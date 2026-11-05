// Model picker, effort and plan usage. Throwaway profile (seeded with a plan usage report) and a
// trusted throwaway workspace; starts one real session but never sends it a prompt or touches the clipboard. Claude
// Code runs in a home of the suite's own with a made-up API key (lib.ownClaudeHome, #368), never the user's ~/.claude.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const scratch = lib.WORK, userData = path.join(scratch, 'plan-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const ws = path.join(scratch, 'plan-ws')
const shots = path.join(scratch, 'pshots')
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true }); fs.mkdirSync(shots, { recursive: true }); fs.mkdirSync(userData, { recursive: true })
const inTwoHours = new Date(Date.now() + 2 * 3600e3 + 14 * 60e3).toISOString()
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ version: 1, planUsage: { fiveHour: { usedPercent: 86, resetsAt: inTwoHours }, sevenDay: { usedPercent: 40, resetsAt: null }, updatedAt: new Date().toISOString() } }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000
/** The longest the real Claude Code may take to start and run its status line: a bound for a hung CLI (#717). */
const CLI_HUNG_MS = 60000
const check = (n, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ` (${extra})` : ''}`)
;(async () => {
  const env = lib.hiveEnv({ CW_USER_DATA: userData, ...lib.ownClaudeHome('plan').env })
  const app = await _electron.launch({ executablePath: process.env.CW_EXE || lib.ELECTRON, args: process.env.CW_EXE ? [] : [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const proj = path.join(ws, 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)

  // Plan usage in the status bar from the stored report.
  const plan = page.locator('.statusbar .status-item', { hasText: '5h' })
  check('status bar shows plan usage', (await plan.textContent()).replace(/\s+/g, '').includes('5h86%·Week40%'), await plan.textContent())
  check('86% is highlighted', (await plan.getAttribute('class')).includes('caution'))
  // Waits for the tooltip itself: a fixed pause missed it when the machine was busy.
  await plan.hover()
  const tipEl = page.locator('.tip', { hasText: 'resets' }).last()
  await tipEl.waitFor({ timeout: 5000 }).catch(() => undefined)
  const tip = await tipEl.textContent().catch(() => '')
  check('tooltip shows reset time', /resets in 2 h 1[34] min/.test(tip), tip)
  await page.screenshot({ path: path.join(shots, '1-statusbar.png') })

  // Overview cards.
  await page.locator('.tab', { hasText: 'Overview' }).click(); await sleep(500)
  check('overview plan cards', (await page.locator('.card', { hasText: '5-hour limit' }).count()) === 1 && (await page.locator('.card', { hasText: 'Weekly limit' }).count()) === 1)
  check('meter coloured at 86%', (await page.locator('.card', { hasText: '5-hour limit' }).locator('.meter.caution').count()) === 1)
  await page.screenshot({ path: path.join(shots, '2-overview.png') })

  // The model picker: a connection's, in its dialog (HI-2145: Settings → Assistant has none since HI-2108, and Claude Code
  // no default model of its own since HI-1774). An account of the suite's own, never signed in, removed after: its first
  // connection edited, each choice saved with the dialog's Save and read back from the connection.
  const account = await inv('connections:add', 'claude-code', 'Max')
  const form = page.locator('[data-connection-form]')
  const editConnection = async () => {
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const row = page.locator(`[data-connections-of="${account.id}"] [data-connection]`).first()
    await row.locator('[data-action="connection-menu"]').click({ timeout: HUNG_MS })
    await page.locator('.menu .menu-item', { hasText: 'Edit…' }).first().click({ timeout: HUNG_MS })
    await form.waitFor({ timeout: HUNG_MS })
  }
  const saveConnection = async () => {
    await page.locator('[data-save-connection]').click()
    await form.waitFor({ state: 'detached', timeout: HUNG_MS })
    await editConnection()
  }
  await page.locator('.activity-btn[aria-label="Settings"]').click()
  await editConnection()
  const picker = form.locator('.model-picker').first()
  await picker.waitFor({ timeout: HUNG_MS })
  const groups = await picker.locator('optgroup').evaluateAll((els) => els.map((e) => e.label))
  const savedModel = async () => (await inv('connections:list')).connectionRows.find((c) => c.account === account.id)?.model ?? ''
  // The models Claude Code reports for this version and account (#125), else Combwork's fallback list.
  const catalog = (await inv('provider:info'))['claude-code']?.catalog
  const offered = (await picker.locator('select option').evaluateAll((os) => os.map((o) => o.value))).filter((v) => v && v !== 'custom')
  let first = 'claude-opus-5-5'
  if (catalog?.models.length) {
    const reported = catalog.models.filter((m) => !m.unavailable).map((m) => m.value)
    check(`the picker lists the models Claude Code ${catalog.version} reports`, groups[0] === 'Claude Code models' && JSON.stringify(offered.slice(0, reported.length)) === JSON.stringify(reported), JSON.stringify({ groups, offered, reported }))
    first = reported[0]
    await picker.locator('select').selectOption(reported.at(-1))
    await saveConnection()
    check('another reported model saved as chosen', !!(await lib.until(async () => (await savedModel()) === reported.at(-1), 5000)), await savedModel())
  } else {
    check('latest and pinned groups, older hidden', JSON.stringify(groups) === JSON.stringify(['Latest (follows new releases)', 'Pinned versions']), JSON.stringify(groups))
    await picker.getByText('Show older versions').click()
    check('older versions shown on request', !!(await lib.until(async () => (await picker.locator('optgroup').count()) === 3, 5000)))
    await picker.locator('select').selectOption('claude-opus-4-5')
    await saveConnection()
    check('an older version saved as chosen', !!(await lib.until(async () => (await savedModel()) === 'claude-opus-4-5', 5000)), await savedModel())
  }
  // No 1M choice (SPEC §9): current models have the 1M window without asking; Opus 4.6 / Sonnet 4.6 reach it only
  // through a [1m] model ID typed as a custom model, which the placeholder says.
  check('no 1M-context choice in the picker', (await picker.locator('input[type=checkbox]').count()) === 0)
  await picker.locator('select').selectOption(first)
  await saveConnection()
  check(`${first} saved as chosen`, !!(await lib.until(async () => (await savedModel()) === first, 5000)), await savedModel())
  await picker.locator('select').selectOption('custom')
  check('the custom model box says how to ask for 1M ([1m])', !!(await lib.until(async () => /\[1m\]/.test((await picker.locator('input.input').getAttribute('placeholder', { timeout: 1000 }).catch(() => '')) ?? ''), HUNG_MS)))
  await picker.locator('input.input').fill('claude-sonnet-9-9'); await picker.locator('input.input').press('Enter')
  await saveConnection()
  check('custom model ID saved', !!(await lib.until(async () => (await savedModel()) === 'claude-sonnet-9-9', HUNG_MS)))
  await picker.locator('select').selectOption(first)
  await saveConnection()
  check(`${first} saved again after the custom ID`, !!(await lib.until(async () => (await savedModel()) === first, HUNG_MS)), await savedModel())
  await page.screenshot({ path: path.join(shots, '3-settings.png') })
  await page.locator('.dialog').last().getByRole('button', { name: 'Cancel' }).click()
  await form.waitFor({ state: 'detached', timeout: HUNG_MS })
  await inv('connections:remove', account.id)

  // Project picker and effort in the header.
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await sleep(300)
  await page.getByText('demo', { exact: true }).first().click()
  await lib.openProjectSettings(page)
  await lib.until(async () => (await page.locator('.setting', { hasText: 'Project key' }).count()) >= 1, HUNG_MS)
  check('Project Settings has no Claude Code page and no model picker (each connection has its own, HI-2107)', (await page.locator('.settings-nav .row', { hasText: 'Claude Code' }).count()) === 0 && (await page.locator('.setting .model-picker').count()) === 0)
  await page.screenshot({ path: path.join(shots, '4-project-settings.png') })

  // Real session: the status line reaches Combwork and prints nothing.
  const agent = await lib.soloAgent(inv, proj)
  // Its own effort (Claude Code has no default effort of its own since HI-1774).
  await lib.setLaunch(inv, proj, agent.id, { effort: 'high' })
  await inv('workspace:refresh')
  await page.locator('.tab', { hasText: 'Session' }).first().click(); await sleep(800)
  // The model's name: Claude Code's default model, by its name once Claude Code has said which it is (#125).
  const chipText = () => page.locator('.pane-footer-bar .pane-foot-item', { hasText: /default/ }).first().textContent({ timeout: 1000 }).catch(() => '').then((t) => t ?? '')
  const chip = (await lib.until(async () => { const t = await chipText(); return t.includes('· High') && t }, HUNG_MS)) || (await chipText())
  check('the agent footer shows the configured effort', chip.includes('· High'), chip)
  await inv('session:start', proj, { agentId: agent.id })
  // Claude Code runs its status line once it has started and drawn its prompt. Under load that came after the 20 s this
  // allowed (#717), and its trust question can come after acceptClaudeTrust's own 15 s: both waited for, bounded only
  // for a hung CLI.
  const startedAt = Date.now()
  await lib.acceptClaudeTrust(inv, proj, agent.id, CLI_HUNG_MS)
  let live = null
  await lib.until(async () => ((live = (await inv('session:live'))[0]), !!live?.effort && !!live?.modelName), CLI_HUNG_MS)
  console.log(`status line: Claude Code reported its effort and model ${Date.now() - startedAt} ms after the start`)
  check('status line reports effort and model', !!live?.effort && !!live?.modelName, JSON.stringify({ effort: live?.effort, modelName: live?.modelName, costUsd: live?.costUsd }))
  await page.locator('.tab', { hasText: 'Session' }).first().click(); await lib.until(async () => (await page.locator('.tab.active', { hasText: 'Session' }).count()) === 1, 10000)
  const raw = await inv('pty:buffer', lib.ptyKey(proj, agent.id))
  check('no status line text in the terminal', !raw.includes('{}') && !/unauthorized|not found/i.test(raw))
  await page.screenshot({ path: path.join(shots, '5-session.png') })
  const usage = await inv('app:planUsage')
  console.log('plan usage after the session started:', JSON.stringify(usage))
  await inv('session:stop', proj); await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  console.log(results.join('\n'))
  await app.close()
  // No delete of its folders here (#324): the runner gives the suite a new folder and removes it when it passes; a run
  // on its own empties them when it starts. Right after app.close() the CLI it stopped can still hold one, and a
  // failed delete here failed a suite whose checks had all passed.
})().catch(async (e) => { console.error(e); console.log(results.join('\n')); process.exit(1) })
