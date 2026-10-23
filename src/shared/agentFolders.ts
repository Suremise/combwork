// Where an agent works (#1434, SPEC §16.10.3): the folder contract every part of Hive uses, decided here only. Pure,
// over what main reads of a project's slots and leases (src/main/agentFolders.ts gathers it; the window reads the
// answers main gives with each agent and session).
//
// - A new conversation starts at `launchFolder`: a review in the project folder (the stable home); a build in the
//   agent's open dispatch lease's slot, else its carried slot (#1441), else the project folder. Before #1441 has
//   migrated a project, an agent with a 0.9 worktree keeps working there, so nothing changes until the migration.
// - A conversation resumes only where it was made (`resumeFolder`): CLIs file conversations by folder. Whether it may
//   resume there now is `resumeHold`: none (`canResumeNow`: Resume All and startup resume it), `byHand` (only the
//   user's own Resume, `canResumeByUser`, which takes the slot under a new lease or binds it to the agent's open one),
//   or a refusal saying why.

import { samePath } from './movePaths'
import type { WorkflowRole } from './workflow/roles'

export type FolderPurpose = 'build' | 'review'
export type FolderLeaseKind = 'card' | 'lane' | 'carried'

/** An open lease of a project's slot. */
export interface FolderLease {
  id: string
  kind: FolderLeaseKind
  slot: string
  card: number | null
  lane: string | null
  /** The builder agent's id. */
  agent: string
}

/** A project's slot as the contract reads it: its folder, state, open lease, and the lease it was last lent under. */
export interface FolderSlot {
  name: string
  folder: string
  /** slots.ts's SlotState. */
  state: string
  /** Its block of ports (HIVE_SLOT_PORT_BASE). */
  portBase: number
  open: FolderLease | null
  /** Its newest lease (the open one, else the last that ended). */
  last: (FolderLease & { ended: boolean }) | null
  /** The session run that writes in it now (main's claimPlace reserves it; cleared once that run has exited). */
  writer: { run: string; agent: string; lease: string } | null
}

/** What the contract decides from: the project, its slots, its migration and its retired homes. */
export interface FolderFacts {
  projectPath: string
  /** #1441 has migrated the project's agents' worktrees into slots: their 0.9 `worktree` no longer counts. */
  migrated: boolean
  /** Retired homes (#1441): folders an agent's conversations resume in, never lent. */
  homes: readonly string[]
  slots: readonly FolderSlot[]
}

/** An agent as the contract reads it: its id, its role in the workflow, and its 0.9 worktree (`legacyWorktree`). */
export interface FolderAgent {
  id: string
  role: WorkflowRole
  legacy: { path: string; branch: string } | null
}

/** A session as the contract reads it: the folder it recorded (none: the project folder) and the lease it is bound to. */
export interface FolderSession {
  cwd?: string | null
  lease?: string | null
}

/**
 * Why a conversation can't resume now, or how only the user's Resume may (`byHand`):
 * - `after`: its agent builds elsewhere under a dispatch lease (its card or lane), and this conversation is in its
 *   carried slot: it resumes once that card ends;
 * - `reused`: its slot holds other work now (open, or lent since) — a card's or a lane's;
 * - `holds`: its agent already keeps another slot (a carried lease), so it can't take this one;
 * - `changed`: its slot is free but not as the conversation left it (files changed, or not set up);
 * - `gone`: its slot's folder is gone;
 * - `reviewer`: its agent reviews now, and reviewers never run in a slot;
 * - `byHand`: its slot is free and as it left it (`take`), or is the agent's own under a later lease (`rebind`): the
 *   user's Resume takes or binds it; Resume All and startup leave it.
 */
export type ResumeHold =
  | { is: 'after'; slot: string; card: number | null; lane: string | null }
  | { is: 'reused'; slot: string; card: number | null; lane: string | null }
  | { is: 'holds'; slot: string }
  | { is: 'changed'; slot: string }
  | { is: 'gone'; slot: string }
  | { is: 'reviewer'; slot: string }
  | { is: 'byHand'; slot: string; how: 'take' | 'rebind'; lease: string }

/** The purpose an agent's new conversation has when nothing says (#1430): reviewers review, builders and either build. */
export const defaultPurpose = (role: WorkflowRole): FolderPurpose => (role === 'reviewer' ? 'review' : 'build')

/** The slot whose folder this is, if any. */
export const slotAt = (facts: FolderFacts, folder: string): FolderSlot | null => facts.slots.find((s) => samePath(s.folder, folder)) ?? null

