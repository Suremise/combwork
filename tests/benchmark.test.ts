// Comparing Combwork's costs (#117): scenario benchmarks and Performance exports read as untrusted input
// (src/shared/benchmark.ts), compared like with like (correctness first: a smaller result that fails, skips checks or
// fails more calls isn't better; what wasn't measured stays unknown), and kept per scope in the workspace
// (src/main/benchmarks.ts: bounded, committed before anything is evicted, bound to the workspace each operation started
// in). Fixtures in tests/fixtures/benchmarks come from a real fake-provider run: a baseline, an intentional reduction,
// and the same reduction that broke a check.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { BENCHMARK_LIMITS, EXPORT_MEASURES, SCENARIO_MEASURES, USAGE_MEASURES, aboutOf, compareArtifacts, compareScopeOf, exportMeasure, factsOf, keptAbout, keptLabel, parseArtifact, readEntry, readKept, sideMeasureLabel, summaryOf, type Artifact, type CompareScope, type KeptEntry, type ParseResult } from '../src/shared/benchmark'
import { englishText, shownText } from '../src/shared/advanced'
import { setLanguage } from '../src/shared/i18n'
import { tempDir } from './tempDir'

const require_ = createRequire(import.meta.url)
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'benchmarks', `${name}.json`), 'utf8')
const WS: CompareScope = { kind: 'workspace' }
const OWN: CompareScope = { kind: 'workspace', own: true }
const art = (r: ParseResult): Artifact => {
  if (!('artifact' in r)) throw new Error(JSON.stringify(r))
  return r.artifact
}
const bench = (name: string): Artifact => art(parseArtifact(fixture(name), WS))
/** A benchmark built from the baseline, changed by `fn` (on its JSON). */
const variant = (fn: (b: any) => void, from = 'baseline'): Artifact => {
  const b = JSON.parse(fixture(from))
  fn(b)
  return art(parseArtifact(JSON.stringify(b), WS))
}
const sampleOf = (b: any, id: string): any => b.scenarios.find((s: any) => s.id === id).samples[0]
const scenario = (c: ReturnType<typeof compareArtifacts>, id: string) => c.scenarios!.find((s) => s.id === id)!

describe('scenario benchmarks', () => {
  it('an intentional reduction is smaller and still correct; the same reduction that broke a check is smaller but failing', () => {
    const base = bench('baseline')
    const good = compareArtifacts(base, bench('smaller'))
    expect(good.comparable).toBe(true)
    expect(scenario(good, 'card-detail').status).toBe('better')
    expect(scenario(good, 'card-detail').measures.find((m) => m.key === 'toolChars')!.pct).toBeCloseTo(-0.4, 2)
    expect(scenario(good, 'work-on-card').status).toBe('better')
    expect(scenario(good, 'review-card').status).toBe('same')
    const bad = compareArtifacts(base, bench('smaller-wrong'))
    const cd = scenario(bad, 'card-detail')
    expect(cd.status).toBe('smaller-but-failing')
    expect(cd.regressions.map((r) => r.name)).toEqual(["its reply had the card's acceptance line"])
    expect(cd.failedChecks).toEqual(["its reply had the card's acceptance line"])
    expect(cd.checks.base).toEqual({ passed: 4, failed: 0, skipped: 1 })
    expect(cd.checks.run).toEqual({ passed: 3, failed: 1, skipped: 1 })
    expect(bad.summary['smaller-but-failing']).toBe(1)
    expect(Object.keys(compareArtifacts(base, base).summary)).toEqual(['same'])
  })

  it('correctness is checked check by check: all skipped is unknown; a check that stops running or passing is a regression', () => {
    const base = bench('baseline')
    const skipped = variant((b) => {
      const x = sampleOf(b, 'card-detail')
      Object.assign(x, { ok: true, passed: 0, failed: 0, skipped: 5, checks: x.checks.map((c: any) => ({ ...c, ok: null })) })
      x.measures.toolBytes = 10
    })
    const s = scenario(compareArtifacts(base, skipped), 'card-detail')
    expect(s.status).toBe('incomplete')
    expect(s.notes.join(' ')).toMatch(/no check ran/)
    const fewer = variant((b) => {
      const x = sampleOf(b, 'card-detail')
      const c = x.checks.find((y: any) => y.ok === true)
      c.ok = null
      x.passed -= 1
      x.skipped += 1
      x.measures.toolBytes = 10
    })
    const f = scenario(compareArtifacts(base, fewer), 'card-detail')
    expect([f.status, f.regressions.length]).toEqual(['smaller-but-failing', 1])
  })

  it('more failures, errors or retries are worse even when every check passes and it is smaller', () => {
    const base = bench('baseline')
    for (const [k, v] of [
      ['hiveCallErrors', 2],
      ['apiFailed', 2],
      ['toolErrors', 1],
      ['apiCancelled', 1],
      ['repeatedCalls', 2]
    ] as const) {
      const run = variant((b) => {
        const m = sampleOf(b, 'card-detail').measures
        m[k] = (m[k] ?? 0) + v
        m.toolBytes = 10
      })
      expect(scenario(compareArtifacts(base, run), 'card-detail').status, k).toBe('worse')
    }
  })

  it("a benchmark saved before 0.9.3 counts its persona's size as its mode's (#1084)", () => {
    const now = variant((b) => {
      const m = sampleOf(b, 'card-detail').measures
      m.modeBytes = 50
      m.modeChars = 40
    })
    const old = variant((b) => {
      const m = sampleOf(b, 'card-detail').measures
      delete m.modeBytes
      delete m.modeChars
      m.personaBytes = 50
      m.personaChars = 40
    })
    const measures = (a: Artifact) => a.scenarios!.find((x) => x.id === 'card-detail')!.samples[0].measures!
    expect(measures(old)).toEqual(measures(now))
    expect(measures(old)).toMatchObject({ modeBytes: 50, modeChars: 40 })
    expect(scenario(compareArtifacts(now, old), 'card-detail').status).toBe('same')
  })

  it('what wasn’t measured stays unknown: no zero-filled totals, no judgement on a partial measurement', () => {
    const base = bench('baseline')
    const missing = variant((b) => {
      const m = sampleOf(b, 'card-detail').measures
      for (const k of ['coreBytes', 'customBytes', 'roleBytes', 'modeBytes', 'catalogBytes', 'toolListBytes', 'toolBytes']) delete m[k]
    })
    const s = scenario(compareArtifacts(base, missing), 'card-detail')
    expect(s.measures.find((m) => m.key === 'contextBytes')).toMatchObject({ incomplete: true, delta: null })
    expect(missing.scenarios!.find((x) => x.id === 'card-detail')!.samples[0].measures!.contextBytes).toBeUndefined()
    expect(s.status).toBe('incomplete')
    for (const cov of [{ recording: false, dropped: 0, partial: ['recording was off'] }, { recording: true, dropped: 3, partial: ['3 measurements dropped'] }, { recording: null }]) {
      const partial = variant((b) => {
        const x = sampleOf(b, 'card-detail')
        x.coverage = cov
        x.measures.toolBytes = 10
      })
      const p = scenario(compareArtifacts(base, partial), 'card-detail')
      expect([p.status, p.notes.join(' ')]).toEqual(['incomplete', expect.stringMatching(/measured partly/)])
    }
  })

  it("isn't comparable across scenario versions, providers, a fake and a model, model setups, or a run whose source changed", () => {
    const base = bench('baseline')
    const why = (fn: (b: any) => void) => compareArtifacts(base, variant(fn))
    expect(why((b) => (b.run.fixturesVersion = 3)).reasons.join()).toMatch(/scenario versions/)
    expect(why((b) => ((b.run.provider = 'fake-codex'), (b.run.providerId = 'codex'))).reasons.join()).toMatch(/Different providers/)
    expect(why((b) => ((b.run.real = true), (b.run.provider = 'claude-code'))).reasons.join()).toMatch(/fake provider against a model/)
    expect(why((b) => (b.run.sourceChangedDuringRun = true)).reasons.join()).toMatch(/source changed while it ran/)
    const realA = variant((b) => Object.assign(b.run, { real: true, provider: 'codex', providerId: 'codex', model: 'gpt-a' }))
    const realB = variant((b) => Object.assign(b.run, { real: true, provider: 'codex', providerId: 'codex', model: 'gpt-b' }))
    expect(compareArtifacts(realA, realB).reasons.join()).toMatch(/model setups/)
    expect(compareArtifacts(base, art(parseArtifact(exportFile(), WS))).reasons.join()).toMatch(/measure different things/)
  })

  it('samples: spread, single samples, incomplete and stale ones left out (and said), only one side', () => {
    const three = (vals: number[], extra: (x: any, i: number) => void = () => undefined) =>
      variant((b) => {
        const sc = b.scenarios.find((s: any) => s.id === 'card-detail')
        sc.samples = vals.map((v, i) => {
          const x = JSON.parse(JSON.stringify(sc.samples[0]))
          x.measures.toolBytes = v
          extra(x, i)
          return x
        })
      })
    const d = scenario(compareArtifacts(three([600, 590, 610]), three([500, 640, 580])), 'card-detail')
    expect(d.measures.find((m) => m.key === 'contextBytes')!.withinSpread).toBe(true)
    expect(scenario(compareArtifacts(bench('baseline'), bench('smaller')), 'card-detail').notes.join()).toMatch(/One sample/)
    const mixed = three([600, 600, 600], (x, i) => {
      if (i === 1) Object.assign(x, { ok: null, incomplete: 'timed out' })
      if (i === 2) x.stale = true
    })
    const m = scenario(compareArtifacts(bench('baseline'), mixed), 'card-detail')
    expect(m.quality.run.n).toBe(1)
    expect(m.notes.join(' ')).toMatch(/timed out/)
    expect(m.notes.join(' ')).toMatch(/stale/)
    const none = three([1], (x) => Object.assign(x, { ok: null, incomplete: 'error' }))
    expect(scenario(compareArtifacts(bench('baseline'), none), 'card-detail').status).toBe('incomplete')
    const fewer = variant((b) => (b.scenarios = b.scenarios.filter((s: any) => s.id !== 'review-card')))
    expect(scenario(compareArtifacts(bench('baseline'), fewer), 'review-card').status).toBe('only-in-base')
  })

  it('provider usage: model trials only, every sample reporting it; cost only with a cost (≈ said); resumed left out; unknown stays unknown', () => {
    const withUsage = (cost: number | null, opts: { resumed?: boolean; reasoning?: number; estimated?: boolean; real?: boolean } = {}) =>
      variant((b) => {
        if (opts.real !== false) Object.assign(b.run, { real: true, provider: 'codex', providerId: 'codex', model: 'm' })
        for (const s of b.scenarios) {
          s.samples[0].resumed = !!opts.resumed
          s.samples[0].measures.usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0, requests: 3, ...(opts.reasoning !== undefined ? { reasoningTokens: opts.reasoning } : {}), ...(cost !== null ? { costUsd: cost } : {}), costEstimated: !!opts.estimated }
        }
      })
    const c = scenario(compareArtifacts(withUsage(0.01, { reasoning: 0 }), withUsage(0.02, { reasoning: 150, estimated: true })), 'card-detail')
    expect(c.usage!.map((u) => u.key)).toEqual(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'requests', 'costUsd'])
    expect(c.usage!.find((u) => u.key === 'outputTokens')!.delta).toBe(0)
    expect(c.notes.join(' ')).toMatch(/Combwork’s estimates/)
    expect(scenario(compareArtifacts(withUsage(0.01), withUsage(0.01, { reasoning: 5 })), 'card-detail').usage!.some((u) => u.key === 'reasoningTokens')).toBe(false)
    expect(scenario(compareArtifacts(withUsage(0.01), withUsage(null)), 'card-detail').usage!.some((u) => u.key === 'costUsd')).toBe(false)
    const resumed = scenario(compareArtifacts(withUsage(0.01), withUsage(0.01, { resumed: true })), 'card-detail')
    expect([resumed.usage, resumed.notes.join(' ')]).toEqual([null, expect.stringMatching(/resumed/)])
    const fakes = compareArtifacts(withUsage(0.01, { real: false }), withUsage(0.02, { real: false }))
    expect([scenario(fakes, 'card-detail').usage, fakes.notes.join(' ')]).toEqual([null, expect.stringMatching(/simulated/)])
  })

  it('reads a file as untrusted input: bounds, junk, escapes; a kept file is re-read into a fresh, bounded object', () => {
    expect(parseArtifact('{', WS)).toMatchObject({ error: expect.stringMatching(/JSON/) })
    expect(parseArtifact('{"schema":"other"}', WS)).toMatchObject({ error: expect.stringMatching(/isn’t a Combwork benchmark/) })
    const big = JSON.stringify({ schema: 'hive-benchmark/1', pad: '日'.repeat(BENCHMARK_LIMITS.fileBytes / 3 + 10) })
    expect(big.length).toBeLessThan(BENCHMARK_LIMITS.fileBytes)
    expect(parseArtifact(big, WS)).toMatchObject({ error: expect.stringMatching(/over 2 MB/) })
    const b = JSON.parse(fixture('baseline'))
    b.label = 'Ünïcödé "quoted" \\ 🐝\u0007 bell'
    b.scenarios.push({ id: '../../etc', title: 'bad id', samples: [] }, { id: 'card-detail', title: 'duplicate', samples: [] }, { id: 'broken', samples: 'broken' })
    b.scenarios[0].samples[0].measures.secretToken = 123
    b.scenarios[0].samples[0].measures.toolChars = -5
    b.scenarios[0].samples[0].failedChecks = Array.from({ length: 50 }, (_, i) => `check ${i} ${'x'.repeat(500)}`)
    const a = art(parseArtifact(JSON.stringify(b), WS))
    expect(a.label).toBe('Ünïcödé "quoted" \\ 🐝  bell')
    expect(a.scenarios!.map((s) => s.id)).toEqual(['work-on-card', 'review-card', 'card-detail', 'oversize-skill'])
    const m = a.scenarios![0].samples[0].measures!
    expect('secretToken' in m || 'toolChars' in m).toBe(false)
    expect(a.scenarios![0].samples[0].failedChecks.length).toBe(BENCHMARK_LIMITS.failedChecks)
    const kept = JSON.parse(JSON.stringify(a))
    kept.scenarios[1].samples = 'broken'
    kept.scenarios.push(...Array.from({ length: 150 }, (_, i) => ({ id: `extra-${i}`, samples: [] })))
    kept.extraField = 'x'
    const back = readKept(kept)!
    expect(back).not.toBe(kept)
    expect('extraField' in back).toBe(false)
    expect(back.scenarios!.length).toBeLessThanOrEqual(BENCHMARK_LIMITS.scenarios)
    expect(back.scenarios!.some((s) => s.id === 'review-card')).toBe(false)
    expect(readKept({ ...kept, scope: { kind: 'project', project: 'alpha' } })).toBeNull()
    expect(parseArtifact(fixture('baseline'), { kind: 'project', project: 'alpha' })).toMatchObject({ error: expect.stringMatching(/not one of your projects/) })
    expect(parseArtifact(fixture('baseline'), OWN)).toMatchObject({ error: expect.stringMatching(/not the workspace’s own work/) })
  })
})

