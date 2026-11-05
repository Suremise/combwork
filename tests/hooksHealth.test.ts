// Hooks health (#1336): when an agent's hooks stop reaching Combwork, Combwork says so rather than show a wrong status. The
// check's two signs and their bounds (its start; a prompt its screen shows it working on), never on time alone: a long
// silent think after a prompt's hook never counts, nor an Enter that started nothing, nor a late hook of a turn that is
// over as an answer. What follows: the agent's state unknown (stalled, its status words), nothing typed into it, its lane
// paused with the reason; and why, from Claude Code's settings files.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HookIds, LaunchContext } from '../src/main/providers/types'
import { claudeTranscriptTurns } from '../src/main/providers/claude/turns'
import { admit, newLedger } from '../src/main/turnLedger'
import type { LiveSessionState, TaskCard } from '../src/shared/types'
import { HOOKS_GRACE_MS, hookSeen, hookTurn, hooksMissing, hooksMissingFor, newHooksWatch, noteHooksMissing, onHooksHealthChanged, promptSent, SeenOnce, transcriptReset, transcriptTurns, turnHeard, type HooksEvidence } from '../src/main/hooksHealth'
import { promptKey } from '../src/main/providers/turns'
import { readyFor } from '../src/main/readiness'
import { agentState } from '../src/shared/agentState'
import { laneStatusText, laneView, type LaneRecord } from '../src/shared/lanes'
import { laneWaitText } from '../src/shared/laneBar'
import { hooksMissingNote, hooksMissingText, runtimeLabel } from '../src/shared/runtime'
import { tr } from '../src/shared/i18n'
import { tempDir } from './tempDir'

const BOUND = 60_000
const quiet: HooksEvidence = { startWaits: false, screen: null }

describe('its start', () => {
  it('a CLI that sends a hook as it starts: none within the bound is missing, not a moment before', () => {
    const w = newHooksWatch(0, true)
    expect(hooksMissing(w, quiet, BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, quiet, BOUND, BOUND)).toBe('start')
  })

  it('a hook at its start (any turn’s): never missing for the start, however long it then stays quiet', () => {
    const w = newHooksWatch(0, true)
    hookSeen(w, 2_000)
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
    hookSeen(w, 1_000)
    turnHeard(w)
    return w
  }

  it('no false alarm on a long silent think: its prompt hook came, and nothing more for a long while', () => {
    const w = started()
    expect(promptSent(w, 10_000, true)).toBe(true)
    hookSeen(w, 10_200)
    turnHeard(w)
    for (let t = 10_000; t <= 10_000 + 30 * BOUND; t += 5_000) expect(hooksMissing(w, { ...quiet, screen: 'working' }, t, BOUND)).toBeNull()
  })

  it('no hook after it while its screen shows it working: missing once the bound has passed and the work has stood a while', () => {
    const w = started()
    promptSent(w, 10_000, true)
    const working = { ...quiet, screen: 'working' as const }
    // Working from the first look, but not missing before the bound.
    expect(hooksMissing(w, working, 15_000, BOUND)).toBeNull()
    expect(hooksMissing(w, working, 10_000 + BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, working, 10_000 + BOUND, BOUND)).toBe('prompt')
  })

  it('seen working once is enough: the work stands though its screen is idle again (or unread) by the bound', () => {
    const w = started()
    promptSent(w, 10_000, true)
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 15_000, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'idle' }, 20_000, BOUND)).toBeNull()
    expect(w.submit).not.toBeNull()
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('prompt')
  })

  it('the work must stand for the grace too: first seen late, it counts only once the grace has passed', () => {
    const w = started()
    promptSent(w, 10_000, true)
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + BOUND, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + BOUND + HOOKS_GRACE_MS - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + BOUND + HOOKS_GRACE_MS, BOUND)).toBe('prompt')
  })

  it('a late hook of a turn that is over (seen, not a current turn’s) answers nothing: it stays watched', () => {
    const w = started()
    promptSent(w, 10_000, true)
    hookSeen(w, 12_000)
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 15_000, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + BOUND, BOUND)).toBe('prompt')
    // A current turn's hook answers it, before or after it was flagged (sessions then clears the flag).
    turnHeard(w)
    expect(w.submit).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it('a quick turn over before the first look is not flagged by itself (#1371): no screen evidence, no alarm', () => {
    const w = started()
    promptSent(w, 1_000, true)
    expect(hooksMissing(w, { ...quiet, screen: null }, 1_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it('an Enter that started nothing (a menu, a local command): dropped once its screen shows it idle', () => {
    const w = started()
    promptSent(w, 10_000, true)
    expect(hooksMissing(w, { ...quiet, screen: 'idle' }, 10_000 + HOOKS_GRACE_MS - 1, BOUND)).toBeNull()
    expect(w.submit).not.toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'idle' }, 10_000 + HOOKS_GRACE_MS, BOUND)).toBeNull()
    expect(w.submit).toBeNull()
    // Its CLI's later turn of its own (a background task's end) isn't that prompt's.
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it("a launch's task, for a CLI whose first hook comes with its first prompt: watched from its start", () => {
    const w = newHooksWatch(0, false)
    expect(promptSent(w, 0, true)).toBe(true)
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 5_000, BOUND)).toBeNull()
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 120_000, BOUND)).toBe('prompt')
  })

  it("a prompt sent while it works isn't watched (its hooks may come only at the turn's end)", () => {
    const w = started()
    expect(promptSent(w, 10_000, false)).toBe(false)
    expect(hooksMissing(w, { ...quiet, screen: 'working' }, 10_000 + 10 * BOUND, BOUND)).toBeNull()
  })

  it('the first unanswered prompt counts, and a current turn’s hook answers it', () => {
    const w = started()
    promptSent(w, 10_000, true)
    expect(promptSent(w, 20_000, true)).toBe(false)
    expect(w.submit!.at).toBe(10_000)
    turnHeard(w)
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

  it('the note says why when Combwork can tell, and what to do', () => {
    expect(hooksMissingNote(live({ hooksMissing: missing }), tr)).toMatch(/^Combwork isn't hearing from Claude Code's hooks, so its status may be wrong\. None came after a prompt it went to work on\. .*Restart the session/)
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, after: 'start' } }), tr)).toContain('None came after it started.')
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'off', offIn: 'managed settings' } }), tr)).toContain('managed settings turns hooks off (disableAllHooks).')
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'refused' } }), tr)).toContain("Combwork refused its hooks: they didn't carry this session's token.")
    expect(hooksMissingNote(live({ hooksMissing: { ...missing, why: 'newer' } }), tr)).toContain('This Claude Code is newer than the version Combwork was tested with')
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

