// HI-3400: the scenario harness's turn end (tests/scenarios/turnEnd.cjs). By scripted looks: a turn ends only with
// evidence this prompt's work ran and ended (or a person is asked), with nothing pending, after the floor, and anything
// pending or work resumed during the floor starts it again. By fake reads: each read is bounded by the trial's deadline,
// one that fails or never answers is unknown and never ends a turn, and nothing is read once the deadline has passed.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'
import { timing } from './timing.cjs'

type Look = { now: number; status: string | null; turn?: string; workSeen?: boolean; endSeen?: boolean; asks?: boolean; quiet?: boolean; trust?: boolean; dispatchedBusy?: boolean; keepWaiting?: boolean; gone?: boolean }
type Step = { state: unknown; done: boolean; outcome: string | null; why: string }
type Reads = Record<string, (v: Record<string, unknown>) => unknown>
const te = createRequire(import.meta.url)('./scenarios/turnEnd.cjs') as {
  turnStep: (s: unknown, l: Look, f: { quietMs: number; waitingQuietMs: number }) => Step
  start: () => unknown
  gatherLook: (reads: Reads, o: { deadline: number; readMs: number }) => Promise<Look>
  waitTurnEnd: (o: { reads: Reads; act?: (l: Look) => unknown; deadline: number; floors: { quietMs: number; waitingQuietMs: number }; readMs: number; lookMs: number; sleep?: (ms: number) => Promise<void> }) => Promise<Step>
}
const FLOORS = { quietMs: 6000, waitingQuietMs: 3000 }
type ScreenReads = { reads: Reads; trustKind: (live: unknown, screen: string) => string | null }
const harness = createRequire(import.meta.url)('./scenarios/harness.cjs') as {
  subjectScreenReads: (o: { readScreen: () => Promise<string>; launchRun: string; answered: Set<string>; provider: string }) => ScreenReads
}

/** Runs looks (each with defaults: this prompt's work seen and ended, quiet, nothing pending) and says when and how it ended. */
function run(looks: Look[]) {
  let state = te.start()
  for (const l of looks) {
    const r = te.turnStep(state, { workSeen: true, endSeen: true, quiet: true, ...l }, FLOORS)
    state = r.state
    if (r.done) return { at: l.now, outcome: r.outcome, why: r.why }
  }
  return null
}
/** Looks a second apart from `from` to `to` (inclusive), each with `look`'s fields. */
const every = (from: number, to: number, look: Omit<Look, 'now'>): Look[] => Array.from({ length: (to - from) / 1000 + 1 }, (_, i) => ({ ...look, now: from + i * 1000 }))

describe('a turn ends', () => {
  it('after working, at finished, quiet for the floor', () => {
    expect(run([...every(0, 2000, { status: 'working' }), ...every(3000, 20000, { status: 'finished' })])).toEqual({ at: 9000, outcome: 'over', why: expect.stringMatching(/finished, quiet/) })
  })
  it("a quick turn seen only in this prompt's statuses (never working in a look)", () => {
    expect(run(every(0, 20000, { status: 'finished' }))?.at).toBe(6000)
  })
  it('at watching (a scenario may end watching)', () => {
    expect(run(every(0, 20000, { status: 'watching' }))?.at).toBe(6000)
  })
  it('stopped for the environment (a sign-in, a usage limit): at once, whatever else the look says', async () => {
    const look = await te.gatherLook({ live: () => ({ status: 'working', turn: { state: 'running' } }), stop: () => 'signed out' }, { deadline: Date.now() + 5000, readMs: 200 })
    expect(te.turnStep(te.start(), look, FLOORS)).toMatchObject({ done: true, outcome: 'environment', why: expect.stringMatching(/signed out/) })
  })
  it('with the session gone: ended once it has stayed gone for the floor', () => {
    expect(run([{ now: 0, status: 'working' }, ...every(1000, 20000, { status: 'stopped', gone: true })])).toEqual({ at: 7000, outcome: 'ended', why: expect.stringMatching(/^the session ended/) })
  })
  it('gone for a moment (a relaunch in its slot: slot-start) and back: not ended, its floor counted again', () => {
    const looks = [{ now: 0, status: 'working' }, ...every(1000, 4000, { status: 'stopped', gone: true }), ...every(5000, 6000, { status: 'working' }), ...every(7000, 30000, { status: 'finished' })]
    expect(run(looks)).toEqual({ at: 13000, outcome: 'over', why: expect.stringMatching(/finished, quiet/) })
  })
})

