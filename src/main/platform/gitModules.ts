// Submodules and Git LFS in the folders Combwork makes from a repository (HI-1182, SPEC §16.6.6 and §16.20's Git
// support): slots, review and check copies and the merge queue's folder. A linked worktree's checkout leaves submodules
// empty and, with the checkout's LFS smudge skipped (Combwork's checkouts while the setting is on: GIT_LFS_SKIP_SMUDGE),
// LFS files as pointers; this step makes them real, as a run of Combwork's, before the folder's setup and checks.
//
// What it never does (HI-1182/s10–s16, agreed with HR2): `git submodule sync` or a top-level `--init` (both write the
// shared .git/config, so the main checkout's), `git submodule foreach`, a push, or any write to the user's or the
// repository's config. The top level is one `git submodule update` whose config (`submodule.active`, and each URL the
// repository config doesn't set) comes only from git's command-line config in the environment (GIT_CONFIG_COUNT…),
// composed before whatever the run's environment already carries, so the user's entries still win. A linked worktree
// clones its submodules into its own git dir (`<worktree git dir>/modules/<name>`): nested submodules are initialised
// inside those private clones only, each after its folder is checked to be exactly that clone, with the superproject
// fenced off (GIT_CEILING_DIRECTORIES). Before anything changes, each first-level submodule's folder is checked: missing,
// empty or this worktree's own clone, else the step fails naming it and nothing is touched. A copy's submodule whose
// gitlink is gone is removed only when this copy's own private clone claims it, by a literal path inside the copy.
// LFS is the superproject's (`git lfs pull`, its objects shared by every worktree in the common dir); a submodule's
// LFS files are smudged as the user's own git-lfs filter config says. Every git here runs with no prompt.

import { lstat, readdir, readFile, realpath } from 'original-fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { agentMsg, inDefaultDialect, say, type AgentMsg, type AgentValues } from '../../shared/agentText'
import { git } from '../git'
import type { GitFilesStatus } from '../../shared/types'
import type { WorkspaceFilesExec, WorkspaceFilesOutcome, WorkspaceFilesStep, WorkspaceToolRun } from './workspacePort'

/** A git run's answer in the step, and how the step runs git (the port's types, workspacePort.ts). */
export type GitFilesRun = WorkspaceToolRun
export type GitFilesExec = WorkspaceFilesExec

/** The step's run title in the Progress panel: the git commands it may run (a command line, not text: never translated). */
export const GIT_FILES_TITLE = 'git submodule update · git lfs pull' // i18n-ignore: git commands, as they are (a run's title)

/** A submodule of the folder's revision: its name, its path (as .gitmodules writes it), and its URL there. */
export interface Submodule {
  name: string
  path: string
  url: string | null
}

/** What a folder uses at its revision: its gitlinked submodules, and how many files git's attributes give to LFS. */
export interface GitFilesUse {
  submodules: Submodule[]
  lfsFiles: number
}

/** A preparation's outcome: done (what ran), nothing to do, or why not (stored, in the Default dialect). */
export type GitFilesOutcome = WorkspaceFilesOutcome

