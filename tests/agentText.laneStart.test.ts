// Dialects (HI-2065), card 5 (HI-2438): the canary dialect over what a lane's start, its brief's delivery, a card's
// finish and the last run's unexpected close say to agents. Every word of what a session gets comes through the
// catalogue; what is stored for any reader (journal facts, a delivery's sender or cancel reason, a lane's startedBy) stays
// the Default's whatever the scope, until stored text is said when read (5b, 6b).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { inDialectOf, setChainResolver, setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const state = vi.hoisted(() => ({ live: new Set<string>(), fail: null as string | null, prompts: [] as string[] }))
vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveFor: (_p: string, id: string) => (state.live.has(id) ? { status: 'ready' } : null),
    start: async (_p: string, o: { agentId: string; prompt: string }) => {
      if (state.fail) throw new Error(state.fail)
      state.prompts.push(o.prompt)
      return { runId: 'r' }
    }
  }
}))

const { recordedLaneNote, resumeLaneBuilder } = await import('../src/main/laneStart')
const { briefText } = await import('../src/main/laneBriefs')
const { doneFact } = await import('../src/main/finishPath')
const { assistantLine, closeFact } = await import('../src/main/lastRun')

const ROOT = join(__dirname, '..')
type Catalogue = Record<string, { text: string; note?: string }>
const catalogue = readCatalogue(ROOT) as Catalogue
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
const canary = (): void => setProcessChain(chain(canaryTexts(catalogue)))
const AREAS = ['brief.start.', 'brief.record.', 'restart.', 'finish.']
const mine = [...ids].filter((id) => AREAS.some((a) => id.startsWith(a)))
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')

afterEach(() => {
  setProcessChain(null)
  setChainResolver(null)
  state.live.clear()
  state.fail = null
  state.prompts = []
})

type Note = Parameters<typeof recordedLaneNote>[0]
const NOTES: { name: string; note: Note; values: string[] }[] = [
  { name: 'started', note: { started: [{ agentId: 'b', name: 'B1', role: 'builder', how: 'started' }], running: [] } as Note, values: ['B1'] },
  { name: 'started two, slot', note: { started: [{ agentId: 'b', name: 'B2', role: 'builder', how: 'started' }, { agentId: 'r', name: 'R1', role: 'reviewer', how: 'started' }], slot: 'slot-c', running: [] } as Note, values: ['B2', 'R1', 'slot-c'] },
  { name: 'fresh, deferred', note: { started: [{ agentId: 'b', name: 'B1', role: 'builder', how: 'fresh' }, { agentId: 'r', name: 'R1', role: 'reviewer', how: 'deferred' }], running: [] } as Note, values: ['B1', 'R1'] },
  { name: 'failed one', note: { started: [{ agentId: 'b', name: 'B1', role: 'builder', how: 'failed', why: 'no CLI' }], running: [] } as Note, values: ['B1', 'no CLI'] },
  { name: 'failed two', note: { started: [{ agentId: 'b', name: 'B1', role: 'builder', how: 'failed' }, { agentId: 'r', name: 'R1', role: 'reviewer', how: 'failed', why: 'x' }], running: [] } as Note, values: ['B1', 'R1', 'x'] },
  { name: 'by Hive, tell one', note: { started: [], running: ['B1', 'R1'], builder: 'B1', firstCardByHive: true } as Note, values: ['B1', 'R1'] },
  { name: 'tell two', note: { started: [], running: ['B1', 'R1'], builder: 'B1' } as Note, values: ['B1', 'R1'] },
  { name: 'no slot', note: { started: [], waitingForSlot: 'all 3 lent', running: ['R1'] } as Note, values: ['R1', 'all 3 lent'] }
]
const CLOSE = { lastSeen: '2026-11-03 10:00', agents: [{ agentName: 'B1', project: 'alpha' }, { agentName: 'R1', project: 'beta' }] } as Parameters<typeof assistantLine>[0]
const REPORTS: Parameters<typeof assistantLine>[1][] = [null, { resumed: [{}], failed: [], held: [] } as never, { resumed: [{}, {}], failed: [{}], held: [{}, {}] } as never, { resumed: [], failed: [] } as never]

