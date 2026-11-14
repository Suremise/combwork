// The merge checks on a jj card's candidate (HI-2938, SPEC "The merge checks on a jj card's candidate"): the real app, the
// pinned jj (npm run jj:fetch) on its PATH, a fake Claude Code builder (B1), a throwaway profile and workspace, merge checks
// that are real commands (Node). Colocated here; `jjchecksnc` runs the same steps on a repository not colocated
// with Git (CW_JJCHECKS_NONCOLOCATED=1), its screenshots `jjchecksnc-…`. jjCandidateRun.cjs's set-up, then:
// - card 1 passes review: its candidate is built and its checks run in a check copy (the first holds until the test lets
//   it go): Waiting says Candidate built and which check runs, with no command; then both pass: Candidate ready, its checks
//   named, with the jj bookmark set command; the user runs it: Done, from a prepared candidate;
// - the stopped card's first check is stopped from Progress (its run, stoppable): stopped, not offered, Run Checks Again; clicked:
//   the checks run again and pass: offered; the user integrates it;
// - the failing card's lint fails: the card goes back to Doing, its comment naming the check; never offered.
// Screenshots of the running and passed states in both themes and all seven locales, and of the stopped state.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjchecks: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const NC = process.env.CW_JJCHECKS_NONCOLOCATED === '1'
const SUITE = NC ? 'jjchecksnc' : 'jjchecks'
const PORT = Number(lib.port(NC ? 47944 : 47943))
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

