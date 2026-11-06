// Project Settings → Storage: what Combwork keeps per project (backups, archive, attachments, worktrees), measured in the
// background; Clean Up…, which moves what its preview listed to the Recycle Bin; and Purge… (#1138), which removes
// everything Combwork keeps per session, for a session, a project or the workspace, as its preview listed it.
import { randomUUID } from 'crypto'
import { basename, dirname, join, resolve, sep } from 'path'
import { lstat, opendir, readdir, rm, rmdir } from 'original-fs/promises'
import { ASSISTANT_NAME } from '../shared/assistant'
import { CW_DIR, assertSessionId, isSessionId, projectAgents } from '../shared/defaults'
import { msg, tr, type Msg } from '../shared/i18n'
import { planCleanup, planPurge, type CleanupFacts, type CleanupSession, type PurgeFacts, type PurgeFile, type PurgeSession } from '../shared/storage'
import { utf8Bytes } from '../shared/metrics'
import type { CleanupItem, CleanupOptions, CleanupResult, ProjectStorage, PurgeItem, PurgePreview, PurgeResult, PurgeTarget, WorkspaceStorage } from '../shared/types'
import { createLogger, userText } from './logger'
import { sessions, type ListContext } from './sessions'
import { workspace, workspaceOf } from './workspace'
import { usageHistory } from './usageHistory'
import { combworkError, shownError } from './combworkError'
import { insideReal, placeKey } from './fsutil'
import { folderFacts, legacyWorktree } from './agentFolders'
import { unusedWorktreeFolders } from './unusedWorktrees'
import { trash } from './trash'
import { attachmentsDir } from './attachmentsFolder'
import { CARD_ATTACHMENTS_DIR, isSessionFolder } from '../shared/attachments'
import { gzSize, isGz } from './transcriptFiles'

const log = createLogger('storage')

/** A folder's own files' total and its subfolders, as of its modified time. */
interface DirSize {
  mtimeMs: number
  files: number
  dirs: string[]
}

/** Folders whose files don't change in place (worktrees are walked again only where a folder changed; attachments are written once). */
const dirCache = new Map<string, DirSize>()
const MAX_CACHED_DIRS = 200_000

/**
 * A folder's size, read a directory at a time and handing the event loop back every few hundred entries so a large
 * worktree never holds up the window or a running session. Links and junctions aren't followed, and .asar files are
 * plain files (original-fs, #246). With `cache`, a folder whose modified time hasn't changed counts what it had last
 * time (its subfolders are still checked). `signal` stops it between entries.
 */
