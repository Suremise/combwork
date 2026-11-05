// Combwork's performance metrics (src/main/metrics.ts): exact units, hourly buckets on a fake clock (folded into days after
// a week, gone after 30 days), per-workspace stores that never mix, project parts that add up to the workspace's totals
// with the workspace's own work kept apart, caps that drop and count rather than grow, malformed bridge reports refused,
// recording off, what is saved (in the workspace database, #1019: moved in from metrics.json once, its totals unchanged;
// size-capped, reset; read as untrusted input), work started in a workspace
// that has since closed or switched (dropped, never moved), retention applied however long Combwork was idle and whichever
// way the clock moved, the launch's skill sizes measured on the copies delivered, and what recording costs. MEASURE=1 prints the overhead numbers (docs/ARCHITECTURE.md records them).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { LATENCY_BOUNDS_MS, percentile, utf8Bytes, type MetricsPart } from '../src/shared/metrics'
import { tempDir } from './tempDir'
import { metricsSaved, putMetrics } from './storeDocs'

const base = tempDir('hive-metrics-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const metrics = await import('../src/main/metrics')
const { tableTestHooks: storeTestHooks } = await import('../src/main/storeTables')
const { closeAllBoards } = await import('../src/main/boardStore')
afterAll(() => {
  closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})
const { config } = await import('../src/main/config')
type WS = ReturnType<typeof createWorkspaceService>

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-10-01T10:30:00Z')
let now = T0
metrics.clock.now = () => now
metrics.knownRoute('/v1/tasks')
metrics.knownRoute('/v1/tasks/:n')
afterEach(() => {
  now = T0
  config.settings.sessions.recordPerformance = true
})

let n = 0
async function open(): Promise<{ w: WS; path: string }> {
  const path = join(base, `ws-${++n}`)
  mkdirSync(path, { recursive: true })
  const w = createWorkspaceService()
  await w.open(path)
  return { w, path }
}

const api = (route = '/v1/tasks', extra: Partial<Parameters<typeof metrics.recordApi>[2]> = {}) => ({ route, method: 'GET', role: 'agent' as const, outcome: 'ok' as const, requestBytes: 10, responseBytes: 100, ms: 7, ...extra })
/** What is saved, as metrics.json's text was (what the size cap measures). */
const savedText = (path: string) => JSON.stringify(metricsSaved(path))
const savedBytes = (path: string) => Buffer.byteLength(savedText(path), 'utf8')
const sumApi = (parts: MetricsPart[]) => parts.flatMap((p) => p.api).reduce((a, s) => ({ count: a.count + s.count, bytes: a.bytes + s.responseBytes }), { count: 0, bytes: 0 })

describe('units', () => {
  it('UTF-8 bytes match what Node encodes, for ASCII, accents, CJK, emoji and a lone surrogate', () => {
    for (const s of ['plain', 'Ünïcödé', '日本語', '🐝 hive', 'a\uD800b', JSON.stringify({ q: 'quote " and \\ and \n' })]) expect(utf8Bytes(s), s).toBe(Buffer.byteLength(s, 'utf8'))
  })

  it('latency histogram: each time in its bucket, and percentiles from them', async () => {
    const { w } = await open()
    for (const ms of [0.5, 3, 40, 40, 900, 20000]) metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { ms }))
    const s = metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).workspace!.api[0]
    expect([s.count, s.maxMs]).toEqual([6, 20000])
    expect(s.histogram.length).toBe(LATENCY_BOUNDS_MS.length + 1)
    expect(s.histogram.at(-1)).toBe(1)
    expect(percentile(s, 0.5)).toBe(50)
    expect(percentile(s, 1)).toBeNull()
    await disposeWorkspaceService(w)
  })
})

describe('waits (HI-1831)', () => {
  it("an isolated check's resolve answered with a wait is recorded as waiting: counted, never a failure", async () => {
    const { byRoute, totals } = await import('../src/shared/metricsView')
    metrics.knownRoute('/v1/progress/resolve')
    // How servers.ts tells them: resolve's 409 with `wait` is a wait; a 409 without one, a client error.
    expect(metrics.apiOutcome({ finished: true, status: 409, waiting: true })).toBe('waiting')
    expect(metrics.apiOutcome({ finished: true, status: 409, waiting: false })).toBe('client-error')
    expect(metrics.apiOutcome({ finished: false, status: 409, waiting: true })).toBe('cancelled')
    expect(metrics.apiOutcome({ finished: true, status: 200, waiting: false })).toBe('ok')
    const { w } = await open()
    const resolve = (outcome: 'ok' | 'waiting' | 'client-error') => metrics.recordApi(metrics.metricsHandle(w), 'alpha', api('/v1/progress/resolve', { method: 'POST', outcome }))
    for (let i = 0; i < 5; i++) resolve('waiting')
    resolve('ok')
    resolve('client-error')
    const q = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - HOUR).toISOString(), trend: true })
    const api_ = Object.values(q.projects).flatMap((p) => p.api)
    expect(api_.find((s) => s.outcome === 'waiting')?.count).toBe(5)
    const t = totals({ api: api_, mcp: [], guidance: [], catalog: [], providers: [], safeguards: [] })
    expect([t.requests, t.waits, t.failed, t.errors]).toEqual([7, 5, 1, 1])
    expect(byRoute(api_)).toMatchObject([{ key: 'POST /v1/progress/resolve', requests: 7, waits: 5, failed: 1 }])
    const hour = q.trend!.find((p) => p.requests > 0)!
    expect([hour.requests, hour.waits, hour.failed]).toEqual([7, 5, 1])
    await disposeWorkspaceService(w)
  })
})

describe('time', () => {
  it('hourly buckets; folded into days after a week; gone after 30 days; a range picks what overlaps it', async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    now = T0 + 2 * HOUR
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    const day = (from: number, to: number) => sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(from).toISOString(), to: new Date(to).toISOString() }).projects))
    expect(day(T0 - HOUR, T0 + HOUR).count).toBe(1)
    expect(day(T0 - HOUR, T0 + 3 * HOUR).count).toBe(2)
    // Eight days on: the hours are one day bucket, still counted.
    now = T0 + 8 * DAY
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    expect(day(T0 - DAY, T0 + DAY).count).toBe(2)
    // 31 days on: gone.
    now = T0 + 31 * DAY
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    expect(day(T0 - DAY, T0 + 9 * DAY).count).toBe(1)
    await disposeWorkspaceService(w)
  })

  it('a clock set back lands in the earlier hour; a bad range is refused', async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    now = T0 - 3 * HOUR
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    now = T0
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 4 * HOUR).toISOString() }).workspace!.api[0].count).toBe(2)
    expect(() => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: 'yesterday' })).toThrow(/ISO times/)
    await disposeWorkspaceService(w)
  })
})

describe('scope', () => {
  it("each workspace has its own; a project scope has only that project's; the parts add up to the totals once", async () => {
    const a = await open()
    const b = await open()
    // A known workload: alpha 3 calls, beta 2, the workspace's own (Assistant, scripts) 4; B has 1 of its own.
    for (let i = 0; i < 3; i++) metrics.recordApi(metrics.metricsHandle(a.w), 'alpha', api())
    for (let i = 0; i < 2; i++) metrics.recordApi(metrics.metricsHandle(a.w), 'beta', api('/v1/tasks/:n'))
    for (let i = 0; i < 4; i++) metrics.recordApi(metrics.metricsHandle(a.w), null, api('/v1/tasks', { role: 'assistant' }))
    metrics.recordMcp(metrics.metricsHandle(a.w), 'alpha', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 50, bytes: 60, ms: 3 })
    metrics.recordApi(metrics.metricsHandle(b.w), 'alpha', api())

    const whole = metrics.queryMetrics(a.w, { scope: { kind: 'workspace' } })
    expect(Object.keys(whole.projects).sort()).toEqual(['alpha', 'beta'])
    const parts = [...Object.values(whole.projects), whole.workspace!]
    expect(sumApi(parts).count).toBe(9)
    expect(sumApi(Object.values(whole.projects)).count + sumApi([whole.workspace!]).count).toBe(9)
    expect(whole.workspace!.api.every((s) => s.role === 'assistant')).toBe(true)

    const alpha = metrics.queryMetrics(a.w, { scope: { kind: 'project', project: 'alpha' } })
    expect(Object.keys(alpha.projects)).toEqual(['alpha'])
    expect(alpha.workspace).toBeUndefined()
    expect(alpha.skills).toBeUndefined()
    expect(sumApi(Object.values(alpha.projects)).count).toBe(3)
    expect(alpha.projects.alpha.mcp[0]).toMatchObject({ tool: 'cw_list_tasks', chars: 50, bytes: 60, count: 1 })
    // B saw nothing of A's.
    expect(sumApi(Object.values(metrics.queryMetrics(b.w, { scope: { kind: 'workspace' } }).projects)).count).toBe(1)
    // An unknown project: an empty part, not another's.
    expect(sumApi(Object.values(metrics.queryMetrics(a.w, { scope: { kind: 'project', project: 'gamma' } }).projects)).count).toBe(0)
    await disposeWorkspaceService(a.w)
    await disposeWorkspaceService(b.w)
  })
})

describe('projects renamed (#514)', () => {
  it("each one's measurements under its old name are its own under the new one, all at once (a swap keeps each one's), once", async () => {
    const { w } = await open()
    for (let i = 0; i < 3; i++) metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordApi(metrics.metricsHandle(w), 'beta', api('/v1/tasks/:n'))
    metrics.recordApi(metrics.metricsHandle(w), 'gamma', api())
    // alpha and beta swapped names; gamma is untouched.
    expect(metrics.applyMetricsRenames(metrics.metricsHandle(w), [{ from: 'alpha', to: 'beta' }, { from: 'beta', to: 'alpha' }], 2)).toBe(true)
    const count = (p: string) => sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: p } }).projects)).count
    expect([count('beta'), count('alpha'), count('gamma')]).toEqual([3, 1, 1])
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.api.map((s) => s.route)).toEqual(['/v1/tasks/:n'])
    // The same batch again, or an older one: nothing changes.
    expect(metrics.applyMetricsRenames(metrics.metricsHandle(w), [{ from: 'alpha', to: 'beta' }, { from: 'beta', to: 'alpha' }], 2)).toBe(false)
    expect(metrics.applyMetricsRenames(metrics.metricsHandle(w), [{ from: 'gamma', to: 'beta' }], 1)).toBe(false)
    expect([count('beta'), count('alpha'), count('gamma')]).toEqual([3, 1, 1])
    // A later one merges into what the new name has.
    expect(metrics.applyMetricsRenames(metrics.metricsHandle(w), [{ from: 'gamma', to: 'beta' }], 3)).toBe(true)
    expect([count('beta'), count('gamma')]).toEqual([4, 0])
    await disposeWorkspaceService(w)
  })
})

describe('bounds', () => {
  it('labels only from known sets; caps on series and projects drop and count, never grow', async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/secret/../path?token=abc'))
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).workspace!.api[0].route).toBe('(other)')
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.projects = 3
      metrics.METRICS_LIMITS.series = 5
      for (let i = 0; i < 6; i++) metrics.recordApi(metrics.metricsHandle(w), `p${i}`, api())
      const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
      expect(Object.keys(r.projects).length).toBe(3)
      expect(r.dropped).toBeGreaterThan(0)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
    }
    await disposeWorkspaceService(w)
  })

  it('a malformed bridge report is refused, not stored; an unknown tool name is "(other)"', async () => {
    const { w } = await open()
    const ok = { tool: 'cw_read_task', mode: 'compact', ok: true, chars: 10, bytes: 10, ms: 1 }
    for (const bad of [{ ...ok, chars: -1 }, { ...ok, bytes: 'many' }, { ...ok, ms: Infinity }, { ...ok, ok: 'yes' }, { ...ok, mode: 'verbose' }, { ...ok, chars: 1e12 }]) {
      expect(metrics.recordMcp(metrics.metricsHandle(w), 'alpha', 'agent', bad as never)).toBe(false)
    }
    expect(metrics.recordMcp(metrics.metricsHandle(w), 'alpha', 'agent', { ...ok, tool: 'rm -rf /' })).toBe(true)
    // Well-formed, but not one of Combwork's tools: not recorded under its name.
    expect(metrics.recordMcp(metrics.metricsHandle(w), 'alpha', 'agent', { ...ok, tool: 'hive_private_secret' })).toBe(true)
    expect(metrics.recordCatalog(metrics.metricsHandle(w), 'alpha', 'agent', 'builder', { tools: 1.5, toolsBytes: 10 })).toBe(false)
    const part = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha
    expect(part.mcp.map((s) => [s.tool, s.count])).toEqual([['(other)', 2]])
    expect(part.catalog).toEqual([])
    await disposeWorkspaceService(w)
  })
})

