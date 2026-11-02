// HI-2358: a None check's points (its start and its end) read off main's thread, in the None baseline's worker (built
// here with esbuild, as noneBaseline.test.ts builds it). Here: the worker's point is what main's thread read (the
// declared paths' revision on a fresh adapter, and checks.ts's stat snapshot of every deliverable), for ordinary files,
// a declared folder, a declared path deleted and no paths; the check's start finishes its point before it returns (so
// before its command); with the watcher's record complete, and without it (its snapshots decide); the end's declared
// paths changed; a start or an end with no answer never counts (no two empty reads matching); two checks at once each
// get their own point, a timed-out one never handing its answer to the other. And a benchmark, recorded, not a gate.
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NoneAdapter } from '../src/main/platform/none'
import { NonePlatform } from '../src/main/platform/nonePlatform'
import type { CardRecord } from '../src/main/workflow/factStore'
import { isUnknown, unknown } from '../src/main/platform/types'
import { UNREADABLE } from '../src/shared/workflow/texts'
import { useBaselineWorker, type BaselineThread } from '../src/main/noneBaseline'
import { checkPoint } from '../src/main/noneBaselineWorker'
import { snapshot } from '../src/main/workflow/checks'
import { checkEnd, checkStart, type CheckRunFor, type WriteLog } from '../src/main/workflow/runChecks'
import { tempDir } from './tempDir'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30_000

const tmp = tempDir('hive-none-point-')
const bundle = join(tmp, 'none-baseline-worker.cjs')
let t: BaselineThread

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'noneBaselineWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  t = useBaselineWorker(bundle)
}, 60_000)
afterAll(() => void useBaselineWorker(null))

