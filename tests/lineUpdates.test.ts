// An agent's worktree between a lane's cards (#1271, SPEC §16.19.2): after a squash merge the builder's branch isn't in
// the target, so the lane's next card waits (its start refused, lane.lineBehind) while Combwork brings the branch up to date:
// once the builder is idle with no run going and its worktree clean, and only when everything on it is in the target;
// recorded as LineMoved on the card just Done, before the next card's Started (whose base is its `to`). Work that isn't
// in the target, and git's refusal, are asked of the user (For you); with the switch off the user is asked every time;
// with workflow rules off nothing moves. A merge commit needs nothing. On a real board (a temp combwork.db) and temp repos.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// The index's renames, refusable (HR2's round 3): `times` renames onto `to` refused with EPERM, as Windows can.
const renameFault = vi.hoisted(() => ({ to: '', times: 0 }))
vi.mock('original-fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const norm = (v: unknown): string => String(v).replaceAll('\\', '/').toLowerCase()
  return {
    ...real,
    renameSync: (from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
      if (renameFault.times > 0 && renameFault.to && norm(to) === norm(renameFault.to)) {
        renameFault.times--
        throw Object.assign(new Error('EPERM: rename refused'), { code: 'EPERM' })
      }
      return real.renameSync(from, to)
    }
  }
})

const base = tempDir('cw-lines-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { runCardIntent } = await import('../src/main/cardIntents')
const lines = await import('../src/main/workflow/lineUpdates')
const { GitPlatform } = await import('../src/main/platform/gitPlatform')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const { forYou } = await import('../src/main/workflow/cardWork')
const service = await import('../src/main/workflow/service')
const G = await import('../src/main/platform/git')
const { gitTestHooks } = await import('../src/main/git')
const { Workflow } = await import('../src/main/workflow/runtime')
const { GIT_HEAVY_MS } = await import('./workflow/harness')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
// Each workspace, intent and pass with its time, said if the test fails (#1479: a timeout under load said only "timed
// out in 20000ms"): whether one step hung (still running) or every step was slow.
const steps: string[] = []
const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  const t = Date.now()
  const i = steps.push(`${what}: still running`) - 1
  try {
    return await run()
  } finally {
    steps[i] = `${what}: ${Date.now() - t} ms`
  }
}
beforeEach(({ onTestFailed }) => {
  steps.length = 0
  const began = Date.now()
  onTestFailed(() => console.error(`Its steps (${Date.now() - began} ms in all): ${steps.join('; ')}`))
})
afterEach(async () => {
  await advanced.set(ENFORCE, true)
  await advanced.set(lines.UPDATE_AGENT_BRANCH, true)
  lines.setAgentBusy(null)
  lines.resetLineUpdates()
  vi.restoreAllMocks()
})
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges (squash or merge commit), the builder's own worktree. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const
/** The same with no review: a submission passes at once (HI-1963: a test whose subject is the merges, not the reviews). */
const UNREVIEWED = { ...PAIR, review: 'none', noSelfReview: false } as const

const workspace = (options: typeof PAIR | typeof UNREVIEWED = PAIR) => step('workspace', () => makeWorkspace(options))
async function makeWorkspace(options: typeof PAIR | typeof UNREVIEWED): Promise<{ w: WS; repo: string; wt: string; cards: number[]; lane: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  const cards: number[] = []
  for (const title of ['One', 'Two', 'Three']) cards.push(await inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number))
  const lane = (await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards, rounds: 10, by: 'Builder (p)' })).lane.id
  return { w, repo, wt, cards, lane }
}

type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => step(`${intent.kind} #${card}`, () => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent)))
const refused = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p
    return null
  } catch (e) {
    const r = (e as { refusal?: { rule: string } }).refusal
    if (!r) throw e
    return r.rule
  }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const commit = (wt: string, file: string): string => {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  return git(wt, 'rev-parse', 'HEAD')
}

/** A card built in the worktree (one commit, `file`), reviewed and passed: Approved. `reviewed` false: submitted with no review (UNREVIEWED). */
async function approved(w: WS, wt: string, card: number, file: string, reviewed = true): Promise<string> {
  await act(w, card, builder, { kind: 'start' })
  const rev = commit(wt, file)
  await act(w, card, builder, { kind: 'submit', summary: file })
  if (!reviewed) return rev
  await act(w, card, reviewer, { kind: 'startReview' })
  await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'PASSED' })
  return rev
}

