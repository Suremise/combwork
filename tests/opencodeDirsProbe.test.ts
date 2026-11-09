import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { suiteOutcome } from './e2e/runner.mjs'

// opencodereal-dirs.cjs's record reading and its end (HI-2772, HR1's round 1): the real suite's two ways of saying what a
// model run proved, checked without a model.
const require = createRequire(import.meta.url)
type Tool = { name: string; status: string | null; result: string; input?: { path?: string; filePath?: string } | null }
const probe = require('./e2e/opencodeDirsProbe.cjs') as {
  toolsOfTurn: (messages: object[], nonce: string) => Tool[] | null
  ended: (t: Tool) => boolean
  readOf: (file: string) => (tools: Tool[]) => Tool | null
  writeOf: (file: string) => (tools: Tool[]) => Tool | null
  turnTools: (read: () => object[], nonce: string, ready: (t: Tool[]) => unknown, until: (fn: () => unknown, ms: number) => Promise<unknown>, ms: number) => Promise<Tool[] | null>
  ending: (r: { failed: number; inconclusive: string[] }) => { line: string; code: number }
}

// A bound for a hung poll (under the test's own timeout, so a wrong predicate fails on its assertion), never how long it takes.
const HUNG_MS = 10000
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
const tool = (status: string, text = '', name = 'read', file = 'C:/copies/p/m.txt') => ({ type: 'assistant', content: [{ type: 'tool', name, state: { status, input: { path: file }, content: text ? [{ type: 'text', text }] : [] } }] })
// The attempt's own file as the probe names it (backslashes, another case): the suite's own predicates.
const FILE = String.raw`C:\Copies\p\M.txt`

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
    const readEnded = probe.readOf(FILE)
    // The user row alone is a turn with no tools yet ([], which is truthy): never taken as its result.
    expect(probe.toolsOfTurn(stages[0], 'nonce-1')).toEqual([])
    const got = await probe.turnTools(read, 'nonce-1', readEnded, until, HUNG_MS)
    expect(got).toEqual([{ name: 'read', status: 'completed', input: { path: 'C:/copies/p/m.txt' }, result: '1: cw-marker', error: null }])
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it("at the bound, what it had: null before the turn's user message, its tools so far after; another turn's tools never", async () => {
    const readEnded = probe.readOf(FILE)
    expect(await probe.turnTools(() => [], 'nonce-2', readEnded, until, 0)).toBeNull()
    expect(await probe.turnTools(() => [user('nonce-2'), tool('running')], 'nonce-2', readEnded, until, 0)).toEqual([expect.objectContaining({ status: 'running' })])
    // A later prompt's tool isn't this turn's.
    expect(probe.toolsOfTurn([user('nonce-3'), user('nonce-4'), tool('completed', 'x')], 'nonce-3')).toEqual([])
  })

  it("waits for the attempt's own file: another file's read that ends first (AGENTS.md) doesn't count, nor another file's write in Plan", async () => {
    const agents = tool('completed', '# rules', 'read', 'C:/proj/AGENTS.md')
    const stages = [[user('nonce-5'), agents], [user('nonce-5'), agents, tool('completed', '1: cw-marker')]]
    let reads = 0
    const got = await probe.turnTools(() => stages[Math.min(reads++, stages.length - 1)], 'nonce-5', probe.readOf(FILE), until, HUNG_MS)
    expect(probe.readOf(FILE)(got!)).toMatchObject({ status: 'completed', result: '1: cw-marker' })
    expect(reads).toBeGreaterThanOrEqual(2)
    // Plan: its own plan file written first, then the asked-for file's write refused; only the latter is the attempt's.
    const planFile = tool('completed', '', 'write', 'C:/home/.opencode/plan/plan.md')
    const refused = { type: 'assistant', content: [{ type: 'tool', name: 'write', state: { status: 'error', input: { path: 'c:/copies/p/m.txt' }, error: { message: 'Cannot use write to modify files outside the Plan directory' } } }] }
    expect(probe.writeOf(FILE)(probe.toolsOfTurn([user('nonce-6'), planFile], 'nonce-6')!)).toBeNull()
    expect(probe.writeOf(FILE)(probe.toolsOfTurn([user('nonce-6'), planFile, refused], 'nonce-6')!)).toMatchObject({ status: 'error', error: expect.stringMatching(/outside the Plan directory/) })
  })
})
