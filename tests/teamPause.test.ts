// Pausing the team before an update (HI-2081, SPEC §16.10.9): a workspace's pause saved before it holds anything (a
// failed save holds and tells nothing), each running agent told once a pause, the user's pause holding a workspace opened
// while it lasts, the update's restart lifting only the pause its close named (HR1's s10 check: a crash, a plain quit or
// an older record keeps it); and a paused workspace's running lanes paused, so none is due a start.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { laneStartDue, laneView, type LaneRecord } from '../src/shared/lanes'
import { TEAM_PAUSE_LINE } from '../src/shared/teamPause'
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

const base = tempDir('hive-teampause-')
let n = 0
/** A workspace with a project of two agents (alpha: B1, R1), as the pause reads it. */
function workspace(): { path: string; info: () => unknown } {
  const path = join(base, `ws-${++n}`)
  mkdirSync(join(path, '.hive'), { recursive: true })
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
  it('is saved before it holds: then each running agent is told once, with its id', async () => {
    profile()
    const w = workspace()
    state.open = [w]
    state.live.add(`${join(w.path, 'alpha')}#b1`)
    const p = await tp.pauseTeam(ws(w), 'user')
    expect(existsSync(join(w.path, '.hive', 'team-pause.json'))).toBe(true)
    expect(tp.teamPauseOf(ws(w))).toEqual(p)
    expect(tp.pausedFor(join(w.path, 'alpha'))).toEqual(p)
    expect(state.told).toEqual([expect.objectContaining({ agentId: 'b1', source: 'team-pause', ref: p.pauseId, body: TEAM_PAUSE_LINE })])
    expect(state.events.at(-1)).toMatchObject({ type: 'team-pause-changed', pause: p })
    // Paused again with the same id (the user's pause reaching it twice): nothing more told.
    await tp.pauseTeam(ws(w), 'user', p.pauseId)
    expect(state.told).toHaveLength(1)
  })

  it("whose save fails holds nothing and tells no one (HR1's s10 condition)", async () => {
    profile()
    const w = workspace()
    state.open = [w]
    state.live.add(`${join(w.path, 'alpha')}#b1`)
    // The pause's file can't be written: a folder stands in its place.
    mkdirSync(join(w.path, '.hive', 'team-pause.json'))
    await expect(tp.pauseTeam(ws(w), 'user')).rejects.toThrow()
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    expect(state.told).toEqual([])
    // The user's pause of every workspace names it, and the app isn't parked while it isn't paused.
    const r = await tp.pauseApp()
    expect(r.failed.map((f) => f.workspacePath)).toEqual([w.path])
  })

  it('resumed, its file goes and the change says what it was (for the held deliveries to move on)', async () => {
    profile()
    const w = workspace()
    state.open = [w]
    const p = await tp.pauseTeam(ws(w), 'assistant')
    expect(await tp.resumeTeam(ws(w))).toBe(true)
    expect(existsSync(join(w.path, '.hive', 'team-pause.json'))).toBe(false)
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    expect(state.events.at(-1)).toMatchObject({ type: 'team-pause-changed', pause: null, was: p })
    expect(tp.resumedAt(join(w.path, 'alpha'))).toBeGreaterThan(0)
    expect(await tp.resumeTeam(ws(w))).toBe(false)
  })

  it("the user's pause holds a workspace opened while it lasts; the user's resume lifts every one", async () => {
    profile()
    const a = workspace()
    state.open = [a]
    const r = await tp.pauseApp()
    expect(r.done).toEqual([a.path])
    // Opened later: held by the same pause at once.
    const b = workspace()
    state.open = [a, b]
    expect(tp.teamPauseOf(ws(b))?.pauseId).toBe(r.pause!.pauseId)
    await vi.waitFor(() => expect(existsSync(join(b.path, '.hive', 'team-pause.json'))).toBe(true), { timeout: 10_000 })
    const back = await tp.resumeApp()
    expect(back.done.sort()).toEqual([a.path, b.path].sort())
    expect(tp.teamPauseOf(ws(a))).toBeNull()
    expect(tp.teamPauseOf(ws(b))).toBeNull()
    expect(tp.appPause()).toBeNull()
  })
})

describe("the update's restart lifts only the pause its close named (HR1's s10 check)", () => {
  /** Pauses a workspace, closes with `reason`, then starts again: its pause as the next start reads it. */
  async function afterClose(reason: string | null, change?: (w: { path: string }) => Promise<void>): Promise<unknown> {
    profile()
    const w = workspace()
    state.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    if (reason) await tp.recordPauseClosing(reason)
    await change?.(w)
    // The next start: nothing kept in memory, the closing record read once.
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    return tp.teamPauseOf(ws(w))
  }

  it('an install or an update that closed under this pause: lifted', async () => {
    expect(await afterClose('install')).toBeNull()
    expect(await afterClose('update')).toBeNull()
  })

  it('a plain quit, a crash (no record), or a record naming an earlier pause: kept', async () => {
    expect(await afterClose('quit')).not.toBeNull()
    expect(await afterClose(null)).not.toBeNull()
    // Closed for an install under one pause; resumed and paused again (another id) before a crash.
    const kept = await afterClose('install', async (w) => {
      await tp.resumeTeam(ws(w))
      await tp.pauseTeam(ws(w), 'user')
    })
    expect(kept).not.toBeNull()
  })

  it('the record is read once: a later start keeps a newer pause', async () => {
    profile()
    const w = workspace()
    state.open = [w]
    await tp.pauseTeam(ws(w), 'user')
    await tp.recordPauseClosing('install')
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    // Paused again, then a crash: the next start finds no record (removed as it was read).
    await tp.pauseTeam(ws(w), 'user')
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(w))).not.toBeNull()
  })
})

