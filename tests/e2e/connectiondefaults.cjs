// Model, effort and context belong to the connection (HI-1770, S3;
// the test seam off so the real rule applies): with Connections on, a project's own model, effort and context move onto
// its agents once (an agent's own kept), recorded in project.json; a connection's defaults are edited in Settings →
// Connections and a launch with none of its own runs them (the fake's launch log), an agent's own winning; Agent Settings
// names "Connection default"; the CLI's and the project's model rows give way; a moved effort its model doesn't take is
// listed once, and stays dismissed. Screenshots in both themes. The fake Claude Code signs in, no browser.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'connectiondefaults-profile')
const home = path.join(lib.WORK, 'connectiondefaults-claude-home')
const ws = path.join(lib.WORK, 'connectiondefaults-ws')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const project = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8'))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  // Its catalogue as the CLI would report it: Haiku takes no effort, so a moved "high" on it can't be used.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {}
  cfg.modelCatalogs = { 'claude-code': { source: 'cli', version: '2.1.999', models: [{ value: 'haiku', label: 'Haiku', efforts: [] }, { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }, { value: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'] }] } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  // The project's own model, effort and context; One has none of its own, Two its own model.
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, providers: { 'claude-code': { model: 'haiku', effort: 'high', permissionMode: 'inherit', extraArgs: '', use200kContext: 'on' } }, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two', model: 'opus' }] }))

  const { app, page } = await lib.launch({ userData, env: { ...env, HIVE_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `connectiondefaults-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- At the open: the project's own moved onto its agents, once, recorded.
    const moved = await lib.until(() => project().migrations?.connections1?.['claude-code'] ?? null, HUNG_MS)
    const agents = project().agents
    const one = agents.find((a) => a.id === 'a-one')
    const two = agents.find((a) => a.id === 'a-two')
    check("the project's model, effort and context moved onto One (none of its own), recorded in project.json", !!moved && one.model === 'haiku' && one.effort === 'high' && one.use200kContext === true, JSON.stringify(one))
    check("…Two's own model kept, the rest given", two.model === 'opus' && two.effort === 'high', JSON.stringify(two))

    // --- A connection, its defaults edited in Settings → Connections.
    fs.mkdirSync(accountsRoot, { recursive: true })
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email: 'one@example.com', orgId: 'org-1' }))
    const max1 = await inv('connections:add', 'claude-code', 'Max 1')
    fs.writeFileSync(path.join(accountsRoot, max1.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
    await inv('connections:signIn', max1.id)
    check('Max 1 signed in', !!(await lib.until(async () => (await inv('connections:list')).connections.find((c) => c.id === max1.id && c.accepted?.email) ?? null, HUNG_MS)))
    await inv('connections:setOn', max1.id, true)
    // The CLI's own defaults deliberately another: Haiku, high, 200K on; the connection's Sonnet, low, 200K off.
    await inv('settings:update', { providers: { 'claude-code': { defaultModel: 'haiku', defaultEffort: 'high', use200kContext: true } } })
    await inv('connections:setDefaults', max1.id, { model: 'sonnet', effort: 'low', use200kContext: false })
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const row = page.locator(`.account-row[data-account="${max1.id}"]`)
    await row.locator('.connection-defaults button').first().click()
    const form = row.locator('.connection-defaults-form')
    check("Settings → Connections: Max 1's defaults show the model and effort set", !!(await lib.until(async () => (await form.locator('select').first().inputValue().catch(() => '')) === 'sonnet', HUNG_MS)))
    await shots('defaults')

    // --- A launch with none of its own runs the connection's defaults; One's own (moved) wins.
    await inv('agents:add', alpha, { name: 'Three' })
    const three = project().agents.find((a) => a.name === 'Three')
    await inv('session:start', alpha, { agentId: three.id })
    const launched = (name) => lines(path.join(accountsRoot, max1.id, 'fake-launches.jsonl')).find((l) => l.env.HIVE_AGENT === name) ?? null
    const t = await lib.until(() => launched('Three'), HUNG_MS)
    check("Three (none of its own) launches with its connection's defaults: --model sonnet --effort low", t?.opts['--model'] === 'sonnet' && t?.opts['--effort'] === 'low', JSON.stringify(t?.opts))
    await inv('session:start', alpha, { agentId: 'a-two' })
    const tw = await lib.until(() => launched('Two'), HUNG_MS)
    check("Two's own model wins (--model opus), its moved effort with it", tw?.opts['--model'] === 'opus' && tw?.opts['--effort'] === 'high', JSON.stringify(tw?.opts))
    await inv('session:start', alpha, { agentId: 'a-one' })
    const o = await lib.until(() => launched('One'), HUNG_MS)
    check("One's moved model runs (--model haiku), its effort that Haiku doesn't take not passed", o?.opts['--model'] === 'haiku' && !o?.opts['--effort'], JSON.stringify(o?.opts))

    // --- The notice: One's moved effort its model doesn't take, listed once; dismissed, it stays so.
    const notice = page.locator('[data-moved-notice]')
    check('the notice lists One’s effort its model doesn’t take', !!(await lib.until(async () => /One: Effort high/.test(await notice.innerText().catch(() => '')), HUNG_MS)), await notice.innerText().catch(() => ''))
    await shots('notice')
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    check('…dismissed, it is gone', !!(await lib.until(async () => (await notice.count()) === 0, HUNG_MS)))
    check('…and stays gone when asked again', (await inv('connections:notice')).length === 0)

    // --- Settings → Claude Code: no model, effort or context rows, nor a note where they went (HI-1774); Project Settings has none either.
    await page.locator('.settings-nav .row[data-section="provider:claude-code"]').click()
    check('Settings → Claude Code: no default model, effort or context rows, and no "moved" note', !!(await lib.until(async () => (await page.getByText('CLI path', { exact: true }).count()) === 1, HUNG_MS)) && (await page.getByText('Default model', { exact: true }).count()) === 0 && (await page.getByText('Default effort', { exact: true }).count()) === 0 && !/Each connection has its own now/.test(await page.locator('body').innerText()))
    await shots('cli')
    await page.keyboard.press('Escape')

    for (const id of ['a-one', 'a-two', three.id]) await inv('session:stop', alpha, id)
    await lib.until(async () => !(await live('a-one')) && !(await live('a-two')), HUNG_MS)
    await page.locator('.project-row', { hasText: 'alpha' }).first().click()
    await lib.openProjectSettings(page)
    // The list of agents is Project Settings → Agents' (HI-1765: it opens on General).
    await page.locator('.tab-body .settings-nav .row').filter({ has: page.locator('.label', { hasText: /^Agents$/ }) }).click()
    const agentRow = page.locator(`.agent-list-row[data-agent="${three.id}"]`)
    check("the Agents list: Three runs its connection's defaults", !!(await lib.until(async () => /Its connection's defaults \(Sonnet/.test(await agentRow.innerText().catch(() => '')), HUNG_MS)), await agentRow.innerText().catch(() => ''))
    await agentRow.getByRole('button', { name: 'Agent Settings' }).click()
    const dialog = page.locator('.dialog').last()
    const base = await lib.until(async () => {
      // The model's choice: the first select whose first option is a "Connection default" (the Connection picker comes before it).
      const first = await dialog.locator('.agent-form select').evaluateAll((all) => all.map((s) => s.options[0]?.textContent ?? '').find((x) => x.startsWith('Connection default')) ?? '').catch(() => '')
      return /Connection default/.test(first ?? '') ? first : null
    }, HUNG_MS)
    check('Agent Settings: an empty model reads "Connection default (Sonnet…)"', !!base && /Connection default \(Sonnet/.test(base), String(base))
    const mode = await dialog.locator('.agent-form select').evaluateAll((all) => all.map((s) => s.options[0]?.textContent ?? '').find((x) => x.startsWith("Project's")) ?? '').catch(() => '')
    check("…its permission mode still follows the project's (never \"Connection default\")", mode.startsWith("Project's ("), mode)
    await shots('agentsettings')
    await page.keyboard.press('Escape')

    // --- Settings → Assistant: an empty model, effort and context name the Assistant's connection's defaults, not the CLI's.
    await page.keyboard.press('Control+,')
    // Settings' own row (Project Settings, still open behind it, has a nav of its own).
    const assistantRow = page.locator('.settings-nav .row[data-section="assistant"]')
    await assistantRow.waitFor({ timeout: HUNG_MS })
    await assistantRow.click()
    const firsts = async () => page.locator('.assistant-defaults').first().locator('select').evaluateAll((all) => all.map((s) => s.options[0]?.textContent ?? '')).catch(() => [])
    const shown = await lib.until(async () => {
      const f = await firsts()
      return f.some((x) => x.startsWith('Connection default')) ? f : null
    }, HUNG_MS)
    check("Settings → Assistant: Connection default (Sonnet…), (Low) and context (Off), never the CLI's Haiku, High, On", !!shown && shown.some((x) => x.startsWith('Connection default (Sonnet')) && shown.includes('Connection default (Low)') && shown.includes('Connection default (Off)') && !shown.some((x) => /Haiku|High|\(On\)/.test(x)), JSON.stringify(shown ?? (await firsts())))
    await shots('assistant')
    await page.keyboard.press('Escape')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
