// Hive's guidance for agents (#1285, #966 row 13: hive.guidance, on by default), on a fake Claude Code session
// (fake-claude/), so nothing signs in or spends tokens. The hive MCP server each launch was given (its --mcp-config, as
// Hive wrote it) is started here as Claude Code would start it and asked to initialize:
// - on: it answers with Hive's guidance as its instructions;
// - off (Settings → Advanced, from the next session): the same server, Hive's tools still there, answers with none.
// Then the new Advanced rows (this switch and Claude Code's "Hive's status line in place of yours", row 12) in both
// themes (agentguidance-*.png in the run's folder). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'agentguidance-profile')
const ws = path.join(lib.WORK, 'agentguidance-ws')
const claudeHome = path.join(lib.WORK, 'agentguidance-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47850))
const GUIDANCE = 'hive.guidance'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

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
          // not a reply of its
        }
      }
    })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) + '\n')
  })
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, port: PORT, provideHiveMcp: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const def = await lib.addAgent(inv, alpha, { name: 'Tester' })
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === def.id)
    const launches = () => {
      const f = path.join(claudeHome, 'fake-launches.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    /** A launch's hive server: started, ready, its --mcp-config read while it runs (it holds the server's environment). */
    const hiveServer = async () => {
      const before = launches().length
      await inv('session:start', alpha, { agentId: def.id })
      await lib.until(async () => launches().length > before && (await live())?.status === 'ready', HUNG_MS)
      const file = launches().at(-1).opts['--mcp-config']
      const server = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.hive
      await inv('session:stop', alpha, def.id)
      await lib.until(async () => !(await live()), HUNG_MS)
      return server
    }

    // ---- On (the default): the guidance as the server's instructions.
    const on = await hiveServer()
    check('the launch has the hive server', !!on?.command, JSON.stringify(on))
    const withGuidance = await initialize(on)
    check("on: the hive server answers with Hive's guidance as its instructions", typeof withGuidance?.instructions === 'string' && /hive_inbox|Hive/.test(withGuidance.instructions), JSON.stringify(withGuidance).slice(0, 300))

    // ---- The canary dialect (HI-2065): the same server given a dialect file with every catalogue text in markers. Its
    // instructions must come through the catalogue whole: a word outside the markers bypassed it.
    const catalogueDir = path.join(lib.ROOT, 'agent-text', 'catalogue')
    const catalogue = Object.assign({}, ...fs.readdirSync(catalogueDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(catalogueDir, f), 'utf8'))))
    const { canaryTexts, canaryProblems } = require('../../src/shared/agentText/canary.ts')
    const dialectFile = path.join(lib.probeDir('agentguidance-canary'), 'dialect.json')
    fs.writeFileSync(dialectFile, JSON.stringify({ texts: canaryTexts(catalogue), files: ['canary'], hash: 'canary' }))
    const canary = await initialize({ ...on, env: { ...on.env, HIVE_DIALECT_FILE: dialectFile, HIVE_DIALECT: 'canary' } })
    const problems = typeof canary?.instructions === 'string' ? canaryProblems(canary.instructions, new Set(Object.keys(catalogue)), ['alpha']) : ['no instructions']
    check("canary: the server reads the dialect file, and every word of its instructions is the catalogue's", problems.length === 0 && canary.instructions.includes('⟦contract.agent.host⟧'), `${problems.join('; ')} | ${String(canary?.instructions).slice(0, 300)}`)

    // ---- Off: the same server, its tools still there, no instructions.
    await inv('advanced:set', GUIDANCE, false)
    const off = await hiveServer()
    check('off: the launch still has the hive server (Hive\'s tools)', !!off?.command && off.env?.HIVE_GUIDANCE === '0', JSON.stringify(off?.env ?? {}).slice(0, 300))
    const without = await initialize(off)
    check('…which answers with no instructions', !!without && !('instructions' in without), JSON.stringify(without).slice(0, 300))
    await inv('advanced:set', GUIDANCE, true)

    // ---- The new rows in Settings → Advanced, in both themes.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const search = page.getByRole('textbox', { name: 'Search settings' })
    for (const [name, query, id] of [['guidance', 'guidance for agents', GUIDANCE], ['statusline', 'status line in place', 'claude-code.override.statusLine']]) {
      await search.fill(query)
      const row = page.locator(`.advanced-row[data-advanced="${id}"]`)
      // The list's values are the store's, refreshed by advanced:set's event after it returns (HI-1988): wait for the switch too.
      check(`Advanced lists ${id}, on`, !!(await lib.until(async () => (await row.count()) === 1 && (await row.getByRole('switch').getAttribute('aria-checked')) === 'true', HUNG_MS)), await row.getByRole('switch').getAttribute('aria-checked', { timeout: 1000 }).catch((e) => e.message))
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(theme), HUNG_MS)
        await page.screenshot({ path: path.join(lib.WORK, `agentguidance-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
