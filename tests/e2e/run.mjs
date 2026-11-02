// Runs Hive's end-to-end suites: npm run e2e [suite…] [options]. See tests/e2e/README.md.
//   --jobs N        how many suites run at once (default 4; 1 runs them one after another). Suites that start a real
//                   CLI run one at a time in a lane of their own beside the others; those marked serial in suites.mjs
//                   (and the installer's) run last, alone.
//   --affected [B]  the suites the changes since branch B (default main) need, uncommitted ones included
//                   (affected.mjs), plus any suites named. B is taken only if it isn't a suite name. A tool for
//                   picking suites (a review round's fixes), not a merge's gate: merges run focused checks (#1010). It
//                   picks every suite itself for shared code, test tooling or unknown files.
//   --all           the full set, at checkpoints (the integration branch when lanes are quiet, each RC and release,
//                   on request; not with --affected): every suite
//                   that starts no real CLI (the fake tier). The real-CLI suites (needs claude/codex in suites.mjs)
//                   are listed as not run.
//   --real          the real tier too: every suite that starts the real Claude Code or Codex (--all --real: everything).
//   --only-real     only the real tier (with --affected, only the real suites the changes need). A step of a real suite
//                   that waits on the CLI (lib.cliStep) and fails because of the machine (usage or rate limit, sign-in,
//                   network, in that step's session) makes the suite a SKIP with the reason, not a FAIL; a CLI that isn't
//                   installed or signed in skips its suites.
//   --record        print and save a run record (the code's fingerprint, each suite's result) for a card comment. The
//                   record is marked not valid, and the run fails, if the code changed while the suites ran or the
//                   build isn't known to be from this source (build.mjs).
//   --repeat N      run the suites N times, stopping at the first run that fails; with --record, one record for all
//                   of them, valid only if every run passed. For changes that could make tests flaky.
//   --fingerprint   print the code's fingerprint and stop (to compare with a run record).
//   --lang L[,L…]   the i18n screenshot route (i18nshots, #769) in these languages (en-XA, the pseudo-locale, when not
//                   given): run alone, its screenshots kept as with --keep-files. Every other suite runs in English.
//   --build         build first (npx electron-vite build), only if the build isn't from this source (build.mjs).
//   --packaged      include the installer's suites (need npm run dist); --no-progress: don't report to Hive.
//   --no-wait       a heavy run (more than 5 suites, or --repeat) fails at once when every test slot on this machine is
//                   taken, instead of waiting for one (slots.mjs; heavySlots and sideSlots in hive-test\config.json); and
//                   any run fails at once when every test lane (10) is taken, instead of waiting for one (lanes.mjs, #707).
//   --pre-merge     a heavy run checking a merge goes first in the queue for a test slot (#558). Not needed in the
//                   session of an agent holding the merge slot: such a run goes first anyway (slots.mjs holdsMergeSlot).
// Needs a dev build. A suite fails when it exits non-zero or prints a line starting with FAIL. Each suite gets its own
// Agent API port (HIVE_E2E_PORT, read through lib.port()), so suites can run side by side; each runner claims a lane
// (lanes.mjs: ports and suite folders of its own), so runners in different worktrees can run at the same time.
// Run in a Hive agent's session, it shows in that Hive's Progress panel, one step per suite (../progressReport.mts).
// Each suite's environment comes from the run context (runContext.cjs): an allowlist and the suite's own folder and
// port, never the environment the runner was started from.
import { spawn, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname, resolve as resolvePath } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { e2eProgress, slotWaitProgress } from '../progressReport.mts'
import { SUITES } from './suites.mjs'
import { affectedSuites, changedFiles, mergeBase } from './affected.mjs'
import { CLI_LOG, fingerprint, readCliLog, realCliHomes, realCliVersions, recordJson, recordMarkdown, selectionOf } from './record.mjs'
import { LANG_SUITE, isRealCli, keepLimits, needsDevBuild, packagedStatus, parentSuite, parseArgs, portBase, realNotRun, repeatStatus, packagedPlan, resultLines, selectSuites, suiteLimitMs, suiteOutcome } from './runner.mjs'
import { devBuild, ensureBuild } from './build.mjs'
import { FAILED_KEEP_MS, finishRunDirs, keepSuiteFiles, logRetention, logsRootFor, markRunFailed, newRunDir, omittedLine, pruneRunDirsReleasing } from './logs.mjs'
import { LANES, describeHolder, laneWaitLine, lanesFirst, laneWork, waitForLane } from './lanes.mjs'
import { endLeftCopies } from './leftCopies.mjs'
import { SIDE_E2E_JOBS, creditFor, preMerge, refusedLine, slotPool, waitForSlot, waitLine, waitSummary } from './slots.mjs'
import { usesCodexHome, waitForCodexHome } from './codexHomeLock.mjs'
import { autoClean, holdLane } from './clean.mjs'
import { recycleBinCount, recycleBinLine } from './recycleBin.mjs'
import { readUnpackedInfo } from '../../scripts/distCopy.mjs'
import { endRunTemp, startRunTemp } from '../runTemp.mts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const lib = createRequire(import.meta.url)('./lib.cjs')
const runContext = createRequire(import.meta.url)('./runContext.cjs')
const { claimedByRuns, clearDir, evidenceFor, findBoard, finishSuiteDir, freshFolder, recordKept, releaseKept } = createRequire(import.meta.url)('./evidence.cjs')
const { stopProcessesIn, endChildTree, endCopies } = createRequire(import.meta.url)('./folderProcesses.cjs')
const { describeExit, windowsCodesIn } = createRequire(import.meta.url)('./windowsExits.cjs')

