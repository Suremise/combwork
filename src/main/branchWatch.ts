import { basename } from 'path'
import type { AgentBranchStatus, CombworkEvent, ProjectInfo } from '../shared/types'
import { leasedLine, legacyWorktree, slotsMigrated } from './agentFolders'
import { boardRead } from './boardStore'
import { emit, onCombworkEvent } from './events'
import { createLogger, userText } from './logger'
import { openWorkspaces, workspaceFor } from './workspace'
import * as wt from './worktrees'
import { gitProblem } from './gitTool'
import { workTargetOf } from './gitRepo'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { isJjLineKey } from './platform/workspacePorts'

const log = createLogger('branches')

/**
 * What each agent's line has not merged (commits ahead of the branch it merges into, uncommitted files), for the
 * Merge… button and the agent's tab. An agent's line (#1451) is its open lease's in that slot (a card's or a lane's,
 * else its carried one's: the card last started there, a carried slot's own branch), else its 0.9 worktree's while the
 * project isn't migrated; an agent with none isn't watched. Git is asked when an agent's turn ends or it stops, when a window
 * gets focus, when an agent is added, after a merge or the Merge dialog's own check, and every minute for
 * agents that still have something to merge. Each change is sent as a `branch-status` event.
 */

/** Unmerged work counts; `null` when git couldn't say (a missing worktree, say). */
const known = new Map<string, { projectPath: string; agentId: string; status: AgentBranchStatus | null }>()
const running = new Map<string, Promise<void>>()
const timers = new Map<string, NodeJS.Timeout>()
/** The last status each agent reported, so only a change of status starts a check. */
const lastStatus = new Map<string, string>()
let lastFocusCheck = 0

const keyOf = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

function same(a: AgentBranchStatus | null, b: AgentBranchStatus | null): boolean {
  return a === b || (!!a && !!b && a.ahead === b.ahead && a.dirty === b.dirty && a.into === b.into && a.branch === b.branch && a.base === b.base && JSON.stringify(a.diff) === JSON.stringify(b.diff))
}

function projectsOf(ws = openWorkspaces()): ProjectInfo[] {
  return ws.flatMap((w) => w.info()?.projects ?? [])
}

/** An agent's watched line: its project, its folder and branch, and for a slot's line the branch it merges into. */
export interface Watched {
  project: ProjectInfo
  /** The agent whose line it is. */
  agentId?: string
  worktree: wt.WorktreeRef
  slot?: true
  target?: string
}

/**
 * The line an agent's status is about (#1451): its open lease's (dispatch, else carried) in that slot, counted against
 * its target (its card's, else the slot's: #1627); else its 0.9 worktree. Null: none to watch.
 */
function findAgent(projectPath: string, agentId: string): Watched | null {
  const p = projectPath.toLowerCase()
  const ws = workspaceFor(projectPath)
  const project = projectsOf(ws ? [ws] : undefined).find((x) => x.path.toLowerCase() === p)
  const agent = project?.agents.find((a) => a.id === agentId)
  if (!ws || !project || !agent) return null
  const legacy = legacyWorktree(agent)
  let leased: { folder: string; target: string | null; line: string | null; carried: boolean } | null = null
  try {
    const slotProject = project.config?.id ?? basename(project.path)
    leased = boardRead(ws, (db) => leasedLine(db, slotProject, agentId))
  } catch {
    // A board still 0.9's: no slots.
  }
  if (leased) {
    const branch = leased.line ?? (leased.carried ? (legacy?.branch ?? null) : null)
    return branch ? { project, agentId, worktree: { path: leased.folder, branch, base: leased.target ?? legacy?.base ?? '' }, slot: true, ...(leased.target ? { target: leased.target } : {}) } : null
  }
  return legacy ? { project, agentId, worktree: legacy } : null
}

/**
 * A line's unmerged work. A slot's is counted against its target, else the project's default branch (#1627: never the
 * branch the project folder has checked out, which needn't be where the line merges), and isn't asked about until its
 * branch is made (a card's line is made as it starts there, after its lease names it): null then, quietly. A 0.9
 * worktree's is counted against the project folder's branch, which its Merge… merges into.
 */
export async function lineStatus(found: Watched): Promise<AgentBranchStatus | null> {
  const { project, worktree } = found
  // A jj card's line is a slot's locator (HI-2866), never a Git branch: nothing for git to check (HI-2896: in a
  // non-colocated jj project git there finds no repository at all, every check a warning).
  if (isJjLineKey(worktree.branch)) return null
  // A branch that isn't there has nothing to merge, and isn't an error to log (HI-1698: an agent's 0.9 branch gone with
  // its worktree, a card's line deleted after its merge, each checked on every refresh): null, quietly.
  if ((await G.lineHead(project.path, worktree.branch)) === null) return null
  if (!found.slot) {
    // An agent whose 0.9 worktree the slots took over (#1441) works in its slot's lines: that branch is no longer its own.
    if (found.agentId && (await slotsMigrated(project.path, found.agentId))) return null
    return wt.branchStatus(project.path, worktree)
  }
  // Its card's target, else the project's (HI-1698: 1.0.0 while that is where work merges, not main), else its default branch.
  const own = found.target ?? (await workTargetOf(project.path))
  const fallback = own ? null : await G.defaultBranch(project.path)
  const target = own ?? (fallback && !isUnknown(fallback) ? fallback : undefined)
  return wt.branchStatus(project.path, target ? { ...worktree, base: worktree.base || target } : worktree, undefined, target)
}

