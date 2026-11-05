// The log's writer thread (HI-1730): combwork.log's and hooks.log's lines are queued on main and written by a thread of
// their own, so a disk that holds writes up (a System Restore point freezing the profile's drive) holds that thread, not
// main. Here, with the writer built and each of its writes held: logging returns at once, every line arrives once and in
// order, the process's exit (flushLogs) writes what the writer hadn't, a writer that won't keep up has lines dropped and
// counted, and the handshake leaves a batch to main once it says it writes what is left.
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = 15_000
const base = tempDir('cw-log-writer-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const logger = await import('../src/main/logger')
const { BUSY, LOG_STATE_SLOTS, STOP, WRITTEN, writeBatch } = await import('../src/main/logWriter')
const bundle = join(base, 'log-writer.cjs')
const hooks = join(base, 'profile', 'logs', 'hooks.log')
const hive = join(base, 'profile', 'logs', 'combwork.log')
const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'logWriter.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
}, 60_000)
afterAll(async () => {
  await logger.useLogWriter(null)
})

describe("the log's writer thread (HI-1730)", () => {
  it('logging returns at once while each write is held, and every line arrives once, in order', async () => {
    await logger.useLogWriter(bundle, 200)
    const from = performance.now()
    for (let i = 0; i < 50; i++) logger.hookJournal(`order ${i}`)
    // Fifty lines queued with each write held 200 ms: main took nothing like a write's hold.
    expect(performance.now() - from).toBeLessThan(150)
    await vi.waitFor(() => expect(lines(hooks).filter((l) => l.includes(' order ')).length).toBe(50), { timeout: HUNG_MS })
    expect(lines(hooks).filter((l) => l.includes(' order ')).map((l) => l.split(' order ')[1])).toEqual(Array.from({ length: 50 }, (_, i) => String(i)))
  })

  it("the process's exit writes what the writer hadn't, each line once: the batch it was writing waited for, the rest here", async () => {
    await logger.useLogWriter(bundle, 400)
    for (let i = 0; i < 5; i++) {
      logger.hookJournal(`exit ${i}`)
      // A batch each: the writer holds the first while the rest wait for it.
      await new Promise((r) => setImmediate(r))
    }
    logger.flushLogs()
    const got = lines(hooks).filter((l) => l.includes(' exit ')).map((l) => l.split(' exit ')[1])
    expect(got).toEqual(['0', '1', '2', '3', '4'])
    // From then on a line is written at once.
    logger.hookJournal('after the exit')
    expect(lines(hooks).at(-1)).toMatch(/after the exit$/)
  })

  it("a writer that won't keep up: lines past the bound are dropped, and combwork.log says how many", async () => {
    await logger.useLogWriter(bundle, 300)
    const was = logger.logLimits.waitingBytes
    logger.logLimits.waitingBytes = 2000
    try {
      for (let i = 0; i < 100; i++) logger.hookJournal(`bound ${i} ${'x'.repeat(40)}`)
      await vi.waitFor(() => expect(lines(hive).some((l) => /\[logger\] \d+ log line\(s\) weren't written/.test(l))).toBe(true), { timeout: HUNG_MS })
      const kept = lines(hooks).filter((l) => l.includes(' bound ')).length
      const said = Number(/(\d+) log line\(s\) weren't written/.exec(lines(hive).find((l) => l.includes("weren't written")) ?? '')?.[1])
      expect(kept + said).toBe(100)
      expect(kept).toBeLessThan(100)
    } finally {
      logger.logLimits.waitingBytes = was
    }
  })

  it("the logger loads in a worker thread, where there is no `app` (the usage worker loads it through fsutil: since HI-1684 it threw there)", async () => {
    const { Worker } = await import('worker_threads')
    const script = join(base, 'logger-in-worker.cjs')
    const { writeFileSync } = await import('fs')
    // What `electron` is in a worker of Electron's main process: the npm package's export, a path, with no `app`.
    const stub = join(base, 'electron-in-worker.cjs')
    writeFileSync(stub, "module.exports = 'C:\\\\electron\\\\electron.exe'\n")
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'logger.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs', electron: stub }, logLevel: 'silent' })
    const runner = join(base, 'logger-runner.cjs')
    writeFileSync(runner, `const { parentPort } = require('worker_threads')\ntry {\n  const l = require(${JSON.stringify(script)})\n  l.createLogger('test').info('from a worker')\n  parentPort.postMessage('loaded')\n} catch (e) {\n  parentPort.postMessage('threw: ' + e.message)\n}\n`)
    const w = new Worker(runner)
    const said = await new Promise<string>((resolve) => {
      w.once('message', (m: string) => resolve(m))
      w.once('error', (e: Error) => resolve(`error: ${e.message}`))
    })
    await w.terminate()
    expect(said).toBe('loaded')
  })

  it('a batch the writer starts after main said it writes what is left (STOP) is left to main; one under way is waited for', () => {
    const state = new Int32Array(new SharedArrayBuffer(LOG_STATE_SLOTS * 4))
    const f = join(base, 'handshake.log')
    expect(writeBatch({ seq: 1, file: f, text: 'one\n', maxBytes: 1 << 20 }, state)).toBe(true)
    expect([Atomics.load(state, WRITTEN), Atomics.load(state, BUSY)]).toEqual([1, 0])
    Atomics.store(state, STOP, 1)
    expect(writeBatch({ seq: 2, file: f, text: 'two\n', maxBytes: 1 << 20 }, state)).toBe(false)
    expect([Atomics.load(state, WRITTEN), Atomics.load(state, BUSY)]).toEqual([1, 0])
    expect(readFileSync(f, 'utf8')).toBe('one\n')
  })
})
