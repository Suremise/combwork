import { useEffect, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { revisionShort } from '@shared/platform/descriptors'
import { queueShown, returnRun, returnWhy, runCheckName } from '@shared/progressQueue'
import type { ProjectInfo } from '@shared/types'
import type { QueueRecent, QueueView } from '@shared/workflow/queue'
import { call } from '../api'
import { set, useLanguage, useStore } from '../store'
import { timeAgo } from '../util'
import { QueueCard } from './ProgressQueue'
import { Icon } from './ui'

/**
 * The Git tab's Merge queue section (#1357, SPEC §16.9.3): each target's queue as the Progress panel's card shows it (now,
 * Pause queue / Resume queue), and its history, the latest 50 outcomes (card, revision, result or reason, when). A target
 * shows by #1356's rule (its state, old rulesets included), and while it has a history. Its own component: P6 moves it
 * into the Version Control tab as it is.
 */

const list = (items: string[]): string => fmt.list(items, 'conjunction')

const M = {
  region: msg({ id: 'git.queue.region', defaultMessage: 'Merge queues', description: "Accessible name of the Git tab's Merge queue section: the project's merge queues, a part per target branch. Glossary 2.5: merge queue." }),
  none: msg({ id: 'git.queue.none', defaultMessage: "No merge queue. When the project's workflow has Hive merge its cards (Project Settings → Workflow: Who merges), each target branch's queue shows here, with its history.", description: "The Git tab's Merge queue section when the project has no queue. Project Settings → Workflow and Who merges are Hive's names: keep them as Hive shows them. Glossary 2.5: merge queue." }),
  history: msg({ id: 'git.queue.history', defaultMessage: 'History of {target}', description: "A heading in the Git tab's Merge queue section: the latest outcomes of the queue for the branch {target} follow." }),
  noHistory: msg({ id: 'git.queue.noHistory', defaultMessage: 'Nothing merged or returned yet.', description: "The Git tab's Merge queue section, under a queue's history heading, when it has none yet." }),
  card: msg({ id: 'git.queue.card', defaultMessage: 'Card', description: "A column heading of the Git tab's merge queue history: the card." }),
  revision: msg({ id: 'git.queue.revision', defaultMessage: 'Revision', description: "A column heading of the Git tab's merge queue history: the card's revision the entry was for (a short commit id). Glossary: revision." }),
  outcome: msg({ id: 'git.queue.outcome', defaultMessage: 'Outcome', description: "A column heading of the Git tab's merge queue history: merged (with the result), returned (with why) or taken out." }),
  when: msg({ id: 'git.queue.when', defaultMessage: 'When', description: "A column heading of the Git tab's merge queue history: how long ago it happened." }),
  open: msg({ id: 'git.queue.open', defaultMessage: 'Open {card}', description: "Tooltip of a card's key in the Git tab's merge queue history: opens the card ({card})." }),
  merged: msg({ id: 'git.queue.merged', defaultMessage: 'Merged as {result}', description: "An outcome in the Git tab's merge queue history: the card was merged; the target's new commit follows ({result}: a short commit id)." }),
  returned: msg({ id: 'git.queue.returned', defaultMessage: 'Returned: {why}', description: "An outcome in the Git tab's merge queue history: the queue returned the card to its builder, and why ({why}: conflict in tasks.ts, checks failed: unit…). Glossary 2.4: returned." }),
  cancelled: msg({ id: 'git.queue.cancelled', defaultMessage: 'Taken out ({reason, select, removed {Remove from queue} stale {its pass no longer counts} hold {On Hold} decision {a decision} integratedOutside {merged outside Hive} other {cancelled}})', description: "An outcome in the Git tab's merge queue history: the card's entry was taken out of the queue, and why. Keep the select keys." })
}

/** The project's queues, read for themselves (the Progress panel on or off), again on each `queue-changed`. */
function useProjectQueues(projectPath: string): QueueView[] | null {
  const version = useStore((s) => s.queueVersion)
  const tasks = useStore((s) => s.tasks)
  const [views, setViews] = useState<QueueView[] | null>(null)
  useEffect(() => {
    let live = true
    void call('queue:list', projectPath).then(
      (v) => live && setViews(v),
      () => live && setViews([])
    )
    return () => {
      live = false
    }
  }, [projectPath, version, tasks])
  return views
}

export function GitQueueSection({ project }: { project: ProjectInfo }) {
  useLanguage()
  const views = useProjectQueues(project.path)
  const runs = useStore((s) => s.progressRuns)
  const now = Date.now()
  if (!views) return null
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

/** A target's history: its latest 50 outcomes, newest first. */
function QueueHistory({ project, view: v }: { project: ProjectInfo; view: QueueView }) {
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
  // A red check named by its run, as the panel names it (when Hive still keeps the run).
  const why = (r: QueueRecent): string => {
    const run = returnRun(v, r, runs)
    return returnWhy(r, run ? runCheckName(run) : null, v.target, tr, list)
  }
  const platform = project.platform?.id
  const short = (id: string): string => (platform ? revisionShort(platform, id) : id.slice(0, 7))
  return (
    <div className="git-queue-history">
      <div className="git-queue-history-h">{tr(M.history, { target: v.target })}</div>
      {rows && !rows.length && <div className="faint">{tr(M.noHistory)}</div>}
      {rows && rows.length > 0 && (
        <table className="git-queue-table">
          <thead>
            <tr>
              <th>{tr(M.card)}</th>
              <th>{tr(M.revision)}</th>
              <th>{tr(M.outcome)}</th>
              <th>{tr(M.when)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.entry}:${r.outcome}`} data-outcome={r.outcome} data-entry={r.entry}>
                <td>
                  <button type="button" className="link" title={tr(M.open, { card: r.key })} onClick={() => set({ taskOpen: r.card })}>
                    {r.key}
                  </button>{' '}
                  <span className="faint git-queue-title">{r.title}</span>
                </td>
                <td>{r.revision ? <code>{short(r.revision)}</code> : <span className="faint">–</span>}</td>
                <td>
                  <Icon name={r.outcome === 'merged' ? 'pass' : r.outcome === 'returned' ? 'error' : 'circle-slash'} />{' '}
                  {r.outcome === 'merged' ? tr(M.merged, { result: r.result ? short(r.result) : '' }) : r.outcome === 'returned' ? tr(M.returned, { why: why(r) }) : tr(M.cancelled, { reason: r.reason ?? 'other' /* i18n-ignore: a select's key, never shown */ })}
                </td>
                <td title={formatDateTime(r.at)}>{timeAgo(r.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