/** A Performance export (hive-metrics/1) of a scope, as metrics:export writes it. */
function exportFile(opts: { scope?: any; sanitized?: boolean; own?: boolean; observedMs?: number; hours?: number; requests?: Record<string, number>; role?: string; dropped?: number; unattributed?: boolean; workspace?: number; brokenApi?: boolean } = {}): string {
  const hours = opts.hours ?? 24
  const to = Date.parse('2026-10-03T12:00:00Z')
  const from = to - hours * 3_600_000
  const api = (n: number) => (opts.brokenApi ? {} : [{ route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', count: n, totalMs: n, maxMs: 1, histogram: [], requestBytes: 0, responseBytes: n * 100 }])
  const part = (n: number) => ({ api: api(n), mcp: [{ tool: 'cw_list_tasks', role: 'agent', mode: 'compact', outcome: 'ok', count: n, totalMs: 0, maxMs: 0, histogram: [], chars: n * 50, bytes: n * 50 }], guidance: [{ provider: 'claude-code', role: 'agent', launches: 1, guidanceBytes: 1000, customBytes: 50, roleBytes: 0, modeBytes: 0, skillCatalogBytes: 300 }], catalog: [] })
  const reqs = opts.requests ?? { alpha: 10, beta: 20 }
  const scope = opts.scope ?? { kind: 'workspace' }
  const report = {
    scope,
    workspacePath: opts.sanitized ? '' : 'C:\\ws',
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    recording: true,
    filters: { ...(opts.own ? { own: true } : {}), ...(opts.role ? { role: opts.role } : {}), notFiltered: [] },
    coverage: { rangeMs: to - from, observedMs: opts.observedMs ?? to - from, observedSince: new Date(from).toISOString(), stretches: 1 },
    projects: Object.fromEntries(Object.entries(reqs).map(([k, n]) => [k, part(n)])),
    ...(scope.kind === 'workspace' || opts.workspace ? { workspace: part(opts.workspace ?? 5) } : {}),
    providers: [],
    notMeasured: [],
    dropped: opts.dropped ?? 0,
    ...(opts.unattributed ? { lossesUnattributed: true } : {})
  }
  return JSON.stringify({ schema: 'hive-metrics/1', app: { name: 'Hive', version: '0.3.1' }, exportedAt: new Date(to).toISOString(), sanitized: !!opts.sanitized, report })
}

describe('what Compare says about its measures', () => {
  it("calls the Assistant's working mode a mode, as the Performance page does (#358)", () => {
    for (const m of [...SCENARIO_MEASURES, ...USAGE_MEASURES, ...EXPORT_MEASURES]) expect(`${m.label.defaultMessage} ${m.tip.defaultMessage}`, m.key).not.toMatch(/persona/i)
    expect(SCENARIO_MEASURES.find((m) => m.key === 'contextBytes')?.tip.defaultMessage).toContain('the Assistant’s role and mode')
  })
})

describe('Performance exports', () => {
  it('compared per hour recorded, with the filters and coverage that make them comparable', () => {
    const a = art(parseArtifact(exportFile({ requests: { alpha: 24 } }), WS))
    const b = art(parseArtifact(exportFile({ requests: { alpha: 48 }, hours: 48 }), WS))
    const c = compareArtifacts(a, b)
    expect(c.comparable).toBe(true)
    expect(c.rows!.find((r) => r.key === 'requests')!.base!.mean).toBeCloseTo((24 + 5) / 24, 5)
    expect(c.rows!.find((r) => r.key === 'requests')!.run!.mean).toBeCloseTo((48 + 5) / 48, 5)
    expect(compareArtifacts(a, art(parseArtifact(exportFile({ role: 'api' }), WS))).reasons.join()).toMatch(/Different filters/)
    expect(compareArtifacts(a, art(parseArtifact(exportFile({ observedMs: 0 }), WS))).reasons.join()).toMatch(/wasn’t recording/)
    expect(compareArtifacts(a, art(parseArtifact(exportFile({ dropped: 3 }), WS))).notes.join()).toMatch(/partial: 3 measurements dropped/)
    // A series that isn't a list: its totals are unknown (said), not zero, and aren't compared.
    const broken = art(parseArtifact(exportFile({ brokenApi: true }), WS))
    expect([broken.summary!.totals.requests, broken.summary!.totals.toolChars]).toEqual([undefined, 30 * 50 + 5 * 50])
    expect(broken.summary!.partial.join()).toMatch(/weren’t valid, so requests, failed, responseBytes, requestBytes are unknown/)
    const vs = compareArtifacts(a, broken)
    expect(vs.rows!.find((r) => r.key === 'requests')).toMatchObject({ incomplete: true, delta: null })
    expect(vs.rows!.find((r) => r.key === 'toolChars')!.incomplete).toBe(false)
  })

  it('says its reasons, notes and refusals as text for the window, the English fields that text in English (#1104)', () => {
    const a = art(parseArtifact(exportFile({ requests: { alpha: 24 } }), WS))
    const dropped = art(parseArtifact(exportFile({ dropped: 3, role: 'api' }), WS))
    const c = compareArtifacts(a, dropped)
    expect([c.reasons, c.notes]).toEqual([c.reasonsText.map((t) => englishText(t)), c.notesText.map((t) => englishText(t))])
    expect(c.reasonsText.length && c.notesText.length).toBeGreaterThan(0)
    // What makes a summary partial is kept as data beside its English, and read back from a kept file; a summary kept
    // before has only the English, which is shown as it was.
    expect(dropped.summary!.partialWhy).toEqual([{ kind: 'dropped', n: 3 }])
    expect(readKept(JSON.parse(JSON.stringify(dropped)))!.summary!.partialWhy).toEqual([{ kind: 'dropped', n: 3 }])
    const old = JSON.parse(JSON.stringify(dropped))
    delete old.summary.partialWhy
    expect(compareArtifacts(a, readKept(old)!).notes.join()).toMatch(/run is partial: 3 measurements dropped \(a limit was full\)\./)
    old.summary.partialWhy = [{ kind: 'invalid', keys: ['notAMeasure'] }]
    expect(readKept(old)!.summary!.partialWhy).toBeUndefined()
    const refused = parseArtifact('{', WS)
    expect('errorText' in refused && englishText(refused.errorText!)).toBe('It isn’t JSON.')
    const s = scenario(compareArtifacts(bench('baseline'), variant((b) => (sampleOf(b, 'card-detail').ok = null))), 'card-detail')
    expect(s.notes).toEqual(s.notesText.map((t) => englishText(t)))
  })

  it("names and describes kept comparisons from their facts in the window's language, with the Who filter's roles and costs as it says them (#1104)", () => {
    const PL = join(__dirname, '..', 'locales', 'pl')
    const polish = (): Record<string, string> => Object.assign({}, ...readdirSync(PL).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(PL, f), 'utf8'))))
    const entryOf = (x: Artifact) => readEntry(JSON.parse(JSON.stringify({ id: '0123456789ab', label: x.label, kind: x.kind, scope: x.scope, createdAt: x.createdAt, keptAt: x.createdAt, pinned: false, about: aboutOf(x), facts: factsOf(x), labelKind: x.labelKind })))!
    const agents = art(parseArtifact(exportFile({ role: 'agent' }), WS))
    const scripts = art(parseArtifact(exportFile({ role: 'api' }), WS))
    const e = entryOf(agents)
    expect([e.labelKind, e.facts?.kind]).toEqual(['export', 'export'])
    const trial: KeptEntry = { ...e, kind: 'scenarios', labelKind: 'benchmark', facts: { kind: 'scenarios', real: true, provider: 'Claude Code', model: 'opus', effort: 'high', mode: 'auto', fixtures: 3, scenarios: 2, repeats: 1, head: 'abc1234', dirty: false, spentUsd: 1.23, unpriced: 0 } }
    expect(shownText(keptAbout(trial))).toBe('Model trial Claude Code opus (high, auto), fixtures v3, 2 scenarios × 1, source abc1234, spent $1.23')
    setLanguage('pl', polish(), 'pl-PL')
    try {
      // Combwork's name, its description and the reason two can't be compared: Polish, the roles as the Who filter names them.
      expect(shownText(keptLabel(e))).not.toMatch(/Export/)
      expect(shownText(keptAbout(e))).not.toMatch(/agent|all providers/)
      const reason = compareArtifacts(agents, scripts).reasonsText.map((t) => shownText(t)).join()
      expect(reason).not.toMatch(/\b(agent|api)\b/)
      expect(reason).toContain(polish()['performance.compare.filters.role.api'])
      // A model trial's cost in the language's currency format, not "$1.23".
      const about = shownText(keptAbout(trial))
      expect(about).not.toContain('$')
      expect(about).toContain('1,23')
    } finally {
      setLanguage('en', {})
    }
    // A name the user gave stays as written; an entry kept before facts shows its English; damaged facts are left out.
    expect(shownText(keptLabel({ ...e, labelKind: undefined }))).toBe(e.label)
    expect(shownText(keptAbout({ about: 'kept before', facts: undefined }))).toBe('kept before')
    expect(readEntry({ ...JSON.parse(JSON.stringify(e)), facts: { kind: 'export', from: 'x' } })).not.toHaveProperty('facts')
    // A kept file keeps the name's kind; a file that came with a name has none.
    expect(readKept(JSON.parse(JSON.stringify(agents)))!.labelKind).toBe('export')
    expect(variant((b) => (b.label = 'mine')).labelKind).toBeUndefined()
  })

  it('the own work is its own scope; a file that says it is own work but holds projects is refused', () => {
    const own = art(parseArtifact(exportFile({ own: true, requests: {} }), OWN))
    expect(own.scope).toEqual(OWN)
    expect(parseArtifact(exportFile({ own: true, requests: {} }), WS)).toMatchObject({ error: expect.stringMatching(/own work/) })
    expect(parseArtifact(exportFile(), OWN)).toMatchObject({ error: expect.stringMatching(/whole workspace’s/) })
    expect(parseArtifact(exportFile({ own: true, requests: { alpha: 3 } }), OWN)).toMatchObject({ error: expect.stringMatching(/holds projects’ data/) })
    expect(compareScopeOf({ kind: 'workspace' }, true)).toEqual(OWN)
    expect(compareArtifacts(own, art(parseArtifact(exportFile(), WS))).reasons.join()).toMatch(/Different scopes/)
  })

  it("a project's page: its own export (only its own data), or a workspace export's part for it only when asked", () => {
    const alpha: CompareScope = { kind: 'project', project: 'Alpha' }
    expect('artifact' in parseArtifact(exportFile({ scope: { kind: 'project', project: 'alpha' }, requests: { alpha: 3 } }), alpha)).toBe(true)
    expect(parseArtifact(exportFile({ scope: { kind: 'project', project: 'alpha' }, requests: { alpha: 10, beta: 500 } }), alpha)).toMatchObject({ error: expect.stringMatching(/also holds other projects’ data/) })
    expect(parseArtifact(exportFile({ scope: { kind: 'project', project: 'alpha' }, requests: { alpha: 10 }, workspace: 7 }), alpha)).toMatchObject({ error: expect.stringMatching(/workspace’s own data/) })
    expect(parseArtifact(exportFile({ scope: { kind: 'project', project: 'beta' }, requests: { beta: 3 } }), alpha)).toMatchObject({ error: expect.stringMatching(/beta’s export, not Alpha’s/) })
    expect(parseArtifact(exportFile(), alpha)).toEqual({ projectPart: { project: 'Alpha' } })
    const part = art(parseArtifact(exportFile(), alpha, { useProjectPart: true }))
    expect([part.scope, part.derived, part.summary!.totals.requests]).toEqual([alpha, expect.stringMatching(/one project’s part/), 10])
    expect(parseArtifact(exportFile({ sanitized: true }), alpha)).toMatchObject({ error: expect.stringMatching(/sanitized/) })
    expect(parseArtifact(exportFile({ own: true }), alpha)).toMatchObject({ error: expect.stringMatching(/own work/) })
    expect(parseArtifact(exportFile({ requests: { beta: 1 } }), alpha)).toMatchObject({ error: expect.stringMatching(/no part for Alpha/) })
    expect(parseArtifact(exportFile({ scope: { kind: 'project', project: 'alpha' } }), WS)).toMatchObject({ error: expect.stringMatching(/compare it on that project’s page/) })
  })

  it('a summary of a report: totals of its parts, guidance in parts, what makes it partial', () => {
    const r = JSON.parse(exportFile({ unattributed: true, requests: { alpha: 2 } })).report
    const s = summaryOf(r)
    expect(s.totals).toMatchObject({ requests: 7, toolChars: 350, launches: 2, guidanceBytes: 2 * 1350 })
    expect(s.partial.join()).toMatch(/attributed/)
  })
})

