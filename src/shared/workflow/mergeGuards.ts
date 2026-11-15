// Merge guards (HI-3284, design HI-3284/s16, HR2's OK): patterns a project's merge refuses in the lines it adds. Each
// guard is a regular expression (with a case flag), the paths it applies to and skips (globs), and a message saying what
// to do instead. Only added text lines are matched, never paths and never what the target already has (Darren's rule of
// 6 Nov: "no new X" guards check the change; sweeps clean what exists). Not a rule (left out of every ruleset): the merge
// queue and jj's candidate checks read the guards as the options are when they check, and a result counts only for the
// guards it was checked with (`guardsKey`).
//
// Here, everything that needs no process: the shape and its bounds, checked when saved without running a pattern; the
// globs; the unified-diff parser (Git's and jj's git format); the matching, which runs in a worker thread
// (mergeGuardsWorker.ts), never on main's thread; and the report, for agents and the window.

import { msg, type Msg } from '../i18n/msg'
// Types only from advanced.ts: it loads the translations, which the agent-facing scripts reaching options.ts must not.
import type { Text } from '../advanced'
import { agentMsg, say } from '../agentText'

/** FNV-1a over a text (compile.ts's stableHash, kept here: options.ts imports this module, and compile.ts imports options.ts). */
function hashOf(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn
  return h.toString(16).padStart(16, '0')
}

/** One guard (Version Control → Workflow → Merge guards). */
export interface MergeGuard {
  /** A short label, shown in refusals. */
  name: string
  /** A JavaScript regular expression, compiled with the `u` flag. */
  pattern: string
  /** Adds the `i` flag. */
  ignoreCase?: boolean
  /** Globs it applies to; none: every file. */
  paths?: string[]
  /** Globs it skips. */
  skip?: string[]
  /** What to do instead. */
  message: string
}

/** The bounds a guard list is saved within (HR2's round 1, point 4). */
export const GUARD_LIMITS = { guards: 50, name: 80, message: 1000, pattern: 500, globs: 50, glob: 260 } as const

/** The check's name in the merge checks' records and a returned card (the failed-check route, design (b)). */
export const MERGE_GUARDS_CHECK = 'merge guards' // i18n-ignore: a check's name, the same in every language as check names are

/** At most this many hits are kept in a report; the rest are counted (`more`). */
export const GUARD_HITS_KEPT = 50
/** A hit's excerpt: at most this many characters around the match. */
export const GUARD_EXCERPT = 160

