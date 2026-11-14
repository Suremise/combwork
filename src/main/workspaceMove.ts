import { existsSync } from 'original-fs'
import { mkdir } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { MoveBranch, MoveCards, MoveHostPlan, MoveOptions, MoveOwner, MovePlan, MoveReport, MoveReportRow, MoveWorktree, PathDataCopy, ProfileMove, ProjectConfig, WorkspaceMoved } from '../shared/types'
import { CW_DIR, projectAgents } from '../shared/defaults'
import { fmt, msg, tr } from '../shared/i18n'
import { moveHasWork, rebaseAny, samePath, worktreeCandidates, type PathMove } from '../shared/movePaths'
import { moveCardFolders, PruneBlocked, recreateWorktree } from './agentWorktree'
import { legacyWorktree, slotsMigrated } from './agentFolders'
import { projectFolders as foldersOf, recreateSlot, relocateFolder, releaseSlotLease, type ProjectFolder } from './projectFolders'
import { folderWhat } from '../shared/projectFolders'
import { config } from './config'
import { placeKey, samePlace } from './fsutil'
import { createLogger, userText } from './logger'
import { allProviders } from './providers'
import { recentChanged } from './recentWorkspaces'
import { sessions } from './sessions'
import { workspaceFor, type WorkspaceService } from './workspace'
import { slotRelocation, slotWorkspaces } from './platform/workspacePorts'
import type { Relocation } from './platform/workspacePort'
import type { SlotRenamer } from './slots'
import { workflowFor } from './workflow/service'
import { reconcilersIdle } from './workflow/reconciler'
import { moveExclusions } from './antivirus'
import { branchHere, chooseSpace, refPart, type BranchHome } from '../shared/agentBranches'
import { orphanNames } from '../shared/projectIds'
import { shortPath } from '../shared/shortPath'
import { legacyCards, moveOrphanCards, stampCardProjects } from './tasks'
import { legacyLanes, moveOrphanLanes } from './lanes'
import { legacyWatches, moveOrphanWatches } from './watches'
import { adoptHandovers } from './notes'
import { noteFormerName } from './projectNames'
import { adoptBenchmarkOwners, benchContext } from './benchmarks'
import { carryPin, pinKeptAt } from './pin'
import { carryProjectViewPrefs, carryViewPrefs, viewPrefsKeptAt } from './viewPrefs'
import { carryWorkspaceRuns } from './closeCommand/closeCommands'
import { emitTo } from './events'

/**
 * A workspace (or project) moved to another folder (#146). Combwork records where each was last opened (`lastPath` in
 * workspace.json and project.json); when that differs, what is stored by absolute path is out of date: agents'
 * worktrees (and git's links both ways), session folders, Claude Code's per-path transcripts and memory, the recent
 * list. The plan says what Repair would do; repair does it, refusing while agents run. Every step can run again
 * harmlessly, and nothing at the old location is ever deleted.
 */

const log = createLogger('move')

const assistantName = (): string => tr(msg({ id: 'main.move.assistant', defaultMessage: 'Assistant', description: "The Combwork Assistant's name, where Repair (after a workspace moved) lists what it repairs and the agents still running." }))
const PROJECT_FILE = join(CW_DIR, 'project.json')

/** Whether p is inside root (or is it). */

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

/**
 * Repair's steps on the store's workspaces (HI-2792: the relocation capability of the platform slots are made with, Git's
 * worktrees in 1.4.0; §16.3.6's gate: relocation). Each its git command or file read as before (platform/gitRelocation.ts).
 */
function relocation(): Relocation {
  const r = slotRelocation()
  if (!r) throw new Error('No relocation for this platform') // i18n-ignore: an internal error, for the log (no platform without it has workspaces in 1.4.0)
  return r
}

/** Whether a folder is one of the store's linked workspaces (Git: a worktree's .git file, not a folder). */
const isWorktreeFolder = (p: string): Promise<boolean> => relocation().isWorkspaceFolder(p)

/** Whether the store's links between a repository and one of its worktrees are right both ways (by real paths: git writes the long names, #389). */
const linked = (repo: string, wt: string): Promise<boolean> => relocation().linked(repo, wt)

/** Records where the workspace and its projects are, for those that have no record yet (opened before #146). */
async function recordNew(ws: WorkspaceService, projects: string[]): Promise<void> {
  const here = ws.path
  if (!ws.config.lastPath && here) {
    // Worked out from the settings as saved (HI-2651), never set on them before.
    await ws.saveWorkspaceConfigWith((c) => (c.lastPath ? {} : { lastPath: here }))
  }
  for (const p of projects) if (!(await ws.projectConfig(p)).lastPath) await ws.mutateProjectConfig(p, (c) => (c.lastPath ? {} : { lastPath: p }))
}

/** The workspace's project folders that have Combwork's files (hidden ones too). */
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

/**
 * Where each worktree of a moved project is now, or why it can't be repaired: its agents' 0.9 worktrees (only agents
 * the slots' migration hasn't taken over, #1441), then its slots, copies and retired homes (#1447, projectFolders.ts).
 */
async function worktreesOf(ws: WorkspaceService, host: Host, wsMove: PathMove, opts: MoveOptions): Promise<MoveWorktree[]> {
  if (host.assistant) return []
  const out: MoveWorktree[] = []
  const projectMove = { from: host.from, to: host.folder }
  const copied = existsSync(host.from)
  for (const a of projectAgents(await ws.projectConfig(host.path))) {
    const legacy = legacyWorktree(a)
    if (!legacy || (await slotsMigrated(host.path, a.id))) continue
    const key = `${host.path}#${a.id}`
    const base = { agentId: a.id, agentName: a.name, from: legacy.path }
    if (opts.unlink?.includes(key)) {
      out.push({ ...base, to: null, how: 'unlink' })
      continue
    }
    const picked = opts.locate?.[key]
    if (picked && (await isWorktreeFolder(picked))) {
      if (!(await linked(host.path, picked)) || !samePlace(picked, legacy.path)) out.push({ ...base, to: resolve(picked), how: 'located' })
      continue
    }
    // Already right (repaired before, or a worktree the move didn't touch).
    if (await linked(host.path, legacy.path)) continue
    const candidates = worktreeCandidates(legacy.path, wsMove, projectMove)
    let found: string | null = null
    for (const c of candidates) {
      if (await isWorktreeFolder(c)) {
        found = c
        break
      }
    }
    if (!found) {
      // Its branch lives in the repository: Recreate makes the worktree again on it (where it would have moved to).
      const branch = { branch: legacy.branch, branchExists: await slotWorkspaces().lineExists(host.path, legacy.branch) }
      out.push(opts.recreate?.includes(key) ? { ...base, ...branch, to: candidates[0], how: 'recreate' } : { ...base, ...branch, to: null, how: 'missing' })
    }
    // Still at its old place while the project is at its old folder too: a copy, and the original keeps its worktree.
    else if (samePath(found, legacy.path) && copied) out.push({ ...base, to: null, how: 'original' })
    else out.push({ ...base, to: found, how: samePath(found, legacy.path) ? 'stayed' : 'moved' })
  }
  for (const f of await foldersOf(ws, host.path)) out.push(...(await folderOf(host, f, wsMove, projectMove, copied, opts)))
  return out
}

/**
 * Where one of a project's slots, copies or retired homes is now (#1447), as its agent's worktree is found: linked
 * already (nothing), Locate…'s choice, then its candidates. Not found: a leased slot is Recreate's (on its line) or
 * Release's (`unlink`), a free slot or a copy is made again where it belongs at its next lease (`later`), and a home is
 * Locate's or Forget's (`unlink`). Copies have no Locate.
 */
