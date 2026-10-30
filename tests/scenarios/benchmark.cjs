// A scenario run as a benchmark artifact (#117): what Hive's own parts cost in each scenario, with each sample's
// correctness, in a versioned, bounded file the Performance page can import and compare (src/shared/benchmark.ts reads
// it: schema "hive-benchmark/1"). Runs keep their own folder; baselines are kept apart and never overwritten (the
// previous copy is kept, the oldest pruned).
const fs = require('fs')
const path = require('path')

const SCHEMA = 'hive-benchmark/1'
// scenarios: as src/shared/benchmark.ts's (200 since #1444).
const LIMITS = { scenarios: 200, samples: 20, checks: 60, failedChecks: 20, skills: 60, text: 200, resultsKept: 30, baselinesKept: 5 }

/** Short text with no paths in it (an error can quote one): at most LIMITS.text characters. */
const clean = (v) =>
  String(v ?? '')
    .split('\n')[0]
    .replace(/[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
    .replace(/(^|\s)\/[^\s'"`)]+/g, '$1<path>')
    .slice(0, LIMITS.text)

/** The sum of a metrics report's parts, work by the harness's own token (role api: its setup and reads) left out. */
function metricsTotals(r) {
  const t = { apiRequests: 0, apiFailed: 0, apiCancelled: 0, apiRequestBytes: 0, apiResponseBytes: 0, apiMs: 0, toolCalls: 0, toolErrors: 0, toolDetailCalls: 0, toolChars: 0, toolBytes: 0, toolMs: 0, launches: 0, coreBytes: 0, customBytes: 0, roleBytes: 0, modeBytes: 0, catalogBytes: 0, coreChars: 0, customChars: 0, roleChars: 0, modeChars: 0, skillBytes: 0, skillsDelivered: 0, skillsNotDelivered: 0, skillsUnmeasured: 0, toolListBytes: 0, toolListStarts: 0, toolListChars: 0, toolListCharStarts: 0, skillScans: 0, skillHits: 0, skillMisses: 0, skillInvalidations: 0, skillBytesRead: 0, skillTooLarge: 0, dropped: 0 }
  if (!r) return t
  for (const part of [...Object.values(r.projects ?? {}), ...(r.workspace ? [r.workspace] : [])]) {
    for (const a of part.api ?? []) {
      if (a.role === 'api') continue
      t.apiRequests += a.count
      if (a.outcome !== 'ok') t.apiFailed += a.count
      if (a.outcome === 'cancelled') t.apiCancelled += a.count
      t.apiRequestBytes += a.requestBytes
      t.apiResponseBytes += a.responseBytes
      t.apiMs += a.totalMs
    }
    for (const m of part.mcp ?? []) {
      t.toolCalls += m.count
      if (m.outcome === 'error') t.toolErrors += m.count
      if (m.mode === 'detail') t.toolDetailCalls += m.count
      t.toolChars += m.chars
      t.toolBytes += m.bytes
      t.toolMs += m.totalMs
    }
    for (const g of part.guidance ?? []) {
      t.launches += g.launches
      t.coreBytes += g.guidanceBytes
      t.customBytes += g.customBytes
      t.roleBytes += g.roleBytes
      t.modeBytes += g.modeBytes
      t.coreChars += g.guidanceChars
      t.customChars += g.customChars
      t.roleChars += g.roleChars
      t.modeChars += g.modeChars
      t.catalogBytes += g.skillCatalogBytes
      t.skillBytes += g.skillBytes
      t.skillsDelivered += g.skills
      t.skillsNotDelivered += g.skillsNotDelivered
      t.skillsUnmeasured += g.skillsUnmeasured
    }
    for (const c of part.catalog ?? []) {
      t.toolListBytes += c.toolsBytes
      t.toolListStarts += c.starts
      t.toolListChars += c.toolsChars ?? 0
      t.toolListCharStarts += c.charStarts ?? 0
    }
  }
  const sk = r.skills
  if (sk) Object.assign(t, { skillScans: sk.scans.count, skillHits: sk.hits, skillMisses: sk.misses, skillInvalidations: sk.invalidations, skillBytesRead: sk.bytes, skillTooLarge: sk.tooLarge })
  t.dropped = r.dropped ?? 0
  return t
}

/**
 * A scenario's measures (#117): what Hive's parts did between the snapshot before the launch and the one after the turn
 * (exact bytes and characters, calls, launches, the skill service's work), the hive calls the server ran (and how many
 * repeated one already made), and the session's own provider usage (a new session: its total is the scenario's; null
 * when the provider reported none).
 */
function measuresOf(before, after, observed, usage) {
  const a = metricsTotals(before)
  const b = metricsTotals(after)
  const m = Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(0, b[k] - a[k])]))
  const calls = observed?.hiveCalls ?? []
  const seen = new Set()
  let repeated = 0
  for (const c of calls) {
    const k = `${c.tool} ${c.args ?? ''}`
    if (seen.has(k)) repeated++
    seen.add(k)
  }
  // The tool list's characters only when every start in the scenario had them counted (HI-2049): else unknown.
  if (m.toolListCharStarts !== m.toolListStarts) delete m.toolListChars
  delete m.toolListCharStarts
  m.hiveCalls = calls.length
  m.hiveCallErrors = calls.filter((c) => !c.ok).length
  m.repeatedCalls = repeated
  m.skillsRead = observed?.skillsRead?.length ?? 0
  m.skillRefsRead = observed?.skillRefsRead?.length ?? 0
  const u = usage && (usage.inputTokens || usage.outputTokens || usage.requests) ? usage : null
  m.usage = u
    ? {
        // What the provider reported, as reported: a field it didn't report stays out (unknown, never 0).
        ...Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'requests', 'contextTokens', 'costUsd'].filter((k) => typeof u[k] === 'number').map((k) => [k, u[k]])),
        costEstimated: !!u.costEstimated
      }
    : null
  return m
}

