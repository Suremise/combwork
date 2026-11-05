// Switching a project's version control (#1419, SPEC §16.3.5, §16.6.5, S20, OP-29), the Assistant off, fake Claude Code
// agents acting by their own tokens:
// - alpha (queueFixture's "Combwork merges" into `integration`): one card testing and one queued when its queue is paused,
//   then switched to None (the warning lists both cards in flight and that the folder is still a Git repository; no
//   switch back is offered afterwards). The Merge queue section stays, reached from the Progress panel's queue card;
//   the queued card is removed there, a new card starts under None's rules meanwhile, and the testing one merges once
//   the queue is resumed; then the section goes.
// - gamma (Git, its own options): `.git` moved away. The offer and the notice (Open Version Control), a card's start
//   refused with the switch as its next step; Switch to None…'s warning lists a running lane and a card in flight; after
//   it, the card in flight keeps its stage and Git's rules and a new card starts under None's. Then Initialise
//   repository… from Git's page (HI-1905): the switch that follows warns of the lane and the card in flight, and is
//   cancelled; Git is offered, switched to, its kept options back, and the next card starts under Git's rules.
// - delta (Git): Mercurial found. The offer, Switch to None…, a new card under None; Git then refused with the reason.
// - a stale switch (the dialog open while another switch is made) is refused.
// - a project inside a larger repository (another workspace): the whole-repository line, and OP-29's refusal.
// Screenshots of each offer and the warning, both themes, English and German. Dev build, throwaway profile, workspaces
// and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47857))
const fx = q.queueProject('vcswitch')
const HUNG_MS = 60000
const gamma = path.join(fx.ws, 'gamma')
const delta = path.join(fx.ws, 'delta')
const outer = path.join(lib.WORK, 'vcswitch-outer')
const inner = path.join(outer, 'app')
/** gamma's own Git options: reviewed by an agent, committed in the project folder. */
const GAMMA = { review: 'agent', noSelfReview: true, finish: 'committed', folder: 'project', okBefore: { mode: 'never', labels: [] } }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** A project's .combwork/project.json, as Combwork keeps it. */
function writeProject(dir, cfg) {
  fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], ...cfg }))
}

