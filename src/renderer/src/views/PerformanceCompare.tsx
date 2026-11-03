import { Children, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BENCHMARK_LIMITS, SCENARIO_MEASURES, USAGE_MEASURES, compareArtifacts, exportMeasure, sideMeasureLabel, compareScopeKey, keptAbout, keptLabel, type CompareScope, type Comparison, type KeptEntry, type MeasureDef, type MeasureDelta, type ScenarioComparison, type ScenarioStatus, type AgentCallsDelta } from '@shared/benchmark'
import type { MetricsQuery } from '@shared/metrics'
import { shownText, type Text } from '@shared/advanced'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import { moneyLabel } from '@shared/usageTotals'
import { formatDateTime } from '@shared/dates'
import { call } from '../api'
import { CodeText, Icon, IconButton, InfoTip, LoadFailed, Tooltip, sentences } from '../components/ui'
import { DataTable, useDateColumns, type DataColumn } from '../components/DataTable'
import { confirm, notify, prompt, useLanguage } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { cx, formatBytes, formatTokens } from '../util'

/**
 * Performance → Compare (#117): a baseline against a run, both kept for this page's scope (main/benchmarks.ts). Scenario
 * benchmarks (tests/scenarios, controlled) compare scenario by scenario, correctness first; Performance exports (real
 * use) compare per hour recorded. shared/benchmark.ts decides whether they are comparable and how each changed, and says
 * why as text (`reasonsText`, `notesText`), shown here in the user's language. The scope is the page's: the whole
 * workspace, its own work, or a project, and each lists and reads only its own.
 */