/**
 * The builder merges its approved card into main as `how` (a squash, or a merge commit) and reports it: Done. Combwork's
 * reconciler follows the project from the card's approval (service.ts) and may find the merge first (its watcher's run,
 * 400 ms after the commit, ahead of a slow report under load, HI-3101): then the card is Done already and the report is
 * refused from there.
 */
async function merged(w: WS, repo: string, card: number, how: 'squash' | 'merge', rev = 'card'): Promise<void> {
  if (how === 'squash') {
    git(repo, 'merge', '-q', '--squash', rev)
    git(repo, 'commit', '-qm', `squash #${card}`)
  } else git(repo, 'merge', '-q', '--no-ff', '-m', `merge #${card}`, rev)
  expect([null, 'move.notFromHere']).toContain(await refused(act(w, card, builder, { kind: 'reportMerge' })))
  expect(foldCard(facts(w, card)).stage).toBe('done')
}

const update = (w: WS) => step('update', () => inWorkspace(w, () => lines.updateLines(w)))
const laneStatus = async (w: WS, lane: string) => (await lanes.getLane(w, lane)).status

describe("an agent's branch between a lane's cards (#1271)", () => {
  // GIT_HEAVY_MS (HI-2025's rule): two cards squash-merged through real git on a real board, the branch brought up to date
  // between them; 4.0 s alone, 9.6 s beside three spinner workers, and past 20 s in HI-2453's proof beside two (every step
  // slow, about 2 to 4 s each, none hung).
  it('after a squash, the next card waits; Combwork brings the branch up to date; two squashed cards in a row each review only their own work', { timeout: GIT_HEAVY_MS }, async () => {
    // No review step (HI-1963: 16 workflow steps timed out at 20 s in a multi-file run): what each card would be reviewed
    // on is its submission, checked below; the other tests here go through the review.
    const { w, repo, wt, cards, lane } = await workspace(UNREVIEWED)
    const [c1, c2, c3] = cards
    await approved(w, wt, c1, 'one.txt', false)
    await merged(w, repo, c1, 'squash')
    // Not in main (its commit was squashed): the next card's start waits for the branch.
    expect(await refused(act(w, c2, builder, { kind: 'start' }))).toBe('lane.lineBehind')
    await update(w)
    const moved = facts(w, c1).find((f) => f.kind === 'LineMoved')
    const main1 = git(repo, 'rev-parse', 'main')
    expect(moved?.data).toMatchObject({ line: 'card', to: main1, why: 'squashContinuation' })
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(main1)
    expect(lines.lineWaiting(w, lane)).toBeNull()
    // Started on the moved line: its base is the LineMoved's `to`; its submission only its own file.
    await approved(w, wt, c2, 'two.txt', false)
    const s2 = foldCard(facts(w, c2))
    expect(s2.started?.base).toBe(main1)
    expect(s2.latest?.files.map((f) => f.path)).toEqual(['two.txt'])
    // And again for the third.
    await merged(w, repo, c2, 'squash')
    await update(w)
    // Its submission is what's checked: no review needed (#1479: less work for a test near its bound under load).
    await act(w, c3, builder, { kind: 'start' })
    commit(wt, 'three.txt')
    await act(w, c3, builder, { kind: 'submit', summary: 'three.txt' })
    expect(foldCard(facts(w, c3)).latest?.files.map((f) => f.path)).toEqual(['three.txt'])
    // The builder was told each time.
    const wakes = store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE kind = 'wake'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as { agent: string; why: string })
    expect(wakes.filter((x) => x.agent === 'a1' && /is up to date with main/.test(x.why))).toHaveLength(2)
  })

  it('a merge commit leaves the branch in main: nothing to do, the next card starts', async () => {
    const { w, repo, wt, cards } = await workspace()
    await approved(w, wt, cards[0], 'one.txt')
    await merged(w, repo, cards[0], 'merge')
    await update(w)
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBeNull()
  })

  it('a dirty worktree, a busy builder and a run going each wait (the lane says why), then it moves', async () => {
    const { w, repo, wt, cards, lane } = await workspace()
    await approved(w, wt, cards[0], 'one.txt')
    await merged(w, repo, cards[0], 'squash')
    // Uncommitted work in the worktree: waits.
    const dirty = Date.now()
    writeFileSync(join(wt, 'scratch.txt'), 'not yet\n')
    await update(w)
    expect(lines.lineWaiting(w, lane)).toBe(cards[1])
    const waits = await laneStatus(w, lane)
    expect(waits).toEqual({ reason: 'lineUpdate', card: cards[1], since: expect.any(Number) })
    // HI-1926: since is when the wait began, the update that found the worktree dirty.
    expect(waits!.since).toBeGreaterThanOrEqual(dirty)
    expect(waits!.since).toBeLessThanOrEqual(Date.now())
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    rmSync(join(wt, 'scratch.txt'))
    // The builder in a turn: waits.
    lines.setAgentBusy(() => true)
    await update(w)
    expect(lines.lineWaiting(w, lane)).toBe(cards[1])
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    // Idle again: moved.
    lines.setAgentBusy(null)
    await update(w)
    expect(lines.lineWaiting(w, lane)).toBeNull()
    expect(await laneStatus(w, lane)).toBeNull()
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(true)
  })

  // GIT_HEAVY_MS (HI-2494, HI-2453's policy): about 50 real Git commands for approval, a late commit, squash and
  // two update passes; 94% of its 2.5 s isolated time was Git. At ~100% CPU it exceeded 20 s with every step slow
  // (workspace 4.0 s, submit 2.9 s, verdict 4.9 s, reportMerge 3.3 s), rather than one condition left unawaited.
  it('a commit made after approval is work not in main: asked of the user (Decide), once, and nothing moves', { timeout: GIT_HEAVY_MS }, async () => {
    const { w, repo, wt, cards } = await workspace()
    const rev = await approved(w, wt, cards[0], 'one.txt')
    commit(wt, 'late.txt')
    // The approved revision is what was merged: the late commit isn't in main.
    await merged(w, repo, cards[0], 'squash', rev)
    await update(w)
    const asked = forYou(w).items.filter((i) => i.card === cards[1])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'decide' })
    expect(asked[0].text).toMatch(/^card has work that isn't in main: [0-9a-f]{7} late\.txt\./)
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('late.txt')
    // Looked at again: not asked twice.
    await update(w)
    expect(forYou(w).items.filter((i) => i.card === cards[1])).toHaveLength(1)
  })

  it("git's refusal is asked of the user with its reason, nothing else tried", async () => {
    const { w, repo, wt, cards } = await workspace()
    await approved(w, wt, cards[0], 'one.txt')
    await merged(w, repo, cards[0], 'squash')
    const move = vi.spyOn(GitPlatform.prototype, 'moveLine').mockResolvedValue('error: Entry one.txt would be overwritten by merge')
    await update(w)
    expect(move).toHaveBeenCalledTimes(1)
    const asked = forYou(w).items.filter((i) => i.card === cards[1])
    expect(asked).toHaveLength(1)
    expect(asked[0].text).toContain("Git wouldn't bring card up to date with main: error: Entry one.txt would be overwritten by merge.")
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    await update(w)
    expect(move).toHaveBeenCalledTimes(1)
  })

  // GIT_HEAVY_MS (HI-2025's rule): two cards squash-merged through real git on a real board, the branch asked about twice;
  // 3.7 s alone, 10 s beside three spinner workers, and past 20 s in HI-2453's loaded full run, every step slow (about
  // 2 s each), none hung.
  it('switched off, the user is asked every time: approved, Combwork moves it once; declined, it stays for the user', { timeout: GIT_HEAVY_MS }, async () => {
    await advanced.set(lines.UPDATE_AGENT_BRANCH, false)
    const { w, repo, wt, cards } = await workspace()
    const [c1, c2, c3] = cards
    await approved(w, wt, c1, 'one.txt')
    await merged(w, repo, c1, 'squash')
    await update(w)
    let asked = forYou(w).items.filter((i) => i.card === c2)
    expect(asked).toMatchObject([{ kind: 'approve' }])
    expect(asked[0].text).toMatch(/^card still has .+'s work, squashed into main: approve and Combwork brings the branch up to date once/)
    expect(facts(w, c1).some((f) => f.kind === 'LineMoved')).toBe(false)
    await inWorkspace(w, () => tasks.answerTask(c2, asked[0].request, { outcome: 'approved' }))
    await update(w)
    expect(facts(w, c1).some((f) => f.kind === 'LineMoved')).toBe(true)
    // The next squash asks again; declined, nothing moves (the user brings it up to date).
    await approved(w, wt, c2, 'two.txt')
    await merged(w, repo, c2, 'squash')
    await update(w)
    asked = forYou(w).items.filter((i) => i.card === c3)
    expect(asked).toHaveLength(1)
    await inWorkspace(w, () => tasks.answerTask(c3, asked[0].request, { outcome: 'declined' }))
    await update(w)
    expect(facts(w, c2).some((f) => f.kind === 'LineMoved')).toBe(false)
    expect(await refused(act(w, c3, builder, { kind: 'start' }))).toBe('lane.lineBehind')
    // The user does it: the card starts.
    git(wt, 'reset', '-q', '--keep', 'main')
    expect(await refused(act(w, c3, builder, { kind: 'start' }))).toBeNull()
  })

  it('with workflow rules off, Combwork never moves the branch nor asks, and nothing waits for it', async () => {
    const { w, repo, wt, cards, lane } = await workspace()
    await approved(w, wt, cards[0], 'one.txt')
    await merged(w, repo, cards[0], 'squash')
    await advanced.set(ENFORCE, false)
    await update(w)
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(false)
    expect(forYou(w).count).toBe(0)
    expect(lines.lineWaiting(w, lane)).toBeNull()
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBeNull()
  })
})

