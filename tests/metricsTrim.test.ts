// HI-2628: the performance history's size cap is the database's, not the old metrics.json's. A workspace as busy as
// HIVE's keeps its 30 days (hours for 7, then days); over the cap the oldest buckets go, each trim logged and reported
// (coverage.evictedThrough); and folding a week's hours into a day keeps every total, even when the day's series are
// more than its cap (the rest go into "(other)" overflow series).
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { metricsSaved, putMetrics } from './storeDocs'

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

describe('HI-2628: 30 days kept, trims logged, folds keep their totals', () => {
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
    // Nothing trimmed for space: nothing logged, nothing evicted; every request of the last 29 days still counted.
    expect(lines).toEqual([])
    const { count, coverage } = requests(w, now - 29 * DAY)
    expect(count).toBeGreaterThanOrEqual(8 * ROUTES.length * 29 * 24)
    expect(count).toBeLessThanOrEqual(8 * ROUTES.length * 30 * 24)
    expect(coverage.evictedThrough).toBeUndefined()
    await disposeWorkspaceService(w)
  }, 120_000)

  it('over the cap the oldest buckets go, days before hours: logged, and reported as removed', async () => {
    const { w, path } = await open()
    // 10 days: the oldest 3 are days by now, the rest hours.
    const start = T0 - 10 * DAY
    for (let h = 0; h <= 10 * 24; h++) {
      now = start + h * HOUR
      for (const r of ROUTES.slice(0, 4)) metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(r))
    }
    await metrics.flushMetrics()
    expect(lines).toEqual([])
    const before = buckets(path)
    expect(before.filter((b) => b.span === 'day').length).toBeGreaterThanOrEqual(3)

    metrics.METRICS_LIMITS.storeBytes = Math.floor(savedBytes(path) * 0.8)
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api(ROUTES[0]))
    await metrics.flushMetrics()
    expect(savedBytes(path)).toBeLessThanOrEqual(metrics.METRICS_LIMITS.storeBytes)
    const kept = buckets(path)
    // The oldest went (the days first, as the oldest), the newest stayed.
    expect(kept.filter((b) => b.span === 'day')).toEqual([])
    expect(kept[0].start).toBeGreaterThan(before[0].start)
    expect(kept.at(-1)!.start).toBe(Math.floor(now / HOUR) * HOUR)
    const r = requests(w, start - DAY)
    expect(Date.parse(r.coverage.evictedThrough!)).toBe(kept[0].start)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Performance history over its size limit \(\d+ bytes, limit \d+\): [1-9]\d* days and \d+ hours dropped \(\S+ to \S+\); \d+ bytes kept$/)
    expect(lines[0]).toContain(`(${new Date(before[0].start).toISOString()} to ${new Date(kept[0].start).toISOString()})`)
    // Kept across a reopen; cleared by a reset.
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect(requests(w, start - DAY).coverage.evictedThrough).toBe(r.coverage.evictedThrough)
    metrics.resetMetrics(w)
    expect(requests(w, start - DAY).coverage.evictedThrough).toBeUndefined()
    await disposeWorkspaceService(w)
  })

  it('a week-old day whose hours had more different series than a day holds keeps every total, in "(other)" overflow series', async () => {
    const { w, path } = await open()
    // Two hours of one day, 1,440 series each and none in common: 60 projects x 12 routes x two roles, other roles in the second.
    const day = T0 - 8 * DAY
    const roles = [['agent', 'assistant'], ['api', 'viewer']] as const
    for (const [i, pair] of roles.entries()) {
      now = day + i * HOUR
      for (let p = 0; p < 60; p++) for (const r of ROUTES) for (const role of pair) metrics.recordApi(metrics.metricsHandle(w), `project-${p}`, { ...api(r), role })
    }
    now = T0
    const report = () => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(day - DAY).toISOString(), to: new Date(day + DAY).toISOString() })
    const total = (r: ReturnType<typeof report>) => Object.values(r.projects).flatMap((p) => p.api).reduce((k, s) => k + s.count, 0)
    let r = report()
    // Folded into its day (a week old), over the day's series cap: nothing dropped, the rest under "(other)".
    expect([total(r), r.dropped]).toEqual([2 * 1440, 0])
    const other = Object.values(r.projects).flatMap((p) => p.api).filter((s) => s.route === '(other)')
    expect(other.length).toBeGreaterThan(0)
    expect(other.every((s) => s.method === '(other)' && (s.role === 'api' || s.role === 'viewer'))).toBe(true)
    // Saved and read back the same: the overflow series are read past the cap too.
    await w.close()
    await metrics.flushMetrics()
    expect(buckets(path).map((b) => b.span)).toEqual(['day'])
    await w.open(path)
    r = report()
    expect([total(r), r.dropped]).toEqual([2 * 1440, 0])
    await disposeWorkspaceService(w)
  })
  it('only the exact overflow keys are free of the series cap: unknown-provider guidance with many dialects is capped, recorded or read back', async () => {
    const { w, path } = await open()
    const launch = { provider: 'unrecognised-provider', role: 'agent' as const, workflow: 'builder' as const, guidanceBytes: 1, guidanceChars: 1, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 }
    // "(other) agent builder <dialect>": provider "(other)", but not an overflow key (those have no dialect).
    for (let i = 0; i < 2050; i++) metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', { ...launch, dialect: i.toString(16).padStart(16, '0') })
    const kept = () => {
      const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
      return { series: Object.values(r.projects).reduce((k, p) => k + p.guidance.length, 0), dropped: r.dropped }
    }
    expect(kept()).toEqual({ series: saved.series, dropped: 50 })
    expect(metrics.metricsHandle(w)!.store.buckets[0].series).toBe(saved.series)
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect(kept()).toEqual({ series: saved.series, dropped: 50 })
    // Saved data with more of them than the cap (written by something else): read back capped too.
    const doc = metricsSaved(path)!
    const extra = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`(other) agent builder ${(10_000 + i).toString(16).padStart(16, '0')}`, { ...launch, provider: '(other)', dialect: (10_000 + i).toString(16).padStart(16, '0'), launches: 1 }]))
    ;(doc.buckets[0] as { projects: Record<string, { guidance: Record<string, unknown> }> }).projects.alpha.guidance = { ...(doc.buckets[0] as { projects: Record<string, { guidance: Record<string, unknown> }> }).projects.alpha.guidance, ...extra }
    await w.close()
    await metrics.flushMetrics()
    await putMetrics(path, doc as never)
    await w.open(path)
    expect(kept().series).toBe(saved.series)
    await disposeWorkspaceService(w)
  })
})
