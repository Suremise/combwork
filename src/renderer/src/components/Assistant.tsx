import { Children, useEffect, useRef, useState } from 'react'
import { ASSISTANT_AGENT_ID, DEFAULT_MODE, NEW_MODE_DESCRIPTION, assistantModeId } from '@shared/assistant'
import { assistantStatusLine } from '@shared/assistantStatus'
import { SHIPPED_MODE_DESCRIPTIONS, SHIPPED_MODE_NAMES } from '@shared/modeDescriptions'
import { AGENT_STATE_LABEL, agentState, boardExtras, type AgentState } from '@shared/agentState'
import { compactThreshold, isCompacting } from '@shared/defaults'
import { formatTime } from '@shared/dates'
import { agentOpenRun, runWords } from '@shared/progress'
import { columnName } from '@shared/tasks'
import { agentProvider, modeOption, providerDescriptor } from '@shared/providers'
import type { AgentInfo, AgentPatch, AssistantQuestion, Connection, ModeInfo, ProgressRun, ProjectInfo, ProviderId } from '@shared/types'
import { shownText } from '@shared/advanced'
import { withSnapshot } from '@shared/assistantChangeList'
import * as actions from '../actions'
import { freshShort, freshTip } from '../freshResume'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { legacyOf, placeText, placeTip } from '../agentPlace'
import { AssistantAccountBanner, cliReadyOf, ConnectionChoice, connectionCellText, connectionCli, firstUsableConnection, useConnections } from './ConnectionChoice'
import { assistantCli, assistantNeed } from '@shared/connectionLabel'
import { accountState } from '@shared/accounts'
import { agentProviderOf, cardLabelOf, confirm, get, notify, NO_PROJECTS, projectKey, revealAgent, runOnce, set, setActivity, setLoaded, setAssistantOpen, showAssistantView, showView, useDateStyle, useStarting, useStore, startingKey, startingLabel, assistantOnLeft, setAssistantSide } from '../store'
import { cardLabel } from '@shared/projectKeys'
import { loadAssistantChanges } from '../assistantUndo'
import { useInbox } from '../inbox'
import { useInboxSwitch } from '../advanced'
import { useLiveUsage } from '../usage'
import { cx, formatKeybinding, sessionLabel, timeAgo } from '../util'
import { stoppedLine, useStoppedEnd } from '../stopped'
import { PaneFooter, RESUME_TINT } from './AgentPanes'
import { AssistantChanges, useDoneCount } from './AssistantChanges'
import { AssistantMark } from './AssistantMark'
import { TaskChip, useAgentCards, useAgentReviews } from './CardChip'
import { PaneResizer, usePaneSize } from './Resizer'
import { StateMark } from './StateMark'
import { TerminalView } from './TerminalView'
import { Icon, IconButton, Modal, ReviewMark, statusText, Tooltip, useContextMenu, type MenuEntry } from './ui'
import { fmt, msg, tr, tRich } from '@shared/i18n'

/**
 * The Combwork Assistant's side panel: the workspace's overseer. Its header (mode, controls) and status line, what is
 * happening in the workspace, its terminal, its footer (model, mode, context, cost) and what it has done. Everything about the
 * Assistant is here, apart from managing modes (their own view) and its defaults (Settings → Assistant).
 */

const AGENT = ASSISTANT_AGENT_ID
// i18n-ignore: the name Combwork's own names for the Assistant's sessions start with (sessionLabel tells them apart), not text
const SESSION_NAMES = 'Assistant'

