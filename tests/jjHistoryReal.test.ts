// jj's history, evidence and attribution against the real jj Combwork is tested with (HI-2796's J3): the acceptance of its
// done-when. Each case runs real jj (and Git) operations in a throwaway repository, captures them with the production
// functions (jjBoundary, jjCheckStart/jjCheckEnd, the pinned reads, the observer) and decides with the production ones
// (jjCredit, jjSameRevision with Git's own replay on the store, jjAttribute): a stable change id rewritten with new
// content, divergent, split and squashed rewrites, a plain Git commit and its import, a raw write, an edit and its undo,
// a missed watcher event, a bookmark set racing the end boundary, a stale workspace, and two operation heads read
// without merging them.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readdirSync, realpathSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner } from '../src/main/platform/jjRunner'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { jjBoundary, isRefused, type Owner } from '../src/main/platform/jjBoundary'
import { jjCheckEnd, jjCheckStart, jjCredit, jjSameRevision, type JjCheckFor, type JjCheckRecord, type JjCheckSeams } from '../src/main/platform/jjChecks'
import { jjAttributeAt } from '../src/main/platform/jjAttribution'
import { recordedIds, jjPlatform } from '../src/main/platform/jjFacts'
import { jjObserver } from '../src/main/platform/jjObserve'
import { isJjUnknown, JjReads, type JjCommit } from '../src/main/platform/jjReads'
import { readOpHeads, type ViewOf } from '../src/main/platform/jjView'
import { gitHistory } from '../src/main/platform/gitHistory'
import type { FolderChanges, WriteLog } from '../src/main/platform/history'
import type { Fact } from '../src/shared/workflow/facts'
import type { Maybe } from '../src/main/platform/types'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjHistoryReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

