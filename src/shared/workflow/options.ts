// The Version Control tab's options (SPEC §16.6), their presets and the combinations the compiled table doesn't support
// (§16.5.4, §16.7.2). Outcome-worded options are the only workflow the user sets: they compile into a ruleset
// (compile.ts) from the fixed piece library (pieces.ts).
//
// In the app (#1263): main/workflow/rulesets.ts resolves a project's options (global → workspace → project) and checks
// them; the Version Control tab (#1278) edits them.

import { msg, type Msg } from '../i18n/msg'
import type { PlatformId } from '../platform/descriptors'

/** G1 / N1: who checks the work before it's done. */
export type ReviewBy = 'none' | 'agent' | 'agentThenYou' | 'you'
/** G5: who finishes a code card. None's only way is acceptance. */
export type Finisher = 'hiveMerges' | 'agentMerges' | 'committed' | 'notChecked' | 'accept'
/** G11: where cards are built. None always works in the project folder (OP-16). */
export type FolderMode = 'slots' | 'project'
/** G10: your OK before merging. */
export interface OkBefore {
  mode: 'never' | 'labels' | 'every'
  labels: string[]
}

export interface WorkflowOptions {
  platform: PlatformId
  /** G1 / N1. */
  review: ReviewBy
  /** G1b: distinct reviewers who must pass the same change. */
  reviewers: 1 | 2
  /** G2 / N2: fixed on while a reviewer agent checks; off only with no reviewer. */
  noSelfReview: boolean
  /** G3 / N3: named checks that must pass on the revision before review. */
  preChecks: string[]
  /** G4: a pass survives a clean rebase (same change), or only the exact revision. */
  sameness: 'change' | 'exact'
  /** G5 (Git); None is always `accept`. */
  finish: Finisher
  /** G6. */
  style: 'merge' | 'squash'
  /** G7: the target line; empty means the repository's default branch. */
  target: string
  /** G8. */
  strict: boolean
  /** G9: named checks on the merged result (Hive merges only). */
  mergeChecks: string[]
  /** G10. */
  okBefore: OkBefore
  /** G11. */
  folder: FolderMode
  /** G12: the project's identity, when on. */
  identity: { name: string; email: string } | null
  /** G13. */
  stopOwnRuns: boolean
  /** G14 / N6. */
  dependenciesDone: boolean
  /** G15. */
  slotsUpToDate: boolean
  /** G16. */
  sharedFolderWarning: boolean
  /** N4: folders and files left out of None's deliverables (`.hive` always is). */
  excluded: string[]
  /** The command of each named check (G3, G9, N3): a run counts as a check only as that command (§16.13). */
  commands: Record<string, string>
}

export type PresetId = 'solo' | 'pair' | 'team'

const BASE: Omit<WorkflowOptions, 'platform'> = {
  review: 'none',
  reviewers: 1,
  noSelfReview: false,
  preChecks: [],
  sameness: 'change',
  finish: 'notChecked',
  style: 'merge',
  target: '',
  strict: false,
  mergeChecks: [],
  okBefore: { mode: 'never', labels: [] },
  folder: 'project',
  identity: null,
  stopOwnRuns: false,
  dependenciesDone: false,
  slotsUpToDate: false,
  sharedFolderWarning: false,
  excluded: ['node_modules', '.venv'],
  commands: {}
}

/**
 * Every check and balance off (§16.6.4): cards move freely, facts are still recorded. Also a new project's options
 * before a preset is chosen (§16.7.4).
 */
export function allOff(platform: PlatformId): WorkflowOptions {
  return { ...BASE, platform, finish: platform === 'none' ? 'accept' : 'notChecked' }
}

/**
 * The presets (§16.6.3, OP-3). `quick` and `tests` are the project's suggested check names (OP-24: suggested from its
 * scripts, never guessed silently), passed in by whoever offers the preset.
 */
