// The signing rules both sides share (HI-1185, HI-2867; SPEC §16.9.5): Combwork's signing check in main (gitSigning.ts)
// and cw-sign.js, the signer agents' sessions run. Pure (Node's path only), because cw-sign.js runs outside the asar
// with only Node's built-ins and Combwork's chunks.

import { delimiter, isAbsolute, join, resolve } from 'path'

/**
 * Where a program name resolves for a commit: a path as given (against its folder), else on its PATH with PATHEXT.
 * `isFile` is the caller's (main's never blocks its thread; cw-sign's, a process of its own, may).
 */
export async function resolveProgramWith(isFile: (p: string) => Promise<boolean>, name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const exts = process.platform === 'win32' ? [...(envGet(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean), ''] : ['']
  const tryAll = async (base: string): Promise<string | null> => {
    for (const ext of exts) if (await isFile(base + ext)) return base + ext
    return null
  }
  if (/[\\/]/.test(name)) return tryAll(isAbsolute(name) ? name : resolve(cwd, name))
  for (const dir of (envGet(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    const found = await tryAll(join(dir, name))
    if (found) return found
  }
  return null
}

/**
 * A signer's words that say it needs someone (a passphrase, a pinentry, an agent with the key unlocked). "No private key
 * found for public key": ssh-keygen given a key's .pub file, whose private half only an agent holds, with none holding it
 * (HI-2867): someone has to load it.
 */
export const NEEDS = /passphrase|pinentry|no gpg-agent|agent.*not running|can't connect to the agent|agent refused|inappropriate ioctl|no tty|cannot open \/dev\/tty|operation cancelled|could not open a connection to your authentication agent|no private key found for public key/i

/** The known installations among `roots` (Git for Windows' folders) and the environment's: Git's gpg and ssh-keygen, GnuPG's (Gpg4win), Windows' OpenSSH. */
export function knownSignerPaths(roots: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const known: string[] = []
  for (const root of roots) known.push(join(root, 'usr', 'bin', 'gpg.exe'), join(root, 'usr', 'bin', 'ssh-keygen.exe'))
  // Read whatever the names' case (a copy of Windows' environment is a plain object: SYSTEMROOT from Git Bash).
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const v = envGet(env, k)
    if (v) known.push(join(v, 'GnuPG', 'bin', 'gpg.exe'))
  }
  const root = envGet(env, 'SystemRoot')
  if (root) known.push(join(root, 'System32', 'OpenSSH', 'ssh-keygen.exe'))
  return known
}

/** Whether a resolved program is one of the known installations. */
export function isKnownSigner(path: string, roots: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const p = resolve(path).toLowerCase()
  return knownSignerPaths(roots, env).some((k) => resolve(k).toLowerCase() === p)
}

/** Git for Windows' root from its exec path (`<root>\<mingw64|ucrt64>\libexec\git-core`). */
export const gitRootOfExecPath = (execPath: string): string => resolve(execPath, '..', '..', '..')

/** The last line of `git config --show-scope --get…`: its scope and value (`--get-regexp`'s value after the key). */
export function lastScoped(out: string, regexp: boolean): { scope: string; value: string } | null {
  const line = out.split(/\r?\n/).filter(Boolean).at(-1)
  if (line === undefined) return null
  const tab = line.indexOf('\t')
  let value = tab < 0 ? line : line.slice(tab + 1)
  if (regexp) value = value.slice(value.indexOf(' ') + 1)
  return { scope: tab < 0 ? '' : line.slice(0, tab), value: value.trim() }
}

// ---- cw-sign: the session's environment and git's call ----

/** The two entries Combwork puts first in a session's GIT_CONFIG_* (HI-2867), in this order. */
export const SIGN_KEYS = ['gpg.program', 'gpg.ssh.program'] as const

/** The session's variables cw-sign reads (set by signerEnv.ts at launch). */
export const SIGN_ENV = {
  /** How many of the first GIT_CONFIG entries are Combwork's (SIGN_KEYS.length). */
  ours: 'CW_SIGN_OURS',
  /** cw-sign.exe's path: the value Combwork's entries hold. */
  self: 'CW_SIGN_SELF',
  /** Combwork's executable, run as Node. */
  exec: 'CW_SIGN_EXEC',
  /** cw-sign.js. */
  script: 'CW_SIGN_JS',
  /** The signer's bound, in ms (the Advanced setting). */
  timeout: 'CW_SIGN_TIMEOUT_MS',
  /** git's arguments, from cw-sign.exe: their count, a colon, then base64 of their UTF-8 joined by NUL. */
  argv: 'CW_SIGN_ARGV',
  /** The caller's own ELECTRON_RUN_AS_NODE, given back to the signer. */
  runAsNode: 'CW_SIGN_RUN_AS_NODE'
} as const

/** git's arguments as cw-sign.exe passed them, or null when the transport is missing or malformed. */
export function decodeArgv(v: string | undefined): string[] | null {
  if (!v) return null
  const colon = v.indexOf(':')
  if (colon < 1) return null
  const n = Number(v.slice(0, colon))
  if (!Number.isInteger(n) || n < 0) return null
  const b64 = v.slice(colon + 1)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null
  const text = Buffer.from(b64, 'base64').toString('utf8')
  const args = n === 0 ? [] : text.split('\0')
  if (n === 0 && text !== '') return null
  return args.length === n ? args : null
}

/** The transport's encoding (cw-sign.exe's, for tests and the dev check). */
export function encodeArgv(args: readonly string[]): string {
  return `${args.length}:${Buffer.from(args.join('\0'), 'utf8').toString('base64')}`
}

/** A variable read whatever its name's case (Windows). */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase())
  return k === undefined ? undefined : env[k]
}

