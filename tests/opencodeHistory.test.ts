// OpenCode's history, usage, cost and plan limits (HI-2762, design s7/s10/s13): the mirror Combwork keeps of a session
// (mirror.ts), read from what 2.2.6 recorded (tests/fixtures/opencode/real-2.2.6); the worker core that reads, exports and
// publishes it (historyCore.ts), with its serialized ownership, bounds and repair; and the main side's limits and live
// cost handling (history.ts). The non-null usage/limits answer is from 2.2.6's openapi.json, never observed: labelled so.
import { readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { HISTORY_TEXT, OpencodeConversationParser, buildMirror, inconsistentBreakdowns, mirrorState, opencodePlanUsage, opencodeUsage, parseExport, parseMirrorUsage, placeholderMirror, subagentSessions, withStatus, withoutStatus } from '../src/main/providers/opencode/mirror'
import { Failed, HistoryCore, dbFiles, mirrorPath, plainLocalGet, statePath, type CoreEvent } from '../src/main/providers/opencode/historyCore'
import { OpencodeHistory, historyWorkerForTests } from '../src/main/providers/opencode/history'
import { serverInfoPath } from '../src/main/providers/opencode/launcher'
import { englishText } from '../src/shared/advanced'
import type { TranscriptItem } from '../src/shared/types'
import { tempDir } from './tempDir'
import { createRequire } from 'module'

/** A child's environment from the run context's allowlist, never the shell's (tests/README.md, Isolation). */
const childEnv = (): Record<string, string> => (createRequire(import.meta.url)('./e2e/runContext.cjs') as { childEnv: () => Record<string, string> }).childEnv()

const FIX = join(__dirname, 'fixtures', 'opencode', 'real-2.2.6')
const fixture = (rel: string): any => JSON.parse(readFileSync(join(FIX, rel), 'utf8'))
/** A recorded `GET /api/session/{id}/message` body's messages, oldest first (the API gives them newest first). */
const recorded = (rel: string): any[] => [...fixture(rel).body.data].reverse()
// The fixtures are CRLF in a Windows checkout (.gitattributes): read as LF.
const cliStdout = (rel: string): string => readFileSync(join(FIX, rel), 'utf8').replace(/\r\n/g, '\n').split('--- stdout\n')[1].split('\n--- stderr')[0]

const SHELL = { info: fixture('wire/session-after-turn.json').body.data, messages: recorded('messages/shell-permission-once.json') }
const COMPACTION = { info: fixture('wire/session-after-compaction.json').body.data, messages: recorded('messages/compaction.json') }
const mirrorOf = (x: { info: any; messages: any[] }, header: Record<string, unknown> = { w: 1, epoch: 1, source: 'api' }): string => buildMirror(header, x.info, x.messages)
const conversation = (text: string, root: string | null = null): TranscriptItem[] => {
  const p = new OpencodeConversationParser(root)
  p.feed(Buffer.from(text))
  return p.items
}

describe("OpenCode's usage from its session (HI-2762)", () => {
  it("takes the session's totals from its info, which count its title's request the messages don't show (5520 against 5043 recorded)", () => {
    const u = parseMirrorUsage(mirrorOf(SHELL), SHELL.info.id)
    expect(u.inputTokens).toBe(5520)
    expect(u.outputTokens).toBe(1222)
    expect(u.cacheReadTokens).toBe(4843)
    expect(u.requests).toBe(2)
    expect(u.model).toBe('probe/qwen3:8b')
    expect(u.title).toBe('r0-shell-marker output')
    expect(u.userMessages).toBe(1)
    // The cost as reported: $0, never an estimate.
    expect(u.costUsd).toBe(0)
    expect(u.costEstimated).toBe(false)
    // The remainder on the last activity's day (a convention): the days add up to the session; the timeline keeps to the messages.
    const days = Object.values(u.days ?? {})
    expect(days.reduce((n, d) => n + d.inputTokens, 0)).toBe(5520)
    const rows = u.timeline!.rows
    expect(rows.reduce((n, r) => n + r[1], 0)).toBe(4834 + 209)
    // The context now: the last request's input and cache, and its output.
    expect(u.contextTokens).toBe(209 + 4839 + 128)
  })

  it("counts a compaction as a request and an event, and agrees with stats --json on the assistant steps (its title and compaction are the session's only)", () => {
    const u = parseMirrorUsage(mirrorOf(COMPACTION), COMPACTION.info.id)
    expect(u.requests).toBe(2)
    expect(u.compactions).toHaveLength(1)
    expect(u.compactions[0]).toMatchObject({ trigger: 'manual', preTokens: 4766 + 4 + 193, postTokens: 467 })
    expect(u.inputTokens).toBe(5798)
    const stats = JSON.parse(cliStdout('cli/stats-json-after-compaction.txt'))
    const assistant = COMPACTION.messages.filter((m) => m.type === 'assistant').reduce((n, m) => n + m.tokens.input, 0)
    expect(assistant).toBe(stats.tokens.input)
  })

  it('keeps info\'s totals and leaves the breakdown out when the messages add up to more than info, for every token kind and cost', () => {
    const msg = (tokens: any, cost: number) => ({ id: 'm1', type: 'assistant', time: { created: 1794179612566 }, model: { id: 'x', providerID: 'p' }, tokens, cost })
    for (const [kind, info, message] of [
      ['input', { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { input: 120, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }],
      ['output', { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, { input: 0, output: 120, reasoning: 0, cache: { read: 0, write: 0 } }],
      ['cache read', { input: 0, output: 0, reasoning: 0, cache: { read: 100, write: 0 } }, { input: 0, output: 0, reasoning: 0, cache: { read: 120, write: 0 } }],
      ['cache write', { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 100 } }, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 120 } }]
    ] as const) {
      const u = opencodeUsage('ses_x', { id: 'ses_x', tokens: info, cost: 0 }, [msg(message, 0)])
      const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
      expect(total, kind).toBe(100)
      expect(u.days, kind).toBeUndefined()
      expect(u.timeline, kind).toBeUndefined()
    }
    const c = opencodeUsage('ses_c', { id: 'ses_c', tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 1 }, [msg({ input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 1.2)])
    expect(c.costUsd).toBe(1)
    expect(c.days).toBeUndefined()
    expect(c.costReports).toBeUndefined()
    expect(inconsistentBreakdowns.at(-1)).toEqual({ sessionId: 'ses_c', kinds: ['cost'] })
  })

  it('reads a rewrite afresh: the same mirror twice is the same usage, and a smaller one replaces it (never a negative)', () => {
    const text = mirrorOf(SHELL)
    expect(parseMirrorUsage(text, 's')).toEqual(parseMirrorUsage(text, 's'))
    const smaller = mirrorOf({ info: { ...SHELL.info, tokens: { input: 300, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } }, messages: SHELL.messages.slice(0, 1) })
    const u = parseMirrorUsage(smaller, 's')
    expect(u.inputTokens).toBe(300)
    expect(u.requests).toBe(0)
    // Inconsistent, then consistent again.
    const bad = mirrorOf({ info: { ...SHELL.info, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, messages: SHELL.messages })
    expect(parseMirrorUsage(bad, 's').days).toBeUndefined()
    expect(parseMirrorUsage(text, 's').days).toBeDefined()
  })

  it('sums the messages for a placeholder or a mirror without info, and has no usage for a placeholder', () => {
    expect(parseMirrorUsage(placeholderMirror(), 's').requests).toBe(0)
    const noInfo = placeholderMirror() + SHELL.messages.map((m) => JSON.stringify({ type: 'combwork.message', message: m })).join('\n') + '\n'
    expect(parseMirrorUsage(noInfo, 's').inputTokens).toBe(4834 + 209)
  })
})

describe("OpenCode's conversation from its mirror (HI-2762)", () => {
  it('shows a shell call with its input, output and exit, the reasoning folded, and the reply', () => {
    const items = conversation(mirrorOf(SHELL))
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'thinking', 'assistant'])
    const tool = items[2].kind === 'tool' ? items[2].tool : null
    expect(tool).toMatchObject({ name: 'shell', input: 'echo r0-shell-marker', result: 'r0-shell-marker\r\n', isError: false, exitCode: 0, summary: 'echo r0-shell-marker' })
    expect(items[4]).toMatchObject({ kind: 'assistant', text: 'r0-shell-marker' })
  })

  it('says an interrupted turn and a failed one in OpenCode\'s words, and a compaction with its summary and the context before it', () => {
    const interrupted = conversation(mirrorOf({ info: fixture('wire/session-interrupted.json').body.data, messages: recorded('messages/interrupted.json') }))
    expect(interrupted.at(-1)).toMatchObject({ kind: 'notice', level: 'info' })
    expect(englishText((interrupted.at(-1) as any).message)).toBe('Interrupted by you')
    const failed = conversation(mirrorOf({ info: fixture('wire/session-failed.json').body.data, messages: recorded('messages/failed-provider-400.json') }))
    expect(failed.filter((i) => i.kind === 'notice').map((i) => (i as any).text)).toContain('r0 provider refused')
    const compacted = conversation(mirrorOf(COMPACTION))
    const c = compacted.find((i) => i.kind === 'compaction') as any
    expect(c).toMatchObject({ trigger: 'manual', preTokens: 4766 + 4 + 193, postTokens: 467 })
    expect(c.summary).toContain('## Objective')
  })

  it('shows MCP calls made through Code Mode\'s execute, with their result', () => {
    const m = recorded('messages/mcp-through-execute.json')
    const items = conversation(mirrorOf({ info: { id: 's', time: {} }, messages: m }))
    const tool = items.find((i) => i.kind === 'tool') as any
    expect(tool.tool.name).toBe('execute')
    expect(tool.tool.result).toBe('pong from combwork (token T-OURS)')
    // The call it made, as 2.2.6 recorded it (metadata.toolCalls), a tool of its own with the script's one result.
    expect(tool.tool.script).toBe(true)
    expect(tool.tool.calls).toEqual([expect.objectContaining({ name: 'combwork.ping_combwork', input: 'note: r0', result: 'pong from combwork (token T-OURS)', isError: false })])
  })

  it('ends with a translated notice and OpenCode\'s own words when the newest read failed; the history before it unchanged', () => {
    const good = mirrorOf(SHELL)
    const failed = withStatus(good, 'exit', 'Session not found: ses_x', '2026-11-09T03:00:00.000Z')
    expect(withoutStatus(failed)).toBe(good)
    expect(failed.startsWith(good)).toBe(true)
    // A second failure replaces the status line, never stacks one.
    expect(withStatus(failed, 'timeout', 'slow', '2026-11-09T03:01:00.000Z').split('combwork.status').length).toBe(2)
    const items = conversation(failed)
    expect(items.slice(0, 5)).toEqual(conversation(good))
    const notice = items[5] as any
    expect(notice.kind).toBe('notice')
    expect(notice.message.m.id).toBe(HISTORY_TEXT.incomplete.id)
    expect(englishText(notice.message)).toBe("Combwork couldn't read the end of this session from OpenCode: OpenCode ended with an error. What's shown is what it had read before.")
    expect(items[6]).toMatchObject({ kind: 'notice', text: 'Session not found: ses_x' })
    expect(mirrorState(failed).status?.problem).toBe('exit')
    expect(mirrorState(good).status).toBeNull()
  })

  it('tells a placeholder from a complete mirror by its first line, not by the file', () => {
    expect(mirrorState(placeholderMirror()).header?.state).toBe('placeholder')
    expect(mirrorState(mirrorOf(SHELL)).header).toMatchObject({ state: 'complete', w: 1, source: 'api' })
    expect(conversation(placeholderMirror())).toEqual([])
  })

  it("reads 2.2.6's CLI export, and nothing that isn't a session's", () => {
    const e = parseExport(cliStdout('cli/session-export-after-compaction.txt'))
    expect(e?.info.id).toMatch(/^ses_/)
    expect(e?.messages.map((m) => m.type)).toEqual(['user', 'assistant', 'idle', 'compaction', 'idle'])
    expect(parseExport('{}')).toBeNull()
    expect(parseExport('not json')).toBeNull()
  })
})

