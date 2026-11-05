/**
 * The Combwork tools the Combwork Assistant gets, by how far it may act (Settings → Assistant → Control). The hive MCP
 * server offers these and Claude Code runs them without asking (they're Combwork's own, already limited by the
 * control level and checked again by the Agent API). No imports: cw-mcp.js runs outside the app bundle.
 */

export type AssistantControlLevel = 'look' | 'agents' | 'projects'

/** Tools that only read: every Assistant (and, for the first ones, every agent) has them. */
export const ASSISTANT_READ_TOOLS = [
  'cw_list_settings',
  'cw_read_setting',
  'cw_list_projects',
  'cw_project_status',
  'cw_session_usage',
  'cw_list_shared_notes',
  'cw_read_shared_note',
  'cw_doc_outline',
  'cw_read_section',
  'cw_read_latest_handover',
  'cw_list_skills',
  'cw_agent_activity',
  'cw_wait_for_agents',
  'cw_list_providers',
  'cw_list_tasks',
  'cw_read_task',
  'cw_read_attachment',
  'cw_wait_for_tasks',
  'cw_inbox',
  // Offered only while Settings → Agent API lets agents read the developer console (#636).
  'cw_console'
]

/** Running agents: add, change, start, stop, prompt, leave a message (#530); and turning projects on and off. Starting a board card runs an agent too. */
export const ASSISTANT_AGENT_TOOLS = ['cw_activate_project', 'cw_add_agent', 'cw_update_agent', 'cw_start_agent', 'cw_stop_agent', 'cw_prompt_agent', 'cw_message_agent', 'cw_hand_over', 'cw_start_task']

/** Changing the task board: every agent has these; the Assistant at the control level that runs agents. */
export const TASK_TOOLS = ['cw_create_task', 'cw_update_task', 'cw_update_tasks', 'cw_reorder_tasks']

/**
 * A card's intents (#1267, SPEC §16.8.1), Combwork moving the card: every agent has these, the Assistant at the control level
 * that runs agents. Starting a card oneself is an agent's (the Assistant starts cards on agents: cw_start_task).
 */
export const INTENT_TOOLS = ['cw_put_back', 'cw_submit', 'cw_declare_paths', 'cw_start_review', 'cw_verdict', 'cw_report_merge', 'cw_ask_user', 'cw_cannot_within_rules', 'cw_request_builder', 'cw_loop_step']

/**
 * Lanes (#483): every Assistant lists them (a read, #500: "which lanes are running?" at Look too); starting, joining and
 * ending one need Control agents, which the Agent API checks (assistantChange), and the tool's description says.
 */
export const ASSISTANT_LANE_TOOLS = ['cw_lane']

/**
 * The merge queue (#1353): every Assistant lists it (a read, as lanes); pause, resume, remove and retry need Control
 * agents, which the Agent API checks (assistantChange), and the tool's description says. Project agents only list.
 */
export const ASSISTANT_QUEUE_TOOLS = ['cw_queue']

/**
 * Release Slot (#1561): every Assistant lists what a project has to release (a read); releasing a carried slot or a held
 * writer needs Control agents, which the Agent API checks (assistantChange). Project agents don't get it: releasing is
 * the user's, and the Assistant's once the user agrees.
 */
export const ASSISTANT_SLOT_TOOLS = ['cw_release_slot']

/**
 * Pausing the team before an update (HI-2081): every Assistant reads its workspace's pause and what still runs; pausing
 * and resuming need Control agents, which the Agent API checks (assistantChange). Project agents don't get it.
 */
export const ASSISTANT_TEAM_TOOLS = ['cw_team']

/**
 * Templates (HI-1502): every Assistant lists them and plans a load (reads); loading one needs Control agents, which the
 * Agent API checks (assistantChange). Project agents don't get it: loading a template is the user's in the window.
 */
export const ASSISTANT_TEMPLATE_TOOLS = ['cw_template']

/**
 * Undoing its own changes (#1282, SPEC §16.14): the Assistant at the control level that runs agents (the Agent API checks
 * it, and that a change is its own: only its own are kept).
 */
export const ASSISTANT_UNDO_TOOLS = ['cw_undo']

/**
 * Connections (HI-2108): every Assistant lists them (a read: which one cw_add_agent names); making or changing one
 * needs Settings → Assistant → Control → Change settings, which the Agent API checks, and the tool's description says.
 * Project agents don't get it.
 */
export const ASSISTANT_CONNECTION_TOOLS = ['cw_connection']

/** Creating projects. */
export const ASSISTANT_PROJECT_TOOLS = ['cw_create_project']

/** Changing Combwork's settings: only with Settings → Assistant → Control → Change settings on, whatever the level. */
export const ASSISTANT_SETTINGS_TOOLS = ['cw_update_setting']

