// The Preview runner (HI-3614, design HI-3597 s16 §E): real dev-server stand-ins (Node scripts), real ports, the real TCP
// table (netstat) and the real test bind, on a range of ports picked free for each test. What the app gives the runner
// beyond those (the process supervisor's job, Electron) is the e2e suite's (tests/e2e/preview.cjs).
// 1. Cross-project: two projects' previews at the same time get different ports.
// 2. Collision and the wrong server: a stranger on the next port is skipped; a stranger on every port is "no free port",
//    naming the range; a server ignoring PORT fails naming its real port; a stranger taking the port while the server
//    starts fails it naming the stranger's pid; an exit then a stranger taking the port leaves it Stopped.
// 3. Identity: clean gives the commit only; an edit gives a content id, a revert the original source, the same edit again
//    the same id; a new lease stops the old preview.
// Plus the shared half: the suggestion from package.json, the setting's check, and the TCP table's parse.
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createServer, type Server } from 'net'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { bindFree, parseNetstat, readListeners } from '../src/main/previewPorts'
import { PreviewRunner, rangeOf, type Launched, type Listener, type RunnerDeps } from '../src/main/previewRunner'
import { previewSource } from '../src/main/previewSource'
import { previewConfigOf, sameSource, suggestPreviewCommand, type PreviewEnd, type PreviewPlace, type PreviewSource, type PreviewView } from '../src/shared/preview'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = timing('wait.hangReal')
const TEST_MS = timing('test.hangReal')
/** How long a stand-in that listens elsewhere gets before its start fails (the runner's startSeconds). */
const START_SECONDS = 3

const dir = tempDir('preview-runner-')
const script = join(dir, 'server.js')
// The stand-in: `port` listens on PORT, `fixed <n>` on n whatever PORT says, `idle` never listens. Each stays until ended.
writeFileSync(
  script,
  [
    "const net = require('net')",
    "const [mode, n] = process.argv.slice(2)",
    "const port = mode === 'fixed' ? Number(n) : Number(process.env.PORT)",
    "if (mode !== 'idle') net.createServer((s) => s.end()).listen(port, '127.0.0.1')",
    'setInterval(() => {}, 1 << 30)',
    ''
  ].join('\n')
)

const children = new Set<ChildProcess>()
const strangers = new Set<Server>()
afterEach(async () => {
  for (const c of children) if (c.exitCode === null) c.kill()
  children.clear()
  await Promise.all([...strangers].map((s) => new Promise((r) => s.close(() => r(undefined)))))
  strangers.clear()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Listens on a port as another program would (held until the test ends). */
function stranger(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const s = createServer((c) => c.end())
    s.once('error', rej)
    s.listen(port, '127.0.0.1', () => {
      strangers.add(s)
      res(s)
    })
  })
}

/** A block of `size` ports free now, at random in 50000–59999 (other runs on the machine pick their own). */
async function freeBlock(size: number): Promise<[number, number]> {
  for (let tries = 0; tries < 50; tries++) {
    const first = 50000 + Math.floor(Math.random() * 9000)
    const all = await Promise.all(Array.from({ length: size }, (_, i) => bindFree(first + i)))
    if (all.every(Boolean)) return [first, first + size - 1]
  }
  throw new Error('no free block of ports')
}

/** The stand-in started directly (no shell): its tree is itself. `mode` comes from the command ("port", "fixed 5555", "idle"). */
const launch: RunnerDeps['launch'] = async (o) => {
  const child = spawn(process.execPath, [script, ...o.command.split(' ')], { cwd: o.place.folder, env: { ...runContext.baseEnv(), ...o.env }, stdio: 'ignore', windowsHide: true })
  children.add(child)
  const exited = new Promise<{ code: number | null }>((res) => {
    child.once('exit', (code) => res({ code }))
    child.once('error', () => res({ code: null }))
  })
  const l: Launched = {
    exited,
    tree: async () => (child.pid && child.exitCode === null ? [child.pid] : []),
    stop: async () => {
      if (child.exitCode === null) child.kill()
      await exited
      return true
    }
  }
  return l
}

