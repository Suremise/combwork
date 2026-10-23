// Fresh starts at natural breaks (#1437; shared/freshStarts.ts and main/freshStarts.ts): who Start Fresh (Idle Agents)
// starts fresh and why not, checked again just before the stop (busy, or a lease taken, after the plan); whether a
// project's work has finished; the nudge once per quiet spell (two triggers or two watchers at once: one notice; another
// Hive or a restart: none until an agent was busy), a completion seen while the work was finishing told once it is
// quiet, only when the work has finished (a card in Review: none), and the switch, Settings' and a project's own. Real
// workspace, board and event handler; the agents' sessions, and Start Fresh's stop and start, are stand-ins.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { freshWhy, workFinished, type FreshNow } from '../src/shared/freshStarts'
import type { HiveEvent } from '../src/shared/types'

/** A bound for a hung run (the waits are for conditions). */
const HUNG_MS = 15_000

const now = (status: FreshNow['status'], o: Partial<FreshNow> = {}): FreshNow => ({ status, pending: false, backgroundTasks: 0, ...o })

describe('who starts fresh (freshWhy)', () => {
  it('idle (ready, finished) with nothing pending and no work in flight starts fresh; everything else says why not', () => {
    expect(freshWhy(now('ready'), null)).toBeNull()
    expect(freshWhy(now('finished'), null)).toBeNull()
    expect(freshWhy(null, null)).toBe('stopped')
    expect(freshWhy(now('working'), null)).toBe('working')
    expect(freshWhy(now('starting'), null)).toBe('starting')
    expect(freshWhy(now('waiting'), null)).toBe('waiting')
    expect(freshWhy(now('signin'), null)).toBe('waiting')
    expect(freshWhy(now('watching'), null)).toBe('watching')
    expect(freshWhy(now('background'), null)).toBe('background')
    expect(freshWhy(now('ready', { backgroundTasks: 2 }), null)).toBe('background')
    expect(freshWhy(now('ready', { pending: true }), null)).toBe('pending')
    // A slot's lease whose card or lane is still in flight (#1434): its work isn't finished.
    expect(freshWhy(now('finished'), { card: 12, lane: null })).toBe('lease')
    expect(freshWhy(now('finished'), { card: null, lane: 'lane-1' })).toBe('lease')
  })

  it("a project's work has finished: no agent busy, no card in Review or Passed", () => {
    expect(workFinished([now('ready'), null, now('finished')], 0)).toBe(true)
    expect(workFinished([now('ready'), now('working')], 0)).toBe(false)
    expect(workFinished([now('watching')], 0)).toBe(false)
    expect(workFinished([now('finished', { backgroundTasks: 1 })], 0)).toBe(false)
    expect(workFinished([now('ready')], 1)).toBe(false)
  })
})

