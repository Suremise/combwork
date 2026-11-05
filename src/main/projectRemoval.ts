import { randomBytes } from 'crypto'
import { basename, dirname, extname, join, resolve } from 'path'
import { copyFile, mkdir, readdir, readFile, rmdir } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { CW_DIR, agentPtyKey, projectAgents } from '../shared/defaults'
import { fmt, msg, tr } from '../shared/i18n'
import { forgetPtys } from './ptyHost'
import type { AgentDef, ProjectFolderOf, ProjectRemoval, ProjectRemovalInfo, TaskCard } from '../shared/types'
import { config } from './config'
import { suspendWatching } from './files'
import { observer } from './platform/observe'
import { containsPlace, readJson, realPath, removePath, samePlace, writeJsonAtomic } from './fsutil'
import { createLogger, userText } from './logger'
import { handoversFor } from './notes'
import { sessions } from './sessions'
import { archiveProjectCards, deleteProjectCards, importCards, projectCards, restoreProjectCards } from './tasks'
import { REMOVED_DIR, workspace, type WorkspaceService } from './workspace'
import * as wt from './worktrees'
import { trash } from './trash'
import { boardWrite } from './boardStore'
import { FactStore } from './workflow/factStore'
import { forgetProjectQueues } from './workflow/queueRunner'
import { legacyWorktree, slotsMigrated } from './agentFolders'
import { deleteBlocks, projectFolders, releaseDelete, removeFolders, reserveDelete, reserveRefusal, trashFolders } from './projectFolders'
import { folderWhat } from '../shared/projectFolders'

const log = createLogger('projects')

/**
 * A project leaving Hive (Project → Remove Project…), three ways:
 * - Hide: nothing moves; Hive leaves the folder out until it's restored (Settings → Workspace).
 * - Remove from Hive: its workspace files (handovers, cards) are packed into its own .combwork/removed and leave the
 *   workspace, so the folder carries them wherever it goes; Hive offers them back when it sees the folder again.
 * - Delete: the folder, its worktrees and its handovers go to the Recycle Bin, and its cards are deleted.
 * The CLIs' own transcripts (~/.claude, ~/.codex) are never touched.
 *
 * Nothing about the project is decided from what the dialog saw: its agents are stopped (and kept from starting)
 * first, and its worktrees, handovers and cards are looked at again after that.
 */

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Every project folder name in the workspace, hidden ones too (handover names are matched against them all). */
async function allNames(ws: WorkspaceService): Promise<string[]> {
  return [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))].map((p) => basename(p))
}

/**
 * The project's handovers in the shared notes, by path relative to .combwork/shared: those its id owns (#514), never
 * another project's that had its name (they are moved or deleted).
 */
async function handoversOf(ws: WorkspaceService, name: string): Promise<string[]> {
  return (await handoversFor(ws, name)).map((f) => f.relPath)
}

/** A project folder of the open workspace, shown or hidden. */
function folderOf(ws: WorkspaceService, projectPath: string): string {
  const p = join(ws.path ?? '', basename(projectPath))
  if (!ws.path || !same(dirname(resolve(projectPath)), ws.path) || !existsSync(p) || basename(p).startsWith('.')) throw new Error(tr(msg({ id: 'main.removal.notProject', defaultMessage: 'Not a project in the open workspace: {path}', description: "An error removing, hiding or restoring a project: the folder {path} is not one of the workspace's projects." }), { path: projectPath }))
  return p
}

/**
 * The project's agent worktrees that are safe to remove: folders git lists as worktrees of this project, that are
 * not the project itself, nor contain it or the workspace, nor are another project. project.json can be edited by
 * hand: a path it gives is never removed on its word alone. The rest come back as `refused`, with why. Exported for tests.
 */
