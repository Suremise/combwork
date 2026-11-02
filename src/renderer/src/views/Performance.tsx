import { Children, useCallback, useEffect, useMemo, useRef } from 'react'
import type { ProjectInfo } from '@shared/types'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import { providerDescriptor, providerName } from '@shared/providers'
import { LATENCY_BOUNDS_MS, percentile, type GuidanceSeries, type MetricsReport, type MetricsScope, type ProviderUsageSummary, type SafeguardCount, type TrendPoint } from '@shared/metrics'
import { DEFAULT_PERF_FILTERS, PERF_RANGES, WORKSPACE_OWN, byRoute, byTool, isEmpty, latencyOrder, pageQuery, providersIn, select, toolListRows, totals, type PerfFilters, type PerfRange, type PerfRole, type PerfSelection, type RouteRow, type ToolListRow, type ToolRow } from '@shared/metricsView'
import { compareScopeKey, compareScopeOf } from '@shared/benchmark'
import { FREE_LOCAL, moneyLabel } from '@shared/usageTotals'
import { formatDateTime, formatDayLabel, formatWeekdayTime } from '@shared/dates'
import { shownText } from '@shared/advanced'
import { call } from '../api'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote, Tooltip } from '../components/ui'
import { CellLines, DataTable, type DataColumn } from '../components/DataTable'
import { notify, set, setActivity, useLanguage, useStore } from '../store'
import { useScopedLoad } from '../scopedLoad'
import { useShallow } from 'zustand/react/shallow'
import { cx, formatBytes, formatTokens, timeAgo } from '../util'
import { ComparePanel } from './PerformanceCompare'
import { AntivirusLine } from '../components/Antivirus'
import { Card } from './WorkspaceOverview'
import { CardsTable } from './PerformanceCards'
import { StallsTable } from './PerformanceStalls'

/**
 * Performance: what Hive's own parts cost (shared/metrics.ts, recorded by main/metrics.ts), for the whole workspace (the
 * activity bar's view, with a project filter) or one project (its Performance tab, fixed to it). One page for both:
 * the scope is explicit in every query, and a project's page asks for its project only, so it can't show another
 * project's work, the Assistant's or the workspace's own. It refreshes every minute while it is shown, through Hive's
 * window (not the Agent API, so reading it adds nothing to what it shows).
 */

const REFRESH_MS = 60_000

