import { randomBytes } from 'crypto'
import { existsSync } from 'original-fs'
import { basename, dirname, join } from 'path'
import { ROLE_MAX, SESSION_LAYOUTS, agentLimitText, agentPtyKey, layoutPanes, mergeBlocked, moveAgentTo, projectAgents, projectLayout, slugify, swapAgentsIn } from '../shared/defaults'
import { orderByCells, placedCells } from '../shared/paneCells'
import { forgetPtys } from './ptyHost'
import { agentProvider, defaultProviderPending, isKnownProvider } from '../shared/providers'
import { cleanMcpServers } from '../shared/agentMcp'
import { isWorkflowRole, type WorkflowRole } from '../shared/workflow/roles'
import type { AddAgentOptions, AddedAgent, AgentBranchStatus, AgentDef, AgentPatch, MergeResult, ProjectConfig, ProjectGitInfo, RemovedAgent, SessionLayout, WorktreeCheck, WorktreeMatch } from '../shared/types'
import { config } from './config'
import { slotLevelsOf } from './slots'
import { slotCopyOf } from '../shared/slotDefaults'
import { toast } from './events'
import { placeKey, samePlace } from './fsutil'
import { withRepoLock } from './repoLock'
import { createLogger } from './logger'
import { checkProject } from './branchWatch'
import { sessions } from './sessions'
import { endReviews, releaseAgentCards } from './tasks'
import { laneAgentRemoved } from './lanes'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { gitProblem, gitTool } from './gitTool'
import { gitProblemData } from '../shared/gitTool'
import { listOf, shownText, withValues, type Text } from '../shared/advanced'
import { msg, tr } from '../shared/i18n'
import { capturedText, HiveError, hiveError, shownError } from './hiveError'
import { providerService } from './providerService'
import { connectionOnHere } from './accounts'
import { assertNameFree, withAgentNames, workspaceAgents } from './agentNames'
import { sameAgentName } from '../shared/agentNames'
import { chooseSpace, hiveBranch, reusableBranches, type BranchHome } from '../shared/hiveBranches'
import { AGENTS_PER_PROJECT } from '../shared/advanced'
import { advanced } from './advanced'
import { legacyWorktree } from './agentFolders'
import { legacySetupPending } from '../shared/agentFolders'

const log = createLogger('agents')

/**
 * A project's agents' refusals (#848, E10d of #677) are HiveErrors: the window reads them in its language, agents (the
 * Agent API's add and change agent) in English, as before. Why an unused worktree isn't reused is text as data: English
 * for the Agent API (`notReused`), the window's language for the window (`notReusedText`, the Add Agent dialog's look).
 */
const M = {
  noAgent: msg({ id: 'worktrees.agent.gone', defaultMessage: 'That agent no longer exists.', description: 'An error: the agent being changed was removed meanwhile.' }),
  badLayout: msg({ id: 'worktrees.agent.badPlacement', defaultMessage: "The panes can't be placed like that in this layout.", description: "An error: saving where the user put the agents' panes in a layout (dragging a pane to another cell) was given a layout or places Hive doesn't know." }),
  sharedTree: msg({ id: 'worktrees.agent.sharedTree', defaultMessage: 'Another agent already works in that worktree.', description: 'An error: an agent was to be added in a worktree another agent of the project already works in.' }),
  unknownProvider: msg({ id: 'worktrees.agent.unknownProvider', defaultMessage: 'Unknown provider "{provider}".', description: 'An error: {provider} is not a coding-agent CLI this Hive knows (Claude Code, Codex…).' }),
  cantCheckAgainst: msg({ id: 'worktrees.reuse.cantCheck', defaultMessage: "git couldn't check it against {base}", description: "Why an unused worktree isn't reused for a new agent: git couldn't check whether it is merged into the branch {base}. A clause, lower case." }),
  notPinned: msg({ id: 'worktrees.agent.notPinned', defaultMessage: 'Agents aren’t pinned to worktrees in 1.0: slots are lent per card or lane.', description: "An error: an agent was to be added in a worktree of its own (a new or an existing one), which 1.0 doesn't do: Hive lends a working folder (a slot) to each card or lane instead (glossary 2.5: slot, lane)." }),
  notChecked: msg({ id: 'worktrees.reuse.notChecked', defaultMessage: 'not checked', description: "Why an unused worktree isn't reused for a new agent: it wasn't checked. A clause, lower case." })
}

/** A shared helper's text for the window (`agentLimitText`, `mergeBlocked`, given the `tr` capturedText passes), as a HiveError. */
const helperError = (fn: Parameters<typeof capturedText>[0]): HiveError => new HiveError(capturedText(fn)!)