/**
 * One scenario run as a sample: whether it completed and passed (passed means at least one check ran and none failed:
 * all skipped is unknown), each check, its measures with their coverage, and what the session was given at launch.
 */
function sampleOf(r) {
  if (r.skipped) return { ok: null, incomplete: clean(r.skipped), passed: 0, failed: 0, skipped: 0, checks: [], failedChecks: [], stale: false, resumed: false, seconds: 0, measures: null, coverage: { recording: null, dropped: 0, partial: ['not run'] } }
  const checks = r.checks ?? []
  const failed = checks.filter((c) => c.ok === false)
  const passed = checks.filter((c) => c.ok === true).length
  const skills = {}
  for (const [name, rev] of Object.entries(r.guidance?.delivered?.skills ?? {}).slice(0, LIMITS.skills)) if (typeof rev === 'string') skills[clean(name)] = clean(rev)
  return {
    // null: it didn't complete (an error, a timeout), or no check ran, so its correctness isn't known.
    ok: r.error ? null : failed.length ? false : passed > 0 ? true : null,
    ...(r.error ? { incomplete: clean(r.error) } : !failed.length && !passed ? { incomplete: 'no check ran' } : {}),
    passed,
    failed: failed.length,
    skipped: checks.filter((c) => c.ok === null).length,
    checks: checks.slice(0, LIMITS.checks).map((c) => ({ name: clean(c.name), ok: c.ok === true ? true : c.ok === false ? false : null })),
    failedChecks: failed.slice(0, LIMITS.failedChecks).map((c) => clean(c.name)),
    // Recorded, not checked (#1611): they never change ok, passed or failed.
    ...(r.observations?.length ? { observations: r.observations.slice(0, LIMITS.checks).map((x) => ({ name: clean(x.name), value: x.value === true })) } : {}),
    coverage: r.coverage ?? { recording: null, dropped: 0, partial: ['not recorded by this harness'] },
    guidance: typeof r.guidance?.delivered?.guidance === 'string' ? clean(r.guidance.delivered.guidance) : null,
    skills: r.guidance?.delivered ? skills : null,
    stale: !!r.staleGuidance,
    // A resumed session's usage is its whole conversation's, not this scenario's (scenarios start new ones).
    resumed: !!r.resumed,
    seconds: r.seconds ?? 0,
    measures: r.measures ?? null
  }
}

/**
 * The artifact for a run: `meta` from run.mjs (provider, model, source, guidance…), `results` every scenario run (each
 * sample of each scenario, in order).
 */
function benchmarkOf(meta, results, appVersion) {
  const byScenario = new Map()
  for (const r of results) {
    const id = r.scenario
    if (!byScenario.has(id)) {
      if (byScenario.size >= LIMITS.scenarios) continue
      byScenario.set(id, { id, title: clean(r.title), role: r.role ?? 'agent', samples: [] })
    }
    const sc = byScenario.get(id)
    if (sc.samples.length < LIMITS.samples) sc.samples.push(sampleOf(r))
  }
  const real = meta.provider === 'claude-code' || meta.provider === 'codex'
  return {
    schema: SCHEMA,
    kind: 'scenarios',
    app: { name: 'Hive', version: appVersion },
    createdAt: meta.when,
    scope: { kind: 'workspace' },
    label: `${meta.provider}${meta.model && meta.model !== '(default)' ? ` ${meta.model}` : ''}, fixtures v${meta.fixturesVersion}`,
    run: {
      fixturesVersion: meta.fixturesVersion,
      provider: meta.provider,
      providerId: meta.provider === 'fake-codex' || meta.provider === 'codex' ? 'codex' : 'claude-code',
      real,
      model: meta.model ?? '(default)',
      effort: meta.effort ?? '(default)',
      mode: meta.mode ?? null,
      cliVersions: [...new Set(results.map((r) => r.cliVersion).filter(Boolean))].slice(0, 5),
      repeats: meta.repeats ?? 1,
      source: meta.source,
      sourceChangedDuringRun: !!meta.sourceChangedDuringRun,
      guidance: meta.guidance ?? null,
      authorization: real ? 'opt-in model trial in the provider’s test home (signed in once by hand)' : null,
      budgetUsd: real ? meta.budgetUsd : null,
      spentUsd: meta.spentUsd ?? 0,
      // Trials that reported no cost: the spend is the known subtotal plus these, unknown in all.
      unknownCostTrials: meta.unknownCostTrials ?? 0,
      seconds: results.reduce((n, r) => n + (r.seconds ?? 0), 0),
      metricsOverheadMs: results.reduce((n, r) => n + (r.metricsOverheadMs ?? 0), 0)
    },
    scenarios: [...byScenario.values()]
  }
}

