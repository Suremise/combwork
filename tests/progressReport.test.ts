// Progress reporters (#137): the hive-progress wrapper (main/progressReporters/wrapper.ts) and the reporting it shares with the
// test runners (main/progressReporters/report.mts), against a stand-in for #136's Agent API: output and exit codes pass
// through; Combwork reachable, unreachable or absent; step lines; estimates after one run; updates coalesced.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { join } from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateFor, evictionOrder, KEEP_KEYS, ProgressRun, progressTarget, recordTiming, wrappedLines } from '../src/main/progressReporters/report.mts'
import { cmdEscapeArgument, commandEnv, commandLabel, isolatedPollDelay, KEEPALIVE_MS, keepAliveDue, parseArgs, parseProcessList, replyTimeoutMs, runWrapped, spawnSpec, StepFilter, stepLine, timingKey, treeToEnd, uncountedLine, wasInterrupted, type WrapperIo } from '../src/main/progressReporters/wrapper'
import { installShims, shimFiles, withBinOnPath } from '../src/main/progressReporters/shims'
import { removeOldShims } from '../src/main/nameUpgradeProfile'
import { combworkInstructions, progressRule, wrapsLongCommands } from '../src/shared/combworkGuidance'
import { STALE_GRACE_MS } from '../src/shared/progress'
import { launchParts } from '../src/main/guidance'
import { tempDir } from './tempDir'
// A process by its identity (pid and start time), never by a remembered pid alone (#603).
type Identity = { pid: number; started: number }
const { identify, stillSame, endExactly } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Identity[]; stillSame: (ids: Identity[]) => number[]; endExactly: (ids: Identity[]) => number }

const dir = tempDir('hive-progress-')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// Nothing under test may end the test's own process (#547: a worker once exited mid-file, dropping 19 tests): a call
// to process.exit fails the test that made it, with where it came from.
const realExit = process.exit
beforeAll(() => {
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? ''}) in the test's own process`)
  }) as typeof process.exit
})
afterAll(() => {
  process.exit = realExit
})

/**
 * The stand-in Agent API: records each call; `refuse` answers the start with 401. Each call is also written to `seenFile`
 * as it arrives, so a command run under the wrapper can wait for what the wrapper has reported (`seenNode` below) instead of
 * guessing how long that takes on a loaded machine.
 */
const calls: { method: string; path: string; auth: string; body: Record<string, unknown> }[] = []
/**
 * What a run is for, asked before its command starts (#1220: POST /v1/progress/resolve), kept apart from `calls`; the
 * stand-in answers as `resolveReply` says: by default 404, as a Combwork from before it does (the run isn't linked).
 */
const resolves: Record<string, unknown>[] = []
let resolveReply: { status: number; body: Record<string, unknown> } | 'hang' = { status: 404, body: { error: 'No such route' } }
/** How long the stand-in holds a resolve before answering it (HI-1892: a slow Combwork). */
let resolveDelayMs = 0
/**
 * How the stand-in takes a run's start and finish (HI-1892): `hangStart`, its start never answered; `hangFinish`, no
 * finish answered; `hangFinishOnce`, the first finish taken but not answered, a second refused as Combwork does (409).
 */
let lose: 'none' | 'hangStart' | 'hangFinish' | 'hangFinishOnce' = 'none'
/** How long the stand-in holds a run's start before taking it (HR2's round 1: a start Combwork takes late, in time). */
let startDelayMs = 0
/** What the stand-in answers a run's finish (#1654: how a check's run counted). */
let finishReply: Record<string, unknown> = {}
// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000
const seenFile = join(dir, 'seen.json')
/** The agent's token in its file, as a session has it (HI-2262: never CW_API_TOKEN). */
const agentTokenFile = join(dir, 'agent-token.json')
writeFileSync(agentTokenFile, JSON.stringify({ token: 'agent-token' }))
let refuse = false
let server: Server
let url = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      if (req.url === '/v1/progress/resolve') {
        resolves.push(raw ? JSON.parse(raw) : {})
        // 'hang': it never answers (the wrapper's own timeout ends the wait).
        if (resolveReply === 'hang') return
        const reply = resolveReply
        const answer = () => {
          res.setHeader('Content-Type', 'application/json')
          res.writeHead(reply.status).end(JSON.stringify(reply.body))
        }
        if (resolveDelayMs) return void setTimeout(answer, resolveDelayMs)
        return answer()
      }
      calls.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : {} })
      writeFileSync(seenFile, JSON.stringify(calls))
      res.setHeader('Content-Type', 'application/json')
      if (refuse) return res.writeHead(401).end('{"error":"no"}')
      if (lose === 'hangStart' && req.method === 'POST' && req.url === '/v1/progress') return
      if (startDelayMs && req.method === 'POST' && req.url === '/v1/progress') return void setTimeout(() => res.end(JSON.stringify({ id: `run-${calls.length}` })), startDelayMs)
      if (req.method === 'POST' && req.url?.endsWith('/finish')) {
        if (lose === 'hangFinish') return
        if (lose === 'hangFinishOnce') return calls.filter((c) => c.path.endsWith('/finish')).length > 1 ? res.writeHead(409).end('{"error":"That run has finished"}') : undefined
        return res.end(JSON.stringify(finishReply))
      }
      res.end(req.method === 'POST' && req.url === '/v1/progress' ? JSON.stringify({ id: `run-${calls.length}` }) : '{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => {
  calls.length = 0
  resolves.length = 0
  resolveReply = { status: 404, body: { error: 'No such route' } }
  resolveDelayMs = 0
  startDelayMs = 0
  lose = 'none'
  finishReply = {}
  refuse = false
  rmSync(seenFile, { force: true })
})

const node = process.execPath
const env = (extra: Record<string, string | undefined> = {}) => ({ ...process.env, CW_API_URL: url, CW_API_TOKEN: undefined, CW_PROGRESS_DATA: join(dir, 'data'), CW_PROGRESS: undefined, CW_API_TOKEN_FILE: agentTokenFile,CW_WORKSPACE: undefined, CW_PROGRESS_WRAPPED: undefined, CW_TEST_SEEN: seenFile, ...extra })
/**
 * Runs the wrapper, collecting what it writes. By default the run is reported only at a step line with the total, or at
 * the end, however long the command takes to start; `startWaitMs` 0 reports it at once, before the command's output.
 */
async function wrap(argv: string[], e: Record<string, string | undefined>, startWaitMs = 60_000, cwd = dir, more: Partial<WrapperIo> = { resolveTimeoutMs: 1000 }) {
  let out = ''
  let err = ''
  const code = await runWrapped(argv, { env: e, cwd, stdout: { write: (b) => (out += String(b)) }, stderr: { write: (b) => (err += String(b)) }, stdin: 'ignore', minIntervalMs: 100, startWaitMs, ...more })
  return { code, out, err }
}
/**
 * Node with `seen(c => …)` for its script: it resolves once the stand-in API's calls so far pass the test, so the command
 * goes on only after the wrapper has reported what it should have; after 10 s it goes on anyway (the test's assertions
 * then fail, rather than the test hanging).
 */
const seenJs = join(dir, 'seen.js')
writeFileSync(seenJs, "globalThis.seen = (p) => new Promise((r) => { const end = Date.now() + 10000; const t = setInterval(() => { let c = []; try { c = JSON.parse(require('fs').readFileSync(process.env.CW_TEST_SEEN, 'utf8')) } catch {} if (p(c) || Date.now() > end) { clearInterval(t); r() } }, 10) })")
const seenNode = [node, '-r', seenJs]

