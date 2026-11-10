// The Operations section (HI-2800, J7; design HI-2800/s12, s16, s19): jj's operations, each named by what jj called it,
// and a preview of reverting one. Under Darren's decision A (HI-2794) Combwork runs no jj write: the preview is read, and
// the command it offers (`jj op revert <id>`) is the user's to run, only when E1–E7 (jjOpView.ts) all hold.
//
// Every read is pinned at the single operation head H through J3's JjReads (`--at-op H --ignore-working-copy`: no
// snapshot, no merge of diverged heads; probed on 0.47.1: `op log`, `debug object operation` and `debug object view`
// pinned write nothing), and the answer stands only while H is still the head (JjReads.pinned). The views' parse and
// comparison run on jj's worker (runner.preview).

import { isJjViewUnknown, JJ_OPERATIONS_MAX, type JjOperationPreview, type JjOperationRow, type JjOperationsView, type JjView } from '../../shared/jjViews'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, jjUnknown, type JjMaybe, type JjReads } from './jjReads'
import { contextOf, readsOf, staleAt, unknownOf } from './jjViews'
import { commitList, isOpId, OP_COMMITS_MAX, operationFacts, previewOf, revertCommand, soleParent, VIEW_TEXT_MAX, type OpCommits, type OperationFacts } from './jjOpView'

const SEP = '\x1f'

/** One operation a line: its id, parents, start (UTC), user, workspace, description's first line and snapshot flag. */
export const OP_ROW_TEMPLATE = [
  'id',
  'parents.map(|p| p.id()).join(",")',
  'time.start().utc().format("%Y-%m-%dT%H:%M:%SZ")',
  'user.escape_json()',
  'workspace_name.escape_json()',
  'description.first_line().escape_json()',
  'snapshot'
].join(` ++ "${SEP}" ++ `) + ' ++ "\\n"'

const json = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

/** Parses one OP_ROW_TEMPLATE line, or null when any field isn't what it should be. */
export function parseOpRow(line: string): JjOperationRow | null {
  const f = line.split(SEP)
  if (f.length !== 7) return null
  const [id, parents, time, user, workspace, desc, snapshot] = f
  const u = json(user)
  const w = json(workspace)
  const d = json(desc)
  const ps = parents ? parents.split(',') : []
  if (!isOpId(id) || !ps.every(isOpId) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(time) || typeof u !== 'string' || typeof w !== 'string' || typeof d !== 'string' || !/^(true|false)$/.test(snapshot)) return null
  return { id, parents: ps, time, user: u.slice(0, 200), workspace: w.slice(0, 200), description: d.slice(0, 500), snapshot: snapshot === 'true' }
}

/** A page of operations, newest first: from the head, or from `from` (a page's `next`) back. */
export async function jjOperations(folder: string, from?: string | null, runner: JjRunner = jjRunner): Promise<JjView<JjOperationsView>> {
  if (from && !isOpId(from)) return { jjUnknown: 'malformed', detail: 'from' } // i18n-ignore: a protocol code
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (op): Promise<JjMaybe<{ rows: JjOperationRow[]; next: string | null }>> => {
    // An older page is read at its own first operation: `op log` lists it and its ancestors (a read, nothing written).
    const out = await reads.run(from ?? op, ['op', 'log', '--no-graph', '-n', String(JJ_OPERATIONS_MAX + 1), '-T', OP_ROW_TEMPLATE])
    if (isJjUnknown(out)) return out
    const rows = out.split('\n').filter(Boolean).map(parseOpRow)
    if (!rows.every((x): x is JjOperationRow => x !== null)) return jjUnknown('malformed', 'opRow')
    return { rows: rows.slice(0, JJ_OPERATIONS_MAX), next: rows.length > JJ_OPERATIONS_MAX ? rows[JJ_OPERATIONS_MAX].id : null }
  })
  return isJjUnknown(r) ? unknownOf(r) : { op: r.op, ...r.value }
}

/** A refusal before anything is compared (E1 and E2), as a preview with no command. */
const refusedEarly = (at: string, op: string, facts: OperationFacts | null, refused: JjOperationPreview['refused'], detail?: string): JjOperationPreview => ({ at, op, description: facts?.description ?? '', did: [], commits: { added: [], hidden: [] }, later: [], command: null, refused, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })

/** A revset's commits at `at`, one more than the cap read so a list past it is known. */
async function commitsAt(reads: JjReads, at: string, revset: string): Promise<JjMaybe<string[]>> {
  const out = await reads.run(at, ['log', '--no-graph', '-r', revset, '-n', String(OP_COMMITS_MAX + 1), '-T', 'commit_id ++ "\\n"'])
  if (isJjUnknown(out)) return out
  return commitList(out) ?? jjUnknown('malformed', 'commitList')
}

/**
 * What reverting operation `op` would change, read at the single head. `at`: the head the window showed the preview at
 * (Copy's revalidation, s19): when the head is another now, the fresh preview comes back with no command (`moved`), for
 * the user to look at before copying again.
 */
export async function jjOperationPreview(folder: string, op: string, at?: string | null, runner: JjRunner = jjRunner): Promise<JjView<JjOperationPreview>> {
  if (!isOpId(op) || (at && !isOpId(at))) return { jjUnknown: 'malformed', detail: 'op' } // i18n-ignore: a protocol code
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (H): Promise<JjMaybe<JjOperationPreview>> => {
    const opText = await reads.run(H, ['debug', 'object', 'operation', op])
    if (isJjUnknown(opText)) return opText
    const facts = operationFacts(opText)
    if (!facts) return refusedEarly(H, op, null, 'shape')
    // E2: one parent (the root has none, a merge of operations two or more).
    const parent = soleParent(facts)
    if (!parent) return refusedEarly(H, op, facts, 'parents')
    const parentText = await reads.run(H, ['debug', 'object', 'operation', parent])
    const headText = await reads.run(H, ['debug', 'object', 'operation', H])
    if (isJjUnknown(parentText)) return parentText
    if (isJjUnknown(headText)) return headText
    const pf = operationFacts(parentText)
    const hf = operationFacts(headText)
    if (!pf || !hf) return refusedEarly(H, op, facts, 'shape')
    const views: string[] = []
    for (const id of [pf.view, facts.view, hf.view]) {
      const v = await reads.run(H, ['debug', 'object', 'view', id])
      if (isJjUnknown(v)) return v
      views.push(v)
    }
    if (views.some((v) => v.length > VIEW_TEXT_MAX)) return refusedEarly(H, op, facts, 'bounds')
    // What O made visible (A) and hid (D), and later work on them, all read at H. Visible is `::visible_heads()`, never
    // `all()`: jj's `all()` also takes in commits a revset names (probed on 0.47.1), so a hidden one would count as visible.
    const V = '::visible_heads()'
    const A = `(at_operation(${op}, ${V}) ~ at_operation(${parent}, ${V}))`
    const D = `(at_operation(${parent}, ${V}) ~ at_operation(${op}, ${V}))`
    const lists: (keyof OpCommits)[] = ['added', 'hidden', 'descendants', 'gone', 'back']
    const revsets = [A, D, `((${A} & ${V}):: ~ (${A} & ${V}))`, `(${A} ~ ${V})`, `(${D} & ${V})`]
    const commits = {} as OpCommits
    for (let i = 0; i < lists.length; i++) {
      const ids = await commitsAt(reads, H, revsets[i])
      if (isJjUnknown(ids)) return ids
      commits[lists[i]] = ids
    }
    const stale = await staleAt(reads, c.root, H)
    const input = { op, facts, parent, views: { parent: views[0], op: views[1], head: views[2] }, commits, stale }
    const core = await (runner.preview ? runner.preview(input) : Promise.resolve(previewOf(input)))
    return { at: H, op, description: facts.description, did: core.did, commits: core.commits, later: core.later, command: core.refused === null ? revertCommand(op) : null, refused: core.refused }
  })
  if (isJjUnknown(r)) return unknownOf(r)
  const p = r.value
  // Copy's revalidation: a head other than the one shown never hands out a command (s19).
  if (at && p.at !== at) return { ...p, command: null, refused: 'moved' }
  return p
}
