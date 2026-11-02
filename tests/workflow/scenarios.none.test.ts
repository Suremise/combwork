// SPEC §16.18's scenarios for None at the core (#1118): no version control, not no workflow. A card's revision is the
// content hash of its declared paths; acceptance needs those paths to still hash to the approved revision.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, commit, moved, put, R1, refusedBy, setup, type Env } from './harness'
import { refusalBody } from '../../src/shared/workflow/refusals'
import { refusedText, type Refused } from '../../src/shared/toolReplies'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { runCheck } from '../../src/main/workflow/checks'
import { detect, offer } from '../../src/main/platform/registry'
import { isRefusal } from '../../src/main/workflow/runtime'
import { NoneAdapter } from '../../src/main/platform/none'
import { tempDir } from '../tempDir'

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

  // HR4's #1511 round 1: Windows resolves names whatever their case, so an alias is left out as the name is; and a starting
  // manifest recorded before #1511 holds such a path, which the submitted change leaves out too.
  it('#1511: what is left out matches whatever its case where the file system does (as NoneAdapter is told), never otherwise', () => {
    const dir = tempDir('none-case-')
    expect(new NoneAdapter(dir, ['node_modules', 'Cache'], true).excludedPart('src/NODE_MODULES/x.js')).toBe('NODE_MODULES')
    expect(new NoneAdapter(dir, ['node_modules', 'Cache'], true).excludedPart('cache/x.bin')).toBe('cache')
    expect(new NoneAdapter(dir, ['node_modules'], true).excludedPart('.HIVE/project.json')).toBe('.HIVE')
    expect(new NoneAdapter(dir, ['node_modules'], false).excludedPart('NODE_MODULES/x.js')).toBeNull()
    expect(new NoneAdapter(dir, ['node_modules'], false).excludedPart('node_modules/x.js')).toBe('node_modules')
  })

  it.runIf(process.platform === 'win32')('#1511: on Windows, a case alias of .hive, .git or an excluded folder is refused by both intents, skipped in a folder, left out when stored; a starting manifest from before leaves it out of the change', async () => {
    const e = (env = setup({ ...preset('none', 'team'), preChecks: [], excluded: ['node_modules', '.venv', 'cache'] }, { files: { 'src/a.md': 'a\n', 'src/Node_Modules/y.js': 'y\n', 'node_modules/pad.js': 'p\n', 'cache/x.bin': 'x\n' } }))
    const card = e.wf.createCard({ title: 'Src', paths: ['src/a.md'] })
    moved(await e.wf.start(card.key, B1))
    for (const [path, folder] of [['NODE_MODULES/pad.js', 'NODE_MODULES'], ['.HIVE/project.json', '.HIVE'], ['.Git/config', '.Git'], ['.VENV/lib/x.py', '.VENV'], ['Cache/x.bin', 'Cache']]) {
      const r = await e.wf.declarePaths(card.key, B1, ['src/a.md', path])
      expect(isRefusal(r) && r.rule === 'paths.excluded' && r.values).toMatchObject({ path, folder })
      const sub = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x', paths: ['src/a.md', path] }), 'paths.excluded')
      expect(sub.values).toMatchObject({ path, folder })
      expect(e.wf.store.card(card.id).paths).toEqual(['src/a.md'])
    }
    // A folder's walk skips Node_Modules as node_modules: a write there is no new revision.
    const folder = async () => {
      const r = await e.wf.declarePaths(card.key, B1, ['src'])
      if (isRefusal(r)) throw new Error(r.message)
      return r.revision
    }
    const r1 = await folder()
    put(e.project, 'src/Node_Modules/y.js', 'y, a cache write\n')
    expect(await folder()).toBe(r1)
    // Started before #1511 with NODE_MODULES/pad.js among its paths: its starting manifest holds it. The submission's
    // change leaves it out, as its revision does (never a "D" for a file the card never covered).
    put(e.project, 'src/a.md', 'a, written\n')
    e.wf.store.updateCard(card.id, { paths: ['src', 'NODE_MODULES/pad.js'] })
    const s = e.wf.state(card)
    const legacy = { ...s, started: { ...s.started!, manifest: { ...s.started!.manifest, 'NODE_MODULES/pad.js': 'f00d', 'node_modules/gone.js': 'beef' } } }
    const plan = await e.wf.platform({ ...preset('none', 'team') }).submission(e.wf.store.card(card.id), legacy, preset('none', 'team'), { agent: 'B1', guards: [], predicted: true } as never)
    expect(plan.ok && plan.files.map((f) => f.path)).toEqual(['src/a.md'])
    expect(plan.ok && plan.warnings.join(' ')).toMatch(/left out of .*'s revision: NODE_MODULES\/pad\.js/)
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

// HI-2339 (§16.3.3): a submission names what the card's declared paths leave out (its pre-fill beyond them, and the
// unclaimed changes), for its builder to add or leave: never claimed, the declared paths stay what the revision covers.
describe('None: what a submission leaves out of its paths is named (HI-2339)', () => {
  const warningsOf = (r: unknown): string[] => (r as { warnings?: string[] }).warnings ?? []
  const pairNone = () => (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files: { 'a.txt': 'a\n' } }))

  it("a later round's new file, and a user's edit: the resubmission's refusal names both, through the Agent API and the hive tools; declared, accepted with the new file only", async () => {
    const e = pairNone()
    const card = e.wf.createCard({ title: 'Round two' })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.txt', 'a1\n')
    e.wf.noteEdit(card, 'a.txt')
    moved(await e.wf.submit(card.key, B1, { summary: 'round 1' }))
    expect(e.wf.state(card).latest!.paths).toEqual(['a.txt'])
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'add b' }))
    // Round 2: its agent adds b.txt (recorded in its pre-fill), and the user edits c.txt.
    put(e.project, 'b.txt', 'b\n')
    e.wf.noteEdit(card, 'b.txt')
    put(e.project, 'c.txt', 'the user typed\n')
    e.wf.noteWrite('c.txt', { agents: [], user: true })
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'round 2' }), 'submit.sameRevisionNote')
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings![0]).toMatch(/paths leave out files it recorded as its agents' edits: b\.txt\..*submit with paths listing every file/)
    expect(r.warnings![1]).toMatch(/in neither its paths nor what it recorded as its agents' edits: c\.txt\./)
    // Factual, not attributed: the unclaimed file isn't said to be the user's or anyone's.
    expect(r.warnings![1]).not.toMatch(/user|editor|formatter|not by/)
    // The Agent API's body and the hive tools' text carry them.
    const body = refusalBody(r)
    expect(body.warnings).toEqual(r.warnings)
    const text = refusedText(body as unknown as Refused)
    expect(text.split('\n').slice(-2)).toEqual(r.warnings!.map((w) => `Warning: ${w}`))
    // The builder includes b.txt: accepted with it, c.txt still only named.
    const ok = await e.wf.submit(card.key, B1, { summary: 'round 2', paths: ['a.txt', 'b.txt'] })
    moved(ok)
    expect(e.wf.state(card).latest!.paths).toEqual(['a.txt', 'b.txt'])
    expect(warningsOf(ok).join('\n')).toMatch(/c\.txt/)
    expect(warningsOf(ok).join('\n')).not.toMatch(/b\.txt/)
  })

  it('nothing changed in its paths: submit.unchanged names its pre-fill beyond them', async () => {
    const e = pairNone()
    const card = e.wf.createCard({ title: 'Unchanged', paths: ['a.txt'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'b.txt', 'b\n')
    e.wf.noteEdit(card, 'b.txt')
    const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.unchanged')
    expect(r.warnings).toEqual([expect.stringMatching(/leave out files it recorded as its agents' edits: b\.txt\./)])
    expect(refusalBody(r).warnings).toEqual(r.warnings)
  })

  it("a first submission's overlapping write (two agents active) is named in its reply, not claimed", async () => {
    const e = pairNone()
    const card = e.wf.createCard({ title: 'Overlap' })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.txt', 'a1\n')
    e.wf.noteEdit(card, 'a.txt')
    put(e.project, 'fmt.txt', 'formatted\n')
    e.wf.noteWrite('fmt.txt', { agents: ['B1', 'B2'], user: false })
    const r = await e.wf.submit(card.key, B1, { summary: 'x' })
    moved(r)
    expect(e.wf.state(card).latest!.paths).toEqual(['a.txt'])
    expect(warningsOf(r)).toEqual([expect.stringMatching(/in neither its paths nor what it recorded as its agents' edits: fmt\.txt\./)])
  })

  it("a declared folder covers its files, and not a sibling's sharing its name's start (src, src-other)", async () => {
    const e = pairNone()
    const card = e.wf.createCard({ title: 'Folder' })
    moved(await e.wf.start(card.key, B1))
    for (const f of ['src/x.txt', 'src/deep/y.txt', 'src-other/z.txt']) {
      put(e.project, f, `${f}\n`)
      e.wf.noteWrite(f, { agents: [], user: true })
    }
    for (const declared of [['src'], ['src/'], ['./src'], ['src\\']]) {
      const d = await e.wf.declarePaths(card.key, B1, declared)
      if (isRefusal(d)) throw new Error(d.message)
      expect(d.unclaimed, declared[0]).toEqual(['src-other/z.txt'])
    }
    const r = await e.wf.submit(card.key, B1, { summary: 'x' })
    moved(r)
    expect(warningsOf(r)).toEqual([expect.stringMatching(/: src-other\/z\.txt\./)])
  })

  it('Solo with no version control: its submission (Done, no review) names what its paths leave out too', async () => {
    const e = (env = setup({ ...preset('none', 'solo'), preChecks: [] }, { files: { 'a.txt': 'a\n' } }))
    const card = e.wf.createCard({ title: 'Solo' })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.txt', 'a1\n')
    e.wf.noteEdit(card, 'a.txt')
    put(e.project, 'notes.txt', 'n\n')
    e.wf.noteWrite('notes.txt', { agents: [], user: true })
    const r = await e.wf.submit(card.key, B1, { summary: 'x' })
    moved(r)
    expect(e.wf.state(card).stage).toBe('done')
    expect(warningsOf(r)).toEqual([expect.stringMatching(/: notes\.txt\./)])
  })

  it('a no-code card, and Git, name nothing of the kind', async () => {
    const e = pairNone()
    const nc = e.wf.createCard({ title: 'Decide', kind: 'no-code' })
    moved(await e.wf.start(nc.key, B1))
    put(e.project, 'other.txt', 'o\n')
    e.wf.noteWrite('other.txt', { agents: [], user: true })
    const r = await e.wf.submit(nc.key, B1, { summary: 'decided' })
    moved(r)
    expect(warningsOf(r).join('\n')).not.toMatch(/leave out|neither its paths/)
    env!.close()
    const g = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const card = g.wf.createCard({ title: 'Git' })
    const s = await g.wf.start(card.key, B1)
    moved(s)
    const folder = String((s as { data?: Record<string, unknown> }).data?.folder)
    commit(folder, { 'g.txt': 'g\n' }, 'g')
    // An edit in the project folder, outside the card's: Git's change is its commits, nothing to name.
    put(g.project, 'elsewhere.txt', 'e\n')
    const gr = await g.wf.submit(card.key, B1, { summary: 'g' })
    moved(gr)
    expect(warningsOf(gr).join('\n')).not.toMatch(/leave out|neither its paths/)
  })
})

const agentC = 'agent:C1' as const
const agentD = 'agent:D1' as const
