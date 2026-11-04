// Agents' old moves for one transition (#1268, SPEC §16.17, §16.8.1): a project agent's cw_update_task column move and
// review are translated into the intent they stand for, through the same guards: Doing → start, Review → submit, Passed →
// a passing verdict, Done → report merge, Todo → put back; review start → start review, passed/failed → a verdict on the
// latest submission. The reply names the intent's tool for next time; a refusal is the runtime's (the 409 contract).
// With the rules off, agents' moves keep P3's path. S1, S6, S15, S16, S17, S26, S29 and S40 through the board.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09, writeCard } from './boardDb'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('hive-agentmoves-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const service = await import('../src/main/workflow/service')
const { ENFORCE } = service
const { adoptNow } = await import('../src/main/workflow/adoption')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
type Actor = Parameters<typeof tasks.updateTask>[2]
type Patch = Parameters<typeof tasks.updateTask>[1]
const opened: WS[] = []
afterEach(() => advanced.set(ENFORCE, true))
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const reviewer = { kind: 'agent', name: 'Reviewer (p)', self: { project: 'p', agentId: 'a2' }, scope: 'p' } as const
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges, agents' worktrees. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

/** A workspace with a Git project `p`: a builder (its own worktree, unless `shared`) and a reviewer, under `options`. */
async function workspace(options: object = PAIR, o: { shared?: boolean } = {}): Promise<{ w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = gitRepo(join(ws, 'p'))
  const wt = o.shared ? repo : join(ws, 'p-card')
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  commit(repo, {}, 'ignore .hive')
  if (!o.shared) sh(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', ...(o.shared ? {} : { worktree: { path: wt, branch: 'card', base: 'main' } }) }, { id: 'a2', name: 'Reviewer' }]
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  return { w: await open(ws), repo, wt }
}

const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const kinds = (w: WS, card: number): string[] => facts(w, card).map((f) => f.kind)
const stage = (w: WS, card: number) => foldCard(facts(w, card)).stage
const create = (w: WS, title = 'Work') => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)

/** An agent's cw_update_task: the card and its reply's lines, as the tools get them. */
async function update(w: WS, card: number, actor: Actor, patch: Patch, comment?: string): Promise<{ card: Awaited<ReturnType<typeof tasks.updateTask>>; said: string[] }> {
  const said: string[] = []
  const c = await inWorkspace(w, () => tasks.updateTask(card, patch, actor, { said, ...(comment !== undefined ? { comment } : {}) }))
  return { card: c, said }
}

/** The rule a change is refused by (the runtime's refusal), or null when it went through. */
async function refused(p: Promise<unknown>): Promise<{ rule: string; message: string; next: string } | null> {
  try {
    await p
    return null
  } catch (e) {
    const r = (e as { refusal?: { rule: string; message: string; next: string } }).refusal
    if (!r) throw e
    return r
  }
}

/** A card started by the builder's old move (Doing), with a commit in its folder. */
async function started(w: WS, wt: string, file = 'b.txt'): Promise<number> {
  const card = await create(w)
  await update(w, card, builder, { column: 'doing' })
  commit(wt, { [file]: `${file}\n` }, file)
  return card
}

