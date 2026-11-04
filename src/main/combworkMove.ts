import { existsSync, readdirSync, statSync } from 'original-fs'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'original-fs/promises'
import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import { HIVE_DIR } from '../shared/defaults'
import { ASSISTANT_DIR } from '../shared/assistant'
import { LEGACY_HIVE_DIR, movedExcludeText, movedPathOf, rewriteMovedPaths, type FolderMove } from '../shared/hiveFolderMove'
import { msg, tr, type Msg } from '../shared/i18n'
import { toast } from './events'
import { readKeptJson, realPath, writeKeptJson, writeTextAtomic } from './fsutil'
import { git } from './git'
import { HiveError, errorText, hiveError } from './hiveError'
import { excludeLine, gitDirOf, vcsOf } from './hiveVcs'
import { createLogger, userText } from './logger'
import { othersPresentByProcess } from './presence'
import { dataFolder, ours, type HostKind } from './hiveFolder'
import { withNamedLock } from './repoLock'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import type { CardsAnswer, CardsRewrite } from './hiveMoveWorker'

/**
 * The move of a workspace's `.hive` folders to `.combwork` (HI-2462, SPEC §4.3; the design is the card's, HI-2462/s21).
 * Each host (the workspace, its Assistant's home inside it, each project folder the workspace lists) has one folder of
 * Combwork's; from 1.1 it is `.combwork`. When a workspace opens, before anything reads it, each host's `.hive` of ours
 * (one holding project.json, workspace.json or hive.db) is renamed: one atomic rename, never a copy, so nothing is
 * half-moved or lost.
 *
 * - **Ownership**: the whole move holds a lock across processes (repoLockCore's row, by token, pid and process start, in
 *   `<workspace>\.combwork-move.lock`, outside every folder that moves, kept for good), and refuses while another
 *   process's presence marker is fresh. The workspace's folder is renamed first: a Hive holding its board open makes
 *   that fail before any project is touched.
 * - **Durable**: the plan (`combwork-move.json`) is written before the first rename, in the tree in use (`.hive` while it
 *   is ours and alone, moving with it; else `.combwork`), and each host gets this plan's id (`combwork-move-id`) in its
 *   folder before its rename, so a later open tells our move from anyone else's. Each phase after the renames is
 *   recorded done only once it worked; a phase that fails leaves the plan and refuses the open, which tries again next
 *   time.
 * - **Never moved**: another tool's `.hive`, a `.hive` beside a `.combwork` (both: `.combwork` is used, `.hive` left as it
 *   is, a warning), a linked `.hive`, a host whose real place is outside the workspace.
 * - **The map** (`combwork-moved.json`, kept for good): only the folders that really moved. Stored paths, links and a
 *   conversation's folder are translated through it alone (shared/hiveFolderMove.ts).
 */

const log = createLogger('hiveMove')

/** The lock's file, in the workspace folder itself: the one place that doesn't move. */
export const MOVE_LOCK_FILE = '.combwork-move.lock'
/** The plan while the move isn't finished. */
export const PLAN_FILE = 'combwork-move.json'
/** The folders that really moved: kept for good, for the paths stored before. */
export const MOVED_FILE = 'combwork-moved.json'
/** The id of the plan that moved a host's folder, written into it before its rename. */
export const MARK_FILE = 'combwork-move-id'

export type { HostKind }
/**
 * - `planned`: our `.hive`, alone: to move.
 * - `moved`: this plan's id is in its `.combwork` (a `.hive` made again beside it is someone else's, left as it is).
 * - `both`: our `.hive` beside a `.combwork` this plan didn't make: `.combwork` is used, `.hive` stays as it is.
 * - `foreign`: a `.hive` that isn't ours (no project.json, workspace.json or hive.db): never touched.
 * - `link`: a linked `.hive`, or a host outside the workspace: never moved.
 * - `current`: `.combwork` alone (fresh, or moved by hand or by another plan), or nothing.
 */
export type HostState = 'planned' | 'moved' | 'both' | 'foreign' | 'link' | 'current'

