import { Children, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AttachmentContent, FileEntry, ProjectInfo, SessionAttachment, SessionAttachmentGroup } from '@shared/types'
import { ATTACHMENT_KIND_ICON, ATTACHMENT_KINDS, attachmentLabel, type AttachmentKind } from '@shared/attachments'
import { providerDescriptor } from '@shared/providers'
import { daysAgo, formatDateTime, formatLongDay, formatShortDay, formatTime } from '@shared/dates'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { attachFiles } from '../attach'
import { discardDrafts, draftsUnder, FILES_TEXT, FileView, hasDraft, moveDrafts, previewsFromDisk, ReadOnlyPreview, useDraftVersion } from '../components/FileView'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { pasteIntoTerminal } from '../components/TerminalView'
import { Icon, IconButton, InfoTip, LoadFailed, Modal, SearchInput, StaleNote, Tooltip, useContextMenu, type MenuEntry } from '../components/ui'
import { cardLabelOf, chooseTab, confirm, filesListeners, useRememberedTab, focusedAgentId, get, notify, openInSessionsTab, projectKey, set, setProjectTab, showAgent, useDateStyle, useStore } from '../store'
import { attachToCardMenu, CARD_ATTACH_TEXT, CardAttachmentSection, removeCardAttachmentAsked, shownCardGroups, useProjectCardAttachments } from '../components/CardAttachments'
import type { CardAttachment } from '@shared/cardAttachments'
import { TabPanel, Tabs } from '../components/Tabs'
import { useScopedLoad } from '../scopedLoad'
import { agentFolder, awayFromProject, legacyOf, placeText } from '../agentPlace'
import { cx, formatBytes, formatKeybinding, FILES_MIME, IMAGE_EXT, imageUrl, quotePath, timeAgo } from '../util'
import { CW_DIR } from '@shared/defaults'

const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const absOf = (project: ProjectInfo, rel: string): string => (rel ? `${project.path}\\${rel.replace(/\//g, '\\')}` : project.path)
const isUnder = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(dir + '/')

const kbd = (chunks: React.ReactNode[]): React.ReactNode => <kbd>{chunks}</kbd>
const faint = (chunks: React.ReactNode[]): React.ReactNode => <span className="faint">{chunks}</span>
/** A message with markup, as React children (keyed, so a list of parts renders without warnings). */
const rich = (m: Msg, values: Parameters<typeof tRich<React.ReactNode>>[1]): React.ReactNode[] => Children.toArray(tRich<React.ReactNode>(m, values))

