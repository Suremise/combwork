// A project renamed or moved within its workspace (#514). Whose a record is goes by the project's stable id, never a
// name alone: Combwork records each project's names by id (.combwork/project-names.json: renames found by id, so a swap is two
// renames, and a copy, given an id of its own, brings none of it along), handovers and kept comparisons are owned by id
// (recorded as they are written, worked out once for older ones from what they say), and what keeps a project by its
// folder's name or path follows each rename once (each place saves the last rename it followed with its data, so a
// failure or a stop part way is finished later, never done twice).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { NameJournal } from '../src/main/projectNames'
import { moveFolder as move } from './moveFolder'
import { tempDir } from './tempDir'
import { readCardIn } from './boardDb'
import { closeAllBoards } from '../src/main/boardStore'

const base = tempDir('hive-projectrename-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
afterAll(() => {
  closeAllBoards()
  rmSync(base, { recursive: true, force: true })
})

const { WorkspaceService, createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const notes = await import('../src/main/notes')
const names = await import('../src/main/projectNames')
const fsutil = await import('../src/main/fsutil')
const { repairMove } = await import('../src/main/workspaceMove')
const { followNames, followingNames, testHooks } = await import('../src/main/projectRename')
testHooks.retryMs = 50
const { config } = await import('../src/main/config')
const { progress } = await import('../src/main/progressService')
const metrics = await import('../src/main/metrics')
const kept = await import('../src/main/benchmarks')
const { metricsReport } = await import('../src/main/metricsUsage')

vi.setConfig({ testTimeout: 30_000 })
beforeAll(() => {
  WorkspaceService.onIdsRead = followNames
})
afterEach(() => vi.restoreAllMocks())

type WS = InstanceType<typeof WorkspaceService>
const projectJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(p, '.combwork', 'project.json'), 'utf8'))
const journal = (ws: string): NameJournal => JSON.parse(readFileSync(join(ws, '.combwork', 'project-names.json'), 'utf8'))
function project(ws: string, name: string, extra: Record<string, unknown> = {}, sessions: string[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...extra }))
  writeFileSync(join(p, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: sessions.map((id) => ({ id, agent: 'claude-code', name: id, createdAt: '2026-10-01T00:00:00.000Z', lastActiveAt: '2026-10-01T00:00:00.000Z', archived: false })) }))
  return p
}
/** A handover as an older Combwork wrote it (no owner recorded): its name's project slug, and its header. */
function oldHandover(ws: string, file: string, projectName: string, session?: string): void {
  mkdirSync(join(ws, '.combwork', 'shared', 'handovers'), { recursive: true })
  writeFileSync(join(ws, '.combwork', 'shared', 'handovers', file), `# Handover\n\n- **Project:** ${projectName}\n${session ? `- **Session:** ${session}\n` : ''}- **Date:** 2026-10-01 10:00 (2026-10-01T10:00:00Z)\n\nWhere things stand.\n`)
}
/** Bounds a wait for the projects' names to be followed (in the background, after each read): only a hung run takes this long. */
const HUNG_MS = 15_000
/** Until `want` holds (up to HUNG_MS): the ids read again (each read is followed in the background). */
async function until(w: WS, want: () => boolean | Promise<boolean>): Promise<boolean> {
  for (const end = Date.now() + HUNG_MS; Date.now() < end; ) {
    if (await want()) return true
    await w.projectIds({ fresh: true })
    await new Promise((r) => setTimeout(r, 20))
  }
  return !!(await want())
}
const handovers = async (w: WS, p: string): Promise<string[]> => (await inWorkspace(w, () => notes.handoversFor(w, p))).map((f) => f.name)
/** A comparison kept from the project's Performance page (a real report of its metrics). */
async function keepFor(w: WS, p: string): Promise<string> {
  metrics.recordApi(metrics.metricsHandle(w), p, { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
  const report = await metricsReport(w, { scope: { kind: 'project', project: p } })
  return (await kept.keepReport(kept.benchContext(w), report, '0.6.0', `${p}'s`)).id
}
const comparisons = async (w: WS, p: string): Promise<string[]> => (await kept.listBenchmarks(kept.benchContext(w), { kind: 'project', project: p })).entries.map((e) => e.id)
let n = 0
const newWs = (): string => join(base, `ws-${++n}`)
async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  return w
}

describe('a project renamed: found by its id (#514)', () => {
  it('while Combwork was closed, and while it runs: each recorded once, its old name kept by its id', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    let w = await open(ws)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    expect(await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))).toBe(true)
    expect(journal(ws).projects[id]).toEqual({ name: 'alpha', former: [] })
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'gamma'))
    w = await open(ws)
    expect(await until(w, () => journal(ws).projects[id]?.name === 'gamma')).toBe(true)
    expect(journal(ws).renames.map((r) => [r.id, r.from, r.to])).toEqual([[id, 'alpha', 'gamma']])
    await move(join(ws, 'gamma'), join(ws, 'delta'))
    expect(await until(w, () => journal(ws).projects[id]?.name === 'delta')).toBe(true)
    expect(journal(ws).projects[id].former).toEqual(['gamma', 'alpha'])
    // Read again and again: nothing more.
    for (let i = 0; i < 3; i++) await w.projectIds({ fresh: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(journal(ws).renames).toHaveLength(2)
    // The project.json is the project's own: no names in it.
    expect(projectJson(join(ws, 'delta'))).not.toHaveProperty('formerNames')
    await disposeWorkspaceService(w)
  })

  it('from before (project.json lastPath in this folder, no record yet): once; a copy, even of a renamed project, never', async () => {
    const ws = newWs()
    project(ws, 'website', { id: 'p-00000000aaaa', lastPath: join(ws, 'hive-website') })
    // Copied by an older Combwork (no ids), its original still a project.
    project(ws, 'old', { lastPath: join(ws, 'old') })
    cpSync(join(ws, 'old'), join(ws, 'old-2'), { recursive: true })
    let w = await open(ws)
    expect(await until(w, () => !!journal(ws).projects['p-00000000aaaa'])).toBe(true)
    expect(journal(ws).renames.map((r) => [r.from, r.to])).toEqual([['hive-website', 'website']])
    // website renamed, then copied: the copy (an id of its own) has no earlier names.
    await disposeWorkspaceService(w)
    await move(join(ws, 'website'), join(ws, 'site'))
    cpSync(join(ws, 'site'), join(ws, 'site-copy'), { recursive: true })
    w = await open(ws)
    const ids = await w.projectIds({ fresh: true })
    const copyId = ids.byPath.get(join(ws, 'site-copy').toLowerCase())!
    expect(copyId).not.toBe('p-00000000aaaa')
    expect(await until(w, () => !!journal(ws).projects[copyId])).toBe(true)
    expect(journal(ws).projects[copyId]).toEqual({ name: 'site-copy', former: [] })
    expect(journal(ws).projects['p-00000000aaaa']).toEqual({ name: 'site', former: ['website', 'hive-website'] })
    await disposeWorkspaceService(w)
  })
})

