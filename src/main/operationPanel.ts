// HI-3470: Changes' panel for a git operation left under way in a folder (SPEC §16.10.2, A git operation left under way):
// what it reads (`git:operation`) and what it does (`git:operationStep`), the user's click at a time, never an agent's
// tool. Which folder: a Changes root (the project folder, an agent's slot or worktree, an unused worktree), its project
// found by the workspace. A slot's step runs while its pool holds it (SlotPool.forUser: nothing else holding it, no
// session or process in it), only under the lease the user confirmed when it is lent; every folder's step refuses a
// live session in it, and the port checks again, under the repository lock and the folder's fence, that nothing of
// Combwork's or an agent's works there and that the operation is still the one the user saw.
import type { OperationLent, OperationPanelState, OperationRequest, OperationStepResult } from '../shared/gitOperations'
import { isOperationName } from '../shared/gitOperations'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { containsPlace } from './fsutil'
import { cardKeyOf } from './boardStore'
import type { OpsFor } from './platform/repoOps'
import { lineRepoReads } from './platform/repoReadsPorts'
import { sessions } from './sessions'
import { poolFor } from './slotsApp'
import type { Slot, SlotPool } from './slots'
import type { WorkspaceService } from './workspace'
import { samePlace } from './fsutil'

const T = {
  session: msg({ id: 'service.gitOperation.session', defaultMessage: "{agent}'s session is in {folder}: nothing was done. Stop it first, or ask it to finish the operation.", description: "HI-3470: an error from the unfinished git operation panel (Version Control → Changes): an agent's session ({agent}, its name) runs in the folder ({folder}, a path), so Combwork doesn't touch git there." }),
  slotSession: msg({ id: 'service.gitOperation.slotSession', defaultMessage: 'A session is in {slot}: nothing was done. Stop it first.', description: 'HI-3470: an error from the panel: a session runs in the slot ({slot}, such as slot-a; glossary: slot).' }),
  slotProcess: msg({ id: 'service.gitOperation.slotProcess', defaultMessage: 'A process has a file or a folder in {slot} open: nothing was done. Close it (a terminal, an editor) and try again.', description: 'HI-3470: an error from the panel: something has the slot\'s folder ({slot}) open, so Windows refused to rename it aside for a moment (the check that nothing works there).' }),
  slotChanged: msg({ id: 'service.gitOperation.slotChanged', defaultMessage: "{slot} changed meanwhile (lent, released, or something of Combwork's started in it): nothing was done. Look again.", description: 'HI-3470: an error from the panel: the slot ({slot}) was lent to a card, released, or taken by one of Combwork\'s own steps (its setup, an archive, a run writing in it) since the user looked, or the lent slot they confirmed is lent under another lease now.' }),
  invalid: msg({ id: 'service.gitOperation.invalid', defaultMessage: 'That step was asked for wrongly: nothing was done.', description: 'HI-3470: an error from the panel: the request was malformed (not reached from the window).' })
}

/** The slot a Changes root is, in its project's pool, or null (the project folder, an agent's 0.9 worktree, another worktree). */
async function slotAt(ws: WorkspaceService, project: string, folder: string): Promise<{ pool: SlotPool; slot: Slot } | null> {
  if (samePlace(folder, project)) return null
  const pool = await poolFor(ws, project)
  const slot = pool.slots().find((s) => samePlace(s.folder, folder))
  return slot ? { pool, slot } : null
}

/** The slot's open lease as the panel names it before the user confirms, or null (free, or not a slot). */
function lentOf(ws: WorkspaceService, at: { pool: SlotPool; slot: Slot } | null): OperationLent | null {
  const l = at ? at.pool.openLease(at.slot.name) : null
  if (!at || !l) return null
  return { slot: at.slot.name, lease: l.id, agent: l.agent, card: l.card !== null ? (cardKeyOf(ws, l.card)?.key ?? `#${l.card}`) : null, lane: l.lane }
}

/** `git:operation`: the operation under way in a Changes root, with its conflicted files and its slot's lease; null with none. */
export async function operationPanel(ws: WorkspaceService, root: string): Promise<OperationPanelState | null> {
  const { folder, project } = ws.changesRootProject(root)
  const state = await lineRepoReads().operation(folder)
  if (!state) return null
  return { ...state, lent: lentOf(ws, await slotAt(ws, project, folder)) }
}

/** The request as the window sent it, checked: anything else is refused before anything runs. */
function requestOf(raw: unknown): OperationRequest {
  const r = (raw ?? {}) as Record<string, unknown>
  // The stop the user saw (HR1's round 1): never optional, so no request acts on whatever git is at now.
  if (!isOperationName(r.what) || typeof r.id !== 'string' || !r.id) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const base = { what: r.what, id: r.id, ...(typeof r.lease === 'string' && r.lease ? { lease: r.lease } : {}) }
  if (r.step === 'continue' || r.step === 'skip' || r.step === 'abort') return { ...base, step: r.step }
  if (typeof r.file === 'string' && r.file && (r.pick === 'mine' || r.pick === 'theirs' || r.pick === 'resolved')) return { ...base, file: r.file, pick: r.pick }
  throw combworkError(T.invalid, undefined, { kind: 'invalid' })
}

/**
 * `git:operationStep`: the user's step on the operation under way in a Changes root, or a conflicted file settled.
 * Refused while a session is in the folder; a slot's only while its pool holds it for this (SlotPool.forUser), under the
 * lease the user confirmed (`req.lease`) when it is lent; `ops` the port, as repoOpsIpc.ts handed it out. Answers git's output (HI-3503: and whether it stopped again).
 */
export async function stepOperation(ws: WorkspaceService, root: string, raw: unknown, ops: OpsFor<'operationSteps'>): Promise<OperationStepResult> {
  const req = requestOf(raw)
  const { folder, project } = ws.changesRootProject(root)
  const noSession = (): void => {
    const live = sessions.liveStates().find((x) => !!x.cwd && containsPlace(folder, x.cwd))
    if (live) throw combworkError(T.session, { agent: live.agentName ?? live.agentId, folder })
  }
  const at = await slotAt(ws, project, folder)
  if (!at) return ops.operationStep(project, folder, req, noSession)
  const name = at.slot.name
  const r = await at.pool.forUser(name, at.slot.folder, req.lease ?? null, () => ops.operationStep(project, folder, req, noSession))
  if (r.ok) return r.value
  throw r.why === 'session' ? combworkError(T.slotSession, { slot: name }) : r.why === 'process' ? combworkError(T.slotProcess, { slot: name }) : combworkError(T.slotChanged, { slot: name }, { kind: 'conflict' })
}
