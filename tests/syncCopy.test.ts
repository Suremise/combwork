import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { appendFile, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { SYNC_STEP, syncCopy, syncCopyNow } from '../src/main/fsutil'
import { tempDir } from './tempDir'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')

// Windows ending the session while an ordinary copy is under way: `interrupt` runs the shutdown copy just before the
// ordinary copy's n-th file operation takes effect (as if that operation were still pending), so a test can try
// every point in turn. `slow` makes each synchronous write take that long (a slow disk): on the test's clock, not the
// wall clock, so how long the machine takes to get to a write can't change how many writes a deadline allows (#379).
const interrupt = vi.hoisted(() => ({ at: 0, calls: 0, fn: null as null | (() => void) }))
const slow = vi.hoisted(() => ({ ms: 0 }))
vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  const wrap =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (interrupt.fn && ++interrupt.calls === interrupt.at) {
        const fn = interrupt.fn
        interrupt.fn = null
        fn()
      }
      return f(...a)
    }
  return { ...fs, stat: wrap(fs.stat), open: wrap(fs.open), copyFile: wrap(fs.copyFile), rename: wrap(fs.rename), rm: wrap(fs.rm), mkdir: wrap(fs.mkdir) }
})
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    writeSync: (fd: number, buf: Buffer, off: number, len: number, pos: number): number => {
      if (slow.ms) vi.setSystemTime(Date.now() + slow.ms)
      return fs.writeSync(fd, buf, off, len, pos)
    }
  }
})

