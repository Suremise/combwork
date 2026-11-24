// HI-3559 (Feedback to GitHub): a reviewer agent's verdict on a pull request's card, under each value of the option, on
// a real repository with a local bare repository standing in for GitHub (prSource.test.ts's #7). The draft is written
// with the verdict, under the option then: Agent's with the action Combwork posts it by, Both's for the user, You's none.
// Posting (postReviewOn) claims it once, sends a COMMENT review through a fake gh (its payload read from its --input
// file), the user's open line comments inline where the PR's diff has the lines and listed otherwise, an agent's text with
// its footer (off by the switch, never on the user's own), and what the option doesn't allow is refused, nothing posted.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { allOff, type WorkflowOptions } from '../../src/shared/workflow/options'
import { boardFile } from '../../src/main/boardStore'
import { discardReviewOn, postReviewOn, type PostDeps } from '../../src/main/githubReviews'
import { gitRevisionReads } from '../../src/main/platform/git/gitRevisionReads'
import { foldGithubReviews, REVIEW_BODY_MAX, rowActions, STUCK_MS } from '../../src/shared/githubReviews'
import type { GhResult, GhTarget } from '../../src/main/ghCli'
import type { GithubSource } from '../../src/shared/githubSource'
import type { LineCommentView } from '../../src/shared/workflow/lineComments'
import { tempDir } from '../tempDir'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const SOURCE: GithubSource = { kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'T', pr: { headRef: 'feature', baseRef: 'main', crossRepository: false, maintainerCanModify: true } }
const LINK = { host: 'github.com', owner: 'acme', repo: 'app' }

function giveSource(e: Env, card: number, s: GithubSource): void {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.prepare(`UPDATE cards SET extra = json_set(COALESCE(extra, '{}'), '$.source', json(?)) WHERE number = ?`).run(JSON.stringify(s), card)
  } finally {
    db.close()
  }
}

