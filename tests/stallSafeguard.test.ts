// HI-2754: a stall whose agent is idle after its latest turn was stopped by its provider's safety filter says so, beside
// the stall's own reason and for that agent only. On 8 Nov OpenAI's filter stopped CB2's turn on CL-133 (Codex,
// gpt-6.1-sol) and the lane's stall said only "CB2 only watches CL-133 (5 min)": the Assistant took it for the usual
// wait. Here: the latest turn's stop placed from a real-shaped Codex rollout (a stop read late is history only, a prompt
// clears it, a stop read twice counts once, a new launch starts clean); the stall's cause attributed to its agent (the
// builder's idle watch gains the context; a reviewer's stop doesn't touch it, nor a structural stall; a reviewer's own
// stall does, and not the builder's stop); the context's words; and the user's notice lines.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-stallsafeguard-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const { sessions } = await import('../src/main/sessions')
const { cardStall, cardStallCause } = await import('../src/main/cardStall')
const { safeguardLines } = await import('../src/main/workflowNotices')
const { codexSafeguards } = await import('../src/main/providers/codex/safeguards')
const { placeEvent, newTurn, noteSafeguard } = await import('../src/shared/safeguards')
const { safeguardContext, stallSafeguardOf } = await import('../src/shared/stallSafeguard')
const { shownText } = await import('../src/shared/advanced')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => vi.restoreAllMocks())

