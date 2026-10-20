// Detecting version control (SPEC §16.3.5): a fact, detected, never switched silently. Hive offers a switch; the user
// confirms it, and it applies from the next card. A project's platform is recorded in its project.json as Hive makes it
// (workspace.ts ensureProject), and each refresh compares what detection finds with it (`projectPlatform`).

import { resolve } from 'path'
import { otherVcsOf, vcsOf } from '../hiveVcs'
import { PLATFORMS, type Detection, type PlatformId, type PlatformOffer, type ProjectPlatform } from '../../shared/platform/descriptors'

export type { Detection } from '../../shared/platform/descriptors'

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
export function offer(current: PlatformId, found: Detection): PlatformOffer | null {
  if (current === found.platform) return null
  if (current === 'none') return found.platform === 'git' ? { offer: 'git', why: 'gitFound' } : null
  return { offer: 'none', why: found.other ? 'otherFound' : 'repositoryGone' }
}

/**
 * A project's platform for ProjectInfo: the recorded one (`current`; a project Hive hasn't recorded yet takes what
 * detection finds), its descriptor's capabilities, the detection, and the offer when they differ.
 */
export function projectPlatform(folder: string, current: PlatformId | undefined): ProjectPlatform {
  const detected = detect(folder)
  const id = current ?? detected.platform
  const o = offer(id, detected)
  return { id, capabilities: PLATFORMS[id].capabilities, detected, ...(o ? { offer: o } : {}) }
}
