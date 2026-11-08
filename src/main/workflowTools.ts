/**
 * The Combwork tools a project's workflow makes unusable (HI-2694, Darren 7 Nov: launch-only): left out of a project
 * agent's tool list when it launches (CW_WORKFLOW_HIDDEN, beside HI-2664's CW_SIDE), and a workflow settings change
 * restarts the agents whose list it changes, as a role change does (sessions.restartForTools: idle at once, busy after
 * asking), only for the tools that change moved (HI-2744). Hidden only where every set of rules still in force forbids a tool: the project's options now, and each ruleset
 * its work in flight still works under (cardWork.workRetained), so a change never takes a tool from work already started.
 * Nothing is hidden where that can't be known: rules not enforced, no version control recorded, options that don't
 * resolve, a board not readable.
 */
import { basename } from 'path'
import { advanced } from './advanced'
import { createLogger, userText } from './logger'
import { onCombworkEvent } from './events'
import { sessions } from './sessions'
import { openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'
import { boardReadToken } from './boardStore'
import { config } from './config'
import { workRetained } from './workflow/cardWork'
import { resolvedOf } from './workflow/rulesets'
import { isAllOff } from '../shared/workflow/options'
import { hiddenForWorkflow } from '../shared/assistantTools'
import { WORKFLOW_ENFORCE } from '../shared/advanced'
import { projectAgents } from '../shared/defaults'
import type { ProjectConfig } from '../shared/types'

const log = createLogger('workflowTools')

/** Each project's hidden list, by its path in lower case, with what it was made from (the board's token, the options). */
const kept = new Map<string, { key: string; hidden: string[] }>()

/**
 * What each project's options alone hide (hiddenForWorkflow of them, [] when all off or unusable), by its path in lower
 * case: as first read, then as each settings change left it. A change compares its options' list with this one, so it
 * restarts only for the tools it moved (HI-2744), never for what the board alone changed meanwhile.
 */
const byOptions = new Map<string, string[]>()

/**
 * The tools a project's agents launch without now, sorted; [] when nothing can be hidden or it can't be known. `cfg`: the
 * project's config (the launch's own read); without, the workspace's copy. Kept per project until the board commits
 * anything (boardReadToken: any commit, another process's, the database reopened or replaced) or its options or the
 * enforcement change; read afresh, never kept, inside a write or a read's snapshot (no token).
 */
export function workflowHiddenNow(ws: WorkspaceService, projectPath: string, cfg?: Pick<ProjectConfig, 'workflow'>): string[] {
  if (ws.isAssistantHome(projectPath)) return []
  const p = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())
  const platform = p?.platform?.id
  const c = cfg ?? p?.config
  if (!p || !platform || !c) return []
  const enforced = advanced.get<boolean>(WORKFLOW_ENFORCE)
  if (!enforced) return []
  const token = boardReadToken(ws)
  const key = JSON.stringify([token, platform, config.settings.workflow ?? null, ws.config.workflow ?? null, c.workflow?.options ?? null])
  const was = kept.get(projectPath.toLowerCase())
  if (token !== null && was?.key === key) return was.hidden
  let hidden: string[] = []
  try {
    const r = resolvedOf(ws, projectPath, platform, c)
    const off = !!r.invalid || isAllOff(r.options)
    // The first list its options alone hide, as what a later settings change is compared with (restartForWorkflow).
    if (!byOptions.has(projectPath.toLowerCase())) byOptions.set(projectPath.toLowerCase(), off ? [] : hiddenForWorkflow([r.options]))
    // All off is really off (SPEC §16.6.4: cards move freely, Review included), so it hides nothing, as rules not enforced.
    const retained = off ? null : workRetained(ws, basename(projectPath))
    hidden = retained && !retained.allOff ? hiddenForWorkflow([r.options, ...retained.options], retained.stages) : []
  } catch (e) {
    log.warn(`the tools ${userText(basename(projectPath))}'s workflow hides couldn't be read, so none are`, e)
    hidden = []
  }
  if (token !== null) kept.set(projectPath.toLowerCase(), { key, hidden })
  return hidden
}

