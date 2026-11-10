// The platform fence (HI-2799, SPEC §16.6.5): a switch between Git and jj changes what a repository's projects run under,
// so nothing may be admitted on that repository while it changes. Every admission (a lane's start, a card's start, a
// slot's or a copy's lease) is a row written in one of the workspace database's write transactions, and that database
// serializes them; so the fence is rows in `board_meta`, read in the admission's own transaction, written in the switch's.
// No new lock is taken and Git's command sequence is unchanged.
//
// Rows (each JSON, each validated whole: anything malformed fails closed):
// - `platform_fence:<store>`: the store's switch state, `settled` or `switching`, its generation, the switch's owner, and
//   each member project's current choice (`current`) with the attempt's before and after (recovery's data only).
// - `platform_member:<project id>`: the store a project is a member of (looked up first, by the project's identity, so a
//   cached store map never overrides membership).
// - `platform_store:<project id>`: the store detection last found for a project (or `none`), written at each refresh.
// - `platform_switching`: the stores switching now (an absent or unreadable map then refuses).
//
// Pure: given a `Meta` (a transaction's board_meta), so its rules are tested without a database or a repository.

import { isPlatformId, type PlatformId } from '../../shared/platform/descriptors'

/** A transaction's board_meta: read and write by key (null removes). */
export interface Meta {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

/** A project's project.json fields a switch changes, exactly as read under its lock (`workflow` as JSON, or absent). */
export interface Snap {
  platform: PlatformId
  platformFound?: string
  workflow?: unknown
}

export interface Member {
  /** The project's folder when the switch began, for recovery's read of its project.json. */
  path: string
  /** Its choice in force: `after` once a switch settled forward, `before` after a rollback. Admissions compare with it. */
  current: Snap
  /**
   * The last attempt it took part in, its generation's: its before and after. Recovery reconciles, and a switching fence
   * refuses, only the members of the switch under way (attempt.generation the fence's); an older attempt is history.
   */
  attempt?: { generation: number; before: Snap; after: Snap }
}

export interface FenceOwner {
  token: string
  pid: number
  profile: string
}

export interface Fence {
  generation: number
  state: 'settled' | 'switching'
  owner?: FenceOwner
  members: Record<string, Member>
}

export const FENCE_KEY = (store: string): string => `platform_fence:${storeKey(store)}`
export const MEMBER_KEY = (id: string): string => `platform_member:${id}`
export const STORE_KEY = (id: string): string => `platform_store:${id}`
export const SWITCHING_KEY = 'platform_switching'
/** A workflow longer than this refuses the switch rather than being truncated in its record (s23). */
export const SNAP_MAX = 64 * 1024

/** A store's key: compared as Windows compares folders (case-insensitive, one separator). */
export const storeKey = (store: string): string => store.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

const MALFORMED = Symbol('malformed')
type Read<T> = T | null | typeof MALFORMED

const parse = (v: string | null): unknown => {
  if (v === null) return null
  try {
    return JSON.parse(v) as unknown
  } catch {
    return MALFORMED
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function snapOf(v: unknown): Snap | null {
  if (!isObj(v) || !isPlatformId(v.platform)) return null
  if (v.platformFound !== undefined && typeof v.platformFound !== 'string') return null
  return { platform: v.platform, ...(v.platformFound !== undefined ? { platformFound: v.platformFound } : {}), ...(v.workflow !== undefined ? { workflow: v.workflow } : {}) }
}

function fenceOf(v: unknown): Fence | null {
  if (!isObj(v) || typeof v.generation !== 'number' || !Number.isInteger(v.generation) || (v.state !== 'settled' && v.state !== 'switching') || !isObj(v.members)) return null
  const members: Record<string, Member> = {}
  for (const [id, raw] of Object.entries(v.members)) {
    if (!isObj(raw) || typeof raw.path !== 'string') return null
    const current = snapOf(raw.current)
    if (!current) return null
    let attempt: Member['attempt']
    if (raw.attempt !== undefined) {
      if (!isObj(raw.attempt) || typeof raw.attempt.generation !== 'number') return null
      const before = snapOf(raw.attempt.before)
      const after = snapOf(raw.attempt.after)
      if (!before || !after) return null
      attempt = { generation: raw.attempt.generation, before, after }
    }
    members[id] = { path: raw.path, current, ...(attempt ? { attempt } : {}) }
  }
  let owner: FenceOwner | undefined
  if (v.owner !== undefined) {
    const o = v.owner
    if (!isObj(o) || typeof o.token !== 'string' || typeof o.pid !== 'number' || typeof o.profile !== 'string') return null
    owner = { token: o.token, pid: o.pid, profile: o.profile }
  }
  return { generation: v.generation, state: v.state, ...(owner ? { owner } : {}), members }
}

/** A store's fence: null when it was never switched, MALFORMED when its row can't be read whole. */
export function readFence(meta: Meta, store: string): Read<Fence> {
  const v = parse(meta.get(FENCE_KEY(store)))
  if (v === null) return null
  return v === MALFORMED ? MALFORMED : (fenceOf(v) ?? MALFORMED)
}

/** The fence a caller holds, or throws: a malformed row is never written over by a switch (recovery reads the disk). */
export function fenceOrNull(meta: Meta, store: string): Fence | null {
  const f = readFence(meta, store)
  if (f === MALFORMED) throw new Error(`the platform fence of ${store} is unreadable`) // i18n-ignore: a broken record, for the log; the window says platform.switching
  return f
}

function memberStore(meta: Meta, id: string): Read<string> {
  const v = parse(meta.get(MEMBER_KEY(id)))
  if (v === null) return null
  return isObj(v) && typeof v.store === 'string' ? v.store : MALFORMED
}

function mappedStore(meta: Meta, id: string): Read<string> {
  const v = meta.get(STORE_KEY(id))
  if (v === null) return null
  return v.length > 0 && v.length < 4096 ? v : MALFORMED
}

/** The stores switching now; MALFORMED counts as switching (fail closed). */
function switchingStores(meta: Meta): string[] | typeof MALFORMED {
  const v = parse(meta.get(SWITCHING_KEY))
  if (v === null) return []
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : MALFORMED
}

/** Why an admission is refused: its store is switching, or it was resolved under a platform that isn't its own now. */
export type AdmitRefusal = { why: 'switching' } | { why: 'changed'; now: PlatformId }

const SWITCHING: AdmitRefusal = { why: 'switching' } // i18n-ignore: a code, never shown as text

/**
 * Whether a project's admission may be written in this transaction (s17 to s26): `id` the project's identity (its
 * project.json id, else its folder's name, as the slot and copy tables key it), `compiled` the platform its rules were
 * resolved under. Membership first, by identity: a member of a switching fence is refused whatever it compiled; a member
 * of a settled one must have compiled its `current` platform. Not a member: the store map; absent or unreadable refuses
 * while any store switches; an unchanged None project outside a group is the only exemption.
 */
export function admit(meta: Meta, id: string, compiled: PlatformId): AdmitRefusal | null {
  const store = memberStore(meta, id)
  if (store === MALFORMED) return SWITCHING
  if (store !== null) {
    const f = readFence(meta, store)
    if (f === null || f === MALFORMED) return SWITCHING
    const m = f.members[id]
    if (!m) return SWITCHING
    // A participant of the switch under way is refused whatever it compiled; a former member outside it (one that
    // left the group for None) is held to its own current choice, as a settled fence holds every member.
    if (f.state === 'switching' && (participates(f, m) || m.current.platform !== 'none')) return SWITCHING
    return m.current.platform === compiled ? null : { why: 'changed', now: m.current.platform } // i18n-ignore: a code, never shown as text
  }
  const mapped = mappedStore(meta, id)
  if (mapped === null || mapped === MALFORMED) {
    const sw = switchingStores(meta)
    return sw === MALFORMED || sw.length ? SWITCHING : null
  }
  if (mapped === 'none' || compiled === 'none') return null
  const f = readFence(meta, mapped)
  if (f === null) return null
  if (f === MALFORMED || f.state === 'switching') return SWITCHING
  // A Git or jj project outside the group on a switched store: never mixed with the members' repository platform.
  const used = new Set(Object.values(f.members).map((m) => m.current.platform).filter((p) => p !== 'none'))
  if (used.size && !used.has(compiled)) return { why: 'changed', now: [...used][0] } // i18n-ignore: a code, never shown as text
  return null
}

/** Whether a member takes part in the fence's switch under way (its attempt is this generation's). */
export const participates = (f: Fence, m: Member): boolean => m.attempt?.generation === f.generation

/**
 * Takes a project out of a fence (s20's membership kept accurate: the project left the store, or the workspace): its
 * member row and its entry, never while it takes part in a switch under way. False when it does, or has no row.
 */
export function dropMember(meta: Meta, id: string): boolean {
  const store = memberStore(meta, id)
  if (store === null) return false
  if (store === MALFORMED) {
    meta.set(MEMBER_KEY(id), null)
    return true
  }
  const f = readFence(meta, store)
  if (f && f !== MALFORMED) {
    const m = f.members[id]
    if (m && f.state === 'switching' && participates(f, m)) return false
    if (m) {
      const { [id]: _gone, ...members } = f.members
      meta.set(FENCE_KEY(store), JSON.stringify({ ...f, members } satisfies Fence))
    }
  }
  meta.set(MEMBER_KEY(id), null)
  return true
}

/** Records the store detection found for a project (a refresh's), only when it changed; null clears it. */
export function mapStore(meta: Meta, id: string, store: string | 'none' | null): boolean {
  const key = STORE_KEY(id)
  const next = store === null ? null : store === 'none' ? 'none' : storeKey(store)
  if (meta.get(key) === next) return false
  meta.set(key, next)
  return true
}

function setSwitching(meta: Meta, store: string, on: boolean): void {
  const sw = switchingStores(meta)
  const list = sw === MALFORMED ? [] : sw.filter((s) => s !== storeKey(store))
  if (on) list.push(storeKey(store))
  meta.set(SWITCHING_KEY, list.length ? JSON.stringify(list) : null)
}

export interface BeginMember {
  id: string
  path: string
  before: Snap
  after: Snap
}

/**
 * Transaction A (s17, s20, s23): the store's fence to `switching`, its generation the next, each member's before and
 * after recorded, each member row written. Refused (null) while the store's fence is already switching: recovery settles
 * a dead owner's first, under the same repository lock. A member of another store's fence moves to this one.
 */
export function beginSwitch(meta: Meta, store: string, members: readonly BeginMember[], owner: FenceOwner): Fence | null {
  const was = fenceOrNull(meta, store)
  if (was?.state === 'switching') return null
  for (const m of members) if (JSON.stringify(m.before).length > SNAP_MAX || JSON.stringify(m.after).length > SNAP_MAX) throw new Error('groupTooLarge') // i18n-ignore: a code the caller words
  const generation = (was?.generation ?? 0) + 1
  // Former members outside this group keep their current choice, their old attempt dropped: only this switch's
  // participants are fenced and reconciled (HR2's HI-2799 round 1).
  const kept = Object.fromEntries(Object.entries(was?.members ?? {}).filter(([id]) => !members.some((m) => m.id === id)).map(([id, m]) => [id, { path: m.path, current: m.current }]))
  const fence: Fence = {
    generation,
    state: 'switching',
    owner,
    members: { ...kept, ...Object.fromEntries(members.map((m) => [m.id, { path: m.path, current: m.before, attempt: { generation, before: m.before, after: m.after } }])) }
  }
  meta.set(FENCE_KEY(store), JSON.stringify(fence))
  for (const m of members) meta.set(MEMBER_KEY(m.id), JSON.stringify({ store: storeKey(store) }))
  setSwitching(meta, store, true)
  return fence
}

/**
 * Transaction B, or a rollback, or recovery's settlement: the fence `settled`, each member's `current` the snapshot its
 * disk shows now (`after` forward, `before` back), the owner gone, the store off the switching list. Only the switch
 * whose generation it is settles it (a later switch's fence is never touched).
 */
export function settle(meta: Meta, store: string, generation: number, currents: Readonly<Record<string, Snap>>): boolean {
  const f = fenceOrNull(meta, store)
  if (!f || f.generation !== generation || f.state !== 'switching') return false
  // Only this switch's participants take a new current choice; anyone else keeps theirs.
  const members = Object.fromEntries(Object.entries(f.members).map(([id, m]) => [id, participates(f, m) && currents[id] ? { ...m, current: currents[id] } : m]))
  meta.set(FENCE_KEY(store), JSON.stringify({ generation: f.generation, state: 'settled', members } satisfies Fence))
  setSwitching(meta, store, false)
  return true
}

/** Equal snapshots, as recovery compares a member's disk with its before and after (JSON of the same fields). */
export const sameSnap = (a: Snap, b: Snap): boolean => JSON.stringify([a.platform, a.platformFound ?? null, a.workflow ?? null]) === JSON.stringify([b.platform, b.platformFound ?? null, b.workflow ?? null])

/** What recovery or a failed switch does with each member, from what its disk shows (s23 §1). */
export type Reconcile = { forward: true } | { back: string[]; untouched: string[] } | { stuck: string[] }

/**
 * Settles forward only when every member's disk equals its `after`; otherwise rolls back the members showing `after`
 * (written back to `before`), leaves those showing `before`, and is stuck (fail closed, a notice) on any member showing
 * neither (edited by hand meanwhile) or unreadable.
 */
export function reconcile(f: Fence, disk: Readonly<Record<string, Snap | null>>): Reconcile {
  const attempted = Object.entries(f.members).filter(([, m]) => participates(f, m))
  const stuck = attempted.filter(([id, m]) => {
    const d = disk[id]
    return !d || (!sameSnap(d, m.attempt!.before) && !sameSnap(d, m.attempt!.after))
  })
  if (stuck.length) return { stuck: stuck.map(([id]) => id) }
  if (attempted.every(([id, m]) => sameSnap(disk[id]!, m.attempt!.after))) return { forward: true }
  return { back: attempted.filter(([id, m]) => sameSnap(disk[id]!, m.attempt!.after)).map(([id]) => id), untouched: attempted.filter(([id, m]) => sameSnap(disk[id]!, m.attempt!.before)).map(([id]) => id) }
}
