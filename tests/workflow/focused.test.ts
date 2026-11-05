// Each card's focused tests (G20, HI-1367; SPEC §16.9.1, §16.13): chosen at submit by the project's picker in the card's
// folder at exactly the submitted revision (or named by its builder), and run by the merge queue at the merged result
// with the project's runner, on real temporary repositories. A selection never passes by default; the approved list
// holds only for paths whose change is exactly the submission's; real-CLI and packaged tests count from the review's
// run at the submitted revision (realProof = review); skipped tests wait for the reviewer's or the user's decision.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { B1, commit, GIT_HEAVY_MS, moved, R1, refusedBy, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { changedSince, chosenTests, choiceStands, parsePick, readResults, testsGiven, validTestId, type FocusedChoice, type FocusedNeed, type FocusedTest } from '../../src/shared/workflow/focused'
import { parseRaw, pathChanges } from '../../src/main/workflow/focusedRun'
import { queueChecks } from '../../src/main/workflow/queueChecks'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

/** A check's environment base as a session's would have it (the picker and runner get it as a check does). */
const base = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ComSpec: process.env.ComSpec ?? 'cmd.exe' })

/** A node script outside the repository, as a command line. */
function script(body: string): string {
  const f = join(tempDir('focused-script-'), 's.cjs')
  writeFileSync(f, body)
  return `"${process.execPath}" "${f}"`
}

/** A picker printing these JSON lines (or failing, or printing one line as given). */
const picker = (lines: unknown[] | 'fail' | string): string =>
  script(lines === 'fail' ? 'process.stderr.write("no git"); process.exit(2)' : typeof lines === 'string' ? `process.stdout.write(${JSON.stringify(lines)})` : `process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n'))})`)

/** A runner giving each test its result (passed unless named), writing what it was given to `seen`. */
function runner(results: Record<string, 'passed' | 'failed' | 'skipped' | 'none'> = {}, seen = join(tempDir('focused-seen-'), 'seen.json')): { command: string; seen: string } {
  const body = `const fs = require('fs')
const ids = JSON.parse(fs.readFileSync(process.env.HIVE_FOCUSED_TESTS, 'utf8'))
const want = ${JSON.stringify(results)}
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ ids, jobs: process.env.HIVE_FOCUSED_JOBS }))
const out = ids.filter((t) => want[t] !== 'none').map((t) => ({ test: t, result: want[t] || 'passed', ...(want[t] === 'skipped' ? { why: 'usage limit' } : {}) }))
fs.writeFileSync(process.env.HIVE_FOCUSED_RESULTS, JSON.stringify(out))
process.exit(out.some((r) => r.result === 'failed') || out.length !== ids.length ? 1 : 0)`
  return { command: script(body), seen }
}

/** Team with only G20 at the merge (no G9 checks: it runs alone), its picker and runner as given. */
function team(pick: string | null, run: string | null, over: Partial<ReturnType<typeof preset>> = {}): Env {
  const commands: Record<string, string> = {}
  if (pick) commands['focused.pick'] = pick
  if (run) commands['focused.run'] = run
  env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] }, focusedTests: true, commands, ...over }, { focused: { env: base, timeoutMs: () => 30_000 } })
  return env
}

/** A card started by B1 with `files` committed. */
async function built(e: Env, files: Record<string, string> = { 'src/c.txt': 'c\n' }) {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  const revision = commit(folder, files, `${card.key}: change`)
  return { card, folder, revision }
}

