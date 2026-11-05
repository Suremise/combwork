// A launch's task on its CLI's command line (#712): the CLI is ready at its SessionStart and takes the task only after,
// so until its first prompt the agent counts as given a task (pending: working to a wait), at most 30 s after it became
// ready. The real SessionManager's agentNow, with hand-made live states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whyNoLine } from '../src/main/lineWriter'
import { sessions } from '../src/main/sessions'
import { agentBusy } from '../src/shared/agentWatch'

const project = 'C:/fake-ws/alpha'
const id = 'b1'
type Entry = { state: { runId: string; status: string; statusSince?: string }; prompts: number; launchTask?: true; launchReadyAt?: number; typed?: { at: number; prompts: number } }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const key = `${project.toLowerCase()}#${id}`
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

function running(over: Partial<Entry> & { status?: string; since?: string } = {}): Entry {
  const { status = 'ready', since = ago(0), ...rest } = over
  const e: Entry = { state: { runId: 'run1', status, statusSince: since }, prompts: 0, ...rest }
  live.set(key, e)
  return e
}
const now = () => sessions.agentNow(project, id)!

describe("a launch's task until its CLI takes it (#712)", () => {
  afterEach(() => live.delete(key))

  it('ready but not on its task yet is pending, so a wait waits', () => {
    running({ launchTask: true, since: ago(2000) })
    expect(now().pending).toBe(true)
    expect(agentBusy(now(), false)).toBe(true)
  })

  it('once its CLI takes the task, it is the turn that counts', () => {
    const e = running({ launchTask: true })
    e.prompts = 1
    expect(now().pending).toBe(false)
    e.state.status = 'working'
    expect(agentBusy(now(), false)).toBe(true)
    e.state.status = 'finished'
    expect(agentBusy(now(), false)).toBe(false)
  })

  it('not taken 30 s after it became ready, it is idle again (a wait mustn’t hang on a dropped task)', () => {
    running({ launchTask: true, since: ago(31_000) })
    expect(now().pending).toBe(false)
  })

  it('waiting for the user (a question at start) is that, not pending', () => {
    running({ launchTask: true, status: 'waiting' })
    expect(now().pending).toBe(false)
  })

  it('a launch with no task is idle when ready', () => {
    running()
    expect(now().pending).toBe(false)
    expect(agentBusy(now(), false)).toBe(false)
  })
})

// #721: nothing of Combwork's is typed into it in that gap (the line writer's and the watch wakes' check), also when a watch
// of the agent's outlived its last launch and shows its ready as watching (round 1 finding 1), or ends meanwhile.
describe("no line of Combwork's before its CLI takes the launch's task (#721)", () => {
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

  /** A launch with its task, as its SessionStart reports it: ready, sent through emitState (which a watch makes watching). */
  function launched(): Entry {
    const e = running({ launchTask: true })
    Object.assign(e.state, { projectPath: project, agentId: id, agentName: 'B1', runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }, turn: { state: 'over' } })
    Object.assign(e, { adapter: { descriptor: { capabilities: { startupSizeRefresh: false } } } })
    return e
  }
  const emit = (e: Entry) => (sessions as unknown as { emitState(s: unknown): void }).emitState(e.state)

  it('ready with no watch: pending, and no line typed', () => {
    emit(launched())
    expect(sessions.launchTaskWaiting(project, id)).toBe(true)
    expect(whyNoLine(project, id)).toMatch(/launch's task/)
  })

  it('a retained watch shows it as watching: still pending, and no line typed', () => {
    watched.current = true
    const e = launched()
    emit(e)
    expect(e.state.status).toBe('watching')
    expect(sessions.launchTaskWaiting(project, id)).toBe(true)
    expect(now().pending).toBe(true)
    expect(whyNoLine(project, id)).toMatch(/launch's task/)
  })

  it('that watch ending meanwhile (finished) keeps it pending', () => {
    watched.current = true
    const e = launched()
    emit(e)
    watched.current = false
    emit(e)
    expect(e.state.status).toBe('finished')
    expect(sessions.launchTaskWaiting(project, id)).toBe(true)
  })

  it('its first prompt ends the wait', () => {
    watched.current = true
    const e = launched()
    emit(e)
    e.prompts = 1
    expect(sessions.launchTaskWaiting(project, id)).toBe(false)
    expect(whyNoLine(project, id) ?? '').not.toMatch(/launch's task/)
  })

  it('at most 30 s from when it first became ready, which a watch coming or going does not move', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const e = launched()
    emit(e)
    vi.setSystemTime(Date.now() + 20_000)
    watched.current = true
    emit(e)
    expect(sessions.launchTaskWaiting(project, id)).toBe(true)
    vi.setSystemTime(Date.now() + 11_000)
    watched.current = false
    emit(e)
    expect(sessions.launchTaskWaiting(project, id)).toBe(false)
    expect(now().pending).toBe(false)
  })
})
