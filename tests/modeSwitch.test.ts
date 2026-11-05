// A running Codex agent's preset switched through its /permissions menu (#363): each key goes in only while the session
// is still the one switched, isn't asking the user anything and isn't busy. One that stops (the session stopped or
// replaced while the keys wait, a question, busy for 30 seconds) types nothing more and reports the switch as not made,
// the mode as it was. Codex's screens are 0.161's, captured from its rendered terminal.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// What Combwork types into agents' terminals, recorded instead (no process runs); onWrite acts as each piece goes in.
const pty = vi.hoisted(() => ({ typed: [] as { key: string; data: string }[], onWrite: (_data: string, _key: string): void => undefined }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (key: string, data: string) => {
    pty.typed.push({ key, data })
    pty.onWrite(data, key)
  }
}))

const base = tempDir('hive-modeswitch-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { codex } = await import('../src/main/providers/codex/adapter')
const { config } = await import('../src/main/config')
const { advanced } = await import('../src/main/advanced')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'switching')
const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
/** A screen, a line per row, however git checked the fixture out (CRLF on Windows). */
const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', `codex-${name}.txt`), 'utf8').replace(/\r\n/g, '\n')
const HELD_WORKING = screen('0.161-held-working')
const MENU = screen('0.161-permissions-readonly')
/** Codex free, its input empty (the held screen with the input cleared). */
const IDLE = screen('0.161-held-idle').replace('› /permissions\n', '› Ask Codex to do anything\n')
if (IDLE === screen('0.161-held-idle')) throw new Error("the held-idle fixture's input line has changed")

