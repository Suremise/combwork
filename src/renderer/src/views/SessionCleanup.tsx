import { useState } from 'react'
import type { SessionBulkProgress, SessionBulkResult, SessionListItem } from '@shared/types'
import { CLEANUP_AGES, cleanupPlan, type CleanupAction, type CleanupAge, type CleanupPlan, type CleanupSkip } from '@shared/sessionCleanup'
import { countText } from '@shared/sessionTree'
import { call } from '../api'
import { useStore } from '../store'
import { BusyButton, Icon, Modal, useBusy } from '../components/ui'
import { cx } from '../util'
import { fmt, msg, tr, type Msg } from '@shared/i18n'

/**
 * The Sessions tab's Clean Up… dialog (#895): pick an age and Archive (the default) or Delete, see what goes, and send
 * it through session:bulk, as the branch actions do. What it leaves alone before asking (running, open in the tab, the
 * Assistant's current conversation) comes back with the result, for the tab to report with main's skips.
 */
export function SessionCleanup({
  projectPath,
  items,
  kind,
  live,
  shown,
  current,
  skipText,
  onClose,
  onDone
}: {
  projectPath: string
  /** The sessions the tab lists (the Assistant's: its own conversations). */
  items: readonly SessionListItem[]
  kind: 'session' | 'conversation'
  live: (id: string) => boolean
  /** The session whose transcript the tab shows. */
  shown: string | null
  /** The Hive Assistant's current conversation (null in a project). */
  current: string | null
  /** A skip reason in a few words, as the result words it. */
  skipText: (reason: CleanupSkip) => string
  onClose: () => void
  onDone: (action: CleanupAction, r: SessionBulkResult, skipped: CleanupPlan['skipped']) => void
}) {
  const [age, setAge] = useState<CleanupAge>('week')
  const [action, setAction] = useState<CleanupAction>('archive')
  const busy = useBusy()
  const plan = cleanupPlan(items, { age, action, now: Date.now(), live, shown, current })
  const what = countText({ sessions: plan.go.filter((s) => !s.sub).length, subs: plan.go.filter((s) => !!s.sub).length })
  const archived = action === 'delete' ? plan.go.filter((s) => s.archived).length : 0
  const reasons = new Map<string, number>()
  for (const s of plan.skipped) reasons.set(skipText(s.reason), (reasons.get(skipText(s.reason)) ?? 0) + 1)
  const skips = fmt.list(
    [...reasons].map(([reason, n]) => tr(M.skipCount, { n, reason })),
    'unit'
  )

  const go = async (): Promise<void> => {
    const ids = plan.go.map((s) => s.id)
    const r = await busy.run('go', () => call('session:bulk', projectPath, action, ids))
    if (!r) return
    onClose()
    onDone(action, r.value, plan.skipped)
  }

  return (
    <Modal
      title={tr(M.title, { kind })}
      icon="clear-all"
      onClose={onClose}
      busy={!!busy.busy}
      error={busy.error}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>
            {tr(M.cancel)}
          </button>
          <BusyButton className={cx('cleanup-go', action === 'delete' ? 'danger' : 'primary')} disabled={!plan.go.length} busy={busy.busy === 'go'} busyLabel={tr(M.busy, { action })} onClick={() => void go()}>
            {tr(M.go, { action })}
          </BusyButton>
        </>
      }
    >
      <div className="agent-dialog-h">{tr(M.olderThan)}</div>
      <div className="cleanup-ages" role="radiogroup">
        {CLEANUP_AGES.map((a) => (
          <label key={a} className="flex" data-age={a}>
            <input type="radio" checked={age === a} onChange={() => setAge(a)} /> {tr(M.age, { age: a })}
          </label>
        ))}
      </div>
      <div className="choice-list">
        {ACTIONS.map((c) => (
          <label key={c.id} className={cx('choice', action === c.id && 'selected')} data-cleanup={c.id}>
            <input type="radio" checked={action === c.id} onChange={() => setAction(c.id)} />
            <div>
              <strong>
                <Icon name={c.icon} /> {tr(c.label)}
              </strong>
              <div className="faint">{tr(c.summary)}</div>
            </div>
          </label>
        ))}
      </div>
      <p className="cleanup-summary">
        <strong>{plan.go.length ? tr(M.summary, { what, age }) : tr(M.nothing, { age, action })}</strong>
        {archived > 0 && <> {tr(M.archived, { n: archived })}</>}
      </p>
      {plan.skipped.length > 0 && <p className="faint cleanup-skips">{tr(M.skipped, { skips })}</p>}
      <p className="faint">{tr(M.inUse)}</p>
      <BulkProgressNote projectPath={projectPath} kind={kind} />
    </Modal>
  )
}

/**
 * How far each bulk action on a host's sessions has got (#1659: 300 can take a minute), from main's session-bulk events,
 * in the window showing the host; nothing when none runs.
 */
export function BulkProgressNote({ projectPath, kind }: { projectPath: string; kind: 'session' | 'conversation' }) {
  const runs = useStore((s) => s.sessionBulk[projectPath.toLowerCase()] ?? NO_RUNS)
  return (
    <>
      {runs.map((p) => (
        <p key={p.id} className="hint sessions-bulk-progress" role="status">
          <Icon name="loading" spin /> {tr(M.progress, { action: p.action, kind, done: p.done, total: p.total })}
        </p>
      ))}
    </>
  )
}

const NO_RUNS: SessionBulkProgress[] = []

