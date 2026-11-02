// Waiting on agents (#416): what counts as an agent no longer working (shared/agentWatch.ts), its wake and limit lines,
// and agent watches in main/watches.ts: one fires once when a watched agent finishes its turn, waits for the user or
// stops, wakes its watcher only when it is idle and the user isn't typing (else later), and ends on wake or cancel. The
// sessions are stand-ins here (the e2e agentwatch suite runs real ones).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { agentBusy, agentEvent, agentLimitLine, agentPart, agentWakeLine, agentWatchLabel, readSavedAgentCondition, type AgentNow } from '../src/shared/agentWatch'
import { WAKE_MAX_BYTES, cardChange, cardWakeLine, readCondition, userNameOf, wakeAbout, type WatchCondition } from '../src/shared/watch'
import { agentWatchText, taskWaitText } from '../src/shared/toolReplies'
import { LANE_DEFAULT_EVENTS } from '../src/shared/laneWatch'
import { tempDir } from './tempDir'
import { storeDocs } from './storeDocs'
import { follow } from './followDoorbell'

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const nowOf = (over: Partial<AgentNow> = {}): AgentNow => ({ status: 'working', runId: 'r1', prompts: 1, pending: false, ...over })
const b6 = { projectPath: 'C:\\ws\\hive', agentId: 'b6', name: 'B6', project: 'hive' }

