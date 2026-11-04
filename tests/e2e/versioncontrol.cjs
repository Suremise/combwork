// The Version Control tab (#1416, SPEC §16.6): the Git tab renamed, Alt+8 and "Go to Version Control" kept on its id.
// A Git project: the header (None · Git with Git chosen and None available, its tooltip (#1419); the fact line naming the
// repository's root; "Workflow: Git · …" with no preset chosen, then Solo, then Custom (from Solo) as the options are saved,
// which opens Workflow), the five sections in order, opening at Changes; Project Settings → Workflow's Open Version
// Control and the presets notice's Choose… land on Workflow. A None project (no repository): Workflow only, where it
// opens, no Initialise repository…; Git chosen there shows only Initialise repository…, saving nothing, gone with the tab
// or None (HI-1905). A subfolder of a larger repository (a second workspace kept in
// git): the whole-repository line. A narrow tab: the sections folded to icons, the selected one named, each reached
// (#1461). Screenshots in both themes, in English and German. Dev build, throwaway profile and
// workspaces; no CLI is started, and the Assistant is off.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'versioncontrol-profile')
const ws = path.join(lib.WORK, 'versioncontrol-ws')
const alpha = path.join(ws, 'alpha')
const plain = path.join(ws, 'plain')
const outer = path.join(lib.WORK, 'versioncontrol-outer')
const inner = path.join(outer, 'app')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Writes to the workspace's board from outside Hive, as the upgrade would have (its marks). */
function board(sql, ...args) {
  const db = new DatabaseSync(path.join(ws, '.combwork', 'hive.db'), { timeout: 5000 })
  try {
    db.prepare(sql).run(...args)
  } finally {
    db.close()
  }
}