const T = {
  unread: agentMsg({ id: 'gitFiles.error.unread', text: "Combwork couldn't tell whether submodules or Git LFS are used: {error}", note: "A slot's or copy's setup error (HI-1182): git's read of .gitmodules or the LFS attributes failed. {error} is git's first line." }),
  foreign: agentMsg({ id: 'gitFiles.error.foreign', text: "submodule {name}: {path} holds files or a repository Combwork didn't set up. Move it away, or turn off Set up submodules and LFS", note: "A slot's or copy's setup error (HI-1182): a submodule's folder already holds something that isn't this folder's own submodule clone, so Combwork changes nothing. {name} is the submodule's name, {path} its folder. Set up submodules and LFS is a setting's name: keep it as Combwork shows it." }),
  badPath: agentMsg({ id: 'gitFiles.error.badPath', text: "submodule {name}'s path {path} isn't a folder inside this one", note: "A slot's or copy's setup error (HI-1182): .gitmodules gives a submodule a path that is empty, absolute or goes outside the folder. {name} is its name, {path} the path." }),
  url: agentMsg({ id: 'gitFiles.error.url', text: "Combwork can't resolve submodule {name}'s URL {url}: set submodule.{name}.url", note: "A slot's or copy's setup error (HI-1182): a relative submodule URL Combwork can't resolve as git would. {name} is the submodule's name, {url} the URL; submodule.{name}.url is a git config key, as it is." }),
  noUrl: agentMsg({ id: 'gitFiles.error.noUrl', text: 'submodule {name} has no URL in .gitmodules', note: "A slot's or copy's setup error (HI-1182): a submodule .gitmodules names has no url. {name} is its name." }),
  update: agentMsg({ id: 'gitFiles.error.update', text: 'git submodule update: {error}', note: "A slot's or copy's setup error (HI-1182): `git submodule update` failed. {error} is git's first line, else failed." }),
  nested: agentMsg({ id: 'gitFiles.error.nested', text: 'submodule {name}: git submodule update: {error}', note: "A slot's or copy's setup error (HI-1182): initialising the submodules inside submodule {name} failed. {error} is git's first line, else failed." }),
  noLfs: agentMsg({ id: 'gitFiles.error.noLfs', text: "Git LFS is used, but git-lfs isn't installed", note: "A slot's or copy's setup error (HI-1182): the repository has files in Git LFS and git-lfs couldn't be run. Git LFS and git-lfs are names, as they are." }),
  noLfsFilter: agentMsg({ id: 'gitFiles.error.noLfsFilter', text: "Git LFS is used, but it isn't set up for this repository: run git lfs install", note: "A slot's or copy's setup error (HI-1182): git-lfs is installed but no LFS filter is configured (git lfs install was never run), so git lfs pull would leave pointer files. Git LFS and git lfs install are a name and a command, as they are." }),
  lfs: agentMsg({ id: 'gitFiles.error.lfs', text: 'git lfs pull: {error}', note: "A slot's or copy's setup error (HI-1182): `git lfs pull` failed. {error} is git-lfs's first line, else failed." }),
  removeLeft: agentMsg({ id: 'gitFiles.error.removeLeft', text: "the folder of removed submodule {path} couldn't be removed: {error}", note: "A copy's setup error (HI-1182): a submodule the revision no longer has left its folder, and Combwork couldn't remove it. {path} is the folder, {error} git's first line or why." }),
  stopped: agentMsg({ id: 'gitFiles.error.stopped', text: 'the setup of submodules and Git LFS was ended', note: "A slot's or copy's setup error (HI-1182): the run was ended (its time limit, or the workspace closing) before it finished." })
}

const stored = (m: AgentMsg, values?: AgentValues): string => inDefaultDialect(() => say(m, values))

/** git's first line of an error, else `failed`. */
const firstLine = (r: GitFilesRun): string => (r.err || r.out).trim().split(/\r?\n/).find((l) => l.trim())?.trim() || 'failed'

/** No git here waits on a prompt nobody sees: no terminal prompt, no askpass, a credential manager kept non-interactive. */
export const NO_PROMPT: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }

/** Combwork's checkouts of a slot, copy or queue folder while the setting is on: LFS files left as pointers for `git lfs pull`. */
export const SKIP_SMUDGE: Readonly<Record<string, string>> = { GIT_LFS_SKIP_SMUDGE: '1' }

/** Pathspecs read literally whatever the environment says (a path from .gitmodules can hold `[`, `*`, `:`). */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }

const winPaths = process.platform === 'win32'
const key = (p: string): string => (winPaths ? resolve(p).toLowerCase() : resolve(p))
/** Whether `inner` is strictly inside `outer` (both resolved). */
const strictlyInside = (outer: string, inner: string): boolean => {
  const o = key(outer).replace(/[\\/]+$/, '')
  const i = key(inner)
  return i !== o && i.startsWith(o + sep)
}
const same = (a: string, b: string): boolean => key(a) === key(b)

/** A path's real location, or null when it can't be resolved (gone, a loop). */
async function real(p: string): Promise<string | null> {
  return realpath(p).catch(() => null)
}

/**
 * git's command-line config in the environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n), `ours` first and
 * then whatever `base` already carries, renumbered after them: later entries win, so the user's (or a test's) still do.
 */
