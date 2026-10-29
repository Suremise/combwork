// HI-2019: a git read that fails for a moment (a lock held, git not starting on a loaded machine) before the merge queue
// has touched anything sends the entry round again, admitted afresh first (still approved, no pause saved meanwhile, the
// rules on, the lease held), within READ_RETRIES; only a read that keeps failing pauses, needsYou with git's own words. A
// commit identity git couldn't read is never taken for one that isn't set. The queue's worktree is reused only when git
// lists it, and nothing of it is ever removed. After the advance, only the folder's branch is read again: nothing is
// redone. The failures are injected where git's outcome comes from (gitWorker's runGit: what the process did, before
// src/main/git's git() reads it), so the real normalisation and the platform's reads see them: git's own exit (128, with
// what it said) or a git that didn't run to an exit (Node's EAGAIN, nothing said). Deterministic: no load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { READ_RETRIES, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import { git } from '../../src/main/git'
import * as G from '../../src/main/platform/git'
import { isUnknown } from '../../src/main/platform/types'
import { gitTool } from '../../src/main/gitTool'
import type { GitOutcome, GitRequest } from '../../src/main/gitWorker'

type Rule = { match: (args: string) => boolean; times: number; native?: string; err: string; code: number; after?: () => Promise<void> }
/** The git calls to fail: the first whose command matches, `times` times (Infinity: always); each call's command. */
const fail = vi.hoisted(() => ({ rules: [] as Rule[], calls: [] as string[] }))
vi.mock('../../src/main/gitWorker', async (orig) => {
  const real = (await orig()) as typeof import('../../src/main/gitWorker')
  // The command as Hive's code wrote it: GIT_PREFIX (git.ts's options for every command) left out.
  const commandOf = (args: string[]): string => args.slice(args.indexOf('core.quotepath=off') + 1).join(' ')
  return {
    ...real,
    runGit: async (m: Omit<GitRequest, 'id'>, ...rest: unknown[]): Promise<GitOutcome> => {
      const line = commandOf(m.args)
      fail.calls.push(line)
      const rule = fail.rules.find((r) => r.times > 0 && r.match(line))
      if (!rule) return (real.runGit as (...a: unknown[]) => Promise<GitOutcome>)(m, ...rest)
      rule.times--
      // A command that did its work and then said it failed (a partial add): run first, then fail.
      if (rule.after) {
        await (real.runGit as (...a: unknown[]) => Promise<GitOutcome>)(m, ...rest)
        await rule.after()
      }
      const none = new Uint8Array()
      return rule.native
        ? { stdout: none, stderr: none, error: { code: rule.native, killed: false, signal: null }, cwdExists: true }
        : { stdout: none, stderr: Buffer.from(rule.err), error: { code: rule.code, killed: false, signal: null }, cwdExists: true }
    }
  }
})

const BUSY = "fatal: Unable to create 'index.lock': File exists."
/** `native`: the process didn't run to an exit (Node's code, e.g. EAGAIN), as a loaded machine can say. */
const failing = (match: string | RegExp, times = 1, more: { code?: number; err?: string; native?: string; after?: () => Promise<void> } = {}): void => {
  fail.rules.push({ match: (l) => (typeof match === 'string' ? l.includes(match) : match.test(l)), times, err: more.err ?? BUSY, code: more.code ?? 128, ...(more.native ? { native: more.native } : {}), ...(more.after ? { after: more.after } : {}) })
}
const callsOf = (match: string): number => fail.calls.filter((l) => l.includes(match)).length

let env: Env | null = null
beforeEach(() => {
  fail.rules.length = 0
  fail.calls.length = 0
})
afterEach(() => {
  env?.close()
  env = null
})

/** Hive merges, one merge check; the target checked out in the project folder (`checkedOut`) or nowhere. */
function project(o: Partial<WorkflowOptions> = {}, checkedOut = true): Env {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: ['quick'], commands: { quick: 'quick' }, okBefore: { mode: 'never', labels: [] }, ...o }))
  if (!checkedOut) sh(e.project, 'checkout', '-q', '--detach')
  return e
}