const M = {
  attachToCard: msg({ id: 'files.attach.toCard', defaultMessage: 'Attach to a card', description: "A session attachment's menu entry in the Attachments tab (HI-1700): opens a menu of the project's cards, to copy the file to one." }),
  rootTip: msg({ id: 'files.root.tip', defaultMessage: 'Show the project folder, or the folder an agent works in: its slot or worktree', description: "Tooltip on the Files tab's folder picker, shown when agents work outside the project folder (in slots, Hive's worktrees lent to cards, or their own worktrees from before 1.0)." }),
  projectFolder: msg({ id: 'files.root.projectFolder', defaultMessage: 'Project folder', description: "The Files tab's folder picker: the project's own folder." }),
  agentPlace: msg({ id: 'files.root.place', defaultMessage: '{agent} · {place}', description: "The Files tab's folder picker: the folder an agent works in. {agent} is the agent's name, {place} where (agents.place.short: \"in slot-b\", \"carried: hb2\", \"home: hr4\")." }),
  agentWorktree: msg({ id: 'files.root.worktree', defaultMessage: "{agent}'s worktree · {branch}", description: "The Files tab's folder picker: a worktree agent's folder. {agent} is the agent's name, {branch} its git branch." }),
  gitStatus: msg({ id: 'files.git.status', defaultMessage: '{status, select, M {Modified} A {Added} D {Deleted} R {Renamed} U {Untracked} C {Copied} other {{status}}}', description: "A file's git status in the Files tab's details, after its letter. Translate the words, not the letters that pick them." }),
  gitInFolder: msg({ id: 'files.git.inFolder', defaultMessage: '{status} (contains changes)', description: "A folder's git status in the Files tab's details: {status} is the first change inside it, such as Modified." }),
  couldNotRename: msg({ id: 'files.error.rename', defaultMessage: 'Could not rename', description: 'Title of an error notification in the Files tab.' }),
  couldNotCreateFolder: msg({ id: 'files.error.createFolder', defaultMessage: 'Could not create folder', description: 'Title of an error notification in the Files tab.' }),
  couldNotCreateFile: msg({ id: 'files.error.createFile', defaultMessage: 'Could not create file', description: 'Title of an error notification in the Files tab.' }),
  couldNotDelete: msg({ id: 'files.error.delete', defaultMessage: 'Could not delete', description: 'Title of an error notification in the Files tab: moving files to the Recycle Bin failed.' }),
  couldNotPaste: msg({ id: 'files.error.paste', defaultMessage: 'Could not paste', description: 'Title of an error notification in the Files tab.' }),
  couldNotMove: msg({ id: 'files.error.move', defaultMessage: 'Could not move', description: 'Title of an error notification in the Files tab.' }),
  couldNotCopy: msg({ id: 'files.error.copy', defaultMessage: 'Could not copy', description: 'Title of an error notification in the Files tab.' }),
  couldNotCopyIn: msg({ id: 'files.error.copyIn', defaultMessage: 'Could not copy files in', description: 'Title of an error notification: files dropped from File Explorer could not be copied into the project.' }),
  couldNotDuplicate: msg({ id: 'files.error.duplicate', defaultMessage: 'Could not duplicate', description: 'Title of an error notification in the Files tab.' }),
  trashTitle: msg({ id: 'files.trash.title', defaultMessage: 'Move to Recycle Bin?', description: 'Title of the confirmation before files or attachments go to the Recycle Bin.' }),
  trashButton: msg({ id: 'files.trash.button', defaultMessage: 'Move to Recycle Bin', description: 'Button: moves the files or attachments to the Recycle Bin.' }),
  trashMessage: msg({ id: 'files.trash.message', defaultMessage: 'Move {count, plural, =1 {{folder, select, yes {"{name}" and everything in it} other {"{name}"}}} other {# items}} to the Recycle Bin?', description: 'The confirmation before deleting in the Files tab. {name} is the one file or folder ({folder} is yes for a folder); {count} how many are selected.' }),
  trashDetail: msg({ id: 'files.trash.detail', defaultMessage: 'You can restore it from the Recycle Bin.{unsaved, plural, =0 {} =1 { Unsaved changes to {file} will be lost.} other { Unsaved changes to # files will be lost.}}', description: 'Under the confirmation before deleting in the Files tab. {unsaved} is how many of the files have unsaved edits; {file} the one such file.' }),
  paste: msg({ id: 'files.menu.paste', defaultMessage: 'Paste', description: "Files tab's right-click menu." }),
  newFile: msg({ id: 'files.menu.newFile', defaultMessage: 'New File…', description: "Files tab's right-click menu and toolbar: creates a file." }),
  newFolder: msg({ id: 'files.menu.newFolder', defaultMessage: 'New Folder…', description: "Files tab's right-click menu and toolbar: creates a folder." }),
  refresh: msg({ id: 'files.refresh', defaultMessage: 'Refresh', description: 'Button or menu item: reads the folder (or the attachments) again.' }),
  openInDefaultApp: msg({ id: 'files.menu.openInDefaultApp', defaultMessage: 'Open in Default App', description: "Files tab's right-click menu and toolbar: opens the file in its Windows app." }),
  insertPath: msg({ id: 'files.menu.insertPath', defaultMessage: 'Insert Path into Session', description: "Files tab's right-click menu and toolbar: attaches the files to the agent's running session." }),
  cut: msg({ id: 'files.menu.cut', defaultMessage: 'Cut', description: "Files tab's right-click menu." }),
  copy: msg({ id: 'files.menu.copy', defaultMessage: 'Copy', description: "Files tab's right-click menu: copies the files (to paste elsewhere)." }),
  duplicate: msg({ id: 'files.menu.duplicate', defaultMessage: 'Duplicate', description: "Files tab's right-click menu: copies the files beside themselves." }),
  copyPath: msg({ id: 'files.menu.copyPath', defaultMessage: 'Copy Path', description: 'Menu item or button: copies the full path to the clipboard.' }),
  copyRelativePath: msg({ id: 'files.menu.copyRelativePath', defaultMessage: 'Copy Relative Path', description: "Files tab's right-click menu: copies the path within the project." }),
  rename: msg({ id: 'files.menu.rename', defaultMessage: 'Rename…', description: "Files tab's right-click menu." }),
  delete: msg({ id: 'files.delete', defaultMessage: 'Delete', description: 'Menu item or button: moves the files or attachments to the Recycle Bin.' }),
  files: msg({ id: 'files.header', defaultMessage: 'Files', description: "Heading of the Files tab's file tree." }),
  filesInfo: msg({ id: 'files.header.info', defaultMessage: 'Everything in the project folder. Drag files in from Explorer to copy them here, or drag files onto the Session tab to paste their paths into the session. Deleted files go to the Recycle Bin.', description: "The (i) beside the Files tab's heading." }),
  collapseAll: msg({ id: 'files.collapseAll', defaultMessage: 'Collapse All', description: "Files tab's toolbar: closes every open folder." }),
  findPlaceholder: msg({ id: 'files.find.placeholder', defaultMessage: 'Find files by name or path', description: "The Files tab's search box, empty." }),
  clear: msg({ id: 'files.find.clear', defaultMessage: 'Clear', description: "Tooltip on the button that empties the Files tab's search box." }),
  searching: msg({ id: 'files.find.searching', defaultMessage: 'Searching…', description: "The Files tab's list while a search runs." }),
  findLoadTarget: msg({ id: 'files.find.loadTarget', defaultMessage: 'the matching files', description: 'What could not be loaded when a search of the Files tab failed: shown in "Could not load {what}: {error}", with Retry.' }),
  noMatch: msg({ id: 'files.find.noMatch', defaultMessage: 'No files match “{filter}”.', description: "The Files tab's list when a search finds nothing. {filter} is what was typed." }),
  folderEmpty: msg({ id: 'files.tree.empty', defaultMessage: 'This project folder is empty.', description: "The Files tab's list for a project folder with nothing in it." }),
  itemsSelected: msg({ id: 'files.details.selected', defaultMessage: '{count, plural, one {# item selected} other {# items selected}}', description: "The Files tab's right pane when several files are selected." }),
  itemsHint: msg({ id: 'files.details.selectedHint', defaultMessage: 'Drag them onto a folder to move them (hold Ctrl to copy), or onto the Session tab to paste their paths.', description: 'Under "n items selected" in the Files tab.' }),
  selectSomething: msg({ id: 'files.details.none', defaultMessage: 'Select a file or folder', description: "The Files tab's right pane when nothing is selected." }),
  selectHint: msg({ id: 'files.details.noneHint', defaultMessage: 'Select a file to view or edit it. Right-click for more. <kbd>F2</kbd> renames, <kbd>Del</kbd> moves to the Recycle Bin, <kbd>Ctrl+C</kbd> / <kbd>Ctrl+X</kbd> / <kbd>Ctrl+V</kbd> copy, cut and paste.', description: 'Under "Select a file or folder". <kbd> marks a key: keep the keys as they are.' }),
  type: msg({ id: 'files.details.type', defaultMessage: 'Type', description: "Label in a file's or folder's details." }),
  folder: msg({ id: 'files.details.folder', defaultMessage: 'Folder', description: "A folder's type in its details." }),
  file: msg({ id: 'files.details.file', defaultMessage: 'File', description: 'The type of a file with no extension, in its details.' }),
  extFile: msg({ id: 'files.details.extFile', defaultMessage: '{ext} file', description: 'A file\'s type in its details, from its extension: "PNG file". {ext} is the extension in capitals.' }),
  size: msg({ id: 'files.details.size', defaultMessage: 'Size', description: "Label in a file's details." }),
  modified: msg({ id: 'files.details.modified', defaultMessage: 'Modified', description: "Label in a file's details: when it last changed." }),
  modifiedAt: msg({ id: 'files.details.modifiedAt', defaultMessage: '{when} <faint>({ago})</faint>', description: "A file's details, Modified: its date and time ({when}), then how long ago, greyed ({ago}: \"2 hours ago\"). Keep the <faint> tags; use your language's brackets." }),
  git: msg({ id: 'files.details.git', defaultMessage: 'Git', description: "Label in a file's details: its git status. Usually kept as Git." }),
  ignored: msg({ id: 'files.details.ignored', defaultMessage: 'Ignored', description: "A file's git status in its details: git ignores it." }),
  insertIntoSession: msg({ id: 'files.insertIntoSession', defaultMessage: 'Insert into Session', description: "Button or menu item: attaches the file to the agent's running session." }),
  renameButton: msg({ id: 'files.details.rename', defaultMessage: 'Rename', description: "Button in a file's details." }),
  // Attachments (#387)
  attachDeleteMessage: msg({ id: 'files.attachments.deleteMessage', defaultMessage: 'Move "{name}" to the Recycle Bin?', description: 'The confirmation before deleting an attachment. {name} is its file name.' }),
  attachDeleteDetail: msg({ id: 'files.attachments.deleteDetail', defaultMessage: 'The transcript will still mention its path.', description: 'Under the confirmation before deleting an attachment.' }),
  attachDeleteFailed: msg({ id: 'files.attachments.deleteFailed', defaultMessage: 'Could not delete the attachment', description: 'Title of an error notification.' }),
  groupDeleteTitle: msg({ id: 'files.attachments.groupDeleteTitle', defaultMessage: 'Move {count, plural, one {# attachment} other {# attachments}} to the Recycle Bin?', description: "Title of the confirmation before deleting all of a session's attachments." }),
  groupDeleteMessage: msg({ id: 'files.attachments.groupDeleteMessage', defaultMessage: 'Move {count, plural, one {the attachment} other {all # attachments}} of "{name}" to the Recycle Bin?', description: "The confirmation before deleting all of a session's attachments. {name} is the session's (or conversation's) name." }),
  groupDeleteDetail: msg({ id: 'files.attachments.groupDeleteDetail', defaultMessage: '{filtered, select, yes {All of its attachments go, whatever the filter shows. } other {}}{host, select, assistant {The conversation keeps its transcript, which still mentions their paths.} other {The session keeps its transcript, which still mentions their paths.}} You can restore them from the Recycle Bin.', description: "Under the confirmation before deleting a session's attachments. {filtered} is yes when a filter hides some of them; {host} is assistant for the Hive Assistant's conversations." }),
  groupDeleteFailed: msg({ id: 'files.attachments.groupDeleteFailed', defaultMessage: 'Could not delete the attachments', description: 'Title of an error notification.' }),
  groupDeleted: msg({ id: 'files.attachments.groupDeleted', defaultMessage: 'Moved {count, plural, one {# attachment} other {# attachments}} to the Recycle Bin.', description: "Notification after deleting a session's attachments." }),
  view: msg({ id: 'files.attachments.view', defaultMessage: 'View', description: "An attachment's right-click menu: opens it in the viewer." }),
  copyImage: msg({ id: 'files.attachments.copyImage', defaultMessage: 'Copy Image', description: "Menu item or button: copies the attachment's picture to the clipboard." }),
  copyImageFailed: msg({ id: 'files.attachments.copyImageFailed', defaultMessage: 'Could not copy image', description: 'Title of an error notification.' }),
  running: msg({ id: 'files.attachments.running', defaultMessage: '{host, select, assistant {Its conversation is running} other {Its session is running}}', description: "Why an attachment can't be deleted now. {host} is assistant for the Hive Assistant's conversations." }),
  loading: msg({ id: 'files.loading', defaultMessage: 'Loading…', description: 'Shown while the attachments (or one of them) load.' }),
  noneYet: msg({ id: 'files.attachments.none', defaultMessage: 'No attachments yet', description: 'The Attachments tab when there are none.' }),
  noneHintAssistant: msg({ id: 'files.attachments.noneHintAssistant', defaultMessage: "Paste a screenshot into the Assistant's panel with <kbd>Ctrl+V</kbd>, or drag files onto it: images, PDFs, logs, any file. Combwork keeps a copy of each one here, grouped by conversation.", description: "Under \"No attachments yet\" in the Hive Assistant's Attachments. <kbd> marks a key: keep it as it is." }),
  noneHint: msg({ id: 'files.attachments.noneHint', defaultMessage: 'Paste a screenshot into a session with <kbd>Ctrl+V</kbd>, or drag files onto the terminal: images, PDFs, logs, any file. Combwork keeps a copy of each one here, grouped by session.', description: 'Under "No attachments yet" in a project\'s Attachments tab. <kbd> marks a key: keep it as it is.' }),
  openTranscript: msg({ id: 'files.attachments.openTranscript', defaultMessage: "{host, select, assistant {Open this conversation's transcript} other {Open this session's transcript}}", description: "Tooltip on a session's name in the Attachments tab. {host} is assistant for the Hive Assistant's conversations." }),
  unnamedGroup: msg({ id: 'files.attachments.unnamed', defaultMessage: '{host, select, assistant {Conversation {id}} other {Session {id}}}', description: 'A session without a name, in the Attachments tab. {id} is the start of its id.' }),
  runningBadge: msg({ id: 'files.attachments.runningBadge', defaultMessage: 'Running', description: "Badge beside a session's name in the Attachments tab: it is running now." }),
  archivedBadge: msg({ id: 'files.attachments.archivedBadge', defaultMessage: 'archived', description: "Badge beside an archived session's name in the Attachments tab." }),
  groupSpan: msg({ id: 'files.attachments.groupSpan', defaultMessage: '{count, plural, one {# attachment} other {# attachments}} · {days, select, one {{from}} other {{from} – {to}}}', description: "Beside a session's name in the Attachments tab: how many, and the days they were added. {from} and {to} are days, such as \"9 Oct\", \"yesterday\" or \"today\"; {days} is one when they were all added on one day." }),
  groupDelete: msg({ id: 'files.attachments.groupDelete', defaultMessage: "{host, select, assistant {Delete This Conversation's Attachments…} other {Delete This Session's Attachments…}}", description: "Tooltip on a session's delete button in the Attachments tab." }),
  attachmentsLoadTarget: msg({ id: 'files.attachments.loadTarget', defaultMessage: 'the attachments', description: 'What could not be loaded when the Attachments tab first opened: shown in "Could not load {what}: {error}", with Retry.' }),
  attachmentsRefreshTarget: msg({ id: 'files.attachments.refreshTarget', defaultMessage: 'the attachments', description: 'What could not be refreshed while the attachments shown stay on screen: shown in "Could not refresh {what}; last updated …", with Retry.' }),
  attachments: msg({ id: 'files.attachments.title', defaultMessage: 'Attachments', description: 'Heading of the Attachments tab.' }),
  infoAssistant: msg({ id: 'files.attachments.infoAssistant', defaultMessage: "Kept in the Assistant's home, .combwork/attachments. Click a conversation's name to read it.", description: "The (i) beside the Hive Assistant's Attachments heading. Keep .combwork/attachments as it is." }),
  info: msg({ id: 'files.attachments.info', defaultMessage: "Kept in the project's .combwork/attachments. Drag one onto the Session tab to send it again; click a session's name to read it.", description: "The (i) beside a project's Attachments heading. Keep .combwork/attachments as it is." }),
  total: msg({ id: 'files.attachments.total', defaultMessage: '{host, select, assistant {{total, number} in {groups, plural, one {# conversation} other {# conversations}}} other {{total, number} in {groups, plural, one {# session} other {# sessions}}}}', description: 'Beside the Attachments heading: how many attachments, in how many sessions (conversations for the Hive Assistant).' }),
  openFolder: msg({ id: 'files.attachments.openFolder', defaultMessage: 'Open Attachments Folder', description: "Tooltip on the button that opens the attachments' folder in File Explorer." }),
  descAssistant: msg({ id: 'files.attachments.descAssistant', defaultMessage: 'Files pasted or dropped into the Assistant, by conversation.', description: "Under the Hive Assistant's Attachments heading." }),
  desc: msg({ id: 'files.attachments.desc', defaultMessage: "Files kept with this project's cards, and files pasted or dropped into its agents' sessions.", description: "Under a project's Attachments heading (HI-1700: cards' files, then sessions')." }),
  totalWithCards: msg({ id: 'files.attachments.totalWithCards', defaultMessage: '{total, plural, one {# file} other {# files}} · {cards, number} on cards, {sessions, number} in {groups, plural, one {# session} other {# sessions}}', description: "Beside a project's Attachments heading when its cards keep files too (HI-1700): how many files in all, how many on cards, and how many in how many sessions." }),
  sessionsKept: msg({ id: 'files.attachments.sessionsKept', defaultMessage: 'Kept with their session: Clean Up and Purge can remove them with it.', description: "Atop a project's Attachments tab's Pane attachments (HI-1700, HI-1841): the files pasted or dropped into sessions." }),
  tabs: msg({ id: 'files.attachments.tabs', defaultMessage: 'Attachments', description: "Accessible name of a project's Attachments tab's two tabs (HI-1841): Pane attachments and Card attachments." }),
  paneTab: msg({ id: 'files.attachments.paneTab', defaultMessage: 'Pane attachments', description: "A tab of a project's Attachments tab (HI-1841): the files pasted or dropped into its agents' panes (sessions), by conversation." }),
  cardTab: msg({ id: 'files.attachments.cardTab', defaultMessage: 'Card attachments', description: "A tab of a project's Attachments tab (HI-1841): the files kept with the project's cards, by card." }),
  paneEmpty: msg({ id: 'files.attachments.paneEmpty', defaultMessage: 'Nothing pasted or dropped into a pane yet.', description: "Pane attachments (a tab of a project's Attachments tab, HI-1841) with no files." }),
  cardEmpty: msg({ id: 'files.attachments.cardEmpty', defaultMessage: "No files kept with this project's cards yet. Paste or drop files into a card's description or a comment.", description: "Card attachments (a tab of a project's Attachments tab, HI-1841) with no files." }),
  cardFailed: msg({ id: 'files.attachments.cardFailed', defaultMessage: "The cards' attachments couldn't be read.", description: "Card attachments (a tab of a project's Attachments tab, HI-1841) when reading them failed." }),
  show: msg({ id: 'files.attachments.filters', defaultMessage: 'Show', description: "Accessible name of the Attachments tab's filter buttons (All, Images, PDFs…)." }),
  all: msg({ id: 'files.attachments.all', defaultMessage: 'All', description: 'Attachments filter: every kind. Followed by a count.' }),
  archivedHeading: msg({ id: 'files.attachments.archived', defaultMessage: '{host, select, assistant {Archived conversations} other {Archived sessions}}', description: "Heading over the archived sessions' attachments." }),
  images: msg({ id: 'files.attachments.kind.image', defaultMessage: 'Images', description: 'Attachments filter. Followed by a count.' }),
  pdfs: msg({ id: 'files.attachments.kind.pdf', defaultMessage: 'PDFs', description: 'Attachments filter. Followed by a count.' }),
  text: msg({ id: 'files.attachments.kind.text', defaultMessage: 'Text', description: 'Attachments filter: text files. Followed by a count.' }),
  other: msg({ id: 'files.attachments.kind.other', defaultMessage: 'Other', description: 'Attachments filter: any other kind of file. Followed by a count.' }),
  position: msg({ id: 'files.viewer.position', defaultMessage: '{index, number} of {count, number}', description: "The attachment viewer's footer: which attachment of how many is shown." }),
  newer: msg({ id: 'files.viewer.newer', defaultMessage: 'Newer (←)', description: "Tooltip on the attachment viewer's left arrow. Keep the arrow." }),
  older: msg({ id: 'files.viewer.older', defaultMessage: 'Older (→)', description: "Tooltip on the attachment viewer's right arrow. Keep the arrow." }),
  readFailed: msg({ id: 'files.viewer.readFailed', defaultMessage: "Couldn't read it: {error}", description: "The attachment viewer when the file can't be read. {error} is why (from Windows, may be English)." }),
  noPreview: msg({ id: 'files.viewer.noPreview', defaultMessage: 'No preview for this kind of file. Show it in its folder, or insert it into a session.', description: 'The attachment viewer for a file it cannot show. Show in Folder and Insert into Session are its buttons (the second only while an agent runs).' }),
  openInApp: msg({ id: 'files.viewer.openInApp', defaultMessage: 'Open in Its App', description: "A button in the attachment viewer (HI-1958), for an image or a PDF only: opens it in the program Windows opens that kind of file with (its photo viewer, its PDF reader), for zooming, printing and the like. Other kinds of file are never opened (nothing attached is ever run): they get Show in Folder instead." }),
  removeFromCard: msg({ id: 'files.viewer.removeFromCard', defaultMessage: 'Remove from Card', description: "A button in the attachment viewer for a card's attachment (HI-1958): takes the file off its card (to the Recycle Bin), after asking. A session's attachment has Delete there instead." }),
  tooLarge: msg({ id: 'files.viewer.tooLarge', defaultMessage: 'Too large to preview here. Reveal it to open it in another program.', description: 'The attachment viewer for a file too large to show.' })
}