describe('the hive-progress command line', () => {
  it('reads --title and the command after --, or the first word that is not an option', () => {
    expect(parseArgs(['--title', 'e2e', '--', 'npm', 'run', 'e2e'])).toEqual({ title: 'e2e', command: ['npm', 'run', 'e2e'] })
    expect(parseArgs(['--title=Build', 'npm', 'run', 'dist'])).toEqual({ title: 'Build', command: ['npm', 'run', 'dist'] })
    expect(parseArgs(['--', 'node', '--version'])).toEqual({ title: undefined, command: ['node', '--version'] })
    // A focused test's check (HI-1367) runs your command; any other check refuses one.
    expect(parseArgs(['--check', 'focused:board', '--', 'npm', 'run', 'e2e', '--', 'board'])).toMatchObject({ check: 'focused:board', command: ['npm', 'run', 'e2e', '--', 'board'] })
    expect(parseArgs(['--check', 'focused:board'])).toHaveProperty('error')
    expect(parseArgs(['--check', 'lint', '--', 'npm', 'run', 'lint'])).toHaveProperty('error')
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs(['--'])).toHaveProperty('error')
    expect(parseArgs(['--colour', 'x'])).toHaveProperty('error')
  })

  it('reads what a run is for: --card, --revision and --check (#1220), with --check taking no command of its own', () => {
    expect(parseArgs(['--card', '#12', '--revision', 'a3f2c1d', '--', 'npm', 'test'])).toEqual({ card: '#12', revision: 'a3f2c1d', command: ['npm', 'test'] })
    expect(parseArgs(['--card=#12', 'npm', 'test'])).toEqual({ card: '#12', command: ['npm', 'test'] })
    expect(parseArgs(['--check', 'typecheck'])).toEqual({ check: 'typecheck', command: [] })
    expect(parseArgs(['--check=typecheck', '--title', 'types', '--card', '#12'])).toEqual({ check: 'typecheck', title: 'types', card: '#12', command: [] })
    expect(parseArgs(['--check', 'typecheck', '--', 'npm', 'run', 'typecheck'])).toEqual({ error: "--check runs the project's command for typecheck: give no command of your own." })
    // --isolated (#1435): a check in a copy of its own, so only with --check.
    expect(parseArgs(['--check', 'test', '--isolated'])).toEqual({ check: 'test', isolated: true, command: [] })
    expect(parseArgs(['--isolated', '--check=test'])).toEqual({ check: 'test', isolated: true, command: [] })
    expect(parseArgs(['--isolated', '--', 'npm', 'test'])).toMatchObject({ error: expect.stringContaining('use it with --check') })
    // A shell took an unquoted "#12" for a comment: name the key (HI-1661), and say how to quote the old form.
    expect(parseArgs(['--card'])).toMatchObject({ error: expect.stringContaining('--card HI-12') })
    expect(parseArgs(['--card'])).toMatchObject({ error: expect.stringContaining('--card "#1061" needs its quotes') })
    expect(parseArgs(['--card', '#12'])).toEqual({ error: 'No command given.' })
  })

  it('reads wait lines: what it waits for (the rest of the line), or nothing when it waits no more (#549)', () => {
    expect(stepLine('##cw-progress wait=waiting for a test slot: held by B4 (hb4)\n')).toEqual({ wait: 'waiting for a test slot: held by B4 (hb4)' })
    expect(stepLine('##cw-progress wait=\r\n')).toEqual({ wait: '' })
  })

  it('reads step lines (##cw-progress); anything else is not one, the old ##hive-progress included (HI-2594)', () => {
    expect(stepLine('##cw-progress step=4 total=12 name=carddialog\n')).toEqual({ step: 4, total: 12, name: 'carddialog' })
    expect(stepLine('##cw-progress wait=waiting for a test slot\r\n')).toEqual({ wait: 'waiting for a test slot' })
    expect(stepLine('##hive-progress step=4 total=12 name=carddialog\n')).toBeNull()
    expect(stepLine('##hive-progress wait=x\n')).toBeNull()
    expect(stepLine('##cw-progress step=2 name=unit tests: tips\r\n')).toEqual({ step: 2, name: 'unit tests: tips' })
    expect(stepLine('##cw-progress total=3')).toEqual({ total: 3 })
    // A log the command wrote (#220): the rest of the line, spaces and all.
    expect(stepLine('##cw-progress log=C:\\logs\\my run\\run-record.md\r\n')).toEqual({ log: 'C:\\logs\\my run\\run-record.md' })
    expect(stepLine('##cw-progress step=x')).toEqual({})
    expect(stepLine('##cw-progressive step=1')).toBeNull()
    expect(stepLine(' ##cw-progress step=1')).toBeNull()
  })

  it('takes step lines out of the output, however the chunks split, and holds back nothing else', () => {
    const run = (chunks: string[]) => {
      const out: string[] = []
      const steps: unknown[] = []
      const f = new StepFilter((b) => out.push(b.toString()), (u) => steps.push(u))
      for (const c of chunks) f.push(Buffer.from(c))
      const before = out.join('')
      f.end()
      return { before, out: out.join(''), steps }
    }
    expect(run(['a\n##cw-pro', 'gress step=1 total=2 name=x\nb\n'])).toEqual({ before: 'a\nb\n', out: 'a\nb\n', steps: [{ step: 1, total: 2, name: 'x' }] })
    // The old opening is the command's own output (HI-2594), however it splits.
    expect(run(['a\n##hive-pro', 'gress step=1 total=2 name=x\nb\n'])).toEqual({ before: 'a\n##hive-progress step=1 total=2 name=x\nb\n', out: 'a\n##hive-progress step=1 total=2 name=x\nb\n', steps: [] })
    expect(run(['##c', 'w-progressive\n'])).toMatchObject({ out: '##cw-progressive\n', steps: [] })
    // A prompt without a newline shows at once; a held line that ends up not a step line comes out whole.
    expect(run(['Continue? '])).toMatchObject({ before: 'Continue? ' })
    expect(run(['##cw', '-progressive\n'])).toMatchObject({ out: '##cw-progressive\n', steps: [] })
    expect(run(['x ##cw-progress step=1\n'])).toMatchObject({ out: 'x ##cw-progress step=1\n', steps: [] })
    // The last line without a newline: a step all the same.
    expect(run(['done\n##cw-progress step=3'])).toMatchObject({ out: 'done\n', steps: [{ step: 3 }] })
  })

  it('shows the command line quoted where needed, and keeps timings under a hash, not the command', () => {
    expect(commandLabel(['node', '-e', 'console.log("hi")'])).toBe('node -e "console.log(\\"hi\\")"')
    expect(commandLabel(['npm', 'run', 'e2e', '--', 'tips'])).toBe('npm run e2e -- tips')
    expect(timingKey('C:\\P', ['npm', 'test'])).toBe(timingKey('c:\\p', ['npm', 'test']))
    expect(timingKey('C:\\P', ['npm', 'test'])).not.toBe(timingKey('C:\\P', ['npm', 'test', 'x']))
    expect(timingKey('C:\\P', ['npm', 'test'])).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe.runIf(process.platform === 'win32')('stopping a command on Windows (#549 round 2)', () => {
  it("ends what the command started too: a .cmd launcher's server is gone, and the run ends stopped", async () => {
    // serve.cmd runs a Node server, as npm.cmd or a project's script does: cmd, then node under it.
    const pidFile = join(dir, 'server.pid')
    rmSync(pidFile, { force: true })
    const serverJs = join(dir, 'server.js')
    writeFileSync(serverJs, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
    const serve = join(dir, 'serve.cmd')
    writeFileSync(serve, `@echo off\r\n"${node}" "${serverJs}"\r\n`)
    const stop: NodeJS.Signals = 'SIGUSR2'
    const going = runWrapped(['--', serve], { env: env(), cwd: dir, stdout: { write: () => true }, stderr: { write: () => true }, stdin: 'ignore', minIntervalMs: 100, startWaitMs: 0, signals: [stop] })
    await vi.waitFor(() => expect(existsSync(pidFile) && calls.length > 0).toBe(true), { timeout: 15_000 })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // Its identity while it is known to be the server: the checks and the clean-up never take a later process with its pid.
    const serverId = identify([pid])
    const alive = (): boolean => stillSame(serverId).length === 1
    expect(alive()).toBe(true)
    try {
      // Stopped twice: ended at once, with the server under cmd.
      process.emit(stop)
      process.emit(stop)
      expect(await going).not.toBe(0)
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 30_000 })
      expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, stopped: true, summary: 'interrupted' } })
    } finally {
      endExactly(serverId)
    }
    // Bounds for a hung run, not waits: the test and the stop start PowerShell five times or more in a row (identify,
    // each alive(), the stop's list and end), and under a full e2e set one start took up to 21 s (#616).
  }, 90_000)
})

describe('which processes stopping a command ends (#655)', () => {
  it('its tree, children first, but never an older process whose parent id is the command\'s reused pid, nor what that one started', () => {
    // 100 is the command (cmd), started at 5000; 200 the server under it, 300 the server's worker. 400 started at 4000,
    // its parent id 100 from a process that ended before the command got that pid: an orphan, not the command's. 500 is
    // its child (started after it, so its child indeed), and 600 is unrelated.
    const list = [
      { pid: 100, parent: 4, started: 5000 },
      { pid: 200, parent: 100, started: 5010 },
      { pid: 300, parent: 200, started: 5020 },
      { pid: 400, parent: 100, started: 4000 },
      { pid: 500, parent: 400, started: 6000 },
      { pid: 600, parent: 4, started: 5005 }
    ]
    expect(treeToEnd(list, 100).map((p) => p.pid)).toEqual([300, 200, 100])
    // One started in the same millisecond as its parent is its child (the stamps are only as fine as a millisecond).
    expect(treeToEnd([...list, { pid: 700, parent: 100, started: 5000 }], 100).map((p) => p.pid)).toEqual([700, 300, 200, 100])
    // A command already gone ends nothing by its pid; a parent-id loop (two reused pids) is walked once.
    expect(treeToEnd(list, 999)).toEqual([])
    expect(treeToEnd([{ pid: 1, parent: 2, started: 10 }, { pid: 2, parent: 1, started: 10 }], 1).map((p) => p.pid)).toEqual([2, 1])
  })

  it('reads the process list as PowerShell prints it, skipping lines that are not a process', () => {
    expect(parseProcessList('0 0 0\r\n4 0 1700000000000\r\n\r\n 812 4 1700000000123 \r\nWARNING: x\r\n')).toEqual([
      { pid: 4, parent: 0, started: 1700000000000 },
      { pid: 812, parent: 4, started: 1700000000123 }
    ])
  })
})