let dir = ''
beforeEach(async () => {
  dir = tempDir('cw-synccopy-')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const line = (i: number): string => JSON.stringify({ i, text: 'x'.repeat(i % 50) }) + '\n'

describe('syncCopy', () => {
  it('copies a new file, then appends only what the source gained', async () => {
    const src = join(dir, 'a.jsonl')
    const dest = join(dir, 'backup', 'a.jsonl')
    let all = ''
    for (let i = 0; i < 2000; i++) all += line(i)
    await writeFile(src, all)
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(all)
    const before = (await stat(dest)).birthtimeMs
    await appendFile(src, line(2000) + line(2001))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(all + line(2000) + line(2001))
    // Appended to, not replaced.
    expect((await stat(dest)).birthtimeMs).toBe(before)
    expect((await readdir(join(dir, 'backup'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('copies the whole file again when the source no longer starts with the copy', async () => {
    const src = join(dir, 'b.jsonl')
    const dest = join(dir, 'b-copy.jsonl')
    await writeFile(src, line(1) + line(2))
    await syncCopy(src, dest)
    await writeFile(src, line(7) + line(8) + line(9))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(line(7) + line(8) + line(9))
    // A source shorter than the copy (rewritten) is copied too.
    await writeFile(src, line(3))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(line(3))
  })

  it('notices a change in the middle of what was copied', async () => {
    const src = join(dir, 'm.jsonl')
    const dest = join(dir, 'm-copy.jsonl')
    const before = Buffer.alloc(12 * 1024, 'a')
    await writeFile(src, before)
    await syncCopy(src, dest)
    const after = Buffer.from(before)
    after[6000] = 'b'.charCodeAt(0)
    await writeFile(src, Buffer.concat([after, Buffer.from('more\n')]))
    await syncCopy(src, dest)
    expect((await readFile(dest)).equals(await readFile(src))).toBe(true)
  })

  // A CLI appends to its transcript while Combwork copies it whole (its first backup): no append may fail. Windows'
  // CopyFile doesn't share writes, and a fake Claude Code died of the EBUSY (#1041).
  it("doesn't stop another process appending to the source during a whole copy", async () => {
    const src = join(dir, 'w.jsonl')
    const stop = join(dir, 'stop')
    await writeFile(src, Buffer.alloc(4 * 1024 * 1024, 'x'))
    const start = (await stat(src)).size
    const script = `const fs = require('fs'); let appends = 0, busy = 0
      while (!fs.existsSync(process.argv[2])) { try { fs.appendFileSync(process.argv[1], 'y'.repeat(200)); appends++ } catch (e) { if (e.code !== 'EBUSY') throw e; busy++ } }
      console.log(JSON.stringify({ appends, busy }))`
    const child = spawn(process.execPath, ['-e', script, src, stop], { env: ctx.baseEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    // Closed (its output complete) or failed to start: either way it is over.
    let ended = false
    let code: number | null = null
    let spawnError: Error | null = null
    const over = new Promise<void>((r) => {
      child.on('close', (c) => ((code = c), (ended = true), r()))
      child.on('error', (e) => ((spawnError = e), (ended = true), r()))
    })
    try {
      // Copies while it appends: each to a new backup, so each is a whole copy.
      await vi.waitFor(async () => expect((await stat(src)).size).toBeGreaterThan(start), { timeout: 15_000 })
      for (let i = 0; i < 30; i++) await syncCopy(src, join(dir, `w-copy${i}.jsonl`))
    } finally {
      // Before afterEach removes the folder, pass or fail: told to stop, and ended by its own handle if it hangs.
      await writeFile(stop, '')
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 15_000 }).catch(() => child.kill())
      await over
    }
    expect(spawnError).toBeNull()
    expect(code).toBe(0)
    const got = JSON.parse(out) as { appends: number; busy: number }
    expect(got.appends).toBeGreaterThan(0)
    expect(got.busy).toBe(0)
    expect(existsSync(join(dir, 'w-copy29.jsonl'))).toBe(true)
  }, 60_000)

  it('appends each new byte once when copies overlap', async () => {
    const src = join(dir, 'c.jsonl')
    const dest = join(dir, 'c-copy.jsonl')
    await writeFile(src, line(0))
    await syncCopy(src, dest)
    let expected = line(0)
    const runs: Promise<void>[] = []
    for (let i = 1; i < 20; i++) {
      await appendFile(src, line(i))
      expected += line(i)
      runs.push(syncCopy(src, dest), syncCopy(src, dest))
    }
    await Promise.all(runs)
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(expected)
  })
})

describe('syncCopyNow (Windows ending the session)', () => {
  const soon = (): number => Date.now() + 2000
  const temps = async (d: string): Promise<string[]> => (await readdir(d)).filter((f) => f.endsWith('.tmp'))

  it('copies a new file, appends what the source gained, and copies a rewritten one whole', async () => {
    const src = join(dir, 'n.jsonl')
    const dest = join(dir, 'backup', 'n.jsonl')
    await writeFile(src, line(1) + line(2))
    expect(syncCopyNow(src, dest, soon())).toBe(true)
    expect(await readFile(dest, 'utf8')).toBe(line(1) + line(2))
    const before = (await stat(dest)).birthtimeMs
    await appendFile(src, line(3))
    expect(syncCopyNow(src, dest, soon())).toBe(true)
    expect(await readFile(dest, 'utf8')).toBe(line(1) + line(2) + line(3))
    expect((await stat(dest)).birthtimeMs).toBe(before)
    await writeFile(src, line(9))
    expect(syncCopyNow(src, dest, soon())).toBe(true)
    expect(await readFile(dest, 'utf8')).toBe(line(9))
    expect(await temps(join(dir, 'backup'))).toEqual([])
  })

  it('starts nothing once its time is up, and leaves the backup as it was', async () => {
    const src = join(dir, 'd.jsonl')
    const dest = join(dir, 'd-copy.jsonl')
    await writeFile(src, line(1))
    await writeFile(dest, 'old\n')
    expect(syncCopyNow(src, dest, 0)).toBe(false)
    expect(await readFile(dest, 'utf8')).toBe('old\n')
    await writeFile(dest, line(1))
    await appendFile(src, line(2))
    expect(syncCopyNow(src, dest, 0)).toBe(false)
    expect(await readFile(dest, 'utf8')).toBe(line(1))
    expect(await temps(dir)).toEqual([])
  })

  describe('on a slow disk', () => {
    // Date only: a write advances the clock by `slow.ms`, and the deadline is read against that clock.
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 }))
    afterEach(() => {
      vi.useRealTimers()
      slow.ms = 0
    })
    const big = Buffer.alloc(8 * SYNC_STEP, 'x')

    it('stops an append after the step under way: a shorter backup, still the start of the transcript', async () => {
      const src = join(dir, 's.jsonl')
      const dest = join(dir, 's-copy.jsonl')
      await writeFile(src, line(1))
      await syncCopy(src, dest)
      await appendFile(src, big)
      slow.ms = 60
      const t = Date.now()
      expect(syncCopyNow(src, dest, t + 20)).toBe(false)
      // One step of 60 ms, not eight: exactly one write before the deadline passes.
      expect(Date.now() - t).toBe(60)
      const got = await readFile(dest)
      expect(got.length).toBe(line(1).length + SYNC_STEP)
      expect(got.equals((await readFile(src)).subarray(0, got.length))).toBe(true)
    })

    it("drops a whole copy it can't finish, and keeps the backup there", async () => {
      const src = join(dir, 'r.jsonl')
      const dest = join(dir, 'r-copy.jsonl')
      await writeFile(src, big)
      await writeFile(dest, 'old\n')
      slow.ms = 60
      expect(syncCopyNow(src, dest, Date.now() + 20)).toBe(false)
      expect(await readFile(dest, 'utf8')).toBe('old\n')
      expect(await temps(dir)).toEqual([])
    })
  })

  // Every point an ordinary copy can be at when Windows ends the session, a pending rename included.
  for (const [what, prior] of [
    ['a whole copy', 'old\n'],
    ['an append', 'new\n']
  ] as const) {
    it(`isn't undone by ${what} under way at any point`, async () => {
      let points = 0
      for (let n = 1; ; n++) {
        const src = join(dir, `i${n}.jsonl`)
        const dest = join(dir, `i${n}-copy.jsonl`)
        await writeFile(src, 'new\n')
        await writeFile(dest, prior)
        if (prior === 'new\n') await appendFile(src, 'more\n')
        const latest = readFileSync(src, 'utf8') + 'latest\n'
        let fired = false
        Object.assign(interrupt, { at: n, calls: 0 })
        interrupt.fn = () => {
          fired = true
          appendFileSync(src, 'latest\n')
          expect(syncCopyNow(src, dest, soon())).toBe(true)
          expect(readFileSync(dest, 'utf8')).toBe(latest)
        }
        await syncCopy(src, dest)
        interrupt.fn = null
        if (!fired) break
        points++
        expect(await readFile(dest, 'utf8'), `interrupted at file operation ${n}`).toBe(latest)
      }
      expect(points).toBeGreaterThanOrEqual(3)
      expect(await temps(dir)).toEqual([])
    })
  }

  it('leaves ordinary copies working after it (shutdown cancelled)', async () => {
    const src = join(dir, 'c.jsonl')
    const dest = join(dir, 'c-copy.jsonl')
    await writeFile(src, line(1))
    syncCopyNow(src, dest, soon())
    await appendFile(src, line(2))
    await syncCopy(src, dest)
    expect(await readFile(dest, 'utf8')).toBe(line(1) + line(2))
  })
})
