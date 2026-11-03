// The merge queue on the card, in the Git tab and in the Merge dialog (#1357, SPEC §16.9.2-3, OP-13): a project set to
// "Hive merges" into `integration` (queueFixture.cjs), fake Claude Code agents acting by their own tokens.
// - a red check's return in the card's Work section: why (the check by name), its output's last lines, Show log
//   (its run's log), Retry merge; a conflict's return with its files;
// - Retry merge as the runtime allows it (HI-1667): once per revision after a return, asked so, then not offered and
//   why; none while a follow-up waits for its reviewer, and why; after Remove from queue, asked with no such limit;
// - the Git tab's Merge queue section: the queue now and its history (each card, revision, result or reason, when);
// - the Merge dialog on a branch whose card Hive merges: the card's queue state, Merge disabled with why, Merge
//   anyway (asks first) merging it and recorded on the card as an override;
// - the project's options switched to "The agent merges" while a card is in its checks: its Work section and the Git
//   tab's section still show it testing, then merged;
// - an advance into `main` checked out in the project folder stopped part way (#1351's crash seam), a listed file
//   edited after: the Work section shows the state (folder, branch, ref, each file and its side, no command) and the
//   For you request's "Show the files and commands" brings it into view.
// Screenshots of each, both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): BD is a 0.9 worktree agent on purpose (the Merge dialog on an agent's branch), and the slow
// and failing reads and the crash are test seams (HIVE_TEST_SLOW_IPC, _FAIL_IPC, _QUEUE_CRASH); the other cards'
// builders are on slots, as 1.0 has them.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47852))
const fx = q.queueProject('queuecard')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const f = q.folderHelpers(fx)

