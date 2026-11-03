// Reviewers review in review copies (#1439, SPEC §16.10.5; src/main/reviewCopies.ts, the grant in sessions.ts and the
// adapters): who is granted the project's copies folder, and how each CLI is given it (Claude Code, Codex and Copilot
// with --add-dir; Codex's -c override would replace the user's own writable roots: the recorded fixture); start review
// leasing a copy at the submission's revision, the verdict returning it to returning, a stale pass's confirming review
// leasing one again, a resubmission's new revision, and a review waiting while every copy is in use, then told once it
// has one. A real CopyPool on a real hive.db and git repository; conditions, never time.
import { spawn as nodeSpawn } from 'child_process'
import { mkdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { commit, gitRepo, sh } from './workflow/harness'
import type { LaunchContext } from '../src/main/providers/types'
import type { WorkflowRole } from '../src/shared/workflow/roles'
import type { CopyPool as Pool } from '../src/main/copies'
import '../src/shared/agentText/asyncScope'
import { inDialectOf, inDialectScope, setChainResolver, type DialectChain } from '../src/shared/agentText'

// The app's message to a reviewer (tellReviewer) as leaveMessage gets it: its text, and the reviewer's.
const sent = vi.hoisted(() => [] as { agent: string; text: string }[])
vi.mock('../src/main/agentMessages', () => ({ leaveMessage: async (_p: string, agent: string, _n: string, _f: unknown, text: string) => (sent.push({ agent, text }), { id: 'm1', fate: 'queued', queued: 1 }) }))

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const base = tempDir('hive-review-copies-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const homes = { CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME }

const { advanced } = await import('../src/main/advanced')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { boardFile, closeBoard, workspaceDb } = await import('../src/main/boardStore')
const { COPIES_DIR, CopyPool, CopyStore, copiesDirOf, grantsCopies } = await import('../src/main/copies')
const { fileSlotConn } = await import('../src/main/slots')
const { BoundedLog, execCommand, FILE_IO } = await import('../src/main/workflow/queueChecks')
const { COPY_WAIT_STALL_MS, copiesInUseText, copyWaitStall, ReviewCopies, reviewCopyText, tellReviewer } = await import('../src/main/reviewCopies')
const { reviewsWork } = await import('../src/shared/workflow/roles')
const { PROVIDERS } = await import('../src/shared/providers')

beforeAll(() => {
  // Never the user's own homes: the adapters read their config.
  process.env.CODEX_HOME = join(base, 'codex-home')
  process.env.COPILOT_HOME = join(base, 'copilot-home')
  mkdirSync(join(base, 'profile'), { recursive: true })
  advanced.load(join(base, 'profile'))
})
afterAll(() => {
  advanced.stop()
  for (const [k, v] of Object.entries(homes)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function context(over: Partial<LaunchContext> = {}): LaunchContext {
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  return {
    projectPath: cwd, agentId: 'a-1', executable: 'C:\\bin\\cli.exe', cwd, workspacePath: base, runId: `r-${Math.random()}`, sessionId: '0cb916db-26aa-40f2-86b5-1ba81b225fd2',
    resume: false, name: '', skills: [], mcpServers: { hive: { command: 'node', args: ['hive-mcp.js'] } }, model: null, effort: null, permissionMode: null, extraArgs: [],
    hookUrl: 'http://127.0.0.1:5000/hook?run=r1', hookAuthFile: join(base, 'auth.txt'), privateDir: join(base, `private-${Math.random()}`), guidance: 'Hive guidance', allowBackgroundSessions: false, use200kContext: false,
    env: { PATH: 'C:\\Windows' },
    ...over
  }
}

const POOL = 'D:\\Work\\ws.worktrees\\proj\\copies'
/** Each value that follows a flag in `args`. */
const valuesOf = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))

describe("the grant of the project's copies folder (extraDirs)", () => {
  const grant = (role: WorkflowRole, o: { inProjectFolder?: boolean; on?: boolean; capable?: boolean; assistant?: boolean } = {}): boolean =>
    grantsCopies({ capable: o.capable ?? true, on: o.on ?? true, reviews: reviewsWork(role), inProjectFolder: o.inProjectFolder ?? true, assistant: o.assistant ?? false })

  it('goes to a reviewer and to an either agent in the project folder; not to either in its slot, a builder, the Assistant, a CLI without it, or with review copies off', () => {
    expect(grant('reviewer')).toBe(true)
    expect(grant('either')).toBe(true)
    expect(grant('either', { inProjectFolder: false })).toBe(false)
    expect(grant('builder')).toBe(false)
    expect(grant('reviewer', { assistant: true })).toBe(false)
    expect(grant('reviewer', { capable: false })).toBe(false)
    expect(grant('reviewer', { on: false })).toBe(false)
  })

  it('is one fixed folder per project, beside its slots', () => {
    expect(copiesDirOf('D:\\Work\\ws.worktrees', 'D:\\Work\\ws\\proj')).toBe(join('D:\\Work\\ws.worktrees', 'proj', COPIES_DIR))
  })

  it('every provider Hive has can be given folders', () => {
    for (const p of PROVIDERS) expect(p.capabilities.extraDirs, p.id).toBe(true)
  })

  it('Claude Code: --add-dir, always followed by an option (it takes several), never with none granted', () => {
    const args = (o: Partial<LaunchContext>): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', context(o)).args
    for (const o of [{ extraDirs: [POOL] }, { extraDirs: [POOL], resume: true }, { extraDirs: [POOL], initialPrompt: 'Review #12' }]) {
      const a = args(o)
      expect(valuesOf(a, '--add-dir')).toEqual([POOL])
      expect(a[a.indexOf('--add-dir') + 2]).toMatch(/^--/)
    }
    expect(args({})).not.toContain('--add-dir')
    expect(args({ extraDirs: [] })).not.toContain('--add-dir')
  })

  it("Claude Code: a session outside its project folder (a slot's) may read its launch plugin, in the project's .hive (HI-2274)", () => {
    const args = (o: Partial<LaunchContext>): string[] => claudeCode.buildCommand('C:\\bin\\claude.exe', context(o)).args
    const project = join(base, 'proj')
    const plugin = join(claudeCode.launchDir(project, 'a-1'), 'plugin')
    const slot = join(base, 'proj.worktrees', 'slot-a')
    mkdirSync(slot, { recursive: true })
    // In a slot: the plugin is outside its folder, so it is added (before any review copies granted, each followed by an option).
    const inSlot = args({ cwd: slot })
    expect(valuesOf(inSlot, '--plugin-dir')).toEqual([plugin])
    expect(valuesOf(inSlot, '--add-dir')).toEqual([plugin])
    expect(inSlot[inSlot.indexOf('--add-dir') + 2]).toMatch(/^--/)
    expect(valuesOf(args({ cwd: slot, extraDirs: [POOL] }), '--add-dir')).toEqual([POOL, plugin])
    // In the project folder the plugin is inside it: nothing added, as before.
    expect(args({})).not.toContain('--add-dir')
    expect(valuesOf(args({ extraDirs: [POOL] }), '--add-dir')).toEqual([POOL])
  })

  it("Codex: --add-dir after resume <id>, never a -c override of the writable roots (it would replace the user's own: the fixture)", () => {
    const args = (o: Partial<LaunchContext>): string[] => codex.buildCommand('C:\\bin\\codex.exe', context(o)).args
    const resumed = args({ extraDirs: [POOL], resume: true })
    expect(resumed.slice(0, 2)).toEqual(['resume', '0cb916db-26aa-40f2-86b5-1ba81b225fd2'])
    expect(valuesOf(resumed, '--add-dir')).toEqual([POOL])
    expect(valuesOf(args({ extraDirs: [POOL] }), '--add-dir')).toEqual([POOL])
    expect(args({ extraDirs: [POOL] }).some((a) => a.includes('writable_roots'))).toBe(false)
    expect(args({})).not.toContain('--add-dir')
    // What Codex 0.163.0 made of each (tests/fixtures/advanced/writable-roots-codex-0.163.0.json).
    const f = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'advanced', 'writable-roots-codex-0.163.0.json'), 'utf8')) as { cases: Record<string, { args: string[]; roots: string[] }> }
    expect(f.cases.userOwn.roots).toContain('C:\\work\\userroot')
    expect(f.cases.configOverride.roots).not.toContain('C:\\work\\userroot')
    expect(f.cases.addDir.args[0]).toBe('--add-dir')
    expect(f.cases.addDir.roots).toEqual(expect.arrayContaining(['C:\\work\\copies', 'C:\\work\\userroot', 'C:\\work\\alpha']))
  })

  it('Copilot: --add-dir, and in Accept edits its edits there approved as in its own folder', () => {
    const args = (o: Partial<LaunchContext>): string[] => copilot.buildCommand('C:\\bin\\copilot.exe', context(o)).args
    expect(valuesOf(args({ extraDirs: [POOL] }), '--add-dir')).toEqual([POOL])
    expect(valuesOf(args({ extraDirs: [POOL], resume: true }), '--add-dir')).toEqual([POOL])
    expect(args({})).not.toContain('--add-dir')
    const edits = args({ extraDirs: [POOL], permissionMode: 'accept-edits' }).filter((a) => a.startsWith('--allow-tool=write('))
    expect(edits).toHaveLength(2)
    expect(edits[1]).toContain('copies')
    expect(args({ extraDirs: [POOL], permissionMode: 'allow-all' }).filter((a) => a.startsWith('--allow-tool=write('))).toEqual([])
  })
})

