import type { Tip } from '../../tips'
import { msg } from '../../i18n/msg'

/** The Antigravity CLI's tips (shared/tips.ts lists them with Combwork's own, HI-3201). */
export const TIPS: Tip[] = [
  { id: 'antigravity', group: 'Agents', order: 113.5, title: msg({ id: 'tips.antigravity.title', defaultMessage: 'Run agents on the Antigravity CLI', description: "A tip's title. Antigravity CLI is a product name." }), text: msg({ id: 'tips.antigravity.text', defaultMessage: 'Agents can use Google’s Antigravity CLI. Provider Setup installs it; sign in once in a terminal and every workspace on this PC shares the sign-in. Each agent runs in a private profile of its own.', description: "A tip. Names of Combwork's menus, views, settings and commands: keep them as Combwork shows them." }), docs: 'antigravity-cli', command: 'help.agentSetup' } // i18n-ignore: its words are messages; its group is a key of TIP_GROUPS (TIP_GROUP_TEXT names it), docs a user guide heading's id
]