describe('recording off', () => {
  it('records nothing new, keeps what it had, and says so', async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    config.settings.sessions.recordPerformance = false
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', { provider: 'claude-code', role: 'agent', workflow: 'builder', guidanceBytes: 1, guidanceChars: 1, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 })
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(r.recording).toBe(false)
    expect(sumApi(Object.values(r.projects)).count).toBe(1)
    expect(r.projects.alpha.guidance).toEqual([])
    await disposeWorkspaceService(w)
  })
})

describe('saving', () => {
  it('saved in the workspace database (git-ignored with it), read back when the workspace opens again, and cleared by reset', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', { provider: 'codex', role: 'agent', workflow: 'builder', guidanceBytes: 1234, guidanceChars: 1200, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 7, skillCatalogBytes: 900, skillBytes: 40000, skillsNotDelivered: 1, skillsUnmeasured: 0 })
    await w.close()
    await metrics.flushMetrics()
    expect(metricsSaved(path)).not.toBeNull()
    // No file of their own, nor a .gitignore for one: the database is git-ignored by .combwork's.
    expect(existsSync(join(path, '.combwork', 'metrics', 'metrics.json'))).toBe(false)
    expect(existsSync(join(path, '.combwork', 'metrics', '.gitignore'))).toBe(false)
    expect(readFileSync(join(path, '.combwork', '.gitignore'), 'utf8')).toMatch(/^hive\.db$/m)
    // Only aggregates: no project path, no route asked for.
    expect(savedText(path)).not.toContain(path.replace(/\\/g, '\\\\'))
    await w.open(path)
    const again = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha
    expect(again.api[0].count).toBe(1)
    expect(again.guidance[0]).toMatchObject({ provider: 'codex', launches: 1, guidanceBytes: 1234, skills: 7 })
    metrics.resetMetrics(w)
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.api).toEqual([])
    await metrics.flushMetrics()
    expect(metricsSaved(path)!.buckets).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('what is saved stays under its cap: the oldest buckets go first', async () => {
    const { w, path } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.fileBytes = 20_000
      for (let h = 0; h < 100; h++) {
        now = T0 + h * HOUR
        for (let p = 0; p < 5; p++) metrics.recordApi(metrics.metricsHandle(w), `p${p}`, api())
      }
      await metrics.flushMetrics()
      expect(savedBytes(path)).toBeLessThanOrEqual(20_000)
      const kept = metricsSaved(path)!.buckets as { start: number }[]
      expect(Math.max(...kept.map((b) => b.start))).toBe(T0 + 99 * HOUR - ((T0 + 99 * HOUR) % HOUR))
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
      await disposeWorkspaceService(w)
    }
  })

  it('work that arrives after the workspace closed is not recorded anywhere', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    await w.close()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    await w.open(path)
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.api[0].count).toBe(1)
    await disposeWorkspaceService(w)
  })
})

describe('switching and the skill service', () => {
  it("a window that opens another workspace records into that one's store; the first one's is saved", async () => {
    const { w, path } = await open()
    const other = join(base, `ws-${++n}`)
    mkdirSync(other, { recursive: true })
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    await w.open(other)
    metrics.recordApi(metrics.metricsHandle(w), 'beta', api())
    await metrics.flushMetrics()
    expect(Object.keys(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).projects)).toEqual(['beta'])
    expect(savedText(path)).toContain('"alpha"')
    expect(savedText(path)).not.toContain('"beta"')
    await disposeWorkspaceService(w)
  })

  it("scans, hits, misses and what they read are the workspace's own", async () => {
    const { w, path } = await open()
    const { inWorkspace } = await import('../src/main/workspace')
    const { syncBundled } = await import('../src/main/bundled')
    const { skillRevisions } = await import('../src/main/guidance')
    await inWorkspace(w, () => syncBundled({ fresh: true }))
    await inWorkspace(w, () => skillRevisions())
    await inWorkspace(w, () => skillRevisions())
    // Edited: invalidated, read again.
    const { appendFileSync } = await import('fs')
    appendFileSync(join(path, '.combwork', 'skills', 'handover', 'SKILL.md'), '\nmore\n')
    await inWorkspace(w, () => Promise.all([skillRevisions(), skillRevisions(), skillRevisions()]))
    const s = metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).skills!
    expect(s.scans.count).toBeGreaterThanOrEqual(3)
    expect(s.misses).toBeGreaterThan(0)
    expect(s.hits).toBeGreaterThan(0)
    expect(s.invalidations).toBeGreaterThanOrEqual(1)
    expect(s.sharedScans).toBeGreaterThanOrEqual(1)
    expect(s.files).toBeGreaterThan(0)
    expect(s.headerBytes).toBeGreaterThan(0)
    expect(s.entries).toBeGreaterThan(0)
    await disposeWorkspaceService(w)
  })
})

describe('lifetime', () => {
  it('work started in a workspace that has since switched is dropped, not recorded in the next one', async () => {
    const { w, path } = await open()
    const other = join(base, `ws-${++n}`)
    mkdirSync(other, { recursive: true })
    const started = metrics.metricsHandle(w)
    metrics.recordApi(started, 'alpha', api())
    await w.open(other)
    // The request that began in the first workspace ends now.
    metrics.recordApi(started, 'alpha', api('/v1/tasks', { outcome: 'cancelled' }))
    metrics.recordSkills(started, { hits: 5 })
    expect(Object.keys(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).projects)).toEqual([])
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).skills!.hits).toBe(0)
    await metrics.flushMetrics()
    expect(savedText(path)).not.toContain('cancelled')
    await disposeWorkspaceService(w)
  })

  it("a metrics read that the workspace switches under is refused, not mixed with the next one's sessions", async () => {
    const { w } = await open()
    const other = join(base, `ws-${++n}`)
    mkdirSync(other, { recursive: true })
    const { metricsReport } = await import('../src/main/metricsUsage')
    const reading = metricsReport(w, { scope: { kind: 'workspace' } }).then(
      () => null,
      (e: Error) => e
    )
    await w.open(other)
    expect((await reading)?.message).toMatch(/closed while its metrics were read/)
    await disposeWorkspaceService(w)
  })
})

describe('retention, whatever happens to the clock', () => {
  it('data older than 30 days is gone when read, even if nothing was recorded since (and when loaded)', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    await metrics.flushMetrics()
    now = T0 + 31 * DAY
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - DAY).toISOString() }).projects).toEqual({})
    // Loaded after a long absence: the same.
    now = T0
    await w.close()
    now = T0 + 31 * DAY
    await w.open(path)
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - DAY).toISOString() }).projects).toEqual({})
    await disposeWorkspaceService(w)
  })

  it('a clock going back an hour at a time keeps a bounded number of buckets; a clock that was days ahead leaves nothing more than a day ahead', async () => {
    const { w } = await open()
    for (let i = 0; i < 400; i++) {
      now = T0 - i * HOUR
      metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    }
    await metrics.flushMetrics()
    const store = metrics.metricsHandle(w)!.store
    expect(store.buckets.length).toBeLessThanOrEqual(metrics.METRICS_LIMITS.buckets)
    // Corrected back to T0 after running 3 days ahead: the "future" buckets go.
    now = T0 + 3 * DAY
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    now = T0
    metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(store.buckets.every((b) => b.start < T0 + DAY)).toBe(true)
    await disposeWorkspaceService(w)
  })
})

describe('the saved file is untrusted', () => {
  const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR
  const fileOf = (path: string) => join(path, '.combwork', 'metrics', 'metrics.json')
  const write = (path: string, data: unknown) => {
    mkdirSync(join(path, '.combwork', 'metrics'), { recursive: true })
    writeFileSync(fileOf(path), typeof data === 'string' ? data : JSON.stringify(data))
  }
  const histogram = Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, () => 0)

  it('a damaged or hand-made file leaves metrics working: bad buckets and series are skipped, labels re-checked', async () => {
    const { w, path } = await open()
    await w.close()
    const good = { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', count: 2, totalMs: 4, maxMs: 3, histogram: [...histogram.slice(0, -1), 2], requestBytes: 1, responseBytes: 2 }
    write(path, {
      version: 1,
      buckets: [
        { start: hourOf(T0), span: 'hour' },
        { start: 'yesterday', span: 'hour' },
        null,
        {
          start: hourOf(T0) - HOUR,
          span: 'hour',
          projects: {
            alpha: {
              api: { a: good, b: { ...good, count: -1 }, c: { ...good, histogram: [1] }, d: { ...good, role: 'root' } },
              mcp: { x: { tool: 'hive_private_secret', role: 'agent', mode: 'compact', outcome: 'ok', count: 1, totalMs: 1, maxMs: 1, histogram, chars: 5, bytes: 5 } }
            },
            '../escape': { api: { a: good } }
          },
          skills: { scans: { count: 'many' } }
        }
      ]
    })
    await w.open(path)
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    expect(Object.keys(r.projects)).toEqual(['alpha'])
    expect(r.projects.alpha.api.map((s) => s.count)).toEqual([2])
    expect(r.projects.alpha.mcp.map((s) => s.tool)).toEqual(['(other)'])
    expect(r.skills!.scans.count).toBe(0)
    await disposeWorkspaceService(w)
  })

  it('a tool saved before HI-2463 (hive_<tool>) is read as cw_<tool>, merged with its new series and counted once', async () => {
    const { w, path } = await open()
    await w.close()
    const series = (tool: string, count: number) => ({ tool, role: 'agent', mode: 'compact', outcome: 'ok', count, totalMs: count, maxMs: 1, histogram: [count, ...histogram.slice(1)], chars: 10 * count, bytes: 10 * count })
    write(path, { version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { mcp: { a: series('hive_list_tasks', 2), b: series('cw_list_tasks', 3), c: series('hive_inbox', 1) } } } }] })
    await w.open(path)
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    const mcp = r.projects.alpha.mcp.map((s) => ({ tool: s.tool, count: s.count, chars: s.chars })).sort((a, b) => a.tool.localeCompare(b.tool))
    expect(mcp).toEqual([{ tool: 'cw_inbox', count: 1, chars: 10 }, { tool: 'cw_list_tasks', count: 5, chars: 50 }])
    // Read again (a second load), still once: the projection reads what is stored, it never adds to it.
    await w.close()
    await w.open(path)
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() }).projects.alpha.mcp.find((s) => s.tool === 'cw_list_tasks')!.count).toBe(5)
    await disposeWorkspaceService(w)
  })

  it("a launch saved before 0.9.3 counts its persona's size as its mode's (#1084)", async () => {
    const { w, path } = await open()
    await w.close()
    const guidance = { provider: 'claude-code', role: 'assistant', launches: 1, guidanceBytes: 100, guidanceChars: 100, customBytes: 0, customChars: 0, roleBytes: 40, roleChars: 40, personaBytes: 70, personaChars: 60, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 }
    write(path, { version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', workspace: { guidance: { g: guidance } } }] })
    await w.open(path)
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    expect(r.workspace!.guidance).toMatchObject([{ role: 'assistant', modeBytes: 70, modeChars: 60 }])
    expect(r.workspace!.guidance[0]).not.toHaveProperty('personaBytes')
    await disposeWorkspaceService(w)
  })

  it('HI-2443: a saved launch series keeps its dialect chain; one that is not a hash counts as the Default', async () => {
    const { w, path } = await open()
    await w.close()
    const g = { provider: 'codex', role: 'agent', workflow: 'builder', launches: 1, guidanceBytes: 100, guidanceChars: 100, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 }
    write(path, { version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', workspace: { guidance: { a: { ...g, dialect: 'abcdef0123456789' }, b: { ...g, dialect: '../x' }, c: g } } }] })
    await w.open(path)
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    expect(r.workspace!.guidance.map((s) => [s.dialect ?? null, s.launches]).sort()).toEqual([[null, 2], ['abcdef0123456789', 1]])
    await disposeWorkspaceService(w)
  })

  it('/v1/metrics also gives each guidance series its persona names of before 0.9.3, in 0.9.3 (#1084)', async () => {
    const { withPersonaAliases } = await import('../src/main/servers')
    const g = { provider: 'claude-code', role: 'assistant' as const, launches: 1, guidanceBytes: 100, guidanceChars: 100, customBytes: 0, customChars: 0, roleBytes: 40, roleChars: 40, modeBytes: 70, modeChars: 60, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 }
    const part = { api: [], mcp: [], guidance: [g], catalog: [] }
    const r = withPersonaAliases({ projects: { alpha: part }, workspace: part } as unknown as Parameters<typeof withPersonaAliases>[0])
    for (const p of [r.projects.alpha, r.workspace!]) expect(p.guidance[0]).toMatchObject({ modeBytes: 70, modeChars: 60, personaBytes: 70, personaChars: 60 })
  })

  it('a file over the size cap is not read at all; one that is not JSON is ignored', async () => {
    // Each found at a workspace's first metrics load (the move in, #1019): one found after it isn't read at all.
    const { w, path } = await open()
    await w.close()
    write(path, ' '.repeat(metrics.METRICS_LIMITS.fileBytes + 1))
    await w.open(path)
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).projects).toEqual({})
    await disposeWorkspaceService(w)
    const other = await open()
    await other.w.close()
    write(other.path, '{"version":1,"buckets":[')
    await other.w.open(other.path)
    expect(metrics.queryMetrics(other.w, { scope: { kind: 'workspace' } }).projects).toEqual({})
    await disposeWorkspaceService(other.w)
  })
})

