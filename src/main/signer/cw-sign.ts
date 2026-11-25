// cw-sign.js (HI-2867, SPEC §16.9.5): the signer agents' sessions run. Git calls cw-sign.exe (the session's gpg.program
// and gpg.ssh.program, given in its environment only), which starts this with Combwork's executable as Node and git's
// arguments in CW_SIGN_ARGV. It runs the signer git would have run without Combwork, chosen as git chooses it, and:
// - for a known installation's signing call (Git for Windows' gpg or ssh-keygen, GnuPG's, Windows' OpenSSH), so it never
//   waits for someone: gpg with --batch --no-tty --pinentry-mode error, ssh-keygen with SSH_ASKPASS_REQUIRE=never, both
//   with no console of their own (detached: Windows' ssh-keygen otherwise reads the agent's terminal and waits, measured
//   on HI-2867), within the Advanced setting's bound; stdin and stdout relayed byte for byte, stderr passed on as it
//   comes with its end kept to say why it failed;
// - anything else (verification, an unknown signer) exactly as git gave it, as before.
// Signing is never turned off: every failure stays one, with git's own nonzero exit, and an agent message saying why.
// Only Node's built-ins and Combwork's chunks (it runs outside the asar).

import '../../shared/agentText/processDialect'
import { spawn } from 'child_process'
import { closeSync, openSync, readSync, statSync } from 'fs'
import { delimiter, join, resolve } from 'path'
import { agentMsg, say } from '../../shared/agentText'
import { GPG_NO_PROMPT, NEEDS, SIGN_ENV, decodeArgv, envGet, gitRootOfExecPath, isKnownSigner, isSignLauncher, isSigningCall, resolveProgramWith, signerKind, signerRun, withoutOurEntries, type SignerRun } from './signerRules'
import { configuredSigner, gitOf } from './signerPick'

const T = {
  needsSomeone: agentMsg({
    id: 'sign.needsSomeone',
    text: "Combwork: signing this commit needs someone to enter a passphrase or unlock a key, and nobody can in an agent's session, so it failed at once instead of waiting, and the commit wasn't made. Signing stays on: don't commit unsigned or change git's signing settings unless the user says so. Tell the user: their key can sign with nobody there (loaded in ssh-agent, or its passphrase cached by gpg-agent), as Version Control → Branches & remotes → Signing shows.",
    note: "cw-sign's line after the signer's own error (HI-2867), which the agent reads under git's \"failed to sign the data\". Keep Version Control → Branches & remotes → Signing as the window shows it."
  }),
  timedOut: agentMsg({
    id: 'sign.timedOut',
    text: "Combwork: the signer ({program}) didn't finish within {seconds, number} s, so Combwork ended it and the commit wasn't made. Signing stays on: don't commit unsigned or change git's signing settings unless the user says so. Tell the user (the bound is the Advanced setting \"Agents' signer: give up after\").",
    note: 'cw-sign (HI-2867): the signer was ended at its bound. program: its path. Keep the Advanced setting\'s title as Settings shows it.'
  }),
  noArgs: agentMsg({
    id: 'sign.noArgs',
    text: "Combwork's signer wrapper got no usable arguments from git, so it signed nothing and the commit wasn't made. Tell the user; turning off the Advanced setting \"Agents' signed commits never wait for a passphrase\" and restarting the session gives it git's own signer.",
    note: "cw-sign (HI-2867): cw-sign.exe's argument transport was missing or malformed."
  }),
  loop: agentMsg({
    id: 'sign.loop',
    text: "Combwork's signer wrapper couldn't tell which signer git would use without it, so it signed nothing and the commit wasn't made. Tell the user; turning off the Advanced setting \"Agents' signed commits never wait for a passphrase\" and restarting the session gives it git's own signer.",
    note: "cw-sign (HI-2867): Combwork's environment entries weren't as Combwork set them, so git's own signer couldn't be found."
  }),
  unreadable: agentMsg({
    id: 'sign.unreadable',
    text: "Combwork's signer wrapper couldn't read git's signing settings ({detail}), so it signed nothing and the commit wasn't made.",
    note: "cw-sign (HI-2867): git config failed. detail: git's words."
  }),
  notFound: agentMsg({
    id: 'sign.notFound',
    text: "{name} wasn't found, so the commit wasn't signed or made.",
    note: 'cw-sign (HI-2867): the signer (as configured, or git\'s default) isn\'t on the session\'s PATH.'
  }),
  notStarted: agentMsg({
    id: 'sign.notStarted',
    text: "{program} couldn't be started ({detail}), so the commit wasn't signed or made.",
    note: "cw-sign (HI-2867): starting the signer failed. detail: the system's words."
  })
}

/** The bound when the session says none (the Advanced setting's default). */
const DEFAULT_TIMEOUT_MS = 120_000
/** How much of the signer's stderr is kept to say why it failed (it is passed on whole as it comes). */
const KEEP = 64 * 1024
/** How long, after the signer exits, its last output may take to arrive (a process it started may hold the pipes open). */
const DRAIN_MS = 2_000
/** The exit code of a signer ended at its bound: cw-sign.exe then ends what the signer started too (its job). */
const TIMED_OUT = 124

const fail = (text: string, code = 2): never => {
  process.stderr.write(`${text}\n`)
  process.exit(code)
}