const M = {
  better: msg({ id: 'performance.compare.status.better', defaultMessage: 'Smaller, still correct', description: "A scenario's result in Performance → Compare: Hive gave it less context and it still passes every check." }),
  betterTip: msg({ id: 'performance.compare.status.betterTip', defaultMessage: 'Less Combwork context; every check that passed still passes and still runs; no more calls, failures or retries.', description: 'Tooltip of the "Smaller, still correct" result in Performance → Compare.' }),
  same: msg({ id: 'performance.compare.status.same', defaultMessage: 'No change', description: "A scenario's result in Performance → Compare." }),
  sameTip: msg({ id: 'performance.compare.status.sameTip', defaultMessage: 'Within 1% of the baseline, with the same correctness.', description: 'Tooltip of the "No change" result in Performance → Compare.' }),
  worse: msg({ id: 'performance.compare.status.worse', defaultMessage: 'Larger or worse', description: "A scenario's result in Performance → Compare." }),
  worseTip: msg({ id: 'performance.compare.status.worseTip', defaultMessage: 'More Combwork context, more calls, failures or retries, or a check that passed (or ran) less often.', description: 'Tooltip of the "Larger or worse" result in Performance → Compare.' }),
  smallerFailing: msg({ id: 'performance.compare.status.smallerFailing', defaultMessage: 'Smaller but failing', description: "A scenario's result in Performance → Compare: less context, but correctness got worse." }),
  smallerFailingTip: msg({ id: 'performance.compare.status.smallerFailingTip', defaultMessage: 'Less context, but a check passed (or ran) less often: not an improvement.', description: 'Tooltip of the "Smaller but failing" result in Performance → Compare.' }),
  failing: msg({ id: 'performance.compare.status.failing', defaultMessage: 'Failing', description: "A scenario's result in Performance → Compare." }),
  failingTip: msg({ id: 'performance.compare.status.failingTip', defaultMessage: 'Checks fail in the run (as often as in the baseline).', description: 'Tooltip of the "Failing" result in Performance → Compare.' }),
  incomplete: msg({ id: 'performance.compare.status.incomplete', defaultMessage: 'Incomplete', description: "A scenario's result in Performance → Compare: not judged." }),
  incompleteTip: msg({ id: 'performance.compare.status.incompleteTip', defaultMessage: 'Not judged: no completed sample on a side, or what it’s judged by wasn’t fully measured.', description: 'Tooltip of the "Incomplete" result in Performance → Compare.' }),
  onlyInBase: msg({ id: 'performance.compare.status.onlyInBase', defaultMessage: 'Only in baseline', description: "A scenario's result in Performance → Compare: only the baseline ran it." }),
  onlyInBaseTip: msg({ id: 'performance.compare.status.onlyInBaseTip', defaultMessage: 'The run didn’t run this scenario.', description: 'Tooltip of the "Only in baseline" result in Performance → Compare.' }),
  onlyInRun: msg({ id: 'performance.compare.status.onlyInRun', defaultMessage: 'Only in run', description: "A scenario's result in Performance → Compare: only the run ran it." }),
  onlyInRunTip: msg({ id: 'performance.compare.status.onlyInRunTip', defaultMessage: 'New in the run: no baseline for it.', description: 'Tooltip of the "Only in run" result in Performance → Compare.' }),
  summary: msg({ id: 'performance.compare.summary', defaultMessage: '{n, number} {status, select, better {smaller, still correct} same {no change} worse {larger or worse} smallerFailing {smaller but failing} failing {failing} incomplete {incomplete} onlyInBase {only in baseline} other {only in run}}', description: 'A badge above the scenarios in Performance → Compare: how many scenarios got each result ("3 smaller, still correct"). Lower case, as the results read in a list.' }),
  unknown: msg({ id: 'performance.compare.unknown', defaultMessage: 'unknown', description: "A measure's change in Performance → Compare when some samples didn't measure it." }),
  unknownTip: msg({ id: 'performance.compare.unknownTip', defaultMessage: 'Some samples didn’t measure it: unknown, not compared.', description: 'Tooltip of "unknown" in Performance → Compare.' }),
  ms: msg({ id: 'performance.compare.unit.ms', defaultMessage: '{n} ms', description: 'A time in milliseconds in Performance → Compare. {n} is the number, already formatted.' }),
  seconds: msg({ id: 'performance.compare.unit.seconds', defaultMessage: '{n} s', description: 'A time in seconds in Performance → Compare. {n} is the number, already formatted.' }),
  usePartTitle: msg({ id: 'performance.compare.usePart.title', defaultMessage: 'Use {project}’s part?', description: "Title of a question when a workspace's Performance export is imported on a project's page. {project} is the project's name." }),
  usePartMessage: msg({ id: 'performance.compare.usePart.message', defaultMessage: 'This is a workspace export. Only {project}’s part of it can be compared on this project’s page.', description: "A question when a workspace's Performance export is imported on a project's page. {project} is the project's name." }),
  usePartDetail: msg({ id: 'performance.compare.usePart.detail', defaultMessage: 'Work of no project (the Assistant, scripts) and other projects’ work are left out. Losses Combwork couldn’t attribute to a project are noted.', description: "A question when a workspace's Performance export is imported on a project's page: what using the project's part leaves out." }),
  usePartConfirm: msg({ id: 'performance.compare.usePart.confirm', defaultMessage: 'Use {project}’s part', description: "Button: imports only this project's part of a workspace's Performance export. {project} is the project's name." }),
  cantCompare: msg({ id: 'performance.compare.cantCompare', defaultMessage: 'Can’t compare that file', description: 'Title of an error importing a file to Performance → Compare; the reason follows.' }),
  kept: msg({ id: 'performance.compare.keptNotice', defaultMessage: 'Kept for comparison', description: "Title of a notice: a file or the current view was kept in Performance → Compare; its name follows." }),
  couldNotImport: msg({ id: 'performance.compare.couldNotImport', defaultMessage: 'Could not import the file', description: 'Title of an error importing a file to Performance → Compare; the reason follows.' }),
  keepTitle: msg({ id: 'performance.compare.keep.title', defaultMessage: 'Keep the current view', description: 'Title of the dialog that keeps what the Performance page shows, to compare with later. It asks for a name.' }),
  keepMessage: msg({ id: 'performance.compare.keep.message', defaultMessage: 'It is kept with its scope, range and filters, to compare with later.', description: 'The dialog that keeps what the Performance page shows, to compare with later.' }),
  keepPlaceholder: msg({ id: 'performance.compare.keep.placeholder', defaultMessage: 'Before the guidance change', description: "An example name for what is kept, in the Keep the current view dialog's name field." }),
  keepConfirm: msg({ id: 'performance.compare.keep.confirm', defaultMessage: 'Keep', description: 'Button of the Keep the current view dialog.' }),
  couldNotKeep: msg({ id: 'performance.compare.couldNotKeep', defaultMessage: 'Could not keep the current view', description: 'Title of an error keeping what the Performance page shows; the reason follows.' }),
  baseline: msg({ id: 'performance.compare.baseline', defaultMessage: 'Baseline', description: 'Performance → Compare: what a run is compared with (a list to choose it, a column, a row).' }),
  run: msg({ id: 'performance.compare.run', defaultMessage: 'Run', description: 'Performance → Compare: what is compared with the baseline (a list to choose it, a column, a row). A noun.' }),
  swap: msg({ id: 'performance.compare.swap', defaultMessage: 'Swap baseline and run', description: 'Button tooltip in Performance → Compare.' }),
  importTip: msg({ id: 'performance.compare.importTip', defaultMessage: 'Import a scenario benchmark (tests/scenarios: benchmark.json) or a Performance export (JSON).', description: 'Tooltip of the Import button in Performance → Compare. Keep tests/scenarios and benchmark.json (a folder and a file).' }),
  import: msg({ id: 'performance.compare.import', defaultMessage: 'Import…', description: 'Button in Performance → Compare: picks a file to compare.' }),
  keepTip: msg({ id: 'performance.compare.keepTip', defaultMessage: 'Keep what the Now view shows to compare with later: {what}.', description: 'Tooltip of the Keep current view button in Performance → Compare. {what} says what is kept (the scope and filters). "Now" is a view of the Performance page: name it as it is there.' }),
  keepCurrent: msg({ id: 'performance.compare.keepCurrent', defaultMessage: 'Keep current view', description: 'Button in Performance → Compare: keeps what the Performance page shows, to compare with later.' }),
  keptLoadTarget: msg({ id: 'performance.compare.keptLoadTarget', defaultMessage: 'the kept comparisons', description: 'Fills "Could not load {what}: {error}" in Performance → Compare.' }),
  comparisonLoadTarget: msg({ id: 'performance.compare.comparisonLoadTarget', defaultMessage: 'the comparison', description: 'Fills "Could not load {what}: {error}" in Performance → Compare.' }),
  oneMore: msg({ id: 'performance.compare.oneMore', defaultMessage: 'Keep or import one more to compare.', description: 'Performance → Compare with only one kept file.' }),
  nothingYet: msg({ id: 'performance.compare.nothingYet', defaultMessage: 'Nothing to compare yet.', description: 'Performance → Compare with nothing kept.' }),
  emptyHint: msg({ id: 'performance.compare.emptyHint', defaultMessage: 'Import a scenario benchmark ({scope, select, workspace {`npm run scenarios` writes benchmark.json} other {with the whole workspace selected: a benchmark is its whole test workspace’s}}) or a Performance export, or keep the current view before a change and again after it.', description: 'Performance → Compare with fewer than two kept files: how to get some. Keep `npm run scenarios` (a command) and benchmark.json (a file).' }),
  sameFile: msg({ id: 'performance.compare.sameFile', defaultMessage: 'The baseline and the run are the same file.', description: 'Performance → Compare with the same file chosen twice.' }),
  comparable: msg({ id: 'performance.compare.comparable', defaultMessage: 'Comparable: {kind, select, scenarios {the same scenarios, provider and setup.} other {the same scope and filters, per hour recorded.}}', description: 'A banner in Performance → Compare: the baseline and the run can be compared.' }),
  notComparable: msg({ id: 'performance.compare.notComparable', defaultMessage: 'Not comparable: {reasons} The numbers are shown, but a difference doesn’t mean a change.', description: 'A banner in Performance → Compare. {reasons} is one or more sentences saying why.' }),
  nothingMeasured: msg({ id: 'performance.compare.nothingMeasured', defaultMessage: 'Nothing measured.', description: "Performance → Compare's measures table when it has none." }),
  noScenarios: msg({ id: 'performance.compare.noScenarios', defaultMessage: 'No scenarios.', description: "Performance → Compare's scenarios table when it has none." }),
  sizesHint: msg({ id: 'performance.compare.sizesHint', defaultMessage: 'Sizes are exact bytes and characters of what Combwork gave the sessions; tokens are only what a provider reported. Skills on disk are what was available, not what a model read. A ~ marks a change within the samples’ spread.', description: "A note under Performance → Compare's scenarios. Keep ~ (it marks a change)." }),
  rowLabel: msg({ id: 'performance.compare.rowLabel', defaultMessage: '{id}: {status}. {open, select, yes {Close} other {Open}} its measures', description: "Accessible name of a scenario's row in Performance → Compare: its id, its result, and what clicking does." }),
  scenario: msg({ id: 'performance.compare.col.scenario', defaultMessage: 'Scenario', description: 'Column header in Performance → Compare.' }),
  result: msg({ id: 'performance.compare.col.result', defaultMessage: 'Result', description: 'Column header in Performance → Compare.' }),
  checks: msg({ id: 'performance.compare.col.checks', defaultMessage: 'Checks', description: 'Column header in Performance → Compare.' }),
  checksTip: msg({ id: 'performance.compare.col.checksTip', defaultMessage: 'On average a sample: checks passed ✓, failed ✗ and skipped – (a check only a model’s own work can meet is skipped for a fake), baseline → run.', description: 'Tooltip of the Checks column in Performance → Compare. Keep ✓, ✗ and – (they mark the counts).' }),
  context: msg({ id: 'performance.compare.col.context', defaultMessage: 'Combwork context', description: "Column header in Performance → Compare: the size of what Hive put in a session's context." }),
  toolReplies: msg({ id: 'performance.compare.col.toolReplies', defaultMessage: 'Tool replies', description: "Column header in Performance → Compare: the size of the replies of Hive's tools." }),
  calls: msg({ id: 'performance.compare.col.calls', defaultMessage: 'Calls (repeated)', description: "Column header in Performance → Compare: calls of Hive's tools, and how many repeated an earlier one." }),
  allAgentsTip: msg({ id: 'performance.compare.col.allAgentsTip', defaultMessage: 'Every agent’s in the scenario together, as the result judges them; a scenario’s details show the session under test apart.', description: "Tooltip of the Tool replies column in Performance → Compare (HI-2186): the figure is all agents' together (the session the scenario tests, and any agents it or Hive started), which is what the Result column judges." }),
  callsTip: msg({ id: 'performance.compare.col.callsTip', defaultMessage: 'The hive tool calls of the session under test (the Assistant, or the agent the scenario tests), and how many repeated an earlier one.', description: "Tooltip of the Calls (repeated) column in Performance → Compare (HI-2186). Keep hive (Hive's tools)." }),
  splitMeasure: msg({ id: 'performance.compare.splitMeasure', defaultMessage: '{measure} · {part, select, subject {{assistant, select, yes {the Assistant} other {the agent under test}}} others {other agents} other {all agents (judged)}}', description: "A row of a scenario's measures in Performance → Compare (HI-2186): {measure} is the measure's name (\"Tool calls\"); then whose: the session the scenario tests (the Assistant, or the agent under test), the other agents, or all of them together, which is what the result judges." }),
  callsByAgent: msg({ id: 'performance.compare.callsByAgent', defaultMessage: 'Combwork calls by agent in the measured window, baseline → run: {agents}', description: "A line under a scenario's measures in Performance → Compare (HI-2186): each agent's hive tool calls, on average a sample. {agents} is a list of entries like \"Coder (builder): 1 → 4\"." }),
  agentCalls: msg({ id: 'performance.compare.agentCalls', defaultMessage: '{agent}{role, select, builder { (builder)} reviewer { (reviewer)} other {}}: {base} → {run}', description: "An entry of the Hive calls by agent line in Performance → Compare (HI-2186): an agent's name (a test fixture's, such as Coder, or the Assistant), its role in a lane, and its calls in the baseline and in the run ({base} and {run} are numbers already formatted, or – when unknown). Glossary: builder, reviewer." }),
  agentAssistant: msg({ id: 'performance.compare.agent.assistant', defaultMessage: 'the Assistant', description: 'An agent in the Hive calls by agent line of Performance → Compare (HI-2186): the Hive Assistant.' }),
  agentUnattributed: msg({ id: 'performance.compare.agent.unattributed', defaultMessage: 'an agent not in the fixture', description: "An agent in the Hive calls by agent line of Performance → Compare (HI-2186): calls of an agent the scenario's fixture didn't make." }),
  agentOverflow: msg({ id: 'performance.compare.agent.overflow', defaultMessage: '{n, plural, one {# other agent} other {# other agents}}', description: 'An entry in the Hive calls by agent line of Performance → Compare (HI-2186): the agents past the list’s limit, their calls summed.' }),
  measure: msg({ id: 'performance.compare.col.measure', defaultMessage: 'Measure', description: 'Column header in Performance → Compare.' }),
  change: msg({ id: 'performance.compare.col.change', defaultMessage: 'Change', description: 'Column header in Performance → Compare: from the baseline to the run.' }),
  samples: msg({ id: 'performance.compare.samples', defaultMessage: '<b>{title}</b> · samples {base, number} → {run, number}', description: "The head of a scenario's details in Performance → Compare: its title, and how many samples the baseline and the run have." }),
  regressions: msg({ id: 'performance.compare.regressions', defaultMessage: 'Checks that passed or ran less often', description: "A heading in a scenario's details in Performance → Compare." }),
  failedInRun: msg({ id: 'performance.compare.failedInRun', defaultMessage: 'Failed in the run: <warn>{checks}</warn>', description: "A scenario's details in Performance → Compare: the checks that failed in the run (their names, in English)." }),
  usageNotCompared: msg({ id: 'performance.compare.usageNotCompared', defaultMessage: 'Provider tokens and cost: not compared (a fake’s are simulated; a model trial’s only when every sample on both sides reported them).', description: "A note in a scenario's details in Performance → Compare." }),
  keptCol: msg({ id: 'performance.compare.col.kept', defaultMessage: 'Kept', description: 'Column header of the kept comparisons list in Performance → Compare.' }),
  kind: msg({ id: 'performance.compare.col.kind', defaultMessage: 'Kind', description: 'Column header of the kept comparisons list in Performance → Compare.' }),
  when: msg({ id: 'performance.compare.col.when', defaultMessage: 'When', description: 'Column header of the kept comparisons list in Performance → Compare: when it was kept.' }),
  unpin: msg({ id: 'performance.compare.unpin', defaultMessage: 'Unpin', description: 'Button tooltip on a kept comparison in Performance → Compare.' }),
  pin: msg({ id: 'performance.compare.pin', defaultMessage: 'Pin (never removed to make room)', description: 'Button tooltip on a kept comparison in Performance → Compare.' }),
  remove: msg({ id: 'performance.compare.remove', defaultMessage: 'Remove', description: 'Button tooltip on a kept comparison in Performance → Compare.' }),
  couldNotChange: msg({ id: 'performance.compare.couldNotChange', defaultMessage: 'Could not change the kept comparisons', description: 'Title of an error pinning or removing a kept comparison; the reason follows.' }),
  keptList: msg({ id: 'performance.compare.keptList', defaultMessage: 'Kept for comparison ({n, number})', description: 'Heading of the kept comparisons list in Performance → Compare, with how many there are.' }),
  keptListTip: msg({ id: 'performance.compare.keptListTip', defaultMessage: 'Kept in the workspace’s .hive/metrics/benchmarks (this machine’s), at most {max, number}: when full, the oldest unpinned one goes. Pin one to keep it.', description: 'Tooltip of the kept comparisons list in Performance → Compare. Keep .hive/metrics/benchmarks (a folder).' }),
  nothingKept: msg({ id: 'performance.compare.nothingKept', defaultMessage: 'Nothing kept.', description: 'The kept comparisons list in Performance → Compare when empty.' }),
  kindScenarios: msg({ id: 'performance.compare.kind.scenarios', defaultMessage: 'Scenario benchmark', description: 'The kind of a kept comparison: a test run of scenarios.' }),
  kindExport: msg({ id: 'performance.compare.kind.export', defaultMessage: 'Performance view', description: 'The kind of a kept comparison: what the Performance page showed, or an export of it.' })
}

