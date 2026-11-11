// The window's repository reads, traced (HI-2785, R2 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1, port 5): the
// summary, the Branches & remotes info, the leftovers, History's pages, what can be compared, a pinned compare with its
// pages and a file's diff, a pin that moved and a branch that isn't one (their errors), an agent's line status and the
// Merge dialog's branches, through the repository reads port. The same git commands (folder and argv; sorted, since
// some run together) and the same answers as the code before the port: the expected traces were recorded at cd19d0e60,
// before the port (its tests/repoReadCalls.ts calls the functions directly), with
// `CW_RECORD_REPO_TRACES=1 npx vitest run tests/repoReadTraces.test.ts`, into tests/fixtures/repoReadTraces.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base0 = tempDir('repo-read-traces-')
mkdirSync(join(base0, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base0, 'profile')

const { gitTestHooks } = await import('../src/main/git')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const reads = await import('./repoReadCalls')

const FIXTURE = join(__dirname, 'fixtures', 'repoReadTraces.json')
const RECORD = process.env.CW_RECORD_REPO_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterEach(() => {
  gitTestHooks.started = undefined
  gitTestHooks.ended = undefined
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

/** Times, which differ run to run, out of an answer: commit dates and the last fetch's time. */
const TIMES = new Set(['date', 'fetchedAt', 'when', 'at', 'committed', 'time'])

/**
 * The git commands `fn` started, each `<folder> :: <args>`, with the test's folder and full and short ids made stable,
 * then its answer (`=> <JSON>`, times out) or its error (`!! <message>`), made stable the same way.
 */
async function traced(base: string, fn: () => Promise<unknown>): Promise<string[]> {
  const ran: string[] = []
  const at = resolve(base).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string =>
    s
      .replace(/\\\\/g, '/')
      .replace(/\\/g, '/')
      .toLowerCase()
      .split(at)
      .join('<base>')
      .replace(/\b[0-9a-f]{40}\b/g, '<id>')
      .replace(/\b[0-9a-f]{7,12}\b/g, '<short>')
  let running = 0
  gitTestHooks.started = (cwd, args) => {
    running++
    ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  }
  gitTestHooks.ended = () => void running--
  let end = ''
  try {
    const v = await fn()
    end = stable(`=> ${JSON.stringify(v ?? null, (k, x) => (TIMES.has(k) ? '<time>' : x))}`)
  } catch (e) {
    end = stable(`!! ${(e as Error).message}`)
  } finally {
    // A command still running when the call ended (one of two read together, after the other's refusal) is this step's:
    // waited for, so it never lands in the next step's trace.
    await until(() => running === 0)
    gitTestHooks.started = undefined
    gitTestHooks.ended = undefined
  }
  // The commands sorted: these reads run some of theirs together (Promise.all), so which starts first varies run to run,
  // in the code before the port too. The port delegates to the same function, so a command added, dropped or changed
  // shows here; the answer, last, is exact.
  return [...ran.sort(), end]
}

/** Waits for `ok` (a bound for a hung run, never how long it should take). */
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  const by = Date.now() + ms
  while (!ok()) {
    if (Date.now() > by) throw new Error('git commands still running after the read ended') // i18n-ignore: a test's own failure
    await new Promise((r) => setTimeout(r, 10))
  }
}

function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

describe("the window's repository reads (HI-2785)", { timeout: 120_000 }, () => {
  it('summary, info, leftovers, History, compare and diff, pins and errors, a line status and the Merge dialog’s branches', async () => {
    const base = tempDir('repo-read-traces-')
    const ws = join(base, 'ws')
    const repo = join(ws, 'p')
    mkdirSync(ws, { recursive: true })
    gitRepo(repo)
    // Each commit a minute after the last: lines sorted by commit date never tie, so the traces' order is the same run to run.
    let tick = 0
    const dated = (dir: string, files: Record<string, string>, message: string): string => {
      process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = `@${1767225600 + ++tick * 60} +0000`
      try {
        return commit(dir, files, message)
      } finally {
        delete process.env.GIT_COMMITTER_DATE
        delete process.env.GIT_AUTHOR_DATE
      }
    }
    dated(repo, { '.gitignore': '.combwork/\n' }, 'ignore')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    sh(repo, 'tag', 'v1.0')
    sh(repo, 'branch', 'release')
    for (let i = 1; i <= 3; i++) dated(repo, { [`r${i}.txt`]: `${i}\n` }, `release work ${i}`)
    const main = sh(repo, 'symbolic-ref', '--short', 'HEAD')
    sh(repo, 'branch', '-f', 'release', 'HEAD')
    sh(repo, 'reset', '-q', '--hard', 'v1.0')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    dated(repo, { 'f.txt': 'f\n' }, 'feature work')
    sh(repo, 'checkout', '-q', main)
    const tree = join(base, 'tree')
    sh(repo, 'worktree', 'add', '-q', tree, 'feature')
    writeFileSync(join(repo, 'project.json.txt'), 'x\n')
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }], workflow: { platform: 'git', preset: null, options: { target: 'release' } } }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const run = (fn: () => Promise<unknown>): Promise<string[]> => traced(base, () => inWorkspace(w, fn))

    same('summary', await run(() => reads.summary(repo)))
    same('work target', await run(() => reads.workTarget(repo)))
    same('info', await run(() => reads.info(repo)))
    same('leftovers', await run(() => reads.leftovers(repo)))
    same('history: the target, page 1', await run(() => reads.history(repo, null, 1)))
    same('history: main', await run(() => reads.history(repo, `refs/heads/${main}`, 1)))
    same('history: not a branch', await run(() => reads.history(repo, 'refs/heads/nope', 1)))
    same('compare lines', await run(() => reads.compareLines(repo, [{ name: 'slot-a', folder: tree, card: 3, agent: 'b1', target: 'release' }])))
    const pinBase = sh(repo, 'rev-parse', 'release')
    const pinHead = sh(repo, 'rev-parse', 'feature')
    same('compare: pinned', await run(() => reads.compare(repo, 'release', 'feature', 1, pinBase, pinHead)))
    same('compare: unpinned', await run(() => reads.compare(repo, 'release', 'feature', 1)))
    same('compare diff: pinned', await run(() => reads.compareDiff(repo, 'release', 'feature', 'f.txt', { base: pinBase, head: pinHead })))
    dated(tree, { 'g.txt': 'g\n' }, 'more feature work')
    same('compare: a pin that moved', await run(() => reads.compare(repo, 'release', 'feature', 1, pinBase, pinHead)))
    same('compare: no such branch', await run(() => reads.compare(repo, 'release', 'nope', 1)))
    same('compare diff: no such file', await run(() => reads.compareDiff(repo, 'release', 'feature', 'nope.txt', { base: pinBase, head: sh(repo, 'rev-parse', 'feature') })))
    same('branch drops', await run(() => reads.branchDrops(repo, 'feature')))
    same('update plan', await run(() => reads.updatePlan(repo, 'feature')))
    same('line status: a worktree', await run(() => reads.lineStatus(w, repo, tree, 'feature')))
    same('merge dialog: branches', await run(() => reads.mergeBranches(repo)))
    same('merge dialog: a branch’s status', await run(() => reads.branchMergeStatus(repo, 'feature', 'release')))
    same('summary: not a repository', await run(() => reads.summary(base)))
    same('compare lines: not a repository', await run(() => reads.compareLines(base, [])))
  })
})
