// Where each agent works, in the window (#1442, SPEC §16.10.3 Built [#1442]): a Git project's slots lent through the
// test copies' `slots:test` channel, on the fake Claude Code:
// 1. Add Agent offers no worktree, and says where an agent works instead.
// 2. B1, started on card #12 (slot-a's lease): "in slot-a" beside its name on its pane (a link to Version Control →
//    Branches & remotes), its hover naming the folder, and the project hover's Slot column; its Files tab opens slot-a.
// 3. B2 holding its carried slot (#1441's adoption of its own worktree, hb2): "carried: hb2".
// 4. R1, a reviewer running in its retired home (#1441's homes, `slots:test` `homes`): "home: hr1".
// 5. The Sessions tab names B1's session's folder: "Slot · slot-a".
// 6. #12's lease ends: B1's pane no longer says "in slot-a" (the window reads the project again at a lease's end).
// 7. Stopped panes say where each works now, never a 0.9 worktree (#1552): B2 in hb2, the slot kept for it; R1 starts
//    new conversations in the project folder and resumes its last one in its old folder hr1.
// Screenshots of the pane, the hover, the agents table, Add Agent and the stopped panes, light and dark. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): its slots are lent through slots:test (and R1's retired home made there), which a packaged
// build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const userData = path.join(lib.WORK, 'agentslots-profile')
const ws = path.join(lib.WORK, 'agentslots-ws')
const home = path.join(lib.WORK, 'agentslots-claude-home')
const shots = path.join(lib.WORK, 'agentslots-shots')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const hb2 = path.join(root, 'hb2')
const hr1 = path.join(root, 'hr1')
const PORT = Number(lib.port(47818))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, path.join(root, 'slot-a'), path.join(root, 'slot-b'), hb2, hr1])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  try {
    h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT) }, viewport: { width: 1500, height: 900 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const { inv, page } = h
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    await lib.fitWindow(h.app, page, { width: 1500, height: 900 })
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const op = (o) => inv('slots:test', alpha, o)
    const agentInfo = async (id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === id)
    const placeMark = (name) => lib.paneHeader(page, name).locator('.agent-place')
    const themed = async (name, shoot) => {
      for (const theme of ['light', 'dark']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await shoot(path.join(shots, `agentslots-${name}-${theme}.png`))
      }
    }

    // --- 1. Add Agent: no worktree to choose.
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const add = page.locator('.dialog', { hasText: 'Add an agent' })
    check('Add Agent opens', !!(await until(async () => (await add.count()) === 1, HUNG_MS)))
    check('…with no worktree choice (no New worktree, Existing worktree or branch)', (await add.locator('.choice', { hasText: /New worktree|Existing worktree/ }).count()) === 0 && (await add.locator('.agent-form.nested').count()) === 0, await add.innerText())
    check('…and says where an agent works: the project folder, a slot per card', /project folder[\s\S]*slots/i.test(await add.locator('[data-where-note]').innerText().catch(() => '')))
    await themed('add-agent', (file) => add.screenshot({ path: file }))
    await page.keyboard.press('Escape')
    await until(async () => (await add.count()) === 0, HUNG_MS)

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    // R1, a reviewer from before 1.0 in its own worktree (made as an upgraded project has one, #1451), whose worktree is a
    // retired home (#1441): it resumes there.
    lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hr1', hr1])
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer', location: 'existing-worktree', worktreePath: hr1 })
    check('three agents', !!b1?.id && !!b2?.id && !!r1?.id, JSON.stringify({ b1, b2, r1 }))

    // --- 2. B1 on #12, in slot-a.
    const l12 = await op({ op: 'lend', agent: b1.id, card: 12 })
    check('#12 is lent slot-a for B1', l12?.ok && l12.slot.name === 'slot-a', JSON.stringify(l12))
    const slotA = l12.slot.folder
    fs.writeFileSync(path.join(slotA, 'only-in-slot-a.txt'), 'slot-a\n')
    await inv('session:start', alpha, { agentId: b1.id })
    const s1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 runs in slot-a', same(s1?.cwd, slotA) && s1?.slot === 'slot-a', JSON.stringify(s1))
    check("B1's place: slot-a", !!(await until(async () => (await agentInfo(b1.id))?.place?.is === 'slot', HUNG_MS)) && (await agentInfo(b1.id)).place.name === 'slot-a' && same((await agentInfo(b1.id)).place.folder, slotA), JSON.stringify((await agentInfo(b1.id))?.place))
    check('its pane says "in slot-a", as a link', !!(await until(async () => (await placeMark('B1').innerText().catch(() => '')) === 'in slot-a', HUNG_MS)) && (await placeMark('B1').evaluate((el) => el.tagName)) === 'BUTTON')
    const tip = await lib.hoverTip(page, lib.paneHeader(page, 'B1').locator('.agent-name'), (t) => t.includes('Works in slot-a'))
    check("…its name's hover names slot-a and its folder", tip.includes('Works in slot-a:') && tip.toLowerCase().includes(slotA.toLowerCase()), tip)
    await themed('pane-hover', (file) => page.locator('.agent-pane', { has: lib.paneHeader(page, 'B1') }).first().screenshot({ path: file }))
    await page.mouse.move(5, 5)

    // --- 3. B2's carried slot hb2.
    lib.git(alpha, ['worktree', 'add', '-q', '-b', 'hive/hb2', hb2])
    const carried = await op({ op: 'carry', agent: b2.id, slot: 'hb2', folder: hb2 })
    check("B2's own worktree hb2 is its carried slot", carried?.kind === 'carried' && carried.agent === b2.id, JSON.stringify(carried))
    // The test channel adopts it without the upgrade's refresh after (#1441): the window reads the project again.
    await inv('workspace:refresh')
    const b2Mark = !!(await until(async () => (await placeMark('B2').innerText().catch(() => '')) === 'carried: hb2', HUNG_MS))
    check('B2\'s pane says "carried: hb2", as text', b2Mark && (await placeMark('B2').evaluate((el) => el.tagName)) === 'SPAN', `${JSON.stringify((await agentInfo(b2.id))?.place)} ${await lib.paneHeader(page, 'B2').innerHTML().catch((e) => String(e))}`)

    // --- 4. R1 in its retired home.
    await op({ op: 'homes', folders: [hr1] })
    await inv('session:start', alpha, { agentId: r1.id })
    const sr = await until(async () => ((await idle(r1.id)) ? live(r1.id) : null), HUNG_MS)
    check('R1 runs in its home', same(sr?.cwd, hr1), JSON.stringify(sr))
    check('R1\'s pane says "home: hr1"', !!(await until(async () => (await placeMark('R1').innerText().catch(() => '')) === 'home: hr1', HUNG_MS)), JSON.stringify((await agentInfo(r1.id))?.place))

    // The project hover's agents table: a Slot column, each agent's place.
    const header = page.locator('.project-header .project-title .badge').first()
    const table = await lib.hoverTip(page, header, (t) => /slot/i.test(t) && t.includes('in slot-a') && t.includes('carried: hb2'))
    check("the project hover's agents table has a Slot column: in slot-a, carried: hb2, home: hr1", /slot/i.test(table) && table.includes('in slot-a') && table.includes('carried: hb2') && table.includes('home: hr1'), table)
    await themed('agents-table', (file) => page.locator('.tip.agents-tip').screenshot({ path: file }))
    await page.mouse.move(5, 5)

    // The slot's link opens Version Control → Branches & remotes.
    await placeMark('B1').click()
    check('"in slot-a" opens Version Control → Branches & remotes', !!(await until(async () => (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await page.locator('button[role="tab"][data-section="branches"][aria-selected="true"]').count()) === 1, HUNG_MS)))

    // --- 2b. The Files tab opens the folder B1 works in.
    await page.locator('.tabs .tab', { hasText: 'Files' }).click()
    const picker = page.locator('.root-select')
    check("Files' folder picker offers B1 in slot-a", !!(await until(async () => (await picker.locator('option', { hasText: 'B1 · in slot-a' }).count()) === 1, HUNG_MS)), JSON.stringify(await picker.locator('option').allInnerTexts().catch(() => [])))
    await picker.selectOption(b1.id)
    check('…which shows slot-a\'s files', !!(await until(async () => (await page.getByText('only-in-slot-a.txt').count()) > 0, HUNG_MS)), `${await picker.inputValue().catch(() => '')} ${(await page.locator('.files-tree, .file-tree, .tree').first().innerText().catch(() => '')).slice(0, 400)}`)

    // --- 5. The Sessions tab names B1's session's folder.
    await page.locator('.tabs .tab', { hasText: 'Sessions' }).click()
    const origin = page.locator('.session-origin', { hasText: 'Slot · slot-a' })
    check("the Sessions tab names B1's session's folder: Slot · slot-a", !!(await until(async () => (await origin.count()) >= 1, HUNG_MS)), JSON.stringify(await page.locator('.session-origin').allInnerTexts()))

    // --- 6. #12's lease ends (Done): B1's idle session there stops, and its pane no longer says "in slot-a".
    await page.locator('.tabs .tab').filter({ hasText: /^\s*Session\s*$/ }).click()
    check("#12's lease ends", (await op({ op: 'release', lease: l12.lease.id, why: 'done' })) === true)
    // The pane first: the test asks for no refresh before it reads it.
    check('…its pane no longer says "in slot-a"', !!(await until(async () => (await lib.paneHeader(page, 'B1').count()) === 1 && (await placeMark('B1').count()) === 0, HUNG_MS)))
    check('…B1 is stopped, and works in the project folder now', !!(await until(async () => !(await live(b1.id)) && (await agentInfo(b1.id))?.place?.is === 'project', HUNG_MS)), JSON.stringify((await agentInfo(b1.id))?.place))

    // --- 7. Stopped panes say where each works now (#1552), never their 0.9 worktree: B2 in the slot kept for it; R1,
    // stopped, starts new conversations in the project folder and resumes its last one in its retired home.
    const placeholder = (name) => page.locator('.agent-pane', { has: lib.paneHeader(page, name) }).first().locator('.pane-placeholder')
    const b2Says = await until(async () => ((await placeholder('B2').innerText().catch(() => '')).includes('Works in hb2, the slot kept for it.') ? placeholder('B2').innerText() : null), HUNG_MS)
    check("B2's stopped pane: works in hb2, the slot kept for it", !!b2Says && !/own worktree/.test(b2Says), (await placeholder('B2').innerText().catch(() => '')) || JSON.stringify((await agentInfo(b2.id))?.place))
    await inv('session:stop', alpha, r1.id)
    check('R1 stops', !!(await until(async () => !(await live(r1.id)), HUNG_MS)))
    // A pane whose session ended here keeps its terminal (the ended bar); after an upgrade Combwork opens with none: open
    // it again, as then, and read R1's pane.
    await h.app.close()
    h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT) }, viewport: { width: 1500, height: 900 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    const again = { inv: h.inv, page: h.page }
    await lib.openWorkspace(again.inv, again.page, ws)
    await lib.fitWindow(h.app, again.page, { width: 1500, height: 900 })
    const placeholder2 = (name) => again.page.locator('.agent-pane', { has: lib.paneHeader(again.page, name) }).first().locator('.pane-placeholder')
    const r1Says = 'A new conversation starts in the project folder; Resume opens its last one in its old folder, hr1.'
    check("R1, stopped, Combwork opened again: its pane says a new conversation starts in the project folder, Resume in its old folder hr1", !!(await until(async () => (await placeholder2('R1').innerText().catch(() => '')).includes(r1Says), HUNG_MS)), await placeholder2('R1').innerText().catch(() => ''))
    check("…and not its 0.9 worktree", !/own worktree/.test(await placeholder2('R1').innerText().catch(() => '')))
    for (const theme of ['light', 'dark']) {
      await again.inv('settings:update', { appearance: { theme } })
      await until(async () => (await again.page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await again.page.screenshot({ path: path.join(shots, `agentslots-stopped-panes-${theme}.png`) })
    }
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
