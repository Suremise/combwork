// HI-2379: a shared folder's attribution after a fast-forward that brings many commits into its line at once (the
// release merge into main, 3,536 commits, held main's thread for 40 s: each commit was its own transaction, folding its card's
// whole log again). They are attributed in batches now: each commit once, its card's head moving from one to the next
// as before, across the batches' edges too, and the card's log read once a batch, not once a commit. Main's stall in the
// app is tests/e2e/mergeburst.cjs's.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-attribution-burst-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { reconcileNow, stopReconciling } = await import('../src/main/workflow/reconciler')
const { ATTRIBUTE_BATCH } = await import('../src/main/workflow/reconcile')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
advanced.load(join(base, 'profile'))
await advanced.set(ENFORCE, false)
afterAll(async () => {
  advanced.stop()
  stopReconciling()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const git = (cwd: string, args: string[], input?: string): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim()

/** `n` commits on a new branch from main, a file each, made at once with fast-import; `trailer(i)`: a commit's Combwork-Card. */
function manyCommits(repo: string, branch: string, n: number, trailer: (i: number) => string | null = () => null): void {
  const from = git(repo, ['rev-parse', 'main'])
  let s = ''
  for (let i = 0; i < n; i++) {
    const t = trailer(i)
    const message = `work ${i}${t ? `\n\nCombwork-Card: ${t}` : ''}\n`
    s += `commit refs/heads/${branch}\ncommitter T <t@t> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i ? '' : `from ${from}\n`}M 100644 inline f/${i}.txt\ndata ${String(i).length + 1}\n${i}\n\n`
  }
  git(repo, ['fast-import', '--quiet'], s)
}

/** A workspace whose project `p` is a git repository on main, worked in by its agents in the folder itself (Solo). */
async function workspace(name: string): Promise<{ w: WS; repo: string }> {
  const repo = join(base, name, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, ['config', k, v])
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'initial'])
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Other' }] }))
  const w = createWorkspaceService()
  await w.open(join(base, name))
  opened.push(w)
  return { w, repo }
}

const factsOf = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: '' }).facts(card)

describe('a shared folder attributes a burst of commits in batches (HI-2379)', () => {
  it("the folder's only card: each commit attributed once, its head moving from each to the next across the batches, its log read once a batch", async () => {
    const { w, repo } = await workspace('one')
    const card = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    await reconcileNow(w, repo)
    const n = ATTRIBUTE_BATCH * 2 + 37
    manyCommits(repo, 'big', n)
    git(repo, ['merge', '-q', '--ff-only', 'big'])
    const reads = vi.spyOn(FactStore.prototype, 'facts')
    try {
      await reconcileNow(w, repo, ['main'])
      // Its log read a few times a batch at most (each batch's fold, and the run's own reads of the card), never a commit.
      const ofCard = reads.mock.calls.filter(([c]) => c === card).length
      expect(ofCard).toBeLessThan(n / 10)
    } finally {
      reads.mockRestore()
    }
    const all = [...git(repo, ['rev-list', '--reverse', 'main@{1}..main']).split('\n')]
    expect(all).toHaveLength(n)
    expect(FactStore.forBoard(w, { project: 'p', key: '' }).folderCommits(repo).map((r) => r.sha)).toEqual(all)
    const facts = factsOf(w, card)
    expect(facts.filter((f) => f.kind === 'CommitAttributed').map((f) => (f.data as { commit: string }).commit)).toEqual(all)
    // Each HeadMoved follows the one before it (its dedupe the head fact it follows, from its `to`): one chain.
    const moves = facts.filter((f) => f.kind === 'HeadMoved')
    expect(moves.map((f) => (f.data as { to: string }).to)).toEqual(all)
    for (let i = 1; i < moves.length; i++) expect({ i, dedupe: moves[i].dedupe, from: (moves[i].data as { from: string }).from }).toEqual({ i, dedupe: `prev:${moves[i - 1].seq}`, from: (moves[i - 1].data as { to: string }).to })
    // Once more: nothing new.
    await reconcileNow(w, repo, ['main'])
    expect(factsOf(w, card)).toHaveLength(facts.length)
  }, 120_000)

  it("two cards in the folder: trailers across a batch's edge go to their card, the rest unattributed, each recorded once", async () => {
    const { w, repo } = await workspace('two')
    const [one, two] = await inWorkspace(w, async () => [(await tasks.createTask({ title: 'One', project: 'p' }, user)).number, (await tasks.createTask({ title: 'Two', project: 'p' }, user)).number])
    await inWorkspace(w, () => tasks.updateTask(one, { column: 'doing', agent: 'a1' }, user))
    await inWorkspace(w, () => tasks.updateTask(two, { column: 'doing', agent: 'a2' }, user))
    await reconcileNow(w, repo)
    const n = ATTRIBUTE_BATCH + 20
    // Two's trailer on the commits either side of the first batch's edge.
    const edge = new Set([ATTRIBUTE_BATCH - 2, ATTRIBUTE_BATCH - 1, ATTRIBUTE_BATCH, ATTRIBUTE_BATCH + 1])
    manyCommits(repo, 'big', n, (i) => (edge.has(i) ? `P-${two}` : null))
    const all = (() => {
      git(repo, ['merge', '-q', '--ff-only', 'big'])
      return git(repo, ['rev-list', '--reverse', 'main@{1}..main']).split('\n')
    })()
    await reconcileNow(w, repo, ['main'])
    const recorded = FactStore.forBoard(w, { project: 'p', key: '' }).folderCommits(repo)
    expect(recorded.map((r) => r.sha)).toEqual(all)
    const toTwo = all.filter((_, i) => edge.has(i))
    expect(recorded.filter((r) => r.card === two).map((r) => [r.sha, r.how])).toEqual(toTwo.map((s) => [s, 'trailer']))
    expect(recorded.filter((r) => r.card !== two).every((r) => r.card === null && r.how === 'unattributed')).toBe(true)
    expect(factsOf(w, two).filter((f) => f.kind === 'HeadMoved').map((f) => (f.data as { to: string }).to)).toEqual(toTwo)
    expect(factsOf(w, one).some((f) => f.kind === 'CommitAttributed' || f.kind === 'HeadMoved')).toBe(false)
  }, 120_000)
})
