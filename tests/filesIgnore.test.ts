// The Files tab's dimmed (git-ignored) entries when git check-ignore fails (#222): another git command rewriting the
// index (a user's `git add`, an agent's commit) can make it exit 128 ("index file open failed"), which used to read as
// "nothing ignored" and showed dist/ undimmed. A busy index is tried again; if git still can't say, the folder keeps
// what was last known and is listed again shortly. Real git for everything but the failures, which a stub injects.
import { execFile, execFileSync } from 'child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult } from '../src/main/git'
import { tempDir } from './tempDir'
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
/** The stress test's listings and adds, each at least (#1480), and its bound past its time for a hung run. */
const ENOUGH = 30
const STRESS_HUNG_MS = 120000

/** check-ignore results to give instead of running it, in order; empty: run it. */
const failNext: Partial<GitResult>[] = []
let checkIgnoreCalls = 0
/** Real check-ignores that failed (neither 0 nor 1), for the stress test's report. */
let realFailures = 0
/** Real check-ignores of dist/ that git answered (0 or 1) without naming it: what git said, for the stress test's report. */
const unnamed: Partial<GitResult>[] = []
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number): Promise<GitResult> => {
      if (args[0] !== 'check-ignore') return real.git(cwd, args, max)
      checkIgnoreCalls++
      const f = failNext.shift()
      if (f) return { out: '', ok: false, buf: Buffer.alloc(0), err: '', code: 128, ...f }
      const r = await real.git(cwd, args, max)
      if (r.code !== 0 && r.code !== 1) realFailures++
      else if (args.includes('dist/') && !/\tdist\/?$/m.test(r.out)) unnamed.push({ code: r.code, ok: r.ok, out: r.out.slice(0, 200), err: r.err.slice(0, 300) })
      return r
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const files = await import('../src/main/files')
// Git's check-ignore tries, with Git's Files reads (HI-2792).
const { IGNORE_TRIES } = await import('../src/main/platform/gitFiles')
const { onCombworkEvent } = await import('../src/main/events')

const BUSY = { err: 'fatal: .git/index: index file open failed: Permission denied' }
const base = tempDir('cw-ignore-')
const ws = join(base, 'ws')
const proj = join(ws, 'proj')
mkdirSync(join(proj, 'dist'), { recursive: true })
mkdirSync(join(proj, 'src'), { recursive: true })
writeFileSync(join(proj, '.gitignore'), 'dist/\n')
writeFileSync(join(proj, 'dist', 'out.js'), '')
writeFileSync(join(proj, 'src', 'a.ts'), '')
execFileSync('git', ['init', '-q', proj])
const w = createWorkspaceService()
w.path = ws
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})
beforeEach(() => {
  failNext.length = 0
  checkIgnoreCalls = 0
})

const dimmed = async (rel = '') => (await files.listDir(proj, rel)).filter((f) => f.ignored).map((f) => f.name)
const relists = () => {
  const seen: string[][] = []
  const off = onCombworkEvent((e) => e.type === 'files-changed' && seen.push(e.dirs))
  return { seen, off }
}

describe('Files tab: a failed git check-ignore (#222)', () => {
  it('a busy index is tried again: exit 128 then success shows dist dimmed', async () => {
    failNext.push(BUSY)
    expect(await dimmed()).toEqual(['dist'])
    expect(checkIgnoreCalls).toBe(2)
  })

  it('still failing: the folder keeps its last known state and is listed again shortly, a few times at most', async () => {
    const r = relists()
    expect(await dimmed()).toEqual(['dist'])
    for (let i = 0; i < IGNORE_TRIES; i++) failNext.push(BUSY)
    expect(await dimmed()).toEqual(['dist'])
    expect(checkIgnoreCalls).toBe(1 + IGNORE_TRIES)
    await vi.waitFor(() => expect(r.seen).toEqual([['']]), { timeout: HUNG_MS })
    // Failing on every re-list: at most RELIST_MAX of them in a row.
    for (let k = 0; k < files.RELIST_MAX + 2; k++) {
      for (let i = 0; i < IGNORE_TRIES; i++) failNext.push(BUSY)
      await dimmed()
      await new Promise((res) => setTimeout(res, 700))
    }
    expect(r.seen.length).toBe(files.RELIST_MAX)
    // Working again: back to normal, and a later failure is listed again once more.
    expect(await dimmed()).toEqual(['dist'])
    for (let i = 0; i < IGNORE_TRIES; i++) failNext.push(BUSY)
    await dimmed()
    await vi.waitFor(() => expect(r.seen.length).toBe(files.RELIST_MAX + 1), { timeout: HUNG_MS })
    r.off()
  })

  it('a folder never listed before shows nothing dimmed while git fails, and is listed again', async () => {
    const r = relists()
    failNext.push({ err: 'fatal: something else went wrong' })
    expect(await dimmed('src')).toEqual([])
    // Not a busy index: not tried again.
    expect(checkIgnoreCalls).toBe(1)
    await vi.waitFor(() => expect(r.seen).toEqual([['src']]), { timeout: HUNG_MS })
    r.off()
  })

  it('outside a repository nothing is ignored: no retry, no re-list', async () => {
    const r = relists()
    failNext.push({ err: 'fatal: not a git repository (or any of the parent directories): .git' })
    expect(await dimmed('src')).toEqual([])
    expect(checkIgnoreCalls).toBe(1)
    await new Promise((res) => setTimeout(res, 700))
    expect(r.seen).toEqual([])
    r.off()
  })

  it("under load from the user's git add, a listing never shows dist undimmed", async () => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: proj })
    expect(await dimmed()).toEqual(['dist'])
    realFailures = 0
    const running = { on: true }
    let adds = 0
    // The user's (or an agent's) git add rewriting the index, three at once; their own clashes don't matter here.
    const writer = async () => {
      while (running.on) {
        const t = new Date(Date.now() - Math.floor(Math.random() * 1e7))
        utimesSync(join(proj, 'src', 'a.ts'), t, t)
        await new Promise((res) => execFile('git', ['add', 'src/a.ts'], { cwd: proj, windowsHide: true }, res))
        adds++
      }
    }
    const undimmed: number[] = []
    let listings = 0
    const reader = async () => {
      while (running.on) {
        if (!(await dimmed()).includes('dist')) undimmed.push(listings)
        listings++
      }
    }
    // At least the stress's time (CW_STRESS_MS, 4 s), and on until enough listings ran beside enough adds, however
    // long load makes that (#1480: a fixed 4 s did 13 listings in a loaded full run, failing a count, not the behaviour).
    const loops = [writer(), writer(), writer(), reader(), reader(), reader()]
    const began = Date.now()
    const atLeastMs = Number(process.env.CW_STRESS_MS) || 4000
    try {
      await vi.waitFor(() => expect({ listings: listings >= ENOUGH, adds: adds >= ENOUGH, time: Date.now() - began >= atLeastMs }).toEqual({ listings: true, adds: true, time: true }), { timeout: atLeastMs + STRESS_HUNG_MS, interval: 50 })
    } finally {
      running.on = false
      await Promise.all(loops)
    }
    console.log(`#222 stress: ${listings} listings, ${adds} adds in ${Date.now() - began} ms, ${realFailures} check-ignore failures absorbed`)
    // Once under four unit suites at once (#560), never since: if it comes back, what git answered says whether it's git
    // or Combwork (#222's handling).
    expect(undimmed, `listings showing dist undimmed; git's answers without it: ${JSON.stringify(unnamed.slice(0, 5))}`).toEqual([])
  }, 600000)
})
