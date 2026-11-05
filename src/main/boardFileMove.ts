import { readdir, rename, rm, stat } from 'original-fs/promises'
import { join } from 'path'
import { msg, tr } from '../shared/i18n'
import { toast } from './events'
import { combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { ifAbsent, present } from './fsPresence'

/**
 * The board's file renamed `hive.db` → `combwork.db` (HI-2587, its design HI-2587/s15, s20, s23, s26), with its copies in
 * `backups/`. Part of the one-way names upgrade (nameUpgrade.ts): it runs at a workspace's open, under the folder move's
 * lock (combworkMove.ts), before anything of the workspace is admitted, so no connection of this process or another
 * Combwork has the file open. Whether it is needed comes from the files alone: any old-name file of the board's.
 *
 * - `hive.db` alone: checkpointed and closed in a worker (its log folded in, a crash's rollback journal rolled back),
 *   then, only once no log or journal with anything in it is left beside it, renamed: one rename of a file that holds
 *   everything. Then the empty leftovers go.
 * - `hive.db` beside `combwork.db` (made again since): `combwork.db` is used, the old file and its sidecars left byte
 *   for byte, and a warning each open while both are there.
 * - No `hive.db`: only leftovers of a crash after the rename. Empty ones go; one holding anything is never deleted:
 *   kept with a warning beside `combwork.db`, and with no board file at all the open is refused for as long as it is
 *   there (it may hold the only copy of what was written), naming the file and how to put the board back.
 */

const log = createLogger('nameUpgrade')

export const OLD_DB_FILE = 'hive.db'
export const NEW_DB_FILE = 'combwork.db'
/** SQLite's files beside a database: its write-ahead log, the log's index and a rollback journal. */
const SIDECARS = ['-wal', '-shm', '-journal'] as const
/** The old families of the board's copies in `backups/` (db.ts's names): `hive-v…`, `hive-before-1.0-v…`, `hive-before-restore-v…`. */
const OLD_BACKUP = /^hive-(v\d|before-)/

const M = {
  notFolded: msg({ id: 'service.nameUpgrade.boardNotFolded', defaultMessage: "Combwork couldn't rename the board's file {file} to combwork.db: its log {log} still holds changes after it was closed. Close any other program using the workspace, then open it again. Nothing was lost.", description: 'An error opening a workspace (HI-2587): the task board database, renamed combwork.db in this version, still had changes in its SQLite log beside it, so it was left as it is. {file} and {log} are file paths. Keep combwork.db as it is (a file name).' }),
  orphan: msg({ id: 'service.nameUpgrade.boardOrphan', defaultMessage: "The workspace's board file is missing, but {file} beside where it was holds changes that may be the only copy of them. Combwork won't start an empty board over it. Close Combwork, put the board's file back as hive.db beside it (from .combwork\\backups or another copy), then open the workspace again.", description: "An error opening a workspace (HI-2587): no task board database is there, but an SQLite log or journal of the old one (hive.db) is, holding data. {file} is its path. Keep hive.db and .combwork\\backups as they are (file and folder names)." }),
  bothTitle: msg({ id: 'main.nameUpgrade.boardBothTitle', defaultMessage: '{folder} has both hive.db and combwork.db', description: "A warning's title as a workspace opens (HI-2587): its folder {folder} holds the task board's database under both its old name and its new one. Keep hive.db and combwork.db as they are (file names)." }),
  bothBody: msg({ id: 'main.nameUpgrade.boardBothBody', defaultMessage: 'Combwork uses combwork.db and leaves hive.db as it is.', description: 'The warning\'s text (HI-2587): which of the two files Combwork uses; it never changes the other. Keep hive.db and combwork.db as they are.' }),
  leftTitle: msg({ id: 'main.nameUpgrade.boardLeftTitle', defaultMessage: '{file} was left as it is', description: "A warning's title as a workspace opens (HI-2587): an SQLite log or journal of the board's old file (hive.db) still holds data, beside the board's new file; {file} is its path." }),
  leftBody: msg({ id: 'main.nameUpgrade.boardLeftBody', defaultMessage: "The board opens from combwork.db. Combwork doesn't delete this file: it may hold changes from before the rename.", description: 'The warning\'s text (HI-2587). Keep combwork.db as it is (a file name).' })
}

/** Test hooks: after each point of the move, to stop it there (a crash halfway). */
export const boardMoveTestHooks: { after?: (point: 'checkpointed' | 'renamed' | 'leftover') => void | Promise<void> } = {}

const sizeOf = async (f: string): Promise<number | null> => {
  try {
    return (await stat(f)).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Whether the board's files in this `.combwork` still have an old name: the file, a sidecar of it, or a copy of it. */
export async function boardFileNeeded(dir: string): Promise<boolean> {
  if (present(join(dir, OLD_DB_FILE)) || SIDECARS.some((s) => present(join(dir, OLD_DB_FILE + s)))) return true
  return (await oldBackups(dir)).length > 0
}

async function oldBackups(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, 'backups')).catch(ifAbsent([] as string[]))
  return names.filter((n) => OLD_BACKUP.test(n) && n.endsWith('.db'))
}

const warned = new Set<string>()
function warnOnce(key: string, title: string, body: string): void {
  if (warned.has(key)) return
  warned.add(key)
  toast('warning', title, body)
}

/** The sidecars of the old name that hold something, after the empty ones are removed. */
async function leftovers(dir: string): Promise<string[]> {
  const kept: string[] = []
  for (const s of SIDECARS) {
    const f = join(dir, OLD_DB_FILE + s)
    const size = await sizeOf(f)
    if (size === null) continue
    // The log's index is never data; an empty log or journal holds nothing.
    if (s === '-shm' || size === 0) await rm(f, { force: true })
    else kept.push(f)
    await boardMoveTestHooks.after?.('leftover')
  }
  return kept
}

/**
 * Moves the board's file in `dir` (a workspace's `.combwork`) to its new name, as the header says. `checkpoint` folds
 * the old file's log in and closes it (in a worker: combworkMove.ts's). Throws a CombworkError when it can't, nothing lost.
 */
export async function moveBoardFile(dir: string, checkpoint: (file: string) => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const oldFile = join(dir, OLD_DB_FILE)
  const newFile = join(dir, NEW_DB_FILE)
  if (present(oldFile)) {
    if (present(newFile)) {
      log.warn(`${userText(dir)} has both ${OLD_DB_FILE} and ${NEW_DB_FILE}: ${NEW_DB_FILE} is used, ${OLD_DB_FILE} is left as it is`)
      warnOnce(`both:${dir.toLowerCase()}`, tr(M.bothTitle, { folder: dir }), tr(M.bothBody))
      await moveBackups(dir)
      return
    }
    const done = await checkpoint(oldFile)
    if (!done.ok) throw new Error(done.error ?? 'the checkpoint failed') // i18n-ignore: the error's detail, for the phase's message
    await boardMoveTestHooks.after?.('checkpointed')
    for (const s of ['-wal', '-journal'] as const) {
      const size = await sizeOf(oldFile + s)
      if (size) throw combworkError(M.notFolded, { file: oldFile, log: oldFile + s }, { kind: 'conflict' })
    }
    // Never onto a file that is there (Node's rename replaces it on Windows): looked at again, under the move's lock.
    if (present(newFile)) throw combworkError(M.notFolded, { file: oldFile, log: newFile }, { kind: 'conflict' })
    await rename(oldFile, newFile)
    log.info(`Renamed ${userText(oldFile)} to ${NEW_DB_FILE}`)
    await boardMoveTestHooks.after?.('renamed')
  }
  const kept = await leftovers(dir)
  if (kept.length) {
    if (!present(newFile)) throw combworkError(M.orphan, { file: kept[0] }, { kind: 'conflict' })
    for (const f of kept) {
      log.warn(`${userText(f)} holds data beside ${NEW_DB_FILE}: left as it is`)
      warnOnce(`left:${f.toLowerCase()}`, tr(M.leftTitle, { file: f }), tr(M.leftBody))
    }
  }
  await moveBackups(dir)
}

/** The board's copies in `backups/` renamed to the new family, each on its own: one already there is left, the old kept. */
async function moveBackups(dir: string): Promise<void> {
  const b = join(dir, 'backups')
  for (const n of await oldBackups(dir)) {
    const to = join(b, n.replace(/^hive-/, 'combwork-'))
    if (present(to)) continue
    await rename(join(b, n), to)
  }
}
