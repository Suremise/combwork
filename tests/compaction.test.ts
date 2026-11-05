// A compaction Combwork asked for: how it ends when the CLI doesn't say so (the transcript, the CLI refusing it, the
// time limits), and that it ends once, with the status rules deciding what the agent shows.
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BEGIN_MS, Compaction, LIMIT_MS } from '../src/main/compaction'
import { applyStep, compactionOver, hookStep, type HookStatusInput } from '../src/main/hookStatus'
import { COMPACTING_MESSAGE } from '../src/shared/defaults'
import type { SessionStatus } from '../src/shared/types'
import { tempDir } from './tempDir'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// What Combwork types into agents' terminals, recorded instead (no process runs).
const typed = vi.hoisted(() => [] as { key: string; data: string }[])
// Run as each key is written (a test acting at that moment, as the user typing then).
const hooks = vi.hoisted(() => ({ onWrite: null as null | ((key: string, data: string) => void) }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  writePty: (key: string, data: string) => {
    typed.push({ key, data })
    hooks.onWrite?.(key, data)
  }
}))
const { claudeInput } = await import('./claudeInputStandIn')

const claudeFailure = async (): Promise<RegExp | null> => (await import('../src/main/providers/claude/adapter')).claudeCode.compactFailure

/** A transcript's n compactions (their times don't count for Combwork's own Compact). */
const times = (n: number) => Array.from({ length: n }, () => ({ timestamp: '' }))

/**
 * An agent compacting as SessionManager.compact leaves it once its /compact is submitted, whose compaction ends as
 * its `over` callback does.
 */
function compacting(before = 2, failure: RegExp | null = null, submitted = true) {
  const st: { status: SessionStatus; statusMessage?: string } = { status: 'working', statusMessage: COMPACTING_MESSAGE }
  const over = vi.fn(() => applyStep(st, compactionOver(st)))
  const c = new Compaction(before, failure, over)
  if (submitted) c.submitted()
  return { st, over, c }
}

