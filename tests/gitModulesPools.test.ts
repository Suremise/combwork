// Submodules and Git LFS from the places Combwork makes folders (HI-1182): a slot's warming and its card's preparation,
// a review or check copy's make and reset, and the merge queue's folder (queueChecks' step). Real pools on a real
// combwork.db and a repository with a local submodule; the step runs as the app's runner runs it (gitFilesExec, the
// file protocol allowed by the run's own environment, composed after Combwork's). Each fixture is one of the design's
// (HI-1182/s10–s16): the step before the setup, before every ready (a failure then a retry with no switch; the setting
// off then on in a retained folder), changed and removed gitlinks, and a project with neither running no step.
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { COPIES_DIR, CopyPool, CopyStore } from '../src/main/copies'
import { dirty } from '../src/main/platform/git'
import { gitWorkspacePort } from '../src/main/platform/gitWorkspacePort'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { queueChecks } from '../src/main/workflow/queueChecks'
import { commit, gitRepo, sh } from './workflow/harness'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

/** The run's git config: the test's own (no system config), never the machine's. */
const globalConfig = join(tempDir('gitmodules-pools-config-'), 'gitconfig')
writeFileSync(globalConfig, '[user]\n\tname = Combwork Test\n\temail = test@example.invalid\n[core]\n\tautocrlf = false\n')
/** The run's environment: the test's, with local (file) submodule URLs allowed as a user's own command-line config would. */
const RUN_ENV: Record<string, string> = { ...baseEnv(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

/** git with the file protocol allowed (making fixtures only). */
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A workspace with a project on main whose `libs/s` is a local submodule at its first commit (v.txt "1"). */
function project(o: { sub?: boolean } = {}) {
  const base = tempDir('gitmodules-pools-')
  const ws = join(base, 'ws')
  const p = gitRepo(join(ws, 'project'))
  const sub = gitRepo(join(base, 'sub'))
  commit(sub, { 'v.txt': '1\n' }, 'one')
  const one = sh(sub, 'rev-parse', 'HEAD')
  if (o.sub !== false) {
    g(p, 'submodule', 'add', '-q', sub, 'libs/s')
    g(p, 'commit', '-q', '-m', 'sub')
  }
  return { base, ws, p, sub, one }
}

type Runs = (SlotRun & SlotRunEnd)[]

/** The app's runner, for tests: the step as the app runs it, any other command a success; `fail` fails the next step once. */
function runner(runs: Runs, ctl: { fail?: boolean } = {}) {
  return async (r: SlotRun): Promise<SlotRunEnd> => {
    let end: SlotRunEnd = { ok: true, exitCode: 0, logPath: null, settled: true }
    if (r.files) {
      const x = r.files.tool.exec({ spawn, env: { ...RUN_ENV, ...r.env }, log: { write: () => undefined }, timeoutMs: 120_000 })
      try {
        const o = ctl.fail ? { ok: false as const, error: 'git submodule update: failed on purpose' } : await r.files.tool.prepare(x, r.files.step)
        ctl.fail = false
        end = o.ok ? end : { ok: false, exitCode: 1, error: o.error, logPath: null, settled: true }
      } finally {
        x.close()
      }
    }
    runs.push({ ...r, ...end })
    return end
  }
}

const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }

function slots(ws: string, p: string, runs: Runs, opts: { setup: string; archive: string; copy: string; gitFiles?: boolean }, ctl: { fail?: boolean } = {}) {
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-gm')
  const pool = new SlotPool({ store, project: p, root: join(`${ws}.worktrees`, 'project'), options: async () => ({ ...opts }), builders: () => 2, cap: () => 12, runner: runner(runs, ctl), settle: async () => true, holder, removeIdle: () => true, removeSkillCopies: async () => undefined })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return pool
}

function copies(ws: string, p: string, runs: Runs, opts: { setup: string; archive: string; copy: string; gitFiles?: boolean }) {
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = new CopyStore(fileSlotConn(boardFile(ws)), 'p-gm')
  const pool = new CopyPool({
    store,
    project: p,
    dir: join(`${ws}.worktrees`, 'project', COPIES_DIR),
    options: async () => ({ ...opts }),
    size: () => 1,
    runner: runner(runs),
    settle: async () => true,
    holder,
    profile: 'profile-1',
    runIn: () => null,
    holderBusy: () => null,
    leaseOver: () => null,
    reviewOn: () => true,
    quietWaitMs: () => 10 * 60_000
  })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return pool
}

const v = (folder: string): string => readFileSync(join(folder, 'libs', 's', 'v.txt'), 'utf8')

describe('slots', { timeout: 120_000 }, () => {
  it("a new slot's submodules are set up before its setup; a card's line at another gitlink gets that one", async () => {
    const { ws, p, sub } = project()
    const runs: Runs = []
    const pool = slots(ws, p, runs, { setup: 'npm ci', archive: '', copy: '' })
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    expect(runs.map((x) => x.what)).toEqual(['gitFiles', 'setup'])
    expect(v(r.slot.folder)).toBe('1\n')
    // A card's branch where the submodule moved on.
    commit(sub, { 'v.txt': '2\n' }, 'two')
    g(p, 'switch', '-q', '-c', 'cw/AM/AM-1-x')
    g(join(p, 'libs', 's'), 'pull', '-q', 'origin', 'main')
    g(p, 'commit', '-q', '-am', 'sub at 2')
    g(p, 'switch', '-q', 'main')
    const prepared = await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-x', base: sh(p, 'rev-parse', 'main'), install: false })
    expect(prepared).toMatchObject({ ok: true })
    expect(v(r.slot.folder)).toBe('2\n')
    expect(await dirty(r.slot.folder)).toEqual([])
  })

  it('a step that fails is run again by the next prepare on the same line, with no switch', async () => {
    const { ws, p } = project()
    const runs: Runs = []
    const ctl = { fail: false }
    const pool = slots(ws, p, runs, { setup: '', archive: '', copy: '' }, ctl)
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    const main = sh(p, 'rev-parse', 'main')
    ctl.fail = true
    expect(await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-y', base: main, install: false })).toEqual({ error: 'git submodule update: failed on purpose' })
    expect(sh(r.slot.folder, 'branch', '--show-current')).toBe('cw/AM/AM-1-y')
    const before = runs.length
    expect(await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-y', base: main, install: false })).toMatchObject({ ok: true })
    expect(runs.slice(before).map((x) => [x.what, x.ok])).toEqual([['gitFiles', true]])
  })

  it('off, nothing runs; turned on, a retained slot already on its line is set up at its next prepare', async () => {
    const { ws, p } = project()
    const runs: Runs = []
    const opts = { setup: '', archive: '', copy: '', gitFiles: false }
    const pool = slots(ws, p, runs, opts)
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    const main = sh(p, 'rev-parse', 'main')
    expect(await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-z', base: main, install: false })).toMatchObject({ ok: true })
    expect(runs).toEqual([])
    expect(existsSync(join(r.slot.folder, 'libs', 's', 'v.txt'))).toBe(false)
    opts.gitFiles = true
    expect(await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-z', base: main, install: false })).toMatchObject({ ok: true })
    expect(runs.map((x) => x.what)).toEqual(['gitFiles'])
    expect(v(r.slot.folder)).toBe('1\n')
  })

  it('a project with neither runs no step', async () => {
    const { ws, p } = project({ sub: false })
    const runs: Runs = []
    const pool = slots(ws, p, runs, { setup: 'npm ci', archive: '', copy: '' })
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-n', base: sh(p, 'rev-parse', 'main'), install: false })
    await pool.prepare(r.lease.id, { line: 'cw/AM/AM-1-n', base: sh(p, 'rev-parse', 'main'), install: false })
    expect(runs.map((x) => x.what)).toEqual(['setup'])
  })

  it("uncommitted work inside a submodule counts as uncommitted, named by the submodule's path (submit.clean)", async () => {
    const { ws, p } = project()
    const pool = slots(ws, p, [], { setup: '', archive: '', copy: '' })
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    expect(await dirty(r.slot.folder)).toEqual([])
    writeFileSync(join(r.slot.folder, 'libs', 's', 'v.txt'), 'edited\n')
    expect(await dirty(r.slot.folder)).toEqual(['libs/s'])
  })
})

describe('review and check copies', { timeout: 120_000 }, () => {
  it('are set up at their revision before their setup; reset to a changed gitlink, then to none, the removed one goes', async () => {
    const { ws, p, sub } = project()
    const at1 = sh(p, 'rev-parse', 'HEAD')
    commit(sub, { 'v.txt': '2\n' }, 'two')
    g(join(p, 'libs', 's'), 'pull', '-q', 'origin', 'main')
    g(p, 'commit', '-q', '-am', 'sub at 2')
    const at2 = sh(p, 'rev-parse', 'HEAD')
    g(p, 'rm', '-q', 'libs/s')
    g(p, 'rm', '-q', '-f', '.gitmodules')
    g(p, 'commit', '-q', '-m', 'no sub')
    const at3 = sh(p, 'rev-parse', 'HEAD')
    const runs: Runs = []
    const pool = copies(ws, p, runs, { setup: 'npm ci', archive: '', copy: '' })
    const lease = async (revision: string, card: number) => {
      const got = await pool.leaseCopy({ kind: 'check', card, revision, agent: 'a1', ref: null })
      if (!got.ok) throw new Error(JSON.stringify(got.refusal))
      return got
    }
    const a = await lease(at1, 1)
    expect(runs.map((x) => x.what)).toEqual(['gitFiles', 'setup'])
    expect(v(a.copy.folder)).toBe('1\n')
    await pool.returnCopy(a.lease.id, 'runEnded')
    const b = await lease(at2, 2)
    expect(b.copy.name).toBe(a.copy.name)
    expect(v(b.copy.folder)).toBe('2\n')
    await pool.returnCopy(b.lease.id, 'runEnded')
    const c = await lease(at3, 3)
    expect(existsSync(join(c.copy.folder, 'libs', 's'))).toBe(false)
    expect(sh(c.copy.folder, 'status', '--porcelain', '--ignored')).toBe('')
  })
})

describe('review and check copies: a doubtful leftover (HR2’s round 1)', { timeout: 120_000 }, () => {
  /** A project whose submodule a later commit removes, a copy leased at the first and returned: [pool, copy folder, the later revision]. */
  async function returnedCopy() {
    const { ws, p } = project()
    const at1 = sh(p, 'rev-parse', 'HEAD')
    g(p, 'rm', '-q', 'libs/s')
    g(p, 'rm', '-q', '-f', '.gitmodules')
    g(p, 'commit', '-q', '-m', 'no sub')
    const at2 = sh(p, 'rev-parse', 'HEAD')
    const pool = copies(ws, p, [], { setup: '', archive: '', copy: '' })
    const a = await pool.leaseCopy({ kind: 'check', card: 1, revision: at1, agent: 'a1', ref: null })
    if (!a.ok) throw new Error(JSON.stringify(a.refusal))
    await pool.returnCopy(a.lease.id, 'runEnded')
    return { pool, folder: a.copy.folder, at2 }
  }

  it('another repository where the removed submodule was fails the lease, naming it, untouched; moved away, the next lease is ready', async () => {
    const { pool, folder, at2 } = await returnedCopy()
    // The submodule's checkout replaced by someone's own repository (the copy's reset leaves a nested repository).
    rmSync(join(folder, 'libs', 's'), { recursive: true, force: true })
    g(folder, 'init', '-q', join(folder, 'libs', 's'))
    writeFileSync(join(folder, 'libs', 's', 'mine.txt'), 'mine\n')
    const b = await pool.leaseCopy({ kind: 'check', card: 2, revision: at2, agent: 'a1', ref: null })
    expect(b).toMatchObject({ ok: false, refusal: { why: 'setupFailed', error: expect.stringContaining('removed submodule libs/s') } })
    expect(readFileSync(join(folder, 'libs', 's', 'mine.txt'), 'utf8')).toBe('mine\n')
    // Moved away, the failed copy goes as any copy whose setup failed does (tidy), and the next lease is ready.
    const away = join(tempDir('gitmodules-moved-'), 's')
    renameSync(join(folder, 'libs', 's'), away)
    await pool.tidy()
    const c = await pool.leaseCopy({ kind: 'check', card: 3, revision: at2, agent: 'a1', ref: null })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    expect(readFileSync(join(away, 'mine.txt'), 'utf8')).toBe('mine\n')
  })

  it("a junction there is removed by the copy's reset as a link (git clean), its target untouched", async () => {
    const { pool, folder, at2 } = await returnedCopy()
    const target = join(tempDir('gitmodules-precious-'), 'precious')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep\n')
    rmSync(join(folder, 'libs', 's'), { recursive: true, force: true })
    symlinkSync(target, join(folder, 'libs', 's'), 'junction')
    const b = await pool.leaseCopy({ kind: 'check', card: 2, revision: at2, agent: 'a1', ref: null })
    expect(b.ok, JSON.stringify(b)).toBe(true)
    expect(existsSync(join(folder, 'libs', 's'))).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep\n')
  })
})

describe("the merge queue's folder", { timeout: 120_000 }, () => {
  it('gets its submodules as one of the queue’s runs before its checks; off, or with neither, no run', async () => {
    const { p } = project()
    const folder = join(tempDir('gitmodules-queue-'), 'q')
    g(p, 'worktree', 'add', '-q', '--detach', folder, 'HEAD')
    const started: string[] = []
    let on = true
    const checks = queueChecks({
      spawn,
      env: () => RUN_ENV,
      logDir: tempDir('gitmodules-queue-logs-'),
      timeoutMs: () => 120_000,
      setupCommand: () => '',
      gitFilesOn: async () => on,
      project: p,
      files: gitWorkspacePort.files,
      runs: { start: (r) => (started.push(r.title), String(started.length)), finish: () => undefined, counts: () => undefined }
    })
    const ctx = { card: 'AM-1', number: 1, revision: sh(p, 'rev-parse', 'HEAD') }
    on = false
    expect(await checks.gitFiles(folder, ctx)).toMatchObject({ ok: true, skipped: true })
    expect(started).toEqual([])
    on = true
    const r = await checks.gitFiles(folder, ctx)
    expect(r.ok, r.output).toBe(true)
    expect(started).toEqual([`AM-1 · git submodule update · git lfs pull · ${ctx.revision.slice(0, 7)}`])
    expect(v(folder)).toBe('1\n')
    const plain = project({ sub: false })
    const f2 = join(tempDir('gitmodules-queue-'), 'q')
    g(plain.p, 'worktree', 'add', '-q', '--detach', f2, 'HEAD')
    expect(await checks.gitFiles(f2, ctx)).toMatchObject({ ok: true, skipped: true })
    expect(started).toHaveLength(1)
  })
})
