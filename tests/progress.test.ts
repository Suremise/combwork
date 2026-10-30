// The Progress panel's store and rules: a run is its starter's (by token), others can't touch it; limits; merged
// updates; stale runs; the taskbar's combined bar; time left.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgressError, ProgressStore, admitReport, keptRuns, type ProgressCaller, type ProgressHistory } from '../src/main/progress'
import { FINISHING_MS, MAX_OPEN_PER_OWNER, ProgressSync, applyRunsPatch, MAX_OPEN_PER_WORKSPACE, PASSED_SHOWN_MS, RECENT_KEPT, STRIP_BARS, ALL_PROJECTS, agentOpenRun, barLook, runStateWord as stateWordIn, runStatusLine as statusLineIn, runWords, NO_PROJECT, SHOW_ALL, activeFilter, agentChoices, filterChoices as filterChoicesIn, filterMergeSlots, filterRuns, inStrip, isListed, isOpenRun, isOverdue, isRecent, runDetailsText as detailsTextIn, stripRuns, stripSummary, taskbarProgress, timeLeft, unseenTrouble } from '../src/shared/progress'
import type { MergeSlotInfo, ProgressRun, ProgressSnapshot } from '../src/shared/types'
import { setDateStyle } from '../src/shared/dates'
import { fmt, setLanguage, tr } from '../src/shared/i18n'
import { runAgentName } from '../src/shared/progress'
import { publicRun } from '../src/main/apiEvents'

// The panel's text is the window's (#798): worded with tr(), in English here.
const runStateWord = (r: Parameters<typeof stateWordIn>[0]): string => stateWordIn(r, tr)
const runStatusLine = (r: ProgressRun, now: number): string => statusLineIn(r, now, tr)
const runDetailsText = (r: ProgressRun, project: string | null, now: number): string => detailsTextIn(r, project, now, tr)
const filterChoices = (runs: readonly ProgressRun[], nameOf: (p: string) => string): ReturnType<typeof filterChoicesIn> => filterChoicesIn(runs, nameOf, tr)
const summaryOf = (runs: readonly ProgressRun[]): string => stripSummary(stripRuns(runs).counts, tr, (items) => fmt.list(items, 'unit'))

const WS = 'C:\\ws'
const alfie: ProgressCaller = { source: 'agent', workspacePath: WS, projectPath: 'C:\\ws\\alpha', agentId: 'a-1', agentName: 'Alfie', provider: 'claude-code' }
const betty: ProgressCaller = { source: 'agent', workspacePath: WS, projectPath: 'C:\\ws\\beta', agentId: 'a-2', agentName: 'Betty', provider: 'codex' }
// Same agent id in another project: still someone else.
const alfieTwin: ProgressCaller = { ...alfie, projectPath: 'C:\\ws\\gamma' }
const script: ProgressCaller = { source: 'api', workspacePath: WS }
const otherWsScript: ProgressCaller = { source: 'api', workspacePath: 'C:\\other' }
const assistant: ProgressCaller = { source: 'assistant', workspacePath: WS, agentName: 'Hive Assistant', provider: 'claude-code' }

let now = 1_000_000
let changes: { ws: string; runs: ProgressRun[]; patch?: ProgressRun[] | null }[] = []
let running = true
/** The reporters' processes still there (#549), by pid. */
let alivePids = new Set<number>()
const store = (): ProgressStore =>
  new ProgressStore({ now: () => now, changed: (ws, runs, patch) => changes.push({ ws, runs, patch }), ownerRunning: () => running, processAlive: (pid) => alivePids.has(pid), emitEveryMs: 250 })

const status = (fn: () => unknown): number | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ProgressError ? e.status : -1
  }
}