/** Branches and worktrees for the Add Agent dialog. */
export async function gitInfo(projectPath: string): Promise<ProjectGitInfo> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  // By real paths (#389): git lists the long names, while an agent's may be saved short (8.3), or through a junction.
  const used = new Set(projectAgents(cfg).flatMap((a) => (legacyWorktree(a) ? [placeKey(legacyWorktree(a)!.path)] : [])))
  const current = await wt.currentBranch(projectPath)
  const all = await wt.listWorktrees(projectPath)
  // No worktrees listed because git can't run is not "not a repository" (#346).
  const problem = all.length ? null : gitProblem()
  return {
    isRepo: all.length > 0,
    ...(problem ? { gitProblem: problem } : {}),
    current,
    branches: await wt.localBranches(projectPath),
    worktrees: all.filter((w) => !samePlace(w.path, projectPath)).map((w) => ({ ...w, used: used.has(placeKey(w.path)) })),
    worktreesRoot: join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!),
    // The workspace part of new branches here (#703), for the dialog's default branch.
    ...(all.length ? await branchHome(projectPath).then((h) => ({ branchSpace: h.space, branchSpaces: [...(h.spaces ?? [])] })) : {})
  }
}

/**
 * Removals of worktrees (#289), by `placeKey`: when each started and, once over, ended, on one counter, so one isn't
 * removed or merged twice at once. A few hundred kept at most (the oldest ended ones go first); removals are rare. (1.0
 * gives no agent a worktree: #1451.)
 */
const removals = new Map<string, { start: number; end?: number }>()
let removalClock = 0
const REMOVALS_KEPT = 200
const worktreeKey = placeKey

/** Reserves a worktree while it is checked and removed, or an unused one merged (#400); the function returned ends it. */
export function reserveForRemoval(path: string): () => void {
  const key = worktreeKey(path)
  const was = removals.get(key)
  if (was && was.end === undefined) throw hiveError(msg({ id: 'worktrees.agent.removing', defaultMessage: 'That worktree is already being removed or merged.', description: 'An error: the worktree is being removed or merged by another action right now.' }))
  const entry: { start: number; end?: number } = { start: ++removalClock }
  removals.delete(key)
  removals.set(key, entry)
  for (const [k, r] of removals) {
    if (removals.size <= REMOVALS_KEPT) break
    if (r.end !== undefined) removals.delete(k)
  }
  return () => void (entry.end = ++removalClock)
}

/** A point to check claims against: taken before looking at the project's worktrees. */
export const claimMark = (): number => removalClock

/** Whether a worktree's removal was going on at any time since `mark` (or is now): a claim from then can't have it. */
export function removedSince(path: string, mark: number): boolean {
  const r = removals.get(worktreeKey(path))
  return !!r && (r.end === undefined || r.end > mark)
}

/**
 * project.json's list of worktrees still to set up (#289, #319), changed: `add` (kept, their setup never ran) and `drop`
 * (worked in again, or gone) applied, each once, at most 50 kept (the newest). Null when nothing changes. Under the lock.
 */
export function pendingSetupPatch(now: ProjectConfig, change: { add?: string[]; drop?: string[] }): Pick<ProjectConfig, 'setupPending'> | null {
  const before = Array.isArray(now.setupPending) ? now.setupPending.filter((p) => typeof p === 'string') : []
  const drop = new Set((change.drop ?? []).map(worktreeKey))
  const list = new Map<string, string>()
  for (const p of [...before, ...(change.add ?? [])]) if (!drop.has(worktreeKey(p))) list.set(worktreeKey(p), p)
  const after = [...list.values()].slice(-50)
  return after.length === before.length && after.every((p, i) => p === before[i]) ? null : { setupPending: after }
}

/**
 * How many agents this project can have (#562): its workspace's own Agents per project, else Settings → Advanced's, else
 * 12. Read afresh each time (under the project's lock too), so a change applies at once.
 */
export function agentLimit(projectPath: string): number {
  return advanced.get<number>(AGENTS_PER_PROJECT, workspaceOf(projectPath).config.advanced)
}

export async function addAgent(projectPath: string, opts: AddAgentOptions): Promise<AddedAgent> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  const limit = agentLimit(projectPath)
  if (agents.length >= limit) throw helperError((t) => agentLimitText(limit, t))
  // Unique across the workspace (#702): the default "Agent n" too, numbered past the other projects' names.
  const everyone = await workspaceAgents(projectPath)
  let n = agents.length + 1
  while (everyone.some((a) => sameAgentName(a.name, `Agent ${n}`))) n++ // i18n-ignore: the default agent name, kept as it is (agents address each other by it)
  const name = opts.name?.trim() || `Agent ${n}` // i18n-ignore: the default agent name, kept as it is (agents address each other by it)
  // Before a worktree is made for it, then again with the write (below).
  await assertNameFree(projectPath, name)
  const { def, discard } = await prepareAgent(projectPath, cfg, opts, name, agents)
  try {
    await withAgentNames(projectPath, async () => {
      // Checked again with the write: another add or rename (the UI and the Assistant at once, another project) may have come first.
      await assertNameFree(projectPath, name)
      await workspace.mutateProjectConfig(projectPath, (now) => {
        const list = projectAgents(now)
        // The limit as it is now: Settings may have lowered it since the check above.
        const max = agentLimit(projectPath)
        if (list.length >= max) throw helperError((t) => agentLimitText(max, t))
        if (list.some((a) => sameAgentName(a.name, name))) throw hiveError(msg({ id: 'worktrees.agent.nameTaken', defaultMessage: 'There is already an agent called "{name}".', description: 'An error: the project already has an agent with the name {name}.' }), { name })
        // An automatic layout follows the agents, so the new one shows; with one chosen by hand, a full page sends it to the next (#134).
        return { agents: [...list, def] }
      })
    })
  } catch (e) {
    await discard()
    throw e
  }
  await workspaceOf(projectPath).refresh()
  return def
}

