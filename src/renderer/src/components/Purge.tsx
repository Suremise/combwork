import { useEffect, useState } from 'react'
import type { PurgeItem, PurgePreview, PurgeTarget } from '@shared/types'
import { formatSize } from '@shared/units'
import { call, errorMessage } from '../api'
import { notify } from '../store'
import { cx } from '../util'
import { BusyButton, Icon, Modal, useBusy } from './ui'
import { DataTable, type DataColumn } from './DataTable'
import { msg, tr, type Msg } from '@shared/i18n'

const M = {
  title: msg({ id: 'workspace.purge.title', defaultMessage: '{scope, select, session {Purge Combwork\'s Files of "{name}"} project {Purge What Combwork Keeps for {name}} other {Purge What Combwork Keeps in {name}}}', description: "The Purge dialog's title: for a session ({name}: its name), a project ({name}: its name) or the workspace ({name}: its folder's name)." }),
  intro: msg({ id: 'workspace.purge.intro', defaultMessage: "Removes what Combwork keeps: its backups of the transcripts (the archive's too), attachments, and what is left of deleted sessions. The coding agents' own files (in ~/.claude, ~/.codex and ~/.copilot) are never touched, and running sessions are left alone. What the sessions used stays in the usage history, so the totals don't change.", description: 'The Purge dialog, at the top. Keep the paths as they are.' }),
  introSession: msg({ id: 'workspace.purge.introSession', defaultMessage: "Removes what Combwork keeps of this session: its backups of the transcript (the archive's too) and its attachments. The coding agent's own files (in ~/.claude, ~/.codex or ~/.copilot) are never touched. What the session used stays in the usage history, so the totals don't change.", description: 'The Purge dialog for one session, at the top. Keep the paths as they are.' }),
  recoverable: msg({ id: 'workspace.purge.recoverable', defaultMessage: "{count, plural, one {# leftover file is kept: it may be a session's only copy, left when Combwork stopped while deleting or moving it.} other {# leftover files are kept: they may be a session's only copy, left when Combwork stopped while deleting or moving it.}}", description: "The Purge dialog: leftover backup files Purge doesn't remove, because they may be all that's left of a session's transcript." }),
  running: msg({ id: 'workspace.purge.running', defaultMessage: '{count, plural, one {# running session is left alone.} other {# running sessions are left alone.}}', description: 'The Purge dialog: sessions running now, whose files are not listed.' }),
  lastCopies: msg({ id: 'workspace.purge.lastCopies', defaultMessage: "{count, plural, one {# session has no other copy: its CLI no longer has the transcript. It is deleted from Combwork, as Delete Session does, and can't be resumed or read afterwards.} other {# sessions have no other copy: their CLI no longer has the transcripts. They are deleted from Combwork, as Delete Session does, and can't be resumed or read afterwards.}} What they used still counts in the totals.", description: "The Purge dialog's warning when Hive's backup is a session's last copy. Delete Session is the Sessions tab's command." }),
  permanent: msg({ id: 'workspace.purge.permanent', defaultMessage: 'Delete permanently', description: "A Purge choice: delete instead of moving to the Recycle Bin." }),
  permanentDesc: msg({ id: 'workspace.purge.permanentDesc', defaultMessage: "Skip the Recycle Bin: what goes can't be restored.", description: 'Under the Purge choice "Delete permanently".' }),
  whatGoes: msg({ id: 'workspace.purge.whatGoes', defaultMessage: 'What goes', description: "The Purge dialog's heading over the files." }),
  looking: msg({ id: 'workspace.purge.looking', defaultMessage: 'Looking…', description: 'The Purge dialog while it finds the files.' }),
  nothing: msg({ id: 'workspace.purge.nothing', defaultMessage: 'Combwork keeps nothing here that Purge removes.', description: 'The Purge dialog when there is nothing to remove.' }),
  what: msg({ id: 'workspace.purge.what', defaultMessage: 'What', description: "The Purge dialog's tables: the column of what goes." }),
  project: msg({ id: 'workspace.purge.project', defaultMessage: 'Project', description: "The Purge dialog's tables for the workspace: the column of projects." }),
  assistant: msg({ id: 'workspace.purge.assistant', defaultMessage: 'Assistant', description: "The Purge dialog's tables: the Assistant, in the column of projects. Hive's name stays as it is." }),
  size: msg({ id: 'workspace.purge.size', defaultMessage: 'Size', description: "The Purge dialog's tables: the column of sizes." }),
  record: msg({ id: 'workspace.purge.record', defaultMessage: 'in its record', description: "The Purge dialog, beside old usage kept in a session's record (not a file)." }),
  lastCopy: msg({ id: 'workspace.purge.lastCopy', defaultMessage: 'last copy', description: "The Purge dialog, a tag beside a backup that is its session's last copy (the session is deleted with it)." }),
  groupCount: msg({ id: 'workspace.purge.groupCount', defaultMessage: '{count, plural, one {# item} other {# items}}, {size}', description: 'The Purge dialog, beside a group: how many and how big ({size}: "12 MB").' }),
  cancel: msg({ id: 'workspace.purge.cancel', defaultMessage: 'Cancel', description: "The Purge dialog's button that closes it." }),
  moveItems: msg({ id: 'workspace.purge.moveItems', defaultMessage: 'Move {count, plural, one {# item} other {# items}} ({size}) to the Recycle Bin', description: "The Purge dialog's button ({size}: \"12 MB\")." }),
  deleteItems: msg({ id: 'workspace.purge.deleteItems', defaultMessage: 'Delete {count, plural, one {# item} other {# items}} ({size}) permanently', description: "The Purge dialog's button with Delete permanently chosen ({size}: \"12 MB\")." }),
  purge: msg({ id: 'workspace.purge.button', defaultMessage: 'Purge', description: "The Purge dialog's button with nothing to remove." }),
  moving: msg({ id: 'workspace.purge.moving', defaultMessage: 'Moving to the Recycle Bin…', description: "The Purge dialog's button while it works." }),
  deleting: msg({ id: 'workspace.purge.deleting', defaultMessage: 'Deleting…', description: "The Purge dialog's button while it deletes permanently." }),
  moved: msg({ id: 'workspace.purge.moved', defaultMessage: 'Moved {count, plural, one {# item} other {# items}} ({size}) to the Recycle Bin', description: 'A notice after Purge ({size}: "12 MB").' }),
  deleted: msg({ id: 'workspace.purge.deleted', defaultMessage: 'Deleted {count, plural, one {# item} other {# items}} ({size}) permanently', description: 'A notice after Purge with Delete permanently ({size}: "12 MB").' }),
  sessionsDeleted: msg({ id: 'workspace.purge.sessionsDeleted', defaultMessage: '{count, plural, one {# session whose last copy went was deleted from Combwork.} other {# sessions whose last copy went were deleted from Combwork.}}', description: 'Under the notice after Purge: sessions deleted because their last copy went.' }),
  nothingRemoved: msg({ id: 'workspace.purge.nothingRemoved', defaultMessage: 'Nothing was removed', description: 'A notice after Purge when nothing went.' }),
  skipped: msg({ id: 'workspace.purge.skipped', defaultMessage: '{count, plural, one {# item skipped:} other {# items skipped:}}', description: "Under the notice after Purge: items left alone (each follows on a line, with why)." }),
  skippedItem: msg({ id: 'workspace.purge.skippedItem', defaultMessage: '{what}: {reason}', description: 'Under the notice after Purge, an item left alone ({what}: like "Transcript backups · fix-login") and why ({reason}: a sentence).' }),
  kindBackup: msg({ id: 'workspace.purge.kindBackup', defaultMessage: 'Transcript backups', description: "The Purge dialog, a group: Hive's copies of the sessions' transcripts (.combwork/sessions, .combwork/archive)." }),
  kindLeftover: msg({ id: 'workspace.purge.kindLeftover', defaultMessage: 'Leftover backup files', description: "The Purge dialog, a group: files left of Hive's backups (of deleted sessions, or half made when Hive stopped)." }),
  kindAttachments: msg({ id: 'workspace.purge.kindAttachments', defaultMessage: 'Attachments', description: 'The Purge dialog, a group: files pasted or dropped into sessions (.combwork/attachments).' }),
  kindOrphan: msg({ id: 'workspace.purge.kindOrphan', defaultMessage: 'Attachments of deleted sessions', description: 'The Purge dialog, a group: attachments whose session Hive no longer has.' }),
  kindKept: msg({ id: 'workspace.purge.kindKept', defaultMessage: 'Old usage on session records', description: "The Purge dialog, a group: usage figures kept on sessions' records from before the usage history (it has them now)." }),
  kindDeletedUsage: msg({ id: 'workspace.purge.kindDeletedUsage', defaultMessage: 'Old usage of deleted sessions', description: 'The Purge dialog, a group: usage figures kept for deleted sessions from before the usage history (it has them now).' })
}

