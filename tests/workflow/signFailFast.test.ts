// HI-2867 (SPEC §16.9.5): agents' own signed commits never wait for a passphrase. Real git commits through the real
// launcher (cw-sign.exe, compiled here from resources/cw-sign/cw-sign.cs with Windows' own csc) and cw-sign.js (bundled
// here from its source), with the session's environment as Combwork gives it (withSessionSigner). Real signers: Git for
// Windows' gpg and ssh-keygen, Windows' OpenSSH ssh-keygen where present, in a test home of their own, never the user's
// keys, agents or settings. Every git run is bounded (HUNG_MS): a hang is a failure, never a wait.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { tempDir } from '../tempDir'
import { withSessionSigner, encodeArgv, SIGN_ENV, type SessionSigner } from '../../src/main/platform/signerRules'
import { configuredSigner } from '../../src/main/platform/signerPick'
// @ts-expect-error: a build script (JavaScript), its one function used here
import { buildSignLauncher, frameworkCsc } from '../../scripts/buildSignLauncher.mjs'

/** The bound of one git run or signer: a hung run, never a wait. */
const HUNG_MS = 60_000
/** How fast a commit that needs someone must fail: seconds, not the minutes a prompt would wait. */
const FAST_MS = 15_000
const win = process.platform === 'win32'
const ROOT = join(__dirname, '..', '..')
const GIT_ROOT = 'C:\\Program Files\\Git'
const GB = join(GIT_ROOT, 'usr', 'bin')
const SYS_KEYGEN = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
const ready = win && !!frameworkCsc() && existsSync(join(GB, 'gpg.exe')) && existsSync(join(GB, 'ssh-keygen.exe'))

const slash = (p: string): string => p.replace(/\\/g, '/')
let dir = ''
let home = ''
let signer: SessionSigner
/** The test's own environment: an allowlist, a home of its own, no system or global git config. */
let base: Record<string, string> = {}

