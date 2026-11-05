// The board asks before a move that skips rules (#1275, SPEC §16.8.4), on a Git project whose rules are a reviewer
// agent and the agent merging: a drag to Done with no merge asks ("Move AL-1 to Done anyway?", each rule by name,
// Reason (optional), Move Anyway), and Move Anyway records the override and shows its mark with who, which rules and why
// (S16's user part); Cancel leaves the card where it was, nothing recorded; a drag to Review with nothing to submit is
// refused with the refusal's sentences and the card stays; the card dialog's Column moved part of the way says where the
// card is (HR3's #1275 round 1); Move to Active's Assign and start on a blocked card asks too, Cancel doing nothing (no
// agent started) and Move Anyway starting it with one override and its reason (round 1); in a project with every rule
// off (S39), nothing asks and a column its rules don't have (Review) takes no drop. Screenshots of the question and the
// mark in both themes, and the question in Polish. Dev build, fake Claude Code, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'boardgates-profile')
const ws = path.join(lib.WORK, 'boardgates-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const gamma = path.join(ws, 'gamma')
const claudeHome = path.join(lib.WORK, 'boardgates-claude-home')
// B1's 0.9 worktree where 0.9 kept them, `<workspace>.worktrees/<project>/<agent>`, never in the workspace folder: there
// it showed as its own project, with a "how do you work?" notice above the board that went when the slot was renamed out,
// moving the board up under a still pointer (HI-2208), or never went (HI-2212: adopted before card #1 existed, the slot
// is handed over to #1, and B1's session there keeps it from being renamed after Done).
const alphaWt = path.join(`${ws}.worktrees`, 'alpha', 'b1')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.gitProject(gamma)
  // Alpha: a reviewer agent, the agent merges, each builder in its own worktree (B1's, on its branch). Beta: every rule
  // off (S39), its agents in the project folder: two builders, since the upgrade turns review on for a reviewer, and a
  // name shaped like R1 reads as one (SPEC §16.10.6, #1430; #1501).
  const main = String(lib.git(alpha, ['branch', '--show-current'])).trim()
  lib.git(alpha, ['worktree', 'add', '-q', '-b', 'b1-work', alphaWt, main])
  const b1 = { id: 'b1', name: 'B1' }
  const r1 = { id: 'r1', name: 'R1' }
  const projects = [
    [alpha, [{ ...b1, worktree: { path: alphaWt, branch: 'b1-work', base: main } }, r1], { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', dependenciesDone: true }],
    [beta, [b1, { id: 'b2', name: 'B2' }], null],
    // Gamma: a reviewer agent, nothing checked, its agents in the project folder (HR3's card-dialog repro).
    [gamma, [b1, r1], { review: 'agent', noSelfReview: true, finish: 'notChecked', folder: 'project' }]
  ]
  for (const [dir, agents, options] of projects) {
    fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform: 'git', preset: null, options } } : {}) }))
  }
  // Alpha's cards start in its pool's slots since P7 (#1548: B1 started in slot-a, untrusted, sat on its trust screen).
  const slots = ['slot-a', 'slot-b', 'slot-c', 'slot-d'].map((s) => path.join(`${ws}.worktrees`, 'alpha', s))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, alphaWt, beta, gamma, ...slots].map((x) => x.toLowerCase())))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_TEST_TIPS: 'off', CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const facts = async (n) => (await inv('tasks:facts', n)).map((f) => f.kind)
    const create = async (title, project) => (await inv('tasks:create', { title, project })).number
    await page.getByRole('button', { name: 'Task Board' }).click()
    const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-label', { hasText: label }) })
    const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
    /** The column a card's tile shows in now (its `data-column`: Merging's cards are `passed` cards), or null. */
    const shownIn = (n) => tile(n).evaluate((e) => e.closest('.board-column')?.getAttribute('data-column') ?? null).catch(() => null)
    let dragSaid = ''
    // Dragged only once the window shows the card where it is (#1505): a tile the board hasn't moved yet (a move just
    // made through IPC) is moved into its column mid-drag, and the drop never comes.
    const drag = (n, label) => dragInto(n, column(label))
    const dragInto = async (n, into) => {
      const at = await lib.until(async () => {
        const now = (await card(n))?.column
        const shown = await shownIn(n)
        return now && (shown === now || (shown === 'merging' && now === 'passed')) ? shown : null
      }, HUNG_MS)
      dragSaid = `card #${n} in ${(await card(n))?.column}, shown in ${await shownIn(n)}${at ? '' : ' (never shown where it is)'}`
      await tile(n).dragTo(into.locator('.board-column-body'))
    }
    const dialog = page.locator('.dialog', { hasText: 'anyway?' })
    const themes = async (name, target) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await target.screenshot({ path: path.join(lib.WORK, `boardgates-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- A drag to Done with no merge asks; Move Anyway records the override, and the card shows its mark.
    const a = await create('Ship the names', 'alpha')
    await inv('tasks:move', a, 'doing', { agent: 'b1' })
    check('the card starts with its agent (Move to Active through the rules)', (await card(a))?.column === 'doing' && (await facts(a)).includes('Started'), JSON.stringify(await facts(a)))
    await drag(a, 'Done')
    check('a drag to Done with no merge asks first', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)), dragSaid)
    const asked = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('…naming the card, the column and each rule it skips by name', asked.includes(`Move ${(await card(a)).key} to Done anyway?`) && asked.includes('Reason (optional)') && /This skips \d+ rules of its project:/.test(asked) && !asked.includes('integrate.approved'), asked)
    check('…nothing recorded while it asks', !(await facts(a)).includes('Override'))
    await themes('ask', dialog)
    await dialog.locator('input').fill('Merged by hand')
    await dialog.getByRole('button', { name: 'Move Anyway' }).click()
    check('Move Anyway moves it to Done', !!(await lib.until(async () => (await card(a))?.column === 'done', HUNG_MS)))
    check('…with one Override, and no Integrated faked', (await facts(a)).filter((k) => k === 'Override').length === 1 && !(await facts(a)).includes('Integrated'), JSON.stringify(await facts(a)))
    // Nothing above the board comes or goes while the mark is hovered (HI-2208, HI-2212): B1's worktree is outside the
    // workspace folder, so no project and no notice for it.
    const notice = page.locator('[data-step-notice]')
    check('…and no notice above the board', (await notice.count()) === 0, await notice.innerText().catch(() => ''))
    const mark = tile(a).locator('[data-badge="override"]')
    check('the card shows its override mark', !!(await lib.until(async () => (await mark.count()) === 1, HUNG_MS)))
    const label = (await mark.getAttribute('aria-label')) ?? ''
    check('…its accessible name says who, which rules and why', label.startsWith('You moved it past its rules: ') && label.endsWith('Reason: Merged by hand') && !label.includes('integrate.approved'), label)
    await page.mouse.move(5, 5)
    await mark.hover()
    check('…and so does its tooltip', !!(await lib.until(async () => (await page.locator('.tip').innerText().catch(() => '')).includes('Reason: Merged by hand'), HUNG_MS)))
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      // The card and its mark's tooltip together.
      const clip = await tile(a).evaluate((el) => {
        const boxes = [el.getBoundingClientRect(), document.querySelector('.tip')?.getBoundingClientRect()].filter(Boolean)
        const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - 12)
        const y = Math.max(0, Math.min(...boxes.map((b) => b.top)) - 12)
        return { x, y, width: Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + 12) - x, height: Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + 12) - y }
      })
      await page.screenshot({ path: path.join(lib.WORK, `boardgates-mark-${theme}.png`), clip })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.mouse.move(5, 5)

    // --- Cancel leaves the card where it was, nothing recorded.
    const b = await create('Tidy the menu', 'alpha')
    await inv('tasks:move', b, 'doing', { agent: 'b1' })
    // Its start's slot work recorded first (#1548: SlotPrepared, PlacementClaimed, then BuilderPlaced, its last, come
    // after the move's reply; slotCards.ts), so what follows compares only what the drag records: the facts Combwork
    // records, not what a reconcile observes of the folder and its target meanwhile (TargetMoved, #1543).
    const recorded = async (n) => (await inv('tasks:facts', n)).filter((f) => f.source === 'recorded').map((f) => f.kind)
    await lib.until(async () => (await facts(b)).includes('BuilderPlaced'), HUNG_MS)
    const before = await recorded(b)
    await drag(b, 'Done')
    check('another drag past the rules asks', !!(await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)))
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    check('Cancel leaves the card where it was', !!(await lib.until(async () => (await dialog.count()) === 0 && (await column('Active').locator(`.task-card[data-task="${b}"]`).count()) === 1, HUNG_MS)) && (await card(b))?.column === 'doing')
    check('…with nothing recorded', JSON.stringify(await recorded(b)) === JSON.stringify(before), JSON.stringify({ before, now: await facts(b) }))

    // --- A drag to Review with nothing to submit: refused for what no override makes true, said; the card stays.
    await drag(b, 'Review')
    const refusal = page.locator('.toast', { hasText: "can't move to Review" })
    check('a drag to Review with nothing to submit is refused, saying why', !!(await lib.until(async () => (await refusal.count()) > 0, HUNG_MS)))
    const said = (await refusal.first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    // Worded for the user (HI-1851): the title names the card, once; the sentences say what and what to do.
    const bKey = (await card(b)).key
    check('…in its sentences: what, and what to do, the card named by its key', said.includes(`${bKey} can't move to Review`) && said.split(bKey).length === 2 && said.includes('Nothing is committed to review yet.') && said.includes("Commit the card's work, then move it again."), said)
    check('…and the card stays in Active', (await card(b))?.column === 'doing' && (await column('Active').locator(`.task-card[data-task="${b}"]`).count()) === 1)
    await refusal.first().screenshot({ path: path.join(lib.WORK, 'boardgates-refused-dark.png') })

    // --- The card dialog's Column moved part of the way (HR3's #1275 round 1, finding 2): Todo → Review starts the card
    // and stops at its submission (nothing to submit). The dialog says where it is now, and its Column follows.
    const p = (await inv('tasks:create', { title: 'Write the notes', project: 'gamma', agent: 'b1' })).number
    await lib.until(async () => (await tile(p).count()) === 1, HUNG_MS)
    await tile(p).click()
    const edit = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await edit.waitFor({ timeout: HUNG_MS })
    await edit.locator('select:has(option[value="review"])').selectOption('review')
    await edit.getByRole('button', { name: 'Save', exact: true }).click()
    const stoppedToast = page.locator('.toast', { hasText: 'stopped in Active' })
    check('the card dialog: a move stopped part way is said (stopped in Active)', !!(await lib.until(async () => (await stoppedToast.count()) > 0, HUNG_MS)))
    const dialogError = async () => (await edit.locator('.dialog-error').innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('…and the dialog says where the card is now, not where it was', !!(await lib.until(async () => (await dialogError()).includes('the card stays in Active'), HUNG_MS)), await dialogError())
    check('…its Column shows it, as the board has it', (await edit.locator('select:has(option[value="review"])').inputValue()) === 'doing' && (await card(p))?.column === 'doing', `${await edit.locator('select:has(option[value="review"])').inputValue()} / ${(await card(p))?.column}`)
    await edit.getByRole('button', { name: 'Cancel' }).click()
    await lib.until(async () => (await edit.count()) === 0, HUNG_MS)

    // --- Move to Active's Assign and start on a blocked card (HR3's #1275 round 1, finding 1): it asks before anything
    // is done; Cancel starts nothing, Move Anyway starts it with one override and the reason.
    const s = await create('Start the design', 'alpha')
    await inv('tasks:update', s, { blocked: 'Needs a design decision' })
    const doingDialog = page.locator('.dialog', { hasText: 'to Active' }).filter({ has: page.locator('label.choice') })
    const assignAndStart = async () => {
      await drag(s, 'Active')
      await doingDialog.waitFor({ timeout: HUNG_MS })
      await doingDialog.locator('label.choice', { hasText: 'Assign and start' }).first().click()
      await doingDialog.locator('label.choice', { has: page.locator('strong', { hasText: /^\s*B1$/ }) }).click()
      await doingDialog.locator('.dialog-footer .btn.primary').click()
    }
    // B1's sessions in alpha, each by its id: since P7 the cards above started B1 in its slot (#1548), so Cancel's "no
    // agent started" is none started by it, not none running.
    const live = async () => (await inv('session:live')).filter((x) => x.projectPath.toLowerCase() === alpha.toLowerCase() && x.agentId === 'b1').map((x) => x.runId).sort().join()
    const liveBefore = await live()
    await assignAndStart()
    const startAsk = page.locator('.dialog', { hasText: 'to Active anyway?' })
    check('Assign and start on a blocked card asks first', !!(await lib.until(async () => (await startAsk.count()) === 1, HUNG_MS)))
    const startAsked = (await startAsk.innerText().catch(() => '')).replace(/\s+/g, ' ')
    // Among what it skips (since P7 also "Each card in its own folder": B1 already holds slot-a with the cards above).
    check('…naming the rule it skips by its name', /This skips (a rule|\d+ rules) of its project:/.test(startAsked) && startAsked.includes("Blocked cards don't start") && !startAsked.includes('start.notBlocked'), startAsked)
    await startAsk.screenshot({ path: path.join(lib.WORK, 'boardgates-start-ask-dark.png') })
    await startAsk.getByRole('button', { name: 'Cancel' }).click()
    await lib.until(async () => (await startAsk.count()) === 0, HUNG_MS)
    await lib.sleep(1500) // A fixed wait on purpose: this checks that nothing starts after Cancel.
    check('Cancel: nothing done, no agent started', (await card(s))?.column === 'todo' && !(await facts(s)).includes('Started') && !(await facts(s)).includes('Override') && (await live()) === liveBefore, JSON.stringify({ column: (await card(s))?.column, facts: await facts(s), live: await live(), liveBefore }))
    // The Move to Active dialog may still be open behind it (the start didn't happen): close it.
    if (await doingDialog.count()) await doingDialog.getByRole('button', { name: 'Cancel' }).click()
    await lib.until(async () => (await doingDialog.count()) === 0, HUNG_MS)
    await assignAndStart()
    await lib.until(async () => (await startAsk.count()) === 1, HUNG_MS)
    await startAsk.locator('input').fill('Decided in the call')
    await startAsk.getByRole('button', { name: 'Move Anyway' }).click()
    check('Move Anyway starts it, in Doing with B1', !!(await lib.until(async () => (await card(s))?.column === 'doing' && (await card(s))?.agent === 'b1', HUNG_MS)), JSON.stringify(await card(s)))
    const sFacts = await inv('tasks:facts', s)
    check('…with one override, its reason, and its start', sFacts.filter((f) => f.kind === 'Override').length === 1 && sFacts.find((f) => f.kind === 'Override')?.data.reason === 'Decided in the call' && sFacts.some((f) => f.kind === 'Started'), JSON.stringify(sFacts.map((f) => [f.kind, f.data?.reason])))
    check('…and the agent starts with it', !!(await lib.until(live, HUNG_MS)))

    // --- Every rule off (S39): nothing asks; a column its rules don't have (Review) takes no drop.
    const c = await create('Read the docs', 'beta')
    await drag(c, 'Review')
    await lib.sleep(1500) // A fixed wait on purpose: this checks that nothing happens (no drop, no question).
    check("a column the card's rules don't have takes no drop", (await card(c))?.column === 'todo' && (await dialog.count()) === 0, (await card(c))?.column)
    check('…which tasks:columns says', JSON.stringify(await inv('tasks:columns', c)) === JSON.stringify(['hold', 'todo', 'doing', 'done']), JSON.stringify(await inv('tasks:columns', c)))
    await drag(c, 'Done')
    check('all off: a drag to Done just moves, nothing asked or overridden', !!(await lib.until(async () => (await card(c))?.column === 'done', HUNG_MS)) && (await dialog.count()) === 0 && !(await facts(c)).includes('Override'), JSON.stringify(await facts(c)))

    // --- The question in Polish (as main sends a change of language, with Polish's own catalogue).
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'pl')
    const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    await speak({ ...base, code: 'pl', locale: 'pl', messages })
    const plDialog = page.locator('.dialog', { hasText: 'mimo to?' })
    const plDone = page.locator('.board-column', { has: page.locator('.board-column-label', { hasText: 'Gotowe' }) })
    await lib.until(async () => (await plDone.count()) === 1, HUNG_MS)
    await dragInto(b, plDone)
    check('the question in Polish', !!(await lib.until(async () => (await plDialog.count()) === 1, HUNG_MS)), await page.locator('.dialog').innerText().catch(() => ''))
    await plDialog.screenshot({ path: path.join(lib.WORK, 'boardgates-ask-pl.png') })
    await plDialog.getByRole('button', { name: 'Anuluj' }).click().catch(() => page.keyboard.press('Escape'))
    await speak(base)
  } catch (e) {
    check('the suite ran to the end', false, e.stack ?? String(e))
    await app
      .firstWindow()
      .then((p) => p.screenshot({ path: path.join(lib.WORK, 'boardgates-failed.png') }))
      .catch(() => undefined)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
