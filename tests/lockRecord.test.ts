// G16 in the app (#1481): each agent's file locks, as its sessions publish them (`lockedFiles` in `session-status`),
// are recorded on its current card (`FilesLocked`), and a commit in the shared folder that includes another agent's
// recorded file is warned about, naming that card, after the lock is released and after a restart; nothing is refused.
// The record is the card's: the agent's next card starts its own, a lock seen before it never lands on it, and a card
// Done no longer counts. Solo's submit.clean doesn't count another agent's locked changes as the submitter's.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-lockrecord-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { runCardIntent } = await import('../src/main/cardIntents')
const { emit } = await import('../src/main/events')
const { fileLockDepth } = await import('../src/main/fsutil')
const { startLockRecords } = await import('../src/main/workflow/lockRecord')
const { foldCard } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
const stopRecords = startLockRecords()
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  stopRecords()
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** The bound for a hung run. */
const HUNG_MS = 15_000
const user = { kind: 'user' } as const
const agent = (id: string) => ({ kind: 'agent', name: `${id} (p)`, self: { project: 'p', agentId: id }, scope: 'p' }) as const
const A = agent('a1')
const B = agent('a2')
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** Solo (Git): every card in the project folder, Done once committed; G16 on. */
const SOLO = (() => {
  const { platform: _p, ...o } = preset('git', 'solo')
  return o
})()

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

/** A workspace with a Git project `p` under Solo, and two agents in its folder (a1, a2). */
async function workspace(): Promise<{ w: WS; ws: string; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'one.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'a1' }, { id: 'a2', name: 'a2' }], workflow: { platform: 'git', preset: 'solo', options: SOLO } }))
  return { w: await open(ws), ws, repo }
}

const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const locked = (w: WS, card: number): string[] => foldCard(facts(w, card)).locked
const create = (w: WS, title: string) => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
/** A card started by an agent: its number and key. */
async function started(w: WS, title: string, by: typeof A | typeof B): Promise<{ n: number; key: string }> {
  const card = await create(w, title)
  await act(w, card, by, { kind: 'start' })
  return { n: card, key: FactStore.forBoard(w, { project: 'p', key: 'p' }).card(card).key }
}
/** A commit of these files in the shared folder, for a card (its trailer). */
function commit(repo: string, files: Record<string, string>, key: string): void {
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', `work on ${key}`, '--trailer', `Combwork-Card: ${key}`)
}
/** What a session publishes as its locks change (sessions.publishLocks): its files relative to its folder. */
function locks(repo: string, agentId: string, lockedFiles: string[]): void {
  emit({ type: 'session-status', state: { projectPath: repo, agentId, cwd: repo, status: 'working', ...(lockedFiles.length ? { lockedFiles } : {}) } as never })
}
const submit = (w: WS, card: number, by: typeof A | typeof B) => act(w, card, by, { kind: 'submit', summary: 'done' })