describe('what an agent watch counts', () => {
  it('working, starting, a typed prompt not yet taken, and background tasks (unless ignored) are working', () => {
    expect(agentBusy(nowOf(), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'starting' }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'ready', pending: true }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'background' }), false)).toBe(true)
    expect(agentBusy(nowOf({ status: 'background' }), true)).toBe(false)
    for (const status of ['ready', 'finished', 'watching', 'waiting', 'signin', 'stopped', 'error'] as const) expect(agentBusy(nowOf({ status }), false)).toBe(false)
  })

  it('what it did: finished, waits for the user, stopped, in error, or never took the prompt it was typed', () => {
    expect(agentEvent(nowOf(), undefined, false)).toBeNull()
    expect(agentEvent(nowOf({ status: 'finished' }), undefined, false)).toBe('finished')
    expect(agentEvent(nowOf({ status: 'watching' }), undefined, false)).toBe('finished')
    expect(agentEvent(nowOf({ status: 'waiting' }), undefined, false)).toBe('waiting')
    expect(agentEvent(nowOf({ status: 'signin' }), undefined, false)).toBe('waiting')
    expect(agentEvent(nowOf({ status: 'stopped', runId: null }), undefined, false)).toBe('stopped')
    expect(agentEvent(nowOf({ status: 'error' }), undefined, false)).toBe('error')
    const typed = { runId: 'r1', prompts: 1, pending: true, seq: 0 }
    expect(agentEvent(nowOf({ status: 'ready', prompts: 1 }), typed, false)).toBe('untaken')
    expect(agentEvent(nowOf({ status: 'finished', prompts: 2 }), typed, false)).toBe('finished')
  })

  it('the wake line names each agent with the start of its reply, within the size; the limit line says to check on it', () => {
    expect(agentWakeLine([{ agent: b6, event: 'finished', now: nowOf({ status: 'finished', reply: 'The installer for Reinstall 12 is built.\nMore.' }) }])).toBe(
      '[Hive] B6 (hive) finished: "The installer for Reinstall 12 is built. More.". Your agent watch has ended: carry on (hive_agent_activity for more).'
    )
    const two = agentWakeLine([
      { agent: b6, event: 'waiting', now: nowOf({ status: 'waiting', statusMessage: 'Allow Bash: npm run dist?' }) },
      { agent: { ...b6, agentId: 'b7', name: 'B7' }, event: 'stopped', now: nowOf({ status: 'stopped' }) }
    ])
    expect(two).toBe('[Hive] B6 (hive) is waiting for the user: "Allow Bash: npm run dist?"; B7 (hive) stopped. Your agent watch has ended: carry on (hive_agent_activity for more).')
    // Long replies from many agents: cut, never past the line's limit, one line.
    const many = agentWakeLine(Array.from({ length: 20 }, (_, i) => ({ agent: { ...b6, agentId: `a${i}`, name: `Agent ${i}` }, event: 'finished' as const, now: nowOf({ status: 'finished', reply: '評'.repeat(500) }) })))
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(many).not.toMatch(/\n/)
    expect(many).toContain('Agent 19')
    expect(agentPart(b6, 'finished', nowOf({ status: 'watching', watch: 'Waiting for #12 → Review' }))).toBe('B6 (hive) finished (now waiting for #12 → Review)')
    expect(agentPart(b6, 'finished', nowOf({ status: 'ready', backgroundTasks: 2 }), 200, true)).toBe('B6 (hive) is idle (2 background tasks still running)')
    expect(agentPart(b6, 'untaken', nowOf({ status: 'ready' }))).toBe("B6 (hive) is idle: its CLI hasn't taken the prompt it was given")
    expect(agentLimitLine({ agents: [b6], ignoreBackground: false }, 120)).toMatch(/^\[Hive\] B6 is still working after 2 h: your agent watch has ended\. Check on it \(hive_agent_activity\)/)
    expect(agentWatchLabel({ agents: [b6, { ...b6, agentId: 'b7', name: 'B7' }], ignoreBackground: false })).toBe('Waiting for B6, B7 to finish')
  })

  it("the Assistant's card line with replies (#418): one line within the size, the end always there, detail giving way first", () => {
    const long = (s: string) => s.repeat(300)
    const card = (n: number) => ({ number: n, title: 'T', description: '', project: 'alpha', agent: 'a2', agentName: long('建造者'), column: 'review' as const, order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [{ at: '2026-10-08T00:00:00.000Z', by: long('評'), text: long('Ünïcødé ') }], history: [{ at: '2026-10-08T00:00:00.000Z', by: long('🐝'), what: 'Review failed' }], archived: false, createdAt: '2026-10-08T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-08T00:00:00.000Z' })
    const change = (n: number) => ({ ...cardChange(n, card(n), ['verdict', 'column']), about: wakeAbout(card(n), ['verdict', 'column'], 'assistant') })
    const replies = [1, 2, 3].map((i) => ({ agentName: long(`Agent${i}`), cards: Array.from({ length: 20 }, (_, k) => 100 + k), text: long('reply ') }))
    for (const changes of [[], [change(100)], Array.from({ length: 20 }, (_, k) => change(100 + k))]) {
      const { line, repliesTold } = cardWakeLine(changes, replies)
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).not.toMatch(/\n/)
      expect(line).toMatch(/Your card watch has ended/)
      expect(repliesTold).toBe(true)
      for (const c of changes) expect(line).toContain(`#${c.number}`)
    }
    // Short enough, everything in full: the reply's text and each card's state.
    const small = cardWakeLine([{ number: 7, column: 'review', changes: ['column'], by: 'You', comment: null }], [{ agentName: 'B1', cards: [7, 9], text: 'C, the hive cell' }])
    expect(small).toEqual({ line: '[Hive] User replied to B1 on #7, #9: "C, the hive cell"; #7 is in Review. Your card watch has ended: carry on (hive_read_task with latestComment on each card for its comment in full).', repliesTold: true })
  })

  it("names the user in the Assistant's reply lines (#426): Settings → General → Your name, else User", () => {
    const reply = [{ agentName: 'B1', cards: [7], text: 'C, the hive cell' }]
    expect(cardWakeLine([], reply, [], 'Darren').line).toBe('[Hive] Darren replied to B1 on #7: "C, the hive cell". Your card watch has ended: carry on (hive_read_task for the card, hive_agent_activity for the agent).')
    expect(cardWakeLine([], reply).line).toMatch(/^\[Hive\] User replied to B1 on #7/)
    const now = nowOf()
    expect(agentWakeLine([{ agent: { projectPath: 'C:/ws/hive', agentId: 'b1', name: 'B1', project: 'hive' }, event: null, now, reply: 'Ship it' }], 'Darren')).toBe('[Hive] Darren replied to B1 (hive): "Ship it". Your agent watch has ended: carry on (hive_agent_activity for more).')
    expect(agentWakeLine([{ agent: { projectPath: 'C:/ws/hive', agentId: 'b1', name: 'B1', project: 'hive' }, event: null, now, reply: 'Ship it' }])).toMatch(/^\[Hive\] User replied to B1 \(hive\)/)
    // Whatever was typed in the setting: one line, a few words; empty or blank is User.
    expect(userNameOf('  Darren  ')).toBe('Darren')
    expect(userNameOf('Dar\nren\t M')).toBe('Dar ren M')
    expect(userNameOf('')).toBe('User')
    expect(userNameOf('   ')).toBe('User')
    expect(userNameOf(undefined)).toBe('User')
    expect([...userNameOf('🐝'.repeat(60))]).toHaveLength(40)
  })

  it('a long name and many agents: the short forms still say the user replied, by name, within the size (#426)', () => {
    const user = userNameOf('Ünïcødé 🐝 '.repeat(10))
    const agents = Array.from({ length: 20 }, (_, i) => ({ projectPath: 'C:/ws/hive', agentId: `a${i}`, name: `Agent ${i} ${'建造者'.repeat(i % 3 ? 1 : 30)}`, project: 'hive' }))
    const long = 'reply '.repeat(200)
    const fits = (line: string): void => {
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line).not.toMatch(/\n/)
      expect(line).toMatch(/Your agent watch has ended/)
    }
    // Replies only: told as replies, never as agents that changed.
    const replies = agentWakeLine(agents.map((agent) => ({ agent, event: null, now: nowOf(), reply: long })), user)
    fits(replies)
    expect(replies).toContain(`${user} replied to `)
    expect(replies).not.toMatch(/ changed\./)
    // Replies and changes: both, each for what it is.
    const mixed = agentWakeLine(agents.map((agent, i) => ({ agent, event: i % 2 ? ('finished' as const) : null, now: nowOf({ status: 'finished', reply: long }), reply: i % 2 ? undefined : long })), user)
    fits(mixed)
    expect(mixed).toContain(`${user} replied to `)
    expect(mixed).toMatch(/ changed\./)
    // So many that even the names don't fit: counted, the user's replies still theirs.
    const many = Array.from({ length: 200 }, (_, i) => ({ agent: { ...agents[0], agentId: `m${i}`, name: `Agent ${i} ${'建造者'.repeat(30)}` }, event: i % 2 ? ('finished' as const) : null, now: nowOf({ status: 'finished' }), reply: i % 2 ? undefined : 'x' }))
    const counted = agentWakeLine(many, user)
    fits(counted)
    expect(counted).toBe(`[Hive] ${user} replied to 100 watched agents; 100 watched agents changed. Your agent watch has ended: carry on (hive_agent_activity for more).`)
    // The card line's short forms keep the name too.
    const cardReplies = agents.map((a) => ({ agentName: a.name, cards: [7, 8, 9], text: long }))
    const { line, repliesTold } = cardWakeLine([], cardReplies, [], user)
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
    expect(line).toContain(`${user} replied to`)
    expect(repliesTold).toBe(true)
  })

  it('a saved condition is checked in full', () => {
    expect(readSavedAgentCondition({ agents: [b6], ignoreBackground: false })).toEqual({ agents: [b6], ignoreBackground: false })
    expect(readSavedAgentCondition({ agents: [], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [b6, b6], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [{ ...b6, name: '' }], ignoreBackground: false })).toBeNull()
    expect(readSavedAgentCondition({ agents: [b6] })).toBeNull()
  })

  it('the tool reply: a watch begun (and the card watch it replaced), already, cancelled', () => {
    expect(agentWatchText({ watching: 'Waiting for B6 to finish', limitAt: '2026-10-08T14:00:00.000Z' })).toBe(
      'Waiting for B6 to finish. End your turn now: Hive types a line into this session when one finishes, waits for the user or stops, or at 2026-10-08T14:00:00.000Z if none does. Nothing runs meanwhile.'
    )
    expect(agentWatchText({ watching: 'Waiting for B6 to finish', limitAt: 'x', replaced: 'Waiting for #12 → Review' })).toMatch(/It replaces your card watch \(waiting for #12 → Review\)\.$/)
    expect(agentWatchText({ watching: 'Waiting for B6 to finish', limitAt: 'x', dropped: ['R6 (hive)', 'B5 (hive)'] })).toMatch(/It replaces your watch on R6 \(hive\), B5 \(hive\): pass every agent you're following\.$/)
    expect(agentWatchText({ already: ['B6 (hive) is idle: "Done."'] })).toBe('Already: B6 (hive) is idle: "Done.".')
    expect(agentWatchText({ already: ['B6 (hive) is idle: "Done."'], dropped: ['R6 (hive)'] })).toBe(`Already: B6 (hive) is idle: "Done.". Your watch on R6 (hive) has ended: watch again, passing every agent you're following.`)
    expect(agentWatchText({ already: ['B6 (hive) is idle: "Done."'], replaced: 'Waiting for #12 → Review' })).toBe('Already: B6 (hive) is idle: "Done.". Your card watch (waiting for #12 → Review) has ended.')
    expect(agentWatchText({ done: 'Cancelled your agent watch.' })).toBe('Cancelled your agent watch.')
    // HI-1987: replacing a lane watch while its lanes run says what it drops, and the watch that keeps them.
    expect(agentWatchText({ watching: 'Waiting for LB2 to finish', limitAt: 'x', replaced: 'Waiting on all running lanes', lanesLeft: ['LB1', 'LB2'] })).toMatch(/if none does\. Nothing runs meanwhile\. This replaces your lane watch: 2 running lanes \(LB1, LB2\) are no longer followed\. To follow them as well, watch them with this instead: hive_wait_for_tasks with lanes, and agents or cards\.$/)
    expect(agentWatchText({ already: ['LB2 (tools) is idle'], lanesLeft: ['LB1'] })).toBe('Already: LB2 (tools) is idle. This replaces your lane watch: 1 running lane (LB1) is no longer followed. To follow them as well, watch them with this instead: hive_wait_for_tasks with lanes, and agents or cards.')
    expect(taskWaitText({ watching: 'Waiting for #12', limitAt: 'x', lanesLeft: ['LB1'] })).toMatch(/Nothing runs meanwhile\. This replaces your lane watch: 1 running lane \(LB1\)/)
    expect(taskWaitText({ watching: 'Waiting on all running lanes and LB2', limitAt: 'x', events: [...LANE_DEFAULT_EVENTS], agents: { now: ['LB2 (tools)'], already: ['LB3 (tools) is idle'] } })).toBe(
      'Waiting on all running lanes and LB2. End your turn now: Hive types a line into this session on a lane event or LB2 (tools) finishing, waiting for the user or stopping, or at x if none comes. Not followed, not working now: LB3 (tools) is idle.'
    )
  })
})

describe('agent watches (main/watches.ts)', async () => {
  const base = tempDir('hive-agentwatch-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const watches = await import('../src/main/watches')
  watches.testHooks.settleMs = 0
  // A check reads what Hive did after `await watches.settled()`: deliveries run in the background (#570).
  const { sessions } = await import('../src/main/sessions')
  /** The watches a workspace has saved (#1018: rows in its database, what watches.json's `watches` held). */
  // oxlint-disable-next-line typescript/no-explicit-any -- saved entries read as JSON, as the file's were
  const savedOf = (path: string): any[] => storeDocs(path, 'watches')
  let n = 0
  const open = async () => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    const beta = join(path, 'beta')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    mkdirSync(join(beta, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Second' }] }))
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Other' }] }))
    const w = createWorkspaceService()
    await w.open(path)
    return { w, path, alpha, beta }
  }
  /**
   * Stand-in sessions: the watcher a1 (its status, the user typing, what Hive typed and what it read: #650, it follows
   * Hive's doorbell with hive_inbox, as a model does) and the agents it watches.
   */
  const fake = (alpha: string) => {
    const state = { status: 'watching' as string, typing: false, typed: [] as string[], told: [] as string[], agents: new Map<string, AgentNow | null>() }
    const is = (p: string, id: string, want: string) => p.toLowerCase() === alpha.toLowerCase() && id === want
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (is(p, id, 'a1') ? ({ projectPath: alpha, agentId: 'a1', status: state.status, runId: 'run-1' } as never) : null),
      // Each line typed into it is taken (#650: its wake is received, and its watch ends, once it reads it).
      promptsTaken: (p: string, id: string) => (is(p, id, 'a1') ? { runId: 'run-1', count: state.typed.length } : null),
      agentNow: (p: string, id: string) => {
        const a = p.toLowerCase() === alpha.toLowerCase() ? state.agents.get(id) : undefined
        return a ? { statusMessage: null, backgroundTasks: 0, reply: null, ...a } : null
      },
      userMayBeTyping: () => state.typing,
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        state.typed.push(text)
        state.status = 'working'
        state.told.push(await follow(alpha, 'a1', text))
      },
      watchChanged: () => undefined
    })
    return state
  }
  const reviewer = (alpha: string) => ({ projectPath: alpha, agentId: 'a2', name: 'Reviewer', project: 'alpha' })
  const second = (alpha: string) => ({ projectPath: alpha, agentId: 'a3', name: 'Second', project: 'alpha' })
  /** An agent's new state, told to the watches as its status event is in Hive (noteAgentStatus). */
  const move = (st: ReturnType<typeof fake>, alpha: string, id: string, now: AgentNow) => {
    st.agents.set(id, now)
    watches.noteAgentStatus({ projectPath: alpha, agentId: id, status: now.status, runId: now.runId ?? '', statusMessage: now.statusMessage ?? undefined } as never)
  }

  it('an agent that finished and is working again by the time the line is typed is still in it, with the one that finished since', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    move(st, alpha, 'a3', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    // The watcher works (the user gave it something): the line waits.
    st.status = 'working'
    move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'First done.' }))
    await watches.evaluateAgentWatches(w)
    move(st, alpha, 'a2', nowOf({ prompts: 2 }))
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Second done.' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    st.status = 'watching'
    await watches.tick()
    await watches.settled()
    expect(st.told).toEqual(['[Hive] Reviewer (alpha) finished: "First done." (working again now); Second (alpha) finished: "Second done.". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    await disposeWorkspaceService(w)
  })

  // #1346 item 6 (#1530): a second agent watch replaced the first silently, and its agents went unwatched.
  it('a new agent watch says which agents of the one it replaces it no longer follows', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    move(st, alpha, 'a3', nowOf())
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })).not.toHaveProperty('dropped')
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [second(alpha)], ignoreBackground: false })).toMatchObject({ dropped: ['Reviewer (alpha)'] })
    // The same agents again, or more: nothing dropped.
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [second(alpha), reviewer(alpha)], ignoreBackground: false })).not.toHaveProperty('dropped')
    // An answer at once (an agent asked about is idle) makes no watch and ends the earlier one whole: every agent it
    // followed is said, those asked about again included (HR2's #1530 rounds 1 and 2).
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Done.' }))
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [second(alpha)], ignoreBackground: false })
    expect(r).toMatchObject({ already: [expect.stringMatching(/^Second \(alpha\)/)], dropped: ['Second (alpha)', 'Reviewer (alpha)'] })
    expect(savedOf(w.path!)).toEqual([])
    // Mixed: a watch on the busy Reviewer, then one asked for on Reviewer and the idle Second.
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })).toHaveProperty('watching')
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })).toMatchObject({ already: [expect.stringMatching(/^Second \(alpha\)/)], dropped: ['Reviewer (alpha)'] })
    expect(savedOf(w.path!)).toEqual([])
    // The same list again once one of them has finished.
    move(st, alpha, 'a3', nowOf())
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })).toHaveProperty('watching')
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Done again.', prompts: 2 }))
    expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })).toMatchObject({ already: [expect.stringMatching(/^Second \(alpha\)/)], dropped: ['Reviewer (alpha)', 'Second (alpha)'] })
    await disposeWorkspaceService(w)
  })

  it("a project renamed while Hive runs: an agent watch follows both its watcher and the agents it watches (#508)", async () => {
    const { w, path, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    const id = JSON.parse(readFileSync(join(alpha, '.hive', 'project.json'), 'utf8')).id
    expect(savedOf(path)[0].agents.agents[0].projectId).toBe(id)
    const gamma = join(path, 'gamma')
    renameSync(alpha, gamma)
    const st2 = fake(gamma)
    st2.agents.set('a2', nowOf())
    await w.projectIds({ fresh: true })
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st2.typed).toEqual([])
    const saved = savedOf(path)[0]
    expect(saved).toMatchObject({ projectPath: gamma, projectId: id })
    expect(saved.agents.agents[0]).toMatchObject({ projectPath: gamma, project: 'gamma', projectId: id })
    expect(Object.keys(saved.agentMarks)).toEqual([`${gamma.toLowerCase()}#a2`])
    // Its reviewer finishes: the watcher is told, under the project's name now.
    move(st2, gamma, 'a2', nowOf({ status: 'finished', reply: 'Done.' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st2.told).toEqual([expect.stringMatching(/^\[Hive\] Reviewer \(gamma\) finished: "Done\."/)])
    await disposeWorkspaceService(w)
  })

  it('the whole workspace moved while Hive was closed: an agent watch comes with its watcher, its agents and their marks, and is delivered (#508 round 3)', async () => {
    const { w, path, alpha, beta } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    const { checkMoved } = await import('../src/main/workspaceMove')
    await checkMoved(w)
    await w.projectIds({ fresh: true })
    // beta's b1 works too, wherever beta is.
    const busyB1 = () => {
      const agentNow = sessions.agentNow
      Object.assign(sessions, { agentNow: (p: string, id: string) => (id === 'b1' && basename(p) === 'beta' ? { ...nowOf(), statusMessage: null, backgroundTasks: 0, reply: null } : agentNow(p, id)) })
    }
    busyB1()
    expect('watching' in (await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), { projectPath: beta, agentId: 'b1', name: 'Other', project: 'beta' }], ignoreBackground: false }))).toBe(true)
    await disposeWorkspaceService(w)
    const to = `${path}-moved`
    renameSync(path, to)
    const [alpha2, beta2] = [join(to, 'alpha'), join(to, 'beta')]
    const st2 = fake(alpha2)
    busyB1()
    st2.agents.set('a2', nowOf())
    const w2 = createWorkspaceService()
    await w2.open(to)
    await watches.stampWatchProjects(w2)
    const saved = savedOf(to)[0]
    expect(saved.projectPath).toBe(alpha2)
    expect(saved.agents.agents.map((a: { projectPath: string }) => a.projectPath)).toEqual([alpha2, beta2])
    expect(Object.keys(saved.agentMarks).sort()).toEqual([`${alpha2.toLowerCase()}#a2`, `${beta2.toLowerCase()}#b1`].sort())
    move(st2, alpha2, 'a2', nowOf({ status: 'finished', reply: 'Moved, done.' }))
    await watches.evaluateAgentWatches(w2)
    await watches.settled()
    expect(st2.told).toEqual([expect.stringMatching(/^\[Hive\] Reviewer \(alpha\) finished: "Moved, done\."/)])
    await disposeWorkspaceService(w2)
  })

  it("a watched agent whose project is gone while another project has its folder (a copied project.json, the same agent id) is told as stopped, never as that one's (#508 round 3)", async () => {
    const { w, path, alpha, beta } = await open()
    const st = fake(alpha)
    // The new beta's agent b1 is "finished", with a reply: neither is the watched one's.
    const agentNow = sessions.agentNow
    const other = (p: string, id: string) => (p.toLowerCase() === beta.toLowerCase() && id === 'b1' ? { status: 'working', runId: 'r1', prompts: 1, pending: false, statusMessage: null, backgroundTasks: 0, reply: null } : agentNow(p, id))
    Object.assign(sessions, { agentNow: other })
    await w.projectIds({ fresh: true })
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [{ projectPath: beta, agentId: 'b1', name: 'Other', project: 'beta' }], ignoreBackground: false })
    const before = savedOf(path)
    // Replaced: another project at beta's folder, with b1 too.
    writeFileSync(join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, id: 'p-ffffffffffff', agents: [{ id: 'b1', name: 'Other' }] }))
    Object.assign(sessions, { agentNow: (p: string, id: string) => (p.toLowerCase() === beta.toLowerCase() && id === 'b1' ? { status: 'finished', runId: 'r9', prompts: 3, pending: false, statusMessage: null, backgroundTasks: 0, reply: 'NEW PROJECT REPLY' } : agentNow(p, id)) })
    watches.noteAgentStatus({ projectPath: beta, agentId: 'b1', status: 'finished', runId: 'r9' } as never)
    // Read back first (Hive reopened), then checked.
    watches.forgetWatches(w)
    await w.projectIds({ fresh: true })
    await watches.stampWatchProjects(w)
    expect(savedOf(path)[0].agents.agents[0]).toMatchObject({ projectId: before[0].agents.agents[0].projectId, gone: true })
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.told).toEqual([expect.stringMatching(/^\[Hive\] Other \(beta\) stopped\./)])
    expect(st.told[0]).not.toContain('NEW PROJECT REPLY')
    Object.assign(sessions, { agentNow })
    await disposeWorkspaceService(w)
  })

  it('a restarted agent becoming ready is no finished turn: a watch after it is given a task waits for that task (round 2 finding)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    st.agents.set('a2', null)
    watches.noteAgentStatus({ projectPath: alpha, agentId: 'a2', status: 'stopped', runId: '' } as never)
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/^\[Hive\] Reviewer \(alpha\) stopped\. /)
    // Restarted (starting, then ready), then given its next task (typed, not taken yet), then watched again.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'starting', runId: 'r2', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 0, pending: true }))
    expect('watching' in (await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false }))).toBe(true)
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // It takes the task and finishes it: one line, now.
    move(st, alpha, 'a2', nowOf({ runId: 'r2', prompts: 1 }))
    move(st, alpha, 'a2', nowOf({ status: 'finished', runId: 'r2', prompts: 1, reply: 'Task done.' }))
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toBe('[Hive] Reviewer (alpha) finished: "Task done.". Your agent watch has ended: carry on (hive_agent_activity for more).')
    // A card watch it starts while idle (finished, then watching, with no turn) isn't a finished turn either.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ runId: 'r2', prompts: 2 }))
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r2', prompts: 2, pending: true }))
    expect(st.typed).toHaveLength(2)
    await disposeWorkspaceService(w)
  })

  it('a startup question or sign-in before any turn is no finished turn; a turn interrupted while it asks still is (round 3 finding)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const watch = () => watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    // Starting, it asks to trust its folder: the watcher is told that (it waits for the user).
    move(st, alpha, 'a2', nowOf({ status: 'starting', runId: 'r1', prompts: 0 }))
    await watch()
    move(st, alpha, 'a2', nowOf({ status: 'waiting', runId: 'r1', prompts: 0, statusMessage: 'Trust this folder?' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/is waiting for the user: "Trust this folder\?"/)
    // The user answers it (ready, no turn ran), and Hive gives it a task: watched again, nothing is told yet.
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0, pending: true }))
    expect('watching' in (await watch())).toBe(true)
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // A sign-in refused before any turn, then signed in again (ready): still nothing.
    move(st, alpha, 'a2', nowOf({ status: 'signin', runId: 'r1', prompts: 0 }))
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(/waiting for the user to sign in/)
    st.status = 'watching'
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0 }))
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 0, pending: true }))
    await watch()
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    // The task runs while the watcher works; it asks for a permission and is interrupted there (ready): that turn's end
    // is what the line tells once the watcher is idle.
    st.status = 'working'
    move(st, alpha, 'a2', nowOf({ runId: 'r1', prompts: 1 }))
    move(st, alpha, 'a2', nowOf({ status: 'waiting', runId: 'r1', prompts: 1, statusMessage: 'Allow Bash?' }))
    await watches.evaluateAgentWatches(w)
    move(st, alpha, 'a2', nowOf({ status: 'ready', runId: 'r1', prompts: 1, reply: 'Interrupted.' }))
    st.status = 'watching'
    await watches.tick()
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(/^\[Hive\] Reviewer \(alpha\) finished: "Interrupted\."/)
    await disposeWorkspaceService(w)
  })

  it("the user's reply to an agent from its pane wakes the Assistant's card watch on its card, and its agent watch on it, once; never a project agent's; not with the setting off (#418)", async () => {
    const { w, alpha } = await open()
    const { config } = await import('../src/main/config')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    // The Assistant watches here (the stand-in's liveFor answers for it too).
    const assistant = { status: 'watching' as string, typed: [] as string[], told: [] as string[] }
    const liveFor = sessions.liveFor
    const sendPrompt = sessions.sendPrompt
    const promptsTaken = sessions.promptsTaken
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (id === 'assistant' ? ({ projectPath: home, agentId: 'assistant', status: assistant.status, runId: 'run-a' } as never) : liveFor(p, id)),
      promptsTaken: (p: string, id: string) => (id === 'assistant' ? { runId: 'run-a', count: assistant.typed.length } : promptsTaken(p, id)),
      sendPrompt: async (p: string, id: string, text: string, guard?: () => void) => {
        if (id !== 'assistant') return sendPrompt(p, id, text, guard)
        guard?.()
        assistant.typed.push(text)
        assistant.status = 'working'
        assistant.told.push(await follow(home, 'assistant', text))
      }
    })
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Icon', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
    move(st, alpha, 'a2', nowOf())
    // A card watch on #c (the Assistant's) and an agent watch on Reviewer (a project agent's): the reply.
    await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['column'], column: 'review' })
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    watches.noteUserReply(alpha, 'a2', 'Reviewer', 'C, the hive cell\nand more')
    await vi.waitFor(() => expect(assistant.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(assistant.told[0]).toBe(`[Hive] User replied to Reviewer on #${c.number}: "C, the hive cell". Your card watch has ended: carry on (hive_read_task for the card, hive_agent_activity for the agent).`)
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    // Watched again: that reply isn't news; a new one is.
    assistant.status = 'watching'
    await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['column'], column: 'review' })
    await watches.evaluateWatches(w)
    await watches.tick()
    await watches.settled()
    expect(assistant.typed).toHaveLength(1)
    watches.noteUserReply(alpha, 'a2', 'Reviewer', 'Use the second one')
    await vi.waitFor(() => expect(assistant.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(assistant.told[1]).toMatch(/^\[Hive\] User replied to Reviewer on #\d+: "Use the second one"/)
    // The Assistant's agent watch on Reviewer (working) hears it too, naming the user as Settings → General → Your name says.
    assistant.status = 'watching'
    await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
    config.settings.general.userName = 'Darren'
    try {
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'Ship it')
      await vi.waitFor(() => expect(assistant.told).toHaveLength(3), { timeout: HUNG_MS })
    } finally {
      config.settings.general.userName = 'User'
    }
    expect(assistant.told[2]).toBe('[Hive] Darren replied to Reviewer (alpha): "Ship it". Your agent watch has ended: carry on (hive_agent_activity for more).')
    // With the setting off, nothing is kept or told.
    assistant.status = 'watching'
    config.settings.assistant.tellReplies = false
    try {
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'Not told')
      await watches.evaluateAgentWatches(w)
      await watches.tick()
      await watches.settled()
      expect(assistant.typed).toHaveLength(3)
    } finally {
      config.settings.assistant.tellReplies = true
      Object.assign(sessions, { liveFor, sendPrompt, promptsTaken })
    }
    await disposeWorkspaceService(w)
  })

  it("a reply to an agent the Assistant follows reaches it within seconds with no watch of its own to tell it: between two watches, after an agent watch answered at once, with a lane watch; told once; never for an agent it doesn't follow (#1099)", async () => {
    const { w, alpha } = await open()
    const { config } = await import('../src/main/config')
    const lanes = await import('../src/main/lanes')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    try {
      // Reviewer finished: the Assistant's agent watch on it is the answer at once ("already"), and no watch starts.
      move(st, alpha, 'a2', nowOf({ status: 'finished' }))
      a.status = 'finished'
      const at = await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      expect('already' in at).toBe(true)
      // The user answers Reviewer in its pane: the Assistant hears of it at once, a wake of its own.
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'go ahead.\nand push')
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(a.told[0]).toBe('[Hive] User replied to Reviewer (alpha): "go ahead.".')
      // It watches Reviewer again (working on the answer): when Reviewer finishes, that reply isn't told again.
      move(st, alpha, 'a2', nowOf())
      a.status = 'watching'
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'Pushed.' }))
      await watches.evaluateAgentWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(a.told[1]).not.toMatch(/replied/)
      // Between watches (that wake read, no watch since): a reply comes at once too.
      a.status = 'finished'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'approve version bump and commit. Thanks!')
      await vi.waitFor(() => expect(a.told).toHaveLength(3), { timeout: HUNG_MS })
      expect(a.told[2]).toBe('[Hive] User replied to Reviewer (alpha): "approve version bump and commit. Thanks!".')

      // An agent it has never watched: nothing (only what it follows, as #418's watches).
      watches.noteUserReply(alpha, 'a3', 'Second', 'not followed')
      await watches.evaluateAgentWatches(w)
      await watches.settled()
      expect(a.typed).toHaveLength(3)

      // A lane watch (which tells no replies) on a lane Second builds: Second's replies come at once.
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'alpha', agent: 'a3', column: 'doing' }, { kind: 'user' }))
      await lanes.startLane(w, { project: 'alpha', builder: 'a3', reviewer: 'a2', cards: [c.number], by: 'Second (alpha)' })
      a.status = 'watching'
      await watches.registerLaneWatch(w, home, 'assistant', { ids: 'all', events: ['failed', 'blocked'] })
      watches.noteUserReply(alpha, 'a3', 'Second', 'use the blue icon')
      await vi.waitFor(() => expect(a.told).toHaveLength(4), { timeout: HUNG_MS })
      expect(a.told[3]).toBe('[Hive] User replied to Second (alpha): "use the blue icon".')

      // With the setting off, none is told.
      config.settings.assistant.tellReplies = false
      try {
        watches.noteUserReply(alpha, 'a3', 'Second', 'Not told')
        await watches.evaluateAgentWatches(w)
        await watches.settled()
        expect(a.typed).toHaveLength(4)
      } finally {
        config.settings.assistant.tellReplies = true
      }
    } finally {
      restore()
    }
    await disposeWorkspaceService(w)
  })

  it('a reply told on its own is withdrawn when replies stop being told: queued and long out of the kept replies, made while they stop, or made before a restart (#1099 round 1 finding 1)', async () => {
    const { w, alpha } = await open()
    const { config } = await import('../src/main/config')
    const deliveries = await import('../src/main/deliveries')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    const inboxText = async () => JSON.stringify((await deliveries.readInbox(home, 'assistant')).items)
    try {
      // Followed (an agent watch answered at once); the Assistant busy, so the reply waits in its inbox.
      move(st, alpha, 'a2', nowOf({ status: 'finished' }))
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      a.status = 'working'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE queued reply')
      await watches.settled()
      // Many more replies since, to an agent it doesn't follow: the queued one is no longer among those Hive keeps.
      for (let i = 0; i < 201; i++) watches.noteUserReply(alpha, 'a3', 'Second', `unfollowed ${i}`)
      await watches.settled()
      config.settings.assistant.tellReplies = false
      await watches.revokeReplies()
      await watches.settled()
      expect(await inboxText()).not.toContain('PRIVATE queued reply')

      // Turned off while the reply's delivery is being made (and on again before it is read): never handed out.
      config.settings.assistant.tellReplies = true
      deliveries.setBeforeSaveForTests(() => {
        deliveries.setBeforeSaveForTests(null)
        config.settings.assistant.tellReplies = false
        void watches.revokeReplies()
      })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE while revoked')
      await watches.settled()
      config.settings.assistant.tellReplies = true
      expect(await inboxText()).not.toContain('PRIVATE while revoked')

      // One made before a restart (another run of Hive): given while replies are told, not once they are off.
      await deliveries.createDelivery(home, { agentId: 'assistant', kind: 'card-event', from: { kind: 'hive', name: 'Hive' }, body: '[Hive] User replied to Reviewer (alpha): "EARLIER RUN".', source: 'reply', ref: 'reply:1', meta: { generation: 0, run: 'an-earlier-run' } })
      config.settings.assistant.tellReplies = false
      expect(await inboxText()).not.toContain('EARLIER RUN')
    } finally {
      deliveries.setBeforeSaveForTests(null)
      config.settings.assistant.tellReplies = true
      restore()
      await disposeWorkspaceService(w)
    }
  })

  it("a reply whose delivery couldn't be made is left to the Assistant's next watch, told once (#1099 round 1 finding 2)", async () => {
    const { w, alpha } = await open()
    const deliveries = await import('../src/main/deliveries')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    try {
      move(st, alpha, 'a2', nowOf({ status: 'finished' }))
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      a.status = 'finished'
      deliveries.setBeforeSaveForTests(() => {
        throw new Error('a failed save, for this test')
      })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'RECOVER ME')
      await watches.settled()
      deliveries.setBeforeSaveForTests(null)
      expect(a.told).toEqual([])
      // Its next watch on Reviewer tells it, with what Reviewer did.
      move(st, alpha, 'a2', nowOf())
      a.status = 'watching'
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'Done.' }))
      await watches.evaluateAgentWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(a.told[0]).toMatch(/^\[Hive\] User replied to Reviewer \(alpha\): "RECOVER ME"; Reviewer \(alpha\) finished/)
    } finally {
      deliveries.setBeforeSaveForTests(null)
      restore()
      await disposeWorkspaceService(w)
    }
  })

  it('a reply is told once whichever picks it first: a watch that takes it during the direct path\'s lookup, or the direct path before a watch (#1099 round 2 finding)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    let go = (): void => undefined
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      // The Assistant remembers Reviewer's card: a card watch on it woke it.
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Remembered card', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], column: 'review', changes: ['column'] })
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, { kind: 'user' }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      await watches.settled()
      move(st, alpha, 'a2', nowOf())
      a.status = 'watching'
      // Between watches, a reply; the direct path's lookup of that card is held while an agent watch on Reviewer starts,
      // fires and is read, telling the reply. Released, the direct path finds it taken and tells nothing.
      let entered = (): void => undefined
      const inside = new Promise<void>((r) => (entered = r))
      const gate = new Promise<void>((r) => (go = r))
      let hold = true
      const real = tasks.getTask
      spy = vi.spyOn(tasks, 'getTask').mockImplementation(async (...args: Parameters<typeof tasks.getTask>) => {
        if (args[0] === c.number && hold) {
          hold = false
          entered()
          await gate
        }
        return real(...args)
      })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'ONLY ONCE')
      await inside
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      await watches.evaluateAgentWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(2), { timeout: HUNG_MS })
      expect(a.told[1]).toMatch(/User replied to Reviewer \(alpha\): "ONLY ONCE"/)
      a.status = 'finished'
      go()
      await watches.settled()
      expect(a.told.filter((x) => x.includes('ONLY ONCE'))).toHaveLength(1)
      spy.mockRestore()
      spy = undefined

      // The other way: given on its own first (no watch now), a watch on Reviewer started after doesn't tell it again.
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'DIRECT FIRST')
      await vi.waitFor(() => expect(a.told).toHaveLength(3), { timeout: HUNG_MS })
      expect(a.told[2]).toBe('[Hive] User replied to Reviewer (alpha): "DIRECT FIRST".')
      move(st, alpha, 'a2', nowOf())
      a.status = 'watching'
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'Done.' }))
      await watches.evaluateAgentWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(4), { timeout: HUNG_MS })
      expect(a.told[3]).not.toMatch(/DIRECT FIRST/)
    } finally {
      go()
      spy?.mockRestore()
      await watches.settled()
      restore()
      await disposeWorkspaceService(w)
    }
  })

  it("a reply arriving while a watch's line, made without it, is being saved is given to the Assistant on its own, once (#1099 round 3 finding)", async () => {
    const { w, alpha } = await open()
    const deliveries = await import('../src/main/deliveries')
    fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    let go = (): void => undefined
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Watch in flight', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], column: 'review', changes: ['column'] })
      // The card watch's line is made (the card in Review, no reply yet); its delivery's save is held.
      let entered = (): void => undefined
      const inside = new Promise<void>((r) => (entered = r))
      const gate = new Promise<void>((r) => (go = r))
      deliveries.setBeforeSaveForTests(async () => {
        deliveries.setBeforeSaveForTests(null)
        entered()
        await gate
      })
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, { kind: 'user' }))
      const checking = watches.evaluateWatches(w)
      await inside
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'REPLY DURING SAVE')
      go()
      await checking
      await watches.settled()
      // The watch's wake is typed (without it); the reply waits in the Assistant's inbox, busy reading that wake.
      expect(a.told).toHaveLength(1)
      expect(a.told[0]).not.toMatch(/REPLY DURING SAVE/)
      const items = (await deliveries.readInbox(home, 'assistant')).items as unknown as { text: string }[]
      expect(items.map((i) => i.text)).toEqual(['[Hive] User replied to Reviewer (alpha): "REPLY DURING SAVE".'])
    } finally {
      go()
      deliveries.setBeforeSaveForTests(null)
      await watches.settled()
      restore()
      await disposeWorkspaceService(w)
    }
  })

  it('a lane watch follows only the lanes it watches (named, or all), also between two lane watches (#1099 round 1 finding 3)', async () => {
    const { w, alpha } = await open()
    const lanes = await import('../src/main/lanes')
    fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    try {
      const c1 = await inWorkspace(w, () => tasks.createTask({ title: 'Watched lane', project: 'alpha', agent: 'a1', column: 'doing' }, { kind: 'user' }))
      const c2 = await inWorkspace(w, () => tasks.createTask({ title: 'Other lane', project: 'alpha', agent: 'a3', column: 'doing' }, { kind: 'user' }))
      const l1 = (await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'a2', cards: [c1.number], by: 'Builder (alpha)' })).lane
      await lanes.startLane(w, { project: 'alpha', builder: 'a3', cards: [c2.number], by: 'Second (alpha)' })
      a.status = 'watching'
      await watches.registerLaneWatch(w, home, 'assistant', { ids: [l1.id], events: ['failed', 'blocked'] })
      // Its lane's builder: told at once. The other lane's: not (it doesn't watch that lane).
      watches.noteUserReply(alpha, 'a1', 'Builder', 'WATCHED lane reply')
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(a.told[0]).toBe('[Hive] User replied to Builder (alpha): "WATCHED lane reply".')
      watches.noteUserReply(alpha, 'a3', 'Second', 'UNWATCHED lane reply')
      await watches.settled()
      expect(a.told.join('\n')).not.toContain('UNWATCHED')
      // Its lane watch wakes (the card blocked) and ends; between that and its next one, its lane's agents still count.
      a.status = 'watching'
      await inWorkspace(w, () => tasks.updateTask(c1.number, { blocked: 'Which icon?' }, { kind: 'user' }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(2), { timeout: HUNG_MS })
      await watches.settled()
      a.status = 'finished'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'between lane watches')
      await vi.waitFor(() => expect(a.told).toHaveLength(3), { timeout: HUNG_MS })
      expect(a.told[2]).toBe('[Hive] User replied to Reviewer (alpha): "between lane watches".')
      watches.noteUserReply(alpha, 'a3', 'Second', 'UNWATCHED again')
      await watches.settled()
      expect(a.told.join('\n')).not.toContain('UNWATCHED')
    } finally {
      restore()
      await disposeWorkspaceService(w)
    }
  })

  /** The Assistant as a watcher here: its status, what Hive typed into it and what it read (the agents' stand-ins stay as they are). */
  const assistantOf = (home: string) => {
    const a = { status: 'watching' as string, typed: [] as string[], told: [] as string[] }
    const liveFor = sessions.liveFor
    const sendPrompt = sessions.sendPrompt
    const promptsTaken = sessions.promptsTaken
    Object.assign(sessions, {
      liveFor: (p: string, id: string) => (id === 'assistant' ? ({ projectPath: home, agentId: 'assistant', status: a.status, runId: 'run-a' } as never) : liveFor(p, id)),
      promptsTaken: (p: string, id: string) => (id === 'assistant' ? { runId: 'run-a', count: a.typed.length } : promptsTaken(p, id)),
      sendPrompt: async (p: string, id: string, text: string, guard?: () => void) => {
        if (id !== 'assistant') return sendPrompt(p, id, text, guard)
        guard?.()
        a.typed.push(text)
        a.status = 'working'
        a.told.push(await follow(home, 'assistant', text))
      }
    })
    return { a, restore: () => Object.assign(sessions, { liveFor, sendPrompt, promptsTaken }) }
  }

  it('turning Tell the Assistant when I reply off withholds a reply already waiting to be told, for card and agent watches; turning it on again replays none (round 1 finding)', async () => {
    const { w, alpha } = await open()
    const { config } = await import('../src/main/config')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Icon', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
      move(st, alpha, 'a2', nowOf())
      // A card watch: the reply fires it while the Assistant works; the setting goes off before it is idle.
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['column'], column: 'review' })
      a.status = 'working'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE FIRST LINE')
      await watches.evaluateWatches(w)
      config.settings.assistant.tellReplies = false
      a.status = 'watching'
      await watches.tick()
      await watches.settled()
      expect(a.typed).toEqual([])
      expect(watches.watchFor(home, 'assistant')?.cards).toEqual([c.number])
      // The same, with a card change too: the change is told, the reply isn't.
      config.settings.assistant.tellReplies = true
      a.status = 'working'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE AGAIN')
      await inWorkspace(w, () => tasks.updateTask(c.number, { column: 'review' }, { kind: 'user' }))
      await watches.evaluateWatches(w)
      config.settings.assistant.tellReplies = false
      a.status = 'watching'
      await watches.tick()
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(a.told[0]).toMatch(new RegExp(`^\\[Hive\\] #${c.number} \\(Reviewer's card\\) is in Review`))
      expect(a.told[0]).not.toMatch(/PRIVATE/)
      // An agent watch: the same.
      config.settings.assistant.tellReplies = true
      a.status = 'watching'
      await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
      a.status = 'working'
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE THIRD')
      await watches.evaluateAgentWatches(w)
      await watches.revokeReplies()
      config.settings.assistant.tellReplies = false
      a.status = 'watching'
      await watches.tick()
      await watches.settled()
      expect(a.typed).toHaveLength(1)
      expect(watches.watchFor(home, 'assistant')?.agents).toEqual(['Reviewer'])
      // On again: nothing kept comes back.
      config.settings.assistant.tellReplies = true
      await watches.evaluateAgentWatches(w)
      await watches.tick()
      await watches.settled()
      expect(a.typed).toHaveLength(1)
    } finally {
      config.settings.assistant.tellReplies = true
      restore()
    }
    await disposeWorkspaceService(w)
  })

  it("hive_inbox gives out a wake telling the user's reply only while the user lets replies be told: the setting turned off (and nothing else), it isn't handed out, and is cancelled (#649 round 3)", async () => {
    const { config } = await import('../src/main/config')
    const deliveries = await import('../src/main/deliveries')
    const { w, alpha } = await open()
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    // The Assistant gets busy as its wake is about to be typed: the wake waits, queued.
    const typing = sessions.sendPrompt
    let once = true
    sessions.sendPrompt = async (p: string, id: string, text: string, guard?: () => void) => {
      if (id === 'assistant' && once) {
        once = false
        a.status = 'working'
        throw new Error('The Assistant got busy.')
      }
      return typing(p, id, text, guard)
    }
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Icon', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
      move(st, alpha, 'a2', nowOf())
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['comment'] })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE choice')
      await watches.evaluateWatches(w)
      await watches.settled()
      expect(a.typed).toEqual([])
      const waiting = await deliveries.deliveriesOf(home, 'assistant')
      expect(waiting.map((r) => r.state)).toEqual(['queued'])
      expect(waiting[0].body).toMatch(/PRIVATE choice/)
      // The setting alone is turned off (no withdrawal ran): the watch's own check says so, and the inbox listens.
      config.settings.assistant.tellReplies = false
      try {
        expect((await deliveries.readInbox(home, 'assistant')).items).toEqual([])
        expect((await deliveries.deliveriesOf(home, 'assistant')).map((r) => `${r.state}: ${r.detail}`)).toEqual(["cancelled: the user's replies are no longer told"])
      } finally {
        config.settings.assistant.tellReplies = true
      }
    } finally {
      sessions.sendPrompt = typing
      restore()
      await watches.settled()
      await disposeWorkspaceService(w)
    }
  })

  it('turned off (and on again) while a wake telling a reply is being typed, nothing more is typed; what else changed comes again without it (rounds 2 and 3 findings)', async () => {
    const { w, alpha } = await open()
    const { config } = await import('../src/main/config')
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    // The Assistant's terminal as sendPrompt types into it: the guard before each piece and before Enter; `during` runs
    // between two pieces (when the setting is turned off, in one case before the first).
    let during: ((when: 'before' | 'between') => Promise<void>) | null = null
    const typing = sessions.sendPrompt
    sessions.sendPrompt = async (p: string, id: string, text: string, guard?: () => void) => {
      if (id !== 'assistant') return typing(p, id, text, guard)
      await during?.('before')
      guard?.()
      await during?.('between')
      guard?.()
      a.typed.push(text)
      a.status = 'working'
      a.told.push(await follow(home, 'assistant', text))
    }
    const off = async () => {
      config.settings.assistant.tellReplies = false
      await watches.revokeReplies()
    }
    // Off, then on again before the next guard: the reply was revoked all the same.
    const offOn = async () => {
      await off()
      config.settings.assistant.tellReplies = true
    }
    try {
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Icon', project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))
      move(st, alpha, 'a2', nowOf())
      for (const [when, revoke] of [['before', off], ['between', off], ['before', offOn], ['between', offOn]] as const) {
        // A card watch: only the reply.
        config.settings.assistant.tellReplies = true
        a.status = 'watching'
        during = async (now) => (now === when ? revoke() : undefined)
        await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['comment'] })
        watches.noteUserReply(alpha, 'a2', 'Reviewer', `PRIVATE CARD ${when}`)
        await watches.evaluateWatches(w)
        await watches.tick()
        await watches.settled()
        expect(a.typed).toEqual([])
        expect(watches.watchFor(home, 'assistant')?.cards).toEqual([c.number])
        // An agent watch: the same.
        config.settings.assistant.tellReplies = true
        await watches.registerAgentWatch(w, home, 'assistant', { agents: [reviewer(alpha)], ignoreBackground: false })
        watches.noteUserReply(alpha, 'a2', 'Reviewer', `PRIVATE AGENT ${when}`)
        await watches.evaluateAgentWatches(w)
        await watches.tick()
        await watches.settled()
        expect(a.typed).toEqual([])
        expect(watches.watchFor(home, 'assistant')?.agents).toEqual(['Reviewer'])
      }
      // A reply and a comment, the setting turned off between pieces: the comment comes again, without the reply.
      config.settings.assistant.tellReplies = true
      during = async (now) => (now === 'between' && config.settings.assistant.tellReplies ? off() : undefined)
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['comment'] })
      watches.noteUserReply(alpha, 'a2', 'Reviewer', 'PRIVATE MIXED')
      await inWorkspace(w, () => tasks.commentTask(c.number, 'Picked C', { kind: 'user' }))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      expect(a.told[0]).toMatch(new RegExp(`^\\[Hive\\] #${c.number} \\(Reviewer's card\\) is in Doing; latest comment by You: "Picked C"`))
      expect(a.typed.join('\n')).not.toMatch(/PRIVATE/)
      // On again: nothing comes back.
      config.settings.assistant.tellReplies = true
      a.status = 'watching'
      during = null
      await watches.registerWatch(w, home, 'assistant', { cards: [c.number], changes: ['column'], column: 'review' })
      await watches.evaluateWatches(w)
      await watches.tick()
      await watches.settled()
      expect(a.typed).toHaveLength(1)
    } finally {
      config.settings.assistant.tellReplies = true
      sessions.sendPrompt = typing
      restore()
    }
    await disposeWorkspaceService(w)
  })

  it("a reply to the agent of many watched cards is told once with every card's change and the line's end, within the size (round 1 finding)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    const { a, restore } = assistantOf(home)
    try {
      const ns: number[] = []
      for (let i = 0; i < 8; i++) ns.push((await inWorkspace(w, () => tasks.createTask({ title: `Card ${i}`, project: 'alpha', agent: 'a2', column: 'doing' }, { kind: 'user' }))).number)
      move(st, alpha, 'a2', nowOf())
      await watches.registerWatch(w, home, 'assistant', { cards: ns, changes: ['column'], column: 'review' })
      a.status = 'working'
      const long = `${'Use the hive cell, '.repeat(6)}and nothing else`.slice(0, 120)
      watches.noteUserReply(alpha, 'a2', 'Reviewer', long)
      for (const num of ns) await inWorkspace(w, () => tasks.updateTask(num, { column: 'review' }, { kind: 'user' }))
      await watches.evaluateWatches(w)
      a.status = 'watching'
      await watches.tick()
      await vi.waitFor(() => expect(a.told).toHaveLength(1), { timeout: HUNG_MS })
      const line = a.told[0]
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(WAKE_MAX_BYTES)
      expect(line.match(/User replied to Reviewer/g)).toHaveLength(1)
      for (const num of ns) expect(line).toContain(`#${num} (Reviewer's card) is in Review`)
      expect(line).toMatch(/Your card watch has ended: carry on/)
    } finally {
      restore()
    }
    await disposeWorkspaceService(w)
  })

  it("a card reassigned leaves the watch of the agent whose part in it ended: woken once when it was the only card, else told with the next line; a blocked card stays (#481); never the new agent's, never the Assistant's (#420)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const card = async (title: string, agent: string, column: 'doing' | 'review' = 'doing') => (await inWorkspace(w, () => tasks.createTask({ title, project: 'alpha', agent, column }, user))).number
    // Builder (a1) waits, as a reviewer, for Reviewer's (a2) card to arrive in Review; it is given to Second (a3).
    const c1 = await card('One', 'a2')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c1], changes: ['column'], column: 'review' })
    await inWorkspace(w, () => tasks.updateTask(c1, { agent: 'a3' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toBe(`[Hive] #${c1} was reassigned to Second (your watch on it ended). Your card watch has ended: drop it from your list and carry on with your next card.`)
    // Its line taken, the wake is received and the watch ends (#649).
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect((await inWorkspace(w, () => tasks.getTask(c1, w))).history.map((h) => h.what)).toContain('Ended Builder (alpha)\'s watch on it: reassigned to Second'), { timeout: HUNG_MS })
    // Two cards: one blocked stays, paused (#481); the other's arrival is told alone.
    st.status = 'watching'
    const c2 = await card('Two', 'a2')
    const c3 = await card('Three', 'a2')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c2, c3], changes: ['column'], column: 'review' })
    await inWorkspace(w, () => tasks.updateTask(c2, { blocked: 'Waiting for the user to pick an icon' }, user))
    await watches.evaluateWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c2, c3])
    await inWorkspace(w, () => tasks.updateTask(c3, { column: 'review' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(new RegExp(`^\\[Hive\\] #${c3} \\(Reviewer's card\\) is in Review`))
    expect(st.told[1]).not.toMatch(/is blocked|your watch on it ended/)
    // Its own card, blocked by itself (it asked the user): kept too, nothing typed (#481: paused, not gone).
    st.status = 'watching'
    const mine = await card('Mine', 'a1')
    await watches.registerWatch(w, alpha, 'a1', { cards: [mine], changes: ['verdict', 'column'], column: 'passed' })
    await inWorkspace(w, () => tasks.updateTask(mine, { blocked: 'Asked the user' }, { kind: 'agent', name: 'Builder (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' }))
    await watches.evaluateWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([mine])
    // Unblocked, then given to another agent: told.
    await inWorkspace(w, () => tasks.updateTask(mine, { blocked: '' }, user))
    await inWorkspace(w, () => tasks.updateTask(mine, { agent: 'a2' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(new RegExp(`^\\[Hive\\] #${mine} was reassigned to Reviewer`))
    // The new agent's watch on it (Reviewer now has it) and the Assistant's are left alone by a later change of hands.
    const home = w.assistantHome
    mkdirSync(home, { recursive: true })
    await watches.registerWatch(w, home, 'assistant', { cards: [mine], changes: ['column'], column: 'done' })
    await inWorkspace(w, () => tasks.updateTask(mine, { agent: 'a3' }, user))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(watches.watchFor(home, 'assistant')?.cards).toEqual([mine])
    await watches.cancelWatch(w, home, 'assistant')
    await disposeWorkspaceService(w)
  })

  it("a watch that can never fire ends: its card merged (Done), or its lane ended or abandoned; not when it counts the move; Done also ends a dependency's, and with the project's loop wakes off (#1475, HI-2153)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const lanes = await import('../src/main/lanes')
    const card = async (title: string, column: 'todo' | 'doing' = 'doing') => (await inWorkspace(w, () => tasks.createTask({ title, project: 'alpha', agent: 'a2', column }, user))).number
    const history = async (num: number) => (await inWorkspace(w, () => tasks.getTask(num, w))).history.map((h) => h.what)
    const done = 'Your card watch has ended: there is nothing more to wait for on it. Don\'t watch it again; end your turn unless you have other work.'
    // a1 reviews a2's lane and waits for its card in Review; the card is merged without coming back (the user moved it).
    const c1 = await card('Merged')
    const l1 = (await lanes.startLane(w, { project: 'alpha', builder: 'a2', reviewer: 'a1', cards: [c1], by: 'Reviewer (alpha)' })).lane
    await watches.registerWatch(w, alpha, 'a1', { cards: [c1], changes: ['column'], column: 'review' })
    await inWorkspace(w, () => tasks.updateTask(c1, { column: 'done' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toBe(`[Hive] #${c1} is in Done (your watch on it ended). ${done}`)
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect(await history(c1)).toContain("Ended Builder (alpha)'s watch on it: the card is in Done"), { timeout: HUNG_MS })
    await vi.waitFor(async () => expect((await lanes.getLane(w, l1.id)).state).toBe('ended'), { timeout: HUNG_MS })
    // A lane abandoned with its card still in Todo: no card changes, and the watch ends all the same.
    st.status = 'watching'
    const c2 = await card('Abandoned', 'todo')
    const l2 = (await lanes.startLane(w, { project: 'alpha', builder: 'a2', reviewer: 'a1', cards: [c2], by: 'Reviewer (alpha)' })).lane
    await watches.registerWatch(w, alpha, 'a1', { cards: [c2], changes: ['column'], column: 'review' })
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c2])
    await lanes.endLane(w, l2.id, { abandoned: true })
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toBe(`[Hive] #${c2}'s lane was abandoned (your watch on it ended). ${done}`)
    await vi.waitFor(async () => expect(await history(c2)).toContain("Ended Builder (alpha)'s watch on it: its lane was abandoned"), { timeout: HUNG_MS })
    // A watch that counts any column move is told the move to Done as a change, not released.
    st.status = 'watching'
    const c3 = await card('Counted')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c3], changes: ['column'] })
    await inWorkspace(w, () => tasks.updateTask(c3, { column: 'done' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(3), { timeout: HUNG_MS })
    expect(st.told[2]).toMatch(new RegExp(`^\\[Hive\\] #${c3} \\(Reviewer's card\\) is in Done`))
    expect(st.told[2]).not.toContain('your watch on it ended')
    // HI-2153: another agent's card it depends on (no part in it: a watch for Passed) ends in Done too, as does a
    // reviewer's with the project's loop wakes off (both kept before): nothing more comes of a merged card.
    st.status = 'watching'
    const c4 = await card('Dependency')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c4], changes: ['column'], column: 'passed' })
    await inWorkspace(w, () => tasks.updateTask(c4, { column: 'done' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(4), { timeout: HUNG_MS })
    expect(st.told[3]).toBe(`[Hive] #${c4} is in Done (your watch on it ended). ${done}`)
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    st.status = 'watching'
    await w.mutateProjectConfig(alpha, () => ({ loopWakes: false }))
    const c5 = await card('Wakes off')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c5], changes: ['column'], column: 'review' })
    await inWorkspace(w, () => tasks.updateTask(c5, { column: 'done' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(5), { timeout: HUNG_MS })
    expect(st.told[4]).toBe(`[Hive] #${c5} is in Done (your watch on it ended). ${done}`)
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    await disposeWorkspaceService(w)
  })

  it("a lane ended, abandoned or a card merged after the watch fired but before its line is typed is told as that, not as the change; a watch for Done is told the Done, not its lane's end (#1475 round 1 findings)", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const lanes = await import('../src/main/lanes')
    const card = async (title: string, agent = 'a2') => (await inWorkspace(w, () => tasks.createTask({ title, project: 'alpha', agent, column: 'doing' }, user))).number
    const over = (one: boolean) => `Your card watch has ended: there is nothing more to wait for on ${one ? 'it' : 'them'}.`
    for (const how of ['abandoned', 'ended', 'done'] as const) {
      // a1 reviews a2's lane and awaits its card in Review; it works, so the arrival fires the watch but waits to be typed.
      st.status = 'watching'
      const c = await card(`Card ${how}`)
      const lane = (await lanes.startLane(w, { project: 'alpha', builder: 'a2', reviewer: 'a1', cards: [c], by: 'Reviewer (alpha)' })).lane
      await watches.registerWatch(w, alpha, 'a1', { cards: [c], changes: ['column'], column: 'review' })
      st.status = 'working'
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, user))
      await watches.evaluateWatches(w)
      if (how !== 'abandoned') await inWorkspace(w, () => tasks.updateTask(c, { column: 'done' }, user))
      if (how !== 'done') await lanes.endLane(w, lane.id, { abandoned: how === 'abandoned' })
      st.status = 'watching'
      const before = st.told.length
      await watches.tick()
      await vi.waitFor(() => expect(st.told).toHaveLength(before + 1), { timeout: HUNG_MS })
      // A card merged is told as Done, whether or not its lane has ended yet.
      expect(st.told.at(-1)).toBe(`[Hive] #${c}${how === 'abandoned' ? "'s lane was abandoned" : ' is in Done'} (your watch on it ended). ${over(true)} Don't watch it again; end your turn unless you have other work.`)
      await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')).toBeNull(), { timeout: HUNG_MS })
    }
    // Two cards in two lanes: the one that fired is in the lane abandoned before the line is typed; nothing is typed, the
    // other stays watched, and its arrival is told with the release first.
    st.status = 'watching'
    const c1 = await card('One')
    const c2 = await card('Two', 'a3')
    const l1 = (await lanes.startLane(w, { project: 'alpha', builder: 'a2', reviewer: 'a1', cards: [c1], by: 'Reviewer (alpha)' })).lane
    await lanes.startLane(w, { project: 'alpha', builder: 'a3', reviewer: 'a1', cards: [c2], by: 'Second (alpha)' })
    await watches.registerWatch(w, alpha, 'a1', { cards: [c1, c2], changes: ['column'], column: 'review' })
    st.status = 'working'
    await inWorkspace(w, () => tasks.updateTask(c1, { column: 'review' }, user))
    await watches.evaluateWatches(w)
    await lanes.endLane(w, l1.id, { abandoned: true })
    st.status = 'watching'
    const typed = st.typed.length
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(typed)
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c2])
    await inWorkspace(w, () => tasks.updateTask(c2, { column: 'review' }, { kind: 'agent', name: 'Second (alpha)', self: { project: 'alpha', agentId: 'a3' }, scope: 'alpha' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(4), { timeout: HUNG_MS })
    expect(st.told.at(-1)).toMatch(new RegExp(`^\\[Hive\\] #${c1}'s lane was abandoned \\(your watch on it ended\\); #${c2} \\(Second's card\\) is in Review`))
    // A builder waiting for its own card's Done, with a real lane: merged, then the lane ended, it is told the Done.
    st.status = 'watching'
    await watches.cancelWatch(w, alpha, 'a1')
    const mine = await card('Mine', 'a1')
    const l3 = (await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'a2', cards: [mine], by: 'Builder (alpha)' })).lane
    await watches.registerWatch(w, alpha, 'a1', { cards: [mine], changes: ['column'], column: 'done' })
    await inWorkspace(w, () => tasks.updateTask(mine, { column: 'done' }, user))
    await lanes.endLane(w, l3.id, {})
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(5), { timeout: HUNG_MS })
    expect(st.told.at(-1)).toMatch(new RegExp(`^\\[Hive\\] #${mine} is in Done`))
    expect(st.told.at(-1)).not.toMatch(/your watch on it ended|lane ended|nothing more to wait for/)
    await disposeWorkspaceService(w)
  })

  it('a card released after its watch fired but before the line is typed is told as released; released cards are told with the limit too (#420 round 1 findings)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const card = async (title: string) => (await inWorkspace(w, () => tasks.createTask({ title, project: 'alpha', agent: 'a2', column: 'doing' }, user))).number
    // Waiting gives up after 10 s, not vi.waitFor's 1 s: four unit suites at once outran that writing the card's history
    // (#560). The bound only says when one has hung.
    const HANG = { timeout: 10_000 }
    for (const [i, change] of [['reassigned', { agent: 'a3' }], ['blocked', { blocked: 'Waiting for a decision' }]] as const) {
      // Builder (a1) awaits Reviewer's card in Review; it works, so the arrival waits to be typed; then the card changes.
      st.status = 'watching'
      const c = await card(`Card ${i}`)
      await watches.registerWatch(w, alpha, 'a1', { cards: [c], changes: ['column'], column: 'review' })
      st.status = 'working'
      await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, user))
      await watches.evaluateWatches(w)
      await inWorkspace(w, () => tasks.updateTask(c, change, user))
      st.status = 'watching'
      const before = st.typed.length
      await watches.tick()
      await vi.waitFor(() => expect(st.told).toHaveLength(before + 1), HANG)
      const line = st.told.at(-1)!
      if (i === 'blocked') {
        // Blocked meanwhile: it stays (#481), so its arrival is told as it was.
        expect(line).toMatch(new RegExp(`^\\[Hive\\] #${c} \\(Reviewer's card\\) is in Review`))
        continue
      }
      expect(line).toMatch(new RegExp(`^\\[Hive\\] #${c} was reassigned to Second \\(your watch on it ended\\)\\. Your card watch has ended: drop it`))
      expect(line).not.toMatch(/is in Review/)
      await vi.waitFor(async () => expect((await inWorkspace(w, () => tasks.getTask(c, w))).history.some((h) => h.by === 'Hive' && h.what.startsWith("Ended Builder (alpha)'s watch on it"))).toBe(true), HANG)
    }
    // Two cards: one reassigned leaves quietly; the other never changes; the limit tells both. The other is Reviewer's card
    // in Doing, which the watcher doesn't review: another agent's work going on, so it is watched again, not taken to the
    // user (HI-2381 round 3).
    st.status = 'watching'
    const c1 = await card('One')
    const c2 = await card('Two')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c1, c2], changes: ['column'], column: 'review' }, 30)
    await inWorkspace(w, () => tasks.updateTask(c1, { agent: 'a3' }, user))
    await watches.evaluateWatches(w)
    const before = st.typed.length
    await watches.tick(Date.now() + 31 * 60_000)
    await vi.waitFor(() => expect(st.told).toHaveLength(before + 1), HANG)
    expect(st.told.at(-1)).toBe(`[Hive] #${c1} was reassigned to Second (your watch on it ended). No change on #${c2} in 30 min: your card watch has ended. #${c2} is in Doing with Reviewer. Drop the first from your list; watch #${c2} again: another agent's work is going on; don't tell the user about it.`)
    await disposeWorkspaceService(w)
  })

  it('a card released after a two-card watch fired keeps the other card watched, told once with its arrival; clearing the awaited builder or the watcher\'s review releases it (#420 round 2 findings)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const card = async (title: string) => (await inWorkspace(w, () => tasks.createTask({ title, project: 'alpha', agent: 'a2', column: 'doing' }, user))).number
    for (const [i, change] of [['reassigned', { agent: 'a3' }]] as const) {
      st.status = 'watching'
      const c1 = await card(`One ${i}`)
      const c2 = await card(`Two ${i}`)
      await watches.registerWatch(w, alpha, 'a1', { cards: [c1, c2], changes: ['column'], column: 'review' })
      // #1 arrives while the watcher works (fired, not typed), then is released; #2 hasn't changed.
      st.status = 'working'
      await inWorkspace(w, () => tasks.updateTask(c1, { column: 'review' }, user))
      await watches.evaluateWatches(w)
      await inWorkspace(w, () => tasks.updateTask(c1, change, user))
      st.status = 'watching'
      const before = st.typed.length
      await watches.tick()
      await watches.settled()
      expect(st.typed).toHaveLength(before)
      expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c2])
      // #2 arrives: one line, the release first.
      await inWorkspace(w, () => tasks.updateTask(c2, { column: 'review' }, user))
      await watches.evaluateWatches(w)
      await vi.waitFor(() => expect(st.told).toHaveLength(before + 1), { timeout: HUNG_MS })
      expect(st.told.at(-1)).toMatch(new RegExp(`^\\[Hive\\] #${c1} was reassigned to Second \\(your watch on it ended\\); #${c2} \\(Reviewer's card\\) is in Review`))
      await watches.tick()
      await watches.settled()
      expect(st.typed).toHaveLength(before + 1)
    }
    // The awaited builder taken off the card (no agent now): the waiting reviewer is released.
    st.status = 'watching'
    const c3 = await card('Three')
    await watches.registerWatch(w, alpha, 'a1', { cards: [c3], changes: ['column'], column: 'review' })
    await inWorkspace(w, () => tasks.updateTask(c3, { agent: '' }, user))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told.at(-1)).toBe(`[Hive] #${c3} was reassigned (it has no agent now) (your watch on it ended). Your card watch has ended: drop it from your list and carry on with your next card.`), { timeout: HUNG_MS })
    // Watching while it reviews: its review stopped by someone else releases it; its own verdict doesn't.
    st.status = 'watching'
    const me = { kind: 'agent', name: 'Builder (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    const c4 = (await inWorkspace(w, () => tasks.createTask({ title: 'Four', project: 'alpha', agent: 'a2', column: 'review' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(c4, { review: 'start' }, me))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c4], changes: ['comment'] })
    await inWorkspace(w, () => tasks.updateTask(c4, { review: 'failed' }, me, { comment: 'Round 1: FAILED' }))
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.told.at(-1)).not.toMatch(/review was taken from you/)
    st.status = 'watching'
    // Failed, it went back to Doing (HI-1946): its builder submits it again before it is reviewed again.
    await inWorkspace(w, () => tasks.updateTask(c4, { column: 'review' }, { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' }))
    await inWorkspace(w, () => tasks.updateTask(c4, { review: 'start' }, me))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c4], changes: ['verdict'] })
    await inWorkspace(w, () => tasks.endReviews('alpha', 'a1', 'its session ended', w))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told.at(-1)).toMatch(new RegExp(`^\\[Hive\\] #${c4}'s review was taken from you \\(your watch on it ended\\)`)), { timeout: HUNG_MS })
    await disposeWorkspaceService(w)
  })

  it('a reviewer waiting for a failed card it keeps across a block: blocked, unblocked and back in Review, it is woken to review it (#481)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    // a1 reviews a2's card: fails round 1, then waits for its next round.
    const rev = { kind: 'agent', name: 'Builder (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
    const builder = { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' } as const
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Asks a question', project: 'alpha', agent: 'a2', column: 'review' }, { kind: 'user' }))).number
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'start' }, rev))
    await watches.registerWatch(w, alpha, 'a1', readCondition({ cards: [c], column: 'review', fresh: true }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { review: 'failed' }, rev, { comment: 'Round 1: FAILED' }))
    // The builder takes it back, blocks it to ask the user, then (answered) unblocks it and returns it to Review.
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'doing' }, builder))
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: 'Which icon?' }, builder))
    await watches.evaluateWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(0)
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c])
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: '' }, builder))
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, builder))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    expect(st.told[0]).toMatch(new RegExp(`^\\[Hive\\] #${c} \\(Reviewer's card\\) is in Review`))
    await disposeWorkspaceService(w)
  })

  it('a watch for a card to be in Review, started after a wake that told it there, fires when it leaves and comes back (#521)', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const user = { kind: 'user' } as const
    const builder = { kind: 'agent', name: 'Reviewer (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' } as const
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Asks a question', project: 'alpha', agent: 'a2', column: 'doing' }, user))).number
    const d = (await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'alpha', agent: 'a2', column: 'todo' }, user))).number
    // a1 reviews a2's cards: woken when c arrives in Review (the wake tells it there).
    await watches.registerWatch(w, alpha, 'a1', readCondition({ cards: [c], column: 'review' }) as WatchCondition)
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, builder))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(1), { timeout: HUNG_MS })
    // Before it is reviewed its builder takes it back and blocks it to ask the user; answered, it is unblocked. The
    // reviewer (told by the user) waits for it to be in Review, as on 10 Oct: column alone, no fresh.
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'doing', blocked: 'Which icon?' }, builder))
    await inWorkspace(w, () => tasks.updateTask(c, { blocked: '' }, user))
    st.status = 'watching'
    expect('watching' in (await watches.registerWatch(w, alpha, 'a1', readCondition({ cards: [c, d], column: 'review' }) as WatchCondition))).toBe(true)
    await watches.evaluateWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    await inWorkspace(w, () => tasks.updateTask(c, { column: 'review' }, builder, { comment: 'Round 2 ready' }))
    await watches.evaluateWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toMatch(new RegExp(`^\\[Hive\\] #${c} \\(Reviewer's card\\) is in Review; latest comment by Reviewer \\(alpha\\): "Round 2 ready"`))
    await disposeWorkspaceService(w)
  })

  it("a wake's next watch counts what happened in between: an agent that finished and took new work meanwhile fires it at once", async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    move(st, alpha, 'a2', nowOf())
    move(st, alpha, 'a3', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    move(st, alpha, 'a2', nowOf({ status: 'finished', reply: 'First done.' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    expect(st.told[0]).toMatch(/^\[Hive\] Reviewer \(alpha\) finished: "First done."\. /)
    // While the watcher reads that wake (working), Second finishes and is given new work; Reviewer too.
    move(st, alpha, 'a3', nowOf({ status: 'finished', reply: 'Second done.' }))
    move(st, alpha, 'a3', nowOf({ prompts: 2 }))
    move(st, alpha, 'a2', nowOf({ prompts: 2 }))
    st.status = 'watching'
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    expect('watching' in r).toBe(true)
    // Second's finish is told (the watch's own check, as it starts, may be typing it); Reviewer's, already told, isn't.
    await watches.evaluateAgentWatches(w)
    await vi.waitFor(() => expect(st.told).toHaveLength(2), { timeout: HUNG_MS })
    expect(st.told[1]).toBe('[Hive] Second (alpha) finished: "Second done." (working again now). Your agent watch has ended: carry on (hive_agent_activity for more).')
    // Nothing new since that wake: the next watch waits.
    st.status = 'watching'
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha), second(alpha)], ignoreBackground: false })
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(2)
    expect(watches.watchFor(alpha, 'a1')?.label).toBe('Waiting for Reviewer, Second to finish')
    await disposeWorkspaceService(w)
  })

  it('fires once when the agent finishes, with its reply; the watch ends; agents not working are the answer at once', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(r).toMatchObject({ watching: { label: 'Waiting for Reviewer to finish', agents: ['Reviewer'], cards: [] } })
    expect(watches.watchFor(alpha, 'a1')?.agents).toEqual(['Reviewer'])
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    st.agents.set('a2', nowOf({ status: 'finished', reply: 'All checks pass.' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.told).toEqual(['[Hive] Reviewer (alpha) finished: "All checks pass.". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    st.status = 'watching'
    await watches.evaluateAgentWatches(w)
    await watches.tick()
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // Idle now: the answer at once, and no watch.
    const again = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(again).toEqual({ already: ['Reviewer (alpha) is idle: "All checks pass."'] })
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    await disposeWorkspaceService(w)
  })

  it('nothing is typed while the watcher works or the user types there; it is typed once both are done', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    st.status = 'working'
    st.agents.set('a2', nowOf({ status: 'waiting', statusMessage: 'Allow Bash?' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    st.status = 'watching'
    st.typing = true
    await watches.tick()
    await watches.settled()
    expect(st.typed).toEqual([])
    st.typing = false
    await watches.tick()
    await watches.settled()
    expect(st.told).toEqual(['[Hive] Reviewer (alpha) is waiting for the user: "Allow Bash?". Your agent watch has ended: carry on (hive_agent_activity for more).'])
    await disposeWorkspaceService(w)
  })

  it('a stop, a prompt typed but not taken, background tasks, the limit and cancel', async () => {
    const { w, alpha } = await open()
    const st = fake(alpha)
    const watch = (ignoreBackground = false, limit?: number) => watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground }, limit)
    // Stopped.
    st.agents.set('a2', nowOf())
    await watch()
    st.agents.set('a2', null)
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    st.typed.pop()
    expect(st.told.pop()).toMatch(/^\[Hive\] Reviewer \(alpha\) stopped\. /)
    // Just given a task, its CLI hasn't taken it yet: working, not already idle; never taken, told so.
    st.status = 'watching'
    st.agents.set('a2', nowOf({ status: 'ready', pending: true }))
    expect('watching' in (await watch())).toBe(true)
    st.agents.set('a2', nowOf({ status: 'ready', pending: false }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    st.typed.pop()
    expect(st.told.pop()).toMatch(/Reviewer \(alpha\) is idle: its CLI hasn't taken the prompt it was given/)
    // Background tasks count as working, unless ignored.
    st.status = 'watching'
    st.agents.set('a2', nowOf())
    await watch()
    st.agents.set('a2', nowOf({ status: 'background', backgroundTasks: 1 }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    await watch(true)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // The limit, with nothing done.
    st.agents.set('a2', nowOf())
    await watch(false, 30)
    await watches.tick(Date.now() + 29 * 60_000)
    await watches.settled()
    expect(st.typed).toEqual([])
    await watches.tick(Date.now() + 31 * 60_000)
    await watches.settled()
    st.typed.pop()
    expect(st.told.pop()).toMatch(/^\[Hive\] Reviewer is still working after 30 min: your agent watch has ended/)
    // Cancel.
    st.status = 'watching'
    await watch()
    expect(await watches.cancelWatch(w, alpha, 'a1')).toBe(true)
    st.agents.set('a2', nowOf({ status: 'finished' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toEqual([])
    await disposeWorkspaceService(w)
  })

  it('kept in the workspace across a reload; replaces a card watch and is replaced by one; only its own project, never itself', async () => {
    const { w, alpha, beta } = await open()
    const st = fake(alpha)
    st.agents.set('a2', nowOf())
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'alpha' }, { kind: 'user' }))
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    const r = await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    expect(r).toMatchObject({ replaced: `Waiting for #${c.number}` })
    // Read back from the file.
    watches.forgetWatches(w)
    expect(watches.watchFor(alpha, 'a1')).toBeNull()
    // It loads in the background: wait for it, not for a fixed time (a loaded machine takes longer).
    await vi.waitFor(() => expect(watches.watchFor(alpha, 'a1')?.label).toBe('Waiting for Reviewer to finish'), { timeout: HUNG_MS })
    st.agents.set('a2', nowOf({ status: 'finished' }))
    await watches.evaluateAgentWatches(w)
    await watches.settled()
    expect(st.typed).toHaveLength(1)
    // A card watch replaces it.
    st.status = 'watching'
    st.agents.set('a2', nowOf())
    await watches.registerAgentWatch(w, alpha, 'a1', { agents: [reviewer(alpha)], ignoreBackground: false })
    await watches.registerWatch(w, alpha, 'a1', { cards: [c.number], changes: ['comment'] })
    expect(watches.watchFor(alpha, 'a1')?.cards).toEqual([c.number])
    // Itself: refused. Another project's agent: watched (its status is open), but what it said isn't told to a
    // project agent (its conversation holds that project's cards).
    await expect(watches.registerAgentWatch(w, alpha, 'a1', { agents: [{ projectPath: alpha, agentId: 'a1', name: 'Builder', project: 'alpha' }], ignoreBackground: false })).rejects.toThrow(/yourself/)
    const other = { projectPath: beta, agentId: 'b1', name: 'Other', project: 'beta' }
    const agentNow = sessions.agentNow
    sessions.agentNow = (p: string, id: string) => (id === 'b1' ? { status: 'finished', runId: 'r2', prompts: 1, pending: false, statusMessage: null, backgroundTasks: 0, reply: 'Card #9 is done.' } : agentNow(p, id))
    try {
      // The card watch it had ends with the answer: said (HR2's #1530 round 1).
      expect(await watches.registerAgentWatch(w, alpha, 'a1', { agents: [other], ignoreBackground: false })).toEqual({ already: ['Other (beta) is idle'], replaced: `Waiting for #${c.number}` })
    } finally {
      sessions.agentNow = agentNow
    }
    await disposeWorkspaceService(w)
  })

  // HI-2195: a usage watch, its whole life: started (saved), answered at once when already there, fired by a usage
  // report and typed, and (HR1's round 1) one read back as its workspace reopens checked at once against the usage kept
  // now, with no new report.
  describe('usage watches (HI-2195)', async () => {
    const { config } = await import('../src/main/config')
    const { emit } = await import('../src/main/events')
    // Hive's own wiring of the watches to its events (a usage report among them), as it starts.
    watches.initWatches()
    const watch = [{ account: 'a-acct1', name: 'Max 1', percent: 98, limit: 'weekly' as const }]
    const weekly = (used: number) => ({ provider: 'claude-code' as const, plan: null, limits: [{ id: 'seven_day', label: 'weekly', windowMinutes: 10080, usedPercent: used, resetsAt: new Date(Date.now() + 48 * 3600e3).toISOString() }], updatedAt: new Date().toISOString() })
    const setUsage = (used: number) => config.update((c) => (c.connectionPlanUsage = { ...c.connectionPlanUsage, 'a-acct1': weekly(used) }))

    it('starts and is saved below the share, answers at once above it, and fires on a report', async () => {
      const { w, path, alpha } = await open()
      const st = fake(alpha)
      setUsage(50)
      const r = await watches.registerUsageWatch(w, alpha, 'a1', watch)
      expect(r).toMatchObject({ watching: { label: 'Waiting for usage: Max 1 at 98% of its weekly limit' } })
      expect(savedOf(path)[0].usage).toEqual(watch)
      // A report under the share: nothing; one at it: the line, typed once the watcher is idle.
      setUsage(97)
      emit({ type: 'plan-usage', provider: 'claude-code', usage: weekly(97), connection: 'a-acct1' })
      await watches.settled()
      expect(st.told).toEqual([])
      setUsage(98.5)
      emit({ type: 'plan-usage', provider: 'claude-code', usage: weekly(98.5), connection: 'a-acct1' })
      await vi.waitFor(() => expect(st.told).toEqual([expect.stringMatching(/^\[Hive\] Usage reached: Max 1: weekly 98\.5% \(resets /)]), { timeout: HUNG_MS })
      // Already there: answered at once, no watch kept.
      expect(await watches.registerUsageWatch(w, alpha, 'a1', watch)).toMatchObject({ already: [expect.stringMatching(/^Max 1: weekly 98\.5%/)] })
      expect(savedOf(path)).toEqual([])
      await disposeWorkspaceService(w)
    })

    it('one read back as its workspace reopens is checked against the usage kept now, with no new report', async () => {
      const { w, path, alpha } = await open()
      const st = fake(alpha)
      setUsage(50)
      expect(await watches.registerUsageWatch(w, alpha, 'a1', watch)).toHaveProperty('watching')
      // Closed; meanwhile another workspace's session reported Max 1 over the share (no event reaches this one).
      watches.forgetWatches(w)
      setUsage(99)
      await watches.stampWatchProjects(w)
      await vi.waitFor(() => expect(st.told).toEqual([expect.stringMatching(/^\[Hive\] Usage reached: Max 1: weekly 99%/)]), { timeout: HUNG_MS })
      expect(savedOf(path)).toEqual([])
      await disposeWorkspaceService(w)
    })
  })
})
