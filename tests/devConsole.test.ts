import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { createContext, runInContext } from 'vm'
import { ConsoleRing, EVENT_MAX_BYTES, HOOK_FIELDS, RING_MAX_BYTES, TRANSCRIPT_FIELDS, hiveSourceId, jsonBytes, makeEvent, mayRead, parseSourceId, redactPayload, safeWord, sessionSourceId, type ConsoleEvent } from '../src/shared/devConsole'
import { DevConsole, MAX_SOURCES, QUEUE_MAX_EVENTS } from '../src/main/devConsole'
import { hookSummary, launchEvent, transcriptEvent } from '../src/main/devConsoleWords'
import { CONSOLE_NOT_CAPTURED, consoleEventsText, consoleSourcesText } from '../src/shared/toolReplies'
import { say } from '../src/shared/agentText'
import { SECRET_SAMPLES } from './secretSamples'

// The developer console's capture (#636): bounded rings, kept only while a console watches, each raw event redacted
// (the sensitive context following everything under it) and paired with what Hive made of it; who may read which
// source; replies bounded. The paths are only compared, never touched.
const ws = join('C:\\', 'work')
const alpha = join(ws, 'alpha')
const beta = join(ws, 'beta')
const other = join('C:\\', 'elsewhere', 'gamma')
const A1 = sessionSourceId(alpha, 'a1')
const A2 = sessionSourceId(alpha, 'a2')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const event = (seq: number, bytes = 10): ConsoleEvent => ({ seq, at: '2026-10-12T00:00:00.000Z', source: A1, kind: 'hook', name: 'Stop', summary: '', bytes })

describe('ConsoleRing', () => {
  it('keeps the newest events within its count', () => {
    const r = new ConsoleRing(3, 1000)
    for (let i = 1; i <= 5; i++) r.push(event(i))
    expect(r.all().map((e) => e.seq)).toEqual([3, 4, 5])
    expect(r.bytes).toBe(30)
  })

  it('keeps the newest events within its bytes, and not one larger than the whole ring', () => {
    const r = new ConsoleRing(100, 25)
    for (let i = 1; i <= 4; i++) r.push(event(i))
    expect(r.all().map((e) => e.seq)).toEqual([3, 4])
    r.push(event(5, 25))
    expect(r.all().map((e) => e.seq)).toEqual([5])
    r.push(event(6, 80))
    expect(r.all()).toEqual([])
    expect(r.bytes).toBe(0)
  })

  it('gives the events after a seq, the newest `limit` of them', () => {
    const r = new ConsoleRing()
    for (let i = 1; i <= 6; i++) r.push(event(i))
    expect(r.since(2).map((e) => e.seq)).toEqual([3, 4, 5, 6])
    expect(r.since(2, 2).map((e) => e.seq)).toEqual([5, 6])
    expect(r.find(4)?.seq).toBe(4)
    expect(r.find(40)).toBeUndefined()
  })
})

