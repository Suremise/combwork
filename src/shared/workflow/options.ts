// The Version Control tab's options (SPEC §16.6), their presets and the combinations the compiled table doesn't support
// (§16.5.4, §16.7.2). Outcome-worded options are the only workflow the user sets: they compile into a ruleset
// (compile.ts) from the fixed piece library (pieces.ts).
//
// In the app (#1263): main/workflow/rulesets.ts resolves a project's options (global → workspace → project) and checks
// them; the Version Control tab (#1278) edits them.

import { msg, type Msg } from '../i18n/msg'
import type { PlatformId } from '../platform/descriptors'
import type { StageId } from './facts'

/** G1 / N1: who checks the work before it's done. */
export type ReviewBy = 'none' | 'agent' | 'agentThenYou' | 'you'
/** G5: who finishes a code card. None's only way is acceptance. */
export type Finisher = 'hiveMerges' | 'agentMerges' | 'committed' | 'notChecked' | 'accept'
/** G11: where cards are built. None always works in the project folder (OP-16). */
export type FolderMode = 'slots' | 'project'
/** G9's install: from scratch when the manifests changed (the default, and always so), or before every merge. */
export type MergeInstall = 'onManifestChange' | 'always'
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
  /**
   * G7 named by the project's own options, not inherited from the workspace's or Hive's (#1419, OP-29): never set by a
   * level, worked out as options are resolved, so a card or lane keeps it with the rest of its ruleset. The merge queue
   * merges a card of a project inside a larger repository only when its ruleset has it.
   */
  targetOwn?: true
  /** G8. */
  strict: boolean
  /** G9: named checks on the merged result (Hive merges only). */
  mergeChecks: string[]
  /**
   * G9's install from scratch (#1349, S13): before the merge checks, a clean install whenever the result's manifests
   * differ from the last install in the queue's folder (always, whatever this says), or before every entry's checks.
   */
  mergeInstall: MergeInstall
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
  /**
   * N5: the project's own names for its stages (OP-30), resolved like the other options; a stage it doesn't name keeps
   * its default. Names aren't rules: left out of the compiled ruleset and its hash (compile.ts), so a rename applies at
   * once and never marks anything "old rules" (#1417). Checked by `stageNameProblems` (stages.ts) when saved.
   */
  stageNames?: Partial<Record<StageId, string>>
}

/** The options that are names, not rules (#1417): left out of a ruleset, so changing them alone applies at once. */
export const NAME_OPTIONS: readonly OptionKey[] = ['stageNames']

/**
 * The presets: Solo, Pair and Team (§16.6.3), and P4's Pair, in which the agent merges (`pairAgent`, §16.19.1), kept
 * beside Pair (Hive merges) since P5 (#1355).
 */
export type PresetId = 'solo' | 'pair' | 'team' | 'pairAgent'

/**
 * Why a preset isn't offered yet: the piece it needs comes in a later version (§16.19.1). None does since P5 (#1361:
 * Team on agent worktrees); kept for a preset a later phase adds.
 */
export type PresetNeeds = 'slots'

/**
 * The presets the form offers for a platform, in order, and those it shows unavailable with why (§16.19.1: no RC's preset
 * needs a later phase; shown, not hidden, so the choice reads as P6's will).
 */
export const PRESETS: Record<PlatformId, { id: PresetId; needs?: PresetNeeds }[]> = {
  git: [{ id: 'solo' }, { id: 'pairAgent' }, { id: 'pair' }, { id: 'team' }],
  none: [{ id: 'solo' }, { id: 'pair' }, { id: 'team' }]
}

