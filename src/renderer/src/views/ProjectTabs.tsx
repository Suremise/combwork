import { TOOLS_SERVER } from '@shared/assistantTools'
import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantMark } from '../components/AssistantMark'
import { CardChip, WatchedCardChip, WatchedCardChips } from '../components/CardChip'
import { cardsWait } from '../components/watchLine'
import { KeybindingsEditor } from '../components/Keybindings'
import type { CompactionEvent, GitDiff, GitStatus, McpServerInfo, MemorySource, PlanLimit, PlanUsage, ProjectConfig, ProjectInfo, ProviderId, SessionListItem, SessionUsage, SkillInfo, UnusedWorktree } from '@shared/types'
import { unpricedModel, unpricedText, usesOwnPrices } from '@shared/prices'
import { formatDateTime, formatDayLabel } from '@shared/dates'
import { agentChoosesMcp, agentGetsMcp, agentMcpText, serverAddedIn } from '@shared/agentMcp'
import { gitFixText, gitProblemText } from '@shared/gitTool'
import { UnusedHeading, UnusedWorkNotice, UnusedWorktreesLine, UnusedWorktreesSection, useUnusedWorktrees } from '../components/UnusedWorktrees'
import { PERIODS, activeIn, costText, dailyTotals, moneyLabel, periodFrom, sumUsage, type DayTotal, type Period, type Totals } from '@shared/usageTotals'
import { agentLimitText, contextPercent, turnPushedCompaction, mergeBlocked } from '@shared/defaults'
import { useAdvancedValue, useAgentLimit } from '../advanced'
import { INBOX_PROJECT_KEY, INBOX_SWITCHES, INBOX_SWITCH_ID, type InboxSwitch } from '@shared/inboxSwitches'
import { PROVIDERS, contextLines, isProviderEnabled, permissionLabel, providerDescriptor, providerName } from '@shared/providers'
import { instructionsStarter } from '@shared/projectTabs'
import { PROJECT_KEY_DESC, PROJECT_SETTINGS_SECTIONS, settingEntry, shownSetting, type SettingsSectionInfo } from '@shared/settingsCatalog'
import { shownText } from '@shared/advanced'
import { NumberField } from '../components/NumberField'
import { CardCleanupSetting, StorageView } from '../components/Storage'
import { CARD_CLEANUP_DEFAULT } from '@shared/cardCleanup'
import { TaskStrip } from '../components/Board'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { DocEditor } from '../components/DocEditor'
import { DiffView } from '../components/Editors'
import { COMPARE_ROOT, CompareGroup, ComparePage, compareRoot, parseCompareRoot, useCompareLines } from '../components/ChangesCompare'
import { LEFTOVERS_ROOT, LeftoversOption, LeftoversPage, useLeftovers } from '../components/ChangesLeftovers'
import { useGitRead } from './GitTab'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { DataTable, useDateColumns, type DataColumn } from '../components/DataTable'
import { Icon, IconButton, InfoTip, LoadFailed, SearchInput, SectionNav, sentences, StaleNote, statusText, StatusDot, Tooltip } from '../components/ui'
import { cliReadyOf, ConnectionMark, connectionCli, connectionLine, firstReadyConnection, useConnections } from '../components/ConnectionChoice'
import { connectionOf } from '@shared/connectionLabel'
import { useConnectionsInUse } from '../connectionUsage'
import { connectionsApply } from '@shared/accounts'
import { languageFor } from '../monacoLang'
import { useScopedLoad } from '../scopedLoad'
import { oneAtATime, withinTime } from '@shared/coalesce'
import { addSkill, deleteSkill, DeliveredSwitch, editInWorkspace, otherLocal, SKILL_LEVEL_TIP, SkillDetail, SkillRow } from '../components/Skills'
import { CHANGES_ABOUT, unusedName, unusedPickerLabel } from '@shared/unusedWorktrees'
import { agentProviderOf, confirm, notify, projectKeyOf, openInSessionsTab, set, setActivity, showView, UNUSED_ROOT, unusedRoot, useDateStyle, useFocusedAgent, useLanguage, useStore } from '../store'
import { rememberProjectPref } from '../projectPrefs'
import { keyProblemText } from '../projectKeys'
import { CombworkVcsNotice } from '../components/CombworkVcsNotice'
import { InitRepoButton } from '../components/InitRepo'
import { MergeSlotList, projectSlots, useMergeSlots } from '../components/MergeSlots'
import { cx, formatDuration, formatNumber, formatTokens, resetsIn, timeAgo } from '../util'
import { useLiveUsage, useNow } from '../usage'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { samePath } from '@shared/movePaths'
import { agentFolder, awayFromProject, legacyOf, placeText, workFolderOf } from '../agentPlace'

