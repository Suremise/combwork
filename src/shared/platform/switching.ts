// Switching a project's version control (#1419, SPEC §16.6.5): which switch can be made from what Combwork detects now, and
// its reasons, the same in the window (the choice atop the Version Control tab) and in main (the switch, under the
// project's lock, and the Assistant's settings tool). Choosing None is never refused for what is detected (#1122: you
// pick the version control): Git only where a Git repository is found and no other version control is; jj (HI-2799)
// only where a jj repository colocated with Git is found. A switch between Git and jj is the repository's (every project
// on it switches together, after a drain and, to jj, a compatibility assessment): main's checks, said here as reasons.

import { msg, type Msg } from '../i18n/msg'
import type { Detection, Gate, PlatformId } from './descriptors'

/** A platform's name as Combwork shows it (glossary 2.1). */
export const PLATFORM_NAME: Record<PlatformId, Msg> = {
  none: msg({ id: 'git.vc.none', defaultMessage: 'None', description: 'The version control of a project without any, in the choice atop the Version Control tab and in "Workflow: None · Solo" (glossary 2.1: None).' }),
  git: msg({ id: 'git.vc.git', defaultMessage: 'Git', description: 'A version control system’s name, in the choice atop the Version Control tab (glossary 2.1: keep).' }),
  jj: msg({ id: 'git.vc.jj', defaultMessage: 'jj', description: 'Jujutsu’s command name, as its users call it, in the choice atop the Version Control tab (HI-2799). Keep it: a product’s name, lower case.' })
}

/**
 * Why a switch can't be made now: no Git repository, another version control found; for jj (HI-2799), no jj repository,
 * one without a colocated Git repository, jj itself (missing, not the tested version, or its answer disagreeing with its
 * files), what the repository uses that jj doesn't support (`gates`), what keeps it from going back to Git (`fallback`),
 * work still running on the repository (`drain`), the repository also a project of another open workspace, or its
 * projects changed since the warning (`groupChanged`).
 */
export type SwitchRefusal =
  | { why: 'noGit' }
  | { why: 'otherFound'; vcs: string }
  | { why: 'noJj' }
  | { why: 'jjSeparate' }
  | { why: 'jjTool'; state: string }
  | { why: 'jjUnknown'; code: string }
  | { why: 'gates' }
  | { why: 'fallback' }
  | { why: 'drain' }
  | { why: 'otherWorkspace'; workspace: string }
  | { why: 'groupChanged' }
  | { why: 'switching' }

export const SWITCH_REFUSED = {
  noGit: msg({ id: 'git.vc.switch.noGit', defaultMessage: 'No Git repository here: Initialise repository… first.', description: 'Why a project can’t be switched to Git (the Version Control tab’s choice, a refusal): its folder has no Git repository. Initialise repository… is a button’s name: keep it as translated there.' }),
  otherFound: msg({ id: 'git.vc.switch.otherFound', defaultMessage: '{vcs} found: not supported yet, so this project can only use None.', description: 'Why a project can’t be switched to Git: another version control ({vcs}: Mercurial, Subversion) was found in its folder. None: glossary 2.1.' }),
  changed: msg({ id: 'git.vc.switch.changed', defaultMessage: 'Changed meanwhile: this project uses {platform} now. Look again before switching.', description: 'Why a switch of version control was refused: someone else switched it since the tab was shown. {platform} is None, Git or jj.' }),
  noJj: msg({ id: 'git.vc.switch.noJj', defaultMessage: 'No jj repository here. Combwork never makes one: create it with jj, colocated with Git.', description: 'Why a project can’t be switched to jj (Jujutsu, HI-2799): its folder has no jj repository. Keep jj and Git.' }),
  jjSeparate: msg({ id: 'git.vc.switch.jjSeparate', defaultMessage: 'This jj repository has no colocated Git repository, which Combwork doesn’t support yet.', description: 'Why a project can’t be switched to jj (HI-2799): its jj repository keeps Git’s data inside .jj rather than beside it (not colocated). Keep jj and Git.' }),
  jjTool: msg({ id: 'git.vc.switch.jjTool', defaultMessage: '{state, select, missing {jj isn’t installed (or isn’t on the PATH)} old {This jj is older than the one Combwork is tested with} untested {This jj is newer than the one Combwork is tested with} other {jj couldn’t be checked}}, so this project can’t use jj.', description: 'Why a project can’t be switched to jj (HI-2799): the jj tool Combwork found. Keep jj.' }),
  jjUnknown: msg({ id: 'git.vc.switch.jjUnknown', defaultMessage: 'jj couldn’t confirm this repository ({code}), so this project can’t switch.', description: 'Why a project can’t be switched to or from jj (HI-2799): jj didn’t confirm what its files say. {code} is a short code for why (kept in English). Keep jj.' }),
  gates: msg({ id: 'git.vc.switch.gates', defaultMessage: 'This repository uses what jj doesn’t support: see the list.', description: 'Why a project can’t be switched to jj (HI-2799): the compatibility check found Git features jj doesn’t support (listed in the same dialog). Keep jj.' }),
  fallback: msg({ id: 'git.vc.switch.fallback', defaultMessage: 'The repository isn’t ready to go back to Git: see the list.', description: 'Why a jj project can’t be switched back to Git (HI-2799): conflicted bookmarks, changes Git hasn’t received and the like (listed in the same dialog). Keep Git.' }),
  drain: msg({ id: 'git.vc.switch.drain', defaultMessage: 'Work is still running on this repository: switch once it has finished.', description: 'Why a switch between Git and jj is refused (HI-2799): lanes, cards in flight, the merge queue or slots are still in use on the repository (listed in the same dialog). Keep Git and jj.' }),
  otherWorkspace: msg({ id: 'git.vc.switch.otherWorkspace', defaultMessage: 'This repository is also a project of the open workspace {workspace}: close it there first.', description: 'Why a switch between Git and jj is refused (HI-2799): another open workspace (another window) has a project on the same repository, whose work Combwork can’t hold while it switches. {workspace} is its name. Keep Git and jj.' }),
  groupChanged: msg({ id: 'git.vc.switch.groupChanged', defaultMessage: 'This repository’s projects changed meanwhile: look again before switching.', description: 'Why a switch between Git and jj is refused (HI-2799): a project joined the repository, or one of its projects’ choices or options changed, after the warning was shown.' }),
  switching: msg({ id: 'git.vc.switch.switching', defaultMessage: 'This repository’s version control is being switched: try again in a moment.', description: 'Why a switch (or a start, a lane, a slot) is refused for now (HI-2799): another switch of the same repository between Git and jj is under way.' })
} satisfies Record<string, Msg>