const KIND_LABEL: Record<PurgeItem['kind'], Msg> = {
  backup: M.kindBackup,
  'leftover-backup': M.kindLeftover,
  attachments: M.kindAttachments,
  'orphan-attachments': M.kindOrphan,
  'kept-usage': M.kindKept,
  'deleted-usage': M.kindDeletedUsage
}

const hostLabel = (i: PurgeItem): string => (i.assistant ? tr(M.assistant) : i.hostName)

/** Its columns, worded when the table is drawn; the workspace's have the project too. */
const purgeColumns = (workspace: boolean): DataColumn<PurgeItem>[] => [
  {
    key: 'what',
    header: tr(M.what),
    cell: (i) => (
      <span title={i.path}>
        {i.label} <span className="faint small mono">{i.path ? i.path.split(/[\\/]/).slice(-2).join('/') : tr(M.record)}</span>
        {i.lastCopy && <span className="badge error purge-last-copy">{tr(M.lastCopy)}</span>}
      </span>
    ),
    sortValue: (i) => i.label,
    filter: { kind: 'text', value: (i) => `${i.label} ${i.path ?? ''}` }
  },
  ...(workspace ? [{ key: 'project', header: tr(M.project), cell: hostLabel, sortValue: hostLabel, filter: { kind: 'text' as const, value: hostLabel } }] : []),
  { key: 'size', header: tr(M.size), num: true, descFirst: true, cell: (i) => formatSize(i.bytes), sortValue: (i) => i.bytes }
]

