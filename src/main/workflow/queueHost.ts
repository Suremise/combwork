// The merge queue in the app (#1348, SPEC §16.9): one host per open workspace, project and target, running the
// target's entries (its IntegrationRequested facts) one at a time on #1360's runner. A host is started by an `enqueue`
// action (the runtime writes one with each IntegrationRequested) and, as a workspace opens, for every target with open
// entries; it takes the target's lease (or finds another Hive running it, and leaves it), recovers its own target's
// entries first (an advance a crash interrupted), then drains: test merge in the runner's folder, merge checks as Hive's
// runs (#1349, on the runner's recording spawn), the compare-and-swap advance under the repository lock (#1347) with the
// lease checked inside it. When the queue is empty, paused, or the workspace closes, it releases its runner.
//
// The card's ruleset decides (§16.6.5): an entry whose card started under Hive merges is merged even after the project's
// options moved to another finisher. With workflow rules off (`hive.workflow.enforce`), nothing runs to an advance: open
// entries pause `rulesOff` (once an advance has begun, recovery finishes it), and carry on when the rules are on again.
// A target checked out in a folder is advanced there by the journaled update (#1351, §16.9.2), with that folder fenced
// (folderFence.ts) and paused while an agent builds in it; asked first (For you) while Settings → Advanced, Merge into a
// checked-out branch, says Ask each time.
//
// Each host keeps the step its entry is at and the check running now (#1353), for the queue's model
// (queueControls.ts), and tells the window of each change (`queue-changed`).

import { basename, join } from 'path'
import { app } from 'electron'
import { boardRead, boardWrite } from '../boardStore'
import { onHiveEvent } from '../events'
import { exitBy } from '../exitLog'
import { git } from '../git'
import { createLogger, userText } from '../logger'
import { processSupervisor } from '../agentProcesses'
import { advanced } from '../advanced'
import { withRepoLock } from '../repoLock'
import { openWorkspaces, WorkspaceService } from '../workspace'
import { onAction } from './actionWorker'
import { withoutWriteFence } from './factStore'
import { MergeQueue, type QueueConfig, type QueueHook, type QueueHooks, type QueueStepInfo } from './mergeQueue'
import { changingFolder, inFolder } from '../folderFence'
import { sessions } from '../sessions'
import { progress } from '../progressService'
import { appQueueChecks } from './queueChecksApp'
import { queueFolderNeeded, QueueRunner, releaseQueueRunners } from './queueRunner'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import { openEntry, type FactData } from '../../shared/workflow/facts'
import { QUEUE_CHECKED_OUT_TARGET, QUEUE_SIGN_SECONDS } from '../../shared/advanced'

const log = createLogger('queue')

/** How long a workspace closing waits for its queues' runs to end once their runners are released (their processes ended). */
const CLOSE_WAIT_MS = 30_000

/** A target's host: its workspace as it was when made, its runner while it runs, whether it was asked again meanwhile. */
interface Host {
  ws: WorkspaceService
  wsPath: string
  life: AbortSignal
  projectPath: string
  target: string
  running: Promise<void> | null
  again: boolean
  /** The entry its queue is taking through its steps now, and the progress run of the check running for it. */
  now: QueueStepInfo | null
  run: string | null
}

const hosts = new Map<string, Host>()
const hostKey = (wsPath: string, projectPath: string, target: string): string => `${wsPath.toLowerCase()}\n${projectPath.toLowerCase()}\n${target}`
const alive = (h: Host): boolean => !h.life.aborted && h.ws.lifetime === h.life && h.ws.path === h.wsPath

/**
 * Runs a target's queue (once more, if it is running now: what was asked meanwhile is looked at again). Resolves when
 * this run ends. Never throws: a failure is logged, and the entries stay for the next run.
 */
