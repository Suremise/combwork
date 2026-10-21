// The app's one way to the workflow runtime (#1263, SPEC §16.7): one `Workflow` per project of an open workspace, on the
// board's store (FactStore.forBoard). Its writes are changes of the board (boardWrite, which a change the caller already
// holds is joined by: tasks.ts's boardLock), only while the workspace it was made for is the one open: once that closes,
// or its window opens another, the instance refuses every write, and the next call makes the new workspace's own. Its
// side effects are `card_actions` rows the actions worker runs after the commit (actionWorker.ts): the runtime never runs
// them itself in the app (`autoRun` off).
//
// Its options are the project's resolved ones (rulesets.ts: global → workspace → project), read again at each call
// here; and whether reconciliation acts on what it observes is the Advanced switch "Workflow rules are enforced"
// (`hive.workflow.enforce`), read at each use: off, Hive is as P3 left it (facts recorded, nothing refused or moved).

import { join } from 'path'
import { projectAgents } from '../../shared/defaults'
import { advanced } from '../advanced'
import { boardSavepoint, boardWrite } from '../boardStore'
import { config } from '../config'
import { hiveError } from '../hiveError'
import { observer } from '../platform/observe'
import { isUnknown } from '../platform/types'
import { msg } from '../../shared/i18n'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'
import { resolveLogged, type ResolvedOptions } from './rulesets'
import { lastActionId, noteRequestsSince } from '../workflowNotices'
import { Workflow } from './runtime'

/** The Advanced switch every gate answers to at once (#1120's table): off, nothing is refused and reconciliation records only. */
export const ENFORCE = 'hive.workflow.enforce'

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
  const cfg = await ws.projectConfig(project.path)
  return resolveLogged(project.path, project.platform, { global: config.settings.workflow, workspace: ws.config.workflow, project: cfg.workflow?.options })
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
  if (!wsPath || !open()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
  const project = projectOf(ws, projectPath)
  if (!project) return null
  const resolved = await resolve(ws, project)
  if (!open()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
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
  if (resolved.options.platform === 'none') {
    await syncHashes(inst, project.path)
    if (!open()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
  }
  return inst.wf
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
  return new Workflow({
    // The project's cards by their keys (a Hive-Card trailer): its name, as the adoption's store keys them.
    store: FactStore.forBoard(ws, { project: project.name, key: project.name }),
    project: project.path,
    projectKey: project.name,
    options,
    slots: join(ws.hiveDir, 'slots'),
    // Actions run by the actions worker after the commit, never here.
    autoRun: false,
    runsOf: (agent) => runsGoing?.(project.path, agent) ?? [],
    // Before P7's slots, an agent's own worktree is a card's folder (SPEC §16.19.1), as project.json has it.
    agentFolder: async (agent) => {
      const a = projectAgents(await ws.projectConfig(project.path)).find((x) => x.id === agent)
      return a?.worktree?.path ? { path: a.worktree.path, base: a.worktree.base ?? null } : null
    },
    get reconcileActs() {
      return workflowEnforced()
    },
    // A change of the board (joining the caller's, when it holds one), only while this workspace is the one open; each
    // write a part of it undone on its own if it throws (#1265: a batch's other cards, the caller's change, go on). The
    // requests for the user it writes (`notify`) are noted on their cards in it too: their durable notice (#1266).
    locked: (fn) => {
      if (!alive()) return Promise.reject(hiveError(M.closed, undefined, { kind: 'conflict' }))
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
    enforced: workflowEnforced
  })
}
