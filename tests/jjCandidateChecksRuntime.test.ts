// HI-2938: the project's merge checks on a jj card's candidate (design HI-2938/s11, HR1's OK), wired into J9b2's
// reconciliation and JjPlatform's checks runner, on the real jj (jjCardsWorld.ts), each check copy a real jj workspace
// at the candidate's commit, each check a real command run by the merge queue's runner, bracketed by jj's check bracket:
// - green: offered only once every check passed and counted; the user's bookmark set onto it, Integrated via candidate;
// - red: the card back to its builder (IntegrationFailed reason checks, the check named); never offered;
// - Stop: stopped, not offered; Run Checks Again: green, offered;
// - validity at the boundaries (s11 §2): a re-approval with identical endpoints, a decision, changed check options, each
//   during a check and at the publication write; the target moved during a check: nothing published, no green reused;
// - a restart (s11 §3): the previous run's lease still holding a live process in its job (a crash's state): no new lease
//   or run while it can still write; once its job is ended, the interrupted check runs again in a fresh copy.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { JjPlatform, type JjChecksHost } from '../src/main/platform/jjPlatform'
import { jjIntegratedOf } from '../src/main/platform/jjFacts'
import { waitingOf } from '../src/main/jjWindow'
import { candidateKey, type JjCandidateShown } from '../src/main/workflow/reconcile'
import { queueChecks } from '../src/main/workflow/queueChecks'
import { jobSpawn } from '../src/main/workflow/jobSpawn'
import { journalPath, LeaseJob, leaseJobGone, queueHost } from '../src/main/workflow/queueJobs'
import { checksJournalKey, writeChecksJournal, type ChecksJournal } from '../src/main/workflow/jjCandidateChecks'
import { candidateLeaseHeld, checkLeaseOver, holdCandidateLease, releaseCandidateLease } from '../src/main/workflow/candidateLeases'
import { attemptsKey, readAttempts, type JjAttemptEntry } from '../src/main/platform/jjCandidateStep'
import { CopyPool, CopyStore } from '../src/main/copies'
import type { OpHolder } from '../src/main/slots'
import type { SqlDb } from '../src/main/platform/jjObligations'
import { TESTED_JJ } from '../src/shared/jjTool'
import type { WorkflowOptions } from '../src/shared/workflow/options'
import { APPLY_OPTIONS } from '../src/shared/workflow/workView'
import { jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, R1, moved } from './workflow/harness'
import { opts, started, world, type World } from './jjCardsWorld'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }

