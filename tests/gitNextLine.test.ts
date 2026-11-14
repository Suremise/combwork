// HI-3116 (design HI-3116/s19): a Git lane's next card started while the slot is still on the last card's line (its
// builder busy since that card's Done). The in-place preparation makes the next line at the base by two ref
// transactions, read back, changing no file or index entry; refused, nothing written, whenever it can't prove that safe;
// its own partial state carried on, anything else left alone; below git 2.46 it waits for its builder. And the off-line
// advice never names a branch that isn't there, its arguments PowerShell-safe. Real git, the real pool and runtime.
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { B1, R1, commit, moved, refusedBy, setup, sh, type Env } from './workflow/harness'
import { preset } from '../src/shared/workflow/options'
import { boardFile } from '../src/main/boardStore'
import { fileSlotConn, NOT_IN_PLACE, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { forgetOffLine } from '../src/main/slotCards'
import { lineAtBaseHooks } from '../src/main/platform/gitWorkspacePort'
import { gitTool, setGitToolForTests } from '../src/main/gitTool'
import { shellLine } from '../src/shared/workflow/queue'
import { tempDir } from './tempDir'

const closers: (() => void | Promise<void>)[] = []
let env: Env | null = null
// As Combwork's own git check finds it at startup (a test process never runs that check): this git's version.
const realGit = { ...gitTool(), state: 'ok' as const, version: execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)![0] }
setGitToolForTests(realGit)
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
  env?.close()
  env = null
  forgetOffLine()
  lineAtBaseHooks.beforeCreate = null
  lineAtBaseHooks.afterCreate = null
  setGitToolForTests(realGit)
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
const ref = (cwd: string, name: string): string | null => {
  try {
    return git(cwd, 'rev-parse', '--verify', '-q', name)
  } catch {
    return null
  }
}

/** Card 1 of a lane through to Done (merged as `finish` says) while the slot stays on its line; card 2 started. */
async function world(finish: 'merge' | 'squash' | 'ff') {
  const e = (env = setup({ ...preset('git', 'pair'), finish: 'agentMerges', preChecks: [], mergeChecks: [], folder: 'slots' as const }, { autoRun: false }))
  const conn = fileSlotConn(boardFile(e.home))
  const store = new SlotStore(conn, 'p-test')
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const pool = new SlotPool({ store, project: e.project, root: join(e.home, 'slot-root'), options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 1, cap: () => 4, runner: async () => ({ ok: true, exitCode: 0, logPath: null, settled: true }), settle: async () => true, holder, sessionIn: () => null })
  closers.push(async () => {
    await pool.close()
    conn.close()
  })
  const [c1, c2] = [1, 2].map((n) => e.wf.createCard({ title: `Card ${n}` }))
  e.wf.startLane('L', [c1.id, c2.id], 'R1')
  const lent = await pool.lend({ lane: 'L', agent: 'B1' }, { target: 'main' })
  if (!lent.ok) throw new Error(JSON.stringify(lent))
  e.wf.cfg.slotFor = async () => ({ slot: lent.slot.name, folder: lent.slot.folder, lease: lent.lease.id, fresh: false })
  e.wf.cfg.slotUnused = async () => undefined
  const folder = lent.slot.folder
  moved(await e.wf.start(c1.key, B1))
  const s1 = e.wf.state(c1.id).started!
  await pool.prepare(lent.lease.id, { line: s1.line!, base: s1.base!, install: false, target: 'main' })
  commit(folder, { 'one.txt': 'one\n' }, 'card 1 work')
  moved(await e.wf.submit(c1.key, B1, { summary: 'one' }))
  moved(await e.wf.startReview(c1.key, R1))
  moved(await e.wf.verdict(c1.key, R1, { pass: true, comment: 'ok' }))
  const rev = e.wf.state(c1.id).latest!.revision!
  if (finish === 'merge') git(e.project, 'merge', '-q', '--no-ff', '-m', 'merge card 1', rev)
  else if (finish === 'ff') git(e.project, 'merge', '-q', '--ff-only', rev)
  else {
    git(e.project, 'merge', '-q', '--squash', rev)
    git(e.project, 'commit', '-q', '-m', 'card 1 (squashed)')
  }
  moved(await e.wf.reportMerge(c1.key, B1))
  expect(e.wf.state(c1.id).stage).toBe('done')
  moved(await e.wf.start(c2.key, B1))
  const s2 = e.wf.state(c2.id).started!
  const line1 = `refs/heads/${s1.line!}`
  const line2 = `refs/heads/${s2.line!}`
  /** The in-place preparation as slotCards asks it first (its builder busy: never its waiting `ready`). */
  const inPlace = () => pool.prepare(lent.lease.id, { line: s2.line!, base: s2.base!, install: false, target: 'main', ready: async () => 'its builder is busy', inPlace: async () => null })
  /** Its waiting preparation, once its builder is quiet. */
  const waiting = () => pool.prepare(lent.lease.id, { line: s2.line!, base: s2.base!, install: false, target: 'main', ready: async () => null })
  /** Every byte the step must never change: the index, the work tree's files, and git's view of them. */
  const bytes = () => ({ index: readFileSync(join(sh(folder, 'rev-parse', '--absolute-git-dir'), 'index')).toString('base64'), files: sh(folder, 'ls-files', '-s'), status: sh(folder, 'status', '--porcelain=v1', '-uall'), one: readFileSync(join(folder, 'one.txt'), 'utf8') })
  return { e, pool, store, lent, folder, c1, c2, s1, s2, line1, line2, inPlace, waiting, bytes }
}

