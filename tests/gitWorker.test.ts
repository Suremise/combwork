// Git's worker (HI-1783): Combwork's git commands start their processes in a thread of their own, so a process start (about
// 4 ms of the calling thread on Windows) never holds main's thread. Here: git() through the built worker gives exactly
// what it gives in-process (as it ran before), for an answer, git's own failure, input, output small and large, an
// environment, a time limit, a folder that isn't there and output over its bound; and many commands at once each get
// their own answer. The observer's read of a repository's refs (HI-1814) is the same through it as in this thread.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { git, readRefsOffMain, useGitWorker, type GitResult } from '../src/main/git'
import { runGit } from '../src/main/gitWorker'
import { readRepoRefs } from '../src/main/platform/repoRefs'
import { tempDir } from './tempDir'

// The longest a test here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 30_000

// The run's allowlisted environment and test git config for every git child, as the suites' git has (never this
// process's environment).
const { gitEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const tmp = tempDir('cw-git-worker-')
const bundle = join(tmp, 'git-worker.cjs')
const repo = join(tmp, 'repo')

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'gitWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  execFileSync('git', ['init', '-q', repo], { windowsHide: true, env: gitEnv() })
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { windowsHide: true, env: gitEnv() })
  // A file of a megabyte, for output far over Node's pool (moved, not copied).
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(1024 * 1024))
}, 60_000)
afterAll(() => useGitWorker(null))

/**
 * A git command that leaves a process of the test's own holding its output open after git exits, as a process main
 * starts meanwhile can (an agent's terminal, HI-1854): an alias whose shell starts it in the background and says
 * `started`. It writes its pid, and ends when the test asks (a stop file) or, should the test run die, after its own
 * bound. Ended when the test finishes, passed, failed or timed out, and waited for until it has gone.
 */
function holding(): { args: string[]; running: () => boolean } {
  const dir = tempDir('cw-git-holder-')
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  const script = join(dir, 'holder.cjs')
  writeFileSync(script, `const fs = require('fs'), path = require('path'), dir = process.argv[2]
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid))
const bound = Date.now() + ${HUNG_MS * 4}
setInterval(() => { if (fs.existsSync(path.join(dir, 'stop')) || Date.now() > bound) process.exit(0) }, 50)
`)
  const pid = (): number | null => (existsSync(join(dir, 'pid')) ? Number(readFileSync(join(dir, 'pid'), 'utf8')) : null)
  const alive = (p: number): boolean => {
    try {
      process.kill(p, 0)
      return true
    } catch {
      return false
    }
  }
  const args = ['-c', `alias.hold=!"${fwd(process.execPath)}" "${fwd(script)}" "${fwd(dir)}" & echo started`, 'hold']
  let asked = false
  onTestFinished(async () => {
    writeFileSync(join(dir, 'stop'), '')
    // Once its command was given out, its holder starts (it writes its pid first) and is gone before the next test.
    if (!asked) return
    const p = await vi.waitFor(
      () => {
        const n = pid()
        if (n === null) throw new Error('its holder has not started')
        return n
      },
      { timeout: HUNG_MS }
    )
    await vi.waitFor(() => expect(alive(p)).toBe(false), { timeout: HUNG_MS })
  })
  return {
    get args() {
      asked = true
      return args
    },
    running: () => {
      const p = pid()
      return p !== null && alive(p)
    }
  }
}

/** What a result says, its bytes included. */
const said = (r: GitResult): unknown => ({ ...r, buf: r.buf.toString('base64') })

/** The commands, each as git() is called. */
const commands: [string, Parameters<typeof git>][] = [
  ['an answer', [repo, ['rev-parse', '--verify', 'HEAD']]],
  ["git's own failure (its exit code and message)", [repo, ['rev-parse', '--verify', 'no-such-ref']]],
  ['input on stdin', [repo, ['hash-object', '--stdin'], undefined, 'some content\n']],
  ['a megabyte of output', [repo, ['hash-object', '--no-filters', '-w', 'big.txt']]],
  ['an environment', [repo, ['var', 'GIT_AUTHOR_IDENT'], undefined, undefined, { env: gitEnv({ GIT_AUTHOR_NAME: 'Worker Test', GIT_AUTHOR_EMAIL: 'w@example.com', GIT_AUTHOR_DATE: '2026-10-27T00:00:00Z' }) }]],
  ['a folder that is not there', [join(tmp, 'not-there'), ['status']]],
  ['output over its bound', [repo, ['cat-file', '-p', 'HEAD'], 8]]
]