;(async () => {
  q.prepare(fx)
  lib.gitProject(gamma, { 'g.txt': 'g\n', '.gitignore': '.combwork/\n' })
  writeProject(gamma, { platform: 'git', workflow: { platform: 'git', preset: null, options: GAMMA } })
  lib.gitProject(delta, { 'd.txt': 'd\n', '.gitignore': '.combwork/\n' })
  writeProject(delta, { platform: 'git', workflow: { platform: 'git', preset: null, options: {} } })
  fs.rmSync(outer, { recursive: true, force: true })
  fs.mkdirSync(inner, { recursive: true })
  fs.writeFileSync(path.join(inner, 'index.js'), 'module.exports = 1\n')
  lib.gitProject(outer, { 'README.md': '# Outer\n' })

  const h = await q.startCombwork(fx, { port: PORT })
  const { page, inv, app } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    const text = async (loc) => ((await loc.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
    const head = page.locator('[data-vc-head]')
    const offer = page.locator('[data-vc-offer]')
    const dialog = page.locator('.dialog').filter({ has: page.locator('[data-vc-switch]') })
    const sections = () => page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))
    const selected = () => page.locator('.git-sections [aria-selected="true"]').getAttribute('data-section').catch(() => null)
    const column = async (n) => (await h.card(n))?.column
    const started = async (n) => (await h.facts(n)).filter((f) => f.kind === 'Started').at(-1)?.data
    /** Under which platform's rules a card started: Git records its line, None its manifest. */
    const startedUnder = async (n) => {
      const d = await started(n)
      return !d ? null : d.line ? 'git' : d.manifest ? 'none' : '?'
    }
    const toTab = async (name) => {
      // Projects toggles the sidebar when its view shows already: clicked only while the project isn't listed.
      if (!(await page.getByText(name, { exact: true }).first().isVisible().catch(() => false))) await page.getByRole('button', { name: 'Projects' }).click()
      await page.getByText(name, { exact: true }).first().click()
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
      await until(async () => (await head.count()) === 1, HUNG_MS)
    }
    const shoot = async (loc, name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await loc.screenshot({ path: path.join(fx.shots, `vcswitch-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'de')
    const german = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'language-changed', language })
    const confirmSwitch = async () => {
      await dialog.getByRole('button', { name: 'Switch', exact: true }).click()
      return !!(await until(async () => (await dialog.count()) === 0, HUNG_MS))
    }

    // --- alpha: a Git queue going on when it is switched to None.
    const reviewer = await q.agent(fx, h, 'R1')
    q.steer(fx, 'wait')
    const t = await q.approve(fx, h, reviewer, 'Testing', { 't.txt': 't\n' })
    check('alpha: Testing is in its merge checks', !!(await until(() => fs.existsSync(fx.started), HUNG_MS)), JSON.stringify(t.steps))
    const p = await q.approve(fx, h, reviewer, 'Queued', { 'p.txt': 'p\n' })
    const view = async () => (await inv('queue:list', fx.alpha, 'integration'))[0]
    check('…and Queued waits behind it', !!(await until(async () => (await view())?.queued.some((x) => x.card === p.n), HUNG_MS)))
    await inv('queue:pause', fx.alpha, 'integration')
    fs.writeFileSync(fx.go, 'go')
    check('the queue paused: Testing finishes its checks and waits, both Merging', !!(await until(async () => !(await view())?.testing && !!(await view())?.paused, HUNG_MS)) && (await column(t.n)) === 'passed' && (await column(p.n)) === 'passed', JSON.stringify(await view()))
    await toTab('alpha')
    await head.locator('[data-platform="none"]').click()
    const alphaKeys = [(await h.card(t.n)).key, (await h.card(p.n)).key]
    check("Switch to None's warning: both cards in flight, the queue carrying on, the folder still a Git repository", !!(await until(async () => {
      const w = await text(dialog)
      return alphaKeys.every((k) => w.includes(k)) && /Their merge queue carries on/.test(w) && /still a Git repository/.test(w) && /From its next card, alpha uses None/.test(w) ? w : null
    }, HUNG_MS)), await text(dialog))
    await shoot(dialog, 'warning-git-to-none')
    check('Switch: saved', await confirmSwitch())
    check('alpha is None: the header, project.json', !!(await until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)) && (await inv('workflow:form', fx.alpha)).platform === 'none')
    check('…with no switch back offered: None was chosen knowing the folder is a Git repository', (await offer.count()) === 0)
    check("…and the old Git queue's section stays", !!(await until(async () => (await sections()).includes('queue'), HUNG_MS)), JSON.stringify(await sections()))
    // Reached from the Progress panel's queue card.
    await page.locator('.git-sections [data-section="workflow"]').click()
    const merges = await q.mergesTab(h)
    await merges.card('integration').locator('.progress-queue-link').click()
    check('Queue in Version Control lands on its section', !!(await until(async () => (await page.locator('.vc-view').getAttribute('data-platform')) === 'none' && (await selected()) === 'queue', HUNG_MS)))
    // The queued card removed there.
    await page.locator('.git-queue').getByRole('button', { name: `Remove ${alphaKeys[1]} from the queue` }).click()
    await page.locator('.dialog').getByRole('button', { name: 'Remove from queue' }).click()
    check('Queued is taken out of the queue from the section', !!(await until(async () => !(await view())?.queued.some((x) => x.card === p.n), HUNG_MS)))
    // A new card meanwhile: None's rules.
    const n1 = await q.agent(fx, h, 'N1')
    const fresh = (await inv('tasks:create', { title: 'Under None', project: 'alpha' })).number
    const st = await q.intent(h, n1, fresh, 'start')
    check('a new card starts under None meanwhile', st.status === 200 && (await startedUnder(fresh)) === 'none', JSON.stringify({ st, data: await started(fresh) }))
    // Resumed: Testing, under Git's rules still, merges.
    q.steer(fx, 'pass')
    await inv('queue:resume', fx.alpha, 'integration')
    check('resumed, Testing merges into integration under its Git rules', !!(await until(async () => (await column(t.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(t.n)))
    // Queued, back in Approved, leaves flight (archived): nothing is left, and the section goes.
    await inv('tasks:archive', p.n, true)
    check('…then the Merge queue section goes', !!(await until(async () => !(await sections()).includes('queue'), HUNG_MS)), JSON.stringify(await sections()))

    // --- gamma: the repository gone (S20), then git init.
    const g1 = await q.agent(fx, h, 'G1', { project: gamma })
    // The lane's reviewer.
    await q.agent(fx, h, 'GR', { project: gamma })
    const c1 = (await inv('tasks:create', { title: 'Gamma in flight', project: 'gamma' })).number
    const c2 = (await inv('tasks:create', { title: 'Gamma lane', project: 'gamma' })).number
    const c3 = (await inv('tasks:create', { title: 'Gamma next', project: 'gamma' })).number
    check('gamma: a card in flight under Git', (await q.intent(h, g1, c1, 'start')).status === 200 && (await startedUnder(c1)) === 'git')
    // A lane of its own builder, registered by it (the cw_lane tool's route): no agent is started again, so G1 keeps
    // its session and token.
    const gl = await q.agent(fx, h, 'GL', { project: gamma })
    const lane = await fetch(`http://127.0.0.1:${PORT}/v1/lanes`, { method: 'POST', headers: { Authorization: `Bearer ${gl.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'gamma', reviewer: 'GR', cards: [c2], name: 'gamma lane' }) })
    check('gamma: a lane runs', lane.status === 200, `${lane.status} ${await lane.text().catch(() => '')}`)
    // The tab open on gamma while its repository goes (#1492): coming back to the window, the tab reads git again and the
    // header follows it, with no workspace refresh asked for here.
    await toTab('gamma')
    const vcFact = page.locator('[data-vc-fact]')
    check('gamma: the header says the folder is a Git repository', !!(await until(async () => (await text(vcFact)).startsWith('This folder is a Git repository'), HUNG_MS)), await text(vcFact))
    // Again while something holds it a moment (a watcher, the scanner: EPERM under load).
    check('gamma: .git moved away', !!(await until(() => { try { fs.renameSync(path.join(gamma, '.git'), path.join(gamma, 'git-away')); return true } catch { return false } }, HUNG_MS)))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    check('the offer: the repository gone, Switch to None…', !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'repositoryGone', HUNG_MS)) && (await text(offer)).startsWith('The Git repository is gone.'), await text(offer))
    // While the offer shows it says the fact itself: no fact line (counted, as innerText would wait for one).
    check('…and the header no longer says it is a Git repository', (await vcFact.count()) === 0 || !(await text(vcFact)).startsWith('This folder is a Git repository'), await text(page.locator('[data-vc-head]')))
    const toast = page.locator('.toast', { hasText: "gamma's Git repository is gone" })
    check('the notice has Open Version Control', !!(await until(async () => (await toast.getByRole('button', { name: 'Open Version Control' }).count()) === 1, HUNG_MS)))
    await shoot(page.locator('.vc-view'), 'offer-gone')
    // Put back and the workspace read again (F5, not the tab's catch-up), then gone a second time (HR6's round 1): the
    // tab asks again, as the first time.
    const moveGit = (from, to) => until(() => { try { fs.renameSync(path.join(gamma, from), path.join(gamma, to)); return true } catch { return false } }, HUNG_MS)
    check('gamma: .git put back', !!(await moveGit('git-away', '.git')))
    await inv('workspace:refresh')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    check('…the refresh and the tab agree: a Git repository, no offer', !!(await until(async () => (await offer.count()) === 0 && (await vcFact.count()) === 1 && (await text(vcFact)).startsWith('This folder is a Git repository'), HUNG_MS)), await text(page.locator('[data-vc-head]')))
    check('gamma: .git moved away again', !!(await moveGit('.git', 'git-away')))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    check('…gone a second time: the offer again, no fact line saying Git', !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'repositoryGone' && (await vcFact.count()) === 0, HUNG_MS)), await text(page.locator('[data-vc-head]')))
    const refused = await q.intent(h, g1, c3, 'start')
    check("a Git card's start is refused: what can't be read, and the switch as its next step", refused.status === 409 && refused.body?.rule === 'platform.unknown' && /switch the project to None in its Version Control tab/.test(refused.body?.next ?? ''), JSON.stringify(refused))
    // German: the offer and the warning.
    await speak({ ...base, code: 'de', locale: 'de', messages: german })
    check('the offer in German', !!(await until(async () => (await text(offer)) && !(await text(offer)).startsWith('The Git repository'), HUNG_MS)), await text(offer))
    await shoot(page.locator('.vc-view'), 'offer-gone-de')
    await offer.locator('[data-action="vc-offer-switch"]').click()
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    await shoot(dialog, 'warning-gone-de')
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    await speak(base)
    await until(async () => (await text(offer)).startsWith('The Git repository is gone.'), HUNG_MS)
    await offer.locator('[data-action="vc-offer-switch"]').click()
    const c1Key = (await h.card(c1)).key
    check('the warning lists the running lane and the card in flight (no merge queue: its cards have none)', !!(await until(async () => {
      const w = await text(dialog)
      return /gamma lane/.test(w) && w.includes(c1Key) && !/merge queue carries on/.test(w) ? w : null
    }, HUNG_MS)), await text(dialog))
    await shoot(dialog, 'warning-gone')
    check('Switch to None: saved', await confirmSwitch())
    check('…the offer gone', !!(await until(async () => (await offer.count()) === 0, HUNG_MS)))
    check('the card in flight keeps its stage and Git rules', (await column(c1)) === 'doing' && (await startedUnder(c1)) === 'git' && !(await h.kinds(c1)).includes('Override'))
    const c3Start = await q.intent(h, g1, c3, 'start')
    check("a new card starts under None's rules", c3Start.status === 200 && (await startedUnder(c3)) === 'none', JSON.stringify({ c3Start, data: await started(c3) }))
    // Initialise repository… from Git's page (HI-1905): with a lane and a card in flight keeping None's rules, the switch
    // that follows warns first; cancelled, the project stays None, and Git is offered without a restart.
    await head.locator('[data-platform="git"]').click()
    const preview = page.locator('[data-vc-git-preview]')
    check("gamma: Git's page offers Initialise repository…", !!(await until(async () => (await preview.locator('[data-git-init]').count()) === 1, HUNG_MS)), await text(page.locator('.vc-view')))
    await preview.locator('[data-git-init]').click()
    const initDialog = page.locator('.dialog').filter({ has: page.locator('[data-git-init-form]') })
    await until(async () => (await initDialog.count()) === 1, HUNG_MS)
    await initDialog.locator('#git-init-gitignore').selectOption('none').catch(() => undefined)
    if (await initDialog.locator('#git-init-name').count()) await initDialog.locator('#git-init-name').fill('Hive Test')
    if (await initDialog.locator('#git-init-email').count()) await initDialog.locator('#git-init-email').fill('test@example.com')
    await initDialog.getByRole('button', { name: 'Initialise', exact: true }).click()
    check('initialised, the switch to Git warns first: the running lane and the card in flight keep their rules', !!(await until(async () => {
      const w = (await initDialog.count()) === 0 && (await dialog.count()) === 1 ? await text(dialog) : ''
      return /Switch gamma to Git\?/.test(w) && /gamma lane/.test(w) && w.includes(c1Key) ? w : null
    }, HUNG_MS)), await text(dialog))
    await shoot(dialog, 'warning-after-init')
    await page.keyboard.press('Escape')
    check('…cancelled: the repository stays, the project None, its page None’s', !!(await until(async () => (await dialog.count()) === 0 && (await preview.count()) === 0 && (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1, HUNG_MS)) && fs.existsSync(path.join(gamma, '.git')) && (await inv('workflow:form', gamma)).platform === 'none')
    check('after Initialise repository…, Git is offered', !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'gitFound', HUNG_MS)) && (await text(offer)).startsWith(`Git found at ${gamma}: switch to Git?`), await text(offer))
    await shoot(page.locator('.vc-view'), 'offer-git')
    await offer.locator('[data-action="vc-offer-switch"]').click()
    check('the warning says the Git options it had come back', !!(await until(async () => /The Git options it had before come back/.test(await text(dialog)), HUNG_MS)), await text(dialog))
    await shoot(dialog, 'warning-to-git')
    check('Switch: saved', await confirmSwitch())
    const gcfg = await inv('workflow:form', gamma)
    check("gamma is Git again, with its own options back", gcfg.platform === 'git' && Object.entries(GAMMA).every(([k, v]) => JSON.stringify(gcfg.own[k]) === JSON.stringify(v)), JSON.stringify(gcfg.own))
    const c4 = (await inv('tasks:create', { title: 'Gamma after init', project: 'gamma' })).number
    const c4Start = await q.intent(h, g1, c4, 'start')
    check("the next card starts under Git's rules", c4Start.status === 200 && (await startedUnder(c4)) === 'git', JSON.stringify({ c4Start, data: await started(c4) }))

    // --- delta: Mercurial found in a Git project.
    fs.mkdirSync(path.join(delta, '.hg'))
    await inv('workspace:refresh')
    await toTab('delta')
    check('the offer: Mercurial found, Switch to None…', !!(await until(async () => (await offer.getAttribute('data-vc-offer').catch(() => null)) === 'otherFound', HUNG_MS)) && (await text(offer)).startsWith('Mercurial found: not supported yet'), await text(offer))
    await shoot(page.locator('.vc-view'), 'offer-other')
    await speak({ ...base, code: 'de', locale: 'de', messages: german })
    await until(async () => !(await text(offer)).startsWith('Mercurial found: not supported'), HUNG_MS)
    await shoot(page.locator('.vc-view'), 'offer-other-de')
    await speak(base)
    await until(async () => (await text(offer)).startsWith('Mercurial found'), HUNG_MS)
    // The fact is said once: by the offer while it shows; Not Now hides it and the line beside the choice says it.
    const fact = page.locator('[data-vc-fact]')
    check('while the offer shows, no fact line repeats it', (await fact.count()) === 0)
    await offer.locator('[data-action="vc-offer-notnow"]').click()
    check('Not Now: the offer goes, the fact line says what was found', !!(await until(async () => (await offer.count()) === 0 && (await text(fact)) === 'Mercurial found in this folder: not supported yet.', HUNG_MS)), await text(fact))
    await shoot(page.locator('[data-vc-head]'), 'notnow-other')
    await head.locator('[data-platform="none"]').click()
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    check('Switch to None: saved', await confirmSwitch())
    const d1 = await q.agent(fx, h, 'D1', { project: delta })
    const dc = (await inv('tasks:create', { title: 'Delta under None', project: 'delta' })).number
    check("a new card starts under None's rules", (await q.intent(h, d1, dc, 'start')).status === 200 && (await startedUnder(dc)) === 'none')
    const gitTip = await lib.hoverTip(page, head.locator('[data-platform="git"]'), (x) => /Mercurial/.test(x))
    check('Git is greyed out, saying why', (await head.locator('[data-platform="git"]').getAttribute('aria-disabled')) === 'true' && gitTip === 'Mercurial found: not supported yet, so this project can only use None.', gitTip)
    const toGit = await inv('workflow:setPlatform', delta, 'git', { expected: 'none' }).then(() => 'switched', (e) => e.message)
    check('switching to Git is refused with the reason', /Mercurial found: not supported yet/.test(toGit), toGit)

    // --- A stale switch: alpha's dialog open while another switch is made.
    await toTab('alpha')
    await head.locator('[data-platform="git"]').click()
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    await inv('workflow:setPlatform', fx.alpha, 'git', { expected: 'none' })
    await dialog.getByRole('button', { name: 'Switch', exact: true }).click()
    check('a stale switch is refused in the dialog', !!(await until(async () => /Changed meanwhile: this project uses Git now/.test(await text(dialog.locator('.dialog-error'))), HUNG_MS)), await text(dialog))
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- A project inside a larger repository (OP-29).
    await lib.openWorkspace(inv, page, outer)
    await page.getByText('app', { exact: true }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Version Control' }).first().click()
    check('a subfolder project says actions affect the whole repository', !!(await until(async () => (await text(page.locator('[data-vc-fact]'))) === `This folder is inside a Git repository at ${outer}: branch and merge actions affect that whole repository.`, HUNG_MS)))
    const merging = q.queueOptions(fx, { target: '' })
    const op29 = await inv('workflow:setOptions', inner, { preset: null, options: merging }).then(() => 'saved', (e) => e.message)
    check('Combwork merges with no target of its own is refused (OP-29)', /This project is inside a larger repository: name the branch its work merges into\./.test(op29), op29)
    const named = await inv('workflow:setOptions', inner, { preset: null, options: { ...merging, target: 'main' } }).then(() => 'saved', (e) => e.message)
    check('…and saved once it names one', named === 'saved', named)
  } catch (e) {
    check('no exception', false, e.stack)
    await page.screenshot({ path: path.join(fx.shots, 'vcswitch-failure.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
