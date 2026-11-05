// The Version Control tab's options (SPEC §16.6), their presets and the combinations the compiled table doesn't support
// (§16.5.4, §16.7.2). Outcome-worded options are the only workflow the user sets: they compile into a ruleset
// (compile.ts) from the fixed piece library (pieces.ts).
//
// In the app (#1263): main/workflow/rulesets.ts resolves a project's options (global → workspace → project) and checks
// them; the Version Control tab (#1278) edits them.

import { msg, type Msg } from '../i18n/msg'
import type { PlatformId } from '../platform/descriptors'
import type { FileLockMode } from '../types'
import { LANE_MAX_ROUNDS, LOOP_STEP_WAIT_MAX_MINUTES, LOOP_WAIT_MAX_HOURS } from '../loopLimits'
import { AGENT_LIMIT_DEFAULT, AGENT_LIMIT_MAX } from '../agentLimits'
import type { StageId } from './facts'
import type { ReviewerMode } from './roles'

/** G1 / N1: who checks the work before it's done. */
export type ReviewBy = 'none' | 'agent' | 'agentThenYou' | 'you'
/** G5: who finishes a code card. None's only way is acceptance. */
export type Finisher = 'hiveMerges' | 'agentMerges' | 'committed' | 'notChecked' | 'accept'
/** G11: where cards are built. None always works in the project folder (OP-16). */
export type FolderMode = 'slots' | 'project'
/** G9's install: from scratch when the manifests changed (the default, and always so), or before every merge. */
export type MergeInstall = 'onManifestChange' | 'always'
/** G19: the message of Hive's merge commit: Hive's (`KEY: title` and trailers) or the branch's own. */
export type CommitMessage = 'hive' | 'branch'
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
  style: 'merge' | 'squash' | 'rebase'
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
  /**
   * G18 (#1179): the merge queue pushes its target to the target's remote after each merge (Hive merges only), never
   * forced. Not a rule: left out of every ruleset (`ruleOptions`), so the queue reads it from the project's options as
   * they are when it pushes, and turning it off takes effect at once.
   */
  pushTarget: boolean
  /**
   * G19 (HI-1697; the branch's own by default since HI-1997): the message of the commit Hive's merge makes (a merge commit, or a squash's commit): Hive's, the
   * card's key and title with its `Hive-` trailers, or the branch's own, with neither. Not a rule, as G18: left out of
   * every ruleset (`ruleOptions`), the queue reads it from the project's options as they are when it merges.
   */
  commitMessage: CommitMessage
  /** G9: named checks on the merged result (Hive merges only). */
  mergeChecks: string[]
  /**
   * G9's install from scratch (#1349, S13): before the merge checks, a clean install whenever the result's manifests
   * differ from the last install in the queue's folder (always, whatever this says), or before every entry's checks.
   */
  mergeInstall: MergeInstall
  /**
   * G20 (HI-1367): each card's focused tests, chosen when it is submitted by the project's picker (`focused.pick` in
   * `commands`) or named by its builder, and run by the merge queue at the merged result with its runner (`focused.run`).
   * Hive merges only.
   */
  focusedTests: boolean
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
  /**
   * G17 (#1443): one reviewer per lane, or a shared pool that takes the next submitted card, oldest first. Git only (None
   * has no G17); unset reads as `lane` (`reviewerModeOf`), and `lane` is left out of a ruleset (`ruleOptions`), so every
   * ruleset from before P7 keeps its id.
   */
  reviewerMode?: ReviewerMode
  /** N4: folders and files left out of None's deliverables (`.combwork` always is). */
  excluded: string[]
  /**
   * The command of each named check (G3, G9, N3): a run counts as a check only as that command (§16.13). G20's picker and
   * runner are `focused.pick` and `focused.run` (FOCUSED_PICK, FOCUSED_RUN), which no check can be named.
   */
  commands: Record<string, string>
  /**
   * N5: the project's own names for its stages (OP-30), resolved like the other options; a stage it doesn't name keeps
   * its default. Names aren't rules: left out of the compiled ruleset and its hash (compile.ts), so a rename applies at
   * once and never marks anything "old rules" (#1417). Checked by `stageNameProblems` (stages.ts) when saved.
   */
  stageNames?: Partial<Record<StageId, string>>
  /**
   * Card loops (HI-1766, before 1.0 Project Settings → Card loops and the workspace's): Hive wakes a card's reviewer and
   * builder for its handoffs; a loop's rounds and wait when its lane doesn't say (read when the lane registers); the
   * time a design or follow-up step waits for its reviewer. Preferences, not rules (`PREFERENCE_OPTIONS`): unset reads
   * as `PREFERENCE_DEFAULTS` (preferences.ts).
   */
  loopWakes?: boolean
  loopRounds?: number
  loopWaitHours?: number
  loopStepWaitMinutes?: number
  /** File locks between agents in the same folder, outside a slot (HI-1766, before 1.0 Settings → Agents). */
  fileLocks?: FileLockMode
  /**
   * Maximum agents (HI-2001, before Settings → Advanced → Agents per project): the user's team size, the most agents the
   * Assistant and the Agent API add to the project (the user adds more by hand, up to AGENT_LIMIT_MAX). Resolved like the
   * preferences and not a rule, but set by the presets and All off (`PRESET_PREFERENCES`), never making them Custom.
   */
  maxAgents?: number
}