// #1371: the transcript's own turns, by the id its hooks carry (or, with none, by when they came).
describe("a turn its transcript shows (#1371)", () => {
  const since = 1_000
  const turn = (id: string, at = 2_000, worked = true) => ({ id, at, worked })
  const idWatch = () => newHooksWatch(since, false, 'id')

  it('worked, and no hook named it: missing once the bound has passed since Combwork found it, not a moment before', () => {
    const w = idWatch()
    transcriptTurns(w, [turn('E')], 10_000, since)
    expect(hooksMissing(w, quiet, 10_000 + BOUND - 1, BOUND)).toBeNull()
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    expect(w.flagged).toBe('E')
  })

  it('its hook came first (a Stop before the transcript was written): never', () => {
    const w = idWatch()
    hookTurn(w, 5_000, 'E')
    transcriptTurns(w, [turn('E')], 10_000, since)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it('its hook came late, before the bound: never flagged', () => {
    const w = idWatch()
    transcriptTurns(w, [turn('E')], 10_000, since)
    hookTurn(w, 10_000 + BOUND - 1, 'E')
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it("the turn before's response written late (after a local command): its prompt's hook came, so it's no sign", () => {
    const w = idWatch()
    hookTurn(w, 3_000, 'P')
    transcriptTurns(w, [turn('cmd', 4_000, false)], 5_000, since)
    transcriptTurns(w, [turn('P', 2_000)], 6_000, since)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it("history (a prompt from before this launch began) and a turn the model never took up aren't signs", () => {
    const w = idWatch()
    transcriptTurns(w, [turn('old', since - 5_000), turn('cmd', 2_000, false)], 10_000, since)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it('flagged: an earlier turn’s late hook neither answers it nor clears it; its own does', () => {
    const w = idWatch()
    transcriptTurns(w, [turn('A'), turn('E', 3_000)], 10_000, since)
    hookTurn(w, 10_001, 'A')
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    expect(hookTurn(w, 70_002, 'A')).toBe(false)
    expect(w.flagged).toBe('E')
    expect(hookTurn(w, 70_003, 'E')).toBe(true)
    expect(w.flagged).toBeNull()
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it('an unread id is unknown: it answers nothing until the transcript places it, however much more is read', () => {
    const older = idWatch()
    transcriptTurns(older, [turn('E', 3_000)], 10_000, since)
    expect(hooksMissing(older, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    expect(hookTurn(older, 80_000, 'A')).toBe(false)
    expect(older.answered).toBe(0)
    expect(transcriptTurns(older, [turn('E', 3_000)], 81_000, since)).toBe(false)
    expect(older.flagged).toBe('E')
  })

  // The invariant (#1371 round 3): an older pending turn E ends only on a hook naming E or a turn placed after it, by
  // the one transition (hookTurn, or transcriptTurns for a hook that came first), in the order the session calls them:
  // never a hook replayed. Each order: N's hook before or after N's record, before or after E's alarm; then an older
  // turn's late hook changes nothing, E's late record isn't waited on, and a new turn with no hook still flags.
  describe('the arrival orders (hook before or after the record × before or after the alarm)', () => {
    const orders: { hook: 'before' | 'after'; alarm: 'before' | 'after' }[] = [
      { hook: 'after', alarm: 'before' },
      { hook: 'after', alarm: 'after' },
      { hook: 'before', alarm: 'before' },
      { hook: 'before', alarm: 'after' }
    ]
    for (const o of orders) {
      it(`N's hook ${o.hook} its record, ${o.alarm} E's alarm: E ends; A's late hook, E's late record and a new unhooked X keep the rules`, () => {
        const w = idWatch()
        // A (answered by its own hook), then E: E's hooks never come.
        transcriptTurns(w, [turn('A', 2_000)], 5_000, since)
        hookTurn(w, 5_500, 'A')
        transcriptTurns(w, [turn('E', 3_000)], 10_000, since)
        const alarmAt = 10_000 + BOUND
        let cleared = false
        if (o.alarm === 'after') expect(hooksMissing(w, quiet, alarmAt, BOUND)).toBe('transcript')
        if (o.hook === 'before') {
          cleared = hookTurn(w, 10_500, 'N') || cleared
          expect(w.unheard.has('E')).toBe(true)
          cleared = transcriptTurns(w, [turn('N', 4_000)], 11_000, since) || cleared
        } else {
          cleared = transcriptTurns(w, [turn('N', 4_000)], 11_000, since) || cleared
          cleared = hookTurn(w, 11_500, 'N') || cleared
        }
        // As the session calls hooksBack: only when an alarm stood.
        expect(cleared).toBe(o.alarm === 'after')
        expect(w.flagged).toBeNull()
        expect(w.unheard.has('E')).toBe(false)
        if (o.alarm === 'before') expect(hooksMissing(w, quiet, alarmAt + 10, BOUND)).toBeNull()
        // An older turn's late hook: nothing changes, nothing more is answered.
        const frontier = w.answered
        expect(hookTurn(w, 200_000, 'A')).toBe(false)
        expect(w.answered).toBe(frontier)
        // E's late record: not waited on.
        transcriptTurns(w, [turn('E', 3_000)], 210_000, since)
        expect(hooksMissing(w, quiet, 210_000 + 10 * BOUND, BOUND)).toBeNull()
        // A new turn X, no hook: flagged at its deadline, not before.
        transcriptTurns(w, [turn('X', 300_000)], 900_000, since)
        expect(hooksMissing(w, quiet, 900_000 + BOUND - 1, BOUND)).toBeNull()
        expect(hooksMissing(w, quiet, 900_000 + BOUND, BOUND)).toBe('transcript')
        expect(w.flagged).toBe('X')
      })
    }
  })

  it("HR6's before-the-alarm probe: E and N read at 10 s, N's hook at 11 s, nothing at 70 s", () => {
    const w = idWatch()
    transcriptTurns(w, [turn('E', 3_000), turn('N', 4_000)], 10_000, since)
    expect(hookTurn(w, 11_000, 'N')).toBe(false)
    expect(w.answered).toBe(w.order.get('N'))
    expect(hooksMissing(w, quiet, 70_000, BOUND)).toBeNull()
  })

  it('answered stays answered (the real Claude reader): a late record of E after N answered it never flags E again; a new turn with no hook after that still does', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-21T18:00:00.000Z') + s * 1000).toISOString()
    const prompt = (id: string, s: number) => JSON.stringify({ type: 'user', uuid: `u-${id}`, parentUuid: null, promptId: id, origin: { kind: 'human' }, timestamp: at(s), message: { role: 'user', content: 'do it' } }) + '\n'
    const reply = (uuid: string, parent: string, s: number) => JSON.stringify({ type: 'assistant', uuid, parentUuid: parent, timestamp: at(s), message: { role: 'assistant', content: [] } }) + '\n'
    const started = Date.parse(at(0))
    const memo = {}
    const read = (text: string, now: number) => transcriptTurns(w, claudeTranscriptTurns(text, memo), now, started)
    const w = newHooksWatch(started, false, 'id')
    read(prompt('E', 1) + reply('a-E', 'u-E', 2), 10_000)
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    // N's hook, then its records: E is answered by the newer turn.
    expect(hookTurn(w, 80_000, 'N')).toBe(false)
    expect(read(prompt('N', 70) + reply('a-N', 'u-N', 71), 81_000)).toBe(true)
    expect(w.flagged).toBeNull()
    // A record of E appended late (chained to E's reply): the reader returns E worked again, and it isn't waited on.
    const late = claudeTranscriptTurns(reply('a-E2', 'a-E', 72), memo)
    expect(late.filter((t) => t.worked).map((t) => t.id)).toContain('E')
    transcriptTurns(w, late, 82_000, started)
    expect(w.unheard.has('E')).toBe(false)
    expect(hooksMissing(w, quiet, 82_000 + 10 * BOUND, BOUND)).toBeNull()
    // A new turn X after the recovery, with no hook: flagged again.
    read(prompt('X', 700) + reply('a-X', 'u-X', 701), 900_000)
    expect(hooksMissing(w, quiet, 900_000 + BOUND, BOUND)).toBe('transcript')
    expect(w.flagged).toBe('X')
  })

  it("past order's bound: flagged E keeps its place, so its own hook clears only E while a newer unhooked X still flags; a forgotten turn's late record is unknown", () => {
    const w = idWatch()
    // An answered turn F, then E (flagged), then X (no hook), then enough turns to push F and E out of order.
    transcriptTurns(w, [turn('F', 2_000)], 5_000, since)
    hookTurn(w, 5_500, 'F')
    transcriptTurns(w, [turn('E', 3_000)], 10_000, since)
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    const eAt = w.flaggedSeq
    transcriptTurns(w, [turn('X', 4_000)], 80_000, since)
    transcriptTurns(w, Array.from({ length: 500 }, (_, i) => turn(`old-${i}`, 5_000, false)), 81_000, since)
    expect(w.order.has('E')).toBe(false)
    expect(w.order.has('F')).toBe(false)
    expect(w.forgotten.has('F')).toBe(true)
    expect(w.forgotten.has('E')).toBe(false)
    // E's own hook clears E only, at E's own place (never Infinity or 0).
    expect(hookTurn(w, 90_000, 'E')).toBe(true)
    expect(w.flagged).toBeNull()
    expect(w.answered).toBe(eAt)
    expect(w.unheard.has('X')).toBe(true)
    expect(hooksMissing(w, quiet, 80_000 + BOUND, BOUND)).toBe('transcript')
    expect(w.flagged).toBe('X')
    // F's late record: forgotten, so neither placed anew nor an answer to X (though F was heard).
    expect(transcriptTurns(w, [turn('F', 2_000)], 95_000, since)).toBe(false)
    expect(w.order.has('F')).toBe(false)
    expect(w.flagged).toBe('X')
    // Its hook (forgotten) answers nothing either.
    expect(hookTurn(w, 96_000, 'F')).toBe(false)
    expect(w.flagged).toBe('X')
  })

  it("Copilot's any hook answers what was read, never a turn read after it; a reset lets go of the frontier", () => {
    const copilot = newHooksWatch(since, false, 'time')
    transcriptTurns(copilot, [turn('I1', 10_000)], 11_000, since)
    expect(hooksMissing(copilot, quiet, 11_000 + BOUND, BOUND)).toBe('transcript')
    expect(hookTurn(copilot, 80_000, null, null)).toBe(true)
    expect(copilot.answered).toBe(copilot.order.get('I1'))
    transcriptTurns(copilot, [turn('I2', 200_000)], 201_000, since)
    expect(hooksMissing(copilot, quiet, 201_000 + BOUND, BOUND)).toBe('transcript')
    expect(copilot.flagged).toBe('I2')
    expect(transcriptReset(copilot)).toBe(true)
    expect(copilot.answered).toBe(0)
    expect(copilot.flaggedSeq).toBe(0)
  })

  it("a newer turn already heard when the transcript shows both: the older turn waited on before it is answered, never flagged", () => {
    const w = idWatch()
    hookTurn(w, 9_000, 'N')
    expect(transcriptTurns(w, [turn('E', 3_000), turn('N', 8_000)], 10_000, since)).toBe(false)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it("with the real ledger (HR6's case): a resumed reading that never showed A; E flagged; A's late Stop, which the ledger applies, doesn't clear E", () => {
    const ledger = newLedger(0)
    const ids = (id: string): HookIds => ({ turn: id, call: null, sub: null, continued: false })
    const w = idWatch()
    expect(admit(ledger, { kind: 'prompt', text: 'a' }, ids('A'), { now: 1 }).verdict).toBe('apply')
    hookTurn(w, 1_500, 'A')
    // The resumed file is read from its end: A's records are never read, E's are, and E's hooks never come.
    transcriptTurns(w, [turn('E', 5_000)], 10_000, since)
    expect(hooksMissing(w, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    const stop = admit(ledger, { kind: 'stop', lastMessage: null }, ids('A'), { now: 2 })
    expect(stop.verdict).toBe('apply')
    expect(hookTurn(w, 75_000, 'A')).toBe(false)
    expect(w.flagged).toBe('E')
  })

  it('read again from the start (another file, conversation or launch): what was waited on is let go, and a flag it raised with it', () => {
    const w = idWatch()
    transcriptTurns(w, [turn('E')], 10_000, since)
    expect(transcriptReset(w)).toBe(false)
    expect(hooksMissing(w, quiet, 100 * BOUND, BOUND)).toBeNull()

    const flagged = idWatch()
    transcriptTurns(flagged, [turn('E')], 10_000, since)
    expect(hooksMissing(flagged, quiet, 10_000 + BOUND, BOUND)).toBe('transcript')
    expect(transcriptReset(flagged)).toBe(true)
    expect(flagged.flagged).toBeNull()
    expect(flagged.unheard.size).toBe(0)
    expect(hooksMissing(flagged, quiet, 100 * BOUND, BOUND)).toBeNull()
  })

  it("Copilot (no turn ids): its prompt hook answers it by the prompt's text, any hook after it was recorded by time; the turn before's last hook, a moment earlier, doesn't", () => {
    const copilotTurn = (id: string, at: number, prompt: string) => ({ id, at, worked: true, prompt: promptKey(prompt) })
    // The turn before ended (its agentStop came) just before this prompt was recorded: not this turn's hook.
    const w = newHooksWatch(since, false, 'time')
    hookSeen(w, 9_900)
    hookTurn(w, 9_900, null, null)
    transcriptTurns(w, [copilotTurn('I1', 10_000, 'say Deaf turn.')], 11_000, since)
    expect(hooksMissing(w, quiet, 11_000 + BOUND, BOUND)).toBe('transcript')
    // Flagged: any hook clears it (none names a turn).
    hookSeen(w, 72_000)
    expect(hookTurn(w, 72_000, null, null)).toBe(true)

    // Its prompt hook (it runs before Copilot records the prompt), whether read before or after the transcript: heard.
    const before = newHooksWatch(since, false, 'time')
    hookSeen(before, 19_950)
    hookTurn(before, 19_950, null, '  say   Healthy turn. ')
    transcriptTurns(before, [copilotTurn('I2', 20_000, 'say Healthy turn.')], 21_000, since)
    expect(hooksMissing(before, quiet, 100 * BOUND, BOUND)).toBeNull()
    const after = newHooksWatch(since, false, 'time')
    transcriptTurns(after, [copilotTurn('I3', 30_000, 'say Late hook.')], 31_000, since)
    hookTurn(after, 31_500, null, 'say Late hook.')
    expect(hooksMissing(after, quiet, 100 * BOUND, BOUND)).toBeNull()
    // Any hook after it was recorded (a tool's, its Stop) answers it too.
    const later = newHooksWatch(since, false, 'time')
    transcriptTurns(later, [copilotTurn('I4', 40_000, 'say Tools.')], 41_000, since)
    hookTurn(later, 40_100, null, null)
    expect(hooksMissing(later, quiet, 100 * BOUND, BOUND)).toBeNull()
  })
})

describe('telling the user once per conversation (#1369)', () => {
  it('a conversation is told once; the set stays bounded, and one seen again is kept over older ones', () => {
    const told = new SeenOnce(3)
    expect([told.first('a'), told.first('a'), told.first('b')]).toEqual([true, false, true])
    // a seen again: the newest now, so c and d push b out first, then the next push a.
    expect(told.first('a')).toBe(false)
    expect([told.first('c'), told.first('d')]).toEqual([true, true])
    expect(told.size).toBe(3)
    expect(told.first('a')).toBe(false)
    expect(told.first('b')).toBe(true)
    // Bounded however many come.
    for (let i = 0; i < 1000; i++) told.first(`s${i}`)
    expect(told.size).toBe(3)
    // Forgotten after so many others: told again.
    expect(told.first('a')).toBe(true)
  })
})
