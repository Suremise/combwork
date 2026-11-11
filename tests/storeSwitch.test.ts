// A switch between Git and jj (HI-2799, s17 to s26; src/main/workflow/storeSwitch.ts) on a real workspace: two projects
// on one repository (the workspace's own Git repository, a `.jj` beside its `.git`), the switch paused at its seams while
// the other project tries to start a card, a lane, a slot's and a copy's lease; the drain's refusal, a failed save and
// its rollback, recovery started during a switch and after a dead owner's, and a group changed after its warning. jj's
// own checks (its confirmation, the gates, the fallback) are stood in for here (`storeSwitchSeams.repo`): the real-jj
// tests run them.
import { execFileSync } from 'child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-storeswitch-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const sw = await import('../src/main/workflow/platformSwitch')
const ss = await import('../src/main/workflow/storeSwitch')
const { workflowFor } = await import('../src/main/workflow/service')
const { SlotStore } = await import('../src/main/slots')
const { CopyStore } = await import('../src/main/copies')
const { boardConn } = await import('../src/main/slotsApp')
const { metaOf } = await import('../src/main/platform/fenceAdmit')
const { beginSwitch, FENCE_KEY, MEMBER_KEY, readFence, storeKey } = await import('../src/main/platform/platformFence')
const { commonGitDir, heldStoreKeys, storeKeyOf } = await import('../src/main/repoLock')
const { withFolderRepoLocks } = await import('../src/main/platform/repoPorts')
const { agentActor } = await import('../src/shared/workflow/facts')
const { projectPlatform } = await import('../src/main/platform/registry')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  ss.storeSwitchSeams.at = undefined
  ss.storeSwitchSeams.write = undefined
})
// jj's own checks stood in for: a colocated jj repository, nothing it doesn't support, ready to go back.
ss.storeSwitchSeams.repo = { ready: async () => null, gates: async () => [], fallback: async () => [] }

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
const user = { kind: 'user' } as const

/** A workspace that is one Git repository with a `.jj` beside its `.git`, its projects p and q inside it (one store). */
async function workspace(platforms: { p: 'git' | 'none'; q: 'git' | 'none' }): Promise<{ w: WS; p: string; q: string }> {
  const ws = join(base, `ws-${++n}`)
  const p = join(ws, 'p')
  const q = join(ws, 'q')
  for (const d of [p, q, ws]) mkdirSync(join(d, '.combwork'), { recursive: true })
  writeFileSync(join(p, 'a.txt'), 'a\n')
  writeFileSync(join(q, 'b.txt'), 'b\n')
  git(ws, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(ws, 'config', k, v)
  writeFileSync(join(ws, '.gitignore'), '.combwork/\n.jj/\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '-qm', 'initial')
  mkdirSync(join(ws, '.jj'))
  const opts = { platform: 'git', preset: null, options: {} }
  for (const [dir, id, platform] of [[p, 'p', platforms.p], [q, 'q', platforms.q]] as const) writeFileSync(join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, id, platform, agents: [{ id: `b-${id}`, name: `B${id.toUpperCase()}`, role: 'builder' }, { id: `r-${id}`, name: `R${id.toUpperCase()}`, role: 'reviewer' }], workflow: { ...opts, platform, preset: platform === 'git' ? 'pair' : 'solo' } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, p, q }
}

const platformIn = async (w: WS, dir: string): Promise<string | undefined> => (await w.projectConfig(dir)).platform
/** A card start of `project` through its runtime as it is now (a fresh one after a switch). */
async function startCard(w: WS, dir: string, project: 'p' | 'q') {
  const card = await inWorkspace(w, () => tasks.createTask({ title: `Card ${project}`, project }, user))
  const wf = (await workflowFor(w, dir))!
  return store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor(`b-${project}`)))
}
/** The project's id (the workspace gives each one its own on open), as the slot and copy tables key it. */
const idOf = async (w: WS, dir: string): Promise<string> => (await w.projectConfig(dir)).id!
const slotTake = async (w: WS, dir: string) => new SlotStore(boardConn(w), await idOf(w, dir)).take({ agent: 'b-x', card: 999 }, { size: 2, root: join(base, 'slots'), target: 'main', token: 't-x', holder: { pid: process.pid, started: 1 } })
const copyTake = async (w: WS, dir: string) => new CopyStore(boardConn(w), await idOf(w, dir)).take({ kind: 'review', card: 999, revision: 'abc' }, { size: 2, dir: join(base, 'copies'), token: 'c-x', holder: { pid: process.pid, started: 1 }, profile: 'test' })
const fenceOf = async (w: WS, dir: string) => { const id = await idOf(w, dir); return store.boardRead(w, (db) => {
  const m = metaOf(db).get(MEMBER_KEY(id))
  return m ? readFence(metaOf(db), (JSON.parse(m) as { store: string }).store) : null
}) }

