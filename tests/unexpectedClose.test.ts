// Combwork closing unexpectedly (#984): the running marker reads back (a damaged one is no marker, bad agent rows are left
// out), and the notice says when Combwork was last seen, which agents were running where, what became of them, a crash dump
// and a merge left half done with the folder to check. #987: the marker keeps what the agents' launches had started, each
// process by id and start time (one without either isn't kept), within bounds, and the notice says how many still run.
// #1008: a cw-progress run (a test run left over) is one item of the notice, named by its title.
import { describe, expect, it, vi } from 'vitest'
import { MAX_MARKER_LAUNCHES, MAX_MARKER_PROCESSES, parseRunMarker, projectsOf, resumeFailedLine, LeftoverStops, stillRunningLine, stopLeftovers, stopStillRunning, unexpectedCloseText, type RunningAgent } from '../src/shared/unexpectedClose'
import { setDateStyle } from '../src/shared/dates'
import { groupProgressRuns, progressRunTitle, progressRunsIn, type AgentProcess } from '../src/shared/agentProcesses'

const agent = (name: string, project: string, extra: Partial<RunningAgent> = {}): RunningAgent => ({ workspace: 'D:/ws', projectPath: `D:/ws/${project}`, project, agentId: name.toLowerCase(), agentName: name, provider: 'claude-code', sessionId: `s-${name}`, ...extra })
const lastSeen = '2026-10-17T03:02:56.000Z'
const HUNG_MS = 10_000
const marker = (over: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, pid: 42, startedAt: '2026-10-17T01:00:00.000Z', lastSeen: '2026-10-17T03:02:56.000Z', app: '0.9.0', workspaces: ['D:/ws'], agents: [agent('B1', 'hive'), agent('R1', 'ambrosia')], ...over })

describe('the running marker (#984)', () => {
  it('reads back what a running Combwork wrote', () => {
    const m = parseRunMarker(marker())
    expect(m?.lastSeen).toBe('2026-10-17T03:02:56.000Z')
    expect(m?.agents.map((a) => a.agentName)).toEqual(['B1', 'R1'])
    expect(m?.workspaces).toEqual(['D:/ws'])
  })

  it('is no marker when damaged, of another version or without a time; bad agent rows are left out', () => {
    expect(parseRunMarker('{ not json')).toBeNull()
    expect(parseRunMarker(marker({ version: 2 }))).toBeNull()
    expect(parseRunMarker(marker({ lastSeen: 'yesterday' }))).toBeNull()
    expect(parseRunMarker(marker({ agents: [agent('B1', 'hive'), { agentName: 'no project' }, null, 'x'] }))?.agents.map((a) => a.agentName)).toEqual(['B1'])
  })

  it("keeps what the agents' launches had started: each process by id and start time, within bounds (#987)", () => {
    const proc = (pid: number, label = 'node serve.js', created: unknown = '133000000000000000') => ({ pid, name: 'node.exe', label, created })
    const launch = { projectPath: 'D:/ws/hive', agentId: 'b1', agentName: 'B1', processes: [proc(10), proc(11, 'npm run e2e')] }
    expect(parseRunMarker(marker({ processes: [launch] }))?.processes).toEqual([launch])
    // A marker of #984 (none kept), and bad rows: a process without its start time, or with a pid that can't be one, is
    // left out (it can't be told from a later process with its id); a launch left with none goes.
    expect(parseRunMarker(marker())?.processes).toEqual([])
    const bad = [{ ...launch, processes: [proc(12, 'x', null), proc(-1), proc(1.5), proc(13, 'y', '12ab'), proc(14)] }, { ...launch, agentId: '' }, { ...launch, processes: [proc(15, 'z', '')] }, null, 'x']
    expect(parseRunMarker(marker({ processes: bad }))?.processes).toEqual([{ ...launch, processes: [proc(14)] }])
    const many = Array.from({ length: MAX_MARKER_LAUNCHES + 5 }, (_, i) => ({ ...launch, agentId: `a${i}`, processes: Array.from({ length: MAX_MARKER_PROCESSES + 5 }, (_p, j) => proc(j + 1)) }))
    const read = parseRunMarker(marker({ processes: many }))?.processes ?? []
    expect(read.length).toBe(MAX_MARKER_LAUNCHES)
    expect(read.every((l) => l.processes.length === MAX_MARKER_PROCESSES)).toBe(true)
    // Each launch's run (#1506: Release Slot… lists a held writer's own run only); one too long or not text is left out.
    expect(parseRunMarker(marker({ processes: [{ ...launch, runId: 'r-1' }, { ...launch, runId: 'x'.repeat(101) }, { ...launch, runId: 7 }] }))?.processes).toEqual([{ ...launch, runId: 'r-1' }, launch, launch])
  })

  it('names each project once, in the order met', () => {
    expect(projectsOf([agent('B1', 'hive'), agent('R1', 'ambrosia'), agent('B2', 'hive')])).toEqual(['hive', 'ambrosia'])
  })
})

