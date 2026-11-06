// The board's stages (SPEC §16.5.2, #1417): the stages a ruleset produces, in board order, each in its fixed category,
// and their names: a message per stage (glossary 2.2), or the project's own name for it (N5, OP-30). Every view that names
// a stage (the board, the Progress panel, the options, the branches) reads it here, so a stage is named, translated and
// renamed once.
//
// Names aren't rules: `stageNames` is left out of the compiled ruleset and its hash (compile.ts), so a rename applies at
// once everywhere and never marks a card "old rules". Agents keep the stage and category ids.

import { msg, type Msg } from '../i18n/msg'
import type { Tr } from '../tasks'
import { agentText, englishText, withValues, type Text } from '../advanced'
import { CATEGORY_STAGE, STAGE_CATEGORY, type Category, type StageId } from './facts'

/** Every stage, in board order (§16.5.2). */
export const STAGE_ORDER: readonly StageId[] = ['hold', 'todo', 'active', 'review', 'approved', 'merging', 'done']

export const isStageId = (v: unknown): v is StageId => typeof v === 'string' && (STAGE_ORDER as readonly string[]).includes(v)

/** A project's own names for its stages (N5): a stage it doesn't name keeps its default name. */
export type StageNames = Partial<Record<StageId, string>>

/** A stage of the board: its id, the category it sits in and its name (the project's, else its message's). */
export interface Stage {
  id: StageId
  category: Category
  name: string
}

/** Each stage's default name (glossary 2.2). */
export const STAGE_TEXT: Record<StageId, Msg> = {
  hold: msg({ id: 'workflow.stage.hold', defaultMessage: 'On Hold', description: 'A stage of the board (glossary 2.2: On Hold): parked cards nobody picks up until the user moves them on.' }),
  todo: msg({ id: 'workflow.stage.todo', defaultMessage: 'Todo', description: 'A stage of the board (glossary 2.2: Todo): cards not started.' }),
  active: msg({ id: 'workflow.stage.active', defaultMessage: 'Active', description: 'A stage of the board (glossary 2.2: Active, was Doing): cards being worked on.' }),
  review: msg({ id: 'workflow.stage.review', defaultMessage: 'Review', description: 'A stage of the board (glossary 2.2: Review): cards waiting for, or in, review.' }),
  approved: msg({ id: 'workflow.stage.approved', defaultMessage: 'Approved', description: 'A stage of the board (glossary 2.2: Approved, was Passed): cards whose work passed review (or your OK) and isn’t merged yet.' }),
  merging: msg({ id: 'workflow.stage.merging', defaultMessage: 'Merging', description: "A stage of the board inside Approved (glossary 2.2: Merging): cards in Combwork's merge queue." }),
  done: msg({ id: 'workflow.stage.done', defaultMessage: 'Done', description: 'A stage of the board (glossary 2.2: Done): cards whose work is merged, or accepted.' })
}

/**
 * A stage's name: the project's own (N5), else its message in the window's language (tr given), else in English. An id
 * this Combwork doesn't know (a record from a newer one) is shown as it is.
 */
export function stageName(id: string, names?: StageNames | null, tr?: Tr): string {
  const own = names?.[id as StageId]
  if (own) return own
  const m = isStageId(id) ? STAGE_TEXT[id] : null
  if (!m) return id
  return tr ? tr(m) : agentText(m)
}

/** The stages of a ruleset (its `stages`, already in board order), each with its category and name. */
export function stagesOf(ruleset: { stages: readonly { id: StageId }[] }, names?: StageNames | null, tr?: Tr): Stage[] {
  return ruleset.stages.map((s) => ({ id: s.id, category: STAGE_CATEGORY[s.id], name: stageName(s.id, names, tr) }))
}

/**
 * A card's stage, from its facts (`WorkBadge.stage`, which a card keeps under its own ruleset, §16.5.4); a card with no
 * work view (none read yet, no project) stands in its column's default stage.
 */
export const stageOf = (card: { column: Category }, badge?: { stage: StageId } | null): StageId => badge?.stage ?? CATEGORY_STAGE[card.column]

/**
 * The stages the board shows: those the ruleset produces, and any it no longer produces while a card is still in it
 * (§16.5.2, §16.17: a card keeps the stages of its own ruleset), in board order.
 */