const STATUS: Record<ScenarioStatus, { label: Msg; tone: string; tip: Msg; key: string }> = {
  better: { label: M.better, tone: 'success', tip: M.betterTip, key: 'better' },
  same: { label: M.same, tone: 'info', tip: M.sameTip, key: 'same' },
  worse: { label: M.worse, tone: 'warn', tip: M.worseTip, key: 'worse' },
  'smaller-but-failing': { label: M.smallerFailing, tone: 'error', tip: M.smallerFailingTip, key: 'smallerFailing' },
  failing: { label: M.failing, tone: 'error', tip: M.failingTip, key: 'failing' },
  incomplete: { label: M.incomplete, tone: 'warn', tip: M.incompleteTip, key: 'incomplete' },
  'only-in-base': { label: M.onlyInBase, tone: 'info', tip: M.onlyInBaseTip, key: 'onlyInBase' },
  'only-in-run': { label: M.onlyInRun, tone: 'info', tip: M.onlyInRunTip, key: 'onlyInRun' }
}

/** Worst first: what needs looking at leads the table. */
const STATUS_ORDER: ScenarioStatus[] = ['smaller-but-failing', 'worse', 'failing', 'incomplete', 'better', 'same', 'only-in-base', 'only-in-run']

/** Each kind's measures by key: a scenario's (with provider usage) and an export's share keys but not labels or tips. */
type Defs = Pick<Map<string, MeasureDef>, 'get'>
const SCENARIO_DEFS: Defs = new Map([...SCENARIO_MEASURES, ...USAGE_MEASURES].map((m) => [m.key, m]))
/** An export's measures, a workflow role's (`<measure>.<role>`, HI-2049) as its measure. */
const EXPORT_DEFS: Defs = { get: (key) => exportMeasure(key)?.def }