/** The Assistant's journal (#1031): offered only while Settings → Assistant → Journal is on (at its start). */
export const JOURNAL_TOOLS = ['cw_journal_write', 'cw_journal_recall', 'cw_journal_entry', 'cw_journal_update']

/**
 * Tools only project agents have (the Assistant doesn't get them): the merge slot is held by an agent's own launch; a card
 * is started by the agent that works on it; an agent asks the Assistant on a card (HI-1866).
 */
export const AGENT_ONLY_TOOLS = ['cw_merge_slot', 'cw_start_card', 'cw_ask_assistant']

/** Tools only the Assistant has (project agents don't get them). cw_wait_for_agents isn't one: an agent waits on its project's agents too (#416). */
export const ASSISTANT_ONLY_TOOLS = ['cw_agent_activity', 'cw_list_providers', 'cw_list_settings', 'cw_read_setting', ...ASSISTANT_AGENT_TOOLS, ...ASSISTANT_SLOT_TOOLS, ...ASSISTANT_TEAM_TOOLS, ...ASSISTANT_TEMPLATE_TOOLS, ...ASSISTANT_CONNECTION_TOOLS, ...ASSISTANT_UNDO_TOOLS, ...ASSISTANT_PROJECT_TOOLS, ...ASSISTANT_SETTINGS_TOOLS, ...JOURNAL_TOOLS]

const RANK: Record<AssistantControlLevel, number> = { look: 0, agents: 1, projects: 2 }

/** Whether a control level allows what needs `need`. */
export function controlAllows(level: AssistantControlLevel | string | undefined, need: AssistantControlLevel): boolean {
  return (RANK[level as AssistantControlLevel] ?? RANK.projects) >= RANK[need]
}

/** The tools an Assistant with this control level (and Change settings, its journal, on or off) may use without asking. */
export function assistantTools(level: AssistantControlLevel | string | undefined, changeSettings = false, journal = false): string[] {
  return [...(journal ? JOURNAL_TOOLS : []), ...ASSISTANT_READ_TOOLS, ...ASSISTANT_LANE_TOOLS, ...ASSISTANT_QUEUE_TOOLS, ...ASSISTANT_SLOT_TOOLS, ...ASSISTANT_TEAM_TOOLS, ...ASSISTANT_TEMPLATE_TOOLS, ...ASSISTANT_CONNECTION_TOOLS, ...(controlAllows(level, 'agents') ? [...ASSISTANT_AGENT_TOOLS, ...TASK_TOOLS, ...INTENT_TOOLS, ...ASSISTANT_UNDO_TOOLS] : []), ...(controlAllows(level, 'projects') ? ASSISTANT_PROJECT_TOOLS : []), ...(changeSettings ? ASSISTANT_SETTINGS_TOOLS : [])]
}

/**
 * The name agents see Combwork's own MCP server by (HI-2463, Darren's decision): `mcp__combwork__cw_inbox` in Claude
 * Code, `combwork-cw_inbox` in Copilot, `[mcp_servers.combwork]` in Codex. Reserved: no workspace server may take it.
 */
export const TOOLS_SERVER = 'combwork'

/** Whether a name is the reserved server name, Combwork's own (case-insensitive, as servers' names are compared). */
export const isReservedServerName = (name: string): boolean => name.trim().toLowerCase() === TOOLS_SERVER

/** Every tool the combwork MCP server has (a test checks it against cw-mcp.ts): the only tool names metrics record. */
export const CW_TOOLS: readonly string[] = [
  'cw_list_projects', 'cw_project_status', 'cw_session_usage', 'cw_list_shared_notes', 'cw_read_shared_note', 'cw_write_shared_note', 'cw_doc_outline', 'cw_read_section',
  'cw_read_latest_handover', 'cw_create_handover', 'cw_notify', 'cw_list_providers', 'cw_agent_activity', 'cw_wait_for_agents',
  'cw_create_project', 'cw_activate_project', 'cw_add_agent', 'cw_update_agent', 'cw_start_agent', 'cw_stop_agent', 'cw_prompt_agent',
  'cw_message_agent', 'cw_hand_over', 'cw_list_tasks', 'cw_read_task', 'cw_read_attachment', 'cw_create_task', 'cw_update_task', 'cw_update_tasks', 'cw_reorder_tasks', 'cw_start_task', 'cw_list_skills', 'cw_wait_for_tasks',
  'cw_list_settings', 'cw_read_setting', 'cw_update_setting', 'cw_merge_slot', 'cw_lane', 'cw_queue', 'cw_release_slot', 'cw_team', 'cw_template', 'cw_connection', 'cw_inbox', 'cw_console',
  'cw_journal_write', 'cw_journal_recall', 'cw_journal_entry', 'cw_journal_update',
  'cw_start_card', ...INTENT_TOOLS, 'cw_focused_skip', 'cw_ask_assistant', 'cw_undo'
]