describe('HI-2049: Performance exports by workflow role', () => {
  const guidance = (workflow: string | undefined, launches: number, bytes: number) => ({ provider: 'claude-code', role: 'agent', ...(workflow ? { workflow } : {}), launches, guidanceBytes: bytes, customBytes: 0, roleBytes: 0, modeBytes: 0, skillCatalogBytes: 0 })
  /** An export whose only project has these launches and tool lists (the rest of its parts as exportFile makes them). */
  const withLaunches = (g: object[], catalog: object[]): Artifact => {
    const f = JSON.parse(exportFile({ requests: { alpha: 10 } }))
    f.report.projects.alpha.guidance = g
    f.report.projects.alpha.catalog = catalog
    f.report.workspace.guidance = []
    return art(parseArtifact(JSON.stringify(f), WS))
  }
  const row = (c: ReturnType<typeof compareArtifacts>, key: string) => c.rows!.find((r) => r.key === key)

  it("a summary keeps each role's launches, guidance and tool lists; launches recorded before it are the role not recorded", () => {
    const a = withLaunches([guidance('builder', 4, 4000), guidance('reviewer', 2, 3000), guidance(undefined, 1, 900)], [{ role: 'agent', workflow: 'builder', starts: 4, tools: 160, toolsBytes: 40400, toolsChars: 40000, charStarts: 4 }, { role: 'agent', workflow: 'reviewer', starts: 2, tools: 80, toolsBytes: 20000, toolsChars: 19800, charStarts: 2 }])
    expect(a.summary!.totals).toMatchObject({ launches: 7, 'launches.builder': 4, 'launches.reviewer': 2, 'launches.unknown': 1, 'guidanceBytes.builder': 4000, 'guidanceBytes.reviewer': 3000, toolListStarts: 6, toolListChars: 59800, 'toolListChars.builder': 40000, 'toolListStarts.reviewer': 2 })
  })

  it('Compare shows each role’s launches, guidance a launch and tool list a launch, only for roles either side has', () => {
    const a = withLaunches([guidance('builder', 4, 4000), guidance('reviewer', 2, 3000)], [{ role: 'agent', workflow: 'builder', starts: 4, tools: 160, toolsBytes: 40400, toolsChars: 40000, charStarts: 4 }, { role: 'agent', workflow: 'reviewer', starts: 2, tools: 80, toolsBytes: 20000, toolsChars: 20000, charStarts: 2 }])
    const b = withLaunches([guidance('builder', 4, 3600), guidance('reviewer', 2, 3000)], [{ role: 'agent', workflow: 'builder', starts: 4, tools: 160, toolsBytes: 36400, toolsChars: 36000, charStarts: 4 }, { role: 'agent', workflow: 'reviewer', starts: 2, tools: 80, toolsBytes: 20000, toolsChars: 20000, charStarts: 2 }])
    const c = compareArtifacts(a, b)
    expect(c.comparable).toBe(true)
    expect(row(c, 'guidancePerLaunch.builder')).toMatchObject({ base: { mean: 1000 }, run: { mean: 900 }, delta: -100 })
    expect(row(c, 'toolListPerLaunch.builder')).toMatchObject({ base: { mean: 10000 }, run: { mean: 9000 } })
    expect(row(c, 'toolListPerLaunch.reviewer')).toMatchObject({ base: { mean: 10000 }, run: { mean: 10000 }, delta: 0 })
    expect(row(c, 'toolListPerLaunch')).toMatchObject({ base: { mean: 60000 / 6 }, run: { mean: 56000 / 6 } })
    expect(row(c, 'launches.reviewer')).toMatchObject({ delta: 0 })
    expect(c.rows!.some((r) => r.key.endsWith('.either') || r.key.endsWith('.none') || r.key.endsWith('.unknown'))).toBe(false)
    // Each row's measure, and the role it is for, for the window.
    expect(exportMeasure('toolListPerLaunch.reviewer')).toMatchObject({ def: { key: 'toolListPerLaunch', unit: 'chars' }, side: 'reviewer' })
    expect(exportMeasure('requests.reviewer')).toBeUndefined()
    expect(englishText(sideMeasureLabel('Guidance a launch', 'none'))).toBe('Guidance a launch · no workflow role')
  })

  it("a tool list's characters average over the starts that had them: one from before, bytes only, isn't a zero", () => {
    const mixed = withLaunches([guidance('builder', 3, 3000)], [{ role: 'agent', workflow: 'builder', starts: 3, tools: 120, toolsBytes: 30300, toolsChars: 10000, charStarts: 1 }, { role: 'agent', starts: 5, tools: 200, toolsBytes: 50000 }])
    expect(mixed.summary!.totals).toMatchObject({ toolListStarts: 1, toolListChars: 10000, 'toolListStarts.builder': 1 })
    expect(mixed.summary!.totals['toolListStarts.unknown']).toBe(0)
    const c = compareArtifacts(mixed, mixed)
    expect(row(c, 'toolListPerLaunch')).toMatchObject({ base: { mean: 10000 } })
    expect(row(c, 'toolListPerLaunch.builder')).toMatchObject({ base: { mean: 10000 } })
    // Only bytes on both sides: no value, not zero.
    const old = withLaunches([guidance(undefined, 2, 2000)], [{ role: 'agent', starts: 2, tools: 80, toolsBytes: 20000 }])
    expect(row(compareArtifacts(old, old), 'toolListPerLaunch')).toMatchObject({ base: null, run: null, delta: null })
  })

  it('a summary kept before it has none of these: its rows are unknown, never zero', () => {
    const now = withLaunches([guidance('builder', 4, 4000)], [{ role: 'agent', workflow: 'builder', starts: 4, tools: 160, toolsBytes: 40400, toolsChars: 40000, charStarts: 4 }])
    const kept = JSON.parse(JSON.stringify(now))
    kept.summary.totals = Object.fromEntries(Object.entries(kept.summary.totals).filter(([k]) => !k.includes('.') && !k.startsWith('toolList')))
    const before = readKept(kept)!
    const c = compareArtifacts(before, now)
    for (const k of ['toolListPerLaunch', 'launches.builder', 'guidancePerLaunch.builder', 'toolListPerLaunch.builder']) expect(row(c, k), k).toMatchObject({ incomplete: true, delta: null })
    expect(row(c, 'guidancePerLaunch')).toMatchObject({ incomplete: false, delta: 0 })
  })
})

