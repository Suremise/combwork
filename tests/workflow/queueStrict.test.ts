// Strict, G8 (#1352, SPEC §16.9.1 step 3): a reviewed revision that doesn't contain the target's head is brought up to
// date by the queue in its own worktree, never on the builder's line; the same change carries its pass over (Updated,
// on the entry; the card's approved revision stays the reviewed one) and is merged; a conflict or a different change
// goes back to its builder (notUpToDate).
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import type { FactData } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const strict = (over: { style?: 'merge' | 'squash' } = {}): Env => {
  env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], strict: true, commitMessage: 'hive', ...over })
  // The target checked out nowhere: the plain compare-and-swap advance.
  sh(env.project, 'checkout', '-q', '--detach')
  return env
}

/** A card built in its worktree (one commit per file set), reviewed and passed: approved, so the queue takes it. */
async function approved(e: Env, title: string, ...commits: Record<string, string>[]) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  for (const [i, files] of commits.entries()) commit(folder, files, `${title} ${i + 1}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  const line = e.wf.state(card).started!.line!
  return { card, folder, line, revision: sh(folder, 'rev-parse', 'HEAD') }
}

/** The builder's line and worktree as they are: its ref, its HEAD and its status. */
const lineState = (e: Env, folder: string, line: string) => ({ ref: sh(e.project, 'rev-parse', `refs/heads/${line}`), head: sh(folder, 'rev-parse', 'HEAD'), status: sh(folder, 'status', '--porcelain') })
/** Moves main as another merge would, outside the card's work. */
const advanceMain = (e: Env, files: Record<string, string>, message: string): string => {
  const tmp = join(e.home, `wt-${Date.now()}`)
  sh(e.project, 'worktree', 'add', '-q', tmp, 'main')
  const c = commit(tmp, files, message)
  sh(e.project, 'worktree', 'remove', '--force', tmp)
  return c
}

describe('strict (G8): the queue brings the reviewed revision up to date', () => {
  for (const style of ['merge', 'squash'] as const) {
    it(`the target moved after the pass: updated on the queue's own ref (${style}), the pass kept, merged; the builder's line untouched`, async () => {
      const e = strict({ style })
      const { card, folder, line, revision } = await approved(e, 'A', { 'a.txt': 'A\n' })
      const moved1 = advanceMain(e, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
      const before = lineState(e, folder, line)
      const [o] = await e.queue().drain('main')
      expect(o).toMatchObject({ outcome: 'integrated' })
      const s = e.wf.state(card)
      expect(s.stage).toBe('done')
      // The update, recorded on its entry: carried, from the reviewed revision.
      const up = e.store.facts(card.id).find((f) => f.kind === 'Updated')!.data as FactData['Updated']
      expect(up).toMatchObject({ entry: s.entries[0].id, from: revision, how: style === 'squash' ? 'rebased' : 'mergedTarget', carried: true })
      expect(s.entries[0].updated).toMatchObject({ from: revision, to: up.to })
      // The card's approved revision is still the reviewed one.
      expect(s.approved?.revision).toBe(revision)
      // The update contains the moved target; the merge brought it in, with the reviewed and the updated revision named.
      expect(sh(e.project, 'merge-base', '--is-ancestor', moved1, up.to)).toBe('')
      const message = sh(e.project, 'log', '-1', '--format=%B', 'main')
      expect(message).toContain(`Combwork-Revision: ${revision}`)
      expect(message).toContain(`Combwork-Updated: ${up.to}`)
      expect(sh(e.project, 'show', 'main:a.txt')).toBe('A')
      expect(sh(e.project, 'show', 'main:other.txt')).toBe('meanwhile')
      // Never on the builder's line: its ref, HEAD and status as they were.
      expect(lineState(e, folder, line)).toEqual(before)
      expect(before.ref).toBe(revision)
    })
  }

  // HR4's round 1: git's rebase.updateRefs moves every other ref at a rebased commit; the queue's rebase moves none.
  for (const where of ['the builder\'s branch, its worktree detached', "a user's branch at the reviewed commit"] as const) {
    it(`squash under rebase.updateRefs=true: ${where} stays where it was`, async () => {
      const e = strict({ style: 'squash' })
      const { folder, line, revision } = await approved(e, 'A', { 'a.txt': 'A\n' }, { 'b.txt': 'B\n' })
      advanceMain(e, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
      sh(e.project, 'config', 'rebase.updateRefs', 'true')
      if (where.startsWith('the builder')) sh(folder, 'checkout', '-q', '--detach', revision)
      else sh(e.project, 'branch', 'user-backup', revision)
      const watched = where.startsWith('the builder') ? `refs/heads/${line}` : 'refs/heads/user-backup'
      expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
      expect(sh(e.project, 'rev-parse', watched)).toBe(revision)
      // The repository's own setting is left as the user set it.
      expect(sh(e.project, 'config', '--get', 'rebase.updateRefs')).toBe('true')
    })
  }

  it('a reviewed revision that already contains the target merges as it is: no update', async () => {
    const e = strict()
    const { card } = await approved(e, 'A', { 'a.txt': 'A\n' })
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'integrated' })
    expect(e.store.facts(card.id).some((f) => f.kind === 'Updated')).toBe(false)
    expect(sh(e.project, 'log', '-1', '--format=%B', 'main')).not.toContain('Combwork-Updated')
  })

  it('reconciliation after an update sees the reviewed revision: no Stale, nothing carried over again', async () => {
    const e = strict()
    const { card } = await approved(e, 'A', { 'a.txt': 'A\n' })
    advanceMain(e, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    // Stopped after the update and its test merge, before the advance: the card is still merging.
    await expect(e.queue({ hooks: { afterTest: () => Promise.reject(new Error('stop')) } }).drain('main')).rejects.toThrow('stop')
    expect(e.store.facts(card.id).some((f) => f.kind === 'Updated')).toBe(true)
    const n = e.store.facts(card.id).length
    await reconcile(e.wf, card)
    expect(e.store.facts(card.id).map((f) => f.kind).slice(n)).not.toContain('Stale')
    expect(e.wf.state(card).stale).toBeNull()
  })

  it('a conflict with the moved target: returned to its builder (notUpToDate) with the files; its line untouched, nothing merged', async () => {
    const e = strict()
    const { card, folder, line } = await approved(e, 'A', { 'src/a.txt': 'the card\n' })
    const atConflict = advanceMain(e, { 'src/a.txt': 'someone else\n' }, 'someone else')
    const before = lineState(e, folder, line)
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'notUpToDate', transient: false })
    const f = e.wf.state(card).entries[0].failure!
    expect(f).toMatchObject({ reason: 'notUpToDate', files: ['src/a.txt'] })
    // Its hunks (HI-1181): strict merges the target into the card's revision, so the card's side comes first.
    expect(f.conflicts).toMatchObject({ oursIs: 'card', files: [{ file: 'src/a.txt', hunks: [{ ours: ['the card'], theirs: ['someone else'] }] }] })
    // …and its builder is told where (HR4's round 1): the file and its line, not only that it isn't up to date.
    expect(e.wakes.some((w) => w.why.includes("it isn't up to date with main: a conflict in src/a.txt (1 conflict, line 1)"))).toBe(true)
    expect(e.wf.state(card).stage).toBe('active')
    expect(sh(e.project, 'rev-parse', 'main')).toBe(atConflict)
    expect(lineState(e, folder, line)).toEqual(before)
    expect(e.store.facts(card.id).some((x) => x.kind === 'Updated')).toBe(false)
  })

  it('an update that is not the same change (part of it is in the target already): returned, nothing merged', async () => {
    const e = strict()
    const { card, folder, line } = await approved(e, 'A', { 'a.txt': 'A\n' }, { 'b.txt': 'B\n' })
    // Someone took the card's first commit into main on their own (a cherry-pick of a.txt).
    const head = advanceMain(e, { 'a.txt': 'A\n' }, 'a.txt picked')
    const before = lineState(e, folder, line)
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'notUpToDate' })
    expect(e.wf.state(card).entries[0].failure?.log).toContain("isn't the same change as reviewed")
    expect(sh(e.project, 'rev-parse', 'main')).toBe(head)
    expect(lineState(e, folder, line)).toEqual(before)
  })

  it('after a return the builder brings its line up to date, submits, passes, and it merges with no update', async () => {
    const e = strict()
    const { card, folder } = await approved(e, 'A', { 'src/a.txt': 'the card\n' })
    advanceMain(e, { 'src/a.txt': 'someone else\n' }, 'someone else')
    expect((await e.queue().drain('main'))[0]).toMatchObject({ outcome: 'returned', reason: 'notUpToDate' })
    // The builder, in its own worktree: merges main, settles the conflict, commits.
    sh(folder, 'merge', '-q', 'main', '-X', 'ours', '-m', 'main in')
    expect(readFileSync(join(folder, 'src/a.txt'), 'utf8')).toBe('the card\n')
    moved(await e.wf.submit(card.key, B1, { summary: 'up to date' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    const out = await e.queue().drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).stage).toBe('done')
    expect(sh(e.project, 'show', 'main:src/a.txt')).toBe('the card')
  })
})
