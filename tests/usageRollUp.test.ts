// The usage history's roll-up (HI-1648, Darren 27 Oct): a session that ended longer ago than Settings → Advanced's days
// of full detail (14 by default) has its timeline merged into 1-hour steps, its tokens, requests and charges unchanged,
// and what reads its timeline (a lane's cost, its cards shared out again) gives the same totals; a recent or running
// session is left alone; and the space it frees goes back to the disk (one whole vacuum on an older file, then
// incremental).
import { statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { handleRequest, type IngestJob, type IngestResult, type RollUpResult } from '../src/main/usageWorker'
import type { StoredSession } from '../src/main/usageDb'
import { chargeShares, coarsenTimeline, COARSE_STEP, type UsageRow, type UsageTimeline } from '../src/shared/usageTimeline'
import { usageFromRows, type SessionHold, type UsageSummary } from '../src/shared/usageLedger'
import { sliceSession } from '../src/shared/cardCosts'
import { USAGE_TIMELINE_DETAIL_DAYS } from '../src/shared/advanced'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

const DAY = 86_400_000
let id = 0
const call = (m: Record<string, unknown>): Promise<unknown> => handleRequest({ id: ++id, ...m } as never)

/** A Claude Code transcript of `n` requests a second apart from `at`, crossing an hour. */
function transcript(path: string, at: number, n: number): void {
  const prompt = JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'go' } }) + '\n'
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'assistant', requestId: `r${i}`, timestamp: new Date(at + (i + 1) * 1000).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 + (i % 7), cache_read_input_tokens: 100, cache_creation_input_tokens: i % 3, output_tokens: 50 + (i % 11) } } }) + '\n')
  writeFileSync(path, prompt + lines.join(''))
}

type Timelines = (StoredSession & { timeline: UsageTimeline | null; summary: UsageSummary; firstActivity: string | null; lastActivity: string | null })[]

async function setup(advanced: Record<string, unknown> = {}) {
  const dir = tempDir('cw-usage-rollup-')
  const file = join(dir, '.combwork', 'usage.db')
  await call({ type: 'config', advanced, providers: DEFAULT_SETTINGS.providers, appVersion: '9.9.9-test' })
  const session = async (name: string, at: number, n: number): Promise<void> => {
    const path = join(dir, `${name}.jsonl`)
    transcript(path, at, n)
    const job: IngestJob = { scope: 'p1', session: name, provider: 'claude-code', agentId: 'a1', path, holds: [], holdsKey: null, keepState: 'no' }
    expect(((await call({ type: 'ingest', file, job })) as IngestResult).status).toBe('written')
  }
  const timelines = async (): Promise<Timelines> => (await call({ type: 'timelines', file, scope: 'p1' })) as Timelines
  const timeline = async (name: string): Promise<UsageTimeline> => (await timelines()).find((s) => s.session === name)!.timeline!
  const rows = async (name: string) => ((await call({ type: 'sessions', file, scopes: ['p1'] })) as StoredSession[]).find((s) => s.session === name)!.rows
  /** Every batch until none is left, as main sends them. */
  const rollUp = async (live: string[] = [], now?: number): Promise<RollUpResult & { batches: number[] }> => {
    const total = { tried: 0, sessions: 0, rows: 0, merged: 0, more: false, batches: [] as number[] }
    for (;;) {
      const r = (await call({ type: 'rollUp', file, live, ...(now ? { now } : {}) })) as RollUpResult
      total.tried += r.tried
      total.sessions += r.sessions
      total.rows += r.rows
      total.merged += r.merged
      total.batches.push(r.sessions)
      if (!r.more || !r.tried) return total
    }
  }
  return { dir, file, session, timelines, timeline, rows, rollUp, close: () => call({ type: 'close', file }) }
}

/** A timeline's tokens and requests, added up by model and flags. */
const sums = (t: UsageTimeline): Record<string, number[]> => {
  const out: Record<string, number[]> = {}
  for (const r of t.rows) {
    const k = `${r[8] ?? -1}|${r[7]}`
    const s = (out[k] ??= [0, 0, 0, 0, 0])
    for (let i = 1; i <= 5; i++) s[i - 1] += r[i] ?? 0
  }
  return out
}
const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