export function kickQueue(ws: WorkspaceService, projectPath: string, target: string): Promise<void> {
  if (!ws.path || !target) return Promise.resolve()
  const key = hostKey(ws.path, projectPath, target)
  let h = hosts.get(key)
  if (!h || !alive(h)) {
    h = { ws, wsPath: ws.path, life: ws.lifetime, projectPath, target, running: null, again: false, now: null, run: null }
    hosts.set(key, h)
  }
  if (h.running) {
    h.again = true
    return h.running
  }
  const host = h
  // Its own course, outside any write fence of whatever started it (an action run a queue's write set going).
  host.running = withoutWriteFence(() => runHost(host))
    .catch((e) => log.warn(`running the merge queue for ${userText(target)} in ${userText(basename(projectPath))}`, e))
    .finally(() => {
      host.running = null
      host.now = null
      host.run = null
      queueChanged(ws, projectPath, target)
      if (!alive(host)) hosts.delete(key)
      // Asked again after its loop had ended (while it released its runner): run once more.
      else if (host.again) void kickQueue(ws, projectPath, target)
    })
  return host.running
}

/** This profile's name, as another Hive's panel says who runs a queue ("run by Hive-Dev"). */
export const profileName = (): string => basename(app.getPath('userData'))

/** Tells the workspace's window that a target's queue changed (its model: queueControls.ts), for the panel and the card. */
export function queueChanged(ws: WorkspaceService, projectPath: string, target: string): void {
  if (ws.path) ws.emit({ type: 'queue-changed', workspacePath: ws.path, projectPath, target })
}

/**
 * What this Hive's host of a target is doing now: running (a run going), the entry's step and the check's run. Nothing
 * running here: all null (another Hive may run it: its lease says).
 */
export function queueLive(ws: WorkspaceService, projectPath: string, target: string): { running: boolean; now: QueueStepInfo | null; run: string | null } {
  const h = ws.path ? hosts.get(hostKey(ws.path, projectPath, target)) : undefined
  if (!h || !alive(h)) return { running: false, now: null, run: null }
  return { running: !!h.running, now: h.now, run: h.run }
}

async function runHost(h: Host): Promise<void> {
  let runner: QueueRunner | null = null
  try {
    do {
      h.again = false
      if (!alive(h)) return
      const wf = await workflowFor(h.ws, h.projectPath)
      if (!wf || !alive(h)) return
      if (!runner) {
        const got = await QueueRunner.acquire({
          store: wf.store,
          workspace: h.wsPath,
          project: h.projectPath,
          target: h.target,
          root: join(h.ws.worktreesRoot, basename(h.projectPath)),
          profile: profileName(),
          locked: (fn) => boardWrite(h.ws, async () => fn(), { alive: () => alive(h) }),
          host: processSupervisor(),
          needed: async () => queueFolderNeeded(wf, h.target)
        })
        if (!got.ok) {
          if (got.heldBy) log.info(`The merge queue for ${userText(h.target)} in ${userText(basename(h.projectPath))} is run by ${userText(got.heldBy.profile)}`)
          else log.warn(`The merge queue for ${userText(h.target)} can't run: ${userText(got.problem ?? 'its runner could not start')}`)
          return
        }
        runner = got.runner
        // An earlier runner's processes it couldn't end: paused (needs you), nothing runs.
        if (got.paused !== undefined) return
      }
      // Each queue recovers its target's begun entries first: what to run again is the queue's own (an entry recovered to
      // run again by an earlier queue, paused meanwhile, is found again here, not left Merging).
      const q = new MergeQueue(wf, queueConfig(h, runner))
      const recovered = await q.recover(h.target)
      for (const o of recovered) if (o.outcome === 'integrated' || o.outcome === 'failed') await dropQueuePin(h.projectPath, o.card)
      // Rules off: open entries wait (paused) before their advance; recovery above finished any advance begun.
      if (!workflowEnforced()) {
        await pauseForRulesOff(wf, q, h.target)
        return
      }
      const outcomes = await q.drain(h.target)
      for (const o of outcomes) if (o.outcome !== 'paused') await dropQueuePin(h.projectPath, o.card)
      await prunePins(wf, h.projectPath)
    } while (h.again && alive(h))
  } finally {
    // The queue is empty, paused or its workspace is going: the lease goes (its folder kept while the queue needs it).
    await runner?.release().catch((e) => log.warn(`releasing the merge queue for ${userText(h.target)}`, e))
  }
}

