// The merge queue in the app (#1348, SPEC §16.9): one host per open workspace, project and target, running the
// target's entries (its IntegrationRequested facts) one at a time on #1360's runner. A host is started by an `enqueue`
// action (the runtime writes one with each IntegrationRequested) and, as a workspace opens, for every target with open
// entries; it takes the target's lease (or finds another Combwork running it, and leaves it), recovers its own target's
// entries first (an advance a crash interrupted), then drains: test merge in the runner's folder, merge checks as Combwork's
// runs (#1349, on the runner's recording spawn), the compare-and-swap advance under the repository lock (#1347) with the
// lease checked inside it. When the queue is empty, paused, or the workspace closes, it releases its runner.
//
// The card's ruleset decides (§16.6.5): an entry whose card started under Combwork merges is merged even after the project's
// options moved to another finisher. With workflow rules off (`cw.workflow.enforce`), nothing runs to an advance: open
// entries pause `rulesOff` (once an advance has begun, recovery finishes it), and carry on when the rules are on again.
// A target checked out in a folder is advanced there by the journaled update (#1351, §16.9.2), with that folder fenced
// (folderFence.ts) and paused while an agent builds in it; asked first (For you) while Settings → Advanced, Merge into a
// checked-out branch, says Ask each time.
//
// Each host keeps the step its entry is at and the check running now (#1353), for the queue's model
// (queueControls.ts), and tells the window of each change (`queue-changed`).
//
// A host that finds another Combwork running its target watches that runner's process (#1455, S50): once it is gone, with
// entries still open, the host runs again here and takes the lease over (the runner's own rule: only a gone process).

import { queueIntegration } from '../platform/integrationPorts'
import { basename, join } from 'path'
import { app } from 'electron'
import { detect } from '../platform/registry'
import { boardRead, boardReadOnly, boardWrite, onBoardUpgraded } from '../boardStore'
import { onCombworkEvent } from '../events'
import { exitBy } from '../exitLog'
import { git, withGitRoute } from '../git'
import { createLogger, userText } from '../logger'
import { processSupervisor } from '../agentProcesses'
import { advanced } from '../advanced'
import { withRepoLock } from '../repoLock'
import { openWorkspaces, WorkspaceService } from '../workspace'
import { onAction } from './actionWorker'
import { withoutWriteFence } from './factStore'
import { catchUpKey, catchUpOf, MergeQueue, pushOwedKey, pushOwedOf, type QueueConfig, type QueueHook, type QueueHooks, type QueueStepInfo } from './mergeQueue'
import { changingFolder, inFolder } from '../folderFence'
import { sessions } from '../sessions'
import { progress } from '../progressService'
import { appQueueChecks } from './queueChecksApp'
import { queueFolderNeeded, QueueRunner, releaseQueueRunners } from './queueRunner'
import { defaultProbe, type ProcessProbe } from './queueProcs'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import { openEntry, type FactData } from '../../shared/workflow/facts'
import { FOCUSED_PICK_SECONDS, QUEUE_CHECKED_OUT_TARGET, QUEUE_FOCUSED_JOBS, QUEUE_SIGN_SECONDS } from '../../shared/advanced'
import { childEnv } from '../ptyHost'
import { pausedFor } from '../teamPause'
import { queueTransportStore } from '../queueTransportStore'

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

/** How often a host whose target another Combwork runs looks at that runner's process: the runners' renewal period. */
let holderMs = 30_000
let holderProbe: ProcessProbe | null = null
/**
 * A watch of another Combwork's runner (watchHolder): the host it is for, and its next look. It stays registered while it
 * looks (its probe awaited), so a second run finding the lease held meanwhile keeps it rather than starting another.
 */
interface HolderWatch {
  host: Host
  timer: NodeJS.Timeout | null
  ended: boolean
}
/** The targets another Combwork runs that this Combwork watches, by host key: one watch each. */
const holderWatches = new Map<string, HolderWatch>()

/** Ends a watch: its timer cleared, its entry removed (only its own: a newer watch under the key is left). */
function endWatch(key: string, w: HolderWatch): void {
  w.ended = true
  if (w.timer) clearTimeout(w.timer)
  w.timer = null
  if (holderWatches.get(key) === w) holderWatches.delete(key)
}

