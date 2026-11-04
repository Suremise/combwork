// Deliveries (#647, shared/deliveries.ts and main/deliveries.ts): the states and their moves, coalescing, the doorbell
// and the inbox's reply; saved records restored after a restart (offered → uncertain, the Assistant's from a launch that
// has ended refused, and shown), permission worked out again at every step, cw_inbox (received) and ack (acked), cancel,
// expiry and overdue. The sessions are stand-ins here (the e2e deliveries suite runs fake Claude Code agents).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { DELIVERY_BODY_MAX_CHARS, DELIVERY_STATES, ackText, canMove, inboxItems, inboxSummary, inboxText, isOverdue, moved, offerLine, readDelivery, type DeliveryRecord, type DeliverySender } from '../src/shared/deliveries'
import { taskPrompt } from '../src/shared/tasks'
import type { TaskCard } from '../src/shared/types'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { putStoreDocs } from './storeDocs'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const at = '2026-10-12T03:00:00.000Z'
const rec = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({ id: 'm1', seq: 1, agentId: 'b1', conversation: null, kind: 'rebrief', from: { kind: 'assistant', name: 'the Assistant', workspace: 'C:/ws', launch: 'a1' }, body: 'Rebase first.', state: 'queued', created: at, expires: '2026-10-13T03:00:00.000Z', ...over })

