// The run context (#203): everything a test run, and each suite in it, has of its own, so runs never assume they are
// alone on the machine or inherit whatever environment they were started from.
//
// - The environment, here: every child a test starts (a suite, a test copy of Combwork, the hive MCP server, the
//   cw-progress wrapper) gets an environment built from an allowlist (ALLOW: Windows' own variables, the user's
//   folders, the network's proxy and certificates) plus what the context sets itself (a profile, quiet, ports, the
//   suite's folders, CLI homes). Nothing else from the parent: not the variables of the Combwork session it was started
//   from (HIVE_API_TOKEN…, HIVE_PROGRESS_*), not NO_COLOR or FORCE_COLOR, not ELECTRON_RUN_AS_NODE, not CLAUDE_* or
//   ANTHROPIC_* (the real tier uses the CLIs' own sign-in). Test settings a person may set for a run are passed on by
//   name (PASS_ENV); a new one is added there, with what it is for. tests/e2esuites.test.ts fails for a suite or the
//   scenario harness that builds a child's environment from process.env.
// - The runners' own tools (#208): the runners, lib.cjs and the scenario harness run in the shell they were started
//   from, so the children they start themselves (the build, git, where.exe, taskkill) get baseEnv() too, never what a
//   call without env inherits (GIT_DIR and GIT_WORK_TREE would point their git at another repository, NODE_OPTIONS
//   reach the build). The unit test fails for a child_process call there without env. Not a child, the runners'
//   progress reporting (tests/progressReport.mts) keeps reading the shell's Combwork variables: it reports to that Combwork.
// - Folders: the work folder (WORK: the lane's, which the runner gives each suite as HIVE_E2E_DIR) and the CLI test
//   homes (CODEX_HOME, CLAUDE_TEST_HOME). What a test copy of Combwork deletes goes to its trash folder in the suite's
//   (HIVE_TEST_TRASH_DIR, `<work>	rash`, #414), never the user's Recycle Bin, and goes with the suite's folder.
// - The temp folder (TEMP, TMP, TMPDIR in ALLOW): the run's own in hive-test\tmp, which the runner sets before it
//   starts anything (tests/tempDir.ts startRunTemp, HI-2102), never %TEMP%.
// - Ports and lane folders: lanes.mjs (each runner claims a lane); each suite's port is HIVE_E2E_PORT, from its runner.
// - The build: build.mjs, under a lock per worktree, so runners started together build it once.
// - Load: slots.mjs, at most a few heavy runs at once on the machine (HEAVY_DIR); the others queue.
const fs = require('fs')
const os = require('os')
const path = require('path')

const LOCAL = process.env.LOCALAPPDATA || os.tmpdir()
/** Everything the tests keep on this machine. */
const TEST_ROOT = path.join(LOCAL, 'hive-test')
/**
 * Where runners claim their lanes (lanes.mjs): e2e and scenario runs take them from the same pool. HIVE_TEST_LANES_DIR
 * gives a pool of its own, for checking a run that waits for a lane (concurrency.mjs, #735) without holding real runs'.
 */
/** The machine's lanes (e2e-lanes); also where the one pool of its own in use is held (lanes.mjs holdOwnPool, #1127). */
const MACHINE_LANES_DIR = path.join(TEST_ROOT, 'e2e-lanes')
const LANES_DIR = process.env.HIVE_TEST_LANES_DIR || MACHINE_LANES_DIR
/** Whether LANES_DIR is a pool of its own, whose lanes take ports above the machine pool's (lanes.mjs lanesFirst, #1127). */
const OWN_LANES = !!process.env.HIVE_TEST_LANES_DIR
/**
 * Where heavy runs claim their slots (slots.mjs): one pool for the machine. HIVE_TEST_HEAVY_DIR gives a pool of its own,
 * for checking the queue (concurrency.mjs --heavy) without waiting behind real runs; HIVE_TEST_HEAVY_SLOTS, how many.
 */
const HEAVY_DIR = process.env.HIVE_TEST_HEAVY_DIR || path.join(TEST_ROOT, 'heavy-slots')
/** Where suites keep their profiles, workspaces and screenshots: the runner's lane folder, else (a suite run on its own) e2e. */
const WORK = process.env.HIVE_E2E_DIR || path.join(TEST_ROOT, 'e2e')
/** The Codex home the Codex suites and model trials use (signed in once by hand: see tests/e2e/README.md). */
const CODEX_HOME = process.env.HIVE_TEST_CODEX_HOME || path.join(TEST_ROOT, 'codex')
/** The Claude Code home the model trials use, beside the Codex one (signed in once by hand: see tests/scenarios/README.md). */
const CLAUDE_TEST_HOME = process.env.HIVE_TEST_CLAUDE_HOME || path.join(path.dirname(CODEX_HOME), 'claude')

