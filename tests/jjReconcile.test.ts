// jj cards reconciled to Integrated when the user integrates (HI-2882's J9b2, design HI-2882/s7–s22), on the real jj in
// both Git-backed modes, behind the guard (compile.ts' seam, jjCardsWorld.ts):
// - Approved, then the user's own integration (a fast-forward of the bookmark, or the card's change replayed onto the
//   target): `Integrated` by outside with J5's provenance, its obligation and retained bundle rows, Done; before it,
//   nothing; a proof that can't be made (unknown) writes nothing; two observers write one fact and one row;
// - the approval replaced while the proof was made: nothing recorded;
// - a slot amend after approval: Stale (another change);
// - the publish pass (afterRun): the user's push settles the obligation `published`; the remote rewound flags it
//   `checkThis`; a retained pin deleted is recreated by the retention page;
// - the window's containment record (HI-2869): for exactly the approval, ordered by its generation, gone with Integrated.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { boardFile } from '../src/main/boardStore'
import { JjPlatform } from '../src/main/platform/jjPlatform'
import type { JjIntegrationPoint } from '../src/main/platform/jjIntegration'
import { jjIntegratedOf } from '../src/main/platform/jjFacts'
import { waitingOf } from '../src/main/jjWindow'
import { containedKey } from '../src/main/workflow/reconcile'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'
import { B1, R1, moved } from './workflow/harness'
import { closers, started, world, type World } from './jjCardsWorld'

if (!jjExe) console.warn(`jjReconcile.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

/** A card started, its work committed in its slot, submitted, pinned, reviewed and passed: Approved. */
async function approved(w: World, title = 'jj work'): Promise<{ card: ReturnType<World['wf']['createCard']>; P: string }> {
  const a = w.slots['slot-a']
  const card = await started(w, title)
  const P = w.commitIn(a.folder, `${title.replace(/\W/g, '')}.txt`, a.identity.workspace)
  moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
  await w.runPins(card.id)
  moved(await w.wf.startReview(card.key, R1))
  moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(w.wf.state(card).stage).toBe('approved')
  return { card, P }
}

/** The project's rows of a table, read on a connection of their own. */
function rows(w: World, table: 'jj_obligations' | 'jj_retained'): Record<string, unknown>[] {
  const db = new DatabaseSync(boardFile(w.home), { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE project = 'p-jj'`).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

/** This file's cards are all B1's: one slot (HI-3018). */
const ONE = { oneSlot: true } as const

const integrated = (w: World, card: number) => w.store.facts(card).filter((f) => f.kind === 'Integrated')

