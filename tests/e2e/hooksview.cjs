// An agent's ⋯ → Hooks… and live lock blocks in Activity (HI-982), on the fake Claude Code and the fake Codex:
// 1. each agent's Hooks dialog lists Combwork's own hooks (passed for the launch) and the user's seeded one (Claude Code's
//    settings.json, configured with its loading unverified; Codex's from its own hooks/list, trusted), the user's marked
//    not observed by Combwork; a settings file changed after launch is said to have changed;
// 2. What fired shows, for each, an edit Combwork allowed, one its file lock blocked (with the reason) and a hook the turn
//    ledger ignored as stale (with why), Combwork's reply apart from what it made of it;
// 3. Activity shows the live lock block (the file and its holder) while the holder still holds the file, and drops it
//    once the holder's turn ends;
// 4. screenshots of the dialog and the block in both themes (--keep-files).
// Dev build, throwaway profile, workspace and CLI homes; the hooks Combwork receives are posted the way the CLIs post them,
// with each launch's own token. Nothing signs in or spends tokens.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'hooksview-profile')
const ws = path.join(lib.WORK, 'hooksview-ws')
const claudeHome = path.join(lib.WORK, 'hooksview-claude-home')
const codexHome = path.join(lib.WORK, 'hooksview-codex-home')
const shots = path.join(lib.WORK, 'hooksview-shots')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47706))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, codexHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [codexHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha, { 'x.txt': 'x\n', 'y.txt': 'y\n' })
  const claude = lib.fakeClaude(userData, claudeHome, [alpha])
  lib.enableProviders(userData, ['claude-code', 'codex'])
  // The user's own hooks: one in Claude Code's settings.json, one Codex lists (its hooks/list, as the fake answers it).
  const claudeSettings = path.join(claudeHome, 'settings.json')
  fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-claude-stop' }] }] } }))
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  fs.writeFileSync(path.join(codexHome, 'fake-hooks-list.json'), JSON.stringify([{ key: `${path.join(codexHome, 'config.toml')}:stop:0:0`, source: 'user', command: 'echo user-codex-stop', trustStatus: 'trusted' }]))
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex = { ...cfg.settings.providers.codex, executablePath: path.join(__dirname, 'fake-codex', 'fake-codex.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Each app server the fake Codex runs, by its pid (HI-982: none left after a listing times out).
  const appServers = path.join(userData, 'fake-appservers.txt')
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...claude, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off', FAKE_CODEX_APPSERVER_LOG: appServers })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.setOwnOptions(inv, alpha, { fileLocks: 'block' })
    await inv('workspace:refresh')
    const holder = await lib.addAgent(inv, alpha, { name: 'Holder', provider: 'claude-code' })
    const cl = await lib.addAgent(inv, alpha, { name: 'Cl', provider: 'claude-code' })
    const cx = await lib.addAgent(inv, alpha, { name: 'Cx', provider: 'codex', permissionMode: 'full-access' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = (id) => async () => ['ready', 'finished'].includes((await live(id))?.status)
    for (const a of [holder, cl, cx]) await inv('session:start', alpha, { agentId: a.id })
    for (const a of [holder, cl, cx]) check(`${a.name} starts`, !!(await lib.until(idle(a.id), HUNG_MS)))
    // Codex reports its session with its first prompt.
    await lib.sendPrompt(inv, lib.ptyKey(alpha, cx.id), 'hello', { submitted: async () => !!(await live(cx.id))?.sessionId })
    await lib.until(idle(cx.id), HUNG_MS)

    // Each launch's own hook route and token, as its CLI has them.
    const holderLive = await live(holder.id)
    const base = lib.launchHook(userData, holderLive.runId)
    const routeOf = (runId) => ({ url: base.url.replace(/run=[0-9a-f]+/, `run=${runId}`), token: /Bearer ([0-9a-f]+)/.exec(fs.readFileSync(path.join(lib.launchDir(userData, runId), 'hook-auth.txt'), 'utf8'))[1] })
    const post = async (a, body) => {
      const l = await live(a.id)
      const r = routeOf(l.runId)
      const res = await fetch(r.url, { method: 'POST', headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: l.sessionId, cwd: alpha, ...body }) })
      return res.json().catch(() => ({}))
    }
    const patch = (f) => ({ command: `*** Begin Patch\n*** Update File: ${f}\n@@\n+x\n*** End Patch` })

    // --- The holder edits x.txt (allowed, and it holds the file); Cl and Cx try it too (blocked); Cx edits y.txt (allowed).
    await post(holder, { hook_event_name: 'UserPromptSubmit', prompt: 'edit x', prompt_id: 'p-h' })
    const allowed = await post(holder, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'h1', tool_input: { file_path: path.join(alpha, 'x.txt') } })
    check("the holder's edit is allowed", !allowed.hookSpecificOutput, JSON.stringify(allowed))
    await post(cl, { hook_event_name: 'UserPromptSubmit', prompt: 'edit x too', prompt_id: 'p-c' })
    const blocked = await post(cl, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'c1', tool_input: { file_path: path.join(alpha, 'x.txt') } })
    check("Cl's edit of the same file is blocked by Combwork's lock", blocked.hookSpecificOutput?.permissionDecision === 'deny', JSON.stringify(blocked))
    await post(cx, { hook_event_name: 'UserPromptSubmit', prompt: 'edit', turn_id: 't-x' })
    const cxAllowed = await post(cx, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'x1', turn_id: 't-x', tool_input: patch('y.txt') })
    await post(cx, { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'x1', turn_id: 't-x', tool_input: patch('y.txt') })
    const cxBlocked = await post(cx, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'x2', turn_id: 't-x', tool_input: patch('x.txt') })
    check("Cx's edit of y.txt is allowed and of x.txt blocked", JSON.stringify(cxAllowed) === '{}' && /Holder is editing x\.txt/.test(JSON.stringify(cxBlocked)), `${JSON.stringify(cxAllowed)} ${JSON.stringify(cxBlocked)}`)

    // --- Activity: the live blocks, by IPC and on screen.
    const blocks = async () => (await inv('activity:now', alpha)).blocks ?? []
    const both = await lib.until(async () => {
      const b = await blocks()
      return b.length === 2 ? b : null
    }, HUNG_MS)
    check("Activity has Cl's and Cx's blocks, the file and its holder named", !!both && both.every((b) => b.file === 'x.txt' && b.holder === 'Holder' && b.kind === 'blocked') && new Set(both.map((b) => b.agentId)).size === 2, JSON.stringify(both))
    const menu = await lib.agentMenu(page, 'Cl')
    check("Cl's ⋯ menu has Hooks…", menu.some((t) => t.startsWith('Hooks…')), JSON.stringify(menu))
    await lib.menuEntry(page, 'Activity').click()
    // The tab opens frozen (HI-1743): Play shows what changes.
    await page.locator('button', { hasText: 'Play' }).click()
    const blockRow = page.locator('.activity-row[data-block="blocked"]')
    check('the Activity tab shows the block, live', !!(await lib.until(async () => (await blockRow.count()) === 1 && /x.txt is locked by agent Holder/.test(await blockRow.innerText()), HUNG_MS)), await blockRow.allInnerTexts().then(String))
    const themed = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
      }
    }
    await themed('activity-block')

    // --- The holder's turn ends: its lock is released, and the blocks leave Activity (nothing of theirs came).
    await post(holder, { hook_event_name: 'Stop', prompt_id: 'p-h' })
    check('the blocks leave once the holder releases the file', !!(await lib.until(async () => (await blocks()).length === 0, HUNG_MS)), JSON.stringify(await blocks()))
    check('…and the Activity row with them', !!(await lib.until(async () => (await blockRow.count()) === 0, HUNG_MS)))
    await page.locator('.tab', { hasText: 'Session' }).first().click()

    // --- Stale hooks: each agent's turn ends, then a tool end of that turn comes (old news), ignored by the turn ledger.
    await post(cl, { hook_event_name: 'Stop', prompt_id: 'p-c' })
    await post(cl, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'c1', prompt_id: 'p-c' })
    await post(cx, { hook_event_name: 'Stop', turn_id: 't-x' })
    await post(cx, { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'x2', turn_id: 't-x' })

    // --- Each agent's Hooks dialog.
    fs.writeFileSync(claudeSettings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo changed' }] }] } }))
    for (const a of [cl, cx]) {
      const h = await inv('session:hooks', alpha, a.id)
      const rows = h?.listing.rows ?? []
      const own = rows.filter((r) => r.source === 'combwork')
      const user = rows.filter((r) => r.source === 'user')
      check(`${a.name}: Combwork's hooks listed as passed and observed`, own.length >= 5 && own.every((r) => r.status === 'passed' && r.observed) && own.some((r) => r.event === 'PreToolUse'), JSON.stringify(own.map((r) => [r.event, r.status])))
      check(`${a.name}: the user's hook listed, not observed by Combwork`, user.length === 1 && !user[0].observed && /user-(claude|codex)-stop/.test(user[0].command) && user[0].status === (a === cx ? 'trusted' : 'unverified'), JSON.stringify(user))
      check(`${a.name}: no command shows Combwork's token, run id or auth file`, !rows.some((r) => /Bearer [0-9a-f]{16}|run=[0-9a-f]{6}|hook-auth/.test(r.command)), JSON.stringify(own.map((r) => r.command)))
      const fired = h?.fired ?? []
      check(`${a.name}: what fired has a lock block with its reason`, fired.some((f) => f.event === 'PreToolUse' && f.response === 'blocked' && /Holder is editing x.txt/.test(f.why ?? '')), JSON.stringify(fired.map((f) => [f.event, f.response, f.ledger])))
      check(`${a.name}: …and a hook the turn ledger ignored, with why, apart from Combwork's reply`, fired.some((f) => f.ledger === 'ignored' && !!f.ledgerWhy), JSON.stringify(fired.map((f) => [f.event, f.response, f.ledger, f.ledgerWhy])))
    }
    const cxFired = (await inv('session:hooks', alpha, cx.id)).fired
    check('Cx: …and its allowed edit', cxFired.some((f) => f.event === 'PreToolUse' && f.response === 'allowed'), JSON.stringify(cxFired.map((f) => [f.event, f.response])))
    const holderFired = (await inv('session:hooks', alpha, holder.id)).fired
    check("the holder's allowed edit is in its own", holderFired.some((f) => f.event === 'PreToolUse' && f.response === 'allowed'))
    const clNotes = (await inv('session:hooks', alpha, cl.id)).listing.notes
    check("Cl: Claude Code's settings.json changed since launch is said so", clNotes.some((n) => n.kind === 'changed' && n.file.toLowerCase() === claudeSettings.toLowerCase()), JSON.stringify(clNotes))

    // --- Codex's listing by its advanced settings (Settings → Advanced): a request it doesn't know, then one it never
    // answers, each said in the dialog (Combwork's own still listed), with no app server left running.
    const cxNotes = async () => (await inv('session:hooks', alpha, cx.id)).listing
    await inv('advanced:set', 'codex.hooks.listMethod', 'hooks/nope')
    let listed = await cxNotes()
    check("with another listing request, Codex's answer (an error) is said, Combwork's own still listed", listed.notes.some((n) => n.kind === 'cliUnknown' && /unknown method: hooks\/nope/.test(n.why)) && listed.rows.filter((r) => r.source === 'combwork').length >= 5 && !listed.rows.some((r) => r.source === 'user'), JSON.stringify(listed.notes))
    await inv('advanced:set', 'codex.hooks.listMethod', 'hooks/list')
    fs.writeFileSync(path.join(codexHome, 'fake-hooks-list-hang.txt'), 'x')
    await inv('advanced:set', 'codex.hooks.listSeconds', 2)
    const asked = Date.now()
    listed = await cxNotes()
    check('a listing Codex never answers ends at its timeout, said in the dialog', listed.notes.some((n) => n.kind === 'cliUnknown') && Date.now() - asked < HUNG_MS, `${Date.now() - asked} ms ${JSON.stringify(listed.notes)}`)
    const ran = () => (fs.existsSync(appServers) ? fs.readFileSync(appServers, 'utf8').split(/\r?\n/).map(Number).filter((n) => n > 0) : [])
    check('…and no app server Combwork started is left running', ran().length > 0 && !!(await lib.until(() => ran().every((pid) => !lib.processRunning(pid)), HUNG_MS)), JSON.stringify(ran().filter((pid) => lib.processRunning(pid))))
    fs.rmSync(path.join(codexHome, 'fake-hooks-list-hang.txt'))
    await inv('advanced:set', 'codex.hooks.listSeconds', 20)
    listed = await cxNotes()
    check('back at the defaults, Codex lists them again', !listed.notes.length && listed.rows.some((r) => r.source === 'user'), JSON.stringify(listed.notes))

    // --- The dialog on screen, from the agent's ⋯ menu.
    await lib.agentMenu(page, 'Cl')
    await lib.menuEntry(page, 'Hooks…').click()
    const dialog = page.locator('.dialog', { hasText: 'Hooks: Cl' })
    check('the dialog opens from ⋯ → Hooks…', !!(await lib.until(async () => (await dialog.locator('[data-table="fired"] tbody tr').count()) > 0, HUNG_MS)))
    check("…listing the user's hook as not observed by Combwork", (await dialog.locator('[data-table="loaded"] tr[data-source="user"]', { hasText: 'Not observed by Combwork' }).count()) === 1)
    check('…the blocked edit and an ignored hook under What fired', (await dialog.locator('[data-table="fired"] tr[data-response="blocked"]').count()) >= 1 && (await dialog.locator('[data-table="fired"] tr[data-ledger="ignored"]').count()) >= 1)
    await themed('hooks-dialog')
    await dialog.locator('[data-table="fired"]').scrollIntoViewIfNeeded()
    await themed('hooks-dialog-fired')
    await page.keyboard.press('Escape')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
