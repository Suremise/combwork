// Reconciliation in the app (#1217, SPEC §16.4.4): what was done outside Combwork to a card's work becomes observed facts on
// the board's store. Record-only with workflow rules not enforced (Settings → Advanced, #1263), as most of this file
// runs: nothing moves. Enforced, it acts at the app level (S7, S41). A card works in its agent's worktree on its own line: a hand
// merge of its branch after its pass (Integrated by outside, the card still Passed), a rebase after a pass (CarriedOver),
// an amend with new content (Stale), a reset of the target under a Done card (LeftTarget), and two Hives racing on one
// head (the log says what is true now).
import { execFileSync } from 'child_process'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-reconciler-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { reconcileNow, stopReconciling } = await import('../src/main/workflow/reconciler')
const { reconcile } = await import('../src/main/workflow/reconcile')
const { Workflow } = await import('../src/main/workflow/runtime')
const { foldCard } = await import('../src/shared/workflow/facts')
const { allOff } = await import('../src/shared/workflow/options')
const G = await import('../src/main/platform/git')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE, workflowFor } = await import('../src/main/workflow/service')
const keys = await import('../src/main/projectKeys')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
// Record-only unless a test turns the rules on.
advanced.load(join(base, 'profile'))
await advanced.set(ENFORCE, false)
afterAll(async () => {
  advanced.stop()
  stopReconciling()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' } } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' } } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/**
 * A workspace whose project `p` is a git repository on main, its builder working in a worktree on `card`, based on main;
 * `options`, its workflow options (else every option off).
 */
async function workspace(opts: { shared?: boolean; options?: object } = {}): Promise<{ ws: string; w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  // `shared`: both agents work in the project folder itself.
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', ...(opts.shared ? {} : { worktree: { path: wt, branch: 'card', base: 'main' } }) }, { id: 'a2', name: 'Reviewer' }], ...(opts.options ? { workflow: { platform: 'git', preset: null, options: opts.options } } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { ws, w, repo, wt }
}
const commitIn = (dir: string, file: string, text = `${file}\n`): string => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', file)
  return git(dir, 'rev-parse', 'HEAD')
}
const factsOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: '' }).facts(card)
const kinds = (w: WS, card: number): string[] => factsOf(w, card).map((f) => f.kind)

/** A card worked in the worktree: started, a commit, submitted, reviewed and passed into Passed. */
async function passedCard(w: WS, wt: string): Promise<{ card: number; head: string }> {
  const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p' }, user))).number
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
  const head = commitIn(wt, 'b.txt')
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder))
  await inWorkspace(w, () => tasks.updateTask(card, { review: 'start' }, reviewer))
  await inWorkspace(w, () => tasks.updateTask(card, { review: 'passed', column: 'passed' }, reviewer))
  return { card, head }
}

