// Unused worktrees (#353): the git worktrees of a project no agent works in, each checked with #291's merged-and-clean
// check. Listed: only worktrees git lists for the project, that exist, that no agent uses and that aren't the project.
// Remove deletes a merged, clean one with its branch, checked again then; Remove anyway (forced) only what the user was
// shown it would lose, refused once it changed; neither for a worktree an agent works in, one being removed, or one git
// doesn't list; nothing at all without git (#346). A deleted template's worktree agents' worktrees are found by name.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { holdsWork, lostByRemoving, originLabel, unusedPickerLabel, unusedState, unusedSummary, unusedWorkNotice } from '../src/shared/unusedWorktrees'
import type { UnusedWorktree } from '../src/shared/types'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'

// As on GitHub's runner (#447): the temp folder by its 8.3 short name where it has one (git lists worktrees by their long
// names; a junction makes another name on any machine, #448), and no global git config (tests/noGlobalGit.ts), so no
// user identity but the repository's own.
const made = tempDir('hive-unusedwt-')
const base = shortPath(made) ?? made
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = async (p) => rmSync(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
/** Makes a git command fail as git would (exit 128) while set: what Hive can't check it never offers to remove. */
let failing: ((args: string[]) => boolean) | null = null
vi.mock('../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/git')>()
  const failed = (): ReturnType<typeof real.git> => Promise.resolve({ out: '', ok: false, buf: Buffer.alloc(0), err: 'fatal: injected failure', code: 128 })
  return { ...real, git: ((cwd, args, ...rest) => (failing?.(args) ? failed() : real.git(cwd, args, ...rest))) as typeof real.git }
})

const { PREVIEW_MS, hiveWorktreeOf, mergeUnused, removalPreview, removeUnusedWorktree, setQueueNeed, unusedBranchStatus, unusedWorktreeCounts, unusedWorktrees } = await import('../src/main/unusedWorktrees')
const { createWorktree } = await import('../src/main/worktrees')
const { addAgent, reserveForRemoval, worktreeChecks } = await import('../src/main/projectAgents')
const { gitTestHooks } = await import('../src/main/git')
const { gitOnPath, setGitToolForTests } = await import('../src/main/gitTool')
// Paths compared as places: git lists the long names of folders Hive may know by short (8.3) ones, as on CI (#389).
const { fileLockDepth, placeKey, withFileLock } = await import('../src/main/fsutil')
const { commonGitDir } = await import('../src/main/repoLock')
const { REPO_LOCK_FILE } = await import('../src/main/repoLockCore')

// Real git work, not a wait (#555): a test here runs 20 to 70 git commands, about 35 ms each alone, about 0.3 s each and
// up to 1.3 s under a full unit run beside other runs (measured: 12 s for one test, against 2 s alone), and more under
// heavier load. So each test is bounded by GIT_HUNG_MS rather than the suite's 20 s: only a hung git takes a minute.
const GIT_HUNG_MS = 60_000
vi.setConfig({ testTimeout: GIT_HUNG_MS })
/** A failure says what git said (#864: "nothing to commit" is on stdout, a lock or a fatal error on stderr). */
const git = (cwd: string, ...a: string[]): string => {
  try {
    return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string }
    throw new Error(`git ${a.join(' ')} failed in ${cwd}:\n${[stderr, stdout].map((s) => s?.trim()).filter(Boolean).join('\n')}`, { cause: e })
  }
}
const wsPath = join(base, 'ws')
const proj = join(wsPath, 'proj')
const root = join(base, 'ws.worktrees', 'proj')
const PATH = process.env.PATH
let w: ReturnType<typeof createWorkspaceService>
const run = <T,>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
let n = 0

/** A new worktree hive/<name> in the workspace's worktree folder, off main. */
async function tree(name: string): Promise<{ path: string; branch: string }> {
  const t = { path: join(root, name), branch: `hive/${name}` }
  await createWorktree(proj, t.path, t.branch, 'main')
  return t
}
const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
}
const branches = (): string[] => git(proj, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean)
const listOf = async (): Promise<UnusedWorktree[]> => (await run(() => unusedWorktrees(proj))).worktrees
const find = async (path: string): Promise<UnusedWorktree | undefined> => (await listOf()).find((x) => placeKey(x.path) === placeKey(path))
/**
 * Agents of the project, with these worktrees. The project keeps its id (#1149): written without it, Hive gives it a new
 * one at its next read of the ids (a second later or more, as under load), and its session records are under the old one.
 */
const agents = (trees: { path: string; branch: string }[]): void => {
  const file = join(proj, '.combwork', 'project.json')
  const id = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { id?: string }).id : undefined
  writeFileSync(file, JSON.stringify({ version: 2, ...(id ? { id } : {}), agents: trees.map((t, i) => ({ id: `a${i}`, name: `A${i}`, provider: 'claude-code', worktree: { ...t, base: 'main' } })) }))
}

