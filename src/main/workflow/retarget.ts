// HI-2680 (SPEC §16.5.4): when a project's Work merges into moves on (a release shipped: 1.1.0 → 1.2.0), what still
// points at the finished branch, and what can follow the new one. A preview first, read-only: the Todo cards whose own
// target is the finished branch with no work of their own, and the free slots recording it that are clean with nothing
// the finished branch lacks; what stays, and why (work, started, lent, changes, unmerged; running lanes are never
// rewritten). Then the apply, bound to that preview: each item moved only as it was seen, rechecked under its own lock
// (a card's in `tasks.setTarget`'s board lock with its expected target; a slot's in the pool's own operation), with the
// project's target still the new one and the caller's authority checked before each. Never all or nothing: each item
// says what happened to it.

import { existsSync } from 'original-fs'
import { randomBytes } from 'crypto'
import { samePlace } from '../places'
import * as G from '../platform/git'
import { isUnknown } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import type { TaskActor } from '../tasks'
import { boardChanged, boardWrite, cardKeys } from '../boardStore'
import { cardLabel } from '../../shared/projectKeys'
import { listLanes, withLanesLock } from '../lanes'
import { projectAgents } from '../../shared/defaults'
import { targetedOf, targetOfRulesetId } from '../../shared/workflow/compile'
import { workflowFor } from './service'
import { hasOwnWork, projectTargets } from './targets'
import { checkCardMove, IN_FLIGHT_STAGES, laneOf, type MoveWhy } from './retargetCard'
import type { RetargetPreview, RetargetResult } from '../../shared/types'
import { combworkError } from '../combworkError'
import { fmt, msg } from '../../shared/i18n'
import { createLogger, userText } from '../logger'
import type { RetargetEnd } from '../slots'

const log = createLogger('retarget')

/** Where a card in flight, a Todo card and a lane stand (codes the window and the tools say in words). */
type KeepWhy = RetargetPreview['cards']['keep'][number]['why']

/** A move in flight's refusal as a retarget's reason to keep a card (or its lane) where it is (HI-2753). */
const keepOf = (why: MoveWhy): KeepWhy => (why === 'queued' || why === 'notInTarget' || why === 'reviewed' || why === 'noLine' ? why : why === 'notStarted' || why === 'lane' ? 'started' : 'cantCheck')

/**
 * What a change of Work merges into from `from` to `to` would move, and what stays with why (HI-2680), read-only. Slots
 * recording none count as `from`'s when it is the project's target they fell back to (the preview is made while it is).
 */
