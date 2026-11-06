import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, AgentDef, Connection, PlanLimit, ProjectConfig, UsageMoveRule } from '../src/shared/types'
import { tempRoot } from './tempDir'

/**
 * HI-2195: an account's usage move. The pure rules (shared/usageMoves.ts), how a usage move and HI-1755's own switch share
 * one switch at the safe point (connectionSwitch.ts), and usageMoves.ts against a fake workspace and fake sessions driven
 * through the real runSwitch: idle agents move at once, busy ones at their safe point, a manual choice always wins, and
 * nothing moves back after a reset.
 */

vi.mock('electron', () => ({
  app: { getPath: () => tempRoot(), isPackaged: false, getVersion: () => '0.0.0' },
  // eslint-disable-next-line typescript/no-extraneous-class
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))

const H = vi.hoisted(() => ({ advanced: true as boolean, notices: [] as { title: string; api?: string; message?: string }[], firstUsable: null as { provider: string } | null }))
vi.mock('../src/main/advanced', () => ({ advanced: { get: (id: string) => (id === 'cw.accounts.usageMoves' ? H.advanced : undefined) } }))
// Told once through tell() (HI-2320): what it tells, by its title and its English one.
vi.mock('../src/main/notify', () => ({ tell: (t: { title: string; apiTitle?: string; message?: string }) => void H.notices.push({ title: t.title, api: t.apiTitle, message: t.message }) }))
vi.mock('../src/main/planUsage', () => ({ connectionLoginNow: () => null }))
vi.mock('../src/main/accounts', async () => {
  const { config } = await import('../src/main/config')
  return {
    allAccounts: () => config.get().accounts ?? [],
    allConnections: () => config.get().connections ?? [],
    accountById: (id: string | null | undefined) => (config.get().accounts ?? []).find((a) => a.id === id),
    getConnection: (id: string | null | undefined) => (config.get().connections ?? []).find((c) => c.id === id),
    // The first usable account here (decision A): what an Assistant naming no CLI launches on (HR3 on HI-2530).
    firstUsableAccount: () => H.firstUsable,
    onConnectionSignedIn: () => undefined
  }
})

// A workspace with one project, its agents in memory, and updateAgent's lock and check as the real one's.
const PROJECT = 'C:\\ws\\proj'
const pc: ProjectConfig = { id: 'p-1', agents: [] } as unknown as ProjectConfig
// The workspace's Assistant: on Anthropic-3 unless a test puts it on Anthropic-1, where it moves too (HI-2530).
const assistantPc: ProjectConfig = { agents: [] } as unknown as ProjectConfig
let lock: Promise<unknown> = Promise.resolve()
// A write held at the lock (HR1's round 1): `gate` set, each write waits for it once it has the lock; `atLock` counts them.
const G: { gate: Promise<void> | null; atLock: number } = { gate: null, atLock: 0 }
const ws = {
  path: 'C:\\ws',
  config: { connections: { 'claude-code': { on: ['a1', 'a2', 'a3'], default: 'a1' } } },
  assistantHome: 'C:\\ws\\.combwork\\assistant',
  isAssistantHome: (p: string) => p === 'C:\\ws\\.combwork\\assistant',
  listProjectPaths: async () => [PROJECT],
  projectConfig: async (p: string) => (p === PROJECT ? pc : p === 'C:\\ws\\.combwork\\assistant' ? assistantPc : ({ agents: [] } as unknown as ProjectConfig)),
  projectIdsNow: () => ({ byPath: new Map([[PROJECT.toLowerCase(), 'p-1']]), byId: new Map() }),
  updateAgent: (p: string, id: string, patch: Partial<AgentDef>, check?: (current: AgentDef) => void) => {
    const run = lock.then(async () => {
      G.atLock++
      if (G.gate) await G.gate
      const current = (p === ws.assistantHome ? assistantPc : pc).agents.find((a) => a.id === id)!
      check?.(current)
      Object.assign(current, patch)
      return current
    })
    lock = run.catch(() => undefined)
    return run
  }
}
vi.mock('../src/main/workspace', () => ({ openWorkspaces: () => [ws], workspaceOf: () => ws, inWorkspace: (_w: unknown, fn: () => unknown) => fn() }))

// Sessions: each running agent's switch through the real runSwitch and SwitchIntents, as sessions.ts composes them.
const S = vi.hoisted(() => ({ running: new Set<string>(), busy: new Set<string>(), quits: [] as string[], resumed: [] as string[], looks: new Map<string, () => void>(), ops: new Map<string, { op: { cancel: (why: string) => void; done: Promise<unknown> }; intents: any }>() }))
vi.mock('../src/main/sessions', async () => {
  const { runSwitch, SwitchIntents } = await import('../src/main/connectionSwitch')
  const sessions = {
    switchAtSafePoint(p: string, id: string, usage?: any): 'queued' | 'waiting' | 'notRunning' {
      const k = `${p}#${id}`
      const w = S.ops.get(k)
      if (w) {
        if (w.intents.join(usage) && usage) void w.op.done.then((e) => usage.ended(e))
        return 'waiting'
      }
      if (!S.running.has(k)) return 'notRunning'
      const intents = new SwitchIntents(usage)
      const op = runSwitch({
        running: () => S.running.has(k),
        heldNow: () => (S.busy.has(k) ? 'in a turn' : null),
        commit: () => intents.commit(),
        quit: async () => {
          S.quits.push(k)
          S.running.delete(k)
          return 'sent'
        },
        resume: async () => {
          S.resumed.push(k)
          S.running.add(k)
        },
        watch: (look) => {
          S.looks.set(k, look)
          return () => S.looks.delete(k)
        },
        log: () => undefined
      })
      S.ops.set(k, { op, intents })
      if (usage) void op.done.then((e) => usage.ended(e))
      void op.done.then(() => S.ops.get(k)?.op === op && S.ops.delete(k))
      return 'queued'
    },
    dropUsageMove(p: string, id: string, why: string): void {
      const w = S.ops.get(`${p}#${id}`)
      if (w?.intents.drop() === 'cancel') w.op.cancel(why)
    }
  }
  return { sessions }
})

const { config } = await import('../src/main/config')
const { lookAtUsageMoves, initUsageMoves, resetUsageMovesForTests, usageMovesPending } = await import('../src/main/usageMoves')
initUsageMoves()
const { noteManualChoice } = await import('../src/main/agentChoice')
const { runSwitch, SwitchIntents } = await import('../src/main/connectionSwitch')
const U = await import('../src/shared/usageMoves')
const { usageHits, usageWakeLine, readSavedUsage } = await import('../src/shared/usageWatch')
const { accountUsageText } = await import('../src/shared/toolReplies')

const HOUR = 3600e3
// The longest a wait here waits: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const ahead = (h: number): string => new Date(Date.now() + h * HOUR).toISOString()
const weekly = (used: number, resetsAt = ahead(48)): PlanLimit => ({ id: 'seven_day', label: 'weekly', windowMinutes: 10080, usedPercent: used, resetsAt })
const fiveHour = (used: number, resetsAt = ahead(2)): PlanLimit => ({ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: used, resetsAt })

const account = (id: string, name: string, extra: Partial<Account> = {}): Account => ({ id, provider: 'claude-code', name, createdAt: '2026-10-01T00:00:00Z', observed: { at: '2026-10-31T00:00:00Z', loggedIn: true }, ...extra })
const conn = (id: string, acc: string, name: string, tag?: string): Connection => ({ id, account: acc, name, ...(tag !== undefined ? { tag } : {}) })
const RULE: UsageMoveRule = { percent: 98, limit: 'weekly', to: 'a2' }

describe('the rules (shared/usageMoves.ts)', () => {
  const now = Date.now()
  it('a limit is due only at its share, in a period whose reset is ahead', () => {
    expect(U.limitDue(weekly(98), 98, now)).toBe(true)
    expect(U.limitDue(weekly(97.9), 98, now)).toBe(false)
    // An expired reading (its period over) or one with no reset time never fires.
    expect(U.limitDue(weekly(99, new Date(now - 1000).toISOString()), 98, now)).toBe(false)
    expect(U.limitDue({ ...weekly(99), resetsAt: null }, 98, now)).toBe(false)
  })
  it('a rule watches its kind of limit, or (any) the weekly and 5-hour ones each on its own', () => {
    const limits = [weekly(10), fiveHour(99), { ...weekly(5), id: 'other', windowMinutes: 60 }]
    expect(U.ruleLimits({ limit: 'weekly' }, limits).map((l) => l.id)).toEqual(['seven_day'])
    expect(U.ruleLimits({ limit: 'fiveHour' }, limits).map((l) => l.id)).toEqual(['five_hour'])
    expect(U.ruleLimits({ limit: 'any' }, limits).map((l) => l.id)).toEqual(['seven_day', 'five_hour'])
  })
  it("a period's record is kept within it and new after its reset (weekly and 5-hour apart)", () => {
    const rec = U.periodRecord(undefined, weekly(98), RULE, 'f1')
    expect(U.periodRecord(rec, { resetsAt: new Date(Date.parse(rec.resetsAt) + 60_000).toISOString() }, RULE, 'f2')).toBe(rec)
    expect(U.periodRecord(rec, { resetsAt: ahead(48 + 168) }, RULE, 'f2').firing).toBe('f2')
  })
  it('matches the same name on the target (any case), else its first connection', () => {
    const cs = [conn('c1', 'a1', 'Builder'), conn('c2', 'a2', 'Main'), conn('c3', 'a2', 'builder ')]
    expect(U.matchConnection({ name: 'Builder' }, 'a2', cs)).toEqual({ connection: cs[2], by: 'name' })
    expect(U.matchConnection({ name: 'Reviewer' }, 'a2', cs)).toEqual({ connection: cs[1], by: 'default' })
    expect(U.matchConnection({ name: 'Builder' }, 'a3', cs)).toBeUndefined()
  })
  it('matches the same tag first (HI-2530): any case and spacing, the first in order of several, then name, then the first', () => {
    // The target: its first is Main (untagged), then two tagged Builders, then one named like the source but tagged otherwise.
    const cs = [conn('m', 'a2', 'Main'), conn('b1', 'a2', 'Opus builders', 'Builders'), conn('b2', 'a2', 'Sonnet builders', 'builders'), conn('n', 'a2', 'Anthropic-1 · Builders', 'Reviewers'), conn('as', 'a2', 'Helper', '  ASSISTANT ')]
    const id = (from: { name: string; tag?: string }) => U.matchConnection(from, 'a2', cs)
    // Tag beats name: the source's name is on the target too, under another tag.
    expect(id({ name: 'Anthropic-1 · Builders', tag: 'Builders' })).toEqual({ connection: cs[1], by: 'tag' })
    // Case and spacing don't matter; of several with the tag, the first in order.
    expect(id({ name: 'x', tag: '  bUILDERS' })).toEqual({ connection: cs[1], by: 'tag' })
    expect(id({ name: 'x', tag: 'assistant' })).toEqual({ connection: cs[4], by: 'tag' })
    // A tag the target hasn't: by name, else the first.
    expect(id({ name: 'anthropic-1 · builders', tag: 'Testers' })).toEqual({ connection: cs[3], by: 'name' })
    expect(id({ name: 'Nowhere', tag: 'Testers' })).toEqual({ connection: cs[0], by: 'default' })
    // No tag, or a blank one: the tag step is skipped, even with untagged connections on the target.
    expect(id({ name: 'Nowhere' })).toEqual({ connection: cs[0], by: 'default' })
    expect(id({ name: 'Nowhere', tag: '   ' })).toEqual({ connection: cs[0], by: 'default' })
  })
  it("a target that can't take them says why: gone, signed out, no connections, or full itself", () => {
    const a1 = account('a1', 'One')
    const cs = [conn('c2', 'a2', 'Main')]
    expect(U.targetProblem(a1, RULE, [a1], cs, undefined, now)).toBe('missing')
    expect(U.targetProblem(a1, RULE, [a1, account('a2', 'Two', { provider: 'codex' })], cs, undefined, now)).toBe('missing')
    expect(U.targetProblem(a1, RULE, [a1, account('a2', 'Two', { observed: { at: '', loggedIn: false } })], cs, undefined, now)).toBe('signedOut')
    expect(U.targetProblem(a1, RULE, [a1, account('a2', 'Two')], [], undefined, now)).toBe('noConnections')
    expect(U.targetProblem(a1, RULE, [a1, account('a2', 'Two')], cs, { limits: [weekly(99)] }, now)).toBe('full')
    expect(U.targetProblem(a1, RULE, [a1, account('a2', 'Two')], cs, { limits: [weekly(50)] }, now)).toBeNull()
  })
})

describe('a usage move and a base switch share one switch (connectionSwitch.ts)', () => {
  const harness = (usage: { ok: boolean } | null, base = false) => {
    let running = true
    let held = true
    const quits: string[] = []
    let look: () => void = () => undefined
    const commits: number[] = []
    const intent = usage ? { commit: async () => (commits.push(1), usage.ok), ended: vi.fn() } : undefined
    const intents = new SwitchIntents(intent)
    if (base && usage) intents.join()
    const op = runSwitch({
      running: () => running,
      heldNow: () => (held ? 'in a turn' : null),
      commit: () => intents.commit(),
      quit: async () => {
        quits.push('quit')
        running = false
        return 'sent'
      },
      resume: async () => undefined,
      watch: (fn) => ((look = fn), () => undefined),
      log: () => undefined
    })
    return { op, intents, quits, commits, intent, safePoint: () => ((held = false), look()) }
  }

  it('a usage move rejected at the safe point leaves the base switch to go on, with no write', async () => {
    const h = harness({ ok: false }, true)
    h.safePoint()
    expect(await h.op.done).toBe('resumed')
    expect(h.quits).toEqual(['quit'])
    expect(h.intents.committed).toBe(false)
  })
  it('a usage move alone, rejected, ends the switch with nothing typed', async () => {
    const h = harness({ ok: false })
    h.safePoint()
    expect(await h.op.done).toBe('cancelled')
    expect(h.quits).toEqual([])
  })
  it('a usage move dropped before the safe point (the rule off) keeps a base switch, and cancels one alone', async () => {
    const both = harness({ ok: true }, true)
    expect(both.intents.drop()).toBe('kept')
    both.safePoint()
    expect(await both.op.done).toBe('resumed')
    expect(both.commits).toEqual([])
    const alone = harness({ ok: true })
    expect(alone.intents.drop()).toBe('cancel')
    alone.op.cancel('the rule changed')
    expect(await alone.op.done).toBe('cancelled')
    expect(alone.quits).toEqual([])
  })
  it('a stop cancels the whole switch: no write, nothing typed', async () => {
    const h = harness({ ok: true }, true)
    h.op.cancel('stopped')
    h.safePoint()
    expect(await h.op.done).toBe('cancelled')
    expect(h.commits).toEqual([])
    expect(h.quits).toEqual([])
  })
  it('a base switch asked for while a usage move waits joins it: one quit', async () => {
    const h = harness({ ok: true })
    expect(h.intents.join()).toBe(true)
    h.safePoint()
    expect(await h.op.done).toBe('resumed')
    expect(h.quits).toEqual(['quit'])
    expect(h.commits).toEqual([1])
  })
})

describe('usageMoves.ts', () => {
  const key = (id: string): string => `${PROJECT}#${id}`
  const agent = (id: string, connection?: string): AgentDef => ({ id, name: id, provider: 'claude-code', ...(connection ? { connection } : {}) }) as AgentDef
  const setUsage = (id: string, limits: PlanLimit[]): void => config.update((c) => (c.connectionPlanUsage = { ...c.connectionPlanUsage, [id]: { provider: 'claude-code', plan: null, limits, updatedAt: new Date().toISOString() } }))
  const connectionOf = (id: string): string | undefined => pc.agents.find((a) => a.id === id)?.connection
  const settle = async (): Promise<void> => {
    await lookAtUsageMoves()
    await lock
  }
  /** The agent's turn ends: its switch reaches its safe point and, once it has quit, resumes. */
  const turnEnds = async (id: string): Promise<void> => {
    S.busy.delete(key(id))
    S.looks.get(key(id))?.()
    await vi.waitFor(() => expect(S.ops.has(key(id))).toBe(false), { timeout: HUNG_MS })
    await lock
  }

  beforeEach(() => {
    resetUsageMovesForTests()
    G.gate = null
    G.atLock = 0
    H.advanced = true
    H.notices.length = 0
    H.firstUsable = null
    for (const s of [S.running, S.busy]) s.clear()
    S.quits.length = 0
    S.resumed.length = 0
    S.ops.clear()
    S.looks.clear()
    config.update((c) => {
      c.accounts = [account('a1', 'Anthropic-1', { usageMove: { ...RULE } }), account('a2', 'Anthropic-2'), account('a3', 'Anthropic-3')]
      c.connections = [conn('c1', 'a1', 'Main'), conn('c1b', 'a1', 'Builder'), conn('c2', 'a2', 'Main'), conn('c2b', 'a2', 'Builder'), conn('c3', 'a3', 'Main')]
      c.connectionPlanUsage = {}
      c.usageMoves = {}
    })
    pc.agents = [agent('idle', 'c1b'), agent('busy', 'c1b'), agent('stopped'), agent('other', 'c3')]
    assistantPc.agents = [{ ...agent('assistant', 'c3'), name: 'Assistant' }]
    for (const id of ['idle', 'busy']) S.running.add(key(id))
    S.busy.add(key('busy'))
  })
  afterEach(() => vi.useRealTimers())

  it('moves idle agents at once and busy ones at their safe point, onto the matching connection, and never back after a reset', async () => {
    setUsage('a1', [weekly(95)])
    await settle()
    expect(connectionOf('idle')).toBe('c1b')
    setUsage('a1', [weekly(98.2)])
    await settle()
    // Idle: switched at once (quit, resumed) on the same-named connection. Stopped: written now. Busy: waits.
    await vi.waitFor(() => expect(S.resumed).toContain(key('idle')), { timeout: HUNG_MS })
    expect(connectionOf('idle')).toBe('c2b')
    expect(connectionOf('stopped')).toBe('c2')
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
    expect(connectionOf('other')).toBe('c3')
    expect(H.notices.map((n) => n.api)).toEqual(['3 agents move from Anthropic-1 to Anthropic-2'])
    await turnEnds('busy')
    expect(connectionOf('busy')).toBe('c2b')
    expect(S.resumed).toContain(key('busy'))
    // The period resets: a new, low reading moves nothing back, and the agents stay on Anthropic-2.
    setUsage('a1', [weekly(3, ahead(48 + 168))])
    await settle()
    expect(pc.agents.map((a) => a.connection)).toEqual(['c2b', 'c2b', 'c2', 'c3'])
  })

  it('moves the Assistant too (HI-2530), only once its turn is over, to the same-tagged connection, and never back', async () => {
    const home = `${ws.assistantHome}#assistant`
    config.update((c) => {
      c.connections = [...c.connections!.filter((x) => x.account !== 'a2'), conn('c2', 'a2', 'Main'), conn('c2b', 'a2', 'Builder'), conn('c2a', 'a2', 'Anthropic-2 · Assistant', 'Assistant'), conn('c1a', 'a1', 'Anthropic-1 · Assistant', 'assistant'), conn('c1x', 'a1', 'Solo')]
    })
    assistantPc.agents = [{ ...agent('assistant', 'c1a'), name: 'Assistant' }]
    // On a connection whose name and tag the target hasn't: its first.
    pc.agents.find((a) => a.id === 'stopped')!.connection = 'c1x'
    S.running.add(home)
    S.busy.add(home)
    setUsage('a1', [weekly(99)])
    await settle()
    await vi.waitFor(() => expect(S.resumed).toContain(key('idle')), { timeout: HUNG_MS })
    // Mid-turn: queued, nothing written or typed yet.
    expect(usageMovesPending()).toContain('assistant:c:\\ws/assistant')
    expect(assistantPc.agents[0].connection).toBe('c1a')
    expect(S.quits).not.toContain(home)
    // The notice names it with the others, and how each was matched.
    expect(H.notices.map((n) => n.api)).toEqual(['4 agents move from Anthropic-1 to Anthropic-2'])
    expect(H.notices[0].message).toContain('Assistant (by tag Assistant)')
    expect(H.notices[0].message).toContain('idle (by name)')
    expect(H.notices[0].message).toContain('stopped (to its first connection)')
    // Its turn over: moved to the same-tagged connection, and resumed there.
    S.busy.delete(home)
    S.looks.get(home)?.()
    await vi.waitFor(() => expect(assistantPc.agents[0].connection).toBe('c2a'), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(S.resumed).toContain(home), { timeout: HUNG_MS })
    // A reverse rule within the period never moves it back (HR1's guard), as for agents.
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a2' ? { ...a, usageMove: { percent: 98, limit: 'weekly', to: 'a1' } } : a))))
    setUsage('a2', [weekly(99)])
    await settle()
    expect(assistantPc.agents[0].connection).toBe('c2a')
  })

  it("an Assistant naming no CLI or connection is moved by its launch CLI's rules only: the first usable account's (HR3)", async () => {
    // A new workspace's Assistant (HI-2108): it launches on the first usable account's CLI, here Codex's.
    assistantPc.agents = [{ id: 'assistant', name: 'Assistant' } as AgentDef]
    H.firstUsable = { provider: 'codex' }
    setUsage('a1', [weekly(99)])
    await settle()
    await vi.waitFor(() => expect(S.resumed).toContain(key('idle')), { timeout: HUNG_MS })
    expect(assistantPc.agents[0].connection).toBeUndefined()
    expect(usageMovesPending().some((k) => k.startsWith('assistant:'))).toBe(false)
    expect(H.notices.map((n) => n.api)).toEqual(['3 agents move from Anthropic-1 to Anthropic-2'])
  })

  it('…and moved when that first usable account is the rule’s CLI, onto the target’s matching connection (HR3)', async () => {
    assistantPc.agents = [{ id: 'assistant', name: 'Assistant' } as AgentDef]
    H.firstUsable = { provider: 'claude-code' }
    setUsage('a1', [weekly(99)])
    await settle()
    // Not running: written at once, to Anthropic-2's first (its connection resolved as Anthropic-1's first, Main: by name).
    await vi.waitFor(() => expect(assistantPc.agents[0].connection).toBe('c2'), { timeout: HUNG_MS })
    expect(H.notices[0]?.message).toContain('Assistant (by name)')
  })

  it("an Assistant inheriting a CLI other than Settings' automatic one keeps it when moved: written with its connection (HR3 round 1)", async () => {
    const { agentProvider } = await import('../src/shared/providers')
    const { resolveAgentConnection } = await import('../src/shared/accounts')
    // The automatic CLI (no provider named) is Claude Code here; the Assistant inherits Codex, the first usable account's.
    expect(agentProvider({}, config.settings)).toBe('claude-code')
    const was = ws.config.connections
    ws.config.connections = { ...was, codex: { on: ['k1', 'k2'], default: 'k1' } } as typeof was
    try {
      config.update((c) => {
        c.accounts = [...c.accounts!, account('k1', 'Codex-1', { provider: 'codex', usageMove: { percent: 98, limit: 'weekly', to: 'k2' } }), account('k2', 'Codex-2', { provider: 'codex' })]
        c.connections = [...c.connections!, conn('kc1', 'k1', 'Codex-1'), conn('kc2', 'k2', 'Codex-2')]
      })
      assistantPc.agents = [{ id: 'assistant', name: 'Assistant' } as AgentDef]
      H.firstUsable = { provider: 'codex' }
      setUsage('k1', [weekly(99)])
      await settle()
      await vi.waitFor(() => expect(assistantPc.agents[0].connection).toBe('kc2'), { timeout: HUNG_MS })
      // Its CLI written with the connection: its next launch (sessions.effective: a connection named, so its own
      // provider) resolves as Codex on Codex-2, not as Claude Code dropping the Codex connection.
      const saved = assistantPc.agents[0]
      expect(saved.provider).toBe('codex')
      const cli = agentProvider(saved, config.settings)
      const launch = resolveAgentConnection(ws.config, cli, saved.connection, config.get().accounts!, config.get().connections!)
      expect(cli).toBe('codex')
      expect(launch.ok && launch.account.id).toBe('k2')
      expect(launch.ok && launch.connection.id).toBe('kc2')
      // Project agents keep whatever provider they had: only the inheriting Assistant is pinned.
      expect(pc.agents.every((a) => a.provider === 'claude-code')).toBe(true)
    } finally {
      ws.config.connections = was
    }
  })

  it('the Assistant, chosen by the user while its move waits, stays where the user put it (HI-2530)', async () => {
    const home = `${ws.assistantHome}#assistant`
    assistantPc.agents = [{ ...agent('assistant', 'c1'), name: 'Assistant' }]
    S.running.add(home)
    S.busy.add(home)
    setUsage('a1', [weekly(99)])
    await settle()
    expect(usageMovesPending()).toContain('assistant:c:\\ws/assistant')
    // Settings → Assistant's choice (projectAgents.updateAgent's note) drops it; its turn ends with nothing written.
    noteManualChoice(ws.assistantHome, { ...assistantPc.agents[0] })
    expect(usageMovesPending()).not.toContain('assistant:c:\\ws/assistant')
    S.busy.delete(home)
    S.looks.get(home)?.()
    await lock
    expect(assistantPc.agents[0].connection).toBe('c1')
    expect(S.quits).not.toContain(home)
  })

  it('a manual choice on the same account while busy wins, through another report and a restart (HR1)', async () => {
    setUsage('a1', [weekly(98)])
    await settle()
    expect(usageMovesPending()).toContain('p-1/busy')
    // The user picks Anthropic-1's Main for it before its turn ends (as projectAgents.updateAgent does: counted under the lock).
    await ws.updateAgent(PROJECT, 'busy', { connection: 'c1' }, (current) => noteManualChoice(PROJECT, current))
    expect(usageMovesPending()).not.toContain('p-1/busy')
    // Another qualifying report, then the safe point: it stays where the user put it, nothing typed.
    setUsage('a1', [weekly(99)])
    await settle()
    S.busy.delete(key('busy'))
    S.looks.get(key('busy'))?.()
    await settle()
    expect(connectionOf('busy')).toBe('c1')
    expect(S.quits).not.toContain(key('busy'))
    // Combwork restarted: the record (config.json) still keeps it for the period.
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBe('kept')
    S.running.add(key('busy'))
    await settle()
    expect(connectionOf('busy')).toBe('c1')
  })

  it('the same connection chosen again counts as the user keeping it', async () => {
    setUsage('a1', [weekly(98)])
    await settle()
    await ws.updateAgent(PROJECT, 'busy', { connection: 'c1b' }, (current) => noteManualChoice(PROJECT, current))
    await turnEnds('busy').catch(() => undefined)
    await settle()
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
  })

  it('a manual choice made after the queue but before the commit is caught at the commit, under the lock', async () => {
    setUsage('a1', [weekly(98)])
    await settle()
    // Written without the note reaching usageMoves first (the commit's own check): the saved value differs.
    pc.agents.find((a) => a.id === 'busy')!.connection = 'c1'
    await turnEnds('busy')
    expect(connectionOf('busy')).toBe('c1')
    expect(S.quits).not.toContain(key('busy'))
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBe('kept')
  })

  it('the Advanced switch off before the safe point drops the move: nothing typed, nothing written', async () => {
    setUsage('a1', [weekly(98)])
    await settle()
    H.advanced = false
    const { emit } = await import('../src/main/events')
    emit({ type: 'advanced-changed' })
    await vi.waitFor(() => expect(S.ops.has(key('busy'))).toBe(false), { timeout: HUNG_MS })
    S.busy.delete(key('busy'))
    await settle()
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
  })

  it('a target that can take no one is noticed once per reason, and moves them once it can', async () => {
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a2' ? { ...a, observed: { at: '', loggedIn: false } } : a))))
    setUsage('a1', [weekly(98)])
    for (let i = 0; i < 3; i++) await settle()
    expect(H.notices.map((n) => n.api)).toEqual(["Combwork can't move Anthropic-1's agents to Anthropic-2"])
    expect(connectionOf('stopped')).toBeUndefined()
    // Signed in again: the next look moves them, with the moved notice.
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a2' ? { ...a, observed: { at: '', loggedIn: true } } : a))))
    await settle()
    expect(connectionOf('stopped')).toBe('c2')
    expect(H.notices).toHaveLength(2)
  })

  /** Holds writes at the lock; returns its release. */
  const hold = (): (() => void) => {
    let release!: () => void
    G.gate = new Promise<void>((r) => (release = r))
    return () => {
      G.gate = null
      release()
    }
  }
  /** The busy agent's turn ends while writes are held: its commit reaches the lock and waits there. */
  const safePointAtLock = async (): Promise<() => void> => {
    setUsage('a1', [weekly(98)])
    await settle()
    const release = hold()
    const at = G.atLock
    S.busy.delete(key('busy'))
    S.looks.get(key('busy'))?.()
    await vi.waitFor(() => expect(G.atLock).toBeGreaterThan(at), { timeout: HUNG_MS })
    return release
  }

  it('the Advanced switch turned off while the write waits for the lock: nothing written, nothing typed (HR1 round 1)', async () => {
    const release = await safePointAtLock()
    H.advanced = false
    const { emit } = await import('../src/main/events')
    emit({ type: 'advanced-changed' })
    release()
    await vi.waitFor(() => expect(S.ops.has(key('busy'))).toBe(false), { timeout: HUNG_MS })
    await lock
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBeUndefined()
  })

  it('a manual stop while the write waits for the lock: nothing written, and it stays to be tried again', async () => {
    const release = await safePointAtLock()
    S.ops.get(key('busy'))!.op.cancel('stopped')
    release()
    await vi.waitFor(() => expect(S.ops.has(key('busy'))).toBe(false), { timeout: HUNG_MS })
    await lock
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBeUndefined()
  })

  it('the target signed out while the write waits: no write, and a base switch sharing it still goes on', async () => {
    setUsage('a1', [weekly(98)])
    await settle()
    // HI-1755's own switch joins the waiting usage move.
    const { sessions } = await import('../src/main/sessions')
    expect(sessions.switchAtSafePoint(PROJECT, 'busy')).toBe('waiting')
    const release = hold()
    const at = G.atLock
    S.busy.delete(key('busy'))
    S.looks.get(key('busy'))?.()
    await vi.waitFor(() => expect(G.atLock).toBeGreaterThan(at), { timeout: HUNG_MS })
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a2' ? { ...a, observed: { at: '', loggedIn: false } } : a))))
    release()
    await vi.waitFor(() => expect(S.resumed).toContain(key('busy')), { timeout: HUNG_MS })
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).toContain(key('busy'))
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBeUndefined()
  })

  it('a period that ends while the agent works moves nothing at its safe point, with no new report (HR1 round 1)', async () => {
    const resetsAt = ahead(1)
    setUsage('a1', [weekly(98, resetsAt)])
    await settle()
    expect(usageMovesPending()).toContain('p-1/busy')
    // The weekly limit resets while it works: no report, no event; then its turn ends.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(resetsAt) + 60_000)
    S.busy.delete(key('busy'))
    S.looks.get(key('busy'))?.()
    await vi.waitFor(() => expect(S.ops.has(key('busy'))).toBe(false), { timeout: HUNG_MS })
    await lock
    expect(connectionOf('busy')).toBe('c1b')
    expect(S.quits).not.toContain(key('busy'))
    expect(config.get().usageMoves?.a1?.seven_day?.handled['p-1/busy']).toBeUndefined()
  })

  it('reciprocal rules never bounce agents between two full accounts', async () => {
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a2' ? { ...a, usageMove: { percent: 98, limit: 'weekly', to: 'a1' } } : a))))
    setUsage('a1', [weekly(98)])
    await settle()
    expect(connectionOf('stopped')).toBe('c2')
    // Anthropic-2 fills up too: Anthropic-1 is full itself, so nothing goes back.
    setUsage('a2', [weekly(99)])
    await settle()
    expect(connectionOf('stopped')).toBe('c2')
  })

  it('weekly and 5-hour limits fire and reset apart (any)', async () => {
    config.update((c) => (c.accounts = c.accounts!.map((a) => (a.id === 'a1' ? { ...a, usageMove: { percent: 90, limit: 'any', to: 'a2' } } : a))))
    pc.agents = [agent('stopped')]
    setUsage('a1', [weekly(50), fiveHour(91)])
    await settle()
    expect(connectionOf('stopped')).toBe('c2')
    expect(Object.keys(config.get().usageMoves?.a1 ?? {})).toEqual(['five_hour'])
    // Moved back by hand; the 5-hour period resets and the weekly one fills: the weekly firing is its own.
    await ws.updateAgent(PROJECT, 'stopped', { connection: 'c1' }, (current) => noteManualChoice(PROJECT, current))
    setUsage('a1', [weekly(92), fiveHour(91, ahead(7))])
    await settle()
    expect(Object.keys(config.get().usageMoves?.a1 ?? {}).sort()).toEqual(['five_hour', 'seven_day'])
    expect(connectionOf('stopped')).toBe('c2')
  })
})

