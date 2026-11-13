// The app's one way to the workflow runtime (#1263, SPEC §16.7): one `Workflow` per project of an open workspace, on the
// board's store (FactStore.forBoard). Its writes are changes of the board (boardWrite, which a change the caller already
// holds is joined by: tasks.ts's boardLock), only while the workspace it was made for is the one open: once that closes,
// or its window opens another, the instance refuses every write, and the next call makes the new workspace's own. Its
// side effects are `card_actions` rows the actions worker runs after the commit (actionWorker.ts): the runtime never runs
// them itself in the app (`autoRun` off).
//
// Its options are the project's resolved ones (rulesets.ts: global → workspace → project), read again at each call
// here; and whether reconciliation acts on what it observes is the Advanced switch "Workflow rules are enforced"
// (`cw.workflow.enforce`), read at each use: off, Combwork is as P3 left it (facts recorded, nothing refused or moved).

import type { JjCardDeps } from '../platform/jjPlatform'
import { basename, resolve as resolvePath } from 'path'
import { projectAgents } from '../../shared/defaults'
import { advanced } from '../advanced'
import { FOCUSED_PICK_SECONDS, WORKFLOW_ENFORCE } from '../../shared/advanced'
import { childEnv } from '../ptyHost'
import { boardSavepoint, boardWrite } from '../boardStore'
import { samePlace } from '../fsutil'
import { combworkError } from '../combworkError'
import { observer } from '../platform/observe'
import { detect } from '../platform/registry'
import { isUnknown } from '../platform/types'
import { fmt, msg, tr } from '../../shared/i18n'
import { declaresPaths, type PlatformId } from '../../shared/platform/descriptors'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'
import { locksSettled } from './lockRecord'
import { checksSettled } from './runChecks'
import { resolvedOf, type ResolvedOptions } from './rulesets'
import { lastActionId, noteRequestsSince } from '../workflowNotices'
import { earlierWorkText, Workflow, type KeptAcross, type SlotForStart } from './runtime'
import type { EarlierLine } from './earlierWork'
import { tell } from '../notify'
import { commentAsCombwork } from '../tasks'
import type { CardRecord } from './factStore'
import { legacyWorktree, slotsMigrated } from '../agentFolders'
import { NOT_RUN_HERE, type QueueLive } from './queueState'
import { noticeTargetChanges } from '../targetChangesNotice'

/** The Advanced switch every gate answers to at once (#1120's table): off, nothing is refused and reconciliation records only. */
export const ENFORCE = WORKFLOW_ENFORCE

const M = {
  closed: msg({ id: 'service.workflow.closed', defaultMessage: 'The workspace this card belongs to has closed', description: 'An error: a change to a card was asked for in a workspace that has since closed, or whose window opened another workspace.' })
}

/**
 * What an agent has going that its submission waits for (G13, `submit.ownRunsStopped`): its open Progress runs and
 * background tasks, each named. Given by the app as it starts (sessions and progress are its; none in unit tests).
 */
let runsGoing: ((project: string, agent: string) => string[]) | null = null
export function setRunsGoing(fn: ((project: string, agent: string) => string[]) | null): void {
  runsGoing = fn
}
/** What an agent has going now (setRunsGoing's), each named; none without the app. */
export const agentRunsGoing = (project: string, agent: string): string[] => runsGoing?.(project, agent) ?? []

/**
 * Whether an agent's session runs now (HI-2487: a review it has in progress holds another agent's start of it until it
 * stops). Given by the app as it starts (sessions are its; none running in unit tests).
 */
let agentRunning: ((project: string, agent: string) => boolean) | null = null
export function setAgentRunning(fn: ((project: string, agent: string) => boolean) | null): void {
  agentRunning = fn
}

/**
 * What runs a target's queue in this Combwork now (queueHost's queueLive: the queue's order, which card reads and refusals
 * give agents, #1354). Given by the app as it starts (none in unit tests: nothing runs a queue here).
 */
