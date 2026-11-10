// The compatibility assessment before a switch to jj (HI-2799, J6; SPEC §16.3.6's gates, J0's detection rules): what a
// repository uses that jj doesn't support, read from what Git and jj would actually apply, never one source of it: Git's
// effective config at every level and include (`git config --list --show-origin --show-scope --includes`, run in the
// repository), every attribute source Git applies (the system's, the global one, every tracked `.gitattributes`, the
// store's `info/attributes`), jj's effective config (`jj config list`), and the repository's files. Anything it can't
// read, list or resolve is "uses it" (unknown): the gate stays closed. Read-only: never a write, a snapshot or an import.
// J7 completes it (non-colocated paths, trust roots, file lists).

import { join, resolve, isAbsolute } from 'path'
import { readdir, readFile, stat } from 'original-fs/promises'
import type { Gate } from '../../shared/platform/descriptors'
import type { RunResult } from './repoContext'
import { git } from '../git'
import { jjRunner, type JjRunner } from './jjRunner'

/** The gates a repository's own use decides (the rest are jj's own limits, closed whatever the repository uses). */
export type RepoGate = Extract<Gate, 'attributes' | 'lfs' | 'submodules' | 'hooks' | 'signing'>
export const REPO_GATES: readonly RepoGate[] = ['attributes', 'lfs', 'submodules', 'hooks', 'signing']

/** A gate's finding: clear, what uses it (a key, a file, an attribute line; at most a few), or what couldn't be read. */
export type GateFinding = { clear: true } | { uses: string[] } | { unknown: string }
export type Assessment = Record<RepoGate, GateFinding>

/** What the assessment runs: git and jj in the repository (injected in tests). */
export interface CompatDeps {
  git: (cwd: string, args: string[]) => Promise<Pick<RunResult, 'ok' | 'out' | 'err'>>
  jj: JjRunner
}

const DEFAULTS: CompatDeps = { git: (cwd, args) => git(cwd, args), jj: jjRunner }

/** At most this many tracked .gitattributes files are read; more is unknown (fail closed). */
export const ATTR_FILES_MAX = 2000
/** At most this much of one attribute file is read; larger is unknown. */
export const ATTR_FILE_MAX = 1024 * 1024
/** The attributes jj doesn't apply (v0.47.1's Git compatibility page): any mention of one, set or unset, uses it. */
const ATTRS = ['text', 'eol', 'filter', 'diff', 'merge', 'working-tree-encoding', 'ident']

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

/** A Git boolean that is true (`true`, `yes`, `on`, `1`; a key with no value). */
const gitTrue = (v: string | null): boolean => v === null || /^(true|yes|on|1)$/i.test(v.trim())
/** A Git boolean that is false (`false`, `no`, `off`, `0`, an empty value). */
const gitFalse = (v: string | null): boolean => v !== null && /^(false|no|off|0|)$/i.test(v.trim())