describe('handovers and kept comparisons are owned by id (#514)', () => {
  it("a renamed project keeps its own; a new project that takes its old name, or a copy of it, never gets them", async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    let w = await open(ws)
    await inWorkspace(w, () => notes.createHandover('alpha', 'Plan', '## State\nIt stands.'))
    const comparison = await keepFor(w, 'alpha')
    await kept.selectBenchmarks(kept.benchContext(w), { kind: 'project', project: 'alpha' }, null, comparison)
    expect(await handovers(w, 'alpha')).toHaveLength(1)
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'gamma'))
    w = await open(ws)
    expect(await until(w, async () => (await handovers(w, 'gamma')).length === 1)).toBe(true)
    expect(await comparisons(w, 'gamma')).toEqual([comparison])
    // A new alpha (an id of its own), and a copy of gamma.
    project(ws, 'alpha')
    cpSync(join(ws, 'gamma'), join(ws, 'gamma-copy'), { recursive: true })
    await w.projectIds({ fresh: true })
    for (const other of ['alpha', 'gamma-copy']) {
      expect(await handovers(w, other)).toEqual([])
      expect(await comparisons(w, other)).toEqual([])
      const ctx = kept.benchContext(w)
      const scope = { kind: 'project' as const, project: other }
      await expect(kept.readBenchmark(ctx, scope, comparison)).rejects.toThrow(/for this scope/)
      await kept.pinBenchmark(ctx, scope, comparison, true)
      await kept.removeBenchmark(ctx, scope, comparison)
      expect((await kept.listBenchmarks(ctx, scope)).run).toBeNull()
    }
    // gamma's are as they were, its choice too.
    const gamma = { kind: 'project' as const, project: 'gamma' }
    expect(await kept.listBenchmarks(kept.benchContext(w), gamma)).toMatchObject({ entries: [expect.objectContaining({ id: comparison, pinned: false })], run: comparison })
    expect((await kept.readBenchmark(kept.benchContext(w), gamma, comparison)).kind).toBe('export')
    expect(await handovers(w, 'gamma')).toHaveLength(1)
    await disposeWorkspaceService(w)
  })

  it('older ones are given owners once, from what they say: a contradicting header is never overruled by a file name', async () => {
    const ws = newWs()
    // website was hive-website, and a Repair already recorded it where it is (lastPath website): its name before is lost.
    project(ws, 'hive')
    project(ws, 'website', { lastPath: join(ws, 'website') }, ['sess-web'])
    oldHandover(ws, '2026-10-01-hive-website-launch.md', 'hive-website')
    oldHandover(ws, '2026-10-02-hive-website-notes.md', 'hive-website', 'sess-web')
    oldHandover(ws, '2026-10-03-hive-plan.md', 'hive')
    const w = await open(ws)
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    // Its conversation tells (sessions.json); the other can't be known yet: nobody's, never hive's.
    expect(await handovers(w, 'website')).toEqual(['2026-10-02-hive-website-notes.md'])
    expect(await handovers(w, 'hive')).toEqual(['2026-10-03-hive-plan.md'])
    // Repair finds website was hive-website (its cards there), and records it: that one is website's too.
    await names.noteFormerName(w, w.projectIdsNow().byPath.get(join(ws, 'website').toLowerCase())!, 'hive-website')
    await inWorkspace(w, () => notes.adoptHandovers(w))
    expect(await handovers(w, 'website')).toEqual(['2026-10-02-hive-website-notes.md', '2026-10-01-hive-website-launch.md'])
    expect(await handovers(w, 'hive')).toEqual(['2026-10-03-hive-plan.md'])
    await disposeWorkspaceService(w)
  })

  it('an older comparison is given its project once (by its name), and keeps it after a rename and a new project of that name', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    let w = await open(ws)
    const comparison = await keepFor(w, 'alpha')
    // As kept before owners: no owner, and its choice by name.
    const indexFile = join(ws, '.combwork', 'metrics', 'benchmarks', 'index.json')
    const index = JSON.parse(readFileSync(indexFile, 'utf8'))
    for (const e of index.entries) delete e.owner
    index.selected = { 'project:alpha': { run: comparison } }
    writeFileSync(indexFile, JSON.stringify(index))
    await disposeWorkspaceService(w)
    w = await open(ws)
    await until(w, async () => !JSON.parse(readFileSync(indexFile, 'utf8')).selected['project:alpha'])
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'gamma'))
    project(ws, 'alpha')
    w = await open(ws)
    await w.projectIds({ fresh: true })
    expect(await kept.listBenchmarks(kept.benchContext(w), { kind: 'project', project: 'gamma' })).toMatchObject({ entries: [expect.objectContaining({ id: comparison })], run: comparison })
    expect(await comparisons(w, 'alpha')).toEqual([])
    await disposeWorkspaceService(w)
  })
})