describe("OpenCode's plan limits (HI-2762)", () => {
  const at = '2026-11-09T03:00:00.000Z'
  it('says none for data: null, as 2.2.6 answers with no Console sign-in (recorded)', () => {
    expect(opencodePlanUsage(fixture('wire/usage-limits-signed-out.json').body, at)).toEqual({ kind: 'none' })
  })

  // From 2.2.6's openapi.json (UsageLimits.Info, .Go, .Meter, .Budget, .BudgetModel): NOT observed, no account was used.
  const UNOBSERVED = {
    location: { directory: 'C:\\p' },
    data: {
      workspace: { id: 'wrk_1', name: 'Team', usageURL: 'https://opencode.ai/usage' },
      go: { rolling: { percent: 42, limited: false, resetsAt: 1794200000000 }, weekly: { percent: 99, limited: true, resetsAt: 1794700000000 }, monthly: { percent: 101, limited: false, resetsAt: 1796000000000 } },
      budgets: [
        { id: 'b1', limit: 50, spent: 12.5, scope: 'combined', per: 'set', coverage: 'all', models: [], vendors: [], picked: true, shared: false, resetsAt: 1796000000000 },
        { id: 'b2', limit: 0, spent: 0, scope: 'each', per: 'model', coverage: 'models', models: [{ providerID: 'anthropic', modelID: 'claude-x', name: 'Claude X' }], vendors: [], picked: false, shared: false, resetsAt: 1796000000000 },
        { id: 'b3', limit: 10, spent: -1, scope: 'each', per: 'set', coverage: 'all', models: [], vendors: [], picked: false, shared: false, resetsAt: 1796000000000 },
        { id: 'b4', limit: 10, spent: 1, scope: 'each', per: 'set', coverage: 'models', models: [], vendors: ['openai'], picked: false, shared: false }
      ]
    }
  }

  it('maps a schema-shaped answer (unobserved), failing closed on what it doesn\'t know', () => {
    const r = opencodePlanUsage(UNOBSERVED, at)
    expect(r.kind).toBe('report')
    if (r.kind !== 'report') return
    expect(r.usage.plan).toBe('Team')
    const byId = Object.fromEntries(r.usage.limits.map((l) => [l.id, l]))
    expect(byId['go.rolling']).toMatchObject({ usedPercent: 42, windowMinutes: null, resetsAt: new Date(1794200000000).toISOString(), models: 'OpenCode Go (rolling)' })
    // limited: at least 100%.
    expect(byId['go.weekly']).toMatchObject({ usedPercent: 100, windowMinutes: 7 * 24 * 60 })
    // A percent over 100 is no meter.
    expect(byId['go.monthly']).toBeUndefined()
    expect(byId['budget.b1']).toMatchObject({ usedPercent: 25, models: 'Console budget: all models' })
    // A budget of 0 isn't in the plan; a negative spend and a missing reset are left out.
    expect(byId['budget.b2']).toMatchObject({ notIncluded: true, models: 'Console budget: Claude X' })
    expect(byId['budget.b3']).toBeUndefined()
    expect(byId['budget.b4']).toBeUndefined()
  })

  it('calls an unknown shape, or one with nothing valid, unsupported, never a report', () => {
    expect(opencodePlanUsage({}, at)).toEqual({ kind: 'unsupported' })
    expect(opencodePlanUsage({ data: { what: 1 } }, at)).toEqual({ kind: 'unsupported' })
    expect(opencodePlanUsage({ data: { workspace: { id: 'w', usageURL: 'u' }, budgets: [{ id: 'x', limit: 'a' }] } }, at)).toEqual({ kind: 'unsupported' })
  })
})