const args = process.argv.slice(2)
const opts = parseArgs(args, SUITES.map((s) => s.name))
if (opts.error) {
  console.error(opts.error.startsWith('Unknown suite') ? `${opts.error}. Suites: ${SUITES.map((s) => s.name).join(', ')}` : opts.error)
  process.exit(2)
}
// At most SIDE_E2E_JOBS on the side slot (below).
let { jobs } = opts

if (opts.fingerprint) {
  console.log(fingerprint(root))
  process.exit(0)
}

// --clear-dir <folder>: empties a probe's or a suite's own folder from Node, for a rerun into the same place (#304), so
// nobody needs a shell delete on a computed path; it refuses anything else and evidence (evidence.cjs clearDir).
if (opts.clearDir) {
  try {
    const board = process.env.HIVE_TEST_NO_BOARD === '1' ? { cards: [] } : { tasksDir: findBoard(root) }
    console.log(`Emptied ${clearDir(opts.clearDir, { board })}`)
    process.exit(0)
  } catch (e) {
    console.error(`Not cleared: ${e.message}`)
    process.exit(2)
  }
}

// What may be deleted (#253, evidence.cjs): never what a card that isn't Done cites. That needs the board: without it
// nothing a run made could be removed, and runs would pile up copies of their suites' folders (#285), so it doesn't
// start. HIVE_TEST_NO_BOARD=1 says there is no board (a checkout outside a Hive workspace): nothing is evidence then.
const evidence = evidenceFor(root)
if (!evidence.ok) {
  console.error(`Can't tell what the tests may delete: ${evidence.why}. Fix the board, or set HIVE_TEST_NO_BOARD=1 if no Hive board cites test output on this machine.`)
  process.exit(2)
}
// The run's own temp folder in hive-test\tmp (HI-2102): its suites, Playwright's playwright-artifacts-* folders, the
// test copies of Hive and the CLIs they start get it as TEMP (runContext.cjs ALLOW), not %TEMP%. It goes as the runner
// exits, unless the run is recorded for review (kept, as its logs are, until a run's start a day later removes it,
// while no open card cites it). A run's start removes what stopped runs left, by the same evidence rules.
const runTemp = startRunTemp((p) => evidence.protects(p))
process.on('exit', () => {
  if (opts.record) return console.log(`\nKept the run's temp folder with its record: ${runTemp}`)
  const failed = endRunTemp()
  if (failed) console.warn(`The run's temp folder was left behind (the next run's start removes it after a day): ${failed}`)
})