/** Submitted (with `tests`), passed by R1. */
async function approved(e: Env, card: { key: string }, tests?: Parameters<Env['wf']['submit']>[2]['tests']) {
  moved(await e.wf.submit(card.key, B1, { summary: 'x', ...(tests ? { tests } : {}) }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
}

const focusedOf = (e: Env, card: { id: number }): FocusedChoice | undefined => e.wf.state(e.store.card(card.id)).latest?.focused
const queue = (e: Env, run = queueChecks({ env: base, logDir: tempDir('focused-logs-'), timeoutMs: () => 60_000, setupCommand: () => '' })) => e.queue({ runCheck: run.runCheck, manifests: [], focused: { env: base, pickTimeoutMs: () => 30_000, jobs: () => 3, dir: tempDir('focused-files-') } })

describe('the shared parts (pure)', () => {
  it("reads a picker's output: tests with their needs, every test, or unknown; never pass by default", () => {
    expect(parsePick('')).toEqual({ state: 'chosen', tests: [] })
    expect(parsePick('{"test":"tests/a.test.ts","needs":["unit"]}\n{"test":"board","needs":["fake"]}\n')).toEqual({ state: 'chosen', tests: [{ id: 'tests/a.test.ts', needs: ['unit'] }, { id: 'board', needs: ['fake'] }] })
    expect(parsePick('{"every":true}\n')).toEqual({ state: 'tooBroad' })
    expect(parsePick('board\n')).toEqual({ state: 'unknown', why: 'badOutput' })
    expect(parsePick('{"test":"a"}\n{"test":"a"}')).toEqual({ state: 'unknown', why: 'badOutput' })
    expect(parsePick('{"test":"a","needs":["gpu"]}')).toEqual({ state: 'unknown', why: 'badOutput' })
    // Ids are the project's: spaces, Unicode and pytest's are fine; control characters never.
    for (const id of ['tests/a b.test.ts', 'tést', 'tests/t.py::test_x']) expect(validTestId(id), id).toBe(true)
    for (const id of ['', 'a\u0000b', 'a\nb', 'x'.repeat(501)]) expect(validTestId(id)).toBe(false)
    expect(testsGiven(['a', { id: 'b', needs: ['real'] }])).toEqual({ tests: [{ id: 'a', needs: [] }, { id: 'b', needs: ['real'] }] })
    expect(testsGiven(['a', 'a'])).toMatchObject({ bad: expect.stringContaining('twice') })
  })

  it('takes a results file only with exactly one known result per test given, and nothing else', () => {
    expect(readResults('[{"test":"a","result":"passed"},{"test":"b","result":"skipped","why":"sign-in"}]', ['a', 'b'])).toEqual({ failed: [], skipped: [{ test: 'b', result: 'skipped', why: 'sign-in' }] })
    expect(readResults('[{"test":"a","result":"passed"}]', ['a', 'b'])).toMatchObject({ bad: expect.stringContaining('no result for b') })
    expect(readResults('[{"test":"a","result":"passed"},{"test":"a","result":"passed"}]', ['a'])).toMatchObject({ bad: expect.stringContaining('two results') })
    expect(readResults('[{"test":"c","result":"passed"}]', ['c', 'd'].slice(1))).toMatchObject({ bad: expect.stringContaining("wasn't given") })
    expect(readResults('[{"test":"a","result":"ok"}]', ['a'])).toMatchObject({ bad: expect.any(String) })
    expect(readResults('not json', ['a'])).toMatchObject({ bad: expect.any(String) })
  })

  it("a choice stands when picked, or when the builder's list stands in for a pick that couldn't choose", () => {
    const c: FocusedChoice = { state: 'unknown', why: 'failed', source: 'picked', picked: [], added: [], change: [] }
    expect(choiceStands(c)).toBe(false)
    expect(choiceStands({ ...c, source: 'manual', added: [{ id: 'a', needs: [] }] })).toBe(true)
    expect(choiceStands({ ...c, state: 'chosen' })).toBe(true)
    expect(chosenTests({ ...c, state: 'chosen', picked: [{ id: 'a', needs: ['unit'] }], added: [{ id: 'a', needs: ['real'] }, { id: 'b', needs: [] }] })).toEqual([{ id: 'a', needs: ['unit', 'real'] }, { id: 'b', needs: [] }])
  })

  it("reads git's raw diff: renames with both endpoints, additions and deletions with no blob on their empty side", () => {
    const z = (...p: string[]): string => p.join('\0') + '\0'
    expect(parseRaw(z(':100644 100644 aaaa bbbb M', 'a.txt', ':000000 100644 0000 cccc A', 'n.txt', ':100644 000000 dddd 0000 D', 'd.txt', ':100644 100755 eeee eeee R100', 'old.sh', 'new.sh'))).toEqual([
      { status: 'M', oldPath: 'a.txt', newPath: 'a.txt', oldMode: '100644', newMode: '100644', oldBlob: 'aaaa', newBlob: 'bbbb' },
      { status: 'A', oldPath: null, newPath: 'n.txt', oldMode: null, newMode: '100644', oldBlob: null, newBlob: 'cccc' },
      { status: 'D', oldPath: 'd.txt', newPath: null, oldMode: '100644', newMode: null, oldBlob: 'dddd', newBlob: null },
      { status: 'R', oldPath: 'old.sh', newPath: 'new.sh', oldMode: '100644', newMode: '100755', oldBlob: 'eeee', newBlob: 'eeee' }
    ])
    expect(parseRaw('garbage\0')).toBeNull()
  })
})

describe("a change's identity, path by path (HR4's s22: exact, never a looser equivalence)", () => {
  /** A repository with `files` at its base commit; each case changes it on branches and compares. */
  function repo(files: Record<string, string>) {
    const dir = tempDir('focused-id-')
    sh(dir, 'init', '-q', '-b', 'main')
    sh(dir, 'config', 'user.name', 'T')
    sh(dir, 'config', 'user.email', 't@example.com')
    const first = commit(dir, files, 'base')
    const on = (name: string, change: Record<string, string>, extra?: (d: string) => void): string => {
      sh(dir, 'checkout', '-q', '-B', name, first)
      if (extra) extra(dir)
      return commit(dir, change, name)
    }
    return { dir, base: first, on }
  }

  it('the same change is the same; whitespace inside a literal is a change', async () => {
    const r = repo({ 'a.ts': "export const s = 'old'\n" })
    const one = r.on('one', { 'a.ts': 'export const s = "a b"\n' })
    const same = r.on('same', { 'a.ts': 'export const s = "a b"\n' })
    const other = r.on('other', { 'a.ts': 'export const s = "ab"\n' })
    const c1 = await pathChanges(r.dir, r.base, one)
    expect(changedSince(c1, await pathChanges(r.dir, r.base, same))).toEqual([])
    expect(changedSince(c1, await pathChanges(r.dir, r.base, other)).map((c) => c.newPath)).toEqual(['a.ts'])
  })

  it('a rename whose content changed, or whose mode changed, is a change', async () => {
    const r = repo({ 'old.sh': 'echo hi\n' })
    const renamed = r.on('renamed', {}, (d) => sh(d, 'mv', 'old.sh', 'new.sh'))
    const content = r.on('content', { 'new.sh': 'echo bye\n' }, (d) => sh(d, 'mv', 'old.sh', 'new.sh'))
    const mode = r.on('mode', {}, (d) => {
      sh(d, 'mv', 'old.sh', 'new.sh')
      sh(d, 'update-index', '--chmod=+x', 'new.sh')
    })
    const c = await pathChanges(r.dir, r.base, renamed)
    expect(c?.[0]).toMatchObject({ status: 'R', oldPath: 'old.sh', newPath: 'new.sh' })
    expect(changedSince(c, await pathChanges(r.dir, r.base, content)).length).toBeGreaterThan(0)
    expect(changedSince(c, await pathChanges(r.dir, r.base, mode))).toHaveLength(1)
  })

  it('the same hunk after the target changed that file elsewhere is a change (picked again, conservatively)', async () => {
    const r = repo({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' })
    const card = r.on('card', { 'a.txt': 'one\ntwo\nthree\nfour\nFIVE\n' })
    const target = r.on('target', { 'a.txt': 'ONE\ntwo\nthree\nfour\nfive\n' })
    sh(r.dir, 'checkout', '-q', '-B', 'merged', target)
    sh(r.dir, 'merge', '-q', '--no-edit', card)
    const result = sh(r.dir, 'rev-parse', 'HEAD')
    const submitted = await pathChanges(r.dir, r.base, card)
    expect(changedSince(submitted, await pathChanges(r.dir, target, result)).map((c) => c.newPath)).toEqual(['a.txt'])
    // Unread on either side: everything on the result's side is a change.
    const now = await pathChanges(r.dir, target, result)
    expect(changedSince(null, now)).toEqual(now)
  })
})

describe('chosen at submit, in the card folder at exactly the revision', () => {
  it("records the picker's tests and the change; the builder's own are added", async () => {
    const e = team(picker([{ test: 'tests/a.test.ts', needs: ['unit'] }, { test: 'board', needs: ['fake'] }]), runner().command)
    const { card } = await built(e)
    moved(await e.wf.submit(card.key, B1, { summary: 'x', tests: [{ id: 'extra', needs: [] }] }))
    const f = focusedOf(e, card)!
    expect(f).toMatchObject({ state: 'chosen', source: 'picked', picked: [{ id: 'tests/a.test.ts', needs: ['unit'] }, { id: 'board', needs: ['fake'] }], added: [{ id: 'extra', needs: [] }] })
    expect(f.change).toEqual([expect.objectContaining({ status: 'A', newPath: 'src/c.txt' })])
  })

  // GIT_HEAVY_MS: three projects, each a card built in its own repository and submitted twice (a refused pick, then the
  // builder's list); 4.1 s alone, 8.9 s beside three spinner workers, past 20 s in HI-2453's loaded full run.
  it("a picker that fails, says every test or has none refuses the submit; the builder's list stands in, reviewed", { timeout: GIT_HEAVY_MS }, async () => {
    for (const pick of [picker('fail'), picker([{ every: true }]), null]) {
      const e = team(pick, runner().command)
      const { card } = await built(e)
      const r = refusedBy(await e.wf.submit(card.key, B1, { summary: 'x' }), 'submit.focusedChosen')
      expect(r.message).toMatch(/focused tests couldn't be chosen/)
      moved(await e.wf.submit(card.key, B1, { summary: 'x', tests: [{ id: 'tests/a.test.ts', needs: [] }] }))
      expect(focusedOf(e, card)).toMatchObject({ source: 'manual', added: [{ id: 'tests/a.test.ts', needs: [] }] })
      env!.close()
      env = null
    }
  })

  it('a picker that writes a tracked file in the folder proves nothing: unknown, refused', async () => {
    const e = team(script("const fs = require('fs'); const t = fs.readFileSync('README.md'); fs.writeFileSync('README.md', 'x'); fs.writeFileSync('README.md', t); process.stdout.write('')"), runner().command)
    const { card } = await built(e)
    // Refused either way, nothing submitted: the bracket's (unknown, changed) or Combwork's own evidence check, which may see it first.
    const r = await e.wf.submit(card.key, B1, { summary: 'x' })
    expect(isRefusal(r) && ['submit.focusedChosen', 'evidence.changed'].includes(r.rule)).toBe(true)
    expect(e.kinds(card.id)).not.toContain('Submitted')
  })
})

describe('run by the merge queue at the merged result', () => {
  it('focused-only (no G9 checks): the tests run once with the jobs given, counted at the result; the target advances', async () => {
    const run = runner()
    const e = team(picker([{ test: 'tests/a.test.ts', needs: ['unit'] }, { test: 'board', needs: ['fake'] }]), run.command)
    const { card } = await built(e)
    await approved(e, card)
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(JSON.parse(readFileSync(run.seen, 'utf8'))).toEqual({ ids: ['tests/a.test.ts', 'board'], jobs: '3' })
    const result = sh(e.project, 'rev-parse', 'main')
    expect(e.wf.state(card).checks.at(-1)).toMatchObject({ name: 'focused tests', revision: result, result: 'passed', counted: true })
  })

  // GIT_HEAVY_MS: two cards built, approved and drained through the queue, 94 git processes; past 20 s in HI-2025's baseline run.
  it('a failed test, or a test with no result, returns the card with its output', { timeout: GIT_HEAVY_MS }, async () => {
    for (const want of [{ board: 'failed' }, { board: 'none' }] as const) {
      const e = team(picker([{ test: 'board', needs: ['fake'] }]), runner(want).command)
      const { card } = await built(e)
      await approved(e, card)
      const before = sh(e.project, 'rev-parse', 'main')
      const [o] = await queue(e).drain('main')
      expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
      expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
      expect(e.wf.state(card).entries.at(-1)?.failure?.log).toMatch(want.board === 'failed' ? /Failed: board/ : /no result for board/)
      env!.close()
      env = null
    }
  })

  it('an explicit empty selection merges without running anything', async () => {
    const run = runner()
    const e = team(picker([]), run.command)
    const { card } = await built(e)
    await approved(e, card)
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(() => readFileSync(run.seen)).toThrow()
  })

  // GIT_HEAVY_MS: a card through the queue twice (without its review run, then with it), 73 git processes; past 20 s in
  // HI-2025's run beside three other full runs.
  it('realProof = review: a real-CLI test without its counted review run returns the card; with it, accepted and not run here', { timeout: GIT_HEAVY_MS }, async () => {
    const run = runner()
    const e = team(picker([{ test: 'claude-real', needs: ['real'] }, { test: 'board', needs: ['fake'] }]), run.command)
    const { card, revision } = await built(e)
    await approved(e, card)
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'focused' })
    expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ focused: { why: 'noProof', tests: ['claude-real'] } })
    // The reviewer's counted run at the submitted revision, then the same revision back into the queue.
    const c = e.store.card(card.id)
    await e.wf.write(c, e.wf.rulesetOf(c, e.wf.state(c)), R1, (w) => w.fact('CheckRan', { name: 'focused:claude-real', command: 'npm run e2e -- claude-real', revision, tested: revision, result: 'passed', run: 'review-run', durationMs: 1, by: 'R1', agent: 'R1', counted: true }))
    moved(await e.wf.submit(card.key, B1, { summary: 'again' }))
    const [o2] = await queue(e).drain('main')
    expect(o2).toMatchObject({ outcome: 'integrated' })
    expect(JSON.parse(readFileSync(run.seen, 'utf8')).ids).toEqual(['board'])
    expect(e.wf.state(card).focusedAccepted).toEqual([expect.objectContaining({ test: 'claude-real', revision, run: 'review-run' })])
    expect(e.wf.state(card).checks.filter((x) => x.name === 'focused:claude-real' && x.revision !== revision)).toEqual([])
  })

  it('skipped tests pause the entry for its reviewer; its decision to merge lets the queue go on', async () => {
    const e = team(picker([{ test: 'board', needs: ['fake'] }]), runner({ board: 'skipped' }).command)
    const { card } = await built(e)
    await approved(e, card)
    const q = queue(e)
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'focusedSkip' })
    const req = e.wf.state(card).requests.find((r) => r.gate === 'focusedSkip')!
    expect(req).toMatchObject({ tests: ['board'] })
    expect(e.wakes.some((w) => w.agent === 'R1' && /cw_focused_skip/.test(w.why))).toBe(true)
    // Another agent can't decide it; its reviewer can.
    expect(isRefusal(await e.wf.focusedSkip(card.key, B1, req.request, true, 'mine'))).toBe(true)
    moved(await e.wf.focusedSkip(card.key, R1, req.request, true, 'the usage limit, not the work'))
    const [o2] = await q.drain('main')
    expect(o2).toMatchObject({ outcome: 'integrated' })
  })

  it("the result's own change to a submitted path is picked again there; a pick that can't choose returns the card", async () => {
    const e = team(picker([{ test: 'board', needs: ['fake'] }]), runner().command)
    const { card } = await built(e, { 'README.md': 'card\n' + readFileSync(join(e.project, 'README.md'), 'utf8') })
    await approved(e, card)
    // The target changes the same file elsewhere: the merged change to README.md isn't the submitted one.
    commit(e.project, { 'README.md': readFileSync(join(e.project, 'README.md'), 'utf8') + 'target\n' }, 'target moves')
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'integrated' })
    expect(e.kinds(card.id)).toContain('FocusedPicked')
  })
})