/** Starts live file events for the project while mounted and calls onChange with the changed folders. */
function useFileEvents(projectPath: string, onChange: (dirs: string[]) => void): void {
  const ref = useRef(onChange)
  ref.current = onChange
  useEffect(() => {
    // Live updates only: without a watch the tree still loads, and Refresh reads it again.
    void call('files:watch', projectPath).catch(() => undefined)
    const listener = (p: string, dirs: string[]): void => {
      if (p.toLowerCase() === projectPath.toLowerCase()) ref.current(dirs)
    }
    filesListeners.add(listener)
    return () => {
      filesListeners.delete(listener)
      void call('files:unwatch', projectPath).catch(() => undefined)
    }
  }, [projectPath])
}

/**
 * Attaches files to the project's running session (#387), as dropping them on its terminal does, and switches to it.
 */
async function insertIntoSession(project: ProjectInfo, paths: string[]): Promise<void> {
  const t = sessionTarget(project)
  const agentId = t.agentId
  if (!project.live || !agentId) return
  const key = projectKey(t.path, agentId)
  const text = await attachFiles(t.path, agentId, paths, key)
  if (!text) return
  setProjectTab(t.path, 'session')
  const owner = get().workspace?.projects.find((x) => x.path === t.path)
  if (owner) showAgent(owner, agentId)
  // A real paste, so Claude Code attaches image paths instead of treating them as typed text.
  if (!pasteIntoTerminal(key, text)) await call('pty:write', key, text)
}

/**
 * A project as a tab sees it: the folder shown (the project folder, or the folder an agent works in: its slot, home or
 * 0.9 worktree, #1442) and, as `live`, the session that Insert into Session pastes into — that folder's agent, else the
 * focused agent if it works in the project folder, else the first agent (none in a project without agents).
 */
type ViewProject = ProjectInfo & { target?: { path: string; agentId: string | null } }

function sessionTarget(p: ViewProject): { path: string; agentId: string | null } {
  return p.target ?? { path: p.path, agentId: null }
}

export function projectView(project: ProjectInfo, rootAgent?: string): ViewProject {
  const away = project.agents.find((a) => a.id === rootAgent && awayFromProject(a))
  if (away) return { ...project, path: agentFolder(away), branch: away.place.branch ?? project.branch, live: away.live, target: { path: project.path, agentId: away.id } }
  const focused = project.agents.find((a) => a.id === focusedAgentId(project))
  const agent = focused && !awayFromProject(focused) ? focused : project.agents[0]
  return { ...project, live: agent?.live ?? null, target: { path: project.path, agentId: agent?.id ?? null } }
}

/** Picks whose folder the Files tab shows when agents work outside the project folder (#1442). Renders nothing otherwise. */
export function RootSelector({ project, value, onChange }: { project: ProjectInfo; value: string | undefined; onChange: (agentId: string) => void }) {
  const worktrees = project.agents.filter((a) => awayFromProject(a))
  if (!worktrees.length) return null
  const known = worktrees.some((a) => a.id === value)
  return (
    <div className="root-row">
      <Tooltip content={tr(M.rootTip)}>
        <select className="select root-select" value={known ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{tr(M.projectFolder)}</option>
          {worktrees.map((a) => (
            <option key={a.id} value={a.id}>
              {legacyOf(a) ? tr(M.agentWorktree, { agent: a.name, branch: legacyOf(a)!.branch }) : tr(M.agentPlace, { agent: a.name, place: placeText(a.place) ?? '' })}
            </option>
          ))}
        </select>
      </Tooltip>
    </div>
  )
}

export function FilesTab({ project }: { project: ProjectInfo }) {
  const root = useStore((s) => s.filesRoot[project.path])
  useStore((s) => s.focusedAgent[project.path])
  const view = projectView(project, root)
  // A file to show (a terminal's file link), once the folder it's in is the one shown.
  const shown = view.path === project.path ? '' : root
  const jump = useStore((s) => (s.filesJump?.project === project.path && s.filesJump.root === shown ? s.filesJump : null))
  const selector = <RootSelector project={project} value={root} onChange={(id) => set((s) => ({ filesRoot: { ...s.filesRoot, [project.path]: id } }))} />
  return <FilesBrowser key={view.path} project={view} selector={selector} jump={jump} />
}

type Goto = { rel: string; line?: number; col?: number; nonce: number }

const copyText = (text: string): void => void navigator.clipboard.writeText(text)

function fileIcon(e: FileEntry, open: boolean): string {
  return e.isDir ? (open ? 'folder-opened' : 'folder') : fileNameIcon(e.name)
}

/** A file's icon by its name: its type's, or a plain file's. */
function fileNameIcon(name: string): string {
  const n = name.toLowerCase()
  if (IMAGE_EXT.test(n) || /\.(svg|ico)$/.test(n)) return 'file-media'
  if (n.endsWith('.md')) return 'markdown'
  if (n.endsWith('.json')) return 'json'
  if (/\.(zip|7z|gz|tar|rar)$/.test(n)) return 'file-zip'
  if (/\.(pdf)$/.test(n)) return 'file-pdf'
  if (/\.(txt|log)$/.test(n)) return 'file-text'
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|cs|go|rs|java|c|cpp|h|css|scss|html|sh|ps1|yml|yaml|toml|xml|sql)$/.test(n)) return 'file-code'
  return 'file'
}

// Cut/copy between tabs and projects. Paste into another project always copies.
let fileClipboard: { mode: 'copy' | 'cut'; project: string; rels: string[] } | null = null