describe('the scenario harness writes what the app reads (tests/scenarios/benchmark.cjs)', () => {
  const { benchmarkOf, pruneResults, saveBaseline, resultsFolder, measuresOf, LIMITS } = require_('./scenarios/benchmark.cjs')
  const meta = { fixturesVersion: 5, provider: 'fake-codex', model: '(default)', effort: '(default)', mode: 'full-access', repeats: 2, source: { head: 'abc1234', dirty: null }, guidance: 'g1', when: '2026-10-03T12:00:00.000Z', spentUsd: 0, budgetUsd: 2 }
  /** A metrics report as GET /v1/metrics answers, with `n` of each thing (and the harness's own role-api requests). */
  const report = (n: number) => ({ projects: { alpha: { api: [{ role: 'agent', outcome: 'ok', count: n, requestBytes: n, responseBytes: n * 10, totalMs: n }, { role: 'api', outcome: 'ok', count: 100, requestBytes: 1, responseBytes: 1, totalMs: 1 }], mcp: [{ mode: 'compact', outcome: 'ok', count: n, chars: n * 5, bytes: n * 6, totalMs: 1 }], guidance: [{ launches: n ? 1 : 0, guidanceBytes: n * 100, guidanceChars: n * 90, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skillCatalogBytes: n * 20, skillBytes: n * 1000, skills: 8, skillsNotDelivered: 0, skillsUnmeasured: 0 }], catalog: [{ starts: n ? 1 : 0, toolsBytes: n * 50 }] } }, workspace: { api: [], mcp: [], guidance: [], catalog: [] }, skills: { scans: { count: n }, hits: n, misses: 0, invalidations: 0, bytes: 0, tooLarge: 0 }, dropped: 0, recording: true })
  const result = (id: string, sample: number, extra: object = {}) => ({
    scenario: id,
    title: `Café “${id}” 🐝`,
    role: 'agent',
    sample,
    seconds: 10,
    cliVersion: '0.160.0',
    checks: [
      { name: 'ünïcode "check" 🐝', ok: true },
      { name: 'b', ok: true },
      { name: 'only a model', ok: null }
    ],
    measures: measuresOf(report(0), report(2), { hiveCalls: [{ tool: 'cw_read_task', ok: true, args: '{"number":1}' }], skillsRead: ['work-on-card'] }, null),
    coverage: { recording: true, dropped: 0, partial: [] },
    guidance: { atStart: { revision: 'g1' }, delivered: { guidance: 'g1', skills: { 'work-on-card': 'rev-a' } } },
    metricsOverheadMs: 12,
    ...extra
  })

  it("the tool list's characters only when every start in the scenario had them (HI-2049): else unknown", () => {
    const withLists = (n: number, catalog: object[]) => ({ ...report(n), projects: { alpha: { ...report(n).projects.alpha, catalog } } })
    const all = measuresOf(withLists(0, []), withLists(1, [{ starts: 2, toolsBytes: 200, toolsChars: 190, charStarts: 2 }]), {}, null)
    expect(all).toMatchObject({ toolListBytes: 200, toolListChars: 190 })
    expect(all).not.toHaveProperty('toolListCharStarts')
    const some = measuresOf(withLists(0, []), withLists(1, [{ starts: 2, toolsBytes: 200, toolsChars: 95, charStarts: 1 }]), {}, null)
    expect(some.toolListBytes).toBe(200)
    expect(some).not.toHaveProperty('toolListChars')
  })

  it('the measures leave out the harness’s own requests; its artifact parses, with checks, coverage, revisions and Unicode intact', () => {
    const m = result('one', 1).measures
    expect([m.apiRequests, m.toolChars, m.coreChars, m.catalogBytes, m.usage]).toEqual([2, 10, 180, 40, null])
    const results = [
      result('one', 1),
      result('two', 1, { error: 'Error: ENOENT C:\\Users\\Someone\\secret\\file.json missing\n at stack' }),
      result('one', 2),
      result('two', 2, { checks: [{ name: 'a', ok: false }] }),
      result('three', 1, { checks: [{ name: 'a', ok: null }] }),
      result('four', 1, { staleGuidance: true }),
      result('five', 1, { resumed: true, measures: { ...result('five', 1).measures, usage: { inputTokens: 5, outputTokens: 1, requests: 1 } } }),
      result('six', 1, { guidance: { atStart: { revision: 'g1' }, delivered: { guidance: 'g1', skills: { 'work-on-card': 'rev-b' } } } })
    ]
    const file = benchmarkOf(meta, results, '0.3.1')
    expect(JSON.stringify(file)).not.toMatch(/Someone|secret|at stack/)
    const a = art(parseArtifact(JSON.stringify(file), WS))
    const s1 = a.scenarios!.find((s) => s.id === 'one')!.samples[0]
    expect([s1.ok, s1.passed, s1.skipped, s1.checks[0].name, s1.coverage.recording, s1.skills]).toEqual([true, 2, 1, 'ünïcode "check" 🐝', true, { 'work-on-card': 'rev-a' }])
    expect(a.scenarios![0].title).toBe('Café “one” 🐝')
    expect(s1.measures).toMatchObject({ guidanceBytes: 240, contextBytes: 240 + 100 + 12 })
    expect(a.scenarios!.find((s) => s.id === 'two')!.samples[0]).toMatchObject({ ok: null, incomplete: expect.stringContaining('<path>') })
    expect(a.scenarios!.find((s) => s.id === 'three')!.samples[0]).toMatchObject({ ok: null, incomplete: 'no check ran' })
    expect(a.scenarios!.find((s) => s.id === 'four')!.samples[0].stale).toBe(true)
    expect(a.scenarios!.find((s) => s.id === 'five')!.samples[0]).toMatchObject({ resumed: true, usage: null })
    const edited = art(parseArtifact(JSON.stringify(benchmarkOf(meta, results.map((r) => (r.scenario === 'six' ? { ...r, guidance: { atStart: { revision: 'g1' }, delivered: { guidance: 'g1', skills: { 'work-on-card': 'rev-a' } } } } : r)), '0.3.1')), WS))
    expect(scenario(compareArtifacts(edited, a), 'six').notes.join(' ')).toMatch(/different skill revisions \(work-on-card\)/)
    expect(benchmarkOf(meta, Array.from({ length: 30 }, (_, i) => result('one', i)), '0.3.1').scenarios[0].samples.length).toBe(LIMITS.samples)
  })

  it('records a scenario’s observations in its sample, never as checks: a false one leaves it passed (#1611)', () => {
    const observed = result('seven', 1, { observations: [{ name: 'read the coordinate-agents skill', value: false, detail: '' }] })
    const sample = benchmarkOf(meta, [observed], '0.3.1').scenarios[0].samples[0]
    expect([sample.ok, sample.passed, sample.failed, sample.observations]).toEqual([true, 2, 0, [{ name: 'read the coordinate-agents skill', value: false }]])
    expect(art(parseArtifact(JSON.stringify(benchmarkOf(meta, [observed], '0.3.1')), WS)).scenarios![0].samples[0].ok).toBe(true)
    expect(benchmarkOf(meta, [result('seven', 1)], '0.3.1').scenarios[0].samples[0]).not.toHaveProperty('observations')
  })

  it('keeps the newest runs in folders of their own; never overwrites a baseline, even saved three times in a second', () => {
    const dir = tempDir('hive-results-')
    try {
      for (let i = 0; i < 35; i++) mkdirSync(join(dir, `2026-10-${String((i % 28) + 1).padStart(2, '0')}T${String(i).padStart(2, '0')}-00-00-fake`), { recursive: true })
      pruneResults(dir, 30)
      expect(readdirSync(dir).length).toBe(30)
      expect(resultsFolder(dir, '2026-10-03T12-00-00-fake')).not.toBe(resultsFolder(dir, '2026-10-03T12-00-00-fake'))
      const baselines = join(dir, 'baselines')
      const src = join(dir, 'b.json')
      for (let i = 0; i < 3; i++) {
        writeFileSync(src, JSON.stringify({ createdAt: '2026-10-03T00:00:00.000Z', i }))
        saveBaseline(baselines, 'same', src)
      }
      const files = readdirSync(baselines).sort()
      expect(files).toEqual(['same.2026-10-03T00-00-00-2.json', 'same.2026-10-03T00-00-00.json', 'same.json'])
      expect(JSON.parse(readFileSync(join(baselines, 'same.json'), 'utf8')).i).toBe(2)
      expect(new Set(files.map((f) => JSON.parse(readFileSync(join(baselines, f), 'utf8')).i))).toEqual(new Set([0, 1, 2]))
      for (let i = 0; i < 8; i++) {
        writeFileSync(src, JSON.stringify({ createdAt: `2026-10-0${i + 1}T00:00:00.000Z`, i }))
        saveBaseline(baselines, 'many', src)
      }
      expect(readdirSync(baselines).filter((f) => f.startsWith('many.') && f !== 'many.json').length).toBe(LIMITS.baselinesKept)
      expect(() => saveBaseline(baselines, 'same', join(dir, 'missing.json'))).toThrow()
      expect(JSON.parse(readFileSync(join(baselines, 'same.json'), 'utf8')).i).toBe(2)
      expect(() => saveBaseline(baselines, '../escape', src)).toThrow(/baseline name/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never prunes a results folder a live runner holds, nor counts it; a dead runner's goes by age (HI-2234)", () => {
    const { resultsHeld, releaseResults } = require_('./scenarios/benchmark.cjs')
    const dir = tempDir('hive-results-held-')
    try {
      // The oldest run is still going (pid 101, alive), as HI-2190's two-hour Codex trials were; then 40 short runs.
      const running = resultsFolder(dir, '2026-10-31T14-27-32-codex', 101)
      const finished = resultsFolder(dir, '2026-10-31T14-28-00-fake', 202)
      for (let i = 0; i < 40; i++) mkdirSync(join(dir, `2026-10-31T15-${String(i).padStart(2, '0')}-00-fake`))
      const alive = (pid: number) => pid === 101
      expect(resultsHeld(running, alive)).toBe(true)
      expect(resultsHeld(finished, alive)).toBe(false)
      pruneResults(dir, 29, () => null, alive)
      const left = readdirSync(dir).sort()
      // The held folder stays besides the newest 29; the dead runner's folder went with the other older ones.
      expect(left).toHaveLength(30)
      expect(left[0]).toBe('2026-10-31T14-27-32-codex')
      expect(left).not.toContain('2026-10-31T14-28-00-fake')
      // Let go (the run ended), it counts with the model trials (HI-2236): the only one, so it stays.
      releaseResults(running)
      expect(resultsHeld(running, alive)).toBe(false)
      pruneResults(dir, 29, () => null, alive)
      expect(readdirSync(dir)).toContain('2026-10-31T14-27-32-codex')
      expect(readdirSync(dir)).toHaveLength(30)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the newest fake runs and, counted apart, the newest model trials: fake runs never push a paid one out (HI-2236)', () => {
    const { resultsKind } = require_('./scenarios/benchmark.cjs')
    expect(['fake', 'fake-codex', 'fake-copilot', 'fake-2', 'fake-codex-3'].map((p) => resultsKind(`2026-10-31T14-27-32-${p}`))).toEqual(['fake', 'fake', 'fake', 'fake', 'fake'])
    expect(['codex', 'claude-code', 'copilot', 'codex-2'].map((p) => resultsKind(`2026-10-31T14-27-32-${p}`))).toEqual(['model', 'model', 'model', 'model'])
    const dir = tempDir('hive-results-kinds-')
    try {
      const at = (h: number, m: number) => `2026-10-31T${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-00`
      // A finished model trial, then 40 fake runs of each fake provider in turn after it.
      mkdirSync(join(dir, `${at(14, 27)}-codex`))
      const fakes = ['fake', 'fake-codex', 'fake-copilot']
      for (let i = 0; i < 40; i++) mkdirSync(join(dir, `${at(15 + Math.floor(i / 60), i % 60)}-${fakes[i % 3]}`))
      pruneResults(dir)
      const left = readdirSync(dir).sort()
      expect(left).toContain(`${at(14, 27)}-codex`)
      expect(left.filter((n) => resultsKind(n) === 'fake')).toEqual(left.filter((n) => n.includes('-fake')).slice(-LIMITS.resultsKept))
      expect(left).toHaveLength(LIMITS.resultsKept + 1)
      // Model trials beyond their own 30 go oldest first, the fake runs untouched.
      for (let i = 0; i < 32; i++) mkdirSync(join(dir, `${at(16 + Math.floor(i / 60), i % 60)}-${i % 2 ? 'claude-code' : 'codex'}`))
      pruneResults(dir)
      const after = readdirSync(dir).sort()
      const models = after.filter((n) => resultsKind(n) === 'model')
      expect(models).toHaveLength(LIMITS.resultsKept)
      expect(models[0]).toBe(`${at(16, 2)}-codex`)
      expect(after.filter((n) => resultsKind(n) === 'fake')).toEqual(left.filter((n) => resultsKind(n) === 'fake'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a run whose results folder is removed under it makes it again with everything it had written (HI-2234)', () => {
    const { writeResults, resultsHeld } = require_('./scenarios/benchmark.cjs')
    const dir = tempDir('hive-results-gone-')
    try {
      const out = resultsFolder(dir, '2026-10-31T14-27-32-codex')
      const written = new Map<string, string>()
      let said = 0
      const save = (name: string, data: string) => {
        writeResults(out, name, data, {
          rewrite: () => {
            for (const [n, d] of written) writeFileSync(join(out, n), d)
          },
          onRecreated: () => said++
        })
        written.set(name, data)
      }
      save('results.json', '{"results":[1]}')
      save('notes.md', 'kept')
      rmSync(out, { recursive: true, force: true })
      save('results.json', '{"results":[1,2]}')
      expect(said).toBe(1)
      expect(readFileSync(join(out, 'results.json'), 'utf8')).toBe('{"results":[1,2]}')
      expect(readFileSync(join(out, 'notes.md'), 'utf8')).toBe('kept')
      // Held again, so no other run's prune takes it.
      expect(resultsHeld(out)).toBe(true)
      save('summary.md', 'done')
      expect(said).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a results folder removed as the write is made, or during the recovery, is made again; only ENOENT is retried, a bounded number of times (HI-2234)', () => {
    const { writeResults, resultsHeld, WRITE_ATTEMPTS } = require_('./scenarios/benchmark.cjs')
    const dir = tempDir('hive-results-race-')
    try {
      const out = resultsFolder(dir, '2026-10-31T14-27-32-codex')
      writeFileSync(join(out, 'results.json'), 'old')
      const files = () => readdirSync(out).sort()
      // Removed between the folder being there and the write landing: the first write meets ENOENT.
      let removals = 1
      let said = 0
      const racing = (p: string, d: string) => {
        if (removals-- > 0) rmSync(out, { recursive: true, force: true })
        writeFileSync(p, d)
      }
      const rewrite = () => writeFileSync(join(out, 'results.json'), 'old')
      writeResults(out, 'summary.md', 'new', { rewrite, onRecreated: () => said++, write: racing })
      expect([files(), said, resultsHeld(out)]).toEqual([['results.json', 'runner.json', 'summary.md'], 1, true])
      expect(readFileSync(join(out, 'summary.md'), 'utf8')).toBe('new')

      // Removed again while the recovery puts the earlier files back: it starts over, and writes only once all are back.
      rmSync(out, { recursive: true, force: true })
      let duringRewrite = 1
      said = 0
      const interrupted = () => {
        if (duringRewrite-- > 0) rmSync(out, { recursive: true, force: true })
        rewrite()
      }
      writeResults(out, 'summary.md', 'newer', { rewrite: interrupted, onRecreated: () => said++ })
      expect([files(), said]).toEqual([['results.json', 'runner.json', 'summary.md'], 2])
      expect(readFileSync(join(out, 'results.json'), 'utf8')).toBe('old')

      // Any other error is thrown at once, with no recovery.
      said = 0
      const denied = () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      }
      expect(() => writeResults(out, 'summary.md', 'x', { rewrite, onRecreated: () => said++, write: denied })).toThrow(/denied/)
      expect(said).toBe(0)

      // A folder that keeps going is given up on after WRITE_ATTEMPTS writes, with the ENOENT.
      let writes = 0
      const alwaysGone = (p: string, d: string) => {
        writes++
        rmSync(out, { recursive: true, force: true })
        writeFileSync(p, d)
      }
      expect(() => writeResults(out, 'summary.md', 'x', { rewrite, write: alwaysGone })).toThrow(expect.objectContaining({ code: 'ENOENT' }))
      expect(writes).toBe(WRITE_ATTEMPTS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('kept comparisons (main/benchmarks.ts)', async () => {
  const base = tempDir('hive-bench-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
  const kept = await import('../src/main/benchmarks')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(join(path, 'alpha'), { recursive: true })
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, ctx: () => kept.benchContext(w), dir: join(path, '.combwork', 'metrics', 'benchmarks') }
  }
  const file = (name: string, textValue: string): string => {
    const f = join(base, `${name}-${++n}.json`)
    writeFileSync(f, textValue)
    return f
  }
  const entryOf = (r: any) => {
    if (!('entry' in r)) throw new Error(JSON.stringify(r))
    return r.entry
  }

  it('imports, lists by scope, reads, selects, pins and removes; a project sees only its own; own work is its own', async () => {
    const { w, ctx } = await open()
    const alpha: CompareScope = { kind: 'project', project: 'alpha' }
    const a = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    const b = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('s', fixture('smaller')) }))
    expect((await kept.listBenchmarks(ctx(), WS)).entries.map((e) => e.id)).toEqual([b.id, a.id])
    expect((await kept.listBenchmarks(ctx(), alpha)).entries).toEqual([])
    expect((await kept.listBenchmarks(ctx(), OWN)).entries).toEqual([])
    await expect(kept.readBenchmark(ctx(), alpha, a.id)).rejects.toThrow(/for this scope/)
    await expect(kept.readBenchmark(ctx(), OWN, a.id)).rejects.toThrow(/for this scope/)
    const ask = await kept.importBenchmark(ctx(), alpha, { path: file('e', exportFile()) })
    if (!('ask' in ask)) throw new Error(JSON.stringify(ask))
    expect(await kept.importBenchmark(ctx(), WS, { token: ask.ask.token, useProjectPart: true })).toMatchObject({ error: expect.stringMatching(/no longer waiting/) })
    const ask2 = await kept.importBenchmark(ctx(), alpha, { path: file('e', exportFile()) })
    if (!('ask' in ask2)) throw new Error('no ask')
    const part = entryOf(await kept.importBenchmark(ctx(), alpha, { token: ask2.ask.token, useProjectPart: true }))
    expect(await kept.importBenchmark(ctx(), alpha, { token: ask2.ask.token, useProjectPart: true })).toMatchObject({ error: expect.stringMatching(/no longer waiting/) })
    await kept.selectBenchmarks(ctx(), WS, a.id, b.id)
    await kept.selectBenchmarks(ctx(), alpha, a.id, part.id)
    expect(await kept.listBenchmarks(ctx(), WS)).toMatchObject({ base: a.id, run: b.id })
    expect(await kept.listBenchmarks(ctx(), alpha)).toMatchObject({ base: null, run: part.id })
    expect(scenario(compareArtifacts(await kept.readBenchmark(ctx(), WS, a.id), await kept.readBenchmark(ctx(), WS, b.id)), 'card-detail').status).toBe('better')
    await kept.removeBenchmark(ctx(), alpha, a.id)
    expect((await kept.listBenchmarks(ctx(), WS)).entries.length).toBe(2)
    await kept.removeBenchmark(ctx(), WS, a.id)
    expect((await kept.listBenchmarks(ctx(), WS)).entries.map((e) => e.id)).toEqual([b.id])
    await disposeWorkspaceService(w)
  })

  it("comparisons kept before facts (#1104) get them from their files when listed, once: described in the window's language, names as they were", async () => {
    const { w, ctx, dir } = await open()
    const trial = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    const agents = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('e', exportFile({ role: 'agent' })) }))
    // As the version before wrote them: no facts in the index, no name kind in the index or the files.
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
    for (const e of index.entries) {
      delete e.facts
      delete e.labelKind
    }
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index))
    for (const id of [trial.id, agents.id]) {
      const a = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
      delete a.labelKind
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(a))
    }
    const listed = (await kept.listBenchmarks(ctx(), WS)).entries
    const byId = (id: string) => listed.find((e) => e.id === id)!
    expect([byId(trial.id).facts?.kind, byId(agents.id).facts?.kind]).toEqual(['scenarios', 'export'])
    expect(listed.map((e) => [e.label, e.labelKind])).toEqual([[agents.label, undefined], [trial.label, undefined]])
    // Written to the index once, so the next list reads no file.
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.every((e: any) => e.facts)).toBe(true)
    const PL = join(__dirname, '..', 'locales', 'pl')
    setLanguage('pl', Object.assign({}, ...readdirSync(PL).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(PL, f), 'utf8')))), 'pl-PL')
    try {
      expect(shownText(keptAbout(byId(agents.id)))).not.toMatch(/ to |agent|all providers/)
      expect(shownText(keptAbout(byId(trial.id)))).not.toMatch(/Fake|scenarios|source/)
    } finally {
      setLanguage('en', {})
    }
    await disposeWorkspaceService(w)
  })

  it('an operation bound to a workspace that closed or switched is refused, never written into the next one', async () => {
    const A = await open()
    const B = join(base, `ws-${++n}`)
    mkdirSync(B, { recursive: true })
    const ctxA = A.ctx()
    const ask = await kept.importBenchmark(ctxA, { kind: 'project', project: 'alpha' }, { path: file('e', exportFile()) })
    // The window switches to B while A's dialog (or read) is still out.
    await A.w.close()
    await A.w.open(B)
    await expect(kept.importBenchmark(ctxA, WS, { path: file('b', fixture('baseline')) })).rejects.toThrow(/closed or switched/)
    await expect(kept.listBenchmarks(ctxA, WS)).rejects.toThrow(/closed or switched/)
    await expect(kept.selectBenchmarks(ctxA, WS, null, null)).rejects.toThrow(/closed or switched/)
    if ('ask' in ask) expect(await kept.importBenchmark(kept.benchContext(A.w), { kind: 'project', project: 'alpha' }, { token: ask.ask.token, useProjectPart: true })).toMatchObject({ error: expect.stringMatching(/no longer waiting/) })
    expect((await kept.listBenchmarks(kept.benchContext(A.w), WS)).entries).toEqual([])
    expect(existsSync(join(B, '.combwork', 'metrics', 'benchmarks'))).toBe(false)
    // Queued changes whose workspace closes before their turn: refused too.
    const ctxB = kept.benchContext(A.w)
    const first = kept.importBenchmark(ctxB, WS, { path: file('b', fixture('baseline')) })
    const second = kept.importBenchmark(ctxB, WS, { path: file('b', fixture('smaller')) })
    await A.w.close()
    const settled = await Promise.allSettled([first, second])
    expect(settled.some((s) => s.status === 'rejected')).toBe(true)
    // A report of another workspace isn't kept here.
    await A.w.open(B)
    await expect(kept.keepReport(kept.benchContext(A.w), { ...JSON.parse(exportFile()).report, workspacePath: 'C:\\elsewhere' }, '0.3.1')).rejects.toThrow(/switched/)
    await disposeWorkspaceService(A.w)
  })

  it('at most 20: the new file and index are committed before the oldest unpinned goes; a failed write evicts nothing', async () => {
    const { w, ctx, dir } = await open()
    const f = file('b', fixture('baseline'))
    const ids: string[] = []
    for (let i = 0; i < BENCHMARK_LIMITS.kept; i++) {
      ids.push(entryOf(await kept.importBenchmark(ctx(), WS, { path: f })).id)
      await new Promise((res) => setTimeout(res, 2))
    }
    const write = kept.benchIo.write
    for (const failOn of ['artifact', 'index']) {
      kept.benchIo.write = async (p: string, t: string) => {
        if (failOn === 'index' ? p.includes('index.json') : /[0-9a-f]{12}\.json\.staged/.test(p)) throw new Error(`disk full (${failOn})`)
        return write(p, t)
      }
      await expect(kept.importBenchmark(ctx(), WS, { path: f })).rejects.toThrow(/disk full/)
      kept.benchIo.write = write
      expect((await kept.listBenchmarks(ctx(), WS)).entries.length).toBe(BENCHMARK_LIMITS.kept)
      expect(readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x)).length).toBe(BENCHMARK_LIMITS.kept)
    }
    await kept.pinBenchmark(ctx(), WS, ids[0], true)
    entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
    const now = (await kept.listBenchmarks(ctx(), WS)).entries.map((e) => e.id)
    expect(now.length).toBe(BENCHMARK_LIMITS.kept)
    expect([now.includes(ids[0]), now.includes(ids[1])]).toEqual([true, false])
    expect(existsSync(join(dir, `${ids[1]}.json`))).toBe(false)
    for (const id of now) await kept.pinBenchmark(ctx(), WS, id, true)
    await expect(kept.importBenchmark(ctx(), WS, { path: f })).rejects.toThrow(/all are pinned/)
    await disposeWorkspaceService(w)
  })

  it('a damaged index is set aside and rebuilt from the kept files; one that can’t be read stops everything', async () => {
    const { w, ctx, dir } = await open()
    const a = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    writeFileSync(join(dir, 'index.json'), '{ not json')
    expect((await kept.listBenchmarks(ctx(), WS)).entries.map((e) => e.id)).toEqual([a.id])
    expect(readdirSync(dir).some((f) => f.startsWith('index.damaged-'))).toBe(true)
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [], pad: 'x'.repeat(600 * 1024) }))
    expect((await kept.listBenchmarks(ctx(), WS)).entries.map((e) => e.id)).toEqual([a.id])
    rmSync(join(dir, 'index.json'), { force: true })
    mkdirSync(join(dir, 'index.json'))
    await expect(kept.listBenchmarks(ctx(), WS)).rejects.toThrow(/can’t be read/)
    await expect(kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) })).rejects.toThrow(/can’t be read/)
    expect(existsSync(join(dir, `${a.id}.json`))).toBe(true)
    await disposeWorkspaceService(w)
  })

  it('a kept file is re-read through the normalisers: damaged, oversized or of another scope than its index is refused', async () => {
    const { w, ctx, dir } = await open()
    const alpha: CompareScope = { kind: 'project', project: 'alpha' }
    const own = entryOf(await kept.importBenchmark(ctx(), alpha, { path: file('e', exportFile({ scope: { kind: 'project', project: 'alpha' }, requests: { alpha: 3 } })) }))
    const stored = JSON.parse(readFileSync(join(dir, `${own.id}.json`), 'utf8'))
    writeFileSync(join(dir, `${own.id}.json`), JSON.stringify({ ...stored, scope: { kind: 'project', project: 'beta' } }))
    await expect(kept.readBenchmark(ctx(), alpha, own.id)).rejects.toThrow(/doesn’t match its scope/)
    writeFileSync(join(dir, `${own.id}.json`), '{"kind":"export"}')
    await expect(kept.readBenchmark(ctx(), alpha, own.id)).rejects.toThrow(/missing or damaged/)
    writeFileSync(join(dir, `${own.id}.json`), JSON.stringify({ ...stored, pad: 'x'.repeat(5 * 1024 * 1024) }))
    await expect(kept.readBenchmark(ctx(), alpha, own.id)).rejects.toThrow(/missing or damaged/)
    const big = file('big', JSON.stringify({ schema: 'hive-benchmark/1', pad: 'x'.repeat(BENCHMARK_LIMITS.fileBytes + 10) }))
    expect(await kept.importBenchmark(ctx(), WS, { path: big })).toMatchObject({ error: expect.stringMatching(/over 2 MB/) })
    await disposeWorkspaceService(w)
  })
})

