import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import type { WorkView } from '@shared/workflow/workView'
import { isJjViewUnknown, jjRevisionInput, type JjBookmarksView, type JjCompareView, type JjConflictsView, type JjHistoryView, type JjOpChange, type JjOperationPreview, type JjOperationRow, type JjOperationsView, type JjOpOverlap, type JjOpRefusal, type JjRepoView, type JjResolved, type JjRow, type JjView, type JjViewUnknown } from '@shared/jjViews'
import { revisionShort, PLATFORMS } from '@shared/platform/descriptors'
import { GATE_TEXT } from '@shared/platform/gateTexts'
import { msg, tr, type Msg } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { cardLabelOf, notify, useLanguage, useStore } from '../store'
import { timeAgo } from '../util'
import { Icon, Tooltip } from '../components/ui'

/**
 * A jj project's sections of the Version Control tab (HI-2799, J6; SPEC §16.3.6): Repository, History, Compare,
 * Bookmarks and Conflicts. Read-only (R5.2: a bookmark is never shown as a Git branch, nothing here changes the
 * repository): every read is main's, pinned at jj's single operation head, and an unknown says why, never shown as
 * clean or empty. A change id and a commit id are shown side by side and never stand in for each other.
 */

const M = {
  refresh: msg({ id: 'jj.refresh', defaultMessage: 'Refresh', description: 'A button in a jj section of the Version Control tab (HI-2799): reads it again.' }),
  reading: msg({ id: 'jj.reading', defaultMessage: 'Reading…', description: 'While a jj section of the Version Control tab is read (HI-2799).' }),
  readFailed: msg({ id: 'jj.readFailed', defaultMessage: 'Couldn’t read it: {error}', description: 'A jj section couldn’t be read (HI-2799). {error} says why.' }),
  // Unknowns, by code.
  heads: msg({ id: 'jj.unknown.heads', defaultMessage: 'jj’s operation log has {detail} heads: Combwork reads nothing until jj reconciles them (any jj command in a terminal does).', description: 'A jj section can’t be read (HI-2799): jj’s operation log diverged (or can’t be read). {detail} is how many heads, or “unreadable”. Keep jj.' }),
  tool: msg({ id: 'jj.unknown.tool', defaultMessage: 'jj isn’t installed, or isn’t the version Combwork is tested with, so nothing is read through it.', description: 'A jj section can’t be read (HI-2799): the jj tool. Keep jj.' }),
  moved: msg({ id: 'jj.unknown.moved', defaultMessage: 'The repository changed while it was read: refresh to read it again.', description: 'A jj section can’t be read (HI-2799): jj recorded an operation while Combwork read.' }),
  noRepo: msg({ id: 'jj.unknown.noRepo', defaultMessage: 'No jj repository was found here.', description: 'A jj section can’t be read (HI-2799): the project folder has no jj repository (any more). Keep jj.' }),
  other: msg({ id: 'jj.unknown.other', defaultMessage: 'jj couldn’t answer ({code}).', description: 'A jj section can’t be read (HI-2799). {code} is a short code for why, kept in English, with jj’s own words after it. Keep jj.' }),
  // Repository.
  root: msg({ id: 'jj.repo.root', defaultMessage: 'Repository at {root}', description: 'The jj Repository section (HI-2799): the repository’s folder.' }),
  colocated: msg({ id: 'jj.repo.colocated', defaultMessage: '{colocated, select, yes {Colocated with Git: Git sees the same history.} other {Not colocated with Git.}}', description: 'The jj Repository section (HI-2799): whether a .git is beside .jj. Keep Git.' }),
  version: msg({ id: 'jj.repo.version', defaultMessage: 'jj {version}', description: 'The jj Repository section (HI-2799): the jj version Combwork uses. Keep jj.' }),
  op: msg({ id: 'jj.repo.op', defaultMessage: 'Operation {op}', description: 'The jj Repository section (HI-2799): jj’s current operation (its id, short), which every view is read at.' }),
  workspaces: msg({ id: 'jj.repo.workspaces', defaultMessage: 'Workspaces', description: 'A heading of the jj Repository section (HI-2799): jj’s workspaces (working folders) of this repository, Combwork’s slots among them.' }),
  workspace: msg({ id: 'jj.repo.workspace', defaultMessage: '{name}: change {change}, commit {commit}', description: 'A jj workspace in the Repository section (HI-2799): its name and its working copy’s change id and commit id (short).' }),
  here: msg({ id: 'jj.repo.here', defaultMessage: 'project folder', description: 'A badge on the jj workspace that is the project folder itself (HI-2800). Lower case.' }),
  stale: msg({ id: 'jj.repo.stale', defaultMessage: 'stale', description: 'A badge on a jj workspace whose files are behind its working-copy commit (HI-2800). Lower case.' }),
  staleTip: msg({ id: 'jj.repo.staleTip', defaultMessage: 'Its files are behind its working-copy commit: another workspace rewrote it. jj workspace update-stale updates them, but edits jj hasn’t recorded can end up in a separate commit: look before you run it. Combwork doesn’t run it.', description: 'Tooltip of the stale badge on a jj workspace (HI-2800). Keep jj workspace update-stale (a command).' }),
  unsupported: msg({ id: 'jj.repo.unsupported', defaultMessage: 'Not supported with jj in Combwork', description: 'A heading of the jj Repository section (HI-2799): what Combwork doesn’t do or support with jj. Keep jj.' }),
  edits: msg({ id: 'jj.repo.edits', defaultMessage: 'jj has no uncommitted changes: edits are recorded in the working-copy commit when jj snapshots them.', description: 'A note in the jj Repository section (HI-2799), in place of Git’s Changes. Keep jj.' }),
  integrate: msg({ id: 'jj.integrate.head', defaultMessage: 'Waiting for you to integrate', description: 'A heading of the jj Repository section (HI-2799, option A): cards that passed review, which the user brings into their target themselves.' }),
  integrateNone: msg({ id: 'jj.integrate.none', defaultMessage: 'No card is waiting.', description: 'Under “Waiting for you to integrate” (HI-2799) when no card has passed.' }),
  integrateCard: msg({ id: 'jj.integrate.card', defaultMessage: '{card} {title}: commit {commit} into {target}', description: 'A passed card in jj’s “Waiting for you to integrate” (HI-2799). {commit} is its reviewed commit (short), {target} the bookmark it goes into.' }),
  integrateHow: msg({ id: 'jj.integrate.how', defaultMessage: 'For example, then move {target} to the rebased commit with jj bookmark set:', description: 'Above a jj command suggested to integrate a passed card (HI-2799): rebase it onto its target, then move the target bookmark. Keep jj bookmark set (a command).' }),
  contained: msg({ id: 'jj.integrate.contained', defaultMessage: 'In {target}: can’t check yet.', description: 'Under a passed jj card (HI-2799): whether its reviewed work is in its target. Combwork can’t check it yet (a later version records it); never read as not integrated.' }),
  noMerge: msg({ id: 'jj.integrate.noMerge', defaultMessage: 'Combwork doesn’t merge under jj: integrate the reviewed work with jj yourself.', description: 'A note under jj’s “Waiting for you to integrate” (HI-2799, Darren’s decision A). Keep jj.' }),
  // History.
  change: msg({ id: 'jj.row.change', defaultMessage: 'Change', description: 'A column of jj’s History (HI-2799): the change id (stable across rewrites).' }),
  commit: msg({ id: 'jj.row.commit', defaultMessage: 'Commit', description: 'A column of jj’s History (HI-2799): the commit id (this exact version).' }),
  description: msg({ id: 'jj.row.description', defaultMessage: 'Description', description: 'A column of jj’s History (HI-2799).' }),
  noDescription: msg({ id: 'jj.row.noDescription', defaultMessage: '(no description)', description: 'A jj commit with an empty description (HI-2799).' }),
  conflict: msg({ id: 'jj.badge.conflict', defaultMessage: 'conflicted', description: 'A badge on a jj commit storing unresolved conflicts (HI-2799). Lower case.' }),
  divergent: msg({ id: 'jj.badge.divergent', defaultMessage: 'divergent', description: 'A badge on a jj commit whose change id names several commits (HI-2799). Lower case.' }),
  divergentTip: msg({ id: 'jj.badge.divergentTip', defaultMessage: 'This change id names more than one commit: refer to this one by its commit id. Combwork never picks one.', description: 'Tooltip of the divergent badge in jj’s History (HI-2799).' }),
  empty: msg({ id: 'jj.badge.empty', defaultMessage: 'empty', description: 'A badge on a jj commit with no changes (HI-2799). Lower case.' }),
  workingCopy: msg({ id: 'jj.badge.workingCopy', defaultMessage: 'working copy', description: 'A badge on the jj working-copy commit (@) of the project folder (HI-2799). Lower case.' }),
  capped: msg({ id: 'jj.history.capped', defaultMessage: 'Only the latest {n, number} are shown.', description: 'Under jj’s History (HI-2799) when there are more commits than shown.' }),
  ids: msg({ id: 'jj.ids.tip', defaultMessage: 'Change {change}\nCommit {commit}', description: 'Tooltip of a jj commit’s ids (HI-2799): both in full.' }),
  // Compare.
  from: msg({ id: 'jj.compare.from', defaultMessage: 'From', description: 'A field of jj’s Compare (HI-2799): the older revision (a bookmark, change id or commit id).' }),
  to: msg({ id: 'jj.compare.to', defaultMessage: 'To', description: 'A field of jj’s Compare (HI-2799): the newer revision.' }),
  placeholder: msg({ id: 'jj.compare.placeholder', defaultMessage: 'Bookmark, change or commit id', description: 'Placeholder of jj’s Compare fields (HI-2799).' }),
  compare: msg({ id: 'jj.compare.go', defaultMessage: 'Compare', description: 'The button of jj’s Compare (HI-2799).' }),
  badRevision: msg({ id: 'jj.compare.bad', defaultMessage: 'Type a bookmark, a change id or a commit id.', description: 'jj’s Compare (HI-2799): a field holds something else (spaces, symbols).' }),
  noneFound: msg({ id: 'jj.compare.none', defaultMessage: 'Nothing is called {rev}.', description: 'jj’s Compare (HI-2799): no revision has that name or id.' }),
  ambiguous: msg({ id: 'jj.compare.ambiguous', defaultMessage: '{rev} names {n, plural, one {# commit} other {# commits}}: pick one by its commit id.', description: 'jj’s Compare (HI-2799): the id is ambiguous (a divergent change id, or a prefix of several): Combwork never picks one.' }),
  pick: msg({ id: 'jj.compare.pick', defaultMessage: 'Use This One', description: 'A button beside one of the commits an ambiguous id names in jj’s Compare (HI-2799): puts its commit id in the field.' }),
  files: msg({ id: 'jj.compare.files', defaultMessage: '{n, plural, =0 {No files changed} one {# file changed} other {# files changed}}', description: 'jj’s Compare (HI-2799): how many files differ.' }),
  diffCapped: msg({ id: 'jj.compare.capped', defaultMessage: 'The diff is long: only its start is shown.', description: 'Under a jj diff in Compare (HI-2799) cut at its limit.' }),
  // Bookmarks.
  bookmark: msg({ id: 'jj.bookmarks.name', defaultMessage: 'Bookmark', description: 'A column of jj’s Bookmarks (HI-2799): the name (and remote).' }),
  target: msg({ id: 'jj.bookmarks.target', defaultMessage: 'Points at', description: 'A column of jj’s Bookmarks (HI-2799): the change and commit it names.' }),
  bookmarkConflict: msg({ id: 'jj.bookmarks.conflict', defaultMessage: 'conflicted: {sides}', description: 'A conflicted jj bookmark (HI-2799): it names several commits ({sides}, short ids).' }),
  notInGit: msg({ id: 'jj.bookmarks.notInGit', defaultMessage: 'not the same in Git', description: 'A badge on a jj bookmark whose Git branch differs (HI-2799): not exported yet, or Git moved it. Lower case. Keep Git.' }),
  noBookmarks: msg({ id: 'jj.bookmarks.none', defaultMessage: 'No bookmarks.', description: 'jj’s Bookmarks section (HI-2799) when there are none.' }),
  bookmarksNote: msg({ id: 'jj.bookmarks.note', defaultMessage: 'Bookmarks are created, moved and pushed with jj itself: Combwork only shows them.', description: 'A note in jj’s Bookmarks section (HI-2799). Keep jj.' }),
  // Conflicts.
  conflictsIntro: msg({ id: 'jj.conflicts.intro', defaultMessage: 'jj can keep a conflict in a commit and carry on. These commits store conflicts; resolve them with jj in a terminal (jj resolve).', description: 'The top of jj’s Conflicts section (HI-2799). Keep jj and jj resolve (a command).' }),
  noConflicts: msg({ id: 'jj.conflicts.none', defaultMessage: 'No commit stores a conflict.', description: 'jj’s Conflicts section (HI-2799) when there are none.' }),
  conflictFiles: msg({ id: 'jj.conflicts.files', defaultMessage: '{n, plural, one {# conflicted file} other {# conflicted files}}', description: 'Under a conflicted jj commit (HI-2799).' }),
  // Operations (HI-2800).
  opsIntro: msg({ id: 'jj.ops.intro', defaultMessage: 'jj records every command as an operation. Preview one to see what undoing it would change. Combwork changes nothing here: when undoing it would touch nothing else, it gives you the command to run yourself.', description: 'The top of jj’s Operations section (HI-2800). Keep jj.' }),
  opsOlder: msg({ id: 'jj.ops.older', defaultMessage: 'Show Older', description: 'A button under jj’s operations list (HI-2800): shows the next page of older operations.' }),
  opPreview: msg({ id: 'jj.ops.preview', defaultMessage: 'Preview Undo', description: 'A button on one jj operation (HI-2800): shows what undoing (reverting) it would change, without changing anything.' }),
  opSnapshot: msg({ id: 'jj.ops.snapshot', defaultMessage: 'snapshot', description: 'A badge on a jj operation that recorded a workspace’s files (a working-copy snapshot, HI-2800). Lower case.' }),
  opBy: msg({ id: 'jj.ops.by', defaultMessage: '{user} in {workspace}', description: 'Who ran a jj operation and in which workspace (HI-2800), after its description. {user} is user@host as jj records it.' }),
  opNone: msg({ id: 'jj.ops.none', defaultMessage: 'No operations.', description: 'jj’s Operations section (HI-2800) when there are none.' }),
  previewHead: msg({ id: 'jj.ops.previewHead', defaultMessage: 'Undoing “{description}”', description: 'The heading of a jj operation’s undo preview (HI-2800). {description} is the operation as jj named it.' }),
  previewAt: msg({ id: 'jj.ops.previewAt', defaultMessage: 'A preview at operation {at}. If anything else changes before you run it, preview again: this isn’t a guarantee about a later command.', description: 'Under a jj undo preview’s heading (HI-2800): the preview holds only for the repository as it was at that operation ({at}, a short id). Keep jj.' }),
  previewSnapshot: msg({ id: 'jj.ops.previewSnapshot', defaultMessage: 'Run in the project folder, jj first records any edits you haven’t recorded yet, as its own operation, then undoes this one.', description: 'A note on a jj undo preview and its command (HI-2800): jj snapshots the working copy before the revert, as a separate operation. Keep jj.' }),
  did: msg({ id: 'jj.ops.did', defaultMessage: 'What it changed (undoing it puts these back)', description: 'A heading in a jj undo preview (HI-2800): the bookmarks, refs, commits and workspaces the operation changed.' }),
  didNothing: msg({ id: 'jj.ops.didNothing', defaultMessage: 'Nothing that undoing it would change.', description: 'A jj undo preview (HI-2800) for an operation that changed nothing.' }),
  later: msg({ id: 'jj.ops.later', defaultMessage: 'Later work undoing it would also change', description: 'A heading in a jj undo preview (HI-2800): changes made since the operation that undoing it would touch too.' }),
  added: msg({ id: 'jj.ops.added', defaultMessage: '{n, plural, one {# commit made} other {# commits made}}: {ids}', description: 'In a jj undo preview (HI-2800): the commits the operation made (or rewrote into), short ids.' }),
  hidden: msg({ id: 'jj.ops.hidden', defaultMessage: '{n, plural, one {# commit hidden} other {# commits hidden}}: {ids}', description: 'In a jj undo preview (HI-2800): the commits the operation hid (abandoned or rewrote), short ids. Undoing it brings them back.' }),
  opChange: msg({ id: 'jj.ops.change', defaultMessage: '{what}: {before} → {after}', description: 'One thing a jj operation changed (HI-2800): {what} names it (a bookmark, a Git ref…), {before} and {after} its value (short commit ids, or “none”). Keep the arrow.' }),
  absent: msg({ id: 'jj.ops.absent', defaultMessage: 'none', description: 'In a jj undo preview (HI-2800): a bookmark, ref or workspace that didn’t exist (before) or doesn’t any more (after). Lower case.' }),
  conflictedValue: msg({ id: 'jj.ops.conflicted', defaultMessage: 'conflicted ({sides})', description: 'In a jj undo preview (HI-2800): a bookmark or ref whose target is conflicted; {sides} are its commits, short ids.' }),
  whyChanged: msg({ id: 'jj.ops.why.changed', defaultMessage: '{what} changed since: now {now}', description: 'Later work in a jj undo preview (HI-2800): something the operation changed was changed again since.' }),
  whyDescendant: msg({ id: 'jj.ops.why.descendant', defaultMessage: 'Commit {commit} was made on top of what it made: undoing it would rebase that commit', description: 'Later work in a jj undo preview (HI-2800).' }),
  whyRewritten: msg({ id: 'jj.ops.why.rewritten', defaultMessage: 'Commit {commit} it made was rewritten or abandoned since', description: 'Later work in a jj undo preview (HI-2800).' }),
  whyRestored: msg({ id: 'jj.ops.why.restored', defaultMessage: 'Commit {commit} it hid is back since', description: 'Later work in a jj undo preview (HI-2800).' }),
  command: msg({ id: 'jj.ops.command', defaultMessage: 'Undoing it changes only what it changed. To undo it, run this in the project folder:', description: 'Above the jj command a preview offers (HI-2800). Combwork never runs it itself.' }),
  copy: msg({ id: 'jj.ops.copy', defaultMessage: 'Copy', description: 'A button beside the jj command of an undo preview (HI-2800): copies it, after checking the repository hasn’t changed since the preview.' }),
  copied: msg({ id: 'jj.ops.copied', defaultMessage: 'Command copied', description: 'A notification (HI-2800): the jj undo command was copied.' }),
  movedAtCopy: msg({ id: 'jj.ops.movedAtCopy', defaultMessage: 'The repository changed since this preview, so nothing was copied. Here it is again: look at it before copying.', description: 'In a jj undo preview (HI-2800): Copy found the repository changed since the preview; the preview shown is the new one.' }),
  noCommand: msg({ id: 'jj.ops.noCommand', defaultMessage: 'No command: {why}', description: 'In a jj undo preview (HI-2800): Combwork gives no command, and why ({why}).' }),
  // Why no command (HI-2800/s19's E1–E7).
  'refused.tool': msg({ id: 'jj.ops.refused.tool', defaultMessage: 'jj isn’t the version Combwork is tested with.', description: 'Why a jj undo preview gives no command (HI-2800). Keep jj.' }),
  'refused.heads': msg({ id: 'jj.ops.refused.heads', defaultMessage: 'jj’s operation log has more than one head.', description: 'Why a jj undo preview gives no command (HI-2800). Keep jj.' }),
  'refused.moved': msg({ id: 'jj.ops.refused.moved', defaultMessage: 'the repository changed since the preview.', description: 'Why a jj undo preview gives no command (HI-2800): a new operation was recorded meanwhile.' }),
  'refused.parents': msg({ id: 'jj.ops.refused.parents', defaultMessage: 'it joins operations that ran at the same time (or is the first one), so undoing it can’t be previewed.', description: 'Why a jj undo preview gives no command (HI-2800): a merge of concurrent operations, or the root operation.' }),
  'refused.shape': msg({ id: 'jj.ops.refused.shape', defaultMessage: 'jj recorded it in a form Combwork can’t read whole.', description: 'Why a jj undo preview gives no command (HI-2800): the operation’s view isn’t exactly what the tested jj writes. Keep jj.' }),
  'refused.bounds': msg({ id: 'jj.ops.refused.bounds', defaultMessage: 'it changed more than a preview shows.', description: 'Why a jj undo preview gives no command (HI-2800): too many bookmarks, refs or commits to account for.' }),
  'refused.workingCopy': msg({ id: 'jj.ops.refused.workingCopy', defaultMessage: 'it changed a workspace’s working copy: undoing it would update files there, which a preview can’t check.', description: 'Why a jj undo preview gives no command (HI-2800): a commit, describe, new, snapshot, workspace added or forgotten.' }),
  'refused.gitOwn': msg({ id: 'jj.ops.refused.gitOwn', defaultMessage: 'it recorded a change made in Git: undoing it changes nothing in Git, and jj would import it again.', description: 'Why a jj undo preview gives no command (HI-2800): an import of Git’s refs or a fetch. Keep jj and Git.' }),
  'refused.overlap': msg({ id: 'jj.ops.refused.overlap', defaultMessage: 'undoing it would also change later work, listed above.', description: 'Why a jj undo preview gives no command (HI-2800).' }),
  'refused.stale': msg({ id: 'jj.ops.refused.stale', defaultMessage: 'the project folder’s workspace is stale. jj workspace update-stale updates it, but edits jj hasn’t recorded can end up in a separate commit.', description: 'Why a jj undo preview gives no command (HI-2800): the project folder’s files are behind its working-copy commit. Keep jj workspace update-stale (a command).' }),
  'refused.nothing': msg({ id: 'jj.ops.refused.nothing', defaultMessage: 'it changed nothing to undo.', description: 'Why a jj undo preview gives no command (HI-2800).' }),
  // An entry's kind, in a preview.
  'kind.bookmark': msg({ id: 'jj.ops.kind.bookmark', defaultMessage: 'Bookmark {name}', description: 'A jj bookmark in an undo preview (HI-2800). {name} is its name.' }),
  'kind.tag': msg({ id: 'jj.ops.kind.tag', defaultMessage: 'Tag {name}', description: 'A jj tag in an undo preview (HI-2800).' }),
  'kind.remoteBookmark': msg({ id: 'jj.ops.kind.remoteBookmark', defaultMessage: 'Bookmark {name}@{remote}', description: 'A remote’s bookmark (and whether it is tracked) in a jj undo preview (HI-2800). Keep the @.' }),
  'kind.remoteTag': msg({ id: 'jj.ops.kind.remoteTag', defaultMessage: 'Tag {name}@{remote}', description: 'A remote’s tag in a jj undo preview (HI-2800). Keep the @.' }),
  'kind.remote': msg({ id: 'jj.ops.kind.remote', defaultMessage: 'Remote {name}', description: 'A remote in a jj undo preview (HI-2800).' }),
  'kind.gitref': msg({ id: 'jj.ops.kind.gitref', defaultMessage: 'Git ref {name}', description: 'A Git ref as jj records it, in a jj undo preview (HI-2800). Keep Git.' }),
  'kind.githead': msg({ id: 'jj.ops.kind.githead', defaultMessage: 'Git HEAD of {name}', description: 'A workspace’s Git HEAD as jj records it, in a jj undo preview (HI-2800). Keep Git HEAD.' }),
  'kind.wc': msg({ id: 'jj.ops.kind.wc', defaultMessage: 'Working copy of {name}', description: 'A workspace’s working-copy commit in a jj undo preview (HI-2800). {name} is the workspace.' }),
  'kind.head': msg({ id: 'jj.ops.kind.head', defaultMessage: 'Head commit {name}', description: 'A visible head commit in a jj undo preview (HI-2800). {name} is its short id.' }),
  tracked: msg({ id: 'jj.ops.tracked', defaultMessage: '{commit}, {state, select, Tracked {tracked} other {not tracked}}', description: 'A remote bookmark’s value in a jj undo preview (HI-2800): its commit and whether it is tracked. Lower case.' })
}

