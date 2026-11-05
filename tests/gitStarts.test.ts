// Fewer git starts (HI-2115): answers about fixed commits (an ancestor, a merge base, a range's first parents) kept for
// as long as Combwork runs, never while the repository's history can differ under the same ids (shallow, replace refs,
// grafts), never for names or unknown answers, and never across repositories. (The slots' finished-card look, the
// other cut, is tested in slotCards.test.ts; the Git status item's in gitRepo.test.ts.)
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { B1, commit, gitRepo, moved, R1, setup, sh } from './workflow/harness'
import { gitTestHooks, withGitRoute } from '../src/main/git'
import { runGit } from '../src/main/gitWorker'
import { contains, firstParents, forgetKeptAnswers, gitStep, isAncestor, mergeBase, NOT_FOUND_MS } from '../src/main/platform/git'
import { reconcile } from '../src/main/workflow/reconcile'
import { allOff, preset } from '../src/shared/workflow/options'
import { isUnknown } from '../src/main/platform/types'

// Real git work, not a wait: a few dozen git commands per test.
vi.setConfig({ testTimeout: 60_000 })

/** The git commands started while `fn` ran (their arguments), and its answer. */
async function counted<T>(fn: () => Promise<T>): Promise<{ ran: string[][]; v: T }> {
  const ran: string[][] = []
  gitTestHooks.started = (_cwd, args) => void ran.push([...args])
  try {
    return { v: await fn(), ran }
  } finally {
    gitTestHooks.started = undefined
  }
}
const rev = (folder: string, what = 'HEAD'): string => sh(folder, 'rev-parse', what)

beforeEach(() => forgetKeptAnswers())
afterEach(() => {
  gitTestHooks.started = undefined
  vi.useRealTimers()
})

