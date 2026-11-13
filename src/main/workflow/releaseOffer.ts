// HI-3155 (Darren's 1A and 2A, 13 Nov; design s7 → s11 with HR1): the release offer, a project's own For you item. When
// a project's Work merges into (G7) is released (HI-3148's release reads: a tag named after it, the line in the main line),
// Combwork offers to move G7 on to the next version (or to start it), and to take released versions off Other branches
// work can merge into (G7b), each part on its own. Never applied by itself: Move… opens the Save… preview, Start… the
// Start the next version dialog, and the Assistant answers with its own tools, each bound to the offer it saw.
//
// Looked at cheaply and often (the port's `watch` checkers: file reads only, no process), read in full only when what it
// rests on moved: the refs of G7, of its next version and of each G7b; the options; the uses of G7b (cards, lanes,
// slots: their events); or the last read was unknown. Per open workspace, stopped as it closes.

import { createHash } from 'crypto'
import { existsSync } from 'original-fs'
import { basename, join } from 'path'
import { ASSISTANT_AGENT_ID } from '../../shared/assistant'
import { CW_DIR } from '../../shared/defaults'
import { nextVersionName } from '../../shared/nextVersion'
import type { ReleaseOffer, ReleaseOfferPart } from '../../shared/types'
import { msg } from '../../shared/i18n'
import { combworkError } from '../combworkError'
import { boardValue, boardWrite, setBoardValue } from '../boardStore'
import { emit, onCombworkEvent } from '../events'
import { createLogger, userText } from '../logger'
import { observePort } from '../platform/historyPorts'
import type { ReleaseReads } from '../platform/releaseReads'
import { releaseReadsOf } from '../platform/releaseReadsPorts'
import { projectPlatform } from '../platform/registry'
import { isUnknown } from '../platform/types'
import { openWorkspaces, WorkspaceService } from '../workspace'
import type { PlatformId } from '../../shared/platform/descriptors'
import { projectTargets } from './targets'
import { resolvedOf } from './rulesets'
import { referencesTo, slotUses } from './retarget'
import { releaseOfferSaid } from './releaseOfferText'

const log = createLogger('releaseOffer')

/** How often a project's admission key is looked at (file reads only), and an unknown read tried again. */
export const releaseOfferTiming = { tickMs: 60_000 }

/** A read that couldn't say: the offer isn't made, and the project stays due. */
class Unreadable extends Error {}

/** Released or not, never unknown: an unknown read throws (the project stays due, nothing is offered on it). */
async function isReleased(reads: ReleaseReads, projectPath: string, line: string): Promise<{ tag: string; into: string; date: string | null } | null> {
  const r = await reads.released(projectPath, line)
  if (isUnknown(r)) throw new Unreadable(r.what)
  return r
}

/**
 * The project's offer as its repository and options are now, or null: nothing released, or a platform with no release
 * reads. Throws `Unreadable` when anything it needs can't be read (never an offer on doubt).
 */
export async function offerFor(ws: WorkspaceService, projectPath: string, name: string): Promise<ReleaseOffer | null> {
  const cfg = await ws.projectConfig(projectPath)
  const platform = projectPlatform(projectPath, cfg.platform).id
  const reads = releaseReadsOf(platform)
  if (!reads) return null
  const t = await projectTargets(ws, projectPath).catch(() => null)
  if (!t) return null
  const basis = { target: t.default, otherTargets: [...t.others] }
  // The move part: G7 released, and where to go from it (its next version, existing and not released; else to start it).
  let move: ReleaseOfferPart['move'] = null
  const g7 = await isReleased(reads, projectPath, t.default)
  if (g7) {
    const next = nextVersionName(t.default)
    let moveTo: string | null = null
    let startNext: string | null = null
    if (next) {
      const there = await reads.exists(projectPath, next)
      if (isUnknown(there)) throw new Unreadable(there.what)
      if (!there) startNext = next
      else if (!(await isReleased(reads, projectPath, next))) moveTo = next
    }
    move = { target: t.default, tag: g7.tag, into: g7.into, date: g7.date, moveTo, startNext }
  }
  // The cleanup part: each released G7b, removable when nothing uses it (as the save's own check would find), else kept.
  const removable: { branch: string; tag: string }[] = []
  const kept: { branch: string; tag: string; uses: string[] }[] = []
  const released: { branch: string; tag: string }[] = []
  for (const b of t.others) {
    const r = await isReleased(reads, projectPath, b)
    if (r) released.push({ branch: b, tag: r.tag })
  }
  if (released.length) {
    const slots = await slotUses(ws, projectPath)
    for (const r of released) {
      const uses = await referencesTo(ws, projectPath, r.branch, () => slots.inUse(), t.default)
      if (uses.length) kept.push({ ...r, uses })
      else removable.push(r)
    }
  }
  if (!move && !removable.length && !kept.length) return null
  const cleanup = removable.length || kept.length ? { drop: removable, kept } : null
  const id = `ro-${createHash('sha1').update(JSON.stringify({ basis, move, drop: removable.map((d) => d.branch), kept: kept.map((k) => [k.branch, k.uses]) })).digest('hex').slice(0, 12)}`
  return { id, project: name, projectPath, basis, move, cleanup, since: new Date().toISOString() }
}