export function preset(platform: PlatformId, id: PresetId, checks: { quick: string[]; tests: string[] } = { quick: [], tests: [] }): WorkflowOptions {
  const quickAndTests = [...checks.quick, ...checks.tests]
  if (platform === 'none') {
    const solo: WorkflowOptions = { ...allOff('none'), dependenciesDone: true }
    if (id === 'solo') return solo
    if (id === 'pair') return { ...solo, review: 'agent', noSelfReview: true, preChecks: checks.quick }
    return { ...solo, review: 'agentThenYou', noSelfReview: true, preChecks: quickAndTests }
  }
  if (id === 'solo') return { ...allOff('git'), finish: 'committed', folder: 'project', dependenciesDone: true, sharedFolderWarning: true }
  const pair: WorkflowOptions = {
    ...allOff('git'),
    review: 'agent',
    noSelfReview: true,
    preChecks: checks.quick,
    finish: 'hiveMerges',
    style: 'merge',
    target: 'main',
    mergeChecks: checks.quick,
    folder: 'slots',
    stopOwnRuns: true,
    dependenciesDone: true,
    slotsUpToDate: true
  }
  if (id === 'pair') return pair
  return { ...pair, preChecks: quickAndTests, mergeChecks: quickAndTests, okBefore: { mode: 'labels', labels: ['ui', 'release'] } }
}

/** Why a combination of options can't be saved (§16.5.4's contradictions), each a whole sentence. */
export const CONTRADICTIONS = {
  selfReview: msg({ id: 'workflow.contradiction.selfReview', defaultMessage: "“Nobody reviews their own work” can't be off while a reviewer agent checks the work.", description: 'Why workflow options in the Version Control tab cannot be saved: the no-self-review option was turned off while a reviewer agent is required.' }),
  mergeNeedsSlots: msg({ id: 'workflow.contradiction.mergeNeedsSlots', defaultMessage: 'When Hive or the agent merges, each card needs its own folder.', description: 'Why workflow options cannot be saved: a merging option was chosen while everyone works in the project folder.' }),
  committedNeedsFolder: msg({ id: 'workflow.contradiction.committedNeedsFolder', defaultMessage: '“Committed is done” needs everyone in the project folder.', description: 'Why workflow options cannot be saved: “Committed is done” was chosen while each card has its own folder.' }),
  okWithReview: msg({ id: 'workflow.contradiction.okWithReview', defaultMessage: 'Your OK before merging is already part of review by you.', description: "Why workflow options cannot be saved: the user's OK before merging was set while the user already reviews." }),
  hiveMergesNeedsGit: msg({ id: 'workflow.contradiction.hiveMergesNeedsGit', defaultMessage: 'Merging needs Git: without version control, work is accepted where it is.', description: 'Why workflow options cannot be saved: a merge option was set for a project with no version control.' }),
  quorumNeedsAgent: msg({ id: 'workflow.contradiction.quorumNeedsAgent', defaultMessage: 'Two reviewers per card need review by reviewer agents.', description: 'Why workflow options cannot be saved: two reviewers per card were set without reviewer agents.' }),
  noneHasNoSlots: msg({ id: 'workflow.contradiction.noneHasNoSlots', defaultMessage: 'Without version control, everyone works in the project folder.', description: 'Why workflow options cannot be saved: separate folders per card were set for a project with no version control.' })
} satisfies Record<string, Msg>

export type Contradiction = keyof typeof CONTRADICTIONS

export const reviewerAgent = (r: ReviewBy): boolean => r === 'agent' || r === 'agentThenYou'
export const reviewByYou = (r: ReviewBy): boolean => r === 'you' || r === 'agentThenYou'

/** The contradictions in a set of options: empty when it can be saved and compiled. */
export function contradictions(o: WorkflowOptions): Contradiction[] {
  const out: Contradiction[] = []
  if (reviewerAgent(o.review) && !o.noSelfReview) out.push('selfReview')
  if (o.reviewers === 2 && !reviewerAgent(o.review)) out.push('quorumNeedsAgent')
  if (o.platform === 'none') {
    if (o.finish !== 'accept') out.push('hiveMergesNeedsGit')
    if (o.folder !== 'project') out.push('noneHasNoSlots')
  } else {
    if (o.finish === 'accept') out.push('hiveMergesNeedsGit')
    if ((o.finish === 'hiveMerges' || o.finish === 'agentMerges') && o.folder !== 'slots') out.push('mergeNeedsSlots')
    if (o.finish === 'committed' && o.folder !== 'project') out.push('committedNeedsFolder')
  }
  if (o.okBefore.mode !== 'never' && reviewByYou(o.review)) out.push('okWithReview')
  return out
}
