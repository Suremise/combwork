// The board shows stages (#1420, SPEC §16.5.2): a Pair project (Hive merges, queueFixture.cjs) beside a No review Git
// project (beta) and a None one (notes), with fake Claude Code agents acting by their own tokens and the Assistant off.
// - a card in the merge queue sits in Merging, a column of its own under Approved's heading, and moves to Done merged;
// - Merging collapses to a strip in the Approved group and stays collapsed after a reload; both columns fold the group;
// - Merging takes no drop, and its hover says cards come through the queue;
// - a No review project shows On Hold, Todo, Active and Done only;
// - the options changed to No review while a card is in Review: Review stays until the card leaves it;
// - a rename shows on the board (one project), the default name with two projects naming it differently, each card's
//   hover its own project's name;
// - "Workflow: Git · …" in the toolbar opens Version Control → Workflow; a line per project with all of them;
// - a None project beside the Git ones;
// - every column there on open, with the board's cards, and nothing moving after (HI-1682): the reads held, the first
//   open, opened again, a workflow changed while the board was closed, groups collapsed and none; Approved's heading
//   on its line in the gap, the columns starting where they do with no group.
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
/** Archive All's dialog once its card has left the column: its button "Archive 0 cards", and off (#1510). */
const nothingToArchive = (dialog) => {
  const button = dialog.getByRole('button', { name: /^Archive/ })
  return until(async () => (await button.innerText().catch(() => '')) === 'Archive 0 cards' && (await button.isDisabled().catch(() => false)), HUNG_MS)
}