// --- Dismissals: board_meta, one offer id per project ("until the next change": another offer has another id). --------

const dismissKey = (ws: WorkspaceService, projectPath: string): string => `release.offerDismissed.${ws.projectIdsNow().byPath.get(projectPath.toLowerCase()) ?? projectPath.toLowerCase()}`

/** The offer id dismissed for the project, or null. */
export function dismissedOffer(ws: WorkspaceService, projectPath: string): string | null {
  try {
    return boardValue(ws, dismissKey(ws, projectPath)) || null
  } catch {
    return null
  }
}

const STALE = msg({ id: 'service.releaseOffer.stale', defaultMessage: 'The release offer for {project} has changed since it was shown, so nothing was changed. Look at it again.', description: 'HI-3155: an action on a release offer (Move…, Start…, Not now, or the Assistant’s answer) refused: the project’s Work merges into or Other branches work can merge into, or what is released, changed after the offer was shown. {project}: the project’s name.' })

/**
 * HI-3155: an action on offer `id` (a save from Move… or Remove…, Start the next version from Start…, the Assistant's
 * setting change, Not now): refused, nothing changed, unless the offer read afresh now is that one. Read from the
 * repository and the options as they are (HR2's round 1: never the followed copy, which a tag made meanwhile leaves
 * behind until its next look): the release, the next version, the uses and the options all go into its id. Unknown
 * refuses too. Called by those actions under their own locks (the repository's, the turn of workflow writes), where the
 * options can't change. The followed copy is read again after (`lookAgain`).
 */
export async function checkOffer(ws: WorkspaceService, projectPath: string, id: string): Promise<ReleaseOffer> {
  const name = currentOffer(ws, projectPath)?.project ?? basename(projectPath)
  const fresh = await offerFor(ws, projectPath, name).catch(() => null)
  if (!fresh || fresh.id !== id) {
    lookAgain(projectPath)
    throw combworkError(STALE, { project: name }, { kind: 'conflict' })
  }
  return fresh
}

/**
 * Not now (the user's, or the Assistant's): hides offer `id`, which must be the project's current one. Returns the value
 * it replaced, for the Assistant's undo (`undoDismiss`).
 */
export async function dismissOffer(ws: WorkspaceService, projectPath: string, id: string): Promise<string | null> {
  // The offer as it is now (as every action on it), then the dismissal in the board's write.
  await checkOffer(ws, projectPath, id)
  const was = await boardWrite(ws, async () => {
    const before = dismissedOffer(ws, projectPath)
    setBoardValue(ws, dismissKey(ws, projectPath), id)
    return before
  })
  changed(ws, projectPath)
  return was
}

/** Undoes a dismissal of `id` only while it is still the one recorded (a newer dismissal is never cleared). */
export async function undoDismiss(ws: WorkspaceService, projectPath: string, id: string, was: string | null): Promise<boolean> {
  const done = await boardWrite(ws, async () => {
    if (dismissedOffer(ws, projectPath) !== id) return false
    setBoardValue(ws, dismissKey(ws, projectPath), was ?? '')
    return true
  })
  if (done) changed(ws, projectPath)
  return done
}

// --- The offers followed, per open workspace's project. ---------------------------------------------------------------

interface Followed {
  ws: WorkspaceService
  path: string
  name: string
  platform: PlatformId
  alive: () => boolean
  watch: { dispose: () => void }
  /** The admission key the last full read was made on (null: never, or it was unknown: due). */
  readOn: string | null
  /** The uses of G7b changed (cards, lanes, slots): bumped by their events, part of the key. */
  usesGen: number
  running: Promise<void> | null
  again: boolean
  offer: ReleaseOffer | null
  /** The offer id last told to the Assistant (one per project: bounded). */
  delivered: string | null
  /** Not before this (ms), a due project's next full read (once a tick while its key is unreadable). */
  nextTry: number
  /** The checkers per line, made once each. */
  checkers: Map<string, (() => string | null) | null>
}