/** Ends the watches of a workspace's hosts (it is closing), or every watch (stopQueueHosts). */
function endWatches(wsPath?: string): void {
  for (const [key, w] of [...holderWatches]) if (!wsPath || w.host.wsPath.toLowerCase() === wsPath.toLowerCase()) endWatch(key, w)
}

/** Tests: how many targets are watched now, and how many of those have a look waiting. */
export function holderWatchState(): { watched: number; timers: number } {
  const all = [...holderWatches.values()]
  return { watched: all.length, timers: all.filter((w) => w.timer).length }
}

/** Whether a pid names a process now (whoever's: EPERM is one this process may not signal). */
function pidThere(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Tests: how often a watch looks and how it tells a process is gone (null: as the app does, every watch ended). */
export function setHolderWatch(opts: { ms?: number; probe?: ProcessProbe } | null): void {
  holderMs = opts?.ms ?? 30_000
  holderProbe = opts?.probe ?? null
  if (!opts) endWatches()
}

/** Tests: a workspace's watches ended as its close ends them. */
export const endHolderWatches = (wsPath: string): void => endWatches(wsPath)
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
  // Its own course, outside any write fence of whatever started it (an action run a queue's write set going). A run its
  // workspace's close ended (it closed between two of its steps: "has closed", a write refused) didn't fail: said so, no
  // warning (HI-1989: a quit while a queue ran warned).
  host.running = withoutWriteFence(() => runHost(host))
    .catch((e) => {
      const what = `the merge queue for ${userText(target)} in ${userText(basename(projectPath))}` // i18n-ignore: part of a log line
      if (alive(host)) log.warn(`running ${what}`, e)
      else log.info(`${what} ended: its workspace closed (${userText(e instanceof Error ? e.message : String(e))})`)
    })
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

/** This profile's name, as another Combwork's panel says who runs a queue ("run by Combwork-Dev"). */
export const profileName = (): string => basename(app.getPath('userData'))

/** Tells the workspace's window that a target's queue changed (its model: queueControls.ts), for the panel and the card. */
export function queueChanged(ws: WorkspaceService, projectPath: string, target: string): void {
  if (ws.path) ws.emit({ type: 'queue-changed', workspacePath: ws.path, projectPath, target })
}

/**
 * What this Combwork's host of a target is doing now: running (a run going), the entry's step and the check's run. Nothing
 * running here: all null (another Combwork may run it: its lease says).
 */
export function queueLive(ws: WorkspaceService, projectPath: string, target: string): { running: boolean; now: QueueStepInfo | null; run: string | null } {
  const h = ws.path ? hosts.get(hostKey(ws.path, projectPath, target)) : undefined
  if (!h || !alive(h)) return { running: false, now: null, run: null }
  return { running: !!h.running, now: h.now, run: h.run }
}

/**
 * What this Combwork's hosts of a project's queues are doing now, as a token (HI-1683): the same token, the same `queueLive`
 * for each of its targets, so a queue view made then is still current as far as they go.
 */
export function queueHostsStamp(ws: WorkspaceService, projectPath: string): string {
  if (!ws.path) return ''
  const out: unknown[] = []
  for (const h of hosts.values()) if (alive(h) && h.wsPath.toLowerCase() === ws.path.toLowerCase() && h.projectPath.toLowerCase() === projectPath.toLowerCase()) out.push([h.target, !!h.running, h.now, h.run])
  return JSON.stringify(out)
}

async function runHost(h: Host): Promise<void> {
  let runner: QueueRunner | null = null
  // HI-2079: runners of this run failed by their git host: the first is replaced by a new lease, the second pauses the queue.
  let hostFailures = 0
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
          if (got.heldBy) {
            log.info(`The merge queue for ${userText(h.target)} in ${userText(basename(h.projectPath))} is run by ${userText(got.heldBy.profile)}`)
            watchHolder(h, wf)
          } else log.warn(`The merge queue for ${userText(h.target)} can't run: ${userText(got.problem ?? 'its runner could not start')}`)
          return
        }
        runner = got.runner
        // An earlier runner's processes it couldn't end: paused (needs you), nothing runs.
        if (got.paused !== undefined) return
        // HI-2079: a second runner failed by its git host in this run: paused (needs you), nothing runs. Not run again by a
        // kick that came meanwhile: the next run is asked for anew (the pause's resume, or a card's change).
        if (hostFailures > 1) {
          await runner.pauseForHost()
          h.again = false
          return
        }
      }
      const r = runner
      try {
        // Each queue recovers its target's begun entries first: what to run again is the queue's own (an entry recovered to
        // run again by an earlier queue, paused meanwhile, is found again here, not left Merging).
        const q = new MergeQueue(wf, queueConfig(h, r))
        // HI-2078: every git the queue's work runs (the platform's reads too) runs in its lease's git host, in its job.
        const route = (m: Parameters<QueueRunner['gitOutcome']>[0]) => r.gitOutcome(m)
        const recovered = await withGitRoute(route, () => q.recover(h.target))
        for (const o of recovered) if (o.outcome === 'integrated' || o.outcome === 'failed') await dropQueuePin(h.projectPath, o.card)
        // Rules off: open entries wait (paused) before their advance; recovery above finished any advance begun.
        if (!workflowEnforced()) {
          await pauseForRulesOff(wf, q, h.target)
          return
        }
        const outcomes = await withGitRoute(route, () => q.drain(h.target))
        // A waiting entry (HI-2709) stays open, its pin kept for its test once unblocked.
        for (const o of outcomes) if (o.outcome !== 'paused' && o.outcome !== 'waiting') await dropQueuePin(h.projectPath, o.card)
      } catch (e) {
        // Its git host failed it part way: what it was doing is uncertain, never a card's outcome (its writes refused).
        if (!r.failed) throw e
      }
      if (r.failed) {
        // HI-2079: its release awaited (its job ended, or its duties kept for the next settle); then a new lease, whose
        // settle ends whatever this one left, and the begun entries recovered.
        await r.release()
        runner = null
        hostFailures++
        h.again = true
        continue
      }
      await prunePins(wf, h.projectPath)
      // G21 (HI-1183): snapshots no begun publication of the project needs (crash leftovers) dropped.
      await new MergeQueue(wf, queueConfig(h, r)).pruneSnapshots(h.target).catch((e) => log.warn('dropping unused transport snapshots', e))
    } while (h.again && alive(h))
  } finally {
    // The queue is empty, paused or its workspace is going: the lease goes (its folder kept while the queue needs it).
    await runner?.release().catch((e) => log.warn(`releasing the merge queue for ${userText(h.target)}`, e))
  }
}