/** Keeps the newest `keep` run folders in `dir` (named by time), removing older ones. */
function pruneResults(dir, keep = LIMITS.resultsKept, spare = () => null) {
  if (!fs.existsSync(dir)) return
  const runs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(d.name) && !spare(path.join(dir, d.name)))
    .map((d) => d.name)
    .sort()
  for (const old of runs.slice(0, Math.max(0, runs.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true })
}

/**
 * Saves `file` as the baseline `name` in `dir`. The new baseline is read first (a failure leaves everything as it was);
 * an existing baseline of that name is copied to a name of its own (name.<its time>.json, or -2, -3… when that is taken:
 * never overwritten, also when saved twice in a second) before the new one replaces it atomically. At most
 * LIMITS.baselinesKept older copies of a name are kept, the oldest going first. Returns the baseline's path.
 */
function saveBaseline(dir, name, file, spare = () => null) {
  if (!/^[\w-]{1,40}$/.test(name)) throw new Error(`A baseline name is letters, digits, "-" and "_" (at most 40): "${name}"`)
  const data = fs.readFileSync(file)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${name}.json`)
  if (fs.existsSync(dest)) {
    let stamp
    try {
      stamp = String(JSON.parse(fs.readFileSync(dest, 'utf8')).createdAt)
    } catch {
      stamp = ''
    }
    if (!/^\d{4}-/.test(stamp)) stamp = fs.statSync(dest).mtime.toISOString()
    stamp = stamp.replace(/[:.]/g, '-').slice(0, 19)
    for (let i = 1; ; i++) {
      const archive = path.join(dir, `${name}.${stamp}${i > 1 ? `-${i}` : ''}.json`)
      try {
        fs.copyFileSync(dest, archive, fs.constants.COPYFILE_EXCL)
        break
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    }
  }
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, dest)
  const older = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.`) && f !== `${name}.json` && /^\d{4}-/.test(f.slice(name.length + 1)) && !spare(path.join(dir, f)))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f))
  for (const { f } of older.slice(0, Math.max(0, older.length - LIMITS.baselinesKept))) fs.rmSync(path.join(dir, f), { force: true })
  return dest
}

/** A results folder of its own for a run (a second run in the same second gets -2, -3…, never another run's folder). */
function resultsFolder(dir, base) {
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 1; ; i++) {
    const f = path.join(dir, `${base}${i > 1 ? `-${i}` : ''}`)
    try {
      fs.mkdirSync(f)
      return f
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/** A --budget value: a finite number of US dollars above 0, or an error saying what it must be. */
function parseBudget(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget must be a number of US dollars above 0 (API-equivalent), not "${v}".`)
  return n
}

/**
 * Whether another model trial may start. Spend is what the trials so far reported; a trial that reported no cost leaves
 * the spend unknown, so no further trial starts (the budget can't be kept) unless the run was told it may go on without
 * knowing (--allow-unknown-cost). Fakes cost nothing and always go on. `noCostModels`: the models of those trials, named
 * with how to price one (a model Hive has no price for is the usual reason).
 */
function budgetGate({ fake, budget, spentKnown, unknownCostTrials, allowUnknownCost, noCostModels = [] }) {
  if (fake) return { ok: true }
  if (unknownCostTrials > 0 && !allowUnknownCost) {
    const why = noCostModels.length
      ? ` with ${noCostModels.join(', ')} (if Hive has no price for it, add one to SHIPPED_PRICES in src/shared/prices.ts from the provider's published prices, or pass --model with a priced model)`
      : ''
    return { ok: false, reason: `${unknownCostTrials} trial${unknownCostTrials === 1 ? '' : 's'} reported no cost${why}, so the spend can’t be checked against the budget (--allow-unknown-cost to go on anyway)` }
  }
  if (spentKnown >= budget) return { ok: false, reason: `budget of $${budget} reached` }
  return { ok: true }
}

/** The spend as the summary says it: the known subtotal, and unknown in all when any trial reported no cost. */
function spendText(meta) {
  const known = `$${meta.spentUsd}`
  return meta.unknownCostTrials ? `${known} reported, plus ${meta.unknownCostTrials} trial${meta.unknownCostTrials === 1 ? '' : 's'} with no reported cost: the total is unknown` : `${known} (API-equivalent)`
}

module.exports = { SCHEMA, LIMITS, benchmarkOf, sampleOf, pruneResults, saveBaseline, resultsFolder, measuresOf, metricsTotals, parseBudget, budgetGate, spendText }
