import { existsSync } from 'original-fs'
import { readFile, stat } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { MoveBranch, MoveCards, MoveHostPlan, MoveOptions, MoveOwner, MovePlan, MoveReport, MoveWorktree, PathDataCopy, ProjectConfig, WorkspaceMoved } from '../shared/types'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { fmt, msg, tr } from '../shared/i18n'
import { moveHasWork, rebase, rebaseAny, samePath, worktreeCandidates, type PathMove } from '../shared/movePaths'
import { recreateWorktree } from './agentWorktree'
import { config } from './config'
import { realPath, samePlace } from './fsutil'
import { git } from './git'
import { createLogger, userText } from './logger'
import { allProviders } from './providers'
import { recentChanged } from './recentWorkspaces'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'
import { listWorktrees, localBranches } from './worktrees'
import { workflowFor } from './workflow/service'
import { reconcilersIdle } from './workflow/reconciler'
import { branchHere, chooseSpace, refPart, type BranchHome } from '../shared/hiveBranches'
import { orphanNames } from '../shared/projectIds'
import { legacyCards, moveOrphanCards, stampCardProjects } from './tasks'
import { legacyLanes, moveOrphanLanes } from './lanes'
import { legacyWatches, moveOrphanWatches } from './watches'
import { adoptHandovers } from './notes'
import { noteFormerName } from './projectNames'
import { adoptBenchmarkOwners, benchContext } from './benchmarks'

/**
 * A workspace (or project) moved to another folder (#146). Hive records where each was last opened (`lastPath` in
 * workspace.json and project.json); when that differs, what is stored by absolute path is out of date: agents'
 * worktrees (and git's links both ways), session folders, Claude Code's per-path transcripts and memory, the recent
 * list. The plan says what Repair would do; repair does it, refusing while agents run. Every step can run again
 * harmlessly, and nothing at the old location is ever deleted.
 */

const log = createLogger('move')

const assistantName = (): string => tr(msg({ id: 'main.move.assistant', defaultMessage: 'Hive Assistant', description: "The Hive Assistant's name, where Repair (after a workspace moved) lists what it repairs and the agents still running." }))
const PROJECT_FILE = join(HIVE_DIR, 'project.json')

/** Whether p is inside root (or is it). */
const under = (p: string, root: string): boolean => rebase(p, root, root) !== null

/**
 * A moved project folder (or the Assistant's home), where its sessions ran then (from) and now (folder): its own folder,
 * except the Assistant's, which works in the workspace folder.
 */
interface Host {
  path: string
  name: string
  from: string
  folder: string
  /** The Assistant's home: no worktrees, and it moved with the workspace. */
  assistant: boolean
  /** Only earlier moves' data left to copy: the folder itself hasn't moved since it was recorded. */
  pendingOnly?: boolean
}

/** Whether a folder is a git worktree's (it has a .git file, not a folder). */
async function isWorktreeFolder(p: string): Promise<boolean> {
  return (await stat(join(p, '.git')).catch(() => null))?.isFile() ?? false
}

/** Whether git's links between a repository and one of its worktrees are right both ways (by real paths: git writes the long names, #389). */
async function linked(repo: string, wt: string): Promise<boolean> {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(join(wt, '.git'), 'utf8'))?.[1]?.trim()
    if (!gitdir || !under(realPath(resolve(wt, gitdir)), realPath(join(repo, '.git', 'worktrees')))) return false
    const back = (await readFile(join(resolve(wt, gitdir), 'gitdir'), 'utf8')).trim()
    return samePlace(resolve(back), join(wt, '.git'))
  } catch {
    return false
  }
}

/** Records where the workspace and its projects are, for those that have no record yet (opened before #146). */
async function recordNew(ws: WorkspaceService, projects: string[]): Promise<void> {
  if (!ws.config.lastPath && ws.path) {
    ws.config.lastPath = ws.path
    await ws.saveWorkspaceConfig()
  }
  for (const p of projects) if (!(await ws.projectConfig(p)).lastPath) await ws.mutateProjectConfig(p, (c) => (c.lastPath ? {} : { lastPath: p }))
}

/** The workspace's project folders that have Hive's files (hidden ones too). */
async function projectFolders(ws: WorkspaceService): Promise<string[]> {
  const all = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  return all.filter((p) => existsSync(join(p, PROJECT_FILE)))
}

/** The projects (and the Assistant's home) whose recorded folder isn't where they are now. */
async function movedHosts(ws: WorkspaceService): Promise<{ from: string | null; hosts: Host[] }> {
  const here = ws.path!
  // By real paths (#455): the same folder opened by another name (an 8.3 short name, a junction) hasn't moved.
  const wsFrom = ws.config.lastPath && !samePlace(ws.config.lastPath, here) ? ws.config.lastPath : null
  const hosts: Host[] = []
  for (const p of await projectFolders(ws)) {
    const cfg = await ws.projectConfig(p)
    const moved = !!cfg.lastPath && !samePlace(cfg.lastPath, p)
    // A project whose move was repaired but some of whose data copies didn't work is still to finish.
    if (moved || cfg.pendingCopies?.length) hosts.push({ path: p, name: basename(p), from: moved ? cfg.lastPath! : p, folder: p, assistant: false, ...(moved ? {} : { pendingOnly: true }) })
  }
  if (wsFrom) hosts.push({ path: ws.assistantHome, name: assistantName(), from: wsFrom, folder: here, assistant: true })
  return { from: wsFrom, hosts }
}