/** Markup in messages, as React children (keyed by Children.toArray where they are shown). */
const strong = (c: ReactNode[]): ReactNode => <strong>{c}</strong>
const warnText = (c: ReactNode[]): ReactNode => <span className="warn-text">{c}</span>

/** Sentences one after the other, as the language spaces them. */
const joined = (texts: Text[]): ReactNode => texts.map((t) => shownText(t) as ReactNode).reduce((a, b) => sentences(a, b))

function value(def: MeasureDef | undefined, v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  switch (def?.unit) {
    case 'bytes':
      return formatBytes(v)
    case 'tokens':
      return formatTokens(v)
    case 'usd':
      return moneyLabel(v)
    case 'ms':
      return tr(M.ms, { n: fmt.number(Math.round(v)) })
    case 's':
      return tr(M.seconds, { n: fmt.number(Math.round(v)) })
    default:
      return Math.abs(v) < 10 && !Number.isInteger(v) ? fmt.figure(v, 1) : fmt.number(Math.round(v))
  }
}

function Delta({ d, defs }: { d: MeasureDelta; defs: Defs }) {
  if (d.incomplete)
    return (
      <Tooltip content={tr(M.unknownTip)}>
        <span className="warn-text">{tr(M.unknown)}</span>
      </Tooltip>
    )
  if (d.delta === null) return <span className="faint">—</span>
  const decimals = Math.abs(d.pct ?? 0) < 0.1 ? 1 : 0
  const pct = d.pct === null ? '' : ` (${fmt.number(d.pct, { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals, signDisplay: 'exceptZero' })})`
  const tone = Math.abs(d.pct ?? (d.delta ? 1 : 0)) <= 0.01 ? 'faint' : d.delta < 0 ? 'good-text' : 'warn-text'
  return (
    <span className={tone}>
      {d.delta > 0 ? '+' : d.delta < 0 ? '−' : ''}
      {value(defs.get(d.key), Math.abs(d.delta))}
      {pct}
      {d.withinSpread ? <span className="faint"> ~</span> : null}
    </span>
  )
}