/** Why a guard list can't be saved: which guard (its index), which field and why. */
export interface GuardProblem {
  guard: number
  field: 'list' | 'name' | 'pattern' | 'message' | 'paths' | 'skip'
  why: 'notList' | 'tooMany' | 'notGuard' | 'empty' | 'tooLong' | 'invalid' | 'glob' | 'tooManyGlobs' | 'matchesEmpty' | 'timedOut' // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
  /** The engine's message for an invalid pattern, or the glob refused. */
  detail?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The guards options hold, as they apply: none when unset or not a list. */
export function guardsOf(o: { mergeGuards?: unknown } | null | undefined): MergeGuard[] {
  return Array.isArray(o?.mergeGuards) ? (o.mergeGuards as MergeGuard[]) : []
}

/** A guard's pattern compiled as it is matched (throws for an invalid one). */
export function compileGuard(g: Pick<MergeGuard, 'pattern' | 'ignoreCase'>): RegExp {
  return new RegExp(g.pattern, g.ignoreCase ? 'iu' : 'u')
}

/** The guards as one key: what a result was checked with (a list in another order, or a changed guard, is another key). */
export function guardsKey(guards: readonly MergeGuard[]): string {
  if (!guards.length) return ''
  const norm = guards.map((g) => ({ name: g.name, pattern: g.pattern, ignoreCase: !!g.ignoreCase, paths: g.paths ?? [], skip: g.skip ?? [], message: g.message }))
  // Each object built in one key order, so the JSON is canonical.
  return hashOf(JSON.stringify(norm))
}

const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Why a glob is refused, or null: only `*`, `**`, `?`, `{a,b}` (not nested) and plain path characters, `/` between
 * segments; no `[`, `]` or `\`, no leading `/`, no empty segment and no `..`.
 */
export function globProblem(glob: unknown): string | null {
  if (typeof glob !== 'string' || !glob.length) return 'empty' // i18n-ignore: a problem's code
  if (glob.length > GUARD_LIMITS.glob) return 'tooLong' // i18n-ignore: a problem's code
  if (CONTROL.test(glob) || /[[\]\\]/.test(glob)) return 'character' // i18n-ignore: a problem's code
  if (glob.startsWith('/')) return 'absolute' // i18n-ignore: a problem's code
  const segments = glob.split('/')
  if (segments.some((s) => !s.length)) return 'emptySegment' // i18n-ignore: a problem's code
  if (segments.some((s) => s === '..' || s === '.')) return 'dots' // i18n-ignore: a problem's code
  let depth = 0
  for (const c of glob) {
    if (c === '{') {
      if (depth) return 'braces' // i18n-ignore: a problem's code
      depth++
    } else if (c === '}') {
      if (!depth) return 'braces' // i18n-ignore: a problem's code
      depth--
    } else if (c === '/' && depth) return 'braces' // i18n-ignore: a problem's code
  }
  return depth ? 'braces' : null // i18n-ignore: a problem's code
}

const REGEX_SPECIAL = /[.+^$()|]/g

/** A segment's glob as a regular expression's source (one segment: no `/`). */
function segmentSource(seg: string): string {
  let out = ''
  let i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === '*') {
      out += '[^/]*'
      while (seg[i] === '*') i++
      continue
    }
    if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = seg.indexOf('}', i)
      out += `(?:${seg
        .slice(i + 1, end)
        .split(',')
        .map((alt) => segmentSource(alt))
        .join('|')})`
      i = end + 1
      continue
    } else out += c.replace(REGEX_SPECIAL, '\\$&')
    i++
  }
  return out
}

/**
 * A glob as a regular expression over a path, case-insensitive (Windows' paths). A glob without a `/` matches a file's
 * or folder's name at any depth (as .gitignore does); with one, the path from the project's root. `**` is any number of
 * folders. A glob that matches a folder matches everything in it.
 */
export function globRegExp(glob: string): RegExp {
  const segs = glob.split('/')
  const anchored = segs.length > 1
  const parts: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const last = i === segs.length - 1
    if (s === '**') parts.push(last ? '.*' : '(?:[^/]+/)*')
    else parts.push(segmentSource(s) + (last ? '' : '/'))
  }
  const body = parts.join('')
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}(?:/.*)?$`, 'i')
}

/** Whether a guard applies to a path (`/` between folders): one of its paths (or none given), and none of its skips. */
export function guardApplies(g: Pick<MergeGuard, 'paths' | 'skip'>, path: string): boolean {
  const p = path.replace(/\\/g, '/')
  if (g.paths?.length && !g.paths.some((x) => globRegExp(x).test(p))) return false
  return !(g.skip ?? []).some((x) => globRegExp(x).test(p))
}

/**
 * Why a guard list can't be saved, without running a pattern on anything (HR2's round 1, point 4): its shape and bounds,
 * each pattern compiled (compiling is cheap; matching runs in the worker), and each glob. The empty-match rule needs a
 * match, so it is the worker's (`emptyMatchProblems`, mergeGuardsRun.ts), at save, off main's thread.
 */