/** Pauses the switch at a seam until `go` is called. */
function pauseAt(point: 'afterBegin' | 'afterDrain' | 'afterWrite' | 'beforeSettle') {
  let go!: () => void
  let reached!: () => void
  const at = new Promise<void>((r) => (reached = r))
  const release = new Promise<void>((r) => (go = r))
  ss.storeSwitchSeams.at = async (pt) => {
    if (pt !== point) return
    reached()
    await release
  }
  return { at, go }
}

describe('a switch between Git and jj is the repository’s (HI-2799)', () => {
  it('names the group, and refuses every admission of a member while it switches (1a, 2f, the leases)', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    // A runtime of P from before the switch: its starts compiled under Git (1b).
    const staleP = (await workflowFor(w, p))!
    const check = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(check.refused).toBeNull()
    expect(check.store?.group.map((g) => g.name).sort()).toEqual(['p', 'q'])
    const admissionsRefused = async (): Promise<void> => {
      // Q's card start, lane start, slot lease and copy lease, and P's own: each refused while it switches.
      expect(await startCard(w, q, 'q')).toMatchObject({ refused: true, rule: 'platform.switching' })
      const qCard = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'q' }, user))
      await expect(lanes.startLane(w, { project: 'q', builder: 'b-q', reviewer: 'r-q', cards: [qCard.number], name: 'q lane', by: 'BQ (q)' })).rejects.toThrow(/being switched/)
      await expect(slotTake(w, q)).rejects.toThrow(/being switched/)
      await expect(copyTake(w, q)).rejects.toThrow(/being switched/)
      expect(await startCard(w, p, 'p')).toMatchObject({ refused: true, rule: 'platform.switching' })
    }
    const pause = pauseAt('afterBegin')
    const switching = sw.setPlatform(w, p, 'jj', { expected: 'git', token: check.store!.token })
    await pause.at
    try {
      await admissionsRefused()
    } finally {
      pause.go()
      await switching
    }
    expect(await platformIn(w, p)).toBe('jj')
    expect(await platformIn(w, q)).toBe('jj')
    // After: Q's start resolves afresh under jj (since J9e, HI-2874, it reaches jj's adapter, which can't read this
    // fixture's folder as a jj repository); P's stale runtime is refused as changed.
    expect((await workflowFor(w, q))!.currentRuleset(false).options.platform).toBe('jj')
    expect(await startCard(w, q, 'q')).toMatchObject({ refused: true, rule: 'platform.unknown' })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'Stale', project: 'p' }, user))
    expect(await store.boardWrite(w, async () => staleP.start(`#${card.number}`, agentActor('b-p')))).toMatchObject({ refused: true, rule: 'platform.changed' })
    // A Git slot lease of Q (compiled Git) is refused as changed; a jj one isn't refused by the fence.
    await expect(slotTake(w, q)).rejects.toThrow(/uses jj now/)
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled' })
    // And back to Git, paused after its drain read: the same refusals; then Git again for both.
    const back = await sw.checkPlatformSwitch(w, q, 'git')
    expect(back.refused).toBeNull()
    const pause2 = pauseAt('afterDrain')
    const switchingBack = sw.setPlatform(w, q, 'git', { expected: 'jj', token: back.store!.token })
    await pause2.at
    try {
      // Q compiles jj's rules now (its start reaches jj's adapter, J9e); its Git copy lease meets the fence.
      expect(await startCard(w, q, 'q')).toMatchObject({ refused: true, rule: 'platform.unknown' })
      await expect(copyTake(w, p)).rejects.toThrow(/being switched/)
      await expect(slotTake(w, q)).rejects.toThrow(/being switched/)
    } finally {
      pause2.go()
      await switchingBack
    }
    expect(await platformIn(w, p)).toBe('git')
    expect(await platformIn(w, q)).toBe('git')
  })

  it('refuses while anything runs on the repository, and an admission between the check and the switch makes it refuse (drain)', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    const token = (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token
    // A lane started in Q after the warning: the switch refuses, listing it; nothing changed.
    const qCard = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'q' }, user))
    await lanes.startLane(w, { project: 'q', builder: 'b-q', reviewer: 'r-q', cards: [qCard.number], name: 'q lane', by: 'BQ (q)' })
    const check = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(check.refused).toEqual({ why: 'drain' })
    expect(check.store?.drain.lanes.map((l) => l.project)).toEqual(['q'])
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'git', token: check.store!.token })).rejects.toThrow(/still running/)
    void token
    expect(await platformIn(w, p)).toBe('git')
    expect(await platformIn(w, q)).toBe('git')
  })

  it("a member that left for None takes no part in a later switch: its start admitted while it runs, a failed save never stuck on it (HR2 round 1)", async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    // Q chooses None by itself: its own switch, recorded in its fence membership.
    expect(await sw.setPlatform(w, q, 'none', { expected: 'jj' })).toEqual({ from: 'jj', to: 'none' })
    const back = (await sw.checkPlatformSwitch(w, p, 'git')).store!
    expect(back.group.map((g) => g.name)).toEqual(['p'])
    const pause = pauseAt('afterBegin')
    // P's save back to Git then fails: rolled back from the disk, P alone.
    ss.storeSwitchSeams.write = async () => {
      throw new Error('disk full')
    }
    const switching = sw.setPlatform(w, p, 'git', { expected: 'jj', token: back.token })
    await pause.at
    try {
      expect(await startCard(w, q, 'q')).not.toMatchObject({ rule: 'platform.switching' })
    } finally {
      pause.go()
      await expect(switching).rejects.toThrow(/disk full/)
    }
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'jj' } }, [await idOf(w, q)]: { current: { platform: 'none' } } } })
    expect(await platformIn(w, p)).toBe('jj')
    expect(await platformIn(w, q)).toBe('none')
    expect(await startCard(w, q, 'q')).not.toMatchObject({ refused: true, rule: expect.stringMatching(/^platform\./) })
  })

  it('a group changed after its warning is refused, and a fresh warning gives the new group (1f)', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'none' })
    const first = (await sw.checkPlatformSwitch(w, p, 'jj')).store!
    expect(first.group.map((g) => g.name)).toEqual(['p'])
    // Q takes Git meanwhile: it joins the group.
    await w.mutateProjectConfig(q, () => ({ platform: 'git' }))
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'git', token: first.token })).rejects.toThrow(/changed meanwhile/)
    const again = (await sw.checkPlatformSwitch(w, p, 'jj')).store!
    expect(again.group.map((g) => g.name).sort()).toEqual(['p', 'q'])
    expect(await platformIn(w, p)).toBe('git')
  })

  it('a failed save rolls back each member to its own before, and fresh admissions use it (1d, 2a)', async () => {
    const { w, p, q } = await workspace({ p: 'none', q: 'git' })
    const before = { p: await w.projectConfig(p), q: await w.projectConfig(q) }
    const token = (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token
    // P (None) is written, then Q's save fails.
    // The first member is written, the second's save fails (whichever comes first: ids are random here).
    let writes = 0
    ss.storeSwitchSeams.write = async (path, partial) => {
      if (++writes === 2) throw new Error('disk full')
      await w.mutateProjectConfig(path, () => partial, { existing: true })
    }
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'none', token })).rejects.toThrow(/disk full/)
    const now = { p: await w.projectConfig(p), q: await w.projectConfig(q) }
    expect(now.p.platform).toBe('none')
    expect(now.q.platform).toBe('git')
    expect(now.p.workflow).toEqual(before.p.workflow)
    expect(now.q.workflow).toEqual(before.q.workflow)
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'none' } }, [await idOf(w, q)]: { current: { platform: 'git' } } } })
    // Fresh admissions: P under None, Q under Git, no changed loop.
    expect(await startCard(w, q, 'q')).not.toMatchObject({ rule: 'platform.changed' })
    expect(await startCard(w, p, 'p')).toMatchObject({ ok: true })
  })

  it('a save that persisted though its call failed settles forward by the disk (2b)', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    const token = (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token
    // The last member's save persists, but its call fails (members are written in their ids' order, random here).
    let writes = 0
    ss.storeSwitchSeams.write = async (path, partial) => {
      await w.mutateProjectConfig(path, () => partial, { existing: true })
      if (++writes === 2) throw new Error('lost reply')
    }
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'git', token })).rejects.toThrow(/lost reply/)
    expect(await platformIn(w, p)).toBe('jj')
    expect(await platformIn(w, q)).toBe('jj')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'jj' } } } })
  })

  it('recovery started while a switch is paused after A never settles it: its owner is live (2c)', async () => {
    const { w, p } = await workspace({ p: 'git', q: 'git' })
    const token = (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token
    const pause = pauseAt('afterWrite')
    const switching = sw.setPlatform(w, p, 'jj', { expected: 'git', token })
    await pause.at
    try {
      // Its owner is live (this process's switch): recovery leaves its fence alone, never settles or rolls it back.
      await ss.recoverFences(w)
      expect(await fenceOf(w, p)).toMatchObject({ state: 'switching' })
      expect(await platformIn(w, p)).toBe('jj')
    } finally {
      pause.go()
      await switching
    }
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'jj' } } } })
    expect(await platformIn(w, p)).toBe('jj')
  })

  it("a dead owner's switch is recovered from the disks: one written, one not, rolled back; then admitted as before (2d)", async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    const storeId = storeKey(await commonGitDir(p))
    const before = { p: await w.projectConfig(p), q: await w.projectConfig(q) }
    const snap = (c: typeof before.p) => ({ platform: c.platform as 'git', ...(c.workflow ? { workflow: JSON.parse(JSON.stringify(c.workflow)) as unknown } : {}) })
    const after = (c: typeof before.p) => ({ platform: 'jj' as const, platformFound: 'jj', ...(c.workflow ? { workflow: { ...(c.workflow as object), platform: 'jj' } } : {}) })
    // A switch that died after A and after writing P: its fence switching, its owner a process that's gone.
    const [ip, iq] = [await idOf(w, p), await idOf(w, q)]
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => beginSwitch(metaOf(db), storeId, [{ id: ip, path: p, before: snap(before.p), after: after(before.p) }, { id: iq, path: q, before: snap(before.q), after: after(before.q) }], { token: 'dead', pid: 2 ** 22 + 7, profile: 'gone' })))
    await w.mutateProjectConfig(p, () => ({ platform: 'jj', platformFound: 'jj', workflow: after(before.p).workflow as never }), { existing: true })
    expect(await startCard(w, q, 'q')).toMatchObject({ refused: true, rule: 'platform.switching' })
    await ss.recoverFences(w)
    expect(await platformIn(w, p)).toBe('git')
    expect((await w.projectConfig(p)).workflow).toEqual(before.p.workflow)
    expect(await platformIn(w, q)).toBe('git')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'git' } }, [await idOf(w, q)]: { current: { platform: 'git' } } } })
    // Fresh admissions under each one's own before: no changed loop.
    expect(await startCard(w, q, 'q')).not.toMatchObject({ rule: 'platform.changed' })
    expect(await startCard(w, p, 'p')).not.toMatchObject({ rule: 'platform.changed' })
  })

  it('a member edited by hand while its switch was dead leaves the fence switching: nothing of it touched (1e)', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    const storeId = storeKey(await commonGitDir(p))
    const cfg = await w.projectConfig(p)
    const snapP = { platform: 'git' as const, workflow: JSON.parse(JSON.stringify(cfg.workflow)) as unknown }
    const ip = await idOf(w, p)
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => beginSwitch(metaOf(db), storeId, [{ id: ip, path: p, before: snapP, after: { platform: 'jj', platformFound: 'jj', workflow: { platform: 'jj' } } }], { token: 'dead', pid: 2 ** 22 + 7, profile: 'gone' })))
    await w.mutateProjectConfig(p, () => ({ platform: 'none' }), { existing: true })
    await ss.recoverFences(w)
    expect(await fenceOf(w, p)).toMatchObject({ state: 'switching' })
    expect(await platformIn(w, p)).toBe('none')
    expect(await startCard(w, p, 'p')).toMatchObject({ refused: true, rule: 'platform.switching' })
    void q
  })
})