describe('redactPayload', () => {
  // Shaped as Claude Code's hooks are.
  const hook = {
    hook_event_name: 'PreToolUse',
    session_id: '0b5f0c2e-3f7e-4c1a-9c8e-2d1f0a6b7c8d',
    transcript_path: 'C:\\Users\\me\\.claude\\projects\\x\\0b5f.jsonl',
    cwd: alpha,
    permission_mode: 'default',
    prompt: 'deploy with my key sk-ant-api03-abcdefghijklmnop',
    tool_name: 'Edit',
    tool_input: { file_path: join(alpha, 'src', 'a.ts'), old_string: 'const a = 1', new_string: 'privatecode', command: 'npm test -- --token abc' },
    usage: { input_tokens: 1200, output_tokens: 30 },
    authorization: 'Bearer abc.def.ghi',
    api_key: 'plain',
    note: 'oneword'
  }

  it("keeps a hook's envelope, its tool's file path and every number, and hides every other string", () => {
    const r = redactPayload(hook, {}, HOOK_FIELDS) as Record<string, any>
    expect(r.hook_event_name).toBe('PreToolUse')
    expect(r.session_id).toBe(hook.session_id)
    expect(r.transcript_path).toBe(hook.transcript_path)
    expect(r.cwd).toBe(alpha)
    expect(r.tool_name).toBe('Edit')
    expect(r.tool_input.file_path).toBe(hook.tool_input.file_path)
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 30 })
    expect(r.prompt).toBe(`<text: ${hook.prompt.length} chars>`)
    expect(r.tool_input.new_string).toBe('<text: 11 chars>')
    expect(r.tool_input.command).toMatch(/^<text: \d+ chars>$/)
    // An unknown field's single word is text too.
    expect(r.note).toBe('<text: 7 chars>')
  })

  it("a tool's arguments stay hidden, whatever their field is called (provider-shaped)", () => {
    const MARK = 'privatecustomer'
    const payloads = [
      // Claude Code: WebSearch, WebFetch, Grep, Task, an MCP tool.
      { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: MARK } },
      { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: `https://example.com/${MARK}`, prompt: MARK } },
      { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: MARK, path: alpha, glob: MARK } },
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: MARK, subagent_type: MARK, id: MARK, name: MARK, model: MARK } },
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__x__y', tool_input: { id: MARK, model: MARK, name: MARK }, tool_response: { id: MARK } },
      // Copilot's camelCase hooks.
      { hookEventName: 'preToolUse', toolName: 'bash', toolArgs: JSON.stringify({ command: MARK }) },
      // An unknown record: ids, names and models under unlisted fields are its own.
      { unknown: { id: MARK, name: MARK, model: MARK, session_id: MARK } }
    ]
    for (const p of payloads) expect(JSON.stringify(redactPayload(p, {}, HOOK_FIELDS))).not.toContain(MARK)
    // A path is kept only where the hook's tool input is listed for one.
    expect((redactPayload(payloads[2], {}, HOOK_FIELDS) as any).tool_input.path).toBe(alpha)
  })

  it('a secret, sign-in or prompt field takes everything under it with it, however it is spelt', () => {
    const r = redactPayload(
      {
        access_token: { data: 'abc-private-token', n: 7 },
        'api-key': { id: 'private-token' },
        idToken: { id: 'private-token' },
        ID_TOKEN: 'private-token',
        Prompt: { name: 'privateprompt' },
        old_string: { name: 'privatecode' },
        login: { username: 'privateuser', device_code: 'ABCD-EFGH' },
        oauth: [{ id: 'x' }],
        signIn: 'expired-private',
        nested: { deep: { deviceCode: 'WXYZ-1234', user_code: 'QQQQ', verificationUri: 'https://x/private' } },
        authorization: 'Bearer abc.def.ghi',
        apiKey: 'plain'
      },
      {},
      { '*': { id: true, name: true, '*': true } }
    ) as Record<string, any>
    const text = JSON.stringify(r)
    for (const secret of ['abc-private-token', 'private-token', 'privateprompt', 'privatecode', 'privateuser', 'ABCD-EFGH', 'expired-private', 'WXYZ-1234', 'QQQQ', 'private', 'abc.def.ghi', 'plain']) expect(text).not.toContain(secret)
    expect(r.access_token).toBe('<redacted>')
    expect(r['api-key']).toBe('<redacted>')
    expect(r.idToken).toBe('<redacted>')
    expect(r.login).toBe('<redacted>')
    expect(r.nested.deep).toEqual({ deviceCode: '<redacted>', user_code: '<redacted>', verificationUri: '<redacted>' })
  })

  it('usage counts are numbers outside any secret, so they stay', () => {
    expect(redactPayload({ usage: { input_tokens: 5, cache_read_input_tokens: 2, total_tokens: 7 } })).toEqual({ usage: { input_tokens: 5, cache_read_input_tokens: 2, total_tokens: 7 } })
  })

  it("a transcript record's envelope is kept, never its text", () => {
    const record = { type: 'assistant', sessionId: 's1', message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'privatereply' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'privatecommand' } }] } }
    const r = redactPayload({ records: 1, newest: [record] }, {}, TRANSCRIPT_FIELDS) as { newest: any[] }
    expect(r.newest[0].message.model).toBe('claude-opus-5-5')
    expect(r.newest[0].message.content[1].name).toBe('Bash')
    expect(JSON.stringify(r)).not.toMatch(/privatereply|privatecommand/)
  })

  it('keeps nothing without safe fields', () => {
    expect(redactPayload({ id: 'x', name: 'y', model: 'z', n: 1 })).toEqual({ id: '<text: 1 chars>', name: '<text: 1 chars>', model: '<text: 1 chars>', n: 1 })
  })

  it('masks a token even in a safe field', () => {
    expect(redactPayload({ model: 'sk-ant-api03-abcdefghijklmnop' }, {}, { model: true })).toEqual({ model: '<redacted>' })
  })

  it('keeps text only when asked, with secrets and sign-ins still masked', () => {
    const r = redactPayload({ ...hook, login: { username: 'privateuser' } }, { includeText: true }, HOOK_FIELDS) as Record<string, any>
    expect(r.prompt).toContain('deploy with my key')
    expect(r.prompt).not.toContain('sk-ant')
    expect(r.authorization).toBe('<redacted>')
    expect(r.login).toBe('<redacted>')
    expect(r.tool_input.command).toContain('npm test')
  })

  it('cuts text to its cap before masking it, dropping a word the cut goes through, and stays fast on huge text (#699 round 6)', () => {
    // A key the cut would split: dropped whole, never kept in part (too short then to be recognised as a key).
    const split = redactPayload({ prompt: `${'a '.repeat(999)}sk-ant-api03-abcdefghijklmnopqrstu and more` }, { includeText: true }) as { prompt: string }
    expect(split.prompt.endsWith('a …')).toBe(true)
    expect(split.prompt).not.toContain('sk-')
    // Masking reads only what is kept: a megabyte of backslashes and quotes is cut to the cap first. A pattern that read it
    // all again and again would blow vm's bound.
    const vmContext = createContext({ redactPayload, text: '' })
    for (const text of ['\\'.repeat(1_000_000), '"'.repeat(1_000_000), `--token ${'\\"'.repeat(500_000)}`]) {
      vmContext.text = text
      const out = runInContext('redactPayload({ prompt: text }, { includeText: true })', vmContext, { timeout: 5000 }) as { prompt: string }
      expect(out.prompt.length).toBeLessThanOrEqual(2001)
    }
  })

  it('bounds lists, fields, field names and depth', () => {
    const long = redactPayload({ list: Array.from({ length: 50 }, (_, i) => i) }) as { list: unknown[] }
    expect(long.list).toHaveLength(41)
    expect(long.list[40]).toBe('<10 more>')
    const wide = redactPayload(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>
    expect(Object.keys(wide)).toHaveLength(61)
    const named = redactPayload({ ['k'.repeat(100_000)]: 1 }) as Record<string, unknown>
    expect(Object.keys(named)[0].length).toBeLessThanOrEqual(65)
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 10; i++) deep = { d: deep }
    expect(JSON.stringify(redactPayload(deep))).toContain('<object>')
  })

  it('never throws on odd values', () => {
    expect(redactPayload({ n: Number.NaN, u: undefined, f: () => 1, big: 10n })).toEqual({ n: 'NaN', f: '<function>', big: '<bigint>' })
  })
})