describe("the user's pause after a restart (HI-2156)", () => {
  const appFile = (): string => join(state.profile, 'team-pause.json')
  const setVersion = (v: string) => ((electron.app as unknown as { getVersion: () => string }).getVersion = () => v)
  afterEach(() => setVersion('0.0.0-test'))

  /** The user's pause of one workspace saved by `version` (none: before versions were recorded), then a start in this one. */
  async function savedAppPause(version?: string): Promise<{ w: { path: string; info: () => unknown }; pauseId: string }> {
    profile()
    const w = workspace()
    state.open = [w]
    if (version) setVersion(version)
    const r = await tp.pauseApp()
    if (!version) {
      // As one saved before versions were recorded: the profile's pause alone, the workspace's file gone.
      writeFileSync(appFile(), JSON.stringify({ pauseId: r.pause!.pauseId, since: r.pause!.since, by: 'user' }))
      rmSync(join(w.path, '.hive', 'team-pause.json'))
    }
    setVersion('0.0.0-test')
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    return { w, pauseId: r.pause!.pauseId }
  }

  it('one saved without a version, its workspace resumed earlier: status and lane starts both see it, and resume lifts it for good', async () => {
    const { w, pauseId } = await savedAppPause()
    // Held, as lane starts see it, and the window's state says the same.
    expect(tp.teamPauseOf(ws(w))?.pauseId).toBe(pauseId)
    expect(() => refuseWhileTeamPaused(ws(w))).toThrow(/team is paused/)
    const scan = await scanWorkspace(ws(w))
    expect(scan.pause?.pauseId).toBe(pauseId)
    // The Assistant's resume (its own workspace): lifted, the profile's pause with it (no other workspace held).
    expect(await tp.resumeTeam(ws(w))).toBe(true)
    expect(() => refuseWhileTeamPaused(ws(w))).not.toThrow()
    expect(existsSync(appFile())).toBe(false)
    // The next start doesn't take it up again.
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(w))).toBeNull()
  })

  it('resumed on its own while another workspace is held: the user\'s pause stays for that one, not for this one after a restart', async () => {
    profile()
    const a = workspace()
    const b = workspace()
    state.open = [a, b]
    const r = await tp.pauseApp()
    expect(await tp.resumeTeam(ws(a))).toBe(true)
    expect(tp.teamPauseOf(ws(b))?.pauseId).toBe(r.pause!.pauseId)
    expect(existsSync(appFile())).toBe(true)
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(a))).toBeNull()
    expect(tp.teamPauseOf(ws(b))?.pauseId).toBe(r.pause!.pauseId)
    // b resumed too: the profile's pause goes with the last workspace it held.
    expect(await tp.resumeTeam(ws(b))).toBe(true)
    expect(existsSync(appFile())).toBe(false)
  })

  it("resumed at once in several workspaces (HR1's round 1 finding): none is held again after a restart, and the last one held takes the user's pause with it", async () => {
    profile()
    const [a, b, c] = [workspace(), workspace(), workspace()]
    state.open = [a, b, c]
    const r = await tp.pauseApp()
    expect(await Promise.all([tp.resumeTeam(ws(a)), tp.resumeTeam(ws(b))])).toEqual([true, true])
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(a))).toBeNull()
    expect(tp.teamPauseOf(ws(b))).toBeNull()
    expect(tp.teamPauseOf(ws(c))?.pauseId).toBe(r.pause!.pauseId)
    // Every workspace resumed at once: the user's pause is gone.
    profile()
    const [d, e] = [workspace(), workspace()]
    state.open = [d, e]
    await tp.pauseApp()
    expect(await Promise.all([tp.resumeTeam(ws(d)), tp.resumeTeam(ws(e))])).toEqual([true, true])
    expect(existsSync(appFile())).toBe(false)
    tp.resetTeamPauseForTests()
    tp.loadPauseClosing()
    expect(tp.teamPauseOf(ws(d))).toBeNull()
    expect(tp.teamPauseOf(ws(e))).toBeNull()
  })

  it('one saved by another version (its update installed, however Hive closed): lifted at start; by this version: kept', async () => {
    const { w } = await savedAppPause('0.0.0-older')
    expect(tp.teamPauseOf(ws(w))).toBeNull()
    expect(tp.appPause()).toBeNull()
    await vi.waitFor(() => expect(existsSync(join(w.path, '.hive', 'team-pause.json'))).toBe(false), { timeout: 10_000 })
    const same = await savedAppPause('0.0.0-test')
    expect(tp.teamPauseOf(ws(same.w))?.pauseId).toBe(same.pauseId)
    expect(tp.appPause()?.pauseId).toBe(same.pauseId)
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