describe("a fence member's switch to None is drained (HI-2974)", () => {
  let k = 0
  const lease = async (w: WS, dir: string, platform: 'git' | 'jj' = 'git') => new SlotStore(boardConn(w), await idOf(w, dir)).take({ agent: `b-m${++k}`, card: 800 + k }, { size: 4, root: join(base, `mslots-${k}`), target: 'main', token: `tm-${k}`, holder: { pid: process.pid, started: 1 }, platform })
  const copy = async (w: WS, dir: string, platform: 'git' | 'jj' = 'git') => new CopyStore(boardConn(w), await idOf(w, dir)).take({ kind: 'review', card: 800 + ++k, revision: 'abc' }, { size: 4, dir: join(base, `mcopies-${k}`), token: `cm-${k}`, holder: { pid: process.pid, started: 1 }, profile: 'test', platform })
  const leaseOk = async (w: WS, dir: string, platform: 'git' | 'jj' = 'git') => expect((await lease(w, dir, platform)).ok).toBe(true)
  const copyOk = async (w: WS, dir: string, platform: 'git' | 'jj' = 'git') => expect((await copy(w, dir, platform)).ok).toBe(true)
  const endAll = async (w: WS, dir: string) => {
    const slots = new SlotStore(boardConn(w), await idOf(w, dir))
    for (const l of slots.openLeases()) await slots.end(l.id, 'test')
    const copies = new CopyStore(boardConn(w), await idOf(w, dir))
    const unfreed = copies.unfreed()
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => unfreed.forEach((l) => copies.dropIn(db, l.id, 'test'))))
    expect([slots.openLeases().length, copies.unfreed().length]).toEqual([0, 0])
  }
  /** P and Q through Git → jj (and back to Git when `back`): both members of their repository's fence. */
  async function members(back: boolean) {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    if (back) await sw.setPlatform(w, p, 'git', { expected: 'jj', token: (await sw.checkPlatformSwitch(w, p, 'git')).store!.token })
    return { w, p, q }
  }

  it('Git → jj → Git, then Git → None with work running: refused up front, its leases still taken; once done, switched', async () => {
    const { w, p, q } = await members(true)
    await leaseOk(w, p)
    await copyOk(w, p)
    const check = await sw.checkPlatformSwitch(w, p, 'none')
    expect(check.refused).toEqual({ why: 'memberDrain' })
    expect(check.store?.group).toEqual([])
    expect(check.store?.drain.slots.map((s) => s.project)).toEqual(['p'])
    expect(check.store?.drain.copies.map((c) => c.project)).toEqual(['p'])
    await expect(sw.setPlatform(w, p, 'none', { expected: 'git' })).rejects.toThrow(/Work is still running in this project/)
    // Nothing changed: P is still Git, its fence settled, and its work goes on taking leases.
    expect(await platformIn(w, p)).toBe('git')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'git' } } } })
    await leaseOk(w, p)
    await copyOk(w, p)
    // Once it has finished: switched, through the fence; Q took no part and keeps Git.
    await endAll(w, p)
    expect((await sw.checkPlatformSwitch(w, p, 'none')).refused).toBeNull()
    expect(await sw.setPlatform(w, p, 'none', { expected: 'git' })).toEqual({ from: 'git', to: 'none' })
    expect(await platformIn(w, p)).toBe('none')
    expect(await platformIn(w, q)).toBe('git')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'none' } }, [await idOf(w, q)]: { current: { platform: 'git' } } } })
    await leaseOk(w, q)
  })

  it('jj → None with a jj card running: refused, both still jj, and a later switch of Q to Git drains P’s work too', async () => {
    const { w, p, q } = await members(false)
    await leaseOk(w, p, 'jj')
    expect((await sw.checkPlatformSwitch(w, p, 'none')).refused).toEqual({ why: 'memberDrain' })
    await expect(sw.setPlatform(w, p, 'none', { expected: 'jj' })).rejects.toThrow(/Work is still running in this project/)
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'jj'])
    await leaseOk(w, p, 'jj')
    await copyOk(w, q, 'jj')
    // P stayed in the group, so Q's switch of the repository to Git waits for P's jj work.
    const back = await sw.checkPlatformSwitch(w, q, 'git')
    expect(back.refused).toEqual({ why: 'drain' })
    expect(back.store?.group.map((g) => g.name).sort()).toEqual(['p', 'q'])
    expect(back.store?.drain.slots.map((s) => s.project)).toEqual(['p', 'p'])
  })

  it('paused after its begin, then after its drain: nothing of the project is admitted, the other member is told to try again', async () => {
    const { w, p, q } = await members(true)
    for (const point of ['afterBegin', 'afterDrain'] as const) {
      const pause = pauseAt(point)
      const switching = sw.setPlatform(w, p, 'none', { expected: 'git' })
      await pause.at
      try {
        expect(await startCard(w, p, 'p')).toMatchObject({ refused: true, rule: 'platform.switching' })
        await expect(lease(w, p)).rejects.toThrow(/being switched/)
        await expect(copy(w, p)).rejects.toThrow(/being switched/)
        await expect(lease(w, q)).rejects.toThrow(/being switched/)
      } finally {
        pause.go()
      }
      expect(await switching).toEqual({ from: 'git', to: 'none' })
      expect(await platformIn(w, p)).toBe('none')
      ss.storeSwitchSeams.at = undefined
      // Back to Git for the next pause.
      if (point === 'afterBegin') {
        const c = await sw.checkPlatformSwitch(w, p, 'git')
        expect(c.refused).toBeNull()
        await sw.setPlatform(w, p, 'git', { expected: 'none', ...(c.store ? { token: c.store.token } : {}) })
        expect(await platformIn(w, p)).toBe('git')
      }
    }
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled' })
  })

  it('a failed save rolls back to its before: the fence settled on Git, its admissions as before', async () => {
    const { w, p } = await members(true)
    ss.storeSwitchSeams.write = async () => {
      throw new Error('disk full')
    }
    await expect(sw.setPlatform(w, p, 'none', { expected: 'git' })).rejects.toThrow(/disk full/)
    ss.storeSwitchSeams.write = undefined
    expect(await platformIn(w, p)).toBe('git')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'git' } } } })
    await leaseOk(w, p)
  })

  it('an unreadable fence refuses, never falling through to an unfenced switch', async () => {
    const { w, p } = await members(true)
    const storeId = storeKey(await commonGitDir(p))
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => metaOf(db).set(FENCE_KEY(storeId), '{not json')))
    expect((await sw.checkPlatformSwitch(w, p, 'none')).refused).toEqual({ why: 'switching' })
    await expect(sw.setPlatform(w, p, 'none', { expected: 'git' })).rejects.toThrow(/being switched/)
    expect(await platformIn(w, p)).toBe('git')
  })

  it('control: a project never switched goes to None with its work running, which keeps its leases (its old rules)', async () => {
    const { w, p } = await workspace({ p: 'git', q: 'git' })
    await leaseOk(w, p)
    const check = await sw.checkPlatformSwitch(w, p, 'none')
    expect(check.refused).toBeNull()
    expect(check.store).toBeUndefined()
    await sw.setPlatform(w, p, 'none', { expected: 'git' })
    expect(await platformIn(w, p)).toBe('none')
    await leaseOk(w, p)
    await copyOk(w, p)
  })
})

