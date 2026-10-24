import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { describe, expect, it } from 'vitest'
import { keptSettleSteps, onCorruptFile, readKeptJson, readKeptJsonSync, writeKeptJson, type KeptSample, type KeptSettled } from '../src/main/fsutil'
import { tempDir } from './tempDir'

describe('kept files', () => {
  const dir = tempDir('hive-kept-')
  const reports: [string, boolean][] = []
  onCorruptFile((file, _aside, restored) => reports.push([file, restored]))

  it('saves a .bak copy with every write', async () => {
    const f = join(dir, 'a.json')
    await writeKeptJson(f, { n: 1 })
    expect(JSON.parse(readFileSync(`${f}.bak`, 'utf8'))).toEqual({ n: 1 })
    expect(await readKeptJson(f, null)).toEqual({ n: 1 })
  })

  it('sets a damaged file aside and restores the last good copy', async () => {
    const f = join(dir, 'b.json')
    await writeKeptJson(f, { sessions: ['s1'] })
    writeFileSync(f, '{ "sessions": [')
    expect(await readKeptJson(f, { sessions: [] })).toEqual({ sessions: ['s1'] })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ sessions: ['s1'] })
    expect(readdirSync(dir).some((n) => n.startsWith('b.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, true])
  })

  it('falls back to the default when there is no good copy, keeping the damaged file', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, 'not json')
    expect(readKeptJsonSync(f, { fresh: true })).toEqual({ fresh: true })
    expect(readdirSync(dir).some((n) => n.startsWith('c.json.corrupt-'))).toBe(true)
    expect(reports.at(-1)).toEqual([f, false])
  })

  it('treats a missing file as new, not damaged', async () => {
    const before = reports.length
    expect(await readKeptJson(join(dir, 'missing.json'), 7)).toBe(7)
    expect(reports.length).toBe(before)
  })

  it('sets aside an empty file that was emptied a while ago', async () => {
    const f = join(dir, 'd.json')
    await writeKeptJson(f, { n: 4 })
    writeFileSync(f, '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(f, old, old)
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

  it('keeps reading a file that keeps changing, and leaves it unsettled when the pauses run out', () => {
    const changing = Array.from({ length: 20 }, (_, i) => read(`{"a":${'1'.repeat(i + 1)}`, 1000 + i))
    expect(run(changing)).toEqual({ pauses: 6, outcome: 'unsettled' })
  })

  it('counts a file emptied a moment ago as still saving to the end, and one emptied long ago as damaged', () => {
    expect(run([read('', Date.now())])).toEqual({ pauses: 6, outcome: 'unsettled' })
    expect(run([read('', Date.now() - 60_000)])).toEqual({ pauses: 1, outcome: 'damaged' })
  })

  it('calls a file damaged once two reads in a row see it unchanged, and takes it once it parses', () => {
    expect(run([read('{"a":', 1000), read('{"a":1', 2000), read('{"a":1', 2000)])).toEqual({ pauses: 2, outcome: 'damaged' })
    expect(run([read('', Date.now()), read('{"a":', 3000), read('{"a":2}', 4000)])).toEqual({ pauses: 2, outcome: { value: { a: 2 } } })
    // Gone and still gone (a save that deletes, then renames, may yet bring it back): missing once the pauses run out.
    expect(run([null, null])).toEqual({ pauses: 6, outcome: 'missing' })
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

  // #1598: something outside Hive saving in place (truncate, then write) while Hive reads must never look like damage.
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
    expect(forLog('HIVE_API_TOKEN=abcdef123456')).toBe('HIVE_API_TOKEN=***')
    expect(forLog('x'.repeat(1000)).length).toBeLessThan(340)
    expect(forLog('--model')).toBe('--model')
  })
})

describe('path guards', () => {
  it("don't let a link inside a folder lead outside it", async () => {
    const { mkdirSync, symlinkSync, writeFileSync: write } = await import('fs')
    const { insideReal } = await import('../src/main/fsutil')
    const base = tempDir('hive-guard-')
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