;(async () => {
  for (const d of [userData, ws, outer]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  // As the upgrade leaves a Git project: its options, no preset chosen (the presets notice names it).
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: {} } }))
  fs.mkdirSync(plain, { recursive: true })
  fs.writeFileSync(path.join(plain, 'notes.md'), '# Notes\n')
  // A workspace kept in git, its project a subfolder of that repository.
  fs.mkdirSync(inner, { recursive: true })
  fs.writeFileSync(path.join(inner, 'index.js'), 'module.exports = 1\n')
  lib.gitProject(outer, { 'README.md': '# Outer\n' })

  const { app, page } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const text = (loc) => loc.innerText().catch(() => '')
    await lib.openWorkspace(inv, page, ws)
    const vcTab = page.locator('.tabs .tab', { hasText: 'Version Control' })
    const head = page.locator('[data-vc-head]')
    const fact = page.locator('[data-vc-fact]')
    const link = page.locator('[data-action="vc-workflow"]')
    const sections = () => page.locator('.git-sections [role="tab"]').evaluateAll((b) => b.map((x) => x.getAttribute('data-section')))
    const selected = () => page.locator('.git-sections [aria-selected="true"]').getAttribute('data-section').catch(() => null)
    /** The workflow link sits at the end of the header's first row, level with the None · Git choice (the Assistant's OK). */
    const linkInPlace = async () => {
      const c = await head.locator('.vc-choice').boundingBox()
      const l = await link.boundingBox()
      const h = await head.boundingBox()
      return !!c && !!l && !!h && Math.abs(c.y + c.height / 2 - (l.y + l.height / 2)) < 4 && h.x + h.width - (l.x + l.width) < 30
    }
    const shots = async (name, target = page) => {
      // No tooltip or hover left over from the step before.
      await page.mouse.move(5, 5)
      await lib.until(async () => (await page.locator('.tip:visible').count()) === 0, HUNG_MS)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await target.screenshot({ path: path.join(lib.WORK, `versioncontrol-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }

    // --- A Git project: the tab, its header and its sections.
    await page.getByText('alpha', { exact: true }).first().click()
    check('the tab reads Version Control', !!(await lib.until(async () => (await vcTab.count()) === 1, HUNG_MS)))
    await vcTab.click()
    // None can always be chosen (#1419): its tooltip says what clicking it does; vcswitch switches.
    check('Git is chosen, None can be chosen', !!(await lib.until(async () => (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && (await head.locator('[data-platform="none"]').getAttribute('aria-disabled')) === 'false', HUNG_MS)), await text(head))
    const tip = await lib.hoverTip(page, head.locator('[data-platform="none"]'), (t) => /from its next card/.test(t))
    check("None's tooltip says it switches from the next card, asking first", tip === 'Switch this project to None, from its next card. Combwork shows what changes first.', tip)
    check('the fact line names the repository root', !!(await lib.until(async () => (await text(fact)) === `This folder is a Git repository at ${alpha}.`, HUNG_MS)), await text(fact))
    check('the workflow link says no preset is chosen', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · no preset chosen', HUNG_MS)), await text(link))
    check('the five sections, Workflow first', JSON.stringify(await sections()) === JSON.stringify(['workflow', 'changes', 'history', 'branches', 'queue']), JSON.stringify(await sections()))
    check('a wide tab names every section', (await page.locator('.git-sections.icons, .git-sections .icon-only').count()) === 0)
    check('a Git project opens at Changes', (await selected()) === 'changes')

    // The preset saved, as the form or the Assistant's tool saves it: the header follows.
    const form = await inv('workflow:form', alpha)
    const solo = form.presets.find((p) => p.id === 'solo').options
    const { platform: _p, ...soloOptions } = solo
    await inv('workflow:setOptions', alpha, { preset: 'solo', options: soloOptions })
    check('Solo saved: "Workflow: Git · Solo"', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · Solo', HUNG_MS)), await text(link))
    await inv('workflow:setOptions', alpha, { preset: 'solo', options: { ...soloOptions, dependenciesDone: !soloOptions.dependenciesDone } })
    check('an option changed: "Workflow: Git · Custom (from Solo)"', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · Custom (from Solo)', HUNG_MS)), await text(link))
    check('Git: the workflow link at the end of the header row', await linkInPlace())
    await shots('git', page.locator('.vc-view'))
    await link.click()
    check('the link opens Workflow, with the options form', !!(await lib.until(async () => (await selected()) === 'workflow' && (await page.locator('[data-vc-workflow] .workflow-form').count()) === 1, HUNG_MS)))
    await shots('git-workflow', page.locator('.vc-view'))

    // --- Project Settings has no Workflow section (HI-1766: it was only a link here) and no Card loops (options here now).
    await page.locator('.git-sections [data-section="history"]').click()
    await lib.openProjectSettings(page)
    const nav = page.locator('.settings-nav .row')
    check('Project Settings has neither a Workflow nor a Card loops section', !!(await lib.until(async () => (await nav.count()) > 0, HUNG_MS)) && (await nav.filter({ hasText: /^\s*(Workflow|Card loops)\s*$/ }).count()) === 0 && (await page.locator('.tab-body .workflow-form').count()) === 0, (await nav.allInnerTexts()).join(' | '))
    await vcTab.click()

    // --- A None project: Workflow only, no Initialise repository… (HI-1905: it is Git's, below).
    await page.getByText('plain', { exact: true }).first().click()
    await vcTab.click()
    const preview = page.locator('[data-vc-git-preview]')
    check('None is chosen, Git can be chosen too (HI-1905)', !!(await lib.until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1 && (await head.locator('[data-platform="git"]').getAttribute('aria-disabled')) === 'false', HUNG_MS)), await text(head))
    const gitTip = await lib.hoverTip(page, head.locator('[data-platform="git"]'), (t) => /Initialise/.test(t))
    check("Git's tooltip says it needs a repository first, nothing changing until then", gitTip === 'Git needs this folder to be a repository: Initialise repository… makes it one. Nothing changes until you do.', gitTip)
    check('the fact line says the folder has no version control', !!(await lib.until(async () => (await text(fact)) === 'This folder has no version control.', HUNG_MS)), await text(fact))
    check('None: Workflow only, where it opens', !!(await lib.until(async () => JSON.stringify(await sections()) === '["workflow"]' && (await selected()) === 'workflow', HUNG_MS)), JSON.stringify(await sections()))
    check("None's page has no Initialise repository…", (await page.locator('[data-git-init]').count()) === 0)
    check('the workflow link names None', (await text(link)).trim().startsWith('Workflow: None · '), await text(link))
    check('None: the workflow link at the end of the header row', await linkInPlace())
    await shots('none', page.locator('.vc-view'))

    // --- Git chosen before the folder is a repository (HI-1905): Git's page, only Initialise repository…, nothing saved.
    const plainSaved = () => (fs.existsSync(path.join(plain, '.combwork', 'project.json')) ? fs.readFileSync(path.join(plain, '.combwork', 'project.json'), 'utf8') : null)
    const savedBefore = plainSaved()
    const linkBefore = (await text(link)).trim()
    await head.locator('[data-platform="git"]').click()
    check("Git: its page says the folder isn't a repository yet, with Initialise repository… and what it does", !!(await lib.until(async () => (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && (await text(preview)).startsWith("This folder isn't a Git repository yet.") && (await preview.locator('[data-git-init]').count()) === 1 && /on a branch called main/.test(await text(preview)), HUNG_MS)), await text(page.locator('.vc-view')))
    check("…and nothing else of Git's: no sections, no preset step", (await page.locator('.git-sections').count()) === 0 && (await page.locator('[data-preset-step]').count()) === 0 && (await page.locator('.git-body').count()) === 0)
    check('…the workflow link and the fact line still None’s', (await text(link)).trim() === linkBefore && (await text(fact)) === 'This folder has no version control.', await text(link))
    check('…and nothing saved', plainSaved() === savedBefore && (await inv('workflow:form', plain)).platform === 'none')
    await shots('none-git-preview', page.locator('.vc-view'))
    await head.locator('[data-platform="none"]').click()
    check('None again: its page', !!(await lib.until(async () => (await preview.count()) === 0 && JSON.stringify(await sections()) === '["workflow"]', HUNG_MS)))
    await head.locator('[data-platform="git"]').click()
    await lib.until(async () => (await preview.count()) === 1, HUNG_MS)
    await page.locator('.tabs .tab', { hasText: 'Tasks' }).first().click()
    await vcTab.click()
    check('leaving the tab and coming back: None, as saved', !!(await lib.until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1 && (await preview.count()) === 0, HUNG_MS)), await text(head))

    // --- German: the header and the sections as they wrap.
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'de')
    const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
    await speak({ ...base, code: 'de', locale: 'de', messages })
    check('the tab and the fact line in German', !!(await lib.until(async () => (await page.locator('.tabs .tab', { hasText: 'Versionsverwaltung' }).count()) === 1 && (await text(fact)) === 'Dieser Ordner hat keine Versionsverwaltung.', HUNG_MS)), await text(fact))
    await shots('none-de', page.locator('.vc-view'))
    await page.getByText('alpha', { exact: true }).first().click()
    await page.locator('.git-sections [data-section="changes"]').click()
    check('the Git header in German', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · Benutzerdefiniert (aus Solo)', HUNG_MS)), await text(link))
    await shots('git-de', page.locator('.vc-view'))
    await speak(base)
    check('back in English', !!(await lib.until(async () => (await vcTab.count()) === 1, HUNG_MS)))

    // --- The presets notice (after an upgrade from 0.9): Choose… opens the first named project's tab at Workflow.
    await inv('workflow:setOptions', alpha, { preset: null, options: {} })
    board("INSERT INTO board_meta (key, value) VALUES ('adoption_upto', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    await page.reload()
    await lib.appReady(page)
    await page.getByText('plain', { exact: true }).first().click()
    const notice = page.locator('.presets-notice')
    check('the presets notice names alpha', !!(await lib.until(async () => (await notice.count()) > 0 && (await text(notice)).includes('alpha'), HUNG_MS)), await text(page.locator('.main-area')))
    await notice.getByRole('button', { name: 'Choose…' }).click()
    check('Choose… opens alpha’s Version Control tab at Workflow', !!(await lib.until(async () => (await page.locator('.project-header', { hasText: 'alpha' }).count()) > 0 && (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await selected()) === 'workflow' && (await page.locator('[data-vc-workflow] .workflow-form').count()) === 1, HUNG_MS)))

    // --- The queues, from models main gives in place of its own (#1416's round 1): alpha's queue paused; plain's (None)
    // as each step sets it. A read of plain's can be held, to see what shows meanwhile.
    await app.evaluate(({ ipcMain }, d) => {
      const view = (p, over = {}) => ({ project: p === d.alpha ? 'alpha' : 'plain', projectPath: p, target: 'main', paused: null, runBy: null, runHere: false, testing: null, queued: [], recent: [], returns: [], returnsMore: 0, pauses: [], hiveMerges: false, inFlight: [], ...over })
      globalThis.__vc = { hold: false, held: [], asked: 0, plain: [] }
      ipcMain.removeHandler('queue:list')
      ipcMain.handle('queue:list', (_e, p) => {
        const s = globalThis.__vc
        if (p === d.alpha) return [view(p, { paused: { reason: 'user', card: null, files: [], by: 'user', at: new Date().toISOString() } })]
        if (p !== d.plain) return []
        if (s.hold) {
          s.asked++
          return new Promise((r) => s.held.push(r))
        }
        return s.plain.map((o) => view(p, o))
      })
      ipcMain.removeHandler('queue:history')
      ipcMain.handle('queue:history', () => [])
    }, { alpha, plain })
    const said = (projectPath) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'queue-changed', workspacePath: ws, projectPath })
    const plainQueue = (models) => app.evaluate((_, m) => (globalThis.__vc.plain = m), models)
    const queueTab = page.locator('.git-sections [data-section="queue"]')
    const pick = async (name) => {
      await page.getByText(name, { exact: true }).first().click()
      await vcTab.click()
    }
    await said(alpha)
    await pick('alpha')
    await queueTab.click()
    check("alpha's queue shows in its Merge queue section", !!(await lib.until(async () => (await page.locator('.vc-view [data-queue="alpha#main"]').count()) === 1, HUNG_MS)))

    // Another project's queues never show while its own read is pending: plain shows none of alpha's, and only Workflow.
    await app.evaluate(() => (globalThis.__vc.hold = true))
    await pick('plain')
    check("plain's read is held", !!(await lib.until(() => app.evaluate(() => globalThis.__vc.asked > 0), HUNG_MS)))
    check("meanwhile plain shows none of alpha's queue, and Workflow only", !!(await lib.until(async () => (await page.locator('.project-header', { hasText: 'plain' }).count()) > 0 && (await page.locator('.vc-view [data-queue]').count()) === 0 && JSON.stringify(await sections()) === '["workflow"]', HUNG_MS)), JSON.stringify(await sections()))
    await app.evaluate(() => {
      const s = globalThis.__vc
      s.hold = false
      for (const r of s.held) r([])
      s.held = []
    })

    // Queue in Version Control, from the Progress panel with another project selected: it selects alpha, at Merge queue.
    await page.locator('.progress-rail').click()
    const panel = page.locator('.progress-panel')
    await panel.locator('.progress-tab[data-tab="merges"]').click()
    const card = panel.locator('[data-queue="alpha#main"]')
    check("the Merges tab has alpha's queue", !!(await lib.until(async () => (await card.count()) === 1, HUNG_MS)))
    await card.locator('.progress-queue-link').click()
    check("Queue in Version Control selects alpha and opens its Merge queue", !!(await lib.until(async () => (await page.locator('.project-header', { hasText: 'alpha' }).count()) > 0 && (await page.locator('.vc-view').getAttribute('data-platform')) === 'git' && (await selected()) === 'queue', HUNG_MS)))

    // None with an old Git queue whose only state is a return just seen: its section shows, then goes by itself once the
    // return folds (no queue event meanwhile), falling back to Workflow.
    await plainQueue([{ returns: [{ card: 9, key: 'PL-9', title: 'Seen', entry: 'pl/9', outcome: 'returned', reason: 'checks', at: new Date(Date.now() - 60_000).toISOString(), seen: new Date().toISOString() }] }])
    await said(plain)
    await pick('plain')
    check("None keeps the old queue's section while its return shows", !!(await lib.until(async () => (await queueTab.count()) === 1, HUNG_MS)))
    await queueTab.click()
    check('…with the return in it', !!(await lib.until(async () => (await page.locator('.vc-view .progress-queue-returned').count()) === 1, HUNG_MS)))
    check('…and both go once it folds, back to Workflow, with no queue event', !!(await lib.until(async () => (await queueTab.count()) === 0 && (await page.locator('.vc-view .progress-queue-returned').count()) === 0 && (await selected()) === 'workflow', HUNG_MS)), JSON.stringify(await sections()))

    // --- A subfolder of a larger repository: the whole-repository line.
    await lib.openWorkspace(inv, page, outer)
    await page.getByText('app', { exact: true }).first().click()
    await vcTab.click()
    check('a subfolder project is Git, and says actions affect the whole repository', !!(await lib.until(async () => (await text(fact)) === `This folder is inside a Git repository at ${outer}: branch and merge actions affect that whole repository.`, HUNG_MS)) && (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1, await text(fact))
    check('the workflow link shows there too, at the end of the header’s one row', !!(await lib.until(async () => (await text(link)).trim().startsWith('Workflow: Git · '), HUNG_MS)), await text(head))
    check('subfolder: the workflow link at the end of the header row', await linkInPlace())
    await shots('subfolder', page.locator('.vc-view'))

    // A narrow tab: the fact line takes a row of its own under None · Git and the link, never a sliver (unusedwt's narrow
    // window with Progress open caught one).
    await lib.fitWindow(app, page, { width: 760, height: 860 })
    const factBox = async () => (await fact.boundingBox())?.width ?? 0
    check('narrow: the fact line has a row of its own, the link still level with the choice', !!(await lib.until(async () => (await factBox()) > (await page.locator('.vc-view').boundingBox()).width * 0.6 && (await linkInPlace()), HUNG_MS)), String(await factBox()))
    await shots('subfolder-narrow', page.locator('.vc-view'))

    // The sections at that width (#1461): folded to their icons, the selected one with its name, all inside the tab,
    // each reached with a click; the icons' names in their tooltips. In English and German.
    const row = () =>
      page.locator('.git-sections').evaluate((list) => {
        const l = list.getBoundingClientRect()
        const v = list.closest('.vc-view').getBoundingClientRect()
        const sel = list.querySelector('[aria-selected="true"]')
        const s = sel?.getBoundingClientRect()
        const name = sel?.querySelector('.hive-tab-label')?.getBoundingClientRect()
        const others = [...list.querySelectorAll('[role="tab"]:not([aria-selected="true"])')]
        return {
          view: Math.round(v.width),
          inside: l.left >= v.left - 0.5 && l.right <= v.right + 0.5,
          scrolls: list.scrollWidth > list.clientWidth,
          selectedWhole: !!s && s.left >= l.left - 0.5 && s.right <= l.right + 0.5,
          named: (name?.width ?? 0) > 20,
          icons: others.every((b) => b.classList.contains('icon-only') && b.getBoundingClientRect().width >= 16)
        }
      })
    const rowOk = (r) => r.inside && !r.scrolls && r.selectedWhole && r.named && r.icons
    const everySection = async (lang) => {
      for (const id of await sections()) {
        await page.locator(`.git-sections [data-section="${id}"]`).click()
        check(`narrow (${lang}): ${id} reached, shown whole with its name, the others icons, all inside the tab`, !!(await lib.until(async () => (await selected()) === id && rowOk(await row()), HUNG_MS)), JSON.stringify(await row()))
      }
    }
    check('the tab is narrow (about 370px)', (await row()).view < 420, String((await row()).view))
    await everySection('en')
    const histTip = await lib.hoverTip(page, page.locator('.git-sections [data-section="history"]'), (t) => t === 'History')
    check("a folded section's tooltip names it", histTip === 'History', histTip)
    await page.locator('.git-sections [data-section="branches"]').click()
    await shots('sections-narrow', page.locator('.vc-view'))
    await speak({ ...base, code: 'de', locale: 'de', messages })
    check('the sections in German', !!(await lib.until(async () => (await page.locator('.tabs .tab', { hasText: 'Versionsverwaltung' }).count()) === 1, HUNG_MS)))
    await everySection('de')
    await page.locator('.git-sections [data-section="branches"]').click()
    await shots('sections-narrow-de', page.locator('.vc-view'))
    await speak(base)
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
