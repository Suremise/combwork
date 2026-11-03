// The Merge dialog's merges outside cards (#1450, OP-13; SPEC §16.10.2): it picks a branch (a card's line in a slot, a
// carried slot's branch, any local branch) and a target, not an agent's worktree, and merges as an agent's merge does
// (one at a time, holding the target's merge slot, #350). A line whose card isn't Done is that card's work: the dialog
// says so and merges only once the user has confirmed it for that card (main checks again here), and the merge is then
// observed as one done outside the rules (§16.4.4). A card Hive's merge queue merges is refused here as for an agent's
// merge (ipc.ts, Merge anyway). Reads only #1429's slots and leases and #1434's folder facts, never an agent's worktree.

import { basename } from 'path'
import { mergeBlocked, projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import type { AgentBranchStatus, MergeBranch, MergeBranchList, MergeResult } from '../shared/types'
import { folderFacts } from './agentFolders'
import { checkProject } from './branchWatch'
import { capturedText, HiveError, hiveError } from './hiveError'
import { placeKey, samePlace } from './fsutil'
import { createLogger, userText } from './logger'
import { mergeInProject } from './projectAgents'
import { sessions } from './sessions'
import { workflowFor } from './workflow/service'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'

const log = createLogger('worktrees')

const M = {
  notBranch: msg({ id: 'main.branchMerge.notBranch', defaultMessage: '{branch} is not a local branch of the project.', description: "An error merging from the Merge dialog (#1450): the branch picked ({branch}) isn't one of the repository's local branches (deleted meanwhile, say)." }),
  sameBranch: msg({ id: 'main.branchMerge.same', defaultMessage: "{branch} can't be merged into itself.", description: 'An error merging from the Merge dialog: the branch picked and the target are the same ({branch}).' }),
  cardWork: msg({ id: 'main.branchMerge.cardWork', defaultMessage: "{branch} is {card}'s work: merge it through its card, or confirm merging it here.", description: "An error merging from the Merge dialog: the branch ({branch}) is the line of a card ({card}: its key) that isn't Done, and the merge wasn't confirmed for that card (the dialog asks first)." })
}

/**
 * Every merge route's rule for a card's line (#1450, HR3's round 1 finding 2): a line whose card isn't Done merges only
 * when the request names that card, which the window sends after its confirmation. The Merge a branch dialog, the older
 * Merge dialog (an agent's 0.9 worktree, an unused worktree) and their main routes all pass through here (ipc.ts).
 */
export async function lineConfirmed(projectPath: string, branch: string | null | undefined, card: number | undefined): Promise<void> {
  if (!branch) return
  const line = await lineCard(projectPath, branch)
  if (line && card !== line.number) throw hiveError(M.cardWork, { branch, card: line.key }, { kind: 'conflict' })
}

/** The card whose line `branch` is, while it isn't Done (started, any stage but done; put back too). Null otherwise. */
export async function lineCard(projectPath: string, branch: string): Promise<{ number: number; key: string; title: string } | null> {
  const wf = await workflowFor(workspaceOf(projectPath), projectPath).catch(() => null)
  if (!wf || !branch) return null
  for (const card of wf.store.cards()) {
    let s
    try {
      s = wf.state(card)
    } catch {
      continue
    }
    if (s.started?.line === branch && s.stage !== 'done') return { number: card.id, key: card.key, title: card.title }
  }
  return null
}

/**
 * The branches the dialog offers, by where each is checked out: in a slot (its line, or a carried slot's branch), in
 * another folder, or nowhere; the project folder's own branch only as a target. The targets are every local branch.
 */
export async function mergeBranches(projectPath: string): Promise<MergeBranchList> {
  projectPath = workspace.assertProject(projectPath)
  const [branches, trees, checkedOut, facts] = await Promise.all([wt.localBranches(projectPath), wt.listWorktrees(projectPath), wt.checkedOutBranch(projectPath).catch(() => null), folderFacts(projectPath).catch(() => null)])
  const out: MergeBranch[] = []
  for (const name of branches) {
    if (name === checkedOut) continue
    const tree = trees.find((t) => t.branch === name && placeKey(t.path) !== placeKey(projectPath))
    const slot = tree ? facts?.slots.find((s) => samePlace(s.folder, tree.path)) : undefined
    const carried = !!slot && (slot.open?.kind === 'carried' || (!slot.open && slot.last?.kind === 'carried'))
    const card = await lineCard(projectPath, name)
    out.push({ name, kind: card || (slot && !carried) ? 'line' : carried ? 'carried' : 'branch', ...(tree ? { folder: tree.path } : {}), ...(slot ? { slot: slot.name } : {}), ...(card ? { card } : {}) })
  }
  // Cards' lines first (the slots' work), then carried branches, then the rest, each by name.
  const rank = { line: 0, carried: 1, branch: 2 }
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name))
  return { branches: out, targets: branches, checkedOut }
}

/** Where a branch is checked out, other than the project folder (its uncommitted files aren't merged). */
async function folderOf(projectPath: string, branch: string): Promise<string> {
  const tree = (await wt.listWorktrees(projectPath)).find((t) => t.branch === branch && placeKey(t.path) !== placeKey(projectPath))
  return tree?.path ?? ''
}

/** Checks the branch and the target are local branches and not the same; the branch's folder. */
async function picked(projectPath: string, branch: string, target: string): Promise<string> {
  const local = await wt.localBranches(projectPath)
  for (const b of [branch, target]) if (!local.includes(b)) throw hiveError(M.notBranch, { branch: b })
  if (branch === target) throw hiveError(M.sameBranch, { branch })
  return folderOf(projectPath, branch)
}

/** What `branch` holds that `target` doesn't, as the dialog shows it. */
export async function branchMergeStatus(projectPath: string, branch: string, target: string): Promise<AgentBranchStatus> {
  projectPath = workspace.assertProject(projectPath)
  const folder = await picked(projectPath, branch, target)
  return wt.branchStatus(projectPath, { path: folder, branch, base: target }, undefined, target)
}

/**
 * Merges `branch` into `target` (#1450), as committed: refused while a session in its folder is in the middle of a task
 * (it may still commit). An unfinished card's line is the route's to authorize first (lineConfirmed).
 */
export async function mergeBranch(projectPath: string, branch: string, opts: { target: string; squash: boolean; message: string }): Promise<MergeResult> {
  projectPath = workspace.assertProject(projectPath)
  const folder = await picked(projectPath, branch, opts.target)
  // The card's confirmation is checked by the route (lineConfirmed, with the queue's Merge anyway): here only logged.
  const card = await lineCard(projectPath, branch)
  if (folder) {
    const live = sessions.liveStates().find((s) => s.cwd && samePlace(s.cwd, folder) && s.projectPath.toLowerCase() === projectPath.toLowerCase())
    const name = live ? (projectAgents(await workspace.projectConfig(projectPath)).find((a) => a.id === live.agentId)?.name ?? live.agentId) : ''
    // agent-text: mergeBlocked
    if (live && mergeBlocked(name, live.status)) throw new HiveError(capturedText((t) => mergeBlocked(name, live.status, t))!, { kind: 'conflict' })
  }
  const result = await mergeInProject(projectPath, { path: folder, branch, base: opts.target }, { squash: opts.squash, message: opts.message, target: opts.target })
  if (result.ok) log.info(`Merged ${userText(branch)} into ${userText(opts.target)} in ${userText(basename(projectPath))} from the Merge dialog${card ? ` (card #${card.number}'s line, outside its rules)` : ''}`)
  workspaceOf(projectPath).scheduleRefresh()
  void checkProject(projectPath)
  return result
}