describe('#117 round 2: checks are authoritative; the budget stops on unknown cost', () => {
  it('a failed check in the list fails the sample, whatever its summary says; untrustworthy lists are unknown', () => {
    const base = bench('baseline')
    // A new failed check appended, the summary counts and ok left as they were, and smaller: never better.
    const lying = variant((b) => {
      const x = sampleOf(b, 'card-detail')
      x.checks.push({ name: 'new failed check', ok: false })
      x.measures.toolBytes = 10
    })
    const l = scenario(compareArtifacts(base, lying), 'card-detail')
    expect(l.status).toBe('incomplete')
    expect(l.notes.join(' ')).toMatch(/check counts don’t match/)
    // The same failure with counts that agree: a failed sample, and the new check is a regression.
    const honest = variant((b) => {
      const x = sampleOf(b, 'card-detail')
      x.checks.push({ name: 'new failed check', ok: false })
      x.failed = 1
      x.measures.toolBytes = 10
    })
    const h = scenario(compareArtifacts(base, honest), 'card-detail')
    expect([h.status, h.regressions.map((r) => r.name)]).toEqual(['smaller-but-failing', ['new failed check']])
    // Duplicated, invalid or too many checks: unknown, never passed.
    for (const [why, fn] of [
      ['listed twice', (x: any) => x.checks.push({ ...x.checks[0] })],
      ['isn’t valid', (x: any) => x.checks.push({ name: 'x', ok: 'yes' })],
      ['too many', (x: any) => (x.checks = Array.from({ length: 61 }, (_, i) => ({ name: `c${i}`, ok: true })))]
    ] as const) {
      const v = variant((b) => fn(sampleOf(b, 'card-detail')))
      const s = v.scenarios!.find((x) => x.id === 'card-detail')!.samples[0]
      expect([s.ok, s.incomplete], why).toEqual([null, expect.any(String)])
    }
  })

  it('unknown real-trial cost stops further trials (unless allowed) and the total is unknown, never $0', () => {
    const { budgetGate, parseBudget, spendText, benchmarkOf } = require_('./scenarios/benchmark.cjs')
    expect(() => parseBudget('0')).toThrow(/above 0/)
    expect(() => parseBudget('-1')).toThrow()
    expect(() => parseBudget('Infinity')).toThrow()
    expect(parseBudget('0.01')).toBe(0.01)
    // Six trials, none reporting a cost, a $0.01 budget: only the first starts.
    const run = (allowUnknownCost: boolean) => {
      let started = 0
      let spentKnown = 0
      let unknownCostTrials = 0
      for (let i = 0; i < 6; i++) {
        if (!budgetGate({ fake: false, budget: 0.01, spentKnown, unknownCostTrials, allowUnknownCost }).ok) continue
        started++
        const cost: number | null = null
        if (typeof cost === 'number') spentKnown += cost
        else unknownCostTrials++
      }
      return { started, unknownCostTrials }
    }
    expect(run(false)).toEqual({ started: 1, unknownCostTrials: 1 })
    expect(run(true)).toEqual({ started: 6, unknownCostTrials: 6 })
    expect(budgetGate({ fake: false, budget: 0.01, spentKnown: 0.02, unknownCostTrials: 0, allowUnknownCost: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/budget/) })
    expect(budgetGate({ fake: true, budget: 0.01, spentKnown: 9, unknownCostTrials: 9, allowUnknownCost: false }).ok).toBe(true)
    // It names the model of the trial without a cost and how to price it.
    const named = budgetGate({ fake: false, budget: 2, spentKnown: 0, unknownCostTrials: 1, allowUnknownCost: false, noCostModels: ['gpt-9-nova'] })
    expect(named.reason).toMatch(/with gpt-9-nova .*src\/shared\/prices\.ts.*--model/)
    expect(spendText({ spentUsd: 0, unknownCostTrials: 1 })).toMatch(/total is unknown/)
    expect(spendText({ spentUsd: 0.5, unknownCostTrials: 0 })).toBe('$0.5 (API-equivalent)')
    // The artifact carries it, and says so.
    const meta = { fixturesVersion: 5, provider: 'codex', model: 'm', effort: '(default)', mode: 'full-access', repeats: 1, source: { head: 'a', dirty: null }, guidance: 'g', when: '2026-10-03T12:00:00.000Z', spentUsd: 0, unknownCostTrials: 1, budgetUsd: 0.01 }
    const a = art(parseArtifact(JSON.stringify(benchmarkOf(meta, [{ scenario: 'one', title: 'One', checks: [{ name: 'a', ok: true }], measures: { toolBytes: 1 }, coverage: { recording: true, dropped: 0, partial: [] } }], '0.3.1')), WS))
    expect(a.run!.unknownCostTrials).toBe(1)
  })
})