describe("evidence: this prompt's work, and its end (HR1 on s8, 2)", () => {
  it("never with no sign this prompt's turn ran (an earlier setup turn's work isn't in its statuses)", () => {
    expect(run(every(0, 120000, { status: 'ready', workSeen: false, endSeen: false }))).toBeNull()
  })
  it("an idle end needs this work's end: ready with no end evidence never ends (no turn, or a missing one, is no end)", () => {
    expect(run(every(0, 120000, { status: 'ready', endSeen: false }))).toBeNull()
    expect(run(every(0, 120000, { status: 'finished', turn: undefined, endSeen: false }))).toBeNull()
  })
  it("stale setup work and an old turn over, then the intended prompt's delayed start and end: only after the latter", () => {
    const looks = [
      // Setup's turn is over and the CLI ready, but nothing of this prompt yet.
      ...every(0, 9000, { status: 'ready', turn: 'over', workSeen: false, endSeen: false }),
      // This prompt starts late, works, then ends.
      ...every(10000, 14000, { status: 'working', turn: 'running', workSeen: true, endSeen: false }),
      ...every(15000, 40000, { status: 'finished', turn: 'over', workSeen: true, endSeen: true })
    ]
    expect(run(looks)?.at).toBe(21000)
  })
  it('a prompt given at launch, at work before its statuses were recorded (card-loop-design-check): seen at work in a look, then at an end with its turn over', () => {
    const looks = [
      { now: 0, status: 'working', turn: 'running', workSeen: false, endSeen: false },
      ...every(2000, 30000, { status: 'watching', turn: 'over', workSeen: false, endSeen: false })
    ]
    expect(run(looks)).toEqual({ at: 8000, outcome: 'over', why: expect.stringMatching(/watching, quiet/) })
  })
  it('seen at work in a look, but no look at an end with its turn over: never ends', () => {
    const looks = [{ now: 0, status: 'working', turn: 'running', workSeen: false, endSeen: false }, ...every(2000, 60000, { status: 'finished', turn: 'unknown', workSeen: false, endSeen: false })]
    expect(run(looks)).toBeNull()
  })
  it('seen at work in a look, then at an end with no turn (missing or null): never ends, a missing turn is no proof (HR1 on HI-3400, 2)', () => {
    for (const turn of [undefined, null]) {
      const looks = [{ now: 0, status: 'working', turn: 'running', workSeen: false, endSeen: false }, ...every(1000, 60000, { status: 'finished', turn: turn as unknown as string, workSeen: false, endSeen: false })]
      expect(run(looks)).toBeNull()
    }
  })
})

describe('a person asked (HR1 on s8, 1)', () => {
  it('ends at its shorter floor though the turn ledger still runs (an ask ends no turn)', () => {
    expect(run(every(0, 20000, { status: 'waiting', turn: 'running', asks: true, endSeen: false }))).toEqual({ at: 3000, outcome: 'over', why: expect.stringMatching(/asking the user/) })
  })
  it('running or unknown with no question never ends, whatever the status says', () => {
    expect(run(every(0, 60000, { status: 'waiting', turn: 'running', asks: false }))).toBeNull()
    expect(run(every(0, 60000, { status: 'ready', turn: 'unknown' }))).toBeNull()
  })
  it('waiting because of a trust question never ends', () => {
    expect(run(every(0, 60000, { status: 'waiting', turn: 'running', asks: true, trust: true }))).toBeNull()
  })
  it("Combwork's composer is no hold on a question for the user", () => {
    expect(run(every(0, 20000, { status: 'waiting', asks: true, quiet: false }))?.at).toBe(3000)
  })
})

describe('the floor starts again', () => {
  it('when a late hook shows work during it (finished, working, finished)', () => {
    expect(run([...every(0, 4000, { status: 'finished' }), { now: 5000, status: 'working' }, ...every(6000, 30000, { status: 'finished' })])?.at).toBe(12000)
  })
  it('when the turn ledger says running, whatever the status', () => {
    expect(run([...every(0, 4000, { status: 'finished' }), { now: 5000, status: 'finished', turn: 'running' }, ...every(6000, 30000, { status: 'finished', turn: 'over' })])?.at).toBe(12000)
  })
  it('while Combwork is about to type into it (composer busy or a delivery queued)', () => {
    expect(run([...every(0, 7000, { status: 'finished', quiet: false }), ...every(8000, 30000, { status: 'finished' })])?.at).toBe(14000)
  })
  it('while a trust question is asked or answered', () => {
    expect(run([...every(0, 5000, { status: 'waiting', trust: true }), ...every(6000, 30000, { status: 'finished' })])?.at).toBe(12000)
  })
  it('while a dispatched agent works (waitForAgents)', () => {
    expect(run([...every(0, 10000, { status: 'finished', dispatchedBusy: true }), ...every(11000, 30000, { status: 'finished' })])?.at).toBe(17000)
  })
  it("while the scenario's keepWaiting holds", () => {
    expect(run([...every(0, 9000, { status: 'finished', keepWaiting: true }), ...every(10000, 30000, { status: 'finished' })])?.at).toBe(16000)
  })
  it("while its state can't be read (status unread)", () => {
    expect(run([...every(0, 4000, { status: 'finished' }), { now: 5000, status: null }, ...every(6000, 30000, { status: 'finished' })])?.at).toBe(12000)
  })
})

