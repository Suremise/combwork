import { useEffect, useState, useSyncExternalStore } from 'react'
import type { WorkBadge, WorkView } from '@shared/workflow/workView'
import { useScopedLoad } from './scopedLoad'
import { useStore } from './store'

// A card's work (#1223) in the window: read from its facts in main (`tasks:work`, `tasks:workBadges`) and read again
// each time the board is (a tasks-changed event, which a fact written in the board's change also gives, observed ones
// too). A card's revisions are shown through its project's platform (`revisionShort`), never by its id.

/**
 * One card's work view; null while loading, with no such card, or on a board not upgraded to 1.0 (`loaded` tells the
 * first from the others). `retry` reads it again (after an error).
 */
export function useCardWork(n: number | null): { view: WorkView | null; error: string | null; loaded: boolean; retry: () => void } {
  const ws = useStore((s) => s.workspace?.path ?? '')
  const tasks = useStore((s) => s.tasks)
  const [again, setAgain] = useState(0)
  const scope = `${ws}\n${n ?? ''}`
  const { data, error, at, load } = useScopedLoad<WorkView | null>(scope)
  useEffect(() => {
    if (n !== null && ws) load(scope, () => window.hive.invoke('tasks:work', n))
  }, [scope, n, ws, tasks, load, again])
  return { view: data, error, loaded: at > 0, retry: () => setAgain((x) => x + 1) }
}

/**
 * Every live card's badges, by number; empty while loading. One source for the window, however many views show them
 * (#1629: each view read them for itself, four or five reads of every board change): read when the board, a project's
 * workflow or the projects change, one read at a time (a change during one reads once more after it). A badge that
 * didn't change keeps its object, and the map stays the same one when none did, so views showing them don't redraw.
 */
export function useWorkBadges(): Map<number, WorkBadge> {
  const ws = useStore((s) => s.workspace?.path ?? '')
  const tasks = useStore((s) => s.tasks)
  // A project's workflow written, or the projects read again (their version control recorded): its cards' old rules
  // marks may have changed (#1421).
  const workflow = useStore((s) => s.workflowVersion)
  const projects = useStore((s) => s.workspace?.projects)
  useEffect(() => {
    if (ws) badgeSource.ask(ws, [tasks, workflow, projects])
  }, [ws, tasks, workflow, projects])
  const shown = useSyncExternalStore(badgeSource.subscribe, badgeSource.get)
  return shown.ws === ws ? shown.badges : NO_BADGES
}

const NO_BADGES = new Map<number, WorkBadge>()

/** The window's work badges (useWorkBadges): the workspace they are of and the latest read. */
export const badgeSource = (() => {
  let shown: { ws: string; badges: Map<number, WorkBadge> } = { ws: '', badges: NO_BADGES }
  const listeners = new Set<() => void>()
  // What the last read was asked for (the same values from another view ask nothing more), and a read under way.
  let asked: { ws: string; why: readonly unknown[] } | null = null
  let reading: string | null = null
  let again = false
  const read = (ws: string): void => {
    reading = ws
    again = false
    void window.hive.invoke('tasks:workBadges').then(
      (list) => {
        if (reading !== ws) return
        if (asked?.ws === ws) take(ws, list)
        done(ws)
      },
      () => done(ws)
    )
  }
  const done = (ws: string): void => {
    if (reading !== ws) return
    reading = null
    if (again && asked?.ws === ws) read(ws)
  }
  const take = (ws: string, list: WorkBadge[]): void => {
    const before = shown.ws === ws ? shown.badges : NO_BADGES
    let same = before.size === list.length
    const next = new Map<number, WorkBadge>()
    for (const b of list) {
      const had = before.get(b.card)
      const keep = had && JSON.stringify(had) === JSON.stringify(b)
      if (!keep) same = false
      next.set(b.card, keep ? had : b)
    }
    if (same && shown.ws === ws) return
    shown = { ws, badges: next }
    for (const l of listeners) l()
  }
  return {
    ask(ws: string, why: readonly unknown[]): void {
      if (asked && asked.ws === ws && asked.why.length === why.length && asked.why.every((x, i) => x === why[i])) return
      asked = { ws, why }
      if (reading === ws) again = true
      else read(ws)
    },
    subscribe(l: () => void): () => void {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    get: () => shown
  }
})()
