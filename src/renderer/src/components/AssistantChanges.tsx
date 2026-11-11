import { useState } from 'react'
import type { UndoFinalWhy } from '@shared/assistantActivity'
import { formatDateTime, formatTime } from '@shared/dates'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import type { AssistantAction, AssistantChangeRow, AssistantUndoResult } from '@shared/types'
import * as actions from '../actions'
import { lineOf, messageGroups, undoable, type MessageGroup } from '@shared/assistantChangeList'
import { undoChanges } from '../assistantUndo'
import { cardLabelOf, confirm, runOnce, useDateStyle, useStore } from '../store'
import { cx, timeAgo } from '../util'
import { ShowAllList } from './ShowAllList'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * What the Assistant did, by the user's message it came from (#1283, SPEC §16.14): "Your message at 08:14: 61 changes ·
 * Undo", the newest message open and the others folded, each change on its row with Undo, an undone one struck through
 * with when, what can't be undone said with why; Undo of a message asks first and then says what it did and what it kept.
 */

const M = {
  notDone: msg({ id: 'assistant.panel.notDone', defaultMessage: 'Not done: {error}', description: "Tooltip on something the Assistant was refused, after when: why ({error}, from Combwork's Agent API, in English)." }),
  message: msg({ id: 'assistant.undo.message', defaultMessage: 'Your message at {time}: {n, plural, one {# change} other {# changes}}', description: "The heading of the Assistant's changes made for one message of the user's ({time}: when it was sent, a time, or a date and time before today; {n}: how many changes)." }),
  messageNone: msg({ id: 'assistant.undo.messageNone', defaultMessage: 'Your message at {time}', description: "The heading of what the Assistant did for one message of the user's when it changed nothing ({time}: when it was sent)." }),
  undo: msg({ id: 'assistant.undo.undo', defaultMessage: 'Undo', description: "A button: undoes a change the Assistant made (on its row), or every change it made for a message (on the message's heading)." }),
  undoChange: msg({ id: 'assistant.undo.undoChange', defaultMessage: 'Undo: {change}', description: "A change's Undo button, for screen readers ({change}: the change, as its row says it)." }),
  undoMessage: msg({ id: 'assistant.undo.undoMessage', defaultMessage: 'Undo the changes for your message at {time}', description: "A message's Undo button, for screen readers ({time}: when the message was sent)." }),
  askTitle: msg({ id: 'assistant.undo.askTitle', defaultMessage: '{n, plural, one {Undo # change?} other {Undo # changes?}}', description: "The question before every change the Assistant made for a message is undone." }),
  askMessage: msg({ id: 'assistant.undo.askMessage', defaultMessage: 'Changes made since by you or an agent are kept.', description: "The question before the Assistant's changes for a message are undone: what someone changed afterwards isn't overwritten." }),
  askFinal: msg({ id: 'assistant.undo.askFinal', defaultMessage: "{n, plural, one {# change can't be undone, such as a prompt that was sent: it is listed with why.} other {# changes can't be undone, such as prompts that were sent: they are listed with why.}}", description: "Under the question before a message's changes are undone, when some of them can't be." }),
  working: msg({ id: 'assistant.undo.working', defaultMessage: 'Undoing…', description: "The Undo button of the question while the changes are being undone." }),
  failed: msg({ id: 'assistant.undo.failed', defaultMessage: "Could not undo the Assistant's change", description: "An error notice: undoing a change the Assistant made failed; the reason follows." }),
  undoneAt: msg({ id: 'assistant.undo.undoneAt', defaultMessage: 'Undone {when}', description: "Beside a change of the Assistant's that was undone ({when}: \"5 minutes ago\", lower case)." }),
  partly: msg({ id: 'assistant.undo.partly', defaultMessage: 'Partly undone', description: "Beside a change of the Assistant's when undo put back some of it and kept the rest (someone changed it since); its tooltip says what." }),
  kept: msg({ id: 'assistant.undo.kept', defaultMessage: 'Kept', description: "Beside a change of the Assistant's that undo left as it is (someone changed it since, or it is gone); its tooltip says why." }),
  final: msg({ id: 'assistant.undo.final', defaultMessage: "Can't be undone", description: "Beside a change of the Assistant's that undo can't take back (a prompt sent, a comment); its tooltip says why." }),
  card: msg({ id: 'assistant.undo.card', defaultMessage: '{card}: {fields}', description: "A change the Assistant made to a card ({card}: the card, \"#12 Fix the login\"; {fields}: what it changed, \"labels and column\")." }),
  made: msg({ id: 'assistant.undo.made', defaultMessage: 'Made {card}', description: "A card the Assistant made ({card}: \"#12 Fix the login\"); undo archives it." }),
  resultUndone: msg({ id: 'assistant.undo.resultUndone', defaultMessage: '{n, plural, one {# change undone} other {# changes undone}}', description: "What an undo of a message's changes did: how many it put back." }),
  resultKept: msg({ id: 'assistant.undo.resultKept', defaultMessage: '{n, plural, one {# kept as it is:} other {# kept as they are:}}', description: "What an undo of a message's changes did: how many it left, each listed after it with why." }),
  resultFinal: msg({ id: 'assistant.undo.resultFinal', defaultMessage: "{n, plural, one {# can't be undone:} other {# can't be undone:}}", description: "What an undo of a message's changes did: how many it couldn't take back, each listed after it with why." }),
  resultAlready: msg({ id: 'assistant.undo.resultAlready', defaultMessage: '{n, plural, one {# undone before} other {# undone before}}', description: "What an undo of a message's changes did: how many were undone already." }),
  resultLine: msg({ id: 'assistant.undo.resultLine', defaultMessage: '{change}: {why}', description: "A change in what an undo did ({change}: the change; {why}: why it was kept, or can't be undone)." }),
  dismiss: msg({ id: 'assistant.undo.dismiss', defaultMessage: 'Close what the undo did', description: "A button that closes the note under a message saying what its undo did." }),
  changed: msg({ id: 'assistant.undo.changed', defaultMessage: '{fields} changed since', description: "Why undo left part of a change of the Assistant's as it is: someone (the user or an agent) changed it afterwards ({fields}: \"labels\", \"title and column\")." }),
  gone: msg({ id: 'assistant.undo.gone', defaultMessage: "it's gone", description: "Why undo left a change of the Assistant's: the card, lane or agent it was about no longer exists. Lower case." }),
  ended: msg({ id: 'assistant.undo.ended', defaultMessage: 'the lane has ended', description: "Why undo left a change of the Assistant's to a lane (a card loop's record): the lane is over. Lower case." }),
  error: msg({ id: 'assistant.undo.error', defaultMessage: 'failed: {error}', description: "Why undo didn't put back part of a change of the Assistant's: it failed ({error}: Combwork's reason, in English). Lower case; Undo is offered again." })
}

