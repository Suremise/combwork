// The slot pool's git commands, traced (HI-2786, R4 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1 and R2.3): every
// worktree's inspection, creation, preparation, detaching, move onto another target, recreation and guarded removal, as the
// pool runs them through the workspace lifecycle port, are the same git commands (folder, argv, order) as the code before
// the port ran. The expected traces were recorded at the revision before the port (a4a488fb7) with
// `CW_RECORD_SLOT_TRACES=1 npx vitest run tests/slotTraces.test.ts`, into tests/fixtures/slotTraces.json; a trace that
// differs is a behaviour change, which an R card never makes (a change found needed is its own card). HI-1182 was one: a
// made or prepared slot reads whether its revision uses submodules or Git LFS (one `ls-files`), and runs nothing more
// where it uses neither.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { gitTestHooks } from '../src/main/git'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder, type SlotRunEnd } from '../src/main/slots'
import { commit, gitRepo, sh } from './workflow/harness'

const FIXTURE = join(__dirname, 'fixtures', 'slotTraces.json')
const RECORD = process.env.CW_RECORD_SLOT_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

const closers: (() => void)[] = []
afterEach(() => {
  gitTestHooks.started = undefined
  for (const c of closers.splice(0)) c()
})

/** A workspace with a combwork.db, a project on main (git-ignoring .env, copied into each new slot) and its pool. */
function world() {
  const ws = join(tempDir('slot-traces-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  commit(project, { '.gitignore': '.env\n' }, 'ignore')
  writeFileSync(join(project, '.env'), 'x')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-trace')
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const done: SlotRunEnd = { ok: true, exitCode: 0, logPath: null, settled: true }
  const pool = new SlotPool({
    store,
    project,
    root: join(`${ws}.worktrees`, 'project'),
    options: async () => ({ setup: '', archive: '', copy: '.env' }),
    builders: () => 2,
    cap: () => 12,
    runner: async () => done,
    settle: async () => true,
    holder,
    removeIdle: () => true,
    removeSkillCopies: async () => undefined
  })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return { ws, project, pool, store }
}

/** The git commands `fn` started, each `<folder> :: <args>`, with the workspace's folder and full ids made stable. */
async function traced(ws: string, fn: () => Promise<unknown>): Promise<string[]> {
  const ran: string[] = []
  const at = resolve(ws).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string => s.replace(/\\/g, '/').toLowerCase().split(at).join('<ws>').replace(/\b[0-9a-f]{40}\b/g, '<id>')
  gitTestHooks.started = (cwd, args) => void ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  try {
    await fn()
  } finally {
    gitTestHooks.started = undefined
  }
  return ran
}

/** Checks (or, recording, keeps) the trace of one step. */
function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

describe("the slot pool's git commands through the workspace lifecycle port (HI-2786)", { timeout: 90_000 }, () => {
  afterEach(() => {
    if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
  })

  it('lending, preparing, releasing, lending again and removing a slot', async () => {
    const { ws, project, pool } = world()
    const main = sh(project, 'rev-parse', 'main')
    let lease = ''
    let folder = ''
    same('lend a new slot', await traced(ws, async () => {
      const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
      if (!r.ok) throw new Error(JSON.stringify(r.refusal))
      lease = r.lease.id
      folder = r.slot.folder
    }))
    same('prepare a new line', await traced(ws, () => pool.prepare(lease, { line: 'cw/AM/AM-1-one', base: main, install: false })))
    same('prepare the line it is on', await traced(ws, () => pool.prepare(lease, { line: 'cw/AM/AM-1-one', base: main, install: false })))
    commit(folder, { 'a.txt': 'a\n' }, 'its work')
    sh(folder, 'switch', '-q', '--detach', 'main')
    same('prepare a line it has', await traced(ws, () => pool.prepare(lease, { line: 'cw/AM/AM-1-one', base: main, install: false })))
    same('release, settled and detached', await traced(ws, async () => {
      await pool.release(lease, 'done')
      await pool.refresh()
    }))
    same('lend it again', await traced(ws, async () => {
      const r = await pool.lend({ agent: 'a1', card: 2 }, { target: 'main' })
      if (!r.ok) throw new Error(JSON.stringify(r.refusal))
      lease = r.lease.id
    }))
    await pool.release(lease, 'done')
    await pool.refresh()
    // Its card's work isn't in main: kept as unmerged.
    sh(folder, 'switch', '-q', 'cw/AM/AM-1-one')
    same('remove, kept unmerged', await traced(ws, () => pool.remove('slot-a')))
    sh(folder, 'switch', '-q', '--detach', 'main')
    writeFileSync(join(folder, 'wip.txt'), 'wip\n')
    same('remove, kept dirty', await traced(ws, () => pool.remove('slot-a')))
    rmSync(join(folder, 'wip.txt'))
    same('remove', await traced(ws, () => pool.remove('slot-a')))
  })

  it("a free slot gone from disk made again as it's lent, and one moved onto another target", async () => {
    const { ws, project, pool } = world()
    const r = await pool.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    await pool.release(r.lease.id, 'done')
    await pool.refresh()
    rmSync(r.slot.folder, { recursive: true, force: true })
    same('lend a slot gone from disk', await traced(ws, async () => {
      const again = await pool.lend({ agent: 'a1', card: 2 }, { target: 'main' })
      if (!again.ok) throw new Error(JSON.stringify(again.refusal))
      await pool.release(again.lease.id, 'done')
      await pool.refresh()
    }))
    sh(project, 'branch', '1.2.0', 'main')
    sh(project, 'checkout', '-q', '1.2.0')
    commit(project, { 'release.txt': '1.2.0\n' }, '1.2.0 only')
    sh(project, 'checkout', '-q', 'main')
    const head = sh(r.slot.folder, 'rev-parse', 'HEAD')
    same('retarget', await traced(ws, () => pool.retarget('slot-a', { folder: r.slot.folder, target: 'main', head }, 'main', '1.2.0', () => true)))
  })

  it("a carried slot's folder gone, made again on its line", async () => {
    const { ws, project, pool } = world()
    const folder = join(`${ws}.worktrees`, 'project', 'kept')
    sh(project, 'worktree', 'add', '-q', '-b', 'cw/kept', folder)
    const lease = (await pool.carry('a-kept', { name: 'kept', folder, target: 'main' }))!
    rmSync(folder, { recursive: true, force: true })
    const to = join(`${ws}.worktrees`, 'project', 'kept-again')
    same('recreate a gone slot', await traced(ws, () => pool.recreateGone('kept', { lease: lease.id, folder }, to, 'cw/kept', async () => [])))
  })
})
