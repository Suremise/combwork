import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CopilotConversationParser, CopilotUsageParser, copilotDetailsMemo, copilotEventsPath, eventsDetails, listCopilotSessions, parseEvents, readWorkspace, signInRefused, WorkspaceCache, workspaceInfo, type CopilotDetailsMemo } from '../src/main/providers/copilot/events'
import { withDayCosts } from '../src/shared/usageDays'
import type { TranscriptItem } from '../src/shared/types'
import { tempDir } from './tempDir'

// Two real sessions from the #403 spike (Copilot CLI 1.0.93), scrubbed: paths under C:\work, the system prompt, hook
// inputs and the CLI's utility-model calls trimmed. REAL ran on Copilot Free (Auto picked mai-code-1.1-flash): three
// prompts, a hive MCP call and a file created, with credits. STUB ran offline against a scripted model (no credits): a
// command, a question, an exit and a resume, then a permission prompt cancelled by an interrupt.
// When a new CLI version changes the format, add its sessions here.
const HOME = join(__dirname, 'fixtures', 'copilot')
const REAL = '5cb5a219-ee72-49a3-b871-cc0c05d27269'
const STUB = '0cb916db-26aa-40f2-86b5-1ba81b225fd2'
const events = (id: string): string => readFileSync(copilotEventsPath(HOME, id), 'utf8')
const line = (type: string, timestamp: string, data: Record<string, unknown>): string => JSON.stringify({ type, data, timestamp }) + '\n'
/** Prices of the user's own for the fixtures' models, which an estimate would use. */
const PRICED = { providers: { copilot: { prices: { 'gpt-4.1': { input: 10, cachedInput: 1, output: 20 }, 'mai-code-1.1-flash': { input: 100, cachedInput: 100, output: 100 } } } } } as never

function conversation(id: string, root: string | null): TranscriptItem[] {
  const p = new CopilotConversationParser(root)
  p.feed(Buffer.from(events(id)))
  return p.items
}

