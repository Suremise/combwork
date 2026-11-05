// The run context (runContext.cjs, #203): nothing from the environment a test is started from reaches what it starts,
// but the allowlist. With the variables an agent's shell or an outer hive-progress sets put into this suite's own
// environment (NO_COLOR, CW_PROGRESS_WRAPPED, an Agent API token…), checked: under the runner, the suite itself got
// nothing else; a test Combwork's main process (whose environment its agents' shells get), a child that is part of Combwork,
// and the hive-progress wrapper (#202: it reports, not taking itself for nested) see none of them; a test Combwork's git
// reads the suite's global config, with the test identity (#1466); and a test Combwork
// started with any environment but lib.hiveEnv's is refused.
const lib = require('./lib.cjs')
const ctx = require('./runContext.cjs')
const { _electron } = require('playwright-core')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const userData = path.join(lib.WORK, 'isolation-profile')
const data = path.join(lib.WORK, 'isolation-progress-data')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const upper = (keys) => keys.filter((k) => !k.startsWith('=')).map((k) => k.toUpperCase())

/** What an agent's shell in Combwork, an outer hive-progress, or a person's own shell may have set. */
const LEAKS = {
  NO_COLOR: '1',
  FORCE_COLOR: '1',
  CW_PROGRESS_WRAPPED: '1',
  CW_PROGRESS_RUN_AS_NODE: '1',
  CW_PROGRESS_DATA: 'C:\\leaked\\progress',
  CW_API_URL: 'http://127.0.0.1:9',
  CW_API_TOKEN: 'leaked-token',
  CW_PROJECT: 'leaked',
  CW_TEST_SLOW_IPC: 'tasks:list=1',
  CW_E2E_NATIVE: '1',
  CLAUDE_CONFIG_DIR: 'C:\\leaked\\claude',
  COPILOT_HOME: 'C:\\leaked\\copilot',
  GH_CONFIG_DIR: 'C:\\leaked\\gh',
  GIT_CONFIG_GLOBAL: 'C:\\leaked\\gitconfig',
  ANTHROPIC_API_KEY: 'leaked-key',
  NODE_OPTIONS: '--max-old-space-size=4096',
  PROMPT: 'leaked$G',
  ELECTRON_RUN_AS_NODE: '1'
}
/** The LEAKS an environment has, by name and value (cmd.exe's default PROMPT isn't one, a leaked PROMPT is). */
const leaked = (env) => Object.entries(env).filter(([k, v]) => LEAKS[k.toUpperCase()] === v).map(([k]) => k)