// HR2's round 1 finding 1: the move is checked again just before it, and only from the exact state checked; anything
// that changes during the slow reads (containment, here) leaves the branch as it is, every commit kept.
describe('the move checked again at its boundary (#1271 round 2)', () => {
  /** Runs `during` while the updater's containment read is under way (after the safe moment was checked). */
  const whileChecking = (during: () => Promise<void> | void) => {
    const contains = GitPlatform.prototype.contains
    vi.spyOn(GitPlatform.prototype, 'contains').mockImplementation(async function (this: InstanceType<typeof GitPlatform>, target, change) {
      const r = await contains.call(this, target, change)
      await during()
      return r
    })
  }
  /** A lane whose first card was squashed into main: its builder's branch held up. */
  const squashed = async () => {
    const env = await workspace()
    await approved(env.w, env.wt, env.cards[0], 'one.txt')
    await merged(env.w, env.repo, env.cards[0], 'squash')
    return { ...env, head: git(env.wt, 'rev-parse', 'HEAD') }
  }
  const lineMoved = (w: WS, card: number) => facts(w, card).filter((f) => f.kind === 'LineMoved')

  it('a commit landing meanwhile is kept: nothing moves, and the next look asks about it', async () => {
    const { w, wt, cards, lane, head } = await squashed()
    whileChecking(() => void commit(wt, 'late-after-check.txt'))
    await update(w)
    expect(lineMoved(w, cards[0])).toEqual([])
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('late-after-check.txt')
    expect(git(wt, 'rev-parse', 'HEAD~1')).toBe(head)
    expect(lines.lineWaiting(w, lane)).toBe(cards[1])
    vi.restoreAllMocks()
    await update(w)
    expect(forYou(w).items.filter((i) => i.card === cards[1]).map((i) => i.text)[0]).toMatch(/late-after-check\.txt/)
    expect(lineMoved(w, cards[0])).toEqual([])
  })

  it('the target moving meanwhile: nothing moves; the next look moves to its new head', async () => {
    const { w, repo, cards } = await squashed()
    whileChecking(() => void commit(repo, 'main-moved.txt'))
    await update(w)
    expect(lineMoved(w, cards[0])).toEqual([])
    vi.restoreAllMocks()
    await update(w)
    expect(lineMoved(w, cards[0]).map((f) => (f.data as { to: string }).to)).toEqual([git(repo, 'rev-parse', 'main')])
  })

  // One case a test, each its own workspace (HR2's round 2: five in one test outran its bound under load).
  const meanwhile: [string, (env: Awaited<ReturnType<typeof squashed>>) => Promise<void> | void][] = [
    ['the builder busy', () => lines.setAgentBusy(() => true)],
    ['a run going', () => service.setRunsGoing(() => ['unit tests'])],
    ['the switch turned off', () => advanced.set(lines.UPDATE_AGENT_BRANCH, false)],
    ['the rules turned off', () => advanced.set(ENFORCE, false)],
    [
      'the workspace closed',
      async (env) => {
        opened.splice(opened.indexOf(env.w), 1)
        await disposeWorkspaceService(env.w)
      }
    ]
  ]
  it.each(meanwhile)('%s meanwhile: nothing moves', async (what, during) => {
    const env = await squashed()
    try {
      whileChecking(() => during(env))
      await update(env.w).catch(() => undefined)
      expect(git(env.wt, 'rev-parse', 'HEAD')).toBe(env.head)
      if (what !== 'the workspace closed') expect(lineMoved(env.w, env.cards[0])).toEqual([])
    } finally {
      service.setRunsGoing(null)
    }
  })

  // HR2's round 2 finding 1: the move itself is serialized with the worktree's other git work and conditional on the
  // exact branch, head and target, its authority asked at that boundary; nothing is reset blindly.
  describe('at the move itself', () => {
    afterEach(() => {
      gitTestHooks.started = undefined
    })
    /** Runs `fn` once, as the move's git command `cmd` starts (synchronously, before it runs). */
    const atCommand = (cmd: string, fn: () => void) => {
      let done = false
      gitTestHooks.started = (_cwd, args) => {
        if (done || args[0] !== cmd) return
        done = true
        fn()
      }
    }

    it('only from the head, branch and target checked, and only while go holds', async () => {
      const { repo, wt, head } = await squashed()
      const main = git(repo, 'rev-parse', 'main')
      expect(await G.moveLineLocked(wt, main, { line: 'other', head, target: 'main' }, () => true)).toBeNull()
      expect(await G.moveLineLocked(wt, main, { line: 'card', head: main, target: 'main' }, () => true)).toBeNull()
      expect(await G.moveLineLocked(wt, head, { line: 'card', head, target: 'main' }, () => true)).toBeNull()
      expect(await G.moveLineLocked(wt, main, { line: 'card', head, target: 'main' }, () => false)).toBeNull()
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
      expect(await G.moveLineLocked(wt, main, { line: 'card', head, target: 'main' }, () => true)).toBe(true)
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(main)
      expect(git(wt, 'status', '--porcelain')).toBe('')
    })

    it('a git write tried in the worktree during the move is refused by git (the move holds its index), and nothing is lost', async () => {
      const { repo, wt, cards, w } = await squashed()
      let tried = ''
      atCommand('update-ref', () => {
        writeFileSync(join(wt, 'racing.txt'), 'racing\n')
        try {
          git(wt, 'add', 'racing.txt')
          tried = 'added'
        } catch (e) {
          tried = String((e as Error).message)
        }
      })
      await update(w)
      expect(tried).toMatch(/index\.lock/)
      // Moved and recorded; the racing file is still there, untracked, for the agent to add again.
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
      expect(lineMoved(w, cards[0])).toHaveLength(1)
      expect(git(wt, 'status', '--porcelain')).toBe('?? racing.txt')
    })

    it('the branch moved by another route as it is moved: the compare-and-swap fails, the files are put back, the branch keeps that commit', async () => {
      const { wt, cards, w, head } = await squashed()
      let other = ''
      atCommand('update-ref', () => {
        // A commit made with no index (as a fetch or a script would), the branch set to it.
        other = git(wt, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'elsewhere')
        git(wt, 'update-ref', 'refs/heads/card', other)
      })
      await update(w)
      expect(git(wt, 'rev-parse', 'refs/heads/card')).toBe(other)
      expect(lineMoved(w, cards[0])).toEqual([])
      // The worktree's files are the head's again (nothing of main's left over them).
      expect(git(wt, 'diff', '--stat', head)).toBe('')
    })

    it('the rules turned off as the move takes its lock: asked at that boundary, nothing moves', async () => {
      const { wt, cards, w, head } = await squashed()
      // The move's first git command once it holds the index's lock: the rules turned off just as it runs.
      const lock = join(G.gitDirSync(wt)!, 'index.lock')
      gitTestHooks.started = () => {
        if (existsSync(lock)) void advanced.set(ENFORCE, false)
      }
      await update(w)
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
      expect(lineMoved(w, cards[0])).toEqual([])
    })

    it("the next card's start during the move waits for its LineMoved (HR2's round 2 finding 2)", async () => {
      const { wt, cards, w } = await squashed()
      // Started just after the branch has moved (its head in main now), before its LineMoved is saved.
      let during: string | null | undefined
      let recorded = true
      const move = GitPlatform.prototype.moveLine
      vi.spyOn(GitPlatform.prototype, 'moveLine').mockImplementation(async function (this: InstanceType<typeof GitPlatform>, ...a: Parameters<typeof move>) {
        const r = await move.apply(this, a)
        if (r === true && during === undefined) {
          recorded = lineMoved(w, cards[0]).length > 0
          during = await refused(act(w, cards[1], builder, { kind: 'start' }))
        }
        return r
      })
      await update(w)
      expect(recorded).toBe(false)
      expect(during).toBe('lane.lineBehind')
      expect(lineMoved(w, cards[0])).toHaveLength(1)
      expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBeNull()
      const started = facts(w, cards[1]).find((f) => f.kind === 'Started')
      expect(started?.data).toMatchObject({ base: git(wt, 'rev-parse', 'main') })
    })

    it("a LineMoved that can't be saved: the move is undone the same way, nothing recorded", async () => {
      const { wt, cards, w, head } = await squashed()
      const write = Workflow.prototype.write
      vi.spyOn(Workflow.prototype, 'write').mockImplementation(function (this: InstanceType<typeof Workflow>, ...a: Parameters<typeof write>) {
        if (a[0].id === cards[0]) return Promise.reject(new Error('the board failed'))
        return write.apply(this, a)
      })
      await update(w)
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(wt, 'status', '--porcelain')).toBe('')
      expect(lineMoved(w, cards[0])).toEqual([])
    })

    // HI-1970: a moving pass asked git 12 times, four of them for paths its `.git` files say (the repository lock's
    // common dir, each line read's markers and target). The three status reads stay: the line is checked again before
    // the move.
    it('a moving pass reads its git paths and the target from the .git files, with no git process', async () => {
      const { repo, wt, cards, w } = await squashed()
      const ran: (readonly string[])[] = []
      // The pass's own: the reconciler, following the project since the card's approval, runs on its watcher's events
      // (the squash, the move) and may read git while the pass runs, under load (HI-3101).
      const stack = (): string => {
        const limit = Error.stackTraceLimit
        Error.stackTraceLimit = 100
        try {
          return new Error().stack ?? ''
        } finally {
          Error.stackTraceLimit = limit
        }
      }
      gitTestHooks.started = (_cwd, args) => void (!/[\\/]reconciler?\.ts:/.test(stack()) && ran.push(args))
      await update(w)
      gitTestHooks.started = undefined
      expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
      expect(lineMoved(w, cards[0])).toHaveLength(1)
      expect(ran.filter((a) => a.includes('--path-format=absolute'))).toEqual([])
      expect(ran.filter((a) => a[0] === 'status')).toHaveLength(3)
      expect(ran.length).toBeLessThanOrEqual(8)
    })
  })
})