describe.runIf(process.platform === 'win32')('starting a command on Windows', () => {
  it('runs an .exe directly, and anything else through cmd with each argument arriving as given', () => {
    expect(spawnSpec([node, '-v'], process.env, dir)).toMatchObject({ file: node, verbatim: false })
    const shim = join(dir, 'args.cmd')
    writeFileSync(shim, `@"${node}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`)
    const args = ['plain', 'two words', 'say "hi"', 'a&b|c', '100%', 'up^caret', 'trail\\', '(x)', '']
    const spec = spawnSpec([shim, ...args], process.env, dir)
    expect(spec).toMatchObject({ verbatim: true, args: ['/d', '/s', '/c', expect.any(String)] })
    const got = spawnSync(spec.file, spec.args, { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(got)).toEqual(args)
    expect(cmdEscapeArgument('a"b')).toBe('^"a\\^"b^"')
  })
})

describe('what a run is for (#1220): its card, revision and check, asked before the command starts', () => {
  const id = 'c'.repeat(40)

  it("starts the run with what Combwork resolved, asking with the folder and what was named", async () => {
    resolveReply = { status: 200, body: { link: 'L1', card: '#12', revision: id, testedCheckout: id, check: null, folder: dir } }
    expect(await wrap(['--card', '#12', '--', node, '-e', "console.log('ran')"], env(), 0)).toEqual({ code: 0, out: 'ran\n', err: '' })
    expect(resolves).toEqual([{ folder: dir, card: '#12' }])
    // The link Combwork gave is passed back (Combwork keeps what it read then); no checkout is sent as if it were proof.
    expect(calls[0].body).toMatchObject({ link: 'L1', card: '#12', revision: id, folder: dir })
    expect(calls[0].body).not.toHaveProperty('testedCheckout')
    expect(calls[0].body).not.toHaveProperty('check')
  })

  it('a run Combwork gives no card says so (card: null), so none is defaulted at the start', async () => {
    resolveReply = { status: 200, body: { card: null, revision: null, testedCheckout: null, check: null, folder: dir } }
    await wrap(['--', node, '-e', '0'], env(), 0)
    expect(resolves).toEqual([{ folder: dir }])
    expect(calls[0].body).toMatchObject({ card: null, folder: dir })
    expect(calls[0].body).not.toHaveProperty('revision')
  })

  it('a refusal (a revision that is not checked out) ends it at once: the command never runs and nothing is reported', async () => {
    resolveReply = { status: 400, body: { error: "a3f2c1d isn't what's checked out here (b71e09a is): check it out first, or leave revision out" } }
    const marker = join(dir, 'ran-refused.txt')
    const r = await wrap(['--revision', 'a3f2c1d', '--', node, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], env(), 0)
    expect(r).toEqual({ code: 2, out: '', err: "cw-progress: a3f2c1d isn't what's checked out here (b71e09a is): check it out first, or leave revision out\n" })
    expect(existsSync(marker)).toBe(false)
    expect(calls).toEqual([])
  })

  it("--check runs the project's configured command, titled by the check's name", async () => {
    const marker = join(dir, 'ran-check.txt')
    // Short on any machine (the marker named from the folder it runs in): a command over the API's 200 characters is clipped.
    const command = `"${node}" -e "require('fs').writeFileSync('ran-check.txt', 'checked')"`
    expect(command.length).toBeLessThan(200)
    resolveReply = { status: 200, body: { card: '#12', revision: id, testedCheckout: id, check: { name: 'typecheck', command }, folder: dir } }
    const r = await wrap(['--check', 'typecheck'], env(), 0)
    expect(r.code).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('checked')
    expect(resolves).toEqual([{ folder: dir, check: 'typecheck' }])
    expect(calls[0].body).toMatchObject({ title: 'typecheck', command, check: 'typecheck', card: '#12' })
    expect(calls[0].body).not.toHaveProperty('titleFromCommand')
    // Its exit code is the command's.
    resolveReply = { status: 200, body: { card: null, revision: null, testedCheckout: null, check: { name: 'test', command: `"${node}" -e "process.exit(4)"` }, folder: dir } }
    expect((await wrap(['--check', 'test'], env(), 0)).code).toBe(4)
  })

  it('--check with no command configured, Combwork unreachable or outside Combwork runs nothing and says why', async () => {
    resolveReply = { status: 400, body: { error: 'hive has no command configured for the check "lint", so nothing was run.' } }
    expect(await wrap(['--check', 'lint'], env(), 0)).toEqual({ code: 2, out: '', err: 'cw-progress: hive has no command configured for the check "lint", so nothing was run.\n' })
    // A Combwork from before (no resolve call: 404) doesn't know the command either.
    resolveReply = { status: 404, body: { error: 'No such route' } }
    expect(await wrap(['--check', 'lint'], env(), 0)).toMatchObject({ code: 2, err: expect.stringContaining("Combwork couldn't be reached to look up the command for lint") })
    expect(await wrap(['--check', 'lint'], env({ CW_API_URL: undefined }), 0)).toMatchObject({ code: 2, err: expect.stringContaining('only Combwork knows') })
    expect(calls).toEqual([])
  })

  it("a --revision is checked with git when Combwork can't check it: reporting off, outside Combwork, an older Combwork, an error, no answer (round 1's finding 2)", async () => {
    const repoDir = join(dir, 'revision-repo')
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repoDir, encoding: 'utf8' }).stdout.trim()
    spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
    writeFileSync(join(repoDir, 'a.txt'), 'a\n')
    g('add', '-A')
    g('commit', '-qm', 'one')
    writeFileSync(join(repoDir, 'a.txt'), 'b\n')
    g('commit', '-qam', 'two')
    const head = g('rev-parse', 'HEAD')
    const marker = join(dir, 'ran-revision.txt')
    const ran = ['--', node, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]
    const ways: [string, () => Record<string, string | undefined>][] = [
      ['reporting off', () => env({ CW_PROGRESS: '0' })],
      ['outside Combwork', () => env({ CW_API_URL: undefined })],
      ['an older Combwork (404)', () => ((resolveReply = { status: 404, body: { error: 'No such route' } }), env())],
      ['an error (500)', () => ((resolveReply = { status: 500, body: { error: 'boom' } }), env())],
      ['no answer', () => ((resolveReply = 'hang'), env())],
      ['nothing listening', () => env({ CW_API_URL: 'http://127.0.0.1:9' })]
    ]
    for (const [way, e] of ways) {
      rmSync(marker, { force: true })
      const wrong = await wrap(['--revision', 'HEAD~1', ...ran], e(), 0, repoDir)
      expect({ way, ...wrong }).toEqual({ way, code: 2, out: '', err: `cw-progress: HEAD~1 isn't what's checked out here (${head.slice(0, 7)} is): check it out first, or leave --revision out\n` })
      expect(existsSync(marker)).toBe(false)
      expect((await wrap(['--revision', 'not-a-commit', ...ran], e(), 0, repoDir)).err).toContain("not-a-commit isn't a commit in")
      expect((await wrap(['--revision', '--all', ...ran], e(), 0, repoDir)).err).toContain('revision is a commit')
      // Where git has nothing to compare with, it isn't taken either.
      expect((await wrap(['--revision', head, ...ran], e(), 0, dir)).err).toContain('Nothing is checked out')
      expect(existsSync(marker)).toBe(false)
      // The revision checked out runs.
      expect({ way, code: (await wrap(['--revision', head.slice(0, 7), ...ran], e(), 0, repoDir)).code }).toEqual({ way, code: 0 })
      expect(existsSync(marker)).toBe(true)
    }
  })

  it("a check's run that didn't count says why, in one line with what to do; its exit code is the command's (#1654)", async () => {
    resolveReply = { status: 200, body: { card: 'HI-12', revision: id, testedCheckout: id, check: { name: 'typecheck', command: `"${node}" -e "0"` }, folder: dir } }
    finishReply = { ok: true, check: { name: 'typecheck', counted: false, whyNot: 'changed', changes: ['src/a.ts', ':reflog'], platform: 'git' } }
    expect(await wrap(['--check', 'typecheck'], env(), 0)).toEqual({ code: 0, out: '', err: 'cw-progress: not counted as check typecheck: files changed in the folder while it ran (src/a.ts, a commit or checkout). Run it again with nothing else writing in the folder, or with --isolated (a check copy of its own).\n' })
    // Counted, or a Combwork that doesn't say: nothing more is printed.
    finishReply = { ok: true, check: { name: 'typecheck', counted: true, platform: 'git' } }
    expect((await wrap(['--check', 'typecheck'], env(), 0)).err).toBe('')
    finishReply = { ok: true }
    expect((await wrap(['--check', 'typecheck'], env(), 0)).err).toBe('')
    // A run that wasn't started as a check says nothing either, whatever Combwork answers.
    resolveReply = { status: 200, body: { card: 'HI-12', revision: id, testedCheckout: id, check: null, folder: dir } }
    finishReply = { ok: true, check: { name: 'node', counted: false, whyNot: 'notCheck', platform: 'git' } }
    expect(await wrap(['--', node, '-e', 'process.exit(3)'], env(), 0)).toEqual({ code: 3, out: '', err: '' })
  })

  it("waits for Combwork's reply as its setting says (HI-1892): a resolve held past 5 s, answered within it, runs the check and records it", async () => {
    resolveReply = { status: 200, body: { card: 'HI-12', revision: null, testedCheckout: null, check: { name: 'typecheck', command: `"${node}" -e "0"` }, folder: dir } }
    resolveDelayMs = 5500
    finishReply = { ok: true, check: { name: 'typecheck', counted: true, platform: 'git' } }
    // No timeout of the test's own: the one Combwork hands the session (8 s here), as a session gets it.
    const r = await wrap(['--check', 'typecheck'], env({ CW_PROGRESS_REPLY_SECONDS: '8' }), 0, dir, {})
    expect(r).toEqual({ code: 0, out: '', err: '' })
    expect(resolves).toHaveLength(1)
    expect(calls.map((c) => [c.method, c.path.replace(/run-\d+/, 'ID'), c.body.check ?? c.body.ok])).toEqual([
      ['POST', '/v1/progress', 'typecheck'],
      ['POST', '/v1/progress/ID/finish', true]
    ])
  }, 30_000)

  it("the setting's reply time, within 1 s and 2 minutes whatever is set; 15 s without it (HI-1892)", () => {
    expect(replyTimeoutMs({})).toBe(15_000)
    expect(replyTimeoutMs({ CW_PROGRESS_REPLY_SECONDS: '40' })).toBe(40_000)
    expect(replyTimeoutMs({ CW_PROGRESS_REPLY_SECONDS: '100000' })).toBe(120_000)
    expect(replyTimeoutMs({ CW_PROGRESS_REPLY_SECONDS: '0.2' })).toBe(1000)
    expect(replyTimeoutMs({ CW_PROGRESS_REPLY_SECONDS: 'soon' })).toBe(15_000)
  })

  it('a check with no reply asks once more, then runs nothing and says Combwork is slow; a refused connection says it couldn\'t be reached at once, asking once (HI-1892)', async () => {
    resolveReply = 'hang'
    const slow = await wrap(['--check', 'lint'], env(), 0, dir, { resolveTimeoutMs: 1000, retryMs: 50 })
    expect(slow).toEqual({ code: 2, out: '', err: 'cw-progress: Combwork is slow to answer: no reply to look up the command for lint in 1 s, asked 2 times, so nothing was run. Try again; Settings → Advanced → "cw-progress: Combwork\'s reply time" gives it longer.\n' })
    expect(resolves).toHaveLength(2)
    // Nothing listens at the address: no retry, and none of the minute it would otherwise wait.
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const gone = `http://127.0.0.1:${(closed.address() as { port: number }).port}`
    await new Promise<void>((r) => closed.close(() => r()))
    const from = Date.now()
    const refused = await wrap(['--check', 'lint'], env({ CW_API_URL: gone }), 0, dir, { resolveTimeoutMs: 60_000, retryMs: 60_000 })
    expect(Date.now() - from).toBeLessThan(HUNG_MS)
    expect(refused).toMatchObject({ code: 2, out: '' })
    expect(refused.err).toBe(`cw-progress: Combwork couldn't be reached to look up the command for lint (connection refused at ${gone}), so nothing was run. Is Combwork running? A sandbox that blocks local network access (Claude Code's Bash sandbox does) stops it too: run the command outside the sandbox.\n`)
    expect(calls).toEqual([])
  })

  it("a check's result Combwork didn't confirm is sent once more, and hive-progress says when it may not be recorded (HI-1889's lost report); its exit code is the command's", async () => {
    resolveReply = { status: 200, body: { card: 'HI-12', revision: null, testedCheckout: null, check: { name: 'typecheck', command: `"${node}" -e "0"` }, folder: dir } }
    const quick = { resolveTimeoutMs: 1000, retryMs: 50, checkFinishWaitMs: 500 }
    const finishes = () => calls.filter((c) => c.path.endsWith('/finish')).length
    // The first finish arrived, its reply lost: the one sent again is refused (it has finished), so it was recorded.
    lose = 'hangFinishOnce'
    expect(await wrap(['--check', 'typecheck'], env(), 0, dir, quick)).toEqual({ code: 0, out: '', err: "cw-progress: Combwork recorded check typecheck, but its reply was lost, so how it counted isn't known.\n" })
    expect(finishes()).toBe(2)
    // No reply to either.
    calls.length = 0
    lose = 'hangFinish'
    expect(await wrap(['--check', 'typecheck'], env(), 0, dir, quick)).toEqual({ code: 0, out: '', err: "cw-progress: Combwork didn't confirm it recorded check typecheck (no reply to its result, asked twice): if submitting says it hasn't passed, run it again.\n" })
    expect(finishes()).toBe(2)
    // Its start never taken: nothing of it was recorded.
    calls.length = 0
    lose = 'hangStart'
    expect(await wrap(['--check', 'typecheck'], env(), 0, dir, quick)).toEqual({ code: 0, out: '', err: "cw-progress: Combwork didn't take this run's report (no reply in time), so check typecheck wasn't recorded: run it again.\n" })
    expect(finishes()).toBe(0)
    // A plain run's finish is never sent again, and says nothing.
    calls.length = 0
    lose = 'hangFinish'
    resolveReply = { status: 404, body: { error: 'No such route' } }
    expect(await wrap(['--', node, '-e', 'process.exit(3)'], env(), 0, dir, quick)).toEqual({ code: 3, out: '', err: '' })
    expect(finishes()).toBe(1)
  }, 30_000)

  it("a quick check's start Combwork takes late but within its time is followed by its finish, never given up first (HR2's round 1)", async () => {
    // Its finish's own budget (twice 300 ms and a 50 ms pause) is shorter than the start's wait: the start's time comes first.
    startDelayMs = 1500
    const run = new ProgressRun({ url, token: 'agent-token', workspace: '' }, { title: 'quick', check: 'typecheck' }, { startTimeoutMs: 5000 })
    await run.finish(true, undefined, 300, {}, 50)
    expect(run.finishedAs()).toBe('answered')
    expect(calls.map((c) => [c.method, c.path.replace(/run-\d+/, 'ID')])).toEqual([
      ['POST', '/v1/progress'],
      ['POST', '/v1/progress/ID/finish']
    ])
  })

  it('says why for each reason a check run is not counted (#1654)', () => {
    const line = (whyNot: string, more: Record<string, unknown> = {}, isolated = false) => uncountedLine({ check: { name: 'lint', counted: false, whyNot, platform: 'git', ...more } }, isolated)
    expect(line('notCheck')).toBe("not counted as check lint: Combwork didn't see the check's configured command run. Run it again with cw-progress --check lint.")
    expect(line('notContained')).toBe("not counted as check lint: what is checked out here doesn't contain the card's revision. Run it in the card's own folder, at its revision.")
    expect(line('dirty', { changes: ['new.txt'] })).toBe('not counted as check lint: the folder had uncommitted changes (new.txt). Commit or remove them, then run it again.')
    expect(line('moved')).toBe('not counted as check lint: something else was checked out by the time it ended. Run it again.')
    expect(line('changed', { changes: [':edit'] })).toBe("not counted as check lint: files changed in the folder while it ran (an agent's edit). Run it again with nothing else writing in the folder, or with --isolated (a check copy of its own).")
    expect(line('revisionChanged', { platform: 'none' })).toBe("not counted as check lint: the card's declared files changed while it ran. Run it again.")
    // --isolated is offered only where it is a remedy: on Git, for a run that wasn't isolated already.
    expect(line('changed', { platform: 'none' })).toBe('not counted as check lint: files changed in the folder while it ran. Run it again with nothing else writing in the folder.')
    expect(line('changed', {}, true)).toBe('not counted as check lint: files changed in the folder while it ran. Run it again with nothing else writing in the folder.')
    for (const answer of [null, {}, { check: { name: 'lint', counted: true } }, { check: { name: 'lint', counted: false, whyNot: 'someday' } }]) expect(uncountedLine(answer, false)).toBeNull()
  })

  it('an isolated check waiting for a check copy asks every 2 s for a minute, then less often, up to every 10 s (HI-1831)', () => {
    const delays: number[] = []
    let waited = 0
    let last = 0
    while (waited < 3_600_000) {
      last = isolatedPollDelay(waited, last)
      delays.push(last)
      waited += last
    }
    expect(delays.slice(0, 30).every((d) => d === 2000)).toBe(true)
    expect(delays.slice(30, 33)).toEqual([3000, 4500, 6750])
    expect(delays.at(-1)).toBe(10_000)
    // An hour's wait: about 380 asks, where it was 1,800.
    expect(delays.length).toBeLessThan(400)
    // A test's own interval stays the first, and never more than the backoff allows.
    expect(isolatedPollDelay(0, 0, 50)).toBe(50)
    expect(isolatedPollDelay(120_000, 50, 50)).toBe(75)
  })

  it('a Combwork from before (no resolve call) still gets the run, as before, unlinked', async () => {
    expect(await wrap(['--card', '#12', '--', node, '-e', '0'], env(), 0)).toMatchObject({ code: 0 })
    for (const k of ['card', 'revision', 'testedCheckout', 'check', 'folder']) expect(calls[0].body).not.toHaveProperty(k)
  })
})