;(async () => {
  q.prepare(fx)
  // beta: Git with no review (Committed is done, the project folder); notes: no version control.
  const beta = path.join(fx.ws, 'beta')
  const notes = path.join(fx.ws, 'notes')
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
  fs.mkdirSync(path.join(beta, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(beta, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: { review: 'none', finish: 'committed', folder: 'project' } } }))
  fs.mkdirSync(path.join(notes, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(notes, 'plan.md'), '# Plan\n')
  fs.writeFileSync(path.join(notes, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'none', agents: [], workflow: { platform: 'none', preset: null, options: {} } }))
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
    // Each open column's header: one row or two (the name over its count, + and ⋯), and whether it's tidy: the count on
    // ⋯'s row and ⋯ at the header's inline end.
    const headerRows = () => board.locator('.board-column:not(.collapsed) .board-column-header').evaluateAll((els) => els.map((head) => {
      const top = (sel) => head.querySelector(sel).getBoundingClientRect().top
      const more = [...head.querySelectorAll('.board-column-tools .icon-btn')].pop().getBoundingClientRect()
      const end = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight)
      const rows = Math.abs(top('.board-column-tools') - top('.board-column-label')) < 1 ? 1 : 2
      return { column: head.closest('.board-column').getAttribute('data-column'), rows, tidy: Math.abs(top('.count') - more.top) < 4 && Math.abs(more.right - end) < 1.5 }
    }))
    // The board with its sidebar (the activity bar's button toggles the sidebar when the board is shown already).
    const showBoard = async (project, button = 'Task Board') => {
      const row = page.locator('.pane-body .row', { hasText: project ?? 'All projects' }).first()
      await until(async () => {
        if ((await row.count()) && (await board.count())) return true
        await page.getByRole('button', { name: button }).click()
        return (await row.count()) > 0 && (await board.count()) > 0
      }, HUNG_MS)
      await row.click()
    }
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
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
    check('the queued card sits in Merging', !!(await until(async () => inColumn(queued.n, 'merging'), HUNG_MS)), await columns())
    const approvedGroup = board.locator('.board-category[data-category="passed"]')
    check('Merging and Approved share one Approved heading', (await approvedGroup.locator('.board-category-head').textContent()) === 'Approved' && (await approvedGroup.locator('.board-column').evaluateAll((e) => e.map((x) => x.getAttribute('data-column')).join(' '))) === 'passed merging')
    check('each column named by its stage', (await labelText('passed')) === 'Approved' && (await labelText('merging')) === 'Merging', `${await labelText('passed')} / ${await labelText('merging')}`)
    check('every category shows with all projects (the union)', (await columns()) === 'hold todo doing review passed merging done', await columns())
    check("the None project's card is on the board", await inColumn(notesCard, 'todo'))
    check('the grouped columns are as wide as the others', !!(await until(async () => {
      const widths = await board.locator('.board-column').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
      return Math.max(...widths) - Math.min(...widths) < 1.5
    }, HUNG_MS)), JSON.stringify(await board.locator('.board-column').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))))
    check('en: every column header is one row, Approved and Merging too (#1490)', (await headerRows()).every((r) => r.rows === 1), JSON.stringify(await headerRows()))
    const headerTops = await board.locator('.board-column-header').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    check("…and every column's header starts at the same height", new Set(headerTops).size === 1, JSON.stringify(headerTops))
    await shoot('merging-en')

    // --- Merging collapses to a strip under Approved's heading, and stays so after a reload (#1662: the saved fold
    // dropped it, so « did nothing); with Approved collapsed too the whole group folds; both expand again.
    const collapsed = async (id) => ((await col(id).getAttribute('class')) ?? '').includes('collapsed')
    await col('merging').getByRole('button', { name: 'Collapse Merging' }).click()
    check('« collapses Merging to a strip', !!(await until(async () => (await collapsed('merging')) && (await col('merging').locator('.board-column-strip').count()) === 1, HUNG_MS)))
    check('…still in the Approved group, Approved open beside it', (await approvedGroup.locator('.board-column[data-column="merging"].collapsed').count()) === 1 && !(await collapsed('passed')) && !((await approvedGroup.getAttribute('class')) ?? '').includes('collapsed'))
    check("…its strip shows its name and its card's count", /Merging/i.test(await col('merging').locator('.board-column-strip').innerText()) && (await col('merging').locator('.board-column-strip .count').innerText()) === '1')
    // Once its width has moved (the columns' transition): the strip is 34 px and Approved as wide as the other columns.
    const widths = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.board .board-column')].map((e) => [e.getAttribute('data-column'), Math.round(e.getBoundingClientRect().width)])))
    check('…a 34 px strip, Approved beside it as wide as the other columns, its header one row', !!(await until(async () => {
      const w = await widths()
      return w.merging === 34 && Math.abs(w.passed - w.hold) <= 1 && (await headerRows()).every((r) => r.rows === 1)
    }, HUNG_MS)), JSON.stringify([await widths(), await headerRows()]))
    await shoot('merging-collapsed')
    await page.reload()
    await lib.appReady(page)
    await showBoard(null)
    check('after a reload, Merging is still collapsed', !!(await until(async () => (await col('merging').count()) === 1 && (await collapsed('merging')), HUNG_MS)), await columns())
    await col('passed').getByRole('button', { name: 'Collapse Approved' }).click()
    check('with Approved collapsed too, the Approved group folds to its two strips', !!(await until(async () => (await collapsed('passed')) && ((await approvedGroup.getAttribute('class')) ?? '').includes('collapsed'), HUNG_MS)))
    check('…its strips stay in the group, under its heading', (await approvedGroup.locator('.board-column.collapsed').count()) === 2 && (await approvedGroup.locator('.board-category-head').count()) === 1)
    check('…two 34 px strips', !!(await until(async () => {
      const w = await widths()
      return w.passed === 34 && w.merging === 34
    }, HUNG_MS)), JSON.stringify(await widths()))
    await shoot('approved-collapsed')

    // --- The board's own columns fold to 34 px strips on a grouped board too (HI-1724: `.board.grouped > .board-column`
    // outranked `.collapsed`, so they kept 140 px); open ones keep their 140 px least width. A mix, then all, wide and narrow.
    const OWN = ['hold', 'todo', 'doing', 'review', 'done']
    const fold = async (folding) => {
      for (const id of folding) await col(id).locator('.board-column-header').getByRole('button', { name: /^Collapse / }).click()
      await until(async () => (await Promise.all(folding.map(collapsed))).every(Boolean), HUNG_MS)
    }
    const foldedRight = (folded) => until(async () => {
      const w = await widths()
      return OWN.every((id) => (folded.includes(id) ? w[id] === 34 : w[id] >= 140))
    }, HUNG_MS)
    await fold(['hold', 'todo', 'review'])
    check('on a grouped board, folded On Hold, Todo and Review are 34 px strips, Active and Done open (HI-1724)', !!(await foldedRight(['hold', 'todo', 'review'])), JSON.stringify(await widths()))
    await shoot('grouped-mix')
    await lib.fitWindow(h.app, page, { width: 900, height: 900 })
    check('…narrow too', !!(await foldedRight(['hold', 'todo', 'review'])), JSON.stringify(await widths()))
    await shoot('grouped-mix-narrow')
    // The toolbar in a narrow window (HI-1725: the search box was a sliver showing "S", Workflows cut to "V"): the row
    // wraps, the search box keeps its least width, and no control is cut or past the toolbar's edge.
    const toolbarRow = () => page.evaluate(() => {
      const bar = document.querySelector('.board-view .board-toolbar')
      const edge = bar.getBoundingClientRect()
      // The workflow button and, where it has a tooltip, its wrapper (then the toolbar's item) both: either could be cut.
      const workflow = bar.querySelector('.board-workflow')
      const wrap = workflow?.parentElement?.matches('.tip-wrap') ? workflow.parentElement : null
      const items = [['search', bar.querySelector('.board-search')], ...[...bar.querySelectorAll(':scope > label')].map((e, i) => [`check${i}`, e]), ['workflow', workflow], ...(wrap ? [['workflow-wrap', wrap]] : []), ['new', bar.querySelector('.btn.primary')], ['more', bar.querySelector('.board-more')]]
      const controls = items.map(([name, e]) => {
        if (!e) return { name, missing: true }
        const r = e.getBoundingClientRect()
        return { name, top: Math.round(r.top), bottom: Math.round(r.bottom), mid: Math.round((r.top + r.bottom) / 2), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), cut: e.scrollWidth > e.clientWidth + 1 }
      })
      return { left: Math.round(edge.left), right: Math.round(edge.right), controls }
    })
    // Every control there, whole, inside the toolbar, and none over another (the button inside its own wrapper aside).
    const toolbarWhole = (t) => {
      const c = t.controls
      if (c.some((x) => x.missing) || c.find((x) => x.name === 'search').width < 160) return false
      if (!c.every((x) => !x.cut && x.left >= t.left - 1 && x.right <= t.right + 1)) return false
      const apart = c.filter((x) => x.name !== 'workflow')
      return apart.every((a, i) => apart.slice(i + 1).every((b) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1))
    }
    // One row: every control's middle within a few pixels of the others' (align-items: center; their heights differ).
    const oneRow = (t) => Math.max(...t.controls.map((x) => x.mid)) - Math.min(...t.controls.map((x) => x.mid)) <= 3
    check('narrow: the toolbar wraps, its search box at least 160 px, every control whole, inside it and apart (HI-1725)', !!(await until(async () => {
      const t = await toolbarRow()
      return toolbarWhole(t) && !oneRow(t)
    }, HUNG_MS)), JSON.stringify(await toolbarRow()))
    await shoot('toolbar-narrow')
    await fold(['doing', 'done'])
    check('…every column folded: all 34 px strips, narrow', !!(await foldedRight(OWN)), JSON.stringify(await widths()))
    await shoot('grouped-all-folded-narrow')
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    check('…and wide', !!(await foldedRight(OWN)), JSON.stringify(await widths()))
    await shoot('grouped-all-folded')
    check('wide: the toolbar is one row, every control whole (HI-1725)', !!(await until(async () => {
      const t = await toolbarRow()
      return toolbarWhole(t) && oneRow(t)
    }, HUNG_MS)), JSON.stringify(await toolbarRow()))
    await shoot('toolbar-wide')
    for (const id of OWN) await col(id).getByRole('button', { name: /^Expand / }).click()
    check('…they open again, each at least 140 px', !!(await foldedRight([])), JSON.stringify(await widths()))

    await col('merging').getByRole('button', { name: 'Expand Merging' }).click()
    await col('passed').getByRole('button', { name: 'Expand Approved' }).click()
    check('both expand again', !!(await until(async () => !(await collapsed('merging')) && !(await collapsed('passed')) && !((await approvedGroup.getAttribute('class')) ?? '').includes('collapsed'), HUNG_MS)))

    // Merging's hover, and no drop.
    await label('merging').hover()
    const tip = page.locator('.tip', { hasText: 'merge queue' })
    check("Merging's hover says cards come through the merge queue", !!(await until(async () => (await tip.count()) > 0, HUNG_MS)))
    const loose = (await inv('tasks:create', { title: 'Loose', project: 'alpha' })).number
    await until(async () => (await tile(loose).count()) === 1, HUNG_MS)
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
    await until(async () => (await tile(sentinel).count()) === 1, HUNG_MS)
    check('a drop into Merging moves nothing', (await h.card(loose))?.column === 'todo' && (await inColumn(loose, 'todo')))

    // --- Archive All in Approved takes Approved's cards only, never Merging's (HR2's round 1): a card waiting for your OK
    // (labelled ui) in Approved beside the queued one in Merging.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { okBefore: { mode: 'labels', labels: ['ui'] } }) })
    const okCard = (await inv('tasks:create', { title: 'Needs your OK', project: 'alpha', labels: ['ui'] })).number
    const okBuilder = await q.agent(fx, h, 'B7')
    await q.startCard(fx, h, okBuilder, okCard)
    fs.writeFileSync(path.join(okBuilder.folder, 'ok.txt'), 'ok\n')
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'ok'])
    await q.intent(h, okBuilder, okCard, 'submit', { summary: 'ready' })
    await q.intent(h, reviewer, okCard, 'start-review')
    await q.intent(h, reviewer, okCard, 'verdict', { pass: true, comment: 'ok' })
    check('a card waiting for your OK sits in Approved, beside the queued one in Merging', !!(await until(async () => (await inColumn(okCard, 'passed')) && (await inColumn(queued.n, 'merging')), HUNG_MS)), await columns())
    const item = (text) => page.locator('.menu .menu-item', { hasText: text })
    await col('passed').getByRole('button', { name: 'Approved: more' }).click()
    check("Approved's menu: Archive All in Approved (1)…, its own card only", !!(await until(async () => (await item('Archive All in Approved (1)…').count()) === 1, HUNG_MS)), JSON.stringify(await page.locator('.menu .menu-item').allTextContents()))
    await item('Archive All in Approved (1)…').click()
    const archiveDialog = page.locator('.dialog', { has: page.locator('.archive-all') })
    check('…which asks for one card in Approved', !!(await until(async () => (await archiveDialog.count()) === 1, HUNG_MS)) && /Archive 1 card in Approved\?/.test(await archiveDialog.innerText()), await archiveDialog.innerText().catch(() => ''))
    // Your OK while it is open: the card goes on to Merging; archiving Approved then leaves it there.
    const ask = (await inv('tasks:forYou', 'alpha')).items.find((i) => i.card === okCard)
    await inv('tasks:answer', okCard, ask.request, { outcome: 'approved' })
    check('…the OK moves it to Merging while the dialog is open', !!(await until(async () => inColumn(okCard, 'merging'), HUNG_MS)))
    // The dialog follows the board (#1510: read once, its button could still be on as the move reached it, then off for
    // the click): nothing left in Approved to archive.
    check('…the dialog follows: nothing in Approved to archive', !!(await nothingToArchive(archiveDialog)), await archiveDialog.innerText().catch(() => ''))
    await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await archiveDialog.count()) === 0, HUNG_MS)
    check('…and nothing in Merging is archived', (await h.card(okCard))?.archived === false && (await h.card(queued.n))?.archived === false)
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })

    fs.writeFileSync(fx.go, 'go')
    check('merged: the card moves to Done', !!(await until(async () => (await h.card(queued.n))?.column === 'done' && (await inColumn(queued.n, 'done')), HUNG_MS)), JSON.stringify(await h.kinds(queued.n)))
    // The OK'd card follows it through the queue.
    await until(async () => (await h.card(okCard))?.column === 'done', HUNG_MS)

    // --- Archive All in Approved while Merging isn't shown (HR2's round 2): a card waiting for your OK under Hive merges,
    // the project switched to The agent merges for later cards (no Merging now); your OK while the dialog is open sends the
    // old card into Merging under its own rules, and Approved's archive leaves it there.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { okBefore: { mode: 'every', labels: [] } }) })
    q.steer(fx, 'wait')
    const oldRules = (await inv('tasks:create', { title: 'Old rules', project: 'alpha' })).number
    await q.startCard(fx, h, okBuilder, oldRules)
    fs.writeFileSync(path.join(okBuilder.folder, 'old.txt'), 'old\n')
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(okBuilder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'old rules'])
    await q.intent(h, okBuilder, oldRules, 'submit', { summary: 'ready' })
    await q.intent(h, reviewer, oldRules, 'start-review')
    await q.intent(h, reviewer, oldRules, 'verdict', { pass: true, comment: 'ok' })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges' }) })
    check('old rules: it waits in Approved, and Merging is not shown', !!(await until(async () => (await inColumn(oldRules, 'passed')) && !(await columns()).includes('merging'), HUNG_MS)), await columns())
    await col('passed').getByRole('button', { name: 'Approved: more' }).click()
    await item('Archive All in Approved (1)…').click()
    check('…Archive All in Approved asks for its one card', !!(await until(async () => (await archiveDialog.count()) === 1, HUNG_MS)) && /Archive 1 card in Approved\?/.test(await archiveDialog.innerText()), await archiveDialog.innerText().catch(() => ''))
    const oldAsk = (await inv('tasks:forYou', 'alpha')).items.find((i) => i.card === oldRules)
    await inv('tasks:answer', oldRules, oldAsk.request, { outcome: 'approved' })
    check('…your OK sends it into Merging (shown now) while the dialog is open', !!(await until(async () => inColumn(oldRules, 'merging'), HUNG_MS)), await columns())
    check('…the dialog follows: nothing in Approved to archive (old rules)', !!(await nothingToArchive(archiveDialog)), await archiveDialog.innerText().catch(() => ''))
    await archiveDialog.getByRole('button', { name: 'Cancel' }).click()
    await until(async () => (await archiveDialog.count()) === 0, HUNG_MS)
    check('…and Approved\'s archive leaves it in Merging', (await h.card(oldRules))?.archived === false && (await inColumn(oldRules, 'merging')))
    fs.writeFileSync(fx.go, 'go')
    check('…then it merges under its own rules: Done', !!(await until(async () => (await h.card(oldRules))?.column === 'done', HUNG_MS)))
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })

    // --- With the workflow rules not enforced, every category shows, the workspace's own cards' board too (HR2's round 1).
    const own = (await inv('tasks:create', { title: 'About the workspace', project: '' })).number
    await inv('advanced:set', 'cw.workflow.enforce', false)
    await showBoard('Workspace')
    check('rules off, the Workspace board: all six categories', !!(await until(async () => (await columns()) === 'hold todo doing review passed done' && (await inColumn(own, 'todo')), HUNG_MS)), await columns())
    await inv('advanced:set', 'cw.workflow.enforce', null)
    check('rules on again, the Workspace board: On Hold, Todo, Active and Done', !!(await until(async () => (await columns()) === 'hold todo doing done', HUNG_MS)), await columns())

    // --- A No review project alone: Review and Approved hidden.
    await showBoard('beta')
    check('beta alone: On Hold, Todo, Active and Done only', !!(await until(async () => (await columns()) === 'hold todo doing done', HUNG_MS)), await columns())
    await shoot('noreview-en')

    // --- Options changed to No review while a card is in Review: Review stays until the card leaves it.
    q.steer(fx, 'pass')
    const builder = await q.agent(fx, h, 'B9')
    const inReview = (await inv('tasks:create', { title: 'In review', project: 'alpha' })).number
    await q.startCard(fx, h, builder, inReview)
    fs.writeFileSync(path.join(builder.folder, 'r.txt'), 'r\n')
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'in review'])
    const submitted = await q.intent(h, builder, inReview, 'submit', { summary: 'ready' })
    check('a card in Review', submitted.status === 200 && (await h.card(inReview))?.column === 'review', JSON.stringify(submitted))
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { review: 'none', noSelfReview: false }) })
    check("alpha's options no longer produce Review", (await ids(fx.alpha)) === 'hold todo active merging done', await ids(fx.alpha))
    await showBoard('alpha')
    check('…but Review stays shown while the card is in it', !!(await until(async () => (await columns()).includes('review') && (await inColumn(inReview, 'review')), HUNG_MS)), await columns())
    await q.intent(h, reviewer, inReview, 'start-review')
    await q.intent(h, reviewer, inReview, 'verdict', { pass: true, comment: 'ok' })
    check('once it leaves Review (its own rules: merged), Review goes', !!(await until(async () => (await h.card(inReview))?.column === 'done' && !(await columns()).includes('review'), HUNG_MS)), await columns())

    // --- A rename: on the board for one project; with two naming it differently, the default and each card's own.
    const building = (await inv('tasks:create', { title: 'Being built', project: 'alpha' })).number
    await inv('tasks:update', building, { column: 'doing' })
    const making = (await inv('tasks:create', { title: 'Being made', project: 'beta' })).number
    await inv('tasks:update', making, { column: 'doing' })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: { ...q.queueOptions(fx, { review: 'none', noSelfReview: false }), stageNames: { active: 'Building' } } })
    check('alpha alone: its Active column reads Building', !!(await until(async () => (await labelText('doing')) === 'Building', HUNG_MS)), await labelText('doing'))
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', finish: 'committed', folder: 'project', stageNames: { active: 'Making' } } })
    await showBoard(null)
    check('all projects, named differently: the column reads Active', !!(await until(async () => (await labelText('doing')) === 'Active', HUNG_MS)), await labelText('doing'))
    const note = (n) => tile(n).locator('.task-project').getAttribute('data-stage-note')
    check("each card's own project's name for its stage, on its project's hover", !!(await until(async () => (await note(building)) === 'Building' && (await note(making)) === 'Making', HUNG_MS)), `${await note(building)} / ${await note(making)}`)
    await tile(building).locator('.task-project').hover()
    check('…the hover says it', !!(await until(async () => (await page.locator('.tip', { hasText: 'In alpha, this stage is Building' }).count()) > 0, HUNG_MS)))
    await inv('workflow:setOptions', beta, { preset: null, options: { review: 'none', finish: 'committed', folder: 'project', stageNames: { active: 'Building' } } })
    await inv('workflow:setOptions', notes, { preset: null, options: { stageNames: { active: 'Building' } } })
    check('every shown project names it alike: the column reads it', !!(await until(async () => (await labelText('doing')) === 'Building', HUNG_MS)), await labelText('doing'))
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
    }, HUNG_MS)
    check('all projects: a line per project in the Workflows menu', complete(), JSON.stringify(lines))
    await showBoard('alpha')
    const link = page.locator('[data-action="board-workflow"]')
    check('alpha alone: "Workflow: Git · no preset chosen" in the toolbar', !!(await until(async () => ((await link.textContent().catch(() => '')) ?? '').trim() === 'Workflow: Git · no preset chosen', HUNG_MS)), await link.textContent().catch(() => ''))
    await link.click()
    const selected = () => page.locator('.git-sections [aria-selected="true"]').getAttribute('data-section').catch(() => null)
    check('it opens Version Control → Workflow', !!(await until(async () => (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await selected()) === 'workflow', HUNG_MS)))

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
    check('Polish: Merging reads Scalanie under Zatwierdzone', !!(await until(async () => (await labelText('merging')) === 'Scalanie' && (await inColumn(second.n, 'merging')), HUNG_MS)), await labelText('merging'))
    // Seven columns at this width: every name readable, wrapped rather than cut (the Assistant's OK on round 3).
    const cut = await board.locator('.board-column-header .board-column-label').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent))
    check('Polish, seven columns: no column name is cut', cut.length === 0 && (await board.locator('.board-column').count()) === 7, JSON.stringify(cut))
    // Every name inside its own column, also a stage's own name of 24 letters with no space (HR2's round 4).
    const outside = () => board.locator('.board-column').evaluateAll((cols) => cols.flatMap((c) => {
      const r = c.getBoundingClientRect()
      return [...c.querySelectorAll('.board-column-header > *')].filter((e) => { const b = e.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1 }).map((e) => `${c.getAttribute('data-column')}: ${e.textContent}`)
    }))
    check('…every header inside its own column', (await outside()).length === 0, JSON.stringify(await outside()))
    // A header that wraps reads the name over "count … ⋯": the count never alone, ⋯ at the inline end (#1490).
    const rows = await headerRows()
    check('Polish: wrapped headers read the name over "count … ⋯", ⋯ at the end', rows.some((r) => r.rows === 2) && rows.every((r) => r.tidy), JSON.stringify(rows))
    await shoot('merging-pl')
    // The toolbar's longer Polish labels in a narrow window (HI-1725).
    await lib.fitWindow(h.app, page, { width: 900, height: 900 })
    check('Polish, narrow: the toolbar wraps, every control whole, inside it and apart (HI-1725)', !!(await until(async () => toolbarWhole(await toolbarRow()), HUNG_MS)), JSON.stringify(await toolbarRow()))
    await shoot('toolbar-narrow-pl')
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: { ...q.queueOptions(fx), stageNames: { active: 'W'.repeat(24) } } })
    await showBoard('alpha', 'Tablica zadań')
    check('a 24-letter name with no space stays inside its column', !!(await until(async () => (await labelText('doing')) === 'W'.repeat(24) && (await outside()).length === 0, HUNG_MS)), JSON.stringify(await outside()))
    await shoot('longname-pl')
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    await h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: base })
    fs.writeFileSync(fx.go, 'go')
    await until(async () => (await h.card(second.n))?.column === 'done', HUNG_MS)

    // --- Every column there on open, nothing moving after (HI-1682, Darren's decision): the board's columns come with its
    // cards (`board:stages`, in the board's read), and Approved's heading sits on its line in the gap above the columns,
    // so a grouped board's columns start where a board's with no group do. main's reads of the stages and of the
    // toolbar's workflow link are held, to see the board meanwhile; each layout the board takes is recorded as it is
    // made. main's answers for alpha with its options now (Hive merges) and with no Merging (No review, committed) are
    // read before the reads are replaced; the test says which alpha's answer (`answer`) as its options change.
    const read = async () => ({ stages: await inv('board:stages'), form: await inv('workflow:form', fx.alpha) })
    const plain = { review: 'none', finish: 'committed', folder: 'project' }
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: plain })
    const alphaPlain = await read()
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
    const alphaMerges = await read()
    const forms = { [beta]: await inv('workflow:form', beta), [notes]: await inv('workflow:form', notes) }
    await h.app.evaluate(({ ipcMain }, d) => {
      globalThis.__hold = { on: false, held: [], alpha: d.alpha, answer: d.answer, forms: d.forms }
      const reply = (v) => (globalThis.__hold.on ? new Promise((r) => globalThis.__hold.held.push(() => r(v))) : v)
      ipcMain.removeHandler('board:stages')
      ipcMain.handle('board:stages', () => reply(globalThis.__hold.answer.stages))
      ipcMain.removeHandler('workflow:form')
      ipcMain.handle('workflow:form', (_e, p) => reply(p === globalThis.__hold.alpha ? globalThis.__hold.answer.form : (globalThis.__hold.forms[p] ?? null)))
    }, { alpha: fx.alpha, answer: alphaMerges, forms })
    const answer = (a) => h.app.evaluate((_, v) => void (globalThis.__hold.answer = v), a)
    const hold = (on) => h.app.evaluate((_, v) => void (globalThis.__hold.on = v), on)
    const heldReads = () => h.app.evaluate(() => globalThis.__hold.held.length)
    const release = () => h.app.evaluate(() => {
      for (const r of globalThis.__hold.held.splice(0)) r()
    })
    const record = () => page.evaluate(() => {
      window.__layouts = []
      const take = () => {
        const b = document.querySelector('.board')
        if (!b) return
        const cols = [...b.querySelectorAll('.board-column')]
        const toolbar = document.querySelector('.board-toolbar')
        const r = {
          columns: cols.map((c) => c.getAttribute('data-column') + (c.classList.contains('collapsed') ? '*' : '')).join(' '),
          tops: [...new Set(cols.map((c) => Math.round(c.getBoundingClientRect().top)))].join(','),
          toolbar: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
          chip: !!document.querySelector('.board-workflow')
        }
        const last = window.__layouts[window.__layouts.length - 1]
        if (!last || JSON.stringify(last) !== JSON.stringify(r)) window.__layouts.push(r)
      }
      window.__observer?.disconnect()
      window.__observer = new MutationObserver(take)
      window.__observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
      take()
    })
    const layouts = () => page.evaluate(() => window.__layouts)
    /** The recorded layouts with columns: one set of columns, all at one top, the toolbar one height throughout. */
    const steady = (all) => {
      const drawn = all.filter((l) => l.columns)
      return drawn.length > 0 && new Set(drawn.map((l) => `${l.columns}|${l.tops}`)).size === 1 && !drawn[0].tops.includes(',') && new Set(all.map((l) => l.toolbar)).size === 1
    }
    const topOf = async () => (await layouts()).filter((l) => l.columns).pop()?.tops
    const topShot = (name) => page.screenshot({ path: path.join(fx.shots, `boardstages-${name}.png`), clip: { x: 0, y: 0, width: 1500, height: 260 } })
    const closeBoard = async () => {
      await page.getByRole('button', { name: 'Projects' }).click()
      await until(async () => (await board.count()) === 0, HUNG_MS)
    }
    const merges = 'hold todo doing review passed merging done'
    // The board opened by open() with main's reads held: its frame without columns until its read comes, then every
    // column at once, and the workflow link with them (read with the stages, HI-1852). Nothing moves, comes or goes, and the toolbar
    // keeps its height.
    const heldOpen = async (what, open, expected, shot) => {
      await hold(true)
      await open()
      const waiting = !!(await until(async () => (await heldReads()) > 0 && (await board.count()) === 1, HUNG_MS))
      check(`${what}: while the board's read waits, its frame shows without columns`, waiting && (await board.locator('.board-column').count()) === 0, JSON.stringify(await layouts()))
      if (shot) await topShot(`${shot}-before`)
      await release()
      await hold(false)
      check(`…then its columns, at once, and the workflow link: ${expected}`, !!(await until(async () => (await columns()) === expected.replace(/\*/g, '') && (await link.count()) === 1, HUNG_MS)), await columns())
      if (shot) await topShot(`${shot}-after`)
      check('…no column moved, none came or went, the toolbar kept its height', steady(await layouts()), JSON.stringify(await layouts()))
    }
    // A reload: the window's first read of the board (held before it: the board, shown already, reads as the window opens).
    const firstOpen = (project, expected, shot) =>
      heldOpen(`${project}, first open`, async () => {
        await page.reload()
        await lib.appReady(page)
        await record()
        await showBoard(project)
      }, expected, shot)
    await firstOpen('alpha', merges, 'noshift-first')
    const groupedTop = await topOf()
    // Opened again: every column from the first paint, with no read of the stages (they came with the board); the
    // workflow link, held, comes after them and moves nothing.
    await closeBoard()
    await hold(true)
    await record()
    await showBoard('alpha')
    check('alpha, opened again: every column from the first paint', !!(await until(async () => (await columns()) === merges, HUNG_MS)) && (await layouts()).filter((l) => l.columns).every((l) => l.columns.replace(/\*/g, '') === merges), JSON.stringify(await layouts()))
    // The workflow link came with the stages too (HI-1852): there from the first paint, with no read of its own.
    check('…the workflow link too, with no read of its own', (await link.count()) === 1 && (await layouts()).filter((l) => l.columns).every((l) => l.chip) && (await heldReads()) === 0, JSON.stringify({ layouts: await layouts(), held: await heldReads() }))
    await topShot('noshift-again')
    await hold(false)
    check('…the columns where they were and the toolbar its height', steady(await layouts()), JSON.stringify(await layouts()))
    // The workflow changed while the board is closed (HR5's round 1): opened again, never the columns of the old one.
    // To No review (no Merging): Merging never shows; and back: Merging comes with the rest, never after them.
    const changedWhileClosed = (options, answered, expected) =>
      heldOpen('alpha, its workflow changed while the board was closed', async () => {
        await closeBoard()
        await answer(answered)
        // Held from here: the change is a board change, read at once (held), and the board opens on it.
        await hold(true)
        await inv('workflow:setOptions', fx.alpha, { preset: null, options })
        await record()
        await showBoard('alpha')
      }, expected)
    await changedWhileClosed(plain, alphaPlain, 'hold todo doing done')
    check('…no Merging or Approved at any point', (await layouts()).every((l) => !/passed|merging/.test(l.columns)), JSON.stringify(await layouts()))
    await changedWhileClosed(q.queueOptions(fx), alphaMerges, merges)
    // Merging collapsed (HI-1662), then the whole Approved group.
    await col('merging').getByRole('button', { name: 'Collapse Merging' }).click()
    await until(async () => (await collapsed('merging')), HUNG_MS)
    await firstOpen('alpha', 'hold todo doing review passed merging* done')
    await col('passed').getByRole('button', { name: 'Collapse Approved' }).click()
    await until(async () => (await collapsed('passed')), HUNG_MS)
    await firstOpen('alpha', 'hold todo doing review passed* merging* done', 'noshift-collapsed')
    await col('merging').getByRole('button', { name: 'Expand Merging' }).click()
    await col('passed').getByRole('button', { name: 'Expand Approved' }).click()
    // No group (beta: no review, no Merging): Merging never flashes in, and the columns start where alpha's do.
    await firstOpen('beta', 'hold todo doing done', 'noshift-nogroup')
    check('beta: no Merging or Approved at any point', (await layouts()).every((l) => !/passed|merging/.test(l.columns)), JSON.stringify(await layouts()))
    check("the Approved heading takes no row: alpha's columns start where beta's do", (await topOf()) === groupedTop, `${groupedTop} / ${await topOf()}`)
    // The heading on its line: in the gap between the toolbar and the columns, over Approved and Merging.
    await showBoard('alpha')
    await until(async () => (await columns()) === merges, HUNG_MS)
    const head = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect()
      const name = r('.board-category-head > span')
      return { name: { top: name.top, bottom: name.bottom }, toolbar: r('.board-toolbar').bottom, columns: r('.board-column[data-column="passed"]').top, line: r('.board-category-head').width, group: r('.board-category').width }
    })
    check("…its name between the toolbar and the columns (a pixel's overlap at most), its line the group's width", head.name.top >= head.toolbar - 1 && head.name.bottom <= head.columns + 3 && Math.abs(head.line - head.group) < 1, JSON.stringify(head))
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await h.page.screenshot({ path: path.join(fx.shots, 'boardstages-failed.png') }).catch(() => {})
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nboardstages: all checks passed')
  process.exit(failed ? 1 : 0)
})()