const M = {
  noWorkspace: msg({ id: 'performance.noWorkspace', defaultMessage: 'Open a workspace to see its performance.', description: 'The Performance view (and its sidebar) when no workspace is open.' }),
  heading: msg({ id: 'performance.heading', defaultMessage: 'Performance', description: "Heading of the Performance view (what Hive's own parts cost) and of its sidebar." }),
  panelTip: msg({ id: 'performance.panel.tip', defaultMessage: "What Hive's Agent API, its tools, the guidance it gives sessions and its skill service cost. Pick what to look at.", description: "Info tip beside the Performance sidebar's heading. Agent API is the name of Hive's local HTTP API." }),
  whole: msg({ id: 'performance.scope.whole', defaultMessage: 'Whole workspace', description: 'What the Performance view shows: everything in the workspace. A row in its sidebar, a choice of its Scope list and its badge.' }),
  wholeTip: msg({ id: 'performance.scope.wholeTip', defaultMessage: 'Every project and the workspace’s own work, each counted once.', description: 'Tooltip of the Whole workspace row in the Performance sidebar.' }),
  own: msg({ id: 'performance.scope.own', defaultMessage: 'Workspace’s own work', description: "What the Performance view shows: the work of no project (the Hive Assistant's, scripts'). A row in its sidebar, a choice of its Scope list and its badge." }),
  ownTip: msg({ id: 'performance.scope.ownTip', defaultMessage: 'Work of no project: the Hive Assistant, scripts with the workspace token, and Hive’s shared work.', description: "Tooltip of the Workspace's own work row in the Performance sidebar." }),
  projects: msg({ id: 'performance.panel.projects', defaultMessage: 'Projects', description: "Section heading in the Performance sidebar, above the workspace's projects." }),
  projectTip: msg({ id: 'performance.scope.projectTip', defaultMessage: "Only {project}'s work. Its own Performance tab shows the same.", description: "Tooltip of a project's row in the Performance sidebar. {project} is the project's name." }),
  project: msg({ id: 'performance.scope.project', defaultMessage: 'Project: {project}', description: "The Performance page's badge when it shows one project. {project} is its name." }),
  pageLabel: msg({ id: 'performance.pageLabel', defaultMessage: 'Performance, {scope}', description: 'Name of the Performance page for screen readers. {scope} is what it shows, such as "Whole workspace" or "Project: hive".' }),
  scopeTitle: msg({ id: 'performance.scope.badgeTitle', defaultMessage: 'What these numbers are about', description: "Tooltip of the Performance page's badge naming what it shows." }),
  viewLabel: msg({ id: 'performance.view.label', defaultMessage: 'Now or compare', description: 'Name, for screen readers, of the switch between the Now and Compare views of the Performance page.' }),
  now: msg({ id: 'performance.view.now', defaultMessage: 'Now', description: 'Button of the Performance page: shows the live metrics. Keep it short.' }),
  compare: msg({ id: 'performance.view.compare', defaultMessage: 'Compare', description: 'Button of the Performance page: compares two kept metrics files. Keep it short.' }),
  introWorkspace: msg({ id: 'performance.intro.workspace', defaultMessage: 'What Hive’s Agent API, its tools, the guidance it gives sessions and its skill service cost, next to what the providers reported.', description: "Under the Performance view's heading. Agent API is the name of Hive's local HTTP API; the providers are Claude Code, Codex and Copilot." }),
  introProject: msg({ id: 'performance.intro.project', defaultMessage: 'What Hive’s Agent API, its tools, the guidance it gives sessions cost, next to what the providers reported. Only this project’s work: the Assistant’s, scripts’ and other projects’ aren’t in it.', description: "Under the heading of a project's Performance tab. Agent API is the name of Hive's local HTTP API; the providers are Claude Code, Codex and Copilot." }),
  rangeLabel: msg({ id: 'performance.range.label', defaultMessage: 'Time range', description: "Name, for screen readers, of the Performance page's time range buttons." }),
  range: msg({ id: 'performance.range.name', defaultMessage: '{range, select, 24h {24 hours} 7d {7 days} other {30 days}}', description: "A time range button of the Performance page. {range} is a key (24h, 7d or 30d): don't translate the keys, only the texts." }),
  scope: msg({ id: 'performance.scope.label', defaultMessage: 'Scope', description: "Label of the Performance view's list choosing what it shows (the whole workspace, its own work or a project)." }),
  updated: msg({ id: 'performance.updated', defaultMessage: 'Updated {when}; every minute while shown.', description: 'Tooltip of the Performance page\'s refresh button. {when} is how long ago, such as "4 minutes ago".' }),
  loading: msg({ id: 'performance.loading', defaultMessage: 'Loading…', description: 'The Performance page while its metrics load.' }),
  refresh: msg({ id: 'performance.refresh', defaultMessage: 'Refresh', description: "The Performance page's refresh button." }),
  exportTip: msg({ id: 'performance.export.tip', defaultMessage: "Save what this page shows (its scope, range and Who; every provider’s, each named in its rows) as a JSON file, with units, coverage and Hive's version. Shift+click: with project names replaced (project-1, project-2…) and no workspace path.", description: "Tooltip of the Performance page's Export button. Who is the name of the page's filter of who did the work: keep it as named there. Keep JSON, Shift+click and project-1, project-2… as they are." }),
  exportButton: msg({ id: 'performance.export.button', defaultMessage: 'Export', description: 'Button of the Performance page: saves its metrics as a JSON file.' }),
  exported: msg({ id: 'performance.export.done', defaultMessage: 'Performance metrics exported', description: "Title of a notification after the Performance page's Export; its message is the file's path." }),
  exportFailed: msg({ id: 'performance.export.failed', defaultMessage: 'Could not export the performance metrics', description: 'Title of an error notification; its message is the error.' }),
  compareHint: msg({ id: 'performance.compare.hint', defaultMessage: 'Compare puts two kept files side by side: each keeps the range and filters it was made with (shown below). The range and Who of Now only shape what <b>Keep current view</b> saves (every provider’s).', description: "Under the Performance page's controls in its Compare view. Compare, Who, Now and Keep current view are names of its buttons and filter: keep them as named there. <b> is shown in bold." }),
  keeps: msg({ id: 'performance.compare.keeps', defaultMessage: '{range, select, 24h {24 hours} 7d {7 days} other {30 days}}, {role, select, all {everyone} agent {project agents} assistant {the Assistant} api {scripts} viewer {viewer apps} other {{role}}}, every provider', description: "What Compare's Keep current view saves, shown in its tooltip after \"Keep what the Now view shows to compare with later:\". {range} (24h, 7d or 30d) and {role} (all, agent, assistant, api, viewer) are keys: don't translate the keys, only the texts. Lower case: it follows a colon." }),
  notRecording: msg({ id: 'performance.notRecording', defaultMessage: 'Hive isn’t recording performance metrics, so nothing new is added (what was recorded is still shown).', description: 'Banner on the Performance page when recording is turned off in Settings → Sessions. A link to the setting follows it.' }),
  settingsLink: msg({ id: 'performance.notRecording.settings', defaultMessage: 'Settings → Sessions', description: 'Link after the Performance page\'s "isn\'t recording" banner: opens that settings section. Use the names Settings shows.' }),
  loadTarget: msg({ id: 'performance.loadTarget', defaultMessage: 'the performance metrics', description: 'What could not be read on the Performance page: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  whoGroup: msg({ id: 'performance.who.groupLabel', defaultMessage: 'Filtered by who did the work', description: 'Name, for screen readers, of the box of the Performance page that its Who filter changes.' }),
  who: msg({ id: 'performance.who.label', defaultMessage: 'Who', description: "Label of the Performance page's filter of who did the work (everyone, project agents, the Assistant…), and a column header: whose sessions a row is. Keep it short." }),
  whoSelect: msg({ id: 'performance.who.select', defaultMessage: 'Who did the work', description: "Name, for screen readers, of the Performance page's Who filter." }),
  followsAll: msg({ id: 'performance.who.followsAll', defaultMessage: 'Everything below follows it.', description: "Beside the Performance page's Who filter, on a project's tab: everything under it is filtered." }),
  followsBox: msg({ id: 'performance.who.followsBox', defaultMessage: 'Everything in this box follows it; the skill service below it is the whole workspace’s.', description: "Beside the Performance view's Who filter." }),
  empty: msg({ id: 'performance.empty', defaultMessage: 'Nothing recorded {filtered, select, yes {for this filter } other {}}in the last {range, select, 24h {24 hours} 7d {7 days} other {30 days}}.', description: "The Performance page when nothing was recorded. {filtered} is yes when its Who filter is set; {range} (24h, 7d or 30d) is a key: don't translate the keys, only the texts." }),
  requests: msg({ id: 'performance.card.requests', defaultMessage: 'API requests', description: "Title of a Performance card: how many Agent API requests Hive answered." }),
  requestsSub: msg({ id: 'performance.card.requestsSub', defaultMessage: '{failed} failed · {cancelled} cancelled', description: "Under the API requests card's number. {failed} and {cancelled} are percentages (\"2%\") or — when there were none." }),
  requestsSubRate: msg({ id: 'performance.card.requestsSubRate', defaultMessage: '{rate, number} an hour recorded · {failed} failed · {cancelled} cancelled', description: "Under the API requests card's number. {rate} is requests per hour while Hive was recording; {failed} and {cancelled} are percentages (\"2%\")." }),
  requestsTip: msg({ id: 'performance.card.requestsTip', defaultMessage: 'Agent API requests (agents’ tools, the Assistant, scripts). An hour: over the time Hive was recording, not the whole range. Failed: refused, client or server errors. Cancelled: the client went away before the reply. Waits (an isolated check waiting for a check copy) are counted but never failed.', description: 'Tooltip of the API requests card. An hour, Failed and Cancelled are words of the card, Waits a column of the Agent API table: keep them as there.' }),
  latency: msg({ id: 'performance.card.latency', defaultMessage: 'Latency', description: 'Title of a Performance card: how long Agent API requests took.' }),
  p50: msg({ id: 'performance.card.p50', defaultMessage: 'p50 {latency}', description: 'The median request time, on the Latency card. {latency} is a time such as "≤ 25 ms". Keep p50.' }),
  p95: msg({ id: 'performance.card.p95', defaultMessage: 'p95 {latency}', description: 'The 95th percentile of request time, on the Latency card. {latency} is a time such as "≤ 250 ms". Keep p95.' }),
  latencyTip: msg({ id: 'performance.card.latencyTip', defaultMessage: "Request time in Hive, from the request to its reply, on a monotonic clock. Percentiles are the bounds of the histogram's buckets.", description: 'Tooltip of the Latency card.' }),
  data: msg({ id: 'performance.card.data', defaultMessage: 'Data', description: 'Title of a Performance card: how much the Agent API sent (its number) and received.' }),
  dataSub: msg({ id: 'performance.card.dataSub', defaultMessage: '{size} received', description: 'Under the Data card\'s number (what was sent). {size} is a size such as "1.5 MB".' }),
  dataTip: msg({ id: 'performance.card.dataTip', defaultMessage: "Bodies only, in UTF-8 bytes: what Hive's API sent and received. Not provider traffic: Hive isn't between the CLIs and their providers.", description: 'Tooltip of the Data card. Keep UTF-8.' }),
  toolReplies: msg({ id: 'performance.card.toolReplies', defaultMessage: 'Tool replies', description: "Title of a Performance card: how many characters Hive's tools replied with (its number)." }),
  toolRepliesSub: msg({ id: 'performance.card.toolRepliesSub', defaultMessage: '{calls, plural, one {characters in # call} other {characters in # calls}} · {size}', description: 'Under the Tool replies card\'s number (characters). {size} is the same in bytes, such as "12 KB".' }),
  toolRepliesTip: msg({ id: 'performance.card.toolRepliesTip', defaultMessage: "The text Hive's tools gave the models (what goes into their context), exactly: characters (UTF-16 code units) and UTF-8 bytes. Not tokens.", description: 'Tooltip of the Tool replies card. Keep UTF-16 and UTF-8.' }),
  guidance: msg({ id: 'performance.card.guidance', defaultMessage: 'Guidance per launch', description: 'Title of a Performance card: the size of what Hive gave each session at launch, on average.' }),
  guidanceSub: msg({ id: 'performance.card.guidanceSub', defaultMessage: '{launches, plural, one {# launch} other {# launches}} · core {core} · catalog {catalog}', description: "Under the Guidance per launch card's size. {core} and {catalog} are sizes such as \"4 KB\": Hive's session contract and its skills' catalog." }),
  guidanceTip: msg({ id: 'performance.card.guidanceTip', defaultMessage: "What Hive gave each session at launch, on average: its session contract (core), what it adds for the project, the Assistant's role and mode, and its skills' catalog (names and descriptions). Skill bodies are separate: a model reads one only when it uses it.", description: 'Tooltip of the Guidance per launch card. core and catalog are words of the card: keep them as there.' }),
  limits: msg({ id: 'performance.limits.heading', defaultMessage: 'What isn’t measured', description: 'A folded section at the end of the Performance page: what its numbers leave out.' }),
  limitsWindow: msg({ id: 'performance.limits.window', defaultMessage: 'This page reads through Hive’s window, not the Agent API: refreshing it adds nothing to these numbers.', description: 'The last line of What isn’t measured on the Performance page.' }),
  coverageRange: msg({ id: 'performance.coverage.range', defaultMessage: '{from} to {to} · kept 30 days, hourly for the last 7.', description: "At the top of the Performance page: the range shown. {from} and {to} are dates and times. Metrics are kept 30 days, by the hour for the last 7." }),
  coverageNone: msg({ id: 'performance.coverage.none', defaultMessage: 'Hive wasn’t recording this workspace in this range, so there is nothing to show (no data, not zero).', description: 'At the top of the Performance page, when Hive recorded nothing in the range.' }),
  coveragePartial: msg({ id: 'performance.coverage.partial', defaultMessage: 'Recorded for {duration} of it ({percent}){sinceShown, select, yes {, since {since}} other {}}{stretches, plural, =0 {} =1 {} other {, in # stretches}}: before that and in the gaps (Hive closed, recording off, a reset) nothing was seen.', description: 'At the top of the Performance page, when Hive recorded only part of the range. {duration} is how long, such as "3 h 10 min"; {percent} its share ("45%"); {since} a date and time, shown when {sinceShown} is yes; {stretches} how many separate stretches (said from 2).' }),
  coverageFull: msg({ id: 'performance.coverage.full', defaultMessage: 'Recorded throughout.', description: 'At the top of the Performance page, when Hive recorded the whole range.' }),
  dropped: msg({ id: 'performance.coverage.dropped', defaultMessage: '{n, plural, one {# measurement} other {# measurements}} not kept (a limit was full), so totals may be low.', description: 'At the top of the Performance page, when measurements were lost.' }),
  unattributed: msg({ id: 'performance.coverage.unattributed', defaultMessage: 'Some measurements couldn’t be attributed to a project: this project’s may be more than shown.', description: "At the top of a project's Performance page." }),
  evicted: msg({ id: 'performance.coverage.evicted', defaultMessage: 'History up to {when} was removed to keep the metrics file under its size limit: nothing before then is available.', description: 'At the top of the Performance page. {when} is a date and time.' }),
  minutes: msg({ id: 'performance.duration.minutes', defaultMessage: '{m, number} min', description: 'A length of time in minutes ("40 min"), on the Performance page.' }),
  hours: msg({ id: 'performance.duration.hours', defaultMessage: '{h, number} h', description: 'A length of time in whole hours ("3 h"), on the Performance page.' }),
  hoursMinutes: msg({ id: 'performance.duration.hoursMinutes', defaultMessage: '{h, number} h {m, number} min', description: 'A length of time in hours and minutes ("3 h 10 min"), on the Performance page.' }),
  days: msg({ id: 'performance.duration.days', defaultMessage: '{d, plural, one {# day} other {# days}}', description: 'A length of time in whole days ("2 days"), on the Performance page.' }),
  daysHours: msg({ id: 'performance.duration.daysHours', defaultMessage: '{d, plural, one {# day} other {# days}} {h, number} h', description: 'A length of time in days and hours ("2 days 4 h"), on the Performance page.' }),
  latencyOver: msg({ id: 'performance.latency.over', defaultMessage: '> {s, number} s', description: 'A request time above the largest measured bound ("> 30 s"), on the Performance page. s is seconds.' }),
  latencySeconds: msg({ id: 'performance.latency.seconds', defaultMessage: '≤ {s, number} s', description: 'A request time, at most this many seconds ("≤ 2.5 s"), on the Performance page.' }),
  latencyMs: msg({ id: 'performance.latency.ms', defaultMessage: '≤ {ms, number} ms', description: 'A request time, at most this many milliseconds ("≤ 250 ms"), on the Performance page.' }),
  trendHeading: msg({ id: 'performance.trend.heading', defaultMessage: '{step, select, hour {API requests by hour} other {API requests by day}}', description: "Heading of the Performance page's chart of requests. {step} is a key (hour or day): don't translate the keys, only the texts." }),
  trendLabel: msg({ id: 'performance.trend.label', defaultMessage: '{step, select, hour {API requests by hour, failures in a second colour} other {API requests by day, failures in a second colour}}', description: "Name, for screen readers, of the Performance page's chart of requests. {step} is a key (hour or day): don't translate the keys, only the texts." }),
  trendSlot: msg({ id: 'performance.trend.slot', defaultMessage: '<b>{when}</b>: {detail}', description: 'Tooltip of a bar of the requests chart. {when} is its hour or day (in bold); {detail} what happened then.' }),
  trendNotRecorded: msg({ id: 'performance.trend.notRecorded', defaultMessage: 'not recorded (Hive closed, recording off, or before a reset)', description: 'Tooltip of a bar of the requests chart, after its hour or day and a colon: Hive recorded nothing then. Lower case.' }),
  trendDetail: msg({ id: 'performance.trend.detail', defaultMessage: '{requests, plural, one {# request} other {# requests}}{failed, plural, =0 {} other {, # failed{cancelled, plural, =0 {} other { ({cancelled, number} cancelled)}}}} · {toolCalls, plural, one {# tool call} other {# tool calls}} ({chars, number} characters) · {launches, plural, one {# launch} other {# launches}}{partial, select, yes { · recorded for {duration} of it} other {}}', description: 'Tooltip of a bar of the requests chart, after its hour or day and a colon: what happened then. {duration} is how long Hive recorded in it ("40 min"), shown when {partial} is yes. Lower case.' }),
  succeeded: msg({ id: 'performance.trend.succeeded', defaultMessage: 'Succeeded', description: "Legend of the requests chart: the bars' colour for requests that succeeded." }),
  trendWaits: msg({ id: 'performance.trend.waits', defaultMessage: '{waits, plural, one {# wait} other {# waits}} for a check copy, not failures', description: 'A second line in the tooltip of a bar of the requests chart, shown when there were any: replies telling an isolated check to ask again because no check copy was free. Lower case.' }),
  waitsLegend: msg({ id: 'performance.trend.waitsLegend', defaultMessage: 'Waits', description: "Legend of the requests chart: the bars' colour for replies that told a check to wait (no check copy free), which aren't failures." }),
  failed: msg({ id: 'performance.trend.failed', defaultMessage: 'Failed', description: "Legend of the requests chart: the bars' colour for requests that failed." }),
  notRecorded: msg({ id: 'performance.trend.notRecordedLegend', defaultMessage: 'Not recorded', description: 'Legend of the requests chart: the hatched bars, when Hive recorded nothing.' }),
  assistant: msg({ id: 'performance.who.assistant', defaultMessage: 'Assistant', description: "In a Performance table's Who column: the Hive Assistant's sessions." }),
  agents: msg({ id: 'performance.who.agents', defaultMessage: 'Agents', description: "In a Performance table's Who column: project agents' sessions." }),
  tool: msg({ id: 'performance.tools.tool', defaultMessage: 'Tool', description: 'Column header of the Hive tools table: the tool\'s name (such as hive_read_task).' }),
  calls: msg({ id: 'performance.tools.calls', defaultMessage: 'Calls', description: 'Column header of the Hive tools table: how many times it was called.' }),
  chars: msg({ id: 'performance.tools.chars', defaultMessage: 'Characters', description: "Column header of the Hive tools table: its replies' characters." }),
  perCall: msg({ id: 'performance.tools.perCall', defaultMessage: 'Per call', description: "Column header of the Hive tools table: its replies' characters per call, on average." }),
  detail: msg({ id: 'performance.tools.detail', defaultMessage: 'Detail', description: 'Column header of the Hive tools table: calls that asked for the full form of the reply.' }),
  errors: msg({ id: 'performance.tools.errors', defaultMessage: 'Errors', description: 'Column header of the Hive tools table: calls that failed.' }),
  p50Header: msg({ id: 'performance.col.p50', defaultMessage: 'p50', description: 'Column header of a Performance table: the median time. Keep it short.' }),
  p95Header: msg({ id: 'performance.col.p95', defaultMessage: 'p95', description: 'Column header of a Performance table: the 95th percentile of time. Keep it short.' }),
  toolsHeading: msg({ id: 'performance.tools.heading', defaultMessage: 'Hive tools', description: "Heading of the Performance page's table of the hive tools agents called." }),
  toolsTip: msg({ id: 'performance.tools.tip', defaultMessage: "Each hive tool's replies as the models got them: characters and UTF-8 bytes, exactly. Detail: calls that asked for the full form. Sorted by characters, what costs a context most.", description: 'Info tip beside the Hive tools heading. Detail is a column of the table: keep it as named there.' }),
  toolsEmpty: msg({ id: 'performance.tools.empty', defaultMessage: 'No tool calls.', description: 'The Hive tools table when it has no rows.' }),
  route: msg({ id: 'performance.routes.route', defaultMessage: 'Route', description: "Column header of the Agent API table: the request's method and route (such as GET /api/tasks)." }),
  requestsHeader: msg({ id: 'performance.col.requests', defaultMessage: 'Requests', description: 'Column header of a Performance table: how many requests.' }),
  failedHeader: msg({ id: 'performance.routes.failed', defaultMessage: 'Failed', description: 'Column header of the Agent API table: requests that failed.' }),
  waitsHeader: msg({ id: 'performance.routes.waits', defaultMessage: 'Waits', description: 'Column header of the Agent API table: replies that told the caller to ask again (an isolated check waiting for a check copy), not failures.' }),
  cancelled: msg({ id: 'performance.routes.cancelled', defaultMessage: 'Cancelled', description: 'Column header of the Agent API table: requests the client gave up on.' }),
  sent: msg({ id: 'performance.routes.sent', defaultMessage: 'Sent', description: 'Column header of the Agent API table: the size of the replies Hive sent.' }),
  received: msg({ id: 'performance.routes.received', defaultMessage: 'Received', description: 'Column header of the Agent API table: the size of the requests Hive received.' }),
  routesHeading: msg({ id: 'performance.routes.heading', defaultMessage: 'Agent API', description: "Heading of the Performance page's table of Agent API requests. Agent API is the name of Hive's local HTTP API." }),
  routesTip: msg({ id: 'performance.routes.tip', defaultMessage: "Requests by route (its template, never the path asked for). The hive tools call these too; a tool call and its request are the same work, so don't add them up.", description: 'Info tip beside the Agent API heading.' }),
  routesEmpty: msg({ id: 'performance.routes.empty', defaultMessage: 'No requests.', description: 'The Agent API table when it has no rows.' }),
  providerGroup: msg({ id: 'performance.provider.groupLabel', defaultMessage: 'Filtered by provider', description: 'Name, for screen readers, of the box of the Performance page that its Provider filter changes.' }),
  provider: msg({ id: 'performance.provider.label', defaultMessage: 'Provider', description: "Label of the Performance page's provider filter, and a column header: the CLI (Claude Code, Codex, Copilot)." }),
  allProviders: msg({ id: 'performance.provider.all', defaultMessage: 'All providers', description: "The Performance page's provider filter's choice of no filter." }),
  providerNote: msg({ id: 'performance.provider.note', defaultMessage: 'Launches and the providers’ usage: the only parts recorded per provider.', description: "Beside the Performance page's Provider filter: what it changes." }),
  providerNothing: msg({ id: 'performance.provider.nothing', defaultMessage: 'Nothing from {provider} in the last {range, select, 24h {24 hours} 7d {7 days} other {30 days}}{filtered, select, yes { for this filter} other {}}.', description: "The Performance page's provider box when the provider chosen has nothing. {provider} is its name (Claude Code, Codex, Copilot); {filtered} is yes when the Who filter is set; {range} (24h, 7d or 30d) is a key: don't translate the keys, only the texts." }),
  toolListHeading: msg({ id: 'performance.toolList.heading', defaultMessage: 'Hive tool list', description: "Heading of the Performance page's table of the hive tools' list each session was given (HI-2063). Keep hive (the tools' name)." }),
  toolListTip: msg({ id: 'performance.toolList.tip', defaultMessage: 'The hive tools’ names, descriptions and schemas as each session’s CLI got them, once a start, on average, for every provider (not recorded per provider). Characters are the list’s JSON; Descriptions and Parameters are the tools’ descriptions and their parameters’ descriptions in it; Schemas is the rest: names, types, keys, punctuation and escapes. A dash: not measured (sessions from before Hive measured it).', description: "Tooltip of the Hive tool list table on the Performance page (HI-2063). Descriptions, Parameters and Schemas are its columns: name them as there. Keep hive (the tools' name)." }),
  toolListEmpty: msg({ id: 'performance.toolList.empty', defaultMessage: 'No tool lists.', description: 'The Hive tool list table when it has no rows.' }),
  toolListStarts: msg({ id: 'performance.toolList.starts', defaultMessage: 'Starts', description: 'Column header of the Hive tool list table: how many session starts were given the list.' }),
  toolListTools: msg({ id: 'performance.toolList.tools', defaultMessage: 'Tools', description: 'Column header of the Hive tool list table: how many tools a start was given, on average.' }),
  toolListChars: msg({ id: 'performance.toolList.chars', defaultMessage: 'Characters', description: "Column header of the Hive tool list table: the list's characters a start, on average." }),
  toolListDescriptions: msg({ id: 'performance.toolList.descriptions', defaultMessage: 'Descriptions', description: "Column header of the Hive tool list table: the characters of the tools' descriptions a start, on average." }),
  toolListParams: msg({ id: 'performance.toolList.params', defaultMessage: 'Parameters', description: "Column header of the Hive tool list table: the characters of the tools' parameters' descriptions a start, on average." }),
  toolListSchemas: msg({ id: 'performance.toolList.schemas', defaultMessage: 'Schemas', description: "Column header of the Hive tool list table: the rest of the list's characters a start (names, types, keys, punctuation), on average." }),
  toolListBytes: msg({ id: 'performance.toolList.bytes', defaultMessage: 'Bytes', description: "Column header of the Hive tool list table: the list's size in UTF-8 bytes a start, on average." }),
  workflow: msg({ id: 'performance.guidance.workflow', defaultMessage: 'Workflow role', description: 'Column header of the Guidance at launch table (HI-2049): the side of the workflow the launched agents took. Glossary: workflow role.' }),
  workflowSide: msg({ id: 'performance.guidance.workflowSide', defaultMessage: '{side, select, builder {Builder} reviewer {Reviewer} either {Either} none {None} other {Not recorded}}', description: "A cell of the Guidance at launch table's Workflow role column (HI-2049): builder, reviewer, either (builds or reviews), none (a generalist, the Assistant), or not recorded (launches from before Hive recorded it). Glossary: builder, reviewer, either." }),
  launches: msg({ id: 'performance.guidance.launches', defaultMessage: 'Launches', description: 'Column header of the Guidance at launch table: how many sessions were launched.' }),
  core: msg({ id: 'performance.guidance.core', defaultMessage: 'Core', description: "Column header of the Guidance at launch table: Hive's session contract's size per launch." }),
  projectBytes: msg({ id: 'performance.guidance.project', defaultMessage: 'Project', description: 'Column header of the Guidance at launch table: the size of what Hive adds for the project, per launch.' }),
  role: msg({ id: 'performance.guidance.role', defaultMessage: 'Role', description: "Column header of the Guidance at launch table: the size of the Assistant's role, per launch." }),
  mode: msg({ id: 'performance.guidance.mode', defaultMessage: 'Mode', description: "Column header of the Guidance at launch table: the size of the Assistant's mode, per launch." }),
  skills: msg({ id: 'performance.guidance.skills', defaultMessage: 'Skills', description: 'Column header of the Guidance at launch table: how many skills each launch got, on average.' }),
  catalog: msg({ id: 'performance.guidance.catalog', defaultMessage: 'Catalog', description: "Column header of the Guidance at launch table: the size of the skills' names and descriptions, per launch." }),
  onDisk: msg({ id: 'performance.guidance.onDisk', defaultMessage: 'On disk', description: "Column header of the Guidance at launch table: the size of the skills' delivered copies, per launch." }),
  notGiven: msg({ id: 'performance.guidance.notGiven', defaultMessage: 'Not given', description: "Column header of the Guidance at launch table: skills that weren't delivered or couldn't be measured." }),
  notGivenTip: msg({ id: 'performance.guidance.notGivenTip', defaultMessage: "{notDelivered, number} asked for but not delivered; {unmeasured, number} delivered but couldn't be measured (left out of the sizes, not counted as zero).", description: 'Tooltip of a cell of the Not given column: how many skills were asked for and not delivered, and how many were delivered but not measured.' }),
  guidanceHeading: msg({ id: 'performance.guidance.heading', defaultMessage: 'Guidance at launch', description: "Heading of the Performance page's table of what Hive gave sessions when they started." }),
  guidanceTableTip: msg({ id: 'performance.guidance.tip', defaultMessage: "What Hive gave sessions when they started, per launch on average, exactly. Core: Hive's session contract, the same for every session of a role. Project: what Hive adds for the project (the latest handover's pointer). Role and mode: the Assistant's. Catalog: the skills' names and descriptions (what a CLI lists); on disk: the delivered copies' bytes. A model reads a skill's body only when it uses it, which isn't observable.", description: 'Info tip beside the Guidance at launch heading. Core, Project, Role, Mode, Catalog and On disk are its columns: keep them as named there.' }),
  guidanceEmpty: msg({ id: 'performance.guidance.empty', defaultMessage: 'No launches.', description: 'The Guidance at launch table when it has no rows.' }),
  unmeasuredSkills: msg({ id: 'performance.guidance.unmeasured', defaultMessage: 'Skills marked ? couldn’t be measured.', description: 'Under the Guidance at launch table. Keep the ?: it is how those skills are marked in it.' }),
  sessions: msg({ id: 'performance.usage.sessions', defaultMessage: 'Sessions', description: 'Column header of the Provider usage table: how many sessions.' }),
  running: msg({ id: 'performance.usage.running', defaultMessage: '{n, number} running', description: 'Under the session count in the Provider usage table: how many of them are running.' }),
  unknownCount: msg({ id: 'performance.usage.unknownCount', defaultMessage: '{n, number} unknown', description: "Under the session count in the Provider usage table: how many of them reported no usage. Lower case." }),
  input: msg({ id: 'performance.usage.input', defaultMessage: 'Input', description: 'Column header of the Provider usage table: input tokens.' }),
  cacheRead: msg({ id: 'performance.usage.cacheRead', defaultMessage: 'Cache read', description: 'Column header of the Provider usage table: tokens read from the cache.' }),
  cacheWrite: msg({ id: 'performance.usage.cacheWrite', defaultMessage: 'Cache write', description: 'Column header of the Provider usage table: tokens written to the cache.' }),
  output: msg({ id: 'performance.usage.output', defaultMessage: 'Output', description: 'Column header of the Provider usage table: output tokens.' }),
  reasoning: msg({ id: 'performance.usage.reasoning', defaultMessage: 'of it reasoning', description: 'Column header of the Provider usage table, after Output: how many of the output tokens were reasoning. Lower case: it reads on from Output.' }),
  context: msg({ id: 'performance.usage.context', defaultMessage: 'Context', description: "Column header of the Provider usage table: the size of sessions' last request (their context)." }),
  contextTip: msg({ id: 'performance.usage.contextTip', defaultMessage: "Last request's context, over {sessions, plural, one {# session} other {# sessions}}: average {avg}, largest {max}{hasWindow, select, yes { of a {window} window} other {}}.", description: 'Tooltip of a cell of the Context column. {avg}, {max} and {window} are token counts such as "45k"; the window is shown when {hasWindow} is yes.' }),
  contextAvg: msg({ id: 'performance.usage.contextAvg', defaultMessage: '{avg} avg', description: 'A cell of the Context column: the average context, a token count such as "45k". Keep it short.' }),
  contextMax: msg({ id: 'performance.usage.contextMax', defaultMessage: '{max} max{hasWindow, select, yes { of {window}} other {}}', description: 'Under a cell of the Context column: the largest context and, when {hasWindow} is yes, the context window, token counts such as "120k". Keep it short.' }),
  compactions: msg({ id: 'performance.usage.compactions', defaultMessage: 'Compactions', description: "Column header of the Provider usage table: how many times sessions' context was compacted." }),
  safeguards: msg({ id: 'performance.safeguards.heading', defaultMessage: 'Safeguard stops', description: "Heading of the Performance page's table of responses a CLI's safety classifier stopped, and a column header of the Provider usage table." }),
  notDetected: msg({ id: 'performance.usage.notDetected', defaultMessage: 'not detected', description: "A cell of the Safeguard stops column for a provider whose transcripts don't record them. Lower case." }),
  cost: msg({ id: 'performance.usage.cost', defaultMessage: 'Cost', description: 'Column header of the Provider usage table: what the usage cost.' }),
  costUnknown: msg({ id: 'performance.usage.costUnknown', defaultMessage: '+ {n, number} unknown', description: 'Under a cost: how many sessions\' cost is unknown. Lower case.' }),
  costFree: msg({ id: 'performance.usage.costFree', defaultMessage: '{n, plural, one {+ # free (local)} other {+ # free (local)}}', description: "Under a cost: how many sessions ran only on a model server on this PC (Ollama, for example), so cost nothing (HI-1772). Lower case." }),
  unknown: msg({ id: 'performance.unknown', defaultMessage: 'unknown', description: 'A cell of a Performance table whose value no session reported (a token count, a model). Lower case.' }),
  agent: msg({ id: 'performance.safeguards.agent', defaultMessage: 'Agent', description: 'Column header of the Safeguard stops table: the agent (and its project).' }),
  model: msg({ id: 'performance.safeguards.model', defaultMessage: 'Model', description: 'Column header of the Safeguard stops table: the model the agent was on.' }),
  stops: msg({ id: 'performance.safeguards.stops', defaultMessage: 'Stops', description: 'Column header of the Safeguard stops table: how many responses were stopped.' }),
  safeguardsTip: msg({ id: 'performance.safeguards.tip', defaultMessage: "Responses a CLI's safety classifier stopped, in the sessions active in the range (each session's whole count), per agent and the model each was on. Copilot's sessions don't record them, so they aren't counted.", description: 'Info tip beside the Safeguard stops heading. Copilot is a product name.' }),
  safeguardsEmpty: msg({ id: 'performance.safeguards.empty', defaultMessage: 'No safeguard stops.', description: 'The Safeguard stops table when it has no rows.' }),
  usageUnknown: msg({ id: 'performance.usage.allUnreadable', defaultMessage: 'Provider usage is unknown: the session history couldn’t be read.', description: "Under the Provider usage heading when no session history could be read." }),
  usagePartial: msg({ id: 'performance.usage.partial', defaultMessage: 'The session history of {unreadable, number} of {hosts, plural, one {# place} other {# places}} (projects, the Assistant) couldn’t be read, so these totals are partial.', description: 'Under the Provider usage table when some session history could not be read. {unreadable} of {hosts} places (projects and the Assistant).' }),
  usageHeading: msg({ id: 'performance.usage.heading', defaultMessage: 'Provider usage', description: "Heading of the Performance page's table of what the providers (Claude Code, Codex, Copilot) reported." }),
  usageTip: msg({ id: 'performance.usage.tip', defaultMessage: "What the providers reported for the sessions active in the range, by whose sessions they were: each session's whole usage (so a long session counts in full). Reasoning is part of output, shown separately, not added. Context is a snapshot of each session's last request (average and largest), not a sum. Cost is API-equivalent (≈ estimated by Hive where the provider didn't report it); a subscription isn't billed per this. Sessions that reported nothing are unknown, left out of the totals.", description: 'Info tip beside the Provider usage heading. Keep ≈: it is how estimates show.' }),
  usageEmpty: msg({ id: 'performance.usage.empty', defaultMessage: 'No provider usage.', description: 'The Provider usage table when it has no rows.' }),
  skillService: msg({ id: 'performance.skills.heading', defaultMessage: 'Skill service', description: "Heading of the Performance view's cards about Hive's own work to know its skills." }),
  skillServiceTip: msg({ id: 'performance.skills.tip', defaultMessage: "Hive's own disk and cache work to know its skills (the status, launches, the Skills view). Shared by the whole workspace, so it is in no project's numbers. A saving in guidance isn't the same as a saving here.", description: 'Info tip beside the Skill service heading. Skills is the name of a view of Hive.' }),
  unfiltered: msg({ id: 'performance.skills.unfiltered', defaultMessage: 'all of it: not per role or provider', description: "After the Skill service heading when the page's filters are set: they don't apply to it. Lower case." }),
  scans: msg({ id: 'performance.skills.scans', defaultMessage: 'Scans', description: "Title of a Skill service card: how many times Hive scanned the skills' folders." }),
  scansSub: msg({ id: 'performance.skills.scansSub', defaultMessage: 'p95 {latency} · {shared, number} shared', description: 'Under the Scans card\'s number. {latency} is a time such as "≤ 250 ms" (p95: the 95th percentile, keep it); shared: scans that served several callers at once.' }),
  cache: msg({ id: 'performance.skills.cache', defaultMessage: 'Cache', description: "Title of a Skill service card: the share of skill lookups the cache answered." }),
  cacheSub: msg({ id: 'performance.skills.cacheSub', defaultMessage: '{hits, number} hits · {misses, number} misses · {changed, number} changed', description: "Under the Cache card's percentage: cache hits, misses, and skills read again because they changed." }),
  cacheTip: msg({ id: 'performance.skills.cacheTip', defaultMessage: 'Hits: a skill unchanged since it was last read. Changed: read again because its files changed.', description: 'Tooltip of the Cache card. Hits and Changed are words of the card: keep them as there.' }),
  read: msg({ id: 'performance.skills.read', defaultMessage: 'Read', description: 'Title of a Skill service card: how much Hive read from skills on disk (a size). Read is a past participle.' }),
  readSub: msg({ id: 'performance.skills.readSub', defaultMessage: '{files, plural, one {# file} other {# files}} · {headers} headers · {entries, plural, one {# entry} other {# entries}}', description: "Under the Read card's size. {headers} is a size such as \"12 KB\": the skills' headers read." }),
  tooBig: msg({ id: 'performance.skills.tooBig', defaultMessage: 'Too big', description: 'Title of a Skill service card: skills over the size limits, not read.' }),
  tooBigSub: msg({ id: 'performance.skills.tooBigSub', defaultMessage: 'over the limits (64 MB, 2000 files, 12 deep)', description: "Under the Too big card's number: the limits (a skill's size, files and folder depth)." }),
  appWide: msg({ id: 'performance.appWide', defaultMessage: 'Hive-wide, not this workspace’s: {inFlight, plural, one {# request} other {# requests}} in flight · {refused, number} refused before Hive knew whose · event streams: {connections, plural, one {# connection} other {# connections}}, {events, number} events, {size}.', description: 'A line at the end of the Performance view: Agent API requests under way, requests refused before Hive knew whose they were, and the event streams (connections, events and their size, such as "1.5 MB").' })
}

/** A message with markup, as React children (keyed). */
const rich = (m: Msg, values: Parameters<typeof tRich<React.ReactNode>>[1]): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, values))
const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