/** G20's picker and runner, in `commands` (HI-1367): reserved names, never a check's. */
export const FOCUSED_PICK = 'focused.pick'
export const FOCUSED_RUN = 'focused.run'

/** The options that are names, not rules (#1417): left out of a ruleset, so changing them alone applies at once. */
export const NAME_OPTIONS: readonly OptionKey[] = ['stageNames']

/**
 * How agents work together, not rules (HI-1766): left out of every ruleset (so a change applies at once and marks
 * nothing "old rules"), never set by a preset or All off (but Maximum agents, `PRESET_PREFERENCES`), never making the
 * options Custom. A lane keeps the rounds and wait it registered with.
 */
export const PREFERENCE_OPTIONS = ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes', 'fileLocks', 'maxAgents'] as const satisfies readonly OptionKey[]
export type PreferenceKey = (typeof PREFERENCE_OPTIONS)[number]

/**
 * The preferences a preset and All off do set (HI-2001): Maximum agents, the team each is for. They still never make
 * the options Custom: a team of another size works the same way.
 */
export const PRESET_PREFERENCES: readonly OptionKey[] = ['maxAgents']

/** The options no preset sets (names and preferences): a choice of preset keeps a project's or level's own. */
export const UNPRESET_OPTIONS: readonly OptionKey[] = [...NAME_OPTIONS, ...PREFERENCE_OPTIONS.filter((k) => !PRESET_PREFERENCES.includes(k))]

/** The options that never make a preset Custom: the names and every preference, Maximum agents too. */
const NOT_CUSTOM: readonly OptionKey[] = [...NAME_OPTIONS, ...PREFERENCE_OPTIONS]

/** A preset's or All off's own options, with the draft's own names and preferences kept (HI-1766, #1417). */
export function withUnpreset(chosen: Partial<WorkflowOptions>, own: Partial<WorkflowOptions>): Partial<WorkflowOptions> {
  const kept = Object.fromEntries(UNPRESET_OPTIONS.filter((k) => own[k] !== undefined).map((k) => [k, own[k]]))
  const fresh = Object.fromEntries(Object.entries(chosen).filter(([k]) => !UNPRESET_OPTIONS.includes(k as OptionKey)))
  return { ...fresh, ...kept }
}

/**
 * The presets: Solo, Pair and Team (§16.6.3), and P4's Pair, in which the agent merges (`pairAgent`, §16.19.1), kept
 * beside Pair (Hive merges) since P5 (#1355).
 */
