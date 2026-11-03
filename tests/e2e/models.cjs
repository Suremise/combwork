// Models and capabilities from the CLIs (#125): the fake Claude Code answers the initialize request and the fake Codex
// `debug models`, each with the recorded reply of the real CLI (tests/fixtures), and the pickers (a connection's, in its dialog: HI-2145) show exactly those
// models; effort pickers offer the selected model's own levels (a choice it doesn't take stays, marked); the footer
// shows a model's default effort ("Medium (default)"); with the CLI unavailable, the fallback lists in Settings apply,
// and editing them and Reset to defaults work; prices can be added, removed and reset. The price tables follow the
// CLIs' lists (#436): a listed model without a price asks for one, a priced one no longer listed is greyed; Claude Code
// has a choice of cost source (its reported cost, or my prices), Codex none but a note with its pricing link. Dev
// build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'models-profile')
const ws = path.join(lib.WORK, 'models-ws')
const claudeHome = path.join(lib.WORK, 'models-claude-home')
const codexHome = path.join(lib.WORK, 'models-codex-home')
const alpha = path.join(ws, 'alpha')
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8'))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = FAKE_CLAUDE
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47930), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const info = async (p) => (await inv('provider:info'))[p]
  const update = (patch) => inv('settings:update', patch)

  // --- What the CLIs said.
  await lib.waitForProvider(inv, 'claude-code')
  await lib.waitForProvider(inv, 'codex')
  const reported = fixture('claude-initialize.json').response.response.models.filter((m) => m.value !== 'default')
  const claude = await info('claude-code')
  check('Claude Code: its models are the ones it reported (fake 2.1.999, the recorded 2.1.289 reply)', claude.catalog?.source === 'cli' && claude.catalog.version === '2.1.999' && JSON.stringify(claude.catalog.models.map((m) => m.value)) === JSON.stringify(reported.map((m) => m.value)), JSON.stringify(claude.catalog))
  check("…and its default model is the one it runs when none is passed", claude.defaultModel === 'claude-opus-5-5', claude.defaultModel)
  const codex = await info('codex')
  check('Codex: its models include gpt-6.1-sol, without the hidden ones', codex.catalog?.models.some((m) => m.value === 'gpt-6.1-sol') && !codex.catalog.models.some((m) => m.value === 'gpt-reserve'), JSON.stringify(codex.catalog?.models.map((m) => m.value)))

  // --- The pickers: a connection's, in its dialog (HI-2145: model and effort are a connection's since HI-2108; Settings →
  // Assistant and the CLIs' pages have none). An account on each CLI, its first connection edited, nothing saved.
  const claudeAccount = await inv('connections:add', 'claude-code', 'Max')
  const codexAccount = await inv('connections:add', 'codex', 'Plus')
  await page.keyboard.press('Control+,')
  const openSection = async (name) => {
    await page.locator('.settings-nav .row', { hasText: name }).first().click()
    await lib.until(async () => (await page.locator('.settings-nav .row.selected', { hasText: name }).count()) > 0, HUNG_MS)
  }
  await openSection('Claude Code')
  check('Settings says where the models come from', (await page.locator('.fallback-source', { hasText: 'Models now: From Claude Code 2.1.999' }).count()) === 1)
  const form = page.locator('[data-connection-form]')
  // Edit… on the account's first connection, in Settings → Accounts & Connections; closed again with Cancel.
  const editConnection = async (account) => {
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const row = page.locator(`[data-connections-of="${account.id}"] [data-connection]`).first()
    await row.locator('[data-action="connection-menu"]').click({ timeout: HUNG_MS })
    await page.locator('.menu .menu-item', { hasText: 'Edit…' }).first().click({ timeout: HUNG_MS })
    await form.waitFor({ timeout: HUNG_MS })
  }
  const cancelConnection = async () => {
    await page.locator('.dialog').last().getByRole('button', { name: 'Cancel' }).click()
    await form.waitFor({ state: 'detached', timeout: HUNG_MS })
  }
  const modelSelect = form.locator('.model-picker select').first()
  const effortSelect = form.locator('select.effort-picker').first()
  const options = async (sel) => sel.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled })))
  await editConnection(claudeAccount)
  const offered = (await options(modelSelect)).map((o) => o.value).filter((v) => v && v !== 'custom')
  check('the Claude Code model picker lists exactly the reported models, Fable included', JSON.stringify(offered) === JSON.stringify(reported.map((m) => m.value)) && offered.includes('fable'), JSON.stringify(offered))
  // An alias reads with the model it stands for, a pinned version as Claude Code names it (#248).
  const labelOf = async (v) => (await options(modelSelect)).find((o) => o.value === v)?.label
  check('the picker lists an alias with its model: Opus (Opus 5.5), Haiku (Haiku 4.5)', (await labelOf('opus')) === 'Opus (Opus 5.5)' && (await labelOf('haiku')) === 'Haiku (Haiku 4.5)', `${await labelOf('opus')}, ${await labelOf('haiku')}`)
  check('…and a pinned version as Claude Code names it: Opus 4.8', (await labelOf('claude-opus-4-8')) === 'Opus 4.8', await labelOf('claude-opus-4-8'))
  await page.screenshot({ path: path.join(lib.WORK, 'models-claude-settings.png') })

  const effortValues = async () => (await options(effortSelect)).map((o) => o.value).filter(Boolean)
  // Each change polled until the picker shows it (HI-1774 round 1: never a sleep, then one look).
  const opusLevels = JSON.stringify(['low', 'medium', 'high', 'max'])
  await modelSelect.selectOption('claude-opus-4-6')
  check("with Opus 4.6, the effort picker offers its levels (no Extra high)", !!(await lib.until(async () => JSON.stringify(await effortValues()) === opusLevels, HUNG_MS)), JSON.stringify(await effortValues()))
  await modelSelect.selectOption('haiku')
  check('with Haiku, none: it has no effort setting, and says so', !!(await lib.until(async () => (await effortValues()).length === 0 && (await form.locator('.effort-caveat', { hasText: 'Haiku 4.5 has no effort setting' }).count()) === 1, HUNG_MS)), JSON.stringify(await effortValues()))
  // …and with Claude Code's default mode (Auto), the warning under the mode that Haiku doesn't run in it (#129: the
  // recorded 2.1.289 reply doesn't offer Auto with Haiku; HI-2145: the connection dialog's since HI-2108).
  check('with Haiku, the mode warns about Auto with Haiku', !!(await lib.until(async () => (await form.locator('.mode-caveat', { hasText: 'Auto with Haiku' }).count()) === 1, HUNG_MS)), JSON.stringify(await form.locator('.mode-caveat').allInnerTexts()))
  await page.screenshot({ path: path.join(lib.WORK, 'models-haiku-auto.png') })
  // A choice the model doesn't take stays chosen, marked, never changed behind the user's back: Extra high on Opus,
  // then Opus 4.6.
  await modelSelect.selectOption('opus')
  await lib.until(async () => (await effortValues()).includes('xhigh'), HUNG_MS)
  await effortSelect.selectOption('xhigh')
  await modelSelect.selectOption('claude-opus-4-6')
  const unsupportedShown = async () => {
    const o = (await options(effortSelect)).find((x) => x.value === 'xhigh')
    return (await effortSelect.inputValue()) === 'xhigh' && /not offered with Opus 4\.6/.test(o?.label ?? '') && (await form.locator('.effort-caveat', { hasText: "doesn't offer Extra high with Opus 4.6" }).count()) === 1
  }
  check("an effort the model doesn't take stays, marked as such", !!(await lib.until(unsupportedShown, HUNG_MS)), JSON.stringify((await options(effortSelect)).find((o) => o.value === 'xhigh')))
  await page.screenshot({ path: path.join(lib.WORK, 'models-effort-unsupported.png') })
  // Both themes: the warning and the lists in light too.
  const themed = (t) => lib.until(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === t, HUNG_MS)
  const light = async (file) => {
    await update({ appearance: { theme: 'light' } })
    await themed('light')
    await page.screenshot({ path: path.join(lib.WORK, file) })
    await update({ appearance: { theme: 'dark' } })
    await themed('dark')
  }
  await light('models-effort-unsupported-light.png')
  await cancelConnection()

  // --- Codex's, in its connection's dialog too.
  await editConnection(codexAccount)
  const codexOffered = (await options(modelSelect)).map((o) => o.value)
  check('the Codex model picker includes gpt-6.1-sol', codexOffered.includes('gpt-6.1-sol') && !codexOffered.includes('gpt-reserve'), JSON.stringify(codexOffered))
  await modelSelect.selectOption('gpt-5.5')
  const codexLevels = JSON.stringify(['low', 'medium', 'high', 'xhigh'])
  check('with GPT-5.5, the Codex effort picker stops at Extra high', !!(await lib.until(async () => JSON.stringify(await effortValues()) === codexLevels, HUNG_MS)), JSON.stringify(await effortValues()))
  await cancelConnection()

  // --- The footer: a model's default effort when nothing is set or reported.
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.addAgent(inv, alpha, { name: 'Sol', provider: 'codex', model: 'gpt-6-sol', permissionMode: 'approve-for-me' })
  const footer = page.locator('.pane-footer-bar').first()
  const footerText = async () => (await footer.innerText().catch(() => '')) + (await footer.locator('[title]').evaluateAll((es) => es.map((e) => e.getAttribute('title')).join(' ')).catch(() => ''))
  const shown = await lib.until(async () => /Medium \(default\)/.test(await footerText()), 8000)
  check("the footer shows the model's default effort: Medium (default)", !!shown, await footer.innerText().catch(() => ''))
  // Effort levels renamed in Settings name the footer's effort too, as they do the pickers' (#230); Reset gives Hive's.
  await inv('settings:setProviderFallback', 'codex', 'efforts', [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Mid' }, { value: 'high', label: 'High' }])
  check('a renamed effort level names the footer’s effort: Mid (default)', !!(await lib.until(async () => /Mid \(default\)/.test(await footerText()), 8000)), await footer.innerText().catch(() => ''))
  await inv('settings:setProviderFallback', 'codex', 'efforts', null)
  check('…and after Reset to defaults, Medium (default) again', !!(await lib.until(async () => /Medium \(default\)/.test(await footerText()), 8000)), await footer.innerText().catch(() => ''))

  // --- The model that runs (#248): an agent and the Assistant on "Opus", and an agent on the default, all show Opus 5.5.
  await lib.addAgent(inv, alpha, { name: 'Writer', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Plain' })
  await page.locator('.layout-switch button[aria-label="Three columns"]').click()
  const modelOf = (name) => page.locator('.agent-pane', { has: page.locator('.pane-header-bar', { hasText: name }) }).locator('.foot-model')
  const modelText = async (name) => (await modelOf(name).innerText().catch(() => '')).split(' · ')[0].trim()
  check('an agent set to Opus shows the model it runs: Opus 5.5', !!(await lib.until(async () => (await modelText('Writer')) === 'Opus 5.5', 8000)), await modelText('Writer'))
  check('an agent on the default shows Opus 5.5 (default)', (await modelText('Plain')) === 'Opus 5.5 (default)', await modelText('Plain'))
  await modelOf('Writer').hover()
  check('…and the tooltip says it was chosen as Opus', !!(await lib.until(async () => (await page.locator('.tip', { hasText: 'Opus 5.5 · chosen as Opus' }).count()) > 0, HUNG_MS)))
  // The Assistant's model is its connection's (HI-2108): set as an agent's is (lib.setLaunch), onto a connection on its account.
  const assistantHome = path.join(ws, '.hive', 'assistant')
  await lib.setLaunch(inv, assistantHome, 'assistant', { model: 'opus' })
  if ((await page.locator('.assistant-panel').count()) === 0) await page.locator('.assistant-rail').click()
  const assistantModel = async () => (await page.locator('.assistant-footer .foot-model').innerText().catch(() => '')).split(' · ')[0].trim()
  check('the Assistant set to Opus shows Opus 5.5 too', !!(await lib.until(async () => (await assistantModel()) === 'Opus 5.5', 8000)), await assistantModel())
  await page.screenshot({ path: path.join(lib.WORK, 'models-alias-footers.png') })
  await light('models-alias-footers-light.png')
  // Claude Code's own default given as an alias (the test home's settings.json "model"): resolved too, still "(default)".
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'opus' }))
  await inv('provider:refresh', 'claude-code')
  check("Claude Code's default is now its settings' alias", !!(await lib.until(async () => (await info('claude-code')).defaultModel === 'opus', 15000)), (await info('claude-code')).defaultModel)
  check('…and an agent on the default still shows Opus 5.5 (default)', !!(await lib.until(async () => (await modelText('Plain')) === 'Opus 5.5 (default)', 8000)), await modelText('Plain'))
  fs.rmSync(path.join(claudeHome, 'settings.json'), { force: true })
  await inv('provider:refresh', 'claude-code')
  await lib.until(async () => (await info('claude-code')).defaultModel === 'claude-opus-5-5', 15000)
  await lib.setLaunch(inv, assistantHome, 'assistant', { model: '' })
  // Hidden from the header's ⋯ (#979: the header's own Hide button went into it).
  await page.locator('.assistant-header button[aria-label="More"]').click()
  await page.locator('.menu .menu-item', { hasText: 'Fold the Assistant panel' }).click()

  // --- Without the CLI: the fallback lists, as edited, and Reset to defaults.
  await page.keyboard.press('Control+,')
  await openSection('Claude Code')
  const modelsRow = page.locator('.fallback-table', { has: page.locator('.fallback-source', { hasText: 'Models now' }) })
  // While the CLI answers and the list is Hive's own, it is folded.
  check("the models fallback is folded while the CLI's answer is in use", (await modelsRow.locator('.fallback-toggle', { hasText: /Show the list \(\d+ models\)/ }).count()) === 1 && (await modelsRow.locator('.fallback-list').count()) === 0)
  await modelsRow.locator('.fallback-toggle').click()
  await modelsRow.getByLabel("New model id").fill('claude-test-9')
  await modelsRow.getByRole('button', { name: 'Add' }).click()
  await lib.until(async () => ((await update({})).providers['claude-code'].modelFallback ?? []).some((m) => m.value === 'claude-test-9'), HUNG_MS)
  const edited = (await update({})).providers['claude-code'].modelFallback ?? []
  check('adding a model stores the list as yours (the shipped ones and yours)', edited.at(-1)?.value === 'claude-test-9' && edited.some((m) => m.value === 'opus'), JSON.stringify(edited.map((m) => m.value)))
  // The CLI can't be asked: one that gives its version but answers nothing else (a missing path would have Hive look
  // for the machine's own Claude Code, which a test never uses).
  const broken = path.join(lib.WORK, 'models-broken-claude', 'claude.cmd')
  fs.mkdirSync(path.dirname(broken), { recursive: true })
  fs.writeFileSync(broken, ['@echo off', 'if "%1"=="--version" (', '  echo 2.1.998 ^(Claude Code^)', '  exit /b 0', ')', 'exit /b 1', ''].join('\r\n'))
  await update({ providers: { 'claude-code': { executablePath: broken } } })
  await inv('provider:refresh', 'claude-code')
  await lib.until(async () => { const i = await info('claude-code'); return !i.checking && i.version === '2.1.998' && !i.catalog }, 20000)
  check('the broken CLI is the one Hive uses, and it gave no models', (await info('claude-code')).version === '2.1.998' && !(await info('claude-code')).catalog, JSON.stringify((await info('claude-code')).version))
  // The picker: a connection's (Claude Code has no default model of its own, HI-1774); the list's source on its page.
  await editConnection(claudeAccount)
  const fallbackOffered = (await options(modelSelect)).map((o) => o.value)
  await cancelConnection()
  await openSection('Claude Code')
  check('without the CLI, the picker offers your fallback list', fallbackOffered.includes('claude-test-9') && !fallbackOffered.includes('claude-sonnet-5'), JSON.stringify(fallbackOffered))
  check('…and Settings says so', (await page.locator('.fallback-source', { hasText: "Fallback (Claude Code couldn't be asked), as you edited it" }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'models-fallback.png') })
  await modelsRow.locator('.fallback-source').scrollIntoViewIfNeeded()
  await light('models-fallback-light.png')
  await modelsRow.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !(await update({})).providers['claude-code'].modelFallback, HUNG_MS)
  await editConnection(claudeAccount)
  const shipped = await modelSelect.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.label))
  await cancelConnection()
  check("Reset to defaults: Hive's own list again", !(await update({})).providers['claude-code'].modelFallback && shipped[0] === 'Latest (follows new releases)', JSON.stringify(shipped))
  await openSection('Claude Code')
  // The effort fallback: renamed levels name the pickers' options.
  const effortsRow = page.locator('.fallback-table', { has: page.locator('.fallback-source', { hasText: /levels|per-model/ }) })
  if (await effortsRow.locator('.fallback-toggle').count()) await effortsRow.locator('.fallback-toggle').click()
  await effortsRow.getByLabel('Name 1').fill('Quick')
  await effortsRow.getByLabel('Name 1').blur()
  await lib.until(async () => ((await update({})).providers['claude-code'].effortFallback ?? [])[0]?.label === 'Quick', HUNG_MS)
  await editConnection(claudeAccount)
  check('a renamed effort level names the effort picker option', !!(await lib.until(async () => (await options(effortSelect)).some((o) => o.value === 'low' && o.label === 'Quick'), HUNG_MS)), JSON.stringify(await options(effortSelect)))
  await cancelConnection()
  await openSection('Claude Code')
  await effortsRow.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !(await update({})).providers['claude-code'].effortFallback, HUNG_MS)
  await editConnection(claudeAccount)
  check('…and Reset to defaults names it Low again', !!(await lib.until(async () => (await options(effortSelect)).some((o) => o.value === 'low' && o.label === 'Low'), HUNG_MS)), JSON.stringify(await options(effortSelect)))
  await cancelConnection()
  await openSection('Claude Code')

  // --- Prices: add, remove, reset.
  const prices = page.locator('.fallback-table', { has: page.locator('.price-table') })
  check('the price table says when its prices were checked', (await prices.locator('.fallback-source', { hasText: /checked \d{4}-\d{2}-\d{2}/ }).count()) === 1)
  await prices.getByLabel("New model's ID").fill('claude-test-9')
  await prices.getByRole('button', { name: 'Add model' }).click()
  await lib.until(async () => !!(await update({})).providers['claude-code'].prices['claude-test-9'], HUNG_MS)
  await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).getByRole('button', { name: 'Remove from the table' }).click()
  await lib.until(async () => ((await update({})).providers['claude-code'].pricesRemoved ?? []).includes('claude-haiku-4-5'), HUNG_MS)
  const afterEdit = await update({})
  check('a model added and a shipped one removed', !!afterEdit.providers['claude-code'].prices['claude-test-9'] && afterEdit.providers['claude-code'].pricesRemoved?.includes('claude-haiku-4-5') && (await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).count()) === 0)
  await prices.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !Object.keys((await update({})).providers['claude-code'].prices).length, HUNG_MS)
  const afterReset = await update({})
  check("Reset to defaults: Combwork's prices again", !Object.keys(afterReset.providers['claude-code'].prices).length && !afterReset.providers['claude-code'].pricesRemoved && (await prices.locator('tr', { hasText: 'claude-haiku-4-5' }).count()) === 1)

  // The CLI back: its models again.
  await update({ providers: { 'claude-code': { executablePath: FAKE_CLAUDE } } })
  await inv('provider:refresh', 'claude-code')
  await lib.until(async () => (await info('claude-code')).catalog?.source === 'cli', 15000)
  check('with the CLI back, its models again', (await info('claude-code')).catalog?.source === 'cli')

  // --- Price tables follow the CLI's list (#436).
  const row = (m) => prices.locator('tr', { hasText: m })
  check("a priced model Claude Code doesn't list (Haiku 5.5 in this reply) is kept, greyed", !!(await lib.until(async () => (await row('claude-haiku-5-5').getAttribute('class'))?.includes('unlisted'), 5000)) && (await row('claude-haiku-5-5').locator('.badge', { hasText: "not in Claude Code's list" }).count()) === 1)
  check('…and a listed one is not', (await row('claude-opus-5-5').locator('.badge').count()) === 0 && !(await row('claude-opus-5-5').getAttribute('class'))?.includes('unlisted'))
  // A listed model with no price (its shipped price removed): a row asking for one, with no Remove.
  await row('claude-opus-4-6').getByRole('button', { name: 'Remove from the table' }).click()
  const noPrice = row('claude-opus-4-6').locator('.badge', { hasText: 'No price: enter one' })
  check('a model Claude Code lists without a price asks for one', !!(await lib.until(async () => (await noPrice.count()) === 1, HUNG_MS)) && (await row('claude-opus-4-6').getByRole('button', { name: 'Remove from the table' }).count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'models-prices-claude.png') })
  await row('claude-opus-4-6').getByLabel('claude-opus-4-6 Input').fill('3')
  await row('claude-opus-4-6').getByLabel('claude-opus-4-6 Input').blur()
  check('…and entering one saves it as yours', !!(await lib.until(async () => (await update({})).providers['claude-code'].prices['claude-opus-4-6']?.input === 3, HUNG_MS)) && !!(await lib.until(async () => (await noPrice.count()) === 0, HUNG_MS)))
  await prices.getByRole('button', { name: 'Reset to defaults' }).click()
  await lib.until(async () => !Object.keys((await update({})).providers['claude-code'].prices).length, HUNG_MS)

  // Claude Code reports its cost: Session costs chooses its report (the default) or my prices.
  const costRow = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Session costs' }) })
  const costSelect = costRow.locator('select')
  check("Claude Code: Session costs, its reported cost by default", (await costSelect.inputValue()) === 'reported' && (await costSelect.locator('option').allTextContents()).join('|') === "Claude Code's reported cost|My prices (the table below)", await costSelect.inputValue())
  await costSelect.selectOption('prices')
  check('…and choosing my prices is saved', !!(await lib.until(async () => (await update({})).providers['claude-code'].costSource === 'prices', HUNG_MS)))
  check('Claude Code shows no "doesn\'t report costs" note', (await page.locator('.price-note').count()) === 0)
  await costSelect.selectOption('reported')
  await lib.until(async () => (await update({})).providers['claude-code'].costSource === 'reported', HUNG_MS)

  // Codex reports no cost: no choice, a note with its pricing link, and its own list's models.
  await openSection('Codex')
  check('Codex: no Session costs choice', (await costRow.count()) === 0)
  const note = page.locator('.price-note')
  check("…but a note that it doesn't report costs, with OpenAI's pricing link", !!(await lib.until(async () => (await note.count()) === 1, HUNG_MS)) && /Codex doesn't report costs, so Combwork estimates them from these prices/.test(await note.innerText()) && (await note.locator('a', { hasText: "OpenAI's pricing" }).count()) === 1)
  check('…and a shipped model Codex no longer lists (gpt-5.3-codex) greyed', (await row('gpt-5.3-codex').locator('.badge', { hasText: "not in Codex's list" }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'models-prices-codex.png') })

  await app.close()
  if (failed) console.log(`${failed} failed`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
