// The Version Control tab (#1416, SPEC §16.6): the Git tab renamed, Alt+8 and "Go to Version Control" kept on its id.
// A Git project: the header (None · Git with Git chosen and None disabled, its tooltip; the fact line naming the
// repository's root; "Workflow: Git · …" with no preset chosen, then Solo, then Custom (from Solo) as the options are saved,
// which opens Workflow), the five sections in order, opening at Changes; Project Settings → Workflow's Open Version
// Control and the presets notice's Choose… land on Workflow. A None project (no repository): Workflow only, where it
// opens, with Initialise repository… under the header. A subfolder of a larger repository (a second workspace kept in
// git): the whole-repository line. Screenshots in both themes, in English and German. Dev build, throwaway profile and
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
  const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { timeout: 5000 })
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
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [], workflow: { platform: 'git', preset: null, options: {} } }))
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
    check('Git is chosen, None disabled', !!(await lib.until(async () => (await head.locator('[data-platform="git"][aria-checked="true"]').count()) === 1 && (await head.locator('[data-platform="none"]').getAttribute('aria-disabled')) === 'true', HUNG_MS)), await text(head))
    const tip = await lib.hoverTip(page, head.locator('[data-platform="none"]'), (t) => /offers to switch/.test(t))
    check("None's tooltip says Hive offers a switch when it detects one", /offers to switch/.test(tip ?? ''), tip)
    check('the fact line names the repository root', !!(await lib.until(async () => (await text(fact)) === `This folder is a Git repository at ${alpha}.`, HUNG_MS)), await text(fact))
    check('the workflow link says no preset is chosen', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · no preset chosen', HUNG_MS)), await text(link))
    check('the five sections, Workflow first', JSON.stringify(await sections()) === JSON.stringify(['workflow', 'changes', 'history', 'branches', 'queue']), JSON.stringify(await sections()))
    check('a Git project opens at Changes', (await selected()) === 'changes')

    // The preset saved, as the form or the Assistant's tool saves it: the header follows.
    const form = await inv('workflow:form', alpha)
    const solo = form.presets.find((p) => p.id === 'solo').options
    const { platform: _p, ...soloOptions } = solo
    await inv('workflow:setOptions', alpha, { preset: 'solo', options: soloOptions })
    check('Solo saved: "Workflow: Git · Solo"', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · Solo', HUNG_MS)), await text(link))
    await inv('workflow:setOptions', alpha, { preset: 'solo', options: { ...soloOptions, dependenciesDone: !soloOptions.dependenciesDone } })
    check('an option changed: "Workflow: Git · Custom (from Solo)"', !!(await lib.until(async () => (await text(link)).trim() === 'Workflow: Git · Custom (from Solo)', HUNG_MS)), await text(link))
    await shots('git', page.locator('.vc-view'))
    await link.click()
    check('the link opens Workflow, with the options form', !!(await lib.until(async () => (await selected()) === 'workflow' && (await page.locator('[data-vc-workflow] .workflow-form').count()) === 1, HUNG_MS)))
    await shots('git-workflow', page.locator('.vc-view'))

    // --- Project Settings → Workflow: no form, Open Version Control.
    await page.locator('.git-sections [data-section="history"]').click()
    await lib.openProjectSettings(page)
    await page.locator('.settings-nav .row', { hasText: 'Workflow' }).click()
    const open = page.locator('[data-action="open-version-control"]')
    check('Project Settings → Workflow has Open Version Control and no form', !!(await lib.until(async () => (await open.count()) === 1, HUNG_MS)) && (await page.locator('.tab-body .workflow-form').count()) === 0)
    await open.click()
    check('Open Version Control lands on Workflow', !!(await lib.until(async () => (await page.locator('.tab.active', { hasText: 'Version Control' }).count()) === 1 && (await selected()) === 'workflow', HUNG_MS)))

    // --- A None project: Workflow only, and Initialise repository… under the header.
    await page.getByText('plain', { exact: true }).first().click()
    await vcTab.click()
    check('None is chosen, Git disabled', !!(await lib.until(async () => (await head.locator('[data-platform="none"][aria-checked="true"]').count()) === 1 && (await head.locator('[data-platform="git"]').getAttribute('aria-disabled')) === 'true', HUNG_MS)), await text(head))
    check('the fact line says the folder has no version control', !!(await lib.until(async () => (await text(fact)) === 'This folder has no version control.', HUNG_MS)), await text(fact))
    check('None: Workflow only, where it opens', !!(await lib.until(async () => JSON.stringify(await sections()) === '["workflow"]' && (await selected()) === 'workflow', HUNG_MS)), JSON.stringify(await sections()))
    check('Initialise repository… under the header', !!(await lib.until(async () => (await page.locator('[data-vc-init] [data-git-init]').count()) === 1, HUNG_MS)))
    check('the workflow link names None', (await text(link)).trim().startsWith('Workflow: None · '), await text(link))
    await shots('none', page.locator('.vc-view'))

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
      const view = (p, over = {}) => ({ project: p === d.alpha ? 'alpha' : 'plain', projectPath: p, target: 'main', paused: null, runBy: null, runHere: false, testing: null, queued: [], recent: [], returns: [], returnsMore: 0, hiveMerges: false, inFlight: [], ...over })
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
    await shots('subfolder', page.locator('.vc-view'))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
