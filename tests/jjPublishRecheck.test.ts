// A settled publish record keeps its evidence and is re-checked (HI-2873, Darren's B on HI-2798; design HI-2873/s7,
// s11, s14): the flag's compare-and-set, and the re-check's bounded, fair sweep, on the memory store with a scripted
// ancestry. The real jj's behaviour (a remote moved back, removed, raced at the final boundary) is jjIntegrationReal's.
import { describe, expect, it } from 'vitest'
import { applyRecheck, memoryObligations, planRecheck, RECHECK_MAX, RECHECK_SCAN, reconstructObligations, type ObligationStore, type PublishNow, type PublishSeen } from '../src/main/platform/jjIntegration'
import { jjUnknown } from '../src/main/platform/jjReads'

const hex = (n: number, c = 'a'): string => n.toString(16).padStart(40, c)
const P1 = 'f'.repeat(40)
const HEAD = 'e'.repeat(40)
const now: PublishNow = { remote: 'origin', url: 'u', pushed: P1, head: HEAD }
const seenOf = (pushed: string | null, at: number, more: Partial<PublishSeen> = {}): PublishSeen => ({ remote: 'origin', url: 'u', pushed, head: HEAD, op: 'op', print: 'p', at, ...more })
const keyOf = (card: string) => ({ card, cycle: 1, bundle: `b-${card}` })

/** Settles a new published row for `card` (its result `result`, the remote at `pushed` then). */
function settleRow(s: ObligationStore, card: string, result: string, pushed: string | null, to: 'published' | 'notHeld' = 'published', at = 1): void {
  expect(s.create({ ...keyOf(card), target: 'main', result, since: 0, state: 'owed' })).toBe(true)
  expect(s.settle(keyOf(card), result, to, seenOf(pushed, at))).toBe(true)
}