describe('what keeps a project by name or path follows a rename, once (#514)', () => {
  const prefs = (ws: string, p: string) => config.get().ui.skillsProvider?.[join(ws, p).toLowerCase()]
  const measured = (w: WS, p: string) => metrics.queryMetrics(w, { scope: { kind: 'project', project: p } }).projects[p]?.api.reduce((a, s) => a + s.count, 0) ?? 0

  it('two projects that swapped names while Combwork was closed keep their own preferences, runs, metrics and handovers', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    const beta = project(ws, 'beta')
    let w = await open(ws)
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    const ids = await w.projectIds()
    const a = ids.byPath.get(alpha.toLowerCase())!
    config.update((c) => {
      c.ui.skillsProvider = { ...c.ui.skillsProvider, [alpha.toLowerCase()]: 'codex', [beta.toLowerCase()]: 'claude-code' }
    })
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
    for (let i = 0; i < 2; i++) metrics.recordApi(metrics.metricsHandle(w), 'beta', { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
    const run = progress.start({ source: 'agent', workspacePath: ws, projectPath: alpha, agentId: 'x', agentName: 'X', provider: 'claude-code' }, { title: 'alpha tests' })
    await inWorkspace(w, () => notes.createHandover('alpha', 'Alpha plan', 'x'))
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'temp'))
    await move(beta, alpha)
    await move(join(ws, 'temp'), beta)
    w = await open(ws)
    expect(await until(w, () => journal(ws).renames.length === 2 && (config.get().renamesApplied?.[ws.toLowerCase()] ?? 0) === 2)).toBe(true)
    // The ids went with the folders: a (was alpha) is beta now, b is alpha.
    expect((await w.projectIds()).byPath.get(beta.toLowerCase())).toBe(a)
    expect(new Set(journal(ws).renames.map((r) => r.batch)).size).toBe(1)
    expect([prefs(ws, 'beta'), prefs(ws, 'alpha')]).toEqual(['codex', 'claude-code'])
    expect(await until(w, () => measured(w, 'beta') === 1)).toBe(true)
    expect(measured(w, 'alpha')).toBe(2)
    expect(progress.list(ws).find((r) => r.id === run.id)?.projectPath).toBe(beta)
    expect(await handovers(w, 'beta')).toHaveLength(1)
    expect(await handovers(w, 'alpha')).toEqual([])
    // Read again: nothing is done twice.
    for (let i = 0; i < 3; i++) await w.projectIds({ fresh: true })
    await new Promise((r) => setTimeout(r, 200))
    expect([prefs(ws, 'beta'), prefs(ws, 'alpha'), measured(w, 'beta'), measured(w, 'alpha')]).toEqual(['codex', 'claude-code', 1, 2])
    progress.clear(ws)
    await disposeWorkspaceService(w)
  })

  it('a step that fails part way is finished at the next read, the steps already done not done again; a second rename meanwhile too', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    const w = await open(ws)
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    config.update((c) => {
      c.ui.skillsProvider = { ...c.ui.skillsProvider, [alpha.toLowerCase()]: 'codex' }
    })
    metrics.recordApi(metrics.metricsHandle(w), 'alpha', { route: '/v1/tasks', method: 'GET', role: 'agent', outcome: 'ok', requestBytes: 1, responseBytes: 1, ms: 1 })
    // Progress fails, twice.
    const real = progress.applyRenames.bind(progress)
    let fails = 2
    vi.spyOn(progress, 'applyRenames').mockImplementation(async (...a) => {
      if (fails-- > 0) throw new Error('disk full')
      return real(...a)
    })
    const run = progress.start({ source: 'agent', workspacePath: ws, projectPath: alpha, agentId: 'x', agentName: 'X', provider: 'claude-code' }, { title: 'tests' })
    await move(alpha, join(ws, 'gamma'))
    expect(await until(w, () => prefs(ws, 'gamma') === 'codex')).toBe(true)
    // Before Progress is done, gamma is renamed again.
    await move(join(ws, 'gamma'), join(ws, 'delta'))
    expect(await until(w, () => progress.list(ws).find((r) => r.id === run.id)?.projectPath === join(ws, 'delta'))).toBe(true)
    expect(prefs(ws, 'delta')).toBe('codex')
    expect(prefs(ws, 'gamma')).toBeUndefined()
    expect(await until(w, () => measured(w, 'delta') === 1)).toBe(true)
    expect(measured(w, 'gamma') + measured(w, 'alpha')).toBe(0)
    progress.clear(ws)
    await disposeWorkspaceService(w)
  })

  it('a retry follows the newest read, never the one that failed: no rename back that never happened (#555)', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    const w = await open(ws)
    expect(await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))).toBe(true)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    config.update((c) => {
      c.ui.skillsProvider = { ...c.ui.skillsProvider, [alpha.toLowerCase()]: 'codex' }
    })
    // Progress fails once; its retry is held, to be let go once a later read has been followed.
    const real = progress.applyRenames.bind(progress)
    let fails = 1
    vi.spyOn(progress, 'applyRenames').mockImplementation(async (...a) => {
      if (fails-- > 0) throw new Error('disk full')
      return real(...a)
    })
    const RETRY = 4321
    const was = testHooks.retryMs
    testHooks.retryMs = RETRY
    let retry: (() => void) | null = null
    const schedule = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === RETRY && !retry) {
        retry = fn
        return { unref: () => undefined }
      }
      return schedule(fn, ms)
    }) as unknown as typeof setTimeout)
    try {
      const run = progress.start({ source: 'agent', workspacePath: ws, projectPath: alpha, agentId: 'x', agentName: 'X', provider: 'claude-code' }, { title: 'tests' })
      await move(alpha, join(ws, 'gamma'))
      expect(await until(w, () => retry !== null && !followingNames(w))).toBe(true)
      // Renamed again, and that read followed, before the retry comes.
      await move(join(ws, 'gamma'), join(ws, 'delta'))
      expect(await until(w, () => progress.list(ws).find((r) => r.id === run.id)?.projectPath === join(ws, 'delta') && !followingNames(w))).toBe(true)
      retry!()
      await vi.waitFor(() => expect(followingNames(w)).toBe(false), { timeout: HUNG_MS })
      expect(journal(ws).renames.map((r) => [r.id, r.from, r.to])).toEqual([[id, 'alpha', 'gamma'], [id, 'gamma', 'delta']])
      expect(progress.list(ws).find((r) => r.id === run.id)?.projectPath).toBe(join(ws, 'delta'))
      expect(prefs(ws, 'delta')).toBe('codex')
      progress.clear(ws)
    } finally {
      testHooks.retryMs = was
      await disposeWorkspaceService(w)
    }
  })
})