// --- Leasing: a real pool.

interface World {
  project: string
  pool: Pool
  reviews: Map<string, { going: boolean; submission: number | null; revision: string | null }>
  busy: Map<string, string>
  told: { agent: string; card: number; text: string }[]
  notes: { card: number; id: string; values?: Record<string, unknown> }[]
  rc: InstanceType<typeof ReviewCopies>
  size: { n: number }
  /** Why review copies are off (a switch: review copies, or workflow rules not enforced), or null; `afterLease` turns it so as a lease comes back. */
  sw: { off: string | null; afterLease: string | null }
}

const closers: (() => void)[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c()
})

function world(size = 2, tell?: ConstructorParameters<typeof ReviewCopies>[0]['tell']): World {
  const ws = join(tempDir('review-copies-'), 'ws')
  const project = gitRepo(join(ws, 'project'))
  commit(project, { '.gitignore': 'node_modules/\n', 'a.ts': 'export const a = 1\n' }, 'first')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const logs = tempDir('review-copies-logs-')
  const store = new CopyStore(fileSlotConn(boardFile(ws)), 'p-test')
  const busy = new Map<string, string>()
  const sz = { n: size }
  let runs = 0
  const pool = new CopyPool({
    store,
    project,
    dir: join(`${ws}.worktrees`, 'project', COPIES_DIR),
    options: async () => ({ setup: '', archive: '', copy: '' }),
    size: () => sz.n,
    runner: async (r) => {
      const logPath = join(logs, `${runs++}.log`)
      const out = new BoundedLog(logPath, FILE_IO)
      const e = await execCommand({ spawn: nodeSpawn, platform: process.platform, timeoutMs: 60_000, env: () => ({ ...baseEnv(), ...r.env }) }, r.command, r.folder, out)
      out.close()
      return { ok: !e.spawnError && !e.timedOut && e.exitCode === 0, exitCode: e.exitCode, logPath, settled: true }
    },
    settle: async () => true,
    holder: { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() },
    profile: 'hive-1',
    runIn: () => null,
    holderBusy: (agent) => busy.get(agent) ?? null,
    leaseOver: () => null,
    reviewOn: () => true,
    quietWaitMs: () => 10 * 60_000
  })
  const reviews: World['reviews'] = new Map()
  const told: World['told'] = []
  const notes: World['notes'] = []
  const sw: World['sw'] = { off: null, afterLease: null }
  // The pool as the review copies see it: a switch turned off while a lease is being set up (`afterLease`).
  const seen = Object.create(pool) as Pool
  seen.leaseCopy = async (r) => {
    const got = await pool.leaseCopy(r)
    if (sw.afterLease) sw.off = sw.afterLease
    return got
  }
  const rc = new ReviewCopies({
    pool: async () => seen,
    review: async (card, agent) => reviews.get(`${card}|${agent}`) ?? { going: false, submission: null, revision: null },
    tell: tell ?? (async (agent, card, text) => void told.push({ agent: agent.id, card, text: text() })),
    note: async (card, text) => void notes.push({ card, id: text.id, ...(text.values ? { values: text.values } : {}) }),
    firstWaitMs: 60_000,
    off: () => (sw.off === null ? null : () => sw.off ?? '')
  })
  closers.push(() => {
    store.conn.close()
    closeBoard(ws)
    dismiss()
  })
  return { project, pool, reviews, busy, told, notes, rc, size: sz, sw }
}

