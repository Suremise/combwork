import { existsSync } from 'original-fs'
import { resolve } from 'path'
import type { RecentWorkspace } from '../shared/types'
import { config } from './config'
import { emit } from './events'
import { combworkWindows } from './windows'

/**
 * The recent workspaces (File → Open Recent, the welcome page; #144). The list itself is config.json's
 * recentWorkspaces (the 12 last opened, workspace.ts adds to it). Paths are compared without case, as Windows does.
 */

const key = (p: string): string => resolve(p).toLowerCase()

/** The workspaces open in a window now, by key. */
const openNow = (): Set<string> => new Set(combworkWindows().flatMap((e) => (e.ws.path ? [key(e.ws.path)] : [])))

/**
 * The list as a window showing `viewing` sees it: each entry with whether its folder is there (checked now; one that
 * isn't, say on an unplugged drive, stays listed, since it may come back) and whether another window has it open.
 */
export function recentFor(viewing: string | null | undefined): RecentWorkspace[] {
  const open = openNow()
  const mine = viewing ? key(viewing) : null
  return config.get().recentWorkspaces.map((path) => {
    const k = key(path)
    return { path, exists: existsSync(path), ...(open.has(k) && k !== mine ? { openElsewhere: true } : {}) }
  })
}

/** Tells every window the list changed: each asks again for its own view of it. */
export function recentChanged(): void {
  emit({ type: 'recent-changed' })
}

/** Forgets a workspace (its folder is left alone), whatever the case of the path given. */
export function removeRecent(path: string): void {
  const k = key(path)
  config.update((c) => {
    c.recentWorkspaces = c.recentWorkspaces.filter((p) => key(p) !== k)
  })
  recentChanged()
}

/** Clears the list, keeping the workspaces open in a window now (in their place). */
export function clearRecent(): void {
  const open = openNow()
  config.update((c) => {
    c.recentWorkspaces = c.recentWorkspaces.filter((p) => open.has(key(p)))
  })
  recentChanged()
}
