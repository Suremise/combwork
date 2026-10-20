import { useEffect } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import type { BoardState } from '@shared/types'
import { call, errorMessage } from '../api'
import { confirm, get, loadTasks, notify, useStore } from '../store'
import { openGuideAt } from '../tips'
import { Icon } from './ui'

/** The user guide's section about the upgrade (Learn more). */
const GUIDE = 'Upgrading to 1.0' // i18n-ignore: a user guide heading, the link's target

const M = {
  askTitle: msg({ id: 'board.upgrade.askTitle', defaultMessage: "Upgrade this workspace's board to 1.0?", description: "Title of the dialog Hive shows on opening a workspace whose task board was saved by Hive 0.9: Hive 1.0 keeps the board in a new format, and asks before converting it." }),
  askMessage: msg({ id: 'board.upgrade.askMessage', defaultMessage: "Hive 1.0 needs to upgrade this workspace's data. A 0.9 Hive can then no longer open it; a backup is kept, and Help → Restore the 0.9 Board Backup… puts it back.", description: "The upgrade dialog's text: why (Hive 1.0 keeps the workspace's data in a new format), then what follows: an older Hive (0.9) can't open the board any more, and a copy of the board as it was is kept. Help → Restore the 0.9 Board Backup… is a command in the Help menu: keep its name as Hive shows it." }),
  askDetail: msg({ id: 'board.upgrade.askDetail', defaultMessage: "Close every other Hive that has this workspace open first. Until it is upgraded, its board is read-only here and its agents can't start.", description: "Under the upgrade dialog's text: the upgrade is refused while another copy of Hive has the workspace open; declining leaves the board readable but not changeable in this Hive, and no agent (nor the Assistant) can start." }),
  upgrade: msg({ id: 'board.upgrade.upgrade', defaultMessage: 'Upgrade', description: "The upgrade dialog's button: converts the board to Hive 1.0's format." }),
  upgrading: msg({ id: 'board.upgrade.upgrading', defaultMessage: 'Upgrading…', description: 'The Upgrade button while the board is converted.' }),
  notNow: msg({ id: 'board.upgrade.notNow', defaultMessage: 'Not Now', description: "The upgrade dialog's other button: leaves the board as it is, read-only in this Hive, with a banner offering the upgrade." }),
  done: msg({ id: 'board.upgrade.done', defaultMessage: 'Board upgraded to 1.0', description: "A notification after the workspace's board was converted to Hive 1.0's format." }),
  doneDetail: msg({ id: 'board.upgrade.doneDetail', defaultMessage: 'The 0.9 board is kept: Help → Restore the 0.9 Board Backup… puts it back.', description: 'Under "Board upgraded to 1.0". Help → Restore the 0.9 Board Backup… is a command in the Help menu: keep its name as Hive shows it.' }),
  banner: msg({ id: 'board.upgrade.banner', defaultMessage: "This workspace is from Hive 0.9: until it is upgraded to 1.0, its board is read-only here and its agents can't start.", description: "A banner at the top of the window while the workspace's upgrade to Hive 1.0's format waits (the user said Not Now): cards can be read but not changed, and no agent (nor the Assistant) can start, as Hive couldn't record its session. Also the tooltip of the board's disabled add-card buttons." }),
  bannerButton: msg({ id: 'board.upgrade.bannerButton', defaultMessage: 'Upgrade…', description: 'A button on the banner above a read-only 0.9 board: asks to upgrade it to 1.0. The … says it asks first: keep it.' }),
  learnMore: msg({ id: 'board.upgrade.learnMore', defaultMessage: 'Learn more', description: "A button on the banner above a read-only 0.9 board: opens the user guide's section about upgrading to 1.0." }),
  restoreTitle: msg({ id: 'board.restore09.title', defaultMessage: 'Restore the 0.9 board backup?', description: "Title of the confirmation before Help → Restore the 0.9 Board Backup… puts back the copy of the board Hive kept when it upgraded it to 1.0." }),
  restoreMessage: msg({
    id: 'board.restore09.message',
    defaultMessage: "Hive keeps a copy of the board as it is now, then puts back the copy made before its upgrade to 1.0 ({when}). Changes made since are only in the kept copy. The board is then read-only here: quit this Hive and open the workspace in Hive 0.9 to carry on.",
    description: 'The confirmation before restoring the 0.9 board backup. {when} is when the backup was made (a date and time).'
  }),
  restore: msg({ id: 'board.restore09.restore', defaultMessage: 'Restore', description: 'The button of the confirmation: puts the 0.9 board backup back.' }),
  restoring: msg({ id: 'board.restore09.restoring', defaultMessage: 'Restoring…', description: 'The Restore button while the 0.9 board backup is put back.' }),
  restored: msg({ id: 'board.restore09.done', defaultMessage: 'The 0.9 board is back', description: 'A notification after the 0.9 board backup was put back.' }),
  restoredDetail: msg({ id: 'board.restore09.doneDetail', defaultMessage: 'The 1.0 board is kept as {file}.', description: 'Under "The 0.9 board is back": {file} is the file the board as it was before the restore was saved to.' }),
  newer: msg({ id: 'board.readOnly.newer', defaultMessage: 'This board was saved by a newer version of Hive: it is read-only here.', description: "Tooltip on the board's add-card buttons, disabled while the board was saved by a newer Hive (whose format this one can't change)." }),
  none: msg({ id: 'board.restore09.none', defaultMessage: 'There is no 0.9 board backup to restore', description: 'A notification from Help → Restore the 0.9 Board Backup… when the workspace has no copy of its board from before an upgrade to 1.0.' })
}

