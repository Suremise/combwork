import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// main/answerRelay.ts's delivery source with its services stood in for (HI-2452): a relay that ends unread tells the
// user, and when telling them fails, that failure is logged, never left as an unhandled rejection.
const st = vi.hoisted(() => ({
  source: null as null | { ended: (r: { meta?: Record<string, unknown> }, host: string) => void },
  warned: [] as { line: string; error: unknown }[],
  noteFails: false,
  noted: [] as number[]
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => undefined, debug: () => undefined, warn: (line: string, error: unknown) => st.warned.push({ line, error }) }),
  userText: (s: string) => s
}))
vi.mock('../src/main/assistantControl', () => ({ allows: () => true }))
vi.mock('../src/main/deliveries', () => ({
  agentReadsInbox: () => true,
  createDelivery: async () => undefined,
  offerNow: async () => undefined,
  registerSource: (_name: string, source: typeof st.source) => (st.source = source)
}))
vi.mock('../src/main/sessions', () => ({ sessions: { notice: () => undefined } }))
vi.mock('../src/main/tasks', () => ({
  noteOnCard: async (card: number) => {
    st.noted.push(card)
    if (st.noteFails) throw new Error('the board is locked')
  }
}))
vi.mock('../src/main/workspace', () => ({ workspaceFor: () => ({ path: 'C:\\ws', assistantHome: 'C:\\ws\\.combwork\\assistant' }) }))

await import('../src/main/answerRelay')

const unhandled: unknown[] = []
const onUnhandled = (e: unknown): void => void unhandled.push(e)

beforeEach(() => {
  st.warned = []
  st.noteFails = false
  st.noted = []
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})
afterEach(() => void process.off('unhandledRejection', onUnhandled))

const HUNG_MS = 10000 // Bounds a hung ended handler; completion is observed through the condition.
/** Waits until the condition holds (the ended handler's work is fire-and-forget). */
async function until(cond: () => boolean, ms: number): Promise<void> {
  await vi.waitFor(() => expect(cond()).toBe(true), { timeout: ms })
}

describe('answerRelay: a relay ended unread', () => {
  it('logs a failure to tell the user, with no unhandled rejection', async () => {
    st.noteFails = true
    st.source!.ended({ meta: { card: 12, project: 'demo', askerName: 'HB1' } }, 'C:\\ws\\.combwork\\assistant')
    await until(() => st.warned.length > 0, HUNG_MS)
    expect(st.warned[0].line).toBe('telling the user an answer reached nobody else')
    expect(String(st.warned[0].error)).toContain('the board is locked')
    // A turn of the event loop, for any unhandled rejection to be reported.
    await new Promise((r) => setImmediate(r))
    expect(unhandled).toEqual([])
  })

  it('tells the user on the card, logging nothing', async () => {
    st.source!.ended({ meta: { card: 12, project: 'demo' } }, 'C:\\ws\\.combwork\\assistant')
    await until(() => st.noted.length > 0, HUNG_MS)
    await new Promise((r) => setImmediate(r))
    expect(st.noted).toEqual([12])
    expect(st.warned).toEqual([])
  })
})
