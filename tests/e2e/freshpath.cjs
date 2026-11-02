// A CLI installed while Hive runs is found without a restart (#472). The test copy starts with a PATH holding no Codex
// (the run context's, without the folders that have one) and a stand-in for the registry's PATH
// (HIVE_TEST_REGISTRY_PATH: test copies never read the machine's). Then the suite "installs" the fake Codex as an
// installer does: a folder of its own with codex.cmd, added to the registry's PATH (the stand-in, changed in Hive's main
// process while it runs). Provider Setup's Check again finds it there (via PATH), Hive's own PATH has the folder, and a new
// Codex agent starts with it, its session's PATH holding the folder too. Then a tool is "installed" the same way with no
// Check again (#821): a Sign in task's terminal and the agent started again after it get its folder, as Hive reads the
// registry's PATH before it starts a process. No real CLI is installed: the fake Codex is tests/e2e/fake-codex.
// Throwaway profile, workspace and CODEX_HOME; quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'freshpath-profile')
const ws = path.join(lib.WORK, 'freshpath-ws')
const codexHome = path.join(lib.WORK, 'freshpath-codex-home')
// The "install" folder, with codex.cmd (a one-line launcher, as npm makes) and its script.
const bin = path.join(lib.WORK, 'freshpath-bin')
// A tool's folder, installed later outside Hive (#821).
const tool = path.join(lib.WORK, 'freshpath-tool')
const seen = path.join(lib.WORK, 'freshpath-seen.jsonl')
const alpha = path.join(ws, 'alpha')
// The fake's version, so Provider Setup's answer is known to be this copy.
const VERSION = '0.160.472'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The run context's PATH for a test copy without the folders that hold a Codex (node stays, for the launcher). */
function pathWithoutCodex() {
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (env[key] ?? '')
    .split(path.delimiter)
    .filter((d) => d && !['codex.exe', 'codex.cmd', 'codex.bat'].some((f) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), f))))
    .join(path.delimiter)
}