export interface PlanHost {
  host: string
  kind: HostKind
  state: HostState
}

export type Phase = 'excludes' | 'worktrees' | 'notes' | 'cards' | 'folders'
/** The phases that need nothing of the workspace's services: run before the open goes on. */
const EARLY: Phase[] = ['excludes', 'worktrees', 'notes']
/** Those that need its board and project services: run once they're up (finishMove). */
const LATE: Phase[] = ['cards', 'folders']

export interface MovePlan {
  version: 1
  id: string
  startedAt: string
  hosts: PlanHost[]
  /** The moves this plan made (old → new folder), for its phases. */
  moves: FolderMove[]
  /** The phases still to do. */
  pending: Phase[]
}

interface MovedFile {
  version: 1
  moves: FolderMove[]
}

const M = {
  locked: msg({ id: 'service.hiveMove.locked', defaultMessage: "Combwork couldn't move {folder} to .combwork: a program has a file in it open. Close that program (or the other Combwork or Hive using this workspace), then open the workspace again. Nothing was lost.", description: "An error opening a workspace (HI-2462): its .hive folder, renamed .combwork in this version, couldn't be renamed because a file in it is open. {folder} is the folder. Keep .hive and .combwork as they are (folder names)." }),
  otherOpen: msg({ id: 'service.hiveMove.otherOpen', defaultMessage: 'This workspace is open in another Combwork or Hive ({profile}). Close it there, then open it here: Combwork moves its .hive folders to .combwork first.', description: "An error opening a workspace (HI-2462): another copy of the app ({profile}: its profile folder's name) has it open, so its .hive folders can't be renamed .combwork now. Keep .hive and .combwork as they are." }),
  busy: msg({ id: 'service.hiveMove.busy', defaultMessage: "Another Combwork is moving this workspace's .hive folders to .combwork ({profile}). Open it again once it has finished.", description: "An error opening a workspace (HI-2462): another copy of the app ({profile}: its profile folder's name) is renaming the workspace's .hive folders to .combwork now. Keep .hive and .combwork as they are." }),
  phase: msg({ id: 'service.hiveMove.phaseFailed', defaultMessage: "Combwork moved this workspace's .hive folders to .combwork, but couldn't finish updating {what}: {error} Open the workspace again to finish.", description: "An error opening a workspace (HI-2462): its .hive folders were renamed .combwork, but a step after that failed; the next open finishes it. {what} is what it was updating (main.hiveMove.what.*); {error} says why, a sentence. Keep .hive and .combwork as they are." }),
  closed: msg({ id: 'service.hiveMove.closed', defaultMessage: "The workspace was closed while Combwork was moving its .hive folders to .combwork. Open it again to finish.", description: 'An error opening a workspace (HI-2462): it was closed, or another was opened in its window, during the rename of its .hive folders to .combwork. Keep .hive and .combwork as they are.' }),
  bothTitle: msg({ id: 'main.hiveMove.bothTitle', defaultMessage: '{folder} has both a .hive and a .combwork folder', description: "A warning's title as a workspace opens (HI-2462): the folder {folder} has Combwork's folder under both its old name (.hive) and its new one (.combwork). Keep .hive and .combwork as they are." }),
  bothBody: msg({ id: 'main.hiveMove.bothBody', defaultMessage: 'Combwork uses .combwork and leaves .hive as it is. Move anything you still need out of .hive yourself.', description: "The warning's text (HI-2462): which of the two folders Combwork uses, and that it never changes the other. Keep .hive and .combwork as they are." }),
  linkTitle: msg({ id: 'main.hiveMove.linkTitle', defaultMessage: "{folder}'s .hive folder wasn't moved", description: "A warning's title as a workspace opens (HI-2462): the folder {folder}'s .hive wasn't renamed .combwork. Keep .hive and .combwork as they are." }),
  linkBody: msg({ id: 'main.hiveMove.linkBody', defaultMessage: "It is a link to another folder, or the project is a link to a folder outside the workspace, so Combwork leaves it as it is. To use it, rename it .combwork yourself with Combwork closed.", description: "The warning's text (HI-2462): why the .hive folder wasn't renamed, and how the user can do it. Keep .hive and .combwork as they are." }),
  what: {
    excludes: msg({ id: 'main.hiveMove.what.excludes', defaultMessage: "git's exclude lines", description: 'What the folder move was updating when it failed (service.hiveMove.phaseFailed): the lines that keep the folder out of git.' }),
    worktrees: msg({ id: 'main.hiveMove.what.worktrees', defaultMessage: 'the worktrees inside it', description: 'What the folder move was updating when it failed (service.hiveMove.phaseFailed): git worktrees kept inside the moved folder.' }),
    notes: msg({ id: 'main.hiveMove.what.notes', defaultMessage: 'the paths in shared notes and handovers', description: 'What the folder move was updating when it failed (service.hiveMove.phaseFailed).' }),
    cards: msg({ id: 'main.hiveMove.what.cards', defaultMessage: 'the paths in cards', description: 'What the folder move was updating when it failed (service.hiveMove.phaseFailed): links and paths in cards\' descriptions and comments.' }),
    folders: msg({ id: 'main.hiveMove.what.folders', defaultMessage: "the agents' folders inside it", description: "What the folder move was updating when it failed (service.hiveMove.phaseFailed): slots and other agents' folders kept inside the moved folder." })
  } satisfies Record<Phase, Msg<string>>
}

