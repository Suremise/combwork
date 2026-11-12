// A switch between Git and jj (HI-2799, s17 to s26; src/main/workflow/storeSwitch.ts) on a real workspace: two projects
// on one repository (the workspace's own Git repository, a `.jj` beside its `.git`), the switch paused at its seams while
// the other project tries to start a card, a lane, a slot's and a copy's lease; the drain's refusal, a failed save and
// its rollback, recovery started during a switch and after a dead owner's, and a group changed after its warning. jj's
// own checks (its confirmation, the gates, the fallback) are stood in for here (`storeSwitchSeams.repo`): the real-jj
// tests run them.
import { execFileSync } from 'child_process'
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
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
const { heldKey, SlotStore } = await import('../src/main/slots')
const { CopyStore } = await import('../src/main/copies')
const { boardConn } = await import('../src/main/slotsApp')
const { metaOf } = await import('../src/main/platform/fenceAdmit')
const { beginSwitch, FENCE_KEY, MEMBER_KEY, readFence, storeKey } = await import('../src/main/platform/platformFence')
const { commonGitDir, heldStoreKeys, storeKeyOf } = await import('../src/main/repoLock')
const { withFolderRepoLocks } = await import('../src/main/platform/repoPorts')
const { agentActor } = await import('../src/shared/workflow/facts')
const { projectPlatform } = await import('../src/main/platform/registry')
const notify = await import('../src/main/notify')

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
    expect(await store.boardWrite(w, async () => staleP.start(`#${card.number}`, agentActor('b-p')))).toMatchObject({ refused: true, rule: 'platform.changed', message: expect.stringContaining('its project uses jj now'), next: expect.stringContaining('under jj’s rules') })
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

  it("HI-3106: a switch to jj gives a project with no jj target Git's: the repository's default branch, or the one Git's options name; one jj already names is kept", async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    // P's Git options name a target of their own; Q's name none (its default branch, main).
    await w.mutateProjectConfig(p, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, target: 'integration' } } }), { existing: true })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'jj'])
    expect((await w.projectConfig(p)).workflow?.options?.target).toBe('integration')
    expect((await w.projectConfig(q)).workflow?.options?.target).toBe('main')
    // Back to Git and to jj again: jj's own target, kept from before, isn't replaced.
    await w.mutateProjectConfig(q, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, target: 'trunk' } } }), { existing: true })
    await sw.setPlatform(w, p, 'git', { expected: 'jj', token: (await sw.checkPlatformSwitch(w, p, 'git')).store!.token })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    expect((await w.projectConfig(q)).workflow?.options?.target).toBe('trunk')
  })

  it("HI-3106: a jj start with no target chosen is refused saying so (platform.noTarget), never as an unreadable blank", async () => {
    const { w, q } = await workspace({ p: 'git', q: 'git' })
    await sw.setPlatform(w, q, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, q, 'jj')).store!.token })
    await w.mutateProjectConfig(q, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, folder: 'slots', target: '' } } }), { existing: true })
    const r = await startCard(w, q, 'q')
    expect(r).toMatchObject({ refused: true, rule: 'platform.noTarget' })
    expect(JSON.stringify(r)).toContain('has no target bookmark chosen')
    expect(JSON.stringify(r)).toContain('Choose one in Version Control → Workflow (Work merges into)')
    expect(JSON.stringify(r)).not.toContain('Provider Setup')
  })

  describe('HI-3104: a Git start in a project folder on no branch', () => {
    const wsOf = (p: string) => join(p, '..')
    it('detached, its branch proved: refused naming it; checked out: it starts', async () => {
      const { w, p } = await workspace({ p: 'git', q: 'git' })
      git(wsOf(p), 'checkout', '-q', '--detach')
      const head = git(wsOf(p), 'rev-parse', '--short=7', 'HEAD')
      const r = await startCard(w, p, 'p')
      expect(r).toMatchObject({ refused: true, rule: 'platform.detachedFolder' })
      expect(JSON.stringify(r)).toContain(`the project folder is on no branch (its head is detached at ${head})`)
      expect(JSON.stringify(r)).toContain('Check out its branch in the project folder (git switch main)')
      git(wsOf(p), 'checkout', '-q', 'main')
      expect(await startCard(w, p, 'p')).not.toMatchObject({ rule: 'platform.detachedFolder' })
    })

    it('detached with no local branch to name: the general instruction, never a guessed branch', async () => {
      const { w, p } = await workspace({ p: 'git', q: 'git' })
      git(wsOf(p), 'checkout', '-q', '--detach')
      git(wsOf(p), 'branch', '-q', '-D', 'main')
      const r = await startCard(w, p, 'p')
      expect(r).toMatchObject({ refused: true, rule: 'platform.detachedFolder' })
      expect(JSON.stringify(r)).toContain('Check out a branch in the project folder (an existing one with git switch, or a new one with git switch -c)')
      expect(JSON.stringify(r)).not.toMatch(/git switch (main|undefined|null|HEAD)\b/)
    })

    it('a no-code card, and a slots start waiting for a slot: never refused for the project folder’s head', async () => {
      const { w, p } = await workspace({ p: 'git', q: 'git' })
      git(wsOf(p), 'checkout', '-q', '--detach')
      const noCode = await inWorkspace(w, () => tasks.createTask({ title: 'Look only', project: 'p', kind: 'no-code' }, user))
      const wf = (await workflowFor(w, p))!
      expect(await store.boardWrite(w, async () => wf.start(`#${noCode.number}`, agentActor('b-p')))).not.toMatchObject({ rule: 'platform.detachedFolder' })
      await w.mutateProjectConfig(p, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, folder: 'slots' } } }), { existing: true })
      const service = await import('../src/main/workflow/service')
      service.setSlotStarts({ leaseFor: async () => ({ wait: 'every slot is in use' }), unused: async () => undefined })
      try {
        const busy = await startCard(w, p, 'p')
        expect(busy).not.toMatchObject({ rule: 'platform.detachedFolder' })
        // As before this card (the provisional plan's target is the folder's line, none when detached, so the evidence
        // read first differs: evidence.changed, carded separately); never the detached refusal.
        expect(busy).toMatchObject({ refused: true, rule: 'evidence.changed' })
        git(wsOf(p), 'checkout', '-q', 'main')
        expect(await startCard(w, p, 'p')).toMatchObject({ refused: true, rule: 'start.slotAvailable' })
      } finally {
        service.setSlotStarts(null)
      }
    })
  })

  it('HI-3104: the switch back to Git lists each member whose folder is on no branch, with its head', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    await sw.setPlatform(w, p, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, p, 'jj')).store!.token })
    expect((await sw.checkPlatformSwitch(w, p, 'git')).store?.detached).toBeUndefined()
    git(join(p, '..'), 'checkout', '-q', '--detach')
    const head = git(join(p, '..'), 'rev-parse', '--short=7', 'HEAD')
    const back = await sw.checkPlatformSwitch(w, p, 'git')
    expect(back.store?.detached?.map((d) => [d.project, d.head]).sort()).toEqual([['p', head], ['q', head]])
    expect(back.refused).toBeNull()
    void q
  })

  it('HI-3105: a fallback read that only raced a moving operation head is read again; anything else is the answer at once', async () => {
    const moved = [{ code: 'unknown' as const, detail: 'moved' }]
    const ready: { code: 'notExported'; name: string }[] = []
    const seq = (answers: unknown[]) => {
      let i = 0
      const read = async () => answers[Math.min(i++, answers.length - 1)] as never
      return { read, count: () => i }
    }
    const a = seq([moved, moved, ready])
    expect(await ss.retryMoved(a.read)).toEqual([])
    expect(a.count()).toBe(3)
    const b = seq([moved, moved, moved, ready])
    expect(await ss.retryMoved(b.read)).toEqual(moved)
    expect(b.count()).toBe(3)
    const other = [{ code: 'unknown' as const, detail: 'heads: 2' }]
    const c = seq([other, ready])
    expect(await ss.retryMoved(c.read)).toEqual(other)
    expect(c.count()).toBe(1)
    const d = seq([[{ code: 'notExported', name: 'main' }]])
    expect(await ss.retryMoved(d.read)).toEqual([{ code: 'notExported', name: 'main' }])
    expect(d.count()).toBe(1)
  })

  it("HI-3105 (HR1's round 1): after a refusal at Switch, the dialog gives way to a fresh look when the check reads clear or refuses with lists, else keeps the error", async () => {
    const { rereadAfterRefusal } = await import('../src/shared/platform/switching')
    const shown = { group: [], token: 't', drain: { lanes: [], cards: [], queue: [], slots: [], copies: [], kept: [] } }
    // The race passed: clear now, a fresh confirmation (no switch made by itself).
    expect(rereadAfterRefusal({ refused: null, store: shown })).toBe(true)
    // What the warning lists changed: the refused dialog with its lists.
    expect(rereadAfterRefusal({ refused: { why: 'drain' }, store: shown })).toBe(true)
    expect(rereadAfterRefusal({ refused: { why: 'fallback' }, store: shown })).toBe(true)
    // The check itself couldn't be read, or refuses for something with no list: the original error stays.
    expect(rereadAfterRefusal(null)).toBe(false)
    expect(rereadAfterRefusal({ refused: { why: 'noGit' } })).toBe(false)
    expect(rereadAfterRefusal({ refused: { why: 'drain' } })).toBe(false)
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

  /** A switch of P and Q begun by a Combwork that died, its owner as given; P written to jj before it died. */
  async function deadSwitch(owner: { pid: number; started?: number }) {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    const storeId = storeKey(await commonGitDir(p))
    const before = { p: await w.projectConfig(p), q: await w.projectConfig(q) }
    const snap = (c: typeof before.p) => ({ platform: c.platform as 'git', ...(c.workflow ? { workflow: JSON.parse(JSON.stringify(c.workflow)) as unknown } : {}) })
    const after = (c: typeof before.p) => ({ platform: 'jj' as const, platformFound: 'jj', ...(c.workflow ? { workflow: { ...(c.workflow as object), platform: 'jj' } } : {}) })
    const [ip, iq] = [await idOf(w, p), await idOf(w, q)]
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => beginSwitch(metaOf(db), storeId, [{ id: ip, path: p, before: snap(before.p), after: after(before.p) }, { id: iq, path: q, before: snap(before.q), after: after(before.q) }], { token: 'dead', profile: 'gone', ...owner })))
    return { w, p, q }
  }

  it('HI-3073: its owner recorded with its start time, its pid since given to another living process: recovered as dead (the real probe)', async () => {
    // This test's parent is alive, but it didn't start at the recorded time: not the switch's owner.
    const { w, p, q } = await deadSwitch({ pid: process.ppid, started: 1 })
    expect(await startCard(w, q, 'q')).toMatchObject({ refused: true, rule: 'platform.switching' })
    await ss.recoverFences(w)
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled' })
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['git', 'git'])
    expect(await startCard(w, q, 'q')).not.toMatchObject({ rule: 'platform.switching' })
  })

  it.each([
    ['running, started then', true],
    ["can't be told (the probe unreadable)", null]
  ] as const)('HI-3073: its owner %s: the switch is left as it is, its owner’s (fail closed)', async (_what, alive) => {
    const asked: [number, number][] = []
    ss.storeSwitchSeams.processes = { alive: async (pid, started) => (asked.push([pid, started]), alive) }
    try {
      const { w, p } = await deadSwitch({ pid: process.ppid, started: 1234 })
      await ss.recoverFences(w)
      expect(asked).toContainEqual([process.ppid, 1234])
      expect(await fenceOf(w, p)).toMatchObject({ state: 'switching' })
    } finally {
      ss.storeSwitchSeams.processes = undefined
    }
  })

  it('HI-3073: a switch whose owner is gone and that can’t be settled is said in a notice, once, naming its projects', async () => {
    const sent: string[] = []
    const win = { isDestroyed: () => false, webContents: { id: 9, send: (...a: unknown[]) => void sent.push(JSON.stringify(a)) } }
    notify.setNotifyHost({ focused: () => ({ win: win as never, workspacePath: 'x', projectPath: null }), fallback: () => win as never, workspaceOf: () => 'x' })
    try {
      const { w, p } = await deadSwitch({ pid: 2 ** 22 + 9 })
      // P edited by hand meanwhile: neither its before nor its after, so the switch stays stuck.
      await w.mutateProjectConfig(p, () => ({ platform: 'none' }), { existing: true })
      await ss.recoverFences(w)
      expect(await fenceOf(w, p)).toMatchObject({ state: 'switching' })
      const told = sent.filter((x) => x.includes('A version control switch couldn’t be finished'))
      expect(told).toHaveLength(1)
      expect(told[0]).toContain('Combwork stopped while switching p and q between Git and jj')
      expect(told[0]).toMatch(/p changed or can’t be read/)
      await ss.recoverFences(w)
      expect(sent.filter((x) => x.includes('A version control switch couldn’t be finished'))).toHaveLength(1)
      // HR1's round 1: workspace A closed, then another workspace on the same repository (its own board), its own stuck
      // switch at the same generation: told too, once, naming its own projects.
      await disposeWorkspaceService(w)
      opened.splice(opened.indexOf(w), 1)
      const ws2 = join(p, '..', 'nested-ws')
      const [r, t] = [join(ws2, 'r'), join(ws2, 't')]
      for (const d of [r, t]) mkdirSync(join(d, '.combwork'), { recursive: true })
      for (const [dir, id] of [[r, 'r'], [t, 't']] as const) writeFileSync(join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, id, platform: 'git', agents: [], workflow: { platform: 'git', preset: 'solo', options: {} } }))
      const w2 = createWorkspaceService()
      await w2.open(ws2)
      opened.push(w2)
      const storeId = storeKey(await commonGitDir(r))
      expect(storeId).toBe(storeKey(await commonGitDir(p)))
      const cfg2 = { r: await w2.projectConfig(r), t: await w2.projectConfig(t) }
      const snap2 = (c: typeof cfg2.r) => ({ platform: 'git' as const, ...(c.workflow ? { workflow: JSON.parse(JSON.stringify(c.workflow)) as unknown } : {}) })
      await store.boardWrite(w2, async () => store.boardWriteOp(w2, (db) => beginSwitch(metaOf(db), storeId, [{ id: cfg2.r.id!, path: r, before: snap2(cfg2.r), after: { platform: 'jj', platformFound: 'jj' } }, { id: cfg2.t.id!, path: t, before: snap2(cfg2.t), after: { platform: 'jj', platformFound: 'jj' } }], { token: 'dead2', pid: 2 ** 22 + 11, profile: 'gone' })))
      await w2.mutateProjectConfig(r, () => ({ platform: 'none' }), { existing: true })
      await ss.recoverFences(w2)
      const both = sent.filter((x) => x.includes('A version control switch couldn’t be finished'))
      expect(both).toHaveLength(2)
      expect(both[1]).toContain('Combwork stopped while switching r and t between Git and jj')
      await ss.recoverFences(w2)
      expect(sent.filter((x) => x.includes('A version control switch couldn’t be finished'))).toHaveLength(2)
    } finally {
      notify.setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
    }
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

  const keptFolders = new Map<string, string>()
  /**
   * HI-3069: a slot of P's kept for a card (put back with commits, HI-2995): a jj slot lent and ended, its kept record
   * written as the pool writes it. `as`: the platform its row is of (one left by a switch made before this fix).
   */
  async function keptSlot(w: WS, dir: string, card: number, as: 'git' | 'jj'): Promise<string> {
    const r = await lease(w, dir, (await platformIn(w, dir)) === 'jj' ? 'jj' : 'git')
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    // Its folder there, as a kept slot's is (the lease's row alone makes none).
    mkdirSync(r.slot.folder, { recursive: true })
    keptFolders.set(r.slot.name, r.slot.folder)
    const slots = new SlotStore(boardConn(w), await idOf(w, dir))
    await slots.end(r.lease.id, 'putBack')
    const id = await idOf(w, dir)
    await store.boardWrite(w, async () =>
      store.boardWriteOp(w, (db) => {
        db.prepare('UPDATE slots SET platform = ? WHERE project = ? AND name = ?').run(as, id, r.slot.name)
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(heldKey(id, r.slot.name), JSON.stringify({ card, generation: 'g1' }))
      })
    )
    return r.slot.name
  }

  it('HI-3069: a jj slot kept for a card refuses the switch back to Git, named; once it is gone, the switch goes', async () => {
    const { w, p, q } = await members(false)
    const slot = await keptSlot(w, p, 77, 'jj')
    expect(new SlotStore(boardConn(w), await idOf(w, p)).openLeases()).toEqual([])
    const check = await sw.checkPlatformSwitch(w, q, 'git')
    expect(check.refused).toEqual({ why: 'drain' })
    expect(check.store?.drain.kept).toEqual([{ project: 'p', slot, card: 77 }])
    expect(check.store?.drain.slots).toEqual([])
    await expect(sw.setPlatform(w, q, 'git', { expected: 'jj', token: check.store!.token })).rejects.toThrow()
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'jj'])
    // To None too (P's own switch out of the fence): the kept slot could never be lent back there either.
    expect((await sw.checkPlatformSwitch(w, p, 'none')).refused).toEqual({ why: 'memberDrain' })
    // Its card finished (the record gone): the switch goes.
    const pid = await idOf(w, p)
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('DELETE FROM board_meta WHERE key = ?').run(heldKey(pid, slot))))
    const after = await sw.checkPlatformSwitch(w, q, 'git')
    expect(after.refused).toBeNull()
    expect(after.store?.drain.kept).toEqual([])
  })

  it('HI-3069: a jj slot kept while the repository is already on Git (switched before the fix) never refuses the switch back to jj', async () => {
    const { w, p, q } = await members(true)
    const slot = await keptSlot(w, p, 78, 'jj')
    const check = await sw.checkPlatformSwitch(w, q, 'jj')
    expect(check.store?.drain.kept).toEqual([])
    expect(check.refused).toBeNull()
    // Its slot is still kept: the switch back is its way on.
    expect(new SlotStore(boardConn(w), await idOf(w, p)).keptSlots()).toEqual([{ slot, card: 78, platform: 'jj' }])
  })

  it.each(['project', 'slots'] as const)('HI-3069: a card whose jj slot was kept before a switch to Git (made before the fix) is refused at its start, cards in the %s folder, naming the way on', async (folder) => {
    const { w, p } = await members(true)
    await w.mutateProjectConfig(p, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, folder } } }), { existing: true })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'Kept card', project: 'p' }, user))
    const wf = (await workflowFor(w, p))!
    expect(wf.rulesetOf(wf.store.card(card.number)).options.folder).toBe(folder)
    const slot = await keptSlot(w, p, card.number, 'jj')
    const { poolFor } = await import('../src/main/slotsApp')
    const service = await import('../src/main/workflow/service')
    service.setSlotStarts({ leaseFor: async () => null, unused: async () => undefined, keptAcross: async (ws, project, cardId) => (await poolFor(ws, project)).keptAcross(cardId) })
    try {
      const fresh = (await workflowFor(w, p))!
      const r = await store.boardWrite(w, async () => fresh.start(`#${card.number}`, agentActor('b-p')))
      expect(r).toMatchObject({ refused: true, rule: 'platform.keptAcross' })
      expect(JSON.stringify(r)).toContain(`kept in slot ${slot}, a jj slot from before the repository switched to Git`)
      expect(JSON.stringify(r)).toContain('Switch the repository back to jj')
      // The user's start too: never across it, in any folder.
      const byUser = await store.boardWrite(w, async () => fresh.start(`#${card.number}`, 'user'))
      expect(byUser).toMatchObject({ refused: true, rule: 'platform.keptAcross' })
      // Its folder deleted since: the way on is Remove… (HR1's round 3: worded from the folder now, not the row).
      rmSync(keptFolders.get(slot)!, { recursive: true, force: true })
      const gone = await store.boardWrite(w, async () => fresh.start(`#${card.number}`, agentActor('b-p')))
      expect(gone).toMatchObject({ refused: true, rule: 'platform.keptAcross' })
      expect(JSON.stringify(gone)).toContain('Its folder is gone')
      expect(JSON.stringify(gone)).toContain('Remove…')
      // Another card starts as before.
      expect(await startCard(w, p, 'p')).not.toMatchObject({ rule: 'platform.keptAcross' })
    } finally {
      service.setSlotStarts(null)
    }
  })

  it('HI-3070: a project that chose None with Git work still running counts in the drain of its repository’s switch to jj; its None work never does', async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    // Q, never switched: a Git card in flight and a slot lease, then None (its own switch: its card keeps Git's rules).
    expect(await startCard(w, q, 'q')).toMatchObject({ ok: true })
    await leaseOk(w, q)
    expect(await sw.setPlatform(w, q, 'none', { expected: 'git' })).toEqual({ from: 'git', to: 'none' })
    const check = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(check.refused).toEqual({ why: 'drain' })
    // Q isn't in the group (it stays None), but its Git work is in the drain.
    expect(check.store?.group.map((g) => g.name)).toEqual(['p'])
    expect(check.store?.drain.cards.map((c) => c.project)).toEqual(['q'])
    expect(check.store?.drain.slots.map((s) => s.project)).toEqual(['q'])
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'git', token: check.store!.token })).rejects.toThrow()
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['git', 'none'])
    // Q's Git work ended (its card put back, its lease ended), a card started under None in flight instead: the switch goes.
    const qwf = (await workflowFor(w, q))!
    const gitCard = qwf.store.cards().find((c) => qwf.state(c).started)!
    expect(await store.boardWrite(w, async () => qwf.putBack(`#${gitCard.id}`, 'user'))).toMatchObject({ ok: true })
    await endAll(w, q)
    expect(await startCard(w, q, 'q')).toMatchObject({ ok: true })
    const after = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(after.refused).toBeNull()
    expect(after.store?.drain.cards).toEqual([])
    expect(await sw.setPlatform(w, p, 'jj', { expected: 'git', token: after.store!.token })).toEqual({ from: 'git', to: 'jj' })
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['jj', 'none'])
  })

  it("HI-3070 (HR2's round 1): a None project's Git lane before its first card starts counts; a lane started under None doesn't", async () => {
    const { w, p, q } = await workspace({ p: 'git', q: 'git' })
    // Q, never switched: a Git lane whose one card is still Todo (its ruleset Git's), then None.
    const qCard = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'q' }, user))
    const gitLane = await lanes.startLane(w, { project: 'q', builder: 'b-q', reviewer: 'r-q', cards: [qCard.number], name: 'git lane', by: 'BQ (q)' })
    expect(await sw.setPlatform(w, q, 'none', { expected: 'git' })).toEqual({ from: 'git', to: 'none' })
    const qwf = (await workflowFor(w, q))!
    expect(qwf.state(qwf.store.card(qCard.number)).stage).toBe('todo')
    const check = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(check.refused).toEqual({ why: 'drain' })
    expect(check.store?.drain.lanes.map((l) => [l.project, l.name])).toEqual([['q', 'git lane']])
    expect(check.store?.drain.cards).toEqual([])
    await expect(sw.setPlatform(w, p, 'jj', { expected: 'git', token: check.store!.token })).rejects.toThrow()
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['git', 'none'])
    // The Git lane ended, a lane started under None (its ruleset None's): never in the drain, so the switch goes.
    await lanes.endLane(w, (gitLane as { lane: { id: string } }).lane.id, { abandoned: true })
    const noneCard = await inWorkspace(w, () => tasks.createTask({ title: 'None lane card', project: 'q' }, user))
    await lanes.startLane(w, { project: 'q', builder: 'b-q', reviewer: 'r-q', cards: [noneCard.number], name: 'none lane', by: 'BQ (q)' })
    const after = await sw.checkPlatformSwitch(w, p, 'jj')
    expect(after.store?.drain.lanes).toEqual([])
    expect(after.refused).toBeNull()
    expect(await sw.setPlatform(w, p, 'jj', { expected: 'git', token: after.store!.token })).toEqual({ from: 'git', to: 'jj' })
  })

  it('HI-3071: a refresh that can’t read the repository (its .git moved away a moment) keeps every member; one read on another repository leaves', async () => {
    const { w, p, q } = await members(false)
    const memberRow = async (dir: string): Promise<string | null> => {
      const id = await idOf(w, dir)
      return store.boardRead(w, (db) => metaOf(db).get(MEMBER_KEY(id)) ?? null)
    }
    await leaseOk(w, q, 'jj')
    expect((await sw.checkPlatformSwitch(w, q, 'none')).refused).toEqual({ why: 'memberDrain' })
    const ws = join(p, '..')
    const [rowP, rowQ] = [await memberRow(p), await memberRow(q)]
    expect(rowP && rowQ).toBeTruthy()
    // The repository unreadable at one look at the stores, then back.
    renameSync(join(ws, '.git'), join(ws, 'git-away'))
    await ss.mapStores(w)
    expect([await memberRow(p), await memberRow(q)]).toEqual([rowP, rowQ])
    renameSync(join(ws, 'git-away'), join(ws, '.git'))
    await ss.mapStores(w)
    expect([await memberRow(p), await memberRow(q)]).toEqual([rowP, rowQ])
    // Still drained as members: Q's jj lease keeps Q's switch to None and P's switch back to Git refused.
    expect((await sw.checkPlatformSwitch(w, q, 'none')).refused).toEqual({ why: 'memberDrain' })
    const back = await sw.checkPlatformSwitch(w, p, 'git')
    expect(back.refused).toEqual({ why: 'drain' })
    expect(back.store?.drain.slots.map((s) => s.project)).toEqual(['q'])
    // Control: Q read on a repository of its own (another store) does leave the fence.
    git(q, 'init', '-q', '-b', 'main')
    await ss.mapStores(w)
    expect(await memberRow(q)).toBeNull()
    expect(await memberRow(p)).toEqual(rowP)
  })

  it.each([
    ['reads as no repository (Mercurial found in it)', (q: string) => mkdirSync(join(q, '.hg'))],
    ["can't be read (a .git file naming nothing)", (q: string) => writeFileSync(join(q, '.git'), 'gitdir: ./nowhere\n')]
  ] as const)("HI-3071 (HR1's round 1): while only Q %s, P's switch back to Git still waits for Q's jj work", async (_what, hide) => {
    const { w, p, q } = await members(false)
    await leaseOk(w, q, 'jj')
    hide(q)
    await ss.mapStores(w)
    const back = await sw.checkPlatformSwitch(w, p, 'git')
    expect(back.refused).toEqual({ why: 'drain' })
    expect(back.store?.drain.slots.map((s) => s.project)).toEqual(['q'])
    await expect(sw.setPlatform(w, p, 'git', { expected: 'jj', token: back.store!.token })).rejects.toThrow()
    expect(await platformIn(w, p)).toBe('jj')
    rmSync(join(q, '.hg'), { recursive: true, force: true })
    rmSync(join(q, '.git'), { force: true })
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

  it('a fence unreadable, gone, or not listing the member: refused, never an unfenced switch; nothing changed (HR2 round 1)', async () => {
    const corrupt: [string, (raw: string | null) => string | null][] = [
      ['malformed', () => '{not json'],
      ['gone', () => null],
      ['without the member', (raw) => {
        const f = JSON.parse(raw!) as { members: Record<string, unknown> }
        for (const id of Object.keys(f.members)) if (id.startsWith('p')) delete f.members[id]
        return JSON.stringify(f)
      }]
    ]
    for (const [name, change] of corrupt) {
      const { w, p } = await members(true)
      const storeId = storeKey(await commonGitDir(p))
      const before = await w.projectConfig(p)
      await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => metaOf(db).set(FENCE_KEY(storeId), change(metaOf(db).get(FENCE_KEY(storeId))))))
      expect((await sw.checkPlatformSwitch(w, p, 'none')).refused, name).toEqual({ why: 'switching' })
      await expect(sw.setPlatform(w, p, 'none', { expected: 'git' }), name).rejects.toThrow(/being switched/)
      expect(await w.projectConfig(p), name).toEqual(before)
    }
  })

  it('authority revoked while it drains: refused at the write, nothing written, the fence settled back and admissions restored (HR2 round 1)', async () => {
    const { w, p, q } = await members(true)
    let revoked = false
    let guarded = 0
    ss.storeSwitchSeams.at = (pt) => {
      if (pt === 'afterDrain') revoked = true
    }
    const guard = () => {
      guarded++
      if (revoked) throw new Error('Control was revoked')
    }
    await expect(sw.setPlatform(w, p, 'none', { expected: 'git', guard })).rejects.toThrow(/Control was revoked/)
    ss.storeSwitchSeams.at = undefined
    expect(guarded).toBe(2)
    expect([await platformIn(w, p), await platformIn(w, q)]).toEqual(['git', 'git'])
    expect(await fenceOf(w, p)).toMatchObject({ state: 'settled', members: { [await idOf(w, p)]: { current: { platform: 'git' } }, [await idOf(w, q)]: { current: { platform: 'git' } } } })
    await leaseOk(w, p)
    await copyOk(w, p)
    expect(await startCard(w, p, 'p')).not.toMatchObject({ rule: 'platform.switching' })
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

/**
 * A workspace with `app`, a Git repository with a `.jj` beside its `.git` (an empty one: jj can't read it, so the real
 * fallback check finds its heads unreadable), and `hot`, a `git worktree` of it the user made, as a project (HI-3034).
 * `platform`: both projects' recorded choice; `appOutside`: app lives outside the workspace, so only hot is a project.
 */
async function worktreeWorkspace(platform: 'git' | 'jj', o: { appOutside?: boolean } = {}): Promise<{ w: WS; app: string; hot: string }> {
  const ws = join(base, `wt-${++n}`)
  const app = o.appOutside ? join(base, `wt-${n}-app`) : join(ws, 'app')
  const hot = join(ws, 'hot')
  for (const d of [app, ws]) mkdirSync(join(d, '.combwork'), { recursive: true })
  writeFileSync(join(app, 'a.txt'), 'a\n')
  git(app, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(app, 'config', k, v)
  writeFileSync(join(app, '.gitignore'), '.combwork/\n.jj/\n')
  git(app, 'add', '-A')
  git(app, 'commit', '-qm', 'initial')
  mkdirSync(join(app, '.jj'))
  git(app, 'worktree', 'add', '-q', '-b', 'hotfix', hot)
  mkdirSync(join(hot, '.combwork'), { recursive: true })
  for (const [dir, id] of [[app, 'app'], [hot, 'hot']] as const) writeFileSync(join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, id, platform, agents: [{ id: `b-${id}`, name: `B${id}`, role: 'builder' }, { id: `r-${id}`, name: `R${id}`, role: 'reviewer' }], workflow: { platform, preset: 'pair', options: {} } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, app, hot }
}

describe('a git worktree project of a colocated jj repository (HI-3034)', () => {
  it('to jj: refused naming the worktree project, whose folder is no jj workspace; nothing changed. Once it is None, the rest switch', async () => {
    const { w, app, hot } = await worktreeWorkspace('git')
    const check = await sw.checkPlatformSwitch(w, app, 'jj')
    expect(check.store?.group.map((g) => g.name).sort()).toEqual(['app', 'hot'])
    expect(check.refused).toEqual({ why: 'memberNoJj', project: 'hot' })
    await expect(sw.setPlatform(w, app, 'jj', { expected: 'git', token: check.store!.token })).rejects.toThrow(/hot is on this repository, but its folder isn’t a jj workspace/)
    expect([await platformIn(w, app), await platformIn(w, hot)]).toEqual(['git', 'git'])
    // Its own way out, as the refusal says: None for the worktree project, which then takes no part.
    await sw.setPlatform(w, hot, 'none', { expected: 'git' })
    const again = await sw.checkPlatformSwitch(w, app, 'jj')
    expect(again.refused).toBeNull()
    await sw.setPlatform(w, app, 'jj', { expected: 'git', token: again.store!.token })
    expect([await platformIn(w, app), await platformIn(w, hot)]).toEqual(['jj', 'none'])
  })

  it('HI-3072: the worktree project, None while the repository runs jj, is refused going back to Git, saying why; once the repository is back on Git, it goes', async () => {
    const { w, app, hot } = await worktreeWorkspace('git')
    await sw.setPlatform(w, hot, 'none', { expected: 'git' })
    await sw.setPlatform(w, app, 'jj', { expected: 'git', token: (await sw.checkPlatformSwitch(w, app, 'jj')).store!.token })
    const back = await sw.checkPlatformSwitch(w, hot, 'git')
    expect(back.refused).toEqual({ why: 'storeRuns', platform: 'jj' })
    await expect(sw.setPlatform(w, hot, 'git', { expected: 'none' })).rejects.toThrow(/This repository uses jj now \(its other projects switched it\), so this project can’t use Git on it/)
    expect([await platformIn(w, app), await platformIn(w, hot)]).toEqual(['jj', 'none'])
    // The repository switched back to Git (from app): hot's own switch to Git goes, and its cards start under Git.
    await sw.setPlatform(w, app, 'git', { expected: 'jj', token: (await sw.checkPlatformSwitch(w, app, 'git')).store!.token })
    expect((await sw.checkPlatformSwitch(w, hot, 'git')).refused).toBeNull()
    expect(await sw.setPlatform(w, hot, 'git', { expected: 'none' })).toEqual({ from: 'none', to: 'git' })
  })

  it('back to Git asked from the worktree project checks the repository’s jj (app’s .jj), as asked from app: refused the same', async () => {
    const { w, app, hot } = await worktreeWorkspace('jj')
    const seams = ss.storeSwitchSeams.repo
    const asked: string[] = []
    ss.storeSwitchSeams.repo = { ...seams, fallback: async (path) => (asked.push(path), ss.fallbackOf(path)) }
    try {
      const fromApp = await sw.checkPlatformSwitch(w, app, 'git')
      const fromHot = await sw.checkPlatformSwitch(w, hot, 'git')
      expect(asked).toEqual([app, app])
      expect(fromApp.refused).toEqual({ why: 'fallback' })
      expect(fromHot.refused).toEqual({ why: 'fallback' })
      expect(fromHot.store?.fallback).toEqual(fromApp.store?.fallback)
      expect(fromHot.store?.fallback?.[0]).toMatchObject({ code: 'heads' })
      await expect(sw.setPlatform(w, hot, 'git', { expected: 'jj', token: fromHot.store!.token })).rejects.toThrow(/isn’t ready to go back to Git/)
    } finally {
      ss.storeSwitchSeams.repo = seams
    }
    expect([await platformIn(w, app), await platformIn(w, hot)]).toEqual(['jj', 'jj'])
  })

  it('back to Git from the worktree project alone (app not a project): the jj beside the repository’s .git is checked', async () => {
    const { w, app, hot } = await worktreeWorkspace('jj', { appOutside: true })
    const seams = ss.storeSwitchSeams.repo
    const asked: string[] = []
    ss.storeSwitchSeams.repo = { ...seams, fallback: async (path) => (asked.push(path), ss.fallbackOf(path)) }
    try {
      const fromHot = await sw.checkPlatformSwitch(w, hot, 'git')
      expect(fromHot.store?.group.map((g) => g.name)).toEqual(['hot'])
      expect(asked.map((a) => realpathSync(a))).toEqual([realpathSync(app)])
      expect(fromHot.refused).toEqual({ why: 'fallback' })
      // Its .jj gone (HI-2975): nothing left to check, so back to Git goes through.
      rmSync(join(app, '.jj'), { recursive: true })
      const gone = await sw.checkPlatformSwitch(w, hot, 'git')
      expect(gone.refused).toBeNull()
      await sw.setPlatform(w, hot, 'git', { expected: 'jj', token: gone.store!.token })
    } finally {
      ss.storeSwitchSeams.repo = seams
    }
    expect(await platformIn(w, hot)).toBe('git')
  })
})
