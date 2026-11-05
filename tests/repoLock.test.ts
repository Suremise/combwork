// The repository lock across processes (#1347, SPEC §16.9.3): the real core (repoLockCore.ts) in plain Node children,
// bundled with esbuild, so two processes contend for one repository's lock as two Hives would. Each child takes the
// lock, writes what happened to its own file (waiting, held, timedout, released) and holds until told to release.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openLockDb } from '../src/main/db'
import { REPO_LOCK_FILE, repoLockHolder, takeRepoLock } from '../src/main/repoLockCore'
import { tempDir } from './tempDir'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const tmp = tempDir('hive-repo-lock-')
const bundle = join(tmp, 'child.cjs')
const CHILD = `
const { appendFileSync, existsSync } = require('fs')
const { takeRepoLock } = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'repoLockCore.ts'))})
const [dir, out, barrier, waitMs, profile] = process.argv.slice(2)
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 20)) }
;(async () => {
  if (barrier !== '-') await until(() => existsSync(barrier))
  const r = await takeRepoLock(dir, { profile, waitMs: Number(waitMs), pollMs: 25, onWait: (h) => appendFileSync(out, 'waiting ' + h.profile + '\\n') })
  if ('timedOut' in r) return appendFileSync(out, 'timedout ' + r.timedOut.profile + '\\n')
  appendFileSync(out, 'held ' + r.held.token + '\\n')
  await until(() => existsSync(out + '.release'))
  r.held.release()
  appendFileSync(out, 'released\\n')
})()
`

beforeAll(async () => {
  const entry = join(tmp, 'child-entry.cjs')
  writeFileSync(entry, CHILD)
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
}, 60_000)
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
})

let n = 0
/** A repository's common git dir stand-in: the lock only needs a folder. */
const repoDir = (): string => tempDir(`hive-repo-lock-${++n}-`)