describe("the lane start's and the unexpected close's text, in the Default", () => {
  it('reads as it always has', () => {
    expect(NOTES.map((n) => recordedLaneNote(n.note))).toEqual([
      "Started B1 with the lane's brief.",
      "Started B2 and R1 with the lane's brief, in slot-c.",
      "Gave B1 the lane in a new conversation (its last stays in its Sessions history): don't prompt it. R1 wasn't free: Combwork gives it the lane in a new conversation once it is, so don't prompt it.",
      "B1 didn't start (no CLI): start it yourself.",
      "B1 didn't start (unknown); R1 didn't start (x): start them yourself.",
      "B1 is running, so Combwork left it as it is: Combwork gives it the lane's first card itself once it is free, so don't prompt it. R1 is running, so Combwork left it as it is: tell it about the lane.",
      'B1 and R1 are running, so Combwork left them as they are: tell them about the lane.',
      'No slot is free (all 3 lent): the lane waits for one, and its stopped agents start once it is lent. R1 is running, so Combwork left it as it is: tell it about the lane.'
    ])
    expect(REPORTS.map((r) => assistantLine(CLOSE, r, 0))).toEqual([
      "Combwork closed unexpectedly: last seen 2026-11-03 10:00. 2 agent(s) were running: B1 (alpha), R1 (beta). Nothing was resumed: the user decides. Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself.",
      "Combwork closed unexpectedly: last seen 2026-11-03 10:00. 2 agent(s) were running: B1 (alpha), R1 (beta). Combwork resumed 1 of them (the user's setting). Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself.",
      "Combwork closed unexpectedly: last seen 2026-11-03 10:00. 2 agent(s) were running: B1 (alpha), R1 (beta). Combwork resumed 2 of them (the user's setting); 1 couldn't resume; 2 left stopped (their slots are free, to resume by hand, or hold other work). Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself.",
      "Combwork closed unexpectedly: last seen 2026-11-03 10:00. 2 agent(s) were running: B1 (alpha), R1 (beta). Combwork resumed 0 of them (the user's setting). Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself."
    ])
    expect(assistantLine({ ...CLOSE, agents: [] }, null, 3)).toBe(
      "Combwork closed unexpectedly: last seen 2026-11-03 10:00. No agents were running. 3 process(es) the agents started are still running; the user can stop them from Combwork's notice. Check for card loops and lanes that stalled and tell the user; don't restart or stop anything yourself."
    )
    expect(closeFact('2026-11-03 10:00', 1)).toBe('Combwork closed unexpectedly (last seen 2026-11-03 10:00); 1 agent(s) of this workspace were running')
    expect(doneFact('#7', 'Fix {it}', 'queue', 'user')).toBe('#7 "Fix {it}" is Done (merged by the merge queue), by You')
    expect(['reported', 'unchecked', 'accepted', 'override', 'board'].map((h) => doneFact('AL-2', 'T', h as never, 'B1'))).toEqual([
      'AL-2 "T" is Done (merged, reported by its builder), by B1',
      'AL-2 "T" is Done (reported merged by its builder, not checked), by B1',
      'AL-2 "T" is Done (accepted), by B1',
      'AL-2 "T" is Done (moved there by an override), by B1',
      'AL-2 "T" is Done (moved there on the board), by B1'
    ])
    expect(briefText({ id: 'lane-1', startedBy: 'the user' }, 'Keep {it} short.')).toBe("Your lane's brief (lane lane-1, from the user):\nKeep {it} short.")
  })

  it("starts a lane's stopped builder with its prompt, and says what happened", async () => {
    expect(await resumeLaneBuilder('C:/ws/alpha', { id: 'lane-1', builder: { id: 'b', name: 'B1' } })).toBe("B1 wasn't running: started it on the lane.")
    expect(state.prompts).toEqual(['Use card-loop as the builder of lane lane-1: cw_lane next names your card.'])
    state.fail = 'no CLI'
    expect(await resumeLaneBuilder('C:/ws/alpha', { id: 'lane-1', builder: { id: 'b', name: 'B1' } })).toBe("B1 isn't running and couldn't be started (no CLI): start it for the lane to go on.")
  })
})