let queueLiveOf: ((ws: WorkspaceService, project: string, target: string) => QueueLive) | null = null
export function setQueueLive(fn: ((ws: WorkspaceService, project: string, target: string) => QueueLive) | null): void {
  queueLiveOf = fn
}

/**
 * Cards on slots (#1438): the slot a card's start lends its builder, and a lease given back when the start wasn't
 * written (slotCards.ts's). Given by the app as it starts (none in unit tests: no slots, a card starts where its agent is).
 */
export interface SlotStarts {
  leaseFor: (ws: WorkspaceService, project: string, card: CardRecord, builder: string, o: { dry: boolean; target: string | null; kept?: { slot: string; generation: string; target: string } }) => Promise<SlotForStart>
  unused: (ws: WorkspaceService, project: string, lease: string) => Promise<void>
  /** HI-3069: a card's kept slot of the other version control (SlotPool.keptAcross), else null. */
  keptAcross?: (ws: WorkspaceService, project: string, card: number) => Promise<KeptAcross | null>
  /** HI-3132: a card's kept slot of the project's own version control (SlotPool.keptHere), else null. */
  keptHere?: (ws: WorkspaceService, project: string, card: number) => Promise<{ slot: string; folder: string } | null>
  /**
   * After #1441's migration: an agent's adopted worktree (its carried slot) while what it is kept for (the lane running at
   * the upgrade, or its card then in flight) goes on, so those finish where they started (the stand-in path).
   */
  standIn?: (ws: WorkspaceService, project: string, agent: string) => Promise<{ path: string; base: string | null } | null>
  /**
   * HI-3118: whether the lease a card's cycle started on still holds its slot for it, from the same pool `leaseFor` lends
   * from (null: can't be read). Left out, a submit doesn't ask.
   */
  held?: (ws: WorkspaceService, project: string, lease: string, slot: string, folder: string, card: number) => boolean | null
}
let slotStarts: SlotStarts | null = null
const EARLIER = {
  title: msg({ id: 'workflow.earlierWork.title', defaultMessage: '{read, select, yes {{card}: its earlier work is on {line}} other {{card}: its earlier work couldn’t be read}}', description: 'HI-3107: a notice when a card starts: it ran before under another version control (Git, before the repository switched to jj), and its line from then may still have work (yes); or its earlier starts couldn’t be read, so that can’t be told (other). Keep the select keys. {card} is a card key; {line} a branch or bookmark name.' }),
  message: msg({ id: 'workflow.earlierWork.message', defaultMessage: '{read, select, yes {{n, plural, one {Its earlier line, {lines}, may hold work its target lacked:} other {Its earlier lines, {lines}, may hold work their target lacked:}} Combwork leaves that work there and doesn’t carry it in.} other {Combwork couldn’t read the card’s earlier starts, so it can’t tell whether work from before was left on a line of its own.}} Check what the card’s folder has (its target may hold that work by now), then bring in what you need, or leave it. Its builder is told on the card.', description: 'HI-3107: the notice’s text. yes: {lines} lists branch or bookmark names, {n} how many; other: the card’s starts couldn’t be read. Keep the select keys. Never says the folder lacks the work: its target may hold it. The builder gets the same as a comment on the card.' })
}

/**
 * HI-3107: a start written with earlier work on another version control's lines: a comment on the card from Combwork
 * (which its builder's start task carries, and the user sees on the card), once per start, and a notice to the user.
 */
async function sayEarlierWork(ws: WorkspaceService, projectPath: string, card: CardRecord, lines: EarlierLine[], now: PlatformId): Promise<void> {
  const text = lines.map((e) => earlierWorkText(card.key, e, now)).join('\n\n')
  const named = lines.flatMap((e) => (e.line === null ? [] : [e.line]))
  const starts = (await workflowFor(ws, projectPath).catch(() => null))?.store.facts(card.id).filter((f) => f.kind === 'Started').length ?? 0
  await commentAsCombwork(card.id, text, ws, () => true, `earlier-work:${card.id}:${starts}`)
  tell({ kind: 'warning', level: 'warning', title: tr(EARLIER.title, { read: named.length ? 'yes' : 'no', card: card.key, line: named[0] ?? '' }), message: tr(EARLIER.message, { read: named.length ? 'yes' : 'no', n: named.length, lines: fmt.list(named) }), apiTitle: EARLIER.title.defaultMessage, projectPath })
}

