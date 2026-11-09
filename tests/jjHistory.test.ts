// jj's history, evidence and attribution (HI-2796's J3) on hand-made `.jj` files and a simulated jj: the bounded file
// reads (operation heads, the checkout record), the pinned reads' parsers and their completeness, the facts' optional
// ids, attribution's rules, and the check bracket's order with races put at each barrier (an owner lost mid-boundary,
// an operation or a Git change before, inside and after the end boundary). Real jj's behaviour is jjHistoryReal.test.ts's.
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { jjAttribute, type Recorded } from '../src/main/platform/jjAttribution'
import { jjBoundary, type Owner } from '../src/main/platform/jjBoundary'
import { jjCheckEnd, jjCheckStart, jjCounts, jjCredit, jjSameRevision, testedFor, type JjCheckFor, type JjCheckSeams } from '../src/main/platform/jjChecks'
import { jjIdsOf, jjPlatform, recordedIds } from '../src/main/platform/jjFacts'
import { jjObserver, parseBookmarks } from '../src/main/platform/jjObserve'
import { EVOLOG_MAX, isJjUnknown, JjReads, parseCommitLine, parseEvolution, type JjCommit } from '../src/main/platform/jjReads'
import type { JjRunner, JjRunResult } from '../src/main/platform/jjRunner'
import { jjFingerprint, OP_HEADS_MAX, parseCheckout, readCheckout, readOpHeads, RECORD_MAX, singleHead, type ViewOf } from '../src/main/platform/jjView'
import type { FolderChanges, WriteLog } from '../src/main/platform/history'
import type { Fact } from '../src/shared/workflow/facts'
import type { JjTool } from '../src/shared/jjTool'
import type { Maybe } from '../src/main/platform/types'
import { tempDir } from './tempDir'

const OK: JjTool = { state: 'ok', version: '0.47.1', path: 'C:\\tools\\jj.exe' }
const op = (n: number): string => n.toString(16).padStart(128, '0')
const commit = (n: number): string => n.toString(16).padStart(40, 'a')
const change = (c: string): string => c.repeat(32)
const answer = (out: string, code = 0): JjRunResult => ({ out, ok: code === 0, buf: Buffer.from(out), err: code ? `Error: ${out}` : '', code })

/** A checkout record as jj 0.47.1 writes it: field 2 the operation id's 64 bytes, field 3 the workspace's name. */
function checkoutBytes(opId: string, name: string): Buffer {
  const id = Buffer.from(opId, 'hex')
  const n = Buffer.from(name, 'utf8')
  return Buffer.concat([Buffer.from([0x12, id.length]), id, Buffer.from([0x1a, n.length]), n])
}

const line = (c: JjCommit): string => [c.commit, c.change, c.parents.join(','), c.empty, c.divergent, c.conflict].join('\t') + '\n'

