// The merge queue runner's git host (HI-2079, gitHost.ts): its frames, read however they come; its requests, each told
// once (out, err, code, a start that failed, an end by a signal), and lost, never answered, once the host goes or says
// something it shouldn't; and in the runner, one host per lease in its job, recorded once, a bounded git still on the
// launcher, and a host that goes failing the runner, which releases (its job ended) and admits nothing more.
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join, win32 } from 'path'
import { PassThrough } from 'stream'
import { runInNewContext } from 'vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { FactStore, withWriteFence } from '../src/main/workflow/factStore'
import { FRAME_MAX, frameOf, FrameDecoder, GitHost, HOST, OUT_CHUNK, REQUEST_MAX, startGitHost, type Frame, type FrameKind } from '../src/main/workflow/gitHost'
import { endLeaseJob, queueHost } from '../src/main/workflow/queueJobs'
import { forgetEnded, LeaseLost, QueueRunner } from '../src/main/workflow/queueRunner'
import { windowsProbe, type Listed } from '../src/main/workflow/queueProcs'
import { checkGit, gitExe, gitTool, realGitBehind, setGitToolForTests } from '../src/main/gitTool'
import { git as combworkGit, withGitRoute } from '../src/main/git'
import { gitRepo, put, sh } from './workflow/harness'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

/** Processes a test made (hosts, commands left by a host that went): any still running when it ends are ended. */
const made: Listed[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const c of children.splice(0)) {
    c.stdin?.end()
    if (c.exitCode === null && c.signalCode === null) c.kill()
  }
  await windowsProbe.end(made.splice(0))
})

/** A process by its pid as running now (its start), kept to be ended if a test fails before it is. */
async function identify(pid: number): Promise<Listed> {
  const p = (await windowsProbe.list())!.find((x) => x.pid === pid)
  if (!p) throw new Error(`process ${pid} isn't running`)
  made.push(p)
  return p
}

const running = (p: Listed): Promise<boolean | null> => windowsProbe.alive(p.pid, p.started)
const ends = (p: Listed): Promise<void> => vi.waitFor(async () => expect(await running(p)).toBe(false), { timeout: 30_000, interval: 200 })

/** A frame as the host writes it. */
const frame = (kind: FrameKind | string, id: number, payload: string | Buffer = ''): Buffer => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = Buffer.alloc(9)
  head.write(kind, 0, 'latin1')
  head.writeUInt32BE(id, 1)
  head.writeUInt32BE(body.length, 5)
  return Buffer.concat([head, body])
}

describe('the frames (FrameDecoder)', () => {
  const stream = Buffer.concat([frame('S', 1, '42'), frame('O', 1, 'héllo'), frame('E', 2, ''), frame('X', 1, '0'), frame('K', 2, 'SIGTERM')])
  const all = (fs: Frame[]): string[] => fs.map((f) => `${f.kind}${f.id}:${f.payload.toString('utf8')}`)
  const whole = all(new FrameDecoder().push(stream))

  it('several at once, or split at any byte: the same frames', () => {
    expect(whole).toEqual(['S1:42', 'O1:héllo', 'E2:', 'X1:0', 'K2:SIGTERM'])
    for (let at = 1; at < stream.length; at++) {
      const d = new FrameDecoder()
      const got = [...d.push(stream.subarray(0, at)), ...d.push(stream.subarray(at))]
      d.end()
      expect(all(got)).toEqual(whole)
    }
    // A byte at a time.
    const d = new FrameDecoder()
    const got: Frame[] = []
    for (const b of stream) got.push(...d.push(Buffer.from([b])))
    expect(all(got)).toEqual(whole)
  })

  it('an unknown kind, a payload over FRAME_MAX, or a frame cut short: refused', () => {
    expect(() => new FrameDecoder().push(frame('Z', 1, 'x'))).toThrow(/unknown frame/)
    const big = Buffer.alloc(9)
    big.write('O', 0, 'latin1')
    big.writeUInt32BE(1, 1)
    big.writeUInt32BE(FRAME_MAX + 1, 5)
    expect(() => new FrameDecoder().push(big)).toThrow(/frame of/)
    const d = new FrameDecoder()
    d.push(frame('O', 1, 'abc').subarray(0, 11))
    expect(() => d.end()).toThrow(/cut short/)
  })
})