const R1 = { id: 'r-1', name: 'R1' }
const R2 = { id: 'r-2', name: 'R2' }
const head = (folder: string): string => sh(folder, 'rev-parse', 'HEAD')
const review = (w: World, card: number, agent: string, submission: number, revision: string): void => void w.reviews.set(`${card}|${agent}`, { going: true, submission, revision })
const stop = (w: World, card: number, agent: string): void => void w.reviews.set(`${card}|${agent}`, { going: false, submission: null, revision: null })
const leaseOf = (w: World, card: number, agent: string) => w.pool.unfreed().find((l) => l.kind === 'review' && l.card === card && l.agent === agent)

describe('start review leases a copy; the review ends, it is returned', () => {
  it("leases a copy at the submission's revision, while the builder has moved on; starting again keeps it", async () => {
    const w = world()
    const submitted = head(w.project)
    review(w, 12, R1.id, 3, submitted)
    commit(w.project, { 'a.ts': 'export const a = 2\n' }, 'moved on')
    const a = await w.rc.start(12, R1)
    expect(a.is).toBe('ready')
    if (a.is !== 'ready') return
    expect(a.folder).toMatch(/[\\/]copies[\\/]copy-1$/)
    expect(head(a.folder)).toBe(submitted)
    expect(head(w.project)).not.toBe(submitted)
    expect(leaseOf(w, 12, R1.id)).toMatchObject({ kind: 'review', revision: submitted, ref: '3', returned: null })
    expect(reviewCopyText(a)).toBe(`Review in ${a.folder} at ${submitted.slice(0, 12)}: read and run commands there, with it as their working directory; your session stays where it is.`)
    expect(w.notes).toEqual([{ card: 12, id: 'tasks.history.reviewCopyLeased', values: { agent: 'R1', copy: 'copy-1', revision: submitted.slice(0, 12) } }])
    const again = await w.rc.start(12, R1)
    expect(again).toEqual(a)
    expect(w.pool.unfreed()).toHaveLength(1)
  })

  it('the verdict returns it: returning while its reviewer is still in its turn, freed once it is idle', async () => {
    const w = world()
    review(w, 12, R1.id, 1, head(w.project))
    const a = await w.rc.start(12, R1)
    expect(a.is).toBe('ready')
    w.busy.set(R1.id, 'R1 (working)')
    stop(w, 12, R1.id)
    expect(await w.rc.end(12, R1.id, 'verdict')).toBe(1)
    const l = w.pool.unfreed().find((x) => x.card === 12)
    expect(l?.returned).toBeTruthy()
    expect(w.pool.copies().find((c) => c.name === 'copy-1')?.state).toBe('returning')
    w.busy.delete(R1.id)
    await w.pool.refresh()
    expect(w.pool.copies().find((c) => c.name === 'copy-1')?.state).toBe('free')
    expect(w.pool.unfreed()).toEqual([])
  })

  it("a review that ended otherwise (the card moved on, its session ended) is over, for the pools' look to return", async () => {
    const w = world()
    review(w, 12, R1.id, 1, head(w.project))
    await w.rc.start(12, R1)
    const l = leaseOf(w, 12, R1.id)!
    expect(await w.rc.over(l)).toBe(false)
    stop(w, 12, R1.id)
    expect(await w.rc.over(l)).toBe(true)
  })

  it("a pass made stale by a decision: its confirming review leases one again", async () => {
    const w = world()
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    const first = await w.rc.start(12, R1)
    stop(w, 12, R1.id)
    await w.rc.end(12, R1.id, 'verdict')
    await w.pool.refresh()
    const was = w.pool.copies().find((c) => c.name === 'copy-1')
    expect(was?.state).toBe('free')
    // The decision made the pass stale: the same submission is reviewed again.
    review(w, 12, R1.id, 1, rev)
    const confirming = await w.rc.start(12, R1)
    expect(confirming.is).toBe('ready')
    expect(confirming).toMatchObject({ revision: rev })
    expect(leaseOf(w, 12, R1.id)?.returned).toBeNull()
    expect(first.is).toBe('ready')
  })

  it("a resubmission's start review returns the earlier revision's copy and leases one at the new", async () => {
    const w = world()
    const one = head(w.project)
    review(w, 12, R1.id, 1, one)
    await w.rc.start(12, R1)
    const two = commit(w.project, { 'a.ts': 'export const a = 3\n' }, 'round 2')
    review(w, 12, R1.id, 2, two)
    const a = await w.rc.start(12, R1)
    expect(a.is === 'ready' && head(a.folder)).toBe(two)
    const mine = w.pool.unfreed().filter((l) => l.card === 12)
    // The earlier one returned (and freed at once: nothing holds it), the new one out.
    expect(mine.map((l) => [l.revision, l.returned])).toEqual([[two, null]])
  })

  it('no review going, or no submitted revision: none', async () => {
    const w = world()
    expect((await w.rc.start(12, R1)).is).toBe('none')
    w.reviews.set(`12|${R1.id}`, { going: true, submission: null, revision: null })
    expect(await w.rc.start(12, R1)).toEqual({ is: 'none', why: 'the card has no submitted revision' })
    expect(w.pool.unfreed()).toEqual([])
  })
})

