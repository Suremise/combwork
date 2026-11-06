import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { HOOK_FIELDS, HOOK_MADE_FIELDS, makeEvent, sessionSourceId, type ConsoleEvent } from '../src/shared/devConsole'
import { DevConsole } from '../src/main/devConsole'
import { redact, type RedactContext } from '../src/shared/redact'
import { compareContract, diagnosticRecording, DIAGNOSTIC_BYTES, DIAGNOSTIC_LINES, newestRecordingsFirst, parseRecording, readingOf, recordingName, recordingToFixture, shapeOf, type ConsoleFixture, type RecordingHeader } from '../src/shared/consoleFixtures.mts'

// Developer console recordings as files (#638): a recording written as the recorder writes it (header, events as a
// subscription delivers them, end) stays redacted unless it opted in to text; fixtures are made only from redacted
// recordings, without paths; the contract comparison flags what a CLI changed; Copy Diagnostics takes the newest part.
// Paths are only compared, never touched.
const alpha = join('C:\\', 'work', 'alpha')
const A1 = sessionSourceId(alpha, 'a1')
const HUNG_MS = 10000
const PRIVATE = 'privatecustomer'

const header = (text = false): RecordingHeader => ({
  type: 'recording',
  format: 1,
  combwork: '0.7.0',
  startedAt: '2026-10-12T09:00:00.000Z',
  source: { kind: 'session', label: 'alpha · B1', provider: 'claude-code' },
  text,
  clis: [
    { provider: 'claude-code', version: '2.1.296', tested: '2.1.296' },
    { provider: 'codex', version: null, tested: '0.162.1' }
  ]
})

/** A hook as Claude Code sends it, with a prompt, a secret and paths. */
const hook = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: name,
  session_id: '0b5f0c2e-3f7e-4c1a-9c8e-2d1f0a6b7c8d',
  cwd: alpha,
  transcript_path: join(alpha, '.claude', 's.jsonl'),
  prompt: `deploy for ${PRIVATE} with sk-ant-api03-abcdefghijklmnopqrstuv`,
  ...extra
})

/** Records two hooks through a subscription, as consoleRecorder.ts does: the file's text. */
async function record(includeText: boolean): Promise<string> {
  const c = new DevConsole()
  const got: ConsoleEvent[] = []
  c.subscribe('record:1', [A1], { includeText, deliver: (e) => got.push(...e) })
  c.capture([A1], () => ({ kind: 'hook', name: 'UserPromptSubmit', provider: 'claude-code', summary: 'UserPromptSubmit → prompt; working', raw: hook('UserPromptSubmit'), made: { event: { kind: 'prompt' }, status: 'working', actions: [] }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS } }))
  c.capture([A1], () => ({ kind: 'hook', name: 'PreToolUse', provider: 'claude-code', summary: 'PreToolUse (Edit) → toolStart; working', raw: hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: join(alpha, 'a.ts'), old_string: PRIVATE } }), made: { event: { kind: 'toolStart' }, status: 'working', actions: [] }, safe: { raw: HOOK_FIELDS, made: HOOK_MADE_FIELDS } }))
  c.capture([A1], () => ({ kind: 'input', name: 'typed', summary: 'typed', raw: { text: PRIVATE } }))
  await vi.waitFor(() => expect(got).toHaveLength(3), { timeout: HUNG_MS })
  const lines = [header(includeText), ...got.map((e) => ({ type: 'event', ...e })), { type: 'end', at: '2026-10-12T09:01:00.000Z', events: got.length, dropped: 0, reason: 'stopped' }]
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('')
}

describe('recording', () => {
  it('is redacted by default: no prompt, edit or typed text, no token; ids, names and paths kept', async () => {
    const text = await record(false)
    expect(text).not.toContain(PRIVATE)
    expect(text).not.toContain('sk-ant')
    const r = parseRecording(text)
    expect(r.header?.text).toBe(false)
    expect(r.events.map((e) => e.name)).toEqual(['UserPromptSubmit', 'PreToolUse', 'typed'])
    expect((r.events[1].raw as { tool_input: { file_path: string } }).tool_input.file_path).toBe(join(alpha, 'a.ts'))
    expect(r.end?.events).toBe(3)
  })

  it('keeps text only when the recording opted in, tokens still masked', async () => {
    const text = await record(true)
    expect(text).toContain(PRIVATE)
    expect(text).not.toContain('sk-ant-api03')
  })

  it('reads what it can of a recording cut short', () => {
    const r = parseRecording(`${JSON.stringify(header())}\n${JSON.stringify({ type: 'event', seq: 1, at: '', kind: 'hook', name: 'Stop', summary: '' })}\n{"type":"ev`)
    expect(r.events).toHaveLength(1)
    expect(r.end).toBeNull()
    expect(r.bad).toBe(1)
  })
})

