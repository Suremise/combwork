// Hooks health (#1336): when an agent's hooks stop reaching Hive, Hive says so rather than show a wrong status. The
// check's two signs and their bounds (its start; a prompt its CLI went to work on), never on time alone: a long silent
// think after a prompt's hook never counts, nor an Enter that started nothing. What follows: the agent's state unknown
// (stalled, its status words), nothing typed into it, its lane paused with the reason; and why, from Claude Code's
// settings files.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchContext } from '../src/main/providers/types'
import type { LiveSessionState, TaskCard } from '../src/shared/types'
import { HOOKS_GRACE_MS, hookArrived, hooksMissing, hooksMissingFor, newHooksWatch, noteHooksMissing, onHooksHealthChanged, promptSent, type HooksEvidence } from '../src/main/hooksHealth'
import { readyFor } from '../src/main/readiness'
import { agentState } from '../src/shared/agentState'
import { laneStatusText, laneView, type LaneRecord } from '../src/shared/lanes'
import { laneWaitText } from '../src/shared/laneBar'
import { hooksMissingNote, hooksMissingText, runtimeLabel } from '../src/shared/runtime'
import { tr } from '../src/shared/i18n'
import { tempDir } from './tempDir'

const BOUND = 60_000
const quiet: HooksEvidence = { startWaits: false, screen: null, requests: null }

