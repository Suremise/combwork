// An agent whose input takes no keys (HI-2191): Claude Code 2.1.314 drew its offer to teach auto mode under its empty
// input box, the dialog took the keys, and Combwork typed its letter into it 105 times in five minutes while nobody was told.
// With the real SessionManager on a stand-in Claude Code input (claudeInputStandIn) that stops reading keys: three
// clears in a row unanswered while the box reads empty block the input, the agent waits for the user with why, and no key
// is pressed there until it is seen to take keys again (its box taking the user's key, a hook that moves it, or the
// user's Try again), in the same run; another question it waits on keeps its reason.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeInput, type ClaudeInput } from './claudeInputStandIn'

const { writes, echo } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } } }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void (writes.push(data), echo.to?.write(data)) }))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { advanced } = await import('../src/main/advanced')
const { hookStep } = await import('../src/main/hookStatus')
const writer = await import('../src/main/lineWriter')

const project = 'C:/combwork-test/input-blocked'
const id = 'b1'
const key = `${project.toLowerCase()}#${id}`
/** Its terminal's key (agentPtyKey), as the user's typing is noted by. */
const pty = `session:${key}`
type Entry = Record<string, unknown> & { state: Record<string, unknown> & { status: string; runId: string; inputBlocked?: { since: string } }; inputBlocked?: { ask: unknown }; unanswered?: number; waitingOn?: unknown; open?: unknown[] }
const s = sessions as unknown as {
  live: Map<string, Entry>
  delivering: Set<string>
  userInput: Map<string, unknown>
  notify: (...a: unknown[]) => void
  clearInput(l: Entry, key: string, check: () => void): Promise<void>
  inputBlockedDrawn(id: string, l: Entry): void
  carryOut(id: string, l: Entry, step: unknown, cause: string, ev?: unknown): void
  statusInput(l: Entry): unknown
}
const liveKey = (): string => [...s.live.keys()].find((k) => s.live.get(k)?.state.agentId === id) ?? ''
let claude: ClaudeInput | null = null

function running(status = 'ready', opts: Parameters<typeof claudeInput>[0] = {}): Entry {
  claude = claudeInput({ paste: true, ...opts })
  echo.to = { write: claude.feed }
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'HB5', runId: 'run1', status, open: [] }, adapter: claudeCode, screen: claude.screen, prompts: 0, open: [] }
  s.live.set(key, e)
  return e
}
/** Advanced's wait for each key made short, so an unanswered key needn't take its 2 s. */
const shortWait = (): void => {
  const number = advanced.number.bind(advanced)
  vi.spyOn(advanced, 'number').mockImplementation((setting: string) => (setting === 'claude-code.prompt.clearKeySeconds' ? 0.2 : number(setting)))
}
/** A delivery's try: refused because its letter went unanswered. */
const refusedTry = (): Promise<void> => expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 task')).rejects.toThrow(/couldn't be seen empty/)
const blockIt = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await refusedTry()
}
const hook = (e: Entry, ev: Record<string, unknown>, cause = 'Hook'): void => s.carryOut(liveKey(), e, hookStep(ev as never, s.statusInput(e) as never), cause, ev)
const OTHER = { kind: 'permission', blocking: true, message: 'Allow Bash(npm test)?' }