/** A picker reading what to print from a control file the test changes between the submit and the merge. */
function steered(): { command: string; set: (c: { pick?: unknown[]; writeReadme?: boolean; holdFor?: string; pidTo?: string }) => void } {
  const control = join(tempDir('focused-control-'), 'control.json')
  const set = (c: object): void => writeFileSync(control, JSON.stringify(c))
  set({ pick: [] })
  const body = `const fs = require('fs')
const c = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'))
if (c.pidTo) fs.writeFileSync(c.pidTo, String(process.pid))
if (c.writeReadme) { const t = fs.readFileSync('README.md'); fs.writeFileSync('README.md', 'x'); fs.writeFileSync('README.md', t) }
const out = () => process.stdout.write((c.pick || []).map((t) => JSON.stringify(t)).join('\\n'))
if (c.holdFor) { const t = Date.now(); const tick = () => (fs.existsSync(c.holdFor) || Date.now() - t > 60000 ? out() : setTimeout(tick, 50)); tick() } else out()`
  return { command: script(body), set }
}

/** A runner that writes `results` as given, whatever its tests, and exits `code`. */
function fixedRunner(results: (ids: string[]) => unknown, code: number): string {
  const f = join(tempDir('focused-fixed-'), 'results.cjs')
  writeFileSync(f, `module.exports = ${results.toString()}`)
  return script(`const fs = require('fs')
const ids = JSON.parse(fs.readFileSync(process.env.HIVE_FOCUSED_TESTS, 'utf8'))
const r = require(${JSON.stringify(f)})(ids)
fs.writeFileSync(process.env.HIVE_FOCUSED_RESULTS, typeof r === 'string' ? r : JSON.stringify(r))
process.exit(${code})`)
}