const legacy = (host: string): string => join(host, LEGACY_HIVE_DIR)
const current = (host: string): string => join(host, HIVE_DIR)
const lower = (p: string): string => resolve(p).toLowerCase()
const under = (p: string, root: string): boolean => {
  const a = lower(p)
  const r = lower(root).replace(/[\\/]+$/, '')
  return a === r || a.startsWith(r + '\\')
}

/** A host's own folder, not a link (a symlink or junction) to somewhere else: its real place is inside the host's. */
async function plainFolder(host: string, dir: string): Promise<boolean> {
  const st = await lstat(dir).catch(() => null)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  return realPath(dir).toLowerCase() === join(realPath(host), LEGACY_HIVE_DIR).toLowerCase()
}

const markOf = async (dir: string): Promise<string | null> => (await readFile(join(dir, MARK_FILE), 'utf8').catch(() => '')).trim() || null

/** What a host's folders are, judged against a plan (its id) or none. */
export async function classify(ws: string, host: string, kind: HostKind, planId: string | null): Promise<HostState> {
  const oldDir = legacy(host)
  const newDir = current(host)
  const hasOld = existsSync(oldDir)
  const hasNew = existsSync(newDir)
  if (hasNew && planId && (await markOf(newDir)) === planId) return 'moved'
  if (!hasOld) return 'current'
  // The workspace's own folder is the workspace; a project or the Assistant's home must really be inside it.
  if (kind !== 'workspace' && !under(realPath(host), realPath(ws))) return 'link'
  if (!(await plainFolder(host, oldDir))) return 'link'
  const kindOurs = ours(oldDir, kind)
  if (!kindOurs) return 'current'
  return hasNew ? 'both' : 'planned'
}

/** The hosts the workspace has: itself, its Assistant's home, and every folder it lists as a project (hidden ones too). */
export function hostsOf(ws: string, assistantHome: string): { host: string; kind: HostKind }[] {
  const out: { host: string; kind: HostKind }[] = [{ host: ws, kind: 'workspace' }, { host: assistantHome, kind: 'assistant' }]
  let names: string[] = []
  try {
    names = readdirSync(ws, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => e.name)
  } catch {
    // Not readable: the open says so.
  }
  for (const n of names) out.push({ host: join(ws, n), kind: 'project' })
  return out
}

/** The Assistant's home in a workspace, wherever its outer folder is now. */
const assistantOf = (ws: string): string => join(existsSync(current(ws)) || !existsSync(legacy(ws)) ? current(ws) : legacy(ws), ASSISTANT_DIR)