describe('moved into the workspace database (#1019)', () => {
  const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR
  const dirOf = (path: string) => join(path, '.combwork', 'metrics')
  const backups = (path: string) => readdirSync(dirOf(path)).filter((f) => f.startsWith('metrics.json.imported-'))
  /** A workspace folder never opened, with its metrics folder (an older Hive's). */
  const fresh = () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(dirOf(path), { recursive: true })
    return path
  }
  const histogram = (count: number) => Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, (_, i) => (i === LATENCY_BOUNDS_MS.length ? count : 0))
  const whole = (w: WS) => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 30 * DAY).toISOString(), trend: true })

  it("a metrics.json that can't be read at the first open is not moved, marked or saved over: the next open moves it in, its numbers whole (#1019 round 1)", async () => {
    const path = fresh()
    const series = { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', count: 2, totalMs: 6, maxMs: 4, histogram: histogram(2), requestBytes: 20, responseBytes: 200 }
    const text = JSON.stringify({ version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { api: { 'GET /v1/tasks agent ok': series } } } }], observed: [[T0 - 2 * HOUR, T0 - HOUR]] })
    const file = join(dirOf(path), 'metrics.json')
    // A folder where the file is: reading it fails as a file Windows holds open would, not as "there is none".
    mkdirSync(file)
    const w = createWorkspaceService()
    await w.open(path)
    metrics.recordApi(metrics.metricsHandle(w), 'beta', { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 2, ms: 3 })
    await w.close()
    await metrics.flushMetrics()
    expect(metricsSaved(path)).toBeNull()
    expect(backups(path)).toEqual([])
    // Readable again: moved in at the next open, with what it held.
    rmSync(file, { recursive: true })
    writeFileSync(file, text)
    await w.open(path)
    expect(whole(w).projects.alpha.api[0].count).toBe(2)
    await metrics.flushMetrics()
    expect(metricsSaved(path)?.buckets).toHaveLength(1)
    expect(backups(path).map((f) => readFileSync(join(dirOf(path), f), 'utf8'))).toEqual([text])
    await disposeWorkspaceService(w)
  })

  it('a metrics.json too big or not JSON at the first open is set aside as it was, and the metrics start again', async () => {
    for (const [why, text] of [['too-big', ' '.repeat(metrics.METRICS_LIMITS.fileBytes + 1)], ['damaged', '{"version":1,"buckets":[']] as const) {
      const path = fresh()
      writeFileSync(join(dirOf(path), 'metrics.json'), text)
      const w = createWorkspaceService()
      await w.open(path)
      expect(whole(w).projects).toEqual({})
      await metrics.flushMetrics()
      const aside = readdirSync(dirOf(path)).filter((f) => f.startsWith(`metrics.json.${why}-`))
      expect(aside.map((f) => readFileSync(join(dirOf(path), f), 'utf8'))).toEqual([text])
      expect(metricsSaved(path)?.buckets).toEqual([])
      await disposeWorkspaceService(w)
    }
  })

  it("metrics whose saved rows can't be read are never saved over, however much is recorded (a save would replace them with nothing)", async () => {
    const path = fresh()
    const series = { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', count: 3, totalMs: 9, maxMs: 4, histogram: histogram(3), requestBytes: 30, responseBytes: 300 }
    await putMetrics(path, { buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { api: { 'GET /v1/tasks agent ok': series } } } } as never], observed: [[T0 - 2 * HOUR, T0 - HOUR]] })
    const saved = metricsSaved(path)
    storeTestHooks.failRead = (store) => store === 'metrics'
    const w = createWorkspaceService()
    try {
      await w.open(path)
      metrics.recordApi(metrics.metricsHandle(w), 'beta', { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 2, ms: 3 })
      await metrics.flushMetrics()
    } finally {
      storeTestHooks.failRead = null
    }
    expect(metricsSaved(path)).toEqual(saved)
    await disposeWorkspaceService(w)
  })

  it('a metrics.json there at the first open is read, moved in by the first save and kept as a backup, unchanged; one found later is kept, unread', async () => {
    const path = fresh()
    const series = { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', count: 3, totalMs: 9, maxMs: 4, histogram: histogram(3), requestBytes: 30, responseBytes: 300 }
    const text = JSON.stringify({ version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { api: { 'GET /v1/tasks agent ok': series } } } }], observed: [[T0 - 2 * HOUR, T0 - HOUR]], evictedThrough: T0 - 3 * HOUR })
    writeFileSync(join(dirOf(path), 'metrics.json'), text)
    const w = createWorkspaceService()
    await w.open(path)
    const before = whole(w)
    expect([before.projects.alpha.api[0].count, before.coverage.evictedThrough]).toEqual([3, new Date(T0 - 3 * HOUR).toISOString()])
    expect(metricsSaved(path)).toBeNull()
    // The first save moves it in, then keeps the file under its backup name, as it was.
    await metrics.flushMetrics()
    expect(metricsSaved(path)).toMatchObject({ evictedThrough: T0 - 3 * HOUR, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour' }] })
    expect(existsSync(join(dirOf(path), 'metrics.json'))).toBe(false)
    expect(backups(path).map((f) => readFileSync(join(dirOf(path), f), 'utf8'))).toEqual([text])
    expect(whole(w)).toEqual(before)
    await w.close()
    await metrics.flushMetrics()
    // An older Hive's metrics.json written after the move: kept as a backup too, never read.
    const later = JSON.stringify({ version: 1, buckets: [{ start: hourOf(T0), span: 'hour', projects: { beta: { api: { 'GET /v1/tasks agent ok': series } } } }] })
    writeFileSync(join(dirOf(path), 'metrics.json'), later)
    await w.open(path)
    const after = whole(w)
    expect(Object.keys(after.projects)).toEqual(['alpha'])
    expect(after.projects).toEqual(before.projects)
    expect(existsSync(join(dirOf(path), 'metrics.json'))).toBe(false)
    expect(backups(path).map((f) => readFileSync(join(dirOf(path), f), 'utf8')).sort()).toEqual([text, later].sort())
    await disposeWorkspaceService(w)
  })

  it("a migrated workspace's metrics report the same numbers (#1019)", async () => {
    const { metricsReport } = await import('../src/main/metricsUsage')
    // Recorded as Combwork records them, over 13 days (hours for the last week, days before it): projects, the workspace's
    // own work, API, MCP, catalog, guidance and skill-service series, observed in stretches.
    const { w: src, path: srcPath } = await open()
    for (let d = 12; d >= 0; d--) {
      for (const h of [9, 5, 1]) {
        now = T0 - d * DAY - h * HOUR
        const handle = metrics.metricsHandle(src)
        metrics.recordApi(handle, 'alpha', api('/v1/tasks', { ms: d + h }))
        metrics.recordApi(handle, 'beta', api('/v1/tasks/:n', { outcome: d % 3 ? 'ok' : 'server-error', ms: 40 * h, responseBytes: 1000 + d }))
        metrics.recordApi(handle, null, api('/v1/tasks', { role: 'assistant' }))
        metrics.recordMcp(handle, 'alpha', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 50 * h, bytes: 60 * h, ms: 3 })
        metrics.recordMcp(handle, null, 'assistant', { tool: 'cw_read_task', mode: 'detail', ok: d % 2 === 0, chars: 500, bytes: 520, ms: 12 })
        metrics.recordCatalog(handle, 'beta', 'agent', 'builder', { tools: 30, toolsBytes: 9000 + d })
        metrics.recordLaunch(handle, d % 2 ? 'alpha' : 'beta', { provider: d % 2 ? 'codex' : 'claude-code', role: 'agent', workflow: 'builder', guidanceBytes: 1234, guidanceChars: 1200, customBytes: 10 * d, customChars: 10 * d, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 7, skillCatalogBytes: 900, skillBytes: 40000, skillsNotDelivered: d % 2, skillsUnmeasured: 0 })
        metrics.recordSkills(handle, { hits: 2, misses: 1, scanMs: 4, files: 3, bytes: 900 })
      }
    }
    now = T0
    metrics.queryMetrics(src, { scope: { kind: 'workspace' } })
    await metrics.flushMetrics()
    // Its saved form, as metrics.json had it, with everything else it holds: history evicted before it, a project rename
    // applied, and measurements dropped (a project's and untracked owners'), each counted in the reports' losses.
    const saved = metricsSaved(srcPath)!
    const last = saved.buckets.length - 1
    const buckets = saved.buckets.map((b, i) => (i === last ? { ...b, dropped: 5, droppedBy: { alpha: 3, '\u0000untracked': 2 } } : b))
    const data = { ...saved, buckets, evictedThrough: hourOf(T0 - 14 * DAY), renamesApplied: 4 }
    expect(new Set(data.buckets.map((b) => b.span))).toEqual(new Set(['hour', 'day']))
    expect(data.observed.length).toBeGreaterThan(1)
    await disposeWorkspaceService(src)

    // An older Hive's workspace with that metrics.json: the reports the Overview and Performance show, the whole range
    // and the last two days (hourly), for the workspace and each project.
    // Recording off while it is opened and reopened: a reopen is a new stretch of observation otherwise (a close is a
    // gap), the one difference that isn't the move's.
    config.settings.sessions.recordPerformance = false
    const path = fresh()
    writeFileSync(join(dirOf(path), 'metrics.json'), JSON.stringify(data))
    const w = createWorkspaceService()
    await w.open(path)
    const reports = async () => {
      const out: Record<string, unknown> = {}
      for (const [name, scope] of [['workspace', { kind: 'workspace' }], ['alpha', { kind: 'project', project: 'alpha' }], ['beta', { kind: 'project', project: 'beta' }]] as const) {
        out[`${name} month`] = await metricsReport(w, { scope, from: new Date(T0 - 30 * DAY).toISOString(), trend: true })
        out[`${name} 2 days`] = await metricsReport(w, { scope, from: new Date(T0 - 2 * DAY).toISOString(), trend: true })
      }
      return out
    }
    const before = await reports()
    // Read from the file: nothing saved yet.
    expect(metricsSaved(path)).toBeNull()
    const ws = before['workspace month'] as Awaited<ReturnType<typeof metricsReport>>
    expect(sumApi(Object.values(ws.projects)).count).toBe(2 * 13 * 3)
    expect(ws.coverage.evictedThrough).toBe(new Date(data.evictedThrough).toISOString())
    expect(JSON.stringify(before)).toMatch(/"dropped":[1-9]/)
    // Moved in by the save as it closes, then read from the database alone.
    await w.close()
    await metrics.flushMetrics()
    // Everything metrics.json held, as it held it: buckets (series, skills, losses), observation, eviction, renames.
    expect(metricsSaved(path)).toEqual(data)
    expect(existsSync(join(dirOf(path), 'metrics.json'))).toBe(false)
    expect(backups(path).length).toBe(1)
    await w.open(path)
    expect(await reports()).toEqual(before)
    await disposeWorkspaceService(w)
  })
})