/** Where each agent worktree of a moved project is now, or why it can't be repaired. */
async function worktreesOf(ws: WorkspaceService, host: Host, wsMove: PathMove, opts: MoveOptions): Promise<MoveWorktree[]> {
  if (host.assistant) return []
  const out: MoveWorktree[] = []
  const projectMove = { from: host.from, to: host.folder }
  const copied = existsSync(host.from)
  for (const a of projectAgents(await ws.projectConfig(host.path))) {
    if (!a.worktree) continue
    const key = `${host.path}#${a.id}`
    const base = { agentId: a.id, agentName: a.name, from: a.worktree.path }
    if (opts.unlink?.includes(key)) {
      out.push({ ...base, to: null, how: 'unlink' })
      continue
    }
    const picked = opts.locate?.[key]
    if (picked && (await isWorktreeFolder(picked))) {
      if (!(await linked(host.path, picked)) || !samePlace(picked, a.worktree.path)) out.push({ ...base, to: resolve(picked), how: 'located' })
      continue
    }
    // Already right (repaired before, or a worktree the move didn't touch).
    if (await linked(host.path, a.worktree.path)) continue
    const candidates = worktreeCandidates(a.worktree.path, wsMove, projectMove)
    let found: string | null = null
    for (const c of candidates) {
      if (await isWorktreeFolder(c)) {
        found = c
        break
      }
    }
    if (!found) {
      // Its branch lives in the repository: Recreate makes the worktree again on it (where it would have moved to).
      const branch = { branch: a.worktree.branch, branchExists: (await git(host.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${a.worktree.branch}`])).ok }
      out.push(opts.recreate?.includes(key) ? { ...base, ...branch, to: candidates[0], how: 'recreate' } : { ...base, ...branch, to: null, how: 'missing' })
    }
    // Still at its old place while the project is at its old folder too: a copy, and the original keeps its worktree.
    else if (samePath(found, a.worktree.path) && copied) out.push({ ...base, to: null, how: 'original' })
    else out.push({ ...base, to: found, how: samePath(found, a.worktree.path) ? 'stayed' : 'moved' })
  }
  return out
}

/**
 * Agents' branches named after where the workspace or project was (#1305, `branchHere`), and the name each takes here:
 * first a rename a Repair before began and couldn't finish (project.json's `pendingBranchRenames`), then every worktree
 * agent of the project whose recorded branch is in the repository, or is the one its worktree is recreated on by this
 * Repair, except those whose worktree this plan still has to find, unlinks or leaves to the original (their branch is
 * renamed by the Repair after). A name already taken is kept, and said.
 */
async function branchesOf(ws: WorkspaceService, project: string, worktrees: readonly MoveWorktree[]): Promise<MoveBranch[]> {
  const cfg = await ws.projectConfig(project)
  const agents = projectAgents(cfg)
  const pending = (cfg.pendingBranchRenames ?? []).filter((r) => agents.some((a) => a.id === r.agentId))
  const later = (id: string): boolean => worktrees.some((w) => w.agentId === id && (w.how === 'missing' || w.how === 'unlink' || w.how === 'original'))
  const recreated = (id: string): boolean => worktrees.some((w) => w.agentId === id && w.how === 'recreate' && w.branchExists)
  const todo = agents.filter((a) => a.worktree?.branch && !later(a.id) && !pending.some((r) => r.agentId === a.id))
  if (!todo.length && !pending.length) return []
  const branches = await localBranches(project)
  const has = (b: string): boolean => branches.some((x) => x.toLowerCase() === b.toLowerCase())
  const place: BranchHome = { workspace: basename(ws.path ?? ''), project: basename(project), spaces: Array.isArray(cfg.branchSpaces) ? cfg.branchSpaces : [] }
  const home = { ...place, space: chooseSpace(place, branches).space }
  const remoteOf = async (b: string): Promise<string> => (await git(project, ['config', '--get', `branch.${b}.remote`])).out.trim()
  const out: MoveBranch[] = []
  for (const r of pending) {
    const a = agents.find((x) => x.id === r.agentId)!
    // Git's rename may be done already (its new name there, the old one gone): the rest is finished from there.
    const remote = await remoteOf(has(r.from) ? r.from : r.to)
    out.push({ agentId: a.id, agentName: a.name, from: r.from, to: r.to, pending: true, ...(remote ? { remote } : {}) })
  }
  for (const a of todo) {
    const from = a.worktree!.branch
    const to = branchHere(from, home)
    if (!to || (!has(from) && !recreated(a.id))) continue
    const remote = await remoteOf(from)
    out.push({ agentId: a.id, agentName: a.name, from, to, ...(remote ? { remote } : {}), ...(has(to) ? { kept: 'exists' as const } : {}) })
  }
  return out
}

/** A project's pending branch renames without the agent's (absent when none is left). */
const dropRename = (list: ProjectConfig['pendingBranchRenames'], agentId: string): ProjectConfig['pendingBranchRenames'] => {
  const rest = (list ?? []).filter((x) => x.agentId !== agentId)
  return rest.length ? rest : undefined
}

/**
 * Each card of the project whose work is on line `from` follows it to `to` (#1305): a LineRenamed fact, so its fold, its
 * view and its reconciliation read the branch by its new name, and never take it for gone. Once a card's line is `to`,
 * a second fact changes nothing (the fold only renames the line it names), so a Repair finishing a rename can write it
 * again harmlessly. A board without the fact log (waiting for its 1.0 upgrade) has no lines to follow.
 */
async function renameCardLines(ws: WorkspaceService, project: string, from: string, to: string): Promise<void> {
  const wf = await workflowFor(ws, project)
  if (!wf) return
  for (const card of wf.store.cards()) {
    if (wf.state(card).started?.line?.toLowerCase() !== from.toLowerCase()) continue
    await wf.write(card, null, 'hive', (w) => w.fact('LineRenamed', { from, to, why: 'repair' })) // i18n-ignore: a fact's kind and codes, not text
  }
}

type Move = PathMove & { of: string; owner?: MoveOwner }

/** A move's owner in English: what `of` keeps, for project.json's older readers and the Repair dialog's plan. */
function ownerLabel(o: MoveOwner): string {
  return o.kind === 'project' ? 'the project' : o.kind === 'assistant' ? 'the Assistant' : `${o.agent}'s worktree` // i18n-ignore: the English label kept in project.json beside the owner (pendingCopies), never shown translated
}

/** A move's owner and its English label, as a move records them (in project.json's pendingCopies too). Exported for tests. */
export const owned = (owner: MoveOwner): { of: string; owner: MoveOwner } => ({ of: ownerLabel(owner), owner })

/**
 * Whose a move is: its owner, or one recovered from the English label a record from before #796 keeps (agentWorktree.ts
 * writes those too). Null when the label is no owner's: the report then names it as it is. Exported for tests.
 */
export function moveOwner(m: { of?: string; owner?: MoveOwner }): MoveOwner | null {
  if (m.owner) return m.owner
  if (m.of === 'the project') return { kind: 'project' }
  if (m.of === 'the Assistant') return { kind: 'assistant' }
  const tree = /^(.+)'s worktree$/.exec(m.of ?? '')
  return tree ? { kind: 'worktree', agent: tree[1] } : null
}

const COPIED = msg({ id: 'main.move.copied', defaultMessage: "{n, plural, one {{owner, select, project {{host}: copied {n, number} file of {provider}'s conversations and memory for the project to its folder for the new path (the old folder is kept).} assistant {{host}: copied {n, number} file of {provider}'s conversations and memory for the Assistant to its folder for the new path (the old folder is kept).} worktree {{host}: copied {n, number} file of {provider}'s conversations and memory for {agent}'s worktree to its folder for the new path (the old folder is kept).} other {{host}: copied {n, number} file of {provider}'s conversations and memory for {of} to its folder for the new path (the old folder is kept).}}} other {{owner, select, project {{host}: copied {n, number} files of {provider}'s conversations and memory for the project to its folder for the new path (the old folder is kept).} assistant {{host}: copied {n, number} files of {provider}'s conversations and memory for the Assistant to its folder for the new path (the old folder is kept).} worktree {{host}: copied {n, number} files of {provider}'s conversations and memory for {agent}'s worktree to its folder for the new path (the old folder is kept).} other {{host}: copied {n, number} files of {provider}'s conversations and memory for {of} to its folder for the new path (the old folder is kept).}}}}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {n} is how many files; {provider} is the coding agent (Claude Code); {owner} whose folder the files are for: the project, the Assistant, an agent's worktree ({agent} is the agent), or other (a name kept from an older record, {of})." })
const COPY_KEPT = msg({ id: 'main.move.copyKept', defaultMessage: "{n, plural, one {{owner, select, project {{host}: {n, number} file of {provider}'s for the project already in {folder} with other content, not overwritten: {files}.} assistant {{host}: {n, number} file of {provider}'s for the Assistant already in {folder} with other content, not overwritten: {files}.} worktree {{host}: {n, number} file of {provider}'s for {agent}'s worktree already in {folder} with other content, not overwritten: {files}.} other {{host}: {n, number} file of {provider}'s for {of} already in {folder} with other content, not overwritten: {files}.}}} other {{owner, select, project {{host}: {n, number} files of {provider}'s for the project already in {folder} with other content, not overwritten: {files}.} assistant {{host}: {n, number} files of {provider}'s for the Assistant already in {folder} with other content, not overwritten: {files}.} worktree {{host}: {n, number} files of {provider}'s for {agent}'s worktree already in {folder} with other content, not overwritten: {files}.} other {{host}: {n, number} files of {provider}'s for {of} already in {folder} with other content, not overwritten: {files}.}}}}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {n} is how many files; {provider} is the coding agent (Claude Code); {owner} whose folder the files are for: the project, the Assistant, an agent's worktree ({agent} is the agent), or other (a name kept from an older record, {of}); {folder} is where they would go; {files} lists them." })
const COPY_FAILED = msg({ id: 'main.move.copyFailed', defaultMessage: "{n, plural, one {{owner, select, project {{host}: {n, number} file of {provider}'s for the project couldn't be copied to {folder}: {files}. Repair tries them again.} assistant {{host}: {n, number} file of {provider}'s for the Assistant couldn't be copied to {folder}: {files}. Repair tries them again.} worktree {{host}: {n, number} file of {provider}'s for {agent}'s worktree couldn't be copied to {folder}: {files}. Repair tries them again.} other {{host}: {n, number} file of {provider}'s for {of} couldn't be copied to {folder}: {files}. Repair tries them again.}}} other {{owner, select, project {{host}: {n, number} files of {provider}'s for the project couldn't be copied to {folder}: {files}. Repair tries them again.} assistant {{host}: {n, number} files of {provider}'s for the Assistant couldn't be copied to {folder}: {files}. Repair tries them again.} worktree {{host}: {n, number} files of {provider}'s for {agent}'s worktree couldn't be copied to {folder}: {files}. Repair tries them again.} other {{host}: {n, number} files of {provider}'s for {of} couldn't be copied to {folder}: {files}. Repair tries them again.}}}}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {n} is how many files; {provider} is the coding agent (Claude Code); {owner} whose folder the files are for: the project, the Assistant, an agent's worktree ({agent} is the agent), or other (a name kept from an older record, {of}); {folder} is where they would go; {files} lists them." })

/**
 * What Repair's report says of one CLI's copy for a moved folder, in the language shown when it is called (the owner
 * is data, whenever the move was recorded): lines done, skipped and failed. Exported for tests.
 */
export function copyReport(host: string, f: PathDataCopy, provider: string): { done: string[]; skipped: string[]; failed: string[] } {
  const o = moveOwner(f)
  const whose = { host, provider, owner: o?.kind ?? 'label', agent: o?.kind === 'worktree' ? o.agent : '', of: f.of ?? '' }
  return {
    done: f.copy ? [tr(COPIED, { ...whose, n: f.copy })] : [],
    skipped: f.kept.length ? [tr(COPY_KEPT, { ...whose, n: f.kept.length, folder: f.to, files: trimList(f.kept) })] : [],
    failed: f.failed?.length ? [tr(COPY_FAILED, { ...whose, n: f.failed.length, folder: f.to, files: trimList(f.failed) })] : []
  }
}

/**
 * The folder moves a host's paths follow, each saying whose: the host itself, each worktree found (or to be made) at a
 * new place, and the moves of earlier repairs whose data isn't all copied yet.
 */
function movesOf(host: Pick<Host, 'from' | 'folder' | 'assistant'>, worktrees: MoveWorktree[], pending: Move[] = []): Move[] {
  const out: Move[] = []
  const add = (m: Move): void => {
    if (!out.some((x) => samePath(x.from, m.from) && samePath(x.to, m.to))) out.push(m)
  }
  add({ from: host.from, to: host.folder, ...owned(host.assistant ? { kind: 'assistant' } : { kind: 'project' }) })
  for (const w of worktrees) if (w.to && !samePath(w.from, w.to)) add({ from: w.from, to: w.to, ...owned({ kind: 'worktree', agent: w.agentName }) })
  for (const m of pending) add(m)
  return out
}

/** A project's moves whose data copy is still to finish (project.json pendingCopies). */
const pendingOf = async (ws: WorkspaceService, host: string): Promise<Move[]> => (samePath(host, ws.assistantHome) ? [] : ((await ws.projectConfig(host)).pendingCopies ?? []))

/** A pending move done: its sessions rewritten and its data copied. */
async function donePending(ws: WorkspaceService, host: string, m: Move): Promise<void> {
  await ws.mutateProjectConfig(host, (cfg) => {
    const rest = (cfg.pendingCopies ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to)))
    return { pendingCopies: rest.length ? rest : undefined }
  })
}

/**
 * Finishes a project's pending moves outside Repair (a worktree recreated at a new place from Start): its sessions
 * rewritten, the CLIs' data copied, each move dropped once both worked. What doesn't work stays pending, and the
 * banner offers Repair….
 */
export async function finishPending(ws: WorkspaceService, host: string): Promise<void> {
  const pending = await pendingOf(ws, host)
  if (pending.length) {
    try {
      await sessionCwds(ws, host, pending, true)
      for (const m of pending) if (!(await copyFor(m, true)).some((f) => f.failed?.length)) await donePending(ws, host, m)
    } catch (e) {
      log.warn(`finishing ${userText(basename(host))}'s moved worktree`, e)
    }
  }
  ws.setMoved(movedSummary(await movePlan(ws)))
}

/** Adds a move whose data is still to be copied (kept until its copy works). */
const withPending = (list: Move[] | undefined, m: Move): Move[] => [...(list ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to))), m]

/** Session records whose folder moves, counted (apply: rewritten under the lock). */
async function sessionCwds(ws: WorkspaceService, host: string, moves: PathMove[], apply: boolean): Promise<number> {
  const rewrite = (list: { cwd?: string }[]): number => {
    let n = 0
    for (const s of list) {
      const next = s.cwd ? rebaseAny(s.cwd, moves) : null
      if (!next || !s.cwd || next === s.cwd) continue
      if (apply) s.cwd = next
      n++
    }
    return n
  }
  if (!apply) return rewrite(structuredClone((await ws.sessionsFile(host)).sessions))
  return ws.mutateSessions(host, (f) => rewrite(f.sessions))
}

/** What each CLI keeps by folder path for one moved folder. */
async function copyFor(m: Move, apply: boolean): Promise<PathDataCopy[]> {
  const out: PathDataCopy[] = []
  for (const p of allProviders()) {
    if (!p.copyPathData) continue
    const rs = await p.copyPathData(m.from, m.to, apply).catch((e): PathDataCopy[] => {
      log.warn(`copying ${p.id}'s data for ${userText(m.to)}`, e)
      return [{ provider: p.id, from: m.from, to: m.to, copy: 0, kept: [], failed: [String(e instanceof Error ? e.message : e)] }]
    })
    const owner = moveOwner(m)
    for (const r of rs) out.push({ ...r, of: m.of, ...(owner ? { owner } : {}) })
  }
  return out
}

/** What each CLI keeps by folder path for a host's moves. */
async function pathData(moves: Move[], apply: boolean): Promise<PathDataCopy[]> {
  const out: PathDataCopy[] = []
  for (const m of moves) out.push(...(await copyFor(m, apply)))
  return out
}

/** Agents running in the workspace (the Assistant too), as "project · agent". */
function runningIn(ws: WorkspaceService, folders: string[]): string[] {
  const mine = new Set([...folders, ws.assistantHome].map((p) => resolve(p).toLowerCase()))
  return sessions
    .liveStates()
    .filter((l) => mine.has(resolve(l.projectPath).toLowerCase()))
    .map((l) => (samePath(l.projectPath, ws.assistantHome) ? assistantName() : `${basename(l.projectPath)} · ${l.agentName ?? l.agentId}`))
}

/** The projects marked Working on in a workspace folder (config.json keeps them by the folder's path). */
function workingAt(folder: string): string[] {
  const all = config.get().activeProjects
  return Object.keys(all)
    .filter((k) => samePath(k, folder))
    .flatMap((k) => all[k] ?? [])
}

/**
 * Records saved before ids (#508: cards, lanes, watches) under a name no project has, their project renamed or moved
 * since, and whose they are now: a project moving now from that name (renamed in the workspace, or with it), else the one
 * whose agents worked on them (orphanNames). Records with an id are their project's by it, and never come here.
 */
async function cardMoves(ws: WorkspaceService, hosts: Host[], wsFrom: string | null): Promise<MoveCards[]> {
  const folders = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  const taken = [...folders.map((p) => basename(p)), ...(ws.config.hiddenProjects ?? []).map((h) => h.name)]
  const known = new Set(taken.map((n) => n.toLowerCase()))
  const cards = await legacyCards(ws)
  const lanes = await legacyLanes(ws)
  const watches = await legacyWatches(ws)
  const left = (r: { name: string }): boolean => !known.has(r.name.toLowerCase())
  if (![...cards, ...lanes, ...watches].some(left)) return []
  const projects: { name: string; agents: Set<string> }[] = []
  for (const p of folders) {
    if (!existsSync(join(p, PROJECT_FILE))) continue
    const agents = new Set(projectAgents(await ws.projectConfig(p)).map((a) => a.id))
    for (const s of (await ws.sessionsFile(p)).sessions) if (s.agentId) agents.add(s.agentId)
    projects.push({ name: basename(p), agents })
  }
  // Renamed in place, or moved with the workspace: not a project brought in from somewhere else under another name.
  const here = ws.path!
  const renamed = hosts.filter((h) => !h.assistant && !h.pendingOnly && (samePath(dirname(h.from), here) || (!!wsFrom && samePath(dirname(h.from), wsFrom)))).map((h) => ({ from: basename(h.from), to: h.name }))
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  return orphanNames([...cards, ...lanes, ...watches], taken, projects, renamed).map((m) => {
    const nLanes = lanes.filter((l) => same(l.name, m.from)).length
    const nWatches = watches.filter((w) => same(w.name, m.from)).length
    return { ...m, cards: cards.filter((c) => same(c.name, m.from)).map((c) => c.number), ...(nLanes ? { lanes: nLanes } : {}), ...(nWatches ? { watches: nWatches } : {}) }
  })
}

/** What Repair would do now; null when nothing moved. */
export async function movePlan(ws: WorkspaceService, opts: MoveOptions = {}): Promise<MovePlan | null> {
  if (!ws.path) return null
  const here = ws.path
  const { from, hosts } = await movedHosts(ws)
  const cards = await cardMoves(ws, hosts, from)
  const wsMove = { from: from ?? here, to: here }
  const planned: MoveHostPlan[] = []
  for (const h of hosts) {
    const worktrees = await worktreesOf(ws, h, wsMove, opts)
    const moves = movesOf(h, worktrees, await pendingOf(ws, h.path))
    const branches = h.assistant ? [] : await branchesOf(ws, h.path, worktrees)
    planned.push({ path: h.path, name: h.name, from: h.from, folder: h.folder, worktrees, sessions: await sessionCwds(ws, h.path, moves, false), folders: await pathData(moves, false), ...(branches.length ? { branches } : {}) })
  }
  // Branches still named after an old place in projects that didn't move (#1305): a move repaired before, or one made
  // outside Hive. Each such project is listed for its branches alone.
  for (const p of await projectFolders(ws)) {
    if (hosts.some((h) => samePath(h.path, p))) continue
    const branches = await branchesOf(ws, p, [])
    if (branches.length) planned.push({ path: p, name: basename(p), from: p, folder: p, worktrees: [], sessions: 0, folders: [], branches })
  }
  const renames = planned.reduce((n, h) => n + (h.branches ?? []).filter((b) => !b.kept).length, 0)
  if (!hosts.length && !from && !cards.length && !renames) return null
  return {
    from,
    to: here,
    projects: hosts.filter((h) => !h.assistant && !h.pendingOnly).map((h) => h.name),
    pending: hosts.filter((h) => h.pendingOnly).map((h) => h.name),
    running: runningIn(ws, await projectFolders(ws)),
    hosts: planned,
    recent: !!from && config.get().recentWorkspaces.some((p) => samePath(p, from)),
    working: from ? workingAt(from).filter((n) => !workingAt(here).includes(n)) : [],
    ...(cards.length ? { cards } : {}),
    ...(renames ? { branches: renames } : {})
  }
}

/** The plan's headline for the banner, or null when there's nothing to repair. */
export const movedSummary = (plan: MovePlan | null): WorkspaceMoved | null =>
  plan && moveHasWork(plan) ? { from: plan.from, projects: plan.projects, pending: plan.pending, ...(plan.cards?.length ? { cards: plan.cards } : {}), ...(plan.branches ? { branches: plan.branches } : {}) } : null

/**
 * On opening a workspace: records the folders of those opened for the first time, and works out whether anything
 * moved. A move with nothing to repair is simply recorded; otherwise the window's banner offers Repair….
 */
export async function checkMoved(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  await recordNew(ws, await projectFolders(ws))
  const plan = await movePlan(ws)
  if (ws.path !== path) return
  if (plan && !moveHasWork(plan)) await recordDone(ws, plan.hosts.map((h) => h.path), true)
  else if (plan) log.info(`Moved since last opened: ${plan.from ? `the workspace, from ${userText(plan.from)}` : `${plan.projects.length} project(s)`}`)
  ws.setMoved(movedSummary(plan))
}

/** Records the hosts' folders as where they are now, and the workspace's when all of them are (the Assistant's included). */
async function recordDone(ws: WorkspaceService, hosts: string[], all: boolean): Promise<void> {
  for (const h of hosts) if (!samePath(h, ws.assistantHome)) await ws.mutateProjectConfig(h, () => ({ lastPath: h }))
  if (all && ws.path && ws.config.lastPath !== ws.path) {
    ws.config.lastPath = ws.path
    await ws.saveWorkspaceConfig()
  }
}

const trimList = (list: string[], max = 5): string =>
  list.length > max
    ? fmt.list([...list.slice(0, max), tr(msg({ id: 'main.move.more', defaultMessage: '{n, plural, one {# more} other {# more}}', description: "The last item of a long list in Repair's report (after a workspace moved), after the first few: how many more there are (folders, files or names). Hive joins it to the list (\"A, B, C and 3 more\")." }), { n: list.length - max })])
    : fmt.list(list, 'unit')

/**
 * Repairs a moved workspace or project (the user's choices in opts): worktrees (git's links, then the agents' records),
 * session folders, the CLIs' per-path data (copied), the recent list. A project is recorded as repaired only when all
 * of its steps worked and none is left (a worktree not found stays listed until it is located or its link removed).
 */
export async function repairMove(ws: WorkspaceService, opts: MoveOptions = {}): Promise<MoveReport> {
  if (repairing.has(ws)) throw new Error(tr(msg({ id: 'main.move.already', defaultMessage: 'A repair is already running in this window.', description: 'An error: Repair (after a workspace moved) was asked for twice.' })))
  // No agent starts while it runs (sessions.ts checks the flag), and the running check comes after it is set.
  ws.repairingMove = true
  const run = repairNow(ws, opts)
  repairing.set(ws, run)
  try {
    return await run
  } finally {
    repairing.delete(ws)
    ws.repairingMove = false
  }
}
const repairing = new WeakMap<WorkspaceService, Promise<MoveReport>>()

/**
 * Gives the handovers and kept comparisons saved under a name a project had (#514) to that project: those under the
 * names this Repair recorded, and any a Repair before recorded but couldn't give (the record of names keeps them).
 */
async function adoptSaved(ws: WorkspaceService, report: MoveReport): Promise<void> {
  try {
    await adoptHandovers(ws)
    await adoptBenchmarkOwners(benchContext(ws))
  } catch (e) {
    report.failed.push(
      tr(msg({ id: 'main.move.adoptFailed', defaultMessage: "The handovers and kept comparisons saved under a project's earlier name couldn't all be given to it ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {why} is the system's message. Kept comparisons are benchmarks kept in Performance → Compare." }), { why: e instanceof Error ? e.message : String(e) })
    )
  }
}

async function repairNow(ws: WorkspaceService, opts: MoveOptions): Promise<MoveReport> {
  const report: MoveReport = { done: [], skipped: [], failed: [], complete: false }
  const plan = await movePlan(ws, opts)
  if (!plan || !moveHasWork(plan)) {
    // What a Repair before couldn't give its project (#514): tried again, and it isn't done until that is.
    await adoptSaved(ws, report)
    if (report.failed.length) return report
    if (plan) await recordDone(ws, plan.hosts.map((h) => h.path), true)
    ws.setMoved(null)
    report.skipped.push(tr(msg({ id: 'main.move.nothing', defaultMessage: 'Nothing to repair: everything already points to where the workspace is now.', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): there was nothing to do." })))
    report.complete = true
    return report
  }
  if (plan.running.length) throw new Error(tr(msg({ id: 'main.move.running', defaultMessage: 'Stop the running agents first: {agents}.', description: "Why Repair (after a workspace moved) can't start: agents are running. {agents} lists them (project · agent)." }), { agents: fmt.list(plan.running) }))
  log.info(`Repairing a move to ${userText(plan.to)}${plan.from ? ` from ${userText(plan.from)}` : ''}`)
  const repaired: string[] = []
  for (const h of plan.hosts) {
    const failedBefore = report.failed.length
    let open = false
    // Worktrees: git's links both ways, checked, then the agent's record.
    const fix = h.worktrees.filter((w) => w.to && (w.how === 'moved' || w.how === 'stayed' || w.how === 'located'))
    if (fix.length) {
      const r = await git(h.path, ['worktree', 'repair', ...fix.map((w) => w.to!)])
      const listed = await listWorktrees(h.path)
      for (const w of fix) {
        const ok = listed.some((l) => samePlace(l.path, w.to!)) && (await linked(h.path, w.to!))
        if (!ok) {
          report.failed.push(
            r.ok
              ? tr(msg({ id: 'main.move.notRepaired', defaultMessage: "{host}: {agent}'s worktree at {path} couldn't be repaired.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree." }), { host: h.name, agent: w.agentName, path: w.to! })
              : tr(msg({ id: 'main.move.notRepairedWhy', defaultMessage: "{host}: {agent}'s worktree at {path} couldn't be repaired ({why}).", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree, {why} git's message." }), { host: h.name, agent: w.agentName, path: w.to!, why: (r.err || tr(msg({ id: 'main.move.gitFailed', defaultMessage: '{command} failed', description: "Why git couldn't do something, when it said nothing itself. {command} is the git command: keep it." }), { command: 'git worktree repair' })).trim() }) // i18n-ignore: a git command's name
          )
          continue
        }
        // The new path, and the move its data follows until that is copied, in one locked change.
        const m = { from: w.from, to: w.to!, ...owned({ kind: 'worktree', agent: w.agentName }) }
        await ws.mutateProjectConfig(h.path, (cfg) => ({
          agents: projectAgents(cfg).map((a) => (a.id === w.agentId && a.worktree ? { ...a, worktree: { ...a.worktree, path: w.to! } } : a)),
          ...(samePath(w.from, w.to!) ? {} : { pendingCopies: withPending(cfg.pendingCopies, m) })
        }))
        report.done.push(
          samePath(w.from, w.to!)
            ? tr(msg({ id: 'main.move.relinked', defaultMessage: "{host}: {agent}'s worktree at {path} is linked to the project again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree." }), { host: h.name, agent: w.agentName, path: w.to! })
            : tr(msg({ id: 'main.move.movedTo', defaultMessage: "{host}: {agent}'s worktree is now at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where the worktree is now." }), { host: h.name, agent: w.agentName, path: w.to! })
        )
      }
    }
    // Worktrees to make again: after the repairs above, so git's prune can't drop a link they still needed.
    const remake = h.worktrees.filter((w) => w.how === 'recreate')
    for (const w of remake) {
      try {
        // Its new path and the move its sessions and data follow are written together (in recreateWorktree).
        const def = await recreateWorktree(h.path, w.agentId, { prefer: w.to ?? undefined, alsoRecreating: remake.map((x) => x.from) })
        const to = def.worktree!.path
        report.done.push(
          w.branchExists
            ? tr(msg({ id: 'main.move.recreated', defaultMessage: "{host}: {agent}'s worktree was recreated on its branch {branch}, at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {branch} is its branch, {path} the new worktree." }), { host: h.name, agent: w.agentName, branch: w.branch ?? '', path: to })
            : tr(msg({ id: 'main.move.madeNew', defaultMessage: "{host}: {agent}'s worktree was made new on {branch} (its branch was gone), at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {branch} is the new branch, {path} the new worktree." }), { host: h.name, agent: w.agentName, branch: w.branch ?? '', path: to })
        )
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        report.failed.push(
          w.branchExists
            ? tr(msg({ id: 'main.move.recreateFailed', defaultMessage: "{host}: {agent}'s worktree couldn't be recreated: {why}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {why} says why." }), { host: h.name, agent: w.agentName, why })
            : tr(msg({ id: 'main.move.makeNewFailed', defaultMessage: "{host}: {agent}'s worktree couldn't be made new: {why}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {why} says why." }), { host: h.name, agent: w.agentName, why })
        )
      }
    }
    for (const w of h.worktrees) {
      if (w.how === 'unlink') {
        await ws.mutateProjectConfig(h.path, (cfg) => ({ agents: projectAgents(cfg).map((a) => (a.id === w.agentId ? { ...a, worktree: undefined } : a)) }))
        report.done.push(tr(msg({ id: 'main.move.unlinked', defaultMessage: '{host}: {agent} no longer has a worktree (its folder {path} was left as it was).', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the old worktree." }), { host: h.name, agent: w.agentName, path: w.from }))
      } else if (w.how === 'missing') {
        open = true
        report.skipped.push(
          w.branchExists
            ? tr(msg({ id: 'main.move.missing', defaultMessage: "{host}: {agent}'s worktree wasn't found (it was at {path}). Recreate it on its branch, locate it, or remove the agent's worktree link.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where it was. Its branch is still there." }), { host: h.name, agent: w.agentName, path: w.from })
            : tr(msg({ id: 'main.move.missingNoBranch', defaultMessage: "{host}: {agent}'s worktree wasn't found (it was at {path}). Create a new worktree, locate it, or remove the agent's worktree link.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where it was. Its branch has gone too." }), { host: h.name, agent: w.agentName, path: w.from })
        )
      } else if (w.how === 'original') {
        report.skipped.push(tr(msg({ id: 'main.move.original', defaultMessage: "{host}: {agent}'s worktree at {path} stays linked to the project at {project}, which is still there.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree, {project} the project folder it was made from (a copy was moved, not that one)." }), { host: h.name, agent: w.agentName, path: w.from, project: h.from }))
      }
    }
    // Branches named after the old place (#1305): one operation a failure part way never leaves half done. The rename
    // is recorded first (pendingBranchRenames); then git's (it moves the branch's upstream and updates the worktree
    // that has it out); then each card whose work is on that line follows it (LineRenamed); then the agent's record,
    // the rename dropped from the list. Cut short anywhere, the next Repair finishes it from there (branchesOf).
    for (const b of h.branches ?? []) {
      if (b.kept) report.skipped.push(tr(msg({ id: 'main.move.branchTaken', defaultMessage: "{host}: {agent}'s branch {from} keeps its name: {to} is already a branch.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place isn't renamed, because a branch with its new name exists. {host} is the project; {agent} an agent; {from} and {to} are branch names." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to }))
    }
    const renames = (h.branches ?? []).filter((b) => !b.kept)
    // No reconciliation reads a line while it is renamed: runs under way finish first, and new ones wait (repairingMove).
    if (renames.length) await reconcilersIdle(ws)
    for (const b of renames) {
      const failed = (why: string): void => {
        report.failed.push(tr(msg({ id: 'main.move.branchFailed', defaultMessage: "{host}: {agent}'s branch {from} couldn't be renamed to {to} ({why}).", description: "A line of Repair's report, after a workspace or project moved to another folder. {host} is the project; {agent} an agent; {from} and {to} are branch names; {why} is git's or the system's message." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to, why }))
      }
      const whyOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      try {
        if (!b.pending) await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingBranchRenames: [...(cfg.pendingBranchRenames ?? []).filter((x) => x.agentId !== b.agentId), { agentId: b.agentId, from: b.from, to: b.to }] }))
      } catch (e) {
        failed(whyOf(e))
        continue
      }
      const branches = await localBranches(h.path)
      const has = (x: string): boolean => branches.some((y) => y.toLowerCase() === x.toLowerCase())
      if (has(b.from)) {
        if (has(b.to)) {
          failed(tr(msg({ id: 'main.move.branchBoth', defaultMessage: 'both names are branches', description: "Why Repair couldn't rename an agent's branch (in main.move.branchFailed's {why}): a branch with the new name appeared meanwhile." })))
          continue
        }
        const r = await git(h.path, ['branch', '-m', b.from, b.to])
        if (!r.ok) {
          failed((r.err || 'git branch -m').trim()) // i18n-ignore: a git command's name
          continue
        }
      } else if (!has(b.to)) {
        // Neither name is a branch any more (deleted meanwhile): nothing to rename, and nothing left to finish.
        await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingBranchRenames: dropRename(cfg.pendingBranchRenames, b.agentId) })).catch((e) => log.warn('dropping a branch rename', e))
        report.skipped.push(tr(msg({ id: 'main.move.branchGone', defaultMessage: "{host}: {agent}'s branch {from} is gone, so it isn't renamed.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch to rename no longer exists. {host} is the project; {agent} an agent; {from} a branch name." }), { host: h.name, agent: b.agentName, from: b.from }))
        continue
      }
      try {
        await renameCardLines(ws, h.path, b.from, b.to)
        const space = b.to.split('/')[1]
        await ws.mutateProjectConfig(h.path, (cfg) => ({
          agents: projectAgents(cfg).map((a) => (a.id === b.agentId && a.worktree && a.worktree.branch.toLowerCase() === b.from.toLowerCase() ? { ...a, worktree: { ...a.worktree, branch: b.to } } : a)),
          pendingBranchRenames: dropRename(cfg.pendingBranchRenames, b.agentId),
          // A workspace part this project's branches hadn't had is recorded, so it stays this project's (#703 round 3).
          ...(space && space.toLowerCase() !== refPart(basename(ws.path ?? ''), 'workspace').toLowerCase() && !(cfg.branchSpaces ?? []).some((s) => s.toLowerCase() === space.toLowerCase()) ? { branchSpaces: [...(cfg.branchSpaces ?? []), space] } : {})
        }))
      } catch (e) {
        report.failed.push(tr(msg({ id: 'main.move.branchUnrecorded', defaultMessage: "{host}: {agent}'s branch is now {to}, but Hive couldn't record it yet ({why}). Repair finishes it.", description: "A line of Repair's report, after a workspace or project moved to another folder: git renamed an agent's branch, and Hive's record of it (or of the cards on it) couldn't be written; the next Repair finishes it. {host} is the project; {agent} an agent; {to} the branch's new name; {why} the system's message." }), { host: h.name, agent: b.agentName, to: b.to, why: whyOf(e) }))
        continue
      }
      report.done.push(
        b.remote
          ? tr(msg({ id: 'main.move.branchRenamedRemote', defaultMessage: "{host}: {agent}'s branch {from} is now {to}; it still tracks {remote}'s {from}, so push it under the new name when you're ready.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place was renamed, and it tracks a remote, which keeps the old name. {host} is the project; {agent} an agent; {from} and {to} are branch names; {remote} the remote (origin)." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to, remote: b.remote })
          : tr(msg({ id: 'main.move.branchRenamed', defaultMessage: "{host}: {agent}'s branch {from} is now {to}.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place was renamed, with Hive's record of it. {host} is the project; {agent} an agent; {from} and {to} are branch names." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to })
      )
    }
    // Sessions and the CLIs' per-path data follow the project and the worktrees now at new places: those are kept in
    // project.json (pendingCopies) until their data is copied, so a copy that fails is tried again, after a restart too.
    const pending = await pendingOf(ws, h.path)
    const moves = movesOf({ ...h, assistant: samePath(h.path, ws.assistantHome) }, [], pending)
    // Session records that can't be written (#1061: in the workspace's database) leave the moves pending: the next Repair rewrites them.
    let sessionsOk = true
    try {
      const n = await sessionCwds(ws, h.path, moves, true)
      if (n) report.done.push(tr(msg({ id: 'main.move.sessions', defaultMessage: '{n, plural, one {{host}: # session now points to the new folder.} other {{host}: # sessions now point to the new folder.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {n} is how many sessions." }), { host: h.name, n }))
    } catch (e) {
      sessionsOk = false
      report.failed.push(tr(msg({ id: 'main.move.sessionsFailed', defaultMessage: "{host}: the sessions' folders couldn't be updated ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {why} is the system's message." }), { host: h.name, why: e instanceof Error ? e.message : String(e) }))
    }
    // Copied, never moved; the old folders stay.
    for (const m of moves) {
      const results = await copyFor(m, true)
      for (const f of results) {
        const who = allProviders().find((p) => p.id === f.provider)?.descriptor.name ?? f.provider
        const said = copyReport(h.name, f, who)
        report.done.push(...said.done)
        report.skipped.push(...said.skipped)
        report.failed.push(...said.failed)
      }
      if (sessionsOk && pending.some((x) => samePath(x.from, m.from) && samePath(x.to, m.to)) && !results.some((f) => f.failed?.length)) await donePending(ws, h.path, m)
    }
    if (report.failed.length === failedBefore && !open) repaired.push(h.path)
  }
  // Cards left under a project's old name go to the project now (#508); every card then names its project by id.
  // Its lanes and its agents' card watches saved before ids go with them.
  for (const m of plan.cards ?? []) {
    try {
      // First, in the record of names, that the project had that name (#514): what was saved under it (handovers, kept
      // comparisons) is then given to it, by this Repair or, if that fails, by the next (or when Hive next follows the
      // projects' names, after a restart too), once the cards that told it are moved.
      const id = ws.projectIdsNow().byPath.get(join(ws.path!, m.to).toLowerCase())
      if (id) await noteFormerName(ws, id, m.from)
      const n = m.cards.length ? await moveOrphanCards(ws, m) : 0
      if (n)
        report.done.push(
          tr(msg({ id: 'main.move.cards', defaultMessage: '{n, plural, one {# card of {from} now belongs to {to}, with its agents.} other {# cards of {from} now belong to {to}, with their agents.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): what was left under a project's old name went to the project. {from} is the old name, {to} the project. {n} is how many cards." }), { n, from: m.from, to: m.to })
        )
      const lanes = m.lanes ? await moveOrphanLanes(ws, m) : 0
      const watches = m.watches ? await moveOrphanWatches(ws, m) : 0
      const also = [
        ...(lanes ? [tr(msg({ id: 'main.move.lanes', defaultMessage: '{n, plural, one {# lane} other {# lanes}}', description: 'Card loops (lanes) that went to a project, in a list (main.move.alsoMoved). {n} is how many.' }), { n: lanes })] : []),
        ...(watches ? [tr(msg({ id: 'main.move.watches', defaultMessage: '{n, plural, one {# card watch} other {# card watches}}', description: "Agents' card watches that went to a project, in a list (main.move.alsoMoved). {n} is how many." }), { n: watches })] : [])
      ]
      if (also.length)
        report.done.push(
          tr(msg({ id: 'main.move.alsoMoved', defaultMessage: "{n, plural, one {{things} of {from} now is {to}'s.} other {{things} of {from} now are {to}'s.}}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): what was left under a project's old name went to the project. {from} is the old name, {to} the project. {things} lists the lanes and card watches (main.move.lanes, main.move.watches); {n} is how many in all." }), { things: fmt.list(also), from: m.from, to: m.to, n: lanes + watches })
        )
    } catch (e) {
      report.failed.push(tr(msg({ id: 'main.move.savedFailed', defaultMessage: "What was saved under {from} couldn't all be given to {to} ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {from} is a project's old name, {to} the project, {why} the system's message." }), { from: m.from, to: m.to, why: e instanceof Error ? e.message : String(e) }))
    }
  }
  if (plan.cards?.length) await stampCardProjects(ws).catch((e) => log.warn("giving the cards their projects' ids", e))
  await adoptSaved(ws, report)
  // A project renamed in place stays Working on under its new name.
  const renamedHere = plan.hosts.filter((h) => !samePath(h.path, ws.assistantHome) && samePath(dirname(h.from), plan.to) && basename(h.from).toLowerCase() !== h.name.toLowerCase())
  const marked = renamedHere.filter((h) => workingAt(plan.to).some((n) => n.toLowerCase() === basename(h.from).toLowerCase()))
  if (marked.length) {
    config.update((c) => {
      for (const k of Object.keys(c.activeProjects).filter((x) => samePath(x, plan.to))) {
        const list = c.activeProjects[k] ?? []
        c.activeProjects[k] = [...new Set(list.map((n) => marked.find((h) => basename(h.from).toLowerCase() === n.toLowerCase())?.name ?? n))]
      }
    })
    report.done.push(tr(msg({ id: 'main.move.workingRenamed', defaultMessage: '{n, plural, one {Working on: {projects}, as before its rename.} other {Working on: {projects}, as before their rename.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): renamed projects stay Working on. Working on is how the sidebar marks projects: use its name as shown. {projects} lists them; {n} is how many." }), { projects: trimList(marked.map((h) => h.name)), n: marked.length }))
  }
  if (plan.recent && plan.from) {
    const from = plan.from
    config.update((c) => {
      const rest = c.recentWorkspaces.filter((p) => !samePath(p, from))
      c.recentWorkspaces = rest.some((p) => samePath(p, plan.to)) ? rest : [plan.to, ...rest]
    })
    recentChanged()
    report.done.push(tr(msg({ id: 'main.move.recent', defaultMessage: 'Open Recent lists {to} instead of {from}.', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). Open Recent is a menu (File → Open Recent): use its name as shown. {to} is the workspace folder now, {from} where it was." }), { to: plan.to, from }))
  }
  if (plan.working.length) {
    config.update((c) => {
      c.activeProjects[plan.to] = [...new Set([...(c.activeProjects[plan.to] ?? []), ...plan.working])]
    })
    report.done.push(tr(msg({ id: 'main.move.workingMoved', defaultMessage: 'Working on: {projects}, as before the move.', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): the projects stay Working on. Working on is how the sidebar marks projects: use its name as shown. {projects} lists them." }), { projects: trimList(plan.working) }))
  }
  await recordDone(ws, repaired, repaired.length === plan.hosts.length)
  const after = await movePlan(ws)
  report.complete = report.failed.length === 0 && (!after || !moveHasWork(after))
  if (report.complete && after) await recordDone(ws, after.hosts.map((h) => h.path), true)
  ws.setMoved(report.complete ? null : movedSummary(after))
  for (const line of report.done) log.info(`Repair: ${userText(line)}`)
  for (const line of report.skipped) log.info(`Repair skipped: ${userText(line)}`)
  for (const line of report.failed) log.warn(`Repair failed: ${userText(line)}`)
  return report
}
