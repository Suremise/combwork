import { useEffect, useRef, useState } from 'react'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { pauseText, returnRun, returnWhy, runCheckName, stepText } from '@shared/progressQueue'
import { QUEUE_ADVANCE_GATE } from '@shared/workflow/facts'
import type { QueueRecent, QueueStuck, QueueView } from '@shared/workflow/queue'
import type { WorkView } from '@shared/workflow/workView'
import type { ProgressRun, TaskCard } from '@shared/types'
import { attempt } from '../actions'
import { call } from '../api'
import { useForYou } from '../forYou'
import { showQueueRun } from '../queueSource'
import { confirm, notify, useStore } from '../store'
import { timeAgo } from '../util'
import { Icon } from './ui'

/**
 * The merge queue on a card (#1357, SPEC §16.9.2 and §16.9.3): the Work section's Merge queue part. Where the card's
 * entry stands (queued with its place, testing with its step and run, merging), how it ended (returned with why, the
 * files, the output's last lines and Show log, with Retry merge; taken out), the queue's pause with Resume, an advance
 * that stopped part way (the branch, the ref, each file and its side, the commands that finish or undo it, to copy:
 * nothing runs them), and the OK an update of a checked-out target waits for. From the card's facts (its work view)
 * and its target's queue (`queue:list`), whatever the project's options now: the card's own ruleset decided.
 */

const list = (items: string[]): string => fmt.list(items, 'conjunction')
/** The last lines of a return's output the section shows (the rest is Show log's). */
const TAIL_LINES = 12

