// Dialects wired into sessions (HI-2443; plans/2026-11-03-dialects-design.md, sections 3 and 7, card 6b): each session's
// chain is pinned at its launch, so an edit applies at its next launch and shows "restart to apply" meanwhile; an
// agent's Dialect setting picks the file in its model slot (a test copy here, which Auto never picks); the launch record
// shows the chain; hive-mcp.js gets the chain's texts through HIVE_DIALECT_FILE; the Agent API speaks each caller's
// chain (an agent's pinned one, the API chain for the workspace token, which follows the files). Runs the fake Claude
// Code and the fake Codex (whose session contract Hive says itself, as developer_instructions). Dev build, throwaway
// profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'dialectlaunch-profile')
const ws = path.join(lib.WORK, 'dialectlaunch-ws')
const claudeHome = path.join(lib.WORK, 'dialectlaunch-claude-home')
const codexHome = path.join(lib.WORK, 'dialectlaunch-codex-home')
const proj = path.join(ws, 'alpha')
const dialects = path.join(ws, '.hive', 'dialects')
const PORT = lib.port(47710)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// The texts overridden: the contract's first line (contract.agent.host, which both CLIs get) and the Agent API's
// "No route" error (api.http.noRoute, said in the caller's chain). Each override has exactly its placeholders.
const host = (mark) => `${mark} {hasProject, select, yes {{project}} other {}}.`
const noRoute = (mark) => `${mark} {method} {path}`
const dialectFile = (name, texts) => JSON.stringify({ name, texts: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text, why: 'dialectlaunch' }])) }, null, 2)
const writeWorkspace = (hostMark, routeMark) => fs.writeFileSync(path.join(dialects, 'workspace.json'), dialectFile('Workspace', { 'contract.agent.host': host(hostMark), 'api.http.noRoute': noRoute(routeMark) }))
const TEST_COPY = 'claude-code/Mark v2.json'
const writeTestCopy = (hostMark, routeMark) => fs.writeFileSync(path.join(dialects, ...TEST_COPY.split('/')), dialectFile('Mark v2', { 'contract.agent.host': host(hostMark), 'api.http.noRoute': noRoute(routeMark) }))

