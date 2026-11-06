// S54, P4's RC scenario end to end (#1287, SPEC §16.18, §16.19.1), as 1.0 builds it (#1573: §16.10's slots, no worktree
// agents): "Pair (the agent merges)", the Assistant off, on fake Claude Code agents acting by their own tokens (their
// Combwork tools' calls), B1 added in the project folder. The project's options are set through Version Control → Workflow
// (#1278); a lane is started from the board (#1280), lent a slot that B1 then works in. Card 1: Combwork starts it with
// the lane's brief (HI-2558), and the builder's own start of it finds it on its line in the slot (the next card's start refused meanwhile: one card at a time), commits, runs the quick check
// through cw-progress --check (counted), submits; the reviewer starts its review and passes it; the builder merges
// it (a merge commit) and reports the merge, which done.contained checks: Done, and only then does the next card start,
// on a line of its own from main (card 1's, merged, deleted). Cards 2 and 3 are squash-merged in a row: card 3 starts
// while B1 is busy and its slot is left as it is until B1 is quiet, then its line is made from main; each card's change
// is only its own and no branch is moved (LineMoved is a 0.9 worktree's, §16.19.2). Card 4 is squash-merged after a
// commit made past its approval: card 5 starts on its own line, and card 4's line, holding work that isn't in main, is
// kept (looked at once card 5, merged, has its line deleted after card 6 starts: a pass that deleted it had looked at
// card 4's first). Each check's run through cw-progress --check is counted. A screenshot at each stage, once the window shows
// it. Dev build (or CW_EXE), throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47861))
const userData = path.join(lib.WORK, 'p4lane-profile')
const ws = path.join(lib.WORK, 'p4lane-ws')
const claudeHome = path.join(lib.WORK, 'p4lane-claude-home')
const shots = path.join(lib.WORK, 'p4lane-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
/** Commits are made with the project's identity (the preset's: Commits use the project's identity, G12). */
let identity = { name: 'B1', email: 'b1@example.com' }
/** git in a folder, as an agent's shell would (tests have no global git config). */
const git = (cwd, ...args) => lib.git(cwd, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args]).trim()

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(claudeHome)
  // A quick check from the project's scripts, as the preset offers it: `typecheck`, which passes.
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', 'package.json': JSON.stringify({ name: 'alpha', scripts: { typecheck: 'node -e "process.exit(0)"' } }), '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  // The Assistant off (S54): a test copy never starts it.
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The dev build, or the packaged Combwork CW_EXE names (S54 on the upgraded build in the Sandbox checks, #1337).
  const { app, page, inv } = await lib.launch({ userData, env: { CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    const projectJson = () => JSON.parse(fs.readFileSync(path.join(alpha, '.combwork', 'project.json'), 'utf8'))

    // --- Pair (the agent merges) through Version Control → Workflow (#1278).
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await until(async () => (await form.count()) > 0, HUNG_MS)
    // The preset previewed, then used (#1418): it fills the form, saved with Save….
    await form.locator('.workflow-choice[data-choice="pairAgent"]').click()
    await form.locator('.workflow-preview [data-action="use-choice"]').click()
    await form.getByRole('button', { name: 'Save…' }).click()
    const save = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await save.waitFor({ timeout: HUNG_MS })
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    const options = await until(() => (projectJson().workflow?.preset === 'pairAgent' ? projectJson().workflow.options : null), HUNG_MS)
    check('Pair (the agent merges) saved from the form: the agent merges, cards on slots, the quick check', !!options && options.finish === 'agentMerges' && options.folder === 'slots' && JSON.stringify(options.preChecks) === '["typecheck"]', JSON.stringify(projectJson().workflow))
    if (options?.identity) identity = options.identity

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1' })
    // The fake trusts the folders it is told of (its trust prompt never shows): the project's slots too, as B1 works in
    // the lane's (one left at the prompt is never quiet, so Combwork would never prepare its next card's line).
    const slotRoot = path.join(`${ws}.worktrees`, 'alpha')
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, alpha, ...'abcdefgh'.split('').map((x) => path.join(slotRoot, `slot-${x}`))].map((d) => d.toLowerCase())))
    check('B1 is a builder in the project folder (no worktree of its own)', !b1.worktree, JSON.stringify(b1))
    /** The slot the lane's cards are built in (a card's start names it), and the line of the card started last. */
    let wt = null
    let line = null
    const cards = []
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five', 'Six']) cards.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [c1, c2, c3, c4, c5, c6] = cards
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const keyOf = async (n) => (await card(n)).key
    const facts = async (n) => inv('tasks:facts', n)
    const kinds = async (n) => (await facts(n)).map((f) => f.kind)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

    // --- A lane from the board (#1280): the Todo column's Start Lane with These Cards….
    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) === 6, HUNG_MS)
    await column('Todo').locator('.board-column-header').click({ button: 'right' })
    const item = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
    await until(async () => (await item('Start Lane with These Cards…').count()) === 1, HUNG_MS)
    await item('Start Lane with These Cards…').click()
    const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    await dialog.locator('#lane-start-builder').selectOption(b1.id)
    await dialog.locator('#lane-start-reviewer').selectOption(r1.id)
    await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
    const lane = await until(async () => (await inv('lanes:list')).find((l) => l.builder.id === b1.id && l.state !== 'ended'), HUNG_MS)
    check('the lane is started from the board: B1 / R1, its six cards in order', !!lane && lane.reviewer?.id === r1.id && JSON.stringify(lane.cards.map((x) => x.number)) === JSON.stringify(cards), JSON.stringify(lane))
    const lentSlot = await until(async () => (await inv('lanes:list')).find((l) => l.id === lane?.id)?.slot, HUNG_MS)
    const lent = lentSlot ? path.join(slotRoot, lentSlot) : null
    check('the lane is lent a slot', !!lent, JSON.stringify((await inv('lanes:list')).find((l) => l.id === lane?.id)?.slot ?? null))
    const idleIn = async (id, folder) => {
      const s = await live(id)
      return !!s && ['ready', 'finished'].includes(s.status) && (!folder || s.cwd?.toLowerCase() === folder.toLowerCase())
    }
    // B1 is started again in the lane's slot (a new conversation, a launch with its own token): read once it runs there.
    check("both agents run, B1 in the lane's slot", !!(await until(async () => (await idleIn(b1.id, lent)) && (await idleIn(r1.id)), HUNG_MS)), JSON.stringify(await live(b1.id)))

    // The agents' own tokens, from their launches, as their Combwork tools read them (progressgates').
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await until(async () => (await live(id))?.sessionId, HUNG_MS))
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const tokens = { b1: await tokenOf(b1.id), r1: await tokenOf(r1.id) }
    check('each agent has its own token', !!tokens.b1 && !!tokens.r1)
    /** An agent's intent on a card (`#n`): its status and reply. */
    const intent = async (who, n, name, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    // The builder's shell (the fake's "shell:" step), as cw-progress runs in its session.
    const shells = () => {
      const f = path.join(claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    /** The lines the fake took as wakes (fake-wakes.jsonl), an agent's. */
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent)
    }
    // A line typed into B1 (typeLine): Combwork may type a wake into it at the same moment (a verdict's, a line moved's), and
    // the line is typed again when the wake disturbed it or B1 dropped it.
    // Each try waits for B1 idle with its inbox quiet (HI-1918: idle between Combwork's own turns isn't enough).
    const typeTo = (text, taken) => lib.typeLine(inv, lib.ptyKey(alpha, b1.id), claudeHome, 'B1', text, { ready: async () => lib.agentQuiet(PORT, 'alpha', await live(b1.id), tokens.b1), strict: true, ...(taken ? { taken } : { live: () => live(b1.id) }), hungMs: 60000 })
    const shell = async (cmd) => {
      const before = shells().length
      await typeTo(`shell: ${cmd}`)
      await until(() => shells().length > before, 60000)
      await until(() => idle(b1.id), HUNG_MS)
      const ran = shells().slice(before).find((s) => s.cmd === cmd)
      if (!ran) throw new Error(`B1 didn't run "${cmd}" (its line wasn't taken)`)
      return ran
    }
    /** The quick check through cw-progress on the card's revision now: true once a new counted CheckRan is on the card. */
    const counted = (f) => f.kind === 'CheckRan' && f.data?.counted === true
    const quickCheck = async (n) => {
      const before = (await facts(n)).filter(counted).length
      await shell(`cw-progress --check typecheck --card ${await keyOf(n)}`)
      return !!(await until(async () => (await facts(n)).filter(counted).length > before, HUNG_MS))
    }
    const commit = (file) => {
      fs.writeFileSync(path.join(wt, file), `${file}\n`)
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', file)
      return git(wt, 'rev-parse', 'HEAD')
    }
    /** A card's revision under review: its last submission's files. */
    const submittedFiles = async (n) => JSON.stringify(((await facts(n)).findLast((f) => f.kind === 'Submitted')?.data?.files ?? []).map((f) => f.path))
    /** A card built in B1's worktree (one commit, `file`), its quick check counted, submitted, reviewed and passed. */
    const build = async (n, file) => {
      const rev = commit(file)
      check(`${await keyOf(n)}'s quick check through cw-progress --check is counted`, await quickCheck(n))
      const sub = await intent('b1', n, 'submit', { summary: `${file} ready` })
      check(`${await keyOf(n)} submitted: Review`, sub.status === 200 && (await card(n)).column === 'review', JSON.stringify(sub.body))
      check(`${await keyOf(n)}'s change is only its own work`, (await submittedFiles(n)) === JSON.stringify([file]), await submittedFiles(n))
      await intent('r1', n, 'start-review')
      const pass = await intent('r1', n, 'verdict', { pass: true, comment: `${file}: PASSED` })
      check(`the reviewer passes ${await keyOf(n)}: Passed`, pass.status === 200 && (await card(n)).column === 'passed', JSON.stringify(pass.body))
      return rev
    }
    /**
     * The builder reports a card's merge: Done, its merge checked (Integrated). Combwork may have seen the merge in main
     * first (reconciliation, S7): then the card is Done already and the report has nothing left to do.
     */
    const reportMerge = async (n) => {
      const r = await intent('b1', n, 'report-merge')
      const done = await until(async () => (await card(n)).column === 'done', HUNG_MS)
      return { ok: (r.status === 200 || (r.status === 409 && r.body?.rule === 'move.notFromHere')) && !!done && (await kinds(n)).includes('Integrated'), r }
    }
    const squash = (rev, message) => {
      git(alpha, 'merge', '-q', '--squash', rev)
      git(alpha, 'commit', '-qm', message)
      return git(alpha, 'rev-parse', 'main')
    }
    /**
     * A card's start, and its Started fact's base and line. Started, it is built in the folder the start names (`wt`, the
     * lane's slot) on its line (`line`) once Combwork has made it there (`made: false` skips that wait).
     */
    const start = async (n, { made = true } = {}) => {
      const s = await intent('b1', n, 'start')
      const started = (await facts(n)).find((f) => f.kind === 'Started')?.data
      if (s.status === 200 && s.body?.data?.folder) {
        wt = s.body.data.folder
        line = s.body.data.line
        if (made) await until(() => git(wt, 'branch', '--show-current') === line, HUNG_MS)
      }
      return { s, base: started?.base, line: started?.line }
    }
    const onLine = () => git(wt, 'branch', '--show-current') === line
    const branchExists = (name) => git(alpha, 'branch', '--list', name) !== ''
    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click().catch(() => undefined)
    await until(async () => (await panel.count()) === 1, HUNG_MS)
    const top = panel.locator(`.progress-lane[data-lane="${lane?.id}"] .progress-lane-top`)
    const topText = async () => ((await top.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const onBoard = async (label, n) => (await column(label).locator('.task-card', { hasText: await keyOf(n) }).count()) === 1
    /** A screenshot once the window shows `ready` (HR2's round 1: the board drawn as the stage, not just the lane there). */
    const shoot = async (name, ready) => {
      check(`the window shows the stage before ${name}.png`, !!(await until(async () => (await top.count()) === 1 && (await ready()), HUNG_MS)), await topText())
      await page.screenshot({ path: path.join(shots, `${name}.png`) })
    }
    // Card 1 arrives with the lane's brief (HI-2558): Combwork starts it on B1 as the lane starts, never the brief first.
    check('card 1 is started by Combwork as the lane starts (HI-2558)', !!(await until(async () => (await kinds(c1)).includes('Started') && (await card(c1)).column === 'doing', HUNG_MS)), JSON.stringify(await kinds(c1)))
    await shoot('1-lane-started', async () => (await onBoard('Active', c1)) && (await onBoard('Todo', c2)) && /B1 \/ R1/.test(await topText()))

    // --- Card 1: built on its line in the slot, checked, submitted, reviewed and passed; merged (a merge commit) and reported.
    const main0 = git(alpha, 'rev-parse', 'main')
    const { s: s1, base: base1, line: line1 } = await start(c1)
    check("card 1 starts in the lane's slot, on its line from main's head", s1.status === 200 && wt?.toLowerCase() === lent?.toLowerCase() && base1 === main0 && onLine() && git(wt, 'rev-parse', 'HEAD') === main0, JSON.stringify(s1.body))
    const early = await intent('b1', c2, 'start')
    check('…the next card waits for it (one card at a time)', early.status === 409 && early.body?.rule === 'lane.oneAtATime', JSON.stringify(early.body))
    await build(c1, 'one.txt')
    await shoot('2-card1-passed', () => onBoard('Approved', c1))
    const notMerged = await intent('b1', c1, 'report-merge')
    check('a merge reported before it is in main is refused (done.contained)', notMerged.status === 409 && notMerged.body?.rule === 'done.contained', JSON.stringify(notMerged.body))
    git(alpha, 'merge', '-q', '--no-ff', '-m', 'merge card 1', line1)
    const done1 = await reportMerge(c1)
    check('merged and reported: Done, its merge checked', done1.ok, JSON.stringify(done1.r.body))
    // The next card starts on a line of its own from main (card 1 in it); card 1's line, merged, goes once that is out.
    const main1 = git(alpha, 'rev-parse', 'main')
    const s2 = await start(c2)
    check('only then does card 2 start, in the slot still, on its own line from main (card 1 merged in)', s2.s.status === 200 && wt?.toLowerCase() === lent?.toLowerCase() && s2.base === main1 && s2.line !== line1 && git(wt, 'rev-parse', 'HEAD') === main1 && !(await kinds(c1)).includes('LineMoved'), JSON.stringify(s2))
    check("…card 1's line, merged, deleted (LineDeleted)", !!(await until(async () => (await kinds(c1)).includes('LineDeleted'), HUNG_MS)) && !branchExists(line1), JSON.stringify(await kinds(c1)))

    // --- Card 2, the first squash: merged while B1 is busy; card 3 starts, its slot left as it is until B1 is quiet.
    const wakesBefore = wakes('B1').length
    await build(c2, 'two.txt')
    const line2 = line
    // B1 in a turn (until the suite lets it go) as it merges: its slot must wait for it. The verdict's loop wake taken
    // first (typed while the suite types, it would end that turn at once), then B1 idle.
    await until(() => wakes('B1').length > wakesBefore, HUNG_MS)
    const holding = async () => (await live(b1.id))?.status === 'working'
    await typeTo('holduntil p4lane-go', holding)
    check('B1 is working', !!(await until(holding, HUNG_MS)))
    const main2 = squash(line2, 'card 2 (squash)')
    const done2 = await reportMerge(c2)
    check('card 2 squash-merged and reported: Done (contained by its replay)', done2.ok, JSON.stringify(done2.r.body))
    const s3 = await start(c3, { made: false })
    const prepared = async (n) => (await kinds(n)).includes('SlotPrepared')
    check('card 3 starts while B1 works; its slot not touched yet (still on card 2\'s line, not prepared)', s3.s.status === 200 && s3.base === main2 && git(wt, 'branch', '--show-current') === line2 && !(await prepared(c3)), JSON.stringify({ s3, branch: git(wt, 'branch', '--show-current'), kinds: await kinds(c3) }))
    await shoot('3-card3-waits-for-b1', async () => (await onBoard('Done', c2)) && (await onBoard('Active', c3)))
    fs.writeFileSync(path.join(claudeHome, 'p4lane-go'), '')
    check("B1 quiet: card 3's line is made in the slot from main (card 2's squash in), no branch moved", !!(await until(async () => (await prepared(c3)) && onLine(), HUNG_MS)) && git(wt, 'rev-parse', 'HEAD') === main2 && !(await kinds(c2)).includes('LineMoved'), JSON.stringify({ branch: git(wt, 'branch', '--show-current'), kinds: await kinds(c3) }))
    check("…card 2's line, squashed into main, deleted (LineDeleted)", !!(await until(async () => (await kinds(c2)).includes('LineDeleted'), HUNG_MS)) && !branchExists(line2), JSON.stringify(await kinds(c2)))

    // --- Card 3, the second squash: card 4 starts on its own line from main.
    await build(c3, 'three.txt')
    const main3 = squash(line, 'card 3 (squash)')
    const done3 = await reportMerge(c3)
    check('card 3 squash-merged and reported: Done', done3.ok, JSON.stringify(done3.r.body))
    const s4 = await start(c4)
    check('card 4 starts on its own line from main (card 3\'s squash in), no branch moved', s4.s.status === 200 && s4.base === main3 && git(wt, 'rev-parse', 'HEAD') === main3 && !(await kinds(c3)).includes('LineMoved'), JSON.stringify(s4))
    await shoot('4-card4-on-main', async () => (await onBoard('Active', c4)) && (await onBoard('Done', c3)))

    // --- Card 4: squash-merged after a commit made past its approval: card 5 starts on its own line, and card 4's line,
    // holding work that isn't in main, is kept (only a line its target contains is deleted, §16.10).
    const approved4 = await build(c4, 'four.txt')
    const line4 = line
    const late = commit('late.txt')
    const main4 = squash(approved4, 'card 4 (squash)')
    const done4 = await reportMerge(c4)
    check('card 4 squash-merged (its approved revision) and reported: Done', done4.ok, JSON.stringify(done4.r.body))
    const s5 = await start(c5)
    check("card 5 starts on its own line from main: its change won't carry card 4's late commit", s5.s.status === 200 && s5.base === main4 && git(wt, 'rev-parse', 'HEAD') === main4 && !fs.existsSync(path.join(wt, 'late.txt')), JSON.stringify(s5))
    await shoot('5-card5-started', async () => (await onBoard('Active', c5)) && (await onBoard('Done', c4)))

    // --- Card 5, merged, is the checkpoint (HR4's round 1): a pass deletes the lane's Done cards' merged lines one after
    // another in the lane's order (slotCards.ts, settleOnce's step 3), so card 5's LineDeleted, once card 6's line is
    // out, comes from a pass that has already looked at card 4's line, which no slot has had checked out since card 5
    // started. Card 4's line is then still there, the late commit its tip, and no deletion of it was begun.
    await build(c5, 'five.txt')
    const line5 = line
    git(alpha, 'merge', '-q', '--no-ff', '-m', 'merge card 5', line5)
    const done5 = await reportMerge(c5)
    check('card 5 merged and reported: Done', done5.ok, JSON.stringify(done5.r.body))
    const s6 = await start(c6)
    check('card 6 starts on its own line from main', s6.s.status === 200 && s6.base === git(alpha, 'rev-parse', 'main') && onLine(), JSON.stringify(s6))
    check("…card 5's line, merged, deleted (LineDeleted): a pass has looked at card 4's line after it", !!(await until(async () => (await kinds(c5)).includes('LineDeleted'), HUNG_MS)) && !branchExists(line5), JSON.stringify(await kinds(c5)))
    check("…card 4's line kept, the commit made after its approval its tip (not in main, so not deleted), no deletion begun", branchExists(line4) && git(alpha, 'rev-parse', line4) === late && !(await kinds(c4)).some((k) => k === 'LineDeleting' || k === 'LineDeleted'), JSON.stringify({ kinds: await kinds(c4), branch: branchExists(line4) }))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
