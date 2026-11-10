// Git's commit signing, read and checked (HI-1185, SPEC §16.9.5): how a repository signs, as git resolves it in the
// folder a commit runs in (with that commit's own `-c` overrides), and a check that signs a throwaway payload the way git
// would, with nobody there. Only signers Combwork can vouch for run: the program a commit would run is found first, to a
// full path, and is checked only when that path is a known installation (Git for Windows' own gpg or ssh-keygen,
// GnuPG's, Windows' OpenSSH); anything else is `notChecked` and never invoked. Those run with no prompt of their own
// (gpg: --batch --no-tty --pinentry-mode error --no-autostart; ssh-keygen: SSH_ASKPASS_REQUIRE=never, no stdin) and
// within a bound that ends their tree. What Combwork can't control is said, not denied: an agent already running, a
// smartcard or a hardware key may still ask in its own way, and the check then ends at its bound (`couldNotComplete`).
// Nothing here writes git, ssh or gpg configuration, or starts or stops an agent.

import { mkdtemp, open, rm, stat, writeFile } from 'original-fs/promises'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path'
import { git } from '../git'
import { gitExe } from '../gitTool'
import { withLauncherEnv } from '../gitWorker'
import { rmSync } from 'original-fs'
import { boundedSpawn, endBoundedSpawns, endBoundedSpawnsNow } from './boundedSpawn'
import { onOwnerGone, ownedWorkStopped } from './ownedWork'
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
  spawn: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<QueueGitResult>
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

/**
 * Where a program name resolves for the commit: a path as given (against its folder), else on its PATH with PATHEXT.
 * Asynchronous throughout (HR1's HI-1185 round 1: a network PATH entry never blocks the thread it runs on).
 */