/**
 * What a child gets from the environment it is started from, by name (any case: Windows' names are). Windows and the
 * user's folders (Node, git, PowerShell and the CLIs need them), and the network's proxy and certificates (the CLIs
 * reach their APIs through them).
 */
const ALLOW = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'OS',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'LOGONSERVER', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'DRIVERDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  // PowerShell's module path, and where a machine keeps its module-analysis cache (GitHub's runner image warms one there:
  // without it each PowerShell's first cmdlet analyses every module cold, HI-2401).
  'PSMODULEPATH', 'PSMODULEANALYSISCACHEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'
]

/**
 * Test settings a person running the tests may set, passed from the runner to its suites (and read there): nothing
 * else of theirs reaches a suite. Not HIVE_E2E_NATIVE: carddialog's native window checks take over the screen, so
 * they run only when the suite is run on its own.
 */
const PASS_ENV = {
  HIVE_TEST_CODEX_HOME: 'another Codex test home (CODEX_HOME above)',
  HIVE_TEST_CLAUDE_HOME: 'another Claude Code test home (CLAUDE_TEST_HOME above)',
  HIVE_TEST_QUIET: '0 shows the test copies of Combwork (taking focus, notifying), to watch a run',
  HIVE_TEST_PROGRESS_TIMINGS: "where the Progress panel's suite timings are kept (tests/progressReport.mts)",
  HIVE_PROGRESS_CHECK_DEV: "1: packaged-progress checks the dev build's cw-progress",
  HIVE_EXE: 'plan and lib.launch run this packaged Combwork executable instead of the dev build (the Sandbox upgrade checks, #1227)',
  HIVE_E2E_HIVE09: "boardupgrade's 0.9 Hive: a 0.9.x win-unpacked folder (else the main checkout's dist/win-unpacked, when it is 0.9.x)",
  REPLYSIZE_OUT: "replysize's report file, in the work folder"
}

/**
 * What the runner sets for each suite, carried from a suite into the test copies of Combwork it starts: a runner started
 * inside a suite (progressreport runs one in its Combwork's agent shell, which drops HIVE_ variables) knows from these that
 * it is nested, and which ports and folders to keep clear of (runner.mjs); which kinds of test slot its run holds for
 * what runs inside it (E2E_RUN_SLOTS, slots.mjs heldCredit, HI-2070); and where those copies note the CLIs they
 * selected (HIVE_TEST_CLI_LOG, in the suite's folder: the run record's real CLIs, #365).
 */
const CARRIED = ['E2E_RUN_SUITE', 'E2E_RUN_DIR', 'E2E_RUN_PORT', 'E2E_RUN_SLOTS', 'HIVE_TEST_CLI_LOG']

/** The variables of `parent` named in `names` (any case), under their own spelling. */
function pick(parent, names) {
  const wanted = new Set(names.map((n) => n.toUpperCase()))
  const env = {}
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && wanted.has(k.toUpperCase())) env[k] = v
  return env
}

/** Sets each of `vars` in env (replacing a spelling in another case); undefined removes it. */
function apply(env, vars) {
  for (const [k, v] of Object.entries(vars)) {
    for (const old of Object.keys(env)) if (old.toUpperCase() === k.toUpperCase()) delete env[old]
    if (v !== undefined && v !== null) env[k] = String(v)
  }
  return env
}

/**
 * PATH without the folders of the cw-progress shims the user's copies of Combwork install (`%APPDATA%\Combwork\bin`, `Combwork-Dev\bin`,
 * and before HI-2461 `Hive\bin`, `Hive-Dev\bin`),
 * which an agent's session has on its PATH (#1253): they run the installed Combwork.exe (or the main checkout's dev build), so
 * a test's `cw-progress` would start another Combwork than its own, and report to the user's. A test Combwork puts its own
 * shims on its sessions' PATH.
 */
function withoutHiveShims(env, parent) {
  if (!parent.APPDATA) return env
  const shims = ['Hive', 'Hive-Dev', 'Combwork', 'Combwork-Dev'].map((p) => path.win32.join(parent.APPDATA, p, 'bin').toLowerCase())
  const same = (d) => path.win32.normalize(d).replace(/[\\/]+$/, '').toLowerCase()
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') env[k] = env[k].split(';').filter((d) => !shims.includes(same(d))).join(';')
  }
  return env
}

