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

import { lstat, readdir, readFile, realpath, rm as removeTree } from 'original-fs/promises'
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
  clearStray: agentMsg({ id: 'gitFiles.error.clearStray', text: "submodule {name}: the files left in {path} couldn't be removed: {error}", note: "A copy's setup error (HI-3080): a submodule's folder held only files an earlier run left (ignored build output, say), and Combwork couldn't remove them before setting the submodule up. {name} is the submodule's name, {path} its folder, {error} the system's words." }),
  removeLeft: agentMsg({ id: 'gitFiles.error.removeLeft', text: "the folder of removed submodule {path} couldn't be removed: {error}", note: "A copy's setup error (HI-1182): a submodule the revision no longer has left its folder, and Combwork couldn't remove it. {path} is the folder, {error} git's first line or why." }),
  doubtfulLeft: agentMsg({ id: 'gitFiles.error.doubtfulLeft', text: "the folder of removed submodule {path} isn't plainly this copy's own clone (a link, or another repository), so it was left as it is: move it away", note: "A copy's setup error (HI-1182): a submodule its revision no longer has left a folder that Combwork can't be sure it cloned itself, so it removes nothing and the copy isn't handed over. {path} is the folder." }),
  workUnread: agentMsg({ id: 'gitFiles.remove.unread', text: "couldn't check submodule {path} before removing the worktree: {error}", note: "Why a slot with submodules wasn't removed (HI-3026): a read of its submodules' clones failed, so nothing was removed. {path} is the clone's folder under the worktree's git dir, {error} git's first line or why." }),
  workOdd: agentMsg({ id: 'gitFiles.remove.odd', text: "couldn't check submodule {path} before removing the worktree: it isn't a clone Combwork can read (a link, a stray file, an incomplete clone, or nested too deep)", note: "Why a slot with submodules wasn't removed (HI-3026): something under the worktree's git dir where submodule clones are kept isn't one Combwork can check, so nothing was removed. {path} is that folder under the worktree's git dir (.git: the worktree names no git dir)." }),
  workChanged: agentMsg({ id: 'gitFiles.remove.changed', text: 'the worktree has changes or untracked files, inside its submodules too: {path}', note: "Why a slot with submodules wasn't removed (HI-3026): git's own clean check (its submodules counted) lists something. {path} is the first entry git lists." }),
  workUnpushed: agentMsg({ id: 'gitFiles.remove.unpushed', text: "submodule {path} has commits that aren't on its remote (a branch, tag or stash there, or a commit fetched by its id), which removing the worktree would delete", note: "Why a slot with submodules wasn't removed (HI-3026): a submodule clone only this worktree has holds commits no remote-tracking ref has. {path} is the clone's folder under the worktree's git dir." }),
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
  // The clone itself owned too (HR2's HI-1182 round 1): inside this worktree's modules folder, no link on the way.
  const m = await ownedModule(gitDir, join(gitDir, 'modules', s.name))
  const [t, f] = await Promise.all([real(target), real(full)])
  if (!t || !m || !f || !same(t, m)) return 'foreign'
  const wt = await moduleWorktree(x, m)
  const w = wt ? await real(wt) : null
  return w && same(w, f) ? 'ours' : 'foreign'
}

/**
 * A private module's folder as this worktree owns it (HI-1182): a folder strictly inside `<gitDir>/modules`, by its path
 * and its real path, with no symlink or junction from that folder (it too) down to it; its real path, else null.
 */
async function ownedModule(gitDir: string, module: string): Promise<string | null> {
  const root = join(gitDir, 'modules')
  const rootSt = await lstat(root).catch(() => null)
  if (!rootSt || rootSt.isSymbolicLink() || !rootSt.isDirectory()) return null
  if (!strictlyInside(root, module) || (await linked(root, module)) !== false) return null
  const st = await lstat(module).catch(() => null)
  if (!st || !st.isDirectory()) return null
  const [r, m] = await Promise.all([real(root), real(module)])
  return r && m && strictlyInside(r, m) ? m : null
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
    const owned = await ownedModule(gitDir, mod)
    if (!owned) continue
    const wt = await moduleWorktree(x, owned)
    // A clone naming no checkout in this copy (none, or outside it): nothing of this copy's to remove.
    if (!wt || !strictlyInside(folder, wt)) continue
    const rel = relative(resolve(folder), wt).split(sep).join('/')
    const full = insidePath(folder, rel)
    if (!full) continue
    const l = await linked(folder, full)
    // Gone already (removed by an earlier run, or never checked out): nothing left.
    if (l === 'missing') continue
    const staged = await x.git(folder, ['ls-files', '-s', '-z', '--', rel], { env: LITERAL })
    if (!staged.ok) return stored(T.removeLeft, { path: rel, error: firstLine(staged) })
    // The revision has something at that path (a gitlink again, or tracked files): not a leftover; left as reset left it.
    if (nul(staged.out).length) continue
    // A leftover that isn't plainly this copy's own clone (a link on the way, no gitdir file, another repository): left
    // untouched, and the copy isn't handed over with it (HR2's HI-1182 round 1).
    const target = l ? null : await gitFileTarget(full)
    const t = target ? await real(target) : null
    if (!t || !same(t, owned)) return stored(T.doubtfulLeft, { path: rel })
    x.note(`Removing the folder of submodule ${rel}, which this revision no longer has (its clone stays).`) // i18n-ignore: the run's log, beside git's own output
    const r = await x.git(folder, ['clean', '-ffdxq', '--', rel], { env: LITERAL, log: true })
    if (!r.ok) return stored(T.removeLeft, { path: rel, error: firstLine(r) })
  }
  return null
}