describe('the canary dialect over them (card 5)', () => {
  it('finds every word in the catalogue, and every reachable id said', async () => {
    canary()
    const seen = new Set<string>()
    const check = (name: string, text: string, values: string[]): void => {
      expect(canaryProblems(text, ids, values), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    for (const n of NOTES) check(n.name, recordedLaneNote(n.note), n.values)
    for (const r of REPORTS) for (const still of [0, 2]) check(`close ${still}`, assistantLine(CLOSE, r, still), ['2026-11-03 10:00', 'B1 (alpha), R1 (beta)'])
    check('close, none', assistantLine({ ...CLOSE, agents: [] }, null, 0), ['2026-11-03 10:00'])
    check('brief', briefText({ id: 'lane-1', startedBy: 'the user' }, 'Keep it short.'), ['lane-1', 'the user', 'Keep it short.'])
    // The builder's prompt is said in its own session's dialect.
    setChainResolver((s) => (s.kind === 'session' ? chain(canaryTexts(catalogue)) : null))
    check('builder started', await resumeLaneBuilder('C:/ws/alpha', { id: 'lane-1', builder: { id: 'b', name: 'B1' } }), ['B1'])
    check('builder prompt', state.prompts[0], ['lane-1'])
    state.fail = 'no CLI'
    check('builder failed', await resumeLaneBuilder('C:/ws/alpha', { id: 'lane-1', builder: { id: 'b', name: 'B1' } }), ['B1', 'no CLI'])
    // Said where their code runs, through the launch and the start pass (laneStart.test.ts, laneStarts.test.ts): each
    // a single sentence the descriptor holds whole.
    const elsewhere = ['brief.start.notGiven', 'brief.start.firstCard', 'brief.start.nextCard', 'brief.record.cleared', 'brief.record.inSlot', 'brief.record.delivered']
    // Stored for any reader: the Default's, whatever the scope (below).
    const stored = ['brief.start.byUser', 'brief.start.fromUser', 'brief.start.retryCancel', 'finish.journal.done', 'finish.cancel.cardDone', 'restart.closed.fact']
    expect(mine.filter((id) => !seen.has(id) && !elsewhere.includes(id) && !stored.includes(id))).toEqual([])
    for (const id of [...elsewhere, ...stored]) expect(ids.has(id), id).toBe(true)
  })

  it('keeps what is stored in the Default, whatever the scope', () => {
    canary()
    setChainResolver(() => chain(canaryTexts(catalogue)))
    inDialectOf({ projectPath: 'C:/ws/alpha', agentId: 'b' }, () => {
      expect(closeFact('t', 2)).toBe('Combwork closed unexpectedly (last seen t); 2 agent(s) of this workspace were running')
      expect(doneFact('#7', 'T', 'accepted', 'user')).toBe('#7 "T" is Done (accepted), by You')
    })
    // The stored ones' call sites say them in the Default.
    expect(read('src/main/laneStart.ts')).toMatch(/inDefaultDialect\(\(\) => say\(A\.byUser\)\)[\s\S]*inDefaultDialect\(\(\) => say\(A\.fromUser\)\)[\s\S]*inDefaultDialect\(\(\) => say\(A\.retryCancel\)\)/)
    expect(read('src/main/finishPath.ts')).toContain('inDefaultDialect(() => say(A.cancelled))')
    expect(read('src/main/laneBriefs.ts')).toContain('inDefaultDialect(() => briefText(lane, text))')
    expect(read('src/main/lastRun.ts')).toContain('inDefaultDialect(() => assistantLine(c, r, still))')
  })
})