/** What a field of a change is, in a few words (a card's, a lane's, an agent's, a setting's). */
const FIELD = msg({
  id: 'assistant.undo.field',
  defaultMessage:
    '{field, select, title {title} description {description} labels {labels} blocked {blocked} blockedBy {blocked by} links {links} agent {agent} column {column} project {project} waitingFor {waiting} created {the card} cards {cards} reviewer {reviewer} rounds {rounds} waitMinutes {wait} name {name} provider {provider} connection {connection} model {model} effort {effort} permissionMode {permission mode} use200kContext {context size} mcpServers {MCP servers} lastSessionId {conversation} value {value} removed {removed models} run {the run} agents {agents} layout {layout} workflow {workflow options} other {{field}}}',
  description: "What part of something the Assistant changed (lower case, listed after a card or in why undo kept it): a card's title, labels, column… (waitingFor, HI-2618: its mark that it waits on purpose); a lane's cards, reviewer, rounds, wait; an agent's provider, model, effort…; a setting's value; run: an agent it started; agents, layout, workflow: a project's agents, page layout and workflow options a template's load replaced (HI-1502). Select keys: the field."
})

/** Why each kind of change, or part of one, can't be undone (UNDO_FINAL's codes, #1282's English in the Agent API). */
const FINAL: Record<UndoFinalWhy, Msg> = {
  prompt: msg({ id: 'assistant.undo.why.prompt', defaultMessage: "A prompt that was sent can't be taken back.", description: "Why a change of the Assistant's can't be undone: it prompted an agent." }),
  message: msg({ id: 'assistant.undo.why.message', defaultMessage: "A message that was sent can't be taken back.", description: "Why a change of the Assistant's can't be undone: it sent an agent a message." }),
  comment: msg({ id: 'assistant.undo.why.comment', defaultMessage: "A comment stays: undo doesn't take back what was said.", description: "Why part of a change of the Assistant's can't be undone: a comment on a card." }),
  handOver: msg({ id: 'assistant.undo.why.handOver', defaultMessage: "A hand-over can't be undone: the work went to the other agent.", description: "Why a change of the Assistant's can't be undone: it handed an agent's work over to another." }),
  projectMade: msg({ id: 'assistant.undo.why.projectMade', defaultMessage: "A project it made stays: remove it from Combwork if it isn't wanted.", description: "Why a change of the Assistant's can't be undone: it created a project." }),
  projectOpened: msg({ id: 'assistant.undo.why.projectOpened', defaultMessage: "A project it opened stays open: close it if it isn't wanted.", description: "Why a change of the Assistant's can't be undone: it opened (activated) a project." }),
  projectClosed: msg({ id: 'assistant.undo.why.projectClosed', defaultMessage: 'A project it closed stays closed: open it again if it is wanted.', description: "Why a change of the Assistant's can't be undone: it closed (deactivated) a project." }),
  agentAdded: msg({ id: 'assistant.undo.why.agentAdded', defaultMessage: "An agent it added stays: remove it in the project's agents if it isn't wanted.", description: "Why a change of the Assistant's can't be undone: it added an agent to a project." }),
  agentStopped: msg({ id: 'assistant.undo.why.agentStopped', defaultMessage: "An agent it stopped isn't started again by undo: start it if it should run.", description: "Why a change of the Assistant's can't be undone: it stopped an agent." }),
  cardsOrder: msg({ id: 'assistant.undo.why.cardsOrder', defaultMessage: "The cards' order isn't put back.", description: "Why a change of the Assistant's can't be undone: it put cards in order in a column." }),
  withdrawn: msg({ id: 'assistant.undo.why.withdrawn', defaultMessage: "Messages it withdrew aren't sent again.", description: "Why a change of the Assistant's can't be undone: it withdrew messages waiting for an agent." }),
  laneEnded: msg({ id: 'assistant.undo.why.laneEnded', defaultMessage: 'A lane that ended stays ended: start it again if it should go on.', description: "Why a change of the Assistant's can't be undone: it ended a lane (a card loop's record)." }),
  decision: msg({ id: 'assistant.undo.why.decision', defaultMessage: 'A decision it recorded stays: only you change or remove decisions.', description: "Why part of a change of the Assistant's can't be undone: it recorded the user's decision on a card." }),
  cardPlace: msg({ id: 'assistant.undo.why.cardPlace', defaultMessage: "The card's place in its column isn't put back.", description: "Why part of a change of the Assistant's can't be undone: it moved a card up or down its column." }),
  context: msg({ id: 'assistant.undo.why.context', defaultMessage: 'The doc sections to read first stay as set.', description: "Why part of a change of the Assistant's can't be undone: it set a card's doc sections to read first." }),
  nothing: msg({ id: 'assistant.undo.why.nothing', defaultMessage: 'It changed nothing undo puts back.', description: "Why a change of the Assistant's can't be undone: nothing it did is something undo puts back." }),
  start: msg({ id: 'assistant.undo.why.start', defaultMessage: "Its start stays in the card's work: undo moves the card back, it doesn't unstart it.", description: "What of a card's start by the Assistant stays when it is undone." }),
  putBack: msg({ id: 'assistant.undo.why.putBack', defaultMessage: 'Its reason stays as a comment.', description: "What of the Assistant putting a card back stays when it is undone: the reason it gave." }),
  submit: msg({ id: 'assistant.undo.why.submit', defaultMessage: "Its submission stays in the card's work.", description: "What of a card's submission for review by the Assistant stays when it is undone." }),
  declarePaths: msg({ id: 'assistant.undo.why.declarePaths', defaultMessage: 'The paths it declared stay with the card.', description: "What of the Assistant declaring a card's paths stays when it is undone." }),
  startReview: msg({ id: 'assistant.undo.why.startReview', defaultMessage: "The review it started stays in the card's work.", description: "What of a review the Assistant started stays when it is undone." }),
  verdict: msg({ id: 'assistant.undo.why.verdict', defaultMessage: "Its verdict stays in the card's work, and its round with it.", description: "What of a review verdict by the Assistant stays when it is undone." }),
  reportMerge: msg({ id: 'assistant.undo.why.reportMerge', defaultMessage: "The merge it reported stays in the card's work.", description: "What of a merge the Assistant reported stays when it is undone." }),
  ask: msg({ id: 'assistant.undo.why.ask', defaultMessage: 'Its question stays under For you: answer or dismiss it there.', description: "What of a question the Assistant asked on a card stays when it is undone. For you: the board's section of what waits on the user (glossary)." }),
  cannot: msg({ id: 'assistant.undo.why.cannot', defaultMessage: 'Its request stays under For you: answer or dismiss it there.', description: "What of a request the Assistant made on a card stays when it is undone. For you: the board's section of what waits on the user (glossary)." }),
  request: msg({ id: 'assistant.undo.why.request', defaultMessage: 'Its request to the builder stays as a comment.', description: "What of a request the Assistant made to a card's builder stays when it is undone." }),
  removedFromQueue: msg({ id: 'assistant.undo.why.removedFromQueue', defaultMessage: "Taking it out of the merge queue stays in the card's work: it is queued again only by Retry merge or a new approval.", description: "What of the Assistant taking a card out of the merge queue stays when it is undone. Retry merge: a command on the card (use it as Combwork shows it)." }),
  retriedMerge: msg({ id: 'assistant.undo.why.retriedMerge', defaultMessage: "Its Retry merge stays in the card's work.", description: "What of the Assistant's Retry merge on a card (a command that queues a returned card again) stays when it is undone." }),
  queuePaused: msg({ id: 'assistant.undo.why.queuePaused', defaultMessage: 'A merge queue it paused stays paused: resume it if it should run.', description: "Why a change of the Assistant's can't be undone: it paused a project's merge queue." }),
  freshRetried: msg({ id: 'assistant.undo.why.freshRetried', defaultMessage: "A lane agent's new conversation tried again isn't stopped by undo: end the lane if it isn't wanted.", description: "Why a change of the Assistant's can't be undone (HI-2034): it retried a lane agent's new conversation, which Combwork had stopped trying to start. Glossary: lane, conversation." }),
  teamPaused: msg({ id: 'assistant.undo.why.teamPaused', defaultMessage: 'A team it paused stays paused: resume it if it should go on.', description: "Why a change of the Assistant's can't be undone (HI-2081): it paused its workspace's team before an update (Combwork starts no card and wakes no agent until it resumes)." }),
  teamResumed: msg({ id: 'assistant.undo.why.teamResumed', defaultMessage: "A team it resumed isn't paused again: pause it if it should wait.", description: "Why a change of the Assistant's can't be undone (HI-2081): it resumed its workspace's team, which was paused before an update." }),
  queueResumed: msg({ id: 'assistant.undo.why.queueResumed', defaultMessage: "A merge queue it resumed isn't paused again: pause it if it shouldn't run.", description: "Why a change of the Assistant's can't be undone: it resumed a project's merge queue." }),
  forwardResolved: msg({ id: 'assistant.undo.why.forwardResolved', defaultMessage: "A forward merge it handed to a builder stays ended, and the card made for the builder stays: put that card on hold or remove it if it isn't wanted.", description: "Why a change of the Assistant's can't be undone (HI-2959): it used Resolve on a builder on a forward merge the merge queue returned, which ended it and made a card for an agent to do the merge by hand." }),
  queueForwarded: msg({ id: 'assistant.undo.why.queueForwarded', defaultMessage: "A forward merge it asked for isn't taken back: remove it from the merge queue if it shouldn't merge.", description: "Why a change of the Assistant's can't be undone (HI-2679): it asked for a forward merge, bringing one of a project's branches up to date with another through the merge queue. Remove from queue: the card's command, as translated there." }),
  retargeted: msg({ id: 'assistant.undo.why.retargeted', defaultMessage: "Cards and slots it moved to a project's new target aren't moved back: set a card's Merges into again if it should go back.", description: "Why a change of the Assistant's can't be undone (HI-2680): it moved cards and free slots from a project's finished branch to its new Work merges into. Merges into is the card's field: as translated there." }),
  slotReleased: msg({ id: 'assistant.undo.why.slotReleased', defaultMessage: "A slot it released isn't kept or held again: the next work that needs a slot may take it.", description: "Why a change of the Assistant's can't be undone: it released a slot (a folder cards are built in) that was kept for an agent or held by an agent's ended session." }),
  connectionMade: msg({ id: 'assistant.undo.why.connectionMade', defaultMessage: "A connection it made stays: remove it in Settings → Accounts & Connections if it isn't wanted.", description: "Why a change of the Assistant's can't be undone (HI-2108): it made a connection (a named setup of model, effort and mode on an account that agents choose). Settings → Accounts & Connections names a section." }),
  connectionChanged: msg({ id: 'assistant.undo.why.connectionChanged', defaultMessage: "A connection it changed isn't changed back: edit it in Settings → Accounts & Connections.", description: "Why a change of the Assistant's can't be undone (HI-2108): it changed a connection's name, model, effort, context or mode. Settings → Accounts & Connections names a section." }),
  laneReorderNow: msg({ id: 'assistant.undo.why.laneReorderNow', defaultMessage: "A card a lane reorder applied now put back stays in Todo: undo puts back only the lane's order.", description: "What of the Assistant's lane reorder applied now (HI-1995) stays when it is undone: the card it put back in the Todo column stays there; undo restores only the order of the lane's cards." }),
  templateCards: msg({ id: 'assistant.undo.why.templateCards', defaultMessage: "The cards and lanes of the agents a template replaced stay as the load left them (cards put back, lanes ended): undo doesn't give them back.", description: "What of the Assistant loading a template into a project (it replaced the project's agents) stays when it is undone: the replaced agents' open cards were put back and their lanes ended (HI-1502)." })
}

