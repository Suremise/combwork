// The window for jj cards (HI-2869, J9c; SPEC "The window for jj cards"): the real app, the pinned jj (npm run jj:fetch)
// on its PATH, a fake Claude Code builder (B1), a throwaway profile and workspace. jj cards start here before J9e through
// the unpackaged seam alone (CW_TEST_JJ_CARDS=1, HI-2870's jjCardsTestSwitch); a packaged build never takes it. Colocated only: a
// non-colocated jj project can't be switched to before J9f (HI-2896, which checks these views in that mode).
// - shop (jj, you review, target main): the user starts a card for B1, in a slot (a jj workspace); B1 commits there with
//   jj and submits through the Agent API; the user passes it. Repository's Waiting for you to integrate shows it with its change id and
//   "not in main yet" (J5's observation for exactly that approval, shown when written), and the same panel, still mounted,
//   follows a change of the record (a board change);
// - the user integrates it (moves main onto it): Done; Waiting is empty; the card dialog's Work section shows its
//   Workspace (in its line's place), its change id beside the revision and how its integration was proved;
// - B1 stopped, the slot back in the pool by itself (HI-2906: ready, detached at main);
// - the slot made stale (its working-copy commit rewritten from the project folder): Slots and copies says Stale with
//   Recover…; the confirmation names the folder unrecorded edits go to; an edit there is kept in it, and the slot is
//   recovered (not stale any more), its Recover… gone;
// - the next card starts in that same slot (HI-2906);
// - Publish records to check and Leftovers follow a change while mounted (Refresh);
// Screenshots of each in both themes, and of Waiting, the Work section and the stale slot's row in all seven locales, in
// both themes.
// Dev build only (#1578): jj cards start through CW_TEST_JJ_CARDS, which a packaged build ignores (until J9e).
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

const PORT = Number(lib.port(47797))
const work = path.join(lib.WORK, 'jjwindow')
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

  const env = { ...toolEnv(), PATH: `${jjDir()};${lib.baseEnv().PATH ?? ''}`, CW_TEST_JJ_CARDS: '1', CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' }
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
        await loc.screenshot({ path: path.join(shots, `jjwindow-${name}-${theme}.png`) })
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
    // The record changes (an observation that couldn't say): Refresh shows it, the panel still mounted.
    const pid = JSON.parse(fs.readFileSync(path.join(shop, '.combwork', 'project.json'), 'utf8')).id
    const ckey = `jj_contained:${pid.toLowerCase()}:${key.toLowerCase()}:1`
    onDb((db) => {
      const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(ckey)
      const v = JSON.parse(r.value)
      db.prepare('UPDATE board_meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...v, gen: v.gen + 1, state: 'unknown', why: 'refused: notFetched' }), ckey)
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
    const back = await until(async () => {
      const s = (await inv('slots:list', shop)).find((x) => x.name === slot)
      return s && s.state === 'ready' ? s : null
    }, HUNG_MS)
    check('after Done, the slot is back in the pool (ready, not lent)', !!back, JSON.stringify(await inv('slots:list', shop)))
    if (!back) throw new Error('the slot never came back to the pool')
    const wsName = w1.workspace
    fs.writeFileSync(path.join(w1.folder, 'draft.txt'), 'unrecorded\n')
    // The slot's working-copy commit rewritten from the project folder, its own working copy untouched (a write of its
    // checkout state can race Combwork's reads there on Windows: Access is denied).
    jj(shop, '--ignore-working-copy', 'describe', '-r', `${wsName}@`, '-m', 'rewritten elsewhere')
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
    check('…recovered: the notice, not stale any more, the edit kept aside', !!(await until(async () => /is recovered/.test(await text(page.locator('body'))) && (await inv('slots:list', shop)).find((s) => s.name === slot)?.stale !== true, HUNG_MS)) && fs.existsSync(path.join(path.dirname(w1.folder), '.cw-recovery', slot)), await text(page.locator('body')))
    const aside = path.join(path.dirname(w1.folder), '.cw-recovery', slot)
    const kept2 = fs.existsSync(aside) ? fs.readdirSync(aside, { recursive: true }).some((f) => String(f).endsWith('draft.txt')) || fs.existsSync(path.join(w1.folder, 'draft.txt')) : false
    check('…its unrecorded edit is kept', kept2, fs.existsSync(aside) ? JSON.stringify(fs.readdirSync(aside, { recursive: true })) : 'no aside folder')
    check('…and Recover… is gone from its row', !!(await until(async () => (await row.locator('[data-action="recover"]').count()) === 0, HUNG_MS)), await text(row))

    // --- HI-2906: the next card gets that same slot. The user, having looked, removes the draft the recovery kept in the
    // slot (its copy is aside), then starts another card for B1.
    fs.rmSync(path.join(w1.folder, 'draft.txt'), { force: true })
    const n2 = (await inv('tasks:create', { title: 'Shop second', project: 'shop', agent: b1.id })).number
    const started2 = await inv('tasks:move', n2, 'doing', { confirm: true, reason: 'jjwindow: the next card' }).catch((e) => ({ error: String(e) }))
    const w2 = await until(async () => {
      const v = await inv('tasks:work', n2)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    check('the next card starts in that same slot', !!w2 && w2.folder.toLowerCase() === w1.folder.toLowerCase() && w2.workspace === w1.workspace, JSON.stringify({ started2, w2, slots: await inv('slots:list', shop) }))
    check('…lent to it', !!(await until(async () => (await inv('slots:list', shop)).find((s) => s.name === slot)?.state === 'lent', HUNG_MS)), JSON.stringify(await inv('slots:list', shop)))

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
