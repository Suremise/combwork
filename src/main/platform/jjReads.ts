// jj's history reads, each pinned to one operation (SPEC §16.3.6 port 3, HI-2796's J3): `--at-op <the single head>`, which
// never snapshots, never brings a stale workspace up to date and never reconciles several heads by writing a merge
// operation (HI-2796's probe: `--ignore-working-copy` alone does, with two heads). With anything but exactly one head in
// the files (jjView.ts) nothing is read through jj. Every answer carries the operation it was read at, and is used only
// while the heads are still that one (`stillAt`). Answers are a value or a typed unknown (a protocol code, as J0's
// detection: never prose), and only the pinned jj version's answers are trusted (jjSupported).

import { jjSupported } from '../../shared/jjTool'
import { jjRunner, type JjRunner, type JjRunOptions } from './jjRunner'
import { CHANGE_ID, COMMIT_ID, readOpHeads, singleHead } from './jjView'

/**
 * Why a jj read couldn't answer: the heads not exactly one (`heads`), the tool not the pinned one (`tool`), a command that
 * didn't run to an exit or exited non-zero (`failed`), an answer it doesn't recognise (`malformed`), a revision that names
 * several commits (`ambiguous`: a divergent change id), none, or a read whose heads moved before it was used (`moved`).
 */
export type JjReadWhy = 'heads' | 'tool' | 'failed' | 'malformed' | 'ambiguous' | 'none' | 'moved'

export interface JjReadUnknown {
  jjUnknown: JjReadWhy
  detail?: string
}

export type JjMaybe<T> = T | JjReadUnknown

export const jjUnknown = (why: JjReadWhy, detail?: string): JjReadUnknown => ({ jjUnknown: why, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })
export const isJjUnknown = (v: unknown): v is JjReadUnknown => !!v && typeof v === 'object' && typeof (v as JjReadUnknown).jjUnknown === 'string'

/** Where reads are made: a folder of the workspace (jj runs there) and its shared repository (`.jj/repo`, the heads). */
export interface ReadsAt {
  folder: string
  jjRepo: string
}

/** An answer read at one operation. */
export interface Pinned<T> {
  op: string
  value: T
}

/** A commit as jj shows it: its immutable id and change id apart (the change id survives rewrites with new content). */
export interface JjCommit {
  commit: string
  change: string
  parents: string[]
  /** Its tree has no change from its single parent's (jj's `empty`). */
  empty: boolean
  /** Its change id names more than one visible commit. */
  divergent: boolean
  /** It stores conflicts. */
  conflict: boolean
}

/** The fields a commit read asks for, one line each, tab-separated. */
const COMMIT_TEMPLATE = 'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\t" ++ empty ++ "\\t" ++ divergent ++ "\\t" ++ conflict ++ "\\n"'

/** Parses one commit line, or null when any field isn't what it should be. */
export function parseCommitLine(line: string): JjCommit | null {
  const f = line.split('\t')
  if (f.length !== 6) return null
  const [commit, change, parents, empty, divergent, conflict] = f
  const ps = parents === '' ? [] : parents.split(',')
  const bool = (s: string): boolean | null => (s === 'true' ? true : s === 'false' ? false : null)
  const e = bool(empty)
  const d = bool(divergent)
  const c = bool(conflict)
  if (!COMMIT_ID.test(commit) || !CHANGE_ID.test(change) || !ps.every((p) => COMMIT_ID.test(p)) || e === null || d === null || c === null) return null
  return { commit, change, parents: ps, empty: e, divergent: d, conflict: c }
}

/** At most this many evolution entries are read; a read that reaches EVOLOG_MAX + 1 was capped, and isn't complete. */
export const EVOLOG_MAX = 100

/** A commit's evolution log as read: complete only when parsed in full, uncapped and starting at the commit itself. */
export interface Evolution {
  commit: string
  /** Every commit in its evolution (itself first), each as its commit and change ids. */
  entries: { commit: string; change: string }[]
}

export class JjReads {
  constructor(
    private readonly at: ReadsAt,
    private readonly runner: JjRunner = jjRunner,
    private readonly o: Pick<JjRunOptions, 'signal' | 'timeout'> = {}
  ) {}

  /** The single head now, from the files; unknown with none or several (nothing is read through jj then). */
  head(): JjMaybe<string> {
    const h = readOpHeads(this.at.jjRepo)
    if (!h) return jjUnknown('heads', 'unreadable')
    if (h.length !== 1) return jjUnknown('heads', `${h.length} heads`)
    return h[0]
  }

  /** Whether the heads are still exactly `op` (a pinned answer may be used). */
  stillAt(op: string): boolean {
    return singleHead(this.at.jjRepo) === op
  }

  /** Whether the tool is the pinned jj (checked when it hasn't been yet): only its answers, and its writes, are trusted. */
  async supported(): Promise<JjMaybe<true>> {
    const tool = this.runner.readinessNow().state === 'unknown' ? await this.runner.readiness() : this.runner.readinessNow()
    return jjSupported(tool) ? true : jjUnknown('tool', tool.state)
  }