describe('makeEvent', () => {
  it('counts its size in UTF-8 bytes', () => {
    const small = makeEvent(1, 'at', A1, { kind: 'hook', name: 'Stop', summary: 'Stop → stop; finished', raw: { a: 1 } })
    expect(small.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...small, bytes: 0 })))
    expect(jsonBytes({ name: '𝄞é→' })).toBe(Buffer.byteLength(JSON.stringify({ name: '𝄞é→' })))
  })

  it('is never larger than its bound, whatever its payload, name or summary', () => {
    const raw = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, Array.from({ length: 40 }, () => 'ab-'.repeat(33))]))
    for (const c of [
      { kind: 'transcript' as const, name: 'transcript', summary: 's', raw: { records: Array.from({ length: 40 }, () => ({ model: 'ab-'.repeat(40) })) } },
      { kind: 'transcript' as const, name: 'transcript', summary: 's', raw: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`${i}${'k'.repeat(2000)}`, 1])) },
      { kind: 'hook' as const, name: 'n'.repeat(40_000), summary: 's'.repeat(40_000), raw },
      { kind: 'hook' as const, name: 'x', summary: 'y', raw: { ['k'.repeat(1_100_000)]: 1 } }
    ]) {
      const e = makeEvent(2, 'at', A1, c)
      expect(e.bytes).toBeLessThanOrEqual(EVENT_MAX_BYTES)
      expect(e.bytes).toBe(jsonBytes({ ...e, bytes: 0 }))
    }
  })

  it('cuts a payload too large to its outline, and says so', () => {
    const raw = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, Array.from({ length: 40 }, () => 'ab-'.repeat(33))]))
    const big = makeEvent(2, 'at', A1, { kind: 'transcript', name: 'transcript', summary: 's', raw: { path: raw } })
    expect(big.truncated).toBe(true)
    expect((big.raw as Record<string, unknown>).fields).toEqual(['path'])
  })

  it('masks a secret even in its summary', () => {
    expect(makeEvent(1, 'at', A1, { kind: 'api', name: 'x', summary: 'Bearer abcdefgh' }).summary).toBe('Bearer <redacted>')
  })
})