describe('recordingToFixture', () => {
  it("keeps the CLI's events and Combwork's reading of them, in order, without times, paths or Combwork's own work", async () => {
    const f = recordingToFixture(await record(false))
    expect(f).toMatchObject({ format: 1, provider: 'claude-code', cli: '2.1.296', combwork: '0.7.0', recordedAt: '2026-10-12T09:00:00.000Z' })
    expect(f.events.map((e) => `${e.kind} ${e.name}`)).toEqual(['hook UserPromptSubmit', 'hook PreToolUse'])
    const text = JSON.stringify(f)
    expect(text).not.toMatch(/work[\\/]+alpha|"seq"|"at"/)
    expect((f.events[1].raw as { cwd: string; tool_input: { file_path: string } }).tool_input.file_path).toBe('<path>')
    expect((f.events[1].made as { event: { kind: string } }).event.kind).toBe('toolStart')
  })

  it('refuses a recording with text, and anything that is not a recording', async () => {
    expect(() => recordingToFixture('')).toThrow(/Not a developer console recording/)
    await expect(record(true).then(recordingToFixture)).rejects.toThrow(/includes prompt and reply text/)
    expect(() => recordingToFixture(`${JSON.stringify(header())}\n`)).toThrow(/no events from a CLI/)
  })
})

