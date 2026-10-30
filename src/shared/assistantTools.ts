/**
 * The hive tools the Hive Assistant gets, by how far it may act (Settings → Assistant → Control). The hive MCP
 * server offers these and Claude Code runs them without asking (they're Hive's own, already limited by the
 * control level and checked again by the Agent API). No imports: hive-mcp.js runs outside the app bundle.
 */

export type AssistantControlLevel = 'look' | 'agents' | 'projects'

/** Tools that only read: every Assistant (and, for the first ones, every agent) has them. */
export const ASSISTANT_READ_TOOLS = [
  'hive_list_settings',
  'hive_read_setting',
  'hive_list_projects',
  'hive_project_status',
  'hive_session_usage',
  'hive_list_shared_notes',
  'hive_read_shared_note',
  'hive_doc_outline',
  'hive_read_section',
  'hive_read_latest_handover',
  'hive_list_skills',
  'hive_agent_activity',
  'hive_wait_for_agents',
  'hive_list_providers',
  'hive_list_tasks',
  'hive_read_task',
  'hive_read_attachment',
  'hive_wait_for_tasks',
  'hive_inbox',
  // Offered only while Settings → Agent API lets agents read the developer console (#636).
  'hive_console'
]

/** Running agents: add, change, start, stop, prompt, leave a message (#530); and turning projects on and off. Starting a board card runs an agent too. */
export const ASSISTANT_AGENT_TOOLS = ['hive_activate_project', 'hive_add_agent', 'hive_update_agent', 'hive_start_agent', 'hive_stop_agent', 'hive_prompt_agent', 'hive_message_agent', 'hive_hand_over', 'hive_start_task']

/** Changing the task board: every agent has these; the Assistant at the control level that runs agents. */
export const TASK_TOOLS = ['hive_create_task', 'hive_update_task', 'hive_update_tasks', 'hive_reorder_tasks']

/**
 * A card's intents (#1267, SPEC §16.8.1), Hive moving the card: every agent has these, the Assistant at the control level
 * that runs agents. Starting a card oneself is an agent's (the Assistant starts cards on agents: hive_start_task).
 */
export const INTENT_TOOLS = ['hive_put_back', 'hive_submit', 'hive_declare_paths', 'hive_start_review', 'hive_verdict', 'hive_report_merge', 'hive_ask_user', 'hive_cannot_within_rules', 'hive_request_builder', 'hive_loop_step']

/**
 * Lanes (#483): every Assistant lists them (a read, #500: "which lanes are running?" at Look too); starting, joining and
 * ending one need Control agents, which the Agent API checks (assistantChange), and the tool's description says.
 */
export const ASSISTANT_LANE_TOOLS = ['hive_lane']

/**
 * The merge queue (#1353): every Assistant lists it (a read, as lanes); pause, resume, remove and retry need Control
 * agents, which the Agent API checks (assistantChange), and the tool's description says. Project agents only list.
 */
export const ASSISTANT_QUEUE_TOOLS = ['hive_queue']

/**
 * Release Slot (#1561): every Assistant lists what a project has to release (a read); releasing a carried slot or a held
 * writer needs Control agents, which the Agent API checks (assistantChange). Project agents don't get it: releasing is
 * the user's, and the Assistant's once the user agrees.
 */
export const ASSISTANT_SLOT_TOOLS = ['hive_release_slot']

/**
 * Pausing the team before an update (HI-2081): every Assistant reads its workspace's pause and what still runs; pausing
 * and resuming need Control agents, which the Agent API checks (assistantChange). Project agents don't get it.
 */
export const ASSISTANT_TEAM_TOOLS = ['hive_team']

/**
 * Templates (HI-1502): every Assistant lists them and plans a load (reads); loading one needs Control agents, which the
 * Agent API checks (assistantChange). Project agents don't get it: loading a template is the user's in the window.
 */
export const ASSISTANT_TEMPLATE_TOOLS = ['hive_template']

/**
 * Undoing its own changes (#1282, SPEC §16.14): the Assistant at the control level that runs agents (the Agent API checks
 * it, and that a change is its own: only its own are kept).
 */
export const ASSISTANT_UNDO_TOOLS = ['hive_undo']

/**
 * Connections (HI-2108): every Assistant lists them (a read: which one hive_add_agent names); making or changing one
 * needs Settings → Assistant → Control → Change settings, which the Agent API checks, and the tool's description says.
 * Project agents don't get it.
 */
export const ASSISTANT_CONNECTION_TOOLS = ['hive_connection']

/** Creating projects. */
export const ASSISTANT_PROJECT_TOOLS = ['hive_create_project']