const range = (d: MeasureDelta, side: 'base' | 'run', defs: Defs): string => {
  const s = d[side]
  if (!s) return '—'
  const def = defs.get(d.key)
  return s.n > 1 && s.min !== s.max ? `${value(def, s.mean)} (${value(def, s.min)}–${value(def, s.max)})` : value(def, s.mean)
}

export function ComparePanel({ workspacePath, scope, query, keeps }: { workspacePath: string; scope: CompareScope; query: () => MetricsQuery; keeps: string }) {
  const scopeKey = compareScopeKey(scope)
  const [version, setVersion] = useState(0)
  const list = useScopedLoad<{ entries: KeptEntry[]; base: string | null; run: string | null; notice?: string }>(`${workspacePath}|${scopeKey}|${version}`)
  const { load: loadList } = list
  useEffect(() => {
    loadList(`${workspacePath}|${scopeKey}|${version}`, () => call('benchmarks:list', scope))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, scopeKey, version, loadList])
  const entries = list.data?.entries ?? []
  const [base, setBase] = useState<string | null>(null)
  const [run, setRun] = useState<string | null>(null)
  // The scope's remembered choice, or the two newest.
  useEffect(() => {
    if (!list.data) return
    setBase(list.data.base ?? list.data.entries[1]?.id ?? null)
    setRun(list.data.run ?? list.data.entries[0]?.id ?? null)
  }, [list.data])
  const choose = (b: string | null, r: string | null): void => {
    setBase(b)
    setRun(r)
    void call('benchmarks:select', scope, b, r).catch(() => undefined)
  }
  const refresh = (): void => setVersion((v) => v + 1)

  // The comparison: one per workspace, scope and pair, so a late answer for another (a switch while reading) is ignored.
  const pairKey = `${workspacePath}|${scopeKey}|${base}|${run}`
  const cmp = useScopedLoad<Comparison>(pairKey)
  const { load: loadCmp } = cmp
  useEffect(() => {
    if (!base || !run) return
    loadCmp(pairKey, async () => compareArtifacts(await call('benchmarks:read', scope, base), await call('benchmarks:read', scope, run)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, loadCmp])

  const importFile = async (): Promise<void> => {
    try {
      let r = await call('benchmarks:import', scope)
      if (r && 'ask' in r) {
        const project = r.ask.project
        const ok = await confirm({ title: tr(M.usePartTitle, { project }), message: tr(M.usePartMessage, { project }), detail: tr(M.usePartDetail), confirmLabel: tr(M.usePartConfirm, { project }) })
        r = await call('benchmarks:import', scope, { token: r.ask.token, useProjectPart: ok })
        if (!ok) return
      }
      if (!r) return
      if ('error' in r) return notify('error', tr(M.cantCompare), r.errorText ? shownText(r.errorText) : r.error)
      if ('entry' in r) {
        notify('success', tr(M.kept), shownText(keptLabel(r.entry)))
        refresh()
      }
    } catch (e) {
      notify('error', tr(M.couldNotImport), String((e as Error).message ?? e))
    }
  }
  const keepCurrent = async (): Promise<void> => {
    const label = await prompt({ title: tr(M.keepTitle), message: tr(M.keepMessage), placeholder: tr(M.keepPlaceholder), confirmLabel: tr(M.keepConfirm) })
    if (label === null) return
    try {
      const e = await call('benchmarks:keep', query(), label)
      notify('success', tr(M.kept), shownText(keptLabel(e)))
      refresh()
    } catch (err) {
      notify('error', tr(M.couldNotKeep), String((err as Error).message ?? err))
    }
  }

  return (
    <div className="perf-compare">
      <div className="overview-head perf-controls">
        <label className="perf-filter">
          {tr(M.baseline)}
          <select className="input" value={base ?? ''} onChange={(e) => choose(e.target.value || null, run)} aria-label={tr(M.baseline)}>
            <option value="">—</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {shownText(keptLabel(e))}
              </option>
            ))}
          </select>
        </label>
        <label className="perf-filter">
          {tr(M.run)}
          <select className="input" value={run ?? ''} onChange={(e) => choose(base, e.target.value || null)} aria-label={tr(M.run)}>
            <option value="">—</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {shownText(keptLabel(e))}
              </option>
            ))}
          </select>
        </label>
        <IconButton icon="arrow-swap" title={tr(M.swap)} onClick={() => choose(run, base)} disabled={!base && !run} />
        <div className="grow" />
        <Tooltip content={tr(M.importTip)}>
          <button className="btn small subtle" onClick={() => void importFile()}>
            <Icon name="cloud-upload" /> {tr(M.import)}
          </button>
        </Tooltip>
        <Tooltip content={tr(M.keepTip, { what: keeps })}>
          <button className="btn small subtle" onClick={() => void keepCurrent()}>
            <Icon name="pin" /> {tr(M.keepCurrent)}
          </button>
        </Tooltip>
      </div>

      {list.error && <LoadFailed what={tr(M.keptLoadTarget)} error={list.error} onRetry={refresh} />}
      {list.data?.notice && (
        <div className="banner info perf-banner">
          <Icon name="info" /> {list.data.notice}
        </div>
      )}
      {list.data && entries.length < 2 && (
        <div className="empty-state perf-empty">
          <Icon name="git-compare" />
          {entries.length ? tr(M.oneMore) : tr(M.nothingYet)}
          <span className="hint">
            <CodeText text={tr(M.emptyHint, { scope: scope.kind === 'project' || scope.own ? 'other' : 'workspace' })} />
          </span>
        </div>
      )}
      {base && run && base === run && <p className="hint">{tr(M.sameFile)}</p>}
      {cmp.error && <LoadFailed what={tr(M.comparisonLoadTarget)} error={cmp.error} onRetry={() => loadCmp(pairKey, async () => compareArtifacts(await call('benchmarks:read', scope, base!), await call('benchmarks:read', scope, run!)))} />}
      {cmp.data && base && run && base !== run && <ComparisonView c={cmp.data} base={entries.find((e) => e.id === base)} run={entries.find((e) => e.id === run)} />}

      {entries.length > 0 && <KeptList entries={entries} scope={scope} onChange={refresh} />}
    </div>
  )
}

