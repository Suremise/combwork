// Builds recorded as facts (#1534, #1062): npm run dist and npm run release tell Combwork of each successful build
// (scripts/buildFact.mjs), through the Agent API when Combwork answers, else by a marker in the workspace's .combwork/builds;
// Combwork writes it into the journal as its own entry, once, while Settings → Advanced → Record builds in the journal and
// the journal take it (src/main/buildFacts.ts). A failed build records nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { BUILD_KINDS, buildFactDetail, buildFactOf, buildFactSummary, parseBuildDetail, parseBuildSummary } from '../src/shared/buildFacts'
import { setLanguage } from '../src/shared/i18n'
import { journalBuildDetail, journalSummary } from '../src/renderer/src/components/journalBuilds'
import { JOURNAL_BUILDS } from '../src/shared/advanced'
// @ts-expect-error: a plain .mjs module without types
import * as script from '../scripts/buildFact.mjs'

// A marker's read held until the test lets it go (#1534 round 1, finding 1: a workspace switch while a pickup reads).
const held: { gate: Promise<void> | null; reached: boolean } = { gate: null, reached: false }
vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  const readFile = (async (file: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
    if (held.gate && String(file).endsWith('.taking')) {
      held.reached = true
      await held.gate
    }
    return (real.readFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
  }) as typeof real.readFile
  return { ...real, readFile, default: { ...real, readFile } }
})

const base = tempDir('hive-build-facts-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const journal = await import('../src/main/journal')
const service = await import('../src/main/journalService')
const builds = await import('../src/main/buildFacts')
const { advanced } = await import('../src/main/advanced')

vi.setConfig({ testTimeout: 30_000 })
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000

const fact = { kind: 'baseline', version: '1.0.0-rc.1', commit: '1fef5341a2b3c4d5e6f708192a3b4c5d6e7f8091', branch: '1.0.0', installer: 'D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0-rc.1.exe', builtAt: '2026-10-24T11:00:00.000Z', by: 'dist' }

describe('a build fact', () => {
  it('has the same kinds in the scripts and in Combwork', () => {
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

  it('reads its line and detail back, for the window', () => {
    const f = buildFactOf(fact) as Exclude<ReturnType<typeof buildFactOf>, { error: string }>
    expect(parseBuildSummary(buildFactSummary(f))).toEqual({ by: 'dist', version: '1.0.0-rc.1', kind: 'baseline', commit: '1fef5341', branch: '1.0.0' })
    expect(parseBuildSummary(buildFactSummary({ ...f, kind: 'rc', branch: null, by: 'release' }))).toEqual({ by: 'release', version: '1.0.0-rc.1', kind: 'rc', commit: '1fef5341', branch: null })
    expect(parseBuildSummary('#12 "Ship it" is Done (merged), moved there by B1')).toBeNull()
    expect(parseBuildDetail(buildFactDetail(f))).toEqual({ installer: f.installer, builtAt: f.builtAt, uploaded: false })
    expect(parseBuildDetail(buildFactDetail({ ...f, by: 'release' }))?.uploaded).toBe(true)
    expect(parseBuildDetail('Some other detail')).toBeNull()
  })

  // #1534 round 1, finding 4: the window shows a build's line in the user's language (stored and recalled in English).
  it("shows a build's line and detail in every language, and any other entry as written", () => {
    const f = buildFactOf({ ...fact, by: 'release', kind: 'rc' }) as Exclude<ReturnType<typeof buildFactOf>, { error: string }>
    const e = { source: 'hive' as const, summary: buildFactSummary(f), detail: buildFactDetail(f) }
    // Stored in English as agents read it ("Hive", until HI-2463); the window says the app's name (HI-2458).
    expect(journalSummary(e)).toBe(e.summary.replace(' Hive ', ' Combwork '))
    expect(journalSummary({ ...e, source: 'assistant' })).toBe(e.summary)
    expect(journalBuildDetail({ ...e, source: 'assistant' })).toBeNull()
    expect(journalBuildDetail(e)?.[0]).toBe(`Installer: ${fact.installer}`)
    const LOCALES = join(__dirname, '..', 'locales')
    try {
      for (const code of readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'en' && !d.name.startsWith('.')).map((d) => d.name)) {
        const dir = join(LOCALES, code)
        setLanguage(code, Object.assign({}, ...readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))))
        const shown = journalSummary(e)
        expect(shown, code).not.toBe(e.summary)
        for (const part of ['1.0.0-rc.1', '1fef5341', '1.0.0']) expect(shown, code).toContain(part)
        const lines = journalBuildDetail(e)!
        expect(lines, code).toHaveLength(3)
        expect(lines[0], code).toContain(fact.installer)
        expect(lines[1], code).not.toMatch(/^Built:/)
        expect(lines[2], code).not.toBe('Uploaded to a draft GitHub release (npm run release).')
        expect(lines[2], code).toContain('npm run release')
      }
    } finally {
      setLanguage('en', {})
    }
  })

  it("reads the installer's path from dist's lines", () => {
    expect(script.installerOf(['Installer: D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0.exe (copied from this worktree, which keeps its own)'])).toBe('D:\\HIVE\\hive\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf(['Not copied to the main checkout: no.', 'Installer: C:\\wt\\dist\\Hive-Setup-1.0.0.exe (this worktree). Run again with --replace to copy it over anyway.'])).toBe('C:\\wt\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf(['Installer: C:\\wt\\dist\\Hive-Setup-1.0.0.exe'])).toBe('C:\\wt\\dist\\Hive-Setup-1.0.0.exe')
    expect(script.installerOf([])).toBeNull()
  })
})

