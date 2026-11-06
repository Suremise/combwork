import { randomBytes } from 'crypto'
import { join } from 'path'
import type { DepEpisode, LaneRecord } from '../shared/lanes'
import type { LaneInfo } from '../shared/types'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import { createDeliveryOnce, ONCE_KEEP_MS, registerSource, type DeliverySource } from './deliveries'
import { lanesEnforced, listLanes, mutateLanes, rawLanes } from './lanes'
import { createLogger, userText } from './logger'
import { cardsNow } from './tasks'
import { workspaceFor, type WorkspaceService } from './workspace'
import type { PassFence } from './laneStarts'

/**
 * A lane's due card waiting for the cards it depends on (HI-2618). On 5 Nov HB6's HI-2616 was next in its lane while the
 * three cards it depends on were still being built in other lanes, and the lane-next stall reported it 29 times. The
 * lane's status now says what it waits on (laneView's `dueDeps`), the stall checks leave it alone, and its wait is an
 * episode kept with the lane (`depEpisode`):
 * - `waiting`: Combwork has seen the card due with one of its dependencies not Done (a new id each episode: a dependency
 *   reopened begins another);
 * - `pending`: none is open now, claimed under the lanes' lock. With the rules on that is Combwork's own start of the card
 *   (laneStarts.ts), so it goes straight to `sent`. With the rules off a lane is bookkeeping and nothing starts it, so its
 *   builder is owed one readiness wake: made with createDeliveryOnce, whose receipt is written in the deliveries' own
 *   transaction, so a retry after any crash (the claim made and nothing enqueued, or enqueued and not checkpointed, or
 *   received, acked and pruned since) makes no second;
 * - `sent`: checkpointed (also by the delivery's received and ended callbacks).
 * Each step is checked again inside the lanes' lock (the look's fence: the same open of the workspace, not overtaken; the
 * lane running with the same due card), and after every await before the delivery. A queued wake no longer due is
 * cancelled by its refresh. Receipts are never dropped as an episode ends (a late producer would then make it again);
 * the deliveries prune them after ONCE_KEEP_MS, and an obligation older than ONCE_RETRY_MS is given up, never retried.
 */

const log = createLogger('laneDeps')

export const LANE_DEPS_SOURCE = 'lane-deps'
/** An obligation older than this is dropped, not retried (HI-2618): its receipt is kept longer (ONCE_KEEP_MS). */
export const ONCE_RETRY_MS = ONCE_KEEP_MS - 24 * 60 * 60_000

const A = {
  ready: agentMsg({
    id: 'wake.lane.depsReady',
    text: "{card}'s dependencies are Done ({deps}): it is your lane's next card. Start it now (cw_lane next names it).",
    note: "HI-2618: with the workflow rules off, a lane's due card waited for the cards it depends on; once the last is Done its builder is told this, once. card: its key; deps: those cards' keys, comma-separated."
  })
}

/** Its delivery's ref (the lane, card and episode: a later episode's wake is never taken for an earlier one) and receipt key. */
const refOf = (lane: string, card: number, id: string): string => `${lane}#${card}#${id}`
const onceOf = (lane: string, card: number, id: string): string => `${LANE_DEPS_SOURCE}:${refOf(lane, card, id)}`
const nowIso = (): string => new Date().toISOString()

/** For tests: awaited between a claim and its delivery, and between the delivery and its checkpoint (crash boundaries). */
export const laneDepsTestHooks: { afterClaim: ((lane: string) => Promise<void>) | null; afterEnqueue: ((lane: string) => Promise<void>) | null } = { afterClaim: null, afterEnqueue: null }

/** Its due card's dependencies as its lane's view has them (laneView says them only for its current card), or null. */
const dueOf = (v: LaneInfo): NonNullable<LaneInfo['dueDeps']> | null => (v.dueDeps && v.dueDeps.card === v.current ? v.dueDeps : null)

/**
 * One look at a workspace's running lanes' dependency waits (from checkLaneStarts, the rules on or off): each episode's
 * cursor moved as its due card's dependencies are now, and with the rules off a pending readiness wake made.
 */
