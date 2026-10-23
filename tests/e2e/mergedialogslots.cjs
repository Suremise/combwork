// The Merge dialog for merges outside cards, and Branches & remotes on slots (#1450, OP-13; SPEC §16.10.2), on a temp
// Git project whose builders merge their own work into main (queueFixture.cjs's, "the agent merges"), the Assistant off:
// - a slot lent to B1 (the test copies' `slots:test`, as #1438's card start will) with a line checked out in it:
//   Branches & remotes names the slot on the line's row and the slot's lease on its Worktrees row; ⑂ opens Merge a
//   branch on it, which merges it into main (screenshots in both themes);
// - a card started by B2 in its own worktree (fake Claude Code, by its token) and submitted, in Review: its line in the
//   dialog says it is that card's work, with a link to the card, and Merge asks first; once confirmed the merge is
//   observed outside the rules (Integrated, by outside, with the rules it skipped) and the card is Done.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47862))
const fx = q.queueProject('mergedialogslots')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const git = (cwd, args) => lib.git(cwd, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, ...args])

;(async () => {
  q.prepare(fx)
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', target: 'main' }) })
    const text = async (l) => ((await l.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const shoot = async (target, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await target.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- slot-a lent to B1, a line in it with a commit main hasn't got.
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const lent = await inv('slots:test', fx.alpha, { op: 'lend', agent: b1.id, card: 101 })
    check('slot-a is lent to B1', lent.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    const slotLine = 'hive/AL/AL-101-slot-work'
    git(lent.slot.folder, ['checkout', '-q', '-b', slotLine])
    fs.writeFileSync(path.join(lent.slot.folder, 's.txt'), 'slot work\n')
    git(lent.slot.folder, ['add', '-A'])
    git(lent.slot.folder, ['commit', '-qm', 'Slot work'])

    // --- Version Control → Branches & remotes.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('[role="tab"][data-section="branches"]').click()
    const row = (b) => page.locator(`.git-branch[data-branch="${b}"]`)
    check("the line's row names its slot", !!(await until(async () => (await row(slotLine).locator('[data-slot="slot-a"]').count()) === 1, HUNG_MS)) && (await text(row(slotLine).locator('[data-slot]'))) === 'slot-a', await text(row(slotLine)))
    check("…its hover, the slot's lease", (await row(slotLine).locator('[data-slot]').getAttribute('title')) === 'slot-a: B1 on #101')
    const wtRow = page.locator('.git-worktree[data-slot="slot-a"]')
    check("the slot's Worktrees row names its lease", !!(await until(async () => (await text(wtRow)).includes('slot-a: B1 on #101'), HUNG_MS)), await text(wtRow))
    await shoot(page, '1-branches-slots')

    // --- Merge a branch on the slot's line: into main.
    await row(slotLine).locator('[data-action="merge-branch"]').click()
    const dialog = page.locator('.dialog', { has: page.locator('[data-branch-merge]') })
    check('⑂ opens Merge a branch on that line, into main', !!(await until(async () => (await dialog.locator('select[data-pick="branch"]').inputValue().catch(() => '')) === slotLine, HUNG_MS)) && (await dialog.locator('select[data-pick="target"]').inputValue()) === 'main', await text(dialog))
    check('…listed under "Cards\' lines", with its slot', (await dialog.locator('optgroup[label="Cards\' lines"] option', { hasText: `${slotLine} (in slot-a)` }).count()) === 1)
    check('…"Merges 1 commit from … into main"', !!(await until(async () => (await text(dialog)).includes(`Merges 1 commit from ${slotLine} into main.`), HUNG_MS)), await text(dialog))
    await shoot(dialog, '2-merge-slot-line')
    await dialog.locator('[data-action="merge"]').click()
    check("the slot's line is merged into main", !!(await until(async () => (await dialog.count()) === 0 && fs.existsSync(path.join(fx.alpha, 's.txt')), HUNG_MS)) && lib.git(fx.alpha, ['log', '-1', '--format=%s', 'main']).trim() === `Merge ${slotLine}`, lib.git(fx.alpha, ['log', '-3', '--oneline', 'main']))

    // --- A card in Review: its line is its work; merged here only after asking, then outside the rules.
    const b2 = await q.agent(fx, h, 'B2', { worktree: true })
    const n = (await inv('tasks:create', { title: 'Card in review', project: 'alpha' })).number
    const key = (await h.card(n)).key
    const started = await q.intent(h, b2, n, 'start')
    const line = started.body?.data?.line
    check('the card starts on its line', started.status === 200 && !!line, JSON.stringify(started.body))
    fs.writeFileSync(path.join(b2.folder, 'c.txt'), 'card work\n')
    git(b2.folder, ['add', '-A'])
    git(b2.folder, ['commit', '-qm', 'Card work'])
    const sub = await q.intent(h, b2, n, 'submit', { summary: 'ready' })
    check('submitted: in Review', sub.status === 200 && !!(await until(async () => (await h.card(n))?.column === 'review', HUNG_MS)), JSON.stringify(sub.body))
    await until(async () => (await row(line).count()) === 1, HUNG_MS)
    await row(line).locator('[data-action="merge-branch"]').click()
    const note = dialog.locator(`[data-line-card="${n}"]`)
    check(`the dialog says the line is ${key}'s work, with a link to it`, !!(await until(async () => (await note.count()) === 1, HUNG_MS)) && (await text(note)).includes(`This is ${key}'s work: merge it through its card.`) && (await note.locator(`[data-open-card="${n}"]`).count()) === 1, await text(dialog))
    await until(async () => (await text(dialog)).includes('Merges 1 commit'), HUNG_MS)
    await shoot(dialog, '3-card-line')
    await dialog.locator('[data-action="merge"]').click()
    const ask = page.locator('.dialog', { hasText: `Merge ${key}'s work outside its card?` })
    check('Merge asks first', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)), await text(page.locator('.dialog').last()))
    await shoot(ask, '4-card-confirm')
    await ask.getByRole('button', { name: 'Merge Here' }).click()
    check("the card's line is merged into main", !!(await until(async () => fs.existsSync(path.join(fx.alpha, 'c.txt')), HUNG_MS)))
    const outside = await until(async () => (await h.facts(n)).find((f) => f.kind === 'Integrated' && f.data.by === 'outside'), HUNG_MS)
    check('…observed outside the rules: Integrated, by outside, naming the rules it skipped', !!outside && Array.isArray(outside.data.outsideRules) && outside.data.outsideRules.length > 0, JSON.stringify((await h.facts(n)).map((f) => [f.kind, f.data?.outsideRules])))
    check('…and the card is Done', !!(await until(async () => (await h.card(n))?.column === 'done', HUNG_MS)), (await h.card(n))?.column)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