/** Asks to upgrade the board (the dialog runs it, and a refusal, such as another Hive having it open, stays in it). */
export async function askBoardUpgrade(): Promise<void> {
  const ok = await confirm({
    title: tr(M.askTitle),
    message: tr(M.askMessage),
    detail: tr(M.askDetail),
    confirmLabel: tr(M.upgrade),
    cancelLabel: tr(M.notNow),
    busyLabel: tr(M.upgrading),
    run: async () => {
      await call('board:upgrade')
      await loadTasks()
    }
  })
  if (ok) notify('success', tr(M.done), tr(M.doneDetail))
}

/** Help → Restore the 0.9 Board Backup…: confirmed first, saying what happens to the board as it is now. */
export async function restoreBoard09(): Promise<void> {
  const at = get().boardState?.backup09?.at
  if (!at) return notify('info', tr(M.none))
  let saved = ''
  const ok = await confirm({
    title: tr(M.restoreTitle),
    message: tr(M.restoreMessage, { when: fmt.dateTime(new Date(at)) }),
    confirmLabel: tr(M.restore),
    busyLabel: tr(M.restoring),
    danger: true,
    run: async () => {
      saved = (await call('board:restore09')).saved
      await loadTasks()
    }
  })
  if (ok) notify('success', tr(M.restored), tr(M.restoredDetail, { file: saved }))
}

/** Why the board takes no changes (its add-card buttons' tooltip), or null when it does. */
export function readOnlyReason(readOnly: BoardState['readOnly'] | undefined): string | null {
  return readOnly === 'upgrade' ? tr(M.banner) : readOnly === 'newer' ? tr(M.newer) : null
}

/** The workspaces this window has asked about already: Not Now holds until Hive starts again (the banner stays). */
const asked = new Set<string>()

/** Asks once per workspace, as soon as its board says it waits for the upgrade. */
export function BoardUpgradeAsk() {
  const waiting = useStore((s) => s.boardState?.readOnly === 'upgrade')
  const path = useStore((s) => s.workspace?.path)
  useEffect(() => {
    if (!waiting || !path || asked.has(path.toLowerCase())) return
    asked.add(path.toLowerCase())
    void askBoardUpgrade()
  }, [waiting, path])
  return null
}

/** Above the board while its upgrade waits: why it is read-only, and the upgrade. */
export function BoardUpgradeBanner() {
  const waiting = useStore((s) => s.boardState?.readOnly === 'upgrade')
  if (!waiting) return null
  return (
    <div className="banner warn board-upgrade" role="status">
      <Icon name="warning" />
      <span className="grow">{tr(M.banner)}</span>
      <button className="btn small primary" onClick={() => void askBoardUpgrade().catch((e) => notify('error', errorMessage(e)))}>
        {tr(M.bannerButton)}
      </button>
      <button className="btn small subtle" onClick={() => openGuideAt(GUIDE)}>
        {tr(M.learnMore)}
      </button>
    </div>
  )
}