const fieldsText = (fields: readonly string[]): string => fmt.list(fields.map((field) => tr(FIELD, { field })))
const whyText = (whys: readonly UndoFinalWhy[] | undefined, english: string | undefined): string => (whys?.length ? whys.map((w) => tr(FINAL[w])).join(' ') : (english ?? ''))
/** The Assistant's own line for a change, as it recorded it (English, as its other lines in this list). */
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Why undo kept each part of a change as it is: the fields changed since, gone, the lane ended, or failed. */
function skippedText(r: Pick<AssistantUndoResult, 'skipped'>): string {
  const changed = r.skipped.filter((s) => s.why === 'changed').map((s) => s.field)
  const out = [
    ...(changed.length ? [tr(M.changed, { fields: fieldsText(changed) })] : []),
    ...(r.skipped.some((s) => s.why === 'gone') ? [tr(M.gone)] : []),
    ...(r.skipped.some((s) => s.why === 'ended') ? [tr(M.ended)] : []),
    ...[...new Set(r.skipped.filter((s) => s.why === 'failed').map((s) => s.error ?? ''))].map((error) => tr(M.error, { error }))
  ]
  return fmt.list(out, 'unit')
}

/** When a message was sent, as its heading says it: a time today, a date and time before. */
const sentAt = (iso: string): string => (new Date(iso).toDateString() === new Date().toDateString() ? formatTime(iso) : formatDateTime(iso))

