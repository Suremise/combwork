import type { ProjectConfig, ProjectView } from './types'

/**
 * A project's view fields (HI-1749, Darren's decision on it): how this user left its Session tab, kept in Hive's own UI
 * state (AppConfig.ui.projectViews), never in project.json, which holds the project's config. A view switch then writes no
 * project file, so nothing holding project.json (another program, a slow write of Hive's own) can make it fail.
 */
export const VIEW_KEYS = ['sessionView', 'layout', 'placement'] as const satisfies readonly (keyof ProjectView)[]

const isViewKey = (k: string): boolean => (VIEW_KEYS as readonly string[]).includes(k)

/** The view fields an object has (those it has a value for). */
export function viewOf(o: Partial<ProjectConfig>): ProjectView {
  return Object.fromEntries(VIEW_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as ProjectView
}

/** An object without its view fields: what is written to project.json. */
export function withoutView<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !isViewKey(k))) as T
}

/** Whether a change has anything but view fields: only such a change writes project.json. */
export const changesConfig = (patch: object): boolean => Object.keys(patch).some((k) => !isViewKey(k))