describe("an ended session's timeline in 1-hour steps (HI-1648)", () => {
  it('keeps its tokens, requests and charges, each model and flag apart, every row on an hour', () => {
    let seed = 1648
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
    for (let k = 0; k < 20; k++) {
      const start = 1_790_000_000 + rand(3600)
      const reports = Array.from({ length: 1 + rand(30) }, () => rand(1000) / 100)
      const rows: UsageRow[] = Array.from({ length: 50 + rand(400) }, (_, i) => {
        const r: UsageRow = [start + i * (1 + rand(60)), rand(500), rand(500), rand(50), rand(5000), 1 + rand(2), rand(4) ? rand(reports.length) : -1, rand(5) ? 0 : 1]
        if (rand(3) === 0) r[8] = rand(2)
        return r
      })
      // Each charge covers some row (as a timeline's always do: boundTimeline keeps only those).
      reports.forEach((_, i) => (rows[i % rows.length][6] = i))
      const t: UsageTimeline = { step: 1, rows, reports, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }
      const c = coarsenTimeline(t)
      expect(c.step).toBe(COARSE_STEP)
      expect(c.rows.every((r) => r[0] % COARSE_STEP === 0)).toBe(true)
      expect(c.rows.length).toBeLessThan(t.rows.length)
      expect(sums(c)).toEqual(sums(t))
      expect(total(c.reports)).toBeCloseTo(total(t.reports), 9)
      // What a lane's or card's share takes from the charges: all of them, still.
      expect(total(chargeShares(c, () => null))).toBeCloseTo(total(chargeShares(t, () => null)), 9)
      expect(c.models).toEqual(t.models)
    }
    // One already that coarse is left as it is.
    const hourly: UsageTimeline = { step: 3600, rows: [[3600, 1, 2, 3, 4, 1, -1, 0]], reports: [] }
    expect(coarsenTimeline(hourly)).toBe(hourly)
  })

  it('merges a session last active past the days of full detail, leaves a recent one and a running one, keeps what every reader adds up', async () => {
    const t = await setup()
    const now = Date.now()
    await t.session('old', now - 30 * DAY, 3000)
    await t.session('running', now - 20 * DAY, 200)
    await t.session('recent', now - 2 * DAY, 300)
    const before = await t.timelines()
    const was = (name: string) => before.find((s) => s.session === name)!
    const oldRows = await t.rows('old')
    expect(was('old').timeline!.step).toBe(1)
    expect(was('old').timeline!.rows.length).toBe(3000)

    const r = await t.rollUp(['running'])
    expect(r).toMatchObject({ sessions: 1, rows: 3000 })
    expect(r.merged).toBeLessThanOrEqual(2)
    const old = await t.timeline('old')
    expect(old.step).toBe(COARSE_STEP)
    expect(old.rows.length).toBe(r.merged)
    expect(sums(old)).toEqual(sums(was('old').timeline!))
    // The running one and the recent one as they were.
    expect(await t.timeline('running')).toEqual(was('running').timeline)
    expect(await t.timeline('recent')).toEqual(was('recent').timeline)
    // The rows every usage view, card cost, Performance and the Overview add up: untouched.
    expect(await t.rows('old')).toEqual(oldRows)

    // A lane whose span covers the session costs it the same.
    const lane = (tl: UsageTimeline, s: (typeof before)[number]) => sliceSession({ usage: usageFromRows(s.summary, [], DEFAULT_SETTINGS), timeline: tl, from: Date.parse(s.firstActivity!), to: Date.parse(s.lastActivity!) }, [[now - 31 * DAY, now]], DEFAULT_SETTINGS)
    const a = lane(was('old').timeline!, was('old'))!
    const b = lane(old, was('old'))!
    expect([b.inputTokens, b.outputTokens, b.cacheWriteTokens, b.cacheReadTokens, b.requests]).toEqual([a.inputTokens, a.outputTokens, a.cacheWriteTokens, a.cacheReadTokens, a.requests])
    expect(b.cost).toBeCloseTo(a.cost, 9)

    // Its cards shared out again from the merged timeline: the same totals. A hold over its whole hours has all of it on
    // the card (one that began or ended inside an hour would have that hour's share: the blur Darren accepted).
    const hour = COARSE_STEP * 1000
    const from = Math.floor(Date.parse(was('old').firstActivity!) / hour) * hour
    const to = Math.ceil(Date.parse(was('old').lastActivity!) / hour) * hour
    const holds: SessionHold[] = [{ card: 7, role: 'build', parts: [[1, [[from, to]]]] }]
    await call({ type: 'attribute', file: t.file, scope: 'p1', sessions: [{ session: 'old', holds, holdsKey: 'k1' }] })
    const shared = await t.rows('old')
    const add = (rs: typeof shared, f: (x: (typeof shared)[number]) => number) => rs.reduce((n, x) => n + f(x), 0)
    for (const f of [(x: (typeof shared)[number]) => x.inputTokens, (x: (typeof shared)[number]) => x.outputTokens, (x: (typeof shared)[number]) => x.cacheReadTokens, (x: (typeof shared)[number]) => x.requests]) expect(add(shared, f)).toBe(add(oldRows, f))
    expect(add(shared.filter((x) => x.card === 7), (x) => x.outputTokens)).toBe(add(oldRows, (x) => x.outputTokens))

    // Nothing left to merge: a second roll-up does nothing.
    expect(await t.rollUp(['running'])).toMatchObject({ sessions: 0 })
    await t.close()
  })

  it('merges one session a batch at least, whatever the lookup took: a batch that used its time up never reads as the end (review round 1)', async () => {
    const t = await setup()
    const now = Date.now()
    for (const name of ['one', 'two', 'three']) await t.session(name, now - 30 * DAY, 50)
    // A clock that has gone 60 ms on at each look: the batch's time is used up before its first session.
    let clock = now
    const slow = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 60))
    try {
      const r = await t.rollUp([], now)
      // Each batch one, the last finding no more after it.
      expect(r.batches).toEqual([1, 1, 1])
      expect(r.sessions).toBe(3)
    } finally {
      slow.mockRestore()
    }
    for (const name of ['one', 'two', 'three']) expect((await t.timeline(name)).step).toBe(COARSE_STEP)
    await t.close()
  })

  it('keeps full detail for as many days as Settings → Advanced says', async () => {
    const t = await setup({ [USAGE_TIMELINE_DETAIL_DAYS]: 60 })
    await t.session('month', Date.now() - 30 * DAY, 100)
    expect(await t.rollUp()).toMatchObject({ sessions: 0 })
    expect((await t.timeline('month')).step).toBe(1)
    await call({ type: 'config', advanced: { [USAGE_TIMELINE_DETAIL_DAYS]: 20 }, providers: DEFAULT_SETTINGS.providers, appVersion: '9.9.9-test' })
    expect(await t.rollUp()).toMatchObject({ sessions: 1 })
    expect((await t.timeline('month')).step).toBe(COARSE_STEP)
    await call({ type: 'config', advanced: {}, providers: DEFAULT_SETTINGS.providers, appVersion: '9.9.9-test' })
    await t.close()
  })

  it('gives the space back: a file from before is vacuumed whole once, and after that its free pages go', async () => {
    const t = await setup()
    const now = Date.now()
    await t.session('a', now - 40 * DAY, 6000)
    // As a file made before HI-1648 is: auto_vacuum off.
    const mode = () => {
      const db = new DatabaseSync(t.file, { readOnly: true })
      try {
        return (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum
      } finally {
        db.close()
      }
    }
    expect(mode()).toBe(0)
    await t.rollUp()
    const first = (await call({ type: 'spaceBack', file: t.file })) as { before: number; after: number; whole: boolean }
    expect(first.whole).toBe(true)
    expect(first.after).toBeLessThan(first.before)
    expect(mode()).toBe(2)

    // Incremental from now on: another old session merged, its rows' pages given back, and the file on disk shrinks.
    await t.session('b', now - 40 * DAY, 6000)
    await t.rollUp()
    // The file as it is with the pages the roll-up freed, its WAL written into it (by a connection of the test's own).
    const db = new DatabaseSync(t.file)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count).toBeGreaterThan(0)
    db.close()
    const size = statSync(t.file).size
    const next = (await call({ type: 'spaceBack', file: t.file })) as { before: number; after: number; whole: boolean }
    expect(next.whole).toBe(false)
    expect(next.after).toBeLessThan(next.before)
    expect(statSync(t.file).size).toBeLessThan(size)
    // Its sessions read as they were merged.
    expect((await t.timeline('a')).step).toBe(COARSE_STEP)
    expect((await t.timeline('b')).step).toBe(COARSE_STEP)
    await t.close()
  })
})
