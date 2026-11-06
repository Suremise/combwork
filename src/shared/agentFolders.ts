// Where an agent works (#1434, SPEC §16.10.3): the folder contract every part of Combwork uses, decided here only. Pure,
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
import type { AgentDef } from './types'
import type { WorkflowRole } from './workflow/roles'

/** An agent's 0.9 worktree: its own checkout of the project on its own branch, made from `base` (0.9.3's `worktree`). */
export interface LegacyWorktree {
  path: string
  branch: string
  /** Branch it was created from, and merges back into. */
  base: string
}

/**
 * What 0.9.3 stored on an agent in project.json that 1.0's `AgentDef` doesn't type (#1452): its worktree and whether that
 * worktree's setup command has still to run. 1.0 reads them only here, carries them through every save unchanged
 * (`carryLegacyAgentFields`), so 0.9.3 finds them after a return, and makes no new worktree.
 */
export interface LegacyAgentFields {
  worktree?: LegacyWorktree
  needsSetup?: boolean
}

/** An agent as project.json may store it: 1.0's definition with 0.9.3's fields. For the readers and writers of those only. */
export type StoredAgent = AgentDef & LegacyAgentFields

/** The agent as stored, for the readers and writers of 0.9.3's fields (migration, Repair, the 0.9 worktree's actions). */
export const storedAgent = <A extends AgentDef>(a: A): A & LegacyAgentFields => a as A & LegacyAgentFields

/**
 * An agent's 0.9 worktree, as project.json stores it (`worktree`). Only the migration (#1441), Repair (#1447), the folder
 * contract and what still knows a project not migrated yet read it (#1451): everything else asks where an agent works.
 */
export function legacyWorktree(raw: object | null | undefined): LegacyWorktree | null {
  const w = (raw as LegacyAgentFields | null | undefined)?.worktree
  return w && typeof w === 'object' && typeof w.path === 'string' && w.path ? w : null
}

/** Whether an agent's 0.9 worktree still has its setup command to run before its next session (0.9.3's `needsSetup`). */
export const legacySetupPending = (raw: object | null | undefined): boolean => !!legacyWorktree(raw) && (raw as LegacyAgentFields).needsSetup === true

/**
 * 0.9.3's fields carried through a save of the agents (#1452, the keep-what-you-don't-own rule P6's `writeWorkflow` has):
 * an agent of `before` written again without a `worktree` or `needsSetup` key keeps the stored one, so a return to 0.9.3
 * finds it. A writer that means to drop one (Repair's unlink) writes the key, `undefined`.
 */
export function carryLegacyAgentFields<A extends object>(before: readonly object[], after: readonly A[]): A[] {
  const old = new Map<string, LegacyAgentFields>()
  for (const a of before) {
    const id = (a as { id?: unknown }).id
    if (typeof id === 'string') old.set(id, a as LegacyAgentFields)
  }
  return after.map((a) => {
    const was = old.get((a as { id?: unknown }).id as string)
    if (!was) return a
    const keep: LegacyAgentFields = {}
    if (!('worktree' in a) && was.worktree !== undefined) keep.worktree = was.worktree
    if (!('needsSetup' in a) && was.needsSetup !== undefined) keep.needsSetup = was.needsSetup
    return Object.keys(keep).length ? { ...a, ...keep } : a
  })
}

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
  /** Its block of ports (CW_SLOT_PORT_BASE). */
  portBase: number
  /** The branch its lines merge into, when it has one (#1569: the base the Changes tab compares its work with). */
  target?: string | null
  open: FolderLease | null
  /** Its newest lease (the open one, else the last that ended), and its last revision (null: not recorded yet, its session draining). */
  last: (FolderLease & { ended: boolean; endRev?: string | null }) | null
  /** The session run that writes in it now (main's claimPlace reserves it; cleared once that run has exited). */
  writer: { run: string; agent: string; lease: string } | null
}