export function composeConfigEnv(base: Record<string, string | undefined>, ours: readonly (readonly [string, string])[]): Record<string, string> {
  const get = (name: string): string | undefined => {
    const k = Object.keys(base).find((x) => x.toUpperCase() === name)
    return k === undefined ? undefined : base[k]
  }
  const n = Number(get('GIT_CONFIG_COUNT'))
  const theirs: [string, string][] = []
  if (Number.isInteger(n) && n > 0) {
    for (let i = 0; i < n; i++) {
      const k = get(`GIT_CONFIG_KEY_${i}`)
      // A broken entry is git's to refuse, as it would have: kept as it is.
      theirs.push([k ?? '', get(`GIT_CONFIG_VALUE_${i}`) ?? ''])
    }
  }
  const all = [...ours, ...theirs]
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(all.length) }
  all.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k
    out[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return out
}

// ---- Relative submodule URLs, as `git submodule init` resolves them (git's remote.c relative_url and chop_last_dir) ----

const isDirSep = (c: string | undefined): boolean => c === '/' || (winPaths && c === '\\')
const dotSlash = (s: string): boolean => s[0] === '.' && isDirSep(s[1])
const dotDotSlash = (s: string): boolean => s[0] === '.' && s[1] === '.' && isDirSep(s[2])
const dosDrive = (s: string): boolean => winPaths && /^[A-Za-z]:/.test(s)
const absolutePath = (s: string): boolean => isDirSep(s[0]) || (dosDrive(s) && isDirSep(s[2]))
/** git's url_is_local_not_ssh: no colon, a slash before the first colon, or a DOS drive. */
function localNotSsh(url: string): boolean {
  const colon = url.indexOf(':')
  const slash = url.search(winPaths ? /[\\/]/ : /\//)
  return colon < 0 || (slash >= 0 && slash < colon) || dosDrive(url)
}

/**
 * A submodule URL resolved against the superproject's default remote URL (or its folder) as `git submodule init` writes
 * it; an absolute URL as it is. Null where git would refuse it or where the base is itself relative (git would write a
 * relative URL, which a clone elsewhere would read differently): the caller fails clearly rather than pick another one.
 */
export function resolveSubmoduleUrl(url: string, base: string): string | null {
  if (!localNotSsh(url) || absolutePath(url)) return url
  if (!dotSlash(url) && !dotDotSlash(url)) return url
  if (!base) return null
  let remote = base
  if (isDirSep(remote[remote.length - 1])) remote = remote.slice(0, -1)
  if (!remote) return null
  // A relative remote: git would write a relative URL here, not one a worktree elsewhere reads the same.
  if (localNotSsh(remote) && !absolutePath(remote)) return null
  let rest = url
  let colonsep = false
  for (;;) {
    if (dotDotSlash(rest)) {
      rest = rest.slice(3)
      let at = -1
      for (let i = remote.length - 1; i >= 0; i--) {
        if (isDirSep(remote[i])) {
          at = i
          break
        }
      }
      if (at >= 0) {
        remote = remote.slice(0, at)
        continue
      }
      const colon = remote.lastIndexOf(':')
      if (colon >= 0) {
        remote = remote.slice(0, colon)
        colonsep = true
        continue
      }
      // git dies here ("cannot strip one component off url") or falls back to "." for a bare word: neither is a place.
      return null
    } else if (dotSlash(rest)) rest = rest.slice(2)
    else break
  }
  let out = `${remote}${colonsep ? ':' : '/'}${rest}`
  if (rest.endsWith('/')) out = out.slice(0, -1)
  return dotSlash(out) ? out.slice(2) : out
}

// ---- Detection ----

/** A NUL-separated list's entries. */
const nul = (s: string): string[] => s.split('\0').filter(Boolean)

/** `submodule.<name>.<field>` entries of `git config -z --get-regexp`, by name. */
function configEntries(out: string, field: RegExp): Map<string, Map<string, string>> {
  const by = new Map<string, Map<string, string>>()
  for (const e of nul(out)) {
    const nl = e.indexOf('\n')
    const k = nl < 0 ? e : e.slice(0, nl)
    const v = nl < 0 ? '' : e.slice(nl + 1)
    const m = /^submodule\.(.+)\.([^.]+)$/i.exec(k)
    if (!m || !field.test(m[2])) continue
    const f = by.get(m[1]) ?? new Map<string, string>()
    f.set(m[2].toLowerCase(), v)
    by.set(m[1], f)
  }
  return by
}

/**
 * What a folder uses at its checked-out revision (one read for both, nested .gitattributes counted): its submodules (from
 * .gitmodules, only those with a gitlink at their path) and its LFS files. Null `error`: the read failed, which is never
 * taken for "unused".
 */
export async function gitFilesUse(x: Pick<GitFilesExec, 'git'>, folder: string): Promise<GitFilesUse | { error: string }> {
  // Magic pathspecs here (top, literal, attr), whatever GIT_LITERAL_PATHSPECS the environment has.
  const listed = await x.git(folder, ['ls-files', '-z', '--', ':(top,literal).gitmodules', ':(attr:filter=lfs)'], { env: { GIT_LITERAL_PATHSPECS: '0' } })
  if (!listed.ok) return { error: stored(T.unread, { error: firstLine(listed) }) }
  const files = nul(listed.out)
  const lfsFiles = files.filter((f) => f !== '.gitmodules').length
  if (!files.includes('.gitmodules')) return { submodules: [], lfsFiles }
  const cfg = await x.git(folder, ['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'])
  // 1: no such entries (an empty .gitmodules).
  if (!cfg.ok && cfg.code !== 1) return { error: stored(T.unread, { error: firstLine(cfg) }) }
  const entries = configEntries(cfg.out, /^(path|url)$/i)
  const named = [...entries].flatMap(([name, f]) => (f.get('path') ? [{ name, path: f.get('path')!, url: f.get('url') ?? null }] : []))
  if (!named.length) return { submodules: [], lfsFiles }
  const staged = await x.git(folder, ['ls-files', '-s', '-z', '--', ...named.map((s) => s.path)], { env: LITERAL })
  if (!staged.ok) return { error: stored(T.unread, { error: firstLine(staged) }) }
  const links = new Set(nul(staged.out).flatMap((e) => (e.startsWith('160000 ') ? [e.slice(e.indexOf('\t') + 1)] : [])))
  return { submodules: named.filter((s) => links.has(s.path.replace(/\/+$/, ''))), lfsFiles }
}

// ---- Folders: what a submodule's folder holds now ----

/** A path from .gitmodules or a module's core.worktree as a folder inside `root`, or null: empty, `.`, absolute, `..` or outside. */
export function insidePath(root: string, path: string): string | null {
  const p = path.replace(/[\\/]+$/, '')
  if (!p || p === '.' || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).some((c) => c === '..' || c === '')) return null
  const full = resolve(root, p)
  return strictlyInside(root, full) ? full : null
}

