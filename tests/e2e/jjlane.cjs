// A jj project's lane end to end (HI-2801, J8; HI-1750's acceptance under decision A): the real app, the pinned jj
// (npm run jj:fetch) on its PATH, a fake Claude Code builder (B1) and reviewer (R1), a throwaway profile and workspace.
// Colocated here; `jjlanenc` runs the same steps on a repository not colocated with Git (CW_JJLANE_NONCOLOCATED=1).
// - shop (jj, a reviewer agent, cards in slots, you integrate into main): the user starts a lane of three cards for B1
//   and R1. Card 1 starts in a slot; B1 commits with jj and submits; R1 reviews it in a review copy of its own and passes
//   it; the user moves main onto it: Integrated (in its history) and Done, by Combwork, which moved no bookmark;
// - the lane goes on: card 2 starts in the same slot;
// - interruption: Combwork quits with card 2 in Doing and opens again: the lane, the card and its slot are as they were;
//   B1 submits it and R1 passes it;
// - the user's own commit on main touches card 2's file elsewhere: Waiting says not in main yet; the user copies it onto
//   main as Waiting suggests (`jj duplicate -r … --onto main`, HI-2913), moves main there and pushes to a bare remote:
//   Integrated (its change found applied again) and Done, and
//   nothing to check in Publish records;
// - card 3 in the same slot, copied onto main as Waiting suggests: Done; the lane ends with it, its slot back in the pool
//   (ready), no review copy leased;
// - card 4, on its own, a true conflict (it and the user's main change the same line), resolved by hand while
//   integrating: that changes the card's change, so Combwork can't prove it is there and fails closed: it stays waiting,
//   nothing Integrated, attributed or published, no bookmark moved by Combwork. The user's own Done is recorded apart, and
//   what its slot does then is logged for HI-2924, not asserted.
// Screenshots of Waiting (card 2 not in main yet) and the Work section (card 2's route), both themes.
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
  console.log("SKIP jjlane: the pinned jj isn't fetched (npm run jj:fetch)")
  process.exit(process.env.CW_JJ_REAL === '1' ? 1 : 0)
}

