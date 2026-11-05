// Hooks health, part 2 (#1371): a quick turn with its hooks off, over before Combwork's first look at its screen, is caught by
// its transcript: the turn the CLI recorded (Claude Code's promptId, Codex's turn_id), which no hook named. With the
// fake Claude Code and the fake Codex, and Combwork's bound (Hooks missing: wait) at 3 s. Combwork's checks are held while a file
// is there (HIVE_TEST_HOOKS_HOLD), so each turn is over, its screen idle and its transcript written before any check
// looks: only the transcript can show it (a condition, not a race with the check's period).
// - a healthy quick turn (its hooks came) is never flagged; then its hooks are turned off and a quick marked turn runs:
//   released, the flag is "transcript", naming that turn's own id, never the healthy one's;
// - its hooks back, the next turn's hook (a newer turn) clears it.
// Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'hookstranscript-profile')
const ws = path.join(lib.WORK, 'hookstranscript-ws')
const claudeHome = path.join(lib.WORK, 'hookstranscript-claude-home')
const codexHome = path.join(lib.WORK, 'hookstranscript-codex-home')
const hold = path.join(lib.WORK, 'hookstranscript-hold')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const jsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
/** Every rollout file under CODEX_HOME's sessions. */
const rollouts = (dir = path.join(codexHome, 'sessions')) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? rollouts(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []))
  } catch {
    return []
  }
}

;(async () => {
  for (const d of [userData, ws, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(hold, { force: true })
  lib.gitProject(alpha)
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha])
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.hooks.missingSeconds': 3 } }, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47846), ...cenv, CODEX_HOME: codexHome, FAKE_CODEX_VERSION: '0.162.1', HIVE_TEST_TIPS: 'off', HIVE_TEST_HOOKS_HOLD: hold })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await inv('project:setActive', alpha, true)
    await lib.waitForProvider(inv)
    await lib.waitForProvider(inv, 'codex')
    const live = async (a) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === a.id)
    const raw = async (a) => (await inv('pty:buffer', lib.ptyKey(alpha, a.id)).catch(() => '')) ?? ''

    /**
     * One quick turn, with Combwork's checks held: typed, then over on its screen (this prompt's own end, after a mark) and
     * idle, its transcript holding its turn (`turnOf`: its id there, by its text); then the hold is let go. Its id.
     */
    const quickTurn = async (a, text, turnOf, ended) => {
      fs.writeFileSync(hold, '')
      const mark = (await raw(a)).length
      const sent = await lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), text, { submitted: async () => ended(lib.plainText((await raw(a)).slice(mark))) })
      const id = sent > 0 ? await until(() => turnOf(text), HUNG_MS) : null
      const idle = await until(async () => ['ready', 'finished', 'unknown'].includes((await live(a))?.status) || !!(await live(a))?.hooksMissing || ended(lib.plainText((await raw(a)).slice(mark))), HUNG_MS)
      fs.rmSync(hold, { force: true })
      return { id, ok: sent > 0 && !!id && !!idle }
    }

    // --- Claude Code: its turns by promptId (prompt_id in its hooks).
    const cc = await lib.addAgent(inv, alpha, { name: 'Builder' })
    await inv('session:start', alpha, { agentId: cc.id })
    check('Claude Code starts', !!(await until(async () => (await live(cc))?.status === 'ready', 45000)))
    const sessionId = (await live(cc))?.sessionId
    const transcript = path.join(claudeHome, 'projects', alpha.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
    const promptIdOf = (text) => jsonl(transcript).find((e) => e.type === 'user' && e.message?.content === text)?.promptId ?? null
    const ccEnded = (shown) => /Worked for/.test(shown)
    const nohooks = (agent, off, home) => {
      const f = path.join(home, `fake-nohooks-${agent}`)
      if (off) fs.writeFileSync(f, '')
      else fs.rmSync(f, { force: true })
    }

    const healthy = await quickTurn(cc, 'hh-healthy one', promptIdOf, ccEnded)
    check('a healthy quick turn runs and is over before any check (held)', healthy.ok, JSON.stringify(healthy))
    nohooks('Builder', true, claudeHome)
    const deaf = await quickTurn(cc, 'hh-deaf two', promptIdOf, ccEnded)
    check('with its hooks off, a quick marked turn runs and is over before any check (held)', deaf.ok, JSON.stringify(deaf))
    const flagged = await until(async () => (await live(cc))?.hooksMissing, HUNG_MS)
    check("released, its transcript shows the turn no hook named: hooks missing, shown by the transcript, naming that turn's promptId", flagged?.after === 'transcript' && flagged?.turn === deaf.id && deaf.id !== healthy.id, JSON.stringify({ flagged, deaf: deaf.id, healthy: healthy.id }))
    nohooks('Builder', false, claudeHome)
    const mark = (await raw(cc)).length
    await lib.sendPrompt(inv, lib.ptyKey(alpha, cc.id), 'hh-back three', { submitted: async () => ccEnded(lib.plainText((await raw(cc)).slice(mark))) })
    check('its hooks back, a newer turn’s hook clears it', !!(await until(async () => !(await live(cc))?.hooksMissing, HUNG_MS)), JSON.stringify((await live(cc))?.hooksMissing))

    // --- Codex: its turns by turn_id. Started with its hooks on, so its session (and rollout) is known.
    const cx = await lib.addAgent(inv, alpha, { name: 'Cx', provider: 'codex' })
    await inv('session:start', alpha, { agentId: cx.id })
    check('Codex starts', !!(await until(async () => (await live(cx))?.status === 'ready', 45000)))
    const turnIdOf = (text) =>
      rollouts()
        .flatMap(jsonl)
        .find((e) => e.type === 'event_msg' && e.payload?.type === 'item_completed' && e.payload.item?.type === 'UserMessage' && e.payload.item.content?.[0]?.text === text)?.payload.turn_id ?? null
    // Its turn's end: the fake's "Done: <prompt>" line, after a mark (this prompt's own).
    const cxEnded = (shown) => /Done: hh-cx/.test(shown)
    const first = await quickTurn(cx, 'hh-cx healthy', turnIdOf, cxEnded)
    check('a healthy Codex turn (its hooks name its session and rollout)', first.ok, JSON.stringify(first))
    nohooks('Cx', true, codexHome)
    const cxDeaf = await quickTurn(cx, 'hh-cx deaf', turnIdOf, cxEnded)
    check('with its hooks off, a quick marked Codex turn runs (held)', cxDeaf.ok, JSON.stringify(cxDeaf))
    const cxFlag = await until(async () => (await live(cx))?.hooksMissing, HUNG_MS)
    check("released, the rollout's turn no hook named: hooks missing by the transcript, naming its turn_id", cxFlag?.after === 'transcript' && cxFlag?.turn === cxDeaf.id && cxDeaf.id !== first.id, JSON.stringify({ cxFlag, deaf: cxDeaf.id, healthy: first.id }))
    nohooks('Cx', false, codexHome)
    const cxMark = (await raw(cx)).length
    await lib.sendPrompt(inv, lib.ptyKey(alpha, cx.id), 'hh-cx back', { submitted: async () => cxEnded(lib.plainText((await raw(cx)).slice(cxMark))) })
    check('its hooks back, the next turn clears it', !!(await until(async () => !(await live(cx))?.hooksMissing, HUNG_MS)), JSON.stringify((await live(cx))?.hooksMissing))
  } catch (e) {
    check('suite ran', false, e?.stack ?? String(e))
  } finally {
    fs.rmSync(hold, { force: true })
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