/** The allowlisted environment, and nothing else: for a child that isn't Combwork (git, a test server). */
function baseEnv(parent = process.env) {
  return withoutHiveShims(pick(parent, ALLOW), parent)
}

/**
 * A child that is part of Combwork but not a copy of it (the hive MCP server, the cw-progress wrapper, a bridge): the
 * allowlist and `vars` (the Agent API URL and token it should use, ELECTRON_RUN_AS_NODE where Electron runs it as Node).
 */
function childEnv(vars = {}, parent = process.env) {
  return apply(baseEnv(parent), vars)
}

/** The environments hiveEnv built: lib.cjs's _electron.launch refuses any other (so no suite starts Combwork with its own). */
const built = new WeakSet()

/** Where the test copies of Combwork a suite starts put what they delete (#414): its work folder's `trash`. */
const trashDir = (parent = process.env) => path.join(parent.HIVE_E2E_DIR || WORK, 'trash')

/**
 * The CLI homes a test copy of Combwork gets unless its suite gives it others (#382): empty folders in its work folder's
 * `cli-homes`, so Combwork's look for the CLIs when it starts (`claude auth status`, `codex login status`, Copilot's
 * config.json and `gh auth status`, #452) reads them, never the user's ~/.claude, ~/.codex, ~/.copilot or GitHub CLI
 * login (an empty GH_CONFIG_DIR hides it: Copilot falls back to it). A suite passes a test home instead (the fake
 * Claude Code's, its own, the Codex test home) in hiveEnv's vars.
 */
