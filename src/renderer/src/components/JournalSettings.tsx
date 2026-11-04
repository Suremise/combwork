import { useCallback, useEffect, useState } from 'react'
import { JOURNAL_LIMITS, SCOPE_KINDS, type JournalSettings, type ScopeKind } from '@shared/journal'
import { msg, tr } from '@shared/i18n'
import { formatSize } from '@shared/units'
import { call, errorMessage } from '../api'
import { confirm, notify, useLanguage, useStore } from '../store'
import { NumberField } from './NumberField'
import { Icon, Switch } from './ui'

/**
 * Settings → Assistant → Journal (#1031): the workspace's Assistant journal on or off (off keeps it), what it may store,
 * how long everyday entries stay, the size cap, its size now, and Delete Journal…. The store is main/journal.ts.
 */

const KIND_TEXT: Record<ScopeKind, ReturnType<typeof msg>> = {
  decision: msg({ id: 'settings.journal.kind.decision', defaultMessage: 'Decisions', description: 'A kind of entry the Assistant may keep in its journal (Settings → Assistant → Journal): what was decided.' }),
  plan: msg({ id: 'settings.journal.kind.plan', defaultMessage: 'Plans', description: 'A kind of journal entry: what is planned.' }),
  event: msg({ id: 'settings.journal.kind.event', defaultMessage: 'Events', description: 'A kind of journal entry: what happened (Hive records lanes, merges and unexpected closes as events too).' }),
  incident: msg({ id: 'settings.journal.kind.incident', defaultMessage: 'Incidents', description: 'A kind of journal entry: something that went wrong.' }),
  insight: msg({ id: 'settings.journal.kind.insight', defaultMessage: 'Insights', description: 'A kind of journal entry: something learned.' }),
  preference: msg({ id: 'settings.journal.kind.preference', defaultMessage: 'Your preferences', description: 'A kind of journal entry: how the user likes things done. Off by default.' }),
  moment: msg({ id: 'settings.journal.kind.moment', defaultMessage: 'Moments', description: 'A kind of journal entry: a memorable moment of working together. Off by default.' })
}

const M = {
  on: msg({ id: 'settings.journal.on', defaultMessage: 'Keep a journal', description: 'A switch (Settings → Assistant → Journal): the Assistant keeps a journal in this workspace. Off keeps what is there.' }),
  offKeeps: msg({ id: 'settings.journal.offKeeps', defaultMessage: "Off, nothing is written and the Assistant's journal tools go at its next start; the entries are kept.", description: 'Under the journal switch when it is off.' }),
  scope: msg({ id: 'settings.journal.scope', defaultMessage: 'What it may store', description: 'A heading (Settings → Assistant → Journal): the kinds of entries the Assistant may keep.' }),
  retention: msg({ id: 'settings.journal.retention', defaultMessage: 'Keep everyday entries for', description: 'A label before a number of days (Settings → Assistant → Journal). Digests and important entries are kept longer.' }),
  days: msg({ id: 'settings.journal.days', defaultMessage: 'days (digests and important entries stay)', description: 'After the number of days everyday journal entries are kept.' }),
  cap: msg({ id: 'settings.journal.cap', defaultMessage: 'Size cap', description: "A label before the journal's size limit in MB (Settings → Assistant → Journal)." }),
  mb: msg({ id: 'settings.journal.mb', defaultMessage: 'MB (past it, the oldest everyday entries go first)', description: "After the journal's size limit in megabytes." }),
  noLimit: msg({ id: 'settings.journal.noLimit', defaultMessage: 'No limit', description: "A checkbox: the journal has no size limit." }),
  size: msg({ id: 'settings.journal.size', defaultMessage: 'Now {size}, {entries, plural, one {# entry} other {# entries}}.', description: "The journal's size on disk ({size}: \"1.2 MB\") and how many entries it has." }),
  none: msg({ id: 'settings.journal.none', defaultMessage: 'No journal yet.', description: 'The journal before the Assistant or Hive has written anything.' }),
  local: msg({ id: 'settings.journal.local', defaultMessage: 'Kept on this computer only, in .combwork/assistant/journal.db, and never sent anywhere.', description: 'A note under the journal settings (privacy). Keep the file path as it is.' }),
  noWorkspace: msg({ id: 'settings.journal.noWorkspace', defaultMessage: "Open a workspace to set its Assistant's journal.", description: 'Settings → Assistant → Journal with no workspace open.' }),
  delete: msg({ id: 'settings.journal.delete', defaultMessage: 'Delete Journal…', description: "A button: deletes the Assistant's journal of this workspace (asks first). The … says it asks: keep it." }),
  deleteTitle: msg({ id: 'settings.journal.deleteTitle', defaultMessage: "Delete the Assistant's journal?", description: "Title of the question before the Assistant's journal is deleted." }),
  deleteMessage: msg({ id: 'settings.journal.deleteMessage', defaultMessage: 'All {entries, plural, one {# entry} other {# entries}} of this workspace go to the Recycle Bin. The Assistant starts again with an empty journal.', description: "The question before the journal is deleted; {entries} is how many entries it has. Recycle Bin is Windows' name for it." }),
  deleteButton: msg({ id: 'settings.journal.deleteButton', defaultMessage: 'Delete', description: 'Button of the confirmation: deletes the journal.' }),
  deleted: msg({ id: 'settings.journal.deleted', defaultMessage: 'Journal deleted', description: "A notice after the Assistant's journal was deleted." }),
  failed: msg({ id: 'settings.journal.failed', defaultMessage: "Couldn't change the journal", description: "An error's title: saving the journal settings or deleting the journal failed (why follows)." })
}