beforeAll(async () => {
  mkdirSync(join(proj, '.combwork'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  commit(proj, 'a.txt')
  agents([])
  w = createWorkspaceService()
  await w.open(wsPath)
})
afterAll(async () => {
  await disposeWorkspaceService(w)
})
afterEach(async () => {
  process.env.PATH = PATH
  setGitToolForTests({ state: 'unknown' })
  failing = null
  // Each test's worktrees go with it (#459): a listing checks every worktree of the project, several git calls each, so
  // ones left by earlier tests made a later test's listings slower the more tests ran before it (24 by the Changes tab's,
  // 7 s a listing alone), past its limit under load. A worktree Windows still holds is tried again a few times, then left.
  const left = git(proj, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)).slice(1)
  for (const path of left) {
    for (let i = 0; i < 5; i++) {
      try {
        git(proj, 'worktree', 'remove', '--force', '--force', path)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }
  git(proj, 'worktree', 'prune')
})

describe('listing', () => {
  it('lists the worktrees no agent works in, each checked, never the project or one an agent has', async () => {
    const used = await tree(`used${++n}`)
    const fresh = await tree(`fresh${n}`)
    const ahead = await tree(`ahead${n}`)
    commit(ahead.path, 'x.txt')
    const dirty = await tree(`dirty${n}`)
    writeFileSync(join(dirty.path, 'new.txt'), 'new\n')
    agents([used])
    const list = await listOf()
    const paths = list.map((x) => placeKey(x.path))
    expect(paths).not.toContain(placeKey(used.path))
    expect(paths).not.toContain(placeKey(proj))
    const f = list.find((x) => x.branch === fresh.branch)!
    expect(f.check).toMatchObject({ removable: true, into: 'main', ahead: 0, dirty: 0 })
    expect(f.lastCommit?.subject).toBe('a.txt')
    expect(f.head).toMatch(/^[0-9a-f]{40}$/)
    expect(unusedState(f)).toBe('Merged into main · clean')
    const a = list.find((x) => x.branch === ahead.branch)!
    expect(a.check).toMatchObject({ removable: false, ahead: 1, dirty: 0 })
    expect(unusedState(a)).toBe('1 commit not on main')
    expect(holdsWork(a)).toBe(true)
    const d = list.find((x) => x.branch === dirty.branch)!
    expect(unusedState(d)).toBe('1 changed file')
    expect(lostByRemoving(d)).toEqual([`1 uncommitted file in ${d.path}`, 'the files git ignores in its folder (build output, copied .env files)'])
    expect(await run(() => unusedWorktreeCounts(proj))).toMatchObject({ merged: expect.any(Number), count: list.length })
    agents([])
  })

  it('an agent whose worktree is saved by another name (a junction, an 8.3 name) works in it: not listed (#389)', async () => {
    const t = await tree(`aliased${++n}`)
    expect(await find(t.path)).toBeDefined()
    const via = junction(t.path, join(base, `via${n}`))
    agents([{ ...t, path: via }])
    expect(await find(t.path)).toBeUndefined()
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false })
    expect(existsSync(t.path)).toBe(true)
    agents([])
  })

  it("says who made each (#476): the Hive agent whose session last ran there, else Hive's folder, else not Hive", async () => {
    const ran = await tree(`ran${++n}`)
    const hive = await tree(`hive${n}`)
    const other = { path: join(base, 'elsewhere', `other${n}`), branch: `feature/other${n}` }
    await createWorktree(proj, other.path, other.branch, 'main')
    const at = (m: number): string => new Date(Date.UTC(2026, 9, 9, 10, m)).toISOString()
    const session = (id: string, cwd: string, agentName: string, m: number) => ({ id, agent: 'claude-code', name: id, createdAt: at(m), lastActiveAt: at(m), archived: false, agentId: `a-${agentName}`, agentName, cwd })
    // Two agents ran there: the later one names it. A session in the project folder says nothing about worktrees.
    // The project's session records (#1061: in the workspace's database).
    await run(() => w.mutateSessions(proj, (f) => void (f.sessions = [session('s1', ran.path, 'Old', 1), session('s2', ran.path, 'B4', 2), session('s3', proj, 'Main', 3)])))
    try {
      // One listing (it reads git for every worktree): each is looked up in it.
      const list = await listOf()
      const of = (path: string): UnusedWorktree => list.find((x) => placeKey(x.path) === placeKey(path))!
      expect(of(ran.path).origin).toEqual({ madeBy: 'hive', agentName: 'B4' })
      expect(of(hive.path).origin).toEqual({ madeBy: 'hive' })
      expect(of(other.path).origin).toEqual({ madeBy: 'other' })
      expect(originLabel(of(ran.path))).toBe('was B4')
      expect(originLabel(of(hive.path))).toBe('made by Combwork')
      expect(originLabel(of(other.path))).toBe('not made by Combwork')
      expect(unusedPickerLabel(of(other.path))).toBe(`feature/other${n} · not made by Combwork · merged, clean`)
    } finally {
      await run(() => w.mutateSessions(proj, (f) => void (f.sessions = [])))
    }
  })

  it('a detached worktree is listed, never removable by Remove', async () => {
    const t = await tree(`detached${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    const d = await find(t.path)
    expect(d).toMatchObject({ branch: null, check: { removable: false, reason: 'it is not on a branch (detached HEAD)', dirty: 0 } })
    expect((await run(() => removeUnusedWorktree(proj, t.path))).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })

  it("the merge queue's folder is never listed while its queue uses it: a running runner holds it (#1360), or the queue still needs it (#1644)", async () => {
    const { FactStore } = await import('../src/main/workflow/factStore')
    const { boardWrite } = await import('../src/main/boardStore')
    const store = FactStore.forBoard(w, { project: 'proj', key: 'proj' })
    const lease = `ab${++n}`
    const t = join(root, `queue-0123456789ab-${lease}`)
    git(proj, 'worktree', 'add', '-q', '--detach', t)
    const needs: string[] = []
    let need: boolean | Error = false
    setQueueNeed(async (_ws, p, target) => {
      needs.push(`${placeKey(p) === placeKey(proj) ? 'proj' : p}:${target}`)
      if (need instanceof Error) throw need
      return need
    })
    try {
      const held = { target: 'main', lease, token: 't1', profile: 'Hive-Dev', pid: process.pid, started: 1, takenAt: '2026-10-21T00:00:00.000Z', renewedAt: '2026-10-21T00:00:00.000Z' }
      await run(() => boardWrite(w, async () => store.takeQueueLease(held, null) && store.setQueueFolder({ folder: t, target: 'main', lease })))
      // Its runner merging in it: not listed, not removable, even though nothing else needs it.
      expect(await find(t)).toBeUndefined()
      await expect(run(() => removalPreview(proj, t))).rejects.toThrow(/Combwork doesn't remove it/)
      expect(existsSync(t)).toBe(true)
      // Its Hive crashed (the lease names a process that has ended): the queue's, while the queue needs it.
      const ended = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot ?? '' } })
      await run(() => boardWrite(w, async () => store.takeQueueLease({ ...held, token: 't2', pid: Number(ended) }, 't1')))
      need = true
      expect(await find(t)).toBeUndefined()
      // Released cleanly and kept warm for the next merge (Darren's case): still the queue's while it needs it.
      await run(() => boardWrite(w, async () => store.dropQueueLease(lease, 't2') && store.setQueueFolder({ folder: t, target: 'main', lease: null })))
      expect(await find(t)).toBeUndefined()
      await expect(run(() => removalPreview(proj, t))).rejects.toThrow(/Combwork doesn't remove it/)
      // Whether it does can't be said: kept, never offered.
      need = new Error('no workflow')
      expect(await find(t)).toBeUndefined()
      // Nothing waits to merge into main any more: left over, listed as the queue's.
      need = false
      expect(await find(t)).toMatchObject({ branch: null, kind: 'queue' })
      expect((await run(() => removalPreview(proj, t))).path).toBeTruthy()
      expect(needs).toContain('proj:main')
      // No way of asking (the app not wired): the queue needs it.
      setQueueNeed(null)
      expect(await find(t)).toBeUndefined()
    } finally {
      setQueueNeed(null)
      await run(() => boardWrite(w, async () => store.dropQueueFolder(t)))
    }
    // A folder named as the queue names them, with no record of it: listed as the queue's, never as a plain worktree.
    expect(await find(t)).toMatchObject({ kind: 'queue' })
  })

  it("Remove anyway never deletes a queue folder a runner claims while the removal checks it (HR4's #1644 round 1); one claimed for removal loses its record", async () => {
    const { FactStore } = await import('../src/main/workflow/factStore')
    const { boardWrite } = await import('../src/main/boardStore')
    const store = FactStore.forBoard(w, { project: 'proj', key: 'proj' })
    const lease = `ac${++n}`
    const t = join(root, `queue-0123456789ab-${lease}`)
    git(proj, 'worktree', 'add', '-q', '--detach', t)
    const runner = (token: string): Parameters<typeof store.takeQueueLease>[0] => ({ target: 'main', lease, token, profile: 'Hive-Dev', pid: process.pid, started: 1, takenAt: '2026-10-25T00:00:00.000Z', renewedAt: '2026-10-25T00:00:00.000Z' })
    const takes = (token: string): void => {
      store.takeQueueLease(runner(token), null)
      store.setQueueFolder({ folder: t, target: 'main', lease })
    }
    const frees = (token: string): Promise<unknown> => run(() => boardWrite(w, async () => store.dropQueueLease(lease, token) && store.setQueueFolder({ folder: t, target: 'main', lease: null })))
    const recorded = (): boolean => store.queueFolders().some((f) => placeKey(f.folder) === placeKey(t))
    await run(() => boardWrite(w, async () => store.setQueueFolder({ folder: t, target: 'main', lease: null })))
    try {
      // A runner takes it while the removal asks whether the queue needs it (HR4's repro): kept, its record too.
      setQueueNeed(async () => false)
      let preview = await run(() => removalPreview(proj, t))
      let acquired = false
      setQueueNeed(async () => {
        if (!acquired) await boardWrite(w, async () => takes('during-need'))
        acquired = true
        return false
      })
      expect(await run(() => removeUnusedWorktree(proj, t, { force: preview.token }))).toMatchObject({ deleted: false })
      expect([acquired, existsSync(t), recorded()]).toEqual([true, true, true])
      await frees('during-need')
      // Later still: after every check of the listing, as its contents are read again (the claim alone stops it).
      setQueueNeed(async () => false)
      preview = await run(() => removalPreview(proj, t))
      // The runner's write is asked for there, so it holds the board's lock before the removal's claim asks for it.
      let late: Promise<unknown> | null = null
      failing = (args) => {
        if (!late && args[0] === 'symbolic-ref' && args.includes('--quiet') && args.at(-1) === 'HEAD') late = run(() => boardWrite(w, async () => takes('during-snapshot')))
        return false
      }
      expect(await run(() => removeUnusedWorktree(proj, t, { force: preview.token }))).toEqual({ deleted: false, reason: 'the merge queue is using it' })
      failing = null
      await late
      expect([!!late, existsSync(t), recorded()]).toEqual([true, true, true])
      await frees('during-snapshot')
      // An ended runner's process not seen gone yet (a duty of its lease): it may be in the folder, so it stays.
      await run(() => boardWrite(w, async () => store.setQueueFolder({ folder: t, target: 'main', lease })))
      await run(() => boardWrite(w, async () => store.addQueueProc({ lease, target: 'main', pid: 1, startAfter: 0, startBefore: 1, what: 'job' })))
      expect(await find(t)).toBeUndefined()
      await run(() => boardWrite(w, async () => store.dropQueueProc(lease, 1)))
      // Nothing has it: removed, and its record goes with it, so no runner takes the folder after.
      preview = await run(() => removalPreview(proj, t))
      expect(await run(() => removeUnusedWorktree(proj, t, { force: preview.token }))).toEqual({ deleted: true })
      expect([existsSync(t), recorded()]).toEqual([false, false])
    } finally {
      failing = null
      setQueueNeed(null)
      await run(() => boardWrite(w, async () => store.dropQueueFolder(t)))
    }
  })

  it("a review copy is never listed; a folder named as the queue names them, with no record, is listed as the queue's (#1644)", async () => {
    const copy = join(root, 'copies', `copy-${++n}`)
    git(proj, 'worktree', 'add', '-q', '--detach', copy)
    const q = join(root, `queue-0123456789ab-cd${n}`)
    git(proj, 'worktree', 'add', '-q', '--detach', q)
    expect(await find(copy)).toBeUndefined()
    expect(await find(q)).toMatchObject({ kind: 'queue' })
  })

  it("Branches & remotes' groups (HI-1710): a review copy is Hive's 'copy', a queue folder its 'queue', anything else no one of Hive's", async () => {
    const copy = join(root, 'copies', `copy-${++n}`)
    const q = join(root, `queue-0123456789ab-ef${n}`)
    const plain = await tree(`plain${n}`)
    const of = (path: string): Promise<'copy' | 'queue' | null> => run(async () => hiveWorktreeOf(proj, path))
    expect(await of(copy)).toBe('copy')
    // As git may list it: another case, the other slash.
    expect(await of(copy.toUpperCase().replace(/\\/g, '/'))).toBe('copy')
    expect(await of(q)).toBe('queue')
    expect(await of(plain.path)).toBeNull()
    expect(await of(proj)).toBeNull()
    // Named like one, but not in the project's own folder of Hive's worktrees: not Hive's.
    expect(await of(join(base, 'elsewhere', 'copies', 'copy-1'))).toBeNull()
    expect(await of(join(base, 'elsewhere', 'queue-0123456789ab-ef1'))).toBeNull()
    expect(await of(join(root, 'copies-old', 'copy-1'))).toBeNull()
  })

  // Read-only check loops share one operation's reads (#733): the project's worktree list, its main branch (its branches
  // and origin/HEAD) and main's commit once, however many worktrees; each worktree's own reads stay its own.
  /** The project folder's reads one step made, by what they read. */
  const counted = async (step: () => Promise<unknown>): Promise<{ worktrees: number; branches: number; originHead: number; mainTip: number }> => {
    const by: string[] = []
    gitTestHooks.started = (cwd, args) => {
      if (placeKey(cwd) === placeKey(proj)) by.push(args.join(' '))
    }
    try {
      await run(step)
    } finally {
      gitTestHooks.started = undefined
    }
    const count = (re: RegExp): number => by.filter((a) => re.test(a)).length
    return { worktrees: count(/^worktree list/), branches: count(/^for-each-ref --format=%\(refname\) refs\/heads$/), originHead: count(/^symbolic-ref /), mainTip: count(/^rev-parse --verify --quiet refs\/heads\/main\^\{commit\}$/) }
  }
  const ONCE = { worktrees: 1, branches: 1, originHead: 1, mainTip: 1 }

  it('the list reads the worktree list and the main branch once, however many worktrees (#733)', async () => {
    const merged = await tree(`once${++n}`)
    const ahead = await tree(`onceahead${n}`)
    commit(ahead.path, 'x.txt')
    const detached = await tree(`oncedetached${n}`)
    git(detached.path, 'checkout', '-q', '--detach')
    let list: UnusedWorktree[] = []
    expect(await counted(async () => (list = (await unusedWorktrees(proj)).worktrees))).toEqual(ONCE)
    // Each checked as before.
    const of = (t: { path: string }): UnusedWorktree | undefined => list.find((x) => placeKey(x.path) === placeKey(t.path))
    expect([of(merged)?.check.removable, of(ahead)?.check.reason, of(detached)?.check]).toEqual([true, '1 commit not merged into main', expect.objectContaining({ removable: false, into: 'main', reason: 'it is not on a branch (detached HEAD)', dirty: 0 })])
  })

  it("Remove All's checks read the worktree list and the main branch once, however many agents (#733)", async () => {
    const trees = [await tree(`checks${++n}`), await tree(`checksahead${n}`), await tree(`checksdirty${n}`)]
    commit(trees[1].path, 'x.txt')
    writeFileSync(join(trees[2].path, 'loose.txt'), 'x')
    agents(trees)
    try {
      let checks: Awaited<ReturnType<typeof worktreeChecks>> = []
      expect(await counted(async () => (checks = await worktreeChecks(proj)))).toEqual(ONCE)
      expect(checks.map((c) => [c.agentId, c.removable, c.reason ?? null])).toEqual([
        ['a0', true, null],
        ['a1', false, '1 commit not merged into main'],
        ['a2', false, '1 uncommitted file']
      ])
    } finally {
      agents([])
    }
  })
})

describe('Remove', () => {
  it('deletes a merged, clean one and its branch', async () => {
    const t = await tree(`merged${++n}`)
    expect(await run(() => removeUnusedWorktree(proj, t.path, { expectInto: 'main' }))).toEqual({ deleted: true })
    expect(existsSync(t.path)).toBe(false)
    expect(branches()).not.toContain(t.branch)
  })

  it('keeps one with unmerged commits or uncommitted files, saying why', async () => {
    const t = await tree(`work${++n}`)
    commit(t.path, 'w.txt')
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false, reason: '1 commit not merged into main' })
    expect(existsSync(t.path)).toBe(true)
  })

  it('keeps one an agent works in, one being removed, and folders git does not list', async () => {
    const t = await tree(`taken${++n}`)
    agents([t])
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toEqual({ deleted: false, reason: 'an agent works in it now' })
    agents([])
    const release = reserveForRemoval(t.path)
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toEqual({ deleted: false, reason: 'That worktree is already being removed or merged.' })
    release()
    const plain = join(root, `plain${n}`)
    mkdirSync(plain, { recursive: true })
    expect((await run(() => removeUnusedWorktree(proj, plain))).deleted).toBe(false)
    expect((await run(() => removeUnusedWorktree(proj, proj))).deleted).toBe(false)
    expect(existsSync(t.path) && existsSync(plain) && existsSync(proj)).toBe(true)
  })
})

describe('Remove anyway', () => {
  const anyway = (path: string, token: string) => run(() => removeUnusedWorktree(proj, path, { force: token }))
  const preview = (path: string) => run(() => removalPreview(proj, path))

  it('deletes what the confirmation showed, folder and branch, once', async () => {
    const t = await tree(`anyway${++n}`)
    commit(t.path, 'w.txt')
    writeFileSync(join(t.path, 'loose.txt'), 'x')
    const p = await preview(t.path)
    expect(p.lost).toEqual([`1 commit on ${t.branch} not on main`, `1 uncommitted file in ${p.path}`, 'the files git ignores in its folder (build output, copied .env files)'])
    expect(await anyway(t.path, p.token)).toEqual({ deleted: true })
    expect(existsSync(t.path)).toBe(false)
    expect(branches()).not.toContain(t.branch)
    // A token is good for one removal.
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
  })

  it('a tag named as its branch: the confirmation names the branch, and it goes by that name, the tag kept (HI-2426)', async () => {
    const t = await tree(`tagged${++n}`)
    commit(t.path, 'w.txt')
    git(proj, 'tag', t.branch, 'main')
    try {
      const p = await preview(t.path)
      expect([p.branch, p.lost[0]]).toEqual([t.branch, `1 commit on ${t.branch} not on main`])
      expect(await anyway(t.path, p.token)).toEqual({ deleted: true })
      expect(branches()).not.toContain(t.branch)
      expect(git(proj, 'tag', '--list', t.branch).trim()).toBe(t.branch)
    } finally {
      git(proj, 'tag', '-d', t.branch)
    }
  })

  it('refuses a token past its 15 minutes, with no other preview since; one inside them still works (#373)', async () => {
    const old = await tree(`expired${++n}`)
    const fresh = await tree(`fresh${n}`)
    const p = await preview(old.path)
    const q = await preview(fresh.path)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + PREVIEW_MS - 60_000)
      expect(await anyway(fresh.path, q.token)).toEqual({ deleted: true })
      vi.setSystemTime(Date.now() + 2 * 60_000)
      expect(await anyway(old.path, p.token)).toEqual({ deleted: false, lookAgain: true, reason: 'what it holds was checked more than 15 minutes ago' })
    } finally {
      vi.useRealTimers()
    }
    expect(existsSync(old.path)).toBe(true)
    expect(branches()).toContain(old.branch)
    // Spent by that refusal: a new look is needed, and settles it (#377).
    expect(await anyway(old.path, p.token)).toMatchObject({ deleted: false, lookAgain: true, reason: expect.stringMatching(/not checked for this removal/) })
    expect(await anyway(old.path, (await preview(old.path)).token)).toEqual({ deleted: true })
  })

  it('a token is spent by a removal refused for another reason too', async () => {
    const t = await tree(`spent${++n}`)
    const p = await preview(t.path)
    agents([t])
    // Not one a new look settles: no lookAgain.
    expect(await anyway(t.path, p.token)).toEqual({ deleted: false, reason: 'an agent works in it now' })
    agents([])
    expect((await anyway(t.path, p.token)).reason).toMatch(/not checked for this removal/)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses without a preview of this worktree', async () => {
    const t = await tree(`notoken${++n}`)
    const other = await tree(`other${n}`)
    expect(await anyway(t.path, 'made-up')).toMatchObject({ deleted: false, reason: expect.stringMatching(/not checked for this removal/) })
    const p = await preview(other.path)
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after a file is renamed and rewritten, the count the same', async () => {
    const t = await tree(`rename${++n}`)
    writeFileSync(join(t.path, 'old.txt'), 'old\n')
    const p = await preview(t.path)
    rmSync(join(t.path, 'old.txt'))
    writeFileSync(join(t.path, 'new-important.txt'), 'new work\n')
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, lookAgain: true, reason: expect.stringMatching(/changed since you were shown.*its files/) })
    expect(existsSync(join(t.path, 'new-important.txt'))).toBe(true)
  })

  it("refuses after an uncommitted file's content changes, its size the same", async () => {
    const t = await tree(`edit${++n}`)
    writeFileSync(join(t.path, 'a.txt'), 'AAAA\n')
    const p = await preview(t.path)
    writeFileSync(join(t.path, 'a.txt'), 'BBBB\n')
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after an ignored file changes', async () => {
    const t = await tree(`ignored${++n}`)
    // Not commit(t.path, '.gitignore'): its ".gitignore" line ignores the file itself, so that commit had nothing of its
    // own and failed whenever git's index didn't make it rehash a.txt (#864).
    writeFileSync(join(t.path, '.gitignore'), '*.log\n')
    git(t.path, 'add', '-A')
    git(t.path, 'commit', '-qm', 'ignore logs')
    writeFileSync(join(t.path, 'build.log'), 'one\n')
    const p = await preview(t.path)
    writeFileSync(join(t.path, 'build.log'), 'one, and more\n')
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its files/) })
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after the worktree switches to another branch at the same commit; neither branch goes', async () => {
    const t = await tree(`switched${++n}`)
    commit(t.path, 'w.txt')
    const p = await preview(t.path)
    expect(p.branch).toBe(t.branch)
    git(t.path, 'checkout', '-q', '-b', `hive/different${n}`)
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its branch/) })
    expect(branches()).toEqual(expect.arrayContaining([t.branch, `hive/different${n}`]))
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after a change staged in its index alone, the working file the same', async () => {
    const t = await tree(`staged${++n}`)
    writeFileSync(join(t.path, 'a.txt'), 'changed\n')
    const p = await preview(t.path)
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: t.path, input: 'NEW STAGED WORK AFTER PREVIEW\n', encoding: 'utf8' }).trim()
    git(t.path, 'update-index', '--cacheinfo', `100644,${blob},a.txt`)
    expect(await anyway(t.path, p.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/its files/) })
    expect(existsSync(t.path)).toBe(true)
  })

  it('refuses after an ignored file and a large file change, at the same size with their times put back', async () => {
    const t = await tree(`sametime${++n}`)
    writeFileSync(join(t.path, '.gitignore'), '*.log\n*.bin\n')
    git(t.path, 'add', '-A')
    git(t.path, 'commit', '-qm', 'ignore')
    const secret = join(t.path, 'secret.log')
    writeFileSync(secret, 'AAAA')
    const was = statSync(secret)
    const p = await preview(t.path)
    writeFileSync(secret, 'BBBB')
    utimesSync(secret, was.atime, was.mtime)
    expect((await anyway(t.path, p.token)).deleted).toBe(false)
    // Bigger than any "hash only small files" limit: still read whole.
    const big = join(t.path, 'big.bin')
    const bytes = Buffer.alloc(9 * 1024 * 1024)
    writeFileSync(big, bytes)
    const bigWas = statSync(big)
    const q = await preview(t.path)
    bytes[bytes.length - 1] = 1
    writeFileSync(big, bytes)
    utimesSync(big, bigWas.atime, bigWas.mtime)
    expect((await anyway(t.path, q.token)).deleted).toBe(false)
    expect(existsSync(secret) && existsSync(big)).toBe(true)
  })

  it("a main branch git couldn't look for is no answer: no preview, and a token from before removes nothing", async () => {
    const t = await tree(`nomain${++n}`)
    commit(t.path, 'w.txt')
    const before = await preview(t.path)
    failing = (args) => args.includes('for-each-ref')
    await expect(preview(t.path)).rejects.toThrow(/couldn't check what it holds: git couldn't list the branches/)
    expect(await anyway(t.path, before.token)).toMatchObject({ deleted: false, reason: expect.stringMatching(/couldn't list the branches/) })
    failing = (args) => args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')
    await expect(preview(t.path)).rejects.toThrow(/couldn't read origin\/HEAD/)
    failing = null
    expect(existsSync(t.path)).toBe(true)
    expect(branches()).toContain(t.branch)
  })

  it('a detached worktree names the commits only its HEAD holds, and they count as work', async () => {
    const t = await tree(`alone${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    commit(t.path, 'unique.txt')
    const listed = (await find(t.path))!
    expect(listed.check).toMatchObject({ removable: false, ahead: 1, dirty: 0 })
    expect(holdsWork(listed)).toBe(true)
    expect(unusedState(listed)).toBe('1 commit on no branch')
    expect(lostByRemoving(listed)![0]).toBe('1 commit on no branch (only its detached HEAD has it)')
    const p = await preview(t.path)
    expect(p.lost[0]).toBe('1 commit on no branch (only its detached HEAD has it)')
    expect(await anyway(t.path, p.token)).toEqual({ deleted: true })
  })

  it("nothing to confirm when git can't count what it holds", async () => {
    const t = await tree(`uncounted${++n}`)
    git(t.path, 'checkout', '-q', '--detach')
    failing = (args) => args.includes('rev-list')
    expect(lostByRemoving((await find(t.path))!)).toBeNull()
    await expect(preview(t.path)).rejects.toThrow(/couldn't check what it holds: git could not count its commits/)
    failing = null
    expect(existsSync(t.path)).toBe(true)
  })
})

describe('in the Changes tab (#400)', () => {
  it('reads only a listed unused worktree: its git status through assertChangesRoot, and only once listed', async () => {
    agents([])
    // Made by another name for its folder, as on the runner (#447): through a junction to the worktrees folder, so on any
    // machine (the 8.3 temp folder only where the volume makes short names, #448). Git lists it by its real name.
    mkdirSync(root, { recursive: true })
    const via = junction(root, join(base, `via-root${++n}`))
    const t = { path: join(via, `changes${n}`), branch: `hive/changes${n}` }
    await createWorktree(proj, t.path, t.branch, 'main')
    commit(t.path, 'c.txt')
    const outside = join(base, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    // Not yet listed: refused (only the project folder and agents' worktrees).
    expect(() => w.assertChangesRoot(t.path)).toThrow(/Not a project or agent worktree/)
    // The Changes tab reads it by the path the listing gave (git's real name), not by another name for it (#447).
    const listed = (await find(t.path))!.path
    expect(listed.toLowerCase()).not.toBe(t.path.toLowerCase())
    expect(placeKey(w.assertChangesRoot(listed))).toBe(placeKey(t.path))
    expect(() => w.assertChangesRoot(outside)).toThrow()
    // The Files tab's file operations never get it.
    expect(() => w.assertRoot(listed)).toThrow()
    // Given to an agent, it isn't unused: listed again, it drops out (it is an agent's worktree, as assertRoot allows).
    agents([t])
    await listOf()
    await w.refresh()
    expect(placeKey(w.assertChangesRoot(t.path))).toBe(placeKey(t.path))
    agents([])
    await w.refresh()
  })

  it('a branch status and a merge only for one the listing would list, never an agent\'s worktree or the project', async () => {
    const t = await tree(`notmine${++n}`)
    agents([t])
    await expect(run(() => unusedBranchStatus(proj, t.path))).rejects.toThrow(/isn't one of the project's unused worktrees/)
    // An agent's: refused before anything is looked at, nothing staged or committed.
    writeFileSync(join(t.path, 'agents-work.txt'), 'theirs\n')
    const head = git(proj, 'rev-parse', 'main')
    await expect(run(() => mergeUnused(proj, t.path, { squash: false, message: 'x', cleanup: false }))).rejects.toThrow(/An agent works in it now/)
    expect(git(proj, 'rev-parse', 'main')).toBe(head)
    expect(git(t.path, 'status', '--porcelain')).toContain('agents-work.txt')
    await expect(run(() => unusedBranchStatus(proj, proj))).rejects.toThrow(/isn't one of the project's unused worktrees/)
    agents([])
  })

  it("merges one's work onto main as an agent's merge does, and removes it after when asked (checked)", async () => {
    agents([])
    const t = await tree(`merging${++n}`)
    commit(t.path, `m${n}.txt`)
    const st = await run(() => unusedBranchStatus(proj, t.path))
    expect(st.ahead).toBe(1)
    expect(st.into).toBe('main')
    const r = await run(() => mergeUnused(proj, t.path, { squash: false, message: `Work from ${t.branch}`, cleanup: true }))
    expect(r).toMatchObject({ ok: true, cleanedUp: true })
    expect(existsSync(join(proj, `m${n}.txt`))).toBe(true)
    expect(existsSync(t.path)).toBe(false)
    expect(branches()).not.toContain(t.branch)
  })

  it('fenced while it waits its turn: an agent given it meanwhile is refused (1.0: always, #1451), and the merge goes on unchanged', async () => {
    agents([])
    const t = await tree(`fenced${++n}`)
    commit(t.path, `f${n}.txt`)
    const head = git(proj, 'rev-parse', 'main')
    // Another merge into this repository holds its turn (its repository lock, held in this process as withRepoLock
    // holds it: HI-2147, a file name from before #1347 fenced nothing), so this one waits after it was checked. Let go
    // of whatever fails below, and the merge settled, so no later test here waits on the real lock behind it.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const lock = join(await commonGitDir(proj), REPO_LOCK_FILE)
    const other = withFileLock(lock, () => held)
    const merging = run(() => mergeUnused(proj, t.path, { squash: false, message: `Work from ${t.branch}`, cleanup: false }))
    try {
      await vi.waitFor(() => expect(fileLockDepth(lock)).toBe(2), { timeout: GIT_HUNG_MS, interval: 20 })
      // Meanwhile Add Agent picks it as an existing worktree: refused (no agent is pinned to a worktree in 1.0), the
      // project's agents unchanged.
      await expect(run(() => addAgent(proj, { name: 'Late', location: 'existing-worktree', worktreePath: t.path }))).rejects.toThrow(/aren’t pinned to worktrees/)
      expect(JSON.parse(readFileSync(join(proj, '.combwork', 'project.json'), 'utf8')).agents).toEqual([])
      // A second merge or a removal of it waits for neither: refused while this one has it.
      await expect(run(() => mergeUnused(proj, t.path, { squash: false, message: 'twice', cleanup: false }))).rejects.toThrow(/already being removed or merged/)
      expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false, reason: 'That worktree is already being removed or merged.' })
      expect(git(proj, 'rev-parse', 'main')).toBe(head)
    } finally {
      release()
      await other
      await merging.catch(() => undefined)
    }
    await vi.waitFor(() => expect(fileLockDepth(lock)).toBe(0), { timeout: GIT_HUNG_MS, interval: 20 })
    expect(await merging).toMatchObject({ ok: true })
    expect(existsSync(join(proj, `f${n}.txt`))).toBe(true)
    expect(existsSync(t.path)).toBe(true)
    expect(branches()).toContain(t.branch)
    agents([])
  })

  it('merged, but kept when the checked removal after it refuses: said why, never forced', async () => {
    agents([])
    const t = await tree(`keepme${++n}`)
    commit(t.path, `k${n}.txt`)
    // git refuses to remove it (a program holding its folder, say): the merge stands, the worktree stays.
    failing = (args) => args.includes('worktree') && args.includes('remove')
    try {
      const r = await run(() => mergeUnused(proj, t.path, { squash: false, message: 'm', cleanup: true }))
      expect(r.ok).toBe(true)
      expect(r.cleanedUp).toBeUndefined()
      expect(r.cleanupKept).toMatch(/git kept it/)
    } finally {
      failing = null
    }
    expect(existsSync(join(proj, `k${n}.txt`))).toBe(true)
    expect(existsSync(t.path)).toBe(true)
  })
})

describe('without git (#346)', () => {
  it('lists nothing, says why, and removes nothing', async () => {
    const t = await tree(`nogit${++n}`)
    process.env.PATH = (PATH ?? '').split(delimiter).filter((d) => d && !gitOnPath({ PATH: d })).join(delimiter)
    expect(await run(() => unusedWorktrees(proj))).toEqual({ worktrees: [], gitProblem: "Git isn't installed (or isn't on Combwork's PATH)" })
    expect(await run(() => removeUnusedWorktree(proj, t.path))).toMatchObject({ deleted: false, reason: "Git isn't installed (or isn't on Combwork's PATH)" })
    await expect(run(() => removalPreview(proj, t.path))).rejects.toThrow(/isn't installed/)
    expect(existsSync(t.path)).toBe(true)
  })
})

describe('what the window says', () => {
  const wt = (check: UnusedWorktree['check'], extra: Partial<UnusedWorktree> = {}): UnusedWorktree => ({ path: 'C:\\w\\x', branch: 'hive/x', check, ...extra })
  it("the Overview's line counts them and the merged ones (#400)", () => {
    const merged = { path: 'C:\\t\\a', branch: 'hive/a', check: { removable: true, into: 'main' } } as UnusedWorktree
    const work = { path: 'C:\\t\\b', branch: 'hive/b', check: { removable: false, into: 'main', ahead: 1, dirty: 0 } } as UnusedWorktree
    expect(unusedSummary([])).toBeNull()
    expect(unusedSummary([merged, work])).toBe('2 unused worktrees (1 merged)')
    expect(unusedSummary([merged])).toBe('1 unused worktree (1 merged)')
  })

  it('the Changes notice only for worktrees holding work', () => {
    expect(unusedWorkNotice([wt({ removable: true, into: 'main', ahead: 0, dirty: 0 })])).toBeNull()
    expect(unusedWorkNotice([wt({ removable: false, into: 'main', ahead: 2, dirty: 0 }), wt({ removable: false, into: 'main', ahead: 0, dirty: 3 })])).toBe("2 unused worktrees have work that isn't on main")
  })
  it('nothing to remove anyway when git could not count it', () => {
    expect(lostByRemoving(wt({ removable: false, into: 'main', reason: "git couldn't check hive/x" }))).toBeNull()
    expect(unusedState(wt({ removable: false, into: 'main', reason: "git couldn't check hive/x" }))).toBe("git couldn't check hive/x")
  })
})