export async function checkedWorktrees(ws: WorkspaceService, p: string, all: AgentDef[]): Promise<{ ok: AgentDef[]; refused: string[] }> {
  // Agents whose 0.9 worktree the slots' migration took over (#1441) are the slots' (removeFolders), not these.
  const agents: AgentDef[] = []
  for (const a of all) if (!(await slotsMigrated(p, a.id))) agents.push(a)
  // Real paths, for each check: git lists long names, while the agent's path may use a short (8.3) one such as RUNNER~1
  // or go through a junction (#389, #455).
  const registered = new Set((await wt.listWorktrees(p)).map((w) => realPath(w.path).toLowerCase()))
  const projects = (await allNames(ws)).map((n) => join(ws.path!, n))
  const ok: AgentDef[] = []
  const refused: string[] = []
  for (const a of agents) {
    const tree = legacyWorktree(a)
    if (!tree) continue
    const t = resolve(tree.path)
    const why = !registered.has(realPath(t).toLowerCase())
      ? tr(msg({ id: 'main.removal.why.notListed', defaultMessage: "git doesn't list it as one of the project's worktrees", description: "Why Combwork won't remove or delete an agent's worktree with its project: a clause in brackets (main.removal.refusedTree)." }))
      : containsPlace(t, p) || containsPlace(t, ws.path!)
        ? tr(msg({ id: 'main.removal.why.contains', defaultMessage: 'it contains the project or the workspace', description: "Why Combwork won't remove or delete an agent's worktree with its project: a clause in brackets (main.removal.refusedTree)." }))
        : projects.some((x) => samePlace(x, t))
          ? tr(msg({ id: 'main.removal.why.otherProject', defaultMessage: 'it is another project of the workspace', description: "Why Combwork won't remove or delete an agent's worktree with its project: a clause in brackets (main.removal.refusedTree)." }))
          : null
    if (why) refused.push(tr(msg({ id: 'main.removal.refusedTree', defaultMessage: "{agent}'s worktree {path} ({why})", description: "An agent's worktree Combwork won't remove or delete with its project. {agent} is the agent's name, {path} the worktree's folder, {why} why (main.removal.why.*)." }), { agent: a.name, path: t, why }))
    else ok.push(a)
  }
  return { ok, refused }
}

export async function removalInfo(projectPath: string): Promise<ProjectRemovalInfo> {
  const ws = workspace
  const p = folderOf(ws, projectPath)
  const name = basename(p)
  const cards = await projectCards(ws, name)
  const worktrees: ProjectRemovalInfo['worktrees'] = []
  for (const a of projectAgents(await ws.projectConfig(p))) {
    // Its 0.9 worktree, until the slots' migration took it over (#1441: then it is one of the slots below).
    const tree = legacyWorktree(a)
    if (!tree || (await slotsMigrated(p, a.id))) continue
    // Unknown is not clean: a worktree git can't check counts as holding work.
    const st = await wt.branchStatus(p, tree).then(
      (s) => ({ ahead: s.ahead, dirty: s.dirty, error: undefined as string | undefined }),
      (e: Error) => ({ ahead: 0, dirty: 0, error: e.message })
    )
    worktrees.push({ agent: a.name, path: tree.path, branch: tree.branch, ...st })
  }
  return {
    name,
    path: p,
    running: sessions.projectStates(p).length,
    handovers: await handoversOf(ws, name),
    cards: cards.filter((c) => !c.archived).length,
    archivedCards: cards.filter((c) => c.archived).length,
    worktrees,
    // Its slots, copies and old reviewer folders (#1447), with what removing it would do to each.
    folders: await removeFolders(ws, p, false)
  }
}

