// SPEC §16.18's merge-queue scenarios at the core (#1118), on real temporary repositories: red merge checks, a clean
// install for a changed manifest, the user's OK, races with the target, requeues, restarts and decisions.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { MergeQueue } from '../../src/main/workflow/mergeQueue'
import { Workflow } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (over: Partial<ReturnType<typeof preset>> = {}, extra: Parameters<typeof setup>[1] = {}) =>
  (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' }, ...over }, extra))

/** A card approved and queued: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env, title = 'Change', files: Record<string, string> = { 'src/c.txt': 'c\n' }, labels: string[] = []) {
  const card = e.wf.createCard({ title, labels })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  // With actions left pending (a crash's view), the folder is prepared here.
  if (e.wf.cfg.autoRun === false) await e.wf.runActions()
  const folder = s.data!.folder as string
  commit(folder, files, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card, folder }
}

const mainHead = (e: Env) => sh(e.project, 'rev-parse', 'main')

describe('the merge queue', () => {
  it('merges an approved card with Hive\'s trailers, and the lane ends verified with the result revision', async () => {
    const e = team()
    const { card } = await queued(e)
    e.wf.startLane('L1', [card.id], 'R1')
    expect(e.wf.state(card).stage).toBe('merging')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ by: 'hive', method: 'merge', result: mainHead(e) })
    const msg = sh(e.project, 'log', '-1', '--format=%B', 'main')
    expect(msg).toContain(`Hive-Card: ${card.key}`)
    expect(msg).toContain(`Hive-Revision: ${s.latest!.revision}`)
    expect(msg).toContain('Hive-Reviewed-By: R1')
    // The submitted revision is pinned.
    expect(sh(e.project, 'rev-parse', `refs/hive/cards/${card.key.toLowerCase()}/1`)).toBe(s.latest!.revision)
  })

  it('S4: red merge checks on the combination → the target doesn\'t move; IntegrationFailed; back to its builder with the output', async () => {
    const e = team()
    const { card } = await queued(e)
    const before = mainHead(e)
    const q = e.queue({ runCheck: async () => ({ ok: false, output: '3 failing tests' }) })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks', transient: false })
    expect(mainHead(e)).toBe(before)
    const s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.entries.at(-1)?.failure).toMatchObject({ reason: 'checks', log: '3 failing tests' })
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('merge queue'))).toBe(true)
  })

  it('S7: a hand merge of an approved card is observed → Done (outside); the queue drops the entry; the lane counts it', async () => {
    const e = team()
    const { card, folder } = await queued(e)
    e.wf.startLane('L', [card.id], 'R1')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', sh(folder, 'rev-parse', 'HEAD'))
    await reconcile(e.wf, card)
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ by: 'outside' })
    expect(s.entries.at(-1)?.state).toBe('cancelled')
    expect(await e.queue().runOnce('main')).toBeNull()
    expect(e.store.deliveries().some((d) => d.kind === 'laneEnded' && d.target === 'L')).toBe(true)
  })

  it('S13: a package missing from package.json while the warm worktree still has it → the queue installs clean and the checks fail', async () => {
    const e = team({}, { files: {} })
    commit(e.project, { 'package.json': '{"dependencies":{"left-pad":"1"}}\n', 'index.js': "require('left-pad')\n", '.gitignore': 'node_modules/\n' }, 'deps')
    // A fake install: node_modules from package.json's dependencies (clean: from scratch).
    const install = async (folder: string, clean: boolean) => {
      if (clean) rmSync(join(folder, 'node_modules'), { recursive: true, force: true })
      const deps = Object.keys(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).dependencies ?? {})
      for (const d of deps) mkdirSync(join(folder, 'node_modules', d), { recursive: true })
      return { ok: true, output: '' }
    }
    // A fake check: every require() resolves in node_modules.
    const runCheck = async (_: string, __: string, folder: string) => {
      const missing = readdirSync(folder)
        .filter((f) => f.endsWith('.js'))
        .flatMap((f) => [...readFileSync(join(folder, f), 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]))
        .filter((d) => !existsSync(join(folder, 'node_modules', d)))
      return { ok: !missing.length, output: missing.length ? `Cannot find module '${missing[0]}'` : '' }
    }
    const q = e.queue({ install, runCheck })
    // A first card warms the queue's worktree, installing left-pad and is-odd (in package.json then).
    const { card: c1 } = await queued(e, 'Add is-odd', { 'package.json': '{"dependencies":{"left-pad":"1","is-odd":"1"}}\n' })
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(c1).stage).toBe('done')
    // The next card uses is-odd but drops it from package.json: the warm folder still has it.
    const { card: c2 } = await queued(e, 'Use is-odd', { 'package.json': '{"dependencies":{"left-pad":"1"}}\n', 'odd.js': "require('is-odd')\n" })
    const before = mainHead(e)
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
    expect(e.wf.state(c2).entries.at(-1)?.failure?.log).toContain("Cannot find module 'is-odd'")
    expect(mainHead(e)).toBe(before)
  })

  it('S14: a release card under "your OK for release" waits on For you (Approve); the user approves → merged', async () => {
    const e = team({ okBefore: { mode: 'labels', labels: ['ui', 'release'] } })
    const { card } = await queued(e, 'Release 1.0', { 'VERSION': '1.0\n' }, ['release'])
    let s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(await e.queue().runOnce('main')).toBeNull()
    const req = s.requests[0]
    expect(req).toMatchObject({ kind: 'approve', gate: 'okBefore' })
    expect(e.notes.length).toBeGreaterThan(0)
    moved(await e.wf.answer(card.key, req.request, 'approved'))
    expect(e.wf.state(card).stage).toBe('merging')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.generation).toBe(0)
  })

  // One case each (#1380: both in one test took 16.7 s alone, 138 gits, and timed out at 20 s under a loaded full run).
  for (const checkedOut of [false, true]) {
    it(`S27: the target moves between the test and the advance → tested again, never an untested advance (${checkedOut ? 'in the project folder' : 'checked out nowhere'})`, async () => {
      const e = team()
      if (!checkedOut) sh(e.project, 'checkout', '-q', '--detach')
      const { card } = await queued(e)
      let moves = 0
      const q = e.queue({
        hooks: {
          afterChecks: () => {
            // Someone commits on main after the checks, once.
            if (moves++) return
            if (checkedOut) commit(e.project, { 'race.txt': 'race\n' }, 'race')
            else sh(e.project, 'update-ref', 'refs/heads/main', commit(e.project, { 'race.txt': 'race\n' }, 'race'))
          }
        }
      })
      const [o] = await q.drain('main')
      expect(o).toMatchObject({ outcome: 'integrated', retests: 1 })
      // The merge's first parent is the moved target: it was tested against it.
      expect(sh(e.project, 'log', '-1', '--format=%s', 'main^1')).toBe('race')
      expect(e.wf.state(card).stage).toBe('done')
      if (checkedOut) expect(readFileSync(join(e.project, 'src/c.txt'), 'utf8')).toBe('c\n')
    })
  }

  // The transient and the red check each in their own case (#1380, as S27).
  it('S32: a transient merge check failure requeues unchanged at most twice', async () => {
    const e = team()
    const { card } = await queued(e)
    const transient = e.queue({ runCheck: async () => ({ ok: false, transient: true, output: 'npm ERR! network' }) })
    expect((await transient.drain('main'))[0]).toMatchObject({ outcome: 'returned', transient: true })
    for (let i = 0; i < 2; i++) {
      const r = await e.wf.submit(card.key, B1, { summary: 'again' })
      moved(r)
      expect(r.data).toMatchObject({ requeued: true })
      expect(e.wf.state(card).rounds).toBe(0)
      expect((await transient.drain('main'))[0]).toMatchObject({ outcome: 'returned', transient: true })
    }
    const limit = refusedBy(await e.wf.submit(card.key, B1, { summary: 'again' }), 'requeue.allowed')
    expect(limit.message).toContain('sent back unchanged 2 times already')
  })

  it("S32: a red check needs a new revision or the user's Retry merge", async () => {
    // A red check is a result: refused; the user's Retry merge (an override) requeues it once.
    const r2 = team()
    const c2 = await queued(r2)
    expect((await r2.queue({ runCheck: async () => ({ ok: false, output: 'red' }) }).drain('main'))[0]).toMatchObject({ outcome: 'returned', transient: false })
    refusedBy(await r2.wf.submit(c2.card.key, B1, { summary: 'again' }), 'requeue.allowed')
    moved(await r2.wf.retryMerge(c2.card.key, 'flaky test, known'))
    expect(r2.wf.state(c2.card).overrides).toMatchObject([{ rules: ['requeue.allowed'] }])
    expect((await r2.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
  })

  it("#1362: a transient check's IntegrationFailed records why, as codes (its cause and the network code); a red one's says nothing of it", async () => {
    const e = team()
    const { card } = await queued(e)
    await e.queue({ runCheck: async () => ({ ok: false, transient: true, cause: { cause: 'network', code: 'ENOTFOUND' }, output: 'npm error code ENOTFOUND' }) }).drain('main')
    const failed = () => e.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').map((f) => f.data)
    expect(failed().at(-1)).toMatchObject({ reason: 'checks', transient: true, cause: 'network', code: 'ENOTFOUND' })
    moved(await e.wf.submit(card.key, B1, { summary: 'again' }))
    await e.queue({ runCheck: async () => ({ ok: false, output: '1 test failed' }) }).drain('main')
    const red = failed().at(-1)!
    expect(red).toMatchObject({ reason: 'checks', transient: false })
    expect(red).not.toHaveProperty('cause')
    expect(red).not.toHaveProperty('code')
  })

  it('S33: restarts — a removed entry never merges; a wake is delivered once; an advance before Integrated is reconciled, never merged twice', async () => {
    const e = team({}, { autoRun: false })
    sh(e.project, 'checkout', '-q', '--detach')
    // (a) Remove from queue, then a restart: the rebuilt queue skips it.
    const a = await queued(e, 'Removed')
    moved(await e.wf.removeFromQueue(a.card.key, 'not now'))
    const restarted = () => {
      const store = e.reopen()
      const wf = new Workflow({ ...e.wf.cfg, store, autoRun: false })
      return { wf, store, q: new MergeQueue(wf, { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }) }) }
    }
    let r = restarted()
    expect(r.q.entries('main')).toEqual([])
    r.store.close()

    // (b) After the fact commit and before the reviewer's wake: delivered once after the restart, even run twice.
    const b = e.wf.createCard({ title: 'Wake' })
    // The reviewer to wake is its lane's (#1291).
    e.wf.startLane('Lb', [b.id], 'R1')
    const sb = await e.wf.start(b.key, B1)
    moved(sb)
    await e.wf.runActions()
    const delivered = e.store.deliveries().length
    commit(sb.data!.folder as string, { 'w.txt': 'w\n' }, 'w')
    moved(await e.wf.submit(b.key, B1, { summary: 'x' }))
    expect(e.store.deliveries().length).toBe(delivered)
    r = restarted()
    await r.wf.runActions()
    await r.wf.runActions()
    expect(r.store.deliveries().filter((d) => d.kind === 'wake' && d.target === 'R1' && String(d.payload.why).includes(b.key))).toHaveLength(1)
    r.store.close()

    // (c) The target advanced, then a crash before `Integrated`: reconciled as Integrated (observed), never merged twice.
    const c = await queued(e, 'Crash')
    await e.wf.runActions()
    const crashing = e.queue({ hooks: { afterAdvance: () => Promise.reject(new Error('crash')) } })
    await expect(crashing.drain('main')).rejects.toThrow('crash')
    const advanced = mainHead(e)
    expect(e.wf.state(c.card).entries.at(-1)?.state).toBe('started')
    r = restarted()
    expect(await r.q.recover()).toEqual([{ card: c.card.key, entry: expect.any(String), outcome: 'integrated' }])
    expect(r.wf.state(c.card).stage).toBe('done')
    expect(r.wf.state(c.card).integrated).toMatchObject({ result: advanced })
    expect(await r.q.drain('main')).toEqual([])
    expect(mainHead(e)).toBe(advanced)
    r.store.close()
  })

  it('S57 (e, f): a decision after the checks and before the advance stops it; after IntegrationStarted it merges, then For you; a no-review Merging card returns to Active', async () => {
    const e = team()
    sh(e.project, 'checkout', '-q', '--detach')
    const { card } = await queued(e)
    const before = mainHead(e)
    const stopped = await e.queue({ hooks: { afterChecks: async () => void (await e.wf.recordDecision(card.key, 'Wait')) } }).drain('main')
    expect(stopped[0]).toMatchObject({ outcome: 'skipped', why: 'cancelled' })
    expect(mainHead(e)).toBe(before)
    expect(e.wf.state(card).stage).toBe('review')

    const { card: late } = await queued(e, 'Late decision', { 'late.txt': 'l\n' })
    await e.queue({ hooks: { afterStarted: async () => void (await e.wf.recordDecision(late.key, 'Too late')) } }).drain('main')
    const s = e.wf.state(late)
    expect(s.stage).toBe('done')
    expect(s.requests.at(-1)).toMatchObject({ kind: 'decide', gate: 'decision' })
    e.close()

    const n = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [] }))
    const c = n.wf.createCard({ title: 'No review' })
    const st = await n.wf.start(c.key, B1)
    moved(st)
    commit(st.data!.folder as string, { 'n.txt': 'n\n' }, 'n')
    moved(await n.wf.submit(c.key, B1, { summary: 'x' }))
    expect(n.wf.state(c).stage).toBe('merging')
    moved(await n.wf.recordDecision(c.key, 'Changed'))
    expect(n.wf.state(c).stage).toBe('active')
    expect(n.wf.state(c).entries.at(-1)?.state).toBe('cancelled')
  })

  it('S46: an approved card squash-merged by hand and its line deleted → Integrated (squash) from the stored key; the pin keeps the revision; deleting after Done changes nothing', async () => {
    const e = team()
    const { card, folder } = await queued(e)
    const rev = sh(folder, 'rev-parse', 'HEAD')
    const line = e.wf.state(card).started!.line!
    sh(e.project, 'merge', '-q', '--squash', rev)
    sh(e.project, 'commit', '-q', '-m', 'squashed by hand')
    sh(e.project, 'worktree', 'remove', '--force', folder)
    sh(e.project, 'branch', '-q', '-D', line)
    await reconcile(e.wf, card)
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ method: 'squash', by: 'outside' })
    expect(sh(e.project, 'rev-parse', `refs/hive/cards/${card.key.toLowerCase()}/1`)).toBe(rev)
    const n = e.store.facts(card.id).length
    await reconcile(e.wf, card)
    expect(e.store.facts(card.id).length).toBe(n)
  })

  it('S37: AM-13 started after AM-12\'s hand squash excludes its work; AM-12 still answers from its key; a reset target marks it, Done stays', async () => {
    const e = team({ finish: 'agentMerges' })
    const { card: a, folder } = await queued(e, 'AM-12 work', { 'twelve.txt': '12\n' })
    const squashBase = mainHead(e)
    sh(e.project, 'merge', '-q', '--squash', sh(folder, 'rev-parse', 'HEAD'))
    sh(e.project, 'commit', '-q', '-m', 'squash 12')
    const line = e.wf.state(a).started!.line!
    sh(e.project, 'worktree', 'remove', '--force', folder)
    sh(e.project, 'branch', '-q', '-D', line)
    await reconcile(e.wf, a)
    expect(e.wf.state(a)).toMatchObject({ stage: 'done' })
    const b = e.wf.createCard({ title: 'AM-13 work' })
    const sb = await e.wf.start(b.key, B1)
    moved(sb)
    commit(sb.data!.folder as string, { 'thirteen.txt': '13\n' }, '13')
    moved(await e.wf.submit(b.key, B1, { summary: 'x' }))
    expect(e.wf.state(b).latest!.files.map((f) => f.path)).toEqual(['thirteen.txt'])
    sh(e.project, 'reset', '-q', '--hard', squashBase)
    await reconcile(e.wf, a)
    const s = e.wf.state(a)
    expect(s.stage).toBe('done')
    expect(s.marks.leftTarget).toMatchObject({ target: 'main' })
  })

  it('a checked-out target: the user\'s edit in a file the merge changes pauses before anything is touched; their edits are kept', async () => {
    const e = team()
    const { card } = await queued(e, 'Touch a', { 'src/a.txt': 'card\n' })
    writeFileSync(join(e.project, 'src/a.txt'), 'the user is editing\n')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'unstagedChanges', files: ['src/a.txt'] })
    expect(readFileSync(join(e.project, 'src/a.txt'), 'utf8')).toBe('the user is editing\n')
    expect(e.wf.state(card).stage).toBe('merging')
    expect(e.store.facts(card.id).some((f) => f.kind === 'IntegrationStarted')).toBe(false)
  })
})
