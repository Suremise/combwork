import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { msg, tr } from '@shared/i18n'
import { branchSummary, inboxName, inboxStateText, type InboxItem } from '@shared/inbox'
import { gist } from '@shared/gist'
import type { NeedYouCard } from '@shared/needYou'
import { cardLabel } from '@shared/projectKeys'
import type { SessionStatus } from '@shared/types'
import type { ForYouItem } from '@shared/workflow/workView'
import { openInboxChanges, openInboxItem, openInboxMerge, openRequest, useNeedsYou } from '../inbox'
import { set, useLanguage, useStore } from '../store'
import { useNow } from '../usage'
import { cx, timeAgo } from '../util'
import { AssistantMark } from './AssistantMark'
import { kindText, requestText } from './ForYou'
import { Icon, Tooltip } from './ui'

/** The status dot an inbox item shows: its agent's for what it needs. */
const dotOf = (i: InboxItem): SessionStatus => (i.kind === 'review' || i.kind === 'finished' ? 'finished' : i.kind === 'failed' || i.kind === 'error' ? 'error' : 'waiting')

/**
 * The status bar's "n need you" (#1632): exactly what For you lists, the cards' requests and the agents stopped in their
 * panes; beside it, quieter, the agents finished since you last looked ("3 finished"), never counted as a need. Each
 * opens the popover. Hidden when nothing needs you, nothing finished unseen and nothing is left to review.
 */
export function InboxStatusItem() {
  const { count, grouped, finished, toReview } = useNeedsYou()
  const open = useStore((s) => s.inboxOpen)
  useLanguage()
  if (!count && !finished.length && !toReview.length && !open) return null
  const toggle = (): void => set((s) => ({ inboxOpen: !s.inboxOpen }))
  return (
    <>
      {(count > 0 || !finished.length) && (
        <Tooltip content={count ? needYouTip(grouped.cards.length, grouped.agents.length) : tr(msg({ id: 'board.inbox.toReviewTip', defaultMessage: 'Worktree agents with work to review', description: "Tooltip of the status bar's inbox item when only worktree agents' work waits (\"1 to review\")." }))}>
          <div className={cx('status-item', 'inbox-item', count > 0 && 'caution')} data-inbox-toggle onClick={toggle} role="button" aria-expanded={open}>
            {count ? (
              <>
                <Icon name="bell-dot" /> {tr(msg({ id: 'board.inbox.needYouCount', defaultMessage: '{n, plural, one {# needs you} other {# need you}}', description: "The status bar's inbox item: how many things wait for the user, requests on cards and agents stopped in their panes (\"2 need you\"). Keep it short." }), { n: count })}
              </>
            ) : (
              <>
                <Icon name="git-merge" /> {tr(msg({ id: 'board.inbox.toReviewCount', defaultMessage: '{n, plural, one {# to review} other {# to review}}', description: "The status bar's inbox item: how many worktree agents have work for the user to review (\"1 to review\"). Keep it short." }), { n: toReview.length })}
              </>
            )}
          </div>
        </Tooltip>
      )}
      {finished.length > 0 && (
        <Tooltip content={tr(msg({ id: 'board.inbox.finishedTip', defaultMessage: 'Agents that finished since you last looked at them. Nothing waits for you there: click to see them.', description: "Tooltip of the status bar's quiet item beside \"n need you\": what it counts (agents that finished their turn, not looked at since)." }))}>
          <div className="status-item inbox-item inbox-finished" data-inbox-toggle data-inbox-finished onClick={toggle} role="button" aria-expanded={open}>
            <Icon name="check" /> {tr(msg({ id: 'board.inbox.finishedCount', defaultMessage: '{n, plural, one {# finished} other {# finished}}', description: "The status bar's quiet item: how many agents finished their turn since the user last looked (\"3 finished\"). Keep it short." }), { n: finished.length })}
          </div>
        </Tooltip>
      )}
    </>
  )
}

/**
 * What the status bar's count is (HI-1931): "2 cards and 1 agent need you", each card counted once however many requests
 * it has, and an agent stopped on a counted card not again.
 */
function needYouTip(cards: number, agents: number): string {
  return tr(
    msg({
      id: 'board.inbox.needYouThings',
      defaultMessage:
        '{agents, plural, =0 {{cards, plural, one {# card needs you} other {# cards need you}}} other {{cards, plural, =0 {{agents, plural, one {# agent needs you} other {# agents need you}}} one {# card and {agents, plural, one {# agent} other {# agents}} need you} other {# cards and {agents, plural, one {# agent} other {# agents}} need you}}}}. Click to see them.',
      description: "Tooltip of the status bar's inbox item (\"3 need you\"): what it counts, as cards with requests for the user (each once, however many requests: approvals, decisions, questions) and agents stopped in their panes (a prompt, a sign-in, a question, an error; one stopped on a counted card isn't counted again). {cards} and {agents} are how many. Glossary: For you."
    }),
    { cards, agents }
  )
}