/** Whether a worktree on `branch` is merged into `base` (a squash merge counting) and clean: its commits then, or why not. */
async function reuseCheck(projectPath: string, path: string, branch: string, base: string): Promise<{ tip: string; baseTip: string } | { why: Text }> {
  const [tip, baseTip] = await Promise.all([wt.tipOf(projectPath, branch), wt.tipOf(projectPath, base)])
  const [ahead, dirty] = tip && baseTip ? await Promise.all([wt.unmergedCommits(projectPath, baseTip, tip), wt.dirtyCount(path)]) : [null, null]
  if (!tip || !baseTip || ahead === null || dirty === null) return { why: gitProblemData(gitTool()) ?? withValues(M.cantCheckAgainst, { base }) }
  const why: Text[] = [
    ...(ahead ? [withValues(msg({ id: 'worktrees.reuse.notMerged', defaultMessage: '{n, plural, one {# commit} other {# commits}} not merged into {base}', description: "Why an unused worktree isn't reused for a new agent: commits on its branch that the branch {base} doesn't have. A clause, lower case; it may be joined with the uncommitted files in a list." }), { n: ahead, base })] : []),
    ...(dirty ? [withValues(msg({ id: 'worktrees.reuse.uncommitted', defaultMessage: '{n, plural, one {# uncommitted file} other {# uncommitted files}}', description: "Why an unused worktree isn't reused for a new agent: files changed in it and not committed. A clause, lower case; it may be joined with the unmerged commits in a list." }), { n: dirty })] : [])
  ]
  return why.length ? { why: why.length === 1 ? why[0] : listOf(why) } : { tip, baseTip }
}

/**
 * Where a project is, for the branches Hive makes in it (#703): its workspace's folder name and its own, and the other
 * workspace parts Hive has given its branches (project.json's `branchSpaces`): with the workspace's own, the only ones
 * that are its.
 */
export async function branchPlace(projectPath: string): Promise<BranchHome> {
  const recorded = (await workspace.projectConfig(projectPath)).branchSpaces
  return { workspace: basename(workspaceOf(projectPath).path ?? ''), project: basename(projectPath), spaces: Array.isArray(recorded) ? recorded.filter((s) => typeof s === 'string') : [] }
}

/**
 * The same, with the workspace part its new branches take in its repository now (`chooseSpace`: its own or the one it
 * moved to, clear of branches from before), and whether that part is new (recorded once a branch is made in it).
 * `reads`: the branches as one operation read them (#732).
 */
export async function branchHome(projectPath: string, reads?: wt.RepoReads): Promise<BranchHome & { newSpace: boolean }> {
  const home = await branchPlace(projectPath)
  const { space, isNew } = chooseSpace(home, await (reads ? reads.branchesStrict().catch(() => []) : wt.localBranches(projectPath)))
  return { ...home, space, newSpace: isNew }
}

/**
 * The project's unused worktree on `branch` (#456), checked against `base`: one in Hive's worktrees folder for the
 * project that git lists on that branch and no agent (`others`) works in. When `branch` is the full-form branch of the
 * agent called `name`, one on the branch Hive made for that name before (hive/<its slug>, #703) is found too, the full
 * form first. Null when there is none.
 */
export async function matchingWorktree(projectPath: string, branch: string, base: string, others: readonly AgentDef[], name?: string): Promise<WorktreeMatch | null> {
  const m = await matchingTree(projectPath, branch, base, others, name)
  if (!m) return null
  const { whyText, ...match } = m
  // The Add Agent dialog's look: the window's.
  return whyText ? { ...match, why: shownText(whyText) } : match
}

/** `matchingWorktree`, with why it isn't reusable as text as data (for a reuse's note, in English and the window's language). */
async function matchingTree(projectPath: string, branch: string, base: string, others: readonly AgentDef[], name?: string): Promise<(Omit<WorktreeMatch, 'why'> & { whyText?: Text }) | null> {
  const root = placeKey(join(workspaceOf(projectPath).worktreesRoot, basename(projectPath)))
  const used = new Set(others.flatMap((a) => (legacyWorktree(a) ? [placeKey(legacyWorktree(a)!.path)] : [])))
  const listed = (await wt.listWorktrees(projectPath)).filter((x) => !samePlace(x.path, projectPath) && placeKey(dirname(x.path)) === root && !used.has(placeKey(x.path)) && existsSync(x.path))
  const w = reusableBranches(branch, await branchPlace(projectPath), name)
    .map((b) => listed.find((x) => x.branch === b))
    .find((x) => !!x)
  if (!w?.branch) return null
  const checked = await reuseCheck(projectPath, w.path, w.branch, base)
  return { path: w.path, branch: w.branch, base, reusable: !('why' in checked), ...('why' in checked ? { whyText: checked.why } : {}) }
}

