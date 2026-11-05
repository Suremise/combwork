import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createKeptJson, DAMAGED_AGE_MS, KEPT_BY_STAT_MAX, KeptFileBusy, keptSettleSteps, onCorruptFile, readKeptJson, readKeptJsonByStat, readKeptJsonSync, writeKeptJson, type KeptSample, type KeptSettled } from '../src/main/fsutil'
import { tempDir } from './tempDir'

describe('kept files', () => {
  const dir = tempDir('cw-kept-')
  const reports: [string, boolean][] = []
  onCorruptFile((file, _aside, restored) => reports.push([file, restored]))
  // Damaged on disk: unchanged for a minute, well past DAMAGED_AGE_MS (#1601).
  const age = (f: string): void => {
    const old = new Date(Date.now() - 60_000)
    utimesSync(f, old, old)
  }

  it('saves a .bak copy with every write', async () => {
    const f = join(dir, 'a.json')
    await writeKeptJson(f, { n: 1 })
    expect(JSON.parse(readFileSync(`${f}.bak`, 'utf8'))).toEqual({ n: 1 })
    expect(await readKeptJson(f, null)).toEqual({ n: 1 })
  })

  it('createKeptJson (HI-2542): makes the file where there is none, never replacing one written meanwhile', async () => {
    const f = join(dir, 'new.json')
    expect(await createKeptJson(f, { n: 'default' })).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 'default' })
    expect(JSON.parse(readFileSync(`${f}.bak`, 'utf8'))).toEqual({ n: 'default' })
    // One written after its absence was checked (a project's own config, copied in) is kept, with its .bak, and no temp file is left.
    const g = join(dir, 'theirs.json')
    writeFileSync(g, '{"n":"theirs"}\n')
    expect(await createKeptJson(g, { n: 'default' })).toBe(false)
    expect(JSON.parse(readFileSync(g, 'utf8'))).toEqual({ n: 'theirs' })
    expect(readdirSync(dir).filter((n) => n.startsWith('theirs.json.'))).toEqual([])
    expect(await readKeptJson(g, null)).toEqual({ n: 'theirs' })
  })

  it('sets a damaged file aside and restores the last good copy', async () => {
    const f = join(dir, 'b.json')
    await writeKeptJson(f, { sessions: ['s1'] })
    writeFileSync(f, '{ "sessions": [')
    age(f)
    expect(await readKeptJson(f, { sessions: [] })).toEqual({ sessions: ['s1'] })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ sessions: ['s1'] })
    expect(readdirSync(dir).some((n) => n.startsWith('b.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, true])
  })

  it('falls back to the default when there is no good copy, keeping the damaged file', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, 'not json')
    age(f)
    expect(readKeptJsonSync(f, { fresh: true })).toEqual({ fresh: true })
    expect(readdirSync(dir).some((n) => n.startsWith('c.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, false])
  })

  it('treats a missing file as new, not damaged', async () => {
    const before = reports.length
    expect(await readKeptJson(join(dir, 'missing.json'), 7)).toBe(7)
    expect(reports.length).toBe(before)
  })

  it('read by its stat (HI-1814): kept until the file changes, a copy each time, and a damaged one recovered as before', async () => {
    type V = { n: number; list: string[] } | null
    const f = join(dir, 'stat.json')
    let derived = 0
    const derive = (v: V): V => (derived++, v)
    const read = (fresh = false): Promise<V> => readKeptJsonByStat<V, V>(f, null, derive, fresh ? { unsettled: 'throw' } : {})
    await writeKeptJson(f, { n: 1, list: ['a'] })
    // Just written: read in full each time (a write of the same size could share its time).
    expect(await read()).toEqual({ n: 1, list: ['a'] })
    expect(await read()).toEqual({ n: 1, list: ['a'] })
    expect(derived).toBe(2)
    // Left alone a while: kept, derived once while the file is the same.
    age(f)
    const first = await read()
    expect(first).toEqual({ n: 1, list: ['a'] })
    // A caller changing what it was given changes nothing kept.
    first!.list.push('changed')
    expect(await read()).toEqual({ n: 1, list: ['a'] })
    expect(await read(true)).toEqual({ n: 1, list: ['a'] })
    expect(derived).toBe(3)
    // Combwork's own write is read at once.
    await writeKeptJson(f, { n: 2, list: ['b'] })
    expect(await read()).toEqual({ n: 2, list: ['b'] })
    age(f)
    expect(await read()).toEqual({ n: 2, list: ['b'] })
    // Anyone else's, of the same size twice in a row: its time says so, at once.
    writeFileSync(f, '{ "n": 3, "list": ["c"] }')
    expect(await read()).toEqual({ n: 3, list: ['c'] })
    writeFileSync(f, '{ "n": 4, "list": ["d"] }')
    expect(await read()).toEqual({ n: 4, list: ['d'] })
    // Damaged: never kept, readKeptJson's recovery (the .bak) each time.
    writeFileSync(f, '{ "n": ')
    age(f)
    expect(await read(true)).toEqual({ n: 2, list: ['b'] })
    expect(await readKeptJsonByStat(join(dir, 'stat-missing.json'), 7, (v) => v)).toBe(7)
  })

  it('keeps at most KEPT_BY_STAT_MAX files by their stat, letting go of the least recently read (HR1, HI-1814)', async () => {
    let derived = 0
    const derive = (v: { i: number } | null): { i: number } | null => (derived++, v)
    const files = Array.from({ length: KEPT_BY_STAT_MAX + 1 }, (_, i) => join(dir, `lru-${i}.json`))
    for (const [i, f] of files.entries()) {
      writeFileSync(f, JSON.stringify({ i }))
      age(f)
    }
    const read = (i: number) => readKeptJsonByStat(files[i], null, derive)
    // File 1 read again before the last is kept: it stays, and file 0 (least recently read) goes.
    for (let i = 0; i < KEPT_BY_STAT_MAX; i++) await read(i)
    await read(1)
    await read(KEPT_BY_STAT_MAX)
    expect(derived).toBe(KEPT_BY_STAT_MAX + 1)
    expect(await read(1)).toEqual({ i: 1 })
    expect(await read(KEPT_BY_STAT_MAX)).toEqual({ i: KEPT_BY_STAT_MAX })
    expect(derived).toBe(KEPT_BY_STAT_MAX + 1)
    // Let go of, it is read again in full, and correctly.
    expect(await read(0)).toEqual({ i: 0 })
    expect(derived).toBe(KEPT_BY_STAT_MAX + 2)
  })

  it('sets aside an empty file that was emptied a while ago', async () => {
    const f = join(dir, 'd.json')
    await writeKeptJson(f, { n: 4 })
    writeFileSync(f, '')
    age(f)
    expect(await readKeptJson(f, null)).toEqual({ n: 4 })
    expect(readdirSync(dir).some((n) => n.startsWith('d.json.corrupt-'))).toBe(true)
  })

  // The rule both readers follow, given reads made up (#1598): what each pause's read sees decides the outcome.
  const run = (reads: KeptSample[]): { pauses: number; outcome: KeptSettled } => {
    const steps = keptSettleSteps(reads[0])
    let pauses = 0
    for (let step = steps.next(); ; ) {
      if (step.done) return { pauses, outcome: step.value }
      pauses++
      step = steps.next(reads[Math.min(pauses, reads.length - 1)])
    }
  }
  const read = (text: string, mtimeMs: number): KeptSample => ({ text, size: text.length, mtimeMs })
  // The clock the age rule reads, held at `now` for the whole of `fn` (timers stay real, #1601): what a test asserts
  // about a file's age can't depend on how long the run took on a loaded machine.
  const frozen = async <T>(now: number, fn: () => T | Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      return await fn()
    } finally {
      vi.useRealTimers()
    }
  }
  // A whole-second time a while ago: a file's mtime set to it reads back exactly.
  const T = Math.floor(Date.now() / 1000) * 1000 - 600_000

  it('keeps reading a file that keeps changing, and leaves it unsettled when the pauses run out', () => {
    const changing = Array.from({ length: 20 }, (_, i) => read(`{"a":${'1'.repeat(i + 1)}`, 1000 + i))
    expect(run(changing)).toEqual({ pauses: 6, outcome: 'unsettled' })
  })

  it('counts a file changed under DAMAGED_AGE_MS ago as still saving to the end, and one changed that long ago as damaged', async () => {
    for (const text of ['', '{"a":']) {
      expect(await frozen(T, () => run([read(text, T)]))).toEqual({ pauses: 6, outcome: 'unsettled' })
      expect(await frozen(T + DAMAGED_AGE_MS - 1, () => run([read(text, T)]))).toEqual({ pauses: 6, outcome: 'unsettled' })
      expect(await frozen(T + DAMAGED_AGE_MS, () => run([read(text, T)]))).toEqual({ pauses: 1, outcome: 'damaged' })
    }
  })

  it('calls a file damaged once two reads in a row see it unchanged, and takes it once it parses', async () => {
    await frozen(T, () => {
      expect(run([read('{"a":', 1000), read('{"a":1', 2000), read('{"a":1', 2000)])).toEqual({ pauses: 2, outcome: 'damaged' })
      expect(run([read('', T), read('{"a":', 3000), read('{"a":2}', 4000)])).toEqual({ pauses: 2, outcome: { value: { a: 2 } } })
      // Gone and still gone (a save that deletes, then renames, may yet bring it back): missing once the pauses run out.
      expect(run([null, null])).toEqual({ pauses: 6, outcome: 'missing' })
    })
  })

  for (const sync of [false, true]) {
    it(`leaves a file still changing after the pauses as it is, using its last good copy${sync ? ' (sync)' : ''}`, async () => {
      const f = join(dir, `busy-${sync ? 'sync' : 'async'}.json`)
      await writeKeptJson(f, { n: 5 })
      writeFileSync(f, '')
      // Emptied "a moment ago" for the whole budget: a save still in progress when the pauses run out.
      const soon = new Date(Date.now() + 60_000)
      utimesSync(f, soon, soon)
      const before = reports.length
      expect(sync ? readKeptJsonSync(f, null) : await readKeptJson(f, null)).toEqual({ n: 5 })
      expect(readFileSync(f, 'utf8')).toBe('')
      expect(readdirSync(dir).filter((n) => n.startsWith(`busy-${sync ? 'sync' : 'async'}.json.corrupt-`))).toEqual([])
      expect(reports.length).toBe(before)
    })
  }

  // #1601: a half-written file a stalled writer left unchanged for a while is only damaged once it is DAMAGED_AGE_MS
  // old; before that it is unsettled (the read keeps its last good copy) and a read for a change refuses.
  for (const sync of [false, true]) {
    it(`leaves a stable file that doesn't parse unsettled while it is recent, and recovers it once it is old${sync ? ' (sync)' : ''}`, async () => {
      const name = `stalled-${sync ? 'sync' : 'async'}.json`
      const f = join(dir, name)
      const readIt = async (): Promise<unknown> => (sync ? readKeptJsonSync(f, null) : await readKeptJson(f, null))
      const setAside = (): string[] => readdirSync(dir).filter((n) => n.startsWith(`${name}.corrupt-`))
      await writeKeptJson(f, { n: 6 })
      const half = JSON.stringify({ n: 7, items: ['a', 'b'] }).slice(0, 12)
      writeFileSync(f, half)
      utimesSync(f, new Date(T), new Date(T))
      const before = reports.length
      // 1 ms short of DAMAGED_AGE_MS old for the whole read, however long it takes: unsettled.
      await frozen(T + DAMAGED_AGE_MS - 1, async () => {
        expect(await readIt()).toEqual({ n: 6 })
        expect(readFileSync(f, 'utf8')).toBe(half)
        expect(setAside()).toEqual([])
        expect(reports.length).toBe(before)
        await expect(readKeptJson(f, null, { unsettled: 'throw' })).rejects.toBeInstanceOf(KeptFileBusy)
        expect(readFileSync(f, 'utf8')).toBe(half)
      })
      // DAMAGED_AGE_MS old: damaged, set aside and its last good copy restored.
      await frozen(T + DAMAGED_AGE_MS, async () => {
        expect(await readIt()).toEqual({ n: 6 })
        expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ n: 6 })
        expect(setAside()).toHaveLength(1)
        expect(reports.slice(before)).toEqual([[f, true]])
      })
    })
  }

  // #1598: something outside Combwork saving in place (truncate, then write) while Combwork reads must never look like damage.
  for (const sync of [false, true]) {
    it(`never sets aside a file being saved in place while it is read${sync ? ' (sync)' : ''}`, async () => {
      const f = join(dir, `save-${sync ? 'sync' : 'async'}.json`)
      const versions = [0, 1].map((v) => JSON.stringify({ v, items: Array.from({ length: 2000 }, (_, i) => `item ${i}`) }))
      await writeKeptJson(f, JSON.parse(versions[0]))
      const shared = new Int32Array(new SharedArrayBuffer(8)) // [0]: stop, [1]: saves made
      const writer = new Worker(
        `const { workerData: { f, versions, shared } } = require('worker_threads')
        const { openSync, writeSync, closeSync } = require('fs')
        const pause = new Int32Array(new SharedArrayBuffer(4))
        for (let n = 0; !Atomics.load(shared, 0); n++) {
          const text = versions[n % 2]
          const fd = openSync(f, 'w')
          writeSync(fd, text.slice(0, text.length >> 1))
          Atomics.wait(pause, 0, 0, 5) // a slow save: half written
          writeSync(fd, text.slice(text.length >> 1))
          closeSync(fd)
          Atomics.add(shared, 1, 1)
          Atomics.wait(pause, 0, 0, 20) // and saved again a moment later
        }`,
        { eval: true, workerData: { f, versions, shared } }
      )
      const before = reports.length
      try {
        for (let reads = 0; reads < 100 || Atomics.load(shared, 1) < 30; reads++) {
          const got = (sync ? readKeptJsonSync(f, null) : await readKeptJson(f, null)) as { v: number } | null
          expect([0, 1]).toContain(got?.v)
          if (sync) await new Promise((r) => setImmediate(r))
        }
      } finally {
        Atomics.store(shared, 0, 1)
        await new Promise((r) => writer.once('exit', r))
      }
      expect(reports.length).toBe(before)
      expect(readdirSync(dir).filter((n) => n.startsWith(`save-${sync ? 'sync' : 'async'}.json.corrupt-`))).toEqual([])
    })
  }
})

