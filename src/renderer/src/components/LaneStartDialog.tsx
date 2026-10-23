import { useEffect, useState } from 'react'
import type { AgentInfo, ProjectInfo } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { cardLabel } from '@shared/projectKeys'
import { agentWorkflowRole, buildsWork, reviewsWork } from '@shared/workflow/roles'
import { call } from '../api'
import { NO_PROJECTS, get, notify, set, useLanguage, useStore } from '../store'
import { cx } from '../util'
import { BusyButton, Icon, IconButton, Modal, statusText, useBusy } from './ui'

/**
 * Start lane… (#1280, SPEC §16.11.3): a lane from the window, without the Assistant. The builder, the reviewer, the
 * cards in the order they are worked (picked from the project's Todo, moved up and down), an optional name and note.
 * Start records the lane and starts both agents, each in a fresh conversation with the generated brief. An agent
 * busy now: the dialog says so, and Wait and Start waits until both are idle, then starts (Cancel stops waiting).
 */

/** Opens Start lane… for a project (its path or name; null: the first with agents), with these cards chosen first. */
export function openLaneStart(project: string | null, cards: number[] = []): void {
  set({ laneStartFor: { project, cards } })
}

const BUSY = new Set(['working', 'starting', 'waiting', 'background', 'watching', 'signin'])
const busy = (a: AgentInfo | undefined): boolean => !!a?.live && BUSY.has(a.live.status)

/** Who may build and who may review, by their role in the workflow (#1430): either-role agents are in both lists. */
const builders = (p: ProjectInfo | null): AgentInfo[] => p?.agents.filter((a) => buildsWork(agentWorkflowRole(a))) ?? []
const reviewers = (p: ProjectInfo | null, builder: string): AgentInfo[] => p?.agents.filter((a) => a.id !== builder && reviewsWork(agentWorkflowRole(a))) ?? []
/** The first builder, and the first reviewer besides it. */
const firstPair = (p: ProjectInfo | null): { builder: string; reviewer: string } => {
  const builder = builders(p)[0]?.id ?? ''
  return { builder, reviewer: reviewers(p, builder)[0]?.id ?? '' }
}