const ACTIONS: { id: CleanupAction; icon: string; label: Msg; summary: Msg }[] = [
  {
    id: 'archive',
    icon: 'archive',
    label: msg({ id: 'sessions.cleanup.archive', defaultMessage: 'Archive', description: 'A choice in Clean Up (Sessions tab): archive the old sessions (the default). Keep it short.' }),
    summary: msg({ id: 'sessions.cleanup.archiveSummary', defaultMessage: "Combwork's own sessions are hidden from the list and their transcripts kept in .hive/archive: tick Archived to see them, and unarchive any at any time.", description: 'Under the Archive choice in Clean Up: what archiving does (.hive/archive is a folder; Archived is a checkbox above the Sessions list: use its translation).' })
  },
  {
    id: 'delete',
    icon: 'trash',
    label: msg({ id: 'sessions.cleanup.delete', defaultMessage: 'Delete', description: 'A choice in Clean Up (Sessions tab): delete the old sessions from Hive. Keep it short.' }),
    summary: msg({ id: 'sessions.cleanup.deleteSummary', defaultMessage: "Archived ones too. Combwork's copies of their transcripts go to the Recycle Bin and Combwork stops listing them; what they used stays in the totals. Each CLI keeps its own transcript.", description: "Under the Delete choice in Clean Up: it takes archived sessions too; Hive's copies go to the Recycle Bin, usage stays counted, and the coding agents' CLIs keep their own transcripts." })
  }
]

const M = {
  title: msg({ id: 'sessions.cleanup.title', defaultMessage: '{kind, select, conversation {Clean Up Old Conversations} other {Clean Up Old Sessions}}', description: "Title of the Sessions tab's Clean Up dialog (the Hive Assistant's: conversations): archives or deletes sessions older than an age." }),
  olderThan: msg({ id: 'sessions.cleanup.olderThan', defaultMessage: 'Last active more than', description: 'In Clean Up, above the ages (24 hours, 7 days, 30 days): sessions whose last activity is longer ago than the one picked.' }),
  age: msg({ id: 'sessions.cleanup.age', defaultMessage: '{age, select, day {24 hours ago} week {7 days ago} other {30 days ago}}', description: 'An age to pick in Clean Up, after "Last active more than": 24 hours, 7 days or 30 days ago.' }),
  summary: msg({ id: 'sessions.cleanup.summary', defaultMessage: '{what} older than {age, select, day {24 hours} week {7 days} other {30 days}}.', description: 'In Clean Up: what goes ({what}: "3 sessions and 12 sub-sessions"), last active more than 24 hours, 7 days or 30 days ago.' }),
  nothing: msg({ id: 'sessions.cleanup.nothing', defaultMessage: 'Nothing older than {age, select, day {24 hours} week {7 days} other {30 days}} to {action, select, archive {archive} other {delete}}.', description: 'In Clean Up: no session last active more than 24 hours, 7 days or 30 days ago is left to archive or delete.' }),
  archived: msg({ id: 'sessions.cleanup.archived', defaultMessage: '{n, plural, one {# of them is archived.} other {# of them are archived.}}', description: 'In Clean Up, after what Delete takes: how many of those sessions are archived ones.' }),
  skipCount: msg({ id: 'sessions.cleanup.skipCount', defaultMessage: '{n, number} {reason}', description: 'How many old sessions Clean Up leaves alone for one reason ({reason}: "running", "open here"), listed after "Left alone:".' }),
  skipped: msg({ id: 'sessions.cleanup.skipped', defaultMessage: 'Left alone: {skips}.', description: 'In Clean Up: the old sessions it leaves alone and why ({skips}: "1 running, 1 open here").' }),
  inUse: msg({ id: 'sessions.cleanup.inUse', defaultMessage: 'Running sessions, the one open here and any whose files are in use are always left alone; the result says which.', description: 'In Clean Up: which sessions are never archived or deleted (running, the transcript open in the tab, files in use), and that the result lists them.' }),
  cancel: msg({ id: 'sessions.cleanup.cancel', defaultMessage: 'Cancel', description: 'Button: closes Clean Up without doing anything.' }),
  go: msg({ id: 'sessions.cleanup.go', defaultMessage: '{action, select, archive {Archive} other {Delete}}', description: 'Button of Clean Up: archives or deletes the old sessions. Keep it short.' }),
  progress: msg({
    id: 'sessions.bulk.progress',
    defaultMessage:
      '{action, select, archive {{kind, select, conversation {Archiving {done, number} of {total, plural, one {# conversation} other {# conversations}}…} other {Archiving {done, number} of {total, plural, one {# session} other {# sessions}}…}}} unarchive {{kind, select, conversation {Unarchiving {done, number} of {total, plural, one {# conversation} other {# conversations}}…} other {Unarchiving {done, number} of {total, plural, one {# session} other {# sessions}}…}}} other {{kind, select, conversation {Deleting {done, number} of {total, plural, one {# conversation} other {# conversations}}…} other {Deleting {done, number} of {total, plural, one {# session} other {# sessions}}…}}}}',
    description: "While many sessions are archived, unarchived or deleted at once (Clean Up, or a branch's Archive All): how many of them ({done}) of how many ({total}) it has been through so far. The Hive Assistant's: conversations."
  }),
  busy: msg({ id: 'sessions.cleanup.busy', defaultMessage: '{action, select, archive {Archiving…} other {Deleting…}}', description: 'The Clean Up button while it archives or deletes.' })
}
