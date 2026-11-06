// A line Combwork types that its CLI doesn't take (#430), with the real SessionManager and the terminal's writes caught:
// nothing more is typed over a line still waiting to be taken (typed and not yet taken, or marked not taken), whoever
// types it; the user's Enter alone doesn't count as taken; only the CLI taking a prompt clears the mark. And a wake's
// Enter again, when it can't be pressed at once, is pressed once it can, else the line is marked, saying so.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessions } from '../src/main/sessions'
import * as pty from '../src/main/ptyHost'
import { config } from '../src/main/config'
// The writer of Combwork's lines and their confirmation (#649: lineWriter.ts, which the delivery service types with).
import * as writer from '../src/main/lineWriter'

const project = 'C:/fake-ws/alpha'
const id = 'a1'
type Entry = { state: Record<string, unknown>; prompts: number; typed?: { at: number; prompts: number; from?: number } }
const live = (sessions as unknown as { live: Map<string, Entry> }).live
const key = `${project.toLowerCase()}#${id}`

/**
 * A hand-made live state whose runtime facts follow its status, as the turn ledger's would (#648): the CLI running, a turn
 * running while it works, asked while it waits. Readiness reads the facts (#649).
 */
function withFacts<T extends { status: string }>(state: T): T {
  let status = state.status
  const rt = { lifecycle: 'running', maintenance: null as null, attention: null as 'waiting' | null, composer: 'free' }
  const follow = (): void => {
    Object.assign(state, { turn: { state: status === 'working' ? 'running' : 'over' } })
    rt.attention = status === 'waiting' ? 'waiting' : null
  }
  Object.defineProperty(state, 'status', {
    get: () => status,
    set: (v: string) => {
      status = v
      follow()
    },
    enumerable: true,
    configurable: true
  })
  Object.assign(state, { runtime: rt })
  follow()
  return state
}

