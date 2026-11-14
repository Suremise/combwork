// HI-3235 (HI-2840/s30, s34; HI-3235/s10–s16): jj's target advance, its pure parts as tables: the parsers, the base
// refusals, the classifier (`advanced` only on the full lineage; a detected difference stops; anything unproved is
// uncertain), the undo's conditions and its lineage, the plan's identity, the durable journal and the lock token. The
// real-jj cases are tests/jjAdvanceReal.test.ts; the recovery and answers through the adapter, tests/jjAdvanceRuntime.test.ts.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { AdvanceJournals, baseRefusal, classifyAdvance, classifyUndo, journalRequested, onlyTarget, parseBookmarks, parseOps, parseWorktrees, pendingExports, planIdOf, undoOffered, undoTxn, underLock, writeDurable, type AdvanceJournal, type BookmarkRow, type GitSnapshot, type HeadObservation, type JjAdvanceDeps, type JjAdvancePlan, type JjObservation, type OpView, type UndoEntry } from '../src/main/platform/jjAdvance'
import { tempDir } from './tempDir'

const E = 'e'.repeat(40)
const R = 'f'.repeat(40)
const X = 'a'.repeat(40)
const P0 = '0'.repeat(128)
const O = '1'.repeat(128)
const XO = '2'.repeat(128)
const EXP = '3'.repeat(128)
const H = '4'.repeat(128)
const U = '5'.repeat(128)
const UEXP = '6'.repeat(128)
const ATTEMPT = 'att-1'
const plan: JjAdvancePlan = { card: 'AM-1', cycle: 7, submission: 9, fingerprint: 'fp', store: 'S', target: 'main', expected: E, result: R, change: 'k'.repeat(32), style: 'merge', checks: 'key', checked: R }
const row = (name: string, remote: string, target: string, conflict = false): BookmarkRow => ({ name, remote, conflict, target: conflict ? '' : target, added: conflict ? [target, X] : [target], removed: conflict ? [E] : [] })
const view = (local: string, tracked: string, extra: BookmarkRow[] = []): OpView => ({ bookmarks: [row('main', '', local), row('main', 'git', tracked), ...extra], tags: [], visibleHeads: [R, X] })
const git = (ref: string, worktrees: GitSnapshot['worktrees'] = [], more: Record<string, string> = {}): GitSnapshot => ({ refs: { 'refs/heads/main': ref, ...more }, worktrees })
const op = (id: string, parents: string[], args = 'args: jj bookmark list'): { id: string; parents: string[]; args: string } => ({ id, parents, args })
const ours = (id: string, parent: string, txn = ATTEMPT): ReturnType<typeof op> => op(id, [parent], `args: jj --ignore-working-copy '--config=combwork.txn="${txn}"' x`)
const head = (o: string, ancestry: ReturnType<typeof op>[], v: OpView, complete = true): HeadObservation => ({ op: o, ancestry, complete, view: v })
const obs = (heads: HeadObservation[], g: GitSnapshot, stable = { heads: true, git: true }): JjObservation => ({ heads, headsStable: stable.heads, git: g, gitStable: stable.git })
const journal = (phase: AdvanceJournal['phase'], o?: string, undos: UndoEntry[] = []): AdvanceJournal => ({ v: 1, attempt: ATTEMPT, planId: planIdOf(plan), plan, phase, base: { op: P0, git: git(E) }, ...(o ? { op: o } : {}), undos })
/** The head after a clean advance: our export op over O over P0, T at R in jj, jj's record of Git and Git. */
const advancedHead = (extra: ReturnType<typeof op>[] = []): HeadObservation => head(EXP, [...extra, ours(EXP, O), ours(O, P0), op(P0, [])], view(R, R))
const P0VIEW = view(E, E)

describe("the advance's parsers (the probe's)", () => {
  it('reads bookmark rows, operations and worktrees; a malformed row is unreadable, never guessed', () => {
    expect(parseBookmarks(`main\u001f\u001ffalse\u001f${E}\u001f${E}\u001f\n`)).toEqual([{ name: 'main', remote: '', conflict: false, target: E, added: [E], removed: [] }])
    expect(() => parseBookmarks('main\u001fgit\n')).toThrow()
    expect(parseOps(`${O}\u001f${P0}\u001fargs: jj x\n`)).toEqual([{ id: O, parents: [P0], args: 'args: jj x' }])
    expect(() => parseOps('not-hex\u001f\u001f\n')).toThrow()
    expect(parseWorktrees(`worktree C:/a\nHEAD ${E}\ndetached\n\nworktree C:/b\nHEAD ${R}\nbranch refs/heads/main\n`)).toEqual([
      { path: 'C:/a', head: E, branch: null },
      { path: 'C:/b', head: R, branch: 'refs/heads/main' }
    ])
    expect(() => parseWorktrees('worktree C:/a\n')).toThrow()
  })
})

