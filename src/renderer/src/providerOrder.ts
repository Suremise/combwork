// Settings → Providers' order, moved from the window (HI-1965, HR2's rounds 1 and 2). One owner per window for its moves:
// this module, alive as long as the window, whichever component shows the list. Main owns the order itself and applies
// each move to the order as it is then (config.moveProvider); this module sends one move at a time, the next only once
// the last has settled, so main takes them in the order they were made. The order shown is the store's settings, which
// only main's settings-changed writes (a reply is an acknowledgement); while moves are under way, or an acknowledged one
// hasn't shown up there yet, the list shows the order they make instead, and goes back to the store's once the store has
// caught up: its revision at or past the last acknowledged one (a newer order from elsewhere is shown as it is).
import { useSyncExternalStore } from 'react'
import { providerOrderWith } from '@shared/providers'
import { msg, tr } from '@shared/i18n'
import type { ProviderId } from '@shared/types'
import { call, errorMessage } from './api'
import { get, notify, useStore } from './store'

const FAILED = msg({ id: 'settings.provider.reorderFailed', defaultMessage: "Couldn't save the providers' order", description: "An error's title: saving the order of Settings → Providers' list failed." })

interface Move {
  id: ProviderId
  toIndex: number
}

/** The moves not settled yet, oldest first: the first is the one sent. */
let moves: Move[] = []
/** The newest acknowledgement: the order and revision a move made. Null once the store has caught up with it. */
let acked: { order: ProviderId[]; revision: number } | null = null
let sending = false
/** The order shown instead of the store's while moves are under way or the store is behind; null: the store's. */
let shown: ProviderId[] | null = null
const listeners = new Set<() => void>()

/** The store's order and revision, which only main's settings-changed (and the window's first read) set. */
function canonical(): { order: ProviderId[]; revision: number } {
  const s = get().settings
  return { order: s?.providerOrder ?? [], revision: s?.providerOrderRevision ?? 0 }
}

function recompute(): void {
  const c = canonical()
  const caughtUp = !acked || c.revision >= acked.revision
  if (caughtUp) acked = null
  let next: ProviderId[] | null = null
  if (moves.length || !caughtUp) {
    // From the newest the window knows (the store's, or an acknowledgement not in it yet), each move still under way on
    // top: a move names a place, so one already in the base changes nothing.
    next = moves.reduce((order, m) => providerOrderWith({ providerOrder: order }, m.id, m.toIndex), caughtUp ? c.order : acked!.order)
  }
  if (JSON.stringify(next) === JSON.stringify(shown)) return
  shown = next
  for (const l of listeners) l()
}

/** Sends the moves one at a time, each once the one before has settled; a failed one says so and the rest go on. */
async function pump(): Promise<void> {
  if (sending) return
  sending = true
  try {
    while (moves.length) {
      const m = moves[0]
      try {
        const r = await call('settings:moveProvider', m.id, m.toIndex)
        if (!acked || r.revision > acked.revision) acked = { order: r.providerOrder, revision: r.revision }
      } catch (e) {
        notify('error', tr(FAILED), errorMessage(e))
      }
      moves.shift()
      recompute()
    }
  } finally {
    sending = false
  }
}

/** Moves a provider to place `toIndex` of the list as shown: shown at once, saved in turn. */
export function moveProvider(id: ProviderId, toIndex: number): void {
  moves.push({ id, toIndex })
  recompute()
  void pump()
}

/** The order to show instead of the store's (moves under way, or acknowledged and not in the store yet); null: none. */
export function usePendingProviderOrder(): ProviderId[] | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => shown
  )
}

// The store's settings changed (main's settings-changed): it may have caught up with what was acknowledged.
useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings) recompute()
})

/** For tests: the order shown instead of the store's now (the hook's snapshot). */
export const pendingProviderOrderForTests = (): ProviderId[] | null => shown

/** For tests: how many moves aren't settled yet (sent or waiting). */
export const providerMovesForTests = (): number => moves.length

/** For tests: forgets every move and acknowledgement. */
export function resetProviderOrderForTests(): void {
  moves = []
  acked = null
  sending = false
  shown = null
}
