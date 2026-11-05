/**
 * Comparing two measurements of Combwork's own costs (#117): scenario benchmarks (tests/scenarios writes them,
 * "combwork-benchmark/1": controlled runs, each sample with its correctness checks) and Performance exports
 * ("combwork-metrics/1": real use over a range, kept as a summary). Pure, so the app and tests share it. Every file, imported
 * or kept, is read through the same normalisers as untrusted input (nothing is cast and returned as it was). A
 * comparison says whether the two can be compared at all (and why not), compares like with like (the same scenarios,
 * scope, filters), keeps what wasn't measured unknown (never zero), and never calls a smaller result better when the work
 * it did got worse: fewer checks passing or running, or more failures, calls or retries.
 *
 * Its text is read both by code and people (#1104, the SPEC's "Text read by both"): what the window shows is messages
 * (measures' labels and tips) or text as data beside an English field (a comparison's `reasonsText` and `notesText`, a
 * refusal's `errorText`), shown in the user's language when rendered; the English fields stay for tests and code. Names
 * a kept comparison is stored under (its default label, `about`, `derived`) stay as written in its file.
 */
import { msg, type Msg } from './i18n/msg'
import { englishText, listOf, withValues, type Text, type TextPart } from './advanced'
import { utf8Bytes, type MetricsRole, type MetricsScope } from './metrics'
import { formatDate, formatDateTime } from './dates'
import { moneyLabel } from './usageTotals'

export const BENCHMARK_SCHEMA = 'combwork-benchmark/1'
export const METRICS_EXPORT_SCHEMA = 'combwork-metrics/1'
/**
 * A Performance export's id as 1.0 wrote it (HI-2587): still imported, as a 1.0 user's kept exports would otherwise be
 * lost. A benchmark's old id isn't: those files are development runs', made again with the new one.
 */
const OLD_METRICS_EXPORT_SCHEMA = 'hive-metrics/1'

/** Bounds on what is read and kept: an artifact is checked as untrusted input. */
// scenarios: 200 since #1444 took the set past 100 (the last ones were dropped from benchmarks).
export const BENCHMARK_LIMITS = { fileBytes: 2 * 1024 * 1024, scenarios: 200, samples: 20, checks: 60, failedChecks: 20, skills: 60, text: 200, kept: 20, projects: 100, series: 2000, agents: 10 }

/**
 * What a comparison is about: the whole workspace, the workspace's own work (no project's: the Assistant, scripts), or
 * one project. A scenario benchmark is the whole workspace's; an export is its scope's (own work is its own scope).
 */
export type CompareScope = { kind: 'workspace'; own?: true } | { kind: 'project'; project: string }

/** A scope's key: the workspace, its own work, or a project (by name, case-insensitive). */
export const compareScopeKey = (s: CompareScope): string => (s.kind === 'project' ? `project:${s.project.toLowerCase()}` : s.own ? 'own' : 'workspace')

/** A page's scope as a comparison's: the workspace view with "Workspace's own work" chosen is its own scope. */
export const compareScopeOf = (scope: MetricsScope, own: boolean): CompareScope => (scope.kind === 'project' ? scope : own ? { kind: 'workspace', own: true } : { kind: 'workspace' })

