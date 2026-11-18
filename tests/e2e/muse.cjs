// Meta's Muse Code as a provider (HI-3202), through Combwork with a stand-in muse (fake-muse/: no sign-in, no model, no
// network; its hook runner breaks a quoted command as 1.4.20's does). Its checks run on Combwork's own roots; an account's
// Set Up is `muse login` on the account's roots, after which the account shows signed in. A project whose .mcp.json
// defines a server the agent wasn't given (a sentinel that marks a file when started), whose .mcp.json can't be read, or
// whose .muse\hooks.json has hooks, is refused before Muse starts, and the sentinel never starts. The launch: the account's
// roots, a key and a header of Combwork's own environment left out, the workspace trusted for that run only, every hook
// event given, Combwork's server (required) and other CLIs' personal skills and rules off; Combwork's guidance arrives as
// the session's start context, and with the limit lowered as a pointer to the whole file. Status from the hooks (the
// session id from SessionStart, a turn, a question); a Combwork tool called through its server; another agent's held edit
// refuses this one's (Combwork's lock) while a free file is written; its transcript and usage (tokens only, no price);
// stopped and resumed by its id with a first prompt, typed once it is up (1.4.20's resume takes none on its command
// line). The sandbox not set up: Provider Setup says so, and a launch waits at Muse's screen, never answered. What the user
// sees, light and dark (kept with --keep-files). The fake proves the adapter's side only (1.4.20 itself is checked in a Windows Sandbox, HI-3202).
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