/** The workspace's tree in use: `.combwork` once there, else its own `.hive`, else `.combwork` (to be made). */
export const treeOf = (ws: string): string => dataFolder(ws, 'workspace')

/** Every move recorded for a workspace (the kept map, and a plan still under way), by its lowercased path. */
const movedCache = new Map<string, { at: number; stamp: string; moves: FolderMove[] }>()

const stampOf = (f: string): string => {
  try {
    const s = statSync(f)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return '-'
  }
}

/** The folders that moved in a workspace: what stored paths into them are translated through. Empty when none did. */
export async function movedFolders(ws: string): Promise<FolderMove[]> {
  const tree = treeOf(ws)
  const files = [join(tree, MOVED_FILE), join(tree, PLAN_FILE)]
  const stamp = files.map(stampOf).join('|')
  const key = lower(ws)
  const kept = movedCache.get(key)
  if (kept && kept.stamp === stamp) return kept.moves
  const moved = await readKeptJson<Partial<MovedFile>>(files[0], {})
  const plan = await readKeptJson<Partial<MovePlan>>(files[1], {})
  const all = [...(Array.isArray(moved.moves) ? moved.moves : []), ...(Array.isArray(plan.moves) ? plan.moves : [])].filter((m): m is FolderMove => !!m && typeof m.from === 'string' && typeof m.to === 'string')
  const seen = new Set<string>()
  const moves = all.filter((m) => !seen.has(m.from.toLowerCase()) && !!seen.add(m.from.toLowerCase()))
  movedCache.set(key, { at: Date.now(), stamp, moves })
  if (movedCache.size > 50) movedCache.delete(movedCache.keys().next().value!)
  return moves
}

/** Where a path stored before the move is now, through its workspace's map; null when it didn't move. */
export async function movedPath(ws: string, p: string): Promise<string | null> {
  return movedPathOf(p, await movedFolders(ws))
}

/** The moves a host's rename makes: its folder, and for the workspace the Assistant's inner one inside it too. */
function movesOf(ws: string, host: string, kind: HostKind): FolderMove[] {
  if (kind === 'assistant') {
    const inner = join(ASSISTANT_DIR, LEGACY_HIVE_DIR)
    // The home's old path, under either outer folder (the workspace's may have moved first).
    return [
      { from: join(legacy(ws), inner), to: join(current(ws), ASSISTANT_DIR, HIVE_DIR) },
      { from: join(current(ws), inner), to: join(current(ws), ASSISTANT_DIR, HIVE_DIR) }
    ]
  }
  return [{ from: legacy(host), to: current(host) }]
}

/** Windows refuses to rename a folder with a file in it open: these say so. */
const isLocked = (e: unknown): boolean => ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '')

/** Test hooks: a stop after a step (an injected crash), and a wait as a contender has looked (the race test). */
export const moveTestHooks: { after?: (step: string) => void | Promise<void>; looked?: () => Promise<void> } = {}

/** A rename, tried again a few times while the folder is held (an antivirus's or indexer's moment), then refused as locked. */
async function renameFolder(from: string, to: string): Promise<void> {
  const waits = [50, 150, 400, 800]
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      if (!isLocked(e) || i >= waits.length) throw e
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
}

export interface MoveOptions {
  /** The open's lifetime: aborted, the move stops between steps (each one either happened or didn't). */
  signal?: AbortSignal
  /** Whether the open is still this window's (its generation): false, the move stops between steps. */
  stillOurs?: () => boolean
}

export interface MoveOutcome {
  /** The late phases are still to do (finishMove, once the board is up). */
  late: boolean
  moved: number
}

/** Per workspace, one move at a time in this process: the open's and a late project's take turns. */
const chains = new Map<string, Promise<unknown>>()

function inTurn<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const key = lower(ws)
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  const settled = run.catch(() => undefined)
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return run
}

