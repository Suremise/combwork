// Pausing the team before an update (HI-2081, SPEC §16.10.9): each running agent told once a pause, the user's pause
// holding a workspace opened while it lasts, kept for the running Combwork only (HI-2156: a start is unpaused and removes
// what earlier builds saved), one answer for status, resume and lane starts; and a paused workspace's running lanes
// paused, so none is due a start.
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { laneStartDue, laneView, type LaneRecord } from '../src/shared/lanes'
import { teamPauseLine } from '../src/shared/teamPause'
import type { TaskCard } from '../src/shared/types'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const state = vi.hoisted(() => ({
  profile: '',
  open: [] as { path: string; info: () => unknown }[],
  live: new Set<string>(),
  told: [] as { host: string; agentId: string; source?: string; ref?: string; body: string }[],
  events: [] as { type: string; pause: unknown; was?: unknown }[]
}))

vi.mock('../src/main/workspace', async (orig) => ({
  ...(await orig<object>()),
  openWorkspaces: () => state.open,
  workspaceFor: (p: string) => state.open.find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())) ?? null,
  inWorkspace: (_w: unknown, fn: () => unknown) => fn()
}))
vi.mock('../src/main/sessions', async (orig) => ({ ...(await orig<object>()), sessions: { liveFor: (p: string, a: string) => (state.live.has(`${p}#${a}`) ? { status: 'ready' } : null) } }))
vi.mock('../src/main/events', async (orig) => ({ ...(await orig<object>()), emit: (e: { type: string; pause: unknown; was?: unknown }) => void state.events.push(e) }))
vi.mock('../src/main/deliveries', async (orig) => ({ ...(await orig<object>()), createDelivery: async (host: string, nd: { agentId: string; source?: string; ref?: string; body: string }) => void state.told.push({ host, ...nd }) }))

;(electron.app as unknown as { getPath: () => string }).getPath = () => state.profile

const tp = await import('../src/main/teamPause')
const { refuseWhileTeamPaused } = await import('../src/main/lanes')
const { scanWorkspace } = await import('../src/main/teamParked')

const base = tempDir('cw-teampause-')
let n = 0
/** A workspace with a project of two agents (alpha: B1, R1), as the pause reads it. */
function workspace(): { path: string; info: () => unknown } {
  const path = join(base, `ws-${++n}`)
  mkdirSync(join(path, '.combwork'), { recursive: true })
  const alpha = join(path, 'alpha')
  return { path, info: () => ({ projects: [{ name: 'alpha', path: alpha, config: { agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] } }] }) }
}
const ws = (w: { path: string }) => w as never

afterEach(() => {
  tp.resetTeamPauseForTests()
  Object.assign(state, { open: [], live: new Set(), told: [], events: [] })
})
const profile = (): string => {
  state.profile = join(base, `profile-${++n}`)
  mkdirSync(state.profile, { recursive: true })
  return state.profile
}

describe("a workspace's pause (HI-2081)", () => {
  it('holds at once: then each running agent is told once, with its id', async () => {
    profile()
    const w = workspace()
    state.open = [w]
    state.live.add(`${join(w.path, 'alpha')}#b1`)
    const p = await tp.pauseTeam(ws(w), 'user')
    expect(tp.teamPauseOf(ws(w))).toEqual(p)
    expect(tp.pausedFor(join(w.path, 'alpha'))).toEqual(p)
    expect(state.told).toEqual([expect.objectContaining({ agentId: 'b1', source: 'team-pause', ref: p.pauseId, body: teamPauseLine() })])
    expect(state.events.at(-1)).toMatchObject({ type: 'team-pause-changed', pause: p })
    // Paused again with the same id (the user's pause reaching it twice): nothing more told.
    await tp.pauseTeam(ws(w), 'user', p.pauseId)
    expect(state.told).toHaveLength(1)
  })

  it('resumed, the change says what it was (for the held deliveries to move on)', async () => {
    profile()
    const w = workspace()
    state.open = [w]
    const p = await tp.pauseTeam(ws(w), 'assistant')
    expect(await tp.resumeTeam(ws(w))).toBe(true)
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    expect(state.events.at(-1)).toMatchObject({ type: 'team-pause-changed', pause: null, was: p })
    expect(tp.resumedAt(join(w.path, 'alpha'))).toBeGreaterThan(0)
    expect(await tp.resumeTeam(ws(w))).toBe(false)
  })

  it("the user's pause holds a workspace opened while it lasts, the window told; the user's resume lifts every one", async () => {
    profile()
    const a = workspace()
    state.open = [a]
    const r = await tp.pauseApp()
    expect(r.done).toEqual([a.path])
    // Opened later: held by the same pause at once.
    const b = workspace()
    state.open = [a, b]
    expect(tp.teamPauseOf(ws(b))?.pauseId).toBe(r.pause!.pauseId)
    expect(state.events.at(-1)).toMatchObject({ type: 'team-pause-changed', workspacePath: b.path, pause: r.pause })
    const back = await tp.resumeApp()
    expect(back.done.sort()).toEqual([a.path, b.path].sort())
    expect(tp.teamPauseOf(ws(a))).toBeNull()
    expect(tp.teamPauseOf(ws(b))).toBeNull()
    expect(tp.appPause()).toBeNull()
  })
})

