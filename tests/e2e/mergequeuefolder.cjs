// Merging into a target checked out in a folder (#1351, SPEC §16.9.2; S27, S34a–c, S42, OP-40): a project set to "Combwork
// merges" into `main`, checked out in the project folder, fake Claude Code agents acting by their own tokens (a reviewer
// whose session lives in the project folder, idle; one builder, building each card on the slot its start lends, as 1.0
// does: #1573), the Assistant off.
// - Ask each time (chosen: Automatically is the default since this card's crash tests passed): the card waits with
//   "update main in <folder> now?" in For you (screenshots of the card dialog's request, both themes); Approve merges it.
// - Automatically, the default (the setting reset; nothing asked): S27/S42, the user commits in the folder and the Git view switches branches during the merge checks,
//   not held up (the lock is held only for the advance); the swap catches the moved main and tests again.
// - S42/S34c: the user's edit in a file the merge changes pauses the queue (not a return) naming it, the edit untouched;
//   anything staged pauses it naming the files; once put right, Resume merges.
// - S34b: the folder on another branch: main is checked out nowhere then, and merged by compare-and-swap, the folder's
//   files untouched.
// - S34a: main moved by another client just before the swap (HIVE_TEST_QUEUE_RACE): rolled back, tested again, merged once.
// Crashes at each point of the journal and the terminal state are mergequeuecrash's (S34d), in a suite of their own.
// Dev build, throwaway profiles, workspace and CLAUDE_CONFIG_DIR.
// S34a's race is a test seam (HIVE_TEST_QUEUE_RACE): NOT RUN on a packaged build (HIVE_EXE), where the rest runs
// (#1578).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47848))
const fx = q.queueProject('mergequeuefolder')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
// Every wait here is bounded only against a hang (#570).
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const f = q.folderHelpers(fx)
const main = () => q.head(fx, 'main')
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  q.prepare(fx)
  let h = await q.startHive(fx, { port: PORT, keepOptions: true })
  let reviewer = null
  let builder = null
  try {
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options() })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const column = async (n) => (await h.card(n))?.column
    const done = async (n) => (await waitHung(async () => (await column(n)) === 'done')) === true
    const queue = async () => (await h.inv('queue:list', fx.alpha, 'main'))[0]
    const paused = (reason) => waitHung(async () => ((await queue())?.paused?.reason === reason ? (await queue()).paused : null))
    // S42: the reviewer's session lives in the project folder, idle, reviewing in a review copy: it doesn't hold the queue up.
    reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token, its session in the project folder', !!reviewer.token && same(reviewer.folder, fx.alpha))
    builder = await q.agent(fx, h, 'B1')

    // --- Ask each time, chosen: For you, then Approve.
    await h.inv('advanced:set', 'cw.queue.checkedOutTarget', 'ask')
    q.steer(fx, 'pass')
    const atAsk = main()
    const one = await q.approveBy(fx, h, builder, reviewer, 'One', { 'one.txt': 'one\n' })
    check('the card is approved (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    const asked = await waitHung(async () => (await h.inv('tasks:forYou')).items?.find((i) => i.card === one.n && i.gate === 'queueAdvance'))
    check('Ask each time: tested, it waits for the Approve in For you, its message naming main and the folder', !!asked && asked.kind === 'approve' && asked.shown?.id === 'workflow.forYou.queueAdvance' && asked.shown.values?.target === 'main', JSON.stringify(asked))
    const p1 = await paused('approval')
    check('…the queue paused for it (approval), the folder named, nothing touched', same(p1?.files?.[0], fx.alpha) && main() === atAsk && !(await h.kinds(one.n)).includes('IntegrationStarted'), JSON.stringify(p1))
    const ask = await f.forYouSection(h, one.n)
    check("…the card dialog shows it: Approve, the request's words", !!(await waitHung(async () => /Approve[\s\S]*update main in/.test(await ask.section.innerText().catch(() => '')))), await ask.section.innerText().catch(() => ''))
    await f.themes(h.page, ask.section, 'mergequeuefolder-ask')
    await ask.section.getByRole('button', { name: 'Approve' }).click()
    check('…approved: merged into main at once, in the folder', (await done(one.n)) && f.text('one.txt') === 'one\n', `${JSON.stringify(await h.kinds(one.n))} ${JSON.stringify(f.text('one.txt'))}`)
    check('…the folder clean at the result, merged once', f.status() === '' && f.merges((await h.card(one.n)).key) === 1, f.status())
    await h.page.keyboard.press('Escape')

    // --- The setting back to its default, Automatically, from here (S27's card shows nothing is asked).
    await h.inv('advanced:set', 'cw.queue.checkedOutTarget', null)
    check('Merge into a checked-out branch: back to its default', (await h.inv('advanced:state')).values['cw.queue.checkedOutTarget'] === undefined)

    // --- S27 / S42: the user commits in the folder and the Git view switches branches during the checks.
    q.steer(fx, 'wait')
    const two = await q.approveBy(fx, h, builder, reviewer, 'Two', { 'two.txt': 'two\n' })
    check('S42: its check is running', !!(await waitHung(() => fs.existsSync(fx.started))))
    fs.writeFileSync(path.join(fx.alpha, 'mine.txt'), 'the user commits\n')
    lib.git(fx.alpha, ['add', 'mine.txt'])
    lib.git(fx.alpha, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'the user commits'])
    const userCommit = main()
    // The Git view's actions take the repository lock: done while the check still runs (it waits for go.txt).
    const viaGitView = await h.inv('git:createBranch', fx.alpha, 'scratch').then(() => h.inv('git:switch', fx.alpha, 'main')).then(() => 'ok', (e) => String(e.message ?? e))
    check("…the Git view isn't held up by the queue (a branch made and switched back during the check)", viaGitView === 'ok' && !fs.existsSync(fx.go), viaGitView)
    fs.rmSync(fx.started, { force: true })
    fs.writeFileSync(fx.go, 'go')
    check('…merged: Done', await done(two.n), JSON.stringify(await h.kinds(two.n)))
    check('…the default is Automatically: nothing was asked', !(await h.facts(two.n)).some((x) => x.kind === 'ApprovalRequested') && !(await h.kinds(two.n)).includes('Approval'), JSON.stringify(await h.kinds(two.n)))
    const [i2] = (await h.facts(two.n)).filter((x) => x.kind === 'Integrated')
    check("S27: its result's first parent is the user's commit: tested again on the moved main", !!i2 && lib.git(fx.alpha, ['rev-parse', `${i2.data.result}^1`]).trim() === userCommit, JSON.stringify(i2))
    check('…its checks ran twice (once per test merge); the folder clean', (await h.facts(two.n)).filter((x) => x.kind === 'CheckRan').length === 2 && f.status() === '', f.status())

    // --- S42 / S34c: the user's edit in a file the merge changes: paused, named, the edit untouched.
    q.steer(fx, 'pass')
    fs.writeFileSync(path.join(fx.alpha, 'a.txt'), 'the user is editing a.txt\n')
    const three = await q.approveBy(fx, h, builder, reviewer, 'Three', { 'a.txt': 'one\ntwo by Three\nthree\n' })
    const p3 = await paused('unstagedChanges')
    check("S34c: the user's edit in a file the merge changes pauses the queue, naming it", JSON.stringify(p3?.files) === '["a.txt"]', JSON.stringify(p3))
    check('…not returned: still merging; the edit untouched', (await column(three.n)) !== 'doing' && !(await h.kinds(three.n)).includes('IntegrationStarted') && f.text('a.txt') === 'the user is editing a.txt\n')
    const stillThere = await h.inv('queue:resume', fx.alpha, 'main')
    check('…Resume while the edit is there: still paused, saying so', stillThere.resumed === false && stillThere.view.paused?.reason === 'unstagedChanges', JSON.stringify(stillThere.view.paused))
    lib.git(fx.alpha, ['checkout', '--', 'a.txt'])
    const resumed = await h.inv('queue:resume', fx.alpha, 'main')
    check('…put back, Resume: merged', resumed.resumed === true && (await done(three.n)) && f.text('a.txt') === 'one\ntwo by Three\nthree\n', `${JSON.stringify(resumed.view.paused)} ${JSON.stringify(f.text('a.txt'))}`)

    // --- S34c: anything staged pauses it, naming the files.
    fs.writeFileSync(path.join(fx.alpha, 'staged.txt'), 'staged by the user\n')
    lib.git(fx.alpha, ['add', 'staged.txt'])
    const four = await q.approveBy(fx, h, builder, reviewer, 'Four', { 'four.txt': 'four\n' })
    const p4 = await paused('staged')
    check('S34c: something staged pauses the queue, naming it; the index untouched', JSON.stringify(p4?.files) === '["staged.txt"]' && lib.git(fx.alpha, ['diff', '--cached', '--name-only']).trim() === 'staged.txt', JSON.stringify(p4))
    lib.git(fx.alpha, ['reset', '-q'])
    fs.rmSync(path.join(fx.alpha, 'staged.txt'))
    check('…unstaged, Resume: merged', (await h.inv('queue:resume', fx.alpha, 'main')).resumed === true && (await done(four.n)))

    // --- S34b: the folder on another branch: main checked out nowhere, merged by compare-and-swap; the folder untouched.
    lib.git(fx.alpha, ['checkout', '-q', '-b', 'elsewhere'])
    const five = await q.approveBy(fx, h, builder, reviewer, 'Five', { 'five.txt': 'five\n' })
    check('S34b: the folder on another branch: merged into main all the same', await done(five.n))
    check('…by compare-and-swap: the folder still on its branch, its files untouched', lib.git(fx.alpha, ['branch', '--show-current']).trim() === 'elsewhere' && f.text('five.txt') === null && f.status() === '' && !(await h.facts(five.n)).find((x) => x.kind === 'IntegrationStarted')?.data?.checkedOut)
    lib.git(fx.alpha, ['checkout', '-q', 'main'])
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }

  // --- S34a: main moved by another client just before the swap (no crash): rolled back, tested again, merged once.
  // The race is a test seam of unpackaged builds: a packaged one (HIVE_EXE, the Sandbox checks) skips it, saying so.
  if (process.env.HIVE_EXE) console.log('NOT RUN S34a (main moved just before the swap) needs an unpackaged build: not run with HIVE_EXE')
  else try {
    h = await q.startHive(fx, { port: PORT, env: { HIVE_TEST_QUEUE_RACE: 'beforeRef' }, keepOptions: true })
    const r = await q.rejoin(fx, h, reviewer)
    const atRace = main()
    q.steer(fx, 'pass')
    const six = await q.approveBy(fx, h, builder, r, 'Six', { 'six.txt': 'six\n' })
    const doneSix = await waitHung(async () => (await h.card(six.n))?.column === 'done')
    const failures = (await h.facts(six.n)).filter((x) => x.kind === 'IntegrationFailed')
    check('S34a: the swap found main moved: failed (target moved) once, then merged', !!doneSix && failures.length === 1 && failures[0].data.reason === 'targetMoved', JSON.stringify(await h.kinds(six.n)))
    const [first] = lib.git(fx.alpha, ['log', '-1', '--format=%P', 'main']).trim().split(' ')
    check("…its merge's first parent is the other client's commit (tested again), merged once, the folder clean", lib.git(fx.alpha, ['rev-parse', `${first}^`]).trim() === atRace && lib.git(fx.alpha, ['log', '-1', '--format=%s', first]).trim() === 'race' && f.merges((await h.card(six.n)).key) === 1 && f.status() === '' && f.text('six.txt') === 'six\n', f.status())
  } catch (e) {
    check('S34a: no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(`screenshots: ${fx.shots}`)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