;(async () => {
  q.prepare(fx)
  let h = await q.startHive(fx, { port: PORT })
  let crew = null
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1400, height: 900 })
    await h.app.evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openPath = async (p) => (globalThis.__opened.push(p), '')
    })
    const opened = () => h.app.evaluate(() => globalThis.__opened)
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    const column = async (n) => (await h.card(n))?.column
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    const openCard = async (n) => {
      await q.showBoard(page)
      await q.openByTitle(page, n)
      await until(async () => (await dialog.count()) === 1, HUNG_MS)
      return dialog.locator('.card-work-queue')
    }
    const closeCard = async () => {
      await page.keyboard.press('Escape')
      await until(async () => (await dialog.count()) === 0, HUNG_MS)
    }
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const shoot = async (loc, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(fx.shots, `queuecard-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- A red check's return in the card's Work section.
    q.steer(fx, 'fail', 'unit broke on line 12')
    const red = await q.approve(fx, h, reviewer, 'Red', { 'red.txt': 'red\n' })
    check('a red check returns it', !!(await until(async () => (await column(red.n)) === 'doing', HUNG_MS)), JSON.stringify(await h.kinds(red.n)))
    let part = await openCard(red.n)
    const redText = await until(async () => {
      const t = await text(part)
      return /Returned .*checks failed: quick/.test(t) ? t : null
    }, HUNG_MS)
    check('Work section: returned, the check by name, its output\'s last lines', !!redText && /red: unit broke on line 12/.test(redText), redText ?? (await text(part)))
    check('…with Show log and Retry merge…', (await part.locator('[data-action="show-log"]').count()) === 1 && (await part.locator('[data-action="retry"]').count()) === 1)
    await part.locator('[data-action="show-log"]').click()
    check('…Show log opens its check\'s log', !!(await until(async () => ((await opened()) ?? []).some((p) => /\.log$/i.test(p)), HUNG_MS)), JSON.stringify(await opened()))
    await shoot(dialog.locator('.card-work'), 'returned-checks')
    await closeCard()

    // --- HI-1667: Retry merge as the runtime allows it. After a return, it asks with "Once per revision"; used for the
    // revision (returned again: the check still fails), it isn't offered again, and the Work section says why.
    part = await openCard(red.n)
    await part.locator('[data-action="retry"]').click()
    const onceAsk = page.locator('.dialog').filter({ hasText: 'Once per revision.' })
    check('Retry merge after a return: its confirmation says once per revision', !!(await until(async () => (await onceAsk.count()) === 1, HUNG_MS)))
    await onceAsk.getByRole('button', { name: 'Retry merge', exact: true }).click()
    const returnedTwice = async () => (await h.facts(red.n)).filter((x) => x.kind === 'IntegrationFailed').length === 2 && (await column(red.n)) === 'doing'
    check('…queued again, and returned again (its check still fails)', !!(await until(returnedTwice, HUNG_MS)), JSON.stringify(await h.kinds(red.n)))
    check('…Retry merge not offered again for the revision, and why', !!(await until(async () => (await part.locator('[data-retry-used]').count()) === 1, HUNG_MS)) && (await part.locator('[data-action="retry"]').count()) === 0, await text(part))
    await shoot(dialog.locator('.card-work'), 'retry-used')
    await closeCard()

    // In Approved, taken out of the queue for a follow-up that waits for its reviewer: not offered (the runtime refuses
    // it), and why. Once the reviewer has checked it and it is taken out by Remove from queue, Retry merge asks with no
    // once-per-revision limit (none applies there). The queue is paused meanwhile, so the card stays in Approved.
    q.steer(fx, 'pass')
    await inv('queue:pause', fx.alpha, 'integration')
    const held = await q.approve(fx, h, reviewer, 'Held', { 'held.txt': 'held\n' })
    check('a card approved while the queue is paused waits in Approved, queued', !!(await until(async () => (await column(held.n)) === 'passed' && (await h.kinds(held.n)).includes('IntegrationRequested'), HUNG_MS)), JSON.stringify(await h.kinds(held.n)))
    const fu = await q.intent(h, held.builder, held.n, 'loop-step', { step: 'followUp', text: 'One more screenshot.' })
    const outFor = async (reason) => (await h.facts(held.n)).some((x) => x.kind === 'IntegrationCancelled' && x.data?.reason === reason)
    check('its builder posts a follow-up: taken out of the queue for it', fu.status === 200 && !!(await until(() => outFor('followUp'), HUNG_MS)), JSON.stringify(fu.body))
    part = await openCard(held.n)
    check('Work section: no Retry merge while the follow-up waits for its reviewer, and why', !!(await until(async () => (await part.locator('[data-retry-waits="followUp"]').count()) === 1, HUNG_MS)) && (await part.locator('[data-action="retry"]').count()) === 0, await text(part))
    await shoot(dialog.locator('.card-work'), 'retry-waits')
    await closeCard()
    // The follow-up's id, as its reply names it: its card's key and the LoopStep fact's seq.
    const posted = (await h.facts(held.n)).findLast((x) => x.kind === 'LoopStep' && x.data?.step === 'followUp')
    const ok = await q.intent(h, reviewer, held.n, 'loop-step', { step: 'ok', text: 'Checked.', design: `${(await h.card(held.n)).key}/s${posted?.seq}` })
    check('…its reviewer checks it: queued again', ok.status === 200 && !!(await until(async () => (await h.facts(held.n)).filter((x) => x.kind === 'IntegrationRequested').length === 2, HUNG_MS)), JSON.stringify(ok.body))
    await inv('queue:remove', held.n, '')
    check('…then Remove from queue: in Approved, taken out', !!(await until(() => outFor('removed'), HUNG_MS)) && (await column(held.n)) === 'passed')
    part = await openCard(held.n)
    check('…Retry merge offered again', !!(await until(async () => (await part.locator('[data-action="retry"]').count()) === 1, HUNG_MS)), await text(part))
    await part.locator('[data-action="retry"]').click()
    const approvedAsk = page.locator('.dialog').filter({ hasText: 'This queues' })
    check('…and it asks with no once-per-revision limit', !!(await until(async () => (await approvedAsk.count()) === 1, HUNG_MS)) && !/Once per revision/.test(await text(approvedAsk)), await text(approvedAsk))
    await approvedAsk.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await approvedAsk.count()) === 0, HUNG_MS)
    await closeCard()
    await inv('queue:resume', fx.alpha, 'integration')

    // --- A conflict's return, with its files: One merges a line, Two changes the same line from the same base.
    q.steer(fx, 'pass')
    // One is approved and merged once Two's line is made (a line is made from the target's head).
    let one = null
    const two = await q.approve(fx, h, reviewer, 'Two', { 'a.txt': 'one\nTWO by two\nthree\n' }, {
      afterStart: async () => {
        one = await q.approve(fx, h, reviewer, 'One', { 'a.txt': 'one\nTWO by one\nthree\n' })
        check('One is merged', !!(await until(async () => (await column(one.n)) === 'done', HUNG_MS)))
      }
    })
    check('Two is returned: a conflict', !!(await until(async () => (await column(two.n)) === 'doing', HUNG_MS)))
    part = await openCard(two.n)
    const conflict = await until(async () => {
      const t = await text(part)
      return /conflict in a\.txt/.test(t) && /Files in conflict a\.txt/.test(t) ? t : null
    }, HUNG_MS)
    check('Work section: a conflict, with its files', !!conflict, await text(part))
    await shoot(dialog.locator('.card-work'), 'returned-conflict')
    await closeCard()

    // --- The Git tab's Merge queue section: the queue now and its history.
    const toGit = async () => {
      await page.getByRole('button', { name: 'Projects' }).click()
      await page.getByText('alpha', { exact: true }).first().click()
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
    }
    await toGit()
    await page.locator('.git-sections [data-section="queue"]').click()
    const section = page.locator('.git-queue')
    const history = section.locator('.git-queue-target[data-target="integration"] .git-queue-table')
    const rows = await until(async () => ((await history.locator('tbody tr').count()) >= 3 ? history.locator('tbody tr') : null), HUNG_MS)
    // Each row a line (#1641): a short outcome, its detail (the merge commit, why it was returned) the outcome's tooltip.
    const outcomes = async () => (await history.locator('[data-outcome]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-outcome')} ${e.textContent.trim()} | ${e.getAttribute('title')}`))).join('\n')
    const historyText = `${await text(history)}\n${await outcomes()}`
    check('Git tab: the queue card and its history, newest first: Two returned, One merged, Red returned', !!rows && (await section.locator('.progress-queue-card').count()) === 1 && /Returned \| Returned: conflict in a\.txt/.test(historyText) && /Merged \| Merged as \w+/.test(historyText) && /checks failed: quick/.test(historyText) && historyText.indexOf((await h.card(two.n)).key) < historyText.indexOf((await h.card(one.n)).key), historyText)
    check('…each with its revision, the merged one with its merge commit', (await history.locator('tbody tr').nth(0).locator('code').count()) === 1 && (await history.locator('tbody tr').filter({ has: page.locator('[data-outcome="merged"]') }).locator('code').count()) === 2, await text(history))
    const heights = await history.locator('tbody tr').evaluateAll((trs) => trs.map((r) => r.getBoundingClientRect().height))
    check('…one line a row: every row as tall as the others', heights.length >= 3 && Math.max(...heights) - Math.min(...heights) < 2, JSON.stringify(heights))
    await shoot(section, 'git-section')
    // At the window's narrowest (900 wide), still a line a row: the title gives way, the hashes never wrap.
    await lib.fitWindow(h.app, page, { width: 900, height: 700 })
    const narrow = await until(async () => {
      const hs = await history.locator('tbody tr').evaluateAll((trs) => trs.map((r) => r.getBoundingClientRect().height))
      const codes = await history.locator('tbody code:visible').evaluateAll((cs) => cs.map((c) => c.getClientRects().length))
      const wrap = history.locator('.table-wrap')
      const fits = await wrap.evaluate((w) => w.scrollWidth <= w.clientWidth + 1)
      return hs.length >= 3 && Math.max(...hs) - Math.min(...hs) < 2 && codes.length >= 3 && codes.every((n) => n === 1) && fits ? { hs, codes } : null
    }, HUNG_MS)
    check('…and at the narrowest window: a line a row, each hash on one line, no sideways scroll (the merge commit left to the tooltip)', !!narrow, JSON.stringify(narrow))
    await shoot(section, 'git-section-narrow')
    await lib.fitWindow(h.app, page, { width: 1400, height: 900 })

    // --- Old rules: the options switch to the agent merging while a card is in its checks.
    q.steer(fx, 'wait')
    const LATE_TITLE = 'Late, with a title long enough to run past the history’s Title column, so it is cut short and its tooltip has it whole'
    const late = await q.approve(fx, h, reviewer, LATE_TITLE, { 'late.txt': 'late\n' })
    check('Late is approved', Object.values(late.steps).every((x) => x.status === 200), JSON.stringify(late.steps))
    const lateKey = (await h.card(late.n)).key
    await until(async () => fs.existsSync(fx.started), HUNG_MS)
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', mergeChecks: [] }) })
    part = await openCard(late.n)
    check('old rules: its Work section still shows it testing', !!(await until(async () => /Testing now: check: quick/.test(await text(part)), HUNG_MS)), await text(part))
    await closeCard()
    await toGit()
    check('…and the Git tab\'s section too', !!(await until(async () => (await text(section)).includes(`${lateKey} + integration`), HUNG_MS)), await text(section))
    fs.writeFileSync(fx.go, 'go')
    check('…through to its outcome: merged', !!(await until(async () => (await column(late.n)) === 'done', HUNG_MS)))
    check('…the Git tab\'s history has it merged', !!(await until(async () => (await history.locator('tbody tr', { hasText: lateKey }).locator('[data-outcome="merged"]').count()) === 1, HUNG_MS)), await text(history))
    const lateTitle = history.locator('tbody tr', { hasText: lateKey }).locator('.git-queue-title')
    const cut = await lateTitle.evaluate((e) => ({ cut: e.scrollWidth > e.clientWidth, tip: e.getAttribute('title'), rows: e.closest('tr').getClientRects()[0].height }))
    check('…its long title cut short on one line, whole in its tooltip', cut.cut && cut.tip === LATE_TITLE && cut.rows < 50, JSON.stringify(cut))
    // A history taller than its box (20 rows a page): the headings and filters stay in view down to the last row. The
    // box made short here stands in for the rows.
    const wrap = history.locator('.table-wrap')
    await wrap.evaluate((w) => {
      w.style.maxHeight = '120px'
      w.scrollTop = w.scrollHeight
    })
    const sticky = await until(async () => {
      const r = await wrap.evaluate((w) => {
        const box = w.getBoundingClientRect()
        const head = w.querySelector('thead').getBoundingClientRect()
        const last = [...w.querySelectorAll('tbody tr')].pop().getBoundingClientRect()
        return { scrolled: w.scrollTop > 0, headTop: head.top - box.top, lastBottom: box.bottom - last.bottom, lastBelowHead: last.top >= head.bottom - 1 }
      })
      return r.scrolled && Math.abs(r.headTop) < 2 && r.lastBottom >= -1 && r.lastBelowHead ? r : null
    }, HUNG_MS)
    check('…scrolled to its last row, the headings and filters stay at the top', !!sticky, JSON.stringify(sticky))
    await shoot(section.locator('.git-queue-history'), 'git-history-scrolled')
    await wrap.evaluate((w) => {
      w.style.maxHeight = ''
      w.scrollTop = 0
    })
    part = await openCard(late.n)
    check('…its Work section: merged (the merge line), no queue part left', !!(await until(async () => /Merged into integration as/.test(await text(dialog.locator('.card-work'))) && (await part.count()) === 0, HUNG_MS)), await text(dialog.locator('.card-work')))
    await closeCard()
    // --- The Merge dialog on a branch whose card Hive merges (the options back to Hive merging).
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    const dee = await q.agent(fx, h, 'BD', { worktree: true })
    const d = (await inv('tasks:create', { title: 'Dee', project: 'alpha' })).number
    await q.intent(h, dee, d, 'start')
    fs.writeFileSync(path.join(dee.folder, 'dee.txt'), 'dee\n')
    lib.git(dee.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(dee.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'Dee'])
    await page.getByRole('button', { name: 'Projects' }).click()
    await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
    const merge = page.locator('.dialog', { hasText: "Merge BD's work" })
    const note = merge.locator('.merge-queue-note:not([data-queue-lookup])')
    const primary = merge.locator('[data-action="merge"]')
    const anyway = merge.locator('[data-action="merge-anyway"]')
    const deeKey = (await h.card(d)).key
    const openMerge = async () => {
      await lib.agentMenu(page, 'BD')
      await page.locator('.menu-item', { hasText: 'Merge…' }).click()
      await until(async () => (await merge.count()) === 1, HUNG_MS)
    }
    // While the card's queue is still being read (HR3's round 1 finding 1): Merge stays off, nothing says Hive merges.
    await h.app.evaluate(() => (process.env.HIVE_TEST_SLOW_IPC = 'worktrees:branchCards=4000*1'))
    await openMerge()
    const branchRead = async () => !!(await merge.locator('code').count()) && /Merges 1 commit/.test(await text(merge))
    check('Merge dialog, its card still being read: the branch read, Merge off, no note yet', !!(await until(branchRead, HUNG_MS)) && (await primary.isDisabled()) && (await note.count()) === 0 && (await anyway.count()) === 0, await text(merge))
    check('…then the note, Merge still off', !!(await until(async () => (await note.count()) === 1 && (await primary.isDisabled()), HUNG_MS)), await text(merge))
    await merge.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await merge.count()) === 0, HUNG_MS)
    // Its read failing: said, Merge off, Retry reads it again.
    await h.app.evaluate(() => {
      delete process.env.HIVE_TEST_SLOW_IPC
      process.env.HIVE_TEST_FAIL_IPC = 'worktrees:branchCards*1'
    })
    await openMerge()
    const failedNote = merge.locator('[data-queue-lookup="failed"]')
    check('…its card unread (the read failed): said, Merge off, no Merge anyway', !!(await until(async () => (await failedNote.count()) === 1 && (await branchRead()), HUNG_MS)) && (await primary.isDisabled()) && (await anyway.count()) === 0, await text(merge))
    await h.app.evaluate(() => delete process.env.HIVE_TEST_FAIL_IPC)
    await failedNote.getByRole('button', { name: 'Retry' }).click()
    // A plain merge of it is refused by main too, whatever a dialog thinks (a stale or pending state).
    const plain = await inv('agents:merge', fx.alpha, dee.id, { squash: false, message: 'plain', cleanup: false }).then(() => 'merged', (e) => String(e?.message ?? e))
    check('…and a plain merge of the branch is refused, saying Combwork merges it', new RegExp(`Combwork merges ${deeKey} through the merge queue`).test(plain) && !lib.git(fx.alpha, ['log', '--format=%s', 'main']).includes('plain'), plain)
    check('Merge dialog: the card Combwork merges, not in the queue yet', !!(await until(async () => (await note.count()) === 1 && new RegExp(`Combwork merges ${deeKey} through the merge queue`).test(await note.innerText()) && /once it is approved/.test(await note.innerText()), HUNG_MS)), await text(merge))
    check('…Merge disabled, plainly (not the primary action), Merge anyway offered', !!(await until(async () => (await primary.isDisabled()) && !(await primary.evaluate((el) => el.classList.contains('primary'))) && (await anyway.count()) === 1 && !(await anyway.isDisabled()), HUNG_MS)))
    const heldTip = await lib.hoverTip(page, merge.locator('.tip-wrap:has([data-action="merge"])'), (t) => /through the merge queue/.test(t), HUNG_MS)
    check("…its reason in Merge's tooltip", new RegExp(`Combwork merges ${deeKey} through the merge queue`).test(heldTip), heldTip)
    await page.mouse.move(5, 5)
    await shoot(merge, 'merge-dialog')
    await anyway.click()
    const ask = page.locator('.dialog', { hasText: `Merge ${deeKey} outside the merge queue?` })
    check('Merge anyway asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)))
    await ask.getByRole('button', { name: 'Merge anyway' }).click()
    const override = await until(async () => (await h.facts(d)).find((x) => x.kind === 'Override' && x.data.move === 'merge outside the queue') ?? null, HUNG_MS)
    check('…merged, and recorded on the card as an override, the user\'s', !!override && override.data.by === 'user' && lib.git(fx.alpha, ['log', '--format=%s', 'main']).includes('BD: work from'), JSON.stringify(override))

    // A crew for the crash part: a builder building its card on the slot its start lends, rejoined in each run after.
    crew = { builder: await q.agent(fx, h, 'CB'), reviewer }
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }

  // --- Needs you: an advance into main, checked out in the project folder, stopped part way (#1351's crash seam), a
  // listed file edited after; the Work section shows the state, and For you's request brings it into view.
  if (crew) {
    try {
      h = await q.startHive(fx, { port: PORT, keepOptions: true, env: { HIVE_TEST_QUEUE_CRASH: 'afterFiles' } })
      await h.inv('workflow:setOptions', fx.alpha, { preset: null, options: f.options() })
      await h.inv('advanced:set', 'hive.queue.checkedOutTarget', 'auto')
      crew = { builder: await q.rejoin(fx, h, crew.builder), reviewer: await q.rejoin(fx, h, crew.reviewer) }
      let ended = false
      h.app.process().once('exit', () => (ended = true))
      q.steer(fx, 'pass')
      const steps = await q.approveBy(fx, h, crew.builder, crew.reviewer, 'Card stuck', { 'stuck.txt': 'stuck\n' }).then((r) => r.steps, (e) => String(e?.message ?? e))
      check('needs you: Combwork ended at the seam', !!(await until(() => ended, HUNG_MS)), JSON.stringify(steps))
      await h.app.close().catch(() => {})
      fs.writeFileSync(path.join(fx.alpha, 'stuck.txt'), 'edited after the crash\n')
      h = await q.startHive(fx, { port: PORT, keepOptions: true })
      const { page, inv } = h
      page.on('pageerror', (e) => check('no page errors (needs you)', false, e.message))
      await lib.fitWindow(h.app, page, { width: 1400, height: 900 })
      const c = await until(() => f.byTitle(h, 'Card stuck'), HUNG_MS)
      const st = await until(async () => (await inv('queue:list', fx.alpha, 'main'))[0]?.paused?.stuck ?? null, HUNG_MS)
      check('the restart pauses the queue: needs you, the state recorded', !!st && st.files.some((x) => x.path === 'stuck.txt'), JSON.stringify(st))
      const item = await until(async () => (await inv('tasks:forYou')).items?.find((i) => i.card === c.number && i.gate === 'queueStuck'), HUNG_MS)
      check('…For you asks, its text counting the files and naming the Work section (agents read it in English)', /with 1 file left between the two/.test(item?.text ?? '') && /Work section lists each file/.test(item?.text ?? ''), item?.text)
      const { dialog, section } = await f.forYouSection(h, c.number)
      const show = section.locator('[data-action="show-stuck"]')
      check('…its request offers Show the files and commands', !!(await until(async () => (await show.count()) === 1, HUNG_MS)))
      const stuck = dialog.locator('.card-work-queue-stuck')
      const stuckText = await until(async () => {
        const t = ((await stuck.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
        return /stopped part way/.test(t) ? t : null
      }, HUNG_MS)
      check('Work section: the folder, its branch, where main is, before and the merge, each file and its side, no command', !!stuckText && /Folder/.test(stuckText) && /Its branch main/.test(stuckText) && /main is at/.test(stuckText) && /1 file, and where it is stuck\.txt neither/.test(stuckText) && /put them right by hand/.test(stuckText), stuckText)
      // The Work section folded (HR3's round 1 finding 2): the link opens it, then brings the state into view.
      await dialog.locator('.task-section-h', { hasText: 'Work' }).click()
      check('…the Work section folded: its state not shown', !!(await until(async () => (await stuck.count()) === 0, HUNG_MS)))
      await show.click()
      const inView = () =>
        stuck.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const d = el.closest('.dialog')?.getBoundingClientRect()
          return !!d && r.top >= d.top - 1 && r.top < d.bottom
        })
      check('…Show the files and commands opens it and brings them into view', !!(await until(async () => (await stuck.count()) === 1 && (await inView()), HUNG_MS)))
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await section.screenshot({ path: path.join(fx.shots, `queuecard-needsyou-request-${theme}.png`) })
        await dialog.locator('.card-work').screenshot({ path: path.join(fx.shots, `queuecard-needsyou-work-${theme}.png`) })
      }
      await page.keyboard.press('Escape')
      // Settled by hand and answered: the queue looks again and finishes it.
      lib.git(fx.alpha, ['checkout', '--', 'stuck.txt'])
      await inv('tasks:answer', c.number, item.request, { outcome: 'answered', reply: 'put back' })
      check('…settled and answered: merged', !!(await until(async () => (await h.card(c.number))?.column === 'done', HUNG_MS)))
      await h.app.close().catch(() => {})

      // --- A stopped advance with commands (HR3's round 1 finding 3): Hive ended after the advance began, before it
      // touched the files; the merge then put into the folder by hand (its files as merged, main where it was). The
      // journal says nothing was touched, the files say otherwise: §16.9.2's terminal state, with the command that
      // finishes it (main moved to the merge) and the one that undoes it (the files put back). Neither is run.
      h = await q.startHive(fx, { port: PORT, keepOptions: true, env: { HIVE_TEST_QUEUE_CRASH: 'afterStarted' } })
      crew = { builder: await q.rejoin(fx, h, crew.builder), reviewer: await q.rejoin(fx, h, crew.reviewer) }
      let ended2 = false
      h.app.process().once('exit', () => (ended2 = true))
      const steps2 = await q.approveBy(fx, h, crew.builder, crew.reviewer, 'Card cmd', { 'cmd.txt': 'cmd\n' }).then((r) => r.steps, (e) => String(e?.message ?? e))
      check('commands: Combwork ended once the advance began, before the files', !!(await until(() => ended2, HUNG_MS)), JSON.stringify(steps2))
      await h.app.close().catch(() => {})
      const expected = q.head(fx, 'main')
      const result = lib.git(fx.alpha, ['for-each-ref', '--format=%(objectname)', 'refs/hive/queue/']).trim().split(String.fromCharCode(10))[0].trim()
      lib.git(fx.alpha, ['read-tree', '-m', '-u', expected, result])
      check('…the merge put into the folder by hand, main where it was', f.text('cmd.txt') === 'cmd\n' && q.head(fx, 'main') === expected)
      h = await q.startHive(fx, { port: PORT, keepOptions: true })
      const p2 = h.page
      p2.on('pageerror', (e) => check('no page errors (commands)', false, e.message))
      await lib.fitWindow(h.app, p2, { width: 1400, height: 900 })
      // The clipboard stubbed in the page (never the real one): what Copy writes, recorded.
      await p2.evaluate(() => {
        window.__copied = []
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => void window.__copied.push(t), readText: async () => '' } })
      })
      const c2 = await until(() => f.byTitle(h, 'Card cmd'), HUNG_MS)
      const st2 = await until(async () => {
        const s = (await h.inv('queue:list', fx.alpha, 'main'))[0]?.paused?.stuck
        return s?.commands?.length ? s : null
      }, HUNG_MS)
      const finish = st2?.commands.find((x) => x.purpose === 'finish')
      const undo = st2?.commands.find((x) => x.purpose === 'undo')
      check('the restart pauses the queue: needs you, with a command to finish it and one to undo it', !!finish && !!undo && finish.place === 'project' && undo.place === 'folder' && st2.files.every((x) => x.side === 'result'), JSON.stringify({ st2, result, paused: (await h.inv('queue:list', fx.alpha, 'main'))[0]?.paused, main: q.head(fx, 'main') }))
      const s2 = await f.forYouSection(h, c2.number)
      const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
      const work2 = s2.dialog.locator('.card-work-queue-stuck')
      const rows = work2.locator('.card-work-queue-command')
      check('Work section: both commands, as Combwork gives them, each with where to run it', !!(await until(async () => (await rows.count()) === 2, HUNG_MS)) && (await rows.locator('code').allInnerTexts()).join('\n') === [finish.command, undo.command].join('\n') && (await text(rows.first().locator('.faint'))).endsWith('To finish it, in alpha') && (await text(rows.nth(1).locator('.faint'))).endsWith('To undo it, in alpha') && (await rows.first().locator('.faint').getAttribute('title')) === fx.alpha && (await rows.nth(1).locator('.faint').getAttribute('title')) === st2.folder, await text(work2))
      await rows.first().getByRole('button', { name: 'Copy the command to finish it' }).click()
      await rows.nth(1).getByRole('button', { name: 'Copy the command to undo it' }).click()
      const copied = await until(async () => {
        const v = await p2.evaluate(() => window.__copied)
        return v?.length === 2 ? v : null
      }, HUNG_MS)
      check('…Copy copies each exactly', JSON.stringify(copied) === JSON.stringify([finish.command, undo.command]), JSON.stringify(copied))
      check('…and nothing ran them: main where it was, the files as merged by hand', q.head(fx, 'main') === expected && f.text('cmd.txt') === 'cmd\n')
      for (const theme of ['dark', 'light']) {
        await h.inv('settings:update', { appearance: { theme } })
        await until(async () => (await p2.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await p2.mouse.move(5, 5)
        await work2.screenshot({ path: path.join(fx.shots, `queuecard-needsyou-commands-${theme}.png`) })
      }
    } catch (e) {
      check('no exception (needs you)', false, e.stack)
    } finally {
      await h.app.close().catch(() => {})
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
