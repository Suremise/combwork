// Haiku asked for Auto (#129, #234), with the fake Claude Code acting out each thing a CLI may say about it
// (fake-models.json): Haiku takes Auto, doesn't (Claude Code 2.1.289), or the CLI doesn't say. Each time the Assistant
// starts with Haiku asking for Auto, and: the mode the CLI itself shows (modeObserved, from its hooks: never the mode
// asked for) is the one it said, Combwork shows that mode, and the connection dialog warns exactly when Auto isn't offered (HI-2145).
// The same checks (lib.haikuAutoMode, lib.haikuAutoCaveat) run against the real Claude Code in claude-real. Dev
// build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'automode-profile')
const ws = path.join(lib.WORK, 'automode-ws')
const claudeHome = path.join(lib.WORK, 'automode-claude-home')
const home = path.join(ws, '.combwork', 'assistant')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'api'), { recursive: true })
  const claude = lib.fakeClaude(userData, claudeHome, [ws, home])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47931), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await inv('settings:update', { assistant: { providers: { 'claude-code': { model: 'haiku' } } } })
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')

  for (const [haikuAuto, says] of [[false, "Haiku doesn't take Auto"], [true, 'Haiku takes Auto'], [null, 'nothing about Auto']]) {
    // What the CLI says now: Combwork asks it again.
    fs.writeFileSync(path.join(claudeHome, 'fake-models.json'), JSON.stringify({ haikuAuto }))
    await inv('provider:refresh', 'claude-code')
    const wanted = haikuAuto === null ? undefined : haikuAuto
    const said = await lib.until(async () => {
      const c = (await inv('provider:info'))['claude-code']
      return !c.checking && c.catalog?.source === 'cli' && c.catalog.models.find((m) => m.value === 'haiku')?.supportsAuto === wanted
    }, 15000)
    check(`the CLI says: ${says}`, !!said)

    await inv('session:start', home, { agentId: 'assistant' })
    await lib.until(async () => (await live())?.status === 'ready', 15000)
    const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split(/\r?\n/)
    const opts = JSON.parse(launches.at(-1)).opts
    check(`${says}: launched asking for Auto, with Haiku`, opts['--permission-mode'] === 'auto' && opts['--model'] === 'haiku', JSON.stringify(opts))
    const m = await lib.haikuAutoMode(inv, home)
    check(`${says}: the CLI shows the mode it says (${m.expected.join(' or ')})`, m.expected.includes(m.observed), m.observed ?? 'none shown')
    // Not merely the mode asked for: where the CLI said nothing or Auto, it still showed it itself.
    check(`${says}: Combwork shows the mode the CLI showed`, !!m.observed && m.shown === m.observed, `${m.shown} / ${m.observed}`)
    const [caveatRight, caveat] = await lib.haikuAutoCaveat(page, m.autoOffered)
    check(`${says}: the connection dialog warns exactly as the CLI says`, caveatRight, caveat)
    await page.keyboard.press('Control+Shift+E').catch(() => undefined)
    await inv('session:stop', home, 'assistant')
    await lib.until(async () => !(await live()), 15000)
  }

  fs.rmSync(path.join(claudeHome, 'fake-models.json'), { force: true })
  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