// --- A real-shaped Codex rollout: a turn (its native id a uuid) its usage policy stopped.
const rec = (timestamp: string, type: string, payload: object): string => JSON.stringify({ timestamp, type, payload })
const T0 = '2026-11-08T17:54:00.000Z'
const T1 = '2026-11-08T17:54:20.000Z'
const turnId = '019a64d2-3f1c-7c40-9b8e-5d2f1a0c4e77'
const rollout = [
  rec(T0, 'event_msg', { type: 'task_started', turn_id: turnId }),
  rec(T0, 'turn_context', { model: 'gpt-6.1-sol' }),
  rec(T0, 'response_item', { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' }),
  rec(T1, 'event_msg', { type: 'error', message: "This content can't be shown.", codex_error_info: 'cyber_policy' }),
  rec(T1, 'event_msg', { type: 'task_complete', turn_id: turnId, error: { message: 'flagged', codex_error_info: 'cyber_policy' } })
].join('\n') + '\n'

describe("the latest turn's stop (HI-2754)", () => {
  it("CB2's path: a Codex policy stop in its latest turn is its latest; a prompt clears it; the count stays", () => {
    const memo = {}
    const events = codexSafeguards(rollout, memo)
    expect(events).toHaveLength(1)
    // Its latest prompt came before the turn's stop (its native turn id is never compared with the ledger's).
    let note = placeEvent(undefined, events[0], Date.parse(T0) - 1000)!
    expect(note).toMatchObject({ stops: 1, latest: { at: T1 }, model: 'gpt-6.1-sol' })
    // Read again with the same memo: the same stop, not another (nothing new to place).
    expect(codexSafeguards(rollout, memo)).toEqual([])
    // A prompt: a new turn, its latest turn not stopped; the stop stays history.
    note = newTurn(note)!
    expect(note.latest).toBeUndefined()
    expect(note.stops).toBe(1)
  })

  it('a stop read late, after a newer prompt, is counted but never the latest; a switch neither sets nor clears it', () => {
    const [stop] = codexSafeguards(rollout, {})
    const later = Date.parse(T1) + 60_000
    const note = placeEvent(undefined, stop, later)!
    expect(note.stops).toBe(1)
    expect(note.latest).toBeUndefined()
    // A stop in the latest turn, then a reroute (a switch): the latest stays.
    const placed = placeEvent(undefined, stop, Date.parse(T0))!
    const switched = placeEvent(placed, { kind: 'switch', at: Date.parse(T1) + 1, from: 'gpt-6.1-sol', to: 'gpt-6.1-mini', flagged: true }, Date.parse(T0))!
    expect(switched.latest).toEqual({ at: T1 })
    const noStop = noteSafeguard(undefined, { kind: 'switch', at: Date.parse(T1), from: 'a', to: 'b', flagged: true })!
    expect(noStop.latest).toBeUndefined()
    // A new launch starts with no note at all (the note is per launch).
    expect(newTurn(undefined)).toBeUndefined()
  })
})

describe("the stall's context (HI-2754)", () => {
  const note = { at: T1, tools: ['shell'], stops: 3, latest: { at: T1 } }
  it('is said for an idle agent whose latest turn was stopped, in facts only; never for one in a turn, or with no latest stop', () => {
    const said = safeguardContext({ name: 'CB2', status: 'watching', provider: 'codex', safeguard: note })!
    expect(said).toMatch(/^CB2's latest turn was stopped by Codex's safety filter at \d\d:\d\d \(3 stops this session\)\. Look at its pane before nudging it, and tell the user\.$/)
    expect(said).not.toMatch(/only the user|runs into|switch/i)
    expect(safeguardContext({ name: 'CB2', status: 'watching', provider: 'codex', safeguard: { ...note, stops: 1 } })).toMatch(/\(1 stop this session\)/)
    expect(safeguardContext({ name: 'CB2', status: 'working', provider: 'codex', safeguard: note })).toBeNull()
    expect(safeguardContext({ name: 'CB2', status: 'watching', provider: 'codex', safeguard: { at: T1, tools: [], stops: 3 } })).toBeNull()
    expect(stallSafeguardOf({ name: 'CB2', status: 'finished', provider: 'codex', safeguard: note })).toEqual({ agent: 'CB2', provider: 'codex', at: T1, stops: 3 })
  })

  it("the user's notice lines: what happened, then the provider's own help, else a pointer to its guidance", () => {
    const lines = (provider: 'codex' | 'opencode') => {
      const t = safeguardLines('CL-133', { agent: 'CB2', provider, at: T1, stops: 3 }) as { lines: unknown[] }
      return t.lines.map((l) => shownText(l as never))
    }
    const codex = lines('codex')
    expect(codex[0]).toMatch(/^CL-133 has stalled\. CB2’s latest turn was stopped by Codex’s safety filter at \d\d:\d\d \(3 stops this session\): look at its pane\.$/)
    expect(codex[1]).toMatch(/Trusted Access for Cyber/)
    expect(lines('opencode')[1]).toBe('Check OpenCode’s guidance on its safety filter.')
  })
})

// --- The stall's cause, on the real board, with the agents' live states stood in for.
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

async function workspace(): Promise<{ w: WS; ws: string; card: number }> {
  const ws = join(base, `ws-${opened.length + 1}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const agents = [{ id: 'a1', name: 'CB2' }, { id: 'a2', name: 'CR1' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: { ...allOff('git'), review: 'agent', noSelfReview: true } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'CL-133', project: 'p' }, user)).number)
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
  return { w, ws, card }
}
type Live = { agentId: string; agentName: string; status: string; cards?: number[]; stopped?: boolean }
const liveAs = (ws: string, agents: Live[]) =>
  vi.spyOn(sessions, 'liveStates').mockReturnValue(
    agents.map((a) => ({ provider: 'codex', runId: `r-${a.agentId}`, projectPath: join(ws, 'p'), agentId: a.agentId, agentName: a.agentName, cwd: join(ws, 'p'), sessionId: '', status: a.status, startedAt: OLD, ...(a.cards ? { watch: { cards: a.cards, since: OLD } } : {}), ...(a.stopped ? { safeguard: { at: T1, tools: ['shell'], stops: 3, latest: { at: T1 } } } : {}) })) as never
  )
const aged = <T extends { history: { at: string }[] }>(c: T): T => ({ ...c, history: c.history.map((h) => ({ ...h, at: OLD })) })

describe("the stall's cause and its agent (HI-2754, HR1's point 2)", () => {
  it("CB2's idle watch: its own stop is said beside the reason; the reviewer's stop alone isn't", async () => {
    const { w, ws, card } = await workspace()
    const lane = (await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card], by: 'You' })).lane
    const view = (await lanes.getLane(w, lane.id))!
    const order = { builder: 'a1', reviewer: 'a2', state: view.state, cards: view.cards.map((c) => ({ number: c.number, column: c.column })) }
    const c = aged(await inWorkspace(w, () => tasks.getTask(card, w)))
    const now = { name: 'CB2', running: true }
    liveAs(ws, [{ agentId: 'a1', agentName: 'CB2', status: 'watching', cards: [card], stopped: true }])
    const why = cardStall(c, now, ws, order)!
    expect(why).toMatch(/^CB2 only watches .*, and nothing waits on it: .* CB2's latest turn was stopped by Codex's safety filter at \d\d:\d\d \(3 stops this session\)\./)
    expect(cardStallCause(c, now, ws, order)).toMatchObject({ agent: { name: 'CB2', status: 'watching' } })
    // The reviewer stopped, the builder only watching: the builder's stall, with nothing of the reviewer's stop.
    liveAs(ws, [
      { agentId: 'a1', agentName: 'CB2', status: 'watching', cards: [card] },
      { agentId: 'a2', agentName: 'CR1', status: 'watching', stopped: true }
    ])
    expect(cardStall(c, now, ws, order)).toMatch(/only watches .* not submitted\.$/)
    // The builder in a turn again (a prompt since would have cleared it anyway): no stall of its idle watch.
    liveAs(ws, [{ agentId: 'a1', agentName: 'CB2', status: 'working', cards: [card], stopped: true }])
    expect(cardStall(c, now, ws, order)).toBeNull()
  })

  it("a structural stall (its start failed) gains nothing from its builder's stop", async () => {
    const { w, ws, card } = await workspace()
    const c = aged(await inWorkspace(w, () => tasks.getTask(card, w)))
    liveAs(ws, [{ agentId: 'a1', agentName: 'CB2', status: 'finished', stopped: true }])
    const why = cardStall(c, { name: 'CB2', running: false, failed: 'its slot could not be made' }, ws, null)
    expect(why).toBeTruthy()
    expect(why).not.toMatch(/safety filter/)
  })

  it("in Review: the reviewer's own stall gains its stop; the builder's stop doesn't touch it", async () => {
    const { w, ws, card } = await workspace()
    const c0 = await inWorkspace(w, () => tasks.getTask(card, w))
    const c = { ...aged(c0), column: 'review' as const, review: { agent: 'a2', agentName: 'CR1', since: OLD } } as typeof c0
    const now = { name: 'CB2', running: true }
    liveAs(ws, [
      { agentId: 'a1', agentName: 'CB2', status: 'watching', cards: [card], stopped: true },
      { agentId: 'a2', agentName: 'CR1', status: 'watching', cards: [card] }
    ])
    const builderStopped = cardStall(c, now, ws, null)!
    expect(builderStopped).toMatch(/CR1 started reviewing/)
    expect(builderStopped).not.toMatch(/safety filter/)
    liveAs(ws, [
      { agentId: 'a1', agentName: 'CB2', status: 'watching', cards: [card] },
      { agentId: 'a2', agentName: 'CR1', status: 'watching', cards: [card], stopped: true }
    ])
    expect(cardStall(c, now, ws, null)).toMatch(/CR1 started reviewing .* CR1's latest turn was stopped by Codex's safety filter/)
  })
})
