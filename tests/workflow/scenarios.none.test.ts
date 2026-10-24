// SPEC §16.18's scenarios for None at the core (#1118): no version control, not no workflow. A card's revision is the
// content hash of its declared paths; acceptance needs those paths to still hash to the approved revision.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, moved, put, R1, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { runCheck } from '../../src/main/workflow/checks'
import { detect, offer } from '../../src/main/platform/registry'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const files = { 'docs/a.md': 'a\n', 'docs/b.md': 'b\n', 'shared.md': 's\n' }

describe('workflow scenarios, None', () => {
  it('S18: a reviewer agent, then you: pass → For you → approve → Accepted → Done; an edit in its paths before the approval → Stale → Review; outside its paths, nothing', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'Docs A', paths: ['docs/a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'docs/a.md', 'a, written\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'a' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    let s = e.wf.state(card)
    // Your OK after the reviewer agent is asked in Approved (§16.5.2, N1; decided on #1417).
    expect(s.stage).toBe('approved')
    const ask = s.requests[0]
    expect(ask).toMatchObject({ gate: 'review', stage: 'approved' })
    // Outside its paths: nothing changes.
    put(e.project, 'docs/b.md', 'b edited\n')
    await reconcile(e.wf, card)
    expect(e.wf.state(card).stale).toBeNull()
    // In its paths, before the approval: the approval can't accept it.
    put(e.project, 'docs/a.md', 'a, edited after the pass\n')
    moved(await e.wf.answer(card.key, ask.request, 'approved'))
    s = e.wf.state(card)
    expect(s.stage).toBe('review')
    expect(s.stale?.why).toBe('change')
    expect(s.accepted).toBeNull()
    // Submitted again, passed, approved: accepted as it is now.
    moved(await e.wf.submit(card.key, B1, { summary: 'a again' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    moved(await e.wf.answer(card.key, e.wf.state(card).requests[0].request, 'approved'))
    s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.accepted?.revision).toBe(s.latest!.revision)
  })

  it('S18: your decline in Approved sends it back to its builder in Active (#1417)', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'Docs A', paths: ['docs/a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'docs/a.md', 'a, written\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'a' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(card).stage).toBe('approved')
    moved(await e.wf.answer(card.key, e.wf.state(card).requests[0].request, 'declined', { note: 'Not yet' }))
    expect(e.wf.state(card).stage).toBe('active')
    expect(e.wf.state(card).requests).toEqual([])
  })

  it('S2, S6 (None): a comment never moves an approved card; the builder can\'t review its own', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'Docs', paths: ['docs/a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'docs/a.md', 'new\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    refusedBy(await e.wf.startReview(card.key, B1), 'review.notAuthor')
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    moved(e.wf.comment(card.key, B1))
    expect(e.wf.state(card).stage).toBe('approved')
    expect(e.wf.state(card).requests).toHaveLength(1)
  })

  it('S5 (None): a decision after the pass returns it to Review; the reviewer confirms after receiving it', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files }))
    const card = e.wf.createCard({ title: 'Docs', paths: ['docs/a.md'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'docs/a.md', 'new\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.recordDecision(card.key, 'Shorter'))
    refusedBy(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }), 'review.decisionsReceived')
    await e.wf.received(card.key, 'R1')
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'meets it' }))
    expect(e.wf.state(card).requests.at(-1)).toMatchObject({ gate: 'review' })
  })

  it('S38 (None): a no-code card with no review → submit → Done; no revision', async () => {
    const e = (env = setup({ platform: 'none' }, { files }))
    const card = e.wf.createCard({ title: 'Think', kind: 'no-code' })
    moved(await e.wf.start(card.key, B1))
    moved(await e.wf.submit(card.key, B1, { summary: 'thought' }))
    const s = e.wf.state(card)
    expect(s).toMatchObject({ stage: 'done', integrated: null })
    expect(s.latest!.revision).toBeNull()
    expect(s.accepted).toEqual({ submission: s.latest!.id })
  })

  it('S45: two agents, two cards, one folder: B\'s own files leave A\'s pass; a shared file makes it stale; a formatter and an editor are unclaimed; a hooks-free card declares its paths', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files }))
    const a = e.wf.createCard({ title: 'A', paths: ['docs/a.md', 'shared.md'] })
    const b = e.wf.createCard({ title: 'B', paths: ['docs/b.md', 'shared.md'] })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    put(e.project, 'docs/a.md', 'A\n')
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    moved(await e.wf.startReview(a.key, R1))
    moved(await e.wf.verdict(a.key, R1, { pass: true, comment: 'ok' }))
    put(e.project, 'docs/b.md', 'B\n')
    await reconcile(e.wf, a)
    expect(e.wf.state(a).stale).toBeNull()
    put(e.project, 'shared.md', 'B changes the shared file\n')
    await reconcile(e.wf, a)
    expect(e.wf.state(a).stale?.why).toBe('change')
    expect(e.wakes.some((w) => w.agent === 'B1' && w.why.includes('changed since the pass'))).toBe(true)

    // A formatter run by C's agent while D's agent is active, and the user's editor: unclaimed at C's submit.
    const c = e.wf.createCard({ title: 'C' })
    moved(await e.wf.start(c.key, agentC))
    put(e.project, 'fmt/one.md', 'formatted\n')
    e.wf.noteWrite('fmt/one.md', { agents: ['C1', 'B2'], user: false })
    put(e.project, 'notes.md', 'the user typed this\n')
    e.wf.noteWrite('notes.md', { agents: [], user: true })
    put(e.project, 'c.md', 'C own\n')
    e.wf.noteEdit(c, 'c.md')
    const declared = await e.wf.declarePaths(c.key, agentC, ['c.md'])
    if (isRefusal(declared)) throw new Error(declared.message)
    expect(declared.prefill).toEqual(['c.md'])
    expect(declared.unclaimed).toEqual(expect.arrayContaining(['fmt/one.md', 'notes.md']))
    // C claims the formatter's file.
    moved(await e.wf.submit(c.key, agentC, { summary: 'C', paths: ['c.md', 'fmt/one.md'] }))
    expect(e.wf.state(c).latest!.paths).toEqual(['c.md', 'fmt/one.md'])

    // A hooks-free session: an empty pre-fill; the builder declares its paths at submit.
    const d = e.wf.createCard({ title: 'D' })
    moved(await e.wf.start(d.key, agentD))
    put(e.project, 'd.md', 'D\n')
    const dd = await e.wf.declarePaths(d.key, agentD, [])
    if (isRefusal(dd)) throw new Error(dd.message)
    expect(dd.prefill).toEqual([])
    moved(await e.wf.submit(d.key, agentD, { summary: 'D', paths: ['d.md'] }))
  })

  it('S61: None, Pair, hooks-free, first submission: declare paths, a counted check, submit; a path added or edited after the run no longer counts', async () => {
    const e = (env = setup({ ...preset('none', 'pair', { quick: ['lint'], tests: [] }), commands: { lint: 'npm run lint' } }, { files }))
    const card = e.wf.createCard({ title: 'Lint me' })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'docs/a.md', 'changed\n')
    const declared = await e.wf.declarePaths(card.key, B1, ['docs/a.md'])
    if (isRefusal(declared)) throw new Error(declared.message)
    expect(declared.prefill).toEqual([])
    const run = await runCheck(e.wf, { card: e.store.card(card.id), name: 'lint', by: 'B1', exec: async () => ({ ok: true }) })
    expect(run).toMatchObject({ counted: true, revision: declared.revision })
    // Adding a path after the run: a new revision, the run doesn't count.
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x', paths: ['docs/a.md', 'docs/b.md'] }), 'submit.checksPassed')
    // Back to the declared paths: it counts again.
    moved(await e.wf.submit(card.key, B1, { summary: 'x', paths: ['docs/a.md'] }))
    const other = e.wf.createCard({ title: 'Edit after the run' })
    moved(await e.wf.start(other.key, B2))
    put(e.project, 'docs/b.md', 'changed\n')
    await e.wf.declarePaths(other.key, B2, ['docs/b.md'])
    await runCheck(e.wf, { card: e.store.card(other.id), name: 'lint', by: 'B2', exec: async () => ({ ok: true }) })
    put(e.project, 'docs/b.md', 'changed again\n')
    refusedBy(await e.wf.submit(other.key, B2, { summary: 'x' }), 'submit.checksPassed')
    // A deliverable written during the run: uncounted.
    const during = await runCheck(e.wf, { card: e.store.card(other.id), name: 'lint', by: 'B2', exec: async () => (writeFileSync(join(e.project, 'docs/a.md'), 'written during\n'), { ok: true }) })
    expect(during).toMatchObject({ counted: false, whyNot: 'changed' })
  })

  // #1511 (decided: refuse): a card's paths narrow the deliverables, never widen them.
  it('#1511: a path under node_modules, .venv, .git or .hive is refused by declare paths and submit; a declared folder leaves its excluded descendants out; paths stored from before are left out of the revision, and said so', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [] }, { files: { 'src/a.md': 'a\n', 'src/node_modules/y.js': 'y\n', 'node_modules/pad/index.js': 'pad\n', '.venv/lib/x.py': 'x\n' } }))
    const card = e.wf.createCard({ title: 'Src', paths: ['src/a.md'] })
    moved(await e.wf.start(card.key, B1))
    for (const [path, folder] of [['node_modules/pad/index.js', 'node_modules'], ['node_modules', 'node_modules'], ['src/node_modules/y.js', 'node_modules'], ['.venv/lib/x.py', '.venv'], ['.git/config', '.git'], ['.hive/project.json', '.hive']]) {
      const r = await e.wf.declarePaths(card.key, B1, ['src/a.md', path])
      expect(isRefusal(r) && r.rule === 'paths.excluded' && r.values).toMatchObject({ path, folder })
      expect(e.wf.store.card(card.id).paths).toEqual(['src/a.md'])
    }
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x', paths: ['src/a.md', 'node_modules/pad/index.js'] }), 'paths.excluded')
    // A declared folder: its excluded descendants are left out, as before (an edit there is no new revision).
    const folder = async () => {
      const r = await e.wf.declarePaths(card.key, B1, ['src'])
      if (isRefusal(r)) throw new Error(r.message)
      return r.revision
    }
    const r1 = await folder()
    put(e.project, 'src/node_modules/y.js', 'y, a cache write\n')
    expect(await folder()).toBe(r1)
    put(e.project, 'src/a.md', 'a, written\n')
    const r2 = await folder()
    expect(r2).not.toBe(r1)
    // Paths stored before #1511 under an excluded folder: the revision is the rest's, and the submit says what it left out.
    e.wf.store.updateCard(card.id, { paths: ['src', 'node_modules/pad/index.js'] })
    const m = await e.wf.submit(card.key, B1, { summary: 'src' })
    moved(m)
    expect(e.wf.state(card).latest?.revision).toBe(r2)
    expect((m as { warnings?: string[] }).warnings?.join(' ')).toMatch(/left out of .*'s revision: node_modules\/pad\/index\.js/)
  })

  it('S20: .git removed → Git\'s rules hold (unknown) and None is offered; a None project gets git init → Git offered', async () => {
    const g = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const card = g.wf.createCard({ title: 'Lost repo' })
    const s = await g.wf.start(card.key, B1)
    moved(s)
    rmSync(join(g.project, '.git'), { recursive: true, force: true })
    expect(offer('git', detect(g.project))).toEqual({ offer: 'none', why: 'repositoryGone' })
    const r = refusedBy(await g.wf.submit(card.key, B1, { summary: 'x' }), 'platform.unknown')
    expect(r.message).toContain("Hive couldn't read")
    g.close()
    const n = (env = setup({ platform: 'none' }, { files }))
    expect(offer('none', detect(n.project))).toBeNull()
    execFileSync('git', ['init', '-q', n.project])
    expect(offer('none', detect(n.project))).toEqual({ offer: 'git', why: 'gitFound' })
  })
})

const agentC = 'agent:C1' as const
const agentD = 'agent:D1' as const