const changeShort = PLATFORMS.jj.changeShort!
const commitShort = (id: string): string => revisionShort('jj', id)

/** One jj read for a project, again on Refresh and on coming back to the window. */
function useJjRead<T>(read: () => Promise<JjView<T>>, key: string): { data: JjView<T> | null; error: string | null; loading: boolean; reload: () => void } {
  const [s, setS] = useState<{ key: string; data: JjView<T> | null; error: string | null; loading: boolean }>({ key, data: null, error: null, loading: true })
  const reload = useCallback(() => {
    let live = true
    setS((p) => ({ ...p, key, loading: true }))
    read().then(
      (data) => live && setS({ key, data, error: null, loading: false }),
      (e: unknown) => live && setS({ key, data: null, error: errorMessage(e), loading: false })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(reload, [reload])
  useEffect(() => {
    const f = (): void => void reload()
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  }, [reload])
  const mine = s.key === key
  return { data: mine ? s.data : null, error: mine ? s.error : null, loading: !mine || s.loading, reload: () => void reload() }
}

export function unknownText(u: JjViewUnknown): string {
  if (u.jjUnknown === 'heads') return tr(M.heads, { detail: u.detail ?? '?' })
  if (u.jjUnknown === 'tool') return tr(M.tool)
  if (u.jjUnknown === 'moved') return tr(M.moved)
  if (u.jjUnknown === 'noRepo') return tr(M.noRepo)
  return `${tr(M.other, { code: u.jjUnknown })}${u.detail ? ` ${u.detail}` : ''}`
}

function Unknown({ u }: { u: JjViewUnknown }) {
  return (
    <div className="banner warn jj-unknown" data-jj-unknown={u.jjUnknown}>
      <Icon name="warning" /> {unknownText(u)}
    </div>
  )
}

/** A section's frame: its Refresh, and what the read gave (a value, an unknown, an error). */
function Frame<T>({ name, r, children }: { name: string; r: ReturnType<typeof useJjRead<T>>; children: (v: T) => React.ReactNode }) {
  useLanguage()
  return (
    <div className="scroll-page">
      <div className="page-narrow jj-section" data-jj-section={name}>
        <div className="git-section-head">
          <span className="git-section-actions">
            <button type="button" className="btn small subtle" data-action="jj-refresh" onClick={r.reload} disabled={r.loading}>
              <Icon name="refresh" spin={r.loading} /> {tr(M.refresh)}
            </button>
          </span>
        </div>
        {r.error ? <div className="banner danger">{tr(M.readFailed, { error: r.error })}</div> : r.data === null ? <p className="faint">{tr(M.reading)}</p> : isJjViewUnknown(r.data) ? <Unknown u={r.data} /> : children(r.data)}
      </div>
    </div>
  )
}

/** A commit's ids, change beside commit, each short, both in full in the tooltip. */
function Ids({ row }: { row: Pick<JjRow, 'change' | 'commit'> }) {
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tr(M.ids, { change: row.change, commit: row.commit })}</span>}>
      <span className="jj-ids mono" data-change={row.change} data-commit={row.commit}>
        <span className="jj-change">{changeShort(row.change)}</span> <span className="jj-commit faint">{commitShort(row.commit)}</span>
      </span>
    </Tooltip>
  )
}