export async function resolveProgram(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const isFile = async (p: string): Promise<boolean> => {
    try {
      return (await stat(p)).isFile()
    } catch {
      return false
    }
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const extKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT') ?? 'PATHEXT'
  const exts = process.platform === 'win32' ? [...(env[extKey] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean), ''] : ['']
  const tryAll = async (base: string): Promise<string | null> => {
    for (const ext of exts) if (await isFile(base + ext)) return base + ext
    return null
  }
  if (/[\\/]/.test(name)) return tryAll(isAbsolute(name) ? name : resolve(cwd, name))
  for (const dir of (env[pathKey] ?? '').split(delimiter).filter(Boolean)) {
    const found = await tryAll(join(dir, name))
    if (found) return found
  }
  return null
}

/** A file's start (at most `max` bytes), asynchronously; null when it can't be read. */
async function head(path: string, max = 4096): Promise<string | null> {
  try {
    const f = await open(path, 'r')
    try {
      const buf = Buffer.alloc(max)
      const { bytesRead } = await f.read(buf, 0, max, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await f.close()
    }
  } catch {
    return null
  }
}

/** A check given up because its owner closed or was removed (HR1's round 1): nothing more of it runs. */
export class SigningCancelled extends Error {
  constructor() {
    super('signing check cancelled') // i18n-ignore: an internal error, never shown
  }
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
export async function checkSigning(d: SignDeps, timeoutMs = SIGN_CHECK_MS, signal?: AbortSignal): Promise<SigningInfo> {
  // Given up when its owner goes (HR1's round 1): looked at after each read, and just before anything is spawned.
  const live = (): void => {
    if (signal?.aborted) throw new SigningCancelled()
  }
  live()
  const at = new Date().toISOString()
  const base: Omit<SigningInfo, 'status'> = { sign: null, format: 'openpgp', formatScope: null, key: null, program: null, at }
  const sign = await scoped(d, ['--type=bool', '--get', 'commit.gpgsign'])
  live()
  if (failed(sign)) return { ...base, status: { kind: 'unreadable', message: sign.failed } }
  const fmt = await scoped(d, ['--get', 'gpg.format'])
  live()
  if (failed(fmt)) return { ...base, sign, status: { kind: 'unreadable', message: fmt.failed } }
  const format: SigningInfo['format'] = fmt?.value === 'ssh' ? 'ssh' : fmt?.value === 'x509' ? 'x509' : 'openpgp'
  const key = await scoped(d, ['--get', 'user.signingkey'])
  live()
  if (failed(key)) return { ...base, sign, format, formatScope: fmt?.scope ?? null, status: { kind: 'unreadable', message: key.failed } }
  const info: Omit<SigningInfo, 'status'> = { ...base, sign, format, formatScope: fmt?.scope ?? null, key: key ? { scope: key.scope, value: shownKey(format, key.value) } : null }
  if (sign?.value !== 'true') return { ...info, status: { kind: 'off' } }
  if (format === 'x509') return { ...info, status: { kind: 'notChecked', why: 'x509' } } // i18n-ignore: a status code, never shown as text
  // The program, as git takes it: gpg.program and gpg.openpgp.program are one setting under two names (the last read wins).
  const prog = format === 'ssh' ? await scoped(d, ['--get', 'gpg.ssh.program']) : await scoped(d, ['--get-regexp', '^gpg\\.(openpgp\\.)?program$'], true)
  live()
  if (failed(prog)) return { ...info, status: { kind: 'unreadable', message: prog.failed } }
  const name = prog?.value || (format === 'ssh' ? 'ssh-keygen' : 'gpg')
  const program = await resolveProgram(name, d.cwd, d.env)
  live()
  if (!program) return { ...info, status: { kind: 'cantSign', message: say(T.notFound, { name }) } }
  const withProgram = { ...info, program }
  // Where this git is installed, as it says itself (its own ssh-keygen and gpg are beside it).
  const exec = await d.git(d.cwd, ['--exec-path'])
  live()
  if (!knownInstallation(program, d.env, exec.ok ? exec.out.trim() : undefined)) return { ...withProgram, status: { kind: 'notChecked', why: 'program', path: program } } // i18n-ignore: a status code, never shown as text
  let dir: string | null = null
  try {
    if (format === 'openpgp') {
      // git's own default key: the committer, as this commit would be made (its overrides included).
      let who = key?.value
      if (!who) {
        const v = await d.git(d.cwd, [...d.who, 'var', 'GIT_COMMITTER_IDENT'])
        live()
        if (!v.ok) return { ...withProgram, status: { kind: 'unreadable', message: said(v) } }
        who = v.out.trim().replace(/\s+\d+\s+[+-]\d{4}$/, '')
      }
      live()
      const r = await d.spawn(program, ['--batch', '--no-tty', '--pinentry-mode', 'error', '--no-autostart', '--status-fd=2', '-bsau', who], { cwd: d.cwd, env: d.env, input: PAYLOAD, timeoutMs, ...(signal ? { signal } : {}) })
      live()
      return { ...withProgram, status: signerSaid('openpgp', r) }
    }
    let file: string
    if (!key) {
      const cmd = await scoped(d, ['--get', 'gpg.ssh.defaultKeyCommand'])
      live()
      if (failed(cmd)) return { ...withProgram, status: { kind: 'unreadable', message: cmd.failed } }
      if (cmd) return { ...withProgram, status: { kind: 'notChecked', why: 'keyCommand' } } // i18n-ignore: a status code, never shown as text
      return { ...withProgram, status: { kind: 'cantSign', message: say(T.noSshKey) } }
    }
    dir = await mkdtemp(join(tmpdir(), 'combwork-sign-'))
    liveDirs.add(dir)
    if (key.value.startsWith('key::')) {
      file = join(dir, 'key.pub')
      await writeFile(file, `${key.value.slice(5).trim()}\n`)
    } else {
      const home = d.env.HOME ?? d.env.USERPROFILE ?? ''
      const v = key.value.startsWith('~/') || key.value.startsWith('~\\') ? join(home, key.value.slice(2)) : key.value
      file = isAbsolute(v) ? v : resolve(d.cwd, v)
    }
    // A hardware key asks for a touch: never checked by itself. Only the file's start is read (a key line is short).
    const pub = file.endsWith('.pub') ? file : `${file}.pub`
    if ((await head(pub))?.trim().startsWith('sk-')) return { ...withProgram, status: { kind: 'notChecked', why: 'hardware' } } // i18n-ignore: a status code, never shown as text
    const payload = join(dir, 'payload')
    await writeFile(payload, PAYLOAD)
    const env: NodeJS.ProcessEnv = { ...d.env, SSH_ASKPASS_REQUIRE: 'never' }
    delete env.DISPLAY
    delete env.SSH_ASKPASS
    live()
    const r = await d.spawn(program, ['-Y', 'sign', '-n', 'git', '-f', file, payload], { cwd: d.cwd, env, timeoutMs, ...(signal ? { signal } : {}) })
    live()
    return { ...withProgram, status: signerSaid('ssh', r) }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      liveDirs.delete(dir)
    }
  }
}

/** The checks' temp folders still there: a shutdown that can't wait removes them (endSigningNow). */
const liveDirs = new Set<string>()

// ---- The Git view's checks (Branches & remotes), HR1's HI-1185 round 1: each tracked from its admission (its settings
// read included) to its end, so an owner closing or removed gives it up wherever it is, and nothing of it starts after.
// One in flight per folder: a call with the same settings joins it; changed settings, or Check again with nothing in
// flight, cancel what runs and wait for it before starting anew. Admission is in turn per folder. A finished check is
// kept (a minute, while its settings stay) apart from what is in flight, written only by its own generation, and swept
// on each look, on its owner's close, and on its expiry.

/** How long the view keeps a folder's finished check while its settings stay (Check again checks at once). */
const VIEW_CHECK_MS = 60_000

interface Admitted {
  owner: string
  abort: AbortController
  /** The whole operation, queued turn included, settled however it ends: what a close waits for. */
  settled: Promise<void>
}
interface Running extends Admitted {
  gen: number
  settings: string
  done: Promise<SigningInfo>
}

/** Every check from its admission until it ends (its settings read too), by owner, for cancellation. */
const admitted = new Set<Admitted>()
/** The check in flight per folder. */
const running = new Map<string, Running>()
/** Finished checks per folder: what Check again or changed settings replace. */
const results = new Map<string, { at: number; owner: string; settings: string; info: SigningInfo }>()
/** Each folder's admission in turn. */
const turns = new Map<string, Promise<unknown>>()
let generation = 0

/** For tests only: the check's git and spawn (a delayed read, a recording signer), and the clock its cache reads. */
export const viewSigningTestHooks: { deps?: (root: string) => Partial<SignDeps>; now?: () => number } = {}
const clock = (): number => viewSigningTestHooks.now?.() ?? Date.now()

function inTurn<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = turns.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  turns.set(key, tail)
  void tail.then(() => {
    if (turns.get(key) === tail) turns.delete(key)
  })
  return run
}

function viewDeps(root: string, signal: AbortSignal): SignDeps {
  const use = gitExe()
  const quiet = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  return {
    git: async (cwd, args) => {
      const r = await git(cwd, args)
      return { ok: r.ok, out: r.out, err: r.err, code: r.code, ...(r.timedOut ? { timedOut: true } : {}), ...(r.notRun ? { notRun: r.notRun } : {}) }
    },
    spawn: (file, args, o) => boundedSpawn(file, args, { ...o, owner: root, signal }),
    cwd: root,
    who: [],
    env: use.launcherEnv ? withLauncherEnv(quiet, use.launcherEnv) : quiet,
    ...viewSigningTestHooks.deps?.(root)
  }
}

/**
 * The Git view's check (Branches & remotes): in the folder, as an agent's commit there would sign (no overrides), its
 * signer a bounded spawn owned by the folder. Rejects with SigningCancelled when its owner closes or is removed meanwhile.
 */
export function viewSigning(root: string, force = false): Promise<SigningInfo> {
  // Refused while Combwork quits or its owner is being closed (HR1's round 2): an IPC already on its way recreates nothing.
  if (ownedWorkStopped() || [...closing].some((owner) => owner(root))) return Promise.reject(new SigningCancelled())
  const key = root.toLowerCase()
  // Owned from this call, before its turn (HR1's round 2): a close finds it queued too, and waits for it.
  const me: Admitted = { owner: root, abort: new AbortController(), settled: Promise.resolve() }
  admitted.add(me)
  // The admission returns its check wrapped, so this turn ends once it is admitted, not once it has signed.
  const check = inTurn(key, () => admit(root, key, force, me)).then((a) => a.check)
  me.settled = check.then(
    () => undefined,
    () => undefined
  )
  return check
}

async function admit(root: string, key: string, force: boolean, me: Admitted): Promise<{ check: Promise<SigningInfo> }> {
  const now = clock()
  for (const [k, r] of results) if (now - r.at >= VIEW_CHECK_MS) results.delete(k)
  let handedOn = false
  try {
    // Given up while it waited its turn.
    if (me.abort.signal.aborted) throw new SigningCancelled()
    const d = viewDeps(root, me.abort.signal)
    // The settings a check depends on, read each time (cheap): a change to them is checked at once, never a minute late.
    const read = await d.git(root, ['config', '--show-scope', '--get-regexp', '^(commit\\.gpgsign|gpg\\..*|user\\.(signingkey|name|email))$'])
    if (me.abort.signal.aborted) throw new SigningCancelled()
    const settings = read.ok ? read.out : `!${read.code}`
    const live = running.get(key)
    // In flight with the same settings: joined (fresh already, Check again included).
    if (live && live.settings === settings) return { check: live.done }
    if (live) {
      live.abort.abort()
      await live.done.catch(() => undefined)
      if (me.abort.signal.aborted) throw new SigningCancelled()
    }
    const had = results.get(key)
    if (!force && had && had.settings === settings && clock() - had.at < VIEW_CHECK_MS) return { check: Promise.resolve(had.info) }
    const gen = ++generation
    const done = checkSigning(d, SIGN_CHECK_MS, me.abort.signal)
      .then((info) => {
        if (running.get(key)?.gen === gen) results.set(key, { at: clock(), owner: root, settings, info })
        return info
      })
      .finally(() => {
        if (running.get(key)?.gen === gen) running.delete(key)
        admitted.delete(me)
      })
    // Its rejection (a cancel) is its callers'; nobody waiting on it is never an unhandled one.
    done.catch(() => undefined)
    running.set(key, { ...me, gen, settings, done })
    handedOn = true
    return { check: done }
  } finally {
    if (!handedOn) admitted.delete(me)
  }
}

/**
 * Gives up the view's checks an owner had (a workspace closing, a project removed, Combwork quitting): those still
 * reading are cancelled before anything spawns, those signing are ended, their results dropped; resolves once every one
 * has ended and its signer and temp folder are gone.
 */
export async function cancelSigningChecks(owner: (root: string) => boolean): Promise<void> {
  // No new admission for these owners while they close (HR1's round 2).
  closing.add(owner)
  try {
    const waits: Promise<unknown>[] = []
    // Every operation of theirs, queued, reading or signing: aborted, and waited for to its end.
    for (const a of admitted) {
      if (!owner(a.owner)) continue
      a.abort.abort()
      waits.push(a.settled)
    }
    for (const r of running.values()) if (owner(r.owner)) waits.push(r.done.catch(() => undefined))
    for (const [k, r] of results) if (owner(r.owner)) results.delete(k)
    await Promise.all(waits)
    await endBoundedSpawns((o) => !!o && owner(o))
    for (const [k, r] of results) if (owner(r.owner)) results.delete(k)
  } finally {
    closing.delete(owner)
  }
}

/** The owners being closed now: refused new admissions until their close has ended. */
const closing = new Set<(root: string) => boolean>()

/** A shutdown that can't wait (will-quit): every check aborted, its signer's process ended, its temp folder removed. */
function endSigningNow(): void {
  for (const a of admitted) a.abort.abort()
  endBoundedSpawnsNow()
  for (const dir of liveDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort, as the process exits
    }
  }
}

// Ended with their owner, through the platform-neutral registry (the app never imports this module for it).
onOwnerGone(cancelSigningChecks, endSigningNow)

/** For tests: how many view checks are admitted, in flight and kept now. */
export const viewSigningCounts = (): { admitted: number; running: number; results: number; turns: number } => ({ admitted: admitted.size, running: running.size, results: results.size, turns: turns.size })
