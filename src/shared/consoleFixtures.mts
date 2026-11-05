/**
 * Developer console recordings as files (#366 decision 5, #638): the JSON Lines a recording is written in, turning a
 * recording into a fixture (tests/fixtures/console/), comparing what a CLI sends now with a fixture (the contract tests),
 * and the part of a recording Copy Diagnostics attaches. No imports, so plain Node runs it as it is
 * (scripts/consoleFixture.mjs, the contract suites), and Hive and the unit tests share it.
 */

/** The recording file's format, in its first line. */
export const RECORDING_FORMAT = 1

/** A recording's first line: what was recorded, with which Hive and CLIs, and whether text is in it. */
export interface RecordingHeader {
  type: 'recording'
  format: number
  combwork: string
  startedAt: string
  source: { kind: string; label: string; provider?: string }
  /** Prompt and reply text kept (the user's opt-in for this recording); secrets are masked either way. */
  text: boolean
  /** Each coding agent's CLI as installed when it started, and the version this Hive release was tested with. */
  clis: { provider: string; version: string | null; tested: string | null }[]
  /** A flight recorder capture (#698): the trigger that fired and what it saw, in English. */
  capture?: { trigger: string; what: string; whatText?: unknown }
}

/** One event as the console captured it (`ConsoleEvent`), a line each. */
export interface RecordedEvent {
  type: 'event'
  seq: number
  at: string
  source?: string
  kind: string
  name: string
  provider?: string
  summary: string
  raw?: unknown
  made?: unknown
  bytes?: number
  truncated?: true
}

/** A recording's last line, once it stopped: why, and how many events it holds and lost. */
export interface RecordingEnd {
  type: 'end'
  at: string
  events: number
  dropped: number
  reason: 'stopped' | 'closed' | 'workspace' | 'limit' | 'failed' | 'captured'
  /** Why a failed recording failed. */
  error?: string
}

export interface Recording {
  header: RecordingHeader | null
  events: RecordedEvent[]
  end: RecordingEnd | null
  /** Lines that weren't JSON or no known type (a recording cut short as Hive quit ends mid-line). */
  bad: number
}

export function parseRecording(text: string): Recording {
  const out: Recording = { header: null, events: [], end: null, bad: 0 }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let v: { type?: unknown }
    try {
      v = JSON.parse(line)
    } catch {
      out.bad++
      continue
    }
    if (v?.type === 'recording' && !out.header) out.header = v as RecordingHeader
    else if (v?.type === 'event') out.events.push(v as RecordedEvent)
    else if (v?.type === 'end') out.end = v as RecordingEnd
    else out.bad++
  }
  return out
}

// --- Fixtures

/** A recording made into a test fixture: what the CLI sent and what Hive made of it, with no machine's paths. */
export interface ConsoleFixture {
  format: number
  provider: string | null
  /** The CLI's version it was recorded with. */
  cli: string | null
  combwork: string
  recordedAt: string
  events: FixtureEvent[]
}

export interface FixtureEvent {
  kind: string
  name: string
  raw?: unknown
  made?: unknown
}

/** What a fixture keeps: what the CLI sends and Hive's reading of it, not Hive's own work (API calls, lines it typed). */
export const FIXTURE_KINDS: readonly string[] = ['hook', 'statusline', 'transcript', 'terminal', 'launch', 'exit']

/** An absolute path (a drive, a UNC share, or a POSIX root) as a whole string. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/

/** Every absolute path in a value becomes "<path>": a fixture is committed, and paths name the machine and its user. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return ABSOLUTE_PATH.test(v) ? '<path>' : v
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
  return v
}

/**
 * A recording as a fixture: its events of the kinds a fixture keeps, in order, without times, sequence numbers or paths.
 * A recording with text is refused: fixtures are committed, and text is the user's.
 */