describe('Copilot usage', () => {
  it('reads a real session: version, model, prompts, requests, credits, tokens and the context', () => {
    const u = parseEvents(events(REAL), REAL, 'Respond With OK')
    expect(u.provider).toBe('copilot')
    expect(u.title).toBe('Respond With OK')
    expect(u.cliVersion).toBe('1.0.93')
    // Auto's choice, not "auto", and not the small models the CLI uses for itself (model.* events).
    expect(u.model).toBe('mai-code-1.1-flash')
    expect(u.userMessages).toBe(3)
    expect(u.lastPrompt).toBe('Create a file hello.txt containing the single word hi.')
    // One request per model call: the CLI's own count at exit says 5 too.
    expect(u.requests).toBe(5)
    // 513,464,000 nano-AIU = 0.51 AI credits = $0.0051.
    expect(u.costUsd).toBeCloseTo(0.00513464, 8)
    expect(u.costEstimated).toBe(false)
    // The CLI's input counts the cache: 92,224 in all, 74,752 of them read from it.
    expect(u.inputTokens).toBe(17472)
    expect(u.cacheReadTokens).toBe(74752)
    expect(u.cacheWriteTokens).toBe(0)
    expect(u.outputTokens).toBe(121)
    // The last checkpoint's prompt, and the cache's lifetime.
    expect(u.contextTokens).toBe(18629)
    expect(u.cacheTtlSeconds).toBe(1800)
    expect(u.firstActivity).toBe('2026-10-08T21:23:50.152Z')
    expect(u.lastActivity).toBe('2026-10-08T21:25:30.385Z')
  })

  it('puts each day’s charges on it, never an estimate', () => {
    const u = withDayCosts(parseEvents(events(REAL), REAL), { providers: { copilot: { prices: { 'mai-code-1.1-flash': { input: 100, cachedInput: 100, output: 100 } } } } } as never)
    const days = Object.values(u.days ?? {})
    expect(days).toHaveLength(1)
    expect(days[0].costUsd).toBeCloseTo(0.00513464, 8)
    expect(days[0].costEstimated).toBe(false)
    expect(days[0]).toMatchObject({ prompts: 3, requests: 5, inputTokens: 17472, cacheReadTokens: 74752, outputTokens: 121 })
    expect(u.costReports).toBeUndefined()
  })

  it('charges a running session before it exits (no tokens yet)', () => {
    const lines = events(REAL).split('\n')
    const shutdown = lines.findIndex((l) => l.includes('"type":"session.shutdown"'))
    const u = withDayCosts(parseEvents(lines.slice(0, shutdown).join('\n') + '\n', REAL))
    expect(u.costUsd).toBeCloseTo(0.00513464, 8)
    expect(u.inputTokens + u.outputTokens).toBe(0)
    expect(Object.values(u.days ?? {})[0].costUsd).toBeCloseTo(0.00513464, 8)
  })

  it('counts a resumed session once: its exit totals include the earlier launch', () => {
    const u = parseEvents(events(STUB), STUB)
    expect(u.model).toBe('gpt-4.1')
    expect(u.userMessages).toBe(4)
    expect(u.requests).toBe(7)
    expect(u.inputTokens).toBe(8638 - 7000)
    expect(u.cacheReadTokens).toBe(7000)
    expect(u.outputTokens).toBe(392)
    // Offline (a model of the user's own): no credits, and the context from the CLI's own count at exit.
    expect(u.costUsd).toBe(0)
    expect(u.contextTokens).toBe(13547)
    const days = Object.values(u.days ?? {})
    expect(days.reduce((n, d) => n + d.inputTokens, 0)).toBe(u.inputTokens)
    expect(days.reduce((n, d) => n + d.outputTokens, 0)).toBe(u.outputTokens)
  })

  it('reads a piece at a time with the same result', () => {
    const text = events(STUB)
    const cut = text.indexOf('{"type":"session.resume"')
    const p = new CopilotUsageParser(STUB)
    p.feed(text.slice(0, cut))
    const before = p.result()
    expect(before.requests).toBe(4)
    expect(before.inputTokens).toBe(4936 - 4000)
    p.feed(text.slice(cut))
    expect(p.result()).toEqual(parseEvents(text, STUB))
  })

  it('takes a reported 0 as the cost, never an estimate (a model of the user’s own)', () => {
    const u = withDayCosts(parseEvents(events(STUB), STUB), PRICED)
    expect(u.costUsd).toBe(0)
    const days = Object.values(u.days ?? {})
    expect(days.length).toBeGreaterThan(0)
    for (const d of days) expect(d).toMatchObject({ costUsd: 0, costEstimated: false })
  })

  it('estimates only when the CLI reports no credits at all', () => {
    const text = line('user.message', '2026-10-08T12:00:00.000Z', { content: 'hi' }) + line('session.shutdown', '2026-10-08T12:05:00.000Z', { currentModel: 'gpt-4.1', modelMetrics: { 'gpt-4.1': { usage: { inputTokens: 100, outputTokens: 20 } } } })
    const u = withDayCosts(parseEvents(text, 's'), PRICED)
    expect(u.costUsd).toBeNull()
    expect(Object.values(u.days ?? {})[0]).toMatchObject({ costUsd: (100 * 10 + 20 * 20) / 1e6, costEstimated: true })
  })

  it('keeps a session’s days adding up to its cost when it exits or resumes on another day', () => {
    const tokens = (n: number) => ({ 'gpt-4.1': { usage: { inputTokens: 100 * n, outputTokens: 20 * n } } })
    const text =
      line('assistant.message', '2026-10-08T12:00:00.000Z', { model: 'gpt-4.1' }) +
      line('session.usage_checkpoint', '2026-10-08T12:00:01.000Z', { totalNanoAiu: 1e9, totalPremiumRequests: 1 }) +
      // The first launch exits the next day, with no new charge: its tokens are covered by the day before's.
      line('session.shutdown', '2026-10-09T12:00:00.000Z', { totalNanoAiu: 1e9, totalPremiumRequests: 1, modelMetrics: tokens(1) }) +
      line('session.resume', '2026-10-10T12:00:00.000Z', {}) +
      line('assistant.message', '2026-10-10T12:00:01.000Z', { model: 'gpt-4.1' }) +
      line('session.usage_checkpoint', '2026-10-10T12:00:02.000Z', { totalNanoAiu: 3e9, totalPremiumRequests: 3 }) +
      line('session.shutdown', '2026-10-10T12:05:00.000Z', { totalNanoAiu: 3e9, totalPremiumRequests: 3, modelMetrics: tokens(2) })
    const parsed = parseEvents(text, 's')
    // Running totals, not added up over the launches.
    expect(parsed.premiumRequests).toBe(3)
    const u = withDayCosts(parsed, PRICED)
    expect(u.costUsd).toBeCloseTo(0.03, 10)
    expect(u).toMatchObject({ inputTokens: 200, outputTokens: 40, requests: 2 })
    const days = Object.entries(u.days ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d)
    expect(days.map((d) => d.costUsd)).toEqual([expect.closeTo(0.01, 10), 0, expect.closeTo(0.02, 10)])
    expect(days.map((d) => d.costEstimated)).toEqual([false, false, false])
    expect(days.map((d) => d.inputTokens)).toEqual([0, 100, 100])
  })

  it('keeps the CLI’s premium requests apart from model calls, live and over a resume', () => {
    const text = events(REAL)
    const lines = text.split('\n')
    const first = lines.findIndex((l) => l.includes('"type":"session.usage_checkpoint"'))
    const p = new CopilotUsageParser(REAL)
    p.feed(lines.slice(0, first + 1).join('\n') + '\n')
    expect(p.result().premiumRequests).toBe(1)
    p.feed(lines.slice(first + 1).join('\n'))
    expect(p.result()).toMatchObject({ premiumRequests: 3, requests: 5 })
    expect((eventsDetails(text) as { premiumRequests?: number }).premiumRequests).toBe(3)
    // Offline: the CLI reports 0 premium requests.
    expect(parseEvents(events(STUB), STUB).premiumRequests).toBe(0)
    expect(parseEvents(line('user.message', '2026-10-08T12:00:00.000Z', { content: 'hi' }), 's').premiumRequests).toBeNull()
  })

  it('adds up the tokens of every model at exit', () => {
    const metrics = {
      'claude-sonnet-4.6': { requests: { count: 3 }, usage: { inputTokens: 5000, outputTokens: 300, cacheReadTokens: 3000, cacheWriteTokens: 1500, reasoningTokens: 120 } },
      'gpt-5-mini': { requests: { count: 2 }, usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0, reasoningTokens: 30 }, tokenDetails: { input: { tokenCount: 500 } } }
    }
    const u = parseEvents(line('session.shutdown', '2026-10-08T12:00:00.000Z', { totalNanoAiu: 0, modelMetrics: metrics, currentModel: 'claude-sonnet-4.6' }), 's')
    // The CLI's input counts the cache: the fresh part is what's left (or tokenDetails' input when it says).
    expect(u).toMatchObject({ inputTokens: 5000 - 3000 - 1500 + 500, cacheReadTokens: 3400, cacheWriteTokens: 1500, outputTokens: 350, reasoningTokens: 150, model: 'claude-sonnet-4.6' })
  })

  it('ignores lines it can’t read', () => {
    const u = parseEvents('not json\n{"type":"user.message"}\n{"type":"user.message","data":{"content":"hi"},"timestamp":"2026-10-08T10:00:00Z"}\n', 's')
    expect(u.userMessages).toBe(2)
    expect(u.lastPrompt).toBe('hi')
  })
})