export type PresetId = 'solo' | 'pair' | 'team' | 'pairAgent'

/** The presets the form offers for a platform, in order (every one since P7: #1445). */
export const PRESETS: Record<PlatformId, { id: PresetId }[]> = {
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
  /** G20's commands (HI-1367), when the project has them: Team turns G20 on only with a runner. */
  focused?: { pick?: string; run?: string }
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
  pushTarget: false,
  // G19 (HI-1997, Darren's decision): the branch's own message in every preset, so card titles never reach a history unasked.
  commitMessage: 'branch',
  mergeChecks: [],
  mergeInstall: 'onManifestChange',
  focusedTests: false,
  okBefore: { mode: 'never', labels: [] },
  folder: 'project',
  identity: null,
  stopOwnRuns: false,
  dependenciesDone: false,
  slotsUpToDate: false,
  sharedFolderWarning: false,
  reviewerMode: 'lane',
  excluded: ['node_modules', '.venv'],
  commands: {},
  maxAgents: AGENT_LIMIT_DEFAULT
}

/**
 * Every check and balance off (§16.6.4): cards move freely, facts are still recorded. Also a new project's options
 * before a preset is chosen (§16.7.4). None has no G17, so no level sets it there.
 */
export function allOff(platform: PlatformId): WorkflowOptions {
  if (platform === 'none') {
    const { reviewerMode: _g17, ...none } = BASE
    return { ...none, platform, finish: 'accept' }
  }
  return { ...BASE, platform, finish: 'notChecked' }
}

/** G17 as a ruleset or options have it: unset (a ruleset from before P7, None) is one reviewer per lane. */
export const reviewerModeOf = (o: Pick<WorkflowOptions, 'reviewerMode'>): ReviewerMode => o.reviewerMode ?? 'lane'

/**
 * Each preset's Maximum agents (HI-2001, Darren's decision): the team it describes. Solo is one agent, Pair a builder
 * and a reviewer, Team (and All off, `BASE`) the default of 12.
 */
export const PRESET_TEAM: Record<PresetId, number> = { solo: 1, pair: 2, pairAgent: 2, team: AGENT_LIMIT_DEFAULT }

/**
 * The presets (§16.6.3, OP-3). `quick` and `tests` are the project's suggested check names (OP-24: suggested from its
 * scripts, never guessed silently), passed in by whoever offers the preset.
 */
export function preset(platform: PlatformId, id: PresetId, checks: PresetInputs = { quick: [], tests: [] }): WorkflowOptions {
  const quickAndTests = [...checks.quick, ...checks.tests]
  // The commands of the checks it names (§16.13: a run counts as a check only as its command).
  const commandsOf = (names: string[]): Record<string, string> => Object.fromEntries(names.filter((n) => checks.commands?.[n]).map((n) => [n, checks.commands![n]]))
  if (platform === 'none') {
    const solo: WorkflowOptions = { ...allOff('none'), dependenciesDone: true, maxAgents: PRESET_TEAM.solo }
    if (id === 'solo') return solo
    if (id === 'pair' || id === 'pairAgent') return { ...solo, review: 'agent', noSelfReview: true, preChecks: checks.quick, commands: commandsOf(checks.quick), maxAgents: PRESET_TEAM.pair }
    return { ...solo, review: 'agentThenYou', noSelfReview: true, preChecks: quickAndTests, commands: commandsOf(quickAndTests), maxAgents: PRESET_TEAM.team }
  }
  if (id === 'solo') return { ...allOff('git'), finish: 'committed', folder: 'project', dependenciesDone: true, sharedFolderWarning: true, maxAgents: PRESET_TEAM.solo }
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
      slotsUpToDate: true,
      reviewerMode: 'lane',
      commands: commandsOf(checks.quick),
      maxAgents: PRESET_TEAM.pairAgent
    }
  // §16.6.3's Pair (#1355, at its full values since P7: #1445): Hive merges with the quick checks on the merged result,
  // each card in a slot brought up to date before it (G15), one reviewer per lane (G17). The target is the repository's
  // default branch, named (`main` in the table), so a repository whose default is another branch isn't given one it lacks.
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
    slotsUpToDate: true,
    reviewerMode: 'lane',
    commands: commandsOf(checks.quick),
    maxAgents: PRESET_TEAM.pair
  }
  if (id === 'pair') return pair
  // Team (#1361, Darren's point 1 on #1121): as Pair, with the unit tests too before review and on the merged result,
  // each card's own focused tests there too (G20, HI-1367: only with the project's runner, else off, the form saying
  // why), installed from scratch before every merge, and your OK for cards labelled ui or release. G15 and G17 as Pair's:
  // slots up to date, one reviewer per lane (a pool is the Team 6 + pool template's choice, §16.6.3).
  const focused = checks.focused?.run ? { [FOCUSED_RUN]: checks.focused.run, ...(checks.focused.pick ? { [FOCUSED_PICK]: checks.focused.pick } : {}) } : null
  return { ...pair, preChecks: quickAndTests, mergeChecks: quickAndTests, mergeInstall: 'always', focusedTests: !!focused, okBefore: { mode: 'labels', labels: ['ui', 'release'] }, commands: { ...commandsOf(quickAndTests), ...focused }, maxAgents: PRESET_TEAM.team }
}

