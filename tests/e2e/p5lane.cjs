// S55, P5's RC scenario end to end (#1358, SPEC §16.18, §16.19.1-2), as 1.0 builds it (#1573: §16.10's slots, no
// worktree agents): "Pair (Hive merges)", the Assistant off, on fake Claude Code agents acting by their own tokens (their
// hive tools' calls), B1 added in the project folder. The project's options are set through Version Control → Workflow
// (#1355's form: Pair, with G8 strict on); lanes are started from the board, each lent a slot that B1 then works in.
// The quick check is the project's `typecheck` script, steered from outside the repository (queueFixture.cjs's check),
// run by the builder through hive-progress --check before each submit (counted) and by the queue on the merged result.
// Lane A (merge commits, strict):
// - One: built on its line in the lane's slot (the next card's start refused meanwhile: one card at a time), submitted,
//   passed; the queue merges its line at the approved revision (testing shown in the Merges tab): Done, and only then
//   does Two start, its line from main's head (One in it), One's merged line deleted once Two's is out;
// - Two: main moves while it is in review; strict: the queue brings it up to date on its own ref (Updated) and merges
//   it, the slot untouched;
// - Three: main changes the same line while it is in review: returned (notUpToDate) naming the file, the slot
//   untouched; B1 resumes in it cleanly (merges main, checks, submits), the review passes, merged with no update. The
//   lane ends verified (S21's queue part: started and answered from the window, the Assistant off).
// Lane B (G6 squash): Four and Five squash-merged by the queue; Five's line is made from main with Four's squash in, so
// its change is only its own (no branch moved: LineMoved is a 0.9 worktree's, §16.19.2). The lane ends verified.
// A screenshot of the lane and the Merges tab at each stage, once the window shows it. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47854))
const fx = q.queueProject('p5lane')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const waitHung = (fn) => lib.until(fn, HUNG_MS, 200)
const slash = (p) => p.replace(/\\/g, '/')
const alpha = fx.alpha
/** Whether `x` is in `y`'s history (git's merge-base --is-ancestor; lib.git throws on its "no"). */
const ancestor = (x, y) => {
  try {
    lib.git(alpha, ['merge-base', '--is-ancestor', x, y])
    return true
  } catch {
    return false
  }
}

