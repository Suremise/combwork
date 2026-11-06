/**
 * Carrying on (#1432, #966 row 16, SPEC §16.15 row C (16)): how Combwork gets an agent to read its inbox, as three switches
 * with one owner each, apart from whether it can read one at all (its Combwork tools: Settings → Agent API → Provide Combwork
 * tools to sessions, `agentReadsInbox`).
 *
 * - **checkpoints** (`cw.inbox.checkpoints`): a working agent is told of new items at the end of a tool of its own.
 * - **stopContinuation** (`cw.inbox.stopContinuation`): an agent stopping with items unread is kept going (Codex and
 *   Copilot: its Stop blocked; Claude Code: context added to its Stop).
 * - **idleWakes** (`cw.inbox.idleWakes`): an idle agent is woken with a doorbell line, for every kind of item (a card
 *   loop's wakes, `loopWakes`, are one kind). Off, nothing is typed for what waits, and the pane's Deliver now types it
 *   once. A task given now (a card started on an agent, cw_prompt_agent) isn't a wake: it is typed as it is asked for.
 *
 * None drops an item: off, it stays in the inbox, unread, with the overdue rules as before. Each is Settings → Advanced's
 * value, which a project can set its own of (`inboxCheckpoints`… in project.json: inherit, on or off); the Assistant's
 * home has no project, so it follows Settings'.
 */
import type { ProjectConfig } from './types'

export type InboxSwitch = 'checkpoints' | 'stopContinuation' | 'idleWakes'

export const INBOX_SWITCHES: readonly InboxSwitch[] = ['checkpoints', 'stopContinuation', 'idleWakes']

/** Each switch's Settings → Advanced value. */
export const INBOX_SWITCH_ID: Record<InboxSwitch, string> = {
  checkpoints: 'cw.inbox.checkpoints',
  stopContinuation: 'cw.inbox.stopContinuation',
  idleWakes: 'cw.inbox.idleWakes'
}

/** Each switch's project override in project.json (and Project Settings → Sessions). */
export const INBOX_PROJECT_KEY = {
  checkpoints: 'inboxCheckpoints',
  stopContinuation: 'inboxStopContinuation',
  idleWakes: 'inboxIdleWakes'
} as const satisfies Record<InboxSwitch, keyof ProjectConfig>

/** Whether a switch is on: the project's own (on or off) over Settings' value; no project (the Assistant), Settings'. */
export function inboxSwitchOn(which: InboxSwitch, project: Partial<ProjectConfig> | null | undefined, global: boolean): boolean {
  const own = project?.[INBOX_PROJECT_KEY[which]]
  return own === 'on' ? true : own === 'off' ? false : global
}