describe('reporting a run', () => {
  it('reports start, steps and finish as the agent, passes output and the exit code through, and estimates after one run', async () => {
    const script = `console.log('one'); console.log('##cw-progress step=1 total=2 name=first'); console.error('warn'); console.log('##cw-progress step=2 name=second'); seen((c) => c.some((x) => x.body.stepName === 'second')).then(() => process.exit(3))`
    const r = await wrap(['--title', 'Build', '--', ...seenNode, '-e', script], env())
    expect(r).toEqual({ code: 3, out: 'one\n', err: 'warn\n' })
    // The first step line gives the total, so the run starts with it: step 1 of 2 starting is 0 finished.
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/progress', auth: 'Bearer agent-token' })
    // With its process (#549: once it is gone without a finish, Combwork says the run ended without a report).
    // Its own title: not the command line, so nothing says it is (#620).
    expect(calls[0].body).toEqual({ title: 'Build', total: 2, step: 0, stepName: 'first', command: expect.stringContaining('-e'), pid: process.pid })
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.every((c) => c.path === '/v1/progress/run-1')).toBe(true)
    expect(Object.assign({}, ...patches.map((c) => c.body))).toEqual({ step: 1, stepName: 'second' })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/progress/run-1/finish', body: { ok: false, summary: 'exit code 3', exitCode: 3 } })

    // A run that failed isn't timed; one that passed is, and the next run of the same command has its estimate: the
    // time left when its start is reported.
    const timings = join(dir, 'data', 'timings.json')
    expect(estimateFor(timings, timingKey(dir, [...seenNode, '-e', script]))).toBeUndefined()
    calls.length = 0
    // (Its start is reported before it ends: at the end, the run would already be timed.)
    const ok = [...seenNode, '-e', `seen((c) => c.length > 0).then(() => console.log('fine'))`]
    expect(await wrap(['--', ...ok], env(), 0)).toEqual({ code: 0, out: 'fine\n', err: '' })
    expect(calls[0].body).not.toHaveProperty('estimateMs')
    expect(calls.at(-1)?.body).toEqual({ ok: true, exitCode: 0 })
    expect(estimateFor(timings, timingKey(dir, ok))).toBeGreaterThanOrEqual(0)
    // Two long runs on record make the usual time ten minutes, so what is left of it when the start is reported doesn't
    // depend on how quickly this machine gets there.
    recordTiming(timings, timingKey(dir, ok), 600_000)
    recordTiming(timings, timingKey(dir, ok), 600_000)
    calls.length = 0
    await wrap(['--', ...ok], env(), 0)
    expect(calls[0].body.estimateMs).toBeGreaterThan(500_000)
    expect(calls[0].body.estimateMs).toBeLessThanOrEqual(600_000)
    // Titled with the command line (clipped: the temporary folder's path is long).
    expect(commandLabel(ok).startsWith(String(calls[0].body.title).replace(/…$/, ''))).toBe(true)
  })

  it("a command's output tells Combwork its run still goes, at most every keep-alive; a silent one sends nothing (HI-1993)", async () => {
    // A stress loop with no step lines, printing as it goes: it ends once Combwork has had a keep-alive (an empty update).
    const loud = `const t = setInterval(() => console.log('run'), 20); seen((c) => c.some((x) => x.method === 'PATCH')).then(() => { clearInterval(t) })`
    const r = await wrap(['--', ...seenNode, '-e', loud], env(), 0, dir, { resolveTimeoutMs: 1000, keepAliveMs: 50 })
    expect(r.code).toBe(0)
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.every((c) => c.path === '/v1/progress/run-1' && Object.keys(c.body).length === 0)).toBe(true)
    // A silent one: no keep-alive even with none due between them (an interval of 0), as only output sends one, so a
    // command that stopped reporting still goes stale. It ends once its start is reported.
    calls.length = 0
    const quiet = `seen((c) => c.length > 0)`
    await wrap(['--', ...seenNode, '-e', quiet], env(), 0, dir, { resolveTimeoutMs: 1000, keepAliveMs: 0 })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST'])
  })

  it('a keep-alive is due once its interval has passed since the last one, the start or a step, and not before (HI-1993)', () => {
    expect(keepAliveDue(1000, 1000)).toBe(false)
    expect(keepAliveDue(1000, 1000 + KEEPALIVE_MS - 1)).toBe(false)
    expect(keepAliveDue(1000, 1000 + KEEPALIVE_MS)).toBe(true)
    expect(keepAliveDue(1000, 1000 + 10 * KEEPALIVE_MS)).toBe(true)
    // An interval of its own (tests), and one well within a quiet run's grace before it shows as stale.
    expect(keepAliveDue(0, 49, 50)).toBe(false)
    expect(keepAliveDue(0, 50, 50)).toBe(true)
    expect(KEEPALIVE_MS).toBeLessThan(STALE_GRACE_MS)
  })

  it('a total given after the run started (no step line at first) is sent once, with the first update that has it (#145)', async () => {
    // The step lines come only once the start has been reported; the second total is ignored.
    const script = `seen((c) => c.length > 0).then(() => { console.log('##cw-progress step=2 total=5 name=late'); return seen((c) => c.some((x) => x.method === 'PATCH')) }).then(() => { console.log('##cw-progress step=3 total=9 name=later'); return seen((c) => c.some((x) => x.body.stepName === 'later')) })`
    await wrap(['--', ...seenNode, '-e', script], env(), 0)
    expect(calls[0].body).not.toHaveProperty('total')
    // No title of its own: its title is its command line, and the reporter says so, for the Agent API to name it by its program alone (#620).
    // (Here the command line is long: the title is cut shorter than the command, so the two differ.)
    expect(calls[0].body.titleFromCommand).toBe(true)
    expect(String(calls[0].body.command).startsWith(String(calls[0].body.title).replace(/…$/, ''))).toBe(true)
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.map((c) => c.body)).toEqual([
      { total: 5, step: 1, stepName: 'late' },
      { step: 2, stepName: 'later' }
    ])
  })

  it('with Combwork unreachable, refusing, absent or turned off: the command runs as usual and nothing fails', async () => {
    const cmd = ['--', node, '-e', "console.log('out'); process.exit(4)"]
    const t0 = Date.now()
    expect(await wrap(cmd, env({ CW_API_URL: 'http://127.0.0.1:9' }))).toEqual({ code: 4, out: 'out\n', err: '' })
    expect(Date.now() - t0).toBeLessThan(5000)
    refuse = true
    expect(await wrap(cmd, env())).toEqual({ code: 4, out: 'out\n', err: '' })
    expect(calls.map((c) => c.path)).toEqual(['/v1/progress'])
    refuse = false
    calls.length = 0
    // Not reporting, the command has the console itself (nothing to collect here): only its exit code is checked.
    const quiet = ['--', node, '-e', 'process.exit(5)']
    expect((await wrap(quiet, env({ CW_API_URL: undefined }))).code).toBe(5)
    expect((await wrap(quiet, env({ CW_API_TOKEN_FILE: undefined }))).code).toBe(5)
    // HI-2262: a token in CW_API_TOKEN alone is no target (sessions get only the file).
    expect((await wrap(quiet, env({ CW_API_TOKEN_FILE: undefined, CW_API_TOKEN: 'agent-token' }))).code).toBe(5)
    expect((await wrap(quiet, env({ CW_PROGRESS: '0' }))).code).toBe(5)
    expect(calls).toEqual([])
  })

  it('a command that is not there fails as a shell would, still reported as failed', async () => {
    const r = await wrap(['--', 'hive-no-such-command-137'], env())
    expect(r.code).not.toBe(0)
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false } })
  })

  it('a wait (#549): the run starts waiting at once, says what for and when it waits no more; then its steps', async () => {
    const script = `console.log('##cw-progress wait=waiting for a test slot: held by B4'); seen((c) => c.some((x) => x.body.waiting)).then(() => { console.log('##cw-progress wait='); console.log('##cw-progress step=1 total=2 name=first'); return seen((c) => c.some((x) => x.body.stepName === 'first')) })`
    const r = await wrap(['--title', 'Queued', '--', ...seenNode, '-e', script], env())
    expect(r.code).toBe(0)
    expect(calls[0]).toMatchObject({ method: 'POST', body: { title: 'Queued', waiting: 'waiting for a test slot: held by B4', pid: process.pid } })
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
    expect(Object.assign({}, ...patches)).toMatchObject({ waiting: '', total: 2, step: 0, stepName: 'first' })
    expect(r.out).toBe('')
  })

  it('stopped (#549): a command ended by Ctrl+C (its exit code), or hive-progress told to stop, is reported as stopped, not failed', async () => {
    expect([wasInterrupted(0xc000013a, null, false), wasInterrupted(-1073741510, null, false), wasInterrupted(130, null, false), wasInterrupted(1, 'SIGINT', false), wasInterrupted(1, null, true)]).toEqual([true, true, true, true, true])
    expect([wasInterrupted(1, null, false), wasInterrupted(3, null, false)]).toEqual([false, false])
    // Its exit code says Ctrl+C ended it.
    const r = await wrap(['--', node, '-e', 'process.exit(-1073741510)'], env(), 0)
    expect([3221225786, -1073741510]).toContain(r.code)
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, stopped: true, summary: 'interrupted' } })
    // Told to stop (a stop signal, here one of the test's own): the command gets a moment, then is ended; the run is stopped.
    calls.length = 0
    const stop: NodeJS.Signals = 'SIGUSR2'
    const going = runWrapped(['--', ...seenNode, '-e', `seen((c) => c.length > 0).then(() => setInterval(() => {}, 1000))`], { env: env(), cwd: dir, stdout: { write: () => true }, stderr: { write: () => true }, stdin: 'ignore', minIntervalMs: 100, startWaitMs: 0, signals: [stop] })
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000 })
    // The first stop gives it a moment; a second ends it at once.
    process.emit(stop)
    process.emit(stop)
    expect(await going).not.toBe(0)
    expect(calls.at(-1)).toMatchObject({ body: { ok: false, stopped: true, summary: 'interrupted' } })
    expect(process.listenerCount(stop)).toBe(0)
  })

  it('told to stop, a command that then shuts down cleanly (exit 0) is still stopped, its exit code kept, and never timed (#549 round 2)', async () => {
    const stopFile = join(dir, 'graceful-stop')
    rmSync(stopFile, { force: true })
    // A server that shuts down by itself, cleanly, once told (here: its stop file), as one handling Ctrl+C does.
    const cmd = [...seenNode, '-e', `seen((c) => c.length > 0).then(() => setInterval(() => require('fs').existsSync(${JSON.stringify(stopFile)}) && process.exit(0), 20))`]
    const stop: NodeJS.Signals = 'SIGUSR2'
    const going = runWrapped(['--', ...cmd], { env: env(), cwd: dir, stdout: { write: () => true }, stderr: { write: () => true }, stdin: 'ignore', minIntervalMs: 100, startWaitMs: 0, signals: [stop] })
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000 })
    process.emit(stop)
    writeFileSync(stopFile, '')
    expect(await going).toBe(0)
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, stopped: true, summary: 'interrupted', exitCode: 0 } })
    expect(estimateFor(join(dir, 'data', 'timings.json'), timingKey(dir, cmd))).toBeUndefined()
  })

  it('coalesces quick updates: the latest state wins, in order, and the finish comes last', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `##cw-progress step=${i + 1} total=200 name=s${i + 1}`).join('\\n')
    await wrap(['--', ...seenNode, '-e', `console.log('${lines}'); seen((c) => c.some((x) => x.body.stepName === 's200'))`], env())
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.length).toBeLessThan(10)
    expect(calls[0].body).toMatchObject({ total: 200, step: 0, stepName: 's1' })
    expect(patches.at(-1)?.body).toMatchObject({ step: 199, stepName: 's200' })
    expect(calls.at(-1)?.path).toBe('/v1/progress/run-1/finish')
  })
})