/** The Assistant's changes and actions in this window's workspace, by the user's message, newest first. */
export function AssistantChanges() {
  const changes = useStore((s) => s.assistantChanges)
  const acts = useStore((s) => s.assistantActions)
  const tasks = useStore((s) => s.tasks)
  // Messages opened or folded by the user; the newest is open until folded.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  useDateStyle()
  const groups = messageGroups(changes, acts)
  if (!groups.length) return null
  const cardText = (n: number): string => {
    const card = tasks.find((c) => c.number === n)
    return card ? `${cardLabelOf({ tasks }, n)} ${card.title}` : cardLabelOf({ tasks }, n)
  }
  const changeText = (c: { kind?: AssistantChangeRow['kind']; card?: number; what: string; fields?: string[] }): string => {
    if (c.card !== undefined && c.fields?.includes('created')) return tr(M.made, { card: cardText(c.card) })
    if (c.card !== undefined && c.kind === 'card' && c.fields?.length) return tr(M.card, { card: cardText(c.card), fields: fieldsText(c.fields) })
    if (c.card !== undefined && c.kind === 'final') return cardText(c.card)
    return capital(c.what)
  }
  return (
    <div className="assistant-actions" id="assistant-done-list">
      {groups.map((g, i) => {
        const open = toggled.has(g.id) ? i !== 0 : i === 0
        const toggle = (): void => setToggled((t) => (t.has(g.id) ? new Set([...t].filter((x) => x !== g.id)) : new Set([...t, g.id])))
        return <MessageGroupView key={g.id} g={g} open={open} toggle={toggle} changeText={changeText} />
      })}
    </div>
  )
}

