// Copies and the providers' context reads, traced (HI-2789, R5 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1): a
// check copy made, returned, reset at another revision (its exact revision, nothing else) and removed, through the
// workspace lifecycle port; the trust check's roots (a main working tree, a linked worktree, a folder in no repository),
// Claude Code's memory base and the skill copies' exclude, through the repository context port. The same git commands
// (folder, argv, order) as the code before the ports: the expected traces were recorded at 5cd46f422 (each context read's answer with it) with
// `CW_RECORD_CONTEXT_TRACES=1 npx vitest run tests/contextTraces.test.ts`, into tests/fixtures/contextTraces.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { gitTestHooks } from '../src/main/git'
import { COPIES_DIR, CopyPool, CopyStore } from '../src/main/copies'
import { fileSlotConn, type OpHolder, type SlotRunEnd } from '../src/main/slots'
import { trustTargets } from '../src/main/accounts'
import { memoryBase } from '../src/main/providers/claude/memoryDir'
import { excludeCopies } from '../src/main/providers/common'
import { commit, gitRepo, sh } from './workflow/harness'

const FIXTURE = join(__dirname, 'fixtures', 'contextTraces.json')
const RECORD = process.env.CW_RECORD_CONTEXT_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

const closers: (() => void)[] = []
afterEach(() => {
  gitTestHooks.started = undefined
  for (const c of closers.splice(0)) c()
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})

/**
 * The git commands `fn` started, each `<folder> :: <args>`, with the test's folder and full ids made stable; `answer`:
 * its answer too, as the last line (`=> <JSON>`), made stable the same way.
 */
async function traced(base: string, fn: () => Promise<unknown>, answer = false): Promise<string[]> {
  const ran: string[] = []
  const at = resolve(base).toLowerCase().replace(/\\/g, '/')
  const stable = (s: string): string => s.replace(/\\/g, '/').toLowerCase().split(at).join('<base>').replace(/\b[0-9a-f]{40}\b/g, '<id>')
  gitTestHooks.started = (cwd, args) => void ran.push(stable(`${resolve(cwd)} :: ${args.join(' ')}`))
  try {
    const v = await fn()
    if (answer) ran.push(stable(`=> ${JSON.stringify(v ?? null).replace(/\\\\/g, '/')}`))
  } finally {
    gitTestHooks.started = undefined
  }
  return ran
}

function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = trace
  else expect(trace, step).toEqual(expected()[step])
}

describe('copies and context reads through the ports (HI-2789)', { timeout: 90_000 }, () => {
  it('a check copy made, returned, reset at another revision and removed', async () => {
    const base = tempDir('context-traces-')
    const ws = join(base, 'ws')
    const project = gitRepo(join(ws, 'project'))
    commit(project, { '.gitignore': 'node_modules/\n' }, 'ignore')
    const dismiss = admitted(ws)
    workspaceDb(ws)
    const store = new CopyStore(fileSlotConn(boardFile(ws)), 'p-trace')
    const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
    const done: SlotRunEnd = { ok: true, exitCode: 0, logPath: null, settled: true }
    const pool = new CopyPool({
      store,
      project,
      dir: join(`${ws}.worktrees`, 'project', COPIES_DIR),
      options: async () => ({ setup: '', archive: '', copy: '' }),
      size: () => 2,
      runner: async () => done,
      settle: async () => true,
      holder,
      profile: 'profile-1',
      runIn: () => null,
      holderBusy: () => null,
      leaseOver: () => true,
      reviewOn: () => true,
      quietWaitMs: () => 0
    })
    closers.push(() => {
      store.conn.close()
      closeBoard(ws)
      dismiss()
    })
    const r1 = sh(project, 'rev-parse', 'HEAD')
    commit(project, { 'b.txt': 'b\n' }, 'b')
    let lease = ''
    let folder = ''
    same('lease a new copy', await traced(base, async () => {
      const l = await pool.leaseCopy({ kind: 'check', card: 7, revision: r1, agent: 'a1', ref: null })
      if (!l.ok) throw new Error(JSON.stringify(l.refusal))
      lease = l.lease.id
      folder = l.copy.folder
    }))
    same('return it', await traced(base, () => pool.returnCopy(lease, 'runEnded')))
    writeFileSync(join(folder, 'left.txt'), 'left\n')
    same('lease it again at another revision', await traced(base, async () => {
      const l = await pool.leaseCopy({ kind: 'check', card: 8, revision: sh(project, 'rev-parse', 'HEAD'), agent: 'a1', ref: null })
      if (!l.ok) throw new Error(JSON.stringify(l.refusal))
      lease = l.lease.id
    }))
    await pool.returnCopy(lease, 'runEnded')
    same('remove it', await traced(base, () => pool.remove('copy-1')))
  })

  it("the trust check's roots, Claude Code's memory base and the skill copies' exclude", async () => {
    const base = tempDir('context-traces-')
    const main = gitRepo(join(base, 'main'))
    const tree = join(base, 'tree')
    sh(main, 'worktree', 'add', '-q', '-b', 'side', tree)
    const none = join(base, 'none')
    mkdirSync(none)
    for (const [name, path] of [['main', main], ['tree', tree], ['none', none]] as const) {
      same(`trust root: ${name}`, await traced(base, () => trustTargets([{ name, path }]), true))
      same(`memory base: ${name}`, await traced(base, () => memoryBase(path), true))
    }
    same('exclude copies: tree', await traced(base, async () => (await excludeCopies(tree), readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')), true))
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('/.agents/skills/cw-*/')
  })
})
