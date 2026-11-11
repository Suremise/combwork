// HI-2938's runner of a jj candidate's merge checks (workflow/jjCandidateChecks.ts, design HI-2938/s11), its decisions
// with every part stood in for: the journal (each phase before its step; another attempt, fingerprint or checks key
// starts afresh; a check started and never ended is interrupted), never a lease while the last one isn't freed, validity
// before the lease and before each check, the lease always given back, and each outcome: green (only counted passes),
// red, transient, uncounted, stopped, invalid, waiting.
import { describe, expect, it } from 'vitest'
import { checksKeyOf, journalFor, runCandidateChecks, type CandidateChecksDeps, type CandidateChecksInput, type ChecksJournal } from '../src/main/workflow/jjCandidateChecks'
import type { JjCandidateFingerprint } from '../src/main/platform/jjCandidateStep'

const C = (c: string): string => c.repeat(40)
const fp: JjCandidateFingerprint = { cycle: 1, submission: 3, revision: C('a'), base: C('b'), key: null, commit: C('a'), target: 'main', ruleset: 'r1', style: 'merge', strict: false, generation: 0, approval: 7 }
const input = (o: Partial<CandidateChecksInput> = {}): CandidateChecksInput => ({ card: { key: 'AM-1', number: 1 }, fp, attempt: 'att0001', result: C('c'), expected: C('d'), checksKey: 'k1', names: ['typecheck', 'lint'], commands: { typecheck: 'tsc', lint: 'oxlint' }, installAlways: false, ...o })

/** The parts, recording what was done; `results` per check name: ok, transient, counted. */
function parts(o: { results?: Record<string, { ok: boolean; transient?: boolean; counted?: boolean }>; valid?: () => boolean; freed?: boolean; lease?: 'wait' | 'refused'; stopped?: string[]; journal?: ChecksJournal | null } = {}) {
  let journal: ChecksJournal | null = o.journal ?? null
  const log: string[] = []
  const writes: ChecksJournal[] = []
  let n = 0
  const deps: CandidateChecksDeps = {
    journal: { read: () => (journal ? structuredClone(journal) : null), write: async (j) => void writes.push(structuredClone((journal = structuredClone(j)))) },
    leaseFreed: async (id) => (log.push(`freed? ${id}`), o.freed ?? true),
    lease: async () => {
      if (o.lease === 'wait') return { wait: 'noCopy' }
      if (o.lease === 'refused') return { refused: 'setup failed' }
      const id = `L${++n}`
      log.push(`lease ${id}`)
      return { id, folder: 'C:\\copy', spawn: (() => null) as never, give: async (why, end) => void log.push(`give ${id} ${why}${end ? ' end' : ''}`) }
    },
    runCheck: async (name) => {
      log.push(`run ${name}`)
      const r = o.results?.[name] ?? { ok: true }
      return { ok: r.ok, ...(r.transient ? { transient: true } : {}), output: `${name} out`, command: name, run: `run-${name}` }
    },
    install: async () => (log.push('install'), { ok: true, output: '' }),
    bracket: async (_f, revision) => ({ end: async () => ({ counted: (o.results?.[log.findLast((l) => l.startsWith('run '))!.slice(4)]?.counted ?? true), tested: revision }) }),
    valid: async () => o.valid?.() ?? true,
    checkRan: async (c) => void log.push(`ran ${c.name} ${c.ok ? 'ok' : 'fail'}${c.counted ? '' : ' uncounted'}`),
    stopped: (run) => !!o.stopped?.includes(run)
  }
  return { deps, log, writes, journal: () => journal }
}