const M = {
  // Its inbox in ⋯ (#1432), as an agent's pane shows it.
  unreadCount: msg({ id: 'assistant.panel.unreadCount', defaultMessage: '{n, plural, one {# unread} other {# unread}}', description: "Read out with the Assistant's ⋯ button: how many items in its inbox it hasn't fetched or acked yet. Keep it short." }),
  inboxTip: msg({ id: 'assistant.panel.inboxTip', defaultMessage: "{n, plural, one {An item} other {# items}} in the Assistant's inbox that it hasn't fetched or acked yet: offered as its next line once it is idle, or read with cw_inbox.", description: "The heading of the Assistant's ⋯ menu's list of what it hasn't read in its inbox ({n}: how many). cw_inbox is a tool's name: keep it." }),
  inboxTipNoWakes: msg({ id: 'assistant.panel.inboxTipNoWakes', defaultMessage: "{n, plural, one {An item} other {# items}} in the Assistant's inbox that it hasn't fetched or acked yet", description: "The heading of the Assistant's ⋯ menu's list of what it hasn't read in its inbox, when the setting Wake an idle agent (Settings → Advanced) is off (a hint line under it says so; {n}: how many)." }),
  noWakesHint: msg({ id: 'assistant.panel.noWakesHint', defaultMessage: 'Wake an idle agent is off, so nothing is typed by itself. Deliver Now types the line once.', description: "A hint line under the heading of the Assistant's ⋯ menu's list of its unread inbox, when the setting Wake an idle agent (Settings → Advanced) is off. Wake an idle agent names a setting and Deliver Now a menu item below: use their names as Combwork shows them." }),
  inboxLine: msg({ id: 'assistant.panel.inboxLine', defaultMessage: '{id} · {from}: {text}', description: "An item of the Assistant's inbox in its ⋯ menu: its id, who it is from ({from}) and the start of its text ({text}). No preposition before the name (glossary §1 rule 4)." }),
  deliverNow: msg({ id: 'assistant.panel.deliverNow', defaultMessage: 'Deliver Now', description: "Menu item in the Assistant's ⋯ menu, shown while the setting Wake an idle agent is off: types the line telling it of what waits in its inbox into its terminal, once." }),
  deliverFailed: msg({ id: 'assistant.panel.deliverFailed', defaultMessage: "Could not deliver the Assistant's inbox", description: "An error's title: typing the line that tells the Assistant of what waits in its inbox (Deliver Now) failed." }),
  notDelivered: msg({ id: 'assistant.panel.notDelivered', defaultMessage: "The Assistant wasn't told now", description: "A notice's title: Deliver Now couldn't type the line into the Assistant's terminal now." }),
  notDeliveredDetail: msg({ id: 'assistant.panel.notDeliveredDetail', defaultMessage: "It isn't idle, or you are typing in its terminal. What waits stays in its inbox: try again once it's idle.", description: 'The detail of the notice that Deliver Now could not type the line into the Assistant now.' }),
  resumeLater: msg({ id: 'assistant.panel.resumeLater', defaultMessage: "You can resume the current conversation later from the Assistant's ⋯ menu.", description: "Under a confirmation that restarts the Assistant. ⋯ is the panel's More button." }),
  restartButton: msg({ id: 'assistant.panel.restartButton', defaultMessage: 'Restart the Assistant', description: "A confirmation's button: stops the Assistant and starts a new conversation." }),
  stopFailed: msg({ id: 'assistant.panel.stopFailed', defaultMessage: 'Could not stop the Assistant', description: "An error notice: the Assistant's session couldn't be stopped; the reason follows." }),
  saveFailed: msg({ id: 'assistant.panel.saveFailed', defaultMessage: "Could not save the Assistant's settings", description: "An error notice: the Assistant Settings dialog's choices couldn't be saved; the reason follows." }),
  switchFailed: msg({ id: 'assistant.panel.switchFailed', defaultMessage: 'Could not switch the mode', description: "An error notice: the Assistant's mode couldn't be switched; the reason follows." }),
  modeTitle: msg({ id: 'assistant.panel.modeTitle', defaultMessage: 'Mode: {name}', description: "A notice after the Assistant's mode was switched ({name}: the mode, Advisor…)." }),
  modeTold: msg({ id: 'assistant.panel.modeTold', defaultMessage: 'The Assistant has been told, in this conversation.', description: 'Under Mode: …, when the running Assistant was told at once.' }),
  modeLater: msg({ id: 'assistant.panel.modeLater', defaultMessage: 'The Assistant will be told as soon as it has finished what it is doing.', description: 'Under Mode: …, when the Assistant is busy.' }),
  restartTitle: msg({ id: 'assistant.panel.restartTitle', defaultMessage: 'Restart in {name} mode?', description: 'Confirmation before Restart in This Mode ({name}: the mode).' }),
  restartMessage: msg({ id: 'assistant.panel.restartMessage', defaultMessage: "The Assistant stops and resumes this conversation with the {name} mode's full instructions.", description: 'Confirmation before Restart in This Mode ({name}: the mode).' }),
  restartDetail: msg({ id: 'assistant.panel.restartDetail', defaultMessage: 'The whole conversation is cached again, which costs more than switching (switching keeps everything and only tells the Assistant the mode).', description: 'Confirmation before Restart in This Mode.' }),
  restart: msg({ id: 'assistant.panel.restart', defaultMessage: 'Restart', description: "Restart in This Mode's confirmation: its button." }),
  saveModeFailed: msg({ id: 'assistant.panel.saveModeFailed', defaultMessage: 'Could not save the mode', description: "An error notice: Restart in This Mode couldn't save the mode; the reason follows." }),
  transcriptAdvice: msg({ id: 'assistant.panel.transcriptAdvice', defaultMessage: 'Start a new conversation (⋯ → New Conversation) to keep things quick.', description: "The Assistant's footer, in the tooltip of a long conversation's size. ⋯ is the More button; New Conversation its menu item." }),
  settingsName: msg({ id: 'assistant.panel.settingsName', defaultMessage: 'Assistant Settings', description: "The Assistant's footer: its settings button, and the Assistant Settings dialog's title." }),
  show: msg({ id: 'assistant.panel.show', defaultMessage: 'Show the Assistant', description: "The hidden Assistant panel's strip, for screen readers." }),
  showTip: msg({ id: 'assistant.panel.showTip', defaultMessage: '{hasKey, select, yes {Show the Assistant ({key})} other {Show the Assistant}}', description: 'Tooltip on the hidden Assistant panel\'s strip, with its shortcut ({key}: "Ctrl+Alt+I").' }),
  asking: msg({ id: 'assistant.panel.asking', defaultMessage: 'The Assistant is asking you something', description: "The hidden Assistant panel's bell: a question waits for you." }),
  statusTitle: msg({ id: 'assistant.panel.statusTitle', defaultMessage: '{running, select, yes {The Assistant: {status}} other {The Assistant is not running}}', description: "The Assistant's mark: what it is doing ({status}: Working, Waiting for you…)." }),
  railLabel: msg({ id: 'assistant.panel.railLabel', defaultMessage: 'Assistant', description: "The hidden Assistant panel's strip, written down it. Combwork's name stays as it is." }),
  resumeTip: msg({ id: 'assistant.panel.resumeTip', defaultMessage: 'Resume "{name}", {when}', description: 'Tooltip on Resume: the conversation and when it was last active ({when}: "3 hours ago").' }),
  resume: msg({ id: 'assistant.panel.resume', defaultMessage: 'Resume', description: "A button: resumes the Assistant's last conversation." }),
  ended: msg({ id: 'assistant.panel.ended', defaultMessage: 'The conversation has ended.', description: "The Assistant's panel after its conversation ended." }),
  new: msg({ id: 'assistant.panel.new', defaultMessage: 'New', description: 'A button after the conversation ended: starts a new one.' }),
  theAssistant: msg({ id: 'assistant.panel.theAssistant', defaultMessage: 'The Assistant', description: "The Assistant's name when its mode isn't known yet, at the start of a sentence; and who a no-guardrails mode would run as." }),
  watches: msg({ id: 'assistant.panel.watches', defaultMessage: '<b>{name}</b> watches over this workspace: ask it what the agents are doing, about any project, or for a plan or a review.', description: "The Assistant's panel before it starts. {name} is its mode (Overseer…) or The Assistant; <b> is bold." }),
  noEdits: msg({ id: 'assistant.panel.noEdits', defaultMessage: "It doesn't edit files itself. Within Settings → Assistant → Control, it can run agents for you and create projects; everything it does is listed here.", description: "The Assistant's panel before it starts. Keep the setting's path as Settings shows it." }),
  start: msg({ id: 'assistant.panel.start', defaultMessage: 'Start Assistant', description: "A button in the Assistant's panel before it starts." }),
  conversations: msg({ id: 'assistant.panel.conversations', defaultMessage: 'Conversations', description: "A button: a menu of the Assistant's past conversations." }),
  listFailed: msg({ id: 'assistant.panel.listFailed', defaultMessage: 'Could not list conversations', description: "An error notice: the Assistant's past conversations couldn't be listed; the reason follows." }),
  resumeOne: msg({ id: 'assistant.panel.resumeOne', defaultMessage: 'Resume a conversation', description: "The heading of the menu of the Assistant's past conversations." }),
  noConversations: msg({ id: 'assistant.panel.noConversations', defaultMessage: 'No conversations yet', description: "The menu of the Assistant's past conversations, when there are none." }),
  openNow: msg({ id: 'assistant.panel.openNow', defaultMessage: 'open now', description: "Beside a past conversation in the menu: it is the one running. Lower case: it follows when it was active." }),
  modeHeaderLive: msg({ id: 'assistant.panel.modeHeaderLive', defaultMessage: 'Mode (switches now, keeping the conversation)', description: "The heading of the Assistant's mode menu while it runs." }),
  modeHeader: msg({ id: 'assistant.panel.modeHeader', defaultMessage: 'Mode', description: "The heading of the Assistant's mode menu." }),
  restartInMode: msg({ id: 'assistant.panel.restartInMode', defaultMessage: 'Restart in This Mode…', description: "An item of the Assistant's mode menu: restarts it with the mode's full instructions." }),
  manageModes: msg({ id: 'assistant.panel.manageModes', defaultMessage: 'Manage Modes…', description: "The Assistant's mode and More menus: opens the modes in the Assistant view." }),
  compacting: msg({ id: 'assistant.panel.compacting', defaultMessage: 'Compacting the conversation…', description: 'Tooltip on Compact while the conversation is compacted.' }),
  nothingToCompact: msg({ id: 'assistant.panel.nothingToCompact', defaultMessage: 'Nothing to compact yet', description: 'Tooltip on Compact before anything was said.' }),
  compactRecommended: msg({ id: 'assistant.panel.compactRecommended', defaultMessage: 'Recommended: the context is over your threshold.', description: "The detail of Compact… in the Assistant's ⋯ menu once its context passes Settings → Assistant's Highlight Compact over." }),
  compactLater: msg({ id: 'assistant.panel.compactLater', defaultMessage: 'Compact once the Assistant has finished', description: 'Tooltip on Compact while the Assistant works.' }),
  compactMenu: msg({ id: 'assistant.panel.compactMenu', defaultMessage: 'Compact…', description: "The Assistant's More menu, in a narrow panel." }),
  stop: msg({ id: 'assistant.panel.stop', defaultMessage: 'Stop', description: "The Assistant's Stop button and menu item." }),
  newConversation: msg({ id: 'assistant.panel.newConversation', defaultMessage: 'New Conversation', description: "An item of the Assistant panel's More (⋯) menu: starts a new conversation." }),
  startMenu: msg({ id: 'assistant.panel.startMenu', defaultMessage: 'Start', description: "The Assistant's Start button and menu item." }),
  resumeMenu: msg({ id: 'assistant.panel.resumeMenu', defaultMessage: 'Resume', description: "An item of the Assistant panel's More (⋯) menu: resumes its last conversation." }),
  resumeConversation: msg({ id: 'assistant.panel.resumeConversation', defaultMessage: 'Resume a Conversation…', description: "An item of the Assistant panel's More (⋯) menu: a list of past conversations to resume." }),
  allConversations: msg({ id: 'assistant.panel.allConversations', defaultMessage: 'All Conversations…', description: "The Assistant's More menu: opens its conversations in the Assistant view." }),
  settingsMenu: msg({ id: 'assistant.panel.settingsMenu', defaultMessage: 'Assistant Settings…', description: "An item of the Assistant panel's More (⋯) menu: opens the Assistant Settings dialog." }),
  moveRight: msg({ id: 'assistant.panel.moveRight', defaultMessage: 'Move Panel to the Right', description: "An item of the Assistant panel's More (⋯) menu: moves the panel to the window's right side." }),
  moveLeft: msg({ id: 'assistant.panel.moveLeft', defaultMessage: 'Move Panel to the Left', description: "An item of the Assistant panel's More (⋯) menu: moves the panel to the window's left side." }),
  fold: msg({ id: 'assistant.panel.fold', defaultMessage: 'Fold the Assistant panel', description: "An item of the Assistant panel's More (⋯) menu, and its header's button: folds the panel to a strip at the window's edge; the Assistant keeps running. Fold as the Progress panel's button says it." }),
  foldTip: msg({ id: 'assistant.panel.foldTip', defaultMessage: '{hasKey, select, yes {Fold the Assistant panel ({key})} other {Fold the Assistant panel}}', description: 'Tooltip of the button in the Assistant panel\'s header that folds it to a strip at the window\'s edge, with its shortcut ({key}: "Ctrl+Alt+I").' }),
  nameTip: msg({ id: 'assistant.panel.nameTip', defaultMessage: 'Assistant · {provider}', description: "Tooltip of the Assistant's name on its panel's header: its coding agent ({provider}: \"Claude Code\"). Assistant as the panel's title says it." }),
  provider: msg({ id: 'assistant.panel.provider', defaultMessage: 'Coding agent: {provider}', description: "A line of an agent's tooltip in the Assistant's workspace section ({provider}: \"Claude Code\")." }),
  providerOn: msg({ id: 'assistant.panel.providerOn', defaultMessage: 'Coding agent: {provider} · {connection}', description: "A line of an agent's tooltip in the Assistant's workspace section, with Connections on (HI-1769): its CLI ({provider}: \"Claude Code\") and the connection it runs on or would start on ({connection}: \"Max 1\", with ⟳ when it runs on another than the one chosen, or why none can run it)." }),
  noneRunning: msg({ id: 'assistant.panel.noneRunning', defaultMessage: 'no agents running', description: "The Assistant's workspace section: a project none of whose agents run. Lower case." }),
  names: msg({ id: 'assistant.panel.names', defaultMessage: 'Show agent names', description: "The Assistant's workspace section: a toggle button that shows each agent's name beside its state mark, for screen readers." }),
  namesTip: msg({ id: 'assistant.panel.namesTip', defaultMessage: "{shown, select, yes {Show only the agents' state marks (names on hover)} other {Show the agents' names beside their state marks}}", description: "Tooltip of the toggle in the Assistant's workspace section: what clicking it does." }),
  title: msg({ id: 'assistant.panel.title', defaultMessage: 'Assistant', description: "The Assistant panel's title, beside its coding agent's icon. Keep it short." }),
  modeTip: msg({ id: 'assistant.panel.modeTip', defaultMessage: '{name}: {description}', description: "Tooltip on the Assistant's mode button: the mode and what it is for." }),
  chooseMode: msg({ id: 'assistant.panel.chooseMode', defaultMessage: 'Choose a mode', description: "Tooltip on the Assistant's mode button when it has none." }),
  stopTip: msg({ id: 'assistant.panel.stopTip', defaultMessage: 'Stop the Assistant (the conversation is kept)', description: "Tooltip on the Assistant panel's Stop button." }),
  startTip: msg({ id: 'assistant.panel.startTip', defaultMessage: 'Start the Assistant', description: "Tooltip on the Assistant's Start button." }),
  more: msg({ id: 'assistant.panel.more', defaultMessage: 'More', description: "The Assistant panel's ⋯ button, which opens its More menu." }),
  status: msg({ id: 'assistant.panel.status', defaultMessage: 'Status: {text}', description: "The Assistant's status line under its header ({text}: \"Working\", \"Waiting for #12 → Review\")." }),
  openCard: msg({ id: 'assistant.panel.openCard', defaultMessage: '{known, select, yes {Open card {number}, in {column}} other {Open card {number}}}', description: 'A card chip in the Assistant\'s status line, for screen readers ({number}: the card\'s name, its key, such as AM-12, or #12 for a card with none; {column}: "Review").' }),
  doneBy: msg({ id: 'assistant.panel.doneBy', defaultMessage: 'Done by the Assistant', description: "The heading of the list of what the Assistant did (a count follows)." }),
  markLabel: msg({ id: 'assistant.panel.markLabel', defaultMessage: '{name}: {state}{running, select, yes {{hasDetail, select, yes { · {detail}} other {}}} other { · not running}}', description: "An agent's state mark in the Assistant's workspace section: its name for screen readers and the first line of its tooltip. {state}: the state its mark draws (Working, Idle, Waiting for you, Stalled); {detail}: what it is doing, when that says more (\"e2e: 12 suites 4/12\"); \"not running\" while its session isn't. Lower case after the dot." }),
  workingOn: msg({ id: 'assistant.panel.workingOn', defaultMessage: 'Working on {number} {title}', description: "An agent's tooltip in the Assistant's overview: a card it works on ({number}: its name, its key, such as AM-12, or #12 for a card with none; {title}: its title)." }),
  reviewing: msg({ id: 'assistant.panel.reviewing', defaultMessage: 'Reviewing {number} {title}', description: "An agent's tooltip in the Assistant's overview: a card it reviews ({number}: its name, its key, such as AM-12, or #12 for a card with none; {title}: its title)." }),
  progress: msg({ id: 'assistant.panel.progress', defaultMessage: '{hasStep, select, yes {Progress: {run} ({step})} other {Progress: {run}}}', description: "An agent's tooltip in the Assistant's overview: its test run ({run}: \"e2e: 12 suites 4/12\"; {step}: what it is on)." }),
  ownWorktree: msg({ id: 'assistant.panel.worktree', defaultMessage: 'Worktree on {branch}', description: "An agent's tooltip in the Assistant's overview: its worktree's branch." }),
  noAgents: msg({ id: 'assistant.panel.noAgents', defaultMessage: 'no agents', description: "The Assistant's overview: a project with no agents. Lower case." }),
  running: msg({ id: 'assistant.panel.running', defaultMessage: '{count} running', description: "The Assistant's overview: how many of a folded project's agents run. Lower case." }),
  workspace: msg({ id: 'assistant.panel.workspace', defaultMessage: 'Workspace', description: "The heading of the Assistant's overview of the workspace." }),
  counts: msg({ id: 'assistant.panel.counts', defaultMessage: '{running} running · {projects, plural, one {# project} other {# projects}}', description: "Beside Workspace in the Assistant's overview." }),
  attention: msg({ id: 'assistant.panel.attention', defaultMessage: "{kind, select, waiting {is waiting for you} signin {needs you to sign in} question {has a question for you} error {was stopped by an error} failed {couldn't start} safeguard {changed models after a safeguard stop} other {has finished}}", description: "The Assistant's overview: what an agent that needs you is doing, after its project and name. Lower case: it follows them." }),
  attentionOpen: msg({ id: 'assistant.panel.attentionOpen', defaultMessage: '{dismiss, select, yes {Click to open {name} and dismiss} other {Click to open {name}}}', description: "Tooltip of a row in the Assistant's overview for an agent that needs you ({name}: the agent, or its project when it has one agent). \"and dismiss\" when going there also removes the row (it has finished)." }),
  attentionDismiss: msg({ id: 'assistant.panel.attentionDismiss', defaultMessage: 'Dismiss: {name} {kind, select, safeguard {changed models after a safeguard stop} other {has finished}}', description: "The × on a row in the Assistant's overview for an agent that has finished (its tooltip and name for screen readers): removes the row without going to the agent. {name}: the agent, or its project when it has one agent." }),
  noProjects: msg({ id: 'assistant.panel.noProjects', defaultMessage: 'No projects in this workspace yet.', description: "The Assistant's overview with no projects." }),
  inactive: msg({ id: 'assistant.panel.inactive', defaultMessage: '{count, plural, one {# inactive project} other {# inactive projects}}', description: "The Assistant's overview: a row that shows the inactive projects folded into it." }),
  restartQuestion: msg({ id: 'assistant.panel.restartQuestion', defaultMessage: 'Restart the Assistant?', description: "Confirmation before the Assistant's coding agent is changed." }),
  connectionRestart: msg({ id: 'assistant.panel.connectionRestart', defaultMessage: 'The Assistant restarts on the connection chosen and resumes this conversation.', description: "Confirmation before a running Assistant moves to another connection of the same coding agent CLI (HI-2108): it restarts in it and carries on the conversation." }),
  cliOwnConnection: msg({ id: 'assistant.panel.cliOwnConnection', defaultMessage: "its mode is the CLI's own setting, and the Assistant needs to know its mode", description: "Why a connection is greyed out in Assistant Settings' choice of connection (HI-2108): its permission mode is \"The CLI's own setting\" (Combwork passes none), and the Assistant's Control relies on knowing its mode. A clause, lower case." }),
  switching: msg({ id: 'assistant.panel.switching', defaultMessage: "Switching to {to} stops this conversation ({from} conversations can't move to another provider) and starts a new one.", description: "Confirmation before the Assistant's coding agent is changed ({to}, {from}: Claude Code, Codex…)." }),
  tellFailed: msg({ id: 'assistant.panel.tellFailed', defaultMessage: 'Could not tell the Assistant its mode', description: "An error notice: the running Assistant couldn't be told its new mode; the reason follows." }),
  cancel: msg({ id: 'assistant.panel.cancel', defaultMessage: 'Cancel', description: "The Assistant Settings dialog's button that closes it without saving." }),
  save: msg({ id: 'assistant.panel.save', defaultMessage: 'Save', description: "The Assistant Settings dialog's button that saves the choices." }),
  forWorkspace: msg({ id: 'assistant.panel.forWorkspace', defaultMessage: 'For this workspace. Its connection holds its model, effort and permission mode; a mode left at <i>Default</i> follows <link>Settings → Assistant</link>.', description: 'Assistant Settings, at the top (HI-2108). <i> is italic (the choice Default of the Mode list); <link> opens Settings → Assistant.' }),
  mode: msg({ id: 'assistant.panel.mode', defaultMessage: 'Mode', description: "Assistant Settings: the mode's label." }),
  defaultMode: msg({ id: 'assistant.panel.defaultMode', defaultMessage: 'Default ({name})', description: "Assistant Settings: the mode that follows Settings → Assistant ({name}: that mode)." }),
  codingAgent: msg({ id: 'assistant.panel.codingAgent', defaultMessage: 'Coding agent', description: 'Assistant Settings: a heading (Claude Code, Codex…).' }),
  settings: msg({ id: 'assistant.panel.settings', defaultMessage: 'Settings', description: 'Assistant Settings: the heading over model, effort, mode and context.' }),
  default: msg({ id: 'assistant.panel.default', defaultMessage: 'Default', description: "Assistant Settings: a model, effort, mode or context that follows Settings → Assistant (what it is follows in brackets)." }),
  appliesNext: msg({ id: 'assistant.panel.appliesNext', defaultMessage: 'Model, effort, mode and context apply when the Assistant next starts. A new mode is told to it at once; a new provider restarts it now (after asking).', description: 'Assistant Settings, at the bottom, while the Assistant runs.' })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>
const italic = (c: React.ReactNode[]): React.ReactNode => <em>{c}</em>
/** Assistant Settings' link to Settings → Assistant: the dialog closes and Settings opens there. */
const settingsLink = (c: React.ReactNode[]): React.ReactNode => (
  <a
    onClick={() => {
      set({ assistantSettingsOpen: false, settingsSection: 'assistant', settingsQuery: '' })
      setActivity('settings')
    }}
  >
    {c}
  </a>
)

/**
 * A mode's name in the window: one Combwork ships (SHIPPED_MODE_NAMES, #806), in the window's language while its file still
 * has Combwork's name for it; any other (the user's own, or one they renamed) as its file has it.
 */
export function modeName(p: Pick<ModeInfo, 'id' | 'name' | 'bundled'>): string {
  const shipped = p.bundled ? SHIPPED_MODE_NAMES[p.id] : undefined
  return shipped && p.name === shipped.defaultMessage ? tr(shipped) : p.name
}

/** What a mode is for, in the window: as modeName, one Combwork ships in the window's language while its file still has Combwork's words. */
export function modeDescription(p: Pick<ModeInfo, 'id' | 'description' | 'bundled'>): string {
  const shipped = p.bundled ? SHIPPED_MODE_DESCRIPTIONS[p.id] : undefined
  if (shipped && p.description === shipped.defaultMessage) return tr(shipped)
  // A new mode's description until the user writes one (#889).
  if (p.description === NEW_MODE_DESCRIPTION) return tr(msg({ id: 'assistant.modes.newDescription', defaultMessage: 'What this mode is for, in one line.', description: "A new mode of the Combwork Assistant's description, until the user writes one in its file: under its name in the mode menu and the Assistant view." }))
  return p.description
}

/** The workspace's modes, reloaded when they change. */
export function useModes(): ModeInfo[] {
  const version = useStore((s) => s.modesVersion)
  const ws = useStore((s) => s.workspace?.path)
  const [list, setList] = useState<ModeInfo[]>([])
  useEffect(() => {
    if (!ws) return setList([])
    // A newer load (another workspace, a change) replaces this one.
    let current = true
    void call('modes:list')
      .then((l) => current && setList(l))
      // Modes only add choices to the Assistant's menus: without them, it still works.
      .catch(() => current && setList([]))
    return () => {
      current = false
    }
  }, [version, ws])
  return list
}

/** Changes the Assistant's settings for this workspace; a change that needs a new conversation restarts it after asking. */
async function changeAssistant(patch: Omit<AgentPatch, 'name'>, restart: { title: string; message: string; resume?: boolean } | null): Promise<boolean> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  if (!a || !agent) return false
  const wasLive = !!agent.live && !!restart
  if (wasLive) {
    const ok = await confirm({ title: restart!.title, message: restart!.message, detail: tr(M.resumeLater), confirmLabel: tr(M.restartButton) })
    if (!ok) return false
    await actions.attempt(tr(M.stopFailed), () => call('session:stop', a.path, AGENT))
    await actions.waitForStop(a.path, AGENT)
  }
  const done = await actions.attempt(tr(M.saveFailed), () => call('agents:update', a.path, AGENT, patch))
  await actions.refreshWorkspace()
  if (done && wasLive) await (restart!.resume ? actions.resumeLast(a.path, AGENT) : actions.newSession(a.path, AGENT))
  return !!done
}