export async function retargetPreview(ws: WorkspaceService, projectPath: string, from: string, to: string): Promise<RetargetPreview> {
  const out: RetargetPreview = { from, to, cards: { move: [], keep: [] }, slots: { move: [], keep: [] }, lanes: [] }
  const wf = await workflowFor(ws, projectPath)
  if (!wf || from === to) return out
  const store = wf.store
  const cards = store.cards()
  const keys = cardKeys(ws, cards.map((c) => c.id))
  const row = (c: (typeof cards)[number]) => ({ number: c.id, key: cardLabel({ number: c.id, key: keys.get(c.id) }), title: c.title })
  // Running lanes on `from` (HI-2753): each moves with its card in flight, when that card can (at most one in flight).
  const running = (await listLanes(ws, { project: wf.store.scope.project })).filter((x) => x.state === 'active' || x.state === 'paused')
  const laneTarget = (id: string): string | null => {
    const rec = wf.lane(id)
    return rec?.ruleset ? (targetOfRulesetId(rec.ruleset) ?? store.ruleset(rec.ruleset).options.target ?? null) : null
  }
  const onFrom = new Set(running.filter((l) => (laneTarget(l.id) || null) === from && !wf.lane(l.id)?.ended).map((l) => l.id))
  // Only once `from` has ended (HI-2753): gone, or all of it in `to` (merged, as an integration branch is at its release).
  // A change between branches that both go on leaves started cards and running lanes on their own (HI-2674).
  const fromNow = await G.lineHead(projectPath, from)
  const toNow = await G.lineHead(projectPath, to)
  const ended = !isUnknown(fromNow) && !isUnknown(toNow) && !!toNow && (!fromNow || fromNow === toNow || (await G.isAncestor(projectPath, fromNow, toNow)) === true)
  const inFlight = (c: (typeof cards)[number], s: ReturnType<typeof wf.state>): boolean => IN_FLIGHT_STAGES.includes(s.stage) && s.started?.target === from
  const grouped = new Set<number>()
  out.laneMoves = []
  for (const l of running.filter((x) => onFrom.has(x.id))) {
    const flying = cards.filter((c) => c.lane === l.id && inFlight(c, wf.state(c)))
    for (const c of flying) grouped.add(c.id)
    const lane = { id: l.id, name: l.name, builder: l.builder.name }
    if (!ended || flying.length > 1) {
      out.lanes.push(lane)
      for (const c of flying) out.cards.keep.push({ ...row(c), why: 'started' }) // i18n-ignore: a reason's code, said in words where it is shown
      continue
    }
    const c = flying[0]
    const checked = c ? await checkCardMove(wf, projectPath, c, to) : null
    if (checked && !checked.ok) {
      const why = keepOf(checked.why)
      out.lanes.push({ ...lane, why })
      out.cards.keep.push({ ...row(c), why })
      continue
    }
    out.laneMoves.push({ ...lane, ruleset: wf.lane(l.id)!.ruleset!, card: c && checked?.ok ? { ...row(c), head: checked.check.head, own: c.target ?? null } : null })
  }
  for (const c of cards) {
    const s = wf.state(c)
    if (s.stage === 'done' || grouped.has(c.id)) continue
    const own = c.target ?? null
    // Started on it (HI-2753): moves with its work kept when that work is provably its own, else stays with why.
    if (s.stage !== 'todo' && s.stage !== 'hold' && s.started?.target === from) {
      if (!inFlight(c, s) || !ended) {
        out.cards.keep.push({ ...row(c), why: 'started' }) // i18n-ignore: a reason's code, said in words where it is shown
        continue
      }
      const lane = laneOf(wf, c)
      const checked = lane && (lane.target ?? null) !== to && !onFrom.has(lane.id) ? null : await checkCardMove(wf, projectPath, c, to)
      if (checked?.ok) out.cards.move.push({ ...row(c), started: { head: checked.check.head, own } })
      else out.cards.keep.push({ ...row(c), why: checked ? keepOf(checked.why) : 'started' }) // i18n-ignore: a reason's code, said in words where it is shown
      continue
    }
    if (own !== from) continue
    const w = await hasOwnWork(projectPath, s, wf.folderOf(s))
    if (w === false) out.cards.move.push(row(c))
    else out.cards.keep.push({ ...row(c), why: (w === 'unknown' ? 'cantCheck' : 'work') as KeepWhy }) // i18n-ignore: a reason's code, said in words where it is shown
  }
  const { poolFor } = await import('../slotsApp')
  const pool = await poolFor(ws, projectPath).catch(() => null)
  const fromHead = await G.lineHead(projectPath, from)
  for (const s of pool ? pool.deps.store.slots() : []) {
    if ((s.target ?? from) !== from) continue
    const keep = (why: RetargetPreview['slots']['keep'][number]['why']) => out.slots.keep.push({ name: s.name, why })
    if (s.state !== 'ready') {
      keep(s.state === 'lent' ? 'lent' : s.state === 'dirty' ? 'dirty' : 'busy')
      continue
    }
    if (s.op || s.job || s.writer || pool!.deps.store.openLease(s.name)) {
      keep('busy')
      continue
    }
    if (!existsSync(s.folder) || isUnknown(fromHead) || !fromHead) {
      keep('cantCheck')
      continue
    }
    const d = await G.dirty(s.folder)
    const h = await G.head(s.folder)
    if (isUnknown(d) || isUnknown(h) || !h) {
      keep('cantCheck')
      continue
    }
    if (d.length) {
      keep('dirty')
      continue
    }
    const inIt = h === fromHead || (await G.isAncestor(projectPath, h, fromHead))
    if (inIt !== true) {
      keep(isUnknown(inIt) ? 'cantCheck' : 'unmerged')
      continue
    }
    out.slots.move.push({ name: s.name, folder: s.folder, target: s.target ?? null, head: h })
  }
  return out
}

/**
 * Moves what a confirmed preview listed (HI-2680), each only as it was seen: a card from `from` (its own target as
 * expected, under the board's lock: `tasks.setTarget`'s), a slot from its recorded target, folder and head (the pool's
 * retarget). Before each, the project's target must still be `to` (else the rest stops: "the target changed
 * meanwhile") and `still()` (the caller's authority) must hold (else the rest stops), checked again at each one's write
 * (a card's under the board's lock, which a save of Work merges into holds too; a slot's under the repository's lock,
 * which every save holds). What happened to each is said, a failure part way included (HR1's round 1, finding 3): never
 * thrown past the items already moved.
 */