async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + HUNG_MS
  while (!ok()) {
    if (Date.now() > end) throw new Error('still not so after HUNG_MS')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let n = 0
function project(): string {
  const p = tempDir(`hive-none-point-${++n}-`)
  writeFileSync(join(p, 'doc.md'), 'the doc\n')
  writeFileSync(join(p, 'other.md'), 'another\n')
  mkdirSync(join(p, 'src', 'deep'), { recursive: true })
  writeFileSync(join(p, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(p, 'src', 'deep', 'b.ts'), 'b\n')
  mkdirSync(join(p, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(p, 'node_modules', 'x', 'i.js'), 'x')
  return p
}

const COMMANDS = { typecheck: 'npm run typecheck' }
const forNone = (p: string, paths: string[] = ['doc.md']): CheckRunFor => ({ card: 7, folder: p, project: p, platform: 'none', tested: null, check: 'typecheck', checkCommand: 'npm run typecheck', command: 'npm run typecheck', commands: COMMANDS, facts: [], paths, excluded: ['node_modules'] })

/** A watcher's record: complete (`writes`: what it saw), or not complete (null: the snapshots decide). */
const logOf = (writes: string[] | null): WriteLog => ({
  settled: async () => undefined,
  changedBetween: async (_f, _a, _b, counts) => (writes === null ? unknown(UNREADABLE.deliverables, { project: 'p', n: 1 }) : { changed: (counts ? counts(writes) : writes).length > 0, paths: counts ? counts(writes) : writes })
})
const endOf = (endPaths?: string[]) => ({ at: Date.now(), result: 'passed' as const, run: 'r1', by: 'B1', title: 'typecheck', ...(endPaths ? { endPaths } : {}) })

describe("a None check's points, off main's thread (HI-2358)", () => {
  it("the worker's point is what main's thread read: files, a declared folder, a deleted path, no paths", async () => {
    const p = project()
    const a = new NoneAdapter(p, ['node_modules'])
    const mainSnapshot = await snapshot(p, a.deliverables() as string[], null)
    for (const paths of [['doc.md'], ['src'], ['gone.md', 'doc.md'], [], ['.']]) {
      const here = new NoneAdapter(p, ['node_modules']).revision(paths)
      const point = await t.readPoint({ project: p, excluded: ['node_modules'], caseless: a.caseless, paths, snapshot: true })
      expect(point?.revision, JSON.stringify(paths)).toBe(isUnknown(here) ? null : here.revision)
      expect(point?.snapshot, JSON.stringify(paths)).toBe(mainSnapshot)
      expect(checkPoint(p, ['node_modules'], a.caseless, paths, true)).toEqual(point)
    }
    // A deleted file in the snapshot is its `gone` line, the same either side.
    const ghost = ['doc.md', 'missing.md']
    expect((await snapshot(p, ghost, null)).split('\n')[1]).toBe('missing.md:gone')
    // No snapshot asked: none read.
    expect(await t.readPoint({ project: p, excluded: ['node_modules'], caseless: a.caseless, paths: ['doc.md'], snapshot: false })).not.toHaveProperty('snapshot')
  })

  it('its start finishes its point before it returns (before the command can start)', async () => {
    const p = project()
    t.hold()
    let started = false
    const s = checkStart(forNone(p), logOf([])).then((x) => ((started = true), x))
    await until(() => t.pending === 1)
    expect(started).toBe(false)
    t.release()
    expect((await s).revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it("with the watcher's record complete: counts, or a write to another deliverable is a change", async () => {
    const p = project()
    const r = forNone(p)
    expect(await checkEnd(r, await checkStart(r, logOf([])), endOf(), logOf([]))).toMatchObject({ counted: true })
    expect(await checkEnd(r, await checkStart(r, logOf([])), endOf(), logOf(['other.md']))).toMatchObject({ counted: false, whyNot: 'changed', changes: ['other.md'] })
  })

  it("without the watcher's record (its snapshots decide): counts unchanged; a write to another deliverable is a change", async () => {
    const p = project()
    const r = forNone(p)
    expect(await checkEnd(r, await checkStart(r, logOf(null)), endOf(), logOf(null))).toMatchObject({ counted: true })
    const start = await checkStart(r, logOf(null))
    writeFileSync(join(p, 'other.md'), 'a longer edit than before\n')
    expect(await checkEnd(r, start, endOf(), logOf(null))).toMatchObject({ counted: false, whyNot: 'changed' })
    // A deliverable deleted meanwhile: its line gone from the end's snapshot.
    const again = await checkStart(r, logOf(null))
    rmSync(join(p, 'src', 'a.ts'))
    expect(await checkEnd(r, again, endOf(), logOf(null))).toMatchObject({ counted: false, whyNot: 'changed' })
  })

  it("the end's declared paths changed: the revision changed", async () => {
    const p = project()
    const r = forNone(p)
    expect(await checkEnd(r, await checkStart(r, logOf([])), endOf(['doc.md', 'src']), logOf([]))).toMatchObject({ counted: false, whyNot: 'revisionChanged' })
  })

  it('no answer at its start, or at its end, never counts: no two empty reads matching', async () => {
    const bounded = useBaselineWorker(bundle, { timeoutMs: 150 })
    try {
      const p = project()
      const r = forNone(p)
      // Its start's point times out (held): no revision, no snapshot.
      bounded.hold()
      const start = await checkStart(r, logOf(null))
      expect(start).toMatchObject({ revision: null, snapshot: null })
      bounded.timeoutMs = HUNG_MS
      expect(await checkEnd(r, start, endOf(), logOf(null))).toMatchObject({ counted: false, whyNot: 'revisionChanged' })
      // Its end's point times out: the start was read, the end wasn't.
      const good = await checkStart(r, logOf(null))
      expect(good.snapshot).not.toBeNull()
      // A snapshot that couldn't be read (its walk unreadable) beside a good revision: a change, never a match.
      expect(await checkEnd(r, { ...good, snapshot: null }, endOf(), logOf(null))).toMatchObject({ counted: false, whyNot: 'changed' })
      bounded.timeoutMs = 150
      bounded.hold()
      expect(await checkEnd(r, good, endOf(), logOf(null))).toMatchObject({ counted: false, whyNot: 'revisionChanged' })
    } finally {
      t = useBaselineWorker(bundle)
    }
  })

  it('two checks at once each get their own point; one timed out never hands its answer to the other', async () => {
    const p = project()
    const q = project()
    t.hold()
    const a = checkStart(forNone(p), logOf([]))
    const b = checkStart(forNone(q, ['src']), logOf([]))
    await until(() => t.pending === 2)
    t.release()
    const [x, y] = await Promise.all([a, b])
    expect(x.revision).not.toBe(y.revision)
    expect(x.snapshot).toContain('doc.md:')
    expect(y.snapshot).toContain('src/deep/b.ts:')
    const bounded = useBaselineWorker(bundle, { timeoutMs: 150 })
    try {
      bounded.hold()
      const late = checkStart(forNone(p), logOf([]))
      const next = checkStart(forNone(q, ['src']), logOf([]))
      // The held one is sent with its 150 ms bound; the next, sent to a new worker once it times out, has room under load.
      await until(() => bounded.pending === 2)
      bounded.timeoutMs = HUNG_MS
      expect((await late).revision).toBeNull()
      // The next check's point went to a new worker: its own answer, q's.
      expect((await next).revision).toBe(y.revision)
    } finally {
      t = useBaselineWorker(bundle)
    }
  })

  it("benchmark (recorded, not a gate): main's longest gap during a check's start for a card declaring the project (5,000 files)", async () => {
    const p = tempDir('hive-none-point-bench-')
    for (let i = 0; i < 5000; i++) {
      const d = join(p, 'assets', String(i % 20))
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `${i}.txt`), `${i}`.padEnd(1024, '.'))
    }
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
    // Before HI-2358, on main's thread: a fresh adapter's revision of `.`, and the walk (the snapshot's stats were
    // already asynchronous).
    const onMain = await gapDuring(async () => {
      const a = new NoneAdapter(p, ['node_modules'])
      a.revision(['.'])
      await snapshot(p, a.deliverables() as string[], null)
    })
    const inWorker = await gapDuring(() => checkStart(forNone(p, ['.']), logOf(null)))
    console.info(`HI-2358 benchmark, a check's start declaring the project, 5,000 x 1 KB: main's longest gap ${Math.round(onMain)} ms on main's thread, ${Math.round(inWorker)} ms with its point in the worker`)
    // The whole start, as the app does it (HR3's round 1): the run's link reads the card's revision first
    // (`NonePlatform.runRevision`, through `cardRunRevision`), then the check's start. Before: the workflow's own adapter
    // (its cache warm from the card's start: the walk and stats left) on main, then the old start.
    const adapter = new NoneAdapter(p, ['node_modules'])
    adapter.revision(['.'])
    const platform = new NonePlatform({} as never, adapter)
    const card = { id: 7, key: 'AM-7', kind: 'code', paths: ['.'] } as unknown as CardRecord
    const fullBefore = await gapDuring(async () => {
      adapter.revision(['.'])
      const a = new NoneAdapter(p, ['node_modules'])
      a.revision(['.'])
      await snapshot(p, a.deliverables() as string[], null)
    })
    const fullAfter = await gapDuring(async () => {
      const linked = await platform.runRevision(card, {} as never, null, null)
      expect(linked.revision).toMatch(/^[0-9a-f]{64}$/)
      await checkStart(forNone(p, ['.']), logOf(null))
    })
    console.info(`HI-2358 benchmark, the whole start (its link's revision, then the check's start), 5,000 x 1 KB: main's longest gap ${Math.round(fullBefore)} ms before, ${Math.round(fullAfter)} ms after`)
    expect(inWorker).toBeGreaterThanOrEqual(0)
  }, 120_000)
})