const ms = (v: number | null, count: number): string => (v === null ? (count ? tr(M.latencyOver, { s: LATENCY_BOUNDS_MS.at(-1)! / 1000 }) : '—') : v >= 1000 ? tr(M.latencySeconds, { s: v / 1000 }) : tr(M.latencyMs, { ms: v }))
const num = (n: number): string => fmt.number(Math.round(n))
const pct = (part: number, whole: number): string => (whole ? fmt.percent(part / whole, part && part / whole < 0.01 ? 1 : 0) : '—')

const ROLE_LABEL: Record<PerfRole, Msg> = {
  all: msg({ id: 'performance.role.all', defaultMessage: 'Everyone', description: "A choice of the Performance page's Who filter: everyone's work." }),
  agent: msg({ id: 'performance.role.agent', defaultMessage: 'Project agents', description: "A choice of the Performance page's Who filter: project agents' work." }),
  assistant: msg({ id: 'performance.role.assistant', defaultMessage: 'The Assistant', description: "A choice of the Performance page's Who filter: the Hive Assistant's work." }),
  api: msg({ id: 'performance.role.api', defaultMessage: 'Scripts', description: "A choice of the Performance page's Who filter: scripts calling the Agent API with a token." }),
  viewer: msg({ id: 'performance.role.viewer', defaultMessage: 'Viewer apps', description: "A choice of the Performance page's Who filter: viewer apps' work." })
}