/**
 * Watches the runner another Combwork has of a host's target (#1455, S50), by the process its lease names: once that is
 * gone (`alive` false: a reused pid counts as gone), or the lease is no one's, the host runs again here, which takes the
 * lease over. A runner whose process can't be checked counts as running, as acquire takes it.
 *
 * One watch per target, owned by its host (HR4's #1358 round 1): a host already watched keeps its watch (a second run
 * finding the lease held, even while a look awaits its probe); a newer host of the target (the workspace reopened)
 * replaces an older host's watch. A watch ends with its host's workspace (its lifetime, or the close: endWatches), once
 * the target has nothing open, and when it kicks; it re-checks after every await that it is still the target's watch.
 * While a run goes on here it only looks again later: that run either takes the lease or finds it held and keeps this.
 */
function watchHolder(h: Host, wf: Workflow): void {
  const key = hostKey(h.wsPath, h.projectPath, h.target)
  const was = holderWatches.get(key)
  if (was && was.host === h && !was.ended) return
  if (was) endWatch(key, was)
  const w: HolderWatch = { host: h, timer: null, ended: false }
  holderWatches.set(key, w)
  const current = (): boolean => !w.ended && holderWatches.get(key) === w
  const look = async (): Promise<void> => {
    w.timer = null
    if (!current()) return
    if (!alive(h) || !openTargets(wf).includes(h.target)) return endWatch(key, w)
    if (h.running) return schedule()
    const lease = wf.store.queueLease(h.target)
    // A pid that isn't there is gone at once; one that is, by its start time too (the probe: PowerShell on Windows).
    const gone = !lease || !pidThere(lease.pid) || (await (holderProbe ?? defaultProbe()).alive(lease.pid, lease.started)) === false
    if (!current()) return
    if (!alive(h)) return endWatch(key, w)
    if (!gone || h.running) return schedule()
    endWatch(key, w)
    log.info(`The merge queue for ${userText(h.target)} in ${userText(basename(h.projectPath))}: its runner${lease ? ` (${userText(lease.profile)}, process ${lease.pid})` : ''} has gone, so this Combwork runs it`)
    void kickQueue(h.ws, h.projectPath, h.target)
  }
  const schedule = (): void => {
    if (!current()) return
    w.timer = setTimeout(() => void look().catch((e) => log.warn(`watching the runner of the merge queue for ${userText(h.target)}`, e)), holderMs)
    w.timer.unref?.()
  }
  schedule()
}