const M = {
  title: msg({ id: 'board.laneStart.title', defaultMessage: 'Start Lane', description: "Title of the Start Lane dialog: a builder and a reviewer agent work through cards in turn (a lane, a card loop), started from the window. Glossary: lane." }),
  intro: msg({ id: 'board.laneStart.intro', defaultMessage: 'The builder works through the cards in this order, one at a time, and the reviewer reviews each. Both start in a new conversation with a brief: the cards, where the builder works, what the project’s rules ask, and your note.', description: 'At the top of the Start Lane dialog. Glossary: lane, rule.' }),
  project: msg({ id: 'board.laneStart.project', defaultMessage: 'Project', description: "A field label in the Start Lane dialog: the project whose cards the lane works through." }),
  builder: msg({ id: 'board.laneStart.builder', defaultMessage: 'Builder', description: 'A field label in the Start Lane dialog: the agent that builds the cards. Glossary: builder.' }),
  reviewer: msg({ id: 'board.laneStart.reviewer', defaultMessage: 'Reviewer', description: 'A field label in the Start Lane dialog: the agent that reviews each card. Glossary: reviewer.' }),
  noReviewer: msg({ id: 'board.laneStart.noReviewer', defaultMessage: 'No reviewer', description: 'A choice of the Start Lane dialog’s reviewer: the lane has none (the project’s rules may need one).' }),
  noAgents: msg({ id: 'board.laneStart.noAgents', defaultMessage: 'The project has no agents. Add one first.', description: 'In the Start Lane dialog: the chosen project has no agents to build the cards.' }),
  noBuilders: msg({ id: 'board.laneStart.noBuilders', defaultMessage: 'None of the project’s agents builds. Set Role in the workflow to Builder or Either in an agent’s settings.', description: 'In the Start Lane dialog: every agent of the project is a reviewer, so none can build the cards. Role in the workflow, Builder and Either are the Agent Settings field and its choices: use their translated names. Glossary: builder, either.' }),
  agentState: msg({ id: 'board.laneStart.agentState', defaultMessage: '{agent} ({status})', description: "An agent in the Start Lane dialog's choices, with what it is doing ({status}: \"Working…\", \"Not running\")." }),
  notRunning: msg({ id: 'board.laneStart.notRunning', defaultMessage: 'not running', description: "An agent's state in the Start Lane dialog's choices: its session isn't running (it starts with the brief)." }),
  cards: msg({ id: 'board.laneStart.cards', defaultMessage: 'Cards, in order', description: 'A field label in the Start Lane dialog: the cards the lane works through, in the order they are worked.' }),
  noCards: msg({ id: 'board.laneStart.noCards', defaultMessage: 'No cards yet: add them from the project’s Todo below.', description: "In the Start Lane dialog's list of cards, while none is chosen. Todo is a board column." }),
  addCard: msg({ id: 'board.laneStart.addCard', defaultMessage: 'Add a card from Todo…', description: "The first entry of the Start Lane dialog's card picker: choosing a card adds it at the end of the lane's list. Todo is a board column." }),
  up: msg({ id: 'board.laneStart.up', defaultMessage: 'Move {card} up', description: 'Tooltip of a button in the Start Lane dialog: moves the card ({card}, its key) one place earlier in the lane.' }),
  down: msg({ id: 'board.laneStart.down', defaultMessage: 'Move {card} down', description: 'Tooltip of a button in the Start Lane dialog: moves the card ({card}, its key) one place later in the lane.' }),
  remove: msg({ id: 'board.laneStart.remove', defaultMessage: 'Take {card} out of the lane', description: "Tooltip of a button in the Start Lane dialog: removes the card ({card}, its key) from the lane's list (the card stays on the board)." }),
  name: msg({ id: 'board.laneStart.name', defaultMessage: 'What it is about (optional)', description: "A field label in the Start Lane dialog: a short name for the lane, shown in the Progress panel." }),
  note: msg({ id: 'board.laneStart.note', defaultMessage: 'Note for the agents (optional)', description: 'A field label in the Start Lane dialog: anything the user wants both agents to know, added to their brief.' }),
  busy: msg({ id: 'board.laneStart.busyNow', defaultMessage: '{agents} {n, plural, one {is busy} other {are busy}} now: Wait and Start waits until {n, plural, one {it is} other {they are}} idle, then starts the lane.', description: "In the Start Lane dialog: the chosen builder or reviewer ({agents}: their names, joined) can't start a new conversation now; the Wait and Start button waits for them." }),
  waiting: msg({ id: 'board.laneStart.waiting', defaultMessage: 'Waiting for {agents} to be idle…', description: 'In the Start Lane dialog, after Wait and Start: it waits for the busy agents ({agents}: their names, joined) before starting the lane. Cancel stops waiting.' }),
  start: msg({ id: 'board.laneStart.start', defaultMessage: 'Start Lane', description: 'Button of the Start Lane dialog: records the lane and starts both agents.' }),
  waitAndStart: msg({ id: 'board.laneStart.waitAndStart', defaultMessage: 'Wait and Start', description: 'Button of the Start Lane dialog while the builder or reviewer is busy: waits until they are idle, then starts the lane.' }),
  starting: msg({ id: 'board.laneStart.starting', defaultMessage: 'Starting…', description: 'The Start Lane button while the lane is being started.' }),
  cancel: msg({ id: 'board.laneStart.cancel', defaultMessage: 'Cancel', description: 'Button of the Start Lane dialog: closes it without starting anything (and stops waiting).' }),
  started: msg({ id: 'board.laneStart.started', defaultMessage: 'Lane started: {pair}', description: "A toast's title after a lane started from the window: its builder / reviewer ({pair}). Glossary: lane." }),
  startedText: msg({ id: 'board.laneStart.startedText', defaultMessage: '{n, plural, one {# card} other {# cards}}. Each agent starts in a new conversation with its brief.', description: "The text of the toast after a lane started: how many cards ({n}), and that both agents started fresh with their brief." }),
  notStarted: msg({ id: 'board.laneStart.notStarted', defaultMessage: "{agent} didn't start", description: "A toast's title: the lane was recorded, but one of its agents ({agent}) couldn't be started. The reason follows." }),
  notStartedText: msg({ id: 'board.laneStart.notStartedText', defaultMessage: '{why} The lane is recorded: start {agent} yourself, or end the lane from its row in the Progress panel.', description: "The text of the toast when a lane's agent ({agent}) didn't start: why ({why}, a sentence), and what the user can do." }),
  show: msg({ id: 'board.laneStart.show', defaultMessage: 'Show', description: 'A button on the toast after a lane started: shows its builder.' })
}

