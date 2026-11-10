// jj's runner and read-only detection against the real jj Combwork is tested with (HI-2793's J0): the portable official
// build of resources/tested-vcs.json's version, fetched and checked by `npm run jj:fetch` into the test area, never
// system-wide. Every repository is a throwaway one from tempDir(), with jj's and git's config isolated (a dummy identity,
// no global config, no remote). The cases: the version, a missing tool, colocated and non-colocated repositories,
// linked workspaces (one store), nested roots, the output cap and cancellation, and that detection never writes (the
// .jj folder and the operation log unchanged, a raw edit never snapshotted, two operation heads never merged).
//
// Without the fetched jj this file is skipped, saying so; with CW_JJ_REAL=1 (a release's checks) its absence fails.
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner, type JjRunner } from '../src/main/platform/jjRunner'
import { jjContextOf, type JjContext, type JjDetection } from '../src/main/platform/jjDetect'
import { gitRepoPorts } from '../src/main/platform/gitRepoPorts'
import { sameStore } from '../src/main/platform/repoContext'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }
type Identity = { pid: number; started: number }
const { identify, stillSame, endExactly } = require('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Identity[]; stillSame: (ids: Identity[]) => number[]; endExactly: (ids: Identity[]) => number }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** jj's home and config for this file: a dummy identity, no pager, nothing of the user's. */
function isolated(): NodeJS.ProcessEnv {
  const home = tempDir('jj-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  return gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
}

const real = (p: string): string => resolve(realpathSync.native(p))
const same = (a: string, b: string): void => expect(resolve(a).toLowerCase()).toBe(resolve(b).toLowerCase())
const ctxOf = (d: JjDetection): JjContext => {
  if (!('jj' in d)) throw new Error(`not a jj repository: ${JSON.stringify(d)}`)
  return d.jj
}

/** Every file under a folder, with its size and content hash: what a read must leave exactly as it was. */
function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const s = statSync(p)
      if (s.isDirectory()) walk(p)
      else h.update(`${p}\0${s.size}\0`).update(readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

describe.skipIf(!exe)(`the real jj (${TESTED_JJ.version})`, () => {
  const env = isolated()
  const jj = (cwd: string, ...args: string[]): string => execFileSync(exe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  const runner: JjRunner = createJjRunner({ exe: exe!, env })
  const opId = (root: string): string => jj(root, '--ignore-working-copy', 'op', 'log', '--no-graph', '--limit', '1', '-T', 'id').trim()
  const make = (name: string, ...init: string[]): string => {
    const d = join(tempDir(`jj-${name}-`), 'repo')
    mkdirSync(d)
    jj(d, 'git', 'init', ...init)
    writeFileSync(join(d, 'base.txt'), 'base\n')
    jj(d, 'commit', '-m', 'base')
    return real(d)
  }

  it('is the pinned version, and the runner says it is ready, not untested', async () => {
    expect(jj(process.cwd(), '--version')).toMatch(new RegExp(`^jj ${TESTED_JJ.version.replace(/\./g, '\\.')}\\b`))
    expect(await runner.readiness()).toEqual({ state: 'ok', version: TESTED_JJ.version, path: exe })
  })

  it('a colocated repository: one Git store, the .git beside .jj, detected without writing', async () => {
    const root = make('colocated', '--colocate')
    const before = { tree: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')), op: opId(root) }
    const c = ctxOf(await jjContextOf(root, runner))
    same(c.root, root)
    same(c.store, real(join(root, '.git')))
    same(c.jjRepo, real(join(root, '.jj', 'repo')))
    same(c.workspace, real(join(root, '.jj')))
    expect(c).toMatchObject({ colocated: true, linked: false, tool: { state: 'ok', version: TESTED_JJ.version } })
    expect(c.subfolder).toBeUndefined()
    expect(c.nestedGit).toBeUndefined()
    expect({ tree: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')), op: opId(root) }).toEqual(before)
    // The same store, so the same repository lock, as Git's own context of the folder (R1.1: one store, one lock).
    const g = await gitRepoPorts.contextOf(root)
    expect(g && sameStore(g, c)).toBe(true)
  })

  it('a colocated repository with Git changes jj has not imported: detection imports nothing (refs, config, index, op log)', async () => {
    const root = make('colocated-moved', '--colocate')
    writeFileSync(join(root, 'plain.txt'), 'by plain git\n')
    git(root, 'add', 'plain.txt')
    git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'plain git commit')
    git(root, 'branch', 'made-by-git')
    const before = { jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')), op: opId(root) }
    ctxOf(await jjContextOf(root, runner))
    await runner.run(root, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
    expect({ jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')), op: opId(root) }).toEqual(before)
  })

  it('a stale linked workspace with a local edit: detected without updating it, snapshotting it or touching the shared repository', async () => {
    const root = make('stale', '--no-colocate')
    const other = join(resolve(root, '..'), 'stale-ws')
    jj(root, 'workspace', 'add', other, '--name', 'stale')
    // Rewrite the other workspace's working-copy commit onto a new tree from here: it is stale there.
    writeFileSync(join(root, 'dest.txt'), 'destination\n')
    jj(root, 'commit', '-m', 'destination')
    jj(root, 'rebase', '-r', 'stale@', '-d', '@-')
    writeFileSync(join(other, 'local.txt'), 'unsnapshotted local edit\n')
    const before = { ws: treeHash(join(other, '.jj')), repo: treeHash(join(root, '.jj')), op: opId(root) }
    const c = ctxOf(await jjContextOf(other, runner))
    same(c.root, real(other))
    expect(c.linked).toBe(true)
    expect({ ws: treeHash(join(other, '.jj')), repo: treeHash(join(root, '.jj')), op: opId(root) }).toEqual(before)
    expect(readFileSync(join(other, 'local.txt'), 'utf8')).toBe('unsnapshotted local edit\n')
  })

  it('a non-colocated Git-backed repository: its store inside .jj, not colocated', async () => {
    const root = make('native', '--no-colocate')
    expect(existsSync(join(root, '.git'))).toBe(false)
    const c = ctxOf(await jjContextOf(root, runner))
    same(c.store, real(join(root, '.jj', 'repo', 'store', 'git')))
    expect(c).toMatchObject({ colocated: false, linked: false })
  })

  it("linked workspaces share one store and one repository, each with its own workspace (jj workspace add)", async () => {
    const root = make('linked', '--no-colocate')
    const other = join(resolve(root, '..'), 'agent-b')
    jj(root, 'workspace', 'add', other, '--name', 'b')
    const a = ctxOf(await jjContextOf(root, runner))
    const b = ctxOf(await jjContextOf(other, runner))
    same(b.store, a.store)
    expect(sameStore(a, b)).toBe(true)
    same(b.jjRepo, a.jjRepo)
    same(b.root, real(other))
    expect(b.workspace.toLowerCase()).not.toBe(a.workspace.toLowerCase())
    expect(b).toMatchObject({ linked: true, colocated: false })
    // From a colocated repository, jj makes the workspace's Git worktree too: the same store, seen by Git.
    const co = make('linked-co', '--colocate')
    const coOther = join(resolve(co, '..'), 'agent-c')
    jj(co, 'workspace', 'add', coOther, '--name', 'c')
    const c = ctxOf(await jjContextOf(coOther, runner))
    same(c.store, real(join(co, '.git')))
    // Git's context of the jj-made workspace names the same store (its worktree's common dir), so one lock for both.
    const g = existsSync(join(coOther, '.git')) ? await gitRepoPorts.contextOf(coOther) : null
    if (g) expect(sameStore(g, c)).toBe(true)
    expect(c.linked).toBe(true)
    expect(c.colocated).toBe(existsSync(join(coOther, '.git')))
  })

  it('nested roots: a subfolder, a jj repository inside a Git one, a Git repository inside a jj workspace, and none', async () => {
    const root = make('nested', '--no-colocate')
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    const sub = ctxOf(await jjContextOf(join(root, 'src', 'deep'), runner))
    same(sub.root, root)
    expect(sub.subfolder).toBe(true)
    same(sub.folder, real(join(root, 'src', 'deep')))
    // A jj repository inside a Git repository's folder: the nearer one, jj's, holds it.
    const outer = tempDir('jj-outer-git-')
    git(outer, 'init', '-q')
    const inner = join(outer, 'inner')
    mkdirSync(inner)
    jj(inner, 'git', 'init', '--no-colocate')
    const i = ctxOf(await jjContextOf(inner, runner))
    same(i.root, real(inner))
    expect(i.nestedGit).toBeUndefined()
    // A Git repository inside a jj workspace: jj's workspace is still found, with the nearer Git root named.
    const g = join(root, 'vendored')
    mkdirSync(g)
    git(g, 'init', '-q')
    const n = ctxOf(await jjContextOf(g, runner))
    same(n.root, root)
    same(n.nestedGit!, g)
    // No .jj at or above: none, with no process.
    const plain = tempDir('jj-none-')
    expect(await jjContextOf(plain, runner)).toEqual({ none: true })
  })

  it('a missing jj is unknown, never a guess from its files', async () => {
    const root = make('missing', '--no-colocate')
    const none = createJjRunner({ env: { ...env, PATH: tempDir('jj-empty-path-') } })
    expect(await none.readiness()).toEqual({ state: 'missing' })
    expect(await jjContextOf(root, none)).toMatchObject({ unknown: 'tool', tool: { state: 'missing' } })
  })

  it("a damaged .jj is unknown: its repository pointer gone, or naming nowhere", async () => {
    const root = make('damaged', '--no-colocate')
    const other = join(resolve(root, '..'), 'ws')
    jj(root, 'workspace', 'add', other, '--name', 'ws')
    writeFileSync(join(other, '.jj', 'repo'), join(root, 'nowhere'))
    expect(await jjContextOf(other, runner)).toMatchObject({ unknown: 'repoGone' })
  })

  it('a read never snapshots: a raw edit leaves the operation log and .jj as they were', async () => {
    const root = make('snapshot', '--no-colocate')
    const before = { tree: treeHash(join(root, '.jj')), op: opId(root) }
    writeFileSync(join(root, 'raw.txt'), 'not snapshotted\n')
    ctxOf(await jjContextOf(root, runner))
    await runner.run(root, ['log', '-r', '@', '--no-graph', '-T', 'commit_id'])
    expect({ tree: treeHash(join(root, '.jj')), op: opId(root) }).toEqual(before)
  })

  it('two operation heads: detection is unknown and merges nothing (.jj, op heads and Git exactly as they were); one head again, it reads pinned (HI-2831)', async () => {
    const root = make('two-heads', '--colocate')
    const headsDir = join(root, '.jj', 'repo', 'op_heads', 'heads')
    const [op] = readdirSync(headsDir)
    // Two commands that started from the same operation: two heads, as two agents or an external jj leave them.
    jj(root, '--ignore-working-copy', 'describe', '-r', '@-', '-m', 'h1')
    jj(root, '--at-op', op, '--ignore-working-copy', 'describe', '-r', '@-', '-m', 'h2')
    const heads = readdirSync(headsDir).sort()
    expect(heads).toHaveLength(2)
    const before = { jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')) }
    expect(await jjContextOf(root, runner)).toMatchObject({ unknown: 'opHeads', detail: '2' })
    expect(readdirSync(headsDir).sort()).toEqual(heads)
    expect({ jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')) }).toEqual(before)
    // The premise: an unpinned read that loads the repository merges them (a new single head), which detection never runs.
    jj(root, '--ignore-working-copy', 'git', 'root')
    const merged = readdirSync(headsDir)
    expect(merged).toHaveLength(1)
    expect(heads).not.toContain(merged[0])
    // One head: detected, its reads pinned to it, and .jj still exactly as it was.
    const settled = { jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')) }
    ctxOf(await jjContextOf(root, runner))
    expect(readdirSync(headsDir)).toEqual(merged)
    expect({ jj: treeHash(join(root, '.jj')), git: treeHash(join(root, '.git')) }).toEqual(settled)
  })

  it("caps a real jj's output: ended, not an answer", async () => {
    const root = make('cap', '--no-colocate')
    const r = await runner.run(root, ['help', 'log'], { maxOutput: 64 })
    expect(r).toMatchObject({ ok: false, code: -1, notRun: 'maxOutput' })
    expect(r.buf.length).toBeLessThanOrEqual(64)
    // A detection whose reads hit the cap is unknown.
    expect(await jjContextOf(root, runner, { maxOutput: 4 })).toMatchObject({ unknown: 'notRun' })
  })

  it('cancels a real jj under way: jj ended, the result cancelled; detection cancelled is unknown', async () => {
    const root = make('cancel', '--no-colocate')
    const probe = tempDir('jj-cancel-probe-')
    const said = join(probe, 'pids.json')
    // jj util exec keeps jj running while its command runs: the command says its pid and jj's (its parent), then waits.
    const script = `require('fs').writeFileSync(${JSON.stringify(said)}, JSON.stringify({ pid: process.pid, jj: process.ppid })); setTimeout(() => {}, 60000)`
    const ac = new AbortController()
    const running = runner.run(root, ['util', 'exec', '--', process.execPath, '-e', script], { signal: ac.signal, timeout: 90_000 })
    await expect.poll(() => existsSync(said), { timeout: 30_000 }).toBe(true)
    const { pid, jj: jjPid } = JSON.parse(readFileSync(said, 'utf8')) as { pid: number; jj: number }
    // Each process by its identity (its pid and start time, #603): never a remembered pid alone.
    const [command, jjIs] = [identify([pid]), identify([jjPid])]
    try {
      expect(jjIs).toHaveLength(1)
      ac.abort()
      expect(await running).toMatchObject({ ok: false, code: -1, cancelled: true })
      expect(stillSame(jjIs)).toEqual([])
    } finally {
      // The command jj started is the test's own: ended here. A jj command that starts processes is a later J card's
      // (J5's publish, in its lease's job); J0's reads start none.
      endExactly(command)
    }
    const pre = new AbortController()
    pre.abort()
    expect(await jjContextOf(root, runner, { signal: pre.signal })).toMatchObject({ unknown: 'notRun', cancelled: true })
  })
})