describe("a launch's skills, as delivered", () => {
  it('measured on the copy the CLI reads: a kept, edited copy counts as it is, not as its source', async () => {
    const { deliveredSkillSizes } = await import('../src/main/sessions')
    const { codex } = await import('../src/main/providers/codex/adapter')
    ;(codex as unknown as { checkHookHashes: () => Promise<void> }).checkHookHashes = async () => undefined
    const root = join(base, 'delivered')
    const cwd = join(root, 'project')
    const src = join(root, 'skills', 'mine')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '---\nname: mine\ndescription: Short.\n---\n\nBody.\n')
    const ctx = { projectPath: cwd, agentId: 'a1', runId: 'r', cwd, skills: [{ name: 'mine', sourcePath: src }], mcpServers: {}, hookUrl: 'http://127.0.0.1:9/hook?run=x', env: {}, executable: 'codex' } as never
    const first = await deliveredSkillSizes(codex, ctx, await codex.prepareLaunch(ctx))
    // The copy grows (its marker still says it is the source's), the source doesn't: Codex reads the copy.
    const copy = codex.skillCopyPath(ctx, 'mine')
    writeFileSync(join(copy, 'notes.md'), 'x'.repeat(10_000))
    const second = await deliveredSkillSizes(codex, ctx, await codex.prepareLaunch(ctx))
    expect(second.bytes).toBe(first.bytes + 10_000)
    expect(second.catalog).toBe(first.catalog)
    // Not delivered: not counted.
    expect(await deliveredSkillSizes(codex, ctx, { mine: { revision: null, problem: 'x' } })).toEqual({ catalog: 0, bytes: 0, unmeasured: 0 })
  })
})

describe('cost', () => {
  it('recording is cheap, and a full bucket is bounded in memory and on disk', async () => {
    const { w, path } = await open()
    const t = performance.now()
    const N = 100_000
    for (let i = 0; i < N; i++) metrics.recordApi(metrics.metricsHandle(w), `p${i % 20}`, api(i % 2 ? '/v1/tasks' : '/v1/tasks/:n', { ms: i % 300 }))
    const perCallUs = ((performance.now() - t) * 1000) / N
    // Every series the caps allow, in one hour: Combwork's tools x roles x modes x outcomes, over projects.
    const { CW_TOOLS } = await import('../src/shared/assistantTools')
    const h = metrics.metricsHandle(w)
    for (let p = 0; p < 12; p++) for (const tool of CW_TOOLS) for (const role of ['agent', 'assistant'] as const) for (const mode of ['compact', 'detail']) for (const ok of [true, false]) metrics.recordMcp(h, `project-${p}`, role, { tool, mode, ok, chars: 1000, bytes: 1200, ms: 3 })
    const full = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    const kept = Object.values(full.projects).reduce((total, pt) => total + pt.mcp.length + pt.api.length, 0) + full.workspace!.api.length
    expect(kept).toBe(metrics.METRICS_LIMITS.series)
    expect(full.dropped).toBeGreaterThan(0)
    await metrics.flushMetrics()
    const size = savedBytes(path)
    const heap = Buffer.byteLength(JSON.stringify(metrics.metricsHandle(w)!.store.buckets))
    if (process.env.MEASURE) console.log(`recordApi: ${perCallUs.toFixed(2)} µs a call; a bucket at its ${metrics.METRICS_LIMITS.series}-series cap: ${(size / 1024).toFixed(0)} KB on disk, ${(heap / 1024).toFixed(0)} KB as JSON in memory`)
    expect(perCallUs).toBeLessThan(50)
    expect(size).toBeLessThanOrEqual(metrics.METRICS_LIMITS.fileBytes)
    await disposeWorkspaceService(w)
  }, 60_000)
})

describe('approved labels', () => {
  it("the tool names metrics take are exactly the Combwork MCP server's tools", async () => {
    const { CW_TOOLS } = await import('../src/shared/assistantTools')
    const source = readFileSync(join(__dirname, '..', 'src', 'main', 'mcp', 'hive-mcp.ts'), 'utf8')
    // A tool's name, or an intent tool's (#1267: intent('cw_submit', …)).
    const offered = [...source.matchAll(/(?:^ {4}name: |\bintent\(\s*)'(cw_[a-z_]+)'/gm)].map((m) => m[1])
    expect([...offered].sort()).toEqual([...CW_TOOLS].sort())
  })
})

describe('round 3: names, drops, saved expiry, byte cap, unmeasured copies', () => {
  it("projects named like Object methods are ordinary projects; a project is matched however it's cased", async () => {
    const { w, path } = await open()
    for (const p of ['constructor', '__proto__', 'toString', 'alpha']) metrics.recordApi(metrics.metricsHandle(w), p, api())
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(Object.keys(r.projects).sort()).toEqual(['__proto__', 'alpha', 'constructor', 'toString'])
    for (const p of ['constructor', '__proto__', 'toString']) expect(sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: p } }).projects)).count, p).toBe(1)
    expect(sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'ALPHA' } }).projects)).count).toBe(1)
    // Saved and loaded the same.
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect(sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: '__proto__' } }).projects)).count).toBe(1)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    await disposeWorkspaceService(w)
  })

  it("a project's report counts only its own dropped measurements", async () => {
    const { w } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.projects = 2
      metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
      metrics.recordApi(metrics.metricsHandle(w), 'gamma', api())
      metrics.recordApi(metrics.metricsHandle(w), 'beta', api())
      const of = (project: string) => metrics.queryMetrics(w, { scope: { kind: 'project', project } }).dropped
      expect([of('alpha'), of('beta'), of('BETA')]).toEqual([0, 1, 1])
      expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).dropped).toBe(1)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
    }
    await disposeWorkspaceService(w)
  })

  it('what expires is gone from what is saved too, even with nothing new recorded; a query that changes nothing writes nothing', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    await metrics.flushMetrics()
    let saves = 0
    storeTestHooks.beforeSave = async (store) => {
      if (store === 'metrics') saves++
    }
    try {
      metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
      await metrics.flushMetrics()
      expect(saves).toBe(0)
    } finally {
      storeTestHooks.beforeSave = null
    }
    config.settings.sessions.recordPerformance = false
    now = T0 + 31 * DAY
    metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    await w.close()
    await metrics.flushMetrics()
    expect(metricsSaved(path)!.buckets).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('the size cap is in UTF-8 bytes, a lone bucket over it included, so Combwork never saves more than it would read', async () => {
    const { w, path } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.fileBytes = 4600
      for (let h = 0; h < 6; h++) {
        now = T0 + h * HOUR
        for (let p = 0; p < 4; p++) metrics.recordApi(metrics.metricsHandle(w), `日本語プロジェクト-${p}`, api())
      }
      await metrics.flushMetrics()
      expect(savedBytes(path)).toBeLessThanOrEqual(4600)
      // One bucket bigger than the whole cap: nothing is kept rather than an over-cap file.
      metrics.METRICS_LIMITS.fileBytes = 200
      metrics.recordApi(metrics.metricsHandle(w), '🐝🐝🐝', api())
      await metrics.flushMetrics()
      expect(savedBytes(path)).toBeLessThanOrEqual(200)
      await w.close()
      await w.open(path)
      expect(() => metrics.queryMetrics(w, { scope: { kind: 'workspace' } })).not.toThrow()
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
      await disposeWorkspaceService(w)
    }
  })

  it("a delivered copy that can't be measured is counted as unmeasured, not as zero", async () => {
    const { deliveredSkillSizes } = await import('../src/main/sessions')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const root = join(base, 'unmeasured')
    const cwd = join(root, 'project')
    mkdirSync(join(cwd, '.agents', 'skills', 'cw-ok'), { recursive: true })
    writeFileSync(join(cwd, '.agents', 'skills', 'cw-ok', 'SKILL.md'), '---\nname: ok\ndescription: Fine.\n---\n')
    mkdirSync(join(cwd, '.agents', 'skills', 'cw-headless'), { recursive: true })
    writeFileSync(join(cwd, '.agents', 'skills', 'cw-headless', 'notes.md'), 'no SKILL.md here')
    const ctx = { projectPath: cwd, agentId: 'a1', cwd } as never
    const r = await deliveredSkillSizes(codex, ctx, { ok: { revision: 'r1' }, gone: { revision: 'r2' }, headless: { revision: 'r3' }, never: { revision: null } })
    expect(r.unmeasured).toBe(2)
    expect(r.catalog).toBe(utf8Bytes('ok') + utf8Bytes('Fine.'))
    expect(r.bytes).toBe(statSync(join(cwd, '.agents', 'skills', 'cw-ok', 'SKILL.md')).size)
  })
})

describe('round 4: bounded loss owners, unreadable copied headers', () => {
  it('owners of dropped measurements are capped like projects; past that, losses are untracked, which a project report only flags', async () => {
    const { w, path } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.projects = 3
      for (let i = 0; i < 1000; i++) metrics.recordApi(metrics.metricsHandle(w), `p${i}`, api())
      const store = metrics.metricsHandle(w)!.store
      const owners = Object.keys(store.buckets[0].droppedBy)
      expect(owners.length).toBeLessThanOrEqual(metrics.METRICS_LIMITS.projects + 2)
      expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).dropped).toBe(997)
      // A tracked owner knows its own; an untracked one says its losses are unknown, up to the untracked total.
      const tracked = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'p3' } })
      expect(tracked.dropped).toBe(1)
      const untracked = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'p999' } })
      expect([untracked.dropped, untracked.lossesUnattributed, 'droppedUntracked' in untracked]).toEqual([0, true, false])
      expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).droppedUntracked).toBe(994)
      // Saved and loaded: still bounded.
      await w.close()
      await metrics.flushMetrics()
      const raw = metricsSaved(path)!
      const droppedBy = (raw.buckets[0] as { droppedBy: Record<string, number> }).droppedBy
      for (let i = 0; i < 1000; i++) droppedBy[`extra-${i}`] = 1
      await putMetrics(path, raw as never)
      await w.open(path)
      expect(Object.keys(metrics.metricsHandle(w)!.store.buckets[0].droppedBy).length).toBeLessThanOrEqual(metrics.METRICS_LIMITS.projects + 2)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
      await disposeWorkspaceService(w)
    }
  }, 60_000)

  it("a copied SKILL.md whose header can't be read (invalid YAML, a key twice, an unknown audience) is unmeasured", async () => {
    const { deliveredSkillSizes } = await import('../src/main/sessions')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const cwd = join(base, 'bad-headers')
    const headers: Record<string, string> = {
      broken: '---\nname: broken\nmetadata: [broken\n---\n',
      twice: '---\nname: twice\nname: again\n---\n',
      audience: '---\nname: audience\nmetadata:\n  audience: assitant\n---\n',
      fine: '---\nname: fine\ndescription: Good.\n---\n'
    }
    for (const [name, text] of Object.entries(headers)) {
      mkdirSync(join(cwd, '.agents', 'skills', `cw-${name}`), { recursive: true })
      writeFileSync(join(cwd, '.agents', 'skills', `cw-${name}`, 'SKILL.md'), text)
    }
    const r = await deliveredSkillSizes(codex, { projectPath: cwd, agentId: 'a1', cwd } as never, Object.fromEntries(Object.keys(headers).map((k) => [k, { revision: 'r' }])))
    expect(r.unmeasured).toBe(3)
    expect(r.catalog).toBe(utf8Bytes('fine') + utf8Bytes('Good.'))
    expect(r.bytes).toBe(Buffer.byteLength(headers.fine))
  })
})

