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

/**
 * The presets: Solo, Pair and Team (§16.6.3), and P4's Pair, in which the agent merges (`pairAgent`, §16.19.1): what an
 * RC offers before Hive merges (P5) and slots (P7) exist.
 */
export type PresetId = 'solo' | 'pair' | 'team' | 'pairAgent'

/** Why a preset isn't offered yet: the piece it needs comes in a later version (§16.19.1). */
export type PresetNeeds = 'hiveMerges' | 'slots'

/**
 * The presets the form offers for a platform, in order, and those it shows unavailable with why (§16.19.1: no RC's preset
 * needs a later phase; shown, not hidden, so the choice reads as P6's will).
 */
export const PRESETS: Record<PlatformId, { id: PresetId; needs?: PresetNeeds }[]> = {
  git: [{ id: 'solo' }, { id: 'pairAgent' }, { id: 'pair', needs: 'hiveMerges' }, { id: 'team', needs: 'slots' }],
  none: [{ id: 'solo' }, { id: 'pair' }, { id: 'team' }]
}

/** What a preset fills in from the project: its suggested checks (OP-24) with their commands, and the identity G12 shows. */
export interface PresetInputs {
  quick: string[]
  tests: string[]
  commands?: Record<string, string>
  identity?: { name: string; email: string } | null
}

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
export function preset(platform: PlatformId, id: PresetId, checks: PresetInputs = { quick: [], tests: [] }): WorkflowOptions {
  const quickAndTests = [...checks.quick, ...checks.tests]
  // The commands of the checks it names (§16.13: a run counts as a check only as its command).
  const commandsOf = (names: string[]): Record<string, string> => Object.fromEntries(names.filter((n) => checks.commands?.[n]).map((n) => [n, checks.commands![n]]))
  if (platform === 'none') {
    const solo: WorkflowOptions = { ...allOff('none'), dependenciesDone: true }
    if (id === 'solo') return solo
    if (id === 'pair' || id === 'pairAgent') return { ...solo, review: 'agent', noSelfReview: true, preChecks: checks.quick, commands: commandsOf(checks.quick) }
    return { ...solo, review: 'agentThenYou', noSelfReview: true, preChecks: quickAndTests, commands: commandsOf(quickAndTests) }
  }
  if (id === 'solo') return { ...allOff('git'), finish: 'committed', folder: 'project', dependenciesDone: true, sharedFolderWarning: true }
  // §16.19.1: a reviewer agent, the agent merges (merge-ready, then reported), each card in the agent's worktree, the
  // quick checks before review; the repository's default branch as the target.
  if (id === 'pairAgent')
    return {
      ...allOff('git'),
      review: 'agent',
      noSelfReview: true,
      preChecks: checks.quick,
      finish: 'agentMerges',
      style: 'merge',
      folder: 'slots',
      identity: checks.identity ?? null,
      stopOwnRuns: true,
      dependenciesDone: true,
      commands: commandsOf(checks.quick)
    }
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

export type OptionKey = Exclude<keyof WorkflowOptions, 'platform'>

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')
const oneOf =
  <T extends string>(choices: readonly T[]) =>
  (v: unknown): boolean =>
    typeof v === 'string' && (choices as readonly string[]).includes(v)
const bool = (v: unknown): boolean => typeof v === 'boolean'

/**
 * What each option takes: its type and, for a choice, one of its values (HR2's #1263 round 1: compiling checks only
 * contradictions). Every option has its check (a new one fails the typecheck until it has).
 */
export const OPTION_TAKES: Record<OptionKey, (v: unknown) => boolean> = {
  review: oneOf<ReviewBy>(['none', 'agent', 'agentThenYou', 'you']),
  reviewers: (v) => v === 1 || v === 2,
  noSelfReview: bool,
  preChecks: strings,
  sameness: oneOf<WorkflowOptions['sameness']>(['change', 'exact']),
  finish: oneOf<Finisher>(['hiveMerges', 'agentMerges', 'committed', 'notChecked', 'accept']),
  style: oneOf<WorkflowOptions['style']>(['merge', 'squash']),
  target: (v) => typeof v === 'string',
  strict: bool,
  mergeChecks: strings,
  okBefore: (v) => isRecord(v) && oneOf<OkBefore['mode']>(['never', 'labels', 'every'])(v.mode) && strings(v.labels),
  folder: oneOf<FolderMode>(['slots', 'project']),
  identity: (v) => v === null || (isRecord(v) && typeof v.name === 'string' && typeof v.email === 'string'),
  stopOwnRuns: bool,
  dependenciesDone: bool,
  slotsUpToDate: bool,
  sharedFolderWarning: bool,
  excluded: strings,
  commands: (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string')
}

/** Whether a value is one its option takes (false for anything that isn't an option). */
export const takesOption = (key: string, v: unknown): boolean => Object.hasOwn(OPTION_TAKES, key) && OPTION_TAKES[key as OptionKey](v)

/**
 * The options P4's form shows for a platform, in order (§16.6.1, §16.6.2; #1278). P4 offers only what it ships
 * (§16.19.1): G8 strict, G9 merge checks, G15 and G17 wait for Hive merges and slots, and None's stage names (N5) for the
 * Version Control tab. The check commands (`commands`) are edited with the checks that name them.
 */
export const FORM_OPTIONS: Record<PlatformId, OptionKey[]> = {
  git: ['review', 'reviewers', 'noSelfReview', 'preChecks', 'sameness', 'finish', 'style', 'target', 'okBefore', 'folder', 'identity', 'stopOwnRuns', 'dependenciesDone', 'sharedFolderWarning'],
  none: ['review', 'noSelfReview', 'preChecks', 'excluded', 'dependenciesDone']
}

/** Why a value can't be set yet: its piece comes in a later version (§16.19.1). */
export const NOT_OFFERED = {
  hiveMerges: msg({ id: 'workflow.notOffered.hiveMerges', defaultMessage: '“Hive merges” isn’t available in this version yet: choose “The agent merges, Hive checks”.', description: 'Why workflow options cannot be saved: Hive merging cards itself comes in a later version of Hive.' }),
  later: msg({ id: 'workflow.notOffered.later', defaultMessage: 'Some of these options aren’t available in this version yet: leave them as they are.', description: 'Why workflow options cannot be saved: an option set (merge checks, up to date before merging, slots kept up to date) comes in a later version of Hive.' })
} satisfies Record<string, Msg>

/** The values a project sets that this version doesn't offer yet (§16.19.1), by why. */
export function notOffered(own: Partial<WorkflowOptions>): (keyof typeof NOT_OFFERED)[] {
  const out: (keyof typeof NOT_OFFERED)[] = []
  if (own.finish === 'hiveMerges') out.push('hiveMerges')
  if (own.strict === true || (own.mergeChecks?.length ?? 0) > 0 || own.slotsUpToDate === true) out.push('later')
  return out
}