/**
 * A workspace that is one non-colocated jj repository (HI-2896): `.jj` with its Git store inside (`.jj/repo/store/git`, a
 * bare repository, J0's layout written by hand: jj's own checks are stood in for here), no `.git`; projects p and q in it.
 */
async function separateWorkspace(): Promise<{ w: WS; p: string; q: string; gitStore: string }> {
  const ws = join(base, `sep-${++n}`)
  const p = join(ws, 'p')
  const q = join(ws, 'q')
  for (const d of [p, q, ws]) mkdirSync(join(d, '.combwork'), { recursive: true })
  const st = join(ws, '.jj', 'repo', 'store')
  mkdirSync(st, { recursive: true })
  writeFileSync(join(st, 'type'), 'git')
  writeFileSync(join(st, 'git_target'), 'git')
  git(st, 'init', '-q', '--bare', 'git')
  for (const [dir, id] of [[p, 'p'], [q, 'q']] as const) writeFileSync(join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, id, platform: 'none', agents: [{ id: `b-${id}`, name: `B${id.toUpperCase()}`, role: 'builder' }, { id: `r-${id}`, name: `R${id.toUpperCase()}`, role: 'reviewer' }], workflow: { platform: 'none', preset: 'solo', options: {} } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, p, q, gitStore: join(st, 'git') }
}

