// S53, a card loop across the 1.0 upgrade (#1218, SPEC §16.17): a released 0.9 build runs a lane on two fake Claude Code
// agents, a builder and a reviewer, with a card in Review, one in Doing and one in Todo, and closes. The dev build opens
// the workspace, upgrades its board, and adopts it in the background: the cards in flight get `Adopted` (the Review card
// an adopted submission too), the Todo card none (from before 1.0), the project its options. The agents resume and the
// loop carries on as on 0.9: every move is accepted, nothing refused, and every card passes, each finished by the
// builder's report of its merge before the next starts (HI-1985: a carried-over lane goes on at Done, S40).
// Since 1.1 the dev build first moves the workspace's 1.0 folders to .combwork as it opens it (HI-2462), and the 0.9
// conversations start fresh, carrying their work, as any launched before the names agents see changed (HI-2463): the
// 0.9 build's tools still have their names from before 1.1 (HI-2506).
//
// The 0.9 build is a packaged 0.9.x one: CW_E2E_V09 (its win-unpacked folder), else the main checkout's
// dist/win-unpacked when that is 0.9.x; with neither, the suite is skipped. Throwaway profiles, workspace and
// CLAUDE_CONFIG_DIR. lib.cjs keeps the 0.9 build's windows off screen and unfocused (#1253).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
// old-name: begin upgradelane-inputs
/** What a 0.9 build is and keeps: its exe, its name in its errors, its folders, its lane tool. */
const OLD_EXE = 'Hive.exe'
const OLD_APP = 'Hive'
const OLD_DIR = '.hive'
const OLD_LANE_TOOL = 'hive_lane'
// old-name: end upgradelane-inputs

const devProfile = path.join(lib.WORK, 'upgradelane-dev')
const oldProfile = path.join(lib.WORK, 'upgradelane-old')
const ws = path.join(lib.WORK, 'upgradelane-ws')
const claudeHome = path.join(lib.WORK, 'upgradelane-claude')
const spareHome = path.join(lib.WORK, 'upgradelane-claude-spare')
const alpha = path.join(ws, 'alpha')
// The board as the dev build keeps it, once it has moved the workspace's 1.0 folder to .combwork (HI-2462).
const dbFile = path.join(ws, '.combwork', 'combwork.db')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** The 0.9 build to run, or why there is none (as boardupgrade finds it). */
function build09() {
  let dir = process.env.CW_E2E_V09
  if (!dir) {
    const main = /^worktree (.+)$/m.exec(lib.git(lib.ROOT, 'worktree list --porcelain'))?.[1]
    if (!main) return { why: 'no main checkout found (git worktree list)' }
    dir = path.join(main, 'dist', 'win-unpacked')
  }
  const exe = path.join(dir, OLD_EXE)
  if (!fs.existsSync(exe)) return { why: `no ${OLD_APP} 0.9 build at ${dir} (set CW_E2E_V09 to a 0.9.x win-unpacked folder)` }
  let version = '?'
  try {
    version = JSON.parse(require('@electron/asar').extractFile(path.join(dir, 'resources', 'app.asar'), 'package.json').toString('utf8')).version
  } catch (e) {
    return { why: `couldn't read the version of ${dir}: ${e.message}` }
  }
  if (!version.startsWith('0.9.')) return { why: `${dir} is ${OLD_APP} ${version}, not 0.9.x (set CW_E2E_V09 to a 0.9.x win-unpacked folder)` }
  return { exe, version }
}

