// Fresh starts at natural breaks (#1437; shared/freshStarts.ts and main/freshStarts.ts): who Start Fresh (Idle Agents)
// starts fresh and why not; whether a project's work has finished; the nudge once per quiet spell (two watchers, or two
// windows, at once: one notice), only when the work has finished (a card in Review: none), and the switch, Settings'
// and a project's own. Real workspace and board; the agents' sessions are stand-ins.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { freshWhy, workFinished, type FreshNow } from '../src/shared/freshStarts'

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
    // Checked again as it starts: busy since, left as it is (nothing stopped or started).
    states.set('a1', now('working'))
    expect(await inWorkspace(w, () => fresh.startFreshIfIdle(alpha, 'a1'))).toBe('working')
    await disposeWorkspaceService(w)
  })

  it('the nudge once per quiet spell, even from two watchers at once; again only after an agent was busy, for a new trigger', async () => {
    fresh.resetFreshNudgesForTests()
    const { w, alpha, told } = await open()
    const both = await Promise.all([fresh.considerNudge(w, alpha, 'lane:l1'), fresh.considerNudge(w, alpha, 'lane:l1')])
    expect(both.filter(Boolean)).toHaveLength(1)
    expect(told).toEqual([{ project: alpha, action: 'session.startFreshIdle' }])
    // The same spell: not again, whatever ends next.
    expect(await fresh.considerNudge(w, alpha, 'card:7')).toBe(false)
    // Another window or Hive (its own spell memory) for the same trigger: the board says it was told.
    fresh.resetFreshNudgesForTests()
    expect(await fresh.considerNudge(w, alpha, 'lane:l1')).toBe(false)
    // After an agent was busy (this Hive forgets the spell), a new trigger is told.
    expect(await fresh.considerNudge(w, alpha, 'card:8')).toBe(true)
    expect(told).toHaveLength(2)
    await disposeWorkspaceService(w)
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