describe('waiting when none is free', () => {
  it('waits (said on the card once), then is told once a copy is leased after another review returns one', async () => {
    const w = world(1)
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    const waiting = await w.rc.start(13, R2)
    expect(waiting.is).toBe('waiting')
    expect(reviewCopyText(waiting)).toMatch(/^Waiting for a review copy \(/)
    expect(w.notes.filter((n) => n.id === 'tasks.history.reviewCopyWaiting')).toEqual([{ card: 13, id: 'tasks.history.reviewCopyWaiting', values: { agent: 'R2' } }])
    expect(w.rc.waits()).toEqual([expect.objectContaining({ card: 13, agent: R2.id, name: 'R2', since: expect.any(Number) })])
    // It says what holds each copy, and when Hive tries again (HI-1764: it was told only "pending").
    expect(w.rc.waits()[0].why).toMatch(/^the pool's 1 copy is in use; the longest lent, copy-1, for \d+ min \(a review of \S*12\)$/)
    // Asked again meanwhile: still waiting, said on the card once.
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    expect(w.notes.filter((n) => n.id === 'tasks.history.reviewCopyWaiting')).toHaveLength(1)
    await w.rc.retry()
    expect(w.told).toEqual([])
    // R1's verdict: its copy returned and freed; the next look leases it to R2, who is told.
    stop(w, 12, R1.id)
    await w.rc.end(12, R1.id, 'verdict')
    await w.pool.refresh()
    await w.rc.retry()
    expect(w.rc.waits()).toEqual([])
    const l = leaseOf(w, 13, R2.id)
    expect(l?.returned).toBeNull()
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatchObject({ agent: R2.id, card: 13 })
    expect(w.told[0].text).toMatch(/^#13's review copy is ready\. Review in .*copy-1 at /)
  })

  it('a review waiting for a copy past COPY_WAIT_STALL_MS stalls its card, for a lane watch to notice (HI-1764)', async () => {
    const w = world(1)
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    const waits = w.rc.waits()
    const card = { number: 13, key: 'HI-13', column: 'review' }
    expect(copyWaitStall(card, waits, waits[0].since + COPY_WAIT_STALL_MS - 1)).toBeNull()
    expect(copyWaitStall(card, waits, waits[0].since + 7 * 60_000)).toMatch(/^HI-13's review by R2 has waited 7 min for a review copy: the pool's 1 copy is in use; the longest lent, copy-1, for \d+ min \(a review of \S*12\)\.$/)
    // Only its own card, and only in Review.
    expect(copyWaitStall({ ...card, number: 12 }, waits, waits[0].since + 7 * 60_000)).toBeNull()
    expect(copyWaitStall({ ...card, column: 'doing' }, waits, waits[0].since + 7 * 60_000)).toBeNull()
  })

  it("says what holds the copies in one clause, the reply still lean (at most 300 characters) with a full pool held back (HI-1764)", () => {
    const now = Date.parse('2026-10-26T22:25:00Z')
    const at = (min: number): string => new Date(now - min * 60_000).toISOString()
    const pool = [
      { copy: 'copy-4', kind: 'review' as const, card: 1745, from: at(48), returned: null, by: null },
      ...[7, 6, 2, 1, 5, 3].map((n, i) => ({ copy: `copy-${n}`, kind: 'check' as const, card: 1697, from: at(40 - i), returned: at(37 - i), by: i % 2 ? "its run's processes (copy-c-63bf7dfaf427)" : 'a process with a file or folder open in it' }))
    ]
    const why = copiesInUseText(pool, (c) => `HI-${c}`, now)
    expect(why).toBe("the pool's 7 copies are in use; copy-7, returned 37 min ago, is held back by a process with a file or folder open in it")
    expect(reviewCopyText({ is: 'waiting', why }).length).toBeLessThanOrEqual(300)
    expect(copiesInUseText([{ ...pool[0] }], (c) => `HI-${c}`, now)).toBe("the pool's 1 copy is in use; the longest lent, copy-4, for 48 min (a review of HI-1745)")
  })

  it('two reviews at once with a pool of two; a third waits', async () => {
    const w = world(2)
    const rev = head(w.project)
    const R3 = { id: 'r-3', name: 'R3' }
    for (const [card, r] of [[12, R1], [13, R2], [14, R3]] as const) review(w, card, r.id, 1, rev)
    // Both copies made at once: git's worktree changes in the repository one at a time (HI-2322, git.ts oneWorktreeChange).
    const [a, b] = await Promise.all([w.rc.start(12, R1), w.rc.start(13, R2)])
    expect([a.is, b.is], JSON.stringify([a, b])).toEqual(['ready', 'ready'])
    expect(a.is === 'ready' && b.is === 'ready' && a.folder !== b.folder).toBe(true)
    expect((await w.rc.start(14, R3)).is).toBe('waiting')
  })

  it('a waiting review that ends is dropped, never leased', async () => {
    const w = world(1)
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    await w.rc.start(12, R1)
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    stop(w, 13, R2.id)
    stop(w, 12, R1.id)
    await w.rc.end(12, R1.id, 'verdict')
    await w.pool.refresh()
    await w.rc.retry()
    expect(w.rc.waits()).toEqual([])
    expect(leaseOf(w, 13, R2.id)).toBeUndefined()
    expect(w.told).toEqual([])
  })
})

// HR5's round 1: off means off. With workflow rules not enforced (or review copies off), Hive records facts and leases
// nothing; a copy already out is still returned and freed.
const NOT_ENFORCED = "workflow rules aren't enforced (Settings → Advanced, Workflow rules are enforced)"

describe("switched off (Workflow rules are enforced, Reviewers review in review copies)", () => {
  it('off before start review: none, nothing leased or noted', async () => {
    const w = world()
    review(w, 12, R1.id, 1, head(w.project))
    w.sw.off = NOT_ENFORCED
    expect(await w.rc.start(12, R1)).toEqual({ is: 'none', why: NOT_ENFORCED })
    expect(w.pool.unfreed()).toEqual([])
    expect(w.pool.copies()).toEqual([])
    expect(w.notes).toEqual([])
  })

  it('off while a review waits: dropped and told, never leased once a copy is free', async () => {
    const w = world(1)
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    await w.rc.start(12, R1)
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    w.sw.off = NOT_ENFORCED
    await w.rc.retry()
    expect(w.rc.waits()).toEqual([])
    expect(w.told).toEqual([{ agent: R2.id, card: 13, text: `#13: No review copy (${NOT_ENFORCED}): review the builder's work read-only from where you are.` }])
    // R1's verdict frees copy-1 (returning and freeing still work while off); the next look leases R2 nothing.
    stop(w, 12, R1.id)
    expect(await w.rc.end(12, R1.id, 'verdict')).toBe(1)
    await w.pool.refresh()
    await w.rc.retry()
    expect(w.pool.copies().find((c) => c.name === 'copy-1')?.state).toBe('free')
    expect(leaseOf(w, 13, R2.id)).toBeUndefined()
    expect(w.told).toHaveLength(1)
  })

  it('off while its copy is being set up: the copy is returned, never handed over', async () => {
    const w = world()
    review(w, 12, R1.id, 1, head(w.project))
    w.sw.afterLease = NOT_ENFORCED
    expect(await w.rc.start(12, R1)).toEqual({ is: 'none', why: NOT_ENFORCED })
    expect(leaseOf(w, 12, R1.id)).toBeUndefined()
    expect(w.pool.unfreed()).toEqual([])
    expect(w.pool.copies().find((c) => c.name === 'copy-1')?.state).toBe('free')
    expect(w.notes.filter((x) => x.id === 'tasks.history.reviewCopyLeased')).toEqual([])
    expect(w.rc.waits()).toEqual([])
  })

  it('a copy leased before it was turned off is still returned at the verdict, and freed', async () => {
    const w = world()
    review(w, 12, R1.id, 1, head(w.project))
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    w.sw.off = NOT_ENFORCED
    stop(w, 12, R1.id)
    expect(await w.rc.over(leaseOf(w, 12, R1.id)!)).toBe(true)
    expect(await w.rc.end(12, R1.id, 'verdict')).toBe(1)
    await w.pool.refresh()
    expect(w.pool.unfreed()).toEqual([])
    expect(w.pool.copies().find((c) => c.name === 'copy-1')?.state).toBe('free')
  })
})

// Dialects (HI-2447, HR1's round 1): what a wait says is rendered by whoever reads it, and a later message to a reviewer
// is said in that reviewer's dialect, wherever it is made (the pools' look runs in the background, in no scope).
describe("a review copy's text, in its reader's dialect", () => {
  const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })
  /** Each session's own texts (by its agent's id); the API and other sessions get the Default. */
  const dialects = (by: Record<string, Record<string, string>>): void => setChainResolver((s) => (s.kind === 'session' && by[s.session.agentId] ? chain(by[s.session.agentId]) : null))
  afterEach(() => {
    setChainResolver(null)
    sent.length = 0
  })

  it("keeps why a review waits as data: a lane watch's stall and another start read it in their own dialect", async () => {
    const w = world(1)
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    dialects({ [R2.id]: { 'copy.inUse.all': 'FIRST CALLER TEXT' } })
    // Two starts of R2's review at once share one lease attempt: each answer is its own caller's.
    const [mine, api] = await Promise.all([inDialectOf({ projectPath: w.project, agentId: R2.id }, () => w.rc.start(13, R2)), inDialectScope({ kind: 'api' }, () => w.rc.start(13, R2))])
    expect(mine).toMatchObject({ is: 'waiting', why: expect.stringMatching(/^FIRST CALLER TEXT; the longest lent, copy-1/) })
    expect(api).toMatchObject({ is: 'waiting', why: expect.stringMatching(/^the pool's 1 copy is in use; the longest lent, copy-1/) })
    // Kept, then read: in the Default by a lane watch, in R2's dialect by R2.
    const since = w.rc.waits()[0].since
    expect(copyWaitStall({ number: 13, key: 'HI-13', column: 'review' }, w.rc.waits(), since + COPY_WAIT_STALL_MS)).toMatch(/^HI-13's review by R2 has waited 5 min for a review copy: the pool's 1 copy is in use; /)
    expect(inDialectOf({ projectPath: w.project, agentId: R2.id }, () => w.rc.waits()[0].why)).toMatch(/^FIRST CALLER TEXT; /)
    expect(inDialectOf({ projectPath: w.project, agentId: R1.id }, () => w.rc.waits()[0].why)).toMatch(/^the pool's 1 copy is in use; /)
  })

  it("tells a reviewer its copy is ready in the reviewer's dialect, from the pools' look in the background", async () => {
    const w = world(1, (agent, card, text) => tellReviewer(w.project, agent, card, text))
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    dialects({ [R2.id]: { 'copy.review.ready': 'TARGET READY {folder}' } })
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    stop(w, 12, R1.id)
    await w.rc.end(12, R1.id, 'verdict')
    await w.pool.refresh()
    // No scope open: the look's own.
    await w.rc.retry()
    expect(sent).toEqual([{ agent: R2.id, text: expect.stringMatching(/^TARGET READY .*copy-1$/) }])
  })

  it("tells a reviewer it gets none, with why, in the reviewer's dialect", async () => {
    const w = world(1, (agent, card, text) => tellReviewer(w.project, agent, card, text))
    const rev = head(w.project)
    review(w, 12, R1.id, 1, rev)
    review(w, 13, R2.id, 1, rev)
    expect((await w.rc.start(12, R1)).is).toBe('ready')
    expect((await w.rc.start(13, R2)).is).toBe('waiting')
    dialects({ [R2.id]: { 'copy.review.none': 'TARGET NONE ({why})' } })
    w.sw.off = 'switched off'
    await w.rc.retry()
    expect(sent).toEqual([{ agent: R2.id, text: '#13: TARGET NONE (switched off)' }])
  })
})