describe('round 5: closing, and project-scoped losses', () => {
  it('nothing is admitted while a workspace is closing; after it reopens, recording works and is saved', async () => {
    const { w, path } = await open()
    // Its open settled (HI-1747: the bundled items' update after it, HI-1705, ended), so its close waits on nothing first.
    await w.itemsUpToDate()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    const closing = w.close()
    const late = metrics.metricsHandle(w)
    // Skill work started while it closes: its handle is taken the same way.
    const { revisionOf } = await import('../src/main/revisions')
    const { inWorkspace } = await import('../src/main/workspace')
    await closing
    expect(late).toBeNull()
    metrics.recordApi(late, 'alpha', api())
    await inWorkspace(w, () => revisionOf(join(path, 'nowhere')).catch(() => undefined))
    await metrics.flushMetrics()
    expect((metricsSaved(path)!.buckets[0] as { projects: Record<string, { api: Record<string, { count: number }> }> }).projects.alpha.api['GET /v1/tasks agent ok'].count).toBe(1)
    await w.open(path)
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.api[0].count).toBe(2)
    await disposeWorkspaceService(w)
  })

  it("a project report never carries other projects' or untracked loss counts, only its own and a flag", async () => {
    const { w } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.projects = 1
      metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
      metrics.recordApi(metrics.metricsHandle(w), 'beta', api())
      for (let i = 0; i < 10; i++) metrics.recordApi(metrics.metricsHandle(w), `other-${i}`, api())
      const alpha = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } })
      expect(alpha.dropped).toBe(0)
      expect(alpha.lossesUnattributed).toBe(true)
      expect(JSON.stringify(alpha)).not.toMatch(/"(droppedUntracked|droppedBy)"/)
      const whole = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
      expect([whole.dropped, whole.droppedUntracked]).toEqual([11, 10])
      // beta's known losses (one each hour), summed over hours even past the owners' cap in a sum.
      now = T0 + HOUR
      metrics.recordApi(metrics.metricsHandle(w), 'gamma', api())
      metrics.recordApi(metrics.metricsHandle(w), 'beta', api())
      expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'beta' }, from: new Date(T0 - HOUR).toISOString(), to: new Date(T0 + 2 * HOUR).toISOString() }).dropped).toBe(2)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
    }
    await disposeWorkspaceService(w)
  })
})

describe('round 6: long project names, drop-only saves', () => {
  it('a supported project name longer than the label budget is still its own project, found however it is cased', async () => {
    const { w } = await open()
    const long = 'long-project-'.repeat(11).slice(0, 135)
    expect(long.length).toBe(135)
    const made = await w.createProject(long)
    expect(made).toBeTruthy()
    metrics.recordApi(metrics.metricsHandle(w), long, api())
    const mine = metrics.queryMetrics(w, { scope: { kind: 'project', project: long } })
    expect(sumApi(Object.values(mine.projects)).count).toBe(1)
    expect(sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: long.toUpperCase() } }).projects)).count).toBe(1)
    // Its label is bounded, and nothing of it went to the workspace's own part.
    const whole = metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(Object.keys(whole.projects).every((k) => k.length <= 128)).toBe(true)
    expect(whole.workspace!.api).toEqual([])
    // A name that can't be a folder: untracked, flagged, never the workspace's.
    metrics.recordApi(metrics.metricsHandle(w), 'a/b', api())
    const odd = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'a/b' } })
    expect([odd.dropped, odd.lossesUnattributed]).toEqual([0, true])
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).workspace!.api).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('a measurement only dropped (MCP, catalog, launch) is saved as a loss, and nothing happens with recording off', async () => {
    const { w, path } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.projects = 1
      metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
      await metrics.flushMetrics()
      metrics.recordMcp(metrics.metricsHandle(w), 'beta', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 1, bytes: 1, ms: 1 })
      metrics.recordCatalog(metrics.metricsHandle(w), 'gamma', 'agent', 'builder', { tools: 1, toolsBytes: 10 })
      metrics.recordLaunch(metrics.metricsHandle(w), 'delta', { provider: 'codex', role: 'agent', workflow: 'builder', guidanceBytes: 1, guidanceChars: 1, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 0, skillCatalogBytes: 0, skillBytes: 0, skillsNotDelivered: 0, skillsUnmeasured: 0 })
      await w.close()
      await metrics.flushMetrics()
      await w.open(path)
      // beta's loss is tracked (the one owner the cap allows); gamma's and delta's are untracked: flagged, and all three
      // are in the workspace's total, after a save and reload with nothing accepted since the last save.
      expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'beta' } }).dropped).toBe(1)
      for (const p of ['gamma', 'delta']) expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: p } }).lossesUnattributed, p).toBe(true)
      expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).dropped).toBe(3)
      config.settings.sessions.recordPerformance = false
      metrics.recordMcp(metrics.metricsHandle(w), 'beta', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 1, bytes: 1, ms: 1 })
      expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'beta' } }).dropped).toBe(1)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
      await disposeWorkspaceService(w)
    }
  })
})

describe('round 7: a shortened label never equals a real project name', () => {
  it("a long project and a project named like its shortened label are two projects; neither sees the other's", async () => {
    const { createHash } = await import('crypto')
    const { w, path } = await open()
    const long = 'long-project-'.repeat(11).slice(0, 135)
    await w.createProject(long)
    // The label the round-6 encoding gave the long project: a valid name of its own.
    const lookalike = `${long.slice(0, 111)}~${createHash('sha256').update(long.toLowerCase()).digest('hex').slice(0, 16)}`
    await w.createProject(lookalike)
    // The new encoding's separator can't be in a project's name: Combwork refuses it.
    await expect(w.createProject(`${long.slice(0, 111)}|${'0'.repeat(16)}`)).rejects.toThrow(/Project names cannot/)
    metrics.recordApi(metrics.metricsHandle(w), long, api())
    metrics.recordApi(metrics.metricsHandle(w), lookalike, api('/v1/tasks/:n'))
    metrics.recordApi(metrics.metricsHandle(w), lookalike, api('/v1/tasks/:n'))
    const count = (p: string) => sumApi(Object.values(metrics.queryMetrics(w, { scope: { kind: 'project', project: p } }).projects)).count
    expect([count(long), count(long.toUpperCase()), count(lookalike), count(lookalike.toUpperCase())]).toEqual([1, 1, 2, 2])
    // Saved and loaded: still two.
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    expect([count(long), count(lookalike)]).toEqual([1, 2])
    expect(Object.keys(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).projects)).toHaveLength(2)
    // Drops: each its own.
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      metrics.METRICS_LIMITS.series = 0
      metrics.recordApi(metrics.metricsHandle(w), long, api('/v1/tasks', { outcome: 'denied' }))
      expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: long } }).dropped).toBe(1)
      expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: lookalike } }).dropped).toBe(0)
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
    }
    // A raw name with "|" (impossible for a folder) is untracked, not anyone's.
    metrics.recordApi(metrics.metricsHandle(w), `${long.slice(0, 111)}|${'0'.repeat(16)}`, api())
    expect(count(`${long.slice(0, 111)}|${'0'.repeat(16)}`)).toBe(0)
    await disposeWorkspaceService(w)
  })
})

describe('trend, the Performance view and export', () => {
  const view = () => import('../src/shared/metricsView')
  const report = (r: Omit<import('../src/shared/metrics').MetricsReport, 'providers'>, providers: import('../src/shared/metrics').ProviderUsageSummary[] = []) => ({ ...r, providers })
  const usage = (provider: string, costUsd: number) => ({ provider, sessions: 1, unknown: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 2, compactions: 0, safeguardStops: 0, costUsd, costEstimated: 0, costUnknown: 0, role: 'agent' as const, running: 0, contextSessions: 0, contextAvgTokens: 0, contextMaxTokens: 0, contextWindow: null })

  it('a trend has every slot of the range: hours up to 2 days, days beyond; a project scope only its own', async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api('/v1/tasks', { outcome: 'server-error' }))
    metrics.recordApi(metrics.metricsHandle(w), 'beta', api())
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { role: 'assistant' }))
    now = T0 - 5 * HOUR
    metrics.recordMcp(metrics.metricsHandle(w), 'alpha', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 50, bytes: 60, ms: 3 })
    now = T0
    const day = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - DAY).toISOString(), trend: true })
    expect(day.trendStep).toBe('hour')
    expect(day.trend!.length).toBe(25)
    // Consecutive hours, none missing.
    expect(day.trend!.every((p, i) => i === 0 || Date.parse(p.start) - Date.parse(day.trend![i - 1].start) === HOUR)).toBe(true)
    expect(day.trend!.at(-1)).toMatchObject({ start: '2026-10-01T10:00:00.000Z', requests: 4, failed: 1 })
    expect(day.trend!.find((p) => p.toolCalls)).toMatchObject({ start: '2026-10-01T05:00:00.000Z', toolCalls: 1, toolChars: 50, requests: 0 })
    expect(day.trend!.reduce((sum, p) => sum + p.requests, 0)).toBe(4)
    const alpha = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'ALPHA' }, from: new Date(T0 - DAY).toISOString(), trend: true })
    expect(alpha.trend!.reduce((sum, p) => sum + p.requests, 0)).toBe(2)
    const week = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 7 * DAY).toISOString(), trend: true })
    expect([week.trendStep, week.trend!.length]).toEqual(['day', 8])
    expect(week.trend!.at(-1)!.requests).toBe(4)
    // Not asked for: not there.
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).trend).toBeUndefined()
    await disposeWorkspaceService(w)
  })

  it("the view's filters: scope, role and provider; totals and tables from what they keep", async () => {
    const { select, totals, byRoute, byTool, providersIn, isEmpty, partsOf, WORKSPACE_OWN, DEFAULT_PERF_FILTERS } = await view()
    const { w } = await open()
    for (let i = 0; i < 3; i++) metrics.recordApi(metrics.metricsHandle(w), 'Alpha', api('/v1/tasks', { ms: 3 }))
    metrics.recordApi(metrics.metricsHandle(w), 'beta', api('/v1/tasks/:n', { outcome: 'cancelled', ms: 300 }))
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { role: 'api' }))
    metrics.recordMcp(metrics.metricsHandle(w), 'Alpha', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 50, bytes: 60, ms: 3 })
    metrics.recordMcp(metrics.metricsHandle(w), 'Alpha', 'agent', { tool: 'cw_read_task', mode: 'detail', ok: false, chars: 500, bytes: 500, ms: 3 })
    metrics.recordLaunch(metrics.metricsHandle(w), 'Alpha', { provider: 'claude-code', role: 'agent', workflow: 'builder', guidanceBytes: 1000, guidanceChars: 1000, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 4, skillCatalogBytes: 400, skillBytes: 9000, skillsNotDelivered: 1, skillsUnmeasured: 0 })
    metrics.recordLaunch(metrics.metricsHandle(w), 'beta', { provider: 'codex', role: 'agent', workflow: 'builder', guidanceBytes: 2000, guidanceChars: 2000, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 2, skillCatalogBytes: 200, skillBytes: 1000, skillsNotDelivered: 0, skillsUnmeasured: 1 })
    const r = report(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }), [usage('claude-code', 1), usage('codex', 2)])

    const all = totals(select(r, DEFAULT_PERF_FILTERS))
    expect([all.requests, all.failed, all.cancelled, all.launches, all.toolCalls, all.toolChars, all.detailCalls, all.toolErrors]).toEqual([5, 1, 1, 2, 2, 550, 1, 1])
    expect(all.avgGuidanceBytes).toBe(1500)
    expect([all.p50, all.p95]).toEqual([5, 500])
    // A project, matched in any case; the workspace's own work; a role; a provider.
    expect(totals(select(r, { ...DEFAULT_PERF_FILTERS, project: 'alpha' })).requests).toBe(3)
    expect(totals(select(r, { ...DEFAULT_PERF_FILTERS, project: WORKSPACE_OWN })).requests).toBe(1)
    expect(totals(select(r, { ...DEFAULT_PERF_FILTERS, role: 'api' })).requests).toBe(1)
    const codex = select(r, { ...DEFAULT_PERF_FILTERS, provider: 'codex' })
    expect([totals(codex).launches, codex.providers.map((p) => p.provider)]).toEqual([1, ['codex']])
    expect(providersIn(r)).toEqual(['claude-code', 'codex'])
    // The filter's choices keep its current one even when the range has none of it (#270).
    expect(providersIn(report(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'beta' } })), 'claude-code')).toEqual(['claude-code', 'codex'])
    expect(providersIn(r, 'codex')).toEqual(['claude-code', 'codex'])
    expect(isEmpty(select(r, { ...DEFAULT_PERF_FILTERS, project: 'gamma' }))).toBe(false) // provider usage is the scope's
    expect(isEmpty(select(report(metrics.queryMetrics(w, { scope: { kind: 'workspace' } })), { ...DEFAULT_PERF_FILTERS, project: 'gamma' }))).toBe(true)

    const routes = byRoute(select(r, DEFAULT_PERF_FILTERS).api)
    expect(routes.map((x) => [x.key, x.requests, x.failed])).toEqual([['GET /v1/tasks', 4, 0], ['GET /v1/tasks/:n', 1, 1]])
    const tools = byTool(select(r, DEFAULT_PERF_FILTERS).mcp)
    expect(tools.map((x) => [x.tool, x.calls, x.chars, x.detail, x.errors])).toEqual([['cw_read_task', 1, 500, 1, 1], ['cw_list_tasks', 1, 50, 0, 0]])

    // A project's report holds only that project: no filter widens it.
    const alpha = report(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }))
    expect(partsOf(alpha, WORKSPACE_OWN)).toHaveLength(1)
    expect(totals(select(alpha, { ...DEFAULT_PERF_FILTERS, project: WORKSPACE_OWN })).requests).toBe(3)
    expect(totals(select(alpha, { ...DEFAULT_PERF_FILTERS, project: 'beta' })).requests).toBe(3)
    await disposeWorkspaceService(w)
  })

  it('an export carries its schema, version and units; sanitized, no project name or workspace path is left', async () => {
    const { metricsExport, METRICS_EXPORT_SCHEMA } = await import('../src/main/metricsUsage')
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'Secret-Project', api())
    metrics.recordApi(metrics.metricsHandle(w), 'other', api())
    const r = { ...report(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, trend: true })), safeguards: [{ project: 'Secret-Project', agent: 'Secret-Agent', provider: 'claude-code', role: 'agent' as const, model: 'claude-opus-5-5', stops: 1 }] }
    const plain = metricsExport(r, '9.9.9', false) as Record<string, unknown>
    expect(plain).toMatchObject({ schema: METRICS_EXPORT_SCHEMA, app: { name: 'Combwork', version: '9.9.9' }, sanitized: false })
    expect(Object.keys(plain.units as object)).toEqual(expect.arrayContaining(['bytes', 'chars', 'ms', 'tokens', 'costUsd']))
    expect(JSON.stringify(plain)).toContain('Secret-Project')
    const clean = JSON.stringify(metricsExport(r, '9.9.9', true))
    expect(clean).not.toMatch(/Secret-Project|Secret-Agent|"other"/)
    expect(JSON.parse(clean).report.safeguards).toEqual([{ project: 'project-1', agent: 'agent-1', provider: 'claude-code', role: 'agent', model: 'claude-opus-5-5', stops: 1 }])
    expect(clean).not.toContain(JSON.stringify(path).slice(1, -1))
    expect(Object.keys(JSON.parse(clean).report.projects).sort()).toEqual(['project-1', 'project-2'])
    expect(JSON.parse(clean).report.trend.length).toBeGreaterThan(0)
    const one = metricsExport(report(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'SECRET-project' } })), '9.9.9', true) as { report: { scope: unknown; projects: object } }
    expect([one.report.scope, Object.keys(one.report.projects)]).toEqual([{ kind: 'project', project: 'project-1' }, ['project-1']])
    await disposeWorkspaceService(w)
  })
})

