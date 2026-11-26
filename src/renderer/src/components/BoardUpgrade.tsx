import { useEffect } from 'react'
import { msg, tr } from '@shared/i18n'
import type { BoardState } from '@shared/types'
import { BOARD_UPGRADE_GUIDE } from '@shared/userGuide'
import { call, errorMessage } from '../api'
import { confirm, get, loadTasks, notify, set, useStore } from '../store'
import { openGuideAt } from '../tips'
import { Icon } from './ui'

const M = {
  askTitle: msg({ id: 'board.upgrade.askTitle', defaultMessage: "Upgrade this workspace's board to 1.0?", description: "Title of the dialog Combwork shows on opening a workspace whose task board was saved by version 0.9: 1.0 keeps the board in a new format, and asks before converting it." }),
  askMessage: msg({ id: 'board.upgrade.askMessage', defaultMessage: "Combwork 1.0 needs to upgrade this workspace's data. There's no going back: version 0.9 can then no longer open it, and your agents' worktrees become slots. Back up first.", description: "The upgrade dialog's text: why (1.0 keeps the workspace's data in a new format), then what follows, for good: version 0.9 can't open the workspace any more, and the agents' own worktrees become slots (working folders Combwork lends to cards), which 0.9 can't use again, so the user should back up first." }),
  askDetail: msg({ id: 'board.upgrade.askDetail', defaultMessage: "Close every other Combwork that has this workspace open first. Until it is upgraded, its board is read-only here and its agents can't start.", description: "Under the upgrade dialog's text: the upgrade is refused while another copy of Combwork has the workspace open; declining leaves the board readable but not changeable in this Combwork, and no agent (nor the Assistant) can start." }),
  upgrade: msg({ id: 'board.upgrade.upgrade', defaultMessage: 'Upgrade', description: "The upgrade dialog's button: converts the board to 1.0's format." }),
  upgrading: msg({ id: 'board.upgrade.upgrading', defaultMessage: 'Upgrading…', description: 'The Upgrade button while the board is converted.' }),
  notNow: msg({ id: 'board.upgrade.notNow', defaultMessage: 'Not Now', description: "The upgrade dialog's other button: leaves the board as it is, read-only in this Combwork, with a banner offering the upgrade." }),
  done: msg({ id: 'board.upgrade.done', defaultMessage: 'Board upgraded to 1.0', description: "A notification after the workspace's board was converted to 1.0's format." }),
  doneDetail: msg({ id: 'board.upgrade.doneDetail', defaultMessage: 'Version 0.9 can no longer open this workspace.', description: 'Under "Board upgraded to 1.0": the upgrade is one-way, so the older version 0.9 of Combwork can no longer open the workspace.' }),
  banner: msg({ id: 'board.upgrade.banner', defaultMessage: "This workspace is from version 0.9: until it is upgraded to 1.0, its board is read-only here and its agents can't start.", description: "A banner at the top of the window while the workspace's upgrade to 1.0's format waits (the user said Not Now): cards can be read but not changed, and no agent (nor the Assistant) can start, as Combwork couldn't record its session. Also the tooltip of what is disabled meanwhile: the board's add-card buttons, dragging cards, the card dialog's changes, and New Session and Resume." }),
  bannerButton: msg({ id: 'board.upgrade.bannerButton', defaultMessage: 'Upgrade…', description: 'A button on the banner above a read-only 0.9 board: asks to upgrade it to 1.0. The … says it asks first: keep it.' }),
  learnMore: msg({ id: 'board.upgrade.learnMore', defaultMessage: 'Learn more', description: "A button on the banner above a read-only 0.9 board: opens the user guide's section about upgrading to 1.0." }),
  newer: msg({ id: 'board.readOnly.newer', defaultMessage: 'This board was saved by a newer version of Combwork: it is read-only here.', description: "Tooltip on what changes cards (the board's add-card buttons, the card dialog's Save, comments and decisions), disabled while the board was saved by a newer Combwork (whose format this one can't change); also a banner in the card dialog." })
}

/** Asks to upgrade the board (the dialog runs it, and a refusal, such as another Combwork having it open, stays in it). */
export async function askBoardUpgrade(): Promise<void> {
  const ok = await confirm({
    title: tr(M.askTitle),
    message: tr(M.askMessage),
    detail: tr(M.askDetail),
    confirmLabel: tr(M.upgrade),
    cancelLabel: tr(M.notNow),
    busyLabel: tr(M.upgrading),
    run: async () => {
      // Shown at once as the workspace's opening step (HI-1694): main is busy with it until it is done, so its own word of
      // the step would come only after; the steps after it, and the end, come from main.
      const path = get().workspace?.path
      if (path) set({ openProgress: { path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, step: 'upgrade' } })
      await call('board:upgrade')
      await loadTasks()
    }
  })
  if (ok) notify('success', tr(M.done), tr(M.doneDetail))
}

/** Why the board takes no changes (its add-card buttons' tooltip), or null when it does. */
export function readOnlyReason(readOnly: BoardState['readOnly'] | undefined): string | null {
  return readOnly === 'upgrade' ? tr(M.banner) : readOnly === 'newer' ? tr(M.newer) : null
}

/**
 * Why no agent can start here (#1230): the workspace's upgrade to 1.0 waits, and Combwork refuses a start then
 * (`board.error.upgradeFirstStart`), so New Session and Resume are disabled with this as their tooltip. Else null.
 */
export function startBlockedReason(readOnly: BoardState['readOnly'] | undefined): string | null {
  return readOnly === 'upgrade' ? tr(M.banner) : null
}

/** startBlockedReason() for this window's workspace, drawn again as it changes. */
export function useStartBlocked(): string | null {
  return startBlockedReason(useStore((s) => s.boardState?.readOnly))
}

/** The workspaces this window has asked about already: Not Now holds until Combwork starts again (the banner stays). */
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
      <button className="btn small subtle" onClick={() => openGuideAt(BOARD_UPGRADE_GUIDE)}>
        {tr(M.learnMore)}
      </button>
    </div>
  )
}
