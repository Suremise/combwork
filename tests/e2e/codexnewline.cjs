// A typed prompt's line breaks for Codex (HI-1327), on the fake Codex, which takes Alt+Enter (ESC CR) as a new line in
// its prompt and Enter as a send, as Codex 0.164's editor does. A card the user starts on a running Codex agent without
// hive tools is typed into its CLI:
// 1. with Send prompts as typed on and Typed prompts: line breaks at its default (Automatic: Alt+Enter only with a Codex
//    version it was tried with; the fake says 0.160.0), the prompt goes in on one line, as before;
// 2. with Alt+Enter chosen (any version), Codex records the prompt as written, its line breaks, blank lines and indentation kept, in
//    one prompt (one turn), with nothing sent early;
// 3. with the switch off, one line again.
// Dev build, throwaway profile, workspace and Codex home; nothing signs in or spends tokens.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'codexnewline-profile')
const ws = path.join(lib.WORK, 'codexnewline-ws')
const claudeHome = path.join(lib.WORK, 'codexnewline-claude-home')
const codexHome = path.join(lib.WORK, 'codexnewline-codex-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47701))
const AS_TYPED = 'cw.prompt.asTyped'
const NEWLINE = 'codex.prompt.newlineKey'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  // No hive tools, so a card the user starts on a running agent is typed into its CLI (#650).
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, port: PORT, provideHiveMcp: false, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const codex = await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', permissionMode: 'full-access' })
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === codex.id)
    const idle = async () => ['ready', 'finished'].includes((await live())?.status)
    await inv('session:start', alpha, { agentId: codex.id })
    check('the fake Codex starts', !!(await lib.until(idle, HUNG_MS)))

    /** Every prompt Codex recorded (its rollouts' user messages), in order. */
    const prompts = () => {
      const out = []
      const walk = (dir) => {
        for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
          const f = path.join(dir, e.name)
          if (e.isDirectory()) walk(f)
          else if (/^rollout-.*\.jsonl$/.test(e.name)) for (const l of lines(f)) if (l.type === 'response_item' && l.payload?.role === 'user') out.push(l.payload.content?.[0]?.text ?? '')
        }
      }
      walk(path.join(codexHome, 'sessions'))
      return out
    }
    /** Starts a card on the agent (typed into its CLI), and waits for the prompt that has its title, and for it to be idle. */
    const startCard = async (title, description) => {
      const card = await inv('tasks:create', { title, description, project: 'alpha' })
      let started = null
      await lib.until(async () => {
        started = await inv('tasks:start', card.number, { kind: 'agent', agentId: codex.id }).then(() => true, (e) => String(e?.message ?? e))
        return started === true || !/being given another card|is working|has just typed in it/.test(started)
      }, HUNG_MS, 300)
      const got = await lib.until(() => {
        const g = prompts().filter((t) => t.includes(title))
        return g.length ? g : null
      }, HUNG_MS, 200)
      await lib.until(idle, HUNG_MS, 200)
      return { started, got: got || [] }
    }
    const written = 'Plan one:\r\n  step A\n\nstep B'

    // 1. As typed, at the default, with a Codex version it wasn't tried with: one line, as before.
    await inv('advanced:set', AS_TYPED, true)
    let r = await startCard('Card one', written)
    check('a card started on the Codex agent is typed into it', r.started === true, String(r.started))
    check("at the default, with a Codex version it wasn't tried with (0.160.0), Codex gets it on one line, as before",r.got.length === 1 && !r.got[0].includes('\n') && r.got[0].includes('Plan one:   step A  step B'), JSON.stringify(r.got))

    // 2. Alt+Enter: as written, in one prompt.
    await inv('advanced:set', NEWLINE, 'alt-enter')
    r = await startCard('Card two', written)
    check('with Alt+Enter, Codex gets the prompt as written: line breaks, the blank line and indentation kept', r.got.length === 1 && r.got[0].endsWith('Card two\n\nPlan one:\n  step A\n\nstep B'), JSON.stringify(r.got))
    check('…in one prompt: nothing was sent early', prompts().filter((t) => /Plan one|step A|step B/.test(t) && !t.includes('Card one')).length === 1, JSON.stringify(prompts()))

    // 3. The switch off: one line again, whatever the line-break choice.
    await inv('advanced:set', AS_TYPED, false)
    r = await startCard('Card three', written)
    check('with Send prompts as typed off, one line again', r.got.length === 1 && !r.got[0].includes('\n') && r.got[0].includes('Card three Plan one: step A step B'), JSON.stringify(r.got))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