if (!jjExe) console.warn(`jjCandidateChecksRuntime.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A hung test's bound, as jjCandidatesReal's (HI-2921): many real jj and git commands, and real check runs. */
const REAL_JJ_MS = 120_000
const NODE = `"${process.execPath}"`
const PASS = `${NODE} -e "process.exit(0)"`
const FAIL = `${NODE} -e "console.log('lint: 1 problem');process.exit(1)"`

const ends: (() => void)[] = []
const closersHere: (() => void)[] = []
afterAll(() => {
  for (const e of [...closersHere.splice(0), ...ends.splice(0)]) e()
})

/** The checks configured on the project (its options, as a card starting now takes them). */
const withChecks = (w: World, checks: Record<string, string>, more: Partial<WorkflowOptions> = {}) => void (w.wf.cfg.options = () => ({ ...opts, mergeChecks: Object.keys(checks), commands: { ...opts.commands, ...checks }, ...more }))

/** The options changed and applied to the card in flight (optionsForm.ts' Apply to cards in flight). */
function reapply(w: World, card: { id: number }, checks: Record<string, string>): void {
  withChecks(w, checks)
  const r = w.wf.currentRuleset()
  w.store.tx((tx) => tx.append(card.id, { kind: 'Override', actor: 'user', source: 'recorded', ruleset: r.id, data: { rules: ['option.mergeChecks'], move: APPLY_OPTIONS, by: 'user', reason: '' } } as never))
}

/**
 * The app's checks host (jjCards.ts), on the real copies pool (copies.ts, the jj port): each lease a check copy reset to
 * the candidate's commit; the pool's `leaseOver` the production predicate (checkLeaseOver, with the runs' open state), each
 * run's start the lease's ref as in the app (candidateRun), the lease held while the attempt runs (holdCandidateLease);
 * `job`: every process in a real lease job. The project's setup command and its stamp are the test's (`setSetup`).
 */
function host(w: World, o: { job?: { host: ReturnType<typeof queueHost> }; freed?: (id: string) => Promise<boolean> } = {}) {
  const root = tempDir('jjchecks-')
  const leases: { id: string; folder: string; given?: string }[] = []
  const stop = new Set<string>()
  const runs: string[] = []
  const open = new Map<string, boolean>()
  let current: string | null = null
  const holder: OpHolder = { self: async () => ({ pid: 1, started: 1001 }), alive: async () => true, live: new Set() }
  const store = new CopyStore(w.conn, 'p-jj')
  const warm = async (): Promise<{ ok: boolean; exitCode: number; logPath: null; settled: boolean }> => ({ ok: true, exitCode: 0, logPath: null, settled: true })
  const pool = new CopyPool({ store, workspaces: w.port, project: w.repo, dir: join(root, 'copies'), options: async () => ({ setup: '', archive: '', copy: '' }), size: () => 2, runner: warm, settle: async () => true, holder, profile: 'profile-1', runIn: () => null, holderBusy: () => null, leaseOver: (l) => checkLeaseOver(l, (ref) => open.get(ref), 60_000), reviewOn: () => true, quietWaitMs: () => 60_000 })
  closersHere.push(() => void pool.close().catch(() => undefined))
  let setup = { setup: '', stamp: 's0' }
  const runner = (spawnIt: Parameters<typeof queueChecks>[0]['spawn']) =>
    queueChecks({
      ...(spawnIt ? { spawn: spawnIt } : {}),
      env: () => baseEnv() as Record<string, string>,
      logDir: join(root, 'logs'),
      timeoutMs: () => 60_000,
      setupCommand: () => setup.setup,
      runs: {
        start: (r) => {
          runs.push(r.title)
          const id = `run${runs.length}`
          open.set(id, true)
          // As the app's candidateRun: each run the lease's ref.
          if (current) void pool.setRef(current, id)
          return id
        },
        finish: (id) => void open.set(id, false),
        counts: () => undefined
      }
    })
  const h: JjChecksHost = {
    setup: async () => ({ ...setup }),
    setupStamp: () => setup.stamp,
    lease: async (card, revision) => {
      const r = await pool.leaseCopy({ kind: 'check', card, revision, agent: null })
      if (!r.ok) return r.refusal.why === 'noCopy' ? { wait: 'noCopy' } : { refused: r.refusal.why }
      const id = r.lease.id
      holdCandidateLease(id)
      current = id
      leases.push({ id, folder: r.copy.folder })
      let spawnIt: ReturnType<typeof jobSpawn> | undefined
      if (o.job) {
        const job = await LeaseJob.open(o.job.host, id, await journalPath(root, id, join(root, '.journals')))
        if (!(job instanceof LeaseJob)) return { refused: 'no job' }
        spawnIt = jobSpawn(job)
        jobs.set(id, job)
      }
      return {
        id,
        folder: r.copy.folder,
        spawn: (spawnIt ?? spawn) as never,
        give: async (why, end) => {
          if (end) await jobs.get(id)?.end()
          releaseCandidateLease(id)
          if (current === id) current = null
          leases.find((l) => l.id === id)!.given = why
          await pool.returnCopy(id, why)
        }
      }
    },
    leaseFreed:
      o.freed ??
      (async (id) => {
        await pool.refresh()
        const l = pool.lease(id)
        return !l || !!l.freed
      }),
    runCheck: (name, command, folder, ctx, spawnIt) => runner(spawnIt).runCheck(name, command, folder, ctx),
    install: (folder, ctx, spawnIt) => runner(spawnIt).install(folder, true, ctx),
    stopped: (run) => stop.delete(run),
    againMs: () => 3_600_000,
    watchMs: 100,
    parkCopies: async (at, to) => {
      await pool.refresh()
      return pool.parkFree(at, to)
    }
  }
  const jobs = new Map<string, LeaseJob>()
  w.deps.candidateChecks = h
  const setSetup = (v: string): void => void (setup = { setup: v, stamp: `s${Date.now()}-${Math.random()}` })
  return { h, leases, stop, runs, root, pool, setSetup, open }
}

/** A card started, its work committed in its slot, submitted, pinned, reviewed and passed: Approved. */
async function approved(w: World, title = 'jj work') {
  const a = w.slots['slot-a']
  const card = await started(w, title)
  const st = w.wf.state(card).started!
  w.store.tx((tx) => tx.append(card.id, { kind: 'SlotPrepared', actor: 'combwork', source: 'recorded', data: { lease: st.lease!, line: st.line!, revision: st.base! } } as never))
  writeFileSync(join(a.folder, 'work.txt'), 'work\n')
  w.h.jj(a.folder, 'commit', '-m', title)
  const P = w.h.id(a.folder, `${a.identity.workspace}@-`)
  moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
  await w.runPins(card.id)
  moved(await w.wf.startReview(card.key, R1))
  moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(w.wf.state(card).stage).toBe('approved')
  return { card, P }
}

const shown = (w: World, card: { key: string }, cycle: number): JjCandidateShown | null => {
  const raw = w.store.boardMeta(candidateKey('p-jj', card.key, cycle))
  return raw ? (JSON.parse(raw) as JjCandidateShown) : null
}
const waiting = (w: World, card: number) => waitingOf(w.wf, 'p-jj', new Map([['main', w.main()]]), '').find((c) => c.card === card)
/** A failing or waiting set's retry time come (HI-2991), as the runner's timer would find it: its record's `retryAt` set to now. */
async function due(w: World, card: { key: string }, cycle: number): Promise<void> {
  const k = candidateKey('p-jj', card.key, cycle)
  const rec = shown(w, card, cycle)!
  await w.conn.write((db) => void db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...rec, checks: { ...rec.checks!, retryAt: Date.now() } }), k))
}

/** Reconciled, then the checks runner's looks until it is idle. */
async function settle(w: World, card: { id: number }): Promise<JjPlatform> {
  const jjp = new JjPlatform(w.wf)
  await jjp.reconcile(w.wf.store.card(card.id), {})
  await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
  return jjp
}

describe.skipIf(!jjExe)(`merge checks on a jj card's candidate (jj ${TESTED_JJ.version}), HI-2938`, { timeout: REAL_JJ_MS }, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('green: offered only once its checks passed, in a copy at the candidate; the user integrates it: via candidate', async () => {
      const w = await world(colocated, { candidates: true })
      const x = host(w)
      withChecks(w, { typecheck: PASS, lint: PASS })
      const { card } = await approved(w)
      await settle(w, card)
      const cycle = w.wf.state(card).cycle
      const rec = shown(w, card, cycle)!
      expect(rec.checks).toMatchObject({ state: 'passed', names: ['typecheck', 'lint'] })
      expect(x.leases.map((l) => l.given)).toEqual(['checksEnded'])
      // Each a CheckRan of the candidate's commit, counted, under its attempt's entry.
      const ran = w.store.facts(card.id).filter((f) => f.kind === 'CheckRan' && (f.data as { entry?: string }).entry === `jj:${rec.offer!.attempt}`)
      expect(ran.map((f) => [(f.data as { name: string }).name, (f.data as { revision: string }).revision, (f.data as { counted: boolean }).counted])).toEqual([
        ['typecheck', rec.offer!.result, true],
        ['lint', rec.offer!.result, true]
      ])
      expect(waiting(w, card.id)?.candidate).toMatchObject({ state: 'ready', checks: { state: 'passed' } })
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', rec.offer!.result)
      await new JjPlatform(w.wf).reconcile(w.wf.store.card(card.id), {})
      const f = w.store.facts(card.id).find((x2) => x2.kind === 'Integrated')!
      expect(jjIntegratedOf((f.data as { platform?: unknown }).platform)).toMatchObject({ via: 'candidate' })
    })

    it('red: the card back to its builder, its check named; never offered', async () => {
      const w = await world(colocated, { candidates: true })
      host(w)
      withChecks(w, { typecheck: PASS, lint: FAIL })
      const { card } = await approved(w)
      await settle(w, card)
      const failed = w.store.facts(card.id).find((f) => f.kind === 'IntegrationFailed')
      expect(failed?.data).toMatchObject({ reason: 'checks', check: 'lint', target: 'main' })
      expect((failed!.data as { entry: string }).entry).toMatch(/^jj:/)
      expect(w.wf.state(card).stage).toBe('active')
      expect(shown(w, card, w.wf.state(card).cycle)).toBeNull()
    })

    it("HI-2990: the user's own fast-forward while a check runs in a copy at the candidate: Done; the candidate dropped by the sweep once the copy is freed, the copy off it", async () => {
      const w = await world(colocated, { candidates: true })
      const x = host(w)
      // The check holds until its gate exists, so the copy is surely still leased when Integrated is recorded.
      const gate = join(tempDir('jjff-'), 'go')
      withChecks(w, { lint: `${NODE} -e "const f=require('fs');setInterval(()=>{if(f.existsSync(${JSON.stringify(gate).replace(/"/g, "'")}))process.exit(0)},50)"` })
      const { card, P } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      const cycle = w.wf.state(card).cycle
      await vi.waitFor(() => expect(x.runs.length).toBe(1), { timeout: REAL_JJ_MS, interval: 50 })
      const c = shown(w, card, cycle)!.offer!
      w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      expect(w.wf.state(card).stage).toBe('done')
      // Its drop at Integrated skipped: the copy still leased at the candidate.
      const entry = () => (w.conn.read((db) => readAttempts(db as unknown as SqlDb, attemptsKey('p-jj', card.key, cycle))) as JjAttemptEntry[]).find((e) => e.record.attempt === c.attempt)!
      expect(entry().state).toBeUndefined()
      await jjp.afterRun()
      expect(entry().state).toBeUndefined()
      writeFileSync(gate, 'go')
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      // Once the pool has the copy back, a sweep (the platform's run) parks it and drops the candidate.
      await vi.waitFor(
        async () => {
          await x.pool.refresh()
          await jjp.afterRun()
          expect(entry().state).toBe('dropped')
        },
        { timeout: REAL_JJ_MS, interval: 200 }
      )
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${c.result} & ::visible_heads()`, '-T', 'commit_id').trim()).toBe('')
      expect(w.refAt(`refs/cw/jj/${card.key}/${c.attempt}/candidate`)).toBeNull()
      expect(x.pool.copies().filter((k) => k.revision === c.result)).toEqual([])
    })

    it("HI-2991: a check that keeps not counting runs again only at its retry time, doubling, its misses rising to the window's message", async () => {
      const w = await world(colocated, { candidates: true })
      const x = host(w)
      x.h.againMs = (n) => n * 3_600_000
      // Exits 0 but writes in the copy: never counted (uncounted:changed), a transient miss each time.
      withChecks(w, { lint: `${NODE} -e "require('fs').writeFileSync('junk.txt', String(Date.now()))"` })
      const { card } = await approved(w)
      const jjp = await settle(w, card)
      const cycle = w.wf.state(card).cycle
      const checks = () => shown(w, card, cycle)!.checks!
      expect(checks()).toMatchObject({ state: 'failing', misses: 1, why: 'lint: uncounted:changed' })
      expect(x.runs).toHaveLength(1)
      expect(checks().retryAt! - Date.now()).toBeGreaterThan(3_000_000)
      // Reconciliations and platform runs before the retry time: nothing runs again.
      await jjp.reconcile(w.wf.store.card(card.id), {})
      await jjp.afterRun()
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(x.runs).toHaveLength(1)
      for (const n of [2, 3]) {
        // Its retry time come (as the timer's look would find it): run again once, the miss counted on.
        await due(w, card, cycle)
        await jjp.afterRun()
        await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
        expect(x.runs).toHaveLength(n)
        expect(checks()).toMatchObject({ state: 'failing', misses: n })
        expect(checks().retryAt! - Date.now()).toBeGreaterThan((n - 0.2) * 3_600_000)
      }
      const shownNow = waiting(w, card.id)?.candidate
      expect(shownNow?.state === 'ready' && shownNow.checks).toMatchObject({ state: 'failing', misses: 3 })
    })

    it("HI-2991: another slot's jj commit while a check runs in its copy: the check still counts; passed, offered", async () => {
      const w = await world(colocated, { candidates: true })
      const x = host(w)
      const dir = tempDir('jjother-')
      const [marker, gate] = [join(dir, 'started'), join(dir, 'go')]
      const q = (p: string): string => JSON.stringify(p).replace(/"/g, "'")
      withChecks(w, { lint: `${NODE} -e "const f=require('fs');f.writeFileSync(${q(marker)},'1');setInterval(()=>{if(f.existsSync(${q(gate)}))process.exit(0)},50)"` })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(w.wf.store.card(card.id), {})
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: REAL_JJ_MS, interval: 50 })
      // Another agent, in another slot, commits its own work while the check runs.
      const b = w.slots['slot-b']
      writeFileSync(join(b.folder, 'other.txt'), 'other agent\n')
      w.h.jj(b.folder, 'commit', '-m', 'another card, another slot')
      writeFileSync(gate, 'go')
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'passed' })
      expect(x.runs).toHaveLength(1)
      const ran = w.store.facts(card.id).filter((f) => f.kind === 'CheckRan').map((f) => f.data as { counted: boolean; whyNot?: string })
      expect(ran).toEqual([expect.objectContaining({ counted: true })])
    })
  })

  describe('stop and validity (colocated)', () => {
    it('Stop: stopped, not offered; Run Checks Again: green, offered', async () => {
      const w = await world(true, { candidates: true })
      const x = host(w)
      withChecks(w, { typecheck: PASS })
      x.h.hook = async (p) => {
        // Stop pressed while it runs: the run started next is run1.
        if (p === 'beforeCheck:typecheck' && x.runs.length === 0) x.stop.add('run1')
      }
      const { card } = await approved(w)
      const jjp = await settle(w, card)
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'stopped' })
      expect(waiting(w, card.id)?.candidate).toMatchObject({ checks: { state: 'stopped' } })
      expect(await jjp.checksAgain(w.wf.store.card(card.id))).toBe(true)
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'passed' })
    })

    for (const [what, at] of [
      ['a re-approval with identical endpoints', 'beforeCheck:lint'],
      ['a re-approval with identical endpoints, at the publication write', 'afterCheck:lint'],
      ['a decision', 'beforeCheck:lint'],
      ['changed check options', 'beforeCheck:lint'],
      ['changed check options, at the publication write', 'afterCheck:lint'],
      ['the target moved', 'beforeCheck:lint']
    ] as const) {
      it(`${what} during the checks: nothing published, no green reused`, async () => {
        const w = await world(true, { candidates: true })
        const x = host(w)
        withChecks(w, { typecheck: PASS, lint: PASS })
        const { card } = await approved(w)
        let once = true
        x.h.hook = async (p) => {
          if (p !== at || !once) return
          once = false
          if (what.startsWith('a re-approval')) w.store.tx((tx) => tx.append(card.id, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'approved', to: 'approved', by: 'user' } } as never))
          else if (what === 'a decision') w.store.tx((tx) => tx.append(card.id, { kind: 'Decision', actor: 'user', source: 'recorded', data: { decision: 'd1', generation: 1, text: 'later' } } as never))
          else if (what.startsWith('changed')) reapply(w, card, { typecheck: PASS, lint: `${PASS} ` })
          else {
            w.h.jj(w.repo, 'new', 'main', '-m', 'theirs')
            writeFileSync(join(w.repo, 'theirs.txt'), 'theirs\n')
            w.h.jj(w.repo, 'commit', '-m', 'theirs')
            w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
          }
        }
        await settle(w, card)
        const cycle = w.wf.state(card).cycle
        const rec = shown(w, card, cycle)
        // Never passed for the old identity, options or head; nothing returned.
        expect(rec?.checks?.state ?? 'none').not.toBe('passed')
        expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
        expect(waiting(w, card.id)?.candidate?.state === 'ready' && waiting(w, card.id)?.candidate).not.toMatchObject({ checks: { state: 'passed' } })
      })
    }
  })

  describe("HR1's round 1 (colocated)", () => {
    it("HI-2950 (HR1's round 1): a real check copy still leased at the candidate when its cycle ends: unresolved, never marked done; dropped once the copy is freed and parked", async () => {
      const w = await world(true, { candidates: true })
      const x = host(w)
      withChecks(w, {})
      const { card } = await approved(w)
      const jjp = await settle(w, card)
      const cycle = w.wf.state(card).cycle
      const c = shown(w, card, cycle)!.offer!
      // A check copy leased at the candidate (its working copy on it), as a candidate's checks leave one until it is freed.
      const leased = await x.pool.leaseCopy({ kind: 'check', card: card.id, revision: c.result, agent: null })
      if (!leased.ok) throw new Error(JSON.stringify(leased))
      expect(await w.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'by hand' })).toMatchObject({ ok: true })
      await jjp.afterRun()
      const e1 = (w.conn.read((db) => readAttempts(db as unknown as SqlDb, attemptsKey('p-jj', card.key, cycle))) as JjAttemptEntry[]).find((e) => e.record.attempt === c.attempt)!
      expect(e1.state).toBeUndefined()
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${c.result} & ::visible_heads()`, '-T', 'commit_id').trim()).toBe(c.result)
      // The copy freed (its barrier), then the next sweep parks it and drops the candidate.
      await x.pool.returnCopy(leased.lease.id, 'done')
      await vi.waitFor(async () => {
        await x.pool.refresh()
        expect(x.pool.lease(leased.lease.id)?.freed).toBeTruthy()
      }, { timeout: REAL_JJ_MS, interval: 200 })
      await jjp.afterRun()
      const e2 = (w.conn.read((db) => readAttempts(db as unknown as SqlDb, attemptsKey('p-jj', card.key, cycle))) as JjAttemptEntry[]).find((e) => e.record.attempt === c.attempt)!
      expect(e2.state).toBe('dropped')
      expect(w.h.jj(w.repo, '--ignore-working-copy', 'log', '--no-graph', '-r', `${c.result} & ::visible_heads()`, '-T', 'commit_id').trim()).toBe('')
    })

    it('finding 1: the pool refreshed between the install and a check and between two checks: the lease stays the attempt’s', async () => {
      const w = await world(true, { candidates: true })
      const x = host(w)
      withChecks(w, { typecheck: PASS, lint: PASS }, { mergeInstall: 'always' })
      x.setSetup(PASS)
      const held: boolean[] = []
      x.h.hook = async (p) => {
        if (p !== 'afterInstall' && p !== 'afterCheck:typecheck') return
        // The run just ended (its ref's run closed): a refresh now must not return the lease.
        await x.pool.refresh()
        const l = x.pool.lease(x.leases[0].id)
        held.push(!!l && !l.returned)
      }
      const { card } = await approved(w)
      await settle(w, card)
      expect(held).toEqual([true, true])
      expect(shown(w, card, w.wf.state(card).cycle)?.checks).toMatchObject({ state: 'passed' })
      expect(x.leases.map((l) => l.given)).toEqual(['checksEnded'])
    })

    for (const at of ['beforeCheck:lint', 'afterCheck:lint'] as const) {
      it(`finding 3: the setup command changed (${at === 'beforeCheck:lint' ? 'during the final check' : 'at the publication write'}): not passed under the old key; then run anew under the new one`, async () => {
        const w = await world(true, { candidates: true })
        const x = host(w)
        withChecks(w, { typecheck: PASS, lint: PASS })
        let once = true
        x.h.hook = async (p) => {
          if (p === at && once) {
            once = false
            x.setSetup('npm ci --ignore-scripts')
          }
        }
        const { card } = await approved(w)
        const jjp = await settle(w, card)
        const cycle = w.wf.state(card).cycle
        const before = shown(w, card, cycle)!.checks!
        expect(before.state).not.toBe('passed')
        // The next look: the key now differs, so the checks start anew under it and pass.
        const runs = x.runs.length
        jjp.checksWanted()
        await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
        const after = shown(w, card, cycle)!.checks!
        expect(after).toMatchObject({ state: 'passed' })
        expect(after.key).not.toBe(before.key)
        expect(x.runs.length - runs).toBe(2)
      })
    }
  })

  describe.runIf(process.platform === 'win32')("HR1's round 1, in real jobs (colocated)", () => {
    /** A command that writes `marker` once it runs, then holds until `gate` exists. */
    const held = (marker: string, gate: string) => `${NODE} -e "const f=require('fs');f.writeFileSync(${JSON.stringify(marker).replace(/"/g, "'")},'1');setInterval(()=>{if(f.existsSync(${JSON.stringify(gate).replace(/"/g, "'")}))process.exit(0)},50)"`

    it('finding 2: Stop on a running install: stopped, not red or retried; Run Checks Again then passes', async () => {
      const w = await world(true, { candidates: true })
      const sup = queueHost()
      ends.push(() => void sup.close())
      const x = host(w, { job: { host: sup } })
      const dir = tempDir('jjinstall-')
      const marker = join(dir, 'install-started')
      const gate = join(dir, 'install-go')
      withChecks(w, { typecheck: PASS }, { mergeInstall: 'always' })
      x.setSetup(held(marker, gate))
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      // The install is running (its marker written): Stop, as the Progress panel's (its run, then its lease's job ended).
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: REAL_JJ_MS, interval: 50 })
      x.stop.add('run1')
      const lease = x.leases[0]
      await (await import('../src/main/workflow/queueJobs')).endLeaseJob(sup, lease.id)
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'stopped', why: 'install' })
      expect(w.store.facts(card.id).some((f) => f.kind === 'IntegrationFailed')).toBe(false)
      writeFileSync(gate, 'go')
      expect(await jjp.checksAgain(w.wf.store.card(card.id))).toBe(true)
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'passed' })
    })

    it("HI-2950: a held check when its card is moved to Done: its job ended, its checks journal kept while the lease is out, then the cycle cleaned up", async () => {
      const w = await world(true, { candidates: true })
      const sup = queueHost()
      ends.push(() => void sup.close())
      let freed = false
      const x = host(w, { job: { host: sup }, freed: async () => freed })
      const dir = tempDir('jjended-')
      const marker = join(dir, 'check-started')
      withChecks(w, { typecheck: held(marker, join(dir, 'never')) })
      const { card } = await approved(w)
      const jjp = new JjPlatform(w.wf)
      await jjp.reconcile(card, {})
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: REAL_JJ_MS, interval: 50 })
      const cycle = w.wf.state(card).cycle
      const rec = shown(w, card, cycle)!
      expect(await w.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'integrated by hand' })).toMatchObject({ ok: true })
      // The watcher ends the check's job (its candidate no longer valid) and gives the lease back.
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(x.leases[0].given).toBe('invalid')
      const checksKey = checksJournalKey('p-jj', card.key, cycle, rec.offer!.attempt)
      // The lease not freed yet: the candidate dropped, its checks journal kept (its lease ref the evidence).
      await jjp.afterRun()
      expect(w.store.boardMeta(checksKey)).not.toBeNull()
      expect(w.refAt(`refs/cw/jj/${card.key}/${rec.offer!.attempt}/candidate`)).toBeNull()
      // Freed: the next sweep removes the journal and the window's row.
      freed = true
      await jjp.afterRun()
      expect(w.store.boardMeta(checksKey)).toBeNull()
      expect(shown(w, card, cycle)).toBeNull()
    })

    for (const what of ['a re-approval', 'the target moved', 'changed check options'] as const) {
      it(`finding 4: ${what} while a check runs: its job ended at once, never waiting for the check to finish`, async () => {
        const w = await world(true, { candidates: true })
        const sup = queueHost()
        ends.push(() => void sup.close())
        const x = host(w, { job: { host: sup } })
        const dir = tempDir('jjrunning-')
        const marker = join(dir, 'check-started')
        // Its gate is never opened: the check finishes only if its job is ended.
        withChecks(w, { typecheck: held(marker, join(dir, 'never')) })
        const { card } = await approved(w)
        const jjp = new JjPlatform(w.wf)
        await jjp.reconcile(card, {})
        await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: REAL_JJ_MS, interval: 50 })
        if (what === 'a re-approval') w.store.tx((tx) => tx.append(card.id, { kind: 'Moved', actor: 'user', source: 'recorded', data: { from: 'approved', to: 'approved', by: 'user' } } as never))
        else if (what === 'changed check options') reapply(w, card, { typecheck: PASS })
        else {
          w.h.jj(w.repo, 'new', 'main', '-m', 'theirs')
          writeFileSync(join(w.repo, 'theirs.txt'), 'theirs\n')
          w.h.jj(w.repo, 'commit', '-m', 'theirs')
          w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
        }
        await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
        const cycle = w.wf.state(card).cycle
        expect(shown(w, card, cycle)?.checks?.state ?? 'none').not.toBe('passed')
        expect(x.leases[0].given).toBe('invalid')
      })
    }
  })

  describe.runIf(process.platform === 'win32')('a restart (colocated, the real process supervisor)', () => {
    it("the last run's lease still holding a live process: no new lease or run until its tree is ended; then the check runs again", async () => {
      const w = await world(true, { candidates: true })
      const sup = queueHost()
      ends.push(() => void sup.close())
      const x = host(w, { job: { host: sup }, freed: (id) => leaseJobGone(sup, id) })
      withChecks(w, { typecheck: PASS })
      // Built and offered for checks, its first look given no copy (it waits), so the crash's state can be set after.
      const lease = x.h.lease
      x.h.lease = async () => ({ wait: 'noCopy' })
      const { card } = await approved(w)
      const jjp = await settle(w, card)
      const cycle = w.wf.state(card).cycle
      const rec = shown(w, card, cycle)!
      // The crash's state: a previous Combwork's lease with a check started and never ended, its process still running in
      // the lease's job and writing in its copy.
      const old = `Lold-${Date.now()}`
      const job = (await LeaseJob.open(sup, old, await journalPath(x.root, old, join(x.root, '.journals')))) as LeaseJob
      const copy = join(x.root, 'copy-old')
      w.h.jj(w.repo, 'workspace', 'add', copy, '--name', 'copy-old', '-r', rec.offer!.result, '--colocate')
      const child: ChildProcess = jobSpawn(job)(process.execPath, ['-e', "setInterval(()=>require('fs').writeFileSync('beat.txt',String(Date.now())),50)"], { cwd: copy, env: baseEnv() })
      ends.push(() => void child.kill())
      const beat = join(copy, 'beat.txt')
      await vi.waitFor(() => expect(existsSync(beat)).toBe(true), { timeout: 30_000, interval: 50 })
      const j: ChecksJournal = { fp: rec.fp, attempt: rec.offer!.attempt, result: rec.offer!.result, expected: rec.offer!.expected, checksKey: rec.checks!.key, lease: old, checks: [{ name: 'typecheck', command: PASS, phase: 'started' }] }
      await w.deps.records!.write((db) => writeChecksJournal(db as unknown as SqlDb, checksJournalKey('p-jj', card.key, cycle, rec.offer!.attempt), j))
      x.h.lease = lease
      // A new Combwork's runner, once the waiting set's retry time has come (HI-2991): the old lease isn't freed (its job
      // still runs), so nothing is leased or run.
      await due(w, card, cycle)
      const other = w.another()
      const next = new JjPlatform(other)
      next.checksWanted()
      await vi.waitFor(() => expect(next.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      const leasedWhileAlive = x.leases.filter((l) => l.folder !== copy).length
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'waiting', why: 'previous' })
      expect(leasedWhileAlive).toBe(0)
      const t0 = statSync(beat).mtimeMs
      await vi.waitFor(() => expect(statSync(beat).mtimeMs).toBeGreaterThan(t0), { timeout: 30_000, interval: 50 })
      // Its tree ended (as the pool's barrier settles a returned lease's job): then the interrupted check runs again.
      expect(await job.end()).toBe(true)
      await job.close()
      await vi.waitFor(async () => expect(await leaseJobGone(sup, old)).toBe(true), { timeout: 30_000, interval: 100 })
      await due(w, card, cycle)
      next.checksWanted()
      await vi.waitFor(() => expect(next.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'passed' })
      expect(x.leases.length).toBe(1)
      // The old tree ended before the new run leased its copy (no overlap): its process is gone.
      await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 30_000, interval: 50 })
    })
  })

  describe('HI-2963 (colocated)', () => {
    it("saving the lease's id fails: the copy goes back to the real pool, no longer held; the next look passes", async () => {
      const w = await world(true, { candidates: true })
      const x = host(w)
      withChecks(w, { typecheck: PASS })
      // The board write right after the lease (its id journalled) fails once.
      const records = w.deps.records!
      const write = records.write
      let failNext = false
      records.write = async (fn) => {
        if (failNext) {
          failNext = false
          throw new Error('journal write failed')
        }
        return write(fn)
      }
      const lease = x.h.lease
      x.h.lease = async (card, revision) => {
        const l = await lease(card, revision)
        if ('id' in l && x.leases.length === 1) failNext = true
        return l
      }
      const { card } = await approved(w)
      const jjp = await settle(w, card)
      const cycle = w.wf.state(card).cycle
      expect(shown(w, card, cycle)?.checks?.state).not.toBe('passed')
      // The copy given back and released: the pool's, not this Combwork's hold.
      const first = x.leases[0]
      expect(first.given).toBe('checksEnded')
      expect(candidateLeaseHeld(first.id)).toBe(false)
      await x.pool.refresh()
      expect(x.pool.lease(first.id)?.returned ?? true).toBeTruthy()
      // The next look leases again and passes.
      jjp.checksWanted()
      await vi.waitFor(() => expect(jjp.checksBusy()).toBe(false), { timeout: REAL_JJ_MS, interval: 100 })
      expect(shown(w, card, cycle)?.checks).toMatchObject({ state: 'passed' })
      expect(x.leases.map((l) => l.given)).toEqual(['checksEnded', 'checksEnded'])
    })
  })
})
