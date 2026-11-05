// Several windows, like VS Code: each shows its own workspace. New Window, a workspace already open in
// another window is brought forward instead, events stay in their window, the Agent API names workspaces,
// windows are reopened at start, and closing a window, switching its workspace or closing the workspace stops
// that workspace's agents (after asking). A workspace by another name (a junction) is the same one (#455). The agents
// run the fake Claude Code (fake-claude/, #194).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { _electron } = require('playwright-core')

const userData = path.join(lib.WORK, 'windows-profile')
const wsA = path.join(lib.WORK, 'windows-ws-a')
const wsB = path.join(lib.WORK, 'windows-ws-b')
/** Workspace A by another name: a junction to it (#455). */
const aliasA = path.join(lib.WORK, 'windows-ws-a-alias')
const claudeHome = path.join(lib.WORK, 'windows-claude-home')
const PORT = Number(lib.port(47893))
const sleep = lib.sleep
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

function api(method, p, headers = {}) {
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function start() {
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  app.on('window', (p) => p.on('pageerror', (e) => console.log('FAIL page error', e.message)))
  return app
}
const invOn = (page) => (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
async function waitFor(fn, ms = 15000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(300)
  }
  return null
}

;(async () => {
  // The alias first, as a link (rmdir never follows a junction into its folder).
  try {
    fs.rmdirSync(aliasA)
  } catch {
    // Not there yet.
  }
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  for (const [ws, names] of [[wsA, ['shared', 'alpha']], [wsB, ['shared', 'beta']]]) for (const n of names) fs.mkdirSync(path.join(ws, n), { recursive: true })
  lib.fakeClaude(userData, claudeHome, [wsA, wsB].flatMap((ws) => ['shared', 'alpha', 'beta'].map((n) => path.join(ws, n))))
  // Ask before stopping any session, so closing a window with one running shows the dialog.
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'always' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // --- Two windows, two workspaces.
  let app = await start()
  const p1 = await app.firstWindow()
  await lib.appReady(p1)
  const inv1 = invOn(p1)
  await inv1('workspace:open', wsA)
  const next = app.waitForEvent('window')
  await inv1('window:new')
  const p2 = await next
  await p2.waitForLoadState('domcontentloaded')
  await lib.appReady(p2)
  const inv2 = invOn(p2)
  check('New Window opens a second window on the welcome page', (await inv2('workspace:get')) === null)
  await inv2('workspace:open', wsB)
  await sleep(500)
  check('each window has its own workspace', (await inv1('workspace:get'))?.path === wsA && (await inv2('workspace:get'))?.path === wsB)

  // Opening A in window 2 brings window 1 forward and leaves window 2 as it is.
  const again = await inv2('workspace:open', wsA)
  check('a workspace open elsewhere: that window comes forward, this one keeps its own', again?.path === wsB && (await inv2('workspace:get'))?.path === wsB)
  // By another name too (#455): window 1 shows it, so it comes forward, rather than the folder opening a second time.
  fs.symlinkSync(wsA, aliasA, 'junction')
  const byAlias = await inv2('workspace:open', aliasA).catch((e) => ({ error: e.message }))
  check('…also by another name for its folder (a junction)', byAlias?.path === wsB && (await inv2('workspace:get'))?.path === wsB && (await inv1('workspace:get'))?.path === wsA, JSON.stringify(byAlias))
  await p2.screenshot({ path: path.join(lib.WORK, 'windows-alias-elsewhere.png') }).catch(() => undefined)

  // A change in one window's workspace shows there only.
  await inv1('project:create', 'gamma')
  await lib.until(async () => (await p1.locator('.sidebar').innerText().catch(() => '')).includes('gamma'), 10000)
  const t1 = await p1.locator('.sidebar').innerText().catch(() => '')
  const t2 = await p2.locator('.sidebar').innerText().catch(() => '')
  check("a workspace's changes reach its own window", /gamma/.test(t1), t1.slice(0, 200))
  check("…and not the other's", !/gamma/.test(t2) && /beta/.test(t2), t2.slice(0, 200))

  // The Agent API names workspaces.
  let r = await api('GET', '/v1/workspaces')
  check('API: /v1/workspaces lists both', r.status === 200 && r.body.length === 2, JSON.stringify(r.body))
  r = await api('GET', '/v1/projects')
  const names = (r.body ?? []).map((x) => `${x.workspace}/${x.name}`).sort()
  check('API: /v1/projects lists every window\'s projects with their workspace', JSON.stringify(names) === JSON.stringify(['windows-ws-a/alpha', 'windows-ws-a/gamma', 'windows-ws-a/shared', 'windows-ws-b/beta', 'windows-ws-b/shared']), JSON.stringify(names))
  r = await api('GET', '/v1/projects/shared')
  check('API: a project name in two workspaces is ambiguous (409)', r.status === 409, JSON.stringify(r))
  r = await api('GET', `/v1/projects/${encodeURIComponent('windows-ws-b/shared')}`)
  check('API: <workspace>/<project> picks one', r.status === 200 && r.body.path === path.join(wsB, 'shared'), JSON.stringify(r))
  r = await api('GET', '/v1/projects/shared', { 'X-Hive-Workspace': encodeURIComponent(wsA) })
  check("API: a session's workspace header picks its own", r.status === 200 && r.body.path === path.join(wsA, 'shared'), JSON.stringify(r))
  r = await api('GET', '/v1/shared')
  check('API: workspace-wide calls ask which workspace when several are open (400)', r.status === 400, JSON.stringify(r))
  r = await api('GET', '/v1/shared?workspace=windows-ws-b')
  check('API: …and answer with ?workspace=', r.status === 200, JSON.stringify(r))

  // --- Quit, and start again: both windows come back.
  const exited = app.waitForEvent('close', { timeout: 20000 }).then(() => true).catch(() => false)
  await inv1('app:quit').catch(() => undefined)
  check('Combwork quits with no agents running', await exited)
  app = await start()
  await app.firstWindow()
  await waitFor(async () => app.windows().length >= 2, 15000)
  await lib.until(async () => { const ws = app.windows(); if (ws.length < 2) return false; const paths = await Promise.all(ws.map((pg) => invOn(pg)('workspace:get').then((w) => w?.path ?? null).catch(() => null))); if (!paths.every(Boolean)) return false; const info = await invOn(ws[0])('provider:info').catch(() => null); return !!info && Object.values(info).every((p) => !p.checking) }, 60000) // both windows back, and the CLIs found again
  const pages = app.windows()
  const shown = []
  for (const pg of pages) shown.push((await invOn(pg)('workspace:get'))?.path ?? null)
  check('at start, the windows open when Combwork quit come back', pages.length === 2 && shown.includes(wsA) && shown.includes(wsB), JSON.stringify(shown))

  // --- Closing a window with a running agent: asks, then stops that workspace's agent only.
  const pb = pages[shown.indexOf(wsB)]
  const pa = pages[shown.indexOf(wsA)]
  const invB = invOn(pb)
  const invA = invOn(pa)
  const beta = path.join(wsB, 'beta')
  const agent = await lib.addAgent(invB, beta)
  await invB('session:start', beta, { agentId: agent.id })
  await lib.acceptClaudeTrust(invB, beta, agent.id)
  check('an agent runs in window B', !!(await waitFor(async () => (await invA('session:live')).length === 1)))
  await pb.evaluate(() => window.hive.invoke('window:close')).catch(() => undefined)
  const dialog = await waitFor(async () => (await pb.getByText('Close this window?').count()) > 0, 8000)
  check('closing it asks first ("Close this window?")', !!dialog)
  await pb.screenshot({ path: path.join(lib.WORK, 'windows-close.png') }).catch(() => undefined)
  await pb.locator('.dialog .btn', { hasText: 'Close window' }).click().catch(() => undefined)
  const closed = await waitFor(async () => app.windows().length === 1, 10000)
  check('the window closes', !!closed)
  check("its workspace's agent was stopped", (await invA('session:live')).length === 0)
  check('the other window stays, with its workspace', (await invA('workspace:get'))?.path === wsA)
  // Settings are saved a moment after they change.
  const readSaved = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).windows ?? []
  const saved = (await waitFor(async () => (readSaved().length === 1 ? readSaved() : null), 5000)) ?? readSaved()
  check('the closed window is no longer reopened at start', saved.length === 1 && saved[0].workspace === wsA, JSON.stringify(saved.map((w) => w.workspace)))

  // --- Switching a window's workspace with an agent running: asks (Cancel keeps everything), then stops it.
  const alpha = path.join(wsA, 'alpha')
  const agentA = await lib.addAgent(invA, alpha)
  await invA('session:start', alpha, { agentId: agentA.id })
  await lib.acceptClaudeTrust(invA, alpha, agentA.id)
  check('an agent runs in window A', !!(await waitFor(async () => (await invA('session:live')).length === 1)))
  // Its own workspace by another name isn't a switch (#455): no question, its agent runs on, and it keeps the name it has.
  // Nor is it closed and opened again (HI-2141: that ended what its passes were writing): counted by the log's "Opened
  // workspace" lines once the switch below has logged its own, which comes after any this open would have written.
  const openedLines = () => fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8').split('\n').filter((l) => l.includes('Opened workspace')).length
  const openedBefore = openedLines()
  const same = invA('workspace:open', aliasA)
  const asked = await waitFor(async () => (await pa.getByText('Switch workspace?').count()) > 0, 4000)
  await pa.screenshot({ path: path.join(lib.WORK, 'windows-alias-same.png') }).catch(() => undefined)
  if (asked) await pa.locator('.dialog .btn', { hasText: 'Cancel' }).click()
  const reopened = await same
  check('opening its own workspace by another name asks nothing', !asked)
  check('…keeps its name and its agent running', reopened?.path === wsA && (await invA('workspace:get'))?.path === wsA && (await invA('session:live')).length === 1, JSON.stringify({ path: reopened?.path, live: (await invA('session:live')).length }))
  let pending = invA('workspace:open', wsB)
  check('switching workspace asks first ("Switch workspace?")', !!(await waitFor(async () => (await pa.getByText('Switch workspace?').count()) > 0, 8000)))
  await pa.screenshot({ path: path.join(lib.WORK, 'windows-switch.png') }).catch(() => undefined)
  await pa.locator('.dialog .btn', { hasText: 'Cancel' }).click()
  check('Cancel keeps the workspace', (await pending)?.path === wsA)
  check('…and the agent running', (await invA('session:live')).length === 1)
  pending = invA('workspace:open', wsB)
  await waitFor(async () => (await pa.getByText('Switch workspace?').count()) > 0, 8000)
  await pa.locator('.dialog .btn', { hasText: 'Switch workspace now' }).click()
  check('confirming switches the workspace', (await pending)?.path === wsB)
  await waitFor(async () => openedLines() > openedBefore, 8000)
  check('…and opening its own workspace neither closed nor opened it again', openedLines() === openedBefore + 1, `${openedLines() - openedBefore} opened`)
  check("…after stopping the old workspace's agent", (await invA('session:live')).length === 0)

  // --- Close Workspace with an agent running: asks, then stops every agent of the workspace.
  const agentB = await lib.addAgent(invA, beta)
  await invA('session:start', beta, { agentId: agentB.id })
  check('an agent runs in workspace B', !!(await waitFor(async () => (await invA('session:live')).length === 1)))
  pending = invA('workspace:close')
  check('Close Workspace asks first ("Close this workspace?")', !!(await waitFor(async () => (await pa.getByText('Close this workspace?').count()) > 0, 8000)))
  await pa.screenshot({ path: path.join(lib.WORK, 'windows-close-workspace.png') }).catch(() => undefined)
  await pa.locator('.dialog .btn', { hasText: 'Close workspace now' }).click()
  check('the workspace closes', (await pending) === true && (await invA('workspace:get')) === null)
  check('…with its agents stopped', (await invA('session:live')).length === 0)

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