describe('at the edges: a switched workspace, a name taken again, a failed write (#514)', () => {
  it('adoption waiting for its lock when the window opens another workspace changes nothing in either', async () => {
    WorkspaceService.onIdsRead = null
    try {
      const A = newWs()
      const B = newWs()
      project(A, 'alpha', { id: 'p-111111111111' })
      project(B, 'alpha', { id: 'p-222222222222' })
      project(B, 'beta', { id: 'p-333333333333' })
      oldHandover(A, '2026-10-01-alpha-a.md', 'alpha')
      oldHandover(B, '2026-10-01-beta-b.md', 'beta')
      const ownersB = join(B, '.combwork', 'handover-owners.json')
      const before = { version: 1, owners: { '2026-10-01-beta-b.md': 'p-333333333333' } }
      writeFileSync(ownersB, JSON.stringify(before))
      const w = await open(A)
      const ownersA = join(A, '.combwork', 'handover-owners.json')
      // A's record held (another adoption writing it): this one waits for it.
      let release!: () => void
      let held!: () => void
      const holding = new Promise<void>((r) => (held = r))
      const holder = fsutil.withFileLock(ownersA, () => (held(), new Promise<void>((r) => (release = r))))
      await holding
      const real = fsutil.withFileLock
      let queued!: () => void
      const waiting = new Promise<void>((r) => (queued = r))
      vi.spyOn(fsutil, 'withFileLock').mockImplementation(((file: string, fn: () => Promise<unknown>) => {
        if (file === ownersA) queued()
        return real(file, fn)
      }) as typeof fsutil.withFileLock)
      const adoption = inWorkspace(w, () => notes.adoptHandovers(w))
      await waiting
      // The window opens B meanwhile.
      await w.open(B)
      release()
      await holder
      await expect(adoption).rejects.toThrow(/closed or switched/)
      expect(JSON.parse(readFileSync(ownersB, 'utf8'))).toEqual(before)
      expect(existsSync(ownersA)).toBe(false)
      await disposeWorkspaceService(w)
    } finally {
      WorkspaceService.onIdsRead = followNames
    }
  })

  it('an older handover of a renamed project, its name taken by a new project: its conversation tells; nothing tells, nobody', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha', {}, ['session-original'])
    let w = await open(ws)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'gamma'))
    project(ws, 'alpha')
    // Not given owners before (a Combwork from before, or written by hand meanwhile).
    oldHandover(ws, '2026-10-01-alpha-original.md', 'alpha', 'session-original')
    oldHandover(ws, '2026-10-02-alpha-unknown.md', 'alpha')
    oldHandover(ws, '2026-10-03-alpha-elsewhere.md', 'alpha', 'session-nowhere')
    w = await open(ws)
    expect(await until(w, () => journal(ws).projects[id]?.name === 'gamma')).toBe(true)
    expect(await handovers(w, 'gamma')).toEqual(['2026-10-01-alpha-original.md'])
    expect(await handovers(w, 'alpha')).toEqual([])
    // The ones that can't be known stay nobody's (asked again later), never the new alpha's.
    const owners = JSON.parse(readFileSync(join(ws, '.combwork', 'handover-owners.json'), 'utf8')).owners
    expect(Object.keys(owners)).toEqual(['2026-10-01-alpha-original.md'])
    await disposeWorkspaceService(w)
  })

  it("Repair that can't give the handovers their project records what it found first: the next Repair finishes it, and isn't done until then", async () => {
    const ws = newWs()
    // website was hive-website, and was recorded where it is (lastPath website) before ids: only its old card tells.
    project(ws, 'website', { lastPath: join(ws, 'website'), agents: [{ id: 'site-builder', name: 'Builder', provider: 'claude-code' }] })
    project(ws, 'hive')
    oldHandover(ws, '2026-10-01-hive-website-old.md', 'hive-website')
    mkdirSync(join(ws, '.combwork', 'tasks'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'tasks', '1.json'), JSON.stringify({ number: 1, title: 'Old card', project: 'hive-website', agent: 'site-builder', column: 'done', archived: true, history: [], comments: [] }))
    const w = await open(ws)
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    const owners = join(ws, '.combwork', 'handover-owners.json')
    const real = fsutil.writeKeptJson
    // Every write of the handovers' owners fails, for now (the record of names and the cards are written).
    const spy = vi.spyOn(fsutil, 'writeKeptJson').mockImplementation(async (file, data) => {
      if (file === owners) throw new Error('disk full')
      return real(file, data)
    })
    const first = await inWorkspace(w, () => repairMove(w))
    expect(first.complete).toBe(false)
    expect(first.failed.join(' ')).toMatch(/Repair tries again/)
    expect(journal(ws).projects[w.projectIdsNow().byPath.get(join(ws, 'website').toLowerCase())!].former).toContain('hive-website')
    // The card moved; the next Repair, still failing, isn't done either.
    expect(readCardIn(ws, 1).project).not.toBe('hive-website')
    expect((await inWorkspace(w, () => repairMove(w))).complete).toBe(false)
    spy.mockRestore()
    const third = await inWorkspace(w, () => repairMove(w))
    expect(third.complete).toBe(true)
    expect(await handovers(w, 'website')).toEqual(['2026-10-01-hive-website-old.md'])
    expect(await handovers(w, 'hive')).toEqual([])
    await disposeWorkspaceService(w)
  })

  it("Hide's names follow a rename only once workspace.json is saved: a save that fails is done again", async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    const w = await open(ws)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    await until(w, () => existsSync(join(ws, '.combwork', 'project-names.json')))
    w.config.hiddenProjects = [{ name: 'alpha', mode: 'hidden', at: '2026-10-01T00:00:00.000Z' }]
    await w.saveWorkspaceConfig()
    const file = join(ws, '.combwork', 'workspace.json')
    const real = fsutil.writeKeptJson
    let fails = 1
    const spy = vi.spyOn(fsutil, 'writeKeptJson').mockImplementation(async (f, data) => {
      if (f === file && fails-- > 0) throw new Error('disk full')
      return real(f, data)
    })
    const disk = (): { hiddenProjects?: { name: string }[]; renamesApplied?: number } => JSON.parse(readFileSync(file, 'utf8'))
    await move(alpha, join(ws, 'gamma'))
    // Failed: as it was, in memory and on disk; then done, at the next try.
    expect(await until(w, () => journal(ws).projects[id]?.name === 'gamma' && disk().renamesApplied === journal(ws).seq && w.config.renamesApplied === journal(ws).seq)).toBe(true)
    expect(fails).toBeLessThan(0)
    expect(disk().hiddenProjects?.map((h) => h.name)).toEqual(['gamma'])
    expect(w.config.hiddenProjects?.map((h) => h.name)).toEqual(['gamma'])
    expect(w.config.renamesApplied).toBe(journal(ws).seq)
    spy.mockRestore()
    await disposeWorkspaceService(w)
  })

  it('a handover renamed in Notes keeps its project (its case too, and with an adoption at the same time), after a rename and a new project of the old name', async () => {
    const ws = newWs()
    const alpha = project(ws, 'alpha')
    let w = await open(ws)
    const id = (await w.projectIds()).byPath.get(alpha.toLowerCase())!
    const file = await inWorkspace(w, () => notes.createHandover('alpha', 'Plan', '## State\nIt stands.'))
    await disposeWorkspaceService(w)
    await move(alpha, join(ws, 'gamma'))
    project(ws, 'alpha')
    w = await open(ws)
    expect(await until(w, async () => (await handovers(w, 'gamma')).length === 1)).toBe(true)
    const date = file.match(/(\d{4}-\d{2}-\d{2})-alpha-plan\.md$/)![1]
    const ownersFile = join(ws, '.combwork', 'handover-owners.json')
    const owners = (): Record<string, string> => JSON.parse(readFileSync(ownersFile, 'utf8')).owners
    // Renamed while the record is held, with an adoption waiting too: both wait, and neither loses it.
    let release!: () => void
    let held!: () => void
    const holding = new Promise<void>((r) => (held = r))
    const holder = fsutil.withFileLock(ownersFile, () => (held(), new Promise<void>((r) => (release = r))))
    await holding
    const renamed = inWorkspace(w, () => notes.renameNote(file, `${date}-alpha-renamed-plan.md`))
    const adoption = inWorkspace(w, () => notes.adoptHandovers(w))
    release()
    await holder
    await renamed
    await adoption
    expect(owners()).toEqual({ [`${date}-alpha-renamed-plan.md`]: id })
    expect(await handovers(w, 'gamma')).toEqual([`${date}-alpha-renamed-plan.md`])
    expect(await handovers(w, 'alpha')).toEqual([])
    // Only its case.
    await inWorkspace(w, () => notes.renameNote(join(ws, '.combwork', 'shared', 'handovers', `${date}-alpha-renamed-plan.md`), `${date}-alpha-Renamed-Plan.md`))
    expect(owners()).toEqual({ [`${date}-alpha-Renamed-Plan.md`]: id })
    expect(await handovers(w, 'gamma')).toEqual([`${date}-alpha-Renamed-Plan.md`])
    expect(await handovers(w, 'alpha')).toEqual([])
    // Its extension's case, and another type for a while, there and back: still gamma's.
    const dir = join(ws, '.combwork', 'shared', 'handovers')
    const final = `${date}-alpha-plan.md`
    let name = `${date}-alpha-Renamed-Plan.md`
    for (const next of [`${date}-alpha-plan.MD`, `${date}-alpha-plan.txt`, final]) {
      await inWorkspace(w, () => notes.renameNote(join(dir, name), next))
      name = next
      expect(owners()).toEqual({ [next]: id })
      expect(await handovers(w, 'gamma')).toEqual(next.endsWith('.txt') ? [] : [next])
    }
    // Its case changed outside Combwork (Explorer): the same file, still gamma's.
    await move(join(dir, final), join(dir, final.toUpperCase().replace('.MD', '.md')))
    expect(await handovers(w, 'gamma')).toEqual([final.toUpperCase().replace('.MD', '.md')])
    await move(join(dir, final.toUpperCase().replace('.MD', '.md')), join(dir, final))
    // And after the workspace is opened again.
    await disposeWorkspaceService(w)
    w = await open(ws)
    expect(await handovers(w, 'gamma')).toEqual([final])
    expect(await handovers(w, 'alpha')).toEqual([])
    expect(owners()).toEqual({ [final]: id })
    await disposeWorkspaceService(w)
  })
})