export async function folderSize(root: string, cache: 'use' | 'refresh' | 'none' = 'none', signal?: AbortSignal): Promise<number> {
  let total = 0
  let seen = 0
  const stack = [root]
  while (stack.length) {
    signal?.throwIfAborted()
    const dir = stack.pop()!
    const st = await lstat(dir).catch(() => null)
    if (!st?.isDirectory()) continue
    const key = dir.toLowerCase()
    const hit = cache === 'use' ? dirCache.get(key) : undefined
    if (hit && hit.mtimeMs === st.mtimeMs) {
      total += hit.files
      stack.push(...hit.dirs)
      continue
    }
    let files = 0
    const dirs: string[] = []
    try {
      for await (const e of await opendir(dir)) {
        const p = join(dir, e.name)
        if (e.isDirectory()) dirs.push(p)
        else if (e.isFile()) files += (await lstat(p).catch(() => null))?.size ?? 0
        if (++seen % 300 === 0) {
          await new Promise((r) => setImmediate(r))
          signal?.throwIfAborted()
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e
      // Gone or unreadable meanwhile: what was read counts.
    }
    if (cache !== 'none') {
      if (dirCache.size > MAX_CACHED_DIRS) dirCache.clear()
      dirCache.set(key, { mtimeMs: st.mtimeMs, files, dirs })
    }
    total += files
    stack.push(...dirs)
  }
  return total
}

/** A request whose window stopped waiting for it (storage:abandon). */
export class StorageStopped extends Error {
  constructor() {
    super('Measuring stopped: nothing waits for it.') // i18n-ignore: no window waits for it, so it is never shown
  }
}

/** A measurement under way: the waits for it, and its stop once none is left. */
interface Measuring {
  promise: Promise<ProjectStorage>
  abort: AbortController
  waiting: Set<object>
}

const results = new Map<string, ProjectStorage>()
const running = new Map<string, Measuring>()
/**
 * The requests a window can abandon, by the window that sent them (its web contents' id; none for a caller that isn't
 * a window) and its request id, each with its waits' stops and how many calls run under it (asRequest). A window
 * abandons only its own, and all of them when its page goes (abandonWindowStorage, #260): closing a window or
 * reloading its page runs none of the page's clean-up.
 */
type Request = { window: number | undefined; stops: Set<() => void>; calls: number; abandoned: boolean }
const requests = new Map<string, Request>()
const requestKey = (request: string, window: number | undefined): string => `${window ?? ''}:${request}`

/**
 * What Combwork keeps for a project or the Assistant. The last result comes back at once unless `refresh`; one
 * measurement runs per project at a time. With `request`, the window (`window`, its web contents' id) can abandon the
 * call (abandonStorage), or abandons it by going: the measurement, which walks every file of every worktree, stops once
 * nothing waits for it.
 */
export function projectStorage(projectPath: string, refresh = false, request?: string, window?: number): Promise<ProjectStorage> {
  projectPath = workspace.assertSessionHost(projectPath)
  return asRequest(request, window, (entry) => storageOf(projectPath, refresh, entry))
}

/** The window no longer waits for this request: its call fails, and a measurement only it waited for stops. */
export function abandonStorage(request: string, window?: number): void {
  abandon(requestKey(request, window))
}

/** The window's page went (closed or reloaded): it waits for none of its requests any more. */
export function abandonWindowStorage(window: number): void {
  for (const [key, r] of [...requests]) if (r.window === window) abandon(key)
}

function abandon(key: string): void {
  const r = requests.get(key)
  requests.delete(key)
  if (!r) return
  r.abandoned = true
  for (const stop of r.stops) stop()
}

/**
 * Runs a call under its request. Calls with the same window and id while one is still going share its entry (#299):
 * abandoning the request (the page going) reaches every one of their waits, and the entry goes with the last of them.
 * One sent after the request was abandoned starts a new entry. Each call keeps its own entry, not the id: one abandoned
 * while it awaited something stays abandoned, whatever a later call with the same id starts (#338).
 */
async function asRequest<T>(request: string | undefined, window: number | undefined, run: (entry: Request | undefined) => Promise<T>): Promise<T> {
  if (request === undefined) return run(undefined)
  const key = requestKey(request, window)
  const mine = requests.get(key) ?? { window, stops: new Set<() => void>(), calls: 0, abandoned: false }
  requests.set(key, mine)
  mine.calls++
  try {
    return await run(mine)
  } finally {
    // The last call of its own entry (an abandoned one was already removed, and the same id may have a new one).
    if (--mine.calls === 0 && requests.get(key) === mine) requests.delete(key)
  }
}

/** `request`: the call's request entry (asRequest), if it can be abandoned. */
function storageOf(projectPath: string, refresh: boolean, request: Request | undefined): Promise<ProjectStorage> {
  if (request?.abandoned) return Promise.reject(new StorageStopped())
  const stops = request?.stops
  const key = projectPath.toLowerCase()
  const last = results.get(key)
  if (last && !refresh) return Promise.resolve(last)
  const m = running.get(key) ?? startMeasuring(projectPath, refresh)
  const wait = {}
  m.waiting.add(wait)
  return new Promise((settle, fail) => {
    const stop = (): void => {
      if (!m.waiting.delete(wait)) return
      fail(new StorageStopped())
      if (m.waiting.size) return
      // Nothing waits any more: stop walking, and let the next call start afresh.
      m.abort.abort()
      if (running.get(key) === m) running.delete(key)
    }
    stops?.add(stop)
    m.promise.then(settle, fail).finally(() => {
      m.waiting.delete(wait)
      stops?.delete(stop)
    })
  })
}

function startMeasuring(projectPath: string, refresh: boolean): Measuring {
  const key = projectPath.toLowerCase()
  const abort = new AbortController()
  const promise = measure(projectPath, refresh, abort.signal).finally(() => {
    if (running.get(key)?.promise === promise) running.delete(key)
  })
  const m: Measuring = { abort, waiting: new Set(), promise }
  running.set(key, m)
  return m
}

async function measure(projectPath: string, refresh: boolean, signal: AbortSignal): Promise<ProjectStorage> {
  const assistant = workspace.isAssistantHome(projectPath)
  const combwork = join(projectPath, CW_DIR)
  const cache = refresh ? 'refresh' : 'use'
  // Backups grow in place, so they are always measured afresh (a few files).
  const backups = await folderSize(join(combwork, 'sessions'), 'none', signal)
  const archive = await folderSize(join(combwork, 'archive'), 'none', signal)
  // What they hold before compression (#1110).
  const sessionsRaw = await beforeCompression(join(combwork, 'sessions'), backups)
  const archiveRaw = await beforeCompression(join(combwork, 'archive'), archive)
  const attachmentsRoot = await attachmentsDir(projectPath)
  // Cards' attachments (HI-1700) on a row of their own: the sessions' are the rest of the folder.
  const cardAttachments = await folderSize(join(attachmentsRoot, CARD_ATTACHMENTS_DIR), cache, signal)
  const attachments = (await folderSize(attachmentsRoot, cache, signal)) - cardAttachments
  // The folders agents work in (#1451), each once by its real path: the project's slots on disk, lent now (to the agent
  // with the lease) or not (a free slot is kept for the next card), and an agent's 0.9 worktree while its project isn't
  // migrated.
  const worktrees: ProjectStorage['worktrees'] = []
  const counted = new Set<string>()
  let copies: ProjectStorage['copies']
  if (!assistant) {
    const agents = projectAgents(await workspace.projectConfig(projectPath))
    const facts = await folderFacts(projectPath)
    const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
    for (const s of facts.slots) {
      if (counted.has(placeKey(s.folder))) continue
      counted.add(placeKey(s.folder))
      worktrees.push({ ...(s.open ? { agent: nameOf(s.open.agent) } : {}), slot: s.name, path: s.folder, bytes: await folderSize(s.folder, cache, signal) })
    }
    for (const a of agents) {
      const w = legacyWorktree(a)
      if (!w || facts.migratedAgents.includes(a.id) || counted.has(placeKey(w.path))) continue
      counted.add(placeKey(w.path))
      worktrees.push({ agent: a.name, path: w.path, bytes: await folderSize(w.path, cache, signal) })
    }
    // The review and check copies (#1435): their folder, once.
    const copiesDir = join(workspaceOf(projectPath).worktreesRoot, basename(projectPath), 'copies')
    const copiesBytes = await folderSize(copiesDir, cache, signal)
    if (copiesBytes) copies = { path: copiesDir, bytes: copiesBytes }
  }
  // Worktrees no agent works in any more (#353): on disk all the same; a folder counted above isn't counted again.
  const unused: NonNullable<ProjectStorage['unusedWorktrees']> = []
  if (!assistant) for (const w of await unusedWorktreeFolders(projectPath)) if (!counted.has(placeKey(w.path))) unused.push({ ...w, bytes: await folderSize(w.path, cache, signal) })
  const result: ProjectStorage = {
    path: projectPath,
    name: assistant ? ASSISTANT_NAME : basename(projectPath),
    ...(assistant ? { assistant: true } : {}),
    sessions: backups,
    archive,
    ...(sessionsRaw !== backups ? { sessionsRaw } : {}),
    ...(archiveRaw !== archive ? { archiveRaw } : {}),
    attachments,
    ...(cardAttachments ? { cardAttachments } : {}),
    worktrees,
    ...(copies ? { copies } : {}),
    ...(unused.length ? { unusedWorktrees: unused } : {}),
    total: backups + archive + attachments + cardAttachments + (copies?.bytes ?? 0) + [...worktrees, ...unused].reduce((n, w) => n + w.bytes, 0),
    computedAt: new Date().toISOString()
  }
  results.set(projectPath.toLowerCase(), result)
  return result
}

/**
 * A backups folder's size before compression (#1110): its size, with each compressed backup's own size in place of
 * the file's (from the gzip trailer; a file it can't read counts as it is).
 */
async function beforeCompression(dir: string, bytes: number): Promise<number> {
  let raw = bytes
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !isGz(e.name)) continue
    const path = join(dir, e.name)
    const [packed, size] = [(await lstat(path).catch(() => null))?.size, await gzSize(path)]
    if (packed !== undefined && size !== null) raw += size - packed
  }
  return raw
}