beforeAll(async () => {
  if (!ready) return
  dir = tempDir('sign-')
  home = join(dir, 'h')
  mkdirSync(join(home, '.gnupg'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '')
  const launcher = buildSignLauncher(join(dir, 'bin'), () => undefined)
  const script = join(dir, 'cw-sign.js')
  await build({ entryPoints: [join(ROOT, 'src', 'main', 'platform', 'cw-sign.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: script, logLevel: 'silent' })
  signer = { launcher, exec: process.execPath, script, timeoutMs: HUNG_MS }
  for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive', 'ProgramData']) if (process.env[k]) base[k] = process.env[k]!
  // Git's own folders first, as a session started from Git's installation finds gpg (git adds them for its children).
  base = { ...base, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') }
}, HUNG_MS)

afterAll(() => {
  if (!ready) return
  spawnSync(join(GB, 'gpgconf.exe'), ['--kill', 'gpg-agent'], { env: base, windowsHide: true, timeout: HUNG_MS })
})

/** A session's environment with Combwork's signer (or none). */
const session = (s: SessionSigner | null = signer, extra: Record<string, string> = {}): Record<string, string> => withSessionSigner({ ...base, ...extra }, s)

function git(cwd: string, args: string[], env: Record<string, string> = base, input?: string): SpawnSyncReturns<string> {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS, input: input ?? '' })
}

/** A repository committing as Test, signing with `format` and `key`. */
function repo(format: 'ssh' | 'openpgp', key: string): string {
  const r = join(tempDir('r-'), 'repo')
  mkdirSync(r)
  for (const a of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['config', 'commit.gpgsign', 'true'], ['config', 'gpg.format', format], ['config', 'user.signingkey', key]]) expect(git(r, a).status).toBe(0)
  return r
}

/** A signed commit attempt in `r`, timed. */
function commit(r: string, env: Record<string, string>, message = 'change'): { status: number | null; err: string; ms: number; signal: string | null } {
  writeFileSync(join(r, `${message}.txt`), message)
  git(r, ['add', '-A'])
  const t = Date.now()
  const c = git(r, ['commit', '-q', '-m', message], env)
  return { status: c.status, err: c.stderr, ms: Date.now() - t, signal: c.signal }
}

const heads = (r: string): number => Number(git(r, ['rev-list', '--count', '--all']).stdout.trim() || '0')

function sshKey(keygen: string, passphrase: string, name = 'id'): string {
  const k = join(tempDir('k-'), name)
  const g = spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'test', '-f', k], { env: base, windowsHide: true, timeout: HUNG_MS })
  expect(g.status).toBe(0)
  return k
}

function allowSigners(r: string, pub: string): void {
  const f = join(tempDir('a-'), 'allowed')
  writeFileSync(f, `test@example.invalid ${readFileSync(pub, 'utf8').trim()}\n`)
  git(r, ['config', 'gpg.ssh.allowedSignersFile', slash(f)])
}

const NEEDS_LINE = "nobody can in an agent's session"
const gpg = join(GB, 'gpg.exe')
const gpgRun = (args: string[], input?: string): SpawnSyncReturns<string> => spawnSync(gpg, args, { env: base, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS, input: input ?? '' })
const fpr = (uid: string): string => gpgRun(['--list-secret-keys', '--with-colons', uid]).stdout.split('\n').find((l) => l.startsWith('fpr'))!.split(':')[9]

describe.skipIf(!ready)('ssh signing through cw-sign', () => {
  it("fails at once, saying why, when Git for Windows' ssh-keygen would need a passphrase; nothing is committed", () => {
    const r = repo('ssh', slash(sshKey(join(GB, 'ssh-keygen.exe'), 'secret')))
    const c = commit(r, session())
    expect(c.status).not.toBe(0)
    expect(c.ms).toBeLessThan(FAST_MS)
    expect(c.err).toContain(NEEDS_LINE)
    expect(heads(r)).toBe(0)
  })

  it.skipIf(!existsSync(SYS_KEYGEN))("fails at once with Windows' own ssh-keygen too, which reads the console when it has one (measured: it waits)", () => {
    // Its own key: it refuses a key file another tool made when the folder's permissions are wider than it allows.
    const r = repo('ssh', slash(sshKey(SYS_KEYGEN, 'secret')))
    git(r, ['config', 'gpg.ssh.program', slash(SYS_KEYGEN)])
    const c = commit(r, session())
    expect(c.signal).toBeNull()
    expect(c.ms).toBeLessThan(FAST_MS)
    expect(c.err).toContain(NEEDS_LINE)
    expect(heads(r)).toBe(0)
  })

  it('signs with a key that needs nobody, at a path holding spaces, &, % and ^ (git → launcher → shim → signer, losslessly), and verification runs as before', () => {
    const k = sshKey(join(GB, 'ssh-keygen.exe'), '', 'k ey&x%PATH%^y')
    const r = repo('ssh', slash(k))
    allowSigners(r, `${k}.pub`)
    const c = commit(r, session())
    expect(c.err).toBe('')
    expect(c.status).toBe(0)
    const v = git(r, ['verify-commit', 'HEAD'], session())
    expect(v.status).toBe(0)
    expect(v.stderr).toContain('Good "git" signature')
  })

  it("signs with a passphrase key loaded in ssh-agent (a private agent, never the user's)", () => {
    const k = sshKey(join(GB, 'ssh-keygen.exe'), 'secret')
    const sock = join(tempDir('ag-'), 's')
    const started = spawnSync(join(GB, 'ssh-agent.exe'), ['-s', '-a', sock], { env: base, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS })
    const pid = /SSH_AGENT_PID=(\d+)/.exec(started.stdout)?.[1]
    const authSock = /SSH_AUTH_SOCK=([^;]+);/.exec(started.stdout)?.[1]
    expect(pid && authSock).toBeTruthy()
    const agentEnv = { SSH_AUTH_SOCK: authSock!, SSH_AGENT_PID: pid! }
    try {
      const ask = join(tempDir('ap-'), 'ask')
      writeFileSync(ask, '#!/bin/sh\necho secret\n')
      const add = spawnSync(join(GB, 'ssh-add.exe'), [k], { env: { ...base, ...agentEnv, SSH_ASKPASS: slash(ask), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'none' }, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS, input: '' })
      expect(add.status, add.stderr).toBe(0)
      const r = repo('ssh', slash(`${k}.pub`))
      const c = commit(r, session(signer, agentEnv))
      expect(c.err).toBe('')
      expect(c.status).toBe(0)
    } finally {
      spawnSync(join(GB, 'ssh-agent.exe'), ['-k'], { env: { ...base, ...agentEnv }, windowsHide: true, timeout: HUNG_MS })
    }
  })

  it('runs an unknown signer exactly as git gave it (nothing added, no message of its own)', () => {
    const r = repo('ssh', 'unused')
    // Node as the "signer": it refuses git's first argument, which shows the arguments arrived as git gave them.
    git(r, ['config', 'gpg.ssh.program', slash(process.execPath)])
    const c = commit(r, session())
    expect(c.status).not.toBe(0)
    expect(c.err).toMatch(/bad option: -Y/)
    expect(c.err).not.toContain('Combwork')
  })

  it("refuses, signing nothing, when the session's entries aren't exactly Combwork's (never a guess, never unsigned)", () => {
    const r = repo('ssh', slash(sshKey(join(GB, 'ssh-keygen.exe'), '')))
    const c = commit(r, { ...session(), [SIGN_ENV.ours]: '3' })
    expect(c.status).not.toBe(0)
    expect(c.err).toContain("couldn't tell which signer git would use")
    expect(heads(r)).toBe(0)
  })
})

describe.skipIf(!ready)('gpg signing through cw-sign', () => {
  let key = ''
  let open = ''
  beforeAll(() => {
    expect(gpgRun(['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'secret', '--quick-gen-key', 'Test <test@example.invalid>', 'ed25519', 'sign', 'never']).status).toBe(0)
    expect(gpgRun(['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key', 'Open <open@example.invalid>', 'ed25519', 'sign', 'never']).status).toBe(0)
    key = fpr('test@example.invalid')
    open = fpr('open@example.invalid')
    spawnSync(join(GB, 'gpgconf.exe'), ['--kill', 'gpg-agent'], { env: base, windowsHide: true, timeout: HUNG_MS })
  }, HUNG_MS)

  it("fails at once, saying why, when the passphrase isn't cached; the gpg-agent gpg started stays (a finished run ends nothing)", () => {
    const r = repo('openpgp', key)
    const c = commit(r, session())
    expect(c.status).not.toBe(0)
    expect(c.ms).toBeLessThan(FAST_MS)
    expect(c.err).toMatch(/No pinentry/)
    expect(c.err).toContain(NEEDS_LINE)
    expect(heads(r)).toBe(0)
    const alive = spawnSync(join(GB, 'gpg-connect-agent.exe'), ['--no-autostart', '/bye'], { env: base, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS })
    expect(alive.status, alive.stderr).toBe(0)
  })

  it("signs once the passphrase is cached: gpg reads git's whole payload after its end (stdin's end isn't a cancel), and verifies", () => {
    expect(gpgRun(['--batch', '--pinentry-mode', 'loopback', '--passphrase', 'secret', '-u', key, '-bsa'], 'warm').status).toBe(0)
    const r = repo('openpgp', key)
    const c = commit(r, session())
    expect(c.err).toBe('')
    expect(c.status).toBe(0)
    expect(git(r, ['log', '-1', '--format=%G?'], session()).stdout.trim()).toBe('G')
    expect(git(r, ['verify-commit', 'HEAD'], session()).status).toBe(0)
  })

  it('signs with a key that needs no passphrase', () => {
    const r = repo('openpgp', open)
    const c = commit(r, session())
    expect(c.err).toBe('')
    expect(c.status).toBe(0)
  })

  it("ends a signer at the Advanced setting's bound and says so (not a passphrase)", () => {
    const r = repo('openpgp', open)
    const c = commit(r, session({ ...signer, timeoutMs: 1 }))
    expect(c.status).not.toBe(0)
    expect(c.err).toContain("didn't finish within")
    expect(c.err).not.toContain(NEEDS_LINE)
  })
})

describe.skipIf(!ready)('which signer git would run without Combwork', () => {
  const gitExe = 'git'
  const clean = (extra: Record<string, string> = {}): Record<string, string> => ({ ...base, ...extra })
  it('takes the last of gpg.program and gpg.openpgp.program, in either order and across scopes', () => {
    const r = repo('openpgp', 'k')
    git(r, ['config', 'gpg.program', 'A'])
    git(r, ['config', 'gpg.openpgp.program', 'B'])
    expect(configuredSigner(gitExe, r, clean(), 'openpgp')).toBe('B')
    // The other order: gpg.openpgp.program's section first, gpg.program's after it.
    const r2 = repo('openpgp', 'k')
    git(r2, ['config', 'gpg.openpgp.program', 'B'])
    writeFileSync(join(r2, '.git', 'config'), `${readFileSync(join(r2, '.git', 'config'), 'utf8')}[gpg]
	program = C
`)
    expect(configuredSigner(gitExe, r2, clean(), 'openpgp')).toBe('C')
    writeFileSync(join(home, '.gitconfig'), '[gpg "openpgp"]\n\tprogram = G\n')
    try {
      expect(configuredSigner(gitExe, r2, clean(), 'openpgp')).toBe('C')
      expect(configuredSigner(gitExe, r2, clean({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.openpgp.program', GIT_CONFIG_VALUE_0: 'E' }), 'openpgp')).toBe('E')
      expect(configuredSigner(gitExe, r2, clean({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.program', GIT_CONFIG_VALUE_0: 'F' }), 'openpgp')).toBe('F')
    } finally {
      writeFileSync(join(home, '.gitconfig'), '')
    }
  })
  it("reads gpg.ssh.program, unset as none, and the user's own environment entry over the repository's", () => {
    const r = repo('ssh', 'k')
    expect(configuredSigner(gitExe, r, clean(), 'ssh')).toBeNull()
    git(r, ['config', 'gpg.ssh.program', 'S'])
    expect(configuredSigner(gitExe, r, clean(), 'ssh')).toBe('S')
    expect(configuredSigner(gitExe, r, clean({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.ssh.program', GIT_CONFIG_VALUE_0: 'U' }), 'ssh')).toBe('U')
  })
})

describe.skipIf(!ready)('the launcher', () => {
  /** A recorder in place of cw-sign.js: what the launcher handed on, then `exit` (or held, with a detached child). */
  function recorder(): { script: string; out: string } {
    const d = tempDir('rec-')
    const script = join(d, 'rec.js')
    const out = join(d, 'out.json')
    writeFileSync(
      script,
      [
        "const fs = require('fs'), { spawn } = require('child_process')",
        'const chunks = []',
        "process.stdin.on('data', (c) => chunks.push(c))",
        "process.stdin.on('end', () => {",
        `  const rec = { argv: process.env.${SIGN_ENV.argv}, stdin: Buffer.concat(chunks).toString('base64'), runAsNode: process.env.ELECTRON_RUN_AS_NODE, pid: process.pid }`,
        "  if (process.env.REC_HOLD) rec.child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }).pid",
        `  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(rec))`,
        '  if (!process.env.REC_HOLD) process.exit(Number(process.env.REC_EXIT || 0))',
        "  else setInterval(() => {}, 1000)",
        '})'
      ].join('\n')
    )
    return { script, out }
  }
  const read = (out: string): { argv: string; stdin: string; runAsNode: string; pid: number; child?: number } => JSON.parse(readFileSync(out, 'utf8'))

  it("hands git's arguments and stdin on byte for byte: quotes, %, ^, & and spaces", () => {
    const rec = recorder()
    const r = repo('openpgp', 'a"b %PATH% ^& c')
    writeFileSync(join(r, 'f.txt'), 'f')
    git(r, ['add', '-A'])
    const when = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
    git(r, ['commit', '-q', '-m', 'm'], { ...session({ ...signer, script: rec.script }), ...when })
    const got = read(rec.out)
    const tree = git(r, ['write-tree']).stdout.trim()
    expect(got.argv).toBe(encodeArgv(['--status-fd=2', '-bsau', 'a"b %PATH% ^& c']))
    expect(Buffer.from(got.stdin, 'base64').toString('utf8')).toBe(`tree ${tree}\nauthor Test <test@example.invalid> 1767225600 +0000\ncommitter Test <test@example.invalid> 1767225600 +0000\n\nm\n`)
    expect(got.runAsNode).toBe('1')
  })

  it("returns the script's own exit code", () => {
    const rec = recorder()
    const run = spawnSync(signer.launcher, ['-Y', 'sign'], { env: { ...session({ ...signer, script: rec.script }), REC_EXIT: '7' }, windowsHide: true, timeout: HUNG_MS, input: '' })
    expect(run.status).toBe(7)
    expect(read(rec.out).argv).toBe(encodeArgv(['-Y', 'sign']))
    expect(spawnSync(signer.launcher, [], { env: { ...session({ ...signer, script: rec.script }), REC_EXIT: '0' }, windowsHide: true, timeout: HUNG_MS, input: '' }).status).toBe(0)
    expect(read(rec.out).argv).toBe('0:')
  })

  it('refuses without its variables, starting nothing', () => {
    const run = spawnSync(signer.launcher, ['x'], { env: base, encoding: 'utf8', windowsHide: true, timeout: HUNG_MS })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('CW_SIGN_EXEC or CW_SIGN_JS is not set')
  })

  it('ended (its session ending its tree), takes what it started with it, detached or not', async () => {
    const rec = recorder()
    const l = spawn(signer.launcher, ['x'], { env: { ...session({ ...signer, script: rec.script }), REC_HOLD: '1' }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    l.stdin.end()
    await vi.waitFor(() => expect(existsSync(rec.out)).toBe(true), { timeout: HUNG_MS, interval: 50 })
    const { pid, child } = read(rec.out)
    const alive = (p: number): boolean => {
      try {
        process.kill(p, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(pid) && alive(child!)).toBe(true)
    l.kill()
    await vi.waitFor(() => expect([alive(pid), alive(child!)]).toEqual([false, false]), { timeout: HUNG_MS, interval: 50 })
  })
})