export async function retargetApply(ws: WorkspaceService, projectPath: string, preview: Pick<RetargetPreview, 'from' | 'to' | 'cards' | 'slots' | 'laneMoves'>, actor: TaskActor, still: () => void = () => undefined): Promise<RetargetResult> {
  const { from, to } = preview
  const out: RetargetResult = { from, to, moved: { cards: [], slots: [], lanes: [] }, skipped: [] }
  const targetNow = async (): Promise<boolean> => (await projectTargets(ws, projectPath).catch(() => null))?.default === to
  const allowed = (): boolean => {
    try {
      still()
      return true
    } catch {
      return false
    }
  }
  let stop: 'targetChanged' | 'refused' | null = null
  const { setTarget } = await import('../tasks')
  // HI-2753: running lanes first, each with its card in flight in one write (the card's), or alone: its cards then follow.
  for (const l of preview.laneMoves ?? []) {
    const name = l.name ?? l.builder
    if (!stop && !(await targetNow())) stop = 'targetChanged'
    if (!stop && !allowed()) stop = 'refused'
    if (stop) {
      out.skipped.push({ lane: name, ...(l.card ? { card: l.card.number, key: l.card.key } : {}), why: stop })
      continue
    }
    try {
      if (l.card) {
        await setTarget(l.card.number, to, actor, { commit: still, expect: l.card.own, expectDefault: to, expectHead: l.card.head, expectFrom: from, withLane: true })
        out.moved.cards.push({ number: l.card.number, key: l.card.key })
      } else await moveLaneAlone(ws, projectPath, l, from, to, still)
      out.moved.lanes!.push(name)
    } catch (e) {
      if (!(await targetNow())) stop = 'targetChanged'
      else if (!allowed()) stop = 'refused'
      out.skipped.push({ lane: name, ...(l.card ? { card: l.card.number, key: l.card.key } : {}), why: stop ?? 'changed', detail: (e as Error).message }) // i18n-ignore: a reason's code, said in words where it is shown
    }
  }
  for (const c of preview.cards.move) {
    if (!stop && !(await targetNow())) stop = 'targetChanged'
    if (!stop && !allowed()) stop = 'refused'
    if (stop) {
      out.skipped.push({ card: c.number, key: c.key, why: stop })
      continue
    }
    try {
      await setTarget(c.number, to, actor, c.started ? { commit: still, expect: c.started.own, expectDefault: to, expectHead: c.started.head, expectFrom: from } : { commit: still, expect: from, expectDefault: to })
      out.moved.cards.push({ number: c.number, key: c.key })
    } catch (e) {
      // Refused at its write: the target moved on again, the caller's authority withdrawn, or the card changed.
      if (!(await targetNow())) stop = 'targetChanged'
      else if (!allowed()) stop = 'refused'
      out.skipped.push({ card: c.number, key: c.key, why: stop ?? 'changed', detail: (e as Error).message }) // i18n-ignore: a reason's code, said in words where it is shown
    }
  }
  const { poolFor } = await import('../slotsApp')
  const pool = preview.slots.move.length ? await poolFor(ws, projectPath).catch((e: Error) => (log.warn(`Retarget: no slot pool for ${userText(projectPath)}: ${userText(e.message)}`), null)) : null
  for (const s of preview.slots.move) {
    if (!stop && !(await targetNow())) stop = 'targetChanged'
    if (!stop && !allowed()) stop = 'refused'
    if (stop || !pool) {
      out.skipped.push({ slot: s.name, why: stop ?? 'changed' }) // i18n-ignore: a reason's code, said in words where it is shown
      continue
    }
    const end = await pool.retarget(s.name, { folder: s.folder, target: s.target, head: s.head }, from, to, async () => allowed() && (await targetNow())).catch((e: Error): RetargetEnd => {
      log.warn(`Retarget of slot ${userText(s.name)} failed: ${userText(e.message)}`)
      return { kind: 'kept', why: 'failed', detail: e.message } // i18n-ignore: a reason's code, said in words where it is shown
    })
    if (end.kind === 'kept' && end.why === 'refused') stop = (await targetNow()) ? 'refused' : 'targetChanged'
    if (end.kind === 'moved') out.moved.slots.push(s.name)
    else if (end.kind === 'kept') out.skipped.push({ slot: s.name, why: end.why === 'refused' ? 'refused' : end.why === 'changed' ? 'changed' : end.why, ...(end.detail ? { detail: end.detail } : {}) }) // i18n-ignore: a reason's code, said in words where it is shown
    else out.skipped.push({ slot: s.name, why: end.state === 'gone' ? 'gone' : 'setAside', ...(end.detail ? { detail: end.detail } : {}) }) // i18n-ignore: a reason's code, said in words where it is shown
  }
  return out
}