function ComparisonView({ c, base, run }: { c: Comparison; base?: KeptEntry; run?: KeptEntry }) {
  const notes = c.notesText
  return (
    <div className="perf-comparison">
      <dl className="perf-pair hint">
        <dt>{tr(M.baseline)}</dt>
        <dd>{base ? shownText(keptAbout(base)) : '—'}</dd>
        <dt>{tr(M.run)}</dt>
        <dd>{run ? shownText(keptAbout(run)) : '—'}</dd>
      </dl>
      {c.comparable ? (
        <div className="banner success perf-banner">
          <Icon name="check" /> {tr(M.comparable, { kind: c.kind })}
        </div>
      ) : (
        <div className="banner warn perf-banner">
          <Icon name="warning" /> {Children.toArray(tRich<ReactNode>(M.notComparable, { reasons: joined(c.reasonsText) }))}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="perf-notes hint">
          {notes.map((n, i) => (
            <li key={i}>{shownText(n)}</li>
          ))}
        </ul>
      )}
      {c.kind === 'scenarios' && c.scenarios && <ScenarioTable scenarios={c.scenarios} summary={c.summary} />}
      {c.kind === 'export' && c.rows && <DataTable id="perf-compare-measures" rows={c.rows} columns={measureColumns()} rowKey={(d) => d.key} empty={tr(M.nothingMeasured)} />}
    </div>
  )
}

function ScenarioTable({ scenarios, summary }: { scenarios: ScenarioComparison[]; summary: Comparison['summary'] }) {
  const language = useLanguage()
  const [open, setOpen] = useState<string | null>(null)
  // Worst first, then by name: the table's default order (the Result column, ascending).
  const rows = useMemo(() => [...scenarios].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id.localeCompare(b.id)), [scenarios])
  const toggle = useCallback((s: ScenarioComparison) => setOpen((o) => (o === s.id ? null : s.id)), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo((): DataColumn<ScenarioComparison>[] => scenarioColumns(open), [open, language])
  return (
    <>
      <p className="perf-summary">
        {STATUS_ORDER.filter((s) => summary[s]).map((s) => (
          <span key={s} className={`badge ${STATUS[s].tone}`}>
            {tr(M.summary, { n: summary[s] ?? 0, status: STATUS[s].key })}
          </span>
        ))}
      </p>
      <DataTable
        id="perf-compare-scenarios"
        className="perf-scenarios"
        rows={rows}
        columns={columns}
        rowKey={(s) => s.id}
        defaultSort={WORST_FIRST}
        defaultPageSize={50}
        onRowClick={toggle}
        rowLabel={(s) => tr(M.rowLabel, { id: s.id, status: tr(STATUS[s.status].label), open: open === s.id ? 'yes' : 'no' })}
        rowClassName={(s) => open === s.id && 'selected'}
        detail={detailOf(open)}
        empty={tr(M.noScenarios)}
      />
      <p className="hint">{tr(M.sizesHint)}</p>
    </>
  )
}

const WORST_FIRST = { key: 'result', desc: false }
/** The open scenario's measures, under its row. */
const detailOf = (open: string | null) => (s: ScenarioComparison) => (open === s.id ? <ScenarioDetail s={s} /> : null)
const measureOf = (s: ScenarioComparison, k: string): MeasureDelta | undefined => s.measures.find((m) => m.key === k)
/** A change as a sortable number: its share where there is one, else its size; unknown and none sort last. */
const changeOf = (d: MeasureDelta | undefined): number | null => (!d || d.incomplete || d.delta === null ? null : (d.pct ?? d.delta))

