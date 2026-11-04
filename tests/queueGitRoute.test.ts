// The merge queue's reads in its lease's git host (HI-2078): git() inside a route's scope runs there and nowhere else
// (never the worker, and nothing at all once the runner doesn't admit); outside the scope, or after it, on the worker;
// the host's bounds as execFile's; and one mapping for both, so a routed git() answers as the worker's would.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { git, gitTestHooks, withGitRoute, withoutGitRoute, type GitResult, type GitRoute } from '../src/main/git'
import { gitTool, setGitToolForTests } from '../src/main/gitTool'
import type { GitOutcome } from '../src/main/gitWorker'
import { FactStore } from '../src/main/workflow/factStore'
import { GitHost, startGitHost, type HostResult } from '../src/main/workflow/gitHost'
import { outcomeOf, QueueRunner } from '../src/main/workflow/queueRunner'
import * as G from '../src/main/platform/git'
import { treeOf, windowsProbe, type Listed } from '../src/main/workflow/queueProcs'
import { B1, commit, gitRepo, moved, R1, setup, sh, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

/** Processes a test made (hooks, hosts' commands): any still running when it ends are ended. */
const made: Listed[] = []
const observing: Promise<Listed>[] = []
const reading: Promise<unknown>[] = []
let worker = 0
let env: Env | null = null

afterEach(async () => {
  gitTestHooks.started = undefined
  vi.restoreAllMocks()
  // A failed assertion may skip awaiting a hook's observation. Finish it before ending its owned tree (HI-2502).
  await Promise.allSettled(observing.splice(0))
  env?.close()
  env = null
  const owned = made.splice(0)
  // Stop parents first: a live git can retry fsmonitor when its hook is ended, creating a child outside the snapshot.
  await windowsProbe.end(owned.reverse())
  await Promise.allSettled(reading.splice(0))
  if (!owned.length) return
  await vi.waitFor(async () => {
    const list = await windowsProbe.list()
    expect(list, 'the process list is readable after ending fixture processes').not.toBeNull()
    expect(owned.filter((p) => list!.some((x) => x.pid === p.pid && x.started === p.started)), 'all recorded fixture processes have exited').toEqual([])
  }, { timeout: 30_000, interval: 100 })
})

/** Counts the git commands started on the worker from here on. */
function countWorker(): void {
  worker = 0
  gitTestHooks.started = () => worker++
}

/** The live hook and its launch's tree, kept to be ended even if the test fails before awaiting them. */
async function identifyHook(file: string, since: number): Promise<Listed> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 30_000, interval: 100 })
  const pid = Number(readFileSync(file, 'utf8'))
  const list = (await windowsProbe.list())!
  const p = list.find((x) => x.pid === pid)
  if (!p) throw new Error(`process ${pid} isn't running`)
  let root = p
  // The hook's ancestors created by this launch, up to the test worker or the older lease host. Capture while the
  // launcher still lives: its timeout can leave both the real git and its conhost as siblings below that launcher.
  for (;;) {
    const parent = list.find((x) => x.pid === root.parent)
    if (!parent || parent.pid === process.pid || parent.started < since || parent.started > root.started) break
    root = parent
  }
  made.push(...treeOf(list, root))
  expect(list.some((x) => x.pid === root.parent && (x.pid === process.pid || x.started < since)), 'the fixture tree was captured before its launcher exited').toBe(true)
  return p
}

/** The process its pid file names has ended (it may have ended before it could be identified). */
async function goneByFile(file: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 30_000, interval: 100 })
  const pid = Number(readFileSync(file, 'utf8'))
  await vi.waitFor(async () => expect((await windowsProbe.list())!.some((p) => p.pid === pid)).toBe(false), { timeout: 30_000, interval: 200 })
}

const running = (p: Listed): Promise<boolean | null> => windowsProbe.alive(p.pid, p.started)
const ends = (p: Listed): Promise<void> => vi.waitFor(async () => expect(await running(p)).toBe(false), { timeout: 30_000, interval: 200 })

/** An outcome a stub route gives: its stdout, and an exit (null: 0). */
const said = (out: string, error: GitOutcome['error'] = null): GitOutcome => ({ stdout: Buffer.from(out), stderr: Buffer.alloc(0), error, cwdExists: true })

