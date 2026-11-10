// The Version Control tab's jj views (HI-2799, J6): read-only, every read pinned at the single operation head through J3's
// JjReads (`--at-op` with J0's `--ignore-working-copy`: no snapshot, no merge of several heads, R5.3), answered only
// while the heads are still that one, and only by the pinned jj. With none or several heads nothing is read (unknown).
// Off main: each is jj processes in jj's worker. Nothing here writes, snapshots or changes a bookmark.

import { join } from 'path'
import { PLATFORMS } from '../../shared/platform/descriptors'
import { isJjViewUnknown, JJ_CONFLICTS_MAX, JJ_DIFF_MAX, JJ_HISTORY_MAX, jjRevisionInput, type JjBookmarkRow, type JjBookmarksView, type JjCompareView, type JjConflictsView, type JjHistoryView, type JjRepoView, type JjResolved, type JjRow, type JjView, type JjViewUnknown, type JjWorkspaceRow } from '../../shared/jjViews'
import { jjContextOf, type JjContext } from './jjDetect'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, JjReads, type JjMaybe } from './jjReads'
import { CHANGE_ID, COMMIT_ID, readOpHeads } from './jjView'

const SEP = '\x1f'

/** One commit per line, fields apart by U+001F (descriptions and names as JSON strings, so no field holds the separator). */
export const ROW_TEMPLATE = [
  'commit_id',
  'change_id',
  'description.first_line().escape_json()',
  'author.name().escape_json()',
  'author.timestamp().utc().format("%Y-%m-%dT%H:%M:%SZ")',
  '"[" ++ bookmarks.map(|b| b.name().escape_json()).join(",") ++ "]"',
  'current_working_copy',
  'empty',
  'divergent',
  'conflict'
].join(` ++ "${SEP}" ++ `) + ' ++ "\\n"'

const json = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}
const bool = (s: string): boolean | null => (s === 'true' ? true : s === 'false' ? false : null)

/** Parses one ROW_TEMPLATE line, or null when any field isn't what it should be. */
export function parseRow(line: string): JjRow | null {
  const f = line.split(SEP)
  if (f.length !== 10) return null
  const [commit, change, desc, author, time, marks, wc, empty, divergent, conflict] = f
  const d = json(desc)
  const a = json(author)
  const b = json(marks)
  const flags = [wc, empty, divergent, conflict].map(bool)
  if (!COMMIT_ID.test(commit) || !CHANGE_ID.test(change) || typeof d !== 'string' || typeof a !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(time)) return null
  if (!Array.isArray(b) || !b.every((x) => typeof x === 'string') || flags.some((x) => x === null)) return null
  return { commit, change, description: d.slice(0, 500), author: a.slice(0, 200), time, bookmarks: b as string[], workingCopy: flags[0]!, empty: flags[1]!, divergent: flags[2]!, conflict: flags[3]! }
}

/** The root commit jj shows below everything (all zeros): never a row of its own. */
const isRoot = (r: JjRow): boolean => /^0+$/.test(r.commit)

const unknownOf = (u: { jjUnknown: string; detail?: string }): JjViewUnknown => ({ jjUnknown: u.jjUnknown as JjViewUnknown['jjUnknown'], ...(u.detail ? { detail: u.detail.slice(0, 2000) } : {}) })

/** A project folder's jj context, confirmed by jj (J0's detection): or why not. */
async function contextOf(folder: string, runner: JjRunner): Promise<JjContext | JjViewUnknown> {
  const d = await jjContextOf(folder, runner)
  if ('jj' in d) return d.jj
  if ('none' in d) return { jjUnknown: 'noRepo' }
  return { jjUnknown: d.unknown, ...(d.detail ? { detail: d.detail.slice(0, 2000) } : {}) }
}

/** Reads for a context, run in its workspace root. */
const readsOf = (c: JjContext, runner: JjRunner): JjReads => new JjReads({ folder: c.root, jjRepo: c.jjRepo }, runner)

async function rowsAt(reads: JjReads, op: string, revset: string, max: number): Promise<JjMaybe<{ rows: JjRow[]; capped: boolean }>> {
  const out = await reads.run(op, ['log', '--no-graph', '-r', revset, '-n', String(max + 1), '-T', ROW_TEMPLATE])
  if (isJjUnknown(out)) return out
  const lines = out.split('\n').filter(Boolean)
  const rows = lines.map(parseRow)
  if (!rows.every((r): r is JjRow => r !== null)) return { jjUnknown: 'malformed', detail: 'logRow' } // i18n-ignore: a protocol code
  const shown = rows.filter((r) => !isRoot(r))
  return { rows: shown.slice(0, max), capped: shown.length > max }
}

