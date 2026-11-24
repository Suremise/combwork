import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { githubFooter, type GithubReviewsView } from '@shared/githubReviews'
import type { TaskCard } from '@shared/types'
import * as actions from '../actions'
import { call } from '../api'
import { confirm, openWorkflowOption, useStore } from '../store'
import { Icon } from './ui'

/**
 * Feedback to GitHub on a pull request's card (HI-3559): the reviews it posts to its pull request, always a comment review
 * through the user's GitHub CLI. Under Both an agent's verdict is drafted here for the user to edit and post; under You the
 * user writes their own; under The agent each verdict is posted as it is given, and one that failed can be posted again.
 */

const T = {
  label: msg({ id: 'board.github.label', defaultMessage: 'Feedback to GitHub', description: 'A field label in the card dialog of a pull request’s card (HI-3559): the reviews posted to that pull request.' }),
  option: msg({ id: 'board.github.option', defaultMessage: '{option, select, agent {Each reviewer agent’s verdict is posted as it is given.} user {Only reviews you write here are posted.} other {A reviewer agent’s verdict is drafted here for you to edit and post.}} Posted as your GitHub account, always as a comment review.', description: 'Under “Feedback to GitHub” in a pull request card’s dialog (HI-3559): what the project’s Feedback to GitHub option does. Keep the select keys. A comment review neither approves nor requests changes.' }),
  change: msg({ id: 'board.github.change', defaultMessage: 'Change…', description: 'A button under “Feedback to GitHub” in the card dialog (HI-3559): opens the option in Version Control → Workflow → GitHub.' }),
  drafted: msg({ id: 'board.github.drafted', defaultMessage: 'Drafted from {reviewer}’s verdict', description: 'Over a review draft in the card dialog (HI-3559): which reviewer agent’s verdict it is. {reviewer} is an agent’s name.' }),
  footer: msg({ id: 'board.github.footer', defaultMessage: 'Ends with “{footer}”.', description: 'Under a review draft (HI-3559): the line it ends with on GitHub, naming the model (quoted in English as posted).' }),
  comments: msg({ id: 'board.github.comments', defaultMessage: '{n, plural, one {With your # open line comment on this revision.} other {With your # open line comments on this revision.}}', description: 'Under a review draft or the box for a review of the user’s own (HI-3559): the user’s open line comments it carries to GitHub.' }),
  post: msg({ id: 'board.github.post', defaultMessage: 'Post to GitHub', description: 'A button in the card dialog (HI-3559): posts the review (a draft as edited, or the user’s own) to the pull request on GitHub.' }),
  postAgain: msg({ id: 'board.github.postAgain', defaultMessage: 'Post Again', description: 'A button on a review that wasn’t posted to GitHub (HI-3559): tries again.' }),
  discard: msg({ id: 'board.github.discard', defaultMessage: 'Discard', description: 'A button on a review draft (HI-3559): drops it, never posted.' }),
  posting: msg({ id: 'board.github.posting', defaultMessage: 'Being posted to GitHub…', description: 'A review in the card dialog (HI-3559) while it is posted.' }),
  posted: msg({ id: 'board.github.posted', defaultMessage: 'Posted {when} by {by, select, combwork {Combwork} other {you}}', description: 'A review posted to GitHub (HI-3559): when (a date and time), and by Combwork (an automatic one) or the user. Keep the select keys.' }),
  open: msg({ id: 'board.github.open', defaultMessage: 'Open on GitHub', description: 'A link on a posted review (HI-3559): opens it on GitHub.' }),
  carried: msg({ id: 'board.github.carried', defaultMessage: '{inline, plural, =0 {} one {# line comment on the diff} other {# line comments on the diff}}{both, select, yes {, } other {}}{listed, plural, =0 {} one {# listed in it} other {# listed in it}}', description: 'Under a posted review (HI-3559): how many of the user’s line comments sit on the pull request’s diff, and how many are listed in its text (lines GitHub’s diff doesn’t show). Keep the select key.' }),
  failed: msg({ id: 'board.github.failed', defaultMessage: 'Not posted: {error}', description: 'A review that couldn’t be posted to GitHub (HI-3559). {error} says why (often the GitHub CLI’s own words, in English).' }),
  discarded: msg({ id: 'board.github.discarded', defaultMessage: 'Discarded draft', description: 'A review draft the user discarded (HI-3559).' }),
  notNow: msg({ id: 'board.github.notNow', defaultMessage: 'Not posted: Feedback to GitHub doesn’t post agents’ drafts now.', description: 'Under a review draft the project’s option no longer lets be posted (HI-3559).' }),
  write: msg({ id: 'board.github.write', defaultMessage: 'Write a review', description: 'The placeholder of the box in a pull request card’s dialog where the user writes a review of their own to post (HI-3559).' }),
  postFailed: msg({ id: 'board.github.postFailed', defaultMessage: 'Couldn’t post to GitHub', description: 'An error’s title (HI-3559): a review couldn’t be posted; its message says why.' }),
  recovery: msg({ id: 'board.github.recovery', defaultMessage: '{why, select, abandoned {Combwork didn’t post this: Combwork closed before it did. Post it now, or discard it.} stale {This may not have been posted: Combwork closed while posting it.} other {This may have been posted: GitHub’s answer didn’t come, or couldn’t be read.}}', description: 'A notice on a review in a pull request card’s dialog (HI-3559) that wasn’t posted, or may or may not have been: an automatic post that never ran, one Combwork closed in the middle of, or one GitHub may have taken. Keep the select keys.' }),
  checkGithub: msg({ id: 'board.github.checkGithub', defaultMessage: 'Check on GitHub first', description: 'A link beside the notice that a review may have been posted (HI-3559): opens the pull request on GitHub, to look before posting it again.' }),
  approve: msg({ id: 'board.github.approve', defaultMessage: 'Approve on GitHub…', description: 'A button in a pull request card’s Feedback to GitHub (HI-3560): approves the pull request on GitHub as the user, after asking. Merging stays on GitHub.' }),
  approveTitle: msg({ id: 'board.github.approveTitle', defaultMessage: 'Approve pull request #{number} on {repo}?', description: 'The title of the question before approving a card’s pull request on GitHub (HI-3560). {number} is its number, {repo} its repository (owner/name).' }),
  approveMessage: msg({ id: 'board.github.approveMessage', defaultMessage: 'Combwork approves it on GitHub through your GitHub CLI, as your own account. Merging it stays yours, on GitHub: Combwork never merges a pull request.', description: 'The question before approving a card’s pull request on GitHub (HI-3560).' }),
  approveConfirm: msg({ id: 'board.github.approveConfirm', defaultMessage: 'Approve', description: 'The button of the question before approving a pull request on GitHub (HI-3560).' }),
  approved: msg({ id: 'board.github.approved', defaultMessage: 'You approved it on GitHub {when}. Merging stays on GitHub.', description: 'In a pull request card’s Feedback to GitHub (HI-3560): when the user approved the pull request from the card (a date and time).' }),
  approveFailed: msg({ id: 'board.github.approveFailed', defaultMessage: 'Couldn’t approve the pull request', description: 'An error’s title (HI-3560): approving the pull request on GitHub failed; its message says why.' }),
  discardFailed: msg({ id: 'board.github.discardFailed', defaultMessage: 'Couldn’t discard the draft', description: 'An error’s title (HI-3559): a review draft couldn’t be discarded; its message says why.' })
}

