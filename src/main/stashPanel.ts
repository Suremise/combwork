// HI-3472: Changes' Stashes (SPEC §16.10.2, Stashes): what the list reads (`git:stashes`, Show's `git:stashFiles` and
// `git:stashDiff`) and what it does (`git:applyStash`, `git:dropStash`), the user's click at a time, never an agent's
// tool. Which folder Apply and Pop act in: the Changes root shown (the project folder, a slot, an agent's worktree, an
// unused worktree), its project found by the workspace, with the same refusals as HI-3470's panel (operationPanel.ts):
// a live session in the folder, and a slot's only while its pool holds it for the user (SlotPool.forUser), under the
// lease the user confirmed when it is lent. The port checks again, under the repository lock and the folder's fence,
// that nothing of Combwork's or an agent's works there (gitStashes.ts). Drop changes no folder: the repository lock only.
import { isStashCommit, stashRequestOf, type StashApplied, type StashList } from '../shared/gitStashes'
import { msg } from '../shared/i18n'
import type { GitDiff } from '../shared/types'
import { combworkError } from './combworkError'
import { containsPlace } from './fsutil'
import { lentOf, slotAt } from './operationPanel'
import type { OpsFor } from './platform/repoOps'
import { sessions } from './sessions'
import type { WorkspaceService } from './workspace'

const T = {
  session: msg({ id: 'service.gitStash.session', defaultMessage: "{agent}'s session is in {folder}: nothing was done. Stop it first.", description: "HI-3472: an error from Version Control → Changes → Stashes' Apply or Pop: an agent's session ({agent}, its name) runs in the folder ({folder}, a path), so Combwork doesn't change its files." }),
  slotSession: msg({ id: 'service.gitStash.slotSession', defaultMessage: 'A session is in {slot}: nothing was done. Stop it first.', description: "HI-3472: an error from Stashes' Apply or Pop: a session runs in the slot ({slot}, such as slot-a; glossary: slot)." }),
  slotProcess: msg({ id: 'service.gitStash.slotProcess', defaultMessage: 'A process has a file or a folder in {slot} open: nothing was done. Close it (a terminal, an editor) and try again.', description: "HI-3472: an error from Stashes' Apply or Pop: something has the slot's folder ({slot}) open, so Windows refused to rename it aside for a moment (the check that nothing works there)." }),
  slotChanged: msg({ id: 'service.gitStash.slotChanged', defaultMessage: "{slot} changed meanwhile (lent, released, or something of Combwork's started in it): nothing was done. Look again.", description: "HI-3472: an error from Stashes' Apply or Pop: the slot ({slot}) was lent to a card, released, or taken by one of Combwork's own steps since the user looked, or the lent slot they confirmed is lent under another lease now." }),
  invalid: msg({ id: 'service.gitStash.invalid', defaultMessage: 'That was asked for wrongly: nothing was done.', description: 'HI-3472: an error from Stashes: the request was malformed (not reached from the window).' })
}

/** `git:stashes`: the repository's stashes, and the Changes root's slot's lease when it is lent. */
export async function stashList(ws: WorkspaceService, root: string, ops: OpsFor<'stashes'>): Promise<StashList> {
  const { folder, project } = ws.changesRootProject(root)
  const stashes = await ops.stashes(folder)
  return { stashes, lent: lentOf(ws, await slotAt(ws, project, folder)) }
}

const commitOf = (raw: unknown): string => {
  if (!isStashCommit(raw)) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  return raw
}

/** `git:stashFiles`: Show's files of a stash. */
export function stashFilesAt(ws: WorkspaceService, root: string, commit: unknown, ops: OpsFor<'stashes'>): ReturnType<OpsFor<'stashes'>['stashFiles']> {
  return ops.stashFiles(ws.changesRootProject(root).folder, commitOf(commit))
}

/** `git:stashDiff`: one file of a stash. */
export function stashDiffAt(ws: WorkspaceService, root: string, commit: unknown, file: unknown, untracked: unknown, ops: OpsFor<'stashes'>): Promise<GitDiff> {
  if (typeof file !== 'string' || !file) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  return ops.stashDiff(ws.changesRootProject(root).folder, commitOf(commit), file, untracked === true)
}

/** `git:applyStash`: Apply or Pop into the Changes root shown, refused while a session is there; a slot's under its pool's hold. */
export async function applyStashAt(ws: WorkspaceService, root: string, raw: unknown, ops: OpsFor<'stashes'>): Promise<StashApplied> {
  const req = stashRequestOf(raw)
  if (!req) throw combworkError(T.invalid, undefined, { kind: 'invalid' })
  const { folder, project } = ws.changesRootProject(root)
  const noSession = (): void => {
    const live = sessions.liveStates().find((x) => !!x.cwd && containsPlace(folder, x.cwd))
    if (live) throw combworkError(T.session, { agent: live.agentName ?? live.agentId, folder })
  }
  const at = await slotAt(ws, project, folder)
  if (!at) return ops.applyStash(project, folder, req, noSession)
  const name = at.slot.name
  const r = await at.pool.forUser(name, at.slot.folder, req.lease ?? null, () => ops.applyStash(project, folder, req, noSession))
  if (r.ok) return r.value
  throw r.why === 'session' ? combworkError(T.slotSession, { slot: name }) : r.why === 'process' ? combworkError(T.slotProcess, { slot: name }) : combworkError(T.slotChanged, { slot: name }, { kind: 'conflict' })
}

/** `git:dropStash`: Drop, for the Changes root's repository. */
export function dropStashAt(ws: WorkspaceService, root: string, commit: unknown, ops: OpsFor<'stashes'>): Promise<void> {
  return ops.dropStash(ws.changesRootProject(root).project, commitOf(commit))
}