describe('Start Fresh and the nudge (main/freshStarts.ts)', async () => {
  const base = tempDir('hive-freshstarts-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
  const tasks = await import('../src/main/tasks')
  const { config } = await import('../src/main/config')
  const { sessions } = await import('../src/main/sessions')
  const fresh = await import('../src/main/freshStarts')
  const { boardRead, boardWrite, boardWriteOp } = await import('../src/main/boardStore')
  const { tellListeners } = await import('../src/main/events')
  const { onBoardCommitted } = await import('../src/main/boardStore')
  const { coalescing } = await import('../src/main/coalesce')
  const lanes = await import('../src/main/lanes')
  let n = 0
  /** A workspace with project alpha (agents a1, a2, a3), its agents' states as `states` says, and the notices told. */
  const open = async (own?: 'on' | 'off') => {
    const path = join(base, `ws-${++n}`)
    const alpha = join(path, 'alpha')
    mkdirSync(join(alpha, '.hive'), { recursive: true })
    writeFileSync(join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, ...(own ? { suggestFreshStart: own } : {}), agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }, { id: 'a3', name: 'Idle' }] }))
    const w = createWorkspaceService()
    await w.open(path)
    const states = new Map<string, FreshNow | null>([
      ['a1', now('finished')],
      ['a2', now('ready')],
      ['a3', null]
    ])
    const told: { project: string; action?: string }[] = []
    Object.assign(sessions, {
      agentNow: (p: string, id: string) => (p.toLowerCase() === alpha.toLowerCase() && states.get(id) ? { runId: 'r', prompts: 0, statusMessage: null, reply: null, ...states.get(id)! } : null),
      notice: (p: string, _t: unknown, _b: unknown, action?: { command: string }) => void told.push({ project: p, ...(action ? { action: action.command } : {}) })
    })
    return { w, path, alpha, states, told }
  }

  it("Start Fresh's plan: the idle running agents start fresh, a busy one and a stopped one say why not", async () => {
    const { w, alpha, states } = await open()
    states.set('a2', now('working'))
    const plan = await inWorkspace(w, () => fresh.freshPlan(alpha))
    expect(plan.map((r) => [r.name, r.why])).toEqual([
      ['Builder', null],
      ['Reviewer', 'working'],
      ['Idle', 'stopped']
    ])
    await disposeWorkspaceService(w)
  })

  it('Start Fresh checks the agent again just before the stop: busy, or a lease taken, after the plan said idle, left as it is', async () => {
    const { w, alpha, states } = await open()
    const s = sessions as unknown as Record<string, unknown>
    const real = { startFresh: s.startFresh, endConversation: s.endConversation, start: s.start }
    const stopped: string[] = []
    let between: () => Promise<void> = async () => undefined
    Object.assign(s, {
      // The plan has said idle by now; what happens before the stop is `between`.
      startFresh: async (...a: unknown[]) => {
        await between()
        return (real.startFresh as (...x: unknown[]) => Promise<unknown>).apply(sessions, a)
      },
      endConversation: async (_p: string, id: string) => (stopped.push(id), true),
      start: async () => ({})
    })
    try {
      // Working once the plan was read: not stopped.
      between = async () => void states.set('a1', now('working'))
      expect(await inWorkspace(w, () => fresh.startFreshIfIdle(alpha, 'a1'))).toBe('working')
      // A dispatch lease taken once the plan was read (#1434: its card is in flight): not stopped.
      const project = (await w.projectConfig(alpha)).id ?? 'alpha'
      between = () =>
        boardWrite(w, async () =>
          boardWriteOp(w, (db) => {
            const at = new Date().toISOString()
            db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES (?, 'slot-a', ?, 'lent', 41000, ?, ?)").run(project, join(alpha, 'slot-a'), at, at)
            db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l1', ?, 'slot-a', 'card', 12, 'a2', ?)").run(project, at)
          })
        )
      expect(await inWorkspace(w, () => fresh.startFreshIfIdle(alpha, 'a2'))).toBe('lease')
      expect(stopped).toEqual([])
      // Still idle at the stop: stopped and started fresh.
      states.set('a1', now('finished'))
      between = async () => undefined
      expect(await inWorkspace(w, () => fresh.startFreshIfIdle(alpha, 'a1'))).toBeNull()
      expect(stopped).toEqual(['a1'])
    } finally {
      Object.assign(s, real)
      await disposeWorkspaceService(w)
    }
  })

  // The races of the nudge's lifecycle (#1437 round 3's design): one gated test each.
  const status = (alpha: string, agentId: string, st: string): void => tellListeners({ type: 'session-status', state: { projectPath: alpha, agentId, status: st } } as unknown as HiveEvent)
  const markOf = (w: Awaited<ReturnType<typeof open>>['w'], project: string) => boardRead(w, (db) => db.prepare('SELECT value FROM board_meta WHERE key = ?').get(`fresh_nudge:${project}`) as { value: string } | undefined)
  /** Waits for the reset of a project's spell (coalesced) to have run, however it ended. */
  const resetRun = (alpha: string) => vi.waitFor(() => expect(coalescing(`freshSpell:${alpha.toLowerCase()}`)).toBe(false), { timeout: HUNG_MS })

  it('race 1: two triggers, or two watchers, at once: one notice', async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    const four = await Promise.all([fresh.considerNudge(w, alpha, 'lane:l1'), fresh.considerNudge(w, alpha, 'lane:l1'), fresh.considerNudge(w, alpha, 'card:42'), fresh.considerNudge(w, alpha, 'card:43')])
    expect(four.filter(Boolean)).toHaveLength(1)
    expect(told).toEqual([{ project: alpha, action: 'session.startFreshIdle' }])
    // The same spell: not again, whatever ends next.
    expect(await fresh.considerNudge(w, alpha, 'card:7')).toBe(false)
    expect(told).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  for (const trigger of ['lane:l6', 'card:61'])
    it(`race 2 (${trigger.split(':')[0]}): the agent goes quiet just after the check found it working, before the check returns: told once`, async () => {
      fresh.resetFreshNudgesForTests()
      fresh.startFreshNudges()
      const { w, alpha, states, told } = await open()
      states.set('a1', now('working'))
      // Once the check's write (unfinished) has committed, and before considerNudge carries on: a1's turn ends.
      let gated = false
      const off = onBoardCommitted((ws) => {
        if (ws !== w || gated) return
        gated = true
        states.set('a1', now('finished'))
        status(alpha, 'a1', 'finished')
      })
      try {
        expect(await fresh.considerNudge(w, alpha, trigger)).toBe(false)
        expect(gated).toBe(true)
        await vi.waitFor(() => expect(told).toHaveLength(1), { timeout: HUNG_MS })
        // Once: going quiet again tells nothing more.
        status(alpha, 'a2', 'finished')
        expect(await fresh.considerNudge(w, alpha, trigger)).toBe(false)
        expect(told).toHaveLength(1)
      } finally {
        off()
        await disposeWorkspaceService(w)
      }
    })

  it("race 3: a restart in the spell (this Hive's memory gone, the mark on the board): no repeat until an agent is busy", async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    expect(await fresh.considerNudge(w, alpha, 'lane:l3')).toBe(true)
    fresh.resetFreshNudgesForTests()
    expect(await fresh.considerNudge(w, alpha, 'card:8')).toBe(false)
    expect(told).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('race 4: another Hive marks the spell after this one saw none: its next busy moment ends it, and the next completion is told', async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    const project = 'alpha'
    // Busy here with no mark: nothing to remove.
    status(alpha, 'a1', 'working')
    await resetRun(alpha)
    // The other Hive tells it (its own write on the board).
    await boardWrite(w, async () => boardWriteOp(w, (db) => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(`fresh_nudge:${project}`, JSON.stringify({ trigger: 'lane:other' }))))
    expect(await fresh.considerNudge(w, alpha, 'card:1')).toBe(false)
    // Busy here again: that spell ends; the next completion is told here.
    status(alpha, 'a1', 'working')
    await vi.waitFor(() => expect(markOf(w, project)).toBeUndefined(), { timeout: HUNG_MS })
    expect(await fresh.considerNudge(w, alpha, 'card:2')).toBe(true)
    expect(told).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('race 5: new work in the spell: an agent busy ends it (the next completion told); a lane started while a completion waits drops it, and its end is told', async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00.000Z'))
    const { w, alpha, states, told } = await open()
    try {
      const project = 'alpha'
      expect(await fresh.considerNudge(w, alpha, 'card:50')).toBe(true)
      // Busy (the same millisecond): the mark goes; the next completion is told.
      status(alpha, 'a1', 'working')
      await vi.waitFor(() => expect(markOf(w, project)).toBeUndefined(), { timeout: HUNG_MS })
      expect(await fresh.considerNudge(w, alpha, 'card:51')).toBe(true)
      expect(told).toHaveLength(2)
      // A completion while a1 works; then a lane starts: as a1 goes quiet, the completion is dropped, not told.
      status(alpha, 'a1', 'working')
      await resetRun(alpha)
      states.set('a1', now('working'))
      expect(await fresh.considerNudge(w, alpha, 'card:52')).toBe(false)
      const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Lane work', project: 'alpha', agent: 'a1', column: 'doing' }, { kind: 'user' }))).number
      const laneId = (await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'a2', cards: [card], by: 'Builder (alpha)' })).lane.id
      states.set('a1', now('finished'))
      status(alpha, 'a1', 'finished')
      await vi.waitFor(() => expect(coalescing(`freshPending:${alpha.toLowerCase()}`)).toBe(false), { timeout: HUNG_MS })
      // Dropped: quiet again, still nothing.
      status(alpha, 'a2', 'finished')
      expect(coalescing(`freshPending:${alpha.toLowerCase()}`)).toBe(false)
      expect(told).toHaveLength(2)
      // The lane's end is told.
      await lanes.endLane(w, laneId, {})
      expect(await fresh.considerNudge(w, alpha, `lane:${laneId}`)).toBe(true)
      expect(told).toHaveLength(3)
    } finally {
      clock.mockRestore()
      await disposeWorkspaceService(w)
    }
  })

  /** Holds each spell reset (once it has its duty) until released: what a reset late for its busy moment does. */
  const holdResets = (svc: typeof fresh) => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached = false
    svc.gateSpellResetsForTests(async () => {
      reached = true
      await held
    })
    return {
      reached: () => reached,
      release: () => {
        svc.gateSpellResetsForTests(null)
        release()
      }
    }
  }
  /** An SQLite trigger refusing changes to the spell marks (`op`: DELETE or INSERT), as a failed write; returns its removal. */
  const refuse = async (w: Awaited<ReturnType<typeof open>>['w'], op: 'DELETE' | 'INSERT') => {
    await boardWrite(w, async () => boardWriteOp(w, (db) => void db.exec(`CREATE TRIGGER refuse_${op} BEFORE ${op} ON board_meta WHEN ${op === 'DELETE' ? 'old' : 'new'}.key LIKE 'fresh_nudge:%' BEGIN SELECT RAISE(ABORT, 'refused'); END`)))
    return () => boardWrite(w, async () => boardWriteOp(w, (db) => void db.exec(`DROP TRIGGER refuse_${op}`)))
  }
  /** A second, independent copy of the service (its own pending completions and duties), on the same board and sessions: another Hive. */
  // @ts-expect-error: the same module, loaded again as another instance
  const other: typeof fresh = await import('../src/main/freshStarts?watcher=b')

  it('race 6: another Hive (its own state) replaces the mark while this one is late to end it: its mark stays, told once each', async () => {
    fresh.resetFreshNudgesForTests()
    other.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    try {
      // No mark at this Hive's busy moment: no duty; the other Hive's mark, made after, stays.
      status(alpha, 'a1', 'working')
      await resetRun(alpha)
      expect(await other.considerNudge(w, alpha, 'card:b1')).toBe(true)
      const y1 = markOf(w, 'alpha')!.value
      expect(await fresh.considerNudge(w, alpha, 'card:a1')).toBe(false)
      expect(markOf(w, 'alpha')!.value).toBe(y1)
      expect(told).toHaveLength(1)
      // Mark X here; a busy moment here, its reset held. The other Hive's own busy moment, then its claim: X replaced by Y.
      other.agentBusy(alpha)
      await vi.waitFor(() => expect(markOf(w, 'alpha')).toBeUndefined(), { timeout: HUNG_MS })
      expect(await fresh.considerNudge(w, alpha, 'card:a2')).toBe(true)
      const x = markOf(w, 'alpha')!.value
      const held = holdResets(fresh)
      status(alpha, 'a1', 'working')
      expect(held.reached()).toBe(true)
      // (its duty is X; its claim removes X and makes Y. Its own reset would too, but in this test the two copies share
      // one coalescing key, so it waits behind this Hive's held one.)
      other.agentBusy(alpha)
      expect(await other.considerNudge(w, alpha, 'card:b2')).toBe(true)
      const y = markOf(w, 'alpha')!.value
      expect(y).not.toBe(x)
      expect(told).toHaveLength(3)
      // This Hive's late reset: X is gone, Y stays; this Hive's next completion is in Y's spell.
      held.release()
      await resetRun(alpha)
      expect(markOf(w, 'alpha')!.value).toBe(y)
      expect(await fresh.considerNudge(w, alpha, 'card:a3')).toBe(false)
      expect(told).toHaveLength(3)
    } finally {
      fresh.gateSpellResetsForTests(null)
      await disposeWorkspaceService(w)
    }
  })

  it('race 7: a reset whose write fails keeps its duty: the next completion ends that spell and is told', async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    try {
      expect(await fresh.considerNudge(w, alpha, 'card:70')).toBe(true)
      const x = markOf(w, 'alpha')!.value
      const allow = await refuse(w, 'DELETE')
      status(alpha, 'a1', 'working')
      await resetRun(alpha)
      // Rolled back: X is still there.
      expect(markOf(w, 'alpha')!.value).toBe(x)
      await allow()
      // The duty was kept: the next completion removes X and is told.
      expect(await fresh.considerNudge(w, alpha, 'card:71')).toBe(true)
      expect(markOf(w, 'alpha')!.value).not.toBe(x)
      expect(told).toHaveLength(2)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it("race 8: a claim that fails while it ends a spell keeps the duty: nothing told, X stays; then the reset ends it and the next is told once", async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const { w, alpha, told } = await open()
    try {
      expect(await fresh.considerNudge(w, alpha, 'card:80')).toBe(true)
      const x = markOf(w, 'alpha')!.value
      const held = holdResets(fresh)
      status(alpha, 'a1', 'working')
      expect(held.reached()).toBe(true)
      const allow = await refuse(w, 'INSERT')
      expect(await fresh.considerNudge(w, alpha, 'card:81')).toBe(false)
      expect(markOf(w, 'alpha')!.value).toBe(x)
      expect(told).toHaveLength(1)
      await allow()
      held.release()
      await vi.waitFor(() => expect(markOf(w, 'alpha')).toBeUndefined(), { timeout: HUNG_MS })
      expect(await fresh.considerNudge(w, alpha, 'card:82')).toBe(true)
      expect(await fresh.considerNudge(w, alpha, 'card:83')).toBe(false)
      expect(told).toHaveLength(2)
    } finally {
      fresh.gateSpellResetsForTests(null)
      await disposeWorkspaceService(w)
    }
  })

  it('race 9 (the clock frozen): overlapping busy moments: a late reset for X leaves Y, and the newer duty for Y still ends its spell', async () => {
    fresh.resetFreshNudgesForTests()
    fresh.startFreshNudges()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00.000Z'))
    const { w, alpha, told } = await open()
    try {
      expect(await fresh.considerNudge(w, alpha, 'card:90')).toBe(true)
      const held = holdResets(fresh)
      status(alpha, 'a1', 'working')
      expect(held.reached()).toBe(true)
      // The claim ends X's spell itself and tells Y.
      expect(await fresh.considerNudge(w, alpha, 'card:91')).toBe(true)
      const y = markOf(w, 'alpha')!.value
      // Busy again (duty Y); the held reset for X goes on: Y isn't removed for X …
      status(alpha, 'a2', 'working')
      held.release()
      // … but for its own busy moment it is, by the run after it.
      await vi.waitFor(() => expect(markOf(w, 'alpha')).toBeUndefined(), { timeout: HUNG_MS })
      expect(y).toBeTruthy()
      expect(await fresh.considerNudge(w, alpha, 'card:92')).toBe(true)
      expect(await fresh.considerNudge(w, alpha, 'card:93')).toBe(false)
      expect(told).toHaveLength(3)
    } finally {
      fresh.gateSpellResetsForTests(null)
      clock.mockRestore()
      await disposeWorkspaceService(w)
    }
  })

  it("no nudge while the work isn't finished: an agent busy, or a card in Review", async () => {
    fresh.resetFreshNudgesForTests()
    const { w, alpha, states, told } = await open()
    states.set('a2', now('waiting'))
    expect(await fresh.considerNudge(w, alpha, 'lane:l2')).toBe(false)
    states.set('a2', now('ready'))
    await inWorkspace(w, () => tasks.createTask({ title: 'Waits', project: 'alpha', agent: 'a1', column: 'review' }, { kind: 'user' }))
    expect(await fresh.considerNudge(w, alpha, 'lane:l2')).toBe(false)
    expect(told).toEqual([])
    await disposeWorkspaceService(w)
  })

  it("the switch: Settings → Notifications off, none; a project's own on over it, told; a project's own off, none", async () => {
    fresh.resetFreshNudgesForTests()
    const was = config.settings.notifications.suggestFreshStart
    try {
      config.settings.notifications.suggestFreshStart = false
      const off = await open()
      expect(await fresh.considerNudge(off.w, off.alpha, 'lane:l3')).toBe(false)
      await disposeWorkspaceService(off.w)
      const own = await open('on')
      expect(await fresh.considerNudge(own.w, own.alpha, 'lane:l3')).toBe(true)
      await disposeWorkspaceService(own.w)
      config.settings.notifications.suggestFreshStart = true
      const ownOff = await open('off')
      expect(await fresh.considerNudge(ownOff.w, ownOff.alpha, 'lane:l4')).toBe(false)
      expect(ownOff.told).toEqual([])
      await disposeWorkspaceService(ownOff.w)
    } finally {
      config.settings.notifications.suggestFreshStart = was
    }
  })
})