const M = {
  heading: msg({ id: 'board.workQueue.heading', defaultMessage: 'Merge queue', description: "A sub-heading in the card dialog's Work section: where the card stands in the merge queue follows. Glossary 2.5: merge queue." }),
  queued: msg({ id: 'board.workQueue.queued', defaultMessage: 'Queued for {target}: {position, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} in line', description: "The card dialog's Work section: the card waits in the merge queue for the branch {target}, at place {position} (1st: next; the card testing now counts). Glossary 2.5: merge queue." }),
  queuedNoPlace: msg({ id: 'board.workQueue.queuedNoPlace', defaultMessage: 'Queued for {target}', description: "The card dialog's Work section: the card waits in the merge queue for the branch {target} (its place isn't known here: another Hive runs the queue)." }),
  approved: msg({ id: 'board.workQueue.approved', defaultMessage: 'Approved revision', description: "A label in the card dialog's Work section's merge queue part: the revision that was approved and is merged follows (a short commit id). Glossary: revision." }),
  testing: msg({ id: 'board.workQueue.testing', defaultMessage: 'Testing now: {step}', description: "The card dialog's Work section: the merge queue is testing the card now, at a step ({step}: test merge, merge checks, check: unit, merging into main). Glossary 2.5: merge queue." }),
  showRun: msg({ id: 'board.workQueue.showRun', defaultMessage: 'Show the run', description: "A button in the card dialog's Work section: shows the merge check running now in the Progress panel's Runs tab." }),
  advancing: msg({ id: 'board.workQueue.advancing', defaultMessage: 'Merging into {target} now', description: "The card dialog's Work section: the merge queue is moving the branch {target} to the card's merged result now." }),
  returned: msg({ id: 'board.workQueue.returned', defaultMessage: 'Returned {when}: {why}', description: "The card dialog's Work section: the merge queue returned the card to its builder ({when}: how long ago), and why ({why}: conflict in tasks.ts, checks failed: unit, a hook failed…). Glossary 2.4: returned." }),
  conflictFiles: msg({ id: 'board.workQueue.conflictFiles', defaultMessage: 'Files in conflict', description: "A label in the card dialog's Work section: the files the merge conflicted in follow." }),
  output: msg({ id: 'board.workQueue.output', defaultMessage: '{n, plural, one {Its output’s last line} other {Its output’s last # lines}}', description: "A label in the card dialog's Work section: the last lines ({n}) of what the failed check or hook printed follow." }),
  showLog: msg({ id: 'board.queue.showLog', defaultMessage: 'Show log', description: "A button on a merge queue's returned card in the Progress panel: shows the failed check's log (or the hook's output)." }),
  hideLog: msg({ id: 'board.workQueue.hideLog', defaultMessage: 'Hide the output', description: "A button in the card dialog's Work section: hides a return's whole output shown above it." }),
  retry: msg({ id: 'board.workQueue.retry', defaultMessage: 'Retry merge…', description: "A button in the card dialog's Work section on a card the merge queue returned: queues its approved revision again, unchanged (asks first)." }),
  retryTitle: msg({ id: 'board.workQueue.retryTitle', defaultMessage: 'Retry {card}’s merge?', description: "Title of the confirmation before Retry merge ({card}: the card's key)." }),
  retryMessage: msg({ id: 'board.workQueue.retryMessage', defaultMessage: 'This queues {revision} again, unchanged: the revision that was approved, not a new one. Once per revision.', description: "The confirmation before Retry merge: the same approved revision ({revision}, a short commit id) goes back into the merge queue; it can be done once per revision. Glossary: revision." }),
  retryConfirm: msg({ id: 'board.workQueue.retryConfirm', defaultMessage: 'Retry merge', description: 'The button confirming Retry merge. Keep it short.' }),
  retryFailed: msg({ id: 'board.workQueue.retryFailed', defaultMessage: "Couldn't retry the merge", description: "An error's title: Retry merge failed (the card dialog); its message says why." }),
  retried: msg({ id: 'board.workQueue.retried', defaultMessage: 'Queued again by Retry merge.', description: "The card dialog's Work section: the card's revision was queued again, unchanged, by the user's Retry merge." }),
  cancelled: msg({ id: 'board.workQueue.cancelled', defaultMessage: '{reason, select, removed {Taken out of the queue (Remove from queue).} stale {Taken out of the queue: its pass no longer counts.} hold {Taken out of the queue: the card went On Hold.} decision {Taken out of the queue: a decision was recorded.} integratedOutside {Taken out of the queue: it was merged outside Hive.} other {Taken out of the queue.}}', description: "The card dialog's Work section: the card's merge queue entry was cancelled, and why. Keep the select keys. Glossary: merge queue, On Hold, decision, outside Hive." }),
  paused: msg({ id: 'board.workQueue.paused', defaultMessage: 'The queue for {target} is paused', description: "A heading line in the card dialog's Work section: the merge queue for the branch {target} is paused (why follows)." }),
  resume: msg({ id: 'board.queue.resume', defaultMessage: 'Resume queue', description: "A button on a paused merge queue's card in the Progress panel: clears the pause once its cause is fixed. Glossary 2.5: Resume queue." }),
  resumeFailed: msg({ id: 'board.queue.resumeFailed', defaultMessage: "Couldn't resume the merge queue", description: "An error's title: Resume queue failed (Progress panel)." }),
  stillPaused: msg({ id: 'board.queue.stillPaused', defaultMessage: 'The merge queue is still paused', description: "A notification's title after Resume queue: what paused it still holds, so it paused again. Its message says why." }),
  stuck: msg({ id: 'board.workQueue.stuck', defaultMessage: 'Its merge into {target} stopped part way. Hive changes nothing more on its own: put it right with one of the commands below, then answer under For you.', description: "The card dialog's Work section: the merge queue's update of the checked-out branch {target} stopped half done (a crash, another program); the user settles it by hand. For you: where the card's request waits (glossary 2.3)." }),
  stuckFolder: msg({ id: 'board.workQueue.stuckFolder', defaultMessage: 'Folder', description: "A label in the card dialog's Work section: the folder the target is checked out in follows (a path)." }),
  stuckBranch: msg({ id: 'board.workQueue.stuckBranch', defaultMessage: 'Its branch', description: "A label in the card dialog's Work section: the branch that folder is on now follows (or that it is on none)." }),
  noBranch: msg({ id: 'board.workQueue.noBranch', defaultMessage: 'none (a detached HEAD)', description: "In the card dialog's Work section, after Its branch: the folder isn't on any branch. HEAD is git's: keep it." }),
  stuckRef: msg({ id: 'board.workQueue.stuckRef', defaultMessage: '{target} is at', description: "A label in the card dialog's Work section: the commit the branch {target} points at now follows." }),
  unreadRef: msg({ id: 'board.workQueue.unreadRef', defaultMessage: 'not read', description: "In the card dialog's Work section: where the branch points couldn't be read." }),
  expected: msg({ id: 'board.workQueue.expected', defaultMessage: 'Before the merge', description: "A label in the card dialog's Work section: the commit the branch was at before the merge follows." }),
  result: msg({ id: 'board.workQueue.result', defaultMessage: 'The merge', description: "A label in the card dialog's Work section: the merged commit follows." }),
  files: msg({ id: 'board.workQueue.files', defaultMessage: '{n, plural, one {# file, and where it is} other {# files, and where each is}}', description: "A sub-heading in the card dialog's Work section, over the files a stopped merge left: how many ({n}), and for each whether it is as before the merge, as merged, or neither." }),
  side: msg({ id: 'board.workQueue.side', defaultMessage: '{side, select, expected {as before the merge} result {as merged} other {neither}}', description: "Beside a file in the card dialog's Work section: whether its contents are as before the merge, as merged, or neither. Keep the select keys." }),
  commands: msg({ id: 'board.workQueue.commands', defaultMessage: 'Commands (PowerShell): nothing runs them for you', description: "A sub-heading in the card dialog's Work section, over the git commands that finish or undo a stopped merge: the user runs them in PowerShell; Hive doesn't." }),
  command: msg({ id: 'board.workQueue.command', defaultMessage: '{purpose, select, finish {To finish it} other {To undo it}}, in {folder}', description: "Above a command in the card dialog's Work section: what it does (finish or undo the stopped merge) and the folder to run it in ({folder}: its name, such as alpha; the full path on hover). Keep the select keys." }),
  noCommands: msg({ id: 'board.workQueue.noCommands', defaultMessage: 'Its files are neither as they were nor as merged: put them right by hand.', description: "In the card dialog's Work section when no command can settle a stopped merge: the user fixes the files by hand." }),
  copy: msg({ id: 'board.workQueue.copy', defaultMessage: 'Copy', description: "A button beside a command in the card dialog's Work section: copies it. Keep it short." }),
  copyNamed: msg({ id: 'board.workQueue.copyNamed', defaultMessage: 'Copy the command {purpose, select, finish {to finish it} other {to undo it}}', description: "Accessible name of the Copy button beside a command in the card dialog's Work section. Keep the select keys." }),
  copied: msg({ id: 'board.workQueue.copied', defaultMessage: 'Command copied', description: "A notification after copying a command from the card dialog's Work section." }),
  copyFailed: msg({ id: 'board.workQueue.copyFailed', defaultMessage: 'Could not copy the command', description: "A notification: copying a command from the card dialog's Work section failed." }),
  advance: msg({ id: 'board.workQueue.advance', defaultMessage: 'Tested and ready: update {target} in its folder now?', description: "The card dialog's Work section: the merge queue waits for the user's OK before it updates the branch {target}, which is checked out in a folder (its files change there). The same question waits under For you." }),
  approve: msg({ id: 'board.workQueue.approve', defaultMessage: 'Approve', description: "A button in the card dialog's Work section: the user's OK to update the checked-out branch now (the same answer as under For you). Glossary 2.3: Approve." }),
  decline: msg({ id: 'board.workQueue.decline', defaultMessage: 'Decline', description: "A button in the card dialog's Work section: declines updating the checked-out branch now (the same answer as under For you)." }),
  answerFailed: msg({ id: 'board.workQueue.answerFailed', defaultMessage: "Couldn't answer", description: "An error's title: approving or declining the update of a checked-out branch failed (the card dialog)." })
}