describe('Copilot live details', () => {
  it('reports the model Auto picked, the effort and the credits so far', () => {
    const d = eventsDetails(events(REAL))
    expect(d.modelName).toBe('mai-code-1.1-flash')
    expect(d.modelId).toBe('mai-code-1.1-flash')
    expect(d.effort).toBe('medium')
    expect(d.costUsd).toBeCloseTo(0.00513464, 8)
    expect((d as { interruptedAt?: string }).interruptedAt).toBeUndefined()
  })

  it('reports when the user last interrupted a turn', () => {
    // STUB's permission prompt was cancelled by an interrupt (Esc): only the abort event says so.
    expect((eventsDetails(events(STUB)) as { interruptedAt?: string }).interruptedAt).toBe('2026-10-08T21:14:50.350Z')
    const two = '{"type":"abort","data":{"reason":"user_initiated"},"timestamp":"2026-10-08T10:00:00.000Z"}\n{"type":"abort","data":{"reason":"user_initiated"},"timestamp":"2026-10-08T11:00:00.000Z"}\n'
    expect((eventsDetails(two) as { interruptedAt?: string }).interruptedAt).toBe('2026-10-08T11:00:00.000Z')
  })

  // Esc on Copilot's "Path permission needed" prompt (Copilot CLI 1.0.93, #475): the denial, the tool's failure and the
  // turn's end, with no abort and no agentStop.
  const refusal = (at: string): string =>
    line('permission.requested', `${at}:01.000Z`, { toolCallId: 'call_1', permissionRequest: { kind: 'path' } }) +
    line('permission.completed', `${at}:02.000Z`, { toolCallId: 'call_1', result: { kind: 'denied-interactively-by-user' } }) +
    line('tool.execution_complete', `${at}:02.001Z`, { toolCallId: 'call_1', success: false, error: { message: 'Permission denied' } }) +
    line('assistant.turn_end', `${at}:02.002Z`, { turnId: '0' })
  const prompt = (at: string): string => line('hook.start', `${at}:00.000Z`, { hookType: 'userPromptSubmitted' }) + line('user.message', `${at}:00.001Z`, { content: 'write ../outside.txt' }) + line('assistant.turn_start', `${at}:00.002Z`, { turnId: '0' })
  const carriedOn = (at: string): string =>
    refusal(at) + line('assistant.turn_start', `${at}:02.003Z`, { turnId: '1' }) + line('assistant.message', `${at}:03.000Z`, { content: 'I can’t write there.' }) + line('assistant.turn_end', `${at}:03.001Z`, { turnId: '1' }) + line('hook.start', `${at}:03.002Z`, { hookType: 'agentStop' })
  const interrupted = (text: string, memo?: CopilotDetailsMemo): string | undefined => (eventsDetails(text, memo) as { interruptedAt?: string }).interruptedAt
  /**
   * The events read in two, as a launch's reads may split them, split after each of its lines in turn: what each read
   * reported, with the launch's memo.
   */
  const splits = (text: string): { at: number; first?: string; second?: string }[] => {
    const lines = text.split('\n').filter(Boolean)
    return lines.map((_, k) => {
      const memo = copilotDetailsMemo()
      const part = (from: number, to: number): string => lines.slice(from, to).map((l) => l + '\n').join('')
      return { at: k + 1, first: interrupted(part(0, k + 1), memo), second: interrupted(part(k + 1, lines.length), memo) }
    })
  }
  const REFUSED_END = '2026-10-09T10:00:02.002Z'

  it('reports a turn that ends on the user refusing a path prompt as interrupted', () => {
    expect(interrupted(prompt('2026-10-09T10:00') + refusal('2026-10-09T10:00'))).toBe(REFUSED_END)
    // However the reads split it: once, by the read its turn's end is in.
    for (const s of splits(prompt('2026-10-09T10:00') + refusal('2026-10-09T10:00'))) {
      expect([s.first, s.second].filter(Boolean), `split after line ${s.at}`).toEqual([REFUSED_END])
      expect(s.at < 7 ? s.second : s.first, `split after line ${s.at}`).toBe(REFUSED_END)
    }
    // An approved prompt isn't a refusal.
    expect(interrupted(refusal('2026-10-09T10:00').replace('denied-interactively-by-user', 'approved'))).toBeUndefined()
  })

  it('doesn’t count a refusal Copilot carries on from', () => {
    // Its next model call and the turn's Stop (agentStop): finished by the Stop hook, not interrupted.
    expect(interrupted(carriedOn('2026-10-09T10:00'))).toBeUndefined()
    // Split anywhere but between the refusal's end and the next call (a millisecond apart, so a read there is unlikely:
    // the agent shows ready until the Stop hook finishes it).
    for (const s of splits(carriedOn('2026-10-09T10:00'))) {
      expect(s.second, `split after line ${s.at}`).toBeUndefined()
      expect(s.first, `split after line ${s.at}`).toBe(s.at === 4 ? REFUSED_END : undefined)
    }
    // A refusal in an earlier model call of a turn that went on to its Stop isn't this turn's end.
    expect(interrupted(carriedOn('2026-10-09T10:00') + prompt('2026-10-09T10:05') + line('assistant.turn_end', '2026-10-09T10:05:01.000Z', { turnId: '0' }))).toBeUndefined()
  })

  it('leaves an interrupt the user’s next prompt follows as history', () => {
    // The prompt's own hook has already said the agent works again.
    expect(interrupted(refusal('2026-10-09T10:00') + prompt('2026-10-09T10:01'))).toBeUndefined()
    // Read in two: only a read that ends with the turn over, before the prompt, reports it (the agent was idle then).
    for (const s of splits(refusal('2026-10-09T10:00') + prompt('2026-10-09T10:01'))) {
      expect(s.second, `split after line ${s.at}`).toBeUndefined()
      expect(s.first, `split after line ${s.at}`).toBe(s.at === 4 ? REFUSED_END : undefined)
    }
    const abort = line('abort', '2026-10-09T10:00:00.000Z', { reason: 'user_initiated' })
    expect(interrupted(abort + prompt('2026-10-09T10:01'))).toBeUndefined()
    expect(interrupted(abort + prompt('2026-10-09T10:01') + refusal('2026-10-09T10:01'))).toBe('2026-10-09T10:01:02.002Z')
  })

  it('reads 1.0.105’s refusal, which an abort follows after the turn’s end, as interrupted however the reads split it (HI-1945)', () => {
    // Recorded with Copilot 1.0.105 (the copilot e2e suite's refused read): the denial, the tool's failure, the turn's end,
    // then abort (user_initiated). Interrupted at the turn's end, or at the abort once it is read.
    const text = readFileSync(join(HOME, 'refusal-1.0.105.jsonl'), 'utf8').replace(/\r\n/g, '\n')
    const types = text.trim().split('\n').map((l) => JSON.parse(l).type as string)
    expect(types.slice(-4)).toEqual(['permission.completed', 'tool.execution_complete', 'assistant.turn_end', 'abort'])
    const END = '2026-10-28T13:03:37.673Z'
    const ABORT = '2026-10-28T13:03:37.675Z'
    expect(interrupted(text)).toBe(ABORT)
    for (const s of splits(text)) {
      // The read with the abort reports it; split between the turn's end and the abort, the first read already reported the end.
      expect(s.second ?? s.first, `split after line ${s.at}`).toBe(ABORT)
      expect(s.first, `split after line ${s.at}`).toBe(s.at === types.length - 1 ? END : s.at === types.length ? ABORT : undefined)
    }
    // Followed by the next prompt, it is history.
    expect(interrupted(text + prompt('2026-10-28T13:04'))).toBeUndefined()
  })

  it('keeps each launch’s refusal to its own memo', () => {
    const lines = refusal('2026-10-09T10:00').split('\n').filter(Boolean)
    const a = copilotDetailsMemo()
    expect(interrupted(lines.slice(0, 2).map((l) => l + '\n').join(''), a)).toBeUndefined()
    // Another launch's turn end isn't the refused one's; the refused launch's is.
    expect(interrupted(lines.slice(2).map((l) => l + '\n').join(''), copilotDetailsMemo())).toBeUndefined()
    expect(interrupted(lines.slice(2).map((l) => l + '\n').join(''), a)).toBe(REFUSED_END)
    // Without a memo (a whole log read at once), nothing is kept.
    expect(interrupted(lines.slice(0, 2).map((l) => l + '\n').join(''))).toBeUndefined()
    expect(interrupted(lines.slice(2).map((l) => l + '\n').join(''))).toBeUndefined()
  })

  it('reports a refused sign-in until the agent carries on', () => {
    const err = '{"type":"session.error","data":{"errorType":"query","message":"Please use /login to sign in to use Copilot"},"timestamp":"2026-10-08T21:00:00.000Z"}\n'
    expect(eventsDetails(err)).toMatchObject({ signIn: 'Please use /login to sign in to use Copilot', signInAt: '2026-10-08T21:00:00.000Z' })
    const after = eventsDetails(err + '{"type":"assistant.message","data":{"content":"ok","model":"gpt-4.1"}}\n')
    expect(after.signIn).toBeUndefined()
    expect(after.signInAt).toBeUndefined()
    // Other errors aren't the sign-in (seen in the spike).
    expect(eventsDetails('{"type":"session.error","data":{"errorType":"query","message":"No response was returned. Send your message again to retry."}}\n').signIn).toBeUndefined()
    expect(signInRefused({ errorType: 'authentication', message: '' })).toBe('Copilot isn’t signed in.')
    expect(signInRefused(null)).toBeNull()
  })
})