/**
 * The environment without Combwork's own GIT_CONFIG entries, the rest renumbered, so git reads its settings as it would
 * have without Combwork. Only when they are exactly Combwork's: CW_SIGN_OURS is SIGN_KEYS.length and the first entries
 * are SIGN_KEYS holding CW_SIGN_SELF. Anything else drops nothing (`stripped: false`), and the signer git then names is
 * cw-sign itself: the caller refuses rather than guess.
 */
export function withoutOurEntries(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; stripped: boolean } {
  const out: NodeJS.ProcessEnv = {}
  const configKey = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i
  for (const [k, v] of Object.entries(env)) if (!configKey.test(k) && k.toUpperCase() !== SIGN_ENV.ours) out[k] = v
  const keep = (): { env: NodeJS.ProcessEnv; stripped: boolean } => ({ env, stripped: false })
  const self = envGet(env, SIGN_ENV.self)
  const count = Number(envGet(env, 'GIT_CONFIG_COUNT'))
  if (envGet(env, SIGN_ENV.ours) !== String(SIGN_KEYS.length) || !self || !Number.isInteger(count) || count < SIGN_KEYS.length) return keep()
  for (let i = 0; i < SIGN_KEYS.length; i++) {
    if ((envGet(env, `GIT_CONFIG_KEY_${i}`) ?? '').toLowerCase() !== SIGN_KEYS[i] || envGet(env, `GIT_CONFIG_VALUE_${i}`) !== self) return keep()
  }
  const rest = count - SIGN_KEYS.length
  if (rest > 0) out.GIT_CONFIG_COUNT = String(rest)
  for (let i = 0; i < rest; i++) {
    const k = envGet(env, `GIT_CONFIG_KEY_${i + SIGN_KEYS.length}`)
    const v = envGet(env, `GIT_CONFIG_VALUE_${i + SIGN_KEYS.length}`)
    if (k !== undefined) out[`GIT_CONFIG_KEY_${i}`] = k
    if (v !== undefined) out[`GIT_CONFIG_VALUE_${i}`] = v
  }
  return { env: out, stripped: true }
}

/** Whether a program is a cw-sign launcher (this Combwork's or another's, such as the session a dev build was started from). */
export const isSignLauncher = (p: string): boolean => /(^|[\\/])cw-sign\.exe$/i.test(p.trim())

/** Where a session's signer runs from, and its bound: null when it gets none (the switch off, no launcher built). */
export interface SessionSigner {
  /** cw-sign.exe. */
  launcher: string
  /** Combwork's executable, run as Node. */
  exec: string
  /** cw-sign.js. */
  script: string
  timeoutMs: number
}

/**
 * A session's environment with Combwork's signer (HI-2867): its two GIT_CONFIG entries first, so the user's own entries
 * (after them) still win, and the variables cw-sign reads. Entries naming a cw-sign launcher already in the environment
 * (Combwork started from another Combwork's session) are never the user's, and are dropped, with or without a signer:
 * kept, they'd make the session's git run the other Combwork's launcher. Nothing else changes.
 */
export function withSessionSigner(env: Record<string, string>, signer: SessionSigner | null): Record<string, string> {
  const out: Record<string, string> = {}
  const configKey = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i
  for (const [k, v] of Object.entries(env)) if (!configKey.test(k)) out[k] = v
  const theirs: [string, string][] = []
  const n = Number(envGet(env, 'GIT_CONFIG_COUNT'))
  if (Number.isInteger(n) && n > 0) {
    for (let i = 0; i < n; i++) {
      const k = envGet(env, `GIT_CONFIG_KEY_${i}`) ?? ''
      const v = envGet(env, `GIT_CONFIG_VALUE_${i}`) ?? ''
      // A broken entry is git's to refuse, as it would have: kept as it is.
      if (!((SIGN_KEYS as readonly string[]).includes(k.toLowerCase()) && isSignLauncher(v))) theirs.push([k, v])
    }
  } else if (envGet(env, 'GIT_CONFIG_COUNT') !== undefined) {
    // Not a count git takes: left for git to refuse, as before.
    return env
  }
  const all: [string, string][] = [...(signer ? SIGN_KEYS.map((k): [string, string] => [k, signer.launcher]) : []), ...theirs]
  if (all.length) out.GIT_CONFIG_COUNT = String(all.length)
  all.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = k
    out[`GIT_CONFIG_VALUE_${i}`] = v
  })
  if (signer) {
    out[SIGN_ENV.ours] = String(SIGN_KEYS.length)
    out[SIGN_ENV.self] = signer.launcher
    out[SIGN_ENV.exec] = signer.exec
    out[SIGN_ENV.script] = signer.script
    out[SIGN_ENV.timeout] = String(signer.timeoutMs)
  }
  return out
}

/** Which signer git is calling, by its arguments: ssh-keygen's are `-Y <op>`, gpg's the rest. */
export const signerKind = (args: readonly string[]): 'ssh' | 'openpgp' => (args[0] === '-Y' ? 'ssh' : 'openpgp')

/** Whether git's call signs (only those are changed): gpg's detach-sign with a key, ssh-keygen's `-Y sign`. */
export function isSigningCall(args: readonly string[]): boolean {
  if (signerKind(args) === 'ssh') return args[1] === 'sign'
  if (args.some((a) => a === '--verify' || a.startsWith('--verify='))) return false
  return args.some((a) => a === '--detach-sign' || (/^-[a-zA-Z]+$/.test(a) && a.includes('b') && a.includes('s')))
}

/** What a known signer's signing call gets so it never waits for someone: gpg's options before git's arguments, ssh-keygen's environment. */
export const GPG_NO_PROMPT = ['--batch', '--no-tty', '--pinentry-mode', 'error'] as const
