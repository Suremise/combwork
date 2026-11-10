// A jj slot's preparation for a card (HI-2866, J9a; design HI-2866/s7, s10 and s13, HR1's): which card cycle a jj slot is
// bound to, kept apart from the slot's lease (a lane keeps one lease for all its cards), and the durable record of each
// preparation. Pure: keys, records, their checks and the board_meta store. The jj writes are jjWorkspacePort.ts's.
//
// Under decision A (HI-2794) a jj card has no bookmark: nothing in Combwork makes or moves one. A card's line is a key
// that locates one preparation of one slot, `jj:<workspace>/<card>.<cycle>`, never a ref. It authorises nothing alone:
// every check compares the whole key, the lease, the card and its cycle, and the slot's generation now.
//
// Each slot has one completed binding, its pointer (`slot_jjcur:<store>:<workspace>`), which `line()` answers from. A
// preparation writes only its own journal (`slot_jjprep:<store>:<workspace>:<prep>`), with a copy of the pointer it
// started from (`prev`). It validates against `prev`, stops before any write if the pointer no longer equals it, and
// publishes its binding by compare and swap only once its write is done and read back. An unfinished preparation is
// never shown as a binding, and a crash anywhere resumes from the journal's phase with `prev` still there.

import type { FenceDb } from './workspacePort'

/** A slot's completed binding: the card cycle it is prepared for (`key` null: detached at `base`, no card). */
export interface JjBinding {
  /** The preparation's id: `<card>.<cycle>` for a card's, `detach:<card>.<cycle>` for a settle after Done. */
  prep: string
  key: string | null
  card: number | null
  cycle: number | null
  lease: string | null
  /** The card's target bookmark (null for a detach): its submitted commits must be contained there before reuse. */
  target: string | null
  /** The commit the slot's work starts from (a card's) or is put back on (a detach). */
  base: string
  /** The slot folder's creation generation (J2's identity) when bound. */
  generation: string
  /** The card's submitted commits (J9b records them), oldest first: what the slot may hold over `base` when reused. */
  submitted: string[]
}

export type JjPrepPhase = 'planned' | 'recorded' | 'checked' | 'writing' | 'written' | 'done' | 'superseded' | 'refused'

/** One preparation's journal: what it is, the binding it started from, and how far it got. */
export interface JjPrepJournal {
  kind: 'prepare' | 'detach'
  prep: string
  next: JjBinding
  /** The pointer as read when it was planned (null: the slot had none), copied whole. */
  prev: JjBinding | null
  phase: JjPrepPhase
  /** The operation head its check was made at: the write's expected parent operation. */
  checkedAt?: string
  /** The attempt now running it (a fresh id each time it is taken up): only that attempt may publish its binding. */
  run?: string
  /** The working-copy commit the check examined (the commit the write moves the slot off). */
  from?: string
  /** Set with `writing`, before the write: the mark its `jj new` carries in its operation's arguments (`cw.prep=<mark>`). */
  mark?: string
  /** Set with `written`: the marked operation and the working-copy commit it made (read at that operation). */
  wrote?: { op: string; commit: string }
  why?: string
}

/** Where the bindings and journals live (board_meta, by key), with the pointer's compare and swap as one write. */
export interface JjPrepStore {
  /** The slot's pointer: its binding, null for none, 'unreadable' when the row can't be read (never taken for none). */
  pointer(store: string, workspace: string): JjBinding | null | 'unreadable'
  journal(store: string, workspace: string, prep: string): JjPrepJournal | null | 'unreadable'
  writeJournal(store: string, workspace: string, j: JjPrepJournal): Promise<void>
  /**
   * In one write: the pointer set to `next` only if it is still exactly `expect` (sameBinding) and the preparation's
   * journal is still `j`'s attempt (its `run`, when `j` has one), and the journal marked done. False, and nothing
   * written, when the pointer moved or a later attempt took the preparation over meanwhile.
   */
  publish(store: string, workspace: string, expect: JjBinding | null, next: JjBinding, j: JjPrepJournal): Promise<boolean>
  /**
   * The same publication inside a caller's transaction on this store's database (a fence's `commit`, HR1's round 2), so
   * the holder's check and the pointer's compare and swap commit as one.
   */
  publishIn?(db: BoardDb, store: string, workspace: string, expect: JjBinding | null, next: JjBinding, j: JjPrepJournal): boolean
}

/** A line key of a card cycle's preparation in a jj slot. */
export const jjLineKey = (workspace: string, card: number, cycle: number): string => `jj:${workspace}/${card}.${cycle}`

/** A jj line key's parts, or null when it isn't one (a Git branch, anything else). */
export function parseJjLineKey(key: string): { workspace: string; card: number; cycle: number; prep: string } | null {
  const m = /^jj:([A-Za-z0-9._-]{1,200})\/(\d{1,12})\.(\d{1,12})$/.exec(key)
  if (!m) return null
  return { workspace: m[1], card: Number(m[2]), cycle: Number(m[3]), prep: `${m[2]}.${m[3]}` }
}

/** Whether a line is a jj preparation's key (never passed to a ref or bookmark command). */
export const isJjLineKey = (line: string | null | undefined): boolean => !!line && line.startsWith('jj:')

/** Two bindings are the same, every field (the submitted endpoints included); null only equals null. */
export function sameBinding(a: JjBinding | null, b: JjBinding | null): boolean {
  if (a === null || b === null) return a === b
  return a.prep === b.prep && a.key === b.key && a.card === b.card && a.cycle === b.cycle && a.lease === b.lease && a.target === b.target && a.base === b.base && a.generation === b.generation && a.submitted.length === b.submitted.length && a.submitted.every((c, i) => c === b.submitted[i])
}