/**
 * Purge… (#1138): everything Hive keeps for a session, a project or the workspace, listed with its size first, then
 * removed exactly as listed (main plans it again and skips what changed), to the Recycle Bin or permanently.
 * `beforeApply` runs just before (the Sessions tab closes its view of the session, which counts as in use).
 */
export function PurgeDialog({ target, name, onClose, onDone, beforeApply }: { target: PurgeTarget; name: string; onClose: () => void; onDone: () => void; beforeApply?: () => Promise<void> }) {
  const [preview, setPreview] = useState<PurgePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [permanent, setPermanent] = useState(false)
  const action = useBusy()
  const key = JSON.stringify(target)

  useEffect(() => {
    let live = true
    setPreview(null)
    setPreviewError(null)
    call('storage:purgePreview', JSON.parse(key) as PurgeTarget).then(
      (r) => live && setPreview(r),
      (e) => live && setPreviewError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [key])

  const items = preview?.items ?? []
  const total = items.reduce((n, i) => n + i.bytes, 0)
  const lastCopies = new Set(items.filter((i) => i.lastCopy).map((i) => `${i.host}|${i.sessionId}`)).size
  const go = async (): Promise<void> => {
    if (!items.length) return
    await beforeApply?.()
    const r = await action.run('purge', () => call('storage:purge', preview!.id, items.map((i) => i.key), permanent))
    if (!r) return
    const { removed, bytes, deleted, skipped } = r.value
    const byKey = new Map(items.map((i) => [i.key.toLowerCase(), i]))
    const lines = [
      ...(deleted ? [tr(M.sessionsDeleted, { count: deleted })] : []),
      ...(skipped.length
        ? [
            tr(M.skipped, { count: skipped.length }),
            ...skipped.map((s) => {
              const i = byKey.get(s.key.toLowerCase())
              return tr(M.skippedItem, { what: i ? `${tr(KIND_LABEL[i.kind])} · ${i.label}` : s.key, reason: s.reason })
            })
          ]
        : [])
    ]
    notify(removed ? 'success' : 'info', removed ? tr(permanent ? M.deleted : M.moved, { count: removed, size: formatSize(bytes) }) : tr(M.nothingRemoved), lines.length ? lines.join('\n') : undefined)
    onDone()
  }

  const busy = !!action.busy
  const groups = (Object.keys(KIND_LABEL) as PurgeItem['kind'][]).map((k) => ({ kind: k, list: items.filter((i) => i.kind === k) })).filter((g) => g.list.length)
  const workspace = target.kind === 'workspace'

  return (
    <Modal
      title={tr(M.title, { scope: target.kind, name })}
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
          <BusyButton className={permanent || lastCopies ? 'danger' : 'primary'} disabled={!items.length} busy={action.busy === 'purge'} busyLabel={tr(permanent ? M.deleting : M.moving)} onClick={() => void go()}>
            {items.length ? tr(permanent ? M.deleteItems : M.moveItems, { count: items.length, size: formatSize(total) }) : tr(M.purge)}
          </BusyButton>
        </>
      }
    >
      <p className="faint" style={{ marginTop: 0 }}>
        {tr(target.kind === 'session' ? M.introSession : M.intro)}
      </p>
      <div className="choice-list cleanup-options">
        <label className={cx('choice', permanent && 'selected', permanent && 'danger')}>
          <input type="checkbox" checked={permanent} disabled={busy} onChange={(e) => setPermanent(e.target.checked)} />
          <div>
            <strong>{tr(M.permanent)}</strong>
            <div className="faint">{tr(M.permanentDesc)}</div>
          </div>
        </label>
      </div>
      {!!lastCopies && (
        <div className="banner danger">
          <Icon name="warning" /> {tr(M.lastCopies, { count: lastCopies })}
        </div>
      )}
      {!!preview?.recoverable && (
        <div className="faint small purge-running">
          <Icon name="info" /> {tr(M.recoverable, { count: preview.recoverable })}
        </div>
      )}
      {!!preview?.running && (
        <div className="faint small purge-running">
          <Icon name="info" /> {tr(M.running, { count: preview.running })}
        </div>
      )}
      <div className="agent-dialog-h">{tr(M.whatGoes)}</div>
      {previewError ? (
        <div className="field-error">{previewError}</div>
      ) : !preview ? (
        <div className="faint">
          <Icon name="loading" spin /> {tr(M.looking)}
        </div>
      ) : !items.length ? (
        <div className="faint">{tr(M.nothing)}</div>
      ) : (
        <div className="cleanup-preview purge-preview">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="cleanup-kind">
                {tr(KIND_LABEL[g.kind])} <span className="faint">· {tr(M.groupCount, { count: g.list.length, size: formatSize(g.list.reduce((n, i) => n + i.bytes, 0)) })}</span>
              </div>
              <DataTable id={`storage-purge-${workspace ? 'workspace' : 'one'}`} rows={g.list} columns={purgeColumns(workspace)} rowKey={(i) => i.key} defaultPageSize={10} filterFrom={10} empty="" />
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