/** Whether a switch from `from` to `to` is the repository's (HI-2799): Git ↔ jj, or None → jj (the group moves together). */
export const storeWide = (from: PlatformId, to: PlatformId): boolean => from !== to && (to === 'jj' || (from === 'jj' && to === 'git'))

/** Whether a project can switch to `to` from what is detected now: null when it can (main checks the rest). */
export function switchRefused(to: PlatformId, found: Detection): SwitchRefusal | null {
  if (to === 'jj') {
    if (found.platform !== 'jj') return { why: 'noJj' } // i18n-ignore: a reason's key, not text
    return found.jj?.colocated ? null : { why: 'jjSeparate' } // i18n-ignore: a reason's key, not text
  }
  if (to !== 'git') return null
  if (found.other) return { why: 'otherFound', vcs: found.other } // i18n-ignore: a reason's key, not text
  // A colocated jj repository has Git beside it: back to Git (main checks it is ready, `fallback`).
  if (found.platform === 'jj') return found.jj?.colocated ? null : { why: 'noGit' } // i18n-ignore: a reason's key, not text
  return found.platform === 'git' ? null : { why: 'noGit' } // i18n-ignore: a reason's key, not text
}

/** A refusal's message and values. */
export function switchRefusalText(r: SwitchRefusal): { m: Msg; values?: Record<string, string> } {
  switch (r.why) {
    case 'otherFound':
      return { m: SWITCH_REFUSED.otherFound, values: { vcs: r.vcs } }
    case 'jjTool':
      return { m: SWITCH_REFUSED.jjTool, values: { state: r.state } }
    case 'jjUnknown':
      return { m: SWITCH_REFUSED.jjUnknown, values: { code: r.code } }
    case 'otherWorkspace':
      return { m: SWITCH_REFUSED.otherWorkspace, values: { workspace: r.workspace } }
    default:
      return { m: SWITCH_REFUSED[r.why] }
  }
}

/** What the drain found still running on the repository, per project (none of it is changed by a switch). */
export interface SwitchDrain {
  lanes: { project: string; id: string; name: string | null; builder: string }[]
  cards: { project: string; number: number; title: string }[]
  queue: string[]
  slots: { project: string; slot: string; agent: string }[]
  copies: { project: string; copy: string; kind: string }[]
}

export const drainEmpty = (d: SwitchDrain): boolean => !d.lanes.length && !d.cards.length && !d.queue.length && !d.slots.length && !d.copies.length

/** A gate the repository uses (from main's assessment): what uses it, or what couldn't be read (which counts as using it). */
export type GateCheck = { gate: Gate; clear: true } | { gate: Gate; uses: string[] } | { gate: Gate; unknown: string }

/** What keeps a jj repository from going back to Git (HI-2799): each a code and what it is about. */
export type FallbackProblem = { code: 'heads'; n: number } | { code: 'conflictedBookmark'; name: string } | { code: 'notExported'; name: string } | { code: 'conflictedCommit'; commit: string } | { code: 'unknown'; detail: string }

/** A store-wide switch's warning (HI-2799): the projects that switch together, what still runs, what jj can't do. */
export interface StoreSwitch {
  /** Every project of this workspace on the repository that switches (named in the warning), with its choice now. */
  group: { path: string; name: string; from: PlatformId }[]
  /** The group as shown, for the switch's own check: a project joining or changing since refuses it (`groupChanged`). */
  token: string
  drain: SwitchDrain
  /** To jj: each repository gate's finding. */
  gates?: GateCheck[]
  /** To jj: jj's own limits, always (relocation, plain Git, advance, publish, the shared folder). */
  unsupported?: Gate[]
  /** Back to Git: what isn't ready. */
  fallback?: FallbackProblem[]
}