// --- Which suites.
let affected = null
let changed = []
if (opts.affected) {
  changed = changedFiles(opts.affected, root)
  affected = affectedSuites(changed, SUITES.map((s) => s.name), SUITES.filter(isRealCli).map((s) => s.name))
  if (affected.all) console.log(`Affected since ${opts.affected}: every fake suite (${affected.why[0]})${affected.real.length ? `, and the real tier's ${affected.real.join(', ')}` : ''}`)
  else console.log(`Affected since ${opts.affected}: ${affected.suites.length ? affected.suites.join(', ') : 'none'}`)
  for (const w of affected.all ? affected.why.slice(1) : affected.why) console.log(`  ${w}`)
}
const chosen = selectSuites(SUITES, opts, affected)
// How they were picked, for the record (#628): the full set, or what --affected selected and why.
const selection = selectionOf({ all: opts.all, named: opts.named, affected, base: opts.affected, mergeBase: opts.affected ? mergeBase(opts.affected, root) : null, files: changed.length })
// The real tier left out of a full or affected run: said, so it is never silent (and in the record).
const notRun = opts.named.length && !opts.all && !opts.affected ? [] : realNotRun(SUITES, chosen)
if (notRun.length) console.log(`Not run: the real tier (add --real): ${notRun.map((s) => s.name).join(', ')}\n`)
if (!chosen.length) {
  console.log(`\nNo suite to run${opts.affected ? ' for these changes' : ''}.`)
  process.exit(0)
}
// A packaged build (HIVE_EXE, the Sandbox checks): a suite that can't run on one would test the dev build and pass for
// it, so it is NOT RUN, with why, in the output and the record (#1591, runner.mjs suiteDevOnly: the suite and the
// helpers it uses). The parts of a suite that runs which need the dev build say NOT RUN themselves (queueFixture
// devSeam). A run where none can run tested nothing: it fails, with its record saying so.
const packagedExe = process.env.HIVE_EXE || null
const { devOnly, nothingRan } = packagedPlan(chosen, here, packagedExe)
if (packagedExe) console.log(`Packaged build: ${packagedExe} (HIVE_EXE)${devOnly.size ? `. NOT RUN, as they would test the dev build: ${devOnly.size} of ${chosen.length} suites (each said with why)` : ''}.\n`)

// --- A heavy run (more than a few suites, or a repeat) waits for a test slot: at most a few go at once on this machine,
// across every worktree (slots.mjs), so runs don't slow each other until tests time out; a small one (a few suites
// repeated a few times, HI-2070) takes the side slot, else a heavy one. A runner started inside a suite never waits
// (its parent holds one: slotPool). --no-wait: fail at once instead. A pre-merge run goes first.
const nested = !!parentSuite()
const pool = slotPool({ kind: 'e2e', count: chosen.length, repeat: opts.repeat })
if (pool) {
  const what = `e2e: ${chosen.length} suites${opts.repeat > 1 ? ` × ${opts.repeat}` : ''}`
  const queue = slotWaitProgress('e2e', `npm run e2e -- ${args.join(' ')}`.trim(), args)
  let said = ''
  const got = await waitForSlot(runContext.HEAVY_DIR, {
    pool,
    what,
    root,
    wait: !opts.noWait,
    first: preMerge(opts.preMerge),
    onWait: (look) => {
      const line = waitLine(look)
      if (line !== said) console.log(line)
      said = line
      queue.waitingAs(waitSummary(look))
    }
  })
  if (got.refused) {
    console.error(refusedLine(got.refused))
    process.exit(2)
  }
  // Beside two heavy runs, a side run's suites go at most two at once (HI-2070: four took the machine near full).
  if (got.pool === 'side' && jobs > SIDE_E2E_JOBS) {
    console.log(`On the side slot: ${SIDE_E2E_JOBS} suites at once, not ${jobs} (HI-2070).`)
    jobs = SIDE_E2E_JOBS
  }
  if (said) {
    const after = `${Math.round(got.waitedMs / 1000)} s`
    console.log(`Got a test slot after ${after}.
`)
    await queue.finish(`got a test slot after ${after}`)
  }
}

// The runner's lane (lanes.mjs): ports and suite folders no other runner on this machine uses while this one runs, so
// runners started at the same time from different worktrees don't take each other's. A runner started inside a suite
// (progressreport runs one in its agent's shell) claims none: it takes ports well clear of its parent's (portBase).
// With every lane taken it waits for one, saying who holds them (and in the Progress panel), #707; --no-wait: fail.
// Before the code's fingerprint and the build (#735): a run that waited tests the source as it is once it has a lane.
let lane = null
if (!nested) {
  // First, the test copies of Hive an earlier run left in lanes no runner holds (HI-1453): one holding a lane's port
  // kept every later runner off that lane.
  try {
    const left = await endLeftCopies(runContext.LANES_DIR, lib.WORK)
    if (left.ended) console.log(`Ended ${left.ended} process(es) of test copies of Hive an earlier run left running in its lanes (HI-1453).\n`)
    // Never ended without a record: listed, for a person to look at.
    if (left.unrecorded.length) console.log(`Still running in lanes no runner holds, with no record of a run starting them (not ended; look at them, HI-1453):\n${left.unrecorded.map((p) => `  ${p.pid}: ${p.commandLine}`).join('\n')}\n`)
  } catch (e) {
    console.warn(`Couldn't look for test copies of Hive an earlier run left running (HI-1453): ${e.message}\n`)
  }
  const queue = slotWaitProgress('e2e', `npm run e2e -- ${args.join(' ')}`.trim(), args, 'a test lane')
  let said = ''
  const got = await waitForLane(runContext.LANES_DIR, {
    root,
    portsFrom: lanesFirst(runContext.OWN_LANES),
    what: `e2e: ${chosen.length} suite${chosen.length === 1 ? '' : 's'}${opts.repeat > 1 ? ` × ${opts.repeat}` : ''}`,
    wait: !opts.noWait,
    onWait: (look) => {
      const line = laneWaitLine(look)
      if (line !== said) console.log(line)
      said = line
      queue.waiting(look.holders.map((c) => describeHolder(c)).join('; '))
    }
  })
  if (got.refused) {
    console.error(`No test lane free (--no-wait): every e2e lane (${LANES}) is taken, by ${got.refused.holders.map((c) => describeHolder(c)).join('; ') || 'runs just finishing'}.`)
    process.exit(2)
  }
  if (said) {
    const after = `${Math.round(got.waitedMs / 1000)} s`
    console.log(`Got a test lane after ${after}.\n`)
    await queue.finish(`got a test lane after ${after}`)
  }
  lane = got
  process.on('exit', lane.release)
  process.on('SIGINT', () => process.exit(130))
}

// The code under test, before anything runs: a run record names it only if it is still the same at the end.
const codeBefore = opts.record ? fingerprint(root) : null

// --- The build: made from the source as it is now (build.mjs), else the suites would test other code. Under the
// worktree's build lock: runners started together build it once.
const runBuild = () => {
  console.log('Building (the dev build is not from this source)…')
  devBuild(root)
}
// Only the installer's suites: they test dist/win-unpacked, not out/ (needsDevBuild), so out/ isn't looked at (#274).
// Nor when none can run on the packaged build HIVE_EXE names: nothing would use it, and the run's record is still due.
const runnable = chosen.filter((s) => !devOnly.has(s.name))
const devBuildNeeded = !nothingRan && needsDevBuild(runnable)
let buildCheck = { stale: false, built: false, waited: false, why: null }
try {
  if (devBuildNeeded) buildCheck = ensureBuild({ root, build: opts.build, runBuild })
} catch (e) {
  console.error(e.message)
  process.exit(e.status ?? 2)
}
if (buildCheck.waited) console.log(`Waited for another runner's build of this worktree${buildCheck.built ? '' : ': it is from this source'}.`)
const stale = buildCheck.stale
if (devBuildNeeded && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('No dev build: add --build (or run npx electron-vite build first).')
  process.exit(2)
} else if (stale) {
  console.warn(`Warning: ${buildCheck.why}: the suites may test other code. Add --build to build first (only when needed)${opts.record ? '; the run record will say it is not valid' : ''}.\n`)
}
// The installer's suites test dist/win-unpacked: is it from this code? npm run dist records that inside it once it is
// sure what the build was made from (its own record, never dist/build-info.json, which describes the installer set and
// can be copied in from a worktree beside an older win-unpacked: scripts/distCopy.mjs). Looked at again at the end,
// for the record.
const packagedCheck = () => (chosen.some((s) => (s.needs ?? []).includes('packaged')) && existsSync(join(root, 'dist', 'win-unpacked')) ? packagedStatus(readUnpackedInfo(join(root, 'dist')), fingerprint(root)) : null)
const packagedStale = packagedCheck()
if (packagedStale) console.warn(`Warning: ${packagedStale}: the installer's suites may test other code. Run npm run dist first${opts.record ? '; the run record will say it is not valid' : ''}.\n`)

/**
 * Where the suites keep their profiles, workspaces and screenshots: the lane's folder (the logs stay in lib.WORK). A
 * runner inside a suite uses nested/ in its parent's (E2E_RUN_DIR: Hive drops HIVE_E2E_DIR from an agent's shell).
 */
const suiteWork = lane ? laneWork(lib.WORK, lane.lane) : process.env.E2E_RUN_DIR ? join(process.env.E2E_RUN_DIR, 'nested') : null
// Each slot has its own port, from the lane's: the CLI lane takes the one below the first slot's.
const PORT_BASE = portBase(process.env, lane?.base)
if (lane) console.log(`Lane ${lane.lane}: ports ${lane.first}–${lane.last}\n  suites' folders: ${suiteWork}\n  logs: ${logsRootFor(lib.WORK)}\n`)

/**
 * A suite's environment (runContext.suiteEnv): the allowlist and the test settings passed on by name, nothing else of
 * the runner's (an agent session's HIVE_ variables, HIVE_PROGRESS_*, NO_COLOR…); its lane's folder, and side by side
 * its own Agent API port (suites read it with lib.port(); the test Hives they start get it through lib.hiveEnv). The
 * same said without the HIVE_ prefix (E2E_RUN_*), which Hive keeps in its sessions: a runner started in an agent's
 * shell inside the suite's Hive (progressreport does) knows it is inside a suite, and which port to keep clear of.
 */
const suiteEnv = (name, port, dir) => {
  const env = runContext.suiteEnv({ name, port, work: dir, runDir: dir ?? lib.WORK, cliLog: dir ? join(dir, CLI_LOG) : null, slots: creditFor(pool) })
  // --lang: the languages the i18n screenshot route photographs (it reads E2E_I18N_LANGS; the others are pinned to English).
  if (name === LANG_SUITE && opts.lang.length) env.E2E_I18N_LANGS = opts.lang.join(',')
  return env
}
/** The CLIs the suite's test copies of Hive selected (record.mjs readCliLog), read before its folder goes. */
const suiteClis = (dir) => {
  try {
    return dir ? readCliLog(readFileSync(join(dir, CLI_LOG), 'utf8')) : []
  } catch {
    return []
  }
}
/**
 * Each suite has a folder of its own in the lane's, made fresh when it starts (`<suite>`, or `<suite>-2`… while an
 * earlier one is kept). When it passes (or skips), the whole folder goes (#285), unless the board, read as it is then,
 * says it must stay (a card cites it, or the board can't be read: said at the end). When it fails, it stays for a look.
 * What stays is tied to the run (evidence.cjs recordKept) and goes when the run's logs are pruned (KEEP_RUNS, a day's
 * runs up to a size, and a failed run a day: logs.mjs), so copies never pile up.
 */

const run = (name, port) =>
  new Promise((resolve) => {
    const started = Date.now()
    let dir = null
    try {
      // Not a folder a failed run still keeps (its evidence goes with the run's logs).
      const claimed = claimedByRuns([logsRoot])
      dir = suiteWork ? freshFolder(join(suiteWork, name), evidence, { claimed: (d) => claimed.has(resolvePath(d).toLowerCase()) }) : null
    } catch (e) {
      // Too many kept copies of its folder (evidence.cjs MAX_COPIES): it doesn't run, and says why.
      resolve({ name, ok: false, failed: [`FAIL ${e.message}`], code: 2, out: `FAIL ${e.message}\n`, seconds: 0, dir: null, kept: null })
      return
    }
    // No tip card over what a suite clicks, unless its profile turns tips on (tips does).
    const child = spawn(process.execPath, [join(here, `${name}.cjs`)], { cwd: root, env: suiteEnv(name, port, dir) })
    let out = ''
    const add = (d) => (out += d)
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    // Out of time: the suite and everything it started. Killing only the suite's node leaves its test copy of Hive running,
    // holding the lane's port, and the lane's next suites can't start their Agent API.
    const limitMs = suiteLimitMs(name, opts.lang)
    const timer = setTimeout(() => {
      out += `\nFAIL timed out after ${limitMs / 60_000} minutes: the suite and the processes it started were stopped\n`
      // Each as the process it is now, children first (#603): never taskkill /T, which follows parent ids that may be stale.
      if (process.platform !== 'win32' || !endChildTree(child)) child.kill()
    }, limitMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      // The Windows codes its output names (#599: a child that failed to start or crashed), not its own exit code: its
      // result line says that one.
      const windows = windowsCodesIn(out).filter((w) => w !== describeExit(code))
      const outcome = { ...suiteOutcome({ code, out }), clis: suiteClis(dir), windows }
      // What a suite's agents left running from its folder (a command through hive-progress, a server: #542) would hold
      // the folder and outlive the run: stopped, by command line (its folder, started since the suite did), never by name.
      // Its test copies of Hive first (HI-1453): those it recorded, as the processes recorded. One not recorded is the
      // folder's sweep's below (#542), which takes what names the folder and started since the suite did.
      const copies = dir ? endCopies([dir]).ended : 0
      if (copies) out += `\n(${copies} process(es) of its test copies of Hive still running after it ended were ended, HI-1453)\n`
      const stopped = dir ? stopProcessesIn(dir, started) : 0
      if (stopped) out += `\n(${stopped} process(es) still running from its folder after it ended were stopped, #542)\n`
      // --keep-files: a passed suite's own files (screenshots, reports) go into the run's log folder before its folder
      // does, as a failed one's do at the end (#304): a new place every run, pruned with the logs.
      if (opts.keepFiles && dir && outcome.ok) {
        const files = keepSuiteFiles(dir, runLogDir, name, keepLimits(name, opts.lang))
        if (files.copied) filesKept.push(name)
        if (files.omitted.length) filesLeftOut.push(`${name}: ${omittedLine(files.omitted)}`)
      }
      const kept = dir ? finishSuiteDir(dir, evidence, !!(outcome.ok || outcome.skipped)).kept : null
      resolve({ name, ...outcome, code, out, seconds: Math.round((Date.now() - started) / 1000), dir, kept: kept && `${dir} (${kept})` })
    })
  })

