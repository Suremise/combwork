// HI-2628: the performance history's size cap is the database's, not the old metrics.json's. A workspace as busy as
// HIVE's keeps its 30 days (hours for 7, then days); over the cap the oldest hours are folded into their days before any
// day goes; every trim is logged, and reports say what it did (coverage.foldedThrough, coverage.evictedThrough).
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { metricsSaved } from './storeDocs'

const lines: string[] = []
vi.mock('../src/main/logger', async (original) => {
  const real = await original<typeof import('../src/main/logger')>()
  return {
    ...real,
    createLogger: (scope: string) => {
      const log = real.createLogger(scope)
      return scope === 'metrics' ? { ...log, warn: (m: string, e?: unknown) => (lines.push(m), log.warn(m, e)) } : log
    }
  }
})

const base = tempDir('cw-metrics-trim-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const metrics = await import('../src/main/metrics')
const { closeAllBoards } = await import('../src/main/boardStore')
const { CW_TOOLS } = await import('../src/shared/assistantTools')
afterAll(() => {
  closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-01T10:30:00Z')
let now = T0
metrics.clock.now = () => now
const ROUTES = Array.from({ length: 12 }, (_, i) => `/v1/route${i}/:n`)
for (const r of ROUTES) metrics.knownRoute(r)
const saved = { ...metrics.METRICS_LIMITS }
afterEach(() => {
  now = T0
  lines.length = 0
  Object.assign(metrics.METRICS_LIMITS, saved)
})

let n = 0
async function open() {
  const path = join(base, `ws-${++n}`)
  mkdirSync(path, { recursive: true })
  const w = createWorkspaceService()
  await w.open(path)
  return { w, path }
}
type Saved = { start: number; span: 'hour' | 'day' }
const buckets = (path: string) => (metricsSaved(path)!.buckets as Saved[]).sort((a, b) => a.start - b.start)
const savedBytes = (path: string) => Buffer.byteLength(JSON.stringify(metricsSaved(path)), 'utf8')
const api = (route: string) => ({ route, method: 'GET', role: 'agent' as const, outcome: 'ok' as const, requestBytes: 10, responseBytes: 100, ms: 7 })
const requests = (w: ReturnType<typeof createWorkspaceService>, from: number) => {
  const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(from).toISOString() })
  return { count: Object.values(r.projects).flatMap((p) => p.api).reduce((k, s) => k + s.count, 0), coverage: r.coverage }
}

describe('HI-2628: the size cap folds before it drops', () => {
  it('a workspace as busy as HIVE (hundreds of series an hour, 30 days) keeps its 30 days: hours for 7, then days', async () => {
    const { w, path } = await open()
    // HIVE's busiest hours hold about 200 series (6 parts): here every hour has 8 projects x (12 routes + 24 tools x 2 roles).
    const tools = CW_TOOLS.slice(0, 24)
    const start = T0 - 30 * DAY
    for (let h = 0; h < 30 * 24; h++) {
      now = start + h * HOUR
      const handle = metrics.metricsHandle(w)
      for (let p = 0; p < 8; p++) {
        for (const r of ROUTES) metrics.recordApi(handle, `project-${p}`, api(r))
        for (const tool of tools) for (const role of ['agent', 'assistant'] as const) metrics.recordMcp(handle, `project-${p}`, role, { tool, mode: 'compact', ok: true, chars: 100, bytes: 120, ms: 3 })
      }
      // Saved as it goes, a day at a time (a save trims what is over the cap).
      if (h % 24 === 23) await metrics.flushMetrics()
    }
    await metrics.flushMetrics()
    // Heavier than the old 2 MB cap held, well under the database's.
    const size = savedBytes(path)
    if (process.env.MEASURE) {
      const t = performance.now()
      JSON.stringify(metrics.metricsHandle(w)!.store.buckets)
      console.log(`30 busy days: ${(size / 1024 / 1024).toFixed(1)} MB saved; measuring it ${(performance.now() - t).toFixed(0)} ms`)
    }
    expect(size).toBeGreaterThan(saved.fileBytes)
    expect(size).toBeLessThanOrEqual(saved.storeBytes)
    const kept = buckets(path)
    const hours = kept.filter((b) => b.span === 'hour')
    const days = kept.filter((b) => b.span === 'day')
    expect(hours[0].start).toBeGreaterThanOrEqual(now - 7 * DAY - HOUR)
    expect(hours.length).toBeGreaterThanOrEqual(7 * 24 - 1)
    expect(days[0].start).toBeLessThanOrEqual(now - 29 * DAY)
    expect(days.length).toBeGreaterThanOrEqual(22)
    // Nothing trimmed for space: nothing logged, nothing evicted or folded early.
    expect(lines).toEqual([])
    const { count, coverage } = requests(w, now - 29 * DAY)
    expect(count).toBeGreaterThan(0)
    expect([coverage.evictedThrough, coverage.foldedThrough]).toEqual([undefined, undefined])
    await disposeWorkspaceService(w)
  }, 120_000)

  it('a tiny cap folds hours into their days first (logged, reported), and drops the oldest days only past that', async () => {
    const { w, path } = await open()
    const start = T0 - 3 * DAY
    for (let h = 0; h <= 3 * 24; h++) {
      now = start + h * HOUR
      for (const r of ROUTES.slice(0, 4)) metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(r))
    }
    await metrics.flushMetrics()
    const full = savedBytes(path)
    const all = requests(w, start - DAY).count
    expect(all).toBe(4 * (3 * 24 + 1))
    expect(lines).toEqual([])

    // A third of what it holds: hours folded into days, every request still counted.
    metrics.METRICS_LIMITS.storeBytes = Math.floor(full / 3)
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(ROUTES[0]))
    await metrics.flushMetrics()
    expect(savedBytes(path)).toBeLessThanOrEqual(metrics.METRICS_LIMITS.storeBytes)
    let kept = buckets(path)
    expect(kept.some((b) => b.span === 'day')).toBe(true)
    expect(kept.filter((b) => b.span === 'hour').map((b) => b.start)).toContain(Math.floor(now / HOUR) * HOUR)
    let r = requests(w, start - DAY)
    expect(r.count).toBe(all + 1)
    expect(r.coverage.evictedThrough).toBeUndefined()
    expect(r.coverage.foldedThrough).toBeDefined()
    expect(Date.parse(r.coverage.foldedThrough!)).toBeGreaterThan(start)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Performance history over its size limit \(\d+ bytes, limit \d+\): \d+ hours folded into their days \(\S+ to \S+\); \d+ bytes kept$/)

    // Too small for even the days: the oldest days go (evicted, logged), the newest kept.
    lines.length = 0
    const oneDay = Math.max(...kept.filter((b) => b.span === 'day').map((b) => Buffer.byteLength(JSON.stringify(b))))
    metrics.METRICS_LIMITS.storeBytes = 2 * oneDay + 2000
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(ROUTES[0]))
    await metrics.flushMetrics()
    expect(savedBytes(path)).toBeLessThanOrEqual(metrics.METRICS_LIMITS.storeBytes)
    kept = buckets(path)
    expect(kept.at(-1)!.start).toBe(Math.floor(now / HOUR) * HOUR)
    r = requests(w, start - DAY)
    expect(r.count).toBeLessThan(all + 2)
    expect(r.coverage.evictedThrough).toBeDefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/: (\d+ hours folded into their days \(\S+ to \S+\); )?[1-9]\d* days and \d+ hours dropped \(\S+ to \S+\); \d+ bytes kept$/)
    // Kept across a reopen; cleared by a reset.
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect(requests(w, start - DAY).coverage.evictedThrough).toBe(r.coverage.evictedThrough)
    metrics.resetMetrics(w)
    expect([requests(w, start - DAY).coverage.foldedThrough, requests(w, start - DAY).coverage.evictedThrough]).toEqual([undefined, undefined])
    await disposeWorkspaceService(w)
  })

  it('hours folded early are reported until they would have been folded by age anyway, and kept across a reopen', async () => {
    const { w, path } = await open()
    for (let h = 0; h < 30; h++) {
      now = T0 + h * HOUR
      for (const r of ROUTES) metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(r))
    }
    await metrics.flushMetrics()
    metrics.METRICS_LIMITS.storeBytes = Math.floor(savedBytes(path) / 2)
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(ROUTES[0]))
    await metrics.flushMetrics()
    const folded = requests(w, T0 - DAY).coverage.foldedThrough
    expect(folded).toBeDefined()
    Object.assign(metrics.METRICS_LIMITS, saved)
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect(requests(w, T0 - DAY).coverage.foldedThrough).toBe(folded)
    // A range from then on doesn't mention it.
    expect(requests(w, Date.parse(folded!)).coverage.foldedThrough).toBeUndefined()
    // A week on, those hours would be days by now: not said any more.
    now = Date.parse(folded!) + 7 * DAY + HOUR
    expect(requests(w, T0 - DAY).coverage.foldedThrough).toBeUndefined()
    await disposeWorkspaceService(w)
  })
})