/** A simulated jj workspace: its heads and checkout record in real files, and a jj that answers from its state. */
class FakeRepo {
  root = tempDir('jjfake-')
  jjRepo = join(this.root, '.jj', 'repo')
  next = 2
  head = op(1)
  /** The files on disk differ from @ (a snapshot records them). */
  dirty = false
  at: JjCommit = { commit: commit(2), change: change('w'), parents: [commit(1)], empty: true, divergent: false, conflict: false }
  revs = new Map<string, JjCommit>([[commit(1), { commit: commit(1), change: change('k'), parents: [commit(9)], empty: false, divergent: false, conflict: false }]])
  files = ['a.txt']
  track = 'all()'
  snapshotFails: string | null = null
  /** The snapshot is cancelled (its signal aborted: the runner's result says so, code -1). */
  snapshotCancelled = false
  calls: string[][] = []
  /** Runs inside a command, before it answers (a race put exactly there). */
  during: ((args: readonly string[]) => void) | null = null
  constructor() {
    mkdirSync(join(this.jjRepo, 'op_heads', 'heads'), { recursive: true })
    mkdirSync(join(this.root, '.jj', 'working_copy'), { recursive: true })
    writeFileSync(join(this.root, 'a.txt'), 'a\n')
    this.setHeads([this.head])
    this.setCheckout(this.head)
  }
  get view(): ViewOf {
    return { jjRepo: this.jjRepo, workspace: join(this.root, '.jj'), root: this.root, store: join(this.root, 'store'), colocated: false }
  }
  setHeads(heads: string[]): void {
    const d = join(this.jjRepo, 'op_heads', 'heads')
    rmSync(d, { recursive: true, force: true })
    mkdirSync(d)
    for (const h of heads) writeFileSync(join(d, h), '')
  }
  setCheckout(opId: string, name = 'default'): void {
    writeFileSync(join(this.root, '.jj', 'working_copy', 'checkout'), checkoutBytes(opId, name))
  }
  /** Another command's operation (a bookmark set elsewhere): a new head, nothing of this workspace changed. */
  otherOp(): void {
    this.head = op(this.next++)
    this.setHeads([this.head])
  }
  runner(tool: JjTool = OK): JjRunner {
    return {
      readiness: async () => tool,
      readinessNow: () => tool,
      problem: () => null,
      shutdown: async () => undefined,
      run: async (_folder, args) => {
        this.calls.push([...args])
        this.during?.(args)
        const a = [...args]
        if (a[0] === 'util' && a[1] === 'snapshot') {
          if (this.snapshotCancelled) return { out: '', ok: false, buf: Buffer.alloc(0), err: 'cancelled', code: -1, notRun: 'cancelled', cancelled: true }
          if (this.snapshotFails) return answer(this.snapshotFails, 1)
          if (this.dirty) {
            this.dirty = false
            this.head = op(this.next++)
            this.at = { ...this.at, commit: commit(this.next++), empty: false }
            this.setHeads([this.head])
          }
          this.setCheckout(this.head)
          return answer('')
        }
        if (a[0] !== '--at-op') return answer('not pinned', 1)
        // jj answers at any operation it has, the head or an older one (as `--at-op` does).
        const rest = a.slice(2)
        if (rest[0] === 'log') {
          const rev = rest[rest.indexOf('-r') + 1]
          if (rev === 'default@') return answer(line(this.at))
          const c = this.revs.get(rev) ?? (rev === this.at.commit ? this.at : null)
          return c ? answer(line(c)) : answer(`Revision \`${rev}\` doesn't exist`, 1)
        }
        if (rest[0] === 'file') return answer(this.files.map((f) => `${f}\n`).join(''))
        if (rest[0] === 'config') return answer(`${this.track}\n`)
        if (rest[0] === 'bookmark') return answer(`main\t\tfalse\t${commit(1)}\n`)
        return answer('unknown command', 1)
      }
    }
  }
}

/** A write log that says what it's told. */
const logSays = (seen: Maybe<FolderChanges>): WriteLog => ({ settled: async () => undefined, changedBetween: async () => seen })
const QUIET = logSays({ changed: false, paths: [] })
const owns = (): Owner & { lose(): void } => {
  let ok = true
  return { still: () => ok, lose: () => void (ok = false) }
}
const noLock = <T>(fn: () => Promise<T>): Promise<T> => fn()

/** Runs a whole bracket on the fake: start, the command (`run`), end, credit. */
async function bracket(f: FakeRepo, o: { owner?: Owner; log?: WriteLog; run?: () => void; seams?: JjCheckSeams } = {}) {
  const r: JjCheckFor = { view: f.view, folder: f.root, revision: commit(1), owner: o.owner ?? owns(), lock: noLock }
  const seams: JjCheckSeams = { runner: f.runner(), ...o.seams }
  const start = await jjCheckStart(r, o.log ?? QUIET, seams)
  o.run?.()
  const rec = await jjCheckEnd(r, start, o.log ?? QUIET, seams)
  return jjCredit(rec)
}

