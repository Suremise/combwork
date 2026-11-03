// Project removal on slots (#1447, SPEC §8): beta has a clean free slot, a free slot with unmerged commits, a review
// copy and R1's retired home (its own worktree from before 1.0, adopted at the upgrade, #1441). Remove Project…'s dialog
// lists them with what Remove from Hive does to each (the kept ones first, with why), screenshots in light and dark;
// then Remove from Hive removes the clean slot and the copy through their pools' guarded clean-up, keeps the slot with
// unmerged work and the home, and says so in its result. With Delete chosen, the dialog sends every one to the Recycle Bin
// with the project instead (#1447, HR1's round 1: the repository goes with it), screenshots too. Dev build, throwaway profile and workspace; no agent runs.
// Dev build only (#1580): beta's slots, review copy and leases are made through slots:test, which a packaged build
// refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const at = (x) => path.join(lib.WORK, `removeprojectslots-${x}`)
const userData = at('profile')
const ws = at('ws')
const shots = at('shots')
const beta = path.join(ws, 'beta')
const trees = path.join(`${ws}.worktrees`, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const identity = ['-c', 'user.name=Hive Slot Test', '-c', 'user.email=slots@example.com']

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.hive/\n' })
  lib.git(beta, ['branch', '-M', 'main'])
  lib.git(beta, ['worktree', 'add', '-q', '-b', 'hive/hr1', path.join(trees, 'hr1'), 'main'])
  fs.mkdirSync(path.join(beta, '.hive'), { recursive: true })
  fs.writeFileSync(
    path.join(beta, '.hive', 'project.json'),
    JSON.stringify({
      version: 2,
      platform: 'git',
      agents: [
        { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder' },
        { id: 'b2', name: 'B2', provider: 'claude-code', workflowRole: 'builder' },
        { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer', worktree: { path: path.join(trees, 'hr1'), branch: 'hive/hr1', base: 'main' } }
      ]
    }, null, 2)
  )
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 900 } })
  const until = (fn, ms) => lib.until(fn, ms, 250)
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    check('R1’s worktree is a retired home', !!(await until(async () => (await inv('project:removalInfo', beta)).folders?.some((f) => f.of.kind === 'home'), HUNG_MS)))
    // Two slots lent and given back: slot-a clean, slot-b with a commit its target hasn't.
    const op = (o) => inv('slots:test', beta, o)
    const a = await op({ op: 'lend', agent: 'b1', card: 91 })
    const b = await op({ op: 'lend', agent: 'b2', card: 92 })
    check('two slots lent', a.ok && b.ok && a.slot.name === 'slot-a' && b.slot.name === 'slot-b', JSON.stringify([a, b]))
    fs.writeFileSync(path.join(b.slot.folder, 'work.txt'), 'work\n')
    lib.git(b.slot.folder, [...identity, 'add', '-A'])
    lib.git(b.slot.folder, [...identity, 'commit', '-q', '-m', 'unmerged'])
    await op({ op: 'release', lease: a.lease.id, why: 'done' })
    await op({ op: 'release', lease: b.lease.id, why: 'done' })
    // A free review copy, as #1435's pool keeps one (its worktree, detached, and its row).
    const copy = path.join(trees, 'copies', 'copy-1')
    lib.git(beta, ['worktree', 'add', '-q', '--detach', copy])
    const id = JSON.parse(fs.readFileSync(path.join(beta, '.hive', 'project.json'), 'utf8')).id
    const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
    try {
      const now = new Date().toISOString()
      db.prepare("INSERT INTO copies (project, name, folder, state, created_at, used_at) VALUES (?, 'copy-1', ?, 'free', ?, ?)").run(id, copy, now, now)
    } finally {
      db.close()
    }

    // The dialog: what Remove from Hive does to each.
    const info = await until(async () => {
      const i = await inv('project:removalInfo', beta)
      return i.folders?.length === 4 ? i : null
    }, HUNG_MS)
    const kept = (name) => info?.folders.find((f) => (f.of.kind === 'home' ? 'home' : f.of.name) === name)?.kept
    check('the clean free slot and the copy would go', kept('slot-a') === null && kept('copy-1') === null, JSON.stringify(info?.folders))
    check('…the slot with unmerged work and the home would stay, with why', /commits that aren't on main/.test(kept('slot-b') ?? '') && /conversations resume there/.test(kept('home') ?? ''), JSON.stringify(info?.folders))
    await page.locator('.project-row', { hasText: 'beta' }).click()
    await page.locator('.project-header').getByRole('button', { name: 'More actions' }).click()
    await page.locator('.menu .menu-item', { hasText: 'Remove Project…' }).click()
    const rd = page.locator('.dialog', { hasText: 'Remove beta' })
    await rd.waitFor({ timeout: HUNG_MS })
    await rd.locator('label.choice', { hasText: 'Remove from Combwork' }).click()
    const text = async () => (await rd.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('the dialog lists them, the kept ones first, with why', !!(await until(async () => /4 slots, copies and old folders/.test(await text()) && /slot-b[^]*kept: it has commits that aren't on main/.test(await text()) && /R1.s old folder[^]*kept: left as it is/.test(await text()) && /slot-a[^]*removed/.test(await text()) && /copy-1[^]*removed/.test(await text()), HUNG_MS)), await text())
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS)
      await page.screenshot({ path: path.join(shots, `removeprojectslots-dialog-${theme}.png`) })
    }
    // Delete: every one to the Recycle Bin with the project (the repository goes too), none kept behind.
    await rd.locator('label.choice').nth(2).click() // Hide, Remove from Combwork, Delete
    check('…with Delete, every one goes to the Recycle Bin with the project', !!(await until(async () => /4 slots, copies and old folders[^]*to the Recycle Bin, with what is in them/.test(await text()) && (await text()).split('to the Recycle Bin').length >= 5 && !/kept:/.test(await text()), HUNG_MS)), await text())
    for (const theme of ['light', 'dark']) {
      await inv('settings:update', { appearance: { theme } })
      await until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme), HUNG_MS)
      await page.screenshot({ path: path.join(shots, `removeprojectslots-delete-${theme}.png`) })
    }
    await page.keyboard.press('Escape')
    await until(async () => (await rd.count()) === 0, HUNG_MS)

    // Remove from Hive: the guarded clean-up, the rest kept and said.
    const done = await inv('project:remove', beta, 'remove')
    const said = done.warnings.join('\n')
    check('the result says what stayed, with why', /Left in place: slot-b( \([^)]*\))? at .* \(it has commits that aren't on main\)/.test(said) && /Left in place: R1.s old folder at .* \(left as it is/.test(said), said)
    check('the clean slot and the copy are gone', !fs.existsSync(a.slot.folder) && !fs.existsSync(copy))
    check('…the slot with unmerged work and the home are still there', fs.existsSync(b.slot.folder) && fs.existsSync(path.join(trees, 'hr1')))
    const listed = lib.git(beta, ['worktree', 'list', '--porcelain']).toLowerCase().replace(/\//g, '\\')
    check('…and git no longer lists the removed ones', !listed.includes(a.slot.folder.toLowerCase()) && !listed.includes(copy.toLowerCase()) && listed.includes(b.slot.folder.toLowerCase()), listed)
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