const NO_NAMES: string[] = []

/** The activity bar's Performance view: the workspace, with the sidebar's (or the page's) project filter. */
export function PerformanceView() {
  // Its path and project names (HI-1806): the workspace's every change (an agent's state) would render the page again.
  const workspacePath = useStore((s) => s.workspace?.path)
  const projects = useStore(useShallow((s) => s.workspace?.projects.map((p) => p.name) ?? NO_NAMES))
  const filters = useStore((s) => s.perfWorkspace)
  const activity = useStore((s) => s.activity)
  const setFilters = useCallback((f: Partial<PerfFilters>) => set((s) => ({ perfWorkspace: { ...s.perfWorkspace, ...f } })), [])
  if (!workspacePath) return <div className="empty-state">{tr(M.noWorkspace)}</div>
  // A project filter that isn't one of this workspace's projects (from before a switch): all of it.
  const project = filters.project && filters.project !== WORKSPACE_OWN && !projects.some((n) => n.toLowerCase() === filters.project.toLowerCase()) ? '' : filters.project
  const scope: MetricsScope = project && project !== WORKSPACE_OWN ? { kind: 'project', project } : { kind: 'workspace' }
  return <PerformancePage key={workspacePath} workspacePath={workspacePath} scope={scope} filters={{ ...filters, project }} setFilters={setFilters} projects={projects} active={activity === 'performance'} />
}