describe('#116 round 1: filters, coverage, attribution, unknown usage, guidance parts', () => {
  const launch = (extra: Partial<Parameters<typeof metrics.recordLaunch>[2]> = {}) => ({ provider: 'claude-code', role: 'agent' as const, workflow: 'builder' as const, guidanceBytes: 100, guidanceChars: 100, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 1, skillCatalogBytes: 10, skillBytes: 20, skillsNotDelivered: 0, skillsUnmeasured: 0, ...extra })

  it("filters narrow every part, the trend and the totals alike, and say what they can't narrow", async () => {
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { role: 'api' }))
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { role: 'assistant', outcome: 'cancelled' }))
    metrics.recordMcp(metrics.metricsHandle(w), 'alpha', 'agent', { tool: 'cw_list_tasks', mode: 'compact', ok: true, chars: 50, bytes: 50, ms: 1 })
    metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', launch())
    metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', launch({ provider: 'codex' }))
    const q = (extra: Partial<import('../src/shared/metrics').MetricsQuery>) => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, trend: true, ...extra })
    const trendSum = (r: ReturnType<typeof q>, k: 'requests' | 'toolCalls' | 'launches' | 'cancelled') => r.trend!.reduce((sum, p) => sum + p[k], 0)

    // The workspace's own work: no project's part, in the parts or in the trend.
    const own = q({ own: true })
    expect([Object.keys(own.projects), own.workspace!.api.length, trendSum(own, 'requests'), trendSum(own, 'toolCalls'), trendSum(own, 'launches'), trendSum(own, 'cancelled')]).toEqual([[], 2, 2, 0, 0, 1])
    expect(own.filters).toEqual({ own: true, notFiltered: [] })
    // Scripts only: one request, no tools, no launches.
    const scripts = q({ role: 'api' })
    expect([trendSum(scripts, 'requests'), trendSum(scripts, 'toolCalls'), trendSum(scripts, 'launches'), scripts.projects.alpha.api.length]).toEqual([1, 0, 0, 0])
    expect(scripts.filters.notFiltered.join(' ')).toMatch(/skill service/)
    // A provider: launches narrowed; requests are every provider's, and the report says so.
    const codex = q({ provider: 'codex' })
    expect([trendSum(codex, 'launches'), codex.projects.alpha.guidance.map((g) => g.provider), trendSum(codex, 'requests')]).toEqual([1, ['codex'], 4])
    expect(codex.filters.notFiltered.join(' ')).toMatch(/recorded per provider/)
    // A project scope with a role: still only that project.
    const alphaApi = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' }, role: 'api', trend: true })
    expect([alphaApi.projects.alpha.api.length, trendSum(alphaApi, 'requests')]).toEqual([0, 0])
    expect(() => q({ role: 'root' as never })).toThrow(/role/)
    await disposeWorkspaceService(w)
  })

  it('coverage: what was observed (open, recording, since a reset), in stretches; unobserved trend slots are marked, not zero', async () => {
    const { w, path } = await open()
    // Opened at T0 (10:30): observed from then, not the 24 hours before.
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    now = T0 + 2 * HOUR
    let r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 22 * HOUR).toISOString(), trend: true })
    // No touch between T0 and now (the fake clock jumped): two stretches, each a moment.
    expect(r.coverage.observedSince).toBe(new Date(T0).toISOString())
    expect(r.coverage.stretches).toBe(2)
    expect(r.trend!.filter((p) => p.observedMs > 0).length).toBe(0)
    // Observed steadily (a touch every few minutes) for an hour.
    for (let m = 0; m <= 60; m += 5) {
      now = T0 + 2 * HOUR + m * 60_000
      metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    }
    r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 21 * HOUR).toISOString(), trend: true })
    expect(r.coverage.observedMs).toBe(HOUR)
    expect(r.trend!.reduce((sum, p) => sum + p.observedMs, 0)).toBe(HOUR)
    expect(r.trend!.find((p) => p.start === new Date(T0 - 30 * 60_000 - 10 * HOUR + 10 * HOUR).toISOString())?.observedMs ?? 0).toBe(0)
    // Recording off: nothing is extended.
    config.settings.sessions.recordPerformance = false
    now += 30 * 60_000
    metrics.queryMetrics(w, { scope: { kind: 'workspace' } })
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 20 * HOUR).toISOString() }).coverage.observedMs).toBe(HOUR)
    config.settings.sessions.recordPerformance = true
    // Saved and read back.
    await w.close()
    await metrics.flushMetrics()
    expect(metricsSaved(path)!.observed.length).toBeGreaterThan(0)
    await w.open(path)
    expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 20 * HOUR).toISOString() }).coverage.observedMs).toBe(HOUR)
    // A reset: observed from the reset only.
    now += HOUR
    metrics.resetMetrics(w)
    r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 20 * HOUR).toISOString() })
    expect([r.coverage.observedSince, r.coverage.observedMs, r.coverage.stretches]).toEqual([new Date(now).toISOString(), 0, 1])
    await disposeWorkspaceService(w)
  })

  it('a long gap is a gap; saved bad stretches: only the valid ones are kept', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    now = T0 + metrics.METRICS_LIMITS.touchMs
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    now = T0 + 3 * HOUR
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - HOUR).toISOString() })
    expect([r.coverage.stretches, r.coverage.observedMs]).toEqual([2, metrics.METRICS_LIMITS.touchMs])
    await w.close()
    await metrics.flushMetrics()
    await putMetrics(path, { ...(metricsSaved(path) as never as { buckets: { span: string; start: number }[] }), observed: [[T0 - HOUR, T0 - HOUR + 1000], 'x', [5, 1], [T0, T0 + 1000], [T0 - 2 * HOUR, T0 - HOUR], [-1, 3]] })
    now = T0 + 3 * HOUR
    await w.open(path)
    const back = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    // Kept: the two in order (the out-of-order one, a reversed one, a negative one and junk are not), plus now.
    expect(back.coverage.observedMs).toBe(2000)
    await disposeWorkspaceService(w)
  })

  it("provider usage: the Assistant's and projects' sessions apart, filtered by own work and role; no usage is unknown, never $0", async () => {
    const { sessions } = await import('../src/main/sessions')
    const { metricsReport } = await import('../src/main/metricsUsage')
    const { w, path } = await open()
    for (const p of ['alpha', 'beta']) mkdirSync(join(path, p), { recursive: true })
    const at = new Date(T0 - HOUR).toISOString()
    const usage = (input: number, cost: number | null, context = 0) => ({ inputTokens: input, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 2, reasoningTokens: 0, contextTokens: context, contextWindow: context ? 200000 : null, compactions: [], cacheTtlSeconds: 300, firstActivity: at, lastActivity: at, userMessages: 1, lastPrompt: null, costUsd: cost, costEstimated: false })
    const item = (id: string, u: (ReturnType<typeof usage> & { safeguards?: Record<string, number> }) | null, agentName?: string) => ({ id, provider: 'claude-code', source: 'hive', title: null, lastActivity: at, hasTranscript: true, hasBackup: false, usage: u, recache: null, ...(agentName ? { agentName } : {}) })
    const byPath: Record<string, unknown[]> = {
      [join(path, 'alpha').toLowerCase()]: [item('a1', { ...usage(100, 1, 5000), safeguards: { 'claude-opus-5-5': 2 } }, 'HB3'), item('a2', { ...usage(50, null, 15000), safeguards: { 'claude-opus-5-5': 1, 'claude-opus-4-8': 1 } }, 'HB3')],
      [join(path, 'beta').toLowerCase()]: [item('b1', null)],
      [w.assistantHome.toLowerCase()]: [item('s1', usage(7, 0.5))]
    }
    const orig = { usageItems: sessions.usageItems, projectStates: sessions.projectStates }
    ;(sessions as unknown as { usageItems: (p: string) => Promise<unknown[]> }).usageItems = async (p) => byPath[p.toLowerCase()] ?? []
    ;(sessions as unknown as { projectStates: (p: string) => unknown[] }).projectStates = (p) => (p.toLowerCase() === join(path, 'alpha').toLowerCase() ? [{ sessionId: 'a1' }] : [])
    try {
      const rows = async (extra: Partial<import('../src/shared/metrics').MetricsQuery> = {}) => (await metricsReport(w, { scope: { kind: 'workspace' }, ...extra })).providers
      const all = await rows()
      const agents = all.find((p) => p.role === 'agent')!
      const assistant = all.find((p) => p.role === 'assistant')!
      expect([agents.sessions, agents.running, agents.unknown, agents.inputTokens, agents.costUsd, agents.costUnknown]).toEqual([3, 1, 1, 150, 1, 2])
      expect([agents.contextSessions, agents.contextAvgTokens, agents.contextMaxTokens, agents.contextWindow]).toEqual([2, 10000, 15000, 200000])
      expect([assistant.sessions, assistant.inputTokens, assistant.costUsd]).toEqual([1, 7, 0.5])
      // Safeguard stops (#606): per provider, and per agent and model, most first.
      expect([agents.safeguardStops, assistant.safeguardStops]).toEqual([4, 0])
      const report = await metricsReport(w, { scope: { kind: 'workspace' } })
      expect(report.safeguards).toEqual([
        { project: 'alpha', agent: 'HB3', provider: 'claude-code', role: 'agent', model: 'claude-opus-5-5', stops: 3 },
        { project: 'alpha', agent: 'HB3', provider: 'claude-code', role: 'agent', model: 'claude-opus-4-8', stops: 1 }
      ])
      expect((await metricsReport(w, { scope: { kind: 'project', project: 'beta' } })).safeguards).toBeUndefined()
      // The workspace's own work, or the Assistant only: the Assistant's sessions alone.
      expect((await rows({ own: true })).map((p) => p.role)).toEqual(['assistant'])
      expect((await rows({ role: 'assistant' })).map((p) => p.role)).toEqual(['assistant'])
      expect((await rows({ role: 'agent' })).map((p) => p.role)).toEqual(['agent'])
      // Scripts: none, and said.
      const scripts = await metricsReport(w, { scope: { kind: 'workspace' }, role: 'api' })
      expect([scripts.providers, scripts.providersNote]).toEqual([[], expect.stringMatching(/Scripts/)])
      // A project with only an unknown session: unknown cost, not a priced zero.
      const beta = (await metricsReport(w, { scope: { kind: 'project', project: 'beta' } })).providers
      expect(beta).toMatchObject([{ role: 'agent', sessions: 1, unknown: 1, costUnknown: 1, costUsd: 0 }])
      // A project scope never has the Assistant's.
      expect((await metricsReport(w, { scope: { kind: 'project', project: 'alpha' }, role: 'assistant' })).providers).toEqual([])
    } finally {
      Object.assign(sessions, orig)
      await disposeWorkspaceService(w)
    }
  })

  it("a launch's guidance in parts: core, the project's additions, the Assistant's role and mode", async () => {
    const { launchParts } = await import('../src/main/guidance')
    const { hiveInstructions, withLatestHandover } = await import('../src/shared/hiveGuidance')
    const core = hiveInstructions('alpha')
    const withHandover = withLatestHandover(core, 'handovers/alpha/one.md')
    const agent = launchParts(withHandover, 'agent', 'alpha', null)
    expect([agent.guidanceBytes, agent.customBytes, agent.roleBytes, agent.modeBytes]).toEqual([utf8Bytes(core), utf8Bytes(withHandover) - utf8Bytes(core), 0, 0])
    expect(agent.customChars).toBeGreaterThan(0)
    const mode = '# Your mode: Bee\n\nBuzz. Ünïcödé.'
    const text = `You are the Combwork Assistant…\n\n${mode}`
    const assistant = launchParts(hiveInstructions('', 'assistant'), 'assistant', 'assistant', { text, modeText: mode })
    expect([assistant.customBytes, assistant.roleBytes, assistant.modeBytes]).toEqual([0, utf8Bytes(text) - utf8Bytes(mode), utf8Bytes(mode)])
    // The Assistant's journal (HI-2112): off, the contract is all core; on, its skills line changes inside the contract
    // (HI-2048), which is still core, and its rule after it is custom.
    const { journalRule } = await import('../src/shared/hiveGuidance')
    const assistantCore = hiveInstructions('', 'assistant')
    expect(launchParts(hiveInstructions('', 'assistant', true, undefined, null), 'assistant', 'assistant', null)).toMatchObject({ guidanceBytes: utf8Bytes(assistantCore), customBytes: 0 })
    const journalOn = hiveInstructions('', 'assistant', true, undefined, ['decision', 'plan'])
    expect(journalOn.startsWith(assistantCore)).toBe(false)
    const rule = `\n${journalRule(['decision', 'plan'])}`
    expect(launchParts(journalOn, 'assistant', 'assistant', null)).toMatchObject({ guidanceBytes: utf8Bytes(journalOn) - utf8Bytes(rule), customBytes: utf8Bytes(rule) })
    // Without long commands wrapped too (Settings → General).
    const unwrapped = hiveInstructions('', 'assistant', false, undefined, ['decision'])
    expect(launchParts(unwrapped, 'assistant', 'assistant', null).customBytes).toBe(utf8Bytes(`\n${journalRule(['decision'])}`))
    // Text that isn't as expected is counted whole, never split by guesswork.
    expect(launchParts('something else', 'agent', 'alpha', null)).toMatchObject({ guidanceBytes: 14, customBytes: 0 })
    expect(launchParts('', 'agent', 'alpha', null)).toMatchObject({ guidanceBytes: 0, customBytes: 0 })
    expect(launchParts('', 'assistant', 'x', { text, modeText: 'not at the end' })).toMatchObject({ roleBytes: utf8Bytes(text), modeBytes: 0 })
  })

  it('an export holds the filters, coverage and range it was made with', async () => {
    const { metricsExport } = await import('../src/main/metricsUsage')
    const { queryFor, pageQuery, WORKSPACE_OWN, DEFAULT_PERF_FILTERS } = await import('../src/shared/metricsView')
    const { w } = await open()
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', api())
    metrics.recordApi(metrics.metricsHandle(w), null, api('/v1/tasks', { role: 'api' }))
    const q = queryFor({ kind: 'workspace' }, { ...DEFAULT_PERF_FILTERS, project: WORKSPACE_OWN, role: 'api', provider: 'codex' }, now)
    expect(q).toMatchObject({ own: true, role: 'api', provider: 'codex', trend: true })
    const r = { ...metrics.queryMetrics(w, q), providers: [] }
    const out = metricsExport(r, '1.0.0', false) as { filters: { own: boolean; role: string; provider: string }; coverage: { observedMs: number }; range: object; report: { projects: object } }
    expect(out.filters).toMatchObject({ own: true, role: 'api', provider: 'codex' })
    expect(Object.keys(out.report.projects)).toEqual([])
    expect(out.coverage).toBeTruthy()
    expect(out.range).toEqual({ from: r.from, to: r.to })
    // A project's tab: never own work, whatever its filters say.
    expect(queryFor({ kind: 'project', project: 'alpha' }, { ...DEFAULT_PERF_FILTERS, project: WORKSPACE_OWN }, now).own).toBeUndefined()
    // The page's query (its load, Export and Keep current view): the same, every provider's (#270).
    const page = pageQuery({ kind: 'workspace' }, { ...DEFAULT_PERF_FILTERS, project: WORKSPACE_OWN, role: 'api', provider: 'codex' }, now)
    expect(page).toEqual({ ...q, provider: undefined })
    expect('provider' in page).toBe(false)
    await disposeWorkspaceService(w)
  })
})

