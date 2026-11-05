// Projects' stable ids (#508): a project renamed or moved keeps its cards, lanes and watches, which name it by an id kept
// in its own project.json. The pure rules (which copy keeps an id, whose cards are left under an old name), then a
// workspace: ids given once, cards stamped once, a rename followed, a copied folder given a new id, and Repair giving
// cards saved before ids (under a project's old name) to the project they belong to now.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { goneProject, isProjectId, orphanNames, projectNow, savedProjectName, settleProjectIds } from '../src/shared/projectIds'
import { moveFolder } from './moveFolder'
import { tempDir } from './tempDir'
import { readCardIn, writeCardOutside } from './boardDb'
import { storeDocs } from './storeDocs'

const base = tempDir('cw-projectids-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { configTestHooks, createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const { movePlan, repairMove } = await import('../src/main/workspaceMove')
const { atomicTestHooks } = await import('../src/main/fsutil')

vi.setConfig({ testTimeout: 30_000 })
/** Bounds a wait for Combwork's folder watcher: only a hung watcher takes this long. */
const HUNG_MS = 15_000

const user = { kind: 'user' } as const
const readCard = (ws: string, n: number): Record<string, unknown> => readCardIn(ws, n)
const projectJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8'))
/** The ids read again now (the workspace reuses what it read for a second), so a folder renamed just now is seen. */
const reread = async (w: { projectIds: (o: { fresh: true }) => Promise<unknown> }): Promise<void> => void (await w.projectIds({ fresh: true }))

function project(ws: string, name: string, extra: Record<string, unknown> = {}, sessions: { agentId: string }[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...extra }))
  writeFileSync(join(p, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: sessions.map((s, i) => ({ id: `s${i}`, provider: 'claude-code', createdAt: '2026-10-01T00:00:00.000Z', ...s })) }))
  return p
}

describe('settleProjectIds', () => {
  it('keeps each id, and gives one to projects without', () => {
    const { keep, fresh } = settleProjectIds([{ path: 'D:\\ws\\a', id: 'p-0123456789ab' }, { path: 'D:\\ws\\b' }, { path: 'D:\\ws\\c', id: 'not an id' }])
    expect([...keep]).toEqual([['d:\\ws\\a', 'p-0123456789ab']])
    expect(fresh).toEqual(['D:\\ws\\b', 'D:\\ws\\c'])
  })

  it('of folders sharing an id (a copy), the one still where it was opened keeps it', () => {
    const id = 'p-0123456789ab'
    const r = settleProjectIds([{ path: 'D:\\ws\\a-copy', id, lastPath: 'D:\\ws\\a' }, { path: 'D:\\ws\\a', id, lastPath: 'D:\\ws\\a' }])
    expect(r.keep.get('d:\\ws\\a')).toBe(id)
    expect(r.fresh).toEqual(['D:\\ws\\a-copy'])
  })

  it('a workspace copied whole: the folder with the old name keeps it, else the first by path', () => {
    const id = 'p-0123456789ab'
    expect(settleProjectIds([{ path: 'E:\\ws\\b', id, lastPath: 'D:\\ws\\a' }, { path: 'E:\\ws\\a', id, lastPath: 'D:\\ws\\a' }]).keep.get('e:\\ws\\a')).toBe(id)
    expect(settleProjectIds([{ path: 'E:\\ws\\c', id }, { path: 'E:\\ws\\b', id }]).keep.get('e:\\ws\\b')).toBe(id)
  })
})

describe('orphanNames', () => {
  const r = (name: string, ...agents: string[]) => ({ name, agents })
  const projects = [
    { name: 'website', agents: new Set(['a-claude', 'a-wb1']) },
    { name: 'acme', agents: new Set(['a-hb1']) }
  ]

  it("gives a name's records to the one project whose agents worked on them, the agentless ones too", () => {
    expect(orphanNames([r('acme-website', 'a-claude'), r('acme-website'), r('acme', 'a-hb1'), r('')], ['website', 'acme'], projects)).toEqual([{ from: 'acme-website', to: 'website' }])
  })

  it("leaves a name alone when its records' agents are no project's, or more than one's", () => {
    expect(orphanNames([r('gone', 'a-nobody'), r('gone')], ['website', 'acme'], projects)).toEqual([])
    expect(orphanNames([r('mixed', 'a-claude'), r('mixed', 'a-hb1')], ['website', 'acme'], projects)).toEqual([])
  })

  it('a project Repair is moving from that name takes them, whatever their agents', () => {
    expect(orphanNames([r('old', 'a-hb1')], ['website', 'acme'], projects, [{ from: 'OLD', to: 'website' }])).toEqual([{ from: 'old', to: 'website' }])
  })

  it("never takes a name that is the workspace's (a hidden or removed project's), nor one shown as gone", () => {
    expect(orphanNames([r('Parked', 'a-claude')], ['website', 'acme', 'parked'], projects)).toEqual([])
    expect(orphanNames([r(goneProject('site'), 'a-claude')], ['website', 'acme'], projects)).toEqual([])
  })
})

