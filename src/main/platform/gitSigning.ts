// Git's commit signing, read and checked (HI-1185, SPEC §16.9.5): how a repository signs, as git resolves it in the
// folder a commit runs in (with that commit's own `-c` overrides), and a check that signs a throwaway payload the way git
// would, with nobody there. Only signers Combwork can vouch for run: the program a commit would run is found first, to a
// full path, and is checked only when that path is a known installation (Git for Windows' own gpg or ssh-keygen,
// GnuPG's, Windows' OpenSSH); anything else is `notChecked` and never invoked. Those run with no prompt of their own
// (gpg: --batch --no-tty --pinentry-mode error --no-autostart; ssh-keygen: SSH_ASKPASS_REQUIRE=never, no stdin) and
// within a bound that ends their tree. What Combwork can't control is said, not denied: an agent already running, a
// smartcard or a hardware key may still ask in its own way, and the check then ends at its bound (`couldNotComplete`).
// Nothing here writes git, ssh or gpg configuration, or starts or stops an agent.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'original-fs'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path'
import { git } from '../git'
import { gitExe } from '../gitTool'
import { withLauncherEnv } from '../gitWorker'
import { boundedSpawn } from './boundedSpawn'
import type { QueueGitResult } from './integration'
import { agentMsg, say } from '../../shared/agentText'
import type { GitScope, ScopedValue, SigningInfo, SigningStatus } from '../../shared/gitSigning'

/** How long a check waits on its signer before ending it (a few seconds: a signer that asks takes longer). */
export const SIGN_CHECK_MS = 5_000

/** What a check needs: git and a program run in the commit's folder, with its overrides and environment. */
export interface SignDeps {
  /** git in `cwd` (the caller's runner: the queue's in its lease's job). */
  git: (cwd: string, args: string[]) => Promise<QueueGitResult>
  /** A program run to its end within `timeoutMs`, its tree ended there; `input` its stdin. */
  spawn: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }) => Promise<QueueGitResult>
  /** The folder the commit runs in. */
  cwd: string
  /** The commit's own overrides (`-c user.name=… -c user.email=…`), before each git command. */
  who: string[]
  /** The commit's environment (its PATH is where git finds its signer). */
  env: NodeJS.ProcessEnv
}

/** For tests only: which resolved programs count as known installations (production never sets it). */
export const signingTestHooks: { eligible?: (path: string) => boolean } = {}

const SCOPES: readonly GitScope[] = ['system', 'global', 'local', 'worktree', 'command']
const scopeOf = (s: string): GitScope => (SCOPES as readonly string[]).includes(s) ? (s as GitScope) : 'unknown'
const T = {
  exited: agentMsg({ id: 'queue.signing.exited', text: 'exited with code {code}', note: "A signing check's detail (HI-1185) when the tool said nothing: its exit code." }),
  notFound: agentMsg({ id: 'queue.signing.notFound', text: "{name} wasn't found", note: "A signing check's detail (HI-1185): the signing program (name: as configured, or git's default) isn't on the commit's PATH." }),
  noSshKey: agentMsg({ id: 'queue.signing.noSshKey', text: 'user.signingkey is not set, and git needs it to sign with ssh', note: "A signing check's detail (HI-1185): ssh signing with no key set and no key command. Keep user.signingkey." })
}
const said = (r: QueueGitResult): string => `${r.err}\n${r.out}`.trim() || say(T.exited, { code: r.code })

/** One setting's effective value and scope (the last git reads wins), null when unset; `failed` when git couldn't say. */
async function scoped(d: SignDeps, args: string[], regexp = false): Promise<ScopedValue | null | { failed: string }> {
  const r = await d.git(d.cwd, [...d.who, 'config', '--show-scope', ...args])
  if (r.ok) {
    const line = r.out.split(/\r?\n/).filter(Boolean).at(-1) ?? ''
    const tab = line.indexOf('\t')
    let value = tab < 0 ? line : line.slice(tab + 1)
    // --get-regexp's lines are `<scope>\t<key> <value>`: the value after the key.
    if (regexp) value = value.slice(value.indexOf(' ') + 1)
    return { scope: scopeOf(tab < 0 ? '' : line.slice(0, tab)), value: value.trim() }
  }
  if (r.code === 1 && !r.timedOut && !r.notRun && !r.signal) return null
  return { failed: said(r) }
}
const failed = (v: unknown): v is { failed: string } => !!v && typeof v === 'object' && 'failed' in v

