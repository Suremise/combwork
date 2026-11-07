// HI-2660: start review's checksAtRevision, the card's checks recorded at the reviewed revision, for its reviewer to
// reuse instead of running them again. The latest counted run of each name at exactly that revision; never another
// revision's, an uncounted attempt, the merge queue's own run, or a configured check whose command has changed since.
// Only those checks: the list never says that everything the change needs ran.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { checksAtRevision } from '../../src/main/workflow/runtime'
import type { FactData } from '../../src/shared/workflow/facts'
import { intentText } from '../../src/shared/toolReplies'

type Ran = FactData['CheckRan']
const ran = (name: string, revision: string, result: Ran['result'], more: Partial<Ran> = {}): Ran => ({ name, command: `npm run ${name}`, revision, tested: revision, result, run: `${name}-${Math.random()}`, durationMs: 1, by: 'B1', counted: true, ...more })
const COMMANDS = { typecheck: 'npm run typecheck', lint: 'npm run lint' }

describe('checksAtRevision (HI-2660)', () => {
  it('the latest counted run of each name: a failure after a pass says failed, a pass after a failure says passed', () => {
    expect(checksAtRevision([ran('typecheck', 'r1', 'passed'), ran('lint', 'r1', 'failed'), ran('typecheck', 'r1', 'failed'), ran('lint', 'r1', 'passed')], 'r1', COMMANDS)).toEqual([
      { name: 'typecheck', result: 'failed' },
      { name: 'lint', result: 'passed' }
    ])
  })

  it("only the reviewed revision's; an uncounted run, the queue's own run and a changed command are left out", () => {
    const checks = [
      ran('typecheck', 'r0', 'passed'),
      ran('lint', 'r1', 'passed', { counted: false, whyNot: 'dirty' }),
      ran('focused tests', 'r1', 'passed', { entry: 'q1', by: 'combwork' }),
      ran('typecheck', 'r1', 'passed', { command: 'tsc --old' })
    ]
    expect(checksAtRevision(checks, 'r1', COMMANDS)).toEqual([])
    // An uncounted attempt after a counted pass doesn't hide the pass: it never counted.
    expect(checksAtRevision([ran('lint', 'r1', 'passed'), ran('lint', 'r1', 'failed', { counted: false, whyNot: 'changed' })], 'r1', COMMANDS)).toEqual([{ name: 'lint', result: 'passed' }])
  })

  it("a check with no configured command (a review's focused:<test> run) stands as recorded; names are data", () => {
    const name = 'focused:claude-real'
    expect(checksAtRevision([ran(name, 'r1', 'passed', { command: 'npm run e2e -- claude-real' })], 'r1', COMMANDS)).toEqual([{ name, result: 'passed' }])
    // In the reply's line: the name and its result; a name with a space or a separator quoted, never a command.
    const line = intentText({ ok: true, card: 'AM-1', from: 'review', to: 'review', data: { checksAtRevision: [{ name: 'typecheck', result: 'passed' }, { name: 'unit tests; rm -rf', result: 'failed' }] } } as never)
    expect(line).toContain('checksAtRevision: typecheck passed, "unit tests; rm -rf" failed')
  })
})

describe("start review's reply (HI-2660)", () => {
  let env: Env | null = null
  afterEach(() => {
    env?.close()
    env = null
  })

  it("names the selected submission's recorded checks, an earlier one too, and leaves the field out where none were", async () => {
    const e = (env = setup({ ...preset('git', 'pair'), mergeChecks: [], finish: 'agentMerges', preChecks: [], commands: COMMANDS }))
    const card = e.wf.createCard({ title: 'Fix it' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    const folder = s.data!.folder as string
    const first = commit(folder, { 'src/a.txt': 'a\n' }, `${card.key}: a`)
    const record = async (data: Ran) => {
      const c = e.store.card(card.id)
      await e.wf.write(c, e.wf.rulesetOf(c, e.wf.state(c)), B1, (w) => w.fact('CheckRan', data))
    }
    await record(ran('typecheck', first, 'passed'))
    await record(ran('lint', first, 'passed'))
    moved(await e.wf.submit(card.key, B1, { summary: 'one' }))
    const one = await e.wf.startReview(card.key, R1)
    moved(one)
    expect(one.data?.checksAtRevision).toEqual([
      { name: 'typecheck', result: 'passed' },
      { name: 'lint', result: 'passed' }
    ])
    moved(await e.wf.verdict(card.key, R1, { pass: false, failKind: 'content', comment: 'Round 1: FAILED. 1. b.' }))
    // A second submission with no checks recorded at its revision: no field.
    commit(folder, { 'src/b.txt': 'b\n' }, `${card.key}: b`)
    moved(await e.wf.submit(card.key, B1, { summary: 'two' }))
    const two = await e.wf.startReview(card.key, R1)
    moved(two)
    expect(two.data).not.toHaveProperty('checksAtRevision')
    // The earlier submission, selected: its own revision's checks.
    const subs = e.wf.state(card).submissions
    const again = await e.wf.startReview(card.key, R1, { submission: subs[0].id })
    moved(again)
    expect(again.data?.revision).toBe(first)
    expect(again.data?.checksAtRevision).toEqual([
      { name: 'typecheck', result: 'passed' },
      { name: 'lint', result: 'passed' }
    ])
  })
})
