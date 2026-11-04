// No line of Hive's before a launch's hive tools have connected (#865): a resumed Claude Code is ready at its SessionStart
// before its hive MCP server has connected, and a doorbell typed then is a turn that can't call cw_inbox. The server
// says when the CLI has connected it (POST /v1/launch/connected → sessions.hiveToolsConnected); until then, at most
// hive.mcp.connectSeconds (30 s) from when the launch first became ready, the line writer and the watch wakes wait. The
// real SessionManager with hand-made live states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whyNoLine } from '../src/main/lineWriter'
import { advanced } from '../src/main/advanced'
import { sessions } from '../src/main/sessions'
import { tempDir } from './tempDir'

const project = 'C:/fake-ws/alpha'
const id = 'b1'
type Entry = { state: Record<string, unknown> & { runId: string; status: string }; prompts: number; hiveTools?: 'connecting' | 'connected'; readyAt?: number }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const key = `${project.toLowerCase()}#${id}`
const emit = (e: Entry) => (sessions as unknown as { emitState(s: unknown): void }).emitState(e.state)

/** A launch as its CLI reports it (`status`), given Hive's tools unless `tools` is false; sent through emitState. */
function launched(status = 'ready', tools = true): Entry {
  const e: Entry = {
    state: { runId: 'run1', status, statusSince: new Date().toISOString(), projectPath: project, agentId: id, agentName: 'B1', runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }, turn: { state: 'over' } },
    prompts: 0,
    ...(tools ? { hiveTools: 'connecting' as const } : {})
  }
  Object.assign(e, { adapter: { descriptor: { capabilities: { startupSizeRefresh: false } } } })
  live.set(key, e)
  emit(e)
  return e
}

describe("no line of Hive's before a launch's hive tools have connected (#865)", () => {
  const watched = { current: false }
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    watched.current = false
    spy = vi.spyOn(sessions, 'watchFor').mockImplementation(() => (watched.current ? ({ label: 'Waiting for #1', cards: [1] } as unknown as ReturnType<typeof sessions.watchFor>) : null))
  })
  afterEach(() => {
    live.delete(key)
    spy.mockRestore()
    vi.useRealTimers()
  })

  it('ready before they have connected: no line, and the reply says why', () => {
    launched()
    expect(sessions.hiveToolsWaiting(project, id)).toBe(true)
    expect(whyNoLine(project, id)).toBe("its Combwork tools haven't connected yet")
  })

  it('a watch that outlived its last launch (watching) waits too', () => {
    watched.current = true
    const e = launched()
    expect(e.state.status).toBe('watching')
    expect(whyNoLine(project, id)).toBe("its Combwork tools haven't connected yet")
  })

  it('once its server says the CLI has connected them, lines go to it', () => {
    launched()
    expect(sessions.hiveToolsConnected(project, id, 'run1')).toBe(true)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(false)
    expect(whyNoLine(project, id)).toBeNull()
  })

  it("an earlier launch's server saying so changes nothing for this one", () => {
    launched()
    expect(sessions.hiveToolsConnected(project, id, 'run0')).toBe(false)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(true)
  })

  it('connected before it became ready (a fresh start), it takes lines once ready', () => {
    const e = launched('starting')
    expect(e.readyAt).toBeUndefined()
    sessions.hiveToolsConnected(project, id, 'run1')
    e.state.status = 'ready'
    emit(e)
    expect(whyNoLine(project, id)).toBeNull()
  })

  it('a launch without Hive\'s tools (Settings → Agent API off) never waits for them', () => {
    launched('ready', false)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(false)
    expect(whyNoLine(project, id)).toBeNull()
  })

  it('a wait for them (a task given meanwhile, round 3) ends when they connect', async () => {
    launched()
    let settled = false
    const wait = sessions.hiveToolsSettled(project, id).then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    sessions.hiveToolsConnected(project, id, 'run1')
    await wait
    expect(settled).toBe(true)
  })

  it('…or when the bound from its ready has passed, and at once when nothing holds its lines', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    launched()
    let settled = false
    const wait = sessions.hiveToolsSettled(project, id).then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_100)
    await wait
    expect(settled).toBe(true)
    live.delete(key)
    await expect(sessions.hiveToolsSettled(project, id)).resolves.toBeUndefined()
  })

  it('the bound lowered in Settings → Advanced while a task waits: the wait ends with the gate, not at the old bound (round 4)', async () => {
    const dir = tempDir('hive-tools-bound')
    advanced.load(dir)
    // The clock stands still until the test moves it (the setting's own write is real, however long it takes).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      launched()
      let settled = false
      const wait = sessions.hiveToolsSettled(project, id).then(() => (settled = true))
      await advanced.set('hive.mcp.connectSeconds', 1)
      // Ready no time ago on this clock: the gate still holds, and the wait with it.
      expect(sessions.hiveToolsWaiting(project, id)).toBe(true)
      expect(settled).toBe(false)
      // Past the lowered bound (not the old 30 s): the wait, looking again when its timer for what was left fires, ends.
      vi.setSystemTime(Date.now() + 1_100)
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10_000 })
      expect(sessions.hiveToolsWaiting(project, id)).toBe(false)
      await wait
    } finally {
      await advanced.set('hive.mcp.connectSeconds', 30)
      advanced.stop()
    }
  })

  it('its launch ending lets the wait go at once', async () => {
    launched()
    let settled = false
    const wait = sessions.hiveToolsSettled(project, id).then(() => (settled = true))
    live.delete(key)
    ;(sessions as unknown as { recheckTools(k: string): void }).recheckTools(key)
    await wait
    expect(settled).toBe(true)
  })

  it('never connected (its server failed, MCP off in its CLI): at most 30 s from when it first became ready', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const e = launched('starting')
    // However long it takes to start, the bound runs from its ready.
    vi.setSystemTime(Date.now() + 60_000)
    e.state.status = 'ready'
    emit(e)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(true)
    // A watch coming and going doesn't move it.
    vi.setSystemTime(Date.now() + 20_000)
    watched.current = true
    emit(e)
    watched.current = false
    emit(e)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(true)
    vi.setSystemTime(Date.now() + 10_001)
    expect(sessions.hiveToolsWaiting(project, id)).toBe(false)
    expect(whyNoLine(project, id)).toBeNull()
  })
})
