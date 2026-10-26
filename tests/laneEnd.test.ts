// A lane's end (HI-1706, SPEC §16.10.2; slotsApp.ts's waitForLaneEnd): its builder's run is ended once its turn is over
// as states say (never after a settle time), told first in a note, fenced to that run and lease throughout, and ended
// past an absolute deadline whatever it waits for. These drive the waiter with a test's own states and clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/sessions', () => ({ sessions: { runNow: () => null, stop: () => undefined, runLive: () => true, liveStates: () => [], turnOpen: () => false, lineWaiting: () => false, liveFor: () => null } }))
/** The project's deliveries being read (laneEndWaitsFor's one await): held until the test lets it go. */
let reading: Promise<void> = Promise.resolve()
vi.mock('../src/main/deliveries', async (orig) => ({ ...(await orig<typeof import('../src/main/deliveries')>()), deliveriesOf: async () => (await reading, []), waitingForRunNow: () => [] }))

const { waitForLaneEnd, laneEndNote, laneEndWaitsFor } = await import('../src/main/slotsApp')
const { setAgentBusy } = await import('../src/main/workflow/lineUpdates')
type Deps = Parameters<typeof waitForLaneEnd>[0]

/** A lane's end over states the test sets: what it waits for, whether it is fenced, what its quit answers. */
function harness(over: Partial<Deps> = {}) {
  const s = { why: 'it is in a turn' as string | null, fenced: true, quitAnswer: 'sent' as 'sent' | 'held' | 'gone', now: 0 }
  const quits: { why: string; force: boolean }[] = []
  const retired: string[] = []
  const notes: string[] = []
  const lines: string[] = []
  let look: (() => void) | null = null
  const deps: Deps = {
    fenced: () => s.fenced,
    waitsFor: async () => s.why,
    note: async () => (notes.push('m1'), 'm1'),
    retire: async (why) => void retired.push(why),
    quit: async (why, force) => (quits.push({ why, force }), s.quitAnswer),
    watch: (fn) => ((look = fn), () => (look = null)),
    now: () => s.now,
    deadline: 10 * 60_000,
    log: (line) => void lines.push(line),
    ...over
  }
  const w = waitForLaneEnd(deps)
  /** A change the end follows (a status, a delivery saved): it looks again. */
  const change = (): void => look?.()
  return { s, quits, retired, notes, lines, change, done: w.done, watching: () => look !== null }
}