describe('the base refusals (s30 §1: nothing written)', () => {
  const cases: [string, number, OpView, GitSnapshot, string | null][] = [
    ['T = T@git = ref = E, nothing pending', 1, view(E, E), git(E), null],
    ['more than one operation head', 2, view(E, E), git(E), 'divergentStart'],
    ['T conflicted', 1, { ...view(E, E), bookmarks: [row('main', '', R, true), row('main', 'git', E)] }, git(E), 'conflicted'],
    ['T ≠ E in jj', 1, view(X, X), git(X), 'moved'],
    ['T not yet exported', 1, view(E, X), git(X), 'partialExport'],
    ['Git moved, not imported', 1, view(E, E), git(X), 'movedInGit'],
    ['T checked out in a worktree', 1, view(E, E), git(E, [{ path: 'C:/wt', head: E, branch: 'refs/heads/main' }]), 'targetCheckedOut'],
    ["someone's bookmark not exported", 1, view(E, E, [row('other', '', X)]), git(E), 'pendingExports'],
    ["a jj tag Git doesn't have", 1, { ...view(E, E), tags: [{ name: 'v1', target: X }] }, git(E), 'pendingExports'],
    ['no such bookmark', 1, { bookmarks: [], tags: [], visibleHeads: [] }, git(E), 'noTarget']
  ]
  for (const [what, n, v, g, code] of cases) {
    it(what, () => {
      const out = baseRefusal(plan, n, v, g)
      expect(out === null ? null : out.kind === 'nothingMoved' ? out.code : `not refused: ${out.kind}`).toBe(code)
    })
  }

  it('lists every pending ref: a local bookmark unexported, a deletion unexported, a tag', () => {
    const v: OpView = { bookmarks: [row('main', '', E), row('main', 'git', E), row('a', '', X), row('gone', 'git', X)], tags: [{ name: 't', target: X }], visibleHeads: [] }
    expect(pendingExports(v, git(E), 'main')).toEqual(['refs/heads/a', 'refs/heads/gone', 'refs/tags/t'])
  })

  it('the view delta: exactly T from E to R, anything else named', () => {
    expect(onlyTarget('main', view(E, E), view(R, E), E, R)).toBeNull()
    expect(onlyTarget('main', view(E, E), view(X, E), E, R)).toBe('opView')
    expect(onlyTarget('main', view(E, E), view(R, E, [row('other', '', X)]), E, R)).toBe('otherBookmarks')
    expect(onlyTarget('main', view(E, E), { ...view(R, E), tags: [{ name: 't', target: X }] }, E, R)).toBe('tags')
    expect(onlyTarget('main', view(E, E), { ...view(R, E), visibleHeads: [R] }, E, R)).toBe('visibleHeads')
  })
})

