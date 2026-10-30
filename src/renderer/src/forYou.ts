import { useEffect, useMemo } from 'react'
import type { ForYouItem, ForYouSummary } from '@shared/workflow/workView'
import { keepSame } from '@shared/keepSame'
import { useScopedLoad } from './scopedLoad'
import { sharedRead } from './sharedRead'
import { useStore } from './store'

// What waits for the user (For you, #1276, SPEC §16.8.5): every live card's open requests, read from main
// (`tasks:forYou`, #1269) and read again each time the board is (a tasks-changed event: a request or an answer is a board
// change), so an answered request leaves at once.

const NONE: ForYouSummary = { items: [], count: 0 }

/**
 * The read for a workspace and board read, shared by every view showing For you (HI-1754). What is the same as the last
 * read stays the same objects (HI-1806): a card's chip renders again only when its own requests change.
 */
let lastRead: ForYouSummary = NONE
const readForYou = sharedRead<ForYouSummary>(() => window.hive.invoke('tasks:forYou').then((s) => (lastRead = keepSame(lastRead, s))))

/**
 * For you as a view last accepted it, with its workspace (HI-2080, HR1's round 1): only a read its scoped load took (one
 * that finished after a newer one started, or for another workspace, is dropped there), never `lastRead`, which every
 * reply writes. The status bar's count (Shell) always shows For you, so the current workspace's is kept up to date.
 */
let accepted: { ws: string; items: readonly ForYouItem[] } | null = null

/**
 * Whether a card has an open request for the user that this agent asked, as For you was last accepted for the workspace
 * open now (HI-2080): the stall check's, which isn't a hook. None known for it (another workspace's, or not read yet): no.
 */
export const askedByNow = (card: number, agentId: string): boolean => {
  const ws = useStore.getState().workspace?.path ?? ''
  const now = accepted
  return !!ws && now?.ws === ws && now.items.some((i) => i.card === card && i.asker === agentId)
}

/** The workspace's requests for the user, and by card; empty while loading. */
export function useForYou(): { summary: ForYouSummary; byCard: Map<number, ForYouItem[]> } {
  const ws = useStore((s) => s.workspace?.path ?? '')
  // Each read of the board: a request or an answer may write only facts, leaving the cards as they were (HI-1859).
  const reads = useStore((s) => s.boardReads)
  const { data, load } = useScopedLoad<ForYouSummary>(ws)
  useEffect(() => {
    if (ws) load(ws, () => readForYou(ws, reads))
  }, [ws, reads, load])
  const summary = data ?? NONE
  // The current scope's read, as accepted (useScopedLoad gives no other): what askedByNow reads.
  if (ws && data) accepted = { ws, items: data.items }
  const byCard = useMemo(() => {
    const m = new Map<number, ForYouItem[]>()
    for (const i of summary.items) m.set(i.card, [...(m.get(i.card) ?? []), i])
    return m
  }, [summary])
  return { summary, byCard }
}