/** Every project's storage and the Assistant's, biggest first (one project at a time); `request` as for projectStorage. */
export function workspaceStorage(refresh = false, request?: string, window?: number): Promise<WorkspaceStorage> {
  return asRequest(request, window, async (entry) => {
    const hosts = [...(await workspace.listProjectPaths()), workspace.assistantHome]
    const projects: ProjectStorage[] = []
    for (const p of hosts) {
      try {
        projects.push(await storageOf(workspace.assertSessionHost(p), refresh, entry))
      } catch (e) {
        if (e instanceof StorageStopped) throw e
        log.warn(`measuring ${userText(p)}`, e)
      }
    }
    projects.sort((a, b) => b.total - a.total)
    return { projects, total: projects.reduce((n, p) => n + p.total, 0) }
  })
}

/** What Clean Up needs to know about a project's sessions and attachments. */
async function cleanupFacts(projectPath: string): Promise<CleanupFacts> {
  const file = await workspace.sessionsFile(projectPath)
  const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(projectPath) }
  const live = sessions.projectStates(projectPath)
  const liveNames = new Set(live.flatMap((s) => [s.sessionId, `run-${s.runId}`]).filter(Boolean).map((n) => n.toLowerCase()))
  const list: CleanupSession[] = []
  for (const rec of file.sessions) {
    const files = sessions.backupFiles(projectPath, rec.id)
    const backups = await Promise.all(files.map(async (path) => ({ path, bytes: (await lstat(path).catch(() => null))?.size ?? 0 })))
    // Only an archived session with backups could be cleaned up: the CLI is asked about no other.
    const inCli = rec.archived && backups.length ? !!(await sessions.providerTranscript(projectPath, rec.id, ctx).catch(() => null)) : false
    list.push({ id: rec.id, name: rec.name, archived: rec.archived, lastActiveAt: rec.lastActiveAt, running: live.some((s) => s.sessionId === rec.id), inCli, backups })
  }
  const dir = await attachmentsDir(projectPath)
  const attachmentFolders: CleanupFacts['attachmentFolders'] = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    // The cards' folder (HI-1700) is never a session's: Clean Up leaves a live card's files alone.
    if (!e.isDirectory() || !isSessionFolder(e.name)) continue
    const path = join(dir, e.name)
    attachmentFolders.push({ name: e.name, path, bytes: await folderSize(path, 'use') })
  }
  return { sessions: list, attachmentFolders, liveNames, now: Date.now() }
}