const NC = process.env.CW_JJLANE_NONCOLOCATED === '1'
const SUITE = NC ? 'jjlanenc' : 'jjlane'
const PORT = Number(lib.port(NC ? 47801 : 47799))
const work = path.join(lib.WORK, SUITE)
const userData = path.join(work, 'profile')
const ws = path.join(work, 'ws')
const shop = path.join(ws, 'shop')
const remote = path.join(work, 'remote.git')
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
const SHARED = ['one', 'two', 'three', 'four', 'five', 'six']
const shared = (edit) => SHARED.map((l, i) => edit[i] ?? l).join('\n') + '\n'

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // No editor jj could open: a step that would need one fails at once, never waits for input or shows a window.
  fs.writeFileSync(jjConfig, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\neditor = "cw-no-editor-in-tests"\n')
  fs.writeFileSync(gitConfig, `[user]\n\tname = ${lib.TEST_GIT_IDENTITY.name}\n\temail = ${lib.TEST_GIT_IDENTITY.email}\n[core]\n\tautocrlf = false\n`)
  fs.mkdirSync(shop, { recursive: true })
  fs.writeFileSync(path.join(shop, '.gitignore'), '.combwork/\n')
  jj(shop, 'git', 'init', NC ? '--no-colocate' : '--colocate')
  fs.writeFileSync(path.join(shop, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(shop, 'shared.txt'), shared({}))
  jj(shop, 'commit', '-m', 'base')
  jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
  execFileSync('git', ['init', '--bare', '-q', remote], { env: toolEnv(), windowsHide: true })
  jj(shop, 'git', 'remote', 'add', 'origin', remote)
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
  let h = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    const watch = () => h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    watch()
    const inv = (...a) => h.inv(...a)
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    await lib.openWorkspace(inv, h.page, ws)
    // A reviewer agent reviews (no self-review), each card in a slot, you integrate into main.
    const opts = await inv('workflow:setOptions', shop, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'slots', finish: 'userIntegrates', target: 'main' } })
    check('shop: a reviewer agent, cards in slots, you integrate into main', !!opts && !opts.error, JSON.stringify(opts))
    const b1 = await lib.addAgent(inv, shop, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, shop, { name: 'R1', workflowRole: 'reviewer' })
    const live = async (aid) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === shop.toLowerCase() && s.agentId === aid)
    const ready = (aid) =>
      until(async () => {
        const s = await live(aid)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(shop, aid), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    // An agent's running session's Agent API token (its session id read again each time: it may be started again).
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
    const column = async (n) => (await card(n))?.column
    const workOf = (n) => until(async () => {
      const v = await inv('tasks:work', n)
      return v?.folder && v.workspace ? v : null
    }, HUNG_MS)
    const integrationOf = async (n) => (await inv('tasks:work', n))?.integration ?? null
    const reviewLease = async (n) => ((await inv('copies:list', shop)) ?? []).find((c) => c.state === 'leased' && c.lease?.kind === 'review' && c.lease.card === n && !c.lease.returned)
    const waitingOf = async (n) => ((await inv('jj:waiting', shop)) ?? []).find((x) => x.card === n) ?? null

    /** B1 records its work with jj in its slot (`edits`: file → text) and submits it; R1 reviews it in a copy and passes it. */
    const buildAndReview = async (n, key, folder, edits, label) => {
      // B1 ready in its slot: the card's start (its slot prepared on the target's head) is over before the work begins.
      // Its slot prepared for it first (HB5 on HI-2923): the working copy on the card's base, which only its preparation puts
      // it on. B1 can look ready from the last card before Combwork ends it for this card's preparation.
      const w0 = await inv('tasks:work', n)
      const at = () => {
        try {
          return id(folder, `${w0.workspace}@-`)
        } catch {
          return null
        }
      }
      check(`${label}: its slot prepared on its base before the work begins`, !!w0?.base && !!(await until(() => at() === w0.base, HUNG_MS)), JSON.stringify({ base: w0?.base, at: at(), notReady: (await inv('tasks:work', n))?.notReady }))
      await ready(b1.id)
      for (const [f, t] of Object.entries(edits)) fs.writeFileSync(path.join(folder, f), t)
      jj(folder, 'commit', '-m', `${key}: ${label}`)
      const ws0 = (await inv('tasks:work', n)).workspace
      const R = id(folder, `${ws0}@-`)
      const sub = await call(await tokenOf(b1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
      check(`${label}: B1 submits it, in Review`, sub.status === 200 && !!(await until(async () => (await column(n)) === 'review', HUNG_MS)), JSON.stringify({ sub: sub.body, column: await column(n) }))
      await ready(r1.id)
      const rv = await call(await tokenOf(r1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/start-review`, {})
      const copy = await until(() => reviewLease(n), HUNG_MS)
      check(`${label}: R1 reviews it in a review copy of its own`, rv.status === 200 && !!copy, JSON.stringify({ rv: rv.body, copies: await inv('copies:list', shop) }))
      const pass = await call(await tokenOf(r1.id), 'POST', `/v1/tasks/${encodeURIComponent(key)}/verdict`, { pass: true, comment: 'Good.' })
      check(`${label}: R1 passes it, waiting for your integration`, pass.status === 200 && !!(await until(async () => (await column(n)) === 'passed', HUNG_MS)), JSON.stringify({ pass: pass.body, column: await column(n) }))
      return R
    }
    /** The user's copy of a card's commit onto main, as Waiting suggests (HI-2913): its commit id, found by its description. */
    const duplicateOnto = (R, description) => {
      jj(shop, '--ignore-working-copy', 'duplicate', '-r', R, '--onto', 'main')
      return id(shop, `description(exact:${JSON.stringify(description + '\n')}) & ~${R} & main+`)
    }
    const bookmarksBefore = () => jj(shop, '--ignore-working-copy', 'bookmark', 'list', '-T', 'name ++ " " ++ normal_target.commit_id() ++ "\\n"')

    // --- The lane: three cards for B1 and R1 (neither running yet: the slots' set-up records the user's working copy only
    // while no agent works in the project folder, HI-2887).
    const n1 = (await inv('tasks:create', { title: 'Card one', project: 'shop' })).number
    const n2 = (await inv('tasks:create', { title: 'Card two', project: 'shop' })).number
    const n3 = (await inv('tasks:create', { title: 'Card three', project: 'shop' })).number
    const [k1, k2, k3] = [(await card(n1)).key, (await card(n2)).key, (await card(n3)).key]
    const lane = await inv('lanes:start', shop, { builder: b1.id, reviewer: r1.id, cards: [n1, n2, n3] }).catch((e) => ({ error: String(e) }))
    const w1 = await workOf(n1)
    check('the lane starts: card 1 in a jj slot', !!w1, JSON.stringify({ lane, w1 }))
    if (!w1) throw new Error('card 1 never started')
    const slotFolder = w1.folder

    // --- Card 1: built, reviewed, integrated by the user; Combwork moves no bookmark itself.
    const R1 = await buildAndReview(n1, k1, slotFolder, { 'one.txt': 'card one\n' }, 'card 1')
    const marks = bookmarksBefore()
    check('Combwork moved no bookmark while building and reviewing it', /^main /m.test(marks) && marks.includes(id(shop, 'description(exact:"base\n")')), marks)
    jj(shop, 'bookmark', 'set', 'main', '-r', R1)
    check('the user moves main onto it: Done', !!(await until(async () => (await column(n1)) === 'done', HUNG_MS)), await column(n1))
    check('…Integrated by the user, proved in its history', (await integrationOf(n1))?.via === 'ancestry' && (await integrationOf(n1))?.by === 'outside', JSON.stringify(await integrationOf(n1)))

    // --- The lane goes on: card 2 in the same slot.
    const w2 = await workOf(n2)
    check('card 2 starts in the same slot', !!w2 && w2.folder.toLowerCase() === slotFolder.toLowerCase(), JSON.stringify(w2))

    // --- Interruption: Combwork quits with card 2 in Doing, and opens again on the same profile.
    await h.app.close()
    h = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
    watch()
    await lib.openWorkspace(inv, h.page, ws)
    const w2b = await workOf(n2)
    check('after a restart: card 2 still in Doing, in its slot, its workspace kept', (await column(n2)) === 'doing' && !!w2b && w2b.folder.toLowerCase() === slotFolder.toLowerCase() && w2b.workspace === w2.workspace, JSON.stringify({ column: await column(n2), w2b }))
    // Its agents again: resumed by Combwork, or started once the slot's own look after the restart is over (a start refused
    // meanwhile says the slot is still being set up).
    for (const a of [b1, r1]) {
      const back = await until(async () => !!(await live(a.id)) || (await inv('session:start', shop, { agentId: a.id }).then(() => true, () => false)), HUNG_MS)
      check(`after the restart: ${a.name} running again`, !!back, JSON.stringify(await live(a.id)))
    }

    // --- Card 2 touches line 6 of shared.txt; the user's own commit on main changes line 1 meanwhile.
    const R2 = await buildAndReview(n2, k2, slotFolder, { 'shared.txt': shared({ 5: 'six, by card two' }) }, 'card 2')
    jj(shop, 'new', 'main', '-m', 'the user moves on')
    fs.writeFileSync(path.join(shop, 'shared.txt'), shared({ 0: 'one, by the user' }))
    jj(shop, 'commit', '-m', 'the user moves on')
    jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
    const waiting2 = await until(async () => {
      const x = await waitingOf(n2)
      return x?.contained?.state === 'notYet' ? x : null
    }, HUNG_MS)
    check('Waiting: card 2 not in main yet', !!waiting2, JSON.stringify(await inv('jj:waiting', shop)))
    // The user integrates it as Waiting suggests (HI-2913): a copy onto main (`jj duplicate -r … --onto main`, the slot's own
    // commits untouched), main moved to the copy, then pushed.
    const R2b = duplicateOnto(R2, `${k2}: card 2`)
    jj(shop, 'bookmark', 'set', 'main', '-r', R2b)
    jj(shop, 'git', 'push', '--bookmark', 'main')
    check('the user copies it onto main, moves main and pushes: Done', !!(await until(async () => (await column(n2)) === 'done', HUNG_MS)), await column(n2))
    check('…Integrated by the user, its change found applied again', (await integrationOf(n2))?.via === 'replay', JSON.stringify(await integrationOf(n2)))
    check('…nothing to check in Publish records', !!(await until(async () => ((await inv('jj:toCheck', shop, null))?.rows ?? []).length === 0, HUNG_MS)), JSON.stringify(await inv('jj:toCheck', shop, null)))
    // Card 2's Work section, both themes.
    await showBoard(h.page)
    await openByTitle(h.page, n2)
    const workSection = h.page.locator('.card-work[data-work="recorded"]')
    check('card 2\'s Work section: its workspace, change id and route', !!(await until(async () => /found applied again|applied again/.test(await text(workSection)) && (await text(workSection)).includes(w2.workspace), HUNG_MS)), await text(workSection))
    for (const theme of ['dark', 'light']) {
      await h.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await workSection.screenshot({ path: path.join(shots, `${SUITE}-work-replay-${theme}.png`) })
    }
    await h.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await h.page.locator('.dialog').getByRole('button', { name: 'Cancel', exact: true }).click()

    // --- Card 3: built and reviewed in the same slot, integrated as Waiting suggests (a copy onto main): Done.
    const w3 = await workOf(n3)
    check('card 3 starts in the same slot', !!w3 && w3.folder.toLowerCase() === slotFolder.toLowerCase(), JSON.stringify(w3))
    const R3 = await buildAndReview(n3, k3, slotFolder, { 'three.txt': 'card three\n' }, 'card 3')
    jj(shop, 'bookmark', 'set', 'main', '-r', duplicateOnto(R3, `${k3}: card 3`))
    check('the user copies card 3 onto main and moves main there: Done', !!(await until(async () => (await column(n3)) === 'done', HUNG_MS)), await column(n3))

    // --- Cleanup: the lane ends with its last card, its slot back in the pool, no review copy leased.
    check('the lane ends with its last card', !!(await until(async () => ((await inv('lanes:list')) ?? []).every((l) => l.ended || !(l.cards ?? []).includes(n1)), HUNG_MS)), JSON.stringify(await inv('lanes:list')))
    for (const a of [b1, r1]) await inv('session:stop', shop, a.id).catch(() => undefined)
    const back = await until(async () => {
      const s = ((await inv('slots:list', shop)) ?? []).find((x) => x.folder.toLowerCase() === slotFolder.toLowerCase())
      return s && s.state === 'ready' ? s : null
    }, HUNG_MS * 2)
    check('its slot back in the pool (ready)', !!back, JSON.stringify(await inv('slots:list', shop)))
    check('no review copy left leased', ((await inv('copies:list', shop)) ?? []).every((c) => c.state !== 'leased'), JSON.stringify(await inv('copies:list', shop)))

    // --- Card 4, on its own: a true conflict (it and the user's main change the same line), resolved by hand while
    // integrating. Combwork can't prove it (the resolution changes the card's change), so it fails closed: it stays
    // waiting, nothing Integrated, attributed or published, no bookmark moved by Combwork. The user's own Done is a
    // separate route (HI-2924 decides what follows from it).
    const n4 = (await inv('tasks:create', { title: 'Card four', project: 'shop', agent: b1.id })).number
    const k4 = (await card(n4)).key
    const started4 = await inv('tasks:move', n4, 'doing', { confirm: true, reason: 'jjlane: the conflict card' }).catch((e) => ({ error: String(e) }))
    const w4 = await workOf(n4)
    check('card 4 starts in a slot', !!w4, JSON.stringify({ started4, w4 }))
    for (const a of [r1]) {
      const up = await until(async () => !!(await live(a.id)) || (await inv('session:start', shop, { agentId: a.id }).then(() => true, () => false)), HUNG_MS)
      check(`${a.name} running for card 4's review`, !!up, JSON.stringify(await live(a.id)))
    }
    const R4 = await buildAndReview(n4, k4, w4.folder, { 'shared.txt': shared({ 0: 'one, by card four', 5: 'six, by card two' }) }, 'card 4')
    const change4 = id(shop, R4, 'change_id')
    jj(shop, 'new', 'main', '-m', 'the user again')
    fs.writeFileSync(path.join(shop, 'shared.txt'), shared({ 0: 'one, by the user again', 5: 'six, by card two' }))
    jj(shop, 'commit', '-m', 'the user again')
    jj(shop, 'bookmark', 'set', 'main', '-r', '@-')
    const remoteBefore = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { env: toolEnv(), windowsHide: true, encoding: 'utf8' }).trim()
    const R4b = duplicateOnto(R4, `${k4}: card 4`)
    check('the copy onto main stores a conflict', id(shop, R4b, 'if(conflict, "yes", "no")') === 'yes')
    // Before it is resolved: nothing Integrated, not Done.
    check('…while the conflict stands: not Integrated, not Done', (await integrationOf(n4)) === null && (await column(n4)) === 'passed', JSON.stringify({ integration: await integrationOf(n4), column: await column(n4) }))
    // The user resolves it: the copy's file as they want it, squashed into the copy.
    jj(shop, 'new', R4b, '-m', 'resolve')
    fs.writeFileSync(path.join(shop, 'shared.txt'), shared({ 0: 'one, by card four and the user', 5: 'six, by card two' }))
    // Its own description kept (-u): with both described, jj would ask an editor to combine them (HB5 on HI-2923).
    jj(shop, 'squash', '-u')
    const R4c = id(shop, `change_id(${id(shop, R4b, 'change_id')})`)
    check('…resolved: no conflict stored', id(shop, R4c, 'if(conflict, "yes", "no")') === 'no')
    jj(shop, 'bookmark', 'set', 'main', '-r', R4c)
    // Fail-closed: Combwork observes it isn't provably there and records nothing.
    const waiting4 = await until(async () => {
      const x = await waitingOf(n4)
      return x?.contained?.state === 'notYet' && x.contained.at > 0 ? x : null
    }, HUNG_MS)
    check("a hand-resolved integration isn't proved: card 4 stays waiting, not in main as Combwork sees it", !!waiting4 && (await column(n4)) === 'passed', JSON.stringify({ waiting: await waitingOf(n4), column: await column(n4) }))
    check('…nothing Integrated or attributed', (await integrationOf(n4)) === null, JSON.stringify(await integrationOf(n4)))
    check('…main is the user\'s resolved copy, moved by no one else; nothing pushed', id(shop, 'main') === R4c && execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { env: toolEnv(), windowsHide: true, encoding: 'utf8' }).trim() === remoteBefore, JSON.stringify({ main: id(shop, 'main'), R4c }))
    check('…nothing to check in Publish records for it', ((await inv('jj:toCheck', shop, null))?.rows ?? []).every((r) => r.card !== k4), JSON.stringify(await inv('jj:toCheck', shop, null)))
    console.log(`INFO card 4: reviewed ${R4} (change ${change4}); the user's conflicted copy ${R4b}, resolved as ${R4c} (change ${id(shop, R4c, 'change_id')}) on main`)
    // The user's own route: Done by hand (an override), recorded apart from the automatic reconciliation above.
    const done4 = await inv('tasks:move', n4, 'done', { confirm: true, reason: 'Integrated by hand after resolving a conflict' }).catch((e) => ({ error: String(e) }))
    check('the user moves card 4 to Done themselves (an override, not a proof)', !!(await until(async () => (await column(n4)) === 'done', HUNG_MS)) && (await integrationOf(n4)) === null, JSON.stringify({ done4, column: await column(n4), integration: await integrationOf(n4) }))
    // What its slot does after that is HI-2924's to decide: logged here as it stands, not asserted.
    for (const a of [b1, r1]) await inv('session:stop', shop, a.id).catch(() => undefined)
    await until(async () => (((await inv('slots:list', shop)) ?? []).find((x) => x.folder.toLowerCase() === w4.folder.toLowerCase())?.state ?? '') === 'ready', 15000)
    console.log(`INFO card 4's slot after the user's Done (HI-2924, as it stands): ${JSON.stringify(((await inv('slots:list', shop)) ?? []).find((x) => x.folder.toLowerCase() === w4.folder.toLowerCase()))}`)
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