// HR2's round 1 finding 2: what waits is each workspace's own.
// #1287's p4lane: a pass set off from inside another card's intent (a board event its write fires) ran its writes in that
// intent's context, whose hook wrote the intent's card from the moved card's write: card 3 Done, never started.
describe("a pass inside another card's intent (#1287)", () => {
  it("writes only its own cards: the intent's card keeps its column and stage", async () => {
    const { w, repo, wt, cards } = await workspace()
    await approved(w, wt, cards[0], 'one.txt')
    await merged(w, repo, cards[0], 'squash')
    const wf = (await service.workflowFor(w, repo))!
    // The next card's (refused) start, and the pass run from inside it.
    // (Its hook as a start's: the card given to its builder with its first write.)
    await inWorkspace(w, () => tasks.runIntent(wf, cards[1], builder, async () => update(w), (_w, first) => (first ? { patch: { agent: 'a1' } } : {})))
    expect(facts(w, cards[0]).some((f) => f.kind === 'LineMoved')).toBe(true)
    const c2 = await inWorkspace(w, () => tasks.getTask(cards[1], w))
    expect([c2.column, foldCard(facts(w, cards[1])).stage]).toEqual(['todo', 'todo'])
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBeNull()
  })
})

describe("each workspace's waiting lanes are its own (#1271 round 2)", () => {
  it("a pass over another workspace leaves this one's waiting lane as it is; a workspace closed is forgotten", async () => {
    const a = await workspace()
    await approved(a.w, a.wt, a.cards[0], 'one.txt')
    await merged(a.w, a.repo, a.cards[0], 'squash')
    writeFileSync(join(a.wt, 'scratch.txt'), 'not yet\n')
    await update(a.w)
    expect(lines.lineWaiting(a.w, a.lane)).toBe(a.cards[1])
    const b = await workspace()
    await update(b.w)
    expect(lines.lineWaiting(a.w, a.lane)).toBe(a.cards[1])
    expect(lines.lineWaiting(b.w, a.lane)).toBeNull()
    opened.splice(opened.indexOf(a.w), 1)
    await disposeWorkspaceService(a.w)
    await update(b.w)
    expect(lines.lineWaiting(a.w, a.lane)).toBeNull()
  })
})