/** A project's Performance tab: fixed to that project (no workspace or other-project choice). */
export function PerformanceTab({ project }: { project: ProjectInfo }) {
  const workspacePath = useStore((s) => s.workspace?.path)
  const filters = useStore((s) => s.perfProjects[project.path] ?? DEFAULT_PERF_FILTERS)
  const shown = useStore((s) => s.activity === 'projects' && s.selectedProject === project.path)
  const setFilters = useCallback((f: Partial<PerfFilters>) => set((s) => ({ perfProjects: { ...s.perfProjects, [project.path]: { ...(s.perfProjects[project.path] ?? DEFAULT_PERF_FILTERS), ...f, project: '' } } })), [project.path])
  if (!workspacePath) return null
  return <PerformancePage key={`${workspacePath}|${project.path}`} workspacePath={workspacePath} scope={{ kind: 'project', project: project.name }} filters={{ ...filters, project: '' }} setFilters={setFilters} active={shown} />
}

/** The Performance view's sidebar: what to look at (the whole workspace, its own work, or one project). */
export function PerformancePanel() {
  // Whether one is open, and its project names (HI-1806): not the agents' states.
  const workspace = useStore((s) => !!s.workspace)
  const names = useStore(useShallow((s) => s.workspace?.projects.map((p) => p.name) ?? NO_NAMES))
  const project = useStore((s) => s.perfWorkspace.project)
  const pick = (p: string): void => set((s) => ({ perfWorkspace: { ...s.perfWorkspace, project: p } }))
  const row = (value: string, icon: string, label: string, tip: string) => (
    <Tooltip key={value || 'all'} block content={tip}>
      <div className={cx('row', project.toLowerCase() === value.toLowerCase() && 'selected')} role="button" tabIndex={0} aria-pressed={project.toLowerCase() === value.toLowerCase()} onClick={() => pick(value)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(value))}>
        <Icon name={icon} /> <span className="label">{label}</span>
      </div>
    </Tooltip>
  )
  return (
    <>
      <div className="pane-header">
        {tr(M.heading)}
        <InfoTip text={tr(M.panelTip)} />
      </div>
      <div className="pane-body">
        {!workspace && <div className="pane-empty">{tr(M.noWorkspace)}</div>}
        {workspace && (
          <>
            {row('', 'root-folder', tr(M.whole), tr(M.wholeTip))}
            {row(WORKSPACE_OWN, 'hubot', tr(M.own), tr(M.ownTip))}
            <div className="section-header">{tr(M.projects)}</div>
            {names.map((name) => row(name, 'folder', name, tr(M.projectTip, { project: name })))}
          </>
        )}
      </div>
    </>
  )
}