describe('kept comparisons: damage and closing mid-change (#117 round 2)', async () => {
  const base = tempDir('hive-bench2-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
  const kept = await import('../src/main/benchmarks')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(join(path, 'alpha'), { recursive: true })
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, ctx: () => kept.benchContext(w), dir: join(path, '.combwork', 'metrics', 'benchmarks') }
  }
  const file = (name: string, textValue: string): string => {
    const f = join(base, `${name}-${++n}.json`)
    writeFileSync(f, textValue)
    return f
  }
  const entryOf = (r: any) => {
    if (!('entry' in r)) throw new Error(JSON.stringify(r))
    return r.entry
  }

  it('a partly damaged or missing index is recovered: no kept file is deleted, pins survive, it is said, and it is stable', async () => {
    const { w, ctx, dir } = await open()
    const a = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    await kept.pinBenchmark(ctx(), WS, a.id, true)
    const b = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('s', fixture('smaller')) }))
    // One entry damaged, the other recording a removal and an add in progress: a damaged index is never acted on.
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
    const ia = index.entries.findIndex((e: any) => e.id === a.id)
    const ib = index.entries.findIndex((e: any) => e.id === b.id)
    Object.assign(index.entries[ia], { state: 'removing', txn: 'abcdef12' })
    index.entries[ib].id = null
    index.entries.push({ ...index.entries[ia], id: 'cccccccccccc', state: 'adding', txn: 'abcdef12' })
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index))
    const list = await kept.listBenchmarks(ctx(), WS)
    expect([existsSync(join(dir, `${a.id}.json`)), existsSync(join(dir, `${b.id}.json`))]).toEqual([true, true])
    expect(list.entries.map((e) => e.id).sort()).toEqual([a.id, b.id].sort())
    expect(list.entries.find((e) => e.id === a.id)!.pinned).toBe(true)
    expect(list.notice).toMatch(/Recovered: an entry of the list of kept comparisons was damaged/)
    // Stable: read again, nothing is recovered or rewritten.
    const after = readFileSync(join(dir, 'index.json'), 'utf8')
    const again = await kept.listBenchmarks(ctx(), WS)
    expect([again.notice, readFileSync(join(dir, 'index.json'), 'utf8')]).toEqual([undefined, after])
    expect(readdirSync(dir).filter((f) => f.startsWith('index.damaged-')).length).toBe(1)
    // The index gone altogether: the files are adopted, not taken as nothing kept.
    rmSync(join(dir, 'index.json'))
    const missing = await kept.listBenchmarks(ctx(), WS)
    expect([missing.entries.length, missing.notice]).toEqual([2, expect.stringMatching(/was missing/)])
    await disposeWorkspaceService(w)
  })

  it('files the index doesn’t account for (unreadable or extra) go once to quarantine; reading again changes nothing', async () => {
    const { w, ctx, dir } = await open()
    const a = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    writeFileSync(join(dir, 'ffffffffffff.json'), 'not a comparison')
    writeFileSync(join(dir, 'eeeeeeeeeeee.json'), readFileSync(join(dir, `${a.id}.json`)))
    const first = await kept.listBenchmarks(ctx(), WS)
    expect(first.entries.map((e) => e.id)).toEqual([a.id])
    expect(first.notice).toMatch(/2 files not in the list were moved to quarantine/)
    expect(readdirSync(join(dir, 'quarantine')).length).toBe(2)
    const index = readFileSync(join(dir, 'index.json'), 'utf8')
    for (let i = 0; i < 3; i++) expect((await kept.listBenchmarks(ctx(), WS)).notice).toBeUndefined()
    expect([readFileSync(join(dir, 'index.json'), 'utf8'), readdirSync(dir).some((f) => f.startsWith('index.damaged-'))]).toEqual([index, false])
    // More valid files than can be listed, with no index: the newest 20 listed, the rest quarantined, then stable.
    rmSync(join(dir, 'index.json'))
    for (let i = 0; i < 22; i++) writeFileSync(join(dir, `${(0xa00000000000 + i).toString(16)}.json`), readFileSync(join(dir, `${a.id}.json`)))
    const rebuilt = await kept.listBenchmarks(ctx(), WS)
    expect(rebuilt.entries.length).toBe(BENCHMARK_LIMITS.kept)
    expect(readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f)).length).toBe(BENCHMARK_LIMITS.kept)
    const stable = readFileSync(join(dir, 'index.json'), 'utf8')
    expect((await kept.listBenchmarks(ctx(), WS)).notice).toBeUndefined()
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(stable)
    await disposeWorkspaceService(w)
  })

  it('a removal stays recorded until its file is gone: a failed unlink is retried (also after a restart), never resurrected', async () => {
    const { w, ctx, dir, path } = await open()
    const f = file('b', fixture('baseline'))
    const ids: string[] = []
    for (let i = 0; i < BENCHMARK_LIMITS.kept; i++) {
      ids.push(entryOf(await kept.importBenchmark(ctx(), WS, { path: f })).id)
      await new Promise((res) => setTimeout(res, 2))
    }
    const unlinkFn = kept.benchIo.unlink
    let refuse = true
    kept.benchIo.unlink = async (p: string) => {
      if (refuse) throw Object.assign(new Error('EBUSY: in use'), { code: 'EBUSY' })
      return unlinkFn(p)
    }
    try {
      // Eviction at the limit with the oldest file's removal refused: the add succeeds, the evicted one is off the list
      // but recorded, and its file is still there.
      const added = entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
      let list = await kept.listBenchmarks(ctx(), WS)
      expect(list.entries.length).toBe(BENCHMARK_LIMITS.kept)
      expect(list.entries.some((e) => e.id === ids[0])).toBe(false)
      expect(list.entries.some((e) => e.id === added.id)).toBe(true)
      expect(existsSync(join(dir, `${ids[0]}.json`))).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.find((e: any) => e.id === ids[0])).toMatchObject({ state: 'removing' })
      // An explicit Remove whose unlink fails: said, off the list, recorded; not back on the next read.
      await expect(kept.removeBenchmark(ctx(), WS, ids[1])).rejects.toThrow(/couldn’t be removed yet/)
      list = await kept.listBenchmarks(ctx(), WS)
      expect(list.entries.some((e) => e.id === ids[1])).toBe(false)
      // A restart before the retry: still recorded, still off the list.
      await w.close()
      await w.open(path)
      list = await kept.listBenchmarks(ctx(), WS)
      expect(list.entries.some((e) => e.id === ids[0] || e.id === ids[1])).toBe(false)
      // The removal works again: both files go, both entries are dropped.
      refuse = false
      list = await kept.listBenchmarks(ctx(), WS)
      expect([existsSync(join(dir, `${ids[0]}.json`)), existsSync(join(dir, `${ids[1]}.json`))]).toEqual([false, false])
      expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.some((e: any) => e.state)).toBe(false)
      expect(list.notice).toMatch(/interrupted removal was finished/)
    } finally {
      kept.benchIo.unlink = unlinkFn
      await disposeWorkspaceService(w)
    }
  })

  it('an add that never finished (recorded in a valid index) is rolled back: its file goes, what it evicted is kept again', async () => {
    const { w, ctx, dir } = await open()
    const a = entryOf(await kept.importBenchmark(ctx(), WS, { path: file('b', fixture('baseline')) }))
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
    index.entries[0] = { ...index.entries[0], state: 'removing', txn: 'abcdef12' }
    index.entries.push({ ...index.entries[0], id: 'dddddddddddd', state: 'adding', txn: 'abcdef12' })
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index))
    writeFileSync(join(dir, 'dddddddddddd.json'), readFileSync(join(dir, `${a.id}.json`)))
    const list = await kept.listBenchmarks(ctx(), WS)
    expect(list.entries.map((e) => e.id)).toEqual([a.id])
    expect([existsSync(join(dir, `${a.id}.json`)), existsSync(join(dir, 'dddddddddddd.json'))]).toEqual([true, false])
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.some((e: any) => e.state)).toBe(false)
    await disposeWorkspaceService(w)
  })

  it('a workspace closing during the commit’s write commits nothing and evicts nothing', async () => {
    const A = await open()
    const f = file('b', fixture('baseline'))
    const ids: string[] = []
    for (let i = 0; i < BENCHMARK_LIMITS.kept; i++) {
      ids.push(entryOf(await kept.importBenchmark(A.ctx(), WS, { path: f })).id)
      await new Promise((res) => setTimeout(res, 2))
    }
    const before = readFileSync(join(A.dir, 'index.json'), 'utf8')
    // Hold the index's write until the workspace has switched.
    const write = kept.benchIo.write
    let release!: () => void
    let reached!: () => void
    const atIndex = new Promise<void>((r) => (reached = r))
    const held = new Promise<void>((r) => (release = r))
    kept.benchIo.write = async (p: string, t: string) => {
      if (p.includes('index.json')) {
        reached()
        await held
      }
      return write(p, t)
    }
    const importing = kept.importBenchmark(A.ctx(), WS, { path: f })
    await atIndex
    const B = join(base, `ws-${++n}`)
    mkdirSync(B, { recursive: true })
    await A.w.close()
    await A.w.open(B)
    release()
    await expect(importing).rejects.toThrow(/closed or switched/)
    kept.benchIo.write = write
    // A's index and files are as they were: the oldest wasn't evicted, the new file and markers are gone.
    expect(readFileSync(join(A.dir, 'index.json'), 'utf8')).toBe(before)
    expect(existsSync(join(A.dir, `${ids[0]}.json`))).toBe(true)
    expect(readdirSync(A.dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x)).length).toBe(BENCHMARK_LIMITS.kept)
    expect(readdirSync(A.dir).some((x) => /staged/.test(x))).toBe(false)
    expect(existsSync(join(B, '.combwork', 'metrics', 'benchmarks'))).toBe(false)
    await disposeWorkspaceService(A.w)
  })
})