/** A bare repository as origin, with main and pull request #7 adding pr.txt (ten lines). */
function github(e: Env): void {
  const bare = tempDir('gh-bare-')
  sh(bare, 'init', '-q', '--bare')
  sh(e.project, 'remote', 'add', 'origin', bare)
  sh(e.project, 'push', '-q', 'origin', 'main')
  const clone = tempDir('gh-clone-')
  sh(clone, 'clone', '-q', '-b', 'main', bare, '.')
  sh(clone, 'switch', '-q', '-c', 'feature')
  commit(clone, { 'pr.txt': Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' }, 'PR work')
  sh(clone, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head')
}

function project(feedback: WorkflowOptions['githubFeedback']): Env {
  let home = ''
  const e = setup(
    { ...allOff('git'), platform: 'git', review: 'agent', noSelfReview: true, target: 'main', finish: 'combworkMerges', folder: 'slots', ...(feedback ? { githubFeedback: feedback } : {}) },
    {
      slotFor: async (card) => ({ folder: join(home, 'slots', card.key), slot: `slot-${card.key}`, lease: `L-${card.key}`, fresh: true }),
      githubLink: async () => ({ remote: 'origin', ...LINK })
    }
  )
  home = e.home
  github(e)
  return e
}

/** A PR card started, submitted unchanged (its builder runs checks only) and reviewed by R1: its verdict's comment `comment`. */
async function reviewed(e: Env, pass = false, comment = 'Finding 1: the parser drops the last line.', o: { holdActions?: boolean } = {}): Promise<number> {
  const card = e.wf.createCard({ title: 'PR #7 by mona' })
  giveSource(e, card.id, SOURCE)
  moved(await e.wf.start(card.key, B1))
  moved(await e.wf.submit(card.key, B1, { summary: 'Checks pass.' }))
  moved(await e.wf.startReview(card.key, R1))
  // holdActions: the verdict's actions left pending for the action worker, as the app runs them (autoRun off).
  if (o.holdActions) (e.wf.cfg as { autoRun?: boolean }).autoRun = false
  moved(await e.wf.verdict(card.key, R1, { pass, comment }))
  return card.id
}

const rows = (e: Env, card: number) => foldGithubReviews(e.store.facts(card))
const hasAction = (e: Env, card: number, fact: number): boolean => e.store.hasAction(card, 'postGithubReview', fact)

/** A fake gh for posting: each call's arguments and the review it was given (read from its --input file before it goes). */
function fakeGh(answers: GhResult[] = []): { gh: PostDeps['gh']; calls: { args: string[]; review: Record<string, unknown> }[] } {
  const calls: { args: string[]; review: Record<string, unknown> }[] = []
  const gh = (async (target: GhTarget, args: string[]): Promise<GhResult> => {
    const file = args[args.indexOf('--input') + 1]
    calls.push({ args: [...args, ...('host' in target ? ['--hostname', target.host] : [])], review: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> })
    return answers.shift() ?? { ok: true, stdout: JSON.stringify({ id: calls.length, html_url: `https://github.com/acme/app/pull/7#pullrequestreview-${calls.length}` }), json: null }
  }) as PostDeps['gh']
  return { gh, calls }
}

function deps(e: Env, over: Partial<PostDeps> = {}): PostDeps {
  return { link: async () => LINK, comments: () => [], model: async () => 'Opus 5.5', reads: gitRevisionReads, projectPath: e.project, gh: fakeGh().gh, ...over }
}

/** A user's open line comment on the card's latest submission. */
const comment = (e: Env, card: number, c: Partial<LineCommentView>): LineCommentView => ({ id: `lc-${c.from}`, by: 'user', at: '', submission: e.wf.state(e.store.card(card)).latest!.id, side: 'new', path: 'pr.txt', from: 1, to: 1, lines: '', before: '', after: '', body: 'Say why.', state: 'open', version: 1, sent: false, ...c }) as LineCommentView

describe('Feedback to GitHub (HI-3559)', () => {
  it('drafts a reviewer agent’s verdict as it is written: Agent with its post action, Both for the user, You none', async () => {
    for (const feedback of ['agent', 'both', 'user', undefined] as const) {
      const e = (env = project(feedback))
      const card = await reviewed(e)
      const drafts = e.store.facts(card).filter((f) => f.kind === 'GithubReviewDrafted')
      if (feedback === 'user') expect(drafts, String(feedback)).toEqual([])
      else {
        expect(drafts.map((f) => f.data), String(feedback)).toEqual([expect.objectContaining({ reviewer: 'R1', body: 'Finding 1: the parser drops the last line.', auto: feedback === 'agent' })])
        expect(hasAction(e, card, drafts[0].seq), String(feedback)).toBe(feedback === 'agent')
      }
      e.close()
      env = null
    }
  })

  it('never drafts on a card without a pull request source, nor for a verdict written before the option changed', async () => {
    const e = (env = project('both'))
    const plain = e.wf.createCard({ title: 'Plain' })
    moved(await e.wf.start(plain.key, B1))
    commit(e.wf.state(plain).started!.folder, { 'a.txt': 'a\n' }, 'A')
    moved(await e.wf.submit(plain.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(plain.key, R1))
    moved(await e.wf.verdict(plain.key, R1, { pass: false, comment: 'no' }))
    expect(e.store.facts(plain.id).some((f) => f.kind === 'GithubReviewDrafted')).toBe(false)
    // You first, then Agent: the earlier verdict stays undrafted, never posted after the fact.
    e.options.githubFeedback = 'user'
    const card = await reviewed(e)
    e.options.githubFeedback = 'agent'
    expect(rows(e, card)).toEqual([])
  })

  it('Agent: Combwork posts the draft once, a COMMENT review naming the host, with the model’s footer', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e)
    const draft = rows(e, card)[0].draft!.seq
    const g = fakeGh()
    const row = await postReviewOn(e.wf, card, { row: draft }, 'combwork', deps(e, { gh: g.gh }))
    expect(row.state).toBe('posted')
    expect(row.posted?.url).toBe('https://github.com/acme/app/pull/7#pullrequestreview-1')
    expect(g.calls[0].args).toEqual(expect.arrayContaining(['api', '--method', 'POST', 'repos/acme/app/pulls/7/reviews', '--hostname', 'github.com']))
    expect(g.calls[0].review).toEqual({ body: 'Finding 1: the parser drops the last line.\n\n---\n_Drafted by Opus 5.5 in Combwork_', event: 'COMMENT' })
    // Once: posting it again is refused, nothing sent.
    await expect(postReviewOn(e.wf, card, { row: draft }, 'combwork', deps(e, { gh: g.gh }))).rejects.toThrow(/already posted/)
    expect(g.calls).toHaveLength(1)
    // The user can't post the agent's draft under Agent, nor a review of their own.
    await expect(postReviewOn(e.wf, card, { row: null, body: 'Mine' }, 'user', deps(e, { gh: g.gh }))).rejects.toThrow(/doesn’t post a review you write/)
  })

  it('Both: Combwork never posts the draft; the user posts it as edited (the footer switched off here), and each verdict is a draft of its own', async () => {
    const e = (env = project('both'))
    const card = await reviewed(e)
    const draft = rows(e, card)[0].draft!.seq
    // Combwork never posts a Both draft.
    await expect(postReviewOn(e.wf, card, { row: draft }, 'combwork', deps(e))).rejects.toThrow(/doesn’t post an agent’s draft/)
    e.options.githubFooter = false
    const g = fakeGh()
    const row = await postReviewOn(e.wf, card, { row: draft, body: 'Edited: the parser drops the last line.' }, 'user', deps(e, { gh: g.gh }))
    expect(row.state).toBe('posted')
    expect(g.calls[0].review.body).toBe('Edited: the parser drops the last line.')
    // A second verdict's draft, discarded: never posted.
    moved(await e.wf.submit(e.store.card(card).key, B1, { summary: 'Again.', note: 'Answered the finding: nothing to change.' }))
    moved(await e.wf.startReview(e.store.card(card).key, R1))
    moved(await e.wf.verdict(e.store.card(card).key, R1, { pass: false, comment: 'Still.' }))
    const second = rows(e, card).find((r) => r.state === 'draft')!
    expect(second.draft?.body).toBe('Still.')
  })

  it('the user’s own review under You or Both carries no footer; You never posts an agent’s draft', async () => {
    const e = (env = project('user'))
    const card = await reviewed(e)
    const g = fakeGh()
    const row = await postReviewOn(e.wf, card, { row: null, body: 'Looks good to me.' }, 'user', deps(e, { gh: g.gh }))
    expect(row).toMatchObject({ state: 'posted', draft: null })
    expect(g.calls[0].review).toEqual({ body: 'Looks good to me.', event: 'COMMENT' })
    await expect(postReviewOn(e.wf, card, { row: null, body: '' }, 'user', deps(e))).resolves.toMatchObject({ state: 'failed', error: 'A review needs some text, or a line comment of yours to carry.' })
  })

  it('the user’s line comments go inline where the PR’s diff has the lines, the rest listed; GitHub refusing them lists all', async () => {
    const e = (env = project('both'))
    const card = await reviewed(e)
    const draft = rows(e, card)[0].draft!.seq
    const on = comment(e, card, { id: 'lc-a', from: 2, to: 3, body: 'Off by one.' })
    const deleted = comment(e, card, { id: 'lc-b', side: 'old', from: 1, to: 1, body: 'Kept?' })
    const g = fakeGh()
    const row = await postReviewOn(e.wf, card, { row: draft }, 'user', deps(e, { gh: g.gh, comments: () => [on, deleted, { ...on, id: 'lc-c', state: 'resolved' } as LineCommentView] }))
    expect(row.posted).toMatchObject({ inline: 1, listed: 1, comments: ['lc-a', 'lc-b'] })
    const review = g.calls[0].review as { commit_id: string; comments: unknown[]; body: string }
    expect(review.commit_id).toBe(e.wf.state(e.store.card(card)).started!.pr!.headOid)
    expect(review.comments).toEqual([{ path: 'pr.txt', body: 'Off by one.', line: 3, side: 'RIGHT', start_line: 2, start_side: 'RIGHT' }])
    // pr.txt is new: its old side has no lines on GitHub's diff, so that comment is listed.
    expect(review.body).toContain('**Line comments**\n- `pr.txt`, line 1 (before the change): Kept?')
    // GitHub refuses the inline comments (its head moved meanwhile): sent again with all of them listed.
    const e2 = project('both')
    try {
      const card2 = await reviewed(e2)
      const refused = fakeGh([{ ok: false, problem: 'failed', detail: 'HTTP 422: Unprocessable Entity (https://api.github.com/repos/acme/app/pulls/7/reviews)' }])
      const again = await postReviewOn(e2.wf, card2, { row: rows(e2, card2)[0].draft!.seq }, 'user', deps(e2, { gh: refused.gh, comments: () => [comment(e2, card2, { id: 'lc-a', from: 2, to: 3, body: 'Off by one.' })] }))
      expect(again.posted).toMatchObject({ inline: 0, listed: 1 })
      expect(refused.calls).toHaveLength(2)
      expect(refused.calls[1].review).not.toHaveProperty('comments')
    } finally {
      e2.close()
    }
  })

  it('a failed post is recorded with gh’s words and can be posted again; a link changed since is never posted to', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e)
    const draft = rows(e, card)[0].draft!.seq
    const down = fakeGh([{ ok: false, problem: 'signedOut', detail: 'gh auth login' }])
    const failed = await postReviewOn(e.wf, card, { row: draft }, 'combwork', deps(e, { gh: down.gh }))
    expect(failed).toMatchObject({ state: 'failed', error: 'gh auth login' })
    // Combwork doesn't try again by itself; the user can, under Agent, once it failed.
    await expect(postReviewOn(e.wf, card, { row: draft }, 'combwork', deps(e))).rejects.toThrow(/doesn’t post an agent’s draft/)
    const moved2 = fakeGh()
    const elsewhere = await postReviewOn(e.wf, card, { row: draft }, 'user', deps(e, { gh: moved2.gh, link: async () => ({ host: 'github.com', owner: 'acme', repo: 'next' }) }))
    expect(elsewhere.state).toBe('failed')
    expect(elsewhere.error).toMatch(/no longer names acme\/app/)
    expect(moved2.calls).toEqual([])
    const ok = await postReviewOn(e.wf, card, { row: draft }, 'user', deps(e))
    expect(ok.state).toBe('posted')
  })
})

