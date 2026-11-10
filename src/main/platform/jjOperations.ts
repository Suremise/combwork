// The Operations section (HI-2800, J7; design HI-2800/s12, s16, s19): jj's operations, each named by what jj called it,
// and a preview of reverting one. Under Darren's decision A (HI-2794) Combwork runs no jj write: the preview is read, and
// the command it offers (`jj op revert <id>`) is the user's to run, only when E1–E8 (jjOpView.ts) all hold.
//
// Every read is pinned at the single operation head H through J3's JjReads (`--at-op H --ignore-working-copy`: no
// snapshot, no merge of diverged heads; probed on 0.47.1: `op log`, `debug object operation` and `debug object view`
// pinned write nothing), and the answer stands only while H is still the head (JjReads.pinned). The views' parse and
// comparison run on jj's worker (runner.preview).
//
// Git's own state is part of the moment (HR2's HI-2800 rounds 1 and 2): a plain Git move jj hasn't imported leaves the
// operation heads as they were. Git's refs and HEAD are read (read-only git, `--no-optional-locks`, never an import) and
// compared with jj's record at H (E8), inside J5's verified capture (jjSourcesPrint.ts, HI-2798): a print of every
// source those reads rest on (the operation heads, HEAD, packed refs, every loose ref under refs/heads, refs/tags and
// refs/remotes, a reftable, the store's config) before and after them, equal, and the same print checked once more
// synchronously in the continuation that answers. The preview's `moment` hashes H, the print and Git's answers, and Copy
// sends it back.

import { createHash } from 'crypto'
import { join } from 'path'
import { git as gitRun } from '../git'
import { isJjViewUnknown, JJ_OPERATIONS_MAX, type JjOperationPreview, type JjOperationRow, type JjOperationsView, type JjView } from '../../shared/jjViews'
import { jjRunner, type JjRunner } from './jjRunner'
import { isJjUnknown, jjUnknown, type JjMaybe, type JjReads } from './jjReads'
import { contextOf, readsOf, staleAt, unknownOf } from './jjViews'
import { readCheckout, workspaceGitDir } from './jjView'
import { rawSourcesPrint } from './jjSourcesPrint'
import type { JjContext } from './jjDetect'
import { commitList, isOpId, OP_COMMITS_MAX, operationFacts, previewOf, revertCommand, soleParent, VIEW_TEXT_MAX, type OpCommits, type OperationFacts, type OpGitState } from './jjOpView'

const SEP = '\x1f'

/** One operation a line: its id, parents, start (UTC), user, workspace, description's first line and snapshot flag. */
export const OP_ROW_TEMPLATE = [
  'id',
  'parents.map(|p| p.id()).join(",")',
  'time.start().utc().format("%Y-%m-%dT%H:%M:%SZ")',
  'user.escape_json()',
  // jj 0.47.1 writes a workspace as `name@` here; the row keeps the name.
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
  return { id, parents: ps, time, user: u.slice(0, 200), workspace: w.replace(/@$/, '').slice(0, 200), description: d.slice(0, 500), snapshot: snapshot === 'true' }
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

/** A read-only git command in a folder (main's runner, `--no-optional-locks`); tests inject their own. */
export type GitRead = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; code?: number | null }>
const defaultGit: GitRead = async (cwd, args) => {
  const r = await gitRun(cwd, args)
  return { ok: r.ok, out: r.out, code: r.code }
}

const OID = /^[0-9a-f]{40}$/

/**
 * Git's actual state for E8 and the moment: the store's imported refs (an annotated tag with the commit it peels to) and,
 * colocated, the project workspace's HEAD (null when unborn). `text`: the raw answers, for the moment. Null when git
 * can't say.
 */
