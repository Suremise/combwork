// HI-2944: a card's or lane's start found the folder its target is checked out in with uncommitted changes. The user
// is told in the project's own window, before the work is dispatched, with Commit, Set aside and Show changes (the
// window's helpers, which act on exactly the files named here). A warning only: nothing is refused or asked. Said once
// for the same folder and files within a minute (a lane's start and its first card's start), in a bounded record.
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { fmt, msg, tr } from '../shared/i18n'
import type { TargetChanges, ToastAction } from '../shared/types'
import type { WorkspaceService } from './workspace'

const T = {
  title: msg({ id: 'service.targetChanges.title', defaultMessage: "Uncommitted changes where {target} is checked out", description: "HI-2944: a warning's title when a card or lane starts: the folder the branch {target} is checked out in (where the merge queue merges into it) has uncommitted changes." }),
  message: msg({ id: 'service.targetChanges.message', defaultMessage: '{folder} has {count, plural, one {an uncommitted change} other {# uncommitted changes}}: {files}. A merge into {target} that changes them pauses until they are committed or set aside.', description: "HI-2944: the warning's text. {folder} is the folder's name; {files} lists up to five paths (then how many more); {target} the branch. Work starts anyway." }),
  more: msg({ id: 'service.targetChanges.more', defaultMessage: '{files} and {more, plural, one {# more} other {# more}}', description: 'HI-2944: a list of paths cut at five ({files}), and how many more there are.' }),
  commit: msg({ id: 'service.targetChanges.commit', defaultMessage: 'Commit', description: "HI-2944: a button of the warning: commits exactly the files it names, in that folder." }),
  setAside: msg({ id: 'service.targetChanges.setAside', defaultMessage: 'Set Aside', description: "HI-2944: a button of the warning: sets the files it names aside (a git stash Combwork names), so the merge can go on." }),
  show: msg({ id: 'service.targetChanges.show', defaultMessage: 'Show Changes', description: "HI-2944: a button of the warning: opens the Version Control tab's changes." })
}

/** How long the same folder and files aren't said again, and how many are remembered. */
const QUIET_MS = 60_000
const KEEP = 64
const said = new Map<string, number>()

/** Paths as the warning names them: five at most, then how many more. */
const named = (files: readonly string[]): string => (files.length <= 5 ? fmt.list(files) : tr(T.more, { files: fmt.list(files.slice(0, 5)), more: files.length - 5 }))

/** Whether this folder and these files were said within the last minute; noted now if not. */
function sayNow(key: string, now = Date.now()): boolean {
  for (const [k, at] of said) if (now - at >= QUIET_MS) said.delete(k)
  if (said.has(key)) return false
  said.set(key, now)
  while (said.size > KEEP) said.delete(said.keys().next().value!)
  return true
}

/** Tells the project's window that `changes` stand where its target is checked out (once a minute for the same). */
export function noticeTargetChanges(ws: WorkspaceService, projectPath: string, changes: TargetChanges): void {
  const files = [...changes.files].sort()
  if (!sayNow(`${projectPath.toLowerCase()}|${changes.folder.toLowerCase()}|${files.join('\0')}`)) return
  // Exactly the files found: the window's Commit and Set aside act on them, all of them, whatever the text shows.
  const args = (action: string): unknown[] => [projectPath, changes.target, action, files, changes.folder]
  const actions: ToastAction[] = [
    { label: tr(T.commit), command: 'folderChanges.settle', args: args('commit') },
    { label: tr(T.setAside), command: 'folderChanges.settle', args: args('setAside') },
    { label: tr(T.show), command: 'folderChanges.show', args: [projectPath] }
  ]
  const message = tr(T.message, { folder: basename(changes.folder), count: files.length, files: named(files), target: changes.target })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'warning', title: tr(T.title, { target: changes.target }), message, actions, timestamp: new Date().toISOString(), target: { kind: 'project', projectPath, project: basename(projectPath) } } })
}

/** For tests. */
export function resetTargetChangesNotice(): void {
  said.clear()
}
