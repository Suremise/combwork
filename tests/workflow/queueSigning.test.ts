// HI-1185 (SPEC §16.9.5): signing checked before the merge queue signs, and in the Git view. Real ssh-keygen keys in
// temporary repositories for the queue's paths (each commit made is verified); an injected spawn for how the command is
// built (the test-only eligibility seam), never a real agent or a user's key.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { B1, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import type { QueueConfig, QueueGitResult } from '../../src/main/workflow/mergeQueue'
import { checkSigning, knownInstallation, resolveProgram, signerSaid, signingTestHooks, viewSigning, type SignDeps } from '../../src/main/platform/gitSigning'
import { boundedSpawn, endBoundedSpawns } from '../../src/main/platform/boundedSpawn'
import { gitExe } from '../../src/main/gitTool'
import { withLauncherEnv } from '../../src/main/gitWorker'
import { git } from '../../src/main/git'

let env: Env | null = null
afterEach(() => {
  signingTestHooks.eligible = undefined
  env?.close()
  env = null
})

const slash = (p: string): string => p.replace(/\\/g, '/')
const gitEnv = (): NodeJS.ProcessEnv => {
  const use = gitExe()
  return use.launcherEnv ? withLauncherEnv(process.env, use.launcherEnv) : process.env
}
/** Git for Windows' own ssh-keygen, as git finds it (a known installation). */
const sshKeygen = (): string => resolveProgram('ssh-keygen', process.cwd(), gitEnv())!

/** An ed25519 key pair in a folder of its own: with a passphrase when given. */
function keyPair(passphrase = ''): { key: string; pub: string } {
  const key = slash(join(tempDir('key-'), 'id_ed25519'))
  execFileSync(sshKeygen(), ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'combwork-test', '-f', key])
  return { key, pub: `${key}.pub` }
}

/** Pair (Combwork merges), no review, target checked out nowhere, the repository signing with ssh and `key`. */
function signing(key: { key: string; pub: string }, o: Partial<WorkflowOptions> = {}): Env {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], ...o }))
  sh(e.project, 'checkout', '-q', '--detach')
  const allowed = slash(join(tempDir('allowed-'), 'allowed_signers'))
  writeFileSync(allowed, `* ${require('fs').readFileSync(key.pub, 'utf8').trim()}\n`)
  sh(e.project, 'config', 'gpg.format', 'ssh')
  sh(e.project, 'config', 'user.signingkey', key.key)
  sh(e.project, 'config', 'gpg.ssh.allowedSignersFile', allowed)
  sh(e.project, 'config', 'commit.gpgsign', 'true')
  return e
}

/** A builder's own commit in its folder, unsigned (only Combwork's merges are what these tests sign). */
function work(folder: string, files: Record<string, string>, message: string): void {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(folder, f), text)
  sh(folder, 'add', '-A')
  sh(folder, '-c', 'commit.gpgsign=false', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message)
}

async function queued(e: Env, title: string, build: (folder: string) => void) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  build(s.data!.folder as string)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

/** A commit on the target, `main` (the project folder detached), unsigned (it isn't Combwork's). */
function onTarget(e: Env, files: Record<string, string>, message: string): string {
  sh(e.project, 'checkout', '-q', 'main')
  work(e.project, files, message)
  const c = sh(e.project, 'rev-parse', 'HEAD')
  sh(e.project, 'checkout', '-q', '--detach')
  return c
}

/** The queue's config counting its signer runs (the signing check's spawns). */
function counting(): { runs: string[]; cfg: Partial<QueueConfig> } {
  const runs: string[] = []
  return { runs, cfg: { spawn: (file, args, o) => (runs.push(file), boundedSpawn(file, args, o)) } }
}