type ViewRow = GithubReviewsView['rows'][number]

function Row({ card, v, r, onDone }: { card: number; v: GithubReviewsView; r: ViewRow; onDone: () => void }) {
  // The text of its latest attempt, else its draft's (HR1's round 1, finding 3): kept as the row changes state, never reset.
  const [text, setText] = useState(r.text)
  const [busy, setBusy] = useState(false)
  const can = r.can
  const post = async (): Promise<void> => {
    setBusy(true)
    await actions.attempt(tr(T.postFailed), () => call('github:postReview', card, r.id, text))
    setBusy(false)
    onDone()
  }
  const discard = async (): Promise<void> => {
    if (!r.draft) return
    setBusy(true)
    await actions.attempt(tr(T.discardFailed), () => call('github:discardReview', card, r.draft!.seq))
    setBusy(false)
    onDone()
  }
  const buttons = (can.post || can.discard) && (
    <div className="flex">
      {can.post && (
        <button type="button" className="btn small primary" data-action="review-post" disabled={busy || !text.trim()} onClick={() => void post()}>
          <Icon name={busy ? 'loading' : 'github'} spin={busy} /> {tr(r.state === 'draft' ? T.post : T.postAgain)}
        </button>
      )}
      {can.discard && (
        <button type="button" className="btn small subtle" data-action="review-discard" disabled={busy} onClick={() => void discard()}>
          {tr(T.discard)}
        </button>
      )}
    </div>
  )
  const recovery = can.recovery && (
    <div className="warn-text" data-review-recovery={can.recovery}>
      {tr(T.recovery, { why: can.recovery })}{' '}
      {can.recovery !== 'abandoned' && (
        <a href={v.url} onClick={(e) => (e.preventDefault(), void call('app:openExternal', v.url))}>
          {tr(T.checkGithub)}
        </a>
      )}
    </div>
  )
  return (
    <div className="github-review" data-review={r.id} data-state={r.state}>
      {r.draft && <div className="s-desc">{tr(T.drafted, { reviewer: r.reviewerName ?? r.draft.reviewer })}</div>}
      {r.state === 'posted' && r.posted ? (
        <>
          <div className="github-review-head">
            <Icon name="check" /> {tr(T.posted, { when: formatDateTime(r.posted.at), by: r.posting?.by ?? 'user' })}
            {r.posted.url && (
              <a href={r.posted.url} onClick={(e) => (e.preventDefault(), void call('app:openExternal', r.posted!.url!))}>
                {tr(T.open)}
              </a>
            )}
          </div>
          <div className="github-review-body">{r.posted.body}</div>
          {r.posted.inline + r.posted.listed > 0 && <div className="s-desc">{tr(T.carried, { inline: r.posted.inline, listed: r.posted.listed, both: r.posted.inline && r.posted.listed ? 'yes' : 'no' })}</div>}
        </>
      ) : r.state === 'posting' && can.recovery !== 'stale' ? (
        <div className="muted">
          <Icon name="loading" spin /> {tr(T.posting)}
        </div>
      ) : r.state === 'discarded' ? (
        <div className="muted">{tr(T.discarded)}</div>
      ) : (
        <>
          {r.state === 'failed' && <div className="warn-text" data-review-error="">{tr(T.failed, { error: r.error ?? '' })}</div>}
          {recovery}
          <textarea className="input github-review-text" value={text} readOnly={!can.post} disabled={busy} onChange={(e) => setText(e.target.value)} />
          {v.footer && r.draft && r.model && <div className="s-desc">{tr(T.footer, { footer: githubFooter(r.model) })}</div>}
          {buttons || <div className="s-desc">{tr(T.notNow)}</div>}
        </>
      )}
    </div>
  )
}

