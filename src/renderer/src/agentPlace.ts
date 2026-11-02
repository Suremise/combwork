// Where an agent works, as the window shows it (#1442, SPEC §16.10.3): main sends each agent's place with its live state
// (AgentInfo.place, from #1434's folder contract) and the project's named folders (ProjectInfo.folders). Pure functions
// of those, so no store selector makes a fresh object.
import { msg, tr } from '@shared/i18n'
import { samePath } from '@shared/movePaths'
import type { NamedFolder, ShownPlace } from '@shared/agentFolders'
import type { AgentInfo, ProjectInfo } from '@shared/types'

/** The folder the agent works in now: its running session's, else where its next conversation starts. */
export const agentFolder = (a: Pick<AgentInfo, 'place'>): string => a.place.folder

/** Its 0.9 worktree while it still works there (#1441 hasn't migrated it): what the 0.9 worktree actions act on. */
export function legacyOf(a: Pick<AgentInfo, 'place'>): { path: string; branch: string; base: string } | null {
  const p = a.place
  return p.is === 'legacy' ? { path: p.folder, branch: p.branch ?? '', base: p.base ?? '' } : null
}

/**
 * The folder its work is in, away from the project folder (#1569): the slot it builds in, the slot kept for it or its
 * 0.9 worktree, with its branch and the branch that work is compared with (`base`), when known; null in the project
 * folder or a retired home. What the Changes tab lists as in use.
 */
export function workFolderOf(a: Pick<AgentInfo, 'place'>): { path: string; branch: string | null; base: string | null } | null {
  const p = a.place
  return p.is === 'slot' || p.is === 'carried' || p.is === 'legacy' ? { path: p.folder, branch: p.branch || null, base: p.base || null } : null
}

/** Whether it works outside the project folder (a slot, a carried slot, a home or a 0.9 worktree). */
export const awayFromProject = (a: Pick<AgentInfo, 'place'>): boolean => a.place.is !== 'project'

const PLACE = msg({
  id: 'agents.place.short',
  defaultMessage: '{is, select, slot {in {name}} carried {carried: {name}} home {home: {name}} other {0.9 worktree: {name}}}',
  description: "Where an agent works, shown on its pane's header, in its hover and in the Agents table: in a slot it builds in ({name}: the slot's name, such as slot-b), its carried slot (its own worktree from before 1.0, kept for it), a reviewer's retired home, or its worktree from before 1.0 (Hive 0.9) not moved to a slot yet. Lower case."
})

/** "in slot-b", "carried: hb2", "home: hr4", "0.9 worktree: hb1"; null in the project folder. */
export const placeText = (place: ShownPlace): string | null => (place.is === 'project' || !place.name ? null : tr(PLACE, { is: place.is, name: place.name }))

/** The hover's line, for an agent outside the project folder: where it works, with the folder's path. */
export const placeTip = (place: ShownPlace): string =>
  tr(msg({ id: 'agents.place.tip', defaultMessage: '{is, select, slot {Works in {name}: {path}} carried {Works in {name}, the slot kept for it: {path}} home {Works in its retired home {name}: {path}} other {Works in its 0.9 worktree {name}: {path}}}', description: "A line of an agent's hover: where it works and that folder's path ({path}): a slot it builds in ({name}: the slot's name, such as slot-b), its carried slot (its own worktree from before 1.0, kept for it as a slot), a reviewer's retired home, or its worktree from before 1.0 (Hive 0.9) not moved to a slot yet. Glossary: slot." }), { is: place.is, name: place.name ?? '', path: place.folder })

/** A folder of the project's by name: a slot's, a retired home's, or null (the project folder, or one it doesn't know). */
export const namedFolder = (project: Pick<ProjectInfo, 'folders'>, folder: string): NamedFolder | null => project.folders?.find((f) => samePath(f.path, folder)) ?? null
