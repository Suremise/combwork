// G6's Rebase and fast-forward (#1184): the merge queue rebases a card's reviewed commits onto its target and moves the
// target forward to exactly the tested result, under the "linear landing" policy: every commit the advance adds to the
// target has exactly one parent, and the target's head before is an ancestor of the result. On real repositories.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, put, R1, setup, sh, type Env } from './harness'
import { preset, takesOption } from '../../src/shared/workflow/options'
import { compile } from '../../src/shared/workflow/compile'
import type { FactData } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** Pair (Combwork merges), merge style Rebase and fast-forward; `main` checked out nowhere unless `checkedOut`. */
function rebasing(over: Partial<ReturnType<typeof preset>> = {}, checkedOut = false): Env {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], style: 'rebase', ...over }))
  if (!checkedOut) sh(e.project, 'checkout', '-q', '--detach')
  return e
}

/** A commit on the target, `main`, wherever it is checked out (the project folder is detached unless `checkedOut`). */
function onTarget(e: Env, files: Record<string, string>, message: string): string {
  const detached = !sh(e.project, 'branch', '--show-current')
  if (detached) sh(e.project, 'checkout', '-q', 'main')
  const c = commit(e.project, files, message)
  if (detached) sh(e.project, 'checkout', '-q', '--detach')
  return c
}

/** A card started by B1, its work made by `build` in its folder, submitted and passed by R1. */
async function queued(e: Env, title: string, build: (folder: string) => void) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  build(s.data!.folder as string)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

/** The target's commits a merge added (oldest first), each with its parents. */
function landed(e: Env, before: string): { commit: string; parents: string[] }[] {
  const out = sh(e.project, 'rev-list', '--reverse', '--parents', `${before}..main`)
  return out ? out.split(/\r?\n/).map((l) => ((ids) => ({ commit: ids[0], parents: ids.slice(1) }))(l.split(' '))) : []
}

/** Every commit landed has exactly one parent (linear landing), and the target's head before is an ancestor. */
function linear(e: Env, before: string): void {
  const all = landed(e, before)
  expect(all.length).toBeGreaterThan(0)
  for (const c of all) expect(c.parents, c.commit).toHaveLength(1)
  expect(sh(e.project, 'rev-list', '--min-parents=2', `${before}..main`)).toBe('')
  sh(e.project, 'merge-base', '--is-ancestor', before, 'main')
}

const integrated = (e: Env, card: number): FactData['Integrated'] | undefined => e.store.facts(card).find((f) => f.kind === 'Integrated')?.data as FactData['Integrated'] | undefined
const tree = (e: Env, rev: string): string => sh(e.project, 'rev-parse', `${rev}^{tree}`)