/** Why Remove from Hive can't go ahead: worktrees with work not merged, or that git can't check. Null when it can. */
function unmergedWork(worktrees: ProjectRemovalInfo['worktrees']): string | null {
  const held = worktrees.filter((w) => w.ahead || w.dirty || w.error)
  if (!held.length) return null
  const what = (w: ProjectRemovalInfo['worktrees'][number]): string =>
    w.error ??
    fmt.list([
      ...(w.ahead ? [tr(msg({ id: 'main.removal.ahead', defaultMessage: '{n, plural, one {# commit not merged} other {# commits not merged}}', description: "Work in an agent's worktree that stops Remove from Combwork: its commits not merged. {n} is how many." }), { n: w.ahead })] : []),
      ...(w.dirty ? [tr(msg({ id: 'main.removal.dirty', defaultMessage: '{n, plural, one {# uncommitted file} other {# uncommitted files}}', description: "Work in an agent's worktree that stops Remove from Combwork: its files not committed. {n} is how many." }), { n: w.dirty })] : [])
    ])
  return tr(msg({ id: 'main.removal.unmerged', defaultMessage: "Merge or discard the work in {worktrees} first: a worktree can't go with the project folder.", description: "Why Remove from Combwork can't go ahead. {worktrees} lists the agents' worktrees with work in them (main.removal.heldTree)." }), { worktrees: fmt.list(held.map((w) => tr(msg({ id: 'main.removal.heldTree', defaultMessage: "{agent}'s worktree ({work})", description: "An agent's worktree with work in it, in the reason Remove from Combwork can't go ahead. {work} says what (commits not merged, uncommitted files) or why git couldn't check." }), { agent: w.agent, work: what(w) }))) })
}

/** The slots, copies and old folders a removal left (#1447), one warning each, with why. */
function keptWarnings(folders: readonly { of: ProjectFolderOf; path: string; kept: string | null }[]): string[] {
  return folders.flatMap((f) => (f.kept ? [tr(msg({ id: 'main.removal.folderKept', defaultMessage: 'Left in place: {what} at {path} ({why}).', description: "A warning after Remove from Combwork or Delete (#1447): a slot, review copy or old reviewer folder ({what}: its name) that was kept, at {path}, and why ({why}: a clause)." }), { what: folderWhat(f.of), path: f.path, why: f.kept })] : []))
}

/** Stops the project's agents (and starts in progress) and waits for them, so nothing holds or changes its folders. */
async function stopAgents(p: string): Promise<void> {
  await sessions.stopWhereAndWait((s) => same(s.projectPath, p), 8000)
  if (sessions.projectStates(p).length || sessions.pendingStarts().some((x) => same(x, p))) throw new Error(tr(msg({ id: 'main.removal.stopFailed', defaultMessage: "Could not stop {project}'s agents. Stop them, then try again.", description: 'An error removing, hiding or deleting a project: its agents kept running.' }), { project: basename(p) }))
}

/** Projects being removed now (lower-cased paths): one removal at a time each. */
const removing = new Set<string>()

/**
 * Hides, removes or deletes a project. Returns what couldn't be done after the point of no return (a Delete whose
 * folder is already in the Recycle Bin but a worktree or handover couldn't follow), for the user to see.
 */