function cliHomes(parent = process.env) {
  const base = path.join(parent.HIVE_E2E_DIR || WORK, 'cli-homes')
  return { CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'), COPILOT_HOME: path.join(base, 'copilot'), GH_CONFIG_DIR: path.join(base, 'gh') }
}

/**
 * The commit identity of a test copy of Combwork's git (#1466), in the global git config it gets (gitConfig), so its screens
 * (the Version Control tab's Commit identity, the Initialise dialog's "will commit as") and its commits never show the
 * machine's. A suite that needs none, or another, gives its Combwork a GIT_CONFIG_GLOBAL of its own (gitinit, p5scenarios).
 */
const TEST_GIT_IDENTITY = { name: 'Hive Test', email: 'hive-test@example.invalid' }

/** A suite's global git config (#1466): its work folder's `gitconfig`, which lib.cjs writes (writeGitConfig). */
const gitConfig = (parent = process.env) => path.join(parent.HIVE_E2E_DIR || WORK, 'gitconfig')

/**
 * Writes a work folder's global git config: the test identity, and line endings as they are stored (core.autocrlf
 * false, git's own default): with no system config (GIT_CONFIG_NOSYSTEM) nothing else is read, so a suite's git and its
 * test Combwork's check files out the same on any machine; Git for Windows' system autocrlf=true for one and not the other
 * made Combwork take CRLF checkouts for uncommitted changes (#1466 round 1). Only when it says something else (or nothing),
 * so a test Combwork already reading it never finds it half written.
 */
function writeGitConfig(file) {
  const text = `[user]\n\tname = ${TEST_GIT_IDENTITY.name}\n\temail = ${TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`
  let old = null
  try {
    old = fs.readFileSync(file, 'utf8')
  } catch {
    // none yet
  }
  if (old === text) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/**
 * A suite's git on its fixtures (lib.git, its repositories and worktrees): the allowlist, and the git config its test
 * Combwork has (gitConfig, no system config), so both read the same settings (#1466). Not the runners' git on the checkout
 * under test (baseEnv): that worktree is checked out with the machine's settings.
 */
function gitEnv(vars = {}, parent = process.env) {
  return apply(apply(baseEnv(parent), { GIT_CONFIG_GLOBAL: gitConfig(parent), GIT_CONFIG_NOSYSTEM: '1' }), vars)
}

/** Whether a file is the user's own global git config (~/.gitconfig, or git's XDG one), however its path is spelled. */
function isUserGitConfig(file, parent = process.env) {
  const profile = parent.USERPROFILE || os.homedir()
  const same = (p) => path.win32.resolve(p).toLowerCase()
  return !!file && [path.win32.join(profile, '.gitconfig'), path.win32.join(profile, '.config', 'git', 'config')].some((f) => same(f) === same(file))
}

/**
 * Whether a folder is the user's own Claude Code, Codex or Copilot home (~/.claude, ~/.codex, ~/.copilot) or GitHub CLI
 * config (%APPDATA%\GitHub CLI), however its path is spelled.
 */
function isUserCliHome(dir, parent = process.env) {
  const profile = parent.USERPROFILE || os.homedir()
  const same = (p) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const own = ['.claude', '.codex', '.copilot'].map((d) => path.win32.join(profile, d))
  if (parent.APPDATA) own.push(path.win32.join(parent.APPDATA, 'GitHub CLI'))
  return !!dir && own.some((d) => same(d) === same(dir))
}

/**
 * A test copy of Combwork's environment: the allowlist; quiet (unless HIVE_TEST_QUIET=0 was set for the run) and with tips
 * off (a profile that sets Show a tip turns them on); in English (HIVE_LANG=en, #767: suites find the window by its English
 * text, and dates and numbers format the same on any Windows; `vars` can set another language); its trash folder (HIVE_TEST_TRASH_DIR: the suite's, #414, so it
 * never uses the user's Recycle Bin); the CLI homes (CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME, GH_CONFIG_DIR: empty
 * folders of the suite's, cliHomes, #382, #452, so it never reads the user's); its git's config (GIT_CONFIG_GLOBAL: the
 * work folder's, with the test identity and line endings, gitConfig, #1466; GIT_CONFIG_NOSYSTEM), so its git never reads
 * the user's ~/.gitconfig or the machine's, and matches its suite's (gitEnv); the suite's Agent API port from its runner
 * (HIVE_E2E_PORT), and the CARRIED variables; then `vars` (its profile, HIVE_USER_DATA, always; a port, test CLI homes,
 * test hooks), where undefined removes one (lib.cjs refuses to start a test Combwork without each home or a global git config).
 */
function hiveEnv(vars = {}, parent = process.env) {
  const env = baseEnv(parent)
  env.HIVE_TEST_QUIET = parent.HIVE_TEST_QUIET === '0' ? '0' : '1'
  env.HIVE_TEST_TIPS = 'off'
  // Its CLI test home stands in for a connection where its workspace has none on (HI-1755's seam, DEV_SEAMS): suites
  // launch agents as before connections; the connections suites set it to '0' to test the real rule.
  env.HIVE_TEST_CLI_HOME_CONNECTION = '1'
  env.HIVE_LANG = 'en'
  env.HIVE_TEST_TRASH_DIR = trashDir(parent)
  Object.assign(env, cliHomes(parent))
  env.GIT_CONFIG_GLOBAL = gitConfig(parent)
  env.GIT_CONFIG_NOSYSTEM = '1'
  if (parent.HIVE_E2E_PORT) env.HIVE_API_PORT = parent.HIVE_E2E_PORT
  Object.assign(env, pick(parent, CARRIED))
  apply(env, vars)
  built.add(env)
  return env
}

/** Whether env was built by hiveEnv (and so holds nothing from the parent but the allowlist). */
const isHiveEnv = (env) => !!env && built.has(env)

/**
 * A suite's environment, from its runner: the allowlist, the PASS_ENV settings, and its run context: its folder
 * (HIVE_E2E_DIR, which WORK reads), its Agent API port (HIVE_E2E_PORT, lib.port()), and the same said without the
 * HIVE_ prefix (E2E_RUN_*), which survive into a test Combwork's agent shells; the kinds of test slot its run holds or was
 * given for what runs inside it (slots: E2E_RUN_SLOTS, slots.mjs creditFor, HI-2070: none from a light run); and the
 * file its test copies of Combwork note the CLIs they selected in (cliLog: HIVE_TEST_CLI_LOG, #365).
 */
function suiteEnv({ name, port = null, work = null, runDir, cliLog = null, slots = '' }, parent = process.env) {
  const env = apply(baseEnv(parent), pick(parent, Object.keys(PASS_ENV)))
  env.E2E_RUN_SLOTS = slots
  if (work) env.HIVE_E2E_DIR = work
  if (cliLog) env.HIVE_TEST_CLI_LOG = cliLog
  if (port) {
    env.HIVE_E2E_PORT = String(port)
    env.HIVE_API_PORT = String(port)
    env.E2E_RUN_PORT = String(port)
  }
  env.E2E_RUN_SUITE = name
  env.E2E_RUN_DIR = runDir
  return env
}

module.exports = { TEST_ROOT, MACHINE_LANES_DIR, LANES_DIR, OWN_LANES, HEAVY_DIR, WORK, CODEX_HOME, CLAUDE_TEST_HOME, ALLOW, PASS_ENV, CARRIED, baseEnv, childEnv, hiveEnv, isHiveEnv, suiteEnv, trashDir, cliHomes, isUserCliHome, TEST_GIT_IDENTITY, gitConfig, writeGitConfig, gitEnv, isUserGitConfig }
