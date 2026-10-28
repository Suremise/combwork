import { existsSync } from 'original-fs'
import { mkdir, readFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { AgentDef, WorktreeGone } from '../shared/types'
import { projectAgents, slugify } from '../shared/defaults'
import { samePath } from '../shared/movePaths'
import { config } from './config'
import { samePlace } from './fsutil'
import { git } from './git'
import { msg } from '../shared/i18n'
import { HiveError, hiveError } from './hiveError'
import { withValues } from '../shared/advanced'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'
import { copyIgnored, createWorktree, currentBranch, GIT_FAILED, listWorktrees, uniqueFolder } from './worktrees'
import { workflowFor } from './workflow/service'
import { legacyWorktree, slotsMigrated } from './agentFolders'
import type { StoredAgent } from '../shared/agentFolders'
import { projectFolders, recreateSlot, releaseSlotLease, type ProjectFolder } from './projectFolders'
import { folderThere, slotLevelsOf } from './slots'
import { slotCopyOf } from '../shared/slotDefaults'

/**
 * An agent's worktree whose folder is gone (#146): deleted after its work was merged, or a workspace copied to another
 * computer without its worktrees folder. Its branch lives in the repository, so the worktree can be made again on it
 * (Recreate), or, with the branch gone too, made new from its base. Only ever when the folder is truly missing, and
 * never by pruning another worktree's link that something may still need.
 */

const log = createLogger('worktrees')

/** Recreating or unlinking a missing worktree (#848): refusals the window reads in its language, as HiveErrors. */
const M = {
  noAgent: msg({ id: 'worktrees.missing.noAgent', defaultMessage: 'That agent no longer exists.', description: 'An error: the agent whose missing worktree was to be recreated or unlinked was removed meanwhile.' }),
  noTree: msg({ id: 'worktrees.missing.noTree', defaultMessage: "{agent} doesn't work in a worktree.", description: 'An error: the agent {agent} (its name) works in the project folder, so it has no worktree to recreate or unlink.' })
}

const branchExists = async (repo: string, branch: string): Promise<boolean> => (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok

/**
 * The agent's worktree when its folder is missing, with whether its branch survives; null when there's nothing missing.
 * Its 0.9 worktree while the slots' migration hasn't taken it over (#1441); after, the slot it holds (#1447: its card's
 * or lane's, else its carried one), whose folder is gone: `slot` names it, `branch` is its line.
 */
export async function missingWorktree(projectPath: string, agentId: string): Promise<WorktreeGone | null> {
  const a = projectAgents(await workspace.projectConfig(projectPath)).find((x) => x.id === agentId)
  if (!a) return null
  const legacy = legacyWorktree(a)
  if (legacy && !(await slotsMigrated(projectPath, agentId))) {
    if (existsSync(legacy.path)) return null
    return { agentName: a.name, path: legacy.path, branch: legacy.branch, base: legacy.base, branchExists: await branchExists(projectPath, legacy.branch) }
  }
  const f = await goneSlotOf(projectPath, agentId)
  if (!f) return null
  return { agentName: a.name, path: f.folder, branch: f.line ?? '', base: '', branchExists: !!f.line && (await branchExists(projectPath, f.line)), slot: f.name }
}

/** The agent's held slot whose folder is gone (#1447): its card's or lane's first, then its carried one. */
async function goneSlotOf(projectPath: string, agentId: string): Promise<ProjectFolder | null> {
  const mine = (await projectFolders(workspaceOf(projectPath), projectPath)).filter((f) => f.of.kind === 'slot' && f.lease?.agent === agentId)
  const f = mine.find((x) => x.lease?.kind !== 'carried') ?? mine[0]
  // A quiet check has it aside for a moment (HI-1753): read once none is under way.
  return f && !(await folderThere(f.folder)) ? f : null
}

/**
 * Each card of the project whose folder is `from` follows it to `to` (#1343): a FolderMoved fact, so its fold, its view
 * and its reconciliation read the worktree at its new place, and never take it for gone. Written before the agent's
 * record: cut short between the two, the next Repair writes it again, which changes nothing once a card's folder is
 * `to` (the fold only moves the folder it names). A board without the fact log (waiting for its 1.0 upgrade) has none.
 */
export async function moveCardFolders(projectPath: string, from: string, to: string): Promise<void> {
  if (samePath(from, to)) return
  const wf = await workflowFor(workspaceOf(projectPath), projectPath)
  if (!wf) return
  const on = (folder: string | undefined): boolean => !!folder && folder !== 'project' && samePath(folder, from)
  for (const card of wf.store.cards()) {
    if (!on(wf.state(card).started?.folder)) continue
    // Checked again under the write's lock: a card another observer has already moved gets no second fact.
    await wf.write(card, null, 'hive', (w) => {
      if (on(w.state().started?.folder)) w.fact('FolderMoved', { from, to, why: 'repair' }) // i18n-ignore: a fact's kind and codes, not text
    })
  }
}

/**
 * The worktree entries `git worktree prune` would remove (their folders are missing), by the path each was at. Pruning
 * drops git's link to a worktree, which a moved one still needs to be repaired, so it only runs when it would remove
 * nothing but the entries being recreated.
 */
export async function prunable(repo: string): Promise<string[]> {
  const r = await git(repo, ['worktree', 'prune', '--dry-run', '--verbose'])
  if (!r.ok) return []
  const common = (await git(repo, ['rev-parse', '--git-common-dir'])).out.trim()
  const out: string[] = []
  for (const m of `${r.out}\n${r.err}`.matchAll(/^Removing worktrees\/([^:]+):/gm)) {
    const gitdir = await readFile(join(resolve(repo, common), 'worktrees', m[1], 'gitdir'), 'utf8').catch(() => '')
    out.push(gitdir.trim() ? dirname(resolve(gitdir.trim())) : `(${m[1]})`)
  }
  return out
}

/** Whether a folder's parent exists or can be made (an unplugged drive, say, can't). */
async function usableParent(p: string): Promise<boolean> {
  try {
    await mkdir(dirname(p), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Recreating refused: git's prune would also forget the worktrees in `blockers` (missing too, as git lists them: a folder,
 * or "(name)" for a registration whose folder git doesn't record). Repair's report names them (#1313).
 */
export class PruneBlocked extends HiveError {
  constructor(
    m: Parameters<typeof withValues>[0],
    readonly blockers: string[]
  ) {
    super(withValues(m, { folders: blockers.join(', '), n: blockers.length }))
  }
}

/**
 * Makes a missing agent worktree again: on its branch (`git worktree add <path> <branch>`, no -b) when it survives,
 * else a new one from its base (as Add Agent does). At `prefer` (Repair's moved-along place), else the recorded path,
 * else, if that can't be used, the agent's default worktree location. Prunes git's stale entry first, refusing if the
 * prune would drop another worktree's link (unless it is in `alsoRecreating`) or if git still lists the folder as there.
 * Then the copied ignored files and, at the next start, the project's setup command, as for a new worktree; the agent's
 * record is updated under the lock, with, at a new place, the move its sessions and data are to follow (pendingCopies).
 * Its caller finishes that (finishPending in workspaceMove.ts, or Repair).
 */
export async function recreateWorktree(projectPath: string, agentId: string, opts: { prefer?: string; alsoRecreating?: string[] } = {}): Promise<AgentDef> {
  const cfg = await workspace.projectConfig(projectPath)
  const a = projectAgents(cfg).find((x) => x.id === agentId)
  if (!a) throw hiveError(M.noAgent, undefined, { kind: 'notFound' })
  // A gone slot it holds (#1447): made again where it was, on its line, by its pool; its lease kept.
  if (!(legacyWorktree(a) && !(await slotsMigrated(projectPath, agentId)))) {
    const f = await goneSlotOf(projectPath, agentId)
    if (!f) throw hiveError(M.noTree, { agent: a.name })
    if (sessions.liveFor(projectPath, agentId)) throw hiveError(msg({ id: 'worktrees.missing.stopFirst', defaultMessage: 'Stop {agent} first.', description: "An error: the agent {agent} (its name) is running; its missing worktree can't be recreated until it stops." }), { agent: a.name })
    const why = await recreateSlot(workspaceOf(projectPath), projectPath, f, f.folder)
    if (why) throw hiveError(msg({ id: 'worktrees.missing.slotFailed', defaultMessage: "Slot {slot} of agent {agent} couldn't be made again: {why}", description: "An error: a slot lent to the agent {agent} (its name), whose folder was gone, couldn't be made again ({slot}: the slot's name; {why}: why, often git's message in English). A noun before the name (glossary §1 rule 4)." }), { agent: a.name, slot: f.name, why })
    return a
  }
  const old = legacyWorktree(a)
  if (!old) throw hiveError(M.noTree, { agent: a.name })
  if (existsSync(old.path)) throw hiveError(msg({ id: 'worktrees.missing.thereRecreate', defaultMessage: "{agent}'s worktree folder is there ({folder}): there's nothing to recreate.", description: "An error: the worktree folder {folder} of the agent {agent} (its name) exists, so it isn't missing." }), { agent: a.name, folder: old.path })
  if (sessions.liveFor(projectPath, agentId)) throw hiveError(msg({ id: 'worktrees.missing.stopFirst', defaultMessage: 'Stop {agent} first.', description: "An error: the agent {agent} (its name) is running; its missing worktree can't be recreated until it stops." }), { agent: a.name })
  const others = (await prunable(projectPath)).filter((p) => !samePlace(p, old.path) && !(opts.alsoRecreating ?? []).some((q) => samePlace(p, q)))
  if (others.length) {
    throw new PruneBlocked(msg({ id: 'worktrees.missing.wouldPrune', defaultMessage: "Recreating runs git worktree prune, which would also drop git's link to {folders} (missing too). Locate, recreate or remove {n, plural, one {that worktree} other {those worktrees}} first.", description: "An error: recreating a missing worktree runs git worktree prune (a git command: keep it), which would also forget the other missing worktrees {folders} (a list of folders); {n} is how many." }), others)
  }
  await git(projectPath, ['worktree', 'prune'])
  if ((await listWorktrees(projectPath)).some((l) => samePlace(l.path, old.path))) throw hiveError(msg({ id: 'worktrees.missing.stillListed', defaultMessage: 'git still lists {folder} as a worktree (it may be locked): unlock it, or run git worktree prune, then try again.', description: "An error: git still has the missing worktree {folder} on its list, so it can't be recreated there. git worktree prune is a git command: keep it." }), { folder: old.path })
  const fallback = (): string => uniqueFolder(join(workspaceOf(projectPath).worktreesRoot, basename(projectPath), slugify(a.name)))
  let dest = opts.prefer ?? old.path
  if (existsSync(dest) || !(await usableParent(dest))) dest = fallback()
  const onBranch = await branchExists(projectPath, old.branch)
  let base = old.base
  if (onBranch) {
    const r = await git(projectPath, ['worktree', 'add', dest, old.branch])
    if (!r.ok) throw r.err.trim() ? new Error(r.err.trim()) : hiveError(GIT_FAILED, { command: 'git worktree add' }) // i18n-ignore: a git command, as it is
  } else {
    const from = (await branchExists(projectPath, old.base)) ? old.base : await currentBranch(projectPath)
    if (!from) throw hiveError(msg({ id: 'worktrees.missing.noBranch', defaultMessage: "{agent}'s branch {branch} is gone, and the project folder isn't on a branch to start a new one from.", description: "An error: the missing worktree of the agent {agent} (its name) can't be recreated: its branch {branch} is gone too, and there's no branch to make a new one from." }), { agent: a.name, branch: old.branch })
    await createWorktree(projectPath, dest, old.branch, from)
    base = from
  }
  const copied = await copyIgnored(projectPath, dest, slotCopyOf(cfg, slotLevelsOf(config.settings, workspaceOf(projectPath))).value).catch(() => [] as string[])
  log.info(`${onBranch ? 'Recreated' : 'Created a new'} worktree for ${userText(a.name)} at ${userText(dest)} on ${userText(old.branch)}${copied.length ? `; copied ${userText(copied.join(', '))}` : ''}`)
  // At a new place, its sessions and the CLIs' data for the old folder are to follow it (workspaceMove.ts finishes
  // that): the move is recorded in the same locked change as the new path, so a failure or exit after it can't lose it.
  const moved = !samePath(dest, old.path)
  // Its cards' work follows it first (#1343). Should that fail, reconciliation follows it later from the agent's record.
  if (moved) await moveCardFolders(projectPath, old.path, dest).catch((e) => log.warn(`moving ${userText(a.name)}'s cards to its recreated worktree`, e))
  // Repair writes 0.9.3's fields (#1452: StoredAgent): the worktree it had, at its new place; never a new one.
  let next: StoredAgent | undefined
  await workspace.mutateProjectConfig(projectPath, (now) => {
    const setup = !!now.worktreeSetup.trim()
    const agents = projectAgents(now).map((x) => {
      const w = legacyWorktree(x)
      if (x.id !== agentId || !w) return x
      next = { ...x, worktree: { ...w, path: dest, base }, ...(setup ? { needsSetup: true } : {}) }
      return next
    })
    const m = { from: old.path, to: dest, of: `${a.name}'s worktree` } // i18n-ignore: what a pending copy is of, for the log
    const pending = (now.pendingCopies ?? []).filter((x) => !(samePath(x.from, m.from) && samePath(x.to, m.to)))
    return { agents, ...(moved ? { pendingCopies: [...pending, m] } : {}) }
  })
  if (!next) throw hiveError(M.noAgent, undefined, { kind: 'notFound' })
  return next
}

/**
 * Drops the worktree link of an agent whose worktree folder is missing: it works in the project folder from now on. For
 * a gone slot it holds (#1447): the slot's lease released instead (the slot, free, is made again at its next lease).
 */
export async function unlinkMissingWorktree(projectPath: string, agentId: string): Promise<AgentDef> {
  const now = projectAgents(await workspace.projectConfig(projectPath)).find((x) => x.id === agentId)
  if (now && !(legacyWorktree(now) && !(await slotsMigrated(projectPath, agentId)))) {
    const f = await goneSlotOf(projectPath, agentId)
    if (!f) throw hiveError(M.noTree, { agent: now.name })
    await releaseSlotLease(workspaceOf(projectPath), projectPath, f)
    return now
  }
  let next: StoredAgent | undefined
  await workspace.mutateProjectConfig(projectPath, (cfg) => {
    const agents = projectAgents(cfg).map((x) => {
      if (x.id !== agentId) return x
      const w = legacyWorktree(x)
      if (!w) throw hiveError(M.noTree, { agent: x.name })
      if (existsSync(w.path)) throw hiveError(msg({ id: 'worktrees.missing.thereUnlink', defaultMessage: "{agent}'s worktree folder is there ({folder}): remove the agent to remove its worktree.", description: "An error: the worktree folder {folder} of the agent {agent} (its name) exists, so its link can't be dropped as a missing one." }), { agent: x.name, folder: w.path })
      // Written as undefined, so the save carries no stored one back (carryLegacyAgentFields).
      next = { ...x, worktree: undefined, needsSetup: undefined }
      log.info(`Removed ${userText(x.name)}'s link to its missing worktree ${userText(w.path)}`)
      return next
    })
    return { agents }
  })
  if (!next) throw hiveError(M.noAgent, undefined, { kind: 'notFound' })
  return next
}