// ---- The worker core, on a fake server

interface FakeServer {
  info: any
  /** Oldest first. */
  messages: any[]
  w: number
  /** Called at each watermark read (the n-th): may change the session or wait. */
  onWatermark?: (n: number) => void | Promise<void>
  limits?: unknown
  reads: string[]
}

function fakeGet(srv: FakeServer): (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }> {
  let marks = 0
  return async (input, headers) => {
    const url = new URL(String(input))
    if (headers.authorization !== 'Basic ' + Buffer.from('opencode:pw').toString('base64')) return { status: 401, body: '{}' }
    srv.reads.push(url.pathname + url.search)
    const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) })
    if (url.pathname.endsWith('/log')) {
      await srv.onWatermark?.(++marks)
      return { status: 200, body: `data: ${JSON.stringify({ type: 'log.synced', aggregateID: srv.info.id, seq: srv.w })}\n\n` }
    }
    if (url.pathname === `/api/session/${srv.info.id}`) return json({ data: srv.info })
    if (url.pathname === `/api/session/${srv.info.id}/message`) {
      const limit = Number(url.searchParams.get('limit'))
      const from = Number(url.searchParams.get('cursor') ?? 0)
      const newestFirst = [...srv.messages].reverse()
      const page = newestFirst.slice(from, from + limit)
      return json({ data: page, cursor: { previous: 'p', ...(from + limit < newestFirst.length ? { next: String(from + limit) } : { next: 'end' }) } })
    }
    if (url.pathname === '/api/experimental/usage/limits') return json(srv.limits ?? { location: {}, data: null })
    return { status: 404, body: '{}' }
  }
}