export async function settleDepEpisodes(ws: WorkspaceService, enforced: boolean, fence: PassFence): Promise<void> {
  if (!ws.path || !fence.current()) return
  const views = await listLanes(ws)
  const records = new Map((await rawLanes(ws)).map((l) => [l.id, l]))
  for (const v of views) {
    if (!fence.current()) return
    const rec = records.get(v.id)
    if (!rec || rec.state !== 'active') continue
    const due = dueOf(v)
    const ep = rec.depEpisode
    if (due && due.open.length) {
      // Waiting: an episode begins (or carries on) for this card.
      if (!(ep && ep.card === due.card && ep.state === 'waiting')) await change(ws, fence, rec, due.card, (e) => (e && e.card === due.card && e.state === 'waiting' ? e : { card: due.card, id: randomBytes(6).toString('hex'), state: 'waiting', at: nowIso() }))
      continue
    }
    if (due && ep && ep.card === due.card) {
      if (ep.state === 'waiting') {
        // The last of them Done: claimed. With the rules on Combwork's start is the one task, so nothing is owed.
        const claimed = await change(ws, fence, rec, due.card, (e) => (e && e.card === due.card && e.id === ep.id && e.state === 'waiting' ? { ...e, state: enforced ? 'sent' : 'pending', at: nowIso() } : e))
        if (!claimed || enforced) continue
        await laneDepsTestHooks.afterClaim?.(rec.id)
        await owe(ws, fence, rec, { ...ep, state: 'pending' })
      } else if (ep.state === 'pending') {
        // Owed and not checkpointed (a crash, or a delivery refused for now): retried, its receipt making it once; with
        // the rules now on, or too old, given up.
        if (enforced || Date.now() - Date.parse(ep.at) > ONCE_RETRY_MS) await change(ws, fence, rec, due.card, (e) => (e && e.id === ep.id && e.state === 'pending' ? { ...e, state: 'sent', at: nowIso() } : e))
        else await owe(ws, fence, rec, ep)
      }
      continue
    }
    // Its due card has no wait now (it started, moved, or another card is due): the cursor goes.
    if (ep) await change(ws, fence, rec, null, (e) => (e && e.id === ep.id ? null : e))
  }
}

/**
 * The lane's cursor changed under the lanes' lock: `fn` gets it as it is there and returns it changed (null drops it).
 * Nothing is written unless the look is still current and the lane still runs with the same builder and, for `card`,
 * that card still in it. Whether something changed.
 */
async function change(ws: WorkspaceService, fence: PassFence, rec: LaneRecord, card: number | null, fn: (e: DepEpisode | undefined) => DepEpisode | null | undefined): Promise<boolean> {
  let changed = false
  await mutateLanes(ws, (lanes) => {
    changed = false
    if (!fence.current()) return
    const l = lanes.find((x) => x.id === rec.id)
    if (!l || l.state !== 'active' || l.builder.id !== rec.builder.id || (card !== null && !l.cards.includes(card))) return
    const was = l.depEpisode
    const now = fn(was)
    if (now === was || JSON.stringify(now ?? null) === JSON.stringify(was ?? null)) return
    if (now) l.depEpisode = now
    else delete l.depEpisode
    changed = true
  })
  return changed
}

/** The readiness wake a pending episode owes its builder (the rules off): made once (its receipt), then checkpointed. */
async function owe(ws: WorkspaceService, fence: PassFence, rec: LaneRecord, ep: DepEpisode): Promise<void> {
  if (!ws.path || !fence.current()) return
  // Still owed, as the lanes have it now (after the awaits since the look read them).
  const now = (await rawLanes(ws)).find((l) => l.id === rec.id)
  if (!fence.current() || !now || now.state !== 'active' || now.depEpisode?.id !== ep.id || now.depEpisode.state !== 'pending' || now.builder.id !== rec.builder.id) return
  const projectPath = join(ws.path, rec.project)
  const { key, deps } = await depKeys(ws, projectPath, ep.card)
  if (!fence.current()) return
  try {
    // agent-protocol: the sender is the product's name, Combwork
    const got = await createDeliveryOnce(projectPath, { agentId: now.builder.id, agentName: now.builder.name, kind: 'card-event', from: { kind: 'combwork', name: 'Combwork' }, card: ep.card, body: inDefaultDialect(() => say(A.ready, { card: key, deps: deps.join(', ') })), source: LANE_DEPS_SOURCE, ref: refOf(rec.id, ep.card, ep.id), meta: { lane: rec.id, episode: ep.id }, once: onceOf(rec.id, ep.card, ep.id) }) // i18n-ignore: who a delivery is from, as agents read it
    if (got.made) log.info(`Lane ${rec.id}: #${ep.card}'s dependencies are Done; told ${userText(now.builder.name)} (${got.record?.id ?? ''})`)
  } catch (e) {
    // Refused for now (its inbox full, its agent can't read one): the next look tries again, its receipt making it once.
    log.warn(`telling ${userText(now.builder.name)} lane ${rec.id}'s #${ep.card} can start`, e)
    return
  }
  await laneDepsTestHooks.afterEnqueue?.(rec.id)
  await checkpoint(ws, rec.id, ep.id)
}