describe('projectNow', () => {
  const index = (entries: [string, string][]) => ({ byPath: new Map(entries.map(([id, p]) => [p.toLowerCase(), id])), byId: new Map(entries) })
  const A = 'p-aaaaaaaaaaaa'
  const B = 'p-bbbbbbbbbbbb'

  it("a saved id decides whose a record is: renamed, its project's name now, whatever the saved name names", () => {
    expect(projectNow(index([[A, 'D:\\ws\\gamma']]), 'alpha', A)).toBe('gamma')
    // A new alpha was made after alpha was renamed to gamma: the record is still gamma's.
    expect(projectNow(index([[A, 'D:\\ws\\gamma'], [B, 'D:\\ws\\alpha']]), 'alpha', A)).toBe('gamma')
    // Two projects swapped names.
    expect(projectNow(index([[A, 'D:\\ws\\beta'], [B, 'D:\\ws\\alpha']]), 'alpha', A)).toBe('beta')
  })

  it('an id no project has keeps the saved name, shown as gone (never a folder name) while another project has it', () => {
    expect(projectNow(index([[B, 'D:\\ws\\other']]), 'alpha', A)).toBe('alpha')
    const shown = projectNow(index([[B, 'D:\\ws\\alpha']]), 'alpha', A)
    expect(shown).toBe('alpha: gone')
    expect(savedProjectName(shown)).toBe('alpha')
    // Read again as it shows (a save keeps the saved name, so this is what the next read gets): the same.
    expect(projectNow(index([[B, 'D:\\ws\\alpha']]), savedProjectName(shown), A)).toBe(shown)
  })

  it('a record saved before ids has its name only', () => {
    expect(projectNow(index([[A, 'D:\\ws\\gamma']]), 'alpha', undefined)).toBe('alpha')
    expect(projectNow(index([[A, 'D:\\ws\\alpha']]), 'alpha', 'not-an-id')).toBe('alpha')
  })
})