/** Whether any component from below `root` down to `full` (it too) is a symlink or junction, or can't be read as a folder. */
async function linked(root: string, full: string): Promise<boolean | 'missing'> {
  const rel = relative(resolve(root), full)
  let at = resolve(root)
  const parts = rel.split(/[\\/]/)
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i])
    const st = await lstat(at).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : undefined))
    if (st === undefined) return true
    if (st === null) return 'missing'
    if (st.isSymbolicLink()) return true
    if (i < parts.length - 1 && !st.isDirectory()) return true
  }
  return false
}

/** The gitdir a `.git` file names, resolved from its folder; null when `.git` isn't such a file. */
async function gitFileTarget(folder: string): Promise<string | null> {
  const dotGit = join(folder, '.git')
  const st = await lstat(dotGit).catch(() => null)
  if (!st || !st.isFile()) return null
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  return m ? resolve(folder, m[1]) : null
}

/** A module's checkout folder, from its config's core.worktree (resolved from the module's dir); null when it names none. */
async function moduleWorktree(x: Pick<GitFilesExec, 'git'>, moduleDir: string): Promise<string | null> {
  const r = await x.git(moduleDir, ['config', '-f', join(moduleDir, 'config'), '--get', 'core.worktree'])
  const w = r.ok ? r.out.trim() : ''
  return w ? resolve(moduleDir, w) : null
}

