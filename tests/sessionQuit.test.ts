// sessions.quit (HI-1706): a lane's builder ended as a person ends its CLI, typing its exit command (Claude Code's /exit,
// Codex's /quit) and Enter, then killed only if it is still running after the grace. Never typed over the user's draft
// or while they type, nor over a line of Hive's not taken; fenced to that run and the caller's lease before each key
// and before the kill; Stop and restarts don't use it.
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { claudeInput, type ClaudeInput } from './claudeInputStandIn'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const writes: { key: string; data: string }[] = []
const kills: string[] = []
/** Called at each write (a test's input or turn arriving while Hive types). */
let onWrite: ((key: string, data: string) => void) | null = null
vi.mock('../src/main/ptyHost', async (orig) => ({
  ...(await orig<typeof import('../src/main/ptyHost')>()),
  writePty: (key: string, data: string) => {
    writes.push({ key, data })
    onWrite?.(key, data)
  },
  killPty: (key: string) => void kills.push(key)
}))

const base = tempDir('hive-quit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { sessions } = await import('../src/main/sessions')
const { advanced } = await import('../src/main/advanced')
advanced.load(join(base, 'profile'))
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { config } = await import('../src/main/config')

const P = join(base, 'alpha')
type Priv = { live: Map<string, { state: Record<string, unknown>; adapter: unknown; ending?: boolean; stopRequested?: boolean; stopCause?: string }>; runs: Map<string, string>; noteUserInput: (key: string, data: string) => void; userInput: Map<string, unknown> }
const priv = sessions as unknown as Priv
let n = 0
/** A live session of the agent (a stand-in for its launch), at its prompt. */
function live(adapter: unknown = claudeCode) {
  const agentId = `b${++n}`
  const state = { provider: 'claude-code', runId: `run-${n}`, projectPath: P, agentId, agentName: `B${n}`, cwd: P, status: 'ready', startedAt: new Date().toISOString() }
  // Its input box (claudeInputStandIn, fed what is typed into this agent: HI-1979, Hive types into it only once a key
  // of its own shows it empty), bracketed paste off.
  const input = claudeInput({ paste: false })
  input.from(() => writes.filter((w) => w.key === `session:${P.toLowerCase()}#${agentId}`).map((w) => w.data))
  const l: { state: typeof state; adapter: unknown; screen: ClaudeInput['screen']; ending?: boolean; stopRequested?: boolean; stopCause?: string; prompts?: number } = { state, adapter, screen: input.screen }
  priv.live.set(`${P.toLowerCase()}#${agentId}`, l)
  priv.runs.set(state.runId, `${P.toLowerCase()}#${agentId}`)
  const key = `session:${P.toLowerCase()}#${agentId}`
  return { l, agentId, run: state.runId, key, typed: () => writes.filter((w) => w.key === key).map((w) => w.data).join('') }
}

beforeAll(async () => {
  // A short grace, so the kill's turn comes within the test.
  await advanced.set('claude-code.exit.graceSeconds', 3)
})
afterEach(() => {
  writes.length = 0
  kills.length = 0
  onWrite = null
})
afterAll(() => priv.live.clear())

describe("a lane's builder ended by its CLI's own exit", () => {
  it('types /exit then Enter into Claude Code, and kills it only if it is still running after the grace', async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })).toBe('sent')
    expect(a.typed()).toContain('/exit')
    expect(a.typed().endsWith('\r')).toBe(true)
    expect(a.l.stopRequested).toBe(true)
    expect(kills).toEqual([])
    await vi.waitFor(() => expect(kills).toEqual([a.key]), { timeout: 10_000 })
  })

  it("types Codex's /quit", async () => {
    const a = live(codex)
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })).toBe('sent')
    expect(a.typed()).toContain('/quit')
  })

  it("an exit that ends the run in time isn't killed: the kill is fenced to that very run", async () => {
    vi.useFakeTimers()
    try {
      const a = live()
      const r = sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })
      await vi.advanceTimersByTimeAsync(2000)
      expect(await r).toBe('sent')
      // It exited, and the agent started again (a new run) before the grace was up.
      priv.live.delete(`${P.toLowerCase()}#${a.agentId}`)
      const again = { ...a.l, state: { ...a.l.state, runId: 'run-new' } }
      priv.live.set(`${P.toLowerCase()}#${a.agentId}`, again)
      await vi.advanceTimersByTimeAsync(5000)
      expect(kills).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('nothing typed or killed while the user types or has a draft in its prompt; forced (past the deadline), killed, never typed over', async () => {
    const a = live()
    priv.noteUserInput(a.key, 'half a sentence')
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })).toBe('held')
    expect(a.typed()).toBe('')
    expect(sessions.inputHeld(P, a.agentId)).toBe('the user is typing there')
    priv.userInput.set(a.key, { at: 0, enter: false })
    expect(sessions.inputHeld(P, a.agentId)).toBe("the user's draft is in its prompt")
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })).toBe('held')
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'past the deadline', force: true })).toBe('sent')
    expect(a.typed()).toBe('')
    expect(kills).toEqual([a.key])
  })

  it('a fence lost (a new lease, a restart) before or while it types: nothing more written, nothing killed', async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => false, why: 'its lane ended' })).toBe('gone')
    expect(a.typed()).toBe('')
    vi.useFakeTimers()
    try {
      let fenced = true
      let pieces = 0
      const b = live()
      const r = sessions.quit(P, b.agentId, b.run, { fenced: () => (pieces++ < 2 ? fenced : (fenced = false)), why: 'its lane ended' })
      await vi.advanceTimersByTimeAsync(2000)
      expect(await r).toBe('gone')
      expect(b.typed()).not.toContain('\r')
      expect(b.l.ending).toBe(false)
      expect(b.l.stopRequested).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(kills).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("input of the user's arriving once it has begun typing stops it before Enter, with no typing pause at all (HR1 round 1, finding 3)", async () => {
    const assistant = config.settings.assistant as unknown as { typingPause?: number }
    const pause = assistant.typingPause
    assistant.typingPause = 0
    vi.useFakeTimers()
    try {
      const a = live()
      expect(sessions.userMayBeTyping(P, a.agentId)).toBe(false)
      // At Hive's first write, the user begins a sentence of their own there.
      onWrite = (key) => {
        if (key !== a.key) return
        onWrite = null
        priv.noteUserInput(a.key, 'no wait')
      }
      const r = sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r).toBe('held')
      expect(a.typed()).not.toContain('\r')
      expect(a.l.ending).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(kills).toEqual([])
    } finally {
      vi.useRealTimers()
      assistant.typingPause = pause
    }
  })

  it("a CLI ended by its exit keys (no exit command): the user's input after its first key stops the rest", async () => {
    vi.useFakeTimers()
    try {
      const a = live(copilot)
      onWrite = (key, data) => {
        if (key !== a.key || data !== '\x03') return
        onWrite = null
        priv.noteUserInput(a.key, 'x')
      }
      const r = sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r).toBe('held')
      expect(a.typed()).toBe('\x03')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a turn beginning while it types (a prompt taken, or its states saying the turn is open again) stops it before Enter (HR1 round 1, finding 1)', async () => {
    vi.useFakeTimers()
    try {
      const a = live()
      onWrite = (key) => {
        if (key !== a.key) return
        onWrite = null
        a.l.prompts = (a.l.prompts ?? 0) + 1
      }
      const r = sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r).toBe('held')
      expect(a.typed()).not.toContain('\r')
      const b = live()
      let open = false
      onWrite = (key) => {
        if (key === b.key) open = true
      }
      const r2 = sessions.quit(P, b.agentId, b.run, { fenced: () => true, why: 'its lane ended', ready: () => (open ? 'it is in a turn' : null) })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r2).toBe('held')
      expect(b.typed()).not.toContain('\r')
      // Forced (past the deadline), its states aren't asked: it is ended all the same.
      open = false
      const r3 = sessions.quit(P, b.agentId, b.run, { fenced: () => true, why: 'past the deadline', force: true, ready: () => 'it is in a turn' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r3).toBe('sent')
      expect(b.typed().endsWith('\r')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("another run's id: nothing", async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, 'run-old', { fenced: () => true, why: 'its lane ended' })).toBe('gone')
    expect(a.typed()).toBe('')
  })
})

