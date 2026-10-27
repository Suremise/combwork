// The watcher's reads in git's worker (HI-1814; HR1's round 1): a check waiting for the reads under way waits only for
// those asked for before it, never for refreshes that keep coming meanwhile, in its repository or another. Here the
// worker's reads are held until the test lets each go, so the order is the test's, not the machine's.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRepoRefs, type RepoRefs } from '../src/main/platform/repoRefs'
import { tempDir } from './tempDir'

// Each read asked of the worker, held until let go.
const held = vi.hoisted(() => ({ reads: [] as { common: string; go: () => void }[] }))
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  const readRefsOffMain = (common: string, max: number): Promise<RepoRefs> => new Promise((done) => held.reads.push({ common, go: () => done(readRepoRefs(common, max)) }))
  return { ...real, readRefsOffMain }
})

const { Observer } = await import('../src/main/platform/observe')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

// The run's allowlisted environment and test git config for every git child (never this process's environment).
const { gitEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv() }).trim()

/** A repository on main with one commit. */
function repo(): string {
  const p = tempDir('hive-observe-reads-')
  run(p, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  run(p, 'add', '-A')
  run(p, 'commit', '-q', '-m', 'one')
  return p
}

describe("the watcher's reads in git's worker", () => {
  let o: InstanceType<typeof Observer>
  afterEach(() => {
    o.dispose()
    for (const r of held.reads.splice(0)) r.go()
  })

  it('a check waits only for the reads owed when it began, however many refreshes follow, in its repository or another', async () => {
    const p = repo()
    const q = repo()
    o = new Observer()
    // Attached: each repository's first read is at once, on main (no worker read).
    o.follow([
      { path: p, platform: 'git', root: p },
      { path: q, platform: 'git', root: q }
    ])
    expect(held.reads).toHaveLength(0)
    expect(o.size).toEqual({ repos: 2, folders: 2 })
    // A refresh: one read of each, held in the worker.
    o.rescan()
    expect(held.reads).toHaveLength(2)
    let settled = false
    const waiting = o.settled(p).then(() => void (settled = true))
    // Refreshes keep coming, in both repositories, each time a read is let go: what the check owed is in after the
    // first round, and it goes on while the next reads are still held.
    for (let round = 0; round < 6; round++) {
      const now = held.reads.splice(0)
      expect(now.length, `round ${round}: one read of each repository at a time`).toBe(2)
      o.rescan()
      for (const r of now) r.go()
      await vi.waitFor(() => expect(held.reads.length).toBe(2), { timeout: HUNG_MS })
      if (round === 0) await vi.waitFor(() => expect(settled).toBe(true), { timeout: HUNG_MS })
    }
    await waiting
    // The reads still held keep a later check waiting only until they are in.
    let later = false
    const after = o.settled(q).then(() => void (later = true))
    expect(later).toBe(false)
    for (const r of held.reads.splice(0)) r.go()
    await after
    expect(later).toBe(true)
  })

  it('a check waiting on a read under way goes on once the watch closes', async () => {
    const p = repo()
    o = new Observer()
    o.follow([{ path: p, platform: 'git', root: p }])
    o.rescan()
    expect(held.reads).toHaveLength(1)
    const waiting = o.settled(p)
    o.follow([])
    await waiting
  })
})