describe('kept comparisons: bounds that hold under failing removals; quarantine by age (#117 round 4)', async () => {
  const base = tempDir('hive-bench4-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
  const kept = await import('../src/main/benchmarks')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(join(path, 'alpha'), { recursive: true })
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, ctx: () => kept.benchContext(w), dir: join(path, '.combwork', 'metrics', 'benchmarks') }
  }
  const entryOf = (r: any) => {
    if (!('entry' in r)) throw new Error(JSON.stringify(r))
    return r.entry
  }

  it('every index written is one the reader accepts: with removals failing, keeping stops at the bound and nothing comes back', async () => {
    const { w, ctx, dir } = await open()
    const f = join(base, `b-${++n}.json`)
    writeFileSync(f, fixture('baseline'))
    for (let i = 0; i < BENCHMARK_LIMITS.kept; i++) entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
    const write = kept.benchIo.write
    const unlinkFn = kept.benchIo.unlink
    const written: any[] = []
    kept.benchIo.write = async (p: string, t: string) => {
      if (p.includes('index.json')) written.push(JSON.parse(t))
      return write(p, t)
    }
    let refuse = true
    kept.benchIo.unlink = async (p: string) => {
      if (refuse) throw Object.assign(new Error('EBUSY: in use'), { code: 'EBUSY' })
      return unlinkFn(p)
    }
    try {
      // Each import evicts the oldest, whose removal fails: removals pile up until the bound refuses another keep.
      let added = 0
      let refusal: Error | null = null
      const lastAdded: string[] = []
      for (let i = 0; i < 25 && !refusal; i++) {
        try {
          lastAdded.push(entryOf(await kept.importBenchmark(ctx(), WS, { path: f })).id)
          added++
        } catch (e) {
          refusal = e as Error
        }
      }
      expect(added).toBe(BENCHMARK_LIMITS.kept)
      expect(refusal?.message).toMatch(/couldn’t be deleted yet/)
      // Remove the newest at the bound (its unlink fails too: recorded, off the list), then try to import again.
      await expect(kept.removeBenchmark(ctx(), WS, lastAdded.at(-1)!)).rejects.toThrow(/couldn’t be removed yet/)
      await expect(kept.importBenchmark(ctx(), WS, { path: f })).rejects.toThrow(/couldn’t be deleted yet/)
      // Every index Combwork wrote, the reader accepts: never more than the bound, never more than 20 kept.
      for (const ix of written) {
        expect(ix.entries.length).toBeLessThanOrEqual(BENCHMARK_LIMITS.kept * 2)
        expect(ix.entries.filter((e: any) => !e.state).length).toBeLessThanOrEqual(BENCHMARK_LIMITS.kept)
      }
      // Read again (and after a restart): no recovery, nothing quarantined, the removed one doesn't come back.
      let list = await kept.listBenchmarks(ctx(), WS)
      expect(list.notice ?? '').not.toMatch(/Recovered|quarantine/)
      expect(list.entries.some((e) => e.id === lastAdded.at(-1))).toBe(false)
      expect(list.entries.length).toBe(BENCHMARK_LIMITS.kept - 1)
      expect(existsSync(join(dir, 'quarantine'))).toBe(false)
      // Removals work again: they finish on the next read, and keeping goes on.
      refuse = false
      list = await kept.listBenchmarks(ctx(), WS)
      expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries.some((e: any) => e.state)).toBe(false)
      expect(readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x)).length).toBe(BENCHMARK_LIMITS.kept - 1)
      entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
    } finally {
      kept.benchIo.write = write
      kept.benchIo.unlink = unlinkFn
      await disposeWorkspaceService(w)
    }
  })

  it('quarantine keeps the newest 100 by when they came, whatever their ids', async () => {
    const { w, ctx, dir } = await open()
    const f = join(base, `b-${++n}.json`)
    writeFileSync(f, fixture('baseline'))
    entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
    const q = join(dir, 'quarantine')
    mkdirSync(q, { recursive: true })
    // 100 older quarantined files, with high ids; and one not in Combwork's naming (never pruned).
    for (let i = 0; i < 100; i++) writeFileSync(join(q, `2026-01-01T00-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-000Z-0000-${(0xf00000000000 + i).toString(16)}.json`), '{}')
    writeFileSync(join(q, 'notes.txt'), 'mine')
    // Two new strays in one move, one with the lowest id there is: both kept (in order), the two oldest go.
    writeFileSync(join(dir, '000000000001.json'), 'stray one')
    writeFileSync(join(dir, '000000000002.json'), 'stray two')
    await kept.listBenchmarks(ctx(), WS)
    const names = readdirSync(q)
    const recognised = names.filter((x) => x.endsWith('.json'))
    expect(recognised.length).toBe(100)
    expect(recognised.some((x) => x.endsWith('-000000000001.json'))).toBe(true)
    expect(recognised.some((x) => x.endsWith('-000000000002.json'))).toBe(true)
    expect(recognised.some((x) => x.startsWith('2026-01-01T00-00-00-000Z'))).toBe(false)
    expect(recognised.some((x) => x.startsWith('2026-01-01T00-00-01-000Z'))).toBe(false)
    expect(recognised.some((x) => x.startsWith('2026-01-01T00-00-02-000Z'))).toBe(true)
    expect(names.includes('notes.txt')).toBe(true)
    // The same moment: distinct names, in the order they were moved.
    const fresh = recognised.filter((x) => !x.startsWith('2026-01-01')).sort()
    expect(fresh.map((x) => x.slice(25, 29))).toEqual(['0000', '0001'])
    await disposeWorkspaceService(w)
  })
})