const COMMIT = /^[0-9a-f]{40}$/

/** A stored binding read whole and checked, or null when it isn't one. */
export function bindingOf(v: unknown): JjBinding | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const okNum = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isInteger(x) && x >= 0)
  if (typeof b.prep !== 'string' || !(b.key === null || typeof b.key === 'string') || !okNum(b.card) || !okNum(b.cycle) || !(b.lease === null || typeof b.lease === 'string') || !(b.target === null || typeof b.target === 'string')) return null
  if (typeof b.base !== 'string' || !COMMIT.test(b.base) || typeof b.generation !== 'string' || !Array.isArray(b.submitted) || !b.submitted.every((c) => typeof c === 'string' && COMMIT.test(c))) return null
  return { prep: b.prep, key: b.key as string | null, card: b.card as number | null, cycle: b.cycle as number | null, lease: b.lease as string | null, target: b.target as string | null, base: b.base, generation: b.generation, submitted: [...(b.submitted as string[])] }
}

const PHASES: readonly JjPrepPhase[] = ['planned', 'recorded', 'checked', 'writing', 'written', 'done', 'superseded', 'refused']

/** A stored journal read whole and checked, or null when it isn't one. */
export function journalOf(v: unknown): JjPrepJournal | null {
  if (!v || typeof v !== 'object') return null
  const j = v as Record<string, unknown>
  const next = bindingOf(j.next)
  const prev = j.prev === null ? null : bindingOf(j.prev)
  if ((j.kind !== 'prepare' && j.kind !== 'detach') || typeof j.prep !== 'string' || !next || (j.prev !== null && !prev) || !PHASES.includes(j.phase as JjPrepPhase)) return null
  const str = (k: 'checkedAt' | 'run' | 'from' | 'mark' | 'why'): Partial<JjPrepJournal> => (typeof j[k] === 'string' ? { [k]: j[k] } : {})
  const w = j.wrote as { op?: unknown; commit?: unknown } | undefined
  if (w !== undefined && (!w || typeof w.op !== 'string' || typeof w.commit !== 'string' || !COMMIT.test(w.commit))) return null
  return { kind: j.kind, prep: j.prep, next, prev, phase: j.phase as JjPrepPhase, ...str('checkedAt'), ...str('run'), ...str('from'), ...str('mark'), ...(w ? { wrote: { op: w.op as string, commit: w.commit as string } } : {}), ...str('why') }
}

/**
 * Whether a slot's chain over its binding's base is what reuse allows (s10 §2 step 3): exactly the binding's submitted
 * commits (none for a detached binding or a card that made nothing), in any order, nothing else. `chain`: the commits of
 * `base::@ ~ base`, the working copy left out only when it is empty.
 */
export function chainIsBinding(chain: readonly string[], prev: JjBinding | null): boolean {
  const allowed = new Set(prev?.submitted ?? [])
  return chain.length === allowed.size && chain.every((c) => allowed.has(c))
}

/** The board_meta keys. */
export const pointerKey = (store: string, workspace: string): string => `slot_jjcur:${store.toLowerCase()}:${workspace}`
export const journalKey = (store: string, workspace: string, prep: string): string => `slot_jjprep:${store.toLowerCase()}:${workspace}:${prep}`

/** A database as board_meta's store uses it (a fence's transaction hands the same). */
export type BoardDb = FenceDb

/** A connection's read and transactional write, as boardConn's (SlotStore's `conn`). */
export interface BoardRw {
  read<T>(fn: (db: BoardDb) => T): T
  write<T>(fn: (db: BoardDb) => T): Promise<T>
}

/** The store over a workspace database's board_meta (the app's and the tests'). */
export function boardPrepStore(conn: BoardRw): JjPrepStore {
  const get = (db: BoardDb, key: string): { found: false } | { found: true; value: unknown } => {
    const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL, never shown
    if (!r) return { found: false }
    try {
      return { found: true, value: JSON.parse(r.value) as unknown }
    } catch {
      return { found: true, value: undefined }
    }
  }
  const put = (db: BoardDb, key: string, v: unknown): void => void db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v)) // i18n-ignore: SQL, never shown
  const readPointer = (db: BoardDb, store: string, workspace: string): JjBinding | null | 'unreadable' => {
    const r = get(db, pointerKey(store, workspace))
    if (!r.found) return null
    return bindingOf(r.value) ?? 'unreadable'
  }
  const publishIn = (db: BoardDb, store: string, workspace: string, expect: JjBinding | null, next: JjBinding, j: JjPrepJournal): boolean => {
    const now = readPointer(db, store, workspace)
    if (now === 'unreadable' || !sameBinding(now, expect)) return false
    if (j.run !== undefined) {
      const held = get(db, journalKey(store, workspace, j.prep))
      if (!held.found || (journalOf(held.value)?.run ?? null) !== j.run) return false
    }
    put(db, pointerKey(store, workspace), next)
    put(db, journalKey(store, workspace, j.prep), { ...j, phase: 'done' })
    return true
  }
  return {
    pointer: (store, workspace) => conn.read((db) => readPointer(db, store, workspace)),
    journal: (store, workspace, prep) =>
      conn.read((db) => {
        const r = get(db, journalKey(store, workspace, prep))
        if (!r.found) return null
        return journalOf(r.value) ?? 'unreadable'
      }),
    writeJournal: (store, workspace, j) => conn.write((db) => put(db, journalKey(store, workspace, j.prep), j)),
    publish: (store, workspace, expect, next, j) => conn.write((db) => publishIn(db, store, workspace, expect, next, j)),
    publishIn
  }
}