describe('the notice (#984)', () => {
  setDateStyle({ date: 'ymd', time: '24h' })

  it('says when, what was running where, and that nothing was resumed', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive'), agent('R1', 'ambrosia')], dump: false, merges: [] }, null)
    expect(text).toMatch(/^Combwork was last seen on .+ at .+\. 2 agents were running in hive and ambrosia\. Nothing was resumed\.$/)
    expect(text).not.toMatch(/crash dump/)
  })

  it('with no agents, says so and nothing about resuming', () => {
    expect(unexpectedCloseText({ lastSeen, agents: [], dump: false, merges: [] }, null)).toMatch(/^Combwork was last seen on .+\. No agents were running\.$/)
  })

  it('with the setting on, says how many were resumed and which could not', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive'), agent('R1', 'hive')], dump: false, merges: [] }, { resumed: ['B1'], failed: [{ name: 'R1', error: 'Codex is turned off' }] })
    expect(text).toMatch(/One agent was running in hive\.|2 agents were running in hive\./)
    expect(text).toMatch(/One was resumed, as Settings → Sessions says\. One couldn't resume: R1 \(Codex is turned off\)\.$/)
    expect(text).not.toMatch(/Nothing was resumed/)
    expect(resumeFailedLine({ resumed: [], failed: [{ name: 'A', error: 'x' }, { name: 'B', error: 'y' }] })).toBe("2 couldn't resume: A (x) and B (y).")
  })

  it("leaves a conversation whose slot is free or holds other work (#1434), and says so", () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive'), agent('B2', 'hive')], dump: false, merges: [] }, { resumed: [], failed: [], held: [{ name: 'B1', hold: { is: 'byHand', slot: 'slot-a', how: 'take', lease: 'l1' } }, { name: 'B2', hold: { is: 'reused', slot: 'slot-b', card: 14, lane: null } }] })
    expect(text).toMatch(/None was resumed\. 2 were left stopped: B1 \(its slot is free\. Resume it by hand to take it\) and B2 \(its slot now holds #14's work\)\.$/)
  })

  it('names a crash dump, and each merge left half done with the folder it was in', () => {
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: true, merges: [{ agentName: 'HB5', branch: 'feature/090-session', cards: [977], folder: 'D:/wt/hb5' }, { agentName: 'HB2', branch: 'main', cards: [], folder: 'D:/ws/hive' }] }, null)
    expect(text).toContain('Combwork kept a crash dump of it: Help → Copy Diagnostics names it.')
    expect(text).toContain('HB5 was merging feature/090-session (#977): check D:/wt/hb5 for a merge left half done (git status there) before the next merge.')
    expect(text).toContain('HB2 was merging main: check D:/ws/hive for a merge left half done')
  })

  it("says how many processes the agents started still run, and what they are (#987)", () => {
    const proc = (pid: number, label: string) => ({ pid, name: 'node.exe', label, created: '1' })
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: [proc(1, 'npm run e2e'), proc(2, 'node serve.js'), proc(3, 'npm run e2e')] }, null)
    expect(text).toMatch(/Nothing was resumed\. 3 processes the agents started are still running: 2 × npm run e2e, node serve\.js\.$/)
    expect(stillRunningLine([proc(1, 'node serve.js')])).toBe('One process the agents started is still running: node serve.js.')
    expect(unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: [] }, null)).not.toMatch(/still running/)
  })
})