describe('kept comparisons: Windows rename retries stop when the workspace goes (#117 round 5)', async () => {
  const base = tempDir('hive-bench5-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
  const kept = await import('../src/main/benchmarks')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    mkdirSync(join(path, 'alpha'), { recursive: true })
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, ctx: () => kept.benchContext(w), dir: join(path, '.combwork', 'metrics', 'benchmarks') }
  }
  const entryOf = (r: any) => {
    if (!('entry' in r)) throw new Error(JSON.stringify(r))
    return r.entry
  }
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
  const baselineFile = () => {
    const f = join(base, `b-${++n}.json`)
    writeFileSync(f, fixture('baseline'))
    return f
  }
  /** Refuses (EPERM) the rename picked by `which`, holding the refusal until released; every other rename runs. */
  const holdRefusal = (which: (from: string, to: string, nth: number) => boolean) => {
    const real = kept.benchIo.renameOnce
    let nth = 0
    let reached!: () => void
    let release!: () => void
    const atIt = new Promise<void>((r) => (reached = r))
    const held = new Promise<void>((r) => (release = r))
    let done = false
    kept.benchIo.renameOnce = async (from: string, to: string) => {
      if (!done && which(from, to, ++nth)) {
        done = true
        reached()
        await held
        throw eperm()
      }
      return real(from, to)
    }
    return { atIt, release, restore: () => (kept.benchIo.renameOnce = real) }
  }

  it('the final index commit refused once, the workspace switched during the retry: nothing commits, and A rolls back', async () => {
    const A = await open()
    const f = baselineFile()
    const first = entryOf(await kept.importBenchmark(A.ctx(), WS, { path: f }))
    let indexRenames = 0
    const h = holdRefusal((_from, to) => to.endsWith('index.json') && ++indexRenames === 2)
    try {
      const importing = kept.importBenchmark(A.ctx(), WS, { path: f })
      await h.atIt
      const B = join(base, `ws-${++n}`)
      mkdirSync(B, { recursive: true })
      await A.w.close()
      await A.w.open(B)
      h.release()
      await expect(importing).rejects.toThrow(/closed or switched/)
      expect(existsSync(join(B, '.combwork', 'metrics', 'benchmarks'))).toBe(false)
      h.restore()
      // Back in A: the unfinished add is rolled back on the first read; only the first comparison is kept.
      await A.w.close()
      await A.w.open(A.path)
      const list = await kept.listBenchmarks(kept.benchContext(A.w), WS)
      expect(list.entries.map((e) => e.id)).toEqual([first.id])
      expect(readdirSync(A.dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x))).toEqual([`${first.id}.json`])
      expect(JSON.parse(readFileSync(join(A.dir, 'index.json'), 'utf8')).entries.some((e: any) => e.state)).toBe(false)
    } finally {
      h.restore()
      await disposeWorkspaceService(A.w)
    }
  })

  it('a refusal with no switch is retried and succeeds; refusals to the end leave the index as it was', async () => {
    const { w, ctx, dir } = await open()
    const f = baselineFile()
    const first = entryOf(await kept.importBenchmark(ctx(), WS, { path: f }))
    const h = holdRefusal((_from, to) => to.endsWith('index.json'))
    try {
      const importing = kept.importBenchmark(ctx(), WS, { path: f })
      await h.atIt
      h.release()
      entryOf(await importing)
      expect((await kept.listBenchmarks(ctx(), WS)).entries.length).toBe(2)
    } finally {
      h.restore()
    }
    const before = readFileSync(join(dir, 'index.json'), 'utf8')
    const files = readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x)).sort()
    const real = kept.benchIo.renameOnce
    kept.benchIo.renameOnce = async (from: string, to: string) => {
      if (to.endsWith('index.json')) throw eperm()
      return real(from, to)
    }
    try {
      await expect(kept.importBenchmark(ctx(), WS, { path: f })).rejects.toThrow(/EPERM/)
    } finally {
      kept.benchIo.renameOnce = real
    }
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(before)
    expect(readdirSync(dir).filter((x) => /^[0-9a-f]{12}\.json$/.test(x)).sort()).toEqual(files)
    expect(readdirSync(dir).some((x) => /staged/.test(x))).toBe(false)
    expect((await kept.listBenchmarks(ctx(), WS)).entries.some((e) => e.id === first.id)).toBe(true)
    await disposeWorkspaceService(w)
  }, 30_000)

  it('a quarantine move or a damaged index set aside, refused during a switch, isn’t done late: the files stay where they were', async () => {
    const A = await open()
    const f = baselineFile()
    const first = entryOf(await kept.importBenchmark(A.ctx(), WS, { path: f }))
    writeFileSync(join(A.dir, 'ffffffffffff.json'), 'stray')
    const switchTo = async () => {
      const B = join(base, `ws-${++n}`)
      mkdirSync(B, { recursive: true })
      await A.w.close()
      await A.w.open(B)
    }
    let h = holdRefusal((_from, to) => to.includes('quarantine'))
    try {
      const listing = kept.listBenchmarks(A.ctx(), WS).catch((e) => e)
      await h.atIt
      await switchTo()
      h.release()
      await listing
      expect(existsSync(join(A.dir, 'ffffffffffff.json'))).toBe(true)
      expect(readdirSync(join(A.dir, 'quarantine')).length).toBe(0)
    } finally {
      h.restore()
    }
    // A damaged index whose set-aside is refused while the workspace switches: left as it is, nothing rebuilt.
    await A.w.close()
    await A.w.open(A.path)
    writeFileSync(join(A.dir, 'index.json'), '{ damaged')
    h = holdRefusal((from) => from.endsWith('index.json'))
    try {
      const listing = kept.listBenchmarks(kept.benchContext(A.w), WS)
      await h.atIt
      await switchTo()
      h.release()
      await expect(listing).rejects.toThrow(/closed or switched/)
      expect(readFileSync(join(A.dir, 'index.json'), 'utf8')).toBe('{ damaged')
      expect(existsSync(join(A.dir, `${first.id}.json`))).toBe(true)
    } finally {
      h.restore()
      await disposeWorkspaceService(A.w)
    }
  })
})
