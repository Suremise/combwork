// The Codex sandbox "Set up" task: Combwork opens Codex in a task terminal and brings up its sandbox setup
// prompt (through /permissions, as no sandbox is set up yet). Uses a copy of the test home's sign-in with no
// sandbox configured. Only looks at the prompt Codex shows; never chooses an option (the admin one needs the user).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxsetup-profile')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData, ['codex'])
  const home = path.join(scratch, 'codex-nosandbox')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  for (const f of ['auth.json', 'models_cache.json', 'version.json', 'installation_id']) {
    if (fs.existsSync(path.join(lib.CODEX_HOME, f))) fs.copyFileSync(path.join(lib.CODEX_HOME, f), path.join(home, f))
  }
  fs.writeFileSync(path.join(home, 'config.toml'), '')
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47890), CODEX_HOME: home, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const key = await inv('provider:task', 'codex', 'setup')
  check('setup task starts', key === 'task:codex:setup', key)
  let text = ''
  for (let i = 0; i < 40 && !/Set up default sandbox|Unrecognized/i.test(text); i++) {
    await sleep(1000) // The poll interval of the loop around it, which waits for a condition (not a fixed wait).
    text = (await inv('pty:buffer', key)).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ')
  }
  check('Codex opened without a trust prompt', !/Trust this folder/.test(text))
  check('Codex shows its sandbox setup prompt', /Set up default sandbox/i.test(text) && /non-admin sandbox/i.test(text), text.slice(-400))
  check('no unrecognized command', !/Unrecognized command/i.test(text))
  // Codex stays open after the setup; Combwork closes it once the config names a sandbox. Stands in for Codex
  // finishing (the real setup needs the user) by writing what Codex writes.
  fs.writeFileSync(path.join(home, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  let closed = false
  for (let i = 0; i < 15 && !closed; i++) {
    await sleep(1000) // The poll interval of the loop around it, which waits for a condition (not a fixed wait).
    closed = (await inv('pty:buffer', key)) === ''
  }
  check('Combwork closes Codex once the sandbox is set up', closed)
  if (!closed) await inv('pty:kill', key)
  await lib.until(async () => (await inv('pty:buffer', key).catch(() => '')) === '', 10000)
  await app.close()
  console.log(results.join('\n'))
  console.log('TAIL:', text.slice(-600))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