export async function removeProject(projectPath: string, how: ProjectRemoval): Promise<{ warnings: string[] }> {
  const ws = workspace
  const p = folderOf(ws, projectPath)
  const name = basename(p)
  const key = p.toLowerCase()
  if (removing.has(key)) throw new Error(tr(msg({ id: 'main.removal.already', defaultMessage: '{project} is already being removed.', description: 'An error: the project is being removed, hidden or deleted already.' }), { project: name }))
  // Refused at once, before stopping anything, when it can already tell.
  if (how === 'remove') {
    const early = unmergedWork((await removalInfo(p)).worktrees)
    if (early) throw new Error(early)
  }
  removing.add(key)
  // No agent of the project may start from here on (the Assistant, a card, a hand-over…).
  const unfence = sessions.fenceStarts(p)
  try {
    await stopAgents(p)
    // Looked at again now nothing runs there: a stopping agent may have written to its worktree at the last moment.
    const info = await removalInfo(p)
    const agents = projectAgents(await ws.projectConfig(p))
    if (how === 'hide') {
      ws.setActive(p, false)
      await archiveProjectCards(ws, name, 'project-hidden')
      await ws.setHidden(name, 'hidden')
      log.info(`Hid ${userText(name)}`)
      return { warnings: [] }
    }
    // Its merge queues go with it (#1360): this Hive's runners released, their worktrees and records removed.
    await forgetProjectQueues({ store: FactStore.forBoard(ws, { project: name, key: name }), project: p, root: join(ws.worktreesRoot, name), locked: (fn) => boardWrite(ws, async () => fn()) }).catch((e) => log.warn(`removing ${userText(name)}'s merge queue folders`, e))
    const done = how === 'remove' ? await removeFromCombwork(ws, p, info, agents) : await deleteProject(ws, p, info, agents)
    // Its agents' terminals' kept sizes and output go with it (#489); a hidden project keeps them.
    forgetPtys(agentPtyKey(p, ''))
    return done
  } finally {
    unfence()
    removing.delete(key)
    // Its sessions' records, written into its folder, stay there now it is hidden as removed (#1061), or come back if it isn't.
    if (how === 'remove') await ws.releaseSessions(p).catch((e) => log.warn('after writing the sessions into the folder', e))
    await ws.refresh().catch((e) => log.warn('refresh after removing a project', e))
  }
}

async function removeFromCombwork(ws: WorkspaceService, p: string, info: ProjectRemovalInfo, agents: AgentDef[]): Promise<{ warnings: string[] }> {
  const name = basename(p)
  const held = unmergedWork(info.worktrees)
  if (held) throw new Error(held)
  const { ok, refused } = await checkedWorktrees(ws, p, agents)
  if (refused.length) throw new Error(tr(msg({ id: 'main.removal.wontRemove', defaultMessage: "Combwork won't remove {worktrees}. Fix or remove that agent first.", description: "Why Remove from Combwork refused: agents' worktrees it won't remove. {worktrees} lists them, joined with “or” (main.removal.refusedTree)." }), { worktrees: fmt.list(refused, 'disjunction') }))
  // Packed first: everything after it can be undone from the pack.
  await pack(ws, p, info.handovers)
  // Its sessions' records too (#1061): out of the workspace's database, into its folder, which takes them wherever it goes.
  await ws.exportSessions(p)
  // Its slots and copies (#1447): through their pools' guarded clean-up; what is kept stays, said in the result.
  const folders = await removeFolders(ws, p, true)
  // The worktrees have nothing left that isn't in the project: they and their agents go.
  for (const a of ok) await wt.removeWorktree(p, legacyWorktree(a)!, true)
  if (ok.length) {
    const gone = new Set(ok.map((a) => a.id))
    await ws.mutateProjectConfig(p, (now) => ({ agents: now.agents.filter((a) => !gone.has(a.id)) }))
  }
  ws.setActive(p, false)
  await archiveProjectCards(ws, name, 'project-removed')
  const warnings: string[] = []
  for (const rel of info.handovers) {
    await trash(join(ws.sharedDir, rel)).catch((e) => {
      log.warn(`Could not move ${userText(rel)} to the Recycle Bin`, e)
      warnings.push(tr(msg({ id: 'main.removal.handoverKept', defaultMessage: '{note} stayed in the shared notes (a copy is packed in the folder): {why}', description: "A warning after Remove from Combwork: a handover note couldn't be moved to the Recycle Bin. {note} is its path, {why} the system's message." }), { note: rel, why: (e as Error).message }))
    })
  }
  await ws.setHidden(name, 'removed')
  log.info(`Removed ${userText(name)} from Combwork (packed ${info.handovers.length} handovers and its cards)`)
  return { warnings: [...keptWarnings(folders), ...warnings] }
}