export function setSlotStarts(s: SlotStarts | null): void {
  slotStarts = s
}

/** jj's card work's dependencies for a project (HI-2868: the app's jjCards.ts, set while slots run); none: jj answers nothing. */
type JjCards = (ws: WorkspaceService, projectPath: string, projectId: () => string) => JjCardDeps
let jjCards: JjCards | null = null
export function setJjCards(f: JjCards | null): void {
  jjCards = f
}

/** Whether workflow rules are enforced (Settings → Advanced): read at each use, so a change applies at once. */
export function workflowEnforced(): boolean {
  return advanced.get<boolean>(ENFORCE)
}

/** A project's runtime, its workspace as it was when made, and its options as last resolved. */
interface Instance {
  wf: Workflow
  life: AbortSignal
  wsPath: string
  resolved: ResolvedOptions
  /** None: the time its hashes were last brought in line with the watcher's write log, and that sync (one at a time). */
  syncedAt: number
  sync: Promise<void>
}

const instances = new WeakMap<WorkspaceService, Map<string, Instance>>()
const keyOf = (path: string): string => path.toLowerCase()

/** The project of a workspace a path names, with its platform: null for one it doesn't have (or the Assistant's home). */
function projectOf(ws: WorkspaceService, projectPath: string): { path: string; name: string; platform: PlatformId } | null {
  const p = ws.info()?.projects.find((x) => keyOf(x.path) === keyOf(projectPath))
  return p?.platform ? { path: p.path, name: p.name, platform: p.platform.id } : null
}

/** The project's options, resolved from the three levels (§16.6.6), each read now. */
async function resolve(ws: WorkspaceService, project: { path: string; name: string; platform: PlatformId }): Promise<ResolvedOptions> {
  return resolvedOf(ws, project.path, project.platform, await ws.projectConfig(project.path))
}

/**
 * The project's runtime in a workspace (made once per workspace and project, and again once that workspace has closed),
 * with its options resolved again; null for a path that isn't one of its projects with a platform. Throws when the
 * workspace isn't open, also when it closed or its window opened another while this call waited (for its options, or
 * None's hashes to sync: HR2's #1263 round 2), so a caller never reads through a runtime whose workspace has gone.
 */
export async function workflowFor(ws: WorkspaceService, projectPath: string): Promise<Workflow | null> {
  const wsPath = ws.path
  const life = ws.lifetime
  const open = (): boolean => !!wsPath && !life.aborted && ws.lifetime === life && ws.path === wsPath
  if (!wsPath || !open()) throw combworkError(M.closed, undefined, { kind: 'conflict' })
  const project = projectOf(ws, projectPath)
  if (!project) return null
  const resolved = await resolve(ws, project)
  if (!open()) throw combworkError(M.closed, undefined, { kind: 'conflict' })
  let byProject = instances.get(ws)
  if (!byProject) instances.set(ws, (byProject = new Map()))
  const key = keyOf(project.path)
  let inst = byProject.get(key)
  // Another lifetime's (closed, or another workspace in this window), or the project's platform changed: a new one.
  if (!inst || inst.life !== life || inst.wsPath !== wsPath || inst.resolved.options.platform !== resolved.options.platform) {
    const made: Omit<Instance, 'wf'> & { wf?: Workflow } = { life, wsPath, resolved, syncedAt: Date.now(), sync: Promise.resolve() }
    made.wf = make(ws, project, life, wsPath, () => made.resolved.options)
    inst = made as Instance
    byProject.set(key, inst)
  }
  inst.resolved = resolved
  inst.wf.none.setExcluded(resolved.options.excluded)
  // Declared paths' content hashes (None's revisions), kept current before the runtime answers.
  if (declaresPaths(resolved.options.platform)) {
    await syncHashes(inst, project.path)
    if (!open()) throw combworkError(M.closed, undefined, { kind: 'conflict' })
  }
  return inst.wf
}

