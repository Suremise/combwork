// jj's target head as evidence (HI-2798's J5): one bookmark, not conflicted, its commit neither divergent nor conflicted,
// jj and Git agreeing on it (the export matrix), read at one operation. The integration proof, the retained bundles and
// publish's observation went with jj's finishes (HI-3483); this goes with the rest of jj (HI-3486).

import type { StoreLock } from './jjBoundary'
import { isJjUnknown, JjReads, jjUnknown, type JjReadUnknown } from './jjReads'
import type { JjRunner } from './jjRunner'
import { COMMIT_ID, type ViewOf } from './jjView'
import type { RunResult } from './repoContext'

const SEP = '\u001f'
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)

/** `git for-each-ref`'s `<oid> <name>` lines, or null where one isn't. */
function parseRefs(out: string): Map<string, string> | null {
  const m = new Map<string, string>()
  for (const l of lines(out)) {
    const [oid, name, ...rest] = l.split(' ')
    if (rest.length || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid ?? '')) return null
    if (!name) return null
    m.set(name, oid)
  }
  return m
}

/** Why the evidence is refused: the port's further outcomes (R7/R8) and the publish's own. Never "not contained". */
export type JjRefusal = 'conflictedTarget' | 'divergentChange' | 'partialExport' | 'ambiguousRemote' | 'disagree' | 'notFetched'
export interface JjRefused {
  refused: JjRefusal
  detail?: string
}
export const isRefused = (v: unknown): v is JjRefused => !!v && typeof v === 'object' && typeof (v as JjRefused).refused === 'string'
const refused = (why: JjRefusal, detail?: string): JjRefused => ({ refused: why, ...(detail ? { detail: detail.slice(0, 2000) } : {}) })

/** An answer, a refusal, or a typed unknown (J3's codes, plus `moved` for anything that changed under the read). */
export type JjEvidence<T> = T | JjRefused | JjReadUnknown

export interface JjIntegrationDeps {
  runner: JjRunner
  view: Pick<ViewOf, 'jjRepo' | 'store' | 'colocated'>
  /** A folder of the repository to run jj's pinned reads in (J2's control workspace). */
  folder: string
  /** `git --git-dir <store>`; for `ls-remote`, run with no prompt (`GIT_TERMINAL_PROMPT=0`), bounded. */
  git: (args: readonly string[]) => Promise<RunResult>
  /** The environment `git` runs with (its config scopes follow it): process.env when not given. */
  gitEnv?: NodeJS.ProcessEnv
  lock: StoreLock
  signal?: AbortSignal
  timeout?: number
  hook?: (point: JjIntegrationPoint) => Promise<void> | void
}

/** Where a test pauses (a race placed exactly there). */
export type JjIntegrationPoint = 'afterProof' | 'afterRetain' | `beforePin:${string}` | 'afterRemote' | 'ancestry' | 'finalRemote' | 'finalFence' | 'discovered'

const BOOKMARK_T = `name ++ "${SEP}" ++ if(remote, remote, "") ++ "${SEP}" ++ conflict ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "${SEP}" ++ tracked ++ "\\n"`

interface BookmarkRow {
  name: string
  remote: string
  conflict: boolean
  target: string
  tracked: boolean
}

export function parseBookmarkRows(out: string): BookmarkRow[] | null {
  const rows: BookmarkRow[] = []
  for (const l of lines(out)) {
    const f = l.split(SEP)
    if (f.length !== 5 || !f[0] || (f[3] && !COMMIT_ID.test(f[3]))) return null
    rows.push({ name: f[0], remote: f[1], conflict: f[2] === 'true', target: f[3], tracked: f[4] === 'true' })
  }
  return rows
}

/**
 * The export matrix (s14 §1′), pure: jj's local `T`, its `T@git` row (null: none) and the store's `refs/heads/T` (null:
 * none). Colocated, Git's working copy sees the store's refs, so `@git` and the ref must both be there and equal T.
 * Non-colocated (HI-2896, HR1's s10 answer), the local bookmark alone is the target: nothing imports or exports without
 * colocation (probed on 0.47.1: after one manual `jj git export`, a later `bookmark set` and even `jj git push` leave
 * `T@git` and the ref behind), so a past export is a record, never a disagreement. The row and ref stay in the moment's
 * print and its final fence, so their change still moves it; a raw Git write to the store is E8's (jjOpView).
 */