/** A CLI's path: on the PATH, or where its installer puts it (Hive looks there too); null when it isn't installed. */
const cliPath = (cmd, places) => {
  const r = spawnSync('where.exe', [cmd], { encoding: 'utf8', env: runContext.baseEnv() })
  return (r.status === 0 && r.stdout.split(/\r?\n/)[0].trim()) || places.find((p) => existsSync(p)) || null
}
const cliInstalled = {
  claude: () => cliPath('claude', [join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')]),
  codex: () => cliPath('codex', [join(process.env.APPDATA || '', 'npm', 'codex.cmd')]),
  copilot: () => cliPath('copilot', [join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'copilot.exe'), join(process.env.APPDATA || '', 'npm', 'copilot.cmd')])
}
/**
 * False only when Claude Code itself says it isn't signed in to its test home (`claude auth status --json`, with
 * CLAUDE_CONFIG_DIR set to CLAUDE_TEST_HOME); an answer that can't be read counts as signed in, so the suites run and
 * say what is wrong. Asked once a run. Never about the user's own home (#368): no suite runs there.
 */
let claudeTestSignedIn
const claudeLoggedIn = () => {
  if (claudeTestSignedIn !== undefined) return claudeTestSignedIn
  const env = runContext.childEnv({ CLAUDE_CONFIG_DIR: runContext.CLAUDE_TEST_HOME })
  const r = spawnSync(cliInstalled.claude(), ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000, env })
  try {
    claudeTestSignedIn = JSON.parse(r.stdout).loggedIn !== false
  } catch {
    claudeTestSignedIn = true
  }
  return claudeTestSignedIn
}

