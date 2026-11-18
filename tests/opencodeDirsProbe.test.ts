import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { suiteOutcome } from './e2e/runner.mjs'
import { timing } from './timing.cjs'

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
  questionsAsked: (messages: object[]) => Set<string>
  permissionAsks: (asks: { phase: string; message: string }[], phase: (p: string) => boolean, questions: Set<string>) => { phase: string; message: string }[]
}

// A bound for a hung poll (under the test's own timeout, so a wrong predicate fails on its assertion), never how long it takes.
const HUNG_MS = timing('wait.hang')
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

describe("opencodereal-dirs: the model's question is no permission asked (HI-3317)", () => {
  it("rc.2's write turn: a wait with qwen3's question (its record's question tool) leaves the write unasked; a folder's permission still counts", () => {
    // As the real tier's record had it on 1.6.0-rc.2: the write, then the question tool, its first question's words.
    const record = [
      user('Use your write tool to create the file C:/copies/p/written-1.txt containing exactly this one line: cw-written-1'),
      { type: 'assistant', content: [{ type: 'tool', name: 'write', state: { status: 'completed', input: { path: 'C:/copies/p/written-1.txt' } } }] },
      { type: 'assistant', content: [{ type: 'tool', name: 'question', state: { status: 'error', input: { questions: [{ header: 'What would you like to do with the file?', question: 'Please select your next action with the file', options: [] }] } } }] }
    ]
    const asks = [
      { phase: 'reviewer (Build): write 1', message: 'Please select your next action with the file' },
      { phase: 'builder (Build): write 1', message: 'external_directory: C:/copies/p/*' },
      { phase: 'builder (Build): write 2', message: 'Questions' }
    ]
    const q = probe.questionsAsked(record)
    expect(probe.permissionAsks(asks, (p) => p.startsWith('reviewer (Build): write'), q)).toEqual([])
    expect(probe.permissionAsks(asks, (p) => p.startsWith('builder (Build): write'), q)).toEqual([asks[1]])
    // With no question in the record, the same wait counts as asked; a long question is matched as Combwork cuts it.
    expect(probe.permissionAsks(asks, (p) => p.startsWith('reviewer'), probe.questionsAsked([]))).toEqual([asks[0]])
    const long = 'q'.repeat(700)
    expect(probe.questionsAsked([{ type: 'assistant', content: [{ type: 'tool', name: 'question', state: { input: { questions: [{ question: long }] } } }] }]).has(long.slice(0, 500))).toBe(true)
  })
})

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
