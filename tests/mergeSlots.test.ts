// The merge slot (#350): one merge at a time into a project's branch, others in order; never stuck (a hold ends with
// its launch, after its time, or when the user releases it), and an expiry or a hold Combwork closed under is reported.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLD_MS, KEEP_PLACE_MS, MAX_WAIT_MS, MergeSlots, PROGRESS_FRESH_MS, parseSlotRecords, slotBranch, slotCards, type SlotAgent } from '../src/main/mergeSlots'

const P = 'C:\\ws\\hive'
const agent = (name: string, runId = `${name}-run`): SlotAgent => ({ projectPath: P, agentId: name.toLowerCase(), agentName: name, runId })

function setup() {
  const running = new Set<string>()
  const progress = new Map<string, number>()
  const notes = new Map<string, string | null>()
  const warnings: string[] = []
  let changes = 0
  const slots = new MergeSlots({
    now: () => Date.now(),
    running: (a) => running.has(a.runId),
    progressAt: (a) => progress.get(a.agentId) ?? null,
    changed: () => void changes++,
    note: (a, t) => void notes.set(a.agentId, t),
    warn: (_p, title) => void warnings.push(title)
  })
  const start = (...as: SlotAgent[]): void => as.forEach((a) => running.add(a.runId))
  return { slots, running, progress, notes, warnings, start, changes: () => changes }
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-07T10:00:00Z') }))
afterEach(() => vi.useRealTimers())

describe('merge slot', () => {
  it('gives the slot to one claim at a time, in the order they came', async () => {
    const { slots, start, notes } = setup()
    const [a, b, c] = [agent('B2'), agent('B4'), agent('B5')]
    start(a, b, c)
    expect(await slots.claim(a, P, 'main', [304], 0)).toMatchObject({ held: true })
    const second = slots.claim(b, P, 'main', [305], 60_000)
    const third = slots.claim(c, P, 'main', [], 60_000)
    await vi.advanceTimersByTimeAsync(10)
    expect(slots.status(P, 'main').waiting.map((w) => w.name)).toEqual(['B4', 'B5'])
    expect(notes.get('b4')).toBe('Waiting for the merge slot (B2 is merging #304)')
    expect(notes.get('b2')).toBe('Merging into main (merge slot)')
    expect(slots.release(a, P, 'main')).toMatchObject({ released: true, next: 'B4' })
    expect(await second).toMatchObject({ held: true })
    expect(notes.get('b2')).toBeNull()
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B4', cards: [305], taken: true })
    expect(slots.release(b, P, 'main')).toMatchObject({ released: true, next: 'B5' })
    expect(await third).toMatchObject({ held: true })
    slots.release(c, P, 'main')
    expect(slots.status(P, 'main')).toMatchObject({ holder: null, waiting: [] })
  })

  it('keeps separate slots per project and branch', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    expect(await slots.claim(b, P, 'release', [], 0)).toMatchObject({ held: true })
    expect(await slots.claim(b, 'C:\\ws\\other', 'main', [], 0)).toMatchObject({ held: true })
  })

  it("waits at most MAX_WAIT_MS in one call, under the 300 s after which Node's fetch gives up", async () => {
    expect(MAX_WAIT_MS).toBeLessThan(300_000)
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    let done = false
    const long = slots.claim(b, P, 'main', [], 3_600_000).then((r) => ((done = true), r))
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 10)
    expect(done).toBe(true)
    expect(await long).toMatchObject({ held: false, position: 1 })
  })

  it('a claim that times out keeps its place for a while, then loses it if not called again', async () => {
    const { slots, start } = setup()
    const [a, b, c] = [agent('A'), agent('B'), agent('C')]
    start(a, b, c)
    await slots.claim(a, P, 'main', [], 0)
    const timedOut = slots.claim(b, P, 'main', [], 30_000)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await timedOut).toMatchObject({ held: false, position: 1, waiting: 1, holder: { name: 'A' } })
    // C comes later: B is still ahead of it.
    const late = slots.claim(c, P, 'main', [], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await late).toMatchObject({ held: false, position: 2 })
    // B calls again in time and keeps first place.
    const again = slots.claim(b, P, 'main', [], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await again).toMatchObject({ held: false, position: 1 })
    // C stops asking: after KEEP_PLACE_MS it is out of line.
    await vi.advanceTimersByTimeAsync(KEEP_PLACE_MS + 2000)
    expect(slots.status(P, 'main').waiting.map((w) => w.name)).not.toContain('C')
  })

  it('a free slot given to a waiter between its calls is taken by calling again, or passes on', async () => {
    const { slots, start } = setup()
    const [a, b, c] = [agent('A'), agent('B'), agent('C')]
    start(a, b, c)
    await slots.claim(a, P, 'main', [], 0)
    const b1 = slots.claim(b, P, 'main', [], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await b1
    const cWaits = slots.claim(c, P, 'main', [], 10 * 60_000)
    slots.release(a, P, 'main')
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B', taken: false })
    // B never comes back: after KEEP_PLACE_MS the slot goes to C, and B is told why on its next call.
    await vi.advanceTimersByTimeAsync(KEEP_PLACE_MS + 2000)
    expect(await cWaits).toMatchObject({ held: true })
    expect(await slots.claim(b, P, 'main', [], 0)).toMatchObject({ held: false, lost: { why: expect.stringMatching(/didn't claim it/) } })
  })

  it('claiming again extends the hold; a hold that runs out passes on and is reported', async () => {
    const { slots, start, warnings } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    const first = await slots.claim(a, P, 'main', [], 0)
    await vi.advanceTimersByTimeAsync(HOLD_MS - 60_000)
    const ext = await slots.claim(a, P, 'main', [], 0)
    expect(ext).toMatchObject({ held: true, extended: true })
    expect(ext.held && first.held && ext.until > first.until).toBe(true)
    // B starts waiting four minutes before the extended hold runs out (a claim waits at most MAX_WAIT_MS).
    await vi.advanceTimersByTimeAsync(HOLD_MS - 240_000)
    const waits = slots.claim(b, P, 'main', [], MAX_WAIT_MS)
    await vi.advanceTimersByTimeAsync(260_000)
    expect(await waits).toMatchObject({ held: true })
    expect(warnings).toEqual(["A's merge slot expired"])
    expect(slots.release(a, P, 'main')).toMatchObject({ none: true, holder: { name: 'B' }, lost: { why: expect.stringMatching(/expired after/) } })
  })

  it('a holder still reporting progress keeps its hold past the limit', async () => {
    const { slots, start, progress, warnings } = setup()
    const a = agent('A')
    start(a)
    await slots.claim(a, P, 'main', [], 0)
    for (let t = 0; t < HOLD_MS + 30 * 60_000; t += 5 * 60_000) {
      progress.set('a', Date.now())
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    }
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'A' })
    // It stops reporting: it expires once that report is stale.
    await vi.advanceTimersByTimeAsync(PROGRESS_FRESH_MS + 5000)
    expect(slots.status(P, 'main').holder).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it("frees the slot when its holder's launch ends, and drops that launch's place in line", async () => {
    const { slots, start, running } = setup()
    const [a, b, c] = [agent('A'), agent('B'), agent('C')]
    start(a, b, c)
    await slots.claim(a, P, 'main', [], 0)
    const bWaits = slots.claim(b, P, 'main', [], 60_000)
    const cWaits = slots.claim(c, P, 'main', [], 60_000)
    await vi.advanceTimersByTimeAsync(10)
    running.delete(b.runId)
    slots.sessionEnded(P, 'b', b.runId)
    expect(await bWaits).toMatchObject({ held: false, position: 0 })
    running.delete(a.runId)
    slots.sessionEnded(P, 'a', a.runId)
    expect(await cWaits).toMatchObject({ held: true })
    // A new launch of A is someone else: it doesn't hold the old launch's slot.
    const a2 = agent('A', 'A-run-2')
    start(a2)
    expect(await slots.claim(a2, P, 'main', [], 0)).toMatchObject({ held: false })
  })

  it('a claim whose caller went away stops waiting, keeps its place, and takes its turn only by claiming again', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    const gone = new AbortController()
    const bWaits = slots.claim(b, P, 'main', [], 600_000, gone.signal)
    await vi.advanceTimersByTimeAsync(10)
    gone.abort()
    expect(await bWaits).toMatchObject({ held: false, position: 1 })
    slots.release(a, P, 'main')
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B', taken: false })
    expect(await slots.claim(b, P, 'main', [], 0)).toMatchObject({ held: true, extended: false })
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B', taken: true })
  })

  it('a launch that ended without telling is found out at the next look', async () => {
    const { slots, start, running } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    running.delete(a.runId)
    expect(await slots.claim(b, P, 'main', [], 0)).toMatchObject({ held: true })
  })

  it('the user can release a stuck holder; it is told on its next call', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [7], 0)
    const bWaits = slots.claim(b, P, 'main', [], 60_000)
    await vi.advanceTimersByTimeAsync(10)
    expect(slots.releaseByUser(P, 'main', slots.status(P, 'main').holder!.id)).toBe('A')
    expect(await bWaits).toMatchObject({ held: true })
    expect(slots.release(a, P, 'main')).toMatchObject({ none: true, lost: { why: 'the user released it' } })
    expect(() => slots.releaseByUser(P, 'nothing', 'h1')).toThrow(/changed hands/)
  })

  it('releases only the hold the user was shown, never one that came after (another agent, or the same one again)', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    const shown = slots.status(P, 'main').holder!.id
    // Claiming again extends the same hold: still the one shown.
    await slots.claim(a, P, 'main', [], 0)
    expect(slots.status(P, 'main').holder!.id).toBe(shown)
    // While the question is open, A releases and B takes the slot.
    slots.release(a, P, 'main')
    await slots.claim(b, P, 'main', [], 0)
    expect(() => slots.releaseByUser(P, 'main', shown)).toThrow(/changed hands meanwhile, so nothing was released/)
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B' })
    // The same agent holding it again is a new hold too.
    const bShown = slots.status(P, 'main').holder!.id
    slots.release(b, P, 'main')
    await slots.claim(b, P, 'main', [], 0)
    expect(() => slots.releaseByUser(P, 'main', bShown)).toThrow(/changed hands/)
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B' })
    expect(slots.releaseByUser(P, 'main', slots.status(P, 'main').holder!.id)).toBe('B')
    expect(slots.status(P, 'main').holder).toBeNull()
  })

  for (const how of ['its launch ended unnoticed', 'its hold ran out before its timer fired'] as const) {
    it(`a slot freed when a claim finds that ${how} is the one the claim takes: one holder, seen and recorded`, async () => {
      const { slots, start, running } = setup()
      const [a, b, c] = [agent('A'), agent('B'), agent('C')]
      start(a, b, c)
      await slots.claim(a, P, 'main', [], 0)
      if (how === 'its launch ended unnoticed') running.delete(a.runId)
      else vi.setSystemTime(Date.now() + HOLD_MS + 1000)
      expect(await slots.claim(b, P, 'main', [2], 0)).toMatchObject({ held: true })
      expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B', cards: [2] })
      expect(slots.list('C:\\ws').map((s) => s.holder?.name)).toEqual(['B'])
      expect(slots.heldByAgents().map((h) => h.agentName)).toEqual(['B'])
      // C comes after: it waits behind B rather than holding it too.
      expect(await slots.claim(c, P, 'main', [], 0)).toMatchObject({ held: false, position: 1, holder: { name: 'B' } })
      await expect(slots.asUser(P, 'main', async () => 1)).rejects.toThrow(/B is merging #2/)
    })
  }

  for (const outcome of ['succeeds', 'fails'] as const) {
    it(`a user merge whose hold was released ends (it ${outcome}) without releasing the newer merge's hold`, async () => {
      const { slots, start } = setup()
      const c = agent('C')
      start(c)
      let endFirst!: () => void
      let failFirst!: (e: Error) => void
      const first = slots.asUser(P, 'main', () => new Promise<void>((resolve, reject) => ((endFirst = resolve), (failFirst = reject))))
      await vi.advanceTimersByTimeAsync(10)
      // The user releases the first merge's hold, then starts another merge.
      slots.releaseByUser(P, 'main', slots.status(P, 'main').holder!.id)
      let endSecond!: () => void
      const second = slots.asUser(P, 'main', () => new Promise<void>((resolve) => (endSecond = resolve)))
      await vi.advanceTimersByTimeAsync(10)
      const newer = slots.status(P, 'main').holder!.id
      if (outcome === 'succeeds') endFirst()
      else failFirst(new Error('merge failed'))
      await first.catch(() => undefined)
      expect(slots.status(P, 'main').holder).toMatchObject({ id: newer, kind: 'user' })
      expect(await slots.claim(c, P, 'main', [], 0)).toMatchObject({ held: false, position: 1 })
      endSecond()
      await second
      // The newer merge's own end releases its own hold: the agent in line gets it.
      expect(slots.status(P, 'main').holder).toMatchObject({ name: 'C', taken: false })
    })
  }

  for (const outcome of ['succeeds', 'fails'] as const) {
    it(`a user merge that ${outcome} releases its own hold`, async () => {
      const { slots } = setup()
      const done = slots.asUser(P, 'main', async () => {
        if (outcome === 'fails') throw new Error('merge failed')
        return 1
      })
      if (outcome === 'fails') await expect(done).rejects.toThrow('merge failed')
      else expect(await done).toBe(1)
      expect(slots.status(P, 'main').holder).toBeNull()
    })
  }

  it("a claim whose caller went away doesn't undo a hold another call of the same launch was told it has", async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    const gone = new AbortController()
    // The call that stays tells the agent first, then the one whose caller left goes on. (Joining the line wakes the
    // waiting calls, which wait again after the new one: the later call is woken first.)
    const left = slots.claim(b, P, 'main', [], 200_000, gone.signal)
    await vi.advanceTimersByTimeAsync(10)
    const told = slots.claim(b, P, 'main', [], 200_000)
    await vi.advanceTimersByTimeAsync(10)
    slots.release(a, P, 'main')
    gone.abort()
    expect(await told).toMatchObject({ held: true })
    await left
    expect(slots.status(P, 'main').holder).toMatchObject({ name: 'B', taken: true })
    expect(slots.status(P, 'main').holder!.until).toBeGreaterThan(Date.now() + KEEP_PLACE_MS)
  })

  it("the user's merge after a slot was freed by a clean-up holds the slot others then see", async () => {
    const { slots, start, running } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    running.delete(a.runId)
    let release!: () => void
    const merging = slots.asUser(P, 'main', () => new Promise<void>((r) => (release = r)))
    await vi.advanceTimersByTimeAsync(10)
    expect(slots.status(P, 'main').holder).toMatchObject({ kind: 'user' })
    expect(await slots.claim(b, P, 'main', [], 0)).toMatchObject({ held: false, position: 1 })
    release()
    await merging
  })

  it("the user's merge takes a free slot for its length, and is refused while an agent holds or waits", async () => {
    const { slots, start } = setup()
    const a = agent('A')
    start(a)
    let during: unknown = null
    await slots.asUser(P, 'main', async () => {
      during = slots.status(P, 'main').holder
    })
    expect(during).toMatchObject({ kind: 'user', name: 'you' })
    expect(slots.status(P, 'main').holder).toBeNull()
    await slots.claim(a, P, 'main', [12], 0)
    await expect(slots.asUser(P, 'main', async () => 1)).rejects.toThrow(/A is merging #12 into main/)
    // An agent claiming while the user merges waits for it.
    slots.release(a, P, 'main')
    let release!: () => void
    const merging = slots.asUser(P, 'main', () => new Promise<void>((r) => (release = r)))
    const aWaits = slots.claim(a, P, 'main', [], 60_000)
    await vi.advanceTimersByTimeAsync(10)
    expect(slots.status(P, 'main').waiting.map((w) => w.name)).toEqual(['A'])
    release()
    await merging
    expect(await aWaits).toMatchObject({ held: true })
  })

  it('leaves the line on release while waiting, and says who holds it when not holding', async () => {
    const { slots, start, notes } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    const b1 = slots.claim(b, P, 'main', [], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await b1
    expect(slots.release(b, P, 'main')).toMatchObject({ left: true })
    expect(notes.get('b')).toBeNull()
    expect(slots.release(b, P, 'main')).toMatchObject({ none: true, holder: { name: 'A' } })
  })

  it('a release naming no branch is for the agent\'s one hold or place, whatever the folder is on (#586)', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    // A claims main, then checks its feature branch out in the folder: the folder's branch is feature now.
    await slots.claim(a, P, 'main', [], 0)
    expect(slots.releaseBranch(a, P)).toBe('main')
    expect(slots.release(a, P, slots.releaseBranch(a, P) ?? 'feature')).toMatchObject({ released: true, branch: 'main' })
    expect(slots.status(P, 'main').holder).toBeNull()
    // Its place in line, the same way.
    await slots.claim(a, P, 'main', [], 0)
    const waits = slots.claim(b, P, 'main', [], 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await waits
    expect(slots.releaseBranch(b, P)).toBe('main')
    // With none (it holds none), and with several, the folder's branch decides; the reply says what it holds.
    expect(slots.releaseBranch(agent('C'), P)).toBeNull()
    await slots.claim(a, P, 'release', [], 0)
    expect(slots.releaseBranch(a, P)).toBeNull()
    expect(slots.release(a, P, 'feature')).toMatchObject({ none: true, branch: 'feature', holder: null, yours: [{ branch: 'main', held: true }, { branch: 'release', held: true }] })
    expect(slots.release(b, P, 'feature')).toMatchObject({ none: true, yours: [{ branch: 'main', held: false }] })
    expect(slots.release(agent('C'), P, 'feature')).toMatchObject({ none: true, yours: [] })
    // Another project's slot isn't this one's.
    expect(slots.own(a, 'C:\\ws\\other')).toEqual([])
  })

  it('a release naming no branch after the hold expired is for the branch it lost, so it is told why', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), agent('B')]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    const waits = slots.claim(b, P, 'main', [], MAX_WAIT_MS)
    await vi.advanceTimersByTimeAsync(HOLD_MS + 1000)
    await waits
    expect(slots.releaseBranch(a, P)).toBe('main')
    expect(slots.release(a, P, 'main')).toMatchObject({ none: true, lost: { branch: 'main', why: expect.stringMatching(/expired/) } })
    expect(slots.releaseBranch(a, P)).toBeNull()
  })

  it('lists a workspace\'s slots, not another folder\'s with a similar name', async () => {
    const { slots, start } = setup()
    const [a, b] = [agent('A'), { ...agent('B'), projectPath: 'C:\\ws2\\hive' }]
    start(a, b)
    await slots.claim(a, P, 'main', [], 0)
    await slots.claim(b, 'C:\\ws2\\hive', 'main', [], 0)
    expect(slots.list('C:\\ws').map((s) => s.project)).toEqual([P])
    expect(slots.list('C:\\WS2').map((s) => s.project)).toEqual(['C:\\ws2\\hive'])
  })

  it('keeps a record of agents\' holds that a restart can read back, ignoring anything malformed', async () => {
    const { slots, start } = setup()
    const a = agent('A')
    start(a)
    await slots.claim(a, P, 'main', [3, 4], 0)
    const text = JSON.stringify({ version: 1, holds: [...slots.heldByAgents(), { projectPath: 1 }, null, 'x'] })
    // A new Combwork (a restart): nothing held in memory; the record says who held what.
    const fresh = setup().slots
    expect(fresh.heldByAgents()).toEqual([])
    expect(parseSlotRecords(text)).toEqual([{ projectPath: P, branch: 'main', agentId: 'a', agentName: 'A', runId: 'A-run', cards: [3, 4], since: Date.now(), until: Date.now() + HOLD_MS }])
    expect(parseSlotRecords('not json')).toEqual([])
    expect(parseSlotRecords('{"holds": 5}')).toEqual([])
    // The folder its agent merged in (#984) reads back; one that isn't a path's text is left out.
    const held = slots.heldByAgents()[0]
    expect(parseSlotRecords(JSON.stringify({ version: 1, holds: [{ ...held, cwd: 'D:/wt/b1' }, { ...held, cwd: 5 }] })).map((h) => h.cwd)).toEqual(['D:/wt/b1', undefined])
  })

  it('checks what a claim names', () => {
    expect(slotBranch(' main ')).toBe('main')
    for (const bad of ['', '  ', 'a b', 'x\ny', 7, null, 'x'.repeat(201)]) expect(() => slotBranch(bad)).toThrow(/branch must be/)
    expect(slotCards(undefined)).toEqual([])
    expect(slotCards([1, 2, 2])).toEqual([1, 2])
    for (const bad of [[0], [1.5], ['1'], 5, Array.from({ length: 21 }, (_, i) => i + 1)]) expect(() => slotCards(bad)).toThrow(/cards must be/)
  })
})
