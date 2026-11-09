// The e2e runner's decisions, kept pure so tests/e2esuites.test.ts can check them without running suites: what the
// command line asks for (parseArgs), which suites that is (selectSuites), and whether a run record can be trusted
// (recordStatus). run.mjs does the running.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { createRequire } from 'module'
import { join, posix } from 'path'

const { exitText } = createRequire(import.meta.url)('./windowsExits.cjs')

const VALUE_FLAGS = ['--jobs', '--affected', '--repeat', '--clear-dir', '--lang']
const PLAIN_FLAGS = ['--all', '--real', '--only-real', '--record', '--fingerprint', '--build', '--packaged', '--no-progress', '--no-wait', '--pre-merge', '--keep-files', '--warm-homes']

/** The suite --lang runs (#769): the i18n screenshot route, the one suite that isn't pinned to English. */
export const LANG_SUITE = 'i18nshots'
/**
 * What a run keeps of a suite's files (logs.mjs keepSuiteFiles' limits): its defaults, but room for every language a
 * --lang run photographed (#899: about 370 screenshots and 35 MB each, with the reports beside them).
 */
export const keepLimits = (name, lang = []) => (name === LANG_SUITE && lang.length ? { maxFiles: 100 + 450 * lang.length, maxTotal: (20 + 60 * lang.length) * 1024 * 1024 } : {})
/**
 * How long a suite may run before the runner stops it: 10 minutes, but 6 a language for a --lang run of more than one
 * (HI-2159: a language takes about 3 minutes, so a seven-language run reached four in 10).
 */
export const suiteLimitMs = (name, lang = []) => Math.max(10, name === LANG_SUITE ? 6 * lang.length : 0) * 60_000
/** A language tag as --lang takes it (pl, pt-BR, en-XA); whether Combwork has the language, the suite checks by starting it. */
const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

/** Whether a suite starts a real CLI (Claude Code, or Codex in its test home): the real tier, opt-in with --real. */
export const isRealCli = (s) => (s.needs ?? []).some((n) => n === 'claude' || n === 'codex' || n === 'agy')

/**
 * The CW_TEST_ seams a packaged Combwork ignores (src/main reads them in unpackaged builds only, #1591): a suite needing
 * one tests the dev build's behaviour. tests/e2esuites.test.ts checks every CW_TEST_ name src reads is here, in
 * or in PACKAGED_SEAMS.
 */
export const DEV_SEAMS = [
  'CW_TEST_ANTIVIRUS', 'CW_TEST_ANTIVIRUS_LOG', 'CW_TEST_BLOCK_IPC', 'CW_TEST_BOARD_UPGRADE', 'CW_TEST_CLI_HOME_CONNECTION', 'CW_TEST_CLI_LOG', 'CW_TEST_DAY_MS', 'CW_TEST_DECISION_SETTLE_MS',
  'CW_TEST_DELIVERY_OVERDUE_MS', 'CW_TEST_DETECT_WAIT_MS', 'CW_TEST_DROP_HOOKS', 'CW_TEST_FAIL_IPC', 'CW_TEST_FLIGHT_AFTER_MS',
  'CW_TEST_HOLD_AGENT_TEMP', 'CW_TEST_HOLD_DRAIN', 'CW_TEST_HOLD_IPC', 'CW_TEST_HOLD_MERGE_RECOVERY', 'CW_TEST_HOLD_TRUST', 'CW_TEST_HOLD_TYPED','CW_TEST_HOOKS_HOLD', 'CW_TEST_IDLE', 'CW_TEST_INSTALL_DIR', 'CW_TEST_JOB_KILL_FAILS', 'CW_TEST_LOG_DIRECT', 'CW_TEST_LOOP_GRACE_MS',
  'CW_TEST_MCP_LOG', 'CW_TEST_MERGE_CHOICE_CRASH', 'CW_TEST_MERGE_HOLD_MS', 'CW_TEST_MERGE_SLOT_LOG', 'CW_TEST_OPENCODE_PROVIDER', 'CW_TEST_ORPHAN_MS', 'CW_TEST_ORPHAN_POLL_MS', 'CW_TEST_PROCESS_TRACKER', 'CW_TEST_PROFILE_CHOOSE', 'CW_TEST_QUEUE_CRASH',
  'CW_TEST_QUEUE_RACE', 'CW_TEST_QUEUE_RETURNS', 'CW_TEST_REGISTRY_PATH', 'CW_TEST_RELAUNCH_LOG', 'CW_TEST_RESOURCES', 'CW_TEST_RUN_ON_CLOSE', 'CW_TEST_SILENT_MS',
  'CW_TEST_SLOT_CRASH', 'CW_TEST_SLOT_MIGRATION', 'CW_TEST_SLOW_DETECT', 'CW_TEST_SYSTEM_BROKER', 'CW_TEST_SYSTEM_BROKER_ACTIVE', 'CW_TEST_SLOW_IPC', 'CW_TEST_SLOW_LOG_MS', 'CW_TEST_STALL_QUIET_MS',
  'CW_TEST_START_VIEW_LOG', 'CW_TEST_TASKBAR_LOG', 'CW_TEST_TESTED_CLIS', 'CW_TEST_TRACKER_HEARD', 'CW_TEST_TRACKER_WAIT_MS',
  'CW_TEST_UPGRADE_HOLD', 'CW_TEST_WAKE_TAKE_MS'
]
/**
 * The seams a packaged Combwork honours too, when quiet (#1253: lib.combworkEnv starts every test copy quiet), among them the two
 * every test copy is given, CW_TEST_TIPS and CW_TEST_TRASH_DIR (#1599: takesTestSeams in src/main/testQuiet.ts).
 */