/** What Clean Up… would remove with these options (nothing is changed). */
export async function cleanupPreview(projectPath: string, opts: CleanupOptions): Promise<CleanupItem[]> {
  projectPath = workspace.assertSessionHost(projectPath)
  return planCleanup(await cleanupFacts(projectPath), opts)
}

/**
 * Moves a session's attachments folder to the Recycle Bin, checked again just before: its session wasn't unarchived, resumed or (for
 * an orphan) recorded since, and it can't be resumed while it goes (whileCleaning).
 */
async function trashAttachments(projectPath: string, i: CleanupItem): Promise<void> {
  const name = basename(i.path).toLowerCase()
  await sessions.whileCleaning(projectPath, name, async () => {
    const rec = (await workspace.sessionsFile(projectPath)).sessions.find((s) => s.id.toLowerCase() === name)
    if (i.kind === 'archived-attachments' && !rec?.archived) throw new Error(tr(msg({ id: 'main.storage.unarchived', defaultMessage: 'The session is no longer archived.', description: "Why Clean Up (Settings → Storage) skipped a session's attachments folder: its session was unarchived meanwhile." })))
    if (i.kind === 'orphan-attachments' && rec) throw new Error(tr(msg({ id: 'main.storage.claimed', defaultMessage: 'The folder belongs to a session again.', description: "Why Clean Up (Settings → Storage) skipped a session's attachments folder: it had no session, and has one now." })))
    // After the read above: nothing is awaited between this check and the removal.
    if (sessions.projectStates(projectPath).some((s) => s.sessionId.toLowerCase() === name || `run-${s.runId}`.toLowerCase() === name)) throw new Error(tr(msg({ id: 'main.storage.running', defaultMessage: 'The session is running.', description: "Why Clean Up (Settings → Storage) skipped a session's attachments folder." })))
    await trash(i.path)
  })
}

/**
 * Removes what the preview listed (`listed`, its paths), to the Recycle Bin, after checking each still qualifies:
 * nothing it didn't list goes, and what changed since (a session resumed or unarchived) is skipped. Removing a
 * session's last copy deletes the session as Delete Session does, so its usage still counts.
 */
export async function cleanup(projectPath: string, opts: CleanupOptions, listed: string[]): Promise<CleanupResult> {
  projectPath = workspace.assertSessionHost(projectPath)
  const now = planCleanup(await cleanupFacts(projectPath), opts)
  const want = new Set(listed.map((p) => p.toLowerCase()))
  const items = now.filter((i) => want.has(i.path.toLowerCase()))
  const qualifying = new Set(items.map((i) => i.path.toLowerCase()))
  const skipped = listed.filter((p) => !qualifying.has(p.toLowerCase())).map((p) => tr(msg({ id: 'main.storage.noLonger', defaultMessage: '{path}: no longer qualifies', description: 'What Clean Up (Settings → Storage) skipped: it changed since the preview listed it. {path} is the file or folder.' }), { path: p }))
  const attachmentsRoot = resolve(await attachmentsDir(projectPath)).toLowerCase() + sep
  let removed = 0
  let bytes = 0
  const done = (i: CleanupItem): void => {
    removed++
    bytes += i.bytes
  }
  for (const i of items.filter((x) => x.kind === 'archived-attachments' || x.kind === 'orphan-attachments')) {
    if (!resolve(i.path).toLowerCase().startsWith(attachmentsRoot)) continue
    try {
      await trashAttachments(projectPath, i)
      done(i)
    } catch (e) {
      skipped.push(`${i.path}: ${(e as Error).message}`)
    }
  }
  // Backups go a session at a time, and only when the preview listed every copy of it. The session is checked again
  // with its backups locked: unarchived, resumed or with other copies since, it's skipped.
  const bySession = new Map<string, CleanupItem[]>()
  for (const i of items) if (i.sessionId && (i.kind === 'archived-backup' || i.kind === 'gone-backup')) bySession.set(i.sessionId, [...(bySession.get(i.sessionId) ?? []), i])
  for (const [id, group] of bySession) {
    const paths = group.map((i) => i.path)
    try {
      if (group[0].kind === 'gone-backup') await sessions.delete(projectPath, id, paths)
      else await sessions.removeBackups(projectPath, id, paths)
      group.forEach(done)
    } catch (e) {
      skipped.push(...group.map((i) => `${i.path}: ${(e as Error).message}`))
    }
  }
  log.info(`Clean Up in ${userText(projectPath)}: ${removed} item(s), ${bytes} bytes${skipped.length ? `, ${skipped.length} skipped` : ''}`)
  results.delete(projectPath.toLowerCase())
  return { removed, bytes, skipped }
}