/** The project's runtime if this workspace's lifetime has made one (workflowFor), without resolving anything: else null. */
export function workflowNow(ws: WorkspaceService, projectPath: string): Workflow | null {
  const inst = instances.get(ws)?.get(keyOf(projectPath))
  return inst && inst.life === ws.lifetime && !inst.life.aborted && inst.wsPath === ws.path ? inst.wf : null
}

/**
 * None (§16.3.3): a runtime kept across calls keeps its paths' hashes, which a write with the same size and time (a
 * file restored or copied) wouldn't change (HR2's #1263 round 1). So each call first drops the hashes of the paths the
 * watcher saw written since the last one, or all of them when its record of that time isn't complete (lost events, a
 * watch started again, too long ago). One sync at a time, in order, so a call never reads hashes an earlier one hasn't
 * dropped yet.
 */
function syncHashes(inst: Instance, project: string): Promise<void> {
  const run = inst.sync.then(async () => {
    const from = inst.syncedAt
    const to = Date.now()
    const seen = await observer.changedBetween(project, from, to, (paths) => paths)
    if (isUnknown(seen)) inst.wf.none.forget()
    else for (const p of seen.paths) inst.wf.none.invalidate(p)
    inst.syncedAt = to
  })
  inst.sync = run.catch(() => inst.wf.none.forget())
  return inst.sync
}

/** The options a project's runtime works under, with their origins (§16.6.6), as last resolved; null like workflowFor. */
export async function optionsFor(ws: WorkspaceService, projectPath: string): Promise<ResolvedOptions | null> {
  const wf = await workflowFor(ws, projectPath)
  return wf ? (instances.get(ws)?.get(keyOf(wf.cfg.project))?.resolved ?? null) : null
}