describe("an agent's old moves as intents (#1268)", () => {
  it("a whole round trip by today's moves: each the intent it stands for, its facts once, the reply naming the tool", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    // Doing: start, the card given to the builder.
    const start = await update(w, card, builder, { column: 'doing' })
    expect(start.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(start.said).toContain('As start: next time call cw_start_card')
    expect(foldCard(facts(w, card)).started).toMatchObject({ builder: 'a1', folder: wt })
    commit(wt, { 'b.txt': 'b\n' }, 'b')
    // Review with a comment: submit, the comment its summary.
    const submit = await update(w, card, builder, { column: 'review' }, 'Round 1 ready')
    expect(submit.card.column).toBe('review')
    expect(submit.card.comments.at(-1)?.text).toBe('Round 1 ready')
    expect(submit.said).toContain('As submit: next time call cw_submit')
    expect(facts(w, card).find((f) => f.kind === 'Submitted')?.data).toMatchObject({ summary: 'Round 1 ready' })
    // review start: start review, the card marked as the reviewer's; failed: a verdict, the card back in Doing.
    const review = await update(w, card, reviewer, { review: 'start' })
    expect(review.card.review?.agent).toBe('a2')
    expect(review.said).toContain('As start review: next time call cw_start_review')
    const failed = await update(w, card, reviewer, { review: 'failed' }, 'Round 1: FAILED. 1. Add a test.')
    expect(failed.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(failed.card.comments.at(-1)?.text).toBe('Round 1: FAILED. 1. Add a test.')
    expect(failed.said).toContain('As verdict: next time call cw_verdict')
    expect(foldCard(facts(w, card)).rounds).toBe(1)
    // The builder's move to Doing moves nothing now (it is there): its comment is just a comment.
    expect((await update(w, card, builder, { column: 'doing' }, 'On it')).said).not.toContain('As start: next time call cw_start_card')
    commit(wt, { 'c.txt': 'c\n' }, 'c')
    await update(w, card, builder, { column: 'review' }, 'Round 2 ready')
    // review passed with column passed (the loop's verdict): its review started first, then the verdict; Approved.
    const passed = await update(w, card, reviewer, { review: 'passed', column: 'passed' }, 'Round 2: PASSED.')
    expect(passed.card).toMatchObject({ column: 'passed', agent: 'a1' })
    expect(passed.card.history.some((h) => h.what === 'Review passed')).toBe(true)
    expect(stage(w, card)).toBe('approved')
    // Done: report merge, its merge checked.
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    const done = await update(w, card, builder, { column: 'done' }, 'Merged.')
    expect(done.card.column).toBe('done')
    expect(done.said).toContain('As report merge: next time call cw_report_merge')
    const k = kinds(w, card)
    for (const once of ['Started', 'Integrated']) expect(k.filter((x) => x === once)).toHaveLength(1)
    expect(k.filter((x) => x === 'Submitted')).toHaveLength(2)
    expect(k.filter((x) => x === 'Verdict')).toHaveLength(2)
    expect(k.filter((x) => x === 'ReviewStarted')).toHaveLength(2)
    // More work the user asked for: a Done card back into Doing is reopened and started, a new cycle (its start's).
    const again = await update(w, card, builder, { column: 'doing' }, 'More work')
    expect(again.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(again.said).toContain('As start: next time call cw_start_card')
    expect(kinds(w, card).filter((x) => x === 'Started')).toHaveLength(2)
    expect(facts(w, card).filter((f) => f.kind === 'Moved').slice(-2).map((f) => (f.data as { to: string }).to)).toEqual(['todo', 'active'])
    expect(stage(w, card)).toBe('active')
  })

  // HR2's round 1 finding 1: a new cycle is always a start, through Start's guards; back into Doing for fixes isn't one.
  it("a new cycle by an old move goes through Start's guards: a Done card reopened, one given to another agent, one On Hold, one made in Doing", async () => {
    // Pair as the preset has it: a blocked card doesn't start (start.notBlocked).
    const { w, repo, wt } = await workspace({ ...PAIR, dependenciesDone: true })
    const block = (card: number, why: string | null) => update(w, card, user, { blocked: why ?? '' })
    // A Done card, blocked: its builder's move back to Doing is refused by start.notBlocked; unblocked, it starts again.
    const done = await started(w, wt)
    await update(w, done, builder, { column: 'review' }, 'Ready')
    await update(w, done, reviewer, { review: 'passed', column: 'passed' }, 'PASSED')
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    await update(w, done, builder, { column: 'done' })
    await block(done, 'waiting for the design')
    expect((await refused(update(w, done, builder, { column: 'doing' })))?.rule).toBe('start.notBlocked')
    expect(stage(w, done)).toBe('done')
    expect(kinds(w, done).filter((x) => x === 'Started')).toHaveLength(1)
    await block(done, null)
    expect((await update(w, done, builder, { column: 'doing' })).card.column).toBe('doing')
    expect(kinds(w, done).filter((x) => x === 'Started')).toHaveLength(2)
    // A Todo card given to another agent in the same move: started for that agent, under the same guards.
    const given = await create(w, 'Given')
    await block(given, 'not yet')
    expect((await refused(update(w, given, builder, { column: 'doing', agent: 'a2' })))?.rule).toBe('start.notBlocked')
    expect(kinds(w, given)).not.toContain('Started')
    await block(given, null)
    const g = await update(w, given, builder, { column: 'doing', agent: 'a2' })
    expect(g.card).toMatchObject({ column: 'doing', agent: 'a2' })
    expect(foldCard(facts(w, given)).started).toMatchObject({ builder: 'a2' })
    // A card On Hold that never started: the move to Doing is its start.
    const held = await create(w, 'Held')
    await update(w, held, user, { column: 'hold', blocked: 'parked' })
    expect((await refused(update(w, held, builder, { column: 'doing' })))?.rule).toBe('start.notBlocked')
    expect(stage(w, held)).toBe('hold')
    await block(held, null)
    expect((await update(w, held, builder, { column: 'doing' })).said).toContain('As start: next time call cw_start_card')
    expect(foldCard(facts(w, held)).started).toMatchObject({ builder: 'a1' })
    // Made in Doing for another agent: started for it.
    const made = await inWorkspace(w, () => tasks.createTask({ title: 'For the reviewer', column: 'doing', agent: 'Reviewer' }, builder))
    expect(made).toMatchObject({ column: 'doing', agent: 'a2' })
    expect(foldCard(facts(w, made.number)).started).toMatchObject({ builder: 'a2' })
  })

  // HR2's round 1 finding 2: a translated verdict is one write; refused or failing anywhere, nothing of the change stays.
  it('a verdict that starts its review is all or nothing: a bad comment or a failing placement leaves the card as it was', async () => {
    const { w, wt } = await workspace()
    const card = await started(w, wt)
    await update(w, card, builder, { column: 'review' }, 'Ready')
    const before = await inWorkspace(w, () => tasks.getTask(card, w))
    const unchanged = async () => {
      const c = await inWorkspace(w, () => tasks.getTask(card, w))
      expect([c.title, c.column, c.review ?? null, c.comments.length]).toEqual([before.title, 'review', null, before.comments.length])
      expect(kinds(w, card).filter((k) => k === 'ReviewStarted' || k === 'Verdict')).toEqual([])
      expect(stage(w, card)).toBe('review')
    }
    // An empty comment: refused before anything is gathered or written.
    await expect(update(w, card, reviewer, { review: 'passed', column: 'passed', title: 'Should roll back' }, '')).rejects.toThrow(/comment is empty/)
    await unchanged()
    // A placement that fails in the verdict's own write (no such card to go before): the write is undone whole.
    await expect(update(w, card, reviewer, { review: 'passed', column: 'passed', title: 'Should roll back', before: 9999 }, 'PASSED')).rejects.toThrow()
    await unchanged()
    // Then as it should be: one write, the review started and passed together.
    const ok = await update(w, card, reviewer, { review: 'passed', column: 'passed', title: 'Renamed' }, 'PASSED')
    expect(ok.card).toMatchObject({ title: 'Renamed', column: 'passed' })
    const k = kinds(w, card)
    expect(k.slice(k.indexOf('ReviewStarted'))).toEqual(['ReviewStarted', 'Verdict', 'Moved'])
  })

  it('S1: uncommitted changes refuse the move to Review with the next step; the card stays in Doing', async () => {
    const { w, wt } = await workspace()
    const card = await started(w, wt)
    writeFileSync(join(wt, 'more.txt'), 'uncommitted\n')
    const r = await refused(update(w, card, builder, { column: 'review' }, 'Ready'))
    expect(r?.rule).toBe('submit.clean')
    expect(r?.next).toBe("Commit the card's changes, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. Changes that aren't the card's: ask before removing them.")
    const c = await inWorkspace(w, () => tasks.getTask(card, w))
    expect(c.column).toBe('doing')
    // Nothing of the change was saved, its comment neither.
    expect(c.comments).toEqual([])
    expect(stage(w, card)).toBe('active')
  })

  it("S6: the builder can't review its own card", async () => {
    const { w, wt } = await workspace()
    const card = await started(w, wt)
    await update(w, card, builder, { column: 'review' }, 'Ready')
    expect((await refused(update(w, card, builder, { review: 'start' })))?.rule).toBe('review.notAuthor')
    expect((await refused(update(w, card, builder, { review: 'passed', column: 'passed' })))?.rule).toBe('review.notAuthor')
  })

  it('S15: a commit authored with a personal email refuses the move to Review with the amend command', async () => {
    const { w, wt } = await workspace({ ...PAIR, identity: { name: 'Hive Test', email: 'test@hive.invalid' } })
    const card = await create(w)
    await update(w, card, builder, { column: 'doing' })
    commit(wt, { 'x.txt': 'x\n' }, 'personal', { email: 'me@example.com' })
    const r = await refused(update(w, card, builder, { column: 'review' }, 'x'))
    expect(r?.rule).toBe('submit.identity')
    expect(r?.next).toContain('git commit --amend --no-edit --reset-author')
  })

  it("S16, S17: an agent's Done is report merge: refused before it passed, and while its merge isn't in the target", async () => {
    const { w, wt } = await workspace()
    const card = await started(w, wt)
    expect((await refused(update(w, card, builder, { column: 'done' })))?.rule).toBe('move.notFromHere')
    await update(w, card, builder, { column: 'review' }, 'Ready')
    await update(w, card, reviewer, { review: 'passed', column: 'passed' }, 'PASSED')
    // Not merged: done.contained refuses it.
    expect((await refused(update(w, card, builder, { column: 'done' })))?.rule).toBe('done.contained')
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('passed')
  })

  it('S26: a check that has not passed refuses the move to Review', async () => {
    const { w, wt } = await workspace({ ...PAIR, preChecks: ['lint'], commands: { lint: 'npm run lint' } })
    const card = await started(w, wt)
    const r = await refused(update(w, card, builder, { column: 'review' }, 'Ready'))
    expect(r?.rule).toBe('submit.checksPassed')
    expect(r?.message).toMatch(/^Review refused: lint hasn't passed on [0-9a-f]{7}\.$/)
  })

  it("S29: in the project folder, a commit with no trailer refuses the move to Review, naming the amend", async () => {
    const { w, repo } = await workspace({ ...PAIR, finish: 'committed', folder: 'project' }, { shared: true })
    const card = await create(w)
    const other = await create(w, 'Other')
    // Two cards going in the folder: a commit with no trailer is neither's.
    await update(w, card, builder, { column: 'doing' })
    await update(w, other, builder, { column: 'doing' })
    // The card's trailer, as the runtime names it.
    const key = (await service.workflowFor(w, repo))!.store.card(card).key
    commit(repo, { 'y.txt': 'y\n' }, 'with trailer', { trailer: key })
    commit(repo, { 'x.txt': 'x\n' }, 'no trailer')
    const r = await refused(update(w, card, builder, { column: 'review' }, 'x'))
    expect(r?.rule).toBe('submit.trailer')
    expect(r?.next).toContain(`git commit --amend --no-edit --trailer "Hive-Card: ${key}"`)
    expect(stage(w, card)).toBe('active')
  })

  it("another agent's card in progress names its stages as the project renamed them (HR5's HI-1585 round 1)", async () => {
    const { w, wt } = await workspace({ ...PAIR, stageNames: { active: 'Building', review: 'Checking', approved: 'Accepted', done: 'Finished' } })
    const card = await started(w, wt)
    await expect(update(w, card, reviewer, { column: 'review' })).rejects.toThrow(/in Building with agent Builder.*move it to Checking\. Leave it where it is; agent Builder moves it to Checking when done/)
    await expect(update(w, card, reviewer, { column: 'done' })).rejects.toThrow(/in Building with agent Builder.*move it to Finished\./)
    // The board's column stays the API's id.
    expect((await inWorkspace(w, () => tasks.getTask(card))).column).toBe('doing')
  })

  it("Todo is put back, its comment the why; a reviewer can't take a card in Doing on to Review", async () => {
    const { w, wt } = await workspace()
    const card = await started(w, wt)
    // As before 1.0: another agent's card in Doing is its work in progress.
    // The board's stage names, by default (HI-1585).
    await expect(update(w, card, reviewer, { column: 'review' }, 'Mine now')).rejects.toThrow(/in Active with agent Builder.*move it to Review\./)
    const back = await update(w, card, builder, { column: 'todo' }, 'Waiting for #9 first.')
    expect(back.card.column).toBe('todo')
    expect(back.said).toContain('As put back: next time call cw_put_back')
    expect(facts(w, card).findLast((f) => f.kind === 'Moved')?.data).toMatchObject({ to: 'todo', cause: 'intent', why: 'Waiting for #9 first.' })
  })

  it("a batch translates each card's move, a refused card left as it was; a card made in Doing is started", async () => {
    const { w, wt } = await workspace()
    const one = await started(w, wt, 'one.txt')
    const two = await create(w)
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n')
    // Into Doing together: two starts (the first is there already); then to Review, refused by the uncommitted file.
    const items = await inWorkspace(w, () => tasks.updateTasks([one, two], { column: 'doing' }, builder))
    expect(items.map((i) => [i.number, i.card?.column, i.error])).toEqual([
      [one, 'doing', null],
      [two, 'doing', null]
    ])
    expect(kinds(w, two)).toContain('Started')
    const review = await inWorkspace(w, () => tasks.updateTasks([one], { column: 'review' }, builder))
    expect(review[0].card).toBeNull()
    expect(review[0].error).toMatch(/uncommitted/)
    expect(stage(w, one)).toBe('active')
    // Made in Doing by the builder: started, the card its own.
    const made = await inWorkspace(w, () => tasks.createTask({ title: 'Made in Doing', column: 'doing' }, builder))
    expect(made).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(kinds(w, made.number)).toContain('Started')
    expect(foldCard(facts(w, made.number)).started).toMatchObject({ builder: 'a1' })
    // Made in Passed: refused whole (nothing to pass), no card made.
    const before = (await inWorkspace(w, () => tasks.listTasks())).length
    expect((await refused(inWorkspace(w, () => tasks.createTask({ title: 'Made in Passed', column: 'passed' }, builder))))?.rule).toBe('move.notFromHere')
    expect((await inWorkspace(w, () => tasks.listTasks())).length).toBe(before)
  })

  it("a column its rules don't have keeps P3's move, as the user's: Review with no review, its review, and a card On Hold", async () => {
    const { w, wt } = await workspace({ ...allOff('git') })
    const card = await started(w, wt)
    const review = await update(w, card, builder, { column: 'review' }, 'Ready')
    expect(review.card.column).toBe('review')
    expect(review.said.some((l) => l.startsWith('As '))).toBe(false)
    expect((await update(w, card, reviewer, { review: 'start' })).card.review?.agent).toBe('a2')
    expect((await update(w, card, reviewer, { review: 'passed', column: 'passed' }, 'PASSED')).card.column).toBe('passed')
    // Made by an agent in a column its rules lack: made there, as a move there is (HR2's round 2); in Doing, started.
    for (const column of ['review', 'passed'] as const) {
      const made = await inWorkspace(w, () => tasks.createTask({ title: `Made in ${column}`, column }, builder))
      expect(made.column).toBe(column)
      expect((await inWorkspace(w, () => tasks.getTask(made.number, w))).column).toBe(column)
    }
    const doing = await inWorkspace(w, () => tasks.createTask({ title: 'Made in Doing', column: 'doing' }, builder))
    expect(doing.column).toBe('doing')
    expect(kinds(w, doing.number)).toContain('Started')
    // On Hold is the user's; an agent the user asked takes the card out. Held while being worked on, it goes back to it by
    // P3's move; never started, its move to Doing is its start.
    const working = await started(w, wt, 'w.txt')
    await update(w, working, user, { column: 'hold' })
    const back = await update(w, working, builder, { column: 'doing' })
    expect(back.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(back.said.some((l) => l.startsWith('As '))).toBe(false)
    expect(kinds(w, working).filter((k) => k === 'Started')).toHaveLength(1)
    const held = await create(w, 'Parked')
    await update(w, held, user, { column: 'hold' })
    const out = await update(w, held, builder, { column: 'doing' })
    expect(out.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(out.said).toContain('As start: next time call cw_start_card')
  })

  it("with workflow rules off, an agent's moves take P3's path: nothing translated, a failed review back to Doing as the verdict intent sends it (HI-1946)", async () => {
    await advanced.set(ENFORCE, false)
    const { w, wt } = await workspace()
    const card = await create(w)
    const start = await update(w, card, builder, { column: 'doing' })
    expect(start.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(start.said.some((l) => l.startsWith('As '))).toBe(false)
    // A card made in Review is made there, nothing submitted by the rules.
    const made = await inWorkspace(w, () => tasks.createTask({ title: 'Made in Review', column: 'review' }, builder))
    expect(made.column).toBe('review')
    // P3 records its facts still.
    expect(kinds(w, card)).toContain('Started')
    writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n')
    // No guard: uncommitted changes don't refuse it.
    const submit = await update(w, card, builder, { column: 'review' }, 'Ready')
    expect(submit.card.column).toBe('review')
    await update(w, card, reviewer, { review: 'start' })
    const failed = await update(w, card, reviewer, { review: 'failed' }, 'FAILED')
    // P3 too: a failed card goes back to Doing, its builder's, as the verdict intent sends it (HI-1946).
    expect(failed.card).toMatchObject({ column: 'doing', agent: 'a1' })
    expect(failed.said.some((l) => l.startsWith('As '))).toBe(false)
    expect(kinds(w, card).slice(-2)).toEqual(['Verdict', 'Moved'])
    expect(facts(w, card).at(-1)?.data).toMatchObject({ from: 'review', to: 'active' })
  })
})

describe('a failed review by either route: back to Doing, its builder holding it (HI-1946)', () => {
  /** A Git project with no workflow chosen yet (as a project just added is): its rules have no Review stage. */
  async function bare(): Promise<{ w: WS; wt: string }> {
    const ws = join(base, `ws-${++n}`)
    const repo = gitRepo(join(ws, 'p'))
    const wt = join(ws, 'p-card')
    writeFileSync(join(repo, '.gitignore'), '.hive/\n')
    commit(repo, {}, 'ignore .hive')
    sh(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    mkdirSync(join(repo, '.hive'), { recursive: true })
    writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }] }))
    return { w: await open(join(ws)), wt }
  }
  /** A card the builder started, committed and submitted, under the reviewer's review. */
  async function reviewed(w: WS, wt: string, file: string): Promise<number> {
    const card = await started(w, wt, file)
    await update(w, card, builder, { column: 'review' }, 'Ready')
    await update(w, card, reviewer, { review: 'start' })
    return card
  }
  /** What a failed review left: the card's column, agent and review, its open holds, and its facts after the failure. */
  async function after(w: WS, card: number, fail: () => Promise<unknown>) {
    const had = facts(w, card).length
    await fail()
    const c = await inWorkspace(w, () => tasks.getTask(card))
    const holding = (c.held ?? []).filter((h) => !h.to).map((h) => [h.agent, h.role])
    return { column: c.column, agent: c.agent, review: c.review ?? null, open: holding, facts: facts(w, card).slice(had).map((f) => (f.kind === 'Moved' ? `Moved ${(f.data as { from: string; to: string }).from}→${(f.data as { to: string }).to}` : f.kind)) }
  }
  const WANTED = { column: 'doing', agent: 'a1', review: null, open: [['a1', 'build']], facts: ['Verdict', 'Moved review→active'] }
  const viaPatch = (w: WS, card: number) => () => update(w, card, reviewer, { review: 'failed' }, 'FAILED')
  const viaIntent = (w: WS, card: number) => () => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, reviewer, { kind: 'verdict', pass: false, comment: 'FAILED' }))

  // The same in each, a test each (HI-2075: the three in one reached the time limit on a loaded machine).
  for (const [name, make, enforce] of [
    ['whose rules have no Review stage', bare, true],
    ['with the rules off', () => workspace(), false],
    ['with the rules on, and a Review stage', () => workspace(), true]
  ] as const) {
    it(`in a project ${name}: the same, by PATCH and by the verdict intent`, async () => {
      await advanced.set(ENFORCE, enforce)
      const { w, wt } = await make()
      const [a, b] = [await reviewed(w, wt, 'a.txt'), await reviewed(w, wt, 'b.txt')]
      expect(await after(w, a, viaPatch(w, a)), 'PATCH').toEqual(WANTED)
      expect(await after(w, b, viaIntent(w, b)), 'the verdict intent').toEqual(WANTED)
    })
  }

  it('a card from before 1.0 (P3 until it starts): back to Doing, its builder holding it; one Verdict, then the move', async () => {
    const { w } = await bare()
    const card = await create(w)
    await store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare('UPDATE cards SET pre_workflow = 1 WHERE number = ?').run(card)))
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review', agent: 'a1' }, user))
    await update(w, card, reviewer, { review: 'start' })
    // Its first cycle starts as it goes into Doing (the recorder's Started for a card from before 1.0), then as above.
    expect(await after(w, card, viaPatch(w, card))).toEqual({ ...WANTED, facts: ['Started', ...WANTED.facts] })
  })

  it('a failed review moved anywhere but Doing is refused before anything is written, by either path', async () => {
    for (const make of [bare, () => workspace()]) {
      const { w, wt } = await make()
      const card = await reviewed(w, wt, 'c.txt')
      const had = facts(w, card).length
      const was = await inWorkspace(w, () => tasks.getTask(card))
      for (const column of ['review', 'passed', 'done', 'todo'] as const) await expect(update(w, card, reviewer, { review: 'failed', column }, 'FAILED')).rejects.toThrow(/A failed review sends #\d+ back to Doing, to its builder/)
      const now = await inWorkspace(w, () => tasks.getTask(card))
      expect([now.column, now.review?.agent, now.history.length, now.comments.length, now.held?.length, facts(w, card).length]).toEqual([was.column, 'a2', was.history.length, was.comments.length, was.held?.length, had])
    }
  })
})

