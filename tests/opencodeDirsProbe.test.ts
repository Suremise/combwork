import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { suiteOutcome } from './e2e/runner.mjs'

// opencodereal-dirs.cjs's record reading and its end (HI-2772, HR1's round 1): the real suite's two ways of saying what a
// model run proved, checked without a model.
const require = createRequire(import.meta.url)
type Tool = { name: string; status: string | null; result: string }
const probe = require('./e2e/opencodeDirsProbe.cjs') as {
  toolsOfTurn: (messages: object[], nonce: string) => Tool[] | null
  ended: (t: Tool) => boolean
  turnTools: (read: () => object[], nonce: string, ready: (t: Tool[]) => boolean, until: (fn: () => unknown, ms: number) => Promise<unknown>, ms: number) => Promise<Tool[] | null>
  ending: (r: { failed: number; inconclusive: string[] }) => { line: string; code: number }
}

/** lib.until's contract (a value, or null at the bound), polling each turn of the event loop rather than sleeping. */
async function until<T>(fn: () => T, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return null
    await new Promise((r) => setImmediate(r))
  }
}

const user = (text: string) => ({ type: 'user', text })
const tool = (status: string, text = '') => ({ type: 'assistant', content: [{ type: 'tool', name: 'read', state: { status, input: { path: 'm.txt' }, content: text ? [{ type: 'text', text }] : [] } }] })

describe("opencodereal-dirs: a run that proves nothing isn't a pass", () => {
  it('a step the model never tried ends the run SKIPPED, as the runner reads it; a failed check fails it; else it passed', () => {
    const run = (r: { failed: number; inconclusive: string[] }) => {
      const e = probe.ending(r)
      return suiteOutcome({ code: e.code, out: `PASS something\nINCONCLUSIVE a step\n${e.line}\n` })
    }
    const skipped = run({ failed: 0, inconclusive: ["the Build reviewer's read"] })
    expect(skipped).toMatchObject({ skipped: expect.stringMatching(/^inconclusive: .*the Build reviewer's read/), environment: false })
    expect(skipped).not.toHaveProperty('ok')
    expect(run({ failed: 1, inconclusive: ['x'] })).toMatchObject({ ok: false })
    expect(run({ failed: 0, inconclusive: [] })).toEqual({ ok: true, failed: [] })
  })
})

describe("opencodereal-dirs: a turn's tools, from a record mirrored as it comes", () => {
  it("waits for the tool's end: the turn's user message first, its tool running, then its result", async () => {
    // What Combwork's mirror has, read after read: the user row alone, the call running, then its result.
    const stages = [[user('read m.txt nonce-1')], [user('read m.txt nonce-1'), tool('running')], [user('read m.txt nonce-1'), tool('completed', '1: cw-marker')]]
    let reads = 0
    const read = () => stages[Math.min(reads++, stages.length - 1)]
    const readEnded = (t: Tool[]) => t.some((x) => x.name === 'read' && probe.ended(x))
    // The user row alone is a turn with no tools yet ([], which is truthy): never taken as its result.
    expect(probe.toolsOfTurn(stages[0], 'nonce-1')).toEqual([])
    const got = await probe.turnTools(read, 'nonce-1', readEnded, until, 20000)
    expect(got).toEqual([{ name: 'read', status: 'completed', input: { path: 'm.txt' }, result: '1: cw-marker', error: null }])
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it("at the bound, what it had: null before the turn's user message, its tools so far after; another turn's tools never", async () => {
    const readEnded = (t: Tool[]) => t.some((x) => x.name === 'read' && probe.ended(x))
    expect(await probe.turnTools(() => [], 'nonce-2', readEnded, until, 0)).toBeNull()
    expect(await probe.turnTools(() => [user('nonce-2'), tool('running')], 'nonce-2', readEnded, until, 0)).toEqual([expect.objectContaining({ status: 'running' })])
    // A later prompt's tool isn't this turn's.
    expect(probe.toolsOfTurn([user('nonce-3'), user('nonce-4'), tool('completed', 'x')], 'nonce-3')).toEqual([])
  })
})