describe('jj view files (bounded, no process)', () => {
  it('reads the heads sorted, and refuses a stray name, none or more than the bound', () => {
    const f = new FakeRepo()
    expect(readOpHeads(f.jjRepo)).toEqual([op(1)])
    f.setHeads([op(3), op(2)])
    expect(readOpHeads(f.jjRepo)).toEqual([op(2), op(3)])
    expect(singleHead(f.jjRepo)).toBeNull()
    f.setHeads([op(1), 'not-an-op'])
    expect(readOpHeads(f.jjRepo)).toBeNull()
    f.setHeads([])
    expect(readOpHeads(f.jjRepo)).toBeNull()
    f.setHeads(Array.from({ length: OP_HEADS_MAX + 1 }, (_, i) => op(i + 1)))
    expect(readOpHeads(f.jjRepo)).toBeNull()
    expect(readOpHeads(join(f.root, 'nowhere'))).toBeNull()
  })

  it('parses a checkout record, and anything malformed is null', () => {
    const good = checkoutBytes(op(7), 'default')
    expect(parseCheckout(good)).toEqual({ op: op(7), workspace: 'default' })
    expect(parseCheckout(Buffer.concat([Buffer.from([0x0a, 2, 1, 2]), good]))).toEqual({ op: op(7), workspace: 'default' })
    expect(parseCheckout(good.subarray(0, good.length - 1))).toBeNull() // truncated
    expect(parseCheckout(Buffer.concat([good, Buffer.from([0x1a, 1, 0x41])]))).toBeNull() // duplicate field
    expect(parseCheckout(Buffer.concat([good, Buffer.from([0x20, 1])]))).toBeNull() // an unknown field, varint wire type
    expect(parseCheckout(Buffer.from([0x12, 3, 1, 2, 3, 0x1a, 1, 0x41]))).toBeNull() // an op id that isn't 64 bytes
    expect(parseCheckout(Buffer.concat([Buffer.from([0x12, 64]), Buffer.from(op(7), 'hex')]))).toBeNull() // no name
    expect(parseCheckout(Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0xff]))).toBeNull() // a varint past 5 bytes
    const f = new FakeRepo()
    writeFileSync(join(f.root, '.jj', 'working_copy', 'checkout'), Buffer.alloc(RECORD_MAX + 1, 0x12))
    expect(readCheckout(join(f.root, '.jj'))).toBeNull() // past the bound
  })

  it("fingerprints only the bounded parts, and is null with several heads", () => {
    const f = new FakeRepo()
    const a = jjFingerprint(f.view)
    expect(a).toContain(op(1))
    writeFileSync(join(f.root, 'a.txt'), 'raw edit\n')
    expect(jjFingerprint(f.view)).toBe(a) // the working tree is the boundary's, never walked here
    f.otherOp()
    expect(jjFingerprint(f.view)).not.toBe(a)
    f.setHeads([op(1), op(2)])
    expect(jjFingerprint(f.view)).toBeNull()
  })
})

describe('jj pinned reads', () => {
  it('parses commit lines strictly', () => {
    const c: JjCommit = { commit: commit(1), change: change('k'), parents: [commit(2), commit(3)], empty: false, divergent: true, conflict: false }
    expect(parseCommitLine(line(c).trim())).toEqual(c)
    expect(parseCommitLine(line({ ...c, parents: [] }).trim())).toEqual({ ...c, parents: [] })
    expect(parseCommitLine(line(c).trim().replace('true', 'yes'))).toBeNull()
    expect(parseCommitLine(`${commit(1).slice(0, 12)}\t${change('k')}\t\tfalse\tfalse\tfalse`)).toBeNull() // a short id
    expect(parseCommitLine(`${commit(1)}\t${'a'.repeat(32)}\t\tfalse\tfalse\tfalse`)).toBeNull() // not a change id
  })

  it('takes an evolution only when complete: capped, malformed, truncated or not the commit is unknown', () => {
    const e = (n: number): string => `${commit(n)}\t${change('k')}\n`
    expect(parseEvolution(commit(1), e(1) + e(2))).toEqual({ commit: commit(1), entries: [{ commit: commit(1), change: change('k') }, { commit: commit(2), change: change('k') }] })
    const capped = Array.from({ length: EVOLOG_MAX + 1 }, (_, i) => e(i + 1)).join('')
    expect(parseEvolution(commit(1), capped)).toEqual({ jjUnknown: 'malformed', detail: 'capped' })
    expect(isJjUnknown(parseEvolution(commit(1), Array.from({ length: EVOLOG_MAX }, (_, i) => e(i + 1)).join('')))).toBe(false)
    expect(isJjUnknown(parseEvolution(commit(1), e(1) + 'garbage\n'))).toBe(true)
    expect(isJjUnknown(parseEvolution(commit(1), e(1) + commit(2).slice(0, 20)))).toBe(true) // truncated
    expect(isJjUnknown(parseEvolution(commit(1), e(2) + e(1)))).toBe(true) // not the commit first
    expect(isJjUnknown(parseEvolution(commit(1), ''))).toBe(true)
  })

  it('reads nothing through jj with several heads, and an untested jj is never asked', async () => {
    const f = new FakeRepo()
    f.setHeads([op(1), op(2)])
    const reads = new JjReads({ folder: f.root, jjRepo: f.jjRepo }, f.runner())
    expect(reads.head()).toEqual({ jjUnknown: 'heads', detail: '2 heads' })
    expect(await reads.pinned((o) => reads.commitAt(o, commit(1)))).toMatchObject({ jjUnknown: 'heads' })
    expect(f.calls).toEqual([])
    f.setHeads([op(1)])
    const untested = new JjReads({ folder: f.root, jjRepo: f.jjRepo }, f.runner({ state: 'untested', version: '0.48.0' }))
    expect(await untested.commitAt(op(1), commit(1))).toEqual({ jjUnknown: 'tool', detail: 'untested' })
    expect(f.calls).toEqual([])
  })

  it('a pinned answer whose head moved while it was read is not used', async () => {
    const f = new FakeRepo()
    const reads = new JjReads({ folder: f.root, jjRepo: f.jjRepo }, f.runner())
    expect(await reads.pinned((o) => reads.commitAt(o, commit(1)))).toMatchObject({ op: op(1), value: { commit: commit(1) } })
    f.during = () => f.otherOp()
    expect(await reads.pinned((o) => reads.commitAt(o, commit(1)))).toEqual({ jjUnknown: 'moved' })
  })

  it('a divergent change id is ambiguous, never one picked', async () => {
    const f = new FakeRepo()
    const runner = f.runner()
    const inner = runner.run
    runner.run = async (folder, args, o) => (args.includes('-r') && args[args.indexOf('-r') + 1] === change('k') ? answer(`Error: Change ID \`${change('k')}\` is divergent`, 1) : inner(folder, args, o))
    const reads = new JjReads({ folder: f.root, jjRepo: f.jjRepo }, runner)
    expect(await reads.commitAt(op(1), change('k'))).toMatchObject({ jjUnknown: 'ambiguous' })
  })
})