describe('the flag: settled → checkThis by its own compare-and-set (HI-2873/s7 §2, s11 §3)', () => {
  it('only from the exact key, result, settled state and settle time; never from owed; the evidence kept', () => {
    const s = memoryObligations()
    settleRow(s, 'HI-1', hex(1), hex(2), 'published', 5)
    reconstructObligations(s, [{ card: 'HI-2', cycle: 1, bundle: 'b-HI-2', target: 'main', result: hex(3), at: 1 }])
    const check = { was: 'published' as const, differs: [{ what: 'pushed' as const, was: hex(2), now: P1 }], at: 9 }
    expect(s.flag(keyOf('HI-1'), hex(9), 'published', 5, check)).toBe(false)
    expect(s.flag(keyOf('HI-1'), hex(1), 'notHeld', 5, check)).toBe(false)
    expect(s.flag(keyOf('HI-1'), hex(1), 'published', 6, check)).toBe(false)
    expect(s.flag(keyOf('HI-2'), hex(3), 'published', 5, check)).toBe(false)
    expect(s.flag(keyOf('HI-1'), hex(1), 'published', 5, check)).toBe(true)
    expect(s.flag(keyOf('HI-1'), hex(1), 'published', 5, check)).toBe(false)
    expect(s.rows[0]).toMatchObject({ state: 'checkThis', check, seen: seenOf(hex(2), 5), pushed: hex(2), seq: 1 })
    // A settle never moves it again, and reconstruction never brings it back; a reintegration gets its own key.
    expect(s.settle(keyOf('HI-1'), hex(1), 'published', seenOf(P1, 10))).toBe(false)
    expect(reconstructObligations(s, [{ card: 'HI-1', cycle: 1, bundle: 'b-HI-1', target: 'main', result: hex(1), at: 1 }])).toBe(0)
    expect(reconstructObligations(s, [{ card: 'HI-1', cycle: 1, bundle: 'b-HI-1-again', target: 'main', result: hex(1), at: 1 }])).toBe(1)
    expect(s.rows.map((r) => r.state)).toEqual(['checkThis', 'owed', 'owed'])
  })

  it('seq: assigned only by a successful settle, per target, increasing whatever the clock says', () => {
    const s = memoryObligations()
    settleRow(s, 'HI-1', hex(1), hex(1), 'published', 30)
    settleRow(s, 'HI-2', hex(2), hex(2), 'published', 20)
    settleRow(s, 'HI-3', hex(3), null, 'notHeld', 10)
    expect(s.settle(keyOf('HI-1'), hex(1), 'published', seenOf(hex(1), 40))).toBe(false)
    expect(s.rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(s.recheckPage('main', 0, 3, 10).map((r) => r.card)).toEqual(['HI-1', 'HI-2', 'HI-3'])
    expect(s.recheckPage('main', 1, 2, 10).map((r) => r.card)).toEqual(['HI-2'])
    expect(s.maxSeq('main')).toBe(3)
    expect(s.maxSeq('other')).toBe(0)
  })
})

describe('what a re-observation flags (HI-2873/s7 §4, s11 §2)', () => {
  const pass = async (s: ObligationStore, n: PublishNow, anc: (a: string, b: string) => boolean) => {
    const asked: string[] = []
    const plan = await planRecheck(s, 'main', n, async (a, b) => (asked.push(`${a.slice(-2)}..${b.slice(-2)}`), anc(a, b)))
    if ('jjUnknown' in plan) throw new Error(JSON.stringify(plan))
    return { flagged: applyRecheck(s, 'main', plan, 99), asked, plan }
  }

  it('published: the same pushed id unchanged with no read; the remote advanced unchanged; moved back past it flagged', async () => {
    const s = memoryObligations()
    settleRow(s, 'HI-1', hex(1), hex(2))
    expect(await pass(s, { ...now, pushed: hex(2) }, () => false)).toMatchObject({ flagged: [], asked: [] })
    expect(s.rows[0].state).toBe('published')
    expect(await pass(s, now, (a, b) => a === hex(2) && b === P1)).toMatchObject({ flagged: [], asked: [`${hex(2).slice(-2)}..ff`] })
    expect(s.rows[0].state).toBe('published')
    // The remote rewritten, the result still in it (another commit holding it): unchanged.
    expect((await pass(s, now, (a) => a === hex(1))).flagged).toEqual([])
    const out = await pass(s, now, () => false)
    expect(out.flagged).toEqual([{ key: keyOf('HI-1'), differs: [{ what: 'pushed', was: hex(2), now: P1 }, { what: 'inRemote', was: 'yes', now: 'no' }] }])
    expect(s.rows[0]).toMatchObject({ state: 'checkThis', seen: seenOf(hex(2), 1), check: { was: 'published', at: 99 } })
  })

  it('published: the ref gone from the remote flagged with no read', async () => {
    const s = memoryObligations()
    settleRow(s, 'HI-1', hex(1), hex(2))
    const out = await pass(s, { ...now, pushed: null }, () => true)
    expect(out.asked).toEqual([])
    expect(out.flagged[0].differs).toEqual([{ what: 'pushed', was: hex(2), now: null }, { what: 'inRemote', was: 'yes', now: 'no' }])
  })

  it('a remote or URL that differs, or a verified absence, flags with no read whatever the remote has', async () => {
    for (const [n, differs] of [
      [{ ...now, pushed: hex(2), remote: 'up' }, [{ what: 'remote', was: 'origin', now: 'up' }]],
      [{ ...now, pushed: hex(2), url: 'v' }, [{ what: 'url', was: 'u', now: 'v' }]],
      [{ remote: null, url: null, pushed: null, head: HEAD }, [{ what: 'remote', was: 'origin', now: null }, { what: 'url', was: 'u', now: null }]]
    ] as const) {
      const s = memoryObligations()
      settleRow(s, 'HI-1', hex(1), hex(2))
      settleRow(s, 'HI-2', hex(3), null, 'notHeld')
      const out = await pass(s, n, () => true)
      expect(out.asked).toEqual([])
      expect(out.flagged.map((f) => f.differs)).toEqual([differs, differs])
    }
  })

  it('notHeld: unchanged while neither in the remote nor held; flagged once in the remote, or held again', async () => {
    const s = memoryObligations()
    settleRow(s, 'HI-1', hex(1), hex(2), 'notHeld')
    settleRow(s, 'HI-2', hex(3), hex(2), 'notHeld')
    expect((await pass(s, now, () => false)).flagged).toEqual([])
    const out = await pass(s, now, (a, b) => (a === hex(1) && b === P1) || (a === hex(3) && b === HEAD))
    expect(out.flagged).toEqual([
      { key: keyOf('HI-1'), differs: [{ what: 'pushed', was: hex(2), now: P1 }, { what: 'inRemote', was: 'no', now: 'yes' }] },
      { key: keyOf('HI-2'), differs: [{ what: 'held', was: 'no', now: 'yes' }] }
    ])
  })

  it('an unknown ancestry answer: nothing written, the sweep where it was', async () => {
    const s = memoryObligations()
    for (let i = 1; i <= 3; i++) settleRow(s, `HI-${i}`, hex(i), hex(i, 'b'))
    s.sweeps.set('main', { after: 1, end: 3 })
    const plan = await planRecheck(s, 'main', now, async () => jjUnknown('failed', 'x'))
    expect(plan).toMatchObject({ jjUnknown: 'failed' })
    expect(s.getSweep('main')).toEqual({ after: 1, end: 3 })
    expect(s.rows.every((r) => r.state === 'published')).toBe(true)
  })
})

describe('the sweep: bounded and fair (HI-2873/s14)', () => {
  // Rows each pushed at their own id, every push rewritten away on the remote but each result still in it (so a
  // published row's worst case, two reads, is the real cost); a stale row's result is gone too.
  const res = (n: number): string => `res-${n}`
  const holds = (stale: Set<string>, a: string, b: string): boolean => b === P1 && a.startsWith('res-') && !stale.has(a)
  function world(n: number) {
    const s = memoryObligations()
    let made = 0
    const stale = new Set<string>()
    const add = (k: number): void => {
      for (let i = 0; i < k; i++) {
        made++
        settleRow(s, `HI-${made}`, res(made), `push-${made}`)
      }
    }
    add(n)
    let scanned = 0
    const page = s.recheckPage
    s.recheckPage = (...a) => {
      const r = page(...a)
      scanned += r.length
      return r
    }
    const pass = async () => {
      scanned = 0
      let reads = 0
      const plan = await planRecheck(s, 'main', now, async (a, b) => {
        reads++
        return holds(stale, a, b)
      })
      if ('jjUnknown' in plan) throw new Error(JSON.stringify(plan))
      const flagged = applyRecheck(s, 'main', plan, 1)
      return { flagged, reads, scanned, plan }
    }
    return { s, add, stale, pass }
  }
  // Each row needs at most two reads, so a pass decides at least ⌊RECHECK_MAX / 2⌋ rows (or the rest of its sweep).
  const PER_PASS = Math.floor(RECHECK_MAX / 2)

  it.each([1, 20])('row %i goes stale after the sweep has passed it, while more rows arrive each pass than it can take: flagged within the rest of this sweep and its place in the next', async (k) => {
    const w = world(40)
    // Sweep until the cursor is past row k, every row unchanged.
    let passes = 0
    while ((w.s.getSweep('main')?.after ?? 0) < k) {
      const p = await w.pass()
      expect(p.flagged).toEqual([])
      expect(++passes).toBeLessThan(10)
    }
    const after = w.s.getSweep('main')!.after
    w.stale.add(res(k))
    // The bound, from the actual counts: the rest of this sweep, then row k's place in the next (rows before it, it).
    const bound = Math.ceil((40 - after) / PER_PASS) + Math.ceil(k / PER_PASS)
    let flaggedAt = 0
    for (let i = 1; i <= bound + 5 && !flaggedAt; i++) {
      const p = await w.pass()
      expect(p.scanned).toBeLessThanOrEqual(RECHECK_SCAN)
      expect(p.reads).toBeLessThanOrEqual(RECHECK_MAX)
      expect(p.plan.decided).toBeGreaterThanOrEqual(Math.min(PER_PASS, p.scanned))
      if (p.flagged.some((f) => f.key.card === `HI-${k}`)) flaggedAt = i
      w.add(100)
    }
    expect(flaggedAt, `row ${k} flagged within ${bound} passes`).toBeGreaterThan(0)
    expect(flaggedAt).toBeLessThanOrEqual(bound)
    expect(w.s.rows.filter((r) => r.state === 'checkThis').map((r) => r.card)).toEqual([`HI-${k}`])
  })

  it('a sweep whose remaining rows were all flagged by another pass completes on an empty page', async () => {
    const w = world(10)
    w.s.sweeps.set('main', { after: 4, end: 10 })
    for (let i = 5; i <= 10; i++) expect(w.s.flag(keyOf(`HI-${i}`), res(i), 'published', 1, { was: 'published', differs: [], at: 2 })).toBe(true)
    const p = await w.pass()
    expect(p.scanned).toBe(0)
    expect(w.s.getSweep('main')).toBeNull()
    // The next pass starts a new sweep at the current end.
    w.add(3)
    const q = await w.pass()
    expect(q.plan.expected).toBeNull()
    expect(q.scanned).toBe(7)
  })

  it('a delayed concurrent pass never overwrites a newer sweep, and writes no flag', async () => {
    const w = world(30)
    w.stale.add(res(2))
    const planOf = async () => {
      const plan = await planRecheck(w.s, 'main', now, async (a, b) => holds(w.stale, a, b))
      if ('jjUnknown' in plan) throw new Error(JSON.stringify(plan))
      return plan
    }
    const late = await planOf()
    const first = await planOf()
    expect(applyRecheck(w.s, 'main', first, 1).map((f) => f.key.card)).toEqual(['HI-2'])
    const newer = w.s.getSweep('main')
    expect(applyRecheck(w.s, 'main', late, 1)).toEqual([])
    expect(w.s.getSweep('main')).toEqual(newer)
  })
})