/**
 * HI-2753: a running lane on `from` with no card in flight moved to `to`: its rules merging into `to`, so its next cards
 * start there. Under the lanes' lock and the board's, only as it was seen (its ruleset), with the project's target still
 * `to`, still no card of it in flight on `from`, and the caller still allowed.
 */
async function moveLaneAlone(ws: WorkspaceService, projectPath: string, l: NonNullable<RetargetPreview['laneMoves']>[number], from: string, to: string, still: () => void): Promise<void> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) throw new Error('no workflow') // i18n-ignore: a reason's detail (English)
  await withLanesLock(ws, () =>
    boardWrite(ws, async () => {
      const rec = wf.lane(l.id)
      if (!rec || rec.ended || rec.ruleset !== l.ruleset) throw new Error('the lane changed meanwhile') // i18n-ignore: a reason's detail (English)
      if (wf.store.cards().some((c) => c.lane === l.id && IN_FLIGHT_STAGES.includes(wf.state(c).stage) && wf.state(c).started?.target === from)) throw new Error('a card of the lane started meanwhile') // i18n-ignore: a reason's detail (English)
      if ((await projectTargets(ws, projectPath).catch(() => null))?.default !== to) throw new Error('the target changed meanwhile') // i18n-ignore: a reason's detail (English)
      still()
      const r = targetedOf(wf.store.ruleset(rec.ruleset), to)
      wf.store.saveRuleset(r)
      wf.store.saveLane({ ...rec, ruleset: r.id })
      boardChanged(ws)
    })
  )
}

/**
 * What still records `branch` (HI-2680: a finished target taken out of Other branches work can merge into): running
 * lanes on it, cards in flight started on it, cards whose own target it is, open queue entries for it, and slots
 * recording it. Read as the board is; the save's guard reads it inside its board write.
 */
export async function referencesTo(ws: WorkspaceService, projectPath: string, branch: string, slots?: readonly { name: string; target: string | null }[]): Promise<string[]> {
  const wf = await workflowFor(ws, projectPath)
  if (!wf) return []
  const out: string[] = []
  const cards = wf.store.cards()
  const keys = cardKeys(ws, cards.map((c) => c.id))
  for (const c of cards) {
    const s = wf.state(c)
    if (s.stage === 'done') continue
    const named = (c.target ?? null) === branch || (s.stage !== 'todo' && s.started?.target === branch) || s.entries.some((e) => (e.state === 'open' || e.state === 'started') && e.target === branch)
    if (named) out.push(cardLabel({ number: c.id, key: keys.get(c.id) }))
  }
  // The runtime's own lane records (board reads): never lanes.ts's listing, whose views wait on the board's lock.
  const names = new Map(projectAgents(await ws.projectConfig(projectPath)).map((a) => [a.id, a.name] as const))
  for (const id of wf.store.runningLanes()) {
    const rec = wf.lane(id)
    if (!rec || rec.ended || !rec.ruleset || targetOfRulesetId(rec.ruleset) !== branch) continue
    const builder = wf.store.laneBuilder(id)
    out.push(builder ? (names.get(builder) ?? builder) : id)
  }
  for (const s of slots ?? (await slotTargets(ws, projectPath))) if (s.target === branch) out.push(s.name)
  return out
}

/**
 * The project's slots and the target each records (HI-2680), read from its pool: before a save takes its locks (the
 * pool keeps its own connection to the board's database, never opened inside the board's write).
 */
export async function slotTargets(ws: WorkspaceService, projectPath: string): Promise<{ name: string; target: string | null }[]> {
  const { poolFor } = await import('../slotsApp')
  const pool = await poolFor(ws, projectPath).catch(() => null)
  return pool ? pool.deps.store.slots().map((s) => ({ name: s.name, target: s.target ?? null })) : []
}

/** A preview as the window sends it back (HI-2680): its shape checked, item by item; anything else refused. */
export function retargetArg(raw: unknown): RetargetPreview {
  const r = raw as Partial<RetargetPreview> | null
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 250
  const ok =
    !!r &&
    str(r.from) &&
    str(r.to) &&
    Array.isArray(r.cards?.move) &&
    r.cards!.move.every((c) => Number.isInteger(c?.number) && typeof c.key === 'string' && (c.started === undefined || (str(c.started?.head) && (c.started.own === null || str(c.started.own))))) &&
    Array.isArray(r.slots?.move) &&
    r.slots!.move.every((s) => str(s?.name) && str(s.folder) && (s.target === null || str(s.target)) && str(s.head)) &&
    (r.laneMoves === undefined || (Array.isArray(r.laneMoves) && r.laneMoves.every((l) => str(l?.id) && str(l.ruleset) && typeof l.builder === 'string' && (l.card === null || (Number.isInteger(l.card?.number) && typeof l.card.key === 'string' && str(l.card.head) && (l.card.own === null || str(l.card.own)))))))
  if (!ok) throw new Error('A retarget is a preview: from, to, cards.move and slots.move') // i18n-ignore: a mistake in a caller, never the window's
  return { from: r!.from!, to: r!.to!, cards: { move: r!.cards!.move, keep: [] }, slots: { move: r!.slots!.move, keep: [] }, lanes: [], ...(r!.laneMoves ? { laneMoves: r!.laneMoves } : {}) }
}

