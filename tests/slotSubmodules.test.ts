// HI-3026: a slot whose submodules the files step set up (Set up submodules and LFS on), removed and renamed, on real
// git through the real SlotPool. git refuses any unforced removal of a worktree holding submodule clones
// (`<gitdir>/modules`), and any move of one; forced, it would delete those clones with it. So a free, clean slot is
// removed forced only once git's own clean check (submodules counted) and every clone, nested too, holding nothing a
// remote lacks (any ref: a branch, a tag, a stash) say it loses nothing; anything doubtful or unreadable keeps it,
// saying why. A rename of one keeps its name before anything is copied.
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { gitWorkspacePort } from '../src/main/platform/gitWorkspacePort'
import { gitRelocation } from '../src/main/platform/gitRelocation'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder, type SlotRenamer, type SlotRun, type SlotRunEnd } from '../src/main/slots'
import { commit, gitRepo } from './workflow/harness'

void gitWorkspacePort
const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const globalConfig = join(tempDir('slot-sub-config-'), 'gitconfig')
writeFileSync(globalConfig, '[user]\n\tname = Combwork Test\n\temail = test@example.invalid\n[core]\n\tautocrlf = false\n')
/** The files step's environment: the test's global config, and local (file) submodule URLs allowed. */
const RUN_ENV: Record<string, string> = { ...baseEnv(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env: RUN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A project whose submodule libs/s (one commit) has, with `nested`, its own submodule nn. `releaseTag`: the
 * submodule's remote has a tag v1.0 (lightweight or annotated) on a commit none of its branches holds (a release
 * whose branch was deleted), fetched with the clone.
 */
function project(nested = false, releaseTag?: 'light' | 'annotated'): { ws: string; p: string } {
  const base = tempDir('slot-sub-')
  const ws = join(base, 'ws')
  const p = gitRepo(join(ws, 'project'))
  const sub = gitRepo(join(base, 'sub'))
  commit(sub, { 'v.txt': '1\n' }, 'one')
  if (releaseTag) {
    g(sub, 'switch', '-q', '-c', 'release')
    commit(sub, { 'rel.txt': 'r\n' }, 'release 1.0')
    g(sub, 'tag', ...(releaseTag === 'annotated' ? ['-a', '-m', 'v1.0'] : []), 'v1.0')
    g(sub, 'switch', '-q', 'main')
    g(sub, 'branch', '-q', '-D', 'release')
  }
  if (nested) {
    const nest = gitRepo(join(base, 'nest'))
    commit(nest, { 'n.txt': 'n\n' }, 'nest')
    g(sub, 'submodule', 'add', '-q', nest, 'nn')
    g(sub, 'commit', '-q', '-m', 'nn')
  }
  g(p, 'submodule', 'add', '-q', sub, 'libs/s')
  g(p, 'commit', '-q', '-m', 'sub')
  return { ws, p }
}

/** The slot runs' runner: the files step run for real, the rest (setup, archive) a pass. */
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

function pool(ws: string, p: string, renamer?: SlotRenamer): SlotPool {
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const store = new SlotStore(fileSlotConn(boardFile(ws)), 'p-sub')
  const out = new SlotPool({ store, project: p, root: join(`${ws}.worktrees`, 'project'), options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 2, cap: () => 12, runner, settle: async () => true, holder, removeIdle: () => true, removeSkillCopies: async () => undefined, ...(renamer ? { renamer } : {}) })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return out
}

/** A slot lent once and released: its submodule set up by the files step, free again. `edit` runs in it before the release. */
async function usedSlot(nested = false, edit?: (folder: string, p: string) => void, releaseTag?: 'light' | 'annotated'): Promise<{ pool: SlotPool; name: string; folder: string; p: string }> {
  const { ws, p } = project(nested, releaseTag)
  const pl = pool(ws, p)
  const r = await pl.lend({ agent: 'a1', card: 1 }, { target: 'main' })
  if (!r.ok) throw new Error(JSON.stringify(r.refusal))
  expect(existsSync(join(r.slot.folder, 'libs', 's', 'v.txt'))).toBe(true)
  edit?.(r.slot.folder, p)
  await pl.release(r.lease.id, 'done')
  return { pool: pl, name: r.slot.name, folder: r.slot.folder, p }
}

/** An unpushed commit in a submodule's checkout, HEAD then put back at the gitlink, so the superproject sees it clean. */
function unpushed(dir: string, keep: (dir: string) => void): void {
  writeFileSync(join(dir, 'wip.txt'), 'wip\n')
  g(dir, 'add', 'wip.txt')
  g(dir, 'commit', '-q', '-m', 'wip')
  keep(dir)
  g(dir, 'checkout', '-q', '--detach', 'HEAD~1')
}

describe('HI-3026: a slot whose submodule the files step set up', { timeout: 120_000 }, () => {
  it('free and clean, with no stash: removed, folder and all', async () => {
    const { pool: pl, name, folder } = await usedSlot()
    expect(await pl.remove(name)).toBeNull()
    expect(existsSync(folder)).toBe(false)
  })

  it('an unpushed commit kept only by a local tag in its submodule: kept, saying which, nothing deleted', async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => unpushed(join(f, 'libs', 's'), (d) => g(d, 'tag', 'mine')))
    const kept = await pl.remove(name)
    expect(kept).toMatchObject({ why: 'gitRefused' })
    expect(JSON.stringify(kept)).toContain("submodule libs/s has commits that aren't on its remote")
    expect(g(join(folder, 'libs', 's'), 'rev-parse', 'mine^{commit}')).toMatch(/^[0-9a-f]{40}$/)
  })

  it('an unpushed commit on a branch of a nested submodule: kept, naming that clone', async () => {
    const { pool: pl, name, folder } = await usedSlot(true, (f) => unpushed(join(f, 'libs', 's', 'nn'), (d) => g(d, 'branch', 'wip')))
    const kept = await pl.remove(name)
    expect(JSON.stringify(kept)).toContain('submodule libs/s/modules/nn has commits')
    expect(existsSync(join(folder, 'libs', 's', 'nn', 'wip.txt'))).toBe(false)
    expect(g(join(folder, 'libs', 's', 'nn'), 'rev-parse', 'wip')).toMatch(/^[0-9a-f]{40}$/)
  })

  it.each(['light', 'annotated'] as const)("HI-3077: its remote's %s tag on a commit no branch holds, fetched with the clone: removed", async (kind) => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => expect(g(join(f, 'libs', 's'), 'tag', '-l')).toBe('v1.0'), kind)
    expect(await pl.remove(name)).toBeNull()
    expect(existsSync(folder)).toBe(false)
  })

  it("HI-3077: beside the remote's tag, a local tag on an unpushed commit: kept", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => unpushed(join(f, 'libs', 's'), (d) => g(d, 'tag', 'mine')), 'light')
    expect(JSON.stringify(await pl.remove(name))).toContain("submodule libs/s has commits that aren't on its remote")
    expect(existsSync(join(folder, 'libs', 's', 'v.txt'))).toBe(true)
  })

  it("HI-3077: the remote's tag name moved locally to an unpushed commit: kept, the remote's object no proof", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => unpushed(join(f, 'libs', 's'), (d) => g(d, 'tag', '-f', 'v1.0')), 'light')
    expect(JSON.stringify(await pl.remove(name))).toContain("submodule libs/s has commits that aren't on its remote")
    expect(existsSync(join(folder, 'libs', 's', 'v.txt'))).toBe(true)
  })

  it("HI-3077: the remote's tag, but the remote can't be read: kept, couldn't check", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => g(join(f, 'libs', 's'), 'remote', 'set-url', 'origin', join(tempDir('slot-sub-gone-'), 'missing')), 'light')
    expect(JSON.stringify(await pl.remove(name))).toContain("couldn't check submodule libs/s")
    expect(existsSync(join(folder, 'libs', 's', 'v.txt'))).toBe(true)
  })

  it("an untracked file inside the submodule, hidden by the user's ignore setting from the slot's own check: kept", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f, p) => {
      g(p, 'config', 'submodule.libs/s.ignore', 'all')
      writeFileSync(join(f, 'libs', 's', 'mine.txt'), 'mine\n')
    })
    const kept = await pl.remove(name)
    expect(JSON.stringify(kept)).toContain('changes or untracked files, inside its submodules too: libs/s')
    expect(existsSync(join(folder, 'libs', 's', 'mine.txt'))).toBe(true)
  })

  it("a clone's metadata incomplete (HEAD without config): kept, couldn't check, nothing deleted", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => {
      const junk = join(g(f, 'rev-parse', '--path-format=absolute', '--absolute-git-dir'), 'modules', 'junk')
      mkdirSync(junk, { recursive: true })
      writeFileSync(join(junk, 'HEAD'), 'ref: refs/heads/main\n')
    })
    const kept = await pl.remove(name)
    expect(JSON.stringify(kept)).toContain("couldn't check submodule junk")
    expect(existsSync(join(folder, 'libs', 's', 'v.txt'))).toBe(true)
  })

  it("a clone git can't read (its HEAD broken): kept, nothing deleted", async () => {
    const { pool: pl, name, folder } = await usedSlot(false, (f) => {
      const clone = join(g(f, 'rev-parse', '--path-format=absolute', '--absolute-git-dir'), 'modules', 'libs', 's')
      writeFileSync(join(clone, 'HEAD'), 'not a ref\n')
    })
    // The slot's own read may fail on it first (cantCheck), else this check's (gitRefused): kept either way.
    expect(await pl.remove(name)).not.toBeNull()
    expect(existsSync(join(folder, 'libs', 's', 'v.txt'))).toBe(true)
  })

  it("git's relocation calls one unmovable, and a plain worktree movable", async () => {
    const { folder, p } = await usedSlot()
    expect(await gitRelocation.unmovable!(folder)).toBe("git can't move a worktree with submodules")
    const plain = join(tempDir('slot-sub-plain-'), 'wt')
    g(p, 'worktree', 'add', '-q', '--detach', plain, 'HEAD')
    expect(await gitRelocation.unmovable!(plain)).toBeNull()
  })

  it('a rename of one keeps its name before anything is copied or moved', async () => {
    const { ws, p } = project()
    const copy = vi.fn(async () => true)
    const move = vi.fn(async () => true)
    const renamer: SlotRenamer = { identity: async () => 'tree', unmovable: async () => "git can't move a worktree with submodules", copy, move, follow: async () => undefined, back: async () => true, where: async () => 'from' }
    const pl = pool(ws, p, renamer)
    const r = await pl.lend({ agent: 'a1', card: 1 }, { target: 'main' })
    if (!r.ok) throw new Error(JSON.stringify(r.refusal))
    await pl.release(r.lease.id, 'done')
    expect(await pl.rename(r.slot.name)).toBeNull()
    expect(copy).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
    expect(pl.slots().map((s) => s.name)).toEqual([r.slot.name])
  })
})