describe('delivery records (#647)', () => {
  it('moves only as the states allow, filling in their times', () => {
    const offered = moved(rec(), 'offered', '2026-10-12T03:01:00.000Z')!
    expect(offered).toMatchObject({ state: 'offered', offered: '2026-10-12T03:01:00.000Z', offers: 1 })
    const received = moved(offered, 'received', '2026-10-12T03:02:00.000Z')!
    expect(moved(received, 'acked', '2026-10-12T03:03:00.000Z')).toMatchObject({ state: 'acked', received: '2026-10-12T03:02:00.000Z', acked: '2026-10-12T03:03:00.000Z' })
    // Acked straight from queued (it was read in a line Hive didn't see taken): received then too.
    expect(moved(rec(), 'acked', '2026-10-12T03:04:00.000Z')).toMatchObject({ received: '2026-10-12T03:04:00.000Z', acked: '2026-10-12T03:04:00.000Z' })
    // Not offered after all: as it was.
    expect(moved(offered, 'queued', at)).toEqual(rec())
    expect(moved(rec(), 'cancelled', at, 'cancelled by the user')).toMatchObject({ state: 'cancelled', ended: at, detail: 'cancelled by the user' })
    // Ended stays ended; received can't be refused or cancelled (the agent has it).
    for (const end of ['acked', 'cancelled', 'refused', 'expired', 'stale'] as const) for (const to of DELIVERY_STATES) expect(canMove(end, to)).toBe(false)
    // Stale (#652): from anything not read yet, never once received.
    for (const from of ['queued', 'offered', 'uncertain'] as const) expect(canMove(from, 'stale')).toBe(true)
    expect(canMove('received', 'stale')).toBe(false)
    expect(moved(rec(), 'stale', at, '#7 passed review')).toMatchObject({ state: 'stale', ended: at, detail: '#7 passed review' })
    expect(isOverdue(rec({ state: 'stale' }), Date.parse(at) + 31 * 60_000)).toBe(false)
    expect(canMove('received', 'refused')).toBe(false)
    expect(canMove('received', 'cancelled')).toBe(false)
    expect(canMove('queued', 'uncertain')).toBe(false)
    expect(canMove('offered', 'uncertain')).toBe(true)
    expect(canMove('uncertain', 'offered')).toBe(true)
    expect(moved(rec({ state: 'acked' }), 'queued', at)).toBeNull()
  })

  it('overdue: live and not acked OVERDUE_MINUTES after it was made', () => {
    const t = Date.parse(at)
    expect(isOverdue(rec(), t + 29 * 60_000)).toBe(false)
    expect(isOverdue(rec(), t + 30 * 60_000)).toBe(true)
    expect(isOverdue(rec({ state: 'received' }), t + 31 * 60_000)).toBe(true)
    expect(isOverdue(rec({ state: 'acked' }), t + 31 * 60_000)).toBe(false)
    expect(isOverdue(rec({ state: 'refused' }), t + 31 * 60_000)).toBe(false)
    expect(inboxSummary([rec({ state: 'received' })], t + 31 * 60_000)).toEqual({ unread: [], overdue: 1 })
    expect(inboxSummary([rec({ state: 'acked' })], t)).toBeUndefined()
  })

  it("HI-2087: a card's events with the merge queue's return among them lead with the return and its reason", () => {
    const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
    const back = '[CW] HI-46 came back from the merge queue: a conflict with main in src/main/bundledHistory.json. Merge main into your worktree, resolve the conflict, commit and submit again (cw_submit).'
    // Its lines as their makers mark them: the queue's return (a loop wake's note, or a watch's line leading with it),
    // a watch's line telling only a comment, and anything else unmarked.
    const ev = (seq: number, body: string, meta?: Record<string, boolean>) => rec({ id: `m${seq}`, seq, kind: 'card-event', from: hive, card: 46, body, ...(meta ? { meta } : {}) })
    const returned = (seq: number) => ev(seq, back, { queueReturn: true })
    const commented = (seq: number) => ev(seq, '[CW] HI-46 is in Doing; latest comment by Hive: "HI-46 came back from the merge queue: …"', { commentOnly: true })
    const text = (...events: DeliveryRecord[]) => inboxItems(events).map((i) => i.text)
    // Before it, a pass; after it, only its own comment: the return leads.
    expect(text(ev(1, '[CW] HI-46 is in Passed: HR1 passed it'), returned(2), commented(3))).toEqual([`${back} (with 2 more changes: read the card)`])
    // Newer than the return: submitted again (Review), merged (Done), gone. The count, never the old instruction.
    expect(text(returned(1), ev(2, '[CW] HI-46 is in Review'))).toEqual(['2 changes, read the card'])
    expect(text(returned(1), commented(2), ev(3, '[CW] HI-46 is in Done: its work merged'))).toEqual(['3 changes, read the card'])
    expect(text(returned(1), ev(2, '[CW] HI-46 is gone from your board'))).toEqual(['2 changes, read the card'])
    // Two cycles: back, resubmitted, back again: the latest return leads.
    expect(text(returned(1), ev(2, '[CW] HI-46 is in Review'), { ...returned(3), body: `${back} (2)` })).toEqual([`${back} (2) (with 2 more changes: read the card)`])
    // A line that only quotes the words (an agent's comment, unmarked) is no return.
    expect(text(ev(1, '[CW] HI-46 is in Doing'), ev(2, `[CW] HI-46 is in Doing; latest comment by B1: "${back}"`))).toEqual(['2 changes, read the card'])
  })

  it("coalesces a card's events into one item, where its first one was; a message stays its own", () => {
    const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
    const items = inboxItems([
      rec({ id: 'm1', seq: 1, kind: 'card-event', from: hive, card: 607, body: 'is in Review' }),
      rec({ id: 'm2', seq: 2 }),
      rec({ id: 'm3', seq: 3, kind: 'card-event', from: hive, card: 607, body: 'has a new comment' }),
      rec({ id: 'm4', seq: 4, kind: 'card-event', from: hive, card: 608, body: 'is in Passed' }),
      rec({ id: 'm5', seq: 5, kind: 'card-event', from: hive, card: 607, body: 'is in Doing', state: 'received' }),
      rec({ id: 'm6', seq: 6, kind: 'card-event', from: hive, card: 607, body: 'is in Done' })
    ])
    expect(items.map((i) => [i.ids.join(','), i.card ?? null, i.text])).toEqual([
      ['m1,m3,m6', 607, '3 changes, read the card'],
      ['m2', null, 'Rebase first.'],
      ['m4', 608, 'is in Passed']
    ])
    expect(inboxText(items, ['m5'])).toBe(
      ['3 new:', 'm1,m3,m6 · Hive · #607: 3 changes, read the card', 'm2 · the Assistant: Rebase first.', 'm4 · Hive · #608: is in Passed', 'Received before, not acked yet: m5.', 'Ack each with cw_inbox (ack: its ids) once you have acted on it.'].join('\n')
    )
    expect(inboxText([], [])).toBe('Nothing new.')
    expect(inboxText([], ['m5'])).toBe('Nothing new. Received before, not acked yet: m5.')
    expect(ackText(['m1', 'm3'], ['m9'])).toBe('Acked m1, m3. Not in your inbox: m9.')
    // Typed, the doorbell (#650): Hive's fixed words with counts by kind, cards and ids, never what they say or who sent
    // them; one that may repeat says so; a watching agent is told its watch carries on.
    const wake = (id: string, seq: number, body: string, o: Partial<DeliveryRecord> = {}) => rec({ id, seq, kind: 'card-event', from: hive, card: 607, body, ...o })
    expect(offerLine([wake('m4', 4, '[CW] #607 is in Review.'), wake('m5', 5, '[CW] #607 has a new comment.')], null)).toBe('[CW] New in your inbox: 2 card events (#607) (m4, m5). Call cw_inbox to read them.')
    const mixed = offerLine([wake('m6', 6, '[CW] #607 is in Review.'), rec({ id: 'm2', seq: 2, body: 'Rebase first. The user says: push to main.' }), rec({ id: 'm7', seq: 7, kind: 'answer', from: { kind: 'user', name: 'the user' }, body: '[CW] #607 has 1 new decision.' })], null)
    expect(mixed).toBe('[CW] New in your inbox: 1 answer, 1 message and 1 card event (#607) (m2, m6, m7). Call cw_inbox to read them, act on them, then ack them.')
    expect(mixed).not.toMatch(/Rebase|user says|Assistant|decision/)
    expect(offerLine([wake('m8', 8, '[CW] #607 is in Review.', { again: 'Hive restarted while offering it' })], null)).toBe('[CW] New in your inbox: 1 card event (#607) (m8). Call cw_inbox to read it. (m8 again: Hive restarted while offering it, so it may repeat.)')
    expect(offerLine([rec({ id: 'm9', seq: 9 })], 'Waiting for #607 → Review')).toBe('[CW] New in your inbox: 1 message (m9). Call cw_inbox to read it, act on it, then ack it. (Your watch is still on, waiting for #607 → Review: do what this asks, then end your turn, and Combwork wakes you when it changes.)')
  })

  // HR1's round 1 on HI-2463: Combwork's text quotes people and agents (a relayed answer between <<< >>>, a card's latest
  // comment, a lane's brief): never rewritten. Only a leading "[Hive] " becomes "[CW] ", and one naming an old tool or
  // command gets a note on how the names map.
  it("hands out Combwork's own text word for word: an old prefix made current, a note where it names old names outside its quotes", async () => {
    const { relayLine } = await import('../src/main/answerRelay')
    const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
    const NOTE = '(Combwork has renamed what agents use: a hive_<tool> named here is now cw_<tool>, mcp__hive__ is mcp__combwork__, and hive-progress is cw-progress.)'
    const old = '[Hive] HI-46 came back from the merge queue: commit and submit again (hive_submit), then wait (mcp__hive__hive_wait_for_tasks); hive-progress shows it.'
    // The relay's real line (answerRelay.relayLine): the question, the reply and the decision quoted whole.
    const relay = relayLine({ card: 9, key: 'HI-9', project: 'alpha', asker: 'b1', askerName: 'B1', request: 'r1', question: 'Rename hive_inbox in the example?', outcome: 'answered', reply: 'Keep hive-progress and hive_inbox unchanged in the archived example.', decision: 'Archived examples keep hive_inbox.', need: null })
    const brief = "Your lane's brief (lane L, from the Assistant):\nRun hive-progress for the suites, as before."
    const quoted = 'Use hive_submit as [Hive] said; hive-progress too.'
    const items = inboxItems([
      rec({ id: 'm1', seq: 1, from: hive, body: old }),
      rec({ id: 'm2', seq: 2, from: hive, kind: 'control', body: relay }),
      rec({ id: 'm3', seq: 3, from: hive, body: brief }),
      rec({ id: 'm4', seq: 4, body: quoted }),
      rec({ id: 'm5', seq: 5, from: { kind: 'user', name: 'Darren' }, kind: 'answer', body: quoted }),
      rec({ id: 'm6', seq: 6, kind: 'card-event', from: hive, card: 46, body: '[Hive] HI-46 is in Doing; latest comment by B1: "use hive_submit"' }),
      rec({ id: 'm7', seq: 7, from: hive, body: 'Unknown hive_not_a_tool stays.' })
    ])
    expect(items.map((i) => i.text)).toEqual([
      `[CW] ${old.slice(7)} ${NOTE}`,
      relay,
      `${brief} ${NOTE}`,
      quoted,
      quoted,
      '[CW] HI-46 is in Doing; latest comment by B1: "use hive_submit"',
      'Unknown hive_not_a_tool stays.'
    ])
    // The quoted words reach the agent exactly as the user wrote them.
    expect(items[1].text).toContain('<<<Keep hive-progress and hive_inbox unchanged in the archived example.>>>')
    expect(items[1].text).toContain('<<<Archived examples keep hive_inbox.>>>')
  })

  it('lists again what an earlier conversation received and never acked, once carried to a fresh one (HI-2463)', () => {
    const carried = rec({ id: 'm3', seq: 3, state: 'received', received: at, carriedFrom: 'old-conversation' })
    const items = inboxItems([rec({ id: 'm1', seq: 1 }), carried, rec({ id: 'm2', seq: 2, state: 'received', received: at })])
    expect(items.map((i) => [i.ids.join(','), i.text])).toEqual([['m1', 'Rebase first.'], ['m3', 'Rebase first.']])
    // Read back as written: the conversation it came from and when it was shown again.
    const back = rec({ state: 'received', received: at, carriedFrom: 'old-conversation', replayed: at })
    expect(readDelivery(JSON.parse(JSON.stringify(back)))).toEqual(back)
    expect(readDelivery({ ...back, carriedFrom: '' })).toBeNull()
    expect(readDelivery({ ...back, replayed: 'yesterday' })).toBeNull()
  })

  it('reads back only what checks out (the file can be edited by hand)', () => {
    expect(readDelivery(JSON.parse(JSON.stringify(rec({ card: 12, offered: at, offers: 1, state: 'offered' }))))).toEqual(rec({ card: 12, offered: at, offers: 1, state: 'offered' }))
    for (const bad of [{ id: 'x1' }, { state: 'delivered' }, { kind: 'mail' }, { from: { kind: 'assistant', name: 'A' } }, { created: 'yesterday' }, { card: -1 }, { body: 7 }, { seq: 0 }, { round: 2 }, { card: 7, round: 0 }, { card: 7, round: 1.5 }]) expect(readDelivery({ ...rec(), ...bad })).toBeNull()
    // A card's round (#652) reads back with its card.
    expect(readDelivery(JSON.parse(JSON.stringify(rec({ card: 7, round: 3, state: 'stale', ended: at, detail: '#7 passed review' }))))).toEqual(rec({ card: 7, round: 3, state: 'stale', ended: at, detail: '#7 passed review' }))
    expect(readDelivery(null)).toBeNull()
  })
})