describe('its start', () => {
  it('a CLI that sends a hook as it starts: none within the bound is missing, not a moment before', () => {
    const w = newHooksWatch(0, true)
    expect(hooksMissing(w, quiet, BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, quiet, BOUND, BOUND)).toBe('start')
  })

  it('a hook at its start: never missing for the start, however long it then stays quiet', () => {
    const w = newHooksWatch(0, true)
    hookArrived(w, 2_000)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it("a CLI whose first hook comes with its first prompt (Codex, Copilot): its start isn't a sign", () => {
    const w = newHooksWatch(0, false)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it('the time a question at its start waits for the user (folder trust) doesn\'t count', () => {
    const w = newHooksWatch(0, true)
    expect(hooksMissing(w, { ...quiet, startWaits: true }, 10 * BOUND, BOUND)).toBeNull()
    // Answered then: the bound counts from there.
    expect(hooksMissing(w, quiet, 11 * BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, quiet, 11 * BOUND, BOUND)).toBe('start')
  })
})

describe('a prompt', () => {
  const started = (): ReturnType<typeof newHooksWatch> => {
    const w = newHooksWatch(0, true)
    hookArrived(w, 1_000)
    return w
  }

  it('no false alarm on a long silent think: its prompt hook came, and nothing more for a long while', () => {
    const w = started()
    expect(promptSent(w, 10_000, true, 3)).toBe(true)
    hookArrived(w, 10_200)
    for (let t = 10_000; t <= 10_000 + 30 * BOUND; t += 5_000) expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 5 }, t, BOUND)).toBeNull()
  })

  it('no hook after it while its screen shows it working: missing once the bound has passed and the work has stood a while', () => {
    const w = started()
    promptSent(w, 10_000, true, 3)
    const working = { ...quiet, screen: 'working' as const, requests: 3 }
    // Working from the first look, but not missing before the bound.
    expect(hooksMissing(w, working, 15_000, BOUND)).toBeNull()
    expect(hooksMissing(w, working, 10_000 + BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, working, 10_000 + BOUND, BOUND)).toBe('prompt')
  })

  it('a quick turn over before the first look (HR6 round 2): its count from before the prompt shows the request it made', () => {
    const w = started()
    // A resumed conversation's 3 requests before the prompt (the last look's count, the transcript unchanged since).
    promptSent(w, 1_000, true, 3)
    // Idle at its prompt at every look, a fourth request recorded.
    const quick = { ...quiet, screen: 'idle' as const, requests: 4 }
    expect(hooksMissing(w, quick, 6_000, BOUND)).toBeNull()
    expect(w.submit).not.toBeNull()
    expect(hooksMissing(w, quick, 1_000 + BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, quick, 1_000 + BOUND, BOUND)).toBe('prompt')
  })

  it('its records unreadable just before the prompt: unknown, never none, so its history is no new work; its screen still counts', () => {
    const w = started()
    // A resumed conversation with 12 requests, a local command's Enter (no hook), its transcript unreadable then.
    promptSent(w, 1_000, true, null)
    for (const t of [6_000, 61_000, 10 * BOUND]) expect(hooksMissing(w, { ...quiet, requests: 12 }, t, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 12 }, 11 * BOUND, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 12 }, 11 * BOUND + HOOKS_GRACE_MS, BOUND)).toBe('prompt')
  })

  it('an Enter that started nothing (a menu, a local command): dropped once its screen shows it idle', () => {
    const w = started()
    promptSent(w, 10_000, true, 3)
    expect(hooksMissing(w, { ...quiet, screen: 'idle', requests: 3 }, 10_000 + HOOKS_GRACE_MS, BOUND)).toBeNull()
    expect(w.submit).toBeNull()
    // Its CLI's later turn of its own (a background task's end) isn't that prompt's.
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 4 }, 10_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it("a launch's task, for a CLI whose first hook comes with its first prompt: watched from its start", () => {
    const w = newHooksWatch(0, false)
    expect(promptSent(w, 0, true, 0)).toBe(true)
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 1 }, 5_000, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 1 }, 120_000, BOUND)).toBe('prompt')
  })

  it("a prompt sent while it works isn't watched (its hooks may come only at the turn's end)", () => {
    const w = started()
    expect(promptSent(w, 10_000, false, 3)).toBe(false)
    expect(hooksMissing(w, { ...quiet, screen: 'working', requests: 9 }, 10_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it('the first unanswered prompt counts, and a hook answers it', () => {
    const w = started()
    promptSent(w, 10_000, true)
    expect(promptSent(w, 20_000, true)).toBe(false)
    expect(w.submit!.at).toBe(10_000)
    hookArrived(w, 25_000)
    expect(w.submit).toBeNull()
  })
})

describe('the agents whose hooks are missing', () => {
  afterEach(() => noteHooksMissing('C:\\W\\alpha', 'b1', false))

  it('are told to their listeners as they change, once each change', () => {
    let told = 0
    onHooksHealthChanged(() => told++)
    noteHooksMissing('C:\\W\\alpha', 'b1', true)
    noteHooksMissing('C:\\W\\Alpha', 'b1', true)
    expect(hooksMissingFor('c:\\w\\alpha', 'b1')).toBe(true)
    noteHooksMissing('C:\\W\\alpha', 'b1', false)
    expect(hooksMissingFor('C:\\W\\alpha', 'b1')).toBe(false)
    expect(told).toBe(2)
  })
})

const live = (over: Partial<LiveSessionState> = {}): LiveSessionState =>
  ({ provider: 'claude-code', runId: 'r', projectPath: 'C:\\W\\alpha', agentId: 'b1', cwd: 'C:\\W\\alpha', sessionId: 's', status: 'ready', startedAt: '', launchSignature: '', unseen: false, runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }, ...over }) as LiveSessionState

describe('what follows', () => {
  const missing = { since: '2026-10-21T10:00:00.000Z', after: 'prompt' as const }

  it('its state is unknown: stalled, its status words say so, and nothing is typed into it', () => {
    const st = live({ hooksMissing: missing })
    expect(readyFor(live())).toBe(true)
    expect(readyFor(st)).toBe(false)
    expect(readyFor(st, 'stalled')).toBe(false)
    expect(agentState(st)).toBe('stalled')
    expect(hooksMissingText(st)).toBe('Status unknown: no hooks from Claude Code')
    expect(runtimeLabel(st)).toBe('Status unknown: no hooks from Claude Code')
    expect(runtimeLabel(live())).toBeNull()
  })

  it('the note says why when Hive can tell, and what to do', () => {
    expect(hooksMissingNote(live({ hooksMissing: missing }), tr)).toMatch(/^Hive isn't hearing from Claude Code's hooks, so its status may be wrong\. None came after a prompt it went to work on\. .*Restart the session/)
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, after: 'start' } }), tr)).toContain('None came after it started.')
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'off', offIn: 'managed settings' } }), tr)).toContain('managed settings turns hooks off (disableAllHooks).')
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'refused' } }), tr)).toContain("Hive refused its hooks: they didn't carry this session's token.")
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'newer' } }), tr)).toContain('This Claude Code is newer than the version Hive was tested with')
    expect(hooksMissingNote(live(), tr)).toBeNull()
  })

  const rec = (over: Partial<LaneRecord> = {}): LaneRecord => ({ id: 'lane-1', project: 'alpha', name: null, builder: { id: 'b1', name: 'B1' }, reviewer: { id: 'r1', name: 'R1' }, cards: [1, 2], rounds: 10, waitMinutes: 360, state: 'active', startedBy: 'B1 (alpha)', startedAt: '', updatedAt: '', endedAt: null, mergeCommit: null, ...over })
  const card = (number: number, column: TaskCard['column'], over: Partial<TaskCard> = {}): TaskCard => ({ number, title: `Card ${number}`, column, project: 'alpha', blocked: null, history: [], comments: [], archived: false, ...over }) as unknown as TaskCard

  it("its lane pauses on its card, saying whose hooks; what already waits for the user says more", () => {
    const cards = new Map([[1, card(1, 'doing')], [2, card(2, 'todo')]])
    const v = laneView(rec(), cards, new Map([['r1', 'HR6']]), null, undefined, null, new Set(['r1']))
    expect(v.state).toBe('paused')
    expect(v.status).toEqual({ reason: 'hooks', card: 1, agent: 'HR6' })
    expect(v.pausedOn).toBe(1)
    expect(laneStatusText(v.status!)).toBe("paused: HR6's hooks aren't arriving")
    expect(laneWaitText(v.status!, (n) => `HI-${n}`, tr)).toBe("paused: HR6's hooks aren't arriving")
    expect(laneView(rec(), cards).state).toBe('active')
    const blocked = laneView(rec(), new Map([[1, card(1, 'doing', { blocked: 'Asked the user' })], [2, card(2, 'todo')]]), undefined, null, undefined, null, new Set(['b1']))
    expect(blocked.status?.reason).toBe('blocked')
    // An ended lane isn't paused by anyone's hooks.
    expect(laneView(rec({ state: 'ended', endedAt: '2026-10-21T11:00:00.000Z' }), cards, undefined, null, undefined, null, new Set(['b1'])).status).toBeNull()
  })
})

