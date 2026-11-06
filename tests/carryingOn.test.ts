// Carrying on (#1432, #966 row 16, shared/inboxSwitches.ts): Combwork's three ways of getting an agent to read its inbox,
// each with its own switch: told at the end of a tool (a checkpoint, inboxNotices.ts), kept going at its Stop (the
// drain), woken while idle (the doorbell, deliveries.ts offerOnce). Every combination of the switches, for an agent at
// each point, says what Combwork does, and none loses an item: it stays in the inbox, unread, until the agent reads it.
// Deliver Now types the doorbell once with idle wakes off; a task given now isn't a wake. The sessions are stand-ins
// here, as in agentMessages.test.ts (the e2e carryingon suite runs fake Claude Code and Codex agents).
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { INBOX_SWITCHES, INBOX_SWITCH_ID, inboxSwitchOn, type InboxSwitch } from '../src/shared/inboxSwitches'
import type { LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'
import { admitted } from './admitted'

describe('carrying on: the inbox switches (#1432)', async () => {
  const base = tempDir('cw-carrying-on-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  const dismiss = admitted(base)
  const deliveries = await import('../src/main/deliveries')
  const { noticeFor } = await import('../src/main/inboxNotices')
  const { advanced } = await import('../src/main/advanced')
  const { sessions } = await import('../src/main/sessions')
  afterAll(async () => {
    for (const w of INBOX_SWITCHES) await advanced.set(INBOX_SWITCH_ID[w], null)
    deliveries.setReadsInboxForTests(null)
    dismiss()
    ;(await import('../src/main/boardStore')).closeAllBoards()
    rmSync(base, { recursive: true, force: true })
  })

  let n = 0
  let alpha = ''
  /** A stand-in agent b1 of alpha: its status and launch, and what Combwork typed into it. */
  const st = { status: 'ready' as string, runId: 'r1', sessionId: 's1', typed: [] as string[], during: null as null | (() => unknown) }
  const live = (): LiveSessionState => ({ projectPath: alpha, agentId: 'b1', status: st.status, runId: st.runId, sessionId: st.sessionId }) as never
  Object.assign(sessions, {
    liveFor: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && id === 'b1' ? live() : null),
    userMayBeTyping: () => false,
    lineWaiting: () => false,
    promptsTaken: () => null,
    setInbox: () => undefined,
    sendPrompt: async (_p: string, _id: string, text: string, guard?: () => void) => {
      guard?.()
      await st.during?.()
      guard?.()
      st.typed.push(text)
      st.status = 'working'
    }
  })
  deliveries.setReadsInboxForTests(() => true)
  const combwork = { kind: 'combwork' as const, name: 'Combwork' }
  /** What b1 has unread (queued, offered or uncertain: not received, not ended). */
  const unread = async (): Promise<string[]> => (await deliveries.deliveriesOf(alpha, 'b1')).filter((r) => ['queued', 'offered', 'uncertain'].includes(r.state)).map((r) => r.id)
  const setSwitches = async (on: Record<InboxSwitch, boolean>): Promise<void> => {
    for (const w of INBOX_SWITCHES) await advanced.set(INBOX_SWITCH_ID[w], on[w] ? null : false)
  }

  beforeEach(() => {
    alpha = join(base, `alpha${++n}`)
    Object.assign(st, { status: 'ready', runId: `r${n}`, sessionId: `s${n}`, typed: [], during: null })
    deliveries.setInboxProjectForTests(null)
  })
  afterEach(() => deliveries.settledForTests())

  // Every combination of the three switches (on, off), by what the agent is doing when an item arrives.
  const combos = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ checkpoints: !!(i & 1), stopContinuation: !!(i & 2), idleWakes: !!(i & 4) }))
  const name = (c: Record<InboxSwitch, boolean>): string => INBOX_SWITCHES.map((w) => `${w} ${c[w] ? 'on' : 'off'}`).join(', ')

  describe('the table: each switch decides only its own way, and nothing is dropped', () => {
    for (const c of combos) {
      it(name(c), async () => {
        await setSwitches(c)
        // Working: an item arrives during a tool; the tool's end is a checkpoint.
        st.status = 'working'
        const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Also cover the empty case.' })
        const atTool = await noticeFor(live(), 'checkpoint')
        expect(atTool === null ? 'nothing' : 'told').toBe(c.checkpoints ? 'told' : 'nothing')
        if (c.checkpoints) expect(atTool).toContain(m.id)
        // Stopping: its turn would end with it unread; the Stop is the drain.
        const atStop = await noticeFor(live(), 'drain')
        expect(atStop === null ? 'ends' : 'carried on').toBe(c.stopContinuation ? 'carried on' : 'ends')
        if (c.stopContinuation) expect(atStop).toContain(m.id)
        // Neither told it, or it didn't read it: still unread, typed nothing while it worked.
        expect(await unread()).toEqual([m.id])
        expect(st.typed).toEqual([])
        // Idle: the doorbell, or nothing typed at all.
        st.status = 'ready'
        expect(await deliveries.offerNow(alpha, 'b1')).toBe(c.idleWakes)
        expect(st.typed).toEqual(c.idleWakes ? [`[CW] New in your inbox: 1 message (${m.id}). Call cw_inbox to read it, act on it, then ack it.`] : [])
        // Typed or not, it is unread until the agent reads it: never dropped.
        expect(await unread()).toEqual([m.id])
        // The agent reads its inbox whenever it next calls cw_inbox: it is all there.
        expect((await deliveries.readInbox(alpha, 'b1')).items.flatMap((x) => x.ids)).toEqual([m.id])
        expect(await unread()).toEqual([])
      })
    }
  })

  it('idle wakes off: no kind of item is typed, a card event (a loop wake) included; it stays in the inbox, and Deliver Now types its line once', async () => {
    await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: false })
    const e = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: combwork, card: 1432, body: '#1432 is in Review.', source: 'loop', ref: '#1432' })
    const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Then #1434.' })
    await deliveries.offerAllForTests()
    expect(st.typed).toEqual([])
    expect(await unread()).toEqual([e.id, m.id])
    // Deliver Now (the pane's, session:deliverNow): one line naming both, typed once.
    const { deliverWaiting } = await import('../src/main/agentMessages')
    expect(await deliverWaiting(alpha, 'b1')).toBe(true)
    expect(st.typed).toEqual([`[CW] New in your inbox: 1 message and 1 card event (#1432) (${e.id}, ${m.id}). Call cw_inbox to read them, act on them, then ack them.`])
    // The agent idle again without reading them: nothing rings again by itself.
    st.status = 'ready'
    await deliveries.offerAllForTests()
    expect(st.typed).toHaveLength(1)
    expect(await unread()).toEqual([e.id, m.id])
  })

  it("idle wakes off: Deliver Now pressed while the tick's own try is under way still types its line", async () => {
    await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: false })
    const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Then #1434.' })
    const { deliverWaiting } = await import('../src/main/agentMessages')
    // The tick's try first (it types nothing with idle wakes off), Deliver Now while it runs.
    const [tick, asked] = await Promise.all([deliveries.offerNow(alpha, 'b1'), deliverWaiting(alpha, 'b1')])
    expect(tick).toBe(false)
    expect(asked).toBe(true)
    expect(st.typed).toEqual([`[CW] New in your inbox: 1 message (${m.id}). Call cw_inbox to read it, act on it, then ack it.`])
  })

  it('idle wakes off: Deliver Now whose line is overtaken as it is typed (its source no longer wants it as made) makes it again at once and types it, a bounded number of times (#1504)', async () => {
    await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: false })
    // A loop wake's way: held while the board and lanes haven't changed since it was made (rolesSeq).
    let seq = 0
    deliveries.registerSource('overtaken-as-typed', { refresh: async () => ({ body: `[CW] #1504 is in Review (${seq}).`, meta: { seq } }), holds: (r) => r.meta?.seq === seq })
    const { deliverWaiting } = await import('../src/main/agentMessages')
    // The card's arrival in Review updates its lane as the line is typed, once: made again from the board now, typed.
    const e = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: combwork, card: 1504, body: '[CW] #1504 is in Review.', source: 'overtaken-as-typed', ref: '#1504' })
    let changes = 0
    st.during = () => {
      if (++changes === 1) seq++
    }
    expect(await deliverWaiting(alpha, 'b1')).toBe(true)
    expect(st.typed).toEqual([`[CW] New in your inbox: 1 card event (#1504) (${e.id}). Call cw_inbox to read it.`])
    expect(changes).toBe(2)
    // Overtaken on every try: given up after a few, nothing typed, still unread.
    await deliveries.readInbox(alpha, 'b1')
    Object.assign(st, { status: 'ready', typed: [] })
    const f = await deliveries.createDelivery(alpha, { agentId: 'b1', kind: 'card-event', from: combwork, card: 1505, body: '[CW] #1505 is in Review.', source: 'overtaken-as-typed', ref: '#1505' })
    changes = 0
    st.during = () => {
      changes++
      seq++
    }
    expect(await deliverWaiting(alpha, 'b1')).toBe(false)
    expect(st.typed).toEqual([])
    expect(changes).toBe(3)
    expect(await unread()).toEqual([f.id])
  })

  describe('idle wakes turned off while a wake is made or typed (round 1 finding 1): nothing is typed, and it stays unread', () => {
    /** A message whose source's refresh (as the offer is made, before its first key) runs `then`. */
    const pending = async (then: () => Promise<unknown>) => {
      let refreshed = false
      deliveries.registerSource('switch-test', {
        refresh: async () => {
          refreshed = true
          await then()
          return null
        }
      })
      const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Pending wake.', source: 'switch-test' })
      return { m, refreshed: () => refreshed }
    }
    it("Settings' turned off as it is made", async () => {
      await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: true })
      const { m, refreshed } = await pending(() => advanced.set(INBOX_SWITCH_ID.idleWakes, false))
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(refreshed()).toBe(true)
      expect(st.typed).toEqual([])
      expect(await unread()).toEqual([m.id])
    })
    it("the project's own turned off as it is made (Settings' on)", async () => {
      await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: true })
      let own: 'inherit' | 'off' = 'inherit'
      deliveries.setInboxProjectForTests(async () => ({ own: { inboxIdleWakes: own }, changed: () => false }))
      const { m, refreshed } = await pending(async () => (own = 'off'))
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(refreshed()).toBe(true)
      expect(st.typed).toEqual([])
      expect(await unread()).toEqual([m.id])
    })
    it("Settings' turned off while its line is typed: its last key isn't pressed", async () => {
      await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: true })
      const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Typed wake.' })
      st.during = () => advanced.set(INBOX_SWITCH_ID.idleWakes, false)
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(st.typed).toEqual([])
      expect(await unread()).toEqual([m.id])
    })
    it("the project's own turned off while its line is typed (Combwork writes project.json): its last key isn't pressed (round 2 finding)", async () => {
      await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: true })
      // project.json as Combwork writes it: its own value, and a count of the writes since it was read.
      const project = { own: 'inherit' as 'inherit' | 'off', writes: 0 }
      deliveries.setInboxProjectForTests(async () => {
        const at = project.writes
        return { own: { inboxIdleWakes: project.own }, changed: () => project.writes !== at }
      })
      const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Typed wake.' })
      // Between the line's first check and its last: Project Settings → Sessions → Wake an idle agent, Off.
      st.during = () => {
        project.own = 'off'
        project.writes++
        st.during = null
      }
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(st.typed).toEqual([])
      expect(await unread()).toEqual([m.id])
      // The retry reads it again: Off, so nothing is typed then either.
      st.status = 'ready'
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(false)
      expect(st.typed).toEqual([])
      expect(await unread()).toEqual([m.id])
    })
    it("a project's own on, Settings' turned off while it is typed: still typed (the project's own wins)", async () => {
      await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: true })
      deliveries.setInboxProjectForTests(async () => ({ own: { inboxIdleWakes: 'on' }, changed: () => false }))
      const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Own on.' })
      st.during = () => advanced.set(INBOX_SWITCH_ID.idleWakes, false)
      expect(await deliveries.offerNow(alpha, 'b1')).toBe(true)
      expect(st.typed).toHaveLength(1)
      expect(await unread()).toEqual([m.id])
    })
  })

  it("idle wakes off: Deliver Now pressed while a watch's line for the agent is being made waits for it, then types its own", async () => {
    await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: false })
    const writer = await import('../src/main/lineWriter')
    const m = await deliveries.createDelivery(alpha, { agentId: 'b1', conversation: st.sessionId, kind: 'rebrief', from: combwork, body: 'Then #1442.' })
    // A watch's line is being made for the agent for its first checks, then done.
    let asked = 0
    writer.onLineComing(() => ++asked <= 2)
    try {
      const { deliverWaiting } = await import('../src/main/agentMessages')
      expect(await deliverWaiting(alpha, 'b1')).toBe(true)
      expect(asked).toBeGreaterThan(2)
      expect(st.typed).toEqual([`[CW] New in your inbox: 1 message (${m.id}). Call cw_inbox to read it, act on it, then ack it.`])
    } finally {
      writer.onLineComing(() => false)
    }
  })

  it('idle wakes off: a task given now (a card started on a running agent) is no wake, and is typed', async () => {
    await setSwitches({ checkpoints: true, stopContinuation: true, idleWakes: false })
    const r = await deliveries.deliverNow(alpha, { agentId: 'b1', agentName: 'B1', conversation: st.sessionId, kind: 'task', from: { kind: 'user', name: 'the user' }, card: 7, body: 'Work on #7.', need: 'free' })
    expect(r?.state).toBe('offered')
    expect(st.typed).toHaveLength(1)
  })

  it("a project's own value wins over Settings'; inherit (or none, as the Assistant's home) follows Settings'", () => {
    for (const global of [true, false]) {
      expect(inboxSwitchOn('idleWakes', { inboxIdleWakes: 'inherit' }, global)).toBe(global)
      expect(inboxSwitchOn('idleWakes', null, global)).toBe(global)
      expect(inboxSwitchOn('idleWakes', { inboxIdleWakes: 'on' }, global)).toBe(true)
      expect(inboxSwitchOn('idleWakes', { inboxIdleWakes: 'off' }, global)).toBe(false)
      // Each switch reads its own field only.
      expect(inboxSwitchOn('checkpoints', { inboxIdleWakes: 'off', inboxStopContinuation: 'off' }, global)).toBe(global)
      expect(inboxSwitchOn('stopContinuation', { inboxStopContinuation: 'off' }, global)).toBe(false)
    }
  })
})