/** What a preset fills in from the project: its suggested checks (OP-24) with their commands, and the identity G12 shows. */
export interface PresetInputs {
  quick: string[]
  tests: string[]
  commands?: Record<string, string>
  identity?: { name: string; email: string } | null
  /** The repository's default branch, for Pair's and Team's G7 (#1355); `main` when it can't be read. */
  target?: string
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
  mergeInstall: 'onManifestChange',
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
  // §16.6.3's Pair as P5 offers it (#1355): Hive merges with the quick checks on the merged result, in the agent's
  // worktree (§16.19.1). The target is the repository's default branch, named (`main` in the table), so a repository
  // whose default is another branch isn't given one it lacks. G15 (slots up to date) comes with slots (P7).
  const pair: WorkflowOptions = {
    ...allOff('git'),
    review: 'agent',
    noSelfReview: true,
    preChecks: checks.quick,
    finish: 'hiveMerges',
    style: 'merge',
    target: checks.target || 'main',
    mergeChecks: checks.quick,
    mergeInstall: 'onManifestChange',
    folder: 'slots',
    identity: checks.identity ?? null,
    stopOwnRuns: true,
    dependenciesDone: true,
    commands: commandsOf(checks.quick)
  }
  if (id === 'pair') return pair
  // Team (#1361, Darren's point 1 on #1121): as Pair, with the unit tests too before review and on the merged result
  // (each card's own focused tests come later: #1367), installed from scratch before every merge, and your OK for cards
  // labelled ui or release. G15 and G17 wait for slots (P7).
  return { ...pair, preChecks: quickAndTests, mergeChecks: quickAndTests, mergeInstall: 'always', okBefore: { mode: 'labels', labels: ['ui', 'release'] }, commands: commandsOf(quickAndTests) }
}

/** Why a combination of options can't be saved (§16.5.4's contradictions), each a whole sentence. */
export const CONTRADICTIONS = {
  selfReview: msg({ id: 'workflow.contradiction.selfReview', defaultMessage: "“Nobody reviews their own work” can't be off while a reviewer agent checks the work.", description: 'Why workflow options in the Version Control tab cannot be saved: the no-self-review option was turned off while a reviewer agent is required.' }),
  mergeNeedsSlots: msg({ id: 'workflow.contradiction.mergeNeedsSlots', defaultMessage: 'When Hive or the agent merges, each card needs its own folder.', description: 'Why workflow options cannot be saved: a merging option was chosen while everyone works in the project folder.' }),
  committedNeedsFolder: msg({ id: 'workflow.contradiction.committedNeedsFolder', defaultMessage: '“Committed is done” needs everyone in the project folder.', description: 'Why workflow options cannot be saved: “Committed is done” was chosen while each card has its own folder.' }),
  okWithReview: msg({ id: 'workflow.contradiction.okWithReview', defaultMessage: 'Your OK before merging is already part of review by you.', description: "Why workflow options cannot be saved: the user's OK before merging was set while the user already reviews." }),
  hiveMergesNeedsGit: msg({ id: 'workflow.contradiction.hiveMergesNeedsGit', defaultMessage: 'Merging needs Git: without version control, work is accepted where it is.', description: 'Why workflow options cannot be saved: a merge option was set for a project with no version control.' }),
  quorumNeedsAgent: msg({ id: 'workflow.contradiction.quorumNeedsAgent', defaultMessage: 'Two reviewers per card need review by reviewer agents.', description: 'Why workflow options cannot be saved: two reviewers per card were set without reviewer agents.' }),
  subfolderTarget: msg({ id: 'workflow.contradiction.subfolderTarget', defaultMessage: 'This project is inside a larger repository: name the branch its work merges into.', description: 'Why workflow options cannot be saved (OP-29): Hive or the agent merges, but the project is a subfolder of a bigger Git repository and its own options name no target branch (merges would affect the whole repository).' }),
  noneHasNoSlots: msg({ id: 'workflow.contradiction.noneHasNoSlots', defaultMessage: 'Without version control, everyone works in the project folder.', description: 'Why workflow options cannot be saved: separate folders per card were set for a project with no version control.' })
} satisfies Record<string, Msg>

export type Contradiction = keyof typeof CONTRADICTIONS


/** `targetOwn` (#1419): a Git project's target set by its own options. Worked out as options are resolved. */
export const ownsTarget = (o: WorkflowOptions, targetFrom: string): boolean => o.platform === 'git' && !!o.target && targetFrom === 'project'

export const reviewerAgent = (r: ReviewBy): boolean => r === 'agent' || r === 'agentThenYou'
export const reviewByYou = (r: ReviewBy): boolean => r === 'you' || r === 'agentThenYou'