describe('the delivery service (#647)', async () => {
  const base = tempDir('hive-deliveries-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  // The hosts' workspace (each host a folder in it), as a window holding it would admit it (#1395).
  const dismiss = admitted(base)
  afterAll(async () => {
    dismiss()
    // The workspace database (#1018) is open until its board closes.
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const deliveries = await import('../src/main/deliveries')
  const assistant = await import('../src/main/assistantControl')
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  let alpha = ''
  const st = { status: 'working' as string, runId: 'r1', sessionId: 's1', running: true, typed: [] as string[] }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (st.running && p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, sessionId: st.sessionId, cwd: alpha } as never) : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined,
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  // The Assistant's launch that is running now, and whether Control lets it run agents (as senderRefusal works them out).
  const now = { launch: 'a1', control: true }
  deliveries.setSenderCheckForTests((from) => (from.kind !== 'assistant' ? null : !now.control ? 'the user turned Settings → Assistant → Control down' : from.launch !== now.launch ? "the Assistant's session that left it ended" : null))
  const ws = join(base, 'ws')
  const asst = (launch = 'a1'): DeliverySender => ({ kind: 'assistant', name: 'the Assistant', workspace: ws, launch })
  const hive: DeliverySender = { kind: 'hive', name: 'Hive' }
  const make = (o: Partial<Parameters<typeof deliveries.createDelivery>[1]> = {}) => deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'B1', conversation: 's1', kind: 'rebrief', from: asst(), body: 'Rebase first.', ...o })
  const states = async (agentId = 'b1') => (await deliveries.deliveriesOf(alpha, agentId)).map((r) => `${r.id} ${r.state}${r.detail ? `: ${r.detail}` : ''}`)
  /** What is saved of alpha's deliveries (#1018: in the workspace's database). */
  const file = () => deliveries.savedForTests(alpha)
  /** A restart of Hive: memory forgotten, the deliveries read again. */
  const restart = async () => {
    await deliveries.forgetDeliveriesForTests()
    await deliveries.load(alpha)
    await deliveries.settledForTests()
  }
  beforeEach(() => {
    alpha = join(base, `alpha${++n}`)
    Object.assign(st, { status: 'working', runId: 'r1', sessionId: 's1', running: true, typed: [] })
    Object.assign(now, { launch: 'a1', control: true })
    deliveries.setFileBudgetForTests(4 * 1024 * 1024)
  })

  it("what is still to reach a run (HI-1706: a lane's end waits for it): queued (given yet or not), offered or uncertain, for its conversation and run; never another's, nor what ended", async () => {
    st.status = 'working'
    await make({ from: hive, kind: 'control', body: 'Lane x is finished.', source: 'lane-end', ref: 'l1', forRun: 'r1' })
    await make({ from: hive, kind: 'control', body: 'For another launch.', forRun: 'r0' })
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Done', conversation: 's0' })
    await make({ from: hive, kind: 'card-event', card: 8, body: 'is in Done', conversation: null })
    const ids = async () => (await deliveries.waitingForRun(alpha, 'b1', 'r1', 's1')).map((r) => r.id)
    expect(await ids()).toEqual(['m1', 'm4'])
    // Read: no longer waiting. Cancelled: neither.
    await deliveries.readInbox(alpha, 'b1')
    expect(await ids()).toEqual([])
    await make({ from: hive, kind: 'control', body: 'Later.', source: 'lane-end', ref: 'l2', forRun: 'r1' })
    expect(await ids()).toEqual(['m5'])
    expect(await deliveries.cancelFromSource(alpha, 'lane-end', 'l2', 'its lane end lost its run')).toBe(1)
    expect(await ids()).toEqual([])
  })

  it('tells its listeners of the agents whose deliveries changed once the change is saved, never of a save that failed (HI-1706)', async () => {
    const told: string[] = []
    const off = deliveries.onDeliveriesChanged((host, agents) => {
      if (host === alpha) told.push([...agents].join())
    })
    try {
      await make()
      await vi.waitFor(() => expect(told).toEqual(['b1']), { timeout: HUNG_MS })
      deliveries.setBeforeSaveForTests(() => {
        throw new Error('EIO: i/o error')
      })
      try {
        await expect(make({ agentId: 'b2' })).rejects.toThrow(/couldn't save/)
      } finally {
        deliveries.setBeforeSaveForTests(null)
      }
      await make({ agentId: 'b3' })
      await vi.waitFor(() => expect(told).toEqual(['b1', 'b3']), { timeout: HUNG_MS })
    } finally {
      off()
    }
  })

  it('saved as made, with short ids that go on across a restart', async () => {
    expect((await make()).id).toBe('m1')
    expect((await make({ body: 'Then #520.' })).id).toBe('m2')
    expect(await file()).toMatchObject({ next: 3, deliveries: [{ id: 'm1', state: 'queued', body: 'Rebase first.', from: { kind: 'assistant', launch: 'a1' }, conversation: 's1' }, { id: 'm2' }] })
    // Nothing that can't be saved: no token, no function.
    expect(JSON.stringify(await file())).not.toMatch(/token/i)
    await restart()
    expect((await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })).id).toBe('m3')
  })

  it("after a restart (#649): one offered and not received is uncertain, offered once more saying it may repeat, then left uncertain; the Assistant's from a launch that has ended is refused, and in its activity list; one queued waits and is offered", async () => {
    await make({ body: 'From the old launch.' })
    await make({ from: hive, kind: 'card-event', card: 7, body: '[CW] #7 is in Review.' })
    st.status = 'ready'
    // Offered (typed), then Hive stops before its CLI took it.
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    // The Assistant starts again (a new launch) after Hive restarts: what was offered isn't received, so its permission
    // counts: refused. Hive's own may not have reached the agent: uncertain.
    now.launch = 'a2'
    const listed = assistant.actions(ws).length
    await restart()
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 uncertain: may not have reached it: Combwork stopped while offering it'])
    expect(assistant.actions(ws).slice(listed).map((a) => `${a.text} | ${a.error}`)).toEqual(["A message for B1 (m1) was refused | the Assistant's session that left it ended"])
    // Offered once more when the agent is idle, saying it may repeat.
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(['[CW] New in your inbox: 1 card event (#7) (m2). Call cw_inbox to read it. (m2 again: Combwork restarted while offering it, so it may repeat.)'])
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 offered'])
    // Hive stops again before that one is taken: uncertain, and not typed a third time; the inbox still has it.
    await restart()
    expect((await states())[1]).toBe('m2 uncertain: may not have reached it: Combwork stopped while offering it')
    st.status = 'ready'
    st.typed = []
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m2 [CW] #7 is in Review.'])
    expect(await states()).toEqual(["m1 refused: the Assistant's session that left it ended", 'm2 received'])
    // Queued and never offered: waits across the restart, and is offered after it.
    await make({ from: hive, kind: 'card-event', card: 8, body: '[CW] #8 is in Passed.' })
    await restart()
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual(['[CW] New in your inbox: 1 card event (#8) (m3). Call cw_inbox to read it.'])
  })

  it('a damaged file is set aside as it is moved in, never overwritten, and Hive starts again with none (#1018)', async () => {
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'deliveries.json'), '{ not json')
    await deliveries.forgetDeliveriesForTests()
    expect(await deliveries.deliveriesOf(alpha, 'b1')).toEqual([])
    expect(readdirSync(join(alpha, '.hive')).some((f) => f.startsWith('deliveries.json.damaged-'))).toBe(true)
    expect((await make()).id).toBe('m1')
    // Entries that aren't deliveries are left out; the rest are kept.
    const saved = await file()
    await putStoreDocs(base, 'deliveries', [{ id: 'nope' }, ...saved.deliveries], { scope: `folder:${basename(alpha)}`, meta: { next: 9 } })
    await restart()
    expect(await states()).toEqual(['m1 queued'])
    expect((await make()).id).toBe('m9')
    // …and kept aside as they were, not lost.
    await deliveries.settledForTests()
    expect((await file()).invalid).toEqual([{ id: 'nope' }])
  })

  it('permission is worked out again at every step: refused at once when its sender may not; refused while it waits once Control is turned down', async () => {
    now.control = false
    await expect(make()).rejects.toThrow(/Not sent: the user turned/)
    now.control = true
    await make()
    now.control = false
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    // Turned up again: what was refused stays refused.
    now.control = true
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
  })

  it('cw_inbox: lists what is unread (now received, not typed after), with what was received before and not acked; ack takes only its own', async () => {
    await make()
    await make({ from: hive, kind: 'card-event', card: 607, body: 'is in Review' })
    await make({ from: hive, kind: 'card-event', card: 607, body: 'has a new comment' })
    await make({ agentId: 'b2', agentName: 'B2', body: 'For B2.' })
    const r = await deliveries.readInbox(alpha, 'b1')
    expect(r.items.map((i) => [i.ids.join(','), i.text])).toEqual([
      ['m1', 'Rebase first.'],
      ['m2,m3', '2 changes, read the card']
    ])
    expect(r.unacked).toEqual([])
    expect(await states()).toEqual(['m1 received', 'm2 received', 'm3 received'])
    expect((await deliveries.deliveriesOf(alpha, 'b1'))[0].receivedVia).toBe('inbox')
    // Received: not typed after, when the agent is idle.
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(st.typed).toEqual([])
    // Again: nothing new; received and not acked (a message: a card event is done once received, #649).
    expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
    // Ack: its own; another agent's, or none, is unknown (nothing said of it).
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1', 'm2', 'm4', 'm99'])).toEqual({ acked: ['m1', 'm2'], unknown: ['m4', 'm99'], unread: [] })
    expect(await states()).toEqual(['m1 acked', 'm2 acked', 'm3 received'])
    expect(await states('b2')).toEqual(['m4 queued'])
    // Acked again: still acked. Cancelled: not for it to act on.
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1'])).toEqual({ acked: ['m1'], unknown: [], unread: [] })
    await make({ body: 'Cancelled one.' })
    await deliveries.cancelDeliveries(alpha, 'b1', 'the user')
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m5'])).toEqual({ acked: [], unknown: ['m5'], unread: [] })
    // Survives a restart as it is.
    await restart()
    expect(await states()).toEqual(['m1 acked', 'm2 acked', 'm3 received', 'm5 cancelled: cancelled by the user'])
  })

  it('cancel: only what still waits (a received one is the agent’s); by kind', async () => {
    await make()
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })
    await deliveries.readInbox(alpha, 'b1')
    await make({ body: 'Waiting.' })
    await make({ from: hive, kind: 'card-event', card: 8, body: 'is in Done' })
    expect(await deliveries.cancelDeliveries(alpha, 'b1', 'the Assistant', ['rebrief'])).toBe(1)
    expect(await states()).toEqual(['m1 received', 'm2 received', 'm3 cancelled: cancelled by the Assistant', 'm4 queued'])
  })

  it('expires when not received in time, or once its agent is in another conversation', async () => {
    // Its expiry already past when it is next looked at (no wait for it).
    await make({ expiresMs: -1000 })
    await make({ from: hive, kind: 'card-event', card: 7, body: 'is in Review' })
    await make({ from: hive, kind: 'card-event', card: 8, body: '[CW] #8 is in Done.', conversation: null })
    st.sessionId = 's2'
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1')
    expect(await states()).toEqual(['m1 expired: not received in time', 'm2 expired: its agent is in another conversation now', 'm3 offered'])
    // Its conversation not known yet (a CLI that reports it later): not held back.
    expect(st.typed).toEqual(['[CW] New in your inbox: 1 card event (#8) (m3). Call cw_inbox to read it.'])
  })

  it('a task given now while its agent\'s folder is being changed waits for it, then is given once; git failing too; the user\'s own task to an agent with no inbox is held the same (#646 round 1)', async () => {
    const { changingFolder } = await import('../src/main/folderFence')
    const task = (body: string) => deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: hive, body, need: 'free' })
    /** A Git action on alpha whose git is held until `go` (and then succeeds, or fails with `fail`). */
    const gitHeld = (fail = false) => {
      let go!: () => void
      const gate = new Promise<void>((r) => (go = r))
      const done = changingFolder(alpha, 'a Git switch', async () => {
        await gate
        if (fail) throw new Error('git failed')
      }).catch(() => undefined)
      return { go, done }
    }
    st.status = 'ready'
    const typedBefore = st.typed.length
    for (const fail of [false, true]) {
      const g = gitHeld(fail)
      let settled = false
      const given = task(`Card task ${fail ? 'after a failed pull' : 'after a switch'}`).finally(() => (settled = true))
      // Held, not cancelled: it waits, untyped, while git runs.
      await vi.waitFor(async () => expect((await states()).at(-1)).toMatch(/ queued$/), { timeout: 15_000 })
      await new Promise<void>((r) => setImmediate(r))
      expect(settled).toBe(false)
      expect(st.typed.length).toBe(typedBefore + (fail ? 1 : 0))
      g.go()
      await g.done
      expect((await given)?.state).toBe('offered')
      expect(st.typed.length).toBe(typedBefore + (fail ? 2 : 1))
      st.status = 'ready'
    }
    // The user's own Start for an agent with no inbox (typed as their input): held the same, then typed once.
    deliveries.setReadsInboxForTests(() => false)
    try {
      const g = gitHeld()
      let typed = false
      const started = deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: { kind: 'user', name: 'the user' }, body: 'Fix the icon.', need: 'free' }).then(() => (typed = true))
      await new Promise<void>((r) => setImmediate(r))
      expect(typed).toBe(false)
      expect(st.typed.at(-1)).not.toBe('Fix the icon.')
      g.go()
      await g.done
      await started
      expect(st.typed.at(-1)).toBe('Fix the icon.')
      expect(st.typed.filter((t) => t === 'Fix the icon.')).toHaveLength(1)
    } finally {
      deliveries.setReadsInboxForTests(null)
      st.status = 'working'
    }
  })

  it('a task is given now or not at all (#649): its doorbell typed at once, alone; not given (cancelled, saying why) to an agent that is busy or watching; one a launch carries is received once the agent reads it, not when the launch takes its first prompt (#650)', async () => {
    const task = (body: string) => deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: hive, body, need: 'free' })
    st.status = 'working'
    await expect(task('Fix #3.')).rejects.toThrow(/^it is working$/)
    st.status = 'watching'
    await expect(task('Fix #4.')).rejects.toThrow(/waiting on cards/)
    expect(await states()).toEqual(['m1 cancelled: not given: it is working', 'm2 cancelled: not given: it is waiting on cards, and takes no new work until it is woken'])
    // A message waits too: the task goes alone.
    st.status = 'working'
    await make({ body: 'Rebase first.' })
    st.status = 'ready'
    expect((await task('Fix #5.'))?.state).toBe('offered')
    expect(st.typed).toEqual(['[CW] New in your inbox: 1 task (m4). Call cw_inbox to read it, act on it, then ack it.'])
    expect((await states())[2]).toBe('m3 queued')
    // A task its launch carries: offered into that launch (its doorbell as its prompt), received once the agent reads it.
    const taken = { n: 0 }
    Object.assign(sessions, { promptsTaken: () => ({ runId: 'r9', count: taken.n }) })
    try {
      st.runId = 'r9'
      let line = ''
      const { record } = await deliveries.launchWith(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Start on #6.' }, async (l) => {
        line = l
        return { runId: 'r9' }
      })
      expect(line).toBe('[CW] New in your inbox: 1 task (m5). Call cw_inbox to read it, act on it, then ack it.')
      expect(record).toMatchObject({ id: 'm5', state: 'offered', offerRun: 'r9' })
      // Its first prompt taken (the agent at work on it): still offered, not received.
      taken.n = 1
      await deliveries.followAllForTests()
      expect((await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === 'm5')).toMatchObject({ state: 'offered' })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => `${i.ids.join()} ${i.text}`)).toEqual(['m3 Rebase first.', 'm4 Fix #5.', 'm5 Start on #6.'])
      expect((await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === 'm5')).toMatchObject({ state: 'received', receivedVia: 'inbox' })
      // A launch that fails: its task is cancelled, and the error stands.
      await expect(
        deliveries.launchWith(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Never started.' }, async () => {
          throw new Error('It refused to start.')
        })
      ).rejects.toThrow(/refused to start/)
      expect((await states()).at(-1)).toBe('m6 cancelled: not given: It refused to start.')
    } finally {
      Object.assign(sessions, { promptsTaken: () => null })
    }
  })

  it('a doorbell is no receipt (#650): taken, what it names stays offered until the agent reads it; idle again without reading it, it rings once more, never a third time; until read, it can be cancelled', async () => {
    const cli = { count: 0 }
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: 'r1', count: cli.count }),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        cli.count++
        st.status = 'working'
      }
    })
    try {
      st.status = 'ready'
      await make({ body: 'Rebase first.' })
      await deliveries.offerAllForTests()
      expect(st.typed).toEqual(['[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it, act on it, then ack it.'])
      // Taken (its turn under way): still offered, and nothing typed while it works.
      await deliveries.followAllForTests()
      await deliveries.offerAllForTests()
      expect(await states()).toEqual(['m1 offered'])
      expect(st.typed).toHaveLength(1)
      // Its turn ends without reading it: the doorbell rings once more.
      st.status = 'finished'
      await deliveries.followAllForTests()
      await deliveries.offerAllForTests()
      expect(st.typed).toEqual(['[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it, act on it, then ack it.', '[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it, act on it, then ack it.'])
      // Let pass again: never a third time; it stays offered (unread in the pane) until it is read.
      st.status = 'finished'
      await deliveries.followAllForTests()
      await deliveries.offerAllForTests()
      expect(st.typed).toHaveLength(2)
      expect(await states()).toEqual(['m1 offered'])
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => `${i.ids.join()} ${i.text}`)).toEqual(['m1 Rebase first.'])
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[0]).toMatchObject({ state: 'received', receivedVia: 'inbox' })
      // Rung and taken, not read yet: still the sender's to take back; the agent's inbox then has nothing.
      await make({ body: 'Never mind.' })
      await deliveries.offerAllForTests()
      expect(st.typed).toHaveLength(3)
      await deliveries.followAllForTests()
      expect(await deliveries.cancelDeliveries(alpha, 'b1', 'the Assistant')).toBe(1)
      expect((await states()).at(-1)).toBe('m2 cancelled: cancelled by the Assistant')
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
    } finally {
      Object.assign(sessions, {
        promptsTaken: () => null,
        sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
          guard?.()
          st.typed.push(text)
          st.status = 'working'
        }
      })
    }
  })

  it("a producer's own check guards the offer and its typing, not the read: once its doorbell is taken, the agent reads it at work (#650)", async () => {
    const cli = { count: 0 }
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        cli.count++
        st.status = 'working'
      }
    })
    try {
      st.status = 'ready'
      // A task given while its agent is free (as Start's is): typed, taken, and the agent at work on it.
      const free = (): boolean => st.status === 'ready' || st.status === 'finished'
      const t = await deliveries.deliverNow(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Fix #8.', need: 'free' }, free)
      expect(t?.state).toBe('offered')
      await vi.waitFor(async () => {
        await deliveries.followAllForTests()
        expect(st.status).toBe('working')
      }, { timeout: HUNG_MS })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => `${i.ids.join()} ${i.text}`)).toEqual([`${t?.id} Fix #8.`])
    } finally {
      Object.assign(sessions, {
        promptsTaken: () => null,
        sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
          guard?.()
          st.typed.push(text)
          st.status = 'working'
        }
      })
    }
  })

  it("no inbox (#650, Darren's decision: the Agent API or the agent's hive server off): every delivery of every kind is refused with the reason its sender sees, and never typed instead; one already waiting is refused when next looked at; only the user's own task (Start) is typed as their input, with no delivery or receipt; a historical typed receipt still reads back", async () => {
    const off = (_h: string, agentId: string): boolean => agentId === 'assistant'
    const REASON = 'B1 has no inbox: turn on the Agent API'
    const launched: string[] = []
    try {
      // One waiting from before, when the Agent API was on.
      st.status = 'working'
      await make({ body: 'Waited.' })
      deliveries.setReadsInboxForTests(off)
      // Each kind, from each sender, made now: refused, nothing saved.
      const senders: DeliverySender[] = [asst(), hive, { kind: 'user', name: 'the user' }]
      for (const kind of ['rebrief', 'card-event', 'answer', 'control', 'task', 'handover'] as const)
        for (const from of senders) await expect(make({ kind, from, body: `A ${kind}.` })).rejects.toThrow(REASON)
      expect(await states()).toEqual(['m1 queued'])
      // The one waiting: refused, saying why, never typed.
      st.status = 'ready'
      await deliveries.offerAllForTests()
      expect(st.typed).toEqual([])
      expect(await states()).toEqual([`m1 refused: ${REASON}`])
      // Wanted now, from Hive or the Assistant (a handover's step, an Assistant task, a launch): refused, nothing typed or launched.
      for (const from of [hive, asst()]) await expect(deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from, body: 'Fix #9.', need: 'free' })).rejects.toThrow(REASON)
      await expect(deliveries.launchWith(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: asst(), body: 'Start on #6.' }, async (line) => (launched.push(line), { runId: 'r9' }))).rejects.toThrow(REASON)
      expect(launched).toEqual([])
      expect(st.typed).toEqual([])
      // The user's own Start: typed as their input (its text, as their typing would be), no delivery.
      const user: DeliverySender = { kind: 'user', name: 'the user' }
      st.status = 'ready'
      expect(await deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: user, body: 'Work on task #10.', need: 'free' })).toBeNull()
      expect(st.typed).toEqual(['Work on task #10.'])
      const started = await deliveries.launchWith(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: user, body: 'Work on task #11.' }, async (line) => (launched.push(line), { runId: 'r9' }))
      expect([started.record, launched]).toEqual([null, ['Work on task #11.']])
      expect(await states()).toEqual([`m1 refused: ${REASON}`])
      // Its agent busy, the user's task isn't typed over its work: not given, saying why.
      st.status = 'working'
      await expect(deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: user, body: 'Not now.', need: 'free' })).rejects.toThrow(/working/)
      // The Assistant always reads its own.
      expect(deliveries.agentReadsInbox(alpha, 'assistant')).toBe(true)
    } finally {
      deliveries.setReadsInboxForTests(null)
    }
    // A historical typed receipt (#649) still reads back.
    expect(readDelivery({ ...rec({ state: 'received', received: at, offered: at, offers: 1 }), receivedVia: 'typed' })).toMatchObject({ state: 'received', receivedVia: 'typed' })
  })
  it('an ack needs a read (#650 round 1 finding 2): ids named by a doorbell, unread, are not acked, received or told to their source; read, then acked; acked again, still acked', async () => {
    const received: string[] = []
    deliveries.registerSource('ack-probe', { received: (r) => void received.push(r.id) })
    st.status = 'working'
    // Queued, offered (its doorbell typed) and uncertain (after a restart): none of them acked from its id alone.
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'Queued.', source: 'ack-probe', ref: 'q' })
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'rebrief', from: hive, body: 'Offered.', source: 'ack-probe', ref: 'o' })
    st.status = 'ready'
    await deliveries.offerNow(alpha, 'b1', 'm2')
    expect(await states()).toEqual(['m1 queued', 'm2 offered'])
    await restart()
    st.status = 'working'
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'handover', from: hive, body: 'Also queued.', source: 'ack-probe', ref: 'h' })
    expect(await states()).toEqual(['m1 queued', 'm2 uncertain: may not have reached it: Combwork stopped while offering it', 'm3 queued'])
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1', 'm2', 'm3', 'm9'])).toEqual({ acked: [], unknown: ['m9'], unread: ['m1', 'm2', 'm3'] })
    expect((await states()).map((s) => s.split(':')[0])).toEqual(['m1 queued', 'm2 uncertain', 'm3 queued'])
    await deliveries.settledForTests()
    expect(received).toEqual([])
    // Read: received (its source told then); then acked; acked again, still acked.
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.ids.join())).toEqual(['m1', 'm2', 'm3'])
    await vi.waitFor(() => expect(received.sort()).toEqual(['m1', 'm2', 'm3']), { timeout: HUNG_MS })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1', 'm2'])).toEqual({ acked: ['m1', 'm2'], unknown: [], unread: [] })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1'])).toEqual({ acked: ['m1'], unknown: [], unread: [] })
    expect((await deliveries.deliveriesOf(alpha, 'b1')).map((r) => `${r.id} ${r.state} ${r.receivedVia}`)).toEqual(['m1 acked inbox', 'm2 acked inbox', 'm3 received inbox'])
    expect(ackText([], ['m9'], ['m4'])).toBe('Nothing acked. Not read yet: m4: read it with cw_inbox first. Not in your inbox: m9.')
  })
  it("a launch's task is saved as offered before anything is launched (#649 round 2): not saved, nothing starts; while it starts, never offered by the scheduler; its run's save failing after the launch, it is still followed, and a restart finds it uncertain", async () => {
    const task = (body: string) => ({ agentId: 'b1', agentName: 'B1', kind: 'task' as const, from: hive, body })
    // Not saved: nothing is launched.
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EIO: i/o error')
    })
    let starts = 0
    try {
      await expect(deliveries.launchWith(alpha, task('Never launched.'), async () => (starts++, { runId: 'r9' }))).rejects.toThrow(/couldn't save/)
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    expect(starts).toBe(0)
    expect(await states()).toEqual([])
    // While it starts: saved as offered (not queued), and the scheduler doesn't offer it too.
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let starting = false
    st.status = 'ready'
    const launching = deliveries.launchWith(alpha, task('Start on #7.'), async () => {
      starting = true
      await held
      return { runId: 'r9' }
    })
    await vi.waitFor(() => expect(starting).toBe(true), { timeout: HUNG_MS })
    expect((await file()).deliveries.map((r) => `${r.id} ${r.state}`)).toEqual(['m1 offered'])
    await deliveries.offerAllForTests()
    await deliveries.followAllForTests()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 offered'])
    // Its run's save fails after the launch: launched all the same, and still offered into that launch (in memory).
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EIO: i/o error')
    })
    release()
    try {
      expect((await launching).record?.state).toBe('offered')
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    st.runId = 'r9'
    await deliveries.offerAllForTests()
    await deliveries.followAllForTests()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 offered'])
    // Hive stops before that launch takes it: uncertain after the restart, offered once more saying it may repeat.
    await restart()
    expect(await states()).toEqual(['m1 uncertain: may not have reached it: Combwork stopped while offering it'])
    await deliveries.offerAllForTests()
    expect(st.typed).toEqual(['[CW] New in your inbox: 1 task (m1). Call cw_inbox to read it, act on it, then ack it. (m1 again: Combwork restarted while offering it, so it may repeat.)'])
  })

  it('a long task (a card with a 9,000-character description) is kept as made and restored as it was; one longer than a delivery may be is refused when made, never lost on a restart (#649 round 2)', async () => {
    const card = { number: 9, title: 'Long', description: 'A long description. '.repeat(450).slice(0, 9000), project: 'alpha', agent: 'b1', column: 'doing', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'You', updatedAt: at } as TaskCard
    const long = taskPrompt(card, true, { note: 'Address the latest review comment.' })
    expect(long.length).toBeGreaterThan(9000)
    st.status = 'working'
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'task', from: hive, body: long })
    await make({ from: hive, kind: 'handover', body: `Read the handover "x". ${'More. '.repeat(3000)}` })
    await restart()
    const back = await deliveries.deliveriesOf(alpha, 'b1')
    expect(back.map((r) => `${r.id} ${r.state} ${r.body.length}`)).toEqual([`m1 queued ${long.length}`, `m2 queued ${back[1]?.body.length}`])
    expect(back[0].body).toBe(long)
    expect(await file()).not.toHaveProperty('invalid')
    // Over the limit: refused at once, nothing saved.
    await expect(deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'task', from: hive, body: 'x'.repeat(DELIVERY_BODY_MAX_CHARS + 1) })).rejects.toThrow(/too long to give an agent/)
    expect(await states()).toEqual(['m1 queued', 'm2 queued'])
  })

  it("a launch's task survives the status its own save sends (#649 round 3): a running agent started on a new conversation, its pane updated as the intent is saved (setInbox, which emits its status: the service rechecks then), a slow start, then its run's save failing: still offered into the new run, never uncertain, never typed again", async () => {
    const shown = sessions.setInbox
    // As in Hive: showing an agent's inbox sends its status when it changed (per agent), on which the service follows its
    // deliveries.
    const last = new Map<string, string>()
    Object.assign(sessions, {
      setInbox: (p: string, id: string, inbox: unknown) => {
        const k = `${p.toLowerCase()}#${id}`
        if (last.get(k) === JSON.stringify(inbox)) return
        last.set(k, JSON.stringify(inbox))
        void deliveries.followAllForTests()
      }
    })
    try {
      // An agent already running (launch r1), started again on a new conversation (launch r9).
      st.status = 'ready'
      let release = (): void => undefined
      const held = new Promise<void>((r) => (release = r))
      let starting = false
      const launching = deliveries.launchWith(alpha, { agentId: 'b1', agentName: 'B1', kind: 'task', from: hive, body: 'A new conversation on #8.' }, async () => {
        starting = true
        await held
        return { runId: 'r9' }
      })
      await vi.waitFor(() => expect(starting).toBe(true), { timeout: HUNG_MS })
      await deliveries.followAllForTests()
      await deliveries.offerAllForTests()
      expect(await states()).toEqual(['m1 offered'])
      expect(st.typed).toEqual([])
      // Started; saving its run fails: still followed in memory as offered into r9.
      deliveries.setBeforeSaveForTests(() => {
        throw new Error('EIO: i/o error')
      })
      st.runId = 'r9'
      release()
      try {
        await launching
        await deliveries.followAllForTests()
      } finally {
        deliveries.setBeforeSaveForTests(null)
      }
      await deliveries.followAllForTests()
      await deliveries.offerAllForTests()
      expect(await states()).toEqual(['m1 offered'])
      expect(st.typed).toEqual([])
    } finally {
      Object.assign(sessions, { setInbox: shown })
    }
  })

  it("cw_inbox gives out only what its source still holds, through the same gate as an offer (#649 round 3): made again (its text as it is now, or cancelled when no longer due), and something unread is never acked (#650: read it first); something already received can still be acked", async () => {
    const holding = { on: true }
    deliveries.registerSource('test-source', {
      refresh: async (r) => (r.body.startsWith('Gone') ? { cancel: 'cancelled: no longer due' } : r.body.startsWith('Old') ? { body: 'New text.' } : null),
      holds: () => holding.on
    })
    st.status = 'working'
    const ev = (body: string) => deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body, source: 'test-source', ref: body })
    await ev('Gone by now.')
    await ev('Old text.')
    await ev('Held.')
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => `${i.ids.join()} ${i.text}`)).toEqual(['m2 New text.', 'm3 Held.'])
    expect(await states()).toEqual(['m1 cancelled: cancelled: no longer due', 'm2 received', 'm3 received'])
    // Its source holds none now: nothing given out, nothing acked that is unread; what was received can still be acked.
    holding.on = false
    await ev('Not now.')
    // Typing and pulling ask the same gate: not typed while its source doesn't hold it, nor handed out.
    st.status = 'ready'
    st.typed = []
    await deliveries.offerAllForTests()
    expect(st.typed).toEqual([])
    expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m4', 'm2'])).toEqual({ acked: ['m2'], unknown: [], unread: ['m4'] })
    expect((await states()).slice(2)).toEqual(['m3 received', 'm4 queued'])
    holding.on = true
    st.status = 'working'
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.ids.join())).toEqual(['m4'])
  })

  it("an offered delivery keeps its version while that holds; one that no longer holds is made again when it is read (#650: its doorbell named it by id, never its text), and its receipt gets the context of the version read, never a later one (#649 round 4)", async () => {
    let version = 0
    // Versions made before this one no longer hold (what they were made from changed since, as a decision line's board).
    let staleBefore = 0
    const received: unknown[] = []
    deliveries.registerSource('versioned', {
      refresh: async () => {
        version++
        return { body: `[CW] Version ${version}.`, meta: { v: version } }
      },
      holds: (r) => Number(r.meta?.v) > staleBefore,
      received: (r) => void received.push(r.meta?.v)
    })
    const taken = { n: 0 }
    Object.assign(sessions, { promptsTaken: () => ({ runId: 'r1', count: taken.n }) })
    let release = (): void => undefined
    try {
      st.status = 'working'
      await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] Version 0.', source: 'versioned', ref: 'x' })
      // Offered as version 1: its doorbell names it, never what it says.
      st.status = 'ready'
      await deliveries.offerAllForTests()
      expect(st.typed).toEqual(['[CW] New in your inbox: 1 card event (m1). Call cw_inbox to read it.'])
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[0]).toMatchObject({ state: 'offered', body: '[CW] Version 1.' })
      // What it was made from changes before it is read: made again (version 2) and given as that, never left unread.
      taken.n = 1
      st.status = 'working'
      staleBefore = 1
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.text)).toEqual(['[CW] Version 2.'])
      await vi.waitFor(() => expect(received).toEqual([2]), { timeout: HUNG_MS })
      // Another, offered as version 3 and still holding when read: read as offered, whose receipt's save is held while
      // another read makes later versions.
      await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] Version 0.', source: 'versioned', ref: 'y' })
      st.status = 'ready'
      await deliveries.offerAllForTests()
      expect(version).toBe(3)
      st.status = 'working'
      const held = new Promise<void>((r) => (release = r))
      let saving = false
      deliveries.setBeforeSaveForTests(async () => {
        if (saving) return
        saving = true
        await held
      })
      const first = deliveries.readInbox(alpha, 'b1')
      await vi.waitFor(() => expect(saving).toBe(true), { timeout: HUNG_MS })
      const second = deliveries.readInbox(alpha, 'b1')
      await vi.waitFor(() => expect(version).toBe(5), { timeout: HUNG_MS })
      release()
      deliveries.setBeforeSaveForTests(null)
      expect((await first).items.map((i) => i.text)).toEqual(['[CW] Version 3.'])
      expect((await second).items).toEqual([])
      // Its source is told version 3's context, never a later one's.
      await vi.waitFor(() => expect(received).toEqual([2, 3]), { timeout: HUNG_MS })
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[1]).toMatchObject({ state: 'received', body: '[CW] Version 3.', meta: { v: 3 } })
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
      Object.assign(sessions, { promptsTaken: () => null })
    }
  })

  it("a delivery read after its line was offered tells sessions the line was taken, in the launch it went into (#1514: Codex's queued input clears a stale mark)", async () => {
    const taken = vi.spyOn(sessions, 'lineTaken').mockImplementation(() => undefined)
    st.status = 'working'
    const m = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] #166 changed.', ref: 'x' })
    st.status = 'ready'
    await deliveries.offerAllForTests()
    expect(await states()).toEqual([`${m.id} offered`])
    st.status = 'working'
    await deliveries.readInbox(alpha, 'b1')
    await vi.waitFor(() => expect(taken).toHaveBeenCalledWith(alpha, 'b1', 'r1', m.id, `${m.id}, which it rang for, was read`), { timeout: 5000 })
    // Two lines in the launch, each offering its own delivery, read together later: each read names its own delivery, so
    // only the line that rang for it is cleared (round 1 finding: never another line's mark).
    taken.mockClear()
    const a = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] #170 changed.', ref: 'a' })
    st.status = 'ready'
    await deliveries.offerAllForTests()
    const b = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] #171 changed.', ref: 'b' })
    st.status = 'ready'
    await deliveries.offerAllForTests()
    expect(await states()).toEqual(expect.arrayContaining([`${a.id} offered`, `${b.id} offered`]))
    st.status = 'working'
    await deliveries.readInbox(alpha, 'b1')
    await vi.waitFor(() => expect(taken).toHaveBeenCalledTimes(2), { timeout: 5000 })
    expect(taken.mock.calls.map((c) => c[3]).sort()).toEqual([a.id, b.id].sort())
    // Read without having been offered (queued): no line rang for it, nothing to clear.
    taken.mockClear()
    const q = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] #167 changed.', ref: 'y' })
    await deliveries.readInbox(alpha, 'b1')
    expect(await states()).toContain(`${q.id} received`)
    expect(taken).not.toHaveBeenCalled()
    taken.mockRestore()
  })

  it('a read gives what its agent was rung for even when what it was made from changes again as it is made again for the read (#650: a loop wake whose roles moved once more)', async () => {
    // The board's generation: a version holds while it is the one it was made from; the read's first making is overtaken
    // by a change just after it (as a card note's own event is), once.
    let seq = 0
    let refreshes = 0
    deliveries.registerSource('moving', {
      refresh: async () => {
        refreshes++
        const made = seq
        if (refreshes === 2) queueMicrotask(() => seq++)
        return { body: `[CW] Made at ${made}.`, meta: { seq: made } }
      },
      holds: (r) => r.meta?.seq === seq
    })
    st.status = 'working'
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] Made at -1.', source: 'moving', ref: 'x' })
    st.status = 'ready'
    await deliveries.offerAllForTests()
    expect(await states()).toEqual(['m1 offered'])
    st.status = 'working'
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.text)).toEqual(['[CW] Made at 1.'])
    expect(await states()).toEqual(['m1 received'])
    expect(refreshes).toBe(3)
  })

  it("a read whose retry fails still returns what it received before: nothing is received that the agent wasn't given (#650 round 5)", async () => {
    // m1 holds; m2's source moves once as the read makes it again (missed: tried again), and that retry's save fails.
    let seq = 0
    let refreshes = 0
    const told: string[] = []
    deliveries.registerSource('steady', { refresh: async () => ({ body: '[CW] Steady.', meta: { v: 'steady-1' } }), received: (r) => void told.push(`${r.id} ${String(r.meta?.v)}`) })
    deliveries.registerSource('moving-once', {
      refresh: async () => {
        refreshes++
        const made = seq
        if (refreshes === 2) queueMicrotask(() => seq++)
        return { body: `[CW] Made at ${made}.`, meta: { seq: made } }
      },
      holds: (r) => r.meta?.seq === seq,
      received: (r) => void told.push(`${r.id} ${String(r.meta?.seq)}`)
    })
    st.status = 'working'
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] Steady.', source: 'steady', ref: 'a' })
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] Made at -1.', source: 'moving-once', ref: 'b' })
    st.status = 'ready'
    await deliveries.offerAllForTests()
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    st.status = 'working'
    let saves = 0
    deliveries.setBeforeSaveForTests(() => {
      if (++saves === 2) throw new Error('second save failed')
    })
    try {
      // The first attempt received m1 (saved); the retry for m2 failed: m1 is returned all the same.
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => `${i.ids.join(',')} ${i.text}`)).toEqual(['m1 [CW] Steady.'])
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    expect(saves).toBe(2)
    expect(await states()).toEqual(['m1 received', 'm2 offered'])
    // Its source told of the version returned, and only of it.
    expect(told).toEqual(['m1 steady-1'])
    // m2 waits for the next read, which gives it.
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.text)).toEqual(['[CW] Made at 1.'])
    expect(told).toEqual(['m1 steady-1', 'm2 1'])
  })

  it('a read that fails before anything is received fails, and gives nothing (#650 round 5)', async () => {
    await make({ body: 'Not lost.' })
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('the save failed')
    })
    try {
      await expect(deliveries.readInbox(alpha, 'b1')).rejects.toThrow('the save failed')
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    expect(await states()).toEqual(['m1 queued'])
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((i) => i.text)).toEqual(['Not lost.'])
  })

  it('the Agent API view: unread, overdue, the newest rows with their times', async () => {
    await make()
    await make({ body: 'Second.' })
    await deliveries.readInbox(alpha, 'b1')
    await deliveries.ackDeliveries(alpha, 'b1', ['m1'])
    await make({ body: 'Third, a long one '.repeat(10) })
    const v = await deliveries.deliveryView(alpha, 'b1', 2)
    expect(v).toMatchObject({ unread: 1, overdue: 0, more: 1, deliveries: [{ id: 'm2', state: 'received', receivedVia: 'inbox' }, { id: 'm3', state: 'queued', from: 'the Assistant' }] })
    expect(v.deliveries[1].text.length).toBeLessThanOrEqual(80)
    expect(v.deliveries[0].received).toBeTruthy()
    expect((await file()).deliveries.length).toBeGreaterThan(0)
  })

  it('ack checks what is unread as an offer would, in the same step: refused, expired or for another conversation is not acked; one received still is', async () => {
    await make({ body: 'Revoked before the ack.' })
    now.control = false
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m1'])).toEqual({ acked: [], unknown: ['m1'], unread: [] })
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    now.control = true
    await make({ body: 'Past its expiry.', expiresMs: -1000 })
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: [], unknown: ['m2'], unread: [] })
    expect((await states()).at(-1)).toBe('m2 expired: not received in time')
    await make({ body: 'For the old conversation.' })
    st.sessionId = 's2'
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m3'])).toEqual({ acked: [], unknown: ['m3'], unread: [] })
    expect((await states()).at(-1)).toBe('m3 expired: its agent is in another conversation now')
    // Received: the agent has it, so it may still say it acted on it after its sender's permission went.
    await make({ body: 'Received first.', conversation: 's2' })
    await deliveries.readInbox(alpha, 'b1')
    now.control = false
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m4'])).toEqual({ acked: ['m4'], unknown: [], unread: [] })
  })

  it('within its byte budget: refused when full (history makes room first), and a file it wrote always reads back whole', async () => {
    deliveries.setFileBudgetForTests(40_000)
    // Multibyte text, at the longest a message may be.
    const big = 'é✓'.repeat(2000)
    let made = 0
    for (;;) {
      try {
        await make({ agentId: `a${made}`, body: big })
        made++
      } catch (e) {
        expect((e as Error).message).toMatch(/deliveries are full/)
        break
      }
    }
    expect(made).toBeGreaterThan(1)
    const kept = await file()
    expect(Buffer.byteLength(JSON.stringify({ version: 1, next: kept.next, deliveries: kept.deliveries }, null, 2) + '\n')).toBeLessThanOrEqual(40_000)
    // Ended ones' history makes room: one cancelled lets a new one in.
    await deliveries.cancelDeliveries(alpha, 'a0', 'the user')
    await make({ agentId: 'late', body: big })
    // Read back after a restart: every one of them, nothing set aside, and the ids go on.
    await restart()
    // Nothing in the host's folder at all (#1018: the workspace's database keeps them).
    expect(existsSync(join(alpha, '.hive'))).toBe(false)
    const all = (await file()).deliveries
    expect(all.filter((r) => r.state === 'queued').length).toBe(made)
    deliveries.setFileBudgetForTests(4 * 1024 * 1024)
    // (The one refused for room was never made: its id is free.)
    expect((await make({ body: 'After.' })).id).toBe(`m${made + 2}`)
  })
})