const M = {
  loading: msg({ id: 'project.loading', defaultMessage: 'Loading…', description: 'A project tab while its data loads.' }),
  noAnswer: msg({ id: 'project.overview.noAnswer', defaultMessage: 'no answer after {seconds, number} s', description: 'Why the sessions could not be loaded: Combwork listed them for this long without finishing. Shown as {error} in "Could not load the sessions: {error}", with Retry.' }),
  sessionsTarget: msg({ id: 'project.overview.sessionsTarget', defaultMessage: 'the sessions', description: 'What could not be read in the Overview tab: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  tokensPerDay: msg({ id: 'project.chart.label', defaultMessage: 'Tokens per day', description: "Accessible name of the Overview's chart of tokens per day." }),
  dayTip: msg({ id: 'project.chart.dayTip', defaultMessage: '{day}: {tokens} tokens · {cost} · {prompts, plural, one {# prompt} other {# prompts}}', description: 'Tooltip on a day of the chart. {day} is the date, {tokens} a token count such as 1.2M, {cost} a cost.' }),
  today: msg({ id: 'project.chart.today', defaultMessage: 'Today', description: "The chart's last day, under its bar." }),
  costTip: msg({ id: 'project.cost.tip', defaultMessage: 'What this work would have cost at API prices: reported by the provider where it does (Claude Code), else estimated by Combwork from token counts and the prices in Settings → the provider. On a subscription you are not charged this; it shows how heavy the work was.', description: 'The (i) beside API-equivalent cost in the Overview.' }),
  mergeSlot: msg({ id: 'project.overview.mergeSlot', defaultMessage: 'Merge slot', description: "Heading in the Overview: the project's merge slot and who waits for it." }),
  summary: msg({ id: 'project.overview.summary', defaultMessage: 'Project summary', description: "Heading of the Overview's figures." }),
  updated: msg({ id: 'project.overview.updated', defaultMessage: 'Updated {when}. How often it updates: Settings → Sessions → Overview updates.', description: 'Tooltip on the Overview\'s refresh button. {when} is how long ago, such as "5m ago". The setting\'s path: name it as Settings does.' }),
  refresh: msg({ id: 'project.refresh', defaultMessage: 'Refresh', description: 'Tooltip on a refresh button.' }),
  period: msg({ id: 'project.overview.period', defaultMessage: 'Period', description: "Accessible name of the Overview's period buttons (Today, 7 days…)." }),
  periodHint: msg({ id: 'project.overview.periodHint', defaultMessage: 'What was used in the period across every provider, by calendar day: a session that ran over several days counts only its part in the period.', description: "Under the Overview's period buttons." }),
  tokens: msg({ id: 'project.card.tokens', defaultMessage: 'Tokens', description: 'A figure in the Overview: tokens used.' }),
  tokensSub: msg({ id: 'project.card.tokensSub', defaultMessage: '{input} in · {cached} cached · {output} out', description: 'Under the token total: input, input read from cache and output, each a count such as 1.2M.' }),
  tokensTip: msg({ id: 'project.card.tokensTip', defaultMessage: 'All tokens: new input, cache writes, input read from cache, and output.', description: 'The (i) beside Tokens.' }),
  cost: msg({ id: 'project.card.cost', defaultMessage: 'API-equivalent cost', description: 'A figure in the Overview: what the work would cost at API prices.' }),
  withoutPrice: msg({ id: 'project.card.withoutPrice', defaultMessage: '{count, plural, one {# session without a price} other {# sessions without a price}}', description: 'Under the cost: sessions whose model has no known price.' }),
  withoutPriceShort: msg({ id: 'project.card.withoutPriceShort', defaultMessage: '{count, number} without a price', description: "Under a provider's cost: its sessions whose model has no known price." }),
  partlyEstimated: msg({ id: 'project.card.partlyEstimated', defaultMessage: 'partly estimated', description: 'Under the cost: some of it is estimated by Combwork.' }),
  asReported: msg({ id: 'project.card.asReported', defaultMessage: 'as reported', description: 'Under the cost: all of it as the provider reported it.' }),
  estimated: msg({ id: 'project.card.estimated', defaultMessage: 'estimated', description: 'Under the cost: estimated by Combwork from token counts.' }),
  sessions: msg({ id: 'project.card.sessions', defaultMessage: 'Sessions', description: 'A figure in the Overview: how many sessions.' }),
  runningNow: msg({ id: 'project.card.runningNow', defaultMessage: '{count} running now', description: 'Under Sessions: how many run now.' }),
  prompts: msg({ id: 'project.card.prompts', defaultMessage: 'Prompts', description: 'A figure in the Overview: prompts sent.' }),
  compactions: msg({ id: 'project.card.compactionsSub', defaultMessage: '{count, plural, one {# compaction} other {# compactions}}', description: 'Under Prompts: how many times sessions were compacted.' }),
  runningHeading: msg({ id: 'project.overview.running', defaultMessage: 'Running now', description: 'Heading in the Overview: the agents running now.' }),
  turnedOff: msg({ id: 'project.overview.turnedOff', defaultMessage: '— turned off', description: "After a provider's name in the Overview when it is turned off in Settings → Providers." }),
  outputSub: msg({ id: 'project.card.outputSub', defaultMessage: '{tokens} output', description: "Under a provider's tokens: its output tokens, such as 1.2M." }),
  promptsSub: msg({ id: 'project.card.promptsSub', defaultMessage: '{count, plural, one {# prompt} other {# prompts}}', description: "Under a provider's sessions: prompts sent." }),
  byAgent: msg({ id: 'project.overview.byAgent', defaultMessage: 'By agent', description: 'Heading in the Overview: a table of what each agent used.' }),
  noAgents: msg({ id: 'project.overview.noAgents', defaultMessage: 'No agents.', description: 'The By agent table when there are none.' }),
  colAgent: msg({ id: 'project.col.agent', defaultMessage: 'Agent', description: 'Column of the By agent table.' }),
  colProvider: msg({ id: 'project.col.provider', defaultMessage: 'Provider', description: 'Column of the By agent table.' }),
  colSessions: msg({ id: 'project.col.sessions', defaultMessage: 'Sessions', description: 'Column of the By agent table.' }),
  colTokens: msg({ id: 'project.col.tokens', defaultMessage: 'Tokens', description: 'Column of the By agent table.' }),
  colCost: msg({ id: 'project.col.cost', defaultMessage: 'Cost', description: 'Column of the By agent table.' }),
  plan: msg({ id: 'project.running.plan', defaultMessage: 'Plan', description: "In a running agent's row: it is in plan mode." }),
  contextOf: msg({ id: 'project.running.contextOf', defaultMessage: '{used} of {window} tokens of context', description: "Tooltip on a running agent's context: tokens used of the model's context window, both formatted." }),
  contextUsed: msg({ id: 'project.running.context', defaultMessage: '{used} tokens of context', description: "Tooltip on a running agent's context when the window size is unknown." }),
  contextShort: msg({ id: 'project.running.contextShort', defaultMessage: '{tokens} context{percent, select, none {} other { · {percent}}}', description: "A running agent's context in its row, such as \"120k context · 45%\": its tokens, then (when the window is known) the share of it used, already formatted." }),
  unknownCost: msg({ id: 'project.running.unknownCost', defaultMessage: 'Unknown', description: "A running agent's cost when its model has no price." }),
  colWhen: msg({ id: 'project.col.when', defaultMessage: 'When', description: 'Column of the compaction history.' }),
  colTrigger: msg({ id: 'project.col.trigger', defaultMessage: 'Trigger', description: 'Column of the compaction history: what started it (auto or manual).' }),
  colBefore: msg({ id: 'project.col.before', defaultMessage: 'Before', description: 'Column of the compaction history: tokens before it.' }),
  colAfter: msg({ id: 'project.col.after', defaultMessage: 'After', description: 'Column of the compaction history: tokens after it.' }),
  colFreed: msg({ id: 'project.col.freed', defaultMessage: 'Freed', description: 'Column of the compaction history: tokens it freed.' }),
  colLastTurn: msg({ id: 'project.col.lastTurn', defaultMessage: 'Last turn', description: 'Column of the compaction history: what the turn before it added.' }),
  lastTurnTip: msg({ id: 'project.compaction.lastTurnTip', defaultMessage: 'The last turn added {output} of output (thinking included) to the {input} the context showed before it, so it reached {total} and was compacted.', description: 'Tooltip on a compaction caused by a large last turn. The values are token counts such as 12k.' }),
  turnAdded: msg({ id: 'project.compaction.turnAdded', defaultMessage: 'turn added {output} output', description: 'Badge on a compaction caused by a large last turn. {output} is a token count.' }),
  noCompactions: msg({ id: 'project.compaction.none', defaultMessage: 'No compactions yet.', description: 'The compaction history when there are none.' }),
  openCompaction: msg({ id: 'project.compaction.open', defaultMessage: 'Open the {trigger} compaction of {when} in the transcript', description: 'Accessible name of a compaction row. {trigger} is auto or manual; {when} its date and time.' }),
  unknownTime: msg({ id: 'project.compaction.unknownTime', defaultMessage: 'unknown time', description: 'In "Open the … compaction of {when}…" when its time is not known.' }),
  currentSession: msg({ id: 'project.session.current', defaultMessage: 'Current session', description: "Heading in the Overview: the agent's running session." }),
  recentSession: msg({ id: 'project.session.recent', defaultMessage: 'Most recent session', description: "Heading in the Overview: the agent's last session." }),
  whoseTip: msg({ id: 'project.session.whoseTip', defaultMessage: 'Whose session to show. It follows the focused agent until you pick one.', description: "Tooltip on the Overview's agent picker." }),
  agent: msg({ id: 'project.session.agentLabel', defaultMessage: 'Agent', description: "Accessible name of the Overview's agent picker." }),
  noDataAgent: msg({ id: 'project.session.noDataAgent', defaultMessage: '{agent} has no session data yet. Start a session and its token use, cache and compaction history will appear here.', description: 'The Overview when the picked agent has never had a session.' }),
  noData: msg({ id: 'project.session.noData', defaultMessage: 'No session data yet. Start a session and its token use, cache and compaction history will appear here.', description: 'The Overview when there has been no session.' }),
  context: msg({ id: 'project.card.context', defaultMessage: 'Context', description: "A figure: how many tokens the session's conversation occupies now." }),
  contextLastTurn: msg({ id: 'project.card.contextLastTurn', defaultMessage: '{input} input + {output} output of the last turn', description: 'Under Context. Token counts such as 12k.' }),
  contextRequest: msg({ id: 'project.card.contextRequest', defaultMessage: '{tokens} tokens in the last request', description: 'Under Context, when the last turn is not known in detail.' }),
  contextTip: msg({ id: 'project.card.contextTip', defaultMessage: "How many tokens the conversation occupies now: the last request's input and its output (thinking included), which stays in the context.", description: 'The (i) beside Context, above details of the context window.' }),
  cache: msg({ id: 'project.card.cache', defaultMessage: 'Cache', description: "A figure: whether the provider's prompt cache is still warm." }),
  warm: msg({ id: 'project.card.warm', defaultMessage: 'Warm', description: 'The cache figure: the prompt cache is still valid.' }),
  expired: msg({ id: 'project.card.expired', defaultMessage: 'Expired', description: 'The cache figure: the prompt cache has expired.' }),
  warmLeft: msg({ id: 'project.card.warmLeft', defaultMessage: '≈ {left} left of {ttl, select, hour {1 h} other {5 min}} TTL', description: "Under Warm: how long the cache stays warm. {left} is a duration; TTL is the cache's time to live." }),
  lastActivity: msg({ id: 'project.card.lastActivity', defaultMessage: 'Last activity {when}', description: 'Under Expired. {when} is how long ago, such as "5m ago".' }),
  cacheTip: msg({ id: 'project.card.cacheTip', defaultMessage: "{company}'s prompt cache keeps the conversation prefix for a limited time (5 minutes or 1 hour). While warm, each message reads the context cheaply from cache.", description: 'The (i) beside Cache. {company} is Anthropic, OpenAI…' }),
  recache: msg({ id: 'project.card.recache', defaultMessage: 'Re-cache on resume', description: 'A figure: tokens written to cache again when the session resumes after its cache expired.' }),
  stillWarm: msg({ id: 'project.card.stillWarm', defaultMessage: 'Cache is still warm', description: 'Under Re-cache on resume.' }),
  writtenNext: msg({ id: 'project.card.writtenNext', defaultMessage: 'tokens written to cache on the next message', description: 'Under Re-cache on resume.' }),
  recacheTip: msg({ id: 'project.card.recacheTip', defaultMessage: 'Estimate: when the cache has expired, the first message after resuming writes the whole context to cache again. Archive and start a new session to avoid it.', description: 'The (i) beside Re-cache on resume.' }),
  compactionsCard: msg({ id: 'project.card.compactions', defaultMessage: 'Compactions', description: "A figure: how often the session's conversation was summarised." }),
  lastCompaction: msg({ id: 'project.card.lastCompaction', defaultMessage: 'Last {when}', description: 'Under Compactions: the last one, such as "Last 5m ago".' }),
  noneYet: msg({ id: 'project.card.noneYet', defaultMessage: 'None yet', description: 'Under Compactions.' }),
  compactionsTip: msg({ id: 'project.card.compactionsTip', defaultMessage: '{provider} summarises the conversation when the context fills up. Each compaction frees space but loses detail.', description: 'The (i) beside Compactions.' }),
  output: msg({ id: 'project.card.output', defaultMessage: 'Output', description: 'A figure: output tokens.' }),
  outputDetail: msg({ id: 'project.card.outputDetail', defaultMessage: '{requests, plural, one {# request} other {# requests}} · {prompts, plural, one {# prompt} other {# prompts}}', description: 'Under Output.' }),
  input: msg({ id: 'project.card.input', defaultMessage: 'Input', description: 'A figure: input tokens.' }),
  fromCache: msg({ id: 'project.card.fromCache', defaultMessage: '{share, number, ::percent} read from cache', description: 'Under Input: the share of input tokens read from the prompt cache ("85%").' }),
  inputTip: msg({ id: 'project.card.inputTip', defaultMessage: 'All input tokens: uncached input, cache writes and cache reads.', description: 'The (i) beside Input.' }),
  cacheWrites: msg({ id: 'project.card.cacheWrites', defaultMessage: 'Cache writes', description: 'A figure: tokens written to cache.' }),
  writtenToCache: msg({ id: 'project.card.writtenToCache', defaultMessage: 'tokens written to cache', description: 'Under Cache writes.' }),
  cacheReads: msg({ id: 'project.card.cacheReads', defaultMessage: 'Cache reads', description: 'A figure: tokens read from cache.' }),
  readFromCache: msg({ id: 'project.card.readFromCache', defaultMessage: 'tokens read from cache', description: 'Under Cache reads.' }),
  sessionEstimated: msg({ id: 'project.card.sessionEstimated', defaultMessage: 'this session, estimated at API prices', description: "Under a session's cost." }),
  sessionAtPrices: msg({ id: 'project.card.sessionAtPrices', defaultMessage: 'this session, at API prices', description: "Under a session's cost." }),
  sessionCostTip: msg({ id: 'project.card.sessionCostTip', defaultMessage: '{estimated, select, yes {What this session would have cost at {company} API prices, estimated by Combwork from its token counts. On a subscription you are not charged this; it shows how heavy the session has been.} other {What this session would have cost at {company} API prices, as {provider} calculates it. On a subscription you are not charged this; it shows how heavy the session has been.}}', description: "The (i) beside a session's cost. {company} is Anthropic, OpenAI…; {provider} Claude Code, Codex…" }),
  noPriceFor: msg({ id: 'project.card.noPriceFor', defaultMessage: 'no price for {model}', description: 'Under a cost shown as Unknown.' }),
  model: msg({ id: 'project.meta.model', defaultMessage: 'Model', description: "A row of the session's details." }),
  cliVersion: msg({ id: 'project.meta.version', defaultMessage: '{provider} version', description: "A row of the session's details: the CLI's version. {provider} is Claude Code, Codex…" }),
  started: msg({ id: 'project.meta.started', defaultMessage: 'Started', description: "A row of the session's details." }),
  lastActivityRow: msg({ id: 'project.meta.lastActivity', defaultMessage: 'Last activity', description: "A row of the session's details." }),
  lastPrompt: msg({ id: 'project.meta.lastPrompt', defaultMessage: 'Last prompt', description: "A row of the session's details." }),
  compactionHistory: msg({ id: 'project.compaction.heading', defaultMessage: 'Compaction history', description: "Heading of the session's compactions." }),
  limitTitle: msg({ id: 'project.limit.title', defaultMessage: '{window, select, fiveHour {5-hour limit} weekly {Weekly limit} other {{label} limit}}', description: "Title of a plan limit figure: the provider's rolling usage window. {label} is the provider's own name for a window Combwork doesn't know." }),
  limitUsed: msg({ id: 'project.limit.used', defaultMessage: 'used', description: 'Under a plan limit\'s percent: "42% used".' }),
  limitResets: msg({ id: 'project.limit.resets', defaultMessage: 'used · resets {when}', description: 'Under a plan limit\'s percent. {when} is when it resets: "in 2 h 5 min", or a day and time.' }),
  limitTip: msg({ id: 'project.limit.tip', defaultMessage: "How much of your plan’s {window, select, fiveHour {5-hour} weekly {weekly} other {{label}}} allowance is used, across all your {provider} sessions (not just Combwork).", description: 'The (i) beside a plan limit.' }),
  planLimits: msg({ id: 'project.limit.heading', defaultMessage: '{plan, select, none {Plan limits, account-wide, as of {when}} other {Plan limits ({plan}), account-wide, as of {when}}}', description: "Above the plan limits. {plan} is the plan's name (none when unknown); {when} how long ago they were reported." }),
  limitTipConnection: msg({ id: 'project.limit.tipConnection', defaultMessage: "How much of the plan’s {window, select, fiveHour {5-hour} weekly {weekly} other {{label}}} allowance is used on {name}, across all its sessions (not just Combwork's).", description: 'The (i) beside a plan limit of one connection (HI-1756): {name} is the connection, a sign-in the user named ("Max 1").' }),
  noConnectionLimits: msg({ id: 'project.limit.noneConnection', defaultMessage: 'Its limits appear after the next message in a session on {name}.', description: 'Under a connection ({name}: "Max 1", a sign-in the user named) in the plan limits (HI-1756), before any of its limits were reported.' }),
  noConnectionsOn: msg({ id: 'project.limit.noConnections', defaultMessage: 'No {provider} account is on in this workspace. Turn one on in Settings → Accounts & Connections to see its plan limits here.', description: 'In place of the plan limits (HI-1756) when the workspace has no account on for the coding agent ({provider}). Settings → Accounts & Connections names a section.' }),
  noLimits: msg({ id: 'project.limit.none', defaultMessage: "{provider} reports your plan’s limits while a session runs; they appear here after the next message in any {provider} session. Accounts that use an API key have no plan limits.", description: 'In place of the plan limits before any were reported.' })
}

const C = {
  gitStatus: msg({ id: 'project.changes.status', defaultMessage: '{status, select, M {Modified} A {Added} D {Deleted} R {Renamed} C {Copied} U {Conflict} untracked {Untracked} other {{status}}}', description: "A changed file's git status, in its tooltip in the Changes list." }),
  staged: msg({ id: 'project.changes.staged', defaultMessage: '{status} (staged): {path}', description: "Tooltip on a changed file that is staged. {status} is its status, such as Modified." }),
  unstaged: msg({ id: 'project.changes.unstaged', defaultMessage: '{status}: {path}', description: 'Tooltip on a changed file. {status} is its status, such as Modified.' }),
  pickerTip: msg({ id: 'project.changes.pickerTip', defaultMessage: 'Two branches compared, unused worktrees, a worktree an agent works in, or the project folder', description: "Tooltip on the Changes tab's picker." }),
  unusedGroup: msg({ id: 'project.changes.unusedGroup', defaultMessage: 'Unused worktrees (no agent works in them)', description: "A group of the Changes tab's folder picker." }),
  unusedLooking: msg({ id: 'project.changes.unusedLooking', defaultMessage: 'Unused worktrees (looking…)', description: "The picker's entry for all unused worktrees while Combwork lists them." }),
  unusedCount: msg({ id: 'project.changes.unusedCount', defaultMessage: 'Unused worktrees ({count})', description: "The picker's entry for all unused worktrees." }),
  unusedFailed: msg({ id: 'project.changes.unusedFailed', defaultMessage: "Unused worktrees (couldn't list)", description: "The picker's entry for all unused worktrees when listing them failed." }),
  inUseGroup: msg({ id: 'project.changes.inUseGroup', defaultMessage: 'Worktrees in use', description: "A group of the Changes tab's folder picker: agents' worktrees." }),
  agentWorktree: msg({ id: 'project.changes.agentWorktree', defaultMessage: "{agent}'s worktree · {branch}", description: "An agent's worktree in the picker. {branch} is its git branch." }),
  agentSlot: msg({ id: 'project.changes.agentSlot', defaultMessage: '{agent} · {place}{known, select, yes { · {branch}} other {}}', description: "An agent's slot in the picker (#1569): the agent, where it works ({place}: \"in slot-b\", or \"carried: hb2\" for the slot kept for it) and its git branch ({branch}), when known. Glossary: slot." }),
  projectGroup: msg({ id: 'project.changes.projectGroup', defaultMessage: 'Project folder', description: "A group of the Changes tab's folder picker." }),
  projectFolder: msg({ id: 'project.changes.projectFolder', defaultMessage: 'Project folder · {branch}', description: "The project folder in the picker. {branch} is its git branch (or the project's name)." }),
  worktreeOf: msg({ id: 'project.changes.worktreeOf', defaultMessage: "{agent}'s worktree", description: "Who the changes shown are: an agent's worktree." }),
  cantShow: msg({ id: 'project.changes.cantShow', defaultMessage: "{problem}, so Combwork can't show {project}'s changes.", description: 'The Changes tab when git cannot run. {problem} says why, such as "Git isn\'t installed (or isn\'t on Combwork\'s PATH)".' }),
  agentSetup: msg({ id: 'project.changes.agentSetup', defaultMessage: 'Provider Setup', description: 'Button: opens Provider Setup, which checks git and says how to fix it.' }),
  retry: msg({ id: 'project.retry', defaultMessage: 'Retry', description: 'Button: tries again.' }),
  changes: msg({ id: 'project.changes.heading', defaultMessage: 'Changes', description: "Heading of the Changes list (the Git tab's Changes section)." }),
  lookingUnused: msg({ id: 'project.changes.lookingTip', defaultMessage: 'Looking for unused worktrees…', description: 'Tooltip on the refresh button while Combwork looks for unused worktrees.' }),
  refreshUnused: msg({ id: 'project.changes.refreshUnused', defaultMessage: 'Refresh: look for unused worktrees again', description: 'Tooltip on the refresh button above the unused worktrees.' }),
  unusedTarget: msg({ id: 'project.changes.unusedTarget', defaultMessage: 'the unused worktrees', description: 'What could not be refreshed: shown in "Could not refresh {what}; last updated …".' }),
  unusedListFailed: msg({ id: 'project.changes.listFailed', defaultMessage: "Couldn't list the unused worktrees: {error}", description: 'In place of the unused worktrees when listing them failed. {error} is why.' }),
  lookingBody: msg({ id: 'project.changes.looking', defaultMessage: 'Looking for unused worktrees…', description: 'In place of the unused worktrees while Combwork lists them.' }),
  lookingHint: msg({ id: 'project.changes.lookingHint', defaultMessage: "Combwork asks git about each of {project}'s worktrees, which can take a few seconds.", description: 'Under "Looking for unused worktrees…".' }),
  checkingAgain: msg({ id: 'project.changes.checkingAgain', defaultMessage: 'Checking them again…', description: 'Over the unused worktrees while Combwork lists them again.' }),
  readFailed: msg({ id: 'project.changes.readFailed', defaultMessage: 'Could not read the changes: {error}', description: 'In place of the changes when git status failed.' }),
  notRepo: msg({ id: 'project.changes.notRepo', defaultMessage: '{project} is not a git repository, so there are no changes to review.', description: 'The Changes section of a project without git.' }),
  initHint: msg({ id: 'project.changes.initHint', defaultMessage: 'Initialise it to review its changes here: it gets a first commit, so agents can work in worktrees too.', description: 'Under "… is not a git repository", above the Initialise button.' }),
  mergeAgent: msg({ id: 'project.changes.mergeAgent', defaultMessage: "Merge {agent}'s work…", description: "Tooltip on the merge button of an agent's worktree changes." }),
  mergeBranch: msg({ id: 'project.changes.mergeBranch', defaultMessage: 'Merge {branch}…', description: "Tooltip on the merge button of an unused worktree's changes." }),
  refreshFailed: msg({ id: 'project.changes.refreshFailed', defaultMessage: 'Could not refresh: {error}', description: 'Banner when reading the changes again failed (the last ones stay).' }),
  sinceLeft: msg({ id: 'project.changes.sinceLeft', defaultMessage: 'since it left {base}', description: 'After the branch above a worktree\'s changes: everything since it left {base}, the branch it started from.' }),
  noAgentChanges: msg({ id: 'project.changes.noAgentChanges', defaultMessage: 'No changes on {branch} yet.', description: "The changes of an agent's worktree when there are none." }),
  nothingOn: msg({ id: 'project.changes.nothingOn', defaultMessage: "Nothing on {branch} that isn't on {base}.", description: "The changes of an unused worktree when there are none." }),
  clean: msg({ id: 'project.changes.clean', defaultMessage: 'Working tree clean.', description: 'The changes of the project folder when there are none.' }),
  headWorkingTree: msg({ id: 'project.changes.headWorkingTree', defaultMessage: 'HEAD ↔ working tree', description: "Above a diff: what it compares. Keep HEAD (git's word)." }),
  sideBySide: msg({ id: 'project.changes.sideBySide', defaultMessage: 'Side by side', description: 'Tooltip on the button that shows the diff in two columns.' }),
  inline: msg({ id: 'project.changes.inline', defaultMessage: 'Inline', description: 'Tooltip on the button that shows the diff in one column.' }),
  openFile: msg({ id: 'project.changes.openFile', defaultMessage: 'Open file', description: 'Tooltip on the button that opens the changed file.' }),
  openFailed: msg({ id: 'project.changes.openFailed', defaultMessage: 'Could not open the file', description: 'Title of an error notification.' }),
  diffStale: msg({ id: 'project.changes.diffStale', defaultMessage: 'Could not refresh the diff, so this may be out of date: {error}', description: 'Banner over a diff that could not be read again.' }),
  binary: msg({ id: 'project.changes.binary', defaultMessage: 'Binary file — no text diff.', description: 'In place of the diff of a binary file.' }),
  diffFailed: msg({ id: 'project.changes.diffFailed', defaultMessage: 'Could not load the diff: {error}', description: 'In place of a diff that could not be read.' }),
  loadingDiff: msg({ id: 'project.changes.loadingDiff', defaultMessage: 'Loading the diff…', description: 'While the diff loads.' }),
  mainBranch: msg({ id: 'project.changes.mainBranch', defaultMessage: 'the main branch', description: "Said of the branch an unused worktree would merge into, when git can't say which." }),
  selectFile: msg({ id: 'project.changes.selectFile', defaultMessage: 'Select a file to see its changes.', description: 'The Changes section when no file is selected.' }),
  memLocal: msg({ id: 'project.memory.localTip', defaultMessage: 'Personal project instructions {provider} reads that are not committed.', description: "Tooltip on a provider's local instructions file (such as CLAUDE.local.md)." }),
  memAuto: msg({ id: 'project.memory.autoTip', defaultMessage: "{provider}'s own memory for this project — facts it chose to remember across sessions.", description: "Tooltip on a provider's own memory file." }),
  memProject: msg({ id: 'project.memory.projectTip', defaultMessage: 'Project instructions {provider} reads at the start of every session. Usually committed to git.', description: "Tooltip on a provider's project instructions file (such as CLAUDE.md, AGENTS.md)." }),
  shareTitle: msg({ id: 'project.memory.shareTitle', defaultMessage: 'Share instructions', description: 'Title of the confirmation before agents of several providers share one AGENTS.md.' }),
  shareMessage: msg({ id: 'project.memory.shareMessage', defaultMessage: '{providers} will read the same AGENTS.md.', description: 'The confirmation. {providers} is the providers as a list, such as "Claude Code and Codex". Keep AGENTS.md.' }),
  shareImport: msg({ id: 'project.memory.shareImport', defaultMessage: '{file} gets an "{line}" line that includes AGENTS.md; anything else in it still applies to {provider} only.', description: "In the confirmation, for each provider whose own file gets a line importing AGENTS.md. {file} is its file (CLAUDE.md); {line} the import line, as it is written." }),
  shareMoves: msg({ id: 'project.memory.shareMoves', defaultMessage: "If there's no AGENTS.md yet, the current instructions move into it, so nothing is lost.", description: 'In the share confirmation.' }),
  shareDot: msg({ id: 'project.memory.shareDot', defaultMessage: 'Your .claude/CLAUDE.md stays as it is and applies to Claude Code only: move anything the other agents should know into AGENTS.md.', description: 'In the share confirmation, when the project has a .claude/CLAUDE.md. Keep the file names.' }),
  shareNext: msg({ id: 'project.memory.shareNext', defaultMessage: 'Running sessions read the change when they next start.', description: 'Last in the share confirmation.' }),
  share: msg({ id: 'project.memory.share', defaultMessage: 'Share', description: "The share confirmation's button." }),
  shareFailed: msg({ id: 'project.memory.shareFailed', defaultMessage: 'Could not share the instructions', description: 'Title of an error notification.' }),
  shared: msg({ id: 'project.memory.shared', defaultMessage: 'Instructions shared', description: 'Notification after sharing AGENTS.md.' }),
  updated: msg({ id: 'project.memory.updated', defaultMessage: 'Updated {files}.', description: 'Under "Instructions shared": the files written, as a list.' }),
  groupInstructions: msg({ id: 'project.memory.groupInstructions', defaultMessage: '{provider}: instructions', description: "A group in the Memory tab: a provider's instructions files." }),
  groupMemory: msg({ id: 'project.memory.groupMemory', defaultMessage: '{provider}: memory', description: "A group in the Memory tab: a provider's own memory files." }),
  memoryHeading: msg({ id: 'project.memory.heading', defaultMessage: 'Memory', description: "Heading of the Memory tab's list." }),
  memoryTarget: msg({ id: 'project.memory.target', defaultMessage: 'the instructions and memory', description: 'What could not be read in the Memory tab: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  ownFile: msg({ id: 'project.memory.ownFile', defaultMessage: 'Each provider reads its own instructions file.', description: 'In the Memory tab of a project with agents of several providers, before Share one AGENTS.md….' }),
  shareButton: msg({ id: 'project.memory.shareButton', defaultMessage: 'Share one AGENTS.md…', description: 'Button: makes every provider read one AGENTS.md (asks first). Keep AGENTS.md.' }),
  nothingSaved: msg({ id: 'project.memory.nothingSaved', defaultMessage: 'Nothing saved for this project yet.', description: "Under a provider's memory group when it has none." }),
  create: msg({ id: 'project.memory.create', defaultMessage: 'create', description: "Beside an instructions file that doesn't exist yet: selecting it creates it." }),
  selectFileMem: msg({ id: 'project.memory.select', defaultMessage: 'Select a memory file.', description: 'The Memory tab when no file is selected.' }),
  applyNew: msg({ id: 'project.apply.new', defaultMessage: '{live, select, yes {Changes apply to new sessions — restart the running session to apply them.} other {Changes apply to new sessions.}}', description: 'Under the Skills and MCP tabs.' }),
  skillsHeading: msg({ id: 'project.skills.heading', defaultMessage: 'Skills available to agents', description: "Heading of the project's Skills tab list." }),
  skillsTarget: msg({ id: 'project.skills.target', defaultMessage: 'the skills', description: 'What could not be read in the Skills tab: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  combworkGroup: msg({ id: 'project.skills.cw', defaultMessage: 'Combwork', description: "The group of Combwork's own skills (the workspace's). Usually kept as Combwork." }),
  deliveredNote: msg({ id: 'project.skills.deliveredNote', defaultMessage: "Each switch says whether this project's agents get the skill (Delivered to agents), from their next session. A skill switched off in the Skills view is off in every project.", description: "Under the Combwork skills in a project's Skills tab: what the switch beside each skill does. Delivered to agents is the switch's name; the Skills view is the workspace's list of skills." }),
  noCombworkSkills: msg({ id: 'project.skills.noCombwork', defaultMessage: 'No Combwork skills in this workspace.', description: 'Under the Combwork group when it is empty.' }),
  editInWorkspace: msg({ id: 'project.skills.editInWorkspace', defaultMessage: "Edit in the workspace's Skills view (Combwork skills are shared by every project)", description: 'Tooltip on the button beside a Combwork skill.' }),
  assistantOnly: msg({ id: 'project.skills.assistantOnly', defaultMessage: "{count, plural, one {# Combwork skill is for the Assistant only, so it isn't listed: this project's agents don't get it.} other {# Combwork skills are for the Assistant only, so they aren't listed: this project's agents don't get them.}}", description: 'Under the Combwork skills, when some are for the Combwork Assistant alone.' }),
  seeThem: msg({ id: 'project.skills.seeThem', defaultMessage: 'See them in the Skills view', description: 'Link after the note about skills for the Combwork Assistant.' }),
  showSkillsOf: msg({ id: 'project.skills.showOf', defaultMessage: 'Show the skills of', description: "Accessible name of the provider picker in the Skills tab." }),
  providerSkills: msg({ id: 'project.skills.providerGroup', defaultMessage: '{provider} skills', description: "The fold of a provider's skills, such as \"Claude Code skills\"." }),
  local: msg({ id: 'project.skills.local', defaultMessage: 'Local (User Managed)', description: "A group of a provider's skills: this project's own." }),
  newLocal: msg({ id: 'project.skills.newLocal', defaultMessage: 'New local skill for {provider}…', description: 'Tooltip on the + of the Local group.' }),
  addLocal: msg({ id: 'project.skills.addLocal', defaultMessage: 'Add a local skill for {provider} from a file (.md or .zip)…', description: 'Tooltip on the add-from-file button of the Local group.' }),
  noneLocal: msg({ id: 'project.skills.noneLocal', defaultMessage: 'None yet. Add one with +, or from a .md or .zip.', description: 'Under the Local group when it is empty.' }),
  deleteSkill: msg({ id: 'project.skills.delete', defaultMessage: 'Delete skill', description: 'Tooltip on the delete button beside a local skill.' }),
  user: msg({ id: 'project.skills.user', defaultMessage: 'User', description: "A group of a provider's skills: in your user profile." }),
  noneUser: msg({ id: 'project.skills.noneUser', defaultMessage: 'None in your user profile.', description: 'Under the User group when it is empty.' }),
  plugins: msg({ id: 'project.skills.plugins', defaultMessage: 'Plugins', description: "A group of a provider's skills: from its plugins." }),
  turnOnProvider: msg({ id: 'project.skills.turnOn', defaultMessage: 'Turn on a coding agent in Settings → Providers to see its skills.', description: 'The Skills tab when no provider is turned on.' }),
  selectSkill: msg({ id: 'project.skills.select', defaultMessage: "Select a skill to view it. <b>Combwork</b> skills reach every project's agents (those for the Assistant alone aren't listed here) and are edited in the workspace's Skills view; <b>local</b> skills belong to this project and one provider, and you can add, edit and delete them here.", description: 'The Skills tab when no skill is selected. <b> marks the group names, in bold.' }),
  givenAll: msg({ id: 'project.mcp.givenAll', defaultMessage: 'Given to every agent', description: "Under an MCP server in a project's MCP tab, once agents choose their own servers." }),
  givenTo: msg({ id: 'project.mcp.givenTo', defaultMessage: 'Given to {agents} only', description: 'Under an MCP server: the agents that get it, as a list.' }),
  givenNone: msg({ id: 'project.mcp.givenNone', defaultMessage: 'Given to no agent (each chose others)', description: 'Under an MCP server no agent gets.' }),
  mcpHeading: msg({ id: 'project.mcp.headingAdded', defaultMessage: 'Added servers', description: "Heading in a project's MCP tab (HI-2059): the workspace's MCP servers added to this project." }),
  addServer: msg({ id: 'project.mcp.addServer', defaultMessage: 'Add Server…', description: "A button in a project's MCP tab and the Combwork Assistant's view (HI-2059): opens the picker of the workspace's MCP servers to add." }),
  remove: msg({ id: 'project.mcp.remove', defaultMessage: 'Remove', description: "A button on an MCP server added to a project or the Combwork Assistant (HI-2059): it no longer runs there (it stays in the workspace)." }),
  removeLabel: msg({ id: 'project.mcp.removeLabel', defaultMessage: 'Remove {name} from {project}', description: "Accessible name of Remove on an MCP server in a project's MCP tab (HI-2059). {name} is the server, {project} the project." }),
  noneAdded: msg({ id: 'project.mcp.noneAdded', defaultMessage: "No servers added. Add one to give this project's agents its tools.", description: "A project's MCP tab (HI-2059) when no MCP server is added to it." }),
  mcpTarget: msg({ id: 'project.mcp.target', defaultMessage: "the workspace's MCP servers", description: 'What could not be read in the MCP tab: shown in "Could not load {what}: {error}" and "Could not refresh {what}; last updated …".' }),
  noServers: msg({ id: 'project.mcp.noneInWorkspace', defaultMessage: 'The workspace has no MCP servers yet.', description: "A project's MCP tab (HI-2059) when the workspace has no MCP servers to add." }),
  manage: msg({ id: 'project.mcp.manage', defaultMessage: 'Manage MCP servers', description: 'Link: opens the workspace\'s MCP view.' }),
  invalid: msg({ id: 'project.mcp.invalid', defaultMessage: 'invalid', description: "Badge on an MCP server whose file can't be read." }),
  definedByProject: msg({ id: 'project.mcp.definedByProject', defaultMessage: 'Defined by the project (disabled)', description: "Heading in a project's MCP tab: servers in the project's own agent config." }),
  copyToWorkspace: msg({ id: 'project.mcp.copy', defaultMessage: 'Copy to workspace', description: "Button: copies the project's own MCP server to the workspace." }),
  builtIn: msg({ id: 'project.mcp.builtIn', defaultMessage: 'Built-in', description: "Heading in a project's MCP tab: Combwork's own server." }),
  combworkDesc: msg({ id: 'project.mcp.combworkDesc', defaultMessage: 'Lets agents see other projects, read and write shared notes, create handovers and notify you.', description: "What Combwork's own MCP server (combwork) does." }),
  onAll: msg({ id: 'project.mcp.onAll', defaultMessage: 'On for all sessions', description: "Badge on Combwork's own MCP server when it is on." }),
  off: msg({ id: 'project.mcp.off', defaultMessage: 'Off', description: "Badge on Combwork's own MCP server when it is off." })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

const S = {
  keyLabel: msg({ id: 'project.key.label', defaultMessage: 'Project key', description: "Accessible name of the project key box (Project Settings): 2–4 letters such as AM that the project's cards are named by." }),
  keyChange: msg({ id: 'project.key.change', defaultMessage: 'Change', description: 'Button beside the project key box (Project Settings): makes the key typed the project’s.' }),
  keyFailed: msg({ id: 'project.key.failed', defaultMessage: 'Could not change the project key', description: "An error's title: changing a project's key failed." }),
  keyChanged: msg({ id: 'project.key.changed', defaultMessage: 'Its cards are named {key} now; {old} still finds them.', description: "A notification after a project's key changed. {key} and {old}: the new and the old key (letters such as AM)." }),
  keyWillAlias: msg({ id: 'project.key.willAlias', defaultMessage: 'Its cards will be named {key}-12; {old}-12 will still find them.', description: 'Under the project key box while a new key is typed (Project Settings). {key} is the key typed, {old} the key it has: AM-12 style card names.' }),
  keyAliases: msg({ id: 'project.key.aliases', defaultMessage: 'Its old keys, which still find its cards: {keys}', description: "Under the project key box (Project Settings): the project's earlier keys, joined (AM and AMB), which still name its cards." }),
  keyNone: msg({ id: 'project.key.none', defaultMessage: 'Combwork gives it a key once its board is open.', description: "Project Settings, in place of the project key box: the project has no key yet (its board hasn't been opened or upgraded)." }),
  overrides: msg({ id: 'project.settings.overrides', defaultMessage: 'Overrides the global default', description: 'Tooltip on the mark beside a project setting that is not Inherit.' }),
  turnedOff: msg({ id: 'project.agents.turnedOff', defaultMessage: '{provider} is turned off in Settings → Providers', description: "Tooltip on an agent's provider icon when the provider is turned off." }),
  off: msg({ id: 'project.agents.off', defaultMessage: '{provider} (off)', description: "A provider's name when it is turned off in Settings → Providers (an agent's provider, and the Provider list)." }),
  projectFolder: msg({ id: 'project.agents.projectFolder', defaultMessage: 'project folder', description: 'Where an agent works when it has no worktree.' }),
  ownMcp: msg({ id: 'project.agents.ownMcp', defaultMessage: 'MCP servers {servers}', description: "One of an agent's own settings, in a list: which MCP servers it gets." }),
  agentSettings: msg({ id: 'project.agents.settings', defaultMessage: 'Agent settings…', description: "Tooltip on an agent's settings button." }),
  merge: msg({ id: 'project.agents.merge', defaultMessage: 'Merge…', description: "Tooltip on a worktree agent's merge button." }),
  remove: msg({ id: 'project.agents.remove', defaultMessage: 'Remove agent…', description: "Tooltip on an agent's remove button (asks first)." }),
  addAgent: msg({ id: 'project.agents.add', defaultMessage: 'Add Agent', description: 'Button: adds an agent to the project.' }),
  saveFailed: msg({ id: 'project.settings.saveFailed', defaultMessage: 'Could not save project settings', description: 'Title of an error notification.' }),
  never: msg({ id: 'project.settings.never', defaultMessage: 'never', description: 'A global setting turned off, shown in "Inherit (never)".' }),
  megabytes: msg({ id: 'project.settings.megabytes', defaultMessage: '{count, number} MB', description: 'A size in megabytes.' }),
  inherit: msg({ id: 'project.settings.inherit', defaultMessage: 'Inherit ({value})', description: 'The choice that takes the global (or workspace) setting. {value} is what that is now.' }),
  inheritNewline: msg({ id: 'project.settings.inheritList', defaultMessage: 'Inherit:\n{value}', description: "Placeholder of a box that takes a list when it is empty: Inherit, then the global list on the lines after it. Keep the line break." }),
  on: msg({ id: 'project.settings.on', defaultMessage: 'On', description: 'A choice: on.' }),
  offChoice: msg({ id: 'project.settings.off', defaultMessage: 'Off', description: 'A choice: off.' }),
  onLower: msg({ id: 'project.settings.onLower', defaultMessage: 'on', description: 'A global setting that is on, shown in "Inherit (on)".' }),
  offLower: msg({ id: 'project.settings.offLower', defaultMessage: 'off', description: 'A global setting that is off, shown in "Inherit (off)".' }),
  compactAbove: msg({ id: 'project.settings.compactAbove', defaultMessage: 'Suggest compacting above', description: 'Accessible name of the number box of tokens above which compacting is suggested.' }),
  neverChoice: msg({ id: 'project.settings.neverChoice', defaultMessage: 'Never', description: 'A choice: the warning or suggestion is off.' }),
  warnOver: msg({ id: 'project.settings.warnOver', defaultMessage: 'Warn when a transcript is over', description: 'Accessible name of the number box of megabytes above which a transcript is flagged.' }),
  openCombwork: msg({ id: 'project.settings.openCombwork', defaultMessage: 'Open .combwork folder', description: "Button: opens the project's .combwork folder. Keep .combwork." }),
  resetTitle: msg({ id: 'project.settings.resetTitle', defaultMessage: 'Reset project settings?', description: 'Title of the confirmation before resetting the project settings.' }),
  resetMessage: msg({ id: 'project.settings.resetMessage', defaultMessage: "The default provider, each provider’s model, effort, permission mode, context and extra arguments, the chime, the fresh-start suggestion, the compact threshold, the transcript size warning, file locks, worktree setup and the card-loop rounds and wait go back to Inherit, and loop wakes back on. Agents and skill and MCP opt-outs are kept.", description: 'The confirmation before resetting the project settings.' }),
  reset: msg({ id: 'project.settings.reset', defaultMessage: 'Reset', description: "The reset confirmation's button." }),
  resetButton: msg({ id: 'project.settings.resetButton', defaultMessage: 'Reset to defaults', description: 'Button: resets the project settings (asks first).' }),
  search: msg({ id: 'project.settings.search', defaultMessage: 'Search {project} settings', description: "Placeholder of Project Settings' search box." }),
  global: msg({ id: 'project.settings.global', defaultMessage: 'Global settings', description: 'Link: opens Settings.' }),
  noMatch: msg({ id: 'project.settings.noMatch', defaultMessage: 'No settings match.', description: "Project Settings when the search finds nothing." })
}

/** A plan limit's window as the messages select on: the 5-hour and weekly windows Hive knows, else its own label. */
export const limitWindow = (l: PlanLimit): string => (l.windowMinutes === 300 ? 'fiveHour' : l.windowMinutes === 7 * 24 * 60 ? 'weekly' : 'other')

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** Live updates of the session list come at most this often (each reads the project's session files). */
const LIVE_REFRESH_MS = 15_000
/** While the usage history is reading sessions a list shows (#1106), the list is read again this soon after it tells. */
const PENDING_RELOAD_MS = 1_500
/** A listing with no answer by then shows as failed, with Retry (#1646). */
const LIST_LIMIT_MS = 60_000

/**
 * The project's sessions with their usage, for the Overview and the Sessions tab. Updates follow
 * Settings → Sessions → Overview updates: live (as sessions change, at most every 15 s), every minute, or
 * only on reload(). Only while a view using it is shown.
 */
const NO_SESSIONS: SessionListItem[] = []
/** A listing as shown: `othersLoading` while it is Hive's own sessions alone, the others still being read (HI-1681). */
type SessionsData = { list: SessionListItem[]; kept: SessionListItem[]; othersLoading?: boolean }

export function useSessions(project: ProjectInfo) {
  const mode = useStore((s) => s.settings?.sessions.overviewRefresh ?? 'live')
  // A project's tabs stay mounted while another view (Notes, Settings…) is shown: they don't update then.
  const shown = useStore((s) => s.activity === 'projects' || s.workspace?.assistant?.path === project.path)
  // This project's sessions, and deleted sessions' usage (totals count it, lists don't show it). A failed load: views
  // say so (with this project's sessions from before, if any), not "no sessions".
  const sessions = useScopedLoad<SessionsData>(project.path)
  const haveList = useRef(false)
  haveList.current = !!sessions.data
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One listing at a time (#1646): with listings slower than the updates asking for them (a busy disk, hundreds of
  // sessions), each newer one dropped the one under way and none was ever shown.
  const serial = useRef(oneAtATime())
  const latest = useRef<() => void>(() => undefined)
  const { load: loadScoped } = sessions
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    last.current = Date.now()
    const path = project.path
    serial.current.run(
      path,
      () => {
        // Deleted sessions' usage only adds to the totals: without it they are a little low, which beats no list.
        const kept = call('session:keptUsage', path).catch(() => [] as SessionListItem[])
        const list = Promise.all([call('session:list', path), kept]).then(([items, k]): SessionsData => ({ list: items, kept: k }))
        const bounded = withinTime(list, LIST_LIMIT_MS, () => tr(M.noAnswer, { seconds: LIST_LIMIT_MS / 1000 }))
        if (haveList.current) {
          loadScoped(path, () => bounded)
          return bounded
        }
        // Nothing shown yet (HI-1681): Hive's own sessions first, from its records, while the sessions its CLIs keep for
        // the project's folders are read (seconds on a busy disk with hundreds of them); the whole list follows. Shown
        // only while the whole list's load runs, which alone says how it ended (its time limit too); without deleted
        // sessions' usage meanwhile, which only adds to totals.
        const own = call('session:list', path, { own: true }).then((items): SessionsData => ({ list: items, kept: NO_SESSIONS, othersLoading: true }))
        loadScoped(path, () => bounded, own)
        return bounded
      },
      () => latest.current()
    )
  }, [project.path, loadScoped])
  latest.current = load
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])
  // Live: a change (usage, or an agent starting or stopping) reloads, at most every LIVE_REFRESH_MS.
  // A card moving into an agent's Doing too: its session records it ("Worked on #5").
  const doingKey = useStore((s) => s.tasks.filter((c) => c.column === 'doing' && c.agent && c.project.toLowerCase() === project.name.toLowerCase()).map((c) => `${c.number}:${c.agent}`).join(','))
  const liveKey = `${doingKey}|${project.agents.map((a) => `${a.live?.sessionId ?? ''}:${a.live?.status ?? ''}:${a.live?.sessionName ?? ''}`).join(',')}`
  const live = (): void => {
    if (mode !== 'live' || !last.current || !shown) return
    const wait = last.current + LIVE_REFRESH_MS - Date.now()
    if (wait <= 0) load()
    else if (!timer.current) timer.current = setTimeout(load, wait)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(live, [liveKey, mode, shown])
  // Sessions the usage history didn't have yet (#1106): their figures follow soon after the worker has them (it says so,
  // usage-changed; else the next look), whatever the update setting: that's the list's first load finishing, not a refresh.
  const pending = sessions.data?.list.some((i) => i.pending) ?? false
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSoon = (): void => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current)
    pendingTimer.current = pending && shown ? setTimeout(load, PENDING_RELOAD_MS) : null
  }
  useEffect(() => {
    pendingSoon()
    return () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.at, pending, shown])
  // The usage history's changes, followed without rendering the view again for each (HI-1681): its first import tells
  // of every session, and each render of a list of hundreds held the window up, the list read meanwhile shown seconds late.
  const onUsage = useRef(() => undefined as void)
  onUsage.current = () => {
    live()
    pendingSoon()
  }
  useEffect(() => useStore.subscribe((s, prev) => (s.usageVersion[project.path] ?? 0) !== (prev.usageVersion[project.path] ?? 0) && onUsage.current()), [project.path])
  useEffect(() => {
    if (mode !== 'minute' || !shown) return
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [mode, load, shown])
  return { items: sessions.data?.list ?? null, kept: sessions.data?.kept ?? NO_SESSIONS, othersLoading: sessions.data?.othersLoading ?? false, reload: load, loadedAt: sessions.at, error: sessions.error }
}


/** A figure on the Usage tab; `stat` names it as data-stat, a hook for tests that can't read its translated title (#769). */
function Card({ title, value, sub, tip, accent, children, stat }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: React.ReactNode; accent?: boolean; children?: React.ReactNode; stat?: string }) {
  return (
    <div className={cx('card', accent && 'accent')} data-stat={stat}>
      <h3>
        {title} {tip && <InfoTip text={tip} />}
      </h3>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {children}
    </div>
  )
}

export { PERIODS, activeIn, costText, dailyTotals, money, periodFrom, sumUsage, type Period, type Totals } from '@shared/usageTotals'

/** A small bar per day (tokens), for the 7- and 30-day periods; hover a day for its numbers. */
export function DailyChart({ days }: { days: DayTotal[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const label = (day: string): string => formatDayLabel(`${day}T12:00:00`)
  return (
    <div className="daily-chart" role="img" aria-label={tr(M.tokensPerDay)}>
      <div className="daily-bars">
        {days.map((d) => (
          <Tooltip key={d.day} content={tr(M.dayTip, { day: label(d.day), tokens: formatTokens(d.tokens), cost: costText(d), prompts: d.prompts })}>
            <div className="daily-col">
              <div className="daily-bar" style={{ height: `${d.tokens ? Math.max(3, (d.tokens / max) * 100) : 0}%` }} />
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(days[0].day)}</span>
        <span>{tr(M.today)}</span>
      </div>
    </div>
  )
}

/** The agent a session belongs to: the agent whose 0.9 worktree it ran in, else the agent recorded for it ('?' when none). */
function sessionAgent(project: ProjectInfo, s: SessionListItem): string {
  const cwd = s.cwd
  const own = cwd && !samePath(cwd, project.path) ? project.agents.find((a) => { const l = legacyOf(a); return !!l && samePath(l.path, cwd) }) : undefined
  return own?.id ?? s.agentId ?? '?'
}

/** The project's usage for a period: one summary, what runs now, each provider, each agent, then one agent's session. */
export function OverviewTab({ project }: { project: ProjectInfo }) {
  const { items, kept, reload, loadedAt, error } = useSessions(project)
  const settings = useStore((s) => s.settings)
  const slots = projectSlots(useMergeSlots(), project.path)
  const [period, setPeriod] = useState<Period>('all')
  const now = useNow(60000)
  if (!items) return error ? <LoadFailed what={tr(M.sessionsTarget)} error={error} onRetry={reload} /> : <div className="empty-state"><Icon name="loading" spin />{tr(M.loading)}</div>

  const from = periodFrom(period, now)
  const inPeriod = activeIn([...items.filter((i) => i.source === 'combwork'), ...kept], from)
  const total = sumUsage(inPeriod, from)
  const running = project.agents.filter((a) => a.live && !a.live.settingUp)
  const used = new Set([...inPeriod.map((i) => i.provider), ...running.map((a) => a.live!.provider)])
  const providers = PROVIDERS.filter((p) => used.has(p.id) || isProviderEnabled(settings, p.id))
  const tokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output
  const costTip = tr(M.costTip)

  return (
    <div className="scroll-page overview-page">
      <div className="page-narrow">
        <TaskStrip project={project} />
        <CombworkVcsNotice project={project} dismissible />
        {slots.length > 0 && (
          <>
            <h2 className="section">{tr(M.mergeSlot)}</h2>
            <MergeSlotList slots={slots} projectName={() => project.name} showProject={false} />
          </>
        )}
        <div className="overview-head">
          <h2 className="section">{tr(M.summary)}</h2>
          <Tooltip content={tr(M.updated, { when: timeAgo(new Date(loadedAt).toISOString()) })}>
            <span>
              <IconButton icon="refresh" title={tr(M.refresh)} onClick={reload} />
            </span>
          </Tooltip>
          <div className="grow" />
          <div className="segmented" role="group" aria-label={tr(M.period)}>
            {PERIODS.map((p) => (
              <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => setPeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {error && <StaleNote what={tr(M.sessionsTarget)} error={error} at={loadedAt} onRetry={reload} />}
        <p className="hint">{tr(M.periodHint)}</p>
        <div className="cards">
          <Card accent title={tr(M.tokens)} value={formatTokens(tokens(total))} sub={tr(M.tokensSub, { input: formatTokens(total.input + total.cacheWrite), cached: formatTokens(total.cached), output: formatTokens(total.output) })} tip={tr(M.tokensTip)} />
          <Card
            title={tr(M.cost)}
            stat="cost"
            value={costText(total)}
            sub={total.unpriced ? tr(M.withoutPrice, { count: total.unpriced }) : tr(total.estimated ? M.partlyEstimated : M.asReported)}
            tip={costTip}
          />
          <Card title={tr(M.sessions)} value={formatNumber(total.sessions)} sub={tr(M.runningNow, { count: running.length })} />
          <Card title={tr(M.prompts)} value={formatNumber(total.prompts)} sub={tr(M.compactions, { count: total.compactions })} />
        </div>
        {from && period !== 'today' && <DailyChart days={dailyTotals(inPeriod, from, now)} />}

        {running.length > 0 && (
          <>
            <h2 className="section">{tr(M.runningHeading)}</h2>
            <div className="running-list">
              {running.map((a) => (
                <RunningAgent key={a.id} project={project} a={a} />
              ))}
            </div>
          </>
        )}

        {providers.map((p) => {
          const list = inPeriod.filter((i) => i.provider === p.id)
          const t = sumUsage(list, from)
          return (
            <div key={p.id}>
              <h2 className="section">
                <ProviderIcon provider={p.id} /> {p.name}
                {!isProviderEnabled(settings, p.id) && <span className="muted" style={{ fontWeight: 400 }}> {tr(M.turnedOff)}</span>}
              </h2>
              <div className="cards">
                <Card title={tr(M.tokens)} value={formatTokens(tokens(t))} sub={tr(M.outputSub, { tokens: formatTokens(t.output) })} />
                <Card title={tr(M.cost)} value={costText(t)} sub={t.unpriced ? tr(M.withoutPriceShort, { count: t.unpriced }) : tr(!t.estimated ? M.asReported : p.capabilities.reportsCost && !usesOwnPrices(p.id, settings) ? M.partlyEstimated : M.estimated)} tip={costTip} />
                <Card title={tr(M.sessions)} value={formatNumber(t.sessions)} sub={tr(M.promptsSub, { count: t.prompts })} />
              </div>
              <PlanLimits provider={p.id} />
            </div>
          )
        })}

        {project.agents.length > 1 && (
          <>
            <h2 className="section">{tr(M.byAgent)}</h2>
            <AgentsByUsage rows={project.agents.map((a) => ({ id: a.id, name: a.name, provider: agentProviderOf(a), t: sumUsage(inPeriod.filter((i) => sessionAgent(project, i) === a.id), from) }))} />
          </>
        )}

        <UnusedWorktreesLine project={project} />

        <SessionDetails project={project} items={items} />
      </div>
    </div>
  )
}

/** A row of the Overview's table by agent: what it used in the period. */
interface AgentRow {
  id: string
  name: string
  provider: ProviderId
  t: Totals
}
const allTokens = (t: Totals): number => t.input + t.cached + t.cacheWrite + t.output
/** The table's columns, their headers in the current language (made again when it changes). */
const agentColumns = (): DataColumn<AgentRow>[] => [
  { key: 'agent', header: tr(M.colAgent), cell: (r) => r.name, sortValue: (r) => r.name },
  {
    key: 'provider',
    header: tr(M.colProvider),
    className: 'nowrap',
    cell: (r) => (
      <>
        <ProviderIcon provider={r.provider} /> {providerName(r.provider)}
      </>
    ),
    sortValue: (r) => providerName(r.provider)
  },
  { key: 'sessions', header: tr(M.colSessions), num: true, descFirst: true, cell: (r) => r.t.sessions, sortValue: (r) => r.t.sessions },
  { key: 'tokens', header: tr(M.colTokens), num: true, descFirst: true, cell: (r) => formatTokens(allTokens(r.t)), sortValue: (r) => allTokens(r.t) },
  { key: 'cost', header: tr(M.colCost), num: true, descFirst: true, cell: (r) => (r.t.sessions ? costText(r.t) : '—'), sortValue: (r) => (r.t.sessions ? r.t.cost : null) }
]

/** The Overview's table by agent. */
function AgentsByUsage({ rows }: { rows: AgentRow[] }) {
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(agentColumns, [language])
  return <DataTable id="overview-agents" rows={rows} columns={columns} rowKey={(r) => r.id} empty={tr(M.noAgents)} />
}

/** One running agent: provider, model, mode, status, context used and cost so far. `onOpen` makes it a link. */
export function RunningAgent({ project, a, label, onOpen, assistant }: { project: ProjectInfo; a: ProjectInfo['agents'][number]; label?: React.ReactNode; onOpen?: () => void; assistant?: boolean }) {
  const live = a.live!
  const usage = useLiveUsage(project, a.id)
  const settings = useStore((s) => s.settings)
  const window = usage?.contextWindow ?? null
  const ctx = usage?.contextTokens ?? 0
  const pct = contextPercent(ctx, window)
  const cost = live.costUsd ?? usage?.costUsd ?? null
  const estimated = live.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  const status = statusText(live)
  // Waiting on cards (HI-1679): their chips, as a working agent's card, and the status says what for; its hover the whole.
  const wait = cardsWait(live, status)
  return (
    <div className={cx('running-row', onOpen && 'clickable')} onClick={onOpen} role={onOpen ? 'button' : undefined}>
      {/* The Assistant's own status icon (#399), its status in the tooltip as a dot's is. */}
      {assistant ? (
        <Tooltip content={status}>
          <AssistantMark status={live.status} unseen={live.unseen} />
        </Tooltip>
      ) : (
        <StatusDot live={live} active={project.active} />
      )}
      <ProviderIcon provider={live.provider} />
      <div className="grow">
        {/* One line (HI-1679): the status gives way with "…", the chip after it never wraps and keeps its key whole. */}
        <div className="running-line">
          <strong>{label ?? a.name}</strong>
          <ConnectionMark own={a.connection} provider={live.provider} launched={live.launchedConnection} className="faint running-connection" />
          <Tooltip content={status}>
            <span className="faint running-status">{wait ? wait.line : status}</span>
          </Tooltip>
          {!wait ? <CardChip project={project} a={a} /> : wait.cards.length === 1 ? <WatchedCardChip number={wait.cards[0]} /> : <WatchedCardChips cards={wait.cards} status={status} />}
        </div>
        <div className="faint small">
          {[live.modelName ?? usage?.model ?? null, live.permissionMode ? permissionLabel(live.provider, live.permissionMode, tr) : null, live.planMode ? tr(M.plan) : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <Tooltip content={window ? tr(M.contextOf, { used: fmt.number(ctx), window: fmt.number(window) }) : tr(M.contextUsed, { used: fmt.number(ctx) })}>
        <div className="running-ctx">
          <span className="small">{tr(M.contextShort, { tokens: formatTokens(ctx), percent: pct === null ? 'none' : fmt.percent(pct / 100) })}</span>
          {pct !== null && (
            <div className={cx('meter', pct >= 90 ? 'danger' : pct >= 75 && 'caution')}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Tooltip>
      {cost === null && usage && unpricedModel(usage.provider, usage.model, settings) ? (
        <Tooltip content={unpricedText(usage.model!, providerName(usage.provider))}>
          <span className="running-cost small faint">{tr(M.unknownCost)}</span>
        </Tooltip>
      ) : (
        <span className="running-cost small">{cost !== null ? `${estimated ? '≈ ' : ''}${moneyLabel(cost)}` : ''}</span>
      )}
    </div>
  )
}

/** A compaction, with its place among the session's (oldest first), which opens it in the transcript. */
type CompactionRow = CompactionEvent & { n: number }

/** The compaction history's columns, their headers in the current language (made again when it changes). */
const compactionColumns = (): DataColumn<CompactionRow>[] => [
  { key: 'when', header: tr(M.colWhen), cell: (c) => (c.timestamp ? formatDateTime(c.timestamp) : '—'), sortValue: (c) => c.timestamp || null, descFirst: true, filter: { kind: 'text', value: (c) => (c.timestamp ? formatDateTime(c.timestamp) : '') } },
  { key: 'trigger', header: tr(M.colTrigger), cell: (c) => <span className={cx('badge', c.trigger === 'auto' ? 'accent' : 'info')}>{c.trigger}</span>, sortValue: (c) => c.trigger, filter: { kind: 'choice', value: (c) => c.trigger } },
  { key: 'before', header: tr(M.colBefore), num: true, descFirst: true, cell: (c) => formatTokens(c.preTokens), sortValue: (c) => c.preTokens },
  { key: 'after', header: tr(M.colAfter), num: true, descFirst: true, cell: (c) => formatTokens(c.postTokens), sortValue: (c) => c.postTokens },
  { key: 'freed', header: tr(M.colFreed), num: true, descFirst: true, cell: (c) => formatTokens(Math.max(0, c.preTokens - c.postTokens)), sortValue: (c) => Math.max(0, c.preTokens - c.postTokens) },
  { key: 'turn', header: tr(M.colLastTurn), num: true, descFirst: true, cell: (c) => <LastTurn c={c} />, sortValue: (c) => c.lastOutputTokens ?? null }
]

/** What the last turn before a compaction added, said when it explains the compaction. */
function LastTurn({ c }: { c: CompactionEvent }) {
  if (c.lastOutputTokens === undefined) return <span className="faint">—</span>
  const text = `+${formatTokens(c.lastOutputTokens)}`
  if (!turnPushedCompaction(c)) return <span className="faint">{text}</span>
  return (
    <Tooltip content={tr(M.lastTurnTip, { output: formatTokens(c.lastOutputTokens), input: formatTokens(c.lastInputTokens ?? 0), total: formatTokens(c.preTokens) })}>
      <span className="badge warn compaction-turn">
        {tr(M.turnAdded, { output: formatTokens(c.lastOutputTokens) })}
      </span>
    </Tooltip>
  )
}

/**
 * A session's compactions as a data table (newest first, filters, pages). A row opens that compaction in the Sessions
 * tab's transcript, at its divider, when the transcript (or Hive's backup of it) is there to read.
 */
function CompactionHistory({ project, session, compactions }: { project: ProjectInfo; session: SessionListItem; compactions: CompactionEvent[] }) {
  // Its When filter matches the dates as shown, in the current format.
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useDateColumns(useMemo(compactionColumns, [language]))
  const rows = useMemo(() => compactions.map((c, n) => ({ ...c, n })), [compactions])
  const readable = session.hasTranscript || session.hasBackup
  return (
    <DataTable
      id="compactions"
      className="compaction-history"
      rows={rows}
      columns={columns}
      rowKey={(c) => String(c.n)}
      defaultSort={{ key: 'when', desc: true }}
      defaultPageSize={10}
      empty={tr(M.noCompactions)}
      onRowClick={readable ? (c) => openInSessionsTab(project.path, session.id, c.n) : undefined}
      rowLabel={(c) => tr(M.openCompaction, { trigger: c.trigger, when: c.timestamp ? formatDateTime(c.timestamp) : tr(M.unknownTime) })}
    />
  )
}

/** One agent's running session, else its most recent one, in detail: the agent picked here, else the focused one. */
function SessionDetails({ project, items }: { project: ProjectInfo; items: SessionListItem[] }) {
  const settings = useStore((s) => s.settings)
  useDateStyle()
  const now = useNow(10000)
  const focused = useFocusedAgent(project)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const agent = project.agents.find((a) => a.id === pickedId) ?? focused
  // The footer's context count: this agent's session, scrolled to.
  const jump = useStore((s) => s.overviewJump)
  const head = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!jump || jump.project !== project.path) return
    setPickedId(jump.agentId)
    set({ overviewJump: null })
    // The footer's context: at its compaction history when it has one, else its details; its cost: at its details.
    const to = jump.target === 'session' ? null : document.getElementById('compaction-history')
    setTimeout(() => (to ?? head.current)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }, [jump, project.path])
  const liveState = agent ? agent.live : project.live
  const current = useMemo(() => {
    if (liveState?.sessionId) return items.find((i) => i.id === liveState.sessionId) ?? null
    const own = items.filter((i) => i.source === 'combwork' && (!agent || sessionAgent(project, i) === agent.id))
    return own.find((i) => !i.archived) ?? own[0] ?? null
  }, [items, liveState?.sessionId, agent, project])
  const u: SessionUsage | null = current?.usage ?? null

  const provider = providerDescriptor(u?.provider ?? current?.provider)
  const cacheTtl = provider.capabilities.promptCacheTtl
  const ttl = u ? (settings?.sessions.cacheTtl === '5m' ? 300 : settings?.sessions.cacheTtl === '1h' ? 3600 : u.cacheTtlSeconds) : 300
  const elapsed = u?.lastActivity ? (now - Date.parse(u.lastActivity)) / 1000 : Infinity
  const warm = elapsed < ttl
  const totalIn = u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0
  const hitRate = u && totalIn ? Math.round((u.cacheReadTokens / totalIn) * 100) : 0
  const liveCost = liveState && liveState.sessionId === current?.id ? liveState.costUsd : undefined
  const cost = liveCost ?? u?.costUsd ?? null
  const costEstimated = liveCost !== undefined ? !!liveState?.costEstimated : !!u?.costEstimated

  return (
    <>
        <div className="overview-head session-head" ref={head}>
          <h2 className="section">
            {tr(liveState ? M.currentSession : M.recentSession)}
            {current && <span className="muted" style={{ fontWeight: 400 }}>— {current.name || current.title || current.id.slice(0, 8)} · {provider.name}</span>}
          </h2>
          {project.agents.length > 1 && agent && (
            <Tooltip content={tr(M.whoseTip)}>
              <span>
              <select className="select" aria-label={tr(M.agent)} value={agent.id} onChange={(e) => setPickedId(e.target.value)}>
                {project.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {providerName(agentProviderOf(a))}
                  </option>
                ))}
              </select>
              </span>
            </Tooltip>
          )}
        </div>
        {!u ? (
          <p className="hint">{project.agents.length > 1 && agent ? tr(M.noDataAgent, { agent: agent.name }) : tr(M.noData)}</p>
        ) : (
          <>
            <div className="cards">
              <Card
                accent
                title={tr(M.context)}
                value={formatTokens(u.contextTokens)}
                sub={u.contextInputTokens !== undefined && u.lastOutputTokens ? tr(M.contextLastTurn, { input: formatTokens(u.contextInputTokens), output: formatTokens(u.lastOutputTokens) }) : tr(M.contextRequest, { tokens: formatNumber(u.contextTokens) })}
                tip={<span style={{ whiteSpace: 'pre-line' }}>{`${tr(M.contextTip)}\n${contextLines(u, liveState && liveState.sessionId === current?.id ? liveState.autoCompact : undefined).slice(1).join('\n')}`.trim()}</span>}
              >
                {u.contextWindow ? (
                  <div className="meter">
                    <div style={{ width: `${Math.min(100, (u.contextTokens / u.contextWindow) * 100)}%` }} />
                  </div>
                ) : null}
              </Card>
              {cacheTtl && (
                <>
                  <Card
                    title={tr(M.cache)}
                    value={tr(warm ? M.warm : M.expired)}
                    sub={warm ? tr(M.warmLeft, { left: formatDuration(ttl - elapsed), ttl: ttl === 3600 ? 'hour' : 'minutes' }) : tr(M.lastActivity, { when: timeAgo(u.lastActivity) })}
                    tip={tr(M.cacheTip, { company: provider.company })}
                  />
                  <Card
                    title={tr(M.recache)}
                    value={warm ? '—' : `≈ ${formatTokens(u.contextTokens)}`}
                    sub={tr(warm ? M.stillWarm : M.writtenNext)}
                    tip={tr(M.recacheTip)}
                  />
                </>
              )}
              <Card title={tr(M.compactionsCard)} value={u.compactions.length} sub={u.compactions.length ? tr(M.lastCompaction, { when: timeAgo(u.compactions[u.compactions.length - 1].timestamp) }) : tr(M.noneYet)} tip={tr(M.compactionsTip, { provider: provider.name })} />
              <Card title={tr(M.output)} value={formatTokens(u.outputTokens)} sub={tr(M.outputDetail, { requests: u.requests, prompts: u.userMessages })} />
              <Card title={tr(M.input)} value={formatTokens(u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens)} sub={tr(M.fromCache, { share: hitRate / 100 })} tip={tr(M.inputTip)}>
                <div className="meter">
                  <div style={{ width: `${hitRate}%` }} />
                </div>
              </Card>
              {cacheTtl && <Card title={tr(M.cacheWrites)} value={formatTokens(u.cacheWriteTokens)} sub={tr(M.writtenToCache)} />}
              <Card title={tr(M.cacheReads)} value={formatTokens(u.cacheReadTokens)} sub={tr(M.readFromCache)} />
              {cost !== null && (
                <Card
                  title={tr(M.cost)}
                  value={`${costEstimated ? '≈ ' : ''}${moneyLabel(cost)}`}
                  sub={tr(costEstimated ? M.sessionEstimated : M.sessionAtPrices)}
                  tip={tr(M.sessionCostTip, { estimated: costEstimated ? 'yes' : 'no', company: provider.company, provider: provider.name })}
                />
              )}
              {cost === null && unpricedModel(u.provider, u.model, settings) && (
                <Card title={tr(M.cost)} value={tr(M.unknownCost)} sub={tr(M.noPriceFor, { model: u.model ?? '' })} tip={unpricedText(u.model!, provider.name)} />
              )}
            </div>
            {/* Its own sideways scroll in a very narrow page (#307), as the Overview's other tables have. */}
            <div className="table-wrap session-meta" style={{ marginBottom: 20 }}>
              <table className="table">
                <tbody>
                  <tr>
                    <td className="muted" style={{ width: 180 }}>{tr(M.model)}</td>
                    <td className="mono">{u.model ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">{tr(M.cliVersion, { provider: provider.name })}</td>
                    <td>{u.cliVersion ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">{tr(M.started)}</td>
                    <td>{u.firstActivity ? formatDateTime(u.firstActivity) : '—'}</td>
                  </tr>
                  <tr>
                    <td className="muted">{tr(M.lastActivityRow)}</td>
                    <td>{u.lastActivity ? `${formatDateTime(u.lastActivity)} (${timeAgo(u.lastActivity)})` : '—'}</td>
                  </tr>
                  {u.lastPrompt && (
                    <tr>
                      <td className="muted">{tr(M.lastPrompt)}</td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{u.lastPrompt.slice(0, 400)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {u.compactions.length > 0 && current && (
              <>
                <h2 className="section" id="compaction-history">
                  {tr(M.compactionHistory)}
                </h2>
                <CompactionHistory project={project} session={current} compactions={u.compactions} />
              </>
            )}
          </>
        )}
    </>
  )
}

/**
 * One provider's subscription limits (account-wide), as its sessions last reported them. With connections (HI-1756,
 * the preview on), a CLI that has them lists each of its connections on in this workspace or in use by its sessions,
 * named, each that login's own limits.
 */
export function PlanLimits({ provider }: { provider: ProviderId }) {
  const kept = useStore((s) => s.planUsage[provider])
  const byConnection = useStore((s) => s.connectionPlanUsage)
  const view = useConnections()
  const inUse = useConnectionsInUse()
  const now = useNow(60000)
  const p = providerDescriptor(provider)
  if (connectionsApply(view, provider)) {
    const ids = [...new Set([...(view.workspace[provider]?.on ?? []), ...inUse.filter((c) => c.provider === provider).map((c) => c.id)])]
    if (!ids.length) return <p className="hint">{tr(M.noConnectionsOn, { provider: p.name })}</p>
    return (
      <>
        {ids.map((id) => {
          const c = view.connections.find((x) => x.id === id)
          const name = c?.name ?? inUse.find((x) => x.id === id)?.name ?? id
          const email = c?.observed?.email ?? c?.accepted?.email
          return (
            <div key={id} className="plan-connection-limits" data-plan-connection={id}>
              <div className="plan-connection-name">
                <strong>{name}</strong>
                {email && <span className="faint"> {email}</span>}
              </div>
              <LimitCards kept={byConnection[id]} now={now} tip={(l) => tr(M.limitTipConnection, { window: limitWindow(l), label: l.label, name })} none={tr(M.noConnectionLimits, { name })} />
            </div>
          )
        })}
      </>
    )
  }
  return <LimitCards kept={kept} now={now} tip={(l) => tr(M.limitTip, { window: limitWindow(l), label: l.label, provider: providerName(provider) })} none={tr(M.noLimits, { provider: p.name })} />
}

/** A CLI's or a connection's limits as cards, or `none` before any is current. */
function LimitCards({ kept, now, tip, none }: { kept: PlanUsage | undefined; now: number; tip: (l: PlanLimit) => string; none: string }) {
  // A limit whose reset has passed with no new report isn't shown as it was (#383).
  const usage = kept && { ...kept, limits: kept.limits.filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now) }
  const card = (l: PlanLimit): React.ReactNode => (
    <Card key={l.id} title={tr(M.limitTitle, { window: limitWindow(l), label: `${l.label.charAt(0).toUpperCase()}${l.label.slice(1)}` })} value={fmt.percent(l.usedPercent / 100)} sub={l.resetsAt ? tr(M.limitResets, { when: resetsIn(l.resetsAt) }) : tr(M.limitUsed)} tip={tip(l)} accent={l.usedPercent >= 80}>
      <div className={cx('meter', l.usedPercent >= 95 ? 'danger' : l.usedPercent >= 80 && 'caution')}>
        <div style={{ width: `${Math.min(100, l.usedPercent)}%` }} />
      </div>
    </Card>
  )
  return usage?.limits.length ? (
    <>
      <div className="faint small overview-plan">
        {tr(M.planLimits, { plan: usage.plan || 'none', when: timeAgo(usage.updatedAt) })}
      </div>
      <div className="cards">{usage.limits.map(card)}</div>
    </>
  ) : (
    <p className="hint">{none}</p>
  )
}

// ---------------------------------------------------------------------------
// Changes (git)
// ---------------------------------------------------------------------------

/**
 * The Changes tab's list beside its detail (#906): the list gives up width first, then, short of room for both, sits
 * above the detail (app.css, `.changes-split`), so the detail is never squeezed to nothing or pushed out of the tab.
 */
function ChangesSplit({ listWidth, children }: { listWidth: number; children: React.ReactNode }) {
  return (
    <div className="changes-split" style={{ '--list-width': `${listWidth}px` } as React.CSSProperties}>
      <div className="split">{children}</div>
    </div>
  )
}

/**
 * Whose changes the Changes tab shows (#476): the unused worktrees first (all, or one, each with who made it), then the
 * worktrees agents work in, then the project folder, last (agents working in the folder itself, and you).
 */
function ChangesPicker({ project, value, onChange, unused, looking, listed, compare, leftovers }: { project: ProjectInfo; value: string; onChange: (id: string) => void; unused: UnusedWorktree[]; looking: boolean; listed: boolean; compare: ReturnType<typeof useCompareLines>; leftovers: number }) {
  // The folders agents work in (#1569): a slot, the slot kept for one, or a 0.9 worktree, each once; a free slot's
  // changes are under the unused worktrees.
  const inUse = project.agents.flatMap((a) => { const own = workFolderOf(a); return own ? [{ a, own }] : [] }).filter((x, i, all) => all.findIndex((y) => samePath(y.own.path, x.own.path)) === i)
  return (
    <div className="root-row">
      <Tooltip content={tr(C.pickerTip)}>
        <select className="select root-select changes-picker" value={value} onChange={(e) => onChange(e.target.value)}>
          {compare.lines && compare.lines.branches.length > 1 && <CompareGroup lines={compare.lines} value={value} last={leftovers > 0 || value === LEFTOVERS_ROOT ? <LeftoversOption count={leftovers} /> : null} />}
          <optgroup label={tr(C.unusedGroup)}>
            <option value={UNUSED_ROOT}>{looking ? tr(C.unusedLooking) : listed ? tr(C.unusedCount, { count: unused.length }) : tr(C.unusedFailed)}</option>
            {unused
              .filter((w) => w.branch || w.slot)
              .map((w) => (
                <option key={w.path} value={unusedRoot(w.path)}>
                  {unusedPickerLabel(w)}
                </option>
              ))}
          </optgroup>
          {inUse.length > 0 && (
            <optgroup label={tr(C.inUseGroup)}>
              {inUse.map(({ a, own }) => (
                <option key={a.id} value={a.id}>
                  {a.place.is === 'legacy' ? tr(C.agentWorktree, { agent: a.name, branch: own.branch ?? '' }) : tr(C.agentSlot, { agent: a.name, place: placeText(a.place) ?? '', known: own.branch ? 'yes' : 'no', branch: own.branch ?? '' })}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={tr(C.projectGroup)}>
            <option value="">{tr(C.projectFolder, { branch: project.branch ?? project.name })}</option>
          </optgroup>
        </select>
      </Tooltip>
    </div>
  )
}

export function ChangesTab({ project: owner }: { project: ProjectInfo }) {
  const usageVersion = useStore((s) => s.usageVersion[owner.path] ?? 0)
  const rootId = useStore((s) => s.changesRoot[owner.path])
  const gitTool = useStore((s) => s.gitTool)
  const listWidth = usePaneSize('changes', 280)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [file, setFile] = useState<string | null>(null)
  // The diff and its failure, each with the file (and folder) it is for.
  const [diffOf, setDiffOf] = useState<{ for: string; diff: GitDiff } | null>(null)
  const [diffErrorOf, setDiffErrorOf] = useState<{ for: string; error: string } | null>(null)
  const [inline, setInline] = useState(false)
  // The project's unused worktrees (#400): listed in the folder picker, shown all at once, or one opened like an agent's.
  // The last list shows at once while git is asked again (#476).
  const { data: unusedData, reload: reloadUnused, loading: unusedLoading, error: unusedError, at: unusedAt } = useUnusedWorktrees(owner)
  const unusedList = unusedData?.worktrees ?? []
  // The page shown (#476): the one chosen, else Unused worktrees when the project has worktrees (its agents' or unused
  // ones), else the project folder. Not known yet (no agent's worktree, no list yet): Unused worktrees, looking, until
  // a list says whether there are any. A listing that failed says nothing: the page stays, with the error and Retry,
  // until one succeeds (only a list that came back empty means the project folder).
  const hasWorktrees = owner.agents.some((a) => workFolderOf(a)) || unusedList.length > 0
  const resolving = !hasWorktrees && !unusedData
  // Two branches compared (HI-1824): by default the project's integration line against main, when it has one; until the
  // branches are read, nothing is chosen for it.
  const compare = useCompareLines(owner)
  const integration = compare.lines?.integration && compare.lines.main ? compareRoot(compare.lines.main, compare.lines.integration) : null
  const shownId = rootId ?? integration ?? (!compare.known ? COMPARE_ROOT : hasWorktrees || resolving ? UNUSED_ROOT : '')
  const compared = parseCompareRoot(shownId)
  // The branches nothing uses now (HI-1823), as Branches & remotes reads them.
  const infoRead = useGitRead('git:leftovers', owner)
  const leftovers = useLeftovers(owner, infoRead.data)
  const listingUnused = shownId === UNUSED_ROOT
  const spare = shownId.startsWith(`${UNUSED_ROOT}:`) ? (unusedList.find((w) => unusedRoot(w.path) === shownId && (w.branch || w.slot)) ?? null) : null
  // An agent's folder's changes (its slot, the slot kept for it or its 0.9 worktree, #1569) are everything on its branch
  // since it left its base branch (only what isn't committed when the base isn't known); an unused one's, since the
  // branch it would merge into.
  const agent = owner.agents.find((a) => a.id === shownId && workFolderOf(a))
  const own = agent ? workFolderOf(agent) : null
  // Its 0.9 worktree: Merge… merges it (the agent's merge); a slot's branch is merged as a branch, as an unused slot's.
  const legacy = agent ? legacyOf(agent) : null
  const root = own?.path ?? spare?.path ?? owner.path
  const base = own?.base ?? spare?.check.into ?? undefined
  const project = agent || spare ? { ...owner, path: root } : owner
  // Who the worktree is, in its labels: the agent's 0.9 worktree, its slot, or the unused worktree's branch.
  const whose = agent ? (legacy ? tr(C.worktreeOf, { agent: agent.name }) : (agent.place.name ?? agent.name)) : spare ? unusedName(spare) : null

  const [statusError, setStatusError] = useState<string | null>(null)
  const [diffTry, setDiffTry] = useState(0)
  // Each answer is for the folder (and base) it was asked about: an older one arriving late is dropped.
  const statusFor = useRef('')
  const statusLoads = useRef(0)
  const key = `${root}\n${base ?? ''}`
  const load = useCallback(() => {
    const n = ++statusLoads.current
    void call('git:status', root, base).then(
      (s) => {
        if (n !== statusLoads.current) return
        statusFor.current = `${root}\n${base ?? ''}`
        setStatus(s)
        setStatusError(null)
        setFile((f) => (f && s.files.some((x) => x.path === f) ? f : s.files[0]?.path ?? null))
      },
      (e) => n === statusLoads.current && setStatusError(errorMessage(e))
    )
  }, [root, base])
  // Another folder: its files aren't these, so nothing shows until its own status arrives.
  useEffect(() => {
    setStatus(null)
    setStatusError(null)
    setFile(null)
  }, [root, base])
  useEffect(load, [load, usageVersion])

  // A refresh of the same file keeps showing its diff until the new one arrives; another file's never shows.
  const wanted = `${key}\n${file ?? ''}`
  const diff = diffOf?.for === wanted ? diffOf.diff : null
  const diffError = diffErrorOf?.for === wanted ? diffErrorOf.error : null
  useEffect(() => {
    if (!file || statusFor.current !== key) return
    const asked = `${key}\n${file}`
    let current = true
    void call('git:diff', root, file, base).then(
      (d) => {
        if (!current) return
        setDiffOf({ for: asked, diff: d })
        setDiffErrorOf(null)
      },
      (e) => current && setDiffErrorOf({ for: asked, error: errorMessage(e) })
    )
    return () => {
      current = false
    }
  }, [file, root, base, status, key, diffTry])
  const choose = (id: string): void => set((s) => ({ changesRoot: { ...s.changesRoot, [owner.path]: id } }))
  const selector = hasWorktrees || shownId || (compare.lines?.branches.length ?? 0) > 1 ? <ChangesPicker project={owner} value={shownId} onChange={choose} unused={unusedList} looking={unusedLoading && !unusedData} listed={!!unusedData} compare={compare} leftovers={leftovers.count} /> : null
  if (shownId === COMPARE_ROOT) return <div className="empty-state"><Icon name="loading" spin />{tr(M.loading)}</div>
  if (shownId === LEFTOVERS_ROOT) return <LeftoversPage project={owner} read={infoRead} selector={selector} listWidth={listWidth} onCompare={(b, h) => choose(compareRoot(b, h))} />
  if (compared) return <ComparePage project={owner} base={compared.base} head={compared.head} lines={compare.lines} selector={selector} listWidth={listWidth} onPick={(b, h) => choose(compareRoot(b, h))} />

  // Not "not a git repository": git can't run, so Hive can't tell (#346). Whichever page is shown.
  const gitMissing = (problem: string, retry: () => void): React.ReactNode => (
    <div className="empty-state changes-git-missing" style={{ paddingTop: '15vh' }}>
      <Icon name="warning" />
      {/* Main's text is English (agents read it too): the window's own, in its language, while it knows git's state. */}
      {tr(C.cantShow, { problem: gitProblemText(gitTool) ?? problem, project: project.name })}
      <p className="hint">{gitFixText(gitTool)}</p>
      <div className="flex" style={{ justifyContent: 'center' }}>
        <button className="btn small" onClick={() => set({ setupOpen: true })}>
          <Icon name="hubot" /> {tr(C.agentSetup)}
        </button>
        <button className="btn small" onClick={retry}>
          <Icon name="refresh" /> {tr(C.retry)}
        </button>
      </div>
    </div>
  )
  // What a page of changes shows, in a sentence at the top of its right side (#476: one description, in one place; the
  // unused worktrees page has its own header, UnusedHeading).
  const about = (
    <div className="changes-about changes-page-head" data-about={spare ? 'unused-one' : agent ? 'agent' : 'project'}>
      {spare ? CHANGES_ABOUT.unusedOne(unusedName(spare), spare.check.into ?? tr(C.mainBranch)) : agent && legacy ? CHANGES_ABOUT.agent(agent.name, legacy.branch, legacy.base) : agent ? CHANGES_ABOUT.slot(agent.name, agent.place.is === 'carried' ? 'carried' : 'slot', agent.place.name ?? '', own?.base ?? null) : CHANGES_ABOUT.project}
    </div>
  )

  // All the unused worktrees, in the main pane (#400): the list and its actions, as the Overview had them. Listing them
  // reads git for each, which takes a while: the last list shows meanwhile, else a spinner says what Hive is doing.
  if (listingUnused && unusedData?.gitProblem) return gitMissing(unusedData.gitProblem, reloadUnused)
  if (listingUnused) {
    return (
      <ChangesSplit listWidth={listWidth}>
        <div className="split-list">
          <PaneResizer paneKey="changes" />
          <div className="pane-header" style={{ paddingLeft: 14 }}>
            {tr(C.changes)}
            <div className="actions">
              <IconButton icon={unusedLoading ? 'loading' : 'refresh'} spin={unusedLoading} title={tr(unusedLoading ? C.lookingUnused : C.refreshUnused)} disabled={unusedLoading} onClick={reloadUnused} />
            </div>
          </div>
          {selector}
        </div>
        <div className="split-main unused-worktrees-pane">
          {unusedData && unusedError && !unusedLoading && <StaleNote what={tr(C.unusedTarget)} error={unusedError} at={unusedAt} onRetry={reloadUnused} />}
          {!unusedData ? (
            unusedError && !unusedLoading ? (
              <div className="unused-worktrees">
                <UnusedHeading project={owner} />
                <div className="empty-state" data-unused-error="">
                  <Icon name="error" /> {tr(C.unusedListFailed, { error: unusedError })}
                  <button className="btn small" style={{ marginTop: 10 }} onClick={reloadUnused}>
                    <Icon name="refresh" /> {tr(C.retry)}
                  </button>
                </div>
              </div>
            ) : (
              <div className="unused-worktrees">
                <UnusedHeading project={owner} />
                <div className="empty-state" data-unused-loading="">
                  <Icon name="loading" spin /> {tr(C.lookingBody)}
                  <p className="hint">{tr(C.lookingHint, { project: owner.name })}</p>
                </div>
              </div>
            )
          ) : (
            <>
              {unusedLoading && (
                <div className="hint unused-refreshing" data-unused-refreshing="">
                  <Icon name="loading" spin /> {tr(C.checkingAgain)}
                </div>
              )}
              <UnusedWorktreesSection project={owner} data={unusedData} reload={reloadUnused} onOpen={(path) => choose(unusedRoot(path))} />
            </>
          )}
        </div>
      </ChangesSplit>
    )
  }

  if (!status && statusError) {
    return (
      <div className="empty-state">
        <Icon name="error" /> {tr(C.readFailed, { error: statusError })}
        <button className="btn small" style={{ marginTop: 10 }} onClick={load}>
          <Icon name="refresh" /> {tr(C.retry)}
        </button>
      </div>
    )
  }
  if (!status) return <div className="empty-state"><Icon name="loading" spin />{tr(M.loading)}</div>
  if (status.gitProblem) return gitMissing(status.gitProblem, load)
  if (!status.isRepo) {
    return (
      <div className="empty-state" style={{ paddingTop: '15vh' }}>
        <Icon name="source-control" />
        {tr(C.notRepo, { project: project.name })}
        <p className="hint">{tr(C.initHint)}</p>
        {project === owner && <InitRepoButton project={owner} small />}
      </div>
    )
  }
  return (
    <ChangesSplit listWidth={listWidth}>
      <div className="split-list">
        <PaneResizer paneKey="changes" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(C.changes)} <span className="badge" style={{ marginLeft: 6 }}>{status.files.length}</span>
          <div className="actions">
            {agent && !legacy && own?.branch && <IconButton icon="git-merge" action="merge-slot" title={tr(C.mergeBranch, { branch: own.branch })} onClick={() => set({ branchMergeFor: { project: owner.path, branch: own.branch! } })} />}
            {agent && legacy && <IconButton icon="git-merge" action="merge-agent" title={mergeBlocked(agent.name, agent.live?.status) ?? tr(C.mergeAgent, { agent: agent.name })} disabled={!!mergeBlocked(agent.name, agent.live?.status)} onClick={() => set({ mergeFor: { project: owner.path, agentId: agent.id } })} />}
            {spare?.branch && !spare.check.removable && <IconButton icon="git-merge" action="merge-unused" title={tr(C.mergeBranch, { branch: spare.branch! })} onClick={() => set(spare.slot ? { branchMergeFor: { project: owner.path, branch: spare.branch! } } : { mergeFor: { project: owner.path, agentId: '', worktree: { path: spare.path, branch: spare.branch! } } })} />}
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={load} />
          </div>
        </div>
        {selector}
        {!spare && <UnusedWorkNotice project={owner} data={unusedData} />}
        {statusError && (
          <div className="banner warn">
            <Icon name="warning" /> {tr(C.refreshFailed, { error: statusError })}
            <button className="btn small" onClick={load}>
              {tr(C.retry)}
            </button>
          </div>
        )}
        <div className="muted" style={{ padding: '0 14px 8px', fontSize: 12 }}>
          <Icon name="git-branch" /> {status.branch} {whose && base ? <span className="faint">{tr(C.sinceLeft, { base: base ?? '' })}</span> : <>{status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}</>}
        </div>
        <div className="pane-body">
          {status.files.length === 0 && <div className="pane-empty">{agent && own?.branch ? tr(C.noAgentChanges, { branch: own.branch }) : agent ? tr(C.clean) : spare ? tr(C.nothingOn, { branch: unusedName(spare), base: base ?? '' }) : tr(C.clean)}</div>}
          {status.files.map((f) => (
            <Tooltip block key={f.path} content={tr(f.staged ? C.staged : C.unstaged, { status: tr(C.gitStatus, { status: f.status === '?' ? 'untracked' : f.status }), path: f.path })}>
              <div className={cx('row', file === f.path && 'selected')} data-path={f.path} style={{ width: '100%' }} onClick={() => setFile(f.path)}>
                <span className="label">{f.path.split('/').pop()}</span>
                <span className="desc" style={{ flex: 1, minWidth: 0 }}>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                <span className={cx('git-status', f.status === '?' ? 'U' : f.status)}>{f.status === '?' ? 'U' : f.status /* i18n-ignore: git's status letter */}</span>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="split-main">
        {about}
        {diff ? (
          <>
            <div className="editor-toolbar">
              <Icon name="git-compare" />
              <span className="path">
                <strong>{diff.path}</strong> <span className="faint">{whose ? `${base} ↔ ${whose}` : tr(C.headWorkingTree)}</span>
              </span>
              <IconButton icon={inline ? 'split-horizontal' : 'list-flat'} title={tr(inline ? C.sideBySide : C.inline)} onClick={() => setInline(!inline)} />
              <IconButton icon="go-to-file" title={tr(C.openFile)} onClick={() => void actions.attempt(tr(C.openFailed), () => call('changes:openFile', root, diff.path))} />
            </div>
            {/* A refresh of the shown file failed: its last diff stays, but it may be out of date. */}
            {diffError && (
              <div className="banner warn">
                <Icon name="warning" /> {tr(C.diffStale, { error: diffError })}
                <button className="btn small" onClick={() => setDiffTry((n) => n + 1)}>
                  {tr(C.retry)}
                </button>
              </div>
            )}
            <div className="editor-host">
              {diff.binary ? (
                <div className="empty-state">{diff.modified || tr(C.binary)}</div>
              ) : (
                <DiffView original={diff.original} modified={diff.modified} language={languageFor(diff.path)} inline={inline} />
              )}
            </div>
          </>
        ) : diffError ? (
          <div className="empty-state">
            <Icon name="error" /> {tr(C.diffFailed, { error: diffError })}
            <button className="btn small" style={{ marginTop: 10 }} onClick={() => setDiffTry((n) => n + 1)}>
              <Icon name="refresh" /> {tr(C.retry)}
            </button>
          </div>
        ) : file ? (
          <div className="empty-state">
            <Icon name="loading" spin /> {tr(C.loadingDiff)}
          </div>
        ) : (
          <div className="empty-state">{tr(C.selectFile)}</div>
        )}
      </div>
    </ChangesSplit>
  )
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const memoryTip = (s: MemorySource): string => {
  const name = providerName(s.provider)
  return tr(s.kind === 'local-md' ? C.memLocal : s.kind === 'auto-memory' ? C.memAuto : C.memProject, { provider: name })
}

const NO_SOURCES: MemorySource[] = []

export function MemoryTab({ project }: { project: ProjectInfo }) {
  const listWidth = usePaneSize('memory', 280)
  // This project's files only: another project's never show (or open for editing) here, even while this one loads.
  const memory = useScopedLoad<MemorySource[]>(project.path)
  const sources = memory.data ?? NO_SOURCES
  const error = memory.error
  const [selected, setSelected] = useState<string | null>(null)
  const { load: loadScoped } = memory
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('memory:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load])
  // Start on the first file that exists.
  useEffect(() => {
    const s = memory.data
    const first = s?.find((x) => x.exists) ?? s?.[0]
    if (first) setSelected((cur) => cur ?? `${first.provider}:${first.id}`)
  }, [memory.data])
  const sel = sources.find((s) => `${s.provider}:${s.id}` === selected)
  // One pair of groups per provider the project uses (or, with none yet, every enabled provider).
  const settings = useStore((s) => s.settings)
  const used = new Set(project.agents.map((a) => agentProviderOf(a)))
  const providers = PROVIDERS.filter((p) => used.has(p.id) || (isProviderEnabled(settings, p.id) && sources.some((s) => s.provider === p.id && s.exists)))
  // With agents of more than one provider: one shared AGENTS.md instead of a file per CLI.
  const usedIds = [...used].sort()
  const [shared, setShared] = useState(true)
  useEffect(() => {
    if (usedIds.length < 2) return setShared(true)
    // Only decides whether to offer sharing one AGENTS.md: unknown, it isn't offered.
    void call('memory:instructionsShared', project.path, usedIds).then(setShared).catch(() => setShared(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, usedIds.join(), sources])
  const share = async (): Promise<void> => {
    const names = fmt.list(usedIds.map((id) => providerName(id)))
    const importers = PROVIDERS.filter((p) => used.has(p.id) && p.instructionsImport && p.instructionsFile !== 'AGENTS.md')
    // Sentences, each a message of its own.
    const detail = [
      ...importers.map((p) => tr(C.shareImport, { file: p.instructionsFile, line: p.instructionsImport ?? '', provider: p.name })),
      tr(C.shareMoves),
      ...(sources.some((x) => x.id === 'project-dot' && x.exists) ? [tr(C.shareDot)] : []),
      tr(C.shareNext)
    ].join(' ')
    const ok = await confirm({ title: tr(C.shareTitle), message: tr(C.shareMessage, { providers: names }), detail, confirmLabel: tr(C.share) })
    if (!ok) return
    const written = await actions.attempt(tr(C.shareFailed), () => call('memory:shareInstructions', project.path, usedIds))
    if (written) {
      notify('success', tr(C.shared), written.length ? tr(C.updated, { files: fmt.list(written, 'unit') }) : undefined)
      load()
    }
  }
  const groups: [string, MemorySource[], boolean][] = providers.flatMap((p): [string, MemorySource[], boolean][] => [
    [tr(C.groupInstructions, { provider: p.name }), sources.filter((s) => s.provider === p.id && s.kind !== 'auto-memory'), false],
    [tr(C.groupMemory, { provider: p.name }), sources.filter((s) => s.provider === p.id && s.kind === 'auto-memory'), true]
  ])
  return (
    <div className="split">
      <div className="split-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="memory" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(C.memoryHeading)}
          <div className="actions">
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={load} />
          </div>
        </div>
        {error && memory.data && <StaleNote what={tr(C.memoryTarget)} error={error} at={memory.at} onRetry={load} />}
        <div className="pane-body">
          {error && !memory.data && <LoadFailed inline what={tr(C.memoryTarget)} error={error} onRetry={load} />}
          {!error && !memory.data && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(M.loading)}
            </div>
          )}
          {!shared && (
            <div className="memory-share">
              <Icon name="info" /> {tr(C.ownFile)}
              <button className="btn subtle small" onClick={() => void share()}>
                {tr(C.shareButton)}
              </button>
            </div>
          )}
          {memory.data &&
            groups.map(([title, list, isMemory]) => (
            <div key={title}>
              <div className="section-header" style={{ cursor: 'default' }}>{title}</div>
              {list.length === 0 && <div className="pane-empty" style={{ paddingTop: 6 }}>{isMemory ? tr(C.nothingSaved) : ''}</div>}
              {list.map((s) => (
                <Tooltip block key={`${s.provider}:${s.id}`} content={<span style={{ whiteSpace: 'pre-line' }}>{`${memoryTip(s)}\n${s.path}`}</span>}>
                  <div className={cx('row', selected === `${s.provider}:${s.id}` && 'selected')} data-path={s.path} style={{ width: '100%' }} onClick={() => setSelected(`${s.provider}:${s.id}`)}>
                    <Icon name={s.kind === 'auto-memory' ? 'lightbulb' : 'book'} />
                    <span className="label" style={!s.exists ? { color: 'var(--fg-faint)' } : undefined}>{s.label}</span>
                    {!s.exists && <span className="desc">{tr(C.create)}</span>}
                  </div>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
      </div>
      {sel ? (
        <DocEditor
          key={sel.path}
          path={sel.path}
          title={sel.label}
          createIfMissing={sel.exists ? undefined : instructionsStarter(project.name, providerName(sel.provider))}
          onSaved={load}
        />
      ) : (
        <div className="split-main">
          <div className="empty-state">{tr(C.selectFileMem)}</div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project skills & MCP
// ---------------------------------------------------------------------------

function ChangesApplyNote({ project }: { project: ProjectInfo }) {
  return (
    <p className="hint">{tr(C.applyNew, { live: project.live ? 'yes' : 'no' })}</p>
  )
}

export function ProjectSkillsTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.skillsVersion)
  const settings = useStore((s) => s.settings)
  const listWidth = usePaneSize('projectSkills', 320)
  // This project's skills only. A failed read: said, with Retry (and this project's skills from before, if any),
  // rather than looking like no skills.
  const loaded = useScopedLoad<SkillInfo[]>(project.path)
  const skills = loaded.data
  const error = loaded.error
  const [selected, setSelected] = useState<string | null>(null)
  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('skills:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load, version])

  const providers = PROVIDERS.filter((p) => isProviderEnabled(settings, p.id))
  const ids = providers.map((p) => p.id)
  // One provider's skills at a time (#118): the one last shown for this project, else the CLI of the first usable
  // connection (HI-2121, decision A: what a new agent runs), else the first turned on.
  const key = project.path.toLowerCase()
  const remembered = useStore((s) => s.skillsProvider[key])
  const connections = useConnections()
  const cliFound = useStore((s) => s.providers)
  const fallback = connectionCli(connections, firstReadyConnection(connections, settings, cliReadyOf(cliFound)).id)
  const shown = providers.find((p) => p.id === remembered) ?? providers.find((p) => p.id === fallback) ?? providers[0]
  const showProvider = (id: ProviderId): void => rememberProjectPref('skillsProvider', key, id)
  // Hive skills (the workspace's, the same in every project) start open at the top; the provider's skills folded under
  // the dropdown. Opening or folding either is remembered for the project (Darren, 5 Oct).
  const fold = useStore((s) => s.skillsFold[key])
  const combworkOpen = fold?.combwork ?? true
  const providerOpen = fold?.provider ?? false
  const setFold = (patch: { combwork?: boolean; provider?: boolean }): void => rememberProjectPref('skillsFold', key, { combwork: combworkOpen, provider: providerOpen, ...patch })
  const setCombworkOpen = (open: boolean): void => setFold({ combwork: open })
  const all = skills ?? []
  // This project's agents get the Hive skills for them; those for the Assistant alone are left out, and counted.
  const combwork = all.filter((s) => s.level === 'combwork' && s.audience !== 'assistant')
  const assistantOnly = all.filter((s) => s.level === 'combwork' && s.audience === 'assistant').length
  const current = selected ? all.find((s) => s.path === selected) : undefined

  const add = async (mode: 'new' | 'file', provider: ProviderId): Promise<void> => {
    const r = await addSkill(mode, { kind: 'local', projectPath: project.path, provider }, otherLocal(project.path, provider, ids))
    if (r) setSelected(r.path)
  }
  const row = (sk: SkillInfo, actionsFor?: React.ReactNode, delivered?: React.ReactNode) => <SkillRow key={sk.path} skill={sk} selected={selected === sk.path} onSelect={() => setSelected(sk.path)} actionsFor={actionsFor} delivered={delivered} />
  const group = (title: string, tip: string, items: SkillInfo[], extra?: React.ReactNode, empty?: string) => (
    <>
      <div className="skill-group">
        {title} <InfoTip text={tip} />
        {extra && <div className="actions">{extra}</div>}
      </div>
      {items.length === 0 && empty && <div className="pane-empty">{empty}</div>}
    </>
  )

  return (
    <div className="split">
      <div className="split-list skills-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="projectSkills" max={600} />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(C.skillsHeading)}
          <div className="actions">
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={load} />
          </div>
        </div>
        {error && skills && <StaleNote what={tr(C.skillsTarget)} error={error} at={loaded.at} onRetry={load} />}
        <div className="pane-body">
          {error && !skills && <LoadFailed inline what={tr(C.skillsTarget)} error={error} onRetry={load} />}
          {!error && !skills && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(M.loading)}
            </div>
          )}
          {skills && (
            <div className="skill-group skill-group-toggle" role="button" tabIndex={0} aria-expanded={combworkOpen} onClick={() => setCombworkOpen(!combworkOpen)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setCombworkOpen(!combworkOpen))}>
              <Icon name={combworkOpen ? 'chevron-down' : 'chevron-right'} /> {tr(C.combworkGroup)} <span className="count">{combwork.length}</span> <InfoTip text={SKILL_LEVEL_TIP.combwork} />
            </div>
          )}
          {skills && combworkOpen && combwork.length === 0 && <div className="pane-empty">{tr(C.noCombworkSkills)}</div>}
          {combworkOpen &&
            combwork.map((sk) =>
              row(
                sk,
                <IconButton icon="go-to-file" title={tr(C.editInWorkspace)} onClick={() => editInWorkspace(sk)} />,
                !sk.problem && sk.bundled !== 'missing' ? <DeliveredSwitch skill={sk} projectPath={project.path} /> : undefined
              )
            )}
          {skills && combworkOpen && combwork.length > 0 && <div className="pane-empty skills-delivered-note">{tr(C.deliveredNote)}</div>}
          {skills && combworkOpen && assistantOnly > 0 && (
            <div className="pane-empty assistant-only-note">
              {sentences(tr(C.assistantOnly, { count: assistantOnly }), <a onClick={() => showView('skills')}>{tr(C.seeThem)}</a>)}
            </div>
          )}
          {skills && providers.length > 0 && (
            <div className="skill-provider-pick">
              <select className="select" aria-label={tr(C.showSkillsOf)} value={shown?.id ?? ''} onChange={(e) => showProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({all.filter((sk) => sk.provider === p.id).length})
                  </option>
                ))}
              </select>
            </div>
          )}
          {skills &&
            providers.filter((p) => p.id === shown?.id).map((p) => {
            const mine = all.filter((sk) => sk.provider === p.id)
            const local = mine.filter((sk) => sk.level === 'local')
            const user = mine.filter((sk) => sk.level === 'machine')
            const plugin = mine.filter((sk) => sk.level === 'plugin')
            return (
              <div key={p.id} className="skill-provider">
                <div className="skill-group skill-group-toggle skill-provider-toggle" role="button" tabIndex={0} aria-expanded={providerOpen} onClick={() => setFold({ provider: !providerOpen })} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setFold({ provider: !providerOpen }))}>
                  <Icon name={providerOpen ? 'chevron-down' : 'chevron-right'} /> <ProviderIcon provider={p.id} /> {tr(C.providerSkills, { provider: p.name })} <span className="count">{mine.length}</span>
                </div>
                {providerOpen && (
                <>
                {group(
                  tr(C.local),
                  SKILL_LEVEL_TIP.local,
                  local,
                  <>
                    <IconButton icon="add" title={tr(C.newLocal, { provider: p.name })} onClick={() => void add('new', p.id)} />
                    <IconButton icon="file-add" title={tr(C.addLocal, { provider: p.name })} onClick={() => void add('file', p.id)} />
                  </>,
                  tr(C.noneLocal)
                )}
                {local.map((sk) => row(sk, <IconButton icon="trash" title={tr(C.deleteSkill)} onClick={() => void deleteSkill(sk).then((ok) => ok && selected === sk.path && setSelected(null))} />))}
                {group(tr(C.user), SKILL_LEVEL_TIP.machine, user, undefined, tr(C.noneUser))}
                {user.map((sk) => row(sk))}
                {plugin.length > 0 && group(tr(C.plugins), SKILL_LEVEL_TIP.plugin, plugin)}
                {plugin.map((sk) => row(sk))}
                </>
                )}
              </div>
            )
          })}
          {providers.length === 0 && <div className="pane-empty">{tr(C.turnOnProvider)}</div>}
        </div>
      </div>
      <div className="split-main">
        {current ? (
          <SkillDetail key={current.path} skill={current} where="project" projectPath={project.path} onDeleted={() => setSelected(null)} />
        ) : (
          <div className="empty-state" style={{ paddingTop: '14vh' }}>
            <Icon name="sparkle" />
            <div>{Children.toArray(tRich<React.ReactNode>(C.selectSkill, { b: bold }))}</div>
          </div>
        )}
      </div>
    </div>
  )
}

export function ProjectMcpTab({ project }: { project: ProjectInfo }) {
  const version = useStore((s) => s.skillsVersion)
  const settings = useStore((s) => s.settings)
  const api = useStore((s) => s.api)
  // The workspace's servers (the window's workspace): before they load, nothing is said about them.
  const wsPath = useStore((s) => s.workspace?.path ?? '')
  const loaded = useScopedLoad<McpServerInfo[]>(wsPath)
  const servers = loaded.data
  const error = loaded.error
  const { load: loadScoped } = loaded
  const load = useCallback(() => loadScoped(wsPath, () => call('mcp:list')), [wsPath, loadScoped])
  useEffect(load, [load, version])
  const combworkOn = !!(settings?.agentApi.enabled && settings.agentApi.provideCombworkMcp && api?.running)
  // Only the servers added here (HI-2059): a broken definition still named in its list stays, to be removed.
  const added = (servers ?? []).filter((m) => serverAddedIn({ ...m, def: m.def ?? {} }, project.path))
  // Which agents get a server, once any agent has a choice of its own (#537, Agent Settings → MCP servers).
  const choosing = project.agents.some((a) => agentChoosesMcp(a))
  const givenTo = (name: string): string | null => {
    if (!choosing) return null
    const to = project.agents.filter((a) => agentGetsMcp(a, name)).map((a) => a.name)
    return to.length === project.agents.length ? tr(C.givenAll) : to.length ? tr(C.givenTo, { agents: fmt.list(to, 'unit') }) : tr(C.givenNone)
  }
  return (
    <div className="scroll-page">
      <div className="page-narrow">
        <div className="flex mcp-section-head">
          <h2 className="section">{tr(C.mcpHeading)}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn small" data-action="mcp-add" disabled={!servers} onClick={() => void actions.addMcpServer(project)}>
            <Icon name="add" /> {tr(C.addServer)}
          </button>
        </div>
        <p className="hint">{tr(msg({ id: 'mcp.tab.hintAdded', defaultMessage: "The workspace's MCP servers this project's agents get. Add one from the workspace's servers; Remove takes it off this project only.", description: "Under Added servers in a project's MCP tab (HI-2059)." }))}</p>
        <ChangesApplyNote project={project} />
        {error && servers && <StaleNote what={tr(C.mcpTarget)} error={error} at={loaded.at} onRetry={load} />}
        {!servers ? (
          error ? (
            <LoadFailed inline what={tr(C.mcpTarget)} error={error} onRetry={load} />
          ) : (
            <p className="hint">
              <Icon name="loading" spin /> {tr(M.loading)}
            </p>
          )
        ) : servers.length === 0 ? (
          <p className="hint">
            {tr(C.noServers)} <a onClick={() => setActivity('mcp')}>{tr(C.manage)}</a>
          </p>
        ) : !added.length ? (
          <p className="hint" data-mcp-none-added="">
            {tr(C.noneAdded)}
          </p>
        ) : (
          <div className="toggle-list">
            {added.map((m) => {
              const given = givenTo(m.name)
              return (
                <div key={m.name} className="toggle-item" data-mcp={m.name}>
                  <Icon name={m.def?.url ? 'globe' : 'plug'} />
                  <div className="ti-text">
                    <div className="ti-name">
                      {m.name} {m.error && <span className="badge error">{tr(C.invalid)}</span>}
                    </div>
                    <div className="ti-desc">{actions.mcpErrorText(m) ?? m.def?.description ?? m.def?.command}</div>
                    {given && <div className="ti-desc">{given}</div>}
                  </div>
                  <button className="btn small subtle" data-action="mcp-remove" aria-label={tr(C.removeLabel, { name: m.name, project: project.name })} onClick={() => void actions.removeMcpServer(project, m)}>
                    {tr(C.remove)}
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {project.unmanagedMcp.length > 0 && (
          <>
            <h2 className="section">{tr(C.definedByProject)}</h2>
            <p className="hint">{tr(msg({ id: 'mcp.tab.projectDefinedAdded', defaultMessage: "These servers are in the project's own agent config (such as .mcp.json). Combwork starts sessions with only workspace servers, so they stay disabled until copied to the workspace, which adds them here.", description: "Under Defined by the project in a project's MCP tab (HI-2059: copying one to the workspace adds it to this project). Keep .mcp.json as it is." }))}</p>
            <div className="toggle-list">
              {project.unmanagedMcp.map((n) => (
                <div key={n} className="toggle-item disabled">
                  <Icon name="plug" />
                  <div className="ti-text">
                    <div className="ti-name">{n}</div>
                  </div>
                  <button className="btn small subtle" onClick={() => void actions.importProjectMcp(project.path, [n])}>
                    <Icon name="cloud-upload" /> {tr(C.copyToWorkspace)}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <h2 className="section">{tr(C.builtIn)}</h2>
        <div className="toggle-list">
          <div className="toggle-item">
            <Icon name="hubot" />
            <div className="ti-text">
              <div className="ti-name">{TOOLS_SERVER /* i18n-ignore: the server's name */}</div>
              <div className="ti-desc">{tr(C.combworkDesc)}</div>
            </div>
            <span className={cx('badge', combworkOn ? 'success' : '')}>{tr(combworkOn ? C.onAll : C.off)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

function SettingRow({ title, desc, tip, children, modified }: { title: string; desc: string; tip?: string; children: React.ReactNode; modified?: boolean }) {
  return (
    <div className="setting">
      <div className="s-text">
        <div className="s-title">
          {modified && <Tooltip content={tr(S.overrides)}><span className="modified" /></Tooltip>}
          {title} {tip && <InfoTip text={tip} />}
        </div>
        <div className="s-desc">{desc}</div>
      </div>
      <div className="s-control">{children}</div>
    </div>
  )
}

type ProjectSection = 'general' | 'agents' | 'sessions' | 'storage' | 'keys' | 'advanced'

const PROJECT_SECTION_ICONS: Record<string, string> = { general: 'settings-gear', agents: 'organization', sessions: 'history', storage: 'database', keys: 'keyboard', advanced: 'tools' }

// Each section's label and description are shown from its messages (text), in the window's language when it renders;
// label and desc stay the catalogue's English, for the Assistant's tools.
const PROJECT_SECTIONS: (SettingsSectionInfo & { id: ProjectSection; icon: string })[] = PROJECT_SETTINGS_SECTIONS.map((s) => ({ ...s, id: s.id as ProjectSection, icon: PROJECT_SECTION_ICONS[s.id] ?? 'blank' }))

/** A row's text from the settings catalog (settingsCatalog.ts), which Settings, Project Settings and the Assistant's settings tools share. */
function rowText(id: string): { title: string; desc: string; tip?: string; wide?: boolean } {
  const e = settingEntry(id)
  // i18n-ignore: an internal error (a row missing from the catalog), never a message the user reads
  if (!e) throw new Error(`No settings catalog entry ${id}`)
  // In the window's language, as Settings shows it (shownSetting); its English stays the Assistant's (settingsCatalog.ts).
  const shown = shownSetting(e)
  return { title: shown.title, desc: shown.desc, ...(shown.tip ? { tip: shown.tip } : {}), ...(e.wide ? { wide: true } : {}) }
}

interface ProjectSettingDef {
  section: ProjectSection
  key: string
  title: string
  desc: string
  tip?: string
  modified?: boolean
  wide?: boolean
  render: () => React.ReactNode
}

const CHOOSE_CONNECTIONS = msg({ id: 'project.agents.chooseConnections', defaultMessage: 'Choose Connections…', description: "Button on Project Settings → Agents (HI-2109): opens a dialog choosing the connections (named setups on accounts: model, effort, mode) of the project's agents, by role or one by one, nothing else changed." })

function AgentList({ project }: { project: ProjectInfo }) {
  const settings = useStore((s) => s.settings)
  // Its connection as a start resolves it (HI-2108, decision H), whose values its row sums up.
  const connections = useConnections()
  const connectionFor = (a: ProjectInfo['agents'][number], provider: ProviderId) => {
    const shown = connectionOf(a.connection, provider, undefined, connections)
    const id = shown?.desired.ok ? shown.desired.id : a.connection
    return id ? connections?.connectionRows?.find((c) => c.id === id) : undefined
  }
  const limit = useAgentLimit(project)
  return (
    <div className="agent-list">
      {project.agents.map((a) => {
        const provider = agentProviderOf(a)
        const conn = connectionFor(a, provider)
        // Its connection's values (its model, effort, context, mode), and its own MCP servers when it has a choice of them.
        const line = [(conn && connectionLine(connections, conn, settings)) || providerName(provider), agentChoosesMcp(a) ? tr(S.ownMcp, { servers: agentMcpText(a) }) : ''].filter(Boolean).join(' · ')
        const off = !isProviderEnabled(settings, provider)
        // Its 0.9 worktree's branch, else where it works (#1442: "in slot-b", "carried: hb2"), else the project folder.
        const own = legacyOf(a)
        const place = placeText(a.place)
        return (
          <div key={a.id} className={cx('agent-list-row', off && 'off')} data-agent={a.id}>
            <StatusDot live={a.live} active={project.active} />
            <Tooltip content={off ? tr(S.turnedOff, { provider: providerName(provider) }) : providerName(provider)}>
              <span>
                <ProviderIcon provider={provider} />
              </span>
            </Tooltip>
            <div className="grow">
              <div>
                <strong>{a.name}</strong>{' '}
                <span className="faint">{off ? tr(S.off, { provider: providerName(provider) }) : <ConnectionMark own={a.connection} provider={provider} launched={a.live?.launchedConnection} fallback={providerName(provider)} />}</span>{' '}
                {own ? (
                  <span className="agent-branch">
                    <Icon name="git-branch" /> {own.branch}
                  </span>
                ) : place ? (
                  <span className="faint agent-place" data-place={a.place.is}>
                    {place}
                  </span>
                ) : (
                  <span className="faint">{tr(S.projectFolder)}</span>
                )}
              </div>
              <div className="faint small">
                {line}
                {awayFromProject(a) && <> · {agentFolder(a)}</>}
              </div>
            </div>
            <IconButton icon="settings" title={tr(S.agentSettings)} onClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })} />
            {own && <IconButton icon="git-merge" title={mergeBlocked(a.name, a.live?.status) ?? tr(S.merge)} disabled={!!mergeBlocked(a.name, a.live?.status)} onClick={() => set({ mergeFor: { project: project.path, agentId: a.id } })} />}
            <IconButton icon="close" title={tr(S.remove)} className="act-remove" action="remove-agent" onClick={() => void actions.removeAgent(project.path, a.id)} />
          </div>
        )
      })}
      {/* At its Maximum agents (HI-2058): disabled, saying why and where it is raised. */}
      <Tooltip content={project.agents.length >= limit ? agentLimitText(tr, limit) : null}>
        <button className="btn subtle small" disabled={project.agents.length >= limit} onClick={() => set({ addAgentFor: project.path })}>
          <Icon name="add" /> {tr(S.addAgent)}
        </button>
      </Tooltip>
      {/* HI-2109: the template picker over these agents, changing only their connections. */}
      {project.agents.length > 0 && (
        <button className="btn subtle small" data-action="choose-connections" onClick={() => void actions.chooseConnections(project.path)}>
          <Icon name="plug" /> {tr(CHOOSE_CONNECTIONS)}
        </button>
      )}
    </div>
  )
}

/**
 * The project's key (#1221): typed and checked as it changes, saved with Enter, Change or leaving the box; its old keys
 * under it, which still find its cards. A board that can't be changed (read-only, waiting for its upgrade) shows it only.
 */
function ProjectKeyField({ project }: { project: ProjectInfo }) {
  const keys = useStore((s) => s.projectKeys.find((k) => k.projectPath.toLowerCase() === project.path.toLowerCase()) ?? null)
  const readOnly = useStore((s) => !!s.boardState?.readOnly)
  const [draft, setDraft] = useState(keys?.key ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(keys?.key ?? ''), [keys?.key])
  const k = draft.trim().toUpperCase()
  const changed = !!k && k !== keys?.key
  const problem = changed ? keyProblemText(k, project.path) : null
  const save = async (): Promise<void> => {
    if (!changed || problem || busy) return
    setBusy(true)
    const done = await actions.attempt(tr(S.keyFailed), () => call('project:setKey', project.path, k))
    setBusy(false)
    if (done) notify('success', tr(S.keyChanged, { key: done, old: keys?.key ?? '' }))
  }
  if (!keys) return <span className="faint">{tr(S.keyNone)}</span>
  return (
    <div className="project-key-field">
      <div className="flex">
        <input
          className={cx('input', 'mono', problem && 'invalid')}
          value={draft}
          maxLength={4}
          spellCheck={false}
          disabled={readOnly || busy}
          aria-label={tr(S.keyLabel)}
          aria-invalid={!!problem}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') setDraft(keys.key)
          }}
        />
        <button className="btn" disabled={!changed || !!problem || busy || readOnly} onClick={() => void save()}>
          {tr(S.keyChange)}
        </button>
      </div>
      {problem ? <div className="field-error">{problem}</div> : changed ? <div className="field-hint">{tr(S.keyWillAlias, { old: keys.key, key: k })}</div> : keys.aliases.length > 0 && <div className="field-hint">{tr(S.keyAliases, { keys: fmt.list(keys.aliases) })}</div>}
    </div>
  )
}

export function ProjectSettingsTab({ project }: { project: ProjectInfo }) {
  // Its sections and rows are formatted here: a change of language shows them in it at once.
  useLanguage()
  const settings = useStore((s) => s.settings)
  const [section, setSection] = useState<ProjectSection>('general')
  const [query, setQuery] = useState('')
  // Opened on a section from elsewhere (Settings → Workspace's Storage links).
  const jump = useStore((s) => s.projectSettingsJump)
  useEffect(() => {
    if (!jump || jump.project.toLowerCase() !== project.path.toLowerCase()) return
    if (PROJECT_SECTIONS.some((x) => x.id === jump.section)) setSection(jump.section as ProjectSection)
    setQuery('')
    set({ projectSettingsJump: null })
  }, [jump, project.path])
  const cfg = project.config
  // Its key, for Project key's example (#1221).
  const ownKey = useStore((s) => projectKeyOf(s, project.path))
  // Settings → Advanced's inbox switches, which this project's Inherit follows (#1432).
  const inboxGlobals: Record<InboxSwitch, boolean> = {
    checkpoints: useAdvancedValue<boolean>(INBOX_SWITCH_ID.checkpoints),
    stopContinuation: useAdvancedValue<boolean>(INBOX_SWITCH_ID.stopContinuation),
    idleWakes: useAdvancedValue<boolean>(INBOX_SWITCH_ID.idleWakes)
  }
  if (!settings) return null
  const update = async (patch: Partial<ProjectConfig>): Promise<void> => {
    await actions.attempt(tr(S.saveFailed), () => call('project:updateConfig', project.path, patch))
    await actions.refreshWorkspace()
  }
  const globalCompact = settings.sessions.compactSuggestTokens ? fmt.number(settings.sessions.compactSuggestTokens) : tr(S.never)
  const globalWarn = settings.sessions.transcriptWarnMB ? tr(S.megabytes, { count: settings.sessions.transcriptWarnMB }) : tr(S.never)
  const inherit = (value: string | number): string => tr(S.inherit, { value })

  const defs: ProjectSettingDef[] = [
    {
      section: 'general',
      key: 'key',
      ...rowText('project.key'),
      // Its example in this project's own key.
      desc: tr(PROJECT_KEY_DESC, { example: `${ownKey ?? 'AM'}-12` }),
      render: () => <ProjectKeyField project={project} />
    },
    {
      section: 'sessions',
      key: 'compactSuggestTokens',
      ...rowText('project.compactSuggestTokens'),
      modified: cfg.compactSuggestTokens !== null,
      render: () => (
        <NumberField
          value={cfg.compactSuggestTokens}
          min={1000}
          max={2000000}
          step={10000}
          label={tr(S.compactAbove)}
          inherit={inherit(globalCompact)}
          off={{ label: tr(S.neverChoice), restore: null }}
          onCommit={(v) => update({ compactSuggestTokens: v })}
        />
      )
    },
    {
      section: 'sessions',
      key: 'transcriptWarnMB',
      ...rowText('project.transcriptWarnMB'),
      modified: cfg.transcriptWarnMB !== null,
      render: () => (
        <NumberField
          value={cfg.transcriptWarnMB ?? null}
          min={1}
          max={2000}
          step={10}
          label={tr(S.warnOver)}
          inherit={inherit(globalWarn)}
          off={{ label: tr(S.neverChoice), restore: null }}
          onCommit={(v) => update({ transcriptWarnMB: v })}
        />
      )
    },
    {
      section: 'sessions',
      key: 'chime',
      ...rowText('project.chime'),
      modified: cfg.chime !== 'inherit',
      render: () => (
        <select className="select" value={cfg.chime} onChange={(e) => void update({ chime: e.target.value as ProjectConfig['chime'] })}>
          <option value="inherit">{inherit(tr(settings.notifications.chimeEnabled ? S.onLower : S.offLower))}</option>
          <option value="on">{tr(S.on)}</option>
          <option value="off">{tr(S.offChoice)}</option>
        </select>
      )
    },
    {
      // Suggest a fresh start (#1437): this project's own of Settings → Notifications'.
      section: 'sessions',
      key: 'suggestFreshStart',
      ...rowText('project.suggestFreshStart'),
      modified: (cfg.suggestFreshStart ?? 'inherit') !== 'inherit',
      render: () => (
        <select className="select" data-setting="suggestFreshStart" value={cfg.suggestFreshStart ?? 'inherit'} onChange={(e) => void update({ suggestFreshStart: e.target.value as ProjectConfig['suggestFreshStart'] })}>
          <option value="inherit">{inherit(tr(settings.notifications.suggestFreshStart !== false ? S.onLower : S.offLower))}</option>
          <option value="on">{tr(S.on)}</option>
          <option value="off">{tr(S.offChoice)}</option>
        </select>
      )
    },
    // Carrying on (#1432): this project's own of Settings → Advanced's inbox switches.
    ...INBOX_SWITCHES.map((which): ProjectSettingDef => {
      const key = INBOX_PROJECT_KEY[which]
      return {
        section: 'sessions',
        key,
        ...rowText(`project.${key}`),
        modified: cfg[key] !== 'inherit',
        render: () => (
          <select className="select" data-setting={key} value={cfg[key]} onChange={(e) => void update({ [key]: e.target.value as ProjectConfig[typeof key] })}>
            <option value="inherit">{inherit(tr(inboxGlobals[which] ? S.onLower : S.offLower))}</option>
            <option value="on">{tr(S.on)}</option>
            <option value="off">{tr(S.offChoice)}</option>
          </select>
        )
      }
    }),
    {
      section: 'storage',
      key: 'storage',
      ...rowText('project.storage'),
      wide: true,
      render: () => <StorageView path={project.path} />
    },
    {
      section: 'storage',
      key: 'cardAttachmentCleanup',
      ...rowText('project.cardAttachmentCleanup'),
      modified: cfg.cardAttachmentCleanup !== CARD_CLEANUP_DEFAULT,
      render: () => <CardCleanupSetting path={project.path} name={project.name} value={cfg.cardAttachmentCleanup} onChange={(v) => void update({ cardAttachmentCleanup: v })} />
    },
    {
      section: 'keys',
      key: 'keybindings',
      ...rowText('project.keybindings'),
      wide: true,
      render: () => <KeybindingsEditor project={project} />
    },
    {
      section: 'agents',
      key: 'agents',
      ...rowText('project.agents'),
      wide: true,
      render: () => <AgentList project={project} />
    },
    {
      section: 'advanced',
      key: 'metadata',
      ...rowText('project.metadata'),
      render: () => (
        <button className="btn subtle" onClick={() => void call('app:openPath', `${project.path}\\.combwork`)}>
          <Icon name="folder-opened" /> {tr(S.openCombwork)}
        </button>
      )
    },
    {
      section: 'advanced',
      key: 'reset',
      ...rowText('project.reset'),
      render: () => (
        <button
          className="btn subtle"
          onClick={async () => {
            if (await confirm({ title: tr(S.resetTitle), message: tr(S.resetMessage), confirmLabel: tr(S.reset) }))
              void update({ chime: 'inherit', suggestFreshStart: 'inherit', inboxCheckpoints: 'inherit', inboxStopContinuation: 'inherit', inboxIdleWakes: 'inherit', compactSuggestTokens: null, transcriptWarnMB: null, fileLocks: 'inherit', worktreeCopy: null, worktreeSetup: '', loopWakes: true, loopRounds: null, loopWaitHours: null, loopStepWaitMinutes: null })
          }}
        >
          <Icon name="discard" /> {tr(S.resetButton)}
        </button>
      )
    }
  ]

  const q = query.trim().toLowerCase()
  const visible = defs.filter((d) => (q ? `${d.title} ${d.desc} ${d.tip ?? ''} ${d.key}`.toLowerCase().includes(q) : d.section === section))
  const sections = PROJECT_SECTIONS
  const groups = sections.map((s) => ({ ...s, items: visible.filter((d) => d.section === s.id) })).filter((g) => g.items.length)

  return (
    <div className="settings">
      <div className="settings-top">
        <Icon name="search" />
        <SearchInput placeholder={tr(S.search, { project: project.name })} value={query} onChange={setQuery} />
        <a
          className="muted"
          onClick={() => {
            set({ settingsSection: 'providers' })
            setActivity('settings')
          }}
        >
          {tr(S.global)}
        </a>
      </div>
      <CombworkVcsNotice project={project} />
      <div className="settings-body">
        <SectionNav
          items={sections.map((s) => ({ id: s.id, icon: s.provider ? <ProviderIcon provider={s.provider} /> : <Icon name={s.icon} />, label: shownText(s.text.label), sub: !!s.provider }))}
          selected={!q ? section : null}
          onSelect={(id) => {
            setSection(id as typeof section)
            setQuery('')
          }}
        />
        <div className="settings-content">
          {groups.length === 0 && <div className="empty-state">{tr(S.noMatch)}</div>}
          {groups.map((g) => (
            <div key={g.id} className="settings-group">
              <h2>{shownText(g.text.label)}</h2>
              <p>{shownText(g.text.desc)}</p>
              {g.items.map((d) =>
                d.wide ? (
                  <div key={d.key} className="setting wide">
                    <div className="s-text">
                      <div className="s-title">{d.title}</div>
                      <div className="s-desc">{d.desc}</div>
                      {d.render()}
                    </div>
                  </div>
                ) : (
                  <SettingRow key={d.key} title={d.title} desc={d.desc} tip={d.tip} modified={d.modified}>
                    {d.render()}
                  </SettingRow>
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