;(async () => {
  for (const d of [userData, ws, codexHome, bin, tool]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(seen, { force: true })
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(tool, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  // Notes each run's first argument and whether its PATH has the folder, then is the fake Codex.
  const fake = path.join(__dirname, 'fake-codex', 'fake-codex.cjs')
  fs.writeFileSync(
    path.join(bin, 'codex.cjs'),
    `const fs = require('fs')\nconst p = process.env.PATH ?? process.env.Path ?? ''\nfs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ arg: process.argv[2] ?? '', hasBin: p.toLowerCase().split(';').includes(${JSON.stringify(bin.toLowerCase())}), hasTool: p.toLowerCase().split(';').includes(${JSON.stringify(tool.toLowerCase())}) }) + '\\n')\nrequire(${JSON.stringify(fake)})\n`
  )
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@node "%~dp0codex.cjs" %*\r\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const hidden = pathWithoutCodex()
  check('the test copy gets a PATH without Codex, with node', !hidden.toLowerCase().includes(bin.toLowerCase()) && hidden.split(path.delimiter).some((d) => fs.existsSync(path.join(d, 'node.exe'))))

  const { app, page, inv } = await lib.launch({ userData, env: { PATH: hidden, HIVE_TEST_REGISTRY_PATH: '', CODEX_HOME: codexHome, FAKE_CODEX_VERSION: VERSION }, viewport: { width: 1300, height: 820 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const codexInfo = async () => (await inv('provider:info')).codex
  const before = await codexInfo()
  // Where Codex is installed on this machine, Hive still finds that one (its standalone or npm folder): not this one.
  check('before the install, Hive has not found this Codex', before.path !== path.join(bin, 'codex.cmd'), JSON.stringify({ path: before.path, source: before.source }))
  if (!before.found) check('…and says Codex is not installed', (before.readiness ?? []).some((r) => r.id === 'not-installed'), JSON.stringify(before.readiness))

  // --- The install: the folder goes on the registry's PATH, not on Hive's.
  await app.evaluate((_, dir) => {
    process.env.HIVE_TEST_REGISTRY_PATH = dir
  }, bin)

  await page.keyboard.press('Control+Shift+P')
  await lib.sleep(300)
  await page.keyboard.type('Provider Setup')
  await lib.sleep(300)
  await page.keyboard.press('Enter')
  const setup = page.locator('.dialog', { hasText: 'Provider Setup' })
  check('Provider Setup opens', !!(await lib.until(async () => (await setup.count()) === 1, 10000)))
  await setup.locator('.setup-tab', { hasText: 'Codex' }).click()
  await setup.locator('button', { hasText: 'Check again' }).click()
  const after = await lib.until(async () => {
    const i = await codexInfo()
    return !i.checking && i.path === path.join(bin, 'codex.cmd') ? i : null
  }, 30000)
  check('Check again finds the new Codex on the PATH, without restarting Hive', !!after && after.source === 'PATH' && after.version === VERSION, JSON.stringify(after ?? (await codexInfo())))
  check('…and it is ready (installed)', !!after && !(after.readiness ?? []).some((r) => r.id === 'not-installed'), JSON.stringify(after?.readiness))
  const shows = await lib.until(async () => (await setup.innerText()).includes(`Codex ${VERSION}`), 10000)
  check('Provider Setup shows it found, via PATH', !!shows && (await setup.innerText()).includes('found via PATH'), (await setup.innerText()).slice(0, 300))
  await page.screenshot({ path: path.join(lib.WORK, 'freshpath-setup.png') })
  const hivePath = await app.evaluate(() => process.env.PATH ?? process.env.Path ?? '')
  check("Hive's own PATH has the folder, after its own folders", hivePath.toLowerCase().endsWith(bin.toLowerCase()) && hivePath.toLowerCase().startsWith(hidden.split(path.delimiter)[0].toLowerCase()), hivePath.slice(-200))
  await setup.locator('button', { hasText: 'Close' }).click()

  // --- A new agent uses it, with the new PATH.
  await lib.openWorkspace(inv, page, ws)
  const agent = await lib.addAgent(inv, alpha, { name: 'Fresh', provider: 'codex' })
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const n = runs().length
  await inv('session:start', alpha, { agentId: agent.id })
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  check('a new Codex agent starts with it', !!(await lib.until(async () => (await live())?.status === 'ready', 25000)), JSON.stringify(await live()))
  const session = runs().slice(n).filter((r) => !['--version', 'login', 'debug', 'app-server'].includes(r.arg))
  check("…and its session's PATH has the new folder", session.length > 0 && session.every((r) => r.hasBin), JSON.stringify(runs().slice(n)))
  check('…but not a folder not installed yet', session.every((r) => !r.hasTool), JSON.stringify(runs().slice(n)))

  // --- A tool installed later, outside Hive (#821): its folder goes on the registry's PATH, and nothing makes Hive
  // look for the CLIs again. What Hive starts from now on has it.
  await app.evaluate((_, dirs) => {
    process.env.HIVE_TEST_REGISTRY_PATH = dirs
  }, [bin, tool].join(';'))
  const m = runs().length
  await inv('provider:task', 'codex', 'login')
  const login = await lib.until(() => runs().slice(m).find((r) => r.arg === 'login'), 20000)
  check("a Sign in task's terminal started after it has the tool's folder", !!login && login.hasTool, JSON.stringify(runs().slice(m)))
  await inv('session:stop', alpha, agent.id)
  check('the agent stops', !!(await lib.until(async () => {
    // One read (#882): the session can go between two, and the second's `.status` would throw out of lib.until.
    const s = await live()
    return !s || s.status === 'stopped'
  }, 15000)), JSON.stringify(await live()))
  const k = runs().length
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts again', !!(await lib.until(async () => (await live())?.status === 'ready', 25000)), JSON.stringify(await live()))
  const again = runs().slice(k).filter((r) => !['--version', 'login', 'debug', 'app-server'].includes(r.arg))
  check("…and its session's PATH has the tool's folder, with no Check again", again.length > 0 && again.every((r) => r.hasTool), JSON.stringify(runs().slice(k)))

  await inv('session:stop', alpha, agent.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
