// Server connections (HI-1772, S6; the test seam off): Add Connection
// asks where a connection gets its model, and a server's form (the DeepSeek preset, a dummy key in a password box) adds
// one; its row shows its host and the key's last 4 characters only. An agent on it launches with the server's variables
// (base URL, the key as a bearer token, each Claude name's model) in its own folder; the footer shows the server's model
// with the Claude names it stands in for. A refused key stops it as "Key refused"; a new key lets it carry on. A local
// server (the Ollama preset, a stub here) needs no key: its models are read from it, and its launch gets the placeholder.
// The key is in no log, config or diagnostics, and never in plain text in its store. Dummy keys only; the fake Claude
// Code throughout. Screenshots in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const http = require('http')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'servers-profile')
const home = path.join(lib.WORK, 'servers-claude-home')
const ws1 = path.join(lib.WORK, 'servers-ws1')
const alpha = path.join(ws1, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
// Dummy keys shaped so no other masking rule catches them.
const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
const KEY2 = 'Hn%3*bQ6(kD1)yU5+eW2'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
/** The agents launched on a connection: its folder's fake launch log (a disposable test file, its dummy key in it). */
const launchedIn = (id) => lines(path.join(accountsRoot, id, 'fake-launches.jsonl'))
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')

;(async () => {
  for (const d of [userData, ws1]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }, { id: 'a-two', name: 'Two' }] }))

  // A local server standing in for Ollama: its model list (/api/tags), the Authorization header it got recorded. A cloud
  // model (HI-1773) has remote_host, as Ollama's ListModelResponse does.
  const asked = []
  let tags = [{ name: 'qwen3:8b' }, { name: 'devstral:24b' }]
  const stub = http.createServer((req, res) => {
    asked.push({ url: req.url, auth: req.headers.authorization ?? null })
    res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' })
    res.end(req.url === '/api/tags' ? JSON.stringify({ models: tags }) : '{}')
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  const port = stub.address().port

  const { app, page } = await lib.launch({ userData, env: { ...env, CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const consoleText = []
    page.on('console', (m) => consoleText.push(m.text()))
    const invOn = (p) => (ch, ...a) => p.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const inv = invOn(page)
    await lib.openWorkspace(inv, page, ws1)
    const list = () => inv('connections:list')
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `connections-server-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const row = (name) => page.locator('.account-row', { has: page.locator('.account-name', { hasText: name }) })
    /** Back from Settings to the project (Settings is a view: the activity bar's Projects leaves it). */
    const closeSettings = async () => {
      await page.locator('.activity-btn[aria-label="Projects"]').click()
      await page.getByText('alpha', { exact: true }).first().click()
      check('back on the project', !!(await lib.until(async () => (await page.locator('.settings-nav').count()) === 0, HUNG_MS)))
    }

    // --- Add Connection: where it gets its model, then a server's form from the DeepSeek preset, the key typed once.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    await page.locator('[data-add]').click()
    await page.locator('[data-from="server"]').waitFor({ timeout: HUNG_MS })
    check('Add Connection asks where it gets its model', (await page.locator('[data-from="signIn"]').count()) === 1)
    await page.locator('[data-from="server"]').check()
    await page.locator('#conn-preset').selectOption('deepseek')
    check('…the DeepSeek preset fills the name, base URL and models', (await page.locator('#conn-name').inputValue()) === 'DeepSeek' && (await page.locator('#conn-url').inputValue()) === 'https://api.deepseek.com/anthropic' && (await page.locator('[data-server-models] [data-model]').count()) === 3)
    await page.locator('#conn-key').fill(KEY)
    check('…the key in a password box', (await page.locator('#conn-key').getAttribute('type')) === 'password')
    await shots('add')
    await page.locator('[data-add-connection]').click()
    const ds = await lib.until(async () => (await list()).connections.find((c) => c.name === 'DeepSeek' && c.kind === 'server' && c.key) ?? null, HUNG_MS)
    check('added as a server connection, with its key', !!ds && ds.key.last4 === KEY.slice(-4))
    check('…its row shows its host and the key by its last 4 characters only', !!(await lib.until(async () => (await row('DeepSeek').innerText().catch(() => '')).includes(`api.deepseek.com · Key …${KEY.slice(-4)}`), HUNG_MS)))
    check('…and nothing in the window holds the key', !(await page.content()).includes(KEY) && !JSON.stringify(await list()).includes(KEY))
    // A new server connection's folder has had none of Claude Code's first-run screens (HI-1870): said, Set Up primary.
    check('…it needs set up, said on its row with the primary Set Up and what Set Up is for', !!(await lib.until(async () => (await row('DeepSeek').locator('[data-set-up-state="needed"]').count()) === 1, HUNG_MS)) && (await row('DeepSeek').locator('[data-set-up].primary').count()) === 1 && /first-run questions/.test(await row('DeepSeek').locator('[data-set-up-note]').innerText().catch(() => '')))
    await shots('row')

    // --- An agent on it: the server's variables, in its own folder.
    fs.writeFileSync(path.join(accountsRoot, ds.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
    await inv('connections:setOn', ds.id, true)
    await closeSettings()
    await inv('session:start', alpha, { agentId: 'a-one' })
    const launch = await lib.until(async () => launchedIn(ds.id).find((l) => l.env.CW_AGENT === 'One') ?? null, HUNG_MS)
    check('One launches on the server connection, in its folder', !!launch && launch.env.CLAUDE_CONFIG_DIR === path.join(accountsRoot, ds.id))
    check('…with its base URL and the key as a bearer token', launch?.env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic' && launch?.env.ANTHROPIC_AUTH_TOKEN === KEY && !launch?.env.ANTHROPIC_API_KEY)
    check("…and each Claude name's model", launch?.env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'deepseek-flash[1m]' && launch?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'deepseek-flash' && launch?.env.CLAUDE_CODE_SUBAGENT_MODEL === 'deepseek-flash' && launch?.env.ANTHROPIC_MODEL === 'deepseek-flash[1m]', JSON.stringify(launch?.env))
    check('…no effort passed', !launch?.opts['--effort'])

    // --- The footer: the server's model, with the Claude names it stands in for.
    const ready = async () => (await live('a-one'))?.status === 'idle' || (await live('a-one'))?.status === 'ready'
    await lib.until(ready, HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'a-one'), 'statusmodel deepseek-flash', { submitted: async () => !!(await live('a-one'))?.modelId })
    check('the footer shows the server’s model and what it stands in for', !!(await lib.until(async () => (await page.locator('.foot-model').first().innerText().catch(() => '')).includes('deepseek-flash (as Haiku)'), HUNG_MS)), await page.locator('.foot-model').first().innerText().catch(() => ''))
    await shots('footer')

    // --- A refused key: "Key refused"; a new key lets it carry on.
    fs.writeFileSync(path.join(accountsRoot, ds.id, 'fake-signin.json'), JSON.stringify({ expired: true }))
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'a-one'), 'hello', { submitted: async () => (await live('a-one'))?.status === 'signin' })
    check('a refused key stops it, its status saying so', !!(await lib.until(async () => (await page.locator('.pane-status.signin').first().innerText().catch(() => '')) === 'Key refused', HUNG_MS)))
    await shots('refused')
    fs.writeFileSync(path.join(accountsRoot, ds.id, 'fake-signin.json'), JSON.stringify({ expired: false }))
    await inv('connections:setKey', ds.id, KEY2)
    check('…a new key: it waits for Resume no more', !!(await lib.until(async () => (await live('a-one'))?.status !== 'signin', HUNG_MS)), (await live('a-one'))?.status)
    check('…its row shows the new key', !!(await lib.until(async () => (await list()).connections.find((c) => c.id === ds.id)?.key?.last4 === KEY2.slice(-4), HUNG_MS)))
    await inv('session:stop', alpha, 'a-one')

    // --- A local server (the Ollama preset): no key; its models read from it; the placeholder at launch.
    const ol = await inv('connections:addServer', { cli: 'claude-code', name: 'Ollama', baseUrl: `http://127.0.0.1:${port}`, preset: 'ollama', models: [], modelsFrom: 'listed' })
    const readOut = await inv('connections:readModels', ol.id, 'r1')
    check("a local server's models are read from it, no key sent", readOut.ok && readOut.models.map((m) => m.id).join() === 'qwen3:8b,devstral:24b' && asked.length === 1 && asked[0].url === '/api/tags' && asked[0].auth === null, JSON.stringify({ readOut, asked }))
    await inv('connections:editServer', ol.id, { models: [{ id: 'qwen3:8b', as: ['opus', 'sonnet', 'haiku'] }, { id: 'devstral:24b' }] })
    await inv('connections:setOn', ol.id, true)
    fs.writeFileSync(path.join(accountsRoot, ol.id, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
    await inv('agents:update', alpha, 'a-two', { connection: ol.id })
    await inv('session:start', alpha, { agentId: 'a-two' })
    const local = await lib.until(async () => launchedIn(ol.id).find((l) => l.env.CW_AGENT === 'Two') ?? null, HUNG_MS)
    check('an agent on it launches with its base URL and the placeholder, no key', local?.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${port}` && local?.env.ANTHROPIC_AUTH_TOKEN === 'none' && local?.env.ANTHROPIC_MODEL === 'qwen3:8b', JSON.stringify(local?.env))
    // Its conversation runs only on a server on this PC: free (Darren, 27 Oct), whatever the CLI reports.
    await lib.until(async () => ['idle', 'ready'].includes((await live('a-two'))?.status), HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'a-two'), 'hello', { submitted: async () => !!(await live('a-two'))?.costFree })
    const twoPane = page.locator('.agent-pane', { has: page.locator('.pane-header-bar', { hasText: 'Two' }) })
    check('its footer says free (local)', !!(await lib.until(async () => (await twoPane.locator('.foot-cost[data-cost="free"]').innerText().catch(() => '')) === 'free (local)', HUNG_MS)))
    // Its turn over before going on (the footer says free as soon as its record does, before the turn ends): a quit with
    // an agent at work would ask about it.
    check('…its turn over, still free', !!(await lib.until(async () => ['idle', 'ready', 'finished'].includes((await live('a-two'))?.status) && (await live('a-two'))?.costFree === true, HUNG_MS)))
    await shots('free')
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    check('…its row says it is on this PC, with no key', !!(await lib.until(async () => (await row('Ollama').innerText().catch(() => '')).includes(`127.0.0.1:${port} · On this PC, no key`), HUNG_MS)))
    await shots('local')

    // --- Ollama's preset (HI-1773): its Claude Code guide, and its recommended context length as advice.
    await page.locator('[data-add]').click()
    await page.locator('[data-from="server"]').check()
    await page.locator('#conn-preset').selectOption('ollama')
    check("the Ollama preset recommends Ollama's context length, as advice", !!(await lib.until(async () => (await page.locator('[data-context-advice]').innerText().catch(() => '')).includes('Ollama recommends a context length of 64,000 tokens or more for Claude Code'), HUNG_MS)))
    check('…and links its Claude Code guide', (await page.locator('.server-form').innerText()).includes('https://docs.ollama.com/integrations/claude-code'))
    await shots('ollama-preset')
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('#conn-preset').count()) === 0, HUNG_MS)

    // --- A cloud model Ollama lists (HI-1773, Darren 27 Oct): marked cloud, and the connection no longer free (local).
    tags = [{ name: 'qwen3:8b' }, { name: 'devstral:24b' }, { name: 'mine', model: 'mine', remote_model: 'glm-4.6', remote_host: 'https://ollama.com:443' }]
    await inv('session:stop', alpha, 'a-two')
    await row('Ollama').locator('[data-read-models]').click()
    check("a model Ollama runs in the cloud is marked so in its row, whatever its name", !!(await lib.until(async () => (await row('Ollama').locator('[data-server-models-line]').innerText().catch(() => '')).includes('mine (cloud)'), HUNG_MS)), await row('Ollama').innerText().catch(() => ''))
    await shots('cloud')
    // The pattern for typed models, changed in Settings → Advanced: the row follows at once, both ways, with nothing
    // edited or read again (HI-1773 round 1).
    const modelsLine = () => row('Ollama').locator('[data-server-models-line]').innerText().catch(() => '')
    await inv('advanced:set', 'claude-code.connections.remoteModels', '^devstral:')
    check('…a pattern set in Advanced marks a typed model cloud at once', !!(await lib.until(async () => (await modelsLine()).includes('devstral:24b (cloud)'), HUNG_MS)), await modelsLine())
    await inv('advanced:set', 'claude-code.connections.remoteModels', null)
    check('…and set back, unmarks it, the listed mark kept', !!(await lib.until(async () => !(await modelsLine()).includes('devstral:24b (cloud)') && (await modelsLine()).includes('mine (cloud)'), HUNG_MS)), await modelsLine())
    await closeSettings()
    await inv('session:start', alpha, { agentId: 'a-two' })
    check('Two launches again on it, as not only on this PC', !!(await lib.until(async () => (await live('a-two'))?.launchedConnection?.server?.local === false, HUNG_MS)), JSON.stringify((await live('a-two'))?.launchedConnection))
    await lib.until(async () => ['idle', 'ready'].includes((await live('a-two'))?.status), HUNG_MS)
    await lib.sendPrompt(inv, lib.ptyKey(alpha, 'a-two'), 'statusmodel mine', { submitted: async () => (await live('a-two'))?.modelId === 'mine' })
    check('…its footer names the model as cloud', !!(await lib.until(async () => (await twoPane.locator('.foot-model').innerText().catch(() => '')).includes('mine (cloud)'), HUNG_MS)), await twoPane.locator('.foot-model').innerText().catch(() => ''))
    check('…its turn over, not free', !!(await lib.until(async () => ['idle', 'ready', 'finished'].includes((await live('a-two'))?.status), HUNG_MS)) && (await live('a-two'))?.costFree !== true && (await twoPane.locator('.foot-cost[data-cost="free"]').count()) === 0)
    await shots('cloud-footer')
    await inv('session:stop', alpha, 'a-two')

    // --- The key is nowhere else: not in the log, config, diagnostics or the window's console, never in plain text in its store.
    const diag = await inv('app:diagnostics')
    const keyStore = read(path.join(userData, 'connection-keys.json'))
    check('the key store holds it encrypted, by its last 4 characters', keyStore.includes(ds.id) && !keyStore.includes(KEY) && !keyStore.includes(KEY2))
    check('…and no backup of it is kept', !fs.existsSync(path.join(userData, 'connection-keys.json.bak')))
    for (const [where, text] of [['hive.log', lib.hiveLogLines(userData).join('\n')], ['config.json', read(path.join(userData, 'config.json'))], ['config.json.bak', read(path.join(userData, 'config.json.bak'))], ['Copy Diagnostics', String(diag)], ["the window's console", consoleText.join('\n')]]) check(`no key in ${where}`, !text.includes(KEY) && !text.includes(KEY2))

    // --- Removed: its key goes with it.
    await inv('connections:remove', ds.id)
    check('removing it removes its key', !!(await lib.until(async () => !read(path.join(userData, 'connection-keys.json')).includes(ds.id), HUNG_MS)))
  } finally {
    await app.close().catch(() => undefined)
    stub.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