describe('a line still waiting to be taken (#430)', () => {
  afterEach(() => {
    live.delete(key)
    vi.restoreAllMocks()
  })
  const running = (over: Partial<Entry> = {}): Entry => {
    const e: Entry = { state: withFacts({ projectPath: project, agentId: id, agentName: 'Watcher', runId: 'run1', status: 'ready' }), prompts: 0, ...over }
    live.set(key, e)
    return e
  }

  it('nothing more is typed over it: not while it waits to be taken, not while marked; once taken, typing goes on', async () => {
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    // Typed a moment ago (a wake being confirmed): another wake or a task is refused before anything is written.
    const e = running({ typed: { at: Date.now(), prompts: 0 } })
    expect(sessions.lineWaiting(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, 'SECOND LINE')).rejects.toThrow(/hasn't taken the line Combwork typed before/)
    expect(writes).toEqual([])
    // Taken (the CLI reported the prompt): typing goes on.
    e.prompts = 1
    expect(sessions.lineWaiting(project, id)).toBe(false)
    await sessions.sendPrompt(project, id, 'NEXT')
    expect(writes.join('')).toContain('NEXT')
    // Marked not taken: refused, however long ago it was typed.
    writes.length = 0
    e.typed = { at: Date.now() - 60 * 60_000, prompts: 1 }
    e.state.untakenLine = { since: new Date().toISOString(), text: '[CW] #1 is in Review' }
    await expect(sessions.sendPrompt(project, id, 'THIRD')).rejects.toThrow(/hasn't taken/)
    expect(writes).toEqual([])
  })

  it("the user's Enter there isn't proof it was taken: the mark stays until its CLI takes a prompt", () => {
    const e = running()
    e.state.untakenLine = { since: new Date().toISOString(), text: '[CW] #1 is in Review' }
    sessions.noteUserInput(`session:${key}`, '\r')
    expect(sessions.lineUntaken(project, id)).toBe(true)
  })
})

describe('a wake being confirmed holds its input the whole time (#430 round 2)', () => {
  afterEach(() => {
    live.delete(key)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('past 30 s while Enter again is unsafe, nothing else is typed over it; then Enter again once, taken late, and the hold is gone', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    // Just typed (prompts 0), busy (Enter again unsafe while working).
    const e: Entry = { state: withFacts({ projectPath: project, agentId: id, agentName: 'Watcher', runId: 'run1', status: 'working' }), prompts: 0, typed: { at: Date.now(), prompts: 0 } }
    live.set(key, e)
    const done = writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(sessions.lineWaiting(project, id)).toBe(true)
    await expect(sessions.sendPrompt(project, id, 'A TASK')).rejects.toThrow(/hasn't taken/)
    expect(writes).toEqual([])
    // Safe now: Enter again, once.
    e.state.status = 'finished'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual(['\r'])
    expect(sessions.lineWaiting(project, id)).toBe(true)
    // Its CLI takes it, late: confirmed, and the input is free again.
    e.prompts = 1
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await done).toBe(true)
    expect(sessions.lineWaiting(project, id)).toBe(false)
    expect(writes).toEqual(['\r'])
  })
})

describe("a wake's Enter again (#430)", () => {
  afterEach(() => {
    writer.testHooks.takeMs = undefined
    vi.restoreAllMocks()
  })

  it("pressed once it can be when it can't be at once, never a third time; if it never can, the line is marked, saying Enter wasn't pressed again", async () => {
    writer.testHooks.takeMs = 200
    const before = { runId: 'run1', count: 0 }
    vi.spyOn(sessions, 'promptsTaken').mockReturnValue(before)
    const marks: { line: string; retried: boolean }[] = []
    vi.spyOn(sessions, 'lineNotTaken').mockImplementation((_p, _a, _r, line, retried = true) => void marks.push({ line, retried }))
    // Busy (or the user typing) for a while, then safe: Enter again then, once.
    let tries = 0
    let enters = 0
    vi.spyOn(sessions, 'submitAgain').mockImplementation(() => (++tries > 3 ? (enters++, true) : false))
    expect(await writer.confirmTaken(project, id, before, 'WAKE')).toBe(false)
    expect(enters).toBe(1)
    expect(marks).toEqual([{ line: 'WAKE', retried: true }])
    // Never safe within the wait: no Enter again, and the mark says so.
    marks.length = 0
    vi.spyOn(sessions, 'submitAgain').mockReturnValue(false)
    expect(await writer.confirmTaken(project, id, before, 'WAKE 2')).toBe(false)
    expect(marks).toEqual([{ line: 'WAKE 2', retried: false }])
  })

  it('taken late, while it waited to press Enter again: nothing more', async () => {
    writer.testHooks.takeMs = 50
    let count = 0
    vi.spyOn(sessions, 'promptsTaken').mockImplementation(() => ({ runId: 'run1', count }))
    const marks: string[] = []
    vi.spyOn(sessions, 'lineNotTaken').mockImplementation((_p, _a, _r, line) => void marks.push(line))
    const submit = vi.spyOn(sessions, 'submitAgain').mockImplementation(() => {
      count = 1
      return false
    })
    expect(await writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE')).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([])
  })
})

describe("a line whose CLI took it with no prompt seen: what it rang for was read (#1514, Codex's queued input)", () => {
  afterEach(() => {
    live.delete(key)
    writer.testHooks.takeMs = undefined
    vi.restoreAllMocks()
  })

  it('read before Enter again: taken, no Enter again, no mark (RR2 read m157 8 s after it was typed)', async () => {
    writer.testHooks.takeMs = 50
    vi.spyOn(sessions, 'promptsTaken').mockReturnValue({ runId: 'run1', count: 0 })
    const marks = vi.spyOn(sessions, 'lineNotTaken').mockImplementation(() => undefined)
    const submit = vi.spyOn(sessions, 'submitAgain').mockReturnValue(true)
    let read = false
    let taken = 0
    const done = writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE', { read: () => read, taken: () => void taken++ })
    read = true
    expect(await done).toBe(true)
    expect(taken).toBe(1)
    expect(submit).not.toHaveBeenCalled()
    expect(marks).not.toHaveBeenCalled()
    // Never read, and no prompt: Enter again, then marked, as before.
    expect(await writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE 2', { read: () => false })).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(marks).toHaveBeenCalledTimes(1)
  })

  it("marked not taken, then what it rang for read: the mark goes, in the launch it was typed into, never another; another line's delivery read leaves it (round 1 finding)", () => {
    const e: Entry = { state: withFacts({ projectPath: project, agentId: id, agentName: 'Reviewer', runId: 'run1', status: 'ready' }), prompts: 0 }
    live.set(key, e)
    // The window is told of its state (a hand-made state has no provider to show it by).
    const told = vi.spyOn(sessions as unknown as { emitState: (s: unknown) => void }, 'emitState').mockImplementation(() => undefined)
    // Line B rang for mB and is marked; mA, an older line's (taken by a prompt, its delivery read only now), says nothing of B.
    sessions.lineNotTaken(project, id, 'run1', '[CW] New in your inbox: 1 card event (#166) (mB).', true, ['mB'])
    expect(sessions.lineUntaken(project, id)).toBe(true)
    told.mockClear()
    sessions.lineTaken(project, id, 'run1', 'mA', 'mA, which it rang for, was read')
    expect(sessions.lineUntaken(project, id)).toBe(true)
    // mB read, but in another launch's name: left.
    sessions.lineTaken(project, id, 'run0', 'mB', 'mB, which it rang for, was read')
    expect(sessions.lineUntaken(project, id)).toBe(true)
    expect(told).not.toHaveBeenCalled()
    // mB read in its own launch: B was taken.
    sessions.lineTaken(project, id, 'run1', 'mB', 'mB, which it rang for, was read')
    expect(sessions.lineUntaken(project, id)).toBe(false)
    expect(sessions.lineWaiting(project, id)).toBe(false)
    // A line that rang for nothing Combwork knows (its mark has no deliveries): no read clears it.
    sessions.lineNotTaken(project, id, 'run1', 'A TASK', true)
    sessions.lineTaken(project, id, 'run1', 'mB', 'mB, which it rang for, was read')
    expect(sessions.lineUntaken(project, id)).toBe(true)
  })

  it("a confirmation that ends not taken marks the line with the deliveries it rang for (round 1 finding)", async () => {
    writer.testHooks.takeMs = 0
    vi.spyOn(sessions, 'promptsTaken').mockReturnValue({ runId: 'run1', count: 0 })
    vi.spyOn(sessions, 'submitAgain').mockReturnValue(true)
    const marks = vi.spyOn(sessions, 'lineNotTaken').mockImplementation(() => undefined)
    expect(await writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, 'WAKE', { read: () => false, ids: ['m7', 'm8'] })).toBe(false)
    expect(marks).toHaveBeenCalledWith(project, id, 'run1', 'WAKE', true, ['m7', 'm8'])
  })
})

describe("a line of Combwork's the user typed into is theirs (#652 round 1 finding 2)", () => {
  const was = config.settings.assistant
  afterEach(() => {
    live.delete(key)
    config.settings.assistant = was
    writer.testHooks.takeMs = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  /** A doorbell typed at `t` (its typing began 500 ms before), its first Enter lost: the CLI's count unchanged. */
  const typedAt = (t: number): Entry => {
    const e: Entry = { state: withFacts({ projectPath: project, agentId: id, agentName: 'Builder', runId: 'run1', status: 'ready' }), prompts: 0, typed: { at: t, prompts: 0, from: t - 500 } }
    live.set(key, e)
    return e
  }
  const BELL = '[CW] New in your inbox: 1 message (m1). Call cw_inbox to read it, act on it, then ack it.'

  for (const pause of [15, 0]) {
    it(`edited and left past the typing pause (${pause} s): no Enter again, and nothing more typed until a prompt is sent`, async () => {
      vi.useFakeTimers()
      const t = Date.now()
      config.settings.assistant = { ...was, typingPause: pause, enterEndsPause: true } as typeof was
      const writes: string[] = []
      vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
      const marks = vi.spyOn(sessions, 'lineNotTaken').mockImplementation(() => undefined)
      const e = typedAt(t)
      // The user replaces Combwork's line with a draft of their own, and leaves it unsent past the pause.
      sessions.noteUserInput(`session:${key}`, 'my unsent draft')
      vi.setSystemTime(t + 20_000)
      expect(sessions.userMayBeTyping(project, id)).toBe(false)
      writer.testHooks.takeMs = 0
      let left = 0
      expect(await writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, BELL, { left: () => void left++ })).toBe(false)
      expect(writes).toEqual([])
      expect(left).toBe(1)
      expect(marks).not.toHaveBeenCalled()
      // Not Combwork's to send even directly, and nothing is typed over the draft, however long it stands.
      expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
      vi.setSystemTime(t + 10 * 60_000)
      expect(sessions.lineWaiting(project, id)).toBe(true)
      await expect(sessions.sendPrompt(project, id, 'NEXT BELL')).rejects.toThrow(/hasn't taken the line Combwork typed before/)
      expect(writes).toEqual([])
      // The user sends it (the CLI's count goes up): typing goes on.
      e.prompts = 1
      expect(sessions.lineWaiting(project, id)).toBe(false)
    })
  }

  it('a draft from before the line began is no reason: Enter again, once', async () => {
    vi.useFakeTimers()
    const t = Date.now()
    config.settings.assistant = { ...was, typingPause: 15, enterEndsPause: true } as typeof was
    const writes: string[] = []
    vi.spyOn(pty, 'writePty').mockImplementation((_k, data) => void writes.push(data))
    vi.spyOn(sessions, 'lineNotTaken').mockImplementation(() => undefined)
    sessions.noteUserInput(`session:${key}`, 'x')
    vi.setSystemTime(t + 20_000)
    typedAt(t + 19_000)
    writer.testHooks.takeMs = 0
    expect(await writer.confirmTaken(project, id, { runId: 'run1', count: 0 }, BELL)).toBe(false)
    expect(writes).toEqual(['\r'])
  })
})