/** The queue's config for a host's run: the runner's folder, lease, git and spawn; the repository lock; Combwork's checks. */
function queueConfig(h: Host, runner: QueueRunner): QueueConfig {
  const checks = appQueueChecks(h.ws, h.projectPath, (file, args, opts) => runner.spawnNow('check', file, args, opts), (run) => {
    h.run = run
    queueChanged(h.ws, h.projectPath, h.target)
  })
  const cfg: QueueConfig = {
    folder: runner.folder(),
    subfolder: () => !!detect(h.projectPath).subfolder,
    // HI-1697: an upgraded project's merge style and commit message, still to be chosen (project.json, read each time).
    mergeAsk: async () => !!(await h.ws.projectConfig(h.projectPath)).workflow?.mergeAsk,
    // HI-1697: a pending merge choice written to project.json (waiting for a save still writing it: it holds the same
    // locks), then the project's options read again, so the merge's commit message is the one chosen.
    settle: async () => {
      await (await import('./optionsForm')).settleMergeChoice(h.ws, h.projectPath)
      await workflowFor(h.ws, h.projectPath)
    },
    holds: () => runner.holds(),
    git: (cwd, args, opts) => runner.git(cwd, args, 'testMerge', opts),
    // HI-1185: the signing check's signer, in the lease's job as the test merge's commands are.
    // HI-2947: as git starts it (the check quotes its words), its first word given. HI-3208: with no console of its own.
    spawn: (file, args, o) => runner.run('testMerge', file, args, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.argv0 !== undefined ? { argv0: o.argv0 } : {}), ...(o.verbatim ? { windowsVerbatimArguments: true } : {}), ...(o.noConsole ? { noConsole: true } : {}) }),
    signTimeoutMs: Math.max(1, Number(advanced.get(QUEUE_SIGN_SECONDS)) || 60) * 1000,
    lock: (fn) => withRepoLock(h.projectPath, fn, { quiet: true, project: h.projectPath }),
    enforced: () => workflowEnforced(),
    teamPaused: () => !!pausedFor(h.projectPath),
    // A target checked out in a folder (#1351, §16.9.2): advanced there with that folder fenced, unless an agent builds
    // in it; asked first while Merge into a checked-out branch says so (OP-40).
    // i18n-ignore: what changes the folder, for the log and an agent's reply (agent-facing, English)
    fence: (folder, fn) => changingFolder(folder, 'a merge by the merge queue', fn),
    folderBusy: (folder) => folderBuilders(h.ws, folder),
    checkedOutTarget: () => (advanced.get(QUEUE_CHECKED_OUT_TARGET) === 'auto' ? 'auto' : 'ask'),
    runCheck: checks.runCheck,
    install: checks.install,
    gitFiles: checks.gitFiles,
    gitFilesOn: checks.gitFilesOn,
    // G20 (HI-1367): the pick at the result runs as a check does; its tests and results files in Combwork's own folder.
    focused: {
      env: () => childEnv(),
      pickTimeoutMs: () => Math.max(10, Number(advanced.get(FOCUSED_PICK_SECONDS)) || 180) * 1000,
      jobs: () => Math.max(1, Number(advanced.get(QUEUE_FOCUSED_JOBS)) || 2),
      dir: join(app.getPath('userData'), 'merge-queue', 'focused')
    },
    onStep: (step) => {
      if (step?.step !== h.now?.step || step?.entry !== h.now?.entry) h.run = null
      h.now = step
      queueChanged(h.ws, h.projectPath, h.target)
    },
    // G21 (HI-1183): follow mode's transport snapshots, encrypted in Combwork's profile.
    transport: queueTransportStore,
    ...(app.isPackaged ? {} : { hooks: testHooks(h.projectPath, h.target) })
  }
  return cfg
}

