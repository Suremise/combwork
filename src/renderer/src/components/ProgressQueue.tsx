import { useEffect, useRef, useState } from 'react'
import { shortRevision } from '@shared/progress'
import { historyOutcome, historyRows, justMerged, mergedText, pauseText, pauseWhyShort, pulseLine, pushStateText, queueEstimate, queueNews, queuedText, returnCheck, returnedText, returnRun, returnWhy, shownReturns, testingText, type HistoryRow } from '@shared/progressQueue'
import type { MergeSlotInfo, ProgressRun } from '@shared/types'
import type { QueuePauseLogged, QueueRecent, QueueView } from '@shared/workflow/queue'
import { fmt, msg, tr } from '@shared/i18n'
import { formatDateTime, formatWhen } from '@shared/dates'
import { attempt } from '../actions'
import { call } from '../api'
import { cardLabelOf, choose, confirm, findProject, notify, openVersionControl, set, useLanguage, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { minutesText } from './MergeSlots'
import { MergeCard, useMergeFold } from './ProgressMerge'
import { FolderChangeButtons } from './FolderChangeButtons'
import { Icon, Tooltip } from './ui'

/**
 * The merge queue in the Progress panel (#1356): a card per target (what it tests now, with its step and the time
 * against an estimate; what waits, in order; a merge for a few seconds; a return until seen, with Open card and Show
 * log; a pause, with why and Resume), Pulse's line for a queue testing or paused, and a polite live region announcing
 * its changes. The view model is `shared/progressQueue.ts`; the card's Git tab section (#1357) reuses `QueueCard`.
 */

const list = (items: string[]): string => fmt.list(items, 'conjunction')

type StoreState = Parameters<typeof findProject>[0] & Parameters<typeof cardLabelOf>[0]

/** A card's builder as the window names it: its agent now, else the name it had (null: none). */
function builderOf(s: StoreState, card: number, projectPath: string): string | null {
  const c = s.tasks.find((t) => t.number === card)
  if (!c?.agent) return c?.agentName ?? null
  return findProject(s, projectPath)?.agents.find((a) => a.id === c.agent)?.name ?? c.agentName ?? null
}

/** Why a return happened, in the window's words (the check's name from its run, when there is one). */
export function returnWhyText(v: QueueView, r: QueueRecent, runs: readonly ProgressRun[]): string {
  const run = returnRun(v, r, runs)
  return returnWhy(r, returnCheck(r, run), v.target, tr, list)
}

const openCard = (n: number): void => set({ taskOpen: n })

const OPEN_CARD = msg({ id: 'board.queue.openCard', defaultMessage: 'Open card', description: "A button on a merge queue's card in the Progress panel: opens the card it names (a return, a pause that needs the user)." })

/** A target's queue, as the Progress panel's Merges tab shows it. `showProject`: the workspace has several projects. */
/** HI-2679: a target's forward merges on its queue card (Merges tab, Version Control). */
const FORWARD_T = {
  behind: msg({ id: 'board.queue.behind', defaultMessage: '{n, plural, one {{to} is # commit behind {from}} other {{to} is # commits behind {from}}}', description: 'HI-2679: on a merge queue’s card: its branch {to} lacks {n} commits of another of the project’s branches {from}, counted along {from}’s history (each merged card once). Branch names.' }),
  unknown: msg({ id: 'board.queue.behindUnknown', defaultMessage: 'Can’t tell how far {to} is behind {from}: a branch can’t be read', description: 'HI-2679: on a merge queue’s card: how far its branch {to} is behind {from} couldn’t be read (a branch missing or git couldn’t say).' }),
  behindTip: msg({ id: 'board.queue.behindTip', defaultMessage: 'Counted along {from}’s history: a card merged with a merge commit or squashed counts once; a rebased card counts each of its commits.', description: 'HI-2679: tooltip of a merge queue card’s “N commits behind” line: what is counted. {from} is a branch name.' }),
  button: msg({ id: 'board.queue.forward', defaultMessage: 'Bring Up to Date…', description: 'HI-2679: a button on a merge queue’s card: merges another of the project’s branches into this one through its queue (asks which first).' }),
  askTitle: msg({ id: 'board.queue.forwardAskTitle', defaultMessage: 'Bring {to} up to date with {from}?', description: 'HI-2679: the title of the question before a forward merge. Branch names.' }),
  askMessage: msg({ id: 'board.queue.forwardAskMessage', defaultMessage: '{from} as it is now is merged into {to} through {to}’s merge queue, with its merge checks, as a merge commit. {from} itself doesn’t change. If it conflicts or a check fails, its card comes back for you to Retry merge or Remove.', description: 'HI-2679: the question before a forward merge: what it does. Retry merge and Remove are the card’s commands: as translated there.' }),
  askConfirm: msg({ id: 'board.queue.forwardAskConfirm', defaultMessage: 'Queue It', description: 'HI-2679: the confirm button of the question before a forward merge.' }),
  chooseTitle: msg({ id: 'board.queue.forwardChooseTitle', defaultMessage: 'Bring {to} up to date with…', description: 'HI-2679: the title of the choice of branch for a forward merge into {to}.' }),
  chooseMessage: msg({ id: 'board.queue.forwardChooseMessage', defaultMessage: 'The branch is merged into {to} as it is now, through {to}’s merge queue, with its merge checks. It doesn’t change itself.', description: 'HI-2679: the message of the choice of branch for a forward merge into {to}.' }),
  cancel: msg({ id: 'board.queue.forwardCancel', defaultMessage: 'Cancel', description: 'HI-2679: the choice that cancels the forward merge.' }),
  failed: msg({ id: 'board.queue.forwardFailed', defaultMessage: 'Couldn’t bring the branch up to date', description: 'HI-2679: an error’s title: the forward merge couldn’t be queued. Its text says why.' }),
  upToDate: msg({ id: 'board.queue.forwardUpToDate', defaultMessage: '{to} already has everything of {from}', description: 'HI-2679: a notification: nothing to bring in, so nothing was queued.' }),
  already: msg({ id: 'board.queue.forwardAlready', defaultMessage: '{to} is being brought up to date with {from} already', description: 'HI-2679: a notification: a forward merge for this pair is queued or waiting already; nothing new was queued.' })
}

/** `inVersionControl`: shown in Version Control's Merge queue section, so without its link there (HI-2893). */
export function QueueCard({ view: v, runs, now, showProject, inVersionControl = false }: { view: QueueView; runs: readonly ProgressRun[]; now: number; showProject: boolean; inVersionControl?: boolean }) {
  useLanguage()
  const [busy, setBusy] = useState(false)
  const testingRun = v.testing?.run ? (runs.find((r) => r.id === v.testing!.run) ?? null) : null
  const merged = justMerged(v, now)
  const returns = shownReturns(v, now)
  const estimate = v.testing ? queueEstimate(v, runs) : null
  const name = tr(msg({ id: 'board.queue.title', defaultMessage: 'Merge queue · {target}', description: "The heading of a merge queue's card in the Progress panel ({target}: the branch it merges into, such as main). Glossary 2.5: merge queue." }), { target: v.target })
  const pause = async (): Promise<void> => {
    setBusy(true)
    try {
      await attempt(tr(msg({ id: 'board.queue.pauseFailed', defaultMessage: "Couldn't pause the merge queue", description: "An error's title: Pause queue failed (Progress panel)." })), () => call('queue:pause', v.projectPath, v.target))
    } finally {
      setBusy(false)
    }
  }
  const resume = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await attempt(tr(msg({ id: 'board.queue.resumeFailed', defaultMessage: "Couldn't resume the merge queue", description: "An error's title: Resume queue failed (Progress panel)." })), () => call('queue:resume', v.projectPath, v.target))
      // Its cause still holds: paused again, saying why.
      if (r && !r.resumed && r.view.paused) notify('warning', tr(msg({ id: 'board.queue.stillPaused', defaultMessage: 'The merge queue is still paused', description: "A notification's title after Resume queue: what paused it still holds, so it paused again. Its message says why." })), pauseText(r.view.paused, v.target, tr, list))
    } finally {
      setBusy(false)
    }
  }
  const nothing = !v.testing && !v.queued.length && !v.paused && !merged.length && !returns.length
  // HI-2679: what this target lacks of the project's other targets, and the button that brings it up to date.
  const behind = (v.forward?.behind ?? []).filter((b) => b.commits !== 0)
  const forward = async (): Promise<void> => {
    const offered = behind.filter((b) => b.commits !== null).map((b) => b.from)
    if (!offered.length) return
    const from =
      offered.length === 1
        ? (await confirm({ title: tr(FORWARD_T.askTitle, { to: v.target, from: offered[0] }), message: tr(FORWARD_T.askMessage, { to: v.target, from: offered[0] }), confirmLabel: tr(FORWARD_T.askConfirm) })) ? offered[0] : null
        : await choose({ title: tr(FORWARD_T.chooseTitle, { to: v.target }), message: tr(FORWARD_T.chooseMessage, { to: v.target }), choices: [...offered.map((b) => ({ label: b, value: b })), { label: tr(FORWARD_T.cancel), value: '' }] })
    if (!from) return
    setBusy(true)
    try {
      const r = await attempt(tr(FORWARD_T.failed), () => call('queue:forward', v.projectPath, from, v.target))
      if (r?.upToDate) notify('info', tr(FORWARD_T.upToDate, { to: v.target, from }))
      else if (r && !r.queued) notify('info', tr(FORWARD_T.already, { to: v.target, from }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cx('progress-merge-card', 'progress-queue-card', v.paused && 'paused')} data-queue={`${v.project}#${v.target}`} role="group" aria-label={showProject ? `${v.project} · ${name}` : name}>
      <div className="progress-merge-top">
        <Icon name="git-merge" />
        <span className="progress-merge-who">
          {showProject && <span className="faint">{v.project} · </span>}
          {name}
        </span>
        <div className="grow" />
        {v.paused ? (
          <button type="button" className="btn small" disabled={busy} data-action="resume" onClick={() => void resume()}>
            <Icon name="debug-continue" /> {tr(msg({ id: 'board.queue.resume', defaultMessage: 'Resume queue', description: "A button on a paused merge queue's card in the Progress panel: clears the pause once its cause is fixed. Glossary 2.5: Resume queue." }))}
          </button>
        ) : (
          <Tooltip content={tr(msg({ id: 'board.queue.pauseTip', defaultMessage: 'Stop before the next card. A card in its merge checks finishes them and waits, unmerged.', description: "Tooltip of Pause queue on a merge queue's card in the Progress panel. Glossary 2.3: merge checks." }))}>
            <button type="button" className="btn small subtle" disabled={busy} data-action="pause" onClick={() => void pause()}>
              <Icon name="debug-pause" /> {tr(msg({ id: 'board.queue.pause', defaultMessage: 'Pause queue', description: "A button on a merge queue's card in the Progress panel: stops it before its next card (saved). Glossary 2.5: Pause queue." }))}
            </button>
          </Tooltip>
        )}
      </div>
      {v.runBy && !v.runHere && <div className="progress-queue-line faint">{tr(msg({ id: 'board.queue.runBy', defaultMessage: 'Run by profile {profile}', description: "On a merge queue's card in the Progress panel: another Combwork on this workspace runs the queue ({profile}: its profile's name, such as Combwork-Dev). A noun before the name (glossary §1 rule 4)." }), { profile: v.runBy })}</div>}
      {v.paused && (
        <div className="progress-queue-paused" data-reason={v.paused.reason}>
          <Icon name="debug-pause" />
          <span className="progress-queue-text">{pauseText(v.paused, v.target, tr, list)}</span>
          {v.paused.reason === 'needsYou' && v.paused.card && <CardButton keyOf={v.paused.card} />}
          <FolderChangeButtons projectPath={v.projectPath} target={v.target} paused={v.paused} />
        </div>
      )}
      {v.testing && (
        <div className="progress-queue-testing">
          <Tooltip block content={v.testing.title}>
            <div className="progress-queue-line">
              <Icon name="sync" className="progress-queue-icon" /> {testingText(v, testingRun, tr)}
            </div>
          </Tooltip>
          {v.testing.started && <div className="progress-merge-time faint">{timeText(now - Date.parse(v.testing.started), estimate)}</div>}
        </div>
      )}
      {v.queued.length > 0 && (
        <div className="progress-queue-queued">
          <div className="progress-queue-line">
            <Icon name="list-ordered" className="progress-queue-icon" /> {queuedText(v, tr, list)}
          </div>
          <ol className="progress-queue-list">
            {v.queued.map((q) => (
              <li key={q.entry} data-entry={q.entry}>
                <button type="button" className="progress-run-card" title={tr(OPEN_NAMED, { card: q.key })} onClick={() => openCard(q.card)}>
                  {q.key}
                </button>
                <span className="progress-queue-title faint">{q.title}</span>
                {q.waitingOn?.length ? (
                  <span className="progress-queue-waiting" data-waiting-on={q.waitingOn.join(' ')}>
                    {tr(WAITING_ON, { cards: q.waitingOn.join(', ') })}
                  </span>
                ) : null}
                <RevisionButton revision={q.revision} />
                <button type="button" className="btn small subtle progress-queue-remove" aria-label={tr(msg({ id: 'board.queue.removeNamed', defaultMessage: 'Remove {card} from the queue', description: "Accessible name of Remove from queue on a queued card ({card}: its key) on a merge queue's card in the Progress panel." }), { card: q.key })} onClick={() => void removeFromQueue(q.card, q.key)}>
                  {tr(msg({ id: 'board.queue.remove', defaultMessage: 'Remove', description: "A button beside a queued card on a merge queue's card in the Progress panel: Remove from queue (asks first). Keep it short." }))}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {merged.map((r) => (
        <div key={`${r.entry}:merged`} className="progress-queue-merged" data-entry={r.entry}>
          <Icon name="pass" /> <span className="progress-queue-text">{mergedText(r, tr)}</span>
        </div>
      ))}
      {returns.map((r) => (
        <ReturnRow key={`${r.entry}:returned`} view={v} r={r} runs={runs} />
      ))}
      {v.returnsMore > 0 && (
        <div className="progress-queue-line faint" data-more-returns={v.returnsMore}>
          <Icon name="error" /> {tr(msg({ id: 'board.queue.moreReturned', defaultMessage: '{n, plural, one {# more returned card: it shows here once you have seen these.} other {# more returned cards: they show here as you see these.}}', description: "Under the returned cards on a merge queue's card in the Progress panel, when more are waiting to be shown ({n}): each shows once those above have been seen. Glossary 2.4: returned." }), { n: v.returnsMore })}
        </div>
      )}
      {behind.map((b) => (
        <div key={`behind:${b.from}`} className="progress-queue-line progress-queue-behind" data-behind={b.from}>
          <Tooltip content={tr(FORWARD_T.behindTip, { from: b.from })}>
            <span>
              <Icon name="git-compare" /> {b.commits === null ? tr(FORWARD_T.unknown, { from: b.from, to: v.target }) : tr(FORWARD_T.behind, { n: b.commits, from: b.from, to: v.target })}
            </span>
          </Tooltip>
        </div>
      ))}
      {behind.some((b) => b.commits !== null) && (
        <button type="button" className="btn small" disabled={busy} data-action="forward" onClick={() => void forward()}>
          <Icon name="git-merge" /> {tr(FORWARD_T.button)}
        </button>
      )}
      {nothing && <div className="progress-queue-line faint">{tr(msg({ id: 'board.queue.empty', defaultMessage: 'Nothing queued.', description: "A merge queue's card in the Progress panel when no card is waiting or being merged." }))}</div>}
      {!inVersionControl && (
        <button type="button" className="progress-queue-link" onClick={() => openVersionControl(v.projectPath, 'queue')}>
          {tr(msg({ id: 'board.queue.inVersionControl', defaultMessage: 'Queue in Version Control', description: "A link on a merge queue's card in the Progress panel: shows the project's Version Control tab at its Merge queue section, with its history." }))} <Icon name="arrow-right" />
        </button>
      )}
    </div>
  )
}

/** How long the entry has been testing, against the estimate when there is one. */
function timeText(ms: number, estimate: number | null): string {
  const sofar = minutesText(ms)
  if (estimate === null) return tr(msg({ id: 'board.queue.sofar', defaultMessage: '{sofar} so far', description: "How long the merge queue has been testing its card ({sofar}: \"3 min\"), on its card in the Progress panel, with no estimate (no earlier merge checks to go by)." }), { sofar })
  return tr(msg({ id: 'board.queue.sofarOf', defaultMessage: '{sofar} so far · usually {estimate}', description: "How long the merge queue has been testing its card ({sofar}: \"3 min\") and how long its merge checks usually take ({estimate}: \"12 min\", the median of the last ones), on its card in the Progress panel." }), { sofar, estimate: minutesText(estimate) })
}

/** A return: why, its card and its log (the failed check's run log, or the hook's output). */
function ReturnRow({ view: v, r, runs }: { view: QueueView; r: QueueRecent; runs: readonly ProgressRun[] }) {
  const [log, setLog] = useState(false)
  const builder = useStore((s) => builderOf(s, r.card, v.projectPath))
  const run = returnRun(v, r, runs)
  const why = returnWhy(r, returnCheck(r, run), v.target, tr, list)
  const showLog = (): void => {
    if (run?.logPath) void attempt(tr(msg({ id: 'board.queue.showLogFailed', defaultMessage: "Couldn't open the log", description: "An error's title: Show log on a merge queue's returned card failed (Progress panel)." })), () => call('progress:openLog', run.id))
    else setLog(!log)
  }
  return (
    <div className="progress-queue-returned" data-entry={r.entry}>
      <div className="progress-queue-row">
        <Icon name="error" />
        <span className="progress-queue-text">{returnedText(r, why, builder, tr)}</span>
      </div>
      <div className="progress-queue-actions">
        <button type="button" className="btn small subtle" data-action="open-card" onClick={() => openCard(r.card)}>
          <Icon name="go-to-file" /> {tr(OPEN_CARD)}
        </button>
        {(run?.logPath || r.log) && (
          <button type="button" className="btn small subtle" data-action="show-log" aria-expanded={run?.logPath ? undefined : log} onClick={showLog}>
            <Icon name="output" /> {tr(msg({ id: 'board.queue.showLog', defaultMessage: 'Show log', description: "A button on a merge queue's returned card in the Progress panel: shows the failed check's log (or the hook's output)." }))}
          </button>
        )}
      </div>
      {log && r.log && <pre className="progress-queue-log">{r.log}</pre>}
    </div>
  )
}

/** A card named by its key (a pause's), opened by number once the board has it. */
function CardButton({ keyOf }: { keyOf: string }) {
  const n = useStore((s) => s.tasks.find((t) => t.key?.toLowerCase() === keyOf.toLowerCase())?.number ?? null)
  if (n === null) return null
  return (
    <button type="button" className="btn small subtle" data-action="open-card" onClick={() => openCard(n)}>
      <Icon name="go-to-file" /> {tr(OPEN_CARD)}
    </button>
  )
}

/**
 * A revision, short; a click copies the whole commit id (a queued card's approved revision; the Version Control tab's
 * queue history, #1641, with the project's short form). The click stays its own (it doesn't open a row it is in).
 */
export function RevisionButton({ revision, short = shortRevision }: { revision: string; short?: (id: string) => string }) {
  const s = short(revision)
  return (
    <button
      type="button"
      className="progress-run-revision"
      title={tr(msg({ id: 'board.progress.copyRevision', defaultMessage: 'Copy revision {revision}', description: "Tooltip of a run's revision in the Progress panel (under its agent): copies the whole commit id. {revision} is its short form (a3f2c1d)." }), { revision: s })}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(revision).then(
          () => notify('success', tr(msg({ id: 'board.progress.revisionCopied', defaultMessage: 'Revision {revision} copied', description: "A notification after copying a run's revision (a commit id) from the Progress panel. {revision} is its short form (a3f2c1d)." }), { revision: s })),
          () => notify('error', tr(msg({ id: 'board.progress.revisionCopyFailed', defaultMessage: 'Could not copy the revision', description: "A notification: copying a run's revision (a commit id) from the Progress panel failed." })))
        )
      }}
    >
      <code>{s}</code>
    </button>
  )
}

/** Remove from queue, after asking: the card goes back to Approved and its builder is told; it isn't merged. */
async function removeFromQueue(n: number, key: string): Promise<void> {
  const ok = await confirm({
    title: tr(msg({ id: 'board.queue.removeTitle', defaultMessage: 'Remove {card} from the merge queue?', description: "Title of the confirmation before Remove from queue ({card}: the card's key). Glossary 2.5: merge queue." }), { card: key }),
    message: tr(msg({ id: 'board.queue.removeMessage', defaultMessage: "It goes back to Approved and isn't merged. Its builder is told. To merge it later, requeue it from the card.", description: "The confirmation before Remove from queue (Progress panel). Approved is a stage (glossary 2.2)." })),
    confirmLabel: tr(msg({ id: 'board.queue.removeConfirm', defaultMessage: 'Remove from queue', description: 'The button confirming Remove from queue. Keep it short.' }))
  })
  if (!ok) return
  await attempt(tr(msg({ id: 'board.queue.removeFailed', defaultMessage: "Couldn't remove the card from the queue", description: "An error's title: Remove from queue failed (Progress panel); its message says why (its merge has begun, say)." })), () => call('queue:remove', n, ''))
}

/**
 * The Merges tab (#1356 item 3): the merge queues' cards and the merge slot's, by project then target (a slot's target
 * is the branch it merges into). What merges now comes first, history after (HI-1924, the Assistant's screenshot OK): a
 * project's slots sit under its queue's card (the queue for their target, else the project's first), then the queue's
 * Recent merges; a project with no queue lists its slots alone.
 */
export function MergesList({ queues, slots, runs, now, projectName, showProject, stepOf, agent = null }: { queues: QueueView[]; slots: MergeSlotInfo[]; runs: readonly ProgressRun[]; now: number; projectName: (path: string) => string; showProject: boolean; stepOf: (s: MergeSlotInfo) => string | null; agent?: string | null }) {
  useLanguage()
  const [folded, toggle] = useMergeFold()
  const slotCard = (s: MergeSlotInfo) => <MergeCard key={`s:${s.project}#${s.branch}`} slot={s} project={projectName(s.project)} showProject={showProject} step={stepOf(s)} now={now} folded={folded} onFold={toggle} />
  const byTarget = (a: { target: string }, b: { target: string }): number => a.target.localeCompare(b.target)
  const sorted = [...queues].sort(byTarget)
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  // Each slot's queue: its project's queue for its target, else that project's first.
  const home = (s: MergeSlotInfo): QueueView | undefined => sorted.find((v) => same(v.projectPath, s.project) && v.target === s.branch) ?? sorted.find((v) => same(v.projectPath, s.project))
  const under = new Map<QueueView, MergeSlotInfo[]>()
  const alone: MergeSlotInfo[] = []
  for (const s of [...slots].sort((a, b) => a.branch.localeCompare(b.branch))) {
    const v = home(s)
    if (v) under.set(v, [...(under.get(v) ?? []), s])
    else alone.push(s)
  }
  const items = [
    ...sorted.map((v) => ({
      key: `q:${v.projectPath}#${v.target}`,
      project: projectName(v.projectPath),
      target: v.target,
      el: (
        <div key={`q:${v.projectPath}#${v.target}`} className="progress-queue-with-history">
          <QueueCard view={v} runs={runs} now={now} showProject={showProject} />
          {under.get(v)?.map(slotCard)}
          <RecentMerges view={v} runs={runs} now={now} agent={agent} />
        </div>
      )
    })),
    ...alone.map((s) => ({ key: `s:${s.project}#${s.branch}`, project: projectName(s.project), target: s.branch, el: slotCard(s) }))
  ].sort((a, b) => a.project.localeCompare(b.project) || a.target.localeCompare(b.target) || a.key.localeCompare(b.key))
  return (
    <div className="progress-merge full" role="region" aria-label={tr(msg({ id: 'board.merge.region', defaultMessage: 'Merging', description: "Accessible name of the top of the Progress panel: a card for each merge going on." }))}>
      {items.map((i) => i.el)}
    </div>
  )
}

const H = {
  recent: msg({ id: 'board.queue.recent.heading', defaultMessage: 'Recent merges', description: "A heading under a merge queue's card in the Progress panel's Merges tab (HI-1924): the queue's latest outcomes (merged, returned, taken out) and pauses follow, newest first." }),
  none: msg({ id: 'board.queue.recent.none', defaultMessage: 'No merges yet.', description: "Under Recent merges in the Progress panel's Merges tab, when the merge queue has merged, returned or paused nothing yet (or nothing of the agent the panel is filtered to)." }),
  more: msg({ id: 'board.queue.recent.more', defaultMessage: 'More in Version Control', description: "A link after a merge queue's Recent merges in the Progress panel: its full history, in the project's Version Control tab (Merge queue section). Version Control is a place in Combwork." }),
  took: msg({ id: 'board.queue.recent.took', defaultMessage: 'took {duration}', description: "Beside an outcome in the Progress panel's Recent merges: how long the merge queue took over the card, its merge checks and merge ({duration}: “12 min”, “under a minute”). Lower case." }),
  lasted: msg({ id: 'board.queue.recent.lasted', defaultMessage: 'lasted {duration}', description: "Beside a pause in the Progress panel's Recent merges: how long the merge queue stayed paused ({duration}: “12 min”, “under a minute”). Lower case." }),
  still: msg({ id: 'board.queue.recent.stillPaused', defaultMessage: 'still paused', description: "Beside a pause in the Progress panel's Recent merges: the merge queue is paused now (the pause hasn't ended). Lower case." })
}

const WAITING_ON = msg({ id: 'board.queue.waitingOn', defaultMessage: 'Waiting for {cards}', description: "HI-2709: beside a queued card on a merge queue's card in the Progress panel: it is blocked by these cards ({cards}: their keys, joined with commas), which aren't Done yet; the queue merges the cards behind it meanwhile, and this one once they are Done. Keep it short." })
const OPEN_NAMED = msg({ id: 'board.queue.openNamed', defaultMessage: 'Open {card}', description: "Tooltip of a queued card's key on a merge queue's card in the Progress panel: opens the card ({card}: its key)." })

/**
 * A queue's Recent merges (HI-1924), under its card in the Merges tab: its latest outcomes and pauses, newest first
 * (`historyRows`), the panel's agent filter applied by each card's agent; each row opens its card. From the queue's model,
 * which the window reads again on each queue change: nothing of its own to read, and nothing drawn while the tab is hidden.
 */
export function RecentMerges({ view: v, runs, now, agent }: { view: QueueView; runs: readonly ProgressRun[]; now: number; agent: string | null }) {
  useLanguage()
  const tasks = useStore((s) => s.tasks)
  const agentOf = (pick: (t: (typeof tasks)[number]) => boolean): string | null => tasks.find(pick)?.agent ?? null
  const keep = agent ? { number: (n: number) => agentOf((t) => t.number === n) === agent, key: (k: string) => agentOf((t) => t.key?.toLowerCase() === k.toLowerCase()) === agent } : undefined
  const { rows, more } = historyRows(v, keep)
  const label = tr(H.recent)
  return (
    <section className="progress-queue-history" aria-label={label} data-queue-history={`${v.project}#${v.target}`}>
      <div className="progress-queue-history-h">{label}</div>
      {rows.length ? (
        <ol className="progress-queue-history-list">
          {rows.map((row) => (
            <HistoryItem key={row.key} view={v} row={row} runs={runs} now={now} />
          ))}
        </ol>
      ) : (
        <div className="progress-queue-line faint" data-history-empty="">
          {tr(H.none)}
        </div>
      )}
      {more && (
        <button type="button" className="progress-queue-link" data-action="more-history" onClick={() => openVersionControl(v.projectPath, 'queue')}>
          {tr(H.more)} <Icon name="arrow-right" />
        </button>
      )}
    </section>
  )
}

/** When a row happened: its time (with the date when not today), and how long ago on hover. */
function When({ at, now }: { at: string; now: number }) {
  return (
    <span className="progress-queue-when faint" title={`${timeAgo(at)} · ${formatDateTime(at)}`}>
      {formatWhen(at, new Date(now))}
    </span>
  )
}

function HistoryItem({ view: v, row, runs, now }: { view: QueueView; row: HistoryRow; runs: readonly ProgressRun[]; now: number }) {
  if (row.kind === 'pause') return <PauseItem view={v} p={row.p} now={now} />
  const r = row.r
  const outcome = historyOutcome(r, r.outcome === 'returned' ? returnWhyText(v, r, runs) : '', tr)
  const push = pushStateText(r.push, tr)
  return (
    <li className="progress-queue-history-row opens" data-entry={r.entry} data-outcome={r.outcome} data-push={r.push} onClick={() => openCard(r.card)}>
      <div className="progress-queue-history-top">
        <Icon name={r.outcome === 'merged' ? 'pass' : r.outcome === 'returned' ? 'error' : 'circle-slash'} className="progress-queue-icon" />
        <button
          type="button"
          className="progress-run-card"
          title={tr(OPEN_NAMED, { card: r.key })}
          onClick={(e) => {
            e.stopPropagation()
            openCard(r.card)
          }}
        >
          {r.key}
        </button>
        <span className="progress-queue-title faint" title={r.title}>
          {r.title}
        </span>
        <When at={r.at} now={now} />
      </div>
      <div className="progress-queue-history-detail">
        <span className="progress-queue-outcome" title={outcome}>
          {outcome}
        </span>
        {r.outcome === 'merged' && r.result && <RevisionButton revision={r.result} />}
        {push && <span className={cx('progress-queue-push', r.push !== 'pushed' && 'faint')}>{push}</span>}
        {r.tookMs !== undefined && <span className="faint">{tr(H.took, { duration: minutesText(r.tookMs) })}</span>}
      </div>
    </li>
  )
}

function PauseItem({ view: v, p, now }: { view: QueueView; p: QueuePauseLogged; now: number }) {
  const n = useStore((s) => (p.card ? (s.tasks.find((t) => t.key?.toLowerCase() === p.card.toLowerCase())?.number ?? null) : null))
  const full = pauseText({ reason: p.reason, card: p.card || null, files: [], by: p.by ?? null, at: p.at, ...(p.message ? { message: p.message } : {}) }, v.target, tr, list)
  return (
    <li className={cx('progress-queue-history-row', 'pause', n !== null && 'opens')} data-pause={p.reason} data-ended={p.ended ? '' : undefined} onClick={n !== null ? () => openCard(n) : undefined}>
      <div className="progress-queue-history-top">
        <Icon name="debug-pause" className="progress-queue-icon" />
        {n !== null && (
          <button
            type="button"
            className="progress-run-card"
            title={tr(OPEN_NAMED, { card: p.card })}
            onClick={(e) => {
              e.stopPropagation()
              openCard(n)
            }}
          >
            {p.card}
          </button>
        )}
        <span className="progress-queue-outcome" title={full}>
          {pauseWhyShort(p, tr)}
        </span>
        <When at={p.at} now={now} />
      </div>
      <div className="progress-queue-history-detail faint">{p.ended ? tr(H.lasted, { duration: minutesText(Date.parse(p.ended) - Date.parse(p.at)) }) : tr(H.still)}</div>
    </li>
  )
}

/** Pulse's lines (#1356 item 4): a queue testing or paused, in one line; a click shows the Merges tab. */
export function QueueLines({ views, showProject, onOpen }: { views: QueueView[]; showProject: boolean; onOpen: () => void }) {
  useLanguage()
  if (!views.length) return null
  return (
    <div className="progress-queue-lines">
      {views.map((v) => (
        <button key={`${v.projectPath}#${v.target}`} type="button" className={cx('progress-queue-pulse', v.paused && 'paused')} data-queue={`${v.project}#${v.target}`} onClick={onOpen}>
          <Icon name={v.paused ? 'debug-pause' : 'git-merge'} />
          <span>{pulseLine(v, showProject ? v.project : null, tr)}</span>
          <Icon name="arrow-right" />
        </button>
      ))}
    </div>
  )
}

/** How many announcements the live region keeps (the newest; a screen reader reads each once as it is added). */
const SAID_KEPT = 5

/**
 * The polite live region (#1356 item 8): a card merged or returned, a queue paused or resumed, each said once as the
 * queues change. Mounted with the panel, whatever its tab, so it is there before anything is said.
 */
export function QueueAnnouncer({ views, runs }: { views: QueueView[]; runs: readonly ProgressRun[] }) {
  const before = useRef(new Map<string, QueueView>())
  const said = useRef(new Set<string>())
  const [lines, setLines] = useState<{ key: string; text: string }[]>([])
  useEffect(() => {
    const next = new Map(views.map((v) => [`${v.projectPath.toLowerCase()}\n${v.target}`, v]))
    const news: { key: string; text: string }[] = []
    for (const [k, v] of next) for (const n of queueNews(before.current.get(k), v, Date.now(), tr, (r) => returnWhyText(v, r, runs))) if (!said.current.has(n.key)) news.push(n)
    before.current = next
    if (!news.length) return
    for (const n of news) said.current.add(n.key)
    setLines((l) => [...l, ...news].slice(-SAID_KEPT))
    // runs only word a return's check: a later run doesn't make anything new to say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views])
  return (
    <div className="visually-hidden" role="status" aria-live="polite" data-queue-said>
      {lines.map((l) => (
        <div key={l.key}>{l.text}</div>
      ))}
    </div>
  )
}
