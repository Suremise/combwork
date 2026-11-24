import { useEffect, useState } from 'react'
import { msg, tr } from '@shared/i18n'
import { formatDateTime } from '@shared/dates'
import { associationLabel, type FeedbackAuthor, type FeedbackItem, type PrFeedbackRead } from '@shared/prFeedback'
import type { TaskCard } from '@shared/types'
import type { WorkBadge } from '@shared/workflow/workView'
import * as actions from '../actions'
import { call } from '../api'
import { cardLabelOf, get, loadTasks, set } from '../store'
import { Icon } from './ui'

/**
 * HI-3554: a pull request's comments on its card: for a card whose GitHub source is a pull request, or one in PR open,
 * the conversation comments, reviews and inline review threads GitHub has on it, read when the dialog opens (and on
 * Refresh), each with its author and how GitHub relates them to the repository. "Address feedback" makes a fix card of
 * the ones ticked (all at first); nothing reaches an agent until then, and then only quoted as outside text.
 */

const T = {
  label: msg({ id: 'board.prFeedback.label', defaultMessage: 'Pull request comments', description: 'HI-3554: a field label in the card dialog: the comments, reviews and review threads on the card’s GitHub pull request.' }),
  reading: msg({ id: 'board.prFeedback.reading', defaultMessage: 'Reading them from GitHub…', description: 'HI-3554: the card dialog’s pull request comments while Combwork asks GitHub for them.' }),
  none: msg({ id: 'board.prFeedback.none', defaultMessage: 'No comments on pull request #{number} yet.', description: 'HI-3554: the card dialog: the card’s GitHub pull request has no comments, reviews with text, or review threads. {number} its number.' }),
  problem: msg({ id: 'board.prFeedback.problem', defaultMessage: 'Its comments couldn’t be read: {problem, select, missing {the GitHub CLI isn’t installed} signedOut {the GitHub CLI isn’t signed in on {host}} timeout {the GitHub CLI didn’t answer in time} other {{detail}}}.', description: 'HI-3554: the card dialog: reading the pull request’s comments with the GitHub CLI (gh) failed. Keep the select keys. {host} a GitHub host name; {detail} gh’s own words (English).' }),
  as: msg({ id: 'board.prFeedback.as', defaultMessage: '{as, select, owner {owner} member {member} collaborator {collaborator} outside {outside contributor} other {standing unknown}}', description: 'HI-3554: beside a comment’s author in the card dialog: how GitHub relates them to the repository: its owner, a member of its organisation, a collaborator, someone from outside it, or GitHub didn’t say. Keep the select keys.' }),
  kind: msg({ id: 'board.prFeedback.kind', defaultMessage: '{kind, select, review {Review{state, select, APPROVED {: approved} CHANGES_REQUESTED {: changes requested} other {}}} thread {On {path}{line, select, none {} other {, line {line}}}} other {Comment}}', description: 'HI-3554: what a pull request comment is, in the card dialog: a review’s own text (with its verdict: approved or changes requested), an inline review thread on a file ({path}, at {line}, a number), or a conversation comment. Keep the select keys and {path} as it is.' }),
  replies: msg({ id: 'board.prFeedback.replies', defaultMessage: '{n, plural, one {# reply} other {# replies}}', description: 'HI-3554: under an inline review thread in the card dialog: how many replies it has.' }),
  pick: msg({ id: 'board.prFeedback.pick', defaultMessage: 'Address this one', description: 'HI-3554: the tick box tooltip on a pull request comment in the card dialog: whether Address feedback includes it.' }),
  refresh: msg({ id: 'board.prFeedback.refresh', defaultMessage: 'Refresh', description: 'HI-3554: a button in the card dialog: read the pull request’s comments from GitHub again.' }),
  address: msg({ id: 'board.prFeedback.address', defaultMessage: 'Address feedback ({n, number})', description: 'HI-3554: a button in the card dialog: makes a fix card of the ticked pull request comments ({n}, how many), working on the pull request’s branch. Nothing is sent to an agent until that card is started.' }),
  notOpen: msg({ id: 'board.prFeedback.notOpen', defaultMessage: 'Pull request #{number} isn’t open: its feedback can’t be addressed here.', description: 'HI-3554: the card dialog: the pull request was merged or closed, so Address feedback is off. {number} its number.' }),
  outside: msg({ id: 'board.prFeedback.outsideNote', defaultMessage: 'Anyone can comment on a public repository: the fix card’s agent reads these quoted as someone else’s words, never as instructions.', description: 'HI-3554: a note under the Address feedback button in the card dialog: the chosen comments reach the fix card’s agent only as quoted outside text.' }),
  made: msg({ id: 'board.prFeedback.made', defaultMessage: 'Made {card} to address them.', description: 'HI-3554: in the card dialog after Address feedback: the fix card made in Todo ({card}, its key like HI-12).' }),
  openMade: msg({ id: 'board.prFeedback.openMade', defaultMessage: 'Open it', description: 'HI-3554: a button beside “Made HI-12 to address them.”: opens that fix card.' }),
  failed: msg({ id: 'board.prFeedback.failed', defaultMessage: 'No fix card was made', description: 'HI-3554: the title of an error after Address feedback in the card dialog.' }),
  cardTitle: msg({ id: 'board.prFeedback.cardTitle', defaultMessage: 'Address feedback on PR #{number}', description: 'HI-3554: the title of a fix card made by Address feedback ({number}, the pull request’s number). PR is short for pull request.' }),
  cardDesc: msg({ id: 'board.prFeedback.cardDesc', defaultMessage: 'Address the comments chosen from pull request #{number} on {repo} (made from {card}). They are with the card’s GitHub source, quoted as someone else’s words.', description: 'HI-3554: the description of a fix card made by Address feedback: what to do. {number} the pull request’s number, {repo} owner/name, {card} the card it was made from (a key like HI-12).' })
}