/** The Repository section. */
export async function jjRepoView(folder: string, runner: JjRunner = jjRunner): Promise<JjView<JjRepoView>> {
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const heads = readOpHeads(c.jjRepo)
  const base = { root: c.root, store: c.store, colocated: c.colocated, linked: c.linked, tool: c.tool, gates: PLATFORMS.jj.gates }
  if (!heads || heads.length !== 1) return { ...base, op: null, heads: heads?.length ?? 0, workspaces: { jjUnknown: 'heads', detail: heads ? `${heads.length}` : 'unreadable' } } // i18n-ignore: a protocol code
  const reads = readsOf(c, runner)
  const ws = await reads.pinned(async (op): Promise<JjMaybe<JjWorkspaceRow[]>> => {
    const out = await reads.run(op, ['workspace', 'list', '-T', `name.escape_json() ++ "${SEP}" ++ target.commit_id() ++ "${SEP}" ++ target.change_id() ++ "\\n"`])
    if (isJjUnknown(out)) return out
    const rows: JjWorkspaceRow[] = []
    for (const l of out.split('\n').filter(Boolean)) {
      const [n, commit, change] = l.split(SEP)
      const name = json(n ?? '')
      if (typeof name !== 'string' || !COMMIT_ID.test(commit ?? '') || !CHANGE_ID.test(change ?? '')) return { jjUnknown: 'malformed', detail: 'workspaceList' } // i18n-ignore: a protocol code
      rows.push({ name, commit, change })
    }
    return rows
  })
  return { ...base, op: isJjUnknown(ws) ? null : ws.op, heads: 1, workspaces: isJjUnknown(ws) ? unknownOf(ws) : ws.value }
}

/** The History section: the project workspace's ancestry and every bookmark's, newest first, a page of JJ_HISTORY_MAX. */
export async function jjHistory(folder: string, runner: JjRunner = jjRunner): Promise<JjView<JjHistoryView>> {
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned((op) => rowsAt(reads, op, '::@ | ::bookmarks()', JJ_HISTORY_MAX))
  return isJjUnknown(r) ? unknownOf(r) : { op: r.op, ...r.value }
}

/** Parses `bookmark list -a` lines (BOOKMARK_TEMPLATE), or null when malformed. */
export function parseBookmarkRows(out: string): JjBookmarkRow[] | null {
  const rows: JjBookmarkRow[] = []
  for (const l of out.split('\n')) {
    if (!l) continue
    const f = l.split(SEP)
    if (f.length !== 6) return null
    const [n, remote, conflict, commit, change, added] = f
    const name = json(n)
    const c = bool(conflict)
    const sides = added ? added.split(',') : []
    if (typeof name !== 'string' || c === null || (commit && !COMMIT_ID.test(commit)) || (change && !CHANGE_ID.test(change)) || !sides.every((s) => COMMIT_ID.test(s))) return null
    rows.push({ name, remote: remote || null, conflict: c, commit: commit || null, change: change || null, sides: c ? sides : [] })
  }
  return rows
}

export const BOOKMARK_TEMPLATE = [
  'name.escape_json()',
  'if(remote, remote, "")',
  'conflict',
  'if(normal_target, normal_target.commit_id(), "")',
  'if(normal_target, normal_target.change_id(), "")',
  'added_targets.map(|c| c.commit_id()).join(",")'
].join(` ++ "${SEP}" ++ `) + ' ++ "\\n"'

/**
 * Each local bookmark against Git (colocated): its `@git` remote-tracking target as jj last saw it, and the branch Git
 * has now (`refs/heads/<name>`, read from the files: loose or packed). A difference is shown, never resolved.
 */
async function markGit(c: JjContext, rows: JjBookmarkRow[]): Promise<void> {
  const tracked = new Map(rows.filter((r) => r.remote === 'git').map((r) => [r.name, r.commit]))
  const refs = c.colocated ? await gitBranches(c.store) : null
  for (const r of rows) {
    if (r.remote !== null || r.conflict) continue
    const git = tracked.get(r.name)
    const now = refs?.get(r.name)
    if (git === undefined || git !== r.commit || (refs && now !== r.commit)) r.gitDiffers = true
  }
}

/** Git's local branches, read from the store's files (no process): loose refs win over packed ones. Null if unreadable. */
export async function gitBranches(store: string): Promise<Map<string, string> | null> {
  const { readFile, readdir } = await import('original-fs/promises')
  const out = new Map<string, string>()
  const packed = await readFile(join(store, 'packed-refs'), 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : null))
  if (packed === null) return null
  for (const l of packed.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40}) refs\/heads\/(.+)$/.exec(l)
    if (m) out.set(m[2], m[1])
  }
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const ents = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : null))
    if (!ents) return false
    for (const e of ents.slice(0, 4096)) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!(await walk(p, `${prefix}${e.name}/`))) return false
      } else if (e.isFile()) {
        const v = (await readFile(p, 'utf8').catch(() => null))?.trim()
        if (v && /^[0-9a-f]{40}$/.test(v)) out.set(`${prefix}${e.name}`, v)
      }
    }
    return true
  }
  return (await walk(join(store, 'refs', 'heads'), '')) ? out : null
}