export function recordingToFixture(text: string): ConsoleFixture {
  const r = parseRecording(text)
  if (!r.header) throw new Error('Not a developer console recording: its first line should be the recording header.')
  if (r.header.text) throw new Error('This recording includes prompt and reply text, so it can’t become a fixture: record again without text.')
  const provider = r.header.source.provider ?? r.events.find((e) => e.provider)?.provider ?? null
  const events = r.events.filter((e) => FIXTURE_KINDS.includes(e.kind)).map((e) => ({ kind: e.kind, name: e.name, ...(e.raw !== undefined ? { raw: scrub(e.raw) } : {}), ...(e.made !== undefined ? { made: scrub(e.made) } : {}) }))
  if (!events.length) throw new Error('The recording has no events from a CLI to make a fixture of.')
  return {
    format: RECORDING_FORMAT,
    provider,
    cli: r.header.clis.find((c) => c.provider === provider)?.version ?? null,
    combwork: r.header.combwork,
    recordedAt: r.header.startedAt,
    events
  }
}

// --- Contract tests

/** What changed between a fixture and what a CLI sends now: a change breaks the contract, something new is only flagged. */
export interface ContractFinding {
  level: 'change' | 'new'
  /** "hook PreToolUse". */
  event: string
  what: string
}

/**
 * The kinds whose arrival is part of the contract, for a scripted run: a hook, status line, launch or exit that stops
 * arriving is a change. A transcript read holds whichever records were newest at that moment, so only a new one is
 * flagged.
 */
export const CONTRACT_KINDS: readonly string[] = ['hook', 'statusline', 'launch', 'exit']
/**
 * The terminal markers that say only whether Hive recognised the CLI's screen (once a launch, whatever its status:
 * screenRecognition.ts): one that stops arriving means the CLI's prompt or footer changed. The others (ready, footer
 * mode, title, startup question) are what Hive did with the screen at the time, so they come and go with timing: their
 * readings are compared where both runs have them, and they are never required.
 */