/** An agent's open leases: its dispatch lease (a card's or a lane's) and its carried lease, each at most one. */
export function leasesOf(facts: FolderFacts, agentId: string): { dispatch: FolderLease | null; carried: FolderLease | null } {
  const open = facts.slots.flatMap((s) => (s.open && s.open.agent === agentId ? [s.open] : []))
  return { dispatch: open.find((l) => l.kind !== 'carried') ?? null, carried: open.find((l) => l.kind === 'carried') ?? null }
}

const folderOf = (facts: FolderFacts, lease: FolderLease | null): string | null => (lease ? (facts.slots.find((s) => s.name.toLowerCase() === lease.slot.toLowerCase())?.folder ?? null) : null)

/** Where a new conversation of the agent starts, and under which lease (null: none, outside a slot). */
export function launchPlace(facts: FolderFacts, agent: FolderAgent, purpose: FolderPurpose): { folder: string; lease: FolderLease | null } {
  // Before the migration an agent's 0.9 worktree is its folder, as in 0.9, whatever it does.
  const legacy = !facts.migrated && agent.legacy ? agent.legacy.path : null
  if (purpose === 'review') return { folder: legacy ?? facts.projectPath, lease: null }
  const { dispatch, carried } = leasesOf(facts, agent.id)
  for (const l of [dispatch, carried]) {
    const folder = folderOf(facts, l)
    if (folder) return { folder, lease: l }
  }
  return { folder: legacy ?? facts.projectPath, lease: null }
}

/** Where a new conversation of the agent starts. */
export const launchFolder = (facts: FolderFacts, agent: FolderAgent, purpose: FolderPurpose): string => launchPlace(facts, agent, purpose).folder

/** Where a conversation resumes: always the folder it recorded (none recorded: the project folder). */
export const resumeFolder = (projectPath: string, s: FolderSession): string => s.cwd || projectPath

/** Where the agent works now: its running session's folder (a retired home included), else where it would start. */
export const currentFolder = (facts: FolderFacts, agent: FolderAgent, running: { cwd: string } | null): string => running?.cwd ?? launchFolder(facts, agent, defaultPurpose(agent.role))

/**
 * Whether, and how, the agent's conversation `s` may resume in its own folder now; null: it may (`canResumeNow`). Its
 * folder outside the project's slots (the project folder, a home, a 0.9 worktree) isn't decided here: the launch's
 * own checks apply (the folder exists; a worktree's conversation resumes with the agent working there).
 */
export function resumeHold(facts: FolderFacts, agent: FolderAgent, s: FolderSession): ResumeHold | null {
  const folder = resumeFolder(facts.projectPath, s)
  if (samePath(folder, facts.projectPath) || facts.homes.some((h) => samePath(h, folder))) return null
  const slot = slotAt(facts, folder)
  if (!slot) return null
  if (agent.role === 'reviewer') return { is: 'reviewer', slot: slot.name }
  if (slot.state === 'gone') return { is: 'gone', slot: slot.name }
  const { dispatch, carried } = leasesOf(facts, agent.id)
  const open = slot.open
  if (open && open.agent !== agent.id) return { is: 'reused', slot: slot.name, card: open.card, lane: open.lane }
  // Its carried slot while it builds a card elsewhere: the card's lease wins, this waits for it to end.
  if (dispatch && (!open || open.kind === 'carried') && dispatch.slot.toLowerCase() !== slot.name.toLowerCase()) return { is: 'after', slot: dispatch.slot, card: dispatch.card, lane: dispatch.lane }
  if (open) return s.lease === open.id ? null : { is: 'byHand', slot: slot.name, how: 'rebind', lease: open.id }
  // Free: lent to other work since this conversation's lease (or another agent's session still draining there), or not as it was left.
  const last = slot.last
  if (last && (last.id !== s.lease || (slot.writer && slot.writer.agent !== agent.id))) return { is: 'reused', slot: slot.name, card: last.card, lane: last.lane }
  if (slot.state !== 'ready') return { is: 'changed', slot: slot.name }
  if (carried) return { is: 'holds', slot: carried.slot }
  return { is: 'byHand', slot: slot.name, how: 'take', lease: last?.id ?? '' }
}

/** Resume All and startup: only a conversation with no hold (its lease open, or no slot). */
export const canResumeNow = (facts: FolderFacts, agent: FolderAgent, s: FolderSession): boolean => resumeHold(facts, agent, s) === null

/** The user's own Resume: also a free slot as the conversation left it, or the agent's own slot under a later lease. */
export function canResumeByUser(facts: FolderFacts, agent: FolderAgent, s: FolderSession): boolean {
  const h = resumeHold(facts, agent, s)
  return h === null || h.is === 'byHand'
}
