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
  return requests(def, [{ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }]).then(([r]) => r?.result ?? null)
}

/** The same server, sent requests in turn (ids 1, 2…): each reply (its result or error), null for one that never came. */
function requests(def, list) {
  return new Promise((resolve) => {
    const replies = Array.from({ length: list.length }, () => null)
    let got = 0
    const p = spawn(def.command, def.args ?? [], { env: lib.childEnv(def.env ?? {}), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const done = (v) => {
      clearTimeout(timer)
      p.kill()
      resolve(v)
    }
    const timer = setTimeout(() => done(replies), HUNG_MS)
    p.on('error', () => done(replies))
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (Number.isInteger(m.id) && m.id >= 1 && m.id <= list.length && !replies[m.id - 1]) {
            replies[m.id - 1] = m
            if (++got === list.length) done(replies)
          }
        } catch {
          // not a reply of its
        }
      }
    })
    list.forEach((r, i) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r }) + '\n'))
  })
}

/** Every description in a tool list: each tool's, and its parameters' at any depth, with where it is. */
function descriptions(tools) {
  const out = []
  const walk = (v, at) => {
    if (!v || typeof v !== 'object') return
    if (typeof v.description === 'string') out.push([at, v.description])
    for (const [k, x] of Object.entries(v)) if (k !== 'description' && k !== 'enum') walk(x, `${at}.${k}`)
  }
  for (const t of tools ?? []) walk(t, t.name)
  return out
}

/**
 * What a built script requires, through the chunks it loads: anything but Node's built-ins and Hive's own chunks. The
 * scripts run outside the asar, where nothing in node_modules can be found (a dev build would find this checkout's, so
 * only the built files can tell): agent text's formatter must be bundled in (HI-2433).
 */
function packagesRequired(entry) {
  const builtin = new Set(require('module').builtinModules)
  const seen = new Set()
  const out = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1]
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`))
      else if (!builtin.has(spec.replace(/^node:/, ''))) out.add(spec)
    }
  }
  walk(entry)
  return { files: seen.size, packages: [...out] }
}

;(async () => {
  for (const script of ['hive-mcp.js', 'hive-progress.js']) {
    const r = packagesRequired(path.join(lib.ROOT, 'out', 'main', script))
    check(`${script} and the chunks it loads require only Node's built-ins (agent text's formatter bundled in)`, r.files > 1 && r.packages.length === 0, JSON.stringify(r))
  }
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

    // Its tool lists (HI-2434), for each role, Control level and switch, and the errors its own code gives: every
    // description and error word the catalogue's. Nothing here needs Hive: the lists and these errors come before any call.
    const ids = new Set(Object.keys(catalogue))
    const canaryEnv = { ...on.env, HIVE_DIALECT_FILE: dialectFile, HIVE_DIALECT: 'canary' }
    const assistant = (control) => ({ HIVE_ROLE: 'assistant', HIVE_PROJECT: '', HIVE_ASSISTANT_CONTROL: control, HIVE_ASSISTANT_SETTINGS: '1', HIVE_JOURNAL: '1', HIVE_DEV_CONSOLE: '1' })
    const roles = [
      ['agent', { HIVE_DEV_CONSOLE: '1' }, [['hive_lane', { action: 'nope' }], ['hive_merge_slot', { action: 'nope' }], ['hive_queue', { action: 'pause' }], ['hive_nope', {}]]],
      ['assistant at Look and advise', assistant('look'), []],
      ['assistant at Agents', assistant('agents'), []],
      ['assistant at Projects', assistant('projects'), [['hive_team', { action: 'nope' }], ['hive_connection', { action: 'nope' }], ['hive_release_slot', { action: 'nope', project: 'alpha' }], ['hive_template', { action: 'nope', project: 'alpha' }]]]
    ]
    for (const [role, roleEnv, calls] of roles) {
      const [listed, ...answers] = await requests({ ...on, env: { ...canaryEnv, ...roleEnv } }, [{ method: 'tools/list', params: {} }, ...calls.map(([name, args]) => ({ method: 'tools/call', params: { name, arguments: args } }))])
      const all = descriptions(listed?.result?.tools)
      const wrong = all.flatMap(([at, d]) => canaryProblems(d, ids, ['alpha']).map((p) => `${at}: ${p}`))
      check(`canary: every description in the ${role}'s tool list is the catalogue's`, all.length > 50 && wrong.length === 0, `${all.length} descriptions; ${wrong.slice(0, 3).join(' | ')}`)
      const errors = answers.map((a) => a?.result?.content?.[0]?.text ?? a?.error?.message ?? '')
      const bad = errors.flatMap((t, i) => (t.startsWith('⟦tool.') ? canaryProblems(t, ids) : ['no error in markers']).map((p) => `${calls[i][0]}: ${p} (${t.slice(0, 120)})`))
      if (calls.length) check(`canary: the ${role}'s errors from its own code are the catalogue's`, bad.length === 0, bad.join(' | '))
    }

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