describe('back to Git from jj (HI-2975)', () => {
  /** P and Q switched to jj (jj's checks stood in for), so the repository is theirs as jj's. */
  async function onJj() {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'jj'])
    return { w, p, q }
  }

  it('its .jj gone, Git still there: the offered switch back to Git goes through, its readiness read by the real fallback check', async () => {
    const { w, p, q } = await onJj()
    rmSync(join(w.path!, '.jj'), { recursive: true })
    expect(projectPlatform(p, 'jj', 'jj').offer).toEqual({ offer: 'git', why: 'jjGone' })
    const seams = ss.storeSwitchSeams.repo
    ss.storeSwitchSeams.repo = { ...seams, fallback: undefined }
    try {
      // No jj repository: nothing to export, nothing that can conflict (fallbackOf itself, which runs no jj here).
      expect(await ss.fallbackOf(p)).toEqual([])
      const check = await sw.checkPlatformSwitch(w, p, 'git')
      expect(check.refused).toBeNull()
      expect(check.store?.fallback).toEqual([])
      expect(check.store?.group.map((g) => g.name).sort()).toEqual(['p', 'q'])
      await sw.setPlatform(w, p, 'git', { expected: 'jj', token: check.store!.token })
    } finally {
      ss.storeSwitchSeams.repo = seams
    }
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['git', 'git'])
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled' })
    expect(projectPlatform(p, 'git', 'git').offer ?? null).toBeNull()
  })

  it('jj missing or not the tested version: refused saying the way out, not as a list of unknowns; nothing changed', async () => {
    const { w, p, q } = await onJj()
    const seams = ss.storeSwitchSeams.repo
    for (const detail of ['tool', 'tool: jj exited']) {
      ss.storeSwitchSeams.repo = { ...seams, fallback: async () => [{ code: 'unknown', detail }] }
      try {
        const check = await sw.checkPlatformSwitch(w, p, 'git')
        expect(check.refused).toMatchObject({ why: 'jjToolBack' })
        await expect(sw.setPlatform(w, p, 'git', { expected: 'jj', token: check.store!.token })).rejects.toThrow(/ready to go back to Git\. Install the jj Combwork is tested with, then switch\. Or, if you’re done with jj, remove the \.jj folder/)
      } finally {
        ss.storeSwitchSeams.repo = seams
      }
    }
    // Another unknown is still the fallback's list.
    ss.storeSwitchSeams.repo = { ...seams, fallback: async () => [{ code: 'unknown', detail: 'gitRefs' }] }
    try {
      expect((await sw.checkPlatformSwitch(w, p, 'git')).refused).toEqual({ why: 'fallback' })
    } finally {
      ss.storeSwitchSeams.repo = seams
    }
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'jj'])
  })
})