const userData = path.join(lib.WORK, 'muse-profile')
const ws = path.join(lib.WORK, 'muse-ws')
const alpha = path.join(ws, 'alpha')
const fakeLog = path.join(lib.WORK, 'muse-fake.jsonl')
const marker = path.join(lib.WORK, 'muse-sentinel-started.txt')
const sandboxFile = path.join(lib.WORK, 'muse-sandbox-needs-setup.txt')
const accountsRoot = path.join(userData, 'accounts')
const fake = path.join(__dirname, 'fake-muse', 'muse.cmd')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const entries = (kind) => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !kind || e.kind === kind) : [])
const under = (p, dir) => !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [fakeLog, marker, sandboxFile]) fs.rmSync(f, { force: true })
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha, { 'notes.txt': 'notes\n', 'free.txt': 'free\n' })
  fs.writeFileSync(path.join(alpha, 'AGENTS.md'), '# The project rules\n')
  lib.enableProviders(userData, ['claude-code', 'muse'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.muse = { ...cfg.settings.providers.muse, executablePath: fake }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // A key and a header in Combwork's own environment, as ones set on the PC would be: a Muse agent must never get them.
  const env = { FAKE_MUSE_LOG: fakeLog, FAKE_MUSE_SANDBOX_FILE: sandboxFile, META_API_KEY: 'not-for-muse', MUSE_CUSTOM_HEADERS: 'Authorization: Bearer not-for-muse', CW_TEST_CLI_HOME_CONNECTION: '0' }
  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e))
    await lib.waitForProvider(inv, 'muse')
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    // At its prompt: ready, or a turn finished.
    const idle = async (agentId) => ['ready', 'finished'].includes((await live(agentId))?.status)
    const say = async (agentId, text) => {
      await inv('pty:write', lib.ptyKey(alpha, agentId), text)
      await inv('pty:write', lib.ptyKey(alpha, agentId), '\r')
    }

    // Never on any other muse: stopped here unless Combwork selected the fake.
    const selected = await lib.until(async () => (await inv('provider:refresh', 'muse'))?.muse?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no muse'}, not the fake`)
      process.exitCode = 1
      return
    }
    const checks = await lib.until(async () => (entries('sandboxCheck').length ? entries('sandboxCheck') : null), HUNG_MS)
    check("its sandbox check ran on Combwork's own roots, never the user's, with the PC's key and header left out", !!checks && checks.every((c) => under(c.env.XDG_DATA_HOME, userData) && under(c.env.XDG_CONFIG_HOME, userData) && !c.env.META_API_KEY && !c.env.MUSE_CUSTOM_HEADERS), JSON.stringify(checks))

    // --- An agent on a Muse account, signed in with Set Up (`muse login` on the account's roots).
    const agent = await lib.addAgent(inv, alpha, { name: 'Mu', provider: 'muse' })
    check('an agent is added on Muse Code', agent?.provider === 'muse', JSON.stringify(agent))
    const account = await inv('connections:add', 'muse', 'Muse · Test')
    await inv('connections:setOn', account.id, true)
    const home = path.join(accountsRoot, account.id)
    const setUpReply = await inv('connections:setUp', account.id).catch((e) => ({ error: String(e?.message ?? e) }))
    const login = await lib.until(async () => entries('login').find((e) => e.env.XDG_DATA_HOME === home) ?? null, HUNG_MS)
    check("Set Up runs `muse login` on the account's own roots, the PC's key and header left out", !!login && login.env.XDG_CONFIG_HOME === path.join(home, 'xdg-config') && !login.env.META_API_KEY && !login.env.MUSE_CUSTOM_HEADERS, JSON.stringify(setUpReply) + ' ' + JSON.stringify(entries('login')))
    if (setUpReply?.key) await inv('pty:kill', setUpReply.key).catch(() => undefined)
    const signedIn = await lib.until(async () => {
      const row = (await inv('connections:list')).connections.find((c) => c.id === account.id)
      return row?.observed?.loggedIn === true ? row : null
    }, HUNG_MS)
    check('…and the account then shows signed in (its auth.json there, never read)', !!signedIn, JSON.stringify((await inv('connections:list')).connections.find((c) => c.id === account.id)))
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === account.id) ?? (await inv('connection:add', account.id, { name: 'Test · Muse' }))
    await inv('agents:update', alpha, agent.id, { connection: conn.id })

    // --- The project's own config a trusted launch would load: refused before Muse starts (Muse can't leave it out).
    const sentinel = path.join(lib.WORK, 'muse-sentinel.cjs')
    fs.writeFileSync(sentinel, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000)\n`)
    const projectMcp = path.join(alpha, '.mcp.json')
    fs.writeFileSync(projectMcp, JSON.stringify({ mcpServers: { sentinel: { command: process.execPath, args: [sentinel] } } }))
    const launchesBefore = entries('launch').length
    const why = await failure(inv('session:start', alpha, { agentId: agent.id }))
    check("a project whose .mcp.json defines a server the agent wasn't given is refused, naming it and its file", /MCP servers this agent wasn't given \(sentinel\)/.test(why ?? '') && (why ?? '').includes(projectMcp), why ?? 'started')
    check('…before Muse starts, and the sentinel never started', entries('launch').length === launchesBefore && !fs.existsSync(marker) && !(await live(agent.id)))
    fs.writeFileSync(projectMcp, '{ not json')
    const why2 = await failure(inv('session:start', alpha, { agentId: agent.id }))
    check("a .mcp.json that can't be read is refused, naming it (never read as none)", /couldn't read/.test(why2 ?? '') && (why2 ?? '').includes(projectMcp) && entries('launch').length === launchesBefore, why2 ?? 'started')
    fs.rmSync(projectMcp)
    const hooksFile = path.join(alpha, '.muse', 'hooks.json')
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo project' }] }] } }))
    const why3 = await failure(inv('session:start', alpha, { agentId: agent.id }))
    check("a .muse\\hooks.json with hooks of the project's own is refused, naming it", /hooks of the project's own/.test(why3 ?? '') && (why3 ?? '').includes(hooksFile) && entries('launch').length === launchesBefore, why3 ?? 'started')
    fs.rmSync(path.join(alpha, '.muse'), { recursive: true, force: true })

    // --- The launch.
    const started = await failure(inv('session:start', alpha, { agentId: agent.id }))
    check('it starts on the Muse account', started === null, started ?? '')
    const launch = await lib.until(async () => entries('launch').find((e) => !e.resumed && e.env.XDG_DATA_HOME === home) ?? null, HUNG_MS)
    check("on the account's own roots, the PC's key and header left out", !!launch && launch.env.XDG_CONFIG_HOME === path.join(home, 'xdg-config') && !launch.env.META_API_KEY && !launch.env.MUSE_CUSTOM_HEADERS, JSON.stringify(launch?.env))
    check('…the workspace trusted for this run, every hook event Combwork reads given', !!launch && launch.trust === true && ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'].every((e) => launch.hookEvents.includes(e)), JSON.stringify(launch?.hookEvents))
    check("…Combwork's server given, required, and other CLIs' personal skills and rules off", !!launch && launch.servers.includes('combwork') && launch.serverDefs.combwork.mode === 'required' && launch.foreignSkills === false && launch.foreignRules === false, JSON.stringify({ servers: launch?.serverDefs, skills: launch?.foreignSkills, rules: launch?.foreignRules }))
    const token = (() => {
      const runs = path.join(userData, 'launches')
      const dirs = fs.existsSync(runs) ? fs.readdirSync(runs).map((d) => path.join(runs, d, 'hook-auth.txt')).filter((f) => fs.existsSync(f)) : []
      return dirs.map((f) => /Bearer (\S+)/.exec(fs.readFileSync(f, 'utf8'))?.[1]).filter(Boolean)
    })()
    check('…no hook token on its command line (curl reads it from the launch’s file)', token.length > 0 && token.every((t) => !JSON.stringify(launch?.args ?? []).includes(t)), `${token.length} token(s)`)
    const context = await lib.until(async () => entries('context').find((c) => c.kept > 0) ?? null, HUNG_MS)
    check("Combwork's guidance arrives as the session's start context, whole", !!context && context.exit === 0 && /cw_inbox/.test(context.text) && context.bytes <= 16384, JSON.stringify(context && { exit: context.exit, bytes: context.bytes, head: context.head }))
    const mcp = await lib.until(async () => entries('mcp').find((m) => m.server === 'combwork') ?? null, HUNG_MS)
    check("Combwork's server starts and lists its tools", !!mcp && mcp.tools.includes('cw_inbox'), JSON.stringify(mcp))
    const session = await lib.until(async () => {
      const l = await live(agent.id)
      return l?.sessionId && l.status === 'ready' ? l : null
    }, HUNG_MS)
    check('its session id comes from SessionStart, and it is ready', !!session && session.sessionId === launch?.sessionId, JSON.stringify(session && { id: session.sessionId, status: session.status }))

    // --- A turn, a Combwork tool, a question.
    await say(agent.id, 'hello muse ü')
    check('a turn runs and ends (UserPromptSubmit, then Stop)', !!(await lib.until(async () => entries('hook').some((h) => h.event === 'Stop') && (await idle(agent.id)), HUNG_MS)))
    await say(agent.id, 'call cw_inbox {}')
    const toolCall = await lib.until(async () => entries('toolCall').find((t) => t.tool === 'cw_inbox') ?? null, HUNG_MS)
    check("a Combwork tool called through its server answers", !!toolCall && toolCall.ok === true, JSON.stringify(toolCall))
    await say(agent.id, 'ask')
    check('a question (Notification) shows the agent waiting', !!(await lib.until(async () => (await live(agent.id))?.status === 'waiting', HUNG_MS)), (await live(agent.id))?.status)
    await say(agent.id, 'y')
    await lib.until(async () => idle(agent.id), HUNG_MS)

    // --- File locks: another agent's held edit refuses this one's; a free file is written.
    const other = await lib.addAgent(inv, alpha, { name: 'Mo', provider: 'muse' })
    await inv('agents:update', alpha, other.id, { connection: conn.id })
    await inv('session:start', alpha, { agentId: other.id })
    await lib.until(async () => idle(other.id), HUNG_MS)
    await say(other.id, 'edit notes.txt then ask')
    check("Mo's edit of notes.txt runs and its turn waits on a question, its claim held", !!(await lib.until(async () => (await live(other.id))?.status === 'waiting', HUNG_MS)), (await live(other.id))?.status)
    await say(agent.id, 'edit notes.txt')
    const blocked = await lib.until(async () => entries('blocked').find((b) => /notes\.txt/.test(b.file)) ?? null, HUNG_MS)
    check("…Mu's edit of it is refused by Combwork's lock ({\"decision\":\"block\"}), saying why", !!blocked && /notes\.txt/.test(String(blocked.reason)), JSON.stringify(blocked))
    await say(agent.id, 'edit free.txt')
    const wrote = await lib.until(async () => entries('write').find((w) => /free\.txt/.test(w.file)) ?? null, HUNG_MS)
    check('…while its edit of a file nobody holds is written', !!wrote && /edited by fake-muse/.test(fs.readFileSync(path.join(alpha, 'free.txt'), 'utf8')))
    await say(other.id, 'n')
    await inv('session:stop', alpha, other.id)

    // --- Its transcript and usage.
    const items = await lib.until(async () => {
      const it = (await inv('transcript:read', alpha, session.sessionId).catch(() => null))?.items ?? []
      return it.some((i) => i.kind === 'assistant' && /hello muse ü/.test(i.text ?? '')) ? it : null
    }, HUNG_MS)
    check('its conversation shows the turn (non-ASCII kept)', !!items && items.some((i) => i.kind === 'user' && i.text === 'hello muse ü'), JSON.stringify(items?.slice(0, 4)))
    const usage = await lib.until(async () => {
      const u = await inv('session:usage', alpha, session.sessionId).catch(() => null)
      return u?.requests >= 2 ? u : null
    }, HUNG_MS)
    check('its usage counts its requests and tokens, and no price (Muse records none)', !!usage && usage.inputTokens >= 20 && usage.outputTokens >= 10 && usage.costUsd === null, JSON.stringify(usage && { requests: usage.requests, input: usage.inputTokens, output: usage.outputTokens, cost: usage.costUsd }))

    // --- Stopped, then resumed by its id with a first prompt: typed once it is up, never on its command line.
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live(agent.id)), HUNG_MS)
    const resumedStart = await failure(inv('session:start', alpha, { agentId: agent.id, resumeId: session.sessionId, prompt: 'after resume' }))
    check('it resumes its session by id with a first prompt', resumedStart === null, resumedStart ?? '')
    const resumed = await lib.until(async () => entries('launch').find((e) => e.resumed && e.sessionId === session.sessionId) ?? null, HUNG_MS)
    check('…`muse resume <id>` with no prompt on its command line', !!resumed && resumed.args[0] === 'resume' && resumed.args[1] === session.sessionId && resumed.prompt === null, JSON.stringify(resumed?.args?.slice(0, 3)))
    const typed = await lib.until(async () => ((await inv('transcript:read', alpha, session.sessionId).catch(() => null))?.items ?? []).some((i) => i.kind === 'assistant' && i.text === 'echo: after resume'), HUNG_MS)
    check('…the prompt typed once it was up, and answered', !!typed)
    check("…its guidance given again with the resume's first prompt (its SessionStart waits for it, as 1.4.20's does)", entries('context').filter((c) => c.kept > 0).length >= 3)
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live(agent.id)), HUNG_MS)

    // --- Over Muse's start limit: a pointer to the launch's whole guidance file instead, which is there.
    await inv('advanced:set', 'muse.guidance.maxBytes', 1024)
    const before = entries('context').length
    await inv('session:start', alpha, { agentId: agent.id })
    const pointer = await lib.until(async () => entries('context').slice(before).find((c) => c.kept > 0) ?? null, HUNG_MS)
    const file = /:\s*(\S+muse-guidance-full\.md)/.exec(pointer?.text ?? '')?.[1]
    check('with the limit lowered, the start context is a short pointer to the whole guidance file', !!pointer && pointer.bytes <= 1024 && !!file, JSON.stringify(pointer && { bytes: pointer.bytes, text: pointer.text }))
    check('…which holds it whole', !!file && fs.existsSync(file) && /cw_inbox/.test(fs.readFileSync(file, 'utf8')), file ?? '')
    await inv('session:stop', alpha, agent.id)
    await lib.until(async () => !(await live(agent.id)), HUNG_MS)
    await inv('advanced:set', 'muse.guidance.maxBytes', 16384)

    // --- What the user sees, light and dark: Provider Setup's tab, its Settings page and its Advanced tab.
    const shots = async (name, target = page) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await target.screenshot({ path: path.join(lib.WORK, `muse-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    }
    // The sandbox not set up: Provider Setup says so, with Set up, and a new launch waits at Muse's screen.
    fs.writeFileSync(sandboxFile, 'needs setting up\n')
    const readiness = await lib.until(async () => {
      const r = (await inv('provider:refresh', 'muse'))?.muse
      return r?.readiness?.some((i) => i.id === 'sandbox') ? r : null
    }, HUNG_MS)
    check("Provider Setup says Muse's sandbox needs setting up, with Set up", !!readiness && readiness.readiness.find((i) => i.id === 'sandbox').action?.task === 'setup', JSON.stringify((await inv('provider:refresh', 'muse'))?.muse?.readiness))
    await page.keyboard.press('Control+Shift+P')
    await page.locator('.palette input').waitFor({ timeout: HUNG_MS })
    await page.keyboard.type('Provider Setup')
    await page.locator('.palette-item[data-command="help.agentSetup"]').waitFor({ timeout: HUNG_MS })
    await page.keyboard.press('Enter')
    const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
    await setup.locator('.setup-tab', { hasText: 'Muse' }).click()
    const setupText = await lib.until(async () => {
      const t = await setup.innerText().catch(() => '')
      return /1\.4\.20/.test(t) && /sandbox/i.test(t) ? t : null
    }, HUNG_MS)
    check('Provider Setup has a Muse Code tab: the fake found (1.4.20), its sandbox to set up', !!setupText, (await setup.innerText().catch(() => '')).slice(0, 400))
    await shots('setup', setup)
    await page.keyboard.press('Escape')
    await setup.waitFor({ state: 'detached', timeout: HUNG_MS })
    const sandboxRuns = entries('sandboxScreen').length
    const startsBefore = entries('hook').filter((h) => h.event === 'SessionStart').length
    await inv('session:start', alpha, { agentId: agent.id })
    check("a launch then waits at Muse's sandbox screen, the agent waiting for the user", !!(await lib.until(async () => entries('sandboxScreen').length > sandboxRuns && (await live(agent.id))?.status === 'waiting', HUNG_MS)), (await live(agent.id))?.status)
    check('…and Combwork never answers it: no session starts past it', entries('hook').filter((h) => h.event === 'SessionStart').length === startsBefore && !(await inv('pty:buffer', lib.ptyKey(alpha, agent.id)).catch(() => '')).includes('echo:'))
    await inv('session:stop', alpha, agent.id)
    fs.rmSync(sandboxFile, { force: true })

    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    await page.locator('.settings-nav .row', { hasText: 'Muse Code' }).first().click()
    await lib.until(async () => (await page.locator('.settings-nav .row.selected', { hasText: 'Muse Code' }).count()) > 0, HUNG_MS)
    await shots('settings')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const tab = page.locator('.advanced-tabs [role="tab"][data-tab="muse"]')
    await tab.waitFor({ timeout: HUNG_MS })
    await tab.click()
    const rows = await lib.until(async () => {
      const n = await page.locator('.advanced-row[data-advanced^="muse."]').evaluateAll((rs) => rs.filter((r) => r.checkVisibility()).length)
      return n > 0 ? n : null
    }, HUNG_MS)
    check('Settings → Advanced has a Muse Code tab with its values', (rows ?? 0) >= 6, String(rows))
    await shots('advanced')
    // Its protocol's names (HI-3202): four mappings, each shown as its role=name entries; one missing a role is refused.
    const names = page.locator('.advanced-row[data-advanced^="muse.names."]')
    check('…with its four name mappings, each as role=name entries', (await names.count()) === 4 && /start=SessionStart/.test(await page.locator('.advanced-row[data-advanced="muse.names.hookEvents"]').innerText().catch(() => '') + (await page.locator('.advanced-row[data-advanced="muse.names.hookEvents"] input, .advanced-row[data-advanced="muse.names.hookEvents"] textarea').first().inputValue().catch(() => ''))), String(await names.count()))
    const refused = await inv('advanced:set', 'muse.names.hookEvents', ['start=SessionStart']).then(() => null, (e) => String(e?.message ?? e))
    check('…and a mapping missing a role is refused, saying what it takes', !!refused && /takes each of start, prompt/.test(refused), refused ?? 'taken')
    await names.first().scrollIntoViewIfNeeded()
    await shots('advanced-names')
    await page.keyboard.press('Escape')
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed || process.exitCode ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
