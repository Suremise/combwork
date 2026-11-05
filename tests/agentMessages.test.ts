// Messages left for an agent (#530, main/agentMessages.ts), as deliveries (#647, main/deliveries.ts): its doorbell typed at
// once when it is idle or watching (its watch carries on, and the line says so), else queued and named in its next line:
// with a wake (#649: a card event, as a watch or a loop wake hands it over) when one comes first, else a line of its own
// once it is idle; several in one line, by their ids (#650: never their text); received once the agent reads it;
// bounded; each kept to its sender's permission (refused, never typed, once it is gone); cancelled by the user or the
// Assistant; kept across the agent's stops; the reply says what became of it. The sessions are stand-ins here (the e2e
// agentmessage and deliveries suites run fake Claude Code agents).
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { ackText, isOverdue, type DeliverySender } from '../src/shared/deliveries'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

describe('messages left for agents (#530, #647)', async () => {
  const base = tempDir('hive-messages-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  // The hosts' workspace (each host a folder in it), as a window holding it would admit it (#1395).
  const dismiss = admitted(base)
  afterAll(async () => {
    dismiss()
    // The workspace database (#1018) is open until its board closes.
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })
  const messages = await import('../src/main/agentMessages')
  const deliveries = await import('../src/main/deliveries')
  const { storeTestHooks } = await import('../src/main/storeRows')
  const writer = await import('../src/main/lineWriter')
  const { sessions } = await import('../src/main/sessions')
  let n = 0
  let alpha = ''
  /**
   * Stand-in agents of alpha (b1, and any other id while `running`): b1's status, launch and watch, the inbox shown,
   * whether the user types there, what was typed, and `during`: run while a line is being typed (before its last check).
   */
  const st = { status: 'working' as string, runId: 'r1', sessionId: 's1', watch: null as null | { label: string }, typing: false, shown: undefined as undefined | { unread: { id: string; state: string; text: string }[]; overdue: number }, typed: [] as string[], running: true, during: null as null | (() => unknown) }
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (st.running && p.toLowerCase() === alpha.toLowerCase() ? ({ projectPath: alpha, agentId: id, status: st.status, runId: st.runId, sessionId: st.sessionId, ...(st.watch ? { watch: st.watch } : {}) } as never) : null),
    userMayBeTyping: () => st.typing,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: (_p: string, id: string, inbox: typeof st.shown) => {
      if (id === 'b1') st.shown = inbox
    },
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      await st.during?.()
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  /** Whether the Assistant may still send what it left (null: it may), as Control and its launch would say. */
  let why: string | null = null
  deliveries.setSenderCheckForTests((from) => (from.kind === 'assistant' ? why : null))
  const asst: DeliverySender = { kind: 'assistant', name: 'the Assistant', workspace: 'C:/ws', launch: 'a1' }
  const leave = (text: string) => messages.leaveMessage(alpha, 'b1', 'HR2', asst, text)
  const hive: DeliverySender = { kind: 'combwork', name: 'Combwork' }
  /** A wake for b1 (#649: a card event, as a watch or a loop wake hands it over), offered now: whether a line was typed. */
  const wake = async (body: string): Promise<boolean> => {
    await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body })
    return deliveries.offerNow(alpha, 'b1')
  }
  const states = async (agentId = 'b1') => (await deliveries.deliveriesOf(alpha, agentId)).map((r) => `${r.id} ${r.state}${r.detail ? `: ${r.detail}` : ''}`)
  const tryAll = () => deliveries.offerAllForTests()
  /** The doorbell (#650) naming these deliveries: Combwork's fixed words with counts and ids. */
  const bell = (what: string, ids: string, tail = '') => {
    const them = ids.includes(',') ? 'them' : 'it'
    // Anything to ack (not only card events): act on it, then ack (#1530).
    const ack = /\b(message|task|answer|handover)s?\b/.test(what) ? `, act on ${them}, then ack ${them}` : ''
    return `[CW] New in your inbox: ${what} (${ids}). Call cw_inbox to read ${them}${ack}.${tail}`
  }
  beforeEach(async () => {
    // Each test its own project, so ids start at m1.
    alpha = join(base, `alpha${++n}`)
    why = null
    Object.assign(st, { status: 'working', runId: 'r1', sessionId: 's1', watch: null, typing: false, shown: undefined, typed: [], running: true, during: null })
  })

  it('a watching agent is typed into at once, with its id, and told its watch carries on', async () => {
    Object.assign(st, { status: 'watching', watch: { label: 'Waiting for #506 → Review' } })
    expect(await leave('Review #506 when it returns, then #509.')).toEqual({ id: 'm1', fate: 'typed', queued: 0 })
    expect(st.typed).toEqual([bell('1 message', 'm1', ' (Your watch is still on, waiting for #506 → Review: do what this asks, then end your turn, and Combwork wakes you when it changes.)')])
    expect(await states()).toEqual(['m1 offered'])
    // Offered, not received: the pane still shows it until the agent fetches or acks it.
    expect(st.shown?.unread.map((m) => `${m.id} ${m.state}`)).toEqual(['m1 offered'])
  })

  it('a working agent gets it as its next line once it is idle; several waiting go in one line', async () => {
    expect(await leave('Add #520 to your lane after #519.')).toEqual({ id: 'm1', fate: 'queued', queued: 1 })
    expect(await leave('And #522.')).toEqual({ id: 'm2', fate: 'queued', queued: 2 })
    await tryAll()
    expect(st.typed).toEqual([])
    expect(st.shown?.unread.map((m) => m.text)).toEqual(['Add #520 to your lane after #519.', 'And #522.'])
    // Waiting for the user, starting: still queued. The user typing there: still queued. (Its turn over on background
    // tasks of its own takes it, #726: below.)
    for (const s of ['waiting', 'starting']) {
      st.status = s
      await tryAll()
    }
    Object.assign(st, { status: 'finished', typing: true })
    await tryAll()
    expect(st.typed).toEqual([])
    st.typing = false
    await tryAll()
    expect(st.typed).toEqual([bell('2 messages', 'm1, m2')])
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    // Offered once.
    st.status = 'ready'
    await tryAll()
    expect(st.typed).toHaveLength(1)
    // #726: its turn over while its own background tasks run (a timer), a new message rings at once.
    st.status = 'background'
    expect(await leave('Darren pushed the tag.')).toEqual({ id: 'm3', fate: 'typed', queued: 0 })
    expect(st.typed).toHaveLength(2)
  })

  it('received only once the agent reads it (#650), never because its doorbell was typed or its CLI took it; acked through cw_inbox once read, never from its id alone', async () => {
    const cli = { count: 0 }
    Object.assign(sessions, { promptsTaken: () => ({ runId: 'r1', count: cli.count }), holdForConfirm: () => () => undefined })
    writer.testHooks.takeMs = 5000
    try {
      st.status = 'ready'
      expect((await leave('Rebase first.')).fate).toBe('typed')
      // Typed, not taken yet: offered.
      expect(await states()).toEqual(['m1 offered'])
      expect(st.shown?.unread.map((m) => `${m.id} ${m.state}`)).toEqual(['m1 offered'])
      // The CLI takes the doorbell (its prompt count goes up after the line's Enter, its turn under way): still offered.
      cli.count++
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      await deliveries.followAllForTests()
      expect(await states()).toEqual(['m1 offered'])
      // The agent reads it: received, through the inbox, and no longer unread in its pane.
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m1 Rebase first.'])
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[0]).toMatchObject({ state: 'received', receivedVia: 'inbox' })
      expect(st.shown).toBeUndefined()
      // Still the agent's to ack.
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
      // Not acked from its id alone (#650: its doorbell named it, so it is read first): read, then acked.
      st.status = 'ready'
      expect((await leave('And #521.')).fate).toBe('typed')
      expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: [], unknown: [], unread: ['m2'] })
      expect((await states()).at(-1)).toBe('m2 offered')
      await deliveries.readInbox(alpha, 'b1')
      expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: ['m2'], unknown: [], unread: [] })
      expect((await states()).at(-1)).toBe('m2 acked')
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['holdForConfirm']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  // #1531 (#1346 item 7: 80 inbox calls, a read and an ack for each wake): cw_inbox's opt-in combined form acks, then
  // reads, in one call; ack only and read only are as they were, and nothing is acked by being read.
  it('ack then read in one call: the ack by its own rules, then what is new, received and never acked; ack only lists and receives nothing', async () => {
    st.status = 'working'
    await leave('First.')
    expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m1'])
    // A second arrives while the agent acts on the first: one call acks m1 and gives m2, received only.
    await leave('Second.')
    expect(await deliveries.ackThenRead(alpha, 'b1', ['m1'])).toMatchObject({ acked: ['m1'], unknown: [], unread: [], items: [expect.objectContaining({ ids: ['m2'] })], unacked: [] })
    expect(await states()).toEqual(['m1 acked', 'm2 received'])
    // Ack only, with a new one waiting: acks, and lists and receives nothing.
    await leave('Third.')
    expect(await deliveries.ackDeliveries(alpha, 'b1', ['m2'])).toEqual({ acked: ['m2'], unknown: [], unread: [] })
    expect((await states()).at(-1)).toBe('m3 queued')
    // Combined, acking one not read yet: refused unread, then read by the same call (received, not acked).
    expect(await deliveries.ackThenRead(alpha, 'b1', ['m3'])).toMatchObject({ acked: [], unread: ['m3'], items: [expect.objectContaining({ ids: ['m3'] })] })
    expect((await states()).at(-1)).toBe('m3 received')
    // Another agent's id: unknown, revealing nothing, and left as it is.
    await messages.leaveMessage(alpha, 'b2', 'Other', asst, 'For b2.')
    expect(await deliveries.ackThenRead(alpha, 'b1', ['m4'])).toEqual({ acked: [], unknown: ['m4'], unread: [], items: [], unacked: ['m3'] })
    expect(await states('b2')).toEqual(['m4 queued'])
    // Read and not acked (the agent didn't act): still the agent's, overdue after 30 minutes as before.
    const m3 = (await deliveries.deliveriesOf(alpha, 'b1')).find((r) => r.id === 'm3')!
    expect(isOverdue(m3, Date.parse(m3.created) + 31 * 60_000)).toBe(true)
    // Read only: as before.
    expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m3'] })
    // The ack line of each form: one not read yet is read first alone, and read by the same call when combined.
    expect(ackText(['m1'], [], ['m3'])).toBe('Acked m1. Not read yet: m3: read it with cw_inbox first.')
    expect(ackText(['m1'], ['m9'], ['m3'], true)).toBe('Acked m1. Not read before: m3, not acked: ack it once you have acted on it. Not in your inbox: m9.')
  })

  it('offered only once saved: a save that fails types nothing, and a wake waits for the save of what rides it', async () => {
    // A save that fails: the message isn't made (nothing claims it is saved).
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      st.status = 'working'
      await expect(leave('Never saved.')).rejects.toThrow(/couldn't save the deliveries \(EACCES/)
      // Not made: nothing published, nor on disk (and its id is free again).
      expect(await states()).toEqual([])
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    // Saved while queued; offering it can't be saved: nothing is typed, and it still waits.
    await leave('Saved, then not offered.')
    deliveries.setBeforeSaveForTests(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      st.status = 'ready'
      await tryAll()
      expect(st.typed).toEqual([])
      expect(await states()).toEqual(['m1 queued'])
      // Nor can a wake be made while nothing can be saved: nothing is typed, and the message still waits.
      await expect(wake('[CW] #3 is in Review.')).rejects.toThrow(/couldn't save the deliveries/)
      expect(st.typed).toEqual([])
      expect(await states()).toEqual(['m1 queued'])
    } finally {
      deliveries.setBeforeSaveForTests(null)
    }
    // A save that is slow: the line's first key waits for it (the wake's own, then the offer's).
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let saving = false
    deliveries.setBeforeSaveForTests(async () => {
      saving = true
      await held
    })
    try {
      st.status = 'finished'
      const typing = wake('[CW] #4 is in Review.')
      await vi.waitFor(() => expect(saving).toBe(true), { timeout: HUNG_MS })
      expect(st.typed).toEqual([])
      release()
      expect(await typing).toBe(true)
      expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it("waiting messages go in the line with the agent's next wake, once; a change while it is typed stops it, and the next try takes what waits then", async () => {
    await leave('Use the revised review scope.')
    // The agent's turn ends and a wake (a loop wake's card event) is due before the queue is tried: one line, the message first.
    st.status = 'finished'
    expect(await wake("[CW] #2 (B1's card) is in Review. You review this card in its loop: carry on with it.")).toBe(true)
    expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
    expect(await states()).toEqual(['m1 offered', 'm2 offered'])
    st.status = 'finished'
    await tryAll()
    expect(st.typed).toHaveLength(1)
    // Cancelled while the line is typed: the wake isn't typed with it; tried again, it goes alone.
    st.status = 'working'
    await leave('Never mind.')
    st.status = 'finished'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await wake('[CW] #3 is in Review.')).toBe(false)
    st.during = null
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 card event', 'm4')), { timeout: HUNG_MS })
    expect((await states()).slice(2)).toEqual(['m3 cancelled: cancelled by the user', 'm4 offered'])
    // A line that isn't typed after all (the agent got busy): both wait again, and go together in the next line.
    st.status = 'working'
    await leave('Again later.')
    st.status = 'finished'
    st.during = () => {
      st.status = 'working'
    }
    expect(await wake('[CW] #4 is in Review.')).toBe(false)
    st.during = null
    await vi.waitFor(async () => expect((await states()).slice(4)).toEqual(['m5 queued', 'm6 queued']), { timeout: HUNG_MS })
    st.status = 'finished'
    await deliveries.offerNow(alpha, 'b1')
    await vi.waitFor(() => expect(st.typed.at(-1)).toBe(bell('1 message and 1 card event', 'm5, m6')), { timeout: HUNG_MS })
  })

  it("the Assistant's cancel revoked before it is planned, or once planned while its save waits: none cancelled (HI-2420)", async () => {
    expect((await leave('Queued for later.')).fate).toBe('queued')
    let revoked = false
    const guard = () => {
      if (revoked) throw new Error('Control was turned down meanwhile')
    }
    // Revoked while the cancel holds the host's lock: its read made (the plan's check), then once planned, as its save
    // begins (HR1's round 1: the save's own transaction checks again). Its own refusal either way, not NotSaved's.
    for (const set of [deliveries.setBeforePlanForTests, deliveries.setBeforeSaveForTests]) {
      revoked = false
      set(() => void (revoked = true))
      try {
        await expect(messages.cancelMessages(alpha, 'b1', 'the Assistant', guard)).rejects.toThrow(/^Control was turned down meanwhile$/)
      } finally {
        set(null)
      }
      expect(await states()).toEqual(['m1 queued'])
    }
    // Not revoked: the same call cancels it.
    revoked = false
    expect(await messages.cancelMessages(alpha, 'b1', 'the Assistant', guard)).toBe(1)
    expect(await states()).toEqual(['m1 cancelled: cancelled by the Assistant'])
  })

  it('cancelled while it is being typed: never typed, and the reply says so, not that it was typed', async () => {
    st.status = 'ready'
    st.during = () => messages.cancelMessages(alpha, 'b1', 'the user')
    expect(await leave('Stop that.')).toEqual({ id: 'm1', fate: 'cancelled', queued: 0, detail: 'cancelled by the user' })
    expect(st.typed).toEqual([])
  })

  it("kept to its sender's permission: refused, never typed, once it is gone, while queued or while it is typed", async () => {
    await leave('This delivery requires Control agents.')
    why = 'the user turned Settings → Assistant → Control down'
    st.status = 'finished'
    await tryAll()
    expect(st.typed).toEqual([])
    expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
    // Nor can it be sent while its sender may not.
    await expect(leave('Refused at once.')).rejects.toThrow(/Not sent: the user turned/)
    // Nor does it go in a line with a wake: the wake is typed alone.
    why = null
    st.status = 'working'
    await leave('Also gone.')
    why = "the Assistant's session that left it ended"
    st.status = 'finished'
    expect(await wake('[CW] #4 is in Review.')).toBe(true)
    expect(st.typed).toEqual([bell('1 card event', 'm3')])
    await vi.waitFor(async () => expect((await states())[1]).toBe("m2 refused: the Assistant's session that left it ended"), { timeout: HUNG_MS })
    // Revoked while it is being typed at once: stopped before Enter, and refused.
    why = null
    st.status = 'ready'
    st.during = () => {
      why = 'the user turned Settings → Assistant → Control down'
    }
    expect(await leave('Typed now?')).toEqual({ id: 'm4', fate: 'refused', queued: 0, detail: 'the user turned Settings → Assistant → Control down' })
    expect(st.typed).toEqual([bell('1 card event', 'm3')])
  })

  it('its CLI drops the first Enter and its permission goes before the Enter again: the doorbell is never cleared (#652), the Enter again gives the agent nothing of it, and it is refused', async () => {
    // A CLI that takes nothing typed (as Codex dropped an Enter on 7 Oct), until Combwork presses Enter again.
    const cli = { count: 0, enters: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: 'r1', count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 100
    try {
      // Its own doorbell: typed, not taken; revoked before the Enter again, which still comes (it names an id, nothing more).
      st.status = 'ready'
      expect(await leave('Revoked before the retry.')).toEqual({ id: 'm1', fate: 'typed', queued: 0 })
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      // The agent reads its inbox: nothing of it, and it is refused.
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect(await states()).toEqual(['m1 refused: the user turned Settings → Assistant → Control down'])
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // In a doorbell with a wake: the same; the read gives the wake alone, and the doorbell was typed once.
      why = null
      st.status = 'working'
      await leave('In a line with a wake, revoked before the retry.')
      st.status = 'finished'
      expect(await wake('[CW] #5 is in Review.')).toBe(true)
      expect(st.typed.at(-1)).toBe(bell('1 message and 1 card event', 'm2, m3'))
      why = "the Assistant's session that left it ended"
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: HUNG_MS })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m3'])
      expect((await states()).slice(1)).toEqual(["m2 refused: the Assistant's session that left it ended", 'm3 received'])
      expect(st.typed.filter((t) => t.includes('m3'))).toHaveLength(1)
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('a transaction is saved before anyone sees it: a read waits for a create whose save fails, and gets nothing of it', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((r) => (release = r))
    let saves = 0
    deliveries.setBeforeSaveForTests(async () => {
      if (++saves === 1) {
        await held
        throw new Error('EACCES: permission denied')
      }
    })
    try {
      st.status = 'working'
      const made = leave('Never saved, never seen.')
      await vi.waitFor(() => expect(saves).toBe(1), { timeout: HUNG_MS })
      const read = deliveries.readInbox(alpha, 'b1')
      release()
      await expect(made).rejects.toThrow(/couldn't save the deliveries/)
      expect(await read).toEqual({ items: [], unacked: [] })
      expect(await states()).toEqual([])
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it('an operation takes effect at its save: a change while it is saved applies to the next one; a line is checked again before its first key', async () => {
    let release = (): void => undefined
    let holding = false
    const hold = (): void => {
      holding = false
      const held = new Promise<void>((r) => (release = r))
      let first = true
      deliveries.setBeforeSaveForTests(async () => {
        if (!first) return
        first = false
        holding = true
        await held
      })
    }
    try {
      // The inbox: its sender's launch ends while the save of "received" is held: the fetch was decided before, so it
      // is given out and received.
      st.status = 'working'
      await leave('Fetched, then revoked.')
      hold()
      const read = deliveries.readInbox(alpha, 'b1')
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      why = "the Assistant's session that left it ended"
      release()
      expect((await read).items.map((x) => x.ids)).toEqual([['m1']])
      expect(await states()).toEqual(['m1 received'])
      why = null
      // An ack: the agent moves to another conversation while it is saved: acked; the next operation (its inbox) finds
      // the one left for the old conversation expired.
      await leave('Acked from the old conversation.')
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids)).toEqual([['m2']])
      await leave('Left for the old conversation.')
      hold()
      const ack = deliveries.ackDeliveries(alpha, 'b1', ['m2'])
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      st.sessionId = 's2'
      release()
      expect(await ack).toEqual({ acked: ['m2'], unknown: [], unread: [] })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: ['m1'] })
      expect((await states()).slice(1)).toEqual(['m2 acked', 'm3 expired: its agent is in another conversation now'])
      // An offer: its sender's permission goes while "offered" is saved: the writer's check before the first key stops
      // it: nothing typed, refused.
      await leave('Offered while revoked.')
      hold()
      st.status = 'ready'
      const offering = tryAll()
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      why = 'the user turned Settings → Assistant → Control down'
      release()
      await offering
      expect(st.typed).toEqual([])
      expect((await states()).at(-1)).toBe('m4 refused: the user turned Settings → Assistant → Control down')
      why = null
      // An offer: the agent moves to another conversation while "offered" is saved: nothing typed into it, expired.
      st.status = 'working'
      await leave('For this conversation only.')
      hold()
      st.status = 'ready'
      const offering2 = tryAll()
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      st.sessionId = 's3'
      release()
      await offering2
      expect(st.typed).toEqual([])
      expect((await states()).at(-1)).toBe('m5 expired: its agent is in another conversation now')
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
    }
  })

  it('a save that fails changes nothing, on disk or in memory, and a restart restores what was saved (inbox and ack; its write or its commit failing)', async () => {
    for (const how of ['inbox', 'ack'] as const) {
      for (const at of ['write', 'commit'] as const) {
        alpha = join(base, `alpha-failed-${how}-${at}`)
        st.status = 'working'
        await leave('Never received.')
        // An ack is of what was read (#650): read first.
        if (how === 'ack') await deliveries.readInbox(alpha, 'b1')
        const was = how === 'ack' ? 'm1 received' : 'm1 queued'
        const fail = (): never => {
          throw new Error('EIO: i/o error')
        }
        if (at === 'write') deliveries.setBeforeSaveForTests(fail)
        else storeTestHooks.failSave = (s) => s === 'deliveries'
        try {
          const call = how === 'inbox' ? deliveries.readInbox(alpha, 'b1') : deliveries.ackDeliveries(alpha, 'b1', ['m1'])
          await expect(call).rejects.toThrow(at === 'write' ? /couldn't save the deliveries \(EIO.*nothing changed/ : /couldn't save the deliveries \(SQLITE_FULL.*nothing changed/)
        } finally {
          deliveries.setBeforeSaveForTests(null)
          storeTestHooks.failSave = null
        }
        expect(await states()).toEqual([was])
        // As saved (#1018: its workspace's database), the change undone whole.
        expect((await deliveries.savedForTests(alpha)).deliveries.map((r) => `${r.id} ${r.state}`)).toEqual([was])
        await deliveries.forgetDeliveriesForTests()
        expect(await states()).toEqual([was])
      }
    }
  })

  it("a doorbell not taken whose deliveries end before the Enter again (expired, another conversation, cancelled): Enter again, once, and they end honestly; another launch: no Enter, uncertain (#649)", async () => {
    const cli = { count: 0, enters: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    let t = Date.now()
    deliveries.setClockForTests(() => t)
    writer.testHooks.takeMs = 100
    try {
      // Typed, its first Enter lost; then past its expiry: Enter again; expired, and the read gives nothing.
      st.status = 'ready'
      expect((await messages.leaveMessage(alpha, 'b1', 'HR2', asst, 'Expires before the retry.')).fate).toBe('typed')
      t += 25 * 60 * 60_000
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect(await states()).toEqual(['m1 expired: not received in time'])
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // The agent in another conversation before the retry: expired.
      t = Date.now()
      st.status = 'ready'
      expect((await leave('For this conversation.')).fate).toBe('typed')
      st.sessionId = 's2'
      await vi.waitFor(() => expect(cli.enters).toBe(2), { timeout: HUNG_MS })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect((await states()).at(-1)).toBe('m2 expired: its agent is in another conversation now')
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // Cancelled while its CLI hasn't taken the doorbell: cancelled, and the read gives nothing.
      st.sessionId = 's1'
      st.status = 'ready'
      expect((await leave('Cancelled before the retry.')).fate).toBe('typed')
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
      expect((await states()).at(-1)).toBe('m3 cancelled: cancelled by the user')
      await vi.waitFor(() => expect(cli.enters).toBe(3), { timeout: HUNG_MS })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      // The agent started again before the retry: no Enter in the new launch; it may not have reached the agent, so it is
      // uncertain (#649), waiting to be offered once more, and the user can still cancel it.
      st.status = 'working'
      expect((await leave('Typed into the old launch.')).fate).toBe('queued')
      st.status = 'ready'
      await tryAll()
      expect((await states()).at(-1)).toBe('m4 offered')
      st.runId = 'r2'
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
      expect(cli.enters).toBe(3)
      await vi.waitFor(async () => expect((await states()).at(-1)).toBe('m4 uncertain: may not have reached it: its session ended or restarted before it was read'), { timeout: HUNG_MS })
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
    } finally {
      deliveries.setClockForTests(null)
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it("a doorbell with a wake whose offer is saved slowly while a prompt of the user's is taken: its confirmation waits for this line, a cancel still ends the message, and the Enter again gives the wake alone", async () => {
    const cli = { count: 0, enters: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: st.runId, count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      submitAgain: () => {
        cli.enters++
        cli.count++
        st.status = 'working'
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    // Long enough for the cancel to land before the Enter again would come.
    writer.testHooks.takeMs = 2000
    let release = (): void => undefined
    try {
      st.status = 'working'
      await leave('In a slow save.')
      await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: hive, body: '[CW] #6 is in Review.' })
      // The offer's save of "offered" is held; meanwhile the user's own prompt is taken and its turn ends.
      const held = new Promise<void>((r) => (release = r))
      let holding = false
      deliveries.setBeforeSaveForTests(async () => {
        if (holding) return
        holding = true
        await held
      })
      st.status = 'finished'
      const typing = deliveries.offerNow(alpha, 'b1')
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      cli.count++
      release()
      deliveries.setBeforeSaveForTests(null)
      expect(await typing).toBe(true)
      expect(st.typed).toEqual([bell('1 message and 1 card event', 'm1, m2')])
      // Its Enter was lost (the count is still the user's prompt's): not taken, so still the user's to cancel.
      expect(writer.confirmsInFlight()).toBe(1)
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
      expect(await states()).toEqual(['m1 cancelled: cancelled by the user', 'm2 offered'])
      // The Enter again sends the doorbell, which still names the wake: it reads the wake alone, never typed twice.
      await vi.waitFor(() => expect(cli.enters).toBe(1), { timeout: HUNG_MS })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m2'])
      expect(st.typed).toHaveLength(1)
    } finally {
      release()
      deliveries.setBeforeSaveForTests(null)
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'submitAgain']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('tied to a card round (#652): refused for a card not in Doing or Review; stale, never offered or given, once the card passes or a new round starts; kept while the card cannot be read', async () => {
    // The board as a stand-in: card 7, in Doing in round 1 (no failed review yet).
    const card = { number: 7, column: 'doing', archived: false, history: [] as { at: string; by: string; what: string }[] } as never as { number: number; column: string; archived: boolean; history: { at: string; by: string; what: string }[] }
    let readable = true
    deliveries.setCardReaderForTests(async (_host, num) => (!readable ? undefined : num === 7 ? (structuredClone(card) as never) : null))
    const tied = (text: string) => messages.leaveMessage(alpha, 'b1', 'HR2', asst, text, 7)
    try {
      // Not on the board, or not in Doing or Review: refused, nothing made.
      await expect(messages.leaveMessage(alpha, 'b1', 'HR2', asst, 'For a missing card.', 8)).rejects.toThrow(/There is no card #8/)
      card.column = 'todo'
      await expect(tied('Not started.')).rejects.toThrow(/#7 left Doing and Review: a message tied to its round needs it in Doing or Review/)
      expect(await states()).toEqual([])
      // In Doing: tied to round 1, queued while the agent works; saved with its round.
      card.column = 'doing'
      expect(await tied('Round 1: also cover the empty case.')).toEqual({ id: 'm1', fate: 'queued', queued: 1, round: 1 })
      expect((await deliveries.deliveriesOf(alpha, 'b1'))[0]).toMatchObject({ card: 7, round: 1 })
      expect((await deliveries.savedForTests(alpha)).deliveries[0]).toMatchObject({ card: 7, round: 1 })
      // Its first hand-in (into Review, round 1 still): still relevant.
      card.column = 'review'
      await deliveries.sweepStaleForTests()
      expect(await states()).toEqual(['m1 queued'])
      // The card can't be read for a moment (its workspace closing): not stale on that account.
      readable = false
      card.column = 'passed'
      await deliveries.sweepStaleForTests()
      expect(await states()).toEqual(['m1 queued'])
      // It passed: stale, with why, never offered to the idle agent, and its inbox gives nothing of it.
      readable = true
      await deliveries.sweepStaleForTests()
      expect(await states()).toEqual(['m1 stale: #7 passed review'])
      st.status = 'ready'
      await tryAll()
      expect(st.typed).toEqual([])
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      // Its doorbell already rung: a new round starting before the agent reads it leaves the read nothing (the gate checks it).
      card.column = 'doing'
      expect((await tied('Round 1 again.')).fate).toBe('typed')
      expect(st.typed).toEqual([bell('1 message (#7)', 'm2')])
      card.history.push({ at: new Date().toISOString(), by: 'HR2 (alpha)', what: 'Review failed' })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect((await states()).at(-1)).toBe('m2 stale: #7 is in round 2 now')
      // One for round 2, while the card is in Review after that failed verdict: given.
      card.column = 'review'
      st.status = 'ready'
      expect(await tied('Round 2: the finding is about retries.')).toMatchObject({ id: 'm3', fate: 'typed', round: 2 })
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m3 Round 2: the finding is about retries.'])
    } finally {
      deliveries.setCardReaderForTests(null)
    }
  })

  it("tied to a card round, read while the host's lock is held elsewhere (#652 round 1 finding 1): a card that passes or enters a new round while the read waits is seen, and a message made meanwhile is checked too", async () => {
    const card = { number: 7, column: 'doing', archived: false, history: [] as { at: string; by: string; what: string }[] }
    const tied7 = (text: string) => messages.leaveMessage(alpha, 'b1', 'HR2', asst, text, 7)
    let looked = (): void => undefined
    deliveries.setCardReaderForTests(async () => {
      looked()
      return structuredClone(card) as never
    })
    /** Holds the next save (an unrelated delivery's), so what comes after it waits for the host's lock. */
    const holdNextSave = async () => {
      let release = (): void => undefined
      const held = new Promise<void>((r) => (release = r))
      let holding = false
      deliveries.setBeforeSaveForTests(async () => {
        if (holding) return
        holding = true
        await held
      })
      const unrelated = deliveries.createDelivery(alpha, { agentId: 'other', kind: 'control', from: hive, body: 'other' })
      await vi.waitFor(() => expect(holding).toBe(true), { timeout: HUNG_MS })
      return async () => {
        release()
        deliveries.setBeforeSaveForTests(null)
        await unrelated
      }
    }
    try {
      // Passed while the read waits behind a held save: stale, not received.
      expect((await tied7('Old round instruction.')).fate).toBe('queued')
      let release = await holdNextSave()
      let lookups = 0
      looked = () => void lookups++
      const read = deliveries.readInbox(alpha, 'b1')
      // Nothing is read of the card before the lock is held.
      await new Promise<void>((r) => setImmediate(r))
      expect(lookups).toBe(0)
      card.column = 'passed'
      await release()
      expect((await read).items).toEqual([])
      expect(await states()).toEqual(['m1 stale: #7 passed review'])
      // A new round while the read waits: stale too.
      card.column = 'review'
      expect((await tied7('Round 1 again.')).fate).toBe('queued')
      release = await holdNextSave()
      const read2 = deliveries.readInbox(alpha, 'b1')
      card.history.push({ at: new Date().toISOString(), by: 'HR2 (alpha)', what: 'Review failed' })
      await release()
      expect((await read2).items).toEqual([])
      expect((await states()).at(-1)).toBe('m3 stale: #7 is in round 2 now')
      // A message for round 2 made while the read waits (queued for the lock before it, so published by the time the read
      // holds it), its card passing meanwhile: the read checks it too, and it is stale.
      release = await holdNextSave()
      const made = deliveries.createDelivery(alpha, { agentId: 'b1', agentName: 'HR2', kind: 'rebrief', from: asst, card: 7, round: 2, body: 'Made while the read waits.' })
      await new Promise<void>((r) => setImmediate(r))
      const read3 = deliveries.readInbox(alpha, 'b1')
      card.column = 'passed'
      await release()
      expect((await made).id).toBe('m6')
      expect((await read3).items).toEqual([])
      expect((await states()).at(-1)).toBe('m6 stale: #7 passed review')
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
    } finally {
      deliveries.setBeforeSaveForTests(null)
      deliveries.setCardReaderForTests(null)
    }
  })

  it("a doorbell the user typed into before its CLI took it is theirs (#652 round 1 finding 2): no Enter again, whether what it named holds, was cancelled or refused; what still holds waits again", async () => {
    const cli = { count: 0, enters: 0, left: 0 }
    const before = { ...sessions } as Record<string, unknown>
    Object.assign(sessions, {
      promptsTaken: () => ({ runId: 'r1', count: cli.count }),
      holdForConfirm: () => () => undefined,
      lineNotTaken: () => undefined,
      // The user has typed into the prompt since the doorbell began (whatever the typing pause says).
      userTypedOverLine: () => true,
      leaveToUser: () => void cli.left++,
      submitAgain: () => {
        cli.enters++
        return true
      },
      sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
        guard?.()
        st.typed.push(text)
        st.status = 'finished'
      }
    })
    writer.testHooks.takeMs = 50
    try {
      // Still holding: no Enter, and it waits again (offered once more after the user sends a prompt there).
      st.status = 'ready'
      expect((await leave('Still wanted.')).fate).toBe('typed')
      await vi.waitFor(() => expect(cli.left).toBe(1), { timeout: HUNG_MS })
      await vi.waitFor(async () => expect(await states()).toEqual(['m1 queued']), { timeout: HUNG_MS })
      // Cancelled, then refused, before the confirmation looks: no Enter either, and each ends as it is.
      await messages.cancelMessages(alpha, 'b1', 'the user')
      st.status = 'ready'
      expect((await leave('Cancelled.')).fate).toBe('typed')
      expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
      await vi.waitFor(() => expect(cli.left).toBe(2), { timeout: HUNG_MS })
      st.status = 'ready'
      expect((await leave('Refused.')).fate).toBe('typed')
      why = 'the user turned Settings → Assistant → Control down'
      await vi.waitFor(() => expect(cli.left).toBe(3), { timeout: HUNG_MS })
      await vi.waitFor(async () => expect((await states()).slice(1)).toEqual(['m2 cancelled: cancelled by the user', 'm3 refused: the user turned Settings → Assistant → Control down']), { timeout: HUNG_MS })
      expect(cli.enters).toBe(0)
    } finally {
      writer.testHooks.takeMs = undefined
      for (const k of ['promptsTaken', 'holdForConfirm', 'lineNotTaken', 'userTypedOverLine', 'leaveToUser', 'submitAgain']) delete (sessions as unknown as Record<string, unknown>)[k]
      Object.assign(sessions, { sendPrompt: before.sendPrompt, promptsTaken: () => null })
      await vi.waitFor(() => expect(writer.confirmsInFlight()).toBe(0), { timeout: HUNG_MS })
    }
  })

  it('tied to a card round, the board changing after the cards are read (#652 round 2 finding 1): judged at the plan, read again, and never acted on from an outdated read, for the read and the offer', async () => {
    const { emit } = await import('../src/main/events')
    const card = { number: 7, column: 'doing', archived: false, history: [] as { at: string; by: string; what: string }[] }
    deliveries.setCardReaderForTests(async () => structuredClone(card) as never)
    const tied7 = (text: string) => messages.leaveMessage(alpha, 'b1', 'HR2', asst, text, 7)
    const boardChanged = () => emit({ type: 'tasks-changed', workspacePath: 'C:/ws' })
    /** Runs `fn` once, the first time a transaction's read is done and before it is judged and planned. */
    const onceBeforePlan = (fn: () => void) => {
      let done = false
      deliveries.setBeforePlanForTests(() => {
        if (done) return
        done = true
        fn()
      })
    }
    try {
      // The read: the card passes after its cards were read, before the plan. Read again: stale, nothing given.
      expect((await tied7('Round 1: also cover the empty case.')).fate).toBe('queued')
      onceBeforePlan(() => {
        card.column = 'passed'
        boardChanged()
      })
      expect(await deliveries.readInbox(alpha, 'b1')).toEqual({ items: [], unacked: [] })
      expect(await states()).toEqual(['m1 stale: #7 passed review'])
      // The offer: the same between its read and its plan. Nothing is typed, and it is stale.
      card.column = 'doing'
      expect((await tied7('Round 1 again.')).fate).toBe('queued')
      onceBeforePlan(() => {
        card.column = 'passed'
        boardChanged()
      })
      st.status = 'ready'
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(st.typed).toEqual([])
      expect((await states()).at(-1)).toBe('m2 stale: #7 passed review')
      // The board changing at every read (another card's moves): the tied message is held back, unread, neither given nor
      // offered; one not tied to a round goes on as usual.
      card.column = 'doing'
      st.status = 'working'
      expect((await tied7('Held back.')).fate).toBe('queued')
      await leave('Not tied to a round.')
      deliveries.setBeforePlanForTests(() => boardChanged())
      st.status = 'ready'
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(true)
      expect(st.typed).toEqual([bell('1 message', 'm4')])
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => x.ids.join())).toEqual(['m4'])
      expect((await states()).slice(2)).toEqual(['m3 queued', 'm4 received'])
      // Once the board is quiet, it is judged and given.
      deliveries.setBeforePlanForTests(null)
      expect((await deliveries.readInbox(alpha, 'b1')).items.map((x) => `${x.ids.join()} ${x.text}`)).toEqual(['m3 Held back.'])
    } finally {
      deliveries.setBeforePlanForTests(null)
      deliveries.setCardReaderForTests(null)
    }
  })

  it('bounded: at most 5 waiting, 4000 characters each; refused for an agent not running', async () => {
    for (let i = 0; i < messages.MAX_QUEUED; i++) await leave(`Note ${i}`)
    await expect(leave('One too many')).rejects.toThrow(/already has 5 messages waiting/)
    await expect(leave('x'.repeat(messages.MESSAGE_MAX_CHARS + 1))).rejects.toThrow(/at most 4000 characters/)
    // Another agent's count is its own.
    expect((await messages.leaveMessage(alpha, 'b2', 'B2', asst, 'Hello')).fate).toBe('queued')
    st.running = false
    await expect(leave('Hello')).rejects.toThrow(/isn't running/)
  })

  it('cancelled by the user or the Assistant: never typed; kept across a stop and offered to its next launch of that conversation, not another', async () => {
    await leave('Hold on.')
    expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(1)
    expect(st.shown).toBeUndefined()
    expect(await states()).toEqual(['m1 cancelled: cancelled by the user'])
    expect(await messages.cancelMessages(alpha, 'b1', 'the user')).toBe(0)
    st.status = 'ready'
    await tryAll()
    expect(st.typed).toEqual([])
    // Stopped and started again in the same conversation: it waited, and goes in.
    st.status = 'working'
    await leave('For after the restart.')
    st.running = false
    await tryAll()
    expect((await states()).at(-1)).toBe('m2 queued')
    Object.assign(st, { running: true, runId: 'r2', status: 'ready' })
    await tryAll()
    expect(st.typed.at(-1)).toBe(bell('1 message', 'm2'))
    // Its agent in another conversation now: not for it.
    st.status = 'working'
    await leave('For the old conversation.')
    Object.assign(st, { sessionId: 's2', status: 'ready' })
    await tryAll()
    expect(st.typed.filter((t) => t.includes('m3'))).toEqual([])
    expect((await states()).at(-1)).toBe('m3 expired: its agent is in another conversation now')
  })
})
