// HI-2245: a builder's card in Review whose line has commits past its submission: what the runtime proves (its folder as
// checked out there, the committed history only, the shared folder's attribution) and drops (another branch, a dirty
// tree, a swapped checkout, a missing folder, history rewritten, a change during the read), and the replies' text.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { renameSync } from 'fs'
import { B1, B2, commit, moved, put, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { attributeFolder } from '../../src/main/workflow/reconcile'
import { UNSUBMITTED_MAX } from '../../src/main/platform/gitPlatform'
import { taskWaitText } from '../../src/shared/toolReplies'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

let during: (() => void | Promise<void>) | null = null
afterEach(() => {
  during = null
})
const hooks = { unsubmittedRead: () => during?.() }

/** A Pair card in its slot, submitted by B1: in Review, with its folder and submitted revision. */
async function inReview(e: Env) {
  const card = e.wf.createCard({ title: 'Fix the thing' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  const submitted = commit(folder, { 'src/fix.txt': 'fixed\n' }, `${card.key}: fix`)
  moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
  expect(e.wf.state(card).stage).toBe('review')
  return { card, folder, submitted }
}

const pair = () => (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }, { hooks }))
const fact = (e: Env, card: { id: number }, agent = 'B1') => e.wf.unsubmitted(e.store.card(card.id), agent)

/**
 * `n` empty commits on the folder's checked-out line in one git process (fast-import), as a builder's many would be;
 * `trailer(i)`, the card key the i-th (from 1, oldest first) names, if any.
 */
function manyCommits(folder: string, line: string, n: number, trailer?: (i: number) => string | null): void {
  const from = sh(folder, 'rev-parse', 'HEAD')
  let s = ''
  for (let i = 1; i <= n; i++) {
    const key = trailer?.(i)
    const msg = `step ${i}\n${key ? `\nCombwork-Card: ${key}\n` : ''}`
    s += `commit refs/heads/${line}\ncommitter Combwork Test <test@example.invalid> ${1_800_000_000 + i} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}${i === 1 ? `from ${from}\n` : ''}\n`
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: folder, input: s, stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('HI-2245: commits past the submission, in the card folder', () => {
  it('a commit past the submission is said, with its count and the short id; another is counted too', async () => {
    const e = pair()
    const { card, folder, submitted } = await inReview(e)
    expect(await fact(e, card)).toBeNull()
    commit(folder, { 'src/fix.txt': 'fixed again\n' }, `${card.key}: the asked change`)
    expect(await fact(e, card)).toEqual({ count: 1, atLeast: false, since: submitted.slice(0, 7) })
    commit(folder, { 'src/more.txt': 'more\n' }, `${card.key}: more`)
    expect(await fact(e, card)).toEqual({ count: 2, atLeast: false, since: submitted.slice(0, 7) })
  })

  it('nothing for a commit on another branch, a dirty tree only, or a reviewer, and nothing once handed over', async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    // Another branch of the same repository (the project's main checkout).
    commit(e.project, { 'elsewhere.txt': 'x\n' }, 'on main')
    expect(await fact(e, card)).toBeNull()
    // A dirty tree only: changed, new and staged files, never committed.
    put(folder, 'src/fix.txt', 'edited, not committed\n')
    put(folder, 'src/new.txt', 'new\n')
    sh(folder, 'add', 'src/new.txt')
    expect(await fact(e, card)).toBeNull()
    sh(folder, 'reset', '-q', '--hard')
    // Committed: the builder is told; its reviewer, or another agent, never is.
    commit(folder, { 'src/fix.txt': 'fixed again\n' }, `${card.key}: the asked change`)
    expect(await fact(e, card)).not.toBeNull()
    expect(await fact(e, card, 'R1')).toBeNull()
    expect(await fact(e, card, 'B2')).toBeNull()
    // Handed over (followUp): the new submission is the head, so nothing is left to say.
    moved(await e.wf.submit(card.key, B1, { summary: 'the asked change', followUp: true }))
    expect(await fact(e, card)).toBeNull()
  })

  it('nothing for a swapped checkout, a missing folder, or history rewritten (an amend, a reset)', async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    const line = e.wf.state(card).started!.line!
    commit(folder, { 'src/fix.txt': 'fixed again\n' }, `${card.key}: the asked change`)
    expect(await fact(e, card)).not.toBeNull()
    // The slot on another branch, which has the same commits and one more: its line's commits aren't what is there.
    sh(folder, 'checkout', '-q', '-b', 'side')
    commit(folder, { 'side.txt': 's\n' }, 'side')
    expect(await fact(e, card)).toBeNull()
    sh(folder, 'checkout', '-q', line)
    expect(await fact(e, card)).not.toBeNull()
    // Detached at the line's head.
    sh(folder, 'checkout', '-q', '--detach')
    expect(await fact(e, card)).toBeNull()
    sh(folder, 'checkout', '-q', line)
    // The folder gone (moved away), then back.
    renameSync(folder, `${folder}-away`)
    expect(await fact(e, card)).toBeNull()
    renameSync(`${folder}-away`, folder)
    expect(await fact(e, card)).not.toBeNull()
    // An amend of the submitted commit: the head isn't past the submission, so it says nothing (not "moved").
    sh(folder, 'reset', '-q', '--hard', 'HEAD~1')
    expect(await fact(e, card)).toBeNull()
    sh(folder, 'commit', '-q', '--amend', '--allow-empty', '-m', 'amended submission')
    expect(await fact(e, card)).toBeNull()
  })

  it("nothing for another repository in the card's folder: a clone of the project on a line of the same name (HR2's round 1)", async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    const line = e.wf.state(card).started!.line!
    const before = sh(e.project, 'rev-parse', line)
    renameSync(folder, `${folder}-original`)
    execFileSync('git', ['clone', '-q', '--branch', line, e.project, folder], { stdio: 'pipe' })
    sh(folder, 'config', 'user.name', 'Combwork Test')
    sh(folder, 'config', 'user.email', 'test@example.invalid')
    commit(folder, { 'other.txt': 'only in the clone\n' }, 'clone only')
    // The project's line is still the submission: nothing past it in the card's repository.
    expect(sh(e.project, 'rev-parse', line)).toBe(before)
    expect(await fact(e, card)).toBeNull()
  })

  it('nothing for a card not in Review: back in Doing after a failed verdict', async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    moved(await e.wf.startReview(card.key, R1))
    commit(folder, { 'src/fix.txt': 'fixed again\n' }, `${card.key}: more`)
    expect(await fact(e, card)).not.toBeNull()
    moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'not yet' }))
    expect(e.wf.state(card).stage).toBe('active')
    expect(await fact(e, card)).toBeNull()
  })

  it(`past ${UNSUBMITTED_MAX} commits, a lower bound`, async () => {
    const e = pair()
    const { card, folder, submitted } = await inReview(e)
    manyCommits(folder, e.wf.state(card).started!.line!, UNSUBMITTED_MAX + 1)
    expect(await fact(e, card)).toEqual({ count: UNSUBMITTED_MAX, atLeast: true, since: submitted.slice(0, 7) })
  })

  it('dropped when the card or its folder changes during the read: a new submission, a reset, a checkout', async () => {
    const e = pair()
    const { card, folder } = await inReview(e)
    const line = e.wf.state(card).started!.line!
    commit(folder, { 'src/fix.txt': 'fixed again\n' }, `${card.key}: the asked change`)
    // Handed over while the history was read: the card's submission is no longer the one read.
    during = async () => {
      during = null
      moved(await e.wf.submit(card.key, B1, { summary: 'the asked change', followUp: true }))
    }
    expect(await fact(e, card)).toBeNull()
    commit(folder, { 'src/fix.txt': 'and again\n' }, `${card.key}: another`)
    // A reset to the submission during the read: card state unchanged, the folder isn't what was read.
    during = () => {
      during = null
      sh(folder, 'reset', '-q', '--hard', 'HEAD~1')
    }
    expect(await fact(e, card)).toBeNull()
    commit(folder, { 'src/fix.txt': 'and again\n' }, `${card.key}: another`)
    // A checkout of another branch during the read.
    during = () => {
      during = null
      sh(folder, 'checkout', '-q', '-b', 'side2')
    }
    expect(await fact(e, card)).toBeNull()
    sh(folder, 'checkout', '-q', line)
    expect(await fact(e, card)).not.toBeNull()
    // Back in Doing during the read.
    moved(await e.wf.startReview(card.key, R1))
    during = async () => {
      during = null
      moved(await e.wf.verdict(card.key, R1, { pass: false, comment: 'not yet' }))
    }
    expect(await fact(e, card)).toBeNull()
  })
})

