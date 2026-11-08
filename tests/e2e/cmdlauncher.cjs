// A CLI whose path is a .cmd launcher Combwork can't start directly (not npm's, nor a one-line `@node "%~dp0…" %*`), in a
// folder whose name has spaces and other letters (HI-2722): it runs through cmd.exe, whose /s took the quoted path's own
// quotes ("'C:\…\proj' is not recognized"), so the agent never started. Here the fake agy behind such a launcher, in
// `proj ä ö · Gem One`, its profile in a folder like it too: its one-time setup runs in a terminal, an agent starts, and
// each gets the arguments Combwork gave it, unchanged (its settings file's path with spaces, a first task with them).
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const root = path.join(lib.WORK, 'cmdlauncher ä ö')
const userData = path.join(root, 'profile (x86)')
const ws = path.join(lib.WORK, 'cmdlauncher-ws')
const alpha = path.join(ws, 'alpha')
const bin = path.join(root, 'proj ä ö · Gem One')
const agyLog = path.join(lib.WORK, 'cmdlauncher-fake-agy.jsonl')
const ran = path.join(lib.WORK, 'cmdlauncher-through-cmd.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const entries = (kind) => (fs.existsSync(agyLog) ? fs.readFileSync(agyLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind) : [])

;(async () => {
  for (const d of [root, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [agyLog, ran]) fs.rmSync(f, { force: true })
  lib.gitProject(alpha)
  // The launcher does something of its own first (marks that it ran), so Combwork can't start its script directly.
  fs.mkdirSync(bin, { recursive: true })
  const launcher = path.join(bin, 'agy.cmd')
  fs.writeFileSync(launcher, `@echo off\r\necho %* >> "%CW_CMD_RAN%"\r\nnode "${path.join(__dirname, 'fake-agy', 'fake-agy.cjs')}" %*\r\n`)
  lib.enableProviders(userData, ['claude-code', 'antigravity'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.antigravity = { ...cfg.settings.providers.antigravity, executablePath: launcher }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47715), FAKE_AGY_LOG: agyLog, CW_CMD_RAN: ran })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const { until } = lib
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Combwork found this launcher (its version check, through cmd.exe too: HI-2548). Never on: a CLI it found
  // elsewhere instead would be a real agy, which this suite must not start.
  const found = (await inv('provider:refresh', 'antigravity')).antigravity
  check('Combwork finds the launcher at a path with spaces and other letters', (found?.path ?? '').toLowerCase() === launcher.toLowerCase() && found?.version === '1.5.0', JSON.stringify({ path: found?.path, version: found?.version }))
  if (failed) {
    await app.close()
    console.log(`${failed} check(s) failed: nothing started`)
    process.exit(1)
  }

  // --- agy's one-time setup, a terminal task started through cmd.exe.
  const setupKey = await inv('provider:task', 'antigravity', 'setup')
  const shown = await until(async () => entries('onboarding').find((o) => o.shown) ?? null, HUNG_MS)
  check('its one-time setup starts in a terminal, through the launcher at a path with spaces', !!shown && fs.existsSync(ran), shown ? '' : String(await inv('pty:buffer', setupKey).catch(() => '')).slice(-400))
  await inv('pty:write', setupKey, 'accept')
  await inv('pty:write', setupKey, '\r')
  check('…and is completed there', !!(await until(async () => entries('onboarded').length === 1, HUNG_MS)))

  // --- An agent, with a first task: its launch through cmd.exe, its arguments as Combwork gave them.
  const gem = await lib.addAgent(inv, alpha, { name: 'Gem One', provider: 'antigravity' })
  const task = 'Read the notes in proj ä ö · Gem One (x86), then say what 日本 means'
  // The setup task was a launch too: the agent's is the one after it.
  const before = entries('session').length
  await inv('session:start', alpha, { agentId: gem.id, prompt: task })
  const launch = await until(async () => entries('session')[before] ?? null, HUNG_MS)
  check('an agent starts through the launcher at a path with spaces and other letters', !!launch && fs.readFileSync(ran, 'utf8').trim().split('\n').length >= 2, launch ? '' : 'never started')
  const args = launch?.args ?? []
  const settings = args[args.indexOf('--settings') + 1] ?? ''
  check('…its settings file arrives whole, a path with spaces and other letters', settings.startsWith(userData) && fs.existsSync(settings) && /"statusLine"/.test(fs.readFileSync(settings, 'utf8')), JSON.stringify(args))
  check('…and its first task as it was given', args.at(-2) === '-i' && args.at(-1) === task, JSON.stringify(args.slice(-2)))
  check('…its conversation known to Combwork', !!(await until(async () => (await live(gem.id))?.sessionId || null, HUNG_MS)))
  await inv('session:stop', alpha, gem.id)
  await until(async () => !(await live(gem.id)), HUNG_MS)

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
