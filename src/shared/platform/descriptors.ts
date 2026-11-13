// The platform layer's descriptors (SPEC §16.3.1): what each version control can answer, as plain data. An option that
// needs a capability the platform lacks isn't offered; a guard that needs one can't be in its rulesets. Each project's
// platform comes to the window in ProjectInfo (`ProjectPlatform`), which formats revisions through `revisionShort`,
// never by switching on an id.

export type PlatformId = 'none' | 'git' | 'jj'

/**
 * `checkCopies` (HI-2868): a check can run in a copy of its own at the card's revision (`--isolated`). Apart from
 * `isolation` (slots): jj has slots in 1.5.0 but no check copies yet.
 */
export type Capability = 'revisions' | 'isolation' | 'checkCopies' | 'integration' | 'containment' | 'sameness' | 'authorship' | 'observe'

/**
 * What the window can change in a platform's repository (SPEC §16.3.6 port 5, HI-2788's R3): an operation is offered only
 * when its platform lists it, and main refuses one that isn't (never mapped to a near equivalent, R5.2). Platform words:
 * a line is Git's branch.
 */
export type Operation =
  | 'switchLine'
  | 'createLine'
  | 'deleteLines'
  | 'deleteRemoteLines'
  | 'updateLine'
  | 'mergeLine'
  | 'addRemote'
  | 'renameRemote'
  | 'setRemoteUrl'
  | 'removeRemote'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'pushTo'
  | 'setUpstream'
  | 'createTag'
  | 'setIdentity'
  | 'init'
  | 'ignoreRules'
  /** HI-2944: the uncommitted changes in a folder the merge queue merges into, committed or set aside (Files' Commit it too). */
  | 'folderChanges'

/**
 * A compatibility gate (SPEC §16.3.6's matrix, HI-2793's J0): a capability or operation a platform refuses until its J
 * card's evidence opens it. Closed, it is absent from the platform's descriptor and the switch's assessment says why;
 * detecting a repository that uses one (attributes, hooks, LFS, submodules) fails closed: unreadable is "uses it". Git and
 * None have none; jj's descriptor (HI-2799, J6) lists every gate still closed.
 */
export type Gate = 'attributes' | 'hooks' | 'lfs' | 'submodules' | 'signing' | 'relocation' | 'plainGit' | 'advance' | 'publish' | 'sharedFolder'

/** Every gate, in the matrix's order. */
export const GATES: readonly Gate[] = ['attributes', 'hooks', 'lfs', 'submodules', 'signing', 'relocation', 'plainGit', 'advance', 'publish', 'sharedFolder']

/** Every operation, in one place: Git lists them all (it has each today). */
export const OPERATIONS: readonly Operation[] = ['switchLine', 'createLine', 'deleteLines', 'deleteRemoteLines', 'updateLine', 'mergeLine', 'addRemote', 'renameRemote', 'setRemoteUrl', 'removeRemote', 'fetch', 'pull', 'push', 'pushTo', 'setUpstream', 'createTag', 'setIdentity', 'init', 'ignoreRules', 'folderChanges']

/**
 * How a platform's integration combines approved work (SPEC §16.3.1, HI-2822): merged from the card's line into a target
 * line (Git: targets, the merging finishers, the merge queue and its options), accepted where it is (None), or integrated
 * by the user once it passes (jj, HI-2799: option A, no automatic advance; Combwork merges nothing).
 */
export type Integration = 'merge' | 'accept' | 'user'

/** What a code card delivers (§16.3.3, HI-2822): its commits (Git, jj), or the paths it declares, hashed as its revision (None). */
export type Deliverables = 'commits' | 'paths'

export interface PlatformDescriptor {
  id: PlatformId
  capabilities: readonly Capability[]
  /** How integration combines approved work: the options, stages and finishers a project's workflow has follow it. */
  integration: Integration
  /** What a code card delivers: commits, or declared paths (a submission's paths, their pre-fill and exclusions). */
  deliverables: Deliverables
  /**
   * Whether the platform needs its repository found in the project's folder (Git; §16.3.5): switching to it is refused
   * without one, and a project using it whose repository is gone is offered a switch. None works in any folder.
   */
  repository: boolean
  /**
   * HI-3106: whether an empty target means the repository's default line (Git's default branch). jj resolves none, so a
   * switch to it seeds the target from the platform left; None has no target to resolve.
   */
  defaultTarget: boolean
  /** What the window can change in its repository (port 5's operations, HI-2788); None has none. */
  operations: readonly Operation[]
  /** A revision as shown: Git's 7 characters; None's content hash shortened the same way. */
  revisionShort: (id: string) => string
  /**
   * The commands a refusal gives as its remedy, in the platform's own terms (SPEC §16.3.6 port 3's attribution remedies,
   * HI-2792): a common guard never writes a tool's command itself. Absent on a platform with no commits to fix (None).
   */
  remedies?: Remedies
  /** A change id as shown (jj's, HI-2799): absent on a platform without change ids. Never used for credit (R3.1). */
  changeShort?: (id: string) => string
  /** The compatibility gates still closed on this platform (SPEC §16.3.6): what it refuses, shown as not supported. */
  gates: readonly Gate[]
}

/** A refusal's remedies (HI-2792): each a command as the agent types it. */
export interface Remedies {
  /** Adds the card's trailer to the folder's head commit (submit.trailer). */
  trailer: (key: string) => string
  /** Sets the project's identity, when it has none (submit.identity). */
  setIdentity: string
  /** Makes the head commit again with the project's identity (submit.identity). */
  resetAuthor: string
}

