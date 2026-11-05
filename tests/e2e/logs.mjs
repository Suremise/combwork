// Where a run's logs go (run.mjs): a folder of its own for each run, so no run overwrites another's logs or record, and
// only the latest few finished ones kept, with those of the last day up to a size (pruneRunDirs). A run still going (this runner's or another's) is marked active and never
// pruned. A runner started inside a suite (progressreport runs one) keeps its runs apart, under logs/nested, so they
// never push real runs out.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { parentSuite } from './runner.mjs'

const { linkOnPath } = createRequire(import.meta.url)('./evidence.cjs')

/** How many run folders are kept, at the top level and under nested/ each. */
export const KEEP_RUNS = 10
/**
 * Beyond KEEP_RUNS, every run that started in the last KEEP_HOURS is kept too (#1595: with several lanes testing, ten
 * newer runs came within the hour, before a reviewer opened the run a builder cited), as long as the run folders under
 * a root come to no more than KEEP_MB: past it, the oldest passing runs the window keeps go first, then the failed
 * ones. Never one of the newest KEEP_RUNS. CW_E2E_KEEP_HOURS and CW_E2E_KEEP_MB change them (logRetention).
 */
export const KEEP_HOURS = 24
export const KEEP_MB = 2048
const RUN_DIR = /^run-(\d{8}-\d{6})(?:-(\d+))?$/
/** In a run folder while its runner is still going: the runner's process id. */
const ACTIVE = '.active'
/** A marker older than this is from a runner that never finished (or one stuck far beyond any run). */
const ACTIVE_MAX_MS = 24 * 60 * 60_000

/** Whether a process is still running (signal 0 only checks; EPERM means it exists but isn't ours). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The logs folder for this runner: logs/, or logs/nested for a runner started inside a suite (runner.mjs's
 * parentSuite). */
export function logsRootFor(work, env = process.env) {
  return parentSuite(env) ? join(work, 'logs', 'nested') : join(work, 'logs')
}

