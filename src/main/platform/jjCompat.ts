// The compatibility assessment before a switch to jj (HI-2799, J6; SPEC §16.3.6's gates, J0's detection rules): what a
// repository uses that jj doesn't support, read from what Git and jj would actually apply, never one source of it: Git's
// effective config at every level and include (`git config --list --show-origin --show-scope --includes`, run in the
// repository), every attribute source Git applies (the system's, the global one, every tracked `.gitattributes` and, in a
// colocated working tree, every untracked one Git sees (HI-2978), and any on disk in a folder holding a tracked file, ignored or not, the store's
// `info/attributes`), jj's effective config (`jj config list`), and the repository's files. Anything it can't
// read, list or resolve is "uses it" (unknown): the gate stays closed. Read-only: never a write, a snapshot or an import.
// Git for Windows' stock system settings, as its installer writes them, aren't a use (HI-2872): only those values, at
// system scope, from its own etc files. A non-colocated repository (HI-2896) has no Git working copy, so nothing runs git
// in its folder (where git would find no repository, or one above it): Git's config and vars are asked of its store
// (`--git-dir`), and its tracked files are the single head's working-copy commit's tree in the store (`ls-tree`), plus
// the root's own .gitattributes on disk that jj hasn't recorded yet.

import { join, resolve, isAbsolute } from 'path'
import { GIT_MINGW_DIRS } from '../../shared/gitLayout'
import { readdir, readFile, stat } from 'original-fs/promises'
import type { Gate } from '../../shared/platform/descriptors'
import type { RunResult } from './repoContext'
import { git } from '../git'
import { jjRunner, storeGitGated, type JjRunner } from './jjRunner'
import { readOpHeads } from './jjView'

/** The gates a repository's own use decides (the rest are jj's own limits, closed whatever the repository uses). */
export type RepoGate = Extract<Gate, 'attributes' | 'lfs' | 'submodules' | 'hooks' | 'signing'>
export const REPO_GATES: readonly RepoGate[] = ['attributes', 'lfs', 'submodules', 'hooks', 'signing']

/**
 * A gate's finding: clear, what uses it (a key, a file, an attribute line; at most a few), or what couldn't be read.
 * `autocrlf`: attributes' uses include Git's line-ending conversion (core.autocrlf on), which the dialog says how to turn
 * off for the repository (HI-2872).
 */
export type GateFinding = { clear: true } | { uses: string[]; autocrlf?: true } | { unknown: string }
export type Assessment = Record<RepoGate, GateFinding>

/** What the assessment runs: git and jj in the repository (injected in tests). */
export interface CompatDeps {
  git: (cwd: string, args: string[]) => Promise<Pick<RunResult, 'ok' | 'out' | 'err'>>
  jj: JjRunner
}

// Its git reads of a jj store under Combwork's file gate for it (HI-2918).
const DEFAULTS: CompatDeps = { git: (cwd, args) => storeGitGated(cwd, args, () => git(cwd, args)), jj: jjRunner }

/** At most this many tracked .gitattributes files are read; more is unknown (fail closed). */
export const ATTR_FILES_MAX = 2000
/** At most this many folders holding tracked files are looked in for an untracked `.gitattributes`; more is unknown. */
export const ATTR_DIRS_MAX = 100_000
/** At most this much of one attribute file is read; larger is unknown. */
export const ATTR_FILE_MAX = 1024 * 1024
/**
 * The attributes jj doesn't apply (v0.47.1's Git compatibility page): any mention of one, set or unset, uses it. `crlf`
 * (HI-2978) is `text`'s legacy spelling, which Git still converts by when `text` isn't set (`crlf`, `-crlf`, `crlf=input`).
 */
const ATTRS = ['text', 'eol', 'crlf', 'filter', 'diff', 'merge', 'working-tree-encoding', 'ident']

interface ConfigEntry {
  scope: string
  origin: string
  key: string
  value: string | null
}