export function LaneStartDialog() {
  useLanguage()
  const req = useStore((s) => s.laneStartFor)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const tasks = useStore((s) => s.tasks)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [builder, setBuilder] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [cards, setCards] = useState<number[]>([])
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [waiting, setWaiting] = useState(false)
  const action = useBusy()
  const project: ProjectInfo | null = projects.find((p) => p.path === projectPath) ?? null

  // Opened: its project and cards, its first builder and first reviewer (#1430).
  useEffect(() => {
    // Closed (Cancel, Escape, another workspace): nothing waits any more (HR6's #1280 round 1).
    if (!req) return setWaiting(false)
    const named = req.project?.toLowerCase()
    const p = projects.find((x) => x.path.toLowerCase() === named || x.name.toLowerCase() === named) ?? projects.find((x) => x.agents.length > 0) ?? projects[0] ?? null
    setProjectPath(p?.path ?? null)
    const pair = firstPair(p)
    setBuilder(pair.builder)
    setReviewer(pair.reviewer)
    setCards(req.cards.filter((n) => tasks.some((c) => c.number === n && c.project.toLowerCase() === p?.name.toLowerCase())))
    setName('')
    setNote('')
    setWaiting(false)
    action.setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  const agentOf = (id: string): AgentInfo | undefined => project?.agents.find((a) => a.id === id)
  const chosen = [agentOf(builder), reviewer ? agentOf(reviewer) : undefined].filter((a): a is AgentInfo => !!a)
  const busyNow = chosen.filter(busy)
  const ready = !!project && !!agentOf(builder) && builder !== reviewer && cards.length > 0

  const go = async (): Promise<void> => {
    // Only for the request still open: a dialog closed or opened again since starts nothing.
    if (!project || !ready || !req || get().laneStartFor !== req) return
    const out = await action.run('start', () => call('lanes:start', project.path, { builder, reviewer: reviewer || null, cards, note, name }))
    if (!out) return setWaiting(false)
    const r = out.value
    const pair = r.lane.reviewer ? `${r.lane.builder.name} / ${r.lane.reviewer.name}` : r.lane.builder.name
    notify('success', tr(M.started, { pair }), tr(M.startedText, { n: cards.length }), [{ label: tr(M.show), command: 'agent.show', args: [project.path, builder] }])
    for (const s of r.started.filter((x) => x.how === 'failed')) notify('error', tr(M.notStarted, { agent: s.name }), tr(M.notStartedText, { why: s.why ?? '', agent: s.name }))
    set({ laneStartFor: null })
  }

  // Waiting (Wait and Start): starts once both are idle.
  useEffect(() => {
    if (req && waiting && busyNow.length === 0 && !action.busy) void go()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, waiting, busyNow.length])

  if (!req) return null
  const close = (): void => {
    setWaiting(false)
    set({ laneStartFor: null })
  }
  const todo = project ? tasks.filter((c) => !c.archived && c.column === 'todo' && c.project.toLowerCase() === project.name.toLowerCase() && !cards.includes(c.number)) : []
  const cardOf = (n: number) => tasks.find((c) => c.number === n)
  const move = (i: number, by: -1 | 1): void => {
    const next = [...cards]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    setCards(next)
  }
  const agentChoice = (a: AgentInfo) => (
    <option key={a.id} value={a.id}>
      {tr(M.agentState, { agent: a.name, status: a.live ? statusText(a.live) : tr(M.notRunning) })}
    </option>
  )
  const names = fmt.list(busyNow.map((a) => a.name))
  return (
    <Modal
      title={tr(M.title)}
      icon="list-ordered"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(M.cancel)}
          </button>
          <BusyButton className="primary" busy={action.busy === 'start' || waiting} busyLabel={waiting && busyNow.length ? tr(M.waiting, { agents: names }) : tr(M.starting)} disabled={!ready} onClick={() => (busyNow.length ? setWaiting(true) : void go())}>
            <Icon name="play" /> {busyNow.length ? tr(M.waitAndStart) : tr(M.start)}
          </BusyButton>
        </>
      }
    >
      <div className="lane-start" data-waiting={waiting || undefined}>
        <p style={{ marginTop: 0 }}>{tr(M.intro)}</p>
        <div className="agent-form">
          {projects.length > 1 && (
            <>
              <label htmlFor="lane-start-project">{tr(M.project)}</label>
              <select
                id="lane-start-project"
                className="select"
                value={projectPath ?? ''}
                disabled={waiting}
                onChange={(e) => {
                  const p = projects.find((x) => x.path === e.target.value) ?? null
                  setProjectPath(p?.path ?? null)
                  const pair = firstPair(p)
                  setBuilder(pair.builder)
                  setReviewer(pair.reviewer)
                  setCards([])
                }}
              >
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {project && !project.agents.length ? (
            <p className="faint">{tr(M.noAgents)}</p>
          ) : (
            <>
              <label htmlFor="lane-start-builder">{tr(M.builder)}</label>
              <select
                id="lane-start-builder"
                className="select"
                value={builder}
                disabled={waiting}
                onChange={(e) => {
                  setBuilder(e.target.value)
                  // An either-role reviewer chosen as the builder: the next reviewer instead.
                  if (reviewer === e.target.value) setReviewer(reviewers(project, e.target.value)[0]?.id ?? '')
                }}
              >
                {builders(project).map(agentChoice)}
              </select>
              {!builders(project).length && <p className="faint span2" data-no-builders>{tr(M.noBuilders)}</p>}
              <label htmlFor="lane-start-reviewer">{tr(M.reviewer)}</label>
              <select id="lane-start-reviewer" className="select" value={reviewer} disabled={waiting} onChange={(e) => setReviewer(e.target.value)}>
                <option value="">{tr(M.noReviewer)}</option>
                {reviewers(project, builder).map(agentChoice)}
              </select>
            </>
          )}
          <label>{tr(M.cards)}</label>
          <ol className="lane-start-cards" aria-label={tr(M.cards)}>
            {cards.length === 0 && <li className="faint lane-start-none">{tr(M.noCards)}</li>}
            {cards.map((n, i) => {
              const c = cardOf(n)
              const key = c ? cardLabel(c) : `#${n}`
              return (
                <li key={n} data-card={n}>
                  <span className="lane-start-key">{key}</span>
                  <span className="lane-start-card-title">{c?.title}</span>
                  <IconButton icon="arrow-up" title={tr(M.up, { card: key })} disabled={waiting || i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="arrow-down" title={tr(M.down, { card: key })} disabled={waiting || i === cards.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="close" title={tr(M.remove, { card: key })} disabled={waiting} onClick={() => setCards(cards.filter((x) => x !== n))} />
                </li>
              )
            })}
          </ol>
          {/* The form's grid: the picker goes under the list, in the fields' column. */}
          {todo.length > 0 && <span aria-hidden="true" />}
          {todo.length > 0 && (
            <select className="select lane-start-add" value="" disabled={waiting} aria-label={tr(M.addCard)} onChange={(e) => e.target.value && setCards([...cards, Number(e.target.value)])}>
              <option value="">{tr(M.addCard)}</option>
              {todo.map((c) => (
                <option key={c.number} value={c.number}>
                  {cardLabel(c)} {c.title}
                </option>
              ))}
            </select>
          )}
          <label htmlFor="lane-start-name">{tr(M.name)}</label>
          <input id="lane-start-name" className="input" value={name} disabled={waiting} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="lane-start-note">{tr(M.note)}</label>
          <textarea id="lane-start-note" className={cx('input', 'lane-start-note')} rows={3} value={note} disabled={waiting} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </div>
        {busyNow.length > 0 && <p className="lane-start-busy">{waiting ? tr(M.waiting, { agents: names }) : tr(M.busy, { agents: names, n: busyNow.length })}</p>}
      </div>
    </Modal>
  )
}