const home = path.join(work, 'home')
const jjConfig = path.join(home, 'jj.toml')
const gitConfig = path.join(home, 'gitconfig')
const toolEnv = () => ({ ...lib.gitEnv({ GIT_CONFIG_GLOBAL: gitConfig, GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: home, JJ_CONFIG: jjConfig, NO_COLOR: '1' }) })
const jj = (cwd, ...args) => execFileSync(exe, args, { cwd, env: toolEnv(), windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// The checks: Node commands. `gate`: holds until its release file exists (so the running state can be seen), then passes.
const node = `"${process.execPath}"`
const gateFile = path.join(work, 'release-gate')
const lintFails = path.join(work, 'lint-fails')
const typecheckCmd = `${node} -e "const f=require('fs');const t=setInterval(()=>{if(!f.existsSync(${JSON.stringify(gateFile).replace(/"/g, "'")})){return}clearInterval(t)},100)"`
const lintCmd = `${node} -e "if(require('fs').existsSync(${JSON.stringify(lintFails).replace(/"/g, "'")})){console.log('lint: 1 problem');process.exit(1)}"`

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

  const env = lib.withPathFirst({ ...toolEnv(), CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' }, jjDir())
  delete env.CW_USER_DATA
  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    await lib.openWorkspace(inv, page, ws)
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates', target: 'main', style: 'merge', mergeChecks: ['typecheck', 'lint'], commands: { typecheck: typecheckCmd, lint: lintCmd } } })
    check('shop: you review and integrate into main; merge checks typecheck and lint on the candidate', !!opts && !opts.error, JSON.stringify(opts))
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
      const server = JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork
      return JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    /** The slot back in the pool once the last card is done and B1 stopped there (as jjwindow waits between cards). */
    const slotFree = async () => {
      await inv('session:stop', shop, b1.id).catch(() => undefined)
      return until(async () => {
        const all = (await inv('slots:list', shop)) ?? []
        return all.length > 0 && all.every((x) => x.state === 'ready') ? all : null
      }, HUNG_MS * 2)
    }
    /** A card built by B1 in a slot, submitted, and passed by you: its number and key. */
    const passedCard = async (title, file) => {
      const n = (await inv('tasks:create', { title, project: 'shop', agent: b1.id })).number
      const key = (await card(n)).key
      await inv('tasks:move', n, 'doing', { confirm: true, reason: `${SUITE}: start` }).catch((e) => ({ error: String(e) }))
      const w = await until(async () => {
        const v = await inv('tasks:work', n)
        return v?.folder && v.workspace ? v : null
      }, HUNG_MS)
      check(`${key} starts in a jj slot, B1 there`, !!w && !!(await ready(b1.id)), JSON.stringify(w))
      if (!w) throw new Error('no slot')
      fs.writeFileSync(path.join(w.folder, file), `${title}\n`)
      jj(w.folder, 'commit', '-m', title)
      await ready(b1.id)
      const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
      check(`${key}: B1 submits it`, sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify(sub.body))
      await inv('tasks:move', n, 'passed', { confirm: true, reason: `${SUITE}: passed` }).catch((e) => ({ error: String(e) }))
      check(`${key}: you pass it`, !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), (await card(n))?.column)
      return { n, key, w }
    }

    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    await page.getByText('shop', { exact: true }).first().click()
    await vcTab.first().click()
    await page.locator('.git-sections [data-section="jjRepo"]').click()
    const repo = page.locator('[data-jj-section="repo"]')
    const panel = repo.locator('[data-jj-integrate]')
    const refresh = () => repo.locator('[data-action="jj-refresh"]').first().click()
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const quiet = await page.addStyleTag({ content: '.toasts { display: none !important; }' })
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const english = (await inv('app:info')).language
    const catalogue = (code) => Object.assign({}, ...fs.readdirSync(path.join(lib.ROOT, 'locales', code)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', code, f), 'utf8'))))
    const inEach = async (loc, name, wanted) => {
      for (const language of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
        const cat = catalogue(language)
        await speak({ ...english, code: language, locale: language, messages: cat })
        const want = wanted(cat)
        check(`${language}: ${name} in the language`, !!(await until(async () => (await text(loc)).includes(want), HUNG_MS)), await text(loc))
        await shoot(loc, `${name}-${language}`)
      }
      await speak(english)
    }

    // --- Card 1: its checks run (the first held), then pass: offered only then; the user integrates it.
    const c1 = await passedCard('Shop work', 'shop.txt')
    const row1 = repo.locator(`[data-jj-integrate-card="${c1.n}"]`)
    check('card 1: Candidate built, running its first check, no command to integrate it yet', !!(await until(async () => (await row1.locator('[data-jj-checks="running"]').count()) === 1 && /Running its merge checks: typecheck \(1 of 2\)/.test(await text(row1)) && (await row1.locator('[data-jj-command]').count()) === 0, HUNG_MS)), await text(row1))
    await shoot(panel, 'running')
    await inEach(panel, 'running', (cat) => cat['jj.integrate.checksRunning'].split(':')[0].split('：')[0])
    fs.writeFileSync(gateFile, 'go')
    const command1 = row1.locator('[data-jj-command="candidate"]')
    check('…both pass: Candidate ready, its checks named, with the command', !!(await until(async () => (await row1.locator('[data-jj-checks="passed"]').count()) === 1 && /its merge checks passed: typecheck and lint/.test(await text(row1)) && (await command1.count()) === 1, HUNG_MS)), await text(row1))
    await shoot(panel, 'passed')
    await inEach(panel, 'passed', (cat) => cat['jj.integrate.candidateHow'].replace('{target}', 'main'))
    const result = (/-r ([0-9a-f]{40})$/.exec(await text(command1)) ?? [])[1]
    const runs = (await inv('progress:list')).filter((r) => r.copy && r.card === c1.n)
    check('…each check one of Combwork’s runs in a check copy, stoppable', runs.length >= 2 && runs.every((r) => r.stoppable === true), JSON.stringify(runs.map((r) => ({ title: r.title, copy: r.copy, stoppable: r.stoppable }))))
    jj(shop, 'bookmark', 'set', 'main', '-r', result)
    check('the user runs it: Done', !!(await until(async () => (await card(c1.n))?.column === 'done', HUNG_MS)), (await card(c1.n))?.column)
    const work1 = await inv('tasks:work', c1.n)
    check('…integrated from a prepared candidate', JSON.stringify(work1 ?? {}).includes('candidate'), JSON.stringify(work1?.integrated ?? work1))

    // --- The stopped card: its first check stopped from Progress: stopped, Run Checks Again, then passes.
    fs.rmSync(gateFile)
    check('card 1’s slot back in the pool', !!(await slotFree()), JSON.stringify(await inv('slots:list', shop)))
    const c3 = await passedCard('Stopped checks', 'stopped.txt')
    const row3 = repo.locator(`[data-jj-integrate-card="${c3.n}"]`)
    const run3 = await until(async () => (await inv('progress:list')).find((r) => r.card === c3.n && r.copy && r.stoppable && !r.finishedAt) ?? null, HUNG_MS)
    check('the stopped card: its first check running, stoppable', !!run3, JSON.stringify(await inv('progress:list')))
    check('…Stop ends it (its lease’s job)', (await inv('progress:stop', run3.id)) === true)
    await refresh()
    check('…stopped: not offered, Run Checks Again', !!(await until(async () => (await row3.locator('[data-jj-checks="stopped"]').count()) === 1 && (await row3.locator('[data-action="jj-checks-again"]').count()) === 1 && (await row3.locator('[data-jj-command]').count()) === 0, HUNG_MS)), await text(row3))
    await shoot(row3, 'stopped')
    fs.writeFileSync(gateFile, 'go')
    await row3.locator('[data-action="jj-checks-again"]').click()
    check('…Run Checks Again: they run again and pass: offered', !!(await until(async () => (await row3.locator('[data-jj-checks="passed"]').count()) === 1 && (await row3.locator('[data-jj-command="candidate"]').count()) === 1, HUNG_MS)), await text(row3))
    // …integrated by the user, so its slot goes back for the failing card.
    const result3 = (/-r ([0-9a-f]{40})$/.exec(await text(row3.locator('[data-jj-command="candidate"]'))) ?? [])[1]
    jj(shop, 'bookmark', 'set', 'main', '-r', result3)
    check('the stopped card: the user runs it: Done', !!(await until(async () => (await card(c3.n))?.column === 'done', HUNG_MS)), (await card(c3.n))?.column)

    // --- The failing card: lint fails on its candidate: back to its builder, never offered.
    fs.writeFileSync(lintFails, 'yes')
    check('the stopped card’s slot back in the pool', !!(await slotFree()), JSON.stringify(await inv('slots:list', shop)))
    const c2 = await passedCard('Broken lint', 'broken.txt')
    check('the failing card: its lint fails on the candidate: back in Doing', !!(await until(async () => (await card(c2.n))?.column === 'doing', HUNG_MS)), (await card(c2.n))?.column)
    const failed2 = (await inv('tasks:facts', c2.n)).find((f) => f.kind === 'IntegrationFailed')
    const comments2 = (await card(c2.n))?.comments ?? []
    check('…IntegrationFailed for its lint, its comment naming the check', failed2?.data?.reason === 'checks' && failed2?.data?.check === 'lint' && comments2.some((c) => /merge check lint failed on the candidate/.test(c.text)), JSON.stringify({ failed2: failed2?.data, comments: comments2.map((c) => c.text) }))
    // Never offered: it leaves Waiting for you to integrate (once the panel has read the board's change).
    const row2 = repo.locator(`[data-jj-integrate-card="${c2.n}"]`)
    check('…and leaves Waiting, never offered', !!(await until(async () => (await row2.count()) === 0, HUNG_MS)) && (await row2.locator('[data-jj-command="candidate"]').count()) === 0, await text(row2))

    await quiet.evaluate((el) => el.remove())
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
