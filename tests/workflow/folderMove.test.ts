// A card's folder moved with its worktree (#1343): Repair (or Recreate) writes FolderMoved on the card, and
// reconciliation, finding the card's folder gone, follows its builder's worktree to its new place when that is on the
// card's line (a Repair cut short before the card's fact), and takes nothing for gone while a move Repair hasn't recorded
// covers it. Every write is checked under its lock against the card's folder and cycle: two Hives at once write one
// FolderMoved, and a move between an observer's read and its write drops its Gone. Real Git; two Workflows on one store
// stand in for two Hives.
import { renameSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import type { Workflow } from '../../src/main/workflow/runtime'
import type { FactData } from '../../src/shared/workflow/facts'

// A folder whose look fails as a locked or unreadable one does (EACCES): reconciliation's statSync of it throws.
const blocked = vi.hoisted(() => ({ path: '' }))
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    statSync: ((p: string, ...rest: unknown[]) => {
      if (blocked.path && String(p) === blocked.path) throw Object.assign(new Error('locked'), { code: 'EACCES' })
      return (fs.statSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.statSync
  }
})

let env: Env | null = null
afterEach(() => {
  blocked.path = ''
  env?.close()
  env = null
})

/** A started card working in a folder of its own, with a commit on its line. */
async function started(e: Env): Promise<{ card: ReturnType<Workflow['createCard']>; line: string; folder: string }> {
  const card = e.wf.createCard({ title: 'In a worktree' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  commit(folder, { 'a.txt': 'a\n' }, 'A')
  await reconcile(e.wf, card)
  return { card, line: e.wf.state(card).started!.line!, folder }
}

const facts = (e: Env, card: number) => e.store.facts(card)
const folderMoves = (e: Env, card: number) => facts(e, card).filter((f) => f.kind === 'FolderMoved')
const gone = (e: Env, card: number) => facts(e, card).filter((f) => f.kind === 'Gone' && (f.data as FactData['Gone']).what === 'folder')

/** Each observer's builder worktree (project.json's, as service.ts reads it), and whether a move is pending. */
function record(wfs: Workflow[], path: string, pending = false, before?: () => Promise<void>): void {
  for (const wf of wfs) {
    wf.cfg.agentFolder = async () => {
      await before?.()
      return { path, base: null }
    }
    wf.cfg.movePending = async () => pending
  }
}

const opts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

describe("a card's folder moved with its worktree (#1343)", () => {
  it('its worktree moved and recorded, the card not yet: it follows (FolderMoved), never gone, and reads the folder there', async () => {
    const e = (env = setup(opts))
    const { card, line, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    sh(e.project, 'worktree', 'move', folder, to)
    record([e.wf], to)
    await reconcile(e.wf, card)
    expect(folderMoves(e, card.id).map((f) => f.data)).toEqual([{ from: folder, to, why: 'repair' }])
    expect(gone(e, card.id)).toEqual([])
    expect(e.wf.state(card).started!.folder).toBe(to)
    expect(e.wf.folderOf(e.wf.state(card))).toBe(to)
    // A commit there is seen; runs after change nothing more.
    const head = commit(to, { 'b.txt': 'b\n' }, 'B')
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(folderMoves(e, card.id)).toHaveLength(1)
    expect(facts(e, card.id).filter((f) => f.kind === 'HeadMoved').at(-1)!.data).toMatchObject({ line, to: head })
    expect(gone(e, card.id)).toEqual([])
  })

  it('two Hives follow the same move at once: one FolderMoved', async () => {
    const e = (env = setup(opts))
    const other = e.another()
    const { card, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    sh(e.project, 'worktree', 'move', folder, to)
    // Both observers read the card's folder gone before either goes on.
    let waiting = 0
    let release!: () => void
    const both = new Promise<void>((r) => (release = r))
    record([e.wf, other], to, false, async () => {
      if (++waiting === 2) release()
      await both
    })
    await Promise.all([reconcile(e.wf, card), reconcile(other, card)])
    expect(folderMoves(e, card.id)).toHaveLength(1)
    expect(gone(e, card.id)).toEqual([])
    expect(e.wf.state(card).started!.folder).toBe(to)
  })

  it('a move Repair hasn’t recorded: not gone while the builder’s record names the folder; gone once no move covers it', async () => {
    const e = (env = setup(opts))
    const { card, folder } = await started(e)
    // The workspace moved and isn't repaired: the folder isn't where the record says, git's link broken.
    renameSync(folder, join(e.home, 'unrepaired-b1'))
    record([e.wf], folder, true)
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(gone(e, card.id)).toEqual([])
    expect(folderMoves(e, card.id)).toEqual([])
    expect(e.wf.state(card).started!.folder).toBe(folder)
    // No move pending (it was deleted, not moved): gone, once.
    record([e.wf], folder, false)
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(gone(e, card.id)).toHaveLength(1)
  })

  it('its builder’s worktree elsewhere on another line: the card doesn’t follow it, and its folder is gone', async () => {
    const e = (env = setup(opts))
    const { card, folder } = await started(e)
    const other = join(e.home, 'other-b1')
    sh(e.project, 'worktree', 'add', '-q', '-b', 'something-else', other, 'main')
    sh(e.project, 'worktree', 'remove', '--force', folder)
    record([e.wf], other, true)
    await reconcile(e.wf, card)
    expect(folderMoves(e, card.id)).toEqual([])
    expect(gone(e, card.id)).toHaveLength(1)
    expect(e.wf.state(card).started!.folder).toBe(folder)
  })

  it('moved between an observer’s read and its write: its Gone is dropped', async () => {
    const e = (env = setup(opts))
    const other = e.another()
    const { card, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    sh(e.project, 'worktree', 'move', folder, to)
    // The observer reads the builder's old record and no move pending; before it writes, Repair moves the card.
    e.wf.cfg.agentFolder = async () => ({ path: folder, base: null })
    e.wf.cfg.movePending = async () => {
      await other.write(other.store.card(card.id), null, 'hive', (w) => w.fact('FolderMoved', { from: folder, to, why: 'repair' }))
      return false
    }
    await reconcile(e.wf, card)
    expect(gone(e, card.id)).toEqual([])
    expect(folderMoves(e, card.id)).toHaveLength(1)
    expect(e.wf.state(card).started!.folder).toBe(to)
  })

  it('its new place can’t be looked at (locked): undecided, never gone; once it can, the card follows it', async () => {
    const e = (env = setup(opts))
    const { card, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    sh(e.project, 'worktree', 'move', folder, to)
    record([e.wf], to)
    blocked.path = to
    await reconcile(e.wf, card)
    await reconcile(e.wf, card)
    expect(gone(e, card.id)).toEqual([])
    expect(folderMoves(e, card.id)).toEqual([])
    blocked.path = ''
    await reconcile(e.wf, card)
    expect(folderMoves(e, card.id)).toHaveLength(1)
    expect(gone(e, card.id)).toEqual([])
  })

  it('a move and a branch rename both cut short: the card follows both, never gone, after a restart and repeats too', async () => {
    const e = (env = setup(opts))
    const { card, line, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    const renamed = `${line}-renamed`
    // Git's steps done (the worktree moved, its branch renamed) and the agent's record written; the card has neither.
    sh(e.project, 'worktree', 'move', folder, to)
    sh(e.project, 'branch', '-m', line, renamed)
    const pending = (wf: Workflow): void => {
      wf.cfg.pendingRename = async (l) => (l.toLowerCase() === line.toLowerCase() ? renamed : null)
    }
    record([e.wf], to, true)
    pending(e.wf)
    await reconcile(e.wf, card)
    expect(e.wf.state(card).started).toMatchObject({ folder: to, line: renamed })
    // The Combwork started again: its own connection, the same records; and repeats.
    const restarted = e.another()
    record([restarted], to, true)
    pending(restarted)
    await reconcile(restarted, card)
    await reconcile(restarted, card)
    expect(gone(e, card.id)).toEqual([])
    expect(facts(e, card.id).filter((f) => f.kind === 'Gone')).toEqual([])
    expect(folderMoves(e, card.id)).toHaveLength(1)
    expect(facts(e, card.id).filter((f) => f.kind === 'LineRenamed')).toHaveLength(1)
  })

  it('its builder’s worktree on another branch while its line has a rename pending elsewhere: undecided, not gone', async () => {
    const e = (env = setup(opts))
    const { card, line, folder } = await started(e)
    const other = join(e.home, 'other-b1')
    sh(e.project, 'worktree', 'add', '-q', '-b', 'something-else', other, 'main')
    sh(e.project, 'worktree', 'remove', '--force', folder)
    record([e.wf], other)
    e.wf.cfg.pendingRename = async (l) => (l === line ? `${line}-not-yet` : null)
    await reconcile(e.wf, card)
    expect(gone(e, card.id)).toEqual([])
    expect(folderMoves(e, card.id)).toEqual([])
  })

  it('the fold moves only the folder a FolderMoved names: a repeat, or another folder’s, changes nothing', async () => {
    const e = (env = setup(opts))
    const { card, folder } = await started(e)
    const to = join(e.home, 'moved-b1')
    const write = (from: string, dest: string) => e.wf.write(e.store.card(card.id), null, 'hive', (w) => w.fact('FolderMoved', { from, to: dest, why: 'repair' }))
    await write(join(e.home, 'elsewhere'), join(e.home, 'nowhere'))
    expect(e.wf.state(card).started!.folder).toBe(folder)
    // Named by another spelling of the same folder (case, a trailing separator): still the card's.
    await write(`${folder.toUpperCase()}\\`, to)
    expect(e.wf.state(card).started!.folder).toBe(to)
    await write(folder, join(e.home, 'again'))
    expect(e.wf.state(card).started!.folder).toBe(to)
  })
})
