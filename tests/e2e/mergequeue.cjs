// The merge queue in the app (#1348, SPEC §16.9.1, §16.9.3): a project set to "Combwork merges" into `integration` (checked
// out in no folder), fake Claude Code agents acting by their own tokens, the Assistant off. Each card is approved by its
// builder and the reviewer (queueFixture.cjs), and Combwork's queue takes it from there:
// - merged: Done, `Integrated` with the result, the target at it, Combwork's trailers;
// - a conflict with the target: back to its builder with the files; a red check: back with its log;
// - a check that couldn't start (transient): back, and the builder's resubmission of the same revision goes straight
//   into the queue (requeue) and is merged;
// - merged by hand during its check (S7): observed, never merged twice;
// - the target moved during its check (S27): tested again on the new head, never an untested advance;
// - the project's options moved to the agent merge during its check: merged all the same (the card's ruleset);
// - workflow rules turned off during its check: no advance (paused); on again, it is merged;
// - Combwork ended right after the target moved, before `Integrated` (S33c): the next start records it, once.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Builders on slots (#1578). S33c ends Combwork at a crash seam (CW_TEST_QUEUE_CRASH): NOT RUN on a packaged build
// (CW_EXE), where the rest runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47845))
const fx = q.queueProject('mergequeue')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  q.prepare(fx)
  let h = await q.startHive(fx, { port: PORT })
  try {
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const integrated = async (n) => (await h.facts(n)).filter((f) => f.kind === 'Integrated')
    const failedFacts = async (n) => (await h.facts(n)).filter((f) => f.kind === 'IntegrationFailed')
    const column = async (n) => (await h.card(n))?.column
    /** Waits until the card is Done (bounded only against a hang): whether it is. */
    const done = async (n) => (await until(async () => (await column(n)) === 'done', HUNG_MS)) === true
    /** Waits for the card's first IntegrationFailed (bounded only against a hang). */
    const firstFailure = (n) =>
      until(async () => {
        const f = await failedFacts(n)
        return f.length ? f : null
      }, HUNG_MS)
    /** Waits until the check has started (it writes its pid). */
    const checkRunning = async () => !!(await until(() => fs.existsSync(fx.started), HUNG_MS))

    // --- Merged: Done, Integrated with the result, the target at it.
    q.steer(fx, 'pass')
    const one = await q.approve(fx, h, reviewer, 'One', { 'one.txt': 'one\n' })
    check('the card is approved (start, submit, review, pass)', Object.values(one.steps).every((s) => s.status === 200), JSON.stringify(one.steps))
    check('the queue merges it: Done', (await done(one.n)), JSON.stringify(await h.kinds(one.n)))
    const [i1] = await integrated(one.n)
    check('…Integrated by Combwork with the result, the target at it', i1?.data?.by === 'hive' && i1.data.result === q.head(fx) && i1.data.target === 'integration', JSON.stringify(i1))
    const message = lib.git(fx.alpha, ['log', '-1', '--format=%B', 'integration'])
    check("…a merge commit with Combwork's trailers, its revision the builder's", message.includes(`Hive-Card: ${(await h.card(one.n)).key}`) && message.includes(`Hive-Revision: ${one.revision}`), message)
    check('…main untouched (the project folder\'s branch)', lib.git(fx.alpha, ['rev-parse', 'main']).trim() !== q.head(fx))
    const key1 = (await h.card(one.n)).key
    const refs = () => lib.git(fx.alpha, ['for-each-ref', '--format=%(refname)', 'refs/hive/']).split(/\r?\n/).filter(Boolean)
    check("…its test merge's ref dropped once it had its outcome; its submission still pinned", !refs().some((r) => r === `refs/hive/queue/${key1}`) && refs().some((r) => r.startsWith(`refs/hive/cards/${key1.toLowerCase()}/`)), JSON.stringify(refs()))
    // Archived: its pin goes at the queue's next run (the next card's).
    await h.inv('tasks:archive', one.n, true)

    // --- A conflict: back to its builder with the files.
    // Someone's change lands once Two's line is made (a line is made from the target's head).
    const someone = () => q.commitOn(fx, 'integration', { 'a.txt': 'one\nTWO by someone\nthree\n' }, 'someone changes a.txt')
    const two = await q.approve(fx, h, reviewer, 'Two', { 'a.txt': 'one\ntwo by the builder\nthree\n' }, { afterStart: someone })
    const before = q.head(fx)
    const [f2] = await firstFailure(two.n)
    check('a conflict returns it: IntegrationFailed (conflict) naming a.txt, back in Doing', f2?.data?.reason === 'conflict' && JSON.stringify(f2.data.files) === '["a.txt"]' && (await column(two.n)) === 'doing', JSON.stringify(f2))
    check('…the target unmoved', q.head(fx) === before)
    // HI-1181: its hunk recorded (the target's side first, the card's second), unfolded read-only in the Work section.
    const hunk = f2?.data?.conflicts?.files?.[0]?.hunks?.[0]
    check("…its hunk recorded: integration's side first, the builder's second", f2?.data?.conflicts?.oursIs === 'target' && JSON.stringify(hunk?.ours) === '["TWO by someone"]' && JSON.stringify(hunk?.theirs) === '["two by the builder"]' && hunk?.line === 2, JSON.stringify(f2?.data?.conflicts))
    await q.showBoard(h.page)
    await q.openByTitle(h.page, two.n)
    const twoDialog = h.page.locator('.dialog').filter({ has: h.page.locator('.task-title-input') })
    await twoDialog.waitFor({ timeout: HUNG_MS })
    const fileRow = twoDialog.locator('[data-conflict-file="a.txt"]')
    check('…the Work section lists a.txt with its one conflict', !!(await until(async () => /a\.txt\s+1 conflict/.test(await fileRow.innerText().catch(() => '')), HUNG_MS)), await fileRow.innerText().catch(() => ''))
    await fileRow.locator('button').click()
    const hunkText = fileRow.locator('.card-work-hunk-text')
    const twoKey = (await h.card(two.n)).key
    const inOrder = (t) => {
      const at = ['integration', 'TWO by someone', twoKey, 'two by the builder'].map((x) => t.indexOf(x))
      return at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]))
    }
    check('…unfolded: its sides under their names, integration then the card, from line 2', !!(await until(async () => inOrder(await hunkText.innerText().catch(() => '')), HUNG_MS)) && /From line 2/.test(await fileRow.innerText()), await fileRow.innerText().catch(() => ''))
    const returnedPart = fileRow.locator('xpath=ancestor::*[contains(@class,"card-work-queue-returned")][1]')
    for (const theme of ['dark', 'light']) {
      await h.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await h.page.mouse.move(5, 5)
      await returnedPart.screenshot({ path: require('path').join(lib.WORK, `mergequeue-conflict-hunks-${theme}.png`) })
    }
    await h.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await h.page.keyboard.press('Escape')
    // The run prunes once its queue is drained, after the outcome above is recorded.
    const pinGone = await until(() => !refs().some((r) => r.startsWith(`refs/hive/cards/${key1.toLowerCase()}/`)), HUNG_MS)
    const key2 = (await h.card(two.n)).key.toLowerCase()
    check("…the archived card's pin removed at the queue's next run; the next card's kept", !!pinGone && refs().some((r) => r.startsWith(`refs/hive/cards/${key2}/`)), JSON.stringify(refs()))

    // --- A red check: back with its log.
    q.steer(fx, 'fail', 'three is broken')
    const three = await q.approve(fx, h, reviewer, 'Three', { 'three.txt': 'three\n' })
    const [f3] = await firstFailure(three.n)
    check('a red check returns it: IntegrationFailed (checks), not transient, with its log', f3?.data?.reason === 'checks' && f3.data.transient === false && String(f3.data.log).includes('red: three is broken') && (await column(three.n)) === 'doing', JSON.stringify(f3))
    check('…the target unmoved', q.head(fx) === before)

    // --- A check that couldn't start (transient), then the same revision resubmitted: straight back into the queue.
    q.steer(fx, 'pass')
    fs.renameSync(fx.tool, `${fx.tool}.away`)
    const four = await q.approve(fx, h, reviewer, 'Four', { 'four.txt': 'four\n' })
    const [f4] = await firstFailure(four.n)
    check("a check that couldn't start returns it as transient", f4?.data?.reason === 'checks' && f4.data.transient === true && (await column(four.n)) === 'doing', JSON.stringify(f4))
    fs.renameSync(`${fx.tool}.away`, fx.tool)
    const again = await q.intent(h, four.builder, four.n, 'submit', { summary: 'Four: the same revision, again' })
    check('…its builder resubmits the same revision: into the queue at once (no new review)', again.status === 200, JSON.stringify(again.body))
    check('…and it is merged', (await done(four.n)), JSON.stringify(await h.kinds(four.n)))

    // --- Merged by hand during its check (S7): observed, not merged twice.
    q.steer(fx, 'wait')
    const five = await q.approve(fx, h, reviewer, 'Five', { 'five.txt': 'five\n' })
    check('S7: its check is running', (await checkRunning()))
    const byHand = q.mergeOn(fx, 'integration', five.revision, 'merged by hand')
    fs.writeFileSync(fx.go, 'go')
    check('…the hand merge is observed: Done', (await done(five.n)), JSON.stringify(await h.kinds(five.n)))
    const [i5] = await integrated(five.n)
    check('…Integrated by someone outside Combwork, the target where the hand merge left it (no second merge)', i5?.data?.by === 'outside' && q.head(fx) === byHand, `${JSON.stringify(i5)} head ${q.head(fx)} by hand ${byHand}
${lib.git(fx.alpha, ['log', '--oneline', '--graph', '-8', 'integration'])}
${JSON.stringify(await h.kinds(five.n))}`)

    // --- The target moves during its check (S27): tested again on the new head.
    q.steer(fx, 'wait')
    const six = await q.approve(fx, h, reviewer, 'Six', { 'six.txt': 'six\n' })
    check('S27: its check is running', (await checkRunning()))
    const moved = q.commitOn(fx, 'integration', { 'race.txt': 'race\n' }, 'the target moves')
    fs.rmSync(fx.started, { force: true })
    fs.writeFileSync(fx.go, 'go')
    check('…merged: Done', (await done(six.n)), JSON.stringify(await h.kinds(six.n)))
    const [i6] = await integrated(six.n)
    check("…its result's first parent is the moved target: tested again on it", !!i6 && lib.git(fx.alpha, ['rev-parse', `${i6.data.result}^1`]).trim() === moved, JSON.stringify(i6))
    check('…its checks ran twice (once per test merge)', (await h.facts(six.n)).filter((f) => f.kind === 'CheckRan').length === 2)

    // --- The project's options move to the agent merge during its check: the card's ruleset still merges it.
    q.steer(fx, 'wait')
    const seven = await q.approve(fx, h, reviewer, 'Seven', { 'seven.txt': 'seven\n' })
    check('options: its check is running', (await checkRunning()))
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges' }) })
    fs.writeFileSync(fx.go, 'go')
    check("…merged all the same under the card's ruleset: Done, Integrated by Combwork", (await done(seven.n)) && (await integrated(seven.n))[0]?.data?.by === 'hive', JSON.stringify(await h.kinds(seven.n)))
    await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })

    // --- Workflow rules off during its check: no advance; on again, merged.
    q.steer(fx, 'wait')
    const eight = await q.approve(fx, h, reviewer, 'Eight', { 'eight.txt': 'eight\n' })
    check('rules off: its check is running', (await checkRunning()))
    const atOff = q.head(fx)
    await h.inv('advanced:set', 'cw.workflow.enforce', false)
    fs.writeFileSync(fx.go, 'go')
    // Its checks finish (a CheckRan), and then nothing advances.
    await until(async () => (await h.facts(eight.n)).some((f) => f.kind === 'CheckRan'), HUNG_MS)
    check('…no advance: no IntegrationStarted, the target unmoved, still Merging', !(await h.kinds(eight.n)).includes('IntegrationStarted') && q.head(fx) === atOff && (await column(eight.n)) !== 'done')
    q.steer(fx, 'pass')
    await h.inv('advanced:set', 'cw.workflow.enforce', true)
    check('…on again: merged', (await done(eight.n)), JSON.stringify(await h.kinds(eight.n)))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }

  if (q.devSeam('S33c (Combwork ended right after the advance, CW_TEST_QUEUE_CRASH)')) {
    // --- S33c: Combwork ends right after the target moved, before Integrated; the next start records it, once.
    let crashed = null
    try {
      h = await q.startHive(fx, { port: PORT, env: { CW_TEST_QUEUE_CRASH: 'afterAdvance' }, keepOptions: true })
      // Its process's end, seen as it happens (the page goes with it).
      const proc = h.app.process()
      let ended = false
      proc.once('exit', () => (ended = true))
      const reviewer = await q.agent(fx, h, 'R2')
      q.steer(fx, 'pass')
      // Approved: the queue merges it and Combwork ends as the target moves (a reply may not come back).
      crashed = await q.approve(fx, h, reviewer, 'Nine', { 'nine.txt': 'nine\n' }).catch(() => null)
      check('S33c: the card was approved', !!crashed)
      check('S33c: Combwork ended right after the advance', !!(await until(() => ended, HUNG_MS)))
    } catch (e) {
      check('no exception before the crash', false, e.stack)
    } finally {
      await h.app.close().catch(() => {})
    }
    if (crashed) {
      const afterCrash = q.head(fx)
      const queueRefs = () => lib.git(fx.alpha, ['for-each-ref', '--format=%(refname)', 'refs/hive/queue/']).split(/\r?\n/).filter(Boolean)
      const refsAtCrash = queueRefs()
      try {
        h = await q.startHive(fx, { port: PORT, keepOptions: true })
        const restartedDone = await until(async () => (await h.card(crashed.n))?.column === 'done', HUNG_MS)
        const integ = (await h.facts(crashed.n)).filter((f) => f.kind === 'Integrated')
        check('…restarted: Done, Integrated (observed) once, its result the target as the crash left it', !!restartedDone && integ.length === 1 && integ[0].data.result === afterCrash && q.head(fx) === afterCrash, JSON.stringify(integ))
        const crashedRef = `refs/hive/queue/${(await h.card(crashed.n)).key}`
        check("…its test merge's ref, there at the crash, dropped by the recovery", refsAtCrash.includes(crashedRef) && !!(await until(() => !queueRefs().includes(crashedRef), HUNG_MS)), JSON.stringify({ refsAtCrash, now: queueRefs() }))
      } catch (e) {
        check('no exception after the restart', false, e.stack)
      } finally {
        await h.app.close().catch(() => {})
      }
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
