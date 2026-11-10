// The platform fence's rules (HI-2799, s17 to s26; src/main/platform/platformFence.ts), on a board_meta held in a Map:
// membership first, by project identity; a switching fence refuses its members whatever they compiled; a settled one
// holds each member to its current choice (after a switch forward, before a rollback); the store map only for projects
// outside a group, absent or unreadable refusing while any store switches; malformed rows failing closed; recovery's
// reconcile from what each member's disk shows.
import { describe, expect, it } from 'vitest'
import { admit, beginSwitch, dropMember, mapStore, readFence, reconcile, settle, storeKey, MEMBER_KEY, FENCE_KEY, SWITCHING_KEY, STORE_KEY, type Meta, type Snap } from '../src/main/platform/platformFence'

const metaOf = (m = new Map<string, string>()): Meta & { m: Map<string, string> } => ({
  m,
  get: (k) => m.get(k) ?? null,
  set: (k, v) => void (v === null ? m.delete(k) : m.set(k, v))
})

const S = 'C:\\Repos\\Shop\\.git'
const owner = { token: 't1', pid: 1, profile: 'p' }
const snap = (platform: Snap['platform'], workflow?: unknown): Snap => ({ platform, ...(workflow !== undefined ? { workflow } : {}) })
/** P1 None and P2 Git, both going to jj (s23's mixed-origin group), each with its own options. */
const group = [
  { id: 'p1', path: 'C:\\ws\\p1', before: snap('none', { platform: 'none', preset: 'solo' }), after: snap('jj', { platform: 'jj', preset: null }) },
  { id: 'p2', path: 'C:\\ws\\p2', before: snap('git', { platform: 'git', preset: 'pair' }), after: snap('jj', { platform: 'jj', preset: null }) }
]

describe('admit (s17 to s26)', () => {
  it('a store never switched admits everyone as today (3a): no row, no map', () => {
    const meta = metaOf()
    for (const p of ['none', 'git', 'jj'] as const) expect(admit(meta, 'p1', p)).toBeNull()
  })

  it("refuses a switching fence's members whatever they compiled, None included (2f), at both pauses", () => {
    const meta = metaOf()
    const f = beginSwitch(meta, S, group, owner)!
    expect(f.state).toBe('switching')
    for (const id of ['p1', 'p2']) for (const p of ['none', 'git', 'jj'] as const) expect(admit(meta, id, p)).toEqual({ why: 'switching' })
    // A second switch of the same store is refused while one is under way.
    expect(beginSwitch(meta, S, group, owner)).toBeNull()
  })

  it('after a switch forward, members are held to after: a stale None or Git start is refused as changed (1b, 2f)', () => {
    const meta = metaOf()
    const f = beginSwitch(meta, S, group, owner)!
    expect(settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })).toBe(true)
    expect(admit(meta, 'p1', 'none')).toEqual({ why: 'changed', now: 'jj' })
    expect(admit(meta, 'p2', 'git')).toEqual({ why: 'changed', now: 'jj' })
    expect(admit(meta, 'p1', 'jj')).toBeNull()
    expect(admit(meta, 'p2', 'jj')).toBeNull()
  })

  it('after a rollback, fresh admissions use each member’s own before: P1 None, P2 Git, no changed loop (1d, s26)', () => {
    const meta = metaOf()
    const f = beginSwitch(meta, S, group, owner)!
    settle(meta, S, f.generation, { p1: group[0].before, p2: group[1].before })
    expect(admit(meta, 'p1', 'none')).toBeNull()
    expect(admit(meta, 'p2', 'git')).toBeNull()
    expect(admit(meta, 'p2', 'jj')).toEqual({ why: 'changed', now: 'git' })
    // History only: the attempt stays recorded, never read by an admission.
    const kept = readFence(meta, S)
    expect(kept && typeof kept === 'object' && kept.members.p1.attempt?.after.platform).toBe('jj')
  })

  it('membership beats a stale or none store map (2g); the map serves only projects outside a group', () => {
    const meta = metaOf()
    mapStore(meta, 'p1', 'none')
    mapStore(meta, 'p2', 'D:\\elsewhere\\.git')
    const f = beginSwitch(meta, S, group, owner)!
    expect(admit(meta, 'p1', 'none')).toEqual({ why: 'switching' })
    expect(admit(meta, 'p2', 'git')).toEqual({ why: 'switching' })
    settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })
    expect(admit(meta, 'p1', 'none')).toEqual({ why: 'changed', now: 'jj' })
  })

  it('outside the group: an unchanged None project is admitted at every pause (1c); a Git one on the store is not', () => {
    const meta = metaOf()
    mapStore(meta, 'p3', S)
    mapStore(meta, 'p4', S)
    const f = beginSwitch(meta, S, group, owner)!
    expect(admit(meta, 'p3', 'none')).toBeNull()
    expect(admit(meta, 'p4', 'git')).toEqual({ why: 'switching' })
    settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })
    expect(admit(meta, 'p3', 'none')).toBeNull()
    // A Git project joining a jj store afterwards is never mixed in.
    expect(admit(meta, 'p4', 'git')).toEqual({ why: 'changed', now: 'jj' })
    expect(admit(meta, 'p4', 'jj')).toBeNull()
  })

  it('a project with no map entry is refused while any store switches (3b), admitted otherwise', () => {
    const meta = metaOf()
    expect(admit(meta, 'new', 'git')).toBeNull()
    const f = beginSwitch(meta, S, group, owner)!
    expect(admit(meta, 'new', 'git')).toEqual({ why: 'switching' })
    expect(admit(meta, 'new', 'none')).toEqual({ why: 'switching' })
    settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })
    expect(admit(meta, 'new', 'git')).toBeNull()
  })

  it('malformed rows fail closed (3d)', () => {
    const meta = metaOf()
    meta.set(MEMBER_KEY('p1'), '{not json')
    expect(admit(meta, 'p1', 'git')).toEqual({ why: 'switching' })
    meta.set(MEMBER_KEY('p1'), JSON.stringify({ store: storeKey(S) }))
    meta.set(FENCE_KEY(S), JSON.stringify({ generation: 1, state: 'settled', members: { p1: { path: 'x', current: { platform: 'mercurial' } } } }))
    expect(admit(meta, 'p1', 'git')).toEqual({ why: 'switching' })
    meta.set(SWITCHING_KEY, '"oops"')
    expect(admit(meta, 'unmapped', 'git')).toEqual({ why: 'switching' })
    meta.set(STORE_KEY('p9'), '')
    meta.set(SWITCHING_KEY, null)
    expect(admit(meta, 'p9', 'git')).toBeNull()
  })

  it('only the generation that began a switch settles it', () => {
    const meta = metaOf()
    const f = beginSwitch(meta, S, group, owner)!
    expect(settle(meta, S, f.generation + 1, {})).toBe(false)
    expect(settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })).toBe(true)
    expect(settle(meta, S, f.generation, {})).toBe(false)
    expect(beginSwitch(meta, S, group, owner)!.generation).toBe(f.generation + 1)
  })

  it('stores compare as Windows folders do', () => {
    expect(storeKey('C:/Repos/Shop/.git/')).toBe(storeKey('c:\\repos\\shop\\.git'))
  })
})