describe('Feedback to GitHub’s boundaries (HI-3559, HR1’s round 1)', () => {
  it('1: the option changed while a post waits: nothing is posted', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e)
    const g = fakeGh()
    // Agent → You while the link is read: after the claim, before the write to GitHub.
    const row = await postReviewOn(e.wf, card, { row: rows(e, card)[0].draft!.seq }, 'combwork', deps(e, { gh: g.gh, link: async () => ((e.options.githubFeedback = 'user'), LINK) }))
    expect(row).toMatchObject({ state: 'failed' })
    expect(row.error).toMatch(/Feedback to GitHub is “You”/)
    expect(g.calls).toEqual([])
    // Both → You while the model is read, for the user's post of a draft: nothing either.
    e.options.githubFeedback = 'both'
    const both = await reviewed(e)
    const g2 = fakeGh()
    const r2 = await postReviewOn(e.wf, both, { row: rows(e, both)[0].draft!.seq }, 'user', deps(e, { gh: g2.gh, model: async () => ((e.options.githubFeedback = 'user'), 'Opus 5.5') }))
    expect(r2.state).toBe('failed')
    expect(g2.calls).toEqual([])
  })

  it('2: only GitHub’s own 422 sends again with the comments listed; an unknown outcome is kept, never sent twice', async () => {
    const answers: [string, GhResult][] = [
      ['a server error', { ok: false, problem: 'failed', detail: 'HTTP 502: Bad Gateway' }],
      ['no answer in time', { ok: false, problem: 'timeout', detail: null }],
      ['an answer that can’t be read', { ok: true, stdout: 'not json', json: null }],
      ['gh failing for another reason', { ok: false, problem: 'failed', detail: 'connection reset by peer' }]
    ]
    for (const [what, answer] of answers) {
      const e = (env = project('both'))
      const card = await reviewed(e)
      const g = fakeGh([answer])
      const row = await postReviewOn(e.wf, card, { row: rows(e, card)[0].draft!.seq }, 'user', deps(e, { gh: g.gh, comments: () => [comment(e, card, { id: 'lc-a', from: 2, to: 3 })] }))
      expect(row.state, what).toBe('uncertain')
      expect(g.calls, what).toHaveLength(1)
      // Shown so, with Post Again for the user to choose once they've looked.
      expect(rowActions('both', 'user', row, { now: Date.now(), pending: false }), what).toEqual({ post: true, discard: true, recovery: 'uncertain' })
      e.close()
      env = null
    }
  })

  it('3: a failed attempt keeps its text, an edited draft’s and the user’s own, and posting again sends it', async () => {
    const e = (env = project('both'))
    const card = await reviewed(e)
    const draft = rows(e, card)[0].draft!.seq
    const refused = fakeGh([{ ok: false, problem: 'failed', detail: 'HTTP 403: Resource not accessible' }])
    const failed = await postReviewOn(e.wf, card, { row: draft, body: 'Edited: say why.' }, 'user', deps(e, { gh: refused.gh }))
    expect(failed).toMatchObject({ state: 'failed', text: 'Edited: say why.' })
    expect(failed.draft?.body).toBe('Finding 1: the parser drops the last line.')
    const g = fakeGh()
    expect(await postReviewOn(e.wf, card, { row: draft }, 'user', deps(e, { gh: g.gh }))).toMatchObject({ state: 'posted' })
    expect(String(g.calls[0].review.body).startsWith('Edited: say why.')).toBe(true)
    // The user's own, failed: its row keeps it, and Post Again sends it (one row, no empty one).
    const own = await postReviewOn(e.wf, card, { row: null, body: 'Mine: looks good.' }, 'user', deps(e, { gh: fakeGh([{ ok: false, problem: 'signedOut', detail: 'gh auth login' }]).gh }))
    expect(own).toMatchObject({ state: 'failed', text: 'Mine: looks good.', draft: null })
    const g2 = fakeGh()
    expect(await postReviewOn(e.wf, card, { row: own.id }, 'user', deps(e, { gh: g2.gh }))).toMatchObject({ id: own.id, state: 'posted' })
    expect(g2.calls[0].review.body).toBe('Mine: looks good.')
    expect(rows(e, card).filter((r) => !r.draft)).toHaveLength(1)
  })

  it('4: an automatic post that never ran is the user’s to post; one that never finished, after a while, with a warning', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e, false, undefined, { holdActions: true })
    const draft = rows(e, card)[0].draft!.seq
    // Its action still pending: Combwork will post it, so the user can't yet.
    await expect(postReviewOn(e.wf, card, { row: draft }, 'user', deps(e))).rejects.toThrow(/doesn’t post an agent’s draft/)
    // Combwork closed before it ran (its action gone, nothing claimed): Post, never an automatic resend.
    const action = e.store.pendingActions().find((a) => a.kind === 'postGithubReview')!
    e.store.markAction(action.id, 'done')
    expect(rowActions('agent', 'user', rows(e, card)[0], { now: Date.now(), pending: false })).toEqual({ post: true, discard: true, recovery: 'abandoned' })
    expect(await postReviewOn(e.wf, card, { row: draft }, 'user', deps(e))).toMatchObject({ state: 'posted' })
    ;(e.wf.cfg as { autoRun?: boolean }).autoRun = true
    // Claimed and never finished (Combwork closed mid-post): refused while recent, then the user's, warned it may be posted.
    const card2 = await reviewed(e)
    const first = rows(e, card2)[0].draft!
    await e.wf.write(e.store.card(card2), null, 'combwork', (w) => w.fact('GithubReviewPosting', { draft: first.seq, by: 'combwork', submission: first.submission, body: first.body }))
    await expect(postReviewOn(e.wf, card2, { row: first.seq }, 'user', deps(e))).rejects.toThrow(/already being posted/)
    const later = Date.now() + STUCK_MS + 1000
    expect(rowActions('agent', 'user', rows(e, card2)[0], { now: later, pending: false })).toEqual({ post: true, discard: true, recovery: 'stale' })
    const g = fakeGh()
    expect(await postReviewOn(e.wf, card2, { row: first.seq }, 'user', deps(e, { gh: g.gh, now: () => later }))).toMatchObject({ state: 'posted' })
    expect(g.calls).toHaveLength(1)
  })

  it('5: a body over the limit is cut before its footer, which is kept', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e, false, 'x'.repeat(REVIEW_BODY_MAX + 500))
    const g = fakeGh()
    await postReviewOn(e.wf, card, { row: rows(e, card)[0].draft!.seq }, 'combwork', deps(e, { gh: g.gh, comments: () => [comment(e, card, { id: 'lc-z', side: 'old', from: 1, to: 1, body: 'Listed.' })] }))
    const body = String(g.calls[0].review.body)
    expect(body.length).toBeLessThanOrEqual(REVIEW_BODY_MAX)
    expect(body.endsWith('\n\n---\n_Drafted by Opus 5.5 in Combwork_')).toBe(true)
    expect(body).toContain('x…')
  })
})

describe('Feedback to GitHub’s stale discard (HI-3559, HR1’s round 2)', () => {
  it('a posting that never finished, discarded once stale, is discarded: no Post or Discard left, posting refused', async () => {
    const e = (env = project('agent'))
    const card = await reviewed(e)
    const first = rows(e, card)[0].draft!
    await e.wf.write(e.store.card(card), null, 'combwork', (w) => w.fact('GithubReviewPosting', { draft: first.seq, by: 'combwork', submission: first.submission, body: first.body }))
    // Recent: being posted, not the user's to discard.
    await expect(discardReviewOn(e.wf, card, first.seq)).rejects.toThrow(/already being posted/)
    const later = Date.now() + STUCK_MS + 1000
    await discardReviewOn(e.wf, card, first.seq, () => later)
    const row = rows(e, card)[0]
    expect(row.state).toBe('discarded')
    expect(rowActions('agent', 'user', row, { now: later, pending: false })).toEqual({ post: false, discard: false, recovery: null })
    const g = fakeGh()
    await expect(postReviewOn(e.wf, card, { row: first.seq }, 'user', deps(e, { gh: g.gh, now: () => later }))).rejects.toThrow(/discarded/)
    expect(g.calls).toEqual([])
  })
})
