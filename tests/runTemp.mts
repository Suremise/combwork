// A test run's own temp folder (#995, HI-2102), in the test area, %LOCALAPPDATA%\hive-test\tmp (#992), not %TEMP%:
// Combwork's Antivirus scanning setting covers the test area, and what tests make and remove in %TEMP% kept Defender busy.
// Each run has its own folder there, run-<pid>-<random>, made as it starts and made its temp folder (TEMP, TMP and
// TMPDIR), which what it starts inherits: the unit run (vitest.config.ts, before the workers start; tests/tempRun.ts
// removes it once the run has ended) and the e2e and scenario runners (before their suites, removed as they exit), so
// Vitest's module copies, Playwright's playwright-artifacts-* folders, and the temp files of Combwork's code under test, the
// test copies of Combwork, git and the CLIs go there. A run's start removes the folders older than a day that stopped runs
// left, where the board's evidence rules let them go; npm run test:clean (tests/e2e/clean.mjs) sweeps the rest of tmp.
// Where LOCALAPPDATA is unset (off Windows), it is in the temp folder. LOCALAPPDATA is read once, as this loads: a test
// that changes it later doesn't move the folder.
// The runners' as well as the unit tests' (tests/tempDir.ts gives its exports to the tests), so it is a .mts the
// runners load as they do tests/progressReport.mts.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

/** The test area's temp folder, hive-test\tmp: the runs' folders are in it. */
export const tempArea = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'tmp')
/** A run's folder older than this whose run has ended was left by a stopped run: the next run's start removes it. */
const STALE_MS = 24 * 60 * 60_000
let root: string | undefined

/**
 * Why a path must stay, or nothing when it may go: the board's evidence rules (tests/e2e/evidence.cjs protects: a card
 * that isn't Done cites it, or the board can't be read), asked afresh just before each removal.
 */
export type Protects = (path: string) => string | null | undefined

/**
 * Makes this run's own folder in the test area, run-<pid>-<random>, and makes it the temp folder (TEMP, TMP and TMPDIR)
 * of this process and what it starts (vitest.config.ts, before the workers start; the e2e and scenario runners, before
 * their suites), unless a run that started this one has already (a run inside a test sees its parent's). First, given
 * the evidence rules, it removes the folders stopped runs left (pruneRunTemps); without them it removes nothing. The
 * process that made it removes it (endRunTemp).
 */
export function startRunTemp(protects?: Protects): string {
  if (!process.env.HIVE_TEST_RUN_TMP) {
    mkdirSync(tempArea, { recursive: true })
    if (protects) pruneRunTemps(protects)
    process.env.HIVE_TEST_RUN_TMP = realpathSync.native(mkdtempSync(join(tempArea, `run-${process.pid}-`)))
    process.env.HIVE_TEST_RUN_TMP_OWNER = String(process.pid)
  }
  const dir = tempRoot()
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir
  return dir
}

/** Whether process `pid` is running (one we may not signal is). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the runs' folders in the test area that are older than a day, whose run isn't live (by the pid in the name;
 * a folder from before HI-2102 has none, and goes by its age) and that the evidence rules let go, asked just before
 * each removal (a recorded run's kept folder stays while a card cites it; nothing goes while the board can't be read):
 * what a run stopped before its end left. Replies with those removed. npm run test:clean sweeps the rest of tmp.
 */
export function pruneRunTemps(protects: Protects, { now = Date.now(), area = tempArea, isAlive = alive } = {}): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(area)
  } catch {
    return removed
  }
  for (const name of names) {
    const m = /^run-(?:(\d+)-)?/.exec(name)
    if (!m || (m[1] && isAlive(Number(m[1])))) continue
    const dir = join(area, name)
    try {
      if (now - statSync(dir).mtimeMs < STALE_MS || protects(dir)) continue
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      removed.push(dir)
    } catch {
      // In use, or gone meanwhile: the next start tries again.
    }
  }
  return removed
}

/** Removes this run's folder, if this process made it (tests/tempRun.ts, as the run ends). Replies with why it couldn't. */
export function endRunTemp(): string | undefined {
  const dir = process.env.HIVE_TEST_RUN_TMP
  if (!dir || process.env.HIVE_TEST_RUN_TMP_OWNER !== String(process.pid)) return undefined
  // Only ever a run's folder, directly in the test area.
  if (!basename(dir).startsWith('run-') || dirname(dir).toLowerCase() !== realpathSync.native(tempArea).toLowerCase()) return `not a run's folder: ${dir}`
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return undefined
  } catch (e) {
    return `${dir}: ${(e as Error).message}`
  }
}

/** The tests' temp folder by its real, long path, made if it isn't there: the run's own, or hive-test\tmp outside a run. */
export function tempRoot(): string {
  if (root) return root
  const dir = process.env.HIVE_TEST_RUN_TMP || tempArea
  mkdirSync(dir, { recursive: true })
  return (root = realpathSync.native(dir))
}