function newCore(srv: FakeServer, events: CoreEvent[] = []): HistoryCore {
  const g = fakeGet(srv)
  const core = new HistoryCore((e) => events.push(e), { get: async (url, headers, _signal, maxBytes) => {
    const r = await g(url, headers)
    if (Buffer.byteLength(r.body) > maxBytes) throw new Failed('size', 'too large')
    return r
  }, spawn: (f, a, o) => require('child_process').spawn(f, a, { env: o.env, cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), endTree: (c) => c.kill(), now: () => Date.now() })
  return core
}

let req = 0
const ask = (core: HistoryCore, body: any): Promise<unknown> => core.handle({ ...body, id: ++req })

async function started(srv: FakeServer, home: string, runId = 'run1'): Promise<{ core: HistoryCore; events: CoreEvent[] }> {
  const events: CoreEvent[] = []
  const core = newCore(srv, events)
  await ask(core, { type: 'begin', home, sessionId: srv.info.id, runId })
  await ask(core, { type: 'server', runId, url: 'http://127.0.0.1:1', password: 'pw' })
  return { core, events }
}

const server = (over: Partial<FakeServer> = {}): FakeServer => ({ info: { ...SHELL.info, id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' }, messages: SHELL.messages, w: 13, reads: [], ...over })

describe("the OpenCode history's worker core (HI-2762)", () => {
  it('publishes a settled read of every page, oldest first, with its watermark', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core, events } = await started(srv, home)
    await ask(core, { type: 'bounds', bounds: { pageSize: 2 } })
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    const text = readFileSync(mirrorPath(home, srv.info.id), 'utf8')
    expect(mirrorState(text).header).toMatchObject({ state: 'complete', w: 13, source: 'api' })
    expect(srv.reads.filter((r) => r.includes('/message')).length).toBe(3)
    expect(parseMirrorUsage(text, srv.info.id).inputTokens).toBe(5520)
    expect(events.some((e) => e.event === 'published')).toBe(true)
  })

  it('publishes nothing while every try is unsettled (a turn under way), and no notice', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server({ onWatermark: () => void srv.w++ })
    const { core } = await started(srv, home)
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    expect(existsSync(mirrorPath(home, srv.info.id))).toBe(false)
  })

  it('reads nothing more on a poll while time.updated is the one published', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core } = await started(srv, home)
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    srv.reads.length = 0
    await ask(core, { type: 'refresh', runId: 'run1' })
    await ask(core, { type: 'idle' })
    expect(srv.reads).toEqual([`/api/session/${srv.info.id}`])
  })

  it('drops a read whose session was taken by a newer run while it read (the commit race)', async () => {
    const home = tempDir('cw-oc-hist-')
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const srv = server({ onWatermark: (n) => (n === 2 ? gate : undefined) })
    const { core } = await started(srv, home)
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    // The read waits at its second watermark: a new run begins on the session meanwhile, answered before the read goes on.
    for (let i = 0; i < 200 && srv.reads.filter((r) => r.includes('/log')).length < 2; i++) await new Promise((r) => setImmediate(r))
    expect(srv.reads.filter((r) => r.includes('/log')).length).toBe(2)
    await ask(core, { type: 'begin', home, sessionId: srv.info.id, runId: 'run2' })
    release()
    await ask(core, { type: 'idle' })
    expect(existsSync(mirrorPath(home, srv.info.id))).toBe(false)
  })

  it('never lets an export older than the published mirror replace it', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core } = await started(srv, home)
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    await ask(core, { type: 'end', runId: 'run1' })
    const older = join(home, 'older.json')
    writeFileSync(older, JSON.stringify({ info: { ...srv.info, title: 'older', time: { ...srv.info.time, updated: srv.info.time.updated - 1000 } }, messages: srv.messages.slice(0, 1) }))
    await ask(core, { type: 'export', home, sessionId: srv.info.id, reason: 'runEnd', command: { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(older)}))`], env: childEnv() } })
    await ask(core, { type: 'idle' })
    expect(parseMirrorUsage(readFileSync(mirrorPath(home, srv.info.id), 'utf8'), srv.info.id).title).toBe('r0-shell-marker output')
  })

  it('keeps the last good mirror on a failed export, says why, retries only once the account changed, and clears the notice on success', async () => {
    const home = tempDir('cw-oc-hist-')
    const sid = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'
    const events: CoreEvent[] = []
    const core = newCore(server(), events)
    mkdirSync(join(home, 'combwork-sessions'), { recursive: true })
    writeFileSync(mirrorPath(home, sid), placeholderMirror())
    mkdirSync(join(home, 'opencode'), { recursive: true })
    writeFileSync(dbFiles(home)[0], 'db')
    utimesSync(dbFiles(home)[0], new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const fail = { file: process.execPath, args: ['-e', "process.stderr.write('Session not found: x'); process.exit(1)"], env: childEnv() }
    expect(await ask(core, { type: 'repairScan', homes: [home] })).toEqual([{ home, sessionId: sid }])
    await ask(core, { type: 'export', home, sessionId: sid, reason: 'repair', command: fail })
    await ask(core, { type: 'idle' })
    const after = readFileSync(mirrorPath(home, sid), 'utf8')
    expect(mirrorState(after).header?.state).toBe('placeholder')
    expect(mirrorState(after).status).toMatchObject({ problem: 'exit', detail: 'Session not found: x' })
    expect(conversation(after).some((i) => i.kind === 'notice')).toBe(true)
    // Not eligible: the database hasn't changed since, and a day hasn't passed.
    expect(await ask(core, { type: 'repairScan', homes: [home] })).toEqual([])
    writeFileSync(dbFiles(home)[1], 'wal')
    expect(await ask(core, { type: 'repairScan', homes: [home] })).toEqual([{ home, sessionId: sid }])
    const good = join(home, 'good.json')
    writeFileSync(good, JSON.stringify({ info: { ...SHELL.info, id: sid }, messages: SHELL.messages }))
    await ask(core, { type: 'export', home, sessionId: sid, reason: 'repair', command: { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(good)}))`], env: childEnv() } })
    await ask(core, { type: 'idle' })
    const fixed = readFileSync(mirrorPath(home, sid), 'utf8')
    expect(mirrorState(fixed)).toMatchObject({ header: { state: 'complete', source: 'export' }, status: null })
    expect(existsSync(statePath(home, sid))).toBe(false)
    expect(await ask(core, { type: 'repairScan', homes: [home] })).toEqual([])
  })

  it('keeps a failed refresh of a too-large session as a notice on the last good mirror', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core } = await started(srv, home)
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    const good = readFileSync(mirrorPath(home, srv.info.id), 'utf8')
    await ask(core, { type: 'bounds', bounds: { maxBytes: 100 } })
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    const after = readFileSync(mirrorPath(home, srv.info.id), 'utf8')
    expect(withoutStatus(after)).toBe(good)
    expect(mirrorState(after).status?.problem).toBe('size')
  })

  it('publishes nothing into a removed account', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core } = await started(srv, home)
    await ask(core, { type: 'removeRoot', home })
    await ask(core, { type: 'refresh', runId: 'run1', force: true })
    await ask(core, { type: 'idle' })
    expect(existsSync(mirrorPath(home, srv.info.id))).toBe(false)
  })

  it('holds its queue to its bound when every queued job is live work, leaving refreshes to their next poll and run-end exports to repair', async () => {
    const home = tempDir('cw-oc-hist-')
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const events: CoreEvent[] = []
    const core = newCore(server({ onWatermark: () => gate }), events)
    await ask(core, { type: 'bounds', bounds: { maxPending: 3, refreshes: 1 } })
    // Six live runs on sessions of their own: one reads (held), three wait, the rest don't fit.
    const ids = Array.from({ length: 6 }, (_, i) => `ses_q${String(i).padStart(25, '0')}`)
    for (const [i, sid] of ids.entries()) {
      await ask(core, { type: 'begin', home, sessionId: sid, runId: `r${i}` })
      await ask(core, { type: 'server', runId: `r${i}`, url: 'http://127.0.0.1:1', password: 'pw' })
    }
    const queued = []
    for (let i = 0; i < 6; i++) queued.push(await ask(core, { type: 'refresh', runId: `r${i}`, force: true }))
    expect(core.pending).toBeLessThanOrEqual(3)
    expect(queued.filter((q) => q === false).length).toBe(2)
    // A session with no live run whose run-end export doesn't fit: kept for the repair pass, not queued.
    const ended = 'ses_endedendedendedendedende'
    expect(await ask(core, { type: 'export', home, sessionId: ended, reason: 'runEnd', command: { file: process.execPath, args: ['-e', ''], env: {} } })).toBe(false)
    expect(core.pending).toBeLessThanOrEqual(3)
    expect(JSON.parse(readFileSync(statePath(home, ended), 'utf8'))).toEqual({ pending: true })
    writeFileSync(mirrorPath(home, ended), buildMirror({ w: 1, epoch: 0, source: 'api' }, SHELL.info, SHELL.messages))
    expect(await ask(core, { type: 'repairScan', homes: [home] })).toContainEqual({ home, sessionId: ended })
    release()
    await ask(core, { type: 'idle' })
  })

  it('answers a limits read with its run and epoch; null is none', async () => {
    const home = tempDir('cw-oc-hist-')
    const srv = server()
    const { core, events } = await started(srv, home)
    await ask(core, { type: 'limits', runId: 'run1' })
    await ask(core, { type: 'idle' })
    expect(events.find((e) => e.event === 'limits')).toMatchObject({ runId: 'run1', reading: { kind: 'none' } })
  })
})