async function queued(e: Env, title = 'Change') {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/c.txt': `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  // Only the queue's calls are counted (the card's slot was made with a worktree add of its own).
  fail.calls.length = 0
  return card
}

const red: Partial<QueueConfig> = { runCheck: async () => ({ ok: false, output: 'red: the check failed' }) }
const count = (e: Env, card: number, kind: string): number => e.store.facts(card).filter((f) => f.kind === kind).length

/** The reads before anything is touched, each as the queue asks git (the target checked out: the journal's too). */
const BEFORE_TOUCH: [string, string, boolean][] = [
  ['the identity (user.name)', 'config user.name', false],
  ['the identity (user.email)', 'config user.email', false],
  ["the queue worktree's listing", 'worktree list --porcelain', false],
  ["the queue worktree's add", 'worktree add --detach', false],
  ["the test merge's head", 'rev-parse --verify -q HEAD', false],
  ["the checked-out folder's staged files", 'diff --cached --name-only', true],
  ["the merge's files", 'diff --name-only -z --no-renames', true],
  ["the checked-out folder's status", 'status --porcelain -z --untracked-files=all --no-renames', true]
]

/** How a read fails: git's own exit, with what it said; or a git that didn't run to an exit (HR2's round 2: Node's EAGAIN). */
const KINDS: [string, { native?: string }][] = [
  ['git exiting 128', {}],
  ['git not running to an exit (EAGAIN)', { native: 'EAGAIN' }]
]

describe('a read that fails once before anything is touched: the entry goes round again (HI-2019)', () => {
  for (const [how, more] of KINDS)
    for (const [what, match, advanceOnly] of BEFORE_TOUCH) {
      if (!advanceOnly)
        it(`${what}, ${how}, the check red: returned, nothing paused`, async () => {
          const e = project()
          const card = await queued(e)
          failing(match, 1, more)
          expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'returned', reason: 'checks' }])
          expect(e.store.queuePause('main')).toBeNull()
          expect(e.wf.state(card).stage).toBe('active')
          expect(count(e, card.id, 'CheckRan')).toBe(1)
        })
      it(`${what}, ${how}, the check green: merged once, nothing paused`, async () => {
        const e = project()
        const card = await queued(e)
        failing(match, 1, more)
        expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
        expect(e.store.queuePause('main')).toBeNull()
        expect(e.wf.state(card).stage).toBe('done')
        expect(count(e, card.id, 'IntegrationStarted')).toBe(1)
        expect(count(e, card.id, 'Integrated')).toBe(1)
        expect(fail.rules.every((r) => r.times === 0)).toBe(true)
      })
    }

  it('the target checked out nowhere: its listing under the lock failing once, merged once', async () => {
    const e = project({}, false)
    const card = await queued(e)
    // The third listing is the advance's, under the lock (the first is the queue worktree's, the second the look before it).
    let seen = 0
    fail.rules.push({ match: (l) => l === 'worktree list --porcelain' && ++seen === 3, times: 1, err: BUSY, code: 128 })
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.store.queuePause('main')).toBeNull()
    expect(count(e, card.id, 'Integrated')).toBe(1)
  })

  it('strict (G8): the update in the queue worktree, its identity read failing once: merged', async () => {
    const e = project({ strict: true })
    const card = await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile') // the card is behind main: brought up to date
    failing('config user.name')
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.kinds(card.id)).toContain('Updated')
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('Rebase and fast-forward: its reads (merge commits in the suffix, on top) failing once: merged', async () => {
    const e = project({ style: 'rebase' })
    const card = await queued(e)
    commit(e.project, { 'other.txt': 'meanwhile\n' }, 'meanwhile')
    failing('rev-list --min-parents=2')
    failing('merge-base --is-ancestor')
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.store.queuePause('main')).toBeNull()
  })
})

