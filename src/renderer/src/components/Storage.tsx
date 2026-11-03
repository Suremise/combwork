import { Children, useCallback, useEffect, useRef, useState } from 'react'
import type { CleanupItem, CleanupOptions, ProjectStorage, WorkspaceStorage } from '@shared/types'
import { CARD_CLEANUP_CHOICES, cleanupDays, type CardCleanupChoice, type CardCleanupItem } from '@shared/cardCleanup'
import { settingEntry } from '@shared/settingsCatalog'
import { shownText } from '@shared/advanced'
import { formatDateTime } from '@shared/dates'
import { DEFAULT_CLEANUP } from '@shared/storage'
import { formatSize } from '@shared/units'
import { call, errorMessage } from '../api'
import { notify, openProjectSettings, useStore } from '../store'
import { runCommand } from '../commands'
import { cx, timeAgo } from '../util'
import { BusyButton, Icon, LoadFailed, Modal, useBusy } from './ui'
import { DataTable, type DataColumn } from './DataTable'
import { fmt, msg, tr, tRich, type Msg } from '@shared/i18n'
import { PurgeDialog } from './Purge'

const M = {
  what: msg({ id: 'workspace.storage.what', defaultMessage: 'What', description: "Storage's table: the column of what Hive keeps." }),
  size: msg({ id: 'workspace.storage.size', defaultMessage: 'Size', description: "Storage's tables: the column of sizes." }),
  reviewInChanges: msg({ id: 'workspace.storage.reviewInChanges', defaultMessage: 'Review in Changes', description: "Storage, beside the unused worktrees: a link to them in the Git tab's Changes." }),
  loadTarget: msg({ id: 'workspace.storage.loadTarget', defaultMessage: 'the storage sizes', description: 'What could not be loaded when Storage measured: shown in "Could not load {what}: {error}", with Retry.' }),
  backups: msg({ id: 'workspace.storage.backups', defaultMessage: 'Transcript backups', description: "Storage: Hive's copies of the sessions' transcripts (.hive/sessions)." }),
  archive: msg({ id: 'workspace.storage.archive', defaultMessage: 'Archive', description: "Storage: Hive's archive folder (.hive/archive)." }),
  beforeCompression: msg({ id: 'workspace.storage.beforeCompression', defaultMessage: '{size} before compression', description: "Storage, beside the size of Hive's transcript backups or archive: what they hold uncompressed ({size}: like 1.2 GB). Ended sessions' backups are compressed." }),
  attachments: msg({ id: 'workspace.storage.attachments', defaultMessage: 'Attachments', description: 'Storage: files pasted or dropped into sessions (.hive/attachments).' }),
  cardAttachments: msg({ id: 'workspace.storage.cardAttachments', defaultMessage: 'Card attachments', description: 'Storage (HI-1700): files kept with cards (.hive/attachments/cards). Clean Up and Purge never remove them.' }),
  agentWorktree: msg({ id: 'workspace.storage.worktree', defaultMessage: "{agent}'s worktree", description: "Storage: an agent's worktree." }),
  slot: msg({ id: 'workspace.storage.slot', defaultMessage: '{slot}, lent to agent {agent}', description: "Storage (#1451): one of the project's slots (a working folder Hive lends to a card or a lane; {slot} is its name, such as slot-b: keep it as it is), lent now to the agent {agent}. Glossary: slot. A noun before the name (glossary §1 rule 4)." }),
  freeSlot: msg({ id: 'workspace.storage.freeSlot', defaultMessage: '{slot}, not lent', description: "Storage (#1451): one of the project's slots (a working folder Hive lends to a card or a lane; {slot} is its name, such as slot-b: keep it as it is), kept on disk but lent to no one now. Glossary: slot." }),
  copies: msg({ id: 'workspace.storage.copies', defaultMessage: 'Review and check copies', description: "Storage (#1451): the folder of the project's review and check copies (folders Hive keeps at one revision for a reviewer, or an isolated check). Glossary: review copy." }),
  unused: msg({ id: 'workspace.storage.unused', defaultMessage: 'Unused worktrees ({count})', description: 'Storage: the worktrees no agent works in, on one line.' }),
  measuring: msg({ id: 'workspace.storage.measuring', defaultMessage: 'Measuring…', description: 'Storage while it measures the folders.' }),
  nothingKept: msg({ id: 'workspace.storage.nothingKept', defaultMessage: 'Nothing kept.', description: "Storage's table when Hive keeps nothing for the project." }),
  total: msg({ id: 'workspace.storage.total', defaultMessage: 'Total', description: "Storage's table: the last row, the project's total." }),
  measuringAgain: msg({ id: 'workspace.storage.measuringAgain', defaultMessage: 'Measuring again…', description: 'Storage while Refresh measures again.' }),
  measured: msg({ id: 'workspace.storage.measured', defaultMessage: 'Measured {when}', description: 'Storage: when the sizes were measured ({when}: "4 minutes ago").' }),
  refresh: msg({ id: 'workspace.storage.refresh', defaultMessage: 'Refresh', description: 'Storage: measures again.' }),
  cleanUp: msg({ id: 'workspace.storage.cleanUp', defaultMessage: 'Clean Up…', description: 'Storage: opens the Clean Up dialog.' }),
  purge: msg({ id: 'workspace.storage.purge', defaultMessage: 'Purge…', description: "Storage: opens the Purge dialog, which removes everything Hive keeps per session (it lists it first)." }),
  kindArchivedAttachments: msg({ id: 'workspace.storage.kindArchivedAttachments', defaultMessage: 'Attachments of archived sessions', description: 'Clean Up, a group of what goes.' }),
  kindOrphanAttachments: msg({ id: 'workspace.storage.kindOrphanAttachments', defaultMessage: 'Attachments of deleted sessions', description: 'Clean Up, a group of what goes; and its choice.' }),
  kindArchivedBackup: msg({ id: 'workspace.storage.kindArchivedBackup', defaultMessage: 'Backups of archived sessions (the CLI still has them)', description: 'Clean Up, a group of what goes.' }),
  kindGoneBackup: msg({ id: 'workspace.storage.kindGoneBackup', defaultMessage: 'Last copies of archived sessions (deletes them)', description: 'Clean Up, a group of what goes.' }),
  moved: msg({ id: 'workspace.storage.moved', defaultMessage: 'Moved {count, plural, one {# item} other {# items}} ({size}) to the Recycle Bin', description: 'A notice after Clean Up ({size}: "12 MB").' }),
  nothingRemoved: msg({ id: 'workspace.storage.nothingRemoved', defaultMessage: 'Nothing was removed', description: 'A notice after Clean Up when nothing went.' }),
  skipped: msg({ id: 'workspace.storage.skipped', defaultMessage: '{count, plural, one {# item skipped:} other {# items skipped:}}', description: "Under the notice after Clean Up: items that couldn't be moved (each follows on a line)." }),
  title: msg({ id: 'workspace.storage.title', defaultMessage: 'Clean Up {name}', description: "The Clean Up dialog's title ({name}: the project)." }),
  cancel: msg({ id: 'workspace.storage.cancel', defaultMessage: 'Cancel', description: "The Clean Up dialog's button that closes it." }),
  movingBusy: msg({ id: 'workspace.storage.movingBusy', defaultMessage: 'Moving to the Recycle Bin…', description: "The Clean Up dialog's button while it works." }),
  moveItems: msg({ id: 'workspace.storage.moveItems', defaultMessage: 'Move {count, plural, one {# item} other {# items}} ({size}) to the Recycle Bin', description: "The Clean Up dialog's button ({size}: \"12 MB\")." }),
  move: msg({ id: 'workspace.storage.move', defaultMessage: 'Move to the Recycle Bin', description: "The Clean Up dialog's button with nothing chosen." }),
  neverTouched: msg({ id: 'workspace.storage.neverTouched', defaultMessage: "Running sessions and sessions that aren't archived are never touched, nor the coding agents' own transcripts (in ~/.claude, ~/.codex and ~/.copilot). What the sessions used still counts in the totals.", description: 'The Clean Up dialog, at the top. Keep the paths as they are.' }),
  oldAttachments: msg({ id: 'workspace.storage.oldAttachments', defaultMessage: 'Attachments of archived sessions last active more than {days} days ago', description: 'A Clean Up choice; {days} is a box where you type the number of days.' }),
  oldAttachmentsDesc: msg({ id: 'workspace.storage.oldAttachmentsDesc', defaultMessage: 'Files pasted or dropped into those sessions (.hive/attachments).', description: 'Under a Clean Up choice. Keep .hive/attachments as it is.' }),
  attachmentDays: msg({ id: 'workspace.storage.attachmentDays', defaultMessage: 'Attachment age in days', description: "Clean Up: the days box's accessible name." }),
  orphansDesc: msg({ id: 'workspace.storage.orphansDesc', defaultMessage: 'Attachments whose session was deleted, or whose launch never got a session (folders named run-…).', description: 'Under a Clean Up choice. Keep run-… as it is (the folders\' names).' }),
  oldBackups: msg({ id: 'workspace.storage.oldBackups', defaultMessage: "Combwork's backups of archived sessions last active more than {days} days ago", description: 'A Clean Up choice; {days} is a box where you type the number of days.' }),
  oldBackupsDesc: msg({ id: 'workspace.storage.oldBackupsDesc', defaultMessage: "Only where Claude Code or Codex still has the transcript: the session stays, and can be resumed and read from the CLI's copy for as long as the CLI keeps it.", description: 'Under a Clean Up choice.' }),
  backupDays: msg({ id: 'workspace.storage.backupDays', defaultMessage: 'Backup age in days', description: "Clean Up: the days box's accessible name." }),
  goneBackups: msg({ id: 'workspace.storage.goneBackups', defaultMessage: 'Backups of archived sessions the CLI no longer has', description: 'A Clean Up choice (it deletes those sessions).' }),
  goneBackupsDesc: msg({ id: 'workspace.storage.goneBackupsDesc', defaultMessage: "Combwork's copy is the last one: the sessions are deleted, as Delete Session does.", description: 'Under a Clean Up choice. Delete Session is the Sessions tab\'s command.' }),
  goneWarning: msg({ id: 'workspace.storage.goneWarning', defaultMessage: "These sessions can't be resumed or read afterwards: Combwork's backup is the only copy left. They leave the Sessions tab; what they used still counts in the totals.", description: 'The Clean Up dialog, while it would delete sessions.' }),
  whatGoes: msg({ id: 'workspace.storage.whatGoes', defaultMessage: 'What goes to the Recycle Bin', description: "The Clean Up dialog's heading over the files." }),
  looking: msg({ id: 'workspace.storage.looking', defaultMessage: 'Looking…', description: 'The Clean Up dialog while it finds the files.' }),
  nothingMatches: msg({ id: 'workspace.storage.nothingMatches', defaultMessage: 'Nothing matches.', description: 'The Clean Up dialog when no file matches the choices.' }),
  groupCount: msg({ id: 'workspace.storage.groupCount', defaultMessage: '{count, plural, one {# item} other {# items}}, {size}', description: 'The Clean Up dialog, beside a group: how many and how big.' }),
  nothing: msg({ id: 'workspace.storage.nothing', defaultMessage: 'Nothing.', description: 'An empty group in the Clean Up dialog.' }),
  assistant: msg({ id: 'workspace.storage.assistant', defaultMessage: 'Assistant', description: "Settings → Workspace's storage: the Assistant's row and heading. Hive's name stays as it is." }),
  project: msg({ id: 'workspace.storage.project', defaultMessage: 'Project', description: "Settings → Workspace's storage table: the column of projects." }),
  hide: msg({ id: 'workspace.storage.hide', defaultMessage: 'Hide', description: "Settings → Workspace's storage: hides the Assistant's storage." }),
  storage: msg({ id: 'workspace.storage.storage', defaultMessage: 'Storage', description: "Settings → Workspace's storage: shows a project's (or the Assistant's) storage." }),
  noWorkspace: msg({ id: 'workspace.storage.noWorkspace', defaultMessage: 'Open a workspace to see what Combwork keeps for it.', description: "Settings → Workspace's storage with no workspace open." }),
  measuringProjects: msg({ id: 'workspace.storage.measuringProjects', defaultMessage: 'Measuring the projects…', description: "Settings → Workspace's storage while it measures." }),
  noProjects: msg({ id: 'workspace.storage.noProjects', defaultMessage: 'No projects.', description: "Settings → Workspace's storage table with no projects." }),
  workspace: msg({ id: 'workspace.storage.workspace', defaultMessage: 'Workspace', description: "Settings → Workspace's storage table: the last row, the workspace's total." }),
  // HI-1842: archived cards' attachments, removed some days after archiving (Project Settings → Storage).
  cleanUpNow: msg({ id: 'workspace.storage.cardCleanup.now', defaultMessage: 'Clean Up Now…', description: "Project Settings → Storage, beside the setting \"Remove archived cards' attachments\": opens a dialog listing what it would remove now, to remove it at once." }),
  cleanUpOff: msg({ id: 'workspace.storage.cardCleanup.off', defaultMessage: 'Choose a number of days first.', description: 'The tooltip of "Clean Up Now…" (Project Settings → Storage) while the setting is Never: there is nothing it would remove.' }),
  cleanupTitle: msg({ id: 'workspace.storage.cardCleanup.title', defaultMessage: 'Clean Up Card Attachments: {name}', description: 'The dialog of Clean Up Now (Project Settings → Storage): {name} is the project.' }),
  cleanupIntro: msg({ id: 'workspace.storage.cardCleanup.intro', defaultMessage: 'The files kept with these cards, archived {days, plural, one {# day} other {# days}} ago or more, go to the Recycle Bin. Each card gets a comment saying so. Open and Done cards keep theirs.', description: "The Clean Up Now dialog (Project Settings → Storage), at the top: {days} is the project's setting." }),
  cleanupCard: msg({ id: 'workspace.storage.cardCleanup.card', defaultMessage: 'Card', description: "The Clean Up Now dialog's table: the column of archived cards (key and title)." }),
  cleanupArchived: msg({ id: 'workspace.storage.cardCleanup.archived', defaultMessage: 'Archived', description: "The Clean Up Now dialog's table: the column of when each card was archived (\"3 weeks ago\")." }),
  cleanupFiles: msg({ id: 'workspace.storage.cardCleanup.files', defaultMessage: '{count, plural, one {# file} other {# files}}', description: "The Clean Up Now dialog's table: how many files a card keeps." }),
  cleanupNone: msg({ id: 'workspace.storage.cardCleanup.none', defaultMessage: 'No archived card is due yet.', description: 'The Clean Up Now dialog when no archived card has been archived long enough.' }),
  cleanupMove: msg({ id: 'workspace.storage.cardCleanup.move', defaultMessage: 'Move {count, plural, one {# file} other {# files}} ({size}) to the Recycle Bin', description: "The Clean Up Now dialog's button ({size}: \"12 MB\")." }),
  cleanupMore: msg({ id: 'workspace.storage.cardCleanup.more', defaultMessage: 'More archived cards are due than these {count, number}: Clean Up Now again takes on the next ones.', description: 'The Clean Up Now dialog (Project Settings → Storage), under its list when more archived cards are due than one list takes: {count} is how many it lists.' }),
  cleanupLeft: msg({ id: 'workspace.storage.cardCleanup.left', defaultMessage: '{count, plural, one {# file was left as it is} other {# files were left as they are}}: changed, moved or brought back from the archive since the list was made.', description: 'Under the notice after Clean Up Now (Project Settings → Storage): files it listed but did not remove, because they or their card changed meanwhile. Running it again does not remove them unless they are due.' }),
  cleanupDone: msg({ id: 'workspace.storage.cardCleanup.done', defaultMessage: 'Moved {files, plural, one {# file} other {# files}} ({size}) of {cards, plural, one {# archived card} other {# archived cards}} to the Recycle Bin', description: 'A notice after Clean Up Now (Project Settings → Storage): {size} like "12 MB".' })
}

