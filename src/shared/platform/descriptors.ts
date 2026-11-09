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

/** Every operation, in one place: Git lists them all (it has each today). */
export const OPERATIONS: readonly Operation[] = ['switchLine', 'createLine', 'deleteLines', 'deleteRemoteLines', 'updateLine', 'mergeLine', 'addRemote', 'renameRemote', 'setRemoteUrl', 'removeRemote', 'fetch', 'pull', 'push', 'pushTo', 'setUpstream', 'createTag', 'setIdentity', 'init', 'ignoreRules']

export interface PlatformDescriptor {
  id: PlatformId
  capabilities: readonly Capability[]
  /** What the window can change in its repository (port 5's operations, HI-2788); None has none. */
  operations: readonly Operation[]
  /** A revision as shown: Git's 7 characters; None's content hash shortened the same way. */
  revisionShort: (id: string) => string
}

const short = (id: string): string => id.slice(0, 7)

export const PLATFORMS: Record<PlatformId, PlatformDescriptor> = {
  // Git answers everything: worktrees for isolation, merges for integration, replay for sameness.
  git: { id: 'git', capabilities: ['revisions', 'isolation', 'integration', 'containment', 'sameness', 'authorship', 'observe'], operations: OPERATIONS, revisionShort: short },
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