/**
 * HI-3027: the merge queue's folder, just before it is checked out at a revision and merges another: each submodule
 * checkout of its own that one of `revisions` doesn't keep as a submodule (vendored into ordinary files there, or gone)
 * removed, folder and all. git's checkout and merge leave a populated submodule's folder where it is, so its files stand
 * "untracked" where the revision tracks files of its own, and the merge refuses on every pass. Only this folder's own
 * clones' checkouts, as removeLeftSubmodules decides them (a private module whose core.worktree is a literal path
 * strictly inside, no link on the way, whose `.git` file names it back); the clone stays, for the files step to use
 * again. Anything doubtful is left as it is, for git to name. A read git couldn't make, or a removal that failed: its
 * words (nothing else removed after it). HI-3078: `keepChanged` (a slot, someone's work folder) leaves a checkout whose
 * own status lists anything (a change or an untracked file, in a nested submodule too) for git to name, removing only a
 * clean one (its ignored files with it, as `git submodule deinit` does); its commits stay in the clone either way.
 */
export async function clearSubmoduleCheckouts(x: Pick<GitFilesExec, 'git'>, folder: string, revisions: string[], o?: { keepChanged?: boolean }): Promise<string | null> {
  const dirR = await x.git(folder, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
  if (!dirR.ok) return firstLine(dirR)
  const gitDir = dirR.out.trim()
  for (const mod of await privateModules(gitDir)) {
    const owned = await ownedModule(gitDir, mod)
    if (!owned) continue
    const wt = await moduleWorktree(x, owned)
    if (!wt || !strictlyInside(folder, wt)) continue
    const rel = relative(resolve(folder), wt).split(sep).join('/')
    const full = insidePath(folder, rel)
    // Not there (never checked out, or removed already), or a link on the way: nothing of ours to remove.
    if (!full || (await linked(folder, full)) !== false) continue
    const target = await gitFileTarget(full)
    const t = target ? await real(target) : null
    if (!t || !same(t, owned)) continue
    let kept = true
    for (const rev of revisions) {
      const at = await x.git(folder, ['ls-tree', '-z', rev, '--', rel], { env: LITERAL })
      if (!at.ok) return firstLine(at)
      if (!nul(at.out).some((e) => e.startsWith('160000 ') && e.slice(e.indexOf('\t') + 1) === rel)) kept = false
    }
    if (kept) continue
    if (o?.keepChanged) {
      const st = await x.git(full, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'])
      if (!st.ok) return firstLine(st)
      if (st.out.replace(/\0/g, '').trim()) continue
    }
    const err = await removeTree(full, { recursive: true, force: true }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    )
    if (err) return stored(T.removeLeft, { path: rel, error: err })
  }
  return null
}

/** Past this many entries, or this depth, a folder is never taken for leftovers (clearStrayFolder). */
const STRAY_MAX_ENTRIES = 200_000
const STRAY_MAX_DEPTH = 64
/** Names a git dir has beside HEAD (lower case): any of them with a HEAD makes a folder a repository, bare or not. */
const GIT_DIR_PARTS = new Set(['config', 'objects', 'refs', 'packed-refs', 'commondir', 'gitdir', 'index'])

/**
 * HI-3080: a disposable folder's submodule path that holds only files an earlier run left (a revision had ordinary files
 * there, and a build's ignored output stayed after the reset's `clean -fd`), emptied so the submodule can be set up. git's
 * own clean skips a path the index holds as a gitlink, so it is removed here, but only when nothing in it is a repository
 * or a link: no `.git` at any depth, no folder that is a bare one (HEAD beside config, objects, refs…), no symlink or
 * junction on the way or inside, within the bounds above. Anything
 * else is left as it is (the step then names it foreign). Null: emptied, or left; else the system's words.
 */
async function clearStrayFolder(x: Pick<GitFilesExec, 'note'>, root: string, s: Submodule): Promise<string | null> {
  const full = insidePath(root, s.path)
  if (!full || (await linked(root, full)) !== false) return null
  let seen = 0
  const plain = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > STRAY_MAX_DEPTH) return false
    const names = await readdir(dir).catch(() => null)
    if (!names) return false
    // A bare repository (HR1's round 1) has no `.git`: its HEAD beside any other part of a git dir counts as one.
    const lower = names.map((n) => n.toLowerCase())
    if (lower.includes('head') && lower.some((n) => n !== 'head' && GIT_DIR_PARTS.has(n))) return false
    for (const n of names) {
      if (++seen > STRAY_MAX_ENTRIES || n.toLowerCase() === '.git') return false
      const st = await lstat(join(dir, n)).catch(() => null)
      if (!st || st.isSymbolicLink()) return false
      if (st.isDirectory() && !(await plain(join(dir, n), depth + 1))) return false
    }
    return true
  }
  const st = await lstat(full).catch(() => null)
  if (!st?.isDirectory() || !(await plain(full, 0))) return null
  x.note(`Removing what earlier runs left in ${s.path}, where the submodule ${s.name} now belongs.`) // i18n-ignore: the run's log, beside git's own output
  return removeTree(full, { recursive: true, force: true }).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  )
}

