import { msg, tr } from '@shared/i18n'
import type { ArchiveResult } from '@shared/types'
import { call, errorMessage } from './api'
import { cardLabelOf, get, loadTasks, notify, pushToast } from './store'
import { resolveLocal } from './entryConditions'

/** "AM-3, AM-4, #5" (by key where they have one), or the first six and how many more. */
function numbers(ns: number[]): string {
  const shown = ns.slice(0, 6).map((n) => cardLabelOf(get(), n)).join(', ')
  return ns.length > 6 ? tr(msg({ id: 'board.batch.andMore', defaultMessage: '{cards} and {n, number} more', description: 'Cards that could not be brought back from an archive, cut short: the first six card numbers ({cards}: "#3, #4") and how many more ({n}).' }), { cards: shown, n: ns.length - 6 }) : shown
}

/**
 * Tells the user what an Archive All did (#351): Archived n cards with Undo, and the cards it left on the board after all
 * (an agent took one meanwhile, one moved), with why.
 */
export function reportArchived(r: ArchiveResult): void {
  const left = r.skipped.length
    ? tr(msg({ id: 'board.batch.leftOnBoard', defaultMessage: '{n, plural, one {One card was} other {# cards were}} left on the board: {why}.', description: "After Archive All, the cards it left on the board (an agent took one meanwhile, one moved): how many, then each card's number and why ({why}, separated by semicolons)." }), {
        n: r.skipped.length,
        why: `${r.skipped
          .slice(0, 4)
          .map((s) => `${cardLabelOf(get(), s.number)} ${s.why}`)
          .join('; ')}${r.skipped.length > 4 ? '; …' : ''}`
      })
    : undefined
  if (!r.batch) return notify('warning', tr(msg({ id: 'board.batch.nothingArchived', defaultMessage: 'Nothing was archived', description: "A notification's title: Archive All archived no card." })), left)
  pushToast({
    id: `archived-${r.batch.id}`,
    level: 'success',
    title: tr(msg({ id: 'board.batch.archived', defaultMessage: 'Archived {n, plural, one {# card} other {# cards}}', description: "A notification's title after Archive All: how many cards it archived. It has an Undo button." }), { n: r.archived.length }),
    message: left,
    // Its Undo names its workspace (HI-2320): pressed while this window shows another, it is refused. What it did is
    // its own result (unarchiveBatch), checked by main card by card; no live check meanwhile (the Assistant's scope).
    actions: [{ label: tr(msg({ id: 'board.batch.undo', defaultMessage: 'Undo', description: 'Button on the notification after Archive All: brings the archived cards back.' })), command: 'task.undoArchive', args: [r.batch.id, get().workspace?.path ?? ''] }],
    timestamp: new Date().toISOString(),
    timeoutMs: 10_000
  })
}

/**
 * Brings a batch back (Undo, "Unarchive this batch") and says how it went: cards that couldn't come back stay archived
 * with the batch, which is kept so another try brings them. Returns whether every card came back.
 */
export async function unarchiveBatch(id: string, workspacePath?: string): Promise<boolean> {
  // From its notice, for its own workspace only (HI-2320): another shown here now, nothing is done.
  if (workspacePath && workspacePath.toLowerCase() !== (get().workspace?.path ?? '').toLowerCase()) {
    resolveLocal(`archived-${id}`, tr(msg({ id: 'board.batch.otherWorkspace', defaultMessage: "This archive is another workspace's: undo it there, from its Archived view", description: "What the notification after Archive All says when its Undo is pressed while the window shows another workspace (HI-2320): nothing was brought back. Archived is the archive's view: use its translation." })))
    return false
  }
  try {
    const { restored, failed } = await call('tasks:unarchiveBatch', id)
    await loadTasks()
    if (failed.length) {
      notify(
        'error',
        restored.length
          ? tr(msg({ id: 'board.batch.someBack', defaultMessage: "Brought back {n, plural, one {# card} other {# cards}}; {failed} couldn't be", description: "A notification's title: unarchiving a batch brought back {n} cards but not the ones listed ({failed}: \"#3, #4\")." }), { n: restored.length, failed: numbers(failed) })
          : tr(msg({ id: 'board.batch.noneBack', defaultMessage: "Couldn't bring back {failed}", description: "A notification's title: unarchiving a batch brought back none of its cards ({failed}: \"#3, #4\")." }), { failed: numbers(failed) }),
        tr(msg({ id: 'board.batch.stayArchived', defaultMessage: "They stay archived with their batch: Unarchive this batch in Archived tries again (a card's file may be open in another program).", description: "The notification when cards could not be brought back from an archive. \"Unarchive this batch\" is a button and \"Archived\" the archive's view: use their translations." }))
      )
      return false
    }
    const done = tr(msg({ id: 'board.batch.broughtBack', defaultMessage: 'Brought back {n, plural, one {# card} other {# cards}}', description: "A notification's title: unarchiving a batch brought all its cards back to the board." }), { n: restored.length })
    // From its Archived n cards notice's Undo (HI-2320): that notice says so, in place of its button; else its own notice.
    const entry = `archived-${id}`
    if (get().notifications.some((t) => t.id === entry && !t.resolved)) resolveLocal(entry, done)
    else notify('success', done)
    return true
  } catch (e) {
    notify('error', tr(msg({ id: 'board.batch.backFailed', defaultMessage: 'Could not bring the batch back', description: "An error's title: unarchiving a batch of cards failed." })), errorMessage(e))
    return false
  }
}

/** Export Board to JSON…, as the board's ⋯ menu and the command palette call it. */
export const EXPORT_BOARD = msg({ id: 'board.export.command', defaultMessage: 'Export Board to JSON…', description: "A command (the board's ⋯ menu, the command palette): saves every card of the board as a JSON file, in a new folder inside one the user picks. The … says it asks first: keep it." })

/**
 * Exports the board to JSON files (#1017): a folder the user picks gets a new folder with a file for each card, as the
 * cards were kept before 0.9 (an older Hive reads them), and says where.
 */
export async function exportBoard(): Promise<void> {
  try {
    const r = await call('tasks:export')
    if (!r) return
    notify('success', tr(msg({ id: 'board.export.done', defaultMessage: 'Exported {n, plural, one {# card} other {# cards}}', description: "A notification after Export Board to JSON: how many cards were saved." }), { n: r.cards }), r.dir)
  } catch (e) {
    notify('error', tr(msg({ id: 'board.export.failed', defaultMessage: "The board couldn't be exported", description: "A notification: Export Board to JSON failed (why follows)." })), errorMessage(e))
  }
}
