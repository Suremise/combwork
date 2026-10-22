// Repair a Moved Workspace moves Hive's Defender exclusions to the new folders (#1302), on fixtures only:
// HIVE_TEST_ANTIVIRUS stands in for every PowerShell call (the probe, and the elevated add and move on a simulated
// exclusion list) and HIVE_TEST_ANTIVIRUS_LOG records them, so this suite never reads or changes the machine's Defender
// settings nor raises an administrator prompt. Before: workspace Scratch, whose worktrees folder the user had excluded
// themselves; Hive's Add excludes the workspace. Moved to Tools, Repair's table has a Microsoft Defender group: the
// workspace's row moves Hive's exclusion (the box under the table, ticked), the worktrees' is the user's own (named, never
// changed), each folder with its state and where the states come from (Hive's administrator read, dated); unticked, the
// row leaves it; while Defender is still being read, Repair waits. Repair runs one elevated move, last: Hive's old entry
// removed, the new folder added, the report says so, and the Antivirus status follows. Moved again with the box unticked:
// no elevated run. Moved again with Defender ignoring local changes (an organisation's policy): the report says so and
// nothing is remembered as Hive's. Last, moved inside its old folder: with the list hidden the states are what Hive
// knows and an unknown folder is never called scanned; with it shown the new workspace is Excluded only through Hive's
// old entry, and Repair still excludes it. Then (#1389) moved again with Repair's prompt declined: Repair finishes,
// and the Antivirus panel lists Hive's exclusions of folders that are gone, which Remove Hive's Exclusions… takes away.
// Screenshots in both themes, the plan in German and Polish, the gone exclusions in German.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000
const userData = path.join(lib.WORK, 'repairdefender-profile')
const home = path.join(lib.WORK, 'repairdefender-claude-home')
const base = path.join(lib.WORK, 'repairdefender')
const fixture = path.join(lib.WORK, 'repairdefender-fixture.json')
const callLog = path.join(lib.WORK, 'repairdefender-calls.log')
for (const d of [userData, home, base, fixture, callLog]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(base, { recursive: true })
const root = fs.realpathSync.native(base)
const at = (name) => ({ ws: path.join(root, name), trees: path.join(root, `${name}.worktrees`) })
const [scratch, tools, third, fourth] = ['Scratch', 'Tools', 'Third', 'Fourth'].map(at)
const tests = fs.realpathSync.native(path.join(process.env.LOCALAPPDATA, 'hive-test'))

const drive = path.parse(root).root[0].toUpperCase()
const DEFENDER_ON = 397568
// Defender's list hidden without administrator rights: the states come from Hive's last administrator read (its Add).
const probe = { defender: { antivirus: true, realTime: true, mode: 'Normal' }, exclusions: ['N/A: Must be an administrator to view exclusions'], perfMode: 1, products: [{ name: 'Windows Defender', state: DEFENDER_ON }], volumes: [{ drive, fs: 'NTFS' }] }
// `over` changes the probe's answer (a list Defender shows now); `elevated` is the machine's list as administrator rights
// see it, simulated by each copy of Hive from its first elevated run.
const setFixture = (elevated, over = {}) => fs.writeFileSync(fixture, JSON.stringify({ probe: { ...probe, ...over }, elevated }))
const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const changes = (kind) => calls().filter((c) => c.call !== 'probe' && (!kind || c.call === kind))
// A dev build offers Hive's test area too, and it holds this suite's folders: excluded, it would cover every one of them.
// So between runs of Hive the machine's list and Hive's memory of it never hold it (the profile's config.json).
const forgetTests = () => {
  const file = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  const other = (p) => path.resolve(p).toLowerCase() !== tests.toLowerCase()
  const a = cfg.antivirus ?? {}
  cfg.antivirus = { ...a, ...(a.added ? { added: a.added.filter(other) } : {}), ...(a.adminCheck ? { adminCheck: { ...a.adminCheck, exclusions: a.adminCheck.exclusions.filter(other) } } : {}) }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}
// Hive's administrator read forgotten: with Defender's list hidden, only Hive's record of its own exclusions is known.
const forgetAdmin = () => {
  const file = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete cfg.antivirus?.adminCheck
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}
const moveWorkspace = (from, to) => {
  fs.renameSync(from.ws, to.ws)
  fs.renameSync(from.trees, to.trees)
}

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  lib.gitProject(path.join(scratch.ws, 'alpha'))
  fs.mkdirSync(scratch.trees, { recursive: true })
  const env = { ...lib.fakeClaude(userData, home, [path.join(scratch.ws, 'alpha')]), HIVE_TEST_ANTIVIRUS: fixture, HIVE_TEST_ANTIVIRUS_LOG: callLog }
  const launch = (lang) => lib.launch({ userData, env: { ...env, ...(lang ? { HIVE_LANG: lang } : {}) }, viewport: { width: 1400, height: 950 } })

  // The repair dialog, from the banner; openRepair waits for its Defender rows too.
  const openDialog = async (page) => {
    const banner = page.locator('.moved-banner')
    await lib.until(async () => (await banner.count()) === 1, HUNG_MS)
    await banner.locator('button.primary').click()
    return page.locator('.dialog', { has: page.locator('.move-repair') })
  }
  const openRepair = async (page) => {
    const dialog = await openDialog(page)
    await lib.until(async () => (await dialog.locator('.repair-defender').count()) === 1, HUNG_MS)
    return dialog
  }
  const textOf = async (dialog) => (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')

  // Scratch: the user excluded its worktrees folder themselves; Hive's Add excludes the workspace (and the test area).
  setFixture({ exclusions: [scratch.trees] })
  {
    const { app, page, inv } = await launch()
    try {
      await lib.openWorkspace(inv, page, scratch.ws)
      const prepared = await inv('antivirus:prepare', 'add')
      const { result } = await inv('antivirus:apply', prepared.id)
      check('before: Hive excluded the workspace, the user the worktrees', result.outcome === 'done' && JSON.stringify(result.added) === JSON.stringify([scratch.ws, tests]), JSON.stringify(result))
      check('…and Repair’s move can’t be asked for from Settings', !!(await inv('antivirus:prepare', 'move').then(() => null, (e) => String(e.message ?? e))))
    } finally {
      await app.close()
    }
  }
  forgetTests()
  moveWorkspace(scratch, tools)
  // The machine's list as administrator rights see it now (each copy of Hive simulates it from the fixture).
  setFixture({ exclusions: [scratch.trees, scratch.ws] })

  // The plan in German and Polish: looked at, not repaired.
  for (const lang of ['de', 'pl']) {
    const { app, page, inv } = await launch(lang)
    try {
      await lib.openWorkspace(inv, page, tools.ws)
      await openRepair(page)
      await page.screenshot({ path: path.join(lib.WORK, `repairdefender-plan-${lang}.png`) })
    } finally {
      await app.close()
    }
  }

  {
    const { app, page, inv } = await launch()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    try {
      await lib.openWorkspace(inv, page, tools.ws)
      const plan = await inv('workspace:moveDefender')
      check('the plan: Hive’s exclusion of the old workspace moves to the new one; the user’s of the old worktrees is only named', JSON.stringify([plan?.remove, plan?.add, plan?.theirs]) === JSON.stringify([[scratch.ws], [tools.ws], [scratch.trees]]), JSON.stringify(plan))
      check('…its states from Hive’s administrator read', plan?.exclusionsFrom === 'admin-check' && JSON.stringify(plan.old.map((p) => p.state)) === JSON.stringify(['excluded', 'excluded']) && JSON.stringify(plan.now.map((p) => p.state)) === JSON.stringify(['not-excluded', 'not-excluded']), JSON.stringify(plan))
      const before = changes().length
      // Defender's read held (slow): the plan shows, but Repair waits for it, so the box's default can't be skipped.
      await app.evaluate(() => {
        process.env.HIVE_TEST_SLOW_IPC = 'workspace:moveDefender=6000*1'
      })
      const dialog = await openDialog(page)
      const waiting = () =>
        page.evaluate(() => {
          const d = document.querySelector('.move-repair')?.closest('.dialog')
          const repair = [...(d?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Repair')
          return !!d && /Reading Defender's exclusions…/.test(d.textContent ?? '') && !!d.querySelector('.repair-plan') && !!repair?.disabled
        })
      check('while Defender is read, the plan shows and Repair waits', !!(await lib.until(waiting, HUNG_MS)))
      await lib.until(async () => (await dialog.locator('.repair-defender').count()) === 1, HUNG_MS)
      check('…then Repair can be chosen', !!(await lib.until(() => dialog.getByRole('button', { name: 'Repair', exact: true }).isEnabled(), HUNG_MS)))
      const box = dialog.locator('.repair-defender input[type="checkbox"]')
      check('the table has a Microsoft Defender group: the workspace’s exclusion to move, each folder with its state', /Microsoft Defender/i.test(await textOf(dialog)) && (await textOf(dialog)).includes(`The workspace (every project in it): was ${scratch.ws} (Excluded), now ${tools.ws} (Scanned); will move Hive's exclusion`), await textOf(dialog))
      check('…the worktrees’ exclusion is the user’s: named, not changed', (await textOf(dialog)).includes(`Its worktrees: was ${scratch.trees} (Excluded), now ${tools.trees} (Scanned); will yours: change it in Windows Security`) && /Hive never changes yours/.test(await textOf(dialog)), await textOf(dialog))
      check('…the box under the table, ticked: one administrator prompt', (await box.isChecked()) && /Move Hive's exclusion to the new folders \(one administrator prompt\)/.test(await textOf(dialog)), await textOf(dialog))
      check('…saying where the states come from: Hive’s administrator read, with its date, read again before any change', /As Defender listed its exclusions with administrator rights, .+\. Repair's administrator prompt reads Defender's list again before it changes anything\./.test(await textOf(dialog)), await textOf(dialog))
      check('opening the dialog changed nothing', changes().length === before, JSON.stringify(changes().slice(before)))
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-plan-dark.png') })
      await box.uncheck()
      check('unticked: the workspace’s row leaves Hive’s exclusion', !!(await lib.until(async () => (await textOf(dialog)).includes("; will leave Hive's exclusion as it is"), HUNG_MS)), await textOf(dialog))
      await inv('settings:update', { appearance: { theme: 'light' } })
      await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), HUNG_MS)
      await box.check()
      await lib.until(async () => (await textOf(dialog)).includes("; will move Hive's exclusion"), HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-plan-light.png') })

      await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
      check('Repair moves them: the report says so', !!(await lib.until(async () => /Moved Hive's exclusions to the new folders: 1 removed, 1 added\./.test(await textOf(dialog)), HUNG_MS)), await textOf(dialog))
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-report-light.png') })
      const moves = changes('move')
      check('…in one elevated run: exactly Hive’s old entry removed and the new workspace added', moves.length === 1 && JSON.stringify(moves[0].remove) === JSON.stringify([scratch.ws]) && JSON.stringify(moves[0].paths) === JSON.stringify([tools.ws]), JSON.stringify(changes()))
      check('…the user’s exclusion left alone', JSON.stringify(changes('move-requested').map((c) => [c.remove, c.paths])) === JSON.stringify([[[scratch.ws], [tools.ws]]]), JSON.stringify(changes('move-requested')))
      const s = await inv('antivirus:status', true)
      const state = (p) => s.paths.find((x) => x.path === p)
      check('the Antivirus status follows: the new workspace excluded, as Hive’s; its worktrees scanned', state(tools.ws)?.state === 'excluded' && state(tools.ws)?.addedByHive && state(tools.trees)?.state === 'not-excluded' && !state(tools.trees)?.addedByHive, JSON.stringify(s.paths))
      await inv('settings:update', { appearance: { theme: 'dark' } })
      await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-report-dark.png') })
    } finally {
      await app.close()
    }
  }

  // Moved again, the box unticked: no elevated run. Hive's Add then excludes Third's folders, for the last move.
  moveWorkspace(tools, third)
  setFixture({ exclusions: [scratch.trees, tools.ws] })
  {
    const { app, page, inv } = await launch()
    try {
      await lib.openWorkspace(inv, page, third.ws)
      const dialog = await openRepair(page)
      await dialog.locator('.repair-defender input[type="checkbox"]').uncheck()
      const before = changes().length
      await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
      check('unticked: Repair runs nothing elevated, and says nothing of Defender', !!(await lib.until(async () => /Close/.test(await textOf(dialog)) && (await dialog.locator('.btn.primary', { hasText: 'Close' }).count()) === 1, HUNG_MS)) && changes().length === before && !/exclusions/.test(await textOf(dialog)), JSON.stringify({ calls: changes().slice(before), text: await textOf(dialog) }))
      await dialog.locator('.btn.primary', { hasText: 'Close' }).click()
      const prepared = await inv('antivirus:prepare', 'add')
      const { result } = await inv('antivirus:apply', prepared.id)
      check('Hive’s Add excludes Third and its worktrees', result.outcome === 'done' && JSON.stringify(result.added) === JSON.stringify([third.ws, third.trees, tests]), JSON.stringify(result))
    } finally {
      await app.close()
    }
  }

  // Moved again, Defender ignoring local changes (an organisation's policy): said, and nothing remembered as Hive's.
  forgetTests()
  moveWorkspace(third, fourth)
  // The user excluded Fourth's worktrees folder themselves (for the last move).
  setFixture({ exclusions: [scratch.trees, tools.ws, third.ws, third.trees, fourth.trees], policy: true })
  {
    const { app, page, inv } = await launch()
    try {
      await lib.openWorkspace(inv, page, fourth.ws)
      const report = await inv('workspace:moveRepair', { defender: true })
      check('a policy keeps the change from applying: Repair says so, as a failure', report.failed.some((l) => /Defender accepted the change but 3 folders aren't as asked/.test(l)) && !report.done.some((l) => /exclusions/.test(l)), JSON.stringify(report))
      check('…one elevated run, for both kinds', JSON.stringify(changes('move').slice(-1).map((c) => [c.remove, c.paths])) === JSON.stringify([[[third.ws, third.trees], [fourth.ws, fourth.trees]]]), JSON.stringify(changes('move')))
      const s = await inv('antivirus:status', true)
      check('…and nothing of the new folders is remembered as Hive’s', s.paths.every((p) => !p.path.startsWith(fourth.ws) || !p.addedByHive), JSON.stringify(s.paths))
      // Hive's Add for Fourth: the workspace (its worktrees folder is the user's).
      setFixture({ exclusions: [scratch.trees, tools.ws, third.ws, third.trees, fourth.trees] })
      const prepared = await inv('antivirus:prepare', 'add')
      const { result } = await inv('antivirus:apply', prepared.id)
      check('Hive’s Add excludes Fourth', result.outcome === 'done' && JSON.stringify(result.added) === JSON.stringify([fourth.ws, tests]), JSON.stringify(result))
    } finally {
      await app.close()
    }
  }

  // Moved inside its old folder (Fourth\Inner), its worktrees folder left where it was; Hive's administrator read
  // forgotten. With Defender's list hidden: what Hive knows, said as such, and nothing claimed scanned. Then with the
  // list shown: the new workspace shows Excluded only through Hive's old entry, and Repair still excludes it.
  forgetTests()
  forgetAdmin()
  const inner = { ws: path.join(fourth.ws, 'Inner'), trees: path.join(fourth.ws, 'Inner.worktrees') }
  fs.renameSync(fourth.ws, `${fourth.ws}-moving`)
  fs.mkdirSync(fourth.ws)
  fs.renameSync(`${fourth.ws}-moving`, inner.ws)
  const machine = [scratch.trees, tools.ws, third.ws, third.trees, fourth.trees, fourth.ws]
  setFixture({ exclusions: machine })
  {
    const { app, page, inv } = await launch()
    try {
      await lib.openWorkspace(inv, page, inner.ws)
      let dialog = await openRepair(page)
      check('the list hidden, no administrator read: Hive’s own exclusion moves; the states are what Hive knows, said so', (await textOf(dialog)).includes(`The workspace (every project in it): was ${fourth.ws} (Added by Hive), now ${inner.ws} (Unknown); will move Hive's exclusion`) && /Defender shows its exclusions only to administrators: these states are what Hive knows/.test(await textOf(dialog)), await textOf(dialog))
      check('…a folder of unknown state, with no exclusion of Hive’s, is never said to be scanned', (await textOf(dialog)).includes(`Its worktrees: was ${fourth.trees} (Unknown); will nothing (no exclusion of Hive's)`) && !/Defender scans it/.test(await textOf(dialog)), await textOf(dialog))
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-plan-unknown.png') })
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)
      // Defender's list shown now: the new workspace is Excluded, but only through the entry Repair removes.
      setFixture({ exclusions: machine }, { exclusions: machine })
      dialog = await openRepair(page)
      check('the list shown: the new workspace Excluded through Hive’s old entry, still to move, and said to be the list now', (await textOf(dialog)).includes(`The workspace (every project in it): was ${fourth.ws} (Excluded), now ${inner.ws} (Excluded); will move Hive's exclusion`) && /As Defender lists its exclusions now\./.test(await textOf(dialog)), await textOf(dialog))
      const before = changes('move-requested').length
      await dialog.getByRole('button', { name: 'Repair', exact: true }).click()
      check('Repair removes the old entry and excludes the new workspace, no longer covered', !!(await lib.until(async () => /Moved Hive's exclusions to the new folders: 1 removed, 1 added\./.test(await textOf(dialog)), HUNG_MS)), await textOf(dialog))
      check('…in one elevated run', JSON.stringify(changes('move-requested').slice(before).map((c) => [c.remove, c.paths])) === JSON.stringify([[[fourth.ws], [inner.ws]]]), JSON.stringify(changes().slice(-4)))
    } finally {
      await app.close()
    }
  }

  // #1389: moved again (Inner → Fifth) with Repair's administrator prompt declined. Repair finishes and doesn't offer
  // the move again; Hive's exclusion of Inner, a folder that is gone now, stays in Defender's list. The Antivirus panel
  // lists Hive's exclusions of folders that are gone (Inner's, and Tools', left when its move was unticked), and
  // Remove Hive's Exclusions… takes them away. Defender's list hidden, Hive's administrator read forgotten: every one
  // Hive recorded is shown, unconfirmed, until its Remove reads the list.
  forgetTests()
  forgetAdmin()
  const fifth = at('Fifth')
  fs.renameSync(inner.ws, fifth.ws)
  const ours = (p) => (JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).antivirus?.added ?? []).some((x) => path.resolve(x).toLowerCase() === path.resolve(p).toLowerCase())
  setFixture({ exclusions: [scratch.trees, tools.ws, inner.ws, fourth.trees], cancelled: true })
  const command = (app, id) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args: [] })
  {
    const { app, page, inv } = await launch()
    try {
      await lib.openWorkspace(inv, page, fifth.ws)
      check('before: Hive’s exclusions of Inner and Tools are recorded, both folders gone', ours(inner.ws) && ours(tools.ws) && !fs.existsSync(inner.ws) && !fs.existsSync(tools.ws))
      const report = await inv('workspace:moveRepair', { defender: true })
      check('Repair with its prompt declined: said, the rest done', report.skipped.some((l) => /prompt was declined/.test(l)) && report.failed.length === 0, JSON.stringify(report))
      check('…and the move is recorded as repaired: Repair offers no Defender move again', !(await inv('workspace:movePlan')), JSON.stringify(await inv('workspace:movePlan')))
      const s = await inv('antivirus:status', true)
      const gone = (s.gone ?? []).map((g) => g.path)
      check('the status lists Hive’s exclusions of folders that are gone, unconfirmed (the list hidden)', gone.includes(inner.ws) && gone.includes(tools.ws) && (s.gone ?? []).every((g) => g.state === 'added') && !gone.includes(scratch.trees) && !gone.includes(fifth.ws), JSON.stringify(s.gone))
    } finally {
      await app.close()
    }
  }
  // The panel in German, looked at only.
  {
    const { app, page, inv } = await launch('de')
    try {
      await lib.openWorkspace(inv, page, fifth.ws)
      await command(app, 'antivirus.show')
      const gonePanel = page.locator('.antivirus-gone')
      await lib.until(async () => (await gonePanel.count()) === 1, HUNG_MS)
      await gonePanel.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-gone-de.png') })
    } finally {
      await app.close()
    }
  }
  setFixture({ exclusions: [scratch.trees, tools.ws, inner.ws, fourth.trees] })
  {
    const { app, page, inv } = await launch()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    try {
      await lib.openWorkspace(inv, page, fifth.ws)
      await command(app, 'antivirus.show')
      const panel = page.locator('.antivirus')
      const gonePanel = panel.locator('.antivirus-gone')
      const goneText = async () => (await gonePanel.innerText().catch(() => '')).replace(/\s+/g, ' ')
      check('Settings → Workspace → Antivirus scanning lists them under their own heading, each Added by Hive', !!(await lib.until(async () => /Hive’s exclusions of folders that are gone/.test(await goneText()), HUNG_MS)) && (await goneText()).includes(`${inner.ws} Added by Hive`) && (await goneText()).includes(`${tools.ws} Added by Hive`) && /no longer exist \(moved or deleted\)/.test(await goneText()), await goneText())
      await gonePanel.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-gone-dark.png') })
      await inv('settings:update', { appearance: { theme: 'light' } })
      await lib.until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), HUNG_MS)
      await page.screenshot({ path: path.join(lib.WORK, 'repairdefender-gone-light.png') })
      await inv('settings:update', { appearance: { theme: 'dark' } })

      // Remove Hive's Exclusions… covers them (the workspace has none of Hive's: the button is there for them alone).
      await panel.getByRole('button', { name: 'Remove Hive’s Exclusions…' }).click()
      const removeDialog = page.locator('.dialog', { hasText: 'Remove the exclusions Hive added?' })
      await lib.until(async () => (await removeDialog.count()) === 1, HUNG_MS)
      const listedNow = await removeDialog.locator('.dialog-list li').allInnerTexts()
      check('Remove lists them, Hive’s alone', listedNow.includes(inner.ws) && listedNow.includes(tools.ws) && !listedNow.includes(scratch.trees) && !listedNow.includes(fourth.trees), JSON.stringify(listedNow))
      const before = changes('remove-requested').length
      await removeDialog.locator('.btn.primary').click()
      check('…one elevated run asks Defender to remove exactly the entries it lists', !!(await lib.until(async () => changes('remove-requested').length === before + 1, HUNG_MS)) && JSON.stringify([...changes('remove-requested').at(-1).paths].sort()) === JSON.stringify([inner.ws, tools.ws].sort()), JSON.stringify(changes().slice(-2)))
      // config.json is saved a moment after a change: waited for.
      check('…then the panel lists none, and Hive no longer records them', !!(await lib.until(async () => (await gonePanel.count()) === 0 && !ours(inner.ws) && !ours(tools.ws), HUNG_MS)), await panel.innerText())
      const after = await inv('antivirus:status', true)
      check('…nor Hive’s other gone ones Defender no longer lists (forgotten once the list is read)', !(after.gone ?? []).length && !!(await lib.until(() => !ours(third.ws), HUNG_MS)), JSON.stringify({ gone: after.gone, added: JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).antivirus?.added }))
    } finally {
      await app.close()
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