// The longest a wait here waits: a bound for a hung run, never how long it should take.
const HUNG = { timeout: 10_000 }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("a lane's end waits for its builder's turn to be over", () => {
  it('makes its note once, quits only once nothing waits, and once', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.lines).toContain('waiting: it is in a turn'), HUNG)
    expect(h.notes).toEqual(['m1'])
    expect(h.quits).toEqual([])
    h.s.why = 'deliveries still to reach it (m1)'
    h.change()
    await vi.waitFor(() => expect(h.lines).toContain('waiting: deliveries still to reach it (m1)'), HUNG)
    expect(h.quits).toEqual([])
    h.s.why = null
    h.change()
    await expect(h.done).resolves.toBe('ended once its turn was over')
    expect(h.quits).toEqual([{ why: 'its lane ended and its turn is over', force: false }])
    // Over: nothing it follows makes it look again, nor its rechecks.
    expect(h.watching()).toBe(false)
    h.change()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.quits).toHaveLength(1)
    expect(h.notes).toEqual(['m1'])
  })

  it('a doorbell or a Stop continuation held long past any settle time keeps it waiting; released, it waits for the turn it starts', async () => {
    const h = harness()
    // Held: a delivery offered and not taken yet, for minutes, while its status says idle.
    h.s.why = "a line typed into it isn't taken yet"
    h.change()
    for (let i = 0; i < 24; i++) {
      h.s.now += 5000
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(h.quits).toEqual([])
    // Released: the CLI takes it and a turn begins (the drain's continuation keeps the turn open in the ledger).
    h.s.why = 'its turn is still open'
    h.change()
    h.s.now += 30_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.quits).toEqual([])
    // That turn ends: only now.
    h.s.why = null
    h.change()
    await expect(h.done).resolves.toBe('ended once its turn was over')
    expect(h.quits.map((q) => q.force)).toEqual([false])
  })

  it('past its absolute deadline it quits forced whatever it waits for, and retires the unread note; events never move the deadline', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.notes).toEqual(['m1']), HUNG)
    // Many changes before the deadline: each a look, none a quit, none a later deadline.
    for (let i = 0; i < 9; i++) {
      h.s.now += 60_000
      h.change()
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(h.quits).toEqual([])
    h.s.now = 10 * 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(h.done).resolves.toBe('ended past the deadline')
    expect(h.quits).toHaveLength(1)
    expect(h.quits[0].force).toBe(true)
    expect(h.quits[0].why).toContain("didn't finish its turn in time (it is in a turn)")
    expect(h.retired).toEqual(['its run ended'])
  })

  it('a quit held by the user typing (or a line of Hive\'s) is tried again, never forced before the deadline', async () => {
    const h = harness()
    h.s.why = null
    h.s.quitAnswer = 'held'
    h.change()
    await vi.waitFor(() => expect(h.quits.length).toBeGreaterThan(0), HUNG)
    expect(h.quits.every((q) => !q.force)).toBe(true)
    h.s.quitAnswer = 'sent'
    h.s.now += 5000
    await vi.advanceTimersByTimeAsync(5000)
    await expect(h.done).resolves.toBe('ended once its turn was over')
  })

  it('its run or lease gone while it waits (a restart, a new lease, the workspace closed): nothing quit, its note retired', async () => {
    const h = harness()
    await vi.waitFor(() => expect(h.lines).toContain('waiting: it is in a turn'), HUNG)
    h.s.fenced = false
    h.change()
    await expect(h.done).resolves.toBe('the run or its lease is gone: nothing ended')
    expect(h.quits).toEqual([])
    expect(h.retired).toEqual(['its lane end lost its run'])
  })

  it('a fence lost while its note is being made: nothing quit', async () => {
    let fenced = true
    const h = harness({ fenced: () => fenced, note: async () => ((fenced = false), 'm1'), waitsFor: async () => null })
    await expect(h.done).resolves.toBe('the run or its lease is gone: nothing ended')
    expect(h.quits).toEqual([])
  })

  it('a quit that finds the run gone ends without another try', async () => {
    let fenced = true
    const h = harness({ waitsFor: async () => null, quit: async () => ((fenced = false), 'gone'), fenced: () => fenced })
    await expect(h.done).resolves.toBe('the run or its lease is gone: nothing ended')
  })

  it("a note still being made at the deadline doesn't hold it: forced at the deadline, and the note made late is retired (HR1 round 1, finding 2)", async () => {
    let made: (id: string) => void = () => undefined
    const h = harness({ note: () => new Promise<string>((r) => (made = r)) })
    h.s.now = 10 * 60_000
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100)
    await expect(h.done).resolves.toBe('ended past the deadline')
    expect(h.quits.map((q) => q.force)).toEqual([true])
    made('m1')
    await vi.waitFor(() => expect(h.retired).toContain('its lane end was over before its note was made'), HUNG)
    expect(h.quits).toHaveLength(1)
  })

  it('its states still being read at the deadline: forced, and their late answer quits nothing more', async () => {
    let answer: (why: string | null) => void = () => undefined
    const h = harness({ waitsFor: () => new Promise<string | null>((r) => (answer = r)) })
    await vi.waitFor(() => expect(h.notes).toEqual(['m1']), HUNG)
    h.s.now = 10 * 60_000
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100)
    await expect(h.done).resolves.toBe('ended past the deadline')
    answer(null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.quits.map((q) => q.force)).toEqual([true])
  })

  it('its note or its states still being read when the fence is lost: it ends at once, nothing quit, even when they answer later', async () => {
    let made: (id: string) => void = () => undefined
    const h = harness({ note: () => new Promise<string>((r) => (made = r)), waitsFor: async () => null })
    h.s.fenced = false
    h.change()
    await expect(h.done).resolves.toBe('the run or its lease is gone: nothing ended')
    made('m1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.quits).toEqual([])
    expect(h.retired).toContain('its lane end lost its run')
    expect(h.retired).toContain('its lane end was over before its note was made')
  })

  it('a quit still typing at the deadline is waited for, never a second one beside it', async () => {
    let typed: (r: 'sent' | 'held' | 'gone') => void = () => undefined
    const quits: boolean[] = []
    const h = harness({ waitsFor: async () => null, quit: (_why, force) => (quits.push(force), force ? Promise.resolve('sent') : new Promise((r) => (typed = r))) })
    await vi.waitFor(() => expect(quits).toEqual([false]), HUNG)
    h.s.now = 10 * 60_000
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100)
    expect(quits).toEqual([false])
    // The user typed while it typed: it gave up; then the forced one.
    typed('held')
    await expect(h.done).resolves.toBe('ended past the deadline')
    expect(quits).toEqual([false, true])
  })

  it("a note that couldn't be made (no inbox, refused) doesn't hold it: it ends once the turn is over", async () => {
    const h = harness({ note: async () => Promise.reject(new Error('refused')) })
    await vi.waitFor(() => expect(h.lines).toContain("its lane's note wasn't made: refused"), HUNG)
    h.s.why = null
    h.change()
    await expect(h.done).resolves.toBe('ended once its turn was over')
  })
})

