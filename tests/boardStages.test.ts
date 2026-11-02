// The board's columns from stages (#1420, SPEC §16.5.2): each category in order with the shown projects' stages as its
// columns, Approved with Merging as two, unused categories hidden (On Hold, Todo, Active and Done always shown), a stage
// kept while a card is in it, renames when one project or every shown project names it alike, and where a card goes.
import { describe, expect, it } from 'vitest'
import { boardLayout, cardColumn, cardStage, ownStageName, type BoardProject } from '../src/renderer/src/boardStages'
import { mustCompile } from '../src/shared/workflow/compile'
import { allOff, preset } from '../src/shared/workflow/options'
import type { StageId } from '../src/shared/workflow/facts'

const stagesOf = (o: Parameters<typeof mustCompile>[0], names: Partial<Record<StageId, string>> = {}): BoardProject['stages'] => ({ stages: mustCompile(o).stages, names, preset: null })
const PAIR = stagesOf(preset('git', 'pair'))
const NO_REVIEW = stagesOf({ ...allOff('git'), finish: 'committed', folder: 'project' })
const NONE = stagesOf(allOff('none'))
const ids = (layout: ReturnType<typeof boardLayout>): string => layout.map((g) => `${g.category}[${g.columns.map((c) => `${c.id}:${c.stage}`).join(',')}]`).join(' ')

describe("the board's columns from stages (#1420)", () => {
  it('Pair (Hive merges): every category, Approved with Merging as two columns, Merging no drop target', () => {
    const layout = boardLayout([{ name: 'web', stages: PAIR }], [])
    expect(ids(layout)).toBe('hold[hold:hold] todo[todo:todo] doing[doing:active] review[review:review] passed[passed:approved,merging:merging] done[done:done]')
    const approved = layout.find((g) => g.category === 'passed')!
    expect(approved.columns.map((c) => [c.name, c.dropTarget])).toEqual([
      ['Approved', true],
      ['Merging', false]
    ])
  })

  it('a No review project hides Review and Approved; On Hold, Todo, Active and Done always show', () => {
    expect(ids(boardLayout([{ name: 'web', stages: NO_REVIEW }], []))).toBe('hold[hold:hold] todo[todo:todo] doing[doing:active] done[done:done]')
    // A project whose version control isn't recorded yet: the four always.
    expect(ids(boardLayout([{ name: 'web', stages: null }], []))).toBe('hold[hold:hold] todo[todo:todo] doing[doing:active] done[done:done]')
  })

  it('with the workflow rules not enforced, every category shows (cards move freely)', () => {
    const six = 'hold[hold:hold] todo[todo:todo] doing[doing:active] review[review:review] passed[passed:approved] done[done:done]'
    expect(ids(boardLayout([{ name: 'web', stages: NO_REVIEW }], [], undefined, false))).toBe(six)
    // The workspace's own cards (no project shown): the same, whatever projects there are.
    expect(ids(boardLayout([], [{ project: '', stage: 'todo' }], undefined, false))).toBe(six)
    expect(ids(boardLayout([], [{ project: '', stage: 'todo' }]))).toBe('hold[hold:hold] todo[todo:todo] doing[doing:active] done[done:done]')
  })

  it('a stage its options no longer produce stays while a card is in it, and goes once none is', () => {
    expect(ids(boardLayout([{ name: 'web', stages: NO_REVIEW }], [{ project: 'web', stage: 'review' }]))).toContain('review[review:review]')
    expect(ids(boardLayout([{ name: 'web', stages: NO_REVIEW }], [{ project: 'web', stage: 'active' }]))).not.toContain('review')
    // Another project's card doesn't keep this project's stage: it is that project's.
    expect(ids(boardLayout([{ name: 'web', stages: NO_REVIEW }, { name: 'api', stages: NO_REVIEW }], [{ project: 'api', stage: 'merging' }]))).toContain('passed[merging:merging]')
  })

  it('several projects: the union of their stages; a None project beside a Git one', () => {
    expect(ids(boardLayout([{ name: 'notes', stages: NONE }, { name: 'web', stages: PAIR }], []))).toBe('hold[hold:hold] todo[todo:todo] doing[doing:active] review[review:review] passed[passed:approved,merging:merging] done[done:done]')
  })

  it("names a column by the rename of the one project shown, or one every shown project shares; else the default, and the card's hover its own", () => {
    const building = stagesOf(preset('git', 'pair'), { active: 'Building' })
    const making = stagesOf(preset('git', 'pair'), { active: 'Making' })
    const name = (projects: BoardProject[]): string => boardLayout(projects, []).find((g) => g.category === 'doing')!.columns[0].name
    expect(name([{ name: 'web', stages: building }])).toBe('Building')
    expect(name([{ name: 'web', stages: building }, { name: 'api', stages: stagesOf(preset('git', 'pair'), { active: 'Building' }) }])).toBe('Building')
    const two = [
      { name: 'web', stages: building },
      { name: 'api', stages: making }
    ]
    expect(name(two)).toBe('Active')
    expect(ownStageName(two, 'web', 'active', 'Active')).toBe('Building')
    expect(ownStageName(two, 'api', 'active', 'Active')).toBe('Making')
    // Where the column already says it, no hover.
    expect(ownStageName([{ name: 'web', stages: building }], 'web', 'active', 'Building')).toBeNull()
    expect(name([{ name: 'web', stages: building }, { name: 'api', stages: PAIR }])).toBe('Active')
  })

  it('places a card by its facts’ stage within its category, else in its category’s column', () => {
    const layout = boardLayout([{ name: 'web', stages: PAIR }], [])
    expect(cardColumn('passed', cardStage('passed', 'merging'), layout)).toBe('merging')
    expect(cardColumn('passed', cardStage('passed', 'approved'), layout)).toBe('passed')
    expect(cardColumn('passed', cardStage('passed', null), layout)).toBe('passed')
    // A stage that disagrees with its column (a user's move not yet read back): its column's.
    expect(cardStage('done', 'merging')).toBe('done')
    // Merging not shown: its category's column.
    expect(cardColumn('passed', 'merging', boardLayout([{ name: 'web', stages: NO_REVIEW }], []))).toBe('passed')
  })
})