/** The Add Agent dialog's look before adding (#456): the unused worktree a new one on `branch` from `base` would reuse. */
export async function worktreeMatch(projectPath: string, branch: string, base: string, name?: string): Promise<WorktreeMatch | null> {
  projectPath = workspace.assertProject(projectPath)
  return matchingWorktree(projectPath, branch.trim(), base, projectAgents(await workspace.projectConfig(projectPath)), typeof name === 'string' ? name : undefined)
}

/** Records a workspace part Hive has made a branch in for this project (#703 round 3), so it stays this project's. */
async function recordSpace(projectPath: string, space: string): Promise<void> {
  await workspace.mutateProjectConfig(projectPath, (now) => {
    const before = Array.isArray(now.branchSpaces) ? now.branchSpaces : []
    return before.some((s) => s.toLowerCase() === space.toLowerCase()) ? {} : { branchSpaces: [...before, space] }
  })
}

/**
 * Where a new worktree for an agent called `name` goes in this project: a new branch `hive/<workspace>/<project>/<name>`
 * (#703) in the project's own repository and a folder in the workspace's worktree location under the project's name, each numbered (`-2`) when taken.
 * `taken`: branches and folders (`placeKey`s) a plan has already given out. Shared by adding an agent and by a template's
 * load plan (#268), so what the plan shows is what the load makes. `reads`: the branches as one operation read them (#732).
 */
export async function newWorktreePlace(projectPath: string, name: string, branch?: string, taken: { branches: ReadonlySet<string>; folders: ReadonlySet<string> } = { branches: new Set(), folders: new Set() }, reads?: wt.RepoReads): Promise<{ branch: string; path: string; newSpace?: string }> {
  // One read of the branches for both (#732): its workspace part and a free name.
  const repo = reads ?? new wt.RepoReads(projectPath)
  const home = await branchHome(projectPath, repo)
  const generated = hiveBranch(home, name)
  // The default Hive generates for this name, whether left out or sent back as it was shown (the Add Agent dialog and the
  // Agent API send the branch they show, #703 round 4); a branch of the user's own is never taken as a part Hive gave.
  const supplied = branch?.trim()
  const isDefault = !supplied || supplied.toLowerCase() === generated.toLowerCase()
  return {
    branch: await wt.uniqueBranch(projectPath, supplied || generated, taken.branches, repo),
    path: wt.uniqueFolder(join(workspaceOf(projectPath).worktreesRoot, projectPath.split(/[\\/]/).pop()!, slugify(name)), taken.folders),
    // A workspace part this project hasn't had: recorded once its branch is made (#703 round 3).
    ...(isDefault && home.newSpace && home.space ? { newSpace: home.space } : {})
  }
}

/**
 * For test copies only (#1451, `agents:testLegacy`): an agent with a 0.9 worktree of its own, as a project upgraded from
 * 0.9 has one. 1.0 gives no agent a worktree (`prepareAgent` refuses it); the suites that check what 0.9 worktrees still
 * do (Repair, removal, Unused worktrees, the merge queue's fixtures) make them this way: added in the project folder,
 * then given a worktree made as 0.9 made it (`new-worktree`: a new branch from the base, the project's ignored files
 * copied in) or one that is there (`existing-worktree`), its setup still to run when the project has one.
 */
export async function addLegacyAgent(projectPath: string, opts: AddAgentOptions): Promise<AgentDef> {
  projectPath = workspace.assertProject(projectPath)
  const cfg = await workspace.projectConfig(projectPath)
  let tree: wt.WorktreeRef
  if (opts.location === 'existing-worktree') {
    const found = (await wt.listWorktrees(projectPath)).find((w) => !!opts.worktreePath && placeKey(w.path) === placeKey(opts.worktreePath))
    if (!found?.branch) throw new Error(`not a worktree of this project on a branch: ${opts.worktreePath}`) // i18n-ignore: a test channel, never shown
    tree = { path: found.path, branch: found.branch, base: (await wt.currentBranch(projectPath)) ?? found.branch }
  } else {
    const base = opts.base || (await wt.currentBranch(projectPath)) || 'main'
    const name = opts.name?.trim() || 'Agent' // i18n-ignore: a test channel's fallback for a worktree's folder name
    const { branch, path: dest, newSpace } = await newWorktreePlace(projectPath, name, opts.branch)
    await wt.createWorktree(projectPath, dest, branch, base)
    if (newSpace) await recordSpace(projectPath, newSpace)
    await wt.copyIgnored(projectPath, dest, slotCopyOf(cfg, slotLevelsOf(config.settings, workspaceOf(projectPath))).value)
    tree = { path: dest, branch, base }
  }
  const def = await addAgent(projectPath, { ...opts, location: 'project', branch: undefined, base: undefined, worktreePath: undefined, reuseWorktree: undefined })
  const now = await workspace.updateLegacyAgent(projectPath, def.id, { worktree: tree, ...(cfg.worktreeSetup.trim() ? { needsSetup: true } : {}) })
  await workspaceOf(projectPath).refresh()
  return now
}

