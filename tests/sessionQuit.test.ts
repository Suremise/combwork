// sessions.quit (HI-1706): a lane's builder ended as a person ends its CLI, typing its exit command (Claude Code's /exit,
// Codex's /quit) and Enter, then killed only if it is still running after the grace. Never typed over the user's draft
// or while they type, nor over a line of Hive's not taken; fenced to that run and the caller's lease before each key
// and before the kill; Stop and restarts don't use it.
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const writes: { key: string; data: string }[] = []
const kills: string[] = []
vi.mock('../src/main/ptyHost', async (orig) => ({
  ...(await orig<typeof import('../src/main/ptyHost')>()),
  writePty: (key: string, data: string) => void writes.push({ key, data }),
  killPty: (key: string) => void kills.push(key)
}))

const base = tempDir('hive-quit-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { sessions } = await import('../src/main/sessions')
const { advanced } = await import('../src/main/advanced')
advanced.load(join(base, 'profile'))
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')

const P = join(base, 'alpha')
type Priv = { live: Map<string, { state: Record<string, unknown>; adapter: unknown; ending?: boolean; stopRequested?: boolean }>; runs: Map<string, string>; noteUserInput: (key: string, data: string) => void; userInput: Map<string, unknown> }
const priv = sessions as unknown as Priv
let n = 0
/** A live session of the agent (a stand-in for its launch), at its prompt. */
function live(adapter: unknown = claudeCode) {
  const agentId = `b${++n}`
  const state = { provider: 'claude-code', runId: `run-${n}`, projectPath: P, agentId, agentName: `B${n}`, cwd: P, status: 'ready', startedAt: new Date().toISOString() }
  const l: { state: typeof state; adapter: unknown; ending?: boolean; stopRequested?: boolean } = { state, adapter }
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
})
afterAll(() => priv.live.clear())

describe("a lane's builder ended by its CLI's own exit", () => {
  it('types /exit then Enter into Claude Code, and kills it only if it is still running after the grace', async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, a.run, () => true, 'its lane ended')).toBe('sent')
    expect(a.typed()).toContain('/exit')
    expect(a.typed().endsWith('\r')).toBe(true)
    expect(a.l.stopRequested).toBe(true)
    expect(kills).toEqual([])
    await vi.waitFor(() => expect(kills).toEqual([a.key]), { timeout: 10_000 })
  })

  it("types Codex's /quit", async () => {
    const a = live(codex)
    expect(await sessions.quit(P, a.agentId, a.run, () => true, 'its lane ended')).toBe('sent')
    expect(a.typed()).toContain('/quit')
  })

  it("an exit that ends the run in time isn't killed: the kill is fenced to that very run", async () => {
    vi.useFakeTimers()
    try {
      const a = live()
      const r = sessions.quit(P, a.agentId, a.run, () => true, 'its lane ended')
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
    expect(await sessions.quit(P, a.agentId, a.run, () => true, 'its lane ended')).toBe('held')
    expect(a.typed()).toBe('')
    expect(sessions.inputHeld(P, a.agentId)).toBe('the user is typing there')
    priv.userInput.set(a.key, { at: 0, enter: false })
    expect(sessions.inputHeld(P, a.agentId)).toBe("the user's draft is in its prompt")
    expect(await sessions.quit(P, a.agentId, a.run, () => true, 'its lane ended')).toBe('held')
    expect(await sessions.quit(P, a.agentId, a.run, () => true, 'past the deadline', true)).toBe('sent')
    expect(a.typed()).toBe('')
    expect(kills).toEqual([a.key])
  })

  it('a fence lost (a new lease, a restart) before or while it types: nothing more written, nothing killed', async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, a.run, () => false, 'its lane ended')).toBe('gone')
    expect(a.typed()).toBe('')
    vi.useFakeTimers()
    try {
      let fenced = true
      let pieces = 0
      const b = live()
      const r = sessions.quit(P, b.agentId, b.run, () => (pieces++ < 2 ? fenced : (fenced = false)), 'its lane ended')
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

  it("another run's id: nothing", async () => {
    const a = live()
    expect(await sessions.quit(P, a.agentId, 'run-old', () => true, 'its lane ended')).toBe('gone')
    expect(a.typed()).toBe('')
  })
})