describe('the shared reporter and timings', () => {
  it('finds its target: the agent token from the file Combwork keeps it in, never CW_API_TOKEN (HI-2262); CW_PROGRESS=0 turns it off', () => {
    const file = join(dir, 'token.json')
    writeFileSync(file, JSON.stringify({ token: 'from-file' }))
    expect(progressTarget({ CW_API_URL: 'http://h/', CW_API_TOKEN_FILE: file, CW_WORKSPACE: 'W' })).toEqual({ url: 'http://h', token: 'from-file', workspace: 'W' })
    // The file's, whatever CW_API_TOKEN says; with it alone, no target.
    expect(progressTarget({ CW_API_URL: 'http://h', CW_API_TOKEN: 't', CW_API_TOKEN_FILE: file })?.token).toBe('from-file')
    expect(progressTarget({ CW_API_URL: 'http://h', CW_API_TOKEN: 't' })).toBeNull()
    expect(progressTarget({ CW_API_URL: 'http://h', CW_API_TOKEN_FILE: join(dir, 'no-such-token.json') })).toBeNull()
    expect(progressTarget({ CW_API_URL: 'http://h' })).toBeNull()
    expect(progressTarget({ CW_API_TOKEN_FILE: file })).toBeNull()
    expect(progressTarget({ CW_API_URL: 'http://h', CW_API_TOKEN_FILE: file, CW_PROGRESS: '0' })).toBeNull()
  })

  it('sends the workspace, clips long text, and does nothing at all without a target', async () => {
    const r = new ProgressRun({ url, token: 't', workspace: 'C:\\Work space' }, { title: 'x'.repeat(500), total: 3.4, estimateMs: -1 })
    expect(await r.reporting()).toBe(true)
    await r.finish(true)
    // The API's limit for titles is 120 characters; a step can't go past the total.
    expect(calls[0].body).toEqual({ title: expect.stringMatching(/^x{119}…$/), total: 3, pid: process.pid })
    calls.length = 0
    const capped = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'y', total: 2 }, { minIntervalMs: 10 })
    capped.update({ step: 9 })
    // A run with a total keeps it.
    capped.update({ total: 20 })
    // (A finish drops an update not sent yet: each is finished once its update has arrived.)
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1), { timeout: HUNG_MS })
    await capped.finish(true)
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ step: 2 })
    calls.length = 0
    // A late total, once: a step merged in before it is kept within it, and steps after it are capped by it.
    const late = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'late' }, { minIntervalMs: 10 })
    late.update({ step: 9, stepName: 'setup' })
    late.update({ total: 4 })
    late.update({ total: 7 })
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1), { timeout: HUNG_MS })
    await late.finish(true)
    const quick = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'late, then a step' }, { minIntervalMs: 10 })
    quick.update({ total: 3 })
    quick.update({ step: 8 })
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2), { timeout: HUNG_MS })
    await quick.finish(true)
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ total: 4, step: 4, stepName: 'setup' }, { total: 3, step: 3 }])
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/v1/progress').map((c) => c.body)).toEqual([{ title: 'late', pid: process.pid }, { title: 'late, then a step', pid: process.pid }])
    calls.length = 2
    const none = new ProgressRun(null, { title: 'x' })
    none.update({ step: 1 })
    await none.finish(false)
    expect(await none.reporting()).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('a finish can name the exit code and a log; inside hive-progress the log goes to the wrapper as a line (#220)', async () => {
    const r = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'with log' })
    await r.finish(false, '2 failed', undefined, { exitCode: 1, logPath: 'C:\\logs\\run-record.md' })
    expect(calls.at(-1)?.body).toEqual({ ok: false, summary: '2 failed', exitCode: 1, logPath: 'C:\\logs\\run-record.md' })
    const lines: string[] = []
    const inner = new ProgressRun(null, { title: 'inner' }, { lines: (l) => lines.push(l) })
    await inner.finish(true, undefined, undefined, { logPath: 'C:\\logs\\run 2' })
    expect(lines).toEqual(['##cw-progress log=C:\\logs\\run 2'])
    // The wrapper takes the line out of the output and sends the log with the command's exit code.
    calls.length = 0
    const script = `console.log('##cw-progress log=C:\\\\logs\\\\run-record.md'); console.log('done'); process.exit(4)`
    expect(await wrap(['--', ...seenNode, '-e', script], env(), 0)).toEqual({ code: 4, out: 'done\n', err: '' })
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, summary: 'exit code 4', exitCode: 4, logPath: 'C:\\logs\\run-record.md' } })
  })

  it('a late total still waiting to be sent goes out before the finish, passed or failed; other pending updates are dropped', async () => {
    for (const ok of [false, true]) {
      calls.length = 0
      // A long interval: once the first update is sent, the next waits, and the finish comes before it would be sent.
      const r = new ProgressRun({ url, token: 't', workspace: '' }, { title: `late ${ok}` }, { minIntervalMs: 60_000 })
      r.update({ step: 1 })
      await vi.waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true), { timeout: HUNG_MS })
      r.update({ total: 4, step: 2, stepName: 'late' })
      await r.finish(ok, ok ? undefined : 'exit code 1')
      expect(calls.map((c) => [c.method, c.path.replace(/run-\d+/, 'run'), c.body])).toEqual([
        ['POST', '/v1/progress', { title: `late ${ok}`, pid: process.pid }],
        ['PATCH', '/v1/progress/run', { step: 1 }],
        ['PATCH', '/v1/progress/run', { total: 4, step: 2, stepName: 'late' }],
        ['POST', '/v1/progress/run/finish', ok ? { ok } : { ok, summary: 'exit code 1' }]
      ])
    }
    calls.length = 0
    const plain = new ProgressRun({ url, token: 't', workspace: '' }, { title: 'plain', total: 3 }, { minIntervalMs: 60_000 })
    plain.update({ step: 1 })
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true), { timeout: HUNG_MS })
    plain.update({ step: 2, total: 9 })
    await plain.finish(true)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST'])
  })

  it('estimates from the median of the last five runs, keeps the newest keys, and survives a damaged file', () => {
    const file = join(dir, 'timings', 'timings.json')
    expect(estimateFor(file, 'k')).toBeUndefined()
    for (const ms of [100, 900, 200, 300, 250, 260]) recordTiming(file, 'k', ms)
    expect(estimateFor(file, 'k')).toBe(260)
    // A full file (written as it would be, rather than a thousand records), then six more keys run once: each pushes out
    // the oldest key run once.
    const runs = JSON.parse(readFileSync(file, 'utf8')).runs
    for (let i = 0; i < KEEP_KEYS - 1; i++) runs[`k${i}`] = { ms: [1], at: 1000 + i }
    writeFileSync(file, JSON.stringify({ version: 1, runs }))
    for (let i = KEEP_KEYS - 1; i < KEEP_KEYS + 5; i++) recordTiming(file, `k${i}`, 1, 1000 + i)
    expect(estimateFor(file, 'k0')).toBeUndefined()
    expect(estimateFor(file, 'k5')).toBeUndefined()
    expect(estimateFor(file, 'k6')).toBe(1)
    expect(estimateFor(file, `k${KEEP_KEYS + 4}`)).toBe(1)
    // 'k', with a history, outlasts a file's worth of keys run once (#1549).
    expect(estimateFor(file, 'k')).toBe(260)
    writeFileSync(file, '{ damaged')
    expect(estimateFor(file, `k${KEEP_KEYS + 4}`)).toBeUndefined()
    recordTiming(file, 'k', 50)
    expect(estimateFor(file, 'k')).toBe(50)
  })

  // #1549: a full file gives up the keys run once first, then those with a history, each oldest first; never the key
  // just recorded.
  /** A timings file holding `runs`, as recordTiming writes it. */
  const timingsWith = (name: string, runs: Record<string, { ms: number[]; at: number }>): string => {
    const file = join(dir, name, 'timings.json')
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, runs }))
    return file
  }

  it('evicts keys run once before keys with a history, oldest first, never the one just recorded', () => {
    const runs = { suite: { ms: [5, 6], at: 1 }, probe: { ms: [1], at: 3 }, daily: { ms: [7, 8, 9], at: 2 }, old: { ms: [1], at: 0 }, now: { ms: [1], at: 9 } }
    expect(evictionOrder(runs, 'now')).toEqual(['old', 'probe', 'suite', 'daily'])
    // A file full of keys with a history keeps a new key: the oldest with a history goes instead.
    const file = timingsWith('timings-full', Object.fromEntries([...Array(KEEP_KEYS).keys()].map((i) => [`h${i}`, { ms: [1, 2], at: 1000 + i }])))
    recordTiming(file, 'new', 3, 5000)
    expect(estimateFor(file, 'new')).toBe(3)
    expect(estimateFor(file, 'h0')).toBeUndefined()
    expect(estimateFor(file, 'h1')).toBe(1)
  })

  it("a day of several lanes' one-off keys leaves every suite's estimate (#1549)", () => {
    // 300 suites run twice in the morning, then a file's worth of one-off keys (probe folders' commands, unit-test
    // selections), and 300 more recorded on top: the file is full of one-offs, each new one pushing out the oldest.
    const suites = [...Array(300).keys()].map((i) => [`e2e:s${i}`, { ms: [10, 20], at: 1000 + i }])
    const onceKeys = [...Array(KEEP_KEYS - 300).keys()].map((i) => [`once${i}`, { ms: [1], at: 10_000 + i }])
    const file = timingsWith('timings-day', Object.fromEntries([...suites, ...onceKeys]))
    for (let i = KEEP_KEYS - 300; i < KEEP_KEYS; i++) recordTiming(file, `once${i}`, 1, 10_000 + i)
    expect([...Array(300).keys()].every((i) => estimateFor(file, `e2e:s${i}`) === 10)).toBe(true)
    expect(estimateFor(file, 'once0')).toBeUndefined()
    expect(estimateFor(file, `once${KEEP_KEYS - 1}`)).toBe(1)
  })
})

