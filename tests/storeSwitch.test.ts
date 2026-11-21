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
const sw = await import('../src/main/workflow/platformSwitch')
const ss = await import('../src/main/workflow/storeSwitch')
const { workflowFor } = await import('../src/main/workflow/service')
const { SlotStore } = await import('../src/main/slots')
const { CopyStore } = await import('../src/main/copies')
const { boardConn } = await import('../src/main/slotsApp')
const { metaOf } = await import('../src/main/platform/fenceAdmit')
const { beginSwitch, MEMBER_KEY, readFence, storeKey } = await import('../src/main/platform/platformFence')
const { commonGitDir } = await import('../src/main/repoLock')
const { agentActor } = await import('../src/shared/workflow/facts')
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
const fenceOf = async (w: WS, dir: string) => { const id = await idOf(w, dir); return store.boardRead(w, (db) => {
  const m = metaOf(db).get(MEMBER_KEY(id))
  return m ? readFence(metaOf(db), (JSON.parse(m) as { store: string }).store) : null
}) }

describe('a switch between Git and jj is the repository’s (HI-2799)', () => {
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

    it('a no-code card, and a slots start waiting for a slot: never refused for the project folder’s head, but the user’s start across the wait is (HI-3141)', async () => {
      const { w, p } = await workspace({ p: 'git', q: 'git' })
      git(wsOf(p), 'checkout', '-q', '--detach')
      const noCode = await inWorkspace(w, () => tasks.createTask({ title: 'Look only', project: 'p', kind: 'no-code' }, user))
      const wf = (await workflowFor(w, p))!
      expect(await store.boardWrite(w, async () => wf.start(`#${noCode.number}`, agentActor('b-p')))).not.toMatchObject({ rule: 'platform.detachedFolder' })
      await w.mutateProjectConfig(p, (c) => ({ workflow: { ...c.workflow!, options: { ...c.workflow!.options, folder: 'slots' } } }), { existing: true })
      const service = await import('../src/main/workflow/service')
      service.setSlotStarts({ leaseFor: async () => ({ wait: 'every slot is in use' }), unused: async () => undefined })
      try {
        // HI-3141: an agent's start waits for a slot, said as that whatever the project folder's head (the provisional
        // plan takes the slots path's target, as the evidence read it), never evidence.changed nor the detached refusal.
        const busy = await startCard(w, p, 'p')
        expect(busy).toMatchObject({ refused: true, rule: 'start.slotAvailable' })
        // The user's start, and across the wait (built where the agent is): the folder on no branch refuses it as any
        // build there is (HI-3104's), never a card started on no branch.
        const card = await inWorkspace(w, () => tasks.createTask({ title: 'Started by the user', project: 'p' }, user))
        const fresh = (await workflowFor(w, p))!
        expect(await store.boardWrite(w, async () => fresh.start(`#${card.number}`, 'user'))).toMatchObject({ refused: true, rule: 'platform.detachedFolder' })
        const across = await store.boardWrite(w, async () => fresh.start(`#${card.number}`, 'user', { drag: { by: 'user', reason: 'start it anyway', ask: false } }))
        expect(across).toMatchObject({ refused: true, rule: 'platform.detachedFolder' })
        expect(JSON.stringify(across)).toContain('Check out its branch in the project folder (git switch main)')
        expect(fresh.state(fresh.store.card(card.number)).started).toBeFalsy()
        git(wsOf(p), 'checkout', '-q', 'main')
        expect(await startCard(w, p, 'p')).toMatchObject({ refused: true, rule: 'start.slotAvailable' })
        // On its branch, the user's start across the wait goes through, in the project folder, merging into main.
        const ok = await store.boardWrite(w, async () => fresh.start(`#${card.number}`, 'user', { drag: { by: 'user', reason: 'start it anyway', ask: false } }))
        expect(ok).not.toMatchObject({ refused: true })
        expect(fresh.state(fresh.store.card(card.number)).started).toMatchObject({ folder: 'project', line: 'main', target: 'main' })
      } finally {
        service.setSlotStarts(null)
      }
    })
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

  it("HI-3105 (HR2's round 2): pressing Switch: a refusal re-checked clear gives a fresh look, never a second switch; any other failure stays the error", async () => {
    const { switchAtConfirm } = await import('../src/shared/platform/switching')
    const shown = { group: [], token: 't', drain: { lanes: [], cards: [], queue: [], slots: [], copies: [], kept: [] } }
    const flow = (switchIt: () => Promise<never>, rechecks: unknown[]) => {
      const calls = { switch: 0, recheck: 0 }
      const run = switchAtConfirm({
        switchIt: async () => (calls.switch++, switchIt()),
        recheck: async () => rechecks[calls.recheck++] as never
      })
      return { run, calls }
    }
    // A passing race: refused (fallback), the check read again is clear: a fresh look, the switch made once only.
    const race = flow(async () => ({ refused: { why: 'fallback' } }) as never, [{ refused: null, store: shown }])
    expect(await race.run).toBe('reread')
    expect(race.calls).toEqual({ switch: 1, recheck: 1 })
    // An unrelated failure (a save denied): the error itself, the check not read again, whatever it would say.
    const denied = flow(async () => {
      throw new Error('EACCES: permission denied saving project.json')
    }, [{ refused: null, store: shown }])
    await expect(denied.run).rejects.toThrow('EACCES: permission denied saving project.json')
    expect(denied.calls).toEqual({ switch: 1, recheck: 0 })
    // A refusal whose re-check can't be read: the refusal stays the dialog's error.
    const unread = flow(async () => ({ refused: { why: 'drain' } }) as never, [null])
    expect(await unread.run).toEqual({ refused: { why: 'drain' } })
    // Switched: nothing more.
    const ok = flow(async () => ({ switched: { from: 'jj', to: 'git' } }) as never, [])
    expect(await ok.run).toBe('switched')
    expect(ok.calls).toEqual({ switch: 1, recheck: 0 })
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