/** Why a suite can't run here, or null. "environment: …" for the machine's CLIs (the record says so). */
function skipReason(s) {
  const needs = s.needs ?? []
  if (needs.includes('packaged') && !existsSync(join(root, 'dist', 'win-unpacked'))) return 'no dist/win-unpacked (npm run dist)'
  if (needs.includes('claude') && !cliInstalled.claude()) return "environment: Claude Code isn't installed (claude)"
  // A suite with a Claude Code home of its own (claudeHome: 'own', a made-up API key) needs no sign-in: none is asked about.
  // One with none would run in the user's ~/.claude: never (#368; tests/e2esuites.test.ts fails for it first).
  if (needs.includes('claude') && s.claudeHome !== 'own' && s.claudeHome !== 'test') return "no Claude Code test home (suites.mjs claudeHome: 'own' or 'test', #368): it would run in the user's ~/.claude"
  if (needs.includes('claude') && s.claudeHome === 'test' && !claudeLoggedIn()) return `environment: Claude Code isn't signed in to its test home ${runContext.CLAUDE_TEST_HOME} (tests/e2e/README.md)`
  if (needs.includes('codex') && !cliInstalled.codex()) return "environment: Codex isn't installed (codex)"
  if (needs.includes('codex') && !lib.codexSignedIn()) return `environment: Codex isn't signed in to ${lib.CODEX_HOME}`
  // Offline against the stand-in model: no sign-in to ask about.
  if (needs.includes('copilot') && !cliInstalled.copilot()) return "environment: the GitHub Copilot CLI isn't installed (copilot)"
  return null
}

