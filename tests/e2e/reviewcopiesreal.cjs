// S51 (#1439, SPEC §16.10.5 Access), the real tier: a Claude Code, a Codex and a Copilot reviewer each build and run the
// project's test in a review copy, outside their own folder, within their permission mode. Each reviewer's launch is
// granted the project's copies folder (--add-dir, seen on its process's command line); its start review leases it a copy
// at the card's submitted revision; it is asked to write build.txt there and run `node test.js` there (which writes
// ran.txt beside itself). Passes when both are in the copy and nothing of theirs is in the project folder (what is there
// is named, with whose turn left it and its screen, #1546: a reviewer's shell starts in the project folder, and Haiku
// once ran `node test.js` there before running it in its copy). An edit there
// is never asked about (granted): a command may be (Claude Code's Accept edits and Copilot's ask before one), and is
// answered Yes, counted in the output. What each CLI's own home has afterwards never names the copies folder (Combwork
// passes it on the command line only).
// - Claude Code: Haiku, Accept edits, in the signed-in test home (CLAUDE_TEST_HOME: tokens).
// - Codex: gpt-6-luna at low effort, Ask (workspace-write), in the Codex test home (tokens).
// - Copilot: the real CLI offline against the stand-in model (fake-copilot-api.cjs: no sign-in, no cost), in Accept
//   edits; it also builds the cards (B1).
// A part whose CLI isn't installed or signed in is skipped and said (the run record says so).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync, spawnSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const { CLAUDE_TEST_HOME, CODEX_HOME } = require('./runContext.cjs')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// A real model's turn: building and running a test, under load.
const TURN_MS = 5 * 60000

const PORT = Number(lib.port(47803))
const at = (x) => path.join(lib.WORK, `reviewcopiesreal-${x}`)
const userData = at('profile')
const ws = at('ws')
const copilotDir = at('copilot')
const apiLog = at('copilot-api.jsonl')
const alpha = path.join(ws, 'alpha')
const copiesDir = path.join(`${ws}.worktrees`, 'alpha', 'copies')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 500)
const gitIn = (dir, ...a) => execFileSync('git', a, { cwd: dir, env: lib.gitEnv(), encoding: 'utf8' }).trim()

const claudeExe = (() => {
  const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8', env: lib.baseEnv() })
  return r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => /\.(exe|cmd)$/i.test(l.trim()))?.trim() ?? null : null
})()
const claudeSignedIn = (() => {
  if (!claudeExe) return false
  const s = spawnSync(claudeExe, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30000, env: lib.childEnv({ CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME }) })
  try {
    return JSON.parse(s.stdout).loggedIn !== false
  } catch {
    return false
  }
})()
const parts = {
  claude: claudeSignedIn ? null : `environment: Claude Code isn't installed or signed in to its test home ${CLAUDE_TEST_HOME}`,
  codex: lib.codexSignedIn() ? null : `environment: Codex isn't signed in to ${CODEX_HOME}`,
  copilot: copilotInstalled() ? null : "environment: the GitHub Copilot CLI isn't installed (copilot)"
}
if (parts.copilot) lib.skip(`${parts.copilot}: it builds the cards`)
if (parts.claude && parts.codex) lib.skip(`${parts.claude}; ${parts.codex}`)