/** Why a combination of options can't be saved (§16.5.4's contradictions), each a whole sentence. */
export const CONTRADICTIONS = {
  selfReview: msg({ id: 'workflow.contradiction.selfReview', defaultMessage: "“Nobody reviews their own work” can't be off while a reviewer agent checks the work.", description: 'Why workflow options in the Version Control tab cannot be saved: the no-self-review option was turned off while a reviewer agent is required.' }),
  mergeNeedsSlots: msg({ id: 'workflow.contradiction.mergeNeedsSlots', defaultMessage: 'When Combwork or the agent merges, each card needs its own folder.', description: 'Why workflow options cannot be saved: a merging option was chosen while everyone works in the project folder.' }),
  committedNeedsFolder: msg({ id: 'workflow.contradiction.committedNeedsFolder', defaultMessage: '“Committed is done” needs everyone in the project folder.', description: 'Why workflow options cannot be saved: “Committed is done” was chosen while each card has its own folder.' }),
  okWithReview: msg({ id: 'workflow.contradiction.okWithReview', defaultMessage: 'Your OK before merging is already part of review by you.', description: "Why workflow options cannot be saved: the user's OK before merging was set while the user already reviews." }),
  hiveMergesNeedsGit: msg({ id: 'workflow.contradiction.hiveMergesNeedsGit', defaultMessage: 'Merging needs Git: without version control, work is accepted where it is.', description: 'Why workflow options cannot be saved: a merge option was set for a project with no version control.' }),
  quorumNeedsAgent: msg({ id: 'workflow.contradiction.quorumNeedsAgent', defaultMessage: 'Two reviewers per card need review by reviewer agents.', description: 'Why workflow options cannot be saved: two reviewers per card were set without reviewer agents.' }),
  upToDateNeedsSlots: msg({ id: 'workflow.contradiction.upToDateNeedsSlots', defaultMessage: 'Slots are brought up to date only when each card has its own folder.', description: 'Why workflow options cannot be saved: “Slots are brought up to date before each card” (G15) was set while everyone works in the project folder (glossary 2.5: slot).' }),
  poolNeedsAgent: msg({ id: 'workflow.contradiction.poolNeedsAgent', defaultMessage: 'A shared pool of reviewers needs review by reviewer agents.', description: 'Why workflow options cannot be saved: “Reviewers” was set to a shared pool (reviewer agents lanes share) without review by reviewer agents.' }),
  focusedNeedsRunner: msg({ id: 'workflow.contradiction.focusedNeedsRunner', defaultMessage: 'Each card’s focused tests need the command that runs them.', description: 'Why workflow options cannot be saved (G20): “Each card’s focused tests” is on but the project has no command to run them (its runner, focused.run).' }),
  subfolderTarget: msg({ id: 'workflow.contradiction.subfolderTarget', defaultMessage: 'This project is inside a larger repository: name the branch its work merges into.', description: 'Why workflow options cannot be saved (OP-29): Combwork or the agent merges, but the project is a subfolder of a bigger Git repository and its own options name no target branch (merges would affect the whole repository).' }),
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
 * that would clear the contradiction is held on and can't be clicked. Everyone in the project folder turns G15 off.
 */
export function setOption<K extends OptionKey>(own: Partial<WorkflowOptions>, effective: WorkflowOptions, key: K, value: WorkflowOptions[K]): Partial<WorkflowOptions> {
  const next: Partial<WorkflowOptions> = { ...own, [key]: value }
  if (key === 'review' && reviewerAgent(value as ReviewBy) && !effective.noSelfReview) next.noSelfReview = true
  // G15 depends on G11 alone (#1445): everyone in the project folder hides it, so it goes Off with it, never left On out
  // of sight as a contradiction nobody can reach.
  if (key === 'folder' && value === 'project' && effective.slotsUpToDate) next.slotsUpToDate = false
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
  poolNeedsAgent: ['reviewerMode', 'review'],
  upToDateNeedsSlots: ['slotsUpToDate', 'folder'],
  noneHasNoSlots: ['folder'],
  focusedNeedsRunner: ['focusedTests'],
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
  if (reviewerModeOf(o) === 'pool' && !reviewerAgent(o.review)) out.push('poolNeedsAgent')
  if (o.platform === 'none') {
    if (o.finish !== 'accept') out.push('hiveMergesNeedsGit')
    if (o.folder !== 'project') out.push('noneHasNoSlots')
  } else {
    if (o.finish === 'accept') out.push('hiveMergesNeedsGit')
    if ((o.finish === 'hiveMerges' || o.finish === 'agentMerges') && o.folder !== 'slots') out.push('mergeNeedsSlots')
    if (o.finish === 'committed' && o.folder !== 'project') out.push('committedNeedsFolder')
    // G15 depends on G11 alone (#1445): only a slot is brought up to date.
    if (o.slotsUpToDate && o.folder !== 'slots') out.push('upToDateNeedsSlots')
    // G20 (HI-1367): its runner is needed; its picker isn't (without one, every card names its own tests).
    if (o.focusedTests && o.finish === 'hiveMerges' && !o.commands[FOCUSED_RUN]?.trim()) out.push('focusedNeedsRunner')
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
/** A whole number from 1 to `max` (the card loops' limits, as before HI-1766). */
const whole =
  (max: number) =>
  (v: unknown): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max

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
  style: oneOf<WorkflowOptions['style']>(['merge', 'squash', 'rebase']),
  target: (v) => typeof v === 'string',
  targetOwn: (v) => v === true,
  strict: bool,
  pushTarget: bool,
  commitMessage: oneOf<CommitMessage>(['hive', 'branch']),
  mergeChecks: strings,
  mergeInstall: oneOf<MergeInstall>(['onManifestChange', 'always']),
  focusedTests: bool,
  okBefore: (v) => isRecord(v) && oneOf<OkBefore['mode']>(['never', 'labels', 'every'])(v.mode) && strings(v.labels),
  folder: oneOf<FolderMode>(['slots', 'project']),
  identity: (v) => v === null || (isRecord(v) && typeof v.name === 'string' && typeof v.email === 'string'),
  stopOwnRuns: bool,
  dependenciesDone: bool,
  slotsUpToDate: bool,
  sharedFolderWarning: bool,
  reviewerMode: oneOf<ReviewerMode>(['lane', 'pool']),
  excluded: strings,
  commands: (v) => isRecord(v) && Object.values(v).every((x) => typeof x === 'string'),
  stageNames: (v) => isRecord(v) && Object.entries(v).every(([k, x]) => (STAGE_IDS as readonly string[]).includes(k) && typeof x === 'string'),
  loopWakes: bool,
  loopRounds: whole(LANE_MAX_ROUNDS),
  loopWaitHours: whole(LOOP_WAIT_MAX_HOURS),
  loopStepWaitMinutes: whole(LOOP_STEP_WAIT_MAX_MINUTES),
  fileLocks: oneOf<FileLockMode>(['off', 'warn', 'block', 'ask']),
  maxAgents: whole(AGENT_LIMIT_MAX)
}

/** The stage ids a project may name (N5), as stages.ts orders them (kept here so options.ts needs nothing of it). */
const STAGE_IDS: readonly StageId[] = ['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done']

/** Whether a value is one its option takes (false for anything that isn't an option). */
export const takesOption = (key: string, v: unknown): boolean => Object.hasOwn(OPTION_TAKES, key) && OPTION_TAKES[key as OptionKey](v)

/** Card loops' options (HI-1766), a group of their own for both platforms. */
const LOOP_OPTIONS: OptionKey[] = ['loopWakes', 'loopRounds', 'loopWaitHours', 'loopStepWaitMinutes']

/** The Workflow section's groups (#1418), each a heading with its options. */
export type FormGroupId = 'team' | 'review' | 'checks' | 'merging' | 'where' | 'work' | 'loops' | 'stages'

/**
 * The Workflow section's groups for a platform, in order, and their options (SPEC §16.6.1, §16.6.2; #1418). Since P7
 * (#1445) Git's has every option: G17 beside G1b under Review, G15 under Where cards are built. The check commands
 * (`commands`) are edited with the checks that name them. File locks (N7) and Card loops are options of both since
 * HI-1766, and Maximum agents (HI-2001) heads both. Some rows show only where they apply (`formShows`). The slot and copy options aren't workflow
 * options (project.json `slots` and `copies`): the tab's Slots and copies group, beside these.
 */
export const FORM_GROUPS: Record<PlatformId, { id: FormGroupId; options: OptionKey[] }[]> = {
  git: [
    { id: 'team', options: ['maxAgents'] },
    { id: 'review', options: ['review', 'reviewers', 'reviewerMode', 'noSelfReview', 'sameness', 'okBefore'] },
    { id: 'checks', options: ['preChecks', 'mergeChecks', 'focusedTests', 'mergeInstall'] },
    { id: 'merging', options: ['finish', 'style', 'target', 'strict', 'pushTarget', 'commitMessage', 'dependenciesDone'] },
    { id: 'where', options: ['folder', 'slotsUpToDate', 'identity', 'stopOwnRuns', 'sharedFolderWarning', 'fileLocks'] },
    { id: 'loops', options: LOOP_OPTIONS },
    { id: 'stages', options: ['stageNames'] }
  ],
  none: [
    { id: 'team', options: ['maxAgents'] },
    { id: 'review', options: ['review', 'noSelfReview'] },
    { id: 'checks', options: ['preChecks'] },
    { id: 'work', options: ['excluded', 'dependenciesDone', 'fileLocks'] },
    { id: 'loops', options: LOOP_OPTIONS },
    { id: 'stages', options: ['stageNames'] }
  ]
}

/**
 * The rule options the form edits for a platform, in its order (the names, N5, and the preferences, HI-1766, aren't rules:
 * a preset leaves them, and they never make the options Custom; nor does Maximum agents, which a preset sets: HI-2001).
 */
export const FORM_OPTIONS: Record<PlatformId, OptionKey[]> = {
  git: FORM_GROUPS.git.flatMap((g) => g.options).filter((k) => !NOT_CUSTOM.includes(k)),
  none: FORM_GROUPS.none.flatMap((g) => g.options).filter((k) => !NOT_CUSTOM.includes(k))
}

/**
 * What a preset's or All off's preview lists for a platform, in the form's order: the rule options, and the preferences
 * a preset sets (HI-2001: Maximum agents), which never make the options Custom but do change when it is used.
 */
export const PREVIEW_OPTIONS: Record<PlatformId, OptionKey[]> = {
  git: FORM_GROUPS.git.flatMap((g) => g.options).filter((k) => !NOT_CUSTOM.includes(k) || PRESET_PREFERENCES.includes(k)),
  none: FORM_GROUPS.none.flatMap((g) => g.options).filter((k) => !NOT_CUSTOM.includes(k) || PRESET_PREFERENCES.includes(k))
}

/**
 * Whether an option's two values are the same. G12 is on or off (HI-2266: Hive reads the identity from git each time; a
 * saved `{ name, email }` only means on), so two identities are the same when both are on or both off: a saved copy that
 * differs from git's now is no change (HI-2269).
 */
export function sameOptionValue(key: keyof WorkflowOptions, a: unknown, b: unknown): boolean {
  return key === 'identity' ? !!a === !!b : JSON.stringify(a) === JSON.stringify(b)
}

/**
 * G12's value as the window shows it (HI-2269): off, or on as the project's identity from git now (`live`), never a saved
 * copy that may be stale; on with none in git, just on (`true`, shown as On).
 */
export function identityShown(v: unknown, live: { name: string; email: string } | null | undefined): { name: string; email: string } | true | null {
  return v ? (live ? { name: live.name, email: live.email } : true) : null
}

/** A choice's preview (its options) against the options in force: the rows it shows, and those Use would change. */
export function previewRows(options: WorkflowOptions, effective: WorkflowOptions): { keys: OptionKey[]; changed: OptionKey[] } {
  const keys = PREVIEW_OPTIONS[options.platform].filter((k) => formShows(k, options))
  return { keys, changed: keys.filter((k) => !sameOptionValue(k, options[k], effective[k])) }
}

/**
 * Whether the form shows an option's row for these options (#1355, #1418): G9's merge checks only when Hive merges, and
 * its install only when there are merge checks (with none, nothing is installed); G8 only when Hive merges; G16 only
 * with everyone in the project folder (the only place a commit can take in another agent's files).
 */
export function formShows(key: OptionKey, o: WorkflowOptions): boolean {
  if (key === 'mergeChecks' || key === 'focusedTests') return o.finish === 'hiveMerges'
  // The install comes before G9's checks and G20's run alike (HI-1367): focused tests alone install too.
  if (key === 'mergeInstall') return o.finish === 'hiveMerges' && (o.mergeChecks.length > 0 || o.focusedTests)
  // G8 strict (#1352): the merge queue brings work up to date, so only when Hive merges.
  if (key === 'strict') return o.finish === 'hiveMerges'
  // G18 (#1179): only the merge queue pushes.
  if (key === 'pushTarget') return o.finish === 'hiveMerges'
  // G19 (HI-1697): only the merge queue makes a merge's commit, and Rebase makes none (the branch's commits land).
  if (key === 'commitMessage') return o.finish === 'hiveMerges' && o.style !== 'rebase'
  if (key === 'sharedFolderWarning') return o.folder === 'project'
  // G15 depends on G11 alone: only with each card in a slot. G17 whenever a reviewer agent reviews, whatever G11 is
  // (with everyone in the project folder the pool's reviewers read in review copies, #1439).
  if (key === 'slotsUpToDate') return o.folder === 'slots'
  if (key === 'reviewerMode') return reviewerAgent(o.review)
  return FORM_GROUPS[o.platform].some((g) => g.options.includes(key))
}

/** Whether every check and balance is off (§16.6.4): the section then says what never turns off. */
export function isAllOff(o: WorkflowOptions): boolean {
  const off = allOff(o.platform)
  return o.review === 'none' && o.preChecks.length === 0 && o.finish === off.finish && o.folder === 'project' && o.okBefore.mode === 'never' && !o.dependenciesDone && !o.stopOwnRuns
}