/** A row of a project's storage: what it is, where, how big. */
interface StorageRow {
  label: string
  where: string
  bytes: number
  /** What it holds before compression (#1110: compressed backups), when that's more. */
  raw?: number
  /** The project whose Overview lists them, for a Review link (unused worktrees, #353). */
  review?: string
}
/** Its columns, worded when the table is drawn (they follow a change of language). */
const storageColumns = (): DataColumn<StorageRow>[] => [
  {
    key: 'what',
    header: tr(M.what),
    cell: (r) => (
      <>
        {r.label} <span className="faint small mono">{r.where}</span>
        {r.review && (
          <>
            {' '}
            <a className="small" onClick={() => runCommand('project.unusedWorktrees', r.review)}>
              {tr(M.reviewInChanges)}
            </a>
          </>
        )}
      </>
    ),
    sortValue: (r) => r.label
  },
  {
    key: 'size',
    header: tr(M.size),
    num: true,
    descFirst: true,
    cell: (r) => (
      <>
        {formatSize(r.bytes)}
        {r.raw !== undefined && r.raw > r.bytes && <div className="faint small">{tr(M.beforeCompression, { size: formatSize(r.raw) })}</div>}
      </>
    ),
    sortValue: (r) => r.bytes
  }
]

/**
 * Measuring walks every file of every worktree, so the page abandons a call it no longer waits for (a newer one, the page
 * closed) and Hive stops measuring what nothing else waits for. `start` sends the call with its request; the earlier
 * one is abandoned after it, so a measurement both wait for carries on. `current` says whether a call is still the latest.
 */
