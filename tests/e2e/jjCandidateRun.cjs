// A jj card's candidate before the user integrates (HI-2871, SPEC "jj's pre-integration candidate"): the real app, the
// pinned jj (npm run jj:fetch) on its PATH, a fake Claude Code builder (B1), a throwaway profile and workspace. Colocated
// here; the suite `jjcandidatenc` runs the same steps on a repository not colocated with Git (CW_JJCANDIDATE_NONCOLOCATED=1),
// its screenshots `jjcandidatenc-…`. jjWindowRun.cjs's set-up, its own steps:
// - shop (jj, you review, target main, Merge commit): the user starts a card for B1 in a slot; B1 commits there with jj and
//   submits through the Agent API; the target moves on meanwhile (the user's own commit on main); the user passes it;
// - Repository's Waiting for you to integrate shows Candidate ready: a commit of its own on main's head (no conflicts, no
//   merge checks), with the jj bookmark set command that integrates it; main, the slot and its commits untouched;
// - the user runs that command: the card goes to Done by itself, its Work section saying it came from a prepared
//   candidate, and nothing is left waiting;
// Screenshots of the candidate in both themes and all seven locales, and of the Work section.
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
  console.log("SKIP jjcandidate: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const NC = process.env.CW_JJCANDIDATE_NONCOLOCATED === '1'
const SUITE = NC ? 'jjcandidatenc' : 'jjcandidate'
const PORT = Number(lib.port(NC ? 47942 : 47941))
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

  const env = { ...toolEnv(), PATH: `${jjDir()};${lib.baseEnv().PATH ?? ''}`, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' }
  delete env.CW_USER_DATA
  const { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    await lib.openWorkspace(inv, page, ws)
    // You review (an approval waits for your integration), each card in a slot, a merge commit candidate.
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'userIntegrates', target: 'main', style: 'merge' } })
    check('shop: you review, cards in slots, you integrate into main, Merge commit candidates', !!opts && !opts.error, JSON.stringify(opts))
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

    // --- The user starts a jj card for B1: a slot of its own, B1 started there; B1 commits and submits.
    const n = (await inv('tasks:create', { title: 'Shop work', project: 'shop', agent: b1.id })).number
    const key = (await card(n)).key
    const started = await inv('tasks:move', n, 'doing', { confirm: true, reason: 'jjcandidate: start' }).catch((e) => ({ error: String(e) }))
    const w1 = await until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check(`${key} starts in a jj slot, B1 there`, !!w1 && !!(await ready(b1.id)), JSON.stringify({ started, w1 }))
    if (!w1) throw new Error('no slot')
    fs.writeFileSync(path.join(w1.folder, 'shop.txt'), 'shop work\n')
    jj(w1.folder, 'commit', '-m', 'shop work')
    const P = id(w1.folder, '@-')
    const slotAt = id(w1.folder, '@')
    await ready(b1.id)
    const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
    check('B1 submits it: in Review', sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ sub: sub.body, card: (await card(n))?.column }))
    // The target moves on meanwhile: the user's own commit on main (another file), so the candidate is a real merge.
    jj(shop, 'new', 'main', '-m', 'theirs')
    fs.writeFileSync(path.join(shop, 'theirs.txt'), 'theirs\n')
    jj(shop, 'commit', '-m', 'theirs')
    jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
    const head = id(shop, 'main')
    const passed = await inv('tasks:move', n, 'passed', { confirm: true, reason: 'jjcandidate: passed' }).catch((e) => ({ error: String(e) }))
    check('…you pass it: approved, waiting for your integration', !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), JSON.stringify({ passed, column: (await card(n))?.column }))

    // --- Repository: Waiting for you to integrate, with the candidate.
    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    await page.getByText('shop', { exact: true }).first().click()
    await vcTab.first().click()
    await page.locator('.git-sections [data-section="jjRepo"]').click()
    const repo = page.locator('[data-jj-section="repo"]')
    const waiting = repo.locator(`[data-jj-integrate-card="${n}"]`)
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const quiet = await page.addStyleTag({ content: '.toasts { display: none !important; }' })
    const command = waiting.locator('[data-jj-command="candidate"]')
    const shown = await until(async () => ((await waiting.locator('[data-jj-candidate="ready"]').count()) === 1 && (await command.count()) === 1 ? await text(command) : null), HUNG_MS)
    const result = shown ? (/-r ([0-9a-f]{40})$/.exec(shown) ?? [])[1] : null
    check('Waiting: Candidate ready, with the jj bookmark set command that integrates it', !!result && shown === `jj bookmark set main -r ${result}` && /Candidate ready/.test(await text(waiting)) && /No conflicts; no merge checks/.test(await text(waiting)), await text(repo.locator('[data-jj-integrate]')))
    if (!result) throw new Error('no candidate')
    const parents = jj(shop, '--ignore-working-copy', 'log', '--no-graph', '-r', result, '-T', 'parents.map(|p| p.commit_id()).join(",")').trim()
    check('…a merge of main’s head and the reviewed commit, on main’s new head', parents === `${head},${P}` && (await text(waiting)).includes(head.slice(0, 7)), parents)
    check('…main, the slot and its commits untouched (Combwork moved no bookmark)', id(shop, 'main') === head && id(w1.folder, '@') === slotAt && id(w1.folder, '@-') === P)
    // No manual commands while a candidate is ready.
    check('…in place of the copy-and-set commands', (await waiting.locator('[data-jj-command=""]').count()) === 0, await text(waiting))
    await shoot(repo.locator('[data-jj-integrate]'), 'candidate')
    // In each language, both themes.
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const english = (await inv('app:info')).language
    const catalogue = (code) => Object.assign({}, ...fs.readdirSync(path.join(lib.ROOT, 'locales', code)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', code, f), 'utf8'))))
    for (const language of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      const cat = catalogue(language)
      await speak({ ...english, code: language, locale: language, messages: cat })
      const want = cat['jj.integrate.candidateHow'].replace('{target}', 'main')
      check(`${language}: the candidate in the language`, !!(await until(async () => (await text(waiting)).includes(want), HUNG_MS)), await text(waiting))
      await shoot(repo.locator('[data-jj-integrate]'), `candidate-${language}`)
    }
    await speak(english)

    // --- The user integrates it with the command shown: Done, from a prepared candidate.
    jj(shop, 'bookmark', 'set', 'main', '-r', result)
    check('the user runs it: Done', !!(await until(async () => (await card(n))?.column === 'done', HUNG_MS)), (await card(n))?.column)
    await repo.locator('[data-action="jj-refresh"]').first().click()
    check('…and nothing waits any more', !!(await until(async () => (await waiting.count()) === 0, HUNG_MS)), await text(repo.locator('[data-jj-integrate]')))
    await quiet.evaluate((el) => el.remove())
    await showBoard(page)
    await openByTitle(page, n)
    const workSection = page.locator('.card-work[data-work="recorded"]')
    check('the Work section: integrated from a prepared candidate', !!(await until(async () => /from a prepared candidate/.test(await text(workSection)), HUNG_MS)), await text(workSection))
    await shoot(workSection, 'work')
    await page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
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
