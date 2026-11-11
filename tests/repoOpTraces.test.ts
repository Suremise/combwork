// The window's repository mutations, traced (HI-2788, R3 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1, port 5): New
// branch (staying, switching, from a ref) and Switch, deleting a merged branch and refusing an unmerged one, Update from
// the target, the Merge dialog's merge, remotes (add, rename, set URL, remove), fetch, pull, push and Push to against a
// local bare remote, Track…, Create tag, the commit identity, Initialise repository, and the Files tab's Exclude, Stop
// tracking and Include again, through the repository operations port. The same git commands (folder and argv, compared
// as a sorted multiset per step, since some run together: not an order proof) and the same answers and refusals as the
// code before the port: the expected traces were recorded at 196d85906, before the port (its tests/repoOpCalls.ts calls
// the functions directly), with
// `CW_RECORD_OP_TRACES=1 npx vitest run tests/repoOpTraces.test.ts`, into tests/fixtures/repoOpTraces.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base0 = tempDir('repo-op-traces-')
mkdirSync(join(base0, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base0, 'profile')

const { gitTestHooks } = await import('../src/main/git')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const ops = await import('./repoOpCalls')
const { remoteTracking } = await import('../src/main/gitRepo')

const FIXTURE = join(__dirname, 'fixtures', 'repoOpTraces.json')
const RECORD = process.env.CW_RECORD_OP_TRACES === '1'
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

/** The bound for a hung run, never how long a step should take. */
const HUNG_MS = 15_000

/** Waits for `ok` (a bound for a hung run, never how long it should take). */
async function until(ok: () => boolean, ms = HUNG_MS): Promise<void> {
  const by = Date.now() + ms
  while (!ok()) {
    if (Date.now() > by) throw new Error('git commands still running after the call ended') // i18n-ignore: a test's own failure
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The git commands `fn` started, `<folder> :: <args>`, sorted (some run together, so which starts first varies run to
 * run, in the code before the port too), then its answer (`=> <JSON>`) or its error (`!! <message>`); the test's
 * folder, full and short ids made stable. A command still running when the call ended is waited for, so it never lands
 * in the next step's trace.
 */
async function traced(base: string, fn: () => Promise<unknown>): Promise<string[]> {
  const ran: string[] = []
  const at = resolve(base).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string =>
    s.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase().split(at).join('<base>').replace(/\b[0-9a-f]{40}\b/g, '<id>').replace(/\b[0-9a-f]{7,12}\b/g, '<short>')
  // HI-2954: only the commands this step saw start are waited for. A plain count went below zero when one started before
  // the step (a refresh of the workspace's) ended inside it, and the wait below never ended (repoReadTraces on CI, 11 Nov).
  const running = new Map<string, number>()
  const key = (cwd: string, args: readonly string[]): string => `${resolve(cwd)}\0${args.join('\0')}`
  gitTestHooks.started = (cwd, args) => {
    running.set(key(cwd, args), (running.get(key(cwd, args)) ?? 0) + 1)
    ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  }
  gitTestHooks.ended = (cwd, args) => {
    const n = running.get(key(cwd, args))
    if (n === undefined) return
    if (n > 1) running.set(key(cwd, args), n - 1)
    else running.delete(key(cwd, args))
  }
  let end = ''
  try {
    end = stable(`=> ${JSON.stringify((await fn()) ?? null)}`)
  } catch (e) {
    end = stable(`!! ${(e as Error).message}`)
  } finally {
    await until(() => running.size === 0, HUNG_MS)
    gitTestHooks.started = undefined
    gitTestHooks.ended = undefined
  }
  return [...ran.sort(), end]
}

function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

describe("the window's repository mutations (HI-2788)", { timeout: 180_000 }, () => {
  it('branches, update, merge, remotes, push and fetch, tags, identity, init and the Files tab’s ignore writes', async () => {
    const base = tempDir('repo-op-traces-')
    const ws = join(base, 'ws')
    const repo = join(ws, 'p')
    const plain = join(ws, 'plain')
    const remote = join(base, 'remote.git')
    mkdirSync(ws, { recursive: true })
    gitRepo(repo)
    // Each commit a minute after the last: nothing sorted by date ties, so each trace is the same run to run.
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
    dated(repo, { '.gitignore': '.combwork/\n', 'notes.txt': 'n\n' }, 'ignore')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    mkdirSync(join(plain, '.combwork'), { recursive: true })
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    sh(base, 'init', '-q', '--bare', remote)
    const main = sh(repo, 'symbolic-ref', '--short', 'HEAD')
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }], workflow: { platform: 'git', preset: null, options: { target: main } } }))
    writeFileSync(join(plain, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [] }))
    writeFileSync(join(plain, 'a.txt'), 'a\n')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    // HI-2954: the workspace's own refreshes settled first. Opening leaves one scheduled (its writes of project.json schedule
    // it, 250 ms on), as can a step's writes: its git would otherwise straddle or land in a step's trace.
    const run = async (fn: () => Promise<unknown>): Promise<string[]> => {
      await w.refreshesSettled()
      return traced(base, () => inWorkspace(w, fn))
    }
    const at = (line: string): string => sh(repo, 'rev-parse', line)

    // Branches.
    same('new branch: staying', await run(() => ops.createLine(repo, 'feat', true)))
    same('new branch: from a ref, staying', await run(() => ops.createLine(repo, 'fromref', true, { ref: 'feat', commit: at('feat') })))
    same('new branch: switching', await run(() => ops.createLine(repo, 'side', false)))
    same('switch', await run(() => ops.switchLine(repo, main)))
    same('switch: no such branch', await run(() => ops.switchLine(repo, 'nope')))
    dated(repo, { 'm.txt': 'm\n' }, 'main moves on')
    same('update from the target: merge', await run(() => ops.updateLine(repo, 'feat', 'merge')))
    same('delete: merged', await run(() => ops.deleteLines(repo, [{ name: 'side', sha: at('side') }], false)))
    // wip has a commit main hasn't: refused unless confirmed as unmerged.
    sh(repo, 'branch', 'wip', main)
    sh(repo, 'update-ref', 'refs/heads/wip', sh(repo, 'commit-tree', `${at('wip')}^{tree}`, '-p', at('wip'), '-m', 'wip work'))
    same('delete: unmerged refused', await run(() => ops.deleteLines(repo, [{ name: 'wip', sha: at('wip') }], false)))
    same('delete: unmerged, confirmed', await run(() => ops.deleteLines(repo, [{ name: 'wip', sha: at('wip') }], true)))
    same('merge dialog: merge', await run(() => ops.mergeLine(repo, 'fromref', main)))

    // Remotes, push and fetch.
    same('add remote', await run(() => ops.addRemote(repo, 'origin', remote)))
    same('add remote: a bad name', await run(() => ops.addRemote(repo, '-x', remote)))
    same('rename remote', await run(() => ops.renameRemote(repo, 'origin', 'up')))
    same('set remote url', await run(() => ops.setRemoteUrl(repo, 'up', remote)))
    same('push: no upstream, to up', await run(() => ops.push(repo, 'up')))
    same('fetch', await run(() => ops.fetchAll(repo)))
    same('pull: up to date', await run(() => ops.pull(repo)))
    same('push to: every branch and tag', await run(() => ops.pushTo(repo, 'up', 'all')))
    same('track: not on the remote', await run(() => ops.setUpstream(repo, 'feat', 'up', 'feat', false)))
    same('track: pushing it first', await run(() => ops.setUpstream(repo, 'feat', 'up', 'feat', true)))
    same('create tag, pushed', await run(() => ops.createTag(repo, 'v1', 'First', 'up')))
    same('identity', await run(() => ops.setIdentity(repo, 'Pat', 'pat@example.invalid')))
    const tracking = await inWorkspace(w, () => remoteTracking(repo, 'up'))
    same('remove remote', await run(() => ops.removeRemote(repo, 'up', tracking)))

    // Initialise repository, and the Files tab's ignore writes.
    same('init check', await run(() => ops.initCheck(plain)))
    same('init: no identity', await run(() => ops.init(plain)))
    same('init', await run(() => ops.init(plain, 'Pat', 'pat@example.invalid')))
    same('exclude', await run(() => ops.exclude(repo, 'notes.txt')))
    same('stop tracking', await run(() => ops.untrack(repo, 'notes.txt')))
    same('include again', await run(() => ops.include(repo, 'notes.txt')))
  })
})
