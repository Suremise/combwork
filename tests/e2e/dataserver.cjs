// A data-only CLI on a model server of the user's (HI-3197), through Combwork with the fake datacli and a local stub
// server speaking OpenAI's API (fake-openai/stub.cjs). Its description takes a server: a server account is added for it
// with a key, its models listed from the stub, one model's context and output set; an agent on a connection there with
// that model runs it, and its line reaches the stub with that model, the key in its header, and the model's limits in the
// description's variables; the key is never on its command line or in Combwork's log. On the CLI's own setup (its
// PC-wide account), none of the server's variables, whatever Combwork's own environment or the description says.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { startStub } = require('./fake-openai/stub.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'dataserver-profile')
const ws = path.join(lib.WORK, 'dataserver-ws')
const proj = path.join(ws, 'demo')
const fakeLog = path.join(lib.WORK, 'dataserver-fake.jsonl')
const KEY = 'sk-local-test-7c1e9b2a'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const launches = () => lines().filter((e) => e.kind === 'launch')

/** The description: OpenAI's protocol, its server in variables, its model as an argument. */
const description = {
  id: 'fake-srv',
  name: 'Fake Server CLI',
  binary: { names: ['datacli'], paths: [path.join(__dirname, 'fake-datacli', 'datacli.cmd')], versionArgs: ['--version'], versionPattern: 'datacli (\\d+\\.\\d+\\.\\d+)' },
  launch: { args: ['--model', '{model}'], prompt: 'typed', env: { FAKE_DATACLI_MARK: 'from-description', OPENAI_API_KEY: 'from-description' } },
  status: { ready: '^> ', working: 'Working…', osc7501: true, exit: '/exit' },
  server: { api: 'openai', env: { OPENAI_BASE_URL: '{baseUrl}', OPENAI_API_KEY: '{key}', DATACLI_CONTEXT: '{context}', DATACLI_OUTPUT: '{output}' }, args: ['--server-mode'] }
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(fakeLog, { force: true })
  fs.mkdirSync(path.join(userData, 'clis'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'clis', 'fake-srv.json'), JSON.stringify(description, null, 2))
  lib.gitProject(proj)
  lib.enableProviders(userData, ['claude-code', 'fake-srv'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const stub = await startStub()
  // Combwork's own environment has a server of its own: a launch on the stub replaces it, one on the CLI's own setup drops it.
  const { app, page, inv } = await lib.launch({ userData, env: { FAKE_DATACLI_LOG: fakeLog, OPENAI_BASE_URL: 'http://inherited.invalid/v1' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv, 'fake-srv')

    // --- A server account, keyed, its models listed from the stub, one model's limits set.
    const acc = await inv('connections:addServer', { cli: 'fake-srv', name: 'Local stub', baseUrl: stub.url, preset: 'ollama', models: [{ id: 'qwen3:8b' }, { id: 'big-model-300b' }], modelsFrom: 'typed', key: KEY })
    check('a server account is added for a CLI that takes a server', !!acc?.id && acc.kind === 'server' && !acc.keyFailed, JSON.stringify(acc))
    await inv('connections:setOn', acc.id, true)
    const listed = await inv('connections:readModels', acc.id, 'r1')
    check('…its models are listed from its server', JSON.stringify(listed).includes('big-model-300b') && stub.requests.some((r) => r.path === '/v1/models'), JSON.stringify(listed))
    await inv('connections:setModelContext', acc.id, 'qwen3:8b', 32768)
    await inv('connections:setModelOutput', acc.id, 'qwen3:8b', 4096)
    const signIn = await inv('connections:add', 'fake-srv', 'Not a sign-in').then(() => 'added', (e) => String(e.message))
    check('…and no sign-in account can be added for it', /server/.test(signIn), signIn)

    // --- Settings shows a server-only CLI's account as what it can do: no Set Up, no Check Server (Anthropic's), and its
    // models without Claude Code's names, labels or limit rules; Claude Code's own server account keeps them.
    const claude = await inv('connections:addServer', { cli: 'claude-code', name: 'Claude local', baseUrl: 'http://localhost:11434', preset: 'ollama', models: [{ id: 'qwen3:8b' }], modelsFrom: 'typed' })
    await inv('connections:setOn', claude.id, true)
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Accounts & Connections' }).click()
    const row = page.locator(`[data-account="${acc.id}"]`)
    const claudeRow = page.locator(`[data-account="${claude.id}"]`)
    await lib.until(async () => ((await row.count()) === 1 && (await claudeRow.count()) === 1 ? true : null), HUNG_MS)
    check('a server-only account offers no Set Up and no Check Server', (await row.locator('[data-set-up]').count()) === 0 && (await row.locator('[data-check-server]').count()) === 0)
    check('…Claude Code’s server account keeps Set Up', (await claudeRow.locator('[data-set-up]').count()) === 1)
    const checkRefused = await inv('connections:testTools', acc.id, 'qwen3:8b', 't1').then(() => 'ran', (e) => String(e.message))
    check('…and Check Server is refused for it, saying why', /Anthropic/.test(checkRefused) && !stub.requests.some((r) => r.path.includes('messages')), checkRefused)
    const editor = page.locator('[data-server-models]')
    await row.locator('[data-edit-server]').click()
    await lib.until(async () => ((await editor.count()) === 1 ? true : null), HUNG_MS)
    const generic = await editor.locator('[data-limits-hint]').innerText().catch(() => '')
    const placeholders = async () => editor.locator('[data-model="big-model-300b"] [data-limit] input').evaluateAll((els) => els.map((e) => e.getAttribute('placeholder')))
    check('…its unset limits say they aren’t passed, with no default of Claude Code’s', JSON.stringify(await placeholders()) === JSON.stringify(['Not set: not passed (the CLI’s own)', 'Not set: not passed (the CLI’s own)']), JSON.stringify(await placeholders()))
    check('its Edit shows no Claude names, labels or /model hints, and says where its limits go', (await editor.locator('.server-model-alias').count()) === 0 && (await editor.locator('[data-picker-hint]').count()) === 0 && (await editor.locator('[data-aliases-hint]').count()) === 0 && (await editor.locator('[data-limit="label"]').count()) === 0 && generic.includes('{context}'), generic)
    await page.keyboard.press('Escape')
    await lib.until(async () => ((await editor.count()) === 0 ? true : null), HUNG_MS)
    await claudeRow.locator('[data-edit-server]').click()
    await lib.until(async () => ((await editor.count()) === 1 ? true : null), HUNG_MS)
    const claudeHolders = await editor.locator('[data-model="qwen3:8b"] [data-limit="context"] input, [data-model="qwen3:8b"] [data-limit="output"] input').evaluateAll((els) => els.map((e) => e.getAttribute('placeholder')))
    check('…while Claude Code’s Edit keeps its names, /model hints and its own defaults', (await editor.locator('.server-model-alias').count()) === 3 && (await editor.locator('[data-picker-hint]').count()) === 1 && /200,000/.test(claudeHolders[0] ?? '') && /8,192/.test(claudeHolders[1] ?? ''), JSON.stringify(claudeHolders))
    await page.keyboard.press('Escape')
    await lib.until(async () => ((await editor.count()) === 0 ? true : null), HUNG_MS)
    await page.locator('[data-add]').first().click()
    await page.locator('[data-cli-choice="fake-srv"]').click()
    await page.locator('#conn-preset').selectOption('ollama')
    await page.locator('[data-server-models] button', { hasText: 'Add Model' }).click()
    await lib.until(async () => ((await editor.locator('.server-model-row').count()) >= 1 ? true : null), HUNG_MS)
    const addHolders = await editor.locator('.server-model-row [data-limit] input').evaluateAll((els) => els.map((e) => e.getAttribute('placeholder')))
    check('its Add offers the server form alone, its models without Claude names or defaults', (await page.locator('[data-from]').count()) === 0 && (await editor.locator('.server-model-alias').count()) === 0 && (await page.locator('#conn-url').inputValue()) === 'http://localhost:11434/v1' && addHolders.length === 2 && addHolders.every((p) => p === 'Not set: not passed (the CLI’s own)'), JSON.stringify(addHolders))
    await page.keyboard.press('Escape')
    await lib.until(async () => ((await editor.count()) === 0 ? true : null), HUNG_MS)
    await page.keyboard.press('Escape')

    // --- An agent on a connection there with that model: its line reaches the stub with the model, the key and the limits.
    const a = await lib.addAgent(inv, proj, { name: 'Local', provider: 'fake-srv' })
    const rows = async () => (await inv('connections:list')).connectionRows
    const onAccount = (await rows()).find((c) => c.account === acc.id)
    await inv('agents:update', proj, a.id, { connection: onAccount.id })
    await lib.setLaunch(inv, proj, a.id, { model: 'qwen3:8b' })
    const live = async () => (await inv('session:live')).find((s) => s.agentId === a.id && s.status !== 'stopped') ?? null
    await inv('session:start', proj, { agentId: a.id, prompt: 'hello server' })
    const asked = await lib.until(async () => stub.requests.find((r) => r.path === '/v1/chat/completions'), HUNG_MS)
    check('its line reaches the server, with its model', asked?.body?.model === 'qwen3:8b' && asked.body.messages?.[0]?.content === 'hello server', JSON.stringify(asked))
    check('…the key in its header', asked?.auth === `Bearer ${KEY}`, String(asked?.auth))
    check('…and the model’s output budget', asked?.body?.max_tokens === 4096, JSON.stringify(asked?.body))
    const onServer = launches().at(-1)
    check('its launch has the server, the key and the model’s context, over Combwork’s own and the description’s', onServer?.env.OPENAI_BASE_URL === stub.url && onServer.env.OPENAI_API_KEY === KEY && onServer.env.DATACLI_CONTEXT === '32768' && onServer.env.DATACLI_OUTPUT === '4096' && onServer.env.FAKE_DATACLI_MARK === 'from-description', JSON.stringify(onServer?.env))
    check('…its server’s arguments and model, and never the key on its command line', onServer?.args.includes('--server-mode') && onServer.args.join(' ').includes('--model qwen3:8b') && !onServer.args.join(' ').includes(KEY), JSON.stringify(onServer?.args))
    const screen = async () => lib.plainText((await inv('pty:buffer', lib.ptyKey(proj, a.id)).catch(() => '')) ?? '')
    check('its answer comes back: the server’s own reply on its screen', !!(await lib.until(async () => ((await screen()).includes('Done: stub answer from qwen3:8b') ? true : null), HUNG_MS, 150)), (await screen()).slice(-300))
    await lib.until(async () => (['finished', 'ready'].includes((await live())?.status) ? true : null), HUNG_MS, 150)
    await inv('session:stop', proj, a.id)
    await lib.until(async () => !(await live()), HUNG_MS, 150)

    // --- On the CLI's own setup (its PC-wide account): none of the server's variables, inherited or from the description.
    const home = (await rows()).find((c) => c.account === 'fake-srv')
    await inv('agents:update', proj, a.id, { connection: home.id })
    await inv('session:start', proj, { agentId: a.id })
    const onHome = await lib.until(async () => (launches().length >= 2 ? launches().at(-1) : null), HUNG_MS)
    check('on its own setup, none of the server’s variables (Combwork’s own nor the description’s)', !!onHome && onHome.env.OPENAI_BASE_URL === null && onHome.env.OPENAI_API_KEY === null && onHome.env.DATACLI_CONTEXT === null && onHome.env.FAKE_DATACLI_MARK === 'from-description' && !onHome.args.includes('--server-mode'), JSON.stringify(onHome))
    await lib.until(async () => ((await live())?.status === 'ready' ? true : null), HUNG_MS, 150)
    await inv('session:stop', proj, a.id)
    await lib.until(async () => !(await live()), HUNG_MS, 150)

    // --- Its description removed (HI-3270): its server account is still listed, saying why, with Remove alone, and goes.
    fs.rmSync(path.join(userData, 'clis', 'fake-srv.json'))
    await inv('clis:reload')
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Accounts & Connections' }).click()
    const goneRow = page.locator(`[data-account="${acc.id}"][data-gone]`)
    await lib.until(async () => ((await goneRow.count()) === 1 ? true : null), HUNG_MS)
    const goneText = await goneRow.innerText().catch(() => '')
    check('with its description gone, its server account is listed, saying so', /fake-srv's description is gone/.test(goneText), goneText)
    check('…with Remove alone: no menu, switch, Edit or Set Up', (await goneRow.locator('button').count()) === 1 && (await goneRow.locator('[data-remove]').count()) === 1 && (await goneRow.locator('[data-action="account-menu"], [data-edit-server], [data-set-up], [data-on-here]').count()) === 0)
    // Its row as it looks, in both themes, for a visual review.
    await page.mouse.move(5, 5)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.screenshot({ path: path.join(lib.WORK, `dataserver-gone-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await goneRow.locator('[data-remove]').click()
    const askGone = page.locator('.dialog', { hasText: 'Remove Local stub?' })
    await lib.until(async () => ((await askGone.count()) === 1 ? true : null), HUNG_MS)
    await askGone.locator('.dialog-footer .btn.danger').click()
    check('…and Remove removes it', !!(await lib.until(async () => ((await goneRow.count()) === 0 && !(await inv('connections:list')).connections.some((c) => c.id === acc.id) ? true : null), HUNG_MS)))
    await page.keyboard.press('Escape')

    // --- The key in none of Combwork's own records.
    const logs = path.join(userData, 'logs')
    const logged = fs.existsSync(logs) ? fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n') : ''
    check('the key is in none of Combwork’s logs', !!logged && !logged.includes(KEY))
  } finally {
    await app.close().catch(() => undefined)
    await stub.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
