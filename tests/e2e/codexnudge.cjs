// Codex's offer of a cheaper model near the account's limit (HI-2609), on a fake Codex agent (fake-codex/, "nudge"): on 5
// Nov Codex showed "Approaching rate limits: Switch to gpt-6-luna?" with that choice selected, and the Enter of a wake
// Combwork typed answered it, so agents ran gpt-6-luna on connections that said otherwise. Here, with the advanced switch
// that hides it off, the offer shows after a turn: the agent waits for the user with it, a message left meanwhile isn't
// typed into it (no key reaches it), the user keeps the model ("2"), and only then is the message delivered, the model
// unchanged. A model changed another way (switchmodel, as /model does) is marked in the footer and Activity, said in the
// Agent API and told once. With the switch on (its default), each launch hides the offer (-c
// notice.hide_rate_limit_model_nudge=true) and it never shows. Its prompt at a workspace's credit limit (HI-2619,
// "creditnudge": "Notify owner?", whose "y" would email the owner) is a question the same way: nothing is typed into it
// until the user answers it. Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR
// and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const TITLE = 'Approaching rate limits'
const CREDIT_TITLE = "You've reached your workspace credit limit"
const NUDGE_OFF = 'notice.hide_rate_limit_model_nudge=true'

const userData = path.join(lib.WORK, 'codexnudge-profile')
const ws = path.join(lib.WORK, 'codexnudge-ws')
const claudeHome = path.join(lib.WORK, 'codexnudge-claude-home')
const codexHome = path.join(lib.WORK, 'codexnudge-codex-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47863))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The Assistant's fake (which leaves the message) runs in the workspace's folder: trusted.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // The Codex agent reads its inbox and acks what it listed, as a model does; each turn's rollout names its model.
  fs.writeFileSync(path.join(codexHome, 'fake-follow-notices.txt'), '')
  fs.writeFileSync(path.join(codexHome, 'fake-turn-context.txt'), '')

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    // Typed as the user types it (a fake Codex has no input log for lib.typeLine): the line, then Enter.
    const say = async (id, text) => {
      await inv('pty:write', lib.ptyKey(alpha, id), text)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    }
    const nudges = () => lines(path.join(codexHome, 'fake-nudge.jsonl')).filter((n) => n.agent === 'Codex')
    const wakes = () => lines(path.join(codexHome, 'fake-wakes.jsonl')).filter((w) => w.agent === 'Codex')
    const launches = () => lines(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => l.agent)

    // The switch that hides the offer off, so Codex may show it (the user's choice in Settings → Advanced).
    await inv('advanced:set', 'codex.rateLimitNudge.hide', false)
    await page.getByText('alpha', { exact: true }).first().click()
    const codex = await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', model: 'gpt-6-astra', permissionMode: 'approve-for-me' })
    await inv('session:start', alpha, { agentId: codex.id })
    check('the Codex agent starts on its connection\'s model', !!(await until(() => idle(codex.id), HUNG_MS)) && (await live(codex.id))?.launchedWith?.model === 'gpt-6-astra', JSON.stringify((await live(codex.id))?.launchedWith))
    check('…with the switch off, its launch leaves the offer to Codex (no -c of it)', !launches().at(-1)?.args.includes(NUDGE_OFF), JSON.stringify(launches().at(-1)?.args))

    // Messages are left as the Assistant leaves them (cw_message_agent, with its token).
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status === 'ready'), HUNG_MS)
    const tool = (name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' }),
        timeout: 60000
      }).toString()
      const r = JSON.parse(out.split('\n')[0]).result
      return { text: r.content[0].text, isError: !!r.isError }
    }
    const leave = (text) => /\((m\d+)/.exec(tool('cw_message_agent', { project: 'alpha', agent: 'Codex', text }).text)?.[1] ?? null
    const activity = () => JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent: 'Codex' }).text)

    // ---- A turn, then its offer of a cheaper model: the agent waits for the user with it.
    await say(codex.id, 'nudge')
    const asking = await until(async () => {
      const s = await live(codex.id)
      return s?.status === 'waiting' && s
    }, HUNG_MS)
    check("after its turn, Codex's offer shows it waiting for the user", !!asking && String(asking.statusMessage ?? '').includes(TITLE), JSON.stringify(asking && { status: asking.status, message: asking.statusMessage }))
    check('…with the question in its pane', !!(await until(async () => (await page.locator('.pane-status', { hasText: TITLE }).count()) >= 1, HUNG_MS)))
    check('…the offer is on its screen', nudges().some((n) => n.shown === true), JSON.stringify(nudges()))
    await page.screenshot({ path: path.join(lib.WORK, 'codexnudge-asking.png') })

    // A message left meanwhile: never typed into the offer, nor any Enter that would take it; a prompt is refused.
    const m1 = leave('Review HI-12 next.')
    check('a message can be left meanwhile', !!m1, String(m1))
    // Deliver Now, as the user can: nothing is typed into an agent waiting on its CLI's question.
    const typedNow = await inv('session:deliverNow', alpha, codex.id)
    check('…even Deliver Now types nothing', typedNow === false, JSON.stringify(typedNow))
    const prompted = await fetch(`${API}/v1/projects/alpha/agents/Codex/prompt`, { method: 'POST', headers: { Authorization: `Bearer ${JSON.parse(fs.readFileSync(asTokenFile, 'utf8')).token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'something else' }) })
    check('a prompt is refused while it waits for the user', prompted.status === 409, String(prompted.status))
    check('no key of Combwork\'s reached the offer', nudges().filter((n) => n.key !== undefined).length === 0, JSON.stringify(nudges()))
    check('…and the message is not read yet', !wakes().some((w) => w.text.includes('Review HI-12 next.')), JSON.stringify(wakes()))

    // The user keeps the model ("2"): the agent is idle again, and only then is the message typed and read.
    await inv('pty:write', lib.ptyKey(alpha, codex.id), '2')
    check('answered, the agent is idle again', !!(await until(() => idle(codex.id), HUNG_MS)), JSON.stringify(await live(codex.id)))
    check('…the message is delivered and read', !!(await until(() => wakes().some((w) => w.text.includes('Review HI-12 next.')), HUNG_MS)), JSON.stringify(wakes()))
    const keys = nudges().filter((n) => n.key !== undefined).map((n) => n.key)
    check("the offer's only key was the user's \"2\": no wake text, no Enter", JSON.stringify(keys) === '["2"]', JSON.stringify(keys))
    check('…its answer: the model kept', JSON.stringify(nudges().filter((n) => n.answer).map((n) => n.answer)) === '["keep"]', JSON.stringify(nudges()))
    const kept = activity()
    check('the agent still runs its connection\'s model, nothing marked', kept.model === 'gpt-6-astra' && kept.launchedModel === undefined && !(await live(codex.id))?.modelSwitch, JSON.stringify({ model: kept.model, launchedModel: kept.launchedModel }))
    check('…and its footer marks nothing', (await page.locator('.foot-model[data-switched]').count()) === 0)

    // ---- HI-2619: a turn failed at the workspace's credit limit, then Codex's prompt to notify its owner ("1. Yes (y)",
    // "› 2. No (default) (n)"), which no launch argument hides. A wake typed into it would answer it ("y" asks the owner).
    await until(() => idle(codex.id), HUNG_MS)
    const ownerFrom = nudges().length
    const ownerKeys = () => nudges().slice(ownerFrom).filter((n) => n.key !== undefined).map((n) => n.key)
    await say(codex.id, 'creditnudge')
    const owner = await until(async () => {
      const s = await live(codex.id)
      return s?.status === 'waiting' && s
    }, HUNG_MS)
    check("at the workspace's credit limit, Codex's prompt shows it waiting for the user", !!owner && String(owner.statusMessage ?? '').includes(CREDIT_TITLE), JSON.stringify(owner && { status: owner.status, message: owner.statusMessage }))
    check('…the prompt is on its screen', nudges().slice(ownerFrom).some((n) => n.shown === true && n.prompt === 'credits'), JSON.stringify(nudges().slice(ownerFrom)))
    await page.screenshot({ path: path.join(lib.WORK, 'codexnudge-owner.png') })
    // A message with a "y" in it, left meanwhile.
    const m2 = leave('Check your inbox for HI-13.')
    check('a message can be left meanwhile', !!m2, String(m2))
    check('…Deliver Now types nothing into the prompt', (await inv('session:deliverNow', alpha, codex.id)) === false)
    check("no key of Combwork's reached the prompt, so its owner isn't asked", ownerKeys().length === 0 && !nudges().some((n) => n.answer === 'ask-owner'), JSON.stringify(nudges().slice(ownerFrom)))
    check('…and the message is not read yet', !wakes().some((w) => w.text.includes('HI-13')), JSON.stringify(wakes()))
    // The user answers No ("n"): idle again, and only then is the message typed and read.
    await inv('pty:write', lib.ptyKey(alpha, codex.id), 'n')
    check('answered, the agent is idle again', !!(await until(() => idle(codex.id), HUNG_MS)), JSON.stringify(await live(codex.id)))
    check('…the message is delivered and read', !!(await until(() => wakes().some((w) => w.text.includes('HI-13')), HUNG_MS)), JSON.stringify(wakes()))
    check("the prompt's only key was the user's \"n\", and its answer No", JSON.stringify(ownerKeys()) === '["n"]' && JSON.stringify(nudges().slice(ownerFrom).filter((n) => n.answer).map((n) => n.answer)) === '["no"]', JSON.stringify(nudges().slice(ownerFrom)))

    // ---- A model changed another way (as /model does): the footer and Activity mark it, the API says it, told once.
    await until(() => idle(codex.id), HUNG_MS)
    await say(codex.id, 'switchmodel gpt-6-luna')
    const switched = await until(async () => (await live(codex.id))?.modelSwitch, HUNG_MS)
    check('another model reported: the session is marked as on another model than launched', switched?.launched === 'gpt-6-astra' && switched?.running === 'gpt-6-luna', JSON.stringify(switched))
    const marked = page.locator('.foot-model[data-switched="yes"]')
    check('…its footer marks the model', !!(await until(async () => (await marked.count()) === 1, HUNG_MS)))
    const want = (t) => /Launched with GPT-6 Astra.*now runs GPT-6 Luna/is.test(t)
    const tip = await lib.hoverTip(page, marked, want, HUNG_MS)
    check('…whose hover says what it was launched with and what runs', want(tip), tip)
    await page.mouse.move(5, 5)
    // Told in a notice, kept in Notifications (the bell's panel).
    await page.locator('.activitybar button[aria-label="Notifications"]').click()
    const told = page.locator('.notif-panel', { hasText: 'Codex runs another model' })
    check('…the user is told, in a notice kept in Notifications', !!(await until(async () => (await told.count()) === 1, HUNG_MS)), (await page.locator('.notif-panel').allInnerTexts()).join(' | ').slice(0, 600))
    check('…once', (await page.locator('.notif-panel').getByText('Codex runs another model').count()) === 1)
    await page.locator('.notif-panel button[aria-label="Close"]').click()
    const now = activity()
    check('…and cw_agent_activity gives launchedModel beside the model it runs', now.model === 'gpt-6-luna' && now.launchedModel === 'gpt-6-astra', JSON.stringify({ model: now.model, launchedModel: now.launchedModel }))
    await page.screenshot({ path: path.join(lib.WORK, 'codexnudge-switched.png') })
    await page.keyboard.press('Alt+9')
    // The agent is idle (finished), so shown with Hide finished off, as the user shows an idle agent there.
    const hide = page.getByRole('checkbox', { name: 'Hide finished' })
    await until(async () => (await hide.count()) === 1, HUNG_MS)
    if (await hide.isChecked()) await hide.click()
    check('Activity shows "Model changed" for the agent', !!(await until(async () => (await page.locator('[data-model-switch="yes"]', { hasText: /Model changed: GPT-6 Astra → GPT-6 Luna/i }).count()) >= 1, HUNG_MS)), (await page.locator('.activity-part').allInnerTexts()).join(' | ').slice(0, 600))
    await page.screenshot({ path: path.join(lib.WORK, 'codexnudge-activity.png') })

    // ---- The switch on (its default): each launch hides the offer, and it never shows.
    await inv('advanced:set', 'codex.rateLimitNudge.hide', true)
    await inv('session:stop', alpha, codex.id)
    await until(async () => !(await live(codex.id)), HUNG_MS)
    const before = nudges().length
    await inv('session:start', alpha, { agentId: codex.id })
    check('restarted with the switch on', !!(await until(() => idle(codex.id), HUNG_MS)))
    check('…its launch hides the offer for that launch (-c notice.hide_rate_limit_model_nudge=true)', launches().at(-1)?.args.includes(NUDGE_OFF) && launches().at(-1)?.args[launches().at(-1).args.indexOf(NUDGE_OFF) - 1] === '-c', JSON.stringify(launches().at(-1)?.args))
    check('…a new launch on its own model is no longer marked', !(await live(codex.id))?.modelSwitch)
    await say(codex.id, 'nudge')
    check('the offer is never shown, and the agent goes idle after its turn', !!(await until(async () => nudges().slice(before).some((n) => n.shown === false), HUNG_MS)) && !!(await until(() => idle(codex.id), HUNG_MS)), JSON.stringify(nudges().slice(before)))
    check('…nor does it wait for the user', (await live(codex.id))?.status !== 'waiting')
    check("Codex's config.toml in its home is unchanged", fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') === '[windows]\nsandbox = "unelevated"\n')
  } catch (e) {
    check('the suite ran to the end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