describe('an input that takes no keys (HI-2191)', () => {
  afterEach(() => {
    s.live.delete(key)
    s.delivering.clear()
    s.userInput.delete(pty)
    writes.length = 0
    echo.to = null
    claude = null
    vi.restoreAllMocks()
  })

  it('three clears in a row unanswered while its box reads empty: the agent waits for the user with why, and nothing more is typed', async () => {
    shortWait()
    const notified = vi.spyOn(s, 'notify').mockImplementation(() => undefined)
    const e = running()
    claude!.input.answers = 0
    await refusedTry()
    await refusedTry()
    expect(e.state.status, 'two: not yet').toBe('ready')
    expect(sessions.inputBlocked(project, id)).toBe(false)
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(true)
    expect(e.state.status).toBe('waiting')
    expect(String(e.state.statusMessage)).toMatch(/Something on its screen is taking its keys/)
    expect(e.state.inputBlocked?.since).toBeTruthy()
    expect(notified).toHaveBeenCalled()
    // Refused with why, before any key: a delivery, the slot's line (whyNoLine) and an Enter again.
    writes.length = 0
    await expect(sessions.sendPrompt(project, id, 'more')).rejects.toThrow(/taking its keys/)
    expect(writer.whyNoLine(project, id)).toMatch(/taking its keys/)
    expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
    expect(writes).toEqual([])
  })

  it('a clear answered between unanswered ones starts the count again; a redraw late within the wait is answered (no block)', async () => {
    shortWait()
    const e = running()
    claude!.input.answers = 0
    await refusedTry()
    await refusedTry()
    claude!.input.answers = Infinity
    await s.clearInput(e, key, () => undefined)
    expect(e.unanswered).toBe(0)
    claude!.input.answers = claude!.input.keys
    await refusedTry()
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(false)
    vi.restoreAllMocks()
    // A busy machine: each key drawn 600 ms late, within the 2 s wait. Three clears, all answered.
    const slow = running('ready', { lagMs: 600 })
    for (let i = 0; i < 3; i++) await s.clearInput(slow, key, () => undefined)
    expect(slow.unanswered).toBe(0)
    expect(sessions.inputBlocked(project, id)).toBe(false)
  }, 15_000)

  it("not at its prompt, waiting on another question: blocked, but that question's reason stays", async () => {
    shortWait()
    vi.spyOn(s, 'notify').mockImplementation(() => undefined)
    const e = running('waiting')
    e.waitingOn = OTHER
    e.state.statusMessage = OTHER.message
    claude!.input.answers = 0
    await blockIt()
    expect(sessions.inputBlocked(project, id)).toBe(true)
    expect(e.state.status).toBe('waiting')
    expect(e.waitingOn).toBe(OTHER)
    expect(e.state.statusMessage).toBe(OTHER.message)
  })

  it("Combwork done with a line it typed says so (lineWriter.onLineFreed): what waits on 'already typing' looks again by it", async () => {
    running()
    const told: string[] = []
    const off = writer.onLineFreed((p, a) => void told.push(`${p}#${a}`))
    try {
      // Its typing begun (the line writer's own lock held), however it ends (here put off part-way): done with, and said.
      expect(writer.whyNoLine(project, id)).toBeNull()
      let held = false
      await writer.typeLine(project, id, '[CW] New in your inbox: 1 task', () => (held ||= writer.lineBusy(project, id), true))
      expect(held, 'its lock was held while it typed').toBe(true)
      expect(writer.lineBusy(project, id)).toBe(false)
      expect(told).toEqual([`${project}#${id}`])
      // Refused before any key (its input blocked): nothing was held, nothing to say.
      told.length = 0
      ;(s.live.get(key) as Entry).inputBlocked = { runId: 'run1', ask: {}, box: '', since: Date.now() } as never
      expect(await writer.typeLine(project, id, 'more', () => true)).toBe(false)
      expect(told).toEqual([])
    } finally {
      off()
    }
  })

  describe('seen to take keys again', () => {
    const blocked = async (): Promise<Entry> => {
      shortWait()
      vi.spyOn(s, 'notify').mockImplementation(() => undefined)
      const e = running()
      claude!.input.answers = 0
      await blockIt()
      expect(e.state.status).toBe('waiting')
      writes.length = 0
      return e
    }

    it("its box taking a key of the user's frees it; keys that move about a dialog, or none, don't", async () => {
      const e = await blocked()
      // Drawn again with nothing typed: still blocked.
      s.inputBlockedDrawn(liveKey(), e)
      expect(sessions.inputBlocked(project, id)).toBe(true)
      // The user presses keys that don't reach the box (arrows in the dialog, a letter it ignores): the box is as it was.
      sessions.noteUserInput(pty, '\x1b[B')
      sessions.noteUserInput(pty, 'y')
      s.inputBlockedDrawn(liveKey(), e)
      expect(sessions.inputBlocked(project, id)).toBe(true)
      expect(e.state.status).toBe('waiting')
      // The dialog answered, the user types a letter and the box shows it: its input takes keys.
      claude!.input.answers = Infinity
      claude!.feed('h')
      sessions.noteUserInput(pty, 'h')
      s.inputBlockedDrawn(liveKey(), e)
      expect(sessions.inputBlocked(project, id)).toBe(false)
      expect(e.state.status).toBe('ready')
      expect(e.state.inputBlocked).toBeUndefined()
      expect(writes, 'Combwork pressed nothing').toEqual([])
    })

    it('a hook that moves it frees it (a prompt: working; a new question keeps its own reason); its idle notice does not', async () => {
      const e = await blocked()
      hook(e, { kind: 'idle' })
      expect(sessions.inputBlocked(project, id)).toBe(true)
      // Hook-shaped, but drawn from the screen: no evidence its CLI moved.
      hook(e, { kind: 'prompt' }, 'screen')
      expect(sessions.inputBlocked(project, id)).toBe(true)
      hook(e, { kind: 'ask', ask: OTHER })
      expect(sessions.inputBlocked(project, id)).toBe(false)
      expect(e.state.status).toBe('waiting')
      expect(e.waitingOn).toBe(OTHER)
      expect((e.open ?? []).some((a) => /taking its keys/.test((a as { message: string }).message)), 'the block is no open question').toBe(false)
      const again = running()
      claude!.input.answers = 0
      await blockIt()
      hook(again, { kind: 'prompt' })
      expect(sessions.inputBlocked(project, id)).toBe(false)
      expect(again.state.status).toBe('working')
    })

    it('Try again: answered, typing goes on; not answered, it stays blocked; a stale click and a second at once change nothing', async () => {
      const e = await blocked()
      const since = e.state.inputBlocked!.since
      // Not answered yet: still blocked, its letter taken back, nothing else pressed.
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('blocked')
      expect(sessions.inputBlocked(project, id)).toBe(true)
      expect(e.state.status).toBe('waiting')
      expect(writes).toEqual(['x', '\x7f'])
      // A click for another block (an older one): nothing typed.
      writes.length = 0
      await expect(sessions.retryInput(project, id, '2026-01-01T00:00:00.000Z')).resolves.toBe('gone')
      expect(writes).toEqual([])
      // One at a time: a second click while the first runs is busy.
      claude!.input.answers = Infinity
      const first = sessions.retryInput(project, id, since)
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('busy')
      await expect(first).resolves.toBe('clear')
      expect(sessions.inputBlocked(project, id)).toBe(false)
      expect(e.state.status).toBe('ready')
      // Over: a late click changes nothing.
      writes.length = 0
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('gone')
      expect(writes).toEqual([])
    })

    it("Try again just after the user's Esc tries (their click); their text in the box frees it without a key of Combwork's", async () => {
      const e = await blocked()
      const since = e.state.inputBlocked!.since
      // Their Esc a moment ago (typing, for the pause after it): Try again is theirs, so it tries.
      s.userInput.set(pty, { at: Date.now() - 1000, enter: false })
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('blocked')
      expect(writes).toEqual(['x', '\x7f'])
      writes.length = 0
      claude!.input.answers = Infinity
      claude!.feed('my draft')
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('clear')
      expect(writes).toEqual([])
      expect(claude!.input.text).toBe('my draft')
      expect(e.state.status).toBe('ready')
    })

    it('a new run is never blocked by the last one, and a late Try again for it types nothing', async () => {
      const e = await blocked()
      const since = e.state.inputBlocked!.since
      e.state.runId = 'run2'
      expect(sessions.inputBlocked(project, id)).toBe(false)
      claude!.input.answers = Infinity
      await expect(sessions.retryInput(project, id, since)).resolves.toBe('gone')
      expect(writes).toEqual([])
    })
  })
})
