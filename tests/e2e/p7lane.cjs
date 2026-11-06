// P7's acceptance in the app (#1448, SPEC §16.18, §16.19.1's P7 row: "a 6×6 setup runs a full lane on slots, Resume All
// and resume after restart work"), the Assistant off, fake Claude Code builders and fake Codex reviewers acting by their
// own tokens, temp Git projects:
// A. alpha, Combwork's Team 6×6 loaded (its agents named from the project's key), Team chosen in the Version Control tab (G15
//    On, G17 One per lane), Combwork merging into main, checked out in the project folder:
//    - two lanes started from the window at once: each is lent a slot (slot-a, slot-b), its builder started there in a new
//      conversation, and each card gets a line of its own from main's head;
//    - lane 1's first card: counted checks, submitted; its reviewer, whose session stays in the project folder, is
//      leased a review copy at the revision and runs a check of it there; passed; the queue merges it (S42: the reviewer
//      idle in the project folder doesn't hold it up; a commit of the user's from the Git view during the merge checks
//      isn't held up either); Done, its line deleted; the lane's next card waits ("<KEY> merging", S43) and then starts
//      in the same slot from the new main;
//    - S42: the user's uncommitted edit in a file the next merge changes pauses the queue, the file named; put back, it
//      merges;
//    - the Progress panel: "AL-B1 / AL-R1 · slot-a", the review copy's run a check of the revision, the slots' warming
//      runs as Combwork's;
//    - lane 1 ends; a third lane is lent slot-a again; Combwork quits mid-lane and opens again: Resume All resumes the open
//      leases' sessions in their slots and lists AL-B1's, whose slot was lent again, as reused (S35's window side).
// Screenshots in both themes. Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')
const { fromCodexTable } = require('./fake-bridge.cjs')

