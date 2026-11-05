// Compact on a new, empty real Claude Code session: Claude Code refuses it without a turn, so nothing is sent and it
// runs in a home of the suite's own with a made-up API key (lib.ownClaudeHome, #368), never the user's ~/.claude.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'cp-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const ws = path.join(scratch, 'compact-ws')
const shots = path.join(scratch, 'cshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true }); fs.mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
const check = (n, ok) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}`)
;(async () => {
  lib.enableProviders(userData)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, ...lib.ownClaudeHome('compact').env })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const proj = path.join(ws, 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  // Ready once Claude Code's SessionStart hook arrives (checked below).
  await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)
  const status = () => inv('session:live').then((l) => l[0]?.status + (l[0]?.statusMessage ? ` (${l[0].statusMessage})` : ''))
  console.log('status after start:', await status())
  await page.screenshot({ path: path.join(shots, '1-header.png') })
  const ready = (await status()).startsWith('ready')
  check('new session reaches Ready (SessionStart hook arrives)', ready)
  // Compact… is in the agent's ⋯ (#977): unavailable while the conversation is empty.
  await page.locator('.pane-header-bar').getByRole('button', { name: 'More', exact: true }).click()
  const item = page.locator('.menu .menu-item', { hasText: 'Compact…' })
  check("Compact… is in the agent's ⋯", !!(await lib.until(() => item.isVisible(), HUNG_MS)))
  check('empty session: Compact… unavailable', await item.evaluate((el) => el.classList.contains('disabled')))
  await page.keyboard.press('Escape')
  // The dialog via Session menu -> Compact Conversation.
  await page.locator('.menubar-item', { hasText: 'Session' }).first().click()
  await page.getByText('Compact Conversation…').first().click()
  check('dialog opens from the Session menu', !!(await lib.until(async () => (await page.locator('.dialog', { hasText: 'Compact demo?' }).count()) === 1, HUNG_MS)))
  await page.locator('.compact-focus textarea').fill('keep the test notes')
  await page.screenshot({ path: path.join(shots, '2-dialog.png') })
  await page.locator('.dialog button', { hasText: /^\s*Compact\s*$/ }).click()
  await lib.until(async () => (await inv('pty:buffer', lib.ptyKey(proj, agent.id))).includes('messages'), 10000) // Claude Code answered
  const s1 = await status()
  console.log('status right after /compact:', s1)
  await lib.until(async () => !(await status()).includes('Compacting'), 10000)
  const raw = await inv('pty:buffer', lib.ptyKey(proj, agent.id))
  const i = raw.lastIndexOf('messages')
  console.log('RAW:', JSON.stringify(raw.slice(Math.max(0, i - 120), i + 60)))
  const s2 = await status()
  console.log('status 5 s later:', s2)
  check('refused compaction clears "Compacting" within seconds', !s2.includes('Compacting'))
  await page.screenshot({ path: path.join(shots, '3-after.png') })
  // Settings rows.
  await lib.openProjectSettings(page)
  await page.locator('.settings-nav .row', { hasText: 'Sessions' }).click()
  check('project threshold row', !!(await lib.until(async () => (await page.getByText('Suggest compacting above').count()) >= 1, HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '5-project-settings.png') })
  await inv('session:stop', proj); await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  console.log(results.join('\n'))
  await app.close()
  // No delete of its folders here (#324): the runner gives the suite a new folder and removes it when it passes; a run
  // on its own empties them when it starts. Right after app.close() the CLI it stopped can still hold one, and a
  // failed delete here failed a suite whose checks had all passed.
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