/**
 * The files of .combwork/sessions and .combwork/archive that are Combwork's per session: a backup (`<id>.jsonl`, compressed or not)
 * and what is left of one: a spare (`.spare`, trashAllOrNothing), a half-made copy (`.<pid>-<time>.tmp`, compressing)
 * and the names an archive sets aside (`.archiving`, `.previous`, `.archived`). Group 3 is empty for a backup.
 */
const BACKUP_FILE = /^([\w-]{1,100})\.jsonl((?:\.gz)?)((?:\.(?:spare|archiving|previous|archived|\d+-\d+\.tmp))*)$/i

/** The hosts a purge covers: the session's or project's own, or the window's workspace's projects and the Assistant. */
async function purgeHosts(target: PurgeTarget): Promise<string[]> {
  // i18n-ignore: refusals no person sees (the window sends only these)
  if (!target || typeof target !== 'object') throw new Error('target: a purge target')
  if (target.kind === 'workspace') return [...(await workspace.listProjectPaths()), workspace.assistantHome].map((p) => workspace.assertSessionHost(p))
  if (target.kind === 'session') assertSessionId(target.sessionId)
  else if (target.kind !== 'project') throw new Error(`Unknown purge target: ${String((target as { kind: unknown }).kind)}`) // i18n-ignore: a refusal no person sees
  return [workspace.assertSessionHost(target.projectPath)]
}

/** A plain file as it is now (its size and modified time), or null: gone, or not a plain file (a link, a folder). */
async function fileNow(path: string): Promise<PurgeFile | null> {
  const st = await lstat(path).catch(() => null)
  return st?.isFile() ? { path, bytes: st.size, mtimeMs: st.mtimeMs } : null
}

/** A listed file is as the preview saw it. */
const unchanged = (i: PurgeItem, now: PurgeFile | null): boolean => !!now && now.bytes === i.bytes && now.mtimeMs === i.mtimeMs

/** What Purge… needs to know of a host (#1138): its sessions, Combwork's files of them, and old kept usage. */
async function purgeFacts(host: string): Promise<PurgeFacts> {
  const file = await workspace.sessionsFile(host)
  const ctx: ListContext = { records: file.sessions, cfg: await workspace.projectConfig(host) }
  const liveNames = new Set(sessions.projectStates(host).flatMap((s) => [s.sessionId, `run-${s.runId}`]).filter(Boolean).map((n) => n.toLowerCase()))
  const files: PurgeFacts['files'] = []
  for (const folder of ['sessions', 'archive'] as const) {
    const dir = join(host, CW_DIR, folder)
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const m = e.isFile() ? BACKUP_FILE.exec(e.name) : null
      const now = m ? await fileNow(join(dir, e.name)) : null
      if (m && now) files.push({ ...now, id: m[1], folder, backup: !m[3] })
    }
  }
  const withFiles = new Set(files.map((f) => f.id.toLowerCase()))
  const list: PurgeSession[] = []
  for (const rec of file.sessions) {
    const busy = sessions.liveAnywhere(rec.id)
    // Only a session with files here is asked about: whether they are its last copy.
    const inCli = withFiles.has(rec.id.toLowerCase()) && !busy ? !!(await sessions.providerTranscript(host, rec.id, ctx).catch(() => null)) : true
    list.push({ id: rec.id, name: rec.name, running: busy, inCli, keptUsageBytes: rec.keptUsage ? utf8Bytes(JSON.stringify(rec.keptUsage)) : null })
  }
  const attachmentFolders: PurgeFacts['attachmentFolders'] = []
  const dir = await attachmentsDir(host)
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    // Only real folders named as Combwork names them, and in them only plain files: anything else isn't Combwork's.
    if (!e.isDirectory() || !isSessionId(e.name) || !isSessionFolder(e.name)) continue
    const path = join(dir, e.name)
    const inside: PurgeFile[] = []
    for (const f of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const now = f.isFile() ? await fileNow(join(path, f.name)) : null
      if (now) inside.push(now)
    }
    attachmentFolders.push({ name: e.name, path, files: inside })
  }
  const deletedUsage = (file.deletedUsage ?? []).map((k) => ({ id: k.id, name: k.name, bytes: utf8Bytes(JSON.stringify(k)) }))
  const assistant = workspace.isAssistantHome(host)
  return { host, hostName: assistant ? ASSISTANT_NAME : basename(host), ...(assistant ? { assistant: true } : {}), sessions: list, files, attachmentFolders, deletedUsage, liveNames }
}