describe("a stop's cause is its caller's (HI-1881, HR5's round 1)", () => {
  it("a lane's end says lane; another caller of quit (a switch of connection) says nothing, so a stop shows as stopped", async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended', cause: 'lane' })).toBe('sent')
    expect(a.l.stopCause).toBe('lane')
    const b = live()
    expect(await sessions.quit(P, b.agentId, b.run, { fenced: () => true, why: 'a switch of connection' })).toBe('sent')
    expect(b.l.stopRequested).toBe(true)
    expect(b.l.stopCause).toBeUndefined()
  })

  it("a quit called off (a turn began while it typed) leaves no cause behind: a later exit is the CLI's own", async () => {
    vi.useFakeTimers()
    try {
      const a = live()
      onWrite = (key) => {
        if (key !== a.key) return
        onWrite = null
        a.l.prompts = (a.l.prompts ?? 0) + 1
      }
      const r = sessions.quit(P, a.agentId, a.run, { fenced: () => true, why: 'its lane ended', cause: 'lane' })
      await vi.advanceTimersByTimeAsync(3000)
      expect(await r).toBe('held')
      expect(a.l.stopRequested).toBe(false)
      expect(a.l.stopCause).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopping where a caller chose labels the stop only with the cause it gave (a workspace closing), never by itself', async () => {
    const a = live()
    await sessions.stopWhereAndWait((s) => (s as { agentId?: string }).agentId === a.agentId, 50)
    expect(a.l.stopRequested).toBe(true)
    expect(a.l.stopCause).toBeUndefined()
    const b = live()
    await sessions.stopWhereAndWait((s) => (s as { agentId?: string }).agentId === b.agentId, 50, 'closed')
    expect(b.l.stopCause).toBe('closed')
  })
})