describe("a Git lane's next line made in place on the last card's line (HI-3116)", { timeout: 120_000 }, () => {
  it.each(['merge', 'squash', 'ff'] as const)('%s: made at the base, HEAD on it, no file or index byte changed, the uncommitted edit kept', async (finish) => {
    const w = await world(finish)
    expect(sh(w.folder, 'symbolic-ref', 'HEAD')).toBe(w.line1)
    const old = ref(w.folder, w.line1)
    // B1, at work at once: an edit not committed yet.
    writeFileSync(join(w.folder, 'two.txt'), 'two, being written\n')
    const before = w.bytes()
    const r = await w.inPlace()
    expect(r).toMatchObject({ ok: true })
    expect(sh(w.folder, 'symbolic-ref', 'HEAD')).toBe(w.line2)
    expect(ref(w.folder, w.line2)).toBe(w.s2.base)
    expect(ref(w.folder, w.line1)).toBe(old)
    expect(w.bytes().files).toBe(before.files)
    expect(w.bytes().one).toBe(before.one)
    expect(readFileSync(join(w.folder, 'two.txt'), 'utf8')).toBe('two, being written\n')
    expect(sh(w.folder, 'status', '--porcelain=v1', '-uall')).toBe('?? two.txt')
    // B1 commits and submits: its own work alone, on its own line (the squash case never takes card 1's again).
    commit(w.folder, { 'two.txt': 'two\n' }, 'card 2 work')
    moved(await w.e.wf.submit(w.c2.key, B1, { summary: 'two' }))
    expect(w.e.wf.state(w.c2.id).latest!.files.map((f) => f.path)).toEqual(['two.txt'])
    // Done in place once: a repeat prepares nothing more (the read-back's line, as `there`).
    expect(await w.inPlace()).toMatchObject({ ok: true })
  })

  it("refused, nothing written, when the old line's files aren't the base's (more on it than was merged)", async () => {
    const w = await world('merge')
    commit(w.folder, { 'extra.txt': 'more\n' }, 'more on card 1 line')
    const old = ref(w.folder, w.line1)
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line1), ref(w.folder, w.line2)]).toEqual([w.line1, old, null])
    expect(w.bytes()).toEqual(before)
  })

  it('a commit on the old line between the tree read and T1: T1 refused as a whole, nothing written', async () => {
    const w = await world('merge')
    let moved1 = ''
    lineAtBaseHooks.beforeCreate = async () => {
      git(w.folder, 'commit', '-q', '--allow-empty', '-m', 'meanwhile')
      moved1 = ref(w.folder, w.line1)!
    }
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line1), ref(w.folder, w.line2)]).toEqual([w.line1, moved1, null])
    expect(w.bytes()).toEqual(before)
  })

  it('a commit on the old line between T1 and T2: kept there, its changes staged on the new line, no file changed', async () => {
    const w = await world('merge')
    let moved1 = ''
    lineAtBaseHooks.afterCreate = async () => {
      commit(w.folder, { 'late.txt': 'late\n' }, 'meanwhile, on the old line')
      moved1 = ref(w.folder, w.line1)!
    }
    const r = await w.inPlace()
    expect(r).toMatchObject({ ok: true })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line1), ref(w.folder, w.line2)]).toEqual([w.line2, moved1, w.s2.base])
    expect(readFileSync(join(w.folder, 'late.txt'), 'utf8')).toBe('late\n')
    // Its content is staged on the new line: never taken as already committed there.
    expect(sh(w.folder, 'diff', '--cached', '--name-only')).toBe('late.txt')
  })

  it('the new line advanced before T2: T2 refused as a whole, HEAD left on the old line, the line left as it is (not ours to move)', async () => {
    const w = await world('merge')
    let advanced = ''
    lineAtBaseHooks.afterCreate = async () => {
      advanced = git(w.folder, 'commit-tree', `${w.s2.base}^{tree}`, '-p', w.s2.base!, '-m', 'someone else')
      git(w.folder, 'update-ref', w.line2, advanced)
    }
    const old = ref(w.folder, w.line1)
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line1), ref(w.folder, w.line2)]).toEqual([w.line1, old, advanced])
    expect(w.bytes()).toEqual(before)
    // Not provably ours any more: the next pass leaves it alone too.
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect(ref(w.folder, w.line2)).toBe(advanced)
  })

  it("HEAD switched before T2: refused, nothing attached; the next pass carries its own line on (T1's partial state)", async () => {
    const w = await world('merge')
    lineAtBaseHooks.afterCreate = async () => {
      git(w.folder, 'symbolic-ref', 'HEAD', 'refs/heads/main-elsewhere')
    }
    git(w.folder, 'branch', 'main-elsewhere', w.s2.base!)
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line2)]).toEqual(['refs/heads/main-elsewhere', w.s2.base])
    expect(w.bytes().files).toBe(before.files)
    // Back on the old line (as it was): the line made for this lease is proved its own and attached.
    lineAtBaseHooks.afterCreate = null
    git(w.folder, 'symbolic-ref', 'HEAD', w.line1)
    expect(await w.inPlace()).toMatchObject({ ok: true })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line2)]).toEqual([w.line2, w.s2.base])
  })

  it.each([
    ['made by hand (another reflog)', (w: Awaited<ReturnType<typeof world>>) => git(w.folder, 'branch', w.s2.line!, w.s2.base!)],
    ["another lease's", (w: Awaited<ReturnType<typeof world>>) => git(w.folder, 'update-ref', '-m', 'combwork: next line for lease l-other', w.line2, w.s2.base!)],
    ['no reflog', (w: Awaited<ReturnType<typeof world>>) => git(w.folder, '-c', 'core.logAllRefUpdates=false', 'update-ref', w.line2, w.s2.base!)]
  ])('a line already there %s: never attached or moved; nothing written', async (_what, make) => {
    const w = await world('merge')
    make(w)
    const at = ref(w.folder, w.line2)
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line2)]).toEqual([w.line1, at])
    expect(w.bytes()).toEqual(before)
  })

  it("HEAD already naming the line (T2 applied, its answer lost): prepared only while that line resolves (HR2's round 1)", async () => {
    const w = await world('merge')
    expect(await w.inPlace()).toMatchObject({ ok: true })
    // The valid case: the line there at the base, or past it by B1's commits: prepared, its head the revision.
    commit(w.folder, { 'two.txt': 'two\n' }, 'card 2 work')
    const tip = ref(w.folder, w.line2)
    expect(await w.inPlace()).toEqual({ ok: true, revision: tip })
    // The line gone (HEAD still names it): never prepared, nothing written.
    git(w.folder, 'update-ref', '-d', w.line2)
    const before = w.bytes()
    const gone = await w.inPlace()
    expect(gone).toHaveProperty('error')
    expect(gone).not.toHaveProperty('ok')
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line2)]).toEqual([w.line2, null])
    expect(w.bytes()).toEqual(before)
    // Unreadable (a ref file that isn't a ref): an error too, never prepared.
    const refFile = join(sh(w.folder, 'rev-parse', '--git-common-dir'), ...w.line2.split('/'))
    writeFileSync(refFile, 'not a ref\n')
    const unreadable = await w.inPlace()
    expect(unreadable).toHaveProperty('error')
    expect(unreadable).not.toHaveProperty('ok')
  })

  it('below git 2.46: no git run, nothing written; the waiting preparation, its builder quiet, makes the line', async () => {
    const w = await world('merge')
    setGitToolForTests({ state: 'ok', version: '2.45.2' })
    const before = w.bytes()
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    expect([sh(w.folder, 'symbolic-ref', 'HEAD'), ref(w.folder, w.line2)]).toEqual([w.line1, null])
    expect(w.bytes()).toEqual(before)
    setGitToolForTests(realGit)
    expect(await w.waiting()).toMatchObject({ ok: true })
    expect(sh(w.folder, 'symbolic-ref', 'HEAD')).toBe(w.line2)
  })
})