describe("git's worker (HI-1783)", () => {
  it('gives exactly what git() gives in this thread, for each kind of command', async () => {
    useGitWorker(join(tmp, 'none.cjs'))
    const here = []
    for (const [, args] of commands) here.push(said(await git(...args)))
    useGitWorker(bundle)
    for (const [i, [what, args]] of commands.entries()) expect(said(await git(...args)), what).toEqual(here[i])
    // The big file's blob read back whole through the worker.
    const sha = (await git(repo, ['hash-object', '-w', 'big.txt'])).out.trim()
    expect((await git(repo, ['cat-file', '-p', sha])).out.length).toBe(1024 * 1024)
  })

  it('stops a command at its time limit and says so', async () => {
    useGitWorker(bundle)
    // hash-object --stdin with no input waits on its stdin, which is left open.
    const r = await git(repo, ['hash-object', '--stdin'], undefined, undefined, { timeout: 300 })
    expect(r).toMatchObject({ ok: false, timedOut: true })
  })

  it('answers many commands at once, each with its own', async () => {
    useGitWorker(bundle)
    const inputs = Array.from({ length: 30 }, (_, i) => `content ${i}\n`)
    const want = inputs.map((t) => execFileSync('git', ['-C', repo, 'hash-object', '--stdin'], { input: t, windowsHide: true, env: gitEnv() }).toString().trim())
    const got = await Promise.all(inputs.map((t) => git(repo, ['hash-object', '--stdin'], undefined, t)))
    expect(got.map((r) => r.out.trim())).toEqual(want)
  })

  it('answers a command that has exited though another process holds its output open (HI-1854)', async () => {
    // Git exited, its output's pipes still open: held by the test's own process, which inherited them.
    const first = holding()
    const r = await runGit({ cwd: repo, args: first.args, maxBuffer: 1024 * 1024, env: gitEnv() }, 100)
    expect({ out: Buffer.from(r.stdout).toString().trim(), error: r.error, held: r.held }).toEqual({ out: 'started', error: null, held: true })
    // Answered while the holder still runs: not by its ending.
    await vi.waitFor(() => expect(first.running()).toBe(true), { timeout: HUNG_MS })
    // And through the worker, at its own quiet time.
    useGitWorker(bundle)
    const second = holding()
    expect(await git(repo, second.args, undefined, undefined, { env: gitEnv() })).toMatchObject({ ok: true, out: 'started\n' })
    await vi.waitFor(() => expect(second.running()).toBe(true), { timeout: HUNG_MS })
  }, HUNG_MS)

  it("reads a repository's lines, folders, HEADs and reflogs as this thread does (HI-1814)", async () => {
    const r = tempDir('cw-git-worker-refs-')
    const g = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { windowsHide: true, env: gitEnv() })
    g(r, 'init', '-q', '-b', 'main')
    g(r, 'commit', '-q', '--allow-empty', '-m', 'first')
    g(r, 'branch', 'cw/HI/one')
    g(r, 'branch', 'packed')
    g(r, 'pack-refs', '--all')
    g(r, 'commit', '-q', '--allow-empty', '-m', 'second')
    g(r, 'worktree', 'add', '-q', '-b', 'side', join(tempDir('cw-git-worker-wt-'), 'wt'))
    const common = join(r, '.git')
    const here = readRepoRefs(common, 64)
    expect([...here.lines.keys()].sort()).toEqual(['cw/HI/one', 'main', 'packed', 'side'])
    expect(here.folders).toHaveLength(2)
    useGitWorker(bundle)
    expect(await readRefsOffMain(common, 64)).toEqual(here)
    expect((await readRefsOffMain(common, 1)).folders).toHaveLength(1)
  })
})