describe('a cw-progress run left running is one item, named by its title (#1008)', () => {
  const wrapper = String.raw`"C:\Program Files\Hive\Hive.exe" "C:\Program Files\Hive\resources\app.asar.unpacked\out\main\cw-progress.js" --title "e2e: 196 suites in hb2" -- npm run e2e -- --all`

  it('reads the title from the cw-progress command line, else the command; any other process has none', () => {
    expect(progressRunTitle(wrapper)).toBe('e2e: 196 suites in hb2')
    expect(progressRunTitle('"C:/Hive/Hive.exe" "C:/x/cw-progress.js" -- npx vitest run')).toBe('npx vitest run')
    expect(progressRunTitle(String.raw`"C:/Hive/Hive.exe" C:\x\cw-progress.js --title "  " -- node "C:\wt\tests\e2e\run.mjs"`)).toBe('node run.mjs')
    // A --title after the command's -- is the command's own.
    expect(progressRunTitle('Hive.exe cw-progress.js -- tool --title nope')).toBe('tool --title nope')
    expect(progressRunTitle('node C:/wt/tests/e2e/run.mjs --title x')).toBeUndefined()
    expect(progressRunTitle('node not-cw-progress.js.bak')).toBeUndefined()
    // Its name before HI-2463 is no run of Combwork's (HI-2611).
    expect(progressRunTitle('"C:/x/Hive.exe" "C:/x/hive-progress.js" -- npx vitest run')).toBeUndefined()
  })

  // cw-progress (10) → cmd (11) → runner (12) → a test copy (13); a node of its own (20); 14 names 10 as parent but
  // started before it (a later process took a dead parent's id): not the run's.
  const p = (pid: number, parent: number, created: string, label: string, run?: string): AgentProcess => ({ pid, parent, created, name: 'x.exe', label, ...(run ? { run } : {}) })
  const tree = [p(10, 1, '100', 'Combwork cw-progress.js', 'e2e: 196 suites in hb2'), p(11, 10, '101', 'cmd /c npm run e2e'), p(12, 11, '102', 'node run.mjs'), p(13, 12, '103', 'electron .'), p(20, 1, '100', 'node serve.js'), p(14, 10, '99', 'node older.js')]

  it('groups a run with everything below it, by parent and start time', () => {
    const { runs, rest } = groupProgressRuns(tree)
    expect(runs.map((g) => [g.title, g.root.pid, g.top.pid, g.processes.map((x) => x.pid)])).toEqual([['e2e: 196 suites in hb2', 10, 10, [10, 11, 12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([20, 14])
  })

  it('…with the shell that ran the cw-progress command above it, which is its tree’s top; not a shell that ran something else', () => {
    const shell = p(5, 2, '90', 'cmd /d /s /c "cw-progress --title e2e -- npm run e2e"')
    const agentShell = p(2, 1, '80', 'bash -c "npm run dev"')
    const { runs, rest } = groupProgressRuns([agentShell, shell, ...tree.map((x) => (x.pid === 10 ? { ...x, parent: 5 } : x))])
    expect(runs.map((g) => [g.root.pid, g.top.pid, g.processes.map((x) => x.pid).sort((a, b) => a - b)])).toEqual([[10, 5, [5, 10, 11, 12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([2, 20, 14])
  })

  it('keeps a run whose own process has ended, from what was kept; lists only what still runs', () => {
    const running = tree.filter((x) => [12, 13, 20].includes(x.pid))
    const { runs, rest } = progressRunsIn(running, tree)
    expect(runs.map((g) => [g.root.pid, g.processes.map((x) => x.pid)])).toEqual([[10, [12, 13]]])
    expect(rest.map((x) => x.pid)).toEqual([20])
    expect(progressRunsIn(tree.filter((x) => x.pid === 20), tree).runs).toEqual([])
  })

  it('the notice counts every process, and names the run once', () => {
    const running = tree.filter((x) => x.pid !== 14)
    const text = unexpectedCloseText({ lastSeen, agents: [agent('B1', 'hive')], dump: false, merges: [], stillRunning: running, kept: tree }, null)
    expect(text).toMatch(/5 processes the agents started are still running: e2e: 196 suites in hb2 \(4 processes\), node serve\.js\.$/)
    expect(stillRunningLine(tree.filter((x) => x.pid === 12), tree)).toBe('One process the agents started is still running: e2e: 196 suites in hb2 (1 process).')
  })

  it('Stop Them ends a run from its top and each of its processes, and keeps what it could not end to say so and try again', async () => {
    const ids = (ps: readonly AgentProcess[]) => ps.map((x) => x.pid)
    const running = tree.filter((x) => [12, 13, 20].includes(x.pid))
    // A child born after the marker (99) that Windows won't let Combwork end; everything listed ends.
    const late: AgentProcess = { pid: 99, created: '500', name: '', label: '' }
    const asked: { trees: number[]; exact: number[]; still: number[] } = { trees: [], exact: [], still: [] }
    const alive = new Set([99])
    const ops = {
      endTrees: async (roots: readonly AgentProcess[]) => ((asked.trees = ids(roots)), { failed: [late], unverified: [] }),
      endExact: async (ps: readonly AgentProcess[]) => (asked.exact = ids(ps)),
      stillRunning: async (ps: readonly AgentProcess[]) => ((asked.still = ids(ps)), ps.filter((x) => alive.has(x.pid)))
    }
    const r = await stopStillRunning(running, tree, ops)
    // The run's top (10, its own process, gone: the host follows nothing from it) and its processes still running.
    expect(asked.trees).toEqual([10, 12, 13])
    expect(asked.exact).toEqual([12, 13, 20])
    expect(asked.still).toEqual([12, 13, 20, 99])
    // Every process listed was stopped, but the late child still runs: not a success, and kept for Stop Them's next try.
    expect(r).toEqual({ stopped: 3, still: [late], unverified: [] })
    // The host can't say: the run's processes count as still running.
    const unsure = await stopStillRunning(running, tree, { ...ops, endTrees: async () => null, stillRunning: async () => null })
    expect(ids(unsure.still)).toEqual([12, 13, 20, 10])
    expect(unsure.stopped).toBe(0)
    // No run among them: no tree is asked for.
    asked.trees = []
    expect(await stopStillRunning([tree[4]], tree, { ...ops, stillRunning: async () => [] })).toEqual({ stopped: 1, still: [], unverified: [] })
    expect(asked.trees).toEqual([])
  })

  it("Stop Them is no success while a run's child it could neither end nor check still runs", async () => {
    // Everything listed ends; the run's new child (not in the marker) runs, and Windows lets Combwork neither end nor read it.
    const running = tree.filter((x) => [12, 13].includes(x.pid))
    const r = await stopStillRunning(running, tree, { endTrees: async () => ({ failed: [], unverified: [4242] }), endExact: async () => undefined, stillRunning: async () => [] })
    expect(r).toEqual({ stopped: 2, still: [], unverified: [4242] })
  })

  it("Stop Them keeps a child it could neither end nor check across clicks, and never tries it again by its id", async () => {
    const ids = (ps: readonly AgentProcess[]) => ps.map((x) => x.pid)
    const late: AgentProcess = { pid: 99, created: '500', name: '', label: '' }
    const asked: number[][] = []
    // Click 1: the run's processes end but its late child (99) won't, and 4242 can be neither ended nor read.
    let tree1: { failed: AgentProcess[]; unverified: number[] } = { failed: [late], unverified: [4242] }
    const alive = new Set([99])
    const ops = {
      endTrees: async (roots: readonly AgentProcess[]) => (asked.push(ids(roots)), tree1),
      endExact: async () => undefined,
      stillRunning: async (ps: readonly AgentProcess[]) => ps.filter((x) => alive.has(x.pid))
    }
    const first = await stopLeftovers({ running: tree.filter((x) => [12, 13].includes(x.pid)), unverified: [] }, tree, ops)
    expect(first).toEqual({ stopped: 2, left: { running: [late], unverified: [4242] } })
    // Click 2: 99 is tried again (by id and start time) and ends; 4242 isn't asked for, and is still said to maybe run.
    alive.clear()
    tree1 = { failed: [], unverified: [] }
    const second = await stopLeftovers(first.left, tree, ops)
    expect(second).toEqual({ stopped: 1, left: { running: [], unverified: [4242] } })
    // Click 3: nothing to try; nothing is asked of Windows, and 4242 is still there to report rather than a quiet 0.
    asked.length = 0
    const third = await stopLeftovers(second.left, tree, ops)
    expect(third).toEqual({ stopped: 0, left: { running: [], unverified: [4242] } })
    expect(asked).toEqual([])
    // Ids reported by two clicks are kept once.
    expect((await stopLeftovers({ running: [tree[1]], unverified: [4242] }, tree, { ...ops, endTrees: async () => ({ failed: [], unverified: [4242, 4250] }) })).left.unverified).toEqual([4242, 4250])
  })

  it("two Stop Them clicks that overlap take turns: the second sees what the first kept, and is no success over it", async () => {
    const calls: number[][] = []
    let finish: (r: { failed: AgentProcess[]; unverified: number[] }) => void = () => undefined
    const stops = new LeftoverStops({
      // The first click's tree is held open until the second click has been made.
      endTrees: (roots) => (calls.push(roots.map((x) => x.pid)), new Promise((resolve) => (finish = resolve))),
      endExact: async () => undefined,
      stillRunning: async () => []
    })
    stops.set(tree.filter((x) => [12, 13].includes(x.pid)), tree)
    const a = stops.click()
    const b = stops.click()
    // Only the first has asked Windows anything: the second waits for it.
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: HUNG_MS })
    finish({ failed: [], unverified: [4242] })
    expect(await a).toEqual({ stopped: 2, tried: 2, left: { running: [], unverified: [4242] } })
    // The second finds nothing left to try, and 4242 still there (lastRun throws notChecked on it): not a stale success.
    expect(await b).toEqual({ stopped: 0, tried: 0, left: { running: [], unverified: [4242] } })
    expect(calls).toHaveLength(1)
    // And a later click still has it to report.
    expect((await stops.click()).left.unverified).toEqual([4242])
    expect(stops.leftovers).toEqual({ running: [], unverified: [4242] })
  })

  it('a Stop Them click that fails lets the next one run', async () => {
    let fail = true
    const stops = new LeftoverStops({
      endTrees: async () => ({ failed: [], unverified: [] }),
      endExact: async () => {
        if (fail) throw new Error('host gone')
      },
      stillRunning: async () => []
    })
    stops.set([tree[4]], tree)
    await expect(stops.click()).rejects.toThrow('host gone')
    fail = false
    expect(await stops.click()).toEqual({ stopped: 1, tried: 1, left: { running: [], unverified: [] } })
  })

  it("the marker keeps each process's parent and run title; bad ones are left out", () => {
    const procs = [{ pid: 10, created: '100', name: 'Hive.exe', label: 'Hive cw-progress.js', parent: 1, run: 'e2e: 196 suites in hb2' }, { pid: 12, created: '102', name: 'node.exe', label: 'node run.mjs', parent: -3, run: 7 }]
    const m = parseRunMarker(marker({ processes: [{ projectPath: 'D:/ws/hive', agentId: 'b1', agentName: 'B1', processes: procs }] }))
    expect(m?.processes[0].processes).toEqual([
      { pid: 10, created: '100', name: 'Hive.exe', label: 'Hive cw-progress.js', parent: 1, run: 'e2e: 196 suites in hb2' },
      { pid: 12, created: '102', name: 'node.exe', label: 'node run.mjs' }
    ])
  })
})
