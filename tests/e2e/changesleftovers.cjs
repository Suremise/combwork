// The Changes tab's leftover branches (HI-1823). A project whose work goes to 1.0.0, with Darren's five leftovers:
// hive/hb3 (an agent's branch from before slots) and the HI-1151 and HI-1153 card branches, merged into 1.0.0, and the
// superseded HI-1640 and HI-1716, with 2 commits each 1.0.0 hasn't. Never offered: main, 1.0.0, a branch checked out in
// a worktree, and the branch of slot-a, lent to a blocked card (slot-c's case: listed under Slots instead). The picker's
// Leftover branches (5) opens them, grouped merged or not with the commits counted; Compare opens HI-1824's comparison
// against 1.0.0; Delete takes one confirm when merged, and lists the commits first when not (Cancel keeps it). Main checks
// each deletion again: a branch checked out in a worktree while its dialog was open, and one that moved meanwhile, are
// kept, saying why. (An open card taking a branch meanwhile is the same check, branchUseNow: tests/gitRepo.test.ts.)
// Screenshots in both themes. The repository is made with the suite's own git; throwaway profile and workspace; quiet;
// no agent is started.
// Dev build only (#1578): slot-a is lent through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'changesleftovers-profile')
const ws = path.join(lib.WORK, 'changesleftovers-ws')
const proj = path.join(ws, 'proj')
const outside = path.join(lib.WORK, 'changesleftovers-wt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a]).trim()
const heads = () => git(proj, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean)
/** A branch from `from` with `n` commits of its own, made as a terminal would (commit-tree: nothing checked out). */
function branch(name, from, n) {
  let tip = git(proj, 'rev-parse', from)
  for (let i = 1; i <= n; i++) tip = git(proj, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', `${name} work ${i}`)
  git(proj, 'branch', name, tip)
}

const L = {
  hb3: 'hive/hb3',
  c1151: 'hive/HI/HI-1151-flake-liveinforeads',
  c1153: 'hive/HI/HI-1153-flakes-under-load',
  c1640: 'hive/HI/HI-1640-the-repository-lock',
  c1716: 'hive/HI/HI-1716-wsoverview-e2e-fails'
}

;(async () => {
  for (const d of [userData, ws, outside]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  git(ws, 'init', '-q', '-b', 'main', proj)
  fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n')
  git(proj, 'add', '-A')
  git(proj, 'commit', '-qm', 'init')
  branch('1.0.0', 'main', 3)
  // Merged into 1.0.0: at commits it has.
  git(proj, 'branch', L.hb3, '1.0.0~2')
  git(proj, 'branch', L.c1151, '1.0.0~1')
  git(proj, 'branch', L.c1153, '1.0.0')
  // Superseded: 2 commits each that 1.0.0 hasn't.
  branch(L.c1640, '1.0.0~1', 2)
  branch(L.c1716, '1.0.0', 2)
  // In use: one checked out in a worktree.
  git(proj, 'worktree', 'add', '-q', '-b', 'hive/in-a-worktree', outside, '1.0.0')

  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 860 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', proj, { preset: null, options: { target: '1.0.0' } })
    // slot-a lent to card 1758 (blocked: no agent works there) on its card's branch.
    const b1 = await lib.addAgent(inv, proj, { name: 'B1' })
    const lent = await inv('slots:test', proj, { op: 'lend', agent: b1.id, card: 1758 })
    check('slot-a is lent to card 1758', lent?.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    git(lent.slot.folder, 'checkout', '-q', '-b', 'hive/HI/HI-1758-blocked')
    const text = (loc) => loc.innerText().catch(() => '')
    const theme = async (t) => {
      await inv('settings:update', { appearance: { theme: t } })
      await lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
    }
    const shots = async (target, name) => {
      await page.mouse.move(5, 5)
      for (const t of ['dark', 'light']) {
        await theme(t)
        await target.screenshot({ path: path.join(lib.WORK, `changesleftovers-${name}-${t}.png`) })
      }
      await theme('dark')
    }

    // --- The picker's entry, and the page.
    await page.getByText('proj', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Version Control' }).click()
    const picker = page.locator('.split-list .changes-picker')
    const entry = picker.locator('option[value="leftovers"]')
    check('the picker offers Leftover branches (5), under Branches', !!(await lib.until(async () => (await entry.count()) === 1 && (await entry.innerText()) === 'Leftover branches (5)', HUNG_MS)) && (await picker.locator('optgroup[label^="Branches"] option[value="leftovers"]').count()) === 1, JSON.stringify(await picker.locator('option').allInnerTexts()))
    check('…and slot-a’s branch under Slots (slot-c’s case), not as a leftover', (await picker.locator('optgroup[label^="Slots"] option').allInnerTexts()).join('|') === 'slot-a · #1758 · hive/HI/HI-1758-blocked')
    await picker.selectOption('leftovers')
    const pageEl = page.locator('[data-leftovers-page]')
    const rows = (merged) => pageEl.locator(`[data-leftover][data-merged="${merged}"]`)
    const names = async (merged) => rows(merged).evaluateAll((els) => els.map((e) => e.getAttribute('data-leftover')))
    check('merged into 1.0.0: hive/hb3, HI-1151’s and HI-1153’s', !!(await lib.until(async () => JSON.stringify(await names('yes')) === JSON.stringify([L.hb3, L.c1151, L.c1153]), HUNG_MS)), JSON.stringify(await names('yes')))
    check('not in 1.0.0: HI-1640’s and HI-1716’s, 2 commits each', JSON.stringify(await names('no')) === JSON.stringify([L.c1640, L.c1716]) && (await rows('no').locator('.leftover-ahead').allInnerTexts()).every((t) => t === '2 commits not in 1.0.0'), await text(pageEl))
    const all = [...(await names('yes')), ...(await names('no'))]
    check('never main, 1.0.0, a worktree’s branch or a slot’s', !['main', '1.0.0', 'hive/in-a-worktree', 'hive/HI/HI-1758-blocked'].some((b) => all.includes(b)), JSON.stringify(all))
    await shots(page, 'page')

    // --- Compare: HI-1640's branch against 1.0.0, then back.
    await pageEl.locator(`[data-leftover="${L.c1640}"] [data-action="compare-leftover"]`).click()
    const cmp = page.locator('[data-compare-page]')
    check('Compare opens the branch against 1.0.0: its 2 commits', !!(await lib.until(async () => (await cmp.getAttribute('data-compare-head').catch(() => null)) === L.c1640 && (await cmp.getAttribute('data-compare-base')) === '1.0.0' && (await page.locator('[data-compare-ahead]').getAttribute('data-compare-ahead').catch(() => null)) === '2', HUNG_MS)), await text(page.locator('.split-main')))
    await picker.selectOption('leftovers')
    await lib.until(async () => (await rows('yes').count()) === 3, HUNG_MS)

    // --- Delete, merged: one confirm.
    await pageEl.locator(`[data-leftover="${L.hb3}"] [data-action="delete-leftover"]`).click()
    const mergedDialog = page.locator('.dialog', { hasText: `Delete ${L.hb3}?` })
    await lib.until(async () => (await mergedDialog.count()) === 1, HUNG_MS)
    await mergedDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a merged one goes on one confirm, and leaves the list', !!(await lib.until(async () => !heads().includes(L.hb3) && (await pageEl.locator(`[data-leftover="${L.hb3}"]`).count()) === 0, HUNG_MS)), JSON.stringify(heads()))

    // --- Delete, unmerged: its commits listed first; Cancel keeps it, Delete Branch removes it.
    const unmergedDialog = page.locator('.dialog', { hasText: `Delete ${L.c1640} and the 2 commits only it has?` })
    await pageEl.locator(`[data-leftover="${L.c1640}"] [data-action="delete-leftover"]`).click()
    await lib.until(async () => (await unmergedDialog.count()) === 1, HUNG_MS)
    const listed = await unmergedDialog.locator('.dialog-list li').allInnerTexts()
    check('an unmerged one lists its 2 commits first, newest first', listed.length === 2 && /work 2/.test(listed[0]) && /work 1/.test(listed[1]), JSON.stringify(listed))
    await shots(unmergedDialog, 'unmerged-dialog')
    await unmergedDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    check('…Cancel keeps it', !!(await lib.until(async () => (await unmergedDialog.count()) === 0, HUNG_MS)) && heads().includes(L.c1640))
    await pageEl.locator(`[data-leftover="${L.c1640}"] [data-action="delete-leftover"]`).click()
    await lib.until(async () => (await unmergedDialog.count()) === 1, HUNG_MS)
    await unmergedDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('…Delete Branch removes it', !!(await lib.until(async () => !heads().includes(L.c1640) && (await pageEl.locator(`[data-leftover="${L.c1640}"]`).count()) === 0, HUNG_MS)), JSON.stringify(heads()))

    // --- Checked again as it goes: checked out in a worktree while its dialog was open: kept, saying why.
    await pageEl.locator(`[data-leftover="${L.c1151}"] [data-action="delete-leftover"]`).click()
    const usedDialog = page.locator('.dialog', { hasText: `Delete ${L.c1151}?` })
    await lib.until(async () => (await usedDialog.count()) === 1, HUNG_MS)
    git(proj, 'worktree', 'add', '-q', `${outside}-2`, L.c1151)
    await usedDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a branch checked out in a worktree meanwhile is kept, saying so', !!(await lib.until(async () => /checked out in a worktree or slot/.test(await text(usedDialog.locator('.dialog-error'))), HUNG_MS)) && heads().includes(L.c1151), await text(usedDialog))
    await usedDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await usedDialog.count()) === 0, HUNG_MS)

    // --- One that moves while its dialog is open: kept at its new commit.
    await pageEl.locator(`[data-leftover="${L.c1716}"] [data-action="delete-leftover"]`).click()
    const movedDialog = page.locator('.dialog', { hasText: `Delete ${L.c1716} and the 2 commits only it has?` })
    await lib.until(async () => (await movedDialog.count()) === 1, HUNG_MS)
    const tip = git(proj, 'commit-tree', `${L.c1716}^{tree}`, '-p', L.c1716, '-m', 'later')
    git(proj, 'update-ref', `refs/heads/${L.c1716}`, tip)
    await movedDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a branch that moved while its dialog was open is kept, at its new commit', !!(await lib.until(async () => /has moved since you were shown it/.test(await text(movedDialog.locator('.dialog-error'))), HUNG_MS)) && git(proj, 'rev-parse', L.c1716) === tip, await text(movedDialog))
    await movedDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await movedDialog.count()) === 0, HUNG_MS)
    check('the slot’s and the worktree’s branches untouched', heads().includes('hive/HI/HI-1758-blocked') && heads().includes('hive/in-a-worktree'))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