async function folderOf(host: Host, f: ProjectFolder, wsMove: PathMove, projectMove: PathMove, copied: boolean, opts: MoveOptions): Promise<MoveWorktree[]> {
  const key = `${host.path}#${f.key}`
  const base = { agentId: f.key, agentName: f.name, from: f.folder, of: f.of }
  const choosable = f.of.kind === 'home' || !!f.lease
  if (choosable && opts.unlink?.includes(key)) return [{ ...base, to: null, how: 'unlink' }]
  const picked = f.of.kind === 'copy' ? undefined : opts.locate?.[key]
  if (picked && (await isWorktreeFolder(picked))) return !(await linked(host.path, picked)) || !samePath(picked, f.folder) ? [{ ...base, to: resolve(picked), how: 'located' }] : []
  if (await linked(host.path, f.folder)) return []
  const candidates = worktreeCandidates(f.folder, wsMove, projectMove)
  let found: string | null = null
  for (const c of candidates) {
    if (await isWorktreeFolder(c)) {
      found = c
      break
    }
  }
  if (found) {
    if (samePath(found, f.folder) && copied) return [{ ...base, to: null, how: 'original' }]
    return [{ ...base, to: found, how: samePath(found, f.folder) ? 'stayed' : 'moved' }]
  }
  if (f.of.kind === 'slot' && f.lease) {
    const branch = { branch: f.line ?? '', branchExists: !!f.line && (await slotWorkspaces().lineExists(host.path, f.line)) }
    return [opts.recreate?.includes(key) && branch.branchExists ? { ...base, ...branch, to: candidates[0], how: 'recreate' } : { ...base, ...branch, to: null, how: 'missing' }]
  }
  if (f.of.kind === 'home') return [{ ...base, to: null, how: 'missing' }]
  return [{ ...base, to: candidates[0] ?? f.folder, how: 'later' }]
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
  const later = (id: string): boolean => worktrees.some((w) => !w.of && w.agentId === id && (w.how === 'missing' || w.how === 'unlink' || w.how === 'original'))
  const recreated = (id: string): boolean => worktrees.some((w) => w.agentId === id && w.how === 'recreate' && w.branchExists)
  const todo = agents.filter((a) => legacyWorktree(a)?.branch && !later(a.id) && !pending.some((r) => r.agentId === a.id))
  if (!todo.length && !pending.length) return []
  const branches = await relocation().localLines(project)
  const has = (b: string): boolean => branches.some((x) => x.toLowerCase() === b.toLowerCase())
  const place: BranchHome = { workspace: basename(ws.path ?? ''), project: basename(project), spaces: Array.isArray(cfg.branchSpaces) ? cfg.branchSpaces : [] }
  const home = { ...place, space: chooseSpace(place, branches).space }
  const remoteOf = (b: string): Promise<string> => relocation().lineRemote(project, b)
  const out: MoveBranch[] = []
  for (const r of pending) {
    const a = agents.find((x) => x.id === r.agentId)!
    // Git's rename may be done already (its new name there, the old one gone): the rest is finished from there.
    const remote = await remoteOf(has(r.from) ? r.from : r.to)
    out.push({ agentId: a.id, agentName: a.name, from: r.from, to: r.to, pending: true, ...(remote ? { remote } : {}) })
  }
  for (const a of todo) {
    const from = legacyWorktree(a)!.branch
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
  const on = (line: string | null | undefined): boolean => line?.toLowerCase() === from.toLowerCase()
  for (const card of wf.store.cards()) {
    if (!on(wf.state(card).started?.line)) continue
    // Checked again under the write's lock: a card another observer has already renamed gets no second fact.
    await wf.write(card, null, 'combwork', (w) => {
      if (on(w.state().started?.line)) w.fact('LineRenamed', { from, to, why: 'repair' }) // i18n-ignore: a fact's kind and codes, not text
    })
  }
}

/**
 * Whether an action queued for one of the project's cards still names line `from` (#1305): `prepareSlot`, which makes a
 * slot's folder on a card's line (P7). Never an agent's own branch today (an agent's worktree is its card's existing
 * folder, and isn't prepared), but a rename under one would make the slot on the old name, so the rename waits for it.
 */
async function queuedOn(ws: WorkspaceService, project: string, from: string): Promise<boolean> {
  const wf = await workflowFor(ws, project)
  return !!wf && wf.store.pendingActions().some((a) => a.kind === 'prepareSlot' && String(a.payload.line ?? '').toLowerCase() === from.toLowerCase())
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

/** Repair's report as a table (#1313): each step's result in a few words, its Result column; the full line says the rest. */
const R = {
  linked: msg({ id: 'main.move.result.linked', defaultMessage: 'linked again', description: "Repair's report, the Result column: an agent's worktree is linked to the moved project again (git worktree repair)." }),
  notRepaired: msg({ id: 'main.move.result.notRepaired', defaultMessage: "couldn't be repaired{hasWhy, select, yes {: {why}} other {}}", description: "Repair's report, the Result column: an agent's worktree couldn't be linked again; {why} is git's message." }),
  recreated: msg({ id: 'main.move.result.recreated', defaultMessage: '{made, select, new {made new (its branch was gone)} other {recreated on its branch}}', description: "Repair's report, the Result column: an agent's worktree made again on its branch, or new when its branch was gone. The branch's name is in the agent's branch row (Repair may rename it in the same run)." }),
  pruneBlocked: msg({ id: 'main.move.result.pruneBlocked', defaultMessage: "couldn't be recreated while {n, plural, one {another worktree is missing too ({worktrees}): locate, recreate or remove it first} other {# other worktrees are missing too ({worktrees}): locate, recreate or remove them first}}", description: "Repair's report, the Result column: a missing worktree can't be made again yet, because git's clean-up would also forget other missing worktrees. {worktrees} lists them (an agent's worktree, main.move.result.agentWorktree, or a folder's name); {n}: how many. The row's tooltip says it in full." }),
  agentWorktree: msg({ id: 'main.move.result.agentWorktree', defaultMessage: "{agent}'s worktree", description: "Repair's report: an agent's worktree ({agent}: its name), in a list of worktrees in the way (main.move.result.pruneBlocked's {worktrees})." }),
  recreateFailed: msg({ id: 'main.move.result.recreateFailed', defaultMessage: "{made, select, new {couldn't be made new: {why}} other {couldn't be recreated: {why}}}", description: "Repair's report, the Result column: an agent's worktree couldn't be made again ({why}: the reason)." }),
  unlinked: msg({ id: 'main.move.result.unlinked', defaultMessage: 'link removed; its folder was left as it was', description: "Repair's report, the Result column: the agent no longer has a worktree; the folder, if any, is untouched." }),
  missing: msg({ id: 'main.move.result.missing', defaultMessage: '{gone, select, yes {not found, its branch gone too: create, locate or remove its link} other {not found: recreate, locate or remove its link}}', description: "Repair's report, the Result column: an agent's worktree wasn't found; Repair waits for the user's choice (Repair's buttons)." }),
  original: msg({ id: 'main.move.result.original', defaultMessage: 'stays linked to the project at its old folder', description: "Repair's report, the Result column: a worktree stays with the project folder it was made from, which is still there (a copy was moved)." }),
  renamed: msg({ id: 'main.move.result.renamed', defaultMessage: "{remote, select, none {renamed} other {renamed; it still tracks {remote}'s old name}}", description: "Repair's report, the Result column: an agent's branch was renamed; {remote} is the remote it tracks (origin), which keeps the old name, or none." }),
  taken: msg({ id: 'main.move.result.taken', defaultMessage: 'kept: the new name is a branch already', description: "Repair's report, the Result column: an agent's branch isn't renamed, because a branch with the new name exists." }),
  renameFailed: msg({ id: 'main.move.result.renameFailed', defaultMessage: "couldn't be renamed: {why}", description: "Repair's report, the Result column: an agent's branch couldn't be renamed ({why}: git's or the system's message)." }),
  gone: msg({ id: 'main.move.result.gone', defaultMessage: "gone, so it isn't renamed", description: "Repair's report, the Result column: an agent's branch to rename no longer exists." }),
  unrecorded: msg({ id: 'main.move.result.unrecorded', defaultMessage: "renamed, but not recorded yet ({why}): Repair finishes it", description: "Repair's report, the Result column: git renamed an agent's branch, but Combwork couldn't record it yet ({why}: the system's message)." }),
  sessions: msg({ id: 'main.move.result.sessions', defaultMessage: '{n, plural, one {# session points here now} other {# sessions point here now}}', description: "Repair's report, the Result column: session records pointed to the new folder ({n}: how many)." }),
  failedWhy: msg({ id: 'main.move.result.failed', defaultMessage: "couldn't be updated: {why}", description: "Repair's report, the Result column: a step failed ({why}: the system's message); the next Repair tries again." }),
  copied: msg({ id: 'main.move.result.copied', defaultMessage: '{n, plural, one {# file copied} other {# files copied}}', description: "Repair's report, the Result column: a coding agent's conversation and memory files copied to the new folder ({n}: how many)." }),
  copyKept: msg({ id: 'main.move.result.copyKept', defaultMessage: "{n, plural, one {# file already there with other content, kept} other {# files already there with other content, kept}}", description: "Repair's report, the Result column: a coding agent's files already in the new folder with other content, never overwritten (the row's tooltip lists them)." }),
  copyFailed: msg({ id: 'main.move.result.copyFailed', defaultMessage: "{n, plural, one {# file couldn't be copied} other {# files couldn't be copied}}", description: "Repair's report, the Result column: a coding agent's files that couldn't be copied (the row's tooltip lists them); Repair tries them again." }),
  given: msg({ id: 'main.move.result.given', defaultMessage: 'given to {to}: {what}', description: "Repair's report, the Result column of a board row: what was saved under a project's old name went to the project ({to}); {what} lists it (\"9 cards, 1 lane\")." }),
  cards: msg({ id: 'main.move.result.cards', defaultMessage: '{n, plural, one {# card, with its agents} other {# cards, with their agents}}', description: "Repair's report: cards that went to a project, in a list (main.move.result.given's {what}). {n} is how many." }),
  notGiven: msg({ id: 'main.move.result.notGiven', defaultMessage: "couldn't all be given to {to}: {why}", description: "Repair's report, the Result column: what was saved under an old name couldn't all go to its project ({to}: the project, or none known; {why}: the system's message). Repair tries again." }),
  working: msg({ id: 'main.move.result.working', defaultMessage: 'marked again: {projects}', description: "Repair's report, the Result column of Working on: the projects ({projects}) are marked Working on again." }),
  recent: msg({ id: 'main.move.result.recent', defaultMessage: 'lists the new folder', description: "Repair's report, the Result column of Open Recent: the new folder replaces the old one." }),
  released: msg({ id: 'main.move.result.released', defaultMessage: 'released; made again when next lent', description: "Repair's report, the Result column: a lent slot whose folder was gone was released, and is made again at its next use (#1447)." }),
  later: msg({ id: 'main.move.result.later', defaultMessage: 'made again here when next used', description: "Repair's report, the Result column: a free slot or review copy wasn't found, and is made again at its new place when next used (#1447)." }),
  forgotten: msg({ id: 'main.move.result.forgotten', defaultMessage: 'no longer kept', description: "Repair's report, the Result column: an old reviewer folder that wasn't found is forgotten (#1447)." }),
  folderMissing: msg({ id: 'main.move.result.folderMissing', defaultMessage: "{kind, select, home {not found: locate or forget it} other {{gone, select, yes {not found, its branch gone too: locate or release it} other {not found: recreate, locate or release it}}}}", description: "Repair's report, the Result column: a lent slot or an old reviewer folder ({kind}: slot or home) wasn't found; Repair waits for the user's choice (#1447)." })
}

/** Repair's lines about a project's slots, copies and retired homes (#1447): {what} is folderWhat's name for it. */
const F = {
  relinked: msg({ id: 'main.move.folder.relinked', defaultMessage: '{host}: {what} at {path} is linked to the project again.', description: "A line of Repair's report, after a workspace or project moved: one of the project's slots, review copies or old reviewer folders ({what}: its name, such as \"slot-b (HI-B1, AM-12)\") is linked to the project again. {host} is the project, {path} the folder." }),
  movedTo: msg({ id: 'main.move.folder.movedTo', defaultMessage: '{host}: {what} is now at {path}.', description: "A line of Repair's report, after a workspace or project moved: one of the project's slots, copies or old reviewer folders ({what}: its name) is now at {path}. {host} is the project." }),
  failed: msg({ id: 'main.move.folder.failed', defaultMessage: "{host}: {what} at {path} couldn't be recorded ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved: one of the project's slots, copies or old reviewer folders ({what}: its name) was found at {path}, but Combwork's record of it couldn't be updated ({why}). {host} is the project." }),
  busy: msg({ id: 'main.move.folder.busy', defaultMessage: 'Combwork is using it now', description: "Why Repair couldn't update its record of a slot or copy (in main.move.folder.failed's {why}): one of Combwork's own steps (setting it up, removing it) holds it now. A clause." }),
  recreated: msg({ id: 'main.move.folder.recreated', defaultMessage: '{host}: {what} was made again on {branch}, at {path}.', description: "A line of Repair's report: a slot lent to an agent, whose folder was gone, was made again on its branch ({branch}) at {path}; the agent keeps it. {what} is its name, {host} the project." }),
  recreateFailed: msg({ id: 'main.move.folder.recreateFailed', defaultMessage: "{host}: {what} couldn't be made again: {why}", description: "A line of Repair's report: a lent slot whose folder was gone couldn't be made again ({why}: the reason, often in English from git). {what} is its name, {host} the project." }),
  released: msg({ id: 'main.move.folder.released', defaultMessage: "{host}: {what} was released; it's made again where it belongs when it is next lent.", description: "A line of Repair's report: a lent slot whose folder was gone was released (its agent no longer has it); Combwork makes it again at its next use. {what} is its name, {host} the project." }),
  later: msg({ id: 'main.move.folder.later', defaultMessage: "{host}: {what} wasn't found; it's made again at {path} when it is next used.", description: "A line of Repair's report: a free slot or a review copy ({what}: its name) whose folder wasn't found; Combwork makes it again at {path} the next time it lends it. {host} is the project." }),
  forgotten: msg({ id: 'main.move.folder.forgotten', defaultMessage: "{host}: {what} is no longer kept (it was at {path}); its conversations can't be resumed there.", description: "A line of Repair's report: an old reviewer folder ({what}) that wasn't found is forgotten, as the user chose; the conversations that ran there can be read, not resumed there. {host} is the project, {path} where it was." }),
  slotMissing: msg({ id: 'main.move.folder.slotMissing', defaultMessage: "{hasBranch, select, yes {{host}: {what} wasn't found (it was at {path}). Recreate it on {branch}, locate it, or release it.} other {{host}: {what} wasn't found (it was at {path}), and its branch is gone too. Locate it, or release it.}}", description: "A line of Repair's report: a lent slot ({what}: its name) wasn't found; Repair waits for the user's choice: make it again on its branch ({branch}), pick its folder, or release it. {host} is the project, {path} where it was." }),
  homeMissing: msg({ id: 'main.move.folder.homeMissing', defaultMessage: "{host}: {what} wasn't found (it was at {path}). Locate it, or forget it.", description: "A line of Repair's report: an old reviewer folder ({what}), where its conversations resume, wasn't found; Repair waits for the user's choice. {host} is the project, {path} where it was." }),
  original: msg({ id: 'main.move.folder.original', defaultMessage: '{host}: {what} at {path} stays linked to the project at {project}, which is still there.', description: "A line of Repair's report: one of the project's slots, copies or old reviewer folders ({what}) stays with the project folder it was made from ({project}), which is still there (a copy was moved). {host} is the project, {path} the folder." })
}

/**
 * The worktrees git's prune would forget (a recreate's refusal, `PruneBlocked`), as Repair's report names them: an
 * agent's by its name, any other (made outside Combwork, or whose agent is gone) by its folder's name. Exported for tests.
 */
export function blockerNames(blockers: readonly string[], worktrees: readonly Pick<MoveWorktree, 'agentName' | 'from' | 'to'>[]): string[] {
  return blockers.map((p) => {
    const w = worktrees.find((x) => samePath(x.from, p) || (!!x.to && samePath(x.to, p)))
    return w ? tr(R.agentWorktree, { agent: w.agentName }) : shortPath(p)
  })
}

/** One step of Repair's report: its line in done, skipped or failed, and its row in the dialog's table (#1313). */
function say(report: MoveReport, outcome: MoveReportRow['outcome'], line: string, row: Omit<MoveReportRow, 'outcome' | 'line'>): void {
  report[outcome].push(line)
  report.rows.push({ ...row, outcome, line })
}

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
  // A copy's sessions (none: reviewers run in the project folder) and a folder made again later (`later`) have nothing to follow.
  for (const w of worktrees) if (w.to && !samePath(w.from, w.to) && w.how !== 'later' && w.of?.kind !== 'copy') add({ from: w.from, to: w.to, ...owned({ kind: 'worktree', agent: w.agentName }) })
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

/**
 * A worktree's identity (#1441): its git administrative folder, as its `.git` file names it. Git's `worktree move` keeps
 * it, so it tells one worktree from another that comes to the same path. Null when the folder isn't a linked worktree.
 */
export function worktreeIdentity(folder: string): Promise<string | null> {
  return relocation().identity(folder)
}

/**
 * A worktree's rename with Repair's own helpers (#1441, the slot pool's `SlotRenamer`: an adopted worktree given a
 * generic name once nothing holds it). Each step stands alone so the pool's operation can resume from where git lists
 * the worktree after a crash, each a no-op where it was done, and each acts only on the worktree with the rename's
 * identity: another worktree that comes to the destination is never followed, moved or put back. Repair's own flow is
 * unchanged. `hooks.beforeGitMove`: for tests, right before git's move (after the destination was found absent).
 */
export function worktreeRenamer(ws: WorkspaceService, projectPath: string, hooks: { beforeGitMove?: (from: string, to: string) => Promise<void> } = {}): SlotRenamer {
  /** Where git lists the worktree with this identity (any path), or null when git can't say or doesn't list it. */
  const locate = async (tree: string): Promise<string | null> => {
    const listed = await slotWorkspaces().list(projectPath).catch(() => null)
    for (const w of listed ?? []) if ((await worktreeIdentity(w.path)) === tree) return w.path
    return null
  }
  const where = async (from: string, to: string, tree: string): Promise<'from' | 'to' | 'elsewhere' | null> => {
    const at = await locate(tree)
    return !at ? null : samePlace(at, to) ? 'to' : samePlace(at, from) ? 'from' : 'elsewhere'
  }
  /** Sessions and cards put back from `to` to `from`, only while no other worktree is at `to` (theirs are its). */
  const unfollow = async (from: string, to: string, tree: string): Promise<void> => {
    const there = existsSync(to) ? await worktreeIdentity(to) : null
    if (there && there !== tree) return
    await sessionCwds(ws, projectPath, [{ from: to, to: from }], true)
    await moveCardFolders(projectPath, to, from)
  }
  return {
    identity: worktreeIdentity,
    unmovable: async (folder) => (await relocation().unmovable?.(folder)) ?? null,
    where,
    // Each CLI's per-folder data (its conversations and memory) copied for the new path, checked first: every provider's
    // copy applied with no failure, or no rename. The old data is never touched.
    copy: async (from, to, who) => {
      const m: Move = { from, to, ...owned({ kind: 'worktree', agent: who }) }
      const failed = (list: PathDataCopy[]): string[] => list.filter((f) => f.failed?.length).map((f) => `${f.provider}: ${f.failed!.join(', ')}`)
      const dry = failed(await copyFor(m, false))
      if (dry.length) return log.info(`${userText(from)} can't be renamed: ${userText(dry.join('; '))}`), false
      const applied = failed(await copyFor(m, true))
      if (applied.length) return log.warn(`${userText(from)} can't be renamed, its conversations' data didn't follow: ${userText(applied.join('; '))}`), false
      return true
    },
    // Git's move, refused when anything is at `to` (git would move it inside), its parent made first; then checked by
    // identity: this worktree must be at exactly `to`. Anywhere else (inside another that came there meanwhile), it is
    // moved back to `from`; the other is left as it is.
    move: async (from, to, tree) => {
      if (existsSync(to)) return log.info(`${userText(from)} not renamed: ${userText(to)} is already there`), false
      await mkdir(dirname(to), { recursive: true })
      await hooks.beforeGitMove?.(from, to)
      const moved = await relocation().move(projectPath, from, to)
      if (!moved.ok) return log.info(`${userText(from)} not renamed: ${userText((moved.err || '').trim())}`), false
      const at = await locate(tree)
      if (at && samePlace(at, to)) return true
      log.warn(`${userText(from)} moved, but not to ${userText(to)} (${userText(at ?? 'not listed')}): moving it back`)
      if (at && !samePlace(at, from)) {
        const back = await relocation().move(projectPath, at, from)
        if (!back.ok) log.warn(`${userText(at)} couldn't be moved back to ${userText(from)}: ${userText(back.err)}`)
      }
      return false
    },
    follow: async (from, to, tree) => {
      if ((await where(from, to, tree)) !== 'to') throw new Error(`the worktree isn't at ${to}`) // i18n-ignore: the log's reason
      await moveCardFolders(projectPath, from, to)
      await sessionCwds(ws, projectPath, [{ from, to }], true)
    },
    back: async (from, to, tree) => {
      const at = await where(from, to, tree)
      if (at === 'to') {
        await unfollow(from, to, tree)
        const back = await relocation().move(projectPath, to, from)
        if (!back.ok) log.warn(`${userText(to)} couldn't be moved back to ${userText(from)}: ${userText(back.err)}`)
      } else if (at === 'from') await unfollow(from, to, tree)
      else if (at === 'elsewhere' && !existsSync(from)) {
        // Inside another worktree that came to `to` (a move cut short before its own check): this one moved back from
        // there; the other, and its records, left as they are (follow never ran for this one).
        const there = (await locate(tree))!
        const back = await relocation().move(projectPath, there, from)
        if (!back.ok) log.warn(`${userText(there)} couldn't be moved back to ${userText(from)}: ${userText(back.err)}`)
      }
      return (await where(from, to, tree)) === 'from'
    }
  }
}

/**
 * A worktree's folder moved with the renamer's steps, outside a slot's operation (tests, and a caller with its own
 * guard): the data copied first, git's move, cards and sessions following; put back when a step fails after the move.
 */
export async function relocateWorktree(ws: WorkspaceService, projectPath: string, from: string, to: string, owner: MoveOwner): Promise<{ ok: true } | { ok: false; why: string }> {
  const r = worktreeRenamer(ws, projectPath)
  const who = owner.kind === 'worktree' ? owner.agent : basename(projectPath)
  const tree = await r.identity(from)
  if (!tree) return { ok: false, why: "it isn't a worktree git knows" } // i18n-ignore: the log's reason
  if (!(await r.copy(from, to, who))) return { ok: false, why: "its conversations' data couldn't follow" } // i18n-ignore: the log's reason
  if (!(await r.move(from, to, tree))) return { ok: false, why: "git couldn't move it there" } // i18n-ignore: the log's reason
  try {
    await r.follow(from, to, tree)
  } catch (e) {
    if (!(await r.back(from, to, tree))) log.warn(`${userText(to)} couldn't be put back at ${userText(from)}`)
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
  log.info(`Moved ${userText(from)} to ${userText(to)} with its cards, sessions and conversations`)
  return { ok: true }
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
  // outside Combwork. Each such project is listed for its branches alone.
  for (const p of await projectFolders(ws)) {
    if (hosts.some((h) => samePath(h.path, p))) continue
    const branches = await branchesOf(ws, p, [])
    if (branches.length) planned.push({ path: p, name: basename(p), from: p, folder: p, worktrees: [], sessions: 0, folders: [], branches })
  }
  const renames = planned.reduce((n, h) => n + (h.branches ?? []).filter((b) => !b.kept).length, 0)
  const profile = profileFailed(here)
  if (!hosts.length && !from && !cards.length && !renames && !profile.length) return null
  return {
    from,
    to: here,
    projects: hosts.filter((h) => !h.assistant && !h.pendingOnly).map((h) => h.name),
    pending: hosts.filter((h) => h.pendingOnly).map((h) => h.name),
    running: runningIn(ws, await projectFolders(ws)),
    hosts: planned,
    recent: !!from && config.get().recentWorkspaces.some((p) => samePath(p, from)),
    // By each project's name now: one renamed with the move (juniper, now dialect) is marked under its new name.
    working: from ? [...new Set(workingAt(from).map((n) => hosts.find((h) => !h.assistant && basename(h.from).toLowerCase() === n.toLowerCase())?.name ?? n))].filter((n) => !workingAt(here).includes(n)) : [],
    ...(cards.length ? { cards } : {}),
    ...(renames ? { branches: renames } : {}),
    ...(profile.length ? { profile } : {})
  }
}

/** The plan's headline for the banner, or null when there's nothing to repair. */
export const movedSummary = (plan: MovePlan | null): WorkspaceMoved | null =>
  plan && moveHasWork(plan) ? { from: plan.from, projects: plan.projects, pending: plan.pending, ...(plan.cards?.length ? { cards: plan.cards } : {}), ...(plan.branches ? { branches: plan.branches } : {}), ...(plan.profile?.length ? { profile: plan.profile } : {}) } : null

/**
 * What Combwork's profile keeps by a workspace's folder follows it when it moves (HI-2007): its window's pin and its close
 * command's runs, and its view preferences, each project's and its panes' (HI-2008, viewPrefs.ts). The Assistant's old token file is left: it is written again at each launch, and deleting it could take
 * a workspace's back there (HR2's round 2). Design HI-2007/s40 and s42:
 * - A move is recorded as the moved workspace opens (config.json's `profileMoves`, one per old folder) only when the
 *   old folder is gone (no .combwork, not open): a copy's original keeps its own. Records about that old folder follow it
 *   on, keeping their own old folder (A→B becomes A→C), only when the folder they went to is gone too (a copy left
 *   there keeps them). Never evicted. Its old folders are where it was last opened (lastPath) and where its records
 *   were last all brought (workspace.json's `profileAt`, set once nothing is left to follow it), so a second move before
 *   a Repair finds them.
 * - Tried at each open and Repair, whatever Repair's plan says, until nothing is left at the old folder (a pin there, a
 *   run under its prefixes): a run still going follows once it has ended.
 * - Every change rechecks, as it is made, that the workspace is still open here and the old folder still gone; a close
 *   or a switch stops it with the record kept, the original back ends the record.
 * - What couldn't move (a run that couldn't be renamed, a folder that couldn't be read) is the record's `failed`: shown
 *   in the plan and the banner, a failed row in `report` (Repair isn't complete), or logged.
 */
async function carryProfile(ws: WorkspaceService, report?: MoveReport): Promise<void> {
  const here = ws.path
  const life = ws.lifetime
  if (!here) return
  const current = (): boolean => !life.aborted && ws.path === here
  const gone = (p: string): boolean => !existsSync(join(p, CW_DIR)) && !workspaceFor(p)
  const ofFrom = (from: string) => (m: ProfileMove): boolean => samePath(m.from, from)
  // Where it was last opened (lastPath, as Repair goes by), and where its records were last brought (profileAt): moved
  // again before a Repair, lastPath is still the first old folder while the records went on with it (HR2's round 3).
  const olds = [ws.movedFrom, ws.config.profileAt].filter((p): p is string => !!p && !samePath(p, here))
  for (const from of olds.filter((p, i) => olds.findIndex((q) => samePath(p, q)) === i)) {
    config.update((c) => {
      if (!current() || !gone(from)) return
      // Records about the folder it came from (that folder's own, or one whose workspace went there) follow it on, when
      // the folder they last went to is gone too: lastPath stays at the first old folder until a Repair is done.
      const ours = (m: ProfileMove): boolean => (samePath(m.to, from) || samePath(m.from, from)) && !samePath(m.to, here) && gone(m.to)
      const list = (c.profileMoves ?? []).map((m) => (ours(m) ? { ...m, to: here } : m))
      // The folders they went to are old folders of this one now too (the pin went there with it): each has its record.
      const via = (c.profileMoves ?? []).filter(ours).map((m) => m.to)
      for (const f of [from, ...via]) if (!list.some(ofFrom(f))) list.push({ from: f, to: here })
      c.profileMoves = list
    })
  }
  for (const m of (config.get().profileMoves ?? []).filter((x) => samePath(x.to, here))) {
    if (!current()) return
    const ok = (): boolean => current() && gone(m.from)
    const end = (): void =>
      config.update((c) => {
        c.profileMoves = (c.profileMoves ?? []).filter((x) => !ofFrom(m.from)(x))
      })
    // A workspace at the old folder again (moved back, or another one there): what is kept there is its own.
    if (!gone(m.from)) {
      end()
      continue
    }
    const views = carryViewPrefs(m.from, here, ok)
    if (views) log.info(`${views} view preference(s) follow the workspace from ${userText(m.from)}`)
    if (carryPin(m.from, here, ok)) {
      const win = ws.window
      if (win && !win.isDestroyed() && !win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true)
        emitTo(win, { type: 'window-state', maximized: win.isMaximized(), focused: win.isFocused(), alwaysOnTop: true })
      }
      log.info(`The window's pin follows the workspace from ${userText(m.from)}`)
    }
    let r: Awaited<ReturnType<typeof carryWorkspaceRuns>>
    try {
      r = await carryWorkspaceRuns([placeKey(m.from), resolve(m.from).toLowerCase()], ws.openPlace ?? placeKey(here), ok)
    } catch (e) {
      r = { moved: 0, going: [], stuck: [{ name: '', why: (e as Error).message }], stopped: false }
    }
    if (r.moved) log.info(`${r.moved} close-command run(s) follow the workspace from ${userText(m.from)}`)
    // Closed or switched meanwhile: the record stays for the next try. The original back: it ends.
    if (!current()) return
    if (!gone(m.from)) {
      end()
      continue
    }
    if (r.going.length) log.info(`${r.going.length} close-command run(s) still going at ${userText(m.from)}: they follow once ended`)
    for (const s of r.stuck) {
      const why = s.why
      if (report) say(report, 'failed', tr(msg({ id: 'main.move.closeRunsFailed', defaultMessage: "Combwork's records of the workspace's close command couldn't all follow it from the old folder ({why}). Combwork tries again.", description: "A line of Repair's report, after a workspace moved to another folder: the output Combwork keeps of the workspace's close command couldn't all be moved from the old folder's records. {why} is the system's message." }), { why }), { what: { kind: 'closeRuns' }, result: tr(R.failedWhy, { why }) })
      else log.warn(`carrying a close-command run from ${userText(m.from)}: ${userText(why)}`)
    }
    if (!pinKeptAt(m.from) && !viewPrefsKeptAt(m.from) && !r.going.length && !r.stuck.length && !r.stopped) end()
    else {
      const failed = r.stuck[0]?.why
      config.update((c) => {
        c.profileMoves = (c.profileMoves ?? []).map((x) => (ofFrom(m.from)(x) ? { from: x.from, to: x.to, ...(failed ? { failed } : {}) } : x))
      })
    }
  }
  // Projects moved on their own into this workspace from another (HI-2008, HR2's round 1): their view preferences, before
  // anything records where they are now. Only while the old project folder is gone (a copy's original keeps its own);
  // one renamed or moved within this workspace is projectRename.ts's (two that swapped names keep their own).
  if (!current()) return
  // Its old folders: where it was last opened (lastPath, kept for Repair) and where its views were last brought
  // (project.json's profileAt), so moved again before a Repair they are found where they went (HR2's round 2).
  for (const h of (await movedHosts(ws)).hosts) {
    if (h.assistant || h.pendingOnly || !current()) continue
    const at = (await ws.projectConfig(h.path)).profileAt
    const wasAt = [at, h.from].filter((p): p is string => !!p && !samePath(p, h.path) && !samePath(dirname(p), here))
    let all = true
    for (const from of wasAt.filter((p, i) => wasAt.findIndex((q) => samePath(p, q)) === i)) {
      const ok = (): boolean => current() && !existsSync(join(from, PROJECT_FILE))
      if (!ok()) {
        all = false
        continue
      }
      const n = carryProjectViewPrefs({ from, to: h.path }, { from: dirname(from), to: here }, ok)
      if (n) log.info(`${n} view preference(s) follow ${userText(h.name)} from ${userText(from)}`)
    }
    if (all && current() && !samePath(at ?? '', h.path)) await ws.mutateProjectConfig(h.path, () => ({ profileAt: h.path }))
  }
  // All of it here now: the checkpoint says so, in the workspace's own settings (it travels with the folder, so a move
  // after this finds the records here, and a copy finds them still at the original's).
  if (current() && !samePath(ws.config.profileAt ?? '', here) && !(config.get().profileMoves ?? []).some((x) => samePath(x.to, here)))
    await ws.saveWorkspaceConfigWith(() => ({ profileAt: here }))
}

/** This workspace's records by an old folder that couldn't all follow it (HI-2007): Repair tries again. */
const profileFailed = (here: string): NonNullable<MovePlan['profile']> =>
  (config.get().profileMoves ?? []).filter((m) => samePath(m.to, here) && !!m.failed).map((m) => ({ from: m.from, failed: m.failed! }))

/**
 * On opening a workspace: records the folders of those opened for the first time, and works out whether anything
 * moved. A move with nothing to repair is simply recorded; otherwise the window's banner offers Repair….
 */
export async function checkMoved(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  await carryProfile(ws).catch((e) => log.warn("carrying the profile's records of a moved workspace", e))
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
  const here = ws.path
  if (all && here && ws.config.lastPath !== here) await ws.saveWorkspaceConfigWith(() => ({ lastPath: here }))
}

const trimList = (list: string[], max = 5): string =>
  list.length > max
    ? fmt.list([...list.slice(0, max), tr(msg({ id: 'main.move.more', defaultMessage: '{n, plural, one {# more} other {# more}}', description: "The last item of a long list in Repair's report (after a workspace moved), after the first few: how many more there are (folders, files or names). Combwork joins it to the list (\"A, B, C and 3 more\")." }), { n: list.length - max })])
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
    const why = e instanceof Error ? e.message : String(e)
    say(report, 'failed', tr(msg({ id: 'main.move.adoptFailed', defaultMessage: "The handovers and kept comparisons saved under a project's earlier name couldn't all be given to it ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {why} is the system's message. Kept comparisons are benchmarks kept in Performance → Compare." }), { why }), { what: { kind: 'saved' }, result: tr(R.failedWhy, { why }) })
  }
}