export function exportProblem(colocated: boolean, local: string, gitRow: string | null, gitRef: string | null): string | null {
  if (!colocated) return null
  if (gitRow !== null) return gitRow === local && gitRef === local ? null : `T=${local} T@git=${gitRow} ref=${gitRef ?? '-'}`
  return `T=${local} T@git=- ref=${gitRef ?? '-'}`
}

/** The target's head as evidence, with the operation and Git ref it was read at. */
export interface JjTargetHead {
  head: string
  op: string
  gitRef: string | null
  rows: BookmarkRow[]
}

async function refNow(deps: JjIntegrationDeps, ref: string): Promise<string | null | JjReadUnknown> {
  const r = await deps.git(['for-each-ref', '--format=%(objectname) %(refname)', ref])
  if (!r.ok) return jjUnknown('failed', r.err)
  const m = parseRefs(r.out)
  return m ? (m.get(ref) ?? null) : jjUnknown('malformed', r.out)
}

const readsOf = (deps: JjIntegrationDeps): JjReads => new JjReads({ folder: deps.folder, jjRepo: deps.view.jjRepo }, deps.runner, { signal: deps.signal, timeout: deps.timeout })

/** How many whole reads `jjTargetHead` makes at most while the operation head moves under them (HI-2916). */
export const TARGET_READS = 3

/**
 * The target's head (s11 §1, s14 §1′), all at the single head H: the local bookmark (none: null), not conflicted, its
 * commit neither divergent nor conflicted, the export matrix holding; the heads and Git's ref the same after the reads.
 * A read that the operation head moved under (`moved`) is made again whole, at most TARGET_READS reads in all (HI-2916:
 * Combwork's own jj operations beside it, a slot made or detached, move it); nothing of a moved read is kept.
 */
export async function jjTargetHead(deps: JjIntegrationDeps, target: string): Promise<JjEvidence<JjTargetHead | null>> {
  let r = await targetHeadOnce(deps, target)
  for (let i = 1; i < TARGET_READS && isJjUnknown(r) && r.jjUnknown === 'moved'; i++) r = await targetHeadOnce(deps, target)
  return r
}

async function targetHeadOnce(deps: JjIntegrationDeps, target: string): Promise<JjEvidence<JjTargetHead | null>> {
  const reads = readsOf(deps)
  const ok = await reads.supported()
  if (isJjUnknown(ok)) return ok
  const op = reads.head()
  if (isJjUnknown(op)) return op
  const out = await reads.run(op, ['bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])
  if (isJjUnknown(out)) return out
  const rows = parseBookmarkRows(out)
  if (!rows) return jjUnknown('malformed', out)
  const mine = rows.filter((r) => r.name === target)
  const local = mine.find((r) => r.remote === '')
  if (!local) return reads.stillAt(op) ? null : jjUnknown('moved')
  if (local.conflict || !local.target) return refused('conflictedTarget', target)
  const c = await reads.commitAt(op, local.target)
  if (isJjUnknown(c)) return c
  if (c.divergent) return refused('divergentChange', local.target)
  if (c.conflict) return refused('conflictedTarget', local.target)
  const gitRow = mine.find((r) => r.remote === 'git')
  const gitRef = await refNow(deps, `refs/heads/${target}`)
  if (isJjUnknown(gitRef)) return gitRef
  const bad = exportProblem(deps.view.colocated, local.target, gitRow ? gitRow.target || 'conflicted' : null, gitRef)
  if (bad) return refused('partialExport', bad)
  const again = await refNow(deps, `refs/heads/${target}`)
  if (isJjUnknown(again)) return again
  if (again !== gitRef || !reads.stillAt(op)) return jjUnknown('moved')
  return { head: local.target, op, gitRef, rows }
}