describe('jj facts: optional ids in data.platform', () => {
  const ids = { changeId: change('k'), commitId: commit(1), operation: op(1), workspace: 'default' }
  it('reads complete, valid ids only; old facts have none', () => {
    expect(jjIdsOf(jjPlatform(ids))).toEqual(ids)
    expect(jjIdsOf(jjPlatform({ changeId: ids.changeId, commitId: ids.commitId }))).toEqual({ changeId: ids.changeId, commitId: ids.commitId })
    expect(jjIdsOf(undefined)).toBeNull()
    expect(jjIdsOf({ git: { refs: 'x' } })).toBeNull()
    expect(jjIdsOf({ jj: { ...ids, changeId: commit(1) } })).toBeNull() // a commit id where the change id goes
    expect(jjIdsOf({ jj: { ...ids, commitId: change('k') } })).toBeNull()
    expect(jjIdsOf({ jj: { ...ids, operation: 'abc' } })).toBeNull()
    expect(jjIdsOf({ jj: { ...ids, workspace: 'a\nb' } })).toBeNull()
    expect(jjIdsOf({ jj: { ...ids, extra: 1 } })).toBeNull()
  })

  it("records a submission's or adoption's commit only when it is the fact's own revision, never a start's base", () => {
    const fact = (kind: Fact['kind'], data: Record<string, unknown>): Fact => ({ seq: 1, card: 1, kind, at: '', actor: 'user', source: 'recorded', data }) as unknown as Fact
    const rec = recordedIds([
      { card: 'HI-1', facts: [fact('Submitted', { revision: commit(1), platform: jjPlatform({ changeId: change('k'), commitId: commit(1) }) })] },
      { card: 'HI-2', facts: [fact('Submitted', { revision: commit(5), platform: jjPlatform({ changeId: change('l'), commitId: commit(6) }) })] },
      { card: 'HI-3', facts: [fact('Started', { base: commit(7), platform: jjPlatform({ changeId: change('m'), commitId: commit(7) }) })] },
      { card: 'HI-4', facts: [fact('Adopted', { base: commit(7), head: commit(8), platform: jjPlatform({ changeId: change('n'), commitId: commit(8) }) })] }
    ])
    expect([...rec.commits.keys()].sort()).toEqual([commit(1), commit(8)])
    expect([...rec.changes.keys()].sort()).toEqual([change('k'), change('n')])
  })
})