/** What the contract decides from: the project, its slots, its migration and its retired homes. */
export interface FolderFacts {
  projectPath: string
  /** #1441 has run on the project (its record is there). */
  migrated: boolean
  /** The agents #1441 has migrated (their 0.9 worktree adopted as a slot, or a reviewer's kept as a retired home): their
   * 0.9 `worktree` no longer counts. One not listed (a worktree missing at the upgrade, or made since) keeps it. */
  migratedAgents: readonly string[]
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
 * - `draining`: its slot is free, but its last session there is still being handed back (its run exiting, the slot not
 *   looked at yet): it may resume by hand in a moment;
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
  | { is: 'draining'; slot: string }
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
  // Until the migration takes it over, an agent's 0.9 worktree is its folder, as in 0.9, whatever it does.
  const legacy = agent.legacy && !facts.migratedAgents.includes(agent.id) ? agent.legacy.path : null
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

/** The retired home a conversation resumes in, by its folder's name (#1552: its pane says so); null elsewhere. */
export function resumeHome(facts: FolderFacts, s: FolderSession): string | null {
  const folder = resumeFolder(facts.projectPath, s)
  return facts.homes.some((h) => samePath(h, folder)) ? (folder.split(/[\\/]/).filter(Boolean).pop() ?? folder) : null
}

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
  if (slot.writer || slot.state === 'lent' || (last && last.ended && last.endRev === null)) return { is: 'draining', slot: slot.name }
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

/**
 * Why an agent is in a folder (#1451, the Agent API's word for it): its running session is there (`session`); a new
 * conversation starts there under its dispatch lease (`lease`: its card's or lane's slot), its carried slot or 0.9
 * worktree (`carried`), or in the project folder (`project`).
 */
export type PlaceWhy = 'session' | 'lease' | 'carried' | 'project'

/** A folder an agent works in, as the Agent API names it: its path, its short name (`placeName`), why, and its slot. */
export interface AgentPlace {
  path: string
  at: string
  why: PlaceWhy
  slot: string | null
}

/**
 * A folder as the Agent API names it, short (#1451): a slot's name, `project` for the project folder, `home: <name>`
 * for a retired home (#1441), else its path (a 0.9 worktree not migrated yet).
 */
export function placeName(facts: FolderFacts, folder: string): string {
  const slot = slotAt(facts, folder)
  if (slot) return slot.name
  if (samePath(folder, facts.projectPath)) return 'project'
  if (facts.homes.some((h) => samePath(h, folder))) return `home: ${folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}`
  return folder
}

/**
 * Where an agent is now (`currentFolder`: its running session's folder, else where a new conversation would start) and
 * where its next new conversation would start (`launchFolder`, for its role's purpose), each named and with why (#1451).
 */
export function agentPlaces(facts: FolderFacts, agent: FolderAgent, running: { cwd: string } | null): { now: AgentPlace; launch: AgentPlace } {
  const p = launchPlace(facts, agent, defaultPurpose(agent.role))
  const why: PlaceWhy = p.lease ? (p.lease.kind === 'carried' ? 'carried' : 'lease') : samePath(p.folder, facts.projectPath) ? 'project' : 'carried'
  const place = (path: string, w: PlaceWhy): AgentPlace => ({ path, at: placeName(facts, path), why: w, slot: slotAt(facts, path)?.name ?? null })
  const launch = place(p.folder, why)
  return { now: running ? place(running.cwd, 'session') : launch, launch }
}

/**
 * What kind of place an agent's folder is, as the window shows it (#1442): a slot it builds in (`slot`), its carried
 * slot (`carried`, #1441), a retired home (`home`), its 0.9 worktree not migrated yet (`legacy`), or the project folder.
 */
export type ShownPlaceKind = 'slot' | 'carried' | 'home' | 'legacy' | 'project'

/** Where an agent works now, for the window (#1442): its folder, the kind of place, its short name, and its branch. */
export interface ShownPlace {
  folder: string
  is: ShownPlaceKind
  /** The slot's name, or the home's or 0.9 worktree's folder name; null in the project folder. */
  name: string | null
  /** Its line (a card's branch in a slot, a carried slot's or 0.9 worktree's own), when known. */
  branch: string | null
  /** A 0.9 worktree's: the branch it was made from; a slot's: the branch its lines merge into, when known (#1569). */
  base?: string
}

/** A project's folder other than its own, named for the window (#1442): a slot, or a retired home. */
export interface NamedFolder {
  path: string
  name: string
  is: 'slot' | 'home'
}

const leafOf = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder

/**
 * The window's view of `now` (an `agentPlaces` answer) for the agent, with its line (`branch`, main's `agentPlace`) and
 * the branch that line merges into (`target`, its card's: #1627), else the slot's.
 */
export function shownPlace(facts: FolderFacts, agent: FolderAgent, now: AgentPlace, branch: string | null, target: string | null = null): ShownPlace {
  const slot = now.slot ? (facts.slots.find((s) => s.name === now.slot) ?? null) : null
  const base = target ?? slot?.target
  if (slot) return { folder: now.path, is: slot.open?.kind === 'carried' && slot.open.agent === agent.id ? 'carried' : 'slot', name: slot.name, branch, ...(base ? { base } : {}) }
  if (facts.homes.some((h) => samePath(h, now.path))) return { folder: now.path, is: 'home', name: leafOf(now.path), branch: null }
  if (agent.legacy && samePath(agent.legacy.path, now.path)) return { folder: now.path, is: 'legacy', name: leafOf(now.path), branch: agent.legacy.branch }
  return { folder: now.path, is: 'project', name: null, branch: null }
}

/** The project's slots and retired homes, named (#1442): what the window names a session's or a card's folder by. */
export const namedFolders = (facts: FolderFacts): NamedFolder[] => [...facts.slots.map((s) => ({ path: s.folder, name: s.name, is: 'slot' as const })), ...facts.homes.map((h) => ({ path: h, name: leafOf(h), is: 'home' as const }))]