describe("its states (laneEndWaitsFor)", () => {
  it('are read after its deliveries are, at one moment: a turn beginning while they are read is seen (HR1 round 1, finding 1)', async () => {
    let busy = false
    setAgentBusy(() => busy)
    let let_go: () => void = () => undefined
    reading = new Promise<void>((r) => (let_go = r))
    try {
      const answer = laneEndWaitsFor('C:/ws/alpha', 'b1', 'run-1')
      // The read is under way: a doorbell's line is taken and a turn begins.
      busy = true
      let_go()
      expect(await answer).toBe('it is in a turn')
      busy = false
      expect(await laneEndWaitsFor('C:/ws/alpha', 'b1', 'run-1')).toBeNull()
    } finally {
      setAgentBusy(null)
      reading = Promise.resolve()
    }
  })
})

describe("a lane's note", () => {
  it('names each card with its merge commit, and that the session ends with the turn', () => {
    const t = laneEndNote('Off main', false, [
      { key: 'HI-1', merged: 'aaa9a0c3c180fc41a6298d7a19f17a1f9239b3f5' },
      { key: 'HI-2', merged: null }
    ])
    expect(t).toBe("Lane Off main is finished: HI-1 merged at aaa9a0c3c180; HI-2 not merged. Your session ends once this turn does; Hive resumes it for your next lane. Close the lane's work in your reply, then end your turn.")
  })

  it('says an abandoned lane was abandoned', () => {
    expect(laneEndNote('x', true, [{ key: 'HI-3', merged: null }])).toMatch(/^Lane x was abandoned: HI-3 not merged\. /)
  })

  it('is bounded for a lane with many cards', () => {
    const cards = Array.from({ length: 300 }, (_, i) => ({ key: `HI-${1000 + i}`, merged: 'f'.repeat(40) }))
    const t = laneEndNote('long '.repeat(500), false, cards)
    expect(t.length).toBeLessThanOrEqual(2000)
    const short = laneEndNote('l', false, cards)
    expect(short).toContain('HI-1019 merged')
    expect(short).not.toContain('HI-1020')
    expect(short).toContain('and 280 more')
  })
})
