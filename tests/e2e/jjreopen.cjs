// A jj card's reconciliation after a restart (HI-2914): the real app, the pinned jj (npm run jj:fetch) on its PATH, a fake
// Claude Code builder (B1), a throwaway profile and workspace, a colocated repository.
// - the user starts a card for B1 in a slot; Combwork quits with it in Doing and opens again on the same profile;
// - B1 commits there with jj and submits; the user passes it (you review, you integrate into main);
// - the user's own commit on main, the bookmark moved onto it (a jj operation, not integrating the card): its new
//   containment observation ("not in main yet") is written within seconds, by the operation alone. The record is read
//   from the board, never through Waiting's own read (which asks for a run itself), so only the operation can have asked;
// - with the record gone, Waiting read every 200 ms (jjlane's poll) shows the observation within seconds: the cause of
//   HI-2914's minute, each read restarting the reconciler's debounce so no run started while the reads went on.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DatabaseSync } = require('node:sqlite')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// The repository watch's own re-arm and rescan run each minute: an observation written well before it came from the
// operation (or the reopen), not from that timer.
const PROMPT_MS = 20000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjreopen: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const SUITE = 'jjreopen'
const PORT = Number(lib.port(47718))
const work = path.join(lib.WORK, SUITE)
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
const claudeHome = path.join(work, 'claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const lines = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

// jj's and git's config for the fixture and the app alike: no user's, no system's, no autocrlf.
const home = path.join(work, 'home')
const jjConfig = path.join(home, 'jj.toml')
const gitConfig = path.join(home, 'gitconfig')
const toolEnv = () => ({ ...lib.gitEnv({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: home, JJ_CONFIG: jjConfig, NO_COLOR: '1' }) })
const jj = (cwd, ...args) => execFileSync(exe, args, { cwd, env: toolEnv(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const dbFile = path.join(ws, '.combwork', 'combwork.db')
const onDb = (fn) => {
  const db = new DatabaseSync(dbFile, { timeout: 5000 })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(jjConfig, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  fs.writeFileSync(gitConfig, `[user]\n\tname = ${lib.TEST_GIT_IDENTITY.name}\n\temail = ${lib.TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`)
  fs.mkdirSync(shop, { recursive: true })
  fs.writeFileSync(path.join(shop, '.gitignore'), '.combwork/\n')
  jj(shop, 'git', 'init', '--colocate')
  fs.writeFileSync(path.join(shop, 'base.txt'), 'base\n')
  jj(shop, 'commit', '-m', 'base')
  jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
  fs.mkdirSync(path.join(shop, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(shop, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], platform: 'jj', workflow: { platform: 'jj', preset: 'solo', options: { target: 'main' }, presetAsked: 'chosen' } }))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), shop.toLowerCase(), path.join(ws, '..').toLowerCase()]))
  lib.enableProviders(userData, ['claude-code'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = { ...toolEnv(), PATH: `${jjDir()};${lib.baseEnv().PATH ?? ''}`, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' }
  delete env.CW_USER_DATA
  let h = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  const logFrom = () => lib.combworkLogLines(userData).length
  try {
    const watch = () => h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    watch()
    const inv = (...a) => h.inv(...a)
    await lib.openWorkspace(inv, h.page, ws)
    // You review (so an approval waits for your integration), each card in a slot, you integrate into main.
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates', target: 'main' } })
    check('shop: you review, cards in slots, you integrate into main', !!opts && !opts.error, JSON.stringify(opts))
    const b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder' })
    const live = async (aid) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === shop.toLowerCase() && s.agentId === aid)
    const ready = (aid) =>
      until(async () => {
        const s = await live(aid)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(shop, aid), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    const tokenOf = async (aid) => {
      const launch = await until(async () => {
        const sessionId = (await live(aid))?.sessionId
        return sessionId ? lines(path.join(claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === sessionId && l.opts['--mcp-config']) : null
      }, HUNG_MS)
      if (!launch) throw new Error(`no launch of ${aid}`)
      const server = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork
      return JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    const startCard = async (title, b) => {
      const n = (await inv('tasks:create', { title, project: 'shop', agent: b.id })).number
      const key = (await card(n)).key
      const started = await inv('tasks:move', n, 'doing', { confirm: true, reason: 'jjreopen: start' }).catch((e) => ({ error: String(e) }))
      const w = await until(async () => {
        const v = await inv('tasks:work', n)
        return v?.folder && v.workspace ? v : null
      }, HUNG_MS)
      check(`${key} starts in a jj slot, ${b.name} there`, !!w && !!(await ready(b.id)), JSON.stringify({ started, w }))
      if (!w) throw new Error('no slot')
      return { n, key, w }
    }
    /** Its builder commits `file` in its slot and submits; the user passes it. */
    const buildAndPass = async (n, key, folder, file, b) => {
      await ready(b.id)
      fs.writeFileSync(path.join(folder, file), `${file}\n`)
      jj(folder, 'commit', '-m', `${key}: ${file}`)
      const sub = await call(await tokenOf(b.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
      check(`${key}: ${b.name} submits it, in Review`, sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ sub: sub.body, card: (await card(n))?.column }))
      const passed = await inv('tasks:move', n, 'passed', { confirm: true, reason: 'jjreopen: passed' }).catch((e) => ({ error: String(e) }))
      check(`${key}: you pass it, waiting for your integration`, !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), JSON.stringify({ passed, column: (await card(n))?.column }))
    }

    // --- The user starts a jj card for B1: a slot of its own, B1 started there.
    const { n, key, w: w1 } = await startCard('Shop work', b1)

    // --- Combwork quits with the card in Doing and opens again on the same profile.
    await h.app.close()
    h = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
    watch()
    const since = logFrom()
    await lib.openWorkspace(inv, h.page, ws)
    check('after a restart: still in Doing', (await card(n))?.column === 'doing', (await card(n))?.column)
    const back = await until(async () => !!(await live(b1.id)) || (await inv('session:start', shop, { agentId: b1.id }).then(() => true, () => false)), HUNG_MS)
    check('after the restart: B1 running again', !!back, JSON.stringify(await live(b1.id)))

    // --- B1 commits in its slot and submits; the user passes it.
    await buildAndPass(n, key, w1.folder, 'shop.txt', b1)

    // --- The user's own commit on main, the bookmark moved onto it: a jj operation that doesn't integrate the card. Its
    // observation is newer than any before the move (the generation), and written by the run the operation asked for.
    const pid = JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).id
    const ckey = `jj_contained:${pid.toLowerCase()}:${key.toLowerCase()}:1`
    const record = () => onDb((db) => {
      const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(ckey)
      return r ? JSON.parse(r.value) : null
    })
    // Any observation the pass itself asked for is written first (so the one after the move is the move's).
    await until(async () => (await card(n))?.column === 'passed' && !!record(), 5000)
    const before = record()?.gen ?? 0
    jj(shop, 'new', 'main', '-m', 'the user moves on')
    fs.writeFileSync(path.join(shop, 'user.txt'), 'the user\n')
    jj(shop, 'commit', '-m', 'the user moves on')
    const t0 = Date.now()
    jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
    const seen = await until(() => {
      const r = record()
      return r && r.gen > before && r.state === 'notYet' ? r : null
    }, HUNG_MS)
    const took = Date.now() - t0
    check(`after the restart, the move on main is observed within seconds: not in main yet (${took} ms)`, !!seen && took < PROMPT_MS, JSON.stringify({ before, record: record(), took, log: lib.combworkLogLines(userData).slice(since).filter((l) => /workflow|reconcil|jj/i.test(l)).slice(-40) }))
    const waiting = ((await inv('jj:waiting', shop)) ?? []).find((x) => x.card === n)
    check('…Waiting shows it', waiting?.contained?.state === 'notYet', JSON.stringify(waiting))

    // --- Waiting read over and over (jjlane's poll, every 200 ms) while the card has no observation: each read asks for a
    // run, and the asks never put it off (HI-2914: each one restarted the debounce, so none ran while the reads went on).
    onDb((db) => db.prepare('DELETE FROM board_meta WHERE key = ?').run(ckey))
    const t1 = Date.now()
    const shown = await until(async () => {
      const x = ((await inv('jj:waiting', shop)) ?? []).find((r) => r.card === n)
      return x?.contained?.state === 'notYet' ? x : null
    }, HUNG_MS)
    const took1 = Date.now() - t1
    check(`Waiting read every 200 ms: the observation is shown within seconds all the same (${took1} ms)`, !!shown && took1 < PROMPT_MS, JSON.stringify({ took1, waiting: await inv('jj:waiting', shop) }))
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