/** Parses `git config --list --show-origin --show-scope -z`: scope NUL origin NUL key[LF value] NUL…; null if malformed. */
export function parseConfig(out: string): ConfigEntry[] | null {
  const parts = out.split('\0')
  if (parts[parts.length - 1] === '') parts.pop()
  if (parts.length % 3) return null
  const out2: ConfigEntry[] = []
  for (let i = 0; i < parts.length; i += 3) {
    const kv = parts[i + 2]
    const nl = kv.indexOf('\n')
    out2.push({ scope: parts[i], origin: parts[i + 1], key: (nl < 0 ? kv : kv.slice(0, nl)).toLowerCase(), value: nl < 0 ? null : kv.slice(nl + 1) })
  }
  return out2
}

/** The largest int git's config reads (git_parse_int's bound). */
const INT_MAX = 2n ** 31n - 1n

/**
 * A Git boolean as git_config_bool reads it (HI-2942): no value, `true`, `yes`, `on` (any case) true; empty, `false`,
 * `no`, `off` false; else an int as git_parse_int reads it (strtoimax in base 0: decimal, `0x` hex or `0` octal, leading
 * whitespace and a sign allowed, then an optional k, m or g unit, within an int), true unless 0. Null for anything Git
 * refuses ("bad boolean config value": what reads it fails).
 */
export function gitBool(v: string | null): boolean | null {
  if (v === null) return true
  if (v === '') return false
  if (/^(true|yes|on)$/i.test(v)) return true
  if (/^(false|no|off)$/i.test(v)) return false
  const m = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)$/.exec(v)
  if (!m) return null
  const digits = m[2]
  const n = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits[0] === '0' ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits)
  const factor = { '': 1n, k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n }[m[3].toLowerCase() as '' | 'k' | 'm' | 'g']
  // An int's range, as git_parse_signed checks it: down to -INT_MAX - 1.
  if (n * factor > INT_MAX + (m[1] === '-' ? 1n : 0n)) return null
  return n !== 0n
}
/** A Git boolean that is false (`false`, `no`, `off`, `0`, an empty value). */
const gitFalse = (v: string | null): boolean => v !== null && /^(false|no|off|0|)$/i.test(v.trim())

/**
 * Git for Windows' stock system settings (HI-2872, Darren's (b) on HI-2799): the values its installer writes to its own
 * `etc/gitconfig`, which a plain install always has and nothing applies unless the repository asks (an LFS filter no
 * attribute names, a diff driver for Office files). An entry is stock only at system scope, from that file (Git's
 * `--show-origin`), with exactly this value; the same key anywhere else, or another value, still counts.
 */
export const GFW_STOCK_CONFIG: Readonly<Record<string, string>> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process', // i18n-ignore: a Git config value, compared, never shown
  'filter.lfs.required': 'true',
  'diff.astextplain.textconv': 'astextplain',
}
/** Git for Windows' stock `etc/gitattributes`: `*.<ext> diff=astextplain` for these, lower- and upper-case. */
const GFW_STOCK_ATTR_EXTS = ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'pdf', 'rtf', 'ods', 'odf', 'odt']
const GFW_STOCK_ATTR_LINES = new Set(GFW_STOCK_ATTR_EXTS.flatMap((e) => [e, e.toUpperCase()]).map((e) => `*.${e} diff=astextplain`))
/** Whether an attribute line (trimmed) is one of Git for Windows' stock `etc/gitattributes` lines. */
export const gfwStockAttrLine = (line: string): boolean => GFW_STOCK_ATTR_LINES.has(line.split(/\s+/).join(' '))

/** A path as Windows compares it. */
const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * Git for Windows' own system files, from where the git that runs here says it lives (`--exec-path`:
 * `<install>/<mingw64|ucrt64|…>/libexec/git-core`): `<install>/etc/gitconfig` and `etc/gitattributes`. Null for another
 * layout (not Git for Windows) or when git can't say: then nothing is stock.
 */
