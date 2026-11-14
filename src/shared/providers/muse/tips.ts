import type { Tip } from '../../tips'
import { msg } from '../../i18n/msg'

/** Muse Code's tips (shared/tips.ts lists them with Combwork's own, HI-3201). */
export const TIPS: Tip[] = [
  { id: 'muse', group: 'Agents', order: 113.8, title: msg({ id: 'tips.muse.title', defaultMessage: 'Run agents on Muse Code', description: "A tip's title. Muse Code is a product name." }), text: msg({ id: 'tips.muse.text', defaultMessage: 'Agents can use Meta’s Muse Code. Install it with Meta’s installer, add a Muse Code account in Settings → Accounts & Connections and sign it in there. Each account keeps its own sign-in, settings and sessions, apart from your own Muse.', description: "A tip. Muse Code and Meta are names. Names of Combwork's menus, views, settings and commands: keep them as Combwork shows them." }), docs: 'muse-code', command: 'help.agentSetup' } // i18n-ignore: its words are messages; its group is a key of TIP_GROUPS (TIP_GROUP_TEXT names it), docs a user guide heading's id
]
