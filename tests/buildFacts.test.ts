// Builds recorded as facts (#1534, #1062): npm run dist and npm run release tell Hive of each successful build
// (scripts/buildFact.mjs), through the Agent API when Hive answers, else by a marker in the workspace's .hive/builds;
// Hive writes it into the journal as its own entry, once, while Settings → Advanced → Record builds in the journal and
// the journal take it (src/main/buildFacts.ts). A failed build records nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { BUILD_KINDS, buildFactOf, buildFactSummary } from '../src/shared/buildFacts'
import { JOURNAL_BUILDS } from '../src/shared/advanced'
// @ts-expect-error: a plain .mjs module without types
import * as script from '../scripts/buildFact.mjs'

const base = tempDir('hive-build-facts-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const journal = await import('../src/main/journal')
const service = await import('../src/main/journalService')
const builds = await import('../src/main/buildFacts')
const { advanced } = await import('../src/main/advanced')

vi.setConfig({ testTimeout: 30_000 })

const fact = { kind: 'baseline', version: '1.0.0-rc.1', commit: '1fef5341a2b3c4d5e6f708192a3b4c5d6e7f8091', branch: '1.0.0', installer: 'D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0-rc.1.exe', builtAt: '2026-10-24T11:00:00.000Z', by: 'dist' }

describe('a build fact', () => {
  it('has the same kinds in the scripts and in Hive', () => {
    expect(script.BUILD_KINDS).toEqual([...BUILD_KINDS])
  })

  it('takes its kind from --kind, else from the version and the script', () => {
    expect(script.buildKind('1.0.0-rc.1', 'dist', 'baseline')).toBe('baseline')
    expect(script.buildKind('0.9.4-beta.2', 'dist')).toBe('beta')
    expect(script.buildKind('1.0.0-rc.3', 'release')).toBe('rc')
    expect(script.buildKind('1.0.0', 'release')).toBe('release')
    // A dist build at a release's version is its candidate (RELEASING.md, Step 1).
    expect(script.buildKind('1.0.0', 'dist')).toBe('rc')
    expect(() => script.buildKind('1.0.0', 'dist', 'nightly')).toThrow(/--kind is one of: beta, baseline, rc, release/)
  })

  it('is checked as it arrives, and reads as one line', () => {
    expect(buildFactOf(fact)).toEqual({ ...fact, commit: fact.commit })
    expect(buildFactOf({ ...fact, kind: 'nightly' })).toEqual({ error: 'kind is one of: beta, baseline, rc, release.' })
    expect(buildFactOf({ ...fact, commit: 'HEAD' })).toEqual({ error: expect.stringMatching(/^commit is a commit id/) })
    expect(buildFactOf({ ...fact, installer: '' })).toEqual({ error: expect.stringMatching(/^installer/) })
    expect(buildFactOf({ ...fact, by: 'ci' })).toEqual({ error: 'by is dist or release.' })
    expect(buildFactSummary(buildFactOf(fact) as never)).toBe('Built Hive 1.0.0-rc.1 (baseline) from 1fef5341 on 1.0.0')
    expect(buildFactSummary(buildFactOf({ ...fact, kind: 'release', version: '1.0.0', by: 'release' }) as never)).toBe('Uploaded a draft of Hive 1.0.0 (release) from 1fef5341 on 1.0.0')
  })

  it("reads the installer's path from dist's lines", () => {
    expect(script.installerOf(['Installer: D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0.exe (copied from this worktree, which keeps its own)'])).toBe('D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf(['Not copied to the main checkout: no.', 'Installer: C:\\wt\\dist\\Hive-Setup-1.0.0.exe (this worktree). Run again with --replace to copy it over anyway.'])).toBe('C:\\wt\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf(['Installer: C:\\wt\\dist\\Hive-Setup-1.0.0.exe'])).toBe('C:\\wt\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf([])).toBeNull()
  })
})

describe('the scripts tell Hive of a build', () => {
  const ws = join(base, 'scripts-ws')
  const repo = join(ws, 'hive')
  const markers = (): string[] => (existsSync(join(ws, '.hive', 'builds')) ? readdirSync(join(ws, '.hive', 'builds')) : [])
  const env = { HIVE_WORKSPACE: ws }
  beforeAll(() => {
    mkdirSync(join(ws, '.hive'), { recursive: true })
    writeFileSync(join(ws, '.hive', 'workspace.json'), '{}')
    mkdirSync(join(repo, 'dist'), { recursive: true })
  })
  const input = { root: repo, version: '1.0.0-rc.1', commit: fact.commit, branch: '1.0.0', installer: fact.installer, builtAt: fact.builtAt, by: 'dist', kind: 'baseline' }

  it('through the Agent API while Hive answers, leaving no marker', async () => {
    const sent: unknown[] = []
    const post = async (f: unknown, to: unknown) => (sent.push({ f, to }), { recorded: true })
    expect(await script.recordBuild(input, { env: { ...env, HIVE_API_URL: 'http://127.0.0.1:1', HIVE_API_TOKEN: 't' }, post })).toBe("Build recorded in Hive's journal (baseline).")
    expect(sent).toEqual([{ f: fact, to: { url: 'http://127.0.0.1:1', token: 't', workspace: ws } }])
    expect(markers()).toEqual([])
    // Hive answered but didn't write it (the switch or the journal off): said, and no marker either.
    expect(await script.recordBuild(input, { env: { ...env, HIVE_API_URL: 'http://127.0.0.1:1', HIVE_API_TOKEN: 't' }, post: async () => ({ recorded: false, reason: 'off.' }) })).toBe("Build not recorded in Hive's journal: off.")
    expect(markers()).toEqual([])
  })

  it("by a marker when Hive can't be reached, or no API is named", async () => {
    expect(await script.recordBuild(input, { env: { ...env, HIVE_API_URL: 'http://127.0.0.1:1', HIVE_API_TOKEN: 't' }, post: async () => null })).toMatch(/^Build left for Hive's journal \(baseline\)/)
    expect(await script.recordBuild(input, { env })).toMatch(/^Build left for Hive's journal/)
    const left = markers()
    expect(left).toHaveLength(2)
    expect(left.every((n) => n.endsWith('.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(ws, '.hive', 'builds', left[0]), 'utf8'))).toEqual(fact)
  })

  it('after dist: only a build with its build-info.json (a successful one) is recorded', async () => {
    const before = markers().length
    // A failed or unlabelled build leaves no build-info.json (makeDist removes it first): nothing is recorded.
    expect(await script.recordDist({ root: repo, lines: ['Installer: x.exe'] }, { env })).toBeNull()
    expect(markers()).toHaveLength(before)
    writeFileSync(join(repo, 'dist', 'build-info.json'), JSON.stringify({ version: '1.0.0-rc.1', head: fact.commit, branch: '1.0.0', builtAt: fact.builtAt }))
    expect(await script.recordDist({ root: repo, lines: [`Installer: ${fact.installer} (copied from this worktree, which keeps its own)`], kind: 'baseline' }, { env })).toMatch(/^Build left/)
    expect(markers()).toHaveLength(before + 1)
  })

  it('says so when no workspace holds the checkout', async () => {
    const lone = tempDir('hive-build-facts-lone-')
    expect(await script.recordBuild({ ...input, root: lone }, { env: {} })).toBe("Build not recorded in Hive's journal: no Hive workspace holds this checkout (HIVE_WORKSPACE names one).")
  })
})

describe('Hive records a build in the journal', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const dir = join(wsPath, '.hive', 'builds')
  const leave = (name: string, body: unknown): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  const facts = (): { summary: string; tags?: string[] }[] => (existsSync(journal.journalFile(w.assistantHome)) ? journal.recall(w.assistantHome, { limit: 50 }).filter((r) => r.source === 'hive') : [])
  beforeAll(async () => {
    advanced.load(join(base, 'profile'))
    mkdirSync(join(wsPath, 'alpha', '.hive'), { recursive: true })
    writeFileSync(join(wsPath, 'alpha', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => {
    await advanced.set(JOURNAL_BUILDS, null)
    advanced.stop()
    await disposeWorkspaceService(w)
  })

  it('as its own fact, from the API', () => {
    expect(builds.recordBuild(w, buildFactOf(fact) as never)).toEqual({ recorded: true })
    expect(facts().map((f) => f.summary)).toEqual(['Built Hive 1.0.0-rc.1 (baseline) from 1fef5341 on 1.0.0'])
  })

  it('picks a marker up once, and drops one that is not a build', async () => {
    leave('2026-10-24T11-01-00-000Z-aa.json', { ...fact, version: '1.0.0-rc.2' })
    leave('2026-10-24T11-02-00-000Z-bb.json', '{ not json')
    leave('2026-10-24T11-03-00-000Z-cc.json', { ...fact, kind: 'nightly' })
    leave('2026-10-24T11-04-00-000Z-dd.tmp', { ...fact, version: 'half-written' })
    expect(await builds.pickUpBuilds(w)).toBe(1)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.2'))).toHaveLength(1)
    // The .json markers are gone; one being written (.tmp) is left for its writer.
    expect(readdirSync(dir)).toEqual(['2026-10-24T11-04-00-000Z-dd.tmp'])
    expect(await builds.pickUpBuilds(w)).toBe(0)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.2'))).toHaveLength(1)
  })

  it('writes nothing with the switch off, and drops what was left meanwhile', async () => {
    await advanced.set(JOURNAL_BUILDS, false)
    const n = facts().length
    expect(builds.recordBuild(w, buildFactOf({ ...fact, version: '1.0.0-rc.3' }) as never)).toEqual({ recorded: false, reason: 'Settings → Advanced → Record builds in the journal is off.' })
    leave('2026-10-24T11-05-00-000Z-ee.json', { ...fact, version: '1.0.0-rc.4' })
    expect(await builds.pickUpBuilds(w)).toBe(0)
    expect(existsSync(join(dir, '2026-10-24T11-05-00-000Z-ee.json'))).toBe(false)
    // Switched on again, the dropped build doesn't come back.
    await advanced.set(JOURNAL_BUILDS, null)
    expect(await builds.pickUpBuilds(w)).toBe(0)
    expect(facts()).toHaveLength(n)
  })

  it('writes nothing while the journal is off, or its scope has no events', async () => {
    await service.setJournalSettings(w, { enabled: false })
    expect(builds.recordBuild(w, buildFactOf(fact) as never)).toEqual({ recorded: false, reason: expect.stringMatching(/^The journal is off, or its scope/) })
    await service.setJournalSettings(w, { enabled: true, scope: ['decision'] })
    expect(builds.recordBuild(w, buildFactOf(fact) as never).recorded).toBe(false)
    await service.setJournalSettings(w, { scope: ['decision', 'plan', 'event', 'incident', 'insight'] })
    expect(builds.recordBuild(w, buildFactOf(fact) as never).recorded).toBe(true)
  })
})