/** The hive server of a launch's MCP config, started as its CLI would start it, asked to initialize: its result. */
function initialize(def) {
  return new Promise((resolve) => {
    const p = spawn(def.command, def.args ?? [], { env: lib.childEnv(def.env ?? {}), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = (v) => {
      clearTimeout(timer)
      p.kill()
      resolve(v)
    }
    const timer = setTimeout(() => done(null), HUNG_MS)
    p.on('error', () => done(null))
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (m.id === 1) done(m.result ?? null)
        } catch {
          // not a reply
        }
      }
    })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) + '\n')
  })
}

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  fs.mkdirSync(ws, { recursive: true })
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase(), ws.toLowerCase()]))
  // The workspace's own dialect (every session's, and the API chain's), and a test copy for Claude Code beside the
  // empty files Hive ships (synced in as the workspace opens).
  fs.mkdirSync(path.join(dialects, 'claude-code'), { recursive: true })
  writeWorkspace('WS-HOST-1', 'WS-ROUTE-1')
  writeTestCopy('MODEL-HOST-1', 'MODEL-ROUTE-1')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const until = async (fn, ms = HUNG_MS) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const ready = (id) => until(async () => {
    const s = await live(id)
    if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, id), '\r')
    return ['ready', 'finished'].includes(s?.status)
  }, HUNG_MS)
  const agentNow = async (id) => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === id)
  const restart = async (id) => {
    await inv('session:stop', proj, id)
    await until(async () => !(await live(id)), HUNG_MS)
    await inv('session:start', proj, { agentId: id })
    return ready(id)
  }
  // The Agent API: the workspace token (a caller with no session), or an agent's own (its session's chain).
  const wsToken = await until(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token || null
    } catch {
      return null
    }
  }, HUNG_MS)
  const noRouteSaid = async (token) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/no-such-route`, { headers: { Authorization: `Bearer ${token}` } })
    return (await r.json().catch(() => ({}))).error ?? `(status ${r.status})`
  }
  const claudeLaunch = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.env?.HIVE_AGENT === 'Clara').at(-1)
  const codexTold = () => {
    const l = fs.readFileSync(path.join(codexHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.agent === 'Cody').at(-1)
    const i = l?.args.findIndex((a) => a.startsWith('developer_instructions=')) ?? -1
    return i >= 0 ? JSON.parse(l.args[i].slice('developer_instructions='.length)) : ''
  }

  // --- A caller with no session: the API chain (API → Workspace → Default), the shipped API file empty.
  check('the workspace token is said the Workspace file\'s text (the API chain)', (await noRouteSaid(wsToken)).startsWith('WS-ROUTE-1 GET /v1/no-such-route'), await noRouteSaid(wsToken))

  // --- Clara (Claude Code) picks the test copy; Cody (Codex) is on Auto, which never picks a test copy.
  const clara = await lib.addAgent(inv, proj, { name: 'Clara' })
  const cody = await lib.addAgent(inv, proj, { name: 'Cody', provider: 'codex' })
  const saved = await inv('agents:update', proj, clara.id, { dialect: TEST_COPY })
  check('the Dialect setting is saved on the agent', saved?.dialect === TEST_COPY, JSON.stringify(saved))
  await inv('session:start', proj, { agentId: clara.id })
  await inv('session:start', proj, { agentId: cody.id })
  check('both agents start', !!(await ready(clara.id)) && !!(await ready(cody.id)))

  // The launch record: each layer's file, the pick, the chain's hash and its guidance revision.
  const claraRecord = (await agentNow(clara.id))?.live?.launched
  const d1 = claraRecord?.dialect
  check("Clara's launch record shows its chain: the picked file, its CLI's file, the Workspace file", d1?.pick === TEST_COPY && JSON.stringify(d1?.layers) === JSON.stringify([{ layer: 'model', file: TEST_COPY }, { layer: 'cli', file: 'claude-code/cli.json' }, { layer: 'workspace', file: 'workspace.json' }]), JSON.stringify(d1))
  check('…with its hash, and a guidance revision of its own (the chain changes the contract)', /^[0-9a-f]{16}$/.test(d1?.hash ?? '') && /^[0-9a-f]{16}$/.test(d1?.guidance ?? '') && d1.guidance !== claraRecord.guidance, JSON.stringify(claraRecord))
  const codyRecord = (await agentNow(cody.id))?.live?.launched?.dialect
  check("Cody's (Auto) has no model file, the test copy never picked: its CLI's file and the Workspace file", !codyRecord?.pick && codyRecord?.layers?.[0]?.file === null && codyRecord?.layers?.[2]?.file === 'workspace.json' && /^[0-9a-f]{16}$/.test(codyRecord?.hash ?? ''), JSON.stringify(codyRecord))
  check('…and says why when it can\'t name the model ("model unknown"), else the real model ID it matched by', codyRecord?.modelUnknown === true || typeof codyRecord?.model === 'string', JSON.stringify(codyRecord))

  // hive-mcp.js (Claude Code's contract comes from its instructions) and hive-progress get the chain's file.
  const launch = claudeLaunch()
  const mcp = launch?.opts?.['--mcp-config'] ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers?.hive : null
  const file = mcp?.env?.HIVE_DIALECT_FILE
  check("Clara's hive server is given its chain's file, and its shell too (for hive-progress)", !!file && fs.existsSync(file) && launch.env?.HIVE_DIALECT_FILE === file && mcp.env.HIVE_DIALECT === d1?.hash, JSON.stringify({ file, env: launch?.env }))
  const instructions = (await initialize(mcp))?.instructions ?? ''
  check('…which its hive server speaks: the contract opens with the test copy\'s line', instructions.startsWith('MODEL-HOST-1 alpha.'), instructions.slice(0, 160))
  check("Cody's contract (Hive's own developer_instructions) opens with the Workspace file's line", codexTold().startsWith('WS-HOST-1 alpha.'), codexTold().slice(0, 160))
  // The Agent API answers an agent in its own chain.
  const claraToken = launch?.token
  check("Clara's own token is said the test copy's text", (await noRouteSaid(claraToken)).startsWith('MODEL-ROUTE-1 GET'), await noRouteSaid(claraToken))

  // --- An edit: pinned, it applies at the next launch; meanwhile "restart to apply". The API chain follows at once.
  check('before any edit, neither needs a restart', (await agentNow(clara.id))?.restartNeeded === false && (await agentNow(cody.id))?.restartNeeded === false)
  writeTestCopy('MODEL-HOST-2', 'MODEL-ROUTE-2')
  check('editing a file in its chain shows "restart to apply" on Clara', !!(await until(async () => (await agentNow(clara.id))?.restartNeeded === true, HUNG_MS)))
  check("…not on Cody, whose chain doesn't have it", (await agentNow(cody.id))?.restartNeeded === false)
  check('…while Clara still speaks the chain she launched on', (await noRouteSaid(claraToken)).startsWith('MODEL-ROUTE-1 GET'), await noRouteSaid(claraToken))
  writeWorkspace('WS-HOST-1', 'WS-ROUTE-2')
  check('a caller with no session follows the Workspace file\'s edit', !!(await until(async () => (await noRouteSaid(wsToken)).startsWith('WS-ROUTE-2 '), HUNG_MS)), await noRouteSaid(wsToken))
  check('…which Cody\'s chain has too: it shows "restart to apply"', !!(await until(async () => (await agentNow(cody.id))?.restartNeeded === true, HUNG_MS)))

  check('Clara restarts', !!(await restart(clara.id)))
  const d2 = (await agentNow(clara.id))?.live?.launched?.dialect
  check('…on the edited chain: a new hash, and no restart needed', !!d2 && d2.hash !== d1.hash && !!(await until(async () => (await agentNow(clara.id))?.restartNeeded === false, HUNG_MS)), JSON.stringify(d2))
  const launch2 = claudeLaunch()
  check('…and speaks it: its token, and its hive server\'s contract', (await noRouteSaid(launch2?.token)).startsWith('MODEL-ROUTE-2 GET') && ((await initialize(JSON.parse(fs.readFileSync(launch2.opts['--mcp-config'], 'utf8')).mcpServers.hive))?.instructions ?? '').startsWith('MODEL-HOST-2 alpha.'))

  // --- Back to Auto: a change of the setting is a change of chain, applied at the next launch.
  await inv('agents:update', proj, clara.id, { dialect: null })
  check('the setting back on Auto (null) is saved as Auto', !(await agentNow(clara.id))?.dialect)
  check('…and asks for a restart', !!(await until(async () => (await agentNow(clara.id))?.restartNeeded === true, HUNG_MS)))
  check('Clara restarts on Auto', !!(await restart(clara.id)))
  const d3 = (await agentNow(clara.id))?.live?.launched?.dialect
  check('…with no pick and the test copy out of her model slot', !!d3 && !d3.pick && d3.layers[0].file !== TEST_COPY, JSON.stringify(d3))
  check("…so she speaks the Workspace file's text", (await noRouteSaid(claudeLaunch()?.token)).startsWith('WS-ROUTE-2 GET'), await noRouteSaid(claudeLaunch()?.token))

  // --- No dialect at all: nothing written, nothing in the environment (the Default, as before).
  fs.writeFileSync(path.join(dialects, 'workspace.json'), JSON.stringify({ name: 'Workspace', texts: {} }, null, 2))
  check('Clara restarts with no file overriding anything', !!(await restart(clara.id)))
  const plain = claudeLaunch()
  const plainMcp = JSON.parse(fs.readFileSync(plain.opts['--mcp-config'], 'utf8')).mcpServers.hive
  const d4 = (await agentNow(clara.id))?.live?.launched
  check('…gets no dialect file, in its hive server or its shell', !plainMcp.env.HIVE_DIALECT_FILE && !plain.env?.HIVE_DIALECT_FILE, JSON.stringify(plain.env))
  check('…and its launch record says the Default: no hash, the Default\'s guidance revision', d4?.dialect?.hash === '' && d4.dialect.guidance === d4.guidance, JSON.stringify(d4))
  check('…and Hive\'s own English', (await noRouteSaid(plain.token)).startsWith('No route for GET'), await noRouteSaid(plain.token))
  await page.screenshot({ path: path.join(lib.WORK, 'dialectlaunch.png') })

  for (const id of [clara.id, cody.id]) await inv('session:stop', proj, id).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