/** The queue's config for a host's run: the runner's folder, lease, git and spawn; the repository lock; Hive's checks. */
function queueConfig(h: Host, runner: QueueRunner): QueueConfig {
  const checks = appQueueChecks(h.ws, h.projectPath, (file, args, opts) => runner.spawnNow('check', file, args, opts), (run) => {
    h.run = run
    queueChanged(h.ws, h.projectPath, h.target)
  })
  const cfg: QueueConfig = {
    folder: runner.folder(),
    holds: () => runner.holds(),
    git: (cwd, args, opts) => runner.git(cwd, args, 'testMerge', opts),
    signTimeoutMs: Math.max(1, Number(advanced.get(QUEUE_SIGN_SECONDS)) || 60) * 1000,
    lock: (fn) => withRepoLock(h.projectPath, fn, { quiet: true, project: h.projectPath }),
    enforced: () => workflowEnforced(),
    // A target checked out in a folder (#1351, §16.9.2): advanced there with that folder fenced, unless an agent builds
    // in it; asked first while Merge into a checked-out branch says so (OP-40).
    // i18n-ignore: what changes the folder, for the log and an agent's reply (agent-facing, English)
    fence: (folder, fn) => changingFolder(folder, 'a merge by the merge queue', fn),
    folderBusy: (folder) => folderBuilders(h.ws, folder),
    checkedOutTarget: () => (advanced.get(QUEUE_CHECKED_OUT_TARGET) === 'auto' ? 'auto' : 'ask'),
    runCheck: checks.runCheck,
    install: checks.install,
    onStep: (step) => {
      if (step?.step !== h.now?.step || step?.entry !== h.now?.entry) h.run = null
      h.now = step
      queueChanged(h.ws, h.projectPath, h.target)
    },
    ...(app.isPackaged ? {} : { hooks: testHooks(h.projectPath, h.target) })
  }
  return cfg
}

/** The points of an advance a test copy can crash at (HIVE_TEST_QUEUE_CRASH), in the journal's order (#1351, S34d). */
const CRASH_POINTS: QueueHook[] = ['afterStarted', 'beforeFiles', 'afterFiles', 'beforeRef', 'afterAdvance', 'inRollback', 'afterRollback']
let raced = false

/**
 * Test copies (unpackaged) only. `HIVE_TEST_QUEUE_CRASH=<point>` ends Hive at once at that point of an advance (S33c,
 * S34d: the next start's recovery reads the journal); no quit handler runs, nothing is released.
 * `HIVE_TEST_QUEUE_RACE=beforeRef` moves the target, as another git client would, just before the swap (a rollback).
 */
function testHooks(projectPath: string, target: string): QueueHooks {
  const hooks: QueueHooks = {}
  const crash = process.env.HIVE_TEST_QUEUE_CRASH
  const point = CRASH_POINTS.find((p) => p === crash)
  if (point) hooks[point] = () => (exitBy('app.exit', `a test crash at the merge queue's ${point}`, () => app.exit(1)), new Promise<void>(() => undefined))
  if (process.env.HIVE_TEST_QUEUE_RACE === 'beforeRef' && point !== 'beforeRef') {
    hooks.beforeRef = async () => {
      // Once per run of Hive: the entry tested again on the moved target then merges.
      if (raced) return
      raced = true
      // A commit on the target made outside Hive (an empty one, on its tree), the ref moved to it.
      const head = await git(projectPath, ['rev-parse', `refs/heads/${target}`])
      const made = head.ok ? await git(projectPath, ['-c', 'user.name=Race', '-c', 'user.email=race@example.invalid', 'commit-tree', `${head.out.trim()}^{tree}`, '-p', head.out.trim(), '-m', 'race']) : null
      if (made?.ok) await git(projectPath, ['update-ref', `refs/heads/${target}`, made.out.trim(), head.out.trim()])
    }
  }
  return hooks
}