/** One message: its heading (when, how many changes, Undo), what its undo did, and its rows while open. */
function MessageGroupView({ g, open, toggle, changeText }: { g: MessageGroup; open: boolean; toggle: () => void; changeText: (c: { kind?: AssistantChangeRow['kind']; card?: number; what: string; fields?: string[] }) => string }) {
  const running = useStore((s) => s.running)
  const undone = useStore((s) => s.assistantUndone)
  const [result, setResult] = useState<AssistantUndoResult[] | null>(null)
  const time = sentAt(g.at)
  const left = g.changes.filter(undoable)
  const finals = g.changes.filter((c) => c.kind === 'final')
  const undoGroup = async (): Promise<void> => {
    let results: AssistantUndoResult[] | null = null
    const ok = await confirm({
      title: tr(M.askTitle, { n: left.length }),
      message: tr(M.askMessage),
      ...(finals.length ? { detail: tr(M.askFinal, { n: finals.length }) } : {}),
      confirmLabel: tr(M.undo),
      busyLabel: tr(M.working),
      run: async () => (results = await undoChanges({ group: g.id }))
    })
    if (ok && results) setResult(results)
  }
  const undoOne = (c: AssistantChangeRow): void => void runOnce(`undo:${c.id}`, () => actions.attempt(tr(M.failed), () => undoChanges({ change: c.id })))
  const rows: ({ change: AssistantChangeRow } | { action: AssistantAction })[] = [...g.changes.map((change) => ({ change })), ...g.actions.map((action) => ({ action }))].sort((a, b) => {
    const at = (x: typeof a): string => ('change' in x ? x.change.at : x.action.at)
    return at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0
  })
  const changeRow = (c: AssistantChangeRow) => {
    // A card's change by its card; another by the Assistant's line for it while this window has it ("Changed Settings → …:
    // 20 → 50"), else as it was recorded.
    const text = c.kind === 'card' || c.card !== undefined ? changeText(c) : (lineOf(g, c)?.text ?? changeText(c))
    // Once undone, what undo did, as kept with the change whoever undid it (#1283 round 2): Undone, Partly undone (some
    // of it put back) or Kept (none of it), with why. One not undone yet may have failed here: Undo stays offered, and why.
    const o = c.undoneAt ? c.outcome : undefined
    const failed = !c.undoneAt ? undone[c.id]?.skipped.filter((x) => x.why === 'failed') : undefined
    const status = c.kind === 'final' ? 'final' : c.undoneAt ? (o?.skipped.length ? (o.undone.length ? 'partly' : 'kept') : 'undone') : null
    const why = c.kind === 'final' ? whyText(c.finalWhy, c.final) : o?.skipped.length ? skippedText(o) : failed?.length ? skippedText({ skipped: failed }) : ''
    // Its tooltip: the whole line, when, what of it changed (beside a line that doesn't say), and why it was kept or can't be undone.
    const tip = [text, formatDateTime(c.at), ...(c.fields.length && c.kind !== 'card' ? [fieldsText(c.fields)] : []), ...(why ? [why] : [])]
    return (
      <Tooltip block content={tip.join('\n')}>
        <div className={cx('assistant-action', status === 'undone' && 'undone', status === 'final' && 'final')} data-change={c.id} data-status={status ?? 'open'}>
          <Icon name={status === 'final' ? 'lock' : status ? 'discard' : 'check'} />
          <span className="assistant-action-text">{text}</span>
          {status === 'final' && <span className="faint assistant-change-status">{tr(M.final)}</span>}
          {(status === 'undone' || status === 'partly' || status === 'kept') && <span className="faint assistant-change-status">{status === 'kept' ? tr(M.kept) : status === 'partly' ? tr(M.partly) : tr(M.undoneAt, { when: timeAgo(c.undoneAt) })}</span>}
          {undoable(c) && (
            <button
              className="btn small subtle assistant-undo"
              disabled={!!running[`undo:${c.id}`]}
              aria-label={tr(M.undoChange, { change: text })}
              title={failed?.length ? why : undefined}
              onClick={(e) => {
                e.stopPropagation()
                undoOne(c)
              }}
            >
              <Icon name="discard" /> {tr(M.undo)}
            </button>
          )}
          {/* When it was made, while nothing else is said beside it (its tooltip has it always). */}
          {!status && <span className="faint">{timeAgo(c.at)}</span>}
        </div>
      </Tooltip>
    )
  }
  const actionRow = (x: AssistantAction) => (
    <Tooltip block content={[formatDateTime(x.at), ...(x.error ? [tr(M.notDone, { error: x.error })] : [])].join('\n')}>
      <div className={cx('assistant-action', !x.ok && 'failed')}>
        <Icon name={x.ok ? 'check' : 'circle-slash'} />
        <span className="assistant-action-text">{x.text}</span>
        <span className="faint">{timeAgo(x.at)}</span>
      </div>
    </Tooltip>
  )
  const label = g.changes.length ? tr(M.message, { time, n: g.changes.length }) : tr(M.messageNone, { time })
  return (
    <section className="assistant-change-group" data-group={g.id} aria-label={label}>
      <div className="assistant-change-head">
        <button type="button" className="assistant-change-toggle" aria-expanded={open} onClick={toggle}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="assistant-action-text">{label}</span>
        </button>
        {left.length > 0 && (
          <button className="btn small subtle assistant-undo-group" aria-label={tr(M.undoMessage, { time })} onClick={() => void undoGroup()}>
            <Icon name="discard" /> {tr(M.undo)}
          </button>
        )}
      </div>
      {result && <UndoResultView results={result} changeText={changeText} close={() => setResult(null)} />}
      {open && <ShowAllList items={rows} few={3} keyOf={(x) => ('change' in x ? x.change.id : x.action.id)} renderItem={(x) => ('change' in x ? changeRow(x.change) : actionRow(x.action))} label={label} className="assistant-actions-list" />}
    </section>
  )
}

