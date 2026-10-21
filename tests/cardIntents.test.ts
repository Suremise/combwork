// Intents (#1267, SPEC §16.8.1): agents act by intent on the board's one intent path (#1265). A card's whole round trip
// by its builder and reviewer (start, submit, start review, a failed verdict, a resubmission, a pass, report merge), each
// writing its facts once and the card's 0.9 fields with them; refusals as the runtime's (§16.8.3), an agent's plain
// number refused naming both forms (S48); ask the user and couldn't within the rules as For you requests, never a round
// (S22); the reviewer's request; a no-code card's submission (S25, S38); a comment never moves an Approved card (S2);
// the same revision again needs a note, and is a new round with one (S32's explanation part); with the rules off,
// nothing guards an intent.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-intents-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE } = await import('../src/main/workflow/service')
const { runCardIntent } = await import('../src/main/cardIntents')
const { allOff } = await import('../src/shared/workflow/options')
const { foldCard } = await import('../src/shared/workflow/facts')
const { INTENT_ROUTES } = await import('../src/main/servers')
const { intentText } = await import('../src/shared/toolReplies')
const { AGENT_ONLY_TOOLS, ASSISTANT_ONLY_TOOLS, HIVE_TOOLS, INTENT_TOOLS, assistantTools } = await import('../src/shared/assistantTools')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
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
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** "Pair (the agent merges)": a reviewer agent, the agent merges, agents' worktrees. */
const PAIR = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' } as const

async function workspace(options: object = PAIR): Promise<{ w: WS; repo: string; wt: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, wt }
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const kinds = (w: WS, card: number): string[] => facts(w, card).map((f) => f.kind)
const create = (w: WS, title = 'Work') => inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p' }, user)).number)
type Intent = Parameters<typeof runCardIntent>[2]
const act = (w: WS, card: number, actor: Parameters<typeof runCardIntent>[1], intent: Intent) => inWorkspace(w, () => runCardIntent({ n: card, plain: false }, actor, intent))
/** The refusal an intent gets (its rule), or null when it went through. */
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
const commit = (wt: string, file: string): string => {
  writeFileSync(join(wt, file), `${file}\n`)
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', file)
  return git(wt, 'rev-parse', 'HEAD')
}