describe('a compaction Combwork asked for', () => {
  it('while its /compact is typed, no limit runs; the time to begin counts from its submission', () => {
    const { c, over } = compacting(2, null, false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(LIMIT_MS * 2)
    expect(over).not.toHaveBeenCalled()
    c.submitted()
    vi.advanceTimersByTime(BEGIN_MS - 1)
    expect(over).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(over).toHaveBeenCalledTimes(1)
  })

  it('not begun within the time it has: over, and the agent ready', () => {
    const { st, over } = compacting()
    vi.advanceTimersByTime(BEGIN_MS - 1)
    expect(over).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(over).toHaveBeenCalledTimes(1)
    expect(st).toEqual({ status: 'ready', statusMessage: undefined })
    vi.advanceTimersByTime(LIMIT_MS)
    expect(over).toHaveBeenCalledTimes(1)
  })

  it('begun: it has the longer limit, then is over', () => {
    const { c, over } = compacting()
    vi.advanceTimersByTime(BEGIN_MS - 1)
    c.begin()
    expect(c.started).toBe(true)
    vi.advanceTimersByTime(LIMIT_MS - 1)
    expect(over).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(over).toHaveBeenCalledTimes(1)
  })

  it('one the CLI began by itself (#1115): only a compaction recorded since it began ends it, however many came before; else its limit', () => {
    const since = Date.parse('2026-10-20T00:00:00Z')
    const at = (ms: number) => ({ timestamp: new Date(since + ms).toISOString() })
    const st: { status: SessionStatus; statusMessage?: string } = { status: 'working', statusMessage: COMPACTING_MESSAGE }
    const over = vi.fn(() => applyStep(st, compactionOver(st)))
    const c = new Compaction({ since }, null, over)
    c.begin()
    // Earlier ones, and one with no time: history.
    c.transcript([at(-60_000), at(-1), { timestamp: '' }])
    expect(over).not.toHaveBeenCalled()
    c.transcript([at(-60_000), at(-1), at(4_000)])
    expect([over.mock.calls.length, st.status]).toEqual([1, 'ready'])
    const unsaid = compacting(0, null, false)
    const quiet = new Compaction({ since }, null, unsaid.over)
    quiet.begin()
    vi.advanceTimersByTime(LIMIT_MS)
    expect([unsaid.over.mock.calls.length, unsaid.st.status]).toEqual([1, 'ready'])
  })

  it('the transcript shows one more compaction than before: over, once; the same count is not', () => {
    const { c, over, st } = compacting(2)
    c.begin()
    c.transcript(times(2))
    expect(over).not.toHaveBeenCalled()
    c.transcript(times(3))
    c.transcript(times(4))
    vi.advanceTimersByTime(LIMIT_MS)
    expect(over).toHaveBeenCalledTimes(1)
    expect(st.status).toBe('ready')
  })

  it('Claude Code refusing or failing it in its terminal: over, even split across chunks', async () => {
    const failure = await claudeFailure()
    const refused = compacting(0, failure)
    refused.c.terminal('\r\n\x1b[2mNot enough\x1b[1Cmessages ')
    expect(refused.over).not.toHaveBeenCalled()
    refused.c.terminal('to compact.\x1b[0m\r\n')
    expect(refused.over).toHaveBeenCalledTimes(1)
    const failed = compacting(0, failure)
    failed.c.begin()
    failed.c.terminal('Error during compaction: Error: API Error: 500')
    expect(failed.over).toHaveBeenCalledTimes(1)
    // Other output doesn't, nor does any for a CLI without a refusal to look for (Codex).
    const busy = compacting(0, failure)
    busy.c.terminal('Compacting conversation…')
    const codex = compacting(0, null)
    codex.c.terminal('Not enough messages to compact.')
    expect([busy.over.mock.calls.length, codex.over.mock.calls.length]).toEqual([0, 0])
  })

  it('ended by a hook (or the session exiting): no timer or later sign fires it', async () => {
    const { c, over } = compacting(0, await claudeFailure())
    c.begin()
    c.end()
    expect(vi.getTimerCount()).toBe(0)
    c.transcript(times(5))
    c.terminal('Not enough messages to compact.')
    c.begin()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(LIMIT_MS * 2)
    expect(over).not.toHaveBeenCalled()
  })

  it('its end unsaid, a prompt began a turn: what Combwork sees later leaves the turn working', () => {
    const { c, st, over } = compacting()
    c.begin()
    const s: HookStatusInput = { ...st, askedAtStart: false, compacting: 'started', backgroundWakes: true, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false }
    const step = hookStep({ kind: 'prompt' }, s)
    applyStep(st, step)
    expect(st).toEqual({ status: 'working', statusMessage: undefined })
    expect(step.actions).toContain('compactEnded')
    // Had the session carried on without the hook's end (say, ended by the transcript just after the prompt):
    c.transcript(times(3))
    expect(over).toHaveBeenCalledTimes(1)
    expect(st).toEqual({ status: 'working', statusMessage: undefined })
  })
})

describe('SessionManager.compact: typing the /compact', () => {
  const ws = tempDir('hive-compact-')
  const project = join(ws, 'proj')
  const FOCUS = 'x'.repeat(24_000) // 3,000 pieces of 8 every 10 ms: about 30 s, longer than BEGIN_MS

  /**
   * A running Claude Code agent, idle, as SessionManager keeps it (no process: what is typed is recorded). Its input is
   * Claude Code's box (claudeInputStandIn, fed what is typed into it: HI-1979, Combwork types into it only once a key of its
   * own shows it empty), holding `draft`; or a screen that only ever shows `shows`.
   */
  async function running(runId = 'run-1', { draft = '', shows }: { draft?: string; shows?: string } = {}) {
    const { sessions } = await import('../src/main/sessions')
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const live = (sessions as unknown as { live: Map<string, unknown> }).live
    const state = { provider: 'claude', runId, projectPath: project, agentId: 'a1', cwd: project, sessionId: '', status: 'ready' as SessionStatus, statusMessage: undefined as string | undefined, startedAt: '', launchSignature: '', unseen: false }
    const input = claudeInput({ draft, paste: false })
    input.from(() => typed.filter((t) => t.key === `session:${project.toLowerCase()}#a1`).map((t) => t.data))
    const screen = shows === undefined ? input.screen : { text: () => shows, textWithoutDim: () => shows, bracketedPaste: () => false }
    const l = { state, adapter: claudeCode, screen, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as { state: typeof state; compacting?: Compaction }
    live.set(`${project.toLowerCase()}#a1`, l)
    return { sessions, live, l, state, input }
  }

  beforeEach(async () => {
    typed.length = 0
    hooks.onWrite = null
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const w = createWorkspaceService()
    w.path = ws
    vi.spyOn(w, 'isProjectPath').mockImplementation((p: string) => p.toLowerCase() === project.toLowerCase())
    return async () => {
      ;((await import('../src/main/sessions')).sessions as unknown as { live: Map<string, unknown> }).live.clear()
      await disposeWorkspaceService(w)
    }
  })

  it('a long focus: compacting while it is typed (a second Compact or a prompt refused), its limit from Enter', async () => {
    const { sessions, l, state } = await running()
    const compact = sessions.compact(project, FOCUS, 'a1')
    const submitted = (): boolean => typed.at(-1)?.data === '\r'
    await vi.advanceTimersByTimeAsync(BEGIN_MS + 5_000)
    expect([submitted(), state.status, state.statusMessage, !!l.compacting]).toEqual([false, 'working', COMPACTING_MESSAGE, true])
    expect(typed.some((t) => t.data === '\r')).toBe(false)
    await expect(sessions.compact(project, undefined, 'a1')).rejects.toThrow(/already compacting/)
    await expect(sessions.sendPrompt(project, 'a1', 'hello')).rejects.toThrow(/already typing/)
    // Typed in full, then submitted.
    while (!submitted()) await vi.advanceTimersByTimeAsync(10)
    await compact
    expect(typed.map((t) => t.data).join('')).toBe(`x\x7f/compact ${FOCUS}\r`)
    // The CLI never begins it: BEGIN_MS from the submission (within the last 10 ms), not from the start of typing.
    await vi.advanceTimersByTimeAsync(BEGIN_MS - 20)
    expect([state.status, !!l.compacting]).toEqual(['working', true])
    await vi.advanceTimersByTimeAsync(20)
    expect([state.status, state.statusMessage, l.compacting]).toEqual(['ready', undefined, undefined])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("Settings → Advanced's draft switch (#1286): on, Ctrl+U clears the CLI's input first; off, none", async () => {
    const { advanced } = await import('../src/main/advanced')
    const { PROMPT_CLEAR_DRAFT } = await import('../src/shared/advanced')
    const { sessions } = await running()
    const get = advanced.get.bind(advanced)
    for (const clear of [true, false]) {
      typed.length = 0
      const spy = vi.spyOn(advanced, 'get').mockImplementation(((id: string, own?: Record<string, unknown> | null) => (id === PROMPT_CLEAR_DRAFT ? clear : get(id, own))) as typeof advanced.get)
      try {
        const compact = sessions.compact(project, 'short', 'a1')
        while (typed.at(-1)?.data !== '\r') await vi.advanceTimersByTimeAsync(10)
        await compact
      } finally {
        spy.mockRestore()
      }
      expect(typed.map((t) => t.data).join(''), `clear ${clear}`).toBe(`${clear ? 'x\x7f' : ''}/compact short\r`)
      // Ended as the CLI never begins it, so the next one can start.
      await vi.advanceTimersByTimeAsync(BEGIN_MS + 100)
    }
  })

  it("Claude Code's input box not seen empty (HI-1979): Compact is refused after one Ctrl+U, and /compact isn't typed", async () => {
    const { sessions, l, state } = await running('run-1', { shows: 'no input box on this screen' })
    const compact = sessions.compact(project, 'short', 'a1')
    const failed = expect(compact).rejects.toThrow(/couldn't be seen empty/)
    await vi.advanceTimersByTimeAsync(5_000)
    await failed
    expect(typed.map((t) => t.data)).toEqual(['\x15'])
    // Nothing is left reserved: the agent is as it was, and the next Compact can start.
    expect([state.status, l.compacting]).toEqual(['ready', undefined])
  })

  it("the user typing as Compact clears the input (HI-1979, HR6's round 1): no more keys, /compact isn't typed, what's left of the draft stays", async () => {
    const { sessions, l, state, input } = await running('run-1', { draft: `${'a draft of two rows, '.repeat(4)}end` })
    // They type as the first Ctrl+U goes in.
    hooks.onWrite = (key, data) => {
      if (data !== '\x15') return
      hooks.onWrite = null
      sessions.noteUserInput(key, 'y')
    }
    const compact = sessions.compact(project, 'short', 'a1')
    const failed = expect(compact).rejects.toThrow(/You typed in the agent's terminal/)
    await vi.advanceTimersByTimeAsync(5_000)
    await failed
    expect(typed.map((t) => t.data)).toEqual(['\x15'])
    expect(input.input.text, "the draft's first row").toBe('a draft of two rows, '.repeat(4).slice(0, 58))
    expect([state.status, l.compacting]).toEqual(['ready', undefined])
  })

  it('while Combwork types a prompt into the agent, Compact is refused (the two would mix)', async () => {
    const { sessions, l, state } = await running()
    const prompt = sessions.sendPrompt(project, 'a1', FOCUS)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(sessions.compact(project, undefined, 'a1')).rejects.toThrow(/already typing/)
    expect([state.status, l.compacting]).toEqual(['ready', undefined])
    while (typed.at(-1)?.data !== '\r') await vi.advanceTimersByTimeAsync(100)
    await prompt
  })

  it('the agent restarts while it is typed: the rest goes nowhere, and nothing is left reserved', async () => {
    const first = await running('run-1')
    const compact = first.sessions.compact(project, FOCUS, 'a1')
    const failed = expect(compact).rejects.toThrow(/stopped/)
    await vi.advanceTimersByTimeAsync(2_000)
    const sent = typed.length
    // Restarted: a new run of the same agent (the same terminal key) takes its place.
    const second = await running('run-2')
    await vi.advanceTimersByTimeAsync(40_000)
    await failed
    // At most the piece already on its way when the run changed.
    expect(typed.length - sent).toBeLessThanOrEqual(1)
    expect(typed.some((t) => t.data === '\r')).toBe(false)
    expect([first.l.compacting, first.state.status]).toEqual([undefined, 'working'])
    expect([second.state.status, second.l.compacting]).toEqual(['ready', undefined])
    expect(vi.getTimerCount()).toBe(0)
    // The new run can be compacted.
    const again = second.sessions.compact(project, 'short', 'a1')
    await vi.advanceTimersByTimeAsync(1_000)
    await again
    expect(second.l.compacting?.started).toBe(false)
  })
})