describe('answers about fixed commits, kept', () => {
  /** A repository with main (a, b) and a line from a (c): ids of each. */
  function history(): { repo: string; a: string; b: string; c: string } {
    const repo = join(tempDir('kept-'), 'repo')
    gitRepo(repo)
    const a = rev(repo)
    const b = commit(repo, { 'b.txt': 'b\n' }, 'b')
    sh(repo, 'switch', '-q', '-c', 'line', a)
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    sh(repo, 'switch', '-q', 'main')
    return { repo, a, b, c }
  }

  it('asked once across steps, in the repository and its linked worktree alike; answers as git does', async () => {
    const { repo, a, b, c } = history()
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '--detach', wt)
    const first = await counted(() => gitStep(async () => [await isAncestor(repo, a, b), await isAncestor(repo, c, b), await mergeBase(repo, b, c), await firstParents(repo, a, b)]))
    expect(first.v).toEqual([true, false, a, [b]])
    expect(first.ran.length).toBe(4)
    // Another step (the next reconcile), outside any step, and in the worktree: no git.
    const again = await counted(() => gitStep(async () => [await isAncestor(repo, a, b), await isAncestor(wt, c, b), await mergeBase(wt, b, c), await firstParents(repo, a, b)]))
    expect(again.v).toEqual(first.v)
    expect(again.ran).toEqual([])
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it('names and unknown answers are never kept', async () => {
    const { repo, a, b } = history()
    for (let i = 0; i < 2; i++) expect((await counted(() => isAncestor(repo, a, 'main'))).ran.length).toBe(1)
    const missing = 'f'.repeat(40)
    for (let i = 0; i < 2; i++) {
      const r = await counted(() => isAncestor(repo, missing, b))
      expect(isUnknown(r.v)).toBe(true)
      expect(r.ran.length).toBe(1)
    }
  })

  it('never answered from what was kept while a replace ref or a graft is there, and kept again once they go', async () => {
    const { repo, a, b, c } = history()
    expect(await isAncestor(repo, c, b)).toBe(false)
    // b replaced by a commit whose parent is c: c is now b's ancestor, as git says, never the kept "no".
    const fake = sh(repo, 'commit-tree', `${b}^{tree}`, '-p', c, '-m', 'fake')
    sh(repo, 'replace', b, fake)
    for (let i = 0; i < 2; i++) {
      const r = await counted(() => isAncestor(repo, c, b))
      expect(r.v).toBe(true)
      expect(r.ran.length).toBe(1)
    }
    // Packed, the loose folder gone: still seen.
    sh(repo, 'pack-refs', '--all', '--prune')
    rmSync(join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
    expect((await counted(() => isAncestor(repo, c, b))).ran.length).toBe(1)
    sh(repo, 'replace', '-d', b)
    rmSync(join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
    sh(repo, 'pack-refs', '--all', '--prune')
    expect((await counted(() => isAncestor(repo, c, b))).v).toBe(false)
    // A graft (info/grafts: b's parent is c) likewise.
    expect(await isAncestor(repo, a, b)).toBe(true)
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'grafts'), `${b} ${c}\n`)
    const grafted = await counted(() => isAncestor(repo, c, b))
    expect(grafted.ran.length).toBe(1)
    rmSync(join(repo, '.git', 'info', 'grafts'))
    const plain = await counted(() => isAncestor(repo, a, b))
    expect(plain).toEqual({ v: true, ran: [] })
  })

  it("a reftable repository is never plain: a replacement inside the reftable is git's answer at once (HR3's round 2, finding 1)", async () => {
    const repo = join(tempDir('kept-reftable-'), 'repo')
    sh(join(repo, '..'), 'init', '-q', '--ref-format=reftable', '-b', 'main', repo)
    const a = commit(repo, { 'a.txt': 'a\n' }, 'a')
    const b = commit(repo, { 'b.txt': 'b\n' }, 'b')
    sh(repo, 'switch', '-q', '-c', 'line', a)
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    const before = await counted(() => isAncestor(repo, c, b))
    expect(before.v).toBe(false)
    expect((await counted(() => isAncestor(repo, c, b))).ran.length).toBe(1)
    sh(repo, 'replace', b, sh(repo, 'commit-tree', `${b}^{tree}`, '-p', c, '-m', 'fake'))
    expect(await isAncestor(repo, c, b)).toBe(true)
  })

  it("a linked worktree whose own config.worktree gains an include: not plain there, so git again (HR3's round 3, finding 2)", async () => {
    const { repo, a, b } = history()
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '--detach', wt)
    expect((await counted(() => isAncestor(wt, a, b))).ran.length).toBe(1)
    expect((await counted(() => isAncestor(wt, a, b))).ran).toEqual([])
    writeFileSync(join(sh(wt, 'rev-parse', '--absolute-git-dir'), 'config.worktree'), '[include]\n\tpath = more.config\n')
    expect(await counted(() => isAncestor(wt, a, b))).toEqual({ v: true, ran: [expect.any(Array)] })
    // The project's own folder (another git dir, its config.worktree plain) still answers from what was kept.
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it("metadata that can't be read is never taken for plain: what was kept isn't given (HR3's round 3, finding 1)", async () => {
    const { repo, a, b } = history()
    expect(await isAncestor(repo, a, b)).toBe(true)
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
    // A config file that is there but can't be read (here a folder in its place: EISDIR, not "no such file").
    const worktreeConfig = join(repo, '.git', 'config.worktree')
    mkdirSync(worktreeConfig)
    expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    rmSync(worktreeConfig, { recursive: true })
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
    // packed-refs likewise: git is asked (whatever it answers), never the kept "yes".
    mkdirSync(join(repo, '.git', 'packed-refs'))
    expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    rmSync(join(repo, '.git', 'packed-refs'), { recursive: true })
    expect((await counted(() => isAncestor(repo, a, b))).ran).toEqual([])
  })

  it('another replace namespace named in the environment: never kept', async () => {
    const { repo, a, b } = history()
    process.env.GIT_REPLACE_REF_BASE = 'refs/other-replace/'
    try {
      expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
      expect((await counted(() => isAncestor(repo, a, b))).ran.length).toBe(1)
    } finally {
      delete process.env.GIT_REPLACE_REF_BASE
    }
  })

  it('a shallow repository: asked each time; deepened, the answers are the whole history’s', async () => {
    const { repo, a, b } = history()
    const shallow = join(repo, '..', 'shallow')
    sh(join(repo, '..'), 'clone', '-q', '--depth', '1', '--no-local', `file://${repo.replace(/\\/g, '/')}`, shallow)
    const s1 = await counted(() => isAncestor(shallow, a, b))
    expect(isUnknown(s1.v) || s1.v === false).toBe(true)
    expect(s1.ran.length).toBe(1)
    sh(shallow, 'fetch', '-q', '--unshallow')
    const deep = await counted(() => isAncestor(shallow, a, b))
    expect(deep.v).toBe(true)
    expect(deep.ran.length).toBe(1)
    expect((await counted(() => isAncestor(shallow, a, b))).ran).toEqual([])
  })

  it("a folder reused for another repository never gets the other's answers", async () => {
    const one = history()
    expect(await isAncestor(one.repo, one.a, one.b)).toBe(true)
    // The same folder, now a copy whose b is c's descendant instead: another repository (its own common dir is the
    // same path, but the commit ids differ, so the answers asked are others).
    const other = join(tempDir('kept-other-'), 'repo')
    gitRepo(other)
    const x = rev(other)
    const y = commit(other, { 'y.txt': 'y\n' }, 'y')
    rmSync(one.repo, { recursive: true, force: true })
    cpSync(other, one.repo, { recursive: true })
    const r = await counted(() => isAncestor(one.repo, y, x))
    expect(r).toEqual({ v: false, ran: [r.ran[0]] })
    expect(r.ran.length).toBe(1)
  })
})

describe('"is the change in the target?": a merge kept for its commits, a squash asked each pass (HI-2182)', () => {
  /** main (a), a line from a with its change (c), squashed onto main as s: ids of each. */
  function squashed(): { repo: string; a: string; c: string; s: string } {
    const repo = join(tempDir('contains-'), 'repo')
    gitRepo(repo)
    const a = rev(repo)
    sh(repo, 'switch', '-q', '-c', 'line')
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    sh(repo, 'switch', '-q', 'main')
    sh(repo, 'merge', '-q', '--squash', 'line')
    sh(repo, 'commit', '-q', '-m', 'squash of line')
    return { repo, a, c, s: rev(repo) }
  }

  it('a merge or fast-forward, the target unchanged: the next pass starts no git; a target that moves is asked again', async () => {
    const { repo, a, c, s } = squashed()
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge line', 'line')
    const m = rev(repo)
    const first = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(first.v).toEqual({ method: 'merge' })
    expect(first.ran.length).toBeGreaterThan(0)
    // The target's head is read from its ref file: none of resolve's rev-parse.
    expect(first.ran.some((x) => x[0] === 'rev-parse' && x.includes('main^{commit}'))).toBe(false)
    expect(await counted(() => gitStep(() => contains(repo, 'main', { base: a, revision: c })))).toEqual({ v: first.v, ran: [] })
    // Reset off the merge (back at the squash): another head, asked again: the squash.
    sh(repo, 'reset', '-q', '--hard', s)
    const reset = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(reset.v).toEqual({ method: 'squash', commit: s })
    expect(reset.ran.length).toBeGreaterThan(0)
    // Back at the merge: kept, no git. A fast-forward line the same.
    sh(repo, 'reset', '-q', '--hard', m)
    expect(await counted(() => contains(repo, 'main', { base: a, revision: c }))).toEqual({ v: first.v, ran: [] })
    sh(repo, 'switch', '-q', '-c', 'forward', c)
    expect(await contains(repo, 'forward', { base: a, revision: c })).toEqual({ method: 'fastForward' })
    expect(await counted(() => contains(repo, 'forward', { base: a, revision: c }))).toEqual({ v: { method: 'fastForward' }, ran: [] })
    // A name that could be a commit id is git's to read, every time.
    sh(repo, 'branch', 'ff', c)
    for (let i = 0; i < 2; i++) expect((await counted(() => contains(repo, 'ff', { base: a, revision: c }))).ran.map((x) => x.join(' '))).toEqual(['rev-parse --verify -q ff^{commit}'])
  })

  it('a squash found is asked again each pass (once per step): attributes and drivers can change the replay (HR2, round 1)', async () => {
    const { repo, a, c, s } = squashed()
    const first = await counted(() => gitStep(async () => [await contains(repo, 'main', { base: a, revision: c }), await contains(repo, 'main', { base: a, revision: c })]))
    expect(first.v).toEqual([{ method: 'squash', commit: s }, { method: 'squash', commit: s }])
    const n = first.ran.length
    // The next pass asks the replay again, as the first did.
    const again = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(again.v).toEqual(first.v[0])
    expect(again.ran.filter((x) => x[0] === 'merge-tree').length).toBeGreaterThan(0)
    expect(again.ran.length).toBeLessThanOrEqual(n)
  })

  it("an answer a merge driver gave follows the attributes as they are now: a found one at once, a not found within 30 s (HR2's round 1 regression, the user's HI-2189 decision)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = join(tempDir('contains-driver-'), 'repo')
    gitRepo(repo)
    const a = commit(repo, { 'f.txt': 'base\n' }, 'base')
    sh(repo, 'switch', '-q', '-c', 'line')
    const c = commit(repo, { 'f.txt': 'change\n' }, 'change')
    sh(repo, 'switch', '-q', 'main')
    commit(repo, { 'f.txt': 'target\n' }, 'target')
    sh(repo, 'config', 'merge.ours.driver', 'true')
    const attributes = join(repo, '.git', 'info', 'attributes')
    writeFileSync(attributes, 'f.txt merge=ours\n')
    expect(await contains(repo, 'main', { base: a, revision: c })).toEqual({ method: 'sameTree' })
    // The attributes gone, the commits and the head the same: the replay conflicts, as git says now (a found answer
    // isn't kept).
    writeFileSync(attributes, '')
    expect(await contains(repo, 'main', { base: a, revision: c })).toBeNull()
    // And back: the "not found" is kept for 30 s from when git said it (no replay), then git says found again.
    writeFileSync(attributes, 'f.txt merge=ours\n')
    expect(await counted(() => contains(repo, 'main', { base: a, revision: c }))).toEqual({ v: null, ran: [] })
    vi.setSystemTime(Date.now() + NOT_FOUND_MS)
    expect(await contains(repo, 'main', { base: a, revision: c })).toEqual({ method: 'sameTree' })
  })

  it("a change rewritten is another change: asked again, and a rewrite that isn't in the target is not found", async () => {
    const { repo, a, c, s } = squashed()
    expect(await contains(repo, 'main', { base: a, revision: c })).toEqual({ method: 'squash', commit: s })
    sh(repo, 'switch', '-q', 'line')
    commit(repo, { 'c.txt': 'c, rewritten\n' }, 'c again')
    const rewritten = rev(repo)
    sh(repo, 'switch', '-q', 'main')
    const r = await counted(() => contains(repo, 'main', { base: a, revision: rewritten }))
    expect(r.v).toBeNull()
    expect(r.ran.length).toBeGreaterThan(0)
  })

  it("a target named as a tag too is git's to resolve (the tag first, as rev-parse finds it); unknown answers are never kept", async () => {
    const { repo, a, c } = squashed()
    // A tag "main" at a, where the change isn't: rev-parse's `main` is the tag, so the answer is about a.
    sh(repo, 'tag', 'main', a)
    const tagged = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(tagged.v).toBeNull()
    expect(tagged.ran.some((x) => x[0] === 'rev-parse' && x.includes('main^{commit}'))).toBe(true)
    // Packed, the same.
    sh(repo, 'pack-refs', '--all')
    const packed = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(packed.v).toBeNull()
    expect(packed.ran.some((x) => x[0] === 'rev-parse' && x.includes('main^{commit}'))).toBe(true)
    const missing = 'f'.repeat(40)
    for (let i = 0; i < 2; i++) {
      const u = await counted(() => contains(repo, 'line', { base: a, revision: missing }))
      expect(isUnknown(u.v)).toBe(true)
      expect(u.ran.length).toBeGreaterThan(0)
    }
  })

  it('never answered from what was kept while a replace ref is there', async () => {
    const { repo, a, c, s } = squashed()
    expect(await contains(repo, 'main', { base: a, revision: c })).toEqual({ method: 'squash', commit: s })
    sh(repo, 'replace', s, a)
    const r = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(r.ran.length).toBeGreaterThan(0)
    expect(r.v).not.toEqual({ method: 'squash', commit: s })
  })

  it('a second reconcile pass over an unchanged Done card, squash-merged outside Combwork, starts no git', async () => {
    const e = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], finish: 'agentMerges', review: 'none', noSelfReview: false })
    try {
      const card = e.wf.createCard({ title: 'Squashed' })
      const st = await e.wf.start(card.key, B1)
      moved(st)
      const folder = st.data!.folder as string
      commit(folder, { 'src/fix.txt': 'fixed\n' }, `${card.key}: fix`)
      moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
      const line = e.wf.state(card).started!.line!
      sh(e.project, 'merge', '-q', '--squash', line)
      sh(e.project, 'commit', '-q', '-m', `${card.key} (squash)`)
      await reconcile(e.wf, card)
      expect(e.wf.state(card).stage).toBe('done')
      expect(e.wf.state(card).integrated).toMatchObject({ method: 'squash', by: 'outside' })
      // The pass that follows, with nothing new: no git at all.
      await reconcile(e.wf, card)
      const again = await counted(() => reconcile(e.wf, card))
      expect(again.ran).toEqual([])
      expect(e.wf.state(card).marks.leftTarget).toBeFalsy()
      // The target reset off the result: the change is looked for, isn't there, and the card is marked as left.
      sh(e.project, 'reset', '-q', '--hard', 'HEAD~1')
      const reset = await counted(() => reconcile(e.wf, card))
      expect(reset.ran.length).toBeGreaterThan(0)
      expect(e.wf.state(card).marks.leftTarget).toBeTruthy()
      expect(e.wf.state(card).stage).toBe('done')
    } finally {
      e.close()
    }
  })
})

