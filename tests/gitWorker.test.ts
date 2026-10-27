// Git's worker (HI-1783): Hive's git commands start their processes in a thread of their own, so a process start (about
// 4 ms of the calling thread on Windows) never holds main's thread. Here: git() through the built worker gives exactly
// what it gives in-process (as it ran before), for an answer, git's own failure, input, output small and large, an
// environment, a time limit, a folder that isn't there and output over its bound; and many commands at once each get
// their own answer.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, useGitWorker, type GitResult } from '../src/main/git'
import { tempDir } from './tempDir'

const tmp = tempDir('hive-git-worker-')
const bundle = join(tmp, 'git-worker.cjs')
const repo = join(tmp, 'repo')

beforeAll(async () => {
  await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'gitWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  execFileSync('git', ['init', '-q', repo], { windowsHide: true })
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { windowsHide: true })
  // A file of a megabyte, for output far over Node's pool (moved, not copied).
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(1024 * 1024))
}, 60_000)
afterAll(() => useGitWorker(null))

/** What a result says, its bytes included. */
const said = (r: GitResult): unknown => ({ ...r, buf: r.buf.toString('base64') })

/** The commands, each as git() is called. */
const commands: [string, Parameters<typeof git>][] = [
  ['an answer', [repo, ['rev-parse', '--verify', 'HEAD']]],
  ["git's own failure (its exit code and message)", [repo, ['rev-parse', '--verify', 'no-such-ref']]],
  ['input on stdin', [repo, ['hash-object', '--stdin'], undefined, 'some content\n']],
  ['a megabyte of output', [repo, ['hash-object', '--no-filters', '-w', 'big.txt']]],
  ['an environment', [repo, ['var', 'GIT_AUTHOR_IDENT'], undefined, undefined, { env: { ...process.env, GIT_AUTHOR_NAME: 'Worker Test', GIT_AUTHOR_EMAIL: 'w@example.com', GIT_AUTHOR_DATE: '2026-10-27T00:00:00Z' } }]],
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
    const want = inputs.map((t) => execFileSync('git', ['-C', repo, 'hash-object', '--stdin'], { input: t, windowsHide: true }).toString().trim())
    const got = await Promise.all(inputs.map((t) => git(repo, ['hash-object', '--stdin'], undefined, t)))
    expect(got.map((r) => r.out.trim())).toEqual(want)
  })
})