describe('Copilot conversation', () => {
  it('shows a real session: prompts, replies, an MCP call and a file created', () => {
    const items = conversation(REAL, 'C:\\work\\ws2')
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'tool', 'assistant', 'user', 'tool', 'assistant'])
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Reply with only the word OK.', images: [] })
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'OK' })
    const mcp = items[3].kind === 'tool' ? items[3].tool : null
    expect(mcp).toMatchObject({ name: 'hive · hive_ping', result: 'pong MARKER-MCP-RESULT', isError: false })
    const write = items[6].kind === 'tool' ? items[6].tool : null
    expect(write).toMatchObject({ name: 'Write', summary: 'hello.txt', isError: false })
    expect(write?.input).toContain('file_text: hi')
    // The diff the CLI shows, rather than the line the model got.
    expect(write?.result).toContain('diff --git')
    expect(items.map((i) => i.id)).toEqual(items.map((_, n) => n))
  })

  it('shows a command, questions, a resume, a cancelled permission prompt and the interrupt', () => {
    const items = conversation(STUB, 'C:\\work\\ws1')
    const tools = items.flatMap((i) => (i.kind === 'tool' ? [i.tool] : []))
    expect(tools.map((t) => t.name)).toEqual(['PowerShell', 'Question', 'Question', 'PowerShell'])
    expect(tools[0]).toMatchObject({ summary: 'echo', input: 'echo stub-shell', isError: false })
    expect(tools[0].result).toContain('stub-shell')
    // A failed call shows the CLI's error.
    expect(tools[1]).toMatchObject({ isError: true, summary: 'Stub asks: pick one' })
    expect(tools[1].result).toMatch(/structured ask_user format/)
    expect(tools[2]).toMatchObject({ isError: false, result: 'User responded:\nchoice: a' })
    // Cancelled at its permission prompt by the interrupt: it never ran.
    expect(tools[3]).toMatchObject({ input: 'New-Item -Path stub-shell.txt -ItemType File', result: 'Cancelled: Session aborted', isError: true })
    const notices = items.flatMap((i) => (i.kind === 'notice' ? [i.text] : []))
    expect(notices).toEqual(['Session resumed', 'Interrupted by you'])
    expect(items[items.length - 1]).toMatchObject({ kind: 'notice', text: 'Interrupted by you', level: 'info' })
    expect(items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))).toEqual(['do:shell', 'do:ask', 'do:ask', 'do:shell'])
  })

  it('reads whole lines a piece at a time with the same items', () => {
    const buf = Buffer.from(events(STUB))
    const p = new CopilotConversationParser('C:\\work\\ws1')
    let at = 0
    // Pieces that end mid-line: the rest of a line is fed again with the next piece.
    for (let end = 777; at < buf.length; end = Math.min(buf.length, end + 777)) at += p.feed(buf.subarray(at, end))
    expect(p.offset).toBe(buf.length)
    expect(p.items).toEqual(conversation(STUB, 'C:\\work\\ws1'))
  })

  it('shows thinking, other errors and a tool known only from its start', () => {
    const lines = [
      { type: 'assistant.message', data: { reasoningText: 'Let me look.', content: '', toolRequests: [] } },
      { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'C:\\p\\src\\a.ts' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '1. x' } } },
      { type: 'session.error', data: { errorType: 'query', message: 'No response was returned.' } },
      { type: 'abort', data: { reason: 'timeout' } }
    ]
    const p = new CopilotConversationParser('C:\\p')
    p.feed(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'))
    expect(p.items.map((i) => i.kind)).toEqual(['thinking', 'tool', 'notice', 'notice'])
    expect(p.items[1]).toMatchObject({ tool: { name: 'Read', summary: 'src/a.ts', result: '1. x' } })
    expect(p.items[2]).toMatchObject({ text: 'No response was returned.', level: 'error' })
    expect(p.items[3]).toMatchObject({ text: 'Turn ended: timeout' })
  })
})

