// jj's bounded runner and its pinned version (HI-2793's J0), against a fake jj (a script node runs): the version's
// states, the read-only prefix and environment, the output cap, the time limit, cancellation (the process ended), a
// missing tool, and that none of those is ever taken for jj's answer (SPEC §16.3.6 rule 3). The real jj's cases are
// jjReal.test.ts's.
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'
import { compareJjVersions, jjRunnable, jjSupported, jjToolOf, parseJjVersion, TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner, JJ_NO_EDITOR, JJ_PREFIX, JJ_READ, jjOnPath, storeGatedHistory, storeGitGated, storeKeyOf, workspaceGateKeys } from '../src/main/platform/jjRunner'
import { jjFileGate } from '../src/main/platform/jjFileGate'
import { runJj } from '../src/main/platform/jjProcess'
import testedVcs from '../resources/tested-vcs.json'
import { tempDir } from './tempDir'

const dir = tempDir('jj-runner-')
const fake = join(dir, 'fake-jj.cjs')
writeFileSync(
  fake,
  `const fs = require('fs')
const args = process.argv.slice(2)
const say = () => process.stdout.write(process.env.FAKE_JJ_SAYS ?? 'jj 0.47.1-d16ee1fc88a72c54142241b079a34bbf3b033bc0\\n')
if (args[0] === '--version' && process.env.FAKE_JJ_VERSION_STARTED) {
  // Held at a barrier: says it started, then waits for the test's release before it answers.
  fs.writeFileSync(process.env.FAKE_JJ_VERSION_STARTED, String(process.pid))
  setInterval(() => { if (fs.existsSync(process.env.FAKE_JJ_RELEASE)) { say(); process.exit(0) } }, 20)
}
else if (args[0] === '--version' && process.env.FAKE_JJ_VERSION_HANG) { say(); setInterval(() => {}, 1000) }
else if (args[0] === '--version') { say(); process.exit(Number(process.env.FAKE_JJ_VERSION_EXIT ?? 0)) }
else {
if (process.env.FAKE_JJ_PID) fs.writeFileSync(process.env.FAKE_JJ_PID, String(process.pid))
const mode = process.env.FAKE_JJ_MODE
if (mode === 'flood') { const chunk = 'x'.repeat(64 * 1024); const go = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', go) }; go() }
else if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'tree') { const c = require('child_process').spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.FAKE_JJ_CHILD, String(process.pid)); setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000) }
else if (mode === 'stdin') { let got = ''; process.stdin.on('data', (d) => (got += d)); process.stdin.on('end', () => { process.stdout.write('read:' + got); process.exit(3) }) }
else { process.stdout.write(JSON.stringify({ args, editor: process.env.JJ_EDITOR, prompt: process.env.GIT_TERMINAL_PROMPT, cwd: process.cwd() })); process.exit(Number(process.env.FAKE_JJ_EXIT ?? 0)) }
}
`
)
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ SYSTEMROOT: process.env.SYSTEMROOT, PATH: '', ...extra })
/** A folder laid out as a jj workspace (not colocated) as far as the gate's keys read it: `.jj/repo/store` naming a Git store. */
const workspace = (): string => {
  const ws = tempDir('jj-runner-ws-')
  const store = join(ws, '.jj', 'repo', 'store')
  mkdirSync(join(store, 'git'), { recursive: true })
  writeFileSync(join(store, 'type'), 'git')
  writeFileSync(join(store, 'git_target'), 'git')
  writeFileSync(join(store, 'git', 'HEAD'), 'ref: refs/heads/main\n')
  return ws
}
const runner = (extra: Record<string, string> = {}) => createJjRunner({ exe: process.execPath, before: [fake], env: env(extra), here: true })
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the pinned jj version (resources/tested-vcs.json)', () => {
  it('pins one version, with the official build it was tested on', () => {
    expect(TESTED_JJ).toEqual(testedVcs.jj)
    expect(TESTED_JJ.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(TESTED_JJ.download.url).toBe(`https://github.com/jj-vcs/jj/releases/download/v${TESTED_JJ.version}/jj-v${TESTED_JJ.version}-x86_64-pc-windows-msvc.zip`)
    expect(TESTED_JJ.download.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(TESTED_JJ.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reads jj --version, and what each version means against the pinned one', () => {
    expect(parseJjVersion('jj 0.47.1-d16ee1fc88a72c54142241b079a34bbf3b033bc0\n')).toBe('0.47.1')
    expect(parseJjVersion('jj 0.48.0\n')).toBe('0.48.0')
    expect(parseJjVersion('git version 2.56.0')).toBeNull()
    expect(compareJjVersions('0.47.1', '0.47.10')).toBeLessThan(0)
    expect(jjToolOf('0.47.1', 'C:\\jj.exe', '0.47.1')).toEqual({ state: 'ok', version: '0.47.1', path: 'C:\\jj.exe' })
    expect(jjToolOf('0.46.0', undefined, '0.47.1')).toEqual({ state: 'old', version: '0.46.0' })
    expect(jjToolOf('0.48.0', undefined, '0.47.1')).toEqual({ state: 'untested', version: '0.48.0' })
    // Only the pinned version is trusted; a newer one runs (for a report), an older one doesn't.
    expect([jjSupported(jjToolOf('0.47.1', 'x', '0.47.1')), jjRunnable(jjToolOf('0.47.1', 'x', '0.47.1'))]).toEqual([true, true])
    expect([jjSupported(jjToolOf('0.48.0', 'x', '0.47.1')), jjRunnable(jjToolOf('0.48.0', 'x', '0.47.1'))]).toEqual([false, true])
    expect([jjSupported(jjToolOf('0.46.0', 'x', '0.47.1')), jjRunnable(jjToolOf('0.46.0', 'x', '0.47.1'))]).toEqual([false, false])
  })
})

describe("jj's runner", () => {
  it('checks the tool once at a time, and runs reads with no pager, colour, snapshot, stale update, editor, monitor or prompt', async () => {
    const r = runner()
    const [a, b] = await Promise.all([r.readiness(), r.readiness()])
    expect(a).toEqual({ state: 'ok', version: '0.47.1', path: process.execPath })
    expect(b).toBe(a)
    const res = await r.run(dir, ['log', '-r', '@'])
    expect(res.ok).toBe(true)
    const said = JSON.parse(res.out)
    expect(said.args).toEqual([...JJ_PREFIX, ...JJ_READ, 'log', '-r', '@'])
    expect(said.args).toEqual(expect.arrayContaining(['--no-pager', '--color=never', '--ignore-working-copy', '--config=snapshot.auto-update-stale=false', '--config=fsmonitor.backend="none"', `--config=ui.editor="${JJ_NO_EDITOR}"`, `--config=ui.diff-editor="${JJ_NO_EDITOR}"`, `--config=ui.merge-editor="${JJ_NO_EDITOR}"`]))
    expect(said.editor).toBe(JJ_NO_EDITOR)
    expect(said.prompt).toBe('0')
    expect(said.cwd.toLowerCase()).toBe(dir.toLowerCase())
    // A write is asked for by name, in a jj workspace (its gate's keys come from its files, HI-2918).
    const said2 = JSON.parse((await r.run(workspace(), ['describe'], { write: true })).out)
    expect(said2.args).toEqual([...JJ_PREFIX, 'describe'])
  })

  it("a write takes the gate over its workspace's files: it waits for a reader holding it, runs its recheck under it, refuses with no keys (HI-2918)", async () => {
    const ws = workspace()
    const keys = (await workspaceGateKeys(ws))!
    expect(keys.root.startsWith('root:') && keys.store.startsWith('store:')).toBe(true)
    const pid = join(tempDir('jj-runner-gate-'), 'pid')
    const r = runner({ FAKE_JJ_PID: pid })
    // A reader of its checkout holds the gate: the write waits, nothing started.
    const reader = await jjFileGate.acquire([keys.root], 'shared')
    let ran = false
    const write = r.run(ws, ['new'], { write: true }).then((x) => ((ran = true), x))
    // Its admission asked for once its keys are read: then it waits behind the reader.
    await expect.poll(() => jjFileGate.writing(keys.root), { timeout: 20_000 }).toBe(true)
    expect([ran, existsSync(pid)]).toEqual([false, false])
    reader.release()
    expect((await write).ok).toBe(true)
    expect(jjFileGate.size).toBe(0)
    // A recheck that refuses: nothing runs; one that reads the workspace's checkout reads through its ticket.
    rmSync(pid, { force: true })
    const no = await r.run(ws, ['new'], { write: true, recheck: () => 'lost its lease' })
    expect(no).toMatchObject({ ok: false, code: -1, refused: 'lost its lease' })
    expect(existsSync(pid)).toBe(false)
    const yes = await r.run(ws, ['new'], { write: true, recheck: () => jjFileGate.read([keys.root], async () => null) })
    expect(yes.ok).toBe(true)
    expect((await r.run(ws, ['new'], { write: true, recheck: () => Promise.reject(new Error('boom')) })).refused).toMatch(/boom/)
    // Not in a jj workspace: no keys, so nothing runs.
    expect((await r.run(tempDir('jj-runner-nows-'), ['new'], { write: true })).refused).toMatch(/keys/)
    expect(jjFileGate.size).toBe(0)
  })

  it('a write cancelled while it runs keeps its admission until its process has gone; one cancelled while queued never runs (HI-2918)', async () => {
    const ws = workspace()
    const keys = (await workspaceGateKeys(ws))!
    const pid = join(tempDir('jj-runner-gate-'), 'pid')
    const ac = new AbortController()
    const running = runner({ FAKE_JJ_MODE: 'hang', FAKE_JJ_PID: pid }).run(ws, ['new'], { write: true, signal: ac.signal, timeout: 60_000 })
    await expect.poll(() => existsSync(pid), { timeout: 20_000 }).toBe(true)
    const proc = Number(readFileSync(pid, 'utf8'))
    let readerIn = false
    const reader = jjFileGate.read([keys.root], async () => {
      readerIn = true
      // Its process has gone by the time a reader gets in.
      return alive(proc)
    })
    ac.abort()
    expect(await running).toMatchObject({ notRun: 'cancelled' })
    expect(await reader).toBe(false)
    expect(readerIn).toBe(true)
    // Queued behind a reader, then cancelled: never runs.
    const pid2 = join(tempDir('jj-runner-gate-'), 'pid')
    const held = await jjFileGate.acquire([keys.root], 'shared')
    const ac2 = new AbortController()
    const queued = runner({ FAKE_JJ_PID: pid2 }).run(ws, ['new'], { write: true, signal: ac2.signal })
    await new Promise((res) => setImmediate(res))
    ac2.abort()
    expect(await queued).toMatchObject({ notRun: 'cancelled' })
    held.release()
    expect(existsSync(pid2)).toBe(false)
    expect(jjFileGate.size).toBe(0)
  })

  it("gives jj's own exit code as its answer, and its standard input closed after what it is given", async () => {
    const r = runner({ FAKE_JJ_EXIT: '1' })
    const no = await r.run(dir, ['root'])
    expect(no).toMatchObject({ ok: false, code: 1 })
    expect(no.notRun).toBeUndefined()
    const read = await runner({ FAKE_JJ_MODE: 'stdin' }).run(dir, ['x'], { input: 'abc' })
    expect(read).toMatchObject({ code: 3, out: 'read:abc' })
    // Nothing given: the end at once, so a prompt reads it rather than waiting.
    expect(await runner({ FAKE_JJ_MODE: 'stdin' }).run(dir, ['x'], { timeout: 10_000 })).toMatchObject({ code: 3, out: 'read:' })
  })

  it('ends a command whose output passes the cap: not an answer', async () => {
    const res = await runner({ FAKE_JJ_MODE: 'flood' }).run(dir, ['log'], { maxOutput: 100_000, timeout: 20_000 })
    expect(res).toMatchObject({ ok: false, code: -1, notRun: 'maxOutput' })
    expect(res.buf.length).toBeLessThanOrEqual(100_000)
  })

  it('ends a command past its time limit: not an answer, and the process is gone', async () => {
    const pid = join(tempDir('jj-runner-pid-'), 'pid')
    const res = await runner({ FAKE_JJ_MODE: 'hang', FAKE_JJ_PID: pid }).run(dir, ['log'], { timeout: 500 })
    expect(res).toMatchObject({ ok: false, code: -1, notRun: 'timedOut', timedOut: true })
    expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
  })

  it('cancels a command under way: the process is ended and the result says cancelled, never an answer', async () => {
    const pid = join(tempDir('jj-runner-pid-'), 'pid')
    const ac = new AbortController()
    const running = runner({ FAKE_JJ_MODE: 'hang', FAKE_JJ_PID: pid }).run(dir, ['log'], { signal: ac.signal, timeout: 60_000 })
    await expect.poll(() => existsSync(pid), { timeout: 20_000 }).toBe(true)
    ac.abort()
    const res = await running
    expect(res).toMatchObject({ ok: false, code: -1, notRun: 'cancelled', cancelled: true })
    expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
  })

  it('starts nothing for a command cancelled before it starts', async () => {
    const pid = join(tempDir('jj-runner-pid-'), 'pid')
    const r = runner({ FAKE_JJ_PID: pid })
    await r.readiness()
    const ac = new AbortController()
    ac.abort()
    expect(await r.run(dir, ['log'], { signal: ac.signal })).toMatchObject({ code: -1, cancelled: true })
    expect(existsSync(pid)).toBe(false)
  })

  it('says jj is missing when it is on no PATH folder, and runs nothing', async () => {
    expect(jjOnPath({ PATH: dir })).toBeNull()
    const r = createJjRunner({ env: env({ PATH: dir }), here: true })
    expect(await r.readiness()).toEqual({ state: 'missing' })
    expect(r.problem()).toMatch(/isn't installed/)
    expect(await r.run(dir, ['root'])).toMatchObject({ ok: false, code: -1, missing: true })
  })

  it('says an executable that is gone is missing, not a failure of the repository', async () => {
    const r = createJjRunner({ exe: join(dir, 'no-such-jj.exe'), env: env(), here: true })
    expect(await r.readiness()).toEqual({ state: 'missing' })
    const o = await runJj({ exe: join(dir, 'no-such-jj.exe'), cwd: dir, args: [], env: env(), maxOutput: 1000, timeout: 5000 })
    expect(o.end).toMatchObject({ notRun: 'missing' })
    // A working folder that isn't there is a failure, not jj missing.
    const p = await runJj({ exe: process.execPath, cwd: join(dir, 'gone'), args: ['-e', ''], env: env(), maxOutput: 1000, timeout: 5000 })
    expect(p.end).toMatchObject({ notRun: 'failed' })
  })

  it('refuses to run a jj older than the pinned one, and says why; a newer one runs, untested', async () => {
    const old = runner({ FAKE_JJ_SAYS: 'jj 0.40.0\n' })
    expect(await old.readiness()).toMatchObject({ state: 'old', version: '0.40.0' })
    expect(old.problem()).toContain(TESTED_JJ.version)
    expect(await old.run(dir, ['root'])).toMatchObject({ ok: false, code: -1, notRun: 'old' })
    const newer = runner({ FAKE_JJ_SAYS: 'jj 9.0.0\n' })
    expect(await newer.readiness()).toEqual({ state: 'untested', version: '9.0.0', path: process.execPath })
    expect((await newer.run(dir, ['root'])).ok).toBe(true)
  })

  it("takes an answer it can't read as unknown, with jj's words", async () => {
    const r = runner({ FAKE_JJ_SAYS: 'something else\n' })
    expect(await r.readiness()).toMatchObject({ state: 'unknown', error: expect.stringContaining('something else') })
    expect(r.problem()).toMatch(/Couldn't check Jujutsu/)
  })

  it('never takes a version printed by a check that failed, timed out or was capped for the tool (HR2, round 1)', async () => {
    // A valid-looking version, then a nonzero exit.
    expect(await runner({ FAKE_JJ_VERSION_EXIT: '7' }).readiness()).toMatchObject({ state: 'unknown' })
    // A valid-looking version, then no exit before the check's time limit.
    const hung = createJjRunner({ exe: process.execPath, before: [fake], env: env({ FAKE_JJ_VERSION_HANG: '1' }), here: true, versionTimeout: 500 })
    expect(await hung.readiness()).toMatchObject({ state: 'unknown', error: 'jj --version took too long' })
    // Nor is anything run with it.
    expect(await hung.run(dir, ['root'], { timeout: 2000 })).toMatchObject({ ok: false, code: -1 })
  })
})

/**
 * HR2's round 1 race: shutdown while a run waits on the tool's check. The fake's `--version` says it started, then
 * waits at a barrier the test releases only after shutdown has returned; nothing may start after shutdown.
 */
async function shutdownWhileChecking(make: (extra: Record<string, string>) => ReturnType<typeof createJjRunner>): Promise<void> {
  const probe = tempDir('jj-runner-barrier-')
  const [started, release, pid] = [join(probe, 'started'), join(probe, 'release'), join(probe, 'pid')]
  const r = make({ FAKE_JJ_VERSION_STARTED: started, FAKE_JJ_RELEASE: release, FAKE_JJ_PID: pid })
  const running = r.run(dir, ['log'], { timeout: 60_000 })
  await expect.poll(() => existsSync(started), { timeout: 20_000 }).toBe(true)
  const checker = Number(readFileSync(started, 'utf8'))
  await r.shutdown(10_000)
  // By the time shutdown returns, the check's process is ended (it owned it) and the run has its answer.
  expect(alive(checker)).toBe(false)
  writeFileSync(release, '')
  expect(await running).toMatchObject({ ok: false, code: -1 })
  // Nothing started after: the command never ran (its marker absent), and neither a check nor a run starts now.
  expect(existsSync(pid)).toBe(false)
  expect(await r.readiness()).not.toMatchObject({ state: 'ok' })
  expect(await r.run(dir, ['log'])).toMatchObject({ ok: false, code: -1, notRun: 'failed' })
  expect(existsSync(pid)).toBe(false)
}

describe("the store's gate for Git readers and prints (HI-2918, HR2's round 1)", () => {
  /** A Git store outside every jj workspace (its HEAD a file), a worktree's folder naming it, and one naming nothing. */
  const stores = () => {
    const top = tempDir('jj-runner-store-')
    const store = join(top, 'shared.git')
    mkdirSync(join(store, 'objects'), { recursive: true })
    writeFileSync(join(store, 'HEAD'), 'ref: refs/heads/main\n')
    const worktree = join(store, 'worktrees', 'w')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, 'HEAD'), 'ref: refs/heads/w\n')
    writeFileSync(join(worktree, 'commondir'), '../..\n')
    const broken = join(top, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(broken, 'commondir'), '../nowhere\n')
    return { top, store, worktree, broken }
  }

  it("keys a Git dir by its common store, wherever it is; a worktree's folder by the store it names; a broken one refuses", async () => {
    const s = stores()
    const key = await storeKeyOf(s.store)
    expect(key).toMatch(/^store:/)
    expect(await storeKeyOf(s.worktree)).toBe(key)
    expect(await storeKeyOf(s.broken)).toBe('refuse')
    // A folder in no jj workspace and no Git dir: nothing of jj's writes there.
    expect(await storeKeyOf(tempDir('jj-runner-none-'))).toBeNull()
  })

  it("a jj workspace with a project file named HEAD is keyed by its own store, as are its subfolders and its store; the real store's write holds back a reader there (HR2's round 2)", async () => {
    const ws = workspace()
    const store = (await workspaceGateKeys(ws))!.store
    writeFileSync(join(ws, 'HEAD'), 'not git: a file of the project\n')
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'HEAD'), 'also content\n')
    expect(await storeKeyOf(ws)).toBe(store)
    expect(await storeKeyOf(join(ws, 'src'))).toBe(store)
    expect(await storeKeyOf(join(ws, '.jj', 'repo', 'store', 'git'))).toBe(store)
    // A git read in the workspace (no --git-dir): waits while a jj write holds the real store.
    const held = await jjFileGate.acquire([store], 'exclusive')
    let ran = false
    const git = storeGitGated(ws, ['rev-parse', 'HEAD'], async () => ((ran = true), { ok: true, out: '', err: '', buf: Buffer.alloc(0), code: 0 }))
    await new Promise((res) => setImmediate(res))
    expect(ran).toBe(false)
    held.release()
    expect((await git).ok).toBe(true)
    expect(jjFileGate.size).toBe(0)
  })

  it("Git's history port and git on a store outside every jj workspace wait for a write holding that store", async () => {
    const s = stores()
    const key = (await storeKeyOf(s.store)) as string
    const held = await jjFileGate.acquire([key], 'exclusive')
    const ran: string[] = []
    const port = storeGatedHistory({
      contains: async (store: string) => (ran.push(`contains ${store === s.store}`), true),
      refSync: (store: string) => (ran.push(`refSync ${store === s.store}`), 'abc')
    })
    const contains = port.contains(s.store)
    const git = storeGitGated(s.top, ['--git-dir', s.worktree, 'rev-parse', 'HEAD'], async () => (ran.push('git'), { ok: true, out: '', err: '', buf: Buffer.alloc(0), code: 0 }))
    // The sync read gets nothing while the write holds its store.
    expect(port.refSync(s.store)).toBeNull()
    await new Promise((res) => setImmediate(res))
    expect(ran).toEqual([])
    held.release()
    expect(await contains).toBe(true)
    expect((await git).ok).toBe(true)
    expect(ran.sort()).toEqual(['contains true', 'git'])
    expect(port.refSync(s.store)).toBe('abc')
    // A store whose key can't be read isn't run against: refused.
    expect(await storeGitGated(s.top, ['--git-dir', s.broken, 'log'], async () => ({ ok: true, out: 'ran', err: '', buf: Buffer.alloc(0), code: 0 }))).toMatchObject({ ok: false, code: -1 })
    await expect(storeGatedHistory({ contains: async (store: string) => store.length > 0 }).contains(s.broken)).rejects.toThrow(/key/)
    expect(jjFileGate.size).toBe(0)
  })

  it('a print waiting for its store when the runner shuts down is refused without reading; a new one after is refused; one granted reads', async () => {
    const s = stores()
    const key = (await storeKeyOf(s.store)) as string
    const jjRepo = join(s.top, 'repo')
    mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
    writeFileSync(join(jjRepo, 'op_heads', 'heads', 'a'.repeat(128)), '')
    const sources = { jjRepo, store: s.store, files: [{ label: 'HEAD', path: join(s.store, 'HEAD') }] }
    // Granted at once: it reads (a print, not refused).
    const free = runner()
    expect(typeof (await free.print!(sources))).toBe('string')
    await free.shutdown(1000)
    // Queued behind a write holding its store, then shut down: refused, never read; and nothing after.
    const r = runner()
    const held = await jjFileGate.acquire([key], 'exclusive')
    const queued = r.print!(sources)
    await expect.poll(() => jjFileGate.queued, { timeout: 10_000 }).toBe(1)
    await r.shutdown(1000)
    expect(await queued).toBeNull()
    expect(jjFileGate.queued).toBe(0)
    held.release()
    // (A preview takes the same path, gatedRead: refused, its fence is unreadable.)
    expect(await r.print!(sources)).toBeNull()
    expect(jjFileGate.size).toBe(0)
  })
})