/** `run-<date>-<time>` in local time. */
export function runDirName(when) {
  const pad = (n) => String(n).padStart(2, '0')
  return `run-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
}

/**
 * Creates a new run folder under root and returns its path: `run-<date>-<time>`, or with `-2`, `-3`… when another run
 * started in the same second. The suffix is always above any already there for that second, so a name is never reused
 * after pruning (a newer run never sorts as older). Each name is created exclusively (mkdir fails if it exists), so two
 * runners at once never share one, whichever creates it first.
 */
export function newRunDir(root, when = new Date(), owner = process.pid) {
  mkdirSync(root, { recursive: true })
  const base = runDirName(when)
  const taken = readdirSync(root).map((name) => RUN_DIR.exec(name)).filter((m) => m && `run-${m[1]}` === base).map((m) => Number(m[2] ?? 1))
  for (let n = taken.length ? Math.max(...taken) + 1 : 1; ; n++) {
    const dir = join(root, n === 1 ? base : `${base}-${n}`)
    try {
      mkdirSync(dir)
      // Active until its runner finishes (finishRunDirs): no other runner prunes it meanwhile.
      writeFileSync(join(dir, ACTIVE), String(owner))
      return dir
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/** The runner has finished with these folders (its record is saved): they count as finished runs from now. */
export function finishRunDirs(dirs) {
  for (const dir of dirs) rmSync(join(dir, ACTIVE), { force: true })
}

/**
 * A run that failed (a suite failed, or its record isn't valid) is kept beyond KEEP_RUNS for a day (#223): with several
 * agents testing at once, ten newer runs can come within minutes, before a reviewer reads the failure a builder cited.
 * At most FAILED_MAX of them, the newest; after a day, the usual rule. (A run a card cites stays anyway: evidence.cjs.)
 */
export const FAILED_KEEP_MS = 24 * 60 * 60_000
export const FAILED_MAX = 20
/** In a run folder whose run failed: what failed. Its time is when the run ended. */
const FAILED = '.failed'

/** Marks a run folder as a failed run's (what: the failed suites, or why its record isn't valid). */
export function markRunFailed(dir, what) {
  writeFileSync(join(dir, FAILED), `${what}\n`)
}

/** When a run folder was marked failed (ms), or null. */
export function runFailedAt(dir) {
  try {
    return statSync(join(dir, FAILED)).mtimeMs
  } catch {
    return null
  }
}

/** A suite's folder of screenshots or reports (`restart-shots`, `pshots`, `screenshots`, `artifacts`, `reports`), kept with its files. */
export const EVIDENCE_DIR = /shots$|^(?:screenshots|artifacts|reports)$/i
/**
 * What is never kept, at any depth, inside a screenshot folder too: a profile (`board-profile`), a workspace (`board-ws`,
 * `ws-b`, `ws2`, `x-ws.worktrees`), a CLI home (`board-claude-home`, `codex`) or node_modules; and sign-in files.
 */
export const PROTECTED_DIR = /(?:^|-)(?:profile|ws\d*|ws-[a-z0-9]+|ws\.worktrees|home|claude-home|codex-home|claude|codex)$|^node_modules$/i
export const PROTECTED_FILE = /^(?:\.credentials\.json|auth\.json)$/i
/**
 * A suite's fake Claude Code home (`board-claude-home`, lib.cjs) and the file in it that says how each launch ended: its
 * exit code or the error it didn't catch (fake-claude.cjs, #551). Kept from a failed suite (#1146: a fake that exited 1
 * mid-run, whose reason the next run over the lane wiped).
 */
const CLAUDE_HOME = /-claude-home$/i
const FAKE_EXITS = 'fake-exits.jsonl'
const isPlainFile = (p) => {
  try {
    return lstatSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Keeps a suite's own files with its run (#223, #284; a failed suite's, or with --keep-files a passed one's): the files
 * at the top of its folder (screenshots, notification logs, reports) and everything in its folders of screenshots or
 * reports (EVIDENCE_DIR, at any depth, as laid out), copied to <run folder>/<suite>, where they stay as long as the
 * run's logs, whatever later runs do to the lane. Never its other folders, and never a profile, workspace, CLI home or
 * sign-in file at any depth, inside a screenshot folder too (PROTECTED_DIR, PROTECTED_FILE), except a fake Claude Code
 * home's FAKE_EXITS, kept as `<home>.fake-exits.jsonl`. Never through a link: a
 * suite folder with a link anywhere on its path is not read at all, and a junction or symlink inside it is left out,
 * not followed. Left out too: a file over maxBytes, and whatever would go past maxFiles or maxTotal; a folder's files
 * are copied before its folders, so a report beside folders of screenshots is kept when they run past a limit. Returns
 * { copied, omitted: [{ path, why }] }, paths relative to the suite folder ('.' for the folder itself).
 */
export function keepSuiteFiles(suiteDir, runDir, name, { maxBytes = 20 * 1024 * 1024, maxFiles = 500, maxTotal = 200 * 1024 * 1024 } = {}) {
  const size = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`)
  const result = { copied: 0, omitted: [] }
  // A link on the way to the suite's folder (or the folder itself one) would copy from wherever it points.
  const link = linkOnPath(suiteDir)
  if (link) {
    result.omitted.push({ path: '.', why: `reached through a link (${link}): not read` })
    return result
  }
  let total = 0
  /** Copies the suite folder's file `r` to `to` in the run's copy (the same path by default), within the limits. */
  const keep = (r, to = r) => {
    try {
      const bytes = statSync(join(suiteDir, r)).size
      if (bytes > maxBytes) result.omitted.push({ path: r, why: `over ${size(maxBytes)}` })
      else if (result.copied >= maxFiles) result.omitted.push({ path: r, why: `past ${maxFiles} files` })
      else if (total + bytes > maxTotal) result.omitted.push({ path: r, why: `past ${size(maxTotal)} in all` })
      else {
        mkdirSync(dirname(join(runDir, name, to)), { recursive: true })
        copyFileSync(join(suiteDir, r), join(runDir, name, to))
        result.copied++
        total += bytes
      }
    } catch {
      // Gone or in use: the rest are still copied.
    }
  }
  const visit = (rel, inEvidence) => {
    let entries
    try {
      entries = readdirSync(join(suiteDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    // Files first (a stable sort: by name within each).
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()))
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name
      if (e.isSymbolicLink()) {
        if (inEvidence || EVIDENCE_DIR.test(e.name) || !rel) result.omitted.push({ path: r, why: 'a link (not followed)' })
        continue
      }
      if (e.isDirectory()) {
        if (PROTECTED_DIR.test(e.name)) {
          if (inEvidence) result.omitted.push({ path: r, why: 'a profile, workspace or CLI home' })
          // From a fake Claude Code's home, only how each launch ended (FAKE_EXITS, #1146), beside it as one file.
          else if (!rel && CLAUDE_HOME.test(e.name)) {
            const exits = join(r, FAKE_EXITS)
            if (isPlainFile(join(suiteDir, exits))) keep(exits, `${e.name}.${FAKE_EXITS}`)
          }
        } else if (inEvidence || EVIDENCE_DIR.test(e.name)) visit(r, true)
        continue
      }
      if (!e.isFile()) continue
      if (PROTECTED_FILE.test(e.name)) {
        result.omitted.push({ path: r, why: 'a sign-in file' })
        continue
      }
      keep(r)
    }
  }
  visit('', false)
  return result
}

