// The usage worker (#1106): records a session from its transcript, reads only what was added since (taking up its
// parser's state), never makes a session's totals smaller, keeps a kept usage only for a session it doesn't have, and
// leaves a session another writer recorded meanwhile as that writer wrote it.
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { Worker } from 'worker_threads'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { handleRequest, logInProcess, openableWaits, openFiles, type IngestJob, type IngestResult, type WorkerReply, type WorkerRequest } from '../src/main/usageWorker'
import { cursorOf, writeSession, type StoredSession } from '../src/main/usageDb'
import { rowsPart, summaryOf, usageFromRows } from '../src/shared/usageLedger'
import { priceUsage } from '../src/shared/usageDays'
import { newUsageParser } from '../src/main/usageParsers'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { estimateCost } from '../src/shared/prices'
import type { AppSettings, ProviderId, SessionUsage } from '../src/shared/types'
import { tempDir } from './tempDir'
import { leftByAKill, refusedNow, whileMapped } from './mappedShm'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const line = (i: number, output = 100): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }) + '\n'
const prompt = (i: number): string => JSON.stringify({ type: 'user', timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: 'user', content: `go ${i}` } }) + '\n'

let id = 0
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000

/** Holds a file open the way an editor or a virus scanner can: no sharing, so it can't be read (as sessionInUse.test.ts does). */
async function hold(file: string): Promise<ChildProcess> {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 60`
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the file was not held in time')), 20000)
    child.stdout!.on('data', (d) => {
      if (String(d).includes('held')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.on('exit', () => reject(new Error('the holder exited')))
  })
  return child
}
const call = (m: Record<string, unknown>): Promise<unknown> => handleRequest({ id: ++id, ...m } as never)

async function setup() {
  const dir = tempDir('hive-usage-worker-')
  const file = join(dir, '.combwork', 'usage.db')
  const transcript = join(dir, 'abc.jsonl')
  await call({ type: 'config', advanced: {}, providers: DEFAULT_SETTINGS.providers, hiveVersion: '9.9.9-test' })
  const job = (o: Partial<IngestJob> = {}): IngestJob => ({ scope: 'p1', session: 'abc', provider: 'claude-code', agentId: 'a1', path: transcript, holds: [], holdsKey: null, keepState: 'now', ...o })
  const ingest = (o?: Partial<IngestJob>) => call({ type: 'ingest', file, job: job(o) }) as Promise<IngestResult>
  const stored = async (): Promise<StoredSession | undefined> => ((await call({ type: 'sessions', file, scopes: ['p1'] })) as StoredSession[]).find((s) => s.session === 'abc')
  const output = async (): Promise<number> => (await stored())?.rows.reduce((n, r) => n + r.outputTokens, 0) ?? 0
  return { file, transcript, ingest, stored, output, close: () => call({ type: 'close', file }) }
}

describe('the usage worker', () => {
  it('records a session, does nothing more while its file is unchanged, and reads what was added from its saved state', async () => {
    const t = await setup()
    // A long line between the first request and the state's offset: its check covers only the bytes just before it.
    const pad = JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'x'.repeat(10_000) } }) + '\n'
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(200)
    expect((await t.ingest()).status).toBe('unchanged')
    // The part already read is changed (same length) far before the offset, where no reader would look again: only a read
    // from the saved state gives 300 after a line is added; a read from the start would see the changed part.
    writeFileSync(t.transcript, readFileSync(t.transcript, 'utf8').replace('"output_tokens":100}', '"output_tokens":900}'))
    appendFileSync(t.transcript, line(3))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it("doesn't take its state up for other bytes: a file that changed just before the offset is read from the start", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    await t.ingest()
    // Rewritten (shrank and grew again between reads): the bytes before the saved offset aren't the ones it was made from.
    writeFileSync(t.transcript, prompt(0) + line(1, 300) + line(2, 300) + line(3, 300))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(900)
    await t.close()
  })

  it("lets a state go once another file is read: a backup read, then grown, is read whole (its offsets aren't the transcript's)", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 30) + line(2, 30))
    await t.ingest()
    // The transcript went; Hive's backup has the same requests, written differently (a shorter first line).
    const backup = join(t.transcript, '..', 'backup.jsonl')
    writeFileSync(backup, line(1, 30) + line(2, 30))
    // As much as recorded: it's now what the session is read from (its state made from the transcript let go).
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(60)
    appendFileSync(backup, line(3, 30))
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(90)
    appendFileSync(backup, line(4, 30))
    expect((await t.ingest({ path: backup, keepState: 'no' })).status).toBe('written')
    expect(await t.output()).toBe(120)
    await t.close()
  })

  it("shares a session's cards out again when their holds change, without a new read of its file", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 10))
    await t.ingest()
    const card = async (): Promise<number> => (await t.stored())!.rows.filter((r) => r.card === 12).reduce((n, r) => n + r.outputTokens, 0)
    expect(await card()).toBe(0)
    expect((await t.ingest({ holds: [{ card: 12, role: 'build', parts: [[1, [[T0, T0 + 5000]]]] }], holdsKey: 'k1' })).status).toBe('unchanged')
    expect(await card()).toBe(10)
    expect(await t.output()).toBe(10)
    await t.close()
  })

  it('reads from the start when its state is from another Hive version (and the result is the same)', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    await t.ingest()
    await call({ type: 'config', advanced: {}, providers: DEFAULT_SETTINGS.providers, hiveVersion: '9.9.10-test' })
    appendFileSync(t.transcript, line(3))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it("never makes a session's totals smaller: a file cut short leaves what was recorded", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2) + line(3))
    await t.ingest()
    writeFileSync(t.transcript, prompt(0) + line(1))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(300)
    // A file that is gone leaves it too.
    expect((await t.ingest({ path: join(t.transcript, '..', 'gone.jsonl') })).status).toBe('unchanged')
    expect(await t.output()).toBe(300)
    await t.close()
  })

  it('keeps a kept usage that counted more than a stale backup, and never one that counted less', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 10))
    await t.ingest()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1, 500))
    const kept = priceUsage(p.result(), DEFAULT_SETTINGS)
    const job = { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null }
    expect(((await call({ type: 'kept', file: t.file, job })) as IngestResult).status).toBe('written')
    expect(await t.output()).toBe(500)
    // The stale backup read again: the kept usage stays its baseline.
    appendFileSync(t.transcript, prompt(5))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(500)
    // A kept usage that counted less of everything changes nothing.
    const less = newUsageParser('claude-code', 'abc')!
    less.feed(prompt(0) + line(1, 1))
    await call({ type: 'kept', file: t.file, job: { ...job, usage: priceUsage(less.result(), DEFAULT_SETTINGS) } })
    expect(await t.output()).toBe(500)
    await t.close()
  })

  it('keeps each count and the known cost of both a file and a kept usage that disagree (none wins by a sum)', async () => {
    const t = await setup()
    // The transcript: one request, 100 in and 1 out. The kept usage: two requests, 2 in and 20 out, priced at $5.
    writeFileSync(t.transcript, JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: new Date(T0).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 1 } } }) + '\n')
    await t.ingest()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(['a', 'b'].map((rid) => JSON.stringify({ type: 'assistant', requestId: rid, timestamp: new Date(T0).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 10 } } })).join('\n') + '\n')
    const kept = { ...priceUsage(p.result(), DEFAULT_SETTINGS), costUsd: 5, costEstimated: false }
    for (const d of Object.values(kept.days ?? {})) Object.assign(d, { costUsd: 5, costEstimated: false })
    await call({ type: 'kept', file: t.file, job: { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null } })
    const totals = async () => {
      const s = (await t.stored())!
      return { input: s.rows.reduce((n, r) => n + r.inputTokens, 0), output: s.rows.reduce((n, r) => n + r.outputTokens, 0), requests: s.rows.reduce((n, r) => n + r.requests, 0), cost: usageFromRows(s.summary, s.rows, DEFAULT_SETTINGS).costUsd! }
    }
    let now = await totals()
    expect([now.input, now.output, now.requests]).toEqual([100, 20, 2])
    expect(now.cost).toBeGreaterThanOrEqual(5)
    // The file read again (grown by a prompt): still both.
    appendFileSync(t.transcript, prompt(1))
    await t.ingest()
    now = await totals()
    expect([now.input, now.output, now.requests]).toEqual([100, 20, 2])
    expect(now.cost).toBeGreaterThanOrEqual(5)
    await t.close()
  })

  it('never erases a charge the provider reported, nor charges its tokens twice: a rewrite without its report, its cards shared out again, costs the same', async () => {
    const t = await setup()
    const req = (rid: string, input: number, output: number, at = T0): string => JSON.stringify({ type: 'assistant', requestId: rid, timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output } } }) + '\n'
    const charge = JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 1000).toISOString(), totalCostUSD: 0.5 }) + '\n'
    const own = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], costSource: 'prices' as const } } }
    const priced = async (settings: Pick<AppSettings, 'providers'> = DEFAULT_SETTINGS) => {
      const s = (await t.stored())!
      const u = usageFromRows(s.summary, s.rows, settings)
      return { cost: u.costUsd!, input: u.inputTokens, output: u.outputTokens, requests: u.requests }
    }
    const est = (input: number, output: number): number => estimateCost({ provider: 'claude-code', model: 'claude-opus-5-5', inputTokens: input, outputTokens: output, cacheWriteTokens: 0, cacheReadTokens: 0 }, DEFAULT_SETTINGS)!
    writeFileSync(t.transcript, req('r1', 100_000, 10_000) + charge)
    await t.ingest()
    expect((await priced()).cost).toBeCloseTo(0.5, 9)
    // Rewritten without the report: the same request and a new prompt. The same use, the same cost: $0.50, not $1.10.
    writeFileSync(t.transcript, req('r1', 100_000, 10_000) + prompt(5))
    expect((await t.ingest()).status).toBe('written')
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    // Its cards shared out again (a hold now covering the request, then another): which card has it changes, not the cost.
    const share = (card: number, key: string) => call({ type: 'attribute', file: t.file, scope: 'p1', sessions: [{ session: 'abc', holds: [{ card, role: 'build', parts: [[1, [[T0 - 1000, T0 + 5000]]]] }], holdsKey: key }] })
    expect(await share(12, 'h1')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    // The card holding the whole request has its whole charge, as reported (round 7): never its tokens for free.
    const card = async (n: number) => rowsPart((await t.stored())!.rows.filter((r) => r.card === n), 'claude-code', DEFAULT_SETTINGS)
    expect(await card(12)).toMatchObject({ inputTokens: 100_000, outputTokens: 10_000, requests: 1, cost: expect.closeTo(0.5, 9), priced: 1, unpriced: 0, estimated: false })
    expect(await share(13, 'h2')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    expect(await card(13)).toMatchObject({ cost: expect.closeTo(0.5, 9), priced: 1 })
    expect(await card(12)).toBeNull()
    // Two cards held at once: half each, and still $0.50 in all.
    const both = [15, 16].map((c) => ({ card: c, role: 'build' as const, parts: [[2, [[T0 - 1000, T0 + 5000]]]] as [number, [number, number][]][] }))
    expect(await call({ type: 'attribute', file: t.file, scope: 'p1', sessions: [{ session: 'abc', holds: both, holdsKey: 'hb' }] })).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5, 9), input: 100_000, output: 10_000, requests: 1 })
    expect((await card(15))!.cost + (await card(16))!.cost).toBeCloseTo(0.5, 9)
    expect((await card(15))!.cost).toBeCloseTo(0.25, 3)
    expect(await share(13, 'h2')).toBe(1)
    // A request added, still without a report: the old charge, and Hive's estimate for the new request alone.
    appendFileSync(t.transcript, req('r2', 1_000, 100, T0 + 2000))
    expect((await t.ingest({ holds: [{ card: 13, role: 'build', parts: [[1, [[T0 - 1000, T0 + 5000]]]] }], holdsKey: 'h2' })).status).toBe('written')
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5 + est(1_000, 100), 9), input: 101_000, output: 10_100, requests: 2 })
    // And shared out again once more: the same.
    expect(await share(14, 'h3')).toBe(1)
    expect(await priced()).toEqual({ cost: expect.closeTo(0.5 + est(1_000, 100), 9), input: 101_000, output: 10_100, requests: 2 })
    // The user's own prices (#436): Hive's estimate for all of it, as for any session.
    expect((await priced(own)).cost).toBeCloseTo(est(101_000, 10_100), 9)
    await t.close()
  })

  it.runIf(process.platform === 'win32')('says a file it could not read failed, not unchanged: a delete must not take what is recorded as all of it', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1))
    await t.ingest()
    appendFileSync(t.transcript, line(2))
    // Held open by another program (no sharing), its unread end can't be read: failed, what was recorded left as it was.
    const holder = await hold(t.transcript)
    try {
      expect((await t.ingest()).status).toBe('failed')
      expect(await t.output()).toBe(100)
    } finally {
      holder.kill()
    }
    await t.close()
  })

  it("records a kept usage only for a session it doesn't have, at the cost it was kept with", async () => {
    const t = await setup()
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1, 500))
    const kept = priceUsage(p.result(), DEFAULT_SETTINGS)
    const keptJob = { scope: 'p1', session: 'abc', provider: 'claude-code', usage: kept, holds: [], holdsKey: null }
    expect(((await call({ type: 'kept', file: t.file, job: keptJob })) as IngestResult).status).toBe('written')
    expect(await t.output()).toBe(500)
    expect((await t.stored())?.source).toBe('kept')
    // Another kept usage that counted less takes nothing away; its transcript, read later, adds what it has more of.
    await call({ type: 'kept', file: t.file, job: { ...keptJob, usage: { ...kept, outputTokens: 1, days: {} } } })
    expect(await t.output()).toBe(500)
    writeFileSync(t.transcript, prompt(0) + line(1, 500) + line(2))
    expect((await t.ingest()).status).toBe('written')
    expect(await t.output()).toBe(600)
    expect((await t.stored())?.source).toBe('transcript')
    await t.close()
  })

  it('leaves a session another writer recorded meanwhile as it wrote it', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1))
    await t.ingest()
    await t.close()
    const db = new DatabaseSync(t.file)
    const was = cursorOf(db, 'p1', 'abc')!
    const p = newUsageParser('claude-code', 'abc')!
    p.feed(prompt(0) + line(1))
    const w = { scope: 'p1', session: 'abc', provider: 'claude-code' as const, source: 'transcript' as const, path: t.transcript, size: 1, mtime: 1, offset: 1, state: null, summary: summaryOf(p.result()), timeline: null, rows: [], holdsKey: null, baseline: null }
    // From an older point than what is recorded now: refused, nothing written.
    expect(writeSession(db, w, { offset: was.offset - 1, path: was.path })).toBe(false)
    expect(cursorOf(db, 'p1', 'abc')!.tokens).toBe(was.tokens)
    // From what is recorded: written.
    expect(writeSession(db, w, { offset: was.offset, path: was.path })).toBe(true)
    db.close()
  })

  it('answers the cards a session worked on, with whose session each row is', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2) + line(3))
    await t.ingest({ holds: [{ card: 12, role: 'review', parts: [[1, [[T0 + 1500, T0 + 3500]]]] }] })
    const rows = (await call({ type: 'cards', file: t.file, cards: [12] })) as { session: string; agentId?: string; row: { card: number; role: string; outputTokens: number } }[]
    expect(rows.map((r) => [r.session, r.agentId, r.row.role, r.row.outputTokens])).toEqual([['abc', 'a1', 'review', 200]])
    await t.close()
  })

  it("answers only the named sessions' timelines, of that scope alone (HI-1906: a card's)", async () => {
    const t = await setup()
    const other = join(t.transcript, '..', 'def.jsonl')
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    writeFileSync(other, prompt(0) + line(5))
    await t.ingest()
    await t.ingest({ session: 'def', path: other })
    // The same session id in another scope (another host's session): never one of p1's.
    await t.ingest({ scope: 'p2', path: other })
    type Timeline = { scope: string; session: string; timeline: { rows: unknown[] } | null }
    const timelines = async (scope: string, sessions?: string[]) => ((await call({ type: 'timelines', file: t.file, scope, ...(sessions ? { sessions } : {}) })) as Timeline[]).map((s) => [s.scope, s.session, s.timeline?.rows.length ?? 0]).sort()
    expect(await timelines('p1')).toEqual([['p1', 'abc', 2], ['p1', 'def', 1]])
    expect(await timelines('p1', ['abc'])).toEqual([['p1', 'abc', 2]])
    expect(await timelines('p2', ['abc'])).toEqual([['p2', 'abc', 1]])
    expect(await timelines('p1', ['abc', 'nope'])).toEqual([['p1', 'abc', 2]])
    expect(await timelines('p1', [])).toEqual([])
    await t.close()
  })
})

// Reads for main (#1147): a running session's footer and context gauge, read here rather than in main's thread.
describe('the usage worker reading a transcript for main', () => {
  // A long line: a change before it is outside a saved state's check (the bytes just before its offset).
  const pad = JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'x'.repeat(10_000) } }) + '\n'
  /** Changes the first request's output (same length), where only a read from the start would look again. */
  const changeRead = (file: string): void => writeFileSync(file, readFileSync(file, 'utf8').replace('"output_tokens":100}', '"output_tokens":900}'))
  const read = (t: { file: string; transcript: string }, seed = true) => call({ type: 'read', path: t.transcript, session: 'abc', provider: 'claude-code', seed: seed ? { file: t.file, scope: 'p1' } : null }) as Promise<{ usage: SessionUsage; size: number } | null>

  it('reads only what the file added since its last read, and nothing while it is unchanged', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    const first = (await read(t))!
    expect(first.usage.outputTokens).toBe(200)
    expect(first.size).toBe(readFileSync(t.transcript).length)
    expect(first.usage).not.toHaveProperty('timeline')
    changeRead(t.transcript)
    appendFileSync(t.transcript, line(3))
    // Grown: only the added line is read, so the change before it isn't seen.
    expect((await read(t))!.usage.outputTokens).toBe(300)
    appendFileSync(t.transcript, line(4))
    expect((await read(t))!.usage.outputTokens).toBe(400)
    await t.close()
  })

  it("after a restart, takes the session's saved state up: a resumed session's first growth reads only what was added", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    // The session ended: what it used recorded, with its parser's state.
    await t.ingest({ keepState: 'now' })
    // Hive restarted: nothing read in this run.
    await call({ type: 'forgetReads' })
    changeRead(t.transcript)
    appendFileSync(t.transcript, line(3))
    expect((await read(t))!.usage.outputTokens).toBe(300)
    appendFileSync(t.transcript, line(4))
    expect((await read(t))!.usage.outputTokens).toBe(400)
    // Without the history to take it from (the check that the change is seen by a read from the start).
    await call({ type: 'forgetReads' })
    expect((await read(t, false))!.usage.outputTokens).toBe(1200)
    await t.close()
  })

  it("reads from the start when the saved state isn't this file's: rewritten, or shorter than its offset", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + line(2))
    await t.ingest({ keepState: 'now' })
    await call({ type: 'forgetReads' })
    writeFileSync(t.transcript, prompt(0) + line(1, 300))
    expect((await read(t))!.usage.outputTokens).toBe(300)
    // Shrank since the last read: read again.
    writeFileSync(t.transcript, prompt(0) + line(1, 50))
    expect((await read(t))!.usage.outputTokens).toBe(50)
    await t.close()
  })

  it("an ingest of a running session goes on from the parser the footer's read left, so it is read once", async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    expect((await read(t))!.usage.outputTokens).toBe(200)
    changeRead(t.transcript)
    appendFileSync(t.transcript, line(3))
    expect((await t.ingest({ keepState: 'running' })).status).toBe('written')
    expect(await t.output()).toBe(300)
    // And the next read goes on from where the ingest stopped.
    appendFileSync(t.transcript, line(4))
    expect((await read(t))!.usage.outputTokens).toBe(400)
    // The session ended: its parser let go, its state saved: a read after it takes the state up.
    expect((await t.ingest({ keepState: 'now' })).status).toBe('written')
    appendFileSync(t.transcript, line(5))
    expect((await read(t))!.usage.outputTokens).toBe(500)
    await t.close()
  })

  it('reads of one file take turns: reads asked for at once each give the whole file, counted once', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + Array.from({ length: 200 }, (_, i) => line(i + 1, 1)).join(''))
    const all = await Promise.all([read(t), read(t), t.ingest({ keepState: 'running' }), read(t)])
    expect(all.filter((r): r is { usage: SessionUsage; size: number } => !!r && 'usage' in r).map((r) => r.usage.outputTokens)).toEqual([200, 200, 200])
    expect(await t.output()).toBe(200)
    await t.close()
  })

  it("gives every provider's context fields as its parser does, read in two parts", async () => {
    const t = await setup()
    const fixtures: [ProviderId, string][] = [
      ['claude-code', prompt(0) + line(1) + JSON.stringify({ type: 'assistant', requestId: 'r9', timestamp: new Date(T0 + 9000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 2_000, output_tokens: 300 } } }) + '\n'],
      ['codex', readFileSync(join(__dirname, 'fixtures', 'codex-0.159.jsonl'), 'utf8')],
      ['copilot', readFileSync(join(__dirname, 'fixtures', 'copilot', 'compaction-1.0.98.jsonl'), 'utf8')]
    ]
    for (const [provider, text] of fixtures) {
      const lines = text.split(/(?<=\n)/)
      const half = Math.floor(lines.length / 2)
      const path = join(t.transcript, '..', `${provider}.jsonl`)
      writeFileSync(path, lines.slice(0, half).join(''))
      const ask = () => call({ type: 'read', path, session: 'abc', provider, seed: null }) as Promise<{ usage: SessionUsage }>
      await ask()
      appendFileSync(path, lines.slice(half).join(''))
      const got = (await ask()).usage
      const p = newUsageParser(provider, 'abc')!
      p.feed(text)
      const { timeline: _timeline, ...want } = p.result()
      expect(got, provider).toEqual(want)
      const context = (u: SessionUsage) => ({ model: u.model, contextTokens: u.contextTokens, contextInputTokens: u.contextInputTokens, lastOutputTokens: u.lastOutputTokens, contextWindow: u.contextWindow, compactions: u.compactions.length })
      expect(context(got), provider).toEqual(context(want))
      expect(got.contextTokens, provider).toBeGreaterThan(0)
    }
    await t.close()
  })

  it("a session that ran on a server connection (HI-1772): its CLI's Claude-priced cost report never counted, in the history or a read", async () => {
    const t = await setup()
    // A server's model (no price of Hive's), with the cost Claude Code reported for it priced as a Claude model.
    const server = (i: number): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'deepseek-flash', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } }) + '\n'
    const report = JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 3000).toISOString(), totalCostUSD: 4.2 }) + '\n'
    writeFileSync(t.transcript, prompt(0) + server(1) + server(2) + report)
    const settings = { providers: DEFAULT_SETTINGS.providers }
    const cost = async () => { const st = (await t.stored())!; return usageFromRows(st.summary, st.rows, settings).costUsd }
    // As a sign-in session: the report is its cost.
    expect((await t.ingest()).status).toBe('written')
    expect(await cost()).toBeCloseTo(4.2)
    // The same session, now marked (its record's serverRan): the same file, unchanged, read again without the report.
    const tokens = async () => (await t.stored())!.rows.reduce((n, r) => n + r.outputTokens, 0)
    const days = async () => [...new Set((await t.stored())!.rows.map((r) => r.day))]
    const daysBefore = await days()
    expect((await t.ingest({ reportsIgnored: true })).status).toBe('written')
    expect(await cost()).toBeNull()
    expect(await tokens()).toBe(200)
    expect(await days()).toEqual(daysBefore)
    // A late job from before it was marked: never brings the report back; then nothing to do.
    expect((await t.ingest({ reportsIgnored: false })).status).toBe('unchanged')
    expect(await cost()).toBeNull()
    // More of the file, read on from its saved parser: still without the report.
    appendFileSync(t.transcript, server(4) + JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 5000).toISOString(), totalCostUSD: 6.3 }) + '\n')
    expect((await t.ingest()).status).toBe('written')
    expect(await cost()).toBeNull()
    expect(await tokens()).toBe(300)
    // A read for its footer the same way; without the flag, the report.
    const readFor = (reportsIgnored?: boolean) => call({ type: 'read', path: t.transcript, session: 'abc', provider: 'claude-code', seed: null, ...(reportsIgnored ? { reportsIgnored } : {}) }) as Promise<{ usage: SessionUsage }>
    expect(priceUsage((await readFor(true)).usage, settings).costUsd).toBeNull()
    expect(priceUsage((await readFor()).usage, settings).costUsd).toBeCloseTo(6.3)
    // A session marked once its transcript is gone: its stored rows stripped of the report, counts kept.
    const g = await setup()
    writeFileSync(g.transcript, readFileSync(t.transcript, 'utf8'))
    expect((await g.ingest()).status).toBe('written')
    rmSync(g.transcript)
    expect((await g.ingest({ reportsIgnored: true })).status).toBe('written')
    const gs = (await g.stored())!
    expect(usageFromRows(gs.summary, gs.rows, settings).costUsd).toBeNull()
    expect(gs.rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(300)
    await g.close()
    await t.close()
  })

  it('free (HI-1772, Darren 27 Oct): only on servers on this PC, a known $0 whatever prices are set; a run anywhere else ends it for good', async () => {
    const t = await setup()
    // A local model, priced by the user (a price local-only sessions never use), and Claude Code's report beside it.
    const local = (i: number): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'qwen3:8b', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } }) + '\n'
    writeFileSync(t.transcript, prompt(0) + local(1) + JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 2000).toISOString(), totalCostUSD: 3 }) + '\n')
    const settings = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], prices: { 'qwen3:8b': { input: 1000, cachedInput: 0, output: 1000 } } } } }
    const usage = async () => {
      const st = (await t.stored())!
      return usageFromRows(st.summary, st.rows, settings)
    }
    // Local only: free, $0 known, its tokens counted.
    expect((await t.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('written')
    expect(await usage()).toMatchObject({ costUsd: 0, costFree: true, outputTokens: 100 })
    // Unchanged, the same again.
    expect((await t.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    // A run elsewhere (a remote server, a sign-in): not free from now on; the user's price for its model then applies.
    expect((await t.ingest({ reportsIgnored: true, notLocal: true })).status).toBe('written')
    const after = await usage()
    expect(after.costFree).toBeUndefined()
    expect(after.costUsd).toBeGreaterThan(0)
    expect(after.outputTokens).toBe(100)
    // A stale job from before (local alone) never makes it free again.
    expect((await t.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    expect((await usage()).costFree).toBeUndefined()
    // Remote first, then local: never free.
    const r = await setup()
    writeFileSync(r.transcript, readFileSync(t.transcript, 'utf8'))
    expect((await r.ingest({ reportsIgnored: true, notLocal: true })).status).toBe('written')
    expect((await r.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    const rs = (await r.stored())!
    expect(usageFromRows(rs.summary, rs.rows, settings).costFree).toBeUndefined()
    await r.close()
    await t.close()
  })

  it('a locality fact on an unchanged file is kept (HI-1772 follow-up): history from before the flags, notLocal, then a stale local job, across a reopen', async () => {
    const h = await setup()
    const qwen = (i: number): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'qwen3:8b', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } }) + '\n'
    writeFileSync(h.transcript, prompt(0) + qwen(1))
    const settings = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], prices: { 'qwen3:8b': { input: 1000, cachedInput: 0, output: 1000 } } } } }
    // Recorded with no locality at all (as a history from before this change).
    expect((await h.ingest({ reportsIgnored: true })).status).toBe('written')
    // The same file, unchanged: a run elsewhere is told; nothing to read, but the fact is kept.
    expect((await h.ingest({ reportsIgnored: true, notLocal: true })).status).toBe('unchanged')
    // A stale local-only job after it: the stored disqualifier stands.
    expect((await h.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    const priced = async () => {
      const st = (await h.stored())!
      return usageFromRows(st.summary, st.rows, settings)
    }
    expect((await priced()).costFree).toBeUndefined()
    expect((await priced()).costUsd).toBeGreaterThan(0)
    // Reopened (the history's file closed and read again): the same.
    await h.close()
    expect((await h.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    expect((await priced()).costFree).toBeUndefined()
    await h.close()
  })

  it("an Ollama cloud model (HI-1773, Darren 27 Oct): a conversation free while local only, then run on a connection with a cloud model: Hive's price for that id, never the CLI's report", async () => {
    const t = await setup()
    // Claude Code's own $5 for it, priced as a Claude model, beside the requests.
    const cloud = (i: number): string => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), message: { model: 'glm-4.6:cloud', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } }) + '\n'
    writeFileSync(t.transcript, prompt(0) + cloud(1) + JSON.stringify({ type: 'cost-state', timestamp: new Date(T0 + 2000).toISOString(), totalCostUSD: 5 }) + '\n')
    const priced = { providers: { ...DEFAULT_SETTINGS.providers, 'claude-code': { ...DEFAULT_SETTINGS.providers['claude-code'], prices: { 'glm-4.6:cloud': { input: 1_000_000, cachedInput: 0, output: 1_000_000 } } } } }
    const unpriced = { providers: DEFAULT_SETTINGS.providers }
    const usage = async (settings: typeof unpriced) => {
      const st = (await t.stored())!
      return usageFromRows(st.summary, st.rows, settings)
    }
    // Its first runs on a connection that was local only: free.
    expect((await t.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('written')
    expect(await usage(priced)).toMatchObject({ costUsd: 0, costFree: true })
    // Its connection gained a cloud model, so its next launch wasn't local (runsLocally): the same file, unchanged, its
    // free rows read again as charges.
    expect((await t.ingest({ reportsIgnored: true, notLocal: true })).status).toBe('written')
    const after = await usage(priced)
    expect(after.costFree).toBeUndefined()
    // The user's price for glm-4.6:cloud (10 + 100 tokens at $1 each), not the $5 Claude Code reported.
    expect(after.costUsd).toBeCloseTo(110)
    expect(after.outputTokens).toBe(100)
    // No price for it: unpriced, its tokens still counted.
    expect(await usage(unpriced)).toMatchObject({ costUsd: null, outputTokens: 100 })
    // A stale job from while it was local never makes it free again.
    expect((await t.ingest({ reportsIgnored: true, serverLocal: true })).status).toBe('unchanged')
    expect((await usage(priced)).costFree).toBeUndefined()
    await t.close()
  })
})

describe('the usage worker as main starts it (HI-1729)', () => {
  it('loads in a worker thread, where Electron has no `app`, and answers a job (since HI-1684 its logger threw there and ended it on every start)', async () => {
    const base = tempDir('hive-usage-worker-thread-')
    // What `electron` is in a worker of Electron's main process: the npm package's export, a path, with no `app`.
    const stub = join(base, 'electron-in-worker.cjs')
    writeFileSync(stub, "module.exports = 'C:\\\\electron\\\\electron.exe'\n")
    const script = join(base, 'usage-worker.cjs')
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'usageWorker.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs', electron: stub }, logLevel: 'silent' })
    const w = new Worker(script)
    try {
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        w.on('message', (m: WorkerReply) => {
          if ('id' in m) resolve(m)
        })
        w.once('error', reject)
        w.once('exit', (code) => reject(new Error(`the usage worker ended (${code})`)))
        w.postMessage({ id: 1, type: 'sessions', file: join(base, 'usage.db'), scopes: null } satisfies WorkerRequest)
      })
      expect(reply).toEqual({ id: 1, ok: true, value: [] })
    } finally {
      await w.terminate()
    }
  })
})

describe.runIf(process.platform === 'win32')('a usage history whose -shm another process still maps (HI-2200)', () => {
  const logged: string[] = []
  const capture = (m: WorkerReply): void => {
    if ('log' in m) logged.push(m.text)
  }

  it('its requests wait for it to be let go, then the history opens with what it kept', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 100))
    await t.ingest()
    await t.close()
    await leftByAKill(t.file)
    logInProcess(capture)
    try {
      await whileMapped(dirname(t.file), `${t.file}-shm`, async (release) => {
        expect(refusedNow(t.file)).toBe(1546)
        const output = t.output()
        await vi.waitFor(() => expect(logged.some((l) => l.includes("can't be opened yet"))).toBe(true), { timeout: HUNG_MS, interval: 20 })
        release()
        expect(await output).toBe(100)
      })
    } finally {
      logInProcess(() => undefined)
      logged.length = 0
      await t.close()
    }
  })

  // A resumed session's read takes its saved state up from the history (#1147): shown by a change before the offset,
  // which only a read from the start sees (as "after a restart, takes the session's saved state up" does).
  const pad = JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'x'.repeat(10_000) } }) + '\n'
  const changeRead = (file: string): void => writeFileSync(file, readFileSync(file, 'utf8').replace('"output_tokens":100}', '"output_tokens":900}'))
  const seeded = async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1) + pad + line(2))
    await t.ingest({ keepState: 'now' })
    await t.close()
    await call({ type: 'forgetReads' })
    changeRead(t.transcript)
    appendFileSync(t.transcript, line(3))
    await leftByAKill(t.file)
    const read = (noWait?: boolean) => call({ type: 'read', path: t.transcript, session: 'abc', provider: 'claude-code', seed: { file: t.file, scope: 'p1' }, ...(noWait ? { noWait } : {}) }) as Promise<{ usage: SessionUsage } | null>
    return { ...t, read }
  }

  it("a resumed session's read waits for its history too, then takes its saved state up", async () => {
    const t = await seeded()
    logInProcess(capture)
    try {
      await whileMapped(dirname(t.file), `${t.file}-shm`, async (release) => {
        const reading = t.read()
        await vi.waitFor(() => expect(logged.some((l) => l.includes("can't be opened yet"))).toBe(true), { timeout: HUNG_MS, interval: 20 })
        release()
        // 300: only what was added since its saved state was read (from the start, it would be 1100).
        expect((await reading)!.usage.outputTokens).toBe(300)
        expect(logged.some((l) => l.includes("couldn't look for a session's saved state"))).toBe(false)
      })
    } finally {
      logInProcess(() => undefined)
      logged.length = 0
      await t.close()
    }
    expect(openableWaits()).toBe(0)
  })

  it("a start's read never waits for it: it gets nothing while the history can't be opened, and its state once it can", async () => {
    const t = await seeded()
    logInProcess(capture)
    try {
      await whileMapped(dirname(t.file), `${t.file}-shm`, async () => {
        expect(await t.read(true)).toBeNull()
        // Nothing waited, nothing is left waiting.
        expect(logged.some((l) => l.includes("can't be opened yet"))).toBe(false)
        expect(openableWaits()).toBe(0)
      })
      expect((await t.read(true))!.usage.outputTokens).toBe(300)
    } finally {
      logInProcess(() => undefined)
      logged.length = 0
      await t.close()
    }
  })

  it("a close while a resumed session's read waits: the read goes on without the history, which isn't opened again", async () => {
    const t = await seeded()
    logInProcess(capture)
    try {
      await whileMapped(dirname(t.file), `${t.file}-shm`, async () => {
        const reading = t.read()
        await vi.waitFor(() => expect(logged.some((l) => l.includes("can't be opened yet"))).toBe(true), { timeout: HUNG_MS, interval: 20 })
        await t.close()
        // 1100 (900 + 100 + 100): read from the start, its saved state not taken up from a history that has gone.
        expect((await reading)!.usage.outputTokens).toBe(1100)
        expect(openFiles()).not.toContain(t.file.toLowerCase())
        expect(openableWaits()).toBe(0)
      })
    } finally {
      logInProcess(() => undefined)
      logged.length = 0
    }
  })

  it('a close while they wait ends the wait at once, and the requests that waited are refused', async () => {
    const t = await setup()
    writeFileSync(t.transcript, prompt(0) + line(1, 100))
    await t.ingest()
    await t.close()
    await leftByAKill(t.file)
    logInProcess(capture)
    try {
      await whileMapped(dirname(t.file), `${t.file}-shm`, async () => {
        const waiting = t.stored().then(() => 'answered', (e: Error) => e.message)
        await vi.waitFor(() => expect(logged.some((l) => l.includes("can't be opened yet"))).toBe(true), { timeout: HUNG_MS, interval: 20 })
        await t.close()
        // Still mapped: the wait ended for the close, not for the file.
        expect(await waiting).toMatch(/closed while it waited/)
        expect(refusedNow(t.file)).toBe(1546)
        expect(openableWaits()).toBe(0)
      })
    } finally {
      logInProcess(() => undefined)
      logged.length = 0
    }
    // Let go: a request after the close opens it.
    expect(await t.output()).toBe(100)
    await t.close()
  })
})