/** Rows of the board file, read on a connection of its own (read-only); [] while it can't be read. */
function rows(sql, ...args) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 })
    try {
      return db.prepare(sql).all(...args)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
/** A JSON-lines file the fake writes in its home, its records; [] when there is none yet. */
function jsonl(name) {
  const file = path.join(claudeHome, name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []
}
const kinds = (n) => rows('SELECT kind FROM card_facts WHERE card = ? ORDER BY seq', n).map((r) => r.kind)

/** A copy to drive, the 0.9 build or the dev build, with what the loop needs of it. */
function driver(app, page) {
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const typers = new Map()
  /** Types a prompt into an agent once its fake takes prompts (cardloop's say). */
  const say = async (id, text) => {
    if (!typers.has(id)) typers.set(id, lib.fakePrompts(inv, lib.ptyKey(alpha, id), () => live(id), { home: claudeHome }))
    await typers.get(id).type(text)
  }
  const start = async (id, resumeId) => {
    await inv('session:start', alpha, { agentId: id, ...(resumeId ? { resumeId } : {}) })
    return lib.until(async () => ['ready', 'finished'].includes((await live(id))?.status), HUNG_MS)
  }
  const column = async (n) => (await inv('tasks:list')).find((c) => c.number === n)?.column
  return { app, page, inv, live, say, start, column }
}

;(async () => {
  const old = build09()
  if (!old.exe) lib.skip(`environment: ${old.why}`)
  console.log(`0.9 build: ${old.version} (${old.exe})`)
  for (const d of [devProfile, oldProfile, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  // Both copies run the fake from the same home (its conversations resume across them); the dev profile's set-up makes a
  // home of its own, unused.
  fs.mkdirSync(devProfile, { recursive: true })
  fs.mkdirSync(oldProfile, { recursive: true })
  lib.fakeClaude(devProfile, spareHome)
  // The 0.9 build's profile alone runs the fake in old-release mode (its names before 1.1: oldRelease.cjs, HI-2614).
  const claude = lib.fakeClaude(oldProfile, claudeHome, [alpha], { oldRelease: true })
  // Closing a Combwork with agents running asks first: not here (cardloop's set-up).
  for (const profile of [devProfile, oldProfile]) {
    const file = path.join(profile, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  }
  const open = new Set()
  const close = async (h) => {
    open.delete(h)
    await h.app.close().catch(() => undefined)
  }
  // The 0.9 build's tool, by its name there (HI-2463 renamed it cw_lane in 1.1).
  const lane = (body) => `cw ${OLD_LANE_TOOL} ${JSON.stringify(body)}`
  try {
    // 1. The 0.9 build runs the loop: c1 built and in Review, c2 in Doing, c3 still in Todo.
    const oldApp = await _electron.launch({ executablePath: old.exe, args: [], env: lib.combworkEnv({ CW_USER_DATA: oldProfile, ...claude }) })
    const oldPage = await oldApp.firstWindow()
    const o = driver(oldApp, oldPage)
    open.add(o)
    await lib.appReady(oldPage)
    await lib.openWorkspace(o.inv, oldPage, ws)
    const builder = await lib.addAgent(o.inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(o.inv, alpha, { name: 'Reviewer' })
    const made = []
    for (const title of ['First card', 'Second card', 'Third card']) made.push((await o.inv('tasks:create', { title, project: 'alpha', agent: builder.id })).number)
    const [n1, n2, n3] = made
    check('0.9: both agents start', !!(await o.start(reviewer.id)) && !!(await o.start(builder.id)))
    await o.say(reviewer.id, lane({ action: 'join', builder: 'Builder', cards: made }))
    await o.say(builder.id, `${lane({ action: 'start', cards: made, reviewer: 'Reviewer' })} then boardmove ${n1} doing then boardmove ${n1} review then boardcomment ${n1} then boardmove ${n2} doing`)
    const before = await lib.until(async () => (await o.column(n1)) === 'review' && (await o.column(n2)) === 'doing', HUNG_MS)
    check('0.9: the loop is under way (c1 in Review, c2 in Doing, c3 in Todo)', !!before && (await o.column(n3)) === 'todo', JSON.stringify([await o.column(n1), await o.column(n2), await o.column(n3)]))
    const lane09 = (await o.inv('lanes:list'))[0]
    check('0.9: its lane runs, with the three cards', lane09?.state === 'active' && lane09?.cards?.map((c) => c.number).join() === made.join(), JSON.stringify(lane09))
    await close(o)

    // 2. The dev build opens it, upgrades, and adopts the board in the background.
    const d = await lib.launch({ userData: devProfile, viewport: { width: 1400, height: 900 }, env: claude })
    const dev = driver(d.app, d.page)
    open.add(dev)
    d.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(dev.inv, d.page, ws)
    check("the workspace's 1.0 folders moved to .combwork as it opened (HI-2462)", fs.existsSync(dbFile) && !fs.existsSync(path.join(ws, OLD_DIR)) && fs.existsSync(path.join(alpha, '.combwork', 'project.json')) && !fs.existsSync(path.join(alpha, OLD_DIR)))
    const ask = d.page.locator('.dialog', { hasText: "Upgrade this workspace's board to 1.0?" })
    check('the dev build asks before upgrading', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)))
    await ask.getByRole('button', { name: 'Upgrade', exact: true }).click()
    check('the upgrade runs', !!(await lib.until(async () => (await ask.count()) === 0 && (await d.page.locator('.toast', { hasText: 'Board upgraded to 1.0' }).count()) === 1, HUNG_MS)))
    const adopted = await lib.until(() => rows("SELECT value FROM board_meta WHERE key = 'adoption'").length === 1, HUNG_MS)
    check('…then the adoption, once', !!adopted)
    // What the adoption wrote, without the target's observations: a reconcile records its first look at the target in
    // the cycle (TargetMoved from null, #1217) whenever it runs, at times before these are read (#1543).
    const adoptedKinds = (n) => kinds(n).filter((k) => k !== 'TargetMoved')
    check('c1 (Review): Adopted, and an adopted submission', adoptedKinds(n1).join() === 'Adopted,Submitted', kinds(n1).join())
    check('c2 (Doing): Adopted, with its builder', adoptedKinds(n2).join() === 'Adopted' && JSON.parse(rows("SELECT data FROM card_facts WHERE card = ? AND kind = 'Adopted'", n2)[0]?.data ?? '{}').builder === builder.id, kinds(n2).join())
    check('c3 (Todo): no facts, from before 1.0', kinds(n3).length === 0 && rows('SELECT pre_workflow FROM cards WHERE number = ?', n3)[0]?.pre_workflow === 1)
    const cfg = JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8'))
    check('the project has its options as it works today: Git, a reviewer agent, its folder', cfg.platform === 'git' && cfg.workflow?.platform === 'git' && cfg.workflow?.options?.review === 'agent' && cfg.workflow?.options?.folder === 'project', JSON.stringify(cfg.workflow))
    check('nothing moved on the board', (await dev.column(n1)) === 'review' && (await dev.column(n2)) === 'doing' && (await dev.column(n3)) === 'todo')

    // 3. The agents resume their 0.9 conversations and the loop carries on as on 0.9, on Combwork's own loop wakes: the
    // reviewer woken for each card in Review, the builder for each verdict. What each fake does when woken, in order.
    const script = (agent, lines) => fs.writeFileSync(path.join(claudeHome, `fake-wakes-${agent}.txt`), lines.join('\n') + '\n')
    const wakesBefore = jsonl('fake-wakes.jsonl').length
    check('no loop wake was left over from 0.9', wakesBefore === 0, String(wakesBefore))
    script('Reviewer', [n1, n2, n3].map((n) => `boardreview ${n} start then boardreview ${n} passed passed`))
    // Its moves are now the cards' intents (#1268): a move to Review submits the card, so the builder commits its work
    // first, with the card's trailer (everyone works in the project folder), as an agent would.
    const work = (n) => `shell: echo card ${n}>card${n}.txt && git add -A && git -c user.email=b@t -c user.name=Builder commit -qm "card ${n}" --trailer "Combwork-Card: alpha-${n}"`
    // Under the upgrade's options (G5 Not checked, a reviewer agent) a passed card is Approved until its builder reports
    // its merge, and the lane's next card starts once the one before it is Done (Darren on HI-1985: 1.0's rule holds for
    // a lane carried over, as card-loop says): woken by each verdict, the builder reports that card's merge first.
    const cards = await dev.inv('tasks:list')
    const merged = (n) => `cw cw_report_merge ${JSON.stringify({ card: cards.find((c) => c.number === n)?.key })}`
    script('Builder', [`${merged(n1)} then ${work(n2)} then boardmove ${n2} review then boardcomment ${n2}`, `${merged(n2)} then boardmove ${n3} doing then ${work(n3)} then boardmove ${n3} review then boardcomment ${n3}`, 'work 1'])
    const sessions = await dev.inv('session:list', alpha)
    const sessionOf = (id) => sessions.find((x) => x.agentId === id && x.source === 'combwork')?.id
    check("the 0.9 sessions are there, one per agent", !!sessionOf(builder.id) && !!sessionOf(reviewer.id), JSON.stringify(sessions.map((x) => [x.agentId, x.id])))
    check('both agents start again from their 0.9 sessions', !!(await dev.start(reviewer.id, sessionOf(reviewer.id))) && !!(await dev.start(builder.id, sessionOf(builder.id))))
    // Launched before the names agents see changed, a 0.9 conversation starts fresh, its work carried (HI-2463).
    const launches = jsonl('fake-launches.jsonl').slice(-2)
    check('…each in a new conversation, as one from before HI-2463 does', launches.length === 2 && launches.every((l) => !l.opts['--resume']), JSON.stringify(launches.map((l) => l.opts)))
    check('Combwork wakes the reviewer for c1, which passes it', !!(await lib.until(async () => (await dev.column(n1)) === 'passed', HUNG_MS)))
    check('…the builder, woken by the verdict, sends c2 to Review, which passes', !!(await lib.until(async () => (await dev.column(n2)) === 'passed', HUNG_MS)))
    check('…and works c3, from before 1.0, as on 0.9, which passes', !!(await lib.until(async () => (await dev.column(n3)) === 'passed', HUNG_MS)))
    check("c1 and c2 are Done, by the builder's reports of their merges", (await dev.column(n1)) === 'done' && (await dev.column(n2)) === 'done', `${await dev.column(n1)}, ${await dev.column(n2)}`)
    const calls = fs.readFileSync(path.join(claudeHome, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const refused = calls.filter((c) => c.status !== 200)
    check('nothing either agent did was refused, before or after the upgrade', calls.length > 0 && refused.length === 0, JSON.stringify(refused).slice(0, 400))
    const lane10 = (await dev.inv('lanes:list')).find((l) => l.id === lane09?.id)
    check('the same lane, every card passed: c1 and c2 Done, c3 Passed', lane10?.state === 'active' && lane10?.cards?.map((c) => c.column).join() === 'done,done,passed', JSON.stringify(lane10))
    await close(dev)
    // 4. Started again: the adoption has run, and adds nothing.
    const facts = rows('SELECT COUNT(*) AS n FROM card_facts')[0]?.n
    const again = await lib.launch({ userData: devProfile, viewport: { width: 1400, height: 900 }, env: claude })
    open.add(again)
    await lib.openWorkspace(again.inv, again.page, ws)
    check('started again, it opens the board with no question', !!(await lib.until(async () => (await again.inv('tasks:list')).length === 3, HUNG_MS)) && (await ask.count().catch(() => 0)) === 0)
    check('…and the adoption adds nothing', rows("SELECT COUNT(*) AS n FROM card_facts WHERE kind = 'Adopted'")[0]?.n === 2 && rows('SELECT COUNT(*) AS n FROM card_facts')[0]?.n === facts)
    await close(again)
  } finally {
    for (const h of [...open]) await close(h)
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