;(async () => {
  // Under the runner: the suite's environment is the allowlist, the settings passed on by name and its run context.
  if (process.env.E2E_RUN_SUITE) {
    const allowed = new Set(upper([...ctx.ALLOW, ...Object.keys(ctx.PASS_ENV), 'CW_E2E_DIR', 'CW_E2E_PORT', 'CW_API_PORT', ...ctx.CARRIED]))
    const extra = upper(Object.keys(process.env)).filter((k) => !allowed.has(k))
    check("the runner gave this suite nothing of its own environment but the allowlist", !extra.length, extra.join(', '))
  } else console.log('(run on its own: the runner check is skipped)')

  Object.assign(process.env, LEAKS)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(data, { recursive: true, force: true })

  // A test Combwork: its main process's environment is what its agents' shells and the CLIs start from.
  const { app } = await lib.launch({ userData, env: { CW_API_PORT: lib.port(47929) } })
  try {
    const env = await app.evaluate(() => Object.fromEntries(Object.entries(process.env)))
    check("a test Combwork gets none of the suite's environment", !leaked(env).length, leaked(env).join(', '))
    // CHROME_CRASHPAD_PIPE_NAME: Combwork's own crash handler, which Electron sets in main for its processes (#985); what Combwork
    // starts doesn't get it (ptyHost's childEnv).
    const allowed = new Set(upper([...ctx.ALLOW, 'CW_USER_DATA', 'CW_TEST_QUIET', 'CW_TEST_TIPS', 'CW_TEST_CLI_HOME_CONNECTION', 'CW_LANG', 'CW_TEST_TRASH_DIR', ...Object.keys(ctx.cliHomes()), 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CW_API_PORT', ...ctx.CARRIED, 'CHROME_CRASHPAD_PIPE_NAME']))
    // PROMPT: cmd.exe's default ($P$G), which Playwright's start of Electron on Windows sets; not the suite's.
    const extra = upper(Object.keys(env)).filter((k) => !allowed.has(k) && !(k === 'PROMPT' && env[Object.keys(env).find((x) => x.toUpperCase() === 'PROMPT')] === '$P$G'))
    check('…only the allowlist and its run context', !extra.length, extra.join(', '))
    check('…with its profile, quiet, tips off and its port', env.CW_USER_DATA === userData && env.CW_TEST_QUIET === '1' && env.CW_TEST_TIPS === 'off' && env.CW_API_PORT === lib.port(47929), JSON.stringify({ CW_USER_DATA: env.CW_USER_DATA, CW_TEST_QUIET: env.CW_TEST_QUIET, CW_TEST_TIPS: env.CW_TEST_TIPS, CW_API_PORT: env.CW_API_PORT }))
    check("…and its suite's trash folder, not the user's Recycle Bin (#414)", env.CW_TEST_TRASH_DIR === lib.TRASH, String(env.CW_TEST_TRASH_DIR))
    const homes = ctx.cliHomes()
    const given = Object.fromEntries(Object.keys(homes).map((k) => [k, env[k]]))
    check("…and the CLI homes (Claude Code's, Codex's, Copilot's, the GitHub CLI's config), empty folders of the suite's, not the user's (#382, #452)", Object.entries(homes).every(([k, v]) => env[k] === v && !ctx.isUserCliHome(env[k])), JSON.stringify(given))
    // Its git (#1466): the suite's global config, with the test identity and line endings, never the user's ~/.gitconfig,
    // and no system config: all its git reads is that file (`git config --list --show-scope`: global alone).
    const globalGit = await app.evaluate(() => {
      const { execFileSync } = process.mainModule.require('child_process')
      // In its profile, outside any repository, so no repository's config is listed.
      const read = (...a) => execFileSync('git', ['config', ...a], { cwd: process.env.CW_USER_DATA, encoding: 'utf8' }).trim()
      return { name: read('--global', 'user.name'), email: read('--global', 'user.email'), autocrlf: read('core.autocrlf'), scopes: [...new Set(read('--list', '--show-scope').split(/\r?\n/).map((l) => l.split('\t')[0]))] }
    })
    check("…and its git's config, the suite's with the test identity and autocrlf false, no system or user config (#1466)", env.GIT_CONFIG_GLOBAL === ctx.gitConfig() && env.GIT_CONFIG_NOSYSTEM === '1' && globalGit.autocrlf === 'false' && globalGit.scopes.join() === 'global' && globalGit.email === ctx.TEST_GIT_IDENTITY.email && globalGit.name === ctx.TEST_GIT_IDENTITY.name, JSON.stringify({ GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, ...globalGit }))
  } finally {
    await app.close().catch(() => undefined)
  }

  // Started any other way, a test Combwork is refused before it starts.
  const refused = async (env) => {
    try {
      const other = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, ...(env ? { env } : {}) })
      await other.close().catch(() => undefined)
      return false
    } catch (e) {
      return /lib\.hiveEnv/.test(e.message)
    }
  }
  check("a test Combwork started with the suite's own environment is refused", await refused(null))
  check('…or with a copy of a run-context environment', await refused({ ...lib.hiveEnv({ CW_USER_DATA: userData }) }))

  // A child that is part of Combwork (the hive MCP server, a bridge): the allowlist and what it is given.
  const child = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: lib.childEnv({ CW_API_URL: 'http://127.0.0.1:1' }) })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => resolve(JSON.parse(out || '{}')))
  })
  check("a child gets none of the suite's environment, and what it is given", !leaked(child).length && child.CW_API_URL === 'http://127.0.0.1:1', leaked(child).join(', '))

  // #202: the hive-progress wrapper, started by a suite while the suite runs inside an outer hive-progress
  // (CW_PROGRESS_WRAPPED above), reports its run rather than taking itself for nested.
  const calls = []
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`)
      res.setHeader('Content-Type', 'application/json')
      res.end(req.method === 'POST' && req.url === '/v1/progress' ? '{"id":"r1"}' : '{}')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const wrapped = await new Promise((resolve) => {
    const env = lib.childEnv({ ELECTRON_RUN_AS_NODE: '1', CW_PROGRESS_DATA: data, CW_API_URL: `http://127.0.0.1:${srv.address().port}`, CW_API_TOKEN_FILE: lib.tokenFile('agent-token') })
    const p = spawn(lib.ELECTRON, [path.join(lib.ROOT, 'out', 'main', 'cw-progress.js'), '--', 'node', '-e', "console.log('##hive-progress step=1 total=1 name=one')"], { env, cwd: lib.WORK })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out: out.replace(/\r/g, '') }))
  })
  srv.close()
  check("hive-progress started inside an outer one's environment reports its run (#202)", wrapped.code === 0 && calls.includes('POST /v1/progress') && !wrapped.out.includes('##hive-progress'), JSON.stringify({ ...wrapped, calls }))

  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