describe('HI-2245: in the shared project folder, only the card attributed commits on its line', () => {
  const shared = () => (env = setup({ ...preset('git', 'pair'), finish: 'committed', folder: 'project', slotsUpToDate: false, preChecks: [], mergeChecks: [], target: '' }, { hooks }))

  it("its own commit past the submission is said; another card's isn't; an old attribution on another branch isn't", async () => {
    const e = shared()
    const a = e.wf.createCard({ title: 'A' })
    const b = e.wf.createCard({ title: 'B' })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const a1 = commit(e.project, { 'a1.txt': 'a\n' }, 'a1', { trailer: a.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    expect(e.wf.state(a).stage).toBe('review')
    expect(await fact(e, a)).toBeNull()
    // Another card's commit past it: not A's.
    commit(e.project, { 'b1.txt': 'b\n' }, 'b1', { trailer: b.key })
    expect(await fact(e, a)).toBeNull()
    // A commit of A's on another branch, attributed there, then back on the line with only B's commits past it.
    sh(e.project, 'checkout', '-q', '-b', 'side')
    commit(e.project, { 'a-side.txt': 'a\n' }, 'a on side', { trailer: a.key })
    await attributeFolder(e.wf)
    expect(e.wf.state(a).attributed.length).toBeGreaterThan(1)
    sh(e.project, 'checkout', '-q', 'main')
    commit(e.project, { 'b2.txt': 'b\n' }, 'b2', { trailer: b.key })
    expect(await fact(e, a)).toBeNull()
    // A's own commit on the line: said, attributed by the read itself.
    commit(e.project, { 'a2.txt': 'a\n' }, 'a2', { trailer: a.key })
    expect(await fact(e, a)).toEqual({ count: 1, atLeast: false, since: a1.slice(0, 7) })
  })

  it(`past ${UNSUBMITTED_MAX} commits on the line, only the card's among those read, as a lower bound (never the line's count)`, async () => {
    const e = shared()
    const a = e.wf.createCard({ title: 'A' })
    const b = e.wf.createCard({ title: 'B' })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    const a1 = commit(e.project, { 'a1.txt': 'a\n' }, 'a1', { trailer: a.key })
    await attributeFolder(e.wf)
    moved(await e.wf.submit(a.key, B1, { summary: 'A' }))
    // The newest 2 of 101 are A's, the rest B's.
    manyCommits(e.project, 'main', UNSUBMITTED_MAX + 1, (i) => (i > UNSUBMITTED_MAX - 1 ? a.key : b.key))
    expect(await fact(e, a)).toEqual({ count: 2, atLeast: true, since: a1.slice(0, 7) })
  })
})

describe('HI-2245: the watch replies, whole', () => {
  const u = [{ card: 12, count: 2, atLeast: false, since: 'ab30f52' }]
  it('a watch begun: hand over first, then end the turn; no unconditional "End your turn now"', () => {
    const t = taskWaitText({ watching: 'Waiting for #12', limitAt: 'T', unsubmitted: u })
    expect(t).toBe("Waiting for #12. First hand #12 over: #12's line has 2 commits since its submission (ab30f52); cw_submit with followUp: true, then end your turn: Combwork types a line into this session when it changes, or at T if nothing does. Nothing runs meanwhile.")
    expect(t).not.toMatch(/End your turn now/)
    // Two cards, one a lower bound.
    expect(taskWaitText({ watching: 'Waiting for #12 or #13', limitAt: 'T', unsubmitted: [...u, { card: 13, count: 100, atLeast: true, since: 'cd12345' }] })).toBe(
      "Waiting for #12 or #13. First hand them over: #12's line has 2 commits since its submission (ab30f52); #13's line has at least 100 commits since its submission (cd12345); cw_submit each with followUp: true, then end your turn: Combwork types a line into this session when it changes, or at T if nothing does. Nothing runs meanwhile."
    )
  })
  it('already: hand over first', () => {
    const already = { number: 12, column: 'review', changes: ['column'], by: null, comment: null }
    expect(taskWaitText({ already, unsubmitted: [{ ...u[0], count: 1 }] })).toBe("Already: #12 is in Review (column). First hand #12 over: #12's line has 1 commit since its submission (ab30f52); cw_submit with followUp: true.")
  })
  it('with no fact, the replies are as before', () => {
    expect(taskWaitText({ watching: 'Waiting for #12', limitAt: 'T' })).toBe('Waiting for #12. End your turn now: Combwork types a line into this session when it changes, or at T if nothing does. Nothing runs meanwhile.')
    expect(taskWaitText({ watching: 'Waiting for #12', limitAt: 'T', unsubmitted: [] })).toBe('Waiting for #12. End your turn now: Combwork types a line into this session when it changes, or at T if nothing does. Nothing runs meanwhile.')
    expect(taskWaitText({ already: { number: 12, column: 'review', changes: ['column'], by: null, comment: null } })).toBe('Already: #12 is in Review (column).')
  })
})
