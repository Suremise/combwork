// jj's target advance (HI-3235: HI-2840's stage 2; its approved design HI-2840/s30 with s34, the mapping HI-3235/s7,
// s10, s13 and s16). J1's probe (HI-2794) promoted into the protocol Combwork runs when a jj project's finish is
// Combwork's advance (`combworkAdvances`, the default since Darren's decision of 14 Nov): one attempt to move a target
// bookmark T from E to a card's candidate R, journaled before each step, refused at the base on anything unexpected,
// stopped on any difference it detects afterwards, and never called integrated without its full lineage.
//
// The guarantee (s30 §1 as corrected by s34 §1) — what this module refuses, detects, and can't detect:
// - Refused at the base read (nothing written): more than one operation head, T conflicted or divergent, T ≠ E (in jj,
//   jj's record of Git, or Git), T checked out in any Git worktree, any pending export, a changed plan (the caller's).
// - Detected after the move, and stopped: an operation between P0 and O or a foreign one after it, O's view differing
//   from P0's in more than T, a second head, a failed or partial export, Git's T ≠ R, any other Git ref changed, a
//   worktree's HEAD changed or a worktree added or removed.
// - Not detected (the residual races Darren accepted, documented in SPEC §16.3.6, never called safe): (a) ABA on T
//   between P0 and the move; (b′) a racer's move of T to an ancestor of R, absorbed; (d1) a worktree switched to T during
//   the attempt, detached by the export; (d2) a ref made pending during the attempt, exported with ours. Detecting what
//   d2 leaves (another ref changed) stops the attempt; it is never prevented or undone.
//
// The lock: nothing here takes one. Every entry that reads to decide or writes takes a `Held` token, which only
// `underLock` gives, inside the repository lock its caller holds (card → repository → the board's transaction).
// Journals are files (s34 §2), one per attempt, written whole and synced (`writeDurable`), named by card and cycle so a
// card's attempts are found by listing. jj's files and texts used here (op_heads/heads, the uncommitted-operation line,
// the `args` attribute) are jj 0.47.1's mechanics, not an API: anything unexpected is uncertain, never worked around.

import { createHash } from 'crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'original-fs/promises'
import { join } from 'path'
import type { RunResult } from './repoContext'
import { JJ_READ, type JjRunner } from './jjRunner'

// --- Reading jj and Git (the probe's, unchanged in what they read).

/** One bookmark row of an operation's view: local (`remote` empty) or a remote's (`git` is jj's record of the Git ref). */
export interface BookmarkRow {
  name: string
  remote: string
  conflict: boolean
  /** The single target, or '' when conflicted or absent. */
  target: string
  added: string[]
  removed: string[]
}

/** An operation's view, as far as the advance compares it. */
export interface OpView {
  bookmarks: BookmarkRow[]
  tags: { name: string; target: string }[]
  visibleHeads: string[]
}

/** An operation in a head's ancestry: its id, its parents and its `args` attribute. */
export interface OpEntry {
  id: string
  parents: string[]
  args: string
}

/** The Git side: every ref under refs/heads and refs/tags, and each worktree's HEAD (a branch, or detached at a commit). */
export interface GitSnapshot {
  refs: Record<string, string>
  worktrees: { path: string; head: string; branch: string | null }[]
}

/** One operation head, read pinned (`--at-op`): its ancestry (newest first, up to the bound) and its view. */
export interface HeadObservation {
  op: string
  ancestry: OpEntry[]
  /** The ancestry reached the base operation (or the bound wasn't hit): nothing between it and the base is missing. */
  complete: boolean
  view: OpView
}

/** Everything observed, each part read twice: a part that differed between its reads is torn. */
export type JjObservation = { unreadable: string } | { heads: HeadObservation[]; headsStable: boolean; git: GitSnapshot; gitStable: boolean }

const SEP = '\u001f'
const HEX = /^[0-9a-f]+$/
/** A command's marker, kept by jj in its operation's `args`: an advance's is its attempt id, an undo's adds its own id. */
const marker = (txn: string): string => `--config=combwork.txn="${txn}"`
export const markerIn = (args: string, txn: string): boolean => args.includes(`combwork.txn="${txn}"`) || args.includes(`combwork.txn=\\"${txn}\\"`)
export const undoTxn = (attempt: string, undo: string): string => `${attempt}.undo.${undo}`

const BOOKMARK_T = `name ++ "${SEP}" ++ if(remote, remote, "") ++ "${SEP}" ++ conflict ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "${SEP}" ++ added_targets.map(|c| c.commit_id()).join(",") ++ "${SEP}" ++ removed_targets.map(|c| c.commit_id()).join(",") ++ "\\n"`
const TAG_T = `name ++ "${SEP}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n"`
const OP_T = `id ++ "${SEP}" ++ parents.map(|p| p.id()).join(",") ++ "${SEP}" ++ attributes ++ "\\n"`

export class Unreadable extends Error {}
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0)
const ids = (s: string): string[] => (s ? s.split(',') : [])