describe.skipIf(!jjExe)(`jj cards reconciled to Integrated (jj ${TESTED_JJ.version}), HI-2882`, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    // Each starts from a card Approved in a world of its own, made in beforeEach (HI-3018): the setup is most of a
    // test's jj and git runs, so on a loaded machine it has its own time bound, and the test only its own steps.
    describe('a card Approved', () => {
      let s: { w: World; card: Awaited<ReturnType<typeof approved>>['card']; P: string } | null = null
      /** The world's integration hook, set by a test that needs one. */
      let hook: ((point: JjIntegrationPoint) => Promise<void> | void) | null = null
      beforeEach(async () => {
        s = null
        hook = null
        const w = await world(colocated, { ...ONE, hook: (point) => hook?.(point) })
        s = { w, ...(await approved(w)) }
      })

      it("the user's fast-forward integration: Integrated by outside with J5's provenance, its rows, Done; nothing before it", async () => {
        const { w, card, P } = s!
        const jjp = new JjPlatform(w.wf)
        await jjp.reconcile(card, {})
        expect(integrated(w, card.id)).toEqual([])
        expect(w.wf.state(card).stage).toBe('approved')
        // The user integrates (decision A: their own bookmark move).
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        await jjp.reconcile(w.wf.store.card(card.id), {})
        const [f] = integrated(w, card.id)
        expect(f.data).toMatchObject({ revision: P, target: 'main', by: 'outside', result: P })
        const prov = jjIntegratedOf((f.data as { platform?: unknown }).platform)
        expect(prov).toMatchObject({ head: P, via: 'ancestry' })
        expect(w.wf.state(card).stage).toBe('done')
        expect(rows(w, 'jj_obligations')).toMatchObject([{ card: card.key, bundle: prov!.bundle, state: 'owed', result: P, target: 'main' }])
        expect(rows(w, 'jj_retained')).toMatchObject([{ card: card.key, bundle: prov!.bundle }])
      })

      it("the card's change replayed onto the target by the user: proved by replay", async () => {
        const { w, card, P } = s!
        // The user's own commit on main first, then the card's change duplicated onto it, and the bookmark moved there.
        w.h.jj(w.repo, 'new', 'main', '-m', 'theirs')
        writeFileSync(join(w.repo, 'theirs.txt'), 'theirs\n')
        w.h.jj(w.repo, 'commit', '-m', 'theirs')
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
        w.h.jj(w.repo, '--ignore-working-copy', 'duplicate', P, '-d', 'main')
        const dup = w.h.id(w.repo, `description(exact:"jjwork.txt\n") & ~${P}`)
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', dup)
        await new JjPlatform(w.wf).reconcile(card, {})
        const [f] = integrated(w, card.id)
        expect(jjIntegratedOf((f.data as { platform?: unknown }).platform)).toMatchObject({ via: 'replay', head: dup })
        expect(w.wf.state(card).stage).toBe('done')
      })

      it('a proof that cannot be made writes nothing; two observers write one fact and one row', async () => {
        const { w, card, P } = s!
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        const integration = w.deps.integration
        w.deps.integration = async () => null
        const unknowns: string[] = []
        await new JjPlatform(w.wf).reconcile(card, { unknown: (u) => void unknowns.push(u) })
        expect(unknowns).toHaveLength(1)
        expect(integrated(w, card.id)).toEqual([])
        w.deps.integration = integration
        const other = w.another()
        await Promise.all([new JjPlatform(w.wf).reconcile(card, {}), new JjPlatform(other).reconcile(other.store.card(card.id), {})])
        expect(integrated(w, card.id)).toHaveLength(1)
        expect(rows(w, 'jj_obligations')).toHaveLength(1)
        // The winner's bundle is still journalled after the loser's proof (HR1's round 1), and its deleted pin is repaired.
        const bundle = jjIntegratedOf((integrated(w, card.id)[0].data as { platform?: unknown }).platform)!.bundle
        expect(w.deps.records!.bundles(card.key, w.wf.state(card).cycle).map((b) => b.bundle)).toContain(bundle)
        const pin = execFileSync('git', ['--git-dir', w.ctx.store, 'for-each-ref', '--format=%(refname)', `refs/cw/jj-integrated/`], { env: w.h.env, encoding: 'utf8' }).split(/\r?\n/).find((r) => r.includes(`/${bundle}/`))!
        execFileSync('git', ['--git-dir', w.ctx.store, 'update-ref', '-d', pin], { env: w.h.env })
        const jjp = new JjPlatform(w.wf)
        await jjp.invalidated('retained:*')
        await jjp.afterRun()
        expect(w.refAt(pin)).not.toBeNull()
      })

      it("sameness that can't be read after a not-contained proof writes nothing (never Stale)", async () => {
        const { w, card } = s!
        const a = w.slots['slot-a']
        writeFileSync(join(a.folder, 'jjwork.txt'), 'changed\n')
        w.h.jj(a.folder, 'squash')
        // The proof reads the target (not contained); then the sameness check can't read it.
        const integration = w.deps.integration
        let calls = 0
        w.deps.integration = async () => (++calls > 1 ? null : integration())
        const unknowns: string[] = []
        await new JjPlatform(w.wf).reconcile(card, { unknown: (u) => void unknowns.push(u) })
        expect(unknowns.some((u) => u.startsWith('sameness'))).toBe(true)
        expect(w.store.facts(card.id).some((f) => f.kind === 'Stale')).toBe(false)
        expect(w.wf.state(card).stage).toBe('approved')
      })

      it('Integrated recorded while the rules were off is applied (Done) once they are on, with no second record', async () => {
        const { w, card, P } = s!
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        w.wf.cfg.reconcileActs = false
        await new JjPlatform(w.wf).reconcile(card, {})
        expect(integrated(w, card.id)).toHaveLength(1)
        expect(w.wf.state(card).stage).toBe('approved')
        w.wf.cfg.reconcileActs = true
        await new JjPlatform(w.wf).reconcile(w.wf.store.card(card.id), {})
        expect(w.wf.state(card).stage).toBe('done')
        expect(integrated(w, card.id)).toHaveLength(1)
        expect(rows(w, 'jj_obligations')).toHaveLength(1)
        expect(rows(w, 'jj_retained')).toHaveLength(1)
      })

      it('the approval replaced while the proof was made: nothing recorded', async () => {
        let once: (() => Promise<void>) | null = null
        hook = async (point) => { if (point === 'afterProof' && once) { const f = once; once = null; await f() } }
        const { w, card, P } = s!
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        // While J5 proves the approval: a new submission recorded (the same revision, nothing in jj changed, so J5's own
        // fences hold), so the approval proved is replaced: only the Integrated write's check of the snapshot stops it.
        once = async () => {
          const sub = w.store.facts(card.id).findLast((f) => f.kind === 'Submitted')!
          w.store.tx((tx) => tx.append(card.id, { kind: 'Submitted', actor: 'combwork', source: 'recorded', data: { ...(sub.data as object), summary: 'again' } } as never))
        }
        await new JjPlatform(w.wf).reconcile(card, {})
        expect(once).toBeNull()
        expect(integrated(w, card.id)).toEqual([])
        expect(rows(w, 'jj_obligations')).toEqual([])
      })

      it("the window's containment record (HI-2869): for exactly the approval, ordered by generation (never a clock), gone with Integrated", async () => {
        const { w, card, P } = s!
        const waiting = () => waitingOf(w.wf, 'p-jj').find((c) => c.card === card.id)!
        expect(waiting().contained).toBeNull()
        await new JjPlatform(w.wf).reconcile(card, {})
        expect(waiting()).toMatchObject({ revision: P, target: 'main', contained: { state: 'notYet' } })
        expect(waiting().change).toMatch(/^[k-z]+$/)
        // An older observation finishing after a newer one writes nothing: A reserves its generation and blocks in its proof,
        // B (generation after A's) can't read the target (unknown) and records that; A's late "not yet" is dropped.
        const integration = w.deps.integration
        let release!: () => void
        let entered!: () => void
        const inA = new Promise<void>((r) => (entered = r))
        let gate: Promise<void> | null = new Promise<void>((r) => (release = r))
        w.deps.integration = async () => {
          if (gate) {
            const g = gate
            gate = null
            entered()
            await g
          }
          return integration()
        }
        const a = new JjPlatform(w.wf).reconcile(card, {})
        await inA
        const wrapper = w.deps.integration
        w.deps.integration = async () => null
        const other = w.another()
        await new JjPlatform(other).reconcile(other.store.card(card.id), {})
        expect(waiting().contained).toMatchObject({ state: 'unknown' })
        w.deps.integration = wrapper
        release()
        await a
        expect(waiting().contained).toMatchObject({ state: 'unknown' })
        // A newer observation replaces it whatever the clock says (equal, then earlier): the generation orders them.
        const at = waiting().contained!.at
        const clock = vi.spyOn(Date, 'now').mockReturnValue(at)
        try {
          await new JjPlatform(w.wf).reconcile(w.wf.store.card(card.id), {})
          expect(waiting().contained).toMatchObject({ state: 'notYet', at })
          w.deps.integration = async () => null
          clock.mockReturnValue(at - 60_000)
          await new JjPlatform(w.wf).reconcile(w.wf.store.card(card.id), {})
          expect(waiting().contained).toMatchObject({ state: 'unknown', at: at - 60_000 })
        } finally {
          clock.mockRestore()
          w.deps.integration = integration
        }
        // Integrated: the record goes with the card.
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        await new JjPlatform(w.wf).reconcile(w.wf.store.card(card.id), {})
        expect(w.wf.state(card).stage).toBe('done')
        expect(w.store.boardMeta(containedKey('p-jj', card.key, w.wf.state(card).cycle))).toBeNull()
      })

      it("the containment record isn't shown for another approval of the card (HI-2869: a full identity match)", async () => {
        const { w, card } = s!
        await new JjPlatform(w.wf).reconcile(card, {})
        expect(waitingOf(w.wf, 'p-jj')[0].contained).toMatchObject({ state: 'notYet' })
        // The approval replaced by a later submission of the same revision (recorded only): the record names the old one.
        const sub = w.store.facts(card.id).findLast((f) => f.kind === 'Submitted')!
        w.store.tx((tx) => tx.append(card.id, { kind: 'Submitted', actor: 'combwork', source: 'recorded', data: { ...(sub.data as object), summary: 'again' } } as never))
        const now = waitingOf(w.wf, 'p-jj').find((c) => c.card === card.id)
        expect(now?.contained ?? null).toBeNull()
      })

      it('a slot amend after approval (another change): Stale', async () => {
        const { w, card } = s!
        const a = w.slots['slot-a']
        writeFileSync(join(a.folder, 'jjwork.txt'), 'changed\n')
        w.h.jj(a.folder, 'squash')
        await new JjPlatform(w.wf).reconcile(card, {})
        expect(w.store.facts(card.id).some((f) => f.kind === 'Stale')).toBe(true)
      })
    })

    // HI-3018: the publish pass's steps, each a test of its own over one world made in beforeAll (its closers run in
    // afterAll), so no step carries the world's setup and each fits its time bound on a loaded machine.
    describe('the publish pass (afterRun)', () => {
      let s: { w: World; remote: string; card: Awaited<ReturnType<typeof approved>>['card']; P: string; jjp: JjPlatform } | null = null
      const own: (() => void)[] = []
      beforeAll(async () => {
        const w = await world(colocated, ONE)
        own.push(...closers.splice(0))
        const remote = join(tempDir('jjremote-'), 'remote.git')
        execFileSync('git', ['init', '--bare', '-q', remote], { env: w.h.env })
        w.h.jj(w.repo, 'git', 'remote', 'add', 'origin', remote)
        const { card, P } = await approved(w)
        w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', P)
        const jjp = new JjPlatform(w.wf)
        await jjp.reconcile(card, {})
        s = { w, remote, card, P, jjp }
      })
      afterAll(() => {
        for (const c of own.splice(0)) c()
      })

      it("the user's push settles the obligation published", async () => {
        const { w, remote, P, jjp } = s!
        expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'owed' }])
        // The user pushes main (their act, test-side), then the pass observes it.
        execFileSync('git', ['--git-dir', w.ctx.store, 'push', '-q', remote, `${P}:refs/heads/main`], { env: w.h.env })
        await jjp.afterRun()
        expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'published', pushed: P }])
      })

      it("the remote rewound: the next pass's re-check flags it checkThis", async () => {
        const { w, remote, jjp } = s!
        expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'published' }])
        execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', w.h.id(w.repo, 'main-')], { env: w.h.env })
        execFileSync('git', ['--git-dir', w.ctx.store, 'fetch', '-q', remote, '+refs/heads/main:refs/remotes/origin/main'], { env: w.h.env })
        await jjp.afterRun()
        expect(rows(w, 'jj_obligations')).toMatchObject([{ state: 'checkThis' }])
      })

      it('a retained pin deleted is marked due, then the page recreates it', async () => {
        const { w, jjp } = s!
        const pins = execFileSync('git', ['--git-dir', w.ctx.store, 'for-each-ref', '--format=%(refname)', 'refs/cw/jj-integrated/'], { env: w.h.env, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
        expect(pins.length).toBeGreaterThan(0)
        execFileSync('git', ['--git-dir', w.ctx.store, 'update-ref', '-d', pins[0]], { env: w.h.env })
        expect(await jjp.invalidated('retained:*')).toBe(true)
        expect(await jjp.afterRun()).toEqual({ more: false })
        expect(w.refAt(pins[0])).not.toBeNull()
        expect(rows(w, 'jj_retained')).toMatchObject([{ outcome: 'held' }])
      })
    })
  })
})

void closers
