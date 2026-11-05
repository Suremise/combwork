// A card's line renamed by Repair (#1305): git's rename, then LineRenamed on the card, and reconciliation, which follows
// a rename cut short after git's step (a pending rename, `pendingRename`) rather than take the old name for gone. Every
// observation acts on the card's current line and cycle, checked under its write's lock: two Hives recovering the same
// rename at once, a restart, a repeat, a rename between an observer's read and its write, and a new cycle meanwhile
// never leave a Gone: line or a HeadMoved of the old name. Real Git; two Workflows on one store stand in for two Hives.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import type { Workflow } from '../../src/main/workflow/runtime'
import type { Fact, FactData } from '../../src/shared/workflow/facts'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A started card working on a line of its own, with a commit on it; its line's name. */
async function started(e: Env): Promise<{ card: ReturnType<Workflow['createCard']>; line: string; folder: string }> {
  const card = e.wf.createCard({ title: 'On a line' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { 'a.txt': 'a\n' }, 'A')
  await reconcile(e.wf, card)
  return { card, line: e.wf.state(card).started!.line!, folder }
}

const facts = (e: Env, card: number): Fact[] => e.store.facts(card)
const renames = (e: Env, card: number) => facts(e, card).filter((f) => f.kind === 'LineRenamed')
const gone = (e: Env, card: number) => facts(e, card).filter((f) => f.kind === 'Gone' && (f.data as FactData['Gone']).what === 'line')
/** HeadMoved facts of the old name since the rename, or to no head at all (a line read as deleted). */
const staleHeads = (e: Env, card: number, old: string, since: number) => facts(e, card).filter((f) => f.kind === 'HeadMoved' && f.seq > since && ((f.data as FactData['HeadMoved']).line === old || (f.data as FactData['HeadMoved']).to === null))

/** Git's rename, as Repair makes it, with the card left on the old name (the rename cut short after git's step). */
const renameInGit = (e: Env, from: string, to: string): void => void sh(e.project, 'branch', '-m', from, to)

/** Each observer's pending rename: `to` for `from` (project.json's pendingBranchRenames, as service.ts reads it). */
function pending(wfs: Workflow[], from: string, to: string | null, before?: () => Promise<void>): void {
  for (const wf of wfs)
    wf.cfg.pendingRename = async (line) => {
      await before?.()
      return to && line.toLowerCase() === from.toLowerCase() ? to : null
    }
}

describe("a card's line renamed by Repair (#1305)", () => {
  it('two Hives recover the same cut-short rename at once: one LineRenamed, no Gone, no head of the old name', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const { card, line } = await started(e)
    const to = `${line}-renamed`
    renameInGit(e, line, to)
    const since = facts(e, card.id).at(-1)!.seq
    // Both observers read the card on its old line before either goes on (HR5's barrier).
    let waiting = 0
    let release!: () => void
    const both = new Promise<void>((r) => (release = r))
    pending([e.wf, other], line, to, async () => {
      if (++waiting === 2) release()
      await both
    })
    await Promise.all([reconcile(e.wf, card), reconcile(other, card)])
    expect(renames(e, card.id)).toHaveLength(1)
    expect(gone(e, card.id)).toEqual([])
    expect(staleHeads(e, card.id, line, since)).toEqual([])
    expect(e.wf.state(card).started!.line).toBe(to)
  })

  it('a restart after git’s step: the card follows the rename before its line is read; a repeat changes nothing', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const { card, line, folder } = await started(e)
    const to = `${line}-renamed`
    renameInGit(e, line, to)
    const since = facts(e, card.id).at(-1)!.seq
    // The Combwork started again: its own connection to the store, the pending rename still in project.json.
    const restarted = e.another()
    pending([restarted], line, to)
    await reconcile(restarted, card)
    expect(renames(e, card.id)).toHaveLength(1)
    expect(restarted.state(card).started!.line).toBe(to)
    // Recovered again (Repair's own LineRenamed, another run): still one rename, and the line read by its new name.
    await reconcile(restarted, card)
    await reconcile(restarted, card)
    const head = commit(folder, { 'b.txt': 'b\n' }, 'B')
    await reconcile(restarted, card)
    expect(renames(e, card.id)).toHaveLength(1)
    expect(gone(e, card.id)).toEqual([])
    expect(staleHeads(e, card.id, line, since)).toEqual([])
    expect(facts(e, card.id).filter((f) => f.kind === 'HeadMoved').at(-1)!.data).toMatchObject({ line: to, to: head })
  })

  it('renamed between an observer’s read and its write: its head and Gone of the old name are dropped', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const { card, line, folder } = await started(e)
    const to = `${line}-renamed`
    const since = facts(e, card.id).at(-1)!.seq
    commit(folder, { 'b.txt': 'b\n' }, 'B')
    // The observer reads the line's new head; before it writes, Repair renames the branch and the card follows it.
    await reconcile(e.wf, card, {
      afterRead: async () => {
        renameInGit(e, line, to)
        await other.write(other.store.card(card.id), null, 'hive', (w) => w.fact('LineRenamed', { from: line, to, why: 'repair' }))
      }
    })
    expect(gone(e, card.id)).toEqual([])
    expect(staleHeads(e, card.id, line, since)).toEqual([])
    expect(e.wf.state(card).started!.line).toBe(to)
    // The next run reads it by its new name.
    await reconcile(e.wf, card)
    expect(facts(e, card.id).filter((f) => f.kind === 'HeadMoved').at(-1)!.data).toMatchObject({ line: to })
  })

  it('a new cycle between an observer’s read and its write: nothing of the old cycle is written', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const other = e.another()
    const { card, line, folder } = await started(e)
    const to = `${line}-renamed`
    renameInGit(e, line, to)
    commit(folder, { 'c.txt': 'c\n' }, 'C')
    const since = facts(e, card.id).at(-1)!.seq
    // The observer reads the card in its first cycle; before it goes on, the card is put back and started again.
    pending([e.wf], line, to, async () => {
      if (e.wf.state(card).cycle !== e.store.facts(card.id).find((f) => f.kind === 'Started')!.seq) return
      moved(await other.putBack(card.key, B1))
      moved(await other.start(card.key, B1))
    })
    await reconcile(e.wf, card)
    const written = facts(e, card.id).filter((f) => f.seq > since)
    const cycle = written.find((f) => f.kind === 'Started')!.seq
    // Only the new cycle's own facts: no rename of the old cycle's line, no Gone, no head of the old name.
    expect(written.filter((f) => f.seq < cycle && ['LineRenamed', 'Gone', 'HeadMoved'].includes(f.kind))).toEqual([])
    expect(gone(e, card.id)).toEqual([])
    expect(staleHeads(e, card.id, line, since)).toEqual([])
  })

  it('a rename pointing away whose new name can’t be read: the old name isn’t observed, and never taken for gone', async () => {
    const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }))
    const { card, line } = await started(e)
    // The old name is gone, and the pending rename names a branch that isn't there (yet): unknown, not gone.
    sh(e.project, 'branch', '-m', line, `${line}-elsewhere`)
    const since = facts(e, card.id).at(-1)!.seq
    pending([e.wf], line, `${line}-not-there`)
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(renames(e, card.id)).toEqual([])
    expect(gone(e, card.id)).toEqual([])
    expect(staleHeads(e, card.id, line, since)).toEqual([])
    expect(e.wf.state(card).started!.line).toBe(line)
  })
})