function PerformancePage({ workspacePath, scope, filters, setFilters, projects, active }: { workspacePath: string; scope: MetricsScope; filters: PerfFilters; setFilters: (f: Partial<PerfFilters>) => void; projects?: string[]; active: boolean }) {
  const settings = useStore((s) => s.settings)
  const range = PERF_RANGES.find((r) => r.value === filters.range) ?? PERF_RANGES[0]
  // One result per workspace, scope, range and role: a late answer for another (a switch while it loaded) is never shown.
  // Every provider's: the provider filter narrows only its own sections, here (select()), so its choices never shrink
  // to the one picked (#270).
  const own = scope.kind === 'workspace' && filters.project === WORKSPACE_OWN
  const key = `${workspacePath}|${scope.kind === 'project' ? `project:${scope.project.toLowerCase()}` : own ? 'own' : 'workspace'}|${range.value}|${filters.role}`
  const loaded = useScopedLoad<MetricsReport>(key)
  const { load } = loaded
  const inFlight = useRef<string | null>(null)
  const refresh = useCallback(() => {
    // Coalesced: one request at a time for this scope and range. Another scope's still going doesn't hold this one up
    // (its late answer is ignored by useScopedLoad).
    if (inFlight.current === key) return
    inFlight.current = key
    load(key, () => call('metrics:query', pageQuery(scope, filters, Date.now())).finally(() => inFlight.current === key && (inFlight.current = null)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load])
  const comparing = filters.view === 'compare'
  useEffect(() => {
    // Not while comparing: the comparison reads kept files, not the live metrics.
    if (!active || comparing) return
    refresh()
    // Every minute while it is shown (and the window is visible); not at all while hidden or closed.
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS)
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [active, comparing, refresh])

  const report = loaded.data
  // Everything but the provider sections is every provider's (`all`); those two follow the provider filter (`sel`).
  const all = useMemo(() => (report ? select(report, { ...filters, provider: '' }) : null), [report, filters])
  const sel = useMemo(() => (report ? select(report, filters) : null), [report, filters])
  const t = useMemo(() => (all ? totals(all) : null), [all])
  const exportReport = async (sanitize: boolean): Promise<void> => {
    try {
      // The page's own query (scope, range and Who, every provider's), so the file holds what the page shows (#270).
      const path = await call('metrics:export', pageQuery(scope, filters, Date.now()), sanitize)
      if (path) notify('success', tr(M.exported), path)
    } catch (e) {
      notify('error', tr(M.exportFailed), String((e as Error).message ?? e))
    }
  }
  const scopeLabel = scope.kind === 'project' ? tr(M.project, { project: scope.project }) : filters.project === WORKSPACE_OWN ? tr(M.own) : tr(M.whole)
  const isTab = !projects
  const recording = settings?.sessions.recordPerformance !== false

  return (
    <div className="scroll-page performance-page" aria-label={tr(M.pageLabel, { scope: scopeLabel })}>
      <div className="page-narrow">
        <div className="board-header">
          <h1>{tr(M.heading)}</h1>
          <span className="badge accent perf-scope" title={tr(M.scopeTitle)}>
            <Icon name={scope.kind === 'project' ? 'folder' : filters.project === WORKSPACE_OWN ? 'hubot' : 'root-folder'} /> {scopeLabel}
          </span>
          <div className="grow" />
          <div className="segmented" role="group" aria-label={tr(M.viewLabel)}>
            {(['now', 'compare'] as const).map((v) => (
              <button key={v} className={cx(filters.view === v && 'active')} aria-pressed={filters.view === v} onClick={() => setFilters({ view: v })}>
                {v === 'now' ? tr(M.now) : tr(M.compare)}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">{isTab ? tr(M.introProject) : tr(M.introWorkspace)}</p>

        <div className="overview-head perf-controls">
          {!comparing && (
          <div className="segmented" role="group" aria-label={tr(M.rangeLabel)}>
            {PERF_RANGES.map((r) => (
              <button key={r.value} className={cx(filters.range === r.value && 'active')} aria-pressed={filters.range === r.value} onClick={() => setFilters({ range: r.value })}>
                {tr(M.range, { range: r.value })}
              </button>
            ))}
          </div>
          )}
          {projects && (
            <label className="perf-filter">
              {tr(M.scope)}
              <select className="input" value={filters.project} onChange={(e) => setFilters({ project: e.target.value })} aria-label={tr(M.scope)}>
                <option value="">{tr(M.whole)}</option>
                <option value={WORKSPACE_OWN}>{tr(M.own)}</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!comparing && (
          <>
          <div className="grow" />
          <Tooltip content={loaded.at ? tr(M.updated, { when: timeAgo(new Date(loaded.at).toISOString()) }) : tr(M.loading)}>
            <span>
              <IconButton icon="refresh" title={tr(M.refresh)} onClick={refresh} />
            </span>
          </Tooltip>
          <Tooltip content={tr(M.exportTip)}>
            <button className="btn small subtle" onClick={(e) => void exportReport(e.shiftKey)} disabled={!report}>
              <Icon name="desktop-download" /> {tr(M.exportButton)}
            </button>
          </Tooltip>
          </>
          )}
        </div>
        {comparing && <p className="hint perf-compare-hint">{rich(M.compareHint, { b: bold })}</p>}

        {comparing && (
          <ComparePanel
            key={`${workspacePath}|${compareScopeKey(compareScopeOf(scope, own))}`}
            workspacePath={workspacePath}
            scope={compareScopeOf(scope, own)}
            query={() => pageQuery(scope, filters, Date.now())}
            keeps={tr(M.keeps, { range: range.value, role: filters.role })}
          />
        )}
        {filters.view !== 'compare' && !recording && (
          <div className="banner warn perf-banner">
            <Icon name="debug-pause" /> {tr(M.notRecording)}{' '}
            <a onClick={() => (set({ settingsSection: 'sessions', settingsQuery: '' }), setActivity('settings'))}>{tr(M.settingsLink)}</a>
          </div>
        )}
        {filters.view !== 'compare' && loaded.error && report && <StaleNote what={tr(M.loadTarget)} error={loaded.error} at={loaded.at} onRetry={refresh} />}
        {filters.view !== 'compare' && !report && loaded.error && <LoadFailed what={tr(M.loadTarget)} error={loaded.error} onRetry={refresh} />}
        {filters.view !== 'compare' && !report && !loaded.error && (
          <div className="empty-state">
            <Icon name="loading" spin /> {tr(M.loading)}
          </div>
        )}
        {filters.view !== 'compare' && report && all && sel && t && (
          <>
            <Coverage report={report} />
            {!isTab && <AntivirusLine />}
            {/* Who did the work: everything in this group follows it, and nothing outside does (#270). */}
            <section className="perf-group" aria-label={tr(M.whoGroup)}>
              <div className="perf-group-head">
                <label className="perf-filter">
                  {tr(M.who)}
                  <select className="input" value={filters.role} onChange={(e) => setFilters({ role: e.target.value as PerfRole })} aria-label={tr(M.whoSelect)}>
                    {(isTab ? (['all', 'agent'] as PerfRole[]) : (['all', 'agent', 'assistant', 'api', 'viewer'] as PerfRole[])).map((r) => (
                      <option key={r} value={r}>
                        {tr(ROLE_LABEL[r])}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="faint">{isTab || !report.skills ? tr(M.followsAll) : tr(M.followsBox)}</span>
              </div>
            {isEmpty(all) ? (
              <>
                <div className="empty-state perf-empty">
                  <Icon name="pulse" />
                  {tr(M.empty, { filtered: filters.role !== 'all' ? 'yes' : 'no', range: range.value })}
                </div>
                {/* A provider still chosen keeps its filter, saying it has nothing here, so it can be seen and changed (#294).
                    Nothing to show isn't the same as nothing there: say when session history couldn't be read. */}
                {filters.provider ? (
                  <ByProvider report={report} sel={sel} range={range.value} provider={filters.provider} setProvider={(provider) => setFilters({ provider })} />
                ) : report.providersUnreadable ? (
                  <ProvidersTable sel={all} note={report.providersNoteText ? shownText(report.providersNoteText) : report.providersNote} unreadable={report.providersUnreadable} hosts={report.providersHosts} />
                ) : null}
              </>
            ) : (
              <>
                <div className="cards">
                  <Card
                    accent
                    title={tr(M.requests)}
                    value={num(t.requests)}
                    sub={report.coverage.observedMs >= 60_000 ? tr(M.requestsSubRate, { rate: Math.round(t.requests / (report.coverage.observedMs / 3_600_000)), failed: pct(t.errors, t.requests), cancelled: pct(t.cancelled, t.requests) }) : tr(M.requestsSub, { failed: pct(t.errors, t.requests), cancelled: pct(t.cancelled, t.requests) })}
                    tip={tr(M.requestsTip)}
                  />
                  <Card title={tr(M.latency)} value={tr(M.p50, { latency: ms(t.p50, t.requests) })} sub={tr(M.p95, { latency: ms(t.p95, t.requests) })} tip={tr(M.latencyTip)} />
                  <Card title={tr(M.data)} value={formatBytes(t.responseBytes)} sub={tr(M.dataSub, { size: formatBytes(t.requestBytes) })} tip={tr(M.dataTip)} />
                  <Card title={tr(M.toolReplies)} value={num(t.toolChars)} sub={tr(M.toolRepliesSub, { calls: t.toolCalls, size: formatBytes(t.toolBytes) })} tip={tr(M.toolRepliesTip)} />
                  <Card
                    title={tr(M.guidance)}
                    value={formatBytes(t.avgGuidanceBytes + t.avgCustomBytes + t.avgRoleBytes + t.avgModeBytes + t.avgSkillCatalogBytes)}
                    sub={tr(M.guidanceSub, { launches: t.launches, core: formatBytes(t.avgGuidanceBytes), catalog: formatBytes(t.avgSkillCatalogBytes) })}
                    tip={tr(M.guidanceTip)}
                  />
                </div>

                {report.trend && report.trend.length > 0 && <Trend points={report.trend} step={report.trendStep ?? 'hour'} />}

                <ToolsTable sel={all} />
                <RoutesTable sel={all} />
                {(all.guidance.length > 0 || all.providers.length > 0 || !!report.providersNote || !!report.providersUnreadable || !!filters.provider) && (
                  <ByProvider report={report} sel={sel} range={range.value} provider={filters.provider} setProvider={(provider) => setFilters({ provider })} />
                )}
                {/* Hive's tool list isn't per provider: outside the provider's group. */}
                <ToolListTable sel={all} />
              </>
            )}
            </section>
            {/* Cost per card (#602): agents' work only, every provider's, so outside Who's box; the workspace's own work has none. */}
            {!own && (
              <CardsTable
                workspacePath={workspacePath}
                project={scope.kind === 'project' ? scope.project : filters.project || null}
                from={Date.parse(report.from)}
                to={Date.parse(report.to)}
                range={range.value}
                refreshAt={loaded.at}
              />
            )}
            {!isTab && report.skills && <SkillService report={report} filtered={filters.role !== 'all'} />}
            {/* Hive's own main process (HI-1135): app-wide, since it started, so the workspace's page only. */}
            {!isTab && <StallsTable refreshAt={loaded.at} />}
            {!isTab && report.app && <AppWide report={report} />}
            <details className="perf-limits">
              <summary>{tr(M.limits)}</summary>
              <ul>
                {report.notMeasured.map((m, i) => (
                  <li key={m}>{report.notMeasuredText?.[i] ? shownText(report.notMeasuredText[i]) : m}</li>
                ))}
                <li>{tr(M.limitsWindow)}</li>
              </ul>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

function Coverage({ report }: { report: MetricsReport }) {
  const when = (iso: string): string => formatDateTime(iso)
  const c = report.coverage
  const share = c.rangeMs ? c.observedMs / c.rangeMs : 0
  return (
    <div className="hint perf-coverage">
      <p>
        {tr(M.coverageRange, { from: when(report.from), to: when(report.to) })}{' '}
        {!c.observedMs ? (
          <span className="warn-text">{tr(M.coverageNone)}</span>
        ) : share < 0.99 ? (
          <span className={cx(share < 0.5 && 'warn-text')}>
            {tr(M.coveragePartial, {
              duration: duration(c.observedMs),
              percent: pct(c.observedMs, c.rangeMs),
              sinceShown: Date.parse(c.observedSince!) - Date.parse(report.from) > 60_000 ? 'yes' : 'no',
              since: c.observedSince ? when(c.observedSince) : '',
              stretches: c.stretches
            })}
          </span>
        ) : (
          tr(M.coverageFull)
        )}
        {report.dropped > 0 && (
          <>
            {' '}
            <span className="warn-text">{tr(M.dropped, { n: report.dropped })}</span>
          </>
        )}
        {report.scope.kind === 'project' && report.lossesUnattributed && <span className="warn-text"> {tr(M.unattributed)}</span>}
        {c.evictedThrough && <span className="warn-text"> {tr(M.evicted, { when: when(c.evictedThrough) })}</span>}
      </p>
      {report.filters.notFiltered.length > 0 && (
        <ul className="perf-notes">
          {report.filters.notFiltered.map((n, i) => (
            <li key={n}>{report.filters.notFilteredText?.[i] ? shownText(report.filters.notFilteredText[i]) : n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A length of time, roughly: "3 h 10 min", "2 days 4 h". */
function duration(msValue: number): string {
  const min = Math.round(msValue / 60_000)
  if (min < 60) return tr(M.minutes, { m: min })
  const h = Math.floor(min / 60)
  if (h < 48) return min % 60 ? tr(M.hoursMinutes, { h, m: min % 60 }) : tr(M.hours, { h })
  return h % 24 ? tr(M.daysHours, { d: Math.floor(h / 24), h: h % 24 }) : tr(M.days, { d: Math.floor(h / 24) })
}

/** Requests per hour or day, failures in another colour; tool calls in the tooltip. */
function Trend({ points, step }: { points: TrendPoint[]; step: 'hour' | 'day' }) {
  const max = Math.max(1, ...points.map((p) => p.requests))
  const slotMs = step === 'hour' ? 3_600_000 : 86_400_000
  const label = (iso: string): string => (step === 'hour' ? formatWeekdayTime(iso) : formatDayLabel(iso))
  return (
    <div className="daily-chart perf-trend">
      <h2 className="section">{tr(M.trendHeading, { step })}</h2>
      <div className="daily-bars" role="img" aria-label={tr(M.trendLabel, { step })}>
        {points.map((p) => (
          <Tooltip
            key={p.start}
            content={
              <div className="stack-tip">
                {rich(M.trendSlot, {
                  b: bold,
                  when: label(p.start),
                  detail:
                    !p.observedMs && !p.requests
                      ? tr(M.trendNotRecorded)
                      : tr(M.trendDetail, { requests: p.requests, failed: p.failed, cancelled: p.cancelled, toolCalls: p.toolCalls, chars: p.toolChars, launches: p.launches, partial: p.observedMs < slotMs - 60_000 ? 'yes' : 'no', duration: duration(p.observedMs) })
                })}
                {p.waits > 0 && <div>{tr(M.trendWaits, { waits: p.waits })}</div>}
              </div>
            }
          >
            <div className={cx('daily-col', !p.observedMs && !p.requests && 'unobserved', p.observedMs > 0 && p.observedMs < slotMs - 60_000 && 'partial')}>
              <div className="stack-bar" style={{ height: `${p.requests ? Math.max(3, (p.requests / max) * 100) : 0}%` }}>
                {p.requests - p.failed - p.waits > 0 && <div className="stack-part" style={{ flexGrow: p.requests - p.failed - p.waits, background: 'var(--series-1)' }} />}
                {p.waits > 0 && <div className="stack-part" style={{ flexGrow: p.waits, background: 'var(--fg-faint)' }} />}
                {p.failed > 0 && <div className="stack-part" style={{ flexGrow: p.failed, background: 'var(--error)' }} />}
              </div>
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(points[0].start)}</span>
        <span>{label(points[points.length - 1].start)}</span>
      </div>
      <div className="stack-legend">
        <span>
          <span className="swatch" style={{ background: 'var(--series-1)' }} /> {tr(M.succeeded)}
        </span>
        {points.some((p) => p.waits > 0) && (
          <span>
            <span className="swatch" style={{ background: 'var(--fg-faint)' }} /> {tr(M.waitsLegend)}
          </span>
        )}
        <span>
          <span className="swatch" style={{ background: 'var(--error)' }} /> {tr(M.failed)}
        </span>
        <span>
          <span className="swatch unobserved" /> {tr(M.notRecorded)}
        </span>
      </div>
    </div>
  )
}

const roleName = (role: string): string => (role === 'assistant' ? tr(M.assistant) : tr(M.agents))

/** The Hive tools table's columns, in the window's language (made again when it changes). */
const toolColumns = (): DataColumn<ToolRow>[] => [
  { key: 'tool', header: tr(M.tool), cell: (r) => r.tool, sortValue: (r) => r.tool, filter: { kind: 'text', value: (r) => r.tool } },
  { key: 'calls', header: tr(M.calls), num: true, descFirst: true, cell: (r) => num(r.calls), sortValue: (r) => r.calls },
  { key: 'chars', header: tr(M.chars), num: true, descFirst: true, cell: (r) => num(r.chars), sortValue: (r) => r.chars },
  { key: 'avg', header: tr(M.perCall), num: true, descFirst: true, cell: (r) => num(r.avgChars), sortValue: (r) => r.avgChars },
  { key: 'detail', header: tr(M.detail), num: true, descFirst: true, cell: (r) => (r.detail ? num(r.detail) : '—'), sortValue: (r) => r.detail },
  { key: 'errors', header: tr(M.errors), num: true, descFirst: true, cell: (r) => (r.errors ? num(r.errors) : '—'), sortValue: (r) => r.errors },
  { key: 'p95', header: tr(M.p95Header), num: true, descFirst: true, cell: (r) => ms(r.p95, r.calls), sortValue: (r) => latencyOrder(r.p95, r.calls) }
]

function ToolsTable({ sel }: { sel: PerfSelection }) {
  const language = useLanguage()
  const rows = useMemo(() => byTool(sel.mcp), [sel.mcp])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => toolColumns(), [language])
  if (!rows.length) return null
  return (
    <>
      <h2 className="section">
        {tr(M.toolsHeading)} <InfoTip text={tr(M.toolsTip)} />
      </h2>
      <DataTable id="perf-tools" rows={rows} columns={columns} rowKey={(r) => r.tool} defaultSort={BY_CHARS} defaultPageSize={10} filterFrom={10} empty={tr(M.toolsEmpty)} />
    </>
  )
}
const BY_CHARS = { key: 'chars', desc: true }

const failedOnly = (r: RouteRow): number => r.failed - r.cancelled
/** The Agent API table's columns, in the window's language (made again when it changes). */
const routeColumns = (): DataColumn<RouteRow>[] => [
  {
    key: 'route',
    header: tr(M.route),
    cell: (r) => (
      <>
        <span className="faint">{r.method}</span> {r.route}
      </>
    ),
    sortValue: (r) => r.route,
    filter: { kind: 'text', value: (r) => `${r.method} ${r.route}` }
  },
  { key: 'requests', header: tr(M.requestsHeader), num: true, descFirst: true, cell: (r) => num(r.requests), sortValue: (r) => r.requests },
  { key: 'failed', header: tr(M.failedHeader), num: true, descFirst: true, cell: (r) => (failedOnly(r) ? `${num(failedOnly(r))} (${pct(failedOnly(r), r.requests)})` : '—'), sortValue: failedOnly },
  { key: 'cancelled', header: tr(M.cancelled), num: true, descFirst: true, cell: (r) => (r.cancelled ? `${num(r.cancelled)} (${pct(r.cancelled, r.requests)})` : '—'), sortValue: (r) => r.cancelled },
  { key: 'waits', header: tr(M.waitsHeader), num: true, descFirst: true, cell: (r) => (r.waits ? num(r.waits) : '—'), sortValue: (r) => r.waits },
  { key: 'p50', header: tr(M.p50Header), num: true, descFirst: true, cell: (r) => ms(r.p50, r.requests), sortValue: (r) => latencyOrder(r.p50, r.requests) },
  { key: 'p95', header: tr(M.p95Header), num: true, descFirst: true, cell: (r) => ms(r.p95, r.requests), sortValue: (r) => latencyOrder(r.p95, r.requests) },
  { key: 'sent', header: tr(M.sent), num: true, descFirst: true, cell: (r) => formatBytes(r.responseBytes), sortValue: (r) => r.responseBytes },
  { key: 'received', header: tr(M.received), num: true, descFirst: true, cell: (r) => formatBytes(r.requestBytes), sortValue: (r) => r.requestBytes }
]
const BY_REQUESTS = { key: 'requests', desc: true }

function RoutesTable({ sel }: { sel: PerfSelection }) {
  const language = useLanguage()
  const rows = useMemo(() => byRoute(sel.api), [sel.api])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => routeColumns(), [language])
  if (!rows.length) return null
  return (
    <>
      <h2 className="section">
        {tr(M.routesHeading)} <InfoTip text={tr(M.routesTip)} />
      </h2>
      <DataTable id="perf-routes" rows={rows} columns={columns} rowKey={(r) => r.key} defaultSort={BY_REQUESTS} defaultPageSize={10} filterFrom={10} empty={tr(M.routesEmpty)} />
    </>
  )
}

/**
 * The sections the provider filter changes (launches' guidance and the providers' usage), under it; its choices are
 * every provider with data in the range and scope, and the current one (#270).
 */
function ByProvider({ report, sel, range, provider, setProvider }: { report: MetricsReport; sel: PerfSelection; range: PerfRange; provider: string; setProvider: (p: string) => void }) {
  const none = !sel.guidance.length && !sel.providers.length
  return (
    <section className="perf-group perf-by-provider" aria-label={tr(M.providerGroup)}>
      <div className="perf-group-head">
        <label className="perf-filter">
          {tr(M.provider)}
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={tr(M.provider)}>
            <option value="">{tr(M.allProviders)}</option>
            {providersIn(report, provider).map((p) => (
              <option key={p} value={p}>
                {providerName(p)}
              </option>
            ))}
          </select>
        </label>
        <span className="faint">{tr(M.providerNote)}</span>
      </div>
      {provider && none && !report.providersUnreadable ? (
        <p className="hint perf-provider-empty">{tr(M.providerNothing, { provider: providerName(provider), range, filtered: report.filters.role ? 'yes' : 'no' })}</p>
      ) : (
        <>
          <GuidanceTable sel={sel} unmeasured={totals(sel).skillsUnmeasured} />
          <ProvidersTable sel={sel} note={report.providersNoteText ? shownText(report.providersNoteText) : report.providersNote} unreadable={report.providersUnreadable} hosts={report.providersHosts} />
          <SafeguardsTable sel={sel} />
        </>
      )}
    </section>
  )
}

/** A count of characters a start, or — where none was measured (unknown, not zero). */
const charsCell = (v: number | null): string => (v === null ? '—' : fmt.number(Math.round(v)))
const charsColumn = (key: string, header: string, value: (r: ToolListRow) => number | null): DataColumn<ToolListRow> => ({ key, header, num: true, descFirst: true, cell: (r) => charsCell(value(r)), sortValue: value })
/** The Hive tool list table's columns, in the window's language (made again when it changes). */
const toolListColumns = (): DataColumn<ToolListRow>[] => [
  { key: 'role', header: tr(M.who), className: 'nowrap', cell: (r) => roleName(r.role), sortValue: (r) => roleName(r.role) },
  { key: 'workflow', header: tr(M.workflow), className: 'nowrap', cell: (r) => tr(M.workflowSide, { side: r.workflow }), sortValue: (r) => tr(M.workflowSide, { side: r.workflow }) },
  { key: 'starts', header: tr(M.toolListStarts), num: true, descFirst: true, cell: (r) => num(r.starts), sortValue: (r) => r.starts },
  { key: 'tools', header: tr(M.toolListTools), num: true, descFirst: true, cell: (r) => fmt.figure(r.tools, r.tools % 1 ? 1 : 0), sortValue: (r) => r.tools },
  charsColumn('chars', tr(M.toolListChars), (r) => r.chars),
  charsColumn('descriptions', tr(M.toolListDescriptions), (r) => r.descriptionChars),
  charsColumn('params', tr(M.toolListParams), (r) => r.paramChars),
  charsColumn('schemas', tr(M.toolListSchemas), (r) => r.schemaChars),
  { key: 'bytes', header: tr(M.toolListBytes), num: true, descFirst: true, cell: (r) => formatBytes(r.bytes), sortValue: (r) => r.bytes }
]

/** The hive tools' list as each session got it, a start (HI-2063): every provider's (not recorded per provider). */
function ToolListTable({ sel }: { sel: PerfSelection }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => toolListColumns(), [language])
  const rows = useMemo(() => toolListRows(sel.catalog), [sel.catalog])
  if (!rows.length) return null
  return (
    <>
      <h2 className="section">
        {tr(M.toolListHeading)} <InfoTip text={tr(M.toolListTip)} />
      </h2>
      <DataTable id="perf-tool-list" rows={rows} columns={columns} rowKey={(r) => `${r.role} ${r.workflow}`} empty={tr(M.toolListEmpty)} />
    </>
  )
}

const perLaunch = (n: number, launches: number): number | null => (launches && n ? n / launches : null)
const perLaunchColumn = (key: string, header: string, bytes: (g: GuidanceSeries) => number): DataColumn<GuidanceSeries> => ({
  key,
  header,
  num: true,
  descFirst: true,
  cell: (g) => {
    const v = perLaunch(bytes(g), g.launches)
    return v === null ? '—' : formatBytes(v)
  },
  sortValue: (g) => perLaunch(bytes(g), g.launches)
})
/** The Guidance at launch table's columns, in the window's language (made again when it changes). */
const guidanceColumns = (): DataColumn<GuidanceSeries>[] => [
  { key: 'provider', header: tr(M.provider), className: 'nowrap', cell: (g) => providerName(g.provider), sortValue: (g) => providerName(g.provider) },
  { key: 'role', header: tr(M.who), className: 'nowrap', cell: (g) => roleName(g.role), sortValue: (g) => roleName(g.role) },
  { key: 'workflow', header: tr(M.workflow), className: 'nowrap', cell: (g) => tr(M.workflowSide, { side: g.workflow ?? 'unknown' }), sortValue: (g) => tr(M.workflowSide, { side: g.workflow ?? 'unknown' }) },
  { key: 'launches', header: tr(M.launches), num: true, descFirst: true, cell: (g) => num(g.launches), sortValue: (g) => g.launches },
  perLaunchColumn('core', tr(M.core), (g) => g.guidanceBytes),
  perLaunchColumn('project', tr(M.projectBytes), (g) => g.customBytes),
  perLaunchColumn('roleBytes', tr(M.role), (g) => g.roleBytes),
  perLaunchColumn('mode', tr(M.mode), (g) => g.modeBytes),
  { key: 'skills', header: tr(M.skills), num: true, descFirst: true, cell: (g) => (g.launches ? fmt.figure(g.skills / g.launches, 1) : '—'), sortValue: (g) => (g.launches ? g.skills / g.launches : null) },
  perLaunchColumn('catalog', tr(M.catalog), (g) => g.skillCatalogBytes),
  perLaunchColumn('disk', tr(M.onDisk), (g) => g.skillBytes),
  {
    key: 'notGiven',
    header: tr(M.notGiven),
    num: true,
    descFirst: true,
    cell: (g) =>
      g.skillsNotDelivered || g.skillsUnmeasured ? (
        <Tooltip content={tr(M.notGivenTip, { notDelivered: g.skillsNotDelivered ?? 0, unmeasured: g.skillsUnmeasured ?? 0 })}>
          <span>
            {num(g.skillsNotDelivered)}
            {g.skillsUnmeasured ? ` + ${num(g.skillsUnmeasured)} ?` : ''}
          </span>
        </Tooltip>
      ) : (
        '—'
      ),
    sortValue: (g) => (g.skillsNotDelivered ?? 0) + (g.skillsUnmeasured ?? 0)
  }
]

// Totals of sessions none of which reported usage are unknown, not zero: they sort last, either way.
const allUnknown = (p: ProviderUsageSummary): boolean => p.unknown === p.sessions
const tokenColumn = (key: string, header: string, n: (p: ProviderUsageSummary) => number): DataColumn<ProviderUsageSummary> => ({
  key,
  header,
  num: true,
  descFirst: true,
  cell: (p) => (allUnknown(p) ? tr(M.unknown) : formatTokens(n(p))),
  sortValue: (p) => (allUnknown(p) ? null : n(p))
})
/** The Provider usage table's columns, in the window's language (made again when it changes). */
const providerColumns = (): DataColumn<ProviderUsageSummary>[] => [
  { key: 'provider', header: tr(M.provider), className: 'nowrap', cell: (p) => providerName(p.provider), sortValue: (p) => providerName(p.provider) },
  { key: 'role', header: tr(M.who), className: 'nowrap', cell: (p) => roleName(p.role), sortValue: (p) => roleName(p.role) },
  {
    key: 'sessions',
    header: tr(M.sessions),
    num: true,
    descFirst: true,
    // Deliberate lines (#241): the count, then who is running and what is unknown.
    cell: (p) => <CellLines main={num(p.sessions)} sub={[p.running ? tr(M.running, { n: p.running }) : '', p.unknown ? tr(M.unknownCount, { n: p.unknown }) : ''].filter(Boolean).join(' · ')} subWarn={!!p.unknown} />,
    sortValue: (p) => p.sessions
  },
  tokenColumn('input', tr(M.input), (p) => p.inputTokens),
  tokenColumn('cacheRead', tr(M.cacheRead), (p) => p.cacheReadTokens),
  tokenColumn('cacheWrite', tr(M.cacheWrite), (p) => p.cacheWriteTokens),
  tokenColumn('output', tr(M.output), (p) => p.outputTokens),
  { key: 'reasoning', header: tr(M.reasoning), num: true, descFirst: true, cell: (p) => (p.reasoningTokens ? formatTokens(p.reasoningTokens) : '—'), sortValue: (p) => p.reasoningTokens || null },
  { key: 'requests', header: tr(M.requestsHeader), num: true, descFirst: true, cell: (p) => (allUnknown(p) ? tr(M.unknown) : num(p.requests)), sortValue: (p) => (allUnknown(p) ? null : p.requests) },
  {
    key: 'context',
    header: tr(M.context),
    num: true,
    descFirst: true,
    cell: (p) =>
      p.contextSessions ? (
        <Tooltip content={tr(M.contextTip, { sessions: p.contextSessions, avg: formatTokens(p.contextAvgTokens), max: formatTokens(p.contextMaxTokens), hasWindow: p.contextWindow ? 'yes' : 'no', window: p.contextWindow ? formatTokens(p.contextWindow) : '' })}>
          <span>
            <CellLines main={tr(M.contextAvg, { avg: formatTokens(p.contextAvgTokens) })} sub={tr(M.contextMax, { max: formatTokens(p.contextMaxTokens), hasWindow: p.contextWindow ? 'yes' : 'no', window: p.contextWindow ? formatTokens(p.contextWindow) : '' })} />
          </span>
        </Tooltip>
      ) : (
        '—'
      ),
    sortValue: (p) => (p.contextSessions ? p.contextAvgTokens : null)
  },
  { key: 'compactions', header: tr(M.compactions), num: true, descFirst: true, cell: (p) => (allUnknown(p) ? tr(M.unknown) : num(p.compactions)), sortValue: (p) => (allUnknown(p) ? null : p.compactions) },
  // Where the CLI's transcript can't say (Copilot, #606): not detected, never zero.
  { key: 'safeguards', header: tr(M.safeguards), num: true, descFirst: true, cell: (p) => (providerDescriptor(p.provider).safeguardHelp === null ? tr(M.notDetected) : allUnknown(p) ? tr(M.unknown) : num(p.safeguardStops)), sortValue: (p) => (providerDescriptor(p.provider).safeguardHelp === null || allUnknown(p) ? null : p.safeguardStops) },
  {
    key: 'cost',
    header: tr(M.cost),
    num: true,
    descFirst: true,
    cell: (p) =>
      // Only sessions on servers on this PC (HI-1772): free (local).
      p.costFree && p.costFree === p.sessions ? (
        tr(FREE_LOCAL)
      ) : p.costUnknown === p.sessions ? (
        tr(M.unknown)
      ) : (
        // "≈ $25.87" as one unbreakable value; the unknown sessions under it (#241).
        <CellLines main={`${p.costEstimated ? '≈ ' : ''}${moneyLabel(p.costUsd)}`} sub={[p.costUnknown ? tr(M.costUnknown, { n: p.costUnknown }) : '', p.costFree ? tr(M.costFree, { n: p.costFree }) : ''].filter(Boolean).join(' · ')} subWarn={!!p.costUnknown} />
      ),
    sortValue: (p) => (p.costUnknown === p.sessions ? null : p.costUsd)
  }
]

/** The Safeguard stops table's columns, in the window's language (made again when it changes). */
const safeguardColumns = (): DataColumn<SafeguardCount>[] => [
  { key: 'agent', header: tr(M.agent), cell: (g) => <CellLines main={g.agent} sub={g.project} />, sortValue: (g) => `${g.project} ${g.agent}` },
  { key: 'model', header: tr(M.model), cell: (g) => (g.model ? providerDescriptor(g.provider).modelLabel(g.model) : tr(M.unknown)), sortValue: (g) => g.model },
  { key: 'stops', header: tr(M.stops), num: true, descFirst: true, cell: (g) => num(g.stops), sortValue: (g) => g.stops }
]

/** Safeguard stops (#606) per agent and model, in the sessions active in the range: only when there were any. */
function SafeguardsTable({ sel }: { sel: PerfSelection }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => safeguardColumns(), [language])
  if (!sel.safeguards.length) return null
  return (
    <>
      <h2 className="section">
        {tr(M.safeguards)}{' '}
        <InfoTip text={tr(M.safeguardsTip)} />
      </h2>
      <DataTable id="perf-safeguards" rows={sel.safeguards} columns={columns} rowKey={(g) => `${g.project} ${g.agent} ${g.provider} ${g.model}`} empty={tr(M.safeguardsEmpty)} />
    </>
  )
}

function GuidanceTable({ sel, unmeasured }: { sel: PerfSelection; unmeasured: number }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => guidanceColumns(), [language])
  if (!sel.guidance.length) return null
  return (
    <>
      <h2 className="section">
        {tr(M.guidanceHeading)}{' '}
        <InfoTip text={tr(M.guidanceTableTip)} />
      </h2>
      <DataTable id="perf-guidance" rows={sel.guidance} columns={columns} rowKey={(g, i) => `${g.provider} ${g.role} ${g.workflow} ${i}`} empty={tr(M.guidanceEmpty)} />
      {unmeasured > 0 && <p className="hint">{tr(M.unmeasuredSkills)}</p>}
    </>
  )
}

function ProvidersTable({ sel, note, unreadable, hosts }: { sel: PerfSelection; note?: string; unreadable?: number; hosts?: number }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => providerColumns(), [language])
  // Session history that couldn't be read: the totals are partial, or unknown if none could be (never shown as complete).
  const partial = unreadable ? (
    <p className="warn-text perf-partial">
      {unreadable === hosts
        ? tr(M.usageUnknown)
        : tr(M.usagePartial, { unreadable, hosts: hosts ?? 0 })}
    </p>
  ) : null
  if (!sel.providers.length)
    return note || partial ? (
      <>
        <h2 className="section">{tr(M.usageHeading)}</h2>
        {partial}
        {note && <p className="hint">{note}</p>}
      </>
    ) : null
  return (
    <>
      <h2 className="section">
        {tr(M.usageHeading)}{' '}
        <InfoTip text={tr(M.usageTip)} />
      </h2>
      <DataTable id="perf-providers" rows={sel.providers} columns={columns} rowKey={(p) => `${p.provider} ${p.role}`} empty={tr(M.usageEmpty)} />
      {partial}
      {note && <p className="hint">{note}</p>}
    </>
  )
}

function SkillService({ report, filtered }: { report: MetricsReport; filtered: boolean }) {
  const s = report.skills!
  const lookups = s.hits + s.misses
  return (
    <>
      <h2 className="section">
        {tr(M.skillService)} <InfoTip text={tr(M.skillServiceTip)} />
        {filtered && <span className="faint perf-unfiltered"> {tr(M.unfiltered)}</span>}
      </h2>
      <div className="cards">
        <Card title={tr(M.scans)} value={num(s.scans.count)} sub={tr(M.scansSub, { latency: ms(percentile(s.scans, 0.95), s.scans.count), shared: s.sharedScans })} />
        <Card title={tr(M.cache)} value={pct(s.hits, lookups)} sub={tr(M.cacheSub, { hits: s.hits, misses: s.misses, changed: s.invalidations })} tip={tr(M.cacheTip)} />
        <Card title={tr(M.read)} value={formatBytes(s.bytes)} sub={tr(M.readSub, { files: s.files, headers: formatBytes(s.headerBytes), entries: s.entries })} />
        <Card title={tr(M.tooBig)} value={num(s.tooLarge)} sub={tr(M.tooBigSub)} />
      </div>
    </>
  )
}

function AppWide({ report }: { report: MetricsReport }) {
  const a = report.app!
  return (
    <p className="hint">{tr(M.appWide, { inFlight: a.inFlight, refused: a.unauthenticated, connections: a.streams.connections, events: a.streams.events, size: formatBytes(a.streams.bytes) })}</p>
  )
}