describe('reconciliation in the app, record-only (#1217)', () => {
  it("a Passed card's branch merged by hand is Integrated by outside, and the card stays Passed; reset away, a Done card is marked LeftTarget", async () => {
    const { w, repo, wt } = await workspace()
    const { card, head } = await passedCard(w, wt)
    expect(factsOf(w, card).find((f) => f.kind === 'Started')!.data).toMatchObject({ folder: wt, line: 'card', target: 'main' })
    const before = git(repo, 'rev-parse', 'main')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await reconcileNow(w, repo)
    const integrated = factsOf(w, card).find((f) => f.kind === 'Integrated')!
    expect(integrated).toMatchObject({ actor: 'outside', source: 'observed', data: { revision: head, target: 'main', by: 'outside', method: 'merge' } })
    // Nothing moved: no Moved after it, the card still in Passed.
    expect(kinds(w, card).slice(kinds(w, card).indexOf('Integrated'))).toEqual(['Integrated'])
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('passed')
    // Run again: nothing more (the same observation).
    await reconcileNow(w, repo)
    expect(kinds(w, card).filter((k) => k === 'Integrated')).toHaveLength(1)
    // The user moves it to Done; then main is reset to before the merge: a mark, and it stays Done.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    git(repo, 'reset', '-q', '--hard', before)
    await reconcileNow(w, repo, ['main'])
    expect(factsOf(w, card).at(-1)).toMatchObject({ kind: 'LeftTarget', source: 'observed', data: { revision: head, target: 'main' } })
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('done')
  })

  it('a rebase after the pass carries it over; an amend with new content makes it stale; neither moves the card', async () => {
    const { w, repo, wt } = await workspace()
    const { card, head } = await passedCard(w, wt)
    // main moves on, and the card's branch is rebased onto it: the same change.
    commitIn(repo, 'c.txt')
    git(wt, 'rebase', '-q', 'main')
    const rebased = git(wt, 'rev-parse', 'HEAD')
    await reconcileNow(w, repo)
    expect(factsOf(w, card).find((f) => f.kind === 'CarriedOver')).toMatchObject({ source: 'observed', data: { from: head, to: rebased, how: 'replay' } })
    // Then amended with new content: not the same change.
    writeFileSync(join(wt, 'b.txt'), 'changed\n')
    git(wt, 'commit', '-q', '-a', '--amend', '--no-edit')
    const amended = git(wt, 'rev-parse', 'HEAD')
    await reconcileNow(w, repo)
    expect(factsOf(w, card).find((f) => f.kind === 'Stale')).toMatchObject({ source: 'observed', data: { current: amended } })
    expect(kinds(w, card).filter((k) => k === 'Moved').map(String)).toHaveLength(3)
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('passed')
    // The observed heads were recorded on the way.
    expect(foldCard(factsOf(w, card)).head).toBe(amended)
  })

  it('two Hives racing on one head (A→B seen by one, A→C by the other): the log says what is true now, once', async () => {
    const { ws, w, repo, wt } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Race', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    const a = git(wt, 'rev-parse', 'HEAD')
    const runtime = (s: ReturnType<typeof FactStore.open>, locked?: <T>(fn: () => T) => Promise<T>) =>
      new Workflow({ store: s, project: repo, projectKey: '', options: () => allOff('git'), slots: join(ws, '.combwork', 'slots'), autoRun: false, reconcileActs: false, ...(locked ? { locked } : {}) })
    // This Combwork: the board's store, its writes changes of the board. The other: a connection of its own.
    const ours = runtime(FactStore.forBoard(w, { project: 'p', key: '' }), (fn) => store.boardWrite(w, async () => fn()))
    const other = FactStore.open(store.boardFile(ws), { project: 'p', key: '' })
    const theirs = runtime(other)
    try {
      const b = commitIn(wt, 'b.txt')
      // Ours reads B, then waits: meanwhile the head moves to C and the other Combwork records A→C.
      let c = ''
      await reconcile(ours, ours.store.card(card), {
        afterRead: async () => {
          c = commitIn(wt, 'c.txt')
          await reconcile(theirs, theirs.store.card(card))
        }
      })
      const heads = factsOf(w, card).filter((f) => f.kind === 'HeadMoved').map((f) => f.data)
      expect(b).not.toBe(c)
      // One observation, from where its line started (A) to where it is now (C): B, which only one Combwork saw, isn't in it.
      expect(heads).toEqual([{ line: 'card', from: a, to: c }])
      expect(foldCard(factsOf(w, card)).head).toBe(c)
    } finally {
      other.close()
    }
  })

  it('nothing is written while the board waits for its upgrade or once the workspace has closed', async () => {
    const { w, repo, wt } = await workspace()
    const { card } = await passedCard(w, wt)
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    const path = w.path!
    await w.close()
    await reconcileNow(w, repo)
    expect(store.boardOpen(path)).toBe(false)
    const reopened = createWorkspaceService()
    await reopened.open(path)
    opened.push(reopened)
    expect(FactStore.forBoard(reopened, { project: 'p', key: '' }).facts(card).some((f) => f.kind === 'Integrated')).toBe(false)
  })
})