describe('#116 round 2: observation boundaries, evicted history, unreadable session history', () => {
  const MIN = 60_000
  const cov = (w: WS, from = T0 - HOUR) => metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(from).toISOString() }).coverage
  const at = (m: number) => (now = T0 + m * MIN)

  it("recording off is a gap, however short: never joined over (a touch while off, or the setting's change)", async () => {
    const { w } = await open()
    // The probe: recorded at T0, queried at +1, off and queried at +4, on and queried at +5.
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    at(1)
    cov(w)
    config.settings.sessions.recordPerformance = false
    at(4)
    cov(w)
    config.settings.sessions.recordPerformance = true
    at(5)
    let c = cov(w, T0)
    expect([c.rangeMs, c.observedMs, c.stretches]).toEqual([5 * MIN, MIN, 2])
    // Through the setting itself, with no touch while it was off: ended at the change, restarted at the next.
    at(6)
    cov(w)
    at(7)
    config.updateSettings({ sessions: { recordPerformance: false } })
    at(9)
    config.updateSettings({ sessions: { recordPerformance: true } })
    at(10)
    c = cov(w, T0)
    // 0–1, then 5–7 (off at 7), then 9–10.
    expect([c.observedMs, c.stretches]).toEqual([4 * MIN, 3])
    await disposeWorkspaceService(w)
  })

  it('the last window closing is a gap, even reopened within a minute; another window still open is not', async () => {
    const { w, path } = await open()
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    at(1)
    await w.close()
    at(2)
    await w.open(path)
    // Observed from its first use after reopening (a record, a query, a scan), never across the close.
    metrics.recordApi(metrics.metricsHandle(w), null, api())
    at(3)
    let c = cov(w, T0)
    expect([c.observedMs, c.stretches]).toEqual([2 * MIN, 2])
    // Another window opening it as this one closes (sharing its store while it saves): a new stretch, not a join.
    at(4)
    const closing = w.close()
    const other = createWorkspaceService()
    await other.open(path)
    metrics.recordApi(metrics.metricsHandle(other), null, api())
    await closing
    at(5)
    c = cov(other, T0)
    // 0–1, 2–4, 4–5: the close at 4 ends one and the other window's use starts the next.
    expect([c.observedMs, c.stretches]).toEqual([4 * MIN, 3])
    await disposeWorkspaceService(other)
    await disposeWorkspaceService(w)
  })

  it('history evicted for space is unavailable, not idle: observation before it goes, and reports say so', async () => {
    const { w, path } = await open()
    const saved = { ...metrics.METRICS_LIMITS }
    try {
      // The probe: a tiny cap, one request, a minute observed, saved.
      metrics.METRICS_LIMITS.fileBytes = 500
      metrics.recordApi(metrics.metricsHandle(w), null, api())
      at(1)
      cov(w)
      await metrics.flushMetrics()
      let r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 30 * MIN).toISOString() })
      expect(r.workspace!.api.length).toBe(0)
      expect(r.coverage.observedMs).toBe(0)
      expect(r.coverage.evictedThrough).toBe(new Date(T0 + MIN).toISOString())
      // A project's report says the same (the storage's fact), with no global loss count.
      const p = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' }, from: new Date(T0 - 30 * MIN).toISOString() })
      expect([p.coverage.evictedThrough, p.dropped]).toEqual([new Date(T0 + MIN).toISOString(), 0])
      Object.assign(metrics.METRICS_LIMITS, saved)
      // Observed again from then on; kept across a reopen.
      at(2)
      cov(w)
      await w.close()
      await metrics.flushMetrics()
      at(3)
      await w.open(path)
      r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 30 * MIN).toISOString() })
      expect([r.coverage.evictedThrough, r.coverage.observedMs]).toEqual([new Date(T0 + MIN).toISOString(), MIN])
      // Too many buckets: the oldest goes the same way.
      metrics.METRICS_LIMITS.buckets = 2
      for (let h = 1; h <= 3; h++) {
        now = T0 + h * HOUR
        metrics.recordApi(metrics.metricsHandle(w), null, api())
      }
      r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - HOUR).toISOString() })
      expect(r.coverage.evictedThrough).toBe(new Date(Math.floor((T0 + HOUR) / HOUR) * HOUR + HOUR).toISOString())
      // Reset: nothing evicted any more.
      metrics.resetMetrics(w)
      expect(metrics.queryMetrics(w, { scope: { kind: 'workspace' } }).coverage.evictedThrough).toBeUndefined()
    } finally {
      Object.assign(metrics.METRICS_LIMITS, saved)
      await disposeWorkspaceService(w)
    }
  })

  it("session history that can't be read makes provider usage partial or unknown, said by count only; it recovers", async () => {
    const { sessions } = await import('../src/main/sessions')
    const { metricsReport } = await import('../src/main/metricsUsage')
    const { w, path } = await open()
    for (const p of ['alpha', 'beta']) mkdirSync(join(path, p), { recursive: true })
    const when = new Date(T0 - HOUR).toISOString()
    const item = (id: string) => ({ id, provider: 'claude-code', source: 'hive', title: null, lastActivity: when, hasTranscript: true, hasBackup: false, usage: null, recache: null })
    const broken = new Set<string>()
    const orig = { usageItems: sessions.usageItems }
    ;(sessions as unknown as { usageItems: (p: string) => Promise<unknown[]> }).usageItems = async (p) => {
      if (broken.has(p.toLowerCase())) throw new Error(`EACCES ${p}`)
      return [item(p)]
    }
    try {
      const report = (scope: import('../src/shared/metrics').MetricsScope = { kind: 'workspace' }) => metricsReport(w, { scope })
      // One of three hosts unreadable: partial, with a count and no name.
      broken.add(join(path, 'beta').toLowerCase())
      let r = await report()
      expect([r.providersUnreadable, r.providersHosts]).toEqual([1, 3])
      expect(JSON.stringify(r)).not.toMatch(/EACCES|beta/)
      // The project itself unreadable: its report says so (its own only).
      r = await report({ kind: 'project', project: 'beta' })
      expect([r.providers, r.providersUnreadable, r.providersHosts]).toEqual([[], 1, 1])
      expect((await report({ kind: 'project', project: 'alpha' })).providersUnreadable).toBeUndefined()
      // Every host unreadable.
      broken.add(join(path, 'alpha').toLowerCase())
      broken.add(w.assistantHome.toLowerCase())
      r = await report()
      expect([r.providers, r.providersUnreadable, r.providersHosts]).toEqual([[], 3, 3])
      // Readable again: complete, nothing said.
      broken.clear()
      r = await report()
      expect([r.providersUnreadable, r.providers.reduce((n2, p) => n2 + p.sessions, 0)]).toEqual([undefined, 3])
    } finally {
      Object.assign(sessions, orig)
      await disposeWorkspaceService(w)
    }
  })
})

