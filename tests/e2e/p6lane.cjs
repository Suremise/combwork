// P6's acceptance in the app (#1425, SPEC §16.18, §16.19): projects added to a workspace and set up through their
// Version Control tab, the Assistant off, on fake Claude Code agents acting by their own tokens.
// - alpha (Git), added with a builder and a reviewer: the notice, the step suggests Pair, Choose; the header reads
//   "Workflow: Git · Pair"; the board shows Todo, Active, Review, Approved | Merging and Done. A lane started from the
//   window is lent a slot, B1 (added in the project folder: no worktree agents, #1578) started again there, and runs One: a counted check, submit (Branches & remotes shows the card beside its branch with the revision under
//   review; the Progress panel's hover says Review), review and pass, the queue's merge (Merging, the hover's Approved |
//   Merging), Done (the branch's card merged).
// - S19: Two starts, the options are changed in the tab (squash): the save names the lane keeping old rules, the lane
//   shows its mark, and Two is merged under the lane's rules (a merge commit). The lane ends verified.
// - beta (Git), added with one agent: Solo suggested and chosen; a lane of its one card shows in Pulse while it runs; the
//   card committed in the project folder with no trailer, submitted: Done ("Committed is done", S44); its ended lane is
//   left out of Pulse (no lanes section), kept in the Lanes tab.
// - gamma (Git), all off saved in the tab with G16 on, two agents in the project folder (S11, S39): a card blocked by
//   another starts with a warning, both commit with trailers and submit to Done, the user moves a card back and forth with
//   nothing asked or refused; G16 (#1481): G1's edit hook locks a file, recorded on its card, and G2's commit including
//   it is submitted with the warning naming G1's card.
// - S20 on alpha: `.git` moved away, None offered; switched, a new card starts under None's rules.
// Screenshots in both themes, in English and German: the step, the board, Branches & remotes, the Pulse hovers, the
// legend, the old rules mark, the save's warning, the offer, and each Version Control section of a Git and a None
// project. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// The Merge queue section read slowly (CW_TEST_SLOW_IPC) is NOT RUN on a packaged build (CW_EXE), where the rest
// runs (#1578).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47858))
const fx = q.queueProject('p6lane')
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
const beta = path.join(fx.ws, 'beta')
const gamma = path.join(fx.ws, 'gamma')
const projectJson = (p) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8'))

