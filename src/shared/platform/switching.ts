// Switching a project's version control (#1419, SPEC §16.6.5): which switch can be made from what Combwork detects now, and
// its reasons, the same in the window (the choice atop the Version Control tab) and in main (the switch, under the
// project's lock, and the Assistant's settings tool). Choosing None is never refused for what is detected (#1122: you
// pick the version control): Git only where a Git repository is found and no other version control is.

import { msg, type Msg } from '../i18n/msg'
import type { Detection, PlatformId } from './descriptors'

/** A platform's name as Combwork shows it (glossary 2.1). */
export const PLATFORM_NAME: Record<PlatformId, Msg> = {
  none: msg({ id: 'git.vc.none', defaultMessage: 'None', description: 'The version control of a project without any, in the choice atop the Version Control tab and in "Workflow: None · Solo" (glossary 2.1: None).' }),
  git: msg({ id: 'git.vc.git', defaultMessage: 'Git', description: 'A version control system’s name, in the choice atop the Version Control tab (glossary 2.1: keep).' })
}

/** Why a switch can't be made now: no Git repository, or another version control found. */
export type SwitchRefusal = { why: 'noGit' } | { why: 'otherFound'; vcs: string }

export const SWITCH_REFUSED = {
  noGit: msg({ id: 'git.vc.switch.noGit', defaultMessage: 'No Git repository here: Initialise repository… first.', description: 'Why a project can’t be switched to Git (the Version Control tab’s choice, a refusal): its folder has no Git repository. Initialise repository… is a button’s name: keep it as translated there.' }),
  otherFound: msg({ id: 'git.vc.switch.otherFound', defaultMessage: '{vcs} found: not supported yet, so this project can only use None.', description: 'Why a project can’t be switched to Git: another version control ({vcs}: Mercurial, Jujutsu) was found in its folder. None: glossary 2.1.' }),
  changed: msg({ id: 'git.vc.switch.changed', defaultMessage: 'Changed meanwhile: this project uses {platform} now. Look again before switching.', description: 'Why a switch of version control was refused: someone else switched it since the tab was shown. {platform} is None or Git.' })
} satisfies Record<string, Msg>

/** Whether a project can switch to `to` from what is detected now: null when it can. */
export function switchRefused(to: PlatformId, found: Detection): SwitchRefusal | null {
  if (to !== 'git') return null
  if (found.other) return { why: 'otherFound', vcs: found.other } // i18n-ignore: a reason's key, not text
  return found.platform === 'git' ? null : { why: 'noGit' } // i18n-ignore: a reason's key, not text
}

/** A refusal's message and values. */
export const switchRefusalText = (r: SwitchRefusal): { m: Msg; values?: Record<string, string> } => (r.why === 'otherFound' ? { m: SWITCH_REFUSED.otherFound, values: { vcs: r.vcs } } : { m: SWITCH_REFUSED.noGit })