async function deleteProject(ws: WorkspaceService, p: string, info: ProjectRemovalInfo, agents: AgentDef[]): Promise<{ warnings: string[] }> {
  const name = basename(p)
  // Its slots, copies and old folders (#1447, HR1's round 1): refused before anything is done if one is outside the
  // project's worktrees folder or held by one of Hive's steps; the rest go to the Recycle Bin after the folder.
  const folders = await projectFolders(ws, p)
  // Its id now: its project.json goes with the folder (the slots' rows are kept by it).
  const id = (await ws.projectConfig(p)).id ?? name
  const blocked = (items: string[]): Error => new Error(tr(msg({ id: 'main.removal.deleteBlocked', defaultMessage: "Delete can't go ahead: {folders}. Nothing was deleted.", description: "Why Delete refused (#1447): the project's slots or old folders that stop it ({folders}: each one's name and why, a list). Nothing was changed." }), { folders: fmt.list(items) }))
  const blocks = await deleteBlocks(ws, p, folders)
  if (blocks.size) throw blocked(folders.filter((f) => blocks.has(f.key)).map((f) => `${folderWhat(f.of)} (${blocks.get(f.key)})`))
  // Then held, in one write against the rows as they are then (HR1's round 2): no step of any Hive begins on the
  // project's slots or copies, nor makes one, until Delete has finished with them or let them go.
  const token = `d-${randomBytes(8).toString('hex')}`
  const { holder } = await import('./slotsApp')
  holder.live.add(token)
  let held = false
  try {
    const refusal = await reserveDelete(ws, id, folders, token, await holder.self())
    if (refusal) throw blocked(reserveRefusal(folders, refusal))
    held = true
    const { ok, refused } = await checkedWorktrees(ws, p, agents)
    const trees = ok.map((a) => legacyWorktree(a)!.path).filter((t) => existsSync(t))
    // The folder first: it is what Windows most often can't move (a program has it open), and until it has gone
    // nothing else is touched, so a refusal leaves the project as it was (its slots let go, below).
    const resume = suspendWatching([p, ...trees])
    // The platform watcher's too (#1214), until the worktrees have gone as well; a refresh then stops following them.
    const resumeObserving = observer.suspend([p, ...trees])
    try {
      await trash(p)
    } catch (e) {
      resume()
      resumeObserving()
      throw new Error(
        tr(msg({ id: 'main.removal.trashFailed', defaultMessage: 'Could not move {project} to the Recycle Bin: {why}. Close any program using its folder (a terminal, an editor), then try again. Nothing was deleted.', description: "Why Delete failed: the project's folder couldn't go to the Recycle Bin. {why} is the system's message." }), { project: name, why: (e as Error).message }),
        { cause: e }
      )
    }
    // From here the project is gone: what can't follow is reported, not undone.
    const warnings = refused.map((r) => tr(msg({ id: 'main.removal.leftAlone', defaultMessage: 'Left alone: {worktree}.', description: "A warning after Delete: an agent's worktree Combwork didn't delete with the project (main.removal.refusedTree)." }), { worktree: r }))
    // Its slots, copies and old folders follow it to the Recycle Bin, with their work (#1447), their rows with the hold.
    warnings.push(...(await trashFolders(ws, p, id, folders, token, trash)))
    held = false
    return await deleteRest(ws, p, info, name, trees, warnings, resumeObserving)
  } finally {
    if (held) await releaseDelete(ws, id, token).catch((e) => log.warn(`Deleting ${userText(name)}: its slots' hold couldn't be let go (the next refresh does)`, e))
    holder.live.delete(token)
  }
}