/**
 * A new agent's definition, ready to add but not added (#126: a template stages its agents, then adds them all at once):
 * its id and settings, in no worktree (#1451: agents work where their card's or lane's slot is lent, or the project
 * folder). `discard` undoes what preparing made, for when it isn't added after all: nothing now. `others` and `reads`
 * stay for the template's load, which passes them.
 */
export async function prepareAgent(projectPath: string, cfg: ProjectConfig, opts: AddAgentOptions, name: string, others: AgentDef[], reads?: wt.RepoReads): Promise<{ def: AgentDef; discard: () => Promise<void> }> {
  // 1.0 (#1451): an agent isn't pinned to a worktree (slots are lent per card or lane), so a worktree of its own, new or
  // existing, is refused, never silently ignored (`reuseWorktree` alone asks for none: the window's dialog still sends it
  // until #1442).
  if ((opts.location && opts.location !== 'project') || opts.worktreePath || opts.branch || opts.base) throw hiveError(M.notPinned, undefined, { kind: 'invalid' })
  void others
  void reads
  // Never reused: sessions of a removed agent keep its id and must not attach to a new one.
  const id = `a-${randomBytes(4).toString('hex')}`

  // The provider is stored on the agent, so changing a default later doesn't move existing agents. Automatic's is only
  // known once Hive has looked for every CLI before the one it found (#506).
  if (!opts.provider && defaultProviderPending(cfg, config.settings)) await providerService.settle()
  const provider = opts.provider || agentProvider(null, cfg, config.settings)
  if (!isKnownProvider(provider)) throw hiveError(M.unknownProvider, { provider }, { kind: 'invalid' })
  const def: AgentDef = { id, name, provider }
  if (opts.model) def.model = opts.model
  if (opts.effort) def.effort = opts.effort
  if (opts.permissionMode) def.permissionMode = opts.permissionMode
  if (typeof opts.use200kContext === 'boolean') def.use200kContext = opts.use200kContext
  const role = cleanRole(opts.role)
  if (role) def.role = role
  if (opts.workflowRole !== undefined) def.workflowRole = cleanWorkflowRole(opts.workflowRole)
  const mcpServers = cleanMcpServers(opts.mcpServers)
  if (mcpServers) def.mcpServers = mcpServers
  // Its connection (HI-1755), when it is one of its provider's on in this workspace; else it uses the default.
  if (opts.connection && connectionOnHere(opts.connection, provider, projectPath)) def.connection = opts.connection

  return { def, discard: async () => undefined }
}

/** A role as saved: trimmed, one line, at most ROLE_MAX characters ('' for none). */
export function cleanRole(role: unknown): string {
  if (typeof role !== 'string') return ''
  const r = role.replace(/\s+/g, ' ').trim()
  if (r.length > ROLE_MAX) throw hiveError(msg({ id: 'worktrees.agent.roleTooLong', defaultMessage: 'A role is at most {max} characters.', description: "An error: an agent's role (what it does, in a few words) is longer than it may be ({max}, a number)." }), { max: ROLE_MAX })
  return r
}

/** A workflow role as saved (#1430): builder, reviewer or either, else refused. */
export function cleanWorkflowRole(role: unknown): WorkflowRole {
  if (isWorkflowRole(role)) return role
  throw hiveError(msg({ id: 'worktrees.agent.badWorkflowRole', defaultMessage: 'A role in the workflow is builder, reviewer or either.', description: "An error: an agent's role in the workflow was given as something else. builder, reviewer and either are values: keep them in English." }), undefined, { kind: 'invalid' })
}