const IN_USE = msg({ id: 'service.workflow.targetInUse', defaultMessage: '{branch} can’t be taken out of Other branches work can merge into while these use it: {uses}. Retarget or finish them first.', description: 'HI-2680: a save of workflow options refused: it takes a branch out of Other branches work can merge into while cards, lanes, queue entries or slots still use it ({uses}: their keys and names). Other branches work can merge into is the option’s name: as translated there.' })

/**
 * HI-2680: refused when a save takes a branch out of the project's Other branches work can merge into (`before` → `after`,
 * the new default not counted) while anything still records it (`referencesTo`). Called inside the save's board write,
 * which every writer of those references (card targets and starts, enqueues, lane lists) takes too: serial with them.
 */
export async function refuseRemovedTargets(ws: WorkspaceService, projectPath: string, before: readonly string[], after: readonly string[], keep: string | null, slots: readonly { name: string; target: string | null }[]): Promise<void> {
  for (const branch of before.filter((b) => !after.includes(b) && b !== keep)) {
    const uses = await referencesTo(ws, projectPath, branch, slots)
    if (uses.length) throw combworkError(IN_USE, { branch, uses: fmt.list(uses) }, { kind: 'conflict' })
  }
}

/**
 * Retarget previews offered to the Assistant (HR1's HI-2680 round 1, finding 4), held here by id: its apply moves only
 * what the preview it was shown listed, each as it was seen then (a card from its target, a slot at its folder, recorded
 * target and head), never a fresh preview's items. Bounded: the newest 50, each for a day (an offer gone: ask again).
 */
const OFFERS = new Map<string, { project: string; preview: RetargetPreview; at: number }>()
const OFFERS_MAX = 50
const OFFER_TTL = 24 * 60 * 60 * 1000

/** Keeps `preview` (of the project at `projectPath`) for the Assistant's apply; its id. */
export function offerRetarget(projectPath: string, preview: RetargetPreview, now = Date.now()): string {
  for (const [id, o] of OFFERS) if (now - o.at > OFFER_TTL) OFFERS.delete(id)
  while (OFFERS.size >= OFFERS_MAX) OFFERS.delete(OFFERS.keys().next().value!)
  const id = `rt-${randomBytes(4).toString('hex')}`
  OFFERS.set(id, { project: projectPath, preview, at: now })
  return id
}

/** The preview offered as `id` for the project at `projectPath`, while it is kept: null once gone or another project's. */
export function offeredRetarget(id: string, projectPath: string, now = Date.now()): RetargetPreview | null {
  const o = OFFERS.get(id)
  if (!o || now - o.at > OFFER_TTL || !samePlace(o.project, projectPath)) return null
  return o.preview
}

/** An offered preview narrowed to the items named (card keys, slot names; case aside), and the names it doesn't list. */
export function offeredItems(preview: RetargetPreview, items: readonly string[]): { confirmed: RetargetPreview; unknown: string[] } {
  const named = new Set(items.map((x) => x.toLowerCase()))
  // A lane is named by its name or builder, or by its card in flight's key (HI-2753: the two move together).
  const laneNames = (l: NonNullable<RetargetPreview['laneMoves']>[number]): string[] => [l.name ?? l.builder, ...(l.card ? [l.card.key] : [])].map((x) => x.toLowerCase())
  const lanes = (preview.laneMoves ?? []).filter((l) => laneNames(l).some((x) => named.has(x)))
  const confirmed = { ...preview, cards: { move: preview.cards.move.filter((c) => named.has(c.key.toLowerCase())), keep: [] }, slots: { move: preview.slots.move.filter((s) => named.has(s.name.toLowerCase())), keep: [] }, laneMoves: lanes }
  const listed = new Set([...confirmed.cards.move.map((c) => c.key.toLowerCase()), ...confirmed.slots.move.map((s) => s.name.toLowerCase()), ...lanes.flatMap(laneNames)])
  return { confirmed, unknown: [...new Set(items.filter((x) => !listed.has(x.toLowerCase())))] }
}