/** A counted, passing run of a focused test's check at `revision`, by `agent`. */
async function proofBy(e: Env, card: { id: number }, revision: string, test: string, agent: string, run = `run-${agent}`) {
  const c = e.store.card(card.id)
  await e.wf.write(c, e.wf.rulesetOf(c, e.wf.state(c)), `agent:${agent}`, (w) => w.fact('CheckRan', { name: `focused:${test}`, command: 'its command', revision, tested: revision, result: 'passed', run, durationMs: 1, by: agent, agent, counted: true }))
}

describe("HR4's round 1: what the merge takes as proof, decisions and results", () => {
  it("1: a real-CLI test's proof is its reviewer's run: the builder's own counted run is refused", async () => {
    const e = team(picker([{ test: 'claude-real', needs: ['real'] }]), runner().command)
    const { card, revision } = await built(e)
    await approved(e, card)
    await proofBy(e, card, revision, 'claude-real', 'B1')
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'focused' })
    expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ focused: { why: 'noProof', tests: ['claude-real'] } })
    expect(e.wf.state(card).focusedAccepted).toEqual([])
  })

  it("2: only the card's reviewer agent decides a skip: not the Assistant, not a request for another entry", async () => {
    const e = team(picker([{ test: 'board', needs: ['fake'] }]), runner({ board: 'skipped' }).command)
    const { card } = await built(e)
    await approved(e, card)
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'focusedSkip' })
    const req = e.wf.state(card).requests.find((r) => r.gate === 'focusedSkip')!
    for (const who of ['assistant', 'user', 'hive', B1] as const) expect(isRefusal(await e.wf.focusedSkip(card.key, who, req.request, true, 'not theirs')), who).toBe(true)
    expect(e.wf.state(card).approvals).toEqual([])
    expect(isRefusal(await e.wf.focusedSkip(card.key, R1, `${card.key}/r999`, true, 'no such request'))).toBe(true)
  })

  it('3: a skip decided for one merged result is asked again once the target moved; its answer never carries over', async () => {
    const e = team(picker([{ test: 'board', needs: ['fake'] }]), runner({ board: 'skipped' }).command)
    const { card } = await built(e)
    await approved(e, card)
    const q = queue(e)
    expect((await q.drain('main'))[0]).toMatchObject({ outcome: 'paused', reason: 'focusedSkip' })
    const first = e.wf.state(card).requests.find((r) => r.gate === 'focusedSkip')!
    // The target moves on, then the old request is approved.
    commit(e.project, { 'other.txt': 'other\n' }, 'target moves')
    moved(await e.wf.focusedSkip(card.key, R1, first.request, true, 'the usage limit'))
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'focusedSkip' })
    const again = e.wf.state(card).requests.find((r) => r.gate === 'focusedSkip')!
    expect(again.request).not.toBe(first.request)
    expect(e.kinds(card.id)).not.toContain('Integrated')
  })

  it("4: a test the merge's pick finds needs a real CLI now, though approved as fake, has no proof: returned", async () => {
    const p = steered()
    p.set({ pick: [{ test: 'one', needs: ['fake'] }] })
    const e = team(p.command, runner().command)
    const { card } = await built(e, { 'README.md': 'card\n' + readFileSync(join(e.project, 'README.md'), 'utf8') })
    await approved(e, card)
    commit(e.project, { 'README.md': readFileSync(join(e.project, 'README.md'), 'utf8') + 'target\n' }, 'target moves')
    p.set({ pick: [{ test: 'one', needs: ['real'] }] })
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'focused' })
    expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ focused: { why: 'newProof', tests: ['one'] } })
  })

  // GIT_HEAVY_MS: a card through the queue after the target moves, its pick bracketed by git reads of the folder, 93 git
  // processes; past 20 s in HI-2025's baseline run and its run beside three other full runs.
  it("5: the merge's pick is bracketed: one that writes in the folder proves nothing, even choosing no tests", { timeout: GIT_HEAVY_MS }, async () => {
    const p = steered()
    const e = team(p.command, runner().command)
    const { card } = await built(e, { 'README.md': 'card\n' + readFileSync(join(e.project, 'README.md'), 'utf8') })
    await approved(e, card)
    commit(e.project, { 'README.md': readFileSync(join(e.project, 'README.md'), 'utf8') + 'target\n' }, 'target moves')
    p.set({ pick: [], writeReadme: true })
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'uncounted' })
    expect(e.kinds(card.id)).not.toContain('Integrated')
  })

  // GIT_HEAVY_MS: two cards built, approved and drained through the queue, 90 git processes; past 20 s in HI-2025's run
  // beside three other full runs, and on HI-2001's loaded runs.
  it("6: a runner that didn't exit 0 failed, whatever its results say: all passed, or only skips", { timeout: GIT_HEAVY_MS }, async () => {
    for (const results of [(ids: string[]) => ids.map((t) => ({ test: t, result: 'passed' })), (ids: string[]) => ids.map((t) => ({ test: t, result: 'skipped', why: 'x' }))]) {
      const e = team(picker([{ test: 'board', needs: ['fake'] }]), fixedRunner(results, 7))
      const { card } = await built(e)
      await approved(e, card)
      const [o] = await queue(e).drain('main')
      expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
      expect(e.wf.state(card).checks.at(-1)).toMatchObject({ name: 'focused tests', result: 'failed' })
      env!.close()
      env = null
    }
  })

  it('9: a results file over its bound is refused before it is parsed', async () => {
    const e = team(picker([{ test: 'board', needs: ['fake'] }]), fixedRunner(() => `[${'{"test":"board","result":"passed","why":"' + 'x'.repeat(2 * 1024 * 1024) + '"}'}]`, 0))
    const { card } = await built(e)
    await approved(e, card)
    const [o] = await queue(e).drain('main')
    expect(o).toMatchObject({ outcome: 'returned', reason: 'checks' })
    expect(e.wf.state(card).entries.at(-1)?.failure?.log).toMatch(/over \d+ bytes/)
  })

  it("8: a pick still running when its workspace closes is ended, its process tree too, and chooses nothing", async () => {
    const life = new AbortController()
    const p = steered()
    const pid = join(tempDir('focused-pid-'), 'pid')
    p.set({ pick: [], holdFor: join(tempDir('focused-never-'), 'go'), pidTo: pid })
    env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] }, focusedTests: true, commands: { 'focused.pick': p.command, 'focused.run': runner().command } }, { focused: { env: base, timeoutMs: () => 60_000, life: life.signal } })
    const e = env
    const { card } = await built(e)
    const submitting = e.wf.submit(card.key, B1, { summary: 'x' })
    await vi.waitFor(() => expect(existsSync(pid)).toBe(true), { timeout: 30_000 })
    const n = Number(readFileSync(pid, 'utf8'))
    life.abort()
    refusedBy(await submitting, 'submit.focusedChosen')
    const alive = (): boolean => {
      try {
        process.kill(n, 0)
        return true
      } catch {
        return false
      }
    }
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 30_000 })
  })

  // HR4's round 2 finding 1: with the builder's own list too (none, empty, some), an ended submission is never recorded.
  for (const tests of [undefined, [], [{ id: 'mine', needs: [] }]] as (FocusedTest[] | undefined)[]) {
    it(`8: a newer submission of the card ends the one before, whose write is refused (tests: ${JSON.stringify(tests)})`, async () => {
      const p = steered()
      const pid = join(tempDir('focused-pid-'), 'pid')
      const go = join(tempDir('focused-go-'), 'go')
      p.set({ pick: [], holdFor: go, pidTo: pid })
      const e = team(p.command, runner().command)
      const { card } = await built(e)
      const first = e.wf.submit(card.key, B1, { summary: 'OLD', ...(tests ? { tests: [...tests] } : {}) })
      await vi.waitFor(() => expect(existsSync(pid)).toBe(true), { timeout: 30_000 })
      p.set({ pick: [] })
      moved(await e.wf.submit(card.key, B1, { summary: 'NEW', ...(tests ? { tests: [...tests] } : {}) }))
      refusedBy(await first, 'submit.focusedChosen')
      expect(e.wf.state(card).submissions.map((x) => x.summary)).toEqual(['NEW'])
      writeFileSync(go, 'go')
    })

    it(`8: a submission whose workspace closed while it picked is refused (tests: ${JSON.stringify(tests)})`, async () => {
      const life = new AbortController()
      const p = steered()
      const pid = join(tempDir('focused-pid-'), 'pid')
      p.set({ pick: [], holdFor: join(tempDir('focused-never-'), 'go'), pidTo: pid })
      env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] }, focusedTests: true, commands: { 'focused.pick': p.command, 'focused.run': runner().command } }, { focused: { env: base, timeoutMs: () => 60_000, life: life.signal } })
      const { card } = await built(env)
      const submitting = env.wf.submit(card.key, B1, { summary: 'x', ...(tests ? { tests: [...tests] } : {}) })
      await vi.waitFor(() => expect(existsSync(pid)).toBe(true), { timeout: 30_000 })
      life.abort()
      refusedBy(await submitting, 'submit.focusedChosen')
      expect(env.wf.state(card).submissions).toEqual([])
    })
  }

  // HR4's round 3: the operation is settled once per submit call; its retries (a re-gather after the evidence changed)
  // carry it and never make one. OLD held after its pick, NEW started (ending OLD), the evidence changed by a stat-only
  // touch of the index: OLD is refused, never gathered again, and NEW is the one submitted.
  for (const tests of [undefined, [{ id: 'mine', needs: [] }]] as (FocusedTest[] | undefined)[]) {
    it(`8: a superseded submission held before its write never restarts through a re-gather (tests: ${JSON.stringify(tests)})`, async () => {
      const p = steered()
      p.set({ pick: [] })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let atBoundary = false
      let calls = 0
      env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] }, focusedTests: true, commands: { 'focused.pick': p.command, 'focused.run': runner().command } }, {
        focused: { env: base, timeoutMs: () => 60_000 },
        hooks: {
          beforeWrite: async (move) => {
            if (move !== 'submit' || ++calls > 1) return
            atBoundary = true
            await held
          }
        }
      })
      const e = env
      const { card, folder } = await built(e)
      const old = e.wf.submit(card.key, B1, { summary: 'OLD', ...(tests ? { tests: [...tests] } : {}) })
      await vi.waitFor(() => expect(atBoundary).toBe(true), { timeout: 30_000 })
      // NEW starts and is held in its picker: its operation has ended OLD's.
      const pid = join(tempDir('focused-pid-'), 'pid')
      const go = join(tempDir('focused-go-'), 'go')
      p.set({ pick: [], holdFor: go, pidTo: pid })
      const next = e.wf.submit(card.key, B1, { summary: 'NEW', ...(tests ? { tests: [...tests] } : {}) })
      await vi.waitFor(() => expect(existsSync(pid)).toBe(true), { timeout: 30_000 })
      // A stat-only change of the evidence: the index touched, its contents the same.
      const index = join(folder, sh(folder, 'rev-parse', '--git-path', 'index'))
      const later = new Date(Date.now() + 5_000)
      utimesSync(existsSync(index) ? index : sh(folder, 'rev-parse', '--git-path', 'index'), later, later)
      release()
      refusedBy(await old, 'submit.focusedChosen')
      writeFileSync(go, 'go')
      moved(await next)
      expect(e.wf.state(card).submissions.map((x) => x.summary)).toEqual(['NEW'])
    })
  }

  // HR4's round 2 finding 2: each review-only need the merge's pick adds for an id is new, whatever it had.
  for (const [was, now] of [[['real'], ['real', 'packaged']], [['packaged'], ['packaged', 'real']]] as FocusedNeed[][][]) {
    it(`4: a test approved as ${was.join(' and ')} that the merge's pick finds needs ${now.join(' and ')} has no proof for it: returned`, async () => {
      const p = steered()
      p.set({ pick: [{ test: 'one', needs: was }] })
      const e = team(p.command, runner().command)
      const { card, revision } = await built(e, { 'README.md': 'card\n' + readFileSync(join(e.project, 'README.md'), 'utf8') })
      await approved(e, card)
      await proofBy(e, card, revision, 'one', 'R1')
      commit(e.project, { 'README.md': readFileSync(join(e.project, 'README.md'), 'utf8') + 'target\n' }, 'target moves')
      p.set({ pick: [{ test: 'one', needs: now }] })
      const [o] = await queue(e).drain('main')
      expect(o).toMatchObject({ outcome: 'returned', reason: 'focused' })
      expect(e.wf.state(card).entries.at(-1)?.failure).toMatchObject({ focused: { why: 'newProof', tests: ['one'] } })
      expect(e.wf.state(card).focusedAccepted).toEqual([])
    })
  }
})
