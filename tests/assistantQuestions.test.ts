// The Assistant's questions to the user (assistantControl.ask: stopping a busy agent asks first). HI-1994: whatever ends
// the wait closes the question, so none is left open in the Assistant's panel with nobody waiting on it: the user's
// answer, its time up (the Assistant told it timed out), or its caller gone (the Agent API's request aborted); an answer
// after that is nothing.
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-assistant-ask-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { answer, ask, questions } = await import('../src/main/assistantControl')
const { STOP_ASK_MS, REPLY_MS } = await import('../src/main/mcp/agentApiCall')

const WS = join(base, 'ws')
const q = { title: 'Stop HR1 in alpha?', message: 'The Assistant wants to stop HR1, which is working.', yes: 'Stop', no: "Don't stop" }

describe("the Assistant's questions to the user (HI-1994)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("the user's answer ends it, and the question closes", async () => {
    const yes = ask(WS, q)
    const [open] = questions(WS)
    expect(open.title).toBe(q.title)
    answer(open.id, true)
    expect(await yes).toBe('yes')
    expect(questions(WS)).toEqual([])
    const no = ask(WS, q)
    answer(questions(WS)[0].id, false)
    expect(await no).toBe('no')
    expect(questions(WS)).toEqual([])
  })

  it('unanswered in time: timed out, the question closed, and a later answer is nothing', async () => {
    vi.useFakeTimers()
    const how = ask(WS, q, { timeoutMs: 1000 })
    const id = questions(WS)[0].id
    await vi.advanceTimersByTimeAsync(1000)
    expect(await how).toBe('timedOut')
    expect(questions(WS)).toEqual([])
    // The user clicks Stop on a card that has gone (or that the window still showed): nothing waits on it.
    expect(() => answer(id, true)).not.toThrow()
    expect(questions(WS)).toEqual([])
  })

  it('its caller gone (the request aborted): withdrawn at once, never left open', async () => {
    const caller = new AbortController()
    const how = ask(WS, q, { timeoutMs: 60_000, signal: caller.signal })
    expect(questions(WS)).toHaveLength(1)
    caller.abort()
    expect(await how).toBe('gone')
    expect(questions(WS)).toEqual([])
    // Already gone when asked: never shown.
    expect(await ask(WS, q, { signal: caller.signal })).toBe('gone')
    expect(questions(WS)).toEqual([])
  })

  it("a stop's wait ends before Combwork's tools stop waiting for its reply, so the Assistant hears it timed out", () => {
    expect(STOP_ASK_MS).toBeLessThan(REPLY_MS)
    expect(REPLY_MS - STOP_ASK_MS).toBeGreaterThanOrEqual(30_000)
  })
})