/** Whether anything is left to move: a plan under way, or a host with our `.hive` alone. */
async function anyToMove(ws: string, hosts: { host: string; kind: HostKind }[]): Promise<boolean> {
  if (existsSync(join(legacy(ws), PLAN_FILE)) || existsSync(join(current(ws), PLAN_FILE))) return true
  for (const h of hosts) if ((await classify(ws, h.host, h.kind, null)) === 'planned') return true
  return false
}

const warned = new Set<string>()

/** Says once per run of the app for each host that it has both folders, or a linked one. */
function warn(host: string, state: HostState): void {
  const key = `${state}:${lower(host)}`
  if (warned.has(key)) return
  warned.add(key)
  if (state === 'both') {
    log.warn(`${userText(host)} has both .hive and .combwork: .combwork is used, .hive is left as it is`)
    toast('warning', tr(M.bothTitle, { folder: host }), tr(M.bothBody))
  } else if (state === 'link') {
    log.warn(`${userText(host)}'s .hive is a link, or the project is outside the workspace: it isn't moved`)
    toast('warning', tr(M.linkTitle, { folder: host }), tr(M.linkBody))
  }
}

/**
 * Moves a workspace's folders, before anything reads them (WorkspaceService.opened): the whole move, or what is left
 * of an earlier one. `only`: a single host (a project that came into the open workspace later, ensureProject).
 * Throws a HiveError (translated, naming the folder) when it can't, nothing of that host changed.
 */
export function moveFolders(ws: string, o: MoveOptions & { only?: string } = {}): Promise<MoveOutcome> {
  return inTurn(ws, () => moveNow(resolve(ws), o))
}

async function moveNow(ws: string, o: MoveOptions & { only?: string }): Promise<MoveOutcome> {
  const all = hostsOf(ws, assistantOf(ws))
  const hosts = o.only ? all.filter((h) => lower(h.host) === lower(o.only!)) : all
  for (const h of hosts) {
    const s = await classify(ws, h.host, h.kind, null)
    if (s === 'both' || s === 'link') warn(h.host, s)
  }
  if (!(await anyToMove(ws, hosts))) return { late: false, moved: 0 }
  await moveTestHooks.looked?.()
  const stop = (): void => {
    if (o.signal?.aborted || (o.stillOurs && !o.stillOurs())) throw hiveError(M.closed, undefined, { kind: 'conflict' })
  }
  return withNamedLock(ws, MOVE_LOCK_FILE, () => movedUnderLock(ws, hosts, o, stop), { waitMs: 0, busy: (h) => hiveError(M.busy, { profile: h.profile }, { kind: 'conflict' }) })
}

/** Reads the plan under way, wherever it is now (it moves with the workspace's folder). */
async function planNow(ws: string): Promise<{ plan: MovePlan; file: string } | null> {
  for (const dir of [current(ws), legacy(ws)]) {
    const file = join(dir, PLAN_FILE)
    if (!existsSync(file)) continue
    const plan = await readKeptJson<MovePlan | null>(file, null, { unsettled: 'throw' })
    if (plan && plan.version === 1 && typeof plan.id === 'string' && Array.isArray(plan.hosts)) return { plan, file }
  }
  return null
}

async function savePlan(ws: string, plan: MovePlan): Promise<void> {
  const tree = treeOf(ws)
  await mkdir(tree, { recursive: true })
  await writeKeptJson(join(tree, PLAN_FILE), plan)
}

/** Adds moves to the kept map (in the tree in use). */
async function recordMoves(ws: string, moves: FolderMove[]): Promise<void> {
  if (!moves.length) return
  const file = join(treeOf(ws), MOVED_FILE)
  const had = await readKeptJson<Partial<MovedFile>>(file, {}, { unsettled: 'throw' })
  const list = Array.isArray(had.moves) ? [...had.moves] : []
  for (const m of moves) if (!list.some((x) => x.from.toLowerCase() === m.from.toLowerCase())) list.push(m)
  await writeKeptJson(file, { version: 1, moves: list } satisfies MovedFile)
}