/**
 * What a first-level submodule's folder holds now: `init` (missing, or an empty folder: git may make it), `ours` (its
 * `.git` file names exactly this worktree's private clone `<gitDir>/modules/<name>`, whose core.worktree is this folder,
 * all by real paths), or `foreign` (anything else: a repository, files, a link, another clone): never touched.
 */
export async function submoduleFolder(x: Pick<GitFilesExec, 'git'>, root: string, gitDir: string, s: Submodule): Promise<'init' | 'ours' | 'foreign' | 'badPath'> {
  const full = insidePath(root, s.path)
  if (!full) return 'badPath'
  const l = await linked(root, full)
  if (l === 'missing') return 'init'
  if (l) return 'foreign'
  const st = await lstat(full).catch(() => null)
  if (!st) return 'init'
  if (!st.isDirectory()) return 'foreign'
  const names = await readdir(full).catch(() => null)
  if (names === null) return 'foreign'
  if (!names.length) return 'init'
  const target = await gitFileTarget(full)
  if (!target) return 'foreign'
  const module = join(gitDir, 'modules', s.name)
  const [t, m, f] = await Promise.all([real(target), real(module), real(full)])
  if (!t || !m || !f || !same(t, m)) return 'foreign'
  const wt = await moduleWorktree(x, module)
  const w = wt ? await real(wt) : null
  return w && same(w, f) ? 'ours' : 'foreign'
}

// ---- A copy's removed submodules ----

/** Each private module of this worktree (`<gitDir>/modules/…`, a folder with HEAD and config), not those nested in it. */
async function privateModules(gitDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const names = await readdir(dir).catch(() => [] as string[])
    if (names.includes('HEAD') && names.includes('config')) {
      out.push(dir)
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      const st = await lstat(p).catch(() => null)
      if (st?.isDirectory() && !st.isSymbolicLink()) await walk(p, depth + 1)
    }
  }
  await walk(join(gitDir, 'modules'), 0)
  return out
}

/**
 * A copy's folders of submodules its revision no longer has, removed (HI-1182/s13–s16): each private module of this
 * copy's whose core.worktree is a literal path strictly inside the copy, with no link on the way, whose `.git` file names
 * that module back, and where the index has no gitlink now. Removed by git, that path only (`git clean -ffdx` with
 * literal pathspecs); the private clone stays. Anything doubtful is never removed: an error naming it.
 */
export async function removeLeftSubmodules(x: GitFilesExec, folder: string, gitDir: string): Promise<string | null> {
  const mods = await privateModules(gitDir)
  for (const mod of mods) {
    const wt = await moduleWorktree(x, mod)
    if (!wt || !strictlyInside(folder, wt)) continue
    const rel = relative(resolve(folder), wt).split(sep).join('/')
    const full = insidePath(folder, rel)
    if (!full) continue
    const l = await linked(folder, full)
    if (l === 'missing') continue
    const target = await gitFileTarget(full)
    if (l || !target) continue
    const [t, m] = await Promise.all([real(target), real(mod)])
    if (!t || !m || !same(t, m) || !strictlyInside(join(gitDir, 'modules'), m)) continue
    const staged = await x.git(folder, ['ls-files', '-s', '-z', '--', rel], { env: LITERAL })
    if (!staged.ok) return stored(T.removeLeft, { path: rel, error: firstLine(staged) })
    if (nul(staged.out).some((e) => e.startsWith('160000 '))) continue
    // Tracked files there now (a folder at that path in the new revision): not a leftover submodule; left as reset left it.
    if (nul(staged.out).length) continue
    x.note(`Removing the folder of submodule ${rel}, which this revision no longer has (its clone stays).`) // i18n-ignore: the run's log, beside git's own output
    const r = await x.git(folder, ['clean', '-ffdxq', '--', rel], { env: LITERAL, log: true })
    if (!r.ok) return stored(T.removeLeft, { path: rel, error: firstLine(r) })
  }
  return null
}

// ---- git-lfs ----

let lfsVersion: Promise<string | null> | null = null

