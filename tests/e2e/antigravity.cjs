// The Antigravity CLI as a provider (HI-2544), through Combwork with a stand-in agy (fake-agy/: no sign-in, no model):
// an agent on its PC-wide account launches in a private profile of its own (USERPROFILE; HOME left the user's), with
// auto-update off and an account variable of Combwork's own environment left out; a project that defines an MCP server
// the agent wasn't given (a sentinel, which marks a file when it is started) is refused before agy starts, as is one whose
// config can't be read, and the sentinel never starts (agy 1.5.0 can't be kept from starting it: HR1, fail closed); the
// conversation's id comes from the status line; two new conversations one after the other, then each resumed by its id;
// a conversation that isn't the agent's is never resumed. Its transcript (HI-2546): the conversation view (prompts without
// what agy adds, replies, tool calls with their results and the image one read, light and dark), its usage (requests, the
// cache counted once, the model, agy's title), the status line's model and effort, the Sessions tab, and a conversation
// whose store agy no longer has, refused with why. The fake proves the adapter's side only (HI-2548 runs the real
// CLI). Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'antigravity-profile')
const ws = path.join(lib.WORK, 'antigravity-ws')
const alpha = path.join(ws, 'alpha')
const agyLog = path.join(lib.WORK, 'antigravity-fake-agy.jsonl')
const marker = path.join(lib.WORK, 'antigravity-sentinel-started.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const entries = (kind) => (fs.existsSync(agyLog) ? fs.readFileSync(agyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind) : [])

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [agyLog, marker]) fs.rmSync(f, { force: true })
  lib.gitProject(alpha)
  // The project's own MCP server, which no agent was given: a sentinel that marks a file the moment it is started.
  const sentinel = path.join(lib.WORK, 'antigravity-sentinel.cjs')
  fs.writeFileSync(sentinel, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000)\n`)
  fs.mkdirSync(path.join(alpha, '.agents'), { recursive: true })
  const projectMcp = path.join(alpha, '.agents', 'mcp_config.json')
  fs.writeFileSync(projectMcp, JSON.stringify({ mcpServers: { sentinel: { command: process.execPath, args: [sentinel] } } }))
  lib.enableProviders(userData, ['claude-code', 'antigravity'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.antigravity = { ...cfg.settings.providers.antigravity, executablePath: path.join(__dirname, 'fake-agy', 'agy.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // An account variable in Combwork's own environment, which Antigravity agents mustn't get.
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47901), FAKE_AGY_LOG: agyLog, GEMINI_API_KEY: 'not-for-agy' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const { until } = lib
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Its PC-wide account, its own (never Copilot's).
  const accounts = (await inv('connections:list')).homes ?? []
  const own = accounts.find((a) => a.id === 'antigravity')
  check("Antigravity's PC-wide account is its own", !!own && own.provider === 'antigravity' && own.home === 'cli', JSON.stringify(accounts.map((a) => [a.id, a.provider, a.home])))

  // Its checks (HI-2698): agy's sign-in check ran in Combwork's check profile, under this test copy's data, never the user's.
  const checks = await until(async () => (entries('models').length ? entries('models') : null), HUNG_MS)
  check("agy's checks run in Combwork's check profile, never the user's own", !!checks && checks.every((m) => /antigravity[\\/]check$/i.test(m.env?.USERPROFILE ?? '') && m.env.USERPROFILE.toLowerCase().startsWith(userData.toLowerCase())), JSON.stringify(checks?.map((m) => m.env?.USERPROFILE)))

  // Never on any other agy (HI-2548: a fake Combwork couldn't run fell back to the user's real one): stopped here.
  const fakeAgy = path.join(__dirname, 'fake-agy', 'agy.cmd')
  const selected = await until(async () => (await inv('provider:refresh', 'antigravity'))?.antigravity?.path ?? null, HUNG_MS)
  if (String(selected ?? '').toLowerCase() !== fakeAgy.toLowerCase()) {
    console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no agy'}, not the fake`)
    await app.close()
    process.exit(1)
  }
  const gem = await lib.addAgent(inv, alpha, { name: 'Gem', provider: 'antigravity' })
  check('an agent is added on Antigravity', gem?.provider === 'antigravity', JSON.stringify(gem))

  // --- A project server the agent wasn't given: refused before agy starts (nothing could keep agy from starting it).
  const refusedStart = () => inv('session:start', alpha, { agentId: gem.id }).then(() => null, (err) => String(err?.message ?? err))
  const why = await refusedStart()
  check("a project that defines an MCP server the agent wasn't given is refused, naming the server and its file", /MCP servers this agent wasn't given \(sentinel\)/.test(why ?? '') && (why ?? '').includes(projectMcp), why ?? 'started')
  check('…before agy starts', entries('session').length === 0 && !(await live(gem.id)), JSON.stringify(entries('session')))
  check('…and the sentinel never started', !fs.existsSync(marker))
  // --- A project config agy would read that Combwork can't: refused too (never read as none).
  fs.writeFileSync(projectMcp, '{ not json')
  const why2 = await refusedStart()
  check("a project config that can't be read is refused, naming the file", /couldn't read/.test(why2 ?? '') && (why2 ?? '').includes(projectMcp) && entries('session').length === 0, why2 ?? 'started')
  // Without the project's servers, it launches.
  fs.rmSync(projectMcp)

  // --- What the user sees, light and dark (kept with --keep-files): Provider Setup's tab, Settings → Accounts' PC-wide row,
  // its Settings page and its Advanced tab, all with the fake agy.
  const shots = async (name, target = page) => {
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
    await page.mouse.move(5, 5)
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await target.screenshot({ path: path.join(lib.WORK, `antigravity-${name}-${theme}.png`) })
    }
  }
  await page.evaluate(() => window.combwork.invoke('provider:refresh', 'antigravity'))
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').waitFor({ timeout: HUNG_MS })
  await page.keyboard.type('Provider Setup')
  await page.locator('.palette-item[data-command="help.agentSetup"]').waitFor({ timeout: HUNG_MS })
  await page.keyboard.press('Enter')
  const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
  await setup.locator('.setup-tab', { hasText: 'Antigravity' }).click()
  check('Provider Setup has an Antigravity tab, the fake found and signed in', !!(await until(async () => /1\.5\.0/.test(await setup.innerText().catch(() => '')), HUNG_MS)), await setup.innerText().catch(() => ''))
  await shots('setup', setup)
  await page.keyboard.press('Escape')
  await setup.waitFor({ state: 'detached', timeout: HUNG_MS })
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
  await page.locator('.settings-nav .row[data-section="accounts"]').click()
  check("Settings → Accounts lists Antigravity's PC-wide sign-in", !!(await until(async () => /Antigravity/.test(await page.locator('.settings-content, .settings-page, main').first().innerText().catch(() => '')), HUNG_MS)))
  await shots('accounts')
  await page.locator('.settings-nav .row', { hasText: 'Antigravity' }).first().click()
  await until(async () => (await page.locator('.settings-nav .row.selected', { hasText: 'Antigravity' }).count()) > 0, HUNG_MS)
  await shots('settings')
  await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
  const agTab = page.locator('.advanced-tabs [role="tab"][data-tab="antigravity"]')
  await agTab.waitFor({ timeout: HUNG_MS })
  await agTab.click()
  // Its switches (Combwork's overrides) are on its connections, as every CLI's are; Advanced lists its CLI-facing values.
  check('Settings → Advanced has an Antigravity tab with its values', !!(await until(async () => (await page.locator('.advanced-row[data-advanced^="antigravity."]').evaluateAll((rs) => rs.filter((r) => r.checkVisibility()).length)) === 18, HUNG_MS)))
  await shots('advanced')
  await page.keyboard.press('Escape')
  await page.getByText('alpha', { exact: true }).first().click()

  // --- agy's first-run screens (HI-2547, Darren's (a)): Provider Setup says they are needed; Set up runs agy in a terminal
  // in Combwork's check profile, where the user completes them (here the fake's "accept"); Combwork closes it once done,
  // and each agent's profile then starts past them.
  const setupShown = async () => JSON.stringify(await inv('provider:refresh', 'antigravity'))
  check('Provider Setup says Antigravity needs its one-time setup', /one-time setup/.test(await setupShown()))
  const setupKey = await inv('provider:task', 'antigravity', 'setup')
  check('Set up runs agy in a terminal', setupKey === 'task:antigravity:setup', String(setupKey))
  const shownScreen = await until(async () => entries('onboarding').find((o) => o.shown) ?? null, HUNG_MS)
  check("…in Combwork's check profile, showing its first-run screens", !!shownScreen && /antigravity[\\/]check$/i.test(shownScreen.env?.USERPROFILE ?? ''), JSON.stringify(shownScreen))
  await inv('pty:write', setupKey, 'accept')
  await inv('pty:write', setupKey, '\r')
  check('…the user completes them there (Combwork typed nothing into it)', !!(await until(async () => entries('onboarded').length === 1, HUNG_MS)))
  check('…then Provider Setup no longer asks for it', !!(await until(async () => !/one-time setup/.test(await setupShown()), HUNG_MS)))

  // --- First conversation.
  /**
   * A new conversation: agy 1.5.0 names it only with its first prompt (its status line says conversation_id "" until
   * then; Combwork takes the id from its first hook), so `prompt` is typed once it is ready.
   */
  const startNew = async (agentId, prompt) => {
    const before = entries('session').length
    await inv('session:start', alpha, { agentId })
    await until(async () => entries('session').length > before, HUNG_MS)
    await until(async () => (await live(agentId))?.status === 'ready', HUNG_MS)
    const unnamed = !(await live(agentId))?.sessionId
    await inv('pty:write', lib.ptyKey(alpha, agentId), prompt)
    await inv('pty:write', lib.ptyKey(alpha, agentId), '\r')
    const conv = await until(async () => (await live(agentId))?.sessionId || null, HUNG_MS)
    namedAtPrompt.push(unnamed)
    // Recorded as the agent's conversation (its Sessions entry) before anything stops it, as a real turn gives it time to.
    await until(async () => (await inv('session:list', alpha)).some((s) => s.id === conv), HUNG_MS)
    return { conv, launch: entries('session').at(-1) }
  }
  const stop = async (agentId = gem.id) => {
    await inv('session:stop', alpha, agentId)
    return until(async () => !(await live(agentId)), HUNG_MS)
  }
  /** Whether a conversation's transcript (in the agent's profile) has `text`, within the wait. */
  const inTranscript = async (profile, conv, text) => {
    const transcript = path.join(profile, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl')
    return !!(await until(async () => fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes(text), HUNG_MS))
  }
  /** A turn in a conversation (its transcript, which a resume needs, in the agent's profile). */
  const say = async (agentId, profile, conv, text) => {
    const transcript = path.join(profile, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl')
    await inv('pty:write', lib.ptyKey(alpha, agentId), text)
    await inv('pty:write', lib.ptyKey(alpha, agentId), '\r')
    return !!(await until(async () => fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes(text), HUNG_MS))
  }
  const namedAtPrompt = []
  // agy sends SessionStart only with its first prompt: started with none, its status line saying idle is its prompt showing.
  const first = await startNew(gem.id, 'hello antigravity')
  check('started with no prompt, it is ready once its status line says idle, its conversation not named yet (HI-2548)', namedAtPrompt[0] === true)
  check("…its conversation's id comes with its first prompt", /^[0-9a-f-]{36}$/.test(first.conv ?? '') && first.conv === first.launch?.conversation, JSON.stringify({ conv: first.conv, launch: first.launch?.conversation }))
  const e = first.launch?.env ?? {}
  const agentScreens = entries('onboarding').filter((o) => (o.env?.USERPROFILE ?? '').toLowerCase() === (e.USERPROFILE ?? '').toLowerCase())
  check("…past agy's first-run screens (Set up's, copied into its profile)", agentScreens.length > 0 && agentScreens.every((o) => !o.shown) && fs.existsSync(path.join(e.USERPROFILE, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json')), JSON.stringify(agentScreens))
  const launchFile = JSON.parse(fs.readFileSync(first.launch.args[first.launch.args.indexOf('--settings') + 1], 'utf8'))
  const rules = path.join(e.USERPROFILE, '.gemini', 'GEMINI.md')
  check("…Combwork's guidance in its own GEMINI.md (agy's auto-loaded rules file), never in the project", fs.existsSync(rules) && /cw_inbox/.test(fs.readFileSync(rules, 'utf8')) && !fs.existsSync(path.join(alpha, 'GEMINI.md')), fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8').slice(0, 200) : 'none')
  check('…its folder trusted for this launch (no trust question)', (launchFile.trustedWorkspaces ?? []).some((d) => d.toLowerCase() === alpha.toLowerCase()), JSON.stringify(launchFile.trustedWorkspaces))
  check('it runs in a private profile of its own (USERPROFILE), outside the workspace', !!e.USERPROFILE && !e.USERPROFILE.toLowerCase().startsWith(ws.toLowerCase()) && /antigravity[\\/]profiles[\\/]/i.test(e.USERPROFILE), JSON.stringify(e))
  check("…with HOME left the user's own (not the profile)", !!e.HOME && e.HOME !== e.USERPROFILE, JSON.stringify(e))
  check('…auto-update off', e.AGY_CLI_DISABLE_AUTO_UPDATE === 'true', JSON.stringify(e))
  check("…and Combwork's environment's GEMINI_API_KEY left out", e.GEMINI_API_KEY === undefined, JSON.stringify(e))
  const args = first.launch?.args ?? []
  check('it is given its settings for this launch only (--settings), the status line among them', args.includes('--settings') && /"statusLine"/.test(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')), JSON.stringify(args))
  const profileMcp = JSON.parse(fs.readFileSync(path.join(e.USERPROFILE, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers
  check("its profile's MCP servers are Combwork's own", 'combwork' in profileMcp && !('sentinel' in profileMcp), JSON.stringify(Object.keys(profileMcp)))
  // A turn: written to its conversation.
  check('its turns are kept in its own conversation, in its profile', await inTranscript(e.USERPROFILE, first.conv, 'hello antigravity'))
  // --- Its transcript (HI-2546): the conversation view, its usage and the status line's details.
  check('…and a turn with a tool call', await say(gem.id, e.USERPROFILE, first.conv, 'tool fake result'))
  check('…and one reading an image', await say(gem.id, e.USERPROFILE, first.conv, 'image'))
  const shown = await until(async () => {
    const items = (await inv('transcript:read', alpha, first.conv).catch(() => null))?.items ?? []
    return items.some((i) => i.kind === 'assistant' && i.text === 'Done: image') ? items : null
  }, HUNG_MS)
  const said = (shown ?? []).map((i) => (i.kind === 'tool' ? `tool ${i.tool.name}: ${i.tool.result} (${i.tool.images.length} image)` : `${i.kind} ${i.text}`))
  check("the conversation view shows the prompts without what agy adds, the replies and the tool calls with their results and image", JSON.stringify(said) === JSON.stringify(['user hello antigravity', 'assistant Done: hello antigravity', 'user tool fake result', 'tool fake · echo: fake result (0 image)', 'assistant Done: tool fake result', 'user image', 'tool read_file: Showing binary file of type image/png (1 image)', 'assistant Done: image']), JSON.stringify(said))
  const picture = await inv('transcript:image', alpha, first.conv, 0).catch((err) => String(err?.message ?? err))
  check("…the image from agy's own copy in the conversation's media folder", picture === `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'antigravity', 'image-1.5.0-media.png')).toString('base64')}`, String(picture).slice(0, 80))
  const used = await until(async () => {
    const u = await inv('session:usage', alpha, first.conv).catch(() => null)
    return u?.requests === 5 && u.title ? u : null
  }, HUNG_MS)
  // The fake's requests: input 3000 + 100 × its step without the cache read (4000 from the second on), output 20.
  check("its usage counts each request, the cache once, its prompts, model and agy's title", !!used && used.inputTokens === 3100 + 3300 + 3500 + 3700 + 3900 && used.cacheReadTokens === 16000 && used.contextTokens === 3900 + 4000 + 20 && used.outputTokens === 100 && used.userMessages === 3 && used.model === 'Gemini 3.8 Flash (Low)' && used.title === 'Fake: hello antigravity' && used.costUsd === null, JSON.stringify(used && { ...used, days: undefined, timeline: undefined }))
  const details = await live(gem.id)
  check("the status line gives the model, its effort and the context window", details?.modelName === 'Gemini 3.8 Flash (Low)' && details?.effort === 'low', JSON.stringify({ modelName: details?.modelName, effort: details?.effort }))

  // --- Hooks and the status line (HI-2545, s56): Combwork's hooks in the profile; a turn per invocation zero, named by
  // the steps before it (agy sends no prompt hook); a continuation none; the prompt only the status line tells of.
  const profileHooks = JSON.parse(fs.readFileSync(path.join(e.USERPROFILE, '.gemini', 'config', 'hooks.json'), 'utf8')).combwork ?? {}
  check("Combwork's hooks are in the agent's profile, each naming its event for Combwork, the tool hooks included", ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'].every((k) => JSON.stringify(profileHooks[k] ?? '').includes(`event=${k}`)), JSON.stringify(Object.keys(profileHooks)))
  check('…the status line under agy\'s own (stack_with_default)', JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).statusLine?.stack_with_default === true)
  const hooksOf = (event) => entries('hook').filter((h) => h.event === event && h.payload.conversationId === first.conv)
  /** The turn the conversation's latest prompt began: its step + 1 (the invocation zero's initialNumSteps). */
  const latestTurn = (conv) => {
    const steps = fs.readFileSync(path.join(e.USERPROFILE, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    return `${conv}:i${steps.filter((x) => x.type === 'USER_INPUT').at(-1).step_index + 1}`
  }
  const turnIs = async (id, status = 'finished') => !!(await until(async () => { const s = await live(gem.id); return s?.turn?.id === id && s.turn.state === 'over' && s.status === status }, HUNG_MS))
  check('a prompt is a turn, named by the steps before its first model call (agy sends no prompt hook)', await turnIs(latestTurn(first.conv)), JSON.stringify([(await live(gem.id))?.turn, latestTurn(first.conv)]))
  // The same words again: a new step, so a new turn.
  const turnBefore = latestTurn(first.conv)
  await say(gem.id, e.USERPROFILE, first.conv, 'hello antigravity')
  // Its words are in the transcript already (the first time): wait for its new step instead.
  check('the same prompt typed again is a turn of its own', !!(await until(async () => latestTurn(first.conv) !== turnBefore, HUNG_MS)) && (await turnIs(latestTurn(first.conv))), JSON.stringify([(await live(gem.id))?.turn, latestTurn(first.conv)]))
  // A hook's continuation (another hook's `continue`): agy calls the model again, counting on (invocationNum 1).
  const calls = hooksOf('PreInvocation').length
  check('a continuation is no new turn', (await say(gem.id, e.USERPROFILE, first.conv, 'carry on please')) && !!(await until(async () => hooksOf('PreInvocation').length - calls === 2 && hooksOf('PreInvocation').at(-1)?.payload.invocationNum === 1 && hooksOf('Stop').at(-1)?.payload.executionNum === 1, HUNG_MS)) && (await turnIs(latestTurn(first.conv))), JSON.stringify({ turn: (await live(gem.id))?.turn, calls: hooksOf('PreInvocation').length - calls }))
  // An edit nobody holds: Combwork's PreToolUse answers allow (agy 1.5.0 would deny on no answer), and it runs.
  check('an edit runs (Combwork allows what it doesn\'t refuse)', (await say(gem.id, e.USERPROFILE, first.conv, 'edit notes.txt')) && !!(await until(async () => entries('hook').some((h) => h.event === 'PreToolUse' && h.reply?.decision === 'allow') && entries('hook').some((h) => h.event === 'PostToolUse'), HUNG_MS)), JSON.stringify(entries('hook').filter((h) => h.event === 'PreToolUse').map((h) => h.reply)))
  await turnIs(latestTurn(first.conv))
  // A permission prompt only the status line tells of: "waiting for you" until the person answers it in the CLI.
  await inv('pty:write', lib.ptyKey(alpha, gem.id), 'this needs approval')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  check('a permission prompt shows the agent waiting for you', !!(await until(async () => (await live(gem.id))?.status === 'waiting', HUNG_MS)), (await live(gem.id))?.status)
  await inv('pty:write', lib.ptyKey(alpha, gem.id), 'y')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  check('…and, once answered, the turn ends as one turn', await turnIs(latestTurn(first.conv)), JSON.stringify(await live(gem.id)))
  // Cancelled instead: agy sends no hook at all; its status line idle, the turn is interrupted after the grace.
  // The answered turn's Stop is logged by the fake once Combwork has replied to it: counted from after it.
  await until(async () => entries('hook').at(-1)?.event === 'Stop', HUNG_MS)
  const hooksBefore = entries('hook').length
  await inv('pty:write', lib.ptyKey(alpha, gem.id), 'this needs approval again')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  await until(async () => (await live(gem.id))?.status === 'waiting', HUNG_MS)
  await inv('pty:write', lib.ptyKey(alpha, gem.id), 'n')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  check('a cancelled permission prompt (no hook): the turn is interrupted, the agent ready again', await turnIs(latestTurn(first.conv), 'ready'), JSON.stringify(await live(gem.id)))
  check('…with no Stop sent for it', !entries('hook').slice(hooksBefore).some((h) => h.event === 'Stop'))
  // The user's /new: a new conversation, followed at its first prompt.
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '/new')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), 'hello new conversation')
  await inv('pty:write', lib.ptyKey(alpha, gem.id), '\r')
  const moved = await until(async () => { const id = (await live(gem.id))?.sessionId; return id && id !== first.conv ? id : null }, HUNG_MS)
  check("the user's /new moves the agent to the new conversation at its first prompt", !!moved && (await turnIs(latestTurn(moved))), JSON.stringify({ moved, turn: (await live(gem.id))?.turn }))
  check('it stops', !!(await stop()))
  const listed = (await inv('session:list', alpha)).find((s) => s.id === first.conv)
  check("the Sessions list has it, with agy's title", listed?.title === 'Fake: hello antigravity', JSON.stringify(listed && { id: listed.id, title: listed.title }))
  // What the user sees, light and dark (kept with --keep-files): the Sessions tab, its conversation, the image a tool read.
  await page.locator('.tabs .tab', { hasText: 'Sessions' }).first().click()
  const row = page.locator('.session-row', { hasText: 'Fake: hello antigravity' })
  check('the Sessions tab lists it by its title', !!(await until(async () => (await row.count()) === 1, HUNG_MS)))
  await row.click()
  const reading = page.locator('.transcript .tx-tool', { hasText: 'read_file' }).first()
  await reading.waitFor({ timeout: HUNG_MS })
  await reading.locator('.tx-fold-head').click()
  const thumb = reading.locator('.tx-images .thumb img')
  check('…its conversation shows the tool call and the image it read', !!(await until(async () => ((await thumb.getAttribute('src').catch(() => null)) ?? '').startsWith('data:image/png'), HUNG_MS)))
  await shots('sessions-transcript', page.locator('.transcript').first())
  await shots('sessions-list', page.locator('.sessions-tree').first())
  await page.getByText('alpha', { exact: true }).first().click()

  // --- A second new conversation, then each resumed by its own id.
  const second = await startNew(gem.id, 'second conversation')
  check('a second new launch is a new conversation', !!second.conv && second.conv !== first.conv && second.launch?.resumed === false, JSON.stringify({ first: first.conv, second: second.conv }))
  check('…in the same private profile', second.launch?.env?.USERPROFILE === e.USERPROFILE)
  check('…with turns of its own', await inTranscript(e.USERPROFILE, second.conv, 'second conversation'))
  await stop()
  for (const [name, c] of [['the first', first.conv], ['the second', second.conv]]) {
    const before = entries('session').length
    await inv('session:start', alpha, { agentId: gem.id, resumeId: c })
    await until(async () => entries('session').length > before, HUNG_MS)
    const l = entries('session').at(-1)
    check(`${name} conversation resumes by its id (--conversation)`, l?.resumed === true && l.conversation === c && l.args.includes('--conversation'), JSON.stringify(l))
    check(`…and the session is that conversation`, (await until(async () => ((await live(gem.id))?.sessionId === c ? c : null), HUNG_MS)) === c)
    await stop()
  }
  // --- A conversation whose store agy no longer has (its transcript kept): refused before agy starts, saying so.
  fs.rmSync(path.join(e.USERPROFILE, '.gemini', 'antigravity-cli', 'conversations', `${second.conv}.db`))
  const beforeGone = entries('session').length
  const gone = await inv('session:start', alpha, { agentId: gem.id, resumeId: second.conv }).then(() => null, (err) => String(err?.message ?? err))
  check("a conversation agy no longer has isn't resumed, and says why", entries('session').length === beforeGone && /no longer has that conversation/.test(gone ?? ''), gone ?? 'started')
  // --- Another agent's conversation (in its own profile): never resumed by this one, refused before agy starts.
  const other = await lib.addAgent(inv, alpha, { name: 'Ada', provider: 'antigravity' })
  const theirs = await startNew(other.id, 'hers')
  check('another agent has a private profile of its own', !!theirs.launch?.env?.USERPROFILE && theirs.launch.env.USERPROFILE !== e.USERPROFILE, JSON.stringify(theirs.launch?.env))
  check('…and its own conversation', await inTranscript(theirs.launch.env.USERPROFILE, theirs.conv, 'hers'))
  await stop(other.id)
  const before = entries('session').length
  const refused = await inv('session:start', alpha, { agentId: gem.id, resumeId: theirs.conv }).then(() => null, (err) => String(err?.message ?? err))
  check("another agent's conversation is never resumed by this one", entries('session').length === before && !(await live(gem.id)) && /isn't in this agent's own conversations/.test(refused ?? ''), refused ?? 'started')

  // --- File locks (HI-2545): Ada edits notes.txt and waits on a permission prompt, her turn running, her claim held;
  // Gem's edit of the same file is refused, saying why (1.5.0: only a deny stops an edit), and goes ahead once Ada is done.
  const ada = await startNew(other.id, 'edit notes.txt then needs approval')
  const transcriptOf = (profile, conv) => fs.readFileSync(path.join(profile, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs', 'transcript_full.jsonl'), 'utf8')
  check("Ada's edit runs and her turn waits on its prompt", !!(await until(async () => (await live(other.id))?.status === 'waiting', HUNG_MS)), (await live(other.id))?.status)
  const gem2 = await startNew(gem.id, 'edit notes.txt')
  check("…Gem's edit of the file she holds is refused, saying it is held", (await inTranscript(e.USERPROFILE, gem2.conv, 'edit notes.txt')) && !!(await until(async () => /tool call denied by pre-tool hook: .*notes\.txt/.test(transcriptOf(e.USERPROFILE, gem2.conv)), HUNG_MS)), transcriptOf(e.USERPROFILE, gem2.conv).slice(-400))
  await inv('pty:write', lib.ptyKey(alpha, other.id), 'y')
  await inv('pty:write', lib.ptyKey(alpha, other.id), '\r')
  await until(async () => (await live(other.id))?.status === 'finished', HUNG_MS)
  check('…and, once her turn is over, it runs', (await say(gem.id, e.USERPROFILE, gem2.conv, 'edit notes.txt now')) && !!(await until(async () => transcriptOf(e.USERPROFILE, gem2.conv).includes('Made 1 replacement'), HUNG_MS)))
  await stop(other.id)
  await stop()
  void ada
  check('the sentinel was never started, all along', !fs.existsSync(marker))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