describe('Copilot sessions', () => {
  it('reads workspace.yaml', () => {
    expect(workspaceInfo(readFileSync(join(HOME, 'session-state', REAL, 'workspace.yaml'), 'utf8'))).toEqual({
      id: REAL,
      cwd: 'C:\\work\\ws2',
      gitRoot: 'C:\\work\\ws2',
      branch: 'master',
      name: 'Respond With OK',
      userNamed: false,
      createdAt: '2026-10-08T21:23:50.136Z',
      updatedAt: '2026-10-08T21:23:56.125Z'
    })
    // Quoted values, CRLF, and a session that has no name yet.
    const ws = workspaceInfo("id: x\r\ncwd: 'C:\\it''s'\r\nname: \"a: b\"\r\nuser_named: true\r\nlist:\r\n  - y\r\n")
    expect(ws).toMatchObject({ cwd: "C:\\it's", name: 'a: b', userNamed: true, branch: null })
    expect(workspaceInfo('id: x\ncwd: C:\\p\n')?.name).toBeNull()
    // Without its id or folder it isn't a session's.
    expect(workspaceInfo('id: x\n')).toBeNull()
    expect(workspaceInfo('')).toBeNull()
  })

  it('lists the sessions with a conversation for a folder', async () => {
    expect(await listCopilotSessions(HOME, 'C:\\work\\ws2')).toEqual([{ id: REAL, transcriptPath: copilotEventsPath(HOME, REAL), modified: expect.any(String), bytes: expect.any(Number), mtimeMs: expect.any(Number) }])
    // Ids the caller has are left out (HI-1681).
    expect(await listCopilotSessions(HOME, 'C:\\work\\ws2', (id) => id === REAL)).toEqual([])
    // The folder compares as Windows does.
    expect((await listCopilotSessions(HOME, 'c:\\WORK\\ws1\\')).map((s) => s.id)).toEqual([STUB])
    expect(await listCopilotSessions(HOME, 'C:\\work\\other')).toEqual([])
    expect(await readWorkspace(HOME, REAL)).toMatchObject({ name: 'Respond With OK' })
    expect(await readWorkspace(HOME, '..\\x')).toBeNull()
  })

  it('leaves out launches that ended before a prompt, and folders that aren’t sessions', async () => {
    const home = tempDir('hive-copilot-')
    const session = (id: string, text: string | null): void => {
      mkdirSync(join(home, 'session-state', id), { recursive: true })
      writeFileSync(join(home, 'session-state', id, 'workspace.yaml'), `id: ${id}\ncwd: C:\\work\\p\n`)
      if (text !== null) writeFileSync(join(home, 'session-state', id, 'events.jsonl'), text)
    }
    session('aaaaaaaa-0000-0000-0000-000000000001', null)
    session('aaaaaaaa-0000-0000-0000-000000000002', '')
    session('aaaaaaaa-0000-0000-0000-000000000003', '{"type":"session.start"}\n')
    writeFileSync(join(home, 'session-state', 'stray.txt'), 'x')
    expect((await listCopilotSessions(home, 'C:\\work\\p')).map((s) => s.id)).toEqual(['aaaaaaaa-0000-0000-0000-000000000003'])
    expect(await listCopilotSessions(join(home, 'missing'), 'C:\\work\\p')).toEqual([])
  })

  it('keeps a bounded cache of workspace.yaml that sees edits and deletions', async () => {
    const dir = tempDir('hive-copilot-ws-')
    const file = (n: number, name: string): string => {
      const p = join(dir, `${n}.yaml`)
      writeFileSync(p, `id: s${n}\ncwd: C:\\work\\p\nname: ${name}\n`)
      return p
    }
    const cache = new WorkspaceCache(2)
    const [a, b, c] = [file(1, 'one'), file(2, 'two'), file(3, 'three')]
    expect((await cache.read(a))?.name).toBe('one')
    expect((await cache.read(b))?.name).toBe('two')
    expect((await cache.read(a))?.name).toBe('one')
    expect((await cache.read(c))?.name).toBe('three')
    // b was the least recently used.
    expect(cache.size).toBe(2)
    // An edit is read again, even within the same modification time.
    const t = new Date('2026-10-08T12:00:00Z')
    utimesSync(a, t, t)
    expect((await cache.read(a))?.name).toBe('one')
    writeFileSync(a, 'id: s1\ncwd: C:\\work\\p\nname: renamed\n')
    utimesSync(a, t, t)
    expect((await cache.read(a))?.name).toBe('renamed')
    // A deleted file is no session, and leaves the cache.
    unlinkSync(c)
    expect(await cache.read(c)).toBeNull()
    expect(cache.size).toBe(1)
  })
})