describe('jj attribution (positive provenance only)', () => {
  const rec = (commits: [string, string[]][], changes: [string, string[]][] = []): Recorded => ({ commits: new Map(commits.map(([c, k]) => [c, new Set(k)])), changes: new Map(changes.map(([c, k]) => [c, new Set(k)])) })
  const evo = (...cs: [number, string][]) => ({ commit: commit(cs[0][0]), entries: cs.map(([n, ch]) => ({ commit: commit(n), change: change(ch) })) })
  it('a recorded commit, or one in its complete evolution, is the card; nothing recorded is none whatever the lease', () => {
    const r = rec([[commit(2), ['HI-1']]], [[change('k'), ['HI-1']]])
    expect(jjAttribute({ commit: commit(2), divergent: false, evolution: evo([2, 'k']) }, r)).toEqual({ card: 'HI-1' })
    expect(jjAttribute({ commit: commit(3), divergent: false, evolution: evo([3, 'k'], [2, 'k']) }, r)).toEqual({ card: 'HI-1' }) // a rewrite or a split
    expect(jjAttribute({ commit: commit(4), divergent: false, evolution: evo([4, 'x']) }, r)).toEqual({ none: true }) // an import
  })
  it('two cards in its evolution, a change id recorded for another card, divergence or incomplete history are ambiguous', () => {
    const r = rec(
      [
        [commit(2), ['HI-1']],
        [commit(3), ['HI-2']]
      ],
      [
        [change('k'), ['HI-1']],
        [change('l'), ['HI-2']]
      ]
    )
    expect(jjAttribute({ commit: commit(5), divergent: false, evolution: evo([5, 'k'], [2, 'k'], [3, 'l']) }, r)).toMatchObject({ ambiguous: 'several' })
    expect(jjAttribute({ commit: commit(5), divergent: false, evolution: evo([5, 'l'], [2, 'k']) }, r)).toMatchObject({ ambiguous: 'changeId' })
    expect(jjAttribute({ commit: commit(2), divergent: true, evolution: evo([2, 'k']) }, r)).toMatchObject({ ambiguous: 'divergent' })
    expect(jjAttribute({ commit: commit(2), divergent: false, evolution: { jjUnknown: 'malformed', detail: 'capped' } }, r)).toMatchObject({ ambiguous: 'history' })
    expect(jjAttribute({ commit: commit(2), divergent: false, evolution: evo([9, 'k']) }, r)).toMatchObject({ ambiguous: 'history' })
  })
})

describe('jj boundary', () => {
  it("snapshots under its owner and answers @ at the head it left; dirty disk is recorded", async () => {
    const f = new FakeRepo()
    const b = await jjBoundary({ ...f.view, folder: f.root }, owns(), { lock: noLock }, f.runner())
    expect(b).toMatchObject({ before: op(1), op: op(1), recorded: false, at: { commit: commit(2) } })
    f.dirty = true
    const c = await jjBoundary({ ...f.view, folder: f.root }, owns(), { lock: noLock }, f.runner())
    expect(c).toMatchObject({ before: op(1), recorded: true })
  })

  it('refuses when its owner is lost at an await, stale, cancelled, untested, or auto-track narrowed', async () => {
    const f = new FakeRepo()
    const w = { ...f.view, folder: f.root }
    const o = owns()
    expect(await jjBoundary(w, o, { lock: noLock, hooks: { afterSnapshot: () => o.lose() } }, f.runner())).toEqual({ refused: 'owner' })
    const o2 = owns()
    expect(await jjBoundary(w, o2, { lock: noLock, hooks: { beforeSnapshot: () => o2.lose() } }, f.runner())).toEqual({ refused: 'owner' })
    f.snapshotFails = 'The working copy is stale'
    expect(await jjBoundary(w, owns(), { lock: noLock }, f.runner())).toMatchObject({ refused: 'stale' })
    f.snapshotFails = null
    f.snapshotCancelled = true
    expect(await jjBoundary(w, owns(), { lock: noLock }, f.runner())).toEqual({ refused: 'cancelled' })
    f.snapshotCancelled = false
    const runs = f.calls.length
    expect(await jjBoundary(w, owns(), { lock: noLock }, f.runner({ state: 'untested', version: '0.48.0' }))).toMatchObject({ refused: 'unknown' })
    expect(f.calls.length).toBe(runs) // an untested jj never writes
    f.track = 'none()'
    expect(await jjBoundary(w, owns(), { lock: noLock }, f.runner())).toEqual({ refused: 'autoTrack', detail: 'none()' })
  })

  it('strict: heads other than expected before the snapshot, or moving after it, are moved; it never retries', async () => {
    const f = new FakeRepo()
    const w = { ...f.view, folder: f.root }
    expect(await jjBoundary(w, owns(), { lock: noLock, expect: op(9) }, f.runner())).toMatchObject({ refused: 'moved' })
    expect(await jjBoundary(w, owns(), { lock: noLock, hooks: { beforeRecheck: () => f.otherOp() } }, f.runner())).toMatchObject({ refused: 'moved' })
    f.setHeads([op(1), op(2)])
    expect(await jjBoundary(w, owns(), { lock: noLock }, f.runner())).toEqual({ refused: 'heads' })
  })
})

