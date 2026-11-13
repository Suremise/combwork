// HI-2807 (SPEC §16.6.2): Start the next version. From the release branch the project's work merges into now (1.3.0),
// in one go: a new branch (1.4.0) made at the release's head as the user was shown it, the release added to Other
// branches work can merge into, and Work merges into moved to the new branch. What can follow it (Todo cards with no work,
// free slots) is offered as a retarget made with both branches going on (`ongoing`): started cards and running lanes
// stay on the release, whatever the heads say.
//
// One hold: the repository's lock, then this Combwork's turn of workflow writes, as every save of a project's options
// takes them; inside it the save's own core (`saveWorkflowOptions`), never the public wrapper, which would wait on its own
// turn. The branch is made before the save and removed again if the save is refused, only at the commit it was made at
// and while nothing uses it; when it can't be, the error says what was left.

import { CombworkError, combworkError, errorText } from '../combworkError'
import { lineRepoOps } from '../platform/repoOpsPorts'
import type { MadeLineKept } from '../platform/repoOps'
import { lineRepoReads } from '../platform/repoReadsPorts'
import { withFolderRepoLocks } from '../platform/repoPorts'
import { createLogger, userText } from '../logger'
import { msg } from '../../shared/i18n/msg'
import { withValues } from '../../shared/advanced'
import { nextVersionName, type BranchStart, type ResolvedStart } from '../../shared/nextVersion'
import type { PresetId, WorkflowOptions } from '../../shared/workflow/options'
import { merges } from '../../shared/platform/descriptors'
import type { NextVersionPlan, NextVersionResult, RetargetPreview, WorkflowForm } from '../../shared/types'
import type { WorkspaceService } from '../workspace'
import { saveWorkflowOptions, workflowForm } from './optionsForm'
import { retargetPreview } from './retarget'
import { projectTargets } from './targets'
import { workflowWrite } from './writes'
import { queueIntegration } from '../platform/integrationPorts'
import { checkOffer } from './releaseOffer'

const log = createLogger('nextVersion')

const M = {
  notGit: msg({ id: 'service.nextVersion.notGit', defaultMessage: 'Start the next version needs a project using Git.', description: 'HI-2807: Start the next version refused: the project’s version control isn’t Git. Start the next version is an action’s name: as translated there.' }),
  noName: msg({ id: 'service.nextVersion.noName', defaultMessage: 'Name the next version’s branch: {from} doesn’t read as a version to propose one from.', description: 'HI-2807: Start the next version refused: no name was given, and the release branch {from} isn’t a version number (1.3.0), so none could be proposed.' }),
  notBranch: msg({ id: 'service.nextVersion.notBranch', defaultMessage: '{from} isn’t a branch in this repository, so nothing can start from it.', description: 'HI-2807: Start the next version refused: the project’s Work merges into, {from}, isn’t a local branch (a tag of that name doesn’t count).' }),
  sameName: msg({ id: 'service.nextVersion.sameName', defaultMessage: 'The next version needs a branch of its own, not {from}.', description: 'HI-2807: Start the next version refused: the name given is the release branch’s own, {from}.' }),
  movedOn: msg({ id: 'service.nextVersion.movedOn', defaultMessage: 'Work merges into is {now} now, not {from}, so nothing was changed: look again.', description: 'HI-2807: Start the next version refused: the project’s Work merges into (an option’s name: as translated there) changed from {from} to {now} since the dialog opened.' }),
  partial: msg({ id: 'service.nextVersion.partial', defaultMessage: 'Created {name} at {commit}, but the workflow options weren’t saved: {why} {name} was kept ({kept, select, moved {it has moved since} worktree {it is checked out} inUse {it is in use} gone {it is gone} other {it couldn’t be removed}}): delete it in Version Control if it isn’t wanted.', description: 'HI-2807: Start the next version made the branch {name} (at {commit}, a short hash) but saving the options failed ({why}, a sentence), and the branch couldn’t be removed again, for the reason {kept} (keep the select keys).' })
}

/** A save refused after the branch was made, and the branch kept (HI-2807): what the Assistant's undo still needs. */
export class NextVersionPartial extends CombworkError {
  constructor(
    readonly branch: { project: string; name: string; commit: string },
    why: unknown,
    kept: MadeLineKept
  ) {
    super(withValues(M.partial, { name: branch.name, commit: branch.commit.slice(0, 7), why: errorText(why), kept: kept.why }), { kind: 'conflict' })
  }
}

