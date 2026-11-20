// An input box that stays off the screen (HI-3411): a real user's Claude Code agents, in a card watch, had a dialog of their
// CLI's drawn in the input box's place, which Combwork didn't recognise. Every wake, message and slot hand-off was refused
// every 2.5 s for days ("its input box isn't on the screen"), about 14,000 times, and nobody was told. With the real
// SessionManager on a stand-in Claude Code input (claudeInputStandIn) showing a dialog in its place: a clear refused for that
// starts its time hidden; past Advanced's Input box hidden: wait, its input is blocked as HI-2191's is (the agent waits for the
// user, told once, nothing more typed: no key pressed, whyNoLine says why, so a slot's hand-off waits); the box drawn again
// frees it, whoever answered the dialog, and what waited is typed once.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeInput, type ClaudeInput } from './claudeInputStandIn'
import { timing } from './timing.cjs'

const { writes, echo } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } } }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void (writes.push(data), echo.to?.write(data)) }))
const { sessions, INPUT_HIDDEN_SECONDS } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { advanced } = await import('../src/main/advanced')
const { hookStep } = await import('../src/main/hookStatus')
const writer = await import('../src/main/lineWriter')

const project = 'C:/combwork-test/input-hidden'
const id = 'b1'
const key = `${project.toLowerCase()}#${id}`
type Entry = Record<string, unknown> & {
  state: Record<string, unknown> & { status: string; runId: string; inputBlocked?: { since: string }; statusMessage?: unknown }
  inputBlocked?: { hidden?: boolean }
  boxHidden?: { since: number }
}
const s = sessions as unknown as {
  live: Map<string, Entry>
  delivering: Set<string>
  notify: (...a: unknown[]) => void
  watchFor: (...a: unknown[]) => unknown
  inputBlockedDrawn(id: string, l: Entry): void
  carryOut(id: string, l: Entry, step: unknown, cause: string, ev?: unknown): void
  statusInput(l: Entry): unknown
}
const liveKey = (): string => [...s.live.keys()].find((k) => s.live.get(k)?.state.agentId === id) ?? ''
const DIALOG = 'Choose how this session is kept\n❯ 1. Keep it\n  2. Discard it\nEnter to confirm · Esc to cancel'
let claude: ClaudeInput | null = null