describe('jj check credit: the bracket with races at each barrier', () => {
  it('a clean run on an empty @ over the revision counts, tested as the revision', async () => {
    expect(await bracket(new FakeRepo())).toEqual({ revision: commit(1), tested: commit(1) })
  })

  it('a dirty start, a run on another revision, a divergent or conflicted revision earn nothing', async () => {
    const dirty = new FakeRepo()
    dirty.dirty = true
    expect(await bracket(dirty)).toMatchObject({ whyNot: 'dirty', why: 'start:recorded' })
    const other = new FakeRepo()
    other.at = { ...other.at, parents: [commit(3)] }
    expect(await bracket(other)).toMatchObject({ whyNot: 'notContained' })
    const div = new FakeRepo()
    div.revs.set(commit(1), { ...div.revs.get(commit(1))!, divergent: true })
    expect(await bracket(div)).toMatchObject({ whyNot: 'notContained' })
    const conflicted = new FakeRepo()
    conflicted.at = { ...conflicted.at, conflict: true }
    expect(await bracket(conflicted)).toMatchObject({ whyNot: 'notContained' })
  })

  it("a same change id on a new commit isn't the revision", () => {
    const rev = { commit: commit(1), change: change('k'), parents: [commit(9)], empty: false, divergent: false, conflict: false }
    expect(testedFor(commit(1), { ...rev, commit: commit(5) }, rev)).toBeNull()
  })

  it('an operation by anyone during the run (a bookmark set elsewhere) is moved', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { run: () => f.otherOp() })).toMatchObject({ whyNot: 'moved', why: 'end:beforeBoundary' })
  })

  it('the bookmark-only race after the pre-boundary read, before the end snapshot: moved, not retried onto it', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { seams: { boundary: { endHooks: { beforeSnapshot: () => f.otherOp() } } } })).toMatchObject({ whyNot: 'moved', why: 'end:moved' })
  })

  it('the same race inside the end boundary, after its snapshot: no credit', async () => {
    const f = new FakeRepo()
    const c = await bracket(f, { seams: { boundary: { endHooks: { afterSnapshot: () => f.otherOp() } } } })
    expect(c.whyNot).toBeDefined()
    expect(c.tested).toBe(commit(1))
  })

  it('an op between the end boundary and the final read: moved', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { seams: { hooks: { beforeFinal: () => f.otherOp() } } })).toMatchObject({ whyNot: 'moved', why: 'end:final' })
  })

  it('an owner lost while the end boundary waits refuses it', async () => {
    const f = new FakeRepo()
    const o = owns()
    expect(await bracket(f, { owner: o, seams: { boundary: { endHooks: { beforeSnapshot: () => o.lose() } } } })).toMatchObject({ whyNot: 'changed', why: 'end:owner' })
  })

  it('a cancelled end boundary earns nothing', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { run: () => void (f.snapshotCancelled = true) })).toMatchObject({ whyNot: 'changed', why: 'end:cancelled' })
  })

  it('a raw write the watcher missed is recorded by the end boundary', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { run: () => void (f.dirty = true) })).toMatchObject({ whyNot: 'changed', why: 'end:recorded' })
  })

  it('an edit and its undo is in the write record; an incomplete record falls back to the stat snapshot', async () => {
    const f = new FakeRepo()
    expect(await bracket(f, { log: logSays({ changed: true, paths: [':edit', 'a.txt'] }) })).toMatchObject({ whyNot: 'changed', why: 'end:written', changes: [':edit', 'a.txt'] })
    const unknownLog = logSays({ unknown: true, what: 'writes' })
    expect(await bracket(new FakeRepo(), { log: unknownLog })).toEqual({ revision: commit(1), tested: commit(1) })
    const g = new FakeRepo()
    expect(await bracket(g, { log: unknownLog, run: () => writeFileSync(join(g.root, 'a.txt'), 'a longer edit\n') })).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
  })

  it('a colocated Git change (a plain commit jj has not imported) during the run, or during the end boundary, is moved', async () => {
    const colocated = (): FakeRepo => {
      const f = new FakeRepo()
      mkdirSync(join(f.root, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(f.root, '.git', 'HEAD'), `${commit(1)}\n`)
      Object.defineProperty(f, 'view', { get: () => ({ jjRepo: f.jjRepo, workspace: join(f.root, '.jj'), root: f.root, store: join(f.root, '.git'), colocated: true }) })
      return f
    }
    const gitCommit = (f: FakeRepo): void => writeFileSync(join(f.root, '.git', 'HEAD'), `${commit(4)}\n`)
    const a = colocated()
    expect(await bracket(a)).toEqual({ revision: commit(1), tested: commit(1) })
    const b = colocated()
    expect(await bracket(b, { run: () => gitCommit(b) })).toMatchObject({ whyNot: 'moved', why: 'end:beforeBoundary' })
    const c = colocated()
    expect(await bracket(c, { seams: { boundary: { endHooks: { beforeRecheck: () => gitCommit(c) } } } })).toMatchObject({ whyNot: 'moved', why: 'end:moved' })
    const d = colocated()
    expect(await bracket(d, { seams: { hooks: { beforeFinal: () => gitCommit(d) } } })).toMatchObject({ whyNot: 'moved', why: 'end:final' })
  })

  it("jj's and Git's own folders never count in the write record", () => {
    expect(jjCounts(['.jj/repo/x', '.git\\index', 'src/a.ts', ':edit'])).toEqual(['src/a.ts', ':edit'])
  })

  it('a pass carries on the same commit or the same content, never on an equal change id alone', async () => {
    const c = (n: number, o: Partial<JjCommit> = {}): JjCommit => ({ commit: commit(n), change: change('k'), parents: [], empty: false, divergent: false, conflict: false, ...o })
    const never = async (): Promise<boolean> => false
    expect(await jjSameRevision({ base: commit(9), commit: c(1) }, { base: commit(9), commit: c(1) }, never)).toBe(true)
    expect(await jjSameRevision({ base: commit(9), commit: c(1) }, { base: commit(9), commit: c(2) }, never)).toBe(false)
    expect(await jjSameRevision({ base: commit(9), commit: c(1) }, { base: commit(9), commit: c(2, { divergent: true }) }, async () => true)).toBe(false)
    expect(await jjSameRevision({ base: commit(9), commit: c(1) }, { base: commit(9), commit: c(2) }, async () => true)).toBe(true)
  })
})