export function useStorageRequests(): <T>(start: (request: string) => Promise<T>) => { result: Promise<T>; current: () => boolean } {
  const latest = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (latest.current) void call('storage:abandon', latest.current).catch(() => undefined)
      latest.current = null
    },
    []
  )
  return useCallback(<T,>(start: (request: string) => Promise<T>) => {
    const request = crypto.randomUUID()
    const result = start(request)
    if (latest.current) void call('storage:abandon', latest.current).catch(() => undefined)
    latest.current = request
    return { result, current: () => latest.current === request }
  }, [])
}

/** Project Settings → Storage (and the Assistant's in Settings → Workspace): what Hive keeps, Refresh, Clean Up… and Purge…. */
export function StorageView({ path }: { path: string }) {
  const [data, setData] = useState<ProjectStorage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [purging, setPurging] = useState(false)
  const request = useStorageRequests()
  const load = useCallback(
    (refresh: boolean) => {
      setMeasuring(true)
      setError(null)
      const { result, current } = request((r) => call('storage:project', path, refresh, r))
      result.then(
        (d) => current() && setData(d),
        (e) => current() && setError(errorMessage(e))
      ).finally(() => current() && setMeasuring(false))
    },
    [path, request]
  )
  useEffect(() => {
    setData(null)
    load(false)
  }, [load])

  if (error) return <LoadFailed inline what={tr(M.loadTarget)} error={error} onRetry={() => load(true)} />
  const rows: StorageRow[] = data
    ? [
        { label: tr(M.backups), where: '.hive/sessions', bytes: data.sessions, raw: data.sessionsRaw },
        { label: tr(M.archive), where: '.hive/archive', bytes: data.archive, raw: data.archiveRaw },
        { label: tr(M.attachments), where: '.hive/attachments', bytes: data.attachments },
        ...(data.cardAttachments ? [{ label: tr(M.cardAttachments), where: '.hive/attachments/cards', bytes: data.cardAttachments }] : []),
        ...data.worktrees.map((w) => ({ label: w.slot ? (w.agent ? tr(M.slot, { slot: w.slot, agent: w.agent }) : tr(M.freeSlot, { slot: w.slot })) : tr(M.agentWorktree, { agent: w.agent ?? '' }), where: w.path, bytes: w.bytes })),
        ...(data.copies ? [{ label: tr(M.copies), where: data.copies.path, bytes: data.copies.bytes }] : []),
        // The worktrees no agent works in (#353), on one line: the Overview lists and tidies them.
        ...(data.unusedWorktrees?.length
          ? [{ label: tr(M.unused, { count: data.unusedWorktrees.length }), where: fmt.list(data.unusedWorktrees.map((w) => w.branch ?? w.path), 'unit'), bytes: data.unusedWorktrees.reduce((n, w) => n + w.bytes, 0), review: data.path }]
          : [])
      ]
    : []
  return (
    <div className="storage">
      {!data ? (
        <div className="faint">
          <Icon name="loading" spin /> {tr(M.measuring)}
        </div>
      ) : (
        <DataTable
          id="storage-project"
          className="storage-table"
          rows={rows}
          columns={storageColumns()}
          rowKey={(r) => r.where}
          empty={tr(M.nothingKept)}
          foot={
            <tr className="storage-total">
              <td>{tr(M.total)}</td>
              <td className="num">{formatSize(data.total)}</td>
            </tr>
          }
        />
      )}
      <div className="storage-actions">
        <span className="faint small">{measuring ? (data ? tr(M.measuringAgain) : '') : data ? tr(M.measured, { when: timeAgo(data.computedAt) }) : ''}</span>
        <button className="btn subtle small" disabled={measuring} onClick={() => load(true)}>
          <Icon name="refresh" /> {tr(M.refresh)}
        </button>
        <button className="btn small" disabled={!data} onClick={() => setCleaning(true)}>
          <Icon name="trash" /> {tr(M.cleanUp)}
        </button>
        <button className="btn small" disabled={!data} onClick={() => setPurging(true)}>
          <Icon name="trash" /> {tr(M.purge)}
        </button>
      </div>
      {purging && data && (
        <PurgeDialog
          target={{ kind: 'project', projectPath: path }}
          name={data.assistant ? tr(M.assistant) : data.name}
          onClose={() => setPurging(false)}
          onDone={() => {
            setPurging(false)
            load(true)
          }}
        />
      )}
      {cleaning && data && (
        <CleanupDialog
          path={path}
          name={data.name}
          onClose={() => setCleaning(false)}
          onDone={() => {
            setCleaning(false)
            load(true)
          }}
        />
      )}
    </div>
  )
}

