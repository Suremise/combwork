// The repository lock's worker (HI-1680): withRepoLock's takes and releases run in a thread of their own, so a take
// held up in SQLite (its busy wait, a commit's fsyncs) doesn't hold main's thread, and with it the keystrokes typed into
// a pane. The lock is the same row by the same rules (repoLock.test.ts tests those across processes): here, that the
// worker takes and releases it, keeps main's event loop running while it waits, and that a lock whose worker ended is
// released by its token by the next one.
import { execFileSync } from 'child_process'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_LOCK_FILE, repoLockHolder } from '../src/main/repoLockCore'
import type { LockReply, LockRequest } from '../src/main/repoLockWorker'
import { useLockWorker, withRepoLock } from '../src/main/repoLock'
import { tempDir } from './tempDir'

const tmp = tempDir('hive-repo-lock-worker-')
const bundle = join(tmp, 'repo-lock-worker.cjs')

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'repoLockWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  useLockWorker(bundle)
}, 60_000)
afterAll(() => useLockWorker(null))

let n = 0
/** A repository of its own, and its common git dir (where the lock's file is). */
function repo(): { folder: string; dir: string } {
  const folder = tempDir(`hive-repo-lock-worker-${++n}-`)
  execFileSync('git', ['init', '-q', folder], { windowsHide: true })
  return { folder, dir: join(folder, '.git') }
}

describe("the repository lock's worker (HI-1680)", () => {
  it('takes the lock in its thread, naming this process as the holder, and releases it after', async () => {
    const { folder, dir } = repo()
    const during = await withRepoLock(folder, async () => repoLockHolder(dir))
    expect(during?.pid).toBe(process.pid)
    expect(repoLockHolder(dir)).toBeNull()
  })

  it("keeps main's event loop running while a take waits in SQLite's busy wait", async () => {
    const { folder, dir } = repo()
    // Another connection holds the lock file's write lock: the take's BEGIN IMMEDIATE waits in SQLite (its busy
    // timeout, a second) and then fails. On main's thread that wait blocked everything; in the worker, main runs on.
    await withRepoLock(folder, async () => undefined) // the file and its table made
    const other = new DatabaseSync(join(dir, REPO_LOCK_FILE))
    other.exec('BEGIN IMMEDIATE')
    // Main's longest gap between ticks of a timer, the one still open as the take settles included (a blocked loop
    // fires nothing until it ends).
    let last = performance.now()
    let gap = 0
    const tick = setInterval(() => {
      const now = performance.now()
      gap = Math.max(gap, now - last)
      last = now
    }, 5)
    try {
      await expect(withRepoLock(folder, async () => 'ran')).rejects.toThrow(/locked|busy/i)
    } finally {
      clearInterval(tick)
      gap = Math.max(gap, performance.now() - last)
      other.exec('ROLLBACK')
      other.close()
    }
    // Well under the busy wait's second: on main's thread the gap is the whole wait (1155 ms, against 19 ms here).
    expect(gap).toBeLessThan(700)
    expect(await withRepoLock(folder, async () => 'ran')).toBe('ran')
  }, 60_000)

  it('a lock held by a worker that ended is released by its token by the next worker', async () => {
    const { dir } = repo()
    const ask = (w: Worker, m: LockRequest): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const on = (r: LockReply): void => {
          if (!('id' in r) || r.id !== m.id || 'waiting' in r) return
          w.off('message', on)
          if (r.ok) resolve(r.value)
          else reject(new Error(r.error))
        }
        w.on('message', on)
        w.postMessage(m)
      })
    const first = new Worker(bundle)
    const got = (await ask(first, { id: 1, type: 'take', dir, profile: 'test', waitMs: 10_000, noticeAfterMs: 1000 })) as { token: string }
    await first.terminate()
    // Its row stays this process's (a live holder to other Hives) until the release by its token.
    expect(repoLockHolder(dir)?.token).toBe(got.token)
    const second = new Worker(bundle)
    try {
      await ask(second, { id: 1, type: 'release', dir, token: got.token })
      expect(repoLockHolder(dir)).toBeNull()
    } finally {
      await second.terminate()
    }
  }, 60_000)
})
