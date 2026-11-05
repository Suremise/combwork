// What a progress run ran for (#1220, SPEC §16.13): the card, revision and check hive-progress and /v1/progress name,
// or their defaults (the agent's card in Doing, the folder's head), checked before the command runs. Real git in
// throwaway repositories for the head; the board and the project's options are stand-ins.
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { admitLinked, commitIn, folderHead, IssuedLinks, LINK_TTL_MS, linkOwner, MAX_LINKS, publicLink, resolveRunLink, type RunLinkDeps } from '../src/main/workflow/runLink'
import { keptRuns, ProgressStore, type ProgressCaller } from '../src/main/progress'
import { publicRun } from '../src/main/apiEvents'
import { runDetails, shortRevision } from '../src/shared/progress'
import { preset } from '../src/shared/workflow/options'
import { reconcile } from '../src/main/workflow/reconcile'
import { B1, B2, commit, moved, put, setup, sh, type Env } from './workflow/harness'
import { setLanguage, tr } from '../src/shared/i18n'
import type { ProgressRun, TaskColumn } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-runlink-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0

/** A repository with one commit, and a second when `two`; `run` is git there. */
function repo(two = false): { dir: string; run: (...a: string[]) => string; head: () => string } {
  const dir = join(base, `r${++n}`)
  const run = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  run('add', '-A')
  run('commit', '-qm', 'one')
  if (two) {
    writeFileSync(join(dir, 'a.txt'), 'b\n')
    run('commit', '-qam', 'two')
  }
  return { dir, run, head: () => run('rev-parse', 'HEAD') }
}

const PROJECT = join(base, 'hive')
const agent: ProgressCaller = { source: 'agent', workspacePath: base, projectPath: PROJECT, agentId: 'b1', agentName: 'B1', provider: null }
const script: ProgressCaller = { source: 'api', workspacePath: base }

/** The board and the options as a stand-in: cards by number, an agent's Doing cards, the check commands per project. */
function deps(o: { cards?: Record<number, { project: string; column?: TaskColumn; agent?: string | null }>; doing?: number[]; commands?: Record<string, Record<string, string>>; keys?: Record<string, number>; cardRun?: RunLinkDeps['cardRun'] } = {}): RunLinkDeps {
  return {
    card: async (num) => {
      const c = o.cards?.[num]
      return c ? { project: c.project, column: c.column ?? 'doing', agent: c.agent ?? null } : null
    },
    doing: async () => o.doing ?? [],
    // No card with a start in its facts, unless a test gives its adapter's reads (#1233).
    cardRun: o.cardRun ?? (async () => null),
    head: folderHead,
    commitOf: commitIn,
    projectName: (p) => p.split(/[\\/]/).pop()!,
    // A key's card, only within the scope given (as the board's cardOfRef: another project's is none).
    keyCard: (key, scope) => {
      const card = o.keys?.[key.toUpperCase()]
      return card !== undefined && (scope === null || o.cards?.[card]?.project.toLowerCase() === scope.toLowerCase()) ? card : null
    },
    checkCommand: async (project, name) => o.commands?.[project]?.[name] ?? null
  }
}

