// The board shows stages (#1420, SPEC §16.5.2): a Pair project (Hive merges, queueFixture.cjs) beside a No review Git
// project (beta) and a None one (notes), with fake Claude Code agents acting by their own tokens and the Assistant off.
// - a card in the merge queue sits in Merging, a column of its own under Approved's heading, and moves to Done merged;
// - Merging takes no drop, and its hover says cards come through the queue;
// - a No review project shows On Hold, Todo, Active and Done only;
// - the options changed to No review while a card is in Review: Review stays until the card leaves it;
// - a rename shows on the board (one project), the default name with two projects naming it differently, each card's
//   hover its own project's name;
// - "Workflow: Git · …" in the toolbar opens Version Control → Workflow; a line per project with all of them;
// - a None project beside the Git ones.
// Screenshots in both themes, English and Polish. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47857))
const fx = q.queueProject('boardstages')
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 200)

;(async () => {
  q.prepare(fx)
  // beta: Git with no review (Committed is done, the project folder); notes: no version control.
  const beta = path.join(fx.ws, 'beta')
  const notes = path.join(fx.ws, 'notes')
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.hive/\n' })
  fs.mkdirSync(path.join(beta, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(beta, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: { review: 'none', finish: 'committed', folder: 'project' } } }))
  fs.mkdirSync(path.join(notes, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(notes, 'plan.md'), '# Plan\n')
  fs.writeFileSync(path.join(notes, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [], workflow: { platform: 'none', preset: null, options: {} } }))
  const h = await q.startHive(fx, { port: PORT })
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    const board = page.locator('.board')
    const col = (id) => board.locator(`.board-column[data-column="${id}"]`)
    const label = (id) => col(id).locator('.board-column-header .board-column-label')
    const labelText = async (id) => ((await label(id).count()) ? ((await label(id).textContent()) ?? '') : '')
    const tile = (n) => board.locator(`.task-card[data-task="${n}"]`)
    const inColumn = async (n, id) => (await col(id).locator(`.task-card[data-task="${n}"]`).count()) === 1
    const columns = () => board.locator('.board-column').evaluateAll((els) => els.map((e) => e.getAttribute('data-column')).join(' '))
    // The board with its sidebar (the activity bar's button toggles the sidebar when the board is shown already).
    const showBoard = async (project, button = 'Task Board') => {
      const row = page.locator('.pane-body .row', { hasText: project ?? 'All projects' }).first()
      await until(async () => {
        if ((await row.count()) && (await board.count())) return true
        await page.getByRole('button', { name: button }).click()
        return (await row.count()) > 0 && (await board.count()) > 0
      })
      await row.click()
    }
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(fx.shots, `boardstages-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- The stages each project's options produce.
    const ids = async (p) => (await inv('workflow:stages', p))?.stages.map((s) => s.id).join(' ')
    check('alpha (Hive merges) has every stage', (await ids(fx.alpha)) === 'hold todo active review approved merging done', await ids(fx.alpha))
    check('beta (No review) has On Hold, Todo, Active and Done', (await ids(beta)) === 'hold todo active done', await ids(beta))
    check('notes (None) has On Hold, Todo, Active and Done', (await ids(notes)) === 'hold todo active done', await ids(notes))

    // --- A card in the merge queue sits in Merging under Approved, then Done.
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    q.steer(fx, 'wait')
    const queued = await q.approve(fx, h, reviewer, 'Queued', { 'queued.txt': 'queued\n' })
    check('the card is approved and queued', queued.steps.verdict.status === 200, JSON.stringify(queued.steps))
    const notesCard = (await inv('tasks:create', { title: 'Write the plan', project: 'notes' })).number
    await showBoard(null)
    check('the queued card sits in Merging', !!(await until(async () => inColumn(queued.n, 'merging'))), await columns())
    const approvedGroup = board.locator('.board-category[data-category="passed"]')
    check('Merging and Approved share one Approved heading', (await approvedGroup.locator('.board-category-head').textContent()) === 'Approved' && (await approvedGroup.locator('.board-column').evaluateAll((e) => e.map((x) => x.getAttribute('data-column')).join(' '))) === 'passed merging')
    check('each column named by its stage', (await labelText('passed')) === 'Approved' && (await labelText('merging')) === 'Merging', `${await labelText('passed')} / ${await labelText('merging')}`)
    check('every category shows with all projects (the union)', (await columns()) === 'hold todo doing review passed merging done', await columns())
    check("the None project's card is on the board", await inColumn(notesCard, 'todo'))
    await shoot('merging-en')

    // Merging's hover, and no drop.
    await label('merging').hover()
    const tip = page.locator('.tip', { hasText: 'merge queue' })
    check("Merging's hover says cards come through the merge queue", !!(await until(async () => (await tip.count()) > 0)))
    const loose = (await inv('tasks:create', { title: 'Loose', project: 'alpha' })).number
    await until(async () => (await tile(loose).count()) === 1)
    // The drag as the window's events (Merging never takes the drop, so a pointer drag would wait for one).
    const refused = await page.evaluate((n) => {
      const from = document.querySelector(`.board .task-card[data-task="${n}"]`)
      const into = document.querySelector('.board .board-column[data-column="merging"] .board-column-body')
      const dt = new DataTransfer()
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
      into.dispatchEvent(over)
      into.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      // Not taken: its dragover isn't cancelled, so the drag shows it can't go there.
      return !over.defaultPrevented
    }, loose)
    check('Merging refuses the drop (its dragover is not taken)', refused)
    // A later change the board shows: after it, the dropped card's move (if any) would have landed too.
    const sentinel = (await inv('tasks:create', { title: 'Sentinel', project: 'alpha' })).number
    await until(async () => (await tile(sentinel).count()) === 1)
    check('a drop into Merging moves nothing', (await h.card(loose))?.column === 'todo' && (await inColumn(loose, 'todo')))

    // --- Archive All in Approved takes Approved's cards only, never Merging's (HR2's round 1): a card waiting for your OK
    // (labelled ui) in Approved beside the queued one in Merging.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { okBefore: { mode: 'labels', labels: ['ui'] } }) })
    const okCard = (await inv('tasks:create', { title: 'Needs your OK', project: 'alpha', labels: ['ui'] })).number
    const okBuilder = await q.agent(fx, h, 'B7', { worktree: true })
    await q.intent(h, okBuilder, okCard, 'start')
    fs.writeFileSync(path.join(okBuilder.folder, 'ok.txt'), 'ok\n')
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'ok'])
    await q.intent(h, okBuilder, okCard, 'submit', { summary: 'ready' })
    await q.intent(h, reviewer, okCard, 'start-review')
    await q.intent(h, reviewer, okCard, 'verdict', { pass: true, comment: 'ok' })
    check('a card waiting for your OK sits in Approved, beside the queued one in Merging', !!(await until(async () => (await inColumn(okCard, 'passed')) && (await inColumn(queued.n, 'merging')))), await columns())
    const item = (text) => page.locator('.menu .menu-item', { hasText: text })
    await col('passed').getByRole('button', { name: 'Approved: more' }).click()
    check("Approved's menu: Archive All in Approved (1)…, its own card only", !!(await until(async () => (await item('Archive All in Approved (1)…').count()) === 1)), JSON.stringify(await page.locator('.menu .menu-item').allTextContents()))
    await item('Archive All in Approved (1)…').click()
    const archiveDialog = page.locator('.dialog', { has: page.locator('.archive-all') })
    check('…which asks for one card in Approved', !!(await until(async () => (await archiveDialog.count()) === 1)) && /Archive 1 card in Approved\?/.test(await archiveDialog.innerText()), await archiveDialog.innerText().catch(() => ''))
    // Your OK while it is open: the card goes on to Merging; archiving Approved then leaves it there.
    const ask = (await inv('tasks:forYou', 'alpha')).items.find((i) => i.card === okCard)
    await inv('tasks:answer', okCard, ask.request, { outcome: 'approved' })
    check('…the OK moves it to Merging while the dialog is open', !!(await until(async () => inColumn(okCard, 'merging'))))
    const confirm = archiveDialog.getByRole('button', { name: /^Archive/ })
    if (await confirm.isEnabled().catch(() => false)) await confirm.click()
    else await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await archiveDialog.count()) === 0)
    check('…and nothing in Merging is archived', (await h.card(okCard))?.archived === false && (await h.card(queued.n))?.archived === false)
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })

    fs.writeFileSync(fx.go, 'go')
    check('merged: the card moves to Done', !!(await until(async () => (await h.card(queued.n))?.column === 'done' && (await inColumn(queued.n, 'done')))), JSON.stringify(await h.kinds(queued.n)))
    // The OK'd card follows it through the queue.
    await until(async () => (await h.card(okCard))?.column === 'done')

    // --- Archive All in Approved while Merging isn't shown (HR2's round 2): a card waiting for your OK under Hive merges,
    // the project switched to The agent merges for later cards (no Merging now); your OK while the dialog is open sends the
    // old card into Merging under its own rules, and Approved's archive leaves it there.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { okBefore: { mode: 'every', labels: [] } }) })
    q.steer(fx, 'wait')
    const oldRules = (await inv('tasks:create', { title: 'Old rules', project: 'alpha' })).number
    await q.intent(h, okBuilder, oldRules, 'start')
    fs.writeFileSync(path.join(okBuilder.folder, 'old.txt'), 'old\n')
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'old rules'])
    await q.intent(h, okBuilder, oldRules, 'submit', { summary: 'ready' })
    await q.intent(h, reviewer, oldRules, 'start-review')
    await q.intent(h, reviewer, oldRules, 'verdict', { pass: true, comment: 'ok' })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges' }) })
    check('old rules: it waits in Approved, and Merging is not shown', !!(await until(async () => (await inColumn(oldRules, 'passed')) && !(await columns()).includes('merging'))), await columns())
    await col('passed').getByRole('button', { name: 'Approved: more' }).click()
    await item('Archive All in Approved (1)…').click()
    check('…Archive All in Approved asks for its one card', !!(await until(async () => (await archiveDialog.count()) === 1)) && /Archive 1 card in Approved\?/.test(await archiveDialog.innerText()), await archiveDialog.innerText().catch(() => ''))
    const oldAsk = (await inv('tasks:forYou', 'alpha')).items.find((i) => i.card === oldRules)
    await inv('tasks:answer', oldRules, oldAsk.request, { outcome: 'approved' })
    check('…your OK sends it into Merging (shown now) while the dialog is open', !!(await until(async () => inColumn(oldRules, 'merging'))), await columns())
    const archiveNow = archiveDialog.getByRole('button', { name: /^Archive/ })
    if (await archiveNow.isEnabled().catch(() => false)) await archiveNow.click()
    else await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await archiveDialog.count()) === 0)
    check('…and Approved\'s archive leaves it in Merging', (await h.card(oldRules))?.archived === false && (await inColumn(oldRules, 'merging')))
    fs.writeFileSync(fx.go, 'go')
    check('…then it merges under its own rules: Done', !!(await until(async () => (await h.card(oldRules))?.column === 'done')))
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })

    // --- With the workflow rules not enforced, every category shows, the workspace's own cards' board too (HR2's round 1).
    const own = (await inv('tasks:create', { title: 'About the workspace', project: '' })).number
    await inv('advanced:set', 'hive.workflow.enforce', false)
    await showBoard('Workspace')
    check('rules off, the Workspace board: all six categories', !!(await until(async () => (await columns()) === 'hold todo doing review passed done' && (await inColumn(own, 'todo')))), await columns())
    await inv('advanced:set', 'hive.workflow.enforce', null)
    check('rules on again, the Workspace board: On Hold, Todo, Active and Done', !!(await until(async () => (await columns()) === 'hold todo doing done')), await columns())

    // --- A No review project alone: Review and Approved hidden.
    await showBoard('beta')
    check('beta alone: On Hold, Todo, Active and Done only', !!(await until(async () => (await columns()) === 'hold todo doing done')), await columns())
    await shoot('noreview-en')

    // --- Options changed to No review while a card is in Review: Review stays until the card leaves it.
    q.steer(fx, 'pass')
    const builder = await q.agent(fx, h, 'B9', { worktree: true })
    const inReview = (await inv('tasks:create', { title: 'In review', project: 'alpha' })).number
    await q.intent(h, builder, inReview, 'start')
    fs.writeFileSync(path.join(builder.folder, 'r.txt'), 'r\n')
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'in review'])
    const submitted = await q.intent(h, builder, inReview, 'submit', { summary: 'ready' })
    check('a card in Review', submitted.status === 200 && (await h.card(inReview))?.column === 'review', JSON.stringify(submitted))
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { review: 'none', noSelfReview: false }) })
    check("alpha's options no longer produce Review", (await ids(fx.alpha)) === 'hold todo active merging done', await ids(fx.alpha))
    await showBoard('alpha')
    check('…but Review stays shown while the card is in it', !!(await until(async () => (await columns()).includes('review') && (await inColumn(inReview, 'review')))), await columns())
    await q.intent(h, reviewer, inReview, 'start-review')
    await q.intent(h, reviewer, inReview, 'verdict', { pass: true, comment: 'ok' })
    check('once it leaves Review (its own rules: merged), Review goes', !!(await until(async () => (await h.card(inReview))?.column === 'done' && !(await columns()).includes('review'))), await columns())

    // --- A rename: on the board for one project; with two naming it differently, the default and each card's own.
    const building = (await inv('tasks:create', { title: 'Being built', project: 'alpha' })).number
    await inv('tasks:update', building, { column: 'doing' })
    const making = (await inv('tasks:create', { title: 'Being made', project: 'beta' })).number
    await inv('tasks:update', making, { column: 'doing' })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: { ...q.queueOptions(fx, { review: 'none', noSelfReview: false }), stageNames: { active: 'Building' } } })
    check('alpha alone: its Active column reads Building', !!(await until(async () => (await labelText('doing')) === 'Building')), await labelText('doing'))
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', finish: 'committed', folder: 'project', stageNames: { active: 'Making' } } })
    await showBoard(null)
    check('all projects, named differently: the column reads Active', !!(await until(async () => (await labelText('doing')) === 'Active')), await labelText('doing'))
    const note = (n) => tile(n).locator('.task-project').getAttribute('data-stage-note')
    check("each card's own project's name for its stage, on its project's hover", !!(await until(async () => (await note(building)) === 'Building' && (await note(making)) === 'Making')), `${await note(building)} / ${await note(making)}`)
    await tile(building).locator('.task-project').hover()
    check('…the hover says it', !!(await until(async () => (await page.locator('.tip', { hasText: 'In alpha, this stage is Building' }).count()) > 0)))
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', finish: 'committed', folder: 'project', stageNames: { active: 'Building' } } })
    await inv('workflow:setOptions', notes, { preset: null, options: { stageNames: { active: 'Building' } } })
    check('every shown project names it alike: the column reads it', !!(await until(async () => (await labelText('doing')) === 'Building')), await labelText('doing'))
    await shoot('renamed-en')

    // --- The workflow link: a line per project with all of them, the link with one; it opens Version Control → Workflow.
    // Each project's line once its workflow is read (just saved above): the menu, opened again until they all are.
    let lines = []
    const complete = () => ['alpha', 'beta', 'notes'].every((p) => lines.some((l) => l.startsWith(`${p} · Workflow: `)))
    await until(async () => {
      await page.locator('[data-action="board-workflows"]').click()
      lines = await page.locator('.menu .menu-item').allTextContents()
      await page.keyboard.press('Escape')
      return complete()
    })
    check('all projects: a line per project in the Workflows menu', complete(), JSON.stringify(lines))
    await showBoard('alpha')
    const link = page.locator('[data-action="board-workflow"]')
    check('alpha alone: "Workflow: Git · no preset chosen" in the toolbar', !!(await until(async () => ((await link.textContent().catch(() => '')) ?? '').trim() === 'Workflow: Git · no preset chosen')), await link.textContent().catch(() => ''))
    await link.click()
    const selected = () => page.locator('.git-sections [aria-selected="true"]').getAttribute('data-section').catch(() => null)
    check('it opens Version Control → Workflow', !!(await until(async () => (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await selected()) === 'workflow')))

    // --- Polish: the long stage names.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { review: 'none', noSelfReview: false }) })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    q.steer(fx, 'wait')
    const second = await q.approve(fx, h, reviewer, 'Queued again', { 'again.txt': 'again\n' })
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'pl')
    const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: { ...base, code: 'pl', locale: 'pl', messages } })
    await showBoard('Wszystkie projekty', 'Tablica zadań')
    check('Polish: Merging reads Scalanie under Zatwierdzone', !!(await until(async () => (await labelText('merging')) === 'Scalanie' && (await inColumn(second.n, 'merging')))), await labelText('merging'))
    // Seven columns at this width: every name readable, wrapped rather than cut (the Assistant's OK on round 3).
    const cut = await board.locator('.board-column-header .board-column-label').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent))
    check('Polish, seven columns: no column name is cut', cut.length === 0 && (await board.locator('.board-column').count()) === 7, JSON.stringify(cut))
    // Every name inside its own column, also a stage's own name of 24 letters with no space (HR2's round 4).
    const outside = () => board.locator('.board-column').evaluateAll((cols) => cols.flatMap((c) => {
      const r = c.getBoundingClientRect()
      return [...c.querySelectorAll('.board-column-header > *')].filter((e) => { const b = e.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1 }).map((e) => `${c.getAttribute('data-column')}: ${e.textContent}`)
    }))
    check('…every header inside its own column', (await outside()).length === 0, JSON.stringify(await outside()))
    await shoot('merging-pl')
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: { ...q.queueOptions(fx), stageNames: { active: 'W'.repeat(24) } } })
    await showBoard('alpha', 'Tablica zadań')
    check('a 24-letter name with no space stays inside its column', !!(await until(async () => (await labelText('doing')) === 'W'.repeat(24) && (await outside()).length === 0)), JSON.stringify(await outside()))
    await shoot('longname-pl')
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: base })
    fs.writeFileSync(fx.go, 'go')
    await until(async () => (await h.card(second.n))?.column === 'done')
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await h.page.screenshot({ path: path.join(fx.shots, 'boardstages-failed.png') }).catch(() => {})
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nboardstages: all checks passed')
  process.exit(failed ? 1 : 0)
})()
