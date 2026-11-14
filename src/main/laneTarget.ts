// HI-3113: a lane's Merges into, read in one place. A lane started on the project's own branch records G7 as it was,
// unmarked (HI-2556 marks only another branch), and keeps merging there when Work merges into moves on (Start the next
// version), so its branch is the mark, else its recorded ruleset's target (`laneTargetOf`). Its own module: lanes.ts,
// laneEdits.ts and laneStart.ts read it, and tests that mock lanes.ts keep it.
import type { LaneRecord } from '../shared/lanes'
import { laneTargetOf } from '../shared/workflow/compile'
import { FactStore } from './workflow/factStore'
import type { WorkspaceService } from './workspace'

/** A project's recorded rulesets' options by id, as `laneTargetOf` and `laneOptions` read them. */
export const storedRulesets =
  (ws: WorkspaceService, project: string) =>
  (id: string): { target?: string | null } | null =>
    ws.path ? FactStore.forBoard(ws, { project, key: '' }).ruleset(id).options : null

/**
 * A lane's Merges into: the branch its work merges into, marked or as its recorded ruleset names it, null without one.
 * Compare with the project's own through `otherThanOwn`.
 */
export function laneTarget(ws: WorkspaceService, l: Pick<LaneRecord, 'project' | 'ruleset'>): string | null {
  return laneTargetOf(l.ruleset, storedRulesets(ws, l.project))
}