const cleanupColumns = (): DataColumn<CleanupItem>[] => [
  {
    key: 'what',
    header: tr(M.what),
    cell: (i) => (
      <span title={i.path}>
        {i.label} <span className="faint small mono">{i.path.split(/[\\/]/).slice(-2).join('/')}</span>
      </span>
    ),
    sortValue: (i) => i.label,
    filter: { kind: 'text', value: (i) => `${i.label} ${i.path}` }
  },
  { key: 'size', header: tr(M.size), num: true, descFirst: true, cell: (i) => formatSize(i.bytes), sortValue: (i) => i.bytes }
]

const KIND_LABEL: Record<CleanupItem['kind'], Msg> = {
  'archived-attachments': M.kindArchivedAttachments,
  'orphan-attachments': M.kindOrphanAttachments,
  'archived-backup': M.kindArchivedBackup,
  'gone-backup': M.kindGoneBackup
}

/** A days field that commits a whole number from 1 to 3650 (keeps the last good one while typing). */
function DaysInput({ value, disabled, onChange, label }: { value: number; disabled: boolean; onChange: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <input
      className="input days-input"
      type="number"
      min={1}
      max={3650}
      aria-label={label}
      disabled={disabled}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Math.floor(Number(e.target.value))
        if (n >= 1 && n <= 3650) onChange(n)
      }}
    />
  )
}