/** Delete's steps after the project's folder and slots have gone: its agents' worktrees, handovers, cards and records. */
async function deleteRest(ws: WorkspaceService, p: string, info: ProjectRemovalInfo, name: string, trees: string[], warnings: string[], resumeObserving: () => void): Promise<{ warnings: string[] }> {
  for (const t of trees) {
    await trash(t).catch((e) => warnings.push(tr(msg({ id: 'main.removal.notTrashed', defaultMessage: "{path} couldn't be moved to the Recycle Bin: {why}", description: "A warning after Delete: a worktree or handover note of the project couldn't go to the Recycle Bin. {path} is it, {why} the system's message." }), { path: t, why: (e as Error).message })))
  }
  resumeObserving()
  for (const rel of info.handovers) {
    await trash(join(ws.sharedDir, rel)).catch((e) => warnings.push(tr(msg({ id: 'main.removal.notTrashed', defaultMessage: "{path} couldn't be moved to the Recycle Bin: {why}", description: "A warning after Delete: a worktree or handover note of the project couldn't go to the Recycle Bin. {path} is it, {why} the system's message." }), { path: rel, why: (e as Error).message })))
  }
  await deleteProjectCards(ws, name).catch((e) => warnings.push(tr(msg({ id: 'main.removal.cardsKept', defaultMessage: "Its cards couldn't all be deleted: {why}", description: "A warning after Delete: some of the project's cards stayed. {why} is the system's message." }), { why: (e as Error).message })))
  // The project's empty folder of worktrees.
  const treesDir = join(ws.worktreesRoot, name)
  if (existsSync(treesDir) && !(await readdir(treesDir).catch(() => ['?'])).length) await rmdir(treesDir).catch(() => undefined)
  if ((ws.config.hiddenProjects ?? []).some((h) => same(h.name, name))) await ws.setHidden(name, null)
  config.update((c) => {
    if (ws.path && c.activeProjects[ws.path]) c.activeProjects[ws.path] = c.activeProjects[ws.path].filter((n) => !same(n, name))
  })
  for (const w of warnings) log.warn(`Deleting ${userText(name)}: ${userText(w)}`)
  log.info(`Deleted ${userText(name)} (to the Recycle Bin)`)
  return { warnings }
}

interface Manifest {
  version: 1
  at: string
  /** The workspace it was removed from: restoring there brings back the archived cards rather than copies. */
  workspace: string
  project: string
  handovers: number
  cards: number
}

/** Writes the project's handovers and cards into <project>/.combwork/removed, with a manifest. */
async function pack(ws: WorkspaceService, p: string, handovers: string[]): Promise<void> {
  const dir = join(p, CW_DIR, REMOVED_DIR)
  // An older pack (removed before, restored without unpacking) makes way for this one.
  await removePath(dir)
  await mkdir(join(dir, 'handovers'), { recursive: true })
  for (const rel of handovers) await copyFile(join(ws.sharedDir, rel), join(dir, 'handovers', basename(rel)))
  const cards = await projectCards(ws, basename(p))
  await writeJsonAtomic(join(dir, 'cards.json'), cards)
  const manifest: Manifest = { version: 1, at: new Date().toISOString(), workspace: ws.path!, project: basename(p), handovers: handovers.length, cards: cards.length }
  await writeJsonAtomic(join(dir, 'manifest.json'), manifest)
}

/**
 * Where a packed handover goes back: its own name, unless a different note took that name meanwhile; then
 * "<name>-restored.md" (-restored-2…). Null when the same note is already there.
 */
async function restoreTarget(dir: string, f: string, text: string): Promise<string | null> {
  const stem = f.slice(0, f.length - extname(f).length)
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? f : `${stem}-restored${n === 2 ? '' : `-${n - 1}`}${extname(f)}`
    const target = join(dir, name)
    if (!existsSync(target)) return target
    if ((await readFile(target, 'utf8').catch(() => null)) === text) return null
  }
  throw new Error(tr(msg({ id: 'main.removal.tooManyNames', defaultMessage: 'Too many handovers named like {note}', description: "Why restoring a project's handovers stopped: a thousand notes have its name already." }), { note: f }))
}

