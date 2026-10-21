// Detecting version control (SPEC §16.3.5): a fact, detected, never switched silently. Hive offers a switch; the user
// confirms it, and it applies from the next card. A project's platform is recorded in its project.json as Hive makes it
// (workspace.ts ensureProject), and each refresh compares what detection finds with it (`projectPlatform`).

import { resolve } from 'path'
import { otherVcsOf, vcsOf } from '../hiveVcs'
import { isPlatformId, PLATFORMS, type Detection, type PlatformId, type PlatformOffer, type ProjectPlatform } from '../../shared/platform/descriptors'

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
  if (current === 'none') return found.platform === 'git' ? { offer: 'git', why: 'gitFound' } : null // i18n-ignore: a reason's key, not text
  return { offer: 'none', why: found.other ? 'otherFound' : 'repositoryGone' } // i18n-ignore: a reason's key, not text
}

/**
 * A project's platform for ProjectInfo: the recorded one (`recorded`, project.json's, as read: a project Hive hasn't
 * recorded yet takes what detection finds), its descriptor's capabilities, the detection, and the offer when they
 * differ. A recorded value that is no platform is said (`invalid`) and detection used meanwhile, with no offer.
 */
export function projectPlatform(folder: string, recorded: unknown): ProjectPlatform {
  const detected = detect(folder)
  const valid = isPlatformId(recorded)
  const id = valid ? recorded : detected.platform
  const o = valid ? offer(id, detected) : null
  const invalid = recorded === undefined || recorded === null || valid ? undefined : typeof recorded === 'string' ? recorded : JSON.stringify(recorded)
  return { id, capabilities: PLATFORMS[id].capabilities, detected, ...(o ? { offer: o } : {}), ...(invalid !== undefined ? { invalid } : {}) }
}