/** The scenarios' columns (built when rendered: their headers are in the language shown). */
function scenarioColumns(open: string | null): DataColumn<ScenarioComparison>[] {
  return [
    {
      key: 'scenario',
      header: tr(M.scenario),
      cell: (s) => (
        <>
          <Icon name={open === s.id ? 'chevron-down' : 'chevron-right'} /> {s.id}
        </>
      ),
      sortValue: (s) => s.id,
      filter: { kind: 'text', value: (s) => `${s.id} ${s.title}` }
    },
    {
      key: 'result',
      header: tr(M.result),
      cell: (s) => (
        <Tooltip content={tr(STATUS[s.status].tip)}>
          <span className={`badge ${STATUS[s.status].tone}`}>{tr(STATUS[s.status].label)}</span>
        </Tooltip>
      ),
      sortValue: (s) => STATUS_ORDER.indexOf(s.status),
      filter: { kind: 'choice', value: (s) => tr(STATUS[s.status].label) }
    },
    {
      key: 'checks',
      header: tr(M.checks),
      headerTip: tr(M.checksTip),
      num: true,
      descFirst: true,
      cell: (s) => (
        <span className={cx(s.regressions.length > 0 && 'warn-text')}>
          {s.quality.base.n ? counts(s.checks.base) : '—'} → {s.quality.run.n ? counts(s.checks.run) : '—'}
        </span>
      ),
      sortValue: (s) => (s.quality.run.n ? s.checks.run.failed : null)
    },
    {
      key: 'context',
      header: tr(M.context),
      headerTip: tr(SCENARIO_DEFS.get('contextBytes')!.tip),
      num: true,
      descFirst: true,
      cell: (s) => {
        const ctx = measureOf(s, 'contextBytes')
        return ctx ? (
          <>
            {range(ctx, 'run', SCENARIO_DEFS)} <Delta d={ctx} defs={SCENARIO_DEFS} />
          </>
        ) : (
          '—'
        )
      },
      sortValue: (s) => changeOf(measureOf(s, 'contextBytes'))
    },
    {
      key: 'tool',
      header: tr(M.toolReplies),
      headerTip: tr(M.allAgentsTip),
      num: true,
      descFirst: true,
      cell: (s) => {
        const tool = measureOf(s, 'toolChars')
        return tool ? <Delta d={tool} defs={SCENARIO_DEFS} /> : '—'
      },
      sortValue: (s) => changeOf(measureOf(s, 'toolChars'))
    },
    {
      key: 'calls',
      header: tr(M.calls),
      headerTip: tr(M.callsTip),
      num: true,
      descFirst: true,
      cell: (s) => {
        const calls = measureOf(s, 'hiveCalls')
        const rep = measureOf(s, 'repeatedCalls')
        return (
          <>
            {calls?.run ? `${value(undefined, calls.run.mean)} (${value(undefined, rep?.run?.mean ?? 0)})` : '—'} {calls ? <Delta d={calls} defs={SCENARIO_DEFS} /> : null}
          </>
        )
      },
      sortValue: (s) => measureOf(s, 'hiveCalls')?.run?.mean ?? null
    }
  ]
}

/** An export comparison's measures: baseline, run and the change (sortable, the biggest change first). */
function measureColumns(): DataColumn<MeasureDelta>[] {
  const label = (d: MeasureDelta): string => {
    const m = exportMeasure(d.key)
    if (!m) return d.key
    return m.side ? shownText(sideMeasureLabel(tr(m.def.label), m.side)) : tr(m.def.label)
  }
  return [
    {
      key: 'measure',
      header: tr(M.measure),
      cell: (d) => (
        <>
          {label(d)} <InfoTip text={EXPORT_DEFS.get(d.key) ? tr(EXPORT_DEFS.get(d.key)!.tip) : ''} />
        </>
      )
    },
    { key: 'base', header: tr(M.baseline), num: true, cell: (d) => range(d, 'base', EXPORT_DEFS) },
    { key: 'run', header: tr(M.run), num: true, cell: (d) => range(d, 'run', EXPORT_DEFS) },
    { key: 'change', header: tr(M.change), num: true, descFirst: true, cell: (d) => <Delta d={d} defs={EXPORT_DEFS} />, sortValue: (d) => changeOf(d) }
  ]
}

/** A side's checks on average: passed, failed, skipped. */
const counts = (c: { passed: number; failed: number; skipped: number }): string => {
  const n = (v: number): string => (Number.isInteger(v) ? fmt.number(v) : fmt.figure(v, 1))
  return `${n(c.passed)}✓${c.failed ? ` ${n(c.failed)}✗` : ''}${c.skipped ? ` ${n(c.skipped)}–` : ''}`
}

/** A measure row of a scenario's details: its name (and whose, for a part), baseline, run and change. */
type DetailRow = { d: MeasureDelta; part?: 'subject' | 'others' | 'all' }

/**
 * A scenario's rows: each measure split by agent (HI-2186) as the subject's first, then the other agents', then all of
 * theirs (what the result judges); every other measure, and every measure without a split, as before.
 */
function detailRows(s: ScenarioComparison): DetailRow[] {
  const out: DetailRow[] = []
  for (const d of s.measures) {
    const own = s.split?.subject.find((x) => x.key === d.key)
    const others = s.split?.others.find((x) => x.key === d.key)
    // Split only where a part has something (a measure that is 0 for every agent stays one row).
    const some = (x: MeasureDelta): boolean => !!(x.base?.mean || x.run?.mean)
    if (own && others && (some(own) || some(others))) out.push({ d: own, part: 'subject' }, { d: others, part: 'others' }, { d, part: 'all' })
    else out.push({ d })
  }
  return [...out, ...(s.usage ?? []).map((d) => ({ d }))]
}