// HR4's #1217 round 1: trailers resolved by the project's name, an observation never written into a cycle it wasn't
// read in, TargetMoved, Gone for a folder or a repository, and a Done card's target checked after a time closed.
describe('reconciliation in the app, round 2 (#1217)', () => {
  it("a shared folder's commit with a card's trailer is that card's, with two cards working there", async () => {
    const { w, repo } = await workspace({ shared: true })
    const [one, two] = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'One', project: 'p' }, user)).number, (await tasks.createTask({ title: 'Two', project: 'p' }, user)).number])
    await inWorkspace(w, () => tasks.updateTask(one, { column: 'doing', agent: 'a1' }, user))
    await inWorkspace(w, () => tasks.updateTask(two, { column: 'doing', agent: 'a2' }, user))
    writeFileSync(join(repo, 'two.txt'), 'two\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'for two', '-m', `Hive-Card: P-${two}`)
    const sha = git(repo, 'rev-parse', 'HEAD')
    await reconcileNow(w, repo)
    expect(factsOf(w, two).find((f) => f.kind === 'CommitAttributed')).toMatchObject({ data: { commit: sha, how: 'trailer' } })
    expect(kinds(w, one)).not.toContain('CommitAttributed')
    expect(FactStore.forBoard(w, { project: 'p', key: 'p' }).folderCommits(repo)).toMatchObject([{ sha, card: two, how: 'trailer' }])
  })

  // #1294: the runtime names cards by #1219's keys, a project's own numbers apart from the board's.
  it("a project's cards by its key and their number there: the runtime's names, cardByKey (an old key, #N, the name form) and a Hive-Card trailer", async () => {
    const { w, repo } = await workspace({ shared: true })
    await keys.keyProjects(w)
    const key = (await keys.projectKeyOf(w, repo))!
    // A workspace card first, so p's cards' numbers there (1, 2) aren't their numbers on the board.
    await inWorkspace(w, () => tasks.createTask({ title: 'Workspace', project: '' }, user))
    const [one, two] = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'One', project: 'p' }, user)).number, (await tasks.createTask({ title: 'Two', project: 'p' }, user)).number])
    expect(two).not.toBe(2)
    const wf = (await workflowFor(w, repo))!
    expect(wf.cfg.projectKey).toBe(key)
    expect([wf.store.card(one).key, wf.store.card(two).key]).toEqual([`${key}-1`, `${key}-2`])
    for (const ref of [`${key}-2`, `${key.toLowerCase()}-2`, `#${two}`, `p-${two}`]) expect({ ref, got: wf.store.cardByKey(ref)?.id ?? null }).toEqual({ ref, got: two })
    expect(wf.store.cardByKey(`${key}-9`)).toBeNull()
    expect(wf.resolve(`${key}-2`, 'agent:a1')).toMatchObject({ id: two })
    // A trailer by key attributes the commit to that card.
    await inWorkspace(w, () => tasks.updateTask(one, { column: 'doing', agent: 'a1' }, user))
    await inWorkspace(w, () => tasks.updateTask(two, { column: 'doing', agent: 'a2' }, user))
    writeFileSync(join(repo, 'two.txt'), 'two\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'for two', '-m', `Hive-Card: ${key}-2`)
    const sha = git(repo, 'rev-parse', 'HEAD')
    await reconcileNow(w, repo)
    expect(factsOf(w, two).find((f) => f.kind === 'CommitAttributed')).toMatchObject({ data: { commit: sha, how: 'trailer' } })
    expect(kinds(w, one)).not.toContain('CommitAttributed')
    // The key changed: the runtime names them by the new one at once; the old one still finds them.
    await keys.changeProjectKey(w, repo, 'ZQX')
    expect([wf.cfg.projectKey, wf.store.card(two).key, wf.store.cardByKey(`${key}-2`)?.id]).toEqual(['ZQX', 'ZQX-2', two])
  })

  it('a head read before the card started again is never written into its new cycle', async () => {
    const { ws, w, repo, wt } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Cycles', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    const ours = new Workflow({ store: FactStore.forBoard(w, { project: 'p', key: 'p' }), project: repo, projectKey: 'p', options: () => allOff('git'), slots: join(ws, '.combwork', 'slots'), autoRun: false, reconcileActs: false, locked: (fn) => store.boardWrite(w, async () => fn()) })
    const b = commitIn(wt, 'b.txt')
    // Read B; meanwhile C is committed and the card goes Done and is started again: a new cycle.
    await reconcile(ours, ours.store.card(card), {
      afterRead: async () => {
        commitIn(wt, 'c.txt')
        await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
        await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
      }
    })
    const facts = factsOf(w, card)
    const second = facts.findLast((f) => f.kind === 'Started')!
    expect(facts.filter((f) => f.kind === 'Started')).toHaveLength(2)
    expect(facts.filter((f) => f.seq > second.seq && f.kind === 'HeadMoved' && (f.data as { to: string }).to === b)).toEqual([])
  })

  it("TargetMoved: the card's target observed from its last recorded head, each move once", async () => {
    const { w, repo, wt } = await workspace()
    const { card } = await passedCard(w, wt)
    const first = git(repo, 'rev-parse', 'main')
    await reconcileNow(w, repo)
    const moves = () => factsOf(w, card).filter((f) => f.kind === 'TargetMoved').map((f) => f.data)
    expect(moves()).toEqual([{ target: 'main', from: null, to: first }])
    const next = commitIn(repo, 'target.txt')
    await reconcileNow(w, repo)
    await reconcileNow(w, repo)
    expect(moves()).toEqual([
      { target: 'main', from: null, to: first },
      { target: 'main', from: first, to: next }
    ])
  })

  it("Gone: the card's worktree folder taken away (its branch still there), and a repository gone", async () => {
    const { w, repo, wt } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Folder', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    // The refresh the open scheduled reads the projects' files (the worktree is one): Windows won't move a folder with a
    // file open in it (#1341: EPERM).
    await w.refreshesSettled()
    renameSync(wt, `${wt}-away`)
    await reconcileNow(w, repo)
    await reconcileNow(w, repo)
    expect(factsOf(w, card).filter((f) => f.kind === 'Gone').map((f) => f.data)).toEqual([{ what: 'folder' }])
    // Another workspace: the repository itself gone.
    const other = await workspace()
    const c2 = (await inWorkspace(other.w, () => tasks.createTask({ title: 'Repository', project: 'p' }, user))).number
    await inWorkspace(other.w, () => tasks.updateTask(c2, { column: 'doing', agent: 'a1' }, user))
    await other.w.refreshesSettled()
    renameSync(join(other.repo, '.git'), join(other.repo, '.git-away'))
    await reconcileNow(other.w, other.repo)
    expect(factsOf(other.w, c2).filter((f) => f.kind === 'Gone').map((f) => f.data)).toEqual([{ what: 'repository' }])
  })

  it("a Done card's target reset while Combwork was closed: found at the next open, with no event", async () => {
    const { w, repo, wt } = await workspace()
    const { card, head } = await passedCard(w, wt)
    const before = git(repo, 'rev-parse', 'main')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await reconcileNow(w, repo)
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    // A run that checks the Done cards' targets as they are now.
    await reconcileNow(w, repo)
    const path = w.path!
    await w.close()
    git(repo, 'reset', '-q', '--hard', before)
    const again = createWorkspaceService()
    await again.open(path)
    opened.push(again)
    await reconcileNow(again, repo)
    expect(FactStore.forBoard(again, { project: 'p', key: 'p' }).facts(card).find((f) => f.kind === 'LeftTarget')).toMatchObject({ data: { revision: head, target: 'main' } })
  })
})

