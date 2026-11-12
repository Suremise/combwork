import { msg, tr } from '@shared/i18n'
import { attempt } from './actions'
import { call } from './api'
import { confirm } from './store'

/**
 * Remove from queue, after asking (the Progress panel's queued card, and a forward merge's Work section, HI-3084). An
 * ordinary card goes back to Approved and its builder is told; a forward merge (HI-2679) has no builder and ends in
 * Done, nothing merged: its confirmation says so, with its branches.
 */
export async function removeFromQueue(n: number, key: string, forward?: { from: string; to: string }): Promise<void> {
  const ok = await confirm({
    title: tr(msg({ id: 'board.queue.removeTitle', defaultMessage: 'Remove {card} from the merge queue?', description: "Title of the confirmation before Remove from queue ({card}: the card's key). Glossary 2.5: merge queue." }), { card: key }),
    message: forward
      ? tr(msg({ id: 'board.queue.removeForwardMessage', defaultMessage: "It ends in Done and nothing is merged: {to} isn't brought up to date with {from}. To try again later, use Bring Up to Date… on {to}'s queue.", description: "HI-3084: the confirmation before Remove from queue on a forward merge card (Combwork's own card bringing branch {to} up to date with branch {from}): it has no builder, so it ends in Done (a stage, glossary 2.2) with nothing merged. Bring Up to Date… is a button on the merge queue's card: as translated there." }), forward)
      : tr(msg({ id: 'board.queue.removeMessage', defaultMessage: "It goes back to Approved and isn't merged. Its builder is told. To merge it later, requeue it from the card.", description: 'The confirmation before Remove from queue (Progress panel). Approved is a stage (glossary 2.2).' })),
    confirmLabel: tr(msg({ id: 'board.queue.removeConfirm', defaultMessage: 'Remove from queue', description: 'The button confirming Remove from queue. Keep it short.' }))
  })
  if (!ok) return
  await attempt(tr(msg({ id: 'board.queue.removeFailed', defaultMessage: "Couldn't remove the card from the queue", description: "An error's title: Remove from queue failed (Progress panel); its message says why (its merge has begun, say)." })), () => call('queue:remove', n, ''))
}
