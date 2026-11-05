// Start New (All) and Archive and Start New (All) (#216): every agent of a project gets a fresh session after one
// confirmation, running ones stopped first; the second archives each agent's session first. Pure parts here (which
// agents, which sessions, what the confirmation says about each, running them one at a time), so they are tested.
import { agentsToResume } from './resumeAll'
import type { SessionStatus, WorktreeCheck } from './types'
import { msg, tr } from './i18n'

export interface BatchAgent {
  id: string
  name: string
  live: { sessionId: string; status: SessionStatus } | null
  /** The session Resume would open. */
  resume: { id: string } | null
}

export interface BatchSession {
  id: string
  archived?: boolean
}

/** What stopping a running agent costs it, as the quit dialog says it (null: nothing in progress). */
export function busyNote(status: SessionStatus): string | null {
  return status === 'working' || status === 'background' || status === 'waiting' || status === 'watching'
    ? tr(msg({ id: 'agents.batch.busy', defaultMessage: '{status, select, working {will be interrupted} background {background tasks will stop} waiting {waiting for you} other {its card loop pauses until it is resumed}}', description: "What stopping a running agent costs, in a few words (the quit dialog, Start New All…; lower case, in brackets after Stopped): it is working, waiting on its background tasks, waiting for the user's answer, or watching cards in a card loop (other: its loop pauses until the agent is resumed)." }), { status })
    : null
}

/**
 * The session Archive and Start New (All) archives for an agent: a running agent's current one, else the one its Resume
 * would open (its last one, if that isn't archived yet; worked out in main as `AgentInfo.resume`). Null: it has none.
 * The header counts the agents with one, so the button's count and the confirmation's list are the same agents (#275).
 */
export function archiveTarget(agent: Pick<BatchAgent, 'live' | 'resume'>): string | null {
  return agent.live?.sessionId ?? agent.resume?.id ?? null
}

/**
 * Each agent's session to archive (`archiveTarget`), as Hive keeps it: agents with none, or whose stopped session is
 * gone or archived meanwhile, are left out (they have nothing to archive and keep what they have).
 */
export function sessionsToArchive<A extends BatchAgent>(agents: readonly A[], sessions: readonly BatchSession[]): { agent: A; sessionId: string }[] {
  return agents.flatMap((agent) => {
    const id = archiveTarget(agent)
    const s = id ? sessions.find((x) => x.id === id) : undefined
    return s && (agent.live || !s.archived) ? [{ agent, sessionId: s.id }] : []
  })
}

/** How many agents each batch action in the project header would act on, as its confirmation lists them (#275). */
export interface BatchCounts {
  /** Stop: the running agents. */
  stop: number
  /** Resume: the stopped agents with a conversation to resume. */
  resume: number
  /** Start New: every agent. */
  startNew: number
  /** Archive and Start New: the agents with a session to archive. */
  archive: number
}

export function batchCounts(agents: readonly BatchAgent[]): BatchCounts {
  return {
    stop: agents.filter((a) => a.live).length,
    resume: agentsToResume(agents).length,
    startNew: agents.length,
    archive: agents.filter((a) => archiveTarget(a)).length
  }
}

/** A worktree agent's worktree, with whether it could be deleted without losing work (`agents:worktreeChecks`). */
export interface BatchWorktree {
  branch: string
  check?: Pick<WorktreeCheck, 'removable' | 'reason'>
}

/** What a batch does to each agent (#572): Start New (All), Archive and Start New (All), Remove All. */
export type BatchKind = 'start' | 'archive' | 'remove'

/**
 * The confirmation table's "What happens" cell for an agent (#572): stopping it first when it runs, saying what that
 * interrupts as the line does (`busyNote`, then `warn`), and what follows.
 */
export function batchOutcome(kind: BatchKind, agent: Pick<BatchAgent, 'live'>): { text: string; warn: boolean } {
  if (!agent.live) return { text: tr(msg({ id: 'agents.batch.outcome', defaultMessage: '{kind, select, start {A new session} archive {Its session archived, then a new one} other {Removed}}', description: "What happens to an agent that isn't running in a batch (Start New All: start; Archive and Start New All: archive; Remove All: other), in an agents table's What happens column." }), { kind }), warn: false }
  const note = busyNote(agent.live.status)
  return { text: tr(msg({ id: 'agents.batch.stoppedThen', defaultMessage: 'Stopped{note, select, none {} other { ({note})}}, then {kind, select, start {a new session} archive {its session archived, then a new one} other {removed}}', description: "What happens to a running agent in a batch (What happens column): stopped first ({note}: what that interrupts, in a few words; none: leave it empty), then a new session (start), its session archived and a new one (archive), or removed (other)." }), { note: note ?? 'none', kind }), warn: !!note }
}

/**
 * Remove All's Worktree cell (#291, #572): the branch, and what can happen to it: deleted only if the box is ticked and it
 * is merged and clean, else always kept (and why).
 */
export function removeWorktreeText(worktree: BatchWorktree): string {
  const check = worktree.check
  if (check?.removable) return tr(msg({ id: 'agents.batch.worktreeRemovable', defaultMessage: '{branch}: merged and clean', description: "Remove All's Worktree column: the agent's branch ({branch}) is merged and has no changes, so it can be deleted." }), { branch: worktree.branch })
  if (check?.reason) return tr(msg({ id: 'agents.batch.worktreeKept', defaultMessage: '{branch}: always kept ({why})', description: "Remove All's Worktree column: the agent's branch ({branch}) is kept, and why ({why})." }), { branch: worktree.branch, why: check.reason })
  return tr(msg({ id: 'agents.batch.worktreeUnchecked', defaultMessage: "{branch}: always kept (couldn't be checked)", description: "Remove All's Worktree column: the agent's branch ({branch}) is kept because Combwork couldn't check it." }), { branch: worktree.branch })
}

export interface BatchResult {
  done: string[]
  failed: { name: string; error: string }[]
}

/** Runs `step` for each agent in turn (one launch at a time): a failure is kept with its reason and the rest go on. */
export async function eachAgent<A extends { name: string }>(agents: readonly A[], step: (agent: A) => Promise<void>): Promise<BatchResult> {
  const result: BatchResult = { done: [], failed: [] }
  for (const a of agents) {
    try {
      await step(a)
      result.done.push(a.name)
    } catch (e) {
      result.failed.push({ name: a.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