describe('bounded gathering (HR1 on s8, 3)', () => {
  const never = () => new Promise(() => {})
  const done = { status: 'finished', turn: { state: 'over' } }
  /** A look whose reads are bounded at 200 ms each: well within this on a loaded machine, never a read's whole wait. */
  const LOOK_WITHIN = 200 * 10
  const quietReads: Reads = { live: () => done, workSeen: () => true, endSeen: () => true, quiet: () => true }
  /** A look's reads, each a value (or a never-answering or failing read), timed. */
  const timedLook = async (reads: Reads, readMs = 200) => {
    const t = Date.now()
    const look = await te.gatherLook(reads, { deadline: Date.now() + 60_000, readMs })
    return { look, ms: Date.now() - t }
  }

  it('a read that never answers is unknown within its bound: a live() never answering is an unread status', async () => {
    const { look, ms } = await timedLook({ ...quietReads, live: never })
    expect(look.status).toBeNull()
    expect(look.gone).toBe(false)
    expect(ms).toBeLessThan(LOOK_WITHIN)
  })
  it('quiet failing or never answering is not quiet; keepWaiting, trust and dispatched work unknown are pending', async () => {
    expect((await timedLook({ ...quietReads, quiet: () => Promise.reject(new Error('API down')) })).look.quiet).toBe(false)
    expect((await timedLook({ ...quietReads, quiet: never })).look.quiet).toBe(false)
    const unknowns = (await timedLook({ ...quietReads, keepWaiting: never, trust: never, dispatchedBusy: () => Promise.reject(new Error('x')) })).look
    expect([unknowns.keepWaiting, unknowns.trust, unknowns.dispatchedBusy]).toEqual([true, true, true])
  })
  it('left out, a read is nothing pending; a live() of null is the session gone', async () => {
    const { look } = await timedLook({ live: () => null })
    expect([look.gone, look.trust, look.dispatchedBusy, look.keepWaiting]).toEqual([true, false, false, false])
  })

  const fast = { quietMs: 300, waitingQuietMs: 150 }
  it('ends over when the reads say so, within the deadline', async () => {
    const r = await te.waitTurnEnd({ reads: quietReads, deadline: Date.now() + 10_000, floors: fast, readMs: 200, lookMs: 50 })
    expect(r.outcome).toBe('over')
  })
  it('times out at its deadline when live() never answers: never pending past it, never over', async () => {
    const t = Date.now()
    const r = await te.waitTurnEnd({ reads: { ...quietReads, live: never }, deadline: Date.now() + 800, floors: fast, readMs: 200, lookMs: 50 })
    expect(r.outcome).toBe('timed out')
    expect(Date.now() - t).toBeLessThan(800 + 1500)
  })
  it('a keepWaiting or quiet that never answers keeps it from ending: timed out, never over', async () => {
    for (const reads of [{ ...quietReads, keepWaiting: never }, { ...quietReads, quiet: never }]) {
      const r = await te.waitTurnEnd({ reads, deadline: Date.now() + 800, floors: fast, readMs: 100, lookMs: 50 })
      expect(r.outcome).toBe('timed out')
    }
  })
  it('an act (a trust answer, during) that never returns: bounded by the deadline, never started again beside itself, and it holds the turn', async () => {
    const t = Date.now()
    let calls = 0
    // The reads alone would end the turn: the act still running keeps it pending.
    const r = await te.waitTurnEnd({ reads: quietReads, act: () => { calls++; return never() }, deadline: Date.now() + 800, floors: fast, readMs: 100, lookMs: 50 })
    expect(r.outcome).toBe('timed out')
    expect(r.why).toMatch(/action still running/)
    expect(calls).toBe(1)
    expect(Date.now() - t).toBeLessThan(800 + 1500)
  })
  it('an act that fails fails the trial: never a look that ends it', async () => {
    const r = await te.waitTurnEnd({ reads: { ...quietReads, endSeen: () => false }, act: () => Promise.reject(new Error('pty gone')), deadline: Date.now() + 5000, floors: fast, readMs: 100, lookMs: 50 })
    expect(r).toMatchObject({ outcome: 'act failed', why: expect.stringMatching(/pty gone/) })
  })
  it('an act that outran its wait holds the turn until it settles, is never started again beside itself, and the turn ends after it', async () => {
    let calls = 0
    let running = 0
    let overlap = false
    const act = async () => {
      calls++
      if (running++) overlap = true
      // The first one outruns its wait (a read's time here: 100 ms); later ones are quick.
      if (calls === 1) await new Promise((res) => setTimeout(res, timing('quiet.briefMs')))
      running--
    }
    // Not done for a while (no end evidence), then done.
    const until = Date.now() + 700
    const r = await te.waitTurnEnd({ reads: { ...quietReads, endSeen: () => Date.now() > until }, act, deadline: Date.now() + 10_000, floors: fast, readMs: 100, lookMs: 50 })
    expect(r.outcome).toBe('over')
    expect(overlap).toBe(false)
    expect(calls).toBeGreaterThan(1)
  })
  it('nothing is read once the deadline has passed', async () => {
    let reads = 0
    let afterExpiry = 0
    const deadline = Date.now() + 500
    const counted: Reads = { live: () => { reads++; if (Date.now() >= deadline) afterExpiry++; return { status: 'working' } } }
    await te.waitTurnEnd({ reads: counted, deadline, floors: fast, readMs: 100, lookMs: 50 })
    const before = reads
    // The window is the point: no read comes after the deadline within it.
    await new Promise((r) => setTimeout(r, timing('quiet.briefMs')))
    expect(reads).toBe(before)
    expect(afterExpiry).toBe(0)
  })
})