async function movedUnderLock(ws: string, hosts: { host: string; kind: HostKind }[], o: MoveOptions & { only?: string }, stop: () => void): Promise<MoveOutcome> {
  stop()
  // Inside the lock, everything is looked at again: another process may have moved it meanwhile.
  for (const dir of [legacy(ws), current(ws)]) {
    const others = othersPresentByProcess(dir)
    if (others.length) throw hiveError(M.otherOpen, { profile: others[0].profile }, { kind: 'conflict' })
  }
  const found = await planNow(ws)
  const plan: MovePlan = found?.plan ?? { version: 1, id: randomUUID(), startedAt: new Date().toISOString(), hosts: [], moves: [], pending: [...EARLY, ...LATE] }
  // A late host joins a finished plan's map as a plan of its own; its phases are its own. The Assistant's home is one
  // host wherever it is: it follows its outer folder (inside the workspace's, which may have moved since the plan).
  const key = (h: { host: string; kind: HostKind }): string => (h.kind === 'assistant' ? 'assistant' : lower(h.host))
  for (const h of plan.hosts) if (h.kind === 'assistant') h.host = assistantOf(ws)
  const byHost = new Map(plan.hosts.map((h) => [key(h), h]))
  const now = o.only ? hosts : hostsOf(ws, assistantOf(ws))
  for (const h of now) {
    if (byHost.has(key(h))) continue
    const ph: PlanHost = { host: h.host, kind: h.kind, state: 'current' }
    plan.hosts.push(ph)
    byHost.set(key(h), ph)
  }
  // Every host of the plan judged again, as it is now, against this plan.
  for (const h of plan.hosts) h.state = await classify(ws, h.host, h.kind, plan.id)
  const toMove = plan.hosts.filter((h) => h.state === 'planned')
  if (!toMove.length && !found) return { late: false, moved: 0 }
  // The plan and each host's mark before the first rename: a crash after any rename is recovered from them.
  for (const h of toMove) await writeFile(join(legacy(h.host), MARK_FILE), plan.id, 'utf8')
  await savePlan(ws, plan)
  await moveTestHooks.after?.('planned')
  stop()
  // The workspace first: a Hive with its board open fails it here, before any project is touched; then its Assistant's
  // home (inside it), then the projects.
  const order = (k: HostKind): number => (k === 'workspace' ? 0 : k === 'assistant' ? 1 : 2)
  let moved = 0
  for (const h of [...toMove].sort((a, b) => order(a.kind) - order(b.kind))) {
    stop()
    // The Assistant's home's path follows the workspace's folder, moved just now.
    const host = h.kind === 'assistant' ? assistantOf(ws) : h.host
    h.host = host
    if ((await classify(ws, host, h.kind, plan.id)) !== 'planned') continue
    try {
      await renameFolder(legacy(host), current(host))
    } catch (e) {
      if (isLocked(e)) throw hiveError(M.locked, { folder: legacy(host) }, { kind: 'conflict' })
      throw e
    }
    h.state = 'moved'
    moved++
    const ms = movesOf(ws, host, h.kind)
    plan.moves.push(...ms.filter((m) => !plan.moves.some((x) => x.from.toLowerCase() === m.from.toLowerCase())))
    await savePlan(ws, plan)
    await recordMoves(ws, ms)
    log.info(`Moved ${userText(legacy(host))} to .combwork`)
    await moveTestHooks.after?.(`renamed:${h.kind}`)
  }
  // Earlier phases, those that need nothing else.
  for (const phase of EARLY) {
    if (!plan.pending.includes(phase)) continue
    stop()
    try {
      await runEarly(ws, plan, phase)
    } catch (e) {
      log.warn(`the folder move's ${phase}`, e)
      throw hiveError(M.phase, { what: M.what[phase], error: errorText(e) }, { kind: 'conflict' })
    }
    plan.pending = plan.pending.filter((p) => p !== phase)
    await savePlan(ws, plan)
    await moveTestHooks.after?.(`phase:${phase}`)
  }
  const late = plan.pending.some((p) => LATE.includes(p))
  if (!late) await finished(ws)
  return { late, moved }
}