describe("the hive-progress command on a session's PATH (main/progressReporters/shims.ts)", () => {
  it('puts the bin folder first on PATH, once, whatever the variable is called', () => {
    expect(withBinOnPath({ Path: 'C:\\a;C:\\Combwork\\bin;C:\\b' }, 'C:\\Combwork\\bin')).toEqual({ Path: 'C:\\Combwork\\bin;C:\\a;C:\\b' })
    expect(withBinOnPath({ PATH: '/usr/bin' }, '/h/bin', ':')).toEqual({ PATH: '/h/bin:/usr/bin' })
    expect(withBinOnPath({ X: '1' }, null)).toEqual({ X: '1' })
  })

  it('the .cmd and sh shims start the script with Combwork as Node, passing every argument through and the exit code back', async () => {
    const bin = join(dir, 'bin dir')
    // A stand-in for hive-progress.js: shows what it was given, and ends with the code it was asked for.
    const script = join(dir, 'echo args.js')
    writeFileSync(script, "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), data: process.env.CW_PROGRESS_DATA, node: process.env.ELECTRON_RUN_AS_NODE, callers: process.env.CW_PROGRESS_RUN_AS_NODE || null })); process.exit(Number(process.argv.at(-1)) || 0)")
    const data = join(dir, 'data dir')
    expect(await installShims(bin, { exec: node, script, data })).toBe(bin)
    const args = ['--title', 'two words', '--', 'node', 'a&b', '7']
    // The caller's own ELECTRON_RUN_AS_NODE (usually none) is kept for the command, beside the shim's.
    const base = { ...process.env }
    delete base.ELECTRON_RUN_AS_NODE
    const name = 'cw-progress'
    for (const callers of [null, '1']) {
      const callerEnv = callers ? { ...base, ELECTRON_RUN_AS_NODE: callers } : base
      if (process.platform === 'win32') {
        // As typed at a cmd prompt.
        const line = [join(bin, `${name}.cmd`), ...args].map((a) => (/[\s&]/.test(a) ? `"${a}"` : a)).join(' ')
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: callerEnv })
        expect([r.status, JSON.parse(r.stdout)]).toEqual([7, { args, data, node: '1', callers }])
      }
      const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/sh'
      if (existsSync(bash)) {
        const r = spawnSync(bash, [join(bin, name).replace(/\\/g, '/'), ...args], { encoding: 'utf8', env: callerEnv })
        const got = JSON.parse(r.stdout)
        expect([r.status, got.args, got.node, got.data.replace(/\//g, '\\'), got.callers]).toEqual([7, args, '1', data, callers])
      }
    }
    // Written again only when they change.
    const { mtimeMs } = statSync(join(bin, 'cw-progress.cmd'))
    await installShims(bin, { exec: node, script, data })
    expect(statSync(join(bin, 'cw-progress.cmd')).mtimeMs).toBe(mtimeMs)
    // Only cw-progress: the old name isn't made (HI-2594).
    expect(existsSync(join(bin, 'hive-progress'))).toBe(false)
    expect(existsSync(join(bin, 'hive-progress.cmd'))).toBe(false)
    const files = shimFiles({ exec: 'C:\\H\\Combwork.exe', script: 'C:\\H\\x.js', data: 'C:\\D' })
    expect(Object.keys(files).sort()).toEqual(['cw-progress', 'cw-progress.cmd'])
    expect(files['cw-progress']).toBe(
      "#!/bin/sh\nCW_PROGRESS_RUN_AS_NODE=\"${ELECTRON_RUN_AS_NODE-}\" ELECTRON_RUN_AS_NODE=1 CW_PROGRESS_DATA='C:/D' exec 'C:/H/Combwork.exe' 'C:/H/x.js' \"$@\"\n"
    )
  })

  it("the names upgrade removes the old command's shims from the bin folder, and leaves cw-progress's (HI-2594)", async () => {
    const bin = join(dir, 'old bin')
    mkdirSync(bin, { recursive: true })
    for (const f of ['hive-progress', 'hive-progress.cmd', 'cw-progress', 'cw-progress.cmd', 'other.cmd']) writeFileSync(join(bin, f), f)
    await removeOldShims(bin)
    expect(readdirSync(bin).sort()).toEqual(['cw-progress', 'cw-progress.cmd', 'other.cmd'])
    // Again, and on a folder that isn't there: nothing to do.
    await removeOldShims(bin)
    await removeOldShims(join(dir, 'no bin'))
  })

  it("the command doesn't get what started hive-progress: in Combwork's executable, ELECTRON_RUN_AS_NODE is the caller's own again", async () => {
    const shimmed = { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', CW_PROGRESS_DATA: 'd', CW_PROGRESS_RUN_AS_NODE: undefined, CW_API_URL: 'u' }
    expect(commandEnv(shimmed, true)).toEqual({ PATH: 'p', CW_API_URL: 'u' })
    expect(commandEnv({ ...shimmed, CW_PROGRESS_RUN_AS_NODE: '1' }, true)).toEqual({ PATH: 'p', CW_API_URL: 'u', ELECTRON_RUN_AS_NODE: '1' })
    // Run by plain Node, the variable is the caller's: left alone.
    expect(commandEnv(shimmed, false)).toEqual({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', CW_API_URL: 'u' })
    // The command itself, reporting on, unavailable and off: no ELECTRON_RUN_AS_NODE, no CW_PROGRESS_DATA.
    const probe = ['--', node, '-e', 'process.exit(process.env.ELECTRON_RUN_AS_NODE || process.env.CW_PROGRESS_DATA ? 23 : 0)']
    const viaShim = { ELECTRON_RUN_AS_NODE: '1' }
    for (const e of [env(viaShim), env({ ...viaShim, CW_API_URL: 'http://127.0.0.1:9' }), env({ ...viaShim, CW_PROGRESS: '0' })]) {
      const code = await runWrapped(probe, { env: e, cwd: dir, stdout: { write: () => true }, stderr: { write: () => true }, stdin: 'ignore', startWaitMs: 50, viaElectron: true })
      expect(code).toBe(0)
    }
  })
})

describe('a reporter inside a command hive-progress runs: one row, the wrapper\'s (#167)', () => {
  it('the command is told it is wrapped; a reporter in it then has no target and prints step lines instead', () => {
    expect(progressTarget({ CW_API_URL: 'http://h', CW_API_TOKEN_FILE: agentTokenFile, CW_PROGRESS_WRAPPED: '1' })).toBeNull()
    expect(wrappedLines({ CW_PROGRESS_WRAPPED: '1' })).toBeTypeOf('function')
    expect(wrappedLines({ CW_PROGRESS_WRAPPED: '1', CW_PROGRESS: '0' })).toBeUndefined()
    expect(wrappedLines({})).toBeUndefined()
    const lines: string[] = []
    const r = new ProgressRun(null, { title: 'e2e', total: 3, step: 0, stepName: 'a' }, { lines: (l) => lines.push(l) })
    r.update({ step: 1, stepName: 'b' })
    r.update({ estimateMs: 5000 })
    r.update({ step: 3 })
    // The API counts the steps finished; a step line names the one starting (from 1, at most the total).
    expect(lines).toEqual(['##cw-progress step=1 total=3 name=a', '##cw-progress step=2 name=b', '##cw-progress step=3'])
    // A reporter that learns its total late prints it once, for the wrapper's run to take.
    lines.length = 0
    const late = new ProgressRun(null, { title: 'unit' }, { lines: (l) => lines.push(l) })
    late.update({ step: 1, stepName: 'a' })
    late.update({ total: 4 })
    late.update({ total: 6, step: 2 })
    expect(lines).toEqual(['##cw-progress step=2 name=a', '##cw-progress step=2 total=4', '##cw-progress step=3'])
  })

  it('a reporter run under hive-progress shows in its run: one row with the total and steps', async () => {
    const report = pathToFileURL(join(__dirname, '..', 'src', 'main', 'progressReporters', 'report.mts')).href
    // The way Combwork's runners report (tests/progressReport.mts): a run of their own, or step lines when wrapped.
    const script = `import(${JSON.stringify(report)}).then(async (m) => { const r = new m.ProgressRun(m.progressTarget(), { title: 'inner', total: 3, step: 0, stepName: 'a' }, { lines: m.wrappedLines() }); r.update({ step: 1, stepName: 'b' }); await seen((c) => c.some((x) => x.body.stepName === 'b')); await r.finish(true) })`
    const r = await wrap(['--title', 'outer', '--', ...seenNode, '-e', script], env())
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/v1/progress').map((c) => c.body)).toEqual([expect.objectContaining({ title: 'outer', total: 3, step: 0, stepName: 'a' })])
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ step: 1, stepName: 'b' }])
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: true } })
  })
})