/** Records a status (from a check here or the Merge dialog's) and tells the window when it changed. */
export function record(projectPath: string, agentId: string, status: AgentBranchStatus | null): void {
  const key = keyOf(projectPath, agentId)
  const before = known.get(key)
  known.set(key, { projectPath, agentId, status })
  if (before && same(before.status, status)) return
  emit({ type: 'branch-status', projectPath, agentId, status })
}

/** Asks git about one worktree agent now (one check at a time per agent). */
export function check(projectPath: string, agentId: string): Promise<void> {
  const key = keyOf(projectPath, agentId)
  const busy = running.get(key)
  if (busy) return busy
  const found = findAgent(projectPath, agentId)
  if (!found) {
    forget(key)
    return Promise.resolve()
  }
  const p = lineStatus(found)
    .then(
      (st) => record(found.project.path, agentId, st),
      async (e) => {
        // Git that can't run fails every check, every minute: Provider Setup and the status bar say so once (#346). A branch
        // deleted while it was checked (a card's line, just merged) isn't worth a warning either (HI-1698).
        if (!gitProblem() && (await G.lineHead(found.project.path, found.worktree.branch).catch(() => null)) !== null) log.warn(`Couldn't check ${userText(found.worktree.branch)}`, e)
        record(found.project.path, agentId, null)
      }
    )
    .finally(() => running.delete(key))
  running.set(key, p)
  return p
}

/** A check a moment from now, so a burst of status changes asks git once. */
function soon(projectPath: string, agentId: string, ms = 1500): void {
  const key = keyOf(projectPath, agentId)
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void check(projectPath, agentId)
    }, ms)
  )
}

/** Every agent of a project with a line (`findAgent`): a merge changes the branch they are all compared with. */
export function checkProject(projectPath: string): Promise<void> {
  const p = projectPath.toLowerCase()
  const project = projectsOf().find((x) => x.path.toLowerCase() === p)
  return Promise.all((project?.agents ?? []).filter((a) => findAgent(project!.path, a.id)).map((a) => check(project!.path, a.id))).then(() => undefined)
}

function checkAll(onlyNew = false): void {
  const live = new Set<string>()
  for (const project of projectsOf()) {
    for (const a of project.agents) {
      if (!findAgent(project.path, a.id)) continue
      const key = keyOf(project.path, a.id)
      live.add(key)
      if (!onlyNew || !known.has(key)) void check(project.path, a.id)
    }
  }
  // Agents removed, or projects closed with their workspace.
  for (const key of [...known.keys()]) if (!live.has(key)) forget(key)
}

function forget(key: string): void {
  known.delete(key)
  lastStatus.delete(key)
  clearTimeout(timers.get(key))
  timers.delete(key)
}

/** What is known for the projects of the open workspaces, for a window that is just starting. */
export function statuses(): { projectPath: string; agentId: string; status: AgentBranchStatus | null }[] {
  checkAll(true)
  return [...known.values()]
}

/** The last known status of one worktree agent, without asking git. */
export function knownStatus(projectPath: string, agentId: string): AgentBranchStatus | null {
  return known.get(keyOf(projectPath, agentId))?.status ?? null
}

function onEvent(e: CombworkEvent): void {
  switch (e.type) {
    case 'session-status': {
      const { projectPath, agentId, status } = e.state
      const key = keyOf(projectPath, agentId)
      if (lastStatus.get(key) === status) return
      lastStatus.set(key, status)
      // Commits happen during a turn: look once it has ended (or the agent stopped).
      if (status !== 'working' && status !== 'starting' && findAgent(projectPath, agentId)) soon(projectPath, agentId)
      return
    }
    case 'workspace-changed':
      // An agent added (or a workspace opened): check those not known yet; removed ones are forgotten.
      checkAll(true)
      return
    case 'window-state':
      // Back to Combwork: commits made in a terminal, or a branch switched in the project folder, show up.
      if (e.focused && Date.now() - lastFocusCheck > 10_000) {
        lastFocusCheck = Date.now()
        checkAll()
      }
      return
  }
}

let started = false

/** Starts listening; the minute's check covers agents that still have work to merge. */
export function startBranchWatch(): void {
  if (started) return
  started = true
  onCombworkEvent(onEvent)
  setInterval(() => {
    for (const { projectPath, agentId, status } of known.values()) if (status && (status.ahead > 0 || status.dirty > 0)) void check(projectPath, agentId)
  }, 60_000).unref()
}