const isFile = async (p: string): Promise<boolean> => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** A file's first bytes as text (git reads at most 99 of them for a #! line), or null. */
function head(p: string): string | null {
  try {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(99)
      return buf.subarray(0, readSync(fd, buf, 0, 99, 0)).toString('latin1')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** An interpreter as git looks it up (compat/mingw.c path_lookup): the name with .exe, in PATH's folders in order. */
function findExe(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (envGet(env, 'PATH') ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, /\.exe$/i.test(name) ? name : `${name}.exe`)
    try {
      if (statSync(p).isFile()) return p
    } catch {
      // not here
    }
  }
  return null
}

async function main(): Promise<void> {
  const args = decodeArgv(process.env[SIGN_ENV.argv])
  if (!args) return fail(say(T.noArgs))
  const { env: clean, stripped } = withoutOurEntries(process.env)
  for (const k of [SIGN_ENV.argv, SIGN_ENV.ours, SIGN_ENV.exec, SIGN_ENV.script, SIGN_ENV.timeout]) delete clean[k]
  // The caller's own ELECTRON_RUN_AS_NODE back (cw-sign.exe set it to run this).
  const runAsNode = process.env[SIGN_ENV.runAsNode]
  delete clean[SIGN_ENV.runAsNode]
  if (runAsNode) clean.ELECTRON_RUN_AS_NODE = runAsNode
  else delete clean.ELECTRON_RUN_AS_NODE
  const kind = signerKind(args)
  const git = gitOf(process.env)
  const self = process.env[SIGN_ENV.self] ?? ''
  const set = configuredSigner(git, process.cwd(), clean, kind)
  if (set && typeof set === 'object') return fail(say(T.unreadable, { detail: set.failed }))
  const name = set || (kind === 'ssh' ? 'ssh-keygen' : 'gpg')
  const program = await resolveProgramWith(isFile, name, process.cwd(), clean)
  // Never itself, nor another cw-sign launcher: that would run without end.
  if (!stripped || isSignLauncher(name) || (program && (isSignLauncher(program) || (self && resolve(program).toLowerCase() === resolve(self).toLowerCase())))) return fail(say(T.loop))
  if (!program) return fail(say(T.notFound, { name }))
  const exec = envGet(process.env, 'GIT_EXEC_PATH')
  const known = isSigningCall(args) && isKnownSigner(program, exec ? [gitRootOfExecPath(exec)] : [], clean)
  // Started as git starts it (a .cmd or .bat through cmd, a #! script through its interpreter), its command line quoted
  // as git quotes it (HI-2934): Node's own quoting differs (no quotes around *, ?, { or ', which MSYS2 programs glob).
  const runOf = (a: readonly string[]): SignerRun => signerRun(program, /[\\/]/.test(name) ? name : program, a, head(program), (n) => findExe(n, clean), envGet(clean, 'ComSpec') ?? 'cmd.exe')
  if (!known) {
    // As before: git's arguments, the console it has (cw-sign.exe's, shared), nothing added.
    const run = runOf(args)
    let c: ReturnType<typeof spawn>
    try {
      c = spawn(run.file, run.args, { stdio: 'inherit', env: clean, argv0: run.argv0, windowsVerbatimArguments: true })
    } catch (e) {
      return fail(say(T.notStarted, { program, detail: e instanceof Error ? e.message : String(e) }))
    }
    c.on('error', (e) => fail(say(T.notStarted, { program, detail: e.message })))
    c.on('close', (code) => process.exit(code ?? 1))
    return
  }
  const env: NodeJS.ProcessEnv = kind === 'ssh' ? { ...clean, SSH_ASKPASS_REQUIRE: 'never' } : clean
  const timeoutMs = Number(process.env[SIGN_ENV.timeout]) > 0 ? Number(process.env[SIGN_ENV.timeout]) : DEFAULT_TIMEOUT_MS
  const run = runOf(kind === 'openpgp' ? [...GPG_NO_PROMPT, ...args] : args)
  const c = spawn(run.file, run.args, { stdio: ['pipe', 'pipe', 'pipe'], env, argv0: run.argv0, windowsVerbatimArguments: true, windowsHide: true, detached: true })
  process.stdin.pipe(c.stdin!)
  c.stdin?.on('error', () => undefined)
  c.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
  let tail = ''
  c.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d)
    tail = (tail + d.toString('utf8')).slice(-KEEP)
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // Its own process by its handle; what it started goes with cw-sign.exe's job, kept for this exit code (cw-sign.cs).
    c.kill()
  }, timeoutMs)
  c.on('error', (e) => {
    clearTimeout(timer)
    fail(say(T.notStarted, { program, detail: e.message }))
  })
  // Done at the signer's exit, not its streams' close: a gpg-agent gpg starts may hold its pipes open for as long as it
  // runs. What the signer wrote before exiting is read first, within a short bound.
  const ended = (s: NodeJS.ReadableStream | null): Promise<void> => new Promise((res) => (s ? s.once('end', res).once('error', () => res()) : res()))
  const streams = Promise.all([ended(c.stdout), ended(c.stderr)])
  c.on('exit', (code) => {
    clearTimeout(timer)
    let drained: NodeJS.Timeout | undefined
    void Promise.race([streams, new Promise<void>((res) => (drained = setTimeout(res, DRAIN_MS)))]).then(() => {
      clearTimeout(drained)
      finish(code)
    })
  })
  const finish = (code: number | null): void => {
    if (timedOut) return fail(say(T.timedOut, { program, seconds: Math.round(timeoutMs / 1000) }), TIMED_OUT)
    if (code === 0) process.exit(0)
    if (NEEDS.test(tail)) process.stderr.write(`${say(T.needsSomeone)}\n`)
    process.exit(code ?? 1)
  }
}

void main()
