// A lane's stages in the window (#1421): the stage a card's segment names, and the lanes' legend, from each project's
// stages and names (`workflow:stages`). Apart from laneBar.ts, which cw-mcp reaches: stage names load the translations.

import { columnName, type Tr } from './tasks'
import type { ProjectStages, TaskCard } from './types'
import type { WorkBadge } from './workflow/workView'
import { CATEGORY_STAGE, STAGE_CATEGORY, type Category, type StageId } from './workflow/facts'
import { stageName, stagesShown, STAGE_ORDER } from './workflow/stages'
import type { SegmentStage, SegmentState } from './laneBar'

/**
 * The stage a card's segment names (#1421): from its facts (`WorkBadge.stage`, under its own ruleset), else its column's;
 * a badge read before the card's last move (its stage in another category) gives way to the column. Its category's
 * stages are those of the rules it works under (HR4's round 1: §16.5.4, a card keeps its own ruleset's stages): its
 * own (`WorkBadge.stages`, in flight), else `lane`'s (a lane's recorded ruleset, for its cards in Todo), else its
 * project's now. Names are the project's now (`project.names`: names aren't rules). Without any, the stage's own name
 * and no divided line.
 */
export function segmentStage(card: Pick<TaskCard, 'column'>, badge: (Pick<WorkBadge, 'stage'> & Partial<Pick<WorkBadge, 'stages'>>) | undefined, project: Pick<ProjectStages, 'stages' | 'names'> | undefined, tr: Tr, lane?: readonly StageId[] | null): SegmentStage {
  const column = card.column as Category
  const id = badge && STAGE_CATEGORY[badge.stage] === column ? badge.stage : CATEGORY_STAGE[column]
  const names = project?.names
  const own = badge?.stages ?? lane ?? project?.stages.map((s) => s.id) ?? null
  const category = own ? stagesShown({ stages: own.map((s) => ({ id: s })) }, [id], names, tr).filter((s) => s.category === column).map((s) => ({ id: s.id, name: s.name })) : []
  return { id, name: stageName(id, names, tr), renamed: !!names?.[id], category }
}

/** The categories in the legend's order (#1421): as a lane's segments go, then On Hold (shown with blocked cards). */
const LEGEND_ORDER: readonly Category[] = ['todo', 'doing', 'review', 'passed', 'done', 'hold']

/** A category's segment look: its state's colour and pattern (On Hold is a blocked card's red hatching). */
const LEGEND_STATE: Record<Category, SegmentState> = { todo: 'todo', doing: 'doing', review: 'review', passed: 'passed', done: 'done', hold: 'blocked' }

/** A stage's look where it is shown with its colour (a lane segment's, #1424's branch rows): its category's. */
export const stageLook = (stage: StageId): SegmentState => LEGEND_STATE[STAGE_CATEGORY[stage]]

/** A line of the lanes' legend (#1421): a category, its segment's look, and the stages in it of the projects shown, by name. */
export interface LegendGroup {
  category: Category
  state: SegmentState
  name: string
  stages: string[]
}

/**
 * What the legend lists (HR4's #1421 round 1): the stages the lanes shown actually have, each set by its project's names
 * now: a running lane's own (its recorded ruleset's, under old rules too), else its project's now; and each of its live
 * cards' own (`WorkBadge.stages`: a card keeps its ruleset's). An ended lane shows its cards as they were, by its
 * project's stages now.
 */
export function legendSources(lanes: readonly { project: string; stages: readonly StageId[] | null; cards: readonly number[]; frozen: unknown }[], projectOf: (project: string) => Pick<ProjectStages, 'stages' | 'names'> | undefined, badges: ReadonlyMap<number, Pick<WorkBadge, 'stages'>>): Pick<ProjectStages, 'stages' | 'names'>[] {
  const out: Pick<ProjectStages, 'stages' | 'names'>[] = []
  const of = (ids: readonly StageId[]) => ids.map((id) => ({ id, category: STAGE_CATEGORY[id] }))
  for (const l of lanes) {
    const p = projectOf(l.project)
    const names = p?.names ?? {}
    const own = !l.frozen && l.stages ? of(l.stages) : p?.stages
    if (own) out.push({ stages: own, names })
    if (l.frozen) continue
    for (const n of l.cards) {
      const s = badges.get(n)?.stages
      if (s) out.push({ stages: of(s), names })
    }
  }
  return out
}

/** Names compared as read (#1496): a translation's no-break space ("A\u00a0fazer") reads as the same name as "A fazer". */
const sameName = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/**
 * The lanes' legend (#1421, the Lanes bar's hover): by category, in the order lanes go, each with its colour and pattern
 * and the stages in it of the lanes shown (`legendSources`), by their names (renames included, each name once). A
 * category whose only stage has its own name lists none; none known: its categories alone. Names that differ only in
 * their spaces are one name.
 */
export function laneLegend(projects: readonly Pick<ProjectStages, 'stages' | 'names'>[], tr: Tr): LegendGroup[] {
  const shown = new Map<Category, string[]>()
  const add = (c: Category, name: string): void => {
    const list = shown.get(c) ?? []
    if (!list.some((n) => sameName(n, name))) list.push(name)
    shown.set(c, list)
  }
  for (const p of projects) for (const s of STAGE_ORDER.filter((id) => p.stages.some((x) => x.id === id))) add(STAGE_CATEGORY[s], stageName(s, p.names, tr))
  return LEGEND_ORDER.map((c) => {
    const name = columnName(c, tr)
    const stages = shown.get(c) ?? []
    return { category: c, state: LEGEND_STATE[c], name, stages: stages.length === 1 && sameName(stages[0], name) ? [] : stages }
  })
}
