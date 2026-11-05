// §16.19.2's line continuation on a lane carried over the upgrade (#1579): in 1.0 a builder's 0.9 worktree carries
// its lane on until the lane ends (S56, #1441's carried leases), and between that lane's cards Combwork brings the
// worktree's branch to the target after a squash. B1 is such a builder, a 0.9 worktree agent made through the test
// copies' agents:testLegacy (as #1573's p4lane did before it moved to slots); "Pair (the agent merges)" is set through
// Version Control → Workflow and a lane started from the board, the Assistant off, on fake Claude Code agents acting by
// their own tokens. Card 1 is built in B1's worktree (the next card refused meanwhile), merged with a merge commit and
// reported: no branch moved. Cards 2 and 3 are squash-merged in a row: after card 2 the next card is refused
// (lane.lineBehind) and the lane waits while B1 is busy, after card 3 while its worktree has an untracked file; each
// time, once that clears, Combwork brings the branch to main (LineMoved) and the next card starts there, its change only
// its own. Card 4 is squash-merged after a commit made past its approval: For you (Decide), nothing moved, card 5
// waits. A screenshot at each stage. Throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only, 0.9 worktrees on purpose (#1579): a packaged build refuses agents:testLegacy, and 1.0 adds no
// worktree agents; S54 on slots is p4lane's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const PORT = Number(lib.port(47812))
const userData = path.join(lib.WORK, 'linecarried-profile')
const ws = path.join(lib.WORK, 'linecarried-ws')
const claudeHome = path.join(lib.WORK, 'linecarried-claude-home')
const shots = path.join(lib.WORK, 'linecarried-shots')
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
  // Every read of the agents' input recorded, for typeLine (#1560).
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
  // The Assistant off: a test copy never starts it.
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The dev build: B1 is made through a test channel a packaged build refuses.
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' } })
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
    check('Pair (the agent merges) saved from the form: the agent merges, the quick check', !!options && options.finish === 'agentMerges' && options.folder === 'slots' && JSON.stringify(options.preChecks) === '["typecheck"]', JSON.stringify(projectJson().workflow))
    if (options?.identity) identity = options.identity

    // B1 on a 0.9 worktree of its own, as an upgraded workspace's builder whose lane carries on there.
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', location: 'new-worktree' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1' })
    const wt = b1.worktree?.path
    const line = b1.worktree?.branch
    fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws, alpha, wt].filter(Boolean).map((d) => d.toLowerCase())))
    check("B1 builds in its own worktree", !!wt && fs.existsSync(wt), JSON.stringify(b1.worktree))
    const cards = []
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) cards.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [c1, c2, c3, c4, c5] = cards
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const keyOf = async (n) => (await card(n)).key
    const facts = async (n) => inv('tasks:facts', n)
    const kinds = async (n) => (await facts(n)).map((f) => f.kind)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)

    // --- A lane from the board (#1280): the Todo column's Start Lane with These Cards….
    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    await until(async () => (await column('Todo').locator('.task-card').count()) === 5, HUNG_MS)
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
    check('the lane is started from the board: B1 / R1, its five cards in order', !!lane && lane.reviewer?.id === r1.id && JSON.stringify(lane.cards.map((x) => x.number)) === JSON.stringify(cards), JSON.stringify(lane))
    const laneNow = async () => (await inv('lanes:list')).find((l) => l.id === lane?.id)
    check('both agents run', !!(await until(async () => !!(await live(b1.id)) && !!(await live(r1.id)), HUNG_MS)))

    // The agents' own tokens, from their launches, as their hive tools read them (progressgates').
    const launchesFile = path.join(claudeHome, 'fake-launches.jsonl')
    const launches = () => {
      const text = fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    const tokenOf = async (id) => {
      const sessionId = (await until(async () => (await live(id))?.sessionId, HUNG_MS))
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token : null
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
    const typeTo = async (id, text) => {
      // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
      await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
    }
    const shell = async (cmd) => {
      const before = shells().length
      // A wake Combwork types into B1 as the suite types (a verdict's, a line moved's) is taken with the suite's line as one
      // wake, and the command isn't run: seen as that wake taken, it is typed again (a few times at most).
      for (let tries = 0; tries < 3 && shells().length === before; tries++) {
        await until(() => idle(b1.id), HUNG_MS)
        const taken = wakes('B1').length
        await typeTo(b1.id, `shell: ${cmd}`)
        await until(() => shells().length > before || wakes('B1').length > taken, 60000)
      }
      await until(() => idle(b1.id), HUNG_MS)
      const ran = shells().slice(before).find((s) => s.cmd === cmd)
      if (!ran) throw new Error(`B1 didn't run "${cmd}" (its line was taken with a wake each time)`)
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
    /** A card's start, and its Started fact's base. */
    const start = async (n) => {
      const s = await intent('b1', n, 'start')
      return { s, base: (await facts(n)).find((f) => f.kind === 'Started')?.data?.base }
    }
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
    await shoot('1-lane-started', async () => (await onBoard('Todo', c1)) && /B1 \/ R1/.test(await topText()))

    // --- Card 1: built in B1's worktree, checked, submitted, reviewed and passed; merged (a merge commit) and reported.
    const s1 = await intent('b1', c1, 'start')
    check("card 1 starts in B1's worktree", s1.status === 200 && s1.body?.data?.folder?.toLowerCase() === wt?.toLowerCase(), JSON.stringify(s1.body))
    const early = await intent('b1', c2, 'start')
    check('…the next card waits for it (one card at a time)', early.status === 409 && early.body?.rule === 'lane.oneAtATime', JSON.stringify(early.body))
    await build(c1, 'one.txt')
    await shoot('2-card1-passed', () => onBoard('Approved', c1))
    const notMerged = await intent('b1', c1, 'report-merge')
    check('a merge reported before it is in main is refused (done.contained)', notMerged.status === 409 && notMerged.body?.rule === 'done.contained', JSON.stringify(notMerged.body))
    git(alpha, 'merge', '-q', '--no-ff', '-m', 'merge card 1', line)
    const done1 = await reportMerge(c1)
    check('merged and reported: Done, its merge checked', done1.ok, JSON.stringify(done1.r.body))
    // A merge commit leaves the branch in main: nothing to bring up to date, the next card starts.
    const s2 = await start(c2)
    check('only then does card 2 start; a merge commit needs no update of the branch', s2.s.status === 200 && !(await kinds(c1)).includes('LineMoved'), JSON.stringify(s2.s.body))

    // --- Card 2, the first squash: merged while B1 is busy, the next card waits (the lane says why); idle, it moves.
    const wakesBefore = wakes('B1').length
    await build(c2, 'two.txt')
    // B1 in a turn (until the suite lets it go) as it merges: its branch must wait for it. The verdict's loop wake taken
    // first (typed while the suite types, it would end that turn at once), then B1 idle.
    await until(() => wakes('B1').length > wakesBefore, HUNG_MS)
    await until(() => idle(b1.id), HUNG_MS)
    await typeTo(b1.id, 'holduntil linecarried-go')
    check('B1 is working', !!(await until(async () => (await live(b1.id))?.status === 'working', HUNG_MS)))
    const main2 = squash(line, 'card 2 (squash)')
    const done2 = await reportMerge(c2)
    check('card 2 squash-merged and reported: Done (contained by its replay)', done2.ok, JSON.stringify(done2.r.body))
    const waiting = await until(async () => ((await laneNow())?.status?.reason === 'lineUpdate' ? (await laneNow()).status : null), HUNG_MS)
    check("…the lane waits while B1's branch is brought up to date", !!waiting && waiting.card === c3, JSON.stringify((await laneNow())?.status))
    const held = await intent('b1', c3, 'start')
    check("…card 3 can't start yet (lane.lineBehind), nothing moved while B1 works", held.status === 409 && held.body?.rule === 'lane.lineBehind' && !(await kinds(c2)).includes('LineMoved'), JSON.stringify(held.body))
    const why3 = `bringing the builder’s branch up to date before ${await keyOf(c3)}`
    await shoot('3-waiting-for-the-branch', async () => (await topText()).includes(why3) && (await onBoard('Done', c2)))
    fs.writeFileSync(path.join(claudeHome, 'linecarried-go'), '')
    const moved2 = await until(async () => (await facts(c2)).find((f) => f.kind === 'LineMoved'), HUNG_MS)
    check('B1 idle and its worktree clean: its branch is brought to main, recorded (LineMoved)', !!moved2 && moved2.data?.to === main2 && git(wt, 'rev-parse', 'HEAD') === main2, JSON.stringify(moved2?.data))
    // Combwork may start card 3 itself first, once B1 is idle (HI-1990): B1's own start is then that start, even one whose
    // checks Combwork's write came between (HI-2029; HI-2039). Who started it is in the facts, said if it fails.
    const s3 = await start(c3)
    check('card 3 starts on the moved branch: its base is main', s3.s.status === 200 && s3.base === main2, JSON.stringify({ s3, main2, facts: (await facts(c3)).map((f) => [f.seq, f.kind, f.actor, f.data?.builder ?? f.data?.to ?? null]) }))

    // --- Card 3, the second squash: the worktree not clean, it waits; clean, it moves again, and card 4 starts there.
    await build(c3, 'three.txt')
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'not yet\n')
    const main3 = squash(line, 'card 3 (squash)')
    const done3 = await reportMerge(c3)
    check('card 3 squash-merged and reported: Done', done3.ok, JSON.stringify(done3.r.body))
    // The lane's lineUpdate for card 4 is published by a pass that found the worktree dirty and moved nothing (#1579).
    check('…with an untracked file in its worktree, the branch waits (the lane says why)', !!(await until(async () => (await laneNow())?.status?.reason === 'lineUpdate' && (await laneNow())?.status?.card === c4, HUNG_MS)) && !(await kinds(c3)).includes('LineMoved'), JSON.stringify((await laneNow())?.status))
    // The builder cleans up in its own turn: once it is idle again, Combwork looks and moves the branch.
    fs.rmSync(path.join(wt, 'scratch.txt'))
    await typeTo(b1.id, 'work 1')
    const moved3 = await until(async () => (await facts(c3)).find((f) => f.kind === 'LineMoved'), HUNG_MS)
    check('clean, its branch is brought to main again (the second LineMoved)', !!moved3 && moved3.data?.to === main3 && git(wt, 'rev-parse', 'HEAD') === main3, JSON.stringify(moved3?.data))
    const s4 = await start(c4)
    check('card 4 starts on main again: its base is the second LineMoved', s4.s.status === 200 && s4.base === main3, JSON.stringify(s4))
    await shoot('4-card4-on-main', async () => (await onBoard('Active', c4)) && (await onBoard('Done', c3)))

    // --- Card 4: squash-merged after a commit made past its approval: For you, nothing moved, card 5 waits.
    const approved4 = await build(c4, 'four.txt')
    commit('late.txt')
    squash(approved4, 'card 4 (squash)')
    const done4 = await reportMerge(c4)
    check('card 4 squash-merged (its approved revision) and reported: Done', done4.ok, JSON.stringify(done4.r.body))
    const asked = await until(async () => (await inv('tasks:forYou')).items?.find((i) => i.card === c5), HUNG_MS)
    check('the commit after approval stops it: For you (Decide) names it, nothing moved', !!asked && asked.kind === 'decide' && /late\.txt/.test(asked.text ?? '') && !(await kinds(c4)).includes('LineMoved') && git(wt, 'log', '-1', '--format=%s') === 'late.txt', JSON.stringify(asked))
    check('…the lane is paused for you', !!(await until(async () => (await laneNow())?.status?.reason === 'you', HUNG_MS)), JSON.stringify((await laneNow())?.status))
    const held5 = await intent('b1', c5, 'start')
    check('…and card 5 waits', held5.status === 409, JSON.stringify(held5.body))
    await shoot('5-paused-for-you', async () => /waiting for you/.test(await topText()) && (await column('Todo').locator('.task-card', { hasText: await keyOf(c5) }).locator('.task-for-you').count()) > 0)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