/** A pull request's card's Feedback to GitHub, in its dialog. */
export function GithubFeedbackField({ card }: { card: TaskCard }) {
  const [view, setView] = useState<GithubReviewsView | null>(null)
  const [asked, setAsked] = useState(0)
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState(false)
  // Read again as the board changes (a verdict drafted, a post's result).
  const tasks = useStore((s) => s.tasks)
  const projectPath = useStore((s) => s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase())?.path ?? null)
  useEffect(() => {
    let live = true
    call('github:reviews', card.number).then(
      (v) => live && setView(v),
      () => live && setView(null)
    )
    return () => {
      live = false
    }
  }, [card.number, tasks, asked])
  if (card.source?.kind !== 'pr' || !view) return null
  const refresh = (): void => setAsked((n) => n + 1)
  // HI-3560: the user's accept, asked first; merging stays on GitHub.
  const approve = async (): Promise<void> => {
    // The pull request asked about is the one approved (HR1's round 1): main refuses it once the card is about another.
    const s = card.source!
    const target = { host: s.host, owner: s.owner, repo: s.repo, number: s.number }
    if (!(await confirm({ title: tr(T.approveTitle, { number: s.number, repo: `${s.owner}/${s.repo}` }), message: tr(T.approveMessage), confirmLabel: tr(T.approveConfirm) }))) return
    setBusy(true)
    await actions.attempt(tr(T.approveFailed), () => call('github:approvePr', card.number, target))
    setBusy(false)
    refresh()
  }
  const postOwn = async (): Promise<void> => {
    setBusy(true)
    const done = await actions.attempt(tr(T.postFailed), () => call('github:postReview', card.number, null, own))
    setBusy(false)
    // Its row keeps the text now, posted or not (a failed one shows it with Post Again).
    if (done) setOwn('')
    refresh()
  }
  return (
    <>
      <label>{tr(T.label)}</label>
      <div className="github-feedback" data-feedback={view.feedback}>
        <div className="s-desc">
          {tr(T.option, { option: view.feedback })}{' '}
          {projectPath && (
            <button type="button" className="btn small subtle" data-action="feedback-option" onClick={() => openWorkflowOption(projectPath, 'githubFeedback')}>
              {tr(T.change)}
            </button>
          )}
        </div>
        {[...view.rows].reverse().map((r) => (
          <Row key={r.id} card={card.number} v={view} r={r} onDone={refresh} />
        ))}
        <div className="flex github-approve" data-approved={view.approved ? 'yes' : 'no'}>
          {view.approved && <span className="s-desc">{tr(T.approved, { when: formatDateTime(view.approved) })}</span>}
          <span className="grow" />
          <button type="button" className="btn small" data-action="approve-pr" disabled={busy} onClick={() => void approve()}>
            <Icon name="check" /> {tr(T.approve)}
          </button>
        </div>
        {view.canWrite && (
          <div className="github-review" data-review="own">
            <textarea className="input github-review-text" placeholder={tr(T.write)} value={own} disabled={busy} onChange={(e) => setOwn(e.target.value)} />
            {view.openComments > 0 && <div className="s-desc">{tr(T.comments, { n: view.openComments })}</div>}
            <div className="flex">
              <button type="button" className="btn small" data-action="review-post-own" disabled={busy || (!own.trim() && !view.openComments)} onClick={() => void postOwn()}>
                <Icon name={busy ? 'loading' : 'github'} spin={busy} /> {tr(T.post)}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