/** Who wrote it and how GitHub relates them to the repository, and when. */
function Who({ a, at }: { a: FeedbackAuthor; at: string | null }) {
  const as = associationLabel(a.association)
  return (
    <span className="s-desc" data-association={as}>
      <strong>{a.login ?? '?'}</strong> · {tr(T.as, { as })}
      {at && <> · {formatDateTime(at)}</>}
    </span>
  )
}

function Item({ i, on, setOn }: { i: FeedbackItem; on: boolean; setOn: (v: boolean) => void }) {
  return (
    <div className="github-review" data-feedback-item={i.id} data-kind={i.kind}>
      <div className="github-review-head">
        <input type="checkbox" checked={on} title={tr(T.pick)} aria-label={tr(T.pick)} onChange={(e) => setOn(e.target.checked)} />
        <span className="s-label">{tr(T.kind, { kind: i.kind, state: i.state ?? 'none', path: i.path ?? '', line: i.line != null ? String(i.line) : 'none' })}</span>
        <Who a={i} at={i.at} />
        <span className="grow" />
        {i.url && (
          <a href={i.url} onClick={(e) => (e.preventDefault(), void call('app:openExternal', i.url!))}>
            <Icon name="link-external" />
          </a>
        )}
      </div>
      <div className="github-review-body">{i.body}</div>
      {!!i.replies?.length && (
        <div className="pr-feedback-replies">
          <span className="s-desc faint">{tr(T.replies, { n: i.replies.length })}</span>
          {i.replies.map((r, k) => (
            <div key={k}>
              <Who a={r} at={r.at} />
              <div className="github-review-body">{r.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** In the card dialog: its pull request's comments, and Address feedback. */
export function PrFeedbackField({ card, b }: { card: TaskCard; b: WorkBadge | null | undefined }) {
  const shown = card.source?.kind === 'pr' || (b?.stage === 'prOpen' && !!b.pullRequest?.url)
  const [read, setRead] = useState<PrFeedbackRead | null>(null)
  const [asked, setAsked] = useState(0)
  const [off, setOff] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<number | null>(null)
  useEffect(() => {
    if (!shown) return
    let live = true
    setRead(null)
    call('tasks:prFeedback', card.number).then(
      (v) => live && setRead(v),
      () => live && setRead({ target: null, problem: 'failed', detail: null })
    )
    return () => {
      live = false
    }
  }, [card.number, shown, asked])
  if (!shown) return null
  const refresh = (
    <button type="button" className="btn small subtle" data-action="pr-feedback-refresh" onClick={() => setAsked((n) => n + 1)}>
      <Icon name="refresh" /> {tr(T.refresh)}
    </button>
  )
  if (!read)
    return (
      <>
        <label>{tr(T.label)}</label>
        <div className="s-desc" data-pr-feedback="reading">
          {tr(T.reading)}
        </div>
      </>
    )
  if ('problem' in read) {
    if (read.problem === 'none') return null
    return (
      <>
        <label>{tr(T.label)}</label>
        <div className="flex" data-pr-feedback="problem">
          <span className="s-desc">{tr(T.problem, { problem: read.problem, host: read.target?.host ?? '', detail: read.detail ?? '' })}</span>
          {refresh}
        </div>
      </>
    )
  }
  const t = read.target
  const picked = read.items.filter((i) => !off.has(i.id))
  const address = async (): Promise<void> => {
    setBusy(true)
    const repo = `${t.owner}/${t.repo}`
    const from = cardLabelOf(get(), card.number)
    const text = { title: tr(T.cardTitle, { number: t.number }), description: tr(T.cardDesc, { number: t.number, repo, card: from }) }
    const done = await actions.attempt(tr(T.failed), () => call('tasks:addressFeedback', card.number, t, picked.map((i) => i.id), text))
    setBusy(false)
    if (!done) return
    if (!get().tasks.some((c) => c.number === done.number)) await loadTasks()
    setMade(done.number)
  }
  return (
    <>
      <label>{tr(T.label)}</label>
      <div className="pr-feedback" data-pr-feedback={read.items.length} data-pr-open={read.open ? 'yes' : 'no'}>
        {!read.items.length && <div className="s-desc">{tr(T.none, { number: t.number })}</div>}
        {read.items.map((i) => (
          <Item
            key={i.id}
            i={i}
            on={!off.has(i.id)}
            setOn={(v) =>
              setOff((was) => {
                const next = new Set(was)
                if (v) next.delete(i.id)
                else next.add(i.id)
                return next
              })
            }
          />
        ))}
        {!read.open && <div className="s-desc">{tr(T.notOpen, { number: t.number })}</div>}
        <div className="flex">
          {refresh}
          <span className="grow" />
          <button type="button" className="btn small" data-action="address-feedback" disabled={busy || !read.open || !picked.length} onClick={() => void address()}>
            <Icon name="comment-discussion" /> {tr(T.address, { n: picked.length })}
          </button>
        </div>
        {!!read.items.length && <div className="s-desc faint">{tr(T.outside)}</div>}
        {made !== null && (
          <div className="flex" data-feedback-made={made}>
            <span className="s-desc">{tr(T.made, { card: cardLabelOf(get(), made) })}</span>
            <button type="button" className="btn small subtle" data-action="open-fix-card" onClick={() => set({ taskOpen: made })}>
              {tr(T.openMade)}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
