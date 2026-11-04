// Each card's focused tests (G20, HI-1367; SPEC §16.9.1): a project set to "Hive merges" into `integration`
// (queueFixture.cjs) with no G9 checks and G20 on, its picker and runner node scripts outside the repository, steered by
// a control file; fake Claude Code agents acting by their own tokens. The picker's tests are kept with the submission;
// the queue runs them once with the jobs Settings → Advanced gives, and merges on green; a failed test returns the card
// with its output; a skipped one pauses the queue and asks the card's reviewer, whose cw_focused_skip lets it merge; a
// picker that fails refuses the submit until the builder names the tests itself.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47701))
const fx = q.queueProject('queuefocused')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

const focused = path.join(fx.tools, 'focused.json')
const seen = path.join(fx.tools, 'focused-seen.json')
/** What the picker prints and how each test ends, for the next card: { pick: [...] | 'fail', results: { id: result } }. */
const steerFocused = (c) => {
  fs.rmSync(seen, { force: true })
  fs.writeFileSync(focused, JSON.stringify(c))
}

/** The picker and runner, node scripts in the suite's tools folder (never in the repository: a check must count). */
function tools() {
  const pick = path.join(fx.tools, 'pick.js')
  const run = path.join(fx.tools, 'run.js')
  fs.writeFileSync(pick, [
    "const fs = require('fs')",
    `const c = JSON.parse(fs.readFileSync(${JSON.stringify(focused)}, 'utf8'))`,
    "if (c.pick === 'fail') { process.stderr.write('the picker broke'); process.exit(2) }",
    "process.stdout.write(c.pick.map((t) => JSON.stringify(t)).join('\\n'))",
    ''
  ].join('\n'))
  fs.writeFileSync(run, [
    "const fs = require('fs')",
    `const c = JSON.parse(fs.readFileSync(${JSON.stringify(focused)}, 'utf8'))`,
    "const ids = JSON.parse(fs.readFileSync(process.env.HIVE_FOCUSED_TESTS, 'utf8'))",
    `fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ ids, jobs: process.env.HIVE_FOCUSED_JOBS }))`,
    "const out = ids.map((t) => ({ test: t, result: (c.results || {})[t] || 'passed', ...((c.results || {})[t] === 'skipped' ? { why: 'usage limit' } : {}) }))",
    "for (const r of out) if (r.result === 'failed') console.error(r.test + ': 2 failing')",
    'fs.writeFileSync(process.env.HIVE_FOCUSED_RESULTS, JSON.stringify(out))',
    "process.exit(out.some((r) => r.result === 'failed') ? 1 : 0)",
    ''
  ].join('\n'))
  return { pick: `node "${pick}"`, run: `node "${run}"` }
}

;(async () => {
  q.prepare(fx)
  const cmd = tools()
  steerFocused({ pick: [{ test: 'tests/a.test.ts', needs: ['unit'] }, { test: 'board', needs: ['fake'] }] })
  const h = await q.startHive(fx, { port: PORT })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { mergeChecks: [], focusedTests: true, commands: { 'focused.pick': cmd.pick, 'focused.run': cmd.run } }) })
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column
    const submitted = async (n) => (await h.facts(n)).findLast((f) => f.kind === 'Submitted')?.data

    // --- Chosen at submit and run by the queue at the merged result, once, with the jobs it is given: Done.
    const one = await q.approve(fx, h, reviewer, 'Chosen', { 'b.txt': 'b\n' })
    check('a card is approved (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    const sub = await submitted(one.n)
    check('its submission keeps the tests its picker chose, with its change', sub?.focused?.state === 'chosen' && JSON.stringify(sub.focused.picked.map((t) => t.id)) === '["tests/a.test.ts","board"]' && sub.focused.change?.[0]?.newPath === 'b.txt', JSON.stringify(sub?.focused))
    check('…merged by the queue: Done', !!(await until(async () => (await column(one.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(one.n)))
    const ran = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null
    check('…its runner was given its tests and two jobs (Settings → Advanced)', JSON.stringify(ran) === JSON.stringify({ ids: ['tests/a.test.ts', 'board'], jobs: '2' }), JSON.stringify(ran))
    const checks = (await h.facts(one.n)).filter((f) => f.kind === 'CheckRan' && f.data.name === 'focused tests')
    check('…recorded as the check "focused tests", passed and counted at the result', checks.length === 1 && checks[0].data.result === 'passed' && checks[0].data.counted && checks[0].data.revision === q.head(fx), JSON.stringify(checks))

    // --- A failed test returns the card with its output.
    steerFocused({ pick: [{ test: 'board', needs: ['fake'] }], results: { board: 'failed' } })
    const two = await q.approve(fx, h, reviewer, 'Red', { 'c.txt': 'c\n' })
    const failure = await until(async () => (await h.facts(two.n)).find((f) => f.kind === 'IntegrationFailed') ?? null, HUNG_MS)
    check('a failed focused test returns the card, its output kept', failure?.data?.reason === 'checks' && failure.data.check === 'focused tests' && String(failure.data.log).includes('Failed: board') && String(failure.data.log).includes('board: 2 failing'), JSON.stringify(failure?.data))
    check('…back to its builder', !!(await until(async () => (await column(two.n)) === 'doing', HUNG_MS)), String(await column(two.n)))

    // --- A skipped test pauses the queue and asks the card's reviewer; its decision to merge lets it go on.
    steerFocused({ pick: [{ test: 'board', needs: ['fake'] }], results: { board: 'skipped' } })
    const three = await q.approve(fx, h, reviewer, 'Skipped', { 'd.txt': 'd\n' })
    const asked = await until(async () => (await h.facts(three.n)).find((f) => f.kind === 'ApprovalRequested' && f.data.gate === 'focusedSkip') ?? null, HUNG_MS)
    check('a skipped focused test asks under For you, naming it', !!asked && JSON.stringify(asked.data.tests) === '["board"]' && String(asked.data.text).includes('board (usage limit)'), JSON.stringify(asked?.data))
    const other = await q.intent(h, two.builder, three.n, 'focused-skip', { request: asked?.data?.request, merge: true, why: 'not mine' })
    check('…another agent can\'t decide it', other.status === 409, JSON.stringify(other))
    const decided = await q.intent(h, reviewer, three.n, 'focused-skip', { request: asked?.data?.request, merge: true, why: 'the usage limit, not the work' })
    check('…its reviewer decides it merges with it skipped', decided.status === 200, JSON.stringify(decided))
    check('…and the queue merges it: Done', !!(await until(async () => (await column(three.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(three.n)))

    // --- A picker that fails refuses the submit; the builder's own list stands in, for its reviewer.
    steerFocused({ pick: 'fail' })
    const n = (await h.inv('tasks:create', { title: 'Unpicked', project: 'alpha' })).number
    const builder = await q.agent(fx, h, `B${n}`)
    await q.startCard(fx, h, builder, n)
    fs.writeFileSync(path.join(builder.folder, 'e.txt'), 'e\n')
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'unpicked'])
    const refused = await q.intent(h, builder, n, 'submit', { summary: 'ready' })
    check("a picker that fails refuses the submit (submit.focusedChosen), saying how to go on", refused.status === 409 && refused.body?.rule === 'submit.focusedChosen' && String(refused.body?.next).includes('tests'), JSON.stringify(refused))
    const named = await q.intent(h, builder, n, 'submit', { summary: 'ready', tests: ['board'] })
    check("…the builder's own list goes to review in its place", named.status === 200 && (await submitted(n))?.focused?.source === 'manual', JSON.stringify(named))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
