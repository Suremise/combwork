// Combwork's advance of a jj card in the window (HI-3236, HI-2840's stage 3; HI-3235's protocol): the real app, the pinned
// jj (npm run jj:fetch) on its PATH, a fake Claude Code builder (B1), a throwaway profile and workspace, a colocated
// repository, the finish preview and click (`previewAdvance`), you review:
// (a) a passed card's For you preview shows the plan (main from E to its candidate, the commits it adds) with Integrate
//     and Not for this plan; Integrate moves main to the candidate and the card goes to Done;
// (b) a stale preview: main moved by jj after the preview, the old Integrate runs nothing; a fresh preview for the new
//     candidate comes, and its Integrate integrates;
// (c) an uncertain attempt: an AdvanceAttempted with no journal, written into combwork.db with the app closed (cardwork's
//     way); reopened, For you asks It's integrated / Not integrated, start again; It's integrated: Done on your word,
//     the Work section saying integration not proved;
// (d) a stopped attempt's Undo, through the unpackaged test seam CW_TEST_ADVANCE_STOP=undo (HR1's bounds on HI-3236/s7:
//     the move real, recorded as a stop with its undo offered, the undo the real protocol): Undo Combwork's move puts main
//     back, the card stays Approved with nothing integrated.
// Screenshots of the four For you items in both themes and at a narrow width. Dev build only: (d) needs
// CW_TEST_ADVANCE_STOP, a test seam a packaged build ignores (never in an installed Combwork).
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DatabaseSync } = require('node:sqlite')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.step')
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjadvance: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const SUITE = 'jjadvance'
const PORT = Number(lib.port(47601))
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
const id = (cwd, rev, t = 'commit_id') => jj(cwd, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', t).trim()

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

  const baseEnv = lib.withPathFirst({ ...toolEnv(), CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' }, jjDir())
  delete baseEnv.CW_USER_DATA
  let { app, page, inv } = await lib.launch({ userData, env: baseEnv, viewport: { width: 1400, height: 950 } })
  const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
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
  const forYouOf = async (n, gate) => ((await inv('tasks:forYou')).items ?? []).find((i) => i.card === n && i.gate === gate) ?? null
  /** What a failed advance check shows (HI-3321): main against where it was, the card's facts since its pass, its For you items. */
  const advanceEvidence = async (n, was) => {
    const facts = (await inv('tasks:facts', n).catch(() => [])) ?? []
    const from = facts.findLastIndex((f) => f.kind === 'Moved' && f.data?.to === 'approved')
    return {
      mainMoved: id(shop, 'main') !== was,
      facts: facts.slice(Math.max(0, from)).map((f) => `${f.seq}:${f.kind}:${JSON.stringify(f.data ?? {}).slice(0, 160)}`),
      forYou: ((await inv('tasks:forYou')).items ?? []).filter((i) => i.card === n).map((i) => ({ gate: i.gate, request: i.request }))
    }
  }
  let b1 = null
  /** A card for B1 in a slot of its own, B1's commit there submitted, the user's pass: Approved (Passed on the board). */
  const passedCard = async (title, file) => {
    await until(async () => {
      const all = (await inv('slots:list', shop)) ?? []
      return all.every((x) => x.state === 'ready')
    }, HUNG_MS * 2)
    const n = (await inv('tasks:create', { title, project: 'shop', agent: b1.id })).number
    const key = (await card(n)).key
    await inv('tasks:move', n, 'doing', { confirm: true, reason: `${SUITE}: start` }).catch(() => undefined)
    const w = await until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check(`${key} starts in a jj slot, B1 there`, !!w && !!(await ready(b1.id)))
    if (!w) throw new Error('no slot')
    fs.writeFileSync(path.join(w.folder, file), `${title}\n`)
    jj(w.folder, 'commit', '-m', title)
    await ready(b1.id)
    const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
    check(`${key}: B1 submits it`, sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify(sub.body))
    await inv('tasks:move', n, 'passed', { confirm: true, reason: `${SUITE}: passed` }).catch(() => undefined)
    check(`${key}: you pass it`, !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), (await card(n))?.column)
    return { n, key }
  }
  /** The card's dialog, at its For you section. */
  const forYouSection = async (n) => {
    await showBoard(page)
    await openByTitle(page, n)
    return lib.cardDialog(page, await lib.cardLabel(inv, n)).locator('[data-section="for-you"]')
  }
  const closeDialog = () => page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => undefined)
  /** Shots of a For you item: both themes at the suite's width, and dark at a narrow window. */
  const shoot = async (loc, name) => {
    await page.mouse.move(5, 5)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await lib.fitWindow(app, page, { width: 820, height: 950 })
    await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-narrow.png`) })
    await lib.fitWindow(app, page, { width: 1400, height: 950 })
  }
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'you', noSelfReview: false, folder: 'slots', finish: 'previewAdvance', target: 'main', style: 'merge' } })
    check('shop: you review, cards in slots, Combwork integrates when you click', !!opts && !opts.error, JSON.stringify(opts))
    b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder' })

    // --- (a) The preview, then Integrate.
    const a = await passedCard('Shop work', 'shop.txt')
    const E = id(shop, 'main')
    const preview = await until(() => forYouOf(a.n, 'advancePreview'), HUNG_MS)
    check('(a) For you previews the plan: main from its commit to the candidate, the commits it adds', !!preview && /Integrate .* into main\? Combwork moves main from/.test(preview.text) && /adding: /.test(preview.text), JSON.stringify(preview))
    check('…nothing moved before the click', id(shop, 'main') === E)
    let section = await forYouSection(a.n)
    const actions = section.locator('[data-advance="advancePreview"]')
    check('…its buttons: Integrate and Not for this plan', !!(await until(async () => (await actions.count()) === 1, HUNG_MS)) && (await text(actions)).includes('Integrate') && (await text(actions)).includes('Not for this plan'), await text(section))
    await shoot(section, 'preview')
    await actions.locator('button').first().click()
    check('…Integrate: Done, main at the candidate', !!(await until(async () => (await card(a.n))?.column === 'done', HUNG_MS)) && id(shop, 'main') !== E, JSON.stringify({ column: (await card(a.n))?.column, ...(await advanceEvidence(a.n, E)) }))
    await closeDialog()

    // --- (b) A stale preview: main moved by jj after it; the old Integrate runs nothing; a fresh preview integrates.
    const b = await passedCard('Second work', 'second.txt')
    const p1 = await until(() => forYouOf(b.n, 'advancePreview'), HUNG_MS)
    jj(shop, 'new', 'main', '-m', 'theirs')
    fs.writeFileSync(path.join(shop, 'theirs.txt'), 'theirs\n')
    jj(shop, 'commit', '-m', 'theirs')
    jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
    const moved = id(shop, 'main')
    section = await forYouSection(b.n)
    await section.locator('[data-advance="advancePreview"] button').first().click()
    const fresh = await until(async () => {
      const p = await forYouOf(b.n, 'advancePreview')
      return p && p.request !== p1?.request ? p : null
    }, HUNG_MS)
    check('(b) the stale Integrate ran nothing: main where jj moved it, the card still waiting; a fresh preview for the new candidate', !!fresh && (await card(b.n))?.column === 'passed' && id(shop, 'main') === moved, JSON.stringify({ fresh, column: (await card(b.n))?.column }))
    await closeDialog()
    section = await forYouSection(b.n)
    await section.locator('[data-advance="advancePreview"] button').first().click()
    check('…its Integrate: Done', !!(await until(async () => (await card(b.n))?.column === 'done', HUNG_MS)), (await card(b.n))?.column)
    await closeDialog()

    // --- (c) An uncertain attempt: a card waiting at its preview, then an AdvanceAttempted with no journal written while
    // the app is closed.
    const c = await passedCard('Third work', 'third.txt')
    await until(() => forYouOf(c.n, 'advancePreview'), HUNG_MS)
    for (const p of [shop]) await inv('session:stop', p).catch(() => undefined)
    await lib.until(async () => (await inv('session:live')).length === 0, HUNG_MS)
    await app.close()
    const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { timeout: 5000 })
    const seq = (db.prepare('SELECT MAX(seq) AS m FROM card_facts WHERE card = ?').get(c.n).m ?? 0) + 1
    db.prepare('INSERT INTO card_facts (card, seq, kind, at, actor, source, ruleset, dedupe, data) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)').run(c.n, seq, 'AdvanceAttempted', new Date().toISOString(), 'combwork', 'recorded', JSON.stringify({ plan: 'p', attempt: 'ghost' }))
    db.close()
    // Reopened with the test seam on, for (d) too.
    ;({ app, page, inv } = await lib.launch({ userData, env: { ...baseEnv, CW_TEST_ADVANCE_STOP: 'undo' }, viewport: { width: 1400, height: 950 } }))
    page.on('pageerror', (e) => check('no page errors (reopened)', false, e.message))
    await lib.until(async () => (await inv('workspace:get'))?.path?.toLowerCase() === ws.toLowerCase(), HUNG_MS)
    const uncertain = await until(() => forYouOf(c.n, 'advanceUncertain'), HUNG_MS * 2)
    check('(c) For you asks about the uncertain attempt (its journal missing), and no preview with it', !!uncertain && !(await forYouOf(c.n, 'advancePreview')), JSON.stringify(uncertain))
    section = await forYouSection(c.n)
    const named = section.locator('[data-advance="advanceUncertain"]')
    check("…its buttons: It's integrated and Not integrated, start again", !!(await until(async () => (await named.count()) === 1, HUNG_MS)) && (await text(named)).includes('It’s integrated') && (await text(named)).includes('Not integrated, start again'), await text(section))
    await shoot(section, 'uncertain')
    await named.locator('button').first().click()
    check("…It's integrated: Done on your word", !!(await until(async () => (await card(c.n))?.column === 'done', HUNG_MS)), (await card(c.n))?.column)
    await closeDialog()
    await openByTitle(page, c.n)
    const workSection = page.locator('.card-work')
    check('…the Work section says Done by you, integration not proved', !!(await until(async () => /integration not proved/.test(await text(workSection)), HUNG_MS)), await text(workSection))
    await closeDialog()

    // --- (d) A stopped attempt's Undo (the test seam: the real move recorded as a stop with its undo offered).
    const d = await passedCard('Fourth work', 'fourth.txt')
    const before = id(shop, 'main')
    const pd = await until(() => forYouOf(d.n, 'advancePreview'), HUNG_MS)
    section = await forYouSection(d.n)
    await section.locator('[data-advance="advancePreview"] button').first().click()
    const stopped = await until(() => forYouOf(d.n, 'advanceStopped'), HUNG_MS)
    check('(d) the move ran, then the seam recorded it stopped with its undo offered', !!pd && !!stopped && id(shop, 'main') !== before, JSON.stringify({ stopped, main: id(shop, 'main'), before }))
    await closeDialog()
    section = await forYouSection(d.n)
    const undo = section.locator('[data-advance="advanceStopped"]')
    check("…its buttons: Undo Combwork's move and Leave it to me", !!(await until(async () => (await undo.count()) === 1, HUNG_MS)) && (await text(undo)).includes('Undo Combwork’s move') && (await text(undo)).includes('Leave it to me'), await text(section))
    await shoot(section, 'stopped')
    await undo.locator('button').first().click()
    check('…Undo: main back where it was, the card still Approved, nothing integrated, nothing waiting', !!(await until(async () => id(shop, 'main') === before && !(await forYouOf(d.n, 'advanceStopped')), HUNG_MS)) && (await card(d.n))?.column === 'passed', JSON.stringify({ main: id(shop, 'main'), before, column: (await card(d.n))?.column }))
    await closeDialog()
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
