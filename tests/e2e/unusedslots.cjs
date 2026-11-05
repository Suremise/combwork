// Unused Worktrees on slots (#1450, SPEC §16.10.2): a test Combwork lends a Git project's slots (the test copies' `slots:test`
// channel, as #1438's card start will) and Version Control → Changes → Unused worktrees lists only those that need the
// user: a dirty free slot (with Open, which shows its changes), free slots beyond the pool, and a retired home no
// conversation resumes in (`slots:test` `homes`, until #1441 records real ones); never the slot lent to a card or the one
// carried for its agent. Remove is refused for a slot with unmerged commits (it has no Remove; main refuses it, saying
// why), and "Remove all merged" removes the merged free slot beyond the pool through the guarded clean-up. Screenshots
// in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR (no agent is started).
// Dev build only (#1578): its slots are lent through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47861))
const fx = q.queueProject('unusedslots')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const git = (cwd, args) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args])

;(async () => {
  q.prepare(fx)
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    // "How do you work?" answered (#1423), as a user does once.
    await inv('workflow:presetNotNow', fx.alpha, 'git').catch(() => undefined)
    const op = (o) => inv('slots:test', fx.alpha, o)
    // Five builders while the slots are made (the pool makes one per builder at most), three after.
    const agents = []
    for (const name of ['B1', 'B2', 'B3', 'B4', 'B5']) agents.push(await lib.addAgent(inv, fx.alpha, { name }))
    const [b1, b2, b3, b4, b5] = agents

    // slot-a: lent to B1 for card 101, and stays so.
    const a = await op({ op: 'lend', agent: b1.id, card: 101 })
    check('slot-a is lent to B1', a.ok && a.slot.name === 'slot-a', JSON.stringify(a))
    // slot-b: left with an untracked file: dirty.
    const b = await op({ op: 'lend', agent: b3.id, card: 103 })
    fs.writeFileSync(path.join(b.slot.folder, 'left.txt'), 'work left behind\n')
    await op({ op: 'release', lease: b.lease.id, why: 'done' })
    // slot-c: a commit main hasn't (unmerged); slot-d: as main is (merged). Both free and clean.
    const c = await op({ op: 'lend', agent: b4.id, card: 104 })
    const d = await op({ op: 'lend', agent: b5.id, card: 105 })
    fs.writeFileSync(path.join(c.slot.folder, 'c.txt'), 'unmerged\n')
    git(c.slot.folder, ['add', '-A'])
    git(c.slot.folder, ['commit', '-qm', 'Work main has not got'])
    await op({ op: 'release', lease: c.lease.id, why: 'done' })
    await op({ op: 'release', lease: d.lease.id, why: 'done' })
    check('slot-b dirty, slot-c and slot-d ready', JSON.stringify((await inv('slots:list', fx.alpha)).map((s) => [s.name, s.state])) === JSON.stringify([['slot-a', 'lent'], ['slot-b', 'dirty'], ['slot-c', 'ready'], ['slot-d', 'ready']]), JSON.stringify(await inv('slots:list', fx.alpha)))
    // slot-e: B2's old worktree, carried for it (an open carried lease protects it).
    const root = path.dirname(a.slot.folder)
    const e = path.join(root, 'slot-e')
    lib.git(fx.alpha, ['worktree', 'add', '-q', '--detach', e])
    check('slot-e is carried for B2', !!(await op({ op: 'carry', agent: b2.id, slot: 'slot-e', folder: e })))
    // A retired home no conversation can resume in.
    const home = path.join(root, 'home-r1')
    lib.git(fx.alpha, ['worktree', 'add', '-q', '-b', 'cw/r1-old', home])
    fs.writeFileSync(path.join(home, 'notes.txt'), 'review notes\n')
    git(home, ['add', '-A'])
    git(home, ['commit', '-qm', 'Review notes'])
    await op({ op: 'homes', folders: [home] })
    // Three builders now: the pool is three, so two of the five slots are beyond it.
    for (const x of [b4, b5]) await inv('agents:remove', fx.alpha, x.id, { deleteWorktree: false })

    // --- The list, as main has it.
    const listed = async () => Object.fromEntries((await inv('worktrees:unused', fx.alpha)).worktrees.map((w) => [path.basename(w.path), w.kind ?? 'worktree']).sort(([x], [y]) => x.localeCompare(y)))
    check('listed: the dirty slot, the two free slots beyond the pool and the retired home; never the lent or carried slot', JSON.stringify(await listed()) === JSON.stringify({ 'home-r1': 'home', 'slot-b': 'dirtySlot', 'slot-c': 'slot', 'slot-d': 'slot' }), JSON.stringify(await listed()))

    // --- In the window: Version Control → Changes → Unused worktrees.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('[role="tab"][data-section="changes"]').click()
    const picker = page.locator('.split-list .root-select')
    await until(async () => (await picker.count()) === 1, HUNG_MS)
    await picker.selectOption('unused')
    const section = page.locator('.unused-worktrees-pane .unused-worktrees')
    const row = (slot) => section.locator(`.unused-wt[data-slot="${slot}"]`)
    check('the page lists four rows', !!(await until(async () => (await section.locator('.unused-wt').count()) === 4, HUNG_MS)), await section.innerText().catch(() => ''))
    check('slot-b: named, "slot with changes, not lent", with Open, no Remove, no Remove anyway or Give', (await row('slot-b').innerText()).includes('slot-b') && (await row('slot-b').locator('[data-unused-kind="dirtySlot"]').count()) === 1 && (await row('slot-b').getByRole('button', { name: 'Open' }).count()) === 1 && (await row('slot-b').getByRole('button', { name: 'Remove', exact: true }).count()) === 0 && (await row('slot-b').getByRole('button', { name: 'Remove anyway…' }).count()) === 0 && (await row('slot-b').getByRole('button', { name: 'Give to an agent…' }).count()) === 0, await row('slot-b').innerText().catch(() => ''))
    check('slot-c: "free slot beyond the pool", "1 commit not on main", no Remove', !!(await until(async () => /1 commit not on main/.test(await row('slot-c').innerText()), HUNG_MS)) && (await row('slot-c').locator('[data-unused-kind="slot"]').count()) === 1 && (await row('slot-c').getByRole('button', { name: 'Remove', exact: true }).count()) === 0, await row('slot-c').innerText().catch(() => ''))
    check('slot-d: merged and clean, with Remove', /Merged into main · clean/.test(await row('slot-d').innerText()) && (await row('slot-d').getByRole('button', { name: 'Remove', exact: true }).count()) === 1, await row('slot-d').innerText().catch(() => ''))
    check('the retired home: "retired home, no conversation left"', (await section.locator('.unused-wt[data-kind="home"] [data-unused-kind="home"]').count()) === 1)
    check('no row for the lent slot-a or the carried slot-e', (await row('slot-a').count()) === 0 && (await row('slot-e').count()) === 0)
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    await shoot('1-unused-slots')

    // --- Remove is refused for the slot with unmerged commits, saying why; nothing goes.
    const refused = await inv('worktrees:removeUnused', fx.alpha, c.slot.folder, {})
    check('Remove of slot-c is refused: "it has commits that aren\'t on main"', refused.deleted === false && refused.reason === "it has commits that aren't on main" && fs.existsSync(c.slot.folder), JSON.stringify(refused))
    const forced = await inv('worktrees:removeUnused', fx.alpha, c.slot.folder, { force: 'x' })
    check('…and never forced', forced.deleted === false && fs.existsSync(c.slot.folder), JSON.stringify(forced))

    // --- Open on the dirty slot shows its changes.
    await row('slot-b').getByRole('button', { name: 'Open' }).click()
    check("Open shows slot-b's untracked file", !!(await until(async () => (await page.locator('.split-list').innerText().catch(() => '')).includes('left.txt'), HUNG_MS)), await page.locator('.split-list').innerText().catch(() => ''))
    await picker.selectOption('unused')
    await until(async () => (await section.locator('.unused-wt').count()) === 4, HUNG_MS)

    // --- Remove all merged: slot-d goes, through the guarded clean-up; the rest stay.
    await section.getByRole('button', { name: 'Remove all merged (1)…' }).click()
    const ask = page.locator('.dialog', { hasText: 'Remove 1 merged worktree?' })
    check('Remove all merged asks first, naming slot-d', !!(await until(async () => (await ask.count()) === 1, HUNG_MS)) && (await ask.innerText()).includes('slot-d'), await ask.innerText().catch(() => ''))
    await shoot('2-remove-merged')
    await ask.getByRole('button', { name: 'Remove', exact: true }).click()
    check('slot-d is removed: its folder and its row', !!(await until(async () => !fs.existsSync(d.slot.folder) && !(await inv('slots:list', fx.alpha)).some((s) => s.name === 'slot-d'), HUNG_MS)))
    check('…the list keeps the other three', !!(await until(async () => (await section.locator('.unused-wt').count()) === 3, HUNG_MS)), await section.innerText().catch(() => ''))
    check('slot-b, slot-c and the lent and carried slots stay', ['slot-a', 'slot-b', 'slot-c', 'slot-e'].every((s) => fs.existsSync(path.join(root, s))))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
