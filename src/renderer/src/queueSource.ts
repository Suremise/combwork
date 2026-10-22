import { useEffect } from 'react'
import type { QueueView } from '@shared/workflow/queue'
import { call } from './api'
import { get, set, useStore } from './store'

/**
 * Where the window's merge queues come from (#1356): every project's `queue:list` (#1353's model), read when the
 * workspace or its projects change, again for a project when main says its queue changed (`queue-changed`), and for
 * all of them when the board changes (a card starting or finishing under Hive merges changes which queues show).
 */

const NO_QUEUES: QueueView[] = []
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Each project's latest read: an older one finishing later never replaces it. */
const reads = new Map<string, number>()
let seq = 0

async function loadProject(projectPath: string): Promise<void> {
  const ws = get().workspace?.path
  const key = projectPath.toLowerCase()
  const n = ++seq
  reads.set(key, n)
  const views = await call('queue:list', projectPath).catch(() => null)
  if (!views || reads.get(key) !== n || get().workspace?.path !== ws) return
  set((s) => ({ queues: [...s.queues.filter((q) => !same(q.projectPath, projectPath)), ...views] }))
}

/** Every project's queues, read again; a project no longer in the workspace loses its own. */
function loadAll(): void {
  const projects = get().workspace?.projects ?? []
  set((s) => ({ queues: s.queues.filter((q) => projects.some((p) => same(p.path, q.projectPath))) }))
  for (const p of projects) void loadProject(p.path)
}

const timers = new Map<string, number>()
function schedule(key: string, ms: number, fn: () => void): void {
  window.clearTimeout(timers.get(key))
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key)
      fn()
    }, ms)
  )
}

/** A project's queue changed (`queue-changed`): its queues read again, shortly (a burst of steps reads once). */
export function queueChangedEvent(projectPath: string): void {
  if (get().settings?.general.progressPanel === false) return
  schedule(projectPath.toLowerCase(), 150, () => void loadProject(projectPath))
}

/** The board changed (`tasks-changed`): which queues show may have (a card started or finished under Hive merges). */
export function queueBoardChanged(): void {
  if (get().settings?.general.progressPanel === false) return
  schedule('*', 1000, loadAll)
}

/** This window's merge queues, every project's, read when its workspace or its projects change (events keep them current). */
export function useQueues(): QueueView[] {
  const ws = useStore((s) => s.workspace?.path)
  const projects = useStore((s) => (s.workspace?.projects ?? []).map((p) => p.path).join('\n'))
  const on = useStore((s) => s.settings?.general.progressPanel !== false)
  useEffect(() => {
    if (ws && on) loadAll()
  }, [ws, projects, on])
  return useStore((s) => s.queues ?? NO_QUEUES)
}