/**
 * The points of an advance a test copy can crash at (CW_TEST_QUEUE_CRASH), in the journal's order (#1351, S34d); and,
 * following the remote, `beforePublish`: in phase push with nothing sent, so the restart finds an unknown publication
 * the remote lacks and asks For you (HI-3088's window check); `beforeCatchUpRef`: a published merge's local catch-up
 * with its files moved and its ref not (HI-3089's window check: taken up as Combwork starts again).
 */
const CRASH_POINTS: QueueHook[] = ['afterStarted', 'beforeFiles', 'afterFiles', 'beforeRef', 'afterAdvance', 'inRollback', 'afterRollback', 'beforePublish', 'beforeCatchUpRef']
let raced = false

/**
 * Test copies (unpackaged) only. `CW_TEST_QUEUE_CRASH=<point>` ends Combwork at once at that point of an advance (S33c,
 * S34d: the next start's recovery reads the journal); no quit handler runs, nothing is released.
 * `CW_TEST_QUEUE_RACE=beforeRef` moves the target, as another git client would, just before the swap (a rollback).
 */
function testHooks(projectPath: string, target: string): QueueHooks {
  const hooks: QueueHooks = {}
  const crash = process.env.CW_TEST_QUEUE_CRASH
  const point = CRASH_POINTS.find((p) => p === crash)
  if (point) hooks[point] = () => (exitBy('app.exit', `a test crash at the merge queue's ${point}`, () => app.exit(1)), new Promise<void>(() => undefined))
  if (process.env.CW_TEST_QUEUE_RACE === 'beforeRef' && point !== 'beforeRef') {
    hooks.beforeRef = async () => {
      // Once per run of Combwork: the entry tested again on the moved target then merges.
      if (raced) return
      raced = true
      // A commit on the target made outside Combwork (an empty one, on its tree), the ref moved to it.
      const head = await git(projectPath, ['rev-parse', `refs/heads/${target}`])
      const made = head.ok ? await git(projectPath, ['-c', 'user.name=Race', '-c', 'user.email=race@example.invalid', 'commit-tree', `${head.out.trim()}^{tree}`, '-p', head.out.trim(), '-m', 'race']) : null
      if (made?.ok) await git(projectPath, ['update-ref', `refs/heads/${target}`, made.out.trim(), head.out.trim()])
    }
  }
  return hooks
}

/**
 * What makes an agent build in a folder (§16.9.2): the files agents hold locks on there, and the folders of the runs
 * going there (an agent's, the Assistant's or a script's; not Combwork's own). Null when there are none: an idle agent, or one
 * whose session lives there but works in a review copy, holds no lock and runs nothing there.
 */
export function folderBuilders(ws: WorkspaceService, folder: string): string[] | null {
  const locked = sessions.locksIn(folder)
  const runs = ws.path ? progress.list(ws.path).filter((r) => r.source !== 'combwork' && (r.state === 'running' || (r.state === 'stale' && r.staleReason === 'quiet')) && !!r.folder && inFolder(r.folder, folder)) : []
  const what = [...new Set([...locked, ...runs.map((r) => r.folder!)])]
  return what.length ? what : null
}

/** Rules off: a target with open entries is paused `rulesOff` (its first entry's card named), unless paused already. */
async function pauseForRulesOff(wf: Workflow, q: MergeQueue, target: string): Promise<void> {
  const first = q.entries(target)[0]
  if (!first || q.paused(target)) return
  await wf.locked(() => wf.store.setQueuePause(target, { reason: 'rulesOff', card: first.card.key }, true)) // i18n-ignore: a pause reason's code, not text
}

/** A card's test merge's ref (`refs/cw/queue/<key>`), once its entry has an outcome. */
async function dropQueuePin(projectPath: string, cardKey: string): Promise<void> {
  // Its entries' strict updates too (#1352: `refs/cw/queue/<entry>`, `AM-12/e7` as `AM-12-e7`): the port's (HI-2791).
  await queueIntegration().dropQueuePins(projectPath, cardKey)
}

/**
 * The submissions' pins (`refs/cw/cards/<key>/<n>`, §16.9.3) of the project's cards that are archived, or gone:
 * removed. A pin keeps what was reviewed until its card is archived.
 */
