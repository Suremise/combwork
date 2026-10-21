import { useEffect, useMemo, useState } from 'react'
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

/** Every live card's badges, by number; empty while loading. */
export function useWorkBadges(): Map<number, WorkBadge> {
  const ws = useStore((s) => s.workspace?.path ?? '')
  const tasks = useStore((s) => s.tasks)
  const { data, load } = useScopedLoad<WorkBadge[]>(ws)
  useEffect(() => {
    if (ws) load(ws, () => window.hive.invoke('tasks:workBadges'))
  }, [ws, tasks, load])
  return useMemo(() => new Map((data ?? []).map((b) => [b.card, b])), [data])
}