describe('a read that keeps failing pauses needsYou with what git said, after the budget', () => {
  it("the identity: read 1 + READ_RETRIES times, paused needsYou with git's words, never identity; the card stays queued", async () => {
    const e = project()
    const card = await queued(e)
    failing('config user.name', Infinity, { err: 'fatal: bad config line 1 in file .git/config' })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'needsYou', message: 'fatal: bad config line 1 in file .git/config' }])
    expect(callsOf('config user.name')).toBe(1 + READ_RETRIES)
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'needsYou', message: 'fatal: bad config line 1 in file .git/config' })
    expect(e.wf.state(card).stage).toBe('merging')
    expect(count(e, card.id, 'CheckRan')).toBe(0)
  })

  it("the test merge's head, git never running to an exit (EAGAIN): paused needsYou, saying so", async () => {
    const e = project()
    await queued(e)
    failing('rev-parse --verify -q HEAD', Infinity, { native: 'EAGAIN' })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'needsYou', message: "git rev-parse didn't run to an exit (EAGAIN)" }])
  })

  it('the identity, git never running to an exit (EAGAIN): needsYou, never identity', async () => {
    const e = project()
    await queued(e)
    failing('config user.name', Infinity, { native: 'EAGAIN' })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'needsYou', message: "git config didn't run to an exit (EAGAIN)" }])
    expect(callsOf('config user.name')).toBe(1 + READ_RETRIES)
  })

  it('the identity read failing once is read again (not the failed answer kept): 2 reads, returned', async () => {
    const e = project()
    await queued(e)
    failing('config user.name')
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'returned' }])
    expect(callsOf('config user.name')).toBe(2)
  })
})

describe('what needs the user still pauses at once, with no retry', () => {
  const retried = (): Partial<QueueConfig> & { tries: () => number } => {
    let n = 0
    return { hooks: { beforeRetry: () => void n++ }, tries: () => n }
  }

  it("an identity that isn't set: paused identity after one read", async () => {
    const e = project()
    const card = await queued(e)
    sh(e.project, 'config', '--unset', 'user.name')
    const r = retried()
    expect(await e.queue({ ...red, hooks: r.hooks }).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'identity', files: [e.project] }])
    expect(callsOf('config user.name')).toBe(1)
    expect(r.tries()).toBe(0)
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('something staged in the checked-out target: paused staged at once', async () => {
    const e = project()
    await queued(e)
    writeFileSync(join(e.project, 'staged.txt'), 'staged\n')
    sh(e.project, 'add', 'staged.txt')
    const r = retried()
    expect(await e.queue({ hooks: r.hooks }).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'staged' }])
    expect(r.tries()).toBe(0)
  })
})

describe("the queue's worktree: reused only when git lists it, never removed", () => {
  const folder = (e: Env): string => join(e.home, 'queue')

  it('an add that made the worktree and then failed: the next pass finds it listed and reuses it', async () => {
    const e = project()
    await queued(e)
    failing('worktree add --detach', 1, { after: async () => undefined })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'returned' }])
    expect(callsOf('worktree add --detach')).toBe(1)
    expect(sh(e.project, 'worktree', 'list', '--porcelain')).toContain('queue')
  })

  it('an empty folder git doesn\'t list: added there', async () => {
    const e = project()
    await queued(e)
    mkdirSync(folder(e), { recursive: true })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'returned' }])
    expect(existsSync(join(folder(e), '.git'))).toBe(true)
  })

  it("a folder with files that git doesn't list: left as it is, paused naming it", async () => {
    const e = project()
    const card = await queued(e)
    mkdirSync(folder(e), { recursive: true })
    writeFileSync(join(folder(e), 'mine.txt'), 'the user\'s\n')
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'needsYou', files: [folder(e)] }])
    expect(readFileSync(join(folder(e), 'mine.txt'), 'utf8')).toBe("the user's\n")
    expect(callsOf('worktree add')).toBe(0)
    expect(callsOf('checkout --detach -f')).toBe(0)
    expect(e.wf.state(card).stage).toBe('merging')
  })
})

