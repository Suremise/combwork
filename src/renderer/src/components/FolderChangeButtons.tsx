// HI-2944: Commit and Set Aside on a merge paused on uncommitted (or staged) changes in the folder its target is checked
// out in: the same buttons on the Merges tab's and Version Control's queue card and in the card's Work section. They act
// on exactly the paused files, only while that pause is still the current one; the merge goes on once it can.
import { useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import type { QueuePauseInfo } from '@shared/workflow/queue'
import { folderChangesOffered, pauseRefOf, settleFolderChanges } from '../folderChanges'
import { Icon } from './ui'

const T = {
  commit: msg({ id: 'board.queue.pause.commit', defaultMessage: 'Commit', description: "HI-2944: a button on a merge paused on uncommitted changes (the Merges tab, Version Control → Merge queue, a card's Work section): commits exactly the files named, in the folder the branch is checked out in, then the merge goes on." }),
  commitTip: msg({ id: 'board.queue.pause.commitTip', defaultMessage: 'Commit {files} as they are now, on {target}, and let the merge go on.', description: 'HI-2944: tooltip of Commit on a paused merge. {files} lists every file it commits (all of them, though the pause text names five at most); {target} is the branch.' }),
  setAside: msg({ id: 'board.queue.pause.setAside', defaultMessage: 'Set Aside', description: 'HI-2944: a button on a merge paused on uncommitted changes: sets the files named aside (a git stash Combwork names), then the merge goes on.' }),
  setAsideTip: msg({ id: 'board.queue.pause.setAsideTip', defaultMessage: 'Keep the changes to {files} in a git stash (git stash pop brings them back) and let the merge go on.', description: 'HI-2944: tooltip of Set Aside on a paused merge. {files} lists every file it sets aside. Keep git stash pop as it is: a command.' })
}

export function FolderChangeButtons({ projectPath, target, paused }: { projectPath: string; target: string; paused: QueuePauseInfo }) {
  const [busy, setBusy] = useState(false)
  const ref = pauseRefOf(paused)
  if (!ref || !folderChangesOffered()) return null
  const act = async (action: 'commit' | 'setAside'): Promise<void> => {
    setBusy(true)
    try {
      await settleFolderChanges(projectPath, target, action, paused.files, ref)
    } finally {
      setBusy(false)
    }
  }
  // Every file they act on, named (the pause's text names five at most).
  const files = fmt.list(paused.files)
  return (
    <span className="folder-change-buttons">
      <button type="button" className="btn small" disabled={busy} data-action="commit-changes" title={tr(T.commitTip, { target, files })} onClick={() => void act('commit')}>
        <Icon name="git-commit" /> {tr(T.commit)}
      </button>
      <button type="button" className="btn small subtle" disabled={busy} data-action="set-aside-changes" title={tr(T.setAsideTip, { files })} onClick={() => void act('setAside')}>
        <Icon name="archive" /> {tr(T.setAside)}
      </button>
    </span>
  )
}