// ---- A worktree with submodule clones, removed (HI-3026) ----

/**
 * Whether a worktree's own git dir holds submodule clones (`<gitdir>/modules`), which git won't move and won't remove
 * unforced. Null: its `.git` file names no git dir. Anything there but unreadable counts as holding them.
 */
export async function hasPrivateModules(folder: string): Promise<boolean | null> {
  const gitDir = await gitFileTarget(folder)
  if (!gitDir) return null
  return lstat(join(gitDir, 'modules')).then(
    () => true,
    (e: NodeJS.ErrnoException) => e.code !== 'ENOENT'
  )
}

/** Names a clone's metadata has: one with some but not both of HEAD and config is a broken clone, never a folder of clones. */
const CLONE_PARTS = ['HEAD', 'config', 'objects', 'refs', 'packed-refs']

/**
 * Every submodule clone under `<gitDir>/modules`, nested ones (each clone's own `modules`) too, failing closed: a folder
 * that can't be read, a link on the way, a file where only folders of clones belong, a clone missing HEAD or config, or
 * a depth past the bound is a failure naming it (with the system's error when it gave one), never skipped. A `modules`
 * that isn't there holds none.
 */
async function everyClone(gitDir: string): Promise<{ clones: { dir: string; rel: string }[] } | { error?: string; path: string }> {
  const top = join(gitDir, 'modules')
  const clones: { dir: string; rel: string }[] = []
  const relOf = (p: string): string => relative(top, p).split(sep).join('/') || 'modules'
  const walk = async (dir: string, depth: number, optional: boolean): Promise<{ error?: string; path: string } | null> => {
    if (depth > 32) return { path: relOf(dir) }
    const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : e))
    if (st === null) return optional ? null : { path: relOf(dir) }
    if (st instanceof Error) return { error: st.message, path: relOf(dir) }
    if (st.isSymbolicLink() || !st.isDirectory()) return { path: relOf(dir) }
    const names = await readdir(dir).catch((e: Error) => e)
    if (names instanceof Error) return { error: names.message, path: relOf(dir) }
    if (names.includes('HEAD') && names.includes('config')) {
      clones.push({ dir, rel: relOf(dir) })
      return walk(join(dir, 'modules'), depth + 1, true)
    }
    if (names.some((n) => CLONE_PARTS.includes(n))) return { path: relOf(dir) }
    for (const n of names) {
      const r = await walk(join(dir, n), depth + 1, false)
      if (r) return r
    }
    return null
  }
  const failed = await walk(top, 0, true)
  return failed ?? { clones }
}

/**
 * HI-3026: why a worktree holding submodule clones can't be removed by force without losing anything, else null. git
 * refuses any unforced removal of one; forced, it skips its own clean check and deletes the clones with it. So first:
 * git's clean check as it would make it (`status --porcelain --ignore-submodules=none`, empty), and every clone, nested
 * too, holding no commit that a remote-tracking ref there lacks (`rev-list --all --not --remotes`: branches, tags, a
 * stash, HEAD, any ref), the tags a remote has too taken for the remote's (HI-3077: keptPastRemoteTags). A commit
 * fetched by its id alone counts as not on the remote: kept, conservatively. A read that failed keeps it too. The reason
 * is stored, in the Default dialect.
 */
