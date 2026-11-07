// The CLI test homes start each run fresh, keeping only the sign-in (HI-2606; its design s17 with Darren's answers, 7 Nov).
// A real suite or a model trial runs a real CLI from a long-lived, signed-in home under %LOCALAPPDATA%\combwork-test;
// what earlier runs left there (memory, transcripts, per-folder trust, a stray MCP server, history, skill use) could make
// a test pass that a new user's CLI would fail. So, under the home's lease (testHomeLock.mjs), before each run:
//
// - The CLI's own sign-in status first: signed in, or the reset doesn't happen (signed out: the run is skipped for its
//   environment; an answer that can't be read: it stops, saying so).
// - No CLI may still be using the home (this run's own CLI descendants; after taking over from a holder that didn't let
//   go, CLIs that run may have left): it waits, bounded, then refuses, naming them. It never ends a process. A lease
//   reused from a parent run never resets.
// - Each entry is classified (testHomeManifest.mjs): the sign-in files are never opened, copied, written or removed; kept
//   files stay; `clear` ones go (a link is removed as a link, never followed); an unclassified one is kept and reported.
// - Claude Code's .claude.json and Codex's config.toml keep only their account and onboarding fields, written through a
//   temp file and a rename, the old bytes set aside first (`.reset-backup`, never a credential).
// - A marker (`.reset-in-progress`) is written first and removed last: an interrupted reset is done again whole at the
//   next one, under its own lease. A marker never puts anything back (rewrites go through a temp file and a rename, so
//   they landed or didn't): newer CLI state is never overwritten from an old copy.
// - The status again: signed in, done. Signed out: only .claude.json is put back from the aside copy, if its bytes are
//   still exactly what the reset wrote, and checked once more; still signed out, or an answer that can't be read, stops the run. The sign-in
//   itself is never put back or signed in again by a test.
//
// `--warm-homes` (e2e, scenarios) and a suite's `home: 'warm'` skip it, keeping what earlier runs left, on purpose.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { createRequire } from 'module'
import { parse as parseToml, stringify as toToml } from 'smol-toml'
import { classify, HOME_NAMES, KEPT_FIELDS, matches, SIGN_IN, UNCLASSIFIED } from './testHomeManifest.mjs'
import { clearConsumers, holderOf } from './testHomeLock.mjs'

const ctx = createRequire(import.meta.url)('./runContext.cjs')

export const MARKER = '.reset-in-progress'
export const BACKUP = '.reset-backup'
/** What a CLI's home rewrites, keeping only KEPT_FIELDS. */
const SETTINGS = { claude: '.claude.json', codex: 'config.toml' }
const sha = (text) => createHash('sha256').update(text).digest('hex')

/** Why a reset didn't happen, or stopped: `kind` is `signedOut` (skip the run: environment), `unknown`, `busy`, `nested` or `scope`. */
export class HomeNotReady extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

/**
 * The CLI's own answer on its sign-in in a home: `in`, `out` or `unknown` (it timed out, failed to start, or printed
 * something that can't be read). Claude Code: `auth status --json`; Codex: `login status`.
 */
export function signInStatus(cli, home, { run = runCli } = {}) {
  const env = cli === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }
  const r = run(cli === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], cli, env)
  if (!r) return 'unknown'
  if (cli === 'claude') {
    try {
      const j = JSON.parse(String(r.stdout ?? '').trim())
      if (j && typeof j === 'object' && typeof j.loggedIn === 'boolean') return j.loggedIn ? 'in' : 'out'
    } catch {
      // Below.
    }
    return 'unknown'
  }
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (/not logged in/i.test(text)) return 'out'
  if (r.code === 0 && /logged in/i.test(text)) return 'in'
  return 'unknown'
}

