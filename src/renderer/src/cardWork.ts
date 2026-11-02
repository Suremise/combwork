import { useEffect, useState, useSyncExternalStore } from 'react'
import type { WorkBadge, WorkView } from '@shared/workflow/workView'
import { makeBadgeSource, NO_BADGES } from '@shared/workflow/badgeSource'
import { useScopedLoad } from './scopedLoad'
import { useStore } from './store'
import { useShallow } from 'zustand/react/shallow'

// A card's work (#1223) in the window: read from its facts in main (`tasks:work`, `tasks:workBadges`) and read again
// each time the board is (a tasks-changed event, which a fact written in the board's change also gives, observed ones
// too). A card's revisions are shown through its project's platform (`revisionShort`), never by its id.

/**
 * One card's work view; null while loading, with no such card, or on a board not upgraded to 1.0 (`loaded` tells the
 * first from the others). `retry` reads it again (after an error).
 */
export function useCardWork(n: number | null): { view: WorkView | null; error: string | null; loaded: boolean; retry: () => void } {
  const ws = useStore((s) => s.workspace?.path ?? '')
  // Each read of the board, its cards changed or only their facts (HI-1859).
  const reads = useStore((s) => s.boardReads)
  const [again, setAgain] = useState(0)
  const scope = `${ws}\n${n ?? ''}`
  const { data, error, at, load } = useScopedLoad<WorkView | null>(scope)
  useEffect(() => {
    if (n !== null && ws) load(scope, () => window.hive.invoke('tasks:work', n))
  }, [scope, n, ws, reads, load, again])
  return { view: data, error, loaded: at > 0, retry: () => setAgain((x) => x + 1) }
}

/**
 * Every live card's badges, by number; empty while loading. One source for the window however many views show them
 * (makeBadgeSource, #1629), read again when the board, a project's workflow or the projects change.
 */
export function useWorkBadges(): Map<number, WorkBadge> {
  const ws = useStore((s) => s.workspace?.path ?? '')
  // Each read of the board, its cards changed or only their facts (a refusal, HI-1859).
  const reads = useStore((s) => s.boardReads)
  // A project's workflow written, or the projects read again (their version control recorded): its cards' old rules
  // marks may have changed (#1421). The projects as read, not their agents' states (HI-1806): an agent's turn asked them
  // all again. The store keeps each part that didn't change the same object (keepSame).
  const workflow = useStore((s) => s.workflowVersion)
  const projects = useStore(useShallow((s) => (s.workspace?.projects ?? []).flatMap((p) => [p.path, p.config, p.platform, p.isGitRepo, p.branch])))
  useEffect(() => {
    if (ws) badgeSource.ask(ws, [reads, workflow, ...projects])
  }, [ws, reads, workflow, projects])
  const shown = useSyncExternalStore(badgeSource.subscribe, badgeSource.get)
  return shown.ws === ws ? shown.badges : NO_BADGES
}

/** The window's work badges (useWorkBadges). */
export const badgeSource = makeBadgeSource(() => window.hive.invoke('tasks:workBadges'))