describe("why: Claude Code's settings turning hooks off", () => {
  const base = tempDir('hive-hooks-health-')
  const programFiles = process.env.ProgramFiles
  afterEach(() => {
    process.env.ProgramFiles = programFiles
  })

  it('the first scope that sets disableAllHooks decides; managed settings allowing only their own hooks too', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const home = join(base, 'home')
    const cwd = join(base, 'project')
    const managed = join(base, 'pf')
    for (const d of [home, join(cwd, '.claude'), join(managed, 'ClaudeCode')]) mkdirSync(d, { recursive: true })
    process.env.ProgramFiles = managed
    const ctx = { cwd, env: { CLAUDE_CONFIG_DIR: home }, extraArgs: [] } as unknown as LaunchContext
    expect(claudeCode.hooksOffIn(ctx)).toBeNull()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ disableAllHooks: true }))
    expect(claudeCode.hooksOffIn(ctx)).toBe("Claude Code's settings.json")
    // A project's own setting comes before the user's: off there turns them back on.
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ disableAllHooks: false }))
    expect(claudeCode.hooksOffIn(ctx)).toBeNull()
    writeFileSync(join(managed, 'ClaudeCode', 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true }))
    expect(claudeCode.hooksOffIn(ctx)).toBe('managed settings')
  })
})