function isolated(): NodeJS.ProcessEnv {
  const home = tempDir('jj-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  return gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
}

const owner: Owner = { still: () => true }
const noLock = <T>(fn: () => Promise<T>): Promise<T> => fn()
const logSays = (seen: Maybe<FolderChanges>): WriteLog => ({ settled: async () => undefined, changedBetween: async () => seen })
const QUIET = logSays({ changed: false, paths: [] })

/**
 * A write record from the file system's own watch of the repository's parent folder: `settled` writes a marker beside the
 * repository and waits until the watch has reported it (a condition, never a time), so every write before it is in.
 */
class WatchLog implements WriteLog {
  private events: { t: number; p: string }[] = []
  private w: FSWatcher
  private n = 0
  constructor(
    private parent: string,
    private repo: string
  ) {
    this.w = watch(parent, { recursive: true }, (_e, name) => {
      if (name) this.events.push({ t: Date.now(), p: String(name).replace(/\\/g, '/') })
    })
  }
  async settled(): Promise<void> {
    const marker = `marker-${++this.n}`
    writeFileSync(join(this.parent, marker), String(this.n))
    const until = Date.now() + 15_000
    while (!this.events.some((e) => e.p === marker)) {
      if (Date.now() > until) throw new Error('the watch never reported its marker')
      await new Promise((r) => setImmediate(r))
    }
  }
  async changedBetween(_folder: string, t0: number, t1: number, counts?: (paths: string[]) => string[]): Promise<Maybe<FolderChanges>> {
    const prefix = `${this.repo}/`
    const paths = this.events.filter((e) => e.t >= t0 && e.t <= t1 && e.p.startsWith(prefix)).map((e) => e.p.slice(prefix.length))
    const counted = counts ? counts(paths) : paths
    return { changed: counted.length > 0, paths: counted }
  }
  close(): void {
    this.w.close()
  }
}

describe.skipIf(!exe)(`jj history, attribution and evidence on the real jj (${TESTED_JJ.version})`, () => {
  const env = isolated()
  const runner = createJjRunner({ exe: exe!, env })
  const jj = (cwd: string, ...args: string[]): string => execFileSync(exe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  const logs: WatchLog[] = []
  afterAll(() => {
    for (const l of logs) l.close()
  })

  /** A colocated repository with a base commit and card K's work committed (`R`), @ the empty child jj leaves. */
  async function repo(name: string, ...init: string[]) {
    const parent = tempDir(`jjh-${name}-`)
    const root = join(parent, 'repo')
    mkdirSync(root)
    jj(root, 'git', 'init', ...(init.length ? init : ['--colocate']))
    writeFileSync(join(root, 'base.txt'), 'base\n')
    jj(root, 'commit', '-m', 'base')
    writeFileSync(join(root, 'k.txt'), 'card K\n')
    jj(root, 'commit', '-m', 'K')
    const real = resolve(realpathSync.native(root))
    const d = await jjContextOf(real, runner)
    if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
    const view: ViewOf = { jjRepo: d.jj.jjRepo, workspace: d.jj.workspace, root: d.jj.root, store: d.jj.store, colocated: d.jj.colocated }
    const id = (rev: string, t = 'commit_id'): string => jj(real, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', t).trim()
    return { parent, root: real, view, store: d.jj.store, id, R: id('@-'), base: id('@--'), reads: new JjReads({ folder: real, jjRepo: d.jj.jjRepo }, runner) }
  }
  type Repo = Awaited<ReturnType<typeof repo>>

  async function record(r: Repo, revision: string, o: { log?: WriteLog; run?: () => void; seams?: JjCheckSeams } = {}): Promise<JjCheckRecord> {
    const f: JjCheckFor = { view: r.view, folder: r.root, revision, owner, lock: noLock }
    const seams: JjCheckSeams = { runner, ...o.seams }
    const start = await jjCheckStart(f, o.log ?? QUIET, seams)
    o.run?.()
    return jjCheckEnd(f, start, o.log ?? QUIET, seams)
  }
  const credit = async (r: Repo, revision: string, o: Parameters<typeof record>[2] = {}) => jjCredit(await record(r, revision, o))
  const commitOf = async (r: Repo, rev: string): Promise<JjCommit> => {
    const op = r.reads.head()
    if (isJjUnknown(op)) throw new Error('heads')
    const c = await r.reads.commitAt(op, rev)
    if (isJjUnknown(c)) throw new Error(JSON.stringify(c))
    return c
  }
  const sameChange = (r: Repo) => (a: { base: string; revision: string }, b: { base: string; revision: string }) => gitHistory.sameChange(r.store, a, b)
  const recorded = (cards: [string, string, string][]) =>
    recordedIds(cards.map(([card, commit, changeId]) => ({ card, facts: [{ seq: 1, card: 1, kind: 'Submitted', at: '', actor: 'user', source: 'recorded', data: { revision: commit, platform: jjPlatform({ changeId, commitId: commit }) } } as unknown as Fact] })))

  it('a clean run on the revision counts, tested as the revision (an empty @ over it)', async () => {
    const r = await repo('clean')
    expect(await credit(r, r.R)).toEqual({ revision: r.R, tested: r.R })
  })

  it('a raw write the watcher missed: the end boundary records it, so no credit', async () => {
    const r = await repo('raw')
    expect(await credit(r, r.R, { run: () => writeFileSync(join(r.root, 'k.txt'), 'edited during the run\n') })).toMatchObject({ whyNot: 'changed', why: 'end:recorded' })
  })

  it('an edit and its undo: the boundary sees nothing, the write record does', async () => {
    const r = await repo('restore')
    const log = new WatchLog(r.parent, 'repo')
    logs.push(log)
    const rec = await record(r, r.R, {
      log,
      run: () => {
        writeFileSync(join(r.root, 'k.txt'), 'briefly different\n')
        writeFileSync(join(r.root, 'k.txt'), 'card K\n')
      }
    })
    expect(rec.b2 && !isRefused(rec.b2) && rec.b2.recorded).toBe(false)
    expect(jjCredit(rec)).toMatchObject({ whyNot: 'changed', why: 'end:written' })
    expect(jjCredit(rec).changes).toContain('k.txt')
  })

  it('a missed watcher event: an incomplete write record falls back to the stat snapshot', async () => {
    const unknownLog = logSays({ unknown: true, what: 'writes' })
    const quiet = await repo('missed-quiet')
    expect(await credit(quiet, quiet.R, { log: unknownLog })).toEqual({ revision: quiet.R, tested: quiet.R })
    const r = await repo('missed')
    const rec = await record(r, r.R, {
      log: unknownLog,
      run: () => {
        writeFileSync(join(r.root, 'k.txt'), 'a longer, different content\n')
        writeFileSync(join(r.root, 'k.txt'), 'card K\n')
      }
    })
    expect(jjCredit(rec)).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
  })

  it("a plain Git commit during the run (jj hasn't imported it): moved; once imported, it is attributed to no card", async () => {
    const r = await repo('plain-git')
    expect(await credit(r, r.R, { run: () => git(r.root, 'commit', '-q', '--allow-empty', '-m', 'plain git') })).toMatchObject({ whyNot: 'moved', why: 'end:beforeBoundary' })
    writeFileSync(join(r.root, 'g.txt'), 'by git\n')
    git(r.root, 'add', 'g.txt')
    git(r.root, 'commit', '-q', '-m', 'plain git file')
    const imported = git(r.root, 'rev-parse', 'HEAD').trim()
    expect(isRefused(await jjBoundary({ ...r.view, folder: r.root }, owner, { lock: noLock }, runner))).toBe(false) // imports it
    const rec = recorded([['HI-1', r.R, r.id(r.R, 'change_id')]])
    expect(await jjAttributeAt(r.reads, imported, rec)).toEqual({ none: true })
  })

  it('a bookmark set by another command during the run, or racing the end boundary: moved, never retried onto it', async () => {
    const r = await repo('bookmark')
    expect(await credit(r, r.R, { run: () => jj(r.root, '--ignore-working-copy', 'bookmark', 'set', 'elsewhere', '-r', r.base) })).toMatchObject({ whyNot: 'moved', why: 'end:beforeBoundary' })
    const s = await repo('bookmark-race')
    const race = { boundary: { endHooks: { beforeSnapshot: () => void jj(s.root, '--ignore-working-copy', 'bookmark', 'set', 'racer', '-r', s.base) } } }
    expect(await credit(s, s.R, { seams: race })).toMatchObject({ whyNot: 'moved', why: 'end:moved' })
    const g = await repo('git-race')
    const gitRace = { boundary: { endHooks: { beforeRecheck: () => void git(g.root, 'update-ref', 'refs/heads/side', g.base) } } }
    expect(await credit(g, g.R, { seams: gitRace })).toMatchObject({ whyNot: 'moved' })
  })

  it('a stable change id rewritten with new content earns no credit and carries no pass; the same content does', async () => {
    const r = await repo('rewrite')
    const before = await commitOf(r, r.R)
    writeFileSync(join(r.root, 'k2.txt'), 'more of K\n')
    jj(r.root, 'squash', '--into', r.R)
    const after = await commitOf(r, before.change)
    expect(after.change).toBe(before.change)
    expect(after.commit).not.toBe(before.commit)
    expect(await credit(r, r.R)).toMatchObject({ whyNot: 'notContained' })
    expect(await jjSameRevision({ base: r.base, commit: before }, { base: r.base, commit: after }, sameChange(r))).toBe(false)
    // A description-only rewrite: a new commit, the same content, so the pass carries (by content, not the change id).
    jj(r.root, '--ignore-working-copy', 'describe', '-r', after.commit, '-m', 'K, reworded')
    const reworded = await commitOf(r, before.change)
    expect(reworded.commit).not.toBe(after.commit)
    expect(await jjSameRevision({ base: r.base, commit: after }, { base: r.base, commit: reworded }, sameChange(r))).toBe(true)
  })

  it('a divergent change: no credit, attribution ambiguous', async () => {
    const r = await repo('divergent')
    const change = r.id(r.R, 'change_id')
    const op = readOpHeads(r.view.jjRepo)![0]
    jj(r.root, '--ignore-working-copy', 'describe', '-r', r.R, '-m', 'v1')
    jj(r.root, '--at-op', op, 'describe', '-r', r.R, '-m', 'v2')
    expect(readOpHeads(r.view.jjRepo)!.length).toBe(2)
    // Two heads: Combwork reads nothing through jj, and its reads merge nothing.
    expect(r.reads.head()).toMatchObject({ jjUnknown: 'heads' })
    expect(readOpHeads(r.view.jjRepo)!.length).toBe(2)
    // A write (here the user's own jj) reconciles them; the change is divergent.
    jj(r.root, 'status')
    const variants = await r.reads.pinned((o) => r.reads.changeAt(o, change))
    if (isJjUnknown(variants)) throw new Error(JSON.stringify(variants))
    expect(variants.value.length).toBe(2)
    for (const v of variants.value) {
      expect(v.divergent).toBe(true)
      expect(await credit(r, v.commit)).toMatchObject({ whyNot: 'notContained' })
      expect(await jjAttributeAt(r.reads, v.commit, recorded([['HI-1', r.R, change]]))).toMatchObject({ ambiguous: 'divergent' })
    }
    expect(await r.reads.pinned((o) => r.reads.commitAt(o, change))).toMatchObject({ jjUnknown: 'ambiguous' })
  })

  it('a reviewed commit that becomes one variant of a divergent change, keeping its exact id, carries no pass', async () => {
    const r = await repo('divergent-same-id')
    const op = readOpHeads(r.view.jjRepo)![0]
    // The card's revision is a rewrite of R (R1), reviewed while it was the change's only commit.
    jj(r.root, '--ignore-working-copy', 'describe', '-r', r.R, '-m', 'K, reviewed')
    const R1 = r.id('description(substring:"K, reviewed")')
    const reviewed = await commitOf(r, R1)
    expect(reviewed.divergent).toBe(false)
    // Another rewrite of R, made from the operation before (another agent, an external jj): R1 itself is unchanged.
    jj(r.root, '--at-op', op, 'describe', '-r', r.R, '-m', 'K, another variant')
    jj(r.root, 'status') // the user's own jj reconciles the two heads
    const now = await commitOf(r, R1)
    expect(now.commit).toBe(reviewed.commit)
    expect(now.divergent).toBe(true)
    expect(await jjSameRevision({ base: r.base, commit: reviewed }, { base: r.base, commit: now }, sameChange(r))).toBe(false)
    expect(await credit(r, R1)).toMatchObject({ whyNot: 'notContained' })
  })

  it("a split: the part keeping the change id has other content (no credit, no pass) and stays the card's", async () => {
    const r = await repo('split')
    writeFileSync(join(r.root, 'k2.txt'), 'more of K\n')
    jj(r.root, 'squash', '--into', r.R)
    const submitted = await commitOf(r, r.id(r.R, 'change_id'))
    jj(r.root, 'split', '-r', submitted.commit, '-m', 'K part 1', 'k.txt')
    const part1 = await commitOf(r, submitted.change)
    expect(part1.commit).not.toBe(submitted.commit)
    expect(await credit(r, submitted.commit)).toMatchObject({ whyNot: 'notContained' })
    expect(await jjSameRevision({ base: r.base, commit: submitted }, { base: r.base, commit: part1 }, sameChange(r))).toBe(false)
    expect(await jjAttributeAt(r.reads, part1.commit, recorded([['HI-1', submitted.commit, submitted.change]]))).toEqual({ card: 'HI-1' })
  })

  it("a squash across two cards: both are in the result's evolution, so it is ambiguous", async () => {
    const r = await repo('squash')
    writeFileSync(join(r.root, 'l.txt'), 'card L\n')
    jj(r.root, 'commit', '-m', 'L')
    const L = r.id('@-')
    const rec = recorded([
      ['HI-1', r.R, r.id(r.R, 'change_id')],
      ['HI-2', L, r.id(L, 'change_id')]
    ])
    jj(r.root, 'squash', '--from', L, '--into', r.R, '-m', 'K and L')
    const result = r.id('description(substring:"K and L")')
    expect(await jjAttributeAt(r.reads, result, rec)).toMatchObject({ ambiguous: 'several' })
  })

  it('a stale workspace: the boundary refuses it and leaves its local edit where it was', async () => {
    const r = await repo('stale')
    const other = join(r.parent, 'ws2')
    jj(r.root, 'workspace', 'add', other, '--name', 'ws2')
    writeFileSync(join(r.root, 'dest.txt'), 'destination\n')
    jj(r.root, 'commit', '-m', 'destination')
    jj(r.root, 'rebase', '-r', 'ws2@', '-d', '@-')
    writeFileSync(join(other, 'local.txt'), 'local edit\n')
    const o = await jjContextOf(resolve(realpathSync.native(other)), runner)
    if (!('jj' in o)) throw new Error('not detected')
    const heads = readOpHeads(r.view.jjRepo)
    const b = await jjBoundary({ jjRepo: o.jj.jjRepo, workspace: o.jj.workspace, root: o.jj.root, store: o.jj.store, colocated: o.jj.colocated, folder: o.jj.root }, owner, { lock: noLock }, runner)
    expect(b).toMatchObject({ refused: 'stale' })
    expect(readOpHeads(r.view.jjRepo)).toEqual(heads)
    expect(readdirSync(other)).toContain('local.txt')
  })

  it('the observer reads at the single head, reports a moved bookmark, and reads nothing with two heads', async () => {
    const r = await repo('observe')
    jj(r.root, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', r.base)
    const events: unknown[] = []
    const obs = jjObserver({ project: r.root, view: r.view, workspace: 'default', folder: r.root, onChange: (e) => events.push(e), runner, intervalMs: 0, watch: null })
    try {
      await obs.rescan()
      const first = obs.refsNow()
      expect(first).toBe(readOpHeads(r.view.jjRepo)![0])
      jj(r.root, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', r.R)
      await obs.rescan()
      expect(events).toContainEqual({ kind: 'lineMoved', project: r.root, line: 'main', from: r.base, to: r.R })
      const op = readOpHeads(r.view.jjRepo)![0]
      jj(r.root, '--ignore-working-copy', 'bookmark', 'set', 'one', '-r', r.base)
      jj(r.root, '--at-op', op, 'bookmark', 'set', 'two', '-r', r.base)
      const two = readOpHeads(r.view.jjRepo)
      expect(two!.length).toBe(2)
      await obs.rescan()
      expect(obs.refsNow()).toBeNull()
      expect(readOpHeads(r.view.jjRepo)).toEqual(two) // nothing merged them
    } finally {
      obs.dispose()
    }
  })
})
