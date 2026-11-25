// A Git project's folder and its switch to None, on a real workspace (one Git repository, projects p and q inside it):
// HI-3104, a start in a project folder on no branch; and #1419, a switch to None with work running, which keeps its
// leases (its old rules).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-gitfolder-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const sw = await import('../src/main/workflow/platformSwitch')
const { workflowFor } = await import('../src/main/workflow/service')
const { SlotStore } = await import('../src/main/slots')
const { CopyStore } = await import('../src/main/copies')
const { boardConn } = await import('../src/main/slotsApp')
const { agentActor } = await import('../src/shared/workflow/facts')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
const user = { kind: 'user' } as const

/** A workspace that is one Git repository, its projects p and q inside it. */
async function workspace(platforms: { p: 'git' | 'none'; q: 'git' | 'none' }): Promise<{ w: WS; p: string; q: string }> {
  const ws = join(base, `ws-${++n}`)
  const p = join(ws, 'p')
  const q = join(ws, 'q')
  for (const d of [p, q, ws]) mkdirSync(join(d, '.combwork'), { recursive: true })
  writeFileSync(join(p, 'a.txt'), 'a\n')
  writeFileSync(join(q, 'b.txt'), 'b\n')
  git(ws, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(ws, 'config', k, v)
  writeFileSync(join(ws, '.gitignore'), '.combwork/\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '-qm', 'initial')
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

describe('a switch to None (#1419)', () => {
  let k = 0
  const lease = async (w: WS, dir: string) => new SlotStore(boardConn(w), await idOf(w, dir)).take({ agent: `b-m${++k}`, card: 800 + k }, { size: 4, root: join(base, `mslots-${k}`), target: 'main', token: `tm-${k}`, holder: { pid: process.pid, started: 1 } })
  const copy = async (w: WS, dir: string) => new CopyStore(boardConn(w), await idOf(w, dir)).take({ kind: 'review', card: 800 + ++k, revision: 'abc' }, { size: 4, dir: join(base, `mcopies-${k}`), token: `cm-${k}`, holder: { pid: process.pid, started: 1 }, profile: 'test' })
  const leaseOk = async (w: WS, dir: string) => expect((await lease(w, dir)).ok).toBe(true)
  const copyOk = async (w: WS, dir: string) => expect((await copy(w, dir)).ok).toBe(true)
  it('goes to None with its work running, which keeps its leases (its old rules)', async () => {
    const { w, p } = await workspace({ p: 'git', q: 'git' })
    await leaseOk(w, p)
    const check = await sw.checkPlatformSwitch(w, p, 'none')
    expect(check.refused).toBeNull()
    await sw.setPlatform(w, p, 'none', { expected: 'git' })
    expect(await platformIn(w, p)).toBe('none')
    await leaseOk(w, p)
    await copyOk(w, p)
  })
})
