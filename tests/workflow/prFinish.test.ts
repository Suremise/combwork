// HI-3552: the pull request finish on a real repository, a local bare repository standing in for GitHub and an in-memory
// GitHub answering gh's pull request commands (no gh, no network). An approved card waits in Approved with a request
// pinning its approved revision and the project's repository; Combwork's host pushes that exact commit (never forced,
// only to a remote whose push addresses are that repository), opens a draft (or ready) pull request, and moves it to PR
// open; a lost create reply is found again, never opened twice; a failure waits under For you to try again. Following
// it: merged on GitHub → Done with GitHub's merge commit; closed → Todo, its branch kept; a late reply changes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { allOff, contradictions, formShows, formTabOf, type WorkflowOptions } from '../../src/shared/workflow/options'
import { producedStages } from '../../src/shared/workflow/compile'
import { PR_RETRY_GATE } from '../../src/shared/workflow/facts'
import { followPr, notPushedNotice, openPr, prViewOf, pushesTo, type GhPort, type PrPorts } from '../../src/main/workflow/prHost'
import { tempDir } from '../tempDir'
import { intentText } from '../../src/shared/toolReplies'
import { laneRules } from '../../src/shared/laneBrief'
import { DatabaseSync } from 'node:sqlite'
import { boardFile } from '../../src/main/boardStore'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const LINK = { remote: 'origin', host: 'github.com', owner: 'acme', repo: 'app' }
const GITHUB_URL = ['https://github.com/acme/app.git']

/** The project's rules with the pull request finish, built in slots, and its GitHub link (or none). */
function project(more: Partial<WorkflowOptions> = {}, link: typeof LINK | null = LINK): Env {
  let home = ''
  const e = setup(
    { ...allOff('git'), platform: 'git', review: 'agent', noSelfReview: true, target: 'main', finish: 'pullRequest', folder: 'slots', ...more },
    {
      slotFor: async (card) => ({ folder: join(home, 'slots', card.key), slot: `slot-${card.key}`, lease: `L-${card.key}`, fresh: true }),
      githubLink: async () => link
    }
  )
  home = e.home
  return e
}

interface FakePr {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  createdAt: string
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  headRefOid: string
  mergeCommit: { oid: string } | null
  closedAt: string | null
  title: string
  body: string
  /** HI-3562: its head repository (a fork's) and whether maintainers may push there; its head read live from `headBare`. */
  headOwner?: string
  headRepo?: string
  maintainerCanModify?: boolean
  headBare?: string
}

/** GitHub as gh answers it for acme/app, its branches the bare repository's. */
function fakeGithub(bare: string) {
  const prs: FakePr[] = []
  const calls: { args: string[]; input?: string; repo: string }[] = []
  const o = { loseCreate: false, signedOut: false, before: null as null | ((args: string[]) => Promise<void> | void) }
  const arg = (args: string[], name: string): string => args[args.indexOf(name) + 1]
  const run: GhPort = async (target, args, opts) => {
    const repo = 'repo' in target ? `${target.repo.host}/${target.repo.owner}/${target.repo.repo}` : target.host
    calls.push({ args, input: opts?.input, repo })
    if (o.before) await o.before(args)
    if (o.signedOut) return { ok: false, problem: 'signedOut', detail: 'To get started with GitHub CLI, please run: gh auth login' }
    if (repo !== 'github.com/acme/app') return { ok: false, problem: 'failed', detail: `wrong repository ${repo}` }
    if (args[0] === 'pr' && args[1] === 'list') {
      const found = prs.filter((p) => p.headRefName === arg(args, '--head') && p.baseRefName === arg(args, '--base'))
      return { ok: true, stdout: '', json: found.map(({ number, url, createdAt, headRefName, baseRefName, isCrossRepository, isDraft }) => ({ number, url, createdAt, headRefName, baseRefName, isCrossRepository, isDraft })) }
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const head = arg(args, '--head')
      const number = prs.length + 12
      const url = `https://github.com/acme/app/pull/${number}`
      prs.push({ number, url, state: 'OPEN', isDraft: args.includes('--draft'), createdAt: new Date().toISOString(), headRefName: head, baseRefName: arg(args, '--base'), isCrossRepository: false, headRefOid: sh(bare, 'rev-parse', head), mergeCommit: null, closedAt: null, title: arg(args, '--title'), body: opts?.input ?? '' })
      if (o.loseCreate) return { ok: false, problem: 'timeout', detail: null }
      return { ok: true, stdout: `Creating pull request for ${head} into main in acme/app\n\n${url}\n`, json: null }
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const p = prs.find((x) => x.number === Number(args[2]))
      if (!p) return { ok: false, problem: 'failed', detail: 'no pull requests found' }
      const headRefOid = p.headBare ? sh(p.headBare, 'rev-parse', `refs/heads/${p.headRefName}`) : p.headRefOid
      return { ok: true, stdout: '', json: { number: p.number, url: p.url, state: p.state, isDraft: p.isDraft, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }], headRefOid, mergeCommit: p.mergeCommit, mergedAt: null, closedAt: p.closedAt, headRefName: p.headRefName, headRepository: { name: p.headRepo ?? 'app' }, headRepositoryOwner: { login: p.headOwner ?? 'acme' }, isCrossRepository: p.isCrossRepository, maintainerCanModify: p.maintainerCanModify ?? false } }
    }
    return { ok: false, problem: 'failed', detail: `unknown: ${args.join(' ')}` }
  }
  return { prs, calls, o, run, creates: () => calls.filter((c) => c.args[1] === 'create').length }
}