/** A running agent waiting on its cards (a card watch), a dialog of its CLI's in its input box's place. */
function watching(): Entry {
  claude = claudeInput({ paste: true })
  claude.input.dialog = DIALOG
  echo.to = { write: claude.feed }
  vi.spyOn(s, 'watchFor').mockReturnValue({ cards: [1] })
  const e: Entry = { state: { projectPath: project, agentId: id, agentName: 'HB5', runId: 'run1', status: 'watching', open: [] }, adapter: claudeCode, screen: claude.screen, prompts: 0, open: [] }
  s.live.set(key, e)
  return e
}
/** Advanced's wait for each key made short; its time hidden as set. */
const settings = (): void => {
  const number = advanced.number.bind(advanced)
  vi.spyOn(advanced, 'number').mockImplementation((setting: string) => (setting === 'claude-code.prompt.clearKeySeconds' ? 0.2 : number(setting)))
}
const hiddenMs = (): number => advanced.number(INPUT_HIDDEN_SECONDS) * 1000
/** A wake's try: refused because the box isn't on the screen. */
const refusedTry = (): Promise<void> => expect(sessions.sendPrompt(project, id, '[CW] New in your inbox: 1 message')).rejects.toThrow(/couldn't be seen empty/)
/** Time passes: its box hidden since `ms` ago. */
const hiddenFor = (e: Entry, ms: number): void => {
  e.boxHidden!.since = Date.now() - ms
}

describe('an input box that stays off the screen (HI-3411)', () => {
  afterEach(() => {
    s.live.delete(key)
    s.delivering.clear()
    writes.length = 0
    echo.to = null
    claude = null
    vi.restoreAllMocks()
  })

  it('Advanced: minutes, not seconds', () => {
    expect(advanced.number(INPUT_HIDDEN_SECONDS)).toBe(120)
  })

  it('on a watching agent: refused within the wait, then blocked once past it (told once), with nothing more typed and why said', async () => {
    settings()
    const notified = vi.spyOn(s, 'notify').mockImplementation(() => undefined)
    const e = watching()
    await refusedTry()
    expect(e.boxHidden?.since, 'its time hidden starts at the first refusal').toBeTruthy()
    hiddenFor(e, hiddenMs() - 5000)
    await refusedTry()
    expect(sessions.inputBlocked(project, id), 'within the wait: not yet').toBe(false)
    expect(e.state.status).toBe('watching')
    expect(notified).not.toHaveBeenCalled()
    hiddenFor(e, hiddenMs() + 1000)
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(true)
    expect(e.inputBlocked?.hidden).toBe(true)
    expect(e.state.status).toBe('waiting')
    expect(String(e.state.statusMessage)).toMatch(/Something on its screen is taking its keys/)
    expect(notified).toHaveBeenCalledTimes(1)
    // Bounded: no key pressed for what comes after (a wake, a message, an Enter again), each refused with why.
    writes.length = 0
    await expect(sessions.sendPrompt(project, id, 'more')).rejects.toThrow(/taking its keys/)
    expect(await writer.typeLine(project, id, '[CW] New in your inbox: 2 messages', () => true)).toBe(false)
    expect(sessions.submitAgain(project, id, 'run1')).toBe(false)
    expect(writes).toEqual([])
    expect(notified, 'told once, not every try').toHaveBeenCalledTimes(1)
    // A slot's hand-off waits for it (whyNoLine with free), as a delivery given now is cancelled saying why.
    expect(writer.whyNoLine(project, id, 'free')).toMatch(/taking its keys/)
    expect(writer.whyNoLine(project, id)).toMatch(/taking its keys/)
  }, timing('test.hang'))

  it('the dialog answered (the box drawn again): free, watching again, and what waited is typed once', async () => {
    settings()
    vi.spyOn(s, 'notify').mockImplementation(() => undefined)
    const e = watching()
    await refusedTry()
    hiddenFor(e, hiddenMs() + 1000)
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(true)
    // Drawn again with the dialog still there: still blocked.
    s.inputBlockedDrawn(liveKey(), e)
    expect(sessions.inputBlocked(project, id)).toBe(true)
    // The user answers it in the pane (Enter): its box is back.
    claude!.feed('\r')
    s.inputBlockedDrawn(liveKey(), e)
    expect(sessions.inputBlocked(project, id)).toBe(false)
    expect(e.boxHidden).toBeUndefined()
    expect(e.state.inputBlocked).toBeUndefined()
    expect(e.state.status).toBe('watching')
    writes.length = 0
    expect(writer.whyNoLine(project, id)).toBeNull()
    expect(await writer.typeLine(project, id, '[CW] New in your inbox: 1 message', () => true)).toBe(true)
    expect(claude!.input.sent).toEqual(['[CW] New in your inbox: 1 message'])
  }, timing('test.hang'))

  it('its box seen within the wait starts its time again; a clear that empties it does too', async () => {
    settings()
    const e = watching()
    await refusedTry()
    hiddenFor(e, hiddenMs() - 1000)
    claude!.input.dialog = null
    s.inputBlockedDrawn(liveKey(), e)
    expect(e.boxHidden, 'the box drawn').toBeUndefined()
    claude!.input.dialog = DIALOG
    await refusedTry()
    hiddenFor(e, hiddenMs() - 1000)
    claude!.input.dialog = null
    // No draw seen meanwhile: the next clear finds the box empty, and its time hidden is over.
    await sessions.sendPrompt(project, id, 'hello')
    expect(e.boxHidden).toBeUndefined()
    expect(sessions.inputBlocked(project, id)).toBe(false)
  }, timing('test.hang'))

  it('a hook that moves it frees it; a new run starts its time afresh', async () => {
    settings()
    vi.spyOn(s, 'notify').mockImplementation(() => undefined)
    const e = watching()
    await refusedTry()
    hiddenFor(e, hiddenMs() + 1000)
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(true)
    const ev = { kind: 'prompt' }
    s.carryOut(liveKey(), e, hookStep(ev as never, s.statusInput(e) as never), 'Hook', ev)
    expect(sessions.inputBlocked(project, id)).toBe(false)
    expect(e.boxHidden).toBeUndefined()
    // Another launch: what the last one counted doesn't count.
    await refusedTry()
    e.state.runId = 'run2'
    e.state.status = 'watching'
    await refusedTry()
    expect(sessions.inputBlocked(project, id)).toBe(false)
  }, timing('test.hang'))
})
