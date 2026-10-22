// A lane's stages in the window (#1421): the stage a card's segment names, and the lanes' legend, from each project's
// stages and names (`workflow:stages`). Apart from laneBar.ts, which hive-mcp reaches: stage names load the translations.

import { columnName, type Tr } from './tasks'
import type { ProjectStages, TaskCard } from './types'
import type { WorkBadge } from './workflow/workView'
import { CATEGORY_STAGE, STAGE_CATEGORY, type Category } from './workflow/facts'
import { stageName, stagesShown, STAGE_ORDER } from './workflow/stages'
import type { SegmentStage, SegmentState } from './laneBar'

/**
 * The stage a card's segment names (#1421): from its facts (`WorkBadge.stage`, under its own ruleset), else its column's;
 * a badge read before the card's last move (its stage in another category) gives way to the column. `project`: its
 * project's stages and names (`workflow:stages`); without them, the stage's own name and no divided line.
 */
export function segmentStage(card: Pick<TaskCard, 'column'>, badge: Pick<WorkBadge, 'stage'> | undefined, project: Pick<ProjectStages, 'stages' | 'names'> | undefined, tr: Tr): SegmentStage {
  const column = card.column as Category
  const id = badge && STAGE_CATEGORY[badge.stage] === column ? badge.stage : CATEGORY_STAGE[column]
  const names = project?.names
  const category = project ? stagesShown(project, [id], names, tr).filter((s) => s.category === column).map((s) => ({ id: s.id, name: s.name })) : []
  return { id, name: stageName(id, names, tr), renamed: !!names?.[id], category }
}

/** The categories in the legend's order (#1421): as a lane's segments go, then On Hold (shown with blocked cards). */
const LEGEND_ORDER: readonly Category[] = ['todo', 'doing', 'review', 'passed', 'done', 'hold']

/** A category's segment look: its state's colour and pattern (On Hold is a blocked card's red hatching). */
const LEGEND_STATE: Record<Category, SegmentState> = { todo: 'todo', doing: 'doing', review: 'review', passed: 'passed', done: 'done', hold: 'blocked' }

/** A line of the lanes' legend (#1421): a category, its segment's look, and the stages in it of the projects shown, by name. */
export interface LegendGroup {
  category: Category
  state: SegmentState
  name: string
  stages: string[]
}

/**
 * The lanes' legend (#1421, the Lanes bar's hover): by category, in the order lanes go, each with its colour and pattern
 * and the stages in it that the projects shown produce, by their names (renames included, each name once). A category
 * whose only stage has its own name lists none; a project's stages none (not known): its categories' default stages.
 */
export function laneLegend(projects: readonly Pick<ProjectStages, 'stages' | 'names'>[], tr: Tr): LegendGroup[] {
  const shown = new Map<Category, string[]>()
  const add = (c: Category, name: string): void => {
    const list = shown.get(c) ?? []
    if (!list.includes(name)) list.push(name)
    shown.set(c, list)
  }
  for (const p of projects) for (const s of STAGE_ORDER.filter((id) => p.stages.some((x) => x.id === id))) add(STAGE_CATEGORY[s], stageName(s, p.names, tr))
  return LEGEND_ORDER.map((c) => {
    const name = columnName(c, tr)
    const stages = shown.get(c) ?? []
    return { category: c, state: LEGEND_STATE[c], name, stages: stages.length === 1 && stages[0] === name ? [] : stages }
  })
}