describe("git()'s route (HI-2078)", () => {
  it('inside a scope: its route, never the worker; outside it, the worker', async () => {
    const dir = tempDir('route-')
    countWorker()
    const asked: string[][] = []
    const route: GitRoute = async (m) => (asked.push(m.args), said('routed'))
    const inside = await withGitRoute(route, () => git(dir, ['status']))
    expect(inside).toMatchObject({ ok: true, out: 'routed', code: 0 })
    // GIT_PREFIX once, as the worker gets it.
    expect(asked).toEqual([['--no-optional-locks', '-c', 'diff.autoRefreshIndex=false', '-c', 'core.quotepath=off', 'status']])
    expect(worker).toBe(0)
    await git(dir, ['--version'])
    expect(worker).toBe(1)
    expect(asked).toHaveLength(1)
  })

  it('work that outlives its scope runs on the worker; nested scopes; withoutGitRoute', async () => {
    const dir = tempDir('route-')
    countWorker()
    const calls: string[] = []
    const outer: GitRoute = async () => (calls.push('outer'), said(''))
    const inner: GitRoute = async () => (calls.push('inner'), said(''))
    let later: () => Promise<GitResult> = async () => {
      throw new Error('not set')
    }
    let release = (): void => undefined
    const held = new Promise<void>((res) => (release = res))
    let escaped: Promise<GitResult> | null = null
    await withGitRoute(outer, async () => {
      await git(dir, ['a'])
      await withGitRoute(inner, () => git(dir, ['b']))
      await git(dir, ['c'])
      // Bypassed inside: a runner's own clean-up.
      await withoutGitRoute(() => git(dir, ['--version']))
      // A callback started inside, run after the scope completed.
      later = () => git(dir, ['--version'])
      escaped = held.then(() => later())
    })
    expect(calls).toEqual(['outer', 'inner', 'outer'])
    expect(worker).toBe(1)
    release()
    await escaped
    expect(worker).toBe(2)
    expect(calls).toHaveLength(3)
  })

  it("the host's outcome read as the worker's: a signal, a bound, lost with the host, never git's exit 1", async () => {
    const dir = tempDir('route-')
    const r = (x: Partial<HostResult>): HostResult => ({ out: '', err: '', outBuf: Buffer.alloc(0), errBuf: Buffer.alloc(0), code: null, ...x })
    const via = async (x: Partial<HostResult>, opts = {}) => withGitRoute(async () => outcomeOf(r(x), dir), () => git(dir, ['status'], undefined, undefined, opts))
    expect(await via({ signal: 'SIGTERM' })).toMatchObject({ ok: false, code: -1, notRun: 'SIGTERM' })
    expect(await via({ bounded: 'maxBuffer' })).toMatchObject({ ok: false, code: -1, notRun: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    expect(await via({ bounded: 'timeout' }, { timeout: 1000 })).toMatchObject({ ok: false, code: -1, notRun: 'SIGTERM', timedOut: true })
    expect(await via({ lost: 'it ended' })).toMatchObject({ ok: false, code: -1, notRun: 'hostLost' })
    expect(await via({ code: 1, err: 'no', errBuf: Buffer.from('no') })).toMatchObject({ ok: false, code: 1, err: 'no' })
    const exited = await via({ code: 0, out: 'é', outBuf: Buffer.from([0xc3, 0xa9, 0x00, 0xff]) })
    expect(exited.buf).toEqual(Buffer.from([0xc3, 0xa9, 0x00, 0xff]))
  })
})

describe("the host's bounds, as execFile's (HI-2078)", { timeout: 60_000 }, () => {
  /** A host of the test's own (in no job), told to go. */
  const own = (): { host: GitHost; child: ReturnType<typeof startGitHost>['child'] } => {
    const { child } = startGitHost(baseEnv())
    const host = new GitHost(child, () => undefined)
    host.go()
    return { host, child }
  }
  const endless = (dir: string, stream: 'stdout' | 'stderr') =>
    `require('fs').writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid)); const b = Buffer.alloc(4096, 120); (function w() { process.${stream}.write(b, w) })()`

  for (const stream of ['stdout', 'stderr'] as const)
    it(`${stream} past its maxBuffer before it exits: ended there (its child by its handle), nothing past the bound, a request beside it its own`, async () => {
      const { host, child } = own()
      try {
        const dir = tempDir('bound-')
        const beside = host.request({ command: process.execPath, args: ['-e', `setTimeout(() => process.stdout.write('beside'), 500)`], cwd: dir, env: baseEnv() })
        const bounded = host.request({ command: process.execPath, args: ['-e', endless(dir, stream)], cwd: dir, env: baseEnv(), maxBuffer: 100_000 })
        const r = await bounded
        expect(r).toMatchObject({ code: null, bounded: 'maxBuffer' })
        expect(r.alive).toBeUndefined()
        expect((stream === 'stdout' ? r.outBuf : r.errBuf).length).toBeLessThanOrEqual(100_000)
        await goneByFile(join(dir, 'pid'))
        expect(await beside).toMatchObject({ out: 'beside', code: 0 })
      } finally {
        child.stdin?.end()
        child.kill()
      }
    })

  it('past its timeout: ended (bounded timeout)', async () => {
    const { host, child } = own()
    try {
      const dir = tempDir('bound-')
      const r = await host.request({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid)); setInterval(() => {}, 1000)`], cwd: dir, env: baseEnv(), timeout: 2000 })
      expect(r).toMatchObject({ code: null, bounded: 'timeout' })
      await goneByFile(join(dir, 'pid'))
    } finally {
      child.stdin?.end()
      child.kill()
    }
  })
})

interface World {
  project: string
  root: string
  store: FactStore
  close: () => void
}

function world(): World {
  const ws = join(tempDir('qgr-'), 'ws')
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

const acquire = async (w: World): Promise<QueueRunner> => {
  const a = await QueueRunner.acquire({ store: w.store, project: w.project, target: 'main', root: w.root, profile: 'A' })
  if (!a.ok) throw new Error('not acquired')
  return a.runner
}

/** An fsmonitor hook (a test-owned node script) that writes its pid and waits for ever: a `status` that blocks in it. */
function blockingHook(signal: AbortSignal): { args: string[]; ready: Promise<Listed> } {
  // A timed-out test body can resume when cleanup ends its pending git. It must not start another fixture afterward.
  signal.throwIfAborted()
  const since = Date.now()
  const dir = tempDir('qgr-hook-')
  const pidFile = join(dir, 'pid')
  const hook = join(dir, 'hook.cjs')
  writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  const ready = identifyHook(pidFile, since)
  observing.push(ready)
  void ready.catch(() => {}) // Its owner or afterEach observes the rejection, even if the test fails first.
  return { args: ['-c', `core.fsmonitor="${fwd(process.execPath)}" "${fwd(hook)}"`, 'status', '--porcelain'], ready }
}

/** What a result says, for comparing two (its bytes as bytes). */
const shape = (r: GitResult) => ({ ok: r.ok, code: r.code, out: r.out, err: r.err, buf: r.buf.toString('hex'), missing: r.missing, notRun: r.notRun, timedOut: r.timedOut })

describe('git() through the runner, against the worker (HI-2078)', { timeout: 120_000 }, () => {
  it('the same answers: binary output, an exit 1, input, a missing folder, git missing (noted), git running again (noted), a bound', async () => {
    const w = world()
    const runner = await acquire(w)
    const was = gitTool()
    try {
      writeFileSync(join(w.project, 'bin.dat'), Buffer.from([0, 1, 2, 0xff, 0xfe, 0x0a, 0x0d, 0x80]))
      sh(w.project, 'add', 'bin.dat')
      sh(w.project, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'bin')
      const route = (m: Parameters<GitRoute>[0]) => runner.gitOutcome(m)
      const both = async (cwd: string, args: string[], maxBuffer?: number, input?: string, opts = {}) => {
        countWorker()
        const plain = await git(cwd, args, maxBuffer, input, opts)
        const viaHost = await withGitRoute(route, () => git(cwd, args, maxBuffer, input, opts))
        expect(worker).toBe(1)
        return [shape(plain), shape(viaHost)]
      }
      const same = async (...a: Parameters<typeof both>) => {
        const [plain, viaHost] = await both(...a)
        expect(viaHost).toEqual(plain)
        return viaHost
      }
      expect((await same(w.project, ['cat-file', 'blob', 'HEAD:bin.dat'])).buf).toBe('000102fffe0a0d80')
      expect(await same(w.project, ['config', '--get', 'no.such'])).toMatchObject({ ok: false, code: 1 })
      expect((await same(w.project, ['hash-object', '--stdin'], undefined, 'hello\n')).out.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
      expect(await same(join(w.root, 'no-such-folder'), ['status'])).toMatchObject({ ok: false, code: -1, notRun: 'ENOENT' })
      // Output past its bound: execFile's code, never git's answer. Zero is a bound: any byte, on either output, is past it.
      expect(await same(w.project, ['rev-parse', 'HEAD'], 10)).toMatchObject({ ok: false, code: -1, notRun: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      expect(await same(w.project, ['rev-parse', 'HEAD'], 0)).toMatchObject({ ok: false, code: -1, notRun: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      expect(await same(w.project, ['rev-parse', '--verify', 'no-such-ref'], 0)).toMatchObject({ ok: false, code: -1, notRun: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      expect(await same(w.project, ['diff', '--quiet', 'HEAD', 'HEAD'], 0)).toMatchObject({ ok: true, code: 0, out: '' })
      // A bound that isn't one: refused as execFile refuses it, either way.
      await expect(git(w.project, ['status'], -1)).rejects.toMatchObject({ code: 'ERR_OUT_OF_RANGE' })
      await expect(withGitRoute(route, () => git(w.project, ['status'], -1))).rejects.toMatchObject({ code: 'ERR_OUT_OF_RANGE' })
      // git missing (no PATH to it): noted as missing either way; then a git that runs notes it ran.
      setGitToolForTests({ state: 'ok', version: '2', path: 'git' })
      const noGit = { env: { ...baseEnv(), PATH: tempDir('no-git-') } }
      countWorker()
      expect(await git(w.project, ['status'], undefined, undefined, noGit)).toMatchObject({ missing: true, code: -1 })
      expect(gitTool().state).toBe('missing')
      setGitToolForTests({ state: 'ok', version: '2', path: 'git' })
      expect(await withGitRoute(route, () => git(w.project, ['status'], undefined, undefined, noGit))).toMatchObject({ missing: true, code: -1 })
      expect(gitTool().state).toBe('missing')
      expect(await withGitRoute(route, () => git(w.project, ['rev-parse', 'HEAD']))).toMatchObject({ ok: true })
      expect(gitTool().state).not.toBe('missing')
      expect(worker).toBe(1)
    } finally {
      setGitToolForTests(was)
      await runner.release()
      w.close()
    }
  })

  it("a change's key and its containment past 1 MiB of patch (escapes and other scripts in it): the same either way, never unknown", async () => {
    const w = world()
    const runner = await acquire(w)
    try {
      const route = (m: Parameters<GitRoute>[0]) => runner.gitOutcome(m)
      // About 1.5 MiB of patch: quotes, backslashes, tabs, a JSON-looking line, and characters of other scripts.
      const line = (i: number): string => `${i}\t"quoted" \\back\\slash {"id":${i},"x":"\\n"} héllo wörld ✓ 𝄞 日本語 🐝\n`
      const body = Array.from({ length: 18_000 }, (_, i) => line(i)).join('')
      expect(Buffer.byteLength(body)).toBeGreaterThan(1.4 * 1024 * 1024)
      const base = sh(w.project, 'rev-parse', 'HEAD')
      const main = sh(w.project, 'rev-parse', '--abbrev-ref', 'HEAD')
      sh(w.project, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(w.project, 'big.txt'), body)
      sh(w.project, 'add', 'big.txt')
      sh(w.project, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'big')
      const revision = sh(w.project, 'rev-parse', 'HEAD')
      // The same change squashed onto the target: containment keys the target's commits by patch-id, its input that log.
      sh(w.project, 'checkout', '-q', main)
      sh(w.project, 'merge', '-q', '--squash', 'feature')
      sh(w.project, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'squashed')
      countWorker()
      const plainKey = await G.candidateKey(w.project, base, revision)
      const plainIn = await G.contains(w.project, main, { base, revision })
      expect(worker).toBeGreaterThan(0)
      countWorker()
      const [key, held] = await withGitRoute(route, async () => [await G.candidateKey(w.project, base, revision), await G.contains(w.project, main, { base, revision })] as const)
      expect(worker).toBe(0)
      expect(typeof plainKey).toBe('string')
      expect(key).toBe(plainKey)
      expect(plainIn).toMatchObject({ method: expect.any(String) })
      expect(held).toEqual(plainIn)
    } finally {
      await runner.release()
      w.close()
    }
  })

  it('a timeout: timed out either way, never an answer; the routed one ended with its git', async ({ signal }) => {
    const w = world()
    const runner = await acquire(w)
    try {
      const plainHook = blockingHook(signal)
      const plainRead = git(w.project, plainHook.args, undefined, undefined, { timeout: 3000 })
      reading.push(plainRead)
      // Observe before awaiting the timeout: Git's launcher can exit leaving its real git, conhost and hook behind.
      await plainHook.ready
      const plain = await plainRead
      const hook = blockingHook(signal)
      const hostedRead = withGitRoute((m) => runner.gitOutcome(m), () => git(w.project, hook.args, undefined, undefined, { timeout: 3000 }))
      reading.push(hostedRead)
      const left = await hook.ready
      const viaHost = await hostedRead
      expect(shape(viaHost)).toMatchObject({ ok: false, code: -1, notRun: 'SIGTERM', timedOut: true })
      expect(shape(viaHost)).toEqual({ ...shape(plain), err: shape(viaHost).err })
      // Its hook is in the lease's job: the release ends it.
      await runner.release()
      await ends(left)
    } finally {
      await runner.release()
      w.close()
    }
  })

  it('a read blocked in a hook when the lease is released: ended with the job, and never an answer', async ({ signal }) => {
    const w = world()
    const runner = await acquire(w)
    try {
      const hook = blockingHook(signal)
      const read = withGitRoute((m) => runner.gitOutcome(m), () => git(w.project, hook.args))
      reading.push(read)
      const blocked = await hook.ready
      await runner.release()
      expect(await read).toMatchObject({ ok: false, code: -1, notRun: 'hostLost' })
      await ends(blocked)
    } finally {
      await runner.release()
      w.close()
    }
  })

  for (const how of ['released', 'taken over'] as const)
    it(`a queue step resumed after its lease was ${how}: nothing starts (no host request, no worker), never an answer`, async () => {
      const w = world()
      const runner = await acquire(w)
      try {
        const requests = vi.spyOn(GitHost.prototype, 'request')
        let firstDone = false
        let resume = (): void => undefined
        const paused = new Promise<void>((res) => (resume = res))
        const step = withGitRoute(
          (m) => runner.gitOutcome(m),
          async () => {
            const first = await git(w.project, ['rev-parse', 'HEAD'])
            firstDone = true
            await paused
            countWorker()
            return [first, await git(w.project, ['rev-parse', 'HEAD'])] as const
          }
        )
        await vi.waitFor(() => expect(firstDone).toBe(true), { timeout: 30_000, interval: 50 })
        if (how === 'released') await runner.release()
        else {
          const now = w.store.queueLease('main')!
          w.store.takeQueueLease({ ...now, lease: 'successor', token: 'successor', profile: 'B', pid: 1 }, now.token)
        }
        resume()
        const [first, after] = await step
        expect(first).toMatchObject({ ok: true })
        expect(after).toMatchObject({ ok: false, code: -1, notRun: 'leaseLost' })
        expect(requests).toHaveBeenCalledTimes(1)
        expect(worker).toBe(0)
      } finally {
        await runner.release()
        w.store.dropQueueLease('successor', 'successor')
        w.close()
      }
    })
})

describe('a whole drain routed (HI-2078)', { timeout: 180_000 }, () => {
  it("both cards merged, every git the queue's work ran in the lease's host, none on the worker", async () => {
    const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } }))
    for (const [title, file] of [['A', 'a.txt'], ['B', 'b.txt']]) {
      const card = e.wf.createCard({ title })
      const s = await e.wf.start(card.key, B1)
      moved(s)
      commit(s.data!.folder as string, { [file]: `${title}\n` }, `${card.key}: ${title}`)
      moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
      moved(await e.wf.startReview(card.key, R1))
      moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    }
    const a = await QueueRunner.acquire({ store: e.store, project: e.project, target: 'main', root: join(e.home, 'worktrees'), profile: 'P' })
    if (!a.ok) throw new Error('not acquired')
    const runner = a.runner
    try {
      const requests = vi.spyOn(GitHost.prototype, 'request')
      countWorker()
      const q = e.queue({ git: (cwd, args, opts) => runner.git(cwd, args, 'testMerge', opts), holds: () => runner.holds() })
      const out = await withGitRoute((m) => runner.gitOutcome(m), () => q.drain('main'))
      expect(out.map((x) => x.outcome)).toEqual(['integrated', 'integrated'])
      expect(worker).toBe(0)
      // The platform's reads (worktree list, status…) and the queue's own git, all in the host.
      expect(requests.mock.calls.some(([s]) => s.args.includes('worktree') && s.args.includes('list'))).toBe(true)
      expect(requests.mock.calls.length).toBeGreaterThan(20)
    } finally {
      await runner.release()
    }
  })
})