;(async () => {
  q.prepare(fx)
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(fx.claudeHome)
  // The repository's own commit identity, which the preset takes as G12's: never the machine's global one (a clean
  // Windows, as in the Sandbox checks, has none, and the queue would pause for it).
  lib.git(alpha, ['config', 'user.name', fx.identity.name])
  lib.git(alpha, ['config', 'user.email', fx.identity.email])
  // The project's quick check, as the preset offers it from its scripts: `typecheck`, which runs the fixture's check.
  fs.writeFileSync(path.join(alpha, 'package.json'), JSON.stringify({ name: 'alpha', scripts: { typecheck: `node "${slash(path.join(fx.tools, 'check.js'))}"` } }, null, 2) + '\n')
  lib.git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  lib.git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'scripts'])
  const h = await q.startHive(fx, { port: PORT, keepOptions: true })
  const { page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1500, height: 950 })
    await page.getByText('alpha', { exact: true }).first().click()
    const projectJson = () => JSON.parse(fs.readFileSync(path.join(alpha, '.hive', 'project.json'), 'utf8'))

    // --- Pair (Hive merges), strict on, through Version Control → Workflow (#1355, #1352).
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await page.locator('.git-sections [data-section="workflow"]').click()
    const form = page.locator('.workflow-form')
    await waitHung(async () => (await form.count()) > 0)
    // The preset previewed, then used (#1418): it fills the form, saved with Save….
    await form.locator('.workflow-choice[data-choice="pair"]').click()
    await form.locator('.workflow-preview [data-action="use-choice"]').click()
    const strictRow = form.locator('.workflow-option[data-option="strict"]')
    await waitHung(async () => (await strictRow.count()) === 1)
    await strictRow.scrollIntoViewIfNeeded()
    await strictRow.locator('[role="switch"], input[type="checkbox"]').first().click()
    await form.getByRole('button', { name: 'Save…' }).click()
    const save = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await save.waitFor({ timeout: HUNG_MS })
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    const options = await waitHung(() => (projectJson().workflow?.options?.finish === 'hiveMerges' && projectJson().workflow.options.strict === true ? projectJson().workflow.options : null))
    check("Pair (Hive merges) saved from the form, strict on: Hive merges into main, cards on slots, typecheck before review and on the merged result, the repository's identity",!!options && options.target === 'main' && options.folder === 'slots' && JSON.stringify(options.preChecks) === '["typecheck"]' && JSON.stringify(options.mergeChecks) === '["typecheck"]' && options.identity?.email === fx.identity.email,JSON.stringify(projectJson().workflow))
    await page.keyboard.press('Escape')
    const identity = options?.identity ?? fx.identity
    const git = (cwd, ...args) => lib.git(cwd, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args]).trim()

    const b1 = await q.agent(fx, h, 'B1')
    const r1 = await q.agent(fx, h, 'R1')
    // The slot a lane's cards are built in (its start's folder): the lane's, B1's from the lane's start.
    let wt = null
    check('B1 runs in the project folder (no worktree of its own); each agent has its own token', b1.folder.toLowerCase() === alpha.toLowerCase() && !!b1.token && !!r1.token, b1.folder)
    const tokens = { b1: b1.token, r1: r1.token }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const keyOf = async (n) => (await card(n)).key
    const kinds = async (n) => (await h.facts(n)).map((x) => x.kind)
    const factsOf = async (n, kind) => (await h.facts(n)).filter((x) => x.kind === kind)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    /**
     * An agent's intent on a card by its own token. Starting a lane restarts its agents, each launch with a token of its
     * own, and the restart may come after the lane is listed: refused as unknown (401), the token is read again from the
     * agent's latest launch, once it has a new one, and the intent sent again (a few times at most).
     */
    /** A call to the Agent API with an agent's token: its status and body. */
    const api = async (method, route, body, token) => {
      const res = await fetch(`http://127.0.0.1:${h.port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const intent = async (who, n, name, body = {}) => {
      let r = await q.intent(h, { token: tokens[who] }, n, name, body)
      for (let tries = 0; r.status === 401 && tries < 3; tries++) {
        const was = tokens[who]
        await waitHung(async () => {
          tokens[who] = await tokenOf(who === 'b1' ? b1.id : r1.id)
          return !!tokens[who] && tokens[who] !== was
        })
        r = await q.intent(h, { token: tokens[who] }, n, name, body)
      }
      return r
    }
    /** An agent's token now: its live session's latest launch (starting a lane restarts its agents, each launch its own). */
    const tokenOf = async (id) => {
      const sessionId = await waitHung(async () => (await live(id))?.sessionId)
      const launch = await waitHung(() => q.launches(fx).filter((l) => l.sessionId === sessionId && l.opts['--mcp-config']).at(-1))
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
    }
    /** The agents' tokens after a lane start, once both run again. */
    const retoken = async () => {
      // Until each token is taken (a restart may still be on its way as the lane starts).
      const ok = await waitHung(async () => {
        if (!(await idle(b1.id)) || !(await idle(r1.id))) return false
        tokens.b1 = await tokenOf(b1.id)
        tokens.r1 = await tokenOf(r1.id)
        return (await intent('b1', 0, 'start')).status !== 401 && (await intent('r1', 0, 'start')).status !== 401
      })
      check('…both agents run, with their tokens', !!ok, JSON.stringify(tokens))
    }
    const head = () => q.head(fx, 'main')
    const untouched = (was) => git(wt, 'rev-parse', 'HEAD') === was.head && git(wt, 'status', '--porcelain') === was.status
    const worktreeNow = () => ({ head: git(wt, 'rev-parse', 'HEAD'), status: git(wt, 'status', '--porcelain') })

    // The builder's shell (the fake's "shell:" step), as hive-progress runs in its session (p4lane's).
    const shells = () => {
      const file = path.join(fx.claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const shell = async (cmd) => {
      const before = shells().length
      // Hive may type a wake into B1 as the suite types (a verdict's, a card's task): each try waits for B1 idle with its
      // inbox quiet (HI-1918: idle between Hive's own turns isn't enough), and typeLine types it again when a wake disturbed it.
      let seen = null
      const typed = await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), fx.claudeHome, 'B1', `shell: ${cmd}`, {
        ready: async () => {
          const state = await live(b1.id)
          let pending = await lib.inboxPending(PORT, 'alpha', b1.name, tokens.b1)
          // Its inbox unreadable by the token held: an older launch's (HI-2027). A lane start relaunches its agents,
          // sometimes seconds after the lane is listed (once its slot is prepared), and retoken() may have read the token
          // before; or not at all (its relaunch refused while a prompt waits). Its latest launch's token, read again.
          if (pending === null) {
            tokens.b1 = await tokenOf(b1.id)
            pending = await lib.inboxPending(PORT, 'alpha', b1.name, tokens.b1)
          }
          seen = { status: state?.status, composer: state?.runtime?.composer, pending }
          return lib.agentQuiet(PORT, 'alpha', state, tokens.b1)
        },
        strict: true,
        live: () => live(b1.id),
        hungMs: HUNG_MS
      })
      // Never typed unready (strict): what kept B1 from it, said with the failure (HI-1918).
      if (!typed.attempt) throw new Error(`B1 never took "${cmd}": ${typed.lost.join('; ')}; last seen ${JSON.stringify(seen)}`)
      await waitHung(() => shells().length > before)
      await waitHung(() => idle(b1.id))
      if (!shells().slice(before).some((s) => s.cmd === cmd)) throw new Error(`B1 didn't run "${cmd}" (its line wasn't taken)`)
    }
    const counted = (x) => x.kind === 'CheckRan' && x.data?.counted === true
    /** The quick check through hive-progress on the card's revision now (passing): a new counted CheckRan on it. */
    const quickCheck = async (n) => {
      q.steer(fx, 'pass')
      const before = (await h.facts(n)).filter(counted).length
      await shell(`hive-progress --check typecheck --card ${await keyOf(n)}`)
      return !!(await waitHung(async () => (await h.facts(n)).filter(counted).length > before))
    }
    const commit = (file, text = `${file}\n`) => {
      fs.writeFileSync(path.join(wt, file), text)
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', file)
      return git(wt, 'rev-parse', 'HEAD')
    }
    /** A commit on main in the project folder, as the user makes one there. */
    const userCommit = (file, text, message) => {
      fs.writeFileSync(path.join(alpha, file), text)
      git(alpha, 'add', file)
      git(alpha, 'commit', '-qm', message)
      return head()
    }
    const submittedFiles = async (n) => JSON.stringify(((await factsOf(n, 'Submitted')).at(-1)?.data?.files ?? []).map((x) => x.path))
    /**
     * A card's round in B1's worktree: committed (`file`), its quick check counted, submitted; `meanwhile` runs while it
     * is in review (main moving); the reviewer passes it. The merge check is steered to `merge` as the verdict comes.
     */
    const round = async (n, file, { text, meanwhile, merge = 'pass', commitIt = true, watched = false } = {}) => {
      const rev = commitIt ? commit(file, text) : git(wt, 'rev-parse', 'HEAD')
      check(`${await keyOf(n)}'s quick check through hive-progress --check is counted`, await quickCheck(n))
      // HI-2015: B1 watching its card before it submits (card-loop's order), its column moves too, isn't woken by its own
      // submission's move into Review (the checks gate on): its first wake is the reviewer's verdict.
      if (watched) {
        const w = await api('POST', '/v1/tasks/wait', { cards: [n], changes: ['verdict', 'column', 'comment'], wake: true }, tokens.b1)
        check(`B1 watches ${await keyOf(n)} before it submits`, w.status === 200 && !!w.body?.watching, JSON.stringify(w.body))
      }
      const sub = await intent('b1', n, 'submit', { summary: `${file} ready` })
      check(`${await keyOf(n)} submitted: Review`, sub.status === 200 && (await card(n)).column === 'review', JSON.stringify(sub.body))
      const moved = meanwhile ? meanwhile() : null
      const was = worktreeNow()
      await intent('r1', n, 'start-review')
      q.steer(fx, merge)
      const pass = await intent('r1', n, 'verdict', { pass: true, comment: `${file}: PASSED` })
      check(`the reviewer passes ${await keyOf(n)}`, pass.status === 200, JSON.stringify(pass.body))
      if (watched) {
        const wakes = async () => ((await api('GET', `/v1/projects/alpha/agents/${encodeURIComponent(b1.name)}/deliveries?limit=200`, undefined, tokens.b1)).body?.deliveries ?? []).filter((d) => d.kind === 'card-event' && String(d.text ?? '').startsWith('[Hive] '))
        const first = await waitHung(async () => (await wakes())[0])
        check(`…B1's first wake on ${await keyOf(n)} is the verdict, not its own move into Review`, !!first && /passed it|is in Passed/.test(first.text) && !/is in Review/.test(first.text), JSON.stringify(await wakes()))
      }
      return { rev, moved, was }
    }
    const done = async (n) => !!(await waitHung(async () => (await card(n)).column === 'done'))
    const integrated = async (n) => (await factsOf(n, 'Integrated')).at(-1)
    /** A card's start by B1: in the lane's slot (`wt` from then on), on its line once Hive has made it there. */
    const start = async (n) => {
      const s = await intent('b1', n, 'start')
      const started = (await factsOf(n, 'Started')).at(-1)?.data
      if (s.status === 200 && s.body?.data?.folder) {
        wt = s.body.data.folder
        await waitHung(() => git(wt, 'branch', '--show-current') === s.body.data.line)
      }
      return { s, base: started?.base, line: started?.line }
    }

    // The window: the board, and the Progress panel's Lanes and Merges tabs.
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
    const onBoard = async (label, n) => (await column(label).locator('.task-card', { hasText: await keyOf(n) }).count()) === 1
    const panel = page.locator('.progress-panel')
    const showTab = async (name) => {
      if (!(await panel.count())) await page.locator('.progress-rail').click()
      await waitHung(async () => (await panel.count()) === 1)
      await panel.locator(`.progress-tab[data-tab="${name}"]`).click()
      await waitHung(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1)
    }
    const queueCard = panel.locator('.progress-queue-card[data-queue="alpha#main"]')
    const queueText = async () => ((await queueCard.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    /** A screenshot of the window once it shows `ready`, with the panel on `tab`. */
    const shoot = async (name, tab, ready) => {
      await page.getByRole('button', { name: 'Task Board' }).click()
      await showTab(tab)
      check(`the window shows the stage before ${name}.png`, !!(await waitHung(ready)), tab === 'merges' ? await queueText() : await panel.innerText().catch(() => ''))
      await page.mouse.move(5, 5)
      await page.screenshot({ path: path.join(fx.shots, `${name}.png`) })
    }
    const laneRow = (id) => panel.locator(`.progress-lane[data-lane="${id}"]`)
    const laneText = async (id) => ((await laneRow(id).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    /** A lane started from the board: the Todo column's Start Lane with These Cards…, B1 / R1. */
    const startLane = async (cards) => {
      await page.getByRole('button', { name: 'Task Board' }).click()
      await waitHung(async () => (await column('Todo').locator('.task-card').count()) === cards.length)
      await column('Todo').locator('.board-column-header').click({ button: 'right' })
      const item = page.locator('.menu[role="menu"] .menu-item', { hasText: 'Start Lane with These Cards…' })
      await waitHung(async () => (await item.count()) === 1)
      await item.click()
      const dialog = page.locator('.dialog', { hasText: 'Start Lane' })
      await waitHung(async () => (await dialog.count()) === 1)
      await dialog.locator('#lane-start-builder').selectOption(b1.id)
      await dialog.locator('#lane-start-reviewer').selectOption(r1.id)
      await dialog.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
      return waitHung(async () => (await inv('lanes:list')).find((l) => l.builder.id === b1.id && l.state !== 'ended' && JSON.stringify(l.cards.map((x) => x.number)) === JSON.stringify(cards)))
    }
    const laneNow = async (id) => (await inv('lanes:list')).find((l) => l.id === id)
    /** The lane ended verified: ended, its merge commit the last card's result (from the facts). */
    const endedVerified = async (id, last) => waitHung(async () => {
      const l = await laneNow(id)
      return l?.state === 'ended' && l.mergeCommit === (await integrated(last))?.data?.result ? l : null
    })

    // ===== Lane A: Pair, merge commits, strict.
    const laneA = []
    for (const title of ['One', 'Two', 'Three']) laneA.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [c1, c2, c3] = laneA
    const a = await startLane(laneA)
    check('lane A is started from the board: B1 / R1, its three cards in order', !!a, JSON.stringify(await inv('lanes:list')))
    await retoken()
    await shoot('1-laneA-started', 'lanes', async () => (await onBoard('Todo', c1)) && /B1 \/ R1/.test(await laneText(a?.id)))

    // --- One: merged by the queue at the approved revision; the next card waits for it.
    // The lane's slot, once recorded: a lane takes it over from its builder's own as that lease lets go (HI-2027).
    const lentA = await waitHung(async () => (await laneNow(a?.id))?.slot ?? null)
    const { s: s1, base: base1, line: line1 } = await start(c1)
    check("One starts in the lane's slot, on its line from main's head", s1.status === 200 && !!lentA && path.basename(wt ?? '') === lentA && base1 === head() && git(wt, 'rev-parse', 'HEAD') === base1, JSON.stringify({ lane: lentA, start: s1.body }))
    check('…B1 works there now', !!(await waitHung(async () => (await live(b1.id))?.cwd?.toLowerCase() === wt?.toLowerCase())), JSON.stringify(await live(b1.id)))
    const early = await intent('b1', c2, 'start')
    check('…the next card waits for it (one card at a time)', early.status === 409 && early.body?.rule === 'lane.oneAtATime', JSON.stringify(early.body))
    const one = await round(c1, 'one.txt', { merge: 'wait', watched: true })
    check("the queue tests One's merge (its check is running)", !!(await waitHung(() => fs.existsSync(fx.started))))
    const k1 = await keyOf(c1)
    await shoot('2-one-testing', 'merges', async () => (await queueText()).includes(`${k1} + main`) && (await onBoard('Merging', c1)))
    const held = await intent('b1', c2, 'start')
    check('…Two still waits while One is merging', held.status === 409, JSON.stringify(held.body))
    const waiting = await waitHung(async () => ((await laneNow(a?.id))?.status?.reason === 'merging' ? (await laneNow(a.id)).status : null))
    check('S43: the lane says it waits for One merging', !!waiting && waiting.card === c1, JSON.stringify((await laneNow(a?.id))?.status))
    await shoot('2b-lane-waits-merging', 'lanes', async () => (await laneText(a?.id)).includes(`waiting: ${k1} merging`))
    fs.writeFileSync(fx.go, 'go')
    check('One is merged by the queue: Done', await done(c1), JSON.stringify(await kinds(c1)))
    const i1 = await integrated(c1)
    const msg1 = git(alpha, 'log', '-1', '--format=%B', 'main')
    check("…Integrated by Hive at the approved revision: a merge commit of One's line, Hive's trailers", i1?.data?.by === 'hive' && i1.data.result === head() && git(alpha, 'rev-parse', 'main^2') === one.rev && msg1.includes(`Hive-Card: ${k1}`) && msg1.includes(`Hive-Revision: ${one.rev}`), JSON.stringify(i1))
    const main1 = head()
    // HI-1990: nobody starts Two. Once One is Done and B1's turn is over, Hive starts it on B1 as the lane's next card, and
    // B1 is given it in its slot; B1's own start then is that start (it raced Hive's), with the same folder and line.
    const byHive = await waitHung(async () => (await factsOf(c2, 'Started')).find((f) => f.actor === 'hive') ?? null)
    check('Hive starts Two on B1 itself once One is Done, with no prompt from the user or the Assistant', !!byHive && byHive.data?.builder === b1.id && (await card(c2))?.agent === b1.id, JSON.stringify({ byHive, card: await card(c2) }))
    check('…and gives it to B1 in its slot (placed there)', !!(await waitHung(async () => (await kinds(c2)).includes('BuilderPlaced'))), JSON.stringify(await kinds(c2)))
    const s2 = await start(c2)
    check("only then does Two start, in the lane's slot still, its line from main's head (One merged in)", s2.s.status === 200 && path.basename(wt ?? '') === lentA && s2.base === main1 && ancestor(one.rev, s2.base) && git(wt, 'rev-parse', 'HEAD') === s2.base, JSON.stringify(s2))
    check("…B1's own start of it is Hive's, told so", (s2.s.body?.warnings ?? []).some((x) => /^Hive started .* for you, as your lane's next card/.test(x)) && (await factsOf(c2, 'Started')).length === 1, JSON.stringify(s2.s.body))
    check("…One's line, merged, deleted once Two's is out (LineDeleted)", !!(await waitHung(async () => (await kinds(c1)).includes('LineDeleted'))) && !git(alpha, 'branch', '--list', line1), JSON.stringify(await kinds(c1)))
    await shoot('3-one-merged', 'lanes', async () => (await onBoard('Done', c1)) && (await onBoard('Active', c2)))

    // --- Two: main moves while it is in review; strict brings it up to date on the queue's own ref.
    const two = await round(c2, 'two.txt', { meanwhile: () => userCommit('meanwhile.txt', 'meanwhile\n', 'the user commits on main') })
    check('Two merged: Done', await done(c2), JSON.stringify(await kinds(c2)))
    const [up] = await factsOf(c2, 'Updated')
    check('…brought up to date by the queue (strict): Updated, carried, from the reviewed revision', up?.data?.carried === true && up.data.from === two.rev, JSON.stringify(up))
    check("…merged with the user's commit kept, naming both revisions", git(alpha, 'log', '-1', '--format=%B', 'main').includes(`Hive-Updated: ${up?.data?.to}`) && git(alpha, 'log', '-1', '--format=%B', 'main').includes(`Hive-Revision: ${two.rev}`) && ancestor(two.moved, 'main'))
    check("…the slot untouched (its HEAD and status as they were)", untouched(two.was), JSON.stringify({ now: worktreeNow(), was: two.was }))

    // --- Three: main changes the same line while it is in review: returned (notUpToDate); B1 resumes cleanly.
    const s3 = await start(c3)
    check('Three starts', s3.s.status === 200, JSON.stringify(s3.s.body))
    const three = await round(c3, 'a.txt', { text: 'one\ntwo by B1\nthree\n', meanwhile: () => userCommit('a.txt', 'one\nTWO by the user\nthree\n', 'the user changes a.txt') })
    const atThree = head()
    const back = await waitHung(async () => ((await card(c3)).column === 'doing' ? (await factsOf(c3, 'IntegrationFailed'))[0] : null))
    check('Three is returned: notUpToDate, naming a.txt; nothing merged', back?.data?.reason === 'notUpToDate' && JSON.stringify(back.data.files) === '["a.txt"]' && head() === atThree, JSON.stringify(back))
    check('…the slot untouched', untouched(three.was) && (await factsOf(c3, 'Updated')).length === 0, JSON.stringify(worktreeNow()))
    const k3 = await keyOf(c3)
    await shoot('4-three-returned', 'merges', async () => (await queueText()).includes(`${k3} returned`) && (await onBoard('Active', c3)))
    // B1 brings its line up to date in the slot (its side kept), checks and submits again; the review passes.
    git(wt, 'merge', '-q', '-X', 'ours', '-m', 'main in', 'main')
    const resumed = await round(c3, 'a.txt', { commitIt: false })
    check('…B1 resumed cleanly in the slot: merged main, a new revision checked and passed', resumed.rev !== three.rev && git(wt, 'status', '--porcelain') === '')
    check('Three merged with no update (already up to date): Done, B1\'s side of a.txt', (await done(c3)) && (await factsOf(c3, 'Updated')).length === 0 && lib.git(alpha, ['show', 'main:a.txt']).replace(/\r\n/g, '\n') === 'one\ntwo by B1\nthree\n', JSON.stringify(await kinds(c3)))
    const endedA = await endedVerified(a?.id, c3)
    check("lane A ends verified: its merge commit Three's result (S21's queue part, the Assistant off)", !!endedA, JSON.stringify(await laneNow(a?.id)))
    await shoot('5-laneA-ended', 'lanes', async () => (await onBoard('Done', c3)) && (await onBoard('Done', c2)))

    // ===== Lane B: G6 squash. Options changed between lanes (the next lane takes them).
    await inv('workflow:setOptions', alpha, { preset: null, options: { ...projectJson().workflow.options, style: 'squash', strict: false } })
    const laneB = []
    for (const title of ['Four', 'Five']) laneB.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [c4, c5] = laneB
    const b = await startLane(laneB)
    check('lane B is started from the board with the squash options', !!b, JSON.stringify(await inv('lanes:list')))
    await retoken()
    // Once recorded: lane A's end lets the slot go to lane B once its builder's turn and deliveries are over (HI-2027).
    const lentB = await waitHung(async () => (await laneNow(b?.id))?.slot ?? null)
    const main3 = head()
    const s4 = await start(c4)
    check("Four starts in lane B's slot, on its line from main's head", s4.s.status === 200 && !!lentB && path.basename(wt ?? '') === lentB && s4.base === main3 && git(wt, 'rev-parse', 'HEAD') === main3, JSON.stringify({ lane: lentB, s4 }))

    // --- Four: squash-merged by the queue; Five's line made from main with it.
    const four = await round(c4, 'four.txt')
    check('Four squash-merged by the queue: Done, one commit on main with its trailers', (await done(c4)) && git(alpha, 'rev-list', '--parents', '-1', 'main').split(' ').length === 2 && git(alpha, 'log', '-1', '--format=%B', 'main').includes(`Hive-Revision: ${four.rev}`), JSON.stringify(await kinds(c4)))
    const main4 = head()
    const s5 = await start(c5)
    check("Five starts on a line of its own from main (Four's squash in), no branch moved", s5.s.status === 200 && s5.base === main4 && git(wt, 'rev-parse', 'HEAD') === main4 && s5.line !== s4.line && !(await kinds(c4)).includes('LineMoved'), JSON.stringify(s5))
    check("…Four's line, squashed into main, deleted once Five's is out (LineDeleted)", !!(await waitHung(async () => (await kinds(c4)).includes('LineDeleted'))) && !git(alpha, 'branch', '--list', s4.line), JSON.stringify(await kinds(c4)))
    const k5 = await keyOf(c5)
    await shoot('6-four-squashed', 'lanes', async () => (await onBoard('Done', c4)) && (await onBoard('Active', c5)))

    // --- Five: only its own work; squash-merged; the lane ends verified.
    await round(c5, 'five.txt', { merge: 'wait' })
    check("Five's change is only its own work (not Four's)", (await submittedFiles(c5)) === JSON.stringify(['five.txt']), await submittedFiles(c5))
    check("the queue tests Five's squash", !!(await waitHung(() => fs.existsSync(fx.started))))
    await shoot('7-five-testing', 'merges', async () => (await queueText()).includes(`${k5} + main`))
    fs.writeFileSync(fx.go, 'go')
    check('Five squash-merged: Done', await done(c5), JSON.stringify(await kinds(c5)))
    const endedB = await endedVerified(b?.id, c5)
    check("lane B ends verified: its merge commit Five's result", !!endedB, JSON.stringify(await laneNow(b?.id)))
    // Each card's own line from the target: after the last, nothing is moved.
    check('…after its last card no line is moved', !(await kinds(c5)).includes('LineMoved'), JSON.stringify(await kinds(c5)))
    await shoot('8-laneB-ended', 'lanes', async () => (await onBoard('Done', c5)) && !!(await laneNow(b?.id))?.state)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