// The Assistant's condition for rules off (#1120 point 2: P3's behaviour): 0.9's Merge dialog squash still moves the branch.
describe("with workflow rules off, 0.9's Merge dialog squash still moves the agent's branch (#1271)", () => {
  it('a squash with Move branch moves it to the merged branch, as before 1.0', async () => {
    await advanced.set(ENFORCE, false)
    const { repo, wt } = await workspace()
    // Combwork's merge commits in the repository as its own identity says (unit tests have no global git config).
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.com')
    commit(wt, 'work.txt')
    const { mergeWorktree } = await import('../src/main/worktrees')
    const r = await mergeWorktree(repo, { path: wt, branch: 'card', base: 'main' }, { squash: true, message: 'squash card', moveBranch: true })
    expect(r).toMatchObject({ ok: true, branchMoved: true })
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
  })
})

// HR2's round 3: a failure after the move's first change is put back, conditionally, or the next card is held until
// what was left is settled. The index renames refused as Windows can (EPERM), by an original-fs stand-in.
describe('a move failing after its first change (#1271 round 4)', () => {
  afterEach(() => {
    renameFault.to = ''
    renameFault.times = 0
    gitTestHooks.started = undefined
  })
  /** Refuses the next `times` renames onto `<index><suffix>` (the lock: '.lock'; the index itself: ''). */
  const refuseRename = (wt: string, suffix: '' | '.lock', times: number) => {
    renameFault.to = `${git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index')}${suffix}`
    renameFault.times = times
  }
  const squashed = async () => {
    const env = await workspace()
    await approved(env.w, env.wt, env.cards[0], 'one.txt')
    await merged(env.w, env.repo, env.cards[0], 'squash')
    // A file on main only, so a stale index would show it deleted (HR2's round 3 repro).
    commit(env.repo, 'target-only.txt')
    return { ...env, head: git(env.wt, 'rev-parse', 'HEAD') }
  }
  const kindsOf = (w: WS, card: number) => facts(w, card).map((f) => f.kind)
  const consistent = (wt: string, at: string) => {
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(at)
    expect(git(wt, 'status', '--porcelain')).toBe('')
    const index = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index')
    expect([existsSync(`${index}.lock`), existsSync(`${index}.cw-line`)]).toEqual([false, false])
  }

  it("the new index can't be staged in the lock: the files are put back, nothing moved, the user told, the next card held", async () => {
    const { w, wt, cards, head } = await squashed()
    refuseRename(wt, '.lock', 1)
    await update(w)
    expect(renameFault.times).toBe(0)
    consistent(wt, head)
    expect(kindsOf(w, cards[0])).not.toContain('LineMoved')
    expect(forYou(w).items.filter((i) => i.card === cards[1]).map((i) => i.text)[0]).toMatch(/^Git wouldn't bring card up to date with main: .*refused/)
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBe('lane.lineBehind')
  })

  it("the index can't be published after the branch moved: the branch is swapped back and the files with it, nothing lost", async () => {
    const { w, wt, cards, head } = await squashed()
    refuseRename(wt, '', 100)
    await update(w)
    consistent(wt, head)
    expect(kindsOf(w, cards[0])).not.toContain('LineMoved')
    expect(forYou(w).items.filter((i) => i.card === cards[1])).toHaveLength(1)
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBe('lane.lineBehind')
  })

  it('a rename refused a moment, as Windows can: tried again, and the move completes', async () => {
    const { w, wt, repo, cards } = await squashed()
    refuseRename(wt, '', 2)
    await update(w)
    consistent(wt, git(repo, 'rev-parse', 'main'))
    expect(kindsOf(w, cards[0])).toContain('LineMoved')
  })

  it("not put back (the branch moved on meanwhile): its LineMoving holds the next card, the user is asked once; settled by hand, it is recorded and the card starts", async () => {
    const { w, wt, repo, cards, head } = await squashed()
    refuseRename(wt, '', 100)
    // The branch moved elsewhere just as Combwork swaps it back: the swap back fails.
    let other = ''
    gitTestHooks.started = (_cwd, args) => {
      if (args[0] !== 'update-ref' || !args.some((x) => x.includes('put back')) || other) return
      other = git(wt, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'elsewhere')
      git(wt, 'update-ref', 'refs/heads/card', other)
    }
    await update(w)
    gitTestHooks.started = undefined
    renameFault.times = 0
    expect(kindsOf(w, cards[0])).toContain('LineMoving')
    expect(kindsOf(w, cards[0])).not.toContain('LineMoved')
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBe('lane.lineBehind')
    await update(w)
    expect(forYou(w).items.filter((i) => i.card === cards[1]).map((i) => i.text)[0]).toMatch(/didn't finish/)
    await update(w)
    expect(forYou(w).items.filter((i) => i.card === cards[1])).toHaveLength(1)
    // The user settles it: the line at main, clean. The next pass records the move done; the card starts.
    git(wt, 'reset', '-q', '--hard', 'main')
    await update(w)
    expect(kindsOf(w, cards[0])).toContain('LineMoved')
    expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBeNull()
    expect(foldCard(facts(w, cards[1])).started?.base).toBe(git(repo, 'rev-parse', 'main'))
  })

  // HR2's round 4: the files not put back, the head back where it began (before the ref moved, or after it was swapped
  // back). The head proves nothing: the move stays unfinished, the user is asked once, and a consistent state settles it.
  describe('the files not put back, the head where it began', () => {
    /** Makes the put-back's read-tree refuse: a local change to a file it would take away, as it runs. */
    const restoreFails = (wt: string, head: string) => {
      gitTestHooks.started = (_cwd, args) => {
        if (args[0] === 'read-tree' && args[args.length - 1] === head) writeFileSync(join(wt, 'target-only.txt'), 'changed by hand\n')
      }
    }
    for (const [when, suffix, times] of [
      ['before the ref moved (the lock rename refused)', '.lock', 1],
      ['after the ref was swapped back (the index rename refused)', '', 100]
    ] as const) {
      it(`${when}: unfinished, asked once, the next card held; settled by hand, recorded as not made, then moved`, async () => {
        const { w, wt, repo, cards, head } = await squashed()
        refuseRename(wt, suffix, times)
        restoreFails(wt, head)
        await update(w)
        gitTestHooks.started = undefined
        renameFault.times = 0
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
        expect(git(wt, 'status', '--porcelain')).not.toBe('')
        expect(kindsOf(w, cards[0]).filter((k) => k.startsWith('LineMov'))).toEqual(['LineMoving'])
        expect(await refused(act(w, cards[1], builder, { kind: 'start' }))).toBe('lane.lineBehind')
        await update(w)
        await update(w)
        const asked = forYou(w).items.filter((i) => i.card === cards[1])
        expect(asked).toHaveLength(1)
        expect(asked[0].text).toMatch(/didn't finish and couldn't be put back/)
        // The user puts the worktree back as the head has it, and answers: recorded as not made; the next pass moves it.
        git(wt, 'reset', '-q', '--hard', head)
        git(wt, 'clean', '-qfd')
        await inWorkspace(w, () => tasks.answerTask(cards[1], asked[0].request, { outcome: 'answered', reply: 'Put back as it was.' }))
        await update(w)
        expect(kindsOf(w, cards[0]).filter((k) => k.startsWith('LineMov'))).toEqual(['LineMoving', 'LineMoveUndone'])
        await update(w)
        consistent(wt, git(repo, 'rev-parse', 'main'))
        expect(kindsOf(w, cards[0]).filter((k) => k.startsWith('LineMov'))).toEqual(['LineMoving', 'LineMoveUndone', 'LineMoving', 'LineMoved'])
      })
    }
  })
})