const followed = new Map<string, Followed>()
const keyOf = (path: string): string => path.toLowerCase()

/** For tests: how many full reads each project had (by path, lower-cased). */
export const releaseOfferTestHooks: { reads: Map<string, number>; look: (projectPath: string) => void } = {
  reads: new Map(),
  // An ordinary look (not forced): its key first, a full read only when it moved or is due.
  look: (projectPath) => {
    const f = followed.get(keyOf(projectPath))
    if (f) look(f)
  }
}

/** The project's current offer, dismissed or not (null: none, or not followed). */
export function currentOffer(ws: WorkspaceService, projectPath: string): ReleaseOffer | null {
  const f = followed.get(keyOf(projectPath))
  return f && sameWs(f.ws, ws) ? f.offer : null
}

/** The same open workspace (by its folder: callers may hold another handle on it). */
const sameWs = (a: WorkspaceService, b: WorkspaceService): boolean => !!a.path && a.path.toLowerCase() === (b.path ?? '').toLowerCase()

/** The workspace's offers the user hasn't put off (Not now), for the window and the Assistant. */
export function releaseOffers(ws: WorkspaceService): ReleaseOffer[] {
  const out: ReleaseOffer[] = []
  for (const f of followed.values()) if (sameWs(f.ws, ws) && f.offer && dismissedOffer(ws, f.path) !== f.offer.id) out.push(f.offer)
  return out.sort((a, b) => a.project.localeCompare(b.project))
}

/**
 * What the offer rests on now, cheaply (no process: project.json and the port's `watch` checkers, which read files): the
 * platform and the options' targets as saved, the refs of G7, of its next version and of each G7b, and the uses'
 * generation. Null when a checker can't be made or answers unknown (due: read again at the next tick, never at once).
 * An empty G7 is the default line, which is never released (nothing is released into itself): no refs of its own.
 */
async function admissionKey(f: Followed): Promise<string | null> {
  const cfg = await f.ws.projectConfig(f.path).catch(() => null)
  const reads = releaseReadsOf(f.platform)
  if (!cfg || !reads) return JSON.stringify({ none: true, platform: f.platform })
  const o = resolvedOf(f.ws, f.path, f.platform, cfg).options
  const target = o.target || ''
  const others = [...(o.otherTargets ?? [])]
  const lines = [target, nextVersionName(target), ...others].filter((x): x is string => !!x)
  const refs: (string | null)[] = []
  for (const line of lines) {
    // A checker that couldn't be made isn't kept: made again at the next look.
    if (!f.checkers.get(line)) {
      const made = await reads.watch(f.path, line).catch(() => null)
      if (made) f.checkers.set(line, made)
    }
    const c = f.checkers.get(line)
    let v: string | null = null
    try {
      v = c ? c() : null
    } catch {
      v = null
    }
    if (v === null) return null
    refs.push(v)
  }
  return JSON.stringify({ platform: f.platform, target, others, refs, uses: f.usesGen })
}

/** Looks at the project again: its key, and a full read when the key moved or it is due. One at a time, coalesced. */
function look(f: Followed, force = false): void {
  if (!f.alive()) return
  if (f.running) {
    f.again = true
    return
  }
  f.running = (async () => {
    const key = await admissionKey(f)
    if (!f.alive()) return
    if (!force && key !== null && key === f.readOn) return
    // Due but unreadable (no checker, an unknown answer, an unknown read before): read again at most once a tick.
    if (!force && (key === null || f.readOn === null) && Date.now() < f.nextTry) return
    f.nextTry = Date.now() + releaseOfferTiming.tickMs
    releaseOfferTestHooks.reads.set(keyOf(f.path), (releaseOfferTestHooks.reads.get(keyOf(f.path)) ?? 0) + 1)
    let offer: ReleaseOffer | null
    try {
      offer = await offerFor(f.ws, f.path, f.name)
    } catch (e) {
      // Unknown: nothing offered on it, and the project stays due (read again at the next tick).
      if (!(e instanceof Unreadable)) log.warn(`release offer for ${userText(f.name)}`, e)
      f.readOn = null
      return
    }
    if (!f.alive()) return
    // What it read may have moved while it read: published only when the key is still the one it started on.
    const after = await admissionKey(f)
    if (!f.alive()) return
    // Moved while it read: looked at again (its key now differs, so once). Still unreadable: kept as read, due at the
    // next tick (every action reads the offer afresh anyway, `checkOffer`), never looked at again at once.
    if (after !== null && after !== key) {
      f.readOn = null
      f.again = true
      return
    }
    f.readOn = after
    publish(f, offer)
  })()
    .catch((e) => log.warn('release offer', e))
    .finally(() => {
      f.running = null
      if (f.again && f.alive()) {
        f.again = false
        look(f)
      }
    })
}

