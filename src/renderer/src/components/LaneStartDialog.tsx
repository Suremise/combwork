import { useEffect, useState } from 'react'
import type { AgentInfo, LaneStartInfo, ProjectInfo } from '@shared/types'
import { fmt, msg, tr } from '@shared/i18n'
import { LANE_NAME_MAX } from '@shared/lanes'
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
/** The reviewer list's Pool choice (#1443): never an agent's id, which Combwork makes. */
const POOL = '*pool'
/**
 * A builder's reviewer to start with: the one it is paired with (#1436's `pairedWith`, by name), else the pool where the
 * rules have one, else the first reviewer besides it.
 */
const reviewerFor = (p: ProjectInfo | null, builder: string, pool: boolean): string => {
  const paired = p?.agents.find((a) => a.id === builder)?.pairedWith?.toLowerCase()
  const list = reviewers(p, builder)
  return list.find((a) => !!paired && a.name.toLowerCase() === paired)?.id ?? (pool ? POOL : (list[0]?.id ?? ''))
}
/** The first builder, and its reviewer. */
const firstPair = (p: ProjectInfo | null, pool: boolean): { builder: string; reviewer: string } => {
  const builder = builders(p)[0]?.id ?? ''
  return { builder, reviewer: reviewerFor(p, builder, pool) }
}