/**
 * Previews kept for their apply (storage:purge), by id: what each listed, as it saw it. Applying one uses it up; the
 * newest PREVIEWS_KEPT are kept, each for PREVIEW_MS, and one older is refused (#1158).
 */
const previews = new Map<string, { target: PurgeTarget; items: PurgeItem[]; at: number }>()
const PREVIEWS_KEPT = 20
export const PREVIEW_MS = 60 * 60_000

/** Forgets the previews older than PREVIEW_MS. */
function pruneExpiredPreviews(now: number): void {
  for (const [k, p] of previews) if (now - p.at > PREVIEW_MS) previews.delete(k)
}

/** What Purge… would remove (nothing is changed): every file and record of Combwork's it covers, with its size. Kept for its apply. */
export async function purgePreview(target: PurgeTarget): Promise<PurgePreview> {
  const hosts = await purgeHosts(target)
  const only = target.kind === 'session' ? target.sessionId : undefined
  const out: PurgePreview = { id: randomUUID(), items: [], running: 0, recoverable: 0 }
  for (const host of hosts) {
    const r = planPurge(await purgeFacts(host), only)
    out.items.push(...r.items)
    out.running += r.running
    out.recoverable += r.recoverable
  }
  const now = Date.now()
  pruneExpiredPreviews(now)
  previews.set(out.id, { target: structuredClone(target), items: out.items.map((i) => ({ ...i })), at: now })
  while (previews.size > PREVIEWS_KEPT) previews.delete(previews.keys().next().value!)
  return out
}

const M_PURGE = {
  notKept: msg({ id: 'main.storage.purgeNotKept', defaultMessage: "The folder isn't one Combwork keeps attachments in, so it is left alone.", description: "Purge skipped a session's attachments: their folder isn't a real folder in the project's attachments folder (a link, say)." }),
  changed: msg({ id: 'main.storage.purgeChanged', defaultMessage: 'It changed since the preview.', description: 'Purge skipped a file the preview listed: it was changed (written to) since.' }),
  sessionChanged: msg({ id: 'main.storage.purgeSessionChanged', defaultMessage: "One of the session's backups changed since the preview, so nothing of it goes.", description: "Purge left a session alone: one of Combwork's copies of its transcript changed since the preview (it was resumed, say)." }),
  lastCopy: msg({ id: 'main.storage.purgeLastCopy', defaultMessage: "Whether Combwork's backup is the session's last copy changed since the preview.", description: "Purge left a session alone: its coding agent's own transcript went or came back since the preview, so what the purge would do to the session changed." }),
  noLonger: msg({ id: 'main.storage.purgeNoLonger', defaultMessage: 'It no longer qualifies (it changed since the preview).', description: 'Purge skipped an item the preview listed: it changed since (a session resumed, a file gone).' }),
  expired: msg({ id: 'main.storage.purgeExpired', defaultMessage: 'This preview is out of date. Open Purge again to see what goes now.', description: 'Purge refused: the preview it was asked to apply was already applied, or is too old.' })
}

/**
 * Removes attachments of one folder as the preview listed them: each a plain file directly in a real folder of the
 * host's attachments folder, and unchanged since (its size and modified time); one that changed is left, and returned.
 * When they are all the folder holds it goes whole (one item in the Recycle Bin); else each file goes, and the folder
 * too once empty. Nothing added since the preview goes.
 */
async function removeAttachments(host: string, dir: string, listed: PurgeItem[], permanent: boolean): Promise<PurgeItem[]> {
  const root = await attachmentsDir(host)
  const st = await lstat(dir).catch(() => null)
  if (!st?.isDirectory() || st.isSymbolicLink() || resolve(dirname(dir)).toLowerCase() !== resolve(root).toLowerCase() || !insideReal(dir, [root])) throw combworkError(M_PURGE.notKept)
  const same: PurgeItem[] = []
  const changed: PurgeItem[] = []
  for (const i of listed) (resolve(dirname(i.path!)).toLowerCase() === resolve(dir).toLowerCase() && unchanged(i, await fileNow(i.path!)) ? same : changed).push(i)
  const entries = await readdir(dir)
  if (!permanent && !changed.length && entries.length === same.length) await trash(dir)
  else {
    for (const i of same) await (permanent ? rm(i.path!) : trash(i.path!))
    await rmdir(dir).catch(() => undefined)
  }
  return changed
}