export async function submoduleWorkKept(x: Pick<GitFilesExec, 'git'>, folder: string): Promise<string | null> {
  const gitDir = await gitFileTarget(folder)
  if (!gitDir) return stored(T.workOdd, { path: '.git' })
  const st = await x.git(folder, ['status', '--porcelain', '-z', '--ignore-submodules=none'])
  if (!st.ok) return stored(T.workUnread, { path: '.', error: firstLine(st) })
  const first = nul(st.out)[0]
  if (first) return stored(T.workChanged, { path: first.slice(3) })
  const all = await everyClone(gitDir)
  if (!('clones' in all)) return all.error ? stored(T.workUnread, { path: all.path, error: all.error }) : stored(T.workOdd, { path: all.path })
  for (const c of all.clones) {
    const r = await x.git(c.dir, [...cloneOnly(c.dir), 'rev-list', '-n1', '--all', '--not', '--remotes'])
    if (!r.ok) return stored(T.workUnread, { path: c.rel, error: firstLine(r) })
    if (!r.out.trim()) continue
    const kept = await keptPastRemoteTags(x, c.dir)
    if ('error' in kept) return stored(T.workUnread, { path: c.rel, error: kept.error })
    if (kept.kept) return stored(T.workUnpushed, { path: c.rel })
  }
  return null
}

/** Past this much of a command line for the tags no remote has, a clone is kept unchecked (Windows' limit is 32K). */
const LOCAL_TAGS_BUDGET = 16_000

/**
 * HI-3077: a clone whose commits its remote-tracking branches lack, read again with its remotes' tags (`ls-remote
 * --tags --refs`, no prompt): a tag a remote has under the same name, at the same object, is the remote's (fetched
 * with the clone, say a release tag whose branch was deleted), so what it reaches is on the remote; a tag no remote
 * has (or has elsewhere) is local work, as is any other ref. `kept`: something only this clone has. A remote that
 * can't be read is an error, never taken for "nothing there"; so many local tags they can't be named keeps it.
 */
async function keptPastRemoteTags(x: Pick<GitFilesExec, 'git'>, dir: string): Promise<{ kept: boolean } | { error: string }> {
  const gd = cloneOnly(dir)
  const tagsR = await x.git(dir, [...gd, 'for-each-ref', '--format=%(objectname) %(refname:strip=2)', 'refs/tags'])
  if (!tagsR.ok) return { error: firstLine(tagsR) }
  const tags = lines(tagsR.out)
  if (!tags.length) return { kept: true }
  const remotesR = await x.git(dir, [...gd, 'remote'])
  if (!remotesR.ok) return { error: firstLine(remotesR) }
  const theirs = new Set<string>()
  for (const remote of lines(remotesR.out)) {
    const ls = await x.git(dir, [...gd, 'ls-remote', '--tags', '--refs', remote], { env: { ...NO_PROMPT } })
    if (!ls.ok) return { error: firstLine(ls) }
    for (const l of lines(ls.out)) {
      const m = /^([0-9a-f]+)\trefs\/tags\/(.+)$/.exec(l)
      if (m) theirs.add(`${m[1]} ${m[2]}`)
    }
  }
  const mine = tags.filter((t) => !theirs.has(t))
  if (mine.length === tags.length) return { kept: true }
  // Every ref but the tags, and the tags no remote has, less what the remote-tracking branches and the remotes' tags reach.
  const minePos = mine.map((t) => t.slice(0, t.indexOf(' ')))
  const mineExcl = mine.map((t) => `--exclude=${t.slice(t.indexOf(' ') + 1)}`)
  if ([...minePos, ...mineExcl].reduce((n, a) => n + a.length + 1, 0) > LOCAL_TAGS_BUDGET) return { kept: true }
  const r = await x.git(dir, [...gd, 'rev-list', '-n1', '--exclude=refs/tags/*', '--all', ...minePos, '--not', '--remotes', ...mineExcl, '--tags'])
  if (!r.ok) return { error: firstLine(r) }
  return { kept: !!r.out.trim() }
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.trim())

/**
 * A clone's refs read by itself: its git dir, and that same folder for its work tree, so the clone's core.worktree (its
 * checkout, which a revision without the submodule no longer has: HI-3078) is never entered.
 */
const cloneOnly = (dir: string): string[] => [`--git-dir=${dir}`, `--work-tree=${dir}`]

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
      let what = await submoduleFolder(x, s.folder, gitDir, sub)
      if (what === 'foreign' && s.disposable) {
        const cleared = await clearStrayFolder(x, s.folder, sub)
        if (cleared) return { ok: false, error: stored(T.clearStray, { name: sub.name, path: sub.path, error: cleared }) }
        what = await submoduleFolder(x, s.folder, gitDir, sub)
      }
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
      const [rg, rm, rt, rf] = await Promise.all([g ? real(g) : null, ownedModule(gitDir, join(gitDir, 'modules', sub.name)), top ? real(top) : null, real(full)])
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