export const PACKAGED_SEAMS = ['CW_TEST_ASK_LEFTOVERS', 'CW_TEST_DIALOG_SNAPSHOT', 'CW_TEST_NOTIFY_LOG', 'CW_TEST_QUIET', 'CW_TEST_TIPS', 'CW_TEST_TOKEN_LOG', 'CW_TEST_TRASH_DIR']
/**
 * The test copies' channels a packaged Combwork refuses: 0.9 worktree agents (agents:testLegacy; `{ worktree: true })`, an
 * agent asked for in a worktree, as q.agent does; a 0.9 template's worktree modes) and slots:test. A worktree agent asked
 * of agents:add is refused by any 1.0 build (gitmissing checks that), so isn't one.
 */
export const TEST_CHANNELS = /agents:testLegacy|slots:test|\{ worktree: true \}\)|['"](new|existing)-worktree['"]/

/** A suite's source as { header (its opening comment, as one line of text), code (its lines that aren't comments) }. */
export function suiteSource(source) {
  const lines = source.split(/\r?\n/)
  const end = lines.findIndex((l) => !l.startsWith('//'))
  const header = (end < 0 ? lines : lines.slice(0, end)).map((l) => l.replace(/^\/\/\s*/, '')).join(' ')
  return { header, code: lines.filter((l) => !l.trimStart().startsWith('//')) }
}

/**
 * Why a suite can't run on a packaged build (CW_EXE), from its source, or null (#1591): its header says "Dev build
 * only"; it starts this checkout's Electron itself (executablePath: lib.ELECTRON) rather than through lib.launch; or,
 * unless it handles CW_EXE itself (reads it, or q.devSeam: its dev-only parts say NOT RUN and the rest runs), it needs
 * a dev-only seam or a test channel. Under CW_EXE the runner reports such a suite NOT RUN with this reason, so a
 * dev-build pass is never taken for a packaged one; tests/e2esuites.test.ts uses it for the suites' headers.
 */
export function devBuildOnly(source) {
  const { header, code } = suiteSource(source)
  if (/Dev build only/.test(header)) return 'its header says "Dev build only"'
  if (code.some((l) => /executablePath:\s*lib\.ELECTRON\b/.test(l))) return "it starts this checkout's Electron itself (executablePath: lib.ELECTRON), not lib.launch"
  if (code.some((l) => /process\.env\.CW_EXE|\bdevSeam\(/.test(l))) return null
  const seam = code.flatMap((l) => l.match(/CW_TEST_[A-Z0-9_]+/g) ?? []).find((s) => DEV_SEAMS.includes(s))
  if (seam) return `it needs ${seam}, a test seam a packaged build ignores`
  const channel = code.filter((l) => !/inv\('agents:add'/.test(l)).map((l) => TEST_CHANNELS.exec(l)?.[0]).find(Boolean)
  if (channel) return `it uses a test channel a packaged build refuses (${channel})`
  return null
}

/** The launch helpers every suite shares: lib.launch honours CW_EXE, and the seams they give are every copy's. */
const SHARED_HELPERS = new Set(['lib.cjs', 'runContext.cjs'])

/**
 * A suite's files, relative to the suites' folder: its own, those in a folder of its name (i18nshots/), and the helpers
 * they require by relative path, in turn (wakepaste-cli/run.cjs), apart from SHARED_HELPERS.
 */
export function suiteFiles(name, dir) {
  const files = [`${name}.cjs`]
  const own = join(dir, name)
  if (existsSync(own) && statSync(own).isDirectory()) files.push(...readdirSync(own).filter((f) => f.endsWith('.cjs')).sort().map((f) => `${name}/${f}`))
  for (let i = 0; i < files.length; i++) {
    for (const m of readFileSync(join(dir, files[i]), 'utf8').matchAll(/require\('(\.\.?\/[^']+\.cjs)'\)/g)) {
      const f = posix.normalize(posix.join(posix.dirname(files[i]), m[1]))
      if (!SHARED_HELPERS.has(f) && !files.includes(f) && existsSync(join(dir, f))) files.push(f)
    }
  }
  return files
}

/**
 * A run's suites on a packaged build (exe: CW_EXE, or none): { devOnly (a Map of each suite NOT RUN to why), nothingRan
 * (why the run tested nothing, when none of them can run: the run still writes its record, not valid, and fails) }.
 */
export function packagedPlan(chosen, dir, exe) {
  const devOnly = new Map(exe ? chosen.map((s) => [s.name, suiteDevOnly(s.name, dir)]).filter(([, why]) => why) : [])
  return { devOnly, nothingRan: chosen.length && devOnly.size === chosen.length ? 'no suite chosen can run on a packaged build: nothing was tested' : null }
}

/** devBuildOnly for a suite and every file it uses (suiteFiles), each judged on its own: the first reason, or null. */
export function suiteDevOnly(name, dir) {
  for (const f of suiteFiles(name, dir)) {
    const why = devBuildOnly(readFileSync(join(dir, f), 'utf8'))
    if (why) return f === `${name}.cjs` ? why : `${f}: ${why}`
  }
  return null
}

/**
 * The command line: { jobs, all, affected (a base, or null), named, tier, record, fingerprint, build, packaged, noWait, preMerge } or
 * { error }. lang: the languages --lang gives (comma-separated, or the option again) for the i18nshots route, which
 * it runs alone (named, or nothing named) and keeps the screenshots of (keepFiles); every other suite runs in English.
 * tier: 'fake' (default: no real-CLI suite unless named or, with --affected, needed), 'real' (--real: the
 * real tier too) or 'only' (--only-real). A flag's value is taken only when it really is one: --jobs takes a number;
 * --affected takes a base only if the next word is neither a flag nor a suite name (so `--affected board` means board,
 * plus what changed since main). Every suite name given is kept.
 */
export function parseArgs(argv, suiteNames) {
  const o = { jobs: 4, repeat: 1, all: false, affected: null, named: [], tier: 'fake', record: false, fingerprint: false, build: false, packaged: false, noWait: false, preMerge: false, keepFiles: false, warmHomes: false, clearDir: null, lang: [] }
  const tiers = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--jobs') {
      const n = Number(next)
      if (!next || !Number.isInteger(n) || n < 1) return { error: '--jobs needs a whole number of suites to run at once (1 runs them one after another)' }
      o.jobs = Math.min(8, n)
      i++
    } else if (a === '--repeat') {
      const n = Number(next)
      if (!next || !Number.isInteger(n) || n < 1) return { error: '--repeat needs a whole number of runs (1 or more)' }
      o.repeat = n
      i++
    } else if (a === '--clear-dir') {
      if (!next || next.startsWith('--')) return { error: '--clear-dir needs the folder to empty' }
      o.clearDir = next
      i++
    } else if (a === '--lang') {
      const langs = (next ?? '').split(',').map((l) => l.trim()).filter(Boolean)
      if (!next || next.startsWith('--') || !langs.length) return { error: '--lang needs a language code, or several separated by commas (en-XA,pl)' }
      const bad = langs.filter((l) => !LANG_TAG.test(l))
      if (bad.length) return { error: `--lang: ${bad.join(', ')} isn't a language code (pl, pt-BR, en-XA)` }
      o.lang.push(...langs.filter((l) => !o.lang.includes(l)))
      i++
    } else if (a === '--affected') {
      const isBase = next !== undefined && !next.startsWith('--') && !suiteNames.includes(next)
      o.affected = isBase ? next : 'main'
      if (isBase) i++
    } else if (a.startsWith('--')) {
      if (!PLAIN_FLAGS.includes(a) && !VALUE_FLAGS.includes(a)) return { error: `Unknown option ${a}` }
      if (a === '--all') o.all = true
      if (a === '--real') tiers.add('real')
      if (a === '--only-real') tiers.add('only')
      if (a === '--record') o.record = true
      if (a === '--fingerprint') o.fingerprint = true
      if (a === '--build') o.build = true
      if (a === '--packaged') o.packaged = true
      if (a === '--no-wait') o.noWait = true
      if (a === '--pre-merge') o.preMerge = true
      if (a === '--keep-files') o.keepFiles = true
      if (a === '--warm-homes') o.warmHomes = true
    } else {
      o.named.push(a)
    }
  }
  const unknown = o.named.filter((n) => !suiteNames.includes(n))
  if (unknown.length) return { error: `Unknown suite(s): ${unknown.join(', ')}` }
  if (o.all && o.affected) return { error: '--all runs every suite and --affected only some: use one of them' }
  if (tiers.size > 1) return { error: '--real adds the real tier and --only-real runs only it: use one of them' }
  o.tier = [...tiers][0] ?? 'fake'
  if (o.lang.length) {
    if (o.all || o.affected || tiers.size || o.named.some((n) => n !== LANG_SUITE)) return { error: `--lang runs the ${LANG_SUITE} route in those languages, alone: every other suite runs in English` }
    o.named = [LANG_SUITE]
    o.keepFiles = true
  }
  if (o.named.some((n) => n.startsWith('packaged'))) o.packaged = true
  return o
}

/**
 * The suites to run, in suites.mjs order. Suites named always run. The full set (--all, or nothing named and no
 * --affected) is the fake tier: every suite that starts no real CLI. With --affected, the suites the changes need
 * (affected: { suites } or { all, real }: every fake suite plus the real ones it names). tier 'real' (--real) adds every
 * real-CLI suite; 'only' (--only-real) keeps only those. Installer suites only with packaged.
 */
export function selectSuites(suites, { all, named, packaged, tier = 'fake' }, affected = null) {
  // With --affected, nothing needed and nothing named means none (not every suite).
  const everything = all || (!affected && !named.length)
  const wanted = (s) => {
    const real = isRealCli(s)
    if (named.includes(s.name)) return true
    if (tier === 'only' && !real) return false
    if (real && tier === 'real') return true
    if (everything) return !real || tier === 'only'
    if (affected?.all) return !real || (affected.real ?? []).includes(s.name)
    return !!affected && affected.suites.includes(s.name)
  }
  return suites.filter((s) => wanted(s) && (packaged || !(s.needs ?? []).includes('packaged')))
}

/** The real-CLI suites a run leaves out (listed in its output and record as not run, so the tier is never silent). */
export const realNotRun = (suites, chosen) => suites.filter((s) => isRealCli(s) && !chosen.includes(s))

/**
 * A finished suite's result from its exit code and output: { ok, failed } (failed: its FAIL lines), or { skipped } when
 * it skipped itself: a `SKIPPED <why>` line and a clean exit, from lib.skip (no failure) or from lib.cliStep, when a step
 * that waits on the real CLI failed because of the environment (usage or rate limit, sign-in, network: `environment: …`).
 * cliStep says how many failed checks it put down to that (`SKIPPED-FAILS n`); a FAIL line beyond those (a check
 * before the step, a page error) keeps the suite a FAIL. An `ENVIRONMENT` line alone never makes a skip.
 */
/**
 * A suite's result line, then the lines under a failed one: its FAIL lines, and the Windows codes its output names
 * (#599: a child that failed to start or crashed), each with its meaning, as is its own exit code in the line.
 */
export function resultLines(name, r) {
  if (r.notRun) return [`${name.padEnd(22)}NOT RUN  (${r.notRun})`]
  if (r.skipped) return [`${name.padEnd(22)}SKIP  ${r.seconds}s  (${r.skipped})`]
  const failed = r.failed ?? []
  const parts = r.partsNotRun ?? []
  const partsSaid = parts.length ? `${parts.length} part${parts.length === 1 ? '' : 's'} NOT RUN` : ''
  const head = `${name.padEnd(22)}${r.ok ? 'pass' : 'FAIL'}  ${r.seconds}s${r.ok ? (partsSaid ? `  (${partsSaid})` : '') : `  (exit ${exitText(r.code)}${failed.length ? `; ${failed.length} failed check${failed.length === 1 ? '' : 's'}` : ''}${partsSaid ? `; ${partsSaid}` : ''})`}`
  return [head, ...failed.map((f) => `    ${f.trim()}`), ...parts.map((p) => `    NOT RUN ${p}`), ...(r.ok === false ? (r.windows ?? []).map((w) => `    Windows: ${w}`) : [])]
}

/** partsNotRun: what a suite said it left out (`NOT RUN <what>` lines: a dev-only part on a packaged build, #1591). */
export function suiteOutcome({ code, out }) {
  const lines = out.split(/\r?\n/)
  const failed = lines.filter((l) => /^\s*FAIL/.test(l))
  const ok = code === 0 && !failed.length
  const said = (tag) => lines.map((l) => new RegExp(`^${tag} (.+)$`).exec(l.trim())?.[1]).find(Boolean) ?? null
  const self = said('SKIPPED')
  const explained = Number(said('SKIPPED-FAILS') ?? 0)
  if (code === 0 && self && failed.length <= explained) return { skipped: self, environment: self.startsWith('environment:') }
  const partsNotRun = lines.map((l) => /^NOT RUN (.+)$/.exec(l.trim())?.[1]).filter(Boolean)
  return { ok, failed, ...(partsNotRun.length ? { partsNotRun } : {}) }
}

/**
 * Whether a run record can be trusted for the code it names: the code didn't change while the suites ran (same
 * fingerprint before and after), and the dev build wasn't older than the source. Returns { valid, problems }.
 */
/**
 * The suite this runner was started inside, or null: the runner marks each suite's environment (E2E_RUN_SUITE, and
 * CW_E2E_PORT), and E2E_RUN_SUITE survives into the sessions of the Combwork a suite starts, which drop CW_ variables.
 */
export function parentSuite(env = process.env) {
  if (!env.E2E_RUN_SUITE && !env.CW_E2E_PORT) return null
  const port = Number(env.E2E_RUN_PORT || env.CW_E2E_PORT) || null
  return { name: env.E2E_RUN_SUITE ?? null, port }
}

/**
 * The first port the runner's slots use: its lane's (lanes.mjs), or 1000 above the parent suite's port for a runner
 * inside a suite (which claims no lane).
 */
export function portBase(env = process.env, laneBase = 47940) {
  const parent = parentSuite(env)
  return parent ? (parent.port ?? laneBase) + 1000 : laneBase
}

/**
 * A repeat's record (--repeat N): valid only if all N runs ran and passed, on the same code from the first run's start to
 * the last one's end, with a build from that code. A repeat stops at its first failed run, so a later pass never makes up
 * for it. With one run, a failed suite shows in the record but doesn't make it invalid (it is still a true record).
 */
export function repeatStatus({ repeat, runs, before, after, buildStale, packagedStale = null }) {
  const { problems } = recordStatus({ before, after, buildStale, packagedStale })
  if (repeat > 1) {
    const failedAt = runs.findIndex((r) => !r.ok)
    if (failedAt >= 0) problems.unshift(failedAt + 1 < repeat ? `stopped after run ${failedAt + 1} of ${repeat} failed` : `run ${repeat} of ${repeat} failed`)
    else if (runs.length < repeat) problems.unshift(`only ${runs.length} of ${repeat} runs ran`)
  }
  return { valid: !problems.length, problems }
}

export function recordStatus({ before, after, buildStale, packagedStale = null }) {
  const problems = []
  if (before !== after) problems.push(`the code changed while the suites ran (${before} at the start, ${after} at the end): these results are for neither, run them again`)
  if (buildStale) problems.push("the dev build isn't known to be from this source, so the suites may have tested other code: run with --build")
  if (packagedStale) problems.push(`${packagedStale}, so the installer's suites may have tested other code: run npm run dist`)
  return { valid: !problems.length, problems }
}

/**
 * Whether the packaged build the installer's suites test (dist/win-unpacked) is from the code as it is now (#274), from
 * its own record of what it was built from (info: scripts/distCopy.mjs readUnpackedInfo, which `npm run dist` writes
 * once it is sure): null when its code is this fingerprint, else why not.
 */
export function packagedStatus(info, code) {
  if (!info) return "the packaged build (dist\\win-unpacked) has no record of what it was built from (from an older npm run dist, or one whose code changed while it built), so which code it holds is unknown"
  if (info.code !== code) return `the packaged build (dist\\win-unpacked) is from other code (${info.code}${info.branch ? `, ${info.branch}` : ''}; this is ${code})`
  return null
}

/**
 * Whether a run needs the dev build in out/ at all: not when every suite is one of the installer's, which test
 * dist/win-unpacked (packagedStatus checks that one), unless packaged-progress is told to check the dev build's wrapper.
 */
export const needsDevBuild = (suites, env = process.env) => !suites.length || !suites.every((s) => (s.needs ?? []).includes('packaged')) || env.CW_PROGRESS_CHECK_DEV === '1'
