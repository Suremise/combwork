// Workspace notes (#1433, #873): the shared note "Workspace notes.md" reaches every agent at launch, on every CLI and in
// any folder: a Claude Code, a Codex and a Copilot agent in the project folder and one of each in a folder of its own (an
// agent's worktree, as a slot is) each get its line in their launch's instructions (Claude Code's
// --append-system-prompt-file, Codex's developer_instructions, Copilot's instruction file, seen in the system prompt it
// sends the stand-in model). A project's own section reaches only its agents. An edit reaches the next launch, not the
// running one; Settings → Advanced's switch turns it off. A project agent's write to the note is refused, a script's
// (the workspace's token) taken. The fake Claude Code and fake Codex, and the real Copilot CLI offline against the
// stand-in model (fake-copilot-api.cjs) where Copilot is installed (else its part is skipped, said). Dev build,
// throwaway profile, workspace, CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME.
// Dev build only (#1580): it starts this checkout's Electron itself, and each CLI's -W agent is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for a launch outside the project folder.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'workspacenotes-profile')
const ws = path.join(lib.WORK, 'workspacenotes-ws')
const claudeHome = path.join(lib.WORK, 'workspacenotes-claude-home')
const codexHome = path.join(lib.WORK, 'workspacenotes-codex-home')
const copilotDir = path.join(lib.WORK, 'workspacenotes-copilot')
const apiLog = path.join(lib.WORK, 'workspacenotes-copilot-api.jsonl')
const proj = path.join(ws, 'alpha')
const other = path.join(ws, 'beta')
const noteFile = path.join(ws, '.combwork', 'shared', 'Workspace notes.md')
const note = (edition) => `# Workspace notes\n\nNOTE-ALL-${edition}: node is C:\\tools\\node22\\node.exe here.\n\n## alpha\nNOTE-ALPHA-${edition}\n\n## beta\nNOTE-BETA-${edition}\n`
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(proj)
  lib.gitProject(other)
  fs.mkdirSync(path.dirname(noteFile), { recursive: true })
  fs.writeFileSync(noteFile, note(1))
  const copilot = copilotInstalled()
  lib.enableProviders(userData, ['claude-code', 'codex', ...(copilot ? ['copilot'] : [])])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = copilot ? await startFakeCopilotApi({ log: apiLog, systems: true }) : null
  const copilotEnv = api ? copilotTestEnv(api, copilotDir, { above: lib.WORK }) : {}
  const PORT = lib.port(47816)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, ...copilotEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  try {
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    if (copilot) await lib.waitForProvider(inv, 'copilot')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
    const ready = (id) => lib.until(async () => {
      const s = await live(id)
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, id), '\r')
      return ['ready', 'finished'].includes(s?.status)
    }, HUNG_MS, 200)
    const stopped = async (id) => {
      await inv('session:stop', proj, id)
      return !!(await lib.until(async () => !(await live(id)), HUNG_MS, 200))
    }
    const folderOf = async (id) => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === id).worktree?.path ?? proj
    const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    // Each CLI's instructions for the launch now running in a folder (the latest launch there).
    const claudeTold = (cwd) => {
      const l = lines(path.join(claudeHome, 'fake-launches.jsonl')).filter((x) => x.cwd.toLowerCase() === cwd.toLowerCase()).at(-1)
      const file = l?.opts['--append-system-prompt-file']
      return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    }
    const codexTold = (cwd) => {
      const l = lines(path.join(codexHome, 'fake-launches.jsonl')).filter((x) => x.cwd.toLowerCase() === cwd.toLowerCase() && !['--version', 'login', 'app-server'].includes(x.args[0])).at(-1)
      return l?.args.find((a) => a.startsWith('developer_instructions=')) ?? ''
    }
    // What Copilot sent the model: the system prompts of the requests since `from` (a turn's).
    const copilotTold = (from) => lines(apiLog).slice(from).map((r) => r.system ?? '').join('\n')
    const has = (text, edition, own = 'ALPHA') => text.includes(`NOTE-ALL-${edition}`) && text.includes(`NOTE-${own}-${edition}`) && !text.includes(`NOTE-${own === 'ALPHA' ? 'BETA' : 'ALPHA'}-${edition}`)

    // --- One agent of each CLI in the project folder and one in a folder of its own.
    const agents = []
    for (const [provider, short] of [['claude-code', 'Cla'], ['codex', 'Cod'], ...(copilot ? [['copilot', 'Cop']] : [])]) {
      for (const location of ['project', 'new-worktree']) agents.push({ provider, location, ...(await lib.addAgent(inv, proj, { name: `${short}-${location === 'project' ? 'P' : 'W'}`, provider, location })) })
    }
    for (const a of agents) a.cwd = await folderOf(a.id)
    // Copilot asks whether to trust a new folder: these are trusted already, as "Yes, and remember this folder" saves it.
    if (copilot) fs.writeFileSync(path.join(copilotDir, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: agents.filter((a) => a.provider === 'copilot').map((a) => a.cwd) }, null, 2))
    check('a folder of its own for each new-worktree agent', agents.filter((a) => a.location === 'new-worktree').every((a) => a.cwd.toLowerCase() !== proj.toLowerCase()), agents.map((a) => a.cwd).join(', '))
    for (const a of agents) await inv('session:start', proj, { agentId: a.id })
    for (const a of agents) check(`${a.name} starts`, !!(await ready(a.id)), (await live(a.id))?.status)

    /** What each agent was told, by its CLI's own record of its launch (Copilot's: a turn, then the model's requests). */
    const told = async (a) => {
      if (a.provider === 'claude-code') return lib.until(async () => claudeTold(a.cwd), HUNG_MS, 200)
      if (a.provider === 'codex') return lib.until(async () => codexTold(a.cwd), HUNG_MS, 200)
      const from = lines(apiLog).length
      await lib.sendPrompt(inv, lib.ptyKey(proj, a.id), 'say Noted.', { submitted: async () => lines(apiLog).length > from })
      await lib.until(async () => (await live(a.id))?.status === 'finished', HUNG_MS, 200)
      return copilotTold(from)
    }
    for (const a of agents) {
      const text = await told(a)
      check(`${a.name} (${a.location === 'project' ? 'the project folder' : 'its own folder'}): the note's lines for everyone and alpha, not beta's`, has(text, 1), text.slice(-400))
    }
    check('…under its header', /Workspace notes \(this machine\), from the shared note "Workspace notes":/.test(claudeTold(proj)))
    if (!copilot) console.log("SKIP Copilot's part: the GitHub Copilot CLI isn't installed (copilot)")

    // --- Another project's agent gets its own section, not alpha's.
    const beta = await lib.addAgent(inv, other, { name: 'Bet', provider: 'codex' })
    await inv('session:start', other, { agentId: beta.id })
    const betaLive = () => lib.until(async () => ['ready', 'finished'].includes((await inv('session:live')).find((s) => s.agentId === beta.id)?.status), HUNG_MS, 200)
    check("beta's agent starts", !!(await betaLive()))
    check("beta's agent gets beta's section, not alpha's", has(await lib.until(async () => codexTold(other), HUNG_MS, 200), 1, 'BETA'), codexTold(other).slice(-300))

    // --- An edit reaches the next launch, not the running one.
    fs.writeFileSync(noteFile, note(2))
    const claudeP = agents.find((a) => a.provider === 'claude-code' && a.location === 'project')
    const codexW = agents.find((a) => a.provider === 'codex' && a.location === 'new-worktree')
    check('a running agent keeps what it started with', has(claudeTold(claudeP.cwd), 1) && has(codexTold(codexW.cwd), 1))
    for (const a of [claudeP, codexW]) {
      check(`${a.name} stops`, await stopped(a.id))
      await inv('session:start', proj, { agentId: a.id })
      check(`${a.name} starts again`, !!(await ready(a.id)))
    }
    check('the next launch has the edit (Claude Code, the project folder)', has(await lib.until(async () => has(claudeTold(claudeP.cwd), 2) && claudeTold(claudeP.cwd), HUNG_MS, 200), 2), claudeTold(claudeP.cwd).slice(-300))
    check('…and Codex, its own folder', has(await lib.until(async () => has(codexTold(codexW.cwd), 2) && codexTold(codexW.cwd), HUNG_MS, 200), 2), codexTold(codexW.cwd).slice(-300))

    // --- Off in Settings → Advanced: nothing from the next launch.
    await inv('advanced:set', 'cw.notes.deliverWorkspaceNotes', false)
    check(`${codexW.name} stops`, await stopped(codexW.id))
    const launches = lines(path.join(codexHome, 'fake-launches.jsonl')).length
    await inv('session:start', proj, { agentId: codexW.id })
    check(`${codexW.name} starts`, !!(await ready(codexW.id)))
    await lib.until(async () => lines(path.join(codexHome, 'fake-launches.jsonl')).length > launches, HUNG_MS, 200)
    check('switched off, the next launch gets none of it', !codexTold(codexW.cwd).includes('NOTE-ALL'), codexTold(codexW.cwd).slice(-300))
    // Claude Code keeps a conversation's first system prompt on resume (since 2.1.267): one Combwork gave the note to is
    // resumed with it rendered fresh, so the note is gone from it too, by another agent in its folder as well (HR5's
    // rounds 1–2: the record is the conversation's, SessionRecord.promptAdded).
    const claudeSession = (await live(claudeP.id))?.sessionId
    check(`${claudeP.name} stops`, await stopped(claudeP.id))
    const second = await lib.addAgent(inv, proj, { name: 'Cla-Q', provider: 'claude-code', location: 'project' })
    const claudeLaunches = lines(path.join(claudeHome, 'fake-launches.jsonl')).length
    await inv('session:start', proj, { agentId: second.id, resumeId: claudeSession })
    check(`${second.name} resumes ${claudeP.name}'s conversation`, !!(await ready(second.id)))
    const resumed = await lib.until(async () => lines(path.join(claudeHome, 'fake-launches.jsonl')).slice(claudeLaunches).find((x) => x.cwd.toLowerCase() === proj.toLowerCase()), HUNG_MS, 200)
    check('switched off, a resumed Claude Code conversation that had the note appends nothing and renders its prompt fresh', resumed?.opts['--resume'] === claudeSession && !resumed?.opts['--append-system-prompt-file'] && resumed?.opts['--system-prompt-snapshot'] === 'off', JSON.stringify(resumed?.opts))
    agents.push({ ...second, cwd: proj })
    await inv('advanced:set', 'cw.notes.deliverWorkspaceNotes', null)

    // --- A project agent reads the note but can't write it; a script with the workspace's token can.
    const launch = lines(path.join(claudeHome, 'fake-launches.jsonl')).filter((x) => x.cwd.toLowerCase() === claudeP.cwd.toLowerCase()).at(-1)
    const hiveEnv = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env
    const agentToken = JSON.parse(fs.readFileSync(hiveEnv.CW_API_TOKEN_FILE, 'utf8')).token
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const at = `/v1/shared/file?path=${encodeURIComponent('Workspace notes.md')}`
    const read = await call(agentToken, 'GET', at)
    check('a project agent reads the note', read.status === 200 && /NOTE-ALL-2/.test(read.body?.content ?? ''), JSON.stringify(read).slice(0, 200))
    const refused = await call(agentToken, 'PUT', at, { content: 'mine now' })
    check("…but its write is refused, and says whose it is", refused.status === 403 && /the user's and the Assistant's/.test(refused.body?.error ?? JSON.stringify(refused.body)), JSON.stringify(refused))
    const appended = await call(agentToken, 'PUT', `/v1/shared/file?path=${encodeURIComponent('./workspace NOTES.md')}`, { content: 'x', append: true })
    check('…by another spelling of its path too', appended.status === 403, JSON.stringify(appended))
    check('…and the note is as it was', fs.readFileSync(noteFile, 'utf8') === note(2))
    const script = await call(workspaceToken, 'PUT', at, { content: note(3) })
    check("a script's write (the workspace's token) is taken", script.status === 200 && fs.readFileSync(noteFile, 'utf8') === note(3), JSON.stringify(script))

    // --- The Notes view: the note pinned first, and its editor says who gets it.
    await page.keyboard.press('Control+Shift+H')
    const pinned = page.locator('.pinned-note')
    check('Shared Notes has Workspace notes pinned first', !!(await lib.until(async () => (await pinned.count()) === 1, HUNG_MS, 200)))
    await pinned.click()
    check('…and opening it says who gets it', !!(await lib.until(async () => (await page.locator('[data-workspace-notes-notice]').count()) === 1, HUNG_MS, 200)))
    await page.screenshot({ path: path.join(lib.WORK, 'workspacenotes-editor.png') })

    for (const a of [...agents, beta]) await inv('session:stop', a === beta ? other : proj, a.id).catch(() => undefined)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS, 200)
  } finally {
    await app.close()
    await api?.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
