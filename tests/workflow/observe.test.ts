// Observations by two Hives on one workspace (#1118, SPEC §16.17): each transition is written once, a repeat of the same
// values later is still recorded, and a writer that loses the race reads the platform again and writes only what is
// true now. Two Workflows on separate connections to one store file stand in for the dev and the installed Hive.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import type { FactData } from '../../src/shared/workflow/facts'
import { gitTestHooks } from '../../src/main/git'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const heads = (e: Env, card: number) => e.store.facts(card).filter((f) => f.kind === 'HeadMoved').map((f) => (f.data as FactData['HeadMoved']).to)

describe('two Hives observing one workspace', () => {
  it('S59: HEAD goes A→B→A→B → four HeadMoved facts, each once; a card reopened and merged again → a second Integrated in the new cycle', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const card = e.wf.createCard({ title: 'Observed' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const a = commit(folder, { 'a.txt': 'a\n' }, 'A')
    const b = commit(folder, { 'b.txt': 'b\n' }, 'B')
    for (const to of [a, b, a, b]) {
      sh(folder, 'reset', '-q', '--hard', to)
      await reconcile(e.wf, card)
      await reconcile(other, card)
    }
    expect(heads(e, card.id)).toEqual([a, b, a, b])

    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merged', b)
    await reconcile(e.wf, card)
    await reconcile(other, card)
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Integrated')).toHaveLength(1)

    // Reopened (the user moves it back), started again, merged at the same revision: a new cycle, a second Integrated.
    moved(await e.wf.move(card.key, 'todo', 'user'))
    sh(e.project, 'reset', '-q', '--hard', 'HEAD~1')
    sh(e.project, 'worktree', 'remove', '--force', folder)
    sh(e.project, 'branch', '-q', '-D', e.wf.state(card).started!.line!)
    const again = await e.wf.start(card.key, B1)
    moved(again)
    sh(again.data!.folder as string, 'reset', '-q', '--hard', b)
    moved(await e.wf.submit(card.key, B1, { summary: 'again', note: 'reopened' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'merged again', b)
    await reconcile(other, card)
    await reconcile(e.wf, card)
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Integrated')).toHaveLength(2)
  })

  it('S62: from A, one Hive sees B and the other C (made just after) → the second writer reads the platform now; the log ends at the real head', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const card = e.wf.createCard({ title: 'Raced' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const a = commit(folder, { 'a.txt': 'a\n' }, 'A')
    await reconcile(e.wf, card)
    let c = ''
    // The first Hive reads B; before it writes, C is made and the second Hive observes and writes it.
    const b = commit(folder, { 'b.txt': 'b\n' }, 'B')
    await reconcile(e.wf, card, {
      afterRead: async () => {
        c = commit(folder, { 'c.txt': 'c\n' }, 'C')
        await reconcile(other, card)
      }
    })
    expect(heads(e, card.id)).toEqual([a, c])
    expect(heads(e, card.id)).not.toContain(b)
    expect(e.wf.state(card).head).toBe(c)

    // The other way round: the loser's view (D) is newer than the winner's (the winner read before D was made).
    let d = ''
    const e2 = commit(folder, { 'e.txt': 'e\n' }, 'E')
    await reconcile(other, card, {
      afterRead: async () => {
        d = commit(folder, { 'd.txt': 'd\n' }, 'D')
        await reconcile(e.wf, card)
      }
    })
    expect(heads(e, card.id).slice(-1)).toEqual([d])
    expect(heads(e, card.id).filter((h) => h === e2)).toHaveLength(0)
  })

  it('S50 (core): both Hives observe the same hand merge → one Integrated fact', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const card = e.wf.createCard({ title: 'Merged by hand' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const rev = commit(s.data!.folder as string, { 'm.txt': 'm\n' }, 'm')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', rev)
    await Promise.all([reconcile(e.wf, card), reconcile(other, card)])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Integrated')).toHaveLength(1)
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a reconcile reads its target, its line and its common dir from the files, no git for them (#1462: S59 ran 7.5 gits a run; #1491)', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const card = e.wf.createCard({ title: 'Counted' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const line = e.wf.state(card).started!.line!
    const a = commit(s.data!.folder as string, { 'a.txt': 'a\n' }, 'A')
    const ran: string[] = []
    gitTestHooks.started = (_cwd, args) => {
      ran.push(args.join(' '))
    }
    try {
      await reconcile(e.wf, card)
    } finally {
      gitTestHooks.started = undefined
    }
    expect(heads(e, card.id)).toEqual([a])
    expect(ran.filter((c) => c.endsWith('refs/heads/main'))).toEqual([])
    expect(ran.filter((c) => c.endsWith(`refs/heads/${line}`))).toEqual([])
    expect(ran.filter((c) => c.includes('--git-common-dir'))).toEqual([])
  })
})
