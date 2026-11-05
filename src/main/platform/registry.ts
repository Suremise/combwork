// Detecting version control (SPEC §16.3.5): a fact, detected, never switched silently. Combwork offers a switch; the user
// confirms it, and it applies from the next card. A project's platform is recorded in its project.json as Combwork makes it
// (workspace.ts ensureProject), and each refresh compares what detection finds with it (`projectPlatform`).

import { resolve } from 'path'
import { otherVcsOf, vcsOf } from '../combworkVcs'
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

/** What detection found, as project.json keeps it when the user switches (`platformFound`, #1419). */
export const foundKey = (d: Detection): string => (d.other ? `other:${d.other}` : d.platform)

/**
 * A project's platform for ProjectInfo: the recorded one (`recorded`, project.json's, as read: a project Combwork hasn't
 * recorded yet takes what detection finds), its descriptor's capabilities, the detection, and the offer when they
 * differ. A recorded value that is no platform is said (`invalid`) and detection used meanwhile, with no offer.
 * `found`: what detection found when the user last switched (#1419): while the folder shows that still, the user chose
 * this platform knowing it (None for a Git folder), so nothing is offered until the folder changes.
 */
/** A project's platform's id, as projectPlatform gives it: its recorded one, its folder looked at only when it has none (HI-1783: a check's every resolve asks). */
export function platformIdOf(folder: string, recorded: unknown): PlatformId {
  return isPlatformId(recorded) ? recorded : detect(folder).platform
}

export function projectPlatform(folder: string, recorded: unknown, found?: unknown): ProjectPlatform {
  const detected = detect(folder)
  const valid = isPlatformId(recorded)
  const id = valid ? recorded : detected.platform
  const o = valid && found !== foundKey(detected) ? offer(id, detected) : null
  const invalid = recorded === undefined || recorded === null || valid ? undefined : typeof recorded === 'string' ? recorded : JSON.stringify(recorded)
  return { id, capabilities: PLATFORMS[id].capabilities, detected, ...(o ? { offer: o } : {}), ...(invalid !== undefined ? { invalid } : {}) }
}