// Three groups. Side by side: suites with no needs, several at once. The CLI lane: suites that start the real Claude
// Code or use the Codex test home share those with each other (not with the rest), so they run one at a time, in one
// slot beside the side-by-side ones. Last, alone: those marked serial (window focus…) and the installer's.
// With --jobs 1 everything runs one after another, as before.
const NEEDS = ['claude', 'codex', 'packaged']
const rank = (s) => Math.max(-1, ...(s.needs ?? []).map((n) => NEEDS.indexOf(n)))
const needs = (s, n) => (s.needs ?? []).includes(n)
const isLast = (s) => !!s.serial || needs(s, 'packaged')
const isCli = (s) => !isLast(s) && (needs(s, 'claude') || needs(s, 'codex'))
const sideBySide = jobs === 1 ? [] : runnable.filter((s) => !isLast(s) && !isCli(s))
const cliLane = jobs === 1 ? [] : runnable.filter(isCli).sort((a, b) => rank(a) - rank(b))
const last = jobs === 1 ? [...runnable].sort((a, b) => rank(a) - rank(b)) : runnable.filter(isLast).sort((a, b) => rank(a) - rank(b))
const order = [...sideBySide, ...cliLane, ...last].map((s) => s.name)
const { repeat } = opts
// One progress run for the whole repeat: a step per suite in each run.
const progress = e2eProgress(repeat > 1 ? Array.from({ length: repeat }, (_, k) => order.map((n) => `run ${k + 1}: ${n}`)).flat() : order, args)
const step = (k, name) => (repeat > 1 ? `run ${k}: ${name}` : name)
let finished = 0

