import { join, relative } from 'path'
import { lstat, readdir, rm } from 'original-fs/promises'
import { CW_DIR } from '../shared/defaults'
import { createLogger, userText } from './logger'
import { trash } from './trash'
import type { WorkspaceService } from './workspace'

const log = createLogger('leftovers')

/** A temp file of Hive's atomic writes: `<file>.<pid>-<counter>.tmp` (writeTextAtomic, syncCopy) or `<file>.<pid>-<hex>.tmp` (watches, deliveries). */
const TEMP = /^(.+)\.\d+-[0-9a-f]+\.tmp$/i
/** The copy the project-id migration (#508) kept of a record before first changing it. */
const BEFORE_IDS = /^(.+)\.before-ids\.bak$/i
/** A temp file older than this can't be a write still under way, in this Hive or another. */
export const TEMP_AGE_MS = 24 * 60 * 60 * 1000
/** A migration's copy is kept a week after it was made (an older Hive's workspace, just migrated, keeps it a while). */
export const BAK_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** What a store's move into the workspace database kept (#1017, #1018): `<name>.imported-<ISO time, ':' and '.' as '-'>`. */
const IMPORTED = /^(.+)\.imported-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/
/** Such a backup goes to the Recycle Bin two weeks after the move (#1111): time enough to go back to an older Hive. */
export const IMPORTED_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** What a move's backup was, and when its name says it was made; null for any other name. */
export function importedBackup(name: string): { base: string; at: number } | null {
  const m = IMPORTED.exec(name)
  if (!m) return null
  const at = Date.parse(`${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z`)
  return Number.isNaN(at) ? null : { base: m[1], at }
}

/**
 * One of Hive's stores: a folder (relative to a .combwork) and the files Hive writes there. Only a temp file of one of those
 * files (`temp`), the migration's copy of one it migrated (`bak`), or the backup kept when one moved into the workspace
 * database (`imported`), is ever removed: the same suffix on anything else (the user's notes, attachments, a folder Hive
 * doesn't know) is never taken for one.
 */
export interface Store {
  dir: string
  temp: RegExp
  bak?: RegExp
  imported?: RegExp
}

/** The workspace's .combwork: its settings and records, the board, metrics and the Assistant's home. */
export const WORKSPACE_STORES: Store[] = [
  // The board's card files moved as their folder, `tasks` (#1017).
  { dir: '.', temp: /^(workspace|lanes|watches|project-names|handover-owners|bundled)\.json(\.bak)?$/i, bak: /^(lanes|watches)\.json$/i, imported: /^(tasks|lanes\.json|watches\.json)$/i },
  { dir: 'tasks', temp: /^(\d+|board)\.json$/i, bak: /^\d+\.json$/i },
  { dir: 'metrics', temp: /^metrics\.json$/i, imported: /^metrics\.json$/i },
  { dir: join('metrics', 'benchmarks'), temp: /^[\w-]+\.json$/i },
  { dir: 'assistant', temp: /^(project|sessions|deliveries|sync)\.json(\.bak)?$/i, imported: /^(sessions|deliveries)\.json$/i },
  // Transcript backups, plain or compressed (#1110: compressing one, or decompressing one to archive it, writes aside).
  { dir: join('assistant', 'sessions'), temp: /^[\w-]+\.jsonl(\.gz)?$/i },
  { dir: join('assistant', 'archive'), temp: /^[\w-]+\.jsonl(\.gz)?$/i }
]

/** A project's .combwork: its settings, sessions and deliveries, and its transcript backups. */
export const PROJECT_STORES: Store[] = [
  { dir: '.', temp: /^(project|sessions|deliveries|sync)\.json(\.bak)?$/i, imported: /^(sessions|deliveries)\.json$/i },
  { dir: 'sessions', temp: /^[\w-]+\.jsonl(\.gz)?$/i },
  { dir: 'archive', temp: /^[\w-]+\.jsonl(\.gz)?$/i }
]

/**
 * Whether a store's folder is where it says, inside its .combwork: the .combwork and every folder down to it a real folder, never
 * a link or junction (which would make a folder outside it look like Hive's store).
 */
async function plainDir(combwork: string, dir: string): Promise<boolean> {
  let at = combwork
  for (const part of ['', ...dir.split(/[\\/]/).filter((x) => x && x !== '.')]) {
    at = part ? join(at, part) : at
    const st = await lstat(at).catch(() => null)
    if (!st?.isDirectory() || st.isSymbolicLink()) return false
  }
  return true
}

export interface Swept {
  /** Removed files, by kind, per folder. */
  removed: { dir: string; temp: number; bak: number; imported: number }[]
  temp: number
  bak: number
  imported: number
}