/**
 * Purge… (#1138): removes what a preview (`previewId`) listed, those of its keys in `listed`, to the Recycle Bin or
 * (`permanent`) for good. Each is checked against what the preview saw, not what it would list now: still listed by a
 * fresh plan, of the same kind, its file unchanged (size and modified time), and for a backup whether it is the
 * session's last copy as the preview said; what changed is skipped and reported, and nothing it didn't list goes (an
 * attachment added since stays). A session's things go together, checked again with it reserved and its backups locked
 * (sessions.purge), what it used recorded first, and only with every listed backup unchanged; one whose last copy goes is
 * deleted from Combwork, as Delete Session does. What is left of sessions Combwork no longer has goes with that id reserved,
 * once no session has it; old kept usage goes once the usage history has it. Running sessions, the usage history and the
 * CLIs' own files are never touched. A preview is applied once, and only within PREVIEW_MS of making it.
 */
export async function purge(previewId: string, listed: string[], permanent: boolean): Promise<PurgeResult> {
  if (typeof previewId !== 'string' || !Array.isArray(listed)) throw new Error('previewId and listed: a preview and its keys') // i18n-ignore: a refusal no person sees (the window sends these)
  pruneExpiredPreviews(Date.now())
  const preview = previews.get(previewId)
  if (!preview) throw combworkError(M_PURGE.expired)
  previews.delete(previewId)
  const { target } = preview
  const only = target.kind === 'session' ? target.sessionId : undefined
  const remove = (p: string): Promise<void> => (permanent ? rm(p) : trash(p))
  const want = new Set(listed.map((k) => String(k).toLowerCase()))
  const chosen = preview.items.filter((i) => want.has(i.key.toLowerCase()))
  const result: PurgeResult = { removed: 0, bytes: 0, deleted: 0, skipped: [] }
  const done = (i: PurgeItem): void => {
    result.removed++
    result.bytes += i.bytes
  }
  const skip = (i: PurgeItem, e: unknown): void => {
    result.skipped.push({ key: i.key, reason: shownError(e) })
  }
  const skipFor = (i: PurgeItem, m: Msg): void => {
    result.skipped.push({ key: i.key, reason: tr(m) })
  }
  for (const host of await purgeHosts(target)) {
    const mine = chosen.filter((i) => i.host.toLowerCase() === host.toLowerCase())
    if (!mine.length) continue
    const facts = await purgeFacts(host)
    const fresh = new Map(planPurge(facts, only).items.map((i) => [i.key.toLowerCase(), i]))
    // Each as the preview saw it, or skipped; a session with a backup skipped keeps everything.
    const ok: PurgeItem[] = []
    const keepsAll = new Set<string>()
    for (const i of mine) {
      const now = fresh.get(i.key.toLowerCase())
      const why = !now ? M_PURGE.noLonger : !!now.lastCopy !== !!i.lastCopy ? M_PURGE.lastCopy : i.path && (now.bytes !== i.bytes || now.mtimeMs !== i.mtimeMs) ? M_PURGE.changed : null
      if (!why) ok.push(i)
      else {
        skipFor(i, why)
        if (i.kind === 'backup' && i.sessionId) keepsAll.add(i.sessionId.toLowerCase())
      }
    }
    const recorded = new Map(facts.sessions.map((s) => [s.id.toLowerCase(), s.id]))
    const bySession = new Map<string, PurgeItem[]>()
    const rest: PurgeItem[] = []
    for (const i of ok) {
      const id = i.sessionId && i.kind !== 'deleted-usage' && i.kind !== 'orphan-attachments' ? recorded.get(i.sessionId.toLowerCase()) : undefined
      if (id) bySession.set(id, [...(bySession.get(id) ?? []), i])
      else rest.push(i)
    }
    for (const [id, group] of bySession) {
      if (keepsAll.has(id.toLowerCase())) {
        group.forEach((i) => skipFor(i, M_PURGE.sessionChanged))
        continue
      }
      const backups = group.filter((i) => i.kind === 'backup')
      const leftovers = group.filter((i) => i.kind === 'leftover-backup')
      const attached = group.filter((i) => i.kind === 'attachments')
      let attachedChanged: PurgeItem[] = []
      try {
        const r = await sessions.purge(
          host,
          id,
          { backups: backups.map((i) => i.path!), leftovers: leftovers.map((i) => i.path!), attachments: attached.length > 0, keptUsage: group.some((i) => i.kind === 'kept-usage'), lastCopy: backups.some((i) => i.lastCopy) },
          remove,
          async () => {
            attachedChanged = await removeAttachments(host, dirname(attached[0].path!), attached, permanent)
          },
          // With the session reserved and its backups locked, just before anything goes.
          async () => {
            for (const i of backups) if (!unchanged(i, await fileNow(i.path!))) throw combworkError(M_PURGE.sessionChanged)
            // A leftover gone since is fine (sessions.purge passes over it); one written to isn't what was listed.
            for (const i of leftovers) {
              const now = await fileNow(i.path!)
              if (now && !unchanged(i, now)) throw combworkError(M_PURGE.sessionChanged)
            }
          }
        )
        group.filter((i) => !attachedChanged.includes(i)).forEach(done)
        attachedChanged.forEach((i) => skipFor(i, M_PURGE.changed))
        if (r.deleted) result.deleted++
      } catch (e) {
        group.forEach((i) => skip(i, e))
      }
    }
    // What is left of sessions Combwork no longer has: a deleted session's old usage, its backups' files, its attachments (a folder at a time).
    const folders = new Map<string, PurgeItem[]>()
    for (const i of rest) {
      if (i.kind === 'orphan-attachments') {
        folders.set(dirname(i.path!), [...(folders.get(dirname(i.path!)) ?? []), i])
        continue
      }
      try {
        if (i.kind === 'deleted-usage') await purgeDeletedUsage(host, i.sessionId!)
        else await whileUnclaimed(host, i.sessionId!, async () => {
          if (!unchanged(i, await fileNow(i.path!))) throw combworkError(M_PURGE.changed)
          await remove(i.path!)
        })
        done(i)
      } catch (e) {
        skip(i, e)
      }
    }
    for (const [dir, list] of folders) {
      try {
        const changed = await whileUnclaimed(host, basename(dir), () => removeAttachments(host, dir, list, permanent))
        list.filter((i) => !changed.includes(i)).forEach(done)
        changed.forEach((i) => skipFor(i, M_PURGE.changed))
      } catch (e) {
        list.forEach((i) => skip(i, e))
      }
    }
    forgetStorage(host)
    workspaceOf(host).scheduleRefresh()
  }
  const found = new Set(chosen.map((i) => i.key.toLowerCase()))
  for (const k of listed) if (!found.has(String(k).toLowerCase())) result.skipped.push({ key: String(k), reason: tr(M_PURGE.noLonger) })
  log.info(`Purge (${target.kind}${permanent ? ', permanently' : ''}): ${result.removed} item(s), ${result.bytes} bytes, ${result.deleted} session(s) deleted${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`)
  return result
}