/**
 * Makes a mode (a file in .combwork/modes) this workspace's Assistant's, at once and without a restart (#259): a running Assistant
 * is told in its conversation (now, or when it has finished what it is doing), which keeps its context; its next
 * launch starts in the mode.
 */
export async function chooseMode(p: Pick<ModeInfo, 'id' | 'name' | 'bundled'>): Promise<void> {
  const agent = get().workspace?.assistant?.agents[0]
  if (!agent) return
  if (assistantModeId(agent, get().settings) === p.id && agent.mode === p.id) return
  const how = await actions.attempt(tr(M.switchFailed), () => call('assistant:switchMode', p.id))
  await actions.refreshWorkspace()
  if (how === 'told') notify('info', tr(M.modeTitle, { name: modeName(p) }), tr(M.modeTold))
  else if (how === 'later') notify('info', tr(M.modeTitle, { name: modeName(p) }), tr(M.modeLater))
}

/**
 * Restart in This Mode: the Assistant stops and resumes the same conversation with the mode's full instructions (a
 * switch only tells it the mode's habits). Its whole conversation is cached again, so it asks first.
 */
export async function restartInMode(p: Pick<ModeInfo, 'id' | 'name' | 'bundled'>): Promise<void> {
  const a = get().workspace?.assistant
  const agent = a?.agents[0]
  const live = agent?.live
  if (!a || !agent || !live) return
  const ok = await confirm({
    title: tr(M.restartTitle, { name: modeName(p) }),
    message: tr(M.restartMessage, { name: modeName(p) }),
    detail: tr(M.restartDetail),
    confirmLabel: tr(M.restart)
  })
  if (!ok) return
  if (!(await actions.attempt(tr(M.saveModeFailed), () => call('agents:update', a.path, AGENT, { mode: p.id })))) return
  const item = (await call('session:list', a.path)).find((s) => s.id === live.sessionId)
  await actions.attempt(tr(M.stopFailed), () => call('session:stop', a.path, AGENT))
  await actions.waitForStop(a.path, AGENT)
  await actions.refreshWorkspace()
  await actions.resumeSession(a.path, { id: live.sessionId, recache: null, title: null, name: item?.name, agentId: AGENT, cwd: item?.cwd }, AGENT)
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function AssistantPanel() {
  const open = useStore((s) => s.assistantOpen)
  // On the left (Settings → Assistant → Panel side) it is resized from its right edge.
  const left = useStore(assistantOnLeft)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const epochs = useStore((s) => s.sessionEpoch)
  // Its terminal dimmed while it is stopped (HI-1881): not while it starts again, nor after a failed start.
  const notStopped = useStore((s) => {
    const host = s.workspace?.assistant?.path
    return !host || !!s.starting[startingKey(host, AGENT)] || !!s.startFailures[projectKey(host, AGENT)]
  })
  const flash = useStore((s) => (a && s.paneFlash?.key === projectKey(a.path, AGENT) ? s.paneFlash.at : 0))
  const width = usePaneSize('assistant', 430)
  // The overview's share of the height once dragged; until then it takes what it needs (up to a third).
  const topShare = useStore((s) => s.panes.assistantTop)
  const body = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // What the Assistant did and asks in this workspace (events keep them current).
  const ws = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!ws) return
    // Another workspace opened before this loaded: its own load is on the way.
    let current = true
    // Those told by events meanwhile are kept, never twice (HI-1863).
    void Promise.all([call('assistant:actions'), call('assistant:questions')]).then(([snapshot, assistantQuestions]) => current && setLoaded((s) => ({ assistantActions: withSnapshot(s.assistantActions, snapshot), assistantQuestions })))
    // Its changes kept for undo (#1283), by message.
    void loadAssistantChanges()
    return () => {
      current = false
    }
  }, [ws])
  if (!a) return null
  if (!open) return <AssistantRail a={a.agents[0] ?? null} />
  const agent = a.agents[0]
  if (!agent) return null
  const key = projectKey(a.path, AGENT)
  const hasTerminal = !!agent.live || epochs[key] !== undefined

  // The line between the workspace overview and the terminal: drag to share the height.
  const startSplit = (e: React.MouseEvent): void => {
    if (e.button !== 0 || !body.current) return
    e.preventDefault()
    const box = body.current.getBoundingClientRect()
    setDragging(true)
    document.body.classList.add('pane-resizing-v')
    const move = (ev: MouseEvent): void => {
      const share = Math.max(0.12, Math.min(0.7, (ev.clientY - box.top) / box.height))
      set((s) => ({ panes: { ...s.panes, assistantTop: share } }))
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing-v')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      void call('ui:setPane', 'assistantTop', get().panes.assistantTop ?? null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={cx('assistant-panel', left && 'on-left', !!flash && 'flash')} style={{ width }}>
      <PaneResizer paneKey="assistant" edge={left ? 'right' : 'left'} min={300} max={900} keep={380} />
      <AssistantHeader project={a} a={agent} />
      <AssistantStatus a={agent} />
      {!agent.live && <AssistantConnectionBanner a={agent} />}
      <AssistantQuestions />
      <AssistantActions />
      <div className="assistant-body" ref={body}>
        <div className={cx('assistant-top', topShare === undefined && 'auto')} style={topShare === undefined ? undefined : { height: `${topShare * 100}%` }}>
          <WorkspaceOverview />
        </div>
        <div
          className={cx('assistant-split', dragging && 'dragging')}
          onMouseDown={startSplit}
          onDoubleClick={() => {
            set((s) => {
              const panes = { ...s.panes }
              delete panes.assistantTop
              return { panes }
            })
            void call('ui:setPane', 'assistantTop', null)
          }}
        />
        <div className="assistant-terminal">
          {hasTerminal && (
            <TerminalView
              key={`${key}:${epochs[key] ?? 0}`}
              ptyKey={key}
              visible
              projectPath={a.path}
              agentId={AGENT}
              provider={agentProviderOf(agent)}
              autoFocus={!!agent.live}
              dimmed={!agent.live && !notStopped}
            />
          )}
          {!agent.live && <AssistantIdle project={a} a={agent} ended={hasTerminal} />}
        </div>
      </div>
      <div className="assistant-footer">
        <AssistantFooter project={a} a={agent} />
      </div>
    </div>
  )
}

