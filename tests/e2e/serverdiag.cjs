// Server diagnostics (HI-2683): Check Server… on a server connection opens its model's context as a stub of Ollama reports
// it (trained, configured, allocated now, each with when it was read), compares it with Ollama's advice, keeps the
// context the user types as theirs, and runs the tool-call test: a model that writes a tool call out as text fails with
// that named, one that calls the tool and uses its result passes. The stub's Authorization is checked: no key is sent to
// a keyless server. Nothing here signs in or reaches a real server. Screenshots in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const http = require('http')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'serverdiag-profile')
const home = path.join(lib.WORK, 'serverdiag-claude-home')
const ws1 = path.join(lib.WORK, 'serverdiag-ws1')
const alpha = path.join(ws1, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws1]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha])
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One' }] }))

  // A stub of Ollama: its loaded model at an 8K context (HI-2552's SC2), its trained size and Modelfile, and its
  // Messages API, which first writes the tool call out as text, then (once `fixed`) calls it and uses its result.
  const asked = []
  let fixed = false
  const message = (content, stop_reason) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'devstral:24b', content, stop_reason })
  const stub = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      asked.push({ url: req.url, auth: req.headers.authorization ?? null })
      const json = (status, b) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(b))
      }
      if (req.url === '/api/tags') return json(200, { models: [{ name: 'devstral:24b' }] })
      if (req.url === '/api/ps') return json(200, { models: [{ name: 'devstral:24b', model: 'devstral:24b', context_length: 8192 }] })
      if (req.url === '/api/show') return json(200, { model_info: { 'general.architecture': 'mistral3', 'mistral3.context_length': 131072 }, parameters: 'stop "[INST]"' })
      if (req.url === '/v1/messages') {
        const b = JSON.parse(body)
        if (!fixed) return json(200, message([{ type: 'text', text: 'ListFiles.create{"name": "get_weather", "city": "Reykjavik"}' }], 'end_turn'))
        if (b.messages.length === 1) return json(200, message([{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Reykjavik' } }], 'tool_use'))
        const code = /station code (\d+)/.exec(body)?.[1] ?? '?'
        return json(200, message([{ type: 'text', text: `It is -7.3 °C with light snow (station code ${code}).` }], 'end_turn'))
      }
      json(404, {})
    })
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  const port = stub.address().port

  const { app, page } = await lib.launch({ userData, env: { ...env, CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws1)
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `serverdiag-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    const ol = await inv('connections:addServer', { cli: 'claude-code', name: 'Ollama', baseUrl: `http://127.0.0.1:${port}`, preset: 'ollama', models: [{ id: 'devstral:24b' }], modelsFrom: 'typed' })
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row[data-section="accounts"]').click()
    const row = page.locator('.account-row', { has: page.locator('.account-name', { hasText: 'Ollama' }) })
    await row.locator('[data-check-server]').click()
    const dialog = page.locator(`[data-server-diag="${ol.id}"]`)
    await dialog.waitFor({ timeout: HUNG_MS })

    // --- Its context, as the server reports it.
    check('Server diagnostics says it is Ollama', !!(await lib.until(async () => (await dialog.locator('[data-server-kind="ollama"]').count()) === 1, HUNG_MS)))
    const text = () => dialog.innerText().catch(() => '')
    check('…its trained maximum and what is allocated now, each with when it was read', /Trained maximum\s*131,072 tokens · read/.test(await text()) && /Allocated now\s*8,192 tokens · read/.test(await text()), await text())
    check('…what is configured, not reported (no num_ctx), never 0', /Configured\s*not reported/.test(await text()), await text())
    check("…that Ollama's default can't be read", (await text()).includes('OLLAMA_CONTEXT_LENGTH'))
    check("…and below Ollama's advice of 64,000", (await dialog.locator('[data-advice="below"]').count()) === 1 && /This model has 8,192: below it/.test(await text()), await text())
    check('no key went to a keyless server', asked.length > 0 && asked.every((a) => a.auth === null), JSON.stringify(asked.slice(0, 3)))
    await shots('context')

    // --- The tool-call test: tool-shaped text fails, named; then a real call and its result pass.
    await dialog.locator('[data-test-tools]').click()
    check('a tool call written out as text fails, saying so', !!(await lib.until(async () => (await dialog.locator('[data-tool-test="toolText"]').count()) === 1, HUNG_MS)) && (await text()).includes('tool-shaped text rather than a tool call'), await text())
    check('…with what was seen, as data', /Seen: HTTP 200, stop reason end_turn, blocks text/.test(await text()), await text())
    await shots('tools-failed')
    fixed = true
    await dialog.locator('[data-test-tools]').click()
    check('a real call, and an answer that used its result, passes', !!(await lib.until(async () => (await dialog.locator('[data-tool-test="passed"]').count()) === 1, HUNG_MS)), await text())
    check('…saying what it does and does not show', (await text()).includes("doesn't show that every Claude Code tool"))

    // --- The user's own context: kept as theirs, compared with the advice.
    await dialog.locator('[data-context-mine]').fill('65536')
    await dialog.locator('[data-save-context]').click()
    check('the context typed is saved on the model', !!(await lib.until(async () => (await inv('connections:list')).connections.find((a) => a.id === ol.id)?.server?.models[0]?.context === 65536, HUNG_MS)))
    check("…and the server's allocated figure still decides the advice (it never replaces it)", (await dialog.locator('[data-advice="below"]').count()) === 1)
    await shots('passed')
    await page.keyboard.press('Escape')
    await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- Provider Setup: this PC's server, with its line.
    await inv('connections:setModelContext', ol.id, 'devstral:24b', null)
    check('clearing it clears it', !!(await lib.until(async () => (await inv('connections:list')).connections.find((a) => a.id === ol.id)?.server?.models[0]?.context === undefined, HUNG_MS)))
  } finally {
    await app.close().catch(() => undefined)
    stub.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