// ---- The main side: limits and live cost per run (in-process worker)

describe("the OpenCode history's main side (HI-2762)", () => {
  async function history(): Promise<{ h: OpencodeHistory; limits: [string, unknown][]; costs: [string, number][] }> {
    const h = await historyWorkerForTests('in-process')
    const limits: [string, unknown][] = []
    const costs: [string, number][] = []
    h.start({ limits: (runId, u) => limits.push([runId, u]), cost: (runId, c) => costs.push([runId, c]), executable: () => null, homes: () => [], command: async () => ({ file: '', args: [], env: {} }) })
    return { h, limits, costs }
  }

  it("never shows an older live cost after a newer one, nor a mirror's older cost after a newer live one", async () => {
    const { h, costs } = await history()
    const home = tempDir('cw-oc-main-')
    const dir = tempDir('cw-oc-run-')
    await h.begin(home, 'ses_cccccccccccccccccccccccccc', 'runA')
    h.track('runA', dir, 'pw')
    // No server yet: a nudge for an unknown server does nothing.
    h.nudge('ses_cccccccccccccccccccccccccc', { kind: 'usage', cost: 1, at: 100 })
    expect(costs).toEqual([])
    writeFileSync(serverInfoPath(dir), JSON.stringify({ url: 'http://127.0.0.1:1', sessionId: 'ses_cccccccccccccccccccccccccc' }))
    await (h as any).poll((h as any).runs.get('runA'))
    h.nudge('ses_cccccccccccccccccccccccccc', { kind: 'usage', cost: 2, at: 200 })
    h.nudge('ses_cccccccccccccccccccccccccc', { kind: 'usage', cost: 1, at: 150 })
    ;(h as any).onEvent({ event: 'published', home, sessionId: 'ses_cccccccccccccccccccccccccc', source: 'api', updated: 180, cost: 1.5 })
    expect(costs).toEqual([['runA', 2]])
    ;(h as any).onEvent({ event: 'published', home, sessionId: 'ses_cccccccccccccccccccccccccc', source: 'api', updated: 250, cost: 3 })
    expect(costs).toEqual([['runA', 2], ['runA', 3]])
    await h.stop()
  })

  it("passes on a current run's limits, clears on none, and drops a late answer from a run that ended or moved on (never a clear)", async () => {
    const { h, limits } = await history()
    const home = tempDir('cw-oc-main-')
    await h.begin(home, 'ses_dddddddddddddddddddddddddd', 'runA')
    await h.begin(home, 'ses_eeeeeeeeeeeeeeeeeeeeeeeeee', 'runB')
    const usage = { provider: 'opencode', plan: null, limits: [], updatedAt: 'x' }
    const epochA = (h as any).runs.get('runA').epoch
    ;(h as any).onEvent({ event: 'limits', runId: 'runA', epoch: epochA, reading: { kind: 'report', usage } })
    ;(h as any).onEvent({ event: 'limits', runId: 'runB', epoch: (h as any).runs.get('runB').epoch, reading: { kind: 'none' } })
    expect(limits).toEqual([['runA', usage], ['runB', null]])
    // runA moves to another connection (a new run): its old run's late answer is dropped; runB, still on the old connection, keeps its own.
    await h.ended('runA')
    ;(h as any).onEvent({ event: 'limits', runId: 'runA', epoch: epochA, reading: { kind: 'none' } })
    ;(h as any).onEvent({ event: 'limits', runId: 'runB', epoch: (h as any).runs.get('runB').epoch - 1, reading: { kind: 'none' } })
    expect(limits).toHaveLength(2)
    await h.stop()
  })

  it('runs its core in a thread of its own once built (the worker answers begin, repair and shutdown)', async () => {
    const { build } = await import('esbuild')
    const out = join(tempDir('cw-oc-worker-'), 'opencode-history-worker.cjs')
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'opencodeHistoryWorker.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
    const h = await historyWorkerForTests(out)
    const home = tempDir('cw-oc-main-')
    mkdirSync(join(home, 'combwork-sessions'), { recursive: true })
    writeFileSync(mirrorPath(home, 'ses_gggggggggggggggggggggggggg'), placeholderMirror())
    await h.begin(home, 'ses_hhhhhhhhhhhhhhhhhhhhhhhhhh', 'runW')
    expect(await h.ask({ type: 'repairScan', homes: [home] })).toEqual([{ home, sessionId: 'ses_gggggggggggggggggggggggggg' }])
    expect((h as any).thread.worker).toBeTruthy()
    await h.stop()
    await historyWorkerForTests(null)
  }, 60_000)

  it('gives a stable mirror path from the first answer: a placeholder until a read completes', async () => {
    const { h } = await history()
    const home = tempDir('cw-oc-main-')
    const p = await h.mirrorFor(home, 'ses_ffffffffffffffffffffffffff')
    expect(mirrorState(readFileSync(p, 'utf8')).header?.state).toBe('placeholder')
    // Asked again (or after a read published), the same path, and the content isn't touched.
    writeFileSync(p, mirrorOf(SHELL))
    expect(await h.mirrorFor(home, 'ses_ffffffffffffffffffffffffff')).toBe(p)
    expect(mirrorState(readFileSync(p, 'utf8')).header?.state).toBe('complete')
    await h.stop()
  })
})