;(async () => {
  q.prepare(fx)
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(fx.claudeHome)
  // The repository's own identity, which Pair takes as G12's (p5lane's), and its quick check from its scripts (the
  // script's path quoted: the test root may have a space in it).
  lib.git(alpha, ['config', 'user.name', fx.identity.name])
  lib.git(alpha, ['config', 'user.email', fx.identity.email])
  fs.writeFileSync(path.join(alpha, 'package.json'), JSON.stringify({ name: 'alpha', scripts: { typecheck: `node "${slash(path.join(fx.tools, 'check.js'))}"` } }, null, 2) + '\n')
  lib.git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'])
  lib.git(alpha, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'scripts'])
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  const { page, inv, app } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 950 })
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const notice = page.locator('[data-step-notice]')
    const stepEl = page.locator('[data-preset-step]')
    const head = page.locator('[data-vc-head]')
    const offer = page.locator('[data-vc-offer]')
    const dialog = page.locator('.dialog')
    const workflowLine = () => text(head.locator('[data-action="vc-workflow"]'))
    /**
     * An agent's intent (`who`: its token), sent again while Combwork answers evidence.changed, whose next step is "Try again:
     * Combwork reads it afresh" (what it read moved as it decided: a merge's reconcile, the folder's commits read), as an agent
     * does, a few times at most.
     */
    const send = async (who, n, name, body = {}) => {
      let r = await q.intent(h, who, n, name, body)
      for (let tries = 0; r.body?.rule === 'evidence.changed' && tries < 5; tries++) r = await q.intent(h, who, n, name, body)
      return r
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const keyOf = async (n) => (await card(n)).key
    const kinds = async (n) => (await h.facts(n)).map((x) => x.kind)
    const factsOf = async (n, kind) => (await h.facts(n)).filter((x) => x.kind === kind)
    const done = async (n) => !!(await waitHung(async () => (await card(n))?.column === 'done'))

    // German, the long locale, as the window takes a language change (vcswitch's).
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'de')
    const german = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const english = async () => (await page.getByRole('button', { name: 'Task Board', exact: true }).count()) > 0
    /**
     * Screenshots of `loc` (the window by default) in both themes, in English and then German; `show` brings back what
     * the shot is of (a hover) before each, by selectors that don't depend on the language. A dialog's text is set as it
     * opens (#1489): `open` opens it in each language and gives it, `close` closes it after its shots.
     */
    const shoot = async (name, { loc = page, show, open, close } = {}) => {
      for (const lang of ['en', 'de']) {
        if (lang === 'de') {
          await speak({ ...base, code: 'de', locale: 'de', messages: german })
          await waitHung(async () => !(await english()))
        }
        const target = open ? await open() : loc
        for (const theme of ['dark', 'light']) {
          await inv('settings:update', { appearance: { theme } })
          await waitHung(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme)
          if (show) await show()
          else await page.mouse.move(5, 5)
          await target.screenshot({ path: path.join(fx.shots, `p6lane-${name}-${lang}-${theme}.png`) })
        }
        if (close) await close(target, lang)
      }
      await speak(base)
      await waitHung(english)
      await inv('settings:update', { appearance: { theme: 'dark' } })
      await page.mouse.move(5, 5)
    }
    // The Projects view's row of a project. Projects toggles the sidebar when its view shows already, and the board's
    // sidebar lists projects too: clicked until the Projects view shows the project (the board's has All projects).
    const toProject = async (name) => {
      const boardSide = page.locator('.sidebar .pane-body .row', { hasText: 'All projects' })
      const listed = page.locator('.sidebar').getByText(name, { exact: true }).first()
      await waitHung(async () => {
        if ((await boardSide.count()) === 0 && (await listed.isVisible().catch(() => false))) return true
        await page.getByRole('button', { name: 'Projects' }).click()
        return false
      })
      await listed.click()
    }
    const toTab = async (name) => {
      await toProject(name)
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
      await waitHung(async () => (await head.count()) === 1)
    }
    const section = async (id) => {
      await page.locator(`.git-sections [data-section="${id}"]`).click()
      return waitHung(async () => (await page.locator(`.git-sections [data-section="${id}"][aria-selected="true"]`).count()) === 1)
    }
    /** Each section of the Version Control tab shown, its view shot (both themes, English and German). */
    const shootSections = async (name, want) => {
      // Once the row has the sections the platform shows (it is read again after a switch).
      const ids = await waitHung(async () => {
        const now = await page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))
        return want.every((x) => now.includes(x)) ? now : null
      })
      check(`${name}: the Version Control sections ${want.join(', ')}`, !!ids, JSON.stringify(await page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))))
      // The sections the platform always shows: an old queue's section goes once nothing of it is in flight.
      for (const id of ids ? want : []) {
        await section(id)
        // The Merge queue once its queues are read (#1484: a shot taken before showed the section empty).
        if (id === 'queue') await waitHung(async () => (await page.locator('.git-queue').count()) === 1 && (await page.locator('[data-queue-reading]').count()) === 0)
        await shoot(`vc-${name}-${id}`, { loc: page.locator('.vc-view') })
      }
      return ids
    }

    // The board, one project's (the sidebar's row) or all.
    const board = page.locator('.board')
    const col = (id) => board.locator(`.board-column[data-column="${id}"]`)
    const inColumn = async (n, id) => (await col(id).locator(`.task-card[data-task="${n}"]`).count()) === 1
    const columns = () => board.locator('.board-column').evaluateAll((els) => els.map((e) => e.getAttribute('data-column')).join(' '))
    const labels = () => board.locator('.board-column .board-column-label').evaluateAll((els) => els.map((e) => e.textContent).join(' | '))
    // The activity bar's button toggles the sidebar when the board is shown already (boardstages').
    const showBoard = async (project) => {
      const row = page.locator('.pane-body .row', { hasText: project ?? 'All projects' }).first()
      await waitHung(async () => {
        if ((await row.count()) && (await board.count())) return true
        await page.getByRole('button', { name: 'Task Board' }).click()
        return (await row.count()) > 0 && (await board.count()) > 0
      })
      await row.click()
    }

    // The Progress panel: its tabs, a lane's row and its cards' segments, and the page's tooltip.
    const panel = page.locator('.progress-panel')
    const showTab = async (name) => {
      if (!(await panel.count())) await page.locator('.progress-rail').click()
      await waitHung(async () => (await panel.count()) === 1)
      await panel.locator(`.progress-tab[data-tab="${name}"]`).click()
      await waitHung(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1)
    }
    const laneRow = (id) => panel.locator(`.progress-lane[data-lane="${id}"]`)
    const seg = (n) => panel.locator(`.lane-seg[data-card="${n}"]`).first()
    const tips = () => page.locator('.tip')
    const tipText = async () => (await tips().allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ')
    /**
     * Hovers `target` until its tooltip shows `want` (a tooltip shows after its delay; `want` may read the tooltip's parts
     * too). A tooltip closed by the panel drawing again (the queue moving on) is hovered for again.
     */
    let hovers = 0
    const hover = async (target, want) => {
      hovers = 0
      const enter = async () => {
        hovers++
        await page.mouse.move(5, 5)
        await waitHung(async () => (await tips().count()) === 0)
        await target.hover()
      }
      await enter()
      // A tooltip that isn't the target's (the pointer ended on another part as the panel moved) is hovered for again
      // after a few seconds, as is one that closed, and a hover that showed none (#1509: the segment drawn again under
      // the pointer as it entered; no tip came in the minute after).
      let seen = false
      let other = 0
      let none = 0
      return waitHung(async () => {
        const shown = (await tips().count()) > 0
        if ((seen && !shown) || other > 25 || none > 25) {
          seen = false
          other = 0
          none = 0
          await enter()
          return false
        }
        seen = shown
        const ok = shown && (await want(await tipText()))
        if (shown && !ok) other++
        if (!shown) none++
        return ok
      })
    }
    /** What a hover check that failed had: the tip's text, how often it hovered, the target's own name. */
    const hoverSaw = async (target) => `tip: ${(await tipText()) || 'none'}; hovered ${hovers}×; target: ${(await target.getAttribute('aria-label').catch(() => null)) ?? 'not found'}`
    const laneNow = async (id) => (await inv('lanes:list')).find((l) => l.id === id)
    const integrated = async (n) => (await factsOf(n, 'Integrated')).at(-1)
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(fx.userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    /** The step offered by a project's notice: Choose… opens its Version Control tab at it. */
    const fromNotice = async (name) => {
      check(`${name}: the notice says it was added`, !!(await waitHung(async () => (await text(notice)).startsWith(`${name} was added: how do you work?`))), await text(notice))
      await notice.getByRole('button', { name: 'Choose…' }).click()
      return !!(await waitHung(async () => (await stepEl.getAttribute('data-preset-step').catch(() => null)) === 'git' && (await page.locator('.project-header', { hasText: name }).count()) > 0))
    }
    /** The step's Choose and its question's Use <preset>. */
    const choose = async (preset) => {
      await stepEl.locator('[data-action="step-choose"]').click()
      await waitHung(async () => (await dialog.getByRole('button', { name: `Use ${preset}` }).count()) === 1)
      await dialog.getByRole('button', { name: `Use ${preset}` }).click()
      return !!(await waitHung(async () => (await stepEl.count()) === 0 && (await workflowLine()) === `Workflow: Git · ${preset}`))
    }

    // ===== alpha: added with a builder and a reviewer; Pair from the step.
    // B1 in the project folder (#1578: 1.0 adds no worktree agents): the lane started below is lent a slot, its folder `wt`.
    const b1 = await q.agent(fx, h, 'B1')
    const r1 = await q.agent(fx, h, 'Reviewer')
    let wt = null
    check('alpha: its notice opens the step at Git', await fromNotice('alpha'))
    check('…Pair suggested for a builder and a reviewer, and shown', !!(await waitHung(async () => (await stepEl.locator('[data-preset="pair"] .vc-step-tag').count()) === 1)) && (await stepEl.locator('[data-preset="pair"]').getAttribute('aria-checked')) === 'true' && (await text(stepEl.locator('.vc-step-why'))) === 'Suggested for a builder and a reviewer.', await text(stepEl))
    await shoot('1-step-pair', { loc: page.locator('.vc-view') })
    check('Choose → Use Pair: the header reads "Workflow: Git · Pair"', await choose('Pair'), await workflowLine())
    const options = projectJson(alpha).workflow?.options ?? {}
    check("…saved: Combwork merges into main, cards on slots, typecheck before review and on the merged result, the repository's identity", projectJson(alpha).workflow?.preset === 'pair' && projectJson(alpha).workflow?.presetAsked === 'chosen' && options.finish === 'combworkMerges' && options.target === 'main' && options.folder === 'slots' && JSON.stringify(options.preChecks) === '["typecheck"]' && JSON.stringify(options.mergeChecks) === '["typecheck"]' && options.identity?.email === fx.identity.email, JSON.stringify(projectJson(alpha).workflow))
    const identity = options.identity ?? fx.identity
    const git = (cwd, ...args) => lib.git(cwd, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args]).trim()
    // Pair, its Maximum agents raised to 3 as a user would (HI-2131, as HI-2091): G14's builder B2 below is alpha's third.
    await inv('workflow:setOptions', alpha, { preset: 'pair', options: { ...options, maxAgents: 3 } })

    // The board: alpha's stages.
    const laneA = []
    for (const title of ['One', 'Two']) laneA.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [c1, c2] = laneA
    await showBoard('alpha')
    check("the board shows alpha's stages: Todo, Active, Review, Approved | Merging, Done", !!(await waitHung(async () => (await columns()) === 'hold todo doing review passed merging done' && (await inColumn(c1, 'todo')))) && (await labels()) === 'On Hold | Todo | Active | Review | Approved | Merging | Done', `${await columns()}: ${await labels()}`)
    check('…Approved and Merging under one Approved heading', (await board.locator('.board-category[data-category="passed"] .board-category-head').textContent()) === 'Approved', await board.locator('.board-category[data-category="passed"]').innerHTML())
    await shoot('2-board-stages')

    // The agents' tokens: a lane started from the window restarts them, each launch with a token of its own.
    const tokens = { b1: b1.token, r1: r1.token }
    const live = async (id, project = alpha) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === id)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    /** An agent's token now: its live session's latest launch. */
    const tokenOf = async (id) => {
      const sessionId = await waitHung(async () => (await live(id))?.sessionId)
      const launch = await waitHung(() => q.launches(fx).filter((l) => l.sessionId === sessionId && l.opts['--mcp-config']).at(-1))
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    /** An agent's intent by its own token; refused as unknown after a restart, its token read again and sent again (p5lane's). */
    const intent = async (who, n, name, body = {}) => {
      let r = await send({ token: tokens[who] }, n, name, body)
      for (let tries = 0; r.status === 401 && tries < 3; tries++) {
        const was = tokens[who]
        await waitHung(async () => {
          tokens[who] = await tokenOf(who === 'b1' ? b1.id : r1.id)
          return !!tokens[who] && tokens[who] !== was
        })
        r = await send({ token: tokens[who] }, n, name, body)
      }
      return r
    }
    const retoken = async () => {
      const ok = await waitHung(async () => {
        if (!(await idle(b1.id)) || !(await idle(r1.id))) return false
        tokens.b1 = await tokenOf(b1.id)
        tokens.r1 = await tokenOf(r1.id)
        return (await intent('b1', 0, 'start')).status !== 401 && (await intent('r1', 0, 'start')).status !== 401
      })
      check('…both agents run, with their tokens', !!ok, JSON.stringify(tokens))
    }

    // The builder's shell (the fake's "shell:" step), as cw-progress runs in its session (p5lane's).
    const shells = () => {
      const file = path.join(fx.claudeHome, 'fake-shell.jsonl')
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    }
    const shell = async (cmd) => {
      const before = shells().length
      // Combwork may type a wake into B1 as the suite types: each try waits for B1 idle with its inbox quiet (HI-1918), and
      // typeLine types it again when the wake took or wiped it.
      await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), fx.claudeHome, 'B1', `shell: ${cmd}`, { ready: async () => lib.agentQuiet(PORT, 'alpha', await live(b1.id), tokens.b1), strict: true, live: () => live(b1.id), hungMs: HUNG_MS })
      await waitHung(() => shells().length > before)
      await waitHung(() => idle(b1.id))
      if (!shells().slice(before).some((s) => s.cmd === cmd)) throw new Error(`B1 didn't run "${cmd}" (its line wasn't taken)`)
    }
    const counted = (x) => x.kind === 'CheckRan' && x.data?.counted === true
    /** The quick check through cw-progress on the card's revision now (passing): a new counted CheckRan on it. */
    const quickCheck = async (n) => {
      q.steer(fx, 'pass')
      const before = (await h.facts(n)).filter(counted).length
      await shell(`cw-progress --check typecheck --card ${await keyOf(n)}`)
      return !!(await waitHung(async () => (await h.facts(n)).filter(counted).length > before))
    }
    const commit = (file) => {
      fs.writeFileSync(path.join(wt, file), `${file}\n`)
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', file)
      return git(wt, 'rev-parse', 'HEAD')
    }

    /** A lane started from the board: the Todo column's Start Lane with These Cards…, B1 / Reviewer. */
    const startLane = async (cards) => {
      await showBoard('alpha')
      await waitHung(async () => (await col('todo').locator('.task-card').count()) === cards.length)
      await col('todo').locator('.board-column-header').click({ button: 'right' })
      const item = page.locator('.menu[role="menu"] .menu-item', { hasText: 'Start Lane with These Cards…' })
      await waitHung(async () => (await item.count()) === 1)
      await item.click()
      const d = page.locator('.dialog', { hasText: 'Start Lane' })
      await waitHung(async () => (await d.count()) === 1)
      await d.locator('#lane-start-builder').selectOption(b1.id)
      await d.locator('#lane-start-reviewer').selectOption(r1.id)
      await d.getByRole('button', { name: /^(Start Lane|Wait and Start)$/ }).click()
      return waitHung(async () => (await inv('lanes:list')).find((l) => l.builder.id === b1.id && l.state !== 'ended' && JSON.stringify(l.cards.map((x) => x.number)) === JSON.stringify(cards)))
    }
    const a = await startLane(laneA)
    check('a lane is started from the window: B1 / Reviewer, One and Two', !!a, JSON.stringify(await inv('lanes:list')))
    const lentSlot = await waitHung(async () => (await inv('lanes:list')).find((l) => l.id === a?.id)?.slot)
    wt = lentSlot ? path.join(`${fx.ws}.worktrees`, 'alpha', lentSlot) : null
    check('…lent a slot', !!wt, JSON.stringify(await inv('lanes:list')))
    // B1 is started again in the lane's slot (a new conversation, a launch with its own token, read by retoken).
    check("…B1 runs in the lane's slot", !!(await waitHung(async () => (await idle(b1.id)) && (await live(b1.id))?.cwd?.toLowerCase() === wt?.toLowerCase())), JSON.stringify(await live(b1.id)))
    await retoken()
    /** Combwork has made the card's line in the lane's slot (the start names the folder and the line). */
    const onLine = (s) => waitHung(() => s.body?.data?.folder?.toLowerCase() === wt?.toLowerCase() && git(wt, 'branch', '--show-current') === s.body?.data?.line)

    // --- One: start, a counted check, submit.
    const s1 = await intent('b1', c1, 'start')
    const line = s1.body?.data?.line
    check("One starts in the lane's slot, on its line", s1.status === 200 && !!line && !!(await onLine(s1)), JSON.stringify(s1.body))
    const rev1 = commit('one.txt')
    check("One's quick check through cw-progress --check is counted", await quickCheck(c1))
    const sub1 = await intent('b1', c1, 'submit', { summary: 'one ready' })
    check('One submitted: Review', sub1.status === 200 && (await card(c1)).column === 'review', JSON.stringify(sub1.body))
    const k1 = await keyOf(c1)

    // Branches & remotes: the card beside its branch, with the revision under review.
    await toTab('alpha')
    await section('branches')
    const chip = page.locator(`.git-branch[data-branch="${line}"] [data-branch-card="${c1}"]`)
    check('Branches & remotes: One beside its branch, Review, the revision under review', !!(await waitHung(async () => (await chip.getAttribute('data-stage').catch(() => null)) === 'review' && (await chip.locator('[data-under-review]').getAttribute('data-under-review').catch(() => null)) === rev1)) && (await text(chip)).includes(k1) && (await text(chip)).includes(`under review: ${rev1.slice(0, 7)}`), await text(chip))
    await shoot('3-branches-review', { loc: page.locator('.vc-view') })

    // The Progress panel: the segment's hover says Review.
    await page.getByRole('button', { name: 'Task Board' }).click()
    await showTab('pulse')
    check("Pulse: One's segment says Review, in its accessible name and hover", !!(await waitHung(async () => /· Review/.test((await seg(c1).getAttribute('aria-label').catch(() => '')) ?? ''))) && !!(await hover(seg(c1), (t) => t.includes('Review') && t.includes('One'))), await tipText())

    // G14's card and its builder, ready before the merge is held.
    const b2 = await q.agent(fx, h, 'B2')
    const dep = (await inv('tasks:create', { title: 'Needs One', project: 'alpha' })).number
    await inv('tasks:update', dep, { blockedBy: [c1] })

    // --- Review and pass; the queue tests the merge: Merging.
    await intent('r1', c1, 'start-review')
    // Held while the window is shot in two themes and two languages: minutes on a loaded machine.
    q.steer(fx, 'wait', undefined, 10 * 60000)
    const pass1 = await intent('r1', c1, 'verdict', { pass: true, comment: 'one: PASSED' })
    check('the reviewer passes One', pass1.status === 200, JSON.stringify(pass1.body))
    check("the queue tests One's merge (its check is running)", !!(await waitHung(() => fs.existsSync(fx.started))))
    await showBoard('alpha')
    check('the board: One in Merging', !!(await waitHung(() => inColumn(c1, 'merging'))), await columns())
    // G14 (S12): a card blocked by One, approved and not merged yet, can't start.
    const early = await send(b2, dep, 'start')
    check('G14 (S12): a card blocked by One, approved and unmerged, is refused its start', early.status === 409 && early.body?.rule === 'start.dependenciesIntegrated', JSON.stringify(early.body))
    await showTab('pulse')
    const mergingHover = () => hover(seg(c1), async (t) => t.includes('Merging') && t.includes('Approved') && (await page.locator('.tip .lane-seg-stage.own').innerText().catch(() => '')) === 'Merging' && (await page.locator('.tip .lane-stage-divider').count()) === 1)
    check("Pulse: One's hover says Approved | Merging, its own (Merging) marked", !!(await mergingHover()), await hoverSaw(seg(c1)))
    await shoot('4-pulse-merging', { show: () => hover(seg(c1), (t) => t.length > 0 && !!t.match(/One/)) })
    // The legend on the Lanes bar's hover.
    const bar = panel.locator('.progress-lanes-bar')
    const legendRow = (c) => page.locator(`.tip .lanes-legend-row[data-category="${c}"]`)
    check('the legend: Approved with Approved and Merging', !!(await hover(bar, async (t) => t.includes('Each colour is a category') && JSON.stringify(await legendRow('passed').locator('.lanes-legend-stage').allInnerTexts()) === '["Approved","Merging"]')), await tipText())
    await shoot('5-legend', { show: () => hover(bar, () => true).then(() => waitHung(async () => (await page.locator('.tip .lanes-legend').count()) === 1)) })

    // --- Merged: Done; the branch's card says merged.
    fs.writeFileSync(fx.go, 'go')
    check('One is merged by the queue: Done', await done(c1), JSON.stringify(await kinds(c1)))
    const i1 = await integrated(c1)
    check("…Integrated by Combwork at the approved revision: a merge commit of B1's line", i1?.data?.by === 'combwork' && git(alpha, 'rev-parse', 'main^2') === rev1, JSON.stringify(i1))
    await toTab('alpha')
    await section('branches')
    const later = await send(b2, dep, 'start')
    check('…and starts once One is merged', later.status === 200, JSON.stringify(later.body))
    check("Branches & remotes: One's branch says merged, with the merge's revision",!!(await waitHung(async () => (await chip.getAttribute('data-stage').catch(() => null)) === 'done' && (await chip.locator('[data-merged]').getAttribute('data-merged').catch(() => null)) === i1?.data?.result)), await text(chip))

    // ===== S19: the options changed mid-lane, in the tab.
    const s2 = await intent('b1', c2, 'start')
    check("Two starts once One is Done, on its own line in the lane's slot", s2.status === 200 && s2.body?.data?.line !== line && !!(await onLine(s2)), JSON.stringify(s2.body))
    await section('workflow')
    const form = page.locator('.workflow-form')
    const row = (option) => form.locator(`.workflow-option[data-option="${option}"]`)
    await waitHung(async () => (await row('style').count()) === 1)
    await row('style').locator('select').selectOption('squash')
    await form.locator('[data-action="save"]').click()
    const save = page.locator('.dialog', { hasText: 'Save Workflow Options' })
    await save.waitFor({ timeout: HUNG_MS })
    check("the save's warning: squash from the next card, and the running lane keeping the old rules", !!(await waitHung(async () => /keeps the old rules/.test(await text(save)) && /apply from the next card/.test(await text(save)))), await text(save))
    // Cancelled, then opened in each language for its shots (#1489), and again in English to save.
    const saveDialog = page.locator('.dialog', { has: page.locator('.workflow-save') })
    const cancelSave = async (d, lang) => {
      await d.getByRole('button', { name: lang === 'de' ? german['shell.dialog.cancel'] : 'Cancel', exact: true }).click()
      await d.waitFor({ state: 'detached', timeout: HUNG_MS })
    }
    const openSave = async () => {
      await form.locator('[data-action="save"]').click()
      await saveDialog.waitFor({ timeout: HUNG_MS })
      return saveDialog
    }
    await cancelSave(save, 'en')
    await shoot('6-save-old-rules', {
      open: async () => {
        const d = await openSave()
        // In German, its text is German throughout, not only the dialog's own Cancel.
        if (!(await english())) {
          const words = [german['workflow.form.confirmTitle'], german['workflow.form.confirmMessage'], german['workflow.form.changesHead']]
          check("de: the save's dialog is German: its title, message and what changes", !!(await waitHung(async () => { const x = await text(d); return words.every((t) => x.includes(t)) })), await text(d))
        }
        return d
      },
      close: cancelSave
    })
    await openSave()
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('saved: squash', !!(await waitHung(() => projectJson(alpha).workflow?.options?.style === 'squash')), JSON.stringify(projectJson(alpha).workflow))
    check('the lane shows old rules, and Two with it', !!(await waitHung(async () => (await laneNow(a?.id))?.oldRules === true && (await inv('tasks:workBadges')).find((b) => b.card === c2)?.oldRules === true)), JSON.stringify(await laneNow(a?.id)))
    await page.getByRole('button', { name: 'Task Board' }).click()
    await showTab('pulse')
    const tag = laneRow(a?.id).locator('.progress-lane-state.old-rules')
    check("Pulse: the lane's old rules mark, its hover saying what it means", !!(await waitHung(async () => (await tag.count()) === 1)) && !!(await hover(tag, (t) => t.includes('New lanes and cards use the new options'))), await tipText())
    await shoot('7-old-rules', { show: () => hover(tag, (t) => t.length > 0) })
    // G12 (S15): Two committed with a personal email first: its submit is refused with the amend command.
    fs.writeFileSync(path.join(wt, 'two.txt'), 'two.txt\n')
    git(wt, 'add', '-A')
    lib.git(wt, ['-c', 'user.name=Someone', '-c', 'user.email=someone@gmail.com', 'commit', '-qm', 'two.txt'])
    check("Two's quick check is counted (on the personal-email commit)", await quickCheck(c2))
    const personal = await intent('b1', c2, 'submit', { summary: 'two ready' })
    check("G12 (S15): a commit not by the project's identity refuses submit, with the amend command", personal.status === 409 && personal.body?.rule === 'submit.identity' && /git commit --amend --no-edit --reset-author/.test(personal.body?.next ?? ''), JSON.stringify(personal.body))
    git(wt, 'commit', '--amend', '--no-edit', '--reset-author')
    // Two finishes under the lane's rules: merged with a merge commit, not squashed.
    const rev2 = git(wt, 'rev-parse', 'HEAD')
    check("Two's quick check is counted (amended)", await quickCheck(c2))
    const sub2 = await intent('b1', c2, 'submit', { summary: 'two ready' })
    check('Two submitted', sub2.status === 200, JSON.stringify(sub2.body))
    await intent('r1', c2, 'start-review')
    q.steer(fx, 'pass')
    const pass2 = await intent('r1', c2, 'verdict', { pass: true, comment: 'two: PASSED' })
    check('the reviewer passes Two', pass2.status === 200, JSON.stringify(pass2.body))
    check("Two merged under the lane's rules: a merge commit of its revision (not squashed)", (await done(c2)) && git(alpha, 'rev-parse', 'main^2') === rev2, JSON.stringify(await kinds(c2)))
    const ended = await waitHung(async () => {
      const l = await laneNow(a?.id)
      return l?.state === 'ended' && l.mergeCommit === (await integrated(c2))?.data?.result ? l : null
    })
    check("the lane ends verified: its merge commit Two's result; its mark goes", !!ended && ended.oldRules === false, JSON.stringify(await laneNow(a?.id)))
    await toTab('alpha')
    await shootSections('git-pair', ['workflow', 'changes', 'history', 'branches', 'queue'])

    // ===== beta: added with one agent; Solo; S44 through the tab.
    lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
    await inv('workspace:refresh')
    let s = await q.agent(fx, h, 'S1', { project: beta })
    check('beta: its notice opens the step at Git', await fromNotice('beta'))
    check('…Solo suggested for one agent', !!(await waitHung(async () => (await stepEl.locator('[data-preset="solo"] .vc-step-tag').count()) === 1)) && (await text(stepEl.locator('.vc-step-why'))) === 'Suggested for one agent or none.', await text(stepEl))
    check('Choose → Use Solo: "Workflow: Git · Solo"', await choose('Solo'), await workflowLine())
    const solo = projectJson(beta).workflow?.options ?? {}
    check('…saved: no review, Committed is done, the project folder', solo.review === 'none' && solo.finish === 'committed' && solo.folder === 'project', JSON.stringify(solo))
    check("beta's stages: On Hold, Todo, Active and Done", (await inv('workflow:stages', beta))?.stages.map((x) => x.id).join(' ') === 'hold todo active done', JSON.stringify(await inv('workflow:stages', beta)))
    const sc = (await inv('tasks:create', { title: 'Solo work', project: 'beta' })).number
    // A loop of its one card (registered as the card-loop skill does): Pulse shows it while it runs.
    const sl = await api('POST', '/v1/lanes', { project: 'beta', builder: 'S1', reviewer: null, name: 'solo', cards: [sc] })
    check("beta's lane is registered", sl.status === 200, JSON.stringify(sl))
    // S1 is idle in the project folder, so the lane gives it a new conversation (HI-2232), now or once it is free: its
    // calls then carry the new run's token (the one read at its start is refused).
    check('…S1 given the lane in a new conversation', /Gave S1 the lane in a new conversation|S1 wasn't free/.test(JSON.stringify(sl.body)), JSON.stringify(sl.body))
    s = await q.renewed(fx, h, s, beta)
    check("…S1's new run has its own token", !!s.token)
    const soloLane = sl.body?.lane?.id
    await page.getByRole('button', { name: 'Task Board' }).click()
    await showTab('pulse')
    check('Pulse shows the Solo lane while it runs', !!(await waitHung(async () => (await laneRow(soloLane).count()) === 1)), await text(panel))
    const ss = await send(s, sc, 'start')
    check('S44: Solo work starts in the project folder', ss.status === 200 && ss.body?.data?.folder?.toLowerCase() === beta.toLowerCase(), JSON.stringify(ss.body))
    fs.writeFileSync(path.join(beta, 's.txt'), 's\n')
    lib.git(beta, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', 's.txt'])
    lib.git(beta, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', 'solo work, no trailer'])
    const ssub = await send(s, sc, 'submit', { summary: 'done' })
    const soloIn = await waitHung(async () => (await factsOf(sc, 'Integrated')).at(-1))
    check('…committed with no trailer and submitted: Done, committed is done', ssub.status === 200 && (await done(sc)) && soloIn?.data?.method === 'committed', JSON.stringify({ body: ssub.body, i: soloIn }))
    check('…its ended lane left out of Pulse: no lanes section for Solo', !!(await waitHung(async () => (await laneNow(soloLane))?.state === 'ended' && (await laneRow(soloLane).count()) === 0)), JSON.stringify(await laneNow(soloLane)))
    await showTab('lanes')
    check('…the Lanes tab keeps it', !!(await waitHung(async () => (await laneRow(soloLane).count()) === 1)))
    await showTab('pulse')

    // ===== gamma: all off in the tab, G16 on, two agents in the project folder (S11, S39).
    lib.gitProject(gamma, { 'g.txt': 'g\n', '.gitignore': '.combwork/\n' })
    await inv('workspace:refresh')
    const g1 = await q.agent(fx, h, 'G1', { project: gamma })
    const g2 = await q.agent(fx, h, 'G2', { project: gamma })
    check('gamma: its notice opens the step at Git', await fromNotice('gamma'))
    await section('workflow')
    const choice = (id) => form.locator(`.workflow-choice[data-choice="${id}"]`)
    await waitHung(async () => (await choice('allOff').count()) === 1)
    await choice('allOff').click()
    await form.locator('.workflow-preview [data-action="use-choice"]').click()
    await waitHung(async () => (await row('sharedFolderWarning').count()) === 1 && (await row('review').locator('select').inputValue()) === 'none')
    const g16 = row('sharedFolderWarning').locator('[role="switch"], input[type="checkbox"]').first()
    await g16.click()
    await form.locator('[data-action="save"]').click()
    await save.waitFor({ timeout: HUNG_MS })
    await save.getByRole('button', { name: 'Save', exact: true }).click()
    await save.waitFor({ state: 'detached', timeout: HUNG_MS })
    const off = await waitHung(() => (projectJson(gamma).workflow?.options?.sharedFolderWarning === true ? projectJson(gamma).workflow : null))
    check('all off saved in the tab, G16 on: no review, not checked, the project folder, no preset', !!off && off.preset === null && off.options.review === 'none' && off.options.finish === 'notChecked' && off.options.folder === 'project', JSON.stringify(projectJson(gamma).workflow))
    // Gone once the window has the saved options (read once just after the save, it raced it: #1489's run).
    check('…the step answered: gone', !!(await waitHung(async () => (await stepEl.count()) === 0)))
    await shootSections('git-alloff', ['workflow', 'changes', 'history', 'branches'])
    const gc1 = (await inv('tasks:create', { title: 'Gamma one', project: 'gamma' })).number
    const gc2 = (await inv('tasks:create', { title: 'Gamma two', project: 'gamma' })).number
    await inv('tasks:update', gc2, { blocked: 'waiting for a reply' })
    const gk1 = await keyOf(gc1)
    const gk2 = await keyOf(gc2)
    const gs1 = await send(g1, gc1, 'start')
    const gs2 = await send(g2, gc2, 'start')
    check('S39: G1 starts one; G2 starts two, blocked, with a warning, nothing refused', gs1.status === 200 && gs2.status === 200 && (gs2.body?.warnings ?? []).some((w) => w.includes(gk2) && w.includes('blocked')), JSON.stringify({ gs1: gs1.body, gs2: gs2.body }))
    // Both commit in the project folder, each with its card's trailer (S11).
    const gcommit = (file, key) => {
      fs.writeFileSync(path.join(gamma, file), `${file}\n`)
      lib.git(gamma, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', file])
      lib.git(gamma, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', file, '-m', `Combwork-Card: ${key}`])
    }
    gcommit('one.txt', gk1)
    gcommit('two.txt', gk2)
    // Once Combwork has read the folder's new commits (each attributed to its card by its trailer), as S11's core does before
    // its submits: a submit while they are read is refused to try again (evidence.changed).
    check("S11: each card's commit attributed to it by its trailer", !!(await waitHung(async () => (await kinds(gc1)).includes('CommitAttributed') && (await kinds(gc2)).includes('CommitAttributed'))), JSON.stringify({ one: await kinds(gc1), two: await kinds(gc2) }))
    const gsub2 = await send(g2, gc2, 'submit', { summary: 'two' })
    const gsub1 = await send(g1, gc1, 'submit', { summary: 'one' })
    check('S11: both submit in the shared folder: Done, nothing checked', gsub1.status === 200 && gsub2.status === 200 && (await done(gc1)) && (await done(gc2)), JSON.stringify({ gsub1: gsub1.body, gsub2: gsub2.body }))
    check("…two's submission is its own commit only",((await factsOf(gc2, 'Submitted')).at(-1)?.data?.files ?? []).map((x) => x.path).join() === 'two.txt', JSON.stringify((await factsOf(gc2, 'Submitted')).at(-1)?.data))
    // G16 (#1481): G1 edits three.txt on its next card (its CLI's edit hook takes Combwork's file lock); G2's commit sweeps it
    // in: G2's submit warns, naming G1's card, and goes through.
    const gc3 = (await inv('tasks:create', { title: 'Gamma three', project: 'gamma' })).number
    const gc4 = (await inv('tasks:create', { title: 'Gamma four', project: 'gamma' })).number
    const gk3 = await keyOf(gc3)
    const gk4 = await keyOf(gc4)
    check('G1 starts three, G2 four', (await send(g1, gc3, 'start')).status === 200 && (await send(g2, gc4, 'start')).status === 200)
    const g1live = (await inv('session:live')).find((l) => l.projectPath.toLowerCase() === gamma.toLowerCase() && l.agentId === g1.id)
    const g1hook = lib.launchHook(fx.userData, g1live.runId)
    const edit = await fetch(g1hook.url, { method: 'POST', headers: { Authorization: `Bearer ${g1hook.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: g1live.sessionId, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(gamma, 'three.txt') }, cwd: gamma }) })
    check("G16: G1's edit of three.txt takes the lock, recorded on its card", edit.status === 200 && !!(await waitHung(async () => (await factsOf(gc3, 'FilesLocked')).some((f) => f.data.paths.includes('three.txt')))), JSON.stringify(await factsOf(gc3, 'FilesLocked')))
    fs.writeFileSync(path.join(gamma, 'three.txt'), 'three, by G2\n')
    lib.git(gamma, ['add', 'three.txt'])
    gcommit('four.txt', gk4)
    check("…G2's commit attributed to four", !!(await waitHung(async () => (await kinds(gc4)).includes('CommitAttributed'))), JSON.stringify(await kinds(gc4)))
    const gsub4 = await send(g2, gc4, 'submit', { summary: 'four' })
    const g16warning = `three.txt is ${g1.id}'s (${gk3})`
    check("G16: G2's submit including G1's file warns, naming G1's card; nothing refused", gsub4.status === 200 && (gsub4.body?.warnings ?? []).includes(g16warning) && (await done(gc4)), JSON.stringify(gsub4.body))
    // The user moves a card back and forth: nothing asks, nothing is refused.
    await showBoard('gamma')
    check("gamma's board: On Hold, Todo, Active and Done", !!(await waitHung(async () => (await columns()) === 'hold todo doing done')), await columns())
    await inv('tasks:move', gc1, 'todo')
    await inv('tasks:move', gc1, 'done')
    check('the user moves a card from Done to Todo and back freely: no question, no refusal, no override', !!(await waitHung(() => inColumn(gc1, 'done'))) && (await dialog.count()) === 0 && !(await kinds(gc1)).some((k) => k === 'Refused' || k === 'Override'), JSON.stringify(await kinds(gc1)))
    await shoot('8-board-alloff')

    // ===== S20 on alpha: the repository gone, None offered and switched to.
    // Again while something holds it a moment (a watcher, the scanner: EPERM under load).
    check('alpha: .git moved away', !!(await waitHung(() => {
      try {
        fs.renameSync(path.join(alpha, '.git'), path.join(alpha, 'git-away'))
        return true
      } catch {
        return false
      }
    })))
    await inv('workspace:refresh')
    await toTab('alpha')
    check('S20: the offer: the repository gone, Switch to None…', !!(await waitHung(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'repositoryGone')) && (await text(offer)).startsWith('The Git repository is gone.'), await text(offer))
    await shoot('9-offer-gone', { loc: page.locator('.vc-view') })
    await offer.locator('[data-action="vc-offer-switch"]').click()
    const sw = page.locator('.dialog').filter({ has: page.locator('[data-vc-switch]') })
    await waitHung(async () => (await sw.count()) === 1)
    await sw.getByRole('button', { name: 'Switch', exact: true }).click()
    check('switched: alpha uses None, the offer gone', !!(await waitHung(async () => (await sw.count()) === 0 && (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1 && (await offer.count()) === 0)))
    const nc = (await inv('tasks:create', { title: 'Under None', project: 'alpha' })).number
    const ns = await intent('r1', nc, 'start')
    const nStarted = (await factsOf(nc, 'Started')).at(-1)?.data
    check("a new card starts under None's rules (a manifest, no line)", ns.status === 200 && !!nStarted?.manifest && !nStarted?.line, JSON.stringify({ ns: ns.body, nStarted }))
    await shootSections('none', ['workflow'])
    // The old Git queue's section (#1356's rule) with the repository gone (#1484): never empty.
    const queueTab = page.locator('.git-sections [data-section="queue"]')
    check('None, a Git card still in flight: the Merge queue section stays', (await queueTab.count()) === 1, JSON.stringify(await page.locator('.git-sections [data-section]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))))
    if ((await queueTab.count()) === 1) {
      if (q.devSeam('the Merge queue section read slowly (CW_TEST_SLOW_IPC)')) {
        // Read slowly (as under load): the section says it's reading, never nothing.
        await app.evaluate(() => { process.env.CW_TEST_SLOW_IPC = 'queue:list=3000' })
        await section('workflow')
        await section('queue')
        const reading = page.locator('.git-body [data-queue-reading]')
        check('the Merge queue section, while its queues are read, says so', !!(await waitHung(async () => (await reading.count()) === 1 && (await text(reading)) === 'Reading the merge queues…')), (await page.locator('.git-body').innerHTML().catch(() => '')).slice(0, 600))
        await page.locator('.vc-view').screenshot({ path: path.join(fx.shots, 'p6lane-vc-none-queue-reading-en-dark.png') })
        await app.evaluate(() => { delete process.env.CW_TEST_SLOW_IPC })
      }
      // Then the old queue as the board has it, with its history: the repository gone takes none of it away.
      const body = page.locator('.git-body')
      check('None, the repository gone: the Merge queue section shows the queue and its history', !!(await waitHung(async () => (await body.locator('.git-queue-target[data-target="main"]').count()) === 1 && (await body.locator('.git-queue-table [data-outcome="merged"]').count()) >= 2)), JSON.stringify({ html: (await body.innerHTML().catch(() => '')).slice(0, 600) }))
      await shootSections('none-queue', ['queue'])
    }
  } catch (e) {
    check('no exception', false, e.stack)
    await page.screenshot({ path: path.join(fx.shots, 'p6lane-failure.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`screenshots: ${fx.shots}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