describe("agents told to run long commands through hive-progress (Settings → General, #167)", () => {
  it('by default, while the Progress panel is on; otherwise only when the user asks', () => {
    expect(wrapsLongCommands(undefined)).toBe(true)
    expect(wrapsLongCommands({ progressPanel: true, progressCommands: true })).toBe(true)
    expect(wrapsLongCommands({ progressPanel: true, progressCommands: false })).toBe(false)
    expect(wrapsLongCommands({ progressPanel: false, progressCommands: true })).toBe(false)
    expect(combworkInstructions('web')).toContain(progressRule(true))
    expect(progressRule(true)).toMatch(/over 30 s.*in the background too.*`cw-progress --title "<what and why, in a few words>" -- <command>`/)
    expect(combworkInstructions('web', 'agent', false)).toContain(progressRule(false))
    expect(progressRule(false)).toMatch(/only when the user asks/)
    expect(combworkInstructions('', 'assistant')).not.toMatch(/hive-progress/)
  })

  it("a launch's guidance is measured as the contract it got, either way", () => {
    for (const on of [true, false]) {
      const parts = launchParts(`${combworkInstructions('web', 'agent', on)}\nLatest.`, 'agent', 'web', null)
      expect(parts.customChars, String(on)).toBe('\nLatest.'.length)
    }
  })
})

