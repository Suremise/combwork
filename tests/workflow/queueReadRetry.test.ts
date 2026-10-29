// HI-2019: a git read that fails for a moment (a lock held, git not starting on a loaded machine) before the merge queue
// has touched anything sends the entry round again, admitted afresh first (still approved, no pause saved meanwhile, the
// rules on, the lease held), within READ_RETRIES; only a read that keeps failing pauses, needsYou with git's own words. A
// commit identity git couldn't read is never taken for one that isn't set. The queue's worktree is reused only when git
// lists it, and nothing of it is ever removed. After the advance, only the folder's branch is read again: nothing is
// redone. git is wrapped by command here (src/main/git's git(): the queue's reads and the platform's), deterministically:
// no load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { READ_RETRIES, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import type { GitResult } from '../../src/main/git'

/** The git calls to fail: the first whose command matches, `times` times (Infinity: always); each call's command. */
const fail = vi.hoisted(() => ({ rules: [] as { match: (args: string) => boolean; times: number; err: string; code: number; after?: () => Promise<void> }[], calls: [] as string[] }))
vi.mock('../../src/main/git', async (orig) => {
  const real = (await orig()) as typeof import('../../src/main/git')
  return {
    ...real,
    git: async (cwd: string, args: string[], ...rest: unknown[]): Promise<GitResult> => {
      const line = args.join(' ')
      fail.calls.push(line)
      const rule = fail.rules.find((r) => r.times > 0 && r.match(line))
      if (rule) {
        rule.times--
        // A command that did its work and then said it failed (a partial add): run first, then fail.
        if (rule.after) {
          await (real.git as (...a: unknown[]) => Promise<GitResult>)(cwd, args, ...rest)
          await rule.after()
        }
        return { out: '', ok: false, buf: Buffer.alloc(0), err: rule.err, code: rule.code }
      }
      return (real.git as (...a: unknown[]) => Promise<GitResult>)(cwd, args, ...rest)
    }
  }
})

const BUSY = "fatal: Unable to create 'index.lock': File exists."
const failing = (match: string | RegExp, times = 1, more: { code?: number; err?: string; after?: () => Promise<void> } = {}): void => {
  fail.rules.push({ match: (l) => (typeof match === 'string' ? l.includes(match) : match.test(l)), times, err: more.err ?? BUSY, code: more.code ?? 128, ...(more.after ? { after: more.after } : {}) })
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

describe('a read that fails once before anything is touched: the entry goes round again (HI-2019)', () => {
  for (const [what, match, advanceOnly] of BEFORE_TOUCH) {
    if (!advanceOnly)
      it(`${what}, the check red: returned, nothing paused`, async () => {
        const e = project()
        const card = await queued(e)
        failing(match)
        expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'returned', reason: 'checks' }])
        expect(e.store.queuePause('main')).toBeNull()
        expect(e.wf.state(card).stage).toBe('active')
        expect(count(e, card.id, 'CheckRan')).toBe(1)
      })
    it(`${what}, the check green: merged once, nothing paused`, async () => {
      const e = project()
      const card = await queued(e)
      failing(match)
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

  it("the test merge's head (git not starting): paused needsYou with git's words", async () => {
    const e = project()
    await queued(e)
    failing('rev-parse --verify -q HEAD', Infinity, { code: -1, err: 'spawn git EAGAIN' })
    expect(await e.queue(red).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'needsYou', message: 'spawn git EAGAIN' }])
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
  it("the folder's branch unreadable once just after the swap: Done, merged and Integrated once, nothing paused", async () => {
    const e = project()
    const card = await queued(e)
    let swapped = false
    fail.rules.push({ match: (l) => (l.startsWith('update-ref refs/heads/main') && (swapped = true), false), times: 1, err: '', code: 0 })
    fail.rules.push({ match: (l) => swapped && l.startsWith('symbolic-ref'), times: 1, err: BUSY, code: 128 })
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