describe("S40: an upgraded lane's old moves (#1268)", () => {
  const at = new Date(Date.UTC(2026, 9, 1)).toISOString()
  const card09 = (number: number, column: string, agent: string | null): Record<string, unknown> => ({ number, title: `Card ${number}`, description: '', project: 'p', agent, ...(agent ? { agentName: agent === 'b1' ? 'B1' : 'R1' } : {}), column, order: number, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'You', updatedAt: at })

  it('cards in flight at the upgrade, adopted, go on by the old moves: Doing submitted, Review passed, Passed reported merged', async () => {
    const ws = join(base, `ws-${++n}`)
    // A lane in the project folder, as the spike's S40 (the upgrade's options: review by an agent, not checked).
    const p = gitRepo(join(ws, 'p'))
    writeFileSync(join(p, '.gitignore'), '.hive/\n')
    commit(p, { 'src/b.txt': 'b1\n' }, 'B1 builds')
    mkdirSync(join(p, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1 (reviewer)' }] }))
    const w0 = await open(ws)
    for (const c of [card09(1, 'doing', 'b1'), card09(2, 'review', 'b1'), card09(3, 'passed', 'b1')]) await writeCard(w0, c.number as number, c)
    // As 0.9 left it, then upgraded and adopted.
    opened.splice(opened.indexOf(w0), 1)
    await disposeWorkspaceService(w0)
    store.closeBoard(ws)
    as09(store.boardFile(ws))
    const w = await open(ws)
    await inWorkspace(w, () => store.upgradeBoard(w))
    const adopted = await inWorkspace(w, () => adoptNow(w))
    expect(adopted).toMatchObject({ adopted: 3, failed: 0 })
    const b1 = { kind: 'agent', name: 'B1 (p)', self: { project: 'p', agentId: 'b1' }, scope: 'p' } as const
    const r1 = { kind: 'agent', name: 'R1 (p)', self: { project: 'p', agentId: 'r1' }, scope: 'p' } as const
    // The reviewer passes the adopted submission by its old verdict.
    const pass = await update(w, 2, r1, { review: 'passed', column: 'passed' }, 'PASSED')
    expect(pass.card.column).toBe('passed')
    expect(stage(w, 2)).toBe('approved')
    // The builder reports the Passed card merged by its old move to Done (the upgrade's options: not checked).
    const done = await update(w, 3, b1, { column: 'done' }, 'Merged')
    expect(done.card.column).toBe('done')
    expect(stage(w, 3)).toBe('done')
    // And submits the card in Doing by its old move to Review, once it has a change of its own.
    commit(p, { 'src/c.txt': 'c\n' }, 'card 1', { trailer: (await service.workflowFor(w, p))!.store.card(1).key })
    const sub = await update(w, 1, b1, { column: 'review' }, 'Ready')
    expect(sub.card.column).toBe('review')
    expect(kinds(w, 1)).toContain('Submitted')
  })
})