describe('a former member outside a later switch (HR2 round 1)', () => {
  /** P and Q switched to jj together; then Q chose None by itself (its own switch, recorded in the fence). */
  function afterOptOut() {
    const meta = metaOf()
    const f = beginSwitch(meta, S, group, owner)!
    settle(meta, S, f.generation, { p1: group[0].after, p2: group[1].after })
    const raw = JSON.parse(meta.get(FENCE_KEY(S))!)
    raw.members.p2.current = snap('none', { platform: 'none' })
    meta.set(FENCE_KEY(S), JSON.stringify(raw))
    return meta
  }
  const pBack = [{ id: 'p1', path: 'C:\\ws\\p1', before: group[0].after, after: snap('git', { platform: 'git' }) }]

  it("is no participant of P's switch back: its None start is admitted while it runs, its old attempt dropped", () => {
    const meta = afterOptOut()
    const f = beginSwitch(meta, S, pBack, owner)!
    expect(admit(meta, 'p1', 'jj')).toEqual({ why: 'switching' })
    expect(admit(meta, 'p2', 'none')).toBeNull()
    expect(admit(meta, 'p2', 'git')).toEqual({ why: 'changed', now: 'none' })
    expect(f.members.p2.attempt).toBeUndefined()
    // Only P is reconciled: Q's None, matching nothing of P's attempt, never makes it stuck.
    expect(reconcile(f, { p1: pBack[0].before })).toEqual({ back: [], untouched: ['p1'] })
    expect(reconcile(f, { p1: pBack[0].after })).toEqual({ forward: true })
    // Settled, Q keeps its own choice.
    settle(meta, S, f.generation, { p1: pBack[0].before, p2: snap('git') })
    const now = readFence(meta, S)
    expect(now && typeof now === 'object' && now.members.p2.current.platform).toBe('none')
    expect(admit(meta, 'p2', 'none')).toBeNull()
  })

  it('leaves the fence once it is off the store; never while it takes part in a switch under way', () => {
    const meta = afterOptOut()
    expect(dropMember(meta, 'p2')).toBe(true)
    expect(meta.get(MEMBER_KEY('p2'))).toBeNull()
    const f = readFence(meta, S)
    expect(f && typeof f === 'object' && Object.keys(f.members)).toEqual(['p1'])
    // Now outside any fence, its admissions follow the store map as anyone's.
    expect(admit(meta, 'p2', 'none')).toBeNull()
    beginSwitch(meta, S, pBack, owner)
    expect(dropMember(meta, 'p1')).toBe(false)
    expect(meta.get(MEMBER_KEY('p1'))).not.toBeNull()
  })
})

describe('reconcile (s23 §1): from what each member’s disk shows', () => {
  const f = { generation: 1, state: 'switching' as const, owner, members: Object.fromEntries(group.map((m) => [m.id, { path: m.path, current: m.before, attempt: { generation: 1, before: m.before, after: m.after } }])) }
  it('forward only when every member shows its after', () => {
    expect(reconcile(f, { p1: group[0].after, p2: group[1].after })).toEqual({ forward: true })
  })
  it('back when one shows after and one before (a crash after one write): only the one written goes back', () => {
    expect(reconcile(f, { p1: group[0].after, p2: group[1].before })).toEqual({ back: ['p1'], untouched: ['p2'] })
    expect(reconcile(f, { p1: group[0].before, p2: group[1].before })).toEqual({ back: [], untouched: ['p1', 'p2'] })
  })
  it('stuck (fail closed) on a member edited by hand or unreadable (1e)', () => {
    expect(reconcile(f, { p1: snap('git', { platform: 'git', preset: 'team' }), p2: group[1].before })).toEqual({ stuck: ['p1'] })
    expect(reconcile(f, { p1: null, p2: group[1].before })).toEqual({ stuck: ['p1'] })
  })
})