describe('admitted afresh after the wait, before any new merge or check', () => {
  /** A read that fails once at `match`, and `meanwhile` done while the queue waits to go round. */
  async function waitWith(e: Env, match: string, meanwhile: (card: string) => Promise<void> | void, cfg: Partial<QueueConfig> = {}) {
    const card = await queued(e)
    failing(match)
    const checks = () => count(e, card.id, 'CheckRan')
    let before = -1
    const out = await e
      .queue({
        ...cfg,
        hooks: {
          beforeRetry: async () => {
            before = checks()
            await meanwhile(card.key)
          }
        }
      })
      .drain('main')
    // Nothing more was merged or checked after the wait.
    expect(checks()).toBe(before)
    expect(count(e, card.id, 'IntegrationStarted')).toBe(0)
    return { card, out }
  }
  // Red: a read before the checks (the identity); green: a read after them, in the advance's conditions.
  const cases: [string, string, Partial<QueueConfig>][] = [
    ['red', 'config user.name', red],
    ['green', 'diff --cached --name-only', {}]
  ]

  for (const [path, match, cfg] of cases) {
    it(`${path}: the user's Pause queue made meanwhile stands, untouched; the entry waits, open`, async () => {
      const e = project()
      const { card, out } = await waitWith(e, match, async () => void (await e.wf.locked(() => e.store.setQueuePause('main', { reason: 'user', card: '', by: 'user' }))), cfg)
      expect(out).toMatchObject([{ outcome: 'paused', reason: 'user' }])
      expect(e.store.queuePause('main')).toMatchObject({ reason: 'user', by: 'user' })
      expect(e.wf.state(card).stage).toBe('merging')
    })

    it(`${path}: a decision made meanwhile takes the entry out (its passes needed again)`, async () => {
      const e = project()
      const { card, out } = await waitWith(e, match, async (key) => void (await e.wf.recordDecision(key, 'Rename it first.')), cfg)
      expect(out).toMatchObject([{ outcome: 'skipped' }])
      expect(e.wf.state(card).stage).not.toBe('merging')
    })

    it(`${path}: removed from the queue meanwhile: its cancellation stands`, async () => {
      const e = project()
      const { out } = await waitWith(e, match, async (key) => void (await e.wf.removeFromQueue(key, 'later')), cfg)
      expect(out).toMatchObject([{ outcome: 'skipped', why: 'cancelled' }])
    })

    it(`${path}: the rules turned off meanwhile: paused rulesOff, nothing more run`, async () => {
      const e = project()
      let on = true
      const { out } = await waitWith(e, match, () => void (on = false), { ...cfg, enforced: () => on })
      expect(out).toMatchObject([{ outcome: 'paused', reason: 'rulesOff' }])
    })

    it(`${path}: the lease lost meanwhile (another Hive took it, or this workspace closed): stops, writing nothing`, async () => {
      const e = project()
      let holds = true
      const card = await queued(e)
      failing(match)
      const facts = () => e.store.facts(card.id).length
      let before = -1
      const out = await e
        .queue({
          ...cfg,
          holds: () => holds,
          hooks: {
            beforeRetry: () => {
              before = facts()
              holds = false
            }
          }
        })
        .drain('main')
      expect(out).toEqual([])
      expect(facts()).toBe(before)
      expect(e.store.queuePause('main')).toBeNull()
    })
  }
})