function runner(range: [number, number], over: Partial<RunnerDeps> = {}): PreviewRunner {
  return new PreviewRunner({
    range: () => range,
    reserved: () => new Set(),
    startSeconds: () => START_SECONDS,
    bindFree,
    listeners: readListeners,
    launch,
    source: async () => ({ kind: 'clean', commit: 'c0ffee' }),
    watch: () => () => undefined,
    logPath: () => null,
    pollMs: 100,
    ...over
  })
}

function place(name: string, generation = 'project', folder = join(dir, name)): PreviewPlace {
  mkdirSync(folder, { recursive: true })
  return { kind: name === 'project' ? 'project' : 'slot', name, folder, generation }
}

describe.skipIf(process.platform !== 'win32')('the preview runner (HI-3614)', () => {
  it('gives two projects running at the same time different ports, each checked as its own', { timeout: TEST_MS }, async () => {
    const range = await freeBlock(10)
    const r = runner(range)
    const [a, b] = await Promise.all([r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' }), r.start('C:\\ws\\beta', place('beta'), { command: 'port' })])
    expect([a.state, b.state]).toEqual(['running', 'running'])
    expect(a.port).not.toBe(b.port)
    for (const v of [a, b]) expect(v.port >= range[0] && v.port <= range[1]).toBe(true)
    expect(a.url).toBe(`http://127.0.0.1:${a.port}/`)
    expect(r.heldPorts()).toEqual([a.port, b.port].sort((x, y) => x - y))
    // A second start of a running place gives the same preview.
    expect((await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })).id).toBe(a.id)
    await r.stopWhere(() => true, { kind: 'stopped' })
    expect(r.heldPorts()).toEqual([])
  })

  it('skips a port a stranger listens on, and with every port taken fails naming the range', { timeout: TEST_MS }, async () => {
    const range = await freeBlock(3)
    await stranger(range[0])
    const r = runner(range)
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })
    expect(v.state).toBe('running')
    expect(v.port).toBe(range[0] + 1)
    await r.stopWhere(() => true, { kind: 'stopped' })
    await stranger(range[0] + 1)
    await stranger(range[0] + 2)
    const none = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })
    expect(none.state).toBe('stopped')
    expect(none.end).toEqual({ kind: 'noFreePort', first: range[0], last: range[1] })
    expect(r.heldPorts()).toEqual([])
  })

  it("never gives out Combwork's own ports, and gives a second for hot reload when asked", { timeout: TEST_MS }, async () => {
    const range = await freeBlock(4)
    const r = runner(range, { reserved: () => new Set([range[0], range[0] + 1]) })
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port', hmrPort: true })
    expect(v.state).toBe('running')
    expect([v.port, v.hmrPort]).toEqual([range[0] + 2, range[0] + 3])
    await r.stopWhere(() => true, { kind: 'stopped' })
  })

  it('fails a server that ignores PORT, naming the port it listens on', { timeout: TEST_MS }, async () => {
    const range = await freeBlock(2)
    const [own] = await freeBlock(1)
    const r = runner(range)
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: `fixed ${own}` })
    expect(v.state).toBe('stopped')
    expect(v.end).toEqual({ kind: 'otherPort', port: range[0], listening: [own] })
    // Its tree was ended: nothing listens on its own port any more.
    await vi.waitFor(async () => expect(await bindFree(own)).toBe(true), { timeout: HUNG_MS })
    expect(r.heldPorts()).toEqual([])
  })

  it('fails the start when a stranger takes its port before the server listens, naming its pid', { timeout: TEST_MS }, async () => {
    const range = await freeBlock(2)
    const r = runner(range, { startSeconds: () => 60 })
    // As the start is under way (its port known), another program listens on that port.
    let taken: Promise<Server> | null = null
    r.onChange((v) => {
      if (v.state === 'starting' && v.port && !taken) taken = stranger(v.port)
    })
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'idle' })
    expect(taken).not.toBeNull()
    expect(v.state).toBe('stopped')
    expect(v.end).toEqual({ kind: 'stranger', port: range[0], pid: process.pid })
  })

  it("is stopped for good once its server exits: a stranger on its port after isn't shown as it", { timeout: TEST_MS }, async () => {
    const range = await freeBlock(2)
    const r = runner(range)
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })
    expect(v.state).toBe('running')
    for (const c of children) c.kill()
    await vi.waitFor(() => expect(r.at(place('alpha').folder)?.state).toBe('stopped'), { timeout: HUNG_MS })
    expect(r.at(place('alpha').folder)?.end?.kind).toBe('exited')
    expect(r.heldPorts()).toEqual([])
    await vi.waitFor(async () => expect(await bindFree(v.port)).toBe(true), { timeout: HUNG_MS })
    await stranger(v.port)
    // Still stopped, its address gone: nothing reattaches to the stranger.
    const after = r.at(place('alpha').folder)!
    expect([after.state, after.url, after.id]).toEqual(['stopped', null, v.id])
    // Started again, it gets another port, never the stranger's.
    const again = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })
    expect(again.state).toBe('running')
    expect(again.port).not.toBe(v.port)
    await r.stopWhere(() => true, { kind: 'stopped' })
  })

  it("stops a place's preview when a new lease starts there, and with its lease's end", { timeout: TEST_MS }, async () => {
    const range = await freeBlock(4)
    const r = runner(range)
    const folder = join(dir, 'slot-b')
    const first = await r.start('C:\\ws\\alpha', place('slot-b', 'lease-1', folder), { command: 'port' })
    expect(first.state).toBe('running')
    const second = await r.start('C:\\ws\\alpha', place('slot-b', 'lease-2', folder), { command: 'port' })
    expect(second.state).toBe('running')
    expect(second.id).not.toBe(first.id)
    // The old one stopped (its place ended), and only the new one is known for the place.
    expect(r.views().map((x) => [x.place.generation, x.state])).toEqual([['lease-2', 'running']])
    expect((await r.stopWhere((x) => x.place.generation === 'lease-2', { kind: 'placeEnded' })).stopped).toBe(1)
    expect(r.at(folder)?.end).toEqual({ kind: 'placeEnded' })
  })

  it('takes the stamp at its start, and says when the files change after', { timeout: TEST_MS }, async () => {
    const range = await freeBlock(2)
    let changed: (() => void) | null = null
    let source: PreviewSource = { kind: 'clean', commit: 'c0ffee' }
    const r = runner(range, { watch: (_f, fn) => ((changed = fn), () => (changed = null)), source: async () => source })
    const seen: PreviewView[] = []
    r.onChange((v) => seen.push(v))
    const v = await r.start('C:\\ws\\alpha', place('alpha'), { command: 'port' })
    expect(v.source).toEqual({ kind: 'clean', commit: 'c0ffee' })
    expect(v.changedAt).toBeNull()
    source = { kind: 'dirty', commit: 'c0ffee', content: 'feed' }
    changed!()
    expect(r.at(place('alpha').folder)?.changedAt).not.toBeNull()
    expect(await r.sourceNow(v.id)).toEqual({ now: source, changed: true })
    // A tree that can't be read now: whether it changed can't be told (never "unchanged").
    source = { kind: 'unknown', commit: 'c0ffee', why: 'add: fatal' }
    expect((await r.sourceNow(v.id))?.changed).toBeNull()
    await r.stopWhere(() => true, { kind: 'stopped' })
    // Its watcher closed with it.
    expect(changed).toBeNull()
    expect(seen.some((x) => x.changedAt)).toBe(true)
  })
})