/** git-lfs's version line (`git lfs version`), read once per Combwork run; null when it can't be run. */
export function gitLfsVersion(x: Pick<GitFilesExec, 'git'>, folder: string): Promise<string | null> {
  lfsVersion ??= x.git(folder, ['lfs', 'version']).then(
    (r) => (r.ok ? r.out.trim().split(/\r?\n/)[0] || null : null),
    () => null
  )
  const p = lfsVersion
  // A failed read is read again next time (git-lfs installed meanwhile).
  void p.then((v) => {
    if (v === null && lfsVersion === p) lfsVersion = null
  })
  return p
}

/** Whether an LFS filter is configured where the folder's git reads its config (`git lfs install`'s filter.lfs.process or smudge). */
async function lfsFilterSet(x: Pick<GitFilesExec, 'git'>, folder: string): Promise<boolean> {
  const r = await x.git(folder, ['config', '--get-regexp', '^filter\\.lfs\\.(process|smudge)$'])
  return r.ok && !!r.out.trim()
}

/** Tests: forget the cached git-lfs version. */
export function forgetGitLfsVersion(): void {
  lfsVersion = null
}

// ---- The step ----

/** The folder made or reset; the project's folder (a relative submodule URL's base without `origin`); `disposable` (a copy or the queue's folder: `--force` updates, removed submodules' folders removed). */
export type GitFilesStep = WorkspaceFilesStep

/**
 * Makes a folder's submodules and LFS files real (HI-1182). Nothing runs when the folder uses neither (and, for a
 * disposable one, has no private module left to remove): `ran` false. Fails, saying why, before anything changes when a
 * submodule's folder isn't missing, empty or its own clone.
 */
