// The window for jj cards (HI-2869, J9c; SPEC "The window for jj cards"): the real app, the pinned jj (npm run jj:fetch)
// on its PATH, a fake Claude Code builder (B1), a throwaway profile and workspace. jj cards start as in the product (J9e,
// HI-2874, retired the start guard and its test seam). Colocated here; the suite `jjwindownc` runs the same steps on a repository not colocated with Git (J9f, HI-2896:
// CW_JJWINDOW_NONCOLOCATED=1), its screenshots `jjwindownc-…`.
// - shop (jj, you review, target main): the user starts a card for B1, in a slot (a jj workspace); B1 commits there with
//   jj and submits through the Agent API; the user passes it. Repository's Waiting for you to integrate shows it with its change id and
//   "not in main yet" (J5's observation for exactly that approval, shown when written), and the same panel, still mounted,
//   follows a change of the record (a board change);
// - the user integrates it (moves main onto it): Done; Waiting is empty; the card dialog's Work section shows its
//   Workspace (in its line's place), its change id beside the revision and how its integration was proved;
// - B1 stopped, the slot back in the pool by itself (HI-2906: ready, detached at main);
// - the slot made stale (its working-copy commit rewritten from the project folder): Slots and copies says Stale with
//   Recover…; the confirmation names the folder unrecorded edits go to; an edit there is kept in it, and the slot is
//   recovered (not stale any more), its Recover… gone; an edit the update also changed is written beside its file, and
//   what Recover… did shows in a window naming that copy (HI-2996);
// - the next card starts in that same slot (HI-2906); put back with a commit there, the slot is kept for it (Slots and
//   copies: Kept for, in every language), and started again it gets that slot back with its commit (HI-2995); put back
//   again and its folder deleted, the row says so with Remove…, which, confirmed, removes it, its commit kept (HI-3032);
// - Publish records to check and Leftovers follow a change while mounted (Refresh);
// Screenshots of each in both themes, and of Waiting, the Work section and the stale slot's row in all seven locales, in
// both themes.
const lib = require('./lib.cjs')
const { showBoard, openByTitle } = require('./queueFixture.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { DatabaseSync } = require('node:sqlite')
const { jjDir, portableJj } = require('../jjPortable.cjs')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
const exe = portableJj()
if (!exe) {
  console.log("SKIP jjwindow: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

// Not colocated (HI-2896): Git's data inside .jj, no .git in the project folder; its own port and folders.
const NC = process.env.CW_JJWINDOW_NONCOLOCATED === '1'
const SUITE = NC ? 'jjwindownc' : 'jjwindow'
const PORT = Number(lib.port(NC ? 47798 : 47797))
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
    // You review (so an approval waits for your integration: Solo has no Approved stage under jj), each card in a slot.
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
    // Its running session's (the session id read again each time: B1 is started again in its card's slot).
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

    // --- The user starts a jj card for B1 (not running yet: setting up jj's slots records the user's working copy only
    // while no agent works in the project folder, HI-2887): a slot of its own (a jj workspace), B1 started there.
    const n = (await inv('tasks:create', { title: 'Shop work', project: 'shop', agent: b1.id })).number
    const key = (await card(n)).key
    const started = await inv('tasks:move', n, 'doing', { confirm: true, reason: 'jjwindow: start' }).catch((e) => ({ error: String(e) }))
    const w1 = await until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check(`${key} starts in a jj slot, B1 there`, !!w1 && !!(await ready(b1.id)), JSON.stringify({ started, w1 }))
    if (!w1) throw new Error('no slot')
    const slot = path.basename(w1.folder)
    fs.writeFileSync(path.join(w1.folder, 'shop.txt'), 'shop work\n')
    jj(w1.folder, 'commit', '-m', 'shop work')
    const P = id(w1.folder, '@-')
    const change = id(w1.folder, '@-', 'change_id')
    await ready(b1.id)
    const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
    check('B1 submits it: in Review', sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ sub: sub.body, card: (await card(n))?.column }))
    const passed = await inv('tasks:move', n, 'passed', { confirm: true, reason: 'jjwindow: passed' }).catch((e) => ({ error: String(e) }))
    check('…you pass it: approved, waiting for your integration', !!(await until(async () => (await card(n))?.column === 'passed', HUNG_MS)), JSON.stringify({ passed, column: (await card(n))?.column }))

    // --- Repository: Waiting for you to integrate, with J5's observation for exactly this approval.
    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    await page.getByText('shop', { exact: true }).first().click()
    await vcTab.first().click()
    // The project's Version Control tab, from wherever the window is (the board shown after a card's dialog).
    const toProject = async () => {
      // The board is a view of its own: the activity bar's first button (Projects) leaves it.
      if (await page.locator('.board').isVisible()) await page.locator('.activity-btn').first().click()
      await page.locator('text="shop" >> visible=true').first().click()
      await vcTab.first().click()
    }
    const section = async (name) => {
      await page.locator(`.git-sections [data-section="${name}"]`).click()
      return page.locator(`[data-jj-section="${name.replace(/^jj/, '').toLowerCase()}"]`)
    }
    const shoot = async (loc, name) => {
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await loc.screenshot({ path: path.join(shots, `${SUITE}-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const quiet = await page.addStyleTag({ content: '.toasts { display: none !important; }' })
    // The window's language, as a change of it reaches the window (jjview's way). Names change with it: each view is
    // reached in English, then shown in each language where it is, in both themes.
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const english = (await inv('app:info')).language
    const catalogue = (code) => Object.assign({}, ...fs.readdirSync(path.join(lib.ROOT, 'locales', code)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(lib.ROOT, 'locales', code, f), 'utf8'))))
    const inEach = async (loc, name, wanted) => {
      for (const language of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
        const cat = catalogue(language)
        await speak({ ...english, code: language, locale: language, messages: cat })
        const want = wanted(cat)
        check(`${language}: ${name} in the language`, !!want && !!(await until(async () => (await text(loc)).includes(want), HUNG_MS)), await text(loc))
        await shoot(loc, `${name}-${language}`)
      }
      await speak(english)
    }
    const repo = await section('jjRepo')
    const refresh = () => repo.locator('[data-action="jj-refresh"]').first().click()
    const waiting = repo.locator(`[data-jj-integrate-card="${n}"]`)
    check('Waiting: the card, its change id, not in main yet', !!(await until(async () => (await waiting.locator('[data-jj-contained="notYet"]').count()) === 1 && (await text(waiting)).includes(change.slice(0, 12)) && /Not in main as of/.test(await text(waiting)), HUNG_MS)), await text(repo.locator('[data-jj-integrate]')))
    await shoot(repo.locator('[data-jj-integrate]'), 'waiting')
    await inEach(repo.locator('[data-jj-integrate]'), 'waiting', (cat) => cat['jj.integrate.head'])
    // The record changes (an observation that couldn't say): Refresh shows it, the panel still mounted. The candidate
    // (HI-2871) is built first, and its own jj operations schedule further reconciliations, each recording a newer
    // observation: the changed one is written once it is shown, as the newest by far, so none of theirs replaces it.
    check('…its candidate built (HI-2871)', !!(await until(async () => (await waiting.locator('[data-jj-candidate="ready"]').count()) === 1, HUNG_MS)), await text(waiting))
    const pid = JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).id
    const ckey = `jj_contained:${pid.toLowerCase()}:${key.toLowerCase()}:1`
    onDb((db) => {
      const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(ckey)
      const v = JSON.parse(r.value)
      db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...v, gen: v.gen + 1000000, state: 'unknown', why: 'refused: notFetched' }), ckey)
    })
    check('…a changed observation shown with no Refresh (the board changed: couldn’t check, why)', !!(await until(async () => (await waiting.locator('[data-jj-contained="unknown"]').count()) === 1 && /hasn.t fetched/.test(await text(waiting)), HUNG_MS)), await text(waiting))
    await shoot(repo.locator('[data-jj-integrate]'), 'waiting-unknown')

    // --- Publish records to check and Leftovers follow changes while mounted: none yet, as read before anything changes.
    check('nothing to check or left over yet', (await repo.locator('[data-jj-to-check]').count()) === 0 && (await repo.locator('[data-jj-leftovers]').count()) === 0)
    const kept = path.join(work, 'leftover-kept')
    fs.mkdirSync(path.join(kept, 'ws'), { recursive: true })
    fs.writeFileSync(path.join(kept, 'ws', 'notes.txt'), 'kept\n')
    onDb((db) => {
      const seen = JSON.stringify({ remote: 'origin', url: 'u', pushed: '1'.repeat(40), head: '1'.repeat(40), op: 'a'.repeat(128), print: 'p', at: Date.now() - 3600e3 })
      db.prepare(`INSERT INTO jj_obligations (project, card, cycle, bundle, target, result, since, state, pushed, at, seq, seen, "check") VALUES (?, 'SH-90', 1, 'b1sh90', 'main', ?, 1, 'checkThis', ?, 5, 1, ?, ?)`).run(pid, '1'.repeat(40), '1'.repeat(40), seen, JSON.stringify({ was: 'published', differs: [{ what: 'inRemote', was: 'yes', now: 'no' }], at: 100 }))
      const k = `jj_control:${shop.toLowerCase()}`
      const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(k)
      const v = r ? JSON.parse(r.value) : { phase: 'idle' }
      db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify({ ...v, residues: [...(v.residues ?? []), { path: kept, why: 'notEmpty' }] }))
    })
    // The flagged record, written from another connection (as the publish worker's): the board's poll tells the window,
    // and the panel shows it with no Refresh. The leftover (a journal entry, no board change of the window's) on Refresh.
    check('…the flagged record shown with no Refresh (the board changed)', !!(await until(async () => (await repo.locator('[data-jj-to-check-row="SH-90"]').count()) === 1, HUNG_MS)), await text(repo))
    await refresh()
    check('…Refresh: the leftover shown', !!(await until(async () => (await repo.locator('[data-jj-leftover]').count()) === 1, HUNG_MS)), await text(repo))
    fs.rmSync(kept, { recursive: true })
    await refresh()
    check('…the leftover removed by the user: gone from the list on Refresh', !!(await until(async () => (await repo.locator('[data-jj-leftovers]').count()) === 0, HUNG_MS)), await text(repo))

    // --- The user integrates it: Done; the Work section's jj rows.
    jj(shop, 'bookmark', 'set', 'main', '-r', P)
    check('the user moves main onto it: Done', !!(await until(async () => (await card(n))?.column === 'done', HUNG_MS)), (await card(n))?.column)
    await refresh()
    check('…and Waiting no longer lists it', !!(await until(async () => (await waiting.count()) === 0, HUNG_MS)))
    await quiet.evaluate((el) => el.remove())
    await showBoard(page)
    const dialog = await openByTitle(page, n)
    const workSection = page.locator('.card-work[data-work="recorded"]')
    const wt = async () => text(workSection)
    check('the Work section: its Workspace in its line’s place, its change id, proved in its history', !!(await until(async () => /Workspace/.test(await wt()) && (await wt()).includes(w1.workspace) && (await workSection.locator(`[data-change="${change}"]`).count()) >= 1 && /found in its history/.test(await wt()) && !/Branch/.test(await wt()), HUNG_MS)), await wt())
    await shoot(workSection, 'work')
    await inEach(workSection, 'work', (cat) => cat['board.work.workspace'])
    await page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    void dialog

    // --- A stale slot: its working-copy commit rewritten from the project folder; Recover… keeps its unrecorded edit.
    // The prerequisite: nothing works in the slot (recovery's own condition, which it checks again and refuses with
    // "something works in it"). After Done, B1 is stopped: its session was the slot's.
    await inv('session:stop', shop, b1.id)
    const stopped = await until(async () => !(await live(b1.id)) || (await live(b1.id))?.status === 'exited', HUNG_MS)
    check('B1 stopped: nothing works in the slot', !!stopped, JSON.stringify(await live(b1.id)))
    if (!stopped) throw new Error('B1 never stopped')
    // HI-2906: the slot goes back to the pool by itself once its builder has left (detached at main; a slot's state is
    // `ready` when not lent), the pool's settle retried while the session was still leaving.
    // Its bound: the retries' pauses grow to 30 s, and the folder can stay in use for a while after its builder's process
    // has gone (seen: over 30 s), so two of the longest pauses beyond the usual bound.
    const back = await until(async () => {
      const s = (await inv('slots:list', shop)).find((x) => x.name === slot)
      return s && s.state === 'ready' ? s : null
    }, HUNG_MS * 2)
    check('after Done, the slot is back in the pool (ready, not lent)', !!back, JSON.stringify(await inv('slots:list', shop)))
    // What held it meanwhile, as the app logged each retry (HI-2906), for the record.
    const appLog = path.join(userData, 'logs', 'combwork.log')
    for (const l of (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '').split(/\r?\n/).filter((x) => /isn't quiet|detaching|detached/.test(x))) console.log(`INFO app: ${l.slice(0, 300)}`)
    // Not back: the processes still naming this run's folders (read only, nothing ended), for what holds the slot.
    if (!back) {
      try {
        const ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${work.toLowerCase().replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
        for (const l of ps.split(/\r?\n/).filter(Boolean)) console.log(`INFO process: ${l.slice(0, 400)}`)
      } catch (e) {
        console.log(`INFO process listing failed: ${e}`)
      }
    }
    if (!back) throw new Error('the slot never came back to the pool')
    const wsName = w1.workspace
    fs.writeFileSync(path.join(w1.folder, 'draft.txt'), 'unrecorded\n')
    // HI-2996: an unrecorded edit of base.txt too, which the rewrite below also changes (deletes): an overlap, so Recover…
    // keeps the update and writes this version beside it.
    fs.writeFileSync(path.join(w1.folder, 'base.txt'), 'mine\n')
    // The slot's working-copy commit rewritten from the project folder, its own working copy untouched (a write of its
    // checkout state can race Combwork's reads there on Windows: Access is denied).
    jj(shop, '--ignore-working-copy', 'describe', '-r', `${wsName}@`, '-m', 'rewritten elsewhere')
    jj(shop, '--ignore-working-copy', 'restore', '--from', 'root()', '--into', `${wsName}@`, 'base.txt')
    check('the slot is stale', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot)?.stale === true, HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))
    await toProject()
    await section('workflow')
    const row = page.locator(`[data-slot="${slot}"]`)
    check('Slots and copies: Stale, with Recover…', !!(await until(async () => (await row.locator('[data-stale]').count()) === 1 && (await row.locator('[data-action="recover"]').count()) === 1, HUNG_MS)), await text(row))
    await row.scrollIntoViewIfNeeded()
    await shoot(row, 'slot-stale')
    await inEach(row, 'slot-stale', (cat) => cat['workflow.slots.recover'])
    await row.locator('[data-action="recover"]').click()
    const ask = page.locator('.dialog').filter({ hasText: `Recover ${slot}?` })
    check('…the confirmation names the folder its unrecorded edits go to', !!(await until(async () => (await ask.count()) === 1 && (await text(ask)).includes(`.cw-recovery`) && (await text(ask)).includes(slot), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(ask, 'recover-confirm')
    await ask.getByRole('button', { name: 'Recover', exact: true }).click()
    // HI-2996: what it did, in a window: the copy it wrote beside base.txt (your version), the other file put back.
    const did = page.locator('.dialog').filter({ hasText: `${slot} is recovered: look at these` })
    const copyName = () => (fs.existsSync(w1.folder) ? fs.readdirSync(w1.folder).find((f) => f.startsWith('base.txt.cw-recovered-')) : undefined)
    check('…what it did shows: the copy written beside base.txt, by its path, and the other file put back', !!(await until(async () => (await did.count()) === 1 && !!copyName() && (await text(did)).includes(path.join(w1.folder, copyName())) && /1 other file was put back as it was/.test(await text(did)), HUNG_MS)), await text(page.locator('.dialog')))
    check('…the copy holds your version', copyName() !== undefined && fs.readFileSync(path.join(w1.folder, copyName()), 'utf8') === 'mine\n')
    check('…one button, no Cancel', (await did.getByRole('button', { name: 'Cancel' }).count()) === 0 && (await did.getByRole('button', { name: 'OK', exact: true }).count()) === 1)
    await shoot(did, 'recover-did')
    await did.getByRole('button', { name: 'OK', exact: true }).click()
    check('…recovered: not stale any more, the edit kept aside', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot)?.stale !== true, HUNG_MS)) && fs.existsSync(path.join(path.dirname(w1.folder), '.cw-recovery', slot)), await text(page.locator('body')))
    const aside = path.join(path.dirname(w1.folder), '.cw-recovery', slot)
    const kept2 = fs.existsSync(aside) ? fs.readdirSync(aside, { recursive: true }).some((f) => String(f).endsWith('draft.txt')) || fs.existsSync(path.join(w1.folder, 'draft.txt')) : false
    check('…its unrecorded edit is kept', kept2, fs.existsSync(aside) ? JSON.stringify(fs.readdirSync(aside, { recursive: true })) : 'no aside folder')
    check('…and Recover… is gone from its row', !!(await until(async () => (await row.locator('[data-action="recover"]').count()) === 0, HUNG_MS)), await text(row))
    if (NC) check('not colocated throughout: no .git in the project folder or its slot', !fs.existsSync(path.join(shop, '.git')) && !fs.existsSync(path.join(w1.folder, '.git')))

    // --- HI-2906: the next card gets that same slot. The user, having looked, removes the draft the recovery kept in the
    // slot (its copy is aside), then starts another card for B1.
    fs.rmSync(path.join(w1.folder, 'draft.txt'), { force: true })
    // HI-2996: and, having compared them, deletes the copy and puts base.txt back as main has it.
    for (const f of fs.readdirSync(w1.folder).filter((x) => x.includes('.cw-recovered-') || x.includes('.cw-before-recovery-'))) fs.rmSync(path.join(w1.folder, f), { force: true })
    fs.writeFileSync(path.join(w1.folder, 'base.txt'), 'base\n')
    const n2 = (await inv('tasks:create', { title: 'Shop second', project: 'shop', agent: b1.id })).number
    const started2 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: the next card' }).catch((e) => ({ error: String(e) }))
    const w2 = await until(async () => {
      const v = await inv('tasks:work', n2)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check('the next card starts in that same slot', !!w2 && w2.folder.toLowerCase() === w1.folder.toLowerCase() && w2.workspace === w1.workspace, JSON.stringify({ started2, w2, slots: await inv('slots:list', shop) }))
    check('…lent to it', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot)?.state === 'lent', HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))

    // HI-2995: B1 commits work for card 2 there; the user puts the card back and stops B1: the slot is kept for that card
    // (not lent with no lease), Slots and copies says so, and the card started again gets that slot back with its work.
    // B1 is given the card once its slot is prepared for it (its binding card 2's): only then does it work there.
    const given = new RegExp(`Giving \\S*B1\\S* #${n2} in`)
    check('card 2 given to B1 in its prepared slot', !!(await until(async () => fs.existsSync(appLog) && given.test(fs.readFileSync(appLog, 'utf8')), HUNG_MS)), JSON.stringify(await inv('tasks:work', n2)))
    fs.writeFileSync(path.join(w2.folder, 'second.txt'), 'second\n')
    jj(w2.folder, 'commit', '-m', 'second work')
    const keptCommit = jj(w2.folder, 'log', '--no-graph', '-r', `${w2.workspace}@-`, '-T', 'commit_id').trim()
    const back2 = await inv('tasks:move', n2, 'todo', { confirm: true, reason: 'jjwindow: put back' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    const keptRow = await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot && s.keptFor === n2 && s.state === 'dirty' && !s.lease) ?? null, HUNG_MS)
    check('card 2 put back with its commit: the slot kept for it, no lease', !!keptRow, JSON.stringify({ back2, slots: await inv('slots:list', shop) }))
    // Slots and copies reads its list as it opens: opened again (it was still open from the stale slot above).
    await toProject()
    await section('jjRepo')
    await section('workflow')
    check('Slots and copies: Kept for card 2', !!(await until(async () => (await row.locator(`[data-kept-for="${n2}"]`).count()) === 1, HUNG_MS)), await text(row))
    await row.scrollIntoViewIfNeeded()
    await shoot(row, 'slot-kept')
    await inEach(row, 'slot-kept', (cat) => (cat['workflow.slots.keptFor'] ?? '').split('{card}').pop().replace(/^[\s:：、，]+/, '').slice(0, 12))
    const started3 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: card 2 again' }).catch((e) => ({ error: String(e) }))
    const w3 = await until(async () => {
      const v = await inv('tasks:work', n2)
      return v?.folder && v.workspace && v.folder.toLowerCase() === w1.folder.toLowerCase() ? v : null
    }, HUNG_MS)
    check('card 2 started again: the same slot back, with its commit', !!w3 && jj(w1.folder, '--ignore-working-copy', 'log', '--no-graph', '-r', `${keptCommit} & ::${w1.workspace}@`, '-T', 'commit_id').trim() === keptCommit, JSON.stringify({ started3, w3, slots: await inv('slots:list', shop) }))

    // HI-3032: put back again and its folder deleted: Slots and copies says it is kept but its folder is missing, with
    // Remove…; confirmed (the work's last commit named), the slot goes and its commit stays in jj's store.
    const key2 = (await card(n2)).key
    const back3 = await inv('tasks:move', n2, 'todo', { confirm: true, reason: 'jjwindow: put back again' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    check('card 2 put back again: kept for it', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot && s.keptFor === n2 && s.state === 'dirty' && !s.lease) ?? null, HUNG_MS)), JSON.stringify({ back3, slots: await inv('slots:list', shop) }))
    const goneRow = await until(async () => {
      try {
        fs.rmSync(w1.folder, { recursive: true, force: true })
      } catch {
        return null // a file still open there for a moment (Windows): tried again
      }
      // A pool's look (its refresh) sees the folder gone.
      await inv('slots:test', shop, { op: 'tidy' })
      return (await inv('slots:list', shop)).find((s) => s.name === slot && s.state === 'gone' && s.keptFor === n2 && s.keptGone) ?? null
    }, HUNG_MS)
    check('its folder deleted: gone, still kept for card 2, its work recorded', !!goneRow && goneRow.keptGone.commit === keptCommit, JSON.stringify(await inv('slots:list', shop)))
    await toProject()
    await section('jjRepo')
    await section('workflow')
    check('Slots and copies: kept, folder missing, with Remove…', !!(await until(async () => (await row.locator('[data-action="remove-kept"]').count()) === 1 && /Folder missing/.test(await text(row)) && /but its folder is missing/.test(await text(row)), HUNG_MS)), await text(row))
    await row.scrollIntoViewIfNeeded()
    await shoot(row, 'slot-kept-gone')
    await inEach(row, 'slot-kept-gone', (cat) => cat['workflow.slots.removeKept'])
    await row.locator('[data-action="remove-kept"]').click()
    const askRemove = page.locator('.dialog').filter({ hasText: `Remove ${slot}?` })
    check('…the confirmation names the card and its last commit', !!(await until(async () => (await askRemove.count()) === 1 && (await text(askRemove)).includes(key2) && (await text(askRemove)).includes(keptCommit.slice(0, 7)), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(askRemove, 'remove-kept-confirm')
    await askRemove.getByRole('button', { name: 'Remove', exact: true }).click()
    check('…removed: the slot gone, its commit still in jj’s store', !!(await until(async () => !(await inv('slots:list', shop)).some((s) => s.name === slot), HUNG_MS)) && id(shop, keptCommit) === keptCommit, JSON.stringify(await inv('slots:list', shop)))
    check('…said so', !!(await until(async () => (await text(page.locator('.toasts'))).includes(`${slot} is removed.`), HUNG_MS)), await text(page.locator('.toasts')))

    // HI-3097: card 2 again in a new slot, put back with a commit, its workspace then forgotten by the user (its folder
    // left, an edit in it): Slots and copies says jj no longer lists it, with Remove…; confirmed (the Recycle Bin named),
    // the folder goes, its commit stays in jj's store.
    const givenCount = () => (fs.existsSync(appLog) ? (fs.readFileSync(appLog, 'utf8').match(new RegExp(given.source, 'g')) ?? []).length : 0)
    const givenBefore = givenCount()
    const started4 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: card 2 afresh' }).catch((e) => ({ error: String(e) }))
    // Lent and prepared for card 2 (B1 given it there), as above: only then is a commit there card 2's work.
    const w4 = await until(async () => {
      const v = await inv('tasks:work', n2)
      const lent = v?.folder && v.workspace ? (await inv('slots:list', shop)).find((s) => s.folder.toLowerCase() === v.folder.toLowerCase() && s.state === 'lent' && s.lease?.card === n2) : null
      return lent && givenCount() > givenBefore ? v : null
    }, HUNG_MS)
    check('card 2 started afresh in a slot, given to B1 there', !!w4, JSON.stringify({ started4, work: await inv('tasks:work', n2), slots: await inv('slots:list', shop) }))
    const slot4 = path.basename(w4.folder)
    fs.writeFileSync(path.join(w4.folder, 'fourth.txt'), 'fourth\n')
    jj(w4.folder, 'commit', '-m', 'fourth work')
    const forgotCommit = jj(w4.folder, 'log', '--no-graph', '-r', `${w4.workspace}@-`, '-T', 'commit_id').trim()
    const back4 = await inv('tasks:move', n2, 'todo', { confirm: true, reason: 'jjwindow: put back, then forgotten' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    check('card 2 put back: kept for it', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot4 && s.keptFor === n2 && s.state === 'dirty' && !s.lease) ?? null, HUNG_MS)), JSON.stringify({ back4, slots: await inv('slots:list', shop) }))
    jj(shop, 'workspace', 'forget', w4.workspace)
    fs.writeFileSync(path.join(w4.folder, 'edit.txt'), 'not committed\n')
    const forgotRow = await until(async () => {
      await inv('slots:test', shop, { op: 'tidy' })
      return (await inv('slots:list', shop)).find((s) => s.name === slot4 && s.state === 'gone' && s.keptFor === n2 && s.keptGone?.forgotten) ?? null
    }, HUNG_MS)
    check('its workspace forgotten: gone, its folder there, still kept for card 2', !!forgotRow && fs.existsSync(w4.folder), JSON.stringify(await inv('slots:list', shop)))
    await toProject()
    await section('jjRepo')
    await section('workflow')
    check('Slots and copies: kept, not listed by jj (never "Folder missing"), with Remove…', !!(await until(async () => (await row.locator('[data-action="remove-kept"]').count()) === 1 && /Not listed by jj/.test(await text(row)) && !/Folder missing/.test(await text(row)) && /but jj no longer lists its workspace/.test(await text(row)), HUNG_MS)), await text(row))
    await row.scrollIntoViewIfNeeded()
    await shoot(row, 'slot-kept-forgotten')
    await inEach(row, 'slot-kept-forgotten', (cat) => (cat['workflow.slots.keptForgottenFor'] ?? '').split('{card}').pop().replace(/^[\s:：、，]+/, '').slice(0, 12))
    await row.locator('[data-action="remove-kept"]').click()
    const askForgot = page.locator('.dialog').filter({ hasText: `Remove ${slot4}?` })
    check('…the confirmation names the Recycle Bin, the card and its last commit', !!(await until(async () => (await askForgot.count()) === 1 && /Recycle Bin/.test(await text(askForgot)) && (await text(askForgot)).includes(key2) && (await text(askForgot)).includes(forgotCommit.slice(0, 7)), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(askForgot, 'remove-forgotten-confirm')
    await askForgot.getByRole('button', { name: 'Remove', exact: true }).click()
    check('…removed: the slot and its folder gone, its commit still in jj’s store', !!(await until(async () => !(await inv('slots:list', shop)).some((s) => s.name === slot4) && !fs.existsSync(w4.folder), HUNG_MS)) && id(shop, forgotCommit) === forgotCommit, JSON.stringify(await inv('slots:list', shop)))

    // HI-3096 (Darren's decision (a), 12 Nov): with the repository's snapshot.auto-track narrowed, a new file jj doesn't
    // track is the slot's work. B1's submission is refused naming the setting; put back, the slot shows it has changes
    // and the pool's removal (Changes → Unused worktrees' Remove for a colocated slot) refuses it, the file kept.
    jj(shop, 'config', 'set', '--repo', 'snapshot.auto-track', 'none()')
    // A card of its own: the shop has no slot now (the last one removed above), so it gets a new one.
    const n3 = (await inv('tasks:create', { title: 'Shop untracked', project: 'shop', agent: b1.id })).number
    const key3 = (await card(n3)).key
    const givenRe3 = new RegExp(`Giving \\S*B1\\S* #${n3} in`, 'g')
    const given3 = () => (fs.existsSync(appLog) ? (fs.readFileSync(appLog, 'utf8').match(givenRe3) ?? []).length : 0)
    const started6 = await inv('tasks:move', n3, 'doing', { confirm: true, reason: 'jjwindow: a card with auto-track none()' }).catch((e) => ({ error: String(e) }))
    const w6 = await until(async () => {
      const v = await inv('tasks:work', n3)
      const lent = v?.folder && v.workspace ? (await inv('slots:list', shop)).find((s) => s.folder.toLowerCase() === v.folder.toLowerCase() && s.state === 'lent' && s.lease?.card === n3) : null
      return lent && given3() > 0 ? v : null
    }, HUNG_MS)
    check('a new card started in a slot under auto-track none(), given to B1', !!w6, JSON.stringify({ started6, slots: await inv('slots:list', shop) }))
    const slot6 = path.basename(w6.folder)
    fs.writeFileSync(path.join(w6.folder, 'untracked-notes.txt'), 'never tracked\n')
    const sub6 = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key3)}/submit`, { summary: 'Done.' })
    console.log(`INFO HI-3096 submit under auto-track none(): ${sub6.status} ${JSON.stringify(sub6.body)}`)
    check('…B1\'s submission refused, naming snapshot.auto-track and none()', sub6.status !== 200 && /snapshot\.auto-track/.test(JSON.stringify(sub6.body)) && /none\(\)/.test(JSON.stringify(sub6.body)), JSON.stringify(sub6.body))
    const back6 = await inv('tasks:move', n3, 'todo', { confirm: true, reason: 'jjwindow: put back with an untracked file' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    check('…put back: the slot dirty (the untracked file), not lent', !!(await until(async () => { const s = (await inv('slots:list', shop)).find((x) => x.name === slot6); return s && !s.lease && !s.writer && s.state === 'dirty' ? s : null }, HUNG_MS)), JSON.stringify({ back6, slots: await inv('slots:list', shop) }))
    await toProject()
    await section('jjRepo')
    await section('workflow')
    const row6 = page.locator(`[data-slot="${slot6}"]`)
    // Its card's own uncommitted work beside its binding: kept for that card (HI-2995), so its next start gets it back.
    check(`Slots and copies: kept for ${key3}, not ready`, !!(await until(async () => new RegExp(`Kept for ${key3}`).test(await text(row6)) && !/Ready/.test(await text(row6)), HUNG_MS)), await text(row6))
    await row6.scrollIntoViewIfNeeded()
    await shoot(row6, 'slot-untracked-dirty')
    const removed6 = await inv('slots:test', shop, { op: 'remove', slot: slot6 })
    console.log(`INFO HI-3096 the pool's removal: ${JSON.stringify(removed6)}`)
    check('…the pool\'s removal refuses it as dirty, the untracked file kept', removed6?.why === 'dirty' && fs.existsSync(path.join(w6.folder, 'untracked-notes.txt')), JSON.stringify(removed6))
    jj(shop, 'config', 'set', '--repo', 'snapshot.auto-track', 'all()')
    // Tidied for the next step: the file gone, the slot settled ready again (card 2 is lent it next).
    fs.rmSync(path.join(w6.folder, 'untracked-notes.txt'), { force: true })
    check('…the file gone: the slot ready again', !!(await until(async () => {
      await inv('slots:test', shop, { op: 'tidy' })
      return (await inv('slots:list', shop)).find((s) => s.name === slot6 && s.state === 'ready') ?? null
    }, HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))

    // HI-3103: that slot, kept for no card, its workspace then forgotten by the user (its folder left): Slots and copies
    // says jj no longer lists it, with Remove…; confirmed (the Recycle Bin named), the slot and its folder go.
    jj(shop, 'workspace', 'forget', w6.workspace)
    await toProject()
    await section('jjRepo')
    await section('workflow')
    check('Slots and copies: a free slot not listed by jj, with Remove…', !!(await until(async () => (await row6.locator('[data-action="remove-forgotten"]').count()) === 1 && /Not listed by jj/.test(await text(row6)), HUNG_MS)), await text(row6))
    await row6.scrollIntoViewIfNeeded()
    await shoot(row6, 'slot-forgotten-free')
    await row6.locator('[data-action="remove-forgotten"]').click()
    const askFree = page.locator('.dialog').filter({ hasText: `Remove ${slot6}?` })
    check('…the confirmation: jj no longer lists it, its folder to the Recycle Bin with any changes', !!(await until(async () => (await askFree.count()) === 1 && /jj no longer lists/.test(await text(askFree)) && /Recycle Bin/.test(await text(askFree)), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(askFree, 'remove-forgotten-free-confirm')
    await askFree.getByRole('button', { name: 'Remove', exact: true }).click()
    // A process still leaving the folder (B1's stopped session) refuses it for now (`process`): the user tries again.
    check('…removed: the slot and its folder gone', !!(await until(async () => {
      if (!(await inv('slots:list', shop)).some((s) => s.name === slot6) && !fs.existsSync(w6.folder)) return true
      if ((await row6.locator('[data-action="remove-forgotten"]').count()) === 1 && (await page.locator('.dialog').count()) === 0) {
        // The row may go as it is clicked (the removal under way): a short try, never a wait.
        await row6.locator('[data-action="remove-forgotten"]').click({ timeout: 2000 }).catch(() => undefined)
        await page.locator('.dialog').filter({ hasText: `Remove ${slot6}?` }).getByRole('button', { name: 'Remove', exact: true }).click({ timeout: 2000 }).catch(() => undefined)
      }
      return null
    }, HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))

    // HI-3099: card 2 afresh in a slot, an unrecorded edit left there, put back; then the user commits twice in the
    // project folder and discards old operations (`jj op abandon`). The slot shows stale with Recover…, which mends it with
    // the edit kept; the project folder's files are as the user left them, and theirs to use.
    const givenBefore5 = givenCount()
    const started5 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: card 2, then op abandon' }).catch((e) => ({ error: String(e) }))
    const w5 = await until(async () => {
      const v = await inv('tasks:work', n2)
      const lent = v?.folder && v.workspace ? (await inv('slots:list', shop)).find((s) => s.folder.toLowerCase() === v.folder.toLowerCase() && s.state === 'lent' && s.lease?.card === n2) : null
      return lent && givenCount() > givenBefore5 ? v : null
    }, HUNG_MS)
    check('card 2 started in a slot, given to B1 there', !!w5, JSON.stringify({ started5, work: await inv('tasks:work', n2), slots: await inv('slots:list', shop) }))
    const slot5 = path.basename(w5.folder)
    fs.writeFileSync(path.join(w5.folder, 'wip.txt'), 'unrecorded before the abandon\n')
    const back5 = await inv('tasks:move', n2, 'todo', { confirm: true, reason: 'jjwindow: put back before op abandon' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    // Not lent, B1's run no longer writing there (Recover… refuses a slot something works in: busy), and its settle done
    // (dirty: the edit recorded), so the user's commands below never race Combwork's own record of the slot.
    check('card 2 put back: its slot settled dirty, nothing writing in it', !!(await until(async () => { const s = (await inv('slots:list', shop)).find((x) => x.name === slot5); return s && !s.lease && !s.writer && s.state === 'dirty' ? s : null }, HUNG_MS)), JSON.stringify({ back5, slots: await inv('slots:list', shop) }))
    const shopFiles = () => Object.fromEntries(fs.readdirSync(shop).filter((f) => f !== '.jj' && f !== '.git' && fs.statSync(path.join(shop, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(shop, f), 'utf8')]))
    fs.writeFileSync(path.join(shop, 'user-a.txt'), 'a\n')
    jj(shop, 'commit', '-m', 'the user’s a')
    fs.writeFileSync(path.join(shop, 'user-b.txt'), 'b\n')
    jj(shop, 'commit', '-m', 'the user’s b')
    jj(shop, 'op', 'abandon', '..@-')
    const shopBefore = shopFiles()
    const shopBookmarks = jj(shop, '--ignore-working-copy', 'bookmark', 'list')
    check('after the abandon, the slot is stale', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot5)?.stale === true, HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))
    // Slots and copies reads its list as it opens: opened again, as above.
    await toProject()
    await section('jjRepo')
    await section('workflow')
    const row5 = page.locator(`[data-slot="${slot5}"]`)
    check('Slots and copies: Stale, with Recover…', !!(await until(async () => (await row5.locator('[data-stale]').count()) === 1 && (await row5.locator('[data-action="recover"]').count()) === 1, HUNG_MS)), await text(row5))
    await row5.scrollIntoViewIfNeeded()
    await shoot(row5, 'slot-stale-abandoned')
    await row5.locator('[data-action="recover"]').click()
    const ask5 = page.locator('.dialog').filter({ hasText: `Recover ${slot5}?` })
    check('…its confirmation', !!(await until(async () => (await ask5.count()) === 1, HUNG_MS)), await text(page.locator('.dialog')))
    await ask5.getByRole('button', { name: 'Recover', exact: true }).click()
    const recovered5 = await until(async () => {
      const did5 = page.locator('.dialog').filter({ hasText: `${slot5} is recovered` })
      if ((await did5.count()) === 1) await did5.getByRole('button', { name: 'OK', exact: true }).click()
      return (await inv('slots:list', shop)).find((s) => s.name === slot5 && s.stale !== true) ?? null
    }, HUNG_MS)
    check('…recovered: not stale any more, its edit in the folder', !!recovered5 && fs.existsSync(path.join(w5.folder, 'wip.txt')) && fs.readFileSync(path.join(w5.folder, 'wip.txt'), 'utf8') === 'unrecorded before the abandon\n', JSON.stringify({ slots: await inv('slots:list', shop), toasts: await text(page.locator('.toasts')) }))
    check('…the project folder as the user left it, its bookmarks too, and jj works there', JSON.stringify(shopFiles()) === JSON.stringify(shopBefore) && jj(shop, '--ignore-working-copy', 'bookmark', 'list') === shopBookmarks && /Working copy/.test(jj(shop, 'status')), JSON.stringify({ before: shopBefore, now: shopFiles() }))

    // HI-3132: card 2's work is kept in its slot (the recovered edit above), and that slot can't be lent now (a run still
    // writing there: this suite's own process, recorded as its writer). The user drags card 2 to Doing; the board asks to
    // start it across the slot's rule; Move Anyway is refused naming the slot: never started where B1 is (the project
    // folder) without that work, which stays in the slot.
    const kept7 = await until(async () => (await inv('slots:list', shop)).find((s) => s.keptFor === n2 && !s.lease) ?? null, HUNG_MS)
    check('card 2: its work kept in its slot', !!kept7, JSON.stringify(await inv('slots:list', shop)))
    const keptFiles7 = fs.readdirSync(kept7.folder).filter((f) => f !== '.jj' && f !== '.git').sort()
    const held7 = await inv('slots:test', shop, { op: 'writer', slot: kept7.name, agent: b1.id, run: 'hi3132-probe', pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000) })
    check('…that slot held: a run still writing in it', held7 === true, JSON.stringify(held7))
    await page.getByRole('button', { name: 'Task Board' }).click()
    const tile7 = page.locator(`.task-card[data-task="${n2}"]`)
    const doing7 = page.locator('.board-column[data-column="doing"]')
    check('…card 2 on the board, in To Do', !!(await until(async () => (await tile7.count()) === 1 && (await tile7.evaluate((e) => e.closest('.board-column')?.getAttribute('data-column')).catch(() => null)) === 'todo', HUNG_MS)))
    await tile7.dragTo(doing7.locator('.board-column-body'))
    // The board's Move to Active: given to B1 and started (Assign and start), as the user starts a card.
    const move7 = page.locator('.dialog', { hasText: `Move ${key2} to Active` })
    check('…the board asks whom to give it to', !!(await until(async () => (await move7.count()) === 1, HUNG_MS)), await text(page.locator('body')))
    await move7.getByText('Assign and start', { exact: true }).click()
    // With Assign and start chosen, the dialog's button is Start.
    await move7.getByRole('button', { name: 'Start', exact: true }).click()
    // Refused in the dialog naming the slot, with no Move Anyway offered: the refusal is the start's own, never a rule
    // an override skips (the slot rule's wait would have offered one).
    const refused7 = move7.filter({ hasText: `kept in slot ${kept7.name}, and it starts only in that slot` })
    check('…refused in the dialog, naming the slot, nothing to start anyway', !!(await until(async () => (await refused7.count()) === 1, HUNG_MS)) && (await page.locator('.dialog', { hasText: 'anyway?' }).count()) === 0, await text(page.locator('body')))
    await shoot(refused7, 'kept-elsewhere-refused')
    console.log(`INFO HI-3132 refusal shown: ${(await refused7.innerText().catch(() => '')).replace(/\s+/g, ' ')}`)
    await refused7.getByRole('button', { name: 'Cancel' }).click()
    const facts7 = (await inv('tasks:facts', n2)).map((f) => f.kind)
    const work7 = await inv('tasks:work', n2).catch(() => null)
    check('…card 2 not started: still To Do, no Started since, not placed in the project folder', (await card(n2))?.column === 'todo' && !(work7?.folder && work7.folder.toLowerCase() === shop.toLowerCase()), JSON.stringify({ column: (await card(n2))?.column, work7, last: facts7.slice(-3) }))
    check('…its kept work still in the slot, still kept for it', JSON.stringify(fs.readdirSync(kept7.folder).filter((f) => f !== '.jj' && f !== '.git').sort()) === JSON.stringify(keptFiles7) && (await inv('slots:list', shop)).some((s) => s.name === kept7.name && s.keptFor === n2), JSON.stringify(await inv('slots:list', shop)))

    // HI-3129 (Darren's decision (a), 13 Nov): the project's target changed to a new bookmark `next` while card 2's work
    // is kept in its slot on main. Its dialog's Merges into lists the repository's bookmarks (`release-x`, in no Other
    // branches), and its start carries on in the kept slot on main, never refused for the target.
    onDb((db) => db.prepare('UPDATE slots SET writer_run = NULL, writer_lease = NULL, writer_agent = NULL, writer_pid = NULL, writer_started = NULL WHERE name = ?').run(kept7.name))
    jj(shop, 'bookmark', 'create', 'next', '-r', 'main')
    jj(shop, 'bookmark', 'create', 'release-x', '-r', 'main')
    // HI-3152: the user changes Work merges into to next in the Workflow tab and opens Save…: its Retarget lists card 2 and
    // its kept slot as staying on main, each with its reason (`kept`), read through jj, and nothing that jj can't move.
    // Screenshots in both themes, and in each language. Then Save.
    await toProject()
    await section('jjRepo')
    await section('workflow')
    const form8 = page.locator('.workflow-form')
    const targetInput8 = form8.locator('.workflow-option[data-option="target"] input')
    await targetInput8.waitFor({ timeout: HUNG_MS })
    await targetInput8.fill('next')
    await targetInput8.press('Enter')
    await form8.locator('[data-action="save"]').click()
    const save8 = page.locator('.dialog', { has: page.locator('.workflow-save') })
    await save8.waitFor({ timeout: HUNG_MS })
    const retarget8 = save8.locator('[data-retarget]')
    const keptCard8 = retarget8.locator(`[data-retarget-keep="${key2}"]`)
    const keptSlot8 = retarget8.locator(`[data-retarget-keep="${kept7.name}"]`)
    check("Save…'s Retarget: card 2 and its slot listed as staying on main, its work kept there", !!(await until(async () => /These stay on main/.test(await text(retarget8)) && /its work is kept on main/.test(await text(keptCard8)) && (await text(keptCard8)).includes(key2) && /its work is kept on main/.test(await text(keptSlot8)), HUNG_MS)), await text(save8))
    check('…nothing listed to move (no lane, started card or slot)', (await retarget8.locator('[data-retarget-move]').count()) === 0, await text(retarget8))
    await shoot(retarget8, 'retarget-kept')
    // A translated screen: Save… shows the language it was opened in, so it is closed, the window spoken to in German,
    // and opened again; then back in English for the save.
    const reopen8 = async () => {
      await page.keyboard.press('Escape')
      await save8.waitFor({ state: 'detached', timeout: HUNG_MS })
      await form8.locator('[data-action="save"]').click()
      await save8.waitFor({ timeout: HUNG_MS })
    }
    const de8 = catalogue('de')
    const deKept8 = (/\bkept \{([^}]*)\{from\}/.exec(de8['workflow.form.retargetKeep'] ?? '') ?? [])[1]?.trim() ?? ''
    await speak({ ...english, code: 'de', locale: 'de', messages: de8 })
    await reopen8()
    check('de: Save…\'s Retarget, card 2 and its slot staying, in German', !!deKept8 && !!(await until(async () => (await text(keptCard8)).includes(deKept8) && (await text(keptSlot8)).includes(deKept8), HUNG_MS)), await text(retarget8))
    await shoot(retarget8, 'retarget-kept-de')
    await speak(english)
    await reopen8()
    check('…in English again', !!(await until(async () => /its work is kept on main/.test(await text(keptCard8)), HUNG_MS)), await text(retarget8))
    await save8.getByRole('button', { name: 'Save', exact: true }).click()
    await save8.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('the project\'s target changed to next, saved from Save…', !!(await until(async () => (await inv('workflow:form', shop))?.options?.target === 'next' || (await inv('workflow:form', shop))?.effective?.target === 'next', HUNG_MS)), JSON.stringify(await inv('workflow:form', shop)).slice(0, 400))
    await showBoard(page)
    await openByTitle(page, n2)
    const field8 = page.locator('#card-target')
    const options8 = async () => (await field8.locator('option').allInnerTexts().catch(() => [])).map((s) => s.trim())
    check('card 2\'s Merges into lists the repository\'s bookmarks: main and release-x (in no Other branches), and next', !!(await until(async () => { const o = await options8(); return o.includes('release-x') && o.includes('main') && o.some((x) => /next/.test(x)) && !(await field8.isDisabled()) }, HUNG_MS)), JSON.stringify(await options8()))
    // HR2's round 1: the field shows the project's next, so beside it the dialog says where the kept card starts: main.
    const keptNote8 = page.locator('.card-target-kept')
    check('…and says its work is kept on main, where it starts again', !!(await until(async () => (await keptNote8.getAttribute('data-card-target-kept').catch(() => null)) === 'main' && /kept on main/.test(await text(keptNote8)), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(field8.locator('xpath=..'), 'card-target-bookmarks')
    await inEach(keptNote8, 'card-target-kept', (cat) => (cat['board.target.kept'] ?? '').split('{branch}')[0].trim().slice(0, 12))
    await page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    // A fresh card (no kept work): no such note; it starts on next.
    const n9 = (await inv('tasks:create', { title: 'Shop fresh after next', project: 'shop', agent: b1.id })).number
    await openByTitle(page, n9)
    check('a fresh card\'s dialog: Merges into the project\'s next, no kept note', !!(await until(async () => (await field8.count()) === 1 && /next/.test((await field8.locator('option:checked').innerText().catch(() => '')) ?? ''), HUNG_MS)) && (await page.locator('.card-target-kept').count()) === 0, await text(page.locator('.dialog')))
    await page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    const givenBefore8 = givenCount()
    const started8 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: card 2 after the target changed' }).catch((e) => ({ error: String(e) }))
    const w8 = await until(async () => {
      const v = await inv('tasks:work', n2)
      return v?.folder && v.folder.toLowerCase() === kept7.folder.toLowerCase() && givenCount() > givenBefore8 ? v : null
    }, HUNG_MS)
    const startedOn8 = ((await inv('tasks:facts', n2)) ?? []).filter((f) => f.kind === 'Started').pop()?.data?.target
    check('…card 2 started in its kept slot, on main (the bookmark its work is on), its work there', !!w8 && startedOn8 === 'main' && JSON.stringify(fs.readdirSync(kept7.folder).filter((f) => f !== '.jj' && f !== '.git').sort()) === JSON.stringify(keptFiles7), JSON.stringify({ started8, startedOn8, work: await inv('tasks:work', n2), slots: await inv('slots:list', shop) }))

    // HI-3134: card 2 put back, its slot settled; then the slot's own record of an edit (race.txt) races a write of the
    // user's from the operation before it (a describe of the slot's older commit), and jj's head ends up giving the slot
    // that older version, the folder's commit still beside it (the same change, divergent). Recover… changes nothing:
    // a window names both commits and says what to do; race.txt stays in the folder.
    const back9 = await inv('tasks:move', n2, 'todo', { confirm: true, reason: 'jjwindow: put back before a raced record' }).catch((e) => ({ error: String(e) }))
    await inv('session:stop', shop, b1.id)
    check('card 2 put back: its slot settled, nothing writing in it', !!(await until(async () => { const s = (await inv('slots:list', shop)).find((x) => x.name === kept7.name); return s && !s.lease && !s.writer && s.state === 'dirty' ? s : null }, HUNG_MS)), JSON.stringify({ back9, slots: await inv('slots:list', shop) }))
    const op9 = jj(shop, '--ignore-working-copy', 'op', 'log', '--no-graph', '-n', '1', '-T', 'id').trim()
    const E9 = id(kept7.folder, '@')
    fs.writeFileSync(path.join(kept7.folder, 'race.txt'), 'recorded in the race\n')
    jj(kept7.folder, 'status')
    const X9 = id(kept7.folder, '@')
    jj(shop, '--at-op', op9, '--ignore-working-copy', 'describe', '-r', E9, '-m', 'the user')
    const E9b = id(shop, 'description(exact:"the user\n")')
    jj(kept7.folder, '--ignore-working-copy', 'edit', E9b)
    check('…the slot stale, its folder\'s commit beside the one jj gives it', X9 !== E9b && !!(await until(async () => (await inv('slots:list', shop)).find((x) => x.name === kept7.name)?.stale === true, HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))
    await toProject()
    await section('jjRepo')
    await section('workflow')
    const row9 = page.locator(`[data-slot="${kept7.name}"]`)
    check('…Slots and copies: Stale, with Recover…', !!(await until(async () => (await row9.locator('[data-action="recover"]').count()) === 1, HUNG_MS)), await text(row9))
    await row9.locator('[data-action="recover"]').click()
    const ask9 = page.locator('.dialog').filter({ hasText: `Recover ${kept7.name}?` })
    check('…its confirmation', !!(await until(async () => (await ask9.count()) === 1, HUNG_MS)), await text(page.locator('.dialog')))
    await ask9.getByRole('button', { name: 'Recover', exact: true }).click()
    const refused9 = page.locator('.dialog').filter({ hasText: `${kept7.name} wasn’t recovered` })
    check('…refused in a window naming both commits, with how to look at them', !!(await until(async () => (await refused9.count()) === 1 && /divergent in jj/.test(await text(refused9)) && (await text(refused9)).includes(X9.slice(0, 8)) && (await text(refused9)).includes(E9b.slice(0, 8)) && /jj diff --from/.test(await text(refused9)), HUNG_MS)), await text(page.locator('.dialog')))
    await shoot(refused9, 'recover-divergent')
    console.log(`INFO HI-3134 refusal shown: ${(await refused9.innerText().catch(() => '')).replace(/\s+/g, ' ')}`)
    await refused9.getByRole('button', { name: 'OK', exact: true }).click()
    check('…race.txt still in the folder, the slot still stale, both commits still in jj', fs.existsSync(path.join(kept7.folder, 'race.txt')) && (await inv('slots:list', shop)).find((x) => x.name === kept7.name)?.stale === true && id(shop, X9) === X9 && id(kept7.folder, '@') === E9b, JSON.stringify(await inv('slots:list', shop)))

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