/** An agent's Agent API token, from the file Combwork keeps for it (agentTokens.ts). */
const tokenOf = (projectPath, agentId) => {
  const h = createHash('sha256').update(`${projectPath.toLowerCase()}#${agentId}`).digest('hex').slice(0, 16)
  const f = path.join(userData, 'agent-api', `${h}.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).token : null
}

/** The command lines of the processes that name the copies folder (read only). */
const namingCopies = () => {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${copiesDir.toLowerCase().replace(/'/g, "''")}') } | ForEach-Object { $_.CommandLine }`
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: lib.baseEnv() }).split(/\r?\n/).filter(Boolean)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  lib.gitProject(alpha, { 'test.js': "require('fs').writeFileSync(require('path').join(__dirname, 'ran.txt'), 'ran in ' + __dirname)\n", '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  if (!parts.codex) lib.trustForCodex(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const api = await startFakeCopilotApi({ log: apiLog })
  const copilotEnv = copilotTestEnv(api, copilotDir, { above: lib.WORK })
  // Codex's sandbox can't start the Store's PowerShell 7 while another process of it runs (#499, #658): as the real
  // Codex suites do (#584), a PATH without the Store's aliases, so Codex runs commands in Windows PowerShell.
  copilotEnv.PATH = lib.pathWithoutStoreAliases({ PATH: copilotEnv.PATH })
  // Copilot asks whether to trust a new folder: the project folder is, as "Yes, and remember this folder" saves it.
  fs.writeFileSync(path.join(copilotDir, 'copilot-home', 'config.json'), JSON.stringify({ trustedFolders: [alpha] }, null, 2))
  // Each CLI's own settings (Claude Code's settings.json and .claude.json, Codex's config.toml, Copilot's config.json and
  // settings.json): not its records of what ran (Copilot's command-history-state.json holds the prompts, paths and all).
  const homeFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^(config|settings)\.(json|toml)$|^\.claude\.json$/i.test(f)).map((f) => path.join(dir, f)) : [])
  const homesBefore = new Map([...homeFiles(CLAUDE_TEST_HOME), ...homeFiles(CODEX_HOME), ...homeFiles(path.join(copilotDir, 'copilot-home'))].map((f) => [f, fs.readFileSync(f, 'utf8')]))

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE_TEST_HOME, CODEX_HOME, ...copilotEnv, CW_TEST_TIPS: 'off' }) })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'copilot')
    if (!parts.codex) await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project' } })
    await inv('project:updateConfig', alpha, { copies: { size: 3 } })
    // HI-2211: Combwork's reviewer pool gives each card in Review outside a lane to a free reviewer and types it in (HI-2046),
    // and a real CLI then reviews it on its own (RX approved its card before its start review here). The suite's steps are
    // each reviewer's, so the team is paused (HI-2081: nothing given out or told) before any agent starts: none is
    // running to be told of the pause, and the reviews and verdicts below are the agents' own calls, which it doesn't hold.
    const paused = await inv('team:pause')
    check('the team is paused before the agents start (the pool gives nothing out)', paused.failed.length === 0 && paused.done.length === 1, JSON.stringify(paused))
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', provider: 'copilot', workflowRole: 'builder', permissionMode: 'accept-edits' })
    const reviewers = [
      ...(parts.claude ? [] : [{ key: 'claude', def: await lib.addAgent(inv, alpha, { name: 'RC', provider: 'claude-code', model: 'haiku', permissionMode: 'acceptEdits', workflowRole: 'reviewer' }) }]),
      ...(parts.codex ? [] : [{ key: 'codex', def: await lib.addAgent(inv, alpha, { name: 'RX', provider: 'codex', model: 'gpt-6-luna', effort: 'low', permissionMode: 'ask', workflowRole: 'reviewer' }) }]),
      { key: 'copilot', def: await lib.addAgent(inv, alpha, { name: 'RP', provider: 'copilot', permissionMode: 'accept-edits', workflowRole: 'reviewer' }) }
    ]
    for (const [k, why] of Object.entries(parts)) if (why && k !== 'copilot') console.log(`SKIP the ${k} reviewer: ${why}`)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const started = async (a) => {
      await inv('session:start', alpha, { agentId: a.def?.id ?? a.id })
      const id = a.def?.id ?? a.id
      if (a.key === 'claude') await lib.acceptClaudeTrust(inv, alpha, id, HUNG_MS)
      return !!(await until(async () => ['ready', 'finished'].includes((await live(id))?.status) && !!tokenOf(alpha, id), HUNG_MS))
    }
    check('B1 (Copilot, offline) starts', await started({ id: b1.id }))
    for (const r of reviewers) check(`${r.def.name} (${r.key}) starts`, await started(r))

    // --- Each reviewer's process is given the copies folder; the builder's isn't.
    const lines = await until(() => {
      const l = namingCopies()
      return l.filter((x) => /--add-dir/.test(x)).length >= reviewers.length ? l : null
    }, HUNG_MS)
    check('each reviewer runs with --add-dir the copies folder', !!lines && lines.filter((x) => /--add-dir/.test(x)).length >= reviewers.length, JSON.stringify(lines))

    // --- B1 builds a card for each reviewer.
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const tb1 = tokenOf(alpha, b1.id)
    for (const [i, r] of reviewers.entries()) {
      const n = (await inv('tasks:create', { title: `S51 ${r.key}`, project: 'alpha' })).number
      const key = (await card(n)).key
      const s = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start`)
      fs.writeFileSync(path.join(alpha, `card-${i}.txt`), `${r.key}\n`)
      gitIn(alpha, 'add', '-A')
      gitIn(alpha, 'commit', '-qm', `card ${n}`, '-m', `Hive-Card: ${key}`)
      r.card = n
      r.revision = gitIn(alpha, 'rev-parse', 'HEAD')
      const sub = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: `Card ${n} done.`, revision: r.revision })
      check(`B1 builds and submits ${key} for ${r.def.name}`, s.status === 200 && sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ s: s.body, sub: sub.body }))
    }

    // What a turn left in the project folder (#1546): each file with its text (ran.txt says where test.js ran) and the end
    // of that agent's screen, taken away so the next reviewer's are its own.
    const strays = []
    const strayIn = async (who, key) => {
      const found = ['build.txt', 'ran.txt'].filter((f) => fs.existsSync(path.join(alpha, f)))
      if (!found.length) return
      const screen = key ? lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '').slice(-600) : ''
      for (const f of found) {
        strays.push(`${who}: ${f} ("${fs.readFileSync(path.join(alpha, f), 'utf8').trim().slice(0, 200)}")${screen ? `; its screen ends: ${screen}` : ''}`)
        fs.rmSync(path.join(alpha, f))
      }
    }
    await strayIn('the builder, before the reviews')

    // --- Each reviewer: start review leases its copy; it builds and runs the test there.
    for (const r of reviewers) {
      const tr = tokenOf(alpha, r.def.id)
      const sr = await call(tr, 'PATCH', `/v1/tasks/${r.card}`, { review: 'start', reply: 'short' })
      const said = (sr.body?.changes ?? []).find((x) => x.startsWith('Review in ')) ?? ''
      const folder = /^Review in (.+) at [0-9a-f]+:/.exec(said)?.[1]
      const ok = sr.status === 200 && !!folder && path.dirname(folder).toLowerCase() === copiesDir.toLowerCase()
      check(`${r.def.name}'s start review leases a copy`, ok, JSON.stringify(sr.body))
      if (!ok) continue
      check(`…at its card's revision`, gitIn(folder, 'rev-parse', 'HEAD') === r.revision)
      const key = lib.ptyKey(alpha, r.def.id)
      const built = path.join(folder, 'build.txt')
      const ran = path.join(folder, 'ran.txt')
      const prompt =
        r.key === 'copilot'
          ? `write ${built} built then shell Set-Location '${folder}'; node test.js then say done`
          : `Work only in the folder ${folder} (outside your own; you may use it). First create the file build.txt there containing the word built, with your file tools. Then run "node test.js" with that folder as the working directory. Reply done.`
      // Its turn waits on the real CLI answering: an environment failure in its session meanwhile is a SKIP (lib.cliStep).
      let asked = 0
      let askedBeforeEdit = false
      await lib.cliStep(`${r.def.name}'s turn in its review copy`, { session: key }, async () => {
      const sent = await lib.sendPrompt(inv, key, prompt, { submitted: async () => (await live(r.def.id))?.status === 'working' || fs.existsSync(built), waitMs: HUNG_MS })
      check(`…${r.def.name} takes the prompt`, sent > 0)
      // Edits there are never asked about (granted); a command may be, and is answered Yes.
      const done = await until(async () => {
        const s = await live(r.def.id)
        if (s?.status === 'waiting') {
          if (!fs.existsSync(built)) askedBeforeEdit = true
          asked++
          await inv('pty:write', key, '\r')
          await lib.until(async () => (await live(r.def.id))?.status !== 'waiting', 15000, 500)
        }
        return fs.existsSync(built) && fs.existsSync(ran) && ['ready', 'finished', 'waiting'].includes(s?.status) ? true : null
      }, TURN_MS)
      console.log(`INFO ${r.def.name}: questions answered Yes: ${asked}${askedBeforeEdit ? ' (one before its edit)' : ''}`)
      const screen = done ? '' : lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '').slice(-1500)
      check(`…${r.def.name} built (build.txt) and ran the test (ran.txt) in its copy`, !!done && /built/.test(fs.readFileSync(built, 'utf8')) && fs.readFileSync(ran, 'utf8').toLowerCase().includes(folder.toLowerCase()), screen)
      })
      if (r.key === 'copilot') check('…its edit there asked nothing (Accept edits: granted)', !askedBeforeEdit)
      const v = await call(tr, 'PATCH', `/v1/tasks/${r.card}`, { review: 'failed', comment: 'S51: built and tested in the review copy.', reply: 'short' })
      check(`…its verdict`, v.status === 200, JSON.stringify(v.body))
      await strayIn(r.def.name, key)
    }
    check('nothing of theirs is in the project folder', !strays.length, strays.join(' | '))
    // The copies folder as a file may write it: plain, JSON-escaped or with forward slashes.
    const forms = [copiesDir, JSON.stringify(copiesDir).slice(1, -1), copiesDir.replace(/\\/g, '/')].map((x) => x.toLowerCase())
    const names = (f) => forms.some((x) => fs.readFileSync(f, 'utf8').toLowerCase().includes(x))
    const changed = [...homesBefore].filter(([f, before]) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') !== before && names(f))
    const added = [...homeFiles(CLAUDE_TEST_HOME), ...homeFiles(CODEX_HOME), ...homeFiles(path.join(copilotDir, 'copilot-home'))].filter((f) => !homesBefore.has(f) && names(f))
    check("no CLI's own settings name the copies folder", !changed.length && !added.length, JSON.stringify({ changed: changed.map(([f]) => f), added }))
  } catch (e) {
    check('no unexpected error', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
    await api.close?.()
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