/**
 * Removes what Hive's writes left in its stores (#1016): temp files of its atomic writes a crash left (older than a day)
 * and the project-id migration's `*.before-ids.bak` copies (older than a week). Each root is a .combwork with its stores;
 * only the files each store names are looked at, in that folder only (not its subfolders), and only in a store that is a
 * real folder inside its .combwork, never one reached through a link or junction, and never a link to a file. What can't be removed (held
 * open) is left for the next open. Stops when `signal` is aborted, checked again just before each removal.
 * The backups kept when a store moved into the workspace database (#1111: the board's `tasks` folder, metrics.json…) go
 * two weeks after the move, by the time in their name, to the Recycle Bin (`trash`, given for tests), a folder whole.
 */
export async function sweepLeftovers(roots: { combwork: string; stores: Store[] }[], opts: { now?: number; signal?: AbortSignal; trash?: (path: string) => Promise<void> } = {}): Promise<Swept> {
  const now = opts.now ?? Date.now()
  const toBin = opts.trash ?? trash
  const out: Swept = { removed: [], temp: 0, bak: 0, imported: 0 }
  for (const root of roots) {
    for (const store of root.stores) {
      if (opts.signal?.aborted) return out
      const dir = join(root.combwork, store.dir)
      if (!(await plainDir(root.combwork, store.dir))) continue
      const names = await readdir(dir).catch(() => [] as string[])
      let temp = 0
      let bak = 0
      let imported = 0
      for (const name of names) {
        const t = TEMP.exec(name)?.[1]
        const b = t === undefined ? BEFORE_IDS.exec(name)?.[1] : undefined
        const i = t === undefined && b === undefined ? importedBackup(name) : null
        const kind = t !== undefined && store.temp.test(t) ? 'temp' : b !== undefined && store.bak?.test(b) ? 'bak' : i && store.imported?.test(i.base) ? 'imported' : null
        if (!kind) continue
        const file = join(dir, name)
        // The file itself, not what a link points to.
        const st = await lstat(file).catch(() => null)
        if (kind === 'imported') {
          // A file or a real folder, never a link or junction; its age is its name's.
          if (!st || st.isSymbolicLink() || !(st.isFile() || st.isDirectory()) || now - i!.at < IMPORTED_AGE_MS) continue
          if (opts.signal?.aborted) break
          if (!(await toBin(file).then(() => true, (e) => (log.warn(`couldn't move ${userText(file)} to the Recycle Bin: tried again at the next open`, e), false)))) continue
          imported++
          continue
        }
        // Made when: a copy keeps its source's modified time on Windows, so its creation time says when it was made.
        if (!st?.isFile() || now - Math.max(st.mtimeMs, st.birthtimeMs) < (kind === 'temp' ? TEMP_AGE_MS : BAK_AGE_MS)) continue
        if (opts.signal?.aborted) break
        if (!(await rm(file).then(() => true, () => false))) continue
        if (kind === 'temp') temp++
        else bak++
      }
      if (temp || bak || imported) {
        out.removed.push({ dir, temp, bak, imported })
        out.temp += temp
        out.bak += bak
        out.imported += imported
      }
    }
  }
  return out
}

/**
 * The sweep for a workspace as it opens: its .combwork and its projects' (hidden ones too), told in the log once. The
 * workspace and its lifetime are taken together before anything is awaited: if it closes or the window opens another
 * meanwhile, nothing more is removed, and nothing of the next workspace's is ever looked at.
 */
export async function sweepWorkspaceLeftovers(ws: WorkspaceService): Promise<Swept | null> {
  const path = ws.path
  const life = ws.lifetime
  if (!path) return null
  const still = (): boolean => !life.aborted && ws.path === path
  const shown = await ws.listProjectPaths()
  if (!still()) return null
  const hidden = await ws.listProjectPaths({ hidden: true })
  if (!still()) return null
  const roots = [{ combwork: join(path, CW_DIR), stores: WORKSPACE_STORES }, ...[...shown, ...hidden].map((p) => ({ combwork: join(p, CW_DIR), stores: PROJECT_STORES }))]
  const swept = await sweepLeftovers(roots, { signal: life })
  if (swept.temp || swept.bak || swept.imported) {
    const where = swept.removed.map((r) => `${userText(relative(path, r.dir))} (${[r.bak ? `${r.bak} .before-ids.bak` : '', r.temp ? `${r.temp} .tmp` : '', r.imported ? `${r.imported} .imported to the Recycle Bin` : ''].filter(Boolean).join(', ')})`).join('; ')
    log.info(`removed ${swept.bak} old migration backup(s), ${swept.temp} leftover temp file(s) and ${swept.imported} backup(s) of the move into the workspace database from ${userText(path)}: ${where}`)
  }
  return swept
}