describe('after the advance: only the branch is read again', () => {
  for (const [how, more] of KINDS)
    it(`the folder's branch unreadable once just after the swap (${how}): Done, merged and Integrated once, nothing paused`, async () => {
      const e = project()
      const card = await queued(e)
      let swapped = false
      fail.rules.push({ match: (l) => (l.startsWith('update-ref refs/heads/main') && (swapped = true), false), times: 1, err: '', code: 0 })
      fail.rules.push({ match: (l) => swapped && l.startsWith('symbolic-ref'), times: 1, err: BUSY, code: 128, ...more })
      expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
      expect(e.wf.state(card).stage).toBe('done')
      expect(count(e, card.id, 'IntegrationStarted')).toBe(1)
      expect(count(e, card.id, 'Integrated')).toBe(1)
      expect(e.store.queuePause('main')).toBeNull()
      // Hive's merge commit, once (the card's own commit isn't a merge).
      expect(sh(e.project, 'log', '--merges', '--format=%s', 'main').split('\n').filter((s) => s.startsWith(`${card.key}:`))).toHaveLength(1)
    })

  it('the lease lost while the branch is read again: nothing more written after the swap', async () => {
    const e = project()
    const card = await queued(e)
    let swapped = false
    let holds = true
    fail.rules.push({ match: (l) => (l.startsWith('update-ref refs/heads/main') && (swapped = true), false), times: 1, err: '', code: 0 })
    fail.rules.push({ match: (l) => swapped && l.startsWith('symbolic-ref') && ((holds = false), true), times: 1, err: BUSY, code: 128 })
    expect(await e.queue({ holds: () => holds }).drain('main')).toEqual([])
    expect(count(e, card.id, 'Integrated')).toBe(0)
    expect(e.store.queuePause('main')).toBeNull()
  })
})

describe("a git that didn't run to an exit is never git's answer (HR2's round 2: src/main/git's normalisation)", () => {
  it("git(): ok false, code -1 (never 1, git's \"no\"), notRun naming why, said when git said nothing; git not taken for missing", async () => {
    const e = project()
    failing('rev-parse --verify -q HEAD', 1, { native: 'EAGAIN' })
    const r = await git(e.project, ['rev-parse', '--verify', '-q', 'HEAD'])
    expect(r).toMatchObject({ ok: false, code: -1, notRun: 'EAGAIN', err: "git rev-parse didn't run to an exit (EAGAIN)" })
    expect(r.missing).toBeUndefined()
    expect(gitTool().state).not.toBe('missing')
    // git's own exit 1 is still git's answer, as it was.
    const own = await git(e.project, ['config', 'hi2019.unset'])
    expect(own).toMatchObject({ ok: false, code: 1 })
    expect(own.notRun).toBeUndefined()
  })

  it("the identity: unknown when git didn't run to an exit, null only when git says a key isn't set", async () => {
    const e = project()
    failing('config user.name', 1, { native: 'EAGAIN' })
    const failed = await G.identity(e.project)
    expect(isUnknown(failed) && failed.detail).toBe("git config didn't run to an exit (EAGAIN)")
    expect(await G.identity(e.project)).toEqual({ name: expect.any(String), email: expect.any(String) })
    sh(e.project, 'config', '--unset', 'user.email')
    expect(await G.identity(e.project)).toBeNull()
  })

  it("the folder's branch: unknown when git didn't run to an exit, null only for a detached HEAD", async () => {
    const e = project()
    failing('symbolic-ref', 1, { native: 'EAGAIN' })
    expect(isUnknown(await G.branch(e.project))).toBe(true)
    expect(await G.branch(e.project)).toBe('main')
    sh(e.project, 'checkout', '-q', '--detach')
    expect(await G.branch(e.project)).toBeNull()
  })

  it("an ancestry read: a git that didn't run is neither yes (0) nor no (1)", async () => {
    const e = project()
    const head = sh(e.project, 'rev-parse', 'HEAD')
    failing('merge-base --is-ancestor', 1, { native: 'EAGAIN' })
    expect((await git(e.project, ['merge-base', '--is-ancestor', head, head])).code).toBe(-1)
    expect((await git(e.project, ['merge-base', '--is-ancestor', head, head])).code).toBe(0)
  })
})
