import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'original-fs/promises'
import { createHash, randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import { CW_DIR } from '../shared/defaults'
import { ASSISTANT_DIR } from '../shared/assistant'
import { LEGACY_HIVE_DIR, movedExcludeText, movedPathOf, rewriteMovedPaths, type FolderMove } from '../shared/combworkFolderMove'
import { msg, tr, type Msg } from '../shared/i18n'
import { toast } from './events'
import { readKeptJson, realPath, writeKeptJson, writeTextAtomic } from './fsutil'
import { ifAbsent, lstatOrNullAsync, present } from './fsPresence'
import { relocationIn } from './platform/workspacePorts'
import { CombworkError, errorText, combworkError } from './combworkError'
import { vcsOf } from './vcsDetect'
import { excludeLine, gitDirOf } from './platform/gitKeepOut'
import { createLogger, userText } from './logger'
import { othersPresentByProcess } from './presence'
import { ours, type HostKind } from './combworkFolder'
import { withNamedLock } from './repoLock'
import { projectNamesDone, record as recordNames, upgradeWorkspace, workspaceNeeds } from './nameUpgrade'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'
import type { CardsAnswer, CardsRewrite, Checkpoint, CheckpointAnswer, CopyFolders, CopyFoldersAnswer } from './combworkMoveWorker'

/**
 * The move of a workspace's `.hive` folders to `.combwork` (HI-2462, SPEC §4.1.1; the design is the card's: HI-2462/s21,
 * and s65 for its state). Each host (the workspace, its Assistant's home inside it, each project folder the workspace
 * lists) has one folder of Combwork's; from 1.1 it is `.combwork`. When a workspace opens, before anything reads it,
 * each host's `.hive` of ours (one holding project.json, workspace.json or hive.db) is renamed: one atomic rename, never
 * a copy, so nothing is half-moved or lost.
 *
 * - **Ownership**: the move holds a lock across processes (repoLockCore's row, by token, pid and process start, in
 *   `<workspace>\.combwork-move.lock`, outside every folder that moves, kept for good), and refuses while another
 *   process's presence marker is fresh. The workspace's folder is renamed first: a 1.0 app holding its board open makes
 *   that fail before any project is touched.
 * - **State is on disk, never recorded beside it** (s65): before a host's `.hive` is renamed, a marker
 *   (`combwork-move-id`) is written in it, so it moves with the folder. A host has moved exactly when its `.combwork`
 *   holds the marker; the map of moves is derived from that on every open (deriveMoves), the Assistant's old outer path
 *   only from a workspace that moved. A crash anywhere leaves nothing to reconstruct.
 * - **The rewrites are keyed to the map**: when `combwork-moved.json` doesn't hold the hash of the map now, every phase
 *   runs again over all of it (each is idempotent), and the hash is written once the last has worked.
 * - **Never moved**: another tool's `.hive`, a `.hive` beside a `.combwork` with no marker (both: `.combwork` is used,
 *   `.hive` left as it is, a warning), a linked `.hive`, a host whose real place is outside the workspace. Stored paths,
 *   links and a conversation's folder are translated through the map alone (shared/combworkFolderMove.ts).
 */

const log = createLogger('combworkMove')

/** The lock's file, in the workspace folder itself: the one place that doesn't move. */
export const MOVE_LOCK_FILE = '.combwork-move.lock'
/** The map the rewrites last finished for (its hash and its moves), in the workspace's tree in use. */
export const MOVED_FILE = 'combwork-moved.json'
/** The marker of a host's folder that Combwork moved, written into it before its rename. */
export const MARK_FILE = 'combwork-move-id'

export type { HostKind }
/**
 * - `planned`: our `.hive`, alone: to move.
 * - `moved`: its `.combwork` holds the marker (a `.hive` beside it was made again afterwards: left as it is).
 * - `both`: our `.hive` beside a `.combwork` with no marker: `.combwork` is used, `.hive` stays as it is.
 * - `link`: a linked `.hive`, or a host outside the workspace: never moved.
 * - `current`: `.combwork` alone with no marker (fresh), another tool's `.hive`, or nothing.
 */
export type HostState = 'planned' | 'moved' | 'both' | 'link' | 'current'

export type Phase = 'excludes' | 'worktrees' | 'notes' | 'cards' | 'folders'
/** The phases that need nothing of the workspace's services: run before the open goes on. */
const EARLY: Phase[] = ['excludes', 'worktrees', 'notes']

interface MovedFile {
  version: 2
  hash: string
  moves: FolderMove[]
}

const M = {
  locked: msg({ id: 'service.combworkMove.locked', defaultMessage: "Combwork couldn't move {folder} to .combwork: a program has a file in it open. Close that program (or another Combwork, or a 1.0 copy, using this workspace), then open the workspace again. Nothing was lost.", description: "An error opening a workspace (HI-2462): its old data folder, renamed .combwork in this version, couldn't be renamed because a file in it is open. {folder} is the folder. A 1.0 copy: the app's version 1.0, from before it was renamed. Keep .combwork as it is (a folder name)." }),
  otherOpen: msg({ id: 'service.combworkMove.otherOpen', defaultMessage: 'This workspace is open in another Combwork or a 1.0 copy ({profile}). Close it there, then open it here: Combwork moves its old data folders to .combwork first.', description: "An error opening a workspace (HI-2462): another copy of the app ({profile}: its profile folder's name; a 1.0 copy: the app's version 1.0, from before it was renamed) has it open, so its old data folders can't be renamed .combwork now. Keep .combwork as it is." }),
  busy: msg({ id: 'service.combworkMove.busy', defaultMessage: "Another Combwork is moving this workspace's old data folders to .combwork ({profile}). Open it again once it has finished.", description: "An error opening a workspace (HI-2462): another copy of the app ({profile}: its profile folder's name) is renaming the workspace's old data folders to .combwork now. Keep .combwork as it is." }),
  phase: msg({ id: 'service.combworkMove.phaseFailed', defaultMessage: "Combwork moved this workspace's old data folders to .combwork, but couldn't finish updating {what}: {error} Open the workspace again to finish.", description: "An error opening a workspace (HI-2462): its old data folders were renamed .combwork, but a step after that failed; the next open finishes it. {what} is what it was updating (main.combworkMove.what.*); {error} says why, a sentence. Keep .combwork as it is." }),
  closed: msg({ id: 'service.combworkMove.closed', defaultMessage: "The workspace was closed while Combwork was moving its old data folders to .combwork. Open it again to finish.", description: 'An error opening a workspace (HI-2462): it was closed, or another was opened in its window, during the rename of its old data folders to .combwork. Keep .combwork as it is.' }),
  bothTitle: msg({ id: 'main.combworkMove.bothTitle', defaultMessage: '{folder} has both an old data folder and a .combwork folder', description: "A warning's title as a workspace opens (HI-2462): the folder {folder} has Combwork's folder under both its name from before 1.1 and its new one (.combwork). Keep .combwork as it is." }),
  bothBody: msg({ id: 'main.combworkMove.bothBody', defaultMessage: 'Combwork uses .combwork and leaves the old data folder as it is. Move anything you still need out of it yourself.', description: "The warning's text (HI-2462): which of the two folders Combwork uses, and that it never changes the other (the old one, from before 1.1). Keep .combwork as it is." }),
  linkTitle: msg({ id: 'main.combworkMove.linkTitle', defaultMessage: "{folder}'s old data folder wasn't moved", description: "A warning's title as a workspace opens (HI-2462): the folder {folder}'s data folder from before 1.1 wasn't renamed .combwork. Keep .combwork as it is." }),
  linkBody: msg({ id: 'main.combworkMove.linkBody', defaultMessage: "It is a link to another folder, or the project is a link to a folder outside the workspace, so Combwork leaves it as it is. To use it, rename it .combwork yourself with Combwork closed.", description: "The warning's text (HI-2462): why the old data folder wasn't renamed, and how the user can do it. Keep .combwork as it is." }),
  what: {
    excludes: msg({ id: 'main.combworkMove.what.excludes', defaultMessage: "git's exclude lines", description: 'What the folder move was updating when it failed (service.combworkMove.phaseFailed): the lines that keep the folder out of git.' }),
    worktrees: msg({ id: 'main.combworkMove.what.worktrees', defaultMessage: 'the worktrees inside it', description: 'What the folder move was updating when it failed (service.combworkMove.phaseFailed): git worktrees kept inside the moved folder.' }),
    notes: msg({ id: 'main.combworkMove.what.notes', defaultMessage: 'the paths in shared notes and handovers', description: 'What the folder move was updating when it failed (service.combworkMove.phaseFailed).' }),
    cards: msg({ id: 'main.combworkMove.what.cards', defaultMessage: 'the paths in cards', description: 'What the folder move was updating when it failed (service.combworkMove.phaseFailed): links and paths in cards\' descriptions and comments.' }),
    folders: msg({ id: 'main.combworkMove.what.folders', defaultMessage: "the agents' folders inside it", description: "What the folder move was updating when it failed (service.combworkMove.phaseFailed): slots and other agents' folders kept inside the moved folder." })
  } satisfies Record<Phase, Msg<string>>
}

const legacy = (host: string): string => join(host, LEGACY_HIVE_DIR)
const current = (host: string): string => join(host, CW_DIR)
const lower = (p: string): string => resolve(p).toLowerCase()
const under = (p: string, root: string): boolean => {
  const a = lower(p)
  const r = lower(root).replace(/[\\/]+$/, '')
  return a === r || a.startsWith(r + '\\')
}

/** A host's own folder, not a link (a symlink or junction) to somewhere else: its real place is inside the host's. */
async function plainFolder(host: string, dir: string): Promise<boolean> {
  const st = await lstatOrNullAsync(dir)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  return realPath(dir).toLowerCase() === join(realPath(host), LEGACY_HIVE_DIR).toLowerCase()
}

/** The marker's content: what makes it Combwork's, not a file that happens to have its name. */
const MARK_KIND = 'combwork-move'

/** The marker written into a host's `.hive` just before it is renamed. */
const markText = (id: string): string => JSON.stringify({ kind: MARK_KIND, version: 1, id, from: LEGACY_HIVE_DIR, at: new Date().toISOString() })

/**
 * Whether a host's `.combwork` is one Combwork moved there from its `.hive` (s65, HR1's approval): the folder is the
 * host's own (a real folder at its place, not a link) and holds Combwork's marker, as Combwork writes it. The marker is
 * read first (HI-2510): a host without one, every host of a workspace that never had a `.hive`, costs that one call.
 */
async function movedHost(host: string): Promise<boolean> {
  const dir = current(host)
  // No marker, or one that isn't Combwork's: not moved. One that can't be read now fails the step (presence.ts).
  const text = await readFile(join(dir, MARK_FILE), 'utf8').catch(ifAbsent(null))
  if (text === null) return false
  let m: { kind?: unknown; version?: unknown; id?: unknown } | null
  try {
    m = JSON.parse(text) as typeof m
  } catch {
    return false
  }
  if (!(m && m.kind === MARK_KIND && m.version === 1 && typeof m.id === 'string' && m.id.length > 0)) return false
  const st = await lstatOrNullAsync(dir)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  const [realDir, realHost] = await Promise.all([realpath(dir), realpath(host)])
  return realDir.toLowerCase() === join(realHost, CW_DIR).toLowerCase()
}

/** A host as one look at it saw it (HI-2510): whether its `.combwork` was Combwork's move, looked at once per step. */
interface Looked {
  host: string
  kind: HostKind
  marked: boolean
}

/** How many hosts are looked at together: a workspace of many projects never makes a burst of file calls. */
const LOOK_AT_ONCE = 8

/** Each host looked at once, a few at a time (HI-2510: an open no longer waits on each host's calls in turn). */
async function lookAt(hosts: { host: string; kind: HostKind }[]): Promise<Looked[]> {
  const out: Looked[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    for (let i = next++; i < hosts.length; i = next++) out[i] = { ...hosts[i], marked: present(current(hosts[i].host)) && (await movedHost(hosts[i].host)) }
  }
  await Promise.all(Array.from({ length: Math.min(LOOK_AT_ONCE, hosts.length) }, lane))
  return out
}

/** What a host's folders are now. `marked`: whether its `.combwork` holds the marker, when the caller has just looked. */
export async function classify(ws: string, host: string, kind: HostKind, marked?: boolean): Promise<HostState> {
  const oldDir = legacy(host)
  const newDir = current(host)
  const hasOld = present(oldDir)
  const hasNew = present(newDir)
  if (hasNew && (marked ?? (await movedHost(host)))) return 'moved'
  if (!hasOld) return 'current'
  // The workspace's own folder is the workspace; a project or the Assistant's home must really be inside it.
  if (kind !== 'workspace' && !under(realPath(host), realPath(ws))) return 'link'
  if (!(await plainFolder(host, oldDir))) return 'link'
  if (!ours(oldDir, kind)) return 'current'
  return hasNew ? 'both' : 'planned'
}

/** The hosts the workspace has: itself, its Assistant's home (in its tree in use), and every folder it lists as a project (hidden ones too). */
export async function hostsOf(ws: string): Promise<{ host: string; kind: HostKind }[]> {
  const out: { host: string; kind: HostKind }[] = [{ host: ws, kind: 'workspace' }, { host: join(treeOf(ws), ASSISTANT_DIR), kind: 'assistant' }]
  const entries = await readdir(ws, { withFileTypes: true }).catch(ifAbsent(null))
  for (const e of entries ?? []) if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) out.push({ host: join(ws, e.name), kind: 'project' })
  return out
}