/** A bare repository as origin, with the project's main; and GitHub on it. */
function github(e: Env): { bare: string; gh: ReturnType<typeof fakeGithub>; ports: PrPorts } {
  const bare = tempDir('gh-bare-')
  sh(bare, 'init', '-q', '--bare')
  sh(e.project, 'remote', 'add', 'origin', bare)
  sh(e.project, 'push', '-q', 'origin', 'main')
  const gh = fakeGithub(bare)
  // The bare repository stands in for github.com/acme/app: its push address is read as GitHub's (pushesTo's own test
  // reads real ones).
  return { bare, gh, ports: { gh: gh.run, pushUrls: async () => GITHUB_URL } }
}

/** A card started, its work committed and submitted, and passed by its reviewer. */
async function approved(e: Env, title = 'Fix the parser'): Promise<{ card: ReturnType<Env['wf']['createCard']>; revision: string; folder: string }> {
  const card = e.wf.createCard({ title })
  moved(await e.wf.start(card.key, B1))
  const folder = e.wf.state(card).started!.folder
  const revision = commit(folder, { 'fix.txt': 'a fix\n' }, 'A fix')
  moved(await e.wf.submit(card.key, B1, { summary: 'Fixed the parser.\nIts tests too.' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'Looks right.\nMore detail.' }))
  return { card, revision, folder }
}

const requestOf = (e: Env, card: number): string => e.wf.state(card).pullRequest!.requested.request
const kinds = (e: Env, card: number): string[] => e.store.facts(card).map((f) => f.kind)