describe('DevConsole', () => {
  it('captures nothing, and builds nothing, while no console watches', () => {
    const c = new DevConsole()
    const build = vi.fn(() => ({ kind: 'hook' as const, name: 'Stop', summary: 's' }))
    c.capture([A1], build)
    expect(build).not.toHaveBeenCalled()
    expect(c.stats()).toEqual({ sources: 0, events: 0, textEvents: 0, bytes: 0, subscribers: 0, queued: 0, flightSources: 0, flightEvents: 0, flightBytes: 0 })
    // Reading (what the hive tools do) starts nothing.
    expect(c.events(A1)).toEqual([])
    expect(c.capturing(A1)).toBe(false)
  })

  it('captures a watched source from its first console to its last, and keeps nothing after', () => {
    const c = new DevConsole()
    c.subscribe('w1', [A1])
    c.subscribe('w2', [A1, A2])
    c.capture([A1, A2, null], () => ({ kind: 'hook', name: 'Stop', summary: 's', raw: { prompt: 'secret words' } }))
    expect(c.events(A1)).toHaveLength(1)
    expect(c.events(A2)).toHaveLength(1)
    expect(c.events(A1)[0].raw).toEqual({ prompt: '<text: 12 chars>' })
    c.unsubscribe('w2')
    expect(c.capturing(A1)).toBe(true)
    expect(c.capturing(A2)).toBe(false)
    c.unsubscribe('w1')
    expect(c.stats()).toEqual({ sources: 0, events: 0, textEvents: 0, bytes: 0, subscribers: 0, queued: 0, flightSources: 0, flightEvents: 0, flightBytes: 0 })
    expect(c.events(A1)).toEqual([])
  })

  it('changes a subscription in place: new sources start, dropped ones stop', () => {
    const c = new DevConsole()
    c.subscribe('w', [A1])
    c.subscribe('w', [A2])
    expect(c.capturing(A1)).toBe(false)
    expect(c.capturing(A2)).toBe(true)
    expect(c.sourcesOf('w')).toEqual([A2])
    c.unsubscribe('nobody')
  })

  it('bounds the sources one console holds', () => {
    const c = new DevConsole()
    c.subscribe('w', Array.from({ length: MAX_SOURCES + 5 }, (_, i) => sessionSourceId(alpha, `a${i}`)))
    expect(c.sourcesOf('w')).toHaveLength(MAX_SOURCES)
  })

  it('sends live events to a console, with text only to one that opted in', async () => {
    const c = new DevConsole()
    const plain: ConsoleEvent[] = []
    const text: ConsoleEvent[] = []
    c.subscribe('console', [A1], { deliver: (e) => plain.push(...e) })
    c.subscribe('recording', [A1], { deliver: (e) => text.push(...e), includeText: true })
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'hello there' } }))
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'and more' } }))
    await vi.waitFor(() => expect(plain).toHaveLength(2), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(text).toHaveLength(2), { timeout: HUNG_MS })
    expect(plain.map((e) => (e.raw as { text: string }).text)).toEqual(['<text: 11 chars>', '<text: 8 chars>'])
    expect(text.map((e) => (e.raw as { text: string }).text)).toEqual(['hello there', 'and more'])
    // What a reader reads is always the redacted copy.
    expect(c.events(A1).map((e) => (e.raw as { text: string }).text)).toEqual(['<text: 11 chars>', '<text: 8 chars>'])
    // Once the recording ends, no event keeps text for anyone.
    c.unsubscribe('recording')
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'later' } }))
    await vi.waitFor(() => expect(plain).toHaveLength(3), { timeout: HUNG_MS })
    expect((plain[2].raw as { text: string }).text).toBe('<text: 5 chars>')
  })

  it('bounds what waits to be sent to a console: a burst keeps the newest and counts the rest', async () => {
    const c = new DevConsole()
    const got: ConsoleEvent[] = []
    let dropped = 0
    c.subscribe('console', [A1], {
      deliver: (e, d) => {
        got.push(...e)
        dropped += d
      }
    })
    for (let i = 0; i < 2000; i++) c.capture([A1], () => ({ kind: 'hook', name: 'Stop', summary: 's' }))
    expect(c.stats().queued).toBe(QUEUE_MAX_EVENTS)
    await vi.waitFor(() => expect(got.length + dropped).toBe(2000), { timeout: HUNG_MS })
    expect(got).toHaveLength(QUEUE_MAX_EVENTS)
    expect(got[got.length - 1].seq).toBe(2000)
    expect(c.stats().queued).toBe(0)
    expect(c.stats().bytes).toBeLessThanOrEqual(RING_MAX_BYTES)
  })

  it('a replaced subscription is sent nothing queued for the one before it: not its sources, not its text', async () => {
    const c = new DevConsole()
    const got: ConsoleEvent[] = []
    const deliver = (e: ConsoleEvent[]): void => void got.push(...e)
    // Another source, before a flush.
    c.subscribe('w', [A1], { deliver, includeText: true })
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'private recording prompt' } }))
    c.subscribe('w', [A2], { deliver })
    // The same source, text opted out, before a flush.
    c.subscribe('v', [A1], { deliver, includeText: true })
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'private second prompt' } }))
    c.subscribe('v', [A1], { deliver })
    // Back-to-back recordings: the second never gets the first's.
    c.subscribe('r', [A1], { deliver, includeText: true })
    c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 's', raw: { text: 'private third prompt' } }))
    c.subscribe('r', [A1], { deliver, includeText: true })
    c.capture([A2], () => ({ kind: 'hook', name: 'Stop', summary: 'after' }))
    await vi.waitFor(() => expect(got.some((e) => e.summary === 'after')).toBe(true), { timeout: HUNG_MS })
    expect(JSON.stringify(got)).not.toContain('private')
    expect(c.stats().queued).toBe(0)
  })

  // Developer console: show text (#699): a window's subscription keeps text while the setting is on, never secrets.
  describe('a window showing text', () => {
    const MARK = 'privatewords'
    const SECRETS = ['sk-ant-api03-abcdefghijklmnop', 'ghp_abcdefghijklmnopqrstu', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz', 'Bearer abcdefghij', 'hunter2pass', 'ABCD-EFGH', 'privateuser', 'me@example.com']
    // A hook carrying text, and secrets in every place they can be: in the text, in secret fields, in a sign-in.
    const hook = () => ({
      kind: 'hook' as const,
      name: 'PreToolUse',
      summary: 'PreToolUse (Bash)',
      raw: {
        hook_event_name: 'PreToolUse',
        prompt: `${MARK} with my key ${SECRETS[0]} and ${SECRETS[1]}`,
        tool_name: 'Bash',
        // What follows a credential to the next option is masked too: the words shown come before.
        tool_input: { command: `curl ${MARK} -H "Authorization: ${SECRETS[3]}" --token ${SECRETS[2]}` },
        password: SECRETS[4],
        login: { device_code: SECRETS[5], username: SECRETS[6] },
        note: `mail ${SECRETS[7]}`
      },
      safe: { raw: HOOK_FIELDS }
    })
    const noSecrets = (events: ConsoleEvent[]): void => {
      const text = JSON.stringify(events)
      for (const s of SECRETS) expect(text, s).not.toContain(s)
    }

    it('shows text only while it is on, and secrets stay masked even then', async () => {
      const c = new DevConsole()
      const got: ConsoleEvent[] = []
      c.subscribe('window', [A1], { deliver: (e) => void got.push(...e) })
      c.capture([A1], hook)
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: HUNG_MS })
      expect(JSON.stringify(got[0])).not.toContain(MARK)
      expect(c.setIncludeText('window', true)).toBe(true)
      expect(c.includesText('window')).toBe(true)
      c.capture([A1], hook)
      await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: HUNG_MS })
      const shown = got[1].raw as Record<string, any>
      expect(shown.prompt).toContain(MARK)
      expect(shown.tool_input.command).toContain(MARK)
      expect(shown.password).toBe('<redacted>')
      expect(shown.login).toBe('<redacted>')
      noSecrets(got)
      // Turned off: nothing more with text.
      expect(c.setIncludeText('window', false)).toBe(true)
      expect(c.includesText('window')).toBe(false)
      c.capture([A1], hook)
      await vi.waitFor(() => expect(got).toHaveLength(3), { timeout: HUNG_MS })
      expect(JSON.stringify(got[2])).not.toContain(MARK)
    })

    it('secrets and sign-ins in the text itself stay masked: options, quoted values with spaces, passwords, device codes (#699 round 1)', async () => {
      const c = new DevConsole()
      const got: ConsoleEvent[] = []
      c.subscribe('window', [A1], { deliver: (e) => void got.push(...e), includeText: true })
      // As a prompt, a command, a reply and a tool's output carry them.
      for (const s of SECRET_SAMPLES) {
        c.capture([A1], () => ({ kind: 'hook', name: 'PreToolUse', summary: 's', raw: { prompt: s.text, tool_input: { command: s.text }, last_assistant_message: s.text, tool_response: { stdout: s.text } }, safe: { raw: HOOK_FIELDS } }))
      }
      await vi.waitFor(() => expect(got).toHaveLength(SECRET_SAMPLES.length), { timeout: HUNG_MS })
      for (const [i, s] of SECRET_SAMPLES.entries()) {
        for (const kept of [got[i], c.eventsFor('window', A1)[i]]) {
          const text = JSON.stringify(kept)
          for (const secret of s.secrets) expect(text, s.text).not.toContain(secret)
          for (const k of s.kept ?? []) expect(text, s.text).toContain(k)
        }
      }
    })

    it('masking is the last step over the whole event, text kept or not: its name, summary, every payload string and field name', () => {
      // A secret in a prompt, a reply and a command line; in a field kept as a path; in a field's name; in the event's
      // name and summary; and in a payload too large, cut to its outline (its field names).
      const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i} --token outlineSecret${i}`, 'x'.repeat(1000)]))
      const captured = {
        kind: 'hook' as const,
        name: 'enter ABCD-EFGH',
        summary: 'PreToolUse --api-key summarySecret',
        raw: {
          hook_event_name: 'PreToolUse',
          cwd: 'C:\\work\\x --password pathSecret',
          prompt: 'deploy with --api-key promptSecret',
          last_assistant_message: 'Done. Use password: replySecret words',
          tool_input: { command: 'curl -H "Cookie: sid=commandSecret" -u admin:userSecret https://example.com' },
          'device_code=keySecret': 1
        },
        safe: { raw: HOOK_FIELDS }
      }
      for (const includeText of [false, true]) {
        for (const e of [makeEvent(1, 'at', A1, captured, { includeText }), makeEvent(2, 'at', A1, { kind: 'transcript', name: 'transcript', summary: 's', raw: big }, { includeText })]) {
          const text = JSON.stringify(e)
          for (const secret of ['ABCD-EFGH', 'summarySecret', 'pathSecret', 'promptSecret', 'replySecret', 'commandSecret', 'userSecret', 'keySecret', 'outlineSecret']) expect(text, `${secret}, text ${includeText}`).not.toContain(secret)
        }
      }
      // The text itself still shows when kept.
      expect(JSON.stringify(makeEvent(1, 'at', A1, captured, { includeText: true }))).toContain('deploy with --api-key <redacted>')
    })

    it("its backlog (a resume after a pause) has text where it was kept, never what came before; readers' never has", () => {
      const c = new DevConsole()
      c.subscribe('window', [A1], { includeText: true })
      c.subscribe('other', [A1])
      c.capture([A1], hook)
      expect(c.stats().textEvents).toBe(1)
      const backlog = c.eventsFor('window', A1)
      expect(JSON.stringify(backlog)).toContain(MARK)
      noSecrets(backlog)
      // The same seqs as the redacted ring: one list, two copies.
      expect(backlog.map((e) => e.seq)).toEqual(c.events(A1).map((e) => e.seq))
      // A reader (the hive tools), and a window without text, get the redacted ring.
      expect(JSON.stringify(c.events(A1))).not.toContain(MARK)
      expect(JSON.stringify(c.eventsFor('other', A1))).not.toContain(MARK)
      // A new subscription with text gets the kept text back with the rest.
      expect(JSON.stringify(c.subscribe('third', [A1], { includeText: true }).get(A1))).toContain(MARK)
      // A source the subscriber doesn't watch gives nothing.
      expect(c.eventsFor('window', A2)).toEqual([])
    })

    it('turned off, its text goes: nothing waiting is sent, and none is kept once no subscriber keeps text', async () => {
      const c = new DevConsole()
      const got: ConsoleEvent[] = []
      c.subscribe('window', [A1], { deliver: (e) => void got.push(...e), includeText: true })
      c.capture([A1], hook)
      // Before the flush.
      c.setIncludeText('window', false)
      expect(c.stats()).toMatchObject({ queued: 0, textEvents: 0 })
      expect(JSON.stringify(c.eventsFor('window', A1))).not.toContain(MARK)
      c.capture([A1], () => ({ kind: 'hook', name: 'Stop', summary: 'after' }))
      await vi.waitFor(() => expect(got.some((e) => e.summary === 'after')).toBe(true), { timeout: HUNG_MS })
      expect(JSON.stringify(got)).not.toContain(MARK)
      // A recording with text keeps its own text ring going, and only while it lasts.
      c.subscribe('recording', [A1], { includeText: true })
      c.capture([A1], hook)
      expect(c.stats().textEvents).toBe(1)
      c.unsubscribe('recording')
      expect(c.stats().textEvents).toBe(0)
      expect(c.setIncludeText('nobody', true)).toBe(false)
    })
  })

  it("a capture point that throws keeps nothing and doesn't fail its caller", () => {
    const c = new DevConsole()
    c.subscribe('w', [A1])
    expect(() =>
      c.capture([A1], () => {
        throw new Error('boom')
      })
    ).not.toThrow()
    c.capture([A1], () => null)
    expect(c.events(A1)).toHaveLength(0)
  })

  it('numbers events across sources, so since works after a ring is made again', () => {
    const c = new DevConsole()
    c.subscribe('w', [A1, A2])
    c.capture([A1], () => ({ kind: 'hook', name: 'a', summary: 's' }))
    c.capture([A2], () => ({ kind: 'hook', name: 'b', summary: 's' }))
    c.unsubscribe('w')
    c.subscribe('w', [A1])
    c.capture([A1], () => ({ kind: 'hook', name: 'c', summary: 's' }))
    expect(c.events(A1)[0].seq).toBe(3)
  })
})

describe('mayRead', () => {
  const wsOf = (p: string): string | null => (p.toLowerCase().startsWith(ws.toLowerCase()) ? ws : p.toLowerCase().startsWith(join('C:\\', 'elsewhere').toLowerCase()) ? join('C:\\', 'elsewhere') : null)
  const assistantHome = sessionSourceId(join(ws, '.hive', 'assistant'), 'assistant')

  it('a project agent reads its own session only', () => {
    const me = { kind: 'agent' as const, projectPath: alpha, agentId: 'a1' }
    expect(mayRead(me, A1, wsOf)).toBe(true)
    // By any spelling of its own folder.
    expect(mayRead({ ...me, projectPath: alpha.toUpperCase() + '\\' }, A1, wsOf)).toBe(true)
    expect(mayRead(me, A2, wsOf)).toBe(false)
    expect(mayRead(me, sessionSourceId(beta, 'a1'), wsOf)).toBe(false)
    expect(mayRead(me, assistantHome, wsOf)).toBe(false)
    expect(mayRead(me, hiveSourceId(ws), wsOf)).toBe(false)
  })

  it("the Assistant reads its workspace's sessions, its own and Hive's events there, and nothing elsewhere", () => {
    const assistant = { kind: 'assistant' as const, workspace: ws.toLowerCase() }
    expect(mayRead(assistant, A1, wsOf)).toBe(true)
    expect(mayRead(assistant, sessionSourceId(beta, 'b1'), wsOf)).toBe(true)
    expect(mayRead(assistant, assistantHome, wsOf)).toBe(true)
    expect(mayRead(assistant, hiveSourceId(ws), wsOf)).toBe(true)
    expect(mayRead(assistant, sessionSourceId(other, 'g1'), wsOf)).toBe(false)
    expect(mayRead(assistant, hiveSourceId(join('C:\\', 'elsewhere')), wsOf)).toBe(false)
    // A folder in no open workspace.
    expect(mayRead(assistant, sessionSourceId(join('D:\\', 'loose'), 'x'), wsOf)).toBe(false)
  })

  it("a malformed source is nobody's", () => {
    for (const bad of ['', 'session:', 'session:c:\\work\\alpha', 'session:c:\\work\\alpha#', 'hive:', 'other:x']) {
      expect(parseSourceId(bad)).toBeNull()
      expect(mayRead({ kind: 'all' }, bad, wsOf)).toBe(false)
    }
    expect(mayRead({ kind: 'all' }, A1, wsOf)).toBe(true)
  })
})

describe('launches', () => {
  it("keep the CLI, its version and its known option names, and count the rest: never an inline value or a value starting with a dash", () => {
    const MARK = 'privatecustomer'
    const c = new DevConsole()
    c.subscribe('w', [A1])
    const args = ['--session-id', 'x', `--append-system-prompt=${MARK}`, '--allowedTools', `-${MARK}-dash`, '--model', 'opus']
    c.capture([A1], () => launchEvent({ provider: 'claude-code', name: 'Claude Code', file: join('C:\\', 'tools', 'claude.exe'), args, cwd: alpha, version: '2.1.296', state: { status: 'starting', permissionMode: 'default', modelId: undefined, effort: undefined }, resumed: false }))
    const [e] = c.events(A1)
    // Only names from the known list; the rest (values, an inline value, one starting with a dash) counted.
    expect(e.raw).toEqual({ file: 'claude.exe', switches: ['--session-id', '--allowedTools', '--model'], otherArgs: 4, cwd: alpha, version: '2.1.296' })
    expect(JSON.stringify(e)).not.toContain(MARK)
    expect(e.summary).toBe('Claude Code 2.1.296 started; starting')
  })
})

describe('summaries', () => {
  it('a hook: what came in, what Hive took it for, and what it did, in its own words', () => {
    expect(hookSummary('PreToolUse', 'Edit', 'toolStart', 'working', [], true)).toBe('PreToolUse (Edit) → toolStart; working; replied')
    expect(hookSummary('Stop', undefined, 'stop', 'finished', ['notifyFinished', 'turnEnded'], false)).toBe('Stop → stop; finished; notifyFinished, turnEnded')
    // A name that isn't an identifier, or is too long, is not quoted.
    expect(hookSummary('PreToolUse', 'rm -rf my secrets', 'toolStart', 'working', [], false)).toBe('PreToolUse (<text: 17 chars>) → toolStart; working')
    expect(safeWord('x'.repeat(65))).toBe('<text: 65 chars>')
  })

  it("a transcript read: its newest records next to what Hive read from them", () => {
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: 'event', n: i })).join('\n') + '\nnot json\n'
    const e = transcriptEvent('codex', lines, { modelId: 'gpt-5', planUsage: { provider: 'codex', plan: null, updatedAt: 'x', limits: [{ id: 'five_hour', label: '5-hour', windowMinutes: 300, usedPercent: 41.6, resetsAt: null }] } })
    const raw = e.raw as { records: number; newest: unknown[] }
    expect(raw.records).toBe(13)
    expect(raw.newest).toHaveLength(10)
    expect(raw.newest[9]).toEqual({ unparsed: 8 })
    expect(e.summary).toBe('transcript +13 records → model gpt-5 · five_hour 42%')
  })

  it('private text reaches no part of a kept event by default: raw, made, name or summary', () => {
    const MARK = 'zebraumbrella'
    const c = new DevConsole()
    c.subscribe('w', [A1])
    c.capture([A1], () => ({ kind: 'hook', name: safeWord(`${MARK} hook`), summary: hookSummary(`${MARK} two`, `${MARK} tool`, 'prompt', 'working', [], false), raw: { prompt: MARK, title: MARK, custom: MARK, nested: { x: [MARK] }, tool_input: { query: MARK } }, made: { event: { kind: 'prompt', text: MARK }, status: 'working' }, safe: { raw: HOOK_FIELDS } }))
    // A Progress run's title is someone's text: kept in the payload, hidden there, and not in the summary.
    c.capture([A1], () => ({ kind: 'progress', name: 'running', summary: 'progress run by B1 → running', raw: { title: `${MARK} customer project` } }))
    expect(JSON.stringify(c.events(A1))).not.toContain(MARK)
  })
})

describe('replies', () => {
  const source = { label: 'alpha · B1', kind: 'session', select: { agent: 'a-1', project: 'alpha' }, provider: 'claude-code', capturing: true, events: 2 }

  it('lists the sources a page at a time, with how to name each', () => {
    const text = consoleSourcesText({ total: 2, offset: 0, sources: [source, { label: 'Hive', kind: 'hive', select: { source: 'hive' }, capturing: false, events: 0 }] })
    expect(text).toBe('alpha · B1 (claude-code): captured, 2 events [agent="a-1" project="alpha"]\nHive: not captured [source="hive"]')
    // A name a display label cuts or masks is still given whole as the argument that reads it.
    const long = 'developer-console-capture-and-recording-contract-fixtures-project'
    expect(consoleSourcesText({ total: 1, offset: 0, sources: [{ ...source, label: long.slice(0, 40), select: { agent: 'a-9', project: long } }] })).toContain(`project="${long}"`)
    expect(consoleSourcesText({ total: 0, offset: 0, sources: [] })).toBe('No developer console sources you can read.')
    // A large workspace: a page, and where the next starts.
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...source, label: `project${i} · ${'B'.repeat(40)}`, select: { agent: `a-${i}`, project: `project${i}` } }))
    const page = consoleSourcesText({ total: 1000, offset: 50, sources: rows })
    expect(page.endsWith('\nSources 51–100 of 1000: offset=100 for more.')).toBe(true)
    expect(page.length).toBeLessThan(8000)
  })

  it('a read: a line per event and how to carry on; nothing captured says so', () => {
    const events = [{ seq: 7, at: '2026-10-12T01:02:03.000Z', kind: 'hook', name: 'Stop', summary: 'Stop → stop; finished' }]
    const text = consoleEventsText({ source, events, older: 4, newest: 7 })
    expect(text).toBe("alpha · B1:\n#7 01:02:03 hook Stop → stop; finished\n4 earlier not shown.\nNext: since=7. seq=[n] gives an event's raw payload and what Hive made of it.")
    expect(consoleEventsText({ source: { ...source, capturing: false, events: 0 }, events: [], newest: 0 })).toBe(`alpha · B1: ${say(CONSOLE_NOT_CAPTURED)}`)
    expect(consoleEventsText({ source, events: [], newest: 0 })).toBe('alpha · B1: captured by the open console; no events yet.')
    expect(consoleEventsText({ source, events: [], missing: [3] })).toContain('Not in its buffer now: #3.')
  })
})