describe('the usage watch and the listing', () => {
  it('a watch hits once an account reaches its share, and tells the limit', () => {
    const watch = [{ account: 'a1', name: 'Anthropic-1', percent: 98, limit: 'weekly' as const }]
    expect(usageHits(watch, () => [weekly(97)], Date.now())).toEqual([])
    const hits = usageHits(watch, () => [weekly(98.04, '2026-11-02T09:00:00.000Z')], Date.parse('2026-11-01T00:00:00Z'))
    expect(hits).toEqual(['Anthropic-1: weekly 98% (resets 2026-11-02T09:00Z)'])
    expect(usageWakeLine(hits)).toMatch(/^\[CW\] Usage reached: Anthropic-1: weekly 98%/)
    expect(readSavedUsage(watch)).toEqual(watch)
    expect(readSavedUsage([{ ...watch[0], percent: 0 }])).toBeNull()
  })
  it("cw_connection list's line gives the limits and the move", () => {
    expect(accountUsageText({ account: 'Anthropic-1', limits: [{ label: 'weekly', usedPercent: 95, resetsAt: '2026-11-02T09:00:00.000Z' }], move: { percent: 98, limit: 'weekly', to: 'Anthropic-2' } })).toBe('Usage of Anthropic-1: weekly 95% (resets 2026-11-02T09:00Z); moves its agents to Anthropic-2 at 98% of the weekly limit')
  })
})
