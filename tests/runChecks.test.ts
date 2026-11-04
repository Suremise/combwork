// Runs as checks (#1222, SPEC §16.13) on real temporary repositories and folders, the watcher's write log following
// them: a run counts only if it was a check, ran on the card's revision (or a later commit in a shared folder), the
// folder was clean at both ends and at the same checkout, and nothing that counts was written meanwhile. An ignored
// `out/` write still counts; an edit undone, a checkout and back, and None's edit to a declared path don't. In the app, a
// run's bracket writes its `CheckRan` in the card's facts.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { Fact } from '../src/shared/workflow/facts'

const base = tempDir('hive-run-checks-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { Observer } = await import('../src/main/platform/observe')
const { isUnknown } = await import('../src/main/platform/types')
const { checkStart, checkEnd, bracketFor, bracketStarted, bracketFinished, cardRunRevision, checksSettled } = await import('../src/main/workflow/runChecks')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { cardWork } = await import('../src/main/workflow/cardWork')
const { FactStore } = await import('../src/main/workflow/factStore')
type RunFor = import('../src/main/workflow/runChecks').CheckRunFor
type Obs = InstanceType<typeof Observer>

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A repository on main with one commit (a.txt), `out/` ignored. */
function repo(): string {
  const p = tempDir('hive-run-checks-repo-')
  git(p, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  writeFileSync(join(p, '.gitignore'), 'out/\n')
  git(p, 'add', '-A')
  git(p, 'commit', '-q', '-m', 'one')
  return p
}
const commit = (p: string, file: string, text: string): string => {
  writeFileSync(join(p, file), text)
  git(p, 'add', '-A')
  git(p, 'commit', '-q', '-m', text.trim())
  return git(p, 'rev-parse', 'HEAD')
}
/** Once a folder's watch is armed: its record is complete from now on. */
const armed = (o: Obs, folder: string) => vi.waitFor(async () => expect(isUnknown(await o.changedBetween(folder, Date.now(), Date.now()))).toBe(false), { timeout: HUNG_MS })

const COMMANDS = { typecheck: 'npm run typecheck' }
const forGit = (p: string, over: Partial<RunFor> = {}): RunFor => ({ card: 7, folder: p, project: p, platform: 'git', tested: git(p, 'rev-parse', 'HEAD'), check: 'typecheck', checkCommand: 'npm run typecheck', command: 'npm run typecheck', commands: COMMANDS, facts: [], paths: [], excluded: [], ...over })
const end = (result: 'passed' | 'failed' | 'stopped' = 'passed') => ({ at: Date.now(), result, run: 'r1', by: 'B1', title: 'typecheck' })

/** Brackets a run: what was read at its start, `during` as its command, then its CheckRan. */
async function bracket(o: Obs, r: RunFor, during: () => void | Promise<void> = () => undefined) {
  const start = await checkStart(r, o)
  await during()
  return checkEnd(r, start, end(), o)
}

describe('a run as a check on Git (#1222)', () => {
  let o: Obs
  let p: string
  afterEach(() => o?.dispose())
  const watched = async (): Promise<void> => {
    p = repo()
    o = new Observer()
    o.follow([{ path: p, platform: 'git', root: p }])
    await armed(o, p)
  }

  it('counts a check that ran on the card\'s revision with nothing changed, its result whatever it was', async () => {
    await watched()
    const r = forGit(p)
    const start = await checkStart(r, o)
    const c = await checkEnd(r, start, end('failed'), o)
    expect(c).toMatchObject({ name: 'typecheck', command: 'npm run typecheck', revision: r.tested, tested: r.tested, result: 'failed', counted: true, run: 'r1', by: 'B1' })
    expect(c.whyNot).toBeUndefined()
  })

  it('a build writing an ignored out/ still counts', async () => {
    await watched()
    const c = await bracket(o, forGit(p), () => {
      mkdirSync(join(p, 'out'), { recursive: true })
      writeFileSync(join(p, 'out', 'bundle.js'), 'built')
    })
    expect(c).toMatchObject({ counted: true })
  })

  it('an edit during the run, undone before it ends, is a change: not counted', async () => {
    await watched()
    const c = await bracket(o, forGit(p), async () => {
      const was = readFileSync(join(p, 'a.txt'))
      writeFileSync(join(p, 'a.txt'), 'edited\n')
      writeFileSync(join(p, 'a.txt'), was)
    })
    // What it saw written is kept with it (#1654).
    expect(c).toMatchObject({ counted: false, whyNot: 'changed', changes: ['a.txt'] })
  })

  it('a checkout and back during the run is a change (the HEAD reflog): not counted', async () => {
    await watched()
    const first = git(p, 'rev-parse', 'HEAD')
    const second = commit(p, 'b.txt', 'b\n')
    const c = await bracket(o, forGit(p, { tested: second }), () => {
      git(p, 'checkout', '-q', first)
      git(p, 'checkout', '-q', 'main')
    })
    expect(c).toMatchObject({ counted: false, whyNot: 'changed' })
    expect(c.changes).toContain(':reflog')
  })

  it('another commit checked out at the end: moved', async () => {
    await watched()
    const tested = git(p, 'rev-parse', 'HEAD')
    const c = await bracket(o, forGit(p), () => void commit(p, 'b.txt', 'b\n'))
    expect(c).toMatchObject({ tested, counted: false, whyNot: 'moved' })
  })

  it('a folder with uncommitted changes at the start: dirty', async () => {
    await watched()
    writeFileSync(join(p, 'new.txt'), 'untracked\n')
    expect(await bracket(o, forGit(p))).toMatchObject({ counted: false, whyNot: 'dirty', changes: ['new.txt'] })
  })

  it("a check that reported another command than its configured one doesn't count, and its own command is recorded (HR5's round 1 finding 1)", async () => {
    await watched()
    expect(await bracket(o, forGit(p, { check: 'typecheck', command: 'echo skipped' }))).toMatchObject({ name: 'typecheck', command: 'echo skipped', counted: false, whyNot: 'notCheck' })
    // The command is the one configured when the run was resolved: the configuration changing meanwhile changes nothing.
    expect(await bracket(o, forGit(p, { commands: { typecheck: 'tsc -b' } }))).toMatchObject({ name: 'typecheck', command: 'npm run typecheck', counted: true })
    expect(await bracket(o, forGit(p, { checkCommand: null }))).toMatchObject({ counted: false, whyNot: 'notCheck' })
  })

  it("a run that wasn't started as a check counts only if its command is exactly a configured one", async () => {
    await watched()
    expect(await bracket(o, forGit(p, { check: null, command: 'npx tsc --noEmit' }))).toMatchObject({ name: 'typecheck', counted: false, whyNot: 'notCheck' })
    expect(await bracket(o, forGit(p, { check: null, command: 'npm run typecheck' }))).toMatchObject({ name: 'typecheck', command: 'npm run typecheck', counted: true })
  })

  it("in a shared folder, another card's later commit on top of the card's still counts for the card's revision", async () => {
    await watched()
    const c0 = git(p, 'rev-parse', 'HEAD')
    const mine = commit(p, 'mine.txt', 'mine\n')
    const theirs = commit(p, 'theirs.txt', 'theirs\n')
    const facts: Fact[] = [
      { seq: 1, card: 7, kind: 'Started', at: '2026-10-20T10:00:00.000Z', actor: 'agent:B1', source: 'recorded', data: { folder: 'project', line: 'main', base: c0, target: 'main', builder: 'B1', cardKind: 'code' } },
      { seq: 2, card: 7, kind: 'CommitAttributed', at: '2026-10-20T10:01:00.000Z', actor: 'outside', source: 'observed', data: { commit: mine, how: 'trailer' } }
    ]
    expect(await bracket(o, forGit(p, { tested: theirs, facts }))).toMatchObject({ revision: mine, tested: theirs, counted: true })
    // A card's revision the checkout doesn't contain (reset away): not contained.
    git(p, 'reset', '-q', '--hard', c0)
    const other = commit(p, 'other.txt', 'other\n')
    expect(await bracket(o, forGit(p, { tested: other, facts }))).toMatchObject({ revision: mine, counted: false, whyNot: 'notContained' })
  })

  it("a card on its own line counts only on its line's revision, not on an older checkout elsewhere (HR5's round 1 finding 2)", async () => {
    await watched()
    const a = git(p, 'rev-parse', 'HEAD')
    const wt = join(tempDir('hive-run-checks-wt-'), 'card')
    git(p, 'worktree', 'add', '-q', '-b', 'feature', wt)
    const b = commit(wt, 'feature.txt', 'feature\n')
    const facts: Fact[] = [{ seq: 1, card: 7, kind: 'Started', at: '2026-10-20T10:00:00.000Z', actor: 'agent:B1', source: 'recorded', data: { folder: wt, line: 'feature', base: a, target: 'main', builder: 'B1', cardKind: 'code' } }]
    // Run in main, at A: the card's revision is B, which A isn't.
    expect(await bracket(o, forGit(p, { tested: a, facts }))).toMatchObject({ revision: b, tested: a, counted: false, whyNot: 'notContained' })
    // Run in its own folder, at B: counted.
    o.follow([{ path: p, platform: 'git', root: p }, { path: wt, platform: 'git', root: wt }])
    await armed(o, wt)
    expect(await bracket(o, forGit(wt, { project: p, tested: b, facts }))).toMatchObject({ revision: b, tested: b, counted: true })
  })

  it("a folder the watcher doesn't follow: its stat snapshots decide", async () => {
    p = repo()
    o = new Observer()
    expect(await bracket(o, forGit(p))).toMatchObject({ counted: true })
    // The edit is left uncommitted: dirty, naming it.
    expect(await bracket(o, forGit(p), () => writeFileSync(join(p, 'a.txt'), 'a longer text\n'))).toMatchObject({ counted: false, whyNot: 'dirty', changes: ['a.txt'] })
  })
})

describe('a run as a check on None (#1222)', () => {
  let o: Obs
  let p: string
  afterEach(() => o?.dispose())
  const folder = async (): Promise<RunFor> => {
    p = tempDir('hive-run-checks-none-')
    writeFileSync(join(p, 'doc.md'), 'the doc\n')
    writeFileSync(join(p, 'other.md'), 'another\n')
    o = new Observer()
    o.follow([{ path: p, platform: 'none' }])
    await armed(o, p)
    return { card: 7, folder: p, project: p, platform: 'none', tested: null, check: 'typecheck', checkCommand: 'npm run typecheck', command: 'npm run typecheck', commands: COMMANDS, facts: [], paths: ['doc.md'], excluded: ['node_modules', '.venv', 'out'] }
  }

  it("counts when the card's paths hash the same at both ends and no deliverable was written", async () => {
    const r = await folder()
    const c = await bracket(o, r)
    expect(c).toMatchObject({ counted: true })
    expect(c.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(c.tested).toBe(c.revision)
  })

  it("an edit to a declared path during the run: the card's revision changed", async () => {
    const r = await folder()
    expect(await bracket(o, r, () => writeFileSync(join(p, 'doc.md'), 'edited\n'))).toMatchObject({ counted: false, whyNot: 'revisionChanged' })
  })

  it("a write to a folder the options leave out of the deliverables still counts (HR5's round 1 finding 3)", async () => {
    const r = await folder()
    expect(await bracket(o, r, () => {
      mkdirSync(join(p, 'out'), { recursive: true })
      writeFileSync(join(p, 'out', 'bundle.js'), 'built')
    })).toMatchObject({ counted: true })
    expect(await bracket(o, { ...r, excluded: [] }, () => writeFileSync(join(p, 'out', 'bundle.js'), 'built again'))).toMatchObject({ counted: false, whyNot: 'changed' })
  })

  it('a write to another deliverable during the run is a change', async () => {
    const r = await folder()
    expect(await bracket(o, r, () => writeFileSync(join(p, 'other.md'), 'edited\n'))).toMatchObject({ counted: false, whyNot: 'changed', changes: ['other.md'] })
  })
})

describe("a run's bracket in the app (#1222)", () => {
  const opened: ReturnType<typeof createWorkspaceService>[] = []
  afterAll(async () => {
    for (const w of opened) await disposeWorkspaceService(w)
    store.closeAllBoards()
  })

  it("writes the run's CheckRan in its card's facts; a run for no card, or with no checkout, has no bracket", async () => {
    const ws = join(base, 'ws')
    const p = join(ws, 'p')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    git(ws, 'init', '-q', '-b', 'main', p)
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(p, 'config', k, v)
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'git', workflow: { options: { commands: COMMANDS } } }))
    writeFileSync(join(p, '.gitignore'), '.combwork/\n')
    const head = commit(p, 'a.txt', 'a\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Checked', project: 'p' }, { kind: 'user' }))).number
    const link = { card, revision: head, testedCheckout: head, check: { name: 'typecheck', command: 'npm run typecheck' }, folder: p }
    expect(await bracketFor(w, { ...link, card: null })).toBeNull()
    expect(await bracketFor(w, { ...link, testedCheckout: null })).toBeNull()
    const b = (await bracketFor(w, link))!
    expect(b).toMatchObject({ project: 'p', for: { card, platform: 'git', tested: head, check: 'typecheck', commands: COMMANDS } })
    bracketStarted('run-1', b)
    const run = { id: 'run-1', finishedAt: Date.now(), state: 'passed', source: 'agent', agentId: 'a1', agentName: 'Agent 1', title: 'typecheck', command: 'npm run typecheck' } as never
    expect(await bracketFinished(run)).toMatchObject({ name: 'typecheck', revision: head, counted: true })
    expect(cardWork(w, card)!.checks).toMatchObject([{ name: 'typecheck', revision: head, tested: head, result: 'passed', counted: true, run: 'run-1', by: 'Agent 1' }])
    // Once only: its bracket is gone.
    expect(await bracketFinished(run)).toBeNull()
    // A start that names the check but reports another command: recorded as run, not counted.
    bracketStarted('run-2', (await bracketFor(w, link))!)
    expect(await bracketFinished({ ...(run as object), id: 'run-2', command: 'echo skipped' } as never)).toMatchObject({ name: 'typecheck', command: 'echo skipped', counted: false, whyNot: 'notCheck' })
  })

  it("a finished run's record still being written is waited for by its project's submits, not another project's (#1651)", async () => {
    const ws = join(base, 'ws-settled')
    const p = join(ws, 'p')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    git(ws, 'init', '-q', '-b', 'main', p)
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(p, 'config', k, v)
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'git', workflow: { options: { commands: COMMANDS } } }))
    writeFileSync(join(p, '.gitignore'), '.combwork/\n')
    const head = commit(p, 'a.txt', 'a\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Settled', project: 'p' }, { kind: 'user' }))).number
    const link = { card, revision: head, testedCheckout: head, check: { name: 'typecheck', command: 'npm run typecheck' }, folder: p }
    bracketStarted('run-s1', (await bracketFor(w, link))!)
    // As the finish route does: the record started, not waited for (hive-progress has exited meanwhile).
    const recorded = bracketFinished({ id: 'run-s1', finishedAt: Date.now(), state: 'passed', source: 'agent', agentId: 'a1', agentName: 'Agent 1', title: 'typecheck', command: 'npm run typecheck' } as never)
    expect(cardWork(w, card)!.checks).toEqual([])
    await checksSettled(w, join(ws, 'other'))
    await checksSettled(w, p.toUpperCase())
    expect(cardWork(w, card)!.checks).toMatchObject([{ name: 'typecheck', revision: head, result: 'passed', counted: true }])
    await recorded
    // Nothing left to wait for.
    await checksSettled(w, p)
  })

  it('a failed run of a check its card needs before Review says it blocks review; one it needs no more, or that passed, says nothing (#1279)', async () => {
    const ws = join(base, 'ws-blocks')
    const p = join(ws, 'p')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    git(ws, 'init', '-q', '-b', 'main', p)
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(p, 'config', k, v)
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'git', workflow: { options: { commands: COMMANDS, preChecks: ['typecheck'] } } }))
    writeFileSync(join(p, '.gitignore'), '.combwork/\n')
    const head = commit(p, 'a.txt', 'a\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Blocked by its check', project: 'p' }, { kind: 'user' }))).number
    const link = { card, revision: head, testedCheckout: head, check: { name: 'typecheck', command: 'npm run typecheck' }, folder: p }
    const run = (id: string, state: string, check = link.check) => {
      return bracketFor(w, { ...link, check }).then((b) => {
        bracketStarted(id, b!)
        return bracketFinished({ id, finishedAt: Date.now(), state, source: 'agent', agentId: 'a1', agentName: 'Agent 1', title: check.name, command: check.command } as never)
      })
    }
    expect(await run('run-b1', 'failed')).toMatchObject({ name: 'typecheck', result: 'failed', blocks: 'review' })
    expect(await run('run-b2', 'passed')).not.toHaveProperty('blocks')
    expect(await run('run-b3', 'failed', { name: 'unit', command: 'npm test' })).not.toHaveProperty('blocks')
  })

  it("None: the options' exclusions and the card's declared paths as they are at the end (HR5's round 1 findings 3 and 4)", async () => {
    const ws = join(base, 'ws-none')
    const p = join(ws, 'n')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'none', workflow: { options: { commands: COMMANDS, excluded: ['out'] } } }))
    writeFileSync(join(p, 'a.txt'), 'a\n')
    writeFileSync(join(p, 'b.txt'), 'b\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'None', project: 'n' }, { kind: 'user' }))).number
    const facts = FactStore.forBoard(w, { project: 'n', key: 'N' })
    const declare = (paths: string[]) => store.boardWrite(w, async () => void facts.updateCard(card, { paths }))
    await declare(['a.txt'])
    const link = { card, revision: null, testedCheckout: null, check: { name: 'typecheck', command: 'npm run typecheck' }, folder: p }
    let n = 0
    const finish = (during: () => void | Promise<void>) =>
      bracketFor(w, link).then(async (b) => {
        const id = `none-${++n}`
        bracketStarted(id, b!)
        await during()
        return bracketFinished({ id, finishedAt: Date.now(), state: 'passed', source: 'agent', agentId: 'a1', agentName: 'Agent 1', title: 'typecheck', command: 'npm run typecheck' } as never)
      })
    // Its output in an excluded folder counts; a write to a deliverable doesn't.
    expect(await finish(() => {
      mkdirSync(join(p, 'out'), { recursive: true })
      writeFileSync(join(p, 'out', 'bundle.js'), 'built')
    })).toMatchObject({ counted: true })
    expect(await finish(() => writeFileSync(join(p, 'b.txt'), 'b, a longer text\n'))).toMatchObject({ counted: false, whyNot: 'changed' })
    // The declaration changed during the run, no file touched: a new revision.
    expect(await finish(() => declare(['b.txt']))).toMatchObject({ counted: false, whyNot: 'revisionChanged' })
    expect(cardWork(w, card)!.checks.map((c) => [c.counted, c.whyNot])).toEqual([[true, undefined], [false, 'changed'], [false, 'revisionChanged']])
  })

  it("a card's run is read through its platform's adapter once it has started, and with git before (#1233)", async () => {
    const ws = join(base, 'ws-run')
    const p = join(ws, 'p')
    const n = join(ws, 'n')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(n, '.combwork'), { recursive: true })
    git(ws, 'init', '-q', '-b', 'main', p)
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(p, 'config', k, v)
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'git' }))
    writeFileSync(join(p, '.gitignore'), '.combwork/\n')
    writeFileSync(join(n, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }], platform: 'none' }))
    writeFileSync(join(n, 'a.txt'), 'a\n')
    const head = commit(p, 'a.txt', 'a\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const user = { kind: 'user' } as const
    const gitCard = (await inWorkspace(w, () => tasks.createTask({ title: 'Git', project: 'p' }, user))).number
    expect(await cardRunRevision(w, gitCard, p, null)).toBeNull()
    await inWorkspace(w, () => tasks.updateTask(gitCard, { column: 'doing', agent: 'a1' }, user))
    expect(await cardRunRevision(w, gitCard, p, 'main')).toEqual({ revision: head, tested: head, testedIs: 'checkout', named: head })
    const noneCard = (await inWorkspace(w, () => tasks.createTask({ title: 'None', project: 'n' }, user))).number
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'n', key: 'N' }).updateCard(noneCard, { paths: ['a.txt'] }))
    await inWorkspace(w, () => tasks.updateTask(noneCard, { column: 'doing', agent: 'a1' }, user))
    const none = (await cardRunRevision(w, noneCard, n, null))!
    expect(none).toMatchObject({ testedIs: 'content', revision: expect.any(String) })
    expect(none.tested).toBe(none.revision)
  })
})
