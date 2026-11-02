// SPEC §16.18's shared-folder scenarios at the core (#1118): several agents committing in the project folder, with the
// card trailer, attribution recorded once, and check runs that count only for what they ran on.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { B1, B2, B3, commit, locked, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile, attributeFolder } from '../../src/main/workflow/reconcile'
import { checkCopy, runCheck } from '../../src/main/workflow/checks'
import { isRefusal } from '../../src/main/workflow/runtime'
import { gitTestHooks } from '../../src/main/git'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

describe('workflow scenarios, several agents in one folder', () => {
  it('S11: all off, three agents on one branch with trailers → cards move freely, facts recorded, G16 warns, nothing refused', async () => {
    const e = (env = setup({ platform: 'git', sharedFolderWarning: true }))
    const cards = ['One', 'Two', 'Three'].map((t) => e.wf.createCard({ title: t }))
    for (const [i, a] of [B1, B2, B3].entries()) moved(await e.wf.start(cards[i].key, a))
    // Each agent's file locks, recorded on its card (#1481).
    for (const [a, f] of [[B1, 'one.txt'], [B2, 'two.txt'], [B3, 'three.txt']] as const) expect(await locked(e.wf, a, [f])).toBe(true)
    commit(e.project, { 'one.txt': '1\n' }, 'one', { trailer: cards[0].key })
    commit(e.project, { 'two.txt': '2\n' }, 'two', { trailer: cards[1].key })
    // B3's commit sweeps in B1's file.
    commit(e.project, { 'three.txt': '3\n', 'one.txt': '1 changed by three\n' }, 'three', { trailer: cards[2].key })
    await attributeFolder(e.wf)
    for (const c of cards) expect(e.kinds(c.id)).toContain('CommitAttributed')
    const r = await e.wf.submit(cards[2].key, B3, { summary: 'three' })
    moved(r)
    expect(r.warnings).toEqual([`one.txt is B1's (${cards[0].key})`])
    expect(e.wf.state(cards[2]).stage).toBe('done')
    // The user drags any card anywhere with no question.
    for (const to of ['done', 'todo', 'active'] as const) expect(await e.wf.move(cards[0].key, to, 'user')).toMatchObject({ ok: true })
    expect(e.store.cards().every((c) => !e.kinds(c.id).includes('Refused'))).toBe(true)
  })

  it('S29: Pair in the project folder (line = target): interleaved commits with trailers never move a card to Done; each change is its own; reviewed, then Done; a commit with no trailer refuses submit', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const a = e.wf.createCard({ title: 'A' })
    const b = e.wf.createCard({ title: 'B' })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const a1 = commit(e.project, { 'a1.txt': 'a\n' }, 'a1', { trailer: a.key })
    commit(e.project, { 'b1.txt': 'b\n' }, 'b1', { trailer: b.key })
    const a2 = commit(e.project, { 'a2.txt': 'a\n' }, 'a2', { trailer: a.key })
    commit(e.project, { 'b2.txt': 'b\n' }, 'b2', { trailer: b.key })
    await reconcile(e.wf, a)
    await reconcile(e.wf, b)
    expect(e.wf.state(a).stage).toBe('active')
    expect(e.wf.state(b).stage).toBe('active')
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    const sa = e.wf.state(a)
    expect(sa.latest).toMatchObject({ revision: a2, commits: [a1, a2] })
    expect(sa.latest!.files.map((f) => f.path).sort()).toEqual(['a1.txt', 'a2.txt'])
    moved(await e.wf.startReview(a.key, R1))
    moved(await e.wf.verdict(a.key, R1, { pass: true, comment: 'ok' }))
    expect(e.wf.state(a)).toMatchObject({ stage: 'done', integrated: { method: 'committed' } })
    // B commits with no trailer while A... (A is done: B is the only unfinished card, so it's B's). Start a third card.
    const c = e.wf.createCard({ title: 'C' })
    moved(await e.wf.start(c.key, B3))
    commit(e.project, { 'b3.txt': 'no trailer\n' }, 'b3')
    const r = refusedBy(await e.wf.submit(b.key, B2, { summary: 'B' }), 'submit.trailer')
    expect(r.next).toContain(`git commit --amend --no-edit --trailer "Hive-Card: ${b.key}"`)
    expect(e.store.folderCommits(e.project).at(-1)).toMatchObject({ card: null, how: 'unattributed' })
  })

  it("HI-2287: a card started in the folder while a submit's attribution reads → it reads again, and the card's own commit is submitted", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const [a, b, c] = ['A', 'B', 'C'].map((t) => e.wf.createCard({ title: t }))
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const b1 = commit(e.project, { 'b.txt': 'b\n' }, 'b', { trailer: b.key })
    // As the lane's start of its next card did in reviewcopies: C starts between the read of the folder's cards and the write.
    let reads = 0
    await attributeFolder(e.wf, {
      afterRead: async () => {
        if (reads++ === 0) moved(await e.wf.start(c.key, B3))
      }
    })
    expect(reads).toBe(2)
    expect(e.store.folderCommits(e.project).find((x) => x.sha === b1)).toMatchObject({ card: b.id, how: 'trailer' })
    moved(await e.wf.submit(b.key, B2, { summary: 'B' }))
    expect(e.wf.state(b).latest).toMatchObject({ revision: b1, commits: [b1] })
  })

  it("HI-2382: a branch merged into the folder's line → its commits, with a trailer or without, stay off the folder's cards; the merge commit is attributed like any of the line's", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }))
    const [a, b, other] = ['A', 'B', 'Merged elsewhere'].map((t) => e.wf.createCard({ title: t }))
    moved(await e.wf.start(a.key, B1))
    // A branch of the line: one commit names another card, one names none.
    sh(e.project, 'checkout', '-q', '-b', 'side')
    const x1 = commit(e.project, { 'x1.txt': 'x\n' }, 'x1', { trailer: other.key })
    const x2 = commit(e.project, { 'x2.txt': 'x\n' }, 'x2')
    sh(e.project, 'checkout', '-q', 'main')
    const own = commit(e.project, { 'a.txt': 'a\n' }, 'a', { trailer: a.key })
    // The merge has no trailer: A, the folder's only unfinished card, made it.
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const merge1 = sh(e.project, 'rev-parse', 'HEAD')
    await attributeFolder(e.wf)
    const rows = () => e.store.folderCommits(e.project).map((r) => ({ sha: r.sha, card: r.card, how: r.how }))
    expect(rows()).toEqual([
      { sha: own, card: a.id, how: 'trailer' },
      { sha: merge1, card: a.id, how: 'onlyCard' }
    ])
    expect(e.kinds(other.id)).not.toContain('CommitAttributed')
    // With two cards unfinished, a merge of another branch takes its trailer; its branch's commit is still nobody's here.
    moved(await e.wf.start(b.key, B2))
    sh(e.project, 'checkout', '-q', '-b', 'side2')
    const y1 = commit(e.project, { 'y1.txt': 'y\n' }, 'y1')
    sh(e.project, 'checkout', '-q', 'main')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merge side2', '-m', `Hive-Card: ${b.key}`, 'side2')
    const merge2 = sh(e.project, 'rev-parse', 'HEAD')
    await attributeFolder(e.wf)
    expect(rows().slice(2)).toEqual([{ sha: merge2, card: b.id, how: 'trailer' }])
    for (const x of [x1, x2, y1]) expect(rows().some((r) => r.sha === x)).toBe(false)
    // A's change is its own commit and the merge it made.
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    expect(e.wf.state(a).latest).toMatchObject({ revision: merge1, commits: [own, merge1] })
  })

  it('S31: check runs: a file edited and restored, HEAD moved and back → uncounted with why; a wrong --revision refused at start', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: ['unit'], mergeChecks: [], commands: { unit: 'npm test' } }))
    const card = e.wf.createCard({ title: 'Checked' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const head = commit(folder, { 'c.txt': 'c\n' }, 'c')
    const edited = await runCheck(e.wf, {
      card,
      name: 'unit',
      by: 'B1',
      exec: async () => {
        writeFileSync(join(folder, 'README.md'), 'edited\n')
        writeFileSync(join(folder, 'README.md'), 'hello\n')
        return { ok: true }
      }
    })
    expect(edited).toMatchObject({ counted: false, whyNot: 'changed' })
    const moved1 = await runCheck(e.wf, {
      card,
      name: 'unit',
      by: 'B1',
      exec: async () => {
        sh(folder, 'checkout', '-q', '--detach', 'HEAD~1')
        sh(folder, 'checkout', '-q', '-')
        return { ok: true }
      }
    })
    expect(moved1).toMatchObject({ counted: false, whyNot: 'changed' })
    refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.checksPassed')
    const wrong = await runCheck(e.wf, { card, name: 'unit', by: 'B1', revision: sh(folder, 'rev-parse', 'HEAD~1'), exec: async () => ({ ok: true }) })
    expect(isRefusal(wrong) && wrong.rule).toBe('check.revisionMismatch')
    const good = await runCheck(e.wf, { card, name: 'unit', by: 'B1', revision: head, exec: async () => ({ ok: true }) })
    expect(good).toMatchObject({ counted: true })
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  })

  it("a check run reads the folder's head from its status before and after, and its git dir from `.git` (#1478: S58's runs were a long chain of gits)", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: ['unit'], mergeChecks: [], commands: { unit: 'npm test' } }))
    const card = e.wf.createCard({ title: 'Counted' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const head = commit(folder, { 'c.txt': 'c\n' }, 'c')
    const ran: string[] = []
    gitTestHooks.started = (_cwd, args) => {
      ran.push(args.join(' '))
    }
    try {
      expect(await runCheck(e.wf, { card, name: 'unit', by: 'B1', exec: async () => ({ ok: true }) })).toMatchObject({ counted: true, revision: head, tested: head })
    } finally {
      gitTestHooks.started = undefined
    }
    expect(ran.filter((c) => c.startsWith('status '))).toHaveLength(2)
    expect(ran.filter((c) => c.includes('--absolute-git-dir'))).toEqual([])
    // The card's revision (its line's head) once; the folder's, before and after, from the status reads.
    expect(ran.filter((c) => c === 'rev-parse --verify -q HEAD')).toHaveLength(1)
  })

  it('S58: shared folder: A submits its own newest commit; B\'s change excludes A\'s; A\'s run while B edits is uncounted, the isolated run counts; an untrailered commit is listed for the user', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: ['lint'], mergeChecks: [], commands: { lint: 'npm run lint' }, target: '' }))
    const a = e.wf.createCard({ title: 'A' })
    const b = e.wf.createCard({ title: 'B' })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const a1 = commit(e.project, { 'a.txt': 'a\n' }, 'a', { trailer: a.key })
    const b1 = commit(e.project, { 'b.txt': 'b\n' }, 'b', { trailer: b.key })
    await reconcile(e.wf, a)
    // A's run while B edits a tracked file: uncounted; the refusal's remedy is an isolated run.
    const busy = await runCheck(e.wf, { card: a, name: 'lint', by: 'B1', exec: async () => (writeFileSync(join(e.project, 'b.txt'), 'b edits\n'), { ok: true }) })
    expect(busy).toMatchObject({ counted: false })
    sh(e.project, 'checkout', '-q', '--', 'b.txt')
    const copy = await checkCopy(e.wf, a, join(e.home, 'check-a'))
    expect(copy).not.toBeNull()
    const isolated = await runCheck(e.wf, { card: a, name: 'lint', by: 'B1', isolated: copy!, exec: async () => (writeFileSync(join(e.project, 'b.txt'), 'b edits again\n'), { ok: true }) })
    expect(isolated).toMatchObject({ counted: true, isolated: true, revision: a1, tested: a1 })
    sh(e.project, 'checkout', '-q', '--', 'b.txt')
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    expect(e.wf.state(a).latest).toMatchObject({ revision: a1 })
    expect(e.wf.state(a).latest!.revision).not.toBe(sh(e.project, 'rev-parse', 'HEAD'))
    // B's change excludes A's commits.
    await runCheck(e.wf, { card: b, name: 'lint', by: 'B2', exec: async () => ({ ok: true }) })
    moved(await e.wf.submit(b.key, B2, { summary: 'B' }))
    expect(e.wf.state(b).latest).toMatchObject({ revision: b1, commits: [b1] })
    expect(e.wf.state(b).latest!.files.map((f) => f.path)).toEqual(['b.txt'])
    // A fails, fixes and resubmits.
    moved(await e.wf.startReview(a.key, R1))
    moved(await e.wf.verdict(a.key, R1, { pass: false, comment: 'fix' }))
    const a2 = commit(e.project, { 'a.txt': 'a fixed\n' }, 'a fix', { trailer: a.key })
    await reconcile(e.wf, a)
    const copy2 = await checkCopy(e.wf, a, join(e.home, 'check-a2'))
    await runCheck(e.wf, { card: a, name: 'lint', by: 'B1', isolated: copy2!, exec: async () => ({ ok: true }) })
    moved(await e.wf.submit(a.key, B1, { summary: 'A fixed' }))
    expect(e.wf.state(a).latest).toMatchObject({ revision: a2, commits: [a1, a2] })
    // A commit with no trailer while both are unfinished: attributed to no card.
    const c = commit(e.project, { 'who.txt': '?\n' }, 'whose?')
    await attributeFolder(e.wf)
    expect(e.store.folderCommits(e.project).find((x) => x.sha === c)).toMatchObject({ card: null, how: 'unattributed' })
  })

  it("G16's lock records (#1481): each path once a cycle, on the agent's current card only; its next start, Done or a reopening ends a card's", async () => {
    const e = (env = setup({ platform: 'git', sharedFolderWarning: true }))
    const [x, y] = ['X', 'Y'].map((t) => e.wf.createCard({ title: t }))
    moved(await e.wf.start(x.key, B1))
    const onX = { card: x.id, cycle: e.wf.state(x).cycle }
    expect(await locked(e.wf, B1, ['one.txt', 'one.txt', 'two.txt'])).toBe(true)
    expect(await locked(e.wf, B1, ['two.txt'])).toBe(false)
    expect(e.wf.state(x).locked).toEqual(['one.txt', 'two.txt'])
    expect(e.kinds(x.id).filter((k) => k === 'FilesLocked')).toHaveLength(1)
    // B1 starts Y with X unfinished: Y is its current card, and a lock seen on X isn't put on either.
    moved(await e.wf.start(y.key, B1))
    expect([...e.wf.currentCards()].map(([a, c]) => [a, c.card.id])).toEqual([['B1', y.id]])
    expect([e.wf.currentCard('B1')?.card.id, e.wf.currentCard('B2')]).toEqual([y.id, undefined])
    expect(await e.wf.recordLocks('B1', ['late.txt'], onX)).toBe(false)
    expect(await locked(e.wf, B1, ['one.txt'])).toBe(true)
    expect([e.wf.state(x).locked, e.wf.state(y).locked]).toEqual([['one.txt', 'two.txt'], ['one.txt']])
    // Done: B1 has no current card; X reopened and started again: a new cycle, its record empty.
    expect(await e.wf.move(y.key, 'done', 'user')).toMatchObject({ ok: true })
    expect(e.wf.currentCards().size).toBe(0)
    expect(e.wf.currentCard('B1')).toBeUndefined()
    expect(await locked(e.wf, B1, ['after.txt'])).toBe(false)
    expect(await e.wf.move(x.key, 'todo', 'user')).toMatchObject({ ok: true })
    moved(await e.wf.start(x.key, B1))
    expect(e.wf.state(x).locked).toEqual([])
  })
})
