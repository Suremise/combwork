// A scenario run as a benchmark artifact (#117): what Combwork's own parts cost in each scenario, with each sample's
// correctness, in a versioned, bounded file the Performance page can import and compare (src/shared/benchmark.ts reads
// it: schema "combwork-benchmark/1"). Runs keep their own folder; baselines are kept apart and never overwritten (the
// previous copy is kept, the oldest pruned).
const fs = require('fs')
const path = require('path')

const SCHEMA = 'combwork-benchmark/1'
// scenarios: as src/shared/benchmark.ts's (200 since #1444).
const LIMITS = { scenarios: 200, samples: 20, checks: 60, failedChecks: 20, skills: 60, text: 200, resultsKept: 30, baselinesKept: 5 }

/** Short text with no paths in it (an error can quote one): at most LIMITS.text characters. */
const clean = (v) =>
  String(v ?? '')
    .split('\n')[0]
    .replace(/[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
    .replace(/(^|\s)\/[^\s'"`)]+/g, '$1<path>')
    .slice(0, LIMITS.text)

/**
 * The sum of a metrics report's parts, work by the harness's own token (role api: its setup and reads) left out. With
 * `role` (HI-2186: 'assistant' or 'agent'), only that caller role's series; the skill service and drops are shared, so
 * they stay 0 there.
 */
function metricsTotals(r, role) {
  const t = { apiRequests: 0, apiFailed: 0, apiCancelled: 0, apiRequestBytes: 0, apiResponseBytes: 0, apiMs: 0, toolCalls: 0, toolErrors: 0, toolDetailCalls: 0, toolChars: 0, toolBytes: 0, toolMs: 0, launches: 0, coreBytes: 0, customBytes: 0, roleBytes: 0, modeBytes: 0, catalogBytes: 0, coreChars: 0, customChars: 0, roleChars: 0, modeChars: 0, skillBytes: 0, skillsDelivered: 0, skillsNotDelivered: 0, skillsUnmeasured: 0, toolListBytes: 0, toolListStarts: 0, toolListChars: 0, toolListCharStarts: 0, skillScans: 0, skillHits: 0, skillMisses: 0, skillInvalidations: 0, skillBytesRead: 0, skillTooLarge: 0, dropped: 0 }
  if (!r) return t
  const theirs = (s) => role === undefined || s.role === role
  for (const part of [...Object.values(r.projects ?? {}), ...(r.workspace ? [r.workspace] : [])]) {
    for (const a of part.api ?? []) {
      if (a.role === 'api' || !theirs(a)) continue
      t.apiRequests += a.count
      if (a.outcome !== 'ok') t.apiFailed += a.count
      if (a.outcome === 'cancelled') t.apiCancelled += a.count
      t.apiRequestBytes += a.requestBytes
      t.apiResponseBytes += a.responseBytes
      t.apiMs += a.totalMs
    }
    for (const m of part.mcp ?? []) {
      if (!theirs(m)) continue
      t.toolCalls += m.count
      // Every failed call, whatever its kind (HI-2553: refused, invalid, failed, or error from before them).
      if (m.outcome !== 'ok') t.toolErrors += m.count
      if (m.mode === 'detail') t.toolDetailCalls += m.count
      t.toolChars += m.chars
      t.toolBytes += m.bytes
      t.toolMs += m.totalMs
    }
    for (const g of part.guidance ?? []) {
      if (!theirs(g)) continue
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
      if (!theirs(c)) continue
      t.toolListBytes += c.toolsBytes
      t.toolListStarts += c.starts
      t.toolListChars += c.toolsChars ?? 0
      t.toolListCharStarts += c.charStarts ?? 0
    }
  }
  if (role !== undefined) return t
  const sk = r.skills
  if (sk) Object.assign(t, { skillScans: sk.scans.count, skillHits: sk.hits, skillMisses: sk.misses, skillInvalidations: sk.invalidations, skillBytesRead: sk.bytes, skillTooLarge: sk.tooLarge })
  t.dropped = r.dropped ?? 0
  return t
}

/**
 * A scenario's measures (#117): what Combwork's parts did between the snapshot before the launch and the one after the turn
 * (exact bytes and characters, calls, launches, the skill service's work), the Combwork calls the server ran (and how many
 * repeated one already made), and the session's own provider usage (a new session: its total is the scenario's; null
 * when the provider reported none).
 */
function measuresOf(before, after, observed, usage, subject) {
  const m = between(before, after)
  const calls = observed?.combworkCalls ?? []
  const seen = new Set()
  let repeated = 0
  for (const c of calls) {
    const k = `${c.tool} ${c.args ?? ''}`
    if (seen.has(k)) repeated++
    seen.add(k)
  }
  m.combworkCalls = calls.length
  m.combworkCallErrors = calls.filter((c) => !c.ok).length
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
  if (subject) Object.assign(m, splitOf(before, after, observed, subject))
  return m
}

/** What a report's totals grew by between two snapshots (all callers, or one caller role's). */
function between(before, after, role) {
  const a = metricsTotals(before, role)
  const b = metricsTotals(after, role)
  const m = Object.fromEntries(Object.keys(b).map((k) => [k, Math.max(0, b[k] - a[k])]))
  // The tool list's characters only when every start in the scenario had them counted (HI-2049): else unknown.
  if (m.toolListCharStarts !== m.toolListStarts) delete m.toolListChars
  delete m.toolListCharStarts
  return m
}

/** The skill service's work and drops: shared by every agent, so never in a part's measures (HI-2186). */
const SHARED_KEYS = ['skillScans', 'skillHits', 'skillMisses', 'skillInvalidations', 'skillBytesRead', 'skillTooLarge', 'dropped']
/** At most this many agents' rows, an `overflow` row (the rest, summed) among them; the subject's always kept. */
const AGENT_ROWS = 10

/** A caller role's measures between the snapshots, without what is shared. */
function roleMeasures(before, after, role) {
  const m = between(before, after, role)
  for (const k of SHARED_KEYS) delete m[k]
  return m
}

/**
 * Tool-call measures from the combwork servers' test log (HI-2186): `calls` (each { ok, direct, mode, chars, bytes }) and
 * `lists` (each server's tool list, { bytes, chars }), those of the measured window. A size is known only when every
 * call (or list) it sums logged it.
 */
function logMeasures(calls, lists) {
  const served = calls.filter((c) => !c.direct)
  const m = { toolCalls: served.length, toolErrors: served.filter((c) => !c.ok).length }
  const all = (k, f) => served.every((c) => f(c[k]))
  if (all('mode', (v) => typeof v === 'string')) m.toolDetailCalls = served.filter((c) => c.mode === 'detail').length
  if (all('chars', Number.isFinite)) m.toolChars = served.reduce((n, c) => n + c.chars, 0)
  if (all('bytes', Number.isFinite)) m.toolBytes = served.reduce((n, c) => n + c.bytes, 0)
  m.toolListStarts = lists.length
  if (lists.every((l) => Number.isFinite(l.bytes))) m.toolListBytes = lists.reduce((n, l) => n + l.bytes, 0)
  if (lists.every((l) => Number.isFinite(l.chars))) m.toolListChars = lists.reduce((n, l) => n + l.chars, 0)
  return m
}

/** What Combwork itself records as a tool call (its start view, src/main/metrics.ts START_VIEW_METRIC): in no server's log. */
const CW_OWN_CALLS = new Set(['session start view'])

/** The Combwork tool calls the servers reported, Combwork's own records left out. */
function servedCalls(r) {
  let n = 0
  for (const part of [...Object.values(r?.projects ?? {}), ...(r?.workspace ? [r.workspace] : [])]) for (const m of part.mcp ?? []) if (!CW_OWN_CALLS.has(m.tool)) n += m.count
  return n
}

/**
 * Where a served call or a tool list of the log is against the two metrics snapshots (HI-2186), by when its own report
 * reached Combwork (the server's `kind: 'reported'` line naming its id: when the report was sent, and when Combwork had taken
 * it). `snapshots`: each snapshot's request, from before it was sent to after its answer. 'before': Combwork had it before
 * the first snapshot was asked for; 'in': sent after the first's answer and taken before the last was asked for;
 * 'after': sent after the last's answer. Null when that can't be told: a report that overlapped a snapshot, or no report
 * on record for a line logged before the last snapshot's answer (its report failed, or was still on its way).
 */
function placeOf(x, reports, { before, after }) {
  const r = x.id ? reports.get(x.id) : undefined
  if (!r) return String(x.at ?? '') > after.end ? 'after' : null
  if (r.doneAt < before.start) return 'before'
  if (r.sentAt > before.end && r.doneAt < after.start) return 'in'
  if (r.sentAt > after.end) return 'after'
  return null
}

/**
 * The subject apart from the other agents (HI-2186), each from its own series or log lines, never one as the total less
 * the other. `subject`: { kind: 'assistant' | 'agent', agentId, snapshots ({ before, after }: each metrics snapshot's
 * request, { start, end }), complete (the metrics' coverage was whole), roster: [{ id, name, workflowRole }], lanes (the
 * run's, for builder and reviewer) }. `observed.allCombworkCalls`, `observed.mcpLists` and `observed.mcpReports`: Combwork's
 * servers' test log.
 *
 * The log is used only when it says, for every served call and tool list in it, on which side of each snapshot Combwork took
 * it (placeOf), by the line's own report: so the window holds the very calls the metrics counted between the
 * snapshots, not as many others. A call it can't place (a report that overlapped a snapshot, one not on record, a log
 * from before HI-2186 without ids), or a window whose counts still differ from the metrics', leaves the log unused
 * (`split: 'partial'`): unknown, never guessed. A fake's board move straight to the API (`direct`) ran no server and is
 * in no metric: a Combwork call of the window when logged between the snapshots' requests.
 *
 * - The Assistant as subject: Combwork's metrics by caller role, the Assistant's and project agents', every measure (with
 *   complete coverage only, else neither part).
 * - An agent as subject: its tool calls, replies and tool lists from the log, by agent, and the others' the same way.
 *   Its API and launch measures are unknown: Combwork's metrics don't say which agent a request or launch was.
 *
 * Also `agents`: each agent's Combwork calls (and tool lists) in the window, by its fixture name, the subject first.
 */
function splitOf(before, after, observed, subject) {
  const snaps = subject.snapshots
  const reports = new Map()
  for (const r of observed?.mcpReports ?? []) for (const id of r.ids ?? []) reports.set(id, r)
  const logged = observed?.allCombworkCalls ?? []
  const served = logged.filter((c) => !c.direct)
  const listed = observed?.mcpLists ?? []
  const places = snaps?.before && snaps?.after ? new Map([...served, ...listed].map((x) => [x, placeOf(x, reports, snaps)])) : null
  const placed = !!places && [...places.values()].every((p) => p !== null)
  const inside = (x) => places.get(x) === 'in'
  const calls = placed ? logged.filter((c) => (c.direct ? String(c.at ?? '') >= snaps.before.start && String(c.at ?? '') <= snaps.after.end : inside(c))) : []
  const lists = placed ? listed.filter(inside) : []
  // A guard, never the proof: the window's counts are the metrics' between the snapshots.
  const agrees = placed && calls.filter((c) => !c.direct).length === servedCalls(after) - servedCalls(before) && lists.length === between(before, after).toolListStarts
  const mine = subject.kind === 'assistant' ? (c) => c.role === 'assistant' : (c) => c.role !== 'assistant' && c.agent === subject.agentId
  const out = agrees ? { agents: agentRows(calls, lists, subject, mine) } : {}
  if (subject.kind === 'assistant') {
    if (!subject.complete) return { ...out, split: 'partial' }
    return { ...out, subject: roleMeasures(before, after, 'assistant'), others: roleMeasures(before, after, 'agent'), ...(agrees ? {} : { split: 'partial' }) }
  }
  if (!subject.complete || !agrees) return { ...out, split: 'partial' }
  const part = (c) => logMeasures(calls.filter(c), lists.filter(c))
  return { ...out, subject: part(mine), others: part((c) => !mine(c)) }
}

/**
 * Each agent's Combwork calls in the window, by its identity in the fixture (its name in the roster, the Assistant, or
 * `unattributed` for an agent the roster doesn't have), never by when its calls came: the subject first, then by name.
 * Past AGENT_ROWS, the rest in one `overflow` row (`agents`: how many), so the rows' calls always add up to the log's.
 */
function agentRows(calls, lists, subject, mine) {
  const byId = new Map((subject.roster ?? []).map((a) => [a.id, a]))
  const laneRole = new Map()
  for (const l of subject.lanes ?? []) {
    if (l.builder?.id) laneRole.set(l.builder.id, 'builder')
    if (l.reviewer?.id) laneRole.set(l.reviewer.id, 'reviewer')
  }
  const who = (c) => {
    if (c.role === 'assistant') return { agent: 'Assistant', role: 'assistant' }
    const a = byId.get(c.agent)
    if (!a) return { agent: 'unattributed', role: 'agent' }
    const r = laneRole.get(a.id) ?? a.workflowRole
    return { agent: a.name, role: r === 'builder' || r === 'reviewer' ? r : 'agent' }
  }
  const rows = new Map()
  const rowOf = (c) => {
    const w = who(c)
    const key = `${w.agent}\u0000${w.role}`
    if (!rows.has(key)) rows.set(key, { ...w, side: mine(c) ? 'subject' : 'other', calls: [], lists: [] })
    return rows.get(key)
  }
  // The subject's row even when it made no call.
  const self = subject.kind === 'assistant' ? { role: 'assistant', agent: null } : { role: 'agent', agent: subject.agentId }
  rowOf(self)
  for (const c of calls) rowOf(c).calls.push(c)
  for (const l of lists) rowOf(l).lists.push(l)
  const shaped = [...rows.values()].map((r) => {
    return { agent: r.agent, role: r.role, side: r.side, combworkCalls: r.calls.length, toolListStarts: r.lists.length }
  })
  const rank = (r) => (r.side === 'subject' ? 0 : r.agent === 'unattributed' ? 2 : 1)
  shaped.sort((a, b) => rank(a) - rank(b) || a.agent.localeCompare(b.agent, 'en') || a.role.localeCompare(b.role, 'en'))
  if (shaped.length <= AGENT_ROWS) return shaped
  const kept = shaped.slice(0, AGENT_ROWS - 1)
  const rest = shaped.slice(AGENT_ROWS - 1)
  const starts = rest.every((r) => r.toolListStarts !== undefined) ? { toolListStarts: rest.reduce((n, r) => n + r.toolListStarts, 0) } : {}
  return [...kept, { agent: 'overflow', role: 'agent', side: 'other', agents: rest.length, combworkCalls: rest.reduce((n, r) => n + r.combworkCalls, 0), ...starts }]
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
    app: { name: 'Combwork', version: appVersion },
    createdAt: meta.when,
    scope: { kind: 'workspace' },
    // A run with --dialect (HI-2439) says which, so Performance → Compare tells it from the Default's.
    label: `${meta.provider}${meta.model && meta.model !== '(default)' ? ` ${meta.model}` : ''}, fixtures v${meta.fixturesVersion}${meta.dialect ? `, dialect ${meta.dialect.path} ${meta.dialect.hash || 'Default'}` : ''}`,
    run: {
      fixturesVersion: meta.fixturesVersion,
      provider: meta.provider,
      providerId: meta.provider === 'fake-codex' || meta.provider === 'codex' ? 'codex' : meta.provider === 'fake-antigravity' ? 'antigravity' : 'claude-code',
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

/** The file in a results folder naming the runner writing it ({ pid, at }): while that process lives, the folder is held. */
const HOLD = 'runner.json'

/** Whether a process is alive (one we may not signal is). */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Whether a runner still writes into results folder `folder` (HI-2234): its runner.json names a live process. */
function resultsHeld(folder, alive = processAlive) {
  let hold
  try {
    hold = JSON.parse(fs.readFileSync(path.join(folder, HOLD), 'utf8'))
  } catch {
    return false
  }
  return !!hold && Number.isInteger(hold.pid) && hold.pid > 0 && alive(hold.pid)
}

/**
 * Which kind of run a results folder (`<time>-<provider>[-n]`) holds: 'fake' for the fake providers (fake, fake-codex,
 * fake-copilot, fake-antigravity: free, run every few minutes), else 'model' (a model trial, which costs money).
 */
function resultsKind(name) {
  return /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-fake(?:-|$)/.test(name) ? 'fake' : 'model'
}

/**
 * Keeps the newest `keep` run folders of each kind (resultsKind) in `dir` (named by time), removing older ones: fake
 * runs and model trials are counted apart, so fake runs never push a paid trial's results out (HI-2236). Never one a
 * card cites (spare) or one a runner still writes into (resultsHeld, HI-2234: another lane's fake runs starting every
 * few minutes pushed a two-hour model run's folder out from under it); neither counts towards `keep`.
 */
function pruneResults(dir, keep = LIMITS.resultsKept, spare = () => null, alive = processAlive) {
  if (!fs.existsSync(dir)) return
  const runs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(d.name) && !spare(path.join(dir, d.name)) && !resultsHeld(path.join(dir, d.name), alive))
    .map((d) => d.name)
    .sort()
  for (const kind of ['fake', 'model']) {
    const ofKind = runs.filter((n) => resultsKind(n) === kind)
    for (const old of ofKind.slice(0, Math.max(0, ofKind.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true })
  }
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

/**
 * A results folder of its own for a run (a second run in the same second gets -2, -3…, never another run's folder),
 * held by this process (runner.json) so no other run's prune removes it while it runs.
 */
function resultsFolder(dir, base, pid = process.pid) {
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 1; ; i++) {
    const f = path.join(dir, `${base}${i > 1 ? `-${i}` : ''}`)
    try {
      fs.mkdirSync(f)
      holdResults(f, pid)
      return f
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

/** Marks `folder` as held by process `pid`. */
function holdResults(folder, pid = process.pid) {
  fs.writeFileSync(path.join(folder, HOLD), JSON.stringify({ pid, at: new Date().toISOString() }))
}

/** Lets `folder` go (the run has written everything): a later prune may count it. Never fails. */
function releaseResults(folder) {
  try {
    fs.rmSync(path.join(folder, HOLD), { force: true })
  } catch {
    // Gone already, or can't be removed: the process ending lets it go anyway.
  }
}

/** How many times writeResults makes a vanished folder again before it gives up. */
const WRITE_ATTEMPTS = 3

/**
 * Writes `name` in the run's results folder `folder`, which this process holds. Should the folder be gone when the
 * write is made (something outside the prune removed it, HI-2234), it is made again and held, `rewrite()` puts back
 * each file the run had written (from what it holds in memory), onRecreated says so, and the write is tried again:
 * whenever the folder goes, before the write or during the recovery. Only a missing folder (ENOENT) is retried, at most
 * WRITE_ATTEMPTS times in all; any other error, or the folder still going after that, is thrown.
 */
function writeResults(folder, name, data, { rewrite = () => {}, onRecreated = () => {}, write = fs.writeFileSync } = {}) {
  let restore = false
  for (let attempt = 1; ; attempt++) {
    try {
      if (restore) {
        fs.mkdirSync(folder, { recursive: true })
        holdResults(folder)
        onRecreated()
        rewrite()
        restore = false
      }
      write(path.join(folder, name), data)
      return
    } catch (e) {
      // Gone (again, during the recovery too): the next attempt starts the recovery over, so the write is only made
      // once every earlier file is back.
      if (e.code !== 'ENOENT' || attempt >= WRITE_ATTEMPTS) throw e
      restore = true
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
 * with how to price one (a model Combwork has no price for is the usual reason).
 */
function budgetGate({ fake, budget, spentKnown, unknownCostTrials, allowUnknownCost, noCostModels = [] }) {
  if (fake) return { ok: true }
  if (unknownCostTrials > 0 && !allowUnknownCost) {
    const why = noCostModels.length
      ? ` with ${noCostModels.join(', ')} (if Combwork has no price for it, add one to SHIPPED_PRICES in src/shared/prices.ts from the provider's published prices, or pass --model with a priced model)`
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

module.exports = { SCHEMA, LIMITS, benchmarkOf, sampleOf, pruneResults, resultsHeld, resultsKind, saveBaseline, resultsFolder, releaseResults, writeResults, WRITE_ATTEMPTS, measuresOf, metricsTotals, parseBudget, budgetGate, spendText }