export function guardProblems(v: unknown): GuardProblem[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) return [{ guard: -1, field: 'list', why: 'notList' }] // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
  if (v.length > GUARD_LIMITS.guards) return [{ guard: -1, field: 'list', why: 'tooMany' }] // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
  const out: GuardProblem[] = []
  v.forEach((g: unknown, i) => {
    if (!isRecord(g) || typeof g.name !== 'string' || typeof g.pattern !== 'string' || typeof g.message !== 'string' || (g.ignoreCase !== undefined && typeof g.ignoreCase !== 'boolean')) {
      out.push({ guard: i, field: 'list', why: 'notGuard' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      return
    }
    const text = (field: 'name' | 'message' | 'pattern', max: number): void => {
      const s = g[field] as string
      if (!s.trim()) out.push({ guard: i, field, why: 'empty' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      else if ([...s].length > max) out.push({ guard: i, field, why: 'tooLong' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
    }
    text('name', GUARD_LIMITS.name)
    text('message', GUARD_LIMITS.message)
    text('pattern', GUARD_LIMITS.pattern)
    if (g.pattern.trim() && [...g.pattern].length <= GUARD_LIMITS.pattern) {
      try {
        compileGuard(g as unknown as MergeGuard)
      } catch (e) {
        out.push({ guard: i, field: 'pattern', why: 'invalid', detail: e instanceof Error ? e.message : String(e) }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
      }
    }
    for (const field of ['paths', 'skip'] as const) {
      const list = g[field]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        out.push({ guard: i, field, why: 'notGuard' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
        continue
      }
      if (list.length > GUARD_LIMITS.globs) {
        out.push({ guard: i, field, why: 'tooManyGlobs' }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
        continue
      }
      const bad = list.find((x) => globProblem(x) !== null)
      if (bad !== undefined) out.push({ guard: i, field, why: 'glob', detail: typeof bad === 'string' ? bad : JSON.stringify(bad) }) // i18n-ignore: a problem's code (GUARD_PROBLEMS has its message)
    }
  })
  return out
}

/**
 * Whether a value is a guard list as options hold one (each with a name, a pattern and a message), what a level takes as
 * read: what else a save can't take is `guardProblems`' to say, each by its message (checkOptions). A guard that can't
 * compile, read from a hand-edited file, makes the check incomplete, which refuses the merge (never passes it).
 */
export const takesGuards = (v: unknown): boolean => Array.isArray(v) && v.every((g) => isRecord(g) && typeof g.name === 'string' && typeof g.pattern === 'string' && typeof g.message === 'string')

/** Why a guard can't be saved, in a sentence naming it (a message for the window, its English for agents). */
export const GUARD_PROBLEMS = {
  notList: msg({ id: 'workflow.mergeGuards.problem.notList', defaultMessage: 'The merge guards aren’t a list of guards.', description: 'Why workflow options cannot be saved (HI-3284): the merge guards option is not a list. A merge guard is a pattern Combwork refuses in the lines a merge adds.' }),
  tooMany: msg({ id: 'workflow.mergeGuards.problem.tooMany', defaultMessage: 'There are more than {max, number} merge guards.', description: 'Why workflow options cannot be saved (HI-3284): too many merge guards. {max} is the most a project takes.' }),
  notGuard: msg({ id: 'workflow.mergeGuards.problem.notGuard', defaultMessage: 'Merge guard {n, number} isn’t a guard: it needs a name, a pattern and a message.', description: 'Why workflow options cannot be saved (HI-3284): an entry of the merge guards has the wrong shape. {n} is its position, from 1.' }),
  empty: msg({ id: 'workflow.mergeGuards.problem.empty', defaultMessage: 'Merge guard {n, number} has no {field, select, name {name} pattern {pattern} other {message}}.', description: 'Why workflow options cannot be saved (HI-3284): a merge guard’s name, pattern or message is empty (select: translate each; keep the keys). {n} is its position, from 1.' }),
  tooLong: msg({ id: 'workflow.mergeGuards.problem.tooLong', defaultMessage: 'The {field, select, name {name} pattern {pattern} other {message}} of merge guard {n, number} is longer than {max, number} characters.', description: 'Why workflow options cannot be saved (HI-3284): a merge guard’s name, pattern or message is too long (select: translate each; keep the keys). {n} is its position, from 1; {max} the most characters it takes.' }),
  invalid: msg({ id: 'workflow.mergeGuards.problem.invalid', defaultMessage: 'The pattern of merge guard {n, number} isn’t a regular expression JavaScript takes: {detail}', description: 'Why workflow options cannot be saved (HI-3284): a merge guard’s pattern does not compile. {n} is its position, from 1; {detail} is the JavaScript engine’s own message, in English.' }),
  glob: msg({ id: 'workflow.mergeGuards.problem.glob', defaultMessage: 'Merge guard {n, number} has a path it can’t use: “{detail}”. Paths take *, **, ? and {braces} only, with / between folders, and no leading /, .. or [ ].', description: 'Why workflow options cannot be saved (HI-3284): a merge guard’s path (a glob, such as docs/** or *.md) uses something unsupported. {n} is its position, from 1; {detail} is the path as written. {braces} stands for the text "{a,b}": keep it as it is.' }),
  tooManyGlobs: msg({ id: 'workflow.mergeGuards.problem.tooManyGlobs', defaultMessage: 'Merge guard {n, number} has more than {max, number} paths in one list.', description: 'Why workflow options cannot be saved (HI-3284): a merge guard lists too many paths it applies to or skips. {n} is its position, from 1; {max} the most.' }),
  matchesEmpty: msg({ id: 'workflow.mergeGuards.problem.matchesEmpty', defaultMessage: 'The pattern of merge guard {n, number} matches an empty line, so it would refuse every line.', description: 'Why workflow options cannot be saved (HI-3284): a merge guard’s pattern matches the empty string. {n} is its position, from 1.' }),
  timedOut: msg({ id: 'workflow.mergeGuards.problem.timedOut', defaultMessage: 'The pattern of merge guard {n, number} took too long to check.', description: 'Why workflow options cannot be saved (HI-3284): checking a merge guard’s pattern ran past its time limit (a pattern that backtracks a lot). {n} is its position, from 1.' })
} satisfies Record<GuardProblem['why'], Msg>

/** A guard problem as text (a message and its values). The `{braces}` placeholder is the literal `{a,b}`. */
export const guardProblemText = (p: GuardProblem): Text => ({ m: GUARD_PROBLEMS[p.why], values: { n: p.guard + 1, field: p.field, max: p.field === 'list' ? GUARD_LIMITS.guards : p.why === 'tooManyGlobs' ? GUARD_LIMITS.globs : p.field === 'name' ? GUARD_LIMITS.name : p.field === 'pattern' ? GUARD_LIMITS.pattern : GUARD_LIMITS.message, detail: p.detail ?? '', braces: '{a,b}' } })

// ---- The added lines of a diff ----

/** A file's added text lines (1-based numbers in the result). */
export interface AddedFile {
  path: string
  lines: { n: number; text: string }[]
}

/** The most bytes of diff a check reads (with the lines' bound, Settings → Advanced): past it, incomplete. */
export const GUARD_DIFF_BYTES = 64 * 1024 * 1024

/** The added lines of a diff, or why they couldn't all be read (never a partial answer). */
export type AddedLines = { files: AddedFile[]; lines: number } | { incomplete: string }

/** C-quoted path (git's `"a/caf\303\251"`) as text; an unquoted one as it is. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw
  const bytes: number[] = []
  const s = raw.slice(1, raw.endsWith('"') ? -1 : undefined)
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const o = /^[0-7]{3}/.exec(s.slice(i + 1))
      if (o) {
        bytes.push(parseInt(o[0], 8))
        i += 3
        continue
      }
      const e = simple[s[i + 1]]
      if (e !== undefined) {
        bytes.push(e)
        i++
        continue
      }
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** A `--- `/`+++ ` side's path without its prefix (`a/`, `b/`), or null for /dev/null. */
function sidePath(raw: string): string | null {
  const t = raw.replace(/\t.*$/, '')
  if (t === '/dev/null') return null
  const p = unquotePath(t)
  return p.replace(/^[ab]\//, '')
}

/**
 * The lines a unified diff adds, by file (Git's `git diff -U0` and jj's `jj diff --git`): files with no added text lines
 * are left out (a deletion, a pure rename, a binary file). CRLF's carriage return is dropped from a line, as is the
 * `\ No newline at end of file` marker. Anything it can't follow (a hunk's line that isn't one, a hunk with no file) is
 * incomplete; so is a diff past `maxLines` added lines.
 */
export function parseAddedLines(diff: string, maxLines = Infinity): AddedLines {
  const files: AddedFile[] = []
  let file: AddedFile | null = null
  let header = false
  let oldLeft = 0
  let newLeft = 0
  let n = 0
  let count = 0
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0]
      if (c === '+') {
        if (!file || newLeft <= 0) return { incomplete: 'malformed' } // i18n-ignore: a reason's code
        if (++count > maxLines) return { incomplete: 'tooManyLines' } // i18n-ignore: a reason's code
        file.lines.push({ n: n++, text: line.slice(1).replace(/\r$/, '') })
        newLeft--
      } else if (c === '-') {
        if (oldLeft <= 0) return { incomplete: 'malformed' } // i18n-ignore: a reason's code
        oldLeft--
      } else if (c === ' ') {
        if (oldLeft <= 0 || newLeft <= 0) return { incomplete: 'malformed' } // i18n-ignore: a reason's code
        oldLeft--
        newLeft--
        n++
      } else if (c === '\\') continue
      else return { incomplete: 'malformed' } // i18n-ignore: a reason's code
      continue
    }
    if (line.startsWith('\\')) continue
    if (line.startsWith('diff --git ')) {
      file = null
      header = true
      continue
    }
    if (header && line.startsWith('--- ')) continue
    if (header && line.startsWith('+++ ')) {
      const p = sidePath(line.slice(4))
      file = p === null ? null : { path: p, lines: [] }
      if (file) files.push(file)
      continue
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (h) {
      header = false
      oldLeft = h[1] === undefined ? 1 : Number(h[1])
      newLeft = h[3] === undefined ? 1 : Number(h[3])
      n = Number(h[2])
      // A hunk that adds needs its file (a deletion's adds nothing: newLeft 0).
      if (newLeft > 0 && !file) return { incomplete: 'malformed' } // i18n-ignore: a reason's code
      continue
    }
    // Any other header line (index, mode, similarity, rename, Binary files … differ) is read past.
    if (header) continue
    return { incomplete: 'malformed' } // i18n-ignore: a reason's code
  }
  if (oldLeft > 0 || newLeft > 0) return { incomplete: 'truncated' } // i18n-ignore: a reason's code
  return { files: files.filter((f) => f.lines.length), lines: count }
}

// ---- Matching (in the worker) ----

/** One match: the guard, the file and line, and an excerpt around it (at most GUARD_EXCERPT characters). */
export interface GuardHit {
  guard: string
  file: string
  line: number
  excerpt: string
}

/**
 * What a guard check came to: its hits (at most GUARD_HITS_KEPT, `more` past them), each matching guard's message, or
 * why it couldn't finish (`incomplete`: never a pass, never a match).
 */
export interface GuardReport {
  hits: GuardHit[]
  more: number
  messages: { guard: string; message: string }[]
  incomplete?: string
}

/** The excerpt of a line around a match, at most GUARD_EXCERPT characters, "…" where it was cut. */
export function excerptOf(text: string, at: number, length: number): string {
  const clean = text.replace(/\t/g, ' ')
  if (clean.length <= GUARD_EXCERPT) return clean.trim()
  const room = Math.max(0, GUARD_EXCERPT - Math.min(length, GUARD_EXCERPT))
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), clean.length - GUARD_EXCERPT))
  const to = Math.min(clean.length, from + GUARD_EXCERPT)
  return `${from > 0 ? '…' : ''}${clean.slice(from, to).trim()}${to < clean.length ? '…' : ''}`
}

/**
 * The guards over the added lines, every line matched whole (HR2's round 1, point 1). `onGuard` is told which guard runs
 * (so a time limit can name it). A guard whose pattern matches the empty string is incomplete, never run.
 */
export function matchGuards(files: readonly AddedFile[], guards: readonly MergeGuard[], onGuard?: (name: string) => void): GuardReport {
  const hits: GuardHit[] = []
  let more = 0
  const matched = new Set<string>()
  for (const g of guards) {
    onGuard?.(g.name)
    let re: RegExp
    try {
      re = compileGuard(g)
    } catch (e) {
      return { hits: [], more: 0, messages: [], incomplete: `invalid:${g.name}:${e instanceof Error ? e.message : String(e)}` } // i18n-ignore: a reason's code and the engine's words
    }
    if (re.test('')) return { hits: [], more: 0, messages: [], incomplete: `matchesEmpty:${g.name}` } // i18n-ignore: a reason's code
    for (const f of files) {
      if (!guardApplies(g, f.path)) continue
      for (const l of f.lines) {
        const m = re.exec(l.text)
        if (!m) continue
        matched.add(g.name)
        if (hits.length < GUARD_HITS_KEPT) hits.push({ guard: g.name, file: f.path, line: l.n, excerpt: excerptOf(l.text, m.index, m[0].length) })
        else more++
      }
    }
  }
  return { hits, more, messages: guards.filter((g) => matched.has(g.name)).map((g) => ({ guard: g.name, message: g.message })) }
}

/** Whether a report refuses the merge: a match, or a check that couldn't finish. */
export const guardsRefuse = (r: GuardReport): boolean => !!r.incomplete || r.hits.length > 0

// ---- The report, for agents ----

const G = {
  matched: agentMsg({ id: 'mergeGuards.matched', text: 'merge guard "{guard}" matches {count, plural, one {a line} other {# lines}} it adds', note: 'HI-3284: what came back from a merge (the failure, after "came back:"): a merge guard (a pattern the project refuses in the lines a merge adds) matched. {guard}: its name. {count}: lines matched.' }),
  matchedMany: agentMsg({ id: 'mergeGuards.matchedMany', text: 'merge guards {guards} match {count, plural, one {a line} other {# lines}} it adds', note: 'HI-3284: as mergeGuards.matched, several guards. {guards}: their names, quoted and comma-joined. {count}: lines matched.' }),
  incomplete: agentMsg({ id: 'mergeGuards.incomplete', text: "the merge guards couldn't finish ({why}), so nothing was proved", note: 'HI-3284: what came back: the merge guards check could not finish: never a pass and never a match. {why}: mergeGuards.why.*.' }),
  hit: agentMsg({ id: 'mergeGuards.hit', text: '{file}:{line}: {excerpt}', note: 'HI-3284: one line a merge guard matched, in a returned card’s log: the file, the line number, and the line around the match (its own text).' }),
  more: agentMsg({ id: 'mergeGuards.more', text: 'and {count, plural, one {# more line} other {# more lines}}', note: 'HI-3284: past the lines listed, how many more a merge guard matched.' }),
  todo: agentMsg({ id: 'mergeGuards.todo', text: '"{guard}": {message}', note: 'HI-3284: a matching merge guard and its message (the user’s own words: what to do instead), at the end of a returned card’s log.' }),
  warning: agentMsg({ id: 'mergeGuards.warning', text: 'Merge guards: {failure} since its merge base ({where}). The merge will refuse it if it is still there when merged.', note: 'HI-3284: cw_submit’s early warning (never a refusal): a merge guard matched what the submitted revision adds since its merge base with the target. {failure}: mergeGuards.matched or .matchedMany. {where}: the first file:line matched.' }),
  warningIncomplete: agentMsg({ id: 'mergeGuards.warningIncomplete', text: "Merge guards: couldn't check this revision ({why}); the merge checks them.", note: 'HI-3284: cw_submit’s early warning when the merge guards could not be checked at submit. {why}: mergeGuards.why.*.' })
}

const WHY = {
  timedOut: agentMsg({ id: 'mergeGuards.why.timedOut', text: 'guard "{guard}" ran past its time limit', note: 'HI-3284: why the merge guards check could not finish: a guard’s pattern ran past the time limit (Settings → Advanced). {guard}: its name.' }),
  tooLarge: agentMsg({ id: 'mergeGuards.why.tooLarge', text: 'the merge adds more than the guards check', note: 'HI-3284: why the merge guards check could not finish: the merge adds more text or lines than the limits (Settings → Advanced).' }),
  unreadable: agentMsg({ id: 'mergeGuards.why.unreadable', text: "the merge's changes couldn't be read", note: 'HI-3284: why the merge guards check could not finish: the version control could not give the merge’s changes (a temporary failure).' }),
  malformed: agentMsg({ id: 'mergeGuards.why.malformed', text: "the merge's changes couldn't be followed", note: 'HI-3284: why the merge guards check could not finish: the diff the version control gave could not be parsed whole.' }),
  matchesEmpty: agentMsg({ id: 'mergeGuards.why.matchesEmpty', text: 'guard "{guard}" matches an empty line', note: 'HI-3284: why the merge guards check could not finish: a guard’s pattern matches the empty string (it would refuse every line). {guard}: its name.' }),
  invalid: agentMsg({ id: 'mergeGuards.why.invalid', text: 'guard "{guard}" has an invalid pattern', note: 'HI-3284: why the merge guards check could not finish: a guard’s pattern does not compile. {guard}: its name.' }),
  failed: agentMsg({ id: 'mergeGuards.why.failed', text: 'its worker ended', note: 'HI-3284: why the merge guards check could not finish: the thread that matches the guards ended unexpectedly.' })
}

/** An incomplete reason (`code` or `code:guard[:detail]`) in English. */
export function incompleteText(reason: string): string {
  const [code, guard = ''] = reason.split(':')
  const m = WHY[code as keyof typeof WHY] ?? WHY.failed
  return say(m, { guard })
}

/** What came back, in a phrase (for "came back: …" and the submit warning). */
export function guardFailureText(r: GuardReport): string {
  if (r.incomplete) return say(G.incomplete, { why: incompleteText(r.incomplete) })
  const count = r.hits.length + r.more
  const names = [...new Set(r.hits.map((h) => h.guard))]
  return names.length === 1 ? say(G.matched, { guard: names[0], count }) : say(G.matchedMany, { guards: names.map((n) => `"${n}"`).join(', '), count })
}

/** The report's lines, as a returned card's log carries them: each hit, then each matching guard's message last. */
export function guardReportLog(r: GuardReport): string {
  if (r.incomplete) return guardFailureText(r)
  return [...r.hits.map((h) => say(G.hit, { file: h.file, line: h.line, excerpt: h.excerpt })), ...(r.more ? [say(G.more, { count: r.more })] : []), ...r.messages.map((m) => say(G.todo, { guard: m.guard, message: m.message }))].join('\n')
}

/** cw_submit's early warning for a report that refuses (never a refusal itself). */
export function guardWarning(r: GuardReport): string {
  if (r.incomplete) return say(G.warningIncomplete, { why: incompleteText(r.incomplete) })
  const first = r.hits[0]
  return say(G.warning, { failure: guardFailureText(r), where: first ? `${first.file}:${first.line}` : '' })
}

// ---- The example guard (Darren's decision, 15 Nov) ----

/** The characters a regular expression with the `u` flag takes escaped (only these: `\-` is an error there). */
const ESCAPED = /[\^$\\.*+?()[\]{}|/]/g

/**
 * The pattern of a name as a whole word, case-sensitive: the name escaped, its spaces any whitespace, between Unicode
 * letter, number and underscore boundaries (so "Dr." or "Zoë" match as they appear, HR2's OK note).
 */
export function namePattern(name: string): string {
  const body = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(ESCAPED, '\\$&'))
    .join('\\s+')
  return `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`
}

/** The files the example guard skips: where a name belongs (a licence, a manifest's author, the installer's copyright). */
export const NAME_GUARD_SKIPS = ['LICENSE*', 'package.json', 'electron-builder.yml', 'CODE_OF_CONDUCT*'] as const

/** Whether the example guard is offered: a name is set (not empty and not the default, "User"). */
export const offersNameGuard = (name: string | null | undefined): boolean => !!name?.trim() && name.trim() !== 'User'

/** The example guard for a name, filled once (no link to the setting): its label and message given in the user's language. */
export function nameGuard(name: string, label: string, message: string): MergeGuard {
  return { name: label, pattern: namePattern(name), skip: [...NAME_GUARD_SKIPS], message }
}