describe('the pull request finish (HI-3552)', () => {
  it('produces Approved and PR open, needs slots, and offers no merge style', () => {
    expect(contradictions({ ...allOff('git'), finish: 'pullRequest', folder: 'project' })).toContain('mergeNeedsSlots')
    expect(formShows('style', { ...allOff('git'), finish: 'pullRequest', folder: 'slots' })).toBe(false)
    expect(formShows('prDraft', { ...allOff('git'), finish: 'pullRequest', folder: 'slots' })).toBe(true)
    expect(formShows('prDraft', { ...allOff('git'), finish: 'combworkMerges', folder: 'slots' })).toBe(false)
    expect(formTabOf('git', 'prDraft')).toBe('github')
    expect(producedStages({ ...allOff('git'), finish: 'pullRequest', folder: 'slots', review: 'agent', noSelfReview: true })).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'prOpen', 'done'])
    // Approved with no review too: where a card waits while its pull request opens, or after a failure.
    expect(producedStages({ ...allOff('git'), finish: 'pullRequest', folder: 'slots' })).toEqual(['hold', 'todo', 'active', 'approved', 'prOpen', 'done'])
  })

  it('pushes the approved commit (not the line as it is now) and opens a draft pull request, then PR open', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, revision, folder } = await approved(e)
    const s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(s.pullRequest?.requested).toMatchObject({ revision, target: 'main', line: s.started!.line, host: 'github.com', owner: 'acme', repo: 'app', remote: 'origin' })
    const asked = e.store.facts(card.id).find((f) => f.kind === 'PrRequested')!
    expect(e.store.hasAction(card.id, 'openPr', asked.seq)).toBe(true)
    // The line moves on after the approval: what was approved is still what is pushed.
    commit(folder, { 'later.txt': 'not approved\n' }, 'Later')
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    const now = e.wf.state(card)
    expect(now.stage).toBe('prOpen')
    expect(now.pullRequest?.opened).toMatchObject({ number: 12, url: 'https://github.com/acme/app/pull/12', host: 'github.com', owner: 'acme', repo: 'app', head: s.started!.line, base: 'main', pushed: revision, draft: true })
    expect(sh(bare, 'rev-parse', s.started!.line!)).toBe(revision)
    const pr = gh.prs[0]
    expect(pr).toMatchObject({ isDraft: true, title: `${card.key}: Fix the parser`, baseRefName: 'main' })
    // The body on gh's standard input: the card, its summary, the verdict's first line, its key; never on the command line.
    expect(pr.body).toContain('Fixed the parser.\nIts tests too.')
    expect(pr.body).toContain('Review: passed by R1. Looks right.')
    expect(pr.body).not.toContain('More detail')
    expect(pr.body).toContain(`Combwork card ${card.key}.`)
    expect(gh.calls.find((c) => c.args[1] === 'create')!.args).toContain('-')
    expect(gh.calls.every((c) => !c.args.some((a) => a.includes('Fixed the parser')))).toBe(true)
  })

  it('opens it ready for review when the project says so', async () => {
    const e = (env = project({ prDraft: false }))
    const { gh, ports } = github(e)
    const { card } = await approved(e)
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(gh.prs[0].isDraft).toBe(false)
    expect(e.wf.state(card).pullRequest?.opened?.draft).toBe(false)
  })

  it('waits for the user’s OK before anything is pushed (G10)', async () => {
    const e = (env = project({ okBefore: { mode: 'every', labels: [] } }))
    const { gh, ports } = github(e)
    const { card } = await approved(e)
    let s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(s.pullRequest).toBeNull()
    const ask = s.requests.find((r) => r.gate === 'okBefore')!
    expect(ask.text).toContain('OK to push it and open its pull request?')
    moved(await e.wf.answer(card.key, ask.request, 'approved'))
    s = e.wf.state(card)
    expect(s.pullRequest?.requested.request).toBeTruthy()
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).stage).toBe('prOpen')
    expect(gh.creates()).toBe(1)
  })

  it('opens one for a card the user moves into Passed (their OK)', async () => {
    const e = (env = project())
    const { ports } = github(e)
    const card = e.wf.createCard({ title: 'Moved' })
    moved(await e.wf.start(card.key, B1))
    commit(e.wf.state(card).started!.folder, { 'a.txt': 'a\n' }, 'A')
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    moved(await e.wf.move(card.key, 'approved', 'user', { confirm: true, reason: 'looked at it myself' }))
    expect(e.wf.state(card).pullRequest?.requested.request).toBeTruthy()
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).stage).toBe('prOpen')
  })

  it('with no review and no OK, still waits in Approved while its pull request opens', async () => {
    const e = (env = project({ review: 'none', noSelfReview: false }))
    const { ports } = github(e)
    const card = e.wf.createCard({ title: 'No review' })
    moved(await e.wf.start(card.key, B1))
    commit(e.wf.state(card).started!.folder, { 'a.txt': 'a\n' }, 'A')
    moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
    expect(e.wf.state(card).stage).toBe('approved')
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).stage).toBe('prOpen')
  })

  it('finds a pull request whose create reply was lost, and never opens a second', async () => {
    const e = (env = project())
    const { gh, ports } = github(e)
    const { card } = await approved(e)
    gh.o.loseCreate = true
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).pullRequest?.opened).toMatchObject({ number: 12, recovered: true })
    expect(e.wf.state(card).stage).toBe('prOpen')
    // Run again (a restart with the action pending, two runs at once): nothing more.
    await Promise.all([openPr(e.wf, card.id, requestOf(e, card.id), ports), openPr(e.wf, card.id, requestOf(e, card.id), ports)])
    expect(gh.creates()).toBe(1)
    expect(kinds(e, card.id).filter((k) => k === 'PrOpened')).toHaveLength(1)
  })

  it('a pull request found already, even merged meanwhile, is recorded rather than opened again', async () => {
    const e = (env = project())
    const { gh, ports } = github(e)
    const { card } = await approved(e)
    // The first run pushed and its create reached GitHub, then this process ended before it was recorded (the action
    // stays pending).
    const r = e.wf.state(card).pullRequest!.requested
    sh(e.project, 'push', '-q', 'origin', `${r.revision}:refs/heads/${r.line}`)
    await gh.run({ repo: { host: 'github.com', owner: 'acme', repo: 'app' } }, ['pr', 'create', '--head', r.line, '--base', 'main', '--title', 't', '--body-file', '-'], { input: 'b' })
    gh.prs[0].state = 'MERGED'
    gh.prs[0].mergeCommit = { oid: 'abc123' }
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(gh.creates()).toBe(1)
    expect(e.wf.state(card).pullRequest?.opened).toMatchObject({ number: 12, recovered: true })
    // Following it finds the merge.
    await followPr(e.wf, card.id, ports)
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('pushes nothing to a remote whose push address isn’t the pinned repository, and asks to try again', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card } = await approved(e)
    await openPr(e.wf, card.id, requestOf(e, card.id), { ...ports, pushUrls: async () => ['https://github.com/acme/app.git', 'https://github.com/someone/else.git'] })
    const s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(s.pullRequest?.failed).toMatchObject({ problem: 'pushUrl' })
    expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', s.started!.line!)).toThrow()
    expect(gh.creates()).toBe(0)
    const ask = s.requests.find((r) => r.gate === PR_RETRY_GATE)!
    expect(ask.text).toContain('doesn’t push to acme/app on github.com')
    // Approve: a new request of the same cycle, opened this time.
    const first = requestOf(e, card.id)
    moved(await e.wf.answer(card.key, ask.request, 'approved'))
    expect(requestOf(e, card.id)).not.toBe(first)
    expect(e.wf.state(card).pullRequest?.requested.since).toBe(s.pullRequest!.requested.since)
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).stage).toBe('prOpen')
  })

  it('says so when the project has no GitHub link, or gh isn’t signed in', async () => {
    const e = (env = project({}, null))
    const { ports } = github(e)
    const { card } = await approved(e)
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).pullRequest?.failed?.problem).toBe('noLink')
    env.close()
    const f = (env = project())
    const g = github(f)
    const two = await approved(f, 'Second')
    g.gh.o.signedOut = true
    await openPr(f.wf, two.card.id, requestOf(f, two.card.id), g.ports)
    const s = f.wf.state(two.card)
    expect(s.pullRequest?.failed?.problem).toBe('ghSignedOut')
    expect(s.requests.find((r) => r.gate === PR_RETRY_GATE)!.text).toContain('gh auth login --hostname github.com')
  })

  it('never forces a push over commits pushed to its branch from outside', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card } = await approved(e)
    const line = e.wf.state(card).started!.line!
    // Someone pushed to the branch on GitHub first.
    const clone = tempDir('gh-other-')
    sh(clone, 'clone', '-q', '-b', 'main', bare, '.')
    commit(clone, { 'theirs.txt': 'theirs\n' }, 'Theirs')
    sh(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${line}`)
    const theirs = sh(clone, 'rev-parse', 'HEAD')
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).pullRequest?.failed?.problem).toBe('push')
    expect(sh(bare, 'rev-parse', line)).toBe(theirs)
    expect(gh.creates()).toBe(0)
  })

  it('pushes nothing for a request no longer waiting when it gets there (moved back meanwhile)', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card } = await approved(e)
    gh.o.before = async (args) => {
      if (args[1] !== 'list') return
      gh.o.before = null
      moved(await e.wf.move(card.key, 'active', 'user', { confirm: true, reason: 'not yet' }))
    }
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.state(card).stage).toBe('active')
    expect(gh.creates()).toBe(0)
    expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', e.wf.state(card).started!.line!)).toThrow()
  })

  // HR1, round 1: the request's authority is read in the lock before each push and create, as the merge queue's advance
  // reads its own: a decision since the pass (its generation newer than the verdict's) or an approval gone stale while gh
  // or git was waited for takes it away, though the card is still in Approved with its request waiting.
  it('pushes and opens nothing once the request has lost its authority while a step was waited for', async () => {
    for (const lose of ['decision', 'stale'] as const) {
      const e = (env = project())
      const { bare, gh, ports } = github(e)
      const { card, revision } = await approved(e)
      const take = (): Promise<unknown> =>
        e.wf.write(e.store.card(card.id), null, 'user', (w) => {
          const s = w.state()
          if (lose === 'decision') w.fact('Decision', { decision: `${card.key}/d${s.generation + 1}`, generation: s.generation + 1, text: 'Not like that.' })
          else w.fact('Stale', { approved: revision, current: 'f'.repeat(40), why: 'change' })
        })
      // A decision while gh lists; a pass gone stale while the push addresses are read.
      if (lose === 'decision') gh.o.before = async (args) => void (args[1] === 'list' && (gh.o.before = null, await take()))
      const at: PrPorts = lose === 'stale' ? { ...ports, pushUrls: async (p, r) => (await take(), ports.pushUrls(p, r)) } : ports
      await openPr(e.wf, card.id, requestOf(e, card.id), at)
      const s = e.wf.state(card)
      expect(s.stage, lose).toBe('approved')
      expect(s.pullRequest?.opened ?? null, lose).toBeNull()
      expect(gh.creates(), lose).toBe(0)
      expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', s.started!.line!), lose).toThrow()
      env.close()
      env = null
    }
  })

  // HR1, round 1: a pull request an earlier cycle opened (closed since) is never taken for a later cycle's, however soon
  // after it the card is passed again: the new cycle pushes and opens its own.
  it('closed, started again and passed again: opens a new pull request rather than finding the closed one', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card } = await approved(e)
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    gh.prs[0].state = 'CLOSED'
    gh.prs[0].closedAt = new Date().toISOString()
    await followPr(e.wf, card.id, ports)
    expect(e.wf.state(card).stage).toBe('todo')
    moved(await e.wf.start(card.key, B1))
    const again = commit(e.wf.state(card).started!.folder, { 'fix.txt': 'a better fix\n' }, 'A better fix')
    moved(await e.wf.submit(card.key, B1, { summary: 'Fixed it properly.' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'Now it is right.' }))
    expect(e.wf.state(card).stage).toBe('approved')
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    const s = e.wf.state(card)
    expect(gh.creates()).toBe(2)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ number: 13, pushed: again })
    expect(s.pullRequest?.opened?.recovered).toBeUndefined()
    expect(s.prsRecorded).toEqual([12, 13])
    expect(sh(bare, 'rev-parse', s.started!.line!)).toBe(again)
    // Followed, it stays open: the closed one's state never sends it back to Todo.
    expect(await followPr(e.wf, card.id, ports)).toMatchObject({ number: 13, state: 'open' })
    expect(e.wf.state(card).stage).toBe('prOpen')
  })

  // HR1, round 1: a run belongs to its workspace's lifetime (prHosts.ts's owner): closed or switched while gh or git is
  // waited for, it pushes, opens, writes and keeps nothing more; the reopened workspace's run takes the card up.
  it('stops a run whose workspace closed while it waited, and the next owner’s run opens it once', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, revision } = await approved(e)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let first = true
    gh.o.before = async (args) => {
      if (args[1] === 'list' && first) {
        first = false
        await held
      }
    }
    let open = true
    const closing = openPr(e.wf, card.id, requestOf(e, card.id), ports, () => open)
    open = false
    // The reopened workspace's sweep: its own run, not the closed one's result.
    await openPr(e.wf, card.id, requestOf(e, card.id), ports, () => true)
    release()
    await closing
    expect(gh.creates()).toBe(1)
    expect(kinds(e, card.id).filter((k) => k === 'PrOpened' || k === 'PrOpenFailed')).toEqual(['PrOpened'])
    expect(sh(bare, 'rev-parse', e.wf.state(card).started!.line!)).toBe(revision)

    // Following: a read held while the workspace closes keeps no view and moves nothing, merged or not.
    const view = await followPr(e.wf, card.id, ports)
    expect(view?.state).toBe('open')
    gh.prs[0].state = 'MERGED'
    gh.prs[0].mergeCommit = { oid: 'e'.repeat(40) }
    let alive = true
    gh.o.before = async () => {
      alive = false
    }
    expect(await followPr(e.wf, card.id, ports, () => alive)).toBeNull()
    expect(e.wf.state(card).stage).toBe('prOpen')
    expect(prViewOf(e.wf, card.id)).toEqual(view)
  })

  it('follows it: merged on GitHub (outside commits too) → Done with GitHub’s merge commit; what was pushed kept', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, revision } = await approved(e)
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    const open = await followPr(e.wf, card.id, ports)
    expect(open).toMatchObject({ state: 'open', number: 12, draft: true, review: 'required', checks: { passed: 1, failed: 0, pending: 1 }, outside: false })
    expect(e.wf.state(card).stage).toBe('prOpen')
    // A commit pushed to the pull request from outside, then the merge.
    gh.prs[0].headRefOid = 'f'.repeat(40)
    const view = await followPr(e.wf, card.id, ports)
    expect(view?.outside).toBe(true)
    gh.prs[0].state = 'MERGED'
    gh.prs[0].mergeCommit = { oid: 'e'.repeat(40) }
    await followPr(e.wf, card.id, ports)
    const s = e.wf.state(card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ revision: 'f'.repeat(40), target: 'main', result: 'e'.repeat(40), method: 'pullRequest', by: 'github', platform: { pr: 12, pushed: revision } })
    expect(sh(bare, 'rev-parse', 'main')).toBe(sh(e.project, 'rev-parse', 'main'))
  })

  it('follows it: closed without merging → Todo, its branch kept; a late reply from that cycle changes nothing', async () => {
    const e = (env = project())
    const { gh, ports } = github(e)
    const { card } = await approved(e)
    const line = e.wf.state(card).started!.line!
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    gh.prs[0].state = 'CLOSED'
    gh.prs[0].closedAt = '2026-11-24T10:00:00Z'
    await followPr(e.wf, card.id, ports)
    let s = e.wf.state(card)
    expect(s.stage).toBe('todo')
    expect(s.pullRequest?.closed).toMatchObject({ number: 12, at: '2026-11-24T10:00:00Z', by: null })
    // A comment says so on the card, written with the move.
    const moveBack = e.store.facts(card.id).filter((f) => f.kind === 'Moved').at(-1)!
    expect(e.store.hasAction(card.id, 'comment', moveBack.seq)).toBe(true)
    expect(sh(e.project, 'rev-parse', '--verify', line)).toBeTruthy()
    // Started again: a new cycle, its old pull request's replies never move it.
    moved(await e.wf.start(card.key, B1))
    gh.prs[0].state = 'MERGED'
    expect(await followPr(e.wf, card.id, ports)).toBeNull()
    s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.pullRequest).toBeNull()
    // Its last read was of that cycle's pull request: kept for none now.
    expect(prViewOf(e.wf, card.id)).toBeNull()
  })

  /**
   * HI-3562: a pull request's card (HI-3551) whose pull request #7 is on `feature`, GitHub's head of it: on the base
   * repository's bare (same repository) or a fork's bare (`someone/app`, its maintainers allowed to push or not), with
   * refs/pull/7/head on the base one as GitHub keeps it. Started, a fix committed, submitted and passed: in Approved, its
   * push back asked.
   */
  async function prCard(e: Env, bare: string, gh: ReturnType<typeof fakeGithub>, o: { fork?: boolean; canModify?: boolean } = {}) {
    const clone = tempDir('gh-pr-')
    sh(clone, 'clone', '-q', '-b', 'main', bare, '.')
    sh(clone, 'switch', '-q', '-c', 'feature')
    const prHead = commit(clone, { 'pr.txt': 'from the pull request\n' }, 'PR work')
    sh(clone, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head')
    let headBare = bare
    if (o.fork) {
      headBare = tempDir('gh-fork-')
      sh(headBare, 'init', '-q', '--bare')
      sh(clone, 'push', '-q', headBare, 'HEAD:refs/heads/feature')
    } else sh(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')
    const fork = !!o.fork
    const canModify = o.canModify ?? true
    gh.prs.push({ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false, createdAt: '2026-11-01T00:00:00Z', headRefName: 'feature', baseRefName: 'main', isCrossRepository: fork, headRefOid: prHead, mergeCommit: null, closedAt: null, title: 't', body: '', headOwner: fork ? 'someone' : 'acme', headRepo: 'app', maintainerCanModify: canModify, headBare })
    const card = e.wf.createCard({ title: 'PR 7' })
    const db = new DatabaseSync(boardFile(e.home))
    try {
      db.prepare(`UPDATE cards SET extra = json_set(COALESCE(extra, '{}'), '$.source', json(?)) WHERE number = ?`).run(JSON.stringify({ kind: 'pr', host: 'github.com', owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 't', pr: { headRef: 'feature', baseRef: 'main', crossRepository: fork, maintainerCanModify: canModify } }), card.id)
    } finally {
      db.close()
    }
    moved(await e.wf.start(card.key, B1))
    const revision = commit(e.wf.state(card).started!.folder, { 'fix.txt': 'a fix\n' }, 'A fix')
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    return { card, revision, prHead, headBare, clone }
  }
  const forkAt = (headBare: string, urls = ['https://github.com/someone/app.git']) => async () => ({ target: headBare, urls })
  // The comment is written with the move to PR open.
  const commentOf = (e: Env, card: number): boolean => e.store.hasAction(card, 'comment', e.store.facts(card).filter((f) => f.kind === 'Moved').at(-1)!.seq)

  it('a pull request’s card pushes its approved fixes to its own pull request’s branch (same repository), opening none', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, revision, prHead } = await prCard(e, bare, gh)
    let s = e.wf.state(card)
    expect(s.stage).toBe('approved')
    expect(s.pullRequest?.requested).toMatchObject({ revision, target: 'main', line: 'feature', host: 'github.com', owner: 'acme', repo: 'app', remote: 'origin', source: { number: 7, headRef: 'feature' } })
    expect(e.store.hasAction(card.id, 'openPr', e.store.facts(card.id).find((f) => f.kind === 'PrRequested')!.seq)).toBe(true)
    // The card's line moves on after the approval: what was approved is what is pushed.
    commit(s.started!.folder, { 'later.txt': 'not approved\n' }, 'Later')
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    s = e.wf.state(card)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ number: 7, url: 'https://github.com/acme/app/pull/7', head: 'feature', base: 'main', pushed: revision })
    expect(s.pullRequest?.opened?.notPushed).toBeUndefined()
    expect(sh(bare, 'rev-parse', 'feature')).toBe(revision)
    expect(sh(e.project, 'merge-base', '--is-ancestor', prHead, revision)).toBe('')
    // GitHub read again naming the base repository; nothing opened.
    expect(gh.calls.filter((c) => c.args[1] === 'view').every((c) => c.repo === 'github.com/acme/app')).toBe(true)
    expect(gh.creates()).toBe(0)
    gh.prs[0].state = 'MERGED'
    gh.prs[0].mergeCommit = { oid: 'c'.repeat(40) }
    await followPr(e.wf, card.id, ports)
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.wf.state(card).integrated).toMatchObject({ revision, result: 'c'.repeat(40), platform: { pr: 7, pushed: revision } })
  })

  it('pushes to a fork’s branch whose author allows maintainer edits, by the fork’s own address', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, revision, headBare } = await prCard(e, bare, gh, { fork: true, canModify: true })
    await openPr(e.wf, card.id, requestOf(e, card.id), { ...ports, forkTarget: forkAt(headBare) })
    const s = e.wf.state(card)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ number: 7, pushed: revision })
    expect(sh(headBare, 'rev-parse', 'feature')).toBe(revision)
    // The base repository's own branches are untouched.
    expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature')).toThrow()
  })

  it('pushes nothing to a fork whose author doesn’t allow maintainer edits: PR open, saying why', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, prHead, headBare } = await prCard(e, bare, gh, { fork: true, canModify: false })
    await openPr(e.wf, card.id, requestOf(e, card.id), { ...ports, forkTarget: forkAt(headBare) })
    const s = e.wf.state(card)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ number: 7, notPushed: true, notPushedWhy: 'fork', pushed: prHead })
    expect(sh(headBare, 'rev-parse', 'feature')).toBe(prHead)
    expect(commentOf(e, card.id)).toBe(true)
  })

  it('never overwrites commits pushed to GitHub’s head from outside, fetching that head when it isn’t here', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, prHead, clone } = await prCard(e, bare, gh)
    // Someone pushes to the pull request after the card started: an object the project hasn't got.
    sh(clone, 'reset', '-q', '--hard', prHead)
    const outside = commit(clone, { 'theirs.txt': 'their change\n' }, 'Theirs')
    sh(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/feature', '+HEAD:refs/pull/7/head')
    expect(() => sh(e.project, 'cat-file', '-e', `${outside}^{commit}`)).toThrow()
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    const s = e.wf.state(card)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ notPushed: true, notPushedWhy: 'outside', pushed: outside })
    expect(sh(e.project, 'cat-file', '-t', outside)).toBe('commit')
    expect(sh(bare, 'rev-parse', 'feature')).toBe(outside)
    expect(commentOf(e, card.id)).toBe(true)
  })

  it('a branch that moves between the check and the push refuses it, nothing forced: PR open, saying why', async () => {
    const e = (env = project())
    const { bare, gh, ports } = github(e)
    const { card, prHead, clone } = await prCard(e, bare, gh)
    let theirs = ''
    const moving: PrPorts = {
      ...ports,
      pushUrls: async (p, r) => {
        // Checked already (GitHub's head in the approved commit); someone pushes just now.
        sh(clone, 'reset', '-q', '--hard', prHead)
        theirs = commit(clone, { 'theirs.txt': 'just now\n' }, 'Just now')
        sh(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/feature')
        return ports.pushUrls(p, r)
      }
    }
    await openPr(e.wf, card.id, requestOf(e, card.id), moving)
    const s = e.wf.state(card)
    expect(s.stage).toBe('prOpen')
    expect(s.pullRequest?.opened).toMatchObject({ notPushed: true, notPushedWhy: 'refused', pushed: prHead })
    expect(sh(bare, 'rev-parse', 'feature')).toBe(theirs)
  })

  // A fixed notice that only reports (HI-3394): no scenario has this finish; its exact text for each reason.
  it('says on the card why its fixes weren’t pushed, in words agents read', () => {
    const tail = '. Nothing was pushed; the card follows the pull request in PR open.'
    expect(notPushedNotice('AM-1', 7, 'fork')).toBe(`AM-1's fixes weren't pushed to pull request #7: it is from a fork whose author doesn't allow maintainers to push to it${tail}`)
    expect(notPushedNotice('AM-1', 7, 'outside')).toBe(`AM-1's fixes weren't pushed to pull request #7: its branch on GitHub has commits the approved commit lacks, pushed from outside${tail}`)
    expect(notPushedNotice('AM-1', 7, 'refused')).toBe(`AM-1's fixes weren't pushed to pull request #7: the push was refused, its branch having moved since it was read${tail}`)
    expect(notPushedNotice('AM-1', 7, 'notOpen')).toBe(`AM-1's fixes weren't pushed to pull request #7: it isn't open on GitHub${tail}`)
    expect(notPushedNotice('AM-1', 7, 'changed')).toBe(`AM-1's fixes weren't pushed to pull request #7: its head isn't the branch the card started on${tail}`)
  })

  it('pushes nothing where a push address isn’t the pull request’s head repository, and asks to try again', async () => {
    for (const fork of [false, true]) {
      const e = (env = project())
      const { bare, gh, ports } = github(e)
      const { card, prHead, headBare } = await prCard(e, bare, gh, { fork })
      const wrong: PrPorts = fork ? { ...ports, forkTarget: forkAt(headBare, ['https://github.com/someone/app.git', 'https://github.com/elsewhere/app.git']) } : { ...ports, pushUrls: async () => ['https://github.com/acme/app.git', 'https://github.com/elsewhere/app.git'] }
      await openPr(e.wf, card.id, requestOf(e, card.id), wrong)
      const s = e.wf.state(card)
      expect(s.stage, String(fork)).toBe('approved')
      expect(s.pullRequest?.failed?.problem, String(fork)).toBe('pushUrl')
      expect(s.requests.some((q) => q.gate === PR_RETRY_GATE), String(fork)).toBe(true)
      expect(sh(headBare, 'rev-parse', 'feature'), String(fork)).toBe(prHead)
      env.close()
      env = null
    }
  })

  it('tells agents what comes next and what the lane does (fixed notices: no scenario has this finish)', async () => {
    const e = (env = project())
    const { ports } = github(e)
    const { card } = await approved(e)
    expect(e.wf.nextFor(card.id)).toEqual({ step: 'pullRequest' })
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    expect(e.wf.nextFor(card.id)).toEqual({ step: 'pullRequest' })
    const reply = intentText({ ok: true, card: card.key, from: 'approved', to: 'prOpen', next: { step: 'pullRequest' } } as never)
    expect(reply).toContain('Next: Combwork opens its pull request on GitHub (or follows the one open), and it is done once merged there.')
    expect(laneRules({ review: 'agent', finish: 'pullRequest', preChecks: [], okBefore: { mode: 'never', labels: [] }, target: 'main' } as never)).toContain('Combwork pushes each approved card and opens its pull request on GitHub; the card is done when it is merged there.')
  })

  it('reads a remote’s push addresses as the pinned repository, every one of them', () => {
    const r = { host: 'github.com', owner: 'acme', repo: 'app' }
    expect(pushesTo(['https://github.com/acme/app.git'], r)).toBe(true)
    expect(pushesTo(['git@github.com:Acme/App.git'], r)).toBe(true)
    expect(pushesTo(['https://github.com/acme/app.git', 'https://github.com/acme/fork.git'], r)).toBe(false)
    expect(pushesTo(['https://ghe.example.com/acme/app.git'], r)).toBe(false)
    expect(pushesTo(['D:\\repos\\app.git'], r)).toBe(false)
    expect(pushesTo([], r)).toBe(false)
    expect(pushesTo(null, r)).toBe(false)
  })
})
