// A None project's whole-project read off main's thread (HI-2340): noneBaselineWorker.ts runs NoneAdapter's own read in a
// thread of its own (built here with esbuild, as repoLockWorker.test.ts builds its worker), and noneBaseline.ts's
// thread shares, bounds and ends its reads. Here: the worker's answer is the adapter's; main's event loop runs on while
// a read is held in the worker (its tests' barrier, no time threshold); reads asked alike share one; a caller that stops
// waiting leaves only itself; a newer generation drops the project's reads not sent; a read past its bound ends the
// worker and the next read starts a new one; a worker that ends answers its read with nothing. And a modest benchmark:
// main's longest gap during a read, on main's thread and in the worker, written to the run's log (recorded, not a gate).
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NoneAdapter } from '../src/main/platform/none'
import { isUnknown, unknown } from '../src/main/platform/types'
import { UNREADABLE } from '../src/shared/workflow/texts'
import { endedLine, failedLine, readBaseline, useBaselineWorker, type BaselineThread } from '../src/main/noneBaseline'
import { MARKED_LOG, redactLog, type RedactContext } from '../src/shared/redact'
import { scanProject } from '../src/main/noneBaselineWorker'
import { tempDir } from './tempDir'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30_000

const tmp = tempDir('cw-none-baseline-')
const bundle = join(tmp, 'none-baseline-worker.cjs')

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'noneBaselineWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
}, 60_000)
afterAll(() => void useBaselineWorker(null))

let n = 0
/** A project of `files` files (each `size` bytes) under assets/, and a node_modules file left out. */
function project(files: number, size = 16): string {
  const root = tempDir(`cw-none-baseline-${++n}-`)
  for (let i = 0; i < files; i++) {
    const d = join(root, 'assets', String(i % 20))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `${i}.txt`), `${i}`.padEnd(size, '.'))
  }
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'x')
  return root
}