describe('a card by intent (#1267)', () => {
  it("a whole round trip by its builder and reviewer: each intent's facts once, the board's card following", async () => {
    const { w, repo, wt } = await workspace()
    const card = await create(w)
    // Start: the builder's own card, in its worktree.
    const started = await act(w, card, builder, { kind: 'start' })
    expect(started.done).toMatchObject({ ok: true, from: 'todo', to: 'active', data: { folder: wt, line: 'card', target: 'main' } })
    expect(started.card).toMatchObject({ column: 'doing', agent: 'a1' })
    commit(wt, 'b.txt')
    // Submit: Review, its summary a comment.
    const submitted = await act(w, card, builder, { kind: 'submit', summary: 'Round 1 ready' })
    expect(submitted.done).toMatchObject({ from: 'active', to: 'review' })
    expect(submitted.card.column).toBe('review')
    expect(submitted.card.comments.at(-1)?.text).toBe('Round 1 ready')
    // The builder can't review its own work.
    expect(await refused(act(w, card, builder, { kind: 'startReview' }))).toBe('review.notAuthor')
    // The reviewer starts, and fails it (content): back to the builder, the round counted.
    const review = await act(w, card, reviewer, { kind: 'startReview' })
    expect(review.card.review?.agent).toBe('a2')
    const failed = await act(w, card, reviewer, { kind: 'verdict', pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. Add a test.' })
    expect(failed.done).toMatchObject({ from: 'review', to: 'active' })
    expect(failed.card.column).toBe('doing')
    expect(failed.card.history.some((h) => h.what === 'Review failed')).toBe(true)
    expect(foldCard(facts(w, card)).rounds).toBe(1)
    // The same revision again: refused without a note (S32), a new round with one.
    expect(await refused(act(w, card, builder, { kind: 'submit', summary: 'Again' }))).toBe('submit.sameRevisionNote')
    const again = await act(w, card, builder, { kind: 'submit', summary: 'Round 2: explained', note: 'The test was there: see b.txt' })
    expect(again.done.to).toBe('review')
    expect(facts(w, card).filter((f) => f.kind === 'Submitted').map((f) => (f.data as { sameRevision: boolean }).sameRevision)).toEqual([false, true])
    // Passed: Approved (the board's Passed).
    await act(w, card, reviewer, { kind: 'startReview' })
    const passed = await act(w, card, reviewer, { kind: 'verdict', pass: true, comment: 'Round 2: PASSED.' })
    expect(passed.done).toMatchObject({ from: 'review', to: 'approved' })
    expect(passed.card.column).toBe('passed')
    // A comment never moves an Approved card (S2).
    await inWorkspace(w, () => tasks.commentTask(card, 'A thought after the pass', builder))
    expect(foldCard(facts(w, card)).stage).toBe('approved')
    // The builder merges it and reports the merge: Done, its merge checked.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge card', 'card')
    const merged = await act(w, card, builder, { kind: 'reportMerge' })
    expect(merged.done).toMatchObject({ from: 'approved', to: 'done' })
    expect(merged.card.column).toBe('done')
    const k = kinds(w, card)
    for (const once of ['Started', 'Integrated']) expect(k.filter((x) => x === once)).toHaveLength(1)
    expect(k.filter((x) => x === 'Verdict')).toHaveLength(2)
    expect(k.filter((x) => x === 'Submitted')).toHaveLength(2)
  })

  it("an agent's plain number is refused, naming the key and #N forms (S48); #N and the key aren't", async () => {
    const { w } = await workspace()
    const card = await create(w)
    let r: { rule: string; message: string } | null = null
    try {
      await inWorkspace(w, () => runCardIntent({ n: card, plain: true }, builder, { kind: 'start' }))
    } catch (e) {
      r = (e as { refusal: { rule: string; message: string } }).refusal
    }
    expect(r?.rule).toBe('card.plainNumber')
    // Its own forms: its key and #N.
    const key = (await inWorkspace(w, () => tasks.getTask(card, w))).key
    expect((r as unknown as { next: string }).next).toBe(`Name the card as ${key ?? `#${card}`} or #${card}.`)
    expect((await act(w, card, builder, { kind: 'start' })).card.column).toBe('doing')
  })

  it("ask the user and couldn't within the rules are For you requests: nothing moves, no round (S22)", async () => {
    const { w } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    const asked = await act(w, card, builder, { kind: 'ask', askKind: 'decide', text: 'Which greeting?' })
    expect(asked.done).toMatchObject({ from: 'active', to: 'active' })
    const cannot = await act(w, card, builder, { kind: 'cannot', rule: 'submit.checksPassed', why: 'The check needs a device I have no access to.' })
    expect(cannot.done.to).toBe('active')
    const s = foldCard(facts(w, card))
    expect(s.rounds).toBe(0)
    expect(s.stage).toBe('active')
    expect(kinds(w, card)).toEqual(expect.arrayContaining(['ApprovalRequested', 'CannotWithinRules']))
    expect(facts(w, card).filter((f) => f.kind === 'ApprovalRequested').map((f) => (f.data as { kind: string }).kind)).toEqual(['decide', 'decide'])
  })

  it("the reviewer's request to the builder: a fact, the request a comment, the builder's wake written", async () => {
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'c.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    await act(w, card, reviewer, { kind: 'startReview' })
    const req = await act(w, card, reviewer, { kind: 'request', text: 'Which branch did you test on?' })
    expect(req.card.comments.at(-1)).toMatchObject({ text: 'Which branch did you test on?' })
    expect(kinds(w, card)).toContain('ReviewerRequest')
    const wakes = store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'wake'").all(card) as { payload: string }[]).map((r) => JSON.parse(r.payload) as { agent: string })
    expect(wakes.some((p) => p.agent === 'a1')).toBe(true)
  })

  it('a no-code card is submitted with a summary and no revision (S25, S38)', async () => {
    const { w } = await workspace()
    const card = await create(w, 'A design note')
    FactStore.forBoard(w, { project: 'p', key: 'p' })
    await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'p', key: 'p' }).updateCard(card, { kind: 'no-code' }))
    await act(w, card, builder, { kind: 'start' })
    const done = await act(w, card, builder, { kind: 'submit', summary: 'The note is in the card.' })
    expect(done.done.to).toBe('review')
    expect(facts(w, card).find((f) => f.kind === 'Submitted')).toMatchObject({ data: { revision: null, summary: 'The note is in the card.' } })
  })

  it('with workflow rules off, nothing guards an intent (the builder reviews its own card); a plain number is still refused', async () => {
    await advanced.set(ENFORCE, false)
    const { w, wt } = await workspace()
    const card = await create(w)
    await act(w, card, builder, { kind: 'start' })
    commit(wt, 'd.txt')
    await act(w, card, builder, { kind: 'submit', summary: 'Ready' })
    expect(await refused(act(w, card, builder, { kind: 'startReview' }))).toBeNull()
    let rule: string | null = null
    try {
      await inWorkspace(w, () => runCardIntent({ n: card, plain: true }, builder, { kind: 'putBack' }))
    } catch (e) {
      rule = (e as { refusal: { rule: string } }).refusal.rule
    }
    expect(rule).toBe('card.plainNumber')
  })
})