describe('the scripts tell Combwork of a build', () => {
  const ws = join(base, 'scripts-ws')
  const repo = join(ws, 'hive')
  const markers = (): string[] => (existsSync(join(ws, '.combwork', 'builds')) ? readdirSync(join(ws, '.combwork', 'builds')) : [])
  const env = { CW_WORKSPACE: ws }
  // The session's token in its file (HI-2262: never HIVE_API_TOKEN).
  const tokenFile = join(base, 'agent-token.json')
  writeFileSync(tokenFile, JSON.stringify({ token: 't' }))
  beforeAll(() => {
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'workspace.json'), '{}')
    mkdirSync(join(repo, 'dist'), { recursive: true })
  })
  const input = { root: repo, version: '1.0.0-rc.1', commit: fact.commit, branch: '1.0.0', installer: fact.installer, builtAt: fact.builtAt, by: 'dist', kind: 'baseline' }

  it('through the Agent API while Combwork answers, leaving no marker', async () => {
    const sent: unknown[] = []
    const post = async (f: unknown, to: unknown) => (sent.push({ f, to }), { recorded: true })
    expect(await script.recordBuild(input, { env: { ...env, CW_API_URL: 'http://127.0.0.1:1', CW_API_TOKEN_FILE: tokenFile }, post })).toBe("Build recorded in Combwork's journal (baseline).")
    expect(sent).toEqual([{ f: fact, to: { url: 'http://127.0.0.1:1', token: 't', workspace: ws } }])
    expect(markers()).toEqual([])
    // Combwork answered but didn't write it (the switch or the journal off): said, and no marker either.
    expect(await script.recordBuild(input, { env: { ...env, CW_API_URL: 'http://127.0.0.1:1', CW_API_TOKEN_FILE: tokenFile }, post: async () => ({ recorded: false, reason: 'off.' }) })).toBe("Build not recorded in Combwork's journal: off.")
    expect(markers()).toEqual([])
  })

  it('never with HIVE_API_TOKEN alone (HI-2262: sessions get only its file): nothing is posted', async () => {
    const sent: unknown[] = []
    const post = async (f: unknown, to: unknown) => (sent.push({ f, to }), { recorded: true })
    const was = new Set(markers())
    expect(await script.recordBuild(input, { env: { ...env, CW_API_URL: 'http://127.0.0.1:1', HIVE_API_TOKEN: 't' }, post })).toMatch(/^Build left for Combwork's journal/)
    expect(sent).toEqual([])
    // Left as a marker, as with no API named; taken away again so the next test counts its own.
    const left = markers().filter((m) => !was.has(m))
    expect(left).toHaveLength(1)
    for (const m of left) rmSync(join(ws, '.combwork', 'builds', m))
  })

  it("by a marker when Combwork can't be reached, or no API is named", async () => {
    expect(await script.recordBuild(input, { env: { ...env, CW_API_URL: 'http://127.0.0.1:1', CW_API_TOKEN_FILE: tokenFile }, post: async () => null })).toMatch(/^Build left for Combwork's journal \(baseline\)/)
    expect(await script.recordBuild(input, { env })).toMatch(/^Build left for Combwork's journal/)
    const left = markers()
    expect(left).toHaveLength(2)
    expect(left.every((n) => n.endsWith('.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(ws, '.combwork', 'builds', left[0]), 'utf8'))).toEqual(fact)
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

  // #1534 round 1, finding 2: a reply cut off once it had started left postBuild pending for good, and the script ended
  // with an unsettled await after a good build. Every ending settles it (null), and the build is left as a marker.
  it('a reply cut off settles as no reply, and the build is left as a marker', async () => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' })
        res.write('{"recorded": tr')
        res.socket?.destroy()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const api = { ...env, CW_API_URL: url, CW_API_TOKEN_FILE: tokenFile }
    try {
      expect(await script.postBuild(fact, { url, token: 't', workspace: ws })).toBeNull()
      const before = markers().length
      expect(await script.recordBuild(input, { env: api })).toMatch(/^Build left for Combwork's journal \(baseline\)/)
      expect(markers()).toHaveLength(before + 1)
      // A post that throws, or rejects, is no reply either.
      const throws = (): never => {
        throw new Error('boom')
      }
      expect(await script.recordBuild(input, { env: api, post: throws })).toMatch(/^Build left/)
      expect(await script.recordBuild(input, { env: api, post: async () => throws() })).toMatch(/^Build left/)
      expect(markers()).toHaveLength(before + 3)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('a server that never answers is given up on within its bound', async () => {
    // A request held open (the handler never replies): the bound under test is postBuild's own, so it is short here.
    const server = createServer((req) => req.resume())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      expect(await script.postBuild(fact, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 't', workspace: ws }, 300)).toBeNull()
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('says so when no workspace holds the checkout', async () => {
    const lone = tempDir('hive-build-facts-lone-')
    expect(await script.recordBuild({ ...input, root: lone }, { env: {} })).toBe("Build not recorded in Combwork's journal: no Combwork workspace holds this checkout (CW_WORKSPACE names one).")
  })
})

describe('Combwork records a build in the journal', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const dir = join(wsPath, '.combwork', 'builds')
  const leave = (name: string, body: unknown): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  const facts = (): { summary: string; tags?: string[] }[] => (existsSync(journal.journalFile(w.assistantHome)) ? journal.recall(w.assistantHome, { limit: 50 }).filter((r) => r.source === 'hive') : [])
  beforeAll(async () => {
    advanced.load(join(base, 'profile'))
    mkdirSync(join(wsPath, 'alpha', '.combwork'), { recursive: true })
    writeFileSync(join(wsPath, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
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
    // The same build again (a reply cut off, then its marker): one entry.
    expect(builds.recordBuild(w, buildFactOf(fact) as never)).toEqual({ recorded: true })
    expect(facts()).toHaveLength(1)
  })

  // #1534 round 2: the check found only the newest 50 builds of a commit, so an older one replayed after 51 more was
  // written again. It is exact now, in the write's own transaction, however many entries share the commit.
  it('records a build once however many later builds share its commit', () => {
    const entries = (): number => journal.journalSize(w.assistantHome)?.entries ?? 0
    const before = entries()
    const first = { ...fact, version: '1.0.0-rc.8', builtAt: '2026-10-24T08:00:00.000Z' }
    expect(builds.recordBuild(w, buildFactOf(first) as never)).toEqual({ recorded: true })
    for (let i = 1; i <= 51; i++) expect(builds.recordBuild(w, buildFactOf({ ...first, builtAt: new Date(Date.parse(first.builtAt) + i * 60_000).toISOString() }) as never)).toEqual({ recorded: true })
    expect(entries()).toBe(before + 52)
    // The first again, past 50 later builds of the same commit: still 52.
    expect(builds.recordBuild(w, buildFactOf(first) as never)).toEqual({ recorded: true })
    expect(entries()).toBe(before + 52)
  })

  it("keeps a long detail's entry once too (kept compressed)", () => {
    const long = { kind: 'event', summary: 'A fact with a long detail', detail: 'x'.repeat(5000), links: [{ type: 'commit', ref: 'abcdef1' }] }
    const settings = service.journalSettingsOf(w)
    expect(journal.writeEntryOnce(w.assistantHome, settings, long, 'hive', { type: 'commit', ref: 'abcdef1' })).toEqual(expect.any(Number))
    expect(journal.writeEntryOnce(w.assistantHome, settings, long, 'hive', { type: 'commit', ref: 'abcdef1' })).toBeNull()
    // Another detail, or by the Assistant, is another entry.
    expect(journal.writeEntryOnce(w.assistantHome, settings, { ...long, detail: 'y'.repeat(5000) }, 'hive', { type: 'commit', ref: 'abcdef1' })).toEqual(expect.any(Number))
    expect(journal.writeEntryOnce(w.assistantHome, settings, long, 'assistant', { type: 'commit', ref: 'abcdef1' })).toEqual(expect.any(Number))
  })

  // #1534 round 1, finding 3: two pickups at once (a workspace reopened while the last one's runs) took the same marker.
  it('pickups at once take a marker once', async () => {
    leave('2026-10-24T10-59-00-000Z-zz.json', { ...fact, version: '1.0.0-rc.7' })
    const got = await Promise.all([builds.pickUpBuilds(w), builds.pickUpBuilds(w), builds.pickUpBuilds(w)])
    expect(got.reduce((a, b) => a + b, 0)).toBe(1)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.7'))).toHaveLength(1)
    expect(readdirSync(dir)).toEqual([])
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
    expect(builds.recordBuild(w, buildFactOf({ ...fact, version: '1.0.0-rc.9' }) as never).recorded).toBe(true)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.9'))).toHaveLength(1)
  })

  // #1534 round 1, finding 1: the window moved to another workspace while a pickup read a marker; the fact went into the
  // other workspace's journal and the marker was gone. Now it's put back for its own workspace's next open.
  it("writes a marker only into its own workspace's journal: switched meanwhile, it's put back", async () => {
    const other = join(base, 'ws-other')
    mkdirSync(join(other, 'beta', '.combwork'), { recursive: true })
    writeFileSync(join(other, 'beta', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    leave('2026-10-24T11-06-00-000Z-ff.json', { ...fact, version: '1.0.0-rc.5' })
    let release = (): void => {}
    held.gate = new Promise<void>((resolve) => (release = resolve))
    held.reached = false
    const pickup = builds.pickUpBuilds(w)
    try {
      await vi.waitFor(() => expect(held.reached).toBe(true), { timeout: HUNG_MS })
      await w.open(other)
    } finally {
      held.gate = null
      release()
    }
    expect(await pickup).toBe(0)
    expect(readdirSync(dir).filter((n) => !n.endsWith('.tmp'))).toEqual(['2026-10-24T11-06-00-000Z-ff.json'])
    const otherFacts = existsSync(journal.journalFile(w.assistantHome)) ? journal.recall(w.assistantHome, { limit: 50 }).map((r) => r.summary) : []
    expect(otherFacts.filter((t) => t.includes('1.0.0-rc.5'))).toEqual([])
    await w.open(wsPath)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.5'))).toHaveLength(0)
    expect(await builds.pickUpBuilds(w)).toBe(1)
    expect(facts().filter((f) => f.summary.includes('1.0.0-rc.5'))).toHaveLength(1)
  })
})