export async function updateAgent(projectPath: string, agentId: string, patch: AgentPatch, opts: { check?: (current: AgentDef) => void } = {}): Promise<AgentDef> {
  // The Hive Assistant's settings for this workspace are its agent's, too (it keeps its name).
  projectPath = workspace.assertSessionHost(projectPath)
  // The Assistant gets Hive's own tools, not the projects' MCP servers, whatever it is given (sessions.ts).
  if (workspace.isAssistantHome(projectPath)) {
    delete patch.name
    delete patch.mcpServers
  } else delete patch.mode
  const cfg = await workspace.projectConfig(projectPath)
  const agents = projectAgents(cfg)
  if (patch.name !== undefined) {
    patch.name = patch.name.trim()
    if (!patch.name) throw hiveError(msg({ id: 'worktrees.agent.enterName', defaultMessage: 'Enter a name.', description: "An error: an agent's name was emptied." }))
  }
  // Empty values clear an override so the agent follows the project again (and an empty role: its name is its role).
  const { use200kContext, mcpServers, workflowRole, connection, ...rest } = patch
  const clean: Partial<AgentDef> = { ...rest }
  // Its connection (HI-1755): null or empty, the workspace's default again.
  if (connection !== undefined) clean.connection = connection || undefined
  if ('role' in clean) clean.role = cleanRole(clean.role) || undefined
  // null clears it (an undo of the Assistant's change, #1282): the guess again. Absent, it stays as it is.
  if (workflowRole === null) clean.workflowRole = undefined
  else if (workflowRole !== undefined) clean.workflowRole = cleanWorkflowRole(workflowRole)
  // null: all of the project's servers again (#537).
  if (mcpServers !== undefined) clean.mcpServers = cleanMcpServers(mcpServers)
  for (const k of ['model', 'effort', 'permissionMode', 'mode'] as const) if (k in clean && !clean[k]) clean[k] = undefined
  if (use200kContext !== undefined) clean.use200kContext = typeof use200kContext === 'boolean' ? use200kContext : undefined
  if (patch.provider !== undefined) {
    const current = agents.find((a) => a.id === agentId)
    if (!isKnownProvider(patch.provider)) throw hiveError(M.unknownProvider, { provider: patch.provider }, { kind: 'invalid' })
    if (current && agentProvider(current, cfg, config.settings) !== patch.provider) {
      if (sessions.liveFor(projectPath, agentId)) throw hiveError(msg({ id: 'worktrees.agent.stopForProvider', defaultMessage: 'Stop the agent before changing its provider.', description: "An error: an agent's provider (its coding-agent CLI) can't change while it runs." }), undefined, { kind: 'conflict' })
      // Model, effort, mode and context belong to the old provider, and its conversations can't be resumed by the new one.
      Object.assign(clean, { model: patch.model || undefined, effort: patch.effort || undefined, permissionMode: patch.permissionMode || undefined, use200kContext: typeof use200kContext === 'boolean' ? use200kContext : undefined, lastSessionId: undefined, connection: connection || undefined })
    }
  }
  // A name: free across the workspace (#702), checked holding the names lock against the agent as saved then, just
  // before the write (every change of a name takes that lock, so none comes between). Its own name again is no change:
  // an agent sharing its name from before names were unique keeps it while its other settings change, but only while it
  // still has that name. The Assistant's agent is never renamed.
  const name = patch.name
  const def =
    name !== undefined
      ? await withAgentNames(projectPath, async () => {
          const now = projectAgents(await workspace.projectConfig(projectPath)).find((a) => a.id === agentId)
          if (!now || !sameAgentName(now.name, name)) await assertNameFree(projectPath, name, { self: agentId })
          return workspace.updateAgent(projectPath, agentId, clean, opts.check)
        })
      : await workspace.updateAgent(projectPath, agentId, clean, opts.check)
  const live = sessions.liveFor(projectPath, agentId)
  if (live && patch.name) live.agentName = patch.name
  await workspaceOf(projectPath).refresh()
  return def
}

/**
 * Removes an agent (stopped). `releaseCards` takes its open cards from it too (Doing ones back to Todo). `deleteWorktree`
 * deletes its worktree and branch; 'merged-clean' (Remove All, #291) only when they are merged into the main branch (the
 * one the user was shown, `mergedInto`) and clean now, checked here and guarded while deleting (`removeCheckedWorktree`),
 * and no other agent of the project works in that worktree: otherwise they are kept and the reply says why.
 */