// Each run keeps its own logs (logs.mjs): a folder no other run shares, the last few kept; a runner started inside a
// suite keeps its runs under logs/nested.
const logsRoot = logsRootFor(lib.WORK)
// The run now going (runOnce) and, with --keep-files, the passed suites whose files were kept in it (and what was left out).
let runLogDir = null
const filesKept = []
const filesLeftOut = []
/** Runs the chosen suites once (run k of the repeat): { ok, results, logDir, summary }. */
async function runOnce(k) {
  const logDir = newRunDir(logsRoot)
  runLogDir = logDir
  filesKept.length = 0
  filesLeftOut.length = 0
  const results = []
  const startedAt = Date.now()
  const running = new Set()
  const report = () => {
    // A failed real-CLI suite can name the other runners' current suites (#478), rather than guessing at a collision.
    try {
      writeFileSync(join(logDir, 'running-suites.json'), JSON.stringify({ pid: process.pid, root, lane: lane?.lane ?? null, at: Date.now(), suites: [...running].map((name) => ({ name, needs: chosen.find((s) => s.name === name)?.needs ?? [] })) }))
    } catch (e) {
      console.log(`DIAGNOSTIC running suites unavailable: ${e.code || e.message}`)
    }
    progress.suite(finished, [...running].map((n) => step(k, n)).join(', '))
  }
  if (repeat > 1) console.log(`\n--- Run ${k} of ${repeat}`)
  for (const [name, why] of devOnly) {
    results.push({ name, notRun: why })
    for (const line of resultLines(name, { notRun: why })) console.log(line)
  }

  function finish(s, r) {
    finished++
    running.delete(s.name)
    progress.done(step(k, s.name), r.seconds * 1000, r.ok !== false)
    writeFileSync(join(logDir, `${s.name}.log`), r.out)
    // A folder it kept goes with this run's logs (pruneRunDirsReleasing → releaseKept).
    if (r.kept && r.dir) recordKept(logDir, [r.dir])
    // Its line, its FAIL lines, and a Windows code it ended with or names, with its meaning (#599).
    for (const line of resultLines(s.name, r)) console.log(line)
    // A failure with no FAIL line (an exception, a timeout): its last lines say why.
    if (r.ok === false && !r.failed.length) for (const line of r.out.split(/\r?\n/).filter((x) => x.trim()).slice(-5)) console.log(`    | ${line.trim().slice(0, 200)}`)
    if (r.kept && r.ok === false) console.log(`    its profiles and workspaces are kept: ${r.kept}`)
    else if (r.kept) keptAfterPass.push(r.kept)
    results.push(r)
    report()
  }

  async function runSuite(s, port) {
    const lease = usesCodexHome(s) ? await waitForCodexHome(lib.CODEX_HOME, { kind: 'e2e', root, what: `e2e: ${s.name}`, argv: args }) : null
    try {
      // Only suites actually starting count as running in peer diagnostics; a queued Codex suite cannot collide.
      running.add(s.name)
      report()
      return await run(s.name, port)
    } finally {
      lease?.release()
    }
  }

  /** Runs suites one after another (skipping those that can't run here), each with this port. */
  async function inTurn(list, port) {
    for (const s of list) {
      const why = skipReason(s)
      if (why) {
        finished++
        results.push({ name: s.name, skipped: why, environment: why.startsWith('environment:') })
        continue
      }
      finish(s, await runSuite(s, port))
    }
  }

  const queue = [...sideBySide]
  const poolSlots = Math.max(1, cliLane.length ? jobs - 1 : jobs)
  await Promise.all([
    inTurn(cliLane, PORT_BASE - 1),
    ...Array.from({ length: Math.min(poolSlots, queue.length) }, async (_, slot) => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        finish(s, await runSuite(s, PORT_BASE + slot))
      }
    })
  ])
  // Also with --jobs 1: a suite's own default port could be another runner's suite's.
  await inTurn(last, PORT_BASE)

  for (const r of results.filter((x) => x.skipped && x.seconds === undefined)) console.log(`${r.name.padEnd(22)}skipped: ${r.skipped}`)
  const failed = results.filter((r) => r.ok === false)
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
  const summary = `${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.skipped).length} skipped${devOnly.size ? `, ${devOnly.size} not run (they need the dev build)` : ''} in ${minutes} min`
  console.log(`\n${repeat > 1 ? `Run ${k} of ${repeat}: ` : ''}${summary}. Logs: ${logDir}`)
  if (filesKept.length) console.log(`Kept the screenshots and files of ${filesKept.join(', ')} in ${filesKept.length === 1 ? `${logDir}\\${filesKept[0]}` : `${logDir}\\<suite>`} (--keep-files).`)
  // React's commit bursts, recorded only (HI-1387): each suite's largest, the largest first.
  const bursts = results.map((r) => ({ name: r.name, n: Number(/^INFO React commit burst: the largest was (\d+)/m.exec(r.out ?? '')?.[1] ?? 0) })).filter((b) => b.n)
  if (bursts.length) console.log(`React commit bursts (most commits within 250 ms, recorded only, HI-1387): ${bursts.sort((a, b) => b.n - a.n).map((b) => `${b.name} ${b.n}`).join(', ')}`)
  // And each suite's longest commit chain (HI-1865: commits with nothing from outside between them), failed at 50 or not.
  const chains = results.map((r) => ({ name: r.name, n: Number(/^(?:INFO|FAIL) React commit chain: the longest was (\d+)/m.exec(r.out ?? '')?.[1] ?? 0) })).filter((b) => b.n)
  if (chains.length) console.log(`React commit chains (most commits with nothing from outside between them; a suite fails at 50 unless it accepts its chain, HI-1865): ${chains.sort((a, b) => b.n - a.n).map((b) => `${b.name} ${b.n}`).join(', ')}`)
  // A failed run outlives KEEP_RUNS for a day, with its failed suites' screenshots (#223): a path a builder cites in a
  // card is still there when the reviewer looks.
  if (failed.length) {
    markRunFailed(logDir, failed.map((r) => r.name).join(', '))
    const copied = []
    for (const r of failed.filter((x) => x.dir)) {
      const files = keepSuiteFiles(r.dir, logDir, r.name, keepLimits(r.name, opts.lang))
      if (files.copied) copied.push(r.name)
      if (files.omitted.length) filesLeftOut.push(`${r.name}: ${omittedLine(files.omitted)}`)
    }
    console.log(`It failed: its logs are kept for ${FAILED_KEEP_MS / 3_600_000} hours${copied.length ? `, with the screenshots and files of ${copied.join(', ')} in ${copied.length === 1 ? `${logDir}\\${copied[0]}` : `${logDir}\\<suite>`}` : ''}.`)
  }
  if (filesLeftOut.length) console.log(`Left out of the kept files: ${filesLeftOut.join('; ')}.`)
  // In the chosen order, for the record.
  const ordered = chosen.map((s) => results.find((r) => r.name === s.name)).filter(Boolean)
  return { ok: !failed.length, results: ordered, logDir, summary }
}