/** A runner on fakes (HI-3614 round 1): a TCP table the test sets, every port bindable, launches the test answers. */
function fakeRunner(over: Partial<RunnerDeps> = {}) {
  const table: Listener[] = []
  const launches: { o: Parameters<RunnerDeps['launch']>[0]; answer: (l: Launched | { problem: string }) => void }[] = []
  const r = new PreviewRunner({
    range: () => [53000, 53009],
    reserved: () => new Set(),
    startSeconds: () => 60,
    bindFree: async () => true,
    listeners: async () => [...table],
    launch: (o) => new Promise((answer) => launches.push({ o, answer })),
    source: async () => ({ kind: 'clean', commit: 'c0ffee' }),
    watch: () => () => undefined,
    logPath: () => null,
    pollMs: 1,
    ...over
  })
  return { r, table, launches }
}

/** A launched stand-in: its tree is `pid`; its stop is logged, and proved unless told otherwise (or held until `held` settles). */
function fakeServer(pid: number, log: string[], name: string, o: { proved?: boolean; held?: Promise<void> } = {}): Launched {
  let exit!: (e: { code: number | null }) => void
  const exited = new Promise<{ code: number | null }>((res) => (exit = res))
  return {
    exited,
    tree: async () => [pid],
    stop: async () => {
      log.push(`stop ${name}`)
      await o.held
      exit({ code: null })
      return o.proved ?? true
    }
  }
}