/** What the comparison says: shown in the window (Performance → Compare), with its English kept beside it for code. */
const M = {
  scopeName: msg({ id: 'performance.compare.scopeName', defaultMessage: '{kind, select, project {project {project}} own {the workspace’s own work} other {the whole workspace}}', description: 'A scope of Performance → Compare, inside "Different scopes: {base} and {run}.": a project (its name), the workspace’s own work (no project’s: the Assistant, scripts), or the whole workspace.' }),
  filters: msg({ id: 'performance.compare.filters', defaultMessage: '{role}, {provider}{own, select, yes {, own work} other {}}', description: "A Performance export's filters, inside \"Different filters ({base} and {run}).\": {role} is a role name or \"everyone\", {provider} a provider's id or \"all providers\"; \"own work\" when it is the workspace's own work." }),
  everyone: msg({ id: 'performance.compare.filters.everyone', defaultMessage: 'everyone', description: "A Performance export's role filter when it has none: everyone's work. Lower case, in a list of filters." }),
  allProviders: msg({ id: 'performance.compare.filters.allProviders', defaultMessage: 'all providers', description: "A Performance export's provider filter when it has none. Lower case, in a list of filters." }),
  // Why two can't be compared.
  differentKinds: msg({ id: 'performance.compare.reason.differentKinds', defaultMessage: 'One is a scenario benchmark and the other a Performance export: they measure different things.', description: 'Performance → Compare: why a baseline and a run cannot be compared.' }),
  differentScopes: msg({ id: 'performance.compare.reason.differentScopes', defaultMessage: 'Different scopes: {base} and {run}.', description: 'Performance → Compare: why a baseline and a run cannot be compared. {base} and {run} are scopes ("the whole workspace", "project alpha").' }),
  differentFixtures: msg({ id: 'performance.compare.reason.differentFixtures', defaultMessage: 'Different scenario versions (fixtures v{base} and v{run}): the scenarios themselves changed.', description: "Performance → Compare: why two scenario benchmarks cannot be compared. {base} and {run} are the scenarios' version numbers (v3: keep the v)." }),
  fakeVsModel: msg({ id: 'performance.compare.reason.fakeVsModel', defaultMessage: 'A fake provider against a model trial: a fake proves routing and sizes, not a model’s behaviour.', description: 'Performance → Compare: why two scenario benchmarks cannot be compared. A fake provider is a stand-in for a coding agent CLI that runs no model; a model trial runs the real one.' }),
  differentProviders: msg({ id: 'performance.compare.reason.differentProviders', defaultMessage: 'Different providers ({base} and {run}).', description: "Performance → Compare: why two scenario benchmarks cannot be compared. {base} and {run} are providers' ids (claude-code, fake-codex)." }),
  differentSetups: msg({ id: 'performance.compare.reason.differentSetups', defaultMessage: 'Different model setups ({base} and {run}).', description: 'Performance → Compare: why two model trials cannot be compared. {base} and {run} are each a model, an effort and a mode, as the CLI names them ("opus, high, full-access").' }),
  sourceChanged: msg({ id: 'performance.compare.reason.sourceChanged', defaultMessage: '{side, select, baseline {The baseline’s} other {The run’s}} source changed while it ran: its samples may mix two versions.', description: "Performance → Compare: why two scenario benchmarks cannot be compared: Combwork's source code changed while one of them ran." }),
  differentFilters: msg({ id: 'performance.compare.reason.differentFilters', defaultMessage: 'Different filters ({base} and {run}).', description: 'Performance → Compare: why two Performance exports cannot be compared. {base} and {run} are their filters ("everyone, all providers").' }),
  notRecording: msg({ id: 'performance.compare.reason.notRecording', defaultMessage: 'Combwork wasn’t recording in one of the ranges: there is nothing to compare.', description: 'Performance → Compare: why two Performance exports cannot be compared.' }),
  oneIncomplete: msg({ id: 'performance.compare.reason.oneIncomplete', defaultMessage: 'One of them is incomplete.', description: 'Performance → Compare: why a baseline and a run cannot be compared.' }),
  // What a reader should know.
  cliVersions: msg({ id: 'performance.compare.note.cliVersions', defaultMessage: 'CLI versions differ ({base} and {run}).', description: "Performance → Compare, a note on two model trials: the coding agent CLIs' versions differ. {base} and {run} are lists of versions, or ? when unknown." }),
  sameGuidance: msg({ id: 'performance.compare.note.sameGuidance', defaultMessage: 'Both ran the same guidance revision: differences are in the tools, the API, the skills or the run itself.', description: "Performance → Compare, a note: both scenario benchmarks ran with the same revision of Combwork's guidance for agents." }),
  fakeUsage: msg({ id: 'performance.compare.note.fakeUsage', defaultMessage: 'Provider usage isn’t compared: a fake’s tokens are simulated, not a provider’s.', description: "Performance → Compare, a note: a fake provider's token counts aren't real, so they aren't compared." }),
  partial: msg({ id: 'performance.compare.note.partial', defaultMessage: '{side, select, baseline {The baseline} other {The run}} is partial: {what}.', description: 'Performance → Compare, a note on Performance exports: what makes one partial. {what} is a list of reasons ("3 measurements dropped (a limit was full)").' }),
  rangesDiffer: msg({ id: 'performance.compare.note.rangesDiffer', defaultMessage: 'The ranges differ in length: compared per hour recorded.', description: 'Performance → Compare, a note on two Performance exports of time ranges of different lengths.' }),
  realUse: msg({ id: 'performance.compare.note.realUse', defaultMessage: 'Real use isn’t a controlled workload: a change here can be the work that was done, not Combwork.', description: 'Performance → Compare, a note on two Performance exports (measurements of real use, not of a fixed test).' }),
  stale: msg({ id: 'performance.compare.note.stale', defaultMessage: '{n, plural, one {# sample} other {# samples}} left out: the session was given other guidance than the run started with (stale).', description: "Performance → Compare, a note on a scenario: samples left out because their session was given another revision of Combwork's guidance." }),
  leftOut: msg({ id: 'performance.compare.note.leftOut', defaultMessage: '{n, plural, one {# sample} other {# samples}} left out: {why}.', description: "Performance → Compare, a note on a scenario: samples left out because they didn't complete or couldn't be read. {why} lists why (\"no check ran\", or the test harness's own words, in English)." }),
  noSplit: msg({ id: 'performance.compare.note.noSplit', defaultMessage: '{side, select, baseline {The baseline has no per-agent figures} run {The run has no per-agent figures} other {Neither side has per-agent figures}}: totals of all agents shown.', description: "Performance → Compare, a note on a scenario (HI-2186): its measures can't be shown for the agent under test apart from the other agents, because a side was measured before Combwork split them; the figures shown are every agent's together." }),
  splitPartial: msg({ id: 'performance.compare.note.splitPartial', defaultMessage: 'Some per-agent figures weren’t measured (the coverage was partial): they are left out, not zero.', description: 'Performance → Compare, a note on a scenario (HI-2186): some of the figures of the agent under test or of the other agents are unknown.' }),
  fakePerCall: msg({ id: 'performance.compare.note.fakePerCall', defaultMessage: 'With the fake Claude Code or fake Codex, each Combwork tool call starts a combwork MCP server of its own: API requests and tool-list starts count per call, not per session.', description: "Performance → Compare, a note on a comparison of scenario runs on the scripted fake CLIs (HI-2186): what they do differs from a real CLI. Keep Combwork (the app's name), MCP, Claude Code and Codex." }),
  oneSample: msg({ id: 'performance.compare.note.oneSample', defaultMessage: 'One sample on a side: no spread to judge a change by.', description: 'Performance → Compare, a note on a scenario run only once on a side.' }),
  measuredPartly: msg({ id: 'performance.compare.note.measuredPartly', defaultMessage: '{n, plural, one {# sample} other {# samples}} measured partly (recording off, measurements dropped or missing): sizes aren’t judged.', description: 'Performance → Compare, a note on a scenario.' }),
  skillRevisions: msg({ id: 'performance.compare.note.skillRevisions', defaultMessage: 'The sessions were given different skill revisions.', description: 'Performance → Compare, a note on a scenario: the baseline and the run were given different versions of skills.' }),
  skillRevisionsOf: msg({ id: 'performance.compare.note.skillRevisionsOf', defaultMessage: 'The sessions were given different skill revisions ({names}).', description: "Performance → Compare, a note on a scenario: the baseline and the run were given different versions of these skills. {names} lists skills' names." }),
  usageNotEvery: msg({ id: 'performance.compare.note.usageNotEvery', defaultMessage: 'Provider usage isn’t compared: not every sample reported it.', description: 'Performance → Compare, a note on a scenario of model trials.' }),
  estimates: msg({ id: 'performance.compare.note.estimates', defaultMessage: 'Some costs are Combwork’s estimates (≈), not the provider’s.', description: 'Performance → Compare, a note on a scenario of model trials. Keep ≈ (it marks an estimate).' }),
  resumed: msg({ id: 'performance.compare.note.resumed', defaultMessage: 'A resumed session’s provider usage is its whole conversation’s: left out.', description: 'Performance → Compare, a note on a scenario of model trials.' }),
  notJudged: msg({ id: 'performance.compare.note.notJudged', defaultMessage: 'Not judged: some of what it’s judged by wasn’t measured.', description: 'Performance → Compare, a note on a scenario that got no verdict.' }),
  withinSpread: msg({ id: 'performance.compare.note.withinSpread', defaultMessage: 'Smaller on average, but within the samples’ spread.', description: "Performance → Compare, a note on a scenario judged smaller: the change is within the range of the samples' values." }),
  // Why a sample's correctness isn't known (kept in its file as the English: the harness's own reasons stay as it wrote them).
  tooManyChecks: msg({ id: 'performance.compare.sample.tooManyChecks', defaultMessage: 'too many checks to read', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  invalidCheck: msg({ id: 'performance.compare.sample.invalidCheck', defaultMessage: 'a check in it isn’t valid', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  checkTwice: msg({ id: 'performance.compare.sample.checkTwice', defaultMessage: 'a check is listed twice', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  checksNotList: msg({ id: 'performance.compare.sample.checksNotList', defaultMessage: 'its checks aren’t a list', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  countsDiffer: msg({ id: 'performance.compare.sample.countsDiffer', defaultMessage: 'its check counts don’t match its checks', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  failedNoCheck: msg({ id: 'performance.compare.sample.failedNoCheck', defaultMessage: 'it says it failed, but no check did', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  noCheckRan: msg({ id: 'performance.compare.sample.noCheckRan', defaultMessage: 'no check ran', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  didntComplete: msg({ id: 'performance.compare.sample.didntComplete', defaultMessage: 'didn’t complete', description: "Why a scenario's sample is left out of Performance → Compare, in \"{n} samples left out: {why}.\". Lower case." }),
  // What makes a Performance export partial.
  dropped: msg({ id: 'performance.compare.partial.dropped', defaultMessage: '{n, plural, one {# measurement dropped} other {# measurements dropped}} (a limit was full)', description: 'What makes a Performance export partial, in "The baseline is partial: {what}.". Lower case.' }),
  unattributed: msg({ id: 'performance.compare.partial.unattributed', defaultMessage: 'some losses couldn’t be attributed to a project', description: 'What makes a Performance export partial, in "The baseline is partial: {what}.": measurements lost that Combwork couldn\'t say were which project\'s. Lower case.' }),
  evicted: msg({ id: 'performance.compare.partial.evicted', defaultMessage: 'history removed for space in the range', description: 'What makes a Performance export partial, in "The baseline is partial: {what}.": recorded history in its time range was removed to make room. Lower case.' }),
  projectPart: msg({ id: 'performance.compare.partial.projectPart', defaultMessage: 'one project’s part of a workspace export', description: 'What makes a Performance export partial, in "The baseline is partial: {what}.": only one project\'s part of an export of the whole workspace is compared. Lower case.' }),
  invalid: msg({ id: 'performance.compare.partial.invalid', defaultMessage: 'some of its measurements weren’t valid, so {keys} {n, plural, one {is} other {are}} unknown', description: "What makes a Performance export partial, in \"The baseline is partial: {what}.\". {keys} lists measures' field names (requests, responseBytes: keep them); {n} is how many. Lower case." }),
  // Why a file isn't imported.
  tooLarge: msg({ id: 'performance.compare.error.tooLarge', defaultMessage: 'It is over {mb, number} MB.', description: 'Why a file is not imported to Performance → Compare: it is larger than {mb} MB.' }),
  notJson: msg({ id: 'performance.compare.error.notJson', defaultMessage: 'It isn’t JSON.', description: 'Why a file is not imported to Performance → Compare.' }),
  notCombwork: msg({ id: 'performance.compare.error.notCombwork', defaultMessage: 'It isn’t a Combwork benchmark or Performance export.', description: 'Why a file is not imported to Performance → Compare.' }),
  benchmarkOnProject: msg({ id: 'performance.compare.error.benchmarkOnProject', defaultMessage: 'A scenario benchmark is its own test workspace’s, not one of your projects: compare it in the Performance view (activity bar), with the whole workspace selected.', description: "Why a scenario benchmark (a test run's measurements) is not imported on a project's Performance page." }),
  benchmarkOnOwn: msg({ id: 'performance.compare.error.benchmarkOnOwn', defaultMessage: 'A scenario benchmark is its whole test workspace’s, not the workspace’s own work: compare it with the whole workspace selected.', description: 'Why a scenario benchmark is not imported to Performance → Compare with "Workspace\'s own work" selected.' }),
  invalidBenchmark: msg({ id: 'performance.compare.error.invalidBenchmark', defaultMessage: 'It isn’t a valid scenario benchmark (no run, fixtures version or scenarios).', description: 'Why a file is not imported to Performance → Compare.' }),
  noScenarios: msg({ id: 'performance.compare.error.noScenarios', defaultMessage: 'It has no valid scenarios.', description: 'Why a scenario benchmark is not imported to Performance → Compare.' }),
  invalidExport: msg({ id: 'performance.compare.error.invalidExport', defaultMessage: 'It isn’t a valid Performance export (no report, scope or projects).', description: 'Why a file is not imported to Performance → Compare.' }),
  projectsExport: msg({ id: 'performance.compare.error.projectsExport', defaultMessage: 'It is project {project}’s export: compare it on that project’s page.', description: "Why a project's Performance export is not imported on the workspace's Performance page. {project} is the project's name." }),
  exportIsOwn: msg({ id: 'performance.compare.error.exportIsOwn', defaultMessage: 'It is the workspace’s own work: compare it with “Workspace’s own work” selected.', description: 'Why a Performance export is not imported to Performance → Compare. “Workspace’s own work” is a choice on the Performance page: name it as it is there.' }),
  exportIsWhole: msg({ id: 'performance.compare.error.exportIsWhole', defaultMessage: 'It is the whole workspace’s: compare it with the whole workspace selected.', description: 'Why a Performance export is not imported to Performance → Compare.' }),
  ownHoldsProjects: msg({ id: 'performance.compare.error.ownHoldsProjects', defaultMessage: 'It says it is the workspace’s own work, but it holds projects’ data: not imported.', description: 'Why a Performance export is not imported to Performance → Compare: its contents disagree with what it says it is.' }),
  sanitized: msg({ id: 'performance.compare.error.sanitized', defaultMessage: 'It is sanitized (project names replaced), so it can’t be matched to this project.', description: "Why a Performance export is not imported on a project's Performance page." }),
  otherProject: msg({ id: 'performance.compare.error.otherProject', defaultMessage: 'It is project {project}’s export, not {here}’s.', description: "Why a Performance export is not imported on a project's Performance page. {project} and {here} are projects' names." }),
  holdsOther: msg({ id: 'performance.compare.error.holdsOther', defaultMessage: 'It says it is {project}’s, but it also holds {other, select, projects {other projects’} other {the workspace’s own}} data: not imported.', description: "Why a project's Performance export is not imported: it also holds other projects' data, or the workspace's own work's. {project} is the project's name." }),
  sanitizedPart: msg({ id: 'performance.compare.error.sanitizedPart', defaultMessage: 'It is sanitized (project names replaced), so this project’s part can’t be found.', description: "Why a workspace's Performance export is not imported on a project's Performance page." }),
  ownNoPart: msg({ id: 'performance.compare.error.ownNoPart', defaultMessage: 'It is the workspace’s own work: it has no project’s part.', description: "Why a Performance export is not imported on a project's Performance page." }),
  noPart: msg({ id: 'performance.compare.error.noPart', defaultMessage: 'It is a workspace export with no part for {project}.', description: "Why a workspace's Performance export is not imported on a project's Performance page. {project} is the project's name." }),
  unknownSchema: msg({ id: 'performance.compare.error.unknownSchema', defaultMessage: 'It isn’t a Combwork benchmark (combwork-benchmark/1) or Performance export (combwork-metrics/1).', description: 'Why a file is not imported to Performance → Compare. Keep combwork-benchmark/1 and combwork-metrics/1 (file formats).' }),
  // A kept comparison's name and description when Combwork made them (#1104): the window says them from its facts.
  aboutScenarios: msg({ id: 'performance.compare.about.scenarios', defaultMessage: '{real, select, yes {Model trial {provider} {model} ({effort}, {mode})} other {Fake {provider}}}, fixtures v{fixtures}, {scenarios, plural, one {# scenario} other {# scenarios}} × {repeats, number}, source {head}{real, select, yes {, spent {spent}{unpriced, plural, =0 {} other { + {unpriced, number} unpriced (total unknown)}}} other {}}', description: "What a kept scenario benchmark is, in a line under its name in Performance → Compare. A model trial ran a real model ({provider} the CLI, {model}, its {effort} and permission {mode}); Fake ran Combwork's fake CLI. fixtures v{fixtures} is the version of the test fixtures (keep v); {head} is the git commit the run was made from; {spent} what the trial cost; unpriced trials are ones with no known cost." }),
  aboutExport: msg({ id: 'performance.compare.about.export', defaultMessage: '{from} to {to}: {filters}', description: 'What a kept Performance export is, in a line under its name in Performance → Compare: its range ({from} and {to} are dates and times) and its filters (such as "project agents, all providers").' }),
  aboutExportPart: msg({ id: 'performance.compare.about.exportPart', defaultMessage: '{from} to {to}: {filters} ({part})', description: "What a kept Performance export is, in a line under its name in Performance → Compare, when it is one project's part of a workspace export: its range ({from} and {to} are dates and times), its filters, and {part}, which says it is that part." }),
  labelBenchmark: msg({ id: 'performance.compare.label.benchmark', defaultMessage: '{provider} benchmark', description: "The name Combwork gives a kept scenario benchmark that came without one, in Performance → Compare. {provider} is the CLI's name (Claude Code, Codex…)." }),
  labelExport: msg({ id: 'performance.compare.label.export', defaultMessage: 'Export {from} to {to}{own, select, yes {, own work} other {}}', description: "The name Combwork gives a kept Performance export, in Performance → Compare: the dates it covers; own work when it is the workspace's own work (no project's)." }),
  labelExportPart: msg({ id: 'performance.compare.label.exportPart', defaultMessage: 'Export {from} to {to}, {project}’s part', description: "The name Combwork gives one project's part of a workspace's Performance export, kept in Performance → Compare: the dates it covers, and the project's name." }),
  labelKept: msg({ id: 'performance.compare.label.kept', defaultMessage: 'Kept {from} to {to}', description: "The name Combwork gives a Performance view kept for comparison when you give it none (Keep current view), in Performance → Compare: the dates it covers." }),
  roleAgent: msg({ id: 'performance.compare.filters.role.agent', defaultMessage: 'project agents', description: "A Performance export's Who filter (as Performance's Who menu names it: Project agents), in a list of filters. Lower case." }),
  roleAssistant: msg({ id: 'performance.compare.filters.role.assistant', defaultMessage: 'the Assistant', description: "A Performance export's Who filter (as Performance's Who menu names it: The Assistant), in a list of filters." }),
  roleApi: msg({ id: 'performance.compare.filters.role.api', defaultMessage: 'scripts', description: "A Performance export's Who filter (as Performance's Who menu names it: Scripts), in a list of filters. Lower case." }),
  sideMeasure: msg({ id: 'performance.compare.sideMeasure', defaultMessage: '{measure} · {side, select, builder {builders} reviewer {reviewers} either {either role} none {no workflow role} other {role not recorded}}', description: "A measure of Performance → Compare of exports for one workflow role's launches (HI-2049): {measure} is the measure's name (\"Guidance a launch\"); then whose launches: builders', reviewers', agents that take either role, those with no workflow role (generalists, the Assistant), or launches recorded before Combwork recorded the role. Glossary: builder, reviewer, either, workflow role." }),
  roleViewer: msg({ id: 'performance.compare.filters.role.viewer', defaultMessage: 'viewer apps', description: "A Performance export's Who filter (as Performance's Who menu names it: Viewer apps), in a list of filters. Lower case." })
}

const said = (m: Msg, values: Record<string, TextPart>): Text => withValues(m, values)

/** The Who filter's roles, as a list of filters names them; a role this version doesn't know (an imported file's) as written. */
const ROLE_NAME: Record<MetricsRole, Msg> = { agent: M.roleAgent, assistant: M.roleAssistant, api: M.roleApi, viewer: M.roleViewer }
const roleName = (role: string | undefined): TextPart => (role === undefined ? M.everyone : Object.hasOwn(ROLE_NAME, role) ? ROLE_NAME[role as MetricsRole] : role)
/** An export's filters, in a list: its role (or everyone), its provider (or all providers), and own work. */
const filtersText = (x: ExportSummary['filters']): Text => said(M.filters, { role: roleName(x.role), provider: x.provider ?? M.allProviders, own: x.own ? 'yes' : 'no' })

const scopeName = (s: CompareScope): Text => said(M.scopeName, s.kind === 'project' ? { kind: 'project', project: s.project } : { kind: s.own ? 'own' : 'workspace', project: '' })

/** Each measure: what it is, its unit, and how to read a change. All are "less is better". */
export interface MeasureDef {
  key: string
  /** Its name, shown with `tr()`. */
  label: Msg
  unit: 'bytes' | 'chars' | 'count' | 'ms' | 'tokens' | 'usd' | 's'
  group: 'context' | 'traffic' | 'work' | 'failures' | 'skills' | 'provider' | 'time'
  /** What it says about the run, shown on hover (with `tr()`). */
  tip: Msg
}

const AS_REPORTED = msg({ id: 'performance.compare.measureTip.asReported', defaultMessage: 'As the provider reported them.', description: "Tooltip of a token measure in Performance → Compare: the provider's own count." })
const PER_HOUR = msg({ id: 'performance.compare.measureTip.perHour', defaultMessage: 'Per hour recorded.', description: 'Tooltip of a measure in Performance → Compare of exports: shown per hour Combwork was recording.' })

/** A scenario sample's measures (tests/scenarios/harness.cjs measuresOf), with what the comparison derives from them. */
export const SCENARIO_MEASURES: MeasureDef[] = [
  { key: 'contextBytes', label: msg({ id: 'performance.compare.measure.contextBytes', defaultMessage: 'Combwork context', description: "A measure in Performance → Compare: the size of what Combwork put in an agent session's context." }), unit: 'bytes', group: 'context', tip: msg({ id: 'performance.compare.measureTip.contextBytes', defaultMessage: 'What Combwork put in the session’s context: launch guidance (core, project, the Assistant’s role and mode, skills’ catalog), the Combwork tools’ list and every tool reply. Exact UTF-8 bytes, not tokens. Unknown if any part wasn’t measured.', description: 'Tooltip of the Combwork context measure in Performance → Compare. "Combwork tools" are Combwork\'s tools for agents (keep Combwork).' }) },
  { key: 'guidanceBytes', label: msg({ id: 'performance.compare.measure.guidanceBytes', defaultMessage: 'Launch guidance', description: 'A measure in Performance → Compare: the size of the guidance Combwork gave a session at launch.' }), unit: 'bytes', group: 'context', tip: msg({ id: 'performance.compare.measureTip.guidanceBytes', defaultMessage: 'Core contract, project additions, the Assistant’s role and mode, and the skills’ catalog, at launch.', description: 'Tooltip of the Launch guidance measure in Performance → Compare: its parts.' }) },
  { key: 'guidanceChars', label: msg({ id: 'performance.compare.measure.guidanceChars', defaultMessage: 'Launch guidance (characters)', description: 'A measure in Performance → Compare: the launch guidance counted in characters.' }), unit: 'chars', group: 'context', tip: msg({ id: 'performance.compare.measureTip.guidanceChars', defaultMessage: 'The same parts in characters (UTF-16 code units); the catalog has bytes only.', description: 'Tooltip of the Launch guidance (characters) measure in Performance → Compare.' }) },
  { key: 'toolListBytes', label: msg({ id: 'performance.compare.measure.toolListBytes', defaultMessage: 'Tool list', description: "A measure in Performance → Compare: the size of the list of Combwork's tools a session was given." }), unit: 'bytes', group: 'context', tip: msg({ id: 'performance.compare.measureTip.toolListBytes', defaultMessage: 'The Combwork tools’ names, descriptions and schemas as the CLI got them.', description: 'Tooltip of the Tool list measure in Performance → Compare. Keep Combwork (the app\'s name).' }) },
  { key: 'toolListChars', label: msg({ id: 'performance.compare.measure.toolListChars', defaultMessage: 'Tool list (characters)', description: "A measure in Performance → Compare: the size of the list of Combwork's tools a session was given, in characters." }), unit: 'chars', group: 'context', tip: msg({ id: 'performance.compare.measureTip.toolListChars', defaultMessage: 'The same list in characters (UTF-16 code units). Unknown for a run from before Combwork counted them.', description: 'Tooltip of the Tool list (characters) measure in Performance → Compare.' }) },
  { key: 'toolChars', label: msg({ id: 'performance.compare.measure.toolChars', defaultMessage: 'Tool replies', description: "A measure in Performance → Compare: the size of the replies of Combwork's tools." }), unit: 'chars', group: 'context', tip: msg({ id: 'performance.compare.measureTip.toolChars', defaultMessage: 'Characters of the Combwork tools’ replies, as the model got them.', description: 'Tooltip of the Tool replies measure in Performance → Compare. Keep Combwork (the app\'s name).' }) },
  { key: 'toolBytes', label: msg({ id: 'performance.compare.measure.toolBytes', defaultMessage: 'Tool replies (bytes)', description: "A measure in Performance → Compare: the size of the replies of Combwork's tools, in bytes." }), unit: 'bytes', group: 'context', tip: msg({ id: 'performance.compare.measureTip.toolBytes', defaultMessage: 'UTF-8 bytes of the same replies.', description: 'Tooltip of the Tool replies (bytes) measure in Performance → Compare.' }) },
  { key: 'toolCalls', label: msg({ id: 'performance.compare.measure.toolCalls', defaultMessage: 'Tool calls', description: "A measure in Performance → Compare: how many times agents called Combwork's tools." }), unit: 'count', group: 'work', tip: msg({ id: 'performance.compare.measureTip.toolCalls', defaultMessage: 'Combwork tool calls measured by the bridge.', description: "Tooltip of the Tool calls measure in Performance → Compare. Keep Combwork (the app's name); the bridge is Combwork's MCP server between the CLI and Combwork." }) },
  { key: 'toolDetailCalls', label: msg({ id: 'performance.compare.measure.toolDetailCalls', defaultMessage: 'Detail calls', description: "A measure in Performance → Compare: calls of Combwork's tools that asked for the full reply." }), unit: 'count', group: 'work', tip: msg({ id: 'performance.compare.measureTip.toolDetailCalls', defaultMessage: 'Calls that asked for the full form.', description: 'Tooltip of the Detail calls measure in Performance → Compare.' }) },
  { key: 'combworkCalls', label: msg({ id: 'performance.compare.measure.combworkCalls', defaultMessage: 'Calls run', description: "A measure in Performance → Compare: calls of Combwork's tools that Combwork ran." }), unit: 'count', group: 'work', tip: msg({ id: 'performance.compare.measureTip.combworkCalls', defaultMessage: 'Combwork tool calls the server ran (its own log).', description: "Tooltip of the Calls run measure in Performance → Compare. Keep Combwork (the app's name)." }) },
  { key: 'repeatedCalls', label: msg({ id: 'performance.compare.measure.repeatedCalls', defaultMessage: 'Repeated calls', description: 'A measure in Performance → Compare: tool calls identical to an earlier one.' }), unit: 'count', group: 'work', tip: msg({ id: 'performance.compare.measureTip.repeatedCalls', defaultMessage: 'Calls identical to one already made: work done twice.', description: 'Tooltip of the Repeated calls measure in Performance → Compare.' }) },
  { key: 'combworkCallErrors', label: msg({ id: 'performance.compare.measure.combworkCallErrors', defaultMessage: 'Failed calls', description: "A measure in Performance → Compare: calls of Combwork's tools that failed." }), unit: 'count', group: 'failures', tip: msg({ id: 'performance.compare.measureTip.combworkCallErrors', defaultMessage: 'Combwork tool calls that failed.', description: "Tooltip of the Failed calls measure in Performance → Compare. Keep Combwork (the app's name)." }) },
  { key: 'toolErrors', label: msg({ id: 'performance.compare.measure.toolErrors', defaultMessage: 'Tool errors', description: 'A measure in Performance → Compare: tool replies that were errors.' }), unit: 'count', group: 'failures', tip: msg({ id: 'performance.compare.measureTip.toolErrors', defaultMessage: 'Tool replies that were errors (the bridge’s count).', description: "Tooltip of the Tool errors measure in Performance → Compare. The bridge is Combwork's MCP server between the CLI and Combwork." }) },
  { key: 'apiFailed', label: msg({ id: 'performance.compare.measure.apiFailed', defaultMessage: 'API failures', description: "A measure in Performance → Compare: requests to Combwork's Agent API that failed." }), unit: 'count', group: 'failures', tip: msg({ id: 'performance.compare.measureTip.apiFailed', defaultMessage: 'Refused, failed or cancelled requests.', description: 'Tooltip of the API failures measure in Performance → Compare.' }) },
  { key: 'apiCancelled', label: msg({ id: 'performance.compare.measure.apiCancelled', defaultMessage: 'API cancelled', description: "A measure in Performance → Compare: requests to Combwork's Agent API that the caller cancelled." }), unit: 'count', group: 'failures', tip: msg({ id: 'performance.compare.measureTip.apiCancelled', defaultMessage: 'Requests the client gave up on.', description: 'Tooltip of the API cancelled measure in Performance → Compare.' }) },
  { key: 'apiRequests', label: msg({ id: 'performance.compare.measure.apiRequests', defaultMessage: 'API requests', description: "A measure in Performance → Compare: requests to Combwork's Agent API." }), unit: 'count', group: 'traffic', tip: msg({ id: 'performance.compare.measureTip.apiRequests', defaultMessage: 'Agent API requests by the session (and agents it started), not the harness’s own.', description: "Tooltip of the API requests measure in Performance → Compare. The harness is the test program that runs the scenarios." }) },
  { key: 'apiResponseBytes', label: msg({ id: 'performance.compare.measure.apiResponseBytes', defaultMessage: 'API sent', description: "A measure in Performance → Compare: the size of the Agent API's replies." }), unit: 'bytes', group: 'traffic', tip: msg({ id: 'performance.compare.measureTip.apiResponseBytes', defaultMessage: 'Response bodies Combwork’s API sent.', description: 'Tooltip of the API sent measure in Performance → Compare.' }) },
  { key: 'apiRequestBytes', label: msg({ id: 'performance.compare.measure.apiRequestBytes', defaultMessage: 'API received', description: "A measure in Performance → Compare: the size of the requests the Agent API received." }), unit: 'bytes', group: 'traffic', tip: msg({ id: 'performance.compare.measureTip.apiRequestBytes', defaultMessage: 'Request bodies Combwork’s API received.', description: 'Tooltip of the API received measure in Performance → Compare.' }) },
  { key: 'apiMs', label: msg({ id: 'performance.compare.measure.apiMs', defaultMessage: 'API time', description: "A measure in Performance → Compare: the time Combwork's Agent API spent on requests." }), unit: 'ms', group: 'time', tip: msg({ id: 'performance.compare.measureTip.apiMs', defaultMessage: 'Time Combwork spent on the requests, in all.', description: 'Tooltip of the API time measure in Performance → Compare.' }) },
  { key: 'skillBytes', label: msg({ id: 'performance.compare.measure.skillBytes', defaultMessage: 'Skills on disk', description: 'A measure in Performance → Compare: the size of the skills delivered to a session.' }), unit: 'bytes', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillBytes', defaultMessage: 'Delivered skills’ bytes: what was available, not what a model read.', description: 'Tooltip of the Skills on disk measure in Performance → Compare.' }) },
  { key: 'skillsNotDelivered', label: msg({ id: 'performance.compare.measure.skillsNotDelivered', defaultMessage: 'Skills not given', description: "A measure in Performance → Compare: skills a session should have had but didn't get." }), unit: 'count', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillsNotDelivered', defaultMessage: 'Skills asked for that the session didn’t get.', description: 'Tooltip of the Skills not given measure in Performance → Compare.' }) },
  { key: 'skillScans', label: msg({ id: 'performance.compare.measure.skillScans', defaultMessage: 'Skill scans', description: 'A measure in Performance → Compare: how often Combwork looked through the skills.' }), unit: 'count', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillScans', defaultMessage: 'The skill service’s scans during the scenario.', description: 'Tooltip of the Skill scans measure in Performance → Compare.' }) },
  { key: 'skillHits', label: msg({ id: 'performance.compare.measure.skillHits', defaultMessage: 'Skill cache hits', description: 'A measure in Performance → Compare: skills Combwork found unchanged in its cache.' }), unit: 'count', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillHits', defaultMessage: 'Skills found unchanged (more is fine: shown for the cache scenarios).', description: 'Tooltip of the Skill cache hits measure in Performance → Compare.' }) },
  { key: 'skillMisses', label: msg({ id: 'performance.compare.measure.skillMisses', defaultMessage: 'Skill cache misses', description: 'A measure in Performance → Compare: skills Combwork had to read again.' }), unit: 'count', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillMisses', defaultMessage: 'Skills read again (changed, or not cached).', description: 'Tooltip of the Skill cache misses measure in Performance → Compare.' }) },
  { key: 'skillInvalidations', label: msg({ id: 'performance.compare.measure.skillInvalidations', defaultMessage: 'Skill changes seen', description: 'A measure in Performance → Compare: skills Combwork found changed.' }), unit: 'count', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillInvalidations', defaultMessage: 'Kept revisions found changed.', description: 'Tooltip of the Skill changes seen measure in Performance → Compare.' }) },
  { key: 'skillBytesRead', label: msg({ id: 'performance.compare.measure.skillBytesRead', defaultMessage: 'Skill bytes read', description: 'A measure in Performance → Compare: how much of the skills Combwork read from disk.' }), unit: 'bytes', group: 'skills', tip: msg({ id: 'performance.compare.measureTip.skillBytesRead', defaultMessage: 'Bytes the skill service read from disk.', description: 'Tooltip of the Skill bytes read measure in Performance → Compare.' }) },
  { key: 'seconds', label: msg({ id: 'performance.compare.measure.seconds', defaultMessage: 'Duration', description: "A measure in Performance → Compare: how long a scenario's run took." }), unit: 's', group: 'time', tip: msg({ id: 'performance.compare.measureTip.seconds', defaultMessage: 'The scenario’s run, start to end (a model trial’s varies most).', description: 'Tooltip of the Duration measure in Performance → Compare.' }) }
]

/** Provider-reported usage of a scenario's session: model trials only (a fake's is simulated), and only when both report it. */
export const USAGE_MEASURES: MeasureDef[] = [
  { key: 'inputTokens', label: msg({ id: 'performance.compare.measure.inputTokens', defaultMessage: 'Input tokens', description: 'A measure in Performance → Compare: tokens a model read, as its provider reported them.' }), unit: 'tokens', group: 'provider', tip: AS_REPORTED },
  { key: 'cacheReadTokens', label: msg({ id: 'performance.compare.measure.cacheReadTokens', defaultMessage: 'Cache read', description: "A measure in Performance → Compare: tokens read from the provider's prompt cache." }), unit: 'tokens', group: 'provider', tip: AS_REPORTED },
  { key: 'cacheWriteTokens', label: msg({ id: 'performance.compare.measure.cacheWriteTokens', defaultMessage: 'Cache write', description: "A measure in Performance → Compare: tokens written to the provider's prompt cache." }), unit: 'tokens', group: 'provider', tip: AS_REPORTED },
  { key: 'outputTokens', label: msg({ id: 'performance.compare.measure.outputTokens', defaultMessage: 'Output tokens', description: 'A measure in Performance → Compare: tokens a model wrote.' }), unit: 'tokens', group: 'provider', tip: msg({ id: 'performance.compare.measureTip.outputTokens', defaultMessage: 'Reasoning included, as the provider reported them.', description: 'Tooltip of the Output tokens measure in Performance → Compare.' }) },
  { key: 'reasoningTokens', label: msg({ id: 'performance.compare.measure.reasoningTokens', defaultMessage: 'of it reasoning', description: 'A measure in Performance → Compare, under Output tokens: the part of them that was reasoning. Lower case: it reads on from the row above.' }), unit: 'tokens', group: 'provider', tip: msg({ id: 'performance.compare.measureTip.reasoningTokens', defaultMessage: 'Part of output, not added to it.', description: 'Tooltip of the "of it reasoning" measure in Performance → Compare.' }) },
  { key: 'requests', label: msg({ id: 'performance.compare.measure.providerRequests', defaultMessage: 'Provider requests', description: "A measure in Performance → Compare: requests a session made to its model's provider." }), unit: 'count', group: 'provider', tip: msg({ id: 'performance.compare.measureTip.providerRequests', defaultMessage: 'Model requests the session made.', description: 'Tooltip of the Provider requests measure in Performance → Compare.' }) },
  { key: 'costUsd', label: msg({ id: 'performance.compare.measure.costUsd', defaultMessage: 'Cost', description: 'A measure in Performance → Compare: what a session cost, in dollars.' }), unit: 'usd', group: 'provider', tip: msg({ id: 'performance.compare.measureTip.costUsd', defaultMessage: 'API-equivalent; only when every sample on both sides has a cost (≈ when Combwork estimated one).', description: 'Tooltip of the Cost measure in Performance → Compare. Keep ≈ (it marks an estimate).' }) }
]

/** A Performance export's summary measures: per hour Combwork was recording, so ranges of different lengths compare. */
export const EXPORT_MEASURES: MeasureDef[] = [
  { key: 'requests', label: msg({ id: 'performance.compare.measure.exportRequests', defaultMessage: 'API requests', description: "A measure in Performance → Compare of exports: requests to Combwork's Agent API." }), unit: 'count', group: 'traffic', tip: msg({ id: 'performance.compare.measureTip.exportRequests', defaultMessage: 'Agent API requests, per hour recorded.', description: 'Tooltip of the API requests measure in Performance → Compare of exports.' }) },
  { key: 'failed', label: msg({ id: 'performance.compare.measure.exportFailed', defaultMessage: 'Failed or cancelled', description: "A measure in Performance → Compare of exports: Agent API requests that failed or were cancelled." }), unit: 'count', group: 'failures', tip: PER_HOUR },
  { key: 'responseBytes', label: msg({ id: 'performance.compare.measure.exportResponseBytes', defaultMessage: 'API sent', description: "A measure in Performance → Compare of exports: the size of the Agent API's replies." }), unit: 'bytes', group: 'traffic', tip: PER_HOUR },
  { key: 'toolCalls', label: msg({ id: 'performance.compare.measure.exportToolCalls', defaultMessage: 'Tool calls', description: "A measure in Performance → Compare of exports: calls of Combwork's tools." }), unit: 'count', group: 'work', tip: PER_HOUR },
  { key: 'toolChars', label: msg({ id: 'performance.compare.measure.exportToolChars', defaultMessage: 'Tool replies', description: "A measure in Performance → Compare of exports: the size of the replies of Combwork's tools." }), unit: 'chars', group: 'context', tip: msg({ id: 'performance.compare.measureTip.exportToolChars', defaultMessage: 'Characters, per hour recorded.', description: 'Tooltip of the Tool replies measure in Performance → Compare of exports.' }) },
  { key: 'detailCalls', label: msg({ id: 'performance.compare.measure.exportDetailCalls', defaultMessage: 'Detail calls', description: "A measure in Performance → Compare of exports: calls of Combwork's tools that asked for the full reply." }), unit: 'count', group: 'work', tip: PER_HOUR },
  { key: 'launches', label: msg({ id: 'performance.compare.measure.exportLaunches', defaultMessage: 'Launches', description: 'A measure in Performance → Compare of exports: agent sessions started.' }), unit: 'count', group: 'work', tip: PER_HOUR },
  { key: 'guidancePerLaunch', label: msg({ id: 'performance.compare.measure.exportGuidancePerLaunch', defaultMessage: 'Guidance a launch', description: "A measure in Performance → Compare of exports: the size of Combwork's guidance for each session started." }), unit: 'bytes', group: 'context', tip: msg({ id: 'performance.compare.measureTip.exportGuidancePerLaunch', defaultMessage: 'Core, project, the Assistant’s role and mode, and catalog, on average (not per hour).', description: 'Tooltip of the Guidance a launch measure in Performance → Compare of exports: its parts.' }) },
  { key: 'toolListPerLaunch', label: msg({ id: 'performance.compare.measure.exportToolListPerLaunch', defaultMessage: 'Tool list a launch', description: "A measure in Performance → Compare of exports (HI-2049): the size of the list of Combwork's tools each session was given." }), unit: 'chars', group: 'context', tip: msg({ id: 'performance.compare.measureTip.exportToolListPerLaunch', defaultMessage: 'The Combwork tools’ names, descriptions and schemas as each session’s CLI got them, in characters, on average (not per hour). Sessions from before Combwork counted characters are left out.', description: "Tooltip of the Tool list a launch measure in Performance → Compare of exports. Keep Combwork (the app's name)." }) }
]

/**
 * The workflow roles an export's launches are split by (HI-2049): GuidanceSeries and CatalogSeries `workflow`, with
 * `unknown` for what was recorded before. Each has the per-launch measures below, keyed `<measure>.<role>`.
 */
export const WORKFLOW_SIDES = ['builder', 'reviewer', 'either', 'none', 'unknown'] as const
export type WorkflowSide = (typeof WORKFLOW_SIDES)[number]
const SIDE_MEASURES = ['launches', 'guidancePerLaunch', 'toolListPerLaunch']
/** The totals each role keeps, `<total>.<role>`: what its measures are made from. */
const SIDE_TOTALS = ['launches', 'guidanceBytes', 'toolListStarts', 'toolListChars']
const sided = (key: string): string[] => WORKFLOW_SIDES.map((side) => `${key}.${side}`)
const sideOf = (v: unknown): WorkflowSide => (typeof v === 'string' && (WORKFLOW_SIDES as readonly string[]).includes(v) && v !== 'unknown' ? (v as WorkflowSide) : 'unknown')

/** An export comparison row's measure: its own, or one of a workflow role's (`<measure>.<role>`) with that role. */
export function exportMeasure(key: string): { def: MeasureDef; side?: WorkflowSide } | undefined {
  const own = EXPORT_MEASURES.find((m) => m.key === key)
  if (own) return { def: own }
  const at = key.lastIndexOf('.')
  const base = EXPORT_MEASURES.find((m) => m.key === key.slice(0, at))
  const side = key.slice(at + 1)
  return at > 0 && base && SIDE_MEASURES.includes(base.key) && (WORKFLOW_SIDES as readonly string[]).includes(side) ? { def: base, side: side as WorkflowSide } : undefined
}

/** A workflow role's measure's name: the measure's, and whose launches. */
export const sideMeasureLabel = (label: string, side: WorkflowSide): Text => said(M.sideMeasure, { measure: label, side })

// ---------------------------------------------------------------------------
// Artifacts, as kept (validated and normalised).
// ---------------------------------------------------------------------------

export type Measures = Record<string, number>

export interface Check {
  name: string
  /** Passed, failed, or null: skipped (a check only a model's own work can meet, skipped for a fake). */
  ok: boolean | null
}

export interface Sample {
  /**
   * Passed every check that ran (and at least one ran); false: some failed; null: it didn't complete, or no check ran,
   * so its correctness isn't known.
   */
  ok: boolean | null
  incomplete?: string
  passed: number
  failed: number
  skipped: number
  checks: Check[]
  failedChecks: string[]
  /** The session was given other guidance than Combwork had when the run started (a stale launch): left out. */
  stale: boolean
  /** A resumed session: its provider usage is the whole conversation's, so it isn't compared. */
  resumed: boolean
  measures: Measures | null
  /**
   * The measures of the subject (the Assistant, or the agent under test) and of the other agents apart (HI-2186), each
   * measured on its own: a key missing from one is unknown there. Absent from samples of a harness before HI-2186.
   */
  split?: { subject: Measures; others: Measures }
  /** The harness couldn't split every measure (incomplete coverage): what it couldn't is left out of `split`. */
  splitPartial?: boolean
  /** Each agent's Combwork calls in the measured window (HI-2186), the subject first. */
  agents?: AgentCalls[]
  usage: Measures | null
  /** Whether the usage's cost was Hive's estimate. */
  costEstimated: boolean
  /** How complete the measurement was: recording on, measurements dropped, what made it partial. */
  coverage: { recording: boolean | null; dropped: number; partial: string[] }
  /** The guidance and each skill's revision the session was given at launch (name → revision). */
  guidance: string | null
  skills: Record<string, string> | null
}

export interface ScenarioResult {
  id: string
  title: string
  role: string
  samples: Sample[]
}

export interface BenchmarkRun {
  fixturesVersion: number
  provider: string
  providerId: string
  real: boolean
  model: string
  effort: string
  mode: string | null
  cliVersions: string[]
  repeats: number
  source: { head: string; dirty: string | null }
  sourceChangedDuringRun: boolean
  guidance: string | null
  authorization: string | null
  spentUsd: number
  /** Trials that reported no cost: the spend is `spentUsd` plus these, unknown in all. */
  unknownCostTrials: number
  seconds: number
  metricsOverheadMs: number
}

/** A Performance export, kept as its summary (the totals the comparison needs, for its scope and filters). */
export interface ExportSummary {
  from: string
  to: string
  observedMs: number
  rangeMs: number
  filters: { role?: string; provider?: string; own?: boolean }
  /** Totals in the range (not per hour). */
  totals: Measures
  /** Measurements dropped or not attributable: the totals may be low. In English (kept files and tests read it). */
  partial: string[]
  /** The same as data, for the window (a summary kept before #1104 has only `partial`). */
  partialWhy?: PartialReason[]
}

/** What makes an export's summary partial, as data: the window says it in its language. */
export type PartialReason = { kind: 'dropped'; n: number } | { kind: 'unattributed' } | { kind: 'evicted' } | { kind: 'projectPart' } | { kind: 'invalid'; keys: string[] }

const partialText = (r: PartialReason): Text =>
  r.kind === 'dropped' ? said(M.dropped, { n: r.n }) : r.kind === 'invalid' ? said(M.invalid, { keys: r.keys.join(', '), n: r.keys.length }) : r.kind === 'unattributed' ? M.unattributed : r.kind === 'evicted' ? M.evicted : M.projectPart

/** A kept summary's reasons re-read: known ones only, their keys the export's measures (else none: its English is shown). */
function readPartialWhy(v: unknown): PartialReason[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PartialReason[] = []
  for (const x of v.slice(0, 10)) {
    const o = obj(x)
    if (o?.kind === 'dropped' && num(o.n) !== null) out.push({ kind: 'dropped', n: num(o.n)! })
    else if (o?.kind === 'unattributed' || o?.kind === 'evicted' || o?.kind === 'projectPart') out.push({ kind: o.kind })
    else if (o?.kind === 'invalid' && Array.isArray(o.keys) && o.keys.length && o.keys.every((k) => typeof k === 'string' && EXPORT_KEYS.has(k))) out.push({ kind: 'invalid', keys: [...new Set(o.keys as string[])] })
    else return undefined
  }
  return out
}

export interface Artifact {
  schema: typeof BENCHMARK_SCHEMA | typeof METRICS_EXPORT_SCHEMA
  kind: 'scenarios' | 'export'
  label: string
  createdAt: string
  appVersion: string
  scope: CompareScope
  /** Derived from a workspace export: one project's part, explicitly chosen. */
  derived?: string
  /** The name is one Combwork gave it (it came with none): the window says it from its facts (#1104). */
  labelKind?: LabelKind
  run?: BenchmarkRun
  scenarios?: ScenarioResult[]
  summary?: ExportSummary
}

const COMPONENT_KEYS = ['coreBytes', 'customBytes', 'roleBytes', 'modeBytes', 'catalogBytes', 'coreChars', 'customChars', 'roleChars', 'modeChars', 'toolBytes', 'toolListBytes', 'toolListChars']
const DERIVED = new Set(['contextBytes', 'guidanceBytes', 'guidanceChars', 'seconds'])
const MEASURE_KEYS = new Set([...SCENARIO_MEASURES.map((m) => m.key).filter((k) => !DERIVED.has(k)), ...COMPONENT_KEYS, 'toolMs', 'launches', 'skillsDelivered', 'skillsUnmeasured', 'toolListStarts', 'skillTooLarge', 'dropped', 'skillsRead', 'skillRefsRead'])
/**
 * A part's measures (HI-2186: the subject's, the other agents'): the scenario's own, less what isn't any one agent's (the
 * skill service's work, drops) and what the harness counts for the subject alone (its calls, the skills it read).
 */
const NOT_SPLIT = new Set(['combworkCalls', 'combworkCallErrors', 'repeatedCalls', 'skillsRead', 'skillRefsRead', 'skillScans', 'skillHits', 'skillMisses', 'skillInvalidations', 'skillBytesRead', 'skillTooLarge', 'dropped'])
const SPLIT_KEYS = new Set([...MEASURE_KEYS].filter((k) => !NOT_SPLIT.has(k)))
const USAGE_KEYS = new Set([...USAGE_MEASURES.map((m) => m.key), 'contextTokens'])
const EXPORT_KEYS = new Set(['requests', 'failed', 'responseBytes', 'requestBytes', 'toolCalls', 'toolChars', 'detailCalls', 'launches', 'guidanceBytes', 'toolListStarts', 'toolListChars', ...SIDE_TOTALS.flatMap(sided)])

const text = (v: unknown, max = BENCHMARK_LIMITS.text): string =>
  String(typeof v === 'string' || typeof v === 'number' ? v : '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const iso = (v: unknown): string => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : '')
const sum = (m: Measures, keys: string[]): number | null => (keys.every((k) => typeof m[k] === 'number') ? keys.reduce((n, k) => n + m[k], 0) : null)

/** Measures saved before 0.9.3, when the Assistant's mode was its persona (#1084), under their names now. */
function withModeNames(m: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!m || !('personaBytes' in m || 'personaChars' in m)) return m
  const { personaBytes, personaChars, ...rest } = m
  return { ...rest, modeBytes: rest.modeBytes ?? personaBytes, modeChars: rest.modeChars ?? personaChars }
}

/**
 * Measures with what adds up from them: the launch guidance and Combwork's context, only when every part they add up is
 * known (a missing part leaves them unknown).
 */
function withDerived(m: Measures | null): Measures | null {
  if (!m) return null
  const guidance = sum(m, ['coreBytes', 'customBytes', 'roleBytes', 'modeBytes', 'catalogBytes'])
  const guidanceChars = sum(m, ['coreChars', 'customChars', 'roleChars', 'modeChars'])
  if (guidance !== null) {
    m.guidanceBytes = guidance
    const ctx = sum(m, ['toolListBytes', 'toolBytes'])
    if (ctx !== null) m.contextBytes = guidance + ctx
  }
  if (guidanceChars !== null) m.guidanceChars = guidanceChars
  return m
}

/** An agent's calls in a sample (HI-2186), as the harness lists them. */
export interface AgentCalls {
  /** Its name in the scenario's fixture, `Assistant`, `unattributed` (not in the fixture) or `overflow` (the rest). */
  agent: string
  role: 'assistant' | 'builder' | 'reviewer' | 'agent'
  side: 'subject' | 'other'
  combworkCalls: number
  /** Unknown (absent) where the log can't say. */
  toolListStarts?: number
  /** An `overflow` row: how many agents it sums. */
  agents?: number
}

const AGENT_ROLES = ['assistant', 'builder', 'reviewer', 'agent'] as const

/** A sample's agent rows: valid ones only, at most BENCHMARK_LIMITS.agents; none (undefined) when there is no list. */
function readAgents(v: unknown): AgentCalls[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: AgentCalls[] = []
  for (const x of v.slice(0, BENCHMARK_LIMITS.agents)) {
    const o = obj(x)
    const calls = num(o?.combworkCalls)
    if (!o || typeof o.agent !== 'string' || !o.agent || calls === null || !(AGENT_ROLES as readonly string[]).includes(String(o.role)) || (o.side !== 'subject' && o.side !== 'other')) continue
    const starts = num(o.toolListStarts)
    const agents = num(o.agents)
    out.push({ agent: text(o.agent, 64), role: o.role as AgentCalls['role'], side: o.side, combworkCalls: calls, ...(starts !== null ? { toolListStarts: starts } : {}), ...(agents !== null ? { agents } : {}) })
  }
  return out
}

/** Known measures with valid values only (unknown keys and bad values left out, never guessed or zero-filled). */
function readMeasures(v: unknown, keys: Set<string>): Measures | null {
  const o = obj(v)
  if (!o) return null
  const out: Measures = {}
  for (const k of keys) {
    const n = num(o[k])
    if (n !== null) out[k] = n
  }
  return out
}

/**
 * A sample, from a harness file or a kept artifact alike. Derived totals exist only when every part they add up is
 * known; a missing part leaves them unknown. Correctness is recomputed from the counts: a sample whose checks all
 * skipped is unknown, not passed.
 */
function readSample(v: unknown): Sample | null {
  const o = obj(v)
  if (!o) return null
  const raw = withModeNames(obj(o.measures))
  let measures = raw ? withDerived(readMeasures(raw, MEASURE_KEYS)) : null
  if (measures) {
    const secs = num(o.seconds) ?? num(raw?.seconds)
    if (secs !== null) measures = { ...measures, seconds: secs }
  }
  // The subject apart from the other agents (HI-2186): the harness's file has them in its measures, a kept artifact
  // beside them. Both parts or neither.
  const parts = obj(o.split) ?? (raw && obj(raw.subject) && obj(raw.others) ? { subject: raw.subject, others: raw.others } : null)
  const subject = parts ? withDerived(readMeasures(withModeNames(obj(parts.subject)), SPLIT_KEYS)) : null
  const others = parts ? withDerived(readMeasures(withModeNames(obj(parts.others)), SPLIT_KEYS)) : null
  const split = subject && others ? { subject, others } : null
  const splitPartial = o.splitPartial === true || raw?.split === 'partial'
  const agents = readAgents(o.agents ?? raw?.agents)
  const resumed = o.resumed === true
  const u = !resumed ? (obj(o.usage) ?? obj(raw?.usage)) : null
  const usage = u ? readMeasures(u, USAGE_KEYS) : null
  // The check list, when there is one, is what counts: its own counts, and any failure in it fails the sample. A list
  // that can't be trusted (too long to read whole, an entry that isn't a check, a check listed twice) or counts that
  // disagree with it leave the sample's correctness unknown.
  let problem: string | undefined
  const checks: Check[] = []
  if (Array.isArray(o.checks)) {
    if (o.checks.length > BENCHMARK_LIMITS.checks) problem = M.tooManyChecks.defaultMessage
    for (const c of o.checks.slice(0, BENCHMARK_LIMITS.checks)) {
      const co = obj(c)
      if (!co || typeof co.name !== 'string' || !(co.ok === true || co.ok === false || co.ok === null)) {
        problem ??= M.invalidCheck.defaultMessage
        continue
      }
      const name = text(co.name)
      if (checks.some((x) => x.name === name)) problem ??= M.checkTwice.defaultMessage
      else checks.push({ name, ok: co.ok as boolean | null })
    }
  } else if (o.checks !== undefined) problem = M.checksNotList.defaultMessage
  const listed = Array.isArray(o.checks) && o.checks.length > 0
  const count = (key: 'passed' | 'failed' | 'skipped', want: boolean | null): number => {
    const fromList = checks.filter((c) => c.ok === want).length
    const given = num(o[key])
    if (listed && given !== null && given !== fromList) problem ??= M.countsDiffer.defaultMessage
    return listed ? fromList : (given ?? 0)
  }
  const passed = count('passed', true)
  const failed = count('failed', false)
  const skipped = count('skipped', null)
  if (o.ok === false && failed === 0 && listed) problem ??= M.failedNoCheck.defaultMessage
  const incomplete = typeof o.incomplete === 'string' ? text(o.incomplete) : problem
  // Passed only if it completed, nothing failed and something was checked.
  const ok = incomplete !== undefined || o.ok === null ? null : failed > 0 || o.ok === false ? false : passed > 0 ? true : null
  const cov = obj(o.coverage)
  const skills = obj(o.skills)
  const skillMap: Record<string, string> = {}
  for (const [k, rev] of Object.entries(skills ?? {}).slice(0, BENCHMARK_LIMITS.skills)) if (/^[a-z0-9][\w-]{0,63}$/i.test(k) && typeof rev === 'string') skillMap[k] = text(rev, 64)
  return {
    ok,
    ...(incomplete !== undefined ? { incomplete } : ok === null && o.ok !== null ? { incomplete: M.noCheckRan.defaultMessage } : {}),
    passed,
    failed,
    skipped,
    checks,
    failedChecks: arr(o.failedChecks, BENCHMARK_LIMITS.failedChecks).map((x) => text(x)),
    stale: o.stale === true,
    resumed,
    measures,
    ...(split ? { split } : {}),
    ...(splitPartial ? { splitPartial } : {}),
    ...(agents ? { agents } : {}),
    usage,
    costEstimated: u?.costEstimated === true || o.costEstimated === true,
    coverage: {
      recording: cov?.recording === true ? true : cov?.recording === false ? false : null,
      dropped: num(cov?.dropped) ?? 0,
      partial: arr(cov?.partial, 10).map((x) => text(x))
    },
    guidance: typeof o.guidance === 'string' ? text(o.guidance, 64) : null,
    skills: skills ? skillMap : null
  }
}

function readScope(v: unknown): CompareScope | null {
  const o = obj(v)
  if (o?.kind === 'workspace') return o.own === true ? { kind: 'workspace', own: true } : { kind: 'workspace' }
  if (o?.kind === 'project' && typeof o.project === 'string' && o.project && o.project.length <= 255 && !/[\\/\0|]/.test(o.project)) return { kind: 'project', project: o.project }
  return null
}

function readRun(v: unknown): BenchmarkRun | null {
  const run = obj(v)
  if (!run || num(run.fixturesVersion) === null || typeof run.provider !== 'string') return null
  const src = obj(run.source)
  return {
    fixturesVersion: num(run.fixturesVersion)!,
    provider: text(run.provider, 40),
    providerId: text(run.providerId, 40),
    real: run.real === true,
    model: text(run.model, 80) || '(default)',
    effort: text(run.effort, 40) || '(default)',
    mode: typeof run.mode === 'string' ? text(run.mode, 40) : null,
    cliVersions: arr(run.cliVersions, 5).map((x) => text(x, 60)),
    repeats: num(run.repeats) ?? 1,
    source: { head: text(src?.head, 40), dirty: typeof src?.dirty === 'string' ? text(src.dirty, 40) : null },
    sourceChangedDuringRun: run.sourceChangedDuringRun === true,
    guidance: typeof run.guidance === 'string' ? text(run.guidance, 64) : null,
    authorization: typeof run.authorization === 'string' ? text(run.authorization) : null,
    spentUsd: num(run.spentUsd) ?? 0,
    unknownCostTrials: num(run.unknownCostTrials) ?? 0,
    seconds: num(run.seconds) ?? 0,
    metricsOverheadMs: num(run.metricsOverheadMs) ?? 0
  }
}

function readScenarios(v: unknown): ScenarioResult[] {
  const scenarios: ScenarioResult[] = []
  for (const s of arr(v, BENCHMARK_LIMITS.scenarios)) {
    const so = obj(s)
    if (!so || typeof so.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(so.id) || !Array.isArray(so.samples) || scenarios.some((x) => x.id === so.id)) continue
    const samples = arr(so.samples, BENCHMARK_LIMITS.samples)
      .map(readSample)
      .filter((x): x is Sample => !!x)
    scenarios.push({ id: so.id, title: text(so.title), role: so.role === 'assistant' ? 'assistant' : 'agent', samples })
  }
  return scenarios
}

/** Which totals each kind of series adds to (an unreadable series leaves exactly these unknown). */
const SERIES_TOTALS: Record<'api' | 'mcp' | 'guidance' | 'catalog', string[]> = {
  api: ['requests', 'failed', 'responseBytes', 'requestBytes'],
  mcp: ['toolCalls', 'toolChars', 'detailCalls'],
  guidance: ['launches', 'guidanceBytes', ...sided('launches'), ...sided('guidanceBytes')],
  catalog: ['toolListStarts', 'toolListChars', ...sided('toolListStarts'), ...sided('toolListChars')]
}

/**
 * A report part's totals added into `t`. A series that is missing, isn't a list, is longer than can be read, or has an
 * entry whose numbers aren't valid makes the totals it adds to unknown (in `unknown`), never zero: a damaged measurement
 * is no measurement.
 */
function partTotals(p: unknown, t: Measures, unknown: Set<string>): void {
  const o = obj(p)
  if (!o) {
    for (const keys of Object.values(SERIES_TOTALS)) for (const k of keys) unknown.add(k)
    return
  }
  for (const kind of ['api', 'mcp', 'guidance', 'catalog'] as const) {
    const v = o[kind]
    // A report with no tool lists at all (one written by hand, or by a Combwork from before they were counted) has none.
    if (kind === 'catalog' && v === undefined) continue
    const mark = (...keys: string[]): void => keys.forEach((k) => unknown.add(k))
    if (!Array.isArray(v) || v.length > BENCHMARK_LIMITS.series) {
      mark(...SERIES_TOTALS[kind])
      if (!Array.isArray(v)) continue
    }
    for (const raw of v.slice(0, BENCHMARK_LIMITS.series)) {
      const x = obj(raw)
      if (!x) {
        mark(...SERIES_TOTALS[kind])
        continue
      }
      const add = (key: string, value: unknown): void => {
        const n = num(value)
        if (n === null) unknown.add(key)
        else t[key] += n
      }
      if (kind === 'api') {
        const n = num(x.count)
        if (n === null || typeof x.outcome !== 'string') mark('requests', 'failed')
        else {
          t.requests += n
          if (x.outcome !== 'ok') t.failed += n
        }
        add('responseBytes', x.responseBytes)
        add('requestBytes', x.requestBytes)
      } else if (kind === 'mcp') {
        const n = num(x.count)
        if (n === null || typeof x.mode !== 'string') mark('toolCalls', 'detailCalls')
        else {
          t.toolCalls += n
          if (x.mode === 'detail') t.detailCalls += n
        }
        add('toolChars', x.chars)
      } else if (kind === 'guidance') {
        // Recorded before HI-2049: its role is unknown, never a guess.
        const side = sideOf(x.workflow)
        add('launches', x.launches)
        add(`launches.${side}`, x.launches)
        const parts = [x.guidanceBytes, x.customBytes ?? 0, x.roleBytes ?? 0, x.modeBytes ?? x.personaBytes ?? 0, x.skillCatalogBytes].map(num)
        if (parts.some((n) => n === null)) mark('guidanceBytes', `guidanceBytes.${side}`)
        else {
          const n = (parts as number[]).reduce((a, b) => a + b, 0)
          t.guidanceBytes += n
          t[`guidanceBytes.${side}`] += n
        }
      } else {
        // The starts whose characters were counted (`charStarts`): a bridge from before HI-2049 sent bytes only, and
        // its starts count in neither the characters nor the starts they are averaged over.
        if (x.toolsChars === undefined && x.charStarts === undefined) continue
        const side = sideOf(x.workflow)
        for (const [key, value] of [['toolListStarts', x.charStarts], ['toolListChars', x.toolsChars]] as const) {
          add(key, value)
          add(`${key}.${side}`, value)
        }
      }
    }
  }
}

const emptyTotals = (): Measures => ({ requests: 0, failed: 0, responseBytes: 0, requestBytes: 0, toolCalls: 0, toolChars: 0, detailCalls: 0, launches: 0, guidanceBytes: 0, toolListStarts: 0, toolListChars: 0, ...Object.fromEntries(SIDE_TOTALS.flatMap(sided).map((k) => [k, 0])) })

/** Whether a report part has any measurement in it (a part that can't be read counts as having some: it isn't empty). */
const hasData = (p: unknown): boolean => {
  if (p === undefined) return false
  const t = emptyTotals()
  const unknown = new Set<string>()
  partTotals(p, t, unknown)
  return unknown.size > 0 || Object.values(t).some((n) => n > 0)
}

/**
 * A report (or an export's) as a kept summary: totals of its parts (only `project`'s, when given), its coverage, and what
 * makes it partial. The report is untrusted: every part and series is checked as it is added, and a total any damaged
 * piece adds to is left out (unknown), never zero.
 */
export function summaryOf(report: unknown, project?: string): ExportSummary {
  const r = obj(report) ?? {}
  const unknown = new Set<string>()
  const all = Object.entries(obj(r.projects) ?? {})
  if (all.length > BENCHMARK_LIMITS.projects || !obj(r.projects)) for (const k of EXPORT_KEYS) unknown.add(k)
  const totals = emptyTotals()
  for (const [name, part] of all.slice(0, BENCHMARK_LIMITS.projects)) if (project === undefined || name.toLowerCase() === project.toLowerCase()) partTotals(part, totals, unknown)
  if (project === undefined && r.workspace !== undefined) partTotals(r.workspace, totals, unknown)
  const filters = obj(r.filters) ?? {}
  const coverage = obj(r.coverage) ?? {}
  const dropped = num(r.dropped) ?? 0
  const partialWhy: PartialReason[] = []
  if (dropped > 0) partialWhy.push({ kind: 'dropped', n: dropped })
  if (r.lossesUnattributed === true || (project !== undefined && (num(r.droppedUntracked) ?? 0) > 0)) partialWhy.push({ kind: 'unattributed' })
  if (typeof coverage.evictedThrough === 'string') partialWhy.push({ kind: 'evicted' })
  if (project !== undefined) partialWhy.push({ kind: 'projectPart' })
  if (unknown.size) partialWhy.push({ kind: 'invalid', keys: [...unknown] })
  const from = iso(r.from)
  const to = iso(r.to)
  const observed = num(coverage.observedMs)
  return {
    from,
    to,
    observedMs: observed ?? 0,
    rangeMs: num(coverage.rangeMs) ?? Math.max(0, Date.parse(to) - Date.parse(from) || 0),
    filters: { ...(typeof filters.role === 'string' ? { role: text(filters.role, 20) } : {}), ...(typeof filters.provider === 'string' ? { provider: text(filters.provider, 40) } : {}), ...(filters.own === true ? { own: true } : {}) },
    totals: Object.fromEntries(Object.entries(totals).filter(([k]) => !unknown.has(k))),
    // agent-text: partialText
    // window: benchmarks are the window's (Help → Benchmarks) and their saved files'; no agent reads them
    partial: partialWhy.map((w) => englishText(partialText(w))),
    partialWhy
  }
}

/** A kept summary, re-read (Combwork wrote it, but the file is on disk). A total it doesn't have is unknown. */
function readSummary(v: unknown): ExportSummary | null {
  const s = obj(v)
  const totals = s ? readMeasures(s.totals, EXPORT_KEYS) : null
  if (!s || !totals) return null
  const f = obj(s.filters) ?? {}
  const why = readPartialWhy(s.partialWhy)
  return {
    from: iso(s.from),
    to: iso(s.to),
    observedMs: num(s.observedMs) ?? 0,
    rangeMs: num(s.rangeMs) ?? 0,
    filters: { ...(typeof f.role === 'string' ? { role: text(f.role, 20) } : {}), ...(typeof f.provider === 'string' ? { provider: text(f.provider, 40) } : {}), ...(f.own === true ? { own: true } : {}) },
    totals,
    partial: arr(s.partial, 10).map((x) => text(x)),
    ...(why ? { partialWhy: why } : {})
  }
}

/** A refusal: its English (`error`: the log, tests) and its text for the window (`errorText`, #1104). */
export interface Refusal {
  error: string
  errorText?: Text
}

export type ParseResult = { artifact: Artifact } | Refusal | { projectPart: { project: string } }

// window: benchmarks are the window's (Help → Benchmarks) and their saved files'; no agent reads them
const refuse = (t: Text): Refusal => ({ error: englishText(t), errorText: t })

/**
 * Reads a file as an artifact for a scope (the page's), checked as untrusted input. A scenario benchmark is the whole
 * workspace's: never a project's or the own work's. An export must be for the same scope, and its contents must agree
 * with the scope it claims (a project's export holding other projects' or the workspace's data is refused). A workspace
 * export on a project's page offers that project's part, used only when asked (`useProjectPart`). Sanitized exports
 * can't be matched to a project.
 */
export function parseArtifact(textValue: string, scope: CompareScope, opts: { useProjectPart?: boolean } = {}): ParseResult {
  if (utf8Bytes(textValue) > BENCHMARK_LIMITS.fileBytes) return refuse(said(M.tooLarge, { mb: BENCHMARK_LIMITS.fileBytes / 1024 / 1024 }))
  let data: Record<string, unknown> | null
  try {
    data = obj(JSON.parse(textValue))
  } catch {
    return refuse(M.notJson)
  }
  if (!data) return refuse(M.notCombwork)
  const app = obj(data.app)
  if (data.schema === BENCHMARK_SCHEMA) {
    if (scope.kind === 'project') return refuse(M.benchmarkOnProject)
    if (scope.own) return refuse(M.benchmarkOnOwn)
    const run = readRun(data.run)
    if (!run || !Array.isArray(data.scenarios)) return refuse(M.invalidBenchmark)
    const scenarios = readScenarios(data.scenarios)
    if (!scenarios.length) return refuse(M.noScenarios)
    // i18n-ignore: a kept comparison's default name, stored in its file and renamed by the user (#1104: stays as written)
    return { artifact: { schema: BENCHMARK_SCHEMA, kind: 'scenarios', label: text(data.label) || `${run.provider} benchmark`, ...(text(data.label) ? {} : { labelKind: 'benchmark' as const }), createdAt: iso(data.createdAt), appVersion: text(app?.version, 40), scope: { kind: 'workspace' }, run, scenarios } }
  }
  if (data.schema === METRICS_EXPORT_SCHEMA || data.schema === OLD_METRICS_EXPORT_SCHEMA) {
    const report = obj(data.report)
    const fileScope = readScope(report?.scope)
    const projects = obj(report?.projects)
    if (!report || !fileScope || !projects) return refuse(M.invalidExport)
    const own = obj(report.filters)?.own === true
    const base = { schema: METRICS_EXPORT_SCHEMA as typeof METRICS_EXPORT_SCHEMA, kind: 'export' as const, createdAt: iso(data.exportedAt), appVersion: text(app?.version, 40) }
    const sanitized = data.sanitized === true
    // i18n-ignore: part of a kept comparison's default name, stored in its file (#1104: stays as written)
    const range = `${iso(report.from).slice(0, 10)} to ${iso(report.to).slice(0, 10)}`
    const names = Object.keys(projects)
    if (scope.kind === 'workspace') {
      if (fileScope.kind !== 'workspace') return refuse(said(M.projectsExport, { project: text(fileScope.project, 80) }))
      if (own !== !!scope.own) return refuse(own ? M.exportIsOwn : M.exportIsWhole)
      // Own work has no project's part: one that does isn't what it says.
      if (own && names.some((n) => hasData(projects[n]))) return refuse(M.ownHoldsProjects)
      // i18n-ignore: a kept comparison's default name, stored in its file and renamed by the user (#1104: stays as written)
      return { artifact: { ...base, label: `Export ${range}${own ? ', own work' : ''}`, labelKind: 'export', scope: own ? { kind: 'workspace', own: true } : { kind: 'workspace' }, summary: summaryOf(report) } }
    }
    if (fileScope.kind === 'project') {
      if (sanitized) return refuse(M.sanitized)
      if (fileScope.project.toLowerCase() !== scope.project.toLowerCase()) return refuse(said(M.otherProject, { project: text(fileScope.project, 80), here: scope.project }))
      // Its contents must be its project's only.
      const others = names.filter((n) => n.toLowerCase() !== scope.project.toLowerCase() && hasData(projects[n]))
      if (others.length || hasData(report.workspace)) return refuse(said(M.holdsOther, { project: scope.project, other: others.length ? 'projects' : 'own' }))
      // i18n-ignore: a kept comparison's default name, stored in its file and renamed by the user (#1104: stays as written)
      return { artifact: { ...base, label: `Export ${range}`, labelKind: 'export', scope, summary: summaryOf(report, scope.project) } }
    }
    // A workspace export on a project's page: only that project's part, and only when asked for.
    if (sanitized) return refuse(M.sanitizedPart)
    if (own) return refuse(M.ownNoPart)
    if (!names.some((n) => n.toLowerCase() === scope.project.toLowerCase())) return refuse(said(M.noPart, { project: scope.project }))
    if (!opts.useProjectPart) return { projectPart: { project: scope.project } }
    // i18n-ignore: a kept comparison's default name, stored in its file and renamed by the user (#1104: stays as written)
    return { artifact: { ...base, label: `Export ${range}, ${scope.project}’s part`, labelKind: 'export', scope, derived: englishText(M.projectPart), summary: summaryOf(report, scope.project) } } // window: benchmarks are the window's and their saved files'; no agent reads them
  }
  return refuse(M.unknownSchema)
}

/**
 * Re-reads a kept artifact through the same normalisers (Combwork wrote it, but the file is on disk): a fresh, bounded
 * object, never the one read. Null if it isn't a valid one.
 */
export function readKept(v: unknown): Artifact | null {
  const a = obj(v)
  const scope = readScope(a?.scope)
  if (!a || !scope) return null
  const base = { label: text(a.label, 80), createdAt: iso(a.createdAt), appVersion: text(a.appVersion, 40), scope, ...(typeof a.derived === 'string' ? { derived: text(a.derived) } : {}), ...(isLabelKind(a.labelKind) ? { labelKind: a.labelKind } : {}) }
  if (a.kind === 'scenarios') {
    const run = readRun(a.run)
    const scenarios = readScenarios(a.scenarios)
    if (!run || !scenarios.length || scope.kind !== 'workspace' || scope.own) return null
    return { ...base, schema: BENCHMARK_SCHEMA, kind: 'scenarios', run, scenarios }
  }
  if (a.kind === 'export') {
    const summary = readSummary(a.summary)
    if (!summary || !!summary.filters.own !== (scope.kind === 'workspace' && !!scope.own)) return null
    return { ...base, schema: METRICS_EXPORT_SCHEMA, kind: 'export', summary }
  }
  return null
}

/** A kept comparison file, as the Performance page lists it (main/benchmarks.ts keeps them). */
export interface KeptEntry {
  id: string
  label: string
  kind: Artifact['kind']
  scope: CompareScope
  createdAt: string
  keptAt: string
  pinned: boolean
  /** One line saying what it is (provider and model, or the export's range and filters), in English. */
  about: string
  /** What `about` (and a name Combwork gave it) were made from, so the window says them in its language (#1104); none on entries kept before. */
  facts?: KeptFacts
  /** The name is one Combwork gave it: the window says it from `facts` (#1104). */
  labelKind?: LabelKind
  /** A project's: that project's stable id (#514), so it stays its own whatever the project is called later. */
  owner?: string
}

/** An index entry re-read: a fresh, checked object or null. */
export function readEntry(v: unknown): KeptEntry | null {
  const e = obj(v)
  const scope = readScope(e?.scope)
  if (!e || !scope || typeof e.id !== 'string' || !/^[0-9a-f]{12}$/.test(e.id) || (e.kind !== 'scenarios' && e.kind !== 'export')) return null
  const owner = scope.kind === 'project' && typeof e.owner === 'string' && /^p-[0-9a-f]{12}$/.test(e.owner) ? { owner: e.owner } : {}
  return { id: e.id, label: text(e.label, 80), kind: e.kind, scope, createdAt: iso(e.createdAt), keptAt: iso(e.keptAt) || new Date(0).toISOString(), pinned: e.pinned === true, about: text(e.about, 300), ...owner, ...factsAndLabel(e) }
}

/** An import: kept, refused (with why), or a question (use a workspace export's part for this project?). */
export type ImportResult = { entry: KeptEntry } | Refusal | { ask: { token: string; project: string } }

/** What a kept artifact is, in a line (provider and model, or an export's range and filters). */
export function aboutOf(a: Artifact): string {
  if (a.kind === 'scenarios' && a.run) {
    const r = a.run
    // i18n-ignore: a kept comparison's one-line description, stored in its index entry when kept (#1104: stays as written)
    const spend = r.real ? `, spent $${r.spentUsd}${r.unknownCostTrials ? ` + ${r.unknownCostTrials} unpriced (total unknown)` : ''}` : ''
    // i18n-ignore: a kept comparison's one-line description, stored in its index entry when kept (#1104: stays as written)
    return `${r.real ? 'Model trial' : 'Fake'} ${r.provider}${r.real ? ` ${r.model} (${r.effort}, ${r.mode ?? '–'})` : ''}, fixtures v${r.fixturesVersion}, ${a.scenarios?.length ?? 0} scenarios × ${r.repeats}, source ${r.source.head}${r.source.dirty ? '+' : ''}${spend}`
  }
  const s = a.summary!
  const f = [s.filters.role ?? 'everyone', s.filters.provider ?? 'all providers', s.filters.own ? 'own work' : ''].filter(Boolean).join(', ')
  // i18n-ignore: a kept comparison's one-line description, stored in its index entry when kept (#1104: stays as written)
  return `${s.from.slice(0, 16).replace('T', ' ')} to ${s.to.slice(0, 16).replace('T', ' ')}: ${f}${a.derived ? ` (${a.derived})` : ''}`
}

/** What Combwork made a kept comparison's description from (#1104), kept in its index entry: the window says it in its language. */
export type KeptFacts =
  | { kind: 'scenarios'; real: boolean; provider: string; model: string; effort: string; mode: string | null; fixtures: number; scenarios: number; repeats: number; head: string; dirty: boolean; spentUsd: number; unpriced: number }
  | { kind: 'export'; from: string; to: string; filters: ExportSummary['filters']; part: boolean }
/** The name Combwork gave a kept comparison that came with none: a benchmark's, an export's, or a kept Performance view's. */
export type LabelKind = 'benchmark' | 'export' | 'kept'
const isLabelKind = (v: unknown): v is LabelKind => v === 'benchmark' || v === 'export' || v === 'kept'

/** A kept artifact's facts, for its index entry. */
export function factsOf(a: Artifact): KeptFacts | undefined {
  if (a.kind === 'scenarios' && a.run) {
    const r = a.run
    return { kind: 'scenarios', real: r.real, provider: r.provider, model: r.model, effort: r.effort, mode: r.mode, fixtures: r.fixturesVersion, scenarios: a.scenarios?.length ?? 0, repeats: r.repeats, head: r.source.head, dirty: !!r.source.dirty, spentUsd: r.spentUsd, unpriced: r.unknownCostTrials }
  }
  if (a.kind === 'export' && a.summary) return { kind: 'export', from: a.summary.from, to: a.summary.to, filters: a.summary.filters, part: !!a.derived }
  return undefined
}

/** An index entry's facts and name kind, re-read as untrusted input: fresh and bounded, or left out. */
function factsAndLabel(e: Record<string, unknown>): { facts?: KeptFacts; labelKind?: LabelKind } {
  const f = obj(e.facts)
  let facts: KeptFacts | undefined
  if (f?.kind === 'scenarios' && typeof f.real === 'boolean' && num(f.fixtures) !== null && num(f.scenarios) !== null && num(f.repeats) !== null && num(f.spentUsd) !== null && num(f.unpriced) !== null) {
    facts = { kind: 'scenarios', real: f.real, provider: text(f.provider, 40), model: text(f.model, 80), effort: text(f.effort, 20), mode: typeof f.mode === 'string' ? text(f.mode, 20) : null, fixtures: num(f.fixtures)!, scenarios: num(f.scenarios)!, repeats: num(f.repeats)!, head: text(f.head, 40), dirty: f.dirty === true, spentUsd: num(f.spentUsd)!, unpriced: num(f.unpriced)! }
  } else if (f?.kind === 'export' && iso(f.from) && iso(f.to)) {
    const x = obj(f.filters) ?? {}
    const filters = { ...(typeof x.role === 'string' ? { role: text(x.role, 20) } : {}), ...(typeof x.provider === 'string' ? { provider: text(x.provider, 40) } : {}), ...(x.own === true ? { own: true } : {}) }
    facts = { kind: 'export', from: iso(f.from), to: iso(f.to), filters, part: f.part === true }
  }
  return { ...(facts ? { facts } : {}), ...(facts && isLabelKind(e.labelKind) ? { labelKind: e.labelKind } : {}) }
}

/** A kept comparison's name as the window shows it: one Combwork gave it, said from its facts in the window's language; the user's as written. */
export function keptLabel(e: Pick<KeptEntry, 'label' | 'labelKind' | 'facts' | 'scope'>): TextPart {
  const f = e.facts
  if (!e.labelKind || !f) return e.label
  if (f.kind === 'scenarios') return e.labelKind === 'benchmark' ? said(M.labelBenchmark, { provider: f.provider }) : e.label
  const range = { from: formatDate(f.from), to: formatDate(f.to) }
  if (e.labelKind === 'kept') return said(M.labelKept, range)
  if (f.part && e.scope.kind === 'project') return said(M.labelExportPart, { ...range, project: e.scope.project })
  return said(M.labelExport, { ...range, own: f.filters.own ? 'yes' : 'no' })
}

/** What a kept comparison is, in a line, as the window shows it: from its facts in the window's language, else its English. */
export function keptAbout(e: Pick<KeptEntry, 'about' | 'facts'>): TextPart {
  const f = e.facts
  if (!f) return e.about
  if (f.kind === 'scenarios') {
    // i18n-ignore: a dash, for a run that had no permission mode
    const mode = f.mode ?? '–'
    return said(M.aboutScenarios, { real: f.real ? 'yes' : 'no', provider: f.provider, model: f.model, effort: f.effort, mode, fixtures: String(f.fixtures), scenarios: f.scenarios, repeats: f.repeats, head: `${f.head}${f.dirty ? '+' : ''}`, spent: moneyLabel(f.spentUsd), unpriced: f.unpriced })
  }
  const values = { from: formatDateTime(f.from), to: formatDateTime(f.to), filters: filtersText(f.filters) }
  return f.part ? said(M.aboutExportPart, { ...values, part: M.projectPart }) : said(M.aboutExport, values)
}

// ---------------------------------------------------------------------------
// Comparing.
// ---------------------------------------------------------------------------

export interface Stat {
  n: number
  mean: number
  min: number
  max: number
}

const stat = (xs: number[]): Stat | null => (xs.length ? { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null)

export interface MeasureDelta {
  key: string
  base: Stat | null
  run: Stat | null
  /** run.mean − base.mean, and as a share of base (null when base is 0 or either is missing or incomplete). */
  delta: number | null
  pct: number | null
  /** Both have several samples and their ranges overlap: the change is within the spread. */
  withinSpread: boolean
  /** Some samples didn't measure it: unknown, not zero, and not compared. */
  incomplete: boolean
}

export type ScenarioStatus = 'better' | 'same' | 'worse' | 'smaller-but-failing' | 'failing' | 'incomplete' | 'only-in-base' | 'only-in-run'

export interface CheckChange {
  name: string
  /** Of the usable samples: how many passed, failed, skipped it, on each side. */
  base: { passed: number; failed: number; skipped: number }
  run: { passed: number; failed: number; skipped: number }
}

export interface ScenarioComparison {
  id: string
  title: string
  status: ScenarioStatus
  /** Usable samples (completed, not stale) and how many passed every check that ran. */
  quality: { base: { passed: number; n: number }; run: { passed: number; n: number } }
  /** Checks on average a usable sample: passed, failed, skipped. */
  checks: { base: { passed: number; failed: number; skipped: number }; run: { passed: number; failed: number; skipped: number } }
  /** Checks that passed less often, or ran less often (skipped more), in the run. */
  regressions: CheckChange[]
  /** Failed checks in the run's samples (names). */
  failedChecks: string[]
  samples: { base: number; run: number }
  measures: MeasureDelta[]
  /** Whose the scenario's session is (HI-2186): the Assistant's, or an agent's. */
  subject: 'assistant' | 'agent'
  /** The subject's measures and the other agents' apart (HI-2186), when every usable sample on both sides has them. */
  split: { subject: MeasureDelta[]; others: MeasureDelta[] } | null
  /** Each agent's Combwork calls in the measured window, on average a sample (null: unknown), when every sample has them. */
  agents: AgentCallsDelta[] | null
  usage: MeasureDelta[] | null
  /** In English (tests, code); `notesText` is the same for the window. */
  notes: string[]
  notesText: Text[]
}

/** An agent's Combwork calls, baseline and run (HI-2186): null where a side can't say (its rows overflowed). */
export interface AgentCallsDelta {
  agent: string
  role: AgentCalls['role']
  side: AgentCalls['side']
  /** An `overflow` row: how many agents it sums, at most. */
  agents?: number
  base: number | null
  run: number | null
}

export interface Comparison {
  kind: 'scenarios' | 'export'
  comparable: boolean
  /** Why they can't be compared (when not comparable), or what differs that a reader should know. */
  reasons: string[]
  notes: string[]
  /** The reasons and notes as text, for the window (#1104): the English fields are these in English. */
  reasonsText: Text[]
  notesText: Text[]
  scenarios?: ScenarioComparison[]
  rows?: MeasureDelta[]
  summary: Partial<Record<ScenarioStatus, number>>
}

/** A change this small (or smaller) is "the same": exact sizes still move by a few bytes (a card number, a date). */
const SAME_PCT = 0.01

function deltaOf(key: string, base: Sample[] | number[], run: Sample[] | number[], pick?: (s: Sample) => number | undefined): MeasureDelta {
  const values = (xs: Sample[] | number[]): { vals: number[]; missing: boolean } => {
    if (!pick) return { vals: xs as number[], missing: false }
    const vals = (xs as Sample[]).map(pick)
    return { vals: vals.filter((x): x is number => typeof x === 'number'), missing: vals.some((x) => typeof x !== 'number') }
  }
  const b = values(base)
  const r = values(run)
  const bs = stat(b.vals)
  const rs = stat(r.vals)
  const incomplete = b.missing || r.missing
  const delta = bs && rs && !incomplete ? rs.mean - bs.mean : null
  return { key, base: bs, run: rs, delta, pct: delta !== null && bs!.mean > 0 ? delta / bs!.mean : null, withinSpread: !!(bs && rs && bs.n > 1 && rs.n > 1 && rs.min <= bs.max && bs.min <= rs.max), incomplete }
}

/** Usable: completed, correctness known, and not given stale guidance. */
const usable = (s: Sample): boolean => s.ok !== null && !s.stale

/** Per check name, how many of the samples passed, failed and skipped it. */
function checkCounts(samples: Sample[]): Map<string, { passed: number; failed: number; skipped: number }> {
  const m = new Map<string, { passed: number; failed: number; skipped: number }>()
  for (const s of samples)
    for (const c of s.checks) {
      const e = m.get(c.name) ?? { passed: 0, failed: 0, skipped: 0 }
      if (c.ok === true) e.passed++
      else if (c.ok === false) e.failed++
      else e.skipped++
      m.set(c.name, e)
    }
  return m
}

const avg = (xs: Sample[], f: (s: Sample) => number): number => (xs.length ? xs.reduce((n, s) => n + f(s), 0) / xs.length : 0)

/** Measures that mean more failures or more work when they grow: a growth is a regression, whatever the size did. */
const FAILURE_KEYS = ['combworkCallErrors', 'toolErrors', 'apiFailed', 'apiCancelled', 'repeatedCalls', 'combworkCalls']

/** Why a sample is left out: Combwork's own reasons as messages, the harness's own words (or an older Hive's) as written. */
const SAMPLE_PROBLEMS = [M.tooManyChecks, M.invalidCheck, M.checkTwice, M.checksNotList, M.countsDiffer, M.failedNoCheck, M.noCheckRan, M.didntComplete]
const sampleProblem = (reason: string): TextPart => SAMPLE_PROBLEMS.find((m) => m.defaultMessage === reason) ?? reason

function compareScenario(id: string, base: ScenarioResult | undefined, run: ScenarioResult | undefined, compareUsage: boolean): ScenarioComparison {
  const title = run?.title || base?.title || id
  const zero = { passed: 0, failed: 0, skipped: 0 }
  const empty = { quality: { base: { passed: 0, n: 0 }, run: { passed: 0, n: 0 } }, checks: { base: zero, run: zero }, regressions: [], failedChecks: [] }
  const subject = (run?.role ?? base?.role) === 'assistant' ? 'assistant' : 'agent'
  if (!base || !run) return { id, title, status: base ? 'only-in-base' : 'only-in-run', ...empty, samples: { base: base?.samples.length ?? 0, run: run?.samples.length ?? 0 }, measures: [], subject, split: null, agents: null, usage: null, notes: [], notesText: [] }
  const b = base.samples.filter(usable)
  const r = run.samples.filter(usable)
  const notes: Text[] = []
  const all = [...base.samples, ...run.samples]
  const stale = all.filter((s) => s.stale).length
  if (stale) notes.push(said(M.stale, { n: stale }))
  const incomplete = all.filter((s) => s.ok === null && !s.stale)
  if (incomplete.length) notes.push(said(M.leftOut, { n: incomplete.length, why: listOf([...new Set(incomplete.map((s) => s.incomplete ?? M.didntComplete.defaultMessage))].map(sampleProblem), 'unit') }))
  if (b.length === 1 || r.length === 1) notes.push(M.oneSample)
  const partial = [...b, ...r].filter((s) => s.coverage.recording !== true || s.coverage.dropped > 0 || s.coverage.partial.length || !s.measures)
  if (partial.length) notes.push(said(M.measuredPartly, { n: partial.length }))
  // Skill revisions the sessions were given: different on the two sides (an edited skill) is said.
  const revs = (xs: Sample[]): string => [...new Set(xs.map((s) => JSON.stringify(s.skills ?? {})))].join('|')
  if (b.length && r.length && revs(b) !== revs(r)) {
    const names = new Set<string>()
    for (const s of [...b, ...r]) for (const [k, v] of Object.entries(s.skills ?? {})) if ([...b, ...r].some((x) => (x.skills ?? {})[k] !== v)) names.add(k)
    notes.push(names.size ? said(M.skillRevisionsOf, { names: listOf([...names].slice(0, 6), 'unit') }) : M.skillRevisions)
  }
  const quality = { base: { passed: b.filter((s) => s.ok).length, n: b.length }, run: { passed: r.filter((s) => s.ok).length, n: r.length } }
  const checks = { base: { passed: avg(b, (s) => s.passed), failed: avg(b, (s) => s.failed), skipped: avg(b, (s) => s.skipped) }, run: { passed: avg(r, (s) => s.passed), failed: avg(r, (s) => s.failed), skipped: avg(r, (s) => s.skipped) } }
  // Check by check: one that passed (or ran) less often in the run is a regression, whatever the samples' summary says.
  const bc = checkCounts(b)
  const rc = checkCounts(r)
  const regressions: CheckChange[] = []
  for (const name of new Set([...bc.keys(), ...rc.keys()])) {
    const x = bc.get(name) ?? zero
    const y = rc.get(name) ?? zero
    const share = (c: typeof zero, n: number): number => (n ? c.passed / n : 0)
    const ran = (c: typeof zero, n: number): number => (n ? (c.passed + c.failed) / n : 0)
    const fails = (c: typeof zero, n: number): number => (n ? c.failed / n : 0)
    if (b.length && r.length && (share(y, r.length) < share(x, b.length) || ran(y, r.length) < ran(x, b.length) || fails(y, r.length) > fails(x, b.length))) regressions.push({ name, base: x, run: y })
  }
  const failedChecks = [...new Set(r.flatMap((s) => s.failedChecks))].slice(0, BENCHMARK_LIMITS.failedChecks)
  const measures = SCENARIO_MEASURES.map((m) => deltaOf(m.key, b, r, (s) => s.measures?.[m.key]))
  // The subject apart from the other agents (HI-2186): only when every usable sample on both sides was split; else the
  // totals alone, and said so.
  const splitOn = (xs: Sample[]): boolean => xs.length > 0 && xs.every((s) => !!s.split)
  const split =
    splitOn(b) && splitOn(r)
      ? {
          subject: SCENARIO_MEASURES.filter((m) => SPLIT_SHOWN.has(m.key)).map((m) => deltaOf(m.key, b, r, (s) => s.split?.subject[m.key])),
          others: SCENARIO_MEASURES.filter((m) => SPLIT_SHOWN.has(m.key)).map((m) => deltaOf(m.key, b, r, (s) => s.split?.others[m.key]))
        }
      : null
  if (!split && b.length && r.length) notes.push(said(M.noSplit, { side: splitOn(b) ? 'run' : splitOn(r) ? 'baseline' : 'both' }))
  if (split && [...b, ...r].some((s) => s.splitPartial)) notes.push(M.splitPartial)
  const agents = agentDeltas(b, r)
  // Provider usage: model trials only, and only when every usable sample on both sides reported it.
  let usageRows: MeasureDelta[] | null = null
  if (compareUsage && b.length && r.length) {
    usageRows = USAGE_MEASURES.map((m) => deltaOf(m.key, b, r, (s) => s.usage?.[m.key])).filter((d) => !d.incomplete)
    if (!usageRows.length) {
      usageRows = null
      if ([...b, ...r].some((s) => s.usage)) notes.push(M.usageNotEvery)
    }
    if ([...b, ...r].some((s) => s.costEstimated)) notes.push(M.estimates)
  }
  if ([...b, ...r].some((s) => s.resumed)) notes.push(M.resumed)
  const samples = { base: base.samples.length, run: run.samples.length }
  if (!b.length || !r.length) return { id, title, status: 'incomplete', quality, checks, regressions, failedChecks, samples, measures, subject, split, agents, usage: usageRows, ...told(notes) }
  const rate = (q: { passed: number; n: number }): number => q.passed / q.n
  const get = (k: string): MeasureDelta => measures.find((m) => m.key === k)!
  const context = get('contextBytes')
  const sizeKnown = !partial.length && !context.incomplete && context.delta !== null
  const smaller = sizeKnown && (context.pct ?? 0) < -SAME_PCT
  const larger = sizeKnown && ((context.pct ?? 0) > SAME_PCT || (context.base?.mean === 0 && (context.run?.mean ?? 0) > 0))
  const moreFailures = FAILURE_KEYS.some((k) => (get(k).delta ?? 0) > 0)
  const failureUnknown = FAILURE_KEYS.some((k) => get(k).incomplete)
  const correctnessWorse = regressions.length > 0 || rate(quality.run) < rate(quality.base)
  let status: ScenarioStatus
  if (correctnessWorse) status = smaller ? 'smaller-but-failing' : 'worse'
  else if (quality.run.passed < quality.run.n) status = 'failing'
  else if (moreFailures || larger) status = 'worse'
  else if (!sizeKnown || failureUnknown) status = 'incomplete'
  else if (smaller) status = 'better'
  else status = 'same'
  if (status === 'incomplete') notes.push(M.notJudged)
  if (status === 'better' && context.withinSpread) notes.push(M.withinSpread)
  return { id, title, status, quality, checks, regressions, failedChecks, samples, measures, subject, split, agents, usage: usageRows, ...told(notes) }
}

/** The measures shown for each part (HI-2186): those an agent's work makes, none the harness counts for the subject alone. */
const SPLIT_SHOWN = new Set(SCENARIO_MEASURES.map((m) => m.key).filter((k) => !NOT_SPLIT.has(k) && k !== 'seconds'))

/**
 * Each agent's Combwork calls on average a sample, baseline and run (HI-2186), matched by its fixture identity (name and
 * role), the subject first. An agent missing from a sample's rows made no call, unless that sample's rows overflowed:
 * then that side is unknown for it. Null unless every usable sample on both sides listed its agents.
 */
function agentDeltas(b: Sample[], r: Sample[]): AgentCallsDelta[] | null {
  if (!b.length || !r.length || ![...b, ...r].every((s) => s.agents)) return null
  const key = (a: AgentCalls): string => JSON.stringify([a.agent, a.role])
  const rows = new Map<string, AgentCallsDelta>()
  for (const s of [...b, ...r]) for (const a of s.agents!) if (!rows.has(key(a))) rows.set(key(a), { agent: a.agent, role: a.role, side: a.side, base: null, run: null })
  const mean = (xs: Sample[], k: string): { v: number | null; agents?: number } => {
    let n = 0
    let most: number | undefined
    for (const s of xs) {
      const row = s.agents!.find((a) => key(a) === k)
      if (row) {
        n += row.combworkCalls
        if (row.agents !== undefined) most = Math.max(most ?? 0, row.agents)
      } else if (s.agents!.some((a) => a.agent === 'overflow')) return { v: null }
    }
    return { v: n / xs.length, ...(most !== undefined ? { agents: most } : {}) }
  }
  const rank = (a: AgentCallsDelta): number => (a.side === 'subject' ? 0 : a.agent === 'overflow' ? 3 : a.agent === 'unattributed' ? 2 : 1)
  return [...rows.entries()]
    .map(([k, a]) => {
      const x = mean(b, k)
      const y = mean(r, k)
      const most = Math.max(x.agents ?? 0, y.agents ?? 0)
      return { ...a, base: x.v, run: y.v, ...(most ? { agents: most } : {}) }
    })
    .sort((x, y) => rank(x) - rank(y) || x.agent.localeCompare(y.agent, 'en') || x.role.localeCompare(y.role, 'en'))
}

/** A scenario's notes, in English and as text. */
// window: benchmarks are the window's (Help → Benchmarks) and their saved files'; no agent reads them
const told = (notes: Text[]): { notes: string[]; notesText: Text[] } => ({ notes: notes.map((t) => englishText(t)), notesText: notes })

/** A comparison's reasons and notes, in English and as text. */
// window: benchmarks are the window's (Help → Benchmarks) and their saved files'; no agent reads them
const why = (reasons: Text[], notes: Text[]): Pick<Comparison, 'reasons' | 'notes' | 'reasonsText' | 'notesText'> => ({ reasons: reasons.map((t) => englishText(t)), reasonsText: reasons, ...told(notes) })

const sameScope = (a: CompareScope, b: CompareScope): boolean => compareScopeKey(a) === compareScopeKey(b)

/**
 * Compares a baseline with a run: scenario benchmarks scenario by scenario (only the ones both ran; correctness first),
 * exports measure by measure per hour recorded. Not comparable (and said why) when they measured different things:
 * another scope, kind, scenarios' version, provider, model or setup, a fake against a model, a run whose source changed
 * while it ran, or exports of other filters.
 */
export function compareArtifacts(base: Artifact, run: Artifact): Comparison {
  const reasons: Text[] = []
  const notes: Text[] = []
  if (base.kind !== run.kind) return { kind: run.kind, comparable: false, ...why([M.differentKinds], notes), summary: {} }
  if (!sameScope(base.scope, run.scope)) reasons.push(said(M.differentScopes, { base: scopeName(base.scope), run: scopeName(run.scope) }))
  if (base.kind === 'scenarios' && base.run && run.run && base.scenarios && run.scenarios) {
    const a = base.run
    const b = run.run
    if (a.fixturesVersion !== b.fixturesVersion) reasons.push(said(M.differentFixtures, { base: a.fixturesVersion, run: b.fixturesVersion }))
    if (a.real !== b.real) reasons.push(M.fakeVsModel)
    if (a.providerId !== b.providerId || a.provider !== b.provider) reasons.push(said(M.differentProviders, { base: a.provider, run: b.provider }))
    if (a.real && b.real && (a.model !== b.model || a.effort !== b.effort || a.mode !== b.mode)) reasons.push(said(M.differentSetups, { base: listOf([a.model, a.effort, a.mode ?? '–'], 'unit'), run: listOf([b.model, b.effort, b.mode ?? '–'], 'unit') }))
    for (const [side, r] of [['baseline', a] as const, ['run', b] as const]) if (r.sourceChangedDuringRun) reasons.push(said(M.sourceChanged, { side }))
    if (a.real && b.real && a.cliVersions.join() !== b.cliVersions.join()) notes.push(said(M.cliVersions, { base: a.cliVersions.length ? listOf(a.cliVersions, 'unit') : '?', run: b.cliVersions.length ? listOf(b.cliVersions, 'unit') : '?' }))
    if (a.guidance && b.guidance && a.guidance === b.guidance) notes.push(M.sameGuidance)
    const realUsage = a.real && b.real
    if (!realUsage) notes.push(M.fakeUsage)
    // The scripted fakes start a combwork server a call (fake-copilot runs the real Copilot CLI, which keeps one).
    if ([a, b].some((x) => x.provider === 'fake' || x.provider === 'fake-codex')) notes.push(M.fakePerCall)
    const ids = [...new Set([...base.scenarios.map((s) => s.id), ...run.scenarios.map((s) => s.id)])]
    const scenarios = ids.map((id) =>
      compareScenario(
        id,
        base.scenarios!.find((s) => s.id === id),
        run.scenarios!.find((s) => s.id === id),
        realUsage
      )
    )
    const summary: Partial<Record<ScenarioStatus, number>> = {}
    for (const s of scenarios) summary[s.status] = (summary[s.status] ?? 0) + 1
    return { kind: 'scenarios', comparable: reasons.length === 0, ...why(reasons, notes), scenarios, summary }
  }
  if (base.kind === 'export' && base.summary && run.summary) {
    const a = base.summary
    const b = run.summary
    const filters = filtersText
    const same = (x: ExportSummary['filters'], y: ExportSummary['filters']): boolean => x.role === y.role && x.provider === y.provider && !!x.own === !!y.own
    if (!same(a.filters, b.filters)) reasons.push(said(M.differentFilters, { base: filters(a.filters), run: filters(b.filters) }))
    if (!a.observedMs || !b.observedMs) reasons.push(M.notRecording)
    for (const [side, s] of [['baseline', a] as const, ['run', b] as const]) if (s.partial.length) notes.push(said(M.partial, { side, what: s.partialWhy?.length ? listOf(s.partialWhy.map(partialText)) : s.partial.join('; ') }))
    if (Math.abs(a.rangeMs - b.rangeMs) > 3_600_000) notes.push(M.rangesDiffer)
    const known = (s: ExportSummary, ...keys: string[]): boolean => keys.every((k) => typeof s.totals[k] === 'number')
    const perHour = (s: ExportSummary, k: string): number[] => (s.observedMs ? [s.totals[k] / (s.observedMs / 3_600_000)] : [])
    // An average a launch: what it adds up over what it is averaged over (none: no value, not zero).
    const PER_LAUNCH: Record<string, [string, string]> = { guidancePerLaunch: ['guidanceBytes', 'launches'], toolListPerLaunch: ['toolListChars', 'toolListStarts'] }
    const row = (key: string, measure: string, suffix = ''): MeasureDelta => {
      const per = PER_LAUNCH[measure]
      const keys = (per ?? [measure]).map((k) => k + suffix)
      // Unknown on a side (a damaged measurement in its file, or a summary kept before it was measured): shown as
      // unknown, never compared.
      if (!known(a, ...keys) || !known(b, ...keys)) return { key, base: null, run: null, delta: null, pct: null, withinSpread: false, incomplete: true }
      const average = (s: ExportSummary): number[] => (s.totals[keys[1]] ? [s.totals[keys[0]] / s.totals[keys[1]]] : [])
      return per ? deltaOf(key, average(a), average(b)) : deltaOf(key, perHour(a, keys[0]), perHour(b, keys[0]))
    }
    const rows = EXPORT_MEASURES.map((m) => row(m.key, m.key))
    // Each workflow role either side has launches or tool lists of (HI-2049), its own measures.
    for (const side of WORKFLOW_SIDES) {
      const has = (s: ExportSummary): boolean => (s.totals[`launches.${side}`] ?? 0) > 0 || (s.totals[`toolListStarts.${side}`] ?? 0) > 0
      if (has(a) || has(b)) for (const m of SIDE_MEASURES) rows.push(row(`${m}.${side}`, m, `.${side}`))
    }
    notes.push(M.realUse)
    return { kind: 'export', comparable: reasons.length === 0, ...why(reasons, notes), rows, summary: {} }
  }
  return { kind: run.kind, comparable: false, ...why([M.oneIncomplete], notes), summary: {} }
}