describe("jj's shutdown while a run waits on the tool's check", () => {
  it('in this thread: owns the check, ends it, and starts nothing after', () => shutdownWhileChecking((extra) => runner(extra)))
})

describe("jj's worker thread", () => {
  const bundle = join(dir, 'jj-worker.cjs')
  beforeAll(async () => {
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'platform', 'jjWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  }, 60_000)
  const inWorker = (extra: Record<string, string> = {}) => createJjRunner({ exe: process.execPath, before: [fake], env: env(extra), worker: bundle })

  it('runs commands off main with the same answers, caps and time limits', async () => {
    const r = inWorker()
    expect(await r.readiness()).toMatchObject({ state: 'ok', version: '0.47.1' })
    const res = await r.run(dir, ['log'])
    expect(JSON.parse(res.out).args).toEqual([...JJ_PREFIX, ...JJ_READ, 'log'])
    expect(await inWorker({ FAKE_JJ_MODE: 'flood' }).run(dir, ['log'], { maxOutput: 50_000, timeout: 20_000 })).toMatchObject({ code: -1, notRun: 'maxOutput' })
    expect(await inWorker({ FAKE_JJ_MODE: 'hang' }).run(dir, ['log'], { timeout: 500 })).toMatchObject({ code: -1, timedOut: true })
  })

  it('cancels a command under way in the worker: the process is ended', async () => {
    const pid = join(tempDir('jj-runner-pid-'), 'pid')
    const ac = new AbortController()
    const running = inWorker({ FAKE_JJ_MODE: 'hang', FAKE_JJ_PID: pid }).run(dir, ['log'], { signal: ac.signal, timeout: 60_000 })
    await expect.poll(() => existsSync(pid), { timeout: 20_000 }).toBe(true)
    ac.abort()
    expect(await running).toMatchObject({ code: -1, cancelled: true })
    expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
  })

  it("shuts down while a run waits on the tool's check in the worker: the check ended, nothing started after", () => shutdownWhileChecking((extra) => inWorker(extra)))

  it("shuts down: the worker's commands and their trees ended, then the worker", async () => {
    const probe = tempDir('jj-worker-shutdown-')
    const [pid, child] = [join(probe, 'pid'), join(probe, 'child')]
    const r = inWorker({ FAKE_JJ_MODE: 'tree', FAKE_JJ_PID: pid, FAKE_JJ_CHILD: child })
    const running = r.run(dir, ['log'], { timeout: 60_000 })
    await expect.poll(() => existsSync(pid) && existsSync(child), { timeout: 20_000 }).toBe(true)
    await r.shutdown(15_000)
    expect(await running).toMatchObject({ code: -1, cancelled: true })
    expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
    expect(alive(Number(readFileSync(child, 'utf8')))).toBe(false)
  })
})

describe("jj's teardown and shutdown", () => {
  it('ends the whole tree a cancelled jj started, by identity, and nothing else', async () => {
    const probe = tempDir('jj-runner-tree-')
    const [pid, child] = [join(probe, 'pid'), join(probe, 'child')]
    // An unrelated process of the test's own, started first: never ended by jj's teardown.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    try {
      const ac = new AbortController()
      const running = runner({ FAKE_JJ_MODE: 'tree', FAKE_JJ_PID: pid, FAKE_JJ_CHILD: child }).run(dir, ['log'], { signal: ac.signal, timeout: 60_000 })
      await expect.poll(() => existsSync(pid) && existsSync(child), { timeout: 20_000 }).toBe(true)
      ac.abort()
      // It settles after the teardown: by then jj and what it started are gone.
      expect(await running).toMatchObject({ code: -1, cancelled: true })
      expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
      expect(alive(Number(readFileSync(child, 'utf8')))).toBe(false)
      expect(bystander.exitCode).toBeNull()
      expect(alive(bystander.pid!)).toBe(true)
    } finally {
      bystander.kill()
    }
  })

  it('shuts down within its bound: every command under way ended, its tree too, and none started after', async () => {
    const probe = tempDir('jj-runner-shutdown-')
    const [pid, child] = [join(probe, 'pid'), join(probe, 'child')]
    const r = runner({ FAKE_JJ_MODE: 'tree', FAKE_JJ_PID: pid, FAKE_JJ_CHILD: child })
    const running = r.run(dir, ['log'], { timeout: 60_000 })
    await expect.poll(() => existsSync(pid) && existsSync(child), { timeout: 20_000 }).toBe(true)
    const t0 = Date.now()
    await r.shutdown(15_000)
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(await running).toMatchObject({ code: -1, cancelled: true })
    expect(alive(Number(readFileSync(pid, 'utf8')))).toBe(false)
    expect(alive(Number(readFileSync(child, 'utf8')))).toBe(false)
    expect(await r.run(dir, ['log'])).toMatchObject({ code: -1, notRun: 'failed' })
  })
})