/** Lets every promise already settled run on (no time passes: what can happen without the test's answer has). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const waitUntil = (fn: () => boolean): Promise<void> => vi.waitFor(() => expect(fn()).toBe(true), { timeout: HUNG_MS })

describe("a preview's lifetime and its ports' owners (HI-3614 round 1)", () => {
  it('a Stop while its launch is under way is over only once that launch has finished and its server has ended', async () => {
    const { r, launches } = fakeRunner()
    const log: string[] = []
    const started = r.start('P', place('a'), { command: 'x' })
    await waitUntil(() => launches.length === 1)
    let over = false
    const stop = r.stop(r.at(place('a').folder)!.id).then(() => (over = true))
    await settle()
    expect([over, log]).toEqual([false, []])
    expect(r.at(place('a').folder)?.state).toBe('stopped')
    launches[0].answer(fakeServer(101, log, 'a'))
    await stop
    expect(log).toEqual(['stop a'])
    expect((await started).end).toEqual({ kind: 'stopped' })
    expect(r.heldPorts()).toEqual([])
  })

  it("is its owner's from the moment it is asked for: a workspace closing stops one still reading its stamp, and nothing launches", async () => {
    const answers: ((s: PreviewSource) => void)[] = []
    const { r, launches } = fakeRunner({ source: () => new Promise((res) => answers.push(res)) })
    // Stopped before its turn has begun: it reads nothing at all.
    const early = r.start('P', place('a'), { command: 'x' }, { owner: 'ws-1' })
    expect((await r.stopWhere((_v, owner) => owner === 'ws-1', { kind: 'projectClosed' })).stopped).toBe(1)
    expect((await early).end).toEqual({ kind: 'projectClosed' })
    expect(answers.length).toBe(0)
    // Stopped while it reads its stamp.
    const started = r.start('P', place('a'), { command: 'x' }, { owner: 'ws-1' })
    await waitUntil(() => answers.length === 1)
    expect((await r.stopWhere((_v, owner) => owner === 'ws-2', { kind: 'projectClosed' })).stopped).toBe(0)
    expect((await r.stopWhere((_v, owner) => owner === 'ws-1', { kind: 'projectClosed' })).stopped).toBe(1)
    answers[0]({ kind: 'clean', commit: 'c0ffee' })
    expect((await started).end).toEqual({ kind: 'projectClosed' })
    await settle()
    expect(launches.length).toBe(0)
    expect(r.heldPorts()).toEqual([])
  })

  it('is admitted again just before its server starts: a place that ended meanwhile launches nothing', async () => {
    const asked: string[] = []
    let generation = 'lease-1'
    const { r, launches } = fakeRunner({ source: async () => ((generation = 'lease-2'), { kind: 'clean', commit: 'c0ffee' }) })
    const admit = async (): Promise<PreviewEnd | null> => (asked.push(generation), generation === 'lease-1' ? null : { kind: 'placeEnded' })
    const v = await r.start('P', place('slot-a', 'lease-1'), { command: 'x' }, { admit })
    expect(asked).toEqual(['lease-1', 'lease-2'])
    expect(v.end).toEqual({ kind: 'placeEnded' })
    expect(launches.length).toBe(0)
    expect(r.heldPorts()).toEqual([])
  })

  it("a new lease's start in a place waits until the old lease's server has gone", async () => {
    const { r, table, launches } = fakeRunner()
    const log: string[] = []
    const folder = place('slot-a').folder
    const first = r.start('P', place('slot-a', 'lease-1', folder), { command: 'x' })
    await waitUntil(() => launches.length === 1)
    table.push({ port: 53000, pid: 101 })
    let release!: () => void
    launches[0].answer(fakeServer(101, log, 'lease-1', { held: new Promise<void>((res) => (release = res)) }))
    expect((await first).state).toBe('running')
    const second = r.start('P', place('slot-a', 'lease-2', folder), { command: 'x' })
    await waitUntil(() => log.length === 1)
    await settle()
    // The old server is still ending: the new one hasn't launched.
    expect(launches.length).toBe(1)
    table.length = 0
    release()
    await waitUntil(() => launches.length === 2)
    table.push({ port: Number(launches[1].o.env.PORT), pid: 202 })
    launches[1].answer(fakeServer(202, log, 'lease-2'))
    const v = await second
    expect([v.state, v.place.generation]).toEqual(['running', 'lease-2'])
    expect(r.views().filter((x) => x.place.generation === 'lease-1').length).toBe(0)
    await r.stopWhere(() => true, { kind: 'stopped' })
  })

  it("fails the start when a stranger listens on its hot reload port, though its own port is its server's", async () => {
    const { r, table, launches } = fakeRunner()
    const log: string[] = []
    const started = r.start('P', place('a'), { command: 'x', hmrPort: true })
    await waitUntil(() => launches.length === 1)
    expect([launches[0].o.env.PORT, launches[0].o.env.CW_PREVIEW_HMR_PORT]).toEqual(['53000', '53001'])
    table.push({ port: 53000, pid: 101 }, { port: 53001, pid: 999 })
    launches[0].answer(fakeServer(101, log, 'a'))
    const v = await started
    expect(v.end).toEqual({ kind: 'stranger', port: 53001, pid: 999 })
    expect(log).toEqual(['stop a'])
  })

  it('checks its ports again later: a stranger on the hot reload port then stops it', async () => {
    const { r, table, launches } = fakeRunner()
    const log: string[] = []
    const started = r.start('P', place('a'), { command: 'x', hmrPort: true })
    await waitUntil(() => launches.length === 1)
    table.push({ port: 53000, pid: 101 })
    launches[0].answer(fakeServer(101, log, 'a'))
    const v = await started
    expect(v.state).toBe('running')
    expect(await r.checkOwnership(v.id)).toEqual({ ok: true })
    // Its own hot reload socket is its own.
    table.push({ port: 53001, pid: 101 })
    expect(await r.checkOwnership(v.id)).toEqual({ ok: true })
    table[1] = { port: 53001, pid: 999 }
    expect(await r.checkOwnership(v.id)).toEqual({ ok: false, end: { kind: 'stranger', port: 53001, pid: 999 } })
    expect(r.at(place('a').folder)?.state).toBe('stopped')
  })

  it("keeps its place and ports held when its server's end can't be proved: a new lease's start there is refused until it is", async () => {
    const { r, table, launches } = fakeRunner()
    const log: string[] = []
    const folder = place('slot-a').folder
    const started = r.start('P', place('slot-a', 'old', folder), { command: 'x' })
    await waitUntil(() => launches.length === 1)
    table.push({ port: 53000, pid: 101 })
    const proof = { proved: false }
    const server = fakeServer(101, log, 'old')
    launches[0].answer({ ...server, job: 'preview-old', stop: async () => (await server.stop(), proof.proved) })
    const v = await started
    expect(v.state).toBe('running')
    // Its lease ends: the stop can't prove its server gone. The place and its port stay held, and the job is named.
    const ended = await r.stopWhere((x) => x.place.generation === 'old', { kind: 'placeEnded' })
    expect(ended).toEqual({ stopped: 1, held: ['preview-old'] })
    expect(r.heldPorts()).toEqual([53000])
    expect(r.at(folder)).toMatchObject({ id: v.id, held: true })
    // The slot's next lease: its start in the SAME folder tries the old server's end again, still unproved: refused, nothing launched.
    const refused = await r.start('P', place('slot-a', 'new', folder), { command: 'x' })
    expect(refused).toMatchObject({ state: 'stopped', end: { kind: 'placeHeld', preview: v.id } })
    expect(launches.length).toBe(1)
    expect(log).toEqual(['stop old', 'stop old'])
    // The old record is kept (never forgotten while held), and asked again it still names its job.
    expect((await r.stopWhere((x) => x.place.generation === 'old', { kind: 'placeEnded' })).held).toEqual(['preview-old'])
    // Once its end is proved (a later try), the next start goes ahead there, and the old port is free again.
    proof.proved = true
    table.length = 0
    const next = r.start('P', place('slot-a', 'new', folder), { command: 'x' })
    await waitUntil(() => launches.length === 2)
    expect(r.heldPorts()).toEqual([53000])
    expect(r.views().some((x) => x.id === v.id)).toBe(false)
    table.push({ port: 53000, pid: 202 })
    launches[1].answer(fakeServer(202, log, 'new'))
    expect(await next).toMatchObject({ state: 'running', port: 53000, place: { generation: 'new' } })
    await r.stopWhere(() => true, { kind: 'stopped' })
  })
})

describe("a preview's source (HI-3614, s16 §B)", () => {
  const env = runContext.baseEnv()
  const g = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  it('is the commit alone when clean; an edit gives a content id, the revert the original, the same edit the same id', { timeout: TEST_MS }, async () => {
    const repo = tempDir('preview-source-')
    const scratch = tempDir('preview-scratch-')
    g(repo, 'init', '-q')
    g(repo, 'config', 'user.email', 't@example.com')
    g(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-qm', 'first')
    const head = g(repo, 'rev-parse', 'HEAD')
    const clean = await previewSource(repo, scratch)
    expect(clean).toEqual({ kind: 'clean', commit: head })
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    const edited = await previewSource(repo, scratch)
    expect(edited).toEqual({ kind: 'dirty', commit: head, content: expect.stringMatching(/^[0-9a-f]{40}$/) })
    // An untracked file counts; an ignored one doesn't.
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    const untracked = await previewSource(repo, scratch)
    expect(untracked.kind === 'dirty' && edited.kind === 'dirty' && untracked.content !== edited.content).toBe(true)
    rmSync(join(repo, 'b.txt'))
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(repo, 'ignored'))}); require('fs').writeFileSync(${JSON.stringify(join(repo, 'ignored', 'x.txt'))}, 'x')`], { env })
    expect(await previewSource(repo, scratch)).toEqual(edited)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    expect(await previewSource(repo, scratch)).toEqual(clean)
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    expect(await previewSource(repo, scratch)).toEqual(edited)
    // The place's own index is never touched: git status still sees the edit as unstaged.
    expect(g(repo, 'status', '--porcelain')).toBe('M a.txt')
  })

  it('is no commit in a repository with none, and nothing outside a repository', { timeout: TEST_MS }, async () => {
    const repo = tempDir('preview-empty-')
    const scratch = tempDir('preview-scratch-')
    g(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    expect(await previewSource(repo, scratch)).toEqual({ kind: 'dirty', commit: null, content: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(await previewSource(tempDir('preview-none-'), scratch)).toEqual({ kind: 'none' })
  })

  it("is unknown, never clean, when git can't build the tree (a required clean filter failing)", { timeout: TEST_MS }, async () => {
    const repo = tempDir('preview-filter-')
    const scratch = tempDir('preview-scratch-')
    g(repo, 'init', '-q')
    g(repo, 'config', 'user.email', 't@example.com')
    g(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-qm', 'first')
    const head = g(repo, 'rev-parse', 'HEAD')
    // From now on every .txt must pass a filter that always fails: the add of a changed one fails.
    g(repo, 'config', 'filter.broken.clean', 'false')
    g(repo, 'config', 'filter.broken.required', 'true')
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=broken\n')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    const s = await previewSource(repo, scratch)
    expect(s.kind).toBe('unknown')
    expect(s).toMatchObject({ commit: head })
    expect(sameSource(s, { kind: 'clean', commit: head })).toBeNull()
  })
})

describe("the preview's shared half (HI-3614)", () => {
  it('suggests dev, then start, then preview, run by the lockfile’s package manager (npm without one)', () => {
    const pkg = (scripts: Record<string, string>): string => JSON.stringify({ scripts })
    expect(suggestPreviewCommand(pkg({ start: 'node s.js', dev: 'vite', preview: 'vite preview' }))).toEqual({ script: 'dev', line: 'vite', command: 'npm run dev' })
    expect(suggestPreviewCommand(pkg({ preview: 'vite preview', start: 'next start' }))?.command).toBe('npm run start')
    expect(suggestPreviewCommand(pkg({ preview: 'vite preview' }), ['pnpm-lock.yaml'])?.command).toBe('pnpm run preview')
    expect(suggestPreviewCommand(pkg({ dev: 'vite' }), ['yarn.lock'])?.command).toBe('yarn run dev')
    expect(suggestPreviewCommand(pkg({ build: 'tsc', dev: '  ' }))).toBeNull()
    expect(suggestPreviewCommand('{ not json')).toBeNull()
    expect(suggestPreviewCommand(null)).toBeNull()
  })

  it("keeps a setting only with a one-line command and a page path from the server's root", () => {
    expect(previewConfigOf({ command: ' npm run dev ', path: '/', hmrPort: true })).toEqual({ command: 'npm run dev', hmrPort: true })
    expect(previewConfigOf({ command: 'npm run dev', path: '/app/' })).toEqual({ command: 'npm run dev', path: '/app/' })
    for (const bad of [{ command: '' }, { command: 'a\nb' }, { command: 'x'.repeat(1001) }, { command: 'npm', path: 'app' }, { command: 'npm', path: '//evil.example' }, { command: 'npm', path: '/a b' }, null, 'npm run dev']) expect(previewConfigOf(bad)).toBeNull()
  })

  it("reads netstat's listening sockets by their any-address, whatever the state's word in its language", () => {
    const out = [
      '',
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1040',
      '  TCP    127.0.0.1:45000        0.0.0.0:0              ABHÖREN          4242',
      '  TCP    127.0.0.1:45000        127.0.0.1:51000        HERGESTELLT      4242',
      '  TCP    [::1]:45001            [::]:0                 ABHÖREN          77',
      '  TCP    [::]:445               [::]:0                 LISTENING        4',
      '  UDP    0.0.0.0:5353           *:*                                     9'
    ].join('\r\n')
    expect(parseNetstat(out)).toEqual([
      { port: 135, pid: 1040 },
      { port: 45000, pid: 4242 },
      { port: 45001, pid: 77 },
      { port: 445, pid: 4 }
    ])
  })

  it("puts a development build's default range after the installed app's", () => {
    expect(rangeOf(45000, true, 45000)).toEqual([45000, 45999])
    expect(rangeOf(45000, false, 45000)).toEqual([46000, 46999])
    expect(rangeOf(50000, false, 45000)).toEqual([50000, 50999])
    expect(rangeOf(64536, true, 45000)).toEqual([64536, 65535])
  })
})