export function stagesShown(ruleset: { stages: readonly { id: StageId }[] }, cardsStages: Iterable<StageId>, names?: StageNames | null, tr?: Tr): Stage[] {
  const shown = new Set<StageId>(ruleset.stages.map((s) => s.id))
  for (const s of cardsStages) if (isStageId(s)) shown.add(s)
  return STAGE_ORDER.filter((id) => shown.has(id)).map((id) => ({ id, category: STAGE_CATEGORY[id], name: stageName(id, names, tr) }))
}

/** The longest name a stage takes (N5). */
export const STAGE_NAME_MAX = 24

/** Why a stage's name can't be saved (N5): each a whole sentence naming the stage. */
export const STAGE_NAME_PROBLEMS = {
  empty: msg({ id: 'workflow.stageName.empty', defaultMessage: 'The name of {stage} can’t be empty: remove it to use the default name.', description: 'Why workflow options cannot be saved: a stage was given an empty name. {stage} is the stage’s default name (glossary 2.2).' }),
  long: msg({ id: 'workflow.stageName.long', defaultMessage: 'The name of {stage} is longer than {max, number} characters.', description: 'Why workflow options cannot be saved: a stage’s name is too long. {stage} is the stage’s default name (glossary 2.2), {max} the most characters it takes.' }),
  duplicate: msg({ id: 'workflow.stageName.duplicate', defaultMessage: 'The name of {stage} is already another stage’s name.', description: 'Why workflow options cannot be saved: two stages would have the same name. {stage} is the default name of the stage renamed (glossary 2.2).' }),
  control: msg({ id: 'workflow.stageName.control', defaultMessage: 'The name of {stage} has a character that can’t be shown (a line break or a tab).', description: 'Why workflow options cannot be saved: a stage’s name has a control character. {stage} is the stage’s default name (glossary 2.2).' })
} satisfies Record<string, Msg>

export type StageNameProblem = { stage: StageId; why: keyof typeof STAGE_NAME_PROBLEMS }

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** A name as it is kept: trimmed. */
export const keptStageName = (name: string): string => name.trim()

/**
 * The names that can't be saved (N5): empty, longer than STAGE_NAME_MAX, with a control character, or the same (ignoring
 * case) as another stage's name. Every stage counts, whether the options produce it or not: a stage they no longer produce
 * is still shown while a card is in it (§16.17), and options change. A stage's name is its rename, else its default name
 * in English and, given `tr`, in the language Combwork shows (HR2's #1417 round 1: the window shows the translated names).
 */
export function stageNameProblems(names: StageNames | null | undefined, tr?: Tr): StageNameProblem[] {
  const out: StageNameProblem[] = []
  if (!names) return out
  const fold = (n: string): string => keptStageName(n).toLocaleLowerCase('en')
  // agent-protocol: the names a stage is matched by (what agents and the user type), not text sent
  const namesOf = (id: StageId): string[] => (names[id] !== undefined ? [fold(names[id]!)] : [fold(englishText(STAGE_TEXT[id])), ...(tr ? [fold(tr(STAGE_TEXT[id]))] : [])])
  const why = (id: StageId, raw: string): StageNameProblem['why'] | null => {
    const name = keptStageName(raw)
    if (!name) return 'empty' // i18n-ignore: a problem's key (STAGE_NAME_PROBLEMS has its message)
    if (CONTROL.test(raw)) return 'control' // i18n-ignore: a problem's key (STAGE_NAME_PROBLEMS has its message)
    if ([...name].length > STAGE_NAME_MAX) return 'long' // i18n-ignore: a problem's key (STAGE_NAME_PROBLEMS has its message)
    return STAGE_ORDER.some((other) => other !== id && namesOf(other).includes(fold(name))) ? 'duplicate' : null // i18n-ignore: a problem's key (STAGE_NAME_PROBLEMS has its message)
  }
  for (const id of STAGE_ORDER) {
    const raw = names[id]
    const w = raw === undefined ? null : why(id, raw)
    if (w) out.push({ stage: id, why: w })
  }
  return out
}

/** A stage name's problem as a message and its values (the stage by its default name, in the language it's shown in). */
export const stageNameProblemText = (p: StageNameProblem): Text => withValues(STAGE_NAME_PROBLEMS[p.why], { stage: STAGE_TEXT[p.stage], max: STAGE_NAME_MAX })
