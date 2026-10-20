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
import { advanced } from '../advanced'
import { boardWrite } from '../boardStore'
import { config } from '../config'
import { hiveError } from '../hiveError'
import { msg } from '../../shared/i18n'
import type { PlatformId } from '../../shared/platform/descriptors'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'
import { resolveLogged, type ResolvedOptions } from './rulesets'
import { Workflow } from './runtime'

/** The Advanced switch every gate answers to at once (#1120's table): off, nothing is refused and reconciliation records only. */
export const ENFORCE = 'hive.workflow.enforce'

const M = {
  closed: msg({ id: 'service.workflow.closed', defaultMessage: 'The workspace this card belongs to has closed', description: 'An error: a change to a card was asked for in a workspace that has since closed, or whose window opened another workspace.' })
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
 * workspace isn't open.
 */
export async function workflowFor(ws: WorkspaceService, projectPath: string): Promise<Workflow | null> {
  const wsPath = ws.path
  const life = ws.lifetime
  if (!wsPath || life.aborted) throw hiveError(M.closed, undefined, { kind: 'conflict' })
  const project = projectOf(ws, projectPath)
  if (!project) return null
  const resolved = await resolve(ws, project)
  if (life.aborted || ws.lifetime !== life || ws.path !== wsPath) throw hiveError(M.closed, undefined, { kind: 'conflict' })
  let byProject = instances.get(ws)
  if (!byProject) instances.set(ws, (byProject = new Map()))
  const key = keyOf(project.path)
  let inst = byProject.get(key)
  // Another lifetime's (closed, or another workspace in this window), or the project's platform changed: a new one.
  if (!inst || inst.life !== life || inst.wsPath !== wsPath || inst.resolved.options.platform !== resolved.options.platform) {
    const made: Omit<Instance, 'wf'> & { wf?: Workflow } = { life, wsPath, resolved }
    made.wf = make(ws, project, life, wsPath, () => made.resolved.options)
    inst = made as Instance
    byProject.set(key, inst)
  }
  inst.resolved = resolved
  inst.wf.none.setExcluded(resolved.options.excluded)
  return inst.wf
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
    get reconcileActs() {
      return workflowEnforced()
    },
    // A change of the board (joining the caller's, when it holds one), only while this workspace is the one open.
    locked: (fn) => {
      if (!alive()) return Promise.reject(hiveError(M.closed, undefined, { kind: 'conflict' }))
      return boardWrite(ws, async () => fn(), { alive })
    }
  })
}
