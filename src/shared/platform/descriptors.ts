// The platform layer's descriptors (SPEC §16.3.1): what each version control can answer, as plain data. An option that
// needs a capability the platform lacks isn't offered; a guard that needs one can't be in its rulesets.
//
// P2 spike (#1118): not wired into the app yet.

export type PlatformId = 'none' | 'git'

export type Capability = 'revisions' | 'isolation' | 'integration' | 'containment' | 'sameness' | 'authorship' | 'observe'

export interface PlatformDescriptor {
  id: PlatformId
  capabilities: readonly Capability[]
  /** A revision as shown: Git's 7 characters; None's content hash shortened the same way. */
  revisionShort: (id: string) => string
}

const short = (id: string): string => id.slice(0, 7)

export const PLATFORMS: Record<PlatformId, PlatformDescriptor> = {
  // Git answers everything: worktrees for isolation, merges for integration, replay for sameness.
  git: { id: 'git', capabilities: ['revisions', 'isolation', 'integration', 'containment', 'sameness', 'authorship', 'observe'], revisionShort: short },
  // None: content hashes as revisions, acceptance as integration, no isolation in 1.0 (OP-16).
  none: { id: 'none', capabilities: ['revisions', 'integration', 'containment', 'sameness', 'authorship', 'observe'], revisionShort: short }
}

export const hasCapability = (platform: PlatformId, c: Capability): boolean => PLATFORMS[platform].capabilities.includes(c)