/** Clean Up…: choose what goes, see exactly which files and how much, then move them to the Recycle Bin. */
export function CleanupDialog({ path, name, onClose, onDone }: { path: string; name: string; onClose: () => void; onDone: () => void }) {
  const [attachmentsOn, setAttachmentsOn] = useState(DEFAULT_CLEANUP.archivedAttachmentsDays !== null)
  const [attachmentDays, setAttachmentDays] = useState(DEFAULT_CLEANUP.archivedAttachmentsDays ?? 90)
  const [orphans, setOrphans] = useState(DEFAULT_CLEANUP.orphanAttachments)
  const [backupsOn, setBackupsOn] = useState(DEFAULT_CLEANUP.archivedBackupsDays !== null)
  const [backupDays, setBackupDays] = useState(DEFAULT_CLEANUP.archivedBackupsDays ?? 90)
  const [gone, setGone] = useState(DEFAULT_CLEANUP.goneBackups)
  const [items, setItems] = useState<CleanupItem[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const action = useBusy()
  const opts: CleanupOptions = { archivedAttachmentsDays: attachmentsOn ? attachmentDays : null, orphanAttachments: orphans, archivedBackupsDays: backupsOn ? backupDays : null, goneBackups: gone }
  const key = JSON.stringify(opts)

  // The preview follows the options (a moment after the last change).
  useEffect(() => {
    let live = true
    setItems(null)
    setPreviewError(null)
    const t = setTimeout(() => {
      call('storage:cleanupPreview', path, JSON.parse(key) as CleanupOptions).then(
        (r) => live && setItems(r),
        (e) => live && setPreviewError(errorMessage(e))
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [path, key])

  const total = items?.reduce((n, i) => n + i.bytes, 0) ?? 0
  const go = async (): Promise<void> => {
    if (!items?.length) return
    const r = await action.run('clean', () => call('storage:cleanup', path, opts, items.map((i) => i.path)))
    if (!r) return
    const { removed, bytes, skipped } = r.value
    notify(removed ? 'success' : 'info', removed ? tr(M.moved, { count: removed, size: formatSize(bytes) }) : tr(M.nothingRemoved), skipped.length ? [tr(M.skipped, { count: skipped.length }), ...skipped].join('\n') : undefined)
    onDone()
  }

  const busy = !!action.busy
  const option = (on: boolean, set: (v: boolean) => void, title: React.ReactNode, desc: string, danger = false) => (
    <label className={cx('choice', on && 'selected', danger && on && 'danger')}>
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => set(e.target.checked)} />
      <div>
        <strong>{title}</strong>
        <div className="faint">{desc}</div>
      </div>
    </label>
  )
  const groups = (Object.keys(KIND_LABEL) as CleanupItem['kind'][]).map((k) => ({ kind: k, list: items?.filter((i) => i.kind === k) ?? [] })).filter((g) => g.list.length)

  return (
    <Modal
      title={tr(M.title, { name })}
      icon="trash"
      wide
      onClose={onClose}
      busy={busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <BusyButton className={gone ? 'danger' : 'primary'} disabled={!items?.length} busy={action.busy === 'clean'} busyLabel={tr(M.movingBusy)} onClick={() => void go()}>
            {items?.length ? tr(M.moveItems, { count: items.length, size: formatSize(total) }) : tr(M.move)}
          </BusyButton>
        </>
      }
    >
      <p className="faint" style={{ marginTop: 0 }}>
        {tr(M.neverTouched)}
      </p>
      <div className="choice-list cleanup-options">
        {option(
          attachmentsOn,
          setAttachmentsOn,
          <>{Children.toArray(tRich<React.ReactNode>(M.oldAttachments, { days: <DaysInput label={tr(M.attachmentDays)} value={attachmentDays} disabled={busy || !attachmentsOn} onChange={setAttachmentDays} /> }))}</>,
          tr(M.oldAttachmentsDesc)
        )}
        {option(orphans, setOrphans, tr(M.kindOrphanAttachments), tr(M.orphansDesc))}
        {option(
          backupsOn,
          setBackupsOn,
          <>{Children.toArray(tRich<React.ReactNode>(M.oldBackups, { days: <DaysInput label={tr(M.backupDays)} value={backupDays} disabled={busy || !backupsOn} onChange={setBackupDays} /> }))}</>,
          tr(M.oldBackupsDesc)
        )}
        {option(gone, setGone, tr(M.goneBackups), tr(M.goneBackupsDesc), true)}
      </div>
      {gone && (
        <div className="banner danger">
          <Icon name="warning" /> {tr(M.goneWarning)}
        </div>
      )}
      <div className="agent-dialog-h">{tr(M.whatGoes)}</div>
      {previewError ? (
        <div className="field-error">{previewError}</div>
      ) : !items ? (
        <div className="faint">
          <Icon name="loading" spin /> {tr(M.looking)}
        </div>
      ) : !items.length ? (
        <div className="faint">{tr(M.nothingMatches)}</div>
      ) : (
        <div className="cleanup-preview">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="cleanup-kind">
                {tr(KIND_LABEL[g.kind])} <span className="faint">· {tr(M.groupCount, { count: g.list.length, size: formatSize(g.list.reduce((n, i) => n + i.bytes, 0)) })}</span>
              </div>
              <DataTable id="storage-cleanup" rows={g.list} columns={cleanupColumns()} rowKey={(i) => i.path} defaultPageSize={10} filterFrom={10} empty={tr(M.nothing)} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

type WorkspaceRow = WorkspaceStorage['projects'][number]
const BIGGEST_FIRST = { key: 'size', desc: true }
const projectLabel = (p: WorkspaceRow): string => (p.assistant ? tr(M.assistant) : p.name)
/** Settings → Workspace's columns: each project (and the Assistant), its size, and a link to its Storage page. */
function workspaceColumns(assistantOpen: boolean, toggleAssistant: () => void): DataColumn<WorkspaceRow>[] {
  return [
    { key: 'project', header: tr(M.project), cell: projectLabel, sortValue: projectLabel, filter: { kind: 'text', value: projectLabel } },
    { key: 'size', header: tr(M.size), num: true, descFirst: true, cell: (p) => formatSize(p.total), sortValue: (p) => p.total },
    {
      key: 'actions',
      header: '',
      num: true,
      cell: (p) =>
        p.assistant ? (
          <button className="btn small subtle" onClick={toggleAssistant}>
            {tr(assistantOpen ? M.hide : M.storage)}
          </button>
        ) : (
          <button className="btn small subtle" onClick={() => openProjectSettings(p.path, 'storage')}>
            {tr(M.storage)}
          </button>
        )
    }
  ]
}

/** Settings → Workspace: the workspace's total and its projects, biggest first, each linked to its Storage page; Purge… for all of it. */
export function WorkspaceStorageList() {
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const workspaceName = useStore((s) => s.workspace?.name ?? '')
  const [data, setData] = useState<WorkspaceStorage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [purging, setPurging] = useState(false)
  const request = useStorageRequests()
  const load = useCallback(
    (refresh: boolean) => {
      if (!workspace) return
      setMeasuring(true)
      setError(null)
      const { result, current } = request((r) => call('storage:workspace', refresh, r))
      result
        .then(
          (d) => current() && setData(d),
          (e) => current() && setError(errorMessage(e))
        )
        .finally(() => current() && setMeasuring(false))
    },
    [workspace, request]
  )
  useEffect(() => {
    setData(null)
    load(false)
  }, [load])
  if (!workspace) return <div className="faint">{tr(M.noWorkspace)}</div>
  if (error) return <LoadFailed inline what={tr(M.loadTarget)} error={error} onRetry={() => load(true)} />
  const assistant = data?.projects.find((p) => p.assistant)
  return (
    <div className="storage">
      {!data ? (
        <div className="faint">
          <Icon name="loading" spin /> {tr(M.measuringProjects)}
        </div>
      ) : (
        <DataTable
          id="storage-workspace"
          className="storage-table"
          rows={data.projects}
          columns={workspaceColumns(assistantOpen, () => setAssistantOpen((o) => !o))}
          rowKey={(p) => p.path}
          defaultSort={BIGGEST_FIRST}
          defaultPageSize={10}
          filterFrom={10}
          empty={tr(M.noProjects)}
          foot={
            <tr className="storage-total">
              <td>{tr(M.workspace)}</td>
              <td className="num">{formatSize(data.total)}</td>
              <td />
            </tr>
          }
        />
      )}
      <div className="storage-actions">
        <span className="faint small">{measuring && data ? tr(M.measuringAgain) : ''}</span>
        <button className="btn subtle small" disabled={measuring} onClick={() => load(true)}>
          <Icon name="refresh" /> {tr(M.refresh)}
        </button>
        <button className="btn small" disabled={!data} onClick={() => setPurging(true)}>
          <Icon name="trash" /> {tr(M.purge)}
        </button>
      </div>
      {purging && (
        <PurgeDialog
          target={{ kind: 'workspace' }}
          name={workspaceName}
          onClose={() => setPurging(false)}
          onDone={() => {
            setPurging(false)
            load(true)
          }}
        />
      )}
      {assistantOpen && assistant && (
        <div className="storage-assistant">
          <div className="agent-dialog-h">{tr(M.assistant)}</div>
          <StorageView path={assistant.path} />
        </div>
      )}
    </div>
  )
}

const cardCleanupColumns = (): DataColumn<CardCleanupItem>[] => [
  {
    key: 'card',
    header: tr(M.cleanupCard),
    cell: (i) => (
      <span className="card-cleanup-card" title={i.title}>
        <strong>{i.key ?? `#${i.card}`}</strong> {i.title}
      </span>
    ),
    sortValue: (i) => i.card,
    filter: { kind: 'text', value: (i) => `${i.key ?? ''} ${i.title} ${i.files.map((f) => f.name).join(' ')}` }
  },
  { key: 'archived', header: tr(M.cleanupArchived), cell: (i) => <span title={formatDateTime(i.archivedAt)}>{timeAgo(i.archivedAt)}</span>, sortValue: (i) => i.archivedAt },
  { key: 'files', header: tr(M.size), num: true, descFirst: true, cell: (i) => `${tr(M.cleanupFiles, { count: i.files.length })}, ${formatSize(i.files.reduce((n, f) => n + f.size, 0))}`, sortValue: (i) => i.files.reduce((n, f) => n + f.size, 0) }
]

/**
 * Project Settings → Storage: when archived cards' attachments go (HI-1842: Never, or 3, 7, 30 or 90 days after archiving),
 * and Clean Up Now…, which lists what goes now and removes it at once.
 */
export function CardCleanupSetting({ path, name, value, onChange }: { path: string; name: string; value: CardCleanupChoice; onChange: (v: CardCleanupChoice) => void }) {
  const [open, setOpen] = useState(false)
  const options = settingEntry('project.cardAttachmentCleanup')?.options ?? []
  const off = cleanupDays(value) === null
  return (
    <div className="flex card-cleanup-setting">
      <select className="select" data-setting="cardAttachmentCleanup" value={value} onChange={(e) => onChange(e.target.value as CardCleanupChoice)}>
        {CARD_CLEANUP_CHOICES.map((c) => (
          <option key={c} value={c}>
            {shownText(options.find((o) => o.value === c)?.text ?? c)}
          </option>
        ))}
      </select>
      <button className="btn small" disabled={off} title={off ? tr(M.cleanUpOff) : undefined} onClick={() => setOpen(true)}>
        <Icon name="trash" /> {tr(M.cleanUpNow)}
      </button>
      {open && <CardCleanupDialog path={path} name={name} days={cleanupDays(value) ?? 0} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** Clean Up Now: the archived cards due now and their files, then each card's files to the Recycle Bin. */
function CardCleanupDialog({ path, name, days, onClose }: { path: string; name: string; days: number; onClose: () => void }) {
  const [items, setItems] = useState<CardCleanupItem[] | null>(null)
  const [plan, setPlan] = useState<{ id: string | null; more: boolean }>({ id: null, more: false })
  const [error, setError] = useState<string | null>(null)
  const action = useBusy()
  useEffect(() => {
    let live = true
    call('storage:cardCleanupPreview', path).then(
      (r) => {
        if (!live) return
        setPlan({ id: r.plan, more: r.more })
        setItems(r.items)
      },
      (e) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [path])
  const files = items?.reduce((n, i) => n + i.files.length, 0) ?? 0
  const bytes = items?.reduce((n, i) => n + i.files.reduce((t, f) => t + f.size, 0), 0) ?? 0
  const go = async (): Promise<void> => {
    if (!items?.length || !plan.id) return
    const id = plan.id
    const r = await action.run('clean', () => call('storage:cardCleanup', path, id))
    if (!r) return
    const done = r.value
    notify(done.files ? 'success' : 'info', done.files ? tr(M.cleanupDone, { files: done.files, cards: done.cards, size: formatSize(done.bytes) }) : tr(M.nothingRemoved), done.left ? tr(M.cleanupLeft, { count: done.left }) : undefined)
    onClose()
  }
  return (
    <Modal
      title={tr(M.cleanupTitle, { name })}
      icon="trash"
      wide
      onClose={onClose}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <BusyButton className="primary" disabled={!items?.length} busy={action.busy === 'clean'} busyLabel={tr(M.movingBusy)} onClick={() => void go()}>
            {items?.length ? tr(M.cleanupMove, { count: files, size: formatSize(bytes) }) : tr(M.move)}
          </BusyButton>
        </>
      }
    >
      <p className="faint" style={{ marginTop: 0 }}>
        {tr(M.cleanupIntro, { days })}
      </p>
      {error ? (
        <div className="field-error">{error}</div>
      ) : !items ? (
        <div className="faint">
          <Icon name="loading" spin /> {tr(M.looking)}
        </div>
      ) : !items.length ? (
        <div className="faint">{tr(M.cleanupNone)}</div>
      ) : (
        <>
          <DataTable id="storage-card-cleanup" className="card-cleanup-preview" rows={items} columns={cardCleanupColumns()} rowKey={(i) => String(i.card)} defaultPageSize={10} filterFrom={10} empty={tr(M.nothing)} />
          {plan.more && <p className="faint card-cleanup-more">{tr(M.cleanupMore, { count: items.length })}</p>}
        </>
      )}
    </Modal>
  )
}