describe('compareContract', () => {
  const fixture = (events: ConsoleFixture['events']): ConsoleFixture => ({ format: 1, provider: 'claude-code', cli: '2.1.296', combwork: '0.7.0', recordedAt: '', events })
  const pre = (raw: Record<string, unknown>, kind = 'toolStart'): ConsoleFixture['events'][number] => ({ kind: 'hook', name: 'PreToolUse', raw, made: { event: { kind }, status: 'working', actions: [] } })
  const stop = (status = 'finished', actions = ['releaseLocks', 'turnEnded']): ConsoleFixture['events'][number] => ({ kind: 'hook', name: 'Stop', raw: { hook_event_name: 'Stop' }, made: { event: { kind: 'stop', lastMessage: null }, status, actions } })
  const ready = (status = 'ready'): ConsoleFixture['events'][number] => ({ kind: 'terminal', name: 'ready', raw: { screen: '<text: 200 chars>' }, made: { status } })
  const line: ConsoleFixture['events'][number] = { kind: 'statusline', name: 'statusline', raw: { model: { id: 'claude-opus-5-5' }, context_window: { used: 3 } }, made: { contextWindow: 150000 } }
  const base = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), stop(), ready(), line])

  it('finds nothing when the CLI sends the same', () => {
    expect(compareContract(base, base)).toEqual([])
  })

  it('flags a hook no longer sent, a field gone (a likely rename) or retyped, and a new reading as changes', () => {
    const live = fixture([pre({ hook_event_name: 'PreToolUse', toolName: 'Edit', tool_input: { file_path: 3 } }, 'ignore'), ready(), line])
    expect(compareContract(base, live)).toEqual([
      { level: 'change', event: 'hook PreToolUse', what: 'field tool_name is gone (renamed to toolName?)' },
      { level: 'new', event: 'hook PreToolUse', what: 'field toolName is new' },
      { level: 'change', event: 'hook PreToolUse', what: 'field tool_input.file_path was string, now number' },
      { level: 'change', event: 'hook PreToolUse', what: "Combwork's reading changed: it was actions= kind=toolStart status=working; now actions= kind=ignore status=working" },
      { level: 'change', event: 'hook Stop', what: 'no longer arrives' }
    ])
  })

  it("flags Combwork no longer ending the turn the same way: the same fields and event kind, another status or actions", () => {
    expect(compareContract(base, fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), stop('working', []), ready(), line]))).toEqual([
      { level: 'change', event: 'hook Stop', what: "Combwork's reading changed: it was actions=releaseLocks,turnEnded kind=stop status=finished; now actions= kind=stop status=working" }
    ])
  })

  it('flags a status line that stops arriving, and a screen Combwork no longer recognises or reads differently, never a status marker that timing hid', () => {
    const noLine = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), stop(), ready()])
    expect(compareContract(base, noLine)).toEqual([{ level: 'change', event: 'statusline statusline', what: 'no longer arrives' }])
    // Combwork's ready marker comes and goes with timing (a transcript can make the agent ready first): never required.
    const noReady = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), stop(), line])
    expect(compareContract(base, noReady)).toEqual([])
    // What Combwork recognised on the screen is: a prompt or footer no longer recognised is a change.
    const shown: ConsoleFixture['events'][number] = { kind: 'terminal', name: 'prompt shown', made: { recognised: 'prompt' } }
    const seen: ConsoleFixture['events'][number] = { kind: 'terminal', name: 'footer seen', raw: { footer: 'accept-edits' }, made: { recognised: 'footer', permissionMode: 'accept-edits' } }
    const withScreen = fixture([...base.events, shown, seen])
    expect(compareContract(withScreen, fixture([...base.events, seen]))).toEqual([{ level: 'change', event: 'terminal prompt shown', what: 'Combwork no longer recognises it on the screen' }])
    expect(compareContract(withScreen, fixture([...base.events, shown, { ...seen, made: { recognised: 'footer', permissionMode: 'plan' } }]))).toEqual([{ level: 'change', event: 'terminal footer seen', what: "Combwork's reading changed: it was permissionMode=accept-edits recognised=footer; now permissionMode=plan recognised=footer" }])
    const waiting = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' } }), stop(), ready('waiting'), line])
    expect(compareContract(base, waiting)).toEqual([{ level: 'change', event: 'terminal ready', what: "Combwork's reading changed: it was status=ready; now status=waiting" }])
  })

  it('only flags what is new: a new hook, a new field, a value where there was none, a further reading', () => {
    const live = fixture([pre({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '<path>' }, effort: 'high' }), stop(), stop('finished', ['releaseLocks', 'turnEnded', 'notifyFinished']), ready(), line, { kind: 'hook', name: 'Notification', raw: { hook_event_name: 'Notification' } }])
    expect(compareContract(base, live)).toEqual([
      { level: 'new', event: 'hook PreToolUse', what: 'field effort is new' },
      { level: 'new', event: 'hook Stop', what: 'Combwork also reads it as actions=releaseLocks,turnEnded,notifyFinished kind=stop status=finished' },
      { level: 'new', event: 'hook Notification', what: 'arrives now, and is not in the fixture' }
    ])
    const wasNull = fixture([pre({ hook_event_name: 'PreToolUse', model: null })])
    expect(compareContract(wasNull, fixture([pre({ hook_event_name: 'PreToolUse', model: 'opus' })]))).toEqual([])
  })

  it("doesn't hold a transcript read's records, or what varies in a reading, to the fixture", () => {
    const read = (newest: unknown[]): ConsoleFixture['events'][number] => ({ kind: 'transcript', name: 'transcript', raw: { records: newest.length, newest } })
    expect(compareContract(fixture([read([{ type: 'user', data: { text: '<text: 3 chars>' } }])]), fixture([read([{ type: 'session.usage_record', data: { usage: { inputTokens: 1 } } }])]))).toEqual([])
    expect(readingOf({ event: { kind: 'prompt', text: '<text: 9 chars>' }, status: 'working', was: 'ask', note: '<text: 4 chars>', actions: ['prompted'] })).toBe('actions=prompted kind=prompt status=working')
  })

  it("merges a field's types over a list's items", () => {
    expect(Object.fromEntries([...shapeOf([{ a: [{ b: 1 }, { b: 'x' }] }])].map(([k, v]) => [k, [...v]]))).toEqual({ a: ['array'], 'a[]': ['object'], 'a[].b': ['number', 'string'] })
  })
})

describe('recording names', () => {
  it('order by when each started, to the millisecond, then by their number within it, newest first', () => {
    const at = new Date(2026, 9, 12, 12, 0, 0, 5)
    const names = [recordingName(at, 1, 'session'), recordingName(at, 2, 'combwork'), recordingName(at, 10, 'session'), recordingName(new Date(at.getTime() + 1), 1, 'assistant'), recordingName(new Date(at.getTime() - 1000), 3, 'session'), 'notes.txt']
    expect(names[0]).toBe('console-20261012-120000-005-session.jsonl')
    expect(names[2]).toBe('console-20261012-120000-005-10-session.jsonl')
    expect(newestRecordingsFirst(names)).toEqual([names[3], names[2], names[1], names[0], names[4]])
  })
})

