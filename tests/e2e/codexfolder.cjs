// A stray .codex folder in a project warns (#509): Codex treats a project's .codex as its own, and one holding an
// agent's scratch stopped every Codex agent's commands there. A Codex agent (the fake) in a project whose .codex holds
// only Codex's configuration (config.toml, a custom agent in agents/, rules) starts with no warning; a probe written
// into .codex while it works is told at its turn's end, once (not again at the next turn), naming the folder.
// Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME; quiet. No real CLI runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'codexfolder-profile')
const ws = path.join(lib.WORK, 'codexfolder-ws')
const claudeHome = path.join(lib.WORK, 'codexfolder-claude-home')
const codexHome = path.join(lib.WORK, 'codexfolder-codex-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  // The project's own Codex configuration: what a .codex folder is for (its config, a custom agent, rules).
  fs.mkdirSync(path.join(alpha, '.codex', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(alpha, '.codex', 'rules'))
  fs.writeFileSync(path.join(alpha, '.codex', 'config.toml'), '[agents]\nmax_threads = 2\n')
  fs.writeFileSync(path.join(alpha, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\n')
  fs.writeFileSync(path.join(alpha, '.codex', 'rules', 'default.rules'), '')
  const env = { ...lib.fakeClaude(userData, claudeHome, [alpha]), CODEX_HOME: codexHome }
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv, 'codex')
  const warnings = async () => (await page.locator('.toast').allInnerTexts()).filter((t) => /\.codex folder here can stop Codex/.test(t))
  const agent = await inv('agents:add', alpha, { location: 'project', provider: 'codex' })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
  await inv('session:start', alpha, { agentId: agent.id })
  check('a Codex agent starts', !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 30000)), JSON.stringify(await live()))
  await new Promise((r) => setTimeout(r, 1000))
  check('…with no warning: the project’s .codex holds only Codex’s configuration (config, a custom agent, rules)', (await warnings()).length === 0, (await warnings()).join(' | '))

  // An agent writes its probe into .codex while the Codex agent works.
  fs.mkdirSync(path.join(alpha, '.codex', 'scratch', 'r2-484'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.codex', 'scratch', 'r2-484', 'probe.cjs'), '')
  const key = lib.ptyKey(alpha, agent.id)
  /** A turn, ended: the fake Codex says "Done: <prompt>" as it sends its Stop hook. */
  const turn = async (text) => {
    const done = async () => lib.plainText(await inv('pty:buffer', key)).includes(`Done: ${text}`)
    await lib.sendPrompt(inv, key, text, { submitted: done })
    return lib.until(async () => (await done()) && (await live())?.status === 'finished', 30000)
  }
  check('a turn ends', !!(await turn('hello')), JSON.stringify(await live()))
  const told = await lib.until(async () => ((await warnings()).length ? await warnings() : null), 10000)
  check('…and Combwork warns of the stray .codex folder, naming it and what it holds', told?.length === 1 && told[0].includes(path.join(alpha, '.codex')) && told[0].includes('scratch'), (told ?? []).join(' | '))
  await page.screenshot({ path: path.join(lib.WORK, 'codexfolder-warning.png') })
  check('another turn ends', !!(await turn('again')), JSON.stringify(await live()))
  await new Promise((r) => setTimeout(r, 1000))
  check('…with no second warning', (await warnings()).length === 1, (await warnings()).join(' | '))

  await inv('session:stop', alpha, agent.id)
  await lib.until(async () => !(await live()), 20000)
  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