// Passed suites whose folders stayed (a card cites them, or the board couldn't be read): said once at the end, so growth
// while the board can't be read is seen.
const keptAfterPass = []
// The user's Recycle Bin, counted (read only) before and after (#414): test copies use their own trash folders.
const binBefore = recycleBinCount()
// --repeat N: run after run, stopping at the first that fails (a later pass doesn't make up for it).
const runs = []
for (let k = 1; k <= repeat; k++) {
  const r = await runOnce(k)
  runs.push(r)
  if (!r.ok) {
    if (k < repeat) console.log(`\nRun ${k} of ${repeat} failed: stopping here (runs ${k + 1}–${repeat} not started). Fix it, then start the repeat again.`)
    break
  }
}
const lastRun = runs.at(-1)
const passedRuns = runs.filter((r) => r.ok).length
const summary = repeat > 1 ? `${passedRuns} of ${repeat} runs passed${runs.length < repeat ? ` (stopped after run ${runs.length})` : ''}` : lastRun.summary
if (repeat > 1) console.log(`\n${summary}.`)
const binLine = recycleBinLine(binBefore, recycleBinCount())
console.log(binLine)
let recordInvalid = false
if (opts.record) {
  // Named for the code as it was when the first run started, and only valid if it is still that code, built fresh (and,
  // for a repeat, every run passed).
  const status = repeatStatus({ repeat, runs, before: codeBefore, after: fingerprint(root), buildStale: stale, packagedStale: packagedStale ?? packagedCheck() })
  // Each real suite's CLI home (#368): named in the record; one in the user's own home makes it not valid.
  const { homes, own } = realCliHomes(lastRun.results, SUITES)
  const problems = [...(nothingRan ? [nothingRan] : []), ...status.problems, ...(own.length ? [`ran a real CLI in the user's own home (never, #368): ${own.join(', ')}`] : [])]
  recordInvalid = problems.length > 0
  // A record that isn't valid: its run is kept as a failed one's (#223).
  if (recordInvalid) markRunFailed(lastRun.logDir, `record not valid: ${problems.join('; ')}`)
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
  // The real CLIs the real suites ran, as their Hive selected them (#365: the release's tested-with manifest).
  const clis = realCliVersions(lastRun.results, SUITES)
  const md = `${recordMarkdown({ code: codeBefore, when, jobs, results: lastRun.results, logDir: lastRun.logDir, summary, problems, notRun: notRun.map((s) => s.name), runs: repeat > 1 ? Object.assign(runs, { repeat }) : null, clis, homes, selection, packaged: packagedExe }).trimEnd()}\n\n${binLine}\n`
  const json = `${JSON.stringify(recordJson({ code: codeBefore, when, results: lastRun.results, problems, notRun: notRun.map((s) => s.name), clis, selection, packaged: packagedExe }), null, 2)}
`
  for (const r of runs) {
    writeFileSync(join(r.logDir, 'run-record.md'), md)
    writeFileSync(join(r.logDir, 'run-record.json'), json)
  }
  // The latest record is also at logs/run-record.md (and .json).
  writeFileSync(join(logsRoot, 'run-record.md'), md)
  writeFileSync(join(logsRoot, 'run-record.json'), json)
  console.log(`\n${md}\n\n(Saved as ${join(lastRun.logDir, 'run-record.md')})`)
}
// This repeat's folders are finished now (its record is saved). Older finished runs go only now, never this repeat's
// own (a repeat of more than ten keeps them all until the next run prunes) or another runner's still going, nor one a
// card cites (evidence.cjs).
finishRunDirs(runs.map((r) => r.logDir))
// A pruned run's kept suite folders go with it, in lanes this runner may work in (its own, still held, or an idle one
// it claims); in a lane another runner holds they are left for the clean-up (evidence.cjs releaseKept). Runs of the
// last day are kept too, up to a size (#1595: HIVE_E2E_KEEP_HOURS, HIVE_E2E_KEEP_MB).
const retention = logRetention()
if (retention.bad.length) console.log(`\nIgnored ${retention.bad.join(', ')}: not a number of 0 or more (the default is used).`)
// The runs to prune are listed with one look at the board, and each is looked at afresh just before it goes (HI-2364).
const look = evidence.snapshot()
await pruneRunDirsReleasing(logsRoot, undefined, runs.map((r) => r.logDir), undefined, (p) => evidence.protects(p), {
  listSpare: (p) => look.protects(p),
  keepMs: retention.keepMs,
  maxBytes: retention.maxBytes,
  onOverCap: (names, bytes) =>
    console.log(`\nThe logs came to ${Math.round(bytes / 1024 / 1024)} MB, over ${Math.round(retention.maxBytes / 1024 / 1024)} MB: pruned ${names.length} run${names.length === 1 ? '' : 's'} of the last ${retention.keepMs / 3_600_000} hours early (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}).`),
  // Held by something (#1616): kept for a later run to prune; this run's result stays its suites'.
  onKept: (name, code) => console.log(`\nKept ${join(logsRoot, name)}: something still holds it (${code}), so a later run prunes it.`),
  release: (d) => releaseKept(d, evidence, { hold: (k) => holdLane(runContext.LANES_DIR, k) })
})
if (keptAfterPass.length) console.log(`\nKept the folders of ${keptAfterPass.length} passed suite${keptAfterPass.length === 1 ? '' : 's'}: ${keptAfterPass.slice(0, 3).join('; ')}${keptAfterPass.length > 3 ? '; …' : ''}`)
// What tests left in hive-test that is no longer needed (clean.mjs), this lane's included: it is let go first. Not from
// a runner inside a suite (its parent's does it).
if (lane) {
  lane.release()
  await autoClean({ root, ev: evidence })
}
if (nothingRan) console.log(`
It failed: ${nothingRan}.`)
await progress.finish(lastRun.ok && runs.length === repeat && !recordInvalid && !nothingRan, summary, opts.record ? join(lastRun.logDir, 'run-record.md') : lastRun.logDir)
process.exit(!lastRun.ok || recordInvalid || nothingRan ? 1 : 0)
