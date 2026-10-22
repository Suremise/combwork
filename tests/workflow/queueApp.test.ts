// The merge queue's core as the app runs it (#1348, SPEC §16.9.1, §16.9.3): recovery per target, the compare-and-swap
// advance under the repository lock with the lease checked inside it, a target checked out in a folder paused until
// #1351, workflow rules turned off while an entry runs, and the card's ruleset over the project's options now.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (): Env => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' } }))

/** A card approved and queued for a target: started by B1, committed, submitted, passed by R1. */
async function queued(e: Env, title = 'Change', target?: string, file = 'src/c.txt') {
  const card = e.wf.createCard({ title, ...(target ? { target } : {}) })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return { card }
}

/** The target checked out nowhere (the project folder detached), as #1348's advance needs. */
const detach = (e: Env): void => void sh(e.project, 'checkout', '-q', '--detach')
const head = (e: Env, ref = 'main'): string => sh(e.project, 'rev-parse', ref)

describe('the merge queue in the app (#1348)', () => {
  it('a target checked out nowhere: merged by compare-and-swap under the repository lock, its git through the config', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const locked: string[] = []
    const gits: string[] = []
    const [o] = await e
      .queue({
        lock: async (fn) => {
          locked.push('in')
          try {
            return await fn()
          } finally {
            locked.push('out')
          }
        },
        git: async (cwd, args) => {
          gits.push(args.join(' '))
          const { git } = await import('../../src/main/git')
          return git(cwd, args)
        }
      })
      .drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).stage).toBe('done')
    expect(locked).toEqual(['in', 'out'])
    // The test merge and the advance's swap went through the queue's git.
    expect(gits.some((g) => / merge --no-ff /.test(` ${g} `))).toBe(true)
    expect(gits.some((g) => g.startsWith('update-ref refs/heads/main '))).toBe(true)
  })

  it('the lease lost inside the lock, after IntegrationStarted: no swap; the next runner recovers it (rerun) and merges', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const before = head(e)
    let holds = true
    const q = e.queue({ holds: () => holds, lock: (fn) => fn(), hooks: { afterStarted: () => void (holds = false) } })
    expect(await q.drain('main')).toEqual([])
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).toContain('IntegrationStarted')
    // Another runner (the lease is its): recovery finds the target at the expected revision and runs it again.
    const next = e.queue({ holds: () => true })
    expect(await next.recover('main')).toMatchObject([{ outcome: 'rerun' }])
    expect(await next.drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(e.wf.state(card).stage).toBe('done')
  })

  it('recovery per target: each host recovers only its own target\'s entries', async () => {
    const e = team()
    detach(e)
    sh(e.project, 'branch', 'release', 'main')
    const a = await queued(e, 'For main', undefined, 'src/a.txt')
    const b = await queued(e, 'For release', 'release', 'src/b.txt')
    // Both advances begin and Hive crashes before either target moves.
    const crash = { afterStarted: () => Promise.reject(new Error('crash')) }
    await expect(e.queue({ hooks: crash }).drain('main')).rejects.toThrow('crash')
    await expect(e.queue({ hooks: crash }).drain('release')).rejects.toThrow('crash')
    const main = e.queue()
    const out = await main.recover('main')
    expect(out).toEqual([{ card: a.card.key, entry: expect.any(String), outcome: 'rerun' }])
    // The release entry is still begun, untouched, for its own host.
    const release = e.queue()
    expect(await release.recover('release')).toEqual([{ card: b.card.key, entry: expect.any(String), outcome: 'rerun' }])
  })

  it('a target checked out in a folder pauses checkedOut (until #1351), naming the folder; nothing is touched', async () => {
    const e = team()
    const { card } = await queued(e)
    const before = head(e)
    const [o] = await e.queue({ pauseCheckedOut: true }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'checkedOut' })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'checkedOut', files: [expect.stringContaining('project')] })
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it('the target checked out while the queue waited for the repository lock: paused checkedOut, nothing advanced or touched', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const before = head(e)
    const q = e.queue({
      pauseCheckedOut: true,
      lock: (fn) => {
        sh(e.project, 'checkout', '-q', 'main')
        return fn()
      }
    })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'paused', reason: 'checkedOut' }])
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('workflow rules turned off while the queue waited for the repository lock: no IntegrationStarted, paused rulesOff', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const before = head(e)
    let enforced = true
    const q = e.queue({
      enforced: () => enforced,
      lock: (fn) => {
        enforced = false
        return fn()
      }
    })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'paused', reason: 'rulesOff' }])
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
  })

  it('workflow rules turned off during the checks: no advance (paused rulesOff); on again, it carries on from the test merge', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const before = head(e)
    let enforced = true
    const q = e.queue({ enforced: () => enforced, hooks: { afterChecks: () => void (enforced = false) } })
    expect(await q.drain('main')).toMatchObject([{ outcome: 'paused', reason: 'rulesOff' }])
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationStarted')
    enforced = true
    q.resume('main')
    expect(await e.queue({ enforced: () => enforced }).drain('main')).toMatchObject([{ outcome: 'integrated' }])
  })

  it('workflow rules turned off just after IntegrationStarted: the advance finishes, Integrated written (data safety)', async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    let enforced = true
    const [o] = await e.queue({ enforced: () => enforced, hooks: { afterStarted: () => void (enforced = false) } }).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.kinds(card.id)).toContain('Integrated')
  })

  it("the card's ruleset decides: the project's options moved to the agent merge during the checks, and the queue still merges it", async () => {
    const e = team()
    detach(e)
    const { card } = await queued(e)
    const [o] = await e.queue({ hooks: { afterChecks: () => void (e.options.finish = 'agentMerges') } }).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.wf.state(card).stage).toBe('done')
  })
})