let n = 0
/** A running Codex agent in Read Only (no process) whose screen is `shown`, new enough to have no transcript yet. */
function agent(shown: string) {
  const agentId = `a${++n}`
  const id = `${p.toLowerCase()}#${agentId}`
  const view = { text: shown }
  const state: Record<string, unknown> = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, status: 'ready', startedAt: '', launchSignature: '', unseen: false, permissionMode: 'read-only' }
  const live = { state, adapter: codex, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, screen: { text: () => view.text } }
  s.live.set(id, live)
  s.runs.set(state.runId as string, id)
  const key = sessions.key(p, agentId)
  const typed = () => pty.typed.filter((t) => t.key === key).map((t) => t.data)
  const keysSoFar = () => typed().length
  return { agentId, id, key, view, state, live, typed, keysSoFar, switchTo: (mode: string) => run(() => sessions.setPermissionMode(p, agentId, mode as never)) }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("switching a running Codex agent's preset through its menu (#363)", () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    advanced.load(join(base, 'advanced'))
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })
  beforeEach(() => {
    pty.typed.length = 0
    pty.onWrite = () => undefined
  })
  afterEach(() => {
    vi.useRealTimers()
    config.settings.providers.codex.enableDangerousMode = false
    return advanced.resetAll()
  })

  it('switches when Codex is free: Ctrl+U, /permissions, Enter, then the preset picked from its menu', async () => {
    const a = agent(IDLE)
    pty.onWrite = (d) => {
      if (d === '\r') a.view.text = MENU
    }
    expect(await a.switchTo('ask')).toEqual({ ok: true })
    expect(a.typed()).toEqual(['\x15', '/permissions', '\r', '1'])
    expect(a.state.permissionMode).toBe('ask')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it('stopped while its keys wait for Codex to be free: nothing typed, not switched, its mode as it was', async () => {
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await wait(500)
    expect(a.keysSoFar()).toBe(0)
    s.live.delete(a.id)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/its session ended/)
    expect(a.typed()).toEqual([])
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it('replaced by a restart while its keys wait: nothing typed into the new session, whose mode is its own', async () => {
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await wait(500)
    const restarted = { ...a.live, state: { ...a.state, runId: 'run-restarted', permissionMode: 'approve-for-me', status: 'ready' }, screen: { text: () => IDLE } }
    s.live.set(a.id, restarted)
    const r = await result
    expect(r.ok).toBe(false)
    expect(a.typed()).toEqual([])
    expect(restarted.state.permissionMode).toBe('approve-for-me')
    expect(a.state.permissionMode).toBe('read-only')
  })

  it('asking the user something while its keys wait: nothing more typed, not switched', async () => {
    const a = agent(IDLE)
    // The command goes in; then Codex holds it busy, and asks a question.
    pty.onWrite = (d) => {
      if (d === '/permissions') a.view.text = HELD_WORKING
    }
    const result = a.switchTo('ask')
    await wait(800)
    expect(a.typed()).toEqual(['\x15', '/permissions'])
    a.state.status = 'waiting'
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/is asking you something/)
    expect(a.typed()).toEqual(['\x15', '/permissions'])
    expect(a.state.permissionMode).toBe('read-only')
  })

  // Full Access live (#1014): Codex asks its own question after the pick (0.162.1's warning), which the user answers in
  // its terminal; the switch waits for the answer, however long, and Codex's line said before it doesn't count.
  const WARNING = readFileSync(join(__dirname, 'fixtures', 'advanced', 'fullaccess-codex-0.162.1.txt'), 'utf8').replace(/\r\n/g, '\n')
  const SAID = '• Permission selection requested: Full Access\n'
  /** An agent switched to Full Access (turned on in Settings), the warning shown once the preset is picked from the menu. */
  function warned() {
    config.settings.providers.codex.enableDangerousMode = true
    const a = agent(IDLE)
    pty.onWrite = (d) => {
      if (d === '\r') a.view.text = MENU
      else if (/^\d$/.test(d)) a.view.text = WARNING
    }
    return a
  }

  it("Full Access with Codex's warning: waits for the answer however long it takes, then switches", async () => {
    vi.useFakeTimers()
    const a = warned()
    const result = a.switchTo('full-access')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(a.typed()).toEqual(['\x15', '/permissions', '\r', '3'])
    expect(a.state.modeSwitching).toBe('full-access')
    expect(a.state.permissionMode).toBe('read-only')
    // Said while the warning is still up: not the answer.
    ;(a.live as { switchTail?: string }).switchTail = SAID
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.state.permissionMode).toBe('read-only')
    // Answered: the warning goes, and Codex says the switch.
    a.view.text = IDLE
    await vi.advanceTimersByTimeAsync(500)
    ;(a.live as { switchTail?: string }).switchTail = SAID
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual({ ok: true })
    expect(a.state.permissionMode).toBe('full-access')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it("Full Access with Codex's warning cancelled: not switched, its mode as it was", async () => {
    vi.useFakeTimers()
    const a = warned()
    const result = a.switchTo('full-access')
    await vi.advanceTimersByTimeAsync(5000)
    expect(a.state.modeSwitching).toBe('full-access')
    a.view.text = IDLE
    await vi.advanceTimersByTimeAsync(13_000)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/didn't confirm switching to Full access/i)
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it("how long it waits for the answer is Settings → Advanced's (codex.fullAccess.answerSeconds)", async () => {
    vi.useFakeTimers()
    await advanced.set('codex.fullAccess.answerSeconds', 30)
    const a = warned()
    const result = a.switchTo('full-access')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(a.state.modeSwitching).toBe('full-access')
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/didn't confirm switching to Full access/i)
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  it("how long Codex has to show its warning is Settings → Advanced's (codex.fullAccess.warningAfterSeconds)", async () => {
    vi.useFakeTimers()
    /** A warning drawn three seconds after the pick (a slow machine), with no transcript to read the switch back from. */
    const late = () => {
      const a = warned()
      pty.onWrite = (d) => {
        if (d === '\r') a.view.text = MENU
        else if (/^\d$/.test(d)) setTimeout(() => (a.view.text = WARNING), 3000)
      }
      return a
    }
    // By default (2 s) the preset is taken as switched before the warning comes.
    const early = late()
    const r1 = early.switchTo('full-access')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await r1).toEqual({ ok: true })
    // Given 5 s, the switch sees the warning and waits for the answer; cancelled, not switched.
    await advanced.set('codex.fullAccess.warningAfterSeconds', 5)
    const a = late()
    const r2 = a.switchTo('full-access')
    await vi.advanceTimersByTimeAsync(6000)
    expect(a.state.modeSwitching).toBe('full-access')
    a.view.text = IDLE
    await vi.advanceTimersByTimeAsync(13_000)
    expect((await r2).ok).toBe(false)
    expect(a.state.permissionMode).toBe('read-only')
  })

  it('busy for longer than 30 seconds: stops, types nothing, not switched', async () => {
    vi.useFakeTimers()
    const a = agent(HELD_WORKING)
    const result = a.switchTo('ask')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(a.keysSoFar()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/stayed busy for 30 seconds/)
    expect(a.typed()).toEqual([])
    expect(a.state.permissionMode).toBe('read-only')
    expect(a.state.modeSwitching).toBeUndefined()
  })

  // Switch Now (#1024): the running agents switch side by side, so one waiting for the answer to Codex's warning
  // doesn't hold up the others; at most six at once.
  describe('Switch Now with several running agents', () => {
    type Agent = ReturnType<typeof agent>
    /** Running agents whose settings now say `modes[i]`; each one's menu and, for Full Access, Codex's warning. */
    function running(modes: string[]): Agent[] {
      s.live.clear()
      config.settings.providers.codex.enableDangerousMode = true
      const list = modes.map(() => agent(IDLE))
      const want = new Map(list.map((a, i) => [a.agentId, modes[i]]))
      vi.spyOn(sessions as unknown as { agentDef: (p: string, id: string) => Promise<unknown> }, 'agentDef').mockImplementation(async (_p, agentId) => ({ agent: { id: agentId, provider: 'codex' } }))
      vi.spyOn(sessions, 'effective').mockImplementation((async (_p: string, def?: { id: string }) => ({ permissionMode: want.get(def!.id) })) as never)
      pty.onWrite = (d, key) => {
        const a = list.find((x) => x.key === key)!
        if (d === '\r') a.view.text = MENU
        else if (/^\d$/.test(d)) a.view.text = want.get(a.agentId) === 'full-access' ? WARNING : IDLE
      }
      return list
    }
    const delivering = () => (sessions as unknown as { delivering: Set<string> }).delivering
    afterEach(() => {
      vi.restoreAllMocks()
      s.live.clear()
    })

    it("the first agent's warning unanswered: a later agent switches meanwhile; the first, stopped, isn't switched", async () => {
      vi.useFakeTimers()
      const [first, later] = running(['full-access', 'ask'])
      let ended = false
      const result = run(() => sessions.applyModeSettings()).finally(() => (ended = true))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(later.typed()).toEqual(['\x15', '/permissions', '\r', '1'])
      expect(later.state.permissionMode).toBe('ask')
      expect(later.state.modeSwitching).toBeUndefined()
      // The first still waits for the user's answer in its terminal: nothing answered for them, nothing more typed.
      expect(first.typed()).toEqual(['\x15', '/permissions', '\r', '3'])
      expect(first.state.modeSwitching).toBe('full-access')
      expect(ended).toBe(false)
      expect(delivering().has(first.key)).toBe(true)
      expect(delivering().has(later.key)).toBe(false)
      // Stopped while it waits: the switch ends, its composer free, its mode as it was.
      s.live.delete(first.id)
      await vi.advanceTimersByTimeAsync(1000)
      const r = await result
      expect(r.switched).toHaveLength(1)
      expect(r.switched[0]).toMatch(/→/)
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0]).toMatch(/ended/)
      expect(first.typed()).toEqual(['\x15', '/permissions', '\r', '3'])
      expect(first.state.permissionMode).toBe('read-only')
      expect(first.state.modeSwitching).toBeUndefined()
      expect(delivering().size).toBe(0)
    })

    it("the first agent's warning cancelled: reported as not switched, the later agent switched", async () => {
      vi.useFakeTimers()
      const [first, later] = running(['full-access', 'ask'])
      const result = run(() => sessions.applyModeSettings())
      await vi.advanceTimersByTimeAsync(30_000)
      expect(later.state.permissionMode).toBe('ask')
      first.view.text = IDLE
      await vi.advanceTimersByTimeAsync(13_000)
      const r = await result
      expect(r.switched).toHaveLength(1)
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0]).toMatch(/didn't confirm switching to Full access/i)
      expect(first.state.permissionMode).toBe('read-only')
      expect(first.state.modeSwitching).toBeUndefined()
      expect(delivering().size).toBe(0)
    })

    it('at most six at once: a seventh starts when one of them ends', async () => {
      vi.useFakeTimers()
      const list = running(Array(7).fill('full-access'))
      const result = run(() => sessions.applyModeSettings())
      await vi.advanceTimersByTimeAsync(30_000)
      expect(list.slice(0, 6).every((a) => a.state.modeSwitching === 'full-access')).toBe(true)
      expect(list[6].typed()).toEqual([])
      // One answered: Codex says the switch, and the seventh's keys go in.
      list[2].view.text = IDLE
      await vi.advanceTimersByTimeAsync(500)
      ;(list[2].live as { switchTail?: string }).switchTail = SAID
      await vi.advanceTimersByTimeAsync(30_000)
      expect(list[2].state.permissionMode).toBe('full-access')
      expect(list[6].state.modeSwitching).toBe('full-access')
      // The rest stopped: all end, the composers free.
      for (const a of list) s.live.delete(a.id)
      await vi.advanceTimersByTimeAsync(1000)
      const r = await result
      expect(r.switched).toHaveLength(1)
      expect(r.skipped).toHaveLength(6)
      expect(delivering().size).toBe(0)
    })

    /** Seven agents to Full Access: six wait for their warnings' answers and the seventh waits for a free slot. */
    async function queued() {
      vi.useFakeTimers()
      const list = running(Array(7).fill('full-access'))
      const result = run(() => sessions.applyModeSettings())
      await vi.advanceTimersByTimeAsync(30_000)
      expect(list[6].typed()).toEqual([])
      return { list, result }
    }

    it('a queued agent restarted before its turn: nothing typed into the new session, reported as not switched', async () => {
      const { list, result } = await queued()
      const seventh = list[6]
      const restarted = { ...seventh.live, state: { ...seventh.state, runId: 'run-restarted', permissionMode: 'read-only', status: 'ready' }, screen: { text: () => IDLE } }
      s.live.set(seventh.id, restarted)
      // The six stopped: their slots free, the seventh's turn comes.
      for (const a of list.slice(0, 6)) s.live.delete(a.id)
      await vi.advanceTimersByTimeAsync(1000)
      const r = await result
      expect(seventh.typed()).toEqual([])
      expect(restarted.state.permissionMode).toBe('read-only')
      expect((restarted.state as { modeSwitching?: string }).modeSwitching).toBeUndefined()
      expect(r.switched).toEqual([])
      expect(r.skipped).toHaveLength(7)
      expect(r.skipped[6]).toMatch(/session ended before Combwork could switch it/)
      expect(delivering().size).toBe(0)
    })

    it('a queued agent stopped before its turn: nothing typed, reported as not switched', async () => {
      const { list, result } = await queued()
      for (const a of list) s.live.delete(a.id)
      await vi.advanceTimersByTimeAsync(1000)
      const r = await result
      expect(list[6].typed()).toEqual([])
      expect(list[6].state.modeSwitching).toBeUndefined()
      expect(r.skipped).toHaveLength(7)
      expect(r.skipped[6]).toMatch(/session ended before Combwork could switch it/)
      expect(delivering().size).toBe(0)
    })
  })
})