/**
 * Asks for an account where the Assistant can't start without one (HI-1774; HI-2108): neither its connection nor its CLI's
 * first usable one can run it here. Not for a test copy on its CLI test home.
 */
function AssistantConnectionBanner({ a }: { a: AgentInfo }) {
  const view = useConnections()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  // HI-2899: the CLI it would really start on (an Assistant that names none: the first usable account's), and what's missing.
  const cli = useAssistantCli(a)
  const need = assistantNeed(a, cli, view, settings, cliReadyOf(providers), (x) => accountState(x) === 'signedOut')
  return need.kind === 'ok' ? null : <AssistantAccountBanner need={need} settingsLabel={tr(M.settingsMenu)} />
}

/** The Assistant's footer (its model, effort, connection): of the CLI it would really start on (HI-2899). */
function AssistantFooter({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const cli = useAssistantCli(a)
  return <PaneFooter project={project} a={a} onSettings={() => set({ assistantSettingsOpen: true })} onContext={() => undefined} onTranscript={() => undefined} transcriptAdvice={tr(M.transcriptAdvice)} settingsName={tr(M.settingsName)} provider={cli} />
}

/** The Assistant's CLI as its launch picks it (HI-2899, assistantCli): never Automatic's guess while an account would do. */
function useAssistantCli(a: AgentInfo): ProviderId {
  const view = useConnections()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  return assistantCli(a, view, settings, cliReadyOf(providers), agentProviderOf(a))
}

/** The hidden panel: a strip down the right edge; click it to show the panel. Its mark (#399) shows what the Assistant is doing. */
function AssistantRail({ a }: { a: AgentInfo | null }) {
  const kb = commandKeybinding('assistant.toggle')
  const live = a?.live
  const asking = useStore((s) => s.assistantQuestions.length)
  const left = useStore(assistantOnLeft)
  return (
    <div
      className={cx('assistant-rail', left && 'on-left')}
      role="button"
      tabIndex={0}
      aria-label={tr(M.show)}
      onClick={() => setAssistantOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setAssistantOpen(true)
        }
      }}
    >
      <Tooltip content={tr(M.showTip, { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' })}>
        <span className="rail-btn">
          <Icon name={left ? 'chevron-right' : 'chevron-left'} />
        </span>
      </Tooltip>
      {asking > 0 ? (
        <Icon name="bell-dot" className="assistant-rail-asking" title={tr(M.asking)} />
      ) : (
        <AssistantMark status={live?.status ?? 'stopped'} unseen={live?.unseen} title={tr(M.statusTitle, { running: live ? 'yes' : 'no', status: live ? statusText(live) : '' })} />
      )}
      <span className="assistant-rail-label">{tr(M.railLabel)}</span>
    </div>
  )
}

/** Shown while the Assistant isn't running: start it, or resume a conversation. */
function AssistantIdle({ project, a, ended }: { project: ProjectInfo; a: AgentInfo; ended: boolean }) {
  const settings = useStore((s) => s.settings)
  const modes = useModes()
  const modeId = assistantModeId(a, settings)
  const mode = modes.find((p) => p.id === modeId)
  const picker = useConversationPicker()
  // From the click until the Assistant runs (#1177).
  const starting = useStarting(project.path, AGENT)
  // Why and when it stopped (HI-1881), on its ended bar.
  const end = useStoppedEnd(project.path, a)
  const resuming = starting?.kind === 'resume'
  const startingNew = starting?.kind === 'start'
  const resume = a.resume ? (
    <button className={cx(/* i18n-ignore: class names */ 'btn small', RESUME_TINT)} disabled={!!starting} aria-busy={resuming || undefined} onClick={() => void actions.resumeLast(project.path, AGENT)} title={a.resume.fresh ? freshTip(a.resume.fresh, sessionLabel(a.resume, SESSION_NAMES)) : tr(M.resumeTip, { name: sessionLabel(a.resume, SESSION_NAMES), when: timeAgo(a.resume.lastActiveAt) })}>
      <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} /> {resuming ? startingLabel(starting) : tr(M.resume)}
    </button>
  ) : null
  if (ended) {
    return (
      <div className={cx('session-ended', 'compact', 'assistant-ended', !starting && 'stopped')} data-stopped={end?.why ?? (starting ? undefined : '')}>
        <Icon name={starting ? 'loading' : 'debug-disconnect'} spin={!!starting} />
        <span className="grow">{starting ? startingLabel(starting) : end ? stoppedLine(end) : tr(M.ended)}</span>
        {resume}
        <button className="btn act-start solid small" disabled={!!starting} aria-busy={startingNew || undefined} onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name={startingNew ? 'loading' : 'add'} spin={startingNew} /> {startingNew ? startingLabel(starting) : tr(M.new)}
        </button>
      </div>
    )
  }
  return (
    <div className="assistant-idle">
      <div className="assistant-idle-mark">{mode?.icon || '🐝'}</div>
      <p>
        {Children.toArray(tRich<React.ReactNode>(M.watches, { name: mode ? modeName(mode) : tr(M.theAssistant), b: bold }))}
      </p>
      <p className="faint">{tr(M.noEdits)}</p>
      <div className="btns">
        <button className="btn act-start solid" disabled={!!starting} aria-busy={startingNew || undefined} onClick={() => void actions.newSession(project.path, AGENT)}>
          <Icon name={startingNew ? 'loading' : 'play'} spin={startingNew} /> {startingNew ? startingLabel(starting) : tr(M.start)}
        </button>
        {resume}
        <button className="btn subtle small" disabled={!!starting} onClick={(e) => picker.openBelow(e.currentTarget, project)}>
          <Icon name="history" /> {tr(M.conversations)}
        </button>
      </div>
      {picker.element}
    </div>
  )
}

/** A menu of the Assistant's past conversations, newest first. */
function useConversationPicker() {
  const menu = useContextMenu()
  const openAt = async (project: ProjectInfo, x: number, y: number): Promise<void> => {
    const list = await actions.attempt(tr(M.listFailed), () => call('session:list', project.path))
    if (!list) return
    const open = project.agents[0]?.live?.sessionId
    const all = list.filter((s) => s.source === 'combwork' && !s.archived && !s.sub)
    const items: MenuEntry[] = [{ header: true, label: tr(M.resumeOne) }]
    if (!all.length) items.push({ label: tr(M.noConversations), disabled: true })
    for (const s of all.slice(0, 12)) {
      items.push({
        label: sessionLabel(s, SESSION_NAMES),
        detail: [timeAgo(s.lastActivity), s.id === open ? tr(M.openNow) : null, s.fresh && s.id !== open ? freshShort() : null, s.provider ? providerDescriptor(s.provider).name : null].filter(Boolean).join(' · '),
        icon: s.id === open ? 'circle-filled' : 'history',
        disabled: s.id === open,
        onClick: () => void actions.resumeSession(project.path, s, AGENT)
      })
    }
    menu.openAt(x, y, items)
  }
  const openBelow = (el: Element, project: ProjectInfo): void => {
    const r = el.getBoundingClientRect()
    void openAt(project, r.left, r.bottom + 2)
  }
  return { openAt, openBelow, element: menu.element }
}

/**
 * The panel's header, as an agent pane's (#977, #979): the Assistant's state mark, its name (its provider in the
 * tooltip), its mode as a pill (the mode menu), then Stop (Resume, or Start, while it isn't running) and ⋯ with
 * everything else: Compact…, its conversations, its settings and modes, the panel's side, Hide. The pill gives way
 * first; Stop and ⋯ never shrink.
 */
function AssistantHeader({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const settings = useStore((s) => s.settings)
  const left = useStore(assistantOnLeft)
  const modes = useModes()
  const menu = useContextMenu()
  const picker = useConversationPicker()
  const usage = useLiveUsage(project, AGENT)
  const starting = useStarting(project.path, AGENT)
  const live = a.live
  const wakes = useInboxSwitch('idleWakes', null)
  const idle = live && (live.status === 'ready' || live.status === 'finished')
  const empty = !usage || usage.userMessages === 0 || (usage.contextTokens ?? 0) === 0
  // Highlighted past Settings → Assistant's threshold (overlaid on its host's config), as an agent's past its project's.
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const suggested = threshold > 0 && (usage?.contextTokens ?? 0) >= threshold
  const modeId = assistantModeId(a, settings)
  const mode = modes.find((p) => p.id === modeId)

  const modeMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const current = modes.find((p) => p.id === modeId)
    menu.openAt(r.left, r.bottom + 2, [
      { header: true, label: tr(live ? M.modeHeaderLive : M.modeHeader) },
      ...modes
        .filter((p) => p.bundled !== 'missing')
        .map(
          (p): MenuEntry => ({
            label: `${p.icon ? `${p.icon}  ` : ''}${modeName(p)}`,
            detail: modeDescription(p),
            icon: p.id === modeId ? 'check' : undefined,
            onClick: () => void chooseMode(p)
          })
        ),
      { separator: true },
      ...(live && current ? [{ label: tr(M.restartInMode), icon: 'refresh', onClick: () => void restartInMode(current) } as MenuEntry] : []),
      { label: tr(M.manageModes), icon: 'person', onClick: () => showAssistantView('modes') }
    ])
  }
  const start = (): void => void actions.newSession(project.path, AGENT)
  const resume = (): void => void actions.resumeLast(project.path, AGENT)
  const resumeTip = a.resume?.fresh ? freshTip(a.resume.fresh, sessionLabel(a.resume, SESSION_NAMES)) : a.resume ? tr(M.resumeTip, { name: sessionLabel(a.resume, SESSION_NAMES), when: timeAgo(a.resume.lastActiveAt) }) : ''
  const stop = (): void => void actions.stopSession(project.path, AGENT)
  const compact = (): void => set({ compactFor: { project: project.path, agentId: AGENT } })
  const compacting = isCompacting(live)
  // Compact…'s detail in ⋯, as an agent's: why it is unavailable, or that it is recommended.
  const compactDetail = compacting ? tr(M.compacting) : !idle ? tr(M.compactLater) : empty ? tr(M.nothingToCompact) : suggested ? tr(M.compactRecommended) : undefined
  // Its inbox (#1432 round 1): what it hasn't read, as an agent's pane shows it; with Settings' idle wakes off (it has
  // no project of its own), nothing waiting is typed by itself, and Deliver Now types its line once.
  const unread = live?.inbox?.unread ?? []
  const waiting = unread.filter((m) => m.state === 'queued' || m.state === 'uncertain').length
  const deliver = (): void =>
    void actions.attempt(tr(M.deliverFailed), async () => {
      if (!(await call('session:deliverNow', project.path, AGENT))) notify('info', tr(M.notDelivered), tr(M.notDeliveredDetail))
    })
  const inboxEntries: MenuEntry[] = unread.length
    ? [
        { header: true, label: tr(wakes ? M.inboxTip : M.inboxTipNoWakes, { n: unread.length }) },
        ...(wakes ? [] : [{ label: tr(M.noWakesHint), disabled: true }]),
        ...unread.map((m) => ({ label: tr(M.inboxLine, { id: m.id, from: m.from, text: m.text }), disabled: true })),
        ...(waiting && !wakes && live ? [{ label: tr(M.deliverNow), icon: 'send', onClick: deliver } as MenuEntry] : []),
        { separator: true }
      ]
    : []
  /** Stop's place: an icon with a tooltip, in its action's colour, as on an agent's pane. */
  // A start or resume under way shows on its button, which takes no clicks (#1177).
  const btn = (icon: string, label: string, onClick: () => void, tone: string, tip: string, busy?: boolean) => (
    <Tooltip content={busy && starting ? startingLabel(starting) : tip}>
      <button type="button" className={cx(/* i18n-ignore: class names */ 'btn small pane-btn icon-only', tone)} disabled={busy} aria-busy={busy || undefined} aria-label={busy && starting ? startingLabel(starting) : label} onClick={onClick}>
        <Icon name={busy ? 'loading' : icon} spin={busy} />
      </button>
    </Tooltip>
  )
  const more = useRef<HTMLButtonElement>(null)
  const openMore = (keyboard: boolean): void => {
    const r = more.current?.getBoundingClientRect()
    if (!r) return
    const [x, y] = [r.left, r.bottom + 2]
    menu.openAt(
      x,
      y,
      [
        ...inboxEntries,
        // Compact… as on an agent's ⋯: once the Assistant has finished, recommended past the threshold.
        ...(live ? [{ label: tr(M.compactMenu), icon: compacting ? 'loading' : 'fold', detail: compactDetail, disabled: !idle || empty || compacting, onClick: compact } as MenuEntry] : []),
        // Stop's place has Resume while there is a conversation to go back to: a new one is here.
        live || a.resume ? { label: tr(M.newConversation), icon: 'add', action: 'start', disabled: !!starting, onClick: start } : { label: tr(M.startMenu), icon: 'play', action: 'start', disabled: !!starting, onClick: start },
        ...(live ? [] : [{ label: tr(M.resumeMenu), icon: 'debug-continue', action: 'resume', disabled: !a.resume || !!starting, onClick: resume } as MenuEntry]),
        { label: tr(M.resumeConversation), icon: 'history', action: 'resume', onClick: () => void picker.openAt(project, x, y) },
        { label: tr(M.allConversations), icon: 'comment-discussion', onClick: () => showAssistantView('conversations') },
        { separator: true },
        { label: tr(M.settingsMenu), icon: 'settings', onClick: () => set({ assistantSettingsOpen: true }) },
        { label: tr(M.manageModes), icon: 'person', onClick: () => showAssistantView('modes') },
        { separator: true },
        { label: tr(left ? M.moveRight : M.moveLeft), icon: left ? 'layout-sidebar-right' : 'layout-sidebar-left', onClick: () => void setAssistantSide(left ? 'right' : 'left') },
        { label: tr(M.fold), icon: left ? 'layout-sidebar-left-off' : 'layout-sidebar-right-off', keybinding: kb ? formatKeybinding(kb) : undefined, onClick: () => setAssistantOpen(false) }
      ],
      keyboard
    )
  }
  const kb = commandKeybinding('assistant.toggle')
  const provider = providerDescriptor(useAssistantCli(a)).name
  const state = agentState(live)
  return (
    <div className="assistant-header">
      <Tooltip content={tr(M.statusTitle, { running: live ? 'yes' : 'no', status: live ? statusText(live) : '' })}>
        <StateMark state={state} />
      </Tooltip>
      <Tooltip content={tr(M.nameTip, { provider })}>
        <span className="assistant-title">{tr(M.title)}</span>
      </Tooltip>
      <Tooltip content={mode ? tr(M.modeTip, { name: modeName(mode), description: modeDescription(mode) }) : tr(M.chooseMode)}>
        <button type="button" className="assistant-mode" aria-haspopup="menu" onClick={modeMenu}>
          {mode?.icon && <span className="assistant-mode-icon">{mode.icon}</span>}
          <span className="assistant-mode-name">{mode ? modeName(mode) : modeId}</span>
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      <div className="grow" />
      {live
        ? btn('stop-circle', tr(M.stop), stop, 'act-stop', tr(M.stopTip))
        : a.resume
          ? btn('debug-continue', tr(M.resume), resume, 'act-resume', resumeTip, !!starting)
          : btn('play', tr(M.startMenu), start, 'act-start', tr(M.startTip), !!starting)}
      <Tooltip content={tr(M.more)}>
        <button ref={more} type="button" className="icon-btn pane-more" aria-label={tr(M.more)} aria-description={unread.length ? tr(M.unreadCount, { n: unread.length }) : undefined} aria-haspopup="menu" onClick={(e) => openMore(e.detail === 0)}>
          <Icon name="ellipsis" />
          {unread.length > 0 && <span className="pane-more-badge" />}
        </button>
      </Tooltip>
      {/* Fold, as the Progress panel's header has it (#1330): its chevron points to the edge the panel folds to. */}
      <IconButton icon={left ? 'chevron-left' : 'chevron-right'} className="assistant-panel-fold" title={tr(M.foldTip, { hasKey: kb ? 'yes' : 'no', key: kb ? formatKeybinding(kb) : '' })} onClick={() => setAssistantOpen(false)} />
      {menu.element}
      {picker.element}
    </div>
  )
}

/** A question's text as the window shows it (HI-2449): in the language Combwork shows, or as Combwork sent it with none. */
const questionText = (q: AssistantQuestion, field: 'title' | 'message' | 'yes' | 'no'): string => (q.text ? shownText(q.text[field]) : q[field])

/** Questions the Assistant's actions wait on (e.g. stopping a busy agent): the user answers on the card. */
function AssistantQuestions() {
  const questions = useStore((s) => s.assistantQuestions)
  const answering = useStore((s) => s.running)
  if (!questions.length) return null
  return (
    <div className="assistant-questions">
      {questions.map((q) => (
        <div key={q.id} className="assistant-question" role="alertdialog" aria-label={questionText(q, 'title')}>
          <div className="assistant-question-title">
            <Icon name="question" /> {questionText(q, 'title')}
          </div>
          <div className="assistant-question-message">{questionText(q, 'message')}</div>
          <div className="assistant-question-buttons">
            {/* Answered once: a second click while the answer goes is ignored. */}
            <button className="btn small subtle" disabled={!!answering[`answer:${q.id}`]} onClick={() => void runOnce(`answer:${q.id}`, () => call('assistant:answer', q.id, false))}>
              {questionText(q, 'no')}
            </button>
            <button className="btn small danger" disabled={!!answering[`answer:${q.id}`]} onClick={() => void runOnce(`answer:${q.id}`, () => call('assistant:answer', q.id, true))}>
              {questionText(q, 'yes')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Whether a workspace's "Done by the Assistant" list is open (#979: closed until its link in the watch line opens it). */
const doneOpenKey = (ws: string): string => `assistant-done:${ws.toLowerCase()}`

/**
 * The watch line under the header (#312, #979): "Status: Working", "Status: Waiting for #12 #13 → Review (watch until
 * 22:22)", the attention colour when it needs you, and each card it waits for the card chip used everywhere (its column's
 * colour; a click opens it); cut short with "…" in a narrow panel, the whole line in its tooltip. At its end, once the
 * Assistant has done something, "Done by the Assistant (n)" opens and closes that list.
 */
function AssistantStatus({ a }: { a: AgentInfo }) {
  useDateStyle()
  const live = a.live
  // Combwork's own questions its actions wait on (the cards under this line): the user is wanted first.
  const approvals = useStore((s) => s.assistantQuestions)
  const tasks = useStore((s) => s.tasks)
  const done = useDoneCount()
  const ws = useStore((s) => s.workspace?.path ?? '')
  const open = useStore((s) => s.panes[doneOpenKey(ws)] === 1)
  const line = assistantStatusLine(live, (iso) => formatTime(iso), approvals.map((q) => questionText(q, 'title')))
  const whole = tr(M.status, { text: `${line.text}${line.cards.map((n) => cardLabelOf({ tasks }, n)).join(', ')}${line.after}` })
  const toggle = (): void => {
    const key = doneOpenKey(ws)
    set((s) => ({ panes: { ...s.panes, [key]: open ? 0 : 1 } }))
    void call('ui:setPane', key, open ? null : 1)
  }
  return (
    <div className={cx('assistant-status', line.tone)} data-tone={line.tone}>
      {live?.status === 'watching' && <Icon name="eye" />}
      <Tooltip content={whole}>
        <span className="assistant-status-text">
          {Children.toArray(
            tRich<React.ReactNode>(M.status, {
              text: (
                <>
                  {line.text}
                  {line.cards.map((n) => {
                    const card = tasks.find((c) => c.number === n && !c.archived) ?? null
                    return <TaskChip key={n} number={n} column={card?.column ?? null} short label={tr(M.openCard, { number: cardLabelOf({ tasks }, n), known: card ? 'yes' : 'no', column: card ? columnName(card.column, tr) : '' })} />
                  })}
                  {line.after}
                </>
              )
            })
          )}
        </span>
      </Tooltip>
      <ReviewMark live={live} />
      {done > 0 && (
        <button type="button" className="assistant-done-link" aria-expanded={open} onClick={toggle}>
          <AssistantMark />
          {tr(M.doneBy)} <span className="faint">({fmt.number(done)})</span>
        </button>
      )}
    </div>
  )
}

/**
 * What the Assistant did in this workspace, newest first, under the watch line (#312, #399), while its link there has it
 * open (#979): the last 3, Show all scrolls every one inside the same height.
 */
function AssistantActions() {
  const ws = useStore((s) => s.workspace?.path ?? '')
  const open = useStore((s) => s.panes[doneOpenKey(ws)] === 1)
  return open ? <AssistantChanges /> : null
}

/**
 * What an agent is doing, in a few words (#311): its status when it needs you, else its open progress run ("e2e: 12
 * suites 4/12"), else its status (background tasks, a card watch…). Nothing while it isn't running.
 */
function activityOf(live: AgentInfo['live'], run: ProgressRun | null): string | null {
  if (!live) return null
  const needsYou = live.status === 'waiting' || live.status === 'signin' || live.status === 'error' || !!live.question
  return run && !needsYou ? runWords(run) : statusText(live)
}

/**
 * One agent in the workspace section (#979): its state mark (#973), and its name beside it when the section shows names;
 * a click focuses it, switching project. Its tooltip has the rest: its name and provider, its status (or its test run),
 * every card it has in Doing or is reviewing, its progress and its worktree's branch.
 */
function OverviewAgent({ project: p, a, state, names, onGo }: { project: ProjectInfo; a: AgentInfo; state: AgentState; names: boolean; onGo: () => void }) {
  const doing = useAgentCards(p, a.id)
  const reviewing = useAgentReviews(p, a.id)
  const run = useStore((s) => agentOpenRun(s.progressRuns, p.path, a.id))
  const connections = useConnections()
  const activity = activityOf(a.live, run)
  // The state its mark draws first (the board's too: a stalled or blocked card), then what it is doing when that says more.
  const stateText = tr(AGENT_STATE_LABEL[state])
  const detail = activity && !activity.toLowerCase().startsWith(stateText.toLowerCase()) ? activity : ''
  // Its CLI, and the connection it runs on or would start on (HI-1769).
  const cli = providerDescriptor(agentProviderOf(a)).name
  const connection = connectionCellText(a.connection, agentProviderOf(a), a.live?.launchedConnection, connections)
  const first = tr(M.markLabel, { name: a.name, state: stateText, running: a.live ? 'yes' : 'no', hasDetail: detail ? 'yes' : 'no', detail })
  const rest = [
    connection ? tr(M.providerOn, { provider: cli, connection }) : tr(M.provider, { provider: cli }),
    ...doing.map((c) => tr(M.workingOn, { number: cardLabel(c), title: c.title })),
    ...reviewing.map((c) => tr(M.reviewing, { number: cardLabel(c), title: c.title })),
    ...(run ? [tr(M.progress, { run: runWords(run), hasStep: run.stepName ? 'yes' : 'no', step: run.stepName ?? '' })] : []),
    // Where it works (#1442): its 0.9 worktree's branch, else its slot, carried slot or home.
    ...(legacyOf(a) ? [tr(M.ownWorktree, { branch: legacyOf(a)!.branch })] : placeText(a.place) ? [placeTip(a.place)] : [])
  ]
  // The whole of it on keyboard focus too, and for screen readers: the name and state as its label, the rest as its description.
  return (
    <Tooltip focus content={<span style={{ whiteSpace: 'pre-line' }}>{[first, ...rest].join('\n')}</span>}>
      <button type="button" className={cx('assistant-agent', names && 'named')} data-agent={a.id} data-state={state} aria-label={first} aria-description={fmt.list(rest, 'unit')} onClick={onGo}>
        <StateMark state={state} decorative />
        {names && <span className="assistant-agent-name">{a.name}</span>}
      </button>
    </Tooltip>
  )
}

/**
 * A project in the workspace section, on one line (#979): its name (a click opens it), a state mark for each agent
 * running, or not running but waiting or stalled on the board (a card of its blocked on you, or in Doing with no one on
 * it), in the project's order so they stay put as states change, and how many run.
 */
function OverviewProject({ project: p, names, go }: { project: ProjectInfo; names: boolean; go: (p: ProjectInfo, id?: string) => void }) {
  const tasks = useStore((s) => s.tasks)
  const marks = p.agents.map((a) => ({ a, state: agentState(a.live, boardExtras(p.name, a, tasks)) })).filter(({ a, state }) => a.live || state !== 'idle')
  const running = p.agents.filter((a) => a.live).length
  return (
    <div className={cx('assistant-project', !p.active && 'inactive')} data-project={p.name}>
      <button type="button" className="assistant-project-name" onClick={() => go(p)}>
        {p.name}
      </button>
      <span className="assistant-marks">
        {marks.length === 0 && <span className="faint">{tr(p.agents.length ? M.noneRunning : M.noAgents)}</span>}
        {marks.map(({ a, state }) => (
          <OverviewAgent key={a.id} project={p} a={a} state={state} names={names} onGo={() => go(p, a.id)} />
        ))}
      </span>
      {running > 0 && <span className="faint assistant-project-count">{tr(M.running, { count: running })}</span>}
    </div>
  )
}

/** Whether a workspace's section shows its agents' names beside their marks (remembered per workspace; on hover only by default). */
const namesKey = (ws: string): string => `assistant-names:${ws.toLowerCase()}`

/** Whether a workspace's overview shows its inactive projects (remembered per workspace). */
const inactiveKey = (ws: string): string => `assistant-inactive:${ws.toLowerCase()}`

/**
 * What is happening in the workspace: agents needing you first, then a line per project with its agents' state marks
 * (#979). Click one to go to it. Inactive projects without a running agent fold into one row at the end.
 */
function WorkspaceOverview() {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const ws = useStore((s) => s.workspace?.path ?? '')
  const showInactive = useStore((s) => s.panes[inactiveKey(ws)] === 1)
  const toggleInactive = (): void => {
    const v = showInactive ? 0 : 1
    set((s) => ({ panes: { ...s.panes, [inactiveKey(ws)]: v } }))
    void call('ui:setPane', inactiveKey(ws), v)
  }
  const names = useStore((s) => s.panes[namesKey(ws)] === 1)
  const toggleNames = (): void => {
    set((s) => ({ panes: { ...s.panes, [namesKey(ws)]: names ? 0 : 1 } }))
    void call('ui:setPane', namesKey(ws), names ? null : 1)
  }
  const go = (p: ProjectInfo, id?: string): void => {
    set({ selectedProject: p.path })
    showView('projects')
    if (id) revealAgent(p, id)
  }
  // The inbox's agents that need you, oldest first, then (#1632: not a need, kept apart) those finished since you last
  // looked (the Assistant itself isn't listed in its own panel).
  const box = useInbox()
  const attention = [...box.needYou, ...box.finished].flatMap((i) => {
    const p = projects.find((x) => x.path === i.projectPath)
    const a = p?.agents.find((x) => x.id === i.agentId)
    return p && a ? [{ i, p, a }] : []
  })
  const running = projects.reduce((n, p) => n + p.agents.filter((a) => a.live).length, 0)
  const shown = projects.filter((p) => p.active || p.agents.some((a) => a.live))
  const folded = projects.filter((p) => !shown.includes(p))
  const row = (p: ProjectInfo) => <OverviewProject key={p.path} project={p} names={names} go={go} />
  return (
    <div className="assistant-overview">
      <div className="assistant-section-title">
        <span className="grow">{tr(M.workspace)}</span>
        <span className="faint">{tr(M.counts, { running, projects: projects.length })}</span>
        <Tooltip content={tr(M.namesTip, { shown: names ? 'yes' : 'no' })}>
          <button type="button" className={cx('icon-btn', 'assistant-names', names && 'on')} aria-label={tr(M.names)} aria-pressed={names} onClick={toggleNames}>
            <Icon name="tag" />
          </button>
        </Tooltip>
      </div>
      {attention.map(({ i, p, a }) => {
        // A finish (and a model switch after a safeguard stop) is dismissed by going there, or by its × (#1047).
        const dismiss = i.kind === 'finished' || i.kind === 'safeguard'
        const who = p.agents.length > 1 ? a.name : p.name
        const hint = tr(M.attentionOpen, { name: who, dismiss: dismiss ? 'yes' : 'no' })
        return (
          <div key={`${p.path}#${a.id}`} className="assistant-attention" data-agent={a.id}>
            <Tooltip content={hint} focus block>
              <button type="button" className="assistant-attention-open" aria-description={hint} onClick={() => go(p, a.id)}>
                <Icon name={i.kind === 'finished' ? 'check' : 'bell-dot'} />
                <span>
                  <strong>{p.name}</strong>
                  {p.agents.length > 1 ? ` · ${a.name}` : ''} {tr(M.attention, { kind: i.kind })}
                  {i.message ? `: ${i.message}` : ''}
                </span>
              </button>
            </Tooltip>
            {dismiss && <IconButton icon="close" className="assistant-attention-dismiss" title={tr(M.attentionDismiss, { name: who, kind: i.kind })} onClick={() => void call('session:markSeen', p.path, [a.id]).catch(() => undefined)} />}
          </div>
        )
      })}
      {projects.length === 0 && <div className="faint assistant-empty">{tr(M.noProjects)}</div>}
      {shown.map(row)}
      {folded.length > 0 && (
        <button type="button" className="assistant-fold" aria-expanded={showInactive} onClick={toggleInactive}>
          <Icon name={showInactive ? 'chevron-down' : 'chevron-right'} />
          {tr(M.inactive, { count: folded.length })}
        </button>
      )}
      {showInactive && folded.map(row)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant Settings: this workspace's choices, over Settings → Assistant
// ---------------------------------------------------------------------------

/**
 * Assistant Settings (HI-2108; HI-2105's design): this workspace's Assistant's connection (which holds its model, effort,
 * context and mode; its CLI follows from it) and its mode (Coordinator…). A connection in the CLI's own mode is greyed
 * out, saying why: the Assistant's Control relies on knowing its mode (#1284).
 */
export function AssistantSettingsDialog() {
  const openFlag = useStore((s) => s.assistantSettingsOpen)
  const a = useStore((s) => s.workspace?.assistant ?? null)
  const settings = useStore((s) => s.settings)
  const modes = useModes()
  const view = useConnections()
  const agent = a?.agents[0] ?? null
  const current: ProviderId = a && agent ? (agent.live?.provider ?? agentProvider(agent, settings)) : ''
  const [mode, setMode] = useState('')
  const [connection, setConnection] = useState('')
  useEffect(() => {
    setMode(agent?.mode ?? '')
    setConnection(agent?.connection ?? '')
    // Reset each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFlag])
  // None chosen yet (a new workspace's): the first usable in the order of accounts, as a new agent's (decision A).
  const providers = useStore((s) => s.providers)
  const first = firstUsableConnection(view, settings, cliReadyOf(providers))
  useEffect(() => {
    if (openFlag && !connection && first) setConnection(first)
  }, [openFlag, connection, first])
  if (!openFlag || !a || !agent) return null
  const close = (): void => set({ assistantSettingsOpen: false })
  const defaultMode = modes.find((p) => p.id === (settings?.assistant.mode || DEFAULT_MODE))
  const cliOf = (id: string): ProviderId => connectionCli(view, id) ?? current
  const cliOwn = (c: Pick<Connection, 'permissionMode'>, cli: ProviderId): boolean => !!c.permissionMode && !!modeOption(cli, c.permissionMode)?.cliOwn
  const save = async (): Promise<void> => {
    const cli = connection ? cliOf(connection) : current
    const connectionChanged = !!connection && connection !== agent.connection
    const modeChanged = assistantModeId({ mode }, settings) !== assistantModeId(agent, settings)
    const ok = await changeAssistant(
      { mode: mode || undefined, ...(connectionChanged ? { connection } : {}) },
      // Another connection is a restart (its model, mode or CLI), a running Assistant resuming in it; another CLI starts fresh.
      connectionChanged
        ? cli !== current
          ? { title: tr(M.restartQuestion), message: tr(M.switching, { to: providerDescriptor(cli).name, from: providerDescriptor(current).name }) }
          : { title: tr(M.restartQuestion), message: tr(M.connectionRestart), resume: true }
        : null
    )
    // A new mode needs no restart: the running Assistant is told it (#259).
    if (ok && modeChanged && !connectionChanged && agent.live) await actions.attempt(tr(M.tellFailed), () => call('assistant:switchMode', assistantModeId({ mode }, settings), false))
    if (ok) close()
  }
  return (
    <Modal
      title={tr(M.settingsName)}
      icon="settings"
      onClose={close}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(M.cancel)}
          </button>
          <button className="btn primary" onClick={() => void save()}>
            {tr(M.save)}
          </button>
        </>
      }
    >
      <p className="hint">
        {Children.toArray(
          tRich<React.ReactNode>(M.forWorkspace, {
            i: italic,
            link: settingsLink
          })
        )}
      </p>
      <div className="agent-form">
        <ConnectionChoice id="assistant-connection" value={connection} onChange={setConnection} unavailable={(c) => (cliOwn(c, cliOf(c.id)) ? tr(M.cliOwnConnection) : null)} />
        <label>{tr(M.mode)}</label>
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">{tr(M.defaultMode, { name: (defaultMode && modeName(defaultMode)) ?? settings?.assistant.mode ?? 'Overseer' /* i18n-ignore: the default mode's name, as Combwork ships it */ })}</option>
          {modes
            .filter((p) => p.bundled !== 'missing')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon ? `${p.icon} ` : ''}
                {modeName(p)}
              </option>
            ))}
        </select>
      </div>
      {agent.live && <div className="detail">{tr(M.appliesNext)}</div>}
    </Modal>
  )
}