describe("the classifier: advanced only on the full lineage (s34 §2), a difference stops, the rest is uncertain", () => {
  it('advanced: one head, every operation after P0 ours (O then the export), T at R in jj, its Git record and Git, the rest as at base', () => {
    expect(classifyAdvance(journal('exported', O), obs([advancedHead()], git(R)), P0VIEW)).toEqual({ kind: 'advanced', op: O, exportOp: EXP })
  })

  it("T = R alone is never success: a foreign operation in the lineage stops it (an op between P0 and O, or after it)", () => {
    expect(classifyAdvance(journal('exported', O), obs([advancedHead([op(XO, [EXP])])], git(R)), P0VIEW)).toMatchObject({ kind: 'stopped', code: 'concurrent' })
    // O's parent isn't P0 (another operation came first): stopped.
    const h = head(EXP, [ours(EXP, O), ours(O, XO), op(XO, [P0]), op(P0, [])], view(R, R))
    expect(classifyAdvance(journal('exported', O), obs([h], git(R)), P0VIEW)).toMatchObject({ kind: 'stopped', code: 'concurrent' })
  })

  const stopped: [string, JjObservation, string][] = [
    ['a second head', obs([advancedHead(), head(XO, [op(XO, [P0]), op(P0, [])], view(E, E))], git(R)), 'divergent'],
    ['T conflicted', obs([head(EXP, [ours(EXP, O), ours(O, P0), op(P0, [])], { ...view(R, R), bookmarks: [row('main', '', R, true), row('main', 'git', R)] })], git(R)), 'conflicted'],
    ['T moved on from R', obs([head(EXP, [ours(EXP, O), ours(O, P0), op(P0, [])], view(X, X))], git(X)), 'moved'],
    ['a failed export (Git still at E)', obs([head(O, [ours(O, P0), op(P0, [])], view(R, E))], git(E)), 'partialExport'],
    ["Git's T ≠ R after the export", obs([advancedHead()], git(X)), 'partialExport'],
    ['another ref changed (d2: detected, never prevented)', obs([advancedHead()], git(R, [], { 'refs/heads/other': X })), 'foreignRefs'],
    ['a worktree HEAD changed (d1 where visible)', obs([advancedHead()], git(R, [{ path: 'C:/main', head: E, branch: null }])), 'checkoutDetached'],
    ['the view changed beyond T', obs([head(EXP, [ours(EXP, O), ours(O, P0), op(P0, [])], { ...view(R, R), visibleHeads: [R] })], git(R)), 'extraDelta']
  ]
  for (const [what, o, code] of stopped) {
    it(`stopped: ${what}`, () => {
      const j = code === 'checkoutDetached' ? { ...journal('exported', O), base: { op: P0, git: git(E, [{ path: 'C:/main', head: E, branch: 'refs/heads/dev' }]) } } : journal('exported', O)
      expect(classifyAdvance(j, o, P0VIEW)).toMatchObject({ kind: 'stopped', code })
    })
  }

  it('a worktree added during the attempt: stopped (what it had checked out before the read is unknown)', () => {
    expect(classifyAdvance(journal('exported', O), obs([advancedHead()], git(R, [{ path: 'C:/wt', head: R, branch: null }])), P0VIEW)).toMatchObject({ kind: 'stopped', code: 'worktreesChanged' })
  })

  const unsure: [string, JjObservation, string][] = [
    ['unreadable', { unreadable: 'jj died' }, 'unreadable'],
    ['torn heads', obs([advancedHead()], git(R), { heads: false, git: true }), 'torn'],
    ['torn Git', obs([advancedHead()], git(R), { heads: true, git: false }), 'torn'],
    ['an ancestry cut short', obs([head(EXP, [ours(EXP, O)], view(R, R), false)], git(R)), 'ancestry'],
    ['P0 not in the history', obs([head(EXP, [ours(EXP, O), op(XO, [])], view(R, R))], git(R)), 'baseNotInHistory']
  ]
  for (const [what, o, code] of unsure) it(`uncertain: ${what}`, () => expect(classifyAdvance(journal('exported', O), o, P0VIEW)).toMatchObject({ kind: 'uncertain', code }))

  it('nothing of ours in history: nothing moved before an integrate was tried, uncertain once one was', () => {
    const none = obs([head(P0, [op(P0, [])], view(E, E))], git(E))
    expect(classifyAdvance(journal('preparing'), none, P0VIEW)).toEqual({ kind: 'nothingMoved', code: 'notInHistory' })
    expect(classifyAdvance(journal('prepared', O), none, P0VIEW)).toEqual({ kind: 'nothingMoved', code: 'notInHistory' })
    expect(classifyAdvance(journal('integrating', O), none, P0VIEW)).toMatchObject({ kind: 'uncertain', code: 'integrateUncertain' })
    expect(classifyAdvance(journal('based'), none, P0VIEW)).toMatchObject({ kind: 'nothingMoved', code: 'noMutation' })
  })

  it("an undo's operations never count as the advance's (their marker isn't the attempt's)", () => {
    const h = head(EXP, [ours(EXP, O, undoTxn(ATTEMPT, 'u1')), ours(O, P0), op(P0, [])], view(R, R))
    expect(classifyAdvance(journal('exported', O), obs([h], git(R)), P0VIEW)).toMatchObject({ kind: 'stopped', code: 'concurrent' })
  })
})