/** A child taking the lock in dir; `lines()` is what it wrote, `release()` lets it go. */
function contender(dir: string, profile: string, opts: { barrier?: string; waitMs?: number } = {}) {
  const out = join(tmp, `${profile}-${++n}.txt`)
  writeFileSync(out, '')
  const child = spawn(process.execPath, [bundle, dir, out, opts.barrier ?? '-', String(opts.waitMs ?? 60_000), profile], { env: ctx.baseEnv(), stdio: 'ignore', windowsHide: true })
  children.push(child)
  const lines = (): string[] => readFileSync(out, 'utf8').split('\n').filter(Boolean)
  return {
    child,
    lines,
    has: (word: string): boolean => lines().some((l) => l.startsWith(word)),
    token: (): string | undefined => lines().find((l) => l.startsWith('held '))?.slice(5),
    release: (): void => writeFileSync(`${out}.release`, ''),
    exited: (): Promise<void> => (child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', () => r())))
  }
}

const WAIT = { timeout: 30_000, interval: 25 }

describe('the repository lock across processes (#1347)', () => {
  it('two processes take it in turn: the second waits, naming the first, until it is released', async () => {
    const dir = repoDir()
    const a = contender(dir, 'Combwork-A')
    await vi.waitFor(() => expect(a.has('held')).toBe(true), WAIT)
    const b = contender(dir, 'Combwork-B')
    await vi.waitFor(() => expect(b.lines()).toContain('waiting Combwork-A'), WAIT)
    expect(b.has('held')).toBe(false)
    a.release()
    await vi.waitFor(() => expect(b.has('held')).toBe(true), WAIT)
    expect(repoLockHolder(dir)).toMatchObject({ token: b.token(), profile: 'Combwork-B', pid: b.child.pid })
    b.release()
    await b.exited()
    expect(repoLockHolder(dir)).toBeNull()
  })

  it("a dead holder's row is taken over", async () => {
    const dir = repoDir()
    const a = contender(dir, 'Combwork-A')
    await vi.waitFor(() => expect(a.has('held')).toBe(true), WAIT)
    a.child.kill()
    await a.exited()
    expect(repoLockHolder(dir)?.pid).toBe(a.child.pid)
    const got = await takeRepoLock(dir, { profile: 'me', waitMs: 10_000 })
    expect('held' in got).toBe(true)
    expect(repoLockHolder(dir)).toMatchObject({ pid: process.pid, profile: 'me' })
    if ('held' in got) got.held.release()
  })

  it('a reused pid (the holder running with another start time) counts as dead', async () => {
    const dir = repoDir()
    const a = contender(dir, 'Combwork-A')
    await vi.waitFor(() => expect(a.has('held')).toBe(true), WAIT)
    // Its pid runs, but the row says it started at another time: the process that took it is gone.
    const db = openLockDb(join(dir, REPO_LOCK_FILE), 1000, 'SELECT 1')
    db.prepare('UPDATE repo_lock SET process_start = 1').run()
    db.close()
    const got = await takeRepoLock(dir, { profile: 'me', waitMs: 10_000 })
    expect('held' in got).toBe(true)
    expect(repoLockHolder(dir)?.pid).toBe(process.pid)
    if ('held' in got) got.held.release()
  })

  it("two contenders started together on one dead holder's row: exactly one holds it, the other waits", async () => {
    const dir = repoDir()
    const dead = contender(dir, 'Combwork-Dead')
    await vi.waitFor(() => expect(dead.has('held')).toBe(true), WAIT)
    dead.child.kill()
    await dead.exited()
    const barrier = join(tmp, `barrier-${++n}`)
    const b = contender(dir, 'Combwork-B', { barrier })
    const c = contender(dir, 'Combwork-C', { barrier })
    writeFileSync(barrier, '')
    // Both have looked: one holds, the other waits for it (never for the dead holder).
    await vi.waitFor(() => expect([b, c].filter((x) => x.has('held')).length + [b, c].filter((x) => x.has('waiting')).length).toBe(2), WAIT)
    const [holder, waiter] = b.has('held') ? [b, c] : [c, b]
    expect(waiter.has('held')).toBe(false)
    expect(waiter.lines()[0]).toBe(`waiting ${holder === b ? 'Combwork-B' : 'Combwork-C'}`)
    expect(repoLockHolder(dir)?.token).toBe(holder.token())
    holder.release()
    await vi.waitFor(() => expect(waiter.has('held')).toBe(true), WAIT)
    waiter.release()
    await waiter.exited()
  })

  it("a holder's pid reused while another waits is seen as dead; a live holder judged again stays the holder's (HR6's round 1)", async () => {
    const dir = repoDir()
    repoLockHolder(dir)
    const db = openLockDb(join(dir, REPO_LOCK_FILE), 1000, 'SELECT 1')
    db.prepare("INSERT INTO repo_lock (id, token, pid, process_start, profile, taken_at) VALUES (1, 'old', 99999, 22, 'Combwork-Old', '')").run()
    db.close()
    // Pid 99999 runs throughout; the process behind it changes (start 22, then 33) once the waiter has judged it live.
    let start = 22
    const asked: number[] = []
    const procs = { alive: () => true, startOf: async (pid: number) => (pid === 99999 ? (asked.push(start), start) : 1) }
    const kept = await takeRepoLock(dir, { profile: 'me', waitMs: 200, pollMs: 10, recheckMs: 0, procs })
    expect(kept).toMatchObject({ timedOut: { profile: 'Combwork-Old' } })
    expect(asked.length).toBeGreaterThan(1)
    const got = await takeRepoLock(dir, { profile: 'me', waitMs: 30_000, pollMs: 10, recheckMs: 0, procs, onWait: () => (start = 33) })
    expect('held' in got).toBe(true)
    expect(repoLockHolder(dir)).toMatchObject({ pid: process.pid, profile: 'me' })
    if ('held' in got) got.held.release()
  })

  it("a late release by a holder whose row was replaced removes nothing of the new holder's", async () => {
    const dir = repoDir()
    const got = await takeRepoLock(dir, { profile: 'me', waitMs: 10_000 })
    if (!('held' in got)) throw new Error('not held')
    // Taken over meanwhile (as a Combwork that judged this one dead would): another token in the row.
    const db = openLockDb(join(dir, REPO_LOCK_FILE), 1000, 'SELECT 1')
    db.prepare("UPDATE repo_lock SET token = 'successor', profile = 'Combwork-Next'").run()
    db.close()
    got.held.release()
    expect(repoLockHolder(dir)).toMatchObject({ token: 'successor', profile: 'Combwork-Next' })
  })

  it('a live holder that stalls past the wait keeps the lock; the waiter gets who holds it', async () => {
    const dir = repoDir()
    const a = contender(dir, 'Combwork-A')
    await vi.waitFor(() => expect(a.has('held')).toBe(true), WAIT)
    const told: string[] = []
    const got = await takeRepoLock(dir, { profile: 'me', waitMs: 300, pollMs: 25, onWait: (h) => told.push(h.profile) })
    expect(got).toMatchObject({ timedOut: { profile: 'Combwork-A', pid: a.child.pid } })
    expect(told).toEqual(['Combwork-A'])
    expect(repoLockHolder(dir)?.token).toBe(a.token())
    a.release()
    await a.exited()
    expect(existsSync(join(dir, REPO_LOCK_FILE))).toBe(true)
    expect(repoLockHolder(dir)).toBeNull()
  })
})