/** The window event For you's "Show the files and commands" sends: the card dialog's Work section shows its queue part. */
export const SHOW_QUEUE_WORK = 'hive:show-queue-work'

/** The card's place in its target's queue, counting the one testing (1: next), or null when not known here. */
function placeOf(v: QueueView | null, entry: string): number | null {
  if (!v) return null
  const i = v.queued.findIndex((q) => q.entry === entry)
  return i < 0 ? null : i + 1 + (v.testing ? 1 : 0)
}

/** The Work section's Merge queue part, for a card with a queue entry or outcome this cycle, or a stopped merge. */
export function CardQueue({ card, view: w, projectPath, short, reveal = 0 }: { card: TaskCard; view: WorkView; projectPath: string | null; short: (id: string) => string; reveal?: number }) {
  const q = w.queue
  const target = q?.target ?? w.target ?? null
  const [queue, setQueue] = useState<QueueView | null>(null)
  // Read again when the card's facts change, and when main says the queue did (the panel's queues).
  const changed = useStore((s) => s.queueVersion)
  useEffect(() => {
    if (!projectPath || !target) return
    let live = true
    void call('queue:list', projectPath, target).then(
      (v) => live && setQueue(v[0] ?? null),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [projectPath, target, w.lastSeq, changed])
  const runs = useStore((s) => s.progressRuns)
  const forYou = useForYou().byCard.get(card.number) ?? []
  const advance = forYou.find((i) => i.gate === QUEUE_ADVANCE_GATE)
  const stuck = queue?.paused?.stuck && queue.paused.card?.toLowerCase() === card.key?.toLowerCase() ? queue.paused.stuck : null
  // Asked to show it (For you's link): once its state is read, into view, the keyboard on its first button.
  const part = useRef<HTMLDivElement>(null)
  const hasStuck = !!stuck
  useEffect(() => {
    if (!reveal || !part.current) return
    const el = part.current.querySelector<HTMLElement>('.card-work-queue-stuck') ?? part.current
    el.scrollIntoView({ block: 'start' })
    el.querySelector<HTMLElement>('button')?.focus()
  }, [reveal, hasStuck])
  // Merged: the Work section's merge line says it.
  if ((!q || q.state === 'integrated') && !stuck && !advance) return null
  // A stopped advance says where it stands itself: not as one testing or merging now.
  const open = q && (q.state === 'open' || q.state === 'started') && !stuck
  const testing = open && queue?.testing?.entry === q.entry ? queue.testing : null
  const run = testing?.run ? (runs.find((r) => r.id === testing.run) ?? null) : null
  const place = open && !testing ? placeOf(queue, q.entry) : null
  return (
    <div ref={part} className="card-work-queue" data-work-queue={q?.state ?? 'stuck'}>
      <div className="card-work-sub">{tr(M.heading)}</div>
      {q && open && q.state === 'open' && !testing && (
        <div className="card-work-queue-line">
          <Icon name="list-ordered" /> <span>{place !== null ? tr(M.queued, { target: q.target, position: place }) : tr(M.queuedNoPlace, { target: q.target })}</span>
        </div>
      )}
      {q && testing && (
        <div className="card-work-queue-line">
          <Icon name="sync" /> <span>{tr(M.testing, { step: queue ? stepText(queue, run, tr) : '' })}</span>
          {testing.run && (
            <button type="button" className="btn small subtle" data-action="show-run" onClick={() => showQueueRun()}>
              <Icon name="play" /> {tr(M.showRun)}
            </button>
          )}
        </div>
      )}
      {q && open && q.state === 'started' && !testing && (
        <div className="card-work-queue-line">
          <Icon name="git-merge" /> <span>{tr(M.advancing, { target: q.target })}</span>
        </div>
      )}
      {q && open && (
        <dl className="card-work-facts">
          <div>
            <dt>{tr(M.approved)}</dt>
            <dd>
              <code>{short(q.revision)}</code>
            </dd>
          </div>
        </dl>
      )}
      {q?.requeue === 'retry' && open && <div className="faint card-work-queue-line">{tr(M.retried)}</div>}
      {q && q.state === 'failed' && <Returned card={card} q={q} queue={queue} short={short} runs={runs} />}
      {q && q.state === 'cancelled' && (
        <div className="card-work-queue-line faint">
          <Icon name="circle-slash" /> <span>{tr(M.cancelled, { reason: q.cancelled ?? 'other' /* i18n-ignore: a select's key, never shown */ })}</span>
        </div>
      )}
      {advance && <Advance card={card} request={advance.request} target={q?.target ?? target ?? ''} />}
      {queue?.paused && open && !stuck && <Paused queue={queue} projectPath={projectPath!} />}
      {stuck && <Stuck stuck={stuck} target={queue!.target} short={short} projectPath={projectPath ?? ''} />}
    </div>
  )
}

/** A return: why (the files for a conflict, the check by name), the output's last lines and Show log, Retry merge. */
function Returned({ card, q, queue, short, runs }: { card: TaskCard; q: NonNullable<WorkView['queue']>; queue: QueueView | null; short: (id: string) => string; runs: readonly ProgressRun[] }) {
  const [all, setAll] = useState(false)
  const recent: QueueRecent = { card: card.number, key: card.key ?? '', title: card.title, entry: q.entry, outcome: 'returned', at: q.at ?? '', ...(q.failure ? { reason: q.failure } : {}), ...(q.transient ? { transient: true } : {}), ...(q.files ? { files: q.files } : {}) }
  const run = queue ? returnRun(queue, recent, runs) : null
  const why = returnWhy(recent, run ? runCheckName(run) : null, q.target, tr, list)
  const lines = (q.log ?? '').replace(/\s+$/, '').split(/\r?\n/)
  const tail = lines.slice(-TAIL_LINES)
  const retry = async (): Promise<void> => {
    const ok = await confirm({ title: tr(M.retryTitle, { card: card.key ?? `#${card.number}` }), message: tr(M.retryMessage, { revision: short(q.revision) }), confirmLabel: tr(M.retryConfirm) })
    if (ok) await attempt(tr(M.retryFailed), () => call('queue:retry', card.number, ''))
  }
  return (
    <div className="card-work-queue-returned">
      <div className="card-work-queue-line">
        <Icon name="error" /> <span title={q.at ? formatDateTime(q.at) : undefined}>{tr(M.returned, { when: q.at ? timeAgo(q.at) : '', why })}</span>
      </div>
      {q.failure === 'conflict' && q.files?.length ? (
        <>
          <div className="faint">{tr(M.conflictFiles)}</div>
          <ul className="card-work-files">
            {q.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {q.log && (
        <>
          <div className="faint">{tr(M.output, { n: all ? lines.length : tail.length })}</div>
          <pre className="card-work-queue-log">{(all ? lines : tail).join('\n')}</pre>
        </>
      )}
      <div className="card-work-queue-actions">
        {(run?.logPath || (q.log && lines.length > tail.length)) && (
          <button
            type="button"
            className="btn small subtle"
            data-action="show-log"
            onClick={() => (run?.logPath ? void attempt(tr(msg({ id: 'board.queue.showLogFailed', defaultMessage: "Couldn't open the log", description: "An error's title: Show log on a merge queue's returned card failed (Progress panel)." })), () => call('progress:openLog', run.id)) : setAll(!all))}
          >
            <Icon name="output" /> {all && !run?.logPath ? tr(M.hideLog) : tr(M.showLog)}
          </button>
        )}
        {card.column !== 'done' && (
          <button type="button" className="btn small" data-action="retry" onClick={() => void retry()}>
            <Icon name="refresh" /> {tr(M.retry)}
          </button>
        )}
      </div>
    </div>
  )
}

/** The queue paused while the card waits in it: why, and Resume. */
function Paused({ queue, projectPath }: { queue: QueueView; projectPath: string }) {
  const resume = async (): Promise<void> => {
    const r = await attempt(tr(M.resumeFailed), () => call('queue:resume', projectPath, queue.target))
    if (r && !r.resumed && r.view.paused) notify('warning', tr(M.stillPaused), pauseText(r.view.paused, queue.target, tr, list))
  }
  return (
    <div className="card-work-queue-paused">
      <div className="card-work-queue-line">
        <Icon name="debug-pause" /> <span>{tr(M.paused, { target: queue.target })}</span>
      </div>
      <div className="card-work-queue-why">{pauseText(queue.paused!, queue.target, tr, list)}</div>
      <button type="button" className="btn small" data-action="resume" onClick={() => void resume()}>
        <Icon name="debug-continue" /> {tr(M.resume)}
      </button>
    </div>
  )
}

/** The OK an update of a checked-out target waits for (Ask each time): the same answer as For you's. */
function Advance({ card, request, target }: { card: TaskCard; request: string; target: string }) {
  const answer = (outcome: 'approved' | 'declined'): Promise<unknown> => attempt(tr(M.answerFailed), () => call('tasks:answer', card.number, request, { outcome }))
  return (
    <div className="card-work-queue-advance">
      <div className="card-work-queue-line">
        <Icon name="question" /> <span>{tr(M.advance, { target })}</span>
      </div>
      <div className="card-work-queue-actions">
        <button type="button" className="btn small primary" data-action="approve" onClick={() => void answer('approved')}>
          {tr(M.approve)}
        </button>
        <button type="button" className="btn small subtle" data-action="decline" onClick={() => void answer('declined')}>
          {tr(M.decline)}
        </button>
      </div>
    </div>
  )
}

/** An advance stopped part way (§16.9.2's terminal state): the state as Hive found it, each file's side, the commands. */
function Stuck({ stuck: st, target, short, projectPath }: { stuck: QueueStuck; target: string; short: (id: string) => string; projectPath: string }) {
  // Where each command runs, named one way (the Assistant's #1357 review): the folder's name, its full path on hover.
  const where = (place: 'project' | 'folder'): string => (place === 'project' ? projectPath : st.folder)
  const name = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const copy = (text: string): void =>
    void navigator.clipboard.writeText(text).then(
      () => notify('success', tr(M.copied)),
      () => notify('error', tr(M.copyFailed))
    )
  return (
    <div className="card-work-queue-stuck" data-stuck={st.phase}>
      <div className="card-work-queue-line">
        <Icon name="warning" /> <span>{tr(M.stuck, { target })}</span>
      </div>
      <dl className="card-work-facts">
        <div>
          <dt>{tr(M.stuckFolder)}</dt>
          <dd>
            <code>{st.folder}</code>
          </dd>
        </div>
        <div>
          <dt>{tr(M.stuckBranch)}</dt>
          <dd>{st.branch ? <code>{st.branch}</code> : tr(M.noBranch)}</dd>
        </div>
        <div>
          <dt>{tr(M.stuckRef, { target })}</dt>
          <dd>{st.ref ? <code>{short(st.ref)}</code> : tr(M.unreadRef)}</dd>
        </div>
        <div>
          <dt>{tr(M.expected)}</dt>
          <dd>
            <code>{short(st.expected)}</code>
          </dd>
        </div>
        <div>
          <dt>{tr(M.result)}</dt>
          <dd>
            <code>{short(st.result)}</code>
          </dd>
        </div>
      </dl>
      {st.files.length > 0 && (
        <>
          <div className="faint">{tr(M.files, { n: st.files.length })}</div>
          <ul className="card-work-files">
            {st.files.map((f) => (
              <li key={f.path} data-side={f.side}>
                <code>{f.path}</code> <span className="faint">{tr(M.side, { side: f.side })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="faint">{tr(M.commands)}</div>
      {st.commands.length === 0 && <div>{tr(M.noCommands)}</div>}
      {st.commands.map((c, i) => (
        <div key={i} className="card-work-queue-command" data-purpose={c.purpose}>
          <div className="faint" title={where(c.place)}>
            {tr(M.command, { purpose: c.purpose, folder: name(where(c.place)) })}
          </div>
          <div className="card-work-queue-command-row">
            <code>{c.command}</code>
            <button type="button" className="btn small subtle" aria-label={tr(M.copyNamed, { purpose: c.purpose })} onClick={() => copy(c.command)}>
              <Icon name="copy" /> {tr(M.copy)}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