/**
 * A draft's own options after the form sets one (`effective`: the options the form shows). Choosing a reviewer agent
 * turns "Nobody reviews their own work" on where it is off, as the form shows it held (#1508): from All off, the switch
 * that would clear the contradiction is held on and can't be clicked.
 */
export function setOption<K extends OptionKey>(own: Partial<WorkflowOptions>, effective: WorkflowOptions, key: K, value: WorkflowOptions[K]): Partial<WorkflowOptions> {
  const next: Partial<WorkflowOptions> = { ...own, [key]: value }
  if (key === 'review' && reviewerAgent(value as ReviewBy) && !effective.noSelfReview) next.noSelfReview = true
  return next
}

/**
 * The rows each contradiction is about (#1418): the window shows its reason under each of them as the options are
 * chosen, before Save (which checks again under the project's lock).
 */
export const CONTRADICTION_ROWS: Record<Contradiction, OptionKey[]> = {
  selfReview: ['review', 'noSelfReview'],
  mergeNeedsSlots: ['finish', 'folder'],
  committedNeedsFolder: ['finish', 'folder'],
  okWithReview: ['okBefore', 'review'],
  hiveMergesNeedsGit: ['finish'],
  quorumNeedsAgent: ['reviewers', 'review'],
  noneHasNoSlots: ['folder'],
  subfolderTarget: ['target', 'finish']
}

/** Each row's contradictions in these options, by option (#1418: shown under the rows as you choose). */
export function liveContradictions(o: WorkflowOptions, where: ContradictionPlace = {}): Partial<Record<OptionKey, Contradiction[]>> {
  const out: Partial<Record<OptionKey, Contradiction[]>> = {}
  for (const c of contradictions(o, where)) for (const k of CONTRADICTION_ROWS[c]) (out[k] ??= []).push(c)
  return out
}

/** Where the options are for, when a check knows (a save): a project inside a larger repository (OP-29, #1419). */
export interface ContradictionPlace {
  subfolder?: boolean
}

/**
 * The contradictions in a set of options: empty when it can be saved and compiled. `where`: OP-29 (#1419), a project
 * inside a larger repository merges (Hive or the agent) only into a branch it names itself (`targetOwn`: G7 set by the
 * project, not inherited), since its merges change that whole repository.
 */
