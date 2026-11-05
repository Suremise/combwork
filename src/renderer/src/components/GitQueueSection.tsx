import { useEffect, useMemo, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { revisionShort } from '@shared/platform/descriptors'
import { nextChange, queueShown, returnCheck, returnRun, returnWhy } from '@shared/progressQueue'
import type { ProgressRun, ProjectInfo } from '@shared/types'
import type { QueueRecent, QueueView } from '@shared/workflow/queue'
import { call, callShared } from '../api'
import { set, useLanguage, useStore } from '../store'
import { timeAgo } from '../util'
import { DataTable, useDateColumns, type DataColumn } from './DataTable'
import { QueueCard, RevisionButton } from './ProgressQueue'
import { Icon } from './ui'

/**
 * The Version Control tab's Merge queue section (#1357, SPEC §16.9.3): each target's queue as the Progress panel's card shows it (now,
 * Pause queue / Resume queue), and its history, the latest 50 outcomes (card, revision, result or reason, when). A target
 * shows by #1356's rule (its state, old rulesets included), and while it has a history. Placed in the Version Control
 * tab as it was (#1416), for None too while an old Git ruleset's queue is there.
 */

const list = (items: string[]): string => fmt.list(items, 'conjunction')

const M = {
  region: msg({ id: 'git.queue.region', defaultMessage: 'Merge queues', description: "Accessible name of the Git tab's Merge queue section: the project's merge queues, a part per target branch. Glossary 2.5: merge queue." }),
  reading: msg({ id: 'git.queue.reading', defaultMessage: 'Reading the merge queues…', description: "The Version Control tab's Merge queue section while the project's queues are read. Glossary 2.5: merge queue." }),
  none: msg({ id: 'git.queue.none', defaultMessage: "No merge queue. When the project's workflow has Combwork merge its cards (Version Control → Workflow: Who merges), each target branch's queue shows here, with its history.", description: "The Version Control tab's Merge queue section when the project has no queue. Version Control → Workflow and Who merges are Combwork's names: keep them as Combwork shows them. Glossary 2.5: merge queue." }),
  history: msg({ id: 'git.queue.history', defaultMessage: 'History of {target}', description: "A heading in the Git tab's Merge queue section: the latest outcomes of the queue for the branch {target} follow." }),
  noHistory: msg({ id: 'git.queue.noHistory', defaultMessage: 'Nothing merged or returned yet.', description: "The Git tab's Merge queue section, under a queue's history heading, when it has none yet." }),
  card: msg({ id: 'git.queue.card', defaultMessage: 'Card', description: "A column heading of the Git tab's merge queue history: the card." }),
  revision: msg({ id: 'git.queue.revision', defaultMessage: 'Revision', description: "A column heading of the Git tab's merge queue history: the card's revision the entry was for (a short commit id). Glossary: revision." }),
  outcome: msg({ id: 'git.queue.outcome', defaultMessage: 'Outcome', description: "A column heading of the Git tab's merge queue history: merged (with the result), returned (with why) or taken out." }),
  when: msg({ id: 'git.queue.when', defaultMessage: 'When', description: "A column heading of the Git tab's merge queue history: how long ago it happened." }),
  title: msg({ id: 'git.queue.title', defaultMessage: 'Title', description: "A column heading of the Git tab's merge queue history: the card's title." }),
  result: msg({ id: 'git.queue.result', defaultMessage: 'Merge commit', description: "A column heading of the Git tab's merge queue history: for a merged card, the target's new commit (a short commit id)." }),
  open: msg({ id: 'git.queue.open', defaultMessage: 'Open {card}', description: "Accessible name of a row of the Git tab's merge queue history: opens the card ({card}: its key)." }),
  mergedShort: msg({ id: 'git.queue.mergedShort', defaultMessage: 'Merged', description: "An outcome in the Git tab's merge queue history (one short word or two: the full outcome is its tooltip): the card was merged." }),
  returnedShort: msg({ id: 'git.queue.returnedShort', defaultMessage: 'Returned', description: "An outcome in the Git tab's merge queue history (one short word or two: why is its tooltip): the queue returned the card to its builder. Glossary 2.4: returned." }),
  cancelledShort: msg({ id: 'git.queue.cancelledShort', defaultMessage: 'Taken out', description: "An outcome in the Git tab's merge queue history (one short word or two: why is its tooltip): the card's entry was taken out of the queue." }),
  merged: msg({ id: 'git.queue.merged', defaultMessage: 'Merged as {result}', description: "Tooltip of an outcome in the Git tab's merge queue history: the card was merged; the target's new commit follows ({result}: a short commit id)." }),
  returned: msg({ id: 'git.queue.returned', defaultMessage: 'Returned: {why}', description: "Tooltip of an outcome in the Git tab's merge queue history: the queue returned the card to its builder, and why ({why}: conflict in tasks.ts, checks failed: unit…). Glossary 2.4: returned." }),
  cancelled: msg({ id: 'git.queue.cancelled', defaultMessage: 'Taken out ({reason, select, removed {Remove from queue} stale {its pass no longer counts} hold {On Hold} decision {a decision} integratedOutside {merged outside Combwork} other {cancelled}})', description: "Tooltip of an outcome in the Git tab's merge queue history: the card's entry was taken out of the queue, and why. Keep the select keys." })
}

const OUTCOMES: QueueRecent['outcome'][] = ['merged', 'returned', 'cancelled']
const outcomeIcon = (o: QueueRecent['outcome']): string => (o === 'merged' ? 'pass' : o === 'returned' ? 'error' : 'circle-slash')
const outcomeLabel = (o: string): string => tr(o === 'merged' ? M.mergedShort : o === 'returned' ? M.returnedShort : M.cancelledShort)

/**
 * The project's queues, read for themselves (the Progress panel on or off), again on each `queue-changed`. Only this
 * project's answer is returned (null until it has one: another project's never shows here, #1416's round 1), and the
 * caller renders again when a return or a merge it shows expires by time alone (`nextChange`).
 */
export function useProjectQueues(projectPath: string): QueueView[] | null {
  const version = useStore((s) => s.queueVersion)
  const tasks = useStore((s) => s.tasks)
  const [read, setRead] = useState<{ for: string; views: QueueView[] } | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    let live = true
    void callShared('queue:list', projectPath).then(
      (v) => live && setRead({ for: projectPath, views: v }),
      () => live && setRead({ for: projectPath, views: [] })
    )
    return () => {
      live = false
    }
  }, [projectPath, version, tasks])
  const views = read?.for === projectPath ? read.views : null
  const next = views ? nextChange(views, Date.now()) : null
  useEffect(() => {
    if (next === null) return
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [next])
  return views
}