/** The plan is done: its file goes; the map stays. */
async function finished(ws: string): Promise<void> {
  for (const dir of [current(ws), legacy(ws)]) {
    const f = join(dir, PLAN_FILE)
    if (!existsSync(f)) continue
    const { rm } = await import('original-fs/promises')
    await rm(f, { force: true })
    await rm(`${f}.bak`, { force: true })
  }
  log.info(`The move of ${userText(ws)}'s folders to .combwork has finished`)
}

const movedProjects = (plan: MovePlan): PlanHost[] => plan.hosts.filter((h) => h.state === 'moved' && h.kind === 'project')

async function runEarly(ws: string, plan: MovePlan, phase: Phase): Promise<void> {
  if (phase === 'excludes') for (const h of movedProjects(plan)) await moveExcludeLine(h.host)
  else if (phase === 'worktrees') for (const h of movedProjects(plan)) await repairWorktrees(h.host, plan.moves)
  else if (phase === 'notes') await rewriteNotes(join(current(ws), 'shared'), plan.moves)
}

/** Hive's exclude line for a moved project's old folder, in its repository's info/exclude, for the new one. */
export async function moveExcludeLine(host: string): Promise<boolean> {
  const found = vcsOf(host)
  if (found?.kind !== 'git') return false
  const gd = await gitDirOf(found.root)
  if (!gd) return false
  const f = join(gd, 'info', 'exclude')
  const text = await readFile(f, 'utf8').catch(() => null)
  if (text === null) return false
  const newLine = excludeLine(found.root, host)
  const oldLine = newLine.replace(/\/\.combwork\/$/, `/${LEGACY_HIVE_DIR}/`)
  const next = movedExcludeText(text, oldLine, newLine, !existsSync(legacy(host)))
  if (next === text) return false
  await writeTextAtomic(f, next)
  return true
}

/** git's links to the worktrees that were inside a moved folder (its slots), made right again at their new place. */
export async function repairWorktrees(host: string, moves: FolderMove[]): Promise<number> {
  if (vcsOf(host)?.kind !== 'git') return 0
  const r = await git(host, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return 0
  const paths = r.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length).trim()))
  const fixed: string[] = []
  for (const p of paths) {
    const to = movedPathOf(p, moves)
    if (to && existsSync(to)) fixed.push(to)
  }
  if (!fixed.length) return 0
  const rep = await git(host, ['worktree', 'repair', ...fixed])
  if (!rep.ok) throw new Error(rep.err.split(/\r?\n/)[0] || `git worktree repair exited with ${rep.code}`) // i18n-ignore: git's own words, for the error's detail
  return fixed.length
}

/** The shared notes and handovers' paths into moved folders, each file written whole, only those that change. */
export async function rewriteNotes(dir: string, moves: FolderMove[]): Promise<number> {
  if (!moves.length || !existsSync(dir)) return 0
  let n = 0
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(d, { withFileTypes: true }).catch(() => null)
    for (const e of entries ?? []) {
      const p = join(d, e.name)
      if (e.isDirectory() && !e.isSymbolicLink()) await walk(p, depth + 1)
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        const text = await readFile(p, 'utf8')
        const next = rewriteMovedPaths(text, moves)
        if (next !== text) {
          await writeTextAtomic(p, next)
          n++
        }
      }
    }
  }
  await walk(dir, 0)
  return n
}

/** The worker's script, beside main's; in unit tests (no build) its code runs here. */
const workerScript = (): string => join(__dirname, 'hive-move-worker.js')