describe("Combwork's own test runners (tests/progressReport.mts)", () => {
  const saved = { ...process.env }
  beforeEach(() => {
    Object.assign(process.env, { CW_API_URL: url, CW_API_TOKEN_FILE: agentTokenFile, CW_TEST_PROGRESS_TIMINGS: join(dir, 'runner-timings.json') })
    for (const k of ['CW_API_TOKEN', 'CW_WORKSPACE', 'CW_PROGRESS', 'CW_PROGRESS_WRAPPED']) delete process.env[k]
  })
  afterAll(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('waiting for a test slot (#549): its own row starts waiting; under hive-progress, wait lines for the wrapper, and one saying the wait is over', async () => {
    const { slotWaitProgress } = await import('./progressReport.mts')
    const own = slotWaitProgress('e2e', 'npm run e2e -- --all', [])
    own.waiting('B4 (hb4)')
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: HUNG_MS })
    expect(calls[0].body).toEqual({ title: 'e2e: waiting for a test slot', command: 'npm run e2e -- --all', waiting: 'waiting for a test slot: B4 (hb4)', pid: process.pid })
    // The test slots' own wording (HI-2070): the whole line, what is ahead, as slots.mjs waitSummary puts it.
    own.waitingAs("waiting for a test slot (2 heavy runs ahead: HB6's scenarios: 151 (fake), HB4's e2e: 4 suites × 5)")
    await vi.waitFor(() => expect(calls.at(-1)?.body).toEqual({ waiting: "waiting for a test slot (2 heavy runs ahead: HB6's scenarios: 151 (fake), HB4's e2e: 4 suites × 5)" }), { timeout: HUNG_MS })
    await own.finish('got a test slot after 3 s')
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: true, summary: 'got a test slot after 3 s' } })
    calls.length = 0
    process.env.CW_PROGRESS_WRAPPED = '1'
    const lines: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true))
    try {
      const wrapped = slotWaitProgress('e2e', 'npm run e2e -- --all', [])
      wrapped.waiting('B4 (hb4)')
      wrapped.waiting('B5 (hb5)')
      await wrapped.finish('got a test slot after 3 s')
    } finally {
      write.mockRestore()
      delete process.env.CW_PROGRESS_WRAPPED
    }
    expect(lines).toEqual(['##cw-progress wait=waiting for a test slot: B4 (hb4)\n', '##cw-progress wait=waiting for a test slot: B5 (hb5)\n', '##cw-progress wait=\n'])
    expect(calls).toEqual([])
  })

  it('e2e: one step per suite, an estimate from the suites timed before (unknown ones as their average); off with --no-progress', async () => {
    const { e2eProgress } = await import('./progressReport.mts')
    const first = e2eProgress(['a', 'b'], [])
    first.suite(0, 'a')
    first.done('a', 1000, true)
    first.suite(1, 'b')
    first.done('b', 5000, false)
    // (A finish drops an update not sent yet: finished once the last one has arrived.)
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ step: 1, stepName: 'b' }), { timeout: HUNG_MS })
    await first.finish(false, '1 passed, 1 failed')
    expect(calls[0].body).toEqual({ title: 'e2e: 2 suites', total: 2, step: 0, command: 'npm run e2e -- a b', pid: process.pid })
    // Each update counts the suites finished and names the one starting.
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ step: 1, stepName: 'b' })
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, summary: '1 passed, 1 failed' } })
    calls.length = 0
    // a took a second; b failed (not timed), so it counts as the average of the known ones.
    const second = e2eProgress(['a', 'b'], [])
    await vi.waitFor(() => expect(calls[0]?.body.estimateMs).toBe(2000), { timeout: HUNG_MS })
    await second.finish(true)
    calls.length = 0
    const off = e2eProgress(['a'], ['--no-progress'])
    off.suite(0, 'a')
    await off.finish(true)
    process.env.CW_PROGRESS = '0'
    await e2eProgress(['a'], []).finish(true)
    expect(calls).toEqual([])
  })

  it('scenarios (#1457): a step per trial named with the results so far, finished with the counts; estimates by provider; under hive-progress, step lines', async () => {
    const { scenariosProgress } = await import('./progressReport.mts')
    const first = scenariosProgress(['work-on-card', 'review-card', 'handover'], 'fake', ['--only', 'work-on-card,review-card,handover'])
    first.start(0, 'work-on-card')
    first.done('work-on-card', 1000, 'ok')
    first.start(1, 'review-card')
    first.done('review-card', 3000, 'failed')
    first.start(2, 'handover')
    first.done('handover', 0, 'skipped')
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ step: 2, stepName: 'handover · 1 ok, 1 failed' }), { timeout: HUNG_MS })
    await first.finish(false, '1 ok, 1 failed, 1 skipped', join(dir, 'summary.md'))
    expect(calls[0].body).toEqual({ title: 'scenarios: 3 (fake)', total: 3, step: 0, command: 'npm run scenarios -- --only work-on-card,review-card,handover', pid: process.pid })
    expect(calls.at(-1)).toMatchObject({ path: '/v1/progress/run-1/finish', body: { ok: false, summary: '1 ok, 1 failed, 1 skipped', logPath: join(dir, 'summary.md') } })
    calls.length = 0
    // work-on-card took a second (the others failed or were skipped, so not timed: each counts as that average).
    const second = scenariosProgress(['work-on-card', 'review-card'], 'fake', [])
    await vi.waitFor(() => expect(calls[0]?.body.estimateMs).toBe(2000), { timeout: HUNG_MS })
    await second.finish(true)
    calls.length = 0
    // Another provider's trials are timed apart: no estimate yet.
    const codex = scenariosProgress(['work-on-card'], 'fake-codex', [])
    await vi.waitFor(() => expect(calls.length).toBe(1), { timeout: HUNG_MS })
    expect(calls[0].body.estimateMs).toBeUndefined()
    await codex.finish(true)
    calls.length = 0
    // Under hive-progress: step lines for the wrapper's run, each naming the trial starting and the results so far.
    const lines: string[] = []
    const wrapped = scenariosProgress(['a', 'b'], 'fake', [], { target: null, lines: (l) => lines.push(l) })
    wrapped.start(0, 'a')
    wrapped.done('a', 10, 'ok')
    wrapped.start(1, 'b')
    wrapped.done('b', 10, 'ok')
    await wrapped.finish(true, '2 ok, 0 failed')
    expect(lines).toEqual(['##cw-progress step=1 total=2', '##cw-progress step=1 name=a', '##cw-progress step=2 name=b · 1 ok'])
    const off = scenariosProgress(['a'], 'fake', ['--no-progress'])
    off.start(0, 'a')
    await off.finish(true)
    expect(calls).toEqual([])
  })

  it('unit: a step per file as it finishes, finished with the counts; timed only when all passed', async () => {
    const { VitestProgress } = await import('./progressReport.mts')
    const v = new VitestProgress()
    v.onTestRunStart([{ moduleId: 'x.test.ts' }, { moduleId: 'y.test.ts' }])
    v.onTestModuleEnd({ moduleId: 'C:/r/x.test.ts', relativeModuleId: 'x.test.ts', ok: () => true })
    v.onTestModuleEnd({ moduleId: 'C:/r/y.test.ts', relativeModuleId: 'y.test.ts', ok: () => false })
    // (A finish drops an update not sent yet: finished once it has arrived.)
    await vi.waitFor(() => expect(Object.assign({}, ...calls.filter((c) => c.method === 'PATCH').map((c) => c.body))).toEqual({ step: 2 }), { timeout: HUNG_MS })
    await v.onTestRunEnd([], [], 'failed')
    expect(calls[0].body).toEqual({ title: 'unit: 2 files', total: 2, step: 0, command: 'npm test', pid: process.pid })
    expect(Object.assign({}, ...calls.filter((c) => c.method === 'PATCH').map((c) => c.body))).toEqual({ step: 2 })
    expect(calls.at(-1)?.body).toEqual({ ok: false, summary: '1 passed, 1 failed' })
  })
})
