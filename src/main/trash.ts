import { basename, join } from 'path'
import { appendFile, mkdir, rename } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { app, shell } from 'electron'
import { createLogger, userText } from './logger'
import { takesTestSeams } from './testQuiet'

const log = createLogger('trash')

/**
 * Hive's one way to delete what the user can see (files, notes, skills, templates, cards, backups, projects): to the
 * Recycle Bin, so it can be restored (#414). Nothing in main calls `shell.trashItem` itself (tests/trash.test.ts).
 *
 * Test copies of Hive never touch the user's Recycle Bin: an unpackaged build, or a quiet packaged one (CW_TEST_QUIET=1,
 * which the suites start dist\win-unpacked with: takesTestSeams, #1599), with CW_TEST_TRASH_DIR (the run context gives
 * every test copy one, in the suite's own folder) or with a test profile (CW_USER_DATA: then `<profile>/test-trash`)
 * moves the item into that folder instead, and notes it in `trash.jsonl` there, so suites can check it arrived.
 * `npm run dev` (no test profile) and the installed app (never quiet) use the Recycle Bin.
 */
export function testTrashDir(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): string | null {
  if (!takesTestSeams(env, packaged)) return null
  if (env.CW_TEST_TRASH_DIR) return env.CW_TEST_TRASH_DIR
  return env.CW_USER_DATA ? join(env.CW_USER_DATA, 'test-trash') : null
}

let moved = 0

/**
 * Pauses between tries of a move Windows refuses for a moment (#668): an antivirus scan, the search indexer or a program
 * closing a file in it holds a handle briefly, and moving a folder fails while anything in it is open. Tried again after
 * each pause (about 1.5 s in all); a program that keeps it open is still refused, and the caller says so.
 */
const HELD_RETRY_MS = [50, 100, 200, 400, 800]
const HELD_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** move(), tried again while held(error) says what stopped it may pass; then its last error stands. */
async function whileHeld(path: string, move: () => Promise<void>, held: (e: unknown) => boolean): Promise<void> {
  for (let tried = 0; ; tried++) {
    try {
      await move()
      if (tried) log.info(`Moved ${userText(path)} to the Recycle Bin on try ${tried + 1}: it was in use for a moment`)
      return
    } catch (e) {
      if (tried >= HELD_RETRY_MS.length || !held(e)) throw e
    }
    await new Promise((r) => setTimeout(r, HELD_RETRY_MS[tried]))
  }
}

/**
 * Moves a file or folder to the Recycle Bin (or a test copy's trash folder). It resolves once the item has gone, and
 * rejects only when it hasn't, changing nothing (callers rely on that: Delete Project says "Nothing was deleted", a
 * group's delete puts back what had gone). A move Windows refuses because something has the item open is tried again
 * for a moment first (`whileHeld`, #668).
 *
 * In a test copy the move is one rename, whole or not at all: an item on another drive than the trash folder is refused
 * (a copy and remove could fail halfway, leaving parts of it in both places). Noting the move in `trash.jsonl` comes
 * after it and is best effort: a note that can't be written is logged as a warning, and never turns the deletion,
 * which has happened, into a failure.
 */
export async function trash(path: string): Promise<void> {
  const dir = testTrashDir()
  // The Recycle Bin's failures carry no code: tried again while the item is still there to move.
  if (!dir) return whileHeld(path, () => shell.trashItem(path), () => existsSync(path))
  await mkdir(dir, { recursive: true })
  // A name of its own: the same name can be deleted twice in a run.
  const to = join(dir, `${Date.now()}-${process.pid}-${++moved}-${basename(path)}`)
  try {
    await whileHeld(path, () => rename(path, to), (e) => HELD_CODES.has((e as NodeJS.ErrnoException).code ?? ''))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    throw new Error(`${path} is on another drive than the test trash folder (${dir}): a test copy of Hive only moves within a drive, so nothing is half deleted. Nothing was changed.`, { cause: e })
  }
  await appendFile(join(dir, 'trash.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), from: path, to })}\n`).catch((e) => log.warn(`Moved ${userText(path)} to the test trash folder, but could not note it in its trash.jsonl`, e))
}
