import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import type { PrView } from '@shared/githubSource'
import type { WorkBadge, WorkPullRequest } from '@shared/workflow/workView'
import { call } from '../api'
import { Icon } from './ui'

/**
 * A card's pull request (HI-3552), when its project's finish is a pull request: on its tile in PR open, its number as a
 * link to GitHub (a draft says so), or that it isn't open yet and why; in its dialog, GitHub's state read now (checks,
 * review, draft, commits pushed from outside), read again each time the dialog opens. GitHub can't tell Combwork, so
 * what the dialog shows is as of that read.
 */

const T = {
  number: msg({ id: 'board.pr.number', defaultMessage: 'PR #{number}', description: 'HI-3552: on a card in PR open (board tile and dialog): its GitHub pull request’s number, a link to it. PR is short for pull request.' }),
  draft: msg({ id: 'board.pr.draft', defaultMessage: 'Draft', description: 'HI-3552: beside a card’s pull request number: GitHub has it as a draft (GitHub’s word: use its own in your language where it has one).' }),
  open: msg({ id: 'board.pr.open', defaultMessage: 'Open on GitHub', description: 'HI-3552: tooltip of a card’s pull request link: opens it in the browser.' }),
  failed: msg({ id: 'board.pr.failed', defaultMessage: 'Pull request not open: see For you', description: 'HI-3552: on a card waiting in Passed: Combwork couldn’t push it or open its pull request; the For you request says why and offers to try again.' }),
  opening: msg({ id: 'board.pr.opening', defaultMessage: 'Opening its pull request…', description: 'HI-3552: on a card waiting in Passed: Combwork is pushing it and opening its pull request on GitHub.' }),
  heading: msg({ id: 'board.pr.heading', defaultMessage: 'Pull request', description: 'HI-3552: a heading in the card dialog: the card’s GitHub pull request.' }),
  checks: msg({ id: 'board.pr.checks', defaultMessage: 'Checks: {passed, number} passed, {failed, number} failed, {pending, number} running', description: 'HI-3552: the card dialog’s pull request: GitHub’s checks on it, how many passed, failed, and haven’t finished.' }),
  noChecks: msg({ id: 'board.pr.noChecks', defaultMessage: 'No checks', description: 'HI-3552: the card dialog’s pull request: GitHub runs no checks on it.' }),
  review: msg({ id: 'board.pr.review', defaultMessage: '{state, select, approved {Approved on GitHub} changesRequested {Changes requested on GitHub} required {Waiting for a review on GitHub} other {No review asked on GitHub}}', description: 'HI-3552: the card dialog’s pull request: GitHub’s review decision on it. Keep the select keys.' }),
  outside: msg({ id: 'board.pr.outside', defaultMessage: 'Commits were pushed to it outside Combwork: they stay as they are.', description: 'HI-3552: the card dialog’s pull request: its branch on GitHub has commits Combwork didn’t push (someone else’s). Combwork never overwrites them.' }),
  stale: msg({ id: 'board.pr.stale', defaultMessage: 'GitHub didn’t answer just now: this is as last read.', description: 'HI-3552: the card dialog’s pull request: reading it from GitHub failed this time, so what is shown is older (or unknown).' }),
  reading: msg({ id: 'board.pr.reading', defaultMessage: 'Reading it from GitHub…', description: 'HI-3552: the card dialog’s pull request while Combwork asks GitHub for its state.' }),
  closed: msg({ id: 'board.pr.closed', defaultMessage: 'Its pull request was closed on GitHub without merging; its branch is kept.', description: 'HI-3552: on a card moved back to Todo because its GitHub pull request was closed without being merged. Its branch stays for a later start.' })
}

const external = (url: string) => (e: React.MouseEvent) => (e.preventDefault(), void call('app:openExternal', url))

/** On a tile: its pull request in PR open, being opened, or not opened (For you says why); its close, back in Todo. */
export function PrLine({ b }: { b: WorkBadge | null | undefined }) {
  const p: WorkPullRequest | null | undefined = b?.pullRequest
  if (!p || !b) return null
  if (b.stage === 'prOpen' && p.number !== null && p.url) {
    return (
      <div className="task-pr" data-pr={p.number}>
        <Icon name="git-pull-request" />
        <a href={p.url} title={tr(T.open)} onClick={external(p.url)}>
          {tr(T.number, { number: p.number })}
        </a>
        {p.draft && <span className="faint">{tr(T.draft)}</span>}
      </div>
    )
  }
  if (b.stage === 'approved') {
    return (
      <div className={p.failed ? 'task-pr task-stalled' : 'task-pr faint'} data-pr={p.failed ? 'failed' : 'opening'}>
        <Icon name={p.failed ? 'warning' : 'git-pull-request'} />
        <span className="task-note-text">{tr(p.failed ? T.failed : T.opening)}</span>
      </div>
    )
  }
  if (b.stage === 'todo' && p.closed !== null) {
    return (
      <div className="task-pr faint" data-pr="closed">
        <Icon name="git-pull-request-closed" />
        <span className="task-note-text">{tr(T.closed)}</span>
      </div>
    )
  }
  return null
}

/** In the card dialog: its pull request in PR open, read from GitHub as the dialog opens. */
export function PrStatus({ card, b }: { card: number; b: WorkBadge | null | undefined }) {
  const open = b?.stage === 'prOpen' && !!b.pullRequest?.url
  const [view, setView] = useState<PrView | null>(null)
  const [reading, setReading] = useState(false)
  useEffect(() => {
    if (!open) return
    let live = true
    setReading(true)
    void call('tasks:prStatus', card)
      .then((v) => live && setView(v))
      .catch(() => {})
      .finally(() => live && setReading(false))
    return () => {
      live = false
    }
  }, [card, open])
  if (!open) return null
  const p = b!.pullRequest!
  const url = view?.url ?? p.url!
  return (
    <div className="card-pr" data-pr={p.number ?? ''} data-pr-state={view?.state ?? 'unread'}>
      <div className="s-label">{tr(T.heading)}</div>
      <div className="flex">
        <Icon name="git-pull-request" />
        <a href={url} title={tr(T.open)} onClick={external(url)}>
          {tr(T.number, { number: p.number ?? 0 })} · {p.repo}
        </a>
        {(view?.draft ?? p.draft) && <span className="faint">{tr(T.draft)}</span>}
      </div>
      {reading && !view && <div className="s-desc">{tr(T.reading)}</div>}
      {view && view.state !== 'unknown' && (
        <>
          <div className="s-desc" data-pr-checks>
            {view.checks.passed + view.checks.failed + view.checks.pending ? tr(T.checks, view.checks) : tr(T.noChecks)}
          </div>
          <div className="s-desc" data-pr-review={view.review ?? 'none'}>
            {tr(T.review, { state: view.review ?? 'none' })}
          </div>
        </>
      )}
      {view?.outside && (
        <div className="s-desc" data-pr-outside>
          {tr(T.outside)}
        </div>
      )}
      {view?.stale && <div className="s-desc faint">{tr(T.stale)}</div>}
    </div>
  )
}
