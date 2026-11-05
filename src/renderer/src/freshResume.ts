// HI-2540: a conversation that can't continue (shared/sessionFresh: from before the tools agents use were renamed, or
// run in a folder that moved with .hive to .combwork) starts a new one when resumed. Its Resume says so before it is
// pressed (a tooltip, a line in a picker), and asks before it starts, instead of the re-cache question.

import { msg, tr } from '@shared/i18n'
import type { FreshReason } from '@shared/sessionFresh'

const M = {
  title: msg({ id: 'freshResume.title', defaultMessage: 'Start a new conversation?', description: 'Title of the question when Resume is pressed on a conversation that cannot continue (HI-2540): a new one starts instead.' }),
  message: msg({ id: 'freshResume.message', defaultMessage: "{why, select, moved {This conversation ran in a folder that moved with .hive to .combwork, so it can't continue there.} other {This conversation started before Combwork renamed the tools agents use, so it can't continue.}}", description: 'The question when Resume is pressed on a conversation that cannot continue (HI-2540): why. moved: its folder moved with .hive to .combwork (keep both names as they are); other: Combwork renamed the tools agents use since it started.' }),
  detail: msg({ id: 'freshResume.detail', defaultMessage: "{assistant, select, yes {The Assistant starts a new conversation instead, and the old one stays in its conversations to read.} other {{agent} starts a new conversation instead. It carries on the agent's work (its watch, messages and tasks), and the old conversation stays in Sessions to read.}}", description: 'Under the question when Resume is pressed on a conversation that cannot continue (HI-2540): what starting a new one does. assistant yes: the Combwork Assistant (its conversations: the list in its panel); other: an agent ({agent}: its name). Sessions is a tab of the window: keep it as the window names it.' }),
  confirm: msg({ id: 'freshResume.confirm', defaultMessage: 'Start New Conversation', description: 'Button of the question when Resume is pressed on a conversation that cannot continue (HI-2540): starts a new conversation instead.' }),
  tip: msg({ id: 'freshResume.tip', defaultMessage: "{why, select, moved {Starts a new conversation: \"{session}\" ran in a folder that moved with .hive to .combwork, so it can't continue} other {Starts a new conversation: \"{session}\" is from before Combwork renamed the tools agents use, so it can't continue}}", description: "Tooltip of a Resume button whose conversation ({session}: its name) cannot continue (HI-2540): pressing it starts a new one. moved: its folder moved with .hive to .combwork (keep both names); other: the tools agents use were renamed since." }),
  short: msg({ id: 'freshResume.short', defaultMessage: 'starts a new conversation', description: "A conversation in a session picker that cannot continue (HI-2540): resuming it starts a new one. Lower case: it follows how long ago it ran." })
}

/** The question before such a resume: its title, message, detail and button, for confirm(). */
export function freshQuestion(why: FreshReason, who: { assistant: boolean; agent: string }): { title: string; message: string; detail: string; confirmLabel: string } {
  return {
    title: tr(M.title),
    message: tr(M.message, { why }),
    detail: tr(M.detail, { assistant: who.assistant ? 'yes' : 'no', agent: who.agent }),
    confirmLabel: tr(M.confirm)
  }
}

/** A Resume button's tooltip when its conversation starts fresh. */
export const freshTip = (why: FreshReason, session: string): string => tr(M.tip, { why, session })

/** A session picker's line for such a conversation. */
export const freshShort = (): string => tr(M.short)