/** Card n's key and the cards it depends on, by key, as its workflow names them (the board's where it can't). */
async function depKeys(ws: WorkspaceService, projectPath: string, n: number): Promise<{ key: string; deps: string[] }> {
  const c = (await cardsNow(ws, [n])).get(n)
  const wf = await (await import('./workflow/service')).workflowFor(ws, projectPath).catch(() => null)
  const keyOf = (x: number, board?: string): string => {
    try {
      return wf?.store.card(x).key ?? board ?? `#${x}`
    } catch {
      return board ?? `#${x}`
    }
  }
  if (!c) return { key: keyOf(n), deps: [] }
  const deps = await cardsNow(ws, c.blockedBy)
  return { key: keyOf(n, c.key), deps: c.blockedBy.map((d) => keyOf(d, deps.get(d)?.key)) }
}

/** An episode's wake made: recorded `sent` where it is still that episode, pending. */
async function checkpoint(ws: WorkspaceService, lane: string, id: string): Promise<void> {
  await mutateLanes(ws, (lanes) => {
    const l = lanes.find((x) => x.id === lane)
    if (l?.depEpisode?.id === id && l.depEpisode.state === 'pending') l.depEpisode = { ...l.depEpisode, state: 'sent', at: nowIso() }
  })
}

/** Why a readiness wake isn't due any more, or null (its refresh, just before it is offered). Agent-facing, for the log. */
async function staleWhy(r: { ref?: string; agentId: string; meta?: Record<string, string | number | boolean> }, host: string): Promise<string | null> {
  const ws = workspaceFor(host)
  const [lane, n, episode] = (r.ref ?? '').split('#')
  const card = Number(n)
  const l = ws ? (await rawLanes(ws)).find((x) => x.id === lane) : undefined
  if (!ws || !l || l.state !== 'active') return 'its lane is no longer running' // i18n-ignore: why a delivery was cancelled, for the log
  if (l.builder.id !== r.agentId) return 'its lane has another builder' // i18n-ignore: why a delivery was cancelled, for the log
  if (!l.depEpisode || l.depEpisode.card !== card || l.depEpisode.id !== episode || l.depEpisode.state === 'waiting') return 'its dependency wait changed' // i18n-ignore: why a delivery was cancelled, for the log
  if (await lanesEnforced()) return 'Combwork starts its lane cards now' // i18n-ignore: why a delivery was cancelled, for the log
  const v = (await listLanes(ws)).find((x) => x.id === lane)
  const due = v ? dueOf(v) : null
  if (!due || due.card !== card) return 'its card has started or moved' // i18n-ignore: why a delivery was cancelled, for the log
  if (due.open.length) return 'a card it depends on is open again' // i18n-ignore: why a delivery was cancelled, for the log
  return null
}

/** Its checkpoint from the delivery's own life (received, or ended), where its episode is still pending. */
async function settled(r: { ref?: string; meta?: Record<string, string | number | boolean> }, host: string): Promise<void> {
  const ws = workspaceFor(host)
  const lane = (r.ref ?? '').split('#')[0]
  if (ws && typeof r.meta?.episode === 'string') await checkpoint(ws, lane, r.meta.episode)
}

const source: DeliverySource = {
  refresh: async (r, host) => {
    const why = await staleWhy(r, host)
    return why ? { cancel: why } : null
  },
  received: (r, host) => void settled(r, host).catch((e) => log.warn('recording a readiness wake received', e)),
  ended: (r, host) => void settled(r, host).catch((e) => log.warn('recording a readiness wake ended', e))
}

/** Tests: the source's refresh, as the deliveries call it before an offer. */
export const laneDepsRefreshForTests = source.refresh!

let registered = false
/** Registers the readiness wakes' source (laneStarts.ts, as it starts following lanes). */
export function startLaneDeps(): void {
  if (registered) return
  registered = true
  registerSource(LANE_DEPS_SOURCE, source)
}
