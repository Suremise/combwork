// Detecting version control (SPEC §16.3.5): a fact, detected, never switched silently. Hive offers a switch; the user
// confirms it, and it applies from the next card.
//
// P2 spike (#1118): not wired into the app yet.

import { resolve } from 'path'
import { otherVcsOf, vcsOf } from '../hiveVcs'
import type { PlatformId } from '../../shared/platform/descriptors'

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

export function detect(folder: string): Detection {
  const other = otherVcsOf(folder)
  if (other) return { platform: 'none', other: other.name }
  const v = vcsOf(folder)
  if (v?.kind === 'git') return { platform: 'git', root: v.root, ...(resolve(v.root) !== resolve(folder) ? { subfolder: true } : {}) }
  return { platform: 'none' }
}

/**
 * What the Version Control tab offers when the detected platform differs from the project's: Git for a None project
 * that got `git init`, None for a Git project whose repository is gone (whose Git rules hold meanwhile: their facts are
 * unknown). Null when they agree.
 */
export function offer(current: PlatformId, found: Detection): { offer: PlatformId; why: 'gitFound' | 'repositoryGone' | 'otherFound' } | null {
  if (current === found.platform) return null
  if (current === 'none') return found.platform === 'git' ? { offer: 'git', why: 'gitFound' } : null
  return { offer: 'none', why: found.other ? 'otherFound' : 'repositoryGone' }
}