/**
 * Puts back what Remove from Hive packed: handovers into the shared notes (never over a different note: that one
 * keeps its name and the packed one comes back beside it), and the cards: in the workspace it was removed from,
 * the archived ones come back; anywhere else, copies with new numbers. The pack is deleted only once all is back.
 */
async function unpack(ws: WorkspaceService, p: string): Promise<{ handovers: number; cards: number }> {
  const dir = join(p, CW_DIR, REMOVED_DIR)
  const manifest = await readJson<Partial<Manifest> | null>(join(dir, 'manifest.json'), null)
  if (!manifest) return { handovers: 0, cards: 0 }
  let handovers = 0
  const target = join(ws.sharedDir, 'handovers')
  await mkdir(target, { recursive: true })
  for (const f of await readdir(join(dir, 'handovers')).catch(() => [] as string[])) {
    const text = await readFile(join(dir, 'handovers', f), 'utf8')
    const to = await restoreTarget(target, f, text)
    if (to) await copyFile(join(dir, 'handovers', f), to)
    handovers++
  }
  const name = basename(p)
  let cards: number
  if (manifest.workspace && ws.path && same(manifest.workspace, ws.path) && (await projectCards(ws, name)).length) cards = await restoreProjectCards(ws, name)
  else cards = await importCards(ws, (await readJson<TaskCard[]>(join(dir, 'cards.json'), [])).filter((c) => c && typeof c === 'object'), name)
  await removePath(dir)
  return { handovers, cards }
}

/** Brings a hidden or removed project back (Settings → Workspace → Projects). */
export async function restoreProject(name: string): Promise<{ handovers: number; cards: number }> {
  const ws = workspace
  const entry = (ws.config.hiddenProjects ?? []).find((h) => same(h.name, name))
  if (!entry) throw new Error(tr(msg({ id: 'main.removal.notHidden', defaultMessage: "{project} isn't hidden or removed.", description: 'An error restoring a project (Settings → Workspace → Projects): it is shown already.' }), { project: name }))
  const p = join(ws.path!, entry.name)
  if (!existsSync(p)) throw new Error(tr(msg({ id: 'main.removal.folderGone', defaultMessage: 'The folder {folder} is no longer in the workspace. Put it back, or forget it.', description: 'An error restoring a project whose folder has gone. Forget is the button that stops listing it.' }), { folder: entry.name }))
  await ws.setHidden(entry.name, null)
  // If unpacking fails, the project is back and its pack stays: its banner offers to restore it again.
  const result = entry.mode === 'removed' && existsSync(join(p, CW_DIR, REMOVED_DIR)) ? await unpack(ws, p) : { handovers: 0, cards: await restoreProjectCards(ws, entry.name) }
  await ws.ensureProject(p)
  log.info(`Restored ${userText(entry.name)}`)
  await ws.refresh()
  return result
}

/** A project folder holding a pack from Remove from Hive (moved here, or never unpacked): takes it in, or drops it. */
export async function takeRemovedData(projectPath: string, keep: boolean): Promise<{ handovers: number; cards: number }> {
  const ws = workspace
  const p = ws.assertProject(projectPath)
  const result = keep ? await unpack(ws, p) : { handovers: 0, cards: 0 }
  if (!keep) await removePath(join(p, CW_DIR, REMOVED_DIR))
  await ws.refresh()
  return result
}

/** Stops listing a hidden or removed project whose folder has gone from the workspace. */
export async function forgetHidden(name: string): Promise<void> {
  const ws = workspace
  const entry = (ws.config.hiddenProjects ?? []).find((h) => same(h.name, name))
  if (!entry) return
  if (existsSync(join(ws.path!, entry.name))) throw new Error(tr(msg({ id: 'main.removal.stillThere', defaultMessage: '{project} is still in the workspace: restore it instead.', description: 'An error forgetting a hidden project whose folder is still there.' }), { project: entry.name }))
  await ws.setHidden(entry.name, null)
  await ws.refresh()
}
