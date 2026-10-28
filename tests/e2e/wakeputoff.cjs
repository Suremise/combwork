// A wake put off part-way (HI-1974), on a fake Claude Code and a fake Codex agent: a doorbell typed into an idle agent
// whose terminal is 40 columns wide, so the line wraps onto several rows, is held before its Enter (HIVE_TEST_HOLD_TYPED),
// and idle wakes are turned off meanwhile, so it is no longer wanted. What Hive typed is taken back whole: the input is
// empty again (the fake Claude Code's Ctrl+U deletes one wrapped row, as Claude Code 2.1.312's does; LB1 kept a stopped
// wake's first rows, and the next wake was sent after them). Idle wakes on again, the next wake is typed and sent alone.
// Codex (and Copilot, wakepaste-copilot) clear the whole line with one Ctrl+U. Dev build only (the seam), throwaway
// profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFile } = require('child_process')
const { Terminal } = require('@xterm/headless')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const COLS = 40

const userData = path.join(lib.WORK, 'wakeputoff-profile')
const ws = path.join(lib.WORK, 'wakeputoff-ws')
const claudeHome = path.join(lib.WORK, 'wakeputoff-claude-home')
const codexHome = path.join(lib.WORK, 'wakeputoff-codex-home')
const hold = path.join(lib.WORK, 'wakeputoff-hold')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47864))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome, hold]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  lib.logFakeInput(claudeHome)
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
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // Both follow Hive's notices, as a model does: they read their inbox and ack what they listed.
  fs.writeFileSync(path.join(claudeHome, 'fake-follow-notices.txt'), '')
  fs.writeFileSync(path.join(codexHome, 'fake-follow-notices.txt'), '')

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_HOLD_TYPED: hold })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms, 100)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const homeOf = (a) => (a.provider === 'codex' ? codexHome : claudeHome)
    /** The doorbells the agent was sent, each line as its CLI took it. */
    const wakes = (a) => lines(path.join(homeOf(a), 'fake-wakes.jsonl')).filter((w) => w.agent === a.name && w.doorbell).map((w) => w.doorbell)
    const setSwitch = (which, value) => inv('advanced:set', `hive.inbox.${which}`, value)
    const hiveLog = () => {
      const f = path.join(userData, 'logs', 'hive.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    const logCount = (re) => hiveLog().split('\n').filter((l) => re.test(l)).length
    /** What the agent's terminal shows: its output (pty:buffer, which keeps what was erased too) drawn at its size. */
    const screen = async (a) => {
      const key = lib.ptyKey(alpha, a.id)
      const size = await inv('pty:size', key)
      const output = String(await inv('pty:buffer', key).catch(() => ''))
      const term = new Terminal({ cols: size?.cols ?? 120, rows: size?.rows ?? 40, allowProposedApi: true })
      await new Promise((res) => term.write(output, res))
      const b = term.buffer.active
      const rows = []
      for (let i = 0; i < term.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
      term.dispose()
      return rows.join('\n')
    }
    /** The doorbell's copies on screen, wherever its rows were wrapped. */
    const onScreen = async (a) => ((await screen(a)).replace(/\s+/g, '').match(/\[Hive\]Newinyourinbox/g) ?? []).length

    await page.getByText('alpha', { exact: true }).first().click()
    const claude = { ...(await lib.addAgent(inv, alpha, { name: 'Claude' })), name: 'Claude', provider: 'claude-code' }
    const codex = { ...(await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', permissionMode: 'approve-for-me' })), name: 'Codex', provider: 'codex' }
    for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
    check('both agents start', !!(await until(async () => (await idle(claude.id)) && (await idle(codex.id)), HUNG_MS)))

    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status === 'ready'), HUNG_MS)
    // Not synchronous: leaving a message replies once its doorbell is typed, which the test holds meanwhile.
    const tool = (name, args) =>
      new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'hive-mcp.js')], { env: lib.childEnv({ HIVE_API_URL: API, HIVE_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', HIVE_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', HIVE_PROJECT: '' }), timeout: 60000 }, (e, out) => (e ? reject(e) : resolve(JSON.parse(String(out).split('\n')[0]).result.content[0].text)))
        child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      })
    const leave = async (a, text) => /\((m\d+)/.exec(await tool('hive_message_agent', { project: 'alpha', agent: a.name, text }))?.[1] ?? null
    const delivery = async (a, id) => JSON.parse(await tool('hive_agent_activity', { project: 'alpha', agent: a.name, detail: true })).inbox?.deliveries?.find((d) => d.id === id) ?? null

    for (const a of [claude, codex]) {
      const key = lib.ptyKey(alpha, a.id)
      // Narrow, so the doorbell wraps onto several rows (asked again until the terminal is that size).
      check(`${a.name}: its terminal is ${COLS} columns wide`, !!(await until(async () => (await inv('pty:resize', key, COLS, 30), (await inv('pty:size', key))?.cols === COLS), HUNG_MS)), JSON.stringify(await inv('pty:size', key)))
      const before = wakes(a).length
      const held = logCount(/the line Hive typed is held before its Enter/)
      const putOff = logCount(/put off: It is no longer wanted/)
      fs.writeFileSync(hold, '')
      const left = leave(a, 'Rebase onto main.')
      check(`${a.name}: its doorbell is typed, and held before its Enter`, !!(await until(() => logCount(/the line Hive typed is held before its Enter/) > held, HUNG_MS)))
      // The fake Codex doesn't draw its input: its line is checked by what it is sent (below).
      const draws = a.provider === 'claude-code'
      if (draws) check(`${a.name}: …it shows in its input, wrapped onto several rows`, !!(await until(async () => (await onScreen(a)) === 1, HUNG_MS)) && (await inv('pty:size', key))?.cols === COLS, await screen(a))
      // No longer wanted as it waits there: what it was made for can't be typed by itself now.
      await setSwitch('idleWakes', false)
      check(`${a.name}: idle wakes turned off: the wake is put off part-way`, !!(await until(() => logCount(/put off: It is no longer wanted/) > putOff, HUNG_MS)))
      if (draws) check(`${a.name}: …what Hive typed is taken back whole: none of it is left in the input`, !!(await until(async () => (await onScreen(a)) === 0, HUNG_MS)), await screen(a))
      const m = await left
      const waiting = await delivery(a, m)
      check(`${a.name}: …nothing was sent, the message still waits`, !!m && wakes(a).length === before && waiting?.state === 'queued', JSON.stringify({ m, wakes: wakes(a).slice(before), d: waiting }))
      fs.rmSync(hold, { force: true })
      await setSwitch('idleWakes', null)
      check(`${a.name}: idle wakes on again: the next wake is typed and sent`, !!(await until(() => wakes(a).length > before, HUNG_MS)), JSON.stringify(wakes(a).slice(before)))
      const sent = wakes(a).slice(before)
      check(`${a.name}: …alone: one doorbell, nothing typed before it`, sent.length === 1 && sent[0].startsWith('[Hive] New in your inbox') && (sent[0].match(/\[Hive\]/g) ?? []).length === 1, JSON.stringify(sent))
      check(`${a.name}: …it reads and acks the message`, !!(await until(async () => (await delivery(a, m))?.state === 'acked' && (await idle(a.id)), HUNG_MS)), JSON.stringify(await delivery(a, m)))
    }
  } catch (e) {
    check('no error', false, e.stack)
  } finally {
    fs.rmSync(hold, { force: true })
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