export async function prepareGitFiles(x: GitFilesExec, s: GitFilesStep): Promise<GitFilesOutcome> {
  const use = await gitFilesUse(x, s.folder)
  if ('error' in use) return { ok: false, error: use.error }
  const dirR = await x.git(s.folder, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
  if (!dirR.ok) return { ok: false, error: stored(T.unread, { error: firstLine(dirR) }) }
  const gitDir = dirR.out.trim()
  const leftovers = s.disposable ? (await privateModules(gitDir)).length > 0 : false
  if (!use.submodules.length && !use.lfsFiles && !leftovers) return { ok: true, ran: false }
  const stop = (): GitFilesOutcome => ({ ok: false, error: stored(T.stopped) })
  if (s.disposable && leftovers) {
    const left = await removeLeftSubmodules(x, s.folder, gitDir)
    if (left) return { ok: false, error: left }
  }
  if (x.stopped()) return stop()
  if (use.submodules.length) {
    // Every first-level folder looked at before anything changes: one that isn't missing, empty or ours stops it all.
    for (const sub of use.submodules) {
      const what = await submoduleFolder(x, s.folder, gitDir, sub)
      if (what === 'badPath') return { ok: false, error: stored(T.badPath, { name: sub.name, path: sub.path }) }
      if (what === 'foreign') return { ok: false, error: stored(T.foreign, { name: sub.name, path: sub.path }) }
    }
    const set = await x.git(s.folder, ['config', '-z', '--get-regexp', '^submodule\\..*\\.url$'])
    if (!set.ok && set.code !== 1) return { ok: false, error: stored(T.unread, { error: firstLine(set) }) }
    const has = new Set([...configEntries(set.out, /^url$/i).keys()])
    const origin = await x.git(s.folder, ['config', '--get', 'remote.origin.url'])
    const base = origin.ok && origin.out.trim() ? origin.out.trim() : s.project
    const ours: [string, string][] = [['submodule.active', '.']]
    for (const sub of use.submodules) {
      if (has.has(sub.name)) continue
      if (!sub.url) return { ok: false, error: stored(T.noUrl, { name: sub.name }) }
      const url = resolveSubmoduleUrl(sub.url, base)
      if (!url) return { ok: false, error: stored(T.url, { name: sub.name, url: sub.url }) }
      ours.push([`submodule.${sub.name}.url`, url])
    }
    const force = s.disposable ? ['--force'] : []
    const up = await x.git(s.folder, ['submodule', 'update', ...force], { env: { ...NO_PROMPT, ...composeConfigEnv(x.baseEnv(), ours) }, log: true })
    if (x.stopped()) return stop()
    if (!up.ok) return { ok: false, error: stored(T.update, { error: firstLine(up) }) }
    // Nested: only inside this worktree's own clones, checked again now, with the superproject fenced off.
    for (const sub of use.submodules) {
      if (x.stopped()) return stop()
      if ((await submoduleFolder(x, s.folder, gitDir, sub)) !== 'ours') {
        x.note(`Submodule ${sub.path} isn't set up here (inactive, or update=none): its own submodules are left as they are.`) // i18n-ignore: the run's log, beside git's own output
        continue
      }
      const full = insidePath(s.folder, sub.path)!
      const fence = { ...NO_PROMPT, GIT_CEILING_DIRECTORIES: resolve(s.folder) }
      const where = await x.git(full, ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--show-toplevel'], { env: fence })
      const [g, top] = where.ok ? where.out.trim().split(/\r?\n/) : []
      const [rg, rm, rt, rf] = await Promise.all([g ? real(g) : null, real(join(gitDir, 'modules', sub.name)), top ? real(top) : null, real(full)])
      if (!rg || !rm || !rt || !rf || !same(rg, rm) || !same(rt, rf)) {
        x.note(`Submodule ${sub.path} isn't this folder's own clone now: its own submodules are left as they are.`) // i18n-ignore: the run's log, beside git's own output
        continue
      }
      const n = await x.git(full, ['submodule', 'update', '--init', '--recursive', ...force], { env: fence, log: true })
      if (x.stopped()) return stop()
      if (!n.ok) return { ok: false, error: stored(T.nested, { name: sub.name, error: firstLine(n) }) }
    }
  }
  if (use.lfsFiles) {
    if (!(await gitLfsVersion(x, s.folder))) return { ok: false, error: stored(T.noLfs) }
    // With no LFS filter configured, `git lfs pull` fetches but leaves the pointers ("Skipping object checkout"), and exits 0.
    if (!(await lfsFilterSet(x, s.folder))) return { ok: false, error: stored(T.noLfsFilter) }
    if (x.stopped()) return stop()
    const pull = await x.git(s.folder, ['lfs', 'pull'], { env: { ...NO_PROMPT }, log: true })
    if (x.stopped()) return stop()
    if (!pull.ok) return { ok: false, error: stored(T.lfs, { error: firstLine(pull) }) }
  }
  return { ok: true, ran: true }
}

/** Reads through Combwork's own git (its worker, bounded as its reads are): for the checks made before a run is started. */
export const gitReads: Pick<GitFilesExec, 'git'> = {
  git: async (cwd, args, o) => {
    const r = await git(cwd, args, undefined, undefined, o?.env ? { env: { ...process.env, ...o.env } } : {})
    return { ok: r.ok, code: r.code < 0 ? null : r.code, out: r.out, err: r.err }
  }
}

/**
 * Whether a folder needs the step (read before any run is started, so a folder that uses neither shows no run): it
 * uses submodules or LFS at its revision, or (a disposable one) it holds a private module a removed submodule may
 * have left. `error`: git couldn't say, never taken for "no".
 */
export async function gitFilesNeeded(x: Pick<GitFilesExec, 'git'>, folder: string, disposable: boolean): Promise<boolean | { error: string }> {
  const use = await gitFilesUse(x, folder)
  if ('error' in use) return use
  if (use.submodules.length || use.lfsFiles) return true
  if (!disposable) return false
  const gitDir = await gitFileTarget(folder)
  return gitDir ? (await privateModules(gitDir)).length > 0 : false
}

/** The project folder's status for the tab; null when git couldn't say. */
export async function gitFilesStatus(x: Pick<GitFilesExec, 'git'>, folder: string): Promise<GitFilesStatus | null> {
  const use = await gitFilesUse(x, folder)
  if ('error' in use) return null
  const lfs = use.lfsFiles > 0
  return { submodules: use.submodules.length, lfs, lfsVersion: lfs ? await gitLfsVersion(x, folder) : null, lfsFilter: lfs ? await lfsFilterSet(x, folder) : false }
}