/** Parses `bookmark list --all-remotes` with BOOKMARK_T. */
export function parseBookmarks(out: string): BookmarkRow[] {
  return lines(out).map((l) => {
    const f = l.split(SEP)
    if (f.length !== 6) throw new Unreadable(`bookmark row: ${l}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return { name: f[0], remote: f[1], conflict: f[2] === 'true', target: f[3], added: ids(f[4]), removed: ids(f[5]) }
  })
}

/** Parses `op log` with OP_T (an `args` attribute may hold anything but the separator and a newline). */
export function parseOps(out: string): OpEntry[] {
  return lines(out).map((l) => {
    const f = l.split(SEP)
    if (f.length !== 3 || !HEX.test(f[0])) throw new Unreadable(`op row: ${l}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return { id: f[0], parents: ids(f[1]), args: f[2] }
  })
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): GitSnapshot['worktrees'] {
  const found: GitSnapshot['worktrees'] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const ls = lines(block)
    if (!ls.length) continue
    const path = ls.find((l) => l.startsWith('worktree '))?.slice(9)
    const head = ls.find((l) => l.startsWith('HEAD '))?.slice(5)
    if (ls.includes('bare')) continue
    if (!path || !head) throw new Unreadable(`worktree block: ${block}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    found.push({ path, head, branch: ls.find((l) => l.startsWith('branch '))?.slice(7) ?? null })
  }
  return found
}

const local = (v: OpView, name: string): BookmarkRow | undefined => v.bookmarks.find((b) => b.name === name && b.remote === '')
const tracked = (v: OpView, name: string): BookmarkRow | undefined => v.bookmarks.find((b) => b.name === name && b.remote === 'git')
const rowKey = (b: BookmarkRow): string => [b.name, b.remote, b.conflict, b.target, b.added.join(','), b.removed.join(',')].join(SEP)

/**
 * Bookmarks and tags whose jj value Git doesn't have yet (or has, deleted in jj): what `jj git export` would write
 * besides T. A local bookmark without a `git` row, or differing from it, a `git` row without a local one, a jj tag
 * differing from Git's.
 */
export function pendingExports(v: OpView, git: GitSnapshot, except?: string): string[] {
  const out: string[] = []
  for (const b of v.bookmarks) {
    if (b.name === except) continue
    if (b.remote === '' && (b.conflict || tracked(v, b.name)?.target !== b.target)) out.push(`refs/heads/${b.name}`)
    if (b.remote === 'git' && !local(v, b.name)) out.push(`refs/heads/${b.name}`)
  }
  for (const t of v.tags) if (git.refs[`refs/tags/${t.name}`] !== t.target) out.push(`refs/tags/${t.name}`)
  return [...new Set(out)].sort()
}

/**
 * Whether two views differ only in T's local row, from `from` to `to` (T@git, every other bookmark, the tags and the
 * visible heads unchanged): null, else what else differs.
 */
export function onlyTarget(target: string, a: OpView, b: OpView, from: string, to: string): string | null {
  const was = local(a, target)
  const now = local(b, target)
  if (!was || was.conflict || was.target !== from) return 'baseView'
  if (!now || now.conflict || now.target !== to) return 'opView'
  const others = (v: OpView): string[] => v.bookmarks.filter((x) => !(x.name === target && x.remote === '')).map(rowKey).sort()
  if (JSON.stringify(others(a)) !== JSON.stringify(others(b))) return 'otherBookmarks'
  if (JSON.stringify(a.tags) !== JSON.stringify(b.tags)) return 'tags'
  if (JSON.stringify([...a.visibleHeads].sort()) !== JSON.stringify([...b.visibleHeads].sort())) return 'visibleHeads'
  return null
}

// --- The plan, the attempt and its journal.

/**
 * The consent identity (s34 §2): what the user's workflow agreed to integrate, never P0 (unrelated operations would
 * stale it). Its id is the hash of these fields, canonical; an attempt refuses a plan rebuilt with any field changed.
 */
export interface JjAdvancePlan {
  card: string
  cycle: number
  submission: number
  /** The candidate fingerprint's hash (the approval, its ruleset and generation: jjCandidateStep's). */
  fingerprint: string
  /** The backing store: the repository lock's key. */
  store: string
  target: string
  expected: string
  result: string
  change: string
  style: string
  /** The merge checks' key ('' when none are configured) and the revision they ran at (the candidate's). */
  checks: string
  checked: string
}

const canonical = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v))
export const planIdOf = (p: JjAdvancePlan): string => createHash('sha256').update(canonical(p)).digest('hex')
/** A fingerprint's hash for the plan (any JSON value). */
export const fingerprintHash = (fp: unknown): string => createHash('sha256').update(canonical(fp)).digest('hex').slice(0, 32)

/** An advance's phases (s10 §A): each `…ing` journaled before its command, each `…ed` after it answered. */
export type AdvancePhase = 'requested' | 'abandoned' | 'confirmed' | 'based' | 'preparing' | 'prepared' | 'integrating' | 'integrated' | 'exporting' | 'exported' | 'verified'
const ADVANCE_ORDER: readonly AdvancePhase[] = ['requested', 'abandoned', 'confirmed', 'based', 'preparing', 'prepared', 'integrating', 'integrated', 'exporting', 'exported', 'verified']
export const advanceAt = (p: AdvancePhase): number => ADVANCE_ORDER.indexOf(p)

/** An undo's phases (s10 §A's second table; s16: each undo its own entry, an earlier pre-mutation one `abandoned`). */
export type UndoPhase = 'undoRequested' | 'undoBased' | 'reverting' | 'reverted' | 'revertIntegrating' | 'revertIntegrated' | 'revertExporting' | 'revertExported' | 'undone' | 'abandoned' | 'uncertain'
/** The undo phases no jj write can have followed: an undo there is positively pre-mutation. */
const UNDO_BEFORE: readonly UndoPhase[] = ['undoRequested', 'undoBased', 'abandoned']

/** One undo attempt (s16 §1): bound to the request whose Approve made it, with its own marker. */
export interface UndoEntry {
  undo: string
  request: string
  phase: UndoPhase
  /** The single head it reverted at (H), its revert operation (U) once validated, and why it ended where it did. */
  head?: string
  op?: string
  detail?: string
}

/** How an attempt was settled, as its journal remembers (the facts are the record; this saves reading jj again). */
export type AdvanceSettled = 'nothingMoved' | 'integrated' | 'stopped' | 'uncertain' | 'undone' | 'resolved'

/** An attempt's journal (s34 §2): the plan whole, then what the base read found, O, and each phase. */
export interface AdvanceJournal {
  v: 1
  attempt: string
  planId: string
  plan: JjAdvancePlan
  phase: AdvancePhase
  /** P0 and the Git side there (immutable once written: the undo's lineage compares against these too). */
  base?: { op: string; git: GitSnapshot }
  /** O, the prepared move, once validated. */
  op?: string
  detail?: string
  settled?: AdvanceSettled
  /** Refused at the base: what the repository was then (its heads and Git side, hashed), so the same refusal isn't tried again until it changes. */
  refusedAt?: string
  undos: UndoEntry[]
}

/**
 * Writes a file whole and durably: a temp file beside it written and synced, then renamed over it (Windows' rename
 * replaces; a reader sees the old file or the new, never half of one). Renames are retried briefly where Windows holds
 * the file (an antivirus scan, a reader).
 */
export async function writeDurable(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const h = await open(tmp, 'w')
  try {
    await h.writeFile(text, 'utf8')
    await h.sync()
  } finally {
    await h.close()
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
      await new Promise((r) => setTimeout(r, 20 * 2 ** i))
    }
  }
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_')

/** A file removed; one already gone is fine. */
async function gone(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * HI-3264: how an attempt settled for good, its outcome on the card (`Integrated`, `AdvanceResolved`): nothing reads its
 * journal again, so it leaves the live folder. A stopped or uncertain one stays: its question still needs it.
 */
const SETTLED_FOR_GOOD: readonly AdvanceSettled[] = ['nothingMoved', 'integrated', 'resolved', 'undone']
export const settledForGood = (j: Pick<AdvanceJournal, 'settled'>): boolean => !!j.settled && SETTLED_FOR_GOOD.includes(j.settled)
/** HI-3264: how long a journal settled for good is kept in `settled/` (for a look after the fact), before it's pruned. */
export const SETTLED_KEPT_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Where a project's advance journals live (`<workspace>/.combwork/jj-advance`), one file per attempt. Only live ones
 * (unsettled, stopped or uncertain) are in the folder itself, so recovery and a card's listing read only those (HI-3264);
 * one settled for good moves to `settled/`, pruned after SETTLED_KEPT_MS. One found settled for good in the live folder
 * (written there before HI-3264) is moved there by the reader that finds it, so it is read once, not at every pass.
 */
export class AdvanceJournals {
  constructor(readonly dir: string) {}
  private name(card: string, cycle: number, attempt: string): string {
    return `${safe(card)}.${cycle}.${safe(attempt)}.json`
  }
  private file(card: string, cycle: number, attempt: string): string {
    return join(this.dir, this.name(card, cycle, attempt))
  }
  private get settledDir(): string {
    return join(this.dir, 'settled')
  }
  async write(j: AdvanceJournal): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const live = this.file(j.plan.card, j.plan.cycle, j.attempt)
    if (!settledForGood(j)) return writeDurable(live, JSON.stringify(j))
    // Settled for good: written whole into settled/ first, then the live file goes. A crash between leaves the live file
    // as it was before (its previous phase, unsettled, stopped or uncertain), so recovery still finds it and settles it
    // again from the card's facts; the settled/ copy is replaced then.
    await mkdir(this.settledDir, { recursive: true })
    await writeDurable(join(this.settledDir, this.name(j.plan.card, j.plan.cycle, j.attempt)), JSON.stringify(j))
    await gone(live)
    await this.prune()
  }
  /**
   * HI-3264 (HR2's round 1): a journal settled for good found in the live folder (one written there before HI-3264; the
   * new write order never leaves one) moved to settled/ as it is, its file's time kept, so retention covers it. No lock
   * is needed: once settled for good nothing writes its live file again. A move that fails is tried by the next reader.
   */
  private async drain(name: string): Promise<boolean> {
    try {
      await mkdir(this.settledDir, { recursive: true })
      await rename(join(this.dir, name), join(this.settledDir, name))
      return true
    } catch {
      return false
    }
  }
  /** Journals settled for good longer ago than SETTLED_KEPT_MS, removed (at each archive: as rare as attempts). */
  private async prune(now = Date.now()): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.settledDir)
    } catch {
      return
    }
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      const f = join(this.settledDir, n)
      try {
        if (now - (await stat(f)).mtimeMs > SETTLED_KEPT_MS) await gone(f)
      } catch {
        // Gone already, or held: the next archive tries again.
      }
    }
  }
  /** HI-3264: a card's attempts in a cycle settled for good (in `settled/`), for a look after the fact. */
  async settled(card: string, cycle: number): Promise<AdvanceJournal[]> {
    let names: string[]
    try {
      names = await readdir(this.settledDir)
    } catch {
      return []
    }
    const prefix = `${safe(card)}.${cycle}.`
    const out: AdvanceJournal[] = []
    for (const n of names.filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort()) {
      try {
        out.push(JSON.parse(await readFile(join(this.settledDir, n), 'utf8')) as AdvanceJournal)
      } catch {
        // Unreadable: nothing depends on it.
      }
    }
    return out
  }
  /** An attempt's journal: null when there is no file; 'unreadable' when there is one that can't be read. */
  async read(card: string, cycle: number, attempt: string): Promise<AdvanceJournal | null | 'unreadable'> {
    let raw: string
    try {
      raw = await readFile(this.file(card, cycle, attempt), 'utf8')
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
    }
    try {
      const j = JSON.parse(raw) as AdvanceJournal
      return j && j.v === 1 && j.attempt === attempt && j.plan?.card === card && j.plan.cycle === cycle && planIdOf(j.plan) === j.planId ? j : 'unreadable'
    } catch {
      return 'unreadable'
    }
  }
  /** A card's attempts in a cycle, by their files' names (an unreadable one listed as such). */
  async list(card: string, cycle: number): Promise<{ attempt: string; journal: AdvanceJournal | 'unreadable' }[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const prefix = `${safe(card)}.${cycle}.`
    const out: { attempt: string; journal: AdvanceJournal | 'unreadable' }[] = []
    let drained = false
    for (const n of names.filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort()) {
      const attempt = n.slice(prefix.length, -'.json'.length)
      const j = await this.read(card, cycle, attempt)
      if (j && j !== 'unreadable' && settledForGood(j)) drained = (await this.drain(n)) || drained
      else if (j) out.push({ attempt, journal: j })
    }
    if (drained) await this.prune()
    return out
  }
  /** Every journal in the folder (recovery's pass over the project's cards). */
  async all(): Promise<AdvanceJournal[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: AdvanceJournal[] = []
    let drained = false
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      let j: AdvanceJournal
      try {
        j = JSON.parse(await readFile(join(this.dir, n), 'utf8')) as AdvanceJournal
      } catch {
        // An unreadable journal is found again by its card's own listing, which counts it as such.
        continue
      }
      if (j?.v !== 1 || !j.plan) continue
      if (settledForGood(j)) drained = (await this.drain(n)) || drained
      else out.push(j)
    }
    if (drained) await this.prune()
    return out
  }
}

// --- The lock token.

/** Proof that the caller holds the store's repository lock: only `underLock` makes one. */
export interface Held {
  readonly store: string
}
const HELD = Symbol('held')
/** Runs `fn` inside `lock` (the store's repository lock), with the token the advance's entries require. */
export function underLock<T>(store: string, lock: <R>(fn: () => Promise<R>) => Promise<R>, fn: (h: Held) => Promise<T>): Promise<T> {
  return lock(() => fn(Object.freeze({ store, [HELD]: true }) as Held))
}
const assertHeld = (h: Held, store: string): void => {
  if (!h || !(h as unknown as Record<symbol, unknown>)[HELD] || h.store !== store) throw new Error('an advance step outside its store lock') // i18n-ignore: a programming error
}

// --- The steps.

/** Where a test's racer runs: between the steps, and between the observation's reads. */
export type AdvancePoint = 'based' | 'prepared' | 'beforeIntegrate' | 'integrated' | 'beforeExport' | 'exported' | 'undoBased' | 'reverted' | 'revertIntegrated' | 'revertExported' | `observe:${string}` | `crash:${string}`

/** What the advance runs with: the jj runner, a Git reader on the store, the repository's folders, the lease and a test's hook. */
export interface JjAdvanceDeps {
  runner: JjRunner
  /** Runs `git --git-dir <store> --no-optional-locks <args>` (a read; nothing here writes through Git). */
  git: (args: readonly string[]) => Promise<RunResult>
  /** The jj repository's shared folder, where the operation heads are. */
  jjRepo: string
  /** The folder the commands run in (the control workspace; every command ignores its working copy). */
  root: string
  journals: AdvanceJournals
  /** Whether the attempt still holds its lease (the card's plan unchanged, the workspace open): checked before each write. */
  still: () => Promise<boolean> | boolean
  hook?: (point: AdvancePoint, j: AdvanceJournal) => Promise<void> | void
  /** How many operations of a head's ancestry are read at most (default 2000): past it, incomplete (uncertain). */
  ancestryLimit?: number
}

/** What an attempt (or its recovery, or an undo) comes to. */
export type AdvanceOutcome =
  | { kind: 'advanced'; op: string; exportOp: string | null }
  | { kind: 'nothingMoved'; code: string; detail?: string }
  | { kind: 'stopped'; code: string; detail?: string; undo: boolean }
  | { kind: 'uncertain'; code: string; detail?: string }

const nothing = (code: string, detail?: string): AdvanceOutcome => ({ kind: 'nothingMoved', code, ...(detail ? { detail } : {}) })
const uncertain = (code: string, detail?: string): AdvanceOutcome => ({ kind: 'uncertain', code, ...(detail ? { detail } : {}) })

function steps(deps: JjAdvanceDeps) {
  const limit = deps.ancestryLimit ?? 2000
  const read = async (args: readonly string[]): Promise<string> => {
    const r = await deps.runner.run(deps.root, args)
    if (!r.ok || r.code !== 0) throw new Unreadable(`jj ${args.join(' ')}: ${r.code} ${r.err.trim()}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return r.out
  }
  const write = (txn: string, args: readonly string[]) =>
    deps.runner.run(deps.root, [...JJ_READ, marker(txn), ...args], { write: true, recheck: async () => ((await deps.still()) ? null : 'lease') })
  const gitRead = async (args: readonly string[]): Promise<string> => {
    const r = await deps.git(args)
    if (!r.ok || r.code !== 0) throw new Unreadable(`git ${args.join(' ')}: ${r.code} ${r.err.trim()}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return r.out
  }
  const view = async (op: string): Promise<OpView> => ({
    bookmarks: parseBookmarks(await read(['--at-op', op, 'bookmark', 'list', '--all-remotes', '-T', BOOKMARK_T])),
    tags: lines(await read(['--at-op', op, 'tag', 'list', '-T', TAG_T])).map((l) => {
      const [name, target] = l.split(SEP)
      return { name, target }
    }),
    visibleHeads: lines(await read(['--at-op', op, 'log', '--no-graph', '-r', 'visible_heads()', '-T', 'commit_id ++ "\\n"']))
  })
  const opEntry = async (op: string): Promise<OpEntry> => {
    const [e] = parseOps(await read(['--at-op', op, 'op', 'log', '--no-graph', '--limit', '1', '-T', OP_T]))
    if (!e) throw new Unreadable(`no op ${op}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    return e
  }
  /** The head files (this version's layout), each confirmed by jj as a full operation id. */
  const heads = async (): Promise<string[]> => {
    let names: string[]
    try {
      names = await readdir(join(deps.jjRepo, 'op_heads', 'heads'))
    } catch (e) {
      throw new Unreadable(`op_heads: ${(e as Error).message}`)
    }
    if (!names.length || names.some((n) => !HEX.test(n) || n.length < 64)) throw new Unreadable(`op_heads: ${names.join(',')}`)
    const out: string[] = []
    for (const n of names.sort()) {
      const e = await opEntry(n)
      if (e.id !== n) throw new Unreadable(`op head ${n} is ${e.id}`) // i18n-ignore: a protocol detail for logs and tests, never shown
      out.push(n)
    }
    return out
  }
  const gitSnapshot = async (): Promise<GitSnapshot> => {
    const refs: Record<string, string> = {}
    for (const l of lines(await gitRead(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']))) {
      const [k, v] = l.split(' ')
      refs[k] = v
    }
    return { refs, worktrees: parseWorktrees(await gitRead(['worktree', 'list', '--porcelain'])) }
  }
  const head = async (op: string, baseOp: string | undefined): Promise<HeadObservation> => {
    const ancestry = parseOps(await read(['--at-op', op, 'op', 'log', '--no-graph', '--limit', String(limit), '-T', OP_T]))
    const complete = baseOp ? ancestry.some((e) => e.id === baseOp) : ancestry.length < limit
    return { op, ancestry, complete, view: await view(op) }
  }
  /** Whether `commit` is in T's history at the single head `at` (pinned): T read there, not conflicted. */
  const contains = async (at: string, target: string, commit: string): Promise<boolean> => {
    const v = await view(at)
    const t = local(v, target)
    if (!t || t.conflict || !t.target) throw new Unreadable(`target ${target} at ${at}: ${t ? 'conflicted' : 'absent'}`) // i18n-ignore: a protocol detail for logs and tests, never shown
    const out = await read(['--at-op', at, 'log', '--no-graph', '-r', `${commit} & ::${t.target}`, '-T', 'commit_id ++ "\\n"'])
    return lines(out).length > 0
  }
  return { read, write, view, opEntry, heads, gitSnapshot, head, contains }
}

/** Reads the observation: heads, each head pinned, the Git side, then heads and the Git side again. */
export async function observe(deps: JjAdvanceDeps, j: AdvanceJournal, baseOp: string | undefined, tag = ''): Promise<JjObservation> {
  const s = steps(deps)
  const point = async (p: string): Promise<void> => {
    await deps.hook?.(`observe:${tag}${p}`, j)
  }
  try {
    const first = await s.heads()
    await point('heads')
    const hs: HeadObservation[] = []
    for (const h of first) {
      hs.push(await s.head(h, baseOp))
      await point(`head:${hs.length}`)
    }
    const git = await s.gitSnapshot()
    await point('git')
    const again = await s.heads()
    await point('headsAgain')
    const git2 = await s.gitSnapshot()
    return { heads: hs, headsStable: JSON.stringify(first) === JSON.stringify(again), git, gitStable: JSON.stringify(git) === JSON.stringify(git2) }
  } catch (e) {
    if (e instanceof Unreadable) return { unreadable: e.message }
    throw e
  }
}

/**
 * The base check (pure): one head, whose view and the Git side say T = T@git = ref = E, nothing else pending export, and
 * T checked out in no worktree (jj's export would detach it). Anything else refuses, with what was seen.
 */
export function baseRefusal(plan: JjAdvancePlan, heads: number, v: OpView, git: GitSnapshot): AdvanceOutcome | null {
  if (heads !== 1) return nothing('divergentStart', String(heads))
  const t = local(v, plan.target)
  if (!t) return nothing('noTarget')
  if (t.conflict) return nothing('conflicted', [...t.added, ...t.removed].join(','))
  if (t.target !== plan.expected) return nothing('moved', t.target)
  const tg = tracked(v, plan.target)?.target ?? ''
  const ref = git.refs[`refs/heads/${plan.target}`] ?? ''
  if (tg !== t.target) return nothing('partialExport', `${t.target} ${tg} ${ref}`)
  if (ref !== plan.expected) return nothing('movedInGit', ref)
  const out = git.worktrees.filter((w) => w.branch === `refs/heads/${plan.target}`).map((w) => w.path)
  if (out.length) return nothing('targetCheckedOut', out.join(','))
  const pending = pendingExports(v, git, plan.target)
  if (pending.length) return nothing('pendingExports', pending.join(','))
  return null
}

/** The Git side apart from T, against the base: a worktree changed (stopped), added (stopped), or another ref moved (stopped). */
function gitDifference(base: GitSnapshot, now: GitSnapshot, target: string): AdvanceOutcome | null {
  const moved = base.worktrees.filter((w) => {
    const x = now.worktrees.find((y) => y.path === w.path)
    return !x || x.head !== w.head || x.branch !== w.branch
  })
  if (moved.length) return { kind: 'stopped', code: 'checkoutDetached', detail: moved.map((w) => w.path).join(','), undo: false }
  const added = now.worktrees.filter((w) => !base.worktrees.some((x) => x.path === w.path)).map((w) => w.path)
  if (added.length) return { kind: 'stopped', code: 'worktreesChanged', detail: added.join(','), undo: false }
  const tRef = `refs/heads/${target}`
  const keys = new Set([...Object.keys(base.refs), ...Object.keys(now.refs)])
  const foreign = [...keys].filter((k) => k !== tRef && base.refs[k] !== now.refs[k]).sort()
  if (foreign.length) return { kind: 'stopped', code: 'foreignRefs', detail: foreign.join(','), undo: false }
  return null
}

/**
 * The classifier (pure) for an advance that may have moved T: positive evidence only. `advanced` needs the full lineage
 * (s34 §2): one head; P0 in its complete history; every operation after P0 carrying this attempt's marker, O among them,
 * O's parent P0; the head's view differing from P0's only in T, E → R; Git's T = R; every other ref and worktree as at
 * the base. Nothing of ours after P0 in any head's history is *nothing moved* only while the journal says no integrate
 * was attempted. A detected difference is *stopped*; anything not proved either way is *uncertain*.
 */
export function classifyAdvance(j: AdvanceJournal, obs: JjObservation, p0View: OpView | null): AdvanceOutcome {
  const { plan, base } = j
  if (advanceAt(j.phase) <= advanceAt('based')) return nothing('noMutation')
  if ('unreadable' in obs) return uncertain('unreadable', obs.unreadable)
  if (!obs.headsStable || !obs.gitStable) return uncertain('torn')
  if (!base) return uncertain('noBase')
  if (!obs.heads.length) return uncertain('noHeads')
  for (const h of obs.heads) {
    if (!h.complete) return uncertain('ancestry', h.op)
    if (!h.ancestry.some((e) => e.id === base.op)) return uncertain('baseNotInHistory', h.op)
  }
  const after = (h: HeadObservation): OpEntry[] => h.ancestry.slice(0, h.ancestry.findIndex((e) => e.id === base.op))
  const anyOurs = obs.heads.some((h) => after(h).some((e) => markerIn(e.args, j.attempt)))
  if (!anyOurs) {
    // Nothing of this attempt in any complete history: only before an integrate was tried is that "nothing moved".
    if (advanceAt(j.phase) >= advanceAt('integrating')) return uncertain('integrateUncertain')
    const diff = gitDifference(base.git, obs.git, plan.target)
    return diff ? uncertain(`notInHistory:${diff.kind === 'stopped' ? diff.code : ''}`, diff.kind === 'stopped' ? diff.detail : undefined) : nothing('notInHistory')
  }
  // Ours moved something: from here, a difference stops it.
  if (obs.heads.length !== 1) return { kind: 'stopped', code: 'divergent', detail: String(obs.heads.length), undo: false }
  const h = obs.heads[0]
  const ours = after(h)
  const foreign = ours.filter((e) => !markerIn(e.args, j.attempt))
  if (foreign.length) return { kind: 'stopped', code: 'concurrent', detail: foreign.map((e) => e.id.slice(0, 12)).join(','), undo: false }
  if (!j.op || !ours.some((e) => e.id === j.op)) return uncertain('opUnknown')
  const o = ours.find((e) => e.id === j.op)!
  if (o.parents.length !== 1 || o.parents[0] !== base.op) return { kind: 'stopped', code: 'concurrent', detail: 'parent', undo: false } // i18n-ignore: codes
  const t = local(h.view, plan.target)
  if (t?.conflict) return { kind: 'stopped', code: 'conflicted', detail: [...t.added, ...t.removed].join(','), undo: false }
  if (!t || t.target !== plan.result) return { kind: 'stopped', code: 'moved', detail: t?.target ?? '', undo: false }
  const git = gitDifference(base.git, obs.git, plan.target)
  if (git) return git
  const tg = tracked(h.view, plan.target)?.target ?? ''
  const ref = obs.git.refs[`refs/heads/${plan.target}`] ?? ''
  if (tg !== plan.result || ref !== plan.result) return { kind: 'stopped', code: 'partialExport', detail: `${tg} ${ref}`, undo: false }
  // The view's delta from P0 is T alone (T@git along with it, which the export moved): read against P0's own view.
  if (!p0View) return uncertain('noBaseView')
  const delta = onlyTarget(plan.target, withoutTracked(p0View, plan.target), withoutTracked(h.view, plan.target), plan.expected, plan.result)
  if (delta) return { kind: 'stopped', code: 'extraDelta', detail: delta, undo: false }
  const exportOp = ours.find((e) => e.id !== o.id)?.id ?? null
  return { kind: 'advanced', op: o.id, exportOp }
}

/** A view without T's `git` row (the export moves it with T; every other row stays compared). */
const withoutTracked = (v: OpView, target: string): OpView => ({ ...v, bookmarks: v.bookmarks.filter((b) => !(b.name === target && b.remote === 'git')) })

/**
 * Whether an undo may be offered for a stopped attempt (s30 §2), on the state read now: the journal past `integrated`
 * with O; the op log from P0 to the single head exactly this attempt's operations; the view differing from P0's only in
 * T, T = R in jj and in Git; every other ref and every worktree as at the base; T checked out nowhere.
 */
export function undoOffered(j: AdvanceJournal, obs: JjObservation, p0View: OpView | null): boolean {
  const { plan, base } = j
  if (!base || !j.op || advanceAt(j.phase) < advanceAt('integrated') || !p0View) return false
  if ('unreadable' in obs || !obs.headsStable || !obs.gitStable || obs.heads.length !== 1) return false
  const h = obs.heads[0]
  const i = h.ancestry.findIndex((e) => e.id === base.op)
  if (!h.complete || i < 0) return false
  const ours = h.ancestry.slice(0, i)
  if (!ours.length || !ours.every((e) => markerIn(e.args, j.attempt)) || !ours.some((e) => e.id === j.op)) return false
  if (onlyTarget(plan.target, withoutTracked(p0View, plan.target), withoutTracked(h.view, plan.target), plan.expected, plan.result)) return false
  if ((tracked(h.view, plan.target)?.target ?? '') !== plan.result || (obs.git.refs[`refs/heads/${plan.target}`] ?? '') !== plan.result) return false
  if (gitDifference(base.git, obs.git, plan.target)) return false
  return !obs.git.worktrees.some((w) => w.branch === `refs/heads/${plan.target}`)
}

/**
 * An undo's lineage (s10 §A): its revert U carrying its marker, U's parent H, every operation after H its own, the view
 * differing from H's only in T, R → E; T = E in jj and in Git; one head; every other ref and worktree as at the advance's
 * base. Verified: `undone`; nothing of the undo in history before its integrate: `nothingMoved` (pre-mutation); else
 * `stopped`/`uncertain` (never retried).
 */
export function classifyUndo(j: AdvanceJournal, u: UndoEntry, obs: JjObservation, hView: OpView | null): AdvanceOutcome {
  const { plan, base } = j
  const txn = undoTxn(j.attempt, u.undo)
  if (UNDO_BEFORE.includes(u.phase)) return nothing('undoNotStarted')
  if (!base || !u.head) return uncertain('undoNoBase')
  if ('unreadable' in obs) return uncertain('unreadable', obs.unreadable)
  if (!obs.headsStable || !obs.gitStable) return uncertain('torn')
  for (const h of obs.heads) if (!h.complete || !h.ancestry.some((e) => e.id === u.head)) return uncertain('ancestry', h.op)
  const after = (h: HeadObservation): OpEntry[] => h.ancestry.slice(0, h.ancestry.findIndex((e) => e.id === u.head))
  const anyOurs = obs.heads.some((h) => after(h).some((e) => markerIn(e.args, txn)))
  if (!anyOurs) return u.phase === 'reverting' || u.phase === 'reverted' ? nothing('undoNotInHistory') : uncertain('undoIntegrateUncertain')
  if (obs.heads.length !== 1) return uncertain('divergent', String(obs.heads.length))
  const h = obs.heads[0]
  const ours = after(h)
  if (ours.some((e) => !markerIn(e.args, txn))) return uncertain('concurrent')
  if (!u.op || !ours.some((e) => e.id === u.op)) return uncertain('undoOpUnknown')
  const o = ours.find((e) => e.id === u.op)!
  if (o.parents.length !== 1 || o.parents[0] !== u.head) return uncertain('concurrent', 'parent')
  const t = local(h.view, plan.target)
  if (!t || t.conflict || t.target !== plan.expected) return uncertain('moved', t?.target ?? '')
  if ((tracked(h.view, plan.target)?.target ?? '') !== plan.expected || (obs.git.refs[`refs/heads/${plan.target}`] ?? '') !== plan.expected) return uncertain('partialExport')
  // The Git side as at the advance's base, T included (back at E).
  if (gitDifference(base.git, obs.git, plan.target) || base.git.refs[`refs/heads/${plan.target}`] !== obs.git.refs[`refs/heads/${plan.target}`]) return uncertain('gitDiffers')
  if (!hView || onlyTarget(plan.target, withoutTracked(hView, plan.target), withoutTracked(h.view, plan.target), plan.result, plan.expected)) return uncertain('extraDelta')
  return { kind: 'advanced', op: o.id, exportOp: ours.find((e) => e.id !== o.id)?.id ?? null }
}

/** The journal's phase written (whole, durably), and the journal returned as written. */
async function journal(deps: JjAdvanceDeps, j: AdvanceJournal, next: Partial<AdvanceJournal>): Promise<AdvanceJournal> {
  const out = { ...j, ...next }
  await deps.journals.write(out)
  return out
}

/** An undo entry's phase written, within its journal. */
async function journalUndo(deps: JjAdvanceDeps, j: AdvanceJournal, undo: string, next: Partial<UndoEntry>): Promise<AdvanceJournal> {
  return journal(deps, j, { undos: j.undos.map((u) => (u.undo === undo ? { ...u, ...next } : u)) })
}

/** A new attempt's journal: phase `requested`, the plan whole (s34 §2, write 1). */
export async function journalRequested(h: Held, deps: JjAdvanceDeps, attempt: string, plan: JjAdvancePlan): Promise<AdvanceJournal> {
  assertHeld(h, plan.store)
  const j: AdvanceJournal = { v: 1, attempt, planId: planIdOf(plan), plan, phase: 'requested', undos: [] }
  await deps.journals.write(j)
  return j
}

/** The fact wasn't confirmed (s34 §2, write 2): the journal says so; nothing runs. */
export async function journalAbandoned(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal): Promise<AdvanceJournal> {
  assertHeld(h, j.plan.store)
  return journal(deps, j, { phase: 'abandoned', detail: 'factUnconfirmed', settled: 'nothingMoved' })
}

/** The journal's settled mark (the facts recorded it). */
export async function journalSettled(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal, settled: AdvanceSettled, extra: Partial<AdvanceJournal> = {}): Promise<AdvanceJournal> {
  assertHeld(h, j.plan.store)
  return journal(deps, j, { ...extra, settled })
}

/**
 * One attempt, after its fact was confirmed (`j` at `requested`, the fact read back): base, prepare, integrate, export,
 * observe, classify; each mutation journaled first and its lease checked in the write gate. Never retried, never forced.
 */
export async function runAdvance(h: Held, deps: JjAdvanceDeps, j0: AdvanceJournal): Promise<{ outcome: AdvanceOutcome; journal: AdvanceJournal }> {
  assertHeld(h, j0.plan.store)
  const s = steps(deps)
  const { plan } = j0
  let j = await journal(deps, j0, { phase: 'confirmed' })
  await deps.hook?.('crash:confirmed', j)
  const done = (outcome: AdvanceOutcome) => ({ outcome, journal: j })
  try {
    // base
    const hs = await s.heads()
    const base = await s.gitSnapshot()
    const p0 = hs[0]
    const p0View = await s.view(p0)
    const refused = baseRefusal(plan, hs.length, p0View, base)
    if (refused) {
      j = await journal(deps, j, { refusedAt: printOf(hs, base) })
      return done(refused)
    }
    j = await journal(deps, j, { phase: 'based', base: { op: p0, git: base } })
    await deps.hook?.('based', j)
    // prepare
    if (!(await deps.still())) return done(nothing('leaseLost', 'preparing'))
    j = await journal(deps, j, { phase: 'preparing' })
    const prep = await s.write(j.attempt, ['--at-op', p0, '--no-integrate-operation', 'bookmark', 'move', plan.target, '--from', plan.expected, '--to', plan.result])
    await deps.hook?.('crash:afterPrepare', j)
    if (prep.refused) return done(nothing('leaseLost', 'preparing'))
    const short = /--no-integrate-operation was requested: ([0-9a-f]{8,})\s*$/m.exec(`${prep.err}\n${prep.out}`)?.[1]
    if (prep.code !== 0 || !short) return done(classifyAdvance(j, await observe(deps, j, p0), p0View))
    const o = await s.opEntry(short)
    if (o.parents.length !== 1 || o.parents[0] !== p0 || !markerIn(o.args, j.attempt)) return done(nothing('prepareInvalid', o.parents.length !== 1 || o.parents[0] !== p0 ? 'parent' : 'marker'))
    const bad = onlyTarget(plan.target, p0View, await s.view(o.id), plan.expected, plan.result)
    // Prepared, never integrated: O is no head and in no head's history, so nothing moved.
    if (bad) return done(nothing('prepareInvalid', bad))
    j = await journal(deps, j, { phase: 'prepared', op: o.id })
    await deps.hook?.('prepared', j)
    // integrate
    await deps.hook?.('beforeIntegrate', j)
    if (!(await deps.still())) return done(nothing('leaseLost', 'integrating'))
    j = await journal(deps, j, { phase: 'integrating' })
    const integ = await s.write(j.attempt, ['op', 'integrate', o.id])
    await deps.hook?.('crash:afterIntegrate', j)
    if (integ.refused) return done(nothing('leaseLost', 'integrating'))
    if (integ.code !== 0) return done(classifyAdvance(j, await observe(deps, j, p0), p0View))
    j = await journal(deps, j, { phase: 'integrated' })
    await deps.hook?.('integrated', j)
    // export: an integrated move not yet exported is uncertain if the lease goes now (jj says R, Git says E).
    await deps.hook?.('beforeExport', j)
    if (!(await deps.still())) return done(uncertain('leaseLost', 'exporting'))
    j = await journal(deps, j, { phase: 'exporting' })
    const exp = await s.write(j.attempt, ['git', 'export'])
    await deps.hook?.('crash:afterExport', j)
    if (exp.refused) return done(uncertain('leaseLost', 'exporting'))
    if (exp.code === 0) j = await journal(deps, j, { phase: 'exported' })
    await deps.hook?.('exported', j)
    const outcome = classifyAdvance(j, await observe(deps, j, p0), p0View)
    if (outcome.kind === 'advanced') j = await journal(deps, j, { phase: 'verified' })
    else if (outcome.kind === 'stopped') outcome.undo = undoOffered(j, await observe(deps, j, p0, 'undo:'), p0View)
    return done(outcome)
  } catch (e) {
    if (e instanceof Unreadable) return done(advanceAt(j.phase) <= advanceAt('based') ? nothing('unreadable', e.message) : advanceAt(j.phase) <= advanceAt('prepared') ? classifyAfterUnreadable(j) : uncertain('unreadable', e.message))
    throw e
  }
}

/** What the repository is at the base read, hashed: its operation heads and its Git side (a refusal's, to try again only once it changes). */
const printOf = (heads: string[], git: GitSnapshot): string => createHash('sha256').update(canonical({ heads, git })).digest('hex').slice(0, 32)

/**
 * HI-3264: the base check (baseRefusal) on the repository now, read-only, before any journal or fact: what an attempt's
 * base would refuse, null when it would go on, 'unreadable' when jj or Git can't be read. A refusal found here writes
 * nothing, so a cause that persists costs reads on each pass, never a journal or facts.
 */
export async function baseRefusalNow(h: Held, deps: JjAdvanceDeps, plan: JjAdvancePlan): Promise<AdvanceOutcome | null | 'unreadable'> {
  assertHeld(h, plan.store)
  const s = steps(deps)
  try {
    const hs = await s.heads()
    if (hs.length !== 1) return nothing('divergentStart', String(hs.length))
    const git = await s.gitSnapshot()
    return baseRefusal(plan, hs.length, await s.view(hs[0]), git)
  } catch (e) {
    if (e instanceof Unreadable) return 'unreadable'
    throw e
  }
}

/** A read failed once O might exist, before any integrate: without the observation's evidence, uncertain. */
const classifyAfterUnreadable = (j: AdvanceJournal): AdvanceOutcome => (j.phase === 'preparing' || j.phase === 'prepared' ? uncertain('unreadable', 'prepare') : nothing('unreadable'))

/**
 * An attempt's recovery from its journal (s10 §A): read-only, the same classifier on the state read now. Never runs a
 * write. `requested`/`abandoned`/`confirmed`/`based`: nothing moved; a `verified` journal: advanced (its Integrated owed).
 */
export async function recoverAdvance(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal): Promise<AdvanceOutcome> {
  assertHeld(h, j.plan.store)
  if (advanceAt(j.phase) <= advanceAt('based')) return nothing('noMutation', j.phase)
  // Journaled `verified` only once the full lineage was proved (runAdvance): its Integrated is owed, whatever ran since.
  if (j.phase === 'verified' && j.op) return { kind: 'advanced', op: j.op, exportOp: null }
  if (j.phase === 'verified') return uncertain('verifiedNoOp')
  const p0View = await p0ViewOf(deps, j)
  const out = classifyAdvance(j, await observe(deps, j, j.base?.op), p0View)
  if (out.kind === 'stopped') out.undo = undoOffered(j, await observe(deps, j, j.base?.op, 'undo:'), p0View)
  return out
}

const p0ViewOf = async (deps: JjAdvanceDeps, j: AdvanceJournal): Promise<OpView | null> => {
  if (!j.base) return null
  try {
    return await steps(deps).view(j.base.op)
  } catch {
    return null
  }
}

/** Whether a stopped attempt's undo can be offered now (s30 §2's conditions, read now). */
export async function undoOfferedNow(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal): Promise<boolean> {
  assertHeld(h, j.plan.store)
  return undoOffered(j, await observe(deps, j, j.base?.op, 'undo:'), await p0ViewOf(deps, j))
}

/**
 * Whether T contains R now, positively (s13's start again): T read pinned at the single head, not conflicted. Unknown
 * (more than one head, a read that failed) is never an answer either way.
 */
export async function resultContained(h: Held, deps: JjAdvanceDeps, plan: JjAdvancePlan): Promise<boolean | 'unknown'> {
  assertHeld(h, plan.store)
  const s = steps(deps)
  try {
    const hs = await s.heads()
    if (hs.length !== 1) return 'unknown'
    return await s.contains(hs[0], plan.target, plan.result)
  } catch (e) {
    if (e instanceof Unreadable) return 'unknown'
    throw e
  }
}

/**
 * One undo (s30 §2 with s16 §1): `u` already journaled `undoRequested`, bound to its request. Every condition read
 * again; then `jj --at-op H --no-integrate-operation op revert O` (validated: parent H, its marker, its delta exactly T:
 * R → E), integrate, export, observe, classify. Each mutation journaled first. Never retried.
 */
export async function runUndo(h: Held, deps: JjAdvanceDeps, j0: AdvanceJournal, undo: string): Promise<{ outcome: AdvanceOutcome; journal: AdvanceJournal }> {
  assertHeld(h, j0.plan.store)
  const s = steps(deps)
  const { plan } = j0
  let j = j0
  const txn = undoTxn(j.attempt, undo)
  const done = (outcome: AdvanceOutcome) => ({ outcome, journal: j })
  try {
    if (!(await undoOfferedNow(h, deps, j))) return done(nothing('undoConditions'))
    const hs = await s.heads()
    if (hs.length !== 1) return done(nothing('undoConditions', 'heads'))
    const H = hs[0]
    const hView = await s.view(H)
    j = await journalUndo(deps, j, undo, { phase: 'undoBased', head: H })
    await deps.hook?.('undoBased', j)
    if (!(await deps.still())) return done(nothing('leaseLost', 'reverting'))
    j = await journalUndo(deps, j, undo, { phase: 'reverting' })
    const rev = await s.write(txn, ['--at-op', H, '--no-integrate-operation', 'op', 'revert', j.op!])
    await deps.hook?.('crash:afterRevert', j)
    if (rev.refused) return done(nothing('leaseLost', 'reverting'))
    const short = /--no-integrate-operation was requested: ([0-9a-f]{8,})\s*$/m.exec(`${rev.err}\n${rev.out}`)?.[1]
    if (rev.code !== 0 || !short) return done(classifyUndo(j, j.undos.find((x) => x.undo === undo)!, await observe(deps, j, H, 'undo:'), hView))
    const u = await s.opEntry(short)
    if (u.parents.length !== 1 || u.parents[0] !== H || !markerIn(u.args, txn)) return done(nothing('revertInvalid', 'parent'))
    const bad = onlyTarget(plan.target, withoutTracked(hView, plan.target), withoutTracked(await s.view(u.id), plan.target), plan.result, plan.expected)
    if (bad) return done(nothing('revertInvalid', bad))
    j = await journalUndo(deps, j, undo, { phase: 'reverted', op: u.id })
    await deps.hook?.('reverted', j)
    if (!(await deps.still())) return done(nothing('leaseLost', 'revertIntegrating'))
    j = await journalUndo(deps, j, undo, { phase: 'revertIntegrating' })
    const integ = await s.write(txn, ['op', 'integrate', u.id])
    await deps.hook?.('crash:afterRevertIntegrate', j)
    if (integ.refused) return done(nothing('leaseLost', 'revertIntegrating'))
    if (integ.code !== 0) return done(classifyUndo(j, j.undos.find((x) => x.undo === undo)!, await observe(deps, j, H, 'undo:'), hView))
    j = await journalUndo(deps, j, undo, { phase: 'revertIntegrated' })
    await deps.hook?.('revertIntegrated', j)
    if (!(await deps.still())) return done(uncertain('leaseLost', 'revertExporting'))
    j = await journalUndo(deps, j, undo, { phase: 'revertExporting' })
    const exp = await s.write(txn, ['git', 'export'])
    await deps.hook?.('crash:afterRevertExport', j)
    if (exp.refused) return done(uncertain('leaseLost', 'revertExporting'))
    if (exp.code === 0) j = await journalUndo(deps, j, undo, { phase: 'revertExported' })
    await deps.hook?.('revertExported', j)
    const out = classifyUndo(j, j.undos.find((x) => x.undo === undo)!, await observe(deps, j, H, 'undo:'), hView)
    j = await journalUndo(deps, j, undo, { phase: out.kind === 'advanced' ? 'undone' : out.kind === 'nothingMoved' ? 'abandoned' : 'uncertain', ...(out.kind === 'advanced' ? {} : { detail: out.code }) })
    return done(out)
  } catch (e) {
    if (e instanceof Unreadable) {
      const u = j.undos.find((x) => x.undo === undo)!
      return done(UNDO_BEFORE.includes(u.phase) ? nothing('unreadable', e.message) : uncertain('unreadable', e.message))
    }
    throw e
  }
}

/**
 * HI-3236: the commits a plan's move adds (E..R), read pinned at the single operation head: up to `max` lines (a short id
 * and its first line) and how many there are in all. Null when they can't be read (more than one head, a read that
 * failed): a preview then says nothing it couldn't read.
 */
export async function commitsAdded(h: Held, deps: JjAdvanceDeps, plan: JjAdvancePlan, max = 10): Promise<{ lines: string[]; total: number } | null> {
  assertHeld(h, plan.store)
  const s = steps(deps)
  try {
    const hs = await s.heads()
    if (hs.length !== 1) return null
    const all = lines(await s.read(['--at-op', hs[0], 'log', '--no-graph', '-r', `${plan.expected}..${plan.result}`, '-T', 'commit_id.short(12) ++ " " ++ description.first_line() ++ "\\n"']))
    return { lines: all.slice(0, max), total: all.length }
  } catch (e) {
    if (e instanceof Unreadable) return null
    throw e
  }
}

/** An undo's classification on the state read now (s16 §1's replay): read-only, never a write. */
export async function classifyUndoNow(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal, u: UndoEntry): Promise<AdvanceOutcome> {
  assertHeld(h, j.plan.store)
  if (UNDO_BEFORE.includes(u.phase)) return nothing('undoNotStarted')
  if (u.phase === 'undone') return { kind: 'advanced', op: u.op ?? '', exportOp: null }
  if (u.phase === 'uncertain') return uncertain('undoUncertain', u.detail)
  let hView: OpView | null = null
  try {
    if (u.head) hView = await steps(deps).view(u.head)
  } catch {
    hView = null
  }
  return classifyUndo(j, u, await observe(deps, j, u.head, 'undo:'), hView)
}

/** Whether an undo entry is positively pre-mutation (s16 §1): no jj write of it can have run. */
export const undoPreMutation = (u: UndoEntry): boolean => UNDO_BEFORE.includes(u.phase)

/** Appends a new undo entry (s16 §1), earlier pre-mutation ones abandoned, in one durable write. */
export async function journalNewUndo(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal, undo: string, request: string): Promise<AdvanceJournal> {
  assertHeld(h, j.plan.store)
  return journal(deps, j, { undos: [...j.undos.map((u) => (u.phase === 'undoRequested' || u.phase === 'undoBased' ? { ...u, phase: 'abandoned' as const, detail: 'preMutation' } : u)), { undo, request, phase: 'undoRequested' }] }) // i18n-ignore: codes
}

/** An undo entry marked as its replay classified it (pre-mutation: abandoned; otherwise its outcome). */
export async function journalUndoAs(h: Held, deps: JjAdvanceDeps, j: AdvanceJournal, undo: string, phase: UndoPhase, detail?: string): Promise<AdvanceJournal> {
  assertHeld(h, j.plan.store)
  return journalUndo(deps, j, undo, { phase, ...(detail ? { detail } : {}) })
}