function publish(f: Followed, offer: ReleaseOffer | null): void {
  const was = f.offer
  // The same offer keeps its first `since`.
  f.offer = offer && was && was.id === offer.id ? was : offer
  if ((was?.id ?? null) !== (f.offer?.id ?? null)) changed(f.ws, f.path)
  if (f.offer && f.delivered !== f.offer.id && dismissedOffer(f.ws, f.path) !== f.offer.id) {
    f.delivered = f.offer.id
    void tellAssistant(f.ws, f.offer)
  }
}

function changed(ws: WorkspaceService, projectPath: string): void {
  if (ws.path) emit({ type: 'release-offers', workspacePath: ws.path, projectPath })
}

/** The Assistant told of a new offer, once per offer id, in its inbox (it answers with its own tools). */
async function tellAssistant(ws: WorkspaceService, offer: ReleaseOffer): Promise<void> {
  const home = ws.assistantHome
  if (!home || !existsSync(join(home, CW_DIR, 'project.json'))) return
  const { createDelivery } = await import('../deliveries')
  await createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: { kind: 'combwork', name: 'Combwork' }, body: releaseOfferSaid(offer, 'delivery') }).catch((e) => log.warn('telling the Assistant of a release offer', e)) // i18n-ignore: the sender's name, as every delivery of Combwork's names it
}

/** Follows the open workspaces' projects: one for each new one, the ones gone let go. */
function follow(): void {
  const now = new Map<string, { ws: WorkspaceService; path: string; name: string; platform: PlatformId }>()
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    for (const p of ws.info()?.projects ?? []) if (p.platform) now.set(keyOf(p.path), { ws, path: p.path, name: p.name, platform: p.platform.id })
  }
  for (const [k, f] of followed) {
    const n = now.get(k)
    if (!n || n.ws !== f.ws || n.platform !== f.platform || !f.alive()) drop(k)
  }
  for (const [k, n] of now) {
    if (followed.has(k)) continue
    if (!releaseReadsOf(n.platform)) continue
    const life = n.ws.lifetime
    const wsPath = n.ws.path
    const f: Followed = { ...n, alive: () => !life.aborted && n.ws.lifetime === life && n.ws.path === wsPath, watch: { dispose: () => undefined }, readOn: null, usesGen: 0, running: null, again: false, offer: null, delivered: null, nextTry: 0, checkers: new Map() }
    f.watch = observePort.subscribe(n.path, (e) => {
      if (e.kind === 'lineMoved') look(f)
    })
    followed.set(k, f)
    look(f)
  }
}

function drop(k: string): void {
  const f = followed.get(k)
  if (!f) return
  followed.delete(k)
  f.watch.dispose()
  const had = !!f.offer
  f.offer = null
  if (had && f.alive()) changed(f.ws, f.path)
}

/** Looks at a project again now (after Start the next version, a workflow save): its options or refs just changed. */
export function lookAgain(projectPath: string): void {
  const f = followed.get(keyOf(projectPath))
  if (!f) return
  f.checkers.clear()
  look(f, true)
}

let stop: (() => void) | null = null

export function startReleaseOffers(): void {
  if (stop) return
  const off = onCombworkEvent((e) => {
    if (e.type === 'workspace-changed') follow()
    else if (e.type === 'workflow-changed') lookAgain(e.projectPath)
    else if (e.type === 'tasks-changed' || e.type === 'lanes-changed') {
      // The uses of G7b may have changed: part of the key, so the next tick reads again; at once where a kept entry may
      // have just come free (its offer then becomes removable).
      for (const f of followed.values()) {
        if (f.ws.path?.toLowerCase() !== e.workspacePath.toLowerCase()) continue
        f.usesGen++
        if (f.offer?.cleanup?.kept.length) look(f)
      }
    }
  })
  const closing = (path: string): void => {
    for (const [k, f] of followed) if (f.ws.path?.toLowerCase() === path.toLowerCase()) drop(k)
  }
  WorkspaceService.closingListeners.add(closing)
  // Each tick armed with the timing as it is then.
  let tick: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    tick = setTimeout(() => {
      for (const f of followed.values()) look(f)
      arm()
    }, releaseOfferTiming.tickMs)
    tick.unref?.()
  }
  arm()
  follow()
  stop = () => {
    off()
    if (tick) clearTimeout(tick)
    WorkspaceService.closingListeners.delete(closing)
    for (const k of [...followed.keys()]) drop(k)
  }
}

export function stopReleaseOffers(): void {
  stop?.()
  stop = null
}