/** What keepSuiteFiles left out, said in a line ("big.png (over 20 MB), linked (a link …)", the first few). */
export const omittedLine = (omitted, max = 5) =>
  omitted.slice(0, max).map((o) => `${o.path} (${o.why})`).join(', ') + (omitted.length > max ? ` and ${omitted.length - max} more` : '')

/** Whether a run folder's runner is still going: it is marked active by a process that is still running, recently. */
export function runDirActive(dir, alive = processAlive, now = Date.now()) {
  const marker = join(dir, ACTIVE)
  if (!existsSync(marker)) return false
  try {
    const pid = Number(readFileSync(marker, 'utf8'))
    return Number.isInteger(pid) && pid > 0 && alive(pid) && now - statSync(marker).mtimeMs < ACTIVE_MAX_MS
  } catch {
    return false
  }
}

/** Run folders oldest first: by time, then by suffix (run-…-2 after run-…, run-…-10 after run-…-9). */
export function runDirsInOrder(names) {
  const key = (name) => {
    const m = RUN_DIR.exec(name)
    return m ? [m[1], Number(m[2] ?? 1)] : null
  }
  return names.filter((n) => key(n)).sort((a, b) => {
    const [ta, na] = key(a)
    const [tb, nb] = key(b)
    return ta < tb ? -1 : ta > tb ? 1 : na - nb
  })
}

/**
 * The window and size cap from the environment (KEEP_HOURS, KEEP_MB): CW_E2E_KEEP_HOURS and CW_E2E_KEEP_MB, each a
 * number of 0 or more (0 hours: only the newest KEEP_RUNS and failed runs; 0 MB: nothing past KEEP_RUNS by size). A
 * value that isn't one keeps the default and is named in `bad`. Returns { keepMs, maxBytes, bad }.
 */
export function logRetention(env = process.env) {
  const bad = []
  const read = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
    bad.push(`${name}=${raw}`)
    return fallback
  }
  return { keepMs: read('CW_E2E_KEEP_HOURS', KEEP_HOURS) * 3_600_000, maxBytes: read('CW_E2E_KEEP_MB', KEEP_MB) * 1024 * 1024, bad }
}

/** When a run started (ms), from its folder's name (local time), or null. */
export function runStartedAt(name) {
  const m = RUN_DIR.exec(name)
  if (!m) return null
  const at = (from, to) => Number(m[1].slice(from, to))
  return new Date(at(0, 4), at(4, 6) - 1, at(6, 8), at(9, 11), at(11, 13), at(13, 15)).getTime()
}