describe("the undo's conditions (s30 §2) and its lineage (s10 §A)", () => {
  it('offered only when every condition holds now: our ops alone, one head, T = R in jj and Git, the rest as at base, T checked out nowhere', () => {
    expect(undoOffered(journal('exported', O), obs([advancedHead()], git(R)), P0VIEW)).toBe(true)
    expect(undoOffered(journal('prepared', O), obs([advancedHead()], git(R)), P0VIEW)).toBe(false)
    expect(undoOffered(journal('exported', O), obs([advancedHead([op(XO, [EXP])])], git(R)), P0VIEW)).toBe(false)
    expect(undoOffered(journal('exported', O), obs([advancedHead()], git(R, [], { 'refs/heads/other': X })), P0VIEW)).toBe(false)
    expect(undoOffered(journal('exported', O), obs([advancedHead()], git(R, [{ path: 'C:/wt', head: R, branch: 'refs/heads/main' }])), P0VIEW)).toBe(false)
    expect(undoOffered(journal('exported', O), obs([head(O, [ours(O, P0), op(P0, [])], view(R, E))], git(E)), P0VIEW)).toBe(false)
  })

  const undoJournal = (phase: UndoEntry['phase']): { j: AdvanceJournal; u: UndoEntry } => {
    const u: UndoEntry = { undo: 'u1', request: 'AM-1/r9', phase, head: H, ...(phase === 'reverting' || phase === 'undoBased' ? {} : { op: U }) }
    return { j: journal('exported', O, [u]), u }
  }
  const txn = undoTxn(ATTEMPT, 'u1')
  const undoneHead = (extra: ReturnType<typeof op>[] = []): HeadObservation => head(UEXP, [...extra, ours(UEXP, U, txn), ours(U, H, txn), op(H, [])], view(E, E))
  const H_VIEW = view(R, R)

  it('verified: its revert U over H, every op after H its own, T back at E in jj and Git, the rest as at the advance base', () => {
    const { j, u } = undoJournal('revertExported')
    expect(classifyUndo(j, u, obs([undoneHead()], git(E)), H_VIEW)).toEqual({ kind: 'advanced', op: U, exportOp: UEXP })
  })

  it('pre-mutation phases are nothing moved; nothing of the undo in history after its integrate is uncertain, never replayed', () => {
    const none = obs([head(H, [op(H, [])], view(R, R))], git(R))
    for (const p of ['undoRequested', 'undoBased'] as const) expect(classifyUndo(undoJournal(p).j, undoJournal(p).u, none, H_VIEW)).toMatchObject({ kind: 'nothingMoved' })
    expect(classifyUndo(undoJournal('reverting').j, undoJournal('reverting').u, none, H_VIEW)).toMatchObject({ kind: 'nothingMoved', code: 'undoNotInHistory' })
    expect(classifyUndo(undoJournal('revertIntegrating').j, undoJournal('revertIntegrating').u, none, H_VIEW)).toMatchObject({ kind: 'uncertain', code: 'undoIntegrateUncertain' })
  })

  it('a foreign op, a ref changed or T elsewhere after the undo: uncertain (only the user settles it)', () => {
    const { j, u } = undoJournal('revertExported')
    expect(classifyUndo(j, u, obs([undoneHead([op(XO, [UEXP])])], git(E)), H_VIEW)).toMatchObject({ kind: 'uncertain', code: 'concurrent' })
    expect(classifyUndo(j, u, obs([undoneHead()], git(E, [], { 'refs/heads/other': X })), H_VIEW)).toMatchObject({ kind: 'uncertain', code: 'gitDiffers' })
    expect(classifyUndo(j, u, obs([undoneHead()], git(R)), H_VIEW)).toMatchObject({ kind: 'uncertain', code: 'partialExport' })
  })
})

describe("the plan's identity and the journal", () => {
  it('the plan id is its fields, canonical: the same plan the same id whatever its key order, any changed field another', () => {
    const shuffled = Object.fromEntries(Object.entries(plan).reverse()) as unknown as JjAdvancePlan
    expect(planIdOf(shuffled)).toBe(planIdOf(plan))
    for (const k of Object.keys(plan) as (keyof JjAdvancePlan)[]) expect(planIdOf({ ...plan, [k]: k === 'cycle' || k === 'submission' ? 1 : 'other' })).not.toBe(planIdOf(plan))
  })

  it('journals are written whole and found by card and cycle; a damaged one is unreadable, never half read', async () => {
    const dir = tempDir('adv-journal-')
    const js = new AdvanceJournals(dir)
    const deps = { journals: js } as unknown as JjAdvanceDeps
    const j = await underLock('S', (fn) => fn(), (h) => journalRequested(h, deps, ATTEMPT, plan))
    expect(await js.read('AM-1', 7, ATTEMPT)).toEqual(j)
    expect((await js.list('AM-1', 7)).map((x) => x.attempt)).toEqual([ATTEMPT])
    expect(await js.list('AM-1', 8)).toEqual([])
    expect(await js.read('AM-1', 7, 'other')).toBeNull()
    const file = join(dir, `AM-1.7.${ATTEMPT}.json`)
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, 20))
    expect(await js.read('AM-1', 7, ATTEMPT)).toBe('unreadable')
    // A journal whose plan doesn't hash to its id (edited) is unreadable too.
    writeFileSync(file, JSON.stringify({ ...j, plan: { ...plan, result: X } }))
    expect(await js.read('AM-1', 7, ATTEMPT)).toBe('unreadable')
  })

  it('writeDurable replaces a file whole', async () => {
    const f = join(tempDir('adv-durable-'), 'x.json')
    await writeDurable(f, 'one')
    await writeDurable(f, 'two')
    expect(readFileSync(f, 'utf8')).toBe('two')
  })

  it("an entry outside its store's lock is a programming error: the token comes only from underLock, for that store", async () => {
    const deps = { journals: new AdvanceJournals(tempDir('adv-held-')) } as unknown as JjAdvanceDeps
    await expect(journalRequested({ store: 'S' }, deps, ATTEMPT, plan)).rejects.toThrow(/outside its store lock/)
    await expect(underLock('OTHER', (fn) => fn(), (h) => journalRequested(h, deps, ATTEMPT, plan))).rejects.toThrow(/outside its store lock/)
  })
})