function Badges({ row }: { row: JjRow }) {
  return (
    <>
      {row.workingCopy && <span className="badge info">{tr(M.workingCopy)}</span>}
      {row.conflict && (
        <span className="badge error" data-jj-badge="conflict">
          {tr(M.conflict)}
        </span>
      )}
      {row.divergent && (
        <Tooltip content={tr(M.divergentTip)}>
          <span className="badge warn" data-jj-badge="divergent">
            {tr(M.divergent)}
          </span>
        </Tooltip>
      )}
      {row.empty && <span className="badge">{tr(M.empty)}</span>}
    </>
  )
}

function RowLine({ row }: { row: JjRow }) {
  return (
    <li className="jj-row" data-jj-row={row.commit}>
      <Ids row={row} /> <Badges row={row} /> <span className="jj-desc">{row.description || <span className="faint">{tr(M.noDescription)}</span>}</span>{' '}
      {row.bookmarks.map((b) => (
        <span key={b} className="badge accent jj-bookmark">
          <Icon name="bookmark" /> {b}
        </span>
      ))}{' '}
      <span className="faint">
        {row.author} · {timeAgo(row.time)}
      </span>
    </li>
  )
}

/** Option A (HI-2794): the project's passed cards, each with its reviewed commit, its target and a command to integrate it. */
function IntegratePanel({ project }: { project: ProjectInfo }) {
  const tasks = useStore((s) => s.tasks)
  const passed = tasks.filter((t) => t.project === project.name && t.column === 'passed' && !t.archived)
  const [views, setViews] = useState<Record<number, WorkView | null>>({})
  const key = passed.map((t) => t.number).join(',')
  useEffect(() => {
    let live = true
    void Promise.all(passed.map((t) => call('tasks:work', t.number).then((v) => [t.number, v] as const, () => [t.number, null] as const))).then((rows) => live && setViews(Object.fromEntries(rows)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <section className="jj-integrate" data-jj-integrate="">
      <h4>{tr(M.integrate)}</h4>
      <p className="hint">{tr(M.noMerge)}</p>
      {passed.length === 0 ? (
        <p className="faint">{tr(M.integrateNone)}</p>
      ) : (
        <ul>
          {passed.map((t) => {
            const v = views[t.number]
            const commit = v?.approved?.revision ?? null
            const target = v?.target ?? ''
            return (
              <li key={t.number} data-jj-integrate-card={t.number}>
                <div>{tr(M.integrateCard, { card: cardLabelOf({ tasks }, t.number), title: t.title, commit: commit ? commitShort(commit) : '—', target: target || '—' })}</div>
                {commit && target && (
                  <>
                    <div className="hint">{tr(M.integrateHow, { target })}</div>
                    <code className="mono jj-command" data-jj-command="">{`jj rebase -r ${commit} -d ${target}` /* i18n-ignore: a jj command, as typed */}</code>
                  </>
                )}
                <div className="faint" data-jj-contained="unknown">
                  {tr(M.contained, { target: target || '—' })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function JjRepoSection({ project }: { project: ProjectInfo }) {
  const r = useJjRead<JjRepoView>(() => call('jj:repo', project.path), project.path)
  return (
    <Frame name="repo" r={r}>
      {(v) => (
        <>
          <p data-jj-root="">{tr(M.root, { root: v.root })}</p>
          <p className="hint">
            {tr(M.colocated, { colocated: v.colocated ? 'yes' : 'no' })} {v.tool.version && tr(M.version, { version: v.tool.version })}
          </p>
          {v.op ? <p className="hint mono">{tr(M.op, { op: v.op.slice(0, 12) })}</p> : <Unknown u={{ jjUnknown: 'heads', detail: String(v.heads) }} />}
          <p className="hint">{tr(M.edits)}</p>
          <h4>{tr(M.workspaces)}</h4>
          {isJjViewUnknown(v.workspaces) ? (
            <Unknown u={v.workspaces} />
          ) : (
            <ul data-jj-workspaces="">
              {v.workspaces.map((w) => (
                <li key={w.name} className="mono" data-jj-workspace={w.name} {...(w.stale ? { 'data-jj-stale': '' } : {})}>
                  {tr(M.workspace, { name: w.name, change: changeShort(w.change), commit: commitShort(w.commit) })} {w.here && <span className="badge">{tr(M.here)}</span>}{' '}
                  {w.stale && (
                    <Tooltip content={tr(M.staleTip)}>
                      <span className="badge warn">{tr(M.stale)}</span>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
          )}
          <IntegratePanel project={project} />
          <h4>{tr(M.unsupported)}</h4>
          <ul className="jj-unsupported" data-jj-unsupported="">
            {v.gates.map((g) => (
              <li key={g} data-gate={g}>
                <Icon name="circle-slash" /> <strong>{tr(GATE_TEXT[g].name)}</strong>: {tr(GATE_TEXT[g].why)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Frame>
  )
}

export function JjHistorySection({ project }: { project: ProjectInfo }) {
  const r = useJjRead<JjHistoryView>(() => call('jj:history', project.path), project.path)
  return (
    <Frame name="history" r={r}>
      {(v) => (
        <>
          <ul className="jj-rows" data-jj-history="">
            {v.rows.map((row) => (
              <RowLine key={row.commit} row={row} />
            ))}
          </ul>
          {v.capped && <p className="hint">{tr(M.capped, { n: v.rows.length })}</p>}
        </>
      )}
    </Frame>
  )
}

function Resolved({ side, rev, r, onPick }: { side: 'from' | 'to'; rev: string; r: JjResolved; onPick: (commit: string) => void }) {
  if ('commit' in r) return null
  if ('none' in r) return <div className="banner warn" data-jj-resolve={side} data-jj-resolve-state="none">{tr(M.noneFound, { rev })}</div>
  return (
    <div className="banner warn" data-jj-resolve={side} data-jj-resolve-state="ambiguous">
      <div>{tr(M.ambiguous, { rev, n: r.ambiguous.length })}</div>
      <ul>
        {r.ambiguous.map((c) => (
          <li key={c.commit}>
            <Ids row={c} /> <Badges row={c} /> {c.description}{' '}
            <button type="button" className="btn small subtle" data-action="jj-pick" onClick={() => onPick(c.commit)}>
              {tr(M.pick)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function JjCompareSection({ project }: { project: ProjectInfo }) {
  useLanguage()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [asked, setAsked] = useState<{ from: string; to: string } | null>(null)
  const [result, setResult] = useState<{ for: string; v: Awaited<ReturnType<typeof call<'jj:compare'>>> } | { for: string; error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const bad = (from && !jjRevisionInput(from)) || (to && !jjRevisionInput(to))
  const run = (f: string, t: string): void => {
    setAsked({ from: f, to: t })
    setBusy(true)
    call('jj:compare', project.path, f, t).then(
      (v) => setResult({ for: project.path, v }),
      (e: unknown) => setResult({ for: project.path, error: errorMessage(e) })
    ).finally(() => setBusy(false))
  }
  const res = result?.for === project.path ? result : null
  const v = res && 'v' in res ? res.v : null
  return (
    <div className="scroll-page">
      <div className="page-narrow jj-section" data-jj-section="compare">
        <form
          className="jj-compare-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!bad && from && to) run(from.trim(), to.trim())
          }}
        >
          <label>
            {tr(M.from)} <input className="input mono" data-jj-from="" value={from} placeholder={tr(M.placeholder)} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            {tr(M.to)} <input className="input mono" data-jj-to="" value={to} placeholder={tr(M.placeholder)} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" className="btn small primary" data-action="jj-compare" disabled={!!bad || !from || !to || busy}>
            {tr(M.compare)}
          </button>
        </form>
        {bad && <p className="caution">{tr(M.badRevision)}</p>}
        {res && 'error' in res && <div className="banner danger">{tr(M.readFailed, { error: res.error })}</div>}
        {v && isJjViewUnknown(v) && <Unknown u={v} />}
        {v && !isJjViewUnknown(v) && !('files' in v) && asked && (
          <>
            <Resolved side="from" rev={asked.from} r={v.from} onPick={(c) => setFrom(c)} />
            <Resolved side="to" rev={asked.to} r={v.to} onPick={(c) => setTo(c)} />
          </>
        )}
        {v && !isJjViewUnknown(v) && 'files' in v && <CompareResult v={v} />}
      </div>
    </div>
  )
}

function CompareResult({ v }: { v: JjCompareView }) {
  return (
    <div data-jj-compare-result="">
      <ul className="jj-rows">
        <RowLine row={v.from} />
        <RowLine row={v.to} />
      </ul>
      <h4>{tr(M.files, { n: v.files.length })}</h4>
      <ul className="mono" data-jj-files="">
        {v.files.map((f) => (
          <li key={f.path}>
            {f.status} {f.path}
          </li>
        ))}
      </ul>
      {v.diff && <pre className="jj-diff mono">{v.diff}</pre>}
      {v.capped && <p className="hint">{tr(M.diffCapped)}</p>}
    </div>
  )
}

export function JjBookmarksSection({ project }: { project: ProjectInfo }) {
  const r = useJjRead<JjBookmarksView>(() => call('jj:bookmarks', project.path), project.path)
  return (
    <Frame name="bookmarks" r={r}>
      {(v) => (
        <>
          <p className="hint">{tr(M.bookmarksNote)}</p>
          {v.rows.length === 0 ? (
            <p className="faint">{tr(M.noBookmarks)}</p>
          ) : (
            <table className="jj-table" data-jj-bookmarks="">
              <thead>
                <tr>
                  <th>{tr(M.bookmark)}</th>
                  <th>{tr(M.target)}</th>
                </tr>
              </thead>
              <tbody>
                {v.rows.map((b) => (
                  <tr key={`${b.name}@${b.remote ?? ''}`} data-jj-bookmark={b.name} data-jj-remote={b.remote ?? ''} {...(b.conflict ? { 'data-jj-conflict': '' } : {})}>
                    <td className="mono">
                      {b.name}
                      {b.remote && <span className="faint">@{b.remote}</span>} {b.gitDiffers && <span className="badge warn" data-jj-not-in-git="">{tr(M.notInGit)}</span>}
                    </td>
                    <td>{b.conflict ? <span className="badge error">{tr(M.bookmarkConflict, { sides: b.sides.map(commitShort).join(', ') })}</span> : b.commit && b.change ? <Ids row={{ commit: b.commit, change: b.change }} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Frame>
  )
}

export function JjConflictsSection({ project }: { project: ProjectInfo }) {
  const r = useJjRead<JjConflictsView>(() => call('jj:conflicts', project.path), project.path)
  return (
    <Frame name="conflicts" r={r}>
      {(v) => (
        <>
          <p className="hint">{tr(M.conflictsIntro)}</p>
          {v.rows.length === 0 ? (
            <p className="faint">{tr(M.noConflicts)}</p>
          ) : (
            <ul className="jj-rows" data-jj-conflicts="">
              {v.rows.map((c) => (
                <li key={c.row.commit}>
                  <RowLine row={c.row} />
                  {isJjViewUnknown(c.files) ? (
                    <Unknown u={c.files} />
                  ) : (
                    <>
                      <div className="hint">{tr(M.conflictFiles, { n: c.files.length })}</div>
                      <ul className="mono">
                        {c.files.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Frame>
  )
}

/** A value as a preview shows it: short commit ids, conflicted sides, a remote ref's tracking; absent as "none". */
function valueText(v: string | null): string {
  if (v === null) return tr(M.absent)
  if (v === 'present') return '✓' // i18n-ignore: a mark, not text
  const ids = [...v.matchAll(/"([0-9a-f]{40})"/g)].map((m) => commitShort(m[1]))
  const state = /state:(Tracked|New)\}$/.exec(v)?.[1]
  const base = v.startsWith('Conflicted') || v.includes('target:Conflicted') ? tr(M.conflictedValue, { sides: ids.join(', ') }) : ids.join(', ') || tr(M.absent)
  return state ? tr(M.tracked, { commit: base, state }) : base
}

/** An entry's key as a preview names it (`bookmark:main`: Bookmark main). */
function keyText(key: string): string {
  const [kind, ...rest] = key.split(':')
  const name = rest.join(':')
  if (kind === 'remote') {
    const [remote, sub, ...n] = rest
    if (!sub) return tr(M['kind.remote'], { name: remote })
    return tr(sub === 'tag' ? M['kind.remoteTag'] : M['kind.remoteBookmark'], { name: n.join(':'), remote })
  }
  if (kind === 'head') return tr(M['kind.head'], { name: commitShort(name) })
  if (kind === 'commit') return commitShort(name)
  const k = ({ bookmark: M['kind.bookmark'], tag: M['kind.tag'], gitref: M['kind.gitref'], githead: M['kind.githead'], wc: M['kind.wc'] } as Record<string, Msg | undefined>)[kind]
  return k ? tr(k, { name }) : key
}

function overlapText(o: JjOpOverlap): string {
  if (o.why === 'changedSince') return tr(M.whyChanged, { what: keyText(o.key), now: valueText(o.now) })
  const commit = commitShort(o.key.replace(/^commit:/, ''))
  return tr(o.why === 'descendant' ? M.whyDescendant : o.why === 'rewrittenSince' ? M.whyRewritten : M.whyRestored, { commit })
}

const REFUSED: Record<JjOpRefusal, Msg> = {
  tool: M['refused.tool'],
  heads: M['refused.heads'],
  moved: M['refused.moved'],
  parents: M['refused.parents'],
  shape: M['refused.shape'],
  bounds: M['refused.bounds'],
  workingCopy: M['refused.workingCopy'],
  gitOwn: M['refused.gitOwn'],
  overlap: M['refused.overlap'],
  stale: M['refused.stale'],
  nothing: M['refused.nothing']
}

/** One operation's undo preview: what it changed, later work it would touch, and the command only when nothing else would change. */
function OperationPreview({ project, p, note, onReplace }: { project: ProjectInfo; p: JjOperationPreview; note: string | null; onReplace: (p: JjView<JjOperationPreview>, note: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const copy = (): void => {
    setBusy(true)
    // Copy asks main again at the head the preview was read at: a changed head copies nothing and shows the new preview.
    call('jj:operationPreview', project.path, p.op, p.at)
      .then(async (again) => {
        if (!isJjViewUnknown(again) && again.command && again.at === p.at) {
          await navigator.clipboard.writeText(again.command)
          notify('success', tr(M.copied))
          return
        }
        onReplace(await call('jj:operationPreview', project.path, p.op, null), tr(M.movedAtCopy))
      })
      .catch((e: unknown) => notify('error', tr(M.readFailed, { error: errorMessage(e) })))
      .finally(() => setBusy(false))
  }
  const did: JjOpChange[] = p.did.filter((d) => !d.key.startsWith('head:'))
  const nothing = did.length === 0 && p.commits.added.length === 0 && p.commits.hidden.length === 0
  return (
    <div className="jj-op-preview" data-jj-op-preview={p.op} data-jj-refused={p.refused ?? ''}>
      <h4>{tr(M.previewHead, { description: p.description || tr(M.noDescription) })}</h4>
      {note && (
        <div className="banner warn" data-jj-moved-at-copy="">
          {note}
        </div>
      )}
      <p className="hint">{tr(M.previewAt, { at: p.at.slice(0, 12) })}</p>
      <h5>{tr(M.did)}</h5>
      {nothing ? (
        <p className="faint">{tr(M.didNothing)}</p>
      ) : (
        <ul className="jj-op-did" data-jj-op-did="">
          {p.commits.added.length > 0 && <li>{tr(M.added, { n: p.commits.added.length, ids: p.commits.added.map(commitShort).join(', ') })}</li>}
          {p.commits.hidden.length > 0 && <li>{tr(M.hidden, { n: p.commits.hidden.length, ids: p.commits.hidden.map(commitShort).join(', ') })}</li>}
          {did.map((d) => (
            <li key={d.key} data-key={d.key}>
              {tr(M.opChange, { what: keyText(d.key), before: valueText(d.before), after: valueText(d.after) })}
            </li>
          ))}
        </ul>
      )}
      {p.later.length > 0 && (
        <>
          <h5>{tr(M.later)}</h5>
          <ul className="jj-op-later" data-jj-op-later="">
            {p.later.map((o) => (
              <li key={`${o.key}:${o.why}`}>{overlapText(o)}</li>
            ))}
          </ul>
        </>
      )}
      {p.command ? (
        <div data-jj-op-command="">
          <p className="hint">{tr(M.command)}</p>
          <div className="jj-op-command-row">
            <code className="mono jj-command">{p.command}</code>{' '}
            <button type="button" className="btn small" data-action="jj-op-copy" onClick={copy} disabled={busy}>
              <Icon name="copy" /> {tr(M.copy)}
            </button>
          </div>
          <p className="hint">{tr(M.previewSnapshot)}</p>
        </div>
      ) : (
        <p className="caution" data-jj-op-nocommand="">
          {tr(M.noCommand, { why: tr(REFUSED[p.refused ?? 'shape']) })}
        </p>
      )}
    </div>
  )
}

function OperationLine({ row, selected, onPreview }: { row: JjOperationRow; selected: boolean; onPreview: () => void }) {
  return (
    <li className={`jj-row jj-op${selected ? ' selected' : ''}`} data-jj-op={row.id}>
      <span className="mono faint">{row.id.slice(0, 12)}</span> {row.snapshot && <span className="badge">{tr(M.opSnapshot)}</span>} <span className="jj-desc">{row.description || <span className="faint">{tr(M.noDescription)}</span>}</span>{' '}
      <span className="faint">
        {tr(M.opBy, { user: row.user, workspace: row.workspace })} · {timeAgo(row.time)}
      </span>{' '}
      <button type="button" className="btn small subtle" data-action="jj-op-preview" onClick={onPreview}>
        <Icon name="discard" /> {tr(M.opPreview)}
      </button>
    </li>
  )
}

/** jj's operations, each named as jj named it, and a preview of undoing one (HI-2800). Nothing here writes. */
export function JjOperationsSection({ project }: { project: ProjectInfo }) {
  const r = useJjRead<JjOperationsView>(() => call('jj:operations', project.path, null), project.path)
  const [older, setOlder] = useState<{ for: string; first: string; rows: JjOperationRow[]; next: string | null } | null>(null)
  const [preview, setPreview] = useState<{ for: string; op: string; v: JjView<JjOperationPreview> | null; note: string | null } | null>(null)
  const first = r.data && !isJjViewUnknown(r.data) ? r.data : null
  // Older pages belong to the first page they were read after: a refreshed list starts again.
  const extra = older && first && older.for === project.path && older.first === first.op ? older : null
  const rows = first ? [...first.rows, ...(extra?.rows ?? [])] : []
  const next = extra ? extra.next : (first?.next ?? null)
  const shown = preview?.for === project.path ? preview : null
  const showOlder = (): void => {
    if (!next || !first) return
    void call('jj:operations', project.path, next).then((v) => {
      if (isJjViewUnknown(v)) return
      setOlder({ for: project.path, first: first.op, rows: [...(extra?.rows ?? []), ...v.rows], next: v.next })
    })
  }
  const ask = (op: string): void => {
    setPreview({ for: project.path, op, v: null, note: null })
    call('jj:operationPreview', project.path, op, null).then(
      (v) => setPreview({ for: project.path, op, v, note: null }),
      (e: unknown) => setPreview({ for: project.path, op, v: { jjUnknown: 'failed', detail: errorMessage(e) }, note: null })
    )
  }
  return (
    <Frame name="operations" r={r}>
      {() => (
        <>
          <p className="hint">{tr(M.opsIntro)}</p>
          {shown && (shown.v === null ? <p className="faint">{tr(M.reading)}</p> : isJjViewUnknown(shown.v) ? <Unknown u={shown.v} /> : <OperationPreview project={project} p={shown.v} note={shown.note} onReplace={(v, note) => setPreview({ for: project.path, op: shown.op, v, note })} />)}
          {rows.length === 0 ? (
            <p className="faint">{tr(M.opNone)}</p>
          ) : (
            <ul className="jj-rows" data-jj-operations="">
              {rows.map((row) => (
                <OperationLine key={row.id} row={row} selected={shown?.op === row.id} onPreview={() => ask(row.id)} />
              ))}
            </ul>
          )}
          {next && (
            <button type="button" className="btn small subtle" data-action="jj-ops-older" onClick={showOlder}>
              {tr(M.opsOlder)}
            </button>
          )}
        </>
      )}
    </Frame>
  )
}