// HR4's #1217 round 2: a Done target's checkpoint moves only past cards reconciled to the end, and a target deleted
// (and restored) is recorded.
describe('reconciliation in the app, round 3 (#1217)', () => {
  it("a Done card whose check couldn't be read is checked again at the next run, with no event: LeftTarget then", async () => {
    const { w, repo, wt } = await workspace()
    const { card, head } = await passedCard(w, wt)
    const before = git(repo, 'rev-parse', 'main')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await reconcileNow(w, repo)
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, user))
    await reconcileNow(w, repo)
    git(repo, 'reset', '-q', '--hard', before)
    // This run can't tell whether the change is still in main (git unreadable for that one read).
    const unreadable = vi.spyOn(G, 'contains').mockResolvedValueOnce({ unknown: true, what: 'the target (test)' })
    try {
      await reconcileNow(w, repo, ['main'])
    } finally {
      unreadable.mockRestore()
    }
    expect(kinds(w, card)).not.toContain('LeftTarget')
    // The next run, no event, git readable again: the Done card is checked again, and marked.
    await reconcileNow(w, repo)
    expect(factsOf(w, card).find((f) => f.kind === 'LeftTarget')).toMatchObject({ data: { revision: head, target: 'main' } })
  })

  it('a target deleted is recorded (X→null), and its return (null→Y); a run with nothing new adds nothing', async () => {
    const { w, repo, wt } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Target gone', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    await reconcileNow(w, repo)
    const x = git(repo, 'rev-parse', 'main')
    // The project folder off main, and main deleted; the card's own branch stays.
    git(repo, 'checkout', '-q', '--detach')
    git(repo, 'branch', '-q', '-D', 'main')
    await reconcileNow(w, repo, ['main'])
    await reconcileNow(w, repo, ['main'])
    git(repo, 'branch', '-q', 'main', x)
    await reconcileNow(w, repo, ['main'])
    const moves = factsOf(w, card).filter((f) => f.kind === 'TargetMoved').map((f) => f.data)
    expect(moves).toEqual([
      { target: 'main', from: null, to: x },
      { target: 'main', from: x, to: null },
      { target: 'main', from: null, to: x }
    ])
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('card')
  })
})