/** The bytes of the files in a folder, at any depth, never through a link (a file gone meanwhile counts nothing). */
export function folderBytes(dir) {
  let total = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) total += folderBytes(join(dir, e.name))
    else if (e.isFile()) {
      try {
        total += lstatSync(join(dir, e.name)).size
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return total
}

/**
 * Removes the finished run folders under root that nothing keeps. Kept are: the newest `keep` finished ones; every one
 * that started within `keepMs` (#1595); and a failed run less than a day old (the newest FAILED_MAX of them: #223). The
 * window and the failed runs are bounded by `maxBytes`: while the run folders under root (every one left, active ones
 * too) come to more, the oldest passing runs only they keep go, then the failed ones (never the newest `keep`).
 * Never pruned at all: one still active (another runner's, or an unfinished repeat's earlier runs), one in `protect`
 * (the runner prunes once, after saving its record, and protects its own runs, so a repeat of more than `keep` keeps
 * them all until the next runner prunes), and nothing that isn't a run folder (nested/, run-record.md). Nor one
 * spare(path) keeps (#253: a card cites it as evidence, or the board can't be read: evidence.cjs); those don't count
 * towards `keep`. onOverCap(names, bytes), if given, is told of the runs the cap removes and the size before them.
 * A run folder something still holds (#1616: another process's handle, a scan) is kept for a later prune, not a failure:
 * onKept(name, code), if given, is told of it. Returns the runs removed.
 */
export function pruneRunDirs(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null, options = {}) {
  const old = runDirsToPrune(root, keep, protect, alive, spare, options)
  return old.filter((name) => removeRunDir(root, name, options.onKept))
}

/**
 * pruneRunDirs for the runner (#285): before each run folder goes, release(runDir) removes what the run kept outside it
 * (its failed suites' folders in a lane: evidence.cjs releaseKept), awaited, in lanes it may work in. listSpare, if
 * given, is what the list of folders to go is made with (one look at the board for them all: evidence.cjs snapshot);
 * spare is then asked again before each folder's release and after it, just before the folder goes, so a card citing
 * one since the list, or while its release waited, keeps it (HI-2364: asking
 * the board afresh for every run folder kept the runner busy for over a minute after its record).
 */
export async function pruneRunDirsReleasing(root, keep = KEEP_RUNS, protect = [], alive = processAlive, spare = () => null, { release = async () => {}, listSpare = spare, ...options } = {}) {
  const old = runDirsToPrune(root, keep, protect, alive, listSpare, options)
  const removed = []
  for (const name of old) {
    if (listSpare !== spare && spare(join(root, name))) continue
    await release(join(root, name))
    // And again after the release, which can wait for a lane: a card citing the run meanwhile still keeps its logs.
    if (spare(join(root, name))) continue
    if (removeRunDir(root, name, options.onKept)) removed.push(name)
  }
  return removed
}

/** The errors of a folder something still holds open (Windows): such a run folder is kept, never a failed run (#1616). */
const HELD_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

/**
 * Removes a run folder (a few tries, as a scan lets go): whether it went. One still held is kept, onKept(name, code)
 * told of it, and the next prune tries again; any other error is thrown.
 */
function removeRunDir(root, name, onKept = () => {}) {
  try {
    rmSync(join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return true
  } catch (e) {
    if (!HELD_CODES.has(e?.code)) throw e
    onKept(name, e.code)
    return false
  }
}

/** The run folders pruneRunDirs removes (oldest first), without removing them. */
export function runDirsToPrune(
  root,
  keep = KEEP_RUNS,
  protect = [],
  alive = processAlive,
  spare = () => null,
  { now = Date.now(), keepMs = KEEP_HOURS * 3_600_000, maxBytes = KEEP_MB * 1024 * 1024, bytesOf = folderBytes, onOverCap = () => {} } = {}
) {
  if (!existsSync(root)) return []
  const mine = new Set(protect.map((p) => p.split(/[\\/]/).pop()))
  const all = runDirsInOrder(readdirSync(root))
  const finished = all.filter((name) => !runDirActive(join(root, name), alive) && !spare(join(root, name)))
  const failedRecently = new Set(
    finished
      .filter((name) => {
        const at = runFailedAt(join(root, name))
        return at !== null && now - at < FAILED_KEEP_MS
      })
      .slice(-FAILED_MAX)
  )
  const beyond = finished.slice(0, Math.max(0, finished.length - keep)).filter((name) => !mine.has(name))
  const inWindow = (name) => now - runStartedAt(name) < keepMs
  const old = beyond.filter((name) => !failedRecently.has(name) && !inWindow(name))
  // What the window and the failed runs keep, in the order the size cap takes them: passing runs, then failed, oldest first.
  const capped = beyond.filter((name) => !old.includes(name))
  if (!capped.length) return old
  const sizes = new Map(all.filter((name) => !old.includes(name)).map((name) => [name, bytesOf(join(root, name))]))
  const before = [...sizes.values()].reduce((a, b) => a + b, 0)
  let total = before
  const over = []
  for (const name of [...capped.filter((n) => !failedRecently.has(n)), ...capped.filter((n) => failedRecently.has(n))]) {
    if (total <= maxBytes) break
    over.push(name)
    total -= sizes.get(name)
  }
  if (over.length) onOverCap(over, before)
  return runDirsInOrder([...old, ...over])
}
