// The board's columns from stages (#1420, SPEC §16.5.2): each category in its fixed order, with the stages the shown
// projects' options produce as its columns, and any stage a card is still in (a card under old rules keeps its stage
// shown). On Hold, Todo, Active and Done always show; another category shows only with a stage. A stage's column is
// named by the project's rename when one project is shown, or when every shown project names it alike; otherwise by
// its default name, and each card's hover gives its own project's name. Pure, so the layout is unit-tested.

import type { BoardColumnId, ProjectStages, TaskColumn } from '../../shared/types'
import { CATEGORY_STAGE, STAGE_CATEGORY, type StageId } from '../../shared/workflow/facts'
import { STAGE_ORDER, stageName, stagesShown, type StageNames } from '../../shared/workflow/stages'
import { TASK_COLUMNS, type Tr } from '../../shared/tasks'

/** The column a stage is shown in: its category's, except Merging's own. */
export const columnOfStage = (s: StageId): BoardColumnId => (s === 'merging' ? 'merging' : STAGE_CATEGORY[s])

export interface BoardStageColumn {
  id: BoardColumnId
  stage: StageId
  category: TaskColumn
  name: string
  /** Cards enter Merging only through the merge queue: no drop there. */
  dropTarget: boolean
}

export interface BoardCategory {
  category: TaskColumn
  columns: BoardStageColumn[]
}

/** The categories shown whatever the options. */
const ALWAYS: readonly TaskColumn[] = ['hold', 'todo', 'doing', 'done']

/** A shown project: its name and stages (`workflow:stages`; null while its version control isn't recorded). */
export interface BoardProject {
  name: string
  stages: ProjectStages | null
}

/** A card as the layout needs it: its project and its stage (from its facts, else its column's). */
export interface BoardCardStage {
  project: string
  stage: StageId
}

/**
 * The columns of the board, by category, in board order. `enforced`: Settings → Advanced → Workflow rules are enforced;
 * off, cards move freely, so every category shows, as before 1.0, whatever the board shows (the workspace's own cards
 * too, which no project's rules cover).
 */
export function boardLayout(projects: readonly BoardProject[], cards: readonly BoardCardStage[], tr?: Tr, enforced = true): BoardCategory[] {
  const shown = new Set<StageId>(ALWAYS.map((c) => CATEGORY_STAGE[c]))
  if (!enforced) for (const c of TASK_COLUMNS) shown.add(CATEGORY_STAGE[c.id])
  const lower = (s: string): string => s.toLowerCase()
  for (const p of projects) {
    const own = cards.filter((c) => lower(c.project) === lower(p.name)).map((c) => c.stage)
    for (const s of stagesShown(p.stages ?? { stages: [] }, own)) shown.add(s.id)
  }
  // Cards of no shown project (the workspace's own): their stages too.
  for (const c of cards) if (!projects.some((p) => lower(p.name) === lower(c.project))) shown.add(c.stage)
  const name = (stage: StageId): string => {
    const names = projects.map((p) => p.stages?.names?.[stage] ?? null)
    const first = names[0] ?? null
    const alike = names.length > 0 && names.every((n) => n === first)
    return stageName(stage, alike && first ? { [stage]: first } : null, tr)
  }
  return TASK_COLUMNS.flatMap(({ id: category }) => {
    const columns = STAGE_ORDER.filter((s) => shown.has(s) && STAGE_CATEGORY[s] === category).map((stage) => ({ id: columnOfStage(stage), stage, category, name: name(stage), dropTarget: stage !== 'merging' }))
    return columns.length ? [{ category, columns }] : []
  })
}

/** The stage a card is shown in: its facts' stage while it is in that stage's category, else its column's default stage. */
export function cardStage(column: TaskColumn, factsStage: StageId | null | undefined): StageId {
  return factsStage && STAGE_CATEGORY[factsStage] === column ? factsStage : CATEGORY_STAGE[column]
}

/** The column a card is shown in, among the board's columns: its stage's, else its category's. */
export function cardColumn(column: TaskColumn, stage: StageId, layout: readonly BoardCategory[]): BoardColumnId {
  const want = columnOfStage(stage)
  return layout.some((g) => g.columns.some((c) => c.id === want)) ? want : column
}

/**
 * A card's own project's name for its stage, when the column shows another (several projects naming it differently):
 * for its hover. Null when the column already says it.
 */
export function ownStageName(projects: readonly BoardProject[], project: string, stage: StageId, shownName: string, tr?: Tr): string | null {
  const names: StageNames | null = projects.find((p) => p.name.toLowerCase() === project.toLowerCase())?.stages?.names ?? null
  const own = stageName(stage, names, tr)
  return own === shownName ? null : own
}
