// HI-3592 (SPEC §16.5.4): what a retarget left behind, moved later from the window, on fake Claude Code agents. A project
// "Combwork merges" into `integration` (queueFixture.cjs); a card merged so its slot is free there; Work merges into then
// moved on to 1.2.0 without a retarget (as it was when that slot was lent), so the free slot still follows integration.
// - The slot's row: Version Control → Branches & remotes → Worktrees offers Move to 1.2.0…; its question, confirmed: the
//   slot follows 1.2.0, its folder at 1.2.0's head, clean, and the row offers nothing more.
// - Taking integration out of Other branches work can merge into while two cards use it: Save… names them, lists the
//   Todo card that can move (ticked) and the put-back one that stays (its branch holds a commit 1.2.0 lacks), and says
//   what moves stays moved. Saved: the card moves, the save is refused naming the other, the notification says what
//   moved, and the dialog keeps the refusal. With the other gone, saved again: integration taken out.
// Screenshots of the row, the question and Save… in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const path = require('path')
const fs = require('fs')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47716))
const fx = q.queueProject('slotmoveon')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.step')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const git = (cwd, ...args) => lib.git(cwd, args).trim()

;(async () => {
  q.prepare(fx)
  // 1.2.0: the next release's branch, a commit ahead of integration.
  git(fx.alpha, 'branch', '1.2.0', 'integration')
  q.commitOn(fx, '1.2.0', { 'release.txt': '1.2.0\n' }, '1.2.0 starts')
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  const { page, inv, app } = h
  const options = (over) => inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, over) })
  await options({ otherTargets: ['1.2.0'] })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const slots = () => inv('slots:list', fx.alpha)
    const ownTarget = async (n) => (await inv('tasks:workBadges')).find((b) => b.card === n)?.target ?? null
    const closeToasts = async () => {
      for (const close of await page.locator('.toast .toast-close, .toast button[aria-label="Close"]').all()) await close.click().catch(() => undefined)
    }
    const themes = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const t of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme: t } })
        await lib.themeShown(page, t)
        await loc.screenshot({ path: path.join(fx.shots, `${name}-${t}.png`) }).catch(() => undefined)
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
      await lib.themeShown(page, 'dark')
    }

    // --- A card merged into integration, its slot free afterwards; a put-back card on integration with a commit of its own.
    const reviewer = await q.agent(fx, h, 'R1')
    const one = await q.approve(fx, h, reviewer, 'One', { 'one.txt': 'one\n' })
    check('One merged into integration', !!(await waitHung(async () => (await card(one.n))?.column === 'done')), JSON.stringify(await h.kinds(one.n)))
    const b2 = await q.agent(fx, h, 'B2')
    const kept = (await inv('tasks:create', { title: 'Put back with work', project: 'alpha' })).number
    const st = await q.startCard(fx, h, b2, kept)
    check('a card started on integration in a slot of its own', st.status === 200 && !!b2.folder && b2.folder !== fx.alpha, JSON.stringify(st.body))
    fs.writeFileSync(path.join(b2.folder, 'kept.txt'), 'kept\n')
    lib.git(b2.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
    lib.git(b2.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'Kept'])
    const back = await q.act(fx, h, b2, kept, 'put-back', { why: 'later' })
    check('…a commit on its line, put back', back.status === 200 && (await card(kept))?.column === 'todo', JSON.stringify(back.body))
    const slot = await waitHung(async () => (await slots()).find((s) => s.state === 'ready' && !s.lease && !s.writer) ?? null)
    check('a slot is free and ready on integration', !!slot, JSON.stringify(await slots()))
    if (!slot) throw new Error('no free slot')

    // --- Work merges into moved on to 1.2.0 with no retarget: the free slot is left on integration.
    await options({ target: '1.2.0', otherTargets: ['integration'] })
    const offered = await waitHung(async () => ((await slots()).find((s) => s.name === slot.name)?.moveOn ?? null))
    check('the free slot left on integration is offered the move to 1.2.0', offered?.from === 'integration' && offered?.to === '1.2.0', JSON.stringify(await slots()))

    // --- Its row in Version Control → Branches & remotes → Worktrees.
    await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click().catch(() => undefined)
    await waitHung(async () => {
      if ((await page.locator('.tabs .tab', { hasText: 'Version Control' }).count()) > 0) return true
      await page.getByRole('button', { name: 'Projects' }).click()
      await page.locator('.sidebar').getByText('alpha', { exact: true }).first().click().catch(() => undefined)
      return false
    })
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
    await lib.vcSection(page, 'branches')
    const row = page.locator(`.git-worktree[data-slot="${slot.name}"]`)
    const move = row.locator('[data-action="move-slot"]')
    const label = await waitHung(async () => ((await move.count()) ? text(move) : null)).catch(() => null)
    check("the slot's row has Move to 1.2.0…", label === 'Move to 1.2.0…', (await text(page.locator('.git-branches'))).slice(-800))
    await row.scrollIntoViewIfNeeded().catch(() => undefined)
    await themes(row, 'slotmoveon-row')
    await move.click()
    const ask = page.locator('.dialog', { hasText: `Move ${slot.name} to 1.2.0?` })
    await ask.waitFor({ timeout: HUNG_MS })
    const asked = await text(ask)
    check('…its question says it follows integration, is detached at 1.2.0, and nothing is lost', asked.includes(`${slot.name} is free and still follows integration`) && asked.includes('detached at 1.2.0') && asked.includes('Nothing in it is lost'), asked)
    await themes(ask, 'slotmoveon-question')
    await ask.getByRole('button', { name: 'Move', exact: true }).click()
    await ask.waitFor({ state: 'detached', timeout: HUNG_MS })
    const said = await waitHung(async () => {
      const t = page.locator('.toast', { hasText: `${slot.name} follows 1.2.0 now` })
      return (await t.count()) ? text(t.first()) : null
    }).catch(() => null)
    check('…moved: the notification says it follows 1.2.0 now', !!said, (await text(page.locator('body'))).slice(-400))
    const head12 = git(fx.alpha, 'rev-parse', '1.2.0')
    check("…its folder is at 1.2.0's head, clean, ready, and nothing more is offered", git(slot.folder, 'rev-parse', 'HEAD') === head12 && git(slot.folder, 'status', '--porcelain') === '' && !!(await waitHung(async () => { const s = (await slots()).find((x) => x.name === slot.name); return s?.state === 'ready' && !s.moveOn })), JSON.stringify(await slots()))
    check('…and its row no longer has Move to…', !!(await waitHung(async () => (await move.count()) === 0)))
    await closeToasts()

    // --- Taking integration out of Other branches while two cards use it: one can move, the other can't.
    const moves = (await inv('tasks:create', { title: 'Todo on integration', project: 'alpha' })).number
    await inv('tasks:setTarget', moves, 'integration')
    const keyOf = async (n) => (await card(n)).key
    const [moveKey, keptKey] = [await keyOf(moves), await keyOf(kept)]
    await lib.vcSection(page, 'workflow')
    const form = page.locator('.workflow-form')
    const others = form.locator('.workflow-option[data-option="otherTargets"] input')
    await lib.workflowTab(form, 'otherTargets')
    await others.waitFor({ timeout: HUNG_MS })
    await others.fill('')
    await others.press('Enter')
    await form.locator('[data-action="save"]').click()
    const save = page.locator('.dialog', { has: page.locator('.workflow-save') })
    await save.waitFor({ timeout: HUNG_MS })
    const removal = save.locator('[data-removal="integration"]')
    const listed = await waitHung(async () => ((await removal.locator(`[data-retarget-move="${moveKey}"]`).count()) && (await removal.locator(`[data-retarget-keep="${keptKey}"]`).count()) ? text(removal) : null)).catch(() => null)
    check("Save… names integration's users, lists the Todo card as moving and the put-back one as staying", !!listed && listed.includes('integration is still used by:') && listed.includes(moveKey) && listed.includes(keptKey), (await text(save)).slice(0, 800))
    check('…what can move is ticked, and the dialog says it stays moved', (await removal.locator('input[data-retarget-on]').isChecked().catch(() => false)) && (await removal.locator('[data-removal-persist]').count()) === 1, listed ?? '')
    await themes(save, 'slotmoveon-removal')
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    const refused = await waitHung(async () => {
      const t = await text(save)
      return /integration can’t be taken out of Other branches work can merge into while these use it/.test(t) ? t : null
    }).catch(() => null)
    // The refusal names what is left: the card that stays, never the one that moved.
    const uses = refused?.match(/while these use it: ([^.]*)/)?.[1] ?? ''
    check('…saved: refused, naming only the card that stays, the dialog open', uses.includes(keptKey) && !uses.includes(moveKey), refused ?? (await text(save)).slice(0, 600))
    const partial = await waitHung(async () => {
      const t = page.locator('.toast', { hasText: 'Moved what could move, but the options weren’t saved' })
      return (await t.count()) ? text(t.first()) : null
    }).catch(() => null)
    check('…the notification says the card moved and the options weren’t saved', !!partial && /Moved to 1\.2\.0: 1 card and 0 slots/.test(partial), partial ?? (await text(page.locator('body'))).slice(-400))
    check('…the card that could move follows 1.2.0, the other is as it was, integration still listed', (await ownTarget(moves)) === null && ((await inv('workflow:form', fx.alpha))?.options?.otherTargets ?? []).includes('integration'), JSON.stringify(await inv('tasks:workBadges')))
    await themes(page, 'slotmoveon-refused')
    await save.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => undefined)
    await closeToasts()

    // --- With the other card gone, saved again: integration taken out, nothing left to move.
    await inv('tasks:delete', kept)
    await form.locator('[data-action="save"]').click()
    await save.waitFor({ timeout: HUNG_MS })
    check('…saved again with nothing on integration: no removal listed', (await save.locator('[data-removal]').count()) === 0, (await text(save)).slice(0, 600))
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    const gone = await waitHung(async () => (((await inv('workflow:form', fx.alpha))?.options?.otherTargets ?? []).includes('integration') ? null : true)).catch(() => null)
    check('…integration is taken out of Other branches work can merge into', !!gone, JSON.stringify((await inv('workflow:form', fx.alpha))?.options))
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