describe("the history's reads of an agent's server (HI-2762, #1582)", () => {
  it('reads only a server on this PC, refuses an encoded answer and stops at its size bound', async () => {
    const http = await import('http')
    const srv = http.createServer((q, res) => {
      if (q.url === '/br') {
        res.writeHead(200, { 'content-encoding': 'br' })
        return res.end('x')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ asked: q.headers['accept-encoding'], pad: 'x'.repeat(q.url === '/big' ? 5000 : 0) }))
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
    const signal = new AbortController().signal
    try {
      const ok = await plainLocalGet(`${base}/ok`, {}, signal, 1000)
      expect(JSON.parse(ok.body).asked).toBe('identity')
      await expect(plainLocalGet(`${base}/br`, {}, signal, 1000)).rejects.toMatchObject({ problem: 'parse' })
      await expect(plainLocalGet(`${base}/big`, {}, signal, 1000)).rejects.toMatchObject({ problem: 'size' })
      await expect(plainLocalGet('http://example.com/', {}, signal, 1000)).rejects.toMatchObject({ problem: 'timeout' })
      await expect(plainLocalGet('https://127.0.0.1/', {}, signal, 1000)).rejects.toMatchObject({ problem: 'timeout' })
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })
})

describe("the history's ownership across a removal and a new worker (HI-2762, HR1 round 1)", () => {
  it("answers an account's removal only once its export there has ended, and publishes nothing into it after", async () => {
    const home = tempDir('cw-oc-rm-')
    const sid = 'ses_rmrmrmrmrmrmrmrmrmrmrmrmrm'
    const events: CoreEvent[] = []
    const killed: number[] = []
    const core = new HistoryCore((e) => events.push(e), { get: async () => ({ status: 404, body: '{}' }), spawn: (f, a, o) => require('child_process').spawn(f, a, { env: o.env, cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), endTree: (c) => (killed.push(c.pid ?? 0), c.kill()), now: () => Date.now() })
    const begun = join(home, 'started.txt')
    const good = join(home, 'good.json')
    writeFileSync(good, JSON.stringify({ info: { ...SHELL.info, id: sid }, messages: SHELL.messages }))
    // An export that writes its output only after a while: removed meanwhile, it is ended, and nothing is published.
    const script = `require('fs').writeFileSync(${JSON.stringify(begun)}, 'x'); setTimeout(() => process.stdout.write(require('fs').readFileSync(${JSON.stringify(good)})), 20000)`
    await ask(core, { type: 'export', home, sessionId: sid, reason: 'runEnd', command: { file: process.execPath, args: ['-e', script], env: childEnv() } })
    for (let i = 0; i < 2000 && !existsSync(begun); i++) await new Promise((r) => setTimeout(r, 5))
    expect(existsSync(begun)).toBe(true)
    let acked = false
    const removal = ask(core, { type: 'removeRoot', home }).then(() => (acked = true))
    await removal
    expect(acked).toBe(true)
    expect(killed.length).toBe(1)
    await ask(core, { type: 'idle' })
    expect(existsSync(mirrorPath(home, sid))).toBe(false)
    // No temp file of the export's left in the folder.
    const dir = join(home, 'combwork-sessions')
    expect(existsSync(dir) ? require('fs').readdirSync(dir).filter((n: string) => n.includes('.export-')) : []).toEqual([])
    // Taken back (a removal refused later), the root's sessions are read again.
    await ask(core, { type: 'restoreRoot', home })
    await ask(core, { type: 'export', home, sessionId: sid, reason: 'repair', command: { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(good)}))`], env: childEnv() } })
    await ask(core, { type: 'idle' })
    expect(mirrorState(readFileSync(mirrorPath(home, sid), 'utf8')).header?.state).toBe('complete')
  })

  it('refuses a removal the worker never answers (main side): no undo is given, so the account stays', async () => {
    const h = await historyWorkerForTests('in-process')
    ;(h as any).thread.ask = () => new Promise((_, no) => setTimeout(() => no(new Error("the OpenCode history's worker didn't answer removeRoot in 5000 ms")), 10))
    await expect(h.removeRoot(tempDir('cw-oc-rm-'))).rejects.toThrow(/didn't answer removeRoot/)
    expect((h as any).removedHomes.size).toBe(0)
  })

  it('gives a new worker its live runs again after the last one ended: it publishes again, and the old epoch counts for nothing', async () => {
    const { build } = await import('esbuild')
    const out = join(tempDir('cw-oc-worker-'), 'opencode-history-worker.cjs')
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'opencodeHistoryWorker.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
    // An agent's server, as the fake's recordings answer: its session, its pages, its log's watermark.
    const srv = server({ info: { ...SHELL.info, id: 'ses_wkwkwkwkwkwkwkwkwkwkwkwkwk' } })
    const g = fakeGet(srv)
    const http = await import('http')
    const s = http.createServer(async (q, res) => {
      const r = await g(`http://127.0.0.1${q.url}`, { authorization: String(q.headers.authorization ?? '') })
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body)
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`
    const h = await historyWorkerForTests(out)
    const limits: [string, unknown][] = []
    h.start({ limits: (runId, u) => limits.push([runId, u]), cost: () => undefined, executable: () => null, homes: () => [], command: async () => ({ file: '', args: [], env: {} }) })
    try {
      const home = tempDir('cw-oc-wk-')
      const dir = tempDir('cw-oc-wkrun-')
      const sid = srv.info.id
      await h.begin(home, sid, 'runW')
      h.track('runW', dir, 'pw')
      writeFileSync(serverInfoPath(dir), JSON.stringify({ url, sessionId: sid }))
      const t = (h as any).runs.get('runW')
      await (h as any).poll(t)
      const mirror = mirrorPath(home, sid)
      const titleOf = () => (existsSync(mirror) ? parseMirrorUsage(readFileSync(mirror, 'utf8'), sid).title : null)
      for (let i = 0; i < 400 && titleOf() !== 'r0-shell-marker output'; i++) await new Promise((r) => setTimeout(r, 10))
      expect(titleOf()).toBe('r0-shell-marker output')
      const oldEpoch = t.epoch
      // The worker ends (a crash): the next one gets the run again, with a new epoch, before any poll.
      const w = (h as any).thread.worker
      await w.terminate()
      for (let i = 0; i < 400 && (t.epoch === oldEpoch || !(h as any).thread.worker); i++) await new Promise((r) => setTimeout(r, 10))
      expect(t.epoch).not.toBe(oldEpoch)
      expect((h as any).thread.worker).not.toBe(w)
      // The session changes: a turn's end reads it, and the new worker publishes it.
      srv.info = { ...srv.info, title: 'after the restart', time: { ...srv.info.time, updated: srv.info.time.updated + 1000 } }
      srv.w++
      h.nudge(sid, { kind: 'turnEnd' })
      for (let i = 0; i < 400 && titleOf() !== 'after the restart'; i++) await new Promise((r) => setTimeout(r, 10))
      expect(titleOf()).toBe('after the restart')
      // A limits answer of the old epoch counts for nothing.
      const before = limits.length
      ;(h as any).onEvent({ event: 'limits', runId: 'runW', epoch: oldEpoch, reading: { kind: 'none' } })
      expect(limits.length).toBe(before)
    } finally {
      await h.stop()
      await historyWorkerForTests(null)
      await new Promise((r) => s.close(r))
    }
  }, 60_000)
})

describe("a refused removal gives the root back (HI-2762, HR1 round 2)", () => {
  it('a removal whose export outlives the answer is refused, and the account, kept, publishes again once the export has ended', async () => {
    // An export that ends only when the test lets it: the worker marks the root, waits for it past removeRoot's deadline.
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const deps = {
      get: async () => ({ status: 404, body: '{}' }),
      spawn: (f: string, a: string[], o: { env: Record<string, string>; cwd?: string }) => require('child_process').spawn(f, a, { env: o.env, cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
      endTree: (c: any) => void gate.then(() => c.kill()),
      now: () => Date.now()
    }
    const h = await historyWorkerForTests('in-process', deps)
    h.removeAckMs = 30
    const home = tempDir('cw-oc-rmlate-')
    const sid = 'ses_lateLATElateLATElateLATEla'
    const begun = join(home, 'started.txt')
    const good = join(home, 'good.json')
    writeFileSync(good, JSON.stringify({ info: { ...SHELL.info, id: sid }, messages: SHELL.messages }))
    await h.ask({ type: 'export', home, sessionId: sid, reason: 'runEnd', command: { file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(begun)}, 'x'); setTimeout(() => {}, 60000)`], env: childEnv() } })
    for (let i = 0; i < 2000 && !existsSync(begun); i++) await new Promise((r) => setTimeout(r, 5))
    expect(existsSync(begun)).toBe(true)
    await expect(h.removeRoot(home)).rejects.toThrow(/didn't answer removeRoot/)
    expect((h as any).removedHomes.size).toBe(0)
    // The export is ended now; the removal's late answer changes nothing: the root is the kept account's again.
    release()
    await h.idle()
    expect(existsSync(mirrorPath(home, sid))).toBe(false)
    await h.ask({ type: 'export', home, sessionId: sid, reason: 'repair', command: { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(good)}))`], env: childEnv() } })
    await h.idle()
    expect(mirrorState(readFileSync(mirrorPath(home, sid), 'utf8')).header?.state).toBe('complete')
    await h.stop()
    await historyWorkerForTests(null)
  }, 30_000)
})

// ---- Subagents (HI-2773): HI-2773's R0, a `subagent` tool call on 2.2.6 (messages/subagent-*.json)

const SUB_LIST: any[] = fixture('wire/session-list-subagent.json').body.data
const PARENT = { info: SUB_LIST.find((s) => !s.parentID), messages: recorded('messages/subagent-parent.json') }
const CHILD = { info: SUB_LIST.find((s) => s.parentID), messages: recorded('messages/subagent-child.json') }

/** A server with several sessions, as 2.2.6 answers each (one page each). */
function multiGet(sessions: Record<string, { info: any; messages: any[]; w: number }>, reads: string[]) {
  return async (url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> => {
    const u = new URL(url)
    if (headers.authorization !== 'Basic ' + Buffer.from('opencode:pw').toString('base64')) return { status: 401, body: '{}' }
    reads.push(u.pathname)
    const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) })
    const m = /^\/api(?:\/experimental)?\/session\/([^/]+)(\/message|\/log)?$/.exec(u.pathname)
    const s = m && sessions[m[1]]
    if (!s) return { status: 404, body: '{}' }
    if (m[2] === '/log') return { status: 200, body: `data: ${JSON.stringify({ type: 'log.synced', aggregateID: m[1], seq: s.w })}\n\n` }
    if (m[2] === '/message') return json({ data: [...s.messages].reverse(), cursor: { previous: 'p', next: 'n' } })
    return json({ data: s.info })
  }
}

function subCore(sessions: Record<string, { info: any; messages: any[]; w: number }>, reads: string[] = [], events: CoreEvent[] = []): HistoryCore {
  const g = multiGet(sessions, reads)
  return new HistoryCore((e) => events.push(e), { get: (url, headers) => g(url, headers), spawn: (f, a, o) => require('child_process').spawn(f, a, { env: o.env, cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), endTree: (c) => c.kill(), now: () => Date.now() })
}

/** An export command printing a recorded export (or any text). */
function printing(home: string, name: string, text: string): { file: string; args: string[]; env: Record<string, string> } {
  const f = join(home, name)
  writeFileSync(f, text)
  return { file: process.execPath, args: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(f)}))`], env: childEnv() }
}