type Editing = { kind: 'new-file' | 'new-folder'; parent: string } | { kind: 'rename'; rel: string }
type Row = { entry: FileEntry; depth: number } | { edit: true; depth: number; isDir: boolean }

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function FilesBrowser({ project, selector, jump }: { project: ProjectInfo; selector: React.ReactNode; jump: Goto | null }) {
  const listWidth = usePaneSize('files', 360)
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelectedState] = useState<string[]>([])
  // An action that ends late (a slow paste, rename or new file) selects what it made only if the selection hasn't
  // changed since it started: a row the user clicked meanwhile keeps it, so the next key acts on that row (#641).
  // Counted when each change is made, not when it renders: a drag selects its row at dragstart, which may not have
  // rendered by the drop.
  const selectionSeq = useRef(0)
  const setSelected = (next: React.SetStateAction<string[]>): void => {
    selectionSeq.current++
    setSelectedState(next)
  }
  const unchangedSelection = (): (() => boolean) => {
    const before = selectionSeq.current
    return () => selectionSeq.current === before
  }
  const [anchor, setAnchor] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [filter, setFilter] = useState('')
  // The filter searches the whole folder by path. Its matches belong to the folder and the filter: never shown for
  // another. A failed search is said, with Retry, rather than "No files match".
  const q = filter.trim()
  const filtering = !!q
  const findKey = filtering ? JSON.stringify([project.path, q]) : ''
  const find = useScopedLoad<FileEntry[]>(findKey)
  const results = filtering ? find.data : null
  const findError = filtering ? find.error : null
  const [findTry, setFindTry] = useState(0)
  const [git, setGit] = useState<Record<string, string>>({})
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [, setClipVersion] = useState(0)
  useDraftVersion()
  const treeRef = useRef<HTMLDivElement>(null)
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const menu = useContextMenu()
  const hoverTimer = useRef<number | undefined>(undefined)

  const loadDir = useCallback(
    async (rel: string): Promise<void> => {
      try {
        const entries = await call('files:list', project.path, rel)
        setDirs((d) => ({ ...d, [rel]: entries }))
      } catch {
        // The folder is gone: forget it and everything below it.
        setDirs((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !isUnder(k, rel) || rel === '')))
        setExpanded((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !isUnder(k, rel))))
      }
    },
    [project.path]
  )

  const loadGit = useCallback(() => {
    void call('git:status', project.path)
      .then((s) => {
        const map: Record<string, string> = {}
        for (const f of s.files) {
          if (f.status === 'D') continue
          const st = f.status === '?' ? 'U' : f.status
          map[f.path] = st
          // Folders take the colour of the first change inside them, modified winning over new.
          for (let p = parentOf(f.path); p; p = parentOf(p)) if (!map[p] || st === 'M') map[p] = st
        }
        setGit(map)
      })
      // Only the tree's change colours: without git's status the files are still all there.
      .catch(() => setGit({}))
  }, [project.path])

  const reloadAll = useCallback(() => {
    for (const rel of Object.keys(dirsRef.current)) void loadDir(rel)
    if (!dirsRef.current['']) void loadDir('')
    loadGit()
  }, [loadDir, loadGit])

  useEffect(() => {
    setDirs({})
    setExpanded({})
    selectionSeq.current++
    setSelectedState([])
    void loadDir('')
    loadGit()
  }, [project.path, loadDir, loadGit])

  const gitTimer = useRef<number | undefined>(undefined)
  // Per-folder change counters, so the open file can notice it changed on disk.
  const [dirTicks, setDirTicks] = useState<Record<string, number>>({})
  useFileEvents(project.path, (changed) => {
    setDirTicks((t) => Object.fromEntries([...Object.entries(t), ...changed.map((d) => [d, (t[d] ?? 0) + 1])]))
    for (const d of changed) if (dirsRef.current[d]) void loadDir(d)
    window.clearTimeout(gitTimer.current)
    gitTimer.current = window.setTimeout(loadGit, 400)
  })

  const { load: loadFind } = find
  useEffect(() => {
    if (!findKey) return
    const path = project.path
    const t = window.setTimeout(() => loadFind(findKey, () => call('files:find', path, q)), 180)
    return () => window.clearTimeout(t)
    // The key holds the folder and the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findKey, findTry, loadFind])

  const rows = useMemo<Row[]>(() => {
    // Filtering: the matches, none while they're found.
    if (filtering) return (results ?? []).map((entry) => ({ entry, depth: 0 }))
    const out: Row[] = []
    const walk = (rel: string, depth: number): void => {
      if (editing && editing.kind !== 'rename' && editing.parent === rel) out.push({ edit: true, depth, isDir: editing.kind === 'new-folder' })
      for (const entry of dirs[rel] ?? []) {
        out.push({ entry, depth })
        if (entry.isDir && expanded[entry.relPath]) walk(entry.relPath, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [dirs, expanded, editing, filtering, results])

  const entries = useMemo(() => rows.flatMap((r) => ('entry' in r ? [r.entry] : [])), [rows])
  const byRel = useMemo(() => new Map(entries.map((e) => [e.relPath, e])), [entries])
  const selEntries = selected.map((r) => byRel.get(r)).filter((e): e is FileEntry => !!e)
  const focus = selected[selected.length - 1] ?? null

  const expand = (rel: string, open = true): void => {
    setExpanded((x) => ({ ...x, [rel]: open }))
    if (open && !dirsRef.current[rel]) void loadDir(rel)
  }

  /** Folder that new files and pastes go into: the selected folder, or the selected file's folder. */
  const targetDir = (): string => {
    const e = focus ? byRel.get(focus) : null
    if (!e) return ''
    return e.isDir ? e.relPath : parentOf(e.relPath)
  }

  const select = (rel: string, e?: React.MouseEvent | React.KeyboardEvent): void => {
    if (e?.shiftKey && anchor) {
      const a = entries.findIndex((x) => x.relPath === anchor)
      const b = entries.findIndex((x) => x.relPath === rel)
      if (a >= 0 && b >= 0) {
        const range = entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.relPath)
        // Keep the clicked row last so it is the focus.
        setSelected([...range.filter((r) => r !== rel), rel])
        return
      }
    }
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelected((s) => (s.includes(rel) ? s.filter((r) => r !== rel) : [...s, rel]))
      setAnchor(rel)
      return
    }
    setSelected([rel])
    setAnchor(rel)
  }

  // The row to scroll to once it's in the tree (its folders may still be loading).
  const scrollTo = useRef<string | null>(null)
  const scrollToRow = (): void => {
    const rel = scrollTo.current
    const row = rel !== null ? treeRef.current?.querySelector(`[data-rel="${CSS.escape(rel)}"]`) : null
    if (!row) return
    scrollTo.current = null
    row.scrollIntoView({ block: 'nearest' })
  }
  const reveal = (rel: string): void => {
    for (let p = parentOf(rel); p; p = parentOf(p)) expand(p)
    setSelected([rel])
    setAnchor(rel)
    scrollTo.current = rel
    window.setTimeout(scrollToRow, 50)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(scrollToRow, [rows])

  // A terminal's file link: show the file, then go to its line.
  const [goto, setGoto] = useState<Goto | null>(null)
  useEffect(() => {
    if (!jump) return
    setFilter('')
    reveal(jump.rel)
    setGoto(jump)
    set({ filesJump: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce])

  const startNew = (isDir: boolean, parent = targetDir()): void => {
    setFilter('')
    if (parent) expand(parent)
    setEditing({ kind: isDir ? 'new-folder' : 'new-file', parent })
  }

  const commitEdit = async (value: string): Promise<void> => {
    const ed = editing
    const unchanged = unchangedSelection()
    setEditing(null)
    if (!ed || !value.trim()) return
    if (ed.kind === 'rename') {
      const old = byRel.get(ed.rel)
      if (!old || value.trim() === old.name) return
      const rel = await actions.attempt(tr(M.couldNotRename), () => call('files:rename', project.path, ed.rel, value))
      if (rel) {
        moveDrafts(project.path, ed.rel, rel)
        await loadDir(parentOf(ed.rel))
        if (old.isDir) {
          // Carry expanded state over to the new name.
          setExpanded((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [isUnder(k, ed.rel) ? rel + k.slice(ed.rel.length) : k, v])))
          setDirs((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !isUnder(k, ed.rel))))
          if (expanded[ed.rel]) void loadDir(rel)
        }
        if (unchanged()) reveal(rel)
      }
      return
    }
    const rel = await actions.attempt(tr(ed.kind === 'new-folder' ? M.couldNotCreateFolder : M.couldNotCreateFile), () =>
      call('files:create', project.path, ed.parent, value, ed.kind === 'new-folder')
    )
    if (rel) {
      // "a/b/file.txt" also creates the folders in between: open and refresh each of them.
      const chain: string[] = []
      for (let p = parentOf(rel); p && p !== ed.parent; p = parentOf(p)) chain.unshift(p)
      await loadDir(ed.parent)
      for (const p of chain) {
        setExpanded((x) => ({ ...x, [p]: true }))
        await loadDir(p)
      }
      if (unchanged()) reveal(rel)
    }
  }

  const trashSelected = async (items = selEntries): Promise<void> => {
    if (!items.length) return
    const rels = items.map((i) => i.relPath)
    const dirty = draftsUnder(project.path, rels)
    const ok = await confirm({
      title: tr(M.trashTitle),
      message: tr(M.trashMessage, { count: items.length, name: items[0].name, folder: items[0].isDir ? 'yes' : 'no' }),
      detail: tr(M.trashDetail, { unsaved: dirty.length, file: dirty[0] ?? '' }),
      confirmLabel: tr(M.trashButton),
      danger: true
    })
    if (!ok) return
    const unchanged = unchangedSelection()
    const done = await actions.attempt(tr(M.couldNotDelete), () => call('files:trash', project.path, rels).then(() => true))
    if (done) discardDrafts(project.path, rels)
    if (unchanged()) setSelected([])
    for (const d of new Set(items.map((i) => parentOf(i.relPath)))) void loadDir(d)
    loadGit()
  }

  const setClipboard = (mode: 'copy' | 'cut', items = selEntries): void => {
    if (!items.length) return
    fileClipboard = { mode, project: project.path, rels: items.map((i) => i.relPath) }
    setClipVersion((v) => v + 1)
  }

  const paste = async (dest = targetDir()): Promise<void> => {
    const clip = fileClipboard
    if (!clip) return
    const unchanged = unchangedSelection()
    let out: string[] | undefined
    if (clip.project !== project.path) {
      const sources = clip.rels.map((r) => `${clip.project}\\${r.replace(/\//g, '\\')}`)
      out = await actions.attempt(tr(M.couldNotPaste), () => call('files:import', project.path, sources, dest))
    } else if (clip.mode === 'cut') {
      out = await actions.attempt(tr(M.couldNotMove), () => call('files:move', project.path, clip.rels, dest))
      if (out) {
        clip.rels.forEach((r, i) => moveDrafts(project.path, r, out![i]))
        for (const d of new Set(clip.rels.map(parentOf))) void loadDir(d)
      }
    } else {
      out = await actions.attempt(tr(M.couldNotCopy), () => call('files:copy', project.path, clip.rels, dest))
    }
    if (clip.mode === 'cut') fileClipboard = null
    setClipVersion((v) => v + 1)
    if (dest) expand(dest)
    await loadDir(dest)
    loadGit()
    if (out?.length && unchanged()) setSelected(out)
  }

  const duplicate = async (items = selEntries): Promise<void> => {
    const unchanged = unchangedSelection()
    const created: string[] = []
    const byDir = new Map<string, string[]>()
    for (const i of items) byDir.set(parentOf(i.relPath), [...(byDir.get(parentOf(i.relPath)) ?? []), i.relPath])
    for (const [dir, rels] of byDir) {
      const out = await actions.attempt(tr(M.couldNotDuplicate), () => call('files:copy', project.path, rels, dir))
      if (out) created.push(...out)
      await loadDir(dir)
    }
    if (created.length && unchanged()) setSelected(created)
  }

  const open = (e: FileEntry): void => {
    if (e.isDir) expand(e.relPath, !expanded[e.relPath])
    else openExternally(e.relPath)
  }
  const openExternally = (rel: string): void => void actions.attempt(tr(FILES_TEXT.openFailed), () => call('files:open', project.path, rel))

  const menuFor = (e: FileEntry | null): MenuEntry[] => {
    const items = e ? (selected.includes(e.relPath) ? selEntries : [e]) : []
    const dest = e ? (e.isDir ? e.relPath : parentOf(e.relPath)) : ''
    const abs = items.map((i) => absOf(project, i.relPath))
    const pasteItem: MenuEntry = { label: tr(M.paste), icon: 'clippy', keybinding: formatKeybinding('Ctrl+V'), disabled: !fileClipboard, onClick: () => void paste(dest) }
    if (!e) {
      return [
        { label: tr(M.newFile), icon: 'new-file', onClick: () => startNew(false, '') },
        { label: tr(M.newFolder), icon: 'new-folder', onClick: () => startNew(true, '') },
        { separator: true },
        pasteItem,
        { separator: true },
        { label: tr(FILES_TEXT.revealInExplorer), icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
        { label: tr(M.refresh), icon: 'refresh', onClick: reloadAll }
      ]
    }
    const single = items.length === 1
    return [
      ...(e.isDir && single
        ? [
            { label: tr(M.newFile), icon: 'new-file', onClick: () => startNew(false, e.relPath) },
            { label: tr(M.newFolder), icon: 'new-folder', onClick: () => startNew(true, e.relPath) },
            { separator: true }
          ]
        : []),
      ...(!e.isDir && single ? [{ label: tr(M.openInDefaultApp), icon: 'link-external', onClick: () => open(e) }] : []),
      { label: tr(FILES_TEXT.revealInExplorer), icon: 'folder-opened', onClick: () => void call('files:reveal', project.path, e.relPath) },
      ...(project.live ? [{ label: tr(M.insertPath), icon: 'terminal', onClick: () => void insertIntoSession(project, abs) }] : []),
      { separator: true },
      { label: tr(M.cut), icon: 'blank', keybinding: formatKeybinding('Ctrl+X'), onClick: () => setClipboard('cut', items) },
      { label: tr(M.copy), icon: 'copy', keybinding: formatKeybinding('Ctrl+C'), onClick: () => setClipboard('copy', items) },
      pasteItem,
      { label: tr(M.duplicate), icon: 'files', onClick: () => void duplicate(items) },
      { separator: true },
      { label: tr(M.copyPath), icon: 'blank', keybinding: formatKeybinding('Shift+Alt+C'), onClick: () => copyText(abs.join('\n')) },
      { label: tr(M.copyRelativePath), icon: 'blank', onClick: () => copyText(items.map((i) => i.relPath).join('\n')) },
      { separator: true },
      ...(single ? [{ label: tr(M.rename), icon: 'tag', keybinding: 'F2', onClick: () => setEditing({ kind: 'rename', rel: e.relPath }) }] : []),
      { label: tr(M.delete), icon: 'trash', keybinding: formatKeybinding('Del'), danger: true, onClick: () => void trashSelected(items) } // i18n-ignore: a key's id, which formatKeybinding names
    ]
  }

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (editing || (ev.target as HTMLElement).tagName === 'INPUT') return
    const mod = ev.ctrlKey || ev.metaKey
    const idx = focus ? entries.findIndex((x) => x.relPath === focus) : -1
    const cur = idx >= 0 ? entries[idx] : null
    const moveTo = (i: number): void => {
      const t = entries[Math.max(0, Math.min(entries.length - 1, i))]
      if (!t) return
      select(t.relPath, ev.shiftKey ? ev : undefined)
      treeRef.current?.querySelector(`[data-rel="${CSS.escape(t.relPath)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    let handled = true
    if (ev.key === 'ArrowDown') moveTo(idx + 1)
    else if (ev.key === 'ArrowUp') moveTo(idx < 0 ? 0 : idx - 1)
    else if (ev.key === 'Home') moveTo(0)
    else if (ev.key === 'End') moveTo(entries.length - 1)
    else if (ev.key === 'ArrowRight' && cur?.isDir && !filtering) {
      if (!expanded[cur.relPath]) expand(cur.relPath)
      else moveTo(idx + 1)
    } else if (ev.key === 'ArrowLeft' && cur && !filtering) {
      if (cur.isDir && expanded[cur.relPath]) expand(cur.relPath, false)
      else if (parentOf(cur.relPath)) select(parentOf(cur.relPath))
    } else if (ev.key === 'Enter' && cur?.isDir) open(cur)
    else if (ev.key === 'F2' && cur) setEditing({ kind: 'rename', rel: cur.relPath })
    else if (ev.key === 'Delete') void trashSelected()
    else if (mod && ev.key.toLowerCase() === 'c' && !ev.shiftKey) setClipboard('copy')
    else if (mod && ev.key.toLowerCase() === 'x') setClipboard('cut')
    else if (mod && ev.key.toLowerCase() === 'v') void paste()
    else if (mod && ev.key.toLowerCase() === 'a') setSelected(entries.map((x) => x.relPath))
    else if (ev.shiftKey && ev.altKey && ev.key.toLowerCase() === 'c') copyText(selEntries.map((x) => absOf(project, x.relPath)).join('\n'))
    else if (ev.key === 'Escape') {
      if (fileClipboard?.mode === 'cut') {
        fileClipboard = null
        setClipVersion((v) => v + 1)
      } else setSelected([])
    } else handled = false
    if (handled) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

  // ---- drag and drop ----
  const onDragStart = (ev: React.DragEvent, e: FileEntry): void => {
    const items = selected.includes(e.relPath) ? selEntries : [e]
    if (!selected.includes(e.relPath)) setSelected([e.relPath])
    const paths = items.map((i) => absOf(project, i.relPath))
    ev.dataTransfer.setData(FILES_MIME, JSON.stringify({ project: project.path, rels: items.map((i) => i.relPath), paths }))
    ev.dataTransfer.setData('text/plain', paths.map(quotePath).join(' '))
    ev.dataTransfer.effectAllowed = 'copyMove'
  }

  const dragOverDir = (ev: React.DragEvent, dir: string): void => {
    const dt = ev.dataTransfer
    const internal = dt.types.includes(FILES_MIME)
    if (!internal && !dt.types.includes('Files')) return
    ev.preventDefault()
    ev.stopPropagation()
    dt.dropEffect = internal && !ev.ctrlKey ? 'move' : 'copy'
    if (dropTarget !== dir) {
      setDropTarget(dir)
      // Hovering over a closed folder opens it, like Explorer.
      window.clearTimeout(hoverTimer.current)
      if (dir && !expanded[dir]) hoverTimer.current = window.setTimeout(() => expand(dir), 700)
    }
  }

  const dropOn = async (ev: React.DragEvent, dir: string): Promise<void> => {
    ev.preventDefault()
    ev.stopPropagation()
    setDropTarget(null)
    window.clearTimeout(hoverTimer.current)
    const unchanged = unchangedSelection()
    const internal = ev.dataTransfer.getData(FILES_MIME)
    let out: string[] | undefined
    if (internal) {
      const data = JSON.parse(internal) as { project: string; rels?: string[]; paths: string[] }
      if (data.project === project.path && data.rels && !ev.ctrlKey) {
        out = await actions.attempt(tr(M.couldNotMove), () => call('files:move', project.path, data.rels!, dir))
        if (out) {
          data.rels.forEach((r, i) => moveDrafts(project.path, r, out![i]))
          for (const d of new Set(data.rels.map(parentOf))) void loadDir(d)
        }
      } else if (data.project === project.path && data.rels) {
        out = await actions.attempt(tr(M.couldNotCopy), () => call('files:copy', project.path, data.rels!, dir))
      } else out = await actions.attempt(tr(M.couldNotCopy), () => call('files:import', project.path, data.paths, dir))
    } else {
      const sources = [...ev.dataTransfer.files].map((f) => window.combwork.pathForFile(f)).filter(Boolean)
      if (sources.length) out = await actions.attempt(tr(M.couldNotCopyIn), () => call('files:import', project.path, sources, dir))
    }
    if (dir) expand(dir)
    await loadDir(dir)
    loadGit()
    if (out?.length && unchanged()) setSelected(out)
  }

  const cutSet = fileClipboard?.mode === 'cut' && fileClipboard.project === project.path ? new Set(fileClipboard.rels) : null
  const one = selEntries.length === 1 ? selEntries[0] : null

  return (
    <div className="split">
      <div className="split-list files-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="files" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(M.files)}
          <InfoTip text={tr(M.filesInfo)} />
          <div className="actions">
            <IconButton icon="new-file" title={tr(M.newFile)} onClick={() => startNew(false)} />
            <IconButton icon="new-folder" title={tr(M.newFolder)} onClick={() => startNew(true)} />
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={reloadAll} />
            <IconButton icon="collapse-all" title={tr(M.collapseAll)} onClick={() => setExpanded({})} />
          </div>
        </div>
        {selector}
        <div className="files-filter">
          <Icon name="search" />
          <SearchInput
            placeholder={tr(M.findPlaceholder)}
            value={filter}
            onChange={setFilter}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                treeRef.current?.focus()
                if (entries[0]) select(entries[0].relPath)
              }
            }}
          />
          {filter && <IconButton icon="close" title={tr(M.clear)} onClick={() => setFilter('')} />}
        </div>
        <div
          // i18n-ignore: class names
          className={cx('pane-body file-tree', dropTarget === '' && 'drop-root')}
          tabIndex={0}
          ref={treeRef}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => menu.open(e, menuFor(null))}
          onClick={(e) => e.target === e.currentTarget && setSelected([])}
          onDragOver={(e) => dragOverDir(e, '')}
          onDragLeave={(e) => e.currentTarget === e.target && setDropTarget(null)}
          onDrop={(e) => void dropOn(e, '')}
        >
          {findError && <LoadFailed inline what={tr(M.findLoadTarget)} error={findError} onRetry={() => setFindTry((n) => n + 1)} />}
          {filtering && !results && !findError && (
            <div className="pane-empty">
              <Icon name="loading" spin /> {tr(M.searching)}
            </div>
          )}
          {results && results.length === 0 && !findError && <div className="pane-empty">{tr(M.noMatch, { filter })}</div>}
          {!filtering && dirs[''] && dirs[''].length === 0 && !editing && <div className="pane-empty">{tr(M.folderEmpty)}</div>}
          {rows.map((r, i) =>
            'edit' in r ? (
              <NameInput key={`edit-${i}`} depth={r.depth} icon={r.isDir ? 'folder' : 'file'} initial="" onDone={(v) => void commitEdit(v)} />
            ) : editing?.kind === 'rename' && editing.rel === r.entry.relPath ? (
              <NameInput key={r.entry.relPath} depth={r.depth} icon={fileIcon(r.entry, false)} initial={r.entry.name} onDone={(v) => void commitEdit(v)} />
            ) : (
              <FileRow
                key={r.entry.relPath}
                entry={r.entry}
                depth={r.depth}
                flat={filtering}
                open={!!expanded[r.entry.relPath]}
                selected={selected.includes(r.entry.relPath)}
                git={git[r.entry.relPath]}
                cut={!!cutSet?.has(r.entry.relPath)}
                dropTarget={dropTarget === r.entry.relPath}
                onClick={(ev) => {
                  select(r.entry.relPath, ev)
                  if (r.entry.isDir && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey) expand(r.entry.relPath, !expanded[r.entry.relPath])
                }}
                hasDraft={!r.entry.isDir && hasDraft(absOf(project, r.entry.relPath))}
                onContextMenu={(ev) => {
                  if (!selected.includes(r.entry.relPath)) setSelected([r.entry.relPath])
                  menu.open(ev, menuFor(r.entry))
                }}
                onDragStart={(ev) => onDragStart(ev, r.entry)}
                onDragOver={(ev) => dragOverDir(ev, r.entry.isDir ? r.entry.relPath : parentOf(r.entry.relPath))}
                onDrop={(ev) => void dropOn(ev, r.entry.isDir ? r.entry.relPath : parentOf(r.entry.relPath))}
              />
            )
          )}
        </div>
      </div>
      <div className="split-main">
        {one && !one.isDir ? (
          <FileView
            // A fresh instance per file, so no state (text, drafts, mode) leaks from one file to the next.
            key={`${project.path}:${one.relPath}`}
            project={project}
            rel={one.relPath}
            changeTick={dirTicks[parentOf(one.relPath)] ?? 0}
            onOpenRel={reveal}
            goto={goto?.rel === one.relPath && goto.line ? { line: goto.line, col: goto.col, nonce: goto.nonce } : undefined}
            toolbarExtra={
              <>
                <IconButton icon="link-external" title={tr(M.openInDefaultApp)} onClick={() => openExternally(one.relPath)} />
                <IconButton icon="folder-opened" title={tr(FILES_TEXT.revealInExplorer)} onClick={() => void call('files:reveal', project.path, one.relPath)} />
                {project.live && <IconButton icon="terminal" title={tr(M.insertPath)} onClick={() => void insertIntoSession(project, [absOf(project, one.relPath)])} />}
              </>
            }
          />
        ) : (
          <FileDetails project={project} entry={one} count={selEntries.length} git={one ? git[one.relPath] : undefined} onOpen={open} onRename={(e) => setEditing({ kind: 'rename', rel: e.relPath })} onDelete={() => void trashSelected()} />
        )}
      </div>
      {menu.element}
    </div>
  )
}

function FileRow(props: {
  entry: FileEntry
  depth: number
  flat: boolean
  open: boolean
  selected: boolean
  git?: string
  cut: boolean
  dropTarget: boolean
  hasDraft: boolean
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}) {
  const { entry: e, depth, flat, open, git } = props
  return (
    <div
      data-rel={e.relPath}
      className={cx('row', 'file-row', props.selected && 'selected', props.cut && 'cut', e.ignored && 'ignored', props.dropTarget && e.isDir && 'drop-target')}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={e.relPath}
      draggable
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      {e.isDir && !flat ? <Icon name={open ? 'chevron-down' : 'chevron-right'} className="twistie" /> : <span className="twistie" />}
      <Icon name={fileIcon(e, open)} className={cx('file-icon', e.isDir && 'dir')} />
      <span className={cx('label', git && `git-${git}`)}>{e.name}</span>
      {props.hasDraft && <span className="dirty-dot" title={tr(FILES_TEXT.unsaved)}>●</span>}
      {flat && <span className="desc">{parentOf(e.relPath)}</span>}
      {git && !e.isDir && <span className={cx('git-status', git)}>{git}</span>}
      {git && e.isDir && <span className={cx('git-dot', `git-${git}`)} />}
    </div>
  )
}

/** Inline name box for new files/folders and rename. Enter or blur commits, Esc cancels. */
function NameInput({ depth, icon, initial, onDone }: { depth: number; icon: string; initial: string; onDone: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the name without its extension, like VS Code.
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  const finish = (v: string): void => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <div className="row file-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="twistie" />
      <Icon name={icon} className="file-icon" />
      <input
        ref={ref}
        className="input inline-name"
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(e.currentTarget.value)
          if (e.key === 'Escape') finish(initial ? initial : '')
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

function FileDetails({
  project,
  entry,
  count,
  git,
  onOpen,
  onRename,
  onDelete
}: {
  project: ProjectInfo
  entry: FileEntry | null
  count: number
  git?: string
  onOpen: (e: FileEntry) => void
  onRename: (e: FileEntry) => void
  onDelete: () => void
}) {
  useDateStyle()
  if (count > 1) {
    return (
      <div className="empty-state">
        <Icon name="files" />
        {tr(M.itemsSelected, { count })}
        <p className="hint">{tr(M.itemsHint)}</p>
      </div>
    )
  }
  if (!entry) {
    return (
      <div className="empty-state">
        <Icon name="files" />
        {tr(M.selectSomething)}
        <p className="hint">{rich(M.selectHint, { kbd })}</p>
      </div>
    )
  }
  const abs = absOf(project, entry.relPath)
  return (
    <div className="file-details">
      <div className="file-details-head">
        <Icon name={fileIcon(entry, false)} />
        <div style={{ minWidth: 0 }}>
          <h2>{entry.name}</h2>
          <div className="faint path">{entry.relPath}</div>
        </div>
      </div>
      <table className="kv">
        <tbody>
          <tr><td>{tr(M.type)}</td><td>{entry.isDir ? tr(M.folder) : entry.name.includes('.') ? tr(M.extFile, { ext: entry.name.split('.').pop()!.toUpperCase() }) : tr(M.file)}</td></tr>
          {!entry.isDir && <tr><td>{tr(M.size)}</td><td>{formatBytes(entry.size)}</td></tr>}
          {entry.modified && <tr><td>{tr(M.modified)}</td><td>{rich(M.modifiedAt, { when: formatDateTime(entry.modified), ago: timeAgo(entry.modified), faint })}</td></tr>}
          {git && <tr><td>{tr(M.git)}</td><td><span className={cx('git-status', git)}>{git}</span> {entry.isDir ? tr(M.gitInFolder, { status: tr(M.gitStatus, { status: git }) }) : tr(M.gitStatus, { status: git })}</td></tr>}
          {entry.ignored && <tr><td>{tr(M.git)}</td><td className="faint">{tr(M.ignored)}</td></tr>}
        </tbody>
      </table>
      <div className="btns">
        {!entry.isDir && (
          <button className="btn primary" onClick={() => onOpen(entry)}>
            <Icon name="link-external" /> {tr(FILES_TEXT.open)}
          </button>
        )}
        <button className="btn subtle" onClick={() => void call('files:reveal', project.path, entry.relPath)}>
          <Icon name="folder-opened" /> {tr(FILES_TEXT.reveal)}
        </button>
        {project.live && (
          <button className="btn subtle" onClick={() => void insertIntoSession(project, [abs])}>
            <Icon name="terminal" /> {tr(M.insertIntoSession)}
          </button>
        )}
      </div>
      <div className="btns">
        <button className="btn subtle" onClick={() => onRename(entry)}>
          <Icon name="tag" /> {tr(M.renameButton)}
        </button>
        <button className="btn subtle danger-text" onClick={onDelete}>
          <Icon name="trash" /> {tr(M.delete)}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachments (#387)
// ---------------------------------------------------------------------------

const attachmentTime = (a: SessionAttachment): string => formatDateTime(a.modified)

/** A day in a group's span: "today", "yesterday", or "9 Oct". */
const spanDay = (t: number): string => {
  const ago = daysAgo(t)
  return ago === 0 || ago === 1 ? fmt.day(-ago) : formatShortDay(t)
}
const dayKey = (iso: string): string => new Date(iso).toDateString()

/**
 * A project's Attachments tab, and the Hive Assistant's Attachments (`assistant`: its home's .combwork/attachments, grouped by
 * conversation): what was pasted or dropped into sessions, with filters by kind. Clicking a group's name opens that
 * session's transcript.
 */
/** The Attachments tab's two tabs (HI-1841): what was pasted or dropped into panes, and what is kept with cards. */
type AttachTab = 'pane' | 'card'
const ATTACH_TABS: AttachTab[] = ['pane', 'card']
const ATTACH_TABS_KEY = 'attachments'
const NO_KINDS: Record<AttachTab, AttachmentKind | null> = { pane: null, card: null }

/** How many of each kind a list of groups has: a filter is offered for each kind present. */
const kindCounts = (groups: { attachments: { kind: AttachmentKind }[] }[]): Map<AttachmentKind, number> => {
  const c = new Map<AttachmentKind, number>()
  for (const g of groups) for (const a of g.attachments) c.set(a.kind, (c.get(a.kind) ?? 0) + 1)
  return c
}

export function AttachmentsTab({ project: owner, assistant = false }: { project: ProjectInfo; assistant?: boolean }) {
  useStore((s) => s.focusedAgent[owner.path])
  useDateStyle()
  const project = projectView(owner)
  // The Assistant's sessions are conversations: the messages say which (a select on host).
  const host = assistant ? 'assistant' : 'project'
  // This project's attachments only. A failed read: said in place of them (or over this project's last ones), not
  // "No attachments yet".
  const loaded = useScopedLoad<SessionAttachmentGroup[]>(project.path)
  const all = loaded.data
  const error = loaded.error
  const [viewing, setViewing] = useState<SessionAttachment | null>(null)
  // A card attachment open in the same viewer (HI-1958).
  const [viewingCard, setViewingCard] = useState<CardAttachment | null>(null)
  // Each tab's own kind filter (HI-1841).
  const [filters, setFilters] = useState<Record<AttachTab, AttachmentKind | null>>(NO_KINDS)
  // The tab shown when it isn't the remembered one: a link's (kept after its jump), or Pane attachments while the
  // project has no card attachments; for this project only. A click on a tab clears it and is remembered.
  const [shownTab, setShownTab] = useState<{ project: string; tab: AttachTab } | null>(null)
  // What is open in the viewer, and the filters, are the last project's.
  useEffect(() => {
    setViewing(null)
    setViewingCard(null)
    setFilters(NO_KINDS)
  }, [project.path])
  const menu = useContextMenu()
  const tabsId = useId()
  // The project's cards' attachments (HI-1700), Card attachments' (HI-1841); the Assistant has none, and no tabs.
  const cardFiles = useProjectCardAttachments(assistant ? null : project.path)
  const cardCount = cardFiles.groups.reduce((n, g) => n + g.attachments.length, 0)
  const remembered = useRememberedTab<AttachTab>(ATTACH_TABS_KEY, ATTACH_TABS, 'pane')
  const tab: AttachTab = assistant ? 'pane' : shownTab?.project === project.path ? shownTab.tab : remembered
  const chooseAttachTab = (t: AttachTab): void => {
    setShownTab(null)
    chooseTab(ATTACH_TABS_KEY, t)
  }
  // Opening on Card attachments with none yet: Pane attachments, once the cards' files have been read (never while they
  // load or failed); a click on Card attachments afterwards stays there.
  const fellBack = useRef<string | null>(null)
  useEffect(() => {
    if (assistant || !cardFiles.loaded || fellBack.current === project.path) return
    fellBack.current = project.path
    if (remembered === 'card' && !cardCount) setShownTab((t) => (t?.project === project.path ? t : { project: project.path, tab: 'pane' }))
  }, [assistant, cardFiles.loaded, cardCount, remembered, project.path])

  const { load: loadScoped } = loaded
  const load = useCallback(() => {
    const path = project.path
    loadScoped(path, () => call('attachments:list', path))
  }, [project.path, loadScoped])
  useEffect(load, [load])
  useFileEvents(project.path, (dirs) => {
    if (dirs.some((d) => d === CW_DIR || d.startsWith('.combwork/attachments'))) load()
  })

  // How many of each kind the tab shown has: a filter is offered for each kind present, counting only its own files.
  const counts = useMemo(() => kindCounts(tab === 'card' ? cardFiles.groups : (all ?? [])), [tab, all, cardFiles.groups])
  const filter = filters[tab]
  const setFilter = (k: AttachmentKind | null): void => setFilters((f) => ({ ...f, [tab]: k }))
  // A filter whose kind is all gone shows everything again.
  const shownKind = filter && counts.get(filter) ? filter : null
  // Pane attachments' filter, for its groups and the viewer (whose files are Pane attachments' only).
  const paneKind = tab === 'pane' ? shownKind : filters.pane
  const groups = useMemo(
    () => (all ?? []).map((g) => ({ ...g, attachments: g.attachments.filter((a) => !paneKind || a.kind === paneKind) })).filter((g) => g.attachments.length),
    [all, paneKind]
  )
  // Same order as on screen: current sessions first, archived last.
  const flat = useMemo(() => [...groups.filter((g) => !g.archived), ...groups.filter((g) => g.archived)].flatMap((g) => g.attachments), [groups])
  const total = useMemo(() => (all ?? []).reduce((n, g) => n + g.attachments.length, 0), [all])
  // Card attachments' filter, and the files its tab shows, in their order: the card viewer's arrows go through these.
  const cardKind = tab === 'card' ? shownKind : filters.card
  const cardGroups = useMemo(() => shownCardGroups(cardFiles.groups, cardKind), [cardFiles.groups, cardKind])
  const cardFlat = useMemo(() => cardGroups.flatMap((g) => g.attachments), [cardGroups])
  /** A card attachment taken off its card from the viewer, after asking: the viewer goes on to the next one shown. */
  const removeCard = async (a: CardAttachment): Promise<void> => {
    const g = cardGroups.find((x) => x.card === a.card)
    if (!(await removeCardAttachmentAsked(g?.key ?? `#${a.card}`, a))) return
    const i = cardFlat.findIndex((x) => x.id === a.id)
    setViewingCard((v) => (v?.id === a.id ? (cardFlat[i + 1] ?? cardFlat[i - 1] ?? null) : v))
    await cardFiles.reload()
  }

  const remove = async (a: SessionAttachment): Promise<void> => {
    const ok = await confirm({ title: tr(M.trashTitle), message: tr(M.attachDeleteMessage, { name: a.name }), detail: tr(M.attachDeleteDetail), confirmLabel: tr(M.trashButton), danger: true })
    if (!ok) return
    await actions.attempt(tr(M.attachDeleteFailed), () => call('attachments:trash', project.path, a.path))
    if (viewing?.path === a.path) {
      const i = flat.findIndex((x) => x.path === a.path)
      setViewing(flat[i + 1] ?? flat[i - 1] ?? null)
    }
    load()
  }

  /** All of a session's attachments, after asking; none go if one can't (another program has it open), and none while it runs. */
  const removeGroup = async (g: SessionAttachmentGroup): Promise<void> => {
    const n = (all ?? []).find((x) => x.sessionId === g.sessionId)?.attachments.length ?? g.attachments.length
    const ok = await confirm({
      title: tr(M.groupDeleteTitle, { count: n }),
      message: tr(M.groupDeleteMessage, { count: n, name: g.name ?? g.sessionId.slice(0, 8) }),
      detail: tr(M.groupDeleteDetail, { filtered: paneKind ? 'yes' : 'no', host }),
      confirmLabel: tr(M.trashButton),
      danger: true
    })
    if (!ok) return
    const done = await actions.attempt(tr(M.groupDeleteFailed), () => call('attachments:trashGroup', project.path, g.sessionId))
    if (done !== undefined) {
      if (viewing && g.attachments.some((i) => i.path === viewing.path)) setViewing(null)
      notify('success', tr(M.groupDeleted, { count: done }))
    }
    load()
  }
  /** The session's transcript: the Sessions tab, or the Assistant's conversations. */
  const openTranscript = (sessionId: string): void => {
    if (assistant) set({ assistantSection: 'conversations', sessionsJump: { project: owner.path, id: sessionId, nonce: Date.now() } })
    else openInSessionsTab(owner.path, sessionId)
  }

  /** The attachment's session (its folder) is running. */
  const running = (a: SessionAttachment): boolean => {
    const id = a.path.split(/[\\/]/).slice(-2)[0]
    return owner.agents.some((x) => x.live?.sessionId === id)
  }
  const menuFor = (a: SessionAttachment, at?: { x: number; y: number }): MenuEntry[] => [
    { label: tr(M.view), icon: 'eye', onClick: () => setViewing(a) },
    ...(project.live ? [{ label: tr(M.insertIntoSession), icon: 'terminal', onClick: () => void insertIntoSession(project, [a.path]) }] : []),
    // Copied to a card (HI-1700), so it outlives the session's Clean Up.
    ...(!assistant && at
      ? [{ label: tr(M.attachToCard), icon: 'pinned', more: true, onClick: () => { const s = get(); menu.openAt(at.x, at.y, attachToCardMenu({ hostPath: project.path, project: project.name, agentId: null, path: a.path, name: shownName(a.name), cards: s.tasks, label: (t) => cardLabelOf(s, t.number) })) } }]
      : []),
    { separator: true },
    ...(a.kind === 'image' ? [{ label: tr(M.copyImage), icon: 'copy', onClick: () => void actions.attempt(tr(M.copyImageFailed), () => call('attachments:copyImage', a.path)) }] : []),
    { label: tr(M.copyPath), icon: a.kind === 'image' ? 'blank' : 'copy', onClick: () => copyText(a.path) },
    // Opened in its program only when it can't be one that runs (#387: nothing attached is ever run): images and PDFs.
    ...(a.kind === 'image' || a.kind === 'pdf' ? [{ label: tr(FILES_TEXT.open), icon: 'link-external', onClick: () => void call('app:openPath', a.path) }] : []),
    { label: tr(FILES_TEXT.revealInExplorer), icon: 'folder-opened', onClick: () => void call('app:showInFolder', a.path) },
    { separator: true },
    // Not while its session runs (it may paste more): main refuses it too.
    running(a) ? { label: tr(M.delete), icon: 'trash', disabled: true, detail: tr(M.running, { host }) } : { label: tr(M.delete), icon: 'trash', danger: true, onClick: () => void remove(a) }
  ]

  // A link's jump (HI-1841), for this project only: its tab shown (and kept), that tab's filter back to All so its target
  // shows; then, in a render that has both (never the page as it was: HR5's round 1), the target scrolled to and
  // flashed once drawn, and the jump done. A target that isn't there once the files are read (no attachments in that
  // session) leaves the tab shown.
  const jump = useStore((s) => s.attachmentsJump)
  const pageRef = useRef<HTMLDivElement>(null)
  const [preparedJump, setPreparedJump] = useState<number | null>(null)
  useEffect(() => {
    if (assistant || !jump || jump.project !== project.path) return
    setShownTab({ project: project.path, tab: jump.tab })
    setFilters((f) => (f[jump.tab] ? { ...f, [jump.tab]: null } : f))
    setPreparedJump(jump.nonce)
  }, [assistant, jump, project.path])
  useEffect(() => {
    if (assistant || !jump || jump.project !== project.path || preparedJump !== jump.nonce || tab !== jump.tab || filters[jump.tab]) return
    const sel = jump.tab === 'card' ? `[data-card="${jump.card}"]` : `[data-session="${CSS.escape(jump.session)}"]`
    const target = pageRef.current?.querySelector<HTMLElement>(`[role="tabpanel"][data-tab-panel="${jump.tab}"] ${sel}`)
    const read = jump.tab === 'card' ? cardFiles.loaded || cardFiles.failed : !!all
    if (!target && !read) return
    if (target) {
      target.scrollIntoView({ block: 'start' })
      target.classList.add('jumped')
      window.setTimeout(() => target.classList.remove('jumped'), 1500)
    }
    set({ attachmentsJump: null })
  })

  if (!all) return error ? <LoadFailed what={tr(M.attachmentsLoadTarget)} error={error} onRetry={load} /> : <div className="empty-state"><Icon name="loading" spin />{tr(M.loading)}</div>
  if (!all.length && !error && !cardCount && cardFiles.loaded) {
    return (
      <div className="empty-state" style={{ paddingTop: '15vh' }}>
        <Icon name="attach" />
        {tr(M.noneYet)}
        <p className="hint">{rich(assistant ? M.noneHintAssistant : M.noneHint, { kbd })}</p>
      </div>
    )
  }

  const current = groups.filter((g) => !g.archived)
  const archived = groups.filter((g) => g.archived)
  const renderGroup = (g: SessionAttachmentGroup): React.ReactNode => {
    // The count and span are of the whole session's attachments, whatever the filter shows.
    const whole = all.find((x) => x.sessionId === g.sessionId)?.attachments ?? g.attachments
    const times = whole.map((a) => new Date(a.modified).getTime())
    const [first, last] = [Math.min(...times), Math.max(...times)]
    const oneDay = daysAgo(first, new Date(last)) === 0
    return (
      <section key={g.sessionId} className="image-group" data-session={g.sessionId}>
        <div className="image-group-head">
          <Icon name="comment-discussion" />
          <Tooltip content={tr(M.openTranscript, { host })}>
            <button className="image-group-name" onClick={() => openTranscript(g.sessionId)}>
              {g.name ?? tr(M.unnamedGroup, { host, id: g.sessionId.slice(0, 8) })}
            </button>
          </Tooltip>
          {owner.agents.some((a) => a.live?.sessionId === g.sessionId) && <span className="badge accent">{tr(M.runningBadge)}</span>}
          {g.archived && <span className="badge">{tr(M.archivedBadge)}</span>}
          <span className="faint">
            {tr(M.groupSpan, { count: whole.length, days: oneDay ? 'one' : 'more', from: spanDay(first), to: spanDay(last) })}
          </span>
          <IconButton icon="trash" title={tr(M.groupDelete, { host })} action="delete-attachments" disabled={owner.agents.some((a) => a.live?.sessionId === g.sessionId)} onClick={() => void removeGroup(g)} />
        </div>
        <div className="image-grid">
          {g.attachments.flatMap((a, i) => {
            // A group that spans days has a divider where each day's attachments start (newest first).
            const day = !oneDay && (i === 0 || dayKey(a.modified) !== dayKey(g.attachments[i - 1].modified)) ? (
              <div key={`day-${dayKey(a.modified)}`} className="attachment-day">
                {formatLongDay(a.modified)}
              </div>
            ) : null
            const label = g.provider ? attachmentLabel(a.kind, providerDescriptor(g.provider).capabilities.attachments, providerDescriptor(g.provider).name) : null
            const tile = (
              <Tooltip key={a.path} content={`${a.name} · ${attachmentTime(a)} · ${formatBytes(a.size)}${label ? `\n${label.detail}` : ''}`}>
                <div
                  className={cx('thumb', a.kind !== 'image' && 'file')}
                  data-kind={a.kind}
                  draggable
                  onClick={() => setViewing(a)}
                  onContextMenu={(e) => menu.open(e, menuFor(a, { x: e.clientX, y: e.clientY }))}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FILES_MIME, JSON.stringify({ project: project.path, paths: [a.path] }))
                    e.dataTransfer.setData('text/plain', quotePath(a.path))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  {a.kind === 'image' ? (
                    <img src={imageUrl(a.path)} loading="lazy" alt={a.name} draggable={false} />
                  ) : (
                    <>
                      <Icon name={fileNameIcon(a.name)} />
                      <span className="thumb-name">{shownName(a.name)}</span>
                    </>
                  )}
                  <span className="thumb-caption thumb-size">{formatBytes(a.size)}</span>
                  <span className="thumb-caption">{formatTime(a.modified)}</span>
                </div>
              </Tooltip>
            )
            return day ? [day, tile] : [tile]
          })}
        </div>
      </section>
    )
  }

  return (
    <div className="scroll-page images-page" ref={pageRef}>
      <div className="images-toolbar">
        <h2>{tr(M.attachments)}</h2>
        <InfoTip text={tr(assistant ? M.infoAssistant : M.info)} />
        <span className="faint">{!assistant && cardCount ? tr(M.totalWithCards, { total: total + cardCount, cards: cardCount, sessions: total, groups: all.length }) : tr(M.total, { host, total, groups: all.length })}</span>
        <div className="grow" />
        <IconButton icon="refresh" title={tr(M.refresh)} action="refresh-attachments" onClick={load} />
        <IconButton icon="folder-opened" title={tr(M.openFolder)} onClick={() => void call('app:openPath', `${project.path}\\.combwork\\attachments`)} />
      </div>
      <p className="hint images-desc">{tr(assistant ? M.descAssistant : M.desc)}</p>
      {!assistant && <Tabs<AttachTab> idBase={`${tabsId}-attach`} className="attachment-tabs" label={tr(M.tabs)} value={tab} onChange={chooseAttachTab} items={[{ id: 'pane', label: tr(M.paneTab), icon: 'comment-discussion', count: total }, { id: 'card', label: tr(M.cardTab), icon: 'checklist', count: cardCount }]} />}
      {counts.size > 1 && (
        <div className="attachment-filters" role="group" aria-label={tr(M.show)}>
          <button className={cx('attachment-filter', !shownKind && 'selected')} aria-pressed={!shownKind} onClick={() => setFilter(null)}>
            {tr(M.all)} <span className="faint">{tab === 'card' ? cardCount : total}</span>
          </button>
          {ATTACHMENT_KINDS.filter((k) => counts.get(k)).map((k) => (
            <button key={k} className={cx('attachment-filter', shownKind === k && 'selected')} aria-pressed={shownKind === k} data-kind={k} onClick={() => setFilter(shownKind === k ? null : k)}>
              <Icon name={ATTACHMENT_KIND_ICON[k]} /> {tr(ATTACHMENT_FILTER_LABEL[k])} <span className="faint">{counts.get(k)}</span>
            </button>
          ))}
        </div>
      )}
      {/* Each tab its own page (HI-1841); the Assistant's view has Pane attachments alone, without tabs. */}
      {!assistant && (
        <TabPanel idBase={`${tabsId}-attach`} id="card" selected={tab === 'card'} data-tab-panel="card">
          {cardCount ? <CardAttachmentSection groups={cardFiles.groups} kind={cardKind} reload={cardFiles.reload} onOpen={setViewingCard} /> : <div className="empty-state attachment-tab-empty">{cardFiles.loaded ? tr(M.cardEmpty) : cardFiles.failed ? tr(M.cardFailed) : <Icon name="loading" spin />}</div>}
        </TabPanel>
      )}
      <PanePanel assistant={assistant} idBase={`${tabsId}-attach`} selected={tab === 'pane'}>
        {error && <StaleNote what={tr(M.attachmentsRefreshTarget)} error={error} at={loaded.at} onRetry={load} />}
        {!assistant && !all.length && <div className="empty-state attachment-tab-empty">{tr(M.paneEmpty)}</div>}
        {!assistant && all.length > 0 && <p className="hint">{tr(M.sessionsKept)}</p>}
        {current.map(renderGroup)}
        {archived.length > 0 && (
          <>
            <h3 className="images-archived">
              <Icon name="archive" /> {tr(M.archivedHeading, { host })}
            </h3>
            {archived.map(renderGroup)}
          </>
        )}
      </PanePanel>
      {viewing && (
        <AttachmentViewer
          host={project.path}
          item={viewing}
          items={flat}
          view={(a) => paneViewed(project.path, a)}
          live={!!project.live}
          // Worked out for the one shown, so it follows navigation and its session starting or stopping (main refuses too).
          remove={{ label: tr(M.delete), blocked: running(viewing) ? tr(M.running, { host }) : null }}
          onNavigate={setViewing}
          onClose={() => setViewing(null)}
          onInsert={(a) => {
            setViewing(null)
            void insertIntoSession(project, [a.path])
          }}
          onRemove={(a) => void remove(a)}
        />
      )}
      {viewingCard && (
        <AttachmentViewer
          host={project.path}
          item={viewingCard}
          items={cardFlat}
          view={cardViewed}
          live={!!project.live}
          remove={{ label: tr(M.removeFromCard), blocked: null }}
          onNavigate={setViewingCard}
          onClose={() => setViewingCard(null)}
          onInsert={(a) => {
            setViewingCard(null)
            void insertIntoSession(project, [a.path])
          }}
          onRemove={(a) => void removeCard(a)}
        />
      )}
      {menu.element}
    </div>
  )
}

/** Pane attachments' page: a tab's panel in a project, the page itself in the Assistant's view (no tabs). */
function PanePanel({ assistant, idBase, selected, children }: { assistant: boolean; idBase: string; selected: boolean; children: React.ReactNode }) {
  if (assistant) return <>{children}</>
  return (
    <TabPanel idBase={idBase} id="pane" selected={selected} data-tab-panel="pane">
      {children}
    </TabPanel>
  )
}

/** The filters' names, plural. */
const ATTACHMENT_FILTER_LABEL: Record<AttachmentKind, Msg> = { image: M.images, pdf: M.pdfs, text: M.text, file: M.other }

/** A kept attachment's own name, without the time Hive put in front of it ("2026-10-12_09-30-00_report.pdf" is "report.pdf"). */
const shownName = (name: string): string => name.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, '')

/**
 * What the attachment viewer shows (HI-1958): a session's attachment or a card's, as one. `read` gives its text for a
 * preview (a session's through its host, a card's by its card and id, never a path main didn't list).
 */
interface Viewed {
  path: string
  /** Its name as shown, its kind, its size and the time in its title. */
  name: string
  kind: AttachmentKind
  size: number
  when: string
  /** Its file is gone (a card's: its row outlived it). */
  missing: boolean
  read: () => Promise<AttachmentContent>
}

/** A session's attachment in the viewer. */
const paneViewed = (host: string, a: SessionAttachment): Viewed => ({ path: a.path, name: shownName(a.name), kind: a.kind, size: a.size, when: attachmentTime(a), missing: false, read: () => call('attachments:read', host, a.path) })
/** A card's attachment in the viewer (HI-1958). */
const cardViewed = (a: CardAttachment): Viewed => ({ path: a.path, name: a.name, kind: a.kind, size: a.size, when: formatDateTime(a.at), missing: !!a.missing, read: () => call('cards:readAttachment', a.card, a.id) })

/**
 * The attachment viewer (pane and card attachments alike, HI-1958): the one shown, arrows through the others shown,
 * and its actions. An image or a PDF opens in its app; any other kind is shown in its folder, never opened (#387:
 * nothing attached is ever run; Darren's decision on HI-1958). `remove`: its label (Delete, Remove from Card) and why it
 * can't be now, or null.
 */
function AttachmentViewer<T>({
  host,
  item,
  items,
  view,
  live,
  remove,
  onNavigate,
  onClose,
  onInsert,
  onRemove
}: {
  /** The folder whose previews read it (a session host, or the card's project). */
  host: string
  item: T
  items: T[]
  view: (t: T) => Viewed
  live: boolean
  remove: { label: string; blocked: string | null }
  onNavigate: (t: T) => void
  onClose: () => void
  onInsert: (t: T) => void
  onRemove: (t: T) => void
}) {
  const shown = view(item)
  const i = items.findIndex((x) => view(x).path === shown.path)
  // The list is newest first, so "previous" (left) is the newer one.
  const prev = items[i - 1]
  const next = items[i + 1]
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
      else if (e.key === 'ArrowRight' && next) onNavigate(next)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onNavigate])
  const image = shown.kind === 'image'
  const opens = image || shown.kind === 'pdf'
  return (
    <Modal
      title={`${shown.when} · ${shown.name}`}
      icon={shown.missing ? 'warning' : fileNameIcon(shown.name)}
      onClose={onClose}
      wide
      // Sized to what it shows, with its own controls: it stays put (#133).
      movable={false}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>
            {tr(M.position, { index: i + 1, count: items.length })} · {formatBytes(shown.size)}
          </span>
          <Tooltip content={remove.blocked}>
            <button className="btn subtle danger-text" data-action="viewer-remove" disabled={!!remove.blocked} aria-description={remove.blocked ?? undefined} onClick={() => onRemove(item)}>
              <Icon name="trash" /> {remove.label}
            </button>
          </Tooltip>
          {!shown.missing &&
            (opens ? (
              <button className="btn subtle" data-action="viewer-open" onClick={() => void call('app:openPath', shown.path)}>
                <Icon name="link-external" /> {tr(M.openInApp)}
              </button>
            ) : (
              <button className="btn subtle" data-action="viewer-show" onClick={() => void call('app:showInFolder', shown.path)}>
                <Icon name="folder-opened" /> {tr(CARD_ATTACH_TEXT.show)}
              </button>
            ))}
          {!shown.missing && (
            <button className="btn subtle" onClick={() => copyText(shown.path)}>
              {tr(M.copyPath)}
            </button>
          )}
          {image && !shown.missing && (
            <button className="btn subtle" onClick={() => void actions.attempt(tr(M.copyImageFailed), () => call('attachments:copyImage', shown.path))}>
              <Icon name="copy" /> {tr(M.copyImage)}
            </button>
          )}
          {live && !shown.missing && (
            <button className="btn primary" onClick={() => onInsert(item)}>
              <Icon name="terminal" /> {tr(M.insertIntoSession)}
            </button>
          )}
        </>
      }
    >
      <div className="image-viewer">
        <IconButton icon="chevron-left" title={tr(M.newer)} disabled={!prev} onClick={() => prev && onNavigate(prev)} />
        {shown.missing ? (
          <div className="attachment-frame" data-missing>
            <div className="attachment-none">
              <Icon name="warning" />
              {tr(CARD_ATTACH_TEXT.missing)}
            </div>
          </div>
        ) : image ? (
          <div className="image-frame">
            <img src={imageUrl(shown.path)} alt={shown.name} />
          </div>
        ) : (
          <AttachmentFrame host={host} attachment={shown} />
        )}
        <IconButton icon="chevron-right" title={tr(M.older)} disabled={!next} onClick={() => next && onNavigate(next)} />
      </div>
    </Modal>
  )
}

/** An attachment that isn't an image, previewed as the Files tab would (a PDF, Markdown, a CSV's table) or as text. */
function AttachmentFrame({ host, attachment }: { host: string; attachment: Viewed }) {
  const fromDisk = previewsFromDisk(attachment.name)
  const [content, setContent] = useState<AttachmentContent | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // Its read as of this render: the effect runs again for another file, never for a new function of the same one.
  const read = useRef(attachment.read)
  read.current = attachment.read
  useEffect(() => {
    setContent(null)
    setFailed(null)
    if (fromDisk || attachment.kind === 'file') return
    let live = true
    read.current().then(
      (c) => live && setContent(c),
      (e) => live && setFailed(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [host, attachment.path, attachment.kind, fromDisk])
  const none = (icon: string, text: string): React.ReactNode => (
    <div className="attachment-none">
      <Icon name={icon} />
      {text}
    </div>
  )
  let body: React.ReactNode
  if (fromDisk) body = <ReadOnlyPreview root={host} abs={attachment.path} name={attachment.name} text={null} />
  else if (failed) body = none('warning', tr(M.readFailed, { error: failed }))
  else if (attachment.kind === 'file' || content?.kind === 'binary') body = none(fileNameIcon(attachment.name), tr(M.noPreview))
  else if (content?.kind === 'too-large') body = none(fileNameIcon(attachment.name), tr(M.tooLarge))
  else if (content) body = <ReadOnlyPreview root={host} abs={attachment.path} name={attachment.name} text={content.text} />
  else body = none('loading', tr(M.loading))
  return (
    <div className="attachment-frame">
      {body}
    </div>
  )
}