/**
 * The workspace's tree as the move finds it: `.combwork` once there, else its own `.hive` (the move's input, and a 0.9
 * profile's connection order's, accounts.ts), else `.combwork` (to be made). Never makes either.
 */
export function treeOf(ws: string): string {
  const now = join(ws, CW_DIR)
  if (present(now)) return now
  const old = join(ws, LEGACY_HIVE_DIR)
  return present(old) && ours(old, 'workspace') ? old : now
}

/**
 * The moves a workspace's folders show now (s65): each host whose `.combwork` holds the marker. The Assistant's home's
 * own old path (`<ws>\.combwork\assistant\.hive`) when it is marked, and its path under the workspace's old folder
 * (`<ws>\.hive\assistant\.hive`) only when the workspace's own folder is marked too: an old outer tree left beside a
 * `.combwork` is never anyone's. Empty when nothing moved.
 */
export async function deriveMoves(ws: string): Promise<FolderMove[]> {
  ws = resolve(ws)
  return movesOf(ws, await lookAt(await hostsOf(ws)))
}

/** The map from one look at every host of the workspace (deriveMoves, or the open's own look: HI-2510). */
async function movesOf(ws: string, looked: Looked[]): Promise<FolderMove[]> {
  moveStats.derives++
  const out: FolderMove[] = []
  const wsMoved = looked.some((h) => h.kind === 'workspace' && h.marked)
  for (const h of looked) {
    if (h.kind === 'assistant') {
      // The home in the workspace's `.combwork`: the host looked at whenever that folder is there (treeOf), else none.
      const home = join(current(ws), ASSISTANT_DIR)
      if (!(lower(h.host) === lower(home) ? h.marked : await movedHost(home))) continue
      out.push({ from: legacy(home), to: current(home) })
      if (wsMoved) out.push({ from: join(legacy(ws), ASSISTANT_DIR, LEGACY_HIVE_DIR), to: current(home) })
    } else if (h.marked) out.push({ from: legacy(h.host), to: current(h.host) })
  }
  return out
}

