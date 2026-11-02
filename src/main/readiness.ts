import type { DeliveryNeed } from '../shared/deliveries'
import { tasksWillWake } from '../shared/providers'
import { agentRuntime } from '../shared/runtime'
import type { LiveSessionState } from '../shared/types'

/**
 * Whether an agent can take a line of Hive's now, as far as what it is doing goes (#649): the one place every way into an
 * agent asks it (deliveries, watches, the typed line's writer). It reads the turn ledger's facts (#648): the CLI running
 * (or, `stalled`, stopped by a refused sign-in), no turn running and none of unknown state (unknown is never idle), no
 * compaction, nobody asked, and, for new work (`free`, `stalled`), no background tasks that will start it again. A watch
 * is Hive's policy on top: `idle` takes a watching agent (a message or a wake; its watch carries on), `free` doesn't (it
 * takes no new work). Who holds the composer is the writer's to check (it holds it itself while it types). A state from
 * before the facts reads its status word, as before.
 *
 * #726: an agent whose turn has ended while its own background tasks run (a sleep or timer set to renew a merge slot,
 * shown as background) is `idle` for a message or a card event: HB6 slept 40 minutes that way and heard of neither
 * until it woke. Its CLI takes the line as a new turn (Claude Code; Codex and Copilot, whose tasks start no turn, were
 * already idle then). New work still waits for those tasks, which will start a turn of their own.
 */
export function readyFor(st: LiveSessionState | null | undefined, need: DeliveryNeed = 'idle'): boolean {
  if (!st) return false
  // Its hooks aren't arriving (#1336): Hive can't tell when it is free, nor confirm a line it types.
  if (st.hooksMissing) return false
  if (!st.runtime) return byStatus(st, need)
  const rt = agentRuntime(st)
  if (!(rt.lifecycle === 'running' || (need === 'stalled' && rt.lifecycle === 'signin'))) return false
  if (rt.turn === 'running' || rt.turn === 'unknown' || rt.maintenance || rt.attention || (need !== 'idle' && tasksWillWake(st))) return false
  return need === 'idle' || !st.watch
}

/** The status word's reading (states without the ledger's facts). */
function byStatus(st: LiveSessionState, need: DeliveryNeed): boolean {
  if (st.status === 'ready' || st.status === 'finished') return true
  if (st.status === 'watching' || st.status === 'background') return need === 'idle'
  return need === 'stalled' && st.status === 'signin'
}
