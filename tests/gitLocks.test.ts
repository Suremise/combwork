// Combwork's background git calls never write the index (#212): `git status` (the Changes tab, branch status) and `git diff`
// against the working tree refresh it as a side effect, taking index.lock, so a user's or agent's own `git add` or
// `commit` at that moment failed with "index.lock: File exists". Real git, in throwaway repositories.
import { execFileSync } from 'child_process'
import { rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { GIT_PREFIX, git, gitStatus } from '../src/main/git'
import { tempDir } from './tempDir'

const base = tempDir('hive-gitlocks-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0

// A read by git in the instant the user's commit writes the branch, or their add replaces the index, can see the branch
// with no commits yet, the branch broken (its ref read while the commit replaces it, #519) or the index not open (#381).
// Such a read is repeated once the write has landed (each try waits for the next), and is not a failure: the user's own
// add and commit are what must never fail, and they are still counted.
const RACING = /does not have any commits yet|current branch appears to be broken|index file open failed/
async function landed(call: () => Promise<unknown>): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      if (!RACING.test(String(e)) || attempt >= 1000) throw e
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

/** A repository with a.txt…g.txt committed on main; `run` is git there as the user's own commands would be. */
function repo(): { dir: string; run: (...a: string[]) => string; index: string } {
  const dir = join(base, `r${++n}`)
  const run = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) writeFileSync(join(dir, `${f}.txt`), `${f}\n`)
  run('add', '-A')
  run('commit', '-qm', 'base')
  return { dir, run, index: join(dir, '.git', 'index') }
}

/** Makes every file look possibly changed to git (newer than the index), content unchanged: what makes it refresh. */
function staleIndex(dir: string, index: string, files: string[]): number {
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(index, old, old)
  const now = new Date()
  for (const f of files) utimesSync(join(dir, f), now, now)
  return statSync(index).mtimeMs
}

describe("Combwork's git calls and the index (#212)", () => {
  it('every git call turns optional locks and diff index refreshes off', () => {
    expect(GIT_PREFIX).toEqual(expect.arrayContaining(['--no-optional-locks', 'diff.autoRefreshIndex=false']))
    expect(GIT_PREFIX[0]).toBe('--no-optional-locks')
  })

  it("the Changes tab's status leaves the index as it is, and a file touched without changing isn't listed", async () => {
    const { dir, index } = repo()
    writeFileSync(join(dir, 'c.txt'), 'changed\n')
    const before = staleIndex(dir, index, ['a.txt', 'b.txt'])
    const s = await gitStatus(dir)
    expect(s.files.map((f) => `${f.status} ${f.path}`)).toEqual(['M c.txt'])
    expect(statSync(index).mtimeMs).toBe(before)
    // A diff against the working tree, as a worktree's branch status counts it: the same.
    const stat = await git(dir, ['diff', '--shortstat', 'HEAD'])
    expect(stat.out).toMatch(/^ 1 file changed/)
    expect(statSync(index).mtimeMs).toBe(before)
  })

  it("a worktree branch's changes since it left base: real ones only, stat-only ones dropped, without writing the index", async () => {
    const { dir, run, index } = repo()
    run('checkout', '-qb', 'agent')
    // Committed on the branch: b (then left), d (then changed back by hand), e (then changed again), f (then changed
    // back and staged), g (then changed back with only its mode changed, staged: a real change).
    for (const f of ['b', 'd', 'e', 'f', 'g']) writeFileSync(join(dir, `${f}.txt`), `${f}2\n`)
    run('commit', '-qam', 'work')
    writeFileSync(join(dir, 'd.txt'), 'd\n')
    writeFileSync(join(dir, 'e.txt'), 'e3\n')
    writeFileSync(join(dir, 'f.txt'), 'f\n')
    writeFileSync(join(dir, 'g.txt'), 'g\n')
    run('add', 'f.txt', 'g.txt')
    run('update-index', '--chmod=+x', 'g.txt')
    writeFileSync(join(dir, 'c.txt'), 'c2\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    const before = staleIndex(dir, index, ['a.txt', 'b.txt', 'f.txt', 'g.txt'])
    const s = await gitStatus(dir, 'main')
    // a (touched only) and f (the same as at base, content and mode) are not changes. d's working copy is the base's
    // again but differs from its index: kept, never hidden (its diff shows no difference).
    expect(s.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['? new.txt', 'M b.txt', 'M c.txt', 'M d.txt', 'M e.txt', 'M g.txt'])
    expect(statSync(index).mtimeMs).toBe(before)
    // As git itself reports it (a command of the user's, which may refresh the index: after the check above).
    expect(run('diff', '--summary', 'main')).toContain('mode change 100644 => 100755 g.txt')
  })

  it("the user's git add and commit never meet index.lock while Combwork refreshes", async () => {
    const { dir, run } = repo()
    run('checkout', '-qb', 'agent')
    const running = { on: true }
    // Independent loops, as the Changes tab, branch status and a worktree's counts refresh on their own.
    const loop = async (call: () => Promise<unknown>) => {
      let k = 0
      while (running.on) {
        await landed(call)
        k++
      }
      return k
    }
    // Each one's failure is caught as it happens (no unhandled rejection), and reported with the others at the end.
    const refreshers = [() => gitStatus(dir), () => gitStatus(dir, 'main'), () => git(dir, ['diff', '--shortstat', 'main']), () => gitStatus(dir)].map((call) =>
      loop(call).then(
        (k) => ({ k, error: null as string | null }),
        (e) => ({ k: 0, error: String(e) })
      )
    )
    const failures: string[] = []
    const until = Date.now() + 3000
    const touch = (f: string) => {
      const now = new Date(Date.now() + 1000)
      utimesSync(join(dir, f), now, now)
    }
    let results: Awaited<(typeof refreshers)[number]>[] = []
    try {
      for (let i = 0; Date.now() < until; i++) {
        writeFileSync(join(dir, 'a.txt'), `a${i}\n`)
        try {
          run('add', '-A')
          run('commit', '-qm', `c${i}`)
        } catch (e) {
          failures.push(String((e as { stderr?: string }).stderr ?? e).slice(0, 200))
        }
        // Touched, not changed: what makes a refresh write the index, until the next add.
        touch('b.txt')
        touch('c.txt')
        await new Promise((r) => setTimeout(r, 5))
      }
    } finally {
      // The refreshers stop and finish however this ends, a write here throwing too, so none is left running git in the
      // folder afterAll removes (#519). They never reject (each failure is caught above), so the writer's error stays.
      running.on = false
      results = await Promise.all(refreshers)
    }
    expect(results.map((r) => r.error).filter(Boolean)).toEqual([])
    for (const r of results) expect(r.k).toBeGreaterThan(0)
    expect(failures).toEqual([])
  }, 20000)
})