describe('diagnosticRecording', () => {
  it("takes a redacted recording's newest events, every string redacted again", async () => {
    const part = diagnosticRecording(await record(false), (s) => s.split(alpha).join('<folder>').replace('alpha · B1', '<agent>'))
    expect(part?.lines).toHaveLength(3)
    expect(part?.summary).toMatch(/^session source \(claude-code\), started 2026-10-12T09:00:00.000Z, Combwork 0.7.0; 3 events, ended \(stopped\); CLIs: claude-code 2.1.296 \(tested with 2.1.296\); redacted; the newest 3$/)
    expect(part?.lines.join('\n')).not.toContain(alpha.replace(/\\/g, '\\\\'))
    // Its paths (cwd, transcript_path) go whole (HI-2332), before redact sees them.
    expect(part?.lines.join('\n')).toContain('"cwd":"<path>"')
  })

  it("replaces every path's whole value with <path>, as the capture recorded it, wherever it is (HI-2332)", () => {
    // As Copy Diagnostics redacts: names, folders, secrets; a project named like a folder in the paths, as round 1 found.
    const ctx: RedactContext = { home: 'C:\\Users\\Example', folders: ['D:\\Work\\Demo'], names: [{ name: 'Cedar', as: '<project>' }] }
    const paths = [
      'E:/Clients/Cedar Research/acquisition.txt', // another drive, spaces, a name in it
      'E:\\Clients\\Cedar\\acquisition.txt',
      '\\\\fileserver\\Clients\\Cedar Research\\deal.docx', // a share
      'E:/Builds/0123456789abcdef0123456789abcdef/Cedar Research/acquisition.txt', // masked by the capture (round 2)
      'C:\\Users\\Example\\Documents\\Cedar Research\\notes.txt', // home, outside the CLIs' folders
      'D:\\Work\\Demo\\src\\a.ts' // a known folder: a path all the same
    ]
    // As the console captures a hook (sessions.ts): HOOK_FIELDS, no text. A path in a field kept for another reason (`source`) too.
    const events = paths.map((p, i) => makeEvent(i + 1, '2026-11-02T10:00:00.000Z', A1, { kind: 'hook', name: 'PreToolUse', summary: 'PreToolUse', raw: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', cwd: p, transcript_path: p, source: p, tool_input: { file_path: p, path: p, notebook_path: p, content: 'x' } }, safe: { raw: HOOK_FIELDS } }))
    expect(events[3].raw).toMatchObject({ tool_input: { file_path: 'E:/Builds/<redacted>/Cedar Research/acquisition.txt' } })
    const recording = [header(), ...events.map((e) => ({ type: 'event', ...e }))].map((l) => JSON.stringify(l)).join('\n')
    const part = diagnosticRecording(recording, (s) => redact(s, ctx))!
    expect(part.lines).toHaveLength(paths.length)
    const text = part.lines.join('\n')
    for (const word of ['Clients', 'Cedar', 'Research', 'acquisition', 'Builds', 'fileserver', 'deal', 'Documents', 'notes', 'src', 'a.ts', '<project>', '<redacted>']) expect(text).not.toContain(word)
    for (const line of part.lines) {
      const raw = JSON.parse(line).raw
      expect(raw).toEqual({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', cwd: '<path>', transcript_path: '<path>', source: '<path>', tool_input: { file_path: '<path>', path: '<path>', notebook_path: '<path>', content: raw.tool_input.content } })
      expect(raw.tool_input.content).not.toBe('<path>')
    }
  })

  it('never takes a recording with text, and keeps to its count', async () => {
    expect(diagnosticRecording(await record(true), (s) => s)).toBeNull()
    const many = [header(), ...Array.from({ length: DIAGNOSTIC_LINES + 50 }, (_, i) => ({ type: 'event', seq: i + 1, at: '', kind: 'hook', name: 'Stop', summary: '' }))].map((l) => JSON.stringify(l)).join('\n')
    const part = diagnosticRecording(many, (s) => s)
    expect(part?.lines).toHaveLength(DIAGNOSTIC_LINES)
    expect(JSON.parse(part!.lines.at(-1)!).seq).toBe(DIAGNOSTIC_LINES + 50)
  })

  it('keeps to its bound in UTF-8 bytes, line ends included, whatever the characters', () => {
    const utf8 = (s: string): number => new TextEncoder().encode(s).length
    for (const ch of ['文', '😀', 'é']) {
      const big = [header(), ...Array.from({ length: 40 }, (_, i) => ({ type: 'event', seq: i + 1, at: '', kind: 'hook', name: 'Stop', summary: ch.repeat(1800) }))].map((l) => JSON.stringify(l)).join('\n')
      const part = diagnosticRecording(big, (s) => s)!
      const size = part.lines.reduce((n, l) => n + utf8(l) + 1, 0)
      expect(size).toBeLessThanOrEqual(DIAGNOSTIC_BYTES)
      // As many as fit: one more would not.
      expect(size + utf8(part.lines[0]) + 1).toBeGreaterThan(DIAGNOSTIC_BYTES)
    }
  })
})