/** A key as it may be shown: never key material (an openpgp id's last 16 digits, an ssh key file's name, a literal key's type and comment). */
export function shownKey(format: 'openpgp' | 'ssh' | 'x509', key: string): string {
  if (format === 'ssh') {
    if (key.startsWith('key::')) {
      const [type, , ...comment] = key.slice(5).trim().split(/\s+/)
      return [type, ...comment].join(' ')
    }
    return basename(key)
  }
  const hex = key.replace(/^0x/i, '')
  return /^[0-9a-f]{17,}$/i.test(hex) ? hex.slice(-16).toUpperCase() : key
}

/** Where a program name resolves for the commit: a path as given (against its folder), else on its PATH with PATHEXT. */
export function resolveProgram(name: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT') ?? 'PATHEXT'
  const exts = process.platform === 'win32' ? [...(env[extKey] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean), ''] : ['']
  const tryAll = (base: string): string | null => {
    for (const ext of exts) if (isFile(base + ext)) return base + ext
    return null
  }
  if (/[\\/]/.test(name)) return tryAll(isAbsolute(name) ? name : resolve(cwd, name))
  for (const dir of (env[pathKey] ?? '').split(delimiter).filter(Boolean)) {
    const found = tryAll(join(dir, name))
    if (found) return found
  }
  return null
}

/** Git for Windows' own folders (its `usr\bin`), from the git Combwork runs. */
function gitRoots(execPath?: string): string[] {
  const use = gitExe()
  const out = new Set<string>()
  // git's own --exec-path: <root>\<mingw64|ucrt64>\libexec\git-core.
  if (execPath) out.add(resolve(execPath, '..', '..', '..'))
  for (const p of use.launcherEnv?.pathFirst.split(delimiter) ?? []) if (/[\\/]usr[\\/]bin$/i.test(p)) out.add(dirname(dirname(p)))
  let d = dirname(use.exe)
  for (let i = 0; i < 3; i++) {
    out.add(d)
    d = dirname(d)
  }
  return [...out]
}