type Status = { settings: JournalSettings; bytes: number; entries: number }

export function JournalSettingsPanel() {
  useLanguage()
  const workspace = useStore((s) => s.workspace?.path ?? null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    void call('journal:status').then(setStatus, (e) => notify('error', tr(M.failed), errorMessage(e)))
  }, [])
  useEffect(() => {
    setStatus(null)
    if (workspace) load()
  }, [workspace, load])
  if (!workspace) return <div className="muted">{tr(M.noWorkspace)}</div>
  if (!status) return null
  const s = status.settings
  const save = (patch: Partial<JournalSettings>): void => {
    setStatus({ ...status, settings: { ...s, ...patch } })
    setBusy(true)
    void call('journal:set', patch)
      .then(() => load(), (e) => {
        notify('error', tr(M.failed), errorMessage(e))
        load()
      })
      .finally(() => setBusy(false))
  }
  const toggleKind = (k: ScopeKind, on: boolean): void => save({ scope: SCOPE_KINDS.filter((x) => (x === k ? on : s.scope.includes(x))) })
  const remove = (): void => {
    void confirm({ title: tr(M.deleteTitle), message: tr(M.deleteMessage, { entries: status.entries }), confirmLabel: tr(M.deleteButton), danger: true }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void call('journal:delete')
        .then(() => notify('info', tr(M.deleted)), (e) => notify('error', tr(M.failed), errorMessage(e)))
        .finally(() => {
          setBusy(false)
          load()
        })
    })
  }
  return (
    <div className="journal-settings">
      <label className="flex">
        <Switch checked={s.enabled} label={tr(M.on)} disabled={busy} onChange={(v) => save({ enabled: v })} /> {tr(M.on)}
      </label>
      {!s.enabled && <div className="s-desc muted">{tr(M.offKeeps)}</div>}
      <div className="journal-scope" role="group" aria-label={tr(M.scope)}>
        <div className="s-title">{tr(M.scope)}</div>
        {SCOPE_KINDS.map((k) => (
          <label key={k} className="flex">
            <input type="checkbox" className="checkbox" data-kind={k} checked={s.scope.includes(k)} disabled={busy} onChange={(e) => toggleKind(k, e.target.checked)} /> {tr(KIND_TEXT[k])}
          </label>
        ))}
      </div>
      {/* NumberField (HI-2345): a blank box keeps the saved number and one out of range says so, saving nothing; a
          bare box saved Number('') (0), which main raised to the minimum and pruned to at once. */}
      <div className="flex journal-days">
        {tr(M.retention)}
        <NumberField value={s.retentionDays} min={JOURNAL_LIMITS.minRetentionDays} max={JOURNAL_LIMITS.maxRetentionDays} label={tr(M.retention)} disabled={busy} onCommit={(v) => {
            if (v !== null) save({ retentionDays: v })
          }} />
        {tr(M.days)}
      </div>
      <div className="flex journal-cap">
        {tr(M.cap)}
        <NumberField value={s.capMB} min={JOURNAL_LIMITS.minCapMB} max={JOURNAL_LIMITS.maxCapMB} label={tr(M.cap)} disabled={busy || s.capMB === null} onCommit={(v) => {
            if (v !== null && s.capMB !== null) save({ capMB: v })
          }} />
        {tr(M.mb)}
        <label className="flex">
          <input type="checkbox" className="checkbox journal-nolimit" checked={s.capMB === null} disabled={busy} onChange={(e) => save({ capMB: e.target.checked ? null : 50 })} /> {tr(M.noLimit)}
        </label>
      </div>
      <div className="journal-size muted">
        {status.entries || status.bytes ? tr(M.size, { size: formatSize(status.bytes), entries: status.entries }) : tr(M.none)} {tr(M.local)}
      </div>
      <button className="btn subtle" disabled={busy || (!status.entries && !status.bytes)} onClick={remove}>
        <Icon name="trash" /> {tr(M.delete)}
      </button>
    </div>
  )
}