/** How often the map was derived from the folders (a test reads it: readers use the snapshot, never a scan of their own). */
export const moveStats = { derives: 0 }

/**
 * Each workspace's map as its last move left it (HR1's round 2: readers never scan the workspace): published at the
 * move's own boundaries (moveFolders, finishMove: an open, a late project), dropped while one is under way, so a reader
 * then, or after a move that failed part-way (a crash after a rename), derives it from the folders once and keeps that.
 * Folders move only through those boundaries, so between them the snapshot is what the folders say.
 */
const snapshots = new Map<string, FolderMove[]>()
/**
 * Moves on with every publication and every invalidation, of any workspace (HR1's round 3): a reader that derived the
 * map from the folders publishes it only when nothing was published or dropped while it read, so a reader overtaken by
 * a move (a late project's, already ended) never puts back an older map. One number: bounded whatever the workspaces.
 */
let epoch = 0
const publish = (ws: string, moves: FolderMove[]): void => {
  epoch++
  snapshots.set(lower(ws), moves)
  if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value!)
}
const invalidate = (ws: string): void => {
  epoch++
  snapshots.delete(lower(ws))
}

/** A map's hash: its moves sorted, lower case. */
export const mapHash = (moves: readonly FolderMove[]): string =>
  createHash('sha1')
    .update(JSON.stringify(moves.map((m) => [m.from.toLowerCase(), m.to.toLowerCase()]).sort()))
    .digest('hex')

