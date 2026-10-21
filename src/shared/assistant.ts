import type { AppSettings, ProjectConfig, ProjectProviderConfig, ProviderId } from './types'
import { DEFAULT_SETTINGS, projectAgents } from './defaults'
import { isCliOwnMode } from './cliOwnMode'
import { PROVIDERS } from './providers'

/**
 * The Hive Assistant: one per workspace, its overseer. It runs like a project's agent (same terminal, hooks,
 * status, usage and quit handling) from a home folder Hive never lists as a project, .hive/assistant, and
 * works in the workspace folder. Settings → Assistant holds its defaults; the home's one agent holds the
 * workspace's own choices (Assistant Settings), over them.
 */

/** The Assistant's home in a workspace's .hive folder. */
export const ASSISTANT_DIR = 'assistant'
/** Its agent's id (the home's only agent). */
export const ASSISTANT_AGENT_ID = 'assistant'
export const ASSISTANT_NAME = 'Assistant'
/** Where the workspace's modes are, in its .hive folder. */
export const MODES_DIR = 'modes'
/**
 * Where they were until 0.9.3, when modes were called personas (#1084): moved to MODES_DIR as the workspace opens, and
 * still read while there is no MODES_DIR (an older Hive may make it again), in 0.9.3 only.
 */
export const LEGACY_MODES_DIR = 'personas'
/** The mode (a file in MODES_DIR) new conversations use unless Settings or the workspace chooses another (#259). */
export const DEFAULT_MODE = 'coordinator'

export { RETIRED_PERSONAS } from './defaults'

/** Hive's tools that only read: the Assistant uses them without being asked each time (the ones that write still ask). */
export const ASSISTANT_TRUSTED_TOOLS = [
  'hive_list_projects',
  'hive_project_status',
  'hive_session_usage',
  'hive_list_shared_notes',
  'hive_read_shared_note',
  'hive_doc_outline',
  'hive_read_section',
  'hive_read_latest_handover',
  'hive_list_skills'
]

/**
 * The Assistant's config as its sessions see it: Settings → Assistant stands in for "the project's" settings
 * (provider, model, effort, mode, arguments), an unset mode is the provider's assistantMode, and the home
 * always has exactly its one agent, keeping the workspace's overrides from the file. The CLI's own setting is never the
 * Assistant's mode (#1284: Control relies on knowing it): one set by hand or through the Agent API is its assistantMode.
 */
export function assistantProjectConfig(cfg: ProjectConfig, settings: Pick<AppSettings, 'assistant'>): ProjectConfig {
  const a = settings.assistant
  const providers = {} as Record<ProviderId, ProjectProviderConfig>
  for (const p of PROVIDERS) {
    const s = a?.providers?.[p.id]
    providers[p.id] = { model: s?.model || 'inherit', effort: s?.effort || 'inherit', permissionMode: s?.permissionMode && !isCliOwnMode(s.permissionMode) ? s.permissionMode : p.assistantMode, extraArgs: s?.extraArgs ?? '', use200kContext: s?.use200kContext || 'inherit' }
  }
  const found = projectAgents(cfg).find((x) => x.id === ASSISTANT_AGENT_ID)
  const own = found && isCliOwnMode(found.permissionMode) ? { ...found, permissionMode: undefined } : found
  return {
    ...cfg,
    defaultProvider: a?.provider || 'inherit',
    providers,
    agents: [{ ...own, id: ASSISTANT_AGENT_ID, name: ASSISTANT_NAME }],
    layout: 'auto',
    // Settings → Assistant's, so compactThreshold() gives the Assistant its own (0: never), as it does a project its own.
    compactSuggestTokens: a?.compactSuggestTokens ?? DEFAULT_SETTINGS.assistant.compactSuggestTokens,
    fileLocks: 'off',
    worktreeSetup: ''
  }
}

/** The mode a new Assistant conversation takes: the workspace's choice, else Settings → Assistant's. */
export function assistantModeId(agent: { mode?: string } | null | undefined, settings: Pick<AppSettings, 'assistant'> | null | undefined): string {
  return agent?.mode || settings?.assistant?.mode || DEFAULT_MODE
}

/**
 * A mode file's header (name, description, icon, and summary: its habits in a few lines, on one line or as
 * an indented `summary: |` block) and its instructions.
 */
export function parseMode(text: string): { name?: string; description?: string; icon?: string; summary?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text.trim() }
  const out: { name?: string; description?: string; icon?: string; summary?: string; body: string } = { body: text.slice(m[0].length).trim() }
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description|icon|summary):\s*(.*)$/.exec(lines[i].trim())
    if (!kv) continue
    let value = kv[2]
    // A block: the indented lines that follow.
    if (/^[|>][-+]?$/.test(value.trim())) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim())
      value = block.join('\n').trim()
    }
    out[kv[1] as 'name' | 'description' | 'icon' | 'summary'] = value.replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/**
 * A mode's habits in a few lines, for the message that switches the Assistant to it: its summary, else (a mode the
 * user wrote without one) the first lines of its instructions, headings left out.
 */
export function modeSummary(p: { summary?: string; body: string }): string {
  if (p.summary?.trim()) return p.summary.trim()
  const lines = p.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  let out = ''
  for (const l of lines) {
    if (out && `${out} ${l}`.length > 400) break
    out = out ? `${out} ${l}` : l
  }
  return out.length > 400 ? `${out.slice(0, 399)}…` : out
}

/**
 * What Hive types into a running Assistant when the user switches its mode: the mode and its habits, marked as Hive's
 * (not a task), and always Hive's last sentence (never the file's): a mode can't change what the Assistant may do.
 */
export function modeMessage(name: string, summary: string): string {
  return `[Hive] Mode: ${name} (chosen by the user). ${summary.replace(/\s+/g, ' ').trim()} Your tools and permissions are unchanged.`
}

/** A new mode's description until the user writes one (the window shows it in its language while the file has it, #889). */
export const NEW_MODE_DESCRIPTION = 'What this mode is for, in one line.'

/** A new mode's file: a header and a starting point for its instructions. */
export function newModeText(name: string): string {
  return `---\nname: ${name}\ndescription: ${NEW_MODE_DESCRIPTION}\nicon: 🐝\nsummary: |\n  Its habits in a few lines: what Hive tells the Assistant when you switch to it.\n---\n\nYou are in **${name}** mode.\n\nDescribe how the Assistant works in it: what it puts first, its habits and the shape of what it hands back.\n`
}

/** A mode id from a name: lower case, words joined by hyphens. */
export function modeId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