/**
 * Runs fn on what is left of a session Combwork no longer has (`name`: its id, or run-<launch>), with that name reserved so
 * no session starts under it meanwhile, once no record or launch has it now.
 */
async function whileUnclaimed<T>(host: string, name: string, fn: () => Promise<T>): Promise<T> {
  return sessions.whileCleaning(host, name, async () => {
    const lower = name.toLowerCase()
    if ((await workspace.sessionsFile(host)).sessions.some((s) => s.id.toLowerCase() === lower)) throw combworkError(msg({ id: 'main.storage.purgeClaimed', defaultMessage: 'It belongs to a session again.', description: 'Purge skipped a file or folder of a session Combwork no longer had: it has one again.' }))
    // After the read above: nothing is awaited between this check and fn's first look at the files.
    if (sessions.liveAnywhere(name) || sessions.projectStates(host).some((s) => `run-${s.runId}`.toLowerCase() === lower)) throw combworkError(msg({ id: 'main.storage.purgeRunning', defaultMessage: 'Its session is running.', description: 'Purge skipped a file or folder: its session is running now.' }))
    return fn()
  })
}

/** A deleted session's old kept usage (deletedUsage): recorded in the usage history now, then dropped from the host's records. */
async function purgeDeletedUsage(host: string, id: string): Promise<void> {
  const k = (await workspace.sessionsFile(host)).deletedUsage?.find((x) => x.id === id)
  if (!k) return
  if (!(await usageHistory.recordKept(host, k).catch(() => false))) throw combworkError(msg({ id: 'main.storage.purgeUnrecorded', defaultMessage: "Combwork couldn't record it in the usage history, so it is kept.", description: "Purge kept a deleted session's old usage: Combwork couldn't save it in the usage history, which the totals keep." }))
  await workspace.mutateSessions(host, (f) => {
    if (f.deletedUsage?.some((x) => x.id === id)) f.deletedUsage = f.deletedUsage.filter((x) => x.id !== id)
  })
}

/** Forgets a project's last measurement (a worktree was removed, #353): the next look measures again. */
export function forgetStorage(projectPath: string): void {
  results.delete(projectPath.toLowerCase())
}