describe("the intents' routes and tools (#1267)", () => {
  /** The status a route's arguments are refused with, or the intent they make. */
  const parse = (route: string, body: unknown): unknown => {
    try {
      return INTENT_ROUTES[route](body)
    } catch (e) {
      return (e as { status?: number }).status
    }
  }

  it("each route takes its intent's arguments and refuses missing or wrong ones (400)", () => {
    expect(Object.keys(INTENT_ROUTES).sort()).toEqual(['ask', 'cannot', 'declare-paths', 'put-back', 'report-merge', 'request', 'start-review', 'submit', 'verdict'])
    expect(parse('put-back', undefined)).toEqual({ kind: 'putBack' })
    expect(parse('submit', { summary: ' Done ', paths: ['a.ts'] })).toEqual({ kind: 'submit', summary: 'Done', revision: undefined, note: undefined, paths: ['a.ts'] })
    expect(parse('submit', {})).toBe(400)
    expect(parse('submit', { summary: 'x', paths: [''] })).toBe(400)
    expect(parse('declare-paths', {})).toBe(400)
    expect(parse('declare-paths', { paths: ['src/a.ts'] })).toEqual({ kind: 'declarePaths', paths: ['src/a.ts'] })
    expect(parse('start-review', { submission: 2 })).toEqual({ kind: 'startReview', submission: 2 })
    expect(parse('start-review', { submission: 0 })).toBe(400)
    expect(parse('verdict', { comment: 'ok' })).toBe(400)
    expect(parse('verdict', { pass: false, comment: 'No', failKind: 'style' })).toBe(400)
    expect(parse('verdict', { pass: false, comment: 'No', failKind: 'explanation' })).toEqual({ kind: 'verdict', pass: false, comment: 'No', submission: undefined, failKind: 'explanation' })
    expect(parse('ask', { text: 'Which name?' })).toEqual({ kind: 'ask', askKind: 'other', text: 'Which name?' })
    expect(parse('ask', { kind: 'sign-in', text: 'x' })).toBe(400)
    expect(parse('cannot', { rule: 'review.notAuthor' })).toBe(400)
    expect(parse('request', { text: 7 })).toBe(400)
  })

  it('a reply says where the card went and what the intent says of it, lists held to a few', () => {
    expect(intentText({ ok: true, card: 'HI-12', from: 'todo', to: 'active', data: { folder: 'D:/p-card', line: 'card', base: 'abc', target: 'main' } })).toBe('HI-12: todo → active. folder: D:/p-card; line: card; base: abc; target: main')
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    expect(intentText({ ok: true, card: '#3', from: 'review', to: 'review', data: { revision: 'r1', files } })).toBe(`#3: still review. revision: r1; files: ${files.slice(0, 20).join(', ')} and 5 more`)
    expect(intentText({ ok: true, card: '#3', from: '', to: '', warnings: ["b.ts is another agent's"] })).toBe("#3: done.\nWarning: b.ts is another agent's")
  })

  it('every agent has the intent tools, Codex too (#913: enabled_tools is HIVE_TOOLS); the Assistant at Control agents, never start_card', () => {
    for (const t of [...INTENT_TOOLS, 'hive_start_card']) {
      expect(HIVE_TOOLS).toContain(t)
      expect(ASSISTANT_ONLY_TOOLS).not.toContain(t)
    }
    expect(AGENT_ONLY_TOOLS).toContain('hive_start_card')
    expect(assistantTools('look')).not.toContain('hive_verdict')
    expect(assistantTools('agents')).toEqual(expect.arrayContaining(INTENT_TOOLS))
    expect(assistantTools('projects')).not.toContain('hive_start_card')
  })
})