/** What the dialog shows (HI-2807): the release, its head, the proposed name, and what can follow the new branch. */
export async function nextVersionPlan(ws: WorkspaceService, projectPath: string): Promise<NextVersionPlan> {
  const form = await workflowForm(ws, projectPath)
  // A platform whose work merges into a target (Git; HI-2822: by its descriptor, never the id). Making the line is the
  // repository operations port's, which refuses a platform that doesn't list it (HI-2788).
  if (!merges(form.platform)) throw new CombworkError(M.notGit, { kind: 'invalid' })
  const from = (await projectTargets(ws, projectPath))?.default ?? ''
  // The release as its local branch (HR1's round 1, finding 2): a tag of the same name is never its head.
  const found = from ? await lineRepoReads().resolveStart(projectPath, from) : null
  const start = found?.kind === 'branch' ? found : null
  const name = nextVersionName(from) ?? ''
  // HI-3128: under follow mode, what the new branch needs before its first card (read locally; nothing pushed or set).
  const o = form.options
  const follows = o.finish === 'combworkMerges' && o.followRemote === true && from ? await queueIntegration().upstreamRemedy?.(projectPath, name || from, from) : undefined
  const upstream = follows ? { kind: follows.kind, remote: follows.remote, ...(follows.kind === 'unusable' ? { why: follows.why } : {}) } : undefined
  return { from, start, name, base: { preset: form.preset, options: form.own }, listed: (form.options.otherTargets ?? []).includes(from), retarget: name && from ? await previewFor(ws, projectPath, from, name) : null, ...(upstream ? { upstream } : {}) }
}

/** What can follow `to` from `from` with both going on (`ongoing`), or null when nothing is on `from`. */
export async function previewFor(ws: WorkspaceService, projectPath: string, from: string, to: string): Promise<RetargetPreview | null> {
  const p = await retargetPreview(ws, projectPath, from, to, { ongoing: true })
  return p.cards.move.length + p.cards.keep.length + p.slots.move.length + p.slots.keep.length + p.lanes.length + (p.laneMoves?.length ?? 0) ? p : null
}

/**
 * Starts the next version (HI-2807). `from`: the release as the user was shown it (its ref, the project's Work merges
 * into, and its head commit: pinned, refused if either moved); `base`: the options the dialog was read with (refused if
 * they changed: `WorkflowStale`); `check`: the caller's authority, run at the save's write. `preview` (the Assistant's):
 * a retarget preview made inside the hold, before the branch exists, with both going on.
 */
export async function startNextVersion(
  ws: WorkspaceService,
  projectPath: string,
  a: { name?: string; from?: BranchStart; base?: { preset: PresetId | null; options: Partial<WorkflowOptions> }; check?: () => void; preview?: boolean; offer?: string }
): Promise<NextVersionResult> {
  return withFolderRepoLocks([projectPath], () => workflowWrite(() => startLocked(ws, projectPath, a)), { quiet: true, project: projectPath })
}

async function startLocked(ws: WorkspaceService, projectPath: string, a: Parameters<typeof startNextVersion>[2]): Promise<NextVersionResult> {
  a.check?.()
  const form = await workflowForm(ws, projectPath)
  if (!merges(form.platform)) throw new CombworkError(M.notGit, { kind: 'invalid' })
  const release = (await projectTargets(ws, projectPath))?.default ?? ''
  const from: BranchStart = a.from ?? { ref: release, commit: '' }
  if (from.ref !== release) throw combworkError(M.movedOn, { now: release, from: from.ref }, { kind: 'conflict' })
  // HI-3155: started from a release offer's Start…: only while that offer is the project's, on the options it saw.
  if (a.offer) await checkOffer(ws, projectPath, a.offer)
  const name = (a.name ?? '').trim() || nextVersionName(release) || ''
  if (!name) throw combworkError(M.noName, { from: release }, { kind: 'invalid' })
  if (name === release) throw combworkError(M.sameName, { from: release }, { kind: 'invalid' })
  const base = a.base ?? { preset: form.preset, options: form.own }
  // Made before the branch exists, with both going on: the Assistant's offer, which its retarget can't widen.
  const preview = a.preview ? await previewFor(ws, projectPath, release, name) : null
  const others = form.options.otherTargets ?? []
  const listed = others.includes(release)
  const otherTargets = [...new Set([...others, release])].filter((b) => b !== name)
  // Work merges into's own branch, never a tag of its name; made with the caller's authority checked right before git.
  if ((await lineRepoReads().resolveStart(projectPath, release))?.kind !== 'branch') throw combworkError(M.notBranch, { from: release }, { kind: 'invalid' })
  const start: ResolvedStart = await lineRepoOps('createLine').makeLine(projectPath, name, from, a.check)
  let saved: WorkflowForm
  try {
    saved = await saveWorkflowOptions(ws, projectPath, { preset: base.preset, options: { ...base.options, target: name, otherTargets }, base }, { ...(a.check ? { check: a.check } : {}) })
  } catch (e) {
    // Put back as it was: the branch goes only at its commit and while nothing uses it; else what was left is said.
    const r = await lineRepoOps('createLine').removeMadeLine(projectPath, name, start.commit)
    if (r.removed) throw e
    log.warn(`Start the next version: ${userText(name)} kept after a refused save (${r.why})`)
    throw new NextVersionPartial({ project: projectPath, name, commit: start.commit }, e, r)
  }
  log.info(`Started the next version ${userText(name)} from ${userText(release)} (${start.short}) in ${userText(projectPath)}`)
  return { name, from: release, commit: start.commit, short: start.short, added: !listed, form: saved, ...(preview ? { preview } : {}), was: { target: form.own.target, otherTargets: form.own.otherTargets }, now: { target: name, otherTargets } }
}