const verified = (e: Env, rev: string): boolean => {
  try {
    execFileSync('git', ['-C', e.project, 'verify-commit', rev], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('the merge queue checks signing before it signs (HI-1185)', () => {
  it('an ssh key with no passphrase: checked once, the merge commit signed and verified', { timeout: GIT_HEAVY_MS }, async () => {
    const e = signing(keyPair())
    const before = sh(e.project, 'rev-parse', 'main')
    await queued(e, 'A', (f) => work(f, { 'a.txt': 'A\n' }, 'A'))
    const { runs, cfg } = counting()
    expect((await e.queue(cfg).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(runs).toHaveLength(1)
    expect(sh(e.project, 'rev-parse', 'main')).not.toBe(before)
    expect(verified(e, 'main')).toBe(true)
  })

  it('a key with a passphrase: paused signingWaits before any commit, well under the bound; Resume checks again', { timeout: GIT_HEAVY_MS }, async () => {
    const e = signing(keyPair('secret-passphrase-1'))
    const before = sh(e.project, 'rev-parse', 'main')
    await queued(e, 'A', (f) => work(f, { 'a.txt': 'A\n' }, 'A'))
    const { runs, cfg } = counting()
    const t0 = Date.now()
    const out = await e.queue({ ...cfg, signTimeoutMs: 60_000 }).drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'signingWaits' })
    expect(Date.now() - t0).toBeLessThan(30_000)
    expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
    expect(runs).toHaveLength(1)
    e.queue().resume('main')
    await e.queue(cfg).drain('main')
    expect(runs).toHaveLength(2)
  })

  it('strict’s update signs too: checked before it, and paused with a locked key; an unattended update commit verifies', { timeout: GIT_HEAVY_MS }, async () => {
    const locked = keyPair('secret-passphrase-2')
    const e = signing(locked, { strict: true })
    await queued(e, 'A', (f) => work(f, { 'a.txt': 'A\n' }, 'A'))
    onTarget(e, { 'other.txt': 'x\n' }, 'moved on')
    expect((await e.queue().drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'signingWaits' })
    // Unlocked (a key with no passphrase now): the update and the merge both signed.
    const open = keyPair()
    sh(e.project, 'config', 'user.signingkey', open.key)
    writeFileSync(sh(e.project, 'config', 'gpg.ssh.allowedSignersFile'), `* ${require('fs').readFileSync(open.pub, 'utf8').trim()}\n`)
    e.queue().resume('main')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(verified(e, 'main')).toBe(true)
    expect(verified(e, 'main^2')).toBe(true)
  })

  it('rebase and fast-forward: an on-top linear card signs nothing and isn’t checked; a rewritten one is, paused when locked, verified when not', { timeout: GIT_HEAVY_MS }, async () => {
    const e = signing(keyPair('secret-passphrase-3'), { style: 'rebase' })
    await queued(e, 'On top', (f) => work(f, { 'a.txt': 'A\n' }, 'on top'))
    const { runs, cfg } = counting()
    expect((await e.queue(cfg).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(runs).toHaveLength(0)
    await queued(e, 'Behind', (f) => work(f, { 'b.txt': 'B\n' }, 'behind'))
    onTarget(e, { 'other.txt': 'x\n' }, 'moved on')
    const before = sh(e.project, 'rev-parse', 'main')
    expect((await e.queue(cfg).drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'signingWaits' })
    expect(runs).toHaveLength(1)
    expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
    const open = keyPair()
    sh(e.project, 'config', 'user.signingkey', open.key)
    writeFileSync(sh(e.project, 'config', 'gpg.ssh.allowedSignersFile'), `* ${require('fs').readFileSync(open.pub, 'utf8').trim()}\n`)
    e.queue().resume('main')
    expect((await e.queue(cfg).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(verified(e, 'main')).toBe(true)
  })
})

describe('the signing check (HI-1185)', () => {
  /** A recording spawn: the argv each signer run got, answered `reply`. */
  function deps(cwd: string, over: Partial<SignDeps> = {}, reply: Partial<QueueGitResult> = { ok: true, code: 0 }) {
    const ran: { file: string; args: string[]; input?: string }[] = []
    const d: SignDeps = {
      git: async (c, args) => {
        const r = await git(c, args)
        return { ok: r.ok, out: r.out, err: r.err, code: r.code }
      },
      spawn: async (file, args, o) => (ran.push({ file, args, ...(o.input !== undefined ? { input: o.input } : {}) }), { ok: false, out: '', err: '', code: 1, ...reply }),
      cwd,
      who: [],
      env: gitEnv(),
      ...over
    }
    return { d, ran }
  }
  /** A repository of its own, with `config` set locally. */
  function repo(config: Record<string, string> = {}): string {
    const r = slash(tempDir('sign-repo-'))
    sh(r, 'init', '-q')
    for (const [k, v] of Object.entries(config)) sh(r, 'config', '--add', k, v)
    return r
  }
  /** An empty file standing in for a signer: found by its path, eligible only through the test seam. */
  function fakeSigner(name = 'gpg.exe'): string {
    const p = slash(join(tempDir('fake-signer-'), name))
    writeFileSync(p, '')
    signingTestHooks.eligible = (path) => slash(path).toLowerCase() === p.toLowerCase()
    return p
  }

  it('off, x509, unreadable: no signer run', async () => {
    const off = deps(repo())
    expect((await checkSigning(off.d)).status).toEqual({ kind: 'off' })
    const x = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'x509' }))
    expect((await checkSigning(x.d)).status).toMatchObject({ kind: 'notChecked', why: 'x509' })
    const broken = deps(repo(), { git: async () => ({ ok: false, out: '', err: 'fatal: bad config', code: 128 }) })
    expect((await checkSigning(broken.d)).status).toMatchObject({ kind: 'unreadable' })
    expect([...off.ran, ...x.ran, ...broken.ran]).toEqual([])
  })

  it('openpgp: gpg.program and gpg.openpgp.program are one setting (the last git reads wins); no key: the commit’s own identity', async () => {
    const a = fakeSigner('gpg.exe')
    const b = slash(join(tempDir('fake-b-'), 'gpg.exe'))
    writeFileSync(b, '')
    signingTestHooks.eligible = (p) => [a, b].some((x) => x.toLowerCase() === slash(p).toLowerCase())
    // In one file, the later line wins; a command-scope value (the queue's -c) wins over the repository's.
    const r1 = deps(repo({ 'commit.gpgsign': 'true', 'gpg.openpgp.program': a, 'gpg.program': b, 'user.name': 'R', 'user.email': 'r@example.invalid' }))
    await checkSigning(r1.d)
    expect(slash(r1.ran[0].file).toLowerCase()).toBe(b.toLowerCase())
    const r2 = deps(repo({ 'commit.gpgsign': 'true', 'gpg.program': a }), { who: ['-c', `gpg.openpgp.program=${b}`, '-c', 'user.name=Queue Bot', '-c', 'user.email=queue@example.invalid'] })
    const info = await checkSigning(r2.d)
    expect(slash(r2.ran[0].file).toLowerCase()).toBe(b.toLowerCase())
    expect(r2.ran[0].args).toEqual(['--batch', '--no-tty', '--pinentry-mode', 'error', '--no-autostart', '--status-fd=2', '-bsau', 'Queue Bot <queue@example.invalid>'])
    expect(r2.ran[0].input).toContain('Combwork checks that signing works')
    expect(info.status).toEqual({ kind: 'unattended' })
    // gpg.program set while the format is ssh: not ssh's program.
    const k = keyPair()
    const r3 = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'gpg.program': a, 'user.signingkey': k.key }))
    signingTestHooks.eligible = undefined
    await checkSigning(r3.d)
    expect(r3.ran[0].file.toLowerCase()).toContain('ssh-keygen')
  })

  it('a signer Combwork doesn’t run by itself is never invoked: a custom program, a key command, an unconfigured one found first on PATH', async () => {
    const dir = slash(tempDir('custom-'))
    const marker = join(dir, 'ran.txt')
    const script = join(dir, 'ssh-keygen.cmd')
    writeFileSync(script, `@echo ran > "${marker}"\r\n`)
    const custom = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'gpg.ssh.program': script, 'user.signingkey': 'key::ssh-ed25519 AAAA x' }), { spawn: (f, a, o) => boundedSpawn(f, a, o) })
    expect((await checkSigning(custom.d)).status).toMatchObject({ kind: 'notChecked', why: 'program' })
    const viaPath = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'user.signingkey': 'key::ssh-ed25519 AAAA x' }), { env: { ...gitEnv(), PATH: `${dir};${gitEnv().PATH ?? gitEnv().Path ?? ''}` }, spawn: (f, a, o) => boundedSpawn(f, a, o) })
    expect((await checkSigning(viaPath.d)).status).toMatchObject({ kind: 'notChecked', why: 'program' })
    const keyCommand = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'gpg.ssh.defaultKeyCommand': script }), { spawn: (f, a, o) => boundedSpawn(f, a, o) })
    expect((await checkSigning(keyCommand.d)).status).toMatchObject({ kind: 'notChecked', why: 'keyCommand' })
    expect(existsSync(marker)).toBe(false)
    expect(knownInstallation(script)).toBe(false)
    expect(knownInstallation(sshKeygen(), process.env, execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim())).toBe(true)
  })

  it('a hardware ssh key isn’t checked; a real unlocked key signs, a locked one needs someone', async () => {
    const hw = deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'user.signingkey': 'key::sk-ssh-ed25519@openssh.com AAAA x' }))
    expect((await checkSigning(hw.d)).status).toMatchObject({ kind: 'notChecked', why: 'hardware' })
    const real = (k: { key: string }) => deps(repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'user.signingkey': k.key }), { spawn: (f, a, o) => boundedSpawn(f, a, o) })
    expect((await checkSigning(real(keyPair()).d)).status).toEqual({ kind: 'unattended' })
    expect((await checkSigning(real(keyPair('secret-passphrase-4')).d)).status).toMatchObject({ kind: 'needsSomeone', format: 'ssh' })
  })

  it('a signer’s words, classified; a bound reached is never taken for a passphrase', () => {
    const r = (o: Partial<QueueGitResult>): QueueGitResult => ({ ok: false, out: '', err: '', code: 2, ...o })
    expect(signerSaid('openpgp', r({ err: 'gpg: signing failed: No pinentry' }))).toMatchObject({ kind: 'needsSomeone' })
    expect(signerSaid('openpgp', r({ err: 'gpg: no gpg-agent running in this session' }))).toMatchObject({ kind: 'needsSomeone' })
    expect(signerSaid('openpgp', r({ err: 'gpg: skipped "X": No secret key' }))).toMatchObject({ kind: 'cantSign' })
    expect(signerSaid('ssh', r({ err: 'Load key "k": incorrect passphrase supplied to decrypt private key' }))).toMatchObject({ kind: 'needsSomeone' })
    expect(signerSaid('ssh', r({ timedOut: true }))).toEqual({ kind: 'couldNotComplete', format: 'ssh' })
    expect(signerSaid('ssh', r({ ok: true, code: 0 }))).toEqual({ kind: 'unattended' })
  })

  it('a bounded run is ended at its bound, and a workspace closing ends its live checks', async () => {
    const spin = ['-e', 'setInterval(() => {}, 1000)']
    const t0 = Date.now()
    const timed = await boundedSpawn(process.execPath, spin, { cwd: process.cwd(), env: process.env, timeoutMs: 400 })
    expect(timed.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(10_000)
    const running = boundedSpawn(process.execPath, spin, { cwd: process.cwd(), env: process.env, timeoutMs: 30_000, owner: 'C:/proj' })
    endBoundedSpawns((o) => o === 'C:/proj')
    const ended = await running
    expect(ended.ok).toBe(false)
    expect(ended.timedOut).toBeUndefined()
  })

  it('the view’s check is kept a minute while its settings stay; a change to them, or Check again, checks afresh', async () => {
    const k = keyPair()
    const r = repo({ 'commit.gpgsign': 'true', 'gpg.format': 'ssh', 'user.signingkey': k.key })
    const a = await viewSigning(r)
    expect(a.status).toEqual({ kind: 'unattended' })
    expect((await viewSigning(r)).at).toBe(a.at)
    // The key changed to a locked one: checked at once, not a minute later.
    sh(r, 'config', 'user.signingkey', keyPair('secret-passphrase-5').key)
    expect((await viewSigning(r)).status).toMatchObject({ kind: 'needsSomeone' })
    await new Promise((res) => setTimeout(res, 1100))
    const forced = await viewSigning(r, true)
    expect(forced.program?.toLowerCase()).toContain('ssh-keygen')
  })
})