beforeEach(() => {
  now = 1_000_000
  changes = []
  running = true
  alivePids = new Set()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe("the window's tellings (#1108)", () => {
  const ids = (runs: ProgressRun[] | null | undefined): string[] | null => (runs ? runs.map((r) => r.id) : null)

  it('an update tells only the run that changed; runs updated together within the interval are told together', () => {
    const s = store()
    const a = s.start(alfie, { title: 'a', total: 10 })
    const b = s.start(betty, { title: 'b', total: 10 })
    for (let i = 0; i < 150; i++) {
      const done = s.start(script, { title: `old ${i}` })
      s.finish(script, done.id, { ok: true })
    }
    changes = []
    now += 1000
    s.update(alfie, a.id, { step: 1 })
    expect(changes.map((c) => ids(c.patch))).toEqual([[a.id]])
    expect(changes[0].runs).toHaveLength(152)
    expect(changes[0].patch![0]).toMatchObject({ id: a.id, step: 1 })
    // Within 250 ms: held, then both together.
    s.update(alfie, a.id, { step: 2 })
    s.update(betty, b.id, { step: 1 })
    expect(changes).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(changes.map((c) => ids(c.patch))).toEqual([[a.id], [b.id, a.id]])
  })

  it('a new run, a run gone stale and runs seen are told as patches; an end, a dismissal or the history the whole list', () => {
    const s = store()
    const a = s.start(alfie, { title: 'a' })
    expect(ids(changes.at(-1)!.patch)).toEqual([a.id])
    now += 1000
    s.update(alfie, a.id, { step: 1 })
    // A run's update waiting when it ends: the end tells the whole list, which has it.
    s.update(alfie, a.id, { step: 2 })
    s.finish(alfie, a.id, { ok: false })
    expect(changes.at(-1)!.patch).toBeNull()
    s.seen(WS)
    expect(ids(changes.at(-1)!.patch)).toEqual([a.id])
    const b = s.start(betty, { title: 'b' })
    running = false
    s.sweep()
    expect(ids(changes.at(-1)!.patch)).toEqual([b.id])
    s.dismiss(WS, b.id)
    expect(changes.at(-1)!.patch).toBeNull()
    s.clear(WS)
    expect(changes.at(-1)).toMatchObject({ runs: [], patch: null })
  })

  describe("a window's runs kept in step (ProgressSync)", () => {
    const run = (id: string, step: number, startedAt = 1): ProgressRun => ({ id, step, startedAt }) as ProgressRun
    /** A window on `ws`, its reads answered by hand: `answer(i, snap)` or `fail(i)` for the i-th read. */
    function windowOn(ws = 'C:\\A') {
      const state = { ws: ws as string | null, runs: [] as ProgressRun[] }
      const reads: { resolve: (s: ProgressSnapshot) => void; reject: (e: Error) => void }[] = []
      const sync = new ProgressSync({
        workspace: () => state.ws,
        runs: () => state.runs,
        set: (r) => void (state.runs = r),
        load: () => new Promise((resolve, reject) => void reads.push({ resolve, reject }))
      })
      const tell = (seq: number, runs: ProgressRun[], whole = false, workspacePath = state.ws ?? ''): void => sync.told({ type: 'progress-runs', workspacePath, seq, whole, runs })
      const answer = async (i: number, seq: number, runs: ProgressRun[], workspacePath = ws): Promise<void> => {
        reads[i].resolve({ workspacePath, seq, runs })
        await Promise.resolve()
      }
      const fail = async (i: number): Promise<void> => {
        reads[i].reject(new Error('gone'))
        await Promise.resolve()
      }
      const steps = (): (number | null)[] => state.runs.map((r) => r.step)
      return { state, reads, sync, tell, answer, fail, steps }
    }

    it("applies tellings that arrive while the list is read on top of it, after the list's number (HR2's round-1 case)", async () => {
      const w = windowOn()
      w.sync.reload()
      w.tell(10, [run('x', 10)]) // sent before the list was read: in it already
      w.tell(11, [run('x', 11)])
      await w.answer(0, 10, [run('x', 10)])
      expect(w.steps()).toEqual([11])
      // A skipped one reads again; one arriving meanwhile isn't lost, and the older list doesn't overwrite it.
      w.tell(13, [run('x', 13)])
      expect(w.reads).toHaveLength(2)
      w.tell(14, [run('x', 14)])
      await w.answer(1, 13, [run('x', 13)])
      expect(w.steps()).toEqual([14])
      w.tell(15, [run('x', 15)])
      expect(w.steps()).toEqual([15])
      expect(w.reads).toHaveLength(2)
    })

    it('a whole telling during a read is applied after the list when it is newer, and dropped when not', async () => {
      const w = windowOn()
      w.sync.reload()
      w.tell(5, [run('a', 1)], true)
      w.tell(7, [run('b', 1)], true)
      await w.answer(0, 6, [run('old', 1)])
      expect(w.state.runs.map((r) => r.id)).toEqual(['b'])
      w.tell(8, [run('b', 2)])
      expect(w.steps()).toEqual([2])
    })

    it("drops a read for a workspace the window no longer shows, and one a newer read replaced", async () => {
      const w = windowOn('C:\\A')
      w.sync.reload()
      w.state.ws = 'C:\\B'
      w.sync.reload()
      await w.answer(0, 3, [run('a-run', 1)], 'C:\\A')
      expect(w.state.runs).toEqual([])
      await w.answer(1, 9, [run('b-run', 1)], 'C:\\B')
      expect(w.state.runs.map((r) => r.id)).toEqual(['b-run'])
      // Another workspace's tellings never reach it.
      w.tell(10, [run('a-run', 2)], true, 'C:\\A')
      expect(w.state.runs.map((r) => r.id)).toEqual(['b-run'])
      // A telling for the workspace now shown while the old one's read is under way starts its own read.
      w.state.ws = 'C:\\A'
      w.tell(4, [run('a-run', 4)])
      expect(w.reads).toHaveLength(3)
    })

    it('reads at first, and again for a telling of some runs when a read failed; a whole telling is a base', async () => {
      const w = windowOn()
      w.tell(1, [run('x', 1)])
      expect(w.reads).toHaveLength(1)
      w.tell(2, [run('x', 2)])
      await w.fail(0)
      expect(w.state.runs).toEqual([])
      w.tell(3, [run('x', 3)])
      expect(w.reads).toHaveLength(2)
      w.tell(4, [run('x', 4)], true)
      await w.fail(1)
      expect(w.steps()).toEqual([4])
      w.tell(5, [run('x', 5)])
      expect(w.steps()).toEqual([5])
    })

    it('a failed read applies what waited after its newest whole telling, with no telling after (HR2, round 2)', async () => {
      const w = windowOn()
      w.sync.reload()
      w.tell(3, [run('x', 3)])
      w.tell(4, [run('x', 4)], true)
      w.tell(5, [run('x', 5)])
      await w.fail(0)
      expect(w.steps()).toEqual([5])
      expect(w.reads).toHaveLength(1)
      w.tell(6, [run('x', 6)])
      expect(w.steps()).toEqual([6])
    })

    it('a failed read whose waiting tellings skip one after the whole reads again, and the next read puts it right', async () => {
      const w = windowOn()
      w.sync.reload()
      w.tell(4, [run('x', 4)], true)
      w.tell(6, [run('x', 6)])
      await w.fail(0)
      expect(w.steps()).toEqual([4])
      expect(w.reads).toHaveLength(2)
      w.tell(7, [run('x', 7)])
      await w.answer(1, 6, [run('x', 6)])
      expect(w.steps()).toEqual([7])
    })

    it('a failed read with only some runs waiting reads again once, not on and on', async () => {
      const w = windowOn()
      w.sync.reload()
      w.tell(2, [run('x', 2)])
      await w.fail(0)
      expect(w.reads).toHaveLength(2)
      await w.fail(1)
      expect(w.reads).toHaveLength(2)
    })
  })

  it('a patch puts runs in place by id, keeps the others the same objects, and a new run by when it started', () => {
    const run = (id: string, startedAt: number, step = 0): ProgressRun => ({ id, startedAt, step }) as ProgressRun
    const before = [run('c', 30), run('b', 20), run('a', 10)]
    const after = applyRunsPatch(before, [run('b', 20, 5), run('d', 25), run('e', 40), run('z', 1)])
    expect(after.map((r) => r.id)).toEqual(['e', 'c', 'd', 'b', 'a', 'z'])
    expect(after[1]).toBe(before[0])
    expect(after[3]).toMatchObject({ step: 5 })
    expect(after[4]).toBe(before[2])
  })
})

describe('progress runs', () => {
  it("is the starter's: its agent, name and provider come from the caller, not the request", () => {
    const s = store()
    const r = s.start(alfie, { title: 'e2e: 12 suites', total: 12, agentName: 'Mallory', source: 'api' })
    expect(r).toMatchObject({ agentName: 'Alfie', agentId: 'a-1', projectPath: 'C:\\ws\\alpha', provider: 'claude-code', source: 'agent', total: 12, step: 0, state: 'running' })
    expect(s.start(script, { title: 'build' })).toMatchObject({ agentName: 'Script', agentId: null, source: 'api' })
    expect(s.start(assistant, { title: 'x' })).toMatchObject({ agentName: 'Hive Assistant', source: 'assistant' })
  })

  it("projects renamed together (#514): each one's runs, open and ended, are its own at its folder now (a swap keeps each one's), once", async () => {
    const s = store()
    const a = s.start(alfie, { title: 'done' })
    s.finish(alfie, a.id, { ok: true })
    const open = s.start(alfie, { title: 'going' })
    const b = s.start(betty, { title: 'beta' })
    changes = []
    const swap = [
      { from: 'C:\\WS\\Alpha', to: 'C:\\ws\\beta' },
      { from: 'C:\\ws\\beta', to: 'C:\\ws\\alpha' }
    ]
    await s.applyRenames(WS, swap, 2)
    const byId = () => new Map(s.list(WS).map((r) => [r.id, r.projectPath]))
    expect([byId().get(a.id), byId().get(open.id), byId().get(b.id)]).toEqual(['C:\\ws\\beta', 'C:\\ws\\beta', 'C:\\ws\\alpha'])
    expect(changes.at(-1)?.ws).toBe(WS)
    // Again (or an older one): nothing changes.
    await s.applyRenames(WS, swap, 2)
    await s.applyRenames(WS, [{ from: 'C:\\ws\\beta', to: 'C:\\ws\\x' }], 1)
    expect([byId().get(a.id), byId().get(b.id)]).toEqual(['C:\\ws\\beta', 'C:\\ws\\alpha'])
  })

  it("only its owner (or a script in the workspace) updates or finishes it; others get 404 as for an unknown run", () => {
    const s = store()
    const r = s.start(alfie, { title: 'tests', total: 3 })
    for (const who of [betty, alfieTwin, assistant, otherWsScript]) {
      expect(status(() => s.update(who, r.id, { step: 1 }))).toBe(404)
      expect(status(() => s.finish(who, r.id, { ok: true }))).toBe(404)
    }
    expect(status(() => s.update(alfie, 'nope', { step: 1 }))).toBe(404)
    expect(s.update(alfie, r.id, { step: 1, stepName: 'carddialog' })).toMatchObject({ step: 1, stepName: 'carddialog' })
    expect(s.update(script, r.id, { step: 2 }).step).toBe(2)
    const a = s.start(assistant, { title: 'assistant run' })
    expect(status(() => s.update(alfie, a.id, {}))).toBe(404)
    expect(s.update(assistant, a.id, { estimateMs: 1000 }).estimateMs).toBe(1000)
  })

  it('validates input and caps text', () => {
    const s = store()
    expect(status(() => s.start(alfie, {}))).toBe(400)
    expect(status(() => s.start(alfie, { title: '   ' }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 0 }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 'many' }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', total: 3, step: 4 }))).toBe(400)
    expect(status(() => s.start(alfie, { title: 'x', estimateMs: -1 }))).toBe(400)
    const long = s.start(alfie, { title: 'y'.repeat(500), command: 'z'.repeat(500), stepName: 'w\n'.repeat(200) })
    expect(long.title.length).toBe(120)
    expect(long.command!.length).toBe(200)
    expect(long.stepName!.length).toBeLessThanOrEqual(120)
    expect(status(() => s.update(alfie, long.id, { step: 1.5e9 }))).toBe(400)
    expect(status(() => s.finish(alfie, long.id, {}))).toBe(400)
  })

  it('takes a late total once, on a run started without one; a run with a total keeps it', () => {
    const s = store()
    const late = s.start(alfie, { title: 'counts late' })
    s.update(alfie, late.id, { step: 7, stepName: 'setup' })
    // A refused update changes nothing: out of range, or a step past the new total.
    expect(status(() => s.update(alfie, late.id, { total: 0 }))).toBe(400)
    expect(status(() => s.update(alfie, late.id, { total: 4, step: 5 }))).toBe(400)
    expect(late).toMatchObject({ total: null, step: 7, stepName: 'setup' })
    // A step already past the total is kept within it.
    expect(s.update(alfie, late.id, { total: 5 })).toMatchObject({ total: 5, step: 5, stepName: 'setup' })
    expect(s.update(alfie, late.id, { step: 2 }).step).toBe(2)
    expect(status(() => s.update(alfie, late.id, { total: 5 }))).toBe(409)
    expect(status(() => s.update(alfie, late.id, { total: 8, step: 3 }))).toBe(409)
    expect(late).toMatchObject({ total: 5, step: 2 })
    const early = s.start(alfie, { title: 'counts early', total: 3 })
    expect(status(() => s.update(alfie, early.id, { total: 6 }))).toBe(409)
    expect(s.update(alfie, s.start(alfie, { title: 'with name' }).id, { total: 3, step: 1, stepName: 'b' })).toMatchObject({ total: 3, step: 1, stepName: 'b' })
  })

  it(`allows ${MAX_OPEN_PER_OWNER} open runs per owner, counted separately for each`, () => {
    const s = store()
    const ids = Array.from({ length: MAX_OPEN_PER_OWNER }, (_, i) => s.start(alfie, { title: `run ${i}` }).id)
    expect(status(() => s.start(alfie, { title: 'one too many' }))).toBe(429)
    expect(status(() => s.start(betty, { title: 'mine' }))).toBeNull()
    expect(status(() => s.start(script, { title: 'a script' }))).toBeNull()
    s.finish(alfie, ids[0], { ok: true })
    expect(status(() => s.start(alfie, { title: 'room again' }))).toBeNull()
  })

  it(`keeps the newest ${RECENT_KEPT} ended runs (the next drops the oldest), never dropping open ones`, () => {
    const s = store()
    const first = s.start(betty, { title: 'open, oldest' })
    for (let i = 0; i < RECENT_KEPT; i++) s.finish(alfie, s.start(alfie, { title: `r${i}` }).id, { ok: true })
    expect(s.list(WS).length).toBe(RECENT_KEPT + 1)
    expect(s.list(WS).at(-2)?.title).toBe('r0')
    // The 201st ended run: r0, the oldest ended, goes; the open one stays.
    s.finish(alfie, s.start(alfie, { title: `r${RECENT_KEPT}` }).id, { ok: false })
    const list = s.list(WS)
    expect(list.length).toBe(RECENT_KEPT + 1)
    expect(list.some((r) => r.title === 'r0')).toBe(false)
    expect(list.at(-2)?.title).toBe('r1')
    expect(list.some((r) => r.id === first.id)).toBe(true)
    expect(list[0].title).toBe(`r${RECENT_KEPT}`)
    // A dismissed stale run ends too, and counts the same.
    running = false
    s.sweep()
    s.dismiss(WS, first.id)
    expect(s.list(WS).length).toBe(RECENT_KEPT)
    expect(s.list(WS).some((r) => r.id === first.id)).toBe(false)
  })

  it('finishing: passed fills the bar, failed marks the failure unseen until the panel is looked at; no changes after', () => {
    const s = store()
    const a = s.start(alfie, { title: 'unit', total: 10 })
    expect(s.finish(alfie, a.id, { ok: true, summary: 'all good' })).toMatchObject({ state: 'passed', step: 10, finishedAt: now })
    expect(status(() => s.update(alfie, a.id, { step: 3 }))).toBe(409)
    expect(status(() => s.finish(alfie, a.id, { ok: false }))).toBe(409)
    expect(s.failureUnseen(WS)).toBe(false)
    const b = s.start(alfie, { title: 'e2e' })
    s.finish(alfie, b.id, { ok: false, summary: '2 suites failed' })
    expect(s.failureUnseen(WS)).toBe(true)
    s.seen(WS)
    expect(s.failureUnseen(WS)).toBe(false)
  })

  it('seen: each failed or stale run the user had not seen is marked, once; a new report or failure is unseen again (#220)', () => {
    const s = store()
    const f = s.start(alfie, { title: 'e2e' })
    s.finish(alfie, f.id, { ok: false, summary: '1 failed' })
    expect(s.list(WS)[0].seenAt).toBeNull()
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === f.id)!.seenAt).toBe(now)
    const seenAt = now
    now += 5000
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === f.id)!.seenAt).toBe(seenAt)
    // A stale run seen, then reporting again: unseen again if it goes stale or fails later.
    const q = s.start(betty, { title: 'build' })
    running = false
    s.sweep()
    s.seen(WS)
    expect(s.list(WS).find((r) => r.id === q.id)!.seenAt).toBe(now)
    running = true
    expect(s.update(betty, q.id, { step: 1 }).seenAt).toBeNull()
    expect(s.finish(betty, q.id, { ok: false }).seenAt).toBeNull()
  })

  it('finish takes an exit code and a log path (both optional); the first estimate gives the expected time (#220)', () => {
    const s = store()
    const r = s.start(alfie, { title: 'e2e', estimateMs: 60_000 })
    expect(r.expectedMs).toBe(60_000)
    expect(status(() => s.finish(alfie, r.id, { ok: false, exitCode: 'one' }))).toBe(400)
    expect(status(() => s.finish(alfie, r.id, { ok: false, logPath: 7 }))).toBe(400)
    expect(s.finish(alfie, r.id, { ok: false, exitCode: 3, logPath: 'C:\\logs\\run-record.md' })).toMatchObject({ exitCode: 3, logPath: 'C:\\logs\\run-record.md' })
    const late = s.start(alfie, { title: 'unit' })
    expect(late.expectedMs).toBeNull()
    now += 10_000
    expect(s.update(alfie, late.id, { estimateMs: 20_000 }).expectedMs).toBe(30_000)
    now += 5000
    expect(s.update(alfie, late.id, { estimateMs: 99_000 }).expectedMs).toBe(30_000)
    expect(s.finish(alfie, late.id, { ok: true })).toMatchObject({ exitCode: null, logPath: null })
  })

  it('dismissing moves a finished or stale run to Recent; a running one stays', () => {
    const s = store()
    const r = s.start(alfie, { title: 'x' })
    s.dismiss(WS, r.id)
    expect(s.list(WS)[0].dismissed).toBe(false)
    s.finish(alfie, r.id, { ok: false })
    s.dismiss(WS, r.id)
    expect(s.list(WS)[0].dismissed).toBe(true)
  })

  it('goes stale when quiet for longer than expected or when its agent stops; a report revives it', () => {
    const s = store()
    const quiet = s.start(alfie, { title: 'no estimate' })
    const timed = s.start(betty, { title: 'steps', total: 4, step: 0, estimateMs: 4 * 60_000 })
    now += 2 * 60_000 + 59_000
    s.sweep()
    expect(s.list(WS).find((r) => r.id === timed.id)!.state).toBe('running')
    now += 2_000 // one step's share (1 min) + 2 min grace has passed
    s.sweep()
    expect(s.list(WS).find((r) => r.id === timed.id)).toMatchObject({ state: 'stale', staleReason: 'quiet' })
    expect(s.list(WS).find((r) => r.id === quiet.id)!.state).toBe('running')
    s.update(betty, timed.id, { step: 1 })
    expect(s.list(WS).find((r) => r.id === timed.id)).toMatchObject({ state: 'running', staleReason: null })
    running = false
    s.sweep()
    expect(s.list(WS).every((r) => r.state === 'stale' && r.staleReason === 'agent-stopped')).toBe(true)
    // A script's run has no session to stop.
    running = true
    const sc = s.start(script, { title: 'script' })
    running = false
    s.sweep()
    expect(s.list(WS).find((r) => r.id === sc.id)!.state).toBe('running')
  })

  it("a keep-alive (an empty report: hive-progress's command still writing output, HI-1993) keeps it running, and its deadline", () => {
    const s = store()
    const loop = s.start(alfie, { title: 'stress loop' })
    const timed = s.start(betty, { title: 'timed', estimateMs: 20 * 60_000 })
    for (let i = 0; i < 15; i++) {
      now += 60_000
      s.update(alfie, loop.id, {})
      s.update(betty, timed.id, {})
      s.sweep()
    }
    expect(s.list(WS).find((r) => r.id === loop.id)).toMatchObject({ state: 'running', staleReason: null })
    // What is left of an estimate is as it was: a keep-alive moves no deadline.
    expect(timeLeft(s.list(WS).find((r) => r.id === timed.id)!, now)).toBe(5 * 60_000)
    // Silent past the limit, it goes stale as before.
    now += 10 * 60_000 + 1000
    s.sweep()
    expect(s.list(WS).find((r) => r.id === loop.id)).toMatchObject({ state: 'stale', staleReason: 'quiet' })
  })

  it('waiting (#549): no time left while it waits, never stale meanwhile; what was left comes back from when it stops waiting', () => {
    const s = store()
    // Waiting from the start, with an estimate: it is held, not counted down.
    const q = s.start(alfie, { title: 'e2e', estimateMs: 10 * 60_000, waiting: 'waiting for a test slot: held by B4' })
    expect(q).toMatchObject({ waiting: 'waiting for a test slot: held by B4', waitingSince: now, estimateMs: null, heldEstimateMs: 10 * 60_000, expectedMs: 10 * 60_000 })
    expect(timeLeft(q, now + 60_000)).toBeNull()
    // Quiet for 46 minutes while it waits: still running.
    now += 46 * 60_000
    s.sweep()
    expect(s.list(WS)[0]).toMatchObject({ state: 'running', staleReason: null })
    // Who it waits for changes: still waiting since then, the estimate still held.
    s.update(alfie, q.id, { waiting: 'waiting for a test slot: held by B5' })
    expect(s.list(WS)[0]).toMatchObject({ waiting: 'waiting for a test slot: held by B5', waitingSince: 1_000_000, estimateMs: null, heldEstimateMs: 10 * 60_000 })
    // The wait ends: the ten minutes count from now, as if it had just started.
    s.update(alfie, q.id, { waiting: '', total: 3, step: 0 })
    expect(s.list(WS)[0]).toMatchObject({ waiting: null, waitingSince: null, heldEstimateMs: null, estimateMs: 10 * 60_000, updatedAt: now })
    expect(timeLeft(s.list(WS)[0], now + 60_000)).toBe(9 * 60_000)
    // A running run that begins to wait keeps what was left then; an estimate sent while waiting is held too.
    now += 2 * 60_000
    s.update(alfie, q.id, { waiting: 'waiting for the merge slot' })
    expect(s.list(WS)[0]).toMatchObject({ estimateMs: null, heldEstimateMs: 8 * 60_000 })
    s.update(alfie, q.id, { estimateMs: 5 * 60_000 })
    expect(s.list(WS)[0]).toMatchObject({ estimateMs: null, heldEstimateMs: 5 * 60_000 })
    s.update(alfie, q.id, { waiting: '' })
    expect(s.list(WS)[0].estimateMs).toBe(5 * 60_000)
    // A finish ends the wait, whenever it comes.
    s.update(alfie, q.id, { waiting: 'again' })
    s.finish(alfie, q.id, { ok: true })
    expect(s.list(WS)[0]).toMatchObject({ state: 'passed', waiting: null, waitingSince: null })
    expect(status(() => s.update(alfie, s.start(alfie, { title: 'x' }).id, { waiting: 5 }))).toBe(400)
  })

  it('stopped (#549): an interrupted finish is neither passed nor failed, and no failure to see', () => {
    const s = store()
    const r = s.start(alfie, { title: 'server', total: 4, step: 1 })
    expect(status(() => s.finish(alfie, r.id, { ok: false, stopped: 'yes' }))).toBe(400)
    s.finish(alfie, r.id, { ok: false, stopped: true, summary: 'interrupted', exitCode: 3221225786 })
    const done = s.list(WS)[0]
    expect(done).toMatchObject({ state: 'stopped', stopReason: 'interrupted', step: 1, summary: 'interrupted', exitCode: 3221225786, finishedAt: now })
    expect(s.failureUnseen(WS)).toBe(false)
    expect([unseenTrouble(done), isOpenRun(done)]).toEqual([false, false])
    // Listed a few seconds, as a passed run, then under Recent.
    expect([isListed(done, now + PASSED_SHOWN_MS - 1), isRecent(done, now + PASSED_SHOWN_MS)]).toEqual([true, true])
    expect(runStateWord(done)).toBe('stopped')
  })

  it("ended without a report (#549): an open run whose reporter's process is gone ends as stopped (gone), stale or not", () => {
    const s = store()
    alivePids = new Set([11, 12, 13])
    const a = s.start(alfie, { title: 'server', pid: 11 })
    const b = s.start(betty, { title: 'quiet', pid: 12 })
    const c = s.start(script, { title: 'alive', pid: 13 })
    const d = s.start(assistant, { title: 'no pid' })
    expect(a.pid).toBe(11)
    expect(status(() => s.start(alfie, { title: 'bad', pid: -4 }))).toBe(400)
    // b has gone quiet first: stale, as before.
    now += 11 * 60_000
    s.update(alfie, a.id, { step: 0 })
    s.update(script, c.id, { step: 0 })
    s.update(assistant, d.id, { step: 0 })
    s.sweep()
    expect(s.list(WS).find((r) => r.id === b.id)).toMatchObject({ state: 'stale', staleReason: 'quiet' })
    // Then a's and b's processes are gone: both end, without a report; c (alive) and d (no pid) go on.
    alivePids = new Set([13])
    changes = []
    s.sweep()
    for (const id of [a.id, b.id]) expect(s.list(WS).find((r) => r.id === id)).toMatchObject({ state: 'stopped', stopReason: 'gone', staleReason: null, finishedAt: now, summary: null })
    expect(s.list(WS).find((r) => r.id === c.id)!.state).toBe('running')
    expect(s.list(WS).find((r) => r.id === d.id)!.state).toBe('running')
    expect(changes).toHaveLength(1)
    expect(s.failureUnseen(WS)).toBe(false)
    const gone = s.list(WS).find((r) => r.id === a.id)!
    expect(runStateWord(gone)).toBe('ended without a report')
    expect(isOpenRun(gone)).toBe(false)
    // An ended run takes no more reports.
    expect(status(() => s.update(alfie, a.id, { step: 1 }))).toBe(409)
    // Without a way to check processes, a pid is never looked at.
    const plain = new ProgressStore({ now: () => now, changed: () => undefined, ownerRunning: () => true })
    plain.start(alfie, { title: 'x', pid: 99 })
    plain.sweep()
    expect(plain.list(WS)[0].state).toBe('running')
  })

  it('merges rapid updates into at most one window event per interval, with the latest state', () => {
    const s = store()
    const r = s.start(alfie, { title: 'fast', total: 100 })
    changes = []
    for (let i = 1; i <= 50; i++) s.update(alfie, r.id, { step: i })
    expect(changes.length).toBe(0)
    now += 250
    vi.advanceTimersByTime(250)
    expect(changes.length).toBe(1)
    expect(changes[0].runs[0].step).toBe(50)
  })

  it('reports the latest open run of an agent, matched by project and agent', () => {
    const s = store()
    expect(s.openRunOf(alfie.source === 'agent' ? alfie.projectPath : '', 'a-1')).toBeNull()
    const r = s.start(alfie, { title: 'mine' })
    s.start(alfieTwin, { title: 'twin' })
    expect(s.openRunOf('c:\\WS\\ALPHA', 'a-1')?.id).toBe(r.id)
    s.finish(alfie, r.id, { ok: true })
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toBeNull()
  })

  // --- Review round 1 (Codex): each finding, as found.

  it(`holds the workspace to ${MAX_OPEN_PER_WORKSPACE} open runs across many owners, stale ones counting as open`, () => {
    const s = store()
    const owner = (i: number): ProgressCaller => ({ ...alfie, agentId: `a-${i}`, agentName: `A${i}` })
    const first = s.start(owner(0), { title: 'stale soon' })
    running = false
    s.sweep() // the first goes stale: still open
    running = true
    for (let i = 1; i < MAX_OPEN_PER_WORKSPACE; i++) s.start(owner(i), { title: `r${i}` })
    expect(s.list(WS).length).toBe(MAX_OPEN_PER_WORKSPACE)
    expect(status(() => s.start(owner(999), { title: 'one too many' }))).toBe(429)
    expect(status(() => s.start(script, { title: 'a script too' }))).toBe(429)
    expect(s.list(WS).length).toBe(MAX_OPEN_PER_WORKSPACE)
    // A run that ends makes room: a dismissed stale one, which stays under Recent.
    s.dismiss(WS, first.id)
    expect(status(() => s.start(owner(999), { title: 'room' }))).toBeNull()
    expect(s.list(WS).length).toBe(MAX_OPEN_PER_WORKSPACE + 1)
    expect(s.list(WS).some((r) => r.id === first.id)).toBe(true)
    expect(status(() => s.start(owner(1000), { title: 'full again' }))).toBe(429)
    // Another workspace has its own bound.
    expect(status(() => s.start(otherWsScript, { title: 'elsewhere' }))).toBeNull()
  })

  it("clearing a workspace (closed or switched) forgets its runs, unseen failure and timers; others' runs stay", () => {
    const s = store()
    const mine = s.start(script, { title: 'mine', total: 10 })
    const failed = s.start(script, { title: 'failed' })
    s.finish(script, failed.id, { ok: false })
    const theirs = s.start(otherWsScript, { title: 'other window' })
    s.update(script, mine.id, { step: 1 })
    s.update(script, mine.id, { step: 2 }) // a merged window event is pending
    changes = []
    s.clear(WS)
    expect(changes).toEqual([{ ws: WS, runs: [], patch: null }])
    expect(s.list(WS)).toEqual([])
    expect(s.failureUnseen(WS)).toBe(false)
    expect(status(() => s.update(script, mine.id, { step: 3 }))).toBe(404)
    // The pending event was dropped with it: nothing more is sent for the closed workspace.
    now += 1000
    vi.advanceTimersByTime(1000)
    expect(changes.length).toBe(1)
    expect(s.list('C:\\other').map((r) => r.id)).toEqual([theirs.id])
    // Reopened, it starts empty and works as new.
    expect(s.start(script, { title: 'after' }).title).toBe('after')
  })

  it('a rejected finish changes nothing, for either outcome, and can be sent again', () => {
    const s = store()
    for (const ok of [true, false]) {
      const r = s.start(script, { title: `finish ${ok}`, total: 4, step: 1 })
      changes = []
      expect(status(() => s.finish(script, r.id, { ok, summary: 123 }))).toBe(400)
      expect(s.list(WS).find((x) => x.id === r.id)).toMatchObject({ state: 'running', finishedAt: null, step: 1, summary: null })
      expect(changes).toEqual([])
      expect(s.failureUnseen(WS)).toBe(false)
      expect(s.finish(script, r.id, { ok, summary: 'done' }).state).toBe(ok ? 'passed' : 'failed')
      expect(s.failureUnseen(WS)).toBe(!ok)
      s.seen(WS)
    }
    // A rejected start or update changes nothing either.
    const before = s.list(WS).length
    expect(status(() => s.start(script, { title: 'x', command: 5 }))).toBe(400)
    expect(s.list(WS).length).toBe(before)
    const r = s.start(script, { title: 'u', total: 4 })
    expect(status(() => s.update(script, r.id, { step: 2, stepName: 7 }))).toBe(400)
    expect(s.list(WS).find((x) => x.id === r.id)!.step).toBe(0)
  })

  it('a dismissed stale run has ended: out of status and the taskbar, takes no reports, frees its owner', () => {
    // Only the agents named here are running.
    const up = new Set(['a-2'])
    const s = new ProgressStore({ now: () => now, changed: () => undefined, ownerRunning: (r) => up.has(r.agentId ?? ''), emitEveryMs: 250 })
    const r = s.start(alfie, { title: 'long run', total: 10 })
    const other = s.start(betty, { title: 'still going', total: 4, step: 2 })
    s.sweep()
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toMatchObject({ id: r.id, state: 'stale' })
    s.dismiss(WS, r.id)
    expect(s.openRunOf('C:\\ws\\alpha', 'a-1')).toBeNull()
    // Mixed: the dismissed stale run no longer counts; the running one does.
    expect(taskbarProgress(s.list(WS), false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(status(() => s.update(alfie, r.id, { step: 1 }))).toBe(409)
    expect(status(() => s.finish(alfie, r.id, { ok: true }))).toBe(409)
    s.dismiss(WS, other.id) // running: not dismissable
    expect(s.openRunOf('C:\\ws\\beta', 'a-2')?.id).toBe(other.id)
    // The last open run goes stale and is dismissed: the taskbar goes off.
    up.clear()
    s.sweep()
    expect(taskbarProgress(s.list(WS), false).mode).toBe('normal')
    s.dismiss(WS, other.id)
    expect(taskbarProgress(s.list(WS), false).mode).toBe('none')
    expect(s.openRunOf('C:\\ws\\beta', 'a-2')).toBeNull()
  })

  it("an update without an estimate keeps the deadline; only a new estimate moves it", () => {
    const s = store()
    const r = s.start(alfie, { title: 'timed', total: 4, estimateMs: 60_000 })
    now += 30_000
    s.update(alfie, r.id, { step: 1 })
    expect(timeLeft(s.list(WS)[0], now)).toBe(30_000)
    now += 10_000
    s.update(alfie, r.id, { stepName: 'heartbeat' })
    expect(timeLeft(s.list(WS)[0], now)).toBe(20_000)
    now += 30_000
    s.update(alfie, r.id, { stepName: 'late' })
    expect(timeLeft(s.list(WS)[0], now)).toBe(0)
    s.update(alfie, r.id, { estimateMs: 45_000 })
    expect(timeLeft(s.list(WS)[0], now)).toBe(45_000)
    // A run without an estimate stays without one.
    const n = s.start(alfie, { title: 'untimed' })
    s.update(alfie, n.id, { stepName: 'x' })
    expect(s.list(WS).find((x) => x.id === n.id)!.estimateMs).toBeNull()
  })

  // --- Review round 2 (Codex): a report whose caller is still being looked up when the setting changes.

  it('a report resolving while the panel is turned off (or off and on again) is ignored and stores nothing', async () => {
    let on = true
    let generation = 0
    const gate = { on: () => on, generation: () => generation }
    const toggle = (v: boolean): void => {
      on = v
      generation++
    }
    const s = store()
    /** A caller lookup the test finishes when it chooses (as reading project.json can take a while). */
    const slow = (): { resolve: () => Promise<ProgressCaller>; release: () => void } => {
      let release!: () => void
      const ready = new Promise<void>((r) => (release = r))
      return { resolve: async () => (await ready, alfie), release }
    }
    const IGNORED: unknown = { ignored: true }
    const startOf = (c: ProgressCaller) => s.start(c, { title: 'late after panel off' })

    // Off while resolving: ignored, nothing stored, nothing on again.
    let lookup = slow()
    let reply = admitReport(gate, IGNORED, lookup.resolve, startOf)
    toggle(false)
    s.clear()
    lookup.release()
    expect(await reply).toBe(IGNORED)
    expect(s.list(WS)).toEqual([])
    toggle(true)
    expect(s.list(WS)).toEqual([])

    // Off and on again while resolving: an older lifetime can't recreate a run.
    lookup = slow()
    reply = admitReport(gate, IGNORED, lookup.resolve, startOf)
    toggle(false)
    s.clear()
    toggle(true)
    lookup.release()
    expect(await reply).toBe(IGNORED)
    expect(s.list(WS)).toEqual([])

    // Updates and finishes the same way: the run (started after) is untouched.
    const run = admitReport(gate, IGNORED, async () => alfie, startOf)
    const id = ((await run) as ProgressRun).id
    for (const change of [(c: ProgressCaller) => s.update(c, id, { step: 5 }), (c: ProgressCaller) => s.finish(c, id, { ok: false })]) {
      lookup = slow()
      reply = admitReport(gate, IGNORED, lookup.resolve, change)
      toggle(false)
      toggle(true)
      lookup.release()
      expect(await reply).toBe(IGNORED)
    }
    expect(s.list(WS)[0]).toMatchObject({ id, state: 'running', step: null, finishedAt: null })
    expect(s.failureUnseen(WS)).toBe(false)

    // Off before it starts: ignored without looking the caller up. On and unchanged: admitted.
    on = false
    let looked = false
    expect(await admitReport(gate, IGNORED, async () => ((looked = true), alfie), startOf)).toBe(IGNORED)
    expect(looked).toBe(false)
    on = true
    expect(((await admitReport(gate, IGNORED, async () => alfie, startOf)) as ProgressRun).title).toBe('late after panel off')
  })

  it('forgets runs when cleared (the panel turned off)', () => {
    const s = store()
    const r = s.start(alfie, { title: 'x' })
    s.clear()
    expect(s.list(WS)).toEqual([])
    expect(status(() => s.update(alfie, r.id, {}))).toBe(404)
  })
})

describe('progress rules', () => {
  it("an agent's open run and its few words, for the Assistant's overview (#311)", () => {
    const mine = { source: 'agent' as const, projectPath: 'C:\\ws\\Alpha', agentId: 'a-1' }
    const runs = [
      run({ ...mine, id: 'ended', state: 'passed', finishedAt: 5 }),
      run({ ...mine, id: 'twin', projectPath: 'C:\\ws\\gamma' }),
      run({ id: 'script', source: 'api', agentId: 'a-1', projectPath: null }),
      run({ ...mine, id: 'open', title: 'e2e: 12 suites', total: 12, step: 4 })
    ]
    expect(agentOpenRun(runs, 'c:\\ws\\alpha', 'a-1')?.id).toBe('open')
    expect(agentOpenRun(runs, 'c:\\ws\\alpha', 'a-2')).toBeNull()
    expect(runWords(runs[3])).toBe('e2e: 12 suites 4/12')
    expect(runWords(run({ title: 'build', total: null, step: null }))).toBe('build')
    expect(runWords(run({ title: 'unit', total: 3, step: 9, state: 'stale' }))).toBe('unit 3/3 · stopped reporting')
  })

  it(`the folded strip: a bar for the newest ${STRIP_BARS}, the rest counted with the worst state, and every run in words`, () => {
    const runs = (states: ProgressRun['state'][]): ProgressRun[] => states.map((state, i) => ({ ...run({ state }), id: `r${i}` }))
    expect(stripRuns([])).toEqual({ bars: [], more: [], moreState: null, counts: [] })
    expect(summaryOf([])).toBe('')
    expect(summaryOf(runs(['stale']))).toBe('1 run, stopped reporting')
    const six = stripRuns(runs(['running', 'failed', 'running', 'stale', 'passed', 'running']))
    expect([six.bars.length, six.more.length, six.moreState]).toEqual([6, 0, null])
    expect(summaryOf(runs(['running', 'failed', 'running', 'stale', 'passed', 'running']))).toBe('6 runs: 3 running, 1 failed, 1 stopped reporting, 1 passed')
    const nine = stripRuns(runs(['running', 'running', 'running', 'running', 'running', 'running', 'running', 'stale', 'failed']))
    expect(nine.bars.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(nine.more.map((r) => r.id)).toEqual(['r6', 'r7', 'r8'])
    expect(nine.moreState).toBe('failed')
    expect(summaryOf(runs(['running', 'running', 'running', 'running', 'running', 'running', 'running', 'stale', 'failed']))).toBe('9 runs: 7 running, 1 failed, 1 stopped reporting')
    expect(stripRuns(runs(['running', 'running', 'running', 'running', 'running', 'running', 'stale'])).moreState).toBe('stale')
    expect(stripRuns(runs(['failed', 'running', 'running', 'running', 'running', 'running', 'running'])).moreState).toBeNull()
  })

  const run = (over: Partial<ProgressRun>): ProgressRun => ({
    id: 'r',
    workspacePath: WS,
    projectPath: null,
    agentId: null,
    agentName: 'x',
    provider: null,
    source: 'api',
    title: 't',
    command: null,
    total: null,
    step: null,
    stepName: null,
    estimateMs: null,
    startedAt: 0,
    updatedAt: 0,
    finishedAt: null,
    state: 'running',
    staleReason: null,
    stopReason: null,
    waiting: null,
    waitingSince: null,
    heldEstimateMs: null,
    pid: null,
    summary: null,
    dismissed: false,
    seenAt: null,
    expectedMs: null,
    exitCode: null,
    logPath: null,
    ...over
  })

  it('a failed or stale run is listed until seen and a few seconds more, then is under Recent; the strip drops it when seen (#220)', () => {
    const failed = run({ state: 'failed', finishedAt: 100 })
    expect([isListed(failed, 1e9), inStrip(failed, 1e9), isRecent(failed, 1e9), unseenTrouble(failed)]).toEqual([true, true, false, true])
    const seen = { ...failed, seenAt: 1000 }
    expect([isListed(seen, 1000 + PASSED_SHOWN_MS - 1), inStrip(seen, 1000), isRecent(seen, 1000), unseenTrouble(seen)]).toEqual([true, false, false, false])
    expect([isListed(seen, 1000 + PASSED_SHOWN_MS), isRecent(seen, 1000 + PASSED_SHOWN_MS)]).toEqual([false, true])
    const stale = run({ state: 'stale', seenAt: 0 })
    expect([isListed(stale, PASSED_SHOWN_MS), isRecent(stale, PASSED_SHOWN_MS)]).toEqual([false, true])
    expect(isListed(run({ state: 'stale' }), 1e9)).toBe(true)
    const passed = run({ state: 'passed', finishedAt: 0 })
    expect([isListed(passed, PASSED_SHOWN_MS - 1), isRecent(passed, PASSED_SHOWN_MS)]).toEqual([true, true])
    expect([isListed(run({ state: 'failed', finishedAt: 0, dismissed: true }), 0), isRecent(run({ state: 'failed', finishedAt: 0, dismissed: true }), 0)]).toEqual([false, true])
    expect([isListed(run({}), 1e9), isRecent(run({}), 1e9)]).toEqual([true, false])
  })

  it('time left counts from the last report, never below zero', () => {
    expect(timeLeft(run({ estimateMs: 60_000, updatedAt: 1000 }), 31_000)).toBe(30_000)
    expect(timeLeft(run({ estimateMs: 60_000, updatedAt: 1000 }), 999_999)).toBe(0)
    expect(timeLeft(run({}), 5)).toBeNull()
  })

  it('the status line (#549): a waiting run how long it has waited, never a time left; past its estimate "finishing", then "longer than expected", never "0 s left"', () => {
    // Waiting from the start, then waiting after running a while.
    expect(runStatusLine(run({ waiting: 'waiting for a test slot: B4', waitingSince: 0 }), 46 * 60_000)).toBe('waiting 46 min')
    expect(runStatusLine(run({ waiting: 'x', waitingSince: 90_000 }), 150_000)).toBe('3 min · waiting 1 min')
    expect(barLook(run({ waiting: 'x', total: 10, step: 3 }))).toBe('waiting')
    expect([barLook(run({ total: 10, step: 3 })), barLook(run({})), barLook(run({ state: 'passed' })), barLook(run({ state: 'stopped', waiting: 'x' }))]).toEqual(['steps', 'moving', 'full', 'full'])
    // Running with an estimate, every second up to two minutes past it: a time left while there is one, then
    // "finishing" for a minute, then "longer than expected"; never "0 s left".
    const r = run({ estimateMs: 30_000, updatedAt: 0 })
    for (let t = 0; t <= 150_000; t += 250) {
      const line = runStatusLine(r, t)
      expect(line).not.toMatch(/\b0 s left/)
      if (30_000 - t >= 1000) expect(line).toMatch(/about \d+ s left$/)
      else expect(line).toMatch(t - 30_000 < FINISHING_MS ? /· finishing$/ : /· longer than expected$/)
    }
    expect(runStatusLine(run({}), 65_000)).toBe('1 min')
    expect(runStatusLine(run({ state: 'stopped', stopReason: 'interrupted', finishedAt: 125_000 }), 1e9)).toBe('Stopped after 2 min')
    expect(runStatusLine(run({ state: 'stopped', stopReason: 'gone', finishedAt: 125_000 }), 1e9)).toBe('Ended without a report after 2 min')
    expect(runStatusLine(run({ state: 'stale', staleReason: 'quiet', updatedAt: 0 }), 120_000)).toBe('Stopped reporting 2 min ago')
    expect(runWords({ ...run({ waiting: 'x' }), title: 'e2e' })).toBe('e2e · waiting')
  })

  it('overdue: ten minutes without an estimate; the estimate plus two minutes; a step share with steps; never while waiting', () => {
    expect(isOverdue(run({ waiting: 'a test slot' }), 10 * 3_600_000)).toBe(false)
    expect(isOverdue(run({}), 10 * 60_000)).toBe(false)
    expect(isOverdue(run({}), 10 * 60_000 + 1)).toBe(true)
    expect(isOverdue(run({ estimateMs: 60_000 }), 3 * 60_000 + 1)).toBe(true)
    expect(isOverdue(run({ estimateMs: 60_000 }), 3 * 60_000)).toBe(false)
    expect(isOverdue(run({ estimateMs: 10 * 60_000, total: 10, step: 0 }), 3 * 60_000 + 1)).toBe(true)
  })

  it('taskbar: combined steps, indeterminate without steps, red while a failure is unseen, off when idle', () => {
    expect(taskbarProgress([], false)).toEqual({ mode: 'none', value: 0 })
    expect(taskbarProgress([run({ total: 4, step: 1 }), run({ total: 6, step: 4 })], false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(taskbarProgress([run({})], false).mode).toBe('indeterminate')
    // A run without steps doesn't drag the combined fraction down.
    expect(taskbarProgress([run({ total: 2, step: 1 }), run({})], false)).toEqual({ mode: 'normal', value: 0.5 })
    expect(taskbarProgress([run({ state: 'passed', total: 2, step: 2 })], false).mode).toBe('none')
    expect(taskbarProgress([run({ state: 'failed' })], true)).toEqual({ mode: 'error', value: 1 })
    expect(taskbarProgress([run({ total: 4, step: 1 })], true)).toEqual({ mode: 'error', value: 0.25 })
  })

  it('the filter (#251): one project, one agent in it, or the runs without a project; all when there is nothing to choose', () => {
    const a1 = run({ id: 'a1', projectPath: 'C:\\ws\\Alpha', agentId: 'x', agentName: 'Alfie', source: 'agent' })
    const a2 = run({ id: 'a2', projectPath: 'C:\\ws\\alpha', agentId: 'y', agentName: 'Ada', source: 'agent' })
    const b1 = run({ id: 'b1', projectPath: 'C:\\ws\\beta', agentId: 'z', agentName: 'Betty', source: 'agent' })
    const s1 = run({ id: 's1', agentName: 'Script' })
    const all = [a1, a2, b1, s1]
    const names = (p: string): string => p.split('\\').pop()!.toLowerCase()
    expect(filterChoices(all, names)).toEqual([{ value: 'c:\\ws\\alpha', label: 'alpha' }, { value: 'c:\\ws\\beta', label: 'beta' }, { value: NO_PROJECT, label: 'Assistant and scripts' }])
    expect(agentChoices(all, 'c:\\ws\\alpha', tr)).toEqual([{ value: 'y', label: 'Ada' }, { value: 'x', label: 'Alfie' }])
    const ids = (f: Parameters<typeof filterRuns>[1]): string[] => filterRuns(all, activeFilter(all, f)).map((r) => r.id)
    expect(ids({ project: 'c:\\ws\\alpha' })).toEqual(['a1', 'a2'])
    expect(ids({ project: 'c:\\ws\\alpha', agent: 'x' })).toEqual(['a1'])
    expect(ids({ project: NO_PROJECT })).toEqual(['s1'])
    expect(ids({ project: ALL_PROJECTS })).toEqual(['a1', 'a2', 'b1', 's1'])
    // A project with no runs left, or an agent with none: back to all, or to the whole project.
    expect(activeFilter(all, { project: 'c:\\ws\\gone' })).toBe(SHOW_ALL)
    expect(activeFilter(all, { project: 'c:\\ws\\beta', agent: 'x' })).toEqual({ project: 'c:\\ws\\beta' })
    // Every run in one project: nothing to choose between, so no filter.
    expect(activeFilter([a1, a2], { project: 'c:\\ws\\alpha', agent: 'x' })).toBe(SHOW_ALL)
    // …unless offered anyway (HI-2165: All projects hides a queue): the one project is a choice.
    expect(activeFilter([], { project: 'c:\\ws\\beta' }, ['C:\\ws\\beta'], true)).toEqual({ project: 'c:\\ws\\beta' })
    expect(activeFilter([], { project: 'c:\\ws\\beta' }, ['C:\\ws\\beta'])).toBe(SHOW_ALL)
    expect(activeFilter(all, undefined)).toBe(SHOW_ALL)
  })

  it('merge cards follow the filter (#810): the project, and an agent holding or waiting for its slot', () => {
    const slot = (project: string, holder: string | null, taken: boolean, waiting: string[] = []): MergeSlotInfo => ({
      project,
      branch: 'main',
      holder: holder ? { id: `h-${holder}`, kind: 'agent', agentId: holder, name: holder.toUpperCase(), cards: [], since: 0, until: 0, taken } : null,
      waiting: waiting.map((w) => ({ agentId: w, name: w.toUpperCase(), cards: [], since: 0 }))
    })
    // Hive's own slot, as its folder may be written (another case, forward slashes, a trailing separator), and another project's.
    const hive = slot('C:/ws/Hive/', 'hb3', true, ['hb2'])
    const amber = slot('C:\\ws\\amberlight', 'amb2', true)
    // A turn not claimed yet isn't a merge.
    const turn = slot('C:\\ws\\hive', 'hb1', false)
    const slots = [hive, amber, turn]
    expect(filterMergeSlots(slots, SHOW_ALL)).toEqual([hive, amber])
    expect(filterMergeSlots(slots, { project: 'c:\\ws\\hive' })).toEqual([hive])
    expect(filterMergeSlots(slots, { project: 'c:\\ws\\amberlight' })).toEqual([amber])
    // An agent: the slot it holds, or one it waits for; none for an agent in neither.
    expect(filterMergeSlots(slots, { project: 'c:\\ws\\hive', agent: 'hb3' })).toEqual([hive])
    expect(filterMergeSlots(slots, { project: 'c:\\ws\\hive', agent: 'hb2' })).toEqual([hive])
    expect(filterMergeSlots(slots, { project: 'c:\\ws\\hive', agent: 'hb1' })).toEqual([])
    // The Assistant's and scripts' runs hold no project's slot.
    expect(filterMergeSlots(slots, { project: NO_PROJECT })).toEqual([])
  })

  it("Copy details is every field the details show, in their order, then the summary (#251)", () => {
    setDateStyle({ date: 'ymd', time: '24h' })
    const start = new Date(2026, 9, 5, 20, 57).getTime()
    const full = run({ title: 'e2e: full set before merging', command: 'npm run e2e -- --all --real --build --record', agentName: 'Claudio', provider: 'claude-code', source: 'agent', total: 96, step: 95, stepName: 'taskbar', startedAt: start, finishedAt: start + 10 * 60_000, expectedMs: 9 * 60_000, state: 'failed', exitCode: 1, logPath: 'C:\\t\\run-record.md', summary: '1 failed: taskbar' })
    expect(runDetailsText(full, 'hive', start + 11 * 60_000)).toBe(
      [
        'Run: e2e: full set before merging',
        'Command: npm run e2e -- --all --real --build --record',
        'Agent: Claudio · hive',
        'Provider: Claude Code',
        'Started: 2026-10-05 20:57',
        'Ended: 2026-10-05 21:07',
        'Took: 10 min · expected about 9 min',
        'Steps: 95 of 96 done · last: taskbar',
        'State: Failed',
        'Exit code: 1',
        'Log: C:\\t\\run-record.md',
        'Summary: 1 failed: taskbar'
      ].join('\n')
    )
    // Only what a run has: no command, provider, steps, exit code, log or summary.
    expect(runDetailsText(run({ title: 'build', agentName: 'Script', startedAt: start }), null, start + 40_000)).toBe(['Run: build', 'Agent: Script', 'Started: 2026-10-05 20:57', 'Took: 40 s so far', 'State: Running'].join('\n'))
  })
})

describe('progress history (#352): Recent kept across restarts', () => {
  /** A kept file per workspace, in memory, with the calls made. */
  const files = (): ProgressHistory & { saved: Map<string, unknown>; forgot: number } => {
    const saved = new Map<string, unknown>()
    const h = {
      saved,
      forgot: 0,
      load: async (ws: string) => structuredClone(saved.get(ws.toLowerCase()) ?? null),
      save: async (ws: string, runs: ProgressRun[]) => void saved.set(ws.toLowerCase(), structuredClone({ version: 1, runs })),
      forget: async () => {
        saved.clear()
        h.forgot++
      }
    }
    return h
  }
  const kept = (h: ReturnType<typeof files>, ws = WS): ProgressRun[] => (h.saved.get(ws.toLowerCase()) as { runs: ProgressRun[] } | undefined)?.runs ?? []
  const withHistory = (h: ProgressHistory): ProgressStore =>
    new ProgressStore({ now: () => now, changed: (ws, runs) => changes.push({ ws, runs }), ownerRunning: () => running, emitEveryMs: 250, history: h, saveAfterMs: 2000 })

  it("keeps Hive's mark on a name it gave across a save and a restart, and never marks an agent named Agent (#872)", async () => {
    const ended = { state: 'passed', startedAt: 1, finishedAt: 2 }
    const records = [
      { ...ended, id: 'k1', title: 'nameless', source: 'agent', agentId: 'a-1', projectPath: alfie.projectPath },
      { ...ended, id: 'k2', title: 'named Agent', source: 'agent', agentName: 'Agent', agentId: 'a-9', projectPath: alfie.projectPath },
      { ...ended, id: 'k3', title: 'old script', source: 'api', agentName: 'Script' }
    ]
    const marks = (runs: ProgressRun[]): (string | null)[][] => runs.filter((r) => r.id.startsWith('k')).map((r) => [r.id, r.agentName, r.defaultName ?? null])
    const want = [['k1', 'Agent', 'agent'], ['k2', 'Agent', null], ['k3', 'Script', 'script']]
    // Read, written as JSON, read again: the same marks each time.
    const once = keptRuns({ runs: records }, WS)
    expect(marks(once)).toEqual(want)
    expect(marks(keptRuns(JSON.parse(JSON.stringify({ runs: once })), WS))).toEqual(want)
    // A mark on a name that isn't Hive's (an edited file) is dropped, so the window shows that name as it is.
    expect(keptRuns({ runs: [{ ...records[1], defaultName: 'script' }, { ...records[0], agentName: 'Ada', defaultName: 'agent' }] }, WS).map((r) => r.defaultName ?? null)).toEqual([null, null])
    // Through the store: loaded, saved with a new run, loaded again after a restart.
    const h = files()
    h.saved.set(WS.toLowerCase(), { version: 1, runs: records })
    const s = withHistory(h)
    await s.loadHistory(WS)
    s.finish(alfie, s.start(alfie, { title: 'new' }).id, { ok: true })
    await s.saveNow()
    expect(marks(kept(h))).toEqual(want)
    const after = withHistory(h)
    await after.loadHistory(WS)
    expect(marks(after.list(WS))).toEqual(want)
  })

  it('saves ended runs shortly after they end (not open ones); a restart brings them back, seen, under Recent', async () => {
    const h = files()
    const s = withHistory(h)
    await s.loadHistory(WS)
    const open = s.start(alfie, { title: 'still going' })
    const a = s.start(alfie, { title: 'unit' })
    s.finish(alfie, a.id, { ok: false, summary: '2 failed', logPath: 'C:\\logs\\unit.log' })
    now += 1000
    const b = s.start(script, { title: 'build' })
    s.finish(script, b.id, { ok: true })
    expect(kept(h)).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(kept(h).map((r) => r.title)).toEqual(['build', 'unit'])
    // After a restart: a new store, a run reported before the window asked.
    now += 60_000
    const after = withHistory(h)
    const early = after.start(betty, { title: 'early' })
    await after.loadHistory(WS)
    const list = after.list(WS)
    expect(list.map((r) => r.title)).toEqual(['early', 'build', 'unit'])
    expect(list.some((r) => r.id === open.id)).toBe(false)
    const unit = list.find((r) => r.id === a.id)!
    expect(unit).toMatchObject({ state: 'failed', summary: '2 failed', logPath: 'C:\\logs\\unit.log', workspacePath: WS })
    expect(isRecent(unit, now)).toBe(true)
    expect(after.logOf(WS, a.id)).toBe('C:\\logs\\unit.log')
    expect(after.list(WS)[0].id).toBe(early.id)
    expect(changes.at(-1)?.runs.length).toBe(3)
    // Loading again in the same opening changes nothing.
    await after.loadHistory(WS)
    expect(after.list(WS).length).toBe(3)
  })

  it('a save before the history has loaded keeps what the file holds; the cap holds across both', async () => {
    const h = files()
    h.saved.set(WS.toLowerCase(), { runs: Array.from({ length: RECENT_KEPT }, (_, i) => ({ id: `old-${i}`, title: `old ${i}`, state: 'passed', source: 'api', agentName: 'Script', startedAt: 500_000 - i, finishedAt: 500_001 - i })) })
    const s = withHistory(h)
    s.finish(alfie, s.start(alfie, { title: 'new' }).id, { ok: true })
    await vi.advanceTimersByTimeAsync(2000)
    const titles = kept(h).map((r) => r.title)
    expect(titles.length).toBe(RECENT_KEPT)
    expect(titles[0]).toBe('new')
    expect(titles.at(-1)).toBe(`old ${RECENT_KEPT - 2}`)
  })

  it('a closing workspace saves at once; turning the panel off forgets every kept run, and a load under way lands nowhere', async () => {
    const h = files()
    const s = withHistory(h)
    await s.loadHistory(WS)
    s.finish(alfie, s.start(alfie, { title: 'just ended' }).id, { ok: true })
    s.clear(WS)
    await vi.advanceTimersByTimeAsync(0)
    expect(kept(h).map((r) => r.title)).toEqual(['just ended'])
    // Opened again: back.
    await s.loadHistory(WS)
    expect(s.list(WS).map((r) => r.title)).toEqual(['just ended'])
    // Closed while it loads: nothing lands.
    s.clear(WS)
    const loading = s.loadHistory(WS)
    s.clear(WS)
    await loading
    expect(s.list(WS)).toEqual([])
    // The panel turned off: memory and files go, a save waiting doesn't happen.
    await s.loadHistory(WS)
    s.finish(script, s.start(script, { title: 'pending save' }).id, { ok: true })
    s.clear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.forgot).toBe(1)
    expect(h.saved.size).toBe(0)
    expect(s.list(WS)).toEqual([])
  })

  it('saveNow (quitting) writes the saves still waiting', async () => {
    const h = files()
    const s = withHistory(h)
    s.finish(betty, s.start(betty, { title: 'last one' }).id, { ok: true })
    await s.saveNow()
    expect(kept(h).map((r) => r.title)).toEqual(['last one'])
  })

  it('keeps that a title is its command line (#620): from the reporter, and in the kept history', () => {
    const s = store()
    const auto = s.start(alfie, { title: 'cmd /c echo x', command: 'cmd /c echo x', titleFromCommand: true })
    const own = s.start(alfie, { title: 'unit tests', command: 'npm test', titleFromCommand: false })
    expect(auto.titleFromCommand).toBe(true)
    expect(own).not.toHaveProperty('titleFromCommand')
    expect(() => s.start(alfie, { title: 'x', titleFromCommand: 'yes' })).toThrow(/titleFromCommand/)
    const good = { id: 'g', title: 'cmd /c echo x', command: 'cmd /c echo x', state: 'passed', source: 'agent', agentName: 'Alfie', agentId: 'a-1', projectPath: 'C:\\ws\\alpha', startedAt: 1, finishedAt: 2 }
    expect(keptRuns({ runs: [{ ...good, titleFromCommand: true }] }, WS)[0].titleFromCommand).toBe(true)
    expect(keptRuns({ runs: [{ ...good, titleFromCommand: 'x' }] }, WS)[0]).not.toHaveProperty('titleFromCommand')
  })

  it("marks the names Hive gives a run, never an agent's own (#872): the window translates only those, agents get the English", () => {
    const s = store()
    const agentNamedAgent: ProgressCaller = { ...alfie, agentId: 'a-9', agentName: 'Agent' }
    const fromScript = s.start(script, { title: 'build' })
    const fromAgent = s.start(agentNamedAgent, { title: 'unit tests' })
    expect(fromScript).toMatchObject({ agentName: 'Script', defaultName: 'script' })
    expect(fromAgent.agentName).toBe('Agent')
    expect(fromAgent).not.toHaveProperty('defaultName')
    // Kept history: a record with no name gets Hive's "Agent", marked; one named "Agent" keeps its name, unmarked.
    const ended = { state: 'passed', startedAt: 1, finishedAt: 2 }
    const runs = keptRuns({ runs: [
      { ...ended, id: 'k1', title: 'nameless', source: 'agent', agentId: 'a-1', projectPath: alfie.projectPath },
      { ...ended, id: 'k2', title: 'named', source: 'agent', agentName: 'Agent', agentId: 'a-9', projectPath: alfie.projectPath },
      { ...ended, id: 'k3', title: 'old script', source: 'api', agentName: 'Script' },
      { ...ended, id: 'k4', title: 'script, no name', source: 'api' }
    ] }, WS)
    expect(runs.map((r) => [r.agentName, r.defaultName ?? null])).toEqual([['Agent', 'agent'], ['Agent', null], ['Script', 'script'], ['Script', 'script']])
    try {
      setLanguage('de', { 'board.progress.script': 'Skript', 'board.progress.anAgent': 'Ein Agent' })
      expect([fromScript, fromAgent, ...runs].map((r) => runAgentName(r, tr))).toEqual(['Skript', 'Agent', 'Ein Agent', 'Agent', 'Skript', 'Skript'])
    } finally {
      setLanguage('en', {})
    }
    // Agents read the English name, never the marker.
    expect(publicRun(fromScript)).toMatchObject({ agentName: 'Script' })
    expect(publicRun(fromScript)).not.toHaveProperty('defaultName')
    expect(publicRun(runs[0])).not.toHaveProperty('defaultName')
  })

  it('a damaged or edited file gives only well-formed runs, cut to their limits, each once, at most RECENT_KEPT', () => {
    expect(keptRuns(null, WS)).toEqual([])
    expect(keptRuns('nonsense', WS)).toEqual([])
    expect(keptRuns({ runs: 'x' }, WS)).toEqual([])
    const good = { id: 'g', title: 'ok', state: 'failed', source: 'agent', agentName: 'Alfie', agentId: 'a-1', projectPath: 'C:\\ws\\alpha', provider: 'claude-code', startedAt: 1, finishedAt: 2 }
    const runs = keptRuns(
      {
        runs: [
          good,
          { ...good }, // the same id again
          { ...good, id: 'running', state: 'running' },
          { ...good, id: 'no-end', finishedAt: null },
          { ...good, id: 'no-title', title: '' },
          { ...good, id: 'bad-source', source: 'mallory' },
          7,
          null,
          { ...good, id: 'long', title: 'x'.repeat(5000), summary: 'y'.repeat(5000), provider: 'mallory', workspacePath: 'C:\\elsewhere', seenAt: null },
          { ...good, id: 'script', source: 'api', agentId: 'a-1', projectPath: 'C:\\ws\\alpha' }
        ]
      },
      WS
    )
    expect(runs.map((r) => r.id)).toEqual(['g', 'long', 'script'])
    const long = runs[1]
    expect(long.title.length).toBeLessThanOrEqual(120)
    expect(long.summary!.length).toBeLessThanOrEqual(500)
    expect(long).toMatchObject({ provider: null, workspacePath: WS, seenAt: 2, estimateMs: null })
    expect(runs[2]).toMatchObject({ agentId: null, projectPath: null })
    expect(keptRuns({ runs: Array.from({ length: RECENT_KEPT + 50 }, (_, i) => ({ ...good, id: `r${i}` })) }, WS).length).toBe(RECENT_KEPT)
  })
})

describe("Hive's set-up runs in review copies (HI-1710)", () => {
  const hive = (extra: Partial<Extract<ProgressCaller, { source: 'hive' }>> = {}): ProgressCaller => ({ source: 'hive', workspacePath: WS, projectPath: alfie.projectPath, ...extra })

  it("are credited to the agent whose lease held the copy, in that copy, else to one 'Hive (review copies)'", () => {
    const s = store()
    const held = s.start(hive({ copy: 'copy-1', reviewer: { agentId: 'r-6', agentName: 'HR6' } }), { title: 'npm ci' })
    expect(held).toMatchObject({ source: 'hive', agentId: 'r-6', agentName: 'HR6', copy: 'copy-1' })
    expect(held.defaultName).toBeUndefined()
    expect(runAgentName(held, tr)).toBe('HR6')
    expect(runDetailsText(held, 'alpha', now)).toContain('copy-1')
    const idle = [s.start(hive({ copy: 'copy-1' }), { title: 'npm ci' }), s.start(hive({ copy: 'copy-2' }), { title: 'npm ci' })]
    expect(idle.map((r) => [r.agentId, r.agentName, r.defaultName, r.copy])).toEqual([[null, 'Hive (review copies)', 'copy', 'copy-1'], [null, 'Hive (review copies)', 'copy', 'copy-2']])
    expect(idle.map((r) => runAgentName(r, tr))).toEqual(['Hive (review copies)', 'Hive (review copies)'])
    // A slot's run never takes a reviewer.
    expect(s.start(hive({ slot: 'slot-b', reviewer: { agentId: 'r-6', agentName: 'HR6' } }), { title: 'npm ci' })).toMatchObject({ agentId: null, agentName: 'Hive (slot slot-b)', defaultName: 'slot' })
    // The reviewer's run is still Hive's: the agent can't change or end it.
    const r6: ProgressCaller = { ...alfie, agentId: 'r-6', agentName: 'HR6' }
    expect(status(() => s.update(r6, held.id, { step: 1 }))).not.toBeNull()
    expect(status(() => s.update(hive(), held.id, { step: 1 }))).toBeNull()
  })

  it('keep their reviewer across a save; older "Hive (copy copy-1)" runs fold into "Hive (review copies)"', () => {
    const ended = { state: 'passed', startedAt: 1, finishedAt: 2, source: 'hive', projectPath: alfie.projectPath }
    const records = [
      { ...ended, id: 'c1', title: 'npm ci', copy: 'copy-1', agentId: 'r-6', agentName: 'HR6' },
      { ...ended, id: 'c2', title: 'npm ci', copy: 'copy-1', agentName: 'Hive (copy copy-1)', defaultName: 'copy' },
      // An id on a run of the pool's (an edited file) doesn't make it an agent's.
      { ...ended, id: 'c3', title: 'npm ci', copy: 'copy-2', agentId: 'r-6', agentName: 'Hive (review copies)', defaultName: 'copy' },
      { ...ended, id: 'c4', title: 'npm ci', slot: 'slot-b', agentId: 'r-6', agentName: 'HR6' }
    ]
    const marks = (runs: ProgressRun[]): unknown[][] => runs.map((r) => [r.id, r.agentId, r.agentName, r.defaultName ?? null])
    const want = [['c1', 'r-6', 'HR6', null], ['c2', null, 'Hive (review copies)', 'copy'], ['c3', null, 'Hive (review copies)', 'copy'], ['c4', null, 'Hive (slot slot-b)', 'slot']]
    const once = keptRuns({ runs: records }, WS)
    expect(marks(once)).toEqual(want)
    expect(marks(keptRuns(JSON.parse(JSON.stringify({ runs: once })), WS))).toEqual(want)
  })
})