/** A host of the test's own (in no job), told to go: its requests, and why it was lost, each time. */
function own(env: NodeJS.ProcessEnv = baseEnv()): { host: GitHost; child: ChildProcess; lost: string[] } {
  const { child } = startGitHost(env)
  children.push(child)
  const lost: string[] = []
  const host = new GitHost(child, (why) => lost.push(why))
  host.go()
  return { host, child, lost }
}

const node = (cwd: string, code: string, extra: { env?: NodeJS.ProcessEnv; input?: string } = {}) => ({ command: process.execPath, args: ['-e', code], cwd, env: extra.env ?? baseEnv(), ...(extra.input !== undefined ? { input: extra.input } : {}) })

describe('a git host (HI-2079)', { timeout: 60_000 }, () => {
  it('each request its own, several at once: output, error output, exit code, input, folder and environment', async () => {
    const { host, lost } = own()
    const dirs = [tempDir('gh-a-'), tempDir('gh-b-'), tempDir('gh-c-')]
    const code = `process.stdin.pipe(process.stdout); process.stderr.write(process.cwd() + '|' + process.env.HI2079); process.stdin.on('end', () => { process.exitCode = Number(process.env.HI2079) })`
    const rs = await Promise.all(dirs.map((d, i) => host.request(node(d, code, { env: { ...baseEnv(), HI2079: String(i + 2) }, input: `in ${i}` }))))
    rs.forEach((r, i) => expect(r).toMatchObject({ out: `in ${i}`, err: `${dirs[i]}|${i + 2}`, code: i + 2 }))
    expect(lost).toEqual([])
  })

  it('200 KiB of output: framed in pieces of at most 64 KiB, and given back whole', async () => {
    const { host, child } = own()
    const sizes: number[] = []
    const tap = new FrameDecoder()
    child.stdout!.on('data', (d: Buffer) => sizes.push(...tap.push(d).filter((f) => f.kind === 'O').map((f) => f.payload.length)))
    const r = await host.request(node(tempDir('gh-'), `process.stdout.write('x'.repeat(200 * 1024))`))
    expect(r).toMatchObject({ code: 0, err: '' })
    expect(r.out).toBe('x'.repeat(200 * 1024))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(OUT_CHUNK)
  })

  it("a command that couldn't start (HI-2020): notRun and why, and the host goes on", async () => {
    const { host, lost } = own()
    const r = await host.request({ command: 'no-such-command-hi2079', args: [], cwd: tempDir('gh-'), env: baseEnv() })
    expect(r).toMatchObject({ code: null, notRun: 'ENOENT' })
    expect(r.err).toMatch(/ENOENT/)
    expect(await host.request(node(tempDir('gh-'), 'process.exit(1)'))).toMatchObject({ out: '', err: '', code: 1 })
    expect(lost).toEqual([])
  })

  it("a command ended by a signal (HI-2042): its name, never code 1; a real exit 1 stays one", async () => {
    // The fixture, in the host only (its environment, not the requests'), ends its first command by SIGTERM.
    const preload = join(__dirname, 'fixtures', 'gitHostSignal.cjs').replace(/\\/g, '/')
    const { host } = own({ ...baseEnv(), NODE_OPTIONS: `--require "${preload}"`, CW_GIT_HOST_TEST_SIGNAL: '1' })
    expect(await host.request(node(tempDir('gh-'), 'setInterval(() => {}, 1000)'))).toMatchObject({ code: null, signal: 'SIGTERM' })
    const plain = await host.request(node(tempDir('gh-'), `process.stderr.write('said'); process.exit(1)`))
    expect(plain).toMatchObject({ out: '', err: 'said', code: 1 })
  })

  it('output a descendant keeps open after the command exited: told after the quiet, and what it writes later never framed', async () => {
    const { host, lost } = own()
    const dir = tempDir('gh-')
    const go = join(dir, 'go')
    const mark = join(dir, 'wrote')
    // The command exits at once; its detached child holds the output and writes only once the test says (after the
    // command's end was told), then exits. A bound of its own: it ends after a minute whatever happens.
    const later = `const fs = require('fs'); process.stdout.on('error', () => {}); setTimeout(() => process.exit(0), 60000); const t = setInterval(() => { if (!fs.existsSync(${JSON.stringify(go)})) return; clearInterval(t); process.stdout.write('late', () => { fs.writeFileSync(${JSON.stringify(mark)}, String(process.pid)); process.exit(0) }) }, 50)`
    // Hidden, in the test's own environment (the command's, from baseEnv).
    const code = `const k = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(later)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true, env: process.env }); k.unref(); process.stdout.write('p')`
    expect(await host.request(node(dir, code))).toMatchObject({ out: 'p', err: '', code: 0 })
    writeFileSync(go, '')
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 30_000, interval: 100 })
    // Written to a pipe the host no longer reads: nothing framed, nothing lost, and the host goes on.
    expect(await host.request(node(dir, `process.stdout.write('next')`))).toMatchObject({ out: 'next', err: '', code: 0 })
    expect(lost).toEqual([])
  })

  it('a request (all but its input) over REQUEST_MAX: never sent (notRun E2BIG), and the host goes on', async () => {
    const { host, lost } = own()
    const r = await host.request(node(tempDir('gh-'), '', { env: { ...baseEnv(), HI2079: 'x'.repeat(REQUEST_MAX) } }))
    expect(r).toMatchObject({ code: null, notRun: 'E2BIG' })
    expect(await host.request(node(tempDir('gh-'), `process.stdout.write('ok')`))).toMatchObject({ out: 'ok', err: '', code: 0 })
    expect(lost).toEqual([])
  })

  it('input past REQUEST_MAX (HI-2078): streamed whole, characters split across its pieces kept', async () => {
    const { host, lost } = own()
    // 3 MiB and more, a four-byte character every few bytes, so the 64 KiB pieces split them.
    const input = 'ab🐝é'.repeat(400_000)
    expect(Buffer.byteLength(input)).toBeGreaterThan(3 * REQUEST_MAX)
    const r = await host.request(node(tempDir('gh-'), `process.stdin.pipe(process.stdout)`, { input }))
    expect(r.code).toBe(0)
    expect(r.outBuf.equals(Buffer.from(input))).toBe(true)
    expect(lost).toEqual([])
  })

  it('the host gone mid-command: what was told stays, what waits is lost once, nothing is sent after', async () => {
    const { host, child, lost } = own()
    const dir = tempDir('gh-')
    const told = await host.request(node(dir, `process.stdout.write('done')`))
    const pidFile = join(dir, 'pid')
    const waiting = host.request(node(dir, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`))
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 30_000, interval: 100 })
    // Its command, outside any job here, is the test's to end.
    await identify(Number(readFileSync(pidFile, 'utf8')))
    await windowsProbe.end([await identify(child.pid!)])
    expect(await waiting).toMatchObject({ code: null, lost: expect.any(String) })
    expect(told).toMatchObject({ out: 'done', err: '', code: 0 })
    expect(lost).toHaveLength(1)
    expect(host.usable).toBe(false)
    expect(await host.request(node(dir, ''))).toMatchObject({ code: null, lost: lost[0] })
  })
})

/**
 * The host's own script (HOST) run in a VM, no process started: its input, its output (whether it takes more: `full`),
 * its timers (run when the test says), and the children it starts (fake ones, their pipes the test's).
 */
function vmHost(): { send: (b: Buffer | string) => void; paused: () => boolean; frames: () => string[]; setFull: (full: boolean) => void; kids: Fake[]; spawned: { command: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }[]; runTimers: () => void; timers: () => number } {
  const timers = new Map<number, () => void>()
  let next = 0
  let full = false
  const written: Buffer[] = []
  const stdout = Object.assign(new EventEmitter(), { write: (b: Buffer) => (written.push(b), !full) })
  let held = false
  const stdin = Object.assign(new EventEmitter(), { pause: () => (held = true), resume: () => (held = false) })
  const kids: Fake[] = []
  const spawned: { command: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }[] = []
  const cp = {
    spawn: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      spawned.push({ command, args, opts })
      const c = new EventEmitter() as unknown as Fake
      Object.assign(c, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 42 })
      kids.push(c)
      return c
    }
  }
  const proc = { stdout, stdin, exit: () => undefined }
  runInNewContext(HOST, {
    process: proc,
    require: (m: string) => (m === 'child_process' ? cp : req(m)),
    Buffer,
    setTimeout: (f: () => void) => (timers.set(++next, f), next),
    clearTimeout: (i: number) => timers.delete(i)
  })
  return {
    send: (b) => stdin.emit('data', Buffer.isBuffer(b) ? b : Buffer.from(b)),
    paused: () => held,
    frames: () => new FrameDecoder().push(Buffer.concat(written)).map((f) => `${f.kind}${f.id}:${f.payload.toString('utf8')}`),
    setFull: (f) => {
      full = f
      if (!f) stdout.emit('drain')
    },
    kids,
    spawned,
    runTimers: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const f of due) f()
    },
    timers: () => timers.size
  }
}

/** Lets the fake pipes' events through. */
const turn = (): Promise<void> => new Promise((res) => setImmediate(res))

describe("the git host's script, its streams the test's (HR3's round 1 findings 1 and 2)", () => {
  it('held back by the runner: no quiet counted, nothing cut off; once read, all of it framed before its end', async () => {
    const h = vmHost()
    h.send(Buffer.concat([frameOf('G', 0), frameOf('R', 1, JSON.stringify({ id: 1, command: 'git', args: [], cwd: '.', env: {} })), frameOf('J', 1)]))
    const [c] = h.kids
    c.stdout.write('first')
    await turn()
    // The runner stops reading: the next frame isn't taken, and every output is held back.
    h.setFull(true)
    c.stderr.write('warn')
    await turn()
    c.stdout.write('tail')
    c.stderr.write('more')
    c.emit('exit', 0, null)
    await turn()
    // No quiet counts while it is held back: however long, it isn't ended and its tail isn't lost.
    expect(h.timers()).toBe(0)
    h.runTimers()
    expect(h.frames()).toEqual(['S1:42', 'O1:first', 'E1:warn'])
    // Read again: what waited is framed, then the quiet after the exit, then its end, and nothing after.
    h.setFull(false)
    await turn()
    expect(h.frames()).toEqual(['S1:42', 'O1:first', 'E1:warn', 'O1:tail', 'E1:more'])
    h.runTimers()
    // Its output closed by the host: a later write goes nowhere.
    c.stdout.on('error', () => undefined)
    c.stdout.write('later')
    await turn()
    expect(h.frames()).toEqual(['S1:42', 'O1:first', 'E1:warn', 'O1:tail', 'E1:more', 'X1:0'])
  })

  it('a request split at any byte, characters too: its folder, arguments, environment and input as sent', () => {
    const spec = { command: 'git', args: ['commit', '-m', 'héllo wörld ✓ 𝄞'], cwd: 'C:\\Users\\Zoë\\projet é', env: { HI2079: 'ünïcode ✓' } }
    const input = 'naïve 🐝'
    const bytes = Buffer.concat([frameOf('R', 1, JSON.stringify({ id: 1, ...spec })), frameOf('I', 1, input), frameOf('J', 1)])
    for (let at = 1; at < bytes.length; at++) {
      const h = vmHost()
      h.send(frameOf('G', 0))
      h.send(bytes.subarray(0, at))
      h.send(bytes.subarray(at))
      expect(h.spawned).toHaveLength(1)
      const s = h.spawned[0]
      expect({ command: s.command, args: s.args, cwd: s.opts.cwd, env: s.opts.env }).toEqual(spec)
      expect(String(h.kids[0].stdin.read())).toBe(input)
      expect(h.kids[0].stdin.writableEnded).toBe(true)
    }
  })

  it("a command taking no more input: the host reads nothing more until it does; then the rest, and its end (HI-2078)", async () => {
    const h = vmHost()
    h.send(Buffer.concat([frameOf('G', 0), frameOf('R', 1, JSON.stringify({ id: 1, command: 'git', args: [], cwd: '.', env: {} }))]))
    const [c] = h.kids
    const piece = Buffer.alloc(64 * 1024, 97)
    h.send(frameOf('I', 1, piece))
    // Its input full (nothing reads it yet): the host holds every input back.
    expect(h.paused()).toBe(true)
    let got = 0
    c.stdin.on('data', (d: Buffer) => (got += d.length))
    await turn()
    expect(h.paused()).toBe(false)
    h.send(Buffer.concat([frameOf('I', 1, piece), frameOf('J', 1)]))
    await turn()
    expect(got).toBe(2 * piece.length)
    expect(c.stdin.writableEnded).toBe(true)
  })

  it("a zero bound: any byte is past it (as execFile's), an empty output isn't", async () => {
    const h = vmHost()
    const ask = (id: number) => frameOf('R', id, JSON.stringify({ id, command: 'git', args: [], cwd: '.', env: {}, maxBuffer: 0 }))
    h.send(Buffer.concat([frameOf('G', 0), ask(1), frameOf('J', 1), ask(2), frameOf('J', 2)]))
    const [a, b] = h.kids
    a.stdout.write('x')
    await turn()
    expect(h.frames().filter((f) => f.startsWith('B') || f.startsWith('O'))).toEqual([expect.stringMatching(/^B1:maxBuffer/)])
    b.emit('exit', 0, null)
    b.stdout.end()
    b.stderr.end()
    await turn()
    b.emit('close', 0, null)
    await turn()
    expect(h.frames().at(-1)).toBe('X2:0')
  })
})

/** A host's child as a test drives it: its pipes, and its exit when the test says. */
type Fake = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
function fake(): { child: Fake; host: GitHost; lost: string[] } {
  const c = new EventEmitter() as unknown as Fake
  Object.assign(c, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: null, signalCode: null })
  const lost: string[] = []
  return { child: c, host: new GitHost(c, (why) => lost.push(why)), lost }
}

describe("what a git host says that it shouldn't (HI-2079)", () => {
  const spec = { command: 'git', args: [], cwd: '.', env: {} }

  for (const [what, bad] of [
    ['a frame for a request that isn\'t waiting', frame('S', 9, '1')],
    ['output before its start', frame('O', 1, 'x')],
    ['a second start', Buffer.concat([frame('S', 1, '5'), frame('S', 1, '5')])],
    ['an exit that is no number', Buffer.concat([frame('S', 1, '5'), frame('X', 1, 'nope')])],
    ['an unknown kind', frame('Q', 1, '')]
  ] as const)
    it(`${what}: every waiting request lost once, the host not used again`, async () => {
      const { child, host, lost } = fake()
      const a = host.request(spec)
      const b = host.request(spec)
      child.stdout!.write(bad)
      expect(await a).toMatchObject({ lost: lost[0] })
      expect(await b).toMatchObject({ lost: lost[0] })
      expect(lost).toHaveLength(1)
      // Anything after, even a good frame, changes nothing.
      child.stdout!.write(frame('X', 2, '0'))
      expect(lost).toHaveLength(1)
      expect(await host.request(spec)).toMatchObject({ lost: lost[0] })
    })

  it('its output ending part way through a frame: lost, never an answer', async () => {
    const { child, host, lost } = fake()
    const a = host.request(spec)
    child.stdout!.write(frame('S', 1, '5'))
    child.stdout!.end(frame('X', 1, '0').subarray(0, 9))
    expect(await a).toMatchObject({ lost: 'a frame cut short' })
    expect(lost).toEqual(['a frame cut short'])
  })

  it('its exit: what it told first stays, even told after the exit was seen; only what still waits is lost', async () => {
    const { child, host, lost } = fake()
    const a = host.request(spec)
    const b = host.request(spec)
    child.stdout!.write(Buffer.concat([frame('S', 1, '5'), frame('O', 1, 'out')]))
    child.emit('exit', 0, null)
    // The frames it wrote before it exited arrive after.
    child.stdout!.end(frame('X', 1, '0'))
    expect(await a).toMatchObject({ out: 'out', err: '', code: 0, outBuf: Buffer.from('out') })
    expect(await b).toMatchObject({ lost: expect.stringMatching(/ended/) })
    expect(lost).toHaveLength(1)
  })

  it("more output than a request's bound (zero: any byte), however the host sends it: lost, what is read here bounded", async () => {
    const { child, host, lost } = fake()
    const a = host.request({ ...spec, maxBuffer: 0 })
    child.stdout!.write(Buffer.concat([frame('S', 1, '5'), frame('E', 1, 'x')]))
    expect(await a).toMatchObject({ lost: 'more err for 1 than its bound' })
    expect(lost).toHaveLength(1)
  })

  it('its input breaking (EPIPE): lost', async () => {
    const { child, host, lost } = fake()
    const a = host.request(spec)
    child.stdin!.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(await a).toMatchObject({ lost: 'its input: write EPIPE' })
    expect(lost).toHaveLength(1)
  })
})

interface World {
  project: string
  root: string
  store: FactStore
  close: () => void
}

function world(): World {
  const ws = join(tempDir('qgh-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = FactStore.open(boardFile(ws), { project: 'project', key: 'AM' })
  return {
    project,
    root: join(`${ws}.worktrees`, 'project'),
    store,
    close: () => {
      store.close()
      closeBoard(ws)
      dismiss()
    }
  }
}

/** An editor that never ends (a commit waiting on it), writing its pid first: a git that runs until something ends it. */
function stuckCommit(w: World): { env: NodeJS.ProcessEnv; pidFile: string; args: string[] } {
  const dir = tempDir('qgh-editor-')
  const pidFile = join(dir, 'pid')
  const editor = join(dir, 'editor.cjs')
  writeFileSync(editor, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
  put(w.project, 'staged.txt', 'staged\n')
  sh(w.project, 'add', 'staged.txt')
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  return { env: { ...baseEnv(), GIT_EDITOR: `"${fwd(process.execPath)}" "${fwd(editor)}"` }, pidFile, args: ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit'] }
}

const acquire = async (w: World, hooks: NonNullable<Parameters<typeof QueueRunner.acquire>[0]['hooks']> = {}): Promise<QueueRunner> => {
  const a = await QueueRunner.acquire({ store: w.store, project: w.project, target: 'main', root: w.root, profile: 'A', hooks })
  if (!a.ok) throw new Error('not acquired')
  return a.runner
}

const kinds = (w: World, lease: string): string[] => w.store.queueProcs(lease).map((p) => p.what).sort()

describe("the runner's git host (HI-2079)", { timeout: 120_000 }, () => {
  it('git with no bound: one host for the lease, in its job and recorded once, answering as git does; release ends it', async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      const env = baseEnv()
      const [status, head, config] = await Promise.all([
        runner.git(w.project, ['status', '--porcelain'], 'testMerge', { env }),
        runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env }),
        runner.git(w.project, ['config', '--get', 'no.such'], 'testMerge', { env })
      ])
      expect(status).toEqual({ ok: true, code: 0, out: '', err: '' })
      expect(head.out.trim()).toBe(sh(w.project, 'rev-parse', 'HEAD'))
      // git's own "no": exit 1, never taken for anything else.
      expect(config).toEqual({ ok: false, code: 1, out: '', err: '' })
      const pid = runner.gitHostPid!
      expect(pid).toBeGreaterThan(0)
      const host = await identify(pid)
      expect(kinds(w, runner.lease)).toEqual(['job', 'testMerge'])
      expect(w.store.queueProcs(runner.lease).find((p) => p.what === 'testMerge')?.pid).toBe(pid)
      const listed = (await queueHost().request('list', runner.lease)) as { processes: { pid: number }[] }
      expect(listed.processes.map((p) => p.pid)).toContain(pid)
      // The same host for the next git.
      expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env })).toMatchObject({ ok: true })
      expect(runner.gitHostPid).toBe(pid)
      await runner.release()
      await ends(host)
      expect(w.store.queueProcs(runner.lease)).toEqual([])
      expect(w.store.queueLease('main')).toBeNull()
    } finally {
      await runner.release()
      w.close()
    }
  })

  it("a check's detached server and a followed escape: untouched by the host's gits, ended by the release", async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      // A check that starts a detached server and exits (as tests/queueRunner.test.ts's): its server runs on in the job.
      // Hidden, in the check's own environment (baseEnv's).
      const check = `const k = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: process.env }); k.unref(); console.log(k.pid)`
      const c = await runner.spawn('check', process.execPath, ['-e', check], { env: baseEnv() })
      const server = await identify(Number(await new Promise<string>((res) => c.stdout!.once('data', (d) => res(String(d).trim())))))
      // A process outside the job that the supervisor follows (as a packaged app's escaped one).
      const k = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true, env: baseEnv() })
      k.unref()
      const escaped = await identify(k.pid!)
      expect(await runner.followForTests(k.pid!)).toBe(true)
      for (let i = 0; i < 5; i++) expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })).toMatchObject({ ok: true })
      expect(await running(server)).toBe(true)
      expect(await running(escaped)).toBe(true)
      await runner.release()
      await ends(server)
      await ends(escaped)
    } finally {
      await runner.release()
      w.close()
    }
  })

  it("a git that can't start (HI-2020): notRun, the runner going on", async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      const r = await runner.git(join(w.root, 'no-such-folder'), ['status'], 'testMerge', { env: baseEnv() })
      expect(r).toMatchObject({ ok: false, code: -1, notRun: 'ENOENT' })
      expect(runner.failed).toBe(false)
      expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })).toMatchObject({ ok: true })
    } finally {
      await runner.release()
      w.close()
    }
  })

  it('a bounded git keeps the launcher: its bound ends its tree (#1350), the host untouched', async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })).toMatchObject({ ok: true })
      const pid = runner.gitHostPid
      const c = stuckCommit(w)
      const r = await runner.git(w.project, c.args, 'testMerge', { env: c.env, timeoutMs: 5_000 })
      expect(r).toMatchObject({ ok: false, timedOut: true })
      // Its editor (the tree's leaf) ended with it.
      const editor = Number(readFileSync(c.pidFile, 'utf8'))
      await vi.waitFor(async () => expect((await windowsProbe.list())!.some((p) => p.pid === editor)).toBe(false), { timeout: 30_000, interval: 200 })
      expect(runner.gitHostPid).toBe(pid)
      expect(runner.failed).toBe(false)
    } finally {
      await runner.release()
      w.close()
    }
  })

  it('the host gone mid-command: the git lost (no answer), the runner failed, admitting nothing, and released once; its job ended', async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      const c = stuckCommit(w)
      const stuck = runner.git(w.project, c.args, 'testMerge', { env: c.env })
      await vi.waitFor(() => expect(existsSync(c.pidFile)).toBe(true), { timeout: 30_000, interval: 100 })
      const editor = await identify(Number(readFileSync(c.pidFile, 'utf8')))
      const host = await identify(runner.gitHostPid!)
      const lease = runner.lease
      await windowsProbe.end([host])
      expect(await stuck).toMatchObject({ ok: false, code: -1, signal: 'hostLost' })
      expect(runner.failed).toBe(true)
      expect(runner.holds()).toBe(false)
      await expect(runner.git(w.project, ['status'], 'testMerge', { env: baseEnv() })).rejects.toBeInstanceOf(LeaseLost)
      expect(() => runner.spawnNow('check', process.execPath, ['-e', ''])).toThrow(LeaseLost)
      // One release, whoever asks: the failure's, and the queue's run ending.
      expect(runner.release()).toBe(runner.release())
      await runner.release()
      await ends(editor)
      expect(w.store.queueProcs(lease)).toEqual([])
      expect(w.store.queueLease('main')).toBeNull()
    } finally {
      await runner.release()
      w.close()
    }
  })

  it("released while its host starts: LeaseLost, no host told to go, nothing of it left", async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      const lease = runner.lease
      const git = runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })
      const released = runner.release()
      await expect(git).rejects.toBeInstanceOf(LeaseLost)
      await released
      expect(runner.gitHostPid).toBeNull()
      expect(runner.failed).toBe(false)
      expect(w.store.queueProcs(lease)).toEqual([])
      expect(w.store.queueLease('main')).toBeNull()
    } finally {
      w.close()
    }
  })

  it('a takeover between the lease read and the send: never an answer, and the successor finds the job empty', async () => {
    const w = world()
    let took = false
    const runner = await acquire(w, {
      beforeHostSend: async () => {
        if (took) return
        took = true
        // Another Combwork takes the lease (as if this one looked dead) and ends its job by name, as its settle does first.
        const now = w.store.queueLease('main')!
        w.store.takeQueueLease({ ...now, lease: 'successor', token: 'successor', profile: 'B', pid: 1 }, now.token)
        expect(await endLeaseJob(queueHost(), runner.lease)).toBe(true)
      }
    })
    try {
      const r = await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() }).catch((e: unknown) => e)
      if (r instanceof LeaseLost) expect(r).toBeInstanceOf(LeaseLost)
      else expect(r).toMatchObject({ ok: false, signal: 'hostLost' })
      expect(runner.holds()).toBe(false)
      await expect(runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })).rejects.toBeInstanceOf(LeaseLost)
      expect(await queueHost().request('empty', runner.lease)).toBe(true)
    } finally {
      await runner.release()
      w.store.dropQueueLease('successor', 'successor')
      w.close()
    }
  })

  it('HI-2137: the git Combwork starts (gitExe), in the host and through the launcher; one gone, PATH git once more', async () => {
    // As checkGit resolves it, from the launcher: before anything is acquired, so nothing is left open where it can't.
    const execPath = win32.normalize(sh(tempDir('qgh-exec-'), '--exec-path'))
    const top = join(execPath, '..', '..', '..')
    const resolved = realGitBehind(join(top, 'cmd', 'git.exe'), execPath)
    if (!resolved) return // Not Git for Windows: nothing of this applies.
    const real = resolved.exe
    const trace = tempDir('qgh-trace2-')
    // No Git folder on PATH but the launcher's: what the real git's children find comes from its launcher environment.
    const env = { ...baseEnv(), PATH: `${join(top, 'cmd')};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, GIT_TRACE2_EVENT: trace }
    // Each git's argv[0], as trace2 has it: the executable as it was started (a path, or "git" found on PATH).
    const started = (): string[] => readdirSync(trace).flatMap((f) => readFileSync(join(trace, f), 'utf8').split('\n').filter((l) => l.includes('"event":"start"')).map((l) => (JSON.parse(l) as { argv: string[] }).argv[0]))
    const w = world()
    let runner: QueueRunner | null = null
    try {
      runner = await acquire(w)
      setGitToolForTests({ state: 'ok', version: '2.51.0' }, resolved)
      // The launcher's MSYSTEM and its shell tools, seen by an alias through sh.
      const alias = ['-c', 'alias.cwmsys=!echo "$MSYSTEM $(command -v sed)"', 'cwmsys']
      expect(await runner.git(w.project, alias, 'testMerge', { env })).toMatchObject({ ok: true, out: `${resolved.launcherEnv!.msystem} /usr/bin/sed\n` })
      expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env, timeoutMs: 60_000 })).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(started().filter((a) => a.toLowerCase() === real.toLowerCase())).toHaveLength(2), { timeout: 10_000, interval: 50 })
      // The real git gone (uninstalled, moved): the command runs with PATH's git, which is what Combwork starts from then on.
      const gone = join(tempDir('qgh-gone-'), 'git.exe')
      setGitToolForTests({ state: 'ok', version: '2.51.0' }, { exe: gone })
      // Several at once, in the host and through the launcher: each once more from PATH, whichever found it gone first.
      const rs = await Promise.all([
        runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env }),
        runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env }),
        runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env, timeoutMs: 60_000 })
      ])
      for (const r of rs) expect(r).toMatchObject({ ok: true })
      expect(gitExe().exe).not.toBe(gone)
      // And git() in the queue's route (the host, through gitOutcome), several at once: the same.
      setGitToolForTests({ state: 'ok', version: '2.51.0' }, { exe: gone })
      const held = runner
      const routed = await withGitRoute((m) => held.gitOutcome(m), () => Promise.all([1, 2, 3].map(() => combworkGit(w.project, ['rev-parse', 'HEAD'], undefined, undefined, { env }))))
      for (const r of routed) expect(r).toMatchObject({ ok: true })
      expect(gitTool().state).not.toBe('missing')
      // Its check again, settled before the next test.
      await checkGit()
      expect(gitExe().exe).not.toBe(gone)
    } finally {
      setGitToolForTests({ state: 'unknown' })
      await runner?.release()
      w.close()
    }
  })

  it("the host gone, and its job can't be seen empty: the duties stay, and the next runner pauses for them", async () => {
    const w = world()
    const runner = await acquire(w, { endJob: () => false })
    try {
      expect(await runner.git(w.project, ['rev-parse', 'HEAD'], 'testMerge', { env: baseEnv() })).toMatchObject({ ok: true })
      const lease = runner.lease
      await windowsProbe.end([await identify(runner.gitHostPid!)])
      await vi.waitFor(() => expect(runner.failed).toBe(true), { timeout: 30_000, interval: 50 })
      await runner.release()
      // Its lease gone, its duties kept for the next settle.
      expect(w.store.queueLease('main')).toBeNull()
      expect(kinds(w, lease)).toContain('job')
      const next = await QueueRunner.acquire({ store: w.store, project: w.project, target: 'main', root: w.root, profile: 'B', hooks: { endJob: () => false } })
      expect(next).toMatchObject({ ok: true, paused: expect.any(Number) })
      expect(w.store.queuePause('main')).toMatchObject({ reason: 'needsYou', card: '' })
      if (next.ok) await next.runner.release()
    } finally {
      // Settled for real (its job is closed: kill on close ended what was in it).
      const last = await QueueRunner.acquire({ store: w.store, project: w.project, target: 'main', root: w.root, profile: 'C' })
      if (last.ok) await last.runner.release()
      w.close()
    }
  })

  it("HI-2177: a process's exit told in the queue's fenced work after its lease went (the release ending its git host): its record forgotten, never refused as LeaseLost", async () => {
    const w = world()
    const runner = await acquire(w)
    const lease = runner.lease
    try {
      // The lease given up (its release), and a record of it left, as one whose process ends after that.
      await runner.release()
      w.store.addQueueProc({ lease, target: 'main', pid: 4242, startAfter: 1, startBefore: 2, what: 'testMerge' })
      expect(w.store.queueLease('main')).toBeNull()
      // The exit, in the async context of the fenced work its start ran in (MergeQueue's fence: the lease held).
      const fence = () => {
        if (!w.store.queueLease('main')) throw new LeaseLost('main')
      }
      await expect(withWriteFence(fence, async () => w.store.dropQueueProc(lease, 1))).rejects.toThrow(LeaseLost)
      await withWriteFence(fence, () => forgetEnded({ store: w.store }, lease, 4242))
      expect(w.store.queueProcs(lease).map((p) => p.pid)).not.toContain(4242)
    } finally {
      await runner.release()
      w.close()
    }
  })
})