export async function prunePins(wf: Workflow, projectPath: string): Promise<void> {
  const I = queueIntegration()
  const pins = await I.cardPins(projectPath)
  if (!pins) return
  for (const [key, refs] of pins) {
    const card = wf.store.cardByKey(key)
    if (card && !wf.store.isArchived(card.id)) continue
    for (const ref of refs) await I.dropPin(projectPath, ref)
  }
}

/** The targets with open entries (or begun, unfinished ones) of a project, from its facts. */
function openTargets(wf: Workflow): string[] {
  const out = new Set<string>()
  const seen = new Set<string>()
  for (const f of wf.store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    seen.add(d.target)
    const e = openEntry(wf.state(f.card))
    if (e && e.id === d.entry) out.add(d.target)
  }
  // A target whose push an earlier merge still owes (G18, #1179: Combwork stopped before it, or it was refused) runs too;
  // so does one whose local catch-up a published merge still owes (HI-3089: one stopped part way, its files moved and its
  // ref not, was left staged in the user's folder with nothing said until another card came).
  for (const t of seen) if (pushOwedOf(wf.store.meta(pushOwedKey(t))) || catchUpOf(wf.store.meta(catchUpKey(t)))) out.add(t)
  return [...out]
}

/**
 * Starts the hosts of a workspace's projects that have open entries (as it opens, its board upgraded, or the rules back
 * on). A board that takes no writes (waiting for its upgrade to 1.0, or a newer Combwork's) has nothing to run: the upgrade
 * starts them (#1621).
 */
async function startOpen(ws: WorkspaceService, resumeRulesOff = false): Promise<void> {
  if (!ws.path || boardReadOnly(ws)) return
  for (const p of ws.info()?.projects ?? []) {
    // A None project too: its Git cards switched from may still have entries (#1419: they keep Git's rules).
    if (!p.platform) continue
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
 * (the runtime wrote it, nothing in the app ran it before the queue); `releaseSlot` is slotCards.ts's (#1438); a
 * workspace opening starts its hosts with open entries; the rules
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
  // A submission's pin (§16.9.3): what was reviewed is kept until its card is archived (prunePins).
  onAction('pin', async (a, ws) => {
    const project = projectOfCard(ws, a.card)
    const wf = project ? await workflowFor(ws, project) : null
    if (wf) await wf.platformOf(wf.store.card(a.card)).perform('pin', a.payload)
  })
  const seen = new WeakSet<AbortSignal>()
  const off = onCombworkEvent((e) => {
    // The team resuming (HI-2081): its queues go on with what waited, as when the rules are turned on again.
    if (e.type === 'team-pause-changed') {
      const ws = e.pause ? null : openWorkspaces().find((w) => w.path?.toLowerCase() === e.workspacePath.toLowerCase())
      if (ws) void startOpen(ws, true).catch((x) => log.warn('resuming the merge queues after the team resumed', x))
      return
    }
    if (e.type !== 'workspace-changed') return
    for (const ws of openWorkspaces()) {
      if (!ws.path || seen.has(ws.lifetime)) continue
      seen.add(ws.lifetime)
      void startOpen(ws).catch((x) => log.warn('starting the merge queues of a workspace', x))
    }
  })
  // Opened while its board waited for the upgrade to 1.0, its queues start once it is upgraded, with no restart (#1621).
  const offUpgraded = onBoardUpgraded((ws) => void startOpen(ws).catch((x) => log.warn('starting the merge queues of an upgraded workspace', x)))
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
    // Its watches of other Combworks' runners end with it (a reopened workspace's hosts watch afresh).
    endWatches(path)
    await releaseQueueRunners((r) => !!r.cfg.workspace && r.cfg.workspace.toLowerCase() === path.toLowerCase())
    const runs = [...hosts.values()].filter((h) => h.wsPath.toLowerCase() === path.toLowerCase() && h.running).map((h) => h.running)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(runs), new Promise((res) => (timer = setTimeout(res, CLOSE_WAIT_MS)))])
    clearTimeout(timer)
  }
  WorkspaceService.closingTasks.add(closing)
  stopHosts = () => {
    off()
    offUpgraded()
    offAdvanced()
    endWatches()
    WorkspaceService.closingTasks.delete(closing)
  }
}

/** Stops listening (Combwork quitting; tests). Runs going on finish; their runners are released by quit (releaseQueueRunners). */
export function stopQueueHosts(): void {
  stopHosts?.()
  stopHosts = null
}