/** Each attribute line of a file naming an attribute jj doesn't apply, as `<file>: <line>` (at most 3), and lfs's. */
export function attributeUses(text: string, file: string): { uses: string[]; lfs: string[] } {
  const uses: string[] = []
  const lfs: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
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
 * Assesses the repository at `root` (its working tree's top) with Git store `store`: each repository gate clear, used
 * (with what uses it) or unknown. A switch to jj is refused unless every one is clear.
 */
export async function assessJj(root: string, store: string, deps: CompatDeps = DEFAULTS): Promise<Assessment> {
  const a: Assessment = { attributes: { clear: true }, lfs: { clear: true }, submodules: { clear: true }, hooks: { clear: true }, signing: { clear: true } }
  // Git's effective config, every level and include, as Git reads it here.
  const cfg = await deps.git(root, ['config', '--list', '--show-origin', '--show-scope', '--includes', '-z'])
  const entries = cfg.ok ? parseConfig(cfg.out) : null
  if (!entries) for (const g of REPO_GATES) unknownAt(a, g, `git config: ${cfg.err || 'unreadable'}`) // i18n-ignore: what was found, shown as data beside its message
  let hooksPath: string | null = null
  let autocrlf: { at: string; value: string | null } | null = null
  let attributesFile: string | null = null
  for (const e of entries ?? []) {
    const at = `${e.key} (${e.scope})`
    // core.autocrlf as Git applies it: its last value, a later level's winning. False converts nothing, as jj does.
    if (e.key === 'core.autocrlf') autocrlf = { at, value: e.value }
    else if (e.key === 'core.eol' || /^filter\.[^.]+\.(clean|smudge|process)$/.test(e.key)) {
      if (e.key.startsWith('filter.lfs.')) add(a, 'lfs', at)
      else add(a, 'attributes', at)
    }
    if (e.key.startsWith('lfs.')) add(a, 'lfs', at)
    if (e.key.startsWith('submodule.')) add(a, 'submodules', at)
    if ((e.key === 'commit.gpgsign' || e.key === 'tag.gpgsign') && gitTrue(e.value)) add(a, 'signing', at)
    if (e.key === 'core.hookspath') hooksPath = e.value
    if (e.key === 'core.attributesfile') attributesFile = e.value
  }
  if (autocrlf && !gitFalse(autocrlf.value)) add(a, 'attributes', `${autocrlf.at} = ${autocrlf.value ?? 'true'}`) // i18n-ignore: what was found, shown as data beside its message
  // Attribute sources: the system's and the global one as Git names them, every tracked .gitattributes, info/attributes.
  const sources: string[] = []
  for (const v of ['GIT_ATTR_SYSTEM', 'GIT_ATTR_GLOBAL']) {
    const r = await deps.git(root, ['var', v])
    if (r.ok && r.out.trim()) sources.push(resolve(r.out.trim()))
    // No such source (GIT_ATTR_NOSYSTEM, no global file): git var exits 1 saying nothing. Anything it says is unknown.
    else if (!r.ok && r.err.trim() && !/not a valid|unknown variable/i.test(r.err)) unknownAt(a, 'attributes', `git var ${v}: ${r.err}`) // i18n-ignore: what was found, shown as data beside its message
  }
  if (attributesFile) sources.push(isAbsolute(attributesFile) ? attributesFile : resolve(root, attributesFile))
  sources.push(join(store, 'info', 'attributes'))
  const listed = await deps.git(root, ['ls-files', '-z', '-s'])
  if (!listed.ok) {
    unknownAt(a, 'attributes', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
    unknownAt(a, 'submodules', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
    unknownAt(a, 'lfs', `git ls-files: ${listed.err}`) // i18n-ignore: what was found, shown as data beside its message
  } else {
    const rows = listed.out.split('\0').filter(Boolean)
    const attrFiles = rows.map((r) => r.split('\t')).filter(([, p]) => p === '.gitattributes' || p?.endsWith('/.gitattributes'))
    if (attrFiles.length > ATTR_FILES_MAX) unknownAt(a, 'attributes', `${attrFiles.length} .gitattributes files`) // i18n-ignore: what was found, shown as data beside its message
    else for (const [, p] of attrFiles) sources.push(join(root, p))
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
    const u = attributeUses(text, src)
    for (const x of u.uses) add(a, 'attributes', x)
    for (const x of u.lfs) add(a, 'lfs', x)
  }
  // The repository's own files.
  for (const [file, gate] of [['.gitmodules', 'submodules'], ['.lfsconfig', 'lfs']] as const) {
    const st = await stat(join(root, file)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : 'unreadable' as const))
    if (st === 'unreadable') unknownAt(a, gate, file)
    else if (st) add(a, gate, file)
  }
  // Hooks: core.hooksPath (resolved as Git resolves it, from the working tree's top) holding any file, else the store's
  // hooks folder holding any file but the samples.
  const hooksDir = hooksPath ? (isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath)) : join(store, 'hooks')
  const held = await hooksIn(hooksDir)
  if (held === null) unknownAt(a, 'hooks', hooksDir)
  else for (const h of held.slice(0, 5)) add(a, 'hooks', join(hooksDir, h))
  // jj's own signing, at every level it reads.
  const jc = await deps.jj.run(root, ['config', 'list', 'signing.behavior'])
  if (!jc.ok && jc.code === -1) unknownAt(a, 'signing', `jj config list: ${jc.err}`) // i18n-ignore: what was found, shown as data beside its message
  else if (jc.ok && /signing\.behavior\s*=\s*"(own|force)"/.test(jc.out)) add(a, 'signing', 'signing.behavior (jj)')
  return a
}

/** Whether every repository gate is clear. */
export const allClear = (a: Assessment): boolean => REPO_GATES.every((g) => 'clear' in a[g])