/** The hash of the map the rewrites last finished for, or null. */
async function doneHash(ws: string): Promise<string | null> {
  const f = await readKeptJson<Partial<MovedFile>>(join(treeOf(ws), MOVED_FILE), {})
  return typeof f.hash === 'string' ? f.hash : null
}

/** The folders that moved in a workspace, as its folders show now: what stored paths into them are translated through. */
export async function movedFolders(ws: string): Promise<FolderMove[]> {
  const kept = snapshots.get(lower(ws))
  if (kept) return kept
  const seen = epoch
  const moves = await deriveMoves(ws)
  // Kept only when nothing was published or dropped while it read and no move is under way: else the map a move
  // published meanwhile is the authority, and this reader's older one is neither kept nor given.
  if (epoch === seen && !chains.has(lower(ws))) {
    publish(ws, moves)
    return moves
  }
  return snapshots.get(lower(ws)) ?? moves
}

/** Where a path stored before the move is now, through its workspace's map; null when it didn't move. */
export async function movedPath(ws: string, p: string): Promise<string | null> {
  return movedPathOf(p, await movedFolders(ws))
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
 * A `.hive` made again beside a moved `.combwork` (an older release opened it since): said once, left as it is. Only a
 * warning, never a step (HI-2612): one that can't be looked at now is logged, not warned of, and nothing is recorded by it.
 */
async function warnRecreated(hosts: Looked[]): Promise<void> {
  for (const h of hosts) {
    if (!h.marked) continue
    try {
      if ((await plainFolder(h.host, legacy(h.host))) && ours(legacy(h.host), h.kind)) warn(h.host, 'both')
    } catch (e) {
      log.warn(`couldn't look at ${userText(legacy(h.host))} beside its moved .combwork`, e)
    }
  }
}

const lockBusy = (h: { profile: string }): CombworkError => combworkError(M.busy, { profile: h.profile }, { kind: 'conflict' })

/**
 * Moves a workspace's folders, before anything reads them (WorkspaceService's open, inside its claim): every host with
 * our `.hive` alone, then the early phases when the map isn't the one they last finished for. `only`: a single host (a
 * project that came into the open workspace later, ensureProject). Throws a CombworkError (translated, naming the folder)
 * when it can't, nothing of that host changed.
 */
export function moveFolders(ws: string, o: MoveOptions & { only?: string } = {}): Promise<MoveOutcome> {
  return inTurn(ws, () => moveNow(resolve(ws), o))
}

async function moveNow(ws: string, o: MoveOptions & { only?: string }): Promise<MoveOutcome> {
  // A move under way: readers derive the map until it publishes its own.
  invalidate(ws)
  // One look at every host, a few at a time (HI-2510): what each host is, the warnings and the map all come from it, so
  // an ordinary open (nothing to move, or moved before) waits on about two file calls in turn, not on each host's.
  const all = await lookAt(await hostsOf(ws))
  const hosts = o.only ? all.filter((h) => lower(h.host) === lower(o.only!)) : all
  let planned = 0
  // In turn: a host with no `.hive` needs no file call here (classify), and one with a `.hive` is a first open's, rare.
  for (const h of hosts) {
    const s = await classify(ws, h.host, h.kind, h.marked)
    if (s === 'both' || s === 'link') warn(h.host, s)
    if (s === 'planned') planned++
  }
  await warnRecreated(hosts)
  // Nothing to rename, nothing under an old name (HI-2587), and the rewrites finished for the map as it is: no lock,
  // nothing written.
  // A single project (one that came later): its own steps by its own record, whatever the workspace's (HR2's round 1).
  // Only read here (HR2's rounds 2 and 3): whether anything is due. Every write, the names upgrade's records included, is
  // under the lock, after the other processes' refusal.
  const namesDue = o.only ? !(await projectNamesDone(o.only)) : await workspaceNeeds(ws)
  const stop = (): void => {
    if (o.signal?.aborted || (o.stillOurs && !o.stillOurs())) throw combworkError(M.closed, undefined, { kind: 'conflict' })
  }
  if (!planned && !namesDue) {
    const moves = await movesOf(ws, all)
    if (!moves.length || (await doneHash(ws)) === mapHash(moves)) {
      publish(ws, moves)
      return { late: false, moved: 0 }
    }
  }
  await moveTestHooks.looked?.()
  return withNamedLock(ws, MOVE_LOCK_FILE, () => movedUnderLock(ws, o, stop), { waitMs: 0, busy: lockBusy })
}

/**
 * A workspace just made (its `.combwork` new, nothing of 1.0's in it): its names upgrade recorded done, under the move's
 * lock and only with no other process present, as every write of the upgrade is (HR2's round 3). Not recorded (another
 * process there, the lock held): its next open looks again, under the lock. Never throws.
 */
export function recordNewWorkspace(ws: string): Promise<void> {
  return inTurn(ws, () =>
    withNamedLock(
      ws,
      MOVE_LOCK_FILE,
      async () => {
        for (const dir of [legacy(ws), current(ws)]) if (othersPresentByProcess(dir).length) return
        await recordNames(ws)
      },
      { waitMs: 0, busy: lockBusy }
    )
  ).catch((e) => log.warn("recording a new workspace's names upgrade done", e))
}

/**
 * The lock's file kept out of git when the workspace is in a repository (HI-2462/s21: the file stays for good, its row
 * released): its line in that repository's info/exclude, under Combwork's comment, anchored at the workspace. A failure
 * only means git lists one more untracked file; the move goes on.
 */
export async function excludeMoveLock(ws: string): Promise<void> {
  try {
    const found = vcsOf(ws)
    if (found?.kind !== 'git') return
    const gd = await gitDirOf(found.root)
    if (!gd) return
    const f = join(gd, 'info', 'exclude')
    const line = excludeLine(found.root, ws).replace(/\/\.combwork\/$/, `/${MOVE_LOCK_FILE}`)
    const text = await readFile(f, 'utf8').catch(ifAbsent(''))
    if (text.split(/\r?\n/).some((l) => l.trim() === line)) return
    await mkdir(join(gd, 'info'), { recursive: true })
    await writeTextAtomic(f, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Combwork's folder move lock (added by Combwork)\n${line}\n`) // i18n-ignore: a line in git's exclude file, which stays English
  } catch (e) {
    log.warn("keeping the folder move's lock file out of git", e)
  }
}

async function movedUnderLock(ws: string, o: MoveOptions & { only?: string }, stop: () => void): Promise<MoveOutcome> {
  stop()
  // Inside the lock, everything is looked at again: another process may have moved it meanwhile. Another process's
  // presence refuses it before anything is written (HR2's round 3: the lock file's exclude line too).
  for (const dir of [legacy(ws), current(ws)]) {
    const others = othersPresentByProcess(dir)
    if (others.length) throw combworkError(M.otherOpen, { profile: others[0].profile }, { kind: 'conflict' })
  }
  await excludeMoveLock(ws)
  const id = randomUUID()
  // The workspace first: a Combwork with its board open fails it here, before any project is touched; then its Assistant's
  // home (inside the workspace's folder, so looked at after it moved), then the projects.
  let moved = 0
  for (const kind of ['workspace', 'assistant', 'project'] as const) {
    for (const h of (await hostsOf(ws)).filter((x) => x.kind === kind && (!o.only || lower(x.host) === lower(o.only)))) {
      stop()
      if ((await classify(ws, h.host, h.kind)) !== 'planned') continue
      // The marker first, inside the folder that moves: from the rename on, the folder says it moved.
      await writeFile(join(legacy(h.host), MARK_FILE), markText(id), 'utf8')
      await moveTestHooks.after?.(`marked:${kind}`)
      try {
        await renameFolder(legacy(h.host), current(h.host))
      } catch (e) {
        if (isLocked(e)) throw combworkError(M.locked, { folder: legacy(h.host) }, { kind: 'conflict' })
        throw e
      }
      moved++
      log.info(`Moved ${userText(legacy(h.host))} to .combwork`)
      await moveTestHooks.after?.(`renamed:${kind}`)
    }
  }
  // Then what is kept inside under the old names (HI-2587, nameUpgrade.ts), still under the lock and before anything of
  // the workspace is admitted.
  const projects = (await hostsOf(ws)).filter((h) => h.kind === 'project').map((h) => h.host)
  const setAside = async (cards: number): Promise<void> => (await import('./boardStore')).tellSetAside(ws, cards)
  await upgradeWorkspace(ws, { stop, checkpoint: checkpointOffMain, copyFolders: copyFoldersOffMain, projects, only: o.only, setAside })
  const moves = await deriveMoves(ws)
  publish(ws, moves)
  if (!moves.length || (await doneHash(ws)) === mapHash(moves)) return { late: false, moved }
  for (const phase of EARLY) {
    stop()
    try {
      await runEarly(ws, moves, phase)
    } catch (e) {
      log.warn(`the folder move's ${phase}`, e)
      throw combworkError(M.phase, { what: M.what[phase], error: errorText(e) }, { kind: 'conflict' })
    }
    await moveTestHooks.after?.(`phase:${phase}`)
  }
  return { late: true, moved }
}

/** The moved projects in a map: hosts whose own folder moved (not the workspace's, nor the Assistant's home). */
async function movedProjects(ws: string): Promise<string[]> {
  const out: string[] = []
  for (const h of await hostsOf(ws)) if (h.kind === 'project' && (await movedHost(h.host))) out.push(h.host)
  return out
}

async function runEarly(ws: string, moves: FolderMove[], phase: Phase): Promise<void> {
  if (phase === 'excludes') for (const p of await movedProjects(ws)) await moveExcludeLine(p)
  else if (phase === 'worktrees') for (const p of await movedProjects(ws)) await repairWorktrees(p, moves)
  else if (phase === 'notes') await rewriteNotes(join(current(ws), 'shared'), moves)
}

/** Combwork's exclude line for a moved project's old folder, in its repository's info/exclude, for the new one. */
export async function moveExcludeLine(host: string): Promise<boolean> {
  const found = vcsOf(host)
  if (found?.kind !== 'git') return false
  const gd = await gitDirOf(found.root)
  if (!gd) return false
  const f = join(gd, 'info', 'exclude')
  const text = await readFile(f, 'utf8').catch(ifAbsent(null))
  if (text === null) return false
  const newLine = excludeLine(found.root, host)
  const oldLine = newLine.replace(/\/\.combwork\/$/, `/${LEGACY_HIVE_DIR}/`)
  const next = movedExcludeText(text, oldLine, newLine, !present(legacy(host)))
  if (next === text) return false
  await writeTextAtomic(f, next)
  return true
}

/** git's links to the worktrees that were inside a moved folder (its slots), made right again at their new place. */
export async function repairWorktrees(host: string, moves: FolderMove[]): Promise<number> {
  // The relocation of the repository platform holding the host (HI-2792): none, nothing to repair.
  const relocate = relocationIn(host)
  if (!relocate) return 0
  const paths = await relocate.listedFolders(host)
  if (!paths) return 0
  const fixed: string[] = []
  for (const p of paths) {
    const to = movedPathOf(p, moves)
    // A jj workspace colocated with Git (HI-2800, gate relocation) is left as it is: git's repair would make only git's half
    // right, its `.jj` still naming the old store, and no move of a jj workspace is supported.
    if (to && present(to) && !present(join(to, '.jj'))) fixed.push(to)
  }
  if (!fixed.length) return 0
  const rep = await relocate.repair(host, fixed)
  if (!rep.ok) throw new Error(rep.err.split(/\r?\n/)[0] || `git worktree repair exited with ${rep.code}`) // i18n-ignore: git's own words, for the error's detail
  return fixed.length
}

/** The shared notes and handovers' paths into moved folders, each file written whole, only those that change. */
export async function rewriteNotes(dir: string, moves: FolderMove[]): Promise<number> {
  if (!moves.length || !present(dir)) return 0
  let n = 0
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(d, { withFileTypes: true }).catch(ifAbsent(null))
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
const workerScript = (): string => join(__dirname, 'cw-move-worker.js')

/** Rewrites the board's cards in the worker (combworkMoveWorker.ts). */
export function rewriteCardsOffMain(job: CardsRewrite): Promise<CardsAnswer> {
  return inMoveWorker<CardsAnswer>(job, async () => (await import('./combworkMoveWorker')).rewriteCards(job))
}

/** Checkpoints and closes the board's old file in the worker (combworkMoveWorker.ts), before its rename (HI-2587). */
export function checkpointOffMain(file: string): Promise<CheckpointAnswer> {
  const job: Checkpoint = { kind: 'checkpoint', file }
  return inMoveWorker<CheckpointAnswer>(job, async () => (await import('./combworkMoveWorker')).checkpointFile(job))
}

/** The folders the board's skill copies records name, read in the worker (HI-2587's marker step); none without a board. */
export async function copyFoldersOffMain(file: string): Promise<string[]> {
  if (!present(file)) return []
  const job: CopyFolders = { kind: 'copyFolders', file }
  const a = await inMoveWorker<CopyFoldersAnswer>(job, async () => (await import('./combworkMoveWorker')).copyFolders(job))
  if (!a.ok) throw new Error(a.error)
  return a.folders
}

async function inMoveWorker<A extends { ok: boolean }>(job: CardsRewrite | Checkpoint | CopyFolders, here: () => Promise<A>): Promise<A> {
  if (!bundledScriptExists(workerScript())) {
    workerHere('folder move', "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
    return here()
  }
  return new Promise((res) => {
    const w = new Worker(workerScript(), { workerData: job })
    workerStarted('folder move', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    let done = false
    w.once('message', (a: A) => {
      done = true
      res(a)
      void w.terminate()
    })
    w.once('error', (e: Error) => {
      if (!done) res({ ok: false, error: e.message } as unknown as A)
      done = true
    })
    w.once('exit', (code) => {
      if (!done) res({ ok: false, error: `the worker ended (exit code ${code})` } as unknown as A) // i18n-ignore: for the error's detail
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
 * the cards' paths, then the agents' folders that were inside a moved folder; then the map's hash is recorded, so the
 * next open does nothing for it. One that fails refuses the open; the next open does them all again (each idempotent).
 */
export function finishMove(ws: string, svc: LateServices, o: MoveOptions = {}): Promise<void> {
  return inTurn(ws, () => {
    const stop = (): void => {
      if (o.signal?.aborted || (o.stillOurs && !o.stillOurs())) throw combworkError(M.closed, undefined, { kind: 'conflict' })
    }
    return withNamedLock(ws, MOVE_LOCK_FILE, () => finishUnderLock(resolve(ws), svc, stop), { waitMs: 0, busy: lockBusy })
  })
}

async function finishUnderLock(ws: string, svc: LateServices, stop: () => void): Promise<void> {
  const moves = await deriveMoves(ws)
  publish(ws, moves)
  const hash = mapHash(moves)
  if (!moves.length || (await doneHash(ws)) === hash) return
  let deferred = false
  for (const phase of ['cards', 'folders'] as const) {
    stop()
    try {
      if (phase === 'cards') {
        const a = await rewriteCardsOffMain({ file: svc.boardFile, moves, workspaceMoved: await movedHost(ws) })
        if (!a.ok) throw new Error(a.error)
        // A board still to be upgraded: its cards are rewritten at a later open, and the hash waits for that.
        if (a.deferred) deferred = true
        else log.info(`The folder move rewrote ${a.changed} card texts`)
      } else {
        for (const p of await movedProjects(ws)) if (!(await svc.relocateFolders(p, moves))) throw new Error(`a folder of ${p} is in use`) // i18n-ignore: the error's detail
      }
    } catch (e) {
      log.warn(`the folder move's ${phase}`, e)
      throw e instanceof CombworkError ? e : combworkError(M.phase, { what: M.what[phase], error: errorText(e) }, { kind: 'conflict' })
    }
    await moveTestHooks.after?.(`phase:${phase}`)
  }
  if (deferred) return
  await writeKeptJson(join(treeOf(ws), MOVED_FILE), { version: 2, hash, moves } satisfies MovedFile)
  log.info(`The move of ${userText(ws)}'s folders to .combwork has finished`)
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
  if (q && present(q)) return q
  return (await movedAttachment(at)) ?? q
}

/** Whether a stored path (a conversation's folder) lies inside a folder that moved: its conversation can't resume there. */
export async function inMovedFolder(ws: string, p: string | undefined): Promise<boolean> {
  return !!p && (await movedPath(ws, p)) !== null
}