/** Waits for a condition, bounded by HUNG_MS. */
async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + HUNG_MS
  while (!ok()) {
    if (Date.now() > end) throw new Error('still not so after HUNG_MS')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("a None project's whole-project read in its worker (HI-2340)", () => {
  let t: BaselineThread
  beforeAll(() => {
    t = useBaselineWorker(bundle)
  })

  it("answers what NoneAdapter reads on main's thread, the folders left out included; what can't be read comes back as data", async () => {
    const root = project(30)
    const a = new NoneAdapter(root, ['node_modules'])
    const got = await readBaseline(a)
    const here = a.manifest(a.deliverables() as string[])
    expect(got).toEqual(here)
    expect(Object.keys(got as object).some((f) => f.startsWith('node_modules/'))).toBe(false)
    // An unknown answer (past the files' bound) is plain data, so it crosses to main as it is.
    const u = unknown(UNREADABLE.deliverables, { project: root, n: 20_000 })
    expect(structuredClone(u)).toEqual(u)
    expect(isUnknown(structuredClone(u))).toBe(true)
    expect(scanProject(root, ['node_modules'], a.caseless)).toEqual(here)
  })

  it("keeps main's event loop running while a read waits in the worker; the read is answered once it is let go", async () => {
    const a = new NoneAdapter(project(10))
    t.hold()
    let answered = false
    const read = readBaseline(a).then((r) => ((answered = true), r))
    // Main ticks on while the read is held: a timer keeps firing (no time threshold, only that it runs).
    let ticks = 0
    const tick = setInterval(() => void ticks++, 5)
    try {
      await until(() => ticks >= 20)
      expect(answered).toBe(false)
      expect(t.pending).toBe(1)
    } finally {
      clearInterval(tick)
      t.release()
    }
    expect(isUnknown(await read)).toBe(false)
    expect(t.pending).toBe(0)
  })

  it('reads asked alike share one not sent yet; a caller that stops waiting leaves only itself; a read nobody waits for is not sent', async () => {
    const a = new NoneAdapter(project(5))
    const b = new NoneAdapter(project(5))
    t.hold()
    // The first is sent (under way: never shared); the next two, asked alike, share the one queued behind it.
    const one = readBaseline(a)
    const two = readBaseline(a)
    const gone = new AbortController()
    const three = readBaseline(a, gone.signal)
    // b's read waits behind a's (one at a time); its only caller stops waiting: it isn't sent.
    const left = new AbortController()
    const other = readBaseline(b, left.signal)
    await until(() => t.pending === 3)
    gone.abort()
    left.abort()
    expect(await three).toBeNull()
    expect(await other).toBeNull()
    // two still waits on the shared queued read: it stays.
    await until(() => t.pending === 2)
    t.release()
    const [x, y] = await Promise.all([one, two])
    expect(x).not.toBeNull()
    expect(y).toEqual(x)
    expect(t.pending).toBe(0)
  })

  it("a read already under way is never shared: a file it read, changed since, is read again for a later caller (HR3's round 1)", async () => {
    const root = project(3)
    const a = new NoneAdapter(root, ['node_modules'])
    const file = join(root, 'assets', '0', '0.txt')
    // The first read reads the files (the old content), its answer held.
    t.hold({ after: true })
    const held = t.answersHeld
    const first = readBaseline(a)
    await until(() => t.answersHeld === held + 1)
    // The file changes, as the watcher would see it (an invalidation: the generation doesn't change).
    writeFileSync(file, 'changed since the first read')
    a.invalidate('assets/0/0.txt')
    const later = readBaseline(a)
    await until(() => t.pending === 2)
    t.release()
    const [x, y] = (await Promise.all([first, later])) as Record<string, string>[]
    expect(x['assets/0/0.txt']).not.toBe(y['assets/0/0.txt'])
    expect(y).toEqual(a.manifest(a.deliverables() as string[]))
  })

  it("a read's failure and a worker's end are logged as the user's text: Copy Diagnostics leaves the file's name out (HR3's round 1)", () => {
    const T = '2026-11-02T12:00:00.000Z [WARN] [noneBaseline]'
    const lines = [`${T} Combwork 1.1.0 starting (${MARKED_LOG})`, `${T} ${failedLine('D:\\Work\\notes', "ENOENT: no such file or directory, open 'D:\\Work\\notes\\private-salary-review.txt'")}`, `${T} ${endedLine("EACCES: permission denied, scandir 'D:\\Work\\notes\\medical'")}`]
    const out = redactLog(lines.join('\n'), { home: 'C:\\Users\\someone', folders: [], names: [] } satisfies RedactContext)
    expect(out).not.toMatch(/private-salary-review|medical|Work\\notes/)
    expect(out).toContain("the None baseline's worker ended")
  })

  it("a newer generation drops the project's reads not sent yet: they are answered with nothing", async () => {
    const busy = new NoneAdapter(project(3))
    const a = new NoneAdapter(project(3))
    t.hold()
    const first = readBaseline(busy)
    const old = readBaseline(a)
    await until(() => t.pending === 2)
    a.setExcluded(['assets', 'node_modules'])
    const fresh = readBaseline(a)
    expect(await old).toBeNull()
    t.release()
    expect(await first).not.toBeNull()
    // Read under its new folders left out: nothing of assets/.
    expect(Object.keys((await fresh) as object)).toEqual([])
  })

  it('a worker that ends answers its read with nothing; the next read starts a new worker', async () => {
    const a = new NoneAdapter(project(3), ['node_modules'])
    t.hold()
    const read = readBaseline(a)
    await until(() => t.pending === 1)
    await t.kill()
    expect(await read).toBeNull()
    expect(t.pending).toBe(0)
    const again = await readBaseline(a)
    expect(again && !isUnknown(again) ? Object.keys(again).length : 0).toBe(3)
  })

  it('a read past its bound ends its worker and is answered with nothing; a late answer is no later read\'s', async () => {
    const bounded = useBaselineWorker(bundle, { timeoutMs: 150 })
    try {
      const a = new NoneAdapter(project(3), ['node_modules'])
      bounded.hold()
      expect(await readBaseline(a)).toBeNull()
      expect(bounded.pending).toBe(0)
      // A new worker (the held one ended), not held, with room to read under load: answered.
      bounded.timeoutMs = HUNG_MS
      const next = await readBaseline(a)
      expect(next && !isUnknown(next) ? Object.keys(next).length : 0).toBe(3)
    } finally {
      t = useBaselineWorker(bundle)
    }
  })

  it("benchmark (recorded, not a gate): main's longest gap while a 5,000-file project is read, on main's thread and in the worker", async () => {
    const root = project(5000, 1024)
    const gapDuring = async (run: () => Promise<unknown>): Promise<number> => {
      let last = performance.now()
      let gap = 0
      const tick = setInterval(() => {
        const now = performance.now()
        gap = Math.max(gap, now - last)
        last = now
      }, 5)
      try {
        await run()
        gap = Math.max(gap, performance.now() - last)
      } finally {
        clearInterval(tick)
      }
      return gap
    }
    const onMain = await gapDuring(async () => {
      const a = new NoneAdapter(root)
      a.manifest(a.deliverables() as string[])
    })
    const inWorker = await gapDuring(() => readBaseline(new NoneAdapter(root)))
    console.info(`HI-2340 benchmark, 5,000 x 1 KB: main's longest gap ${Math.round(onMain)} ms on main's thread, ${Math.round(inWorker)} ms with the read in its worker`)
    expect(inWorker).toBeGreaterThanOrEqual(0)
  }, 120_000)
})
