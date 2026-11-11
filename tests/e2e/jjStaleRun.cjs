// A jj lane's slot through the user's integrations (HI-2913): the real app, the pinned jj (npm run jj:fetch) on its PATH,
// a fake Claude Code builder (B1) and reviewer (R1), a throwaway profile and workspace. Colocated here; `jjstalenc` runs
// the same steps on a repository not colocated with Git (CW_JJSTALE_NONCOLOCATED=1).
// - card 1: built and reviewed; the user integrates it with exactly the commands Waiting for you to integrate shows
//   (`jj duplicate … --onto main`, then `jj bookmark set main -r <the copy>`): Done (its change found applied again), and
//   the lane's slot isn't stale;
// - card 2: B1, idle in the slot between cards, ended by Combwork so the slot can be prepared (jj's record needs it
//   quiet), and its conversation resumed there with the card, given once; built and reviewed; the user integrates it
//   with a rebase instead (`jj rebase -r`), which rewrites the slot's working copy: Done, the slot stale;
// - card 3: its preparation refused as a stale slot (jj's words, not git's), its Work section saying it hasn't started
//   there yet; the user's Recover… refused while B1 runs there, then, B1 stopped, let through for the lane's slot; the card
//   prepared there and B1 given it; built, reviewed and integrated as Waiting shows: Done;
// - cleanup: the lane ended. (Its slot's return to the pool after a released lease is HI-2916's: not checked here.)
// Screenshots of Waiting's commands, the not-ready Work section and the refused and done recoveries, both themes.
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjstale: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const NC = process.env.CW_JJSTALE_NONCOLOCATED === '1'
const SUITE = NC ? 'jjstalenc' : 'jjstale'
// Each mode's default, clear of the e2e lanes' ports (a runner gives its own: CW_E2E_PORT).
const PORT = Number(NC ? lib.port(47717) : lib.port(47716))
const work = path.join(lib.WORK, SUITE)
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
const claudeHome = path.join(work, 'claude-home')
const shots = lib.WORK
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
const id = (cwd, rev, t = 'commit_id') => jj(cwd, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', t).trim()

/** How often the app's log says it gave B1 card n in its slot (placement, after the slot's preparation). */
function givings(n) {
  const log = path.join(userData, 'logs', 'combwork.log')
  const re = new RegExp(`\\[slots\\] Giving \\S{0,1}B1\\S{0,1} #${n} in `)
  return (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split(/\r?\n/).filter((l) => re.test(l)).length
}

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(jjConfig, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  fs.writeFileSync(gitConfig, `[user]\n\tname = ${lib.TEST_GIT_IDENTITY.name}\n\temail = ${lib.TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`)
  fs.mkdirSync(shop, { recursive: true })
  fs.writeFileSync(path.join(shop, '.gitignore'), '.combwork/\n')
  jj(shop, 'git', 'init', NC ? '--no-colocate' : '--colocate')
  fs.writeFileSync(path.join(shop, 'base.txt'), 'base\n')
  jj(shop, 'commit', '-m', 'base')
  jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
  fs.mkdirSync(path.join(shop, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(shop, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], platform: 'jj', workflow: { platform: 'jj', preset: 'pair', options: { target: 'main' }, presetAsked: 'chosen' } }))
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
  const h = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  const page = h.page
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (...a) => h.inv(...a)
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    await lib.openWorkspace(inv, page, ws)
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'slots', finish: 'userIntegrates', target: 'main' } })
    check('shop: a reviewer agent, cards in slots, you integrate into main', !!opts && !opts.error, JSON.stringify(opts))
    const b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, shop, { name: 'R1', workflowRole: 'reviewer' })
    const live = async (aid) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === shop.toLowerCase() && s.agentId === aid)
    const running = async (aid) => {
      const s = await live(aid)
      return !!s && s.status !== 'exited'
    }
    const ready = (aid) =>
      until(async () => {
        const s = await live(aid)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(shop, aid), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    const launches = () => lines(path.join(claudeHome, 'fake-launches.jsonl'))
    const tokenOf = async (aid) => {
      const launch = await until(async () => {
        const sessionId = (await live(aid))?.sessionId
        return sessionId ? launches().findLast((l) => l.sessionId === sessionId && l.opts['--mcp-config']) : null
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
    const column = async (n) => (await card(n))?.column
    const workOf = (n) => until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    const integrationOf = async (n) => (await inv('tasks:work', n))?.integration ?? null
    const reviewLease = async (n) => ((await inv('copies:list', shop)) ?? []).find((c) => c.state === 'leased' && c.lease?.kind === 'review' && c.lease.card === n && !c.lease.returned)
    const slotRow = async (name) => ((await inv('slots:list', shop)) ?? []).find((s) => s.name === name)
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    const toProject = async () => {
      if (await page.locator('.board').isVisible()) await page.locator('.activity-btn').first().click()
      await page.locator('text="shop" >> visible=true').first().click()
      await vcTab.first().click()
    }
    const section = async (name) => {
      await page.locator(`.git-sections [data-section="${name}"]`).click()
      return page.locator(`[data-jj-section="${name.replace(/^jj/, '').toLowerCase()}"]`)
    }

    /** B1 records its work with jj in its slot and submits it (proof its slot was prepared for the card); R1 passes it. */
    const buildAndReview = async (n, key, folder, file, label) => {
      // Given to B1 in its slot first (placement comes after the slot's preparation): only then is its work the card's.
      check(`${label}: given to B1 in its prepared slot`, !!(await until(() => givings(n) >= 1, HUNG_MS * 2)), String(givings(n)))
      await ready(b1.id)
      fs.writeFileSync(path.join(folder, file), `${label}\n`)
      jj(folder, 'commit', '-m', `${key}: ${label}`)
      const R = id(folder, `${(await inv('tasks:work', n)).workspace}@-`)
      const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
      check(`${label}: B1 submits it from its prepared slot, in Review`, sub.status === 200 && !!(await until(async () => (await column(n)) === 'review', HUNG_MS)), JSON.stringify({ sub: sub.body, column: await column(n) }))
      await ready(r1.id)
      const rv = await call(await tokenOf(r1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/start-review`, {})
      check(`${label}: R1 reviews it in a review copy`, rv.status === 200 && !!(await until(() => reviewLease(n), HUNG_MS)), JSON.stringify(rv.body))
      const pass = await call(await tokenOf(r1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/verdict`, { pass: true, comment: 'Good.' })
      check(`${label}: R1 passes it, waiting for your integration`, pass.status === 200 && !!(await until(async () => (await column(n)) === 'passed', HUNG_MS)), JSON.stringify({ pass: pass.body, column: await column(n) }))
      return R
    }
    /** The user's own commit on main meanwhile, so an integration makes a new commit (a copy or a rebase, as a lane's would). */
    const userMovesMain = (label) => {
      jj(shop, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', label)
      jj(shop, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', `main+ & description(exact:${JSON.stringify(label + '\n')})`)
    }
    /** The commands Waiting for you to integrate shows for card n, as the window shows them. */
    const shownCommands = async (n, shot) => {
      await toProject()
      const repo = await section('jjRepo')
      const row = repo.locator(`[data-jj-integrate-card="${n}"]`)
      const got = await until(async () => {
        await repo.locator('[data-action="jj-refresh"]').first().click().catch(() => undefined)
        const cmds = await row.locator('[data-jj-command]').allInnerTexts().catch(() => [])
        return cmds.length === 2 ? cmds.map((c) => c.trim()) : null
      }, HUNG_MS)
      if (shot && got) await shoot(row, shot)
      return got ?? []
    }
    /** Runs a command as Waiting shows it, in the project folder (`<copy>` given): jj's output. */
    const runShown = (cmd, copy) => {
      const words = cmd.replace('<copy>', copy ?? '<copy>').split(/\s+/)
      if (words[0] !== 'jj') throw new Error(`not a jj command: ${cmd}`)
      return jj(shop, ...words.slice(1))
    }
    /** Card n integrated exactly as Waiting shows: its copy onto main, then main moved to it. */
    const integrateAsShown = async (n, key, label, R, shot) => {
      const cmds = await shownCommands(n, shot)
      check(`${label}: Waiting shows a copy onto main, then the bookmark (not a rebase)`, cmds.length === 2 && cmds[0] === `jj duplicate -r ${R} --onto main` && cmds[1] === 'jj bookmark set main -r <copy>', JSON.stringify(cmds))
      runShown(cmds[0])
      const copy = id(shop, `main+ & description(exact:${JSON.stringify(`${key}: ${label}\n`)}) & ~${R}`)
      runShown(cmds[1], copy)
      check(`${label}: integrated as shown: Done`, !!(await until(async () => (await column(n)) === 'done', HUNG_MS)), await column(n))
      check(`${label}: …its change found applied again`, (await integrationOf(n))?.via === 'replay', JSON.stringify(await integrationOf(n)))
    }

    // --- The lane: three cards for B1 and R1.
    const n1 = (await inv('tasks:create', { title: 'Card one', project: 'shop' })).number
    const n2 = (await inv('tasks:create', { title: 'Card two', project: 'shop' })).number
    const n3 = (await inv('tasks:create', { title: 'Card three', project: 'shop' })).number
    const [k1, k2, k3] = [(await card(n1)).key, (await card(n2)).key, (await card(n3)).key]
    const lane = await inv('lanes:start', shop, { builder: b1.id, reviewer: r1.id, cards: [n1, n2, n3] }).catch((e) => ({ error: String(e) }))
    const w1 = await workOf(n1)
    check('the lane starts: card 1 in a jj slot', !!w1, JSON.stringify({ lane, w1 }))
    if (!w1) throw new Error('card 1 never started')
    const slotFolder = w1.folder
    const slotName = path.basename(slotFolder)

    // --- Card 1, integrated as Waiting shows: the slot untouched.
    const R1 = await buildAndReview(n1, k1, slotFolder, 'one.txt', 'card 1')
    const b1Session = (await live(b1.id))?.sessionId
    userMovesMain('the user moves on')
    await integrateAsShown(n1, k1, 'card 1', R1, 'waiting-commands')
    // Launches from here on are card 2's (a restart of B1 for a changed tool list came earlier).
    const launchesBefore2 = launches().length
    check("card 1: the lane's slot isn't stale", (await slotRow(slotName))?.stale !== true && jj(slotFolder, '--ignore-working-copy', 'workspace', 'list').length > 0, JSON.stringify(await slotRow(slotName)))

    // --- Card 2 in the same slot: B1 ended by Combwork, then resumed there with the card, once.
    const w2 = await workOf(n2)
    check('card 2 starts in the same slot', !!w2 && w2.folder.toLowerCase() === slotFolder.toLowerCase(), JSON.stringify(w2))
    const resumed = await until(() => launches().slice(launchesBefore2).find((l) => l.opts['--resume'] === b1Session && l.cwd.toLowerCase() === slotFolder.toLowerCase()), HUNG_MS * 2)
    check("card 2: B1's conversation resumed in the slot (Combwork ended its idle run so jj could prepare the slot)", !!resumed, JSON.stringify(launches().map((l) => ({ cwd: l.cwd, resume: l.opts['--resume'] ?? null }))))
    const R2 = await buildAndReview(n2, k2, slotFolder, 'two.txt', 'card 2')
    const appLog0 = path.join(userData, 'logs', 'combwork.log')
    check("card 2: B1's idle run ended by Combwork for the slot's preparation", (fs.existsSync(appLog0) ? fs.readFileSync(appLog0, 'utf8') : '').includes('so its slot can be prepared for the next jj card'))
    check('card 2: given to B1 once', givings(n2) === 1, String(givings(n2)))
    check('card 2: its Work section shows it started there (no not-ready note)', !(await inv('tasks:work', n2))?.notReady, JSON.stringify((await inv('tasks:work', n2))?.notReady))

    // --- Card 2 integrated with a rebase instead: the slot's working copy rewritten, the slot stale.
    userMovesMain('the user again')
    jj(shop, '--ignore-working-copy', 'rebase', '-r', R2, '-d', 'main')
    jj(shop, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', `main+ & description(exact:${JSON.stringify(`${k2}: card 2\n`)})`)
    check('card 2: integrated with a rebase: Done', !!(await until(async () => (await column(n2)) === 'done', HUNG_MS)), await column(n2))
    check('card 2: …the slot is stale', !!(await until(async () => (await slotRow(slotName))?.stale === true, HUNG_MS)), JSON.stringify(await slotRow(slotName)))

    // --- Card 3: its preparation refused as a stale slot; its Work section says not started there.
    const notReady = await until(async () => {
      const v = await inv('tasks:work', n3)
      return v?.notReady?.stale ? v.notReady : null
    }, HUNG_MS * 2)
    check('card 3: not ready in the stale slot, and said so', !!notReady && notReady.slot === slotName && /is stale/.test(notReady.why), JSON.stringify(await inv('tasks:work', n3)))
    const appLog = path.join(userData, 'logs', 'combwork.log')
    const refusal = (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '').split(/\r?\n/).filter((l) => l.includes(`couldn't be prepared for #${n3}`))
    check("card 3: the refusal is jj's (stale), not git's", refusal.length > 0 && refusal.every((l) => /is stale/.test(l) && !/git couldn't read/.test(l)), refusal.join(' | '))
    await showBoard(page)
    await openByTitle(page, n3)
    const note = page.locator('.card-work [data-work-not-ready="stale"]')
    check("card 3's Work section: not started in the slot yet, with Recover…", !!(await until(async () => /Not started in/.test(await text(note)) && /Recover/.test(await text(note)), HUNG_MS)), await text(page.locator('.card-work')))
    await shoot(page.locator('.card-work'), 'not-ready')
    await page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()

    // --- The user's Recover…: refused while B1 runs in the slot; let through once it is stopped.
    if (!(await running(b1.id))) await inv('session:start', shop, { agentId: b1.id }).catch(() => undefined)
    check('B1 running in the slot', !!(await until(async () => (await live(b1.id))?.cwd?.toLowerCase() === slotFolder.toLowerCase() && (await running(b1.id)), HUNG_MS)), JSON.stringify(await live(b1.id)))
    await toProject()
    await section('workflow')
    const row = page.locator(`[data-slot="${slotName}"]`)
    check('Slots and copies: the lane\'s slot Stale, with Recover…', !!(await until(async () => (await row.locator('[data-action="recover"]').count()) === 1, HUNG_MS)), await text(row))
    const recover = async () => {
      await row.locator('[data-action="recover"]').click()
      const ask = page.locator('.dialog').filter({ hasText: `Recover ${slotName}?` })
      await until(async () => (await ask.count()) === 1, HUNG_MS)
      await ask.getByRole('button', { name: 'Recover', exact: true }).click()
    }
    await recover()
    check('Recover… while B1 runs there: refused, saying to stop it first', !!(await until(async () => /wasn’t recovered: something works in it \(an agent working there: stop it first\)/.test(await text(page.locator('body'))), HUNG_MS)), await text(page.locator('body')))
    await shoot(page.locator('.toasts'), 'recover-refused').catch(() => undefined)
    check('…the slot still stale, card 3 still not ready', (await slotRow(slotName))?.stale === true && !!(await inv('tasks:work', n3))?.notReady, JSON.stringify(await slotRow(slotName)))
    await inv('session:stop', shop, b1.id)
    check('B1 stopped', !!(await until(async () => !(await running(b1.id)), HUNG_MS)), JSON.stringify(await live(b1.id)))
    // The folder can stay in use for a while after its CLI exits (jjwindow's HI-2906 note: over 30 s seen), and each
    // try is refused until it's quiet: the user's Recover… again, through the call its button makes (the button's own
    // flow, its confirmation and its refusal, is above), each try answered before the next.
    const notStale = async () => (await slotRow(slotName))?.stale !== true
    let tries = 0
    const answers = []
    const recovered = await until(async () => {
      if (await notStale()) return true
      tries++
      const r = await inv('slots:recoverStale', shop, slotName).catch((e) => ({ ok: false, why: String(e) }))
      answers.push(r.ok ? 'ok' : r.why)
      return r.ok && (await notStale())
    }, HUNG_MS * 3)
    console.log(`INFO Recover… tries after B1 stopped: ${answers.join(', ')}`)
    const logText = () => (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '')
    check("Recover… with nothing in the lane's slot: recovered for card 3, not stale any more", !!recovered && logText().includes(`recovered for #${n3}`), `${tries} tries; ${JSON.stringify(await slotRow(slotName))}`)
    for (const l of logText().split(/\r?\n/).filter((x) => /wasn't recovered|recovered for|recovery refused|recovery stopped|prepared for #| is on jj:|Giving|ended in/.test(x))) console.log(`INFO app: ${l.slice(0, 300)}`)

    // --- Card 3 prepared in the recovered slot, B1 given it there; built, reviewed and integrated as shown.
    const prepared3 = await until(async () => {
      const v = await inv('tasks:work', n3)
      return v && !v.notReady && (await running(b1.id)) && (await live(b1.id))?.cwd?.toLowerCase() === slotFolder.toLowerCase() ? v : null
    }, HUNG_MS * 2)
    check('card 3: prepared in the recovered slot, B1 placed there', !!prepared3, JSON.stringify({ work: await inv('tasks:work', n3), b1: await live(b1.id) }))
    const R3 = await buildAndReview(n3, k3, slotFolder, 'three.txt', 'card 3')
    check('card 3: given to B1 once', givings(n3) === 1, String(givings(n3)))
    userMovesMain('the user once more')
    await integrateAsShown(n3, k3, 'card 3', R3, null)
    if (NC) check('not colocated throughout: no .git in the project folder or its slot', !fs.existsSync(path.join(shop, '.git')) && !fs.existsSync(path.join(slotFolder, '.git')))

    // --- Cleanup: the lane ends. Its slot's return to the pool afterwards can lag under load (HI-2916, seen on 1.5.0
    // without this change, in jjwindow too): that card checks it, not this suite.
    check('the lane ends with its last card', !!(await until(async () => ((await inv('lanes:list')) ?? []).every((l) => l.ended || !(l.cards ?? []).includes(n1)), HUNG_MS)), JSON.stringify(await inv('lanes:list')))
    for (const a of [b1, r1]) await inv('session:stop', shop, a.id).catch(() => undefined)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