/**
 * What makes an agent build in a folder (§16.9.2): the files agents hold locks on there, and the folders of the runs
 * going there (an agent's, the Assistant's or a script's; not Hive's own). Null when there are none: an idle agent, or one
 * whose session lives there but works in a review copy, holds no lock and runs nothing there.
 */
function folderBuilders(ws: WorkspaceService, folder: string): string[] | null {
  const locked = sessions.locksIn(folder)
  const runs = ws.path ? progress.list(ws.path).filter((r) => r.source !== 'hive' && (r.state === 'running' || (r.state === 'stale' && r.staleReason === 'quiet')) && !!r.folder && inFolder(r.folder, folder)) : []
  const what = [...new Set([...locked, ...runs.map((r) => r.folder!)])]
  return what.length ? what : null
}

/** Rules off: a target with open entries is paused `rulesOff` (its first entry's card named), unless paused already. */
async function pauseForRulesOff(wf: Workflow, q: MergeQueue, target: string): Promise<void> {
  const first = q.entries(target)[0]
  if (!first || q.paused(target)) return
  await wf.locked(() => wf.store.setQueuePause(target, { reason: 'rulesOff', card: first.card.key }, true)) // i18n-ignore: a pause reason's code, not text
}

/** A card's test merge's ref (`refs/hive/queue/<key>`), once its entry has an outcome. */
async function dropQueuePin(projectPath: string, cardKey: string): Promise<void> {
  await git(projectPath, ['update-ref', '-d', `refs/hive/queue/${cardKey.replace(/[^A-Za-z0-9._-]/g, '-')}`])
}

/**
 * The submissions' pins (`refs/hive/cards/<key>/<n>`, §16.9.3) of the project's cards that are archived, or gone:
 * removed. A pin keeps what was reviewed until its card is archived.
 */
export async function prunePins(wf: Workflow, projectPath: string): Promise<void> {
  const r = await git(projectPath, ['for-each-ref', '--format=%(refname)', 'refs/hive/cards/'])
  if (!r.ok) return
  const keys = new Set(r.out.split(/\r?\n/).map((l) => /^refs\/hive\/cards\/([^/]+)\//.exec(l.trim())?.[1]).filter((k): k is string => !!k))
  for (const key of keys) {
    const card = wf.store.cardByKey(key)
    if (card && !wf.store.isArchived(card.id)) continue
    const refs = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(`refs/hive/cards/${key}/`))
    for (const ref of refs) await git(projectPath, ['update-ref', '-d', ref])
  }
}

/** The targets with open entries (or begun, unfinished ones) of a project, from its facts. */
function openTargets(wf: Workflow): string[] {
  const out = new Set<string>()
  for (const f of wf.store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    const e = openEntry(wf.state(f.card))
    if (e && e.id === d.entry) out.add(d.target)
  }
  return [...out]
}

/** Starts the hosts of a workspace's projects that have open entries (as it opens, or when the rules come back on). */
async function startOpen(ws: WorkspaceService, resumeRulesOff = false): Promise<void> {
  for (const p of ws.info()?.projects ?? []) {
    if (p.platform?.id !== 'git') continue
    const wf = await workflowFor(ws, p.path).catch(() => null)
    if (!wf) continue
    for (const target of openTargets(wf)) {
      if (resumeRulesOff && wf.store.queuePause(target)?.reason === 'rulesOff') await wf.locked(() => wf.store.setQueuePause(target, null))
      void kickQueue(ws, p.path, target)
    }
  }
}

/** The project of a card on a workspace's board, by its board name: its folder, or null. */
function projectOfCard(ws: WorkspaceService, card: number): string | null {
  const name = boardRead(ws, (db) => (db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string } | undefined)?.project) // i18n-ignore: SQL
  if (!name) return null
  return ws.info()?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.path ?? null
}