const PORT = Number(lib.port(47808))
const fx = q.queueProject('p7lane')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** A check the rest of its part builds on (HI-2033): failed, the part stops there rather than carry a null on. */
class Stopped extends Error {}
const must = (name, ok, extra = '') => {
  check(name, ok, extra)
  if (!ok) throw new Stopped(name)
}
/** A part's exception, a check it stopped at already said. */
const caught = (what, e) => (e instanceof Stopped ? console.log(`(${what} stopped at: ${e.message})`) : check(`${what}no exception`, false, e?.stack ?? String(e)))
const until = (fn, ms) => lib.until(fn, ms, 250)
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const slash = (p) => p.replace(/\\/g, '/')
const git = (dir, ...a) => lib.git(dir, a).trim()
const alpha = fx.alpha
const beta = path.join(fx.ws, 'beta')
const gamma = path.join(fx.ws, 'gamma')
// A project with no agents: the gallery's template load (a load into a project whose agents run shows no names to choose).
const delta = path.join(fx.ws, 'delta')
const codexHome = path.join(lib.WORK, 'p7lane-codex-home')
const trees = (p) => path.join(`${fx.ws}.worktrees`, path.basename(p))
const setupLog = path.join(fx.tools, 'setup.log')
const lines = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean)
}
const jsonl = (file) => lines(file).map((l) => JSON.parse(l))
const commitIn = (dir, files, message, trailer) => {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  lib.git(dir, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
  lib.git(dir, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', message, ...(trailer ? ['-m', `Combwork-Card: ${trailer}`] : [])])
  return git(dir, 'rev-parse', 'HEAD')
}
const isIn = (dir, rev, ref) => {
  try {
    lib.git(dir, ['merge-base', '--is-ancestor', rev, ref])
    return true
  } catch {
    return false
  }
}
const hasBranch = (dir, line) => {
  try {
    git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${line}`)
    return true
  } catch {
    return false
  }
}

/** The profile: the fake Claude Code and the fake Codex, quiet, the Agent API on (queueFixture's prepare, with Codex). */
function prepare() {
  q.prepare(fx)
  fs.rmSync(codexHome, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.enableProviders(fx.userData, ['claude-code', 'codex'])
  const cfgFile = path.join(fx.userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The repository's own identity (Team takes it as G12's) and its two checks from its scripts (Team's quick and tests),
  // each the fixture's steered check; the slots' setup records each warming (CW_SLOT: which slot).
  lib.git(alpha, ['config', 'user.name', fx.identity.name])
  lib.git(alpha, ['config', 'user.email', fx.identity.email])
  const tool = `node "${slash(path.join(fx.tools, 'check.js'))}"`
  fs.writeFileSync(path.join(alpha, 'package.json'), JSON.stringify({ name: 'alpha', scripts: { typecheck: tool, test: tool } }, null, 2) + '\n')
  commitIn(alpha, {}, 'scripts')
  // beta (the pool) and gamma (everyone in the project folder): plain projects on main, the identity their own.
  for (const p of [beta, gamma, delta]) {
    lib.gitProject(p, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
    lib.git(p, ['branch', '-M', 'main'])
    lib.git(p, ['config', 'user.name', fx.identity.name])
    lib.git(p, ['config', 'user.email', fx.identity.email])
  }
  fs.writeFileSync(path.join(fx.tools, 'setup.js'), `require('fs').appendFileSync(${JSON.stringify(setupLog)}, (process.env.CW_SLOT || 'none') + '\\n')\n`)
  // The fake Claude Code trusts the workspace, its projects and their worktrees folders (asks nothing).
  const slotFolders = (p) => ['slot-a', 'slot-b', 'slot-c', 'slot-d'].map((s) => path.join(trees(p), s))
  fs.writeFileSync(path.join(fx.claudeHome, 'fake-trusted.json'), JSON.stringify([fx.ws, alpha, beta, gamma, ...slotFolders(alpha), ...slotFolders(beta)].map((f) => f.toLowerCase())))
}

async function startCombwork(env = {}) {
  const { app, page, inv } = await lib.launch({ userData: fx.userData, viewport: { width: 1500, height: 950 }, env: { CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: fx.claudeHome, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off', ...env } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.waitForProvider(inv)
  await lib.waitForProvider(inv, 'codex')
  await lib.openWorkspace(inv, page, fx.ws)
  return { app, page, inv }
}

/** The page's helpers for one start of Combwork: sessions, tokens, intents, shells, the board and the Progress panel. */
function helpers(h) {
  const { page, inv } = h
  const live = async (p, id) => (await inv('session:live')).find((s) => same(s.projectPath, p) && s.agentId === id) ?? null
  const idle = (p, id) => until(async () => ['ready', 'finished'].includes((await live(p, id))?.status), HUNG_MS)
  const claudeLaunches = () => jsonl(path.join(fx.claudeHome, 'fake-launches.jsonl'))
  const codexLaunches = () => jsonl(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => !['--version', 'login', 'app-server', 'debug'].includes(l.args[0]))
  /** The agent's running session's Agent API token, from its launch (Claude Code's --mcp-config, Codex's -c table). */
  const tokenOf = async (p, a) => {
    const s = await until(() => live(p, a.id), HUNG_MS)
    if (!s) return null
    if (a.provider === 'codex') {
      const l = await until(() => codexLaunches().findLast((x) => x.args.some((y) => y.includes(s.runId))), HUNG_MS)
      const server = l ? fromCodexTable(l.args.find((x) => x.startsWith('mcp_servers.combwork=')).slice('mcp_servers.combwork='.length)) : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    // The newest: a resumed conversation keeps its id, and an earlier launch's files are gone.
    const l = await until(() => claudeLaunches().findLast((x) => x.sessionId === s.sessionId && x.opts['--mcp-config'] && fs.existsSync(x.opts['--mcp-config'])), HUNG_MS)
    const server = l ? JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
  }
  /** An agent's intent on a card, its token read afresh each time (a restarted session has a new one). */
  const intent = async (p, a, n, name, body = {}) => {
    const token = await tokenOf(p, a)
    let res = null
    // "Try again: Combwork reads it afresh" (what it read moved as it decided), as an agent does, a few times at most.
    for (let tries = 0; tries < 5; tries++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      res = { status: r.status, body: await r.json().catch(() => null) }
      if (res.body?.rule !== 'evidence.changed') break
    }
    return res
  }
  /**
   * Its start review: under load the copy's setup can outlast the first wait, answered "Waiting for a review copy" and
   * told later (HI-2024, as lanesslots for HI-1955). Once a copy is leased to it for the card, starting again answers with
   * its folder. The reply, and the copy's folder (or null).
   */
  const startReview = async (p, a, n) => {
    let s = await intent(p, a, n, 'start-review')
    if ((s.body?.data?.reviewCopy ?? '').startsWith('Waiting for a review copy')) {
      await until(async () => (await inv('copies:list', p)).some((c) => c.state === 'leased' && c.lease?.kind === 'review' && c.lease.card === n && c.lease.agent === a.id && !c.lease.returned), HUNG_MS)
      s = await intent(p, a, n, 'start-review')
    }
    return { s, copy: (s.body?.data?.reviewCopy ?? '').match(/Review in (.+?) at /)?.[1] ?? null }
  }
  /** A line the agent's shell runs (the fakes' "shell:" step), typed until its CLI has taken it: its record, or null. */
  const shell = async (p, a, cmd) => {
    const file = path.join(a.provider === 'codex' ? codexHome : fx.claudeHome, 'fake-shell.jsonl')
    const before = lines(file).length
    await idle(p, a.id)
    const sent = await lib.sendPrompt(inv, lib.ptyKey(p, a.id), `shell: ${cmd}`, { submitted: () => jsonl(file).slice(before).some((s) => s.cmd === cmd) })
    return sent ? (jsonl(file).slice(before).find((s) => s.cmd === cmd) ?? null) : null
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const facts = (n) => inv('tasks:facts', n)
  const kinds = async (n) => (await facts(n)).map((f) => f.kind)
  const fact = async (n, kind) => (await facts(n)).findLast((f) => f.kind === kind) ?? null
  const done = async (n) => !!(await until(async () => (await card(n))?.column === 'done', HUNG_MS))
  const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
  const slots = (p) => inv('slots:list', p)
  const slotOfLane = async (p, laneId) => (await slots(p)).find((s) => s.lease?.lane === laneId) ?? null
  const create = async (p, title) => (await inv('tasks:create', { title, project: path.basename(p) })).number
  const runs = async () => (await inv('progress:snapshot')).runs

  // Screenshots of `target` (the window by default) in both themes, `show` bringing back what the shot is of first.
  const shoot = async (name, target = page, show) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      if (show) await show()
      await target.screenshot({ path: path.join(fx.shots, `p7lane-${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }

  // The board, a project's (the sidebar's row) or all; the Task Board button toggles the sidebar when the board shows.
  const board = page.locator('.board')
  const col = (id) => board.locator(`.board-column[data-column="${id}"]`)
  const showBoard = async (project) => {
    const row = page.locator('.pane-body .row', { hasText: project }).first()
    await until(async () => {
      if ((await row.count()) && (await board.count())) return true
      await page.getByRole('button', { name: 'Task Board' }).click()
      return (await row.count()) > 0 && (await board.count()) > 0
    }, HUNG_MS)
    await row.click()
  }
  const menuItem = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
  const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
  /**
   * A lane started from the window: the Todo column's Start Lane with These Cards… (all of `cards`, the column's own),
   * or a card's Start Lane with It…; the builder and reviewer (or the pool) chosen; the lane recorded.
   */
  const startLane = async (p, cards, builder, reviewer) => {
    await showBoard(path.basename(p))
    await until(async () => (await col('todo').locator('.task-card').count()) >= cards.length, HUNG_MS)
    if (cards.length > 1) {
      await until(async () => (await col('todo').locator('.task-card').count()) === cards.length, HUNG_MS)
      await col('todo').locator('.board-column-header').click({ button: 'right' })
      await until(async () => (await menuItem('Start Lane with These Cards…').count()) === 1, HUNG_MS)
      await menuItem('Start Lane with These Cards…').click()
    } else {
      await col('todo').locator(`.task-card[data-task="${cards[0]}"]`).click({ button: 'right' })
      await until(async () => (await menuItem('Start Lane with It…').count()) === 1, HUNG_MS)
      await menuItem('Start Lane with It…').click()
    }
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    await dialog.locator('#lane-start-builder').selectOption(builder.id)
    await dialog.locator('#lane-start-reviewer').selectOption(reviewer ? reviewer.id : '*pool')
    await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    return until(async () => (await inv('lanes:list')).find((l) => l.builder.id === builder.id && l.state !== 'ended' && JSON.stringify(l.cards.map((x) => x.number)) === JSON.stringify(cards)), HUNG_MS)
  }

  // The Progress panel: a tab shown, a lane's row.
  const panel = page.locator('.progress-panel')
  const showTab = async (name) => {
    if (!(await panel.count())) await page.locator('.progress-rail').click()
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    await panel.locator(`.progress-tab[data-tab="${name}"]`).click()
    await until(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1, HUNG_MS)
  }
  const laneTop = (id) => panel.locator(`.progress-lane[data-lane="${id}"] .progress-lane-top`)
  const text = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
  // The Projects view's row of a project, clicked (Projects toggles the sidebar when its view shows already), and a tab
  // of the project's by its command.
  const toProject = async (name) => {
    const listed = page.locator('.sidebar').getByText(name, { exact: true }).first()
    await until(async () => {
      if ((await page.locator('.sidebar .pane-body .row', { hasText: 'All projects' }).count()) === 0 && (await listed.isVisible().catch(() => false))) return true
      await page.locator('.activitybar [aria-label="Projects"]').click()
      return false
    }, HUNG_MS)
    await listed.click()
  }
  const command = (id) => h.app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'menu-command', command: id, args: [] })
  return { live, idle, tokenOf, intent, startReview, shell, card, facts, kinds, fact, done, lane, slots, slotOfLane, create, runs, shoot, showBoard, startLane, panel, showTab, laneTop, text, toProject, command }
}

;(async () => {
  prepare()
  let h = await startCombwork()
  // What the restart needs of the first start: the agents, the lanes, the cards.
  const kept = {}
  try {
    const { page, inv } = h
    const x = helpers(h)

    // --- A. alpha: Team 6×6 from Combwork's template, its agents named from the project's key.
    // Loaded from the Templates view: Team 6×6 → Load into Project… → alpha; its load dialog names each agent.
    await page.locator('.activitybar [aria-label="Templates"]').click()
    const tplRow = page.locator('.sidebar .template-row[data-scope="combwork"][aria-label="Team 6×6"]')
    await tplRow.waitFor({ timeout: HUNG_MS })
    await tplRow.click()
    const detail = page.locator('.main-area > .tab-body .template-detail[data-scope="combwork"]')
    await detail.waitFor({ timeout: HUNG_MS })
    await detail.getByRole('button', { name: 'Load into Project…' }).click()
    const pick = page.locator('.dialog').last()
    await pick.locator('select').selectOption({ label: 'alpha' })
    await pick.getByRole('button', { name: 'Continue' }).click()
    const load = page.locator('.dialog', { has: page.locator('.template-plan-name-input') })
    await until(async () => (await load.locator('.template-plan-name-input').count()) === 12, HUNG_MS)
    const names = await load.locator('.template-plan-name-input').evaluateAll((l) => l.map((i) => i.value))
    const key = names[0]?.split('-')[0] ?? 'AL'
    check(`Team 6×6's load dialog names its twelve agents from the key (${key}-B1 … ${key}-R6)`, names.length === 12 && JSON.stringify(names) === JSON.stringify([...[1, 2, 3, 4, 5, 6].map((n) => `${key}-B${n}`), ...[1, 2, 3, 4, 5, 6].map((n) => `${key}-R${n}`)]), JSON.stringify(names))
    await x.shoot('template-names', load)
    await load.getByRole('button', { name: 'Load template' }).click()
    const agentsNow = async () => (await inv('workspace:refresh'))?.projects.find((p) => same(p.path, alpha))?.agents ?? []
    const agents = (await until(async () => ((await agentsNow()).length === 12 ? agentsNow() : null), HUNG_MS)) ?? []
    const named = (n) => agents.find((a) => a.name === `${key}-${n}`)
    const [b1, b2, b3, r1, r2, r3] = ['B1', 'B2', 'B3', 'R1', 'R2', 'R3'].map(named)
    check('…six Claude Code builders and six Codex reviewers, none in a worktree', agents.length === 12 && agents.filter((a) => a.workflowRole === 'builder' && a.provider === 'claude-code').length === 6 && agents.filter((a) => a.workflowRole === 'reviewer' && a.provider === 'codex').length === 6 && agents.every((a) => !a.worktree), JSON.stringify(agents.map((a) => [a.name, a.workflowRole, a.provider, !!a.worktree])))
    Object.assign(kept, { b1, b2, b3, r1, r2, r3 })

    // Team chosen in the Version Control tab: G15 On, G17 One per lane, Combwork merging into main (the default branch).
    await x.toProject('alpha')
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await form.waitFor({ timeout: HUNG_MS })
    await form.locator('.workflow-choice[data-choice="team"]').click()
    const preview = form.locator('.workflow-preview')
    await preview.waitFor({ timeout: HUNG_MS })
    await preview.locator('[data-action="use-choice"]').click()
    await preview.waitFor({ state: 'detached', timeout: HUNG_MS })
    await form.locator('[data-action="save"]').click()
    const save = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await save.waitFor({ timeout: HUNG_MS })
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    const opts = await until(async () => {
      const f = await inv('workflow:form', alpha)
      return f?.preset === 'team' ? f.options : null
    }, HUNG_MS)
    must('Team saved from the tab: Combwork merges into main, slots, G15 On, G17 One per lane, quick and tests before review and merge', opts?.finish === 'combworkMerges' && opts.target === 'main' && !!opts.commands?.typecheck && !!opts.commands?.test && opts.folder === 'slots' && opts.slotsUpToDate === true && opts.reviewerMode === 'lane' && opts.preChecks?.length === 2 && opts.mergeChecks?.length === 2, JSON.stringify(opts))
    await inv('project:updateConfig', alpha, { slots: { setup: `node "${path.join(fx.tools, 'setup.js')}"` } })

    // --- Two lanes from the window at once, each lent a slot, its builder started there in a new conversation.
    const a1 = await x.create(alpha, 'Lane one: first')
    check(`…the key is the project's (its cards' ${(await x.card(a1)).key})`, (await x.card(a1)).key.startsWith(`${key}-`))
    const a2 = await x.create(alpha, 'Lane one: second')
    const l1 = await x.startLane(alpha, [a1, a2], b1, r1)
    const c1 = await x.create(alpha, 'Lane two: only')
    const l2 = await x.startLane(alpha, [c1], b2, r2)
    check('two lanes started from the window, AL-B1 / AL-R1 and AL-B2 / AL-R2', !!l1 && !!l2, JSON.stringify(await inv('lanes:list')))
    Object.assign(kept, { a1, a2, c1, l1: l1?.id, l2: l2?.id })
    const slotA = await until(() => x.slotOfLane(alpha, l1.id), HUNG_MS)
    const slotB = await until(() => x.slotOfLane(alpha, l2.id), HUNG_MS)
    check('…lent slot-a and slot-b', slotA?.name === 'slot-a' && slotB?.name === 'slot-b', JSON.stringify(await x.slots(alpha)))
    Object.assign(kept, { slotA: slotA?.folder, slotB: slotB?.folder })
    for (const [b, s] of [[b1, slotA], [b2, slotB]]) {
      const there = await until(async () => {
        const v = await x.live(alpha, b.id)
        return v && same(v.cwd, s.folder) && ['ready', 'finished'].includes(v.status) ? v : null
      }, HUNG_MS)
      check(`${b.name} runs in ${s.name}`, !!there && there.slot === s.name, JSON.stringify(await x.live(alpha, b.id)))
    }
    check("the slots' warming ran as Combwork's, for each slot", !!(await until(async () => ['slot-a', 'slot-b'].every((n) => lines(setupLog).includes(n)), HUNG_MS)) && (await x.runs()).some((r) => r.source === 'combwork' && r.slot === 'slot-a'), JSON.stringify({ log: lines(setupLog), runs: (await x.runs()).filter((r) => r.slot).map((r) => [r.slot, r.source, r.defaultName]) }))

    // Each card its own line from main's head.
    const startIn = async (b, n, slot) => {
      const s = await x.intent(alpha, b, n, 'start')
      const line = s.body?.data?.line
      const base = git(alpha, 'rev-parse', 'main')
      const ok = s.status === 200 && same(s.body?.data?.folder, slot.folder) && !!line && !!(await until(() => git(slot.folder, 'branch', '--show-current') === line && git(slot.folder, 'rev-parse', 'HEAD') === base, HUNG_MS))
      return { ok, line, why: JSON.stringify({ s: s.body, branch: git(slot.folder, 'branch', '--show-current') }) }
    }
    const s1 = await startIn(b1, a1, slotA)
    must(`${key}-B1's first card starts in slot-a on its own line from main's head`, s1.ok, s1.why)
    const s3 = await startIn(b2, c1, slotB)
    must(`${key}-B2's card starts in slot-b on its own line from main's head`, s3.ok && s3.line !== s1.line, s3.why)
    Object.assign(kept, { line3: s3.line })

    // --- Lane 1's first card: counted checks in the slot, submitted.
    const counted = async (n) => ((await inv('tasks:work', n))?.checks ?? []).filter((c) => c.counted === true).map((c) => c.name)
    const checksIn = async (b, n) => {
      q.steer(fx, 'pass')
      const k = (await x.card(n)).key
      for (const name of ['typecheck', 'test']) await x.shell(alpha, b, `cw-progress --check ${name} --card ${k}`)
      return until(async () => ((await counted(n)).length >= 2 ? counted(n) : null), HUNG_MS)
    }
    const rev1 = commitIn(slotA.folder, { 'one.txt': 'one\n' }, 'Lane one: first')
    must("the first card's two checks are counted, run in slot-a", !!(await checksIn(b1, a1)), JSON.stringify(await inv('tasks:work', a1)))
    must('…submitted', (await x.intent(alpha, b1, a1, 'submit', { summary: 'first: ready' })).status === 200)

    // --- Its reviewer, in the project folder, reviews in a review copy at the revision; its check there is of it.
    await inv('session:start', alpha, { agentId: r1.id }).catch(() => undefined)
    const rs = await until(() => x.live(alpha, r1.id), HUNG_MS)
    check(`${key}-R1 runs in the project folder`, same(rs?.cwd, alpha), JSON.stringify(rs))
    const { s: review, copy } = await x.startReview(alpha, r1, a1)
    must(`…start review leases it a review copy at the revision (${rev1.slice(0, 7)})`, review.status === 200 && !!copy && fs.existsSync(copy) && git(copy, 'rev-parse', 'HEAD') === rev1, JSON.stringify(review.body))
    check("…its session stays in the project folder", same((await x.live(alpha, r1.id))?.cwd, alpha))
    q.steer(fx, 'pass')
    const ran = await x.shell(alpha, r1, `cd /d "${copy}" && cw-progress --check typecheck`)
    const copyRun = await until(async () => (await x.runs()).find((r) => r.card === a1 && r.copy === path.basename(copy) && r.state !== 'running'), HUNG_MS)
    check('…its check in the copy is a check of the card at the revision', !!ran && !!copyRun && copyRun.revision === rev1, JSON.stringify({ ran, copyRun }))
    Object.assign(kept, { copyRun: copyRun?.id })

    // The Progress panel: the lane's row with its slot, the copy's run, the slots' warming.
    await x.showTab('lanes')
    const row1 = x.laneTop(l1.id)
    check(`the lane's row reads "${key}-B1 / ${key}-R1 · slot-a"`, !!(await until(async () => (await x.text(row1)).replace(/\s*·\s*/g, ' · ').includes(`${key}-B1 / ${key}-R1 · slot-a`), HUNG_MS)), await x.text(row1))
    await x.shoot('lanes', x.panel)
    await x.showTab('runs')
    const runRow = x.panel.locator(`.progress-recent-item[data-run="${copyRun?.id}"] .progress-recent > .tip-wrap`).first()
    // Its card's runs (HI-1701) and its group (the reviewer's runs of the card's check) opened.
    await until(async () => {
      const shut = x.panel.locator('.progress-card-toggle[aria-expanded="false"], .progress-group-head[aria-expanded="false"]')
      if ((await shut.count()) === 0) return (await runRow.count()) > 0
      await shut.first().click()
      return false
    }, HUNG_MS)
    // What it ran for and where is in its hover (HI-1701: a line per run).
    const forLine = `${(await x.card(a1)).key} · ${rev1.slice(0, 7)} · in ${path.basename(copy)}`
    const tip = () => h.page.locator('body > .tip').last().innerText().catch(() => '')
    check(`the copy's run's hover reads "<key> · ${rev1.slice(0, 7)} · in ${path.basename(copy)}"`, !!(await until(async () => {
      if ((await tip()).includes(forLine)) return true
      await runRow.hover()
      return false
    }, HUNG_MS)), await tip())
    await h.page.mouse.move(5, 5)
    const agentChoices = () => x.panel.locator('select[aria-label="Agent"] option').allInnerTexts().catch(() => [])
    // HI-1710: the copy's set-up run is its reviewer's (no "Combwork (copy …)" entry), and no entry is listed twice.
    const slots = ['Combwork (slot slot-a)', 'Combwork (slot slot-b)']
    const combworkNamed = async () => {
      const now = await agentChoices()
      return slots.every((c) => now.includes(c)) && !now.some((c) => c.startsWith('Combwork (copy')) && new Set(now).size === now.length
    }
    check("the Runs tab's Agent filter names the slots' runs as Combwork's, and the copy's as its reviewer's", !!(await until(combworkNamed, HUNG_MS)), JSON.stringify(await agentChoices()))
    await x.shoot('runs', x.panel)

    // --- Passed: the queue merges it into main, checked out in the project folder, while the reviewer is idle there (S42).
    q.steer(fx, 'wait')
    check('…passed', (await x.intent(alpha, r1, a1, 'verdict', { pass: true, comment: 'first: passed' })).status === 200)
    check("the queue's merge checks run", !!(await until(() => fs.existsSync(fx.started), HUNG_MS)))
    // S43: the lane's next card waits for it.
    const early = await x.intent(alpha, b1, a2, 'start')
    check('S43: the next card is refused while the first is merging (one card at a time)', early.status === 409 && early.body?.rule === 'lane.oneAtATime', JSON.stringify(early.body))
    const k1 = (await x.card(a1)).key
    const waits = await until(async () => ((await x.lane(l1.id))?.status?.reason === 'merging' ? (await x.lane(l1.id)).status : null), HUNG_MS)
    check(`…the lane says "waiting: ${k1} merging"`, waits?.card === a1, JSON.stringify((await x.lane(l1.id))?.status))
    await x.showTab('lanes')
    await x.shoot('lane-merging', x.panel, () => until(async () => (await x.text(x.panel)).includes(`waiting: ${k1} merging`), HUNG_MS))
    // S42: the user commits in the project folder from the Git view while the checks run: not held up.
    commitIn(alpha, { 'mine.txt': 'the user commits\n' }, 'the user commits')
    // The Git view's actions take the repository lock: done while the checks still run (they wait for go.txt).
    const viaGitView = await inv('git:createBranch', alpha, 'scratch').then(() => inv('git:switch', alpha, 'main')).then(() => 'ok', (e) => String(e?.message ?? e))
    check('S42: the user commits in the project folder and the Git view acts during the merge checks, not held up', viaGitView === 'ok' && !fs.existsSync(fx.go) && git(alpha, 'branch', '--show-current') === 'main', viaGitView)
    const userCommit = git(alpha, 'rev-parse', 'main')
    fs.rmSync(fx.started, { force: true })
    fs.writeFileSync(fx.go, 'go')
    check('the first card merged: Done', await x.done(a1), JSON.stringify(await x.kinds(a1)))
    const i1 = await x.fact(a1, 'Integrated')
    check("…into main in the project folder, after the user's commit", !!i1 && isIn(alpha, rev1, 'main') && isIn(alpha, userCommit, 'main') && git(alpha, 'branch', '--show-current') === 'main', JSON.stringify(i1))
    // S42's swap caught the moved main and tested again (HR1's round 1): the merge checks ran first on a candidate without
    // the user's commit, then passed, counted, on the one that has it, and that tested candidate is what was merged. A
    // merge onto the moved main with no check of it has no such run, and fails here.
    // The queue's checks: those after the merge was asked for.
    const all1 = await x.facts(a1)
    const asked = all1.findIndex((f) => f.kind === 'IntegrationRequested')
    const queueChecks = all1.slice(asked + 1).filter((f) => f.kind === 'CheckRan' && f.data.counted === true)
    /** Both merge checks passed, counted, on the merged candidate, which has the user's commit; checked before it too. */
    const retestedIn = (checks) => {
      const onMoved = checks.filter((f) => isIn(alpha, userCommit, f.data.tested))
      const checked = [...new Set(checks.filter((f) => !isIn(alpha, userCommit, f.data.tested)).map((f) => f.data.name))]
      return checked.length === 2 && checked.every((n) => onMoved.some((f) => f.data.name === n && f.data.result === 'passed' && f.data.tested === i1?.data?.result))
    }
    check("S42: the moved main was tested again: both merge checks passed on the candidate with the user's commit, the one merged", retestedIn(queueChecks), JSON.stringify({ result: i1?.data?.result, userCommit, checks: queueChecks.map((f) => [f.data.name, f.data.result, f.data.tested]) }))
    // The same test given this run's facts with the moved candidate's checks left out (a merge with no retest): it fails.
    check('…and that test fails for a merge onto the moved main with no check of it', !retestedIn(queueChecks.filter((f) => !isIn(alpha, userCommit, f.data.tested))))
    // The next card in the same slot, from the new main.
    const s2 = await startIn(b1, a2, slotA)
    check('S43: the next card starts once the first is Done, in the same slot, from the main that has it', s2.ok && isIn(slotA.folder, rev1, 'HEAD'), s2.why)
    check("…the first card's line, merged, deleted as the slot moved on (LineDeleted on it)", !!(await until(async () => !hasBranch(alpha, s1.line) && (await x.kinds(a1)).includes('LineDeleted'), HUNG_MS)), JSON.stringify(await x.kinds(a1)))

    // --- S42: the user's uncommitted edit in a file the next merge changes: paused, named; put back, merged.
    commitIn(slotA.folder, { 'a.txt': 'one\ntwo by the lane\nthree\n' }, 'Lane one: second')
    check("the second card's checks are counted", !!(await checksIn(b1, a2)))
    fs.writeFileSync(path.join(alpha, 'a.txt'), 'the user is editing a.txt\n')
    check('…submitted, reviewed and passed', (await x.intent(alpha, b1, a2, 'submit', { summary: 'second: ready' })).status === 200 && (await x.intent(alpha, r1, a2, 'start-review')).status === 200 && (await x.intent(alpha, r1, a2, 'verdict', { pass: true, comment: 'second: passed' })).status === 200)
    const queue = async () => (await inv('queue:list', alpha, 'main'))[0]
    const paused = await until(async () => ((await queue())?.paused?.reason === 'unstagedChanges' ? (await queue()).paused : null), HUNG_MS)
    check('S42: the edit in a file the merge changes pauses the queue, naming it (not returned)', JSON.stringify(paused?.files) === '["a.txt"]' && (await x.card(a2))?.column !== 'doing', JSON.stringify(paused))
    lib.git(alpha, ['checkout', '--', 'a.txt'])
    check('…put back and resumed: merged, Done', (await inv('queue:resume', alpha, 'main')).resumed === true && (await x.done(a2)), JSON.stringify(await x.kinds(a2)))
    check('lane 1 ends with its cards Done; its builder is stopped', !!(await until(async () => !!(await x.lane(l1.id))?.endedAt && !(await x.live(alpha, b1.id)), HUNG_MS)))

    // --- A third lane is lent slot-a again (AL-B1's conversation there is now another's); Combwork quits mid-lane.
    // slot-a free again: no lease, its writer (AL-B1's session) gone, ready.
    check('slot-a is free and ready once lane 1 has ended', !!(await until(async () => (await x.slots(alpha)).some((s) => s.name === 'slot-a' && !s.lease && !s.writer && s.state === 'ready'), HUNG_MS)), JSON.stringify(await x.slots(alpha)))
    const d1 = await x.create(alpha, 'Lane three: only')
    const l3 = await x.startLane(alpha, [d1], b3, r3)
    const slot3 = await until(() => x.slotOfLane(alpha, l3.id), HUNG_MS)
    check('a third lane is lent slot-a again', slot3?.name === 'slot-a', JSON.stringify(await x.slots(alpha)))
    const s4 = await startIn(b3, d1, slotA)
    check(`${key}-B3's card starts in slot-a`, s4.ok, s4.why)
    Object.assign(kept, { d1, l3: l3?.id, ok: true })
  } catch (e) {
    caught('', e)
  } finally {
    await h.app.close().catch(() => undefined)
  }

  // --- The second start: the restart's Resume All (S35), then the pool (beta) and everyone in the project folder (gamma).
  h = await startCombwork()
  try {
    if (kept.ok) {
      const { page, inv } = h
      const x = helpers(h)
      const { b1, b2, b3, slotA, slotB } = kept
      const resumeAll = page.locator('button.act-resume.quiet')
      await until(async () => (await resumeAll.count()) === 1, HUNG_MS)
      await resumeAll.click()
      for (const [b, folder, slot] of [[b2, slotB, 'slot-b'], [b3, slotA, 'slot-a']]) {
        const back = await until(async () => {
          const s = await x.live(alpha, b.id)
          return s && same(s.cwd, folder) && ['ready', 'finished'].includes(s.status) ? s : null
        }, HUNG_MS)
        check(`after the restart, Resume All resumes ${b.name} in ${slot}, on its lane's lease`, !!back && back.slot === slot, JSON.stringify(await x.live(alpha, b.id)))
      }
      const reused = page.locator('.toast', { hasText: `${b1.name}: its slot now holds` }).first()
      check(`…and lists ${b1.name}, whose slot now holds another card's work`, !!(await until(async () => (await reused.count()) === 1, HUNG_MS)) && !(await x.live(alpha, b1.id)), await page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))
      if (await reused.count()) await x.shoot('resume-all-reused', reused)
      // The lane carries on after the restart: lane 2's card submitted, reviewed and merged.
      commitIn(slotB, { 'two.txt': 'two\n' }, 'Lane two: only')
      q.steer(fx, 'pass')
      const k = (await x.card(kept.c1)).key
      for (const name of ['typecheck', 'test']) await x.shell(alpha, b2, `cw-progress --check ${name} --card ${k}`)
      await inv('session:start', alpha, { agentId: kept.r2.id }).catch(() => undefined)
      check('lane 2 carries on after the restart: submitted, reviewed, passed', (await x.intent(alpha, b2, kept.c1, 'submit', { summary: 'two: ready' })).status === 200 && (await x.intent(alpha, kept.r2, kept.c1, 'start-review')).status === 200 && (await x.intent(alpha, kept.r2, kept.c1, 'verdict', { pass: true, comment: 'two: passed' })).status === 200)
      check('…merged: Done, the lane ended', (await x.done(kept.c1)) && !!(await until(async () => !!(await x.lane(kept.l2))?.endedAt, HUNG_MS)))
    }
  } catch (e) {
    caught('restart: ', e)
  }
  try {
    await pool(h)
  } catch (e) {
    caught('the pool: ', e)
  }
  try {
    await everyoneInTheFolder(h)
  } catch (e) {
    caught('everyone in the project folder: ', e)
  }
  if (kept.ok)
    try {
      await gallery(h, kept)
    } catch (e) {
      caught('the gallery: ', e)
    }
  await h.app.close().catch(() => undefined)
  console.log(`Screenshots: ${fx.shots}`)
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()

/** A card's reviewers as given (ReviewerAssigned), in order. */
const assignedOf = async (x, n) => (await x.facts(n)).filter((f) => f.kind === 'ReviewerAssigned').map((f) => f.data.reviewer)

/**
 * B. beta, Combwork's Team 6 + pool trimmed to two builders and its two pooled reviewers, an either agent E1 beside them, two
 * reviewers per card (G1b = 2), Combwork merging: two lanes on the pool ("<KEY>-B1 / pool"); a card reviewed by both pooled
 * reviewers, each in a review copy at its revision; E1 builds a card in a slot and isn't given a review meanwhile, then,
 * its card Done, reviews from the pool in the project folder (its launch granted the copies folder).
 */
async function pool(h) {
  const { inv } = h
  const x = helpers(h)
  await inv('workflow:setOptions', beta, { preset: null, options: { review: 'agent', noSelfReview: true, reviewers: 2, finish: 'combworkMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], identity: fx.identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
  const plan = await inv('templates:plan', beta, 'combwork', 'team-6-pool.json')
  check('Team 6 + pool suggests the reviewer pool', plan.reviewerMode === 'pool', JSON.stringify(plan.reviewerMode))
  await inv('templates:load', beta, 'combwork', 'team-6-pool.json', plan.remove.map((a) => a.id))
  const agentsOf = async () => (await inv('workspace:refresh'))?.projects.find((p) => same(p.path, beta))?.agents ?? []
  for (const extra of (await agentsOf()).filter((a) => /-B[3-6]$/.test(a.name))) await inv('agents:remove', beta, extra.id, { deleteWorktree: false })
  await lib.addAgent(inv, beta, { name: 'E1', workflowRole: 'either' })
  const agents = await agentsOf()
  const by = (re) => agents.find((a) => re.test(a.name))
  const [b1, b2, r1, r2, e1] = [/-B1$/, /-B2$/, /-R1$/, /-R2$/, /^E1$/].map(by)
  check('beta: two builders, two pooled Codex reviewers and E1', agents.length === 5 && r1?.provider === 'codex' && r2?.provider === 'codex' && e1?.workflowRole === 'either', JSON.stringify(agents.map((a) => [a.name, a.workflowRole, a.provider])))
  const p1 = await x.create(beta, 'Pool: first')
  const p4 = await x.create(beta, 'Pool: fourth')
  const l1 = await x.startLane(beta, [p1, p4], b1, null)
  check(`a lane from the window on the pool: ${b1.name} / pool`, l1?.pool === true && l1.reviewer === null, JSON.stringify(l1))
  const p2 = await x.create(beta, 'Pool: second')
  const p3 = await x.create(beta, 'Pool: third')
  const l2 = (await inv('lanes:start', beta, { builder: b2.id, reviewer: null, pool: true, cards: [p2] })).lane
  const l3 = (await inv('lanes:start', beta, { builder: e1.id, reviewer: null, pool: true, cards: [p3] })).lane
  check("…and the others' on the pool too", l2?.pool === true && l3?.pool === true, JSON.stringify([l2, l3]))
  await x.showTab('lanes')
  const row = x.laneTop(l1.id)
  check(`the lane's row reads "${b1.name} / pool · slot-…"`, !!(await until(async () => /\/ pool\s*·\s*slot-[a-d]/.test(await x.text(row)) && (await x.text(row)).includes(`${b1.name} / pool`), HUNG_MS)), await x.text(row))
  await x.shoot('lane-pool', row)

  /** A builder's card started in its lane's slot, committed there and submitted: its revision. */
  const build = async (b, laneId, n, file) => {
    const s = await x.intent(beta, b, n, 'start')
    const slot = await until(() => x.slotOfLane(beta, laneId), HUNG_MS)
    const line = s.body?.data?.line
    await until(() => git(slot.folder, 'branch', '--show-current') === line, HUNG_MS)
    const rev = commitIn(slot.folder, { [file]: `${file}\n` }, `${file} done`)
    const sub = await x.intent(beta, b, n, 'submit', { summary: `${file}: ready` })
    const ok = s.status === 200 && sub.status === 200 && !!(await until(async () => (await x.card(n))?.column === 'review', HUNG_MS))
    return { ok, rev, why: JSON.stringify({ s: s.body, sub: sub.body }) }
  }
  /** A reviewer given the card reviews it in a review copy at `rev` and gives its verdict (`pass` false: none yet). */
  const review = async (r, n, rev, pass = true) => {
    await until(async () => (await assignedOf(x, n)).includes(r.id), HUNG_MS)
    await x.idle(beta, r.id)
    const { s, copy } = await x.startReview(beta, r, n)
    const atRev = !!copy && fs.existsSync(copy) && git(copy, 'rev-parse', 'HEAD') === rev
    const inFolder = same((await x.live(beta, r.id))?.cwd, beta)
    const v = pass ? await x.intent(beta, r, n, 'verdict', { pass: true, comment: `${r.name}: passed` }) : { status: 200 }
    return { ok: s.status === 200 && v.status === 200 && atRev && inFolder, why: JSON.stringify({ s: s.body, v: v.body, copy, inFolder }) }
  }

  // --- The first card, reviewed by both pooled reviewers (G1b = 2), while E1 builds: E1 is never given it.
  const one = await build(b1, l1.id, p1, 'p1.txt')
  must(`${b1.name} builds and submits its card in its slot`, one.ok, one.why)
  const ra = await review(r1, p1, one.rev)
  must(`${r1.name} reviews it in a review copy at its revision, from the project folder`, ra.ok, ra.why)
  const rb = await review(r2, p1, one.rev)
  must(`…then ${r2.name}, the second reviewer`, rb.ok, rb.why)
  check('…both pass it: merged, Done', await x.done(p1))
  check(`E1, building in its lane's slot, was given no review`, JSON.stringify(await assignedOf(x, p1)) === JSON.stringify([r1.id, r2.id]) && !!(await x.slotOfLane(beta, l3.id)), JSON.stringify(await assignedOf(x, p1)))

  // --- E1's own card: reviewed by the two others, Done; its lane ends and its slot's lease with it.
  const three = await build(e1, l3.id, p3, 'p3.txt')
  check('E1 builds and submits its card in a slot', three.ok, three.why)
  for (const r of [r1, r2]) {
    const v = await review(r, p3, three.rev)
    check(`${r.name} reviews E1's card`, v.ok, v.why)
  }
  check("E1's card is Done; its lane ends, and its slot's lease", (await x.done(p3)) && !!(await until(async () => !!(await x.lane(l3.id))?.endedAt && !(await x.slotOfLane(beta, l3.id)), HUNG_MS)))

  // --- R1 busy reviewing B2's card (no verdict yet): the next card goes to R2 and E1, E1 in the project folder.
  const two = await build(b2, l2.id, p2, 'p2.txt')
  check(`${b2.name} builds and submits its card`, two.ok, two.why)
  await until(async () => (await assignedOf(x, p2)).length > 0, HUNG_MS)
  const first2 = (await assignedOf(x, p2))[0]
  const busy = first2 === r1.id ? r1 : first2 === r2.id ? r2 : e1
  const hold = await review(busy, p2, two.rev, false)
  check(`${busy.name} takes ${b2.name}'s card and holds it (no verdict yet)`, hold.ok, hold.why)
  const four = await build(b1, l1.id, p4, 'p4.txt')
  check(`${b1.name}'s next card is built and submitted`, four.ok, four.why)
  const others = [r1, r2, e1].filter((r) => r.id !== busy.id)
  for (const r of others) {
    const v = await review(r, p4, four.rev)
    check(`${r.name} reviews it from the pool`, v.ok, v.why)
  }
  check('…E1 among them, now its card is Done', others.some((r) => r.id === e1.id) && (await assignedOf(x, p4)).includes(e1.id), JSON.stringify(await assignedOf(x, p4)))
  const copiesDir = path.join(trees(beta), 'copies')
  const e1Now = await x.live(beta, e1.id)
  const e1Launch = jsonl(path.join(fx.claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === e1Now?.sessionId)
  check("…E1 runs in the project folder, its launch granted the copies folder", same(e1Now?.cwd, beta) && !!e1Launch && same(e1Launch.opts['--add-dir'], copiesDir), JSON.stringify({ cwd: e1Now?.cwd, opts: e1Launch?.opts }))
  check('…merged: Done', await x.done(p4))
  const v2 = await x.intent(beta, busy, p2, 'verdict', { pass: true, comment: `${busy.name}: passed` })
  check(`${busy.name} passes ${b2.name}'s card`, v2.status === 200, JSON.stringify(v2.body))
  const second = others.find((r) => r.id !== e1.id) ?? others[0]
  const v3 = await review(second, p2, two.rev)
  check(`…its second reviewer passes it: Done`, v3.ok && (await x.done(p2)), v3.why)
  // A pool lane left running, for the gallery's lane rows. B2's card Done wakes it (its inbox) and a busy builder is
  // refused: started as the window's Wait and Start does, once it isn't busy (HI-1858); refused again only if a wake
  // came in between.
  const p5 = await x.create(beta, 'Pool: fifth')
  const BUSY = ['working', 'starting', 'waiting', 'background', 'watching', 'signin']
  const l5 = await until(async () => {
    if (BUSY.includes((await x.live(beta, b2.id))?.status)) return null
    return (await inv('lanes:start', beta, { builder: b2.id, reviewer: null, pool: true, cards: [p5] }).catch((e) => (/ is working| is starting| is waiting/.test(String(e)) ? null : Promise.reject(e))))?.lane ?? null
  }, HUNG_MS)
  check('another lane on the pool, left running', !!l5 && !!(await until(() => x.slotOfLane(beta, l5.id), HUNG_MS)), JSON.stringify(await x.live(beta, b2.id)))
}

/**
 * C. gamma, everyone in the project folder with the pool (HR2's round 1 finding 2 on #1428): Committed is done, two
 * builders in the project folder, one pooled Codex reviewer; each card is reviewed from the pool in a review copy at its
 * revision and is Done, and no slot is lent.
 */
async function everyoneInTheFolder(h) {
  const { inv } = h
  const x = helpers(h)
  await inv('workflow:setOptions', gamma, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', preChecks: [], identity: fx.identity, okBefore: { mode: 'never', labels: [] }, reviewerMode: 'pool' } })
  const g1 = await lib.addAgent(inv, gamma, { name: 'G-B1', workflowRole: 'builder' })
  const g2 = await lib.addAgent(inv, gamma, { name: 'G-B2', workflowRole: 'builder' })
  const gr = await lib.addAgent(inv, gamma, { name: 'G-R1', workflowRole: 'reviewer', provider: 'codex' })
  for (const [b, title] of [[g1, 'Folder: first'], [g2, 'Folder: second']]) {
    const n = await x.create(gamma, title)
    const l = await inv('lanes:start', gamma, { builder: b.id, reviewer: null, pool: true, cards: [n] })
    check(`${b.name}'s lane on the pool, with no slot`, l.lane?.pool === true && !l.slot, JSON.stringify(l))
    const s = await x.intent(gamma, b, n, 'start')
    check(`${b.name} starts its card in the project folder`, s.status === 200 && same(s.body?.data?.folder ?? gamma, gamma) && same((await x.live(gamma, b.id))?.cwd, gamma), JSON.stringify(s.body))
    const key = (await x.card(n)).key
    const rev = commitIn(gamma, { [`${key}.txt`]: `${key}\n` }, title, key)
    const sub = await x.intent(gamma, b, n, 'submit', { summary: `${title}: ready`, revision: rev })
    check('…submitted', sub.status === 200, JSON.stringify(sub.body))
    // The builder moves on in the folder: the reviewer reads the card at its revision in a copy.
    commitIn(gamma, { 'later.txt': `after ${key}\n` }, `after ${title}`)
    await until(async () => (await assignedOf(x, n)).includes(gr.id), HUNG_MS)
    await x.idle(gamma, gr.id)
    const { s: r, copy } = await x.startReview(gamma, gr, n)
    must(`G-R1 reviews it from the pool in a review copy at ${rev.slice(0, 7)}`, r.status === 200 && !!copy && git(copy, 'rev-parse', 'HEAD') === rev && same((await x.live(gamma, gr.id))?.cwd, gamma), JSON.stringify(r.body))
    check('…passes it: Done (committed)', (await x.intent(gamma, gr, n, 'verdict', { pass: true, comment: 'passed' })).status === 200 && (await x.done(n)))
  }
  check('no slot was lent in gamma', (await x.slots(gamma)).length === 0, JSON.stringify(await x.slots(gamma)))
}

/**
 * The gallery for Darren (#1448, on #1123): in both themes, in English and German (the long locale, switched as the
 * window takes a language change, p6lane's), the Slots and copies group, lane rows with their slots and a pool, an agent
 * pane "in slot-a", a refused resume, Resume All's list with a slot reused, and a template load's names table.
 */
async function gallery(h, kept) {
  const { page, inv, app } = h
  const x = helpers(h)
  const base = (await inv('app:info')).language
  const dir = path.join(lib.ROOT, 'locales', 'de')
  const german = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
  const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
  const english = async () => (await page.getByRole('button', { name: 'Task Board', exact: true }).count()) > 0
  /** `loc` (or what `open(lang)` opens in each language) shot in both themes, English then German; `close` after. */
  const shoot = async (name, { loc = page, open, close } = {}) => {
    for (const lang of ['en', 'de']) {
      if (lang === 'de') {
        await speak({ ...base, code: 'de', locale: 'de', messages: german })
        await until(async () => !(await english()), HUNG_MS)
      }
      const target = open ? await open(lang) : loc
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await target.screenshot({ path: path.join(fx.shots, `p7lane-gallery-${name}-${lang}-${theme}.png`) })
      }
      if (close) await close(lang)
    }
    await speak(base)
    await until(english, HUNG_MS)
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  // Notices in the corner closed (each one's Dismiss, its last button), so none lies over a shot.
  const clearToasts = () => until(async () => {
    const n = await page.locator('.toast').count()
    if (n) await page.locator('.toast > button').last().click().catch(() => undefined)
    return n === 0
  }, HUNG_MS)
  const shut = async () => {
    for (let i = 0; i < 3 && (await page.locator('.dialog').count()) > 0; i++) await page.keyboard.press('Escape')
  }
  const { b1, b3 } = kept

  // The lane rows: alpha's third lane in slot-a, beta's on the pool.
  await x.showTab('lanes')
  await until(async () => (await x.text(x.panel)).includes('/ pool'), HUNG_MS)
  await shoot('lanes', { loc: x.panel })

  // The Slots and copies group of alpha's Version Control tab.
  await x.toProject('alpha')
  await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
  await page.locator('.git-sections [data-section="workflow"]').click()
  const group = page.locator('.workflow-form .workflow-group[data-group="slots"]')
  await group.waitFor({ timeout: HUNG_MS })
  await group.scrollIntoViewIfNeeded()
  await shoot('slots-and-copies', { loc: group })

  // An agent's pane "in slot-a", and a resume refused (its slot now holds another card's work).
  await x.command('project.tab.session')
  // Two columns: a pane of a grid of six is too narrow for its marks.
  await inv('project:updateConfig', alpha, { layout: 'columns2' })
  await lib.showAgent(page, b3.name, HUNG_MS)
  const place = lib.paneHeader(page, b3.name).locator('.agent-place')
  const placeNow = async () => (await inv('workspace:refresh'))?.projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === b3.id)?.place
  check(`${b3.name}'s pane says "in slot-a"`, !!(await until(async () => (await place.innerText().catch(() => '')) === 'in slot-a', HUNG_MS)), JSON.stringify({ shown: await place.innerText().catch(() => null), place: await placeNow() }))
  await shoot('pane-in-slot', { loc: lib.paneHeader(page, b3.name) })
  await lib.showAgent(page, b1.name, HUNG_MS)
  await shoot('resume-refused', {
    open: async (lang) => {
      await clearToasts()
      await lib.paneHeader(page, b1.name).locator('button.act-resume').first().click()
      // HI-2125: the refusal itself, by its title, not the last notice to come: another (a 6 s one) could raise the
      // count and be gone before the shot, which then waited for a notice that wasn't there.
      const title = lang === 'de' ? german['actions.resume.heldTitle'] : "Can't resume here now"
      const refused = page.locator('.toast', { has: page.locator('.toast-title', { hasText: title }) }).last()
      if (!(await until(async () => (await refused.count()) > 0, HUNG_MS))) throw new Error(`the resume refusal wasn't shown; the notices: ${JSON.stringify(await page.locator('.toast').allInnerTexts())}`)
      return refused
    }
  })

  // Resume All's list: a slot reused.
  await shoot('resume-all', {
    open: async () => {
      // Something to resume: AL-B3 stopped first (its lane's lease open), so Resume All resumes it and lists AL-B1.
      await inv('session:stop', alpha, b3.id)
      // Stopped, and its run's hold on slot-a let go (its processes seen ended).
      await until(async () => !(await x.live(alpha, b3.id)) && !(await x.slots(alpha)).find((s) => s.name === 'slot-a')?.writer, HUNG_MS)
      await clearToasts()
      const before = await page.locator('.toast').count()
      await until(async () => (await page.locator('button.act-resume.quiet').count()) === 1, HUNG_MS)
      await page.locator('button.act-resume.quiet').click()
      await until(async () => (await page.locator('.toast', { hasText: b1.name }).count()) > 0 && (await page.locator('.toast').count()) > before, HUNG_MS)
      return page.locator('.toast', { hasText: b1.name }).last()
    }
  })

  // A template's load dialog, its names table from the project's key (delta's, loaded nowhere).
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await page.locator('.sidebar .template-row[data-scope="combwork"][aria-label="Team 6×6"]').click()
  const detail = page.locator('.main-area > .tab-body .template-detail[data-scope="combwork"]')
  await detail.waitFor({ timeout: HUNG_MS })
  await shoot('template-names', {
    open: async (lang) => {
      await clearToasts()
      await detail.locator('.template-detail-actions button').first().click()
      const pick = page.locator('.dialog').last()
      await pick.locator('select').selectOption({ label: 'delta' })
      await pick.getByRole('button', { name: lang === 'de' ? german['assistant.templates.continue'] : 'Continue' }).click()
      const load = page.locator('.dialog', { has: page.locator('.template-plan-name-input') })
      await until(async () => (await load.locator('.template-plan-name-input').count()) === 12, HUNG_MS)
      return load
    },
    close: shut
  })
}