describe('jj observer', () => {
  it('reports a moved line at a new single head, nothing with several heads, and stops when disposed', async () => {
    const f = new FakeRepo()
    const events: unknown[] = []
    const runner = f.runner()
    let main = commit(1)
    const inner = runner.run
    runner.run = async (folder, args, o) => (args[2] === 'bookmark' ? answer(`main\t\tfalse\t${main}\n`) : inner(folder, args, o))
    const obs = jjObserver({ project: f.root, view: f.view, workspace: 'default', folder: f.root, onChange: (e) => events.push(e), runner, intervalMs: 0, watch: null })
    await obs.rescan()
    expect(obs.refsNow()).toBe(op(1))
    main = commit(3)
    f.otherOp()
    await obs.rescan()
    expect(events).toEqual([{ kind: 'lineMoved', project: f.root, line: 'main', from: commit(1), to: commit(3) }])
    f.setHeads([op(20), op(21)])
    const calls = f.calls.length
    await obs.rescan()
    expect(obs.refsNow()).toBeNull()
    expect(f.calls.length).toBe(calls)
    obs.dispose()
    f.setHeads([op(22)])
    f.head = op(22)
    await obs.rescan()
    expect(obs.refsNow()).toBeNull()
    expect(events.length).toBe(1)
  })

  it('parses local bookmarks; a conflicted one has no place; anything else is malformed', () => {
    expect(parseBookmarks(`main\t\tfalse\t${commit(1)}\nmain\torigin\tfalse\t${commit(2)}\nx\t\ttrue\t\n`)).toEqual(new Map([['main', commit(1)], ['x', null]]))
    expect(parseBookmarks('main\t\tmaybe\t\n')).toBeNull()
  })
})