/** Rewrites the board's cards in the worker (hiveMoveWorker.ts). */
export async function rewriteCardsOffMain(job: CardsRewrite): Promise<CardsAnswer> {
  if (!bundledScriptExists(workerScript())) {
    workerHere('folder move', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
    const { rewriteCards } = await import('./hiveMoveWorker')
    return rewriteCards(job)
  }
  return new Promise((res) => {
    const w = new Worker(workerScript(), { workerData: job })
    workerStarted('folder move', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    let done = false
    w.once('message', (a: CardsAnswer) => {
      done = true
      res(a)
      void w.terminate()
    })
    w.once('error', (e: Error) => {
      if (!done) res({ ok: false, error: e.message })
      done = true
    })
    w.once('exit', (code) => {
      if (!done) res({ ok: false, error: `the worker ended (exit code ${code})` }) // i18n-ignore: for the error's detail
      done = true
    })
  })
}

/** What the late phases need of the open workspace. */
export interface LateServices {
  /** The board's file. */
  boardFile: string
  /** Each moved project's folders kept inside its old `.hive` moved to their new place: false when one can't be now. */
  relocateFolders: (projectPath: string, moves: FolderMove[]) => Promise<boolean>
}

/**
 * The phases that need the board and the project services, once they are up (the open's, after the projects' ids):
 * the cards' paths, then the agents' folders that were inside a moved folder. One that fails refuses the open; the
 * next open tries again from the plan.
 */
export function finishMove(ws: string, svc: LateServices, o: MoveOptions = {}): Promise<void> {
  return inTurn(ws, () => {
    const stop = (): void => {
      if (o.signal?.aborted || (o.stillOurs && !o.stillOurs())) throw hiveError(M.closed, undefined, { kind: 'conflict' })
    }
    return withNamedLock(ws, MOVE_LOCK_FILE, () => finishUnderLock(resolve(ws), svc, stop), { waitMs: 0, busy: (h) => hiveError(M.busy, { profile: h.profile }, { kind: 'conflict' }) })
  })
}

async function finishUnderLock(ws: string, svc: LateServices, stop: () => void): Promise<void> {
  const found = await planNow(ws)
  if (!found) return
  const plan = found.plan
  for (const phase of LATE) {
    if (!plan.pending.includes(phase)) continue
    stop()
    try {
      if (phase === 'cards') {
        const workspaceMoved = plan.hosts.some((h) => h.kind === 'workspace' && h.state === 'moved')
        const a = await rewriteCardsOffMain({ file: svc.boardFile, moves: plan.moves, workspaceMoved })
        if (!a.ok) throw new Error(a.error)
        // A board still to be upgraded: its cards are rewritten at a later open.
        if (a.deferred) continue
        log.info(`The folder move rewrote ${a.changed} card texts`)
      } else {
        for (const h of movedProjects(plan)) if (!(await svc.relocateFolders(h.host, plan.moves))) throw new Error(`a folder of ${h.host} is in use`) // i18n-ignore: the error's detail
      }
    } catch (e) {
      log.warn(`the folder move's ${phase}`, e)
      throw e instanceof HiveError ? e : hiveError(M.phase, { what: M.what[phase], error: errorText(e) }, { kind: 'conflict' })
    }
    plan.pending = plan.pending.filter((p) => p !== phase)
    await savePlan(ws, plan)
    await moveTestHooks.after?.(`phase:${phase}`)
  }
  if (!plan.pending.length) await finished(ws)
}

/**
 * Where an old link leads now, for a file that isn't there (HI-2462): through the map of each workspace given (only
 * folders that really moved), then through the older move of `.hive\images` to `attachments` (#387). Null when neither
 * leads anywhere. A path whose file is there is the caller's to open as it is: a `.hive` made again keeps its own files.
 */
export async function followMovedLink(p: string, workspaces: readonly string[], movedAttachment: (p: string) => Promise<string | null>): Promise<string | null> {
  let q: string | null = null
  for (const ws of workspaces) if ((q = await movedPath(ws, p))) break
  const at = q ?? p
  if (q && existsSync(q)) return q
  return (await movedAttachment(at)) ?? q
}

/** Whether a stored path (a conversation's folder) lies inside a folder that moved: its conversation can't resume there. */
export async function inMovedFolder(ws: string, p: string | undefined): Promise<boolean> {
  return !!p && (await movedPath(ws, p)) !== null
}