describe("the subject's screen, through the harness's own reads (HR1 on HI-3400, 1)", () => {
  const never = () => new Promise<string>(() => {})
  const fast = { quietMs: 300, waitingQuietMs: 150 }
  // A relaunch (a run after the launch's) waiting, Combwork's attention on it: a trust question or one for the user.
  const relaunched = { status: 'waiting', runId: 'slot-run', turn: { state: 'running' }, runtime: { attention: 'waiting', lifecycle: 'running', composer: 'free' } }
  const TRUST = 'Accessing workspace: Is this a project you created or one you trust? > 1. Yes, I trust this folder 2. No, exit'
  const QUESTION = 'Which name should the card have? 1. Short 2. Long'
  /** The harness's reads of a waiting relaunch, its screen read by `readScreen`; this prompt's work seen, nothing else pending. */
  const subject = (readScreen: () => Promise<string>) => {
    const s = harness.subjectScreenReads({ readScreen, launchRun: 'launch-run', answered: new Set(), provider: 'claude-code' })
    return { ...s, reads: { live: () => relaunched, workSeen: () => true, endSeen: () => false, quiet: () => true, ...s.reads } as Reads }
  }
  const look = (reads: Reads) => te.gatherLook(reads, { deadline: Date.now() + 60_000, readMs: 100 })

  it('a screen read that fails or never answers is no question for the user: trust pending, never over', async () => {
    for (const readScreen of [() => Promise.reject(new Error('renderer busy')), never]) {
      const l = await look(subject(readScreen).reads)
      expect([l.asks, l.trust]).toEqual([false, true])
      expect(te.turnStep(te.start(), l, FLOORS)).toMatchObject({ done: false, outcome: null })
      expect((await te.waitTurnEnd({ reads: subject(readScreen).reads, deadline: Date.now() + 800, floors: fast, readMs: 100, lookMs: 50 })).outcome).toBe('timed out')
    }
  })
  it('the screen is read once a look, and asks and trust decide from that one snapshot', async () => {
    let reads = 0
    const l = await look(subject(async () => (reads++, QUESTION)).reads)
    expect(reads).toBe(1)
    expect([l.asks, l.trust]).toEqual([true, false])
  })
  it('unread, then read again: its trust question answered from the look that read it, then a question for the user ends it', async () => {
    // Looks 1-3: the read fails or doesn't answer; then the trust question; once answered, a question for the user.
    let n = 0
    let answered = false
    const readScreen = () => {
      n++
      if (n === 1) return Promise.reject(new Error('renderer busy'))
      if (n <= 3) return never()
      return Promise.resolve(answered ? QUESTION : TRUST)
    }
    const s = subject(readScreen)
    const kinds: (string | null)[] = []
    const act = (l: Look & { values?: Record<string, unknown> }) => {
      const screen = l.values?.screen
      const kind = typeof screen === 'string' ? s.trustKind(relaunched, screen) : null
      kinds.push(kind)
      if (kind) answered = true
    }
    const r = await te.waitTurnEnd({ reads: s.reads, act, deadline: Date.now() + 10_000, floors: fast, readMs: 100, lookMs: 50 })
    expect(r).toMatchObject({ outcome: 'over', why: expect.stringMatching(/asking the user/) })
    // Nothing answered from the unread looks; the trust question answered once it was read.
    expect(kinds.slice(0, 3)).toEqual([null, null, null])
    expect(kinds).toContain('claude')
  })
})