/** The inbox popover above the status bar: oldest first; a click goes to the agent. */
export function InboxPopover() {
  const open = useStore((s) => s.inboxOpen)
  const { grouped, count, finished, toReview } = useNeedsYou()
  const tasks = useStore((s) => s.tasks)
  const ref = useRef<HTMLDivElement>(null)
  useNow(30000)
  useLanguage()
  useEffect(() => {
    if (!open) return
    const close = (): void => set({ inboxOpen: false })
    const down = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('[data-inbox-toggle]')) close()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  if (!open) return null
  const row = (i: InboxItem, under = false) => (
    <div key={`${i.projectPath}#${i.agentId}`} className={cx('inbox-row', under && 'inbox-under')} role="button" onClick={() => openInboxItem(i)}>
      {i.assistant ? <AssistantMark status={dotOf(i)} unseen={i.kind === 'finished'} /> : <span className={cx('dot', dotOf(i), i.kind === 'finished' && 'unseen')} />}
      <div className="inbox-text">
        <div className="inbox-name">
          <strong>{inboxName(i)}</strong>
          {!i.assistant && ` · ${i.agentName}`}
        </div>
        <div className="inbox-state">{i.kind === 'review' && i.branch ? branchSummary(i.branch) : inboxStateText(i)}</div>
      </div>
      {i.kind === 'review' ? (
        <div className="inbox-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn subtle small" onClick={() => openInboxChanges(i)}>
            {tr(msg({ id: 'board.inbox.changes', defaultMessage: 'Changes', description: "Button on a worktree agent's row in the inbox: shows its changes in the Git tab." }))}
          </button>
          <button className="btn subtle small" onClick={() => openInboxMerge(i)}>
            {tr(msg({ id: 'board.inbox.merge', defaultMessage: 'Merge…', description: "Button on a worktree agent's row in the inbox: opens the merge dialog for its branch." }))}
          </button>
        </div>
      ) : (
        i.since && <span className="inbox-time">{timeAgo(i.since)}</span>
      )}
    </div>
  )
  // A card's request (For you): the card and what it asks; a click opens the card, where it is answered.
  const cardName = (n: number) => {
    const card = tasks.find((c) => c.number === n)
    return (
      <div className="inbox-name">
        <strong>{card ? cardLabel(card) : `#${n}`}</strong>
        {card && ` · ${card.title}`}
      </div>
    )
  }
  const request = (i: ForYouItem, under = false) => (
    <div key={i.request} className={cx('inbox-row', under && 'inbox-under')} role="button" data-request={i.request} onClick={() => openRequest(i)}>
      <Icon name="bell-dot" />
      <div className="inbox-text">
        {!under && cardName(i.card)}
        <div className="inbox-state">{`${kindText(i)}: ${gist(requestText(i), 120)}`}</div>
      </div>
      <span className="inbox-time">{timeAgo(i.since)}</span>
    </div>
  )
  // A card counted once (HI-1931): alone, its one request's row; with several requests, or an agent stopped on it, the
  // card's row ("3 questions") and each under it, each answered on its own.
  const card = (g: NeedYouCard) =>
    g.requests.length === 1 && !g.agents.length ? (
      request(g.requests[0])
    ) : (
      <div key={`card:${g.card}`} className="inbox-group" data-card-group={g.card}>
        <div className="inbox-row" role="button" onClick={() => set({ inboxOpen: false, taskOpen: g.card })}>
          <Icon name="bell-dot" />
          <div className="inbox-text">
            {cardName(g.card)}
            <div className="inbox-state">{tr(msg({ id: 'board.inbox.cardRequests', defaultMessage: '{n, plural, one {# question} other {# questions}}', description: "On a card's row in the For you popover (the status bar's \"need you\"), when it has several requests for the user (approvals, decisions, questions: all called questions here) or an agent stopped on it: how many requests ({n}). They are listed under it." }), { n: g.requests.length })}</div>
          </div>
          <span className="inbox-time">{timeAgo(g.since)}</span>
        </div>
        {g.requests.map((r) => request(r, true))}
        {g.agents.map((a) => row(a, true))}
      </div>
    )
  return createPortal(
    <div className="inbox-panel" ref={ref} role="dialog" aria-label={tr(msg({ id: 'board.inbox.panel', defaultMessage: 'What needs you', description: "The inbox popover's accessible name (above the status bar): requests on cards and agents waiting for the user, and agents that finished." }))}>
      <div className="inbox-section">{count ? tr(msg({ id: 'board.inbox.needYouHeading', defaultMessage: 'Need you ({n, number})', description: 'Heading in the inbox popover above what waits for the user (requests on cards, agents stopped in their panes), with how many ({n}).' }), { n: count }) : tr(msg({ id: 'board.inbox.needYouEmptyHeading', defaultMessage: 'Need you', description: 'Heading in the inbox popover above what waits for the user, when nothing does.' }))}</div>
      {count ? (
        <>
          {grouped.cards.map(card)}
          {grouped.agents.map((a) => row(a))}
        </>
      ) : (
        <div className="inbox-empty faint">{tr(msg({ id: 'board.inbox.nothing', defaultMessage: 'Nothing needs you right now.', description: 'The inbox popover when nothing waits for the user.' }))}</div>
      )}
      {finished.length > 0 && (
        <>
          <div className="inbox-section">{tr(msg({ id: 'board.inbox.finishedHeading', defaultMessage: 'Finished ({n, number})', description: 'Heading in the inbox popover above the agents that finished since the user last looked, with how many ({n}). Not something that waits for the user.' }), { n: finished.length })}</div>
          {finished.map((a) => row(a))}
        </>
      )}
      {toReview.length > 0 && (
        <>
          <div className="inbox-section">{tr(msg({ id: 'board.inbox.toReviewHeading', defaultMessage: 'To review ({n})', description: "Heading in the inbox popover above worktree agents whose work waits for the user's review, with how many ({n})." }), { n: toReview.length })}</div>
          {toReview.map((a) => row(a))}
        </>
      )}
    </div>,
    document.body
  )
}