/** An agent in the calls-by-agent line: its fixture name, or what stands for it. */
const agentName = (a: AgentCallsDelta): string => (a.agent === 'Assistant' && a.role === 'assistant' ? tr(M.agentAssistant) : a.agent === 'unattributed' ? tr(M.agentUnattributed) : a.agent === 'overflow' ? tr(M.agentOverflow, { n: a.agents ?? 0 }) : a.agent)
const callCount = (v: number | null): string => (v === null ? '–' : value(undefined, v))

function ScenarioDetail({ s }: { s: ScenarioComparison }) {
  const rows = detailRows(s)
  const notes = s.notesText
  return (
    <div className="perf-detail-body">
      <p>{Children.toArray(tRich<ReactNode>(M.samples, { b: strong, title: s.title, base: s.samples.base, run: s.samples.run }))}</p>
      {notes.length > 0 && (
        <ul className="perf-notes hint">
          {notes.map((n, i) => (
            <li key={i}>{shownText(n)}</li>
          ))}
        </ul>
      )}
      {s.regressions.length > 0 && (
        <div className="perf-regressions">
          <strong className="warn-text">{tr(M.regressions)}</strong>
          <ul>
            {s.regressions.map((r) => (
              <li key={r.name}>
                {r.name}: {counts(r.base)} → {counts(r.run)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.failedChecks.length > 0 && <p className="hint">{Children.toArray(tRich<ReactNode>(M.failedInRun, { warn: warnText, checks: s.failedChecks.join('; ') }))}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>{tr(M.measure)}</th>
            <th className="num">{tr(M.baseline)}</th>
            <th className="num">{tr(M.run)}</th>
            <th className="num">{tr(M.change)}</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter(({ d }) => d.base || d.run)
            .map(({ d, part }) => {
              const def = SCENARIO_DEFS.get(d.key)
              const name = def ? tr(def.label) : d.key
              return (
                <tr key={`${d.key}.${part ?? ''}`} className={cx(part && part !== 'subject' && 'perf-part')}>
                  <td>
                    {part ? tr(M.splitMeasure, { measure: name, part, assistant: s.subject === 'assistant' ? 'yes' : 'no' }) : name} <InfoTip text={def ? tr(def.tip) : ''} />
                  </td>
                  <td className="num">{range(d, 'base', SCENARIO_DEFS)}</td>
                  <td className="num">{range(d, 'run', SCENARIO_DEFS)}</td>
                  <td className="num">
                    <Delta d={d} defs={SCENARIO_DEFS} />
                  </td>
                </tr>
              )
            })}
        </tbody>
      </table>
      {s.agents && s.agents.length > 0 && <p className="hint perf-agents">{tr(M.callsByAgent, { agents: fmt.list(s.agents.map((a) => tr(M.agentCalls, { agent: agentName(a), role: a.role, base: callCount(a.base), run: callCount(a.run) })), 'unit') })}</p>}
      {!s.usage && <p className="hint">{tr(M.usageNotCompared)}</p>}
    </div>
  )
}

const KIND: Record<KeptEntry['kind'], Msg> = { scenarios: M.kindScenarios, export: M.kindExport }

/** The kept list's columns: what it is, its kind, when it was kept, and pin and remove. */
function keptColumns(scope: CompareScope, act: (fn: () => Promise<unknown>) => Promise<void>): DataColumn<KeptEntry>[] {
  return [
    {
      key: 'label',
      header: tr(M.keptCol),
      cell: (e) => (
        <>
          <Icon name={e.kind === 'scenarios' ? 'beaker' : 'pulse'} /> {shownText(keptLabel(e))}
          <div className="faint">{shownText(keptAbout(e))}</div>
        </>
      ),
      sortValue: (e) => shownText(keptLabel(e)),
      filter: { kind: 'text', value: (e) => `${shownText(keptLabel(e))} ${shownText(keptAbout(e))}` }
    },
    { key: 'kind', header: tr(M.kind), className: 'nowrap', cell: (e) => tr(KIND[e.kind]), sortValue: (e) => tr(KIND[e.kind]), filter: { kind: 'choice', value: (e) => tr(KIND[e.kind]) } },
    { key: 'keptAt', header: tr(M.when), num: true, descFirst: true, className: 'faint', cell: (e) => formatDateTime(e.keptAt), sortValue: (e) => e.keptAt, filter: { kind: 'text', value: (e) => formatDateTime(e.keptAt) } },
    {
      key: 'actions',
      header: '',
      num: true,
      className: 'nowrap',
      cell: (e) => (
        <>
          <IconButton icon={e.pinned ? 'pinned' : 'pin'} title={e.pinned ? tr(M.unpin) : tr(M.pin)} onClick={() => void act(() => call('benchmarks:pin', scope, e.id, !e.pinned))} />
          <IconButton icon="trash" title={tr(M.remove)} onClick={() => void act(() => call('benchmarks:remove', scope, e.id))} />
        </>
      )
    }
  ]
}

function KeptList({ entries, scope, onChange }: { entries: KeptEntry[]; scope: CompareScope; onChange: () => void }) {
  const language = useLanguage()
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      onChange()
    } catch (e) {
      notify('error', tr(M.couldNotChange), String((e as Error).message ?? e))
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useDateColumns(useMemo(() => keptColumns(scope, act), [scope, language]))
  return (
    <details className="perf-kept">
      <summary>
        {tr(M.keptList, { n: entries.length })} <InfoTip text={tr(M.keptListTip, { max: BENCHMARK_LIMITS.kept })} />
      </summary>
      <DataTable
        id="perf-kept"
        rows={entries}
        columns={columns}
        rowKey={(e) => e.id}
        defaultPageSize={10}
        filterFrom={10}
        empty={tr(M.nothingKept)}
      />
    </details>
  )
}