export const RECOGNITION_MARKERS: readonly string[] = ['prompt shown', 'footer seen']
const required = (e: FixtureEvent): boolean => CONTRACT_KINDS.includes(e.kind) || (e.kind === 'terminal' && RECOGNITION_MARKERS.includes(e.name))
/** The kinds whose fields are part of it: a field gone or retyped is a change. A terminal marker's are Hive's own. */
export const SHAPE_KINDS: readonly string[] = ['hook', 'statusline', 'launch', 'exit']
/** The kinds whose reading is part of it: what Hive made of the event (its kind, status, actions and the like). */
export const READING_KINDS: readonly string[] = ['hook', 'terminal', 'launch', 'exit']
/** Parts of what Hive made of an event that vary from run to run, or are the CLI's text, never its reading. */
const VARYING = new Set(['text', 'lastMessage', 'was', 'at', 'seq'])

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** A value's field paths and their types ("tool_input.file_path" → "string"; a list's items under "[]"), merged over values. */
export function shapeOf(values: unknown[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (path: string, v: unknown): void => {
    const t = typeOf(v)
    if (path) out.set(path, (out.get(path) ?? new Set()).add(t))
    if (t === 'array') for (const x of v as unknown[]) add(`${path}[]`, x)
    else if (t === 'object') for (const [k, x] of Object.entries(v as object)) add(path ? `${path}.${k}` : k, x)
  }
  for (const v of values) if (v !== undefined) add('', v)
  return out
}

/**
 * What Hive made of an event, as one line: its plain fields (a status, a mode, a flag), a hook's event kind and its
 * actions (in order), leaving out text, hidden values and what varies between runs. "kind=stop status=finished
 * actions=releaseLocks,notifyFinished,turnEnded".
 */
export function readingOf(made: unknown): string {
  if (!made || typeof made !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(made as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    if (VARYING.has(k)) continue
    if (k === 'event' && v && typeof v === 'object') {
      const kind = (v as { kind?: unknown }).kind
      if (typeof kind === 'string') parts.push(`kind=${kind}`)
    } else if (k === 'actions' && Array.isArray(v)) parts.push(`actions=${v.filter((x) => typeof x === 'string').join(',')}`)
    else if (typeof v === 'boolean' || (typeof v === 'string' && !v.startsWith('<'))) parts.push(`${k}=${v}`)
  }
  return parts.sort().join(' ')
}

const groupBy = (events: FixtureEvent[]): Map<string, FixtureEvent[]> => {
  const out = new Map<string, FixtureEvent[]>()
  for (const e of events) {
    const k = `${e.kind} ${e.name}`
    out.set(k, [...(out.get(k) ?? []), e])
  }
  return out
}

/** A field path's parent: "" for a top-level field, "a" for "a.b" and "a[]", "a[]" for "a[].b". */
const parentOf = (path: string): string => path.replace(/(?:^|\.)[^.[\]]+$|\[\]$/, '')

/**
 * Compares what a CLI sends now (`live`, a fixture made from a new recording of the same scripted run) with a recorded
 * fixture. Per event (its kind and name), these are changes: one that no longer arrives (CONTRACT_KINDS, and the
 * terminal's RECOGNITION_MARKERS), a field gone or of another type (SHAPE_KINDS), and a reading of the fixture's that
 * Hive no longer makes where both runs have the event (READING_KINDS: another event kind, status, actions or mode). A
 * new event, field or reading is flagged as new. A field gone with a new one beside it, of the same type, is named as a
 * possible rename.
 */
export function compareContract(fixture: ConsoleFixture, live: ConsoleFixture): ContractFinding[] {
  const findings: ContractFinding[] = []
  const before = groupBy(fixture.events)
  const now = groupBy(live.events)
  for (const [event, was] of before) {
    const kind = was[0].kind
    const is = now.get(event)
    if (!is) {
      if (required(was[0])) findings.push({ level: 'change', event, what: kind === 'terminal' ? 'Combwork no longer recognises it on the screen' : 'no longer arrives' })
      continue
    }
    if (SHAPE_KINDS.includes(kind)) {
      const a = shapeOf(was.map((e) => e.raw))
      const b = shapeOf(is.map((e) => e.raw))
      const gone = [...a.keys()].filter((p) => !b.has(p))
      const added = [...b.keys()].filter((p) => !a.has(p))
      for (const p of gone) {
        const twin = added.find((q) => parentOf(q) === parentOf(p) && [...a.get(p)!].join() === [...b.get(q)!].join())
        findings.push({ level: 'change', event, what: `field ${p} is gone${twin ? ` (renamed to ${twin}?)` : ''}` })
      }
      for (const p of added) findings.push({ level: 'new', event, what: `field ${p} is new` })
      for (const [p, types] of a) {
        const t = b.get(p)
        if (!t) continue
        const lost = [...types].filter((x) => !t.has(x))
        // A field that was always null or absent and now has a value is new information, not a break.
        if (lost.length && !(lost.length === 1 && lost[0] === 'null')) findings.push({ level: 'change', event, what: `field ${p} was ${[...types].join(' or ')}, now ${[...t].join(' or ')}` })
      }
    }
    if (READING_KINDS.includes(kind)) {
      const ra = new Set(was.map((e) => readingOf(e.made)).filter(Boolean))
      const rb = new Set(is.map((e) => readingOf(e.made)).filter(Boolean))
      const lost = [...ra].filter((x) => !rb.has(x))
      const gained = [...rb].filter((x) => !ra.has(x))
      if (lost.length) findings.push({ level: 'change', event, what: `Combwork's reading changed: it was ${lost.join(' | ')}; now ${[...rb].join(' | ') || 'none'}` })
      else if (gained.length) findings.push({ level: 'new', event, what: `Combwork also reads it as ${gained.join(' | ')}` })
    }
  }
  for (const [event] of now) if (!before.has(event)) findings.push({ level: 'new', event, what: 'arrives now, and is not in the fixture' })
  return findings
}

// --- Recording files

/** A recording's file name: when it started, to the millisecond, a number when another took that millisecond, its kind. */
export function recordingName(at: Date, n: number, kind: string): string {
  const p = (x: number, w = 2): string => String(x).padStart(w, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}-${p(at.getMilliseconds(), 3)}`
  return `console-${stamp}${n > 1 ? `-${n}` : ''}-${kind.replace(/[^a-z]/g, '') || 'source'}.jsonl`
}

const RECORDING_NAME = /^console-(\d{8})-(\d{6})-(\d{3})(?:-(\d+))?-[a-z]+\.jsonl$/

/** Whether a file name is one of Hive's recordings. */
export const isRecordingName = (name: string): boolean => RECORDING_NAME.test(name)

/** Recordings' file names, newest first: by the time each started, then by its number within that millisecond. */
export function newestRecordingsFirst(names: string[]): string[] {
  const key = (name: string): [string, number] => {
    const m = RECORDING_NAME.exec(name)
    return m ? [`${m[1]}${m[2]}${m[3]}`, Number(m[4] ?? 1)] : ['', 0]
  }
  return names
    .filter(isRecordingName)
    .map((name) => ({ name, k: key(name) }))
    .sort((a, b) => (a.k[0] === b.k[0] ? b.k[1] - a.k[1] : a.k[0] < b.k[0] ? 1 : -1))
    .map((x) => x.name)
}

// --- Copy Diagnostics

/** At most this much of a recording goes into Copy Diagnostics: its newest events, in UTF-8 bytes with their line ends. */
export const DIAGNOSTIC_LINES = 200
export const DIAGNOSTIC_BYTES = 64 * 1024

const utf8 = new TextEncoder()

/**
 * The fields of an event's payload whose value is a path: those devConsole.ts's safe fields keep one in (a hook's tool
 * input, its transcript and folder, a status line's folders, a CLI's file), at any depth.
 */
export const PATH_FIELDS: ReadonlySet<string> = new Set(['file_path', 'notebook_path', 'path', 'transcript_path', 'transcriptPath', 'cwd', 'current_dir', 'project_dir', 'file'])
/** A value that starts as an absolute path does (a drive's, a share's, a home-relative one), in whatever field the capture kept it. */
const PATH_START = /^\s*(?:[A-Za-z]:[\\/]|[\\/]{2}|~[\\/])/

/**
 * Every string through `fn`, but a path's whole value is `<path>` (HI-2332): by its field, or by how it starts. Never by
 * finding where a path ends in it, which a name or a mask put in it by redaction made fail twice.
 */
function mapStrings(v: unknown, fn: (s: string) => string, inPath = false): unknown {
  if (typeof v === 'string') return v && (inPath || PATH_START.test(v)) ? '<path>' : fn(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn, inPath))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn, inPath || PATH_FIELDS.has(k))]))
  return v
}

/**
 * The part of a recording Copy Diagnostics attaches: a line about it and its newest events (within DIAGNOSTIC_LINES, and
 * DIAGNOSTIC_BYTES of UTF-8 with a line end each), every string passed through `redact` (names, folders, secrets), and
 * every path `<path>` whole, wherever it is (mapStrings). Null for a recording with text, which is never attached.
 */
export function diagnosticRecording(text: string, redact: (s: string) => string): { summary: string; lines: string[] } | null {
  const r = parseRecording(text)
  if (!r.header || r.header.text) return null
  const lines: string[] = []
  let bytes = 0
  for (let i = r.events.length - 1; i >= 0 && lines.length < DIAGNOSTIC_LINES; i--) {
    const line = JSON.stringify(mapStrings(r.events[i], redact))
    const size = utf8.encode(line).length + 1
    if (bytes + size > DIAGNOSTIC_BYTES) break
    bytes += size
    lines.unshift(line)
  }
  const h = r.header
  const clis = h.clis.filter((c) => c.version).map((c) => `${c.provider} ${c.version}${c.tested ? ` (tested with ${c.tested})` : ''}`)
  const end = r.end ? `${r.end.events} events, ended (${r.end.reason})${r.end.dropped ? `, ${r.end.dropped} lost` : ''}` : `${r.events.length} events, not ended`
  const summary = redact(`${h.capture ? `capture (${h.capture.trigger}: ${h.capture.what}) of a ` : ''}${h.source.kind} source${h.source.provider ? ` (${h.source.provider})` : ''}, started ${h.startedAt}, Combwork ${h.combwork}; ${end}; CLIs: ${clis.join(', ') || 'none found'}; redacted; the newest ${lines.length}`)
  return { summary, lines }
}
