// HI-3552: the pull request finish on a real repository, a local bare repository standing in for GitHub and an in-memory
// GitHub answering gh's pull request commands (no gh, no network). An approved card waits in Approved with a request
// pinning its approved revision and the project's repository; Combwork's host pushes that exact commit (never forced,
// only to a remote whose push addresses are that repository), opens a draft (or ready) pull request, and moves it to PR
// open; a lost create reply is found again, never opened twice; a failure waits under For you to try again. Following
// it: merged on GitHub → Done with GitHub's merge commit; closed → Todo, its branch kept; a late reply changes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { allOff, type WorkflowOptions } from '../../src/shared/workflow/options'
import { producedStages } from '../../src/shared/workflow/compile'
import { PR_RETRY_GATE } from '../../src/shared/workflow/facts'
import { followPr, openPr, pushesTo, type GhPort, type PrPorts } from '../../src/main/workflow/prHost'
import { tempDir } from '../tempDir'

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
      return { ok: true, stdout: '', json: { number: p.number, url: p.url, state: p.state, isDraft: p.isDraft, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }], headRefOid: p.headRefOid, mergeCommit: p.mergeCommit, mergedAt: null, closedAt: p.closedAt } }
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
    expect(producedStages({ ...allOff('git'), finish: 'pullRequest', folder: 'slots', review: 'agent', noSelfReview: true })).toEqual(['hold', 'todo', 'active', 'review', 'approved', 'prOpen', 'done'])
    expect(producedStages({ ...allOff('git'), finish: 'pullRequest', folder: 'slots' })).toEqual(['hold', 'todo', 'active', 'prOpen', 'done'])
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
    expect(sh(bare, 'rev-parse', s.started!.line)).toBe(revision)
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
    expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', s.started!.line)).toThrow()
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
    const line = e.wf.state(card).started!.line
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
    expect(() => sh(bare, 'rev-parse', '--verify', '--quiet', e.wf.state(card).started!.line)).toThrow()
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
    const line = e.wf.state(card).started!.line
    await openPr(e.wf, card.id, requestOf(e, card.id), ports)
    gh.prs[0].state = 'CLOSED'
    gh.prs[0].closedAt = '2026-11-24T10:00:00Z'
    await followPr(e.wf, card.id, ports)
    let s = e.wf.state(card)
    expect(s.stage).toBe('todo')
    expect(s.pullRequest?.closed).toMatchObject({ number: 12, at: '2026-11-24T10:00:00Z', by: null })
    expect(sh(e.project, 'rev-parse', '--verify', line)).toBeTruthy()
    // Started again: a new cycle, its old pull request's replies never move it.
    moved(await e.wf.start(card.key, B1))
    gh.prs[0].state = 'MERGED'
    expect(await followPr(e.wf, card.id, ports)).toBeNull()
    s = e.wf.state(card)
    expect(s.stage).toBe('active')
    expect(s.pullRequest).toBeNull()
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