describe("the off-line advice (HI-3116): never a branch that isn't there", { timeout: 120_000 }, () => {
  it("its line missing: make it from where the card started; its line there: switch back", async () => {
    const w = await world('squash')
    w.e.wf.cfg.slotHeld = undefined
    setGitToolForTests({ state: 'ok', version: '2.45.2' })
    expect(await w.inPlace()).toEqual({ retry: NOT_IN_PLACE })
    commit(w.folder, { 'two.txt': 'two\n' }, 'card 2 work, on card 1 line')
    const missing = refusedBy(await w.e.wf.submit(w.c2.key, B1, { summary: 'two' }), 'platform.offLine')
    expect(missing.next).toContain(`git switch -c ${w.s2.line} ${w.s2.base}`)
    expect(missing.next).toContain(`made on ${w.s1.line}`)
    expect(missing.next).not.toMatch(new RegExp(`git switch ${w.s2.line}\\b`))
    git(w.folder, 'branch', w.s2.line!, w.s2.base!)
    const there = refusedBy(await w.e.wf.submit(w.c2.key, B1, { summary: 'two' }), 'platform.offLine')
    expect(there.next).toContain(`Switch back with git switch ${w.s2.line}`)
  })

  it("its commands' branch names reach git as written in PowerShell: $, a backtick and an apostrophe", () => {
    const repo = tempDir('cw-offline-quote-')
    git(repo, 'init', '-q', '-b', 'main', '.')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'one')
    const head = git(repo, 'rev-parse', 'HEAD')
    for (const name of ['cw/AM/AM-2-$HOME-cost', 'cw/AM/AM-2-`date`-tick', "cw/AM/AM-2-o'clock"]) {
      git(repo, 'branch', name)
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `git -C ${shellLine([repo])} rev-parse --verify --quiet ${shellLine([`refs/heads/${name}`])}`], { encoding: 'utf8', windowsHide: true })
      expect([name, r.stdout.trim()]).toEqual([name, head])
    }
  })
})