function make(ws: WorkspaceService, project: { path: string; name: string }, life: AbortSignal, wsPath: string, options: () => WorkflowOptions): Workflow {
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === wsPath
  const store = FactStore.forBoard(ws, { project: project.name, key: project.name, projectId: () => ws.projectIdsNow().byPath.get(resolvePath(project.path).toLowerCase()) ?? null })
  let jjDeps: JjCardDeps | undefined
  return new Workflow({
    // The project's cards by their keys (#1294: its key now, #1219's; its name for what has no key, and for card
    // trailers written before, as the adoption's store keyed them).
    store,
    project: project.path,
    projectId: () => ws.projectIdsNow().byPath.get(resolvePath(project.path).toLowerCase()) ?? basename(project.path),
    get projectKey() {
      return store.projectKey()
    },
    options,
    // Slots (#1438, SPEC §16.10): the card's builder's slot, lent by slotCards.ts (none set: no slots).
    slotFor: (card, builder, o) => slotStarts?.leaseFor(ws, project.path, card, builder, o) ?? Promise.resolve(null),
    slotUnused: (lease) => slotStarts?.unused(ws, project.path, lease) ?? Promise.resolve(),
    // HI-3118: a submit from a slot asks whether its lease still holds it for the card, of the pool that lent it.
    slotHeld: (lease, slot, folder, card) => (slotStarts?.held ? slotStarts.held(ws, project.path, lease, slot, folder, card) : true),
    keptAcross: (card) => slotStarts?.keptAcross?.(ws, project.path, card.id) ?? Promise.resolve(null),
    keptHere: (card) => slotStarts?.keptHere?.(ws, project.path, card.id) ?? Promise.resolve(null),
    earlierWork: (card, lines, now) => sayEarlierWork(ws, project.path, card, lines, now),
    // HI-2944: a start's warning of its target's uncommitted changes, in the project's window too.
    targetChanges: (changes) => noticeTargetChanges(ws, project.path, changes),
    // jj's card work (HI-2868), composed once for the project while slots run.
    get jj() {
      jjDeps ??= jjCards?.(ws, project.path, () => ws.projectIdsNow().byPath.get(resolvePath(project.path).toLowerCase()) ?? basename(project.path))
      return jjDeps
    },
    // Actions run by the actions worker after the commit, never here.
    autoRun: false,
    // HI-2938: a card that passed is reconciled soon (a jj card's candidate is built then; its pass changes no jj
    // operation or ref that would schedule it otherwise).
    moved: (card, _from, to) => {
      // The reconciler imports this module: loaded when needed. It follows the service holding the project (workspaceOf),
      // never a window's proxy of it, which this workflow may have been made from.
      // HI-2950: and one put back or Done, so an ended cycle's candidate is cleaned up soon (JjPlatform's sweep).
      if ((to === 'approved' || to === 'todo' || to === 'done') && alive()) void Promise.all([import('./reconciler'), import('../workspace')]).then(([m, w]) => m.reconcileCard(w.workspaceOf(project.path), card.id, project.name)).catch(() => undefined)
    },
    runsOf: (agent) => runsGoing?.(project.path, agent) ?? [],
    // HI-2487: the project's agents whose sessions run, who may have a review in progress that another's start waits for.
    reviewersPresent: async () => {
      const running = agentRunning
      if (!running) return new Map()
      return new Map(projectAgents(await ws.projectConfig(project.path)).filter((a) => running(project.path, a.id)).map((a) => [a.id, a.name]))
    },
    // G16 (#1481): the file locks seen before an intent are in the cards' records before it reads them.
    locksSettled: () => locksSettled(ws, project.path),
    // #1651: a check run that has finished is in its card's facts before a submit reads them.
    checksSettled: () => checksSettled(ws, project.path),
    // G20 (HI-1367): a submission's pick runs as a check does (a session command's environment), within its limit.
    focused: { env: () => childEnv(), timeoutMs: () => Math.max(10, Number(advanced.get(FOCUSED_PICK_SECONDS)) || 180) * 1000, life },
    // A branch rename Repair recorded and hasn't finished (#1305): its new name, which a card on the old line follows.
    pendingRename: async (line) => (await ws.projectConfig(project.path)).pendingBranchRenames?.find((r) => r.from.toLowerCase() === line.toLowerCase())?.to ?? null,
    // A move Repair hasn't recorded (#1343): the workspace's or the project's last folder isn't where it is now.
    // Its repository gone (Git's), or another version control found (#1419, S20): what Combwork offers in its place is None.
    repositoryGone: (platform) => detect(project.path).platform !== platform,
    movePending: async () => {
      const moved = (last: string | undefined, now: string): boolean => !!last && !samePlace(last, now)
      return moved(ws.config.lastPath, wsPath) || moved((await ws.projectConfig(project.path)).lastPath, project.path)
    },
    // An agent's 0.9 worktree is a card's folder (SPEC §16.19.1's stand-in) until #1441 migrates it into a slot
    // (agentFolders.ts's legacyWorktree); after, its carried slot while the lane or card it is kept for goes on.
    agentFolder: async (agent) => {
      if (await slotsMigrated(project.path, agent)) return (await slotStarts?.standIn?.(ws, project.path, agent)) ?? null
      const w = legacyWorktree(projectAgents(await ws.projectConfig(project.path)).find((x) => x.id === agent))
      return w ? { path: w.path, base: w.base ?? null } : null
    },
    get reconcileActs() {
      return workflowEnforced()
    },
    // A change of the board (joining the caller's, when it holds one), only while this workspace is the one open; each
    // write a part of it undone on its own if it throws (#1265: a batch's other cards, the caller's change, go on). The
    // requests for the user it writes (`notify`) are noted on their cards in it too: their durable notice (#1266).
    locked: (fn) => {
      if (!alive()) return Promise.reject(combworkError(M.closed, undefined, { kind: 'conflict' }))
      return boardWrite(
        ws,
        () =>
          boardSavepoint(ws, async () => {
            const after = lastActionId(ws)
            const out = await fn()
            await noteRequestsSince(ws, after)
            return out
          }),
        { alive }
      )
    },
    enforced: workflowEnforced,
    queueLive: (target) => queueLiveOf?.(ws, project.path, target) ?? NOT_RUN_HERE
  })
}