describe('one answer, for this running Combwork only (HI-2156)', () => {
  it('a start with pauses an earlier build saved: unpaused, and their files removed', async () => {
    const dir = profile()
    const w = workspace()
    state.open = [w]
    const old = JSON.stringify({ pauseId: 'p-old', since: '2026-10-30T15:05:44.452Z', by: 'user' })
    writeFileSync(join(dir, 'team-pause.json'), old)
    writeFileSync(join(dir, 'team-pause-closing.json'), JSON.stringify({ reason: 'quit', at: '', pauses: [] }))
    writeFileSync(join(w.path, '.combwork', 'team-pause.json'), old)
    tp.clearSavedPauses()
    expect(tp.appPause()).toBeNull()
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    expect(() => refuseWhileTeamPaused(ws(w))).not.toThrow()
    expect((await scanWorkspace(ws(w))).pause).toBeNull()
    await vi.waitFor(() => expect([join(dir, 'team-pause.json'), join(dir, 'team-pause-closing.json'), join(w.path, '.combwork', 'team-pause.json')].filter((f) => existsSync(f))).toEqual([]), { timeout: 10_000 })
  })

  it("the user's pause: status and lane starts agree; the Assistant's resume lifts it in its workspace, and it ends with the last workspace it held", async () => {
    profile()
    const [a, b] = [workspace(), workspace()]
    state.open = [a, b]
    const r = await tp.pauseApp()
    for (const w of [a, b]) {
      expect((await scanWorkspace(ws(w))).pause?.pauseId).toBe(r.pause!.pauseId)
      expect(() => refuseWhileTeamPaused(ws(w))).toThrow(/team is paused/)
    }
    expect(await tp.resumeTeam(ws(a))).toBe(true)
    expect((await scanWorkspace(ws(a))).pause).toBeNull()
    expect(() => refuseWhileTeamPaused(ws(a))).not.toThrow()
    // Still held by it elsewhere; a isn't taken up by it again.
    expect(tp.appPause()?.pauseId).toBe(r.pause!.pauseId)
    expect(tp.teamPauseOf(ws(a))).toBeNull()
    expect(() => refuseWhileTeamPaused(ws(b))).toThrow(/team is paused/)
    expect(await tp.resumeTeam(ws(b))).toBe(true)
    expect(tp.appPause()).toBeNull()
    // A workspace opened now isn't held.
    const c = workspace()
    state.open = [a, b, c]
    expect(tp.teamPauseOf(ws(c))).toBeNull()
  })

  it("resumed at once in several workspaces: each stays resumed, and the user's pause ends with the last", async () => {
    profile()
    const [a, b, c] = [workspace(), workspace(), workspace()]
    state.open = [a, b, c]
    const r = await tp.pauseApp()
    expect(await Promise.all([tp.resumeTeam(ws(a)), tp.resumeTeam(ws(b))])).toEqual([true, true])
    expect([tp.teamPauseOf(ws(a)), tp.teamPauseOf(ws(b))]).toEqual([null, null])
    expect(tp.teamPauseOf(ws(c))?.pauseId).toBe(r.pause!.pauseId)
    expect(await tp.resumeTeam(ws(c))).toBe(true)
    expect(tp.appPause()).toBeNull()
    // Pause the Team again holds every one.
    const again = await tp.pauseApp()
    for (const w of [a, b, c]) expect(tp.teamPauseOf(ws(w))?.pauseId).toBe(again.pause!.pauseId)
  })

  it("the Assistant's own pause, then a restart: the next start is unpaused", async () => {
    profile()
    const w = workspace()
    state.open = [w]
    await tp.pauseTeam(ws(w), 'assistant')
    tp.resetTeamPauseForTests()
    tp.clearSavedPauses()
    expect(tp.teamPauseOf(ws(w))).toBeNull()
  })
})

describe("a paused workspace's lanes (HI-2081)", () => {
  const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({ id: 'lane-1', project: 'alpha', name: null, builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 10, waitMinutes: 360, state: 'active', startedBy: 'B1 (alpha)', startedAt: '', updatedAt: '', endedAt: null, mergeCommit: null, ...over })
  const card = (number: number, column: TaskCard['column']): TaskCard => ({ number, title: `Card ${number}`, column, project: 'alpha', blocked: null, history: [], comments: [], archived: false }) as unknown as TaskCard

  it('paused, saying the team is pausing: no card is due to start; resumed, its next one is', () => {
    const cards = new Map([[1, card(1, 'done')], [2, card(2, 'todo')]])
    const held = laneView(rec(), cards, undefined, null, undefined, null, undefined, null, null, null, undefined, null, true)
    expect(held).toMatchObject({ state: 'paused', status: { reason: 'teamPause' } })
    expect(laneStartDue(held)).toBeNull()
    const back = laneView(rec(), cards)
    expect(back.state).toBe('active')
    expect(laneStartDue(back)?.number).toBe(2)
  })
})
