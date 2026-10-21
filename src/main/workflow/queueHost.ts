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
// A target checked out in a folder pauses `checkedOut` until #1351.

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
import { MergeQueue, type QueueConfig } from './mergeQueue'
import { appQueueChecks } from './queueChecksApp'
import { queueFolderNeeded, QueueRunner, releaseQueueRunners } from './queueRunner'
import { workflowEnforced, workflowFor } from './service'
import type { Workflow } from './runtime'
import { openEntry, type FactData } from '../../shared/workflow/facts'

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
  /** Its target's entries recovered since this host was made (once per workspace open). */
  recovered: boolean
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
    h = { ws, wsPath: ws.path, life: ws.lifetime, projectPath, target, running: null, again: false, recovered: false }
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
      if (!alive(host)) hosts.delete(key)
      // Asked again after its loop had ended (while it released its runner): run once more.
      else if (host.again) void kickQueue(ws, projectPath, target)
    })
  return host.running
}

/** This profile's name, as another Hive's panel says who runs a queue ("run by Hive-Dev"). */
const profileName = (): string => basename(app.getPath('userData'))

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
      const q = new MergeQueue(wf, queueConfig(h, runner))
      if (!h.recovered) {
        await q.recover(h.target)
        h.recovered = true
      }
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
  const checks = appQueueChecks(h.ws, h.projectPath, (file, args, opts) => runner.spawnNow('check', file, args, opts))
  const cfg: QueueConfig = {
    folder: runner.folder(),
    holds: () => runner.holds(),
    git: (cwd, args) => runner.git(cwd, args),
    lock: (fn) => withRepoLock(h.projectPath, fn, { quiet: true, project: h.projectPath }),
    enforced: () => workflowEnforced(),
    pauseCheckedOut: true,
    runCheck: checks.runCheck,
    install: checks.install,
    // Test copies (unpackaged): HIVE_TEST_QUEUE_CRASH=afterAdvance ends Hive at once once the target has moved, before
    // `Integrated` is written (S33c: the next start's recovery observes it); no quit handler runs, nothing is released.
    ...(!app.isPackaged && process.env.HIVE_TEST_QUEUE_CRASH === 'afterAdvance' ? { hooks: { afterAdvance: () => (exitBy('app.exit', 'a test crash after the merge queue advanced', () => app.exit(1)), new Promise<void>(() => undefined)) } } : {})
  }
  return cfg
}

/** Rules off: a target with open entries is paused `rulesOff` (its first entry's card named), unless paused already. */
async function pauseForRulesOff(wf: Workflow, q: MergeQueue, target: string): Promise<void> {
  const first = q.entries(target)[0]
  if (!first || q.paused(target)) return
  await wf.locked(() => wf.store.setQueuePause(target, { reason: 'rulesOff', card: first.card.key })) // i18n-ignore: a pause reason's code, not text
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
    if (project && target) void kickQueue(ws, project, target)
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
  const offAdvanced = advanced.onChange(() => {
    const now = workflowEnforced()
    if (now && !enforced) for (const ws of openWorkspaces()) void startOpen(ws, true).catch((x) => log.warn('resuming the merge queues', x))
    enforced = now
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