  /** Runs a read pinned at `op`: its output, or why not. Only the pinned jj's answers count. */
  async run(op: string, args: readonly string[]): Promise<JjMaybe<string>> {
    const ok = await this.supported()
    if (isJjUnknown(ok)) return ok
    const r = await this.runner.run(this.at.folder, ['--at-op', op, ...args], this.o)
    if (!r.ok) return jjUnknown('failed', r.err)
    return r.out
  }

  /** Reads at the single head now, and checks it is still the head once read. */
  async pinned<T>(read: (op: string) => Promise<JjMaybe<T>>): Promise<JjMaybe<Pinned<T>>> {
    const op = this.head()
    if (isJjUnknown(op)) return op
    const value = await read(op)
    if (isJjUnknown(value)) return value
    if (!this.stillAt(op)) return jjUnknown('moved')
    return { op, value }
  }

  /**
   * One commit at `op`: named by its full commit id, or a revset that must give exactly one (a workspace's `<name>@`, a
   * change id). A divergent change id gives several, so it's `ambiguous`, never one picked.
   */
  async commitAt(op: string, rev: string): Promise<JjMaybe<JjCommit>> {
    const out = await this.run(op, ['log', '--no-graph', '-r', rev, '-n', '2', '-T', COMMIT_TEMPLATE])
    if (isJjUnknown(out)) {
      const said = out.detail ?? ''
      if (out.jjUnknown === 'failed' && /is divergent/i.test(said)) return jjUnknown('ambiguous', said)
      if (out.jjUnknown === 'failed' && /doesn't exist|didn't resolve/i.test(said)) return jjUnknown('none', said)
      return out
    }
    const lines = out.split('\n').filter(Boolean)
    if (lines.length === 0) return jjUnknown('none', rev)
    if (lines.length > 1) return jjUnknown('ambiguous', rev)
    return parseCommitLine(lines[0]) ?? jjUnknown('malformed', lines[0])
  }

  /** The commits a change id names at `op` (several when divergent), at most 16; more is unknown. */
  async changeAt(op: string, change: string): Promise<JjMaybe<JjCommit[]>> {
    if (!CHANGE_ID.test(change)) return jjUnknown('malformed', change)
    const out = await this.run(op, ['log', '--no-graph', '-r', `change_id(${change})`, '-n', '17', '-T', COMMIT_TEMPLATE])
    if (isJjUnknown(out)) return out
    const lines = out.split('\n').filter(Boolean)
    if (lines.length > 16) return jjUnknown('malformed', 'tooManyCommits')
    const cs = lines.map(parseCommitLine)
    return cs.every((c): c is JjCommit => c !== null) ? cs : jjUnknown('malformed', change)
  }

  /** A revision's tracked files at `op` (repository-relative, `/`-separated), at most `max`; more is unknown. */
  async filesAt(op: string, commit: string, max = 200_000): Promise<JjMaybe<string[]>> {
    if (!COMMIT_ID.test(commit)) return jjUnknown('malformed', commit)
    const out = await this.run(op, ['file', 'list', '-r', commit, '-T', 'path ++ "\\n"'])
    if (isJjUnknown(out)) return out
    const files = out.split('\n').filter(Boolean)
    return files.length > max ? jjUnknown('malformed', 'tooManyFiles') : files
  }

  /** A config value as jj applies it at `op` (every level, Combwork's overrides included), or unknown. */
  async configAt(op: string, name: string): Promise<JjMaybe<string>> {
    const out = await this.run(op, ['config', 'get', name])
    return isJjUnknown(out) ? out : out.trim()
  }

  /**
   * A commit's evolution at `op` (`jj evolog`): every commit it was rewritten from, squashed sources included (HI-2796's
   * probe: a squash's evolution merges both sides). Unknown unless complete: each line parsed, at most EVOLOG_MAX
   * entries (an EVOLOG_MAX + 1th means the read was capped), the first the commit itself.
   */
  async evolutionAt(op: string, commit: string): Promise<JjMaybe<Evolution>> {
    if (!COMMIT_ID.test(commit)) return jjUnknown('malformed', commit)
    const out = await this.run(op, ['evolog', '--no-graph', '-r', commit, '-n', String(EVOLOG_MAX + 1), '-T', 'commit.commit_id() ++ "\\t" ++ commit.change_id() ++ "\\n"'])
    if (isJjUnknown(out)) return out
    return parseEvolution(commit, out)
  }
}

/** Parses an evolution read (see evolutionAt): complete, or unknown saying why not. */
export function parseEvolution(commit: string, out: string): JjMaybe<Evolution> {
  const lines = out.split('\n').filter((l) => l !== '')
  if (lines.length > EVOLOG_MAX) return jjUnknown('malformed', 'capped')
  const entries: Evolution['entries'] = []
  for (const l of lines) {
    const [c, ch, ...rest] = l.split('\t')
    if (rest.length || !COMMIT_ID.test(c ?? '') || !CHANGE_ID.test(ch ?? '')) return jjUnknown('malformed', l)
    entries.push({ commit: c, change: ch })
  }
  if (entries[0]?.commit !== commit) return jjUnknown('malformed', 'notTheCommit')
  return { commit, entries }
}
