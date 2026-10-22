// The merge queue on the card, in the Git tab and in the Merge dialog (#1357, SPEC §16.9.2-3, OP-13): a project set to
// "Hive merges" into `integration` (queueFixture.cjs), fake Claude Code agents acting by their own tokens.
// - a red check's return in the card's Work section: why (the check by name), its output's last lines, Show log
//   (its run's log), Retry merge; a conflict's return with its files;
// - the Git tab's Merge queue section: the queue now and its history (each card, revision, result or reason, when);
// - the Merge dialog on a branch whose card Hive merges: the card's queue state, Merge disabled with why, Merge
//   anyway (asks first) merging it and recorded on the card as an override;
// - the project's options switched to "The agent merges" while a card is in its checks: its Work section and the Git
//   tab's section still show it testing, then merged;
// - an advance into `main` checked out in the project folder stopped part way (#1351's crash seam), a listed file
//   edited after: the Work section shows the state (folder, branch, ref, each file and its side, no command) and the
//   For you request's "Show the files and commands" brings it into view.
// Screenshots of each, both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
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
      await page.getByRole('button', { name: 'Task Board' }).click()
      await page.locator(`.task-card[data-task="${n}"]`).click()
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

    // --- A conflict's return, with its files: One merges a line, Two changes the same line from the same base.
    q.steer(fx, 'pass')
    const one = await q.approve(fx, h, reviewer, 'One', { 'a.txt': 'one\nTWO by one\nthree\n' })
    check('One is merged', !!(await until(async () => (await column(one.n)) === 'done', HUNG_MS)))
    const two = await q.approve(fx, h, reviewer, 'Two', { 'a.txt': 'one\nTWO by two\nthree\n' })
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
      await page.locator('.tabs .tab', { hasText: 'Git' }).first().click()
    }
    await toGit()
    await page.locator('.git-sections [data-section="queue"]').click()
    const section = page.locator('.git-queue')
    const history = section.locator('.git-queue-target[data-target="integration"] .git-queue-table')
    const rows = await until(async () => ((await history.locator('tbody tr').count()) >= 3 ? history.locator('tbody tr') : null), HUNG_MS)
    const historyText = await text(history)
    check('Git tab: the queue card and its history, newest first: Two returned, One merged, Red returned', !!rows && (await section.locator('.progress-queue-card').count()) === 1 && /Returned: conflict in a\.txt/.test(historyText) && /Merged as/.test(historyText) && /checks failed: quick/.test(historyText) && historyText.indexOf((await h.card(two.n)).key) < historyText.indexOf((await h.card(one.n)).key), historyText)
    check('…each with its revision', (await history.locator('tbody tr code').count()) >= 3)
    await shoot(section, 'git-section')

    // --- Old rules: the options switch to the agent merging while a card is in its checks.
    q.steer(fx, 'wait')
    const late = await q.approve(fx, h, reviewer, 'Late', { 'late.txt': 'late\n' })
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
    check('…the Git tab\'s history has it merged', !!(await until(async () => new RegExp(`${lateKey}.*Merged as`).test(await text(history)), HUNG_MS)), await text(history))
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
    await lib.agentMenu(page, 'BD')
    await page.locator('.menu-item', { hasText: 'Merge…' }).click()
    const merge = page.locator('.dialog', { hasText: "Merge BD's work" })
    const note = merge.locator('.merge-queue-note')
    const deeKey = (await h.card(d)).key
    check('Merge dialog: the card Hive merges, not in the queue yet', !!(await until(async () => (await note.count()) === 1 && new RegExp(`Hive merges ${deeKey} through the merge queue`).test(await note.innerText()) && /once it is approved/.test(await note.innerText()), HUNG_MS)), await text(merge))
    const primary = merge.locator('.btn.primary', { hasText: 'Merge' })
    const anyway = merge.locator('[data-action="merge-anyway"]')
    check('…Merge disabled, Merge anyway offered', !!(await until(async () => (await primary.isDisabled()) && (await anyway.count()) === 1 && !(await anyway.isDisabled()), HUNG_MS)))
    await shoot(merge, 'merge-dialog')
    await anyway.click()
    const ask = page.locator('.dialog', { hasText: `Merge ${deeKey} outside the merge queue?` })
    check('Merge anyway asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)))
    await ask.getByRole('button', { name: 'Merge anyway' }).click()
    const override = await until(async () => (await h.facts(d)).find((x) => x.kind === 'Override' && x.data.move === 'merge outside the queue') ?? null, HUNG_MS)
    check('…merged, and recorded on the card as an override, the user\'s', !!override && override.data.by === 'user' && lib.git(fx.alpha, ['log', '--format=%s', 'main']).includes('BD: work from'), JSON.stringify(override))

    // A crew for the crash part: a builder in its worktree, rejoined in each run after.
    crew = { builder: await q.agent(fx, h, 'CB', { worktree: true }), reviewer }
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
      await q.approveBy(fx, h, crew.builder, crew.reviewer, 'Card stuck', { 'stuck.txt': 'stuck\n' }).catch(() => null)
      check('needs you: Hive ended at the seam', !!(await until(() => ended, HUNG_MS)))
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
      await show.click()
      check('…Show the files and commands brings them into view', !!(await until(() => stuck.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const d = el.closest('.dialog')?.getBoundingClientRect()
        return !!d && r.top >= d.top - 1 && r.top < d.bottom
      }), HUNG_MS)))
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await section.screenshot({ path: path.join(fx.shots, `queuecard-needsyou-request-${theme}.png`) })
        await dialog.locator('.card-work').screenshot({ path: path.join(fx.shots, `queuecard-needsyou-work-${theme}.png`) })
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