describe("a jj candidate's merge checks (HI-2938)", () => {
  it('green: each check run in order, journalled before it starts and after it ends, the lease given back', async () => {
    const p = parts()
    expect(await runCandidateChecks(p.deps, input())).toEqual({ green: true, checks: ['typecheck', 'lint'] })
    expect(p.log).toEqual(['lease L1', 'run typecheck', 'ran typecheck ok', 'run lint', 'ran lint ok', 'give L1 checksEnded'])
    // The started phase is durable before the run: a write with typecheck started and not ended.
    expect(p.writes.some((j) => j.checks.some((c) => c.name === 'typecheck' && c.phase === 'started'))).toBe(true)
    expect(p.journal()!.checks.map((c) => [c.name, c.phase, c.ok, c.counted, c.revision])).toEqual([
      ['typecheck', 'ended', true, true, C('c')],
      ['lint', 'ended', true, true, C('c')]
    ])
  })

  it('red: the card returns (its check and output); transient: retried; exit 0 uncounted is never green', async () => {
    expect(await runCandidateChecks(parts({ results: { lint: { ok: false } } }).deps, input())).toEqual({ red: { check: 'lint', output: 'lint out' } })
    expect(await runCandidateChecks(parts({ results: { typecheck: { ok: false, transient: true } } }).deps, input())).toMatchObject({ transient: { check: 'typecheck' } })
    const u = parts({ results: { typecheck: { ok: true, counted: false } } })
    expect(await runCandidateChecks(u.deps, input())).toMatchObject({ transient: { check: 'typecheck', why: expect.stringMatching(/^uncounted/) } })
    expect(u.log).not.toContain('run lint')
  })

  it('stopped from the Progress panel: stopped, not red', async () => {
    const p = parts({ results: { typecheck: { ok: false } }, stopped: ['run-typecheck'] })
    expect(await runCandidateChecks(p.deps, input())).toEqual({ stopped: { check: 'typecheck' } })
    expect(p.journal()!.checks[0]).toMatchObject({ phase: 'ended', transient: true })
  })

  it('invalid before the lease, or before a check (its lease given back with its job ended)', async () => {
    expect(await runCandidateChecks(parts({ valid: () => false }).deps, input())).toEqual({ invalid: true })
    let calls = 0
    const p = parts({ valid: () => ++calls < 3 })
    expect(await runCandidateChecks(p.deps, input())).toEqual({ invalid: true })
    expect(p.log).toEqual(['lease L1', 'run typecheck', 'ran typecheck ok', 'give L1 invalid end'])
  })

  it('no copy free: waits, nothing run; a refused lease is transient', async () => {
    const w = parts({ lease: 'wait' })
    expect(await runCandidateChecks(w.deps, input())).toEqual({ wait: 'noCopy' })
    expect(w.log).toEqual([])
    expect(await runCandidateChecks(parts({ lease: 'refused' }).deps, input())).toMatchObject({ transient: { check: 'copy' } })
  })

  it('a restart: a check started and never ended is interrupted and run again; one ended counted-green stands', async () => {
    const was: ChecksJournal = { fp, attempt: 'att0001', result: C('c'), expected: C('d'), checksKey: 'k1', lease: 'L0', checks: [{ name: 'typecheck', command: 'tsc', phase: 'ended', ok: true, counted: true, revision: C('c') }, { name: 'lint', command: 'oxlint', phase: 'started' }] }
    expect(journalFor(was, input()).checks[1]).toMatchObject({ phase: 'ended', ok: false, interrupted: true, transient: true })
    const p = parts({ journal: was })
    expect(await runCandidateChecks(p.deps, input())).toEqual({ green: true, checks: ['typecheck', 'lint'] })
    expect(p.log).toEqual(['freed? L0', 'lease L1', 'run lint', 'ran lint ok', 'give L1 checksEnded'])
  })

  it("never a new lease while the last run's lease isn't freed (its tree may still write)", async () => {
    const was: ChecksJournal = { fp, attempt: 'att0001', result: C('c'), expected: C('d'), checksKey: 'k1', lease: 'L0', checks: [{ name: 'typecheck', command: 'tsc', phase: 'started' }] }
    const p = parts({ journal: was, freed: false })
    expect(await runCandidateChecks(p.deps, input())).toEqual({ wait: 'previous' })
    expect(p.log).toEqual(['freed? L0'])
  })

  it('another checks key, attempt or approval starts afresh: no green carried over', async () => {
    const green: ChecksJournal = { fp, attempt: 'att0001', result: C('c'), expected: C('d'), checksKey: 'k1', checks: [{ name: 'typecheck', command: 'tsc', phase: 'ended', ok: true, counted: true, revision: C('c') }, { name: 'lint', command: 'oxlint', phase: 'ended', ok: true, counted: true, revision: C('c') }] }
    expect(await runCandidateChecks(parts({ journal: green }).deps, input())).toEqual({ green: true, checks: ['typecheck', 'lint'] })
    for (const other of [input({ checksKey: 'k2' }), input({ attempt: 'att0002' }), input({ fp: { ...fp, approval: 9 } }), input({ fp: { ...fp, generation: 1 } })]) {
      const p = parts({ journal: green })
      await runCandidateChecks(p.deps, other)
      expect(p.log.filter((l) => l.startsWith('run '))).toEqual(['run typecheck', 'run lint'])
    }
  })

  it('the workspace closing mid-check: its job ended and the lease given back at once; nothing more runs', async () => {
    const life = new AbortController()
    const p = parts()
    const run = p.deps.runCheck
    p.deps.runCheck = async (...a) => {
      if (a[0] === 'typecheck') life.abort()
      return run(...a)
    }
    expect(await runCandidateChecks({ ...p.deps, signal: life.signal }, input())).toEqual({ closed: true })
    // The close (in the stub, as the check starts) ends the lease's job at once, the check's tree with it.
    expect(p.log).toEqual(['lease L1', 'give L1 closed end', 'run typecheck'])
    // Closed before it began: nothing at all.
    const q = parts()
    expect(await runCandidateChecks({ ...q.deps, signal: life.signal }, input())).toEqual({ closed: true })
    expect(q.log).toEqual([])
  })

  it("Stop on the install's run: stopped, never red or retried (HR1's round 1 finding 2)", async () => {
    const p = parts({ stopped: ['run-install'] })
    p.deps.install = async () => ({ ok: false, output: 'stopped', command: 'npm ci', run: 'run-install' })
    expect(await runCandidateChecks(p.deps, input({ installAlways: true }))).toEqual({ stopped: { check: 'install' } })
    expect(p.log).toEqual(['lease L1', 'give L1 checksEnded'])
  })

  it('invalid while a command runs: its job ended at once, never waiting for the command (finding 4)', async () => {
    let valid = true
    let release!: () => void
    const running = new Promise<void>((r) => (release = r))
    const p = parts({ valid: () => valid })
    let started!: () => void
    const inCommand = new Promise<void>((r) => (started = r))
    // The command runs until its job is ended (the lease given back with `end`), as a real tree in a job would.
    p.deps.runCheck = async (name) => {
      p.log.push(`run ${name}`)
      started()
      await running
      return { ok: false, transient: true, output: 'killed', command: name, run: `run-${name}` }
    }
    const lease = p.deps.lease
    p.deps.lease = async (rev) => {
      const l = await lease(rev)
      if (!('id' in l)) return l
      return {
        ...l,
        give: async (why, end) => {
          if (end) release()
          await l.give(why, end)
        }
      }
    }
    const out = runCandidateChecks({ ...p.deps, watchMs: 10 }, input())
    await inCommand
    valid = false
    expect(await out).toEqual({ invalid: true })
    expect(p.log).toEqual(['lease L1', 'run typecheck', 'give L1 invalid end'])
  })

  it('invalid or closed while the copy is leased: the install never starts, the lease given back (HI-2964)', async () => {
    let valid = true
    const p = parts({ valid: () => valid })
    const lease = p.deps.lease
    p.deps.lease = async (rev) => {
      const l = await lease(rev)
      valid = false
      return l
    }
    expect(await runCandidateChecks(p.deps, input({ installAlways: true }))).toEqual({ invalid: true })
    expect(p.log).toEqual(['lease L1', 'give L1 invalid end'])
    // The workspace closing during the lease: closed, nothing run, the copy given back.
    const life = new AbortController()
    const q = parts()
    const qLease = q.deps.lease
    q.deps.lease = async (rev) => {
      const l = await qLease(rev)
      life.abort()
      return l
    }
    expect(await runCandidateChecks({ ...q.deps, signal: life.signal }, input({ installAlways: true }))).toEqual({ closed: true })
    expect(q.log).toEqual(['lease L1', 'give L1 checksEnded'])
    // The workspace closing during the validity read before the install, or before a check, which still says valid
    // (HR1's round 1): nothing starts, the lease given back once.
    // The second read: the one after the lease (before the install, or before the first check).
    for (const installAlways of [true, false]) {
      const life2 = new AbortController()
      const r = parts()
      let reads = 0
      r.deps.valid = async () => {
        if (++reads === 2) life2.abort()
        return true
      }
      expect(await runCandidateChecks({ ...r.deps, signal: life2.signal }, input({ installAlways }))).toEqual({ closed: true })
      expect(r.log).toEqual(['lease L1', 'give L1 closed end'])
    }
    // Closed during the check's started journal write, or during its bracket (HR2's round 2): the check never runs, its
    // bracket (if taken) is ended, the lease given back once.
    for (const at of ['journal', 'bracket'] as const) {
      const life3 = new AbortController()
      const s = parts()
      const write = s.deps.journal.write
      s.deps.journal.write = async (j) => {
        if (at === 'journal' && j.checks.some((c) => c.phase === 'started')) life3.abort()
        await write(j)
      }
      s.deps.bracket = async (_f, revision) => {
        s.log.push('bracket')
        if (at === 'bracket') life3.abort()
        return { end: async () => (s.log.push('bracket end'), { counted: true, tested: revision }) }
      }
      expect(await runCandidateChecks({ ...s.deps, signal: life3.signal }, input())).toEqual({ closed: true })
      expect(s.log).toEqual(at === 'journal' ? ['lease L1', 'give L1 closed end'] : ['lease L1', 'bracket', 'give L1 closed end', 'bracket end'])
    }
    // Closed during a hook, or while the install runs: nothing after it starts.
    for (const at of ['leased', 'beforeCheck:typecheck', 'install'] as const) {
      const life4 = new AbortController()
      const h = parts()
      h.deps.hook = (point) => void (point === at && life4.abort())
      const install = h.deps.install
      h.deps.install = async (...a) => {
        if (at === 'install') life4.abort()
        return install(...a)
      }
      expect(await runCandidateChecks({ ...h.deps, signal: life4.signal }, input({ installAlways: true }))).toEqual({ closed: true })
      expect(h.log).toEqual(at === 'install' ? ['lease L1', 'give L1 closed end', 'install'] : at === 'leased' ? ['lease L1', 'give L1 closed end'] : ['lease L1', 'install', 'give L1 closed end'])
    }
  })

  it("saving the lease's id fails: the copy given back, the error thrown on, nothing run (HI-2963)", async () => {
    const p = parts()
    const write = p.deps.journal.write
    p.deps.journal.write = async (j) => {
      if (j.lease) throw new Error('journal write failed')
      await write(j)
    }
    await expect(runCandidateChecks(p.deps, input({ installAlways: true }))).rejects.toThrow('journal write failed')
    expect(p.log).toEqual(['lease L1', 'give L1 checksEnded'])
  })

  it('the checks key follows the checks, their order and commands, the install and the setup command', () => {
    const o = { mergeChecks: ['a', 'b'], commands: { a: 'x', b: 'y' }, mergeInstall: 'onManifestChange' as const }
    const k = checksKeyOf(o, 'npm ci')
    expect(checksKeyOf({ ...o }, 'npm ci')).toBe(k)
    for (const other of [checksKeyOf({ ...o, mergeChecks: ['b', 'a'] }, 'npm ci'), checksKeyOf({ ...o, commands: { a: 'x2', b: 'y' } }, 'npm ci'), checksKeyOf({ ...o, mergeInstall: 'always' }, 'npm ci'), checksKeyOf(o, 'npm install')]) expect(other).not.toBe(k)
  })
})