describe("G16's lock records in the app (#1481)", () => {
  it("warns of another agent's recorded file, naming its card, after the lock is released; nothing refused", async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    locks(repo, 'a1', ['one.txt'])
    await vi.waitFor(() => expect(locked(w, x.n)).toEqual(['one.txt']), { timeout: HUNG_MS })
    // The lock released as A's turn ends: the record stays.
    locks(repo, 'a1', [])
    const z = await started(w, 'Z', B)
    commit(repo, { 'one.txt': 'one, by B\n', 'two.txt': 'two\n' }, z.key)
    expect((await submit(w, z.n, B)).done).toMatchObject({ ok: true, warnings: [`one.txt is a1's (${x.key})`] })
  })

  it('after a restart the record is still the card’s, until the card is Done', async () => {
    const { w, ws, repo } = await workspace()
    const x = await started(w, 'X', A)
    locks(repo, 'a1', ['one.txt'])
    await vi.waitFor(() => expect(locked(w, x.n)).toEqual(['one.txt']), { timeout: HUNG_MS })
    await disposeWorkspaceService(w)
    const w2 = await open(ws)
    const z = await started(w2, 'Z', B)
    commit(repo, { 'one.txt': 'one, by B\n' }, z.key)
    expect((await submit(w2, z.n, B)).done.warnings).toEqual([`one.txt is a1's (${x.key})`])
    // Once X is Done, its files aren't anyone's.
    commit(repo, { 'x.txt': 'x\n' }, x.key)
    expect((await act(w2, x.n, A, { kind: 'submit', summary: 'X' })).done.to).toBe('done')
    const z2 = await started(w2, 'Z2', B)
    commit(repo, { 'one.txt': 'one, by B again\n' }, z2.key)
    expect((await submit(w2, z2.n, B)).done.warnings).toBeUndefined()
  })

  it("a file both agents locked in turn is still the submitter's own: its uncommitted edit refuses submit.clean, and G16 still warns of the other card (HR6's round 2)", async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    const z = await started(w, 'Z', B)
    locks(repo, 'a1', ['one.txt'])
    locks(repo, 'a1', [])
    locks(repo, 'a2', ['one.txt'])
    await vi.waitFor(() => expect([locked(w, x.n), locked(w, z.n)]).toEqual([['one.txt'], ['one.txt']]), { timeout: HUNG_MS })
    commit(repo, { 'two.txt': 'two\n' }, z.key)
    // B's own edit to one.txt, not committed.
    writeFileSync(join(repo, 'one.txt'), 'one, B at work\n')
    await expect(submit(w, z.n, B)).rejects.toMatchObject({ refusal: { rule: 'submit.clean' } })
    // Committed with the change: submitted, warning of A's card too.
    git(repo, 'add', 'one.txt')
    git(repo, 'commit', '-qm', 'one', '--trailer', `Combwork-Card: ${z.key}`)
    expect((await submit(w, z.n, B)).done).toMatchObject({ ok: true, warnings: [`one.txt is a1's (${x.key})`] })
  })

  it('a submit right after the lock event sees it: the recording is queued before the submit reads the records', async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    const z = await started(w, 'Z', B)
    commit(repo, { 'one.txt': 'one, by B\n' }, z.key)
    // No wait between them: the submit waits for the lock's record itself.
    locks(repo, 'a1', ['one.txt'])
    const r = await submit(w, z.n, B)
    expect(r.done.warnings).toEqual([`one.txt is a1's (${x.key})`])
  })

  it("the agent's next card has its own record: an earlier card's files stop counting, a path locked again is the new card's, [one] → [] → [two] records both", async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    locks(repo, 'a1', ['one.txt'])
    locks(repo, 'a1', [])
    locks(repo, 'a1', ['two.txt'])
    await vi.waitFor(() => expect(locked(w, x.n)).toEqual(['one.txt', 'two.txt']), { timeout: HUNG_MS })
    locks(repo, 'a1', [])
    // A starts Y, X still unfinished: Y is A's current card.
    const y = await started(w, 'Y', A)
    locks(repo, 'a1', ['y.txt'])
    await vi.waitFor(() => expect(locked(w, y.n)).toEqual(['y.txt']), { timeout: HUNG_MS })
    const z = await started(w, 'Z', B)
    commit(repo, { 'one.txt': 'one, by B\n', 'y.txt': 'y, by B\n' }, z.key)
    expect((await submit(w, z.n, B)).done.warnings).toEqual([`y.txt is a1's (${y.key})`])
    // The same path locked again, now on Y: Y's.
    locks(repo, 'a1', [])
    locks(repo, 'a1', ['one.txt'])
    await vi.waitFor(() => expect(locked(w, y.n)).toEqual(['y.txt', 'one.txt']), { timeout: HUNG_MS })
    expect(locked(w, x.n)).toEqual(['one.txt', 'two.txt'])
    const z2 = await started(w, 'Z2', B)
    commit(repo, { 'one.txt': 'one, by B again\n' }, z2.key)
    expect((await submit(w, z2.n, B)).done.warnings).toEqual([`one.txt is a1's (${y.key})`])
  })

  it("a lock seen on one card, recorded only after the agent's next start, never lands on the next card", async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    const next = await create(w, 'Y')
    // The board's queue held: A's start of Y is queued first, then the lock seen while X is A's card.
    let release!: () => void
    const held = store.boardWrite(w, () => new Promise<void>((r) => (release = r)))
    const lockPath = store.boardLock(w.path!)
    await vi.waitFor(() => expect(fileLockDepth(lockPath)).toBe(1), { timeout: HUNG_MS })
    const starting = act(w, next, A, { kind: 'start' })
    await vi.waitFor(() => expect(fileLockDepth(lockPath)).toBe(2), { timeout: HUNG_MS })
    locks(repo, 'a1', ['old.txt'])
    locks(repo, 'a1', [])
    await vi.waitFor(() => expect(fileLockDepth(lockPath)).toBe(3), { timeout: HUNG_MS })
    release()
    await held
    await starting
    // Every queued write done: X's lock went on neither card (X isn't A's current card when it is written; Y started after).
    await vi.waitFor(() => expect(fileLockDepth(lockPath)).toBe(0), { timeout: HUNG_MS })
    expect(locked(w, next)).toEqual([])
    expect(locked(w, x.n)).toEqual([])
    expect(facts(w, next).some((f) => f.kind === 'FilesLocked')).toBe(false)
  })

  it('a session with no card started records nothing', async () => {
    const { w, repo } = await workspace()
    const x = await create(w, 'X')
    locks(repo, 'a1', ['one.txt'])
    const z = await started(w, 'Z', B)
    commit(repo, { 'one.txt': 'one, by B\n' }, z.key)
    expect((await submit(w, z.n, B)).done.warnings).toBeUndefined()
    expect(facts(w, x).some((f) => f.kind === 'FilesLocked')).toBe(false)
  })

  it("Solo's submit.clean in the shared folder: another agent's uncommitted locked change isn't the submitter's; its own is", async () => {
    const { w, repo } = await workspace()
    const x = await started(w, 'X', A)
    locks(repo, 'a1', ['one.txt'])
    await vi.waitFor(() => expect(locked(w, x.n)).toEqual(['one.txt']), { timeout: HUNG_MS })
    // A's edit, not committed.
    writeFileSync(join(repo, 'one.txt'), 'one, A at work\n')
    const z = await started(w, 'Z', B)
    writeFileSync(join(repo, 'two.txt'), 'two\n')
    git(repo, 'add', 'two.txt')
    git(repo, 'commit', '-qm', 'two', '--trailer', `Combwork-Card: ${z.key}`)
    expect((await submit(w, z.n, B)).done).toMatchObject({ ok: true })
    // B's own uncommitted file: refused.
    const z2 = await started(w, 'Z2', B)
    writeFileSync(join(repo, 'three.txt'), 'three\n')
    git(repo, 'add', 'three.txt')
    git(repo, 'commit', '-qm', 'three', '--trailer', `Combwork-Card: ${z2.key}`)
    writeFileSync(join(repo, 'b-loose.txt'), 'not committed\n')
    await expect(submit(w, z2.n, B)).rejects.toMatchObject({ refusal: { rule: 'submit.clean' } })
  })
})
