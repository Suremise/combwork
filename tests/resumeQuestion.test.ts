// HI-3360 (HR3's round 1): the question the window's Resume asks is decided at the click, from the row's last activity
// against Settings → Advanced's threshold and switch as they are then, never from the `idle` the list carried when it
// loaded: a row loaded warm and left open past the threshold, or across a change of the setting, asks all the same.
// The real renderer action's decision, with the window's IPC faked; that nothing starts before the answer is idleresume's
// (tests/e2e: Escape starts nothing, Resume resumes).
import { describe, expect, it } from 'vitest'
import { RESUME_IDLE_ASK, RESUME_IDLE_MINUTES } from '../src/shared/advanced'

;(globalThis as unknown as { window: unknown }).window = {
  combwork: { invoke: async () => null, on: () => () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}

interface Row {
  fresh?: string
  lastActivity?: string | null
  usage?: { contextTokens: number } | null
  transcriptBytes?: number | null
  recache: { tokens: number; warm: boolean; secondsLeft: number; ttlSeconds: number } | null
  idle?: unknown
}
type Question = { is: 'fresh' } | { is: 'idle'; idle: { idleMs: number; tokens: number | null; bytes: number | null } } | { is: 'recache' } | null
// The renderer's module, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
const rendererActions = '../src/renderer/src/actions'
const actions = (await import(/* @vite-ignore */ rendererActions)) as {
  resumeQuestion: (item: Row, advanced: unknown, now?: number) => Question
  restartItem: (live: { sessionId: string; agentId: string }, item: { name?: string; cwd?: string; slot?: string } | undefined) => Row
}

const loadedAt = Date.parse('2026-11-18T10:00:00.000Z')
const minutes = (n: number): number => n * 60_000
/** Settings → Advanced's state with these overrides (none: the defaults, on and 60 minutes). */
const advanced = (values: Record<string, unknown> = {}) => ({ file: '', fileError: null, values, madeFor: {}, unknown: [], workspace: null, cli: {} })
/** A Codex row (no prompt-cache TTL, so no re-cache estimate): active half an hour before the list loaded, warm then. */
const codexRow = (): Row => ({ lastActivity: new Date(loadedAt - minutes(30)).toISOString(), usage: { contextTokens: 90_000 }, transcriptBytes: 2_000_000, recache: null })

describe("Resume's question, decided at the click (HI-3360)", () => {
  it('a row loaded warm and left open past the threshold asks at the click, with its age and size then', () => {
    const row = codexRow()
    expect(actions.resumeQuestion(row, advanced(), loadedAt)).toBeNull()
    // Two hours later, the list never refreshed (nothing changed): its `idle` still absent, the question asked all the same.
    const later = actions.resumeQuestion(row, advanced(), loadedAt + minutes(120))
    expect(later).toMatchObject({ is: 'idle', idle: { idleMs: minutes(150), tokens: 90_000, bytes: 2_000_000 } })
  })

  it("the setting as it is at the click: turned off since, nothing asked; a shorter threshold since, asked", () => {
    const row = codexRow()
    expect(actions.resumeQuestion(row, advanced({ [RESUME_IDLE_ASK]: false }), loadedAt + minutes(120))).toBeNull()
    expect(actions.resumeQuestion(row, advanced({ [RESUME_IDLE_MINUTES]: 20 }), loadedAt)).toMatchObject({ is: 'idle' })
  })

  it("a row's stale `idle` from the list, now off: nothing asked (the list's word is never the decision)", () => {
    const row = { ...codexRow(), idle: { since: 'x', idleMs: 1, tokens: 1, bytes: 1 } }
    expect(actions.resumeQuestion(row, advanced({ [RESUME_IDLE_ASK]: false }), loadedAt)).toBeNull()
  })

  it("HI-2540's can't-continue first; small ones never; an expired cache as before; a restart's row never long idle", () => {
    expect(actions.resumeQuestion({ ...codexRow(), fresh: 'renamed' }, advanced(), loadedAt + minutes(600))).toEqual({ is: 'fresh' })
    expect(actions.resumeQuestion({ ...codexRow(), usage: { contextTokens: 5_000 } }, advanced(), loadedAt + minutes(600))).toBeNull()
    expect(actions.resumeQuestion({ lastActivity: null, recache: { tokens: 60_000, warm: false, secondsLeft: 0, ttlSeconds: 300 } }, advanced(), loadedAt)).toEqual({ is: 'recache' })
    const restart = actions.restartItem({ sessionId: 's1', agentId: 'a1' }, { name: 'x', cwd: 'D:\\ws\\alpha' })
    expect(actions.resumeQuestion(restart, advanced(), loadedAt + minutes(10_000))).toBeNull()
  })
})
