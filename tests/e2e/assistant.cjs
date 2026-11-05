// The Combwork Assistant: its home and modes (#259) in a workspace, the side panel (remembered per workspace), switching
// mode, Assistant Settings (its connection and mode, HI-2108; dark and light screenshots), the Modes view, and one launch (no prompt is sent)
// that runs in the workspace folder, in Auto mode, named "Assistant" in the quit dialog. The Assistant runs the fake
// Claude Code (fake-claude/, #195); that the real Claude Code takes its launch (and falls back from Auto with Haiku) is
// claude-real's. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'assistant-profile')
const ws = path.join(lib.WORK, 'assistant-ws')
const ws2 = path.join(lib.WORK, 'assistant-ws2')
const home = path.join(ws, '.combwork', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const agentFile = () => JSON.parse(fs.readFileSync(path.join(home, '.combwork', 'project.json'), 'utf8')).agents?.[0] ?? {}
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** Whether fn() comes true (checked until it does, up to HUNG_MS). */
const becomes = async (fn) => !!(await lib.until(fn, HUNG_MS))

;(async () => {
  for (const d of [userData, ws, ws2]) fs.rmSync(d, { recursive: true, force: true })
  for (const p of ['api', 'web']) fs.mkdirSync(path.join(ws, p), { recursive: true })
  fs.mkdirSync(ws2, { recursive: true })
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'assistant-claude-home'), [ws, home])
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47894), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // The workspace gets the Assistant's home and Combwork's modes; the home is not a project.
  const info = await inv('workspace:get')
  check('the Assistant has its home and one agent', info.assistant?.path.toLowerCase() === home.toLowerCase() && info.assistant.agents.length === 1)
  check('its home is not listed as a project', info.projects.map((p) => p.name).sort().join(',') === 'api,web')
  check("its sessions are kept out of git", fs.readFileSync(path.join(home, '.gitignore'), 'utf8').includes('*'))
  // Brought in after the open (HI-1705): wait for them.
  const modes = () => (fs.existsSync(path.join(ws, '.combwork', 'modes')) ? fs.readdirSync(path.join(ws, '.combwork', 'modes')).sort().join(',') : '')
  check('Combwork\'s four modes are in the workspace', await becomes(() => modes() === 'coordinator.md,planner.md,qa-triager.md,release-manager.md'), modes())
  check("it defaults to the agents' model and effort, and Auto mode", JSON.stringify(info.assistant.config.providers['claude-code']) === JSON.stringify({ model: 'inherit', effort: 'inherit', permissionMode: 'auto', extraArgs: '', use200kContext: 'inherit' }), JSON.stringify(info.assistant.config.providers['claude-code']))

  // The panel: hidden at first, Ctrl+Alt+I shows it, and each workspace remembers it.
  check('the panel starts hidden, as a strip', (await page.locator('.assistant-panel').count()) === 0 && (await page.locator('.assistant-rail', { hasText: 'Assistant' }).count()) === 1)
  await page.locator('.assistant-rail').click()
  const panelWidth = async () => Math.round((await page.locator('.assistant-panel').boundingBox().catch(() => null))?.width ?? -1)
  check('clicking the strip shows the panel', await becomes(async () => (await page.locator('.assistant-panel').count()) === 1 && (await page.locator('.assistant-rail').count()) === 0))
  check('430 px wide by default', await becomes(async () => (await panelWidth()) === 430), String(await panelWidth()))
  await page.keyboard.press('Control+Alt+I')
  check('Ctrl+Alt+I hides it again', await becomes(async () => (await page.locator('.assistant-rail').count()) === 1))
  await page.keyboard.press('Control+Alt+I')
  check('and shows it', await becomes(async () => (await page.locator('.assistant-panel').count()) === 1))
  check('Start is a header button', await becomes(async () => (await page.locator('.assistant-header button[aria-label="Start"]').count()) === 1))
  // Narrowest: the header keeps Start and ⋯ inside the panel, as an agent pane's keeps Stop and ⋯ (#979); ⋯ has Start too.
  const edge = await page.locator('.assistant-panel > .pane-resizer').boundingBox()
  await page.mouse.move(edge.x + 3, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + 60, edge.y + 200, { steps: 5 })
  await page.mouse.move(edge.x + 160, edge.y + 200, { steps: 5 })
  await page.mouse.up()
  await lib.until(async () => (await panelWidth()) === 300, HUNG_MS)
  const inside = await page.evaluate(() => {
    const right = document.querySelector('.assistant-panel').getBoundingClientRect().right
    return ['button[aria-label="Start"]', 'button[aria-label="More"]', '.assistant-panel-fold'].map((sel) => document.querySelector(`.assistant-header ${sel}`)?.getBoundingClientRect().right ?? Infinity).every((r) => r <= right + 0.5)
  })
  check('at its narrowest the header keeps Start, ⋯ and Fold, inside the panel', inside)
  await page.locator('.assistant-header button[aria-label="More"]').click()
  check('…and ⋯ has Start too', await becomes(async () => (await page.locator('.menu-item', { hasText: /^Start$/ }).count()) === 1))
  await page.keyboard.press('Escape')
  await page.locator('.assistant-panel > .pane-resizer').dblclick()
  check('double-clicking its edge goes back to 430 px', await becomes(async () => (await panelWidth()) === 430), String(await panelWidth()))
  check('inactive projects fold into one row', (await page.locator('.assistant-project').count()) === 0 && (await page.locator('.assistant-fold', { hasText: '2 inactive projects' }).count()) === 1)
  await page.locator('.assistant-fold').click()
  check('which expands to list them', await becomes(async () => (await page.locator('.assistant-project.inactive').count()) === 2))
  await inv('project:setActive', path.join(ws, 'api'), true)
  check('an active project is listed above the fold', await becomes(async () => (await page.locator('.assistant-project:not(.inactive)', { hasText: 'api' }).count()) === 1 && (await page.locator('.assistant-fold', { hasText: '1 inactive project' }).count()) === 1))
  await page.locator('.assistant-fold').click()
  check('and folding hides the rest again', await becomes(async () => (await page.locator('.assistant-project').count()) === 1))
  check('it offers to start the Assistant', (await page.locator('.assistant-idle', { hasText: 'Coordinator' }).count()) === 1)
  await lib.openWorkspace(inv, page, ws2)
  check('another workspace has its own (hidden) panel', (await page.locator('.assistant-panel').count()) === 0)
  await lib.openWorkspace(inv, page, ws)
  check('coming back shows it again', (await page.locator('.assistant-panel').count()) === 1)

  // Switching mode (not running): saved for this workspace.
  await page.locator('.assistant-mode').click()
  await page.locator('.context-menu .menu-item, .menu .menu-item', { hasText: 'Planner' }).first().click()
  check('choosing a mode saves it for the workspace', !!(await lib.until(() => agentFile().mode === 'planner', 10000)), JSON.stringify(agentFile()))
  // The header follows once the workspace is refreshed, which can be after the file is saved.
  check('the header shows it', !!(await lib.until(async () => (await page.locator('.assistant-mode').innerText()).includes('Planner'), 10000)))

  // Assistant Settings (HI-2108): this workspace's connection and mode, nothing else. Two connections on its account (the
  // connection dialog's saves): Sonnet with Medium effort, and one in the CLI's own mode, which the Assistant can't take.
  const saved = async () => (await inv('connections:list')).connectionRows
  const account = await lib.until(async () => (await saved()).find((c) => c.id === agentFile().connection)?.account ?? (await saved())[0]?.account, HUNG_MS)
  const light = await inv('connection:add', account, { name: 'Light', model: 'sonnet', effort: 'medium' })
  const cliOwn = await inv('connection:add', account, { name: 'Its own mode', permissionMode: 'cli-own' })
  await page.locator('.assistant-header button[aria-label="More"]').click()
  await page.locator('.menu-item', { hasText: 'Assistant Settings…' }).click()
  const settingsDialog = page.locator('.dialog', { hasText: 'Assistant Settings' })
  const choice = settingsDialog.locator('#assistant-connection')
  check('Assistant Settings has a connection and a mode, no coding agent, model or effort', await becomes(async () => (await choice.count()) === 1) && (await settingsDialog.locator('.provider-choice').count()) === 0 && (await settingsDialog.getByText('Effort', { exact: true }).count()) === 0)
  check("…a connection in the CLI's own mode greyed out, saying why", await becomes(async () => (await choice.locator(`option[value="${cliOwn.id}"]`).count()) === 1) && (await choice.locator(`option[value="${cliOwn.id}"]`).isDisabled()) && /the Assistant needs to know its mode/.test(await choice.locator(`option[value="${cliOwn.id}"]`).innerText()))
  await choice.selectOption(light.id)
  check('…the one chosen summed up under it', await becomes(async () => /Sonnet.*Medium/.test(await settingsDialog.locator('[data-connection-summary]').innerText().catch(() => ''))), await settingsDialog.locator('[data-connection-summary]').innerText().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await settingsDialog.screenshot({ path: path.join(lib.WORK, `assistant-settings-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await settingsDialog.locator('.btn.primary', { hasText: 'Save' }).click()
  check('Save gives the Assistant that connection, for this workspace', await becomes(() => agentFile().connection === light.id), JSON.stringify(agentFile()))
  check('the footer shows its effort', await becomes(async () => (await page.locator('.assistant-footer').innerText()).includes('Medium')))
  check('renaming the Assistant is ignored', (await inv('agents:update', home, 'assistant', { name: 'Bob' })).name === 'Assistant')
  // Settings → Assistant has no provider, connection or per-provider values any more: its connection holds them.
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).first().click()
  check('Settings → Assistant has no provider, connection or "With Claude Code"', await becomes(async () => (await page.locator('.setting', { hasText: 'Highlight Compact over' }).count()) >= 1) && (await page.locator('.setting', { hasText: /^Provider|With Claude Code|Connection \(this workspace\)/ }).count()) === 0)
  await page.keyboard.press('Control+Shift+E')

  // The Modes view: create, delete and restore.
  await inv('modes:create', 'Night Watch')
  check('a new mode is a file', fs.existsSync(path.join(ws, '.combwork', 'modes', 'night-watch.md')))
  await inv('modes:delete', 'qa-triager')
  const listed = await inv('modes:list')
  check('a deleted bundled mode is offered for restoring', listed.find((p) => p.id === 'qa-triager')?.bundled === 'missing')
  await inv('modes:restore', 'qa-triager')
  check('and restores', (await inv('modes:list')).find((p) => p.id === 'qa-triager')?.bundled === 'same')
  // The Combwork Assistant view: a summary, its conversations and its modes.
  await page.locator('.activity-btn[aria-label="Assistant"]').click()
  check('the Assistant view has a summary', await becomes(async () => (await page.locator('.assistant-summary .assistant-stat').count()) === 4))
  // The summary's stats are drawn at once (showing "…" until its conversations are read), the list once they are: so
  // the list is waited for, not read once after the stats (#710: it failed under load).
  const conversations = page.locator('.sessions-list')
  check('it opens on the conversations', await becomes(async () => (await conversations.locator('.pane-header', { hasText: 'Conversations' }).count()) === 1 && (await page.locator('.sessions-list', { hasText: 'No conversations yet' }).count()) === 1), JSON.stringify(await conversations.allInnerTexts()))
  // The modes load after the view opens: wait for them (read once, it failed under load, #648's runs).
  check('it lists the modes', await becomes(async () => (await page.locator('.mode-row').count()) === 5), String(await page.locator('.mode-row').count()))
  await page.locator('.mode-row', { hasText: 'QA triager' }).click()
  check('a mode opens in the editor', await becomes(async () => (await page.locator('.split-main .editor-toolbar', { hasText: 'QA triager' }).count()) === 1))
  check('its toolbar can delete it', (await page.locator('.split-main .editor-toolbar [aria-label="Delete mode"]').count()) === 1)

  // One launch (no prompt): in the workspace folder, asking for Auto, with Combwork's reading tools allowed.
  await inv('session:start', home, { agentId: 'assistant' })
  await lib.acceptClaudeTrust(inv, home, 'assistant', 20000)
  const t0 = Date.now()
  let live = null
  while (Date.now() - t0 < 30000 && (live = (await inv('session:live')).find((s) => s.agentId === 'assistant'))?.status !== 'ready') await lib.sleep(400)
  check('the Assistant starts', live?.status === 'ready', live?.status)
  check('it works in the workspace folder', live?.cwd.toLowerCase() === ws.toLowerCase(), live?.cwd)
  check('its conversation is named for the mode', (live?.sessionName ?? '').startsWith('Assistant · Planner · '), live?.sessionName)
  const log = fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8')
  // The key is marked as the user's own text in the log (userText), so the line is found by its parts.
  const launch = log.split('\n').filter((l) => / spawn \W?session:/.test(l) && l.toLowerCase().includes('assistant#assistant')).pop() ?? ''
  check('it launches in Auto', launch.includes('"--permission-mode","auto"'))
  check('…with the model its connection sets', launch.includes('"--model","sonnet"'))
  check("its mode is appended to Claude Code's system prompt", launch.includes('--append-system-prompt-file'))
  check("Combwork's reading tools are allowed", launch.includes('mcp__combwork__cw_list_projects') && !launch.includes('mcp__combwork__cw_write_shared_note'))
  check('Planner\'s instructions are in the launch', fs.readFileSync(path.join(home, '.combwork', 'launch-assistant', 'instructions.md'), 'utf8').includes('# Your mode: Planner'))
  check('it is not a project agent', (await inv('workspace:get')).projects.every((p) => p.agents.every((a) => a.id !== 'assistant')))
  // The header's fold button (#1330), as the Progress panel's: its tooltip names the shortcut (a rebinding too), and
  // folding the panel leaves the Assistant running.
  const fold = page.locator('.assistant-header .assistant-panel-fold')
  check('the header has a fold button, with its shortcut', (await fold.getAttribute('aria-label')) === 'Fold the Assistant panel (Ctrl+Alt+I)', await fold.getAttribute('aria-label'))
  await inv('settings:setKeybinding', 'assistant.toggle', 'Mod+Alt+J')
  check('…the shortcut as rebound', await becomes(async () => (await fold.getAttribute('aria-label')) === 'Fold the Assistant panel (Ctrl+Alt+J)'), await fold.getAttribute('aria-label'))
  // null removes the shortcut (the tooltip names none); undefined resets it to Combwork's (setKeybinding).
  await inv('settings:setKeybinding', 'assistant.toggle', null)
  check('…none once it is removed', await becomes(async () => (await fold.getAttribute('aria-label')) === 'Fold the Assistant panel'), await fold.getAttribute('aria-label'))
  await inv('settings:setKeybinding', 'assistant.toggle', undefined)
  check('…and Ctrl+Alt+I again once it is reset', await becomes(async () => (await fold.getAttribute('aria-label')) === 'Fold the Assistant panel (Ctrl+Alt+I)'), await fold.getAttribute('aria-label'))
  const runBefore = (await inv('session:live')).find((s) => s.agentId === 'assistant')?.runId
  await fold.click()
  check('clicking it folds the panel to its strip', await becomes(async () => (await page.locator('.assistant-panel').count()) === 0 && (await page.locator('.assistant-rail').count()) === 1))
  const after = (await inv('session:live')).find((s) => s.agentId === 'assistant')
  check('…and the Assistant keeps running', !!runBefore && after?.status === 'ready' && after.runId === runBefore, JSON.stringify({ runBefore, status: after?.status, runId: after?.runId }))
  await page.locator('.assistant-rail').click()
  await becomes(async () => (await page.locator('.assistant-panel').count()) === 1)
  // Its conversation is in the Assistant view's browser, and reads like any session.
  await page.locator('.assistant-panel .assistant-header button[aria-label="More"]').click()
  await page.locator('.menu-item', { hasText: 'All Conversations…' }).click()
  // The list and its selected conversation's page come after the click: each waited for (#710).
  check('All Conversations… lists it', await becomes(async () => (await page.locator('.session-row').count()) === 1), String(await page.locator('.session-row').count()))
  check("it is the running one, with a Show button for the Assistant's panel", await becomes(async () => (await page.locator('.split-main button', { hasText: 'Show' }).count()) === 1))
  // Closing the workspace (Confirm on quit: always) lists it as "Assistant", then stops it.
  await inv('settings:update', { general: { confirmOnQuit: 'always' } })
  const closing = inv('workspace:close')
  await lib.until(async () => (await page.locator('.dialog').count()) > 0, 10000)
  const dialog = await page.locator('.dialog').last().innerText().catch(() => '')
  check('the close dialog names it "Assistant"', /Assistant/.test(dialog) && !/\.combwork|assistant ·/i.test(dialog), dialog.replace(/\s+/g, ' ').slice(0, 200))
  await page.locator('.dialog .btn', { hasText: 'Close workspace now' }).click()
  check('closing the workspace stops it', (await closing) === true && !(await inv('session:live')).some((s) => s.agentId === 'assistant'))

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
