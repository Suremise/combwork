// The platform layer's descriptors (SPEC §16.3.1): what each version control can answer, as plain data. An option that
// needs a capability the platform lacks isn't offered; a guard that needs one can't be in its rulesets. Each project's
// platform comes to the window in ProjectInfo (`ProjectPlatform`), which formats revisions through `revisionShort`,
// never by switching on an id.

export type PlatformId = 'none' | 'git'

export type Capability = 'revisions' | 'isolation' | 'integration' | 'containment' | 'sameness' | 'authorship' | 'observe'

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

/**
 * A compatibility gate (SPEC §16.3.6's matrix, HI-2793's J0): a capability or operation a platform refuses until its J
 * card's evidence opens it. Closed, it is absent from the platform's descriptor and the switch's assessment says why;
 * detecting a repository that uses one (attributes, hooks, LFS, submodules) fails closed: unreadable is "uses it". No
 * platform has gates in 1.5.0's J0: jj's descriptor (J6) lists them.
 */
export type Gate = 'attributes' | 'hooks' | 'lfs' | 'submodules' | 'signing' | 'relocation' | 'plainGit' | 'advance' | 'publish' | 'sharedFolder'

/** Every gate, in the matrix's order. */
export const GATES: readonly Gate[] = ['attributes', 'hooks', 'lfs', 'submodules', 'signing', 'relocation', 'plainGit', 'advance', 'publish', 'sharedFolder']

/** Every operation, in one place: Git lists them all (it has each today). */
export const OPERATIONS: readonly Operation[] = ['switchLine', 'createLine', 'deleteLines', 'deleteRemoteLines', 'updateLine', 'mergeLine', 'addRemote', 'renameRemote', 'setRemoteUrl', 'removeRemote', 'fetch', 'pull', 'push', 'pushTo', 'setUpstream', 'createTag', 'setIdentity', 'init', 'ignoreRules']

export interface PlatformDescriptor {
  id: PlatformId
  capabilities: readonly Capability[]
  /** What the window can change in its repository (port 5's operations, HI-2788); None has none. */
  operations: readonly Operation[]
  /** A revision as shown: Git's 7 characters; None's content hash shortened the same way. */
  revisionShort: (id: string) => string
  /**
   * The commands a refusal gives as its remedy, in the platform's own terms (SPEC §16.3.6 port 3's attribution remedies,
   * HI-2792): a common guard never writes a tool's command itself. Absent on a platform with no commits to fix (None).
   */
  remedies?: Remedies
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

export const PLATFORMS: Record<PlatformId, PlatformDescriptor> = {
  // Git answers everything: worktrees for isolation, merges for integration, replay for sameness.
  git: { id: 'git', capabilities: ['revisions', 'isolation', 'integration', 'containment', 'sameness', 'authorship', 'observe'], operations: OPERATIONS, revisionShort: short, remedies: GIT_REMEDIES },
  // None: content hashes as revisions, acceptance as integration, no isolation in 1.0 (OP-16). No repository to change:
  // Initialise repository is on Git's page (HI-1905), gated by Git's operations.
  none: { id: 'none', capabilities: ['revisions', 'integration', 'containment', 'sameness', 'authorship', 'observe'], operations: [], revisionShort: short }
}

export const hasCapability = (platform: PlatformId, c: Capability): boolean => PLATFORMS[platform].capabilities.includes(c)

/** Whether a platform offers an operation in its repository (port 5, HI-2788). */
export const hasOperation = (platform: PlatformId, op: Operation): boolean => PLATFORMS[platform].operations.includes(op)

/** Whether a value read from a file (project.json's `platform`) names a platform Combwork has. */
export const isPlatformId = (v: unknown): v is PlatformId => typeof v === 'string' && Object.hasOwn(PLATFORMS, v)

/** A revision as the project's platform shows it. */
export const revisionShort = (platform: PlatformId, id: string): string => PLATFORMS[platform].revisionShort(id)

/** What a folder's version control is (SPEC §16.3.5), read from its folders: never a switch on its own. */
export interface Detection {
  /** The platform the folder can use: Git for a Git repository, else None (no version control, or one not supported yet). */
  platform: PlatformId
  /** The repository's root, for Git. */
  root?: string
  /** Another system found (Mercurial, Jujutsu…): not supported yet, so None. A colocated jj+git repository is Jujutsu. */
  other?: string
  /** The project is a subfolder of a larger repository: its actions affect that whole repository. */
  subfolder?: boolean
}

/** Why the detected platform differs from the project's: what Combwork offers to switch to (§16.3.5). */
export interface PlatformOffer {
  offer: PlatformId
  why: 'gitFound' | 'repositoryGone' | 'otherFound'
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
