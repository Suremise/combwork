// HI-3028: a review or check copy reset from a revision with a submodule (set up by the files step) to one with ordinary
// files at its path, on real git through the real copies pool. A forced checkout writes the files into the old
// submodule's folder and `clean -fd` leaves its `.git` file, so git run there saw the old clone as its repository. The
// Git port's reset now removes the copy's own submodule checkouts the revision doesn't keep first; their clones stay,
// and a later lease back at the submodule's revision sets it up again.
import { execFileSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { COPIES_DIR, CopyPool, CopyStore } from '../src/main/copies'
import { gitWorkspacePort } from '../src/main/platform/gitWorkspacePort'
import { fileSlotConn, type OpHolder, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { commit, gitRepo } from './workflow/harness'

void gitWorkspacePort
const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const globalConfig = join(tempDir('copy-sub-config-'), 'gitconfig')
writeFileSync(globalConfig, '[user]\n\tname = Combwork Test\n\temail = test@example.invalid\n[core]\n\tautocrlf = false\n')
/** The files step's environment: the test's global config, and local (file) submodule URLs allowed. */
const RUN_ENV: Record<string, string> = { ...baseEnv(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: RUN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** The copies' runner: the files step run for real, the rest a pass. */
async function runner(r: SlotRun): Promise<SlotRunEnd> {
  const end: SlotRunEnd = { ok: true, exitCode: 0, logPath: null, settled: true }
  if (!r.files) return end
  const x = r.files.tool.exec({ spawn, env: { ...RUN_ENV, ...r.env }, log: { write: () => undefined }, timeoutMs: 120_000 })
  try {
    const o = await r.files.tool.prepare(x, r.files.step)
    return o.ok ? end : { ok: false, exitCode: 1, error: o.error, logPath: null, settled: true }
  } finally {
    x.close()
  }
}
const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }

/** A project with submodule libs/s (at1), then the submodule vendored: its files ordinary ones at its path (at2). */
function project(): { pool: CopyPool; at1: string; at2: string } {
  const base = tempDir('copy-sub-')
  const ws = join(base, 'ws')
  const p = gitRepo(join(ws, 'project'))
  const sub = gitRepo(join(base, 'sub'))
  commit(sub, { 'v.txt': '1\n' }, 'one')
  g(p, 'submodule', 'add', '-q', sub, 'libs/s')
  g(p, 'commit', '-q', '-m', 'sub')
  const at1 = g(p, 'rev-parse', 'HEAD')
  g(p, 'rm', '-q', 'libs/s')
  g(p, 'rm', '-q', '-f', '.gitmodules')
  const at2 = commit(p, { 'libs/s/v.txt': 'vendored\n', 'libs/s/extra.txt': 'x\n' }, 'vendored')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = new CopyStore(fileSlotConn(boardFile(ws)), 'p-sub')
  const pool = new CopyPool({ store, project: p, dir: join(`${ws}.worktrees`, 'project', COPIES_DIR), options: async () => ({ setup: '', archive: '', copy: '' }), size: () => 1, runner, settle: async () => true, holder, profile: 'profile-1', runIn: () => null, holderBusy: () => null, leaseOver: () => null, reviewOn: () => true, quietWaitMs: () => 10 * 60_000 })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return { pool, at1, at2 }
}

/** The copy leased at `revision` for `card` and returned: its folder. */
async function leased(pool: CopyPool, card: number, revision: string, keep = false): Promise<string> {
  const r = await pool.leaseCopy({ kind: 'check', card, revision, agent: 'a1', ref: null })
  if (!r.ok) throw new Error(JSON.stringify(r.refusal))
  if (!keep) await pool.returnCopy(r.lease.id, 'runEnded')
  return r.copy.folder
}

describe("HI-3028: a copy reset from a submodule to ordinary files at its path", { timeout: 120_000 }, () => {
  it("holds the revision cleanly: no .git of the old clone left, and git in the folder sees the copy's repository", async () => {
    const { pool, at1, at2 } = project()
    const first = await leased(pool, 1, at1)
    expect(readFileSync(join(first, 'libs', 's', 'v.txt'), 'utf8')).toBe('1\n')
    const f = await leased(pool, 2, at2, true)
    expect(f).toBe(first)
    expect(existsSync(join(f, 'libs', 's', '.git'))).toBe(false)
    expect(readFileSync(join(f, 'libs', 's', 'v.txt'), 'utf8')).toBe('vendored\n')
    expect(g(f, 'status', '--porcelain', '--ignored')).toBe('')
    expect(g(join(f, 'libs', 's'), 'rev-parse', 'HEAD')).toBe(at2)
  })

  it('leased back at the submodule revision afterwards: the submodule set up again from its clone', async () => {
    const { pool, at1, at2 } = project()
    await leased(pool, 1, at1)
    await leased(pool, 2, at2)
    const f = await leased(pool, 3, at1, true)
    expect(readFileSync(join(f, 'libs', 's', 'v.txt'), 'utf8')).toBe('1\n')
    expect(existsSync(join(f, 'libs', 's', '.git'))).toBe(true)
    expect(g(f, 'status', '--porcelain')).toBe('')
  })
})