/** What a project's options alone hide (byOptions), whether or not the rules are enforced; null when it can't be read. */
function optionsHidden(ws: WorkspaceService, projectPath: string, cfg: Pick<ProjectConfig, 'workflow'>): string[] | null {
  const platform = ws.info()?.projects.find((x) => x.path.toLowerCase() === projectPath.toLowerCase())?.platform?.id
  if (!platform) return null
  try {
    const r = resolvedOf(ws, projectPath, platform, cfg)
    return r.invalid || isAllOff(r.options) ? [] : hiddenForWorkflow([r.options])
  } catch {
    return null
  }
}

/** Forgets every kept list (tests). */
export function forgetWorkflowHidden(): void {
  kept.clear()
  byOptions.clear()
}

/**
 * Restarts a project's running agents whose tool list its workflow now changes (HI-2694, Darren's decision: as a role
 * change does, through sessions.restartForTools): an idle one at once; busy ones are asked about in the window, once for
 * this change (`tools-restart-asked`), and keep their old tools until they restart (sessions.sideAllows holds work that
 * needs the new ones meanwhile).
 */
export async function restartForWorkflow(ws: WorkspaceService, projectPath: string, only?: (agentId: string) => boolean, o: { settings?: boolean } = {}): Promise<void> {
  if (!ws.path || ws.isAssistantHome(projectPath)) return
  let cfg: ProjectConfig
  try {
    cfg = await ws.projectConfig(projectPath)
  } catch {
    return
  }
  const busy: { id: string; name: string }[] = []
  // A settings change (o.settings) restarts only for the tools its options moved (HI-2744): its options' own list before
  // (read before workflowHiddenNow, which records a project's first) against after. A launch's other differences came
  // from the board alone (a card finished: kept until its next launch, gainsOfBoard's rule), so a change that moved none
  // of them, a stage's new name say, restarts no one and asks nothing. Either list unknown: every difference counts.
  const own = projectPath.toLowerCase()
  const before = o.settings ? byOptions.get(own) : undefined
  const hiddenNow = workflowHiddenNow(ws, projectPath, cfg)
  const target = hiddenNow.join(',')
  let moved: Set<string> | null = null
  if (o.settings) {
    const after = optionsHidden(ws, projectPath, cfg)
    if (after) {
      if (before) moved = new Set([...before, ...after].filter((t) => before.includes(t) !== after.includes(t)))
      byOptions.set(own, after)
    }
  }
  const agents = projectAgents(cfg)
  // Its ended launches and removed agents are forgotten: a question is only ever about a launch still running.
  for (const [id, was] of asked) {
    const [project, agentId] = id.split('|')
    if (project !== projectPath.toLowerCase()) continue
    const live = agents.some((a) => a.id === agentId) ? sessions.liveFor(projectPath, agentId) : null
    if (!live || live.runId !== was.run) asked.delete(id)
  }
  for (const a of agents) {
    const live = sessions.liveFor(projectPath, a.id)
    if (!live || (only && !only(a.id))) continue
    if (moved) {
      const launched = sessions.launchedWorkflowHidden(projectPath, a.id)
      if (launched && ![...launched, ...hiddenNow].some((t) => moved.has(t) && launched.includes(t) !== hiddenNow.includes(t))) continue
    }
    const r = await sessions.restartForTools(projectPath, a.id, { when: 'ifIdle' }).catch((e: unknown) => {
      log.warn(`${userText(a.name)}: not restarted for its project's workflow`, e)
      return 'same' as const
    })
    // Asked once while it still needs this restart: a later change leaving the list it would get the same (Maximum agents,
    // say) doesn't ask again. Once it no longer needs one (changed back, restarted, restarting), it's forgotten, so a change
    // to that list again asks again (HR1's round 1).
    const id = `${projectPath.toLowerCase()}|${a.id}`
    if (r !== 'busy') {
      asked.delete(id)
      continue
    }
    const was = asked.get(id)
    if (was?.run === live.runId && was.target === target) continue
    asked.set(id, { run: live.runId, target })
    busy.push({ id: a.id, name: a.name })
  }
  if (busy.length) ws.emit({ type: 'tools-restart-asked', workspacePath: ws.path, projectPath, agents: busy })
}