export function GitQueueSection({ project }: { project: ProjectInfo }) {
  useLanguage()
  const views = useProjectQueues(project.path)
  const runs = useStore((s) => s.progressRuns)
  const now = Date.now()
  // Never an empty section while the queues are read (#1484: slow under load, it looked like nothing to show).
  if (!views)
    return (
      <div className="git-queue" role="region" aria-label={tr(M.region)} aria-busy="true">
        <div className="pane-empty" data-queue-reading="">
          <Icon name="loading" spin /> {tr(M.reading)}
        </div>
      </div>
    )
  const shown = views.filter((v) => queueShown(v, now) || v.recent.length > 0).sort((a, b) => a.target.localeCompare(b.target))
  return (
    <div className="git-queue" role="region" aria-label={tr(M.region)}>
      {!shown.length && <div className="pane-empty">{tr(M.none)}</div>}
      {shown.map((v) => (
        <section key={v.target} className="git-queue-target" data-target={v.target}>
          <QueueCard view={v} runs={runs} now={now} showProject={false} />
          <QueueHistory project={project} view={v} />
        </section>
      ))}
    </div>
  )
}

/**
 * The history's columns (#1641, as the archived cards' table): one line a row, the title ellipsised with its whole text
 * as a tooltip, revisions short in a column that never wraps (a click copies the whole id), the outcome a short label
 * with its detail (the merge commit, why it was returned or taken out) as its tooltip.
 */