export async function removeAgent(projectPath: string, agentId: string, opts: { deleteWorktree: boolean | 'merged-clean'; mergedInto?: string | null; releaseCards?: boolean }): Promise<RemovedAgent> {
  projectPath = workspace.assertProject(projectPath)
  if (sessions.liveFor(projectPath, agentId)) throw hiveError(msg({ id: 'worktrees.agent.stopToRemove', defaultMessage: 'Stop the agent before removing it.', description: "An error: a running agent can't be removed." }), undefined, { kind: 'conflict' })
  const cfg = await workspace.projectConfig(projectPath)
  const def = cfg.agents.find((a) => a.id === agentId)
  if (!def) return {}
  const tree = legacyWorktree(def)
  let result: RemovedAgent = {}
  if (tree && opts.deleteWorktree === 'merged-clean') {
    const shared = projectAgents(cfg).some((a) => a.id !== agentId && legacyWorktree(a) && samePlace(legacyWorktree(a)!.path, tree.path))
    const done = shared ? { deleted: false, reason: tr(msg({ id: 'worktrees.agent.treeShared', defaultMessage: 'another agent works in it', description: "Why a removed agent's worktree was kept: another agent of the project works in it. A clause, lower case." })) } : await wt.removeCheckedWorktree(projectPath, tree, await wt.worktreeCheck(projectPath, tree), opts.mergedInto)
    result = { worktree: { path: tree.path, branch: tree.branch, ...done } }
  } else if (tree && opts.deleteWorktree) {
    await wt.removeWorktree(projectPath, tree, true)
    result = { worktree: { path: tree.path, branch: tree.branch, deleted: true } }
  } else if (tree) result = { worktree: { path: tree.path, branch: tree.branch, deleted: false } }
  await workspace.mutateProjectConfig(projectPath, (now) => {
    // Its worktree kept before its setup ever ran (#319): remembered, so the next agent given it runs setup first; one
    // deleted is forgotten. As the agent is now, under the lock; a worktree another agent works in is that agent's.
    const was = now.agents.find((a) => a.id === agentId)
    const left = now.agents.filter((a) => a.id !== agentId)
    const keptTree = result.worktree && !result.worktree.deleted ? legacyWorktree(was) : null
    const pending = keptTree && legacySetupPending(was) && now.worktreeSetup.trim() && !left.some((a) => legacyWorktree(a) && samePlace(legacyWorktree(a)!.path, keptTree.path)) ? [keptTree.path] : []
    const gone = result.worktree?.deleted ? [result.worktree.path] : []
    return { agents: left, ...pendingSetupPatch(now, { add: pending, drop: gone }) }
  })
  if (opts.releaseCards) await releaseAgentCards(basename(projectPath), agentId, { kind: 'user' })
  // A review it left going (from before Hive last started) ends with it.
  await endReviews(basename(projectPath), agentId, 'the agent was removed', workspaceOf(projectPath)) // i18n-ignore: the reason's key (ReviewEnd): the history line is a message (#846)
  // Its lanes, as builder or reviewer, are abandoned (#483).
  await laneAgentRemoved(workspaceOf(projectPath), basename(projectPath), agentId).catch((e) => log.warn('abandoning the lanes of a removed agent', e))
  // Its terminal's kept size and output go: a new agent never has its id (#489).
  forgetPtys(agentPtyKey(projectPath, agentId))
  await workspaceOf(projectPath).refresh()
  return result
}

/**
 * For each worktree agent of the project, whether its worktree could be deleted without losing work (#291). Read-only,
 * so one set of reads serves them all (#733): the main branch, its commit and the worktree list are read once, not once
 * per agent. Removing one checks it afresh (`removeAgent`).
 */
export async function worktreeChecks(projectPath: string): Promise<({ agentId: string } & WorktreeCheck)[]> {
  projectPath = workspace.assertProject(projectPath)
  const agents = projectAgents(await workspace.projectConfig(projectPath))
  const reads = new wt.RepoReads(projectPath)
  const out: ({ agentId: string } & WorktreeCheck)[] = []
  for (const a of agents) {
    const tree = legacyWorktree(a)
    if (tree) out.push({ agentId: a.id, ...(await wt.worktreeCheck(projectPath, tree, reads)) })
  }
  return out
}

/** Moves an agent to `index` in the project's order (its position afterwards); returns the agents' ids in the new order. */
export async function moveAgent(projectPath: string, agentId: string, index: number): Promise<string[]> {
  projectPath = workspace.assertProject(projectPath)
  if (!Number.isFinite(index)) throw hiveError(msg({ id: 'worktrees.agent.chooseMove', defaultMessage: 'Choose where to move the agent.', description: "An error: an agent was to be moved in the project's order, with no place given." }))
  const next = await workspace.mutateProjectConfig(projectPath, (now) => {
    const list = projectAgents(now)
    if (!list.some((a) => a.id === agentId)) throw hiveError(M.noAgent, undefined, { kind: 'notFound' })
    return { agents: moveAgentTo(list, agentId, index) }
  })
  await workspaceOf(projectPath).refresh()
  return projectAgents(next).map((a) => a.id)
}

/**
 * Swaps two agents' places in the project's order (#135: one dropped on another's pane), under the project file's lock so
 * a change meanwhile isn't lost. Returns the order as saved.
 */
export async function swapAgents(projectPath: string, agentId: string, otherId: string): Promise<string[]> {
  projectPath = workspace.assertProject(projectPath)
  const next = await workspace.mutateProjectConfig(projectPath, (now) => {
    const list = projectAgents(now)
    if (!list.some((a) => a.id === agentId) || !list.some((a) => a.id === otherId)) throw hiveError(M.noAgent, undefined, { kind: 'notFound' })
    return { agents: swapAgentsIn(list, agentId, otherId) }
  })
  await workspaceOf(projectPath).refresh()
  return projectAgents(next).map((a) => a.id)
}

/**
 * Saves where the user put the panes in one layout (#762): its cells, page after page, an agent's id or null, and the
 * agents' order as the cells read. Ids of agents removed meanwhile go (their cells stay empty), and agents added meanwhile
 * take a cell. An automatic layout becomes the one shown, chosen: the user has
 * placed its panes. Returns the cells as saved.
 */