/** Whether a resolved program is a known installation Combwork runs by itself (the same rule, configured or default). */
export function knownInstallation(path: string, env: NodeJS.ProcessEnv = process.env, execPath?: string): boolean {
  if (signingTestHooks.eligible) return signingTestHooks.eligible(path)
  const p = resolve(path).toLowerCase()
  const known: string[] = []
  for (const root of gitRoots(execPath)) known.push(join(root, 'usr', 'bin', 'gpg.exe'), join(root, 'usr', 'bin', 'ssh-keygen.exe'))
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (env[k]) known.push(join(env[k]!, 'GnuPG', 'bin', 'gpg.exe'))
  if (env.SystemRoot) known.push(join(env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe'))
  return known.some((k) => resolve(k).toLowerCase() === p)
}

/** A signer's words that say it needs someone (a passphrase, a pinentry, an agent with the key unlocked). */
const NEEDS = /passphrase|pinentry|no gpg-agent|agent.*not running|can't connect to the agent|agent refused|inappropriate ioctl|no tty|cannot open \/dev\/tty|operation cancelled|could not open a connection to your authentication agent/i

/** What a signer's run says (exported for its tests): signed, needs someone, didn't finish, or failed with its words. */
export function signerSaid(format: 'openpgp' | 'ssh', r: QueueGitResult): SigningStatus {
  if (r.timedOut || r.signal) return { kind: 'couldNotComplete', format }
  const words = said(r).slice(-2000)
  if (r.notRun) return { kind: 'cantSign', message: words }
  if (r.ok) return { kind: 'unattended' }
  return NEEDS.test(words) ? { kind: 'needsSomeone', format, detail: words } : { kind: 'cantSign', message: words }
}

const PAYLOAD = 'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Combwork <check@combwork.invalid> 0 +0000\ncommitter Combwork <check@combwork.invalid> 0 +0000\n\nCombwork checks that signing works\n' // i18n-ignore: the throwaway payload a check signs, never shown

/**
 * How the repository signs in `d.cwd`, and whether this signer could sign just now with nobody there. A check that
 * succeeds means only that: never that another process's commit will, or that a cache will still hold.
 */
export async function checkSigning(d: SignDeps, timeoutMs = SIGN_CHECK_MS): Promise<SigningInfo> {
  const at = new Date().toISOString()
  const base: Omit<SigningInfo, 'status'> = { sign: null, format: 'openpgp', formatScope: null, key: null, program: null, at }
  const sign = await scoped(d, ['--type=bool', '--get', 'commit.gpgsign'])
  if (failed(sign)) return { ...base, status: { kind: 'unreadable', message: sign.failed } }
  const fmt = await scoped(d, ['--get', 'gpg.format'])
  if (failed(fmt)) return { ...base, sign, status: { kind: 'unreadable', message: fmt.failed } }
  const format: SigningInfo['format'] = fmt?.value === 'ssh' ? 'ssh' : fmt?.value === 'x509' ? 'x509' : 'openpgp'
  const key = await scoped(d, ['--get', 'user.signingkey'])
  if (failed(key)) return { ...base, sign, format, formatScope: fmt?.scope ?? null, status: { kind: 'unreadable', message: key.failed } }
  const info: Omit<SigningInfo, 'status'> = { ...base, sign, format, formatScope: fmt?.scope ?? null, key: key ? { scope: key.scope, value: shownKey(format, key.value) } : null }
  if (sign?.value !== 'true') return { ...info, status: { kind: 'off' } }
  if (format === 'x509') return { ...info, status: { kind: 'notChecked', why: 'x509' } } // i18n-ignore: a status code, never shown as text
  // The program, as git takes it: gpg.program and gpg.openpgp.program are one setting under two names (the last read wins).
  const prog = format === 'ssh' ? await scoped(d, ['--get', 'gpg.ssh.program']) : await scoped(d, ['--get-regexp', '^gpg\\.(openpgp\\.)?program$'], true)
  if (failed(prog)) return { ...info, status: { kind: 'unreadable', message: prog.failed } }
  const name = prog?.value || (format === 'ssh' ? 'ssh-keygen' : 'gpg')
  const program = resolveProgram(name, d.cwd, d.env)
  if (!program) return { ...info, status: { kind: 'cantSign', message: say(T.notFound, { name }) } }
  const withProgram = { ...info, program }
  // Where this git is installed, as it says itself (its own ssh-keygen and gpg are beside it).
  const exec = await d.git(d.cwd, ['--exec-path'])
  if (!knownInstallation(program, d.env, exec.ok ? exec.out.trim() : undefined)) return { ...withProgram, status: { kind: 'notChecked', why: 'program', path: program } } // i18n-ignore: a status code, never shown as text
  const dir = mkdtempSync(join(tmpdir(), 'combwork-sign-'))
  try {
    if (format === 'openpgp') {
      // git's own default key: the committer, as this commit would be made (its overrides included).
      let who = key?.value
      if (!who) {
        const v = await d.git(d.cwd, [...d.who, 'var', 'GIT_COMMITTER_IDENT'])
        if (!v.ok) return { ...withProgram, status: { kind: 'unreadable', message: said(v) } }
        who = v.out.trim().replace(/\s+\d+\s+[+-]\d{4}$/, '')
      }
      const r = await d.spawn(program, ['--batch', '--no-tty', '--pinentry-mode', 'error', '--no-autostart', '--status-fd=2', '-bsau', who], { cwd: d.cwd, env: d.env, input: PAYLOAD, timeoutMs })
      return { ...withProgram, status: signerSaid('openpgp', r) }
    }
    let file: string
    if (!key) {
      const cmd = await scoped(d, ['--get', 'gpg.ssh.defaultKeyCommand'])
      if (failed(cmd)) return { ...withProgram, status: { kind: 'unreadable', message: cmd.failed } }
      if (cmd) return { ...withProgram, status: { kind: 'notChecked', why: 'keyCommand' } } // i18n-ignore: a status code, never shown as text
      return { ...withProgram, status: { kind: 'cantSign', message: say(T.noSshKey) } }
    }
    if (key.value.startsWith('key::')) {
      file = join(dir, 'key.pub')
      writeFileSync(file, `${key.value.slice(5).trim()}\n`)
    } else {
      const home = d.env.HOME ?? d.env.USERPROFILE ?? ''
      const v = key.value.startsWith('~/') || key.value.startsWith('~\\') ? join(home, key.value.slice(2)) : key.value
      file = isAbsolute(v) ? v : resolve(d.cwd, v)
    }
    // A hardware key asks for a touch: never checked by itself.
    const pub = file.endsWith('.pub') ? file : `${file}.pub`
    try {
      if (readFileSync(pub, 'utf8').trim().startsWith('sk-')) return { ...withProgram, status: { kind: 'notChecked', why: 'hardware' } } // i18n-ignore: a status code, never shown as text
    } catch {
      // no public key beside it: the private key file alone
    }
    const payload = join(dir, 'payload')
    writeFileSync(payload, PAYLOAD)
    const env: NodeJS.ProcessEnv = { ...d.env, SSH_ASKPASS_REQUIRE: 'never' }
    delete env.DISPLAY
    delete env.SSH_ASKPASS
    const r = await d.spawn(program, ['-Y', 'sign', '-n', 'git', '-f', file, payload], { cwd: d.cwd, env, timeoutMs })
    return { ...withProgram, status: signerSaid('ssh', r) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** How long the view keeps a folder's check before checking again by itself (Check again checks at once). */
const VIEW_CHECK_MS = 60_000
const viewChecks = new Map<string, { at: number; settings: string; check: Promise<SigningInfo> }>()

/**
 * The Git view's check (Branches & remotes): in the folder, as an agent's commit there would sign (no overrides), its
 * signer run as a bounded spawn owned by the folder (ended when its workspace closes or Combwork quits). One at a time
 * per folder (callers share it), and at most once a minute unless `force` or its signing settings changed.
 */
export async function viewSigning(root: string, force = false): Promise<SigningInfo> {
  const key = root.toLowerCase()
  const run = async (cwd: string, args: string[]): Promise<QueueGitResult> => {
    const r = await git(cwd, args)
    return { ok: r.ok, out: r.out, err: r.err, code: r.code, ...(r.timedOut ? { timedOut: true } : {}), ...(r.notRun ? { notRun: r.notRun } : {}) }
  }
  // The settings a check depends on, read each time (cheap): a change to them is checked at once, never a minute late.
  const read = await run(root, ['config', '--show-scope', '--get-regexp', '^(commit\\.gpgsign|gpg\\..*|user\\.(signingkey|name|email))$'])
  const settings = read.ok ? read.out : `!${read.code}`
  const had = viewChecks.get(key)
  if (had && had.settings === settings && Date.now() - had.at < VIEW_CHECK_MS && (!force || Date.now() - had.at < 1000)) return had.check
  const use = gitExe()
  const env = use.launcherEnv ? withLauncherEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, use.launcherEnv) : { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  const check = checkSigning({ git: run, spawn: (file, args, o) => boundedSpawn(file, args, { ...o, owner: root }), cwd: root, who: [], env })
  viewChecks.set(key, { at: Date.now(), settings, check })
  // A check that failed outright isn't kept: the next look checks again.
  check.catch(() => viewChecks.delete(key))
  return check
}