describe('a non-colocated jj repository switches too (HI-2896)', () => {
  it('to jj: its group is its store inside .jj, the switch holds that store’s lock; back to Git refused (no Git working copy); None its own', async () => {
    const { w, p, q, gitStore } = await separateWorkspace()
    const check = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(check.refused).toBeNull()
    expect(check.store?.group.map((g) => g.name)).toEqual(['p'])
    let held: string[] = []
    ss.storeSwitchSeams.at = (pt) => {
      if (pt === 'afterBegin') held = [...heldStoreKeys()]
    }
    await sw.setPlatform(w, p, 'jj', { expected: 'none', token: check.store!.token })
    expect(held).toEqual([storeKeyOf(realpathSync(gitStore))])
    expect(await platformIn(w, p)).toBe('jj')
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'jj' } } } })
    // Q joins: the same store, so the same group.
    expect((await sw.checkPlatformSwitch(w, q, 'jj')).store?.group.map((g) => g.name).sort()).toEqual(['p', 'q'])
    // Back to Git: refused before anything, with its own reason; None is the project's own switch.
    expect((await sw.checkPlatformSwitch(w, p, 'git')).refused).toEqual({ why: 'jjNoGitCopy' })
    await expect(sw.setPlatform(w, p, 'git', { expected: 'jj' })).rejects.toThrow(/No Git working copy here/)
    expect(await platformIn(w, p)).toBe('jj')
    await sw.setPlatform(w, p, 'none', { expected: 'jj' })
    expect(await platformIn(w, p)).toBe('none')
  })

  it('its slots folder inside a Git working tree refuses the switch (jjInGit); its .jj unreadable refuses the lock, never skips it', async () => {
    const { w, p } = await separateWorkspace()
    // The workspace's slots folder (beside it) inside a Git working tree made later.
    const outer = join(w.path!, '..')
    const slots = w.worktreesRoot
    mkdirSync(slots, { recursive: true })
    git(slots, 'init', '-q')
    const c = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(c.refused).toMatchObject({ why: 'jjInGit' })
    void outer
    // A damaged .jj (its store's type gone): the project's lock refused, nothing run.
    writeFileSync(join(w.path!, '.jj', 'repo', 'store', 'type'), '')
    let ran = false
    await expect(withFolderRepoLocks([p], async () => void (ran = true))).rejects.toThrow(/couldn't read the jj repository/)
    expect(ran).toBe(false)
  })
})