export async function gfwSystemFiles(root: string, deps: Pick<CompatDeps, 'git'>): Promise<{ config: string; attributes: string } | null> {
  const r = await deps.git(root, ['--exec-path'])
  if (!r.ok || !r.out.trim()) return null
  const at = resolve(r.out.trim())
  const [m, libexec, core] = at.split(/[\\/]/).slice(-3).map((p) => p.toLowerCase())
  if (!(GIT_MINGW_DIRS as readonly string[]).includes(m) || libexec !== 'libexec' || core !== 'git-core') return null
  const install = resolve(at, '..', '..', '..')
  return { config: join(install, 'etc', 'gitconfig'), attributes: join(install, 'etc', 'gitattributes') }
}

/**
 * Each attribute line of a file naming an attribute jj doesn't apply, as `<file>: <line>` (at most 3), and lfs's; a line
 * `skip` takes (a stock one) is neither.
 */
export function attributeUses(text: string, file: string, skip?: (line: string) => boolean): { uses: string[]; lfs: string[] } {
  const uses: string[] = []
  const lfs: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || skip?.(line)) continue
    const tokens = line.split(/\s+/).slice(1)
    const names = tokens.map((t) => t.replace(/^[-!]/, '').split('=')[0])
    if (tokens.some((t) => /^filter=lfs$/i.test(t))) lfs.push(`${file}: ${line}`.slice(0, 300))
    if (names.some((n) => ATTRS.includes(n)) || names.includes('binary')) uses.push(`${file}: ${line}`.slice(0, 300))
  }
  return { uses, lfs }
}

const add = (a: Assessment, g: RepoGate, what: string): void => {
  const f = a[g]
  if ('unknown' in f) return
  const list = 'uses' in f ? f.uses : []
  if (list.length < 5 && !list.includes(what)) list.push(what)
  a[g] = { uses: list }
}
const unknownAt = (a: Assessment, g: RepoGate, what: string): void => {
  a[g] = { unknown: what.slice(0, 300) }
}

/** Every folder (relative, `/`-separated, the root's left out) holding a tracked path, each once. */
export function trackedDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const p of paths) {
    for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
      const d = p.slice(0, i)
      if (dirs.has(d)) break
      dirs.add(d)
    }
  }
  return [...dirs]
}

/** A file's text, bounded: null when absent; 'unreadable' when it can't be read or is larger than the bound. */
async function bounded(p: string): Promise<string | null | 'unreadable'> {
  const st = await stat(p).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : 'unreadable' as const))
  if (st === null) return null
  if (st === 'unreadable' || !st.isFile() || st.size > ATTR_FILE_MAX) return 'unreadable'
  return readFile(p, 'utf8').catch(() => 'unreadable' as const)
}

/** Git's hooks, by the names Git runs (githooks(5)): a file of another name in a hooks folder is never run. */
const HOOKS = new Set(['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'])

/**
 * The hooks a folder holds: each file named as a Git hook (with or without an extension Windows runs), never a sample
 * (`*.sample`) or another file (jj's own `docs.url` beside them); null when it can't be listed (absent holds none).
 */
async function hooksIn(dir: string): Promise<string[] | null> {
  const ents = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? [] : null))
  if (!ents) return null
  return ents.filter((e) => !e.isDirectory() && !e.name.endsWith('.sample') && HOOKS.has(e.name.toLowerCase().replace(/\.(exe|bat|cmd|ps1|sh)$/, ''))).map((e) => e.name)
}

/**
 * A non-colocated repository's tracked files (HI-2896), as `git ls-files -s` would list them were there a Git working copy:
 * the tree of the workspace's working-copy commit at the single operation head (read pinned, never snapshotting), listed
 * from the store (`ls-tree -r -z --full-tree`: `<mode> <type> <object>\t<path>`, whose mode and tab the callers read).
 */
