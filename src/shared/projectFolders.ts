// How Repair and project removal name a project's slots, copies and retired homes (#1447): "slot-b (HI-B1, AM-12)",
// "copy-1", "hb2 (carried, HB2)", "HR4's old folder". Worded when shown, in the language shown.
import { fmt, msg, tr } from './i18n'
import type { ProjectFolderOf } from './types'

const M = {
  slot: msg({ id: 'workspace.folder.slot', defaultMessage: '{carried, select, yes {{name} (carried, {agent})} other {{hasAgent, select, yes {{hasCards, select, yes {{name} ({agent}, {cards})} other {{name} ({agent})}}} other {{hasCards, select, yes {{name} ({cards})} other {{name}}}}}}}', description: "What a project's slot is called in Repair's plan and report and in Remove Project (#1447): its name ({name}, such as slot-b), the agent it is lent to ({agent}) and the cards it held ({cards}, keys such as AM-12, a list). carried: an agent's own worktree from before 1.0, kept as a slot for it (carried is Combwork's term: translate it as a short word)." }),
  copy: msg({ id: 'workspace.folder.copy', defaultMessage: '{name}', description: "What a project's review or check copy is called in Repair's plan and report and in Remove Project (#1447): its name ({name}, such as copy-1). Usually left as it is." }),
  home: msg({ id: 'workspace.folder.home', defaultMessage: "{hasAgent, select, yes {{agent}'s old folder} other {an old reviewer folder}}", description: "What a retired home is called in Repair's plan and report and in Remove Project (#1447): a reviewer agent's ({agent}) own worktree from before 1.0, where its conversations still resume." })
}

/** A project folder's name, as Repair's What column and Remove Project say it. */
export function folderWhat(of: ProjectFolderOf): string {
  if (of.kind === 'copy') return tr(M.copy, { name: of.name })
  if (of.kind === 'home') return tr(M.home, { hasAgent: of.agent ? 'yes' : 'no', agent: of.agent ?? '' })
  return tr(M.slot, { name: of.name, carried: of.carried ? 'yes' : 'no', hasAgent: of.agent ? 'yes' : 'no', agent: of.agent ?? '', hasCards: of.cards.length ? 'yes' : 'no', cards: fmt.list(of.cards, 'unit') })
}