async function gitStateOf(c: JjContext, git: GitRead): Promise<{ state: OpGitState; text: string } | null> {
  const refs = await git(c.root, [`--git-dir=${c.store}`, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)', 'refs/heads', 'refs/tags', 'refs/remotes'])
  if (!refs.ok) return null
  const rows: OpGitState['refs'] = []
  for (const line of refs.out.split(/\r?\n/).filter(Boolean)) {
    const [name, oid, peeled] = line.split('\0')
    if (!name || !OID.test(oid ?? '')) return null
    rows.push({ name, oid, peeled: peeled && OID.test(peeled) ? peeled : null })
  }
  const workspace = readCheckout(join(c.root, '.jj'))?.workspace ?? null
  let head: string | null = null
  if (c.colocated) {
    const h = await git(c.root, ['rev-parse', '--verify', '-q', 'HEAD'])
    // Unborn: no output, exit 1. Anything else that fails, or answers something else, can't be read.
    if (h.ok) {
      if (!OID.test(h.out.trim())) return null
      head = h.out.trim()
    } else if (h.out.trim() || h.code !== 1) return null
  }
  return { state: { refs: rows, colocated: c.colocated, workspace, head }, text: `${refs.out}\n${head ?? ''}` }
}

/**
 * The print of every Git source E8's reads rest on (the Operations view's list, the Assistant's on HI-2800): jj's
 * operation heads, the store's HEAD and, for a workspace with its own Git folder, that HEAD, the packed refs, every loose
 * ref under refs/heads, refs/tags and refs/remotes, a reftable if the store has one, and the store's config. The same in
 * both Git-backed modes (a non-colocated store's included). Undefined when any can't be read.
 */
function gitPrint(c: JjContext): string | undefined {
  const own = c.colocated ? workspaceGitDir(c.root) : null
  return rawSourcesPrint({
    jjRepo: c.jjRepo,
    files: [{ label: 'HEAD', path: join(c.store, 'HEAD') }, ...(own && own !== c.store ? [{ label: 'workspace HEAD', path: join(own, 'HEAD') }] : []), { label: 'packed', path: join(c.store, 'packed-refs') }, { label: 'config', path: join(c.store, 'config') }],
    trees: ['heads', 'tags', 'remotes'].map((t) => ({ label: `refs/${t}`, path: join(c.store, 'refs', t) })).concat([{ label: 'reftable', path: join(c.store, 'reftable') }])
  })
}

/** The moment: the head, the print and Git's answers, hashed. */
const momentOf = (H: string, print: string, gitText: string): string => `${H}:${createHash('sha256').update(`${print}
${gitText}`).digest('hex').slice(0, 32)}`

/** A refusal before anything is compared (E2, E3's operation shape), as a preview with no command. */
const refusedEarly = (at: string, moment: string, op: string, facts: OperationFacts | null, refused: JjOperationPreview['refused'], detail?: string): JjOperationPreview => ({ at, moment, op, description: facts?.description ?? '', did: [], commits: { added: [], hidden: [] }, later: [], command: null, refused, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })

/** A revset's commits at `at`, one more than the cap read so a list past it is known. */
async function commitsAt(reads: JjReads, at: string, revset: string): Promise<JjMaybe<string[]>> {
  const out = await reads.run(at, ['log', '--no-graph', '-r', revset, '-n', String(OP_COMMITS_MAX + 1), '-T', 'commit_id ++ "\\n"'])
  if (isJjUnknown(out)) return out
  return commitList(out) ?? jjUnknown('malformed', 'commitList')
}

/**
 * What reverting operation `op` would change, read at the single head and Git's state then. `moment`: the moment the
 * window showed the preview at (Copy's revalidation, s19, and HR2's round 1): when the head or Git's state is another
 * now, the fresh preview comes back with no command (`moved`), for the user to look at before copying again.
 */
export async function jjOperationPreview(folder: string, op: string, moment?: string | null, runner: JjRunner = jjRunner, git: GitRead = defaultGit): Promise<JjView<JjOperationPreview>> {
  if (!isOpId(op) || (moment && !/^[0-9a-f]{128}:[0-9a-f]{32}$/.test(moment))) return { jjUnknown: 'malformed', detail: 'op' } // i18n-ignore: a protocol code
  const c = await contextOf(folder, runner)
  if (isJjViewUnknown(c)) return c
  const reads = readsOf(c, runner)
  const r = await reads.pinned(async (H): Promise<JjMaybe<JjOperationPreview>> => {
    // Git's state first, as a verified capture: the print, the reads, the print again (equal: the answers belong to
    // those bytes). What E8 compares, and the moment the answer stands for.
    const print = gitPrint(c)
    const before = print ? await gitStateOf(c, git) : null
    if (!print || !before || gitPrint(c) !== print) return jjUnknown('moved', 'git')
    const at = momentOf(H, print, before.text)
    const opText = await reads.run(H, ['debug', 'object', 'operation', op])
    if (isJjUnknown(opText)) return opText
    const facts = operationFacts(opText)
    if (!facts) return refusedEarly(H, at, op, null, 'shape')
    // E2: one parent (the root has none, a merge of operations two or more).
    const parent = soleParent(facts)
    if (!parent) return refusedEarly(H, at, op, facts, 'parents')
    const parentText = await reads.run(H, ['debug', 'object', 'operation', parent])
    const headText = await reads.run(H, ['debug', 'object', 'operation', H])
    if (isJjUnknown(parentText)) return parentText
    if (isJjUnknown(headText)) return headText
    const pf = operationFacts(parentText)
    const hf = operationFacts(headText)
    if (!pf || !hf) return refusedEarly(H, at, op, facts, 'shape')
    const views: string[] = []
    for (const id of [pf.view, facts.view, hf.view]) {
      const v = await reads.run(H, ['debug', 'object', 'view', id])
      if (isJjUnknown(v)) return v
      views.push(v)
    }
    if (views.some((v) => v.length > VIEW_TEXT_MAX)) return refusedEarly(H, at, op, facts, 'bounds')
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
    const input = { op, facts, parent, views: { parent: views[0], op: views[1], head: views[2] }, commits, stale, git: before.state }
    const core = await (runner.preview ? runner.preview(input) : Promise.resolve(previewOf(input)))
    // The fence's end, in this continuation after the last awaited read, nothing awaited before the answer: the same print,
    // else a Git change meanwhile (a tag, a remote ref, HEAD) is no answer.
    if (gitPrint(c) !== print) return jjUnknown('moved', 'git')
    return { at: H, moment: at, op, description: facts.description, did: core.did, commits: core.commits, later: core.later, command: core.refused === null ? revertCommand(op) : null, refused: core.refused }
  })
  if (isJjUnknown(r)) return unknownOf(r)
  const p = r.value
  // Copy's revalidation: another moment than the one shown (the head, or Git's state) never hands out a command.
  if (moment && p.moment !== moment) return { ...p, command: null, refused: 'moved' }
  return p
}