async function trackedTree(root: string, jjRepo: string, deps: CompatDeps): Promise<Pick<RunResult, 'ok' | 'out' | 'err'>> {
  const heads = readOpHeads(jjRepo)
  if (!heads || heads.length !== 1) return { ok: false, out: '', err: `jj operation heads: ${heads ? heads.length : 'unreadable'}` } // i18n-ignore: what was found, shown as data beside its message
  const c = await deps.jj.run(root, ['--ignore-working-copy', '--at-op', heads[0], 'log', '--no-graph', '-r', '@', '-T', 'commit_id'])
  const commit = c.ok ? c.out.trim() : ''
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, out: '', err: `jj log @: ${c.err || c.out}`.slice(0, 300) } // i18n-ignore: what was found, shown as data beside its message
  return deps.git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])
}

/**
 * Assesses the repository at `root` (its working tree's top) with Git store `store`: each repository gate clear, used
 * (with what uses it) or unknown. A switch to jj is refused unless every one is clear.
 */
export async function assessJj(root: string, store: string, deps0: CompatDeps = DEFAULTS, o: { separate?: { jjRepo: string } } = {}): Promise<Assessment> {
  const a: Assessment = { attributes: { clear: true }, lfs: { clear: true }, submodules: { clear: true }, hooks: { clear: true }, signing: { clear: true } }
  // Not colocated (HI-2896): every git command asks the store, never the folder.
  const deps: CompatDeps = o.separate ? { ...deps0, git: (cwd, args) => deps0.git(cwd, ['--git-dir', store, ...args]) } : deps0
  // Git's effective config, every level and include, as Git reads it here.
  const cfg = await deps.git(root, ['config', '--list', '--show-origin', '--show-scope', '--includes', '-z'])
  const entries = cfg.ok ? parseConfig(cfg.out) : null
  if (!entries) for (const g of REPO_GATES) unknownAt(a, g, `git config: ${cfg.err || 'unreadable'}`) // i18n-ignore: what was found, shown as data beside its message
  let hooksPath: string | null = null
  let autocrlf: { at: string; value: string | null } | null = null
  let attributesFile: string | null = null
  // Git for Windows' stock system settings aren't a use (HI-2872): a key at system scope from its own etc/gitconfig with
  // exactly the value it ships. Its stock attribute lines are ignored only while their diff driver is stock too.
  const gfw = entries ? await gfwSystemFiles(root, deps) : null
  const stock = (e: ConfigEntry): boolean => !!gfw && e.scope === 'system' && e.origin.startsWith('file:') && samePath(e.origin.slice(5), gfw.config) && e.value === GFW_STOCK_CONFIG[e.key]
  let astextplainStock = true
  for (const e of entries ?? []) {
    if (stock(e)) continue
    if (e.key.startsWith('diff.astextplain.')) astextplainStock = false
    const at = `${e.key} (${e.scope})`
    // core.autocrlf as Git applies it: its last value, a later level's winning. False converts nothing, as jj does.
    if (e.key === 'core.autocrlf') autocrlf = { at, value: e.value }
    // Any filter.lfs.* key not stock is LFS's (HR3 on HI-2872: required too); another filter's driver keys are attributes'.
    else if (e.key.startsWith('filter.lfs.')) add(a, 'lfs', at)
    else if (e.key === 'core.eol' || /^filter\.[^.]+\.(clean|smudge|process|required)$/.test(e.key)) add(a, 'attributes', at)
    if (e.key.startsWith('lfs.')) add(a, 'lfs', at)
    if (e.key.startsWith('submodule.')) add(a, 'submodules', at)
    // Signing on at any level, as Git reads the value (HI-2942: any nonzero int too); a value Git refuses fails closed.
    if (e.key === 'commit.gpgsign' || e.key === 'tag.gpgsign') {
      const on = gitBool(e.value)
      // A refused value is named with its value (data, as core.autocrlf's is: no words of Combwork's, HR1's round 1).
      if (on !== false) add(a, 'signing', on === null ? `${at} = ${e.value}` : at) // i18n-ignore: what was found, shown as data beside its message
    }
    if (e.key === 'core.hookspath') hooksPath = e.value
    if (e.key === 'core.attributesfile') attributesFile = e.value
  }
  const autocrlfOn = !!autocrlf && !gitFalse(autocrlf.value)
  if (autocrlf && autocrlfOn) add(a, 'attributes', `${autocrlf.at} = ${autocrlf.value ?? 'true'}`) // i18n-ignore: what was found, shown as data beside its message
  // Attribute sources: the system's and the global one as Git names them, every tracked .gitattributes, info/attributes.
  const sources: string[] = []
  let systemAttributes: string | null = null
  for (const v of ['GIT_ATTR_SYSTEM', 'GIT_ATTR_GLOBAL']) {
    const r = await deps.git(root, ['var', v])
    if (r.ok && r.out.trim()) {
      sources.push(resolve(r.out.trim()))
      if (v === 'GIT_ATTR_SYSTEM') systemAttributes = resolve(r.out.trim())
    }
    // No such source (GIT_ATTR_NOSYSTEM, no global file): git var exits 1 saying nothing. Anything it says is unknown.
    else if (!r.ok && r.err.trim() && !/not a valid|unknown variable/i.test(r.err)) unknownAt(a, 'attributes', `git var ${v}: ${r.err}`) // i18n-ignore: what was found, shown as data beside its message
  }
  if (attributesFile) sources.push(isAbsolute(attributesFile) ? attributesFile : resolve(root, attributesFile))
  sources.push(join(store, 'info', 'attributes'))
  const listed = o.separate ? await trackedTree(root, o.separate.jjRepo, deps) : await deps.git(root, ['ls-files', '-z', '-s'])
  if (!listed.ok) {
    unknownAt(a, 'attributes', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
    unknownAt(a, 'submodules', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
    unknownAt(a, 'lfs', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
  } else {
    const rows = listed.out.split('\0').filter(Boolean)
    const attrFiles = rows.map((r) => r.split('\t')).filter(([, p]) => p === '.gitattributes' || p?.endsWith('/.gitattributes'))
    if (attrFiles.length > ATTR_FILES_MAX) unknownAt(a, 'attributes', `${attrFiles.length} .gitattributes files`) // i18n-ignore: what was found, shown as data beside its message
    else for (const [, p] of attrFiles) sources.push(join(root, p))
    // Untracked ones Git applies too (HI-2978): in a colocated working tree, each one Git lists as untracked and not
    // ignored; then, in either mode, those beside tracked files on disk, ignored or not (below).
    const seen = new Set(attrFiles.map(([, p]) => p))
    if (!o.separate) {
      const others = await deps.git(root, ['ls-files', '-z', '-o', '--exclude-standard', '--', ':(glob)**/.gitattributes'])
      if (!others.ok) unknownAt(a, 'attributes', `git ls-files -o: ${others.err}`) // i18n-ignore: what was found, shown as data beside its message
      else {
        const untracked = others.out.split('\0').filter((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'))
        if (untracked.length + attrFiles.length > ATTR_FILES_MAX) unknownAt(a, 'attributes', `${untracked.length + attrFiles.length} .gitattributes files`) // i18n-ignore: what was found, shown as data beside its message
        else
          for (const p of untracked) {
            if (seen.has(p)) continue
            seen.add(p)
            sources.push(join(root, p))
          }
      }
    }
    // Ignored ones Git applies all the same (HR1's HI-2978 round 1): the `.gitattributes` on disk in every folder holding
    // a tracked file, and the root's, whatever Git's untracked listing leaves out (bounded: past ATTR_DIRS_MAX folders,
    // unknown; a read that fails, unknown).
    const dirs = trackedDirs(rows.map((r) => r.split('\t')[1] ?? ''))
    if (dirs.length > ATTR_DIRS_MAX) unknownAt(a, 'attributes', `${dirs.length} folders with tracked files`) // i18n-ignore: what was found, shown as data beside its message
    else {
      const look = ['', ...dirs].map((d) => (d ? `${d}/.gitattributes` : '.gitattributes')).filter((p) => !seen.has(p))
      for (let i = 0; i < look.length; i += 64) {
        const found = await Promise.all(look.slice(i, i + 64).map(async (p) => [p, await stat(join(root, p)).then((st) => (st.isFile() ? 'file' : null), (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : 'unreadable'))] as const))
        for (const [p, kind] of found) {
          if (kind === 'unreadable') unknownAt(a, 'attributes', join(root, p))
          else if (kind === 'file') {
            seen.add(p)
            sources.push(join(root, p))
          }
        }
      }
      if (seen.size > ATTR_FILES_MAX) unknownAt(a, 'attributes', `${seen.size} .gitattributes files`) // i18n-ignore: what was found, shown as data beside its message
    }
    for (const r of rows) if (r.startsWith('160000 ')) add(a, 'submodules', `gitlink ${r.split('\t')[1] ?? ''}`)
  }
  for (const src of sources) {
    const text = await bounded(src)
    if (text === null) continue
    if (text === 'unreadable') {
      unknownAt(a, 'attributes', src)
      unknownAt(a, 'lfs', src)
      continue
    }
    const stockLines = gfw && astextplainStock && src === systemAttributes && samePath(src, gfw.attributes)
    const u = attributeUses(text, src, stockLines ? gfwStockAttrLine : undefined)
    for (const x of u.uses) add(a, 'attributes', x)
    for (const x of u.lfs) add(a, 'lfs', x)
  }
  // The repository's own files.
  for (const [file, gate] of [['.gitmodules', 'submodules'], ['.lfsconfig', 'lfs']] as const) {
    const st = await stat(join(root, file)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : 'unreadable' as const))
    if (st === 'unreadable') unknownAt(a, gate, file)
    else if (st) add(a, gate, file)
  }
  // Hooks: the folder Git runs them from, as Git names it (HI-2941: `rev-parse --git-path hooks` applies core.hooksPath
  // with Git's own expansion, `~/` and `%(prefix)/` included, else the store's hooks), relative to the working tree's top
  // where Git runs hooks; holding any hook but the samples. Git unable to say is unknown, never clear.
  const gp = await deps.git(root, ['rev-parse', '--git-path', 'hooks'])
  const said = gp.ok ? gp.out.trim() : ''
  if (!said) unknownAt(a, 'hooks', `git rev-parse --git-path hooks: ${gp.err || 'nothing'}${hooksPath ? ` (core.hooksPath ${hooksPath})` : ''}`) // i18n-ignore: what was found, shown as data beside its message
  else {
    const hooksDir = isAbsolute(said) ? said : resolve(root, said)
    const held = await hooksIn(hooksDir)
    if (held === null) unknownAt(a, 'hooks', hooksDir)
    else for (const h of held.slice(0, 5)) add(a, 'hooks', join(hooksDir, h))
  }
  // jj's own signing, at every level it reads.
  const jc = await deps.jj.run(root, ['config', 'list', 'signing.behavior'])
  if (!jc.ok && jc.code === -1) unknownAt(a, 'signing', `jj config list: ${jc.err}`) // i18n-ignore: what was found, shown as data beside its message
  else if (jc.ok && /signing\.behavior\s*=\s*"(own|force)"/.test(jc.out)) add(a, 'signing', 'signing.behavior (jj)')
  if (autocrlfOn && 'uses' in a.attributes) a.attributes = { ...a.attributes, autocrlf: true }
  return a
}

/** Whether every repository gate is clear. */
export const allClear = (a: Assessment): boolean => REPO_GATES.every((g) => 'clear' in a[g])