describe('"not found" kept for 30 s from when git said it (HI-2189, the user\'s decision)', () => {
  /** main (a, then t), a line from a with its change (c) that isn't in main: ids of each. */
  function waiting(): { repo: string; a: string; c: string; t: string } {
    const repo = join(tempDir('notfound-'), 'repo')
    gitRepo(repo)
    const a = rev(repo)
    sh(repo, 'switch', '-q', '-c', 'line')
    const c = commit(repo, { 'c.txt': 'c\n' }, 'c')
    sh(repo, 'switch', '-q', 'main')
    const t = commit(repo, { 't.txt': 't\n' }, 't')
    return { repo, a, c, t }
  }
  const replays = (ran: string[][]): number => ran.filter((x) => x[0] === 'merge-tree').length

  it('expires 30 s after git computed it, however often it is used; a new target head or revision is asked at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { repo, a, c } = waiting()
    const first = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(first.v).toBeNull()
    expect(replays(first.ran)).toBe(1)
    // Used at 10, 20 and 29.9 s: no git, and never extended by the use.
    const t0 = Date.now()
    for (const at of [10_000, 20_000, NOT_FOUND_MS - 100]) {
      vi.setSystemTime(t0 + at)
      expect(await counted(() => contains(repo, 'main', { base: a, revision: c }))).toEqual({ v: null, ran: [] })
    }
    vi.setSystemTime(t0 + NOT_FOUND_MS)
    const expired = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(expired.v).toBeNull()
    expect(replays(expired.ran)).toBe(1)
    // A new commit on the target: another head, asked at once (and squashed there: found).
    sh(repo, 'merge', '-q', '--squash', 'line')
    sh(repo, 'commit', '-q', '-m', 'squash of line')
    const onto = await counted(() => contains(repo, 'main', { base: a, revision: c }))
    expect(onto.v).toEqual({ method: 'squash', commit: rev(repo) })
    // A new revision of the change: other endpoints, asked at once.
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
    sh(repo, 'switch', '-q', 'line')
    const c2 = commit(repo, { 'c.txt': 'c, again\n' }, 'c again')
    sh(repo, 'switch', '-q', 'main')
    const again = await counted(() => contains(repo, 'main', { base: a, revision: c2 }))
    expect(again.v).toBeNull()
    expect(replays(again.ran)).toBe(1)
  })

  it("a long step's own answer never outlives 30 s, inside it or in a pass after it (HR2's round 1 finding)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const repo = join(tempDir('notfound-step-'), 'repo')
    gitRepo(repo)
    const a = commit(repo, { 'f.txt': 'base\n' }, 'base')
    sh(repo, 'switch', '-q', '-c', 'line')
    const c = commit(repo, { 'f.txt': 'change\n' }, 'change')
    sh(repo, 'switch', '-q', 'main')
    commit(repo, { 'f.txt': 'target\n' }, 'target')
    const zero = Date.now()
    await gitStep(async () => {
      expect(await contains(repo, 'main', { base: a, revision: c })).toBeNull()
      // Past 30 s in the same step: git again, not the step's answer.
      vi.setSystemTime(zero + NOT_FOUND_MS + 1)
      const late = await counted(() => contains(repo, 'main', { base: a, revision: c }))
      expect(late.v).toBeNull()
      expect(replays(late.ran)).toBe(1)
    })
    // The attributes now make it found: a pass after the step is answered by what git computed at 30.001 s, until 60.001 s.
    sh(repo, 'config', 'merge.ours.driver', 'true')
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'f.txt merge=ours\n')
    vi.setSystemTime(zero + 2 * NOT_FOUND_MS)
    expect(await counted(() => contains(repo, 'main', { base: a, revision: c }))).toEqual({ v: null, ran: [] })
    vi.setSystemTime(zero + 2 * NOT_FOUND_MS + 1)
    expect(await contains(repo, 'main', { base: a, revision: c })).toEqual({ method: 'sameTree' })
  })

  it('an answer that took 30 s or more to compute is given but not kept; one whose repository stopped being plain is not used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { repo, a, c, t } = waiting()
    // The clock passes 30 s while the replay runs.
    gitTestHooks.started = (_cwd, args) => {
      if (args[0] === 'merge-tree') vi.setSystemTime(Date.now() + NOT_FOUND_MS)
    }
    expect(await contains(repo, 'main', { base: a, revision: c })).toBeNull()
    gitTestHooks.started = undefined
    expect(replays((await counted(() => contains(repo, 'main', { base: a, revision: c }))).ran)).toBe(1)
    // Kept now; a replace ref makes the repository not plain: git is asked.
    expect((await counted(() => contains(repo, 'main', { base: a, revision: c }))).ran).toEqual([])
    sh(repo, 'replace', t, a)
    expect((await counted(() => contains(repo, 'main', { base: a, revision: c }))).ran.length).toBeGreaterThan(0)
  })

  it("never kept from a routed git (the merge queue's host: another process, its own environment)", async () => {
    const { repo, a, c } = waiting()
    let routed = 0
    const route = (m: Parameters<typeof runGit>[0]) => (routed++, runGit(m))
    for (let i = 0; i < 2; i++) expect(await withGitRoute(route, () => contains(repo, 'main', { base: a, revision: c }))).toBeNull()
    const n = routed
    expect(await withGitRoute(route, () => contains(repo, 'main', { base: a, revision: c }))).toBeNull()
    expect(routed).toBeGreaterThan(n)
    // Nor does a routed run use one kept by the worker's.
    expect(await contains(repo, 'main', { base: a, revision: c })).toBeNull()
    const m = routed
    expect(await withGitRoute(route, () => contains(repo, 'main', { base: a, revision: c }))).toBeNull()
    expect(routed).toBeGreaterThan(m)
  })

  it.each(['approved', 'review'] as const)('a second reconcile pass over an unchanged %s card not merged yet starts no git (the measurement of HI-2189)', async (stage) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const e = setup({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', target: 'main', okBefore: { mode: 'every', labels: [] } })
    try {
      const card = e.wf.createCard({ title: 'Waiting' })
      moved(await e.wf.start(card.key, B1))
      commit(e.wf.folderOf(e.wf.state(card)), { 'a.txt': 'a\n' }, `${card.key}: work`)
      // The target moves on, so the card's revision isn't its ancestor: the squash and same-tree tests run.
      commit(e.project, { 'm.txt': 'm\n' }, 'target moves')
      moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
      if (stage === 'approved') {
        moved(await e.wf.startReview(card.key, R1))
        moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
      }
      expect(e.wf.state(card).stage).toBe(stage)
      // Past whatever the moves themselves kept (an approval looks for the change too).
      vi.setSystemTime(Date.now() + NOT_FOUND_MS)
      const first = await counted(() => reconcile(e.wf, card))
      const second = await counted(() => reconcile(e.wf, card))
      vi.setSystemTime(Date.now() + NOT_FOUND_MS)
      const later = await counted(() => reconcile(e.wf, card))
      // The counts, for the card's run record: before HI-2189 every pass was like the first.
      console.log(`HI-2189 ${stage}: first pass ${first.ran.length} gits (${first.ran.map((x) => x[0]).join(', ')}); second ${second.ran.length}; after 30 s ${later.ran.length}`)
      expect(replays(first.ran)).toBe(1)
      expect(second.ran).toEqual([])
      expect(replays(later.ran)).toBe(1)
      expect(e.wf.state(card).stage).toBe(stage)
    } finally {
      e.close()
    }
  })
})