const M = {
  title: msg({ id: 'board.laneStart.title', defaultMessage: 'Start Lane', description: "Title of the Start Lane dialog: a builder and a reviewer agent work through cards in turn (a lane, a card loop), started from the window. Glossary: lane." }),
  intro: msg({ id: 'board.laneStart.intro', defaultMessage: 'The builder works through the cards in this order, one at a time, and the reviewer reviews each. Both start in a new conversation with a brief: the cards, where the builder works, what the project’s rules ask, and your note.', description: 'At the top of the Start Lane dialog. Glossary: lane, rule.' }),
  project: msg({ id: 'board.laneStart.project', defaultMessage: 'Project', description: "A field label in the Start Lane dialog: the project whose cards the lane works through." }),
  builder: msg({ id: 'board.laneStart.builder', defaultMessage: 'Builder', description: 'A field label in the Start Lane dialog: the agent that builds the cards. Glossary: builder.' }),
  target: msg({ id: 'board.laneStart.target', defaultMessage: 'Merges into', description: 'HI-2556: a field label in the Start Lane dialog: the branch the lane’s cards are made from and merge into (Darren’s name for it).' }),
  targetDefault: msg({ id: 'board.laneStart.targetDefault', defaultMessage: '{branch} (the project’s)', description: 'HI-2556: the first choice of the Start Lane dialog’s Merges into: the project’s Work merges into, {branch} its name.' }),
  reviewer: msg({ id: 'board.laneStart.reviewer', defaultMessage: 'Reviewer', description: 'A field label in the Start Lane dialog: the agent that reviews each card. Glossary: reviewer.' }),
  pool: msg({ id: 'board.laneStart.pool', defaultMessage: 'The reviewer pool ({agents})', description: 'A choice of the Start Lane dialog’s reviewer (#1443): the lane is reviewed by the project’s pool of reviewer agents ({agents}: their names, joined), each card going to the next free one. Glossary: reviewer pool.' }),
  poolNobody: msg({ id: 'board.laneStart.poolNobody', defaultMessage: 'nobody yet', description: 'In the Start Lane dialog’s reviewer choice “The reviewer pool (…)”, in place of the names: no agent of the project reviews yet.' }),
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
  waiting: msg({ id: 'board.laneStart.waiting', defaultMessage: 'Waiting for these agents to be idle: {agents}…', description: 'In the Start Lane dialog, after Wait and Start: it waits for the busy agents ({agents}: their names, joined) before starting the lane. Cancel stops waiting. The names follow a colon (glossary §1 rule 4).' }),
  start: msg({ id: 'board.laneStart.start', defaultMessage: 'Start Lane', description: 'Button of the Start Lane dialog: records the lane and starts both agents.' }),
  waitAndStart: msg({ id: 'board.laneStart.waitAndStart', defaultMessage: 'Wait and Start', description: 'Button of the Start Lane dialog while the builder or reviewer is busy: waits until they are idle, then starts the lane.' }),
  starting: msg({ id: 'board.laneStart.starting', defaultMessage: 'Starting…', description: 'The Start Lane button while the lane is being started.' }),
  cancel: msg({ id: 'board.laneStart.cancel', defaultMessage: 'Cancel', description: 'Button of the Start Lane dialog: closes it without starting anything (and stops waiting).' }),
  started: msg({ id: 'board.laneStart.started', defaultMessage: 'Lane started: {pair}', description: "A toast's title after a lane started from the window: its builder / reviewer ({pair}). Glossary: lane." }),
  startedText: msg({ id: 'board.laneStart.startedText', defaultMessage: '{n, plural, one {# card} other {# cards}}. Each agent starts in a new conversation with its brief.', description: "The text of the toast after a lane started: how many cards ({n}), and that both agents started fresh with their brief." }),
  deferred: msg({ id: 'board.laneStart.deferred', defaultMessage: '{agent} starts once it is free', description: "A toast's title (HI-2034): the lane was started, but its agent {agent} was busy (in a turn, or reading a message Combwork had just given it), so it isn't in its new conversation yet." }),
  deferredText: msg({ id: 'board.laneStart.deferredText', defaultMessage: 'Combwork starts {agent} in a new conversation with the lane’s brief as soon as its turn is over. The lane’s row says so meanwhile, and its cards wait for it.', description: "The text of the toast when a lane's agent ({agent}) was busy as the lane started (HI-2034): Combwork starts it in a new conversation once it is free; the lane's row in the Progress panel says it waits. Glossary: lane, conversation." }),
  notStarted: msg({ id: 'board.laneStart.notStarted', defaultMessage: "{agent} didn't start", description: "A toast's title: the lane was recorded, but one of its agents ({agent}) couldn't be started. The reason follows." }),
  notStartedText: msg({ id: 'board.laneStart.notStartedText', defaultMessage: '{why} The lane is recorded: start {agent} yourself, or end the lane from its row in the Progress panel.', description: "The text of the toast when a lane's agent ({agent}) didn't start: why ({why}, a sentence), and what the user can do." }),
  applyNow: msg({ id: 'board.laneStart.applyNow', defaultMessage: 'Apply now', description: "A checkbox of the Start Lane dialog (HI-1995), off by default, shown when the builder's running lane has a card being worked: the new list applies at once instead of after that card is Done." }),
  applyNowHint: msg({ id: 'board.laneStart.applyNowHint', defaultMessage: "{builder}'s lane is working on {card}: this list applies once {card} is Done. Apply now puts {card} back in Todo first (its work stays on its branch), so the new order applies at once, and tells {builder}.", description: "Under the Apply now checkbox of the Start Lane dialog (HI-1995): {builder} (an agent's name) has a running lane whose card {card} (its key) is in progress. Todo is a board column." }),
  applyNowNot: msg({ id: 'board.laneStart.applyNowNot', defaultMessage: "{builder}'s lane is working on {card}, which is in {column, select, review {Review} other {Approved}}: this list applies once it is Done. It can't be put back now without losing its {column, select, review {review} other {approval and merge}}.", description: "In the Start Lane dialog (HI-1995), with Apply now unavailable: the builder's ({builder}) lane card {card} is already in the Review or Approved column (select; translate each)." }),
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
  const [applyNow, setApplyNow] = useState(false)
  // Its Merges into (HI-2556): '' for the project's own.
  const [target, setTarget] = useState('')
  const lanes = useStore((s) => s.lanes)
  // What the project's rules offer (#1443): the reviewer pool, read for the project chosen.
  const [info, setInfo] = useState<{ path: string; info: LaneStartInfo } | null>(null)
  const action = useBusy()
  const project: ProjectInfo | null = projects.find((p) => p.path === projectPath) ?? null
  const pool = info && info.path === projectPath ? info.info.pool : null
  const targets = info && info.path === projectPath ? info.info.targets : null

  // Opened: its project and cards, its first builder and first reviewer (#1430).
  useEffect(() => {
    // Closed (Cancel, Escape, another workspace): nothing waits any more (HR6's #1280 round 1).
    if (!req) return setWaiting(false)
    const named = req.project?.toLowerCase()
    const p = projects.find((x) => x.path.toLowerCase() === named || x.name.toLowerCase() === named) ?? projects.find((x) => x.agents.length > 0) ?? projects[0] ?? null
    setProjectPath(p?.path ?? null)
    const pair = firstPair(p, false)
    setBuilder(pair.builder)
    setReviewer(pair.reviewer)
    setCards(req.cards.filter((n) => tasks.some((c) => c.number === n && c.project.toLowerCase() === p?.name.toLowerCase())))
    setName('')
    setNote('')
    setWaiting(false)
    setApplyNow(false)
    // Each opening starts on the project's own branch (HI-2556): a pick never carries over to the next lane.
    setTarget('')
    action.setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  // The pool the project's rules offer, read as its project is chosen; with one, a builder that isn't paired starts with it.
  useEffect(() => {
    if (!req || !projectPath) return
    let gone = false
    void call('lanes:startInfo', projectPath)
      .then((got) => {
        if (gone) return
        setInfo({ path: projectPath, info: got })
        // A branch only another project lists is never kept (HI-2556).
        setTarget((t) => (got.targets?.others.includes(t) ? t : ''))
        // The reviewer the builder starts with, now that the pool is known (opened, another project or builder chosen).
        setReviewer(reviewerFor(project, builder, !!got.pool))
      })
      .catch(() => !gone && setInfo({ path: projectPath, info: { pool: null, targets: null } }))
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, projectPath, builder])

  const agentOf = (id: string): AgentInfo | undefined => project?.agents.find((a) => a.id === id)
  const pooled = reviewer === POOL && !!pool
  const chosen = [agentOf(builder), reviewer && !pooled ? agentOf(reviewer) : undefined].filter((a): a is AgentInfo => !!a)
  const busyNow = chosen.filter(busy)
  const ready = !!project && !!agentOf(builder) && builder !== reviewer && (reviewer !== POOL || pooled) && cards.length > 0
  // The builder's running lane with its own card in flight (HI-1995): this start edits that lane, its list queued until
  // that card is Done unless applied now.
  const running = project ? (lanes ?? []).find((l) => (l.state === 'active' || l.state === 'paused') && l.project.toLowerCase() === project.name.toLowerCase() && l.builder.id === builder) : undefined
  const flying = running?.cards.find((c) => !c.elsewhere && (c.column === 'doing' || c.column === 'review' || c.column === 'passed'))
  const keyOf = (n: number): string => {
    const c = tasks.find((x) => x.number === n)
    return c ? cardLabel(c) : `#${n}`
  }
  const canApplyNow = !!flying && flying.column === 'doing' && cards[0] !== flying.number

  const go = async (): Promise<void> => {
    // Only for the request still open: a dialog closed or opened again since starts nothing.
    if (!project || !ready || !req || get().laneStartFor !== req) return
    const out = await action.run('start', () => call('lanes:start', project.path, { builder, reviewer: pooled || !reviewer ? null : reviewer, ...(pooled ? { pool: true } : {}), cards, note, name, ...(applyNow && canApplyNow ? { applyNow: true } : {}), ...(target && targets && !running ? { target } : {}) }))
    if (!out) return setWaiting(false)
    const r = out.value
    const pair = r.lane.reviewer ? `${r.lane.builder.name} / ${r.lane.reviewer.name}` : r.lane.pool && pool ? `${r.lane.builder.name} / ${tr(M.pool, { agents: poolNames(builder) })}` : r.lane.builder.name
    notify('success', tr(M.started, { pair }), tr(M.startedText, { n: cards.length }), [{ label: tr(M.show), command: 'agent.show', args: [project.path, builder] }])
    for (const s of r.started.filter((x) => x.how === 'failed')) notify('error', tr(M.notStarted, { agent: s.name }), tr(M.notStartedText, { why: s.why ?? '', agent: s.name }))
    // Busy as the lane started (HI-2034): started in its new conversation once free, the lane's row saying so meanwhile.
    for (const s of r.started.filter((x) => x.how === 'deferred')) notify('info', tr(M.deferred, { agent: s.name }), tr(M.deferredText, { agent: s.name }))
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
  function poolNames(b: string): string {
    const in_ = (pool ?? []).filter((a) => a.id !== b).map((a) => a.name)
    return in_.length ? fmt.list(in_) : tr(M.poolNobody)
  }
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
                  const pair = firstPair(p, false)
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
                  // Its own reviewer (#1436's pairing), else the pool or the first reviewer: never itself.
                  setReviewer(reviewerFor(project, e.target.value, !!pool))
                }}
              >
                {builders(project).map(agentChoice)}
              </select>
              {!builders(project).length && <p className="faint span2" data-no-builders>{tr(M.noBuilders)}</p>}
              <label htmlFor="lane-start-reviewer">{tr(M.reviewer)}</label>
              <select id="lane-start-reviewer" className="select" value={reviewer} disabled={waiting} onChange={(e) => setReviewer(e.target.value)}>
                <option value="">{tr(M.noReviewer)}</option>
                {pool && <option value={POOL}>{tr(M.pool, { agents: poolNames(builder) })}</option>}
                {reviewers(project, builder).map(agentChoice)}
              </select>
              {/* HI-2556: where its cards merge, when the project lists other branches; a running lane keeps its own. */}
              {targets && !running && (
                <>
                  <label htmlFor="lane-start-target">{tr(M.target)}</label>
                  <select id="lane-start-target" className="select" value={target} disabled={waiting} onChange={(e) => setTarget(e.target.value)} data-lane-target>
                    <option value="">{tr(M.targetDefault, { branch: targets.default })}</option>
                    {targets.others.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </>
              )}
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
          <input id="lane-start-name" className="input" value={name} disabled={waiting} maxLength={LANE_NAME_MAX}onChange={(e) => setName(e.target.value)} />
          <label htmlFor="lane-start-note">{tr(M.note)}</label>
          <textarea id="lane-start-note" className={cx('input', 'lane-start-note')} rows={3} value={note} disabled={waiting} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </div>
        {flying && cards[0] !== flying.number && (
          <div className="lane-start-apply-now" data-apply-now={canApplyNow ? 'can' : 'not'}>
            {canApplyNow && (
              <label className="checkbox">
                <input type="checkbox" checked={applyNow} disabled={waiting} onChange={(e) => setApplyNow(e.target.checked)} /> {tr(M.applyNow)}
              </label>
            )}
            <p className="faint">{canApplyNow ? tr(M.applyNowHint, { builder: agentOf(builder)?.name ?? builder, card: keyOf(flying.number) }) : tr(M.applyNowNot, { builder: agentOf(builder)?.name ?? builder, card: keyOf(flying.number), column: flying.column === 'review' ? 'review' : 'passed' })}</p>
          </div>
        )}
        {busyNow.length > 0 && <p className="lane-start-busy">{waiting ? tr(M.waiting, { agents: names }) : tr(M.busy, { agents: names, n: busyNow.length })}</p>}
      </div>
    </Modal>
  )
}