describe('spawn log lines', () => {
  it('hide bearer tokens and shorten long arguments', async () => {
    const { forLog } = await import('../src/main/ptyHost')
    expect(forLog('hooks.Stop=[{command="curl.exe -H \\"Authorization: Bearer 0123456789abcdef0123456789abcdef\\" x"}]')).not.toContain('0123456789abcdef')
    expect(forLog('CW_API_TOKEN=abcdef123456')).toBe('CW_API_TOKEN=***')
    expect(forLog('x'.repeat(1000)).length).toBeLessThan(340)
    expect(forLog('--model')).toBe('--model')
  })
})

describe('path guards', () => {
  it("don't let a link inside a folder lead outside it", async () => {
    const { mkdirSync, symlinkSync, writeFileSync: write } = await import('fs')
    const { insideReal } = await import('../src/main/fsutil')
    const base = tempDir('cw-guard-')
    const ws = join(base, 'ws')
    const outside = join(base, 'outside')
    mkdirSync(join(ws, 'proj'), { recursive: true })
    mkdirSync(outside)
    write(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(ws, 'proj', 'link'), 'junction')
    expect(insideReal(join(ws, 'proj', 'a.txt'), [ws])).toBe(true)
    expect(insideReal(join(ws, 'proj', 'new', 'b.txt'), [ws])).toBe(true)
    expect(insideReal(join(ws, 'proj', 'link', 'secret.txt'), [ws])).toBe(false)
    expect(insideReal(join(ws, '..', 'outside', 'secret.txt'), [ws])).toBe(false)
  })
})