function historyColumns(v: QueueView, runs: readonly ProgressRun[], short: (id: string) => string): DataColumn<QueueRecent>[] {
  // A red check named by its run, as the panel names it (when Hive still keeps the run).
  const why = (r: QueueRecent): string => {
    const run = returnRun(v, r, runs)
    return returnWhy(r, returnCheck(r, run), v.target, tr, list)
  }
  const detail = (r: QueueRecent): string => (r.outcome === 'merged' ? tr(M.merged, { result: r.result ? short(r.result) : '' }) : r.outcome === 'returned' ? tr(M.returned, { why: why(r) }) : tr(M.cancelled, { reason: r.reason ?? 'other' /* i18n-ignore: a select's key, never shown */ }))
  const revision = (id: string | undefined): React.ReactNode => (id ? <RevisionButton revision={id} short={short} /> : <span className="faint">–</span>)
  return [
    { key: 'card', header: tr(M.card), className: 'nowrap', cell: (r) => <span className="task-number">{r.key}</span>, sortValue: (r) => r.card, filter: { kind: 'text', value: (r) => r.key } },
    {
      key: 'title',
      header: tr(M.title),
      className: 'git-queue-title-cell',
      cell: (r) => (
        <span className="git-queue-title" title={r.title}>
          {r.title}
        </span>
      ),
      sortValue: (r) => r.title,
      filter: { kind: 'text', value: (r) => r.title }
    },
    { key: 'revision', header: tr(M.revision), className: 'nowrap', cell: (r) => revision(r.revision) },
    {
      key: 'outcome',
      header: tr(M.outcome),
      className: 'nowrap',
      cell: (r) => (
        <span className="git-queue-outcome" data-outcome={r.outcome} title={detail(r)}>
          <Icon name={outcomeIcon(r.outcome)} /> {outcomeLabel(r.outcome)}
        </span>
      ),
      sortValue: (r) => OUTCOMES.indexOf(r.outcome),
      filter: { kind: 'choice', value: (r) => r.outcome },
      choiceLabel: outcomeLabel
    },
    { key: 'result', header: tr(M.result), className: 'nowrap git-queue-result', cell: (r) => revision(r.outcome === 'merged' ? r.result : undefined) },
    { key: 'when', header: tr(M.when), className: 'nowrap', descFirst: true, cell: (r) => <span title={formatDateTime(r.at)}>{timeAgo(r.at)}</span>, sortValue: (r) => r.at }
  ]
}

/** A target's history: its latest 50 outcomes, newest first. */
function QueueHistory({ project, view: v }: { project: ProjectInfo; view: QueueView }) {
  const language = useLanguage()
  const version = useStore((s) => s.queueVersion)
  const [rows, setRows] = useState<QueueRecent[] | null>(null)
  useEffect(() => {
    let live = true
    void call('queue:history', project.path, v.target).then(
      (r) => live && setRows(r),
      () => live && setRows([])
    )
    return () => {
      live = false
    }
  }, [project.path, v.target, version])
  const runs = useStore((s) => s.progressRuns)
  const platform = project.platform?.id
  const columns = useDateColumns(
    useMemo(() => {
      const short = (id: string): string => (platform ? revisionShort(platform, id) : id.slice(0, 7))
      return historyColumns(v, runs, short)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [v, runs, platform, language])
  )
  return (
    <div className="git-queue-history">
      <div className="git-queue-history-h">{tr(M.history, { target: v.target })}</div>
      {rows && (
        <DataTable
          id="queue-history"
          className="git-queue-table"
          rows={rows}
          columns={columns}
          rowKey={(r) => `${r.entry}:${r.outcome}`}
          defaultSort={{ key: 'when', desc: true }}
          defaultPageSize={20}
          empty={tr(M.noHistory)}
          onRowClick={(r) => set({ taskOpen: r.card })}
          rowLabel={(r) => tr(M.open, { card: r.key })}
        />
      )}
    </div>
  )
}