describe('a workspace', () => {
  const wsPath = join(base, 'ws')
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

  beforeAll(async () => {
    project(wsPath, 'alpha', { agents: [{ id: 'a1', name: 'A1', provider: 'claude-code' }, { id: 'r1', name: 'R1', provider: 'claude-code' }] })
    project(wsPath, 'beta')
    // Renamed from old-site while Combwork was closed, before projects had ids (as acme-website → website): its agent
    // Claude was removed since, but its sessions are still the project's.
    project(wsPath, 'site', {}, [{ agentId: 'a-claude' }])
    // A card saved before ids, by a project of the workspace: it gets the id when the workspace opens.
    mkdirSync(join(wsPath, '.combwork', 'tasks'), { recursive: true })
    const old = (n: number, name: string, agent: string | null, archived = false): void =>
      writeFileSync(join(wsPath, '.combwork', 'tasks', `${n}.json`), JSON.stringify({ number: n, title: `Old ${n}`, description: '', project: name, agent, ...(agent ? { agentName: 'Claude' } : {}), column: 'done', order: n, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z' }))
    old(1, 'beta', null)
    old(2, 'old-site', 'a-claude', true)
    old(3, 'old-site', null, true)
    old(4, 'old-site', 'a-claude')
    writeFileSync(join(wsPath, '.combwork', 'tasks', 'board.json'), JSON.stringify({ version: 1, next: 5 }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))

  it('gives every project an id once, kept in its project.json', async () => {
    const ids = await w.projectIds()
    const alpha = projectJson(join(wsPath, 'alpha')).id
    expect(isProjectId(alpha)).toBe(true)
    expect(ids.byPath.get(join(wsPath, 'alpha').toLowerCase())).toBe(alpha)
    expect(new Set([...ids.byId.keys()]).size).toBe(3)
    // Read again: the same ids, nothing written.
    const before = readFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), 'utf8')
    expect((await w.projectIds({ fresh: true })).byId.get(alpha as string)).toBe(join(wsPath, 'alpha'))
    expect(readFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), 'utf8')).toBe(before)
  })

  it("stamps the cards with their project's id once; one under a name no project has is left as it was", async () => {
    // As each opening does (ipc.ts); the second time changes nothing.
    expect(await tasks.stampCardProjects(w)).toBe(1)
    expect(await tasks.stampCardProjects(w)).toBe(0)
    expect(readCard(wsPath, 1).projectId).toBe(projectJson(join(wsPath, 'beta')).id)
    expect(readCard(wsPath, 2).projectId).toBeUndefined()
    // A new card gets it too, right after its name.
    const c = await run(() => tasks.createTask({ title: 'New', project: 'alpha', agent: 'A1' }, user))
    const file = readCard(wsPath, c.number)
    expect(Object.keys(file).slice(0, 5)).toEqual(['number', 'title', 'description', 'project', 'projectId'])
    expect(file.projectId).toBe(projectJson(join(wsPath, 'alpha')).id)
    // Not part of the card as Combwork shows it (the Agent API, the board).
    expect('projectId' in c).toBe(false)
    expect('projectId' in (await run(() => tasks.getTask(c.number)))).toBe(false)
  })

  it('a project renamed keeps its cards and lanes, with their agents, archived ones too', async () => {
    const live = await run(() => tasks.createTask({ title: 'Live', project: 'alpha', agent: 'A1', column: 'doing' }, user))
    const archived = await run(() => tasks.createTask({ title: 'Archived', project: 'alpha' }, user))
    await run(() => tasks.archiveTask(archived.number, true))
    await lanes.startLane(w, { project: 'alpha', builder: 'a1', reviewer: 'r1', cards: [live.number], by: 'A1 (alpha)' })
    const id = projectJson(join(wsPath, 'alpha')).id
    await moveFolder(join(wsPath, 'alpha'), join(wsPath, 'gamma'))
    await reread(w)
    // Read back by the id: the new name at once, before anything is rewritten.
    expect((await run(() => tasks.getTask(live.number))).project).toBe('gamma')
    const all = await run(() => tasks.allTasks())
    expect(all.filter((c) => c.project === 'alpha')).toEqual([])
    expect(all.find((c) => c.number === archived.number)).toMatchObject({ project: 'gamma', archived: true })
    expect((await lanes.listLanes(w, { project: 'gamma' })).map((l) => l.builder.name)).toEqual(['A1'])
    expect(await lanes.laneOf(w, 'gamma', 'a1')).not.toBeNull()
    // The files catch up (each workspace opening does this), once.
    expect(await tasks.stampCardProjects(w)).toBeGreaterThanOrEqual(3)
    expect(readCard(wsPath, live.number)).toMatchObject({ project: 'gamma', projectId: id })
    expect(await tasks.stampCardProjects(w)).toBe(0)
    // Its agent is found in the project under its new name.
    const changed = await run(() => tasks.updateTask(live.number, { agent: 'R1' }, user))
    expect(changed).toMatchObject({ project: 'gamma', agent: 'r1' })
    expect(storeDocs<{ projectId: string }>(wsPath, 'lanes')[0].projectId).toBe(id)
  })

  it('a copy of a project folder gets an id of its own: the cards stay with the original', async () => {
    const id = projectJson(join(wsPath, 'beta')).id
    // beta was opened where it is (its lastPath), so the copy is the one that changes.
    cpSync(join(wsPath, 'beta'), join(wsPath, 'beta-copy'), { recursive: true })
    await reread(w)
    const copyId = projectJson(join(wsPath, 'beta-copy')).id
    expect(isProjectId(copyId)).toBe(true)
    expect(copyId).not.toBe(id)
    expect(projectJson(join(wsPath, 'beta')).id).toBe(id)
    expect((await run(() => tasks.getTask(1))).project).toBe('beta')
  })

  it("Repair gives cards saved under a project's old name to the project whose agents worked on them, once", async () => {
    const plan = await movePlan(w)
    expect(plan?.cards).toEqual([{ from: 'old-site', to: 'site', cards: [2, 3, 4] }])
    const report = await repairMove(w)
    expect(report.failed).toEqual([])
    expect(report.done).toContain('3 cards of old-site now belong to site, with their agents.')
    const card = await run(() => tasks.getTask(2))
    expect(card).toMatchObject({ project: 'site', archived: true, agent: 'a-claude' })
    expect(card.history.at(-1)).toMatchObject({ by: 'Repair', what: 'Project: old-site → site (renamed or moved)' })
    // Nobody edited it: its date (an archived card's, as Archived shows it) stays.
    expect(card.updatedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(readCard(wsPath, 2).projectId).toBe(projectJson(join(wsPath, 'site')).id)
    // Nothing left: no banner, and Repair again repeats nothing.
    expect(await movePlan(w)).toBeNull()
    expect((await repairMove(w)).done).toEqual([])
  })

  it('Repair of a project renamed before ids takes the cards of its old name, and keeps it Working on', async () => {
    // delta was "old-delta" when it was last opened: its cards and Working on still say so.
    const delta = project(wsPath, 'delta', { lastPath: join(wsPath, 'old-delta'), id: 'p-00000000000d' })
    writeCardOutside(wsPath, 90, ({ number: 90, title: 'Delta', description: '', project: 'old-delta', agent: null, column: 'todo', order: 90, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z' }))
    const { config } = await import('../src/main/config')
    config.update((c) => {
      c.activeProjects[wsPath] = ['old-delta', 'beta']
    })
    await reread(w)
    const plan = await movePlan(w)
    expect(plan?.projects).toEqual(['delta'])
    expect(plan?.cards).toEqual([{ from: 'old-delta', to: 'delta', cards: [90] }])
    const report = await repairMove(w)
    expect(report.failed).toEqual([])
    expect((await run(() => tasks.getTask(90))).project).toBe('delta')
    expect(readCard(wsPath, 90).projectId).toBe('p-00000000000d')
    expect(config.get().activeProjects[wsPath]).toEqual(['delta', 'beta'])
    expect(projectJson(delta).lastPath).toBe(delta)
    expect(await movePlan(w)).toBeNull()
  })
})

describe('a saved id decides; nothing is lost on the way (#508 round 2)', () => {
  const wsPath = join(base, 'ws2')
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const tasksDir = join(wsPath, '.combwork', 'tasks')
  const legacy = (n: number, name: string, extra: Record<string, unknown> = {}): void =>
    writeFileSync(join(tasksDir, `${n}.json`), JSON.stringify({ number: n, title: `Legacy ${n}`, description: '', project: name, agent: null, column: 'todo', order: n, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'You', updatedAt: '2026-10-01T00:00:00.000Z', ...extra }))
  const alphaAgent = { kind: 'agent', name: 'X (alpha)', scope: 'alpha', self: { project: 'alpha', agentId: 'x1' } } as const

  beforeAll(async () => {
    project(wsPath, 'alpha', { agents: [{ id: 'a1', name: 'A1', provider: 'claude-code' }] })
    project(wsPath, 'beta', { agents: [{ id: 'b1', name: 'B1', provider: 'claude-code' }] })
    project(wsPath, 'site', {}, [{ agentId: 'a-old' }])
    // Each test that renames a folder has its own (#579), so one that fails leaves the next ones theirs.
    project(wsPath, 'kappa')
    project(wsPath, 'rho')
    mkdirSync(tasksDir, { recursive: true })
    legacy(1, 'alpha', { custom: { kept: true } })
    legacy(2, 'beta')
    // Saved before ids under a project renamed since (site was old-site), with a field this Combwork doesn't know.
    legacy(3, 'old-site', { agent: 'a-old', agentName: 'Old', custom: 'mine' })
    writeFileSync(join(tasksDir, 'board.json'), JSON.stringify({ version: 1, next: 4 }))
    // A lane saved before ids, and one under old-site.
    const lane = (id: string, name: string, builder: string) => ({ id, project: name, name: null, builder: { id: builder, name: builder }, reviewer: null, cards: [1], rounds: 5, waitMinutes: 120, state: 'active', startedBy: 'x', startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z', endedAt: null, mergeCommit: null })
    writeFileSync(join(wsPath, '.combwork', 'lanes.json'), JSON.stringify({ version: 1, lanes: [lane('lane-a', 'alpha', 'a1'), lane('lane-o', 'old-site', 'a-old')] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))

  it('stamping gives each card its id once, every field kept; the files as they were are kept in the import backup (#1017)', async () => {
    expect(await tasks.stampCardProjects(w)).toBe(2)
    // The cards' files as they were before the move, kept as they were.
    const kept = readdirSync(join(wsPath, '.combwork')).find((f) => f.startsWith('tasks.imported-'))!
    const before1 = JSON.parse(readFileSync(join(wsPath, '.combwork', kept, '1.json'), 'utf8'))
    expect(before1).toMatchObject({ project: 'alpha', custom: { kept: true } })
    expect(readCard(wsPath, 1)).toEqual({ ...before1, projectId: projectJson(join(wsPath, 'alpha')).id })
    expect(readCard(wsPath, 2).projectId).toBe(projectJson(join(wsPath, 'beta')).id)
    // Saved under a name no project has, it is Repair's: not stamped.
    expect(readCard(wsPath, 3).projectId).toBeUndefined()
    // Again: nothing changes.
    expect(await tasks.stampCardProjects(w)).toBe(0)
  })

  it('lanes saved before ids get their project’s id when stamped, once; lanes.json kept as it was in the import backup (#1018)', async () => {
    const before = readFileSync(join(wsPath, '.combwork', 'lanes.json'), 'utf8')
    expect(await lanes.stampLaneProjects(w)).toBe(1)
    const saved = storeDocs<{ id: string; projectId?: string }>(wsPath, 'lanes')
    expect(saved.find((l) => l.id === 'lane-a')?.projectId).toBe(projectJson(join(wsPath, 'alpha')).id)
    expect(saved.find((l) => l.id === 'lane-o')?.projectId).toBeUndefined()
    const backup = readdirSync(join(wsPath, '.combwork')).find((f) => f.startsWith('lanes.json.imported-'))!
    expect(readFileSync(join(wsPath, '.combwork', backup), 'utf8')).toBe(before)
    expect(existsSync(join(wsPath, '.combwork', 'lanes.json'))).toBe(false)
    expect(await lanes.stampLaneProjects(w)).toBe(0)
  })

  it('Repair gives old-site’s card and lane to site, the card’s own fields kept', async () => {
    const plan = await movePlan(w)
    expect(plan?.cards).toEqual([{ from: 'old-site', to: 'site', cards: [3], lanes: 1 }])
    const report = await repairMove(w)
    expect(report.failed).toEqual([])
    expect(report.done).toEqual(expect.arrayContaining(['1 card of old-site now belongs to site, with its agents.', "1 lane of old-site now is site's."]))
    expect(readCard(wsPath, 3)).toMatchObject({ project: 'site', projectId: projectJson(join(wsPath, 'site')).id, custom: 'mine', agentName: 'Old', updatedAt: '2026-10-01T00:00:00.000Z' })
    expect((await lanes.listLanes(w, { all: true })).find((l) => l.id === 'lane-o')?.project).toBe('site')
    expect(await movePlan(w)).toBeNull()
  })

  it('a new project with the old name never takes a renamed project’s cards; stamping never gives them its id', async () => {
    const c = await run(() => tasks.createTask({ title: 'Alpha’s', project: 'alpha', agent: 'A1' }, user))
    const id = projectJson(join(wsPath, 'alpha')).id
    await lanes.stampLaneProjects(w)
    await moveFolder(join(wsPath, 'alpha'), join(wsPath, 'gamma'))
    project(wsPath, 'alpha', { agents: [{ id: 'x1', name: 'X', provider: 'claude-code' }] })
    await reread(w)
    expect((await run(() => tasks.getTask(c.number))).project).toBe('gamma')
    // The new alpha's agent doesn't see it.
    await expect(run(() => tasks.readTask(c.number, alphaAgent))).rejects.toThrow(/Unknown task/)
    await tasks.stampCardProjects(w)
    expect(readCard(wsPath, c.number)).toMatchObject({ project: 'gamma', projectId: id })
    expect((await lanes.listLanes(w, { all: true })).find((l) => l.id === 'lane-a')?.project).toBe('gamma')
  })

  it('a project gone, its name taken by another: its cards show as gone, are no one’s, and keep their saved id and name', async () => {
    const id = projectJson(join(wsPath, 'kappa')).id
    const c = await run(() => tasks.createTask({ title: 'Kappa’s', project: 'kappa' }, user))
    await tasks.stampCardProjects(w)
    // kappa leaves the workspace; another kappa comes.
    await moveFolder(join(wsPath, 'kappa'), join(base, 'kappa-elsewhere'))
    project(wsPath, 'kappa', { agents: [{ id: 'k1', name: 'K1', provider: 'claude-code' }] })
    await reread(w)
    const shown = await run(() => tasks.getTask(c.number))
    expect(shown.project).toBe('kappa: gone')
    const kappaAgent = { kind: 'agent', name: 'K1 (kappa)', scope: 'kappa', self: { project: 'kappa', agentId: 'k1' } } as const
    await expect(run(() => tasks.readTask(c.number, kappaAgent))).rejects.toThrow(/Unknown task/)
    expect(await tasks.stampCardProjects(w)).toBe(0)
    await run(() => tasks.commentTask(c.number, 'still mine', user))
    expect(readCard(wsPath, c.number)).toMatchObject({ project: 'kappa', projectId: id })
    // Back in the workspace under another name: the card is its again.
    await moveFolder(join(base, 'kappa-elsewhere'), join(wsPath, 'omega'))
    await reread(w)
    expect((await run(() => tasks.getTask(c.number))).project).toBe('omega')
  })

  it('two projects that swap names keep their own cards', async () => {
    const forBeta = await run(() => tasks.createTask({ title: 'Beta’s', project: 'beta' }, user))
    const forSite = await run(() => tasks.createTask({ title: 'Site’s', project: 'site' }, user))
    await moveFolder(join(wsPath, 'beta'), join(wsPath, 'swap'))
    await moveFolder(join(wsPath, 'site'), join(wsPath, 'beta'))
    await moveFolder(join(wsPath, 'swap'), join(wsPath, 'site'))
    await reread(w)
    expect((await run(() => tasks.getTask(forBeta.number))).project).toBe('site')
    expect((await run(() => tasks.getTask(forSite.number))).project).toBe('beta')
  })

  it('a project renamed while the window is open tells the board, so it reads its cards again', async () => {
    const { onCombworkEvent } = await import('../src/main/events')
    const seen: string[] = []
    const off = onCombworkEvent((e) => {
      if (e.type === 'tasks-changed') seen.push(e.workspacePath)
    })
    try {
      await w.projectIds({ fresh: true })
      seen.length = 0
      // Nothing but the rename: the workspace's folder watcher sees it and reads the ids again.
      await moveFolder(join(wsPath, 'rho'), join(wsPath, 'rho2'))
      await vi.waitFor(() => expect(seen).toContain(wsPath), { timeout: HUNG_MS })
    } finally {
      off()
    }
  })
})

describe('a project seen missing between reads, then at another folder, tells the board (#555)', () => {
  it('a read during a rename (the folder listed, gone when its project.json is read) loses no rename', async () => {
    const wsPath = join(base, 'ws-between')
    project(wsPath, 'mu')
    const w = createWorkspaceService()
    await w.open(wsPath)
    const { onCombworkEvent } = await import('../src/main/events')
    const seen: string[] = []
    const off = onCombworkEvent((e) => {
      if (e.type === 'tasks-changed') seen.push(e.workspacePath)
    })
    try {
      const id = (await w.projectIds({ fresh: true })).byPath.get(join(wsPath, 'mu').toLowerCase())
      // As a read part way through the rename sees it: mu is no project then (out of the workspace for this read).
      await moveFolder(join(wsPath, 'mu'), join(base, 'mu-between'))
      expect((await w.projectIds({ fresh: true })).byId.has(id!)).toBe(false)
      seen.length = 0
      await moveFolder(join(base, 'mu-between'), join(wsPath, 'mu2'))
      expect((await w.projectIds({ fresh: true })).byId.get(id!)).toBe(join(wsPath, 'mu2'))
      expect(seen).toContain(wsPath)
    } finally {
      off()
      await disposeWorkspaceService(w)
    }
  })
})

describe('what the workspace remembers of projects a read missed is bounded (#555)', () => {
  it('keeps every project read now and only the most recently missed of the others; a close forgets them all', async () => {
    const wsPath = join(base, 'ws-bound')
    project(wsPath, 'keep')
    const { WorkspaceService } = await import('../src/main/workspace')
    const kept = WorkspaceService.absentIdsKept
    WorkspaceService.absentIdsKept = 2
    const w = createWorkspaceService()
    await w.open(wsPath)
    const { onCombworkEvent } = await import('../src/main/events')
    const seen: string[] = []
    const off = onCombworkEvent((e) => {
      if (e.type === 'tasks-changed') seen.push(e.workspacePath)
    })
    try {
      // Four projects, each read and then out of the workspace: the two missed last are remembered.
      for (let i = 1; i <= 4; i++) {
        project(wsPath, `p${i}`)
        await w.projectIds({ fresh: true })
        await moveFolder(join(wsPath, `p${i}`), join(base, `ws-bound-out${i}`))
        await w.projectIds({ fresh: true })
      }
      expect(w.lastSeenCount()).toBe(1 + 2)
      // p1, missed longest ago, is forgotten: back under another name it is a project Combwork hasn't seen.
      seen.length = 0
      await moveFolder(join(base, 'ws-bound-out1'), join(wsPath, 'p1-back'))
      await w.projectIds({ fresh: true })
      expect(seen).toEqual([])
      // p4 is remembered: back under another name, the board hears of the rename.
      await moveFolder(join(base, 'ws-bound-out4'), join(wsPath, 'p4-back'))
      await w.projectIds({ fresh: true })
      expect(seen).toContain(wsPath)
      expect(w.lastSeenCount()).toBeLessThanOrEqual(3 + 2)
      await w.close()
      expect(w.lastSeenCount()).toBe(0)
    } finally {
      off()
      WorkspaceService.absentIdsKept = kept
      await disposeWorkspaceService(w)
    }
  })

  // HI-1668: the root watcher's read (250 ms after a folder changes) listed p4 before it went, and settled after the read
  // that no longer listed it: the older listing became the projects' ids and what is remembered (4 kept, not 3).
  it('a read that listed the folders before a later one settles after it: the later listing stands', async () => {
    const wsPath = join(base, 'ws-overlap')
    project(wsPath, 'keep')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      const gone = join(wsPath, 'gone')
      // The older read, the first to list `gone`, is held where it reads it, until the newer one has settled.
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const read = w.projectConfig.bind(w)
      let holding = true
      let reached = false
      w.projectConfig = (async (p: string, o?: never) => {
        if (holding && p.toLowerCase() === gone.toLowerCase()) {
          reached = true
          await held
        }
        return read(p, o)
      }) as typeof w.projectConfig
      project(wsPath, 'gone')
      const older = w.projectIds({ fresh: true })
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
      await moveFolder(gone, join(base, 'ws-overlap-out'))
      const newer = await w.projectIds({ fresh: true })
      expect(newer.byPath.has(gone.toLowerCase())).toBe(false)
      holding = false
      release()
      await older
      // HI-1817: the older read gave `gone` an id after it had moved, making its folder again; the root watch's read then
      // listed it, and under load settled before this check.
      expect(existsSync(gone)).toBe(false)
      expect(w.projectIdsNow().byPath.has(gone.toLowerCase())).toBe(false)
      expect(w.projectIdsNow().byPath.size).toBe(1)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  // HI-1817 (HR5's round 1): with no later read at all, a project moved out while it was being given its id was made
  // again by that write: it is given none, whether the move comes before project.json's lock reads it or before it writes.
  for (const at of ['the read in the lock', 'the write'] as const) {
    it(`a project moved while it is given its id isn't made again (moved before ${at})`, async () => {
      const wsPath = join(base, `ws-idmove-${at === 'the write' ? 'write' : 'read'}`)
      project(wsPath, 'keep')
      const w = createWorkspaceService()
      await w.open(wsPath)
      try {
        await w.refreshesSettled()
        const gone = join(wsPath, 'gone')
        let release!: () => void
        const held = new Promise<void>((r) => (release = r))
        let reached = false
        const hold = async (p: string): Promise<void> => {
          if (p.toLowerCase() !== gone.toLowerCase() || reached) return
          reached = true
          await held
        }
        // The listing's read of `gone` is its first; the one in project.json's lock, giving it its id, the second.
        const read = w.projectConfig.bind(w)
        let reads = 0
        w.projectConfig = (async (p: string, o?: never) => {
          if (at === 'the read in the lock' && p.toLowerCase() === gone.toLowerCase() && ++reads === 2) await hold(p)
          return read(p, o)
        }) as typeof w.projectConfig
        if (at === 'the write') configTestHooks.beforeConfigWrite = hold
        project(wsPath, 'gone')
        const ids = w.projectIds({ fresh: true })
        await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
        await moveFolder(gone, join(base, `ws-idmove-out-${at === 'the write' ? 'write' : 'read'}`))
        release()
        const index = await ids
        expect(existsSync(gone)).toBe(false)
        expect(index.byPath.has(gone.toLowerCase())).toBe(false)
        expect(w.projectIdsNow().byPath.has(gone.toLowerCase())).toBe(false)
      } finally {
        configTestHooks.beforeConfigWrite = undefined
        await disposeWorkspaceService(w)
      }
    })
  }

  // HI-2045: a refresh that listed a project before it was deleted (the root watcher's, 250 ms after its folder appeared)
  // found no project.json when it read it, and made the project again (`.combwork` with its sessions and archive folders).
  it("a refresh that listed a project before it was deleted doesn't make its folder again", async () => {
    const wsPath = join(base, 'ws-deleted-in-refresh')
    project(wsPath, 'keep')
    const gone = project(wsPath, 'gone')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      // The refresh is held once it has listed the folders, `gone` among them.
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const list = w.listProjectPaths.bind(w)
      let reached = false
      w.listProjectPaths = (async (o?: { hidden?: boolean }) => {
        const paths = await list(o)
        if (!reached && paths.some((p) => p.toLowerCase() === gone.toLowerCase())) {
          reached = true
          await held
        }
        return paths
      }) as typeof w.listProjectPaths
      const refresh = w.refresh()
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: HUNG_MS })
      rmSync(gone, { recursive: true, force: true })
      release()
      await refresh
      expect(existsSync(gone)).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  // HI-2045 (HR2's round 1): deleted later, once `.combwork` is there and before its folders and project.json are made, the
  // project isn't made again either: each is made only inside a folder that is there.
  it("a project deleted while it is being set up isn't made again by its folders or its project.json", async () => {
    const wsPath = join(base, 'ws-deleted-in-setup')
    project(wsPath, 'keep')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      const gone = join(wsPath, 'gone')
      mkdirSync(gone)
      // Its exclusion from git starts beside the folders: the project goes then, after `.combwork` was made.
      const exclude = w.ensureGitExclude.bind(w)
      w.ensureGitExclude = async (p: string) => {
        if (p.toLowerCase() === gone.toLowerCase()) rmSync(gone, { recursive: true, force: true })
        else await exclude(p)
      }
      await expect(w.ensureProject(gone)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(existsSync(gone)).toBe(false)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  // HI-2542: a project.json written after set up found none (a project copied in, its folder seen first; the accounts
  // suite's epsilon) is kept with its agents, never replaced by the default.
  it("a project.json written while a project is set up isn't replaced by the default", async () => {
    const wsPath = join(base, 'ws-config-in-setup')
    project(wsPath, 'keep')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      const copied = join(wsPath, 'copied')
      mkdirSync(copied)
      const theirs = JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'claude-code' }] })
      // After set up found no project.json, before it writes the default: the project's own arrives then.
      let held = 0
      configTestHooks.beforeDefaultConfig = async (p) => {
        if (p.toLowerCase() !== copied.toLowerCase()) return
        held++
        writeFileSync(join(copied, '.combwork', 'project.json'), theirs)
        writeFileSync(join(copied, '.combwork', 'project.json.bak'), theirs)
      }
      await w.ensureProject(copied)
      expect(held).toBe(1)
      expect(projectJson(copied)).toEqual(JSON.parse(theirs))
      expect(JSON.parse(readFileSync(join(copied, '.combwork', 'project.json.bak'), 'utf8'))).toEqual(JSON.parse(theirs))
      expect(readdirSync(join(copied, '.combwork')).filter((n) => n.endsWith('.tmp'))).toEqual([])
      // Its agent is there to change, as agents:update found it gone before.
      expect((await w.updateAgent(copied, 'a-one', { name: 'Uno' })).name).toBe('Uno')
    } finally {
      delete configTestHooks.beforeDefaultConfig
      await disposeWorkspaceService(w)
    }
  })

  // HI-2563: a project.json written from outside while one of Combwork's own changes to it runs (a new project's id, its
  // connections' migration: each read under the lock, then written) is read again, never written over with the value
  // read before it (the accounts suite's epsilon on RC3: its default, an id and the migration's stamp, its agent gone).
  it("a project.json written while a change to it runs isn't written over", async () => {
    const wsPath = join(base, 'ws-config-in-change')
    project(wsPath, 'keep')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      const taken = join(wsPath, 'taken')
      mkdirSync(taken)
      await w.ensureProject(taken)
      const theirs = { version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'claude-code' }] }
      // After the change read the default, before it writes: the project's own arrives then, written in place.
      let held = 0
      configTestHooks.beforeConfigWrite = async (p) => {
        if (p.toLowerCase() !== taken.toLowerCase() || held++) return
        writeFileSync(join(taken, '.combwork', 'project.json'), JSON.stringify(theirs))
      }
      const seen: unknown[][] = []
      await w.mutateProjectConfig(taken, (cfg) => (seen.push(cfg.agents ?? []), { id: 'p-0123456789ab' }), { existing: true })
      // Run again on the file as written then: both the change and the project's own agent are kept.
      expect(held).toBe(2)
      expect(seen.map((a) => a.length)).toEqual([0, 1])
      expect(projectJson(taken)).toMatchObject({ id: 'p-0123456789ab', agents: theirs.agents })
      expect((await w.updateAgent(taken, 'a-one', { name: 'Uno' })).name).toBe('Uno')
    } finally {
      configTestHooks.beforeConfigWrite = undefined
      await disposeWorkspaceService(w)
    }
  })

  // HI-2563, as on RC3: the change's rename refused (EPERM) while the project's own project.json is written over the file,
  // then tried again. It is read again rather than landing on what was written.
  it("a project.json written while a change's rename is refused isn't written over", async () => {
    const wsPath = join(base, 'ws-config-in-rename')
    project(wsPath, 'keep')
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      await w.refreshesSettled()
      const taken = join(wsPath, 'taken')
      mkdirSync(taken)
      await w.ensureProject(taken)
      const file = join(taken, '.combwork', 'project.json')
      const theirs = { version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'claude-code' }] }
      let refused = 0
      const { rename } = await import('original-fs/promises')
      atomicTestHooks.renameOnce = async (from, to) => {
        if (to.toLowerCase() === file.toLowerCase() && !refused) {
          refused++
          writeFileSync(file, JSON.stringify(theirs))
          throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
        }
        await rename(from, to)
      }
      const seen: number[] = []
      await w.mutateProjectConfig(taken, (cfg) => (seen.push((cfg.agents ?? []).length), { id: 'p-0123456789ab' }), { existing: true })
      expect(refused).toBe(1)
      expect(seen).toEqual([0, 1])
      expect(projectJson(taken)).toMatchObject({ id: 'p-0123456789ab', agents: theirs.agents })
      expect(readdirSync(join(taken, '.combwork')).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      delete atomicTestHooks.renameOnce
      await disposeWorkspaceService(w)
    }
  })

  /**
   * A workspace whose folder listings the test sets (`folders`), with every read of `gone`'s project.json held until
   * `release` (HR3's probe for HI-1668 round 1): the order reads list and settle in is the test's.
   */
  async function heldReads(name: string) {
    const wsPath = join(base, name)
    const keep = project(wsPath, 'keep', { id: 'p-111111111111' })
    const gone = project(wsPath, 'gone', { id: 'p-222222222222' })
    const w = createWorkspaceService()
    await w.open(wsPath)
    await w.refreshesSettled()
    const state = { folders: [keep] }
    w.listProjectPaths = async (o: { hidden?: boolean } = {}) => (o.hidden ? [] : [...state.folders])
    await w.projectIds({ fresh: true })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached = false
    const read = w.projectConfig.bind(w)
    w.projectConfig = (async (p: string, o?: never) => {
      if (p.toLowerCase() === gone.toLowerCase()) {
        reached = true
        await held
      }
      return read(p, o)
    }) as typeof w.projectConfig
    const has = () => w.projectIdsNow().byPath.has(gone.toLowerCase())
    return { w, keep, gone, state, release, reached: () => reached, has }
  }

  it('a later listing that finds the folders as already read settles at once: an older read held meanwhile is dropped', async () => {
    const h = await heldReads('ws-cached')
    try {
      const cached = h.w.projectIdsNow()
      h.state.folders = [h.keep, h.gone]
      const older = h.w.projectIds({ fresh: true })
      await vi.waitFor(() => expect(h.reached()).toBe(true), { timeout: HUNG_MS })
      h.state.folders = [h.keep]
      const newer = await h.w.projectIds({ fresh: true })
      // The folders as already read: the standing index itself.
      expect(newer).toBe(cached)
      h.release()
      await older
      expect(h.has()).toBe(false)
    } finally {
      h.release()
      await disposeWorkspaceService(h.w)
    }
  })

  it('a later listing that finds a read of the same folders under way makes it its own: it stands over one settled between', async () => {
    const h = await heldReads('ws-reuse')
    try {
      h.state.folders = [h.keep, h.gone]
      const first = h.w.projectIds({ fresh: true })
      await vi.waitFor(() => expect(h.reached()).toBe(true), { timeout: HUNG_MS })
      // Between: the folders as already read, settled at once.
      h.state.folders = [h.keep]
      await h.w.projectIds({ fresh: true })
      // Latest: `gone` back, the same folders the held read is reading: it shares that read.
      h.state.folders = [h.keep, h.gone]
      const latest = h.w.projectIds({ fresh: true })
      h.release()
      await Promise.all([first, latest])
      expect(h.has()).toBe(true)
    } finally {
      h.release()
      await disposeWorkspaceService(h.w)
    }
  })
})

describe('merge holds Combwork closed under are told in their project now (#508 round 3)', () => {
  const holdsFile = async (ws: string): Promise<string> => {
    const { hashText } = await import('../src/main/fsutil')
    return join(base, 'profile', 'merge-slots', `${hashText(ws.toLowerCase())}.json`)
  }
  const hold = (projectPath: string, extra: Record<string, unknown> = {}) => ({ projectPath, branch: 'cw/a1', agentId: 'a1', agentName: 'Builder', runId: 'old-run', cards: [1], since: 1, until: 2, ...extra })
  const writeHolds = async (ws: string, holds: object[]): Promise<string> => {
    const file = await holdsFile(ws)
    mkdirSync(join(base, 'profile', 'merge-slots'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, holds }))
    return file
  }
  /** What recovery told: each warning's place and text. */
  const recover = async (ws: string): Promise<{ source?: string; message?: string }[]> => {
    const { recoverMergeSlots } = await import('../src/main/mergeSlotHost')
    const { onCombworkEvent } = await import('../src/main/events')
    const seen: { source?: string; message?: string }[] = []
    const off = onCombworkEvent((e) => {
      if (e.type === 'toast') seen.push({ source: e.toast.source, message: e.toast.message })
    })
    try {
      await recoverMergeSlots(ws)
    } finally {
      off()
    }
    return seen
  }
  let n = 0

  it('one saved before ids, its project renamed since: told in the project now, and the record kept as it was beside it', async () => {
    const ws = join(base, `merges-${++n}`)
    const gamma = project(ws, 'gamma', { agents: [{ id: 'a1', name: 'Builder' }], lastPath: join(ws, 'alpha') })
    const file = await writeHolds(ws, [hold(join(ws, 'alpha'))])
    const before = readFileSync(file, 'utf8')
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      expect((await recover(ws)).map((t) => t.source)).toEqual([gamma])
      expect(JSON.parse(readFileSync(file, 'utf8')).holds).toEqual([])
      expect(readFileSync(`${file}.before-ids.bak`, 'utf8')).toBe(before)
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('one with an id follows it; one whose project is gone while another has its folder is told in the workspace, and kept', async () => {
    const ws = join(base, `merges-${++n}`)
    const delta = project(ws, 'delta', { id: 'p-0000000000d1', agents: [{ id: 'a1', name: 'Builder' }] })
    project(ws, 'alpha', { id: 'p-00000000a1b2', agents: [{ id: 'a1', name: 'Someone else' }] })
    const gone = hold(join(ws, 'alpha'), { projectId: 'p-0000000000aa', runId: 'gone-run' })
    const file = await writeHolds(ws, [hold(join(ws, 'beta'), { projectId: 'p-0000000000d1' }), gone])
    const w = createWorkspaceService()
    await w.open(ws)
    try {
      const told = await recover(ws)
      expect(told.map((t) => t.source)).toEqual([delta, ws])
      expect(told[1].message).toMatch(/in alpha, a project this workspace no longer has/)
      expect(JSON.parse(readFileSync(file.replace(/\.json$/, '.unplaced.json'), 'utf8')).holds).toEqual([gone])
      // Told once: opened again, nothing more.
      expect(await recover(ws)).toEqual([])
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('the whole workspace moved: the holds recorded at its old folder are told in its projects at the new one', async () => {
    const from = join(base, `merges-${++n}`)
    const alpha = project(from, 'alpha', { agents: [{ id: 'a1', name: 'Builder' }] })
    const w = createWorkspaceService()
    await w.open(from)
    const { checkMoved } = await import('../src/main/workspaceMove')
    await checkMoved(w)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())
    await disposeWorkspaceService(w)
    const file = await writeHolds(from, [hold(alpha, { projectId: id }), hold(alpha, { runId: 'legacy-run', branch: 'cw/old' })])
    const before = readFileSync(file, 'utf8')
    const to = `${from}-moved`
    await moveFolder(from, to)
    const w2 = createWorkspaceService()
    await w2.open(to)
    try {
      expect(w2.movedFrom?.toLowerCase()).toBe(from.toLowerCase())
      expect((await recover(to)).map((t) => t.source)).toEqual([join(to, 'alpha'), join(to, 'alpha')])
      expect(JSON.parse(readFileSync(file, 'utf8')).holds).toEqual([])
      expect(readFileSync(`${file}.before-ids.bak`, 'utf8')).toBe(before)
    } finally {
      await disposeWorkspaceService(w2)
    }
  })
})

describe('a workspace moved with a project renamed (#1305): Working on by the name it has now', () => {
  it('the plan names the project as it is called now, and Repair marks it so, never its old name', async () => {
    const before = join(base, 'Scratch')
    const wsPath = join(base, 'Tools')
    // juniper, now dialect: moved with its workspace (Scratch → Tools) and renamed while Combwork was closed.
    project(wsPath, 'dialect', { lastPath: join(before, 'juniper') })
    const w = createWorkspaceService()
    await w.open(wsPath)
    try {
      w.config.lastPath = before
      await w.saveWorkspaceConfig()
      const { config } = await import('../src/main/config')
      config.update((c) => {
        c.activeProjects[before] = ['juniper']
      })
      const plan = await movePlan(w)
      expect(plan?.working).toEqual(['dialect'])
      const report = await repairMove(w)
      expect(report.failed).toEqual([])
      expect(config.get().activeProjects[wsPath]).toEqual(['dialect'])
    } finally {
      await disposeWorkspaceService(w)
    }
  })
})