describe("a run's card, revision and check (#1220)", () => {
  it("defaults to the agent's one card in Doing and the folder's head", async () => {
    const r = repo()
    const link = await resolveRunLink(agent, { folder: r.dir }, deps({ doing: [1061] }))
    expect(link).toEqual({ card: 1061, revision: r.head(), testedCheckout: r.head(), check: null, folder: r.dir })
    expect(publicLink(link, 'L1')).toMatchObject({ link: 'L1', card: '#1061', revision: r.head() })
  })

  it('names no card by default when the agent has none in Doing, or several (a run for the wrong card is worse than none)', async () => {
    const r = repo()
    expect((await resolveRunLink(agent, { folder: r.dir }, deps({ doing: [] }))).card).toBeNull()
    expect((await resolveRunLink(agent, { folder: r.dir }, deps({ doing: [12, 13] }))).card).toBeNull()
    // card: null says the run is for no card: nothing is defaulted.
    expect((await resolveRunLink(agent, { folder: r.dir, card: null }, deps({ doing: [12] }))).card).toBeNull()
    // A script has no card of its own.
    expect((await resolveRunLink(script, { folder: r.dir }, deps({ doing: [12] }))).card).toBeNull()
  })

  it('takes a card named as #N, of the caller\'s own project for an agent, and refuses a plain number or a key with the form to use', async () => {
    const d = deps({ cards: { 12: { project: 'hive' }, 40: { project: 'website' } } })
    expect((await resolveRunLink(agent, { card: '#12' }, d)).card).toBe(12)
    // Another project's card is unknown to an agent, as an unknown one is; a script may name any.
    await expect(resolveRunLink(agent, { card: '#40' }, d)).rejects.toThrow('Unknown card #40')
    await expect(resolveRunLink(agent, { card: '#41' }, d)).rejects.toThrow('Unknown card #41')
    expect((await resolveRunLink(script, { card: '#40' }, d)).card).toBe(40)
    await expect(resolveRunLink(agent, { card: '12' }, d)).rejects.toThrow(/a plain number isn't taken/)
    await expect(resolveRunLink(agent, { card: 12 }, d)).rejects.toThrow(/a plain number isn't taken/)
    // Keys (#1219): its own project's, any case; another project's, or one nobody has, as unknown, in the words it used.
    const k = deps({ cards: { 12: { project: 'hive' }, 40: { project: 'website' } }, keys: { 'HI-12': 12, 'WE-1': 40 } })
    expect((await resolveRunLink(agent, { card: 'hi-12' }, k)).card).toBe(12)
    await expect(resolveRunLink(agent, { card: 'WE-1' }, k)).rejects.toThrow('Unknown card WE-1')
    await expect(resolveRunLink(agent, { card: 'HI-99' }, k)).rejects.toThrow('Unknown card HI-99')
    expect((await resolveRunLink(script, { card: 'WE-1' }, k)).card).toBe(40)
  })

  it('takes a revision that is what is checked out (by id, short id or name) and refuses one that is not, before anything runs', async () => {
    const r = repo(true)
    const head = r.head()
    const before = r.run('rev-parse', 'HEAD~1')
    expect((await resolveRunLink(agent, { folder: r.dir, revision: head.slice(0, 7) }, deps())).revision).toBe(head)
    expect((await resolveRunLink(agent, { folder: r.dir, revision: 'main' }, deps())).revision).toBe(head)
    await expect(resolveRunLink(agent, { folder: r.dir, revision: before.slice(0, 7) }, deps())).rejects.toThrow(`${before.slice(0, 7)} isn't what's checked out here (${head.slice(0, 7)} is)`)
    await expect(resolveRunLink(agent, { folder: r.dir, revision: 'nonesuch' }, deps())).rejects.toThrow("nonesuch isn't a commit in")
    // An option is never passed to git as a revision.
    await expect(resolveRunLink(agent, { folder: r.dir, revision: '--all' }, deps())).rejects.toThrow('revision is a commit')
    // A revision needs the folder to compare with, and something checked out there.
    await expect(resolveRunLink(agent, { revision: head }, deps())).rejects.toThrow('give folder too')
    const plain = join(base, `plain${++n}`)
    mkdirSync(plain)
    await expect(resolveRunLink(agent, { folder: plain, revision: head }, deps())).rejects.toThrow('Nothing is checked out')
  })

  it('a folder with nothing checked out has no revision', async () => {
    const plain = join(base, `plain${++n}`)
    mkdirSync(plain)
    expect(await resolveRunLink(agent, { folder: plain }, deps())).toMatchObject({ revision: null, testedCheckout: null, folder: plain })
    await expect(resolveRunLink(agent, { folder: 'relative/path' }, deps())).rejects.toThrow('folder is the absolute path')
  })

  it("what is checked out is always read, never taken from the request (round 1's finding 1)", async () => {
    // An older commit named as both revision and testedCheckout: the checkout is read, and the older one refused.
    const r = repo(true)
    const head = r.head()
    const before = r.run('rev-parse', 'HEAD~1')
    let reads = 0
    const d = { ...deps(), head: (f: string) => (reads++, folderHead(f)) }
    await expect(resolveRunLink(agent, { folder: r.dir, revision: before, testedCheckout: before } as Record<string, unknown>, d)).rejects.toThrow(`isn't what's checked out here (${head.slice(0, 7)} is)`)
    expect(reads).toBe(1)
    expect(await resolveRunLink(agent, { folder: r.dir, testedCheckout: before } as Record<string, unknown>, d)).toMatchObject({ revision: head, testedCheckout: head })
  })

  it("--check runs the project's configured command for the name, and says so when there is none", async () => {
    const d = deps({ cards: { 40: { project: 'website' } }, commands: { hive: { typecheck: 'npm run typecheck' }, website: { test: 'npm test' } } })
    expect((await resolveRunLink(agent, { check: 'typecheck' }, d)).check).toEqual({ name: 'typecheck', command: 'npm run typecheck' })
    await expect(resolveRunLink(agent, { check: 'lint' }, d)).rejects.toThrow('hive has no command configured for the check "lint", so nothing was run')
    await expect(resolveRunLink(agent, { check: 'npm run lint' }, d)).rejects.toThrow("check is the name of one of the project's checks")
    // A script's check is its card's project's; with no card, there's no project to ask.
    expect((await resolveRunLink(script, { check: 'test', card: '#40' }, d)).check).toEqual({ name: 'test', command: 'npm test' })
    await expect(resolveRunLink(script, { check: 'test' }, d)).rejects.toThrow('name the card too')
    // A focused test's check (HI-1367): any test id, no configured command (the one after -- runs).
    expect((await resolveRunLink(agent, { check: 'focused:tests/a b.test.ts' }, d)).check).toEqual({ name: 'focused:tests/a b.test.ts', command: '' })
    await expect(resolveRunLink(agent, { check: 'focused:' }, d)).rejects.toThrow('"focused:<test>"')
  })
})

// #1233: a card with a start in its facts has its run read through its platform's adapter (the workflow harness's real
// Git and None adapters), never by switching on a platform id; a card with none is read with git, as above.
describe("a card's run through its platform adapter (#1233)", () => {
  let env: Env | null = null
  afterEach(() => {
    env?.close()
    env = null
  })
  /** deps whose card `num` is the harness's card, read through the adapter its ruleset names. */
  const through = (e: Env, num: number): RunLinkDeps =>
    deps({
      cards: { [num]: { project: 'hive' } },
      cardRun: async (c, folder, named) => {
        const card = e.wf.store.card(c)
        return e.wf.platformOf(card).runRevision(card, e.wf.state(card), folder, named)
      }
    })

  it("Git, its own line: the card's revision is its folder's head; a run elsewhere keeps the two apart; a named one must be what's checked out", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const card = e.wf.createCard({ title: 'Own line' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const head = commit(folder, { 'c.txt': 'c\n' }, 'c')
    const d = through(e, card.id)
    expect(await resolveRunLink(agent, { folder, card: `#${card.id}` }, d)).toMatchObject({ card: card.id, revision: head, testedCheckout: head })
    // Run in the project's checkout (a reviewer's, say): tested on what's there, for the card's revision.
    const main = sh(e.project, 'rev-parse', 'HEAD')
    expect(await resolveRunLink(agent, { folder: e.project, card: `#${card.id}` }, d)).toMatchObject({ revision: head, testedCheckout: main })
    expect((await resolveRunLink(agent, { folder, card: `#${card.id}`, revision: head.slice(0, 7) }, d)).revision).toBe(head)
    await expect(resolveRunLink(agent, { folder, card: `#${card.id}`, revision: main.slice(0, 7) }, d)).rejects.toThrow(`${main.slice(0, 7)} isn't what's checked out here (${head.slice(0, 7)} is)`)
    await expect(resolveRunLink(agent, { folder, card: `#${card.id}`, revision: 'nonesuch' }, d)).rejects.toThrow("nonesuch isn't a commit in")
  })

  it("Git, a shared folder: the card's revision is its newest attributed commit, not the folder's head", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const a = e.wf.createCard({ title: 'A' })
    const b = e.wf.createCard({ title: 'B' })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const a1 = commit(e.project, { 'a1.txt': 'a\n' }, 'a1', { trailer: a.key })
    const b1 = commit(e.project, { 'b1.txt': 'b\n' }, 'b1', { trailer: b.key })
    await reconcile(e.wf, a)
    expect(await resolveRunLink(agent, { folder: e.project, card: `#${a.id}` }, through(e, a.id))).toMatchObject({ revision: a1, testedCheckout: b1 })
  })

  it("None: the card's revision is its declared paths' hash, which is also what it's tested on; a named one must be that hash", async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files: { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' } }))
    const card = e.wf.createCard({ title: 'Docs A', paths: ['docs/a.md'] })
    moved(await e.wf.start(card.key, B1))
    const d = through(e, card.id)
    const first = await resolveRunLink(agent, { folder: e.project, card: `#${card.id}` }, d)
    expect(first.revision).toEqual(expect.any(String))
    expect(first.testedCheckout).toBe(first.revision)
    // No git anywhere: a name is checked against the hash, not as a commit.
    expect((await resolveRunLink(agent, { folder: e.project, card: `#${card.id}`, revision: first.revision! }, d)).revision).toBe(first.revision)
    await expect(resolveRunLink(agent, { folder: e.project, card: `#${card.id}`, revision: 'abc1234' }, d)).rejects.toThrow(`abc1234 isn't #${card.id}'s revision now (its paths hash to ${shortRevision(first.revision!)})`)
    // Its paths edited: a new revision; another file: the same.
    put(e.project, 'docs/b.md', 'b, edited\n')
    expect((await resolveRunLink(agent, { folder: e.project, card: `#${card.id}` }, d)).revision).toBe(first.revision)
    put(e.project, 'docs/a.md', 'a, edited\n')
    expect((await resolveRunLink(agent, { folder: e.project, card: `#${card.id}` }, d)).revision).not.toBe(first.revision)
  })
})

describe("links resolve gives out, for the run's start (round 1's finding 1)", () => {
  const link = { card: 12, revision: 'd'.repeat(40), testedCheckout: 'd'.repeat(40), check: null, folder: PROJECT }

  it("a start gets what was resolved (the checkout before the command ran) once, and only its own caller's", () => {
    const links = new IssuedLinks()
    const id = links.issue(linkOwner(agent), link)
    expect(links.take(linkOwner(script), id)).toBeNull()
    expect(links.take(linkOwner({ ...agent, agentId: 'r1' }), id)).toBeNull()
    expect(links.take(linkOwner(agent), id)).toEqual(link)
    expect(links.take(linkOwner(agent), id)).toBeNull()
    expect(links.take(linkOwner(agent), 'made-up')).toBeNull()
    expect(links.take(linkOwner(agent), undefined)).toBeNull()
  })

  it('a link waits LINK_TTL_MS for its start, and at most MAX_LINKS are kept (the oldest go)', () => {
    let now = 0
    const links = new IssuedLinks(() => now)
    const old = links.issue(linkOwner(agent), link)
    now = LINK_TTL_MS + 1
    expect(links.take(linkOwner(agent), old)).toBeNull()
    const first = links.issue(linkOwner(agent), link)
    const rest = Array.from({ length: MAX_LINKS }, () => links.issue(linkOwner(agent), link))
    expect(links.take(linkOwner(agent), first)).toBeNull()
    expect(links.take(linkOwner(agent), rest[rest.length - 1])).toEqual(link)
  })
})

describe("a start's link is looked up inside its admission (round 2's finding)", () => {
  const link = { card: 12, revision: null, testedCheckout: null, check: null, folder: null }
  const IGNORED: { id?: string; ignored?: boolean } = { ignored: true }

  /** A gate the test turns off and on, a link lookup it finishes when it chooses, and the starts made. */
  function rig() {
    let on = true
    let generation = 0
    let release!: () => void
    const ready = new Promise<void>((r) => (release = r))
    const starts: unknown[] = []
    let lookups = 0
    let closed = false
    const admit = () =>
      admitLinked(
        { on: () => on, generation: () => generation },
        IGNORED,
        {
          caller: async () => agent,
          link: async () => (lookups++, await ready, link),
          settled: () => {
            if (closed) throw new Error('The workspace was closed')
          }
        },
        (caller, l) => (starts.push({ caller, l }), { id: 'started' })
      )
    return { admit, release, starts, lookups: () => lookups, toggle: (v: boolean) => ((on = v), generation++), close: () => (closed = true) }
  }

  it('a panel turned off, or off and on, while the link is looked up ignores the start', async () => {
    for (const toggles of [[false], [false, true]]) {
      const r = rig()
      const reply = r.admit()
      for (const v of toggles) r.toggle(v)
      r.release()
      expect(await reply).toBe(IGNORED)
      expect(r.starts).toEqual([])
    }
  })

  it('with the panel off from the start, nothing is looked up; a workspace closed meanwhile gets no run; otherwise it starts with its link', async () => {
    const off = rig()
    off.toggle(false)
    expect(await off.admit()).toBe(IGNORED)
    expect(off.lookups()).toBe(0)

    const closing = rig()
    const reply = closing.admit()
    closing.close()
    closing.release()
    await expect(reply).rejects.toThrow('The workspace was closed')
    expect(closing.starts).toEqual([])

    const fine = rig()
    fine.release()
    expect(await fine.admit()).toEqual({ id: 'started' })
    expect(fine.starts).toEqual([{ caller: agent, l: link }])
  })
})

describe('runs keep what they ran for (#1220)', () => {
  const store = (): ProgressStore => new ProgressStore({ now: () => 1000, changed: () => {}, ownerRunning: () => true })
  const id = 'b'.repeat(40)

  it('a run started for a card has it, and an old report (no link) is unchanged', () => {
    const s = store()
    const linked = s.start(agent, { title: 'unit tests' }, { card: 1061, revision: id, testedCheckout: id, check: 'test', folder: PROJECT })
    expect(linked).toMatchObject({ card: 1061, revision: id, testedCheckout: id, check: 'test', folder: PROJECT })
    expect(publicRun(linked)).toMatchObject({ card: '#1061', revision: id, testedCheckout: id, check: 'test' })
    // Its folder stays in Combwork, as the log's path does.
    expect(publicRun(linked)).not.toHaveProperty('folder')
    const old = s.start(agent, { title: 'e2e' })
    for (const k of ['card', 'revision', 'testedCheckout', 'check', 'folder']) {
      expect(old).not.toHaveProperty(k)
      expect(publicRun(old)).not.toHaveProperty(k)
    }
  })

  it('Recent keeps them across a restart, checked like the rest of the file', () => {
    const s = store()
    const run = s.start(agent, { title: 'unit tests' }, { card: 1061, revision: id, testedCheckout: id, check: 'test', folder: PROJECT })
    s.finish(agent, run.id, { ok: true })
    const [kept] = keptRuns({ runs: s.list(base) }, base)
    expect(kept).toMatchObject({ card: 1061, revision: id, check: 'test', folder: PROJECT })
    const [damaged] = keptRuns({ runs: [{ ...s.list(base)[0], card: 'x', revision: 'nope', check: 'rm -rf /' }] }, base)
    expect(damaged).not.toHaveProperty('card')
    expect(damaged).not.toHaveProperty('revision')
    expect(damaged).not.toHaveProperty('check')
  })

  it("its details show the card and the whole revision", () => {
    setLanguage('en', {})
    const s = store()
    const run: ProgressRun = s.start(agent, { title: 'unit tests' }, { card: 1061, revision: id })
    const rows = runDetails(run, 'hive', 2000, tr)
    expect(rows).toContainEqual({ label: 'Card', text: '#1061' })
    expect(rows).toContainEqual({ label: 'Revision', text: id, code: true })
    expect(runDetails(s.start(agent, { title: 'e2e' }), 'hive', 2000, tr).map((d) => d.label)).not.toContain('Card')
  })

  // #1446: the folder it ran in is the run's own, kept as it ran, whatever its agent works in now.
  it('its details show the folder it ran in, not where its agent is now', () => {
    setLanguage('en', {})
    const s = store()
    const slotB = join(PROJECT, '..', 'slot-b')
    const r: ProgressRun = s.start(agent, { title: 'unit tests' }, { card: 1061, folder: slotB })
    // Its agent moved on to another slot since: the run's record keeps where it ran.
    expect(runDetails(r, 'hive', 2000, tr)).toContainEqual({ label: 'Folder', text: slotB, code: true })
    expect(runDetails(s.start(agent, { title: 'e2e' }), 'hive', 2000, tr).map((d) => d.label)).not.toContain('Folder')
  })

  // #1273: what it was tested on, beside the card's revision, only when they differ.
  it('its details show what it was tested on when that is not the card\'s revision', () => {
    setLanguage('en', {})
    const s = store()
    const run: ProgressRun = s.start(agent, { title: 'unit tests' }, { card: 1061 })
    const same = runDetails({ ...run, revision: id, testedCheckout: id }, 'hive', 2000, tr)
    expect(same.map((d) => d.label)).not.toContain('Tested on')
    const other = 'c'.repeat(40)
    // With the folder it ran in (#1446) too: Tested on still follows the Revision it qualifies (#1554), the folder after it.
    const rows = runDetails({ ...run, revision: id, testedCheckout: other, folder: 'D:\\work\\older' }, 'hive', 2000, tr)
    expect(rows).toContainEqual({ label: 'Revision', text: id, code: true })
    expect(rows).toContainEqual({ label: 'Tested on', text: other, code: true })
    const labels = rows.map((d) => d.label)
    expect(labels.indexOf('Tested on')).toBe(labels.indexOf('Revision') + 1)
    expect(labels.indexOf('Folder')).toBe(labels.indexOf('Tested on') + 1)
  })
})