/** Runs a CLI's status command with only the home's variable added to the run's environment; null when it couldn't. */
function runCli(args, cli, env) {
  const exe = cli === 'claude' ? ['.local\\bin\\claude.exe'].map((f) => join(process.env.USERPROFILE ?? '', f)).find((f) => existsSync(f)) ?? 'claude' : 'codex'
  try {
    const stdout = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], { env: ctx.childEnv(env), encoding: 'utf8', timeout: 30000, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    if (typeof e?.status !== 'number') return null
    return { code: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

/** A process that is a CLI a test run starts: Claude Code, Codex, or node (their npm shims, cw-mcp). */
const CLI_EXE = /^(claude|codex|node)(\.exe)?$/i
const exeOf = (cmd) => /^\s*(?:"([^"]+)"|(\S+))/.exec(String(cmd ?? ''))?.slice(1).find(Boolean)?.split(/[\\/]/).pop() ?? ''

/**
 * Who may still be using a home, from evidence tied to it (HR1 on s17 and s29), never a guess from names:
 * - the consumers its lease state keeps (testHomeLock.mjs), until a reset proves them gone:
 *   - a suite's folder, registered before the suite starts: any process whose command line names it (Combwork's CLI
 *     launches pass their settings, MCP config and hook files from its profile there), and the test copies of Combwork it
 *     recorded there;
 *   - a process (a suite, a test copy, a holder that ended without letting go): itself while running (the same pid and
 *     start), and every CLI it started since, by its parent chain (a CLI told the home only by its environment too);
 * - given `self`, this process's own CLI descendants (a scenario run starts nothing else).
 * A process list that can't be read is itself a user: no reset without it. Never ends anything; a process of another
 * home's is never looked at.
 */
export function homeUsers(cli, home, { lease = null, processes = listProcesses, self = null } = {}) {
  const list = processes()
  if (!list) return ['the process list (it couldn\'t be read)']
  const fp = createRequire(import.meta.url)('./folderProcesses.cjs')
  const state = lease?.dir ? holderOf(lease.dir) : null
  const roots = []
  const users = []
  for (const c of state?.consumers ?? []) {
    if (c.folder) {
      for (const p of list) if (p.pid !== process.pid && fp.namesFolder(String(p.commandLine ?? ''), c.folder)) users.push(`${exeOf(p.commandLine) || 'a process'} (pid ${p.pid}, naming ${c.folder})`)
      for (const copy of fp.recordedCopies(c.folder)) roots.push({ ...copy, why: `a test copy of Combwork from ${c.folder}` })
    } else roots.push({ ...c, why: 'what used it under an earlier lease' })
  }
  if (self) roots.push({ pid: self.pid, started: self.started, why: "this run's", own: true })
  for (const r of roots) {
    const same = (p) => p.pid === r.pid && Math.abs(p.started - (r.started ?? p.started)) <= 2000
    if (!r.own && list.some(same)) users.push(`pid ${r.pid} (${r.why})`)
    for (const d of fp.descendantsIn(list, r.pid)) {
      const p = list.find((x) => x.pid === d.pid)
      if (p && p.started >= (r.started ?? 0) - 2000 && (CLI_EXE.test(exeOf(p.commandLine)) || !r.own)) users.push(`${exeOf(p.commandLine) || 'a process'} (pid ${p.pid}, started by ${r.why})`)
    }
  }
  return [...new Set(users)]
}

/** The machine's processes with their command lines, or null when they can't be listed. */
function listProcesses() {
  const fp = createRequire(import.meta.url)('./folderProcesses.cjs')
  try {
    return fp.processes?.() ?? null
  } catch {
    return null
  }
}

const safeList = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** A home a reset may touch: a real folder under the test root, not a user's own CLI home, not reached through a link. */
export function assertTestHome(home, root = ctx.TEST_ROOT) {
  const abs = resolve(home)
  let real
  try {
    real = realpathSync.native(abs)
  } catch {
    throw new HomeNotReady('scope', `the test home ${abs} isn't there`)
  }
  const inside = (p) => {
    const r = relative(resolve(root).toLowerCase(), p.toLowerCase())
    return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
  }
  if (ctx.isUserCliHome(abs) || ctx.isUserCliHome(real)) throw new HomeNotReady('scope', `${abs} is a user's own CLI home: never reset`)
  if (!inside(abs) || !inside(real)) throw new HomeNotReady('scope', `${abs} isn't under the test root ${root}: never reset`)
  if (lstatSync(abs).isSymbolicLink()) throw new HomeNotReady('scope', `${abs} is a link: never reset`)
  return real
}

/** A kept settings file with only its kept fields: Claude Code's .claude.json (JSON), Codex's config.toml (TOML). */
export function keptSettings(cli, text) {
  const keep = KEPT_FIELDS[cli]
  if (cli === 'claude') {
    const j = JSON.parse(text)
    const out = Object.fromEntries(Object.entries(j).filter(([k]) => matches(k, keep)))
    return `${JSON.stringify(out, null, 2)}\n`
  }
  const t = parseToml(text)
  const out = Object.fromEntries(Object.entries(t).filter(([k]) => keep.includes(k)))
  return toToml(out)
}

/** Writes a file through a temp file and a rename (a crash leaves the old or the new, never half of one). */
function writeAtomic(file, text) {
  const tmp = `${file}.reset-tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Removes one entry of a home: a link (symlink or junction) as a link, never followed; else the file or folder. */
function removeEntry(path) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(path)
    } catch {
      // A junction to a folder: removed as a link (rmdir), never its target's contents.
      rmSync(path, { force: true })
    }
    return
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Resets a CLI's test home to its sign-in, its kept files and its kept settings (above). Returns what it did:
 * `{ cleared, rewrote, unclassified, finishedInterrupted }`. Throws HomeNotReady when the home can't be reset now.
 * `deps` (tests): `status(cli, home)`, `users(cli, home)`, `waitMs` (how long to wait for users to end), `pollMs`.
 */
export async function freshenHome(cli, home, deps = {}) {
  const lease = deps.lease ?? null
  // A lease reused from a parent (a nested run) never resets: the parent may be using the home (HR1 on s17).
  if (lease?.reused) throw new HomeNotReady('nested', `${HOME_NAMES[cli]}'s test home is held by a parent run: a nested run doesn't reset it`)
  const status = deps.status ?? ((c, h) => signInStatus(c, h))
  const users = deps.users ?? ((c, h) => homeUsers(c, h, { lease, self: deps.self ?? null }))
  const waitMs = deps.waitMs ?? 60_000
  const pollMs = deps.pollMs ?? 1000
  const root = deps.root ?? ctx.TEST_ROOT
  const name = HOME_NAMES[cli]
  const real = assertTestHome(home, root)
  const marker = join(real, MARKER)
  const finishedInterrupted = existsSync(marker)

  // Nobody using it: wait, bounded, then refuse, naming them.
  const until = Date.now() + waitMs
  let busy = await users(cli, real)
  while (busy.length && Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs))
    busy = await users(cli, real)
  }
  if (busy.length) throw new HomeNotReady('busy', `${name}'s test home ${real} is still in use (${busy.join(', ')}): not reset; nothing was ended`)
  // None of what used it is there any more: its consumers are let go (HR1 on s29: only a reset that proved them gone).
  clearConsumers(lease)

  const before = await status(cli, real)
  if (before === 'out') throw new HomeNotReady('signedOut', `${name} isn't signed in to its test home ${real} (tests/e2e/README.md): not reset`)
  if (before !== 'in') throw new HomeNotReady('unknown', `${name}'s sign-in status in ${real} couldn't be read: not reset`)

  const entries = safeList(real)
  const clear = entries.filter((e) => classify(cli, e) === 'clear')
  const unclassified = entries.filter((e) => classify(cli, e) === 'unclassified')
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), cli, clear, policy: UNCLASSIFIED }, null, 2))

  // The kept settings file: its old bytes aside, then only its kept fields.
  const settings = join(real, SETTINGS[cli])
  let written = null
  const backup = join(real, BACKUP, SETTINGS[cli])
  if (existsSync(settings)) {
    mkdirSync(join(real, BACKUP), { recursive: true })
    const old = readFileSync(settings, 'utf8')
    writeFileSync(backup, old)
    const kept = keptSettings(cli, old)
    writeAtomic(settings, kept)
    written = sha(kept)
  }
  for (const e of clear) {
    // Never a sign-in file, however a pattern reads (classify puts it first; asserted again).
    if (matches(e, SIGN_IN[cli])) continue
    removeEntry(join(real, e))
  }
  rmSync(marker, { force: true })

  const after = await status(cli, real)
  if (after === 'in') return { cleared: clear, rewrote: written ? [SETTINGS[cli]] : [], unclassified, finishedInterrupted }
  if (after === 'out' && cli === 'claude' && written && existsSync(backup)) {
    // Only .claude.json, and only while its bytes are exactly what the reset wrote (a status command that wrote account
    // data since keeps it, HR1 on s17): never the sign-in.
    if (sha(readFileSync(settings, 'utf8')) === written) {
      writeAtomic(settings, readFileSync(backup, 'utf8'))
      if ((await status(cli, real)) === 'in') throw new HomeNotReady('unknown', `${name} was signed out after its test home ${real} was reset, and back once its .claude.json was put back: the kept fields (testHomeManifest.mjs) miss one it needs; the run stops`)
    }
  }
  if (after === 'out') throw new HomeNotReady('signedOut', `${name} isn't signed in to its test home ${real} after it was reset: the run stops; its sign-in was never touched (tests/e2e/README.md)`)
  throw new HomeNotReady('unknown', `${name}'s sign-in status in ${real} couldn't be read after it was reset: the run stops`)
}

/** What a reset said, as a line for the run's report (unclassified entries named, as Darren asked). */
export function freshenedLine(cli, r) {
  const parts = [`${HOME_NAMES[cli]}'s test home reset: ${r.cleared.length} cleared${r.rewrote.length ? `, ${r.rewrote.join(', ')} rewritten` : ''}`]
  if (r.finishedInterrupted) parts.push('an interrupted reset finished')
  if (r.unclassified.length) parts.push(`kept, not classified in testHomeManifest.mjs: ${r.unclassified.join(', ')}`)
  return parts.join('; ')
}