/** What an undo of a message did: how many it put back, and each it kept or couldn't undo, with why. */
function UndoResultView({ results, changeText, close }: { results: AssistantUndoResult[]; changeText: (c: { card?: number; what: string; fields?: string[]; kind?: AssistantChangeRow['kind'] }) => string; close: () => void }) {
  const done = results.filter((r) => !r.already && !r.final && r.undone.length)
  const kept = results.filter((r) => !r.already && !r.final && r.skipped.length)
  const finals = results.filter((r) => r.final !== undefined)
  const already = results.filter((r) => r.already)
  // Each change by its card (its why says what of it), else by the Assistant's line.
  const line = (r: AssistantUndoResult, why: string) => <li key={r.change}>{tr(M.resultLine, { change: changeText({ card: r.card, what: r.what, kind: 'final' }), why })}</li>
  return (
    <div className="assistant-undo-result" role="status">
      <div className="flex">
        <span>{fmt.list([tr(M.resultUndone, { n: done.length }), ...(already.length ? [tr(M.resultAlready, { n: already.length })] : [])], 'unit')}</span>
        <IconButton icon="close" title={tr(M.dismiss)} onClick={close} />
      </div>
      {kept.length > 0 && (
        <>
          <div>{tr(M.resultKept, { n: kept.length })}</div>
          <ul className="assistant-undo-kept">{kept.map((r) => line(r, skippedText(r)))}</ul>
        </>
      )}
      {finals.length > 0 && (
        <>
          <div>{tr(M.resultFinal, { n: finals.length })}</div>
          <ul className="assistant-undo-final">{finals.map((r) => line(r, whyText(r.finalWhy, r.final)))}</ul>
        </>
      )}
    </div>
  )
}

/** "Done by the Assistant (n)": how many rows the list has (changes, and the actions listed on their own). */
export function useDoneCount(): number {
  const changes = useStore((s) => s.assistantChanges)
  const acts = useStore((s) => s.assistantActions)
  return messageGroups(changes, acts).reduce((n, g) => n + g.changes.length + g.actions.length, 0)
}