export function contradictions(o: WorkflowOptions, where: ContradictionPlace = {}): Contradiction[] {
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
  if (where.subfolder && o.platform === 'git' && (o.finish === 'hiveMerges' || o.finish === 'agentMerges') && !o.targetOwn) out.push('subfolderTarget')
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
  targetOwn: (v) => v === true,
  strict: bool,
  mergeChecks: strings,
  mergeInstall: oneOf<MergeInstall>(['onManifestChange', 'always']),
  okBefore: (v) => isRecord(v) && oneOf<OkBefore['mode']>(['never', 'labels', 'every'])(v.mode) && strings(v.labels),
  folder: oneOf<FolderMode>(['slots', 'project']),
  identity: (v) => v === null || (isRecord(v) && typeof v.name === 'string' && typeof v.email === 'string'),
  stopOwnRuns: bool,
  dependenciesDone: bool,
  slotsUpToDate: bool,
  sharedFolderWarning: bool,
  excluded: strings,
  commands: (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string'),
  stageNames: (v) => isRecord(v) && Object.entries(v).every(([k, x]) => (STAGE_IDS as readonly string[]).includes(k) && typeof x === 'string')
}

/** The stage ids a project may name (N5), as stages.ts orders them (kept here so options.ts needs nothing of it). */
const STAGE_IDS: readonly StageId[] = ['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done']

/** Whether a value is one its option takes (false for anything that isn't an option). */
export const takesOption = (key: string, v: unknown): boolean => Object.hasOwn(OPTION_TAKES, key) && OPTION_TAKES[key as OptionKey](v)

/** The Workflow section's groups (#1418), each a heading with its options. */
export type FormGroupId = 'review' | 'checks' | 'merging' | 'where' | 'work' | 'stages' | 'elsewhere'

/**
 * The Workflow section's groups for a platform, in order, and their options (SPEC §16.6.1, §16.6.2; #1418). It offers
 * what this version ships (§16.19.1): G15 and G17 wait for slots (P7). The check commands (`commands`) are edited with
 * the checks that name them. "Shown here, set elsewhere" holds rows whose owner is another setting (N7, Card loops).
 * Some rows show only where they apply (`formShows`).
 */
export const FORM_GROUPS: Record<PlatformId, { id: FormGroupId; options: OptionKey[] }[]> = {
  git: [
    { id: 'review', options: ['review', 'reviewers', 'noSelfReview', 'sameness', 'okBefore'] },
    { id: 'checks', options: ['preChecks', 'mergeChecks', 'mergeInstall'] },
    { id: 'merging', options: ['finish', 'style', 'target', 'strict', 'dependenciesDone'] },
    { id: 'where', options: ['folder', 'identity', 'stopOwnRuns', 'sharedFolderWarning'] },
    { id: 'stages', options: ['stageNames'] },
    { id: 'elsewhere', options: [] }
  ],
  none: [
    { id: 'review', options: ['review', 'noSelfReview'] },
    { id: 'checks', options: ['preChecks'] },
    { id: 'work', options: ['excluded', 'dependenciesDone'] },
    { id: 'stages', options: ['stageNames'] },
    { id: 'elsewhere', options: [] }
  ]
}

/**
 * The rule options the form edits for a platform, in its order (the names, N5, aren't rules: a preset leaves them, and
 * they never make the options Custom).
 */
export const FORM_OPTIONS: Record<PlatformId, OptionKey[]> = {
  git: FORM_GROUPS.git.flatMap((g) => g.options).filter((k) => !NAME_OPTIONS.includes(k)),
  none: FORM_GROUPS.none.flatMap((g) => g.options).filter((k) => !NAME_OPTIONS.includes(k))
}

/**
 * Whether the form shows an option's row for these options (#1355, #1418): G9's merge checks only when Hive merges, and
 * its install only when there are merge checks (with none, nothing is installed); G8 only when Hive merges; G16 only
 * with everyone in the project folder (the only place a commit can take in another agent's files).
 */
export function formShows(key: OptionKey, o: WorkflowOptions): boolean {
  if (key === 'mergeChecks') return o.finish === 'hiveMerges'
  if (key === 'mergeInstall') return o.finish === 'hiveMerges' && o.mergeChecks.length > 0
  // G8 strict (#1352): the merge queue brings work up to date, so only when Hive merges.
  if (key === 'strict') return o.finish === 'hiveMerges'
  if (key === 'sharedFolderWarning') return o.folder === 'project'
  return FORM_GROUPS[o.platform].some((g) => g.options.includes(key))
}

/** Whether every check and balance is off (§16.6.4): the section then says what never turns off. */
export function isAllOff(o: WorkflowOptions): boolean {
  const off = allOff(o.platform)
  return o.review === 'none' && o.preChecks.length === 0 && o.finish === off.finish && o.folder === 'project' && o.okBefore.mode === 'never' && !o.dependenciesDone && !o.stopOwnRuns
}

/** Why a value can't be set yet: its piece comes in a later version (§16.19.1). */
export const NOT_OFFERED = {
  later: msg({ id: 'workflow.notOffered.later', defaultMessage: 'Some of these options aren’t available in this version yet: leave them as they are.', description: 'Why workflow options cannot be saved: an option set (up to date before merging, slots kept up to date) comes in a later version of Hive.' })
} satisfies Record<string, Msg>

/**
 * The values a project sets that this version doesn't offer yet (§16.19.1), by why. Hive merges and merge checks are
 * offered since P5 (#1348's queue, #1355's form), and strict (G8) since #1352.
 */
export function notOffered(own: Partial<WorkflowOptions>): (keyof typeof NOT_OFFERED)[] {
  const out: (keyof typeof NOT_OFFERED)[] = []
  if (own.slotsUpToDate === true) out.push('later')
  return out
}