describe('HI-2049: launches and tool lists by workflow role', () => {
  const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR
  const write = (path: string, data: unknown) => {
    mkdirSync(join(path, '.combwork', 'metrics'), { recursive: true })
    writeFileSync(join(path, '.combwork', 'metrics', 'metrics.json'), JSON.stringify(data))
  }
  const launch = (workflow: 'builder' | 'reviewer' | 'either' | 'none') => ({ provider: 'claude-code', role: 'agent' as const, workflow, guidanceBytes: 100, guidanceChars: 100, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 1, skillCatalogBytes: 10, skillBytes: 20, skillsNotDelivered: 0, skillsUnmeasured: 0 })

  it('a launch carries its workflow role: builders’ and reviewers’ launches are series of their own', async () => {
    const { w } = await open()
    const h = metrics.metricsHandle(w)
    metrics.recordLaunch(h, 'alpha', launch('builder'))
    metrics.recordLaunch(h, 'alpha', launch('reviewer'))
    metrics.recordLaunch(h, 'alpha', launch('reviewer'))
    const g = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.guidance
    expect(g.map((s) => [s.workflow, s.launches]).sort()).toEqual([['builder', 1], ['reviewer', 2]])
    await disposeWorkspaceService(w)
  })

  it('HI-2443: launches on a dialect chain are a series of their own, kept by its hash; the Default has none', async () => {
    const { w } = await open()
    const h = metrics.metricsHandle(w)
    metrics.recordLaunch(h, 'alpha', launch('builder'))
    metrics.recordLaunch(h, 'alpha', { ...launch('builder'), dialect: '0123456789abcdef' })
    metrics.recordLaunch(h, 'alpha', { ...launch('builder'), dialect: '0123456789abcdef' })
    const g = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.guidance
    expect(g.map((s) => [s.dialect ?? null, s.launches]).sort()).toEqual([[null, 1], ['0123456789abcdef', 2]])
    expect(g.find((s) => !s.dialect)).not.toHaveProperty('dialect')
    await disposeWorkspaceService(w)
  })

  it("the tool list's characters, on its launch's side; a bridge from before sends bytes only, so its start has no characters", async () => {
    const { w } = await open()
    const h = metrics.metricsHandle(w)
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'reviewer', { tools: 40, toolsBytes: 9100, toolsChars: 9000 })).toBe(true)
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'reviewer', { tools: 40, toolsBytes: 9100 })).toBe(true)
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'builder', { tools: 42, toolsBytes: 9500, toolsChars: 9400 })).toBe(true)
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'unknown', { tools: 1, toolsBytes: 10, toolsChars: 10 })).toBe(true)
    for (const bad of [{ toolsChars: -1 }, { toolsChars: 1.5 }, { toolsChars: 'many' }]) expect(metrics.recordCatalog(h, 'alpha', 'agent', 'builder', { tools: 1, toolsBytes: 10, ...bad })).toBe(false)
    // A side Combwork doesn't record is unknown, never one it does.
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'boss' as never, { tools: 1, toolsBytes: 10, toolsChars: 10 })).toBe(true)
    const c = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.catalog
    const by = Object.fromEntries(c.map((s) => [s.workflow, s]))
    expect(by.reviewer).toMatchObject({ role: 'agent', starts: 2, toolsBytes: 18200, charStarts: 1, toolsChars: 9000 })
    expect(by.builder).toMatchObject({ starts: 1, charStarts: 1, toolsChars: 9400 })
    expect(by.unknown).toMatchObject({ starts: 2, charStarts: 2, toolsChars: 20 })
    await disposeWorkspaceService(w)
  })

  it('series saved before it: their role unknown and their tool lists without characters, merged with new ones apart', async () => {
    const { w, path } = await open()
    await w.close()
    const old = { provider: 'claude-code', role: 'agent', launches: 3, guidanceBytes: 300, guidanceChars: 300, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: 3, skillCatalogBytes: 30, skillBytes: 60, skillsNotDelivered: 0, skillsUnmeasured: 0 }
    const catalog = { a: { role: 'agent', starts: 2, tools: 80, toolsBytes: 18000 }, b: { role: 'agent', workflow: 'builder', starts: 1, tools: 40, toolsBytes: 9000, toolsChars: 8900, charStarts: 2 } }
    write(path, { version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { guidance: { g: old }, catalog } } }] })
    await w.open(path)
    metrics.recordLaunch(metrics.metricsHandle(w), 'alpha', launch('builder'))
    metrics.recordCatalog(metrics.metricsHandle(w), 'alpha', 'agent', 'builder', { tools: 40, toolsBytes: 9000, toolsChars: 8900 })
    const part = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' }, from: new Date(T0 - 2 * HOUR).toISOString() }).projects.alpha
    expect(part.guidance.map((s) => [s.workflow, s.launches]).sort()).toEqual([['builder', 1], ['unknown', 3]])
    // The old list counts its starts, none with characters; one with more starts of characters than starts isn't read.
    expect(part.catalog.map((s) => [s.workflow, s.starts, s.charStarts, s.toolsChars]).sort()).toEqual([['builder', 1, 1, 8900], ['unknown', 2, 0, 0]])
    await disposeWorkspaceService(w)
  })
})

describe("HI-2063: the tool list's parts", () => {
  const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR
  const write = (path: string, data: unknown) => {
    mkdirSync(join(path, '.combwork', 'metrics'), { recursive: true })
    writeFileSync(join(path, '.combwork', 'metrics', 'metrics.json'), JSON.stringify(data))
  }

  it('parts come both or neither, with the characters, and add up to no more than them', async () => {
    const { w } = await open()
    const h = metrics.metricsHandle(w)
    const ok = { tools: 40, toolsBytes: 10000, toolsChars: 9800 }
    for (const bad of [
      { ...ok, descriptionChars: 6000, paramChars: 4000 },
      { ...ok, descriptionChars: 5000 },
      { ...ok, paramChars: 3000 },
      { tools: 40, toolsBytes: 10000, descriptionChars: 1, paramChars: 1 },
      { ...ok, descriptionChars: -1, paramChars: 1 },
      { ...ok, descriptionChars: 1.5, paramChars: 1 },
      { ...ok, descriptionChars: 'many', paramChars: 1 },
      { ...ok, descriptionChars: null, paramChars: 1 }
    ])
      expect(metrics.recordCatalog(h, 'alpha', 'agent', 'builder', bad), JSON.stringify(bad)).toBe(false)
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha?.catalog ?? []).toEqual([])
    expect(metrics.recordCatalog(h, 'alpha', 'agent', 'builder', { ...ok, descriptionChars: 5000, paramChars: 4800 })).toBe(true)
    expect(metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' } }).projects.alpha.catalog[0]).toMatchObject({ starts: 1, charStarts: 1, partStarts: 1, partToolsChars: 9800, descriptionChars: 5000, paramChars: 4800 })
    await disposeWorkspaceService(w)
  })

  it('bytes-only, characters-only and parts-bearing starts each average over their own: saved, reloaded and merged', async () => {
    const { w, path } = await open()
    await w.close()
    // Saved earlier in the hour: a bridge from before HI-2049 (bytes only) and one from HI-2049 (characters, no parts).
    const saved = { a: { role: 'agent', starts: 2, tools: 80, toolsBytes: 20000 }, b: { role: 'agent', workflow: 'builder', starts: 1, tools: 40, toolsBytes: 10000, toolsChars: 9000, charStarts: 1 } }
    write(path, { version: 1, buckets: [{ start: hourOf(T0), span: 'hour', projects: { alpha: { catalog: saved } } }] })
    await w.open(path)
    const h = metrics.metricsHandle(w)
    // Now, two parts-bearing starts on the builder side, in the same bucket as the HI-2049 one.
    metrics.recordCatalog(h, 'alpha', 'agent', 'builder', { tools: 40, toolsBytes: 10200, toolsChars: 10000, descriptionChars: 4000, paramChars: 3000 })
    metrics.recordCatalog(h, 'beta', 'agent', 'builder', { tools: 40, toolsBytes: 12200, toolsChars: 12000, descriptionChars: 5000, paramChars: 4000 })
    await w.close()
    await metrics.flushMetrics()
    await w.open(path)
    const { toolListRows } = await import('../src/shared/metricsView')
    const r = metrics.queryMetrics(w, { scope: { kind: 'workspace' }, from: new Date(T0 - 2 * HOUR).toISOString() })
    const rows = toolListRows(Object.values(r.projects).flatMap((p) => p.catalog))
    const by = Object.fromEntries(rows.map((x) => [x.workflow, x]))
    // Characters over the three starts that had them; parts over the two that had parts, never diluted by the others.
    expect(by.builder).toMatchObject({ starts: 3, chars: (9000 + 10000 + 12000) / 3, descriptionChars: 4500, paramChars: 3500, schemaChars: (10000 + 12000 - 9000 - 7000) / 2 })
    // The bytes-only starts: tools and bytes known, characters and parts unknown, never zero.
    expect(by.unknown).toMatchObject({ starts: 2, tools: 40, bytes: 10000, chars: null, descriptionChars: null, paramChars: null, schemaChars: null })
    await disposeWorkspaceService(w)
  })

  it('a saved series whose parts are more than its characters, or than its starts, is not read', async () => {
    const { w, path } = await open()
    await w.close()
    const series = { role: 'agent', workflow: 'builder', starts: 2, tools: 80, toolsBytes: 20000, toolsChars: 19000, charStarts: 2 }
    const catalog = { over: { ...series, partStarts: 1, partToolsChars: 9000, descriptionChars: 6000, paramChars: 4000 }, more: { ...series, workflow: 'reviewer', partStarts: 3, partToolsChars: 9000, descriptionChars: 1, paramChars: 1 }, fine: { ...series, workflow: 'either', partStarts: 1, partToolsChars: 9000, descriptionChars: 5000, paramChars: 3000 } }
    write(path, { version: 1, buckets: [{ start: hourOf(T0) - HOUR, span: 'hour', projects: { alpha: { catalog } } }] })
    await w.open(path)
    const part = metrics.queryMetrics(w, { scope: { kind: 'project', project: 'alpha' }, from: new Date(T0 - 2 * HOUR).toISOString() }).projects.alpha
    expect(part.catalog.map((c) => c.workflow)).toEqual(['either'])
    await disposeWorkspaceService(w)
  })
})

describe('HI-2063: Copy Diagnostics says the tool list a start', () => {
  it('counts only, per role and workflow role; what was not measured is said, never zero', async () => {
    const { toolListLine } = await import('../src/main/diagnostics')
    const row = { role: 'agent' as const, workflow: 'builder' as const, starts: 3, tools: 98, bytes: 63000.4, chars: 61234.2, descriptionChars: 30120, paramChars: 12004, schemaChars: 19110 }
    expect(toolListLine('Workspace 1', [row, { ...row, role: 'assistant', workflow: 'none', starts: 1, chars: 70000, descriptionChars: null, paramChars: null, schemaChars: null }, { ...row, workflow: 'unknown', chars: null }])).toBe(
      '- Workspace 1 Combwork tool list (24 h): agents · builder: 98 tools, 61,234 chars a start (descriptions 30,120, parameters 12,004, schemas 19,110), 63,000 bytes, 3 starts; assistant · none: 98 tools, 70,000 chars a start (parts not measured), 63,000 bytes, 1 start; agents · unknown: 98 tools, characters not measured, 63,000 bytes, 3 starts'
    )
    expect(toolListLine('Workspace 2', [])).toBe('- Workspace 2 Combwork tool list (24 h): none recorded')
  })
})
