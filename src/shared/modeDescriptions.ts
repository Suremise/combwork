import { msg, type Msg } from './i18n/msg'

/**
 * The names of the modes Combwork ships (resources/modes), as the window shows them (#806), by mode id. Display only: the
 * files keep their names, and what the Assistant reads is the file. tests/modeDescriptions.test.ts keeps these equal to
 * the mode files.
 */
export const SHIPPED_MODE_NAMES: Record<string, Msg> = {
  coordinator: msg({ id: 'assistant.modes.shipped.coordinator', defaultMessage: 'Coordinator', description: "The name of a mode of the Combwork Assistant that ships with Combwork: it runs the work across the agents. Shown in its menus and the Assistant view; keep it short." }),
  planner: msg({ id: 'assistant.modes.shipped.planner', defaultMessage: 'Planner', description: "The name of a mode of the Combwork Assistant that ships with Combwork: it shapes work before anyone starts it. Shown in its menus and the Assistant view; keep it short." }),
  'qa-triager': msg({ id: 'assistant.modes.shipped.qaTriager', defaultMessage: 'QA triager', description: "The name of a mode of the Combwork Assistant that ships with Combwork: it turns a bug report into a card with evidence. Shown in its menus and the Assistant view; keep it short." }),
  'release-manager': msg({ id: 'assistant.modes.shipped.releaseManager', defaultMessage: 'Release manager', description: "The name of a mode of the Combwork Assistant that ships with Combwork: it takes a release through its checklist. Shown in its menus and the Assistant view; keep it short." })
}

/** What the modes Combwork ships are for (their files' description), as the window shows them (#885). Display only, as their names. */
export const SHIPPED_MODE_DESCRIPTIONS: Record<string, Msg> = {
  coordinator: msg({ id: 'assistant.modes.shippedDescription.coordinator', defaultMessage: 'Runs the work across the agents: state first, facts looked up before asked, short status tables, lane prompts from settled cards, decisions only when they are real.', description: "What a mode of the Combwork Assistant that ships with Combwork (Coordinator) is for, in a line: under its name in the mode menu and the Assistant view." }),
  planner: msg({ id: 'assistant.modes.shippedDescription.planner', defaultMessage: 'Shapes work before anyone starts it: the open questions with a recommendation each, options, lanes split by files, complete cards.', description: "What a mode of the Combwork Assistant that ships with Combwork (Planner) is for, in a line: under its name in the mode menu and the Assistant view." }),
  'qa-triager': msg({ id: 'assistant.modes.shippedDescription.qaTriager', defaultMessage: 'Turns a bug report into a card with evidence: reproduce or read the code to find the likely cause, propose a fix, place it in the right lane.', description: "What a mode of the Combwork Assistant that ships with Combwork (QA triager) is for, in a line: under its name in the mode menu and the Assistant view." }),
  'release-manager': msg({ id: 'assistant.modes.shippedDescription.releaseManager', defaultMessage: "Takes a release through the project's release path, stage by stage: notes, licences, packaged checks; each build, version, merge, tag and publish only when asked.", description: "What a mode of the Combwork Assistant that ships with Combwork (Release manager) is for, in a line: under its name in the mode menu and the Assistant view." })
}