describe("OpenCode's subagent sessions (HI-2773)", () => {
  it("finds a subagent's session from the tool part that started it, never from the tool's name", () => {
    const found = subagentSessions(PARENT.info.id, PARENT.messages)
    expect([...found.keys()]).toEqual([CHILD.info.id])
    expect(found.get(CHILD.info.id)).toBe(1794216071948)
    // A part naming its own session, or not an id, is no subagent's.
    expect(subagentSessions(CHILD.info.id, PARENT.messages.map((m) => JSON.parse(JSON.stringify(m).replaceAll(CHILD.info.id, 'not an id'))))).toEqual(new Map())
    expect(subagentSessions(CHILD.info.id, CHILD.messages)).toEqual(new Map())
  })

  it("counts each session's tokens once: a parent's info leaves its subagent's out, as stats --json adds both", () => {
    const parent = parseMirrorUsage(buildMirror({ w: 1 }, PARENT.info, PARENT.messages), PARENT.info.id)
    const child = parseMirrorUsage(buildMirror({ w: 1 }, CHILD.info, CHILD.messages), CHILD.info.id)
    expect(parent.inputTokens).toBe(7694)
    expect(child.inputTokens).toBe(1196)
    expect(child.requests).toBe(1)
    expect(child.title).toBe('Test subagent response')
    // stats --json counts the steps of both (8394 input): the parent's two and the subagent's one, its title apart.
    const stats = JSON.parse(cliStdout('cli/stats-json-subagent.txt'))
    expect(stats.subagents).toBe(1)
    const steps = (x: { messages: any[] }) => x.messages.filter((m) => m.type === 'assistant').reduce((n, m) => n + m.tokens.input, 0)
    expect(steps(PARENT) + steps(CHILD)).toBe(stats.tokens.input)
  })

  it("says in a subagent's mirror's first line whose it is and where it ran; a parent's says neither", () => {
    expect(mirrorState(buildMirror({ w: 1 }, CHILD.info, CHILD.messages)).header).toMatchObject({ parent: PARENT.info.id, directory: '<root>\\project' })
    const h = mirrorState(buildMirror({ w: 1 }, PARENT.info, PARENT.messages)).header!
    expect('parent' in h || 'directory' in h).toBe(false)
    // The subagent's conversation: the prompt OpenCode gave it, its reasoning and reply.
    const items = conversation(buildMirror({ w: 1 }, CHILD.info, CHILD.messages))
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'assistant'])
    expect(items.find((i) => i.kind === 'assistant')).toMatchObject({ text: 'PONG' })
  })

  it("mirrors a live run's subagent from its server once the parent's read names it, and polls it only while it runs", async () => {
    const home = tempDir('cw-oc-sub-')
    const reads: string[] = []
    const running = { ...CHILD.info, time: { ...CHILD.info.time, idle: undefined } }
    const sessions = { [PARENT.info.id]: { ...PARENT, w: 20 }, [CHILD.info.id]: { info: running, messages: CHILD.messages, w: 12 } }
    const core = subCore(sessions, reads)
    await ask(core, { type: 'begin', home, sessionId: PARENT.info.id, runId: 'r1' })
    await ask(core, { type: 'server', runId: 'r1', url: 'http://127.0.0.1:1', password: 'pw' })
    await ask(core, { type: 'refresh', runId: 'r1', force: true })
    await ask(core, { type: 'idle' })
    const text = readFileSync(mirrorPath(home, CHILD.info.id), 'utf8')
    expect(mirrorState(text).header).toMatchObject({ state: 'complete', source: 'api', parent: PARENT.info.id })
    expect(parseMirrorUsage(text, CHILD.info.id).inputTokens).toBe(1196)
    // Still running: the parent's poll checks it too (one read of its info), though the parent is unchanged.
    reads.length = 0
    await ask(core, { type: 'refresh', runId: 'r1' })
    await ask(core, { type: 'idle' })
    expect(reads.sort()).toEqual([`/api/session/${CHILD.info.id}`, `/api/session/${PARENT.info.id}`].sort())
    // Done (its info says idle): read once more as it changed, then no longer polled.
    sessions[CHILD.info.id].info = CHILD.info
    await ask(core, { type: 'refresh', runId: 'r1' })
    await ask(core, { type: 'idle' })
    reads.length = 0
    await ask(core, { type: 'refresh', runId: 'r1' })
    await ask(core, { type: 'idle' })
    expect(reads).toEqual([`/api/session/${PARENT.info.id}`])
  })

  it("never publishes a session as a subagent's unless its info names that parent", async () => {
    const home = tempDir('cw-oc-sub-')
    const events: CoreEvent[] = []
    const sessions = { [PARENT.info.id]: { ...PARENT, w: 20 }, [CHILD.info.id]: { info: { ...CHILD.info, parentID: 'ses_someoneElseEntirely000' }, messages: CHILD.messages, w: 12 } }
    const core = subCore(sessions, [], events)
    await ask(core, { type: 'begin', home, sessionId: PARENT.info.id, runId: 'r1' })
    await ask(core, { type: 'server', runId: 'r1', url: 'http://127.0.0.1:1', password: 'pw' })
    await ask(core, { type: 'refresh', runId: 'r1', force: true })
    await ask(core, { type: 'idle' })
    expect(existsSync(mirrorPath(home, PARENT.info.id))).toBe(true)
    expect(existsSync(mirrorPath(home, CHILD.info.id))).toBe(false)
    expect(events.some((e) => e.event === 'log' && /didn't name the session that started it/.test(e.text))).toBe(true)
  })

  it("owns a subagent's session with its parent's run: no export while it lives; after it, exported only when older than its newest start", async () => {
    const home = tempDir('cw-oc-sub-')
    const events: CoreEvent[] = []
    const sessions = { [PARENT.info.id]: { ...PARENT, w: 20 }, [CHILD.info.id]: { ...CHILD, w: 12 } }
    const core = subCore(sessions, [], events)
    await ask(core, { type: 'begin', home, sessionId: PARENT.info.id, runId: 'r1' })
    await ask(core, { type: 'server', runId: 'r1', url: 'http://127.0.0.1:1', password: 'pw' })
    await ask(core, { type: 'refresh', runId: 'r1', force: true })
    await ask(core, { type: 'idle' })
    const childExport = printing(home, 'child.json', cliStdout('cli/session-export-subagent.txt'))
    // The parent's run is the subagent's owner: an export of it is refused while the run lives.
    expect(await ask(core, { type: 'export', home, sessionId: CHILD.info.id, reason: 'repair', command: childExport })).toBe(false)
    await ask(core, { type: 'end', runId: 'r1' })
    // The parent's run-end export: its subagent's mirror is as new as its start, so it isn't exported again.
    await ask(core, { type: 'export', home, sessionId: PARENT.info.id, reason: 'runEnd', command: printing(home, 'parent.json', cliStdout('cli/session-export-subagent-parent.txt')) })
    await ask(core, { type: 'idle' })
    expect(events.filter((e) => e.event === 'children')).toEqual([])
    // A subagent with no mirror (the run's reads missed it): main is told to export it, for the parent's reason.
    const fresh = tempDir('cw-oc-sub-')
    await ask(core, { type: 'export', home: fresh, sessionId: PARENT.info.id, reason: 'runEnd', command: printing(fresh, 'parent.json', cliStdout('cli/session-export-subagent-parent.txt')) })
    await ask(core, { type: 'idle' })
    expect(events.filter((e) => e.event === 'children')).toEqual([{ event: 'children', home: fresh, sessionId: PARENT.info.id, children: [CHILD.info.id], reason: 'runEnd' }])
    await ask(core, { type: 'export', home: fresh, sessionId: CHILD.info.id, reason: 'runEnd', command: printing(fresh, 'child.json', cliStdout('cli/session-export-subagent.txt')) })
    await ask(core, { type: 'idle' })
    const text = readFileSync(mirrorPath(fresh, CHILD.info.id), 'utf8')
    expect(mirrorState(text).header).toMatchObject({ state: 'complete', source: 'export', parent: PARENT.info.id })
    // A new run on the parent takes its subagent's session again.
    await ask(core, { type: 'begin', home, sessionId: PARENT.info.id, runId: 'r2' })
    await ask(core, { type: 'server', runId: 'r2', url: 'http://127.0.0.1:1', password: 'pw' })
    await ask(core, { type: 'refresh', runId: 'r2', force: true })
    await ask(core, { type: 'idle' })
    expect(await ask(core, { type: 'export', home, sessionId: CHILD.info.id, reason: 'repair', command: childExport })).toBe(false)
  })

  it("exports an exported session's subagents through main, each in turn", async () => {
    const asked: string[][] = []
    const h = await historyWorkerForTests('in-process')
    const home = tempDir('cw-oc-sub-main-')
    h.start({ limits: () => undefined, cost: () => undefined, executable: () => process.execPath, homes: () => [], command: async (_exe, args) => {
      asked.push(args)
      const text = args[2] === CHILD.info.id ? cliStdout('cli/session-export-subagent.txt') : cliStdout('cli/session-export-subagent-parent.txt')
      return printing(home, `${args[2]}.json`, text)
    } })
    await (h as any).exportSession(home, PARENT.info.id, 'runEnd')
    for (let i = 0; i < 400 && !existsSync(mirrorPath(home, CHILD.info.id)); i++) {
      await h.idle()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(asked).toEqual([['session', 'export', PARENT.info.id], ['session', 'export', CHILD.info.id]])
    expect(mirrorState(readFileSync(mirrorPath(home, CHILD.info.id), 'utf8')).header?.parent).toBe(PARENT.info.id)
    await h.stop()
    await historyWorkerForTests(null)
  }, 30_000)
})