describe("G6's Rebase and fast-forward (#1184)", () => {
  it('two commits onto a target that moved: rebased, the target fast-forwarded to exactly the tested result, linear, each commit its own', async () => {
    const e = rebasing()
    const card = await queued(e, 'Two', (f) => {
      commit(f, { 'one.txt': 'one\n' }, 'AM-1: one')
      commit(f, { 'two.txt': 'two\n' }, 'AM-1: two')
    })
    onTarget(e, { 'other.txt': 'target moved\n' }, 'the target moves')
    const before = sh(e.project, 'rev-parse', 'main')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    linear(e, before)
    expect(landed(e, before).map((c) => sh(e.project, 'log', '-1', '--format=%s', c.commit))).toEqual(['AM-1: one', 'AM-1: two'])
    expect(sh(e.project, 'rev-parse', 'main')).toBe((o as { result: string }).result)
    expect(tree(e, 'main')).toBe(tree(e, `refs/cw/queue/${card.key.toLowerCase()}`))
    expect(integrated(e, card.id)).toMatchObject({ method: 'fastForward', by: 'hive', result: sh(e.project, 'rev-parse', 'main') })
    expect(e.wf.state(card).stage).toBe('done')
    // The reviewed revision stays pinned.
    expect(sh(e.project, 'rev-parse', `refs/cw/cards/${card.key.toLowerCase()}/1`)).toBe(e.wf.state(card).latest!.revision)
  })

  it('a linear card already on top of the target: its reviewed commits land as they are, no rewrite', async () => {
    const e = rebasing()
    const card = await queued(e, 'On top', (f) => void commit(f, { 'top.txt': 'top\n' }, 'AM-1: on top'))
    const before = sh(e.project, 'rev-parse', 'main')
    await e.queue().drain('main')
    linear(e, before)
    expect(sh(e.project, 'rev-parse', 'main')).toBe(e.wf.state(card).latest!.revision)
  })

  for (const reused of [false, true]) {
    it(`a linear card already on top, with merge checks, in a ${reused ? 'reused' : 'fresh'} queue folder: the checks run on exactly its revision, and it lands (HR2 r1 f1)`, async () => {
      const e = rebasing({ mergeChecks: ['verify'], commands: { verify: 'npm run verify' } })
      const card = await queued(e, 'On top', (f) => void commit(f, { 'top.txt': 'top\n' }, 'AM-1: on top'))
      const revision = e.wf.state(card).latest!.revision!
      // A queue folder left at the target's head by an earlier merge.
      if (reused) sh(e.project, 'worktree', 'add', '-q', '--detach', `${e.home}/queue`, 'main')
      let tested: { head: string; file: boolean } | null = null
      const [o] = await e
        .queue({
          runCheck: async (_name, _command, folder) => {
            tested = { head: sh(folder, 'rev-parse', 'HEAD'), file: existsSync(join(folder, 'top.txt')) }
            return { ok: true, output: '' }
          }
        })
        .drain('main')
      expect(tested).toEqual({ head: revision, file: true })
      expect(o).toMatchObject({ outcome: 'integrated' })
      expect(sh(e.project, 'rev-parse', 'main')).toBe(revision)
    })
  }

  it('a restart between the advance and its Integrated: recovery records the landing as the advance would, fastForward (HR2 r1 f2)', async () => {
    const e = rebasing()
    const card = await queued(e, 'Recovered', (f) => void commit(f, { 'r.txt': 'r\n' }, 'AM-1: recovered'))
    onTarget(e, { 'other.txt': 'moved\n' }, 'the target moves')
    const before = sh(e.project, 'rev-parse', 'main')
    await expect(e.queue({ hooks: { afterAdvance: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect((await e.queue().recover('main')).map((x) => x.outcome)).toEqual(['integrated'])
    expect(integrated(e, card.id)).toMatchObject({ method: 'fastForward', by: 'hive' })
    linear(e, before)
  })

  it('a conflict with the target: returned with its files, the target unmoved', async () => {
    const e = rebasing()
    const card = await queued(e, 'Clash', (f) => void commit(f, { 'src/a.txt': 'card\n' }, 'AM-1: clash'))
    onTarget(e, { 'src/a.txt': 'target\n' }, 'the target edits the same file')
    const before = sh(e.project, 'rev-parse', 'main')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'conflict' })
    expect(e.wf.state(card).entries.at(-1)?.failure?.files).toEqual(['src/a.txt'])
    // Its hunks (HI-1181): rebased onto the target, whose side git wrote first.
    expect(e.wf.state(card).entries.at(-1)?.failure?.conflicts).toMatchObject({ oursIs: 'target', files: [{ file: 'src/a.txt', hunks: [{ ours: ['target'], theirs: ['card'] }] }] })
    expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
  })

  it('with the repository\'s rebase.rebaseMerges on: a card whose branch merged the target in mid-way still lands linear, the same change', async () => {
    const e = rebasing()
    sh(e.project, 'config', 'rebase.rebaseMerges', 'true')
    const card = await queued(e, 'Merged in', (f) => {
      commit(f, { 'c1.txt': 'c1\n' }, 'AM-1: first')
      onTarget(e, { 'mid.txt': 'mid\n' }, 'the target moves mid-way')
      sh(f, 'merge', '-q', '--no-edit', 'main')
      commit(f, { 'c2.txt': 'c2\n' }, 'AM-1: second')
    })
    onTarget(e, { 'late.txt': 'late\n' }, 'the target moves again')
    const before = sh(e.project, 'rev-parse', 'main')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    linear(e, before)
    expect(landed(e, before).map((c) => sh(e.project, 'log', '-1', '--format=%s', c.commit))).toEqual(['AM-1: first', 'AM-1: second'])
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a card holding a merge, already descending from the target: flattened, never landed with its merge commit', async () => {
    const e = rebasing()
    const card = await queued(e, 'Descends', (f) => {
      commit(f, { 'c1.txt': 'c1\n' }, 'AM-1: first')
      onTarget(e, { 'mid.txt': 'mid\n' }, 'the target moves')
      sh(f, 'merge', '-q', '--no-edit', 'main')
    })
    const reviewed = e.wf.state(card).latest!.revision!
    // The reviewed suffix holds a merge, and the target hasn't moved since: it already descends from it.
    sh(e.project, 'merge-base', '--is-ancestor', 'main', reviewed)
    const before = sh(e.project, 'rev-parse', 'main')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    linear(e, before)
    expect(sh(e.project, 'rev-parse', 'main')).not.toBe(reviewed)
    expect(tree(e, 'main')).toBe(tree(e, reviewed))
  })

  it('a merge resolution that changes the work (dropped when flattened): returned, not the same change as reviewed', async () => {
    const e = rebasing()
    const card = await queued(e, 'Evil merge', (f) => {
      commit(f, { 'c1.txt': 'c1\n' }, 'AM-1: first')
      onTarget(e, { 'mid.txt': 'mid\n' }, 'the target moves')
      // The merge commit carries a change of its own, which a linear history can't keep.
      sh(f, 'merge', '-q', '--no-ff', '--no-commit', 'main')
      put(f, 'only-in-merge.txt', 'resolution\n')
      sh(f, 'add', '-A')
      sh(f, 'commit', '-q', '-m', 'Merge main, with a change')
    })
    const before = sh(e.project, 'rev-parse', 'main')
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'notUpToDate' })
    expect(e.wf.state(card).entries.at(-1)?.failure?.log).toMatch(/isn't the same change as reviewed/)
    expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
  })

  it('strict (G8) with Rebase and fast-forward: no separate update first, and it lands linear', async () => {
    const e = rebasing({ strict: true })
    const card = await queued(e, 'Strict', (f) => void commit(f, { 's.txt': 's\n' }, 'AM-1: strict'))
    onTarget(e, { 'other.txt': 'moved\n' }, 'the target moves')
    const before = sh(e.project, 'rev-parse', 'main')
    await e.queue().drain('main')
    linear(e, before)
    expect(e.kinds(card.id)).not.toContain('Updated')
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('a target checked out in the project folder: its files follow the rebased result', async () => {
    const e = rebasing({}, true)
    const card = await queued(e, 'Checked out', (f) => void commit(f, { 'co.txt': 'co\n' }, 'AM-1: checked out'))
    onTarget(e, { 'other.txt': 'moved\n' }, 'the target moves')
    const before = sh(e.project, 'rev-parse', 'main')
    await e.queue().drain('main')
    linear(e, before)
    expect(e.wf.state(card).stage).toBe('done')
    expect(sh(e.project, 'show', 'HEAD:co.txt')).toBe('co')
    expect(sh(e.project, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('the option: taken, a rule (its ruleset says it), and no preset sets it', () => {
    expect(takesOption('style', 'rebase')).toBe(true)
    const c = compile({ ...preset('git', 'pair'), style: 'rebase' })
    expect(c.ok && c.ruleset.options.style).toBe('rebase')
    for (const p of ['solo', 'pairAgent', 'pair', 'team'] as const) expect(preset('git', p).style, p).not.toBe('rebase')
  })
})