export async function placePanes(projectPath: string, layout: SessionLayout, cells: (string | null)[]): Promise<(string | null)[]> {
  projectPath = workspace.assertProject(projectPath)
  if (layout === 'single' || !SESSION_LAYOUTS.some((l) => l.value === layout)) throw hiveError(M.badLayout)
  if (!Array.isArray(cells) || cells.length > 48 || cells.some((c) => c !== null && (typeof c !== 'string' || c.length > 200))) throw hiveError(M.badLayout)
  // An agent in one cell only.
  const named = cells.filter((c): c is string => c !== null)
  if (new Set(named).size !== named.length) throw hiveError(M.badLayout)
  let saved: (string | null)[] = []
  await workspace.mutateProjectConfig(projectPath, (now) => {
    // Agents gone meanwhile leave their cell empty; agents added meanwhile take one, as on any change of agents.
    saved = placedCells(projectAgents(now).map((a) => a.id), cells, layoutPanes(layout))
    return { placement: { ...now.placement, [layout]: saved }, agents: orderByCells(projectAgents(now), saved), ...(now.layout === 'auto' ? { layout: projectLayout(now) } : {}) }
  })
  await workspaceOf(projectPath).refresh()
  return saved
}

async function worktreeOf(projectPath: string, agentId: string) {
  const def = projectAgents(await workspace.projectConfig(projectPath)).find((a) => a.id === agentId)
  const worktree = legacyWorktree(def)
  if (!def || !worktree) throw hiveError(msg({ id: 'worktrees.agent.noTree', defaultMessage: 'This agent works in the project folder, not a worktree.', description: "An error: something only a worktree agent has (its branch's state, a merge) was asked of an agent working in the project folder." }))
  return { def, worktree }
}

export async function branchStatus(projectPath: string, agentId: string): Promise<AgentBranchStatus> {
  projectPath = workspace.assertProject(projectPath)
  return wt.branchStatus(projectPath, (await worktreeOf(projectPath, agentId)).worktree)
}

/**
 * Runs the user's merge holding the merge slot of the branch it merges into (#350). mergeSlotHost sets it at startup
 * (this module stays below the slot service); until then a merge runs as it is.
 */
let userMergeSlot: (projectPath: string, branch: string, run: () => Promise<MergeResult>) => Promise<MergeResult> = (_p, _b, run) => run()
export function setUserMergeSlot(fn: typeof userMergeSlot): void {
  userMergeSlot = fn
}

/**
 * Merges a worktree's branch into the project folder's, the user's way: one merge at a time per repository, across
 * Hives too (the repository lock, #1347: two would stage and commit into each other), holding the merge slot of the
 * branch it merges into (#350), so an agent's merge doesn't land in the middle. An agent's merge and an unused
 * worktree's (#400) both go through it.
 */
export async function mergeInProject(projectPath: string, worktree: wt.WorktreeRef, opts: { squash: boolean; message: string; moveBranch?: boolean; target?: string }): Promise<MergeResult> {
  // The merge slot of the branch merged into: the target named (#1450's branch merges), else the project folder's.
  const into = opts.target ?? (await workspace.branch(projectPath))
  const run = (): Promise<MergeResult> => withRepoLock(projectPath, () => wt.mergeWorktree(projectPath, worktree, opts), { project: projectPath })
  return into ? await userMergeSlot(projectPath, into, run) : await run()
}

export async function merge(projectPath: string, agentId: string, opts: { squash: boolean; message: string; cleanup: boolean; moveBranch?: boolean }): Promise<MergeResult> {
  projectPath = workspace.assertProject(projectPath)
  const { def, worktree } = await worktreeOf(projectPath, agentId)
  if (opts.cleanup && sessions.liveFor(projectPath, agentId)) throw hiveError(msg({ id: 'worktrees.agent.stopToMerge', defaultMessage: 'Stop {agent} before merging and removing its worktree.', description: 'An error: a merge that also removes the worktree needs the agent {agent} (its name) stopped first.' }), { agent: def.name })
  // Its branch is merged as committed: not while it may still commit to it, in the middle of a task.
  const status = sessions.liveFor(projectPath, agentId)?.status
  if (mergeBlocked(def.name, status)) throw helperError((t) => mergeBlocked(def.name, status, t))
  // One merge at a time, holding the slot (the Merge dialog waits until it is free). A branch removed afterwards isn't moved.
  const result = await mergeInProject(projectPath, worktree, { ...opts, moveBranch: opts.moveBranch && !opts.cleanup })
  // The project folder's branch moved on: every worktree agent's unmerged work is counted again.
  if (!result.ok || !opts.cleanup) {
    workspaceOf(projectPath).scheduleRefresh()
    void checkProject(projectPath)
    return result
  }
  try {
    await wt.removeWorktree(projectPath, worktree, true)
    await workspace.mutateProjectConfig(projectPath, (now) => ({ agents: now.agents.filter((a) => a.id !== agentId) }))
    await workspaceOf(projectPath).refresh()
    void checkProject(projectPath)
    return { ...result, cleanedUp: true }
  } catch (e) {
    toast('warning', tr(msg({ id: 'worktrees.merge.notRemoved', defaultMessage: 'Merged, but the worktree was not removed', description: "A notification's title: the agent's work was merged, but removing its worktree afterwards failed (the reason follows)." })), shownError(e), undefined, projectPath)
    return result
  }
}