/** Changing Hive's settings: only with Settings → Assistant → Control → Change settings on, whatever the level. */
export const ASSISTANT_SETTINGS_TOOLS = ['hive_update_setting']

/** The Assistant's journal (#1031): offered only while Settings → Assistant → Journal is on (at its start). */
export const JOURNAL_TOOLS = ['hive_journal_write', 'hive_journal_recall', 'hive_journal_entry', 'hive_journal_update']

/**
 * Tools only project agents have (the Assistant doesn't get them): the merge slot is held by an agent's own launch; a card
 * is started by the agent that works on it; an agent asks the Assistant on a card (HI-1866).
 */
export const AGENT_ONLY_TOOLS = ['hive_merge_slot', 'hive_start_card', 'hive_ask_assistant']

/** Tools only the Assistant has (project agents don't get them). hive_wait_for_agents isn't one: an agent waits on its project's agents too (#416). */
export const ASSISTANT_ONLY_TOOLS = ['hive_agent_activity', 'hive_list_providers', 'hive_list_settings', 'hive_read_setting', ...ASSISTANT_AGENT_TOOLS, ...ASSISTANT_SLOT_TOOLS, ...ASSISTANT_TEAM_TOOLS, ...ASSISTANT_TEMPLATE_TOOLS, ...ASSISTANT_CONNECTION_TOOLS, ...ASSISTANT_UNDO_TOOLS, ...ASSISTANT_PROJECT_TOOLS, ...ASSISTANT_SETTINGS_TOOLS, ...JOURNAL_TOOLS]

const RANK: Record<AssistantControlLevel, number> = { look: 0, agents: 1, projects: 2 }

/** Whether a control level allows what needs `need`. */
export function controlAllows(level: AssistantControlLevel | string | undefined, need: AssistantControlLevel): boolean {
  return (RANK[level as AssistantControlLevel] ?? RANK.projects) >= RANK[need]
}

/** The tools an Assistant with this control level (and Change settings, its journal, on or off) may use without asking. */
export function assistantTools(level: AssistantControlLevel | string | undefined, changeSettings = false, journal = false): string[] {
  return [...(journal ? JOURNAL_TOOLS : []), ...ASSISTANT_READ_TOOLS, ...ASSISTANT_LANE_TOOLS, ...ASSISTANT_QUEUE_TOOLS, ...ASSISTANT_SLOT_TOOLS, ...ASSISTANT_TEAM_TOOLS, ...ASSISTANT_TEMPLATE_TOOLS, ...ASSISTANT_CONNECTION_TOOLS, ...(controlAllows(level, 'agents') ? [...ASSISTANT_AGENT_TOOLS, ...TASK_TOOLS, ...INTENT_TOOLS, ...ASSISTANT_UNDO_TOOLS] : []), ...(controlAllows(level, 'projects') ? ASSISTANT_PROJECT_TOOLS : []), ...(changeSettings ? ASSISTANT_SETTINGS_TOOLS : [])]
}

/** Every tool the hive MCP server has (a test checks it against hive-mcp.ts): the only tool names metrics record. */
export const HIVE_TOOLS: readonly string[] = [
  'hive_list_projects', 'hive_project_status', 'hive_session_usage', 'hive_list_shared_notes', 'hive_read_shared_note', 'hive_write_shared_note', 'hive_doc_outline', 'hive_read_section',
  'hive_read_latest_handover', 'hive_create_handover', 'hive_notify', 'hive_list_providers', 'hive_agent_activity', 'hive_wait_for_agents',
  'hive_create_project', 'hive_activate_project', 'hive_add_agent', 'hive_update_agent', 'hive_start_agent', 'hive_stop_agent', 'hive_prompt_agent',
  'hive_message_agent', 'hive_hand_over', 'hive_list_tasks', 'hive_read_task', 'hive_read_attachment', 'hive_create_task', 'hive_update_task', 'hive_update_tasks', 'hive_reorder_tasks', 'hive_start_task', 'hive_list_skills', 'hive_wait_for_tasks',
  'hive_list_settings', 'hive_read_setting', 'hive_update_setting', 'hive_merge_slot', 'hive_lane', 'hive_queue', 'hive_release_slot', 'hive_team', 'hive_template', 'hive_connection', 'hive_inbox', 'hive_console',
  'hive_journal_write', 'hive_journal_recall', 'hive_journal_entry', 'hive_journal_update',
  'hive_start_card', ...INTENT_TOOLS, 'hive_focused_skip', 'hive_ask_assistant', 'hive_undo'
]