/** The Bookmarks section: every bookmark, local and remote-tracking; conflicted ones with their sides. */
export async function jjBookmarks(folder: string, runner: JjRunner = jjRunner): Promise<JjView<JjBookmarksView>> {
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (op): Promise<JjMaybe<JjBookmarkRow[]>> => {
    const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_TEMPLATE])
    if (isJjUnknown(out)) return out
    return parseBookmarkRows(out) ?? { jjUnknown: 'malformed', detail: 'bookmarkList' } // i18n-ignore: a protocol code
  })
  if (isJjUnknown(r)) return unknownOf(r)
  await markGit(c, r.value)
  return { op: r.op, rows: r.value }
}

/**
 * A revision typed for Compare, resolved at `op` to exactly one commit. An id naming several (a divergent change id, an
 * ambiguous prefix) lists them all, for the user to pick one by its commit id; nothing is picked for them.
 */
export async function resolveAt(reads: JjReads, op: string, input: string): Promise<JjMaybe<JjResolved>> {
  const rev = input.trim()
  if (!jjRevisionInput(rev)) return { jjUnknown: 'malformed', detail: 'revision' } // i18n-ignore: a protocol code
  const one = await rowsAt(reads, op, rev, 16)
  if (!isJjUnknown(one)) return one.rows.length === 1 && !one.capped ? { commit: one.rows[0] } : one.rows.length === 0 ? { none: true } : { ambiguous: one.rows }
  const said = one.detail ?? ''
  if (/doesn't exist|didn't resolve|no such|not found/i.test(said)) return { none: true }
  if (!/divergent|ambiguous/i.test(said)) return one
  // Every commit the id could mean: a change id's (divergent) or a prefix's, change and commit ids alike.
  const hex = /^[0-9a-f]+$/.test(rev)
  const ch = /^[k-z]+$/.test(rev)
  if (!hex && !ch) return { jjUnknown: 'ambiguous', detail: said }
  const all = await rowsAt(reads, op, [ch ? `change_id(${rev})` : null, hex ? `commit_id(${rev})` : null].filter(Boolean).join(' | '), 16)
  return isJjUnknown(all) ? { jjUnknown: 'ambiguous', detail: said } : { ambiguous: all.rows }
}

/** What a Compare reads: each side resolved, or why it couldn't be. */
export type JjCompareAnswer = JjView<JjCompareView | { from: JjResolved; to: JjResolved; op: string }>

/** The Compare section: two revisions resolved to one commit each, then what changed between them (capped). */
export async function jjCompare(folder: string, from: string, to: string, runner: JjRunner = jjRunner): Promise<JjCompareAnswer> {
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (op): Promise<JjMaybe<JjCompareView | { from: JjResolved; to: JjResolved; op: string }>> => {
    const a = await resolveAt(reads, op, from)
    if (isJjUnknown(a)) return a
    const b = await resolveAt(reads, op, to)
    if (isJjUnknown(b)) return b
    if (!('commit' in a) || !('commit' in b)) return { from: a, to: b, op }
    const summary = await reads.run(op, ['diff', '--from', a.commit.commit, '--to', b.commit.commit, '--summary'])
    if (isJjUnknown(summary)) return summary
    const files = summary
      .split('\n')
      .filter(Boolean)
      .map((l) => /^([MADRC]) (.+)$/.exec(l))
    if (!files.every((m) => m)) return { jjUnknown: 'malformed', detail: 'diffSummary' } // i18n-ignore: a protocol code
    const diff = await reads.run(op, ['diff', '--from', a.commit.commit, '--to', b.commit.commit, '--git'])
    if (isJjUnknown(diff)) return diff
    return { op, from: a.commit, to: b.commit, files: files.map((m) => ({ status: m![1], path: m![2] })), diff: diff.slice(0, JJ_DIFF_MAX), capped: diff.length > JJ_DIFF_MAX }
  })
  if (isJjUnknown(r)) return unknownOf(r)
  return 'files' in r.value ? r.value : { ...r.value, op: r.op }
}

/** The Conflicts section: the commits storing conflicts among the history's, each with its conflicted files. */
export async function jjConflicts(folder: string, runner: JjRunner = jjRunner): Promise<JjView<JjConflictsView>> {
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (op): Promise<JjMaybe<Omit<JjConflictsView, 'op'>>> => {
    const found = await rowsAt(reads, op, 'conflicts() & (::@ | ::bookmarks())', JJ_CONFLICTS_MAX)
    if (isJjUnknown(found)) return found
    const rows: JjConflictsView['rows'] = []
    for (const row of found.rows) {
      const out = await reads.run(op, ['resolve', '--list', '-r', row.commit])
      const files = isJjUnknown(out) ? unknownOf(out) : out.split('\n').filter(Boolean).map((l) => l.replace(/\s{2,}.*$/, '').trim())
      rows.push({ row, files })
    }
    return { rows, capped: found.capped }
  })
  return isJjUnknown(r) ? unknownOf(r) : { op: r.op, ...r.value }
}
