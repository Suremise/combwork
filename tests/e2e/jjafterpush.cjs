// A jj card started right after another's integration (HI-2916, shape 3): the real app, the pinned jj (npm run jj:fetch)
// on its PATH, fake Claude Code builders (B1, B2), a throwaway profile and workspace, a colocated repository with a
// remote.
// - card 1 built by B1, passed by the user and integrated (main moved onto it, pushed): Done;
// - card 2 started for B2 at once by the user (a drag into Doing), beside Combwork's own jj operations after card 1's
//   Done (its slot detached, another made): started first time, in a slot within a minute;
// - B1 stopped, and card 3 started for B1 at once (HI-2919, HI-2916's shapes 1 and 2): card 3 in a slot within a minute,
//   and card 1's slot back within jjwindow's bound (ready, or lent to a card; never `lent` with no lease, HI-2912's, or
//   held by a carried lease, HI-2920's).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjafterpush: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const SUITE = 'jjafterpush'
const PORT = Number(lib.port(47719))
const work = path.join(lib.WORK, SUITE)
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
const remote = path.join(work, 'remote.git')
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
  lib.git(work, ['init', '--bare', '-q', remote])
  jj(shop, 'git', 'remote', 'add', 'origin', remote)
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
  try {
    const watch = () => h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    watch()
    const inv = (...a) => h.inv(...a)
    await lib.openWorkspace(inv, h.page, ws)
    // You review (so an approval waits for your integration), each card in a slot, you integrate into main.
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates', target: 'main' } })
    check('shop: you review, cards in slots, you integrate into main', !!opts && !opts.error, JSON.stringify(opts))
    const b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder' })
    const b2 = await lib.addAgent(inv, shop, { name: 'B2', workflowRole: 'builder' })
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
      const started = await inv('tasks:move', n, 'doing', { confirm: true, reason: 'jjafterpush: start' }).catch((e) => ({ error: String(e) }))
      const w = await until(async () => {
        const v = await inv('tasks:work', n)
        return v?.folder && v.workspace ? v : null
      }, HUNG_MS)
      check(`${key} starts in a jj slot, ${b.name} there`, !!w && !!(await ready(b.id)), JSON.stringify({ started: started?.moved?.column ?? started, w, work: w ? null : await inv('tasks:work', n), slots: await inv('slots:list', shop), log: w ? [] : lib.combworkLogLines(userData).filter((l) => /\[slots\]|\[folders\]|\[workflow\]|lease/.test(l)).slice(-40) }, null, 1))
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
      const passed = await inv('tasks:move', n, 'passed', { confirm: true, reason: 'jjafterpush: passed' }).catch((e) => ({ error: String(e) }))
      check(`${key}: you pass it, waiting for your integration`, !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), JSON.stringify({ passed, column: (await card(n))?.column }))
    }

    // --- Card 1: built by B1, passed, integrated by the user (main moved onto it, pushed): Done.
    const c1 = await startCard('Card one', b1)
    await buildAndPass(c1.n, c1.key, c1.w.folder, 'one.txt', b1)
    const R1 = jj(c1.w.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
    jj(shop, 'bookmark', 'set', 'main', '-r', R1)
    jj(shop, 'git', 'push', '--bookmark', 'main')
    check(`${c1.key}: the user moves main onto it and pushes: Done`, !!(await until(async () => (await card(c1.n))?.column === 'done', HUNG_MS)), (await card(c1.n))?.column)
    // --- Card 2 for B2 at once, beside Combwork's own jj operations after card 1's Done (its slot detached, B2's made):
    // started first time. Before HI-2916 it was refused about half the time under load: `platform.unknown` (the target's
    // read moved under it) or `evidence.changed` (the operation head moved again in the start's one gather-again pass).
    const n2 = (await inv('tasks:create', { title: 'Card two', project: 'shop', agent: b2.id })).number
    const started2 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjafterpush: start' }).catch((e) => ({ error: String(e) }))
    check('card 2 starts at once after the push: not refused', !started2?.refused && !started2?.error, JSON.stringify({ started2, log: lib.combworkLogLines(userData).filter((l) => / not started: /.test(l)).slice(-5) }))
    const t2 = Date.now()
    const w2 = await until(async () => {
      const v = await inv('tasks:work', n2)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    // A slot of its own, or card 1's once that one is back in the pool: either is the pool's to pick.
    check(`…in a slot within a minute (${Date.now() - t2} ms)`, !!w2, JSON.stringify({ w2, work: await inv('tasks:work', n2), slots: await inv('slots:list', shop), log: lib.combworkLogLines(userData).filter((l) => /\[slots\]|\[folders\]|lease|#2\b/.test(l)).slice(-40) }, null, 1))

    // --- HI-2919 (HI-2916's shapes 1 and 2), after HI-2912's fix: B1 stopped, and card 3 started for B1 at once.
    // Shape 2: card 3 gets a slot within a minute. Shape 1: card 1's slot, its builder gone, is back within jjwindow's
    // bound: ready, or lent to a card; never left `lent` with no lease (the settle held off, HI-2912's) or held by a
    // carried lease (HI-2920's).
    await inv('session:stop', shop, b1.id)
    check('B1 stopped', !!(await until(async () => !(await live(b1.id)) || (await live(b1.id))?.status === 'exited', HUNG_MS)), JSON.stringify(await live(b1.id)))
    const t3 = Date.now()
    const n3 = (await inv('tasks:create', { title: 'Card three', project: 'shop', agent: b1.id })).number
    const slot1 = path.basename(c1.w.folder)
    const back = (s) => !!s && (s.state === 'ready' || (s.state === 'lent' && !!s.lease && s.lease.kind !== 'carried' && (s.lease.card !== null || !!s.lease.lane)))
    // At once and side by side: card 1's slot watched for its return, and card 3 started as the window starts it, with
    // no override. While no slot is free the window asks (`start.slotAvailable`, "waits for a slot") and the user waits
    // (a confirmed drag would start it in the project folder, SPEC's "a user's start across it works where the agent
    // is"), so it is asked again until it starts. jjwindow's bound for the slot: the settle's retries pause up to 30 s.
    let started3 = null
    const [slot1At, started3At] = await Promise.all([
      until(async () => back((await inv('slots:list', shop)).find((s) => s.name === slot1)), HUNG_MS * 2).then((ok) => (ok ? Date.now() - t3 : null)),
      until(async () => {
        started3 = await inv('tasks:move', n3, 'doing', { reason: 'jjafterpush: start after the builder stopped' }).catch((e) => ({ error: String(e) }))
        return !!started3 && !started3.ask && !started3.refused && !started3.error
      }, HUNG_MS).then((ok) => (ok ? Date.now() - t3 : null))
    ])
    const s1 = (await inv('slots:list', shop)).find((s) => s.name === slot1)
    check(`card 1's slot back after its builder left, within jjwindow's bound (${slot1At} ms)`, slot1At !== null, JSON.stringify({ slot: s1, why: !s1 ? 'gone' : s1.lease?.kind === 'carried' ? 'carried lease (HI-2920)' : s1.state === 'lent' && !s1.lease ? 'lent with no lease (HI-2912)' : s1.state }))
    check(`card 3 for B1, asked right after B1 stopped: started within a minute (${started3At} ms)`, started3At !== null, JSON.stringify({ started3, slots: await inv('slots:list', shop) }))
    const w3 = await until(async () => {
      const v = await inv('tasks:work', n3)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check(`…in a slot (${Date.now() - t3} ms after B1 stopped)`, !!w3 && w3.folder !== 'project', JSON.stringify({ w3, work: await inv('tasks:work', n3), slots: await inv('slots:list', shop), log: lib.combworkLogLines(userData).filter((l) => /\[slots\]|\[folders\]|lease|#3\b/.test(l)).slice(-40) }, null, 1))
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