let stopHosts: (() => void) | null = null

/**
 * Starts the app's merge queue (index.ts, once): `enqueue` runs a target's host; `pin` pins a submission's revision
 * (the runtime wrote it, nothing in the app ran it before the queue); `releaseSlot` is marked done (P7's
 * slots; agents' worktrees carry on meanwhile); a workspace opening starts its hosts with open entries; the rules
 * coming back on lift `rulesOff` pauses; a workspace closing waits for its hosts' runs to end.
 */
export function startQueueHosts(): void {
  if (stopHosts) return
  onAction('enqueue', (a, ws) => {
    const project = projectOfCard(ws, a.card)
    const target = typeof a.payload.target === 'string' ? a.payload.target : ''
    if (!project || !target) return
    queueChanged(ws, project, target)
    // The user answered that an advance left part way is settled (#1351): looked at again, as Resume does.
    if (a.payload.recheck === true) {
      void import('./queueControls').then((c) => c.recheckStuck(ws, project, target)).catch((e) => log.warn(`looking again at the merge queue for ${userText(target)}`, e))
      return
    }
    void kickQueue(ws, project, target)
  })
  onAction('releaseSlot', () => undefined)
  // A submission's pin (§16.9.3): what was reviewed is kept until its card is archived (prunePins).
  onAction('pin', async (a, ws) => {
    const project = projectOfCard(ws, a.card)
    const wf = project ? await workflowFor(ws, project) : null
    if (wf) await wf.platformOf(wf.store.card(a.card)).perform('pin', a.payload)
  })
  const seen = new WeakSet<AbortSignal>()
  const off = onHiveEvent((e) => {
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void startOpen(ws).catch((x) => log.warn('starting the merge queues of a workspace', x))
    }
  })
  let enforced = workflowEnforced()
  const checkedOutMode = (): unknown => advanced.get(QUEUE_CHECKED_OUT_TARGET)
  let mode = checkedOutMode()
  const offAdvanced = advanced.onChange(() => {
    const now = workflowEnforced()
    if (now && !enforced) for (const ws of openWorkspaces()) void startOpen(ws, true).catch((x) => log.warn('resuming the merge queues', x))
    // Merge into a checked-out branch set to Automatically (#1351, HR4's round 1): a queue waiting for an Approve looks
    // again, and goes ahead.
    else if (checkedOutMode() === 'auto' && mode !== 'auto') for (const ws of openWorkspaces()) void startOpen(ws).catch((x) => log.warn('waking the merge queues', x))
    enforced = now
    mode = checkedOutMode()
  })
  // A workspace closing: its runners released first (their processes ended; from then on every write their runs try is
  // refused by the fence, so a check ended by the close never returns its card), then its runs waited for, briefly.
  const closing = async (path: string): Promise<void> => {
    await releaseQueueRunners((r) => !!r.cfg.workspace && r.cfg.workspace.toLowerCase() === path.toLowerCase())
    const runs = [...hosts.values()].filter((h) => h.wsPath.toLowerCase() === path.toLowerCase() && h.running).map((h) => h.running)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(runs), new Promise((res) => (timer = setTimeout(res, CLOSE_WAIT_MS)))])
    clearTimeout(timer)
  }
  WorkspaceService.closingTasks.add(closing)
  stopHosts = () => {
    off()
    offAdvanced()
    WorkspaceService.closingTasks.delete(closing)
  }
}

/** Stops listening (Hive quitting; tests). Runs going on finish; their runners are released by quit (releaseQueueRunners). */
export function stopQueueHosts(): void {
  stopHosts?.()
  stopHosts = null
}