// #1263: with workflow rules enforced, reconciliation acts on what it observes, through the project's runtime (S7, S41 at
// the app level, on the real board); turned off, the same observations are recorded and nothing moves.
describe('reconciliation acts with workflow rules enforced (#1263)', () => {
  beforeAll(() => advanced.set(ENFORCE, true))
  afterEach(() => advanced.set(ENFORCE, true))
  afterAll(() => advanced.set(ENFORCE, false))
  // Reconciliation's own actions: the loop's handoffs the board's changes write (#1266: a wake `about` a verdict) left out.
  const actions = (w: WS, card: number): string[] => store.boardRead(w, (db) => (db.prepare("SELECT kind FROM card_actions WHERE card = ? AND json_extract(payload, '$.about') IS NULL ORDER BY id").all(card) as { kind: string }[]).map((r) => r.kind))
  const column = async (w: WS, card: number) => (await inWorkspace(w, () => tasks.getTask(card, w))).column

  // A review by an agent: with the rules enforced, agents' moves are intents (#1268), and with every option off a
  // submission is Done at once.
  const REVIEWED = { ...allOff('git'), review: 'agent', noSelfReview: true }

  it('S7: a Passed card merged by hand is Done (outside), its lane told and its slot released', async () => {
    const { w, repo, wt } = await workspace({ options: REVIEWED })
    const { card, head } = await passedCard(w, wt)
    // The intents' own actions (#1268: the review copy, the builder told it passed) before it.
    const before = actions(w, card).length
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await reconcileNow(w, repo)
    expect(factsOf(w, card).find((f) => f.kind === 'Integrated')).toMatchObject({ actor: 'outside', data: { revision: head, by: 'outside' } })
    expect(factsOf(w, card).at(-2)).toMatchObject({ kind: 'Moved', data: { to: 'done', cause: 'derived' } })
    // Its finish follows the move (HI-2014): a hand merge found in the target, verified.
    expect(factsOf(w, card).at(-1)).toMatchObject({ kind: 'Finished', data: { how: 'reported', verified: expect.any(String) } })
    expect(await column(w, card)).toBe('done')
    expect(actions(w, card).slice(before)).toEqual(['finish'])
    // Again: nothing more.
    await reconcileNow(w, repo)
    expect(kinds(w, card).filter((k) => k === 'Integrated' || k === 'Moved').slice(-2)).toEqual(['Integrated', 'Moved'])
  })

  it("S41: a card just started isn't Done; part of an Active card's work merged by hand is a mark; a Review card merged by hand is Done outside the rules", async () => {
    const fresh = await workspace()
    const just = (await inWorkspace(fresh.w, () => tasks.createTask({ title: 'Just started', project: 'p' }, user))).number
    await inWorkspace(fresh.w, () => tasks.updateTask(just, { column: 'doing', agent: 'a1' }, user))
    await reconcileNow(fresh.w, fresh.repo)
    expect(await column(fresh.w, just)).toBe('doing')

    const part = await workspace()
    const partly = (await inWorkspace(part.w, () => tasks.createTask({ title: 'Two parts', project: 'p' }, user))).number
    await inWorkspace(part.w, () => tasks.updateTask(partly, { column: 'doing', agent: 'a1' }, user))
    const first = commitIn(part.wt, 'p1.txt')
    commitIn(part.wt, 'p2.txt')
    git(part.repo, 'merge', '-q', '--no-ff', '-m', 'part one by hand', first)
    await reconcileNow(part.w, part.repo)
    expect(factsOf(part.w, partly).find((f) => f.kind === 'MergedInPart')).toMatchObject({ data: { revision: first, target: 'main' } })
    expect(await column(part.w, partly)).toBe('doing')

    const rev = await workspace({ options: REVIEWED })
    const reviewed = (await inWorkspace(rev.w, () => tasks.createTask({ title: 'Reviewed', project: 'p' }, user))).number
    await inWorkspace(rev.w, () => tasks.updateTask(reviewed, { column: 'doing', agent: 'a1' }, user))
    commitIn(rev.wt, 'r.txt')
    await inWorkspace(rev.w, () => tasks.updateTask(reviewed, { column: 'review' }, builder))
    git(rev.repo, 'merge', '-q', '--no-ff', '-m', 'by hand', 'card')
    await reconcileNow(rev.w, rev.repo)
    const r = foldCard(factsOf(rev.w, reviewed))
    expect(r.integrated).toMatchObject({ by: 'outside' })
    expect(r.marks.outsideRules).toEqual(['review'])
    expect(await column(rev.w, reviewed)).toBe('done')
  })

  // HR2's round 1: an observation recorded while the rules were off is acted on once they're on again, once.
  it('off then on: a hand merge recorded while off makes the card Done once the rules are on, with its actions written once', async () => {
    await advanced.set(ENFORCE, false)
    const { w, repo, wt } = await workspace()
    const { card } = await passedCard(w, wt)
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await reconcileNow(w, repo)
    expect(kinds(w, card).at(-1)).toBe('Integrated')
    expect(await column(w, card)).toBe('passed')
    await advanced.set(ENFORCE, true)
    await reconcileNow(w, repo)
    expect(await column(w, card)).toBe('done')
    expect(factsOf(w, card).at(-2)).toMatchObject({ kind: 'Moved', data: { to: 'done', cause: 'derived' } })
    // Its finish follows the move (HI-2014): a hand merge found in the target, verified.
    expect(factsOf(w, card).at(-1)).toMatchObject({ kind: 'Finished', data: { how: 'reported', verified: expect.any(String) } })
    expect(kinds(w, card).filter((k) => k === 'Integrated')).toHaveLength(1)
    expect(actions(w, card)).toEqual(['finish'])
    await reconcileNow(w, repo, ['main'])
    expect(actions(w, card)).toEqual(['finish'])
    expect(factsOf(w, card).filter((f) => f.kind === 'Moved' && (f.data as { cause: string }).cause === 'derived')).toHaveLength(1)
  })

  it('off then on: a stale pass recorded while off wakes its builder once the rules are on, once', async () => {
    await advanced.set(ENFORCE, false)
    const { w, repo, wt } = await workspace()
    const { card } = await passedCard(w, wt)
    // Amended with new content after the pass: not the same change.
    writeFileSync(join(wt, 'b.txt'), 'changed\n')
    git(wt, 'commit', '-q', '-a', '--amend', '--no-edit')
    await reconcileNow(w, repo)
    const stale = factsOf(w, card).find((f) => f.kind === 'Stale')!
    expect(stale).toBeTruthy()
    expect(actions(w, card)).toEqual([])
    await advanced.set(ENFORCE, true)
    await reconcileNow(w, repo)
    const wakes = () => store.boardRead(w, (db) => db.prepare("SELECT fact, payload FROM card_actions WHERE card = ? AND kind = 'wake' AND json_extract(payload, '$.about') IS NULL").all(card) as { fact: number; payload: string }[])
    expect(wakes()).toHaveLength(1)
    expect(wakes()[0].fact).toBe(stale.seq)
    expect(JSON.parse(wakes()[0].payload)).toMatchObject({ agent: 'a1' })
    expect(await column(w, card)).toBe('passed')
    await reconcileNow(w, repo)
    expect(wakes()).toHaveLength(1)
  })

  it('turned off, the same hand merge of a Review card is recorded and the card stays in Review', async () => {
    await advanced.set(ENFORCE, false)
    const { w, repo, wt } = await workspace()
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Reviewed', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    commitIn(wt, 'r.txt')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, builder))
    git(repo, 'merge', '-q', '--no-ff', '-m', 'by hand', 'card')
    await reconcileNow(w, repo)
    expect(factsOf(w, card).find((f) => f.kind === 'Integrated')).toMatchObject({ data: { by: 'outside', outsideRules: ['review'] } })
    expect(kinds(w, card).at(-1)).toBe('Integrated')
    expect(await column(w, card)).toBe('review')
    expect(actions(w, card)).toEqual([])
  })
})
