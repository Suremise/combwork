// What the Version Control tab says about each platform (HI-3140): the fact line atop the tab for a folder a platform
// detected, or for a project on a platform whose repository is gone, the offer's switch button, and which platforms the
// None · Git preview moves between. The platforms own these rows; the header asks by the detected platform and the
// project's, never by an id. Messages, never translated text: the header says them (tr) when it renders.

import { msg, type Msg } from '../i18n/msg'
import { needsRepository, type Detection, type PlatformId, type ProjectPlatform } from './descriptors'

const M = {
  noRepo: msg({ id: 'git.vc.fact.none', defaultMessage: 'This folder has no version control.', description: 'Atop the Version Control tab, when the project folder has no repository.' }),
  repo: msg({ id: 'git.vc.fact.repo', defaultMessage: 'This folder is a Git repository at {root}.', description: 'Atop the Version Control tab: what Combwork found in the project folder. {root} is the repository root (glossary 2.1: repository root).' }),
  subfolder: msg({ id: 'git.vc.fact.subfolder', defaultMessage: 'This folder is inside a Git repository at {root}: branch and merge actions affect that whole repository.', description: 'Atop the Version Control tab, when the project is a subfolder of a larger repository. {root} is that repository’s root.' }),
  gone: msg({ id: 'git.vc.fact.gone', defaultMessage: 'The Git repository is gone from this folder. Until it’s back, what needs Git can’t be read.', description: 'Atop the Version Control tab of a Git project whose .git was removed or moved.' }),
  other: msg({ id: 'git.vc.fact.other', defaultMessage: '{vcs} found: not supported yet, so this project uses None.', description: 'Atop the Version Control tab: another version control was found in the folder. {vcs} is its name (Mercurial, Jujutsu). None: glossary 2.1.' }),
  otherGit: msg({ id: 'git.vc.fact.otherGit', defaultMessage: '{vcs} found in this folder: not supported yet.', description: 'Atop the Version Control tab of a project still using Git, where another version control was found ({vcs}: Mercurial, Jujutsu). The offer under it says what to do.' }),
  jjRepo: msg({ id: 'git.vc.fact.jj', defaultMessage: 'This folder is a jj repository at {root}, {colocated, select, yes {colocated with Git} other {not colocated with Git}}.', description: 'Atop the Version Control tab (HI-2799, HI-2896): what Combwork found in the project folder, a jj (Jujutsu) repository. {root} is its root; colocated with Git means a .git folder beside .jj, not colocated that Git’s data is inside .jj (both are supported). Keep jj and Git.' }),
  jjInGit: msg({ id: 'git.vc.fact.jjInGit', defaultMessage: 'This folder is a jj repository at {root}, not colocated, inside the Git repository at {git}: Combwork can’t use jj here.', description: 'Atop the Version Control tab (HI-2896): a jj (Jujutsu) repository whose Git data is inside .jj, in a folder that is itself inside a Git working tree ({git}); git commands in it would reach that repository, so jj isn’t offered. Keep jj and Git.' }),
  jjGone: msg({ id: 'git.vc.fact.jjGone', defaultMessage: 'The jj repository is gone from this folder.', description: 'Atop the Version Control tab of a project using jj (Jujutsu, HI-2799) whose .jj folder was removed or moved. Keep jj.' }),
  switchGit: msg({ id: 'git.vc.offer.switchGit', defaultMessage: 'Switch…', description: 'A button of the offer to switch a project to Git (atop the Version Control tab): shows what changes, then asks. The … says it asks first: keep it.' }),
  switchJj: msg({ id: 'git.vc.offer.switchJj', defaultMessage: 'Switch to jj…', description: 'A button of the offer to switch a project to jj (Jujutsu, HI-2799): shows what changes, then asks. The … says it asks first: keep it. Keep jj.' }),
  switchNone: msg({ id: 'git.vc.offer.switchNone', defaultMessage: 'Switch to None…', description: 'A button of the offer to switch a project to None, no version control (atop the Version Control tab): shows what changes, then asks. The … says it asks first: keep it. None: glossary 2.1.' })
}

/** A fact line: its message and values, and whether it is said as a caution (something to act on). */
export interface PlatformFact {
  m: Msg
  values?: Record<string, string>
  caution?: boolean
}

/** One platform's words in the Version Control tab. */
export interface PlatformView {
  /** The offer's button switching a project to this platform. */
  switchTo: Msg
  /** While this platform is in force, another version control (`vcs`) found in the folder. */
  other: Msg
  /** A folder this platform detected; null when it has nothing to say of it (Git without a root). */
  found?: (d: Detection) => PlatformFact | null
  /**
   * Whether that fact comes before the project's own platform's `gone` (jj's: its repository explains the folder better
   * than another's absence, HI-2799); else after it.
   */
  foundFirst: boolean
  /** This platform's repository is gone from a project's folder that uses it. */
  gone?: Msg
  /** Whether the None · Git choice moves to it as a view, nothing switched (None, and Git's page with Initialise repository…). */
  previewable: boolean
}

export const PLATFORM_VIEW: Record<PlatformId, PlatformView> = {
  none: { switchTo: M.switchNone, other: M.other, foundFirst: false, previewable: true },
  git: {
    switchTo: M.switchGit,
    other: M.otherGit,
    found: (d) => (d.root ? { m: d.subfolder ? M.subfolder : M.repo, values: { root: d.root } } : null),
    foundFirst: false,
    gone: M.gone,
    previewable: true
  },
  // jj (HI-2799): colocated or not (HI-2896), one inside a Git working tree (a caution), and a jj project whose repository is gone.
  jj: {
    switchTo: M.switchJj,
    other: M.other,
    found: (d): PlatformFact => (d.jj?.inGit ? { m: M.jjInGit, values: { root: d.root ?? '', git: d.jj.inGit }, caution: true } : { m: M.jjRepo, values: { root: d.root ?? '', colocated: d.jj?.colocated ? 'yes' : 'no' } }),
    foundFirst: true,
    gone: M.jjGone,
    previewable: false
  }
}

/**
 * What Combwork finds in a project's folder, as the tab's fact line says it: another system found, in the words of the
 * platform in force (Git's: what was found, not yet what it uses; the offer under the header says that); else what the
 * detected platform found, before or after the project's platform's repository gone from the folder, as the detected
 * platform's row says (`foundFirst`); else no version control.
 */
export function factOf(p: ProjectPlatform): PlatformFact {
  const d = p.detected
  if (d.other) return { m: PLATFORM_VIEW[p.id].other, values: { vcs: d.other } }
  const seen = PLATFORM_VIEW[d.platform]
  const found = seen.found?.(d) ?? null
  if (found && seen.foundFirst) return found
  const gone = PLATFORM_VIEW[p.id].gone
  if (gone && needsRepository(p.id) && d.platform !== p.id) return { m: gone }
  return found ?? { m: M.noRepo }
}

/** Whether what the detected platform found is a caution in itself (jj's repository inside a Git working tree, HI-2896). */
export const detectedCaution = (d: Detection): boolean => !!PLATFORM_VIEW[d.platform].found?.(d)?.caution
