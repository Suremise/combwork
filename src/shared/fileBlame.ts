// HI-3476: blame by card in the Files tab's viewer (SPEC §8, Blame by card): which commit last changed each line of
// the file as it is in the editor, and that commit's own card and the agent that submitted it (HI-3475's rules), else
// the commit and its author. The parsing here is pure; gitFileBlame.ts runs git, fileBlamePanel.ts adds the cards.

import type { FileHistoryCard, FileHistoryFile, FileHistoryRow } from './fileHistory'

/** The id git gives lines that no commit has yet (the editor's own edits, uncommitted changes). */
export const UNCOMMITTED = '0'.repeat(40)

/** A commit blame names, as the annotations show it. */
export interface BlameCommit {
  hash: string
  author: string
  email: string
  /** When it was authored, ms since the epoch. */
  date: number
  subject: string
  /** The commit before it that held these lines, and the path the file had there (null: it added them). */
  previous: { commit: string; path: string } | null
  /** The file's path at this commit, from the repository's top. */
  path: string
  card: FileHistoryCard | null
  submittedBy: { agent: string; name: string } | null
}

/** A run of lines (`start`, 1-based, and `count`) one commit last changed; `commit` null for lines not committed yet. */
export interface BlameBlock {
  start: number
  count: number
  commit: string | null
}

/** `files:blame`'s answer. */
export type BlameResult =
  | { kind: 'blame'; blocks: BlameBlock[]; commits: Record<string, BlameCommit> }
  /** The file has more lines than Settings → Advanced's limit: blame it only once asked again with `large`. */
  | { kind: 'large'; lines: number; limit: number }
  /** Git doesn't track the file (new, ignored) or the folder has no commits: nothing to blame. */
  | { kind: 'untracked' }

/** The reads port's blame (its `fileBlame`): the blocks, and each commit with its `Combwork-Card` trailer's values. */
export type BlameRead = { kind: 'blame'; blocks: BlameBlock[]; commits: (BlamedCommit & { trailer: string })[] } | { kind: 'untracked' }

/** A commit as `git blame --incremental` gives it, before its card is found. */
export interface BlamedCommit {
  hash: string
  author: string
  email: string
  date: number
  subject: string
  previous: { commit: string; path: string } | null
  path: string
}

/**
 * `git blame --incremental`'s output: each group is a header (`<sha> <original line> <final line> <lines>`), the commit's
 * details the first time it appears, and its `filename` line, which ends the group. Blocks come back sorted by line,
 * adjacent runs of one commit joined.
 */
export function parseIncrementalBlame(out: string): { blocks: BlameBlock[]; commits: Map<string, BlamedCommit> } {
  const commits = new Map<string, BlamedCommit>()
  const raw: { start: number; count: number; hash: string }[] = []
  let cur: { hash: string; start: number; count: number; info: Partial<BlamedCommit> & { previous?: BlamedCommit['previous'] } } | null = null
  for (const line of out.split(/\r?\n/)) {
    if (!cur) {
      const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ (\d+) (\d+)$/.exec(line)
      if (m) cur = { hash: m[1], start: Number(m[2]), count: Number(m[3]), info: {} }
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'author') cur.info.author = value
    else if (key === 'author-mail') cur.info.email = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') cur.info.date = (Number(value) || 0) * 1000
    else if (key === 'summary') cur.info.subject = value
    else if (key === 'previous') {
      const at = value.indexOf(' ')
      cur.info.previous = at < 0 ? null : { commit: value.slice(0, at), path: unquoteGitPath(value.slice(at + 1)) }
    } else if (key === 'filename') {
      const known = commits.get(cur.hash)
      if (!known) commits.set(cur.hash, { hash: cur.hash, author: cur.info.author ?? '', email: cur.info.email ?? '', date: cur.info.date ?? 0, subject: cur.info.subject ?? '', previous: cur.info.previous ?? null, path: unquoteGitPath(value) })
      else if (!known.previous && cur.info.previous) known.previous = cur.info.previous
      raw.push({ start: cur.start, count: cur.count, hash: cur.hash })
      cur = null
    }
  }
  raw.sort((a, b) => a.start - b.start)
  const blocks: BlameBlock[] = []
  for (const r of raw) {
    const commit = r.hash === UNCOMMITTED ? null : r.hash
    const last = blocks[blocks.length - 1]
    if (last && last.commit === commit && last.start + last.count === r.start) last.count += r.count
    else blocks.push({ start: r.start, count: r.count, commit })
  }
  return { blocks, commits }
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * A path as git prints it in blame's `filename` and `previous` (HR1's round 1 finding 1): quoted in C's way when it has
 * characters git escapes (a quote, a backslash, a control character, and with `core.quotePath` on any byte above 0x7f
 * as octal), else as it is. The quoted form's bytes are decoded as UTF-8.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p
  const s = p.slice(1, -1)
  const bytes: number[] = []
  const enc = new TextEncoder()
  let i = 0
  while (i < s.length) {
    const slash = s.indexOf('\\', i)
    const plainEnd = slash < 0 ? s.length : slash
    if (plainEnd > i) bytes.push(...enc.encode(s.slice(i, plainEnd)))
    if (slash < 0) break
    const n = s[slash + 1] ?? ''
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(slash + 1))![0]
      bytes.push(parseInt(oct, 8) & 0xff)
      i = slash + 1 + oct.length
    } else {
      bytes.push(ESCAPES[n] ?? n.charCodeAt(0))
      i = slash + 2
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The commit's diff of the file, as History opens one: its parent at the path it had there, the commit at its own. */
export function blamePick(c: BlameCommit): { row: FileHistoryRow; file: FileHistoryFile } {
  const renamed = c.previous && c.previous.path !== c.path ? c.previous.path : null
  const file: FileHistoryFile = { status: c.previous ? (renamed ? 'R' : 'M') : 'A', path: c.path, oldPath: renamed }
  const row: FileHistoryRow = { hash: c.hash, short: c.hash.slice(0, 7), parent: c.previous?.commit ?? null, author: c.author, email: c.email, date: c.date, subject: c.subject, files: [file], card: c.card, submittedBy: c.submittedBy }
  return { row, file }
}

/** How faded an annotation is by its age: 0 for the newest commit blamed, 1 for the oldest (none: all the same). */
export function ageShade(date: number, newest: number, oldest: number): number {
  if (newest <= oldest) return 0
  return Math.min(1, Math.max(0, (newest - date) / (newest - oldest)))
}