async function repairNow(ws: WorkspaceService, opts: MoveOptions): Promise<MoveReport> {
  const report: MoveReport = { done: [], skipped: [], failed: [], rows: [], complete: false }
  await carryProfile(ws, report)
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
    const folders = await foldersOf(ws, h.path)
    const folderOfRow = (w: MoveWorktree): ProjectFolder | undefined => (w.of ? folders.find((f) => f.key === w.agentId) : undefined)
    const whatOf = (w: MoveWorktree): MoveReportRow['what'] => (w.of ? { kind: 'folder', of: w.of } : { kind: 'worktree', agent: w.agentName })
    if (fix.length) {
      const r = await relocation().repair(h.path, fix.map((w) => w.to!))
      const listed = (await slotWorkspaces().list(h.path)) ?? []
      for (const w of fix) {
        const ok = listed.some((l) => samePlace(l.path, w.to!)) && (await linked(h.path, w.to!))
        if (!ok) {
          const why = r.ok ? '' : (r.err || tr(msg({ id: 'main.move.gitFailed', defaultMessage: '{command} failed', description: "Why git couldn't do something, when it said nothing itself. {command} is the git command: keep it." }), { command: 'git worktree repair' })).trim() // i18n-ignore: a git command's name
          say(
            report,
            'failed',
            r.ok
              ? tr(msg({ id: 'main.move.notRepaired', defaultMessage: "{host}: {agent}'s worktree at {path} couldn't be repaired.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree." }), { host: h.name, agent: w.agentName, path: w.to! })
              : tr(msg({ id: 'main.move.notRepairedWhy', defaultMessage: "{host}: {agent}'s worktree at {path} couldn't be repaired ({why}).", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree, {why} git's message." }), { host: h.name, agent: w.agentName, path: w.to!, why }),
            { host: h.name, what: whatOf(w), was: w.from, now: w.to!, result: tr(R.notRepaired, { hasWhy: why ? 'yes' : 'no', why }) }
          )
          continue
        }
        // A slot, copy or home (#1447): its cards follow it (slots), then its record, then its sessions and data
        // (pending, as an agent's worktree's: slots and homes, not copies, whose reviewers run in the project folder).
        const f = folderOfRow(w)
        if (w.of) {
          const what = folderWhat(w.of)
          const failed = (why: string): void => say(report, 'failed', tr(F.failed, { host: h.name, what, path: w.to!, why }), { host: h.name, what: whatOf(w), was: w.from, now: w.to!, result: tr(R.failedWhy, { why }) })
          try {
            // The move its sessions and data follow is saved first (HR1's round 1): cut short after the record below, the
            // pending move is still there for this Repair's last step or the next Repair to finish.
            if (w.of.kind !== 'copy' && !samePath(w.from, w.to!)) {
              const m = { from: w.from, to: w.to!, ...owned({ kind: 'worktree', agent: w.agentName }) }
              await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingCopies: withPending(cfg.pendingCopies, m) }))
            }
            if (w.of.kind === 'slot') await moveCardFolders(h.path, w.from, w.to!)
            if (!f || !(await relocateFolder(ws, h.path, f, w.to!))) {
              failed(tr(F.busy))
              continue
            }
          } catch (e) {
            failed(e instanceof Error ? e.message : String(e))
            continue
          }
          say(report, 'done', samePath(w.from, w.to!) ? tr(F.relinked, { host: h.name, what, path: w.to! }) : tr(F.movedTo, { host: h.name, what, path: w.to! }), { host: h.name, what: whatOf(w), was: w.from, now: w.to!, result: tr(R.linked) })
          continue
        }
        // Its cards' work follows it first (#1343), so a Repair cut short before the record below writes it again.
        try {
          await moveCardFolders(h.path, w.from, w.to!)
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          say(report, 'failed', tr(msg({ id: 'main.move.cardsNotMoved', defaultMessage: "{host}: the cards {agent} works on couldn't be told its worktree is now at {path} ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder: the board's record of the cards worked on in an agent's worktree couldn't be updated to its new place. {host} is the project; {agent} an agent; {path} the worktree's new folder; {why} the system's message." }), { host: h.name, agent: w.agentName, path: w.to!, why }), { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, now: w.to!, result: tr(R.failedWhy, { why }) })
          continue
        }
        // The new path, and the move its data follows until that is copied, in one locked change.
        const m = { from: w.from, to: w.to!, ...owned({ kind: 'worktree', agent: w.agentName }) }
        await ws.mutateProjectConfig(h.path, (cfg) => ({
          // Repair writes 0.9.3's field (#1452): the worktree the agent had, at its new path.
          agents: projectAgents(cfg).map((a) => { const t = legacyWorktree(a); return a.id === w.agentId && t ? { ...a, worktree: { ...t, path: w.to! } } : a }),
          ...(samePath(w.from, w.to!) ? {} : { pendingCopies: withPending(cfg.pendingCopies, m) })
        }))
        say(
          report,
          'done',
          samePath(w.from, w.to!)
            ? tr(msg({ id: 'main.move.relinked', defaultMessage: "{host}: {agent}'s worktree at {path} is linked to the project again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree." }), { host: h.name, agent: w.agentName, path: w.to! })
            : tr(msg({ id: 'main.move.movedTo', defaultMessage: "{host}: {agent}'s worktree is now at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where the worktree is now." }), { host: h.name, agent: w.agentName, path: w.to! }),
          { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, now: w.to!, result: tr(R.linked) }
        )
      }
    }
    // Worktrees to make again: after the repairs above, so git's prune can't drop a link they still needed.
    const remake = h.worktrees.filter((w) => w.how === 'recreate')
    for (const w of remake) {
      if (w.of) {
        // A gone leased slot (#1447): made again on its line by its pool, its lease kept; its cards and sessions follow.
        const f = folderOfRow(w)
        const what = folderWhat(w.of)
        // The move its sessions and data follow, saved before the slot is made (HR1's round 1), dropped if it isn't.
        const m = w.to && !samePath(w.from, w.to) ? { from: w.from, to: w.to, ...owned({ kind: 'worktree', agent: w.agentName }) } : null
        if (m) await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingCopies: withPending(cfg.pendingCopies, m) }))
        const why = f && w.to ? await recreateSlot(ws, h.path, f, w.to) : 'not found' // i18n-ignore: the log's reason
        if (why) {
          if (m) await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingCopies: (cfg.pendingCopies ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to))) }))
          say(report, 'failed', tr(F.recreateFailed, { host: h.name, what, why }), { host: h.name, what: whatOf(w), was: w.from, result: tr(R.recreateFailed, { made: 'again', why }) })
          continue
        }
        await moveCardFolders(h.path, w.from, w.to!).catch((e) => log.warn(`moving ${userText(w.agentName)}'s cards to its recreated slot`, e))
        say(report, 'done', tr(F.recreated, { host: h.name, what, branch: w.branch ?? '', path: w.to! }), { host: h.name, what: whatOf(w), was: w.from, now: w.to!, result: tr(R.recreated, { made: 'again' }) })
        continue
      }
      try {
        // Its new path and the move its sessions and data follow are written together (in recreateWorktree).
        const def = await recreateWorktree(h.path, w.agentId, { prefer: w.to ?? undefined, alsoRecreating: remake.map((x) => x.from) })
        const to = legacyWorktree(def)!.path
        say(
          report,
          'done',
          w.branchExists
            ? tr(msg({ id: 'main.move.recreated', defaultMessage: "{host}: {agent}'s worktree was recreated on its branch {branch}, at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {branch} is its branch, {path} the new worktree." }), { host: h.name, agent: w.agentName, branch: w.branch ?? '', path: to })
            : tr(msg({ id: 'main.move.madeNew', defaultMessage: "{host}: {agent}'s worktree was made new on {branch} (its branch was gone), at {path}.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {branch} is the new branch, {path} the new worktree." }), { host: h.name, agent: w.agentName, branch: w.branch ?? '', path: to }),
          { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, now: to, result: tr(R.recreated, { made: w.branchExists ? 'again' : 'new' }) }
        )
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        say(
          report,
          'failed',
          w.branchExists
            ? tr(msg({ id: 'main.move.recreateFailed', defaultMessage: "{host}: {agent}'s worktree couldn't be recreated: {why}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {why} says why." }), { host: h.name, agent: w.agentName, why })
            : tr(msg({ id: 'main.move.makeNewFailed', defaultMessage: "{host}: {agent}'s worktree couldn't be made new: {why}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {why} says why." }), { host: h.name, agent: w.agentName, why }),
          {
            host: h.name,
            what: { kind: 'worktree', agent: w.agentName },
            was: w.from,
            // Git's clean-up would forget the worktrees git names (not the plan's missing ones: git's list may differ),
            // each by its agent or folder here, the full paths in the line.
            result: e instanceof PruneBlocked ? tr(R.pruneBlocked, { n: e.blockers.length, worktrees: fmt.list(blockerNames(e.blockers, h.worktrees), 'unit') }) : tr(R.recreateFailed, { made: w.branchExists ? 'again' : 'new', why })
          }
        )
      }
    }
    for (const w of h.worktrees) {
      if (w.of) {
        const f = folderOfRow(w)
        const what = folderWhat(w.of)
        const row = { host: h.name, what: whatOf(w), was: w.from }
        if (w.how === 'unlink' && f && w.of.kind === 'slot') {
          // Release: its lease ends; the slot, free, is made again where it belongs at its next lease.
          const ok = await releaseSlotLease(ws, h.path, f)
          say(report, ok ? 'done' : 'failed', ok ? tr(F.released, { host: h.name, what }) : tr(F.failed, { host: h.name, what, path: w.from, why: tr(F.busy) }), { ...row, result: ok ? tr(R.released) : tr(R.failedWhy, { why: tr(F.busy) }) })
          if (!ok) open = true
        } else if (w.how === 'unlink' && f) {
          await relocateFolder(ws, h.path, f, w.from, { gone: true })
          say(report, 'done', tr(F.forgotten, { host: h.name, what, path: w.from }), { ...row, result: tr(R.forgotten) })
        } else if (w.how === 'later' && f && w.to) {
          const ok = await relocateFolder(ws, h.path, f, w.to, { gone: true })
          say(report, ok ? 'done' : 'failed', ok ? tr(F.later, { host: h.name, what, path: w.to }) : tr(F.failed, { host: h.name, what, path: w.to, why: tr(F.busy) }), { ...row, now: w.to, result: ok ? tr(R.later) : tr(R.failedWhy, { why: tr(F.busy) }) })
          if (!ok) open = true
        } else if (w.how === 'missing') {
          open = true
          say(report, 'skipped', w.of.kind === 'home' ? tr(F.homeMissing, { host: h.name, what, path: w.from }) : tr(F.slotMissing, { host: h.name, what, path: w.from, hasBranch: w.branchExists ? 'yes' : 'no', branch: w.branch ?? '' }), { ...row, result: tr(R.folderMissing, { kind: w.of.kind, gone: w.branchExists ? 'no' : 'yes' }) })
        } else if (w.how === 'original') say(report, 'skipped', tr(F.original, { host: h.name, what, path: w.from, project: h.from }), { ...row, result: tr(R.original) })
        continue
      }
      if (w.how === 'unlink') {
        await ws.mutateProjectConfig(h.path, (cfg) => ({ agents: projectAgents(cfg).map((a) => (a.id === w.agentId ? { ...a, worktree: undefined } : a)) }))
        say(report, 'done', tr(msg({ id: 'main.move.unlinked', defaultMessage: '{host}: {agent} no longer has a worktree (its folder {path} was left as it was).', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the old worktree." }), { host: h.name, agent: w.agentName, path: w.from }), { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, result: tr(R.unlinked) })
      } else if (w.how === 'missing') {
        open = true
        say(
          report,
          'skipped',
          w.branchExists
            ? tr(msg({ id: 'main.move.missing', defaultMessage: "{host}: {agent}'s worktree wasn't found (it was at {path}). Recreate it on its branch, locate it, or remove the agent's worktree link.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where it was. Its branch is still there." }), { host: h.name, agent: w.agentName, path: w.from })
            : tr(msg({ id: 'main.move.missingNoBranch', defaultMessage: "{host}: {agent}'s worktree wasn't found (it was at {path}). Create a new worktree, locate it, or remove the agent's worktree link.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is where it was. Its branch has gone too." }), { host: h.name, agent: w.agentName, path: w.from }),
          { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, result: tr(R.missing, { gone: w.branchExists ? 'no' : 'yes' }) }
        )
      } else if (w.how === 'original') {
        say(report, 'skipped', tr(msg({ id: 'main.move.original', defaultMessage: "{host}: {agent}'s worktree at {path} stays linked to the project at {project}, which is still there.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {agent} an agent. {path} is the worktree, {project} the project folder it was made from (a copy was moved, not that one)." }), { host: h.name, agent: w.agentName, path: w.from, project: h.from }), { host: h.name, what: { kind: 'worktree', agent: w.agentName }, was: w.from, result: tr(R.original) })
      }
    }
    // Branches named after the old place (#1305): one operation a failure part way never leaves half done. The rename
    // is recorded first (pendingBranchRenames); then git's (it moves the branch's upstream and updates the worktree
    // that has it out); then each card whose work is on that line follows it (LineRenamed); then the agent's record,
    // the rename dropped from the list. Cut short anywhere, the next Repair finishes it from there (branchesOf).
    for (const b of h.branches ?? []) {
      if (b.kept) say(report, 'skipped', tr(msg({ id: 'main.move.branchTaken', defaultMessage: '{host}: branch {from} of agent {agent} keeps its name: {to} is already a branch.', description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place isn't renamed, because a branch with its new name exists. {host} is the project; {agent} an agent; {from} and {to} are branch names. A noun before the name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to }), { host: h.name, what: { kind: 'branch', agent: b.agentName }, was: b.from, now: b.from, names: true, result: tr(R.taken) })
    }
    const renames = (h.branches ?? []).filter((b) => !b.kept)
    // No reconciliation reads a line while it is renamed: runs under way finish first, and new ones wait (repairingMove).
    if (renames.length) await reconcilersIdle(ws)
    for (const b of renames) {
      // Now is the branch as it is after this step (#1313 round 2): its old name until git's rename is done, the new one
      // after, none once it's gone; the name it was to have is in the row's full line.
      const branchRow = { host: h.name, what: { kind: 'branch', agent: b.agentName }, was: b.from, names: true } as const
      const failed = (why: string): void => {
        say(report, 'failed', tr(msg({ id: 'main.move.branchFailed', defaultMessage: "{host}: branch {from} of agent {agent} couldn't be renamed to {to} ({why}).", description: "A line of Repair's report, after a workspace or project moved to another folder. {host} is the project; {agent} an agent; {from} and {to} are branch names; {why} is git's or the system's message. A noun before the name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to, why }), { ...branchRow, now: b.from, result: tr(R.renameFailed, { why }) })
      }
      const whyOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      try {
        if (!b.pending) await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingBranchRenames: [...(cfg.pendingBranchRenames ?? []).filter((x) => x.agentId !== b.agentId), { agentId: b.agentId, from: b.from, to: b.to }] }))
      } catch (e) {
        failed(whyOf(e))
        continue
      }
      const branches = await relocation().localLines(h.path)
      const has = (x: string): boolean => branches.some((y) => y.toLowerCase() === x.toLowerCase())
      if (has(b.from)) {
        if (has(b.to)) {
          failed(tr(msg({ id: 'main.move.branchBoth', defaultMessage: 'both names are branches', description: "Why Repair couldn't rename an agent's branch (in main.move.branchFailed's {why}): a branch with the new name appeared meanwhile." })))
          continue
        }
        if (await queuedOn(ws, h.path, b.from)) {
          // Its pending entry stays: the next Repair renames it once the queued action has run.
          failed(tr(msg({ id: 'main.move.branchQueued', defaultMessage: 'a queued step still uses it; Repair renames it next time', description: "Why Repair couldn't rename an agent's branch yet (in main.move.branchFailed's {why}): one of the board's queued steps (preparing a card's folder) names the branch." })))
          continue
        }
        const r = await relocation().renameLine(h.path, b.from, b.to)
        if (!r.ok) {
          failed((r.err || 'git branch -m').trim()) // i18n-ignore: a git command's name
          continue
        }
      } else if (!has(b.to)) {
        // Neither name is a branch any more (deleted meanwhile): nothing to rename, and nothing left to finish.
        await ws.mutateProjectConfig(h.path, (cfg) => ({ pendingBranchRenames: dropRename(cfg.pendingBranchRenames, b.agentId) })).catch((e) => log.warn('dropping a branch rename', e))
        say(report, 'skipped', tr(msg({ id: 'main.move.branchGone', defaultMessage: "{host}: branch {from} of agent {agent} is gone, so it isn't renamed.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch to rename no longer exists. {host} is the project; {agent} an agent; {from} a branch name. A noun before the name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, from: b.from }), { ...branchRow, result: tr(R.gone) })
        continue
      }
      try {
        await renameCardLines(ws, h.path, b.from, b.to)
        const space = b.to.split('/')[1]
        await ws.mutateProjectConfig(h.path, (cfg) => ({
          agents: projectAgents(cfg).map((a) => { const t = legacyWorktree(a); return a.id === b.agentId && t && t.branch.toLowerCase() === b.from.toLowerCase() ? { ...a, worktree: { ...t, branch: b.to } } : a }),
          pendingBranchRenames: dropRename(cfg.pendingBranchRenames, b.agentId),
          // A workspace part this project's branches hadn't had is recorded, so it stays this project's (#703 round 3).
          ...(space && space.toLowerCase() !== refPart(basename(ws.path ?? ''), 'workspace').toLowerCase() && !(cfg.branchSpaces ?? []).some((s) => s.toLowerCase() === space.toLowerCase()) ? { branchSpaces: [...(cfg.branchSpaces ?? []), space] } : {})
        }))
      } catch (e) {
        say(report, 'failed', tr(msg({ id: 'main.move.branchUnrecorded', defaultMessage: "{host}: the branch of agent {agent} is now {to}, but Combwork couldn't record it yet ({why}). Repair finishes it.", description: "A line of Repair's report, after a workspace or project moved to another folder: git renamed an agent's branch, and Combwork's record of it (or of the cards on it) couldn't be written; the next Repair finishes it. {host} is the project; {agent} an agent; {to} the branch's new name; {why} the system's message. A noun before the name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, to: b.to, why: whyOf(e) }), { ...branchRow, now: b.to, result: tr(R.unrecorded, { why: whyOf(e) }) })
        continue
      }
      say(
        report,
        'done',
        b.remote
          ? tr(msg({ id: 'main.move.branchRenamedRemote', defaultMessage: "{host}: branch {from} of agent {agent} is now {to}; it still tracks {from} on remote {remote}, so push it under the new name when you're ready.", description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place was renamed, and it tracks a remote, which keeps the old name. {host} is the project; {agent} an agent; {from} and {to} are branch names; {remote} the remote (origin). A noun before each name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to, remote: b.remote })
          : tr(msg({ id: 'main.move.branchRenamed', defaultMessage: '{host}: branch {from} of agent {agent} is now {to}.', description: "A line of Repair's report, after a workspace or project moved to another folder: an agent's branch named after the old place was renamed, with Combwork's record of it. {host} is the project; {agent} an agent; {from} and {to} are branch names. A noun before the name (glossary §1 rule 4)." }), { host: h.name, agent: b.agentName, from: b.from, to: b.to }),
        { ...branchRow, now: b.to, result: tr(R.renamed, { remote: b.remote ?? 'none' }) }
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
      if (n) say(report, 'done', tr(msg({ id: 'main.move.sessions', defaultMessage: '{n, plural, one {{host}: # session now points to the new folder.} other {{host}: # sessions now point to the new folder.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {n} is how many sessions." }), { host: h.name, n }), { host: h.name, what: { kind: 'sessions' }, was: h.from, now: h.folder, result: tr(R.sessions, { n }) })
    } catch (e) {
      sessionsOk = false
      const why = e instanceof Error ? e.message : String(e)
      say(report, 'failed', tr(msg({ id: 'main.move.sessionsFailed', defaultMessage: "{host}: the sessions' folders couldn't be updated ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {host} is the project (or the Assistant) it is about; {why} is the system's message." }), { host: h.name, why }), { host: h.name, what: { kind: 'sessions' }, was: h.from, result: tr(R.failedWhy, { why }) })
    }
    // Copied, never moved; the old folders stay.
    for (const m of moves) {
      const results = await copyFor(m, true)
      for (const f of results) {
        const who = allProviders().find((p) => p.id === f.provider)?.descriptor.name ?? f.provider
        const said = copyReport(h.name, f, who)
        // Where the folder moved from and to (whose it is), not the CLI's own folders for them: the line names those.
        const row = { host: h.name, what: { kind: 'copy', provider: f.provider }, was: m.from, now: m.to } as const
        for (const line of said.done) say(report, 'done', line, { ...row, result: tr(R.copied, { n: f.copy }) })
        for (const line of said.skipped) say(report, 'skipped', line, { ...row, result: tr(R.copyKept, { n: f.kept.length }) })
        for (const line of said.failed) say(report, 'failed', line, { ...row, result: tr(R.copyFailed, { n: f.failed?.length ?? 0 }) })
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
      // comparisons) is then given to it, by this Repair or, if that fails, by the next (or when Combwork next follows the
      // projects' names, after a restart too), once the cards that told it are moved.
      const id = ws.projectIdsNow().byPath.get(join(ws.path!, m.to).toLowerCase())
      if (id) await noteFormerName(ws, id, m.from)
      const board = { what: { kind: 'board', from: m.from } } as const
      const n = m.cards.length ? await moveOrphanCards(ws, m) : 0
      if (n)
        say(
          report,
          'done',
          tr(msg({ id: 'main.move.cards', defaultMessage: '{n, plural, one {# card of {from} now belongs to {to}, with its agents.} other {# cards of {from} now belong to {to}, with their agents.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): what was left under a project's old name went to the project. {from} is the old name, {to} the project. {n} is how many cards." }), { n, from: m.from, to: m.to }),
          { ...board, result: tr(R.given, { to: m.to, what: tr(R.cards, { n }) }) }
        )
      const lanes = m.lanes ? await moveOrphanLanes(ws, m) : 0
      const watches = m.watches ? await moveOrphanWatches(ws, m) : 0
      const also = [
        ...(lanes ? [tr(msg({ id: 'main.move.lanes', defaultMessage: '{n, plural, one {# lane} other {# lanes}}', description: 'Card loops (lanes) that went to a project, in a list (main.move.alsoMoved). {n} is how many.' }), { n: lanes })] : []),
        ...(watches ? [tr(msg({ id: 'main.move.watches', defaultMessage: '{n, plural, one {# card watch} other {# card watches}}', description: "Agents' card watches that went to a project, in a list (main.move.alsoMoved). {n} is how many." }), { n: watches })] : [])
      ]
      if (also.length)
        say(
          report,
          'done',
          tr(msg({ id: 'main.move.alsoMoved', defaultMessage: "{n, plural, one {{things} of {from} now is {to}'s.} other {{things} of {from} now are {to}'s.}}", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): what was left under a project's old name went to the project. {from} is the old name, {to} the project. {things} lists the lanes and card watches (main.move.lanes, main.move.watches); {n} is how many in all." }), { things: fmt.list(also), from: m.from, to: m.to, n: lanes + watches }),
          { ...board, result: tr(R.given, { to: m.to, what: fmt.list(also) }) }
        )
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      say(report, 'failed', tr(msg({ id: 'main.move.savedFailed', defaultMessage: "What was saved under {from} couldn't all be given to {to} ({why}). Repair tries again.", description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). {from} is a project's old name, {to} the project, {why} the system's message." }), { from: m.from, to: m.to, why }), { what: { kind: 'board', from: m.from }, result: tr(R.notGiven, { to: m.to, why }) })
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
    say(report, 'done', tr(msg({ id: 'main.move.workingRenamed', defaultMessage: '{n, plural, one {Working on: {projects}, as before its rename.} other {Working on: {projects}, as before their rename.}}', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): renamed projects stay Working on. Working on is how the sidebar marks projects: use its name as shown. {projects} lists them; {n} is how many." }), { projects: trimList(marked.map((h) => h.name)), n: marked.length }), { what: { kind: 'working' }, result: tr(R.working, { projects: trimList(marked.map((h) => h.name)) }) })
  }
  if (plan.recent && plan.from) {
    const from = plan.from
    config.update((c) => {
      const rest = c.recentWorkspaces.filter((p) => !samePath(p, from))
      c.recentWorkspaces = rest.some((p) => samePath(p, plan.to)) ? rest : [plan.to, ...rest]
    })
    recentChanged()
    say(report, 'done', tr(msg({ id: 'main.move.recent', defaultMessage: 'Open Recent lists {to} instead of {from}.', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner). Open Recent is a menu (File → Open Recent): use its name as shown. {to} is the workspace folder now, {from} where it was." }), { to: plan.to, from }), { what: { kind: 'recent' }, was: from, now: plan.to, result: tr(R.recent) })
  }
  if (plan.working.length) {
    config.update((c) => {
      c.activeProjects[plan.to] = [...new Set([...(c.activeProjects[plan.to] ?? []), ...plan.working])]
    })
    say(report, 'done', tr(msg({ id: 'main.move.workingMoved', defaultMessage: 'Working on: {projects}, as before the move.', description: "A line of Repair's report, after a workspace or project moved to another folder (the moved-workspace banner): the projects stay Working on. Working on is how the sidebar marks projects: use its name as shown. {projects} lists them." }), { projects: trimList(plan.working) }), { what: { kind: 'working' }, result: tr(R.working, { projects: trimList(plan.working) }) })
  }
  // Combwork's Defender exclusions follow the workspace (#1302): last, so the administrator prompt comes once everything else
  // is done; only when the dialog's box asked for it. A declined prompt changes nothing and is said; a refusal too.
  if (opts.defender && plan.from) {
    try {
      const r = await moveExclusions(ws, plan.from)
      if (r) say(report, r.outcome === 'done' ? 'done' : r.outcome === 'refused' ? 'skipped' : 'failed', r.message, { what: { kind: 'defender' }, result: r.message })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      say(report, 'failed', tr(msg({ id: 'main.move.defenderFailed', defaultMessage: "Combwork's Defender exclusions couldn't be moved to the new folders ({why}).", description: "A line of Repair's report, after a workspace moved to another folder: moving Combwork's Microsoft Defender exclusions from the old folders to the new ones failed. {why} is the system's message." }), { why }), { what: { kind: 'defender' }, result: tr(R.failedWhy, { why }) })
    }
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