/** Each busy launch's question while it still needs that restart: its project and agent → its run and the hidden list then. */
const asked = new Map<string, { run: string; target: string }>()

/** Forgets every question asked (tests). */
export function forgetAskedRestarts(): void {
  asked.clear()
}

/**
 * A board change that makes a tool usable again with no settings change (HI-2694): a card moved into Review by hand on a
 * project without review keeps the review tools (WORKFLOW_TOOL_STAGES). The running agents launched without such a tool
 * are restarted for it, as a settings change does; a tool that only became unusable (a card finished) waits for the next
 * launch, so finishing work never restarts anyone. Read once a board change has settled, per open workspace, and only for
 * projects with an agent running without some tool.
 */
async function gainsOfBoard(ws: WorkspaceService): Promise<void> {
  for (const p of ws.info()?.projects ?? []) {
    const agents = projectAgents(p.config).filter((a) => (sessions.launchedWorkflowHidden(p.path, a.id) ?? []).length)
    if (!agents.length) continue
    const now = workflowHiddenNow(ws, p.path)
    const gains = new Set(agents.filter((a) => (sessions.launchedWorkflowHidden(p.path, a.id) ?? []).some((t) => !now.includes(t))).map((a) => a.id))
    if (gains.size) await restartForWorkflow(ws, p.path, (id) => gains.has(id))
  }
}

/** Workspaces with a board change to look at, by path (one look after a burst of them). */
const boardChanged = new Map<string, WorkspaceService>()
let boardLook: ReturnType<typeof setTimeout> | null = null

let started = false
let enforcedWas: boolean | null = null

/** Follows workflow settings changes for the restarts (every open workspace's). Once, at startup. */
export function startWorkflowTools(): void {
  if (started) return
  started = true
  sessions.workflowHiddenOf = (projectPath, cfg) => workflowHiddenNow(workspaceOf(projectPath), projectPath, cfg)
  // A project's options written, at any level (each project it reaches is told: levels.ts), by the window, the
  // Assistant, a preset, a platform switch or a template.
  onCombworkEvent((e) => {
    if (e.type === 'tasks-changed') {
      const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
      if (!ws) return
      boardChanged.set(e.workspacePath.toLowerCase(), ws)
      boardLook ??= setTimeout(() => {
        boardLook = null
        const all = [...boardChanged.values()]
        boardChanged.clear()
        for (const w of all) void gainsOfBoard(w).catch((err: unknown) => log.warn('restarting agents for tools a board change brought back', err))
      }, 250)
      return
    }
    if (e.type !== 'workflow-changed') return
    const ws = openWorkspaces().find((w) => w.path && w.path.toLowerCase() === e.workspacePath.toLowerCase())
    if (ws) void restartForWorkflow(ws, e.projectPath, undefined, { settings: true }).catch((err: unknown) => log.warn('restarting agents for a workflow change', err))
  })
  // Settings → Advanced → Workflow rules are enforced: every project's list changes with it.
  enforcedWas = advanced.get<boolean>(WORKFLOW_ENFORCE)
  advanced.onChange(() => {
    const now = advanced.get<boolean>(WORKFLOW_ENFORCE)
    if (now === enforcedWas) return
    enforcedWas = now
    for (const ws of openWorkspaces()) for (const p of ws.info()?.projects ?? []) void restartForWorkflow(ws, p.path).catch((err: unknown) => log.warn('restarting agents for the workflow rules switch', err))
  })
}