/** Git's remedies: the commands submit.trailer and submit.identity have always given. */
const GIT_REMEDIES: Remedies = {
  trailer: (key) => `git commit --amend --no-edit --trailer "Combwork-Card: ${key}"`, // i18n-ignore: a git command, as typed
  setIdentity: 'git config user.email', // i18n-ignore: a git command, as typed
  resetAuthor: 'git commit --amend --no-edit --reset-author' // i18n-ignore: a git command, as typed
}

const short = (id: string): string => id.slice(0, 7)
const short12 = (id: string): string => id.slice(0, 12)

export const PLATFORMS: Record<PlatformId, PlatformDescriptor> = {
  // Git answers everything: worktrees for isolation, merges for integration, replay for sameness.
  git: { id: 'git', capabilities: ['revisions', 'isolation', 'checkCopies', 'integration', 'containment', 'sameness', 'authorship', 'observe'], integration: 'merge', deliverables: 'commits', repository: true, defaultTarget: true, operations: OPERATIONS, revisionShort: short, remedies: GIT_REMEDIES, gates: [] },
  // None: content hashes as revisions, acceptance as integration, no isolation in 1.0 (OP-16). No repository to change:
  // Initialise repository is on Git's page (HI-1905), gated by Git's operations.
  none: { id: 'none', capabilities: ['revisions', 'integration', 'containment', 'sameness', 'authorship', 'observe'], integration: 'accept', deliverables: 'paths', repository: false, defaultTarget: false, operations: [], revisionShort: short, gates: [] },
  // jj (HI-2799, J6; SPEC §16.3.6): workspaces for isolation (J2), pinned history and attribution (J3). No integration, ever,
  // under Darren's option A (HI-2794: no automatic advance, the user integrates), and no operation in the window (R5.2):
  // jj itself changes bookmarks. Every gate is closed until its J card's evidence opens it.
  jj: { id: 'jj', capabilities: ['revisions', 'isolation', 'containment', 'sameness', 'authorship', 'observe'], integration: 'user', deliverables: 'commits', repository: true, defaultTarget: false, operations: [], revisionShort: short12, changeShort: short12, gates: GATES }
}

export const hasCapability = (platform: PlatformId, c: Capability): boolean => PLATFORMS[platform].capabilities.includes(c)

/** Whether a platform's integration merges lines into a target (HI-2822): targets, merging, the merge queue and its options. */
export const merges = (platform: PlatformId): boolean => PLATFORMS[platform].integration === 'merge'

/** Whether a platform accepts approved work where it is (HI-2822: None's finisher, its presets and words; never jj's). */
export const accepts = (platform: PlatformId): boolean => PLATFORMS[platform].integration === 'accept'

/** Whether a platform's code cards deliver commits (HI-2822: Git's and jj's; a rule needing the change needs its folder clean). */
export const deliversCommits = (platform: PlatformId): boolean => PLATFORMS[platform].deliverables === 'commits'

/** Whether a platform's code cards deliver the paths they declare (HI-2822: None's paths, pre-fill and exclusions). */
export const declaresPaths = (platform: PlatformId): boolean => PLATFORMS[platform].deliverables === 'paths'

/** Whether a platform needs its repository found in the project's folder (HI-2822: Git's, jj's). */
export const needsRepository = (platform: PlatformId): boolean => PLATFORMS[platform].repository

/** Whether a platform offers an operation in its repository (port 5, HI-2788). */
export const hasOperation = (platform: PlatformId, op: Operation): boolean => PLATFORMS[platform].operations.includes(op)

/** Whether a platform still refuses what a gate covers (SPEC §16.3.6). */
export const hasGate = (platform: PlatformId, g: Gate): boolean => PLATFORMS[platform].gates.includes(g)

/** Whether a value read from a file (project.json's `platform`) names a platform Combwork has. */
export const isPlatformId = (v: unknown): v is PlatformId => typeof v === 'string' && Object.hasOwn(PLATFORMS, v)

/** A revision as the project's platform shows it. */
export const revisionShort = (platform: PlatformId, id: string): string => PLATFORMS[platform].revisionShort(id)

/** What a folder's version control is (SPEC §16.3.5), read from its folders: never a switch on its own. */
export interface Detection {
  /**
   * The platform the folder can use: Git for a Git repository, jj for a Jujutsu repository (HI-2799), else None (no
   * version control, or one not supported). Never what a project uses by itself: a jj folder is recorded None and offered.
   */
  platform: PlatformId
  /** The repository's root: Git's, or the jj workspace's. */
  root?: string
  /**
   * jj's (HI-2799), read from its files as hints (J0's detection confirms them before a switch). `inGit` (HI-2896): a
   * non-colocated repository inside a Git working tree, that tree's root (a git command in the project would reach it).
   */
  jj?: { colocated: boolean; inGit?: string }
  /** Another system found (Mercurial, Subversion…): not supported, so None. */
  other?: string
  /** The project is a subfolder of a larger repository: its actions affect that whole repository. */
  subfolder?: boolean
}

/** Why the detected platform differs from the project's: what Combwork offers to switch to (§16.3.5). */
export interface PlatformOffer {
  offer: PlatformId
  why: 'gitFound' | 'repositoryGone' | 'otherFound' | 'jjFound' | 'jjGone'
}

/**
 * A project's platform (ProjectInfo): the one it uses (recorded when Combwork set the project up, never switched
 * silently), its descriptor's capabilities, what detection finds now, and the switch Combwork offers when they differ.
 */
export interface ProjectPlatform {
  id: PlatformId
  capabilities: readonly Capability[]
  detected: Detection
  offer?: PlatformOffer
  /**
   * The project.json names no platform Combwork has (edited by hand, a later version's): what it holds, as text. The
   * project uses what detection finds, offering nothing, until the setting is a platform again.
   */
  invalid?: string
}
