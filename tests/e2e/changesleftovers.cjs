// The Changes tab's leftover branches (HI-1823), on real cards (queueFixture.cjs's project, its work merging into
// `integration`; fake Claude Code builders starting cards by their own tokens, the Assistant off):
// - leftovers: hive/hb3 (an agent's branch from before slots, merged), card A's line (2 commits of its own; moved to Done
//   by the user, superseded, and archived), card B's line (Done, then merged into integration by hand: its card chip
//   shows Done), card E's line (Done, 1 commit of its own). Combwork keeps a Done card's line only while it has commits of
//   its own (one with none is deleted at Done), so B's and E's have one. Tags named as integration and as B's line
//   don't change their names (HR1's round 1);
// - never offered: main, integration, the open card C's line (Active, in its slot), and blocked card D's line, whose slot
//   is listed under Slots with D's key (slot-c's case);
// - Leftover branches (N) groups them merged or not with A's 2 commits counted; Compare opens A's line against
//   integration; Delete takes one confirm when merged (hb3), and lists the commits first when not (A's: Cancel keeps it,
//   Delete Branch removes it);
// - main checks each deletion again: E reopened (back to Active) while its dialog was open, a branch checked out in a
//   worktree meanwhile, and one that moved, are each kept, saying why.
// Screenshots in both themes. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): its cards' slots are lent by the pool as a dev build's test copies lend them.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47863))
const fx = q.queueProject('changesleftovers')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const git = (cwd, ...a) => lib.git(cwd, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, '-c', 'core.autocrlf=false', ...a]).trim()
const heads = () => git(fx.alpha, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(Boolean).map((r) => r.slice('refs/heads/'.length))

;(async () => {
  q.prepare(fx)
  // hive/hb3: an agent's branch from before slots, at integration's commit (merged). A tag named as integration.
  git(fx.alpha, 'branch', 'hive/hb3', 'integration')
  git(fx.alpha, 'tag', 'integration', 'main')
  const h = await q.startHive(fx, { port: PORT })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
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
    /** A card started by a builder of its own on the slot its start lends: { n, key, line, folder, builder }. */
    const started = async (title, builderName) => {
      const n = (await inv('tasks:create', { title, project: 'alpha' })).number
      const builder = await q.agent(fx, h, builderName)
      const s = await q.startCard(fx, h, builder, n)
      check(`${title}: started on its line`, s.status === 200 && !!s.body?.data?.line, JSON.stringify(s.body))
      return { n, key: (await h.card(n)).key, line: s.body?.data?.line, folder: builder.folder, builder }
    }
    const commitIn = (folder, file) => {
      fs.writeFileSync(path.join(folder, file), `${file}\n`)
      git(folder, 'add', '-A')
      git(folder, 'commit', '-qm', `add ${file}`)
    }
    const doneByUser = async (n, reason) => {
      const r = await inv('tasks:move', n, 'done', { confirm: true, reason })
      check(`card #${n} moved to Done by the user`, !!(await lib.until(async () => (await h.card(n))?.column === 'done', HUNG_MS)), JSON.stringify(r))
    }

    // --- The cards.
    const A = await started('Superseded work', 'BA')
    commitIn(A.folder, 'a1.txt')
    commitIn(A.folder, 'a2.txt')
    const B = await started('Done, merged by hand', 'BB')
    commitIn(B.folder, 'b.txt')
    const E = await started('Done, to reopen', 'BE')
    commitIn(E.folder, 'e.txt')
    const C = await started('Open card', 'BC')
    commitIn(C.folder, 'c.txt')
    const D = await started('Blocked card', 'BD')
    await inv('tasks:update', D.n, { blocked: 'Waiting for a decision' })
    await doneByUser(A.n, 'Superseded by another card')
    await inv('tasks:archive', A.n, true)
    await doneByUser(B.n, 'Merged by hand')
    await doneByUser(E.n, 'Set aside')
    // Their slots, free now, keep each line checked out (so in use: a worktree's) until the pool lends them again; the
    // next card's start moves each off it, as here (Darren's leftovers had no worktree left).
    for (const x of [A, B, E]) git(x.folder, 'checkout', '-q', '--detach')
    q.mergeOn(fx, 'integration', git(fx.alpha, 'rev-parse', `refs/heads/${B.line}`), 'Merge B by hand')
    // A tag named as B's line (HR1's round 1: never `heads/…`).
    git(fx.alpha, 'tag', B.line, 'main')

    // --- The picker and the page.
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Version Control' }).click()
    const picker = page.locator('.split-list .changes-picker')
    const entry = picker.locator('option[value="leftovers"]')
    check('the picker offers Leftover branches (4), under Branches', !!(await lib.until(async () => (await entry.count()) === 1 && (await entry.innerText()) === 'Leftover branches (4)', HUNG_MS)), JSON.stringify(await picker.locator('option').allInnerTexts()))
    const slotLabels = await picker.locator('optgroup[label^="Slots"] option').allInnerTexts()
    check('the blocked card’s slot is listed under Slots, with its key and line (slot-c’s case)', slotLabels.some((l) => l.endsWith(` · ${D.key} · ${D.line}`)), JSON.stringify(slotLabels))
    await picker.selectOption('leftovers')
    const pageEl = page.locator('[data-leftovers-page]')
    const rows = (merged) => pageEl.locator(`[data-leftover][data-merged="${merged}"]`)
    const names = async (merged) => rows(merged).evaluateAll((els) => els.map((e) => e.getAttribute('data-leftover')))
    check('merged into integration: hive/hb3 and B’s line, by their names', !!(await lib.until(async () => JSON.stringify((await names('yes')).sort()) === JSON.stringify(['hive/hb3', B.line].sort()), HUNG_MS)), JSON.stringify(await names('yes')))
    check('not in integration: A’s line (Done, archived) with its 2 commits, E’s with 1', JSON.stringify(await names('no')) === JSON.stringify([A.line, E.line]) && JSON.stringify(await rows('no').locator('.leftover-ahead').allInnerTexts()) === JSON.stringify(['2 commits not in integration', '1 commit not in integration']), await text(pageEl))
    const all = [...(await names('yes')), ...(await names('no'))]
    check('never main, integration, the open card’s line or the blocked card’s', !['main', 'integration', C.line, D.line].some((b) => all.includes(b)) && !all.some((b) => b.startsWith('heads/')), JSON.stringify(all))
    const chip = pageEl.locator(`[data-leftover="${B.line}"] [data-branch-card]`)
    check('B’s row shows its card, Done', (await chip.getAttribute('data-branch-card').catch(() => null)) === String(B.n) && (await chip.getAttribute('data-stage')) === 'done', await text(pageEl.locator(`[data-leftover="${B.line}"]`)))
    await shots(page, 'page')

    // --- Compare: A's line against integration.
    await pageEl.locator(`[data-leftover="${A.line}"] [data-action="compare-leftover"]`).click()
    const cmp = page.locator('[data-compare-page]')
    check('Compare opens A’s line against integration: its 2 commits', !!(await lib.until(async () => (await cmp.getAttribute('data-compare-head').catch(() => null)) === A.line && (await cmp.getAttribute('data-compare-base')) === 'integration' && (await page.locator('[data-compare-ahead]').getAttribute('data-compare-ahead').catch(() => null)) === '2', HUNG_MS)), await text(page.locator('.split-main')))
    await picker.selectOption('leftovers')
    await lib.until(async () => (await rows('yes').count()) === 2, HUNG_MS)

    // --- Checked again as it goes: E reopened (Active again) while its dialog was open: kept, saying why.
    await pageEl.locator(`[data-leftover="${E.line}"] [data-action="delete-leftover"]`).click()
    const eDialog = page.locator('.dialog', { hasText: `Delete ${E.line} and the commit only it has?` })
    await lib.until(async () => (await eDialog.count()) === 1, HUNG_MS)
    await inv('tasks:move', E.n, 'doing', { confirm: true, reason: 'Reopened' })
    await lib.until(async () => (await h.card(E.n))?.column === 'doing', HUNG_MS)
    await eDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a leftover whose card is reopened meanwhile is kept, saying an open card works on it', !!(await lib.until(async () => /An open card works on/.test(await text(eDialog.locator('.dialog-error'))), HUNG_MS)) && heads().includes(E.line), await text(eDialog))
    await eDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await eDialog.count()) === 0, HUNG_MS)
    check('…and leaves the list, in use now', !!(await lib.until(async () => (await pageEl.locator(`[data-leftover="${E.line}"]`).count()) === 0, HUNG_MS)))

    // --- A branch checked out in a worktree while its dialog was open: kept.
    await pageEl.locator('[data-leftover="hive/hb3"] [data-action="delete-leftover"]').click()
    const hbDialog = page.locator('.dialog', { hasText: 'Delete hive/hb3?' })
    await lib.until(async () => (await hbDialog.count()) === 1, HUNG_MS)
    const wt = path.join(lib.probeDir('changesleftovers'), 'wt')
    git(fx.alpha, 'worktree', 'add', '-q', wt, 'hive/hb3')
    await hbDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a branch checked out in a worktree meanwhile is kept, saying so', !!(await lib.until(async () => /checked out in a worktree or slot/.test(await text(hbDialog.locator('.dialog-error'))), HUNG_MS)) && heads().includes('hive/hb3'), await text(hbDialog))
    await hbDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await hbDialog.count()) === 0, HUNG_MS)
    // Free again: merged, deleted on one confirm.
    git(fx.alpha, 'worktree', 'remove', '--force', wt)
    // Changed outside Combwork: read again.
    await pageEl.locator('[data-action="refresh-leftovers"]').click()
    check('…free again once its worktree is gone, read again', !!(await lib.until(async () => (await pageEl.locator('[data-leftover="hive/hb3"]').count()) === 1, HUNG_MS)))
    await pageEl.locator('[data-leftover="hive/hb3"] [data-action="delete-leftover"]').click()
    await lib.until(async () => (await hbDialog.count()) === 1, HUNG_MS)
    await hbDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('a merged one goes on one confirm, and leaves the list; the tag of integration untouched', !!(await lib.until(async () => !heads().includes('hive/hb3') && (await pageEl.locator('[data-leftover="hive/hb3"]').count()) === 0, HUNG_MS)) && git(fx.alpha, 'tag', '--list', 'integration') === 'integration', JSON.stringify(heads()))

    // --- A's line: its 2 commits listed first; one that moves while the dialog is open is kept; then Cancel, then Delete.
    const aDialog = page.locator('.dialog', { hasText: `Delete ${A.line} and the 2 commits only it has?` })
    await pageEl.locator(`[data-leftover="${A.line}"] [data-action="delete-leftover"]`).click()
    await lib.until(async () => (await aDialog.count()) === 1, HUNG_MS)
    const listed = await aDialog.locator('.dialog-list li').allInnerTexts()
    check('an unmerged one lists its 2 commits first, newest first', listed.length === 2 && /add a2\.txt/.test(listed[0]) && /add a1\.txt/.test(listed[1]), JSON.stringify(listed))
    await shots(aDialog, 'unmerged-dialog')
    await aDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    check('…Cancel keeps it', !!(await lib.until(async () => (await aDialog.count()) === 0, HUNG_MS)) && heads().includes(A.line))
    await pageEl.locator(`[data-leftover="${A.line}"] [data-action="delete-leftover"]`).click()
    await lib.until(async () => (await aDialog.count()) === 1, HUNG_MS)
    const tip = git(fx.alpha, 'commit-tree', `${A.line}^{tree}`, '-p', `refs/heads/${A.line}`, '-m', 'later')
    git(fx.alpha, 'update-ref', `refs/heads/${A.line}`, tip)
    await aDialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('one that moved while its dialog was open is kept, at its new commit', !!(await lib.until(async () => /has moved since you were shown it/.test(await text(aDialog.locator('.dialog-error'))), HUNG_MS)) && git(fx.alpha, 'rev-parse', `refs/heads/${A.line}`) === tip, await text(aDialog))
    await aDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await lib.until(async () => (await aDialog.count()) === 0, HUNG_MS)
    const a3Dialog = page.locator('.dialog', { hasText: `Delete ${A.line} and the 3 commits only it has?` })
    await lib.until(async () => /3 commits not in integration/.test(await text(pageEl.locator(`[data-leftover="${A.line}"]`))), HUNG_MS)
    await pageEl.locator(`[data-leftover="${A.line}"] [data-action="delete-leftover"]`).click()
    await lib.until(async () => (await a3Dialog.count()) === 1, HUNG_MS)
    await a3Dialog.getByRole('button', { name: 'Delete Branch', exact: true }).click()
    check('…read again, its 3 commits listed, Delete Branch removes it', !!(await lib.until(async () => !heads().includes(A.line) && (await pageEl.locator(`[data-leftover="${A.line}"]`).count()) === 0, HUNG_MS)), JSON.stringify(heads()))
    check('the open card’s, the blocked card’s and the reopened card’s lines untouched', heads().includes(C.line) && heads().includes(D.line) && heads().includes(E.line) && heads().includes(B.line))
  } finally {
    await h.app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
