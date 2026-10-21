// An agent's worktree between a lane's cards (#1271, SPEC §16.19.2): after a squash merge the builder's branch isn't in
// the target, so the lane's next card waits (its start refused, lane.lineBehind) while Hive brings the branch up to date:
// once the builder is idle with no run going and its worktree clean, and only when everything on it is in the target;
// recorded as LineMoved on the card just Done, before the next card's Started (whose base is its `to`). Work that isn't
// in the target, and git's refusal, are asked of the user (For you); with the switch off the user is asked every time;
// with workflow rules off nothing moves. A merge commit needs nothing. On a real board (a temp hive.db) and temp repos.
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-lines-')
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

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
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

async function workspace(): Promise<{ w: WS; repo: string; wt: string; cards: number[]; lane: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: PAIR } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  const cards: number[] = []
  for (const title of ['One', 'Two', 'Three']) cards.push(await inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number))
  const lane = (await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards, rounds: 10, by: 'Builder (p)' })).lane.id
  return { w, repo, wt, cards, lane }
}

type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
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

/** A card built in the worktree (one commit, `file`), reviewed and passed: Approved. */
async function approved(w: WS, wt: string, card: number, file: string): Promise<string> {
  await act(w, card, builder, { kind: 'start' })
  const rev = commit(wt, file)
  await act(w, card, builder, { kind: 'submit', summary: file })
  await act(w, card, reviewer, { kind: 'startReview' })
  await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'PASSED' })
  return rev
}

/** The builder merges its approved card into main as `how` (a squash, or a merge commit) and reports it: Done. */
async function merged(w: WS, repo: string, card: number, how: 'squash' | 'merge', rev = 'card'): Promise<void> {
  if (how === 'squash') {
    git(repo, 'merge', '-q', '--squash', rev)
    git(repo, 'commit', '-qm', `squash #${card}`)
  } else git(repo, 'merge', '-q', '--no-ff', '-m', `merge #${card}`, rev)
  await act(w, card, builder, { kind: 'reportMerge' })
  expect(foldCard(facts(w, card)).stage).toBe('done')
}

const update = (w: WS) => inWorkspace(w, () => lines.updateLines(w))
const laneStatus = async (w: WS, lane: string) => (await lanes.getLane(w, lane)).status

describe("an agent's branch between a lane's cards (#1271)", () => {
  it('after a squash, the next card waits; Hive brings the branch up to date; two squashed cards in a row each review only their own work', async () => {
    const { w, repo, wt, cards, lane } = await workspace()
    const [c1, c2, c3] = cards
    await approved(w, wt, c1, 'one.txt')
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
    await approved(w, wt, c2, 'two.txt')
    const s2 = foldCard(facts(w, c2))
    expect(s2.started?.base).toBe(main1)
    expect(s2.latest?.files.map((f) => f.path)).toEqual(['two.txt'])
    // And again for the third.
    await merged(w, repo, c2, 'squash')
    await update(w)
    await approved(w, wt, c3, 'three.txt')
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
    writeFileSync(join(wt, 'scratch.txt'), 'not yet\n')
    await update(w)
    expect(lines.lineWaiting(w, lane)).toBe(cards[1])
    expect(await laneStatus(w, lane)).toEqual({ reason: 'lineUpdate', card: cards[1] })
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

  it('a commit made after approval is work not in main: asked of the user (Decide), once, and nothing moves', async () => {
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

  it('switched off, the user is asked every time: approved, Hive moves it once; declined, it stays for the user', async () => {
    await advanced.set(lines.UPDATE_AGENT_BRANCH, false)
    const { w, repo, wt, cards } = await workspace()
    const [c1, c2, c3] = cards
    await approved(w, wt, c1, 'one.txt')
    await merged(w, repo, c1, 'squash')
    await update(w)
    let asked = forYou(w).items.filter((i) => i.card === c2)
    expect(asked).toMatchObject([{ kind: 'approve' }])
    expect(asked[0].text).toMatch(/^card still has .+'s work, squashed into main: approve and Hive brings the branch up to date once/)
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

  it('with workflow rules off, Hive never moves the branch nor asks, and nothing waits for it', async () => {
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

  it('the builder busy, a run going, the switch turned off, the rules turned off or the workspace closed meanwhile: nothing moves', async () => {
    const service = await import('../src/main/workflow/service')
    const cases: [string, (env: Awaited<ReturnType<typeof squashed>>) => Promise<void> | void][] = [
      ['busy', () => lines.setAgentBusy(() => true)],
      ['a run', () => service.setRunsGoing(() => ['unit tests'])],
      ['switch off', () => advanced.set(lines.UPDATE_AGENT_BRANCH, false)],
      ['rules off', () => advanced.set(ENFORCE, false)],
      ['closed', async (env) => {
        opened.splice(opened.indexOf(env.w), 1)
        await disposeWorkspaceService(env.w)
      }]
    ]
    for (const [what, during] of cases) {
      const env = await squashed()
      whileChecking(() => during(env))
      await update(env.w).catch(() => undefined)
      expect([what, git(env.wt, 'rev-parse', 'HEAD')]).toEqual([what, env.head])
      if (what !== 'closed') expect([what, lineMoved(env.w, env.cards[0]).length]).toEqual([what, 0])
      vi.restoreAllMocks()
      lines.setAgentBusy(null)
      service.setRunsGoing(null)
      await advanced.set(lines.UPDATE_AGENT_BRANCH, true)
      await advanced.set(ENFORCE, true)
    }
  })

  it("the platform's move is conditional on the head checked: a branch that moved on since isn't reset", async () => {
    const { repo, wt, head } = await squashed()
    const G = await import('../src/main/platform/git')
    commit(wt, 'after.txt')
    expect(await G.resetKeep(wt, git(repo, 'rev-parse', 'main'), { line: 'card', head })).toBeNull()
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('after.txt')
    expect(await G.resetKeep(wt, git(repo, 'rev-parse', 'main'), { line: 'other', head: git(wt, 'rev-parse', 'HEAD') })).toBeNull()
  })
})

// HR2's round 1 finding 2: what waits is each workspace's own.
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
    // Hive's merge commits in the repository as its own identity says (unit tests have no global git config).
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.com')
    commit(wt, 'work.txt')
    const { mergeWorktree } = await import('../src/main/worktrees')
    const r = await mergeWorktree(repo, { path: wt, branch: 'card', base: 'main' }, { squash: true, message: 'squash card', moveBranch: true })
    expect(r).toMatchObject({ ok: true, branchMoved: true })
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
  })
})
