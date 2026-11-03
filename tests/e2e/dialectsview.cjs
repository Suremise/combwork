// The Dialects view (HI-2444; plans/2026-11-03-dialects-design.md, section 4; HR1's design checks s12 and s15): the list
// of a workspace's dialect files with their state, which running agents use them (a known model on the empty shipped
// file too) and an on/off switch; a file showing every agent text, inherited text dimmed with its layer, expanding to
// each layer's value; outdated overrides flagged with the current Default (or none, for an id this Hive no longer has);
// Save checking the schema only, refused with reasons and the draft kept, from the Texts tab and from the JSON tab (an
// invalid JSON never saving an older draft); a change on disk while editing refused (changedOnDisk) and Keep My Changes;
// Duplicate (no model), Use for a model (Promote), Revert to shipped, Export, Import (through its token), Delete (the
// user's own files only); "restart to apply" only for a dialect change, never a skill-only one; Agent Settings' Dialect
// picking a file. Screenshots in light and dark. Runs the fake Claude Code (no model catalogue: FAKE_CLAUDE_MODELS=fail).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'dialectsview-profile')
const ws = path.join(lib.WORK, 'dialectsview-ws')
const claudeHome = path.join(lib.WORK, 'dialectsview-claude-home')
const proj = path.join(ws, 'alpha')
const dialects = path.join(ws, '.hive', 'dialects')
const PORT = lib.port(47711)
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const file = (name, texts, extra = {}) => JSON.stringify({ name, ...extra, texts: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text, why: 'dialectsview' }])) }, null, 2)
const TEST_COPY = 'claude-code/Mark v2.json'
const HOST = 'contract.agent.host'
const read = (rel) => fs.readFileSync(path.join(dialects, ...rel.split('/')), 'utf8')

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(ws, { recursive: true })
  lib.gitProject(proj)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([proj.toLowerCase(), ws.toLowerCase()]))
  fs.mkdirSync(path.join(dialects, 'claude-code'), { recursive: true })
  // The Workspace file overrides the contract's first line; the test copy has two outdated overrides: an id this Hive
  // doesn't have, and a text missing a placeholder.
  fs.writeFileSync(path.join(dialects, 'workspace.json'), file('Workspace', { [HOST]: 'WS-HOST {hasProject, select, yes {{project}} other {}}.' }))
  fs.writeFileSync(path.join(dialects, ...TEST_COPY.split('/')), file('Mark v2', { 'gone.text': 'old', 'api.http.noRoute': 'MARK {method}' }))
  const importFrom = path.join(lib.probeDir('dialectsview-import'), 'Imported.json')
  fs.writeFileSync(importFrom, file('Imported', { 'api.http.noRoute': 'IMP {method} {path}' }, { model: 'claude-opus-5-5' }))
  lib.enableProviders(userData, ['claude-code'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, FAKE_CLAUDE_MODELS: 'fail' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const command = (id) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id })
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === id)
  const ready = (id) => until(async () => {
    const s = await live(id)
    if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(proj, id), '\r')
    return ['ready', 'finished'].includes(s?.status)
  }, HUNG_MS)
  const shot = async (name, locator = null) => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await (locator ?? page).screenshot({ path: path.join(lib.WORK, `dialectsview-${name}-${theme}.png`) })
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  }
  // Answers the app's next confirm or prompt dialog: its field filled when one is given, then its main button.
  const answer = async (value) => {
    const dialog = page.locator('.dialog').last()
    await dialog.waitFor({ timeout: HUNG_MS })
    if (value !== undefined) await dialog.locator('input.input').first().fill(value)
    await dialog.locator('.btn.primary, .btn.danger').last().click()
  }

  // --- An agent on a model Hive can name, on the empty shipped Opus 5.5 file (Auto).
  const clara = await lib.addAgent(inv, proj, { name: 'Clara' })
  await lib.setLaunch(inv, proj, clara.id, { model: 'claude-opus-5-5' })
  await inv('session:start', proj, { agentId: clara.id })
  check('Clara starts', !!(await ready(clara.id)))

  await command('view.dialects')
  const row = (p) => page.locator(`.dialect-row[data-dialect="${p}"]`)
  check('the Dialects view lists the files: Workspace, the CLI file, the shipped model files, the test copy, the API file', !!(await until(async () => (await row('workspace.json').count()) && (await row('claude-code/cli.json').count()) && (await row('claude-code/Opus 5.5.json').count()) && (await row(TEST_COPY).count()) && (await row('api/cli.json').count()), HUNG_MS)))
  check('the test copy is flagged with its 2 outdated texts', (await row(TEST_COPY).locator('[data-outdated]').getAttribute('data-outdated').catch(() => null)) === '2')
  check('Clara (a known model, Auto) shows as using the empty shipped Opus 5.5 file', !!(await until(async () => (await row('claude-code/Opus 5.5.json').locator('[data-users]').getAttribute('data-users').catch(() => null)) === '1', HUNG_MS)))
  check("…and the Workspace and CLI files, which her chain has too, not the test copy", (await row('workspace.json').locator('[data-users]').count()) === 1 && (await row(TEST_COPY).locator('[data-users]').count()) === 0)
  await shot('overview')

  // --- A file: every text, inherited ones dimmed with their layer; expanding shows each layer.
  await row(TEST_COPY).click()
  const pane = page.locator(`.dialect-detail[data-dialect-file="${TEST_COPY}"]`)
  await pane.waitFor({ timeout: HUNG_MS })
  await pane.locator('.dialect-area[data-area="contract"] .dialect-area-head').click()
  const host = pane.locator(`.dialect-text[data-text-id="${HOST}"]`)
  check('an empty file shows every text: the contract area lists its first line', (await until(() => host.count(), HUNG_MS)) === 1)
  check('…inherited from the Workspace file: dimmed, with its layer', (await host.getAttribute('data-source')) === 'layer' && (await host.getAttribute('class')).includes('inherited') && /Workspace/.test(await host.locator('.dialect-source').innerText()), await host.locator('.dialect-source').innerText())
  await host.locator('.dialect-text-head').click()
  const layers = await host.locator('.dialect-layer').evaluateAll((els) => els.map((e) => e.getAttribute('data-layer')))
  check('expanding it shows each layer, top to bottom: this file, the CLI file, Workspace, Default', JSON.stringify(layers) === JSON.stringify(['file', 'cli', 'workspace', 'default']), JSON.stringify(layers))
  check('…the empty layers saying "—", the Workspace its text', (await host.locator('.dialect-layer[data-layer="workspace"]').innerText()).includes('WS-HOST') && (await host.locator('.dialect-layer[data-layer="file"]').innerText()).includes('—'))

  // --- Outdated: flagged with the Default beside them; an id this Hive no longer has, with no Default.
  const outdated = pane.locator('.dialect-area[data-area="outdated"]')
  check('the outdated overrides are listed first', (await outdated.locator('.dialect-text').count()) === 2)
  check('…an id this Hive no longer has says there is no current Default', (await outdated.locator('.dialect-text[data-text-id="gone.text"] [data-problem="unknown"]').count()) === 1 && /No current Default/.test(await outdated.locator('.dialect-text[data-text-id="gone.text"]').innerText()))
  check('…a text missing a placeholder says which, with the Default now beside it', /missing \{path\}/.test(await outdated.locator('.dialect-text[data-text-id="api.http.noRoute"]').innerText()) && /No route for/.test(await outdated.locator('.dialect-text[data-text-id="api.http.noRoute"]').innerText()))
  await shot('inherited-outdated', pane)

  // --- Save checks the schema only: refused with reasons, the draft kept.
  await host.locator('[data-dialect-override]').click()
  await host.locator('[data-dialect-edit-text]').fill('MINE {project}')
  await pane.locator('[data-dialect-save]').click()
  const refused = pane.locator('[data-dialect-refused]')
  check('a save with texts that fail the schema is refused, naming each and what is wrong', !!(await until(async () => (await refused.count()) === 1, HUNG_MS)) && /contract\.agent\.host: missing \{hasProject\}/.test(await refused.innerText()) && /gone\.text/.test(await refused.innerText()), await refused.innerText().catch(() => ''))
  check('…nothing is written, and the draft is kept', !read(TEST_COPY).includes('MINE') && (await host.locator('[data-dialect-edit-text]').inputValue()) === 'MINE {project}')
  await host.locator('[data-dialect-edit-text]').fill('MINE {hasProject, select, yes {{project}} other {}}.')
  for (const id of ['gone.text', 'api.http.noRoute']) {
    const r = outdated.locator(`.dialect-text[data-text-id="${id}"]`)
    await r.locator('.dialect-text-head').click()
    await r.locator('[data-dialect-remove]').click()
  }
  await pane.locator('[data-dialect-save]').click()
  check('fixed, it saves: the override is in the file, the outdated ones gone', !!(await until(() => read(TEST_COPY).includes('MINE {hasProject'), HUNG_MS)) && !read(TEST_COPY).includes('gone.text'), read(TEST_COPY))
  check('…and the list no longer flags it', !!(await until(async () => (await row(TEST_COPY).locator('[data-outdated]').count()) === 0, HUNG_MS)))

  // --- The JSON tab: one draft with the Texts tab; invalid JSON refused with the draft kept; a valid save.
  await pane.locator('[data-dialect-tab="json"]').click()
  const editor = pane.locator('.dialect-json .monaco-editor .view-lines')
  await until(async () => (await editor.innerText().catch(() => '')).includes('MINE'), HUNG_MS)
  check('the JSON tab shows the file as saved, with no draft started by showing it', (await pane.locator('[data-dialect-discard]').count()) === 0 && (await pane.locator('[data-dialect-outside]').count()) === 0)
  // The JSON tab's whole text replaced as a user would: everything selected, then pasted (typing JSON in Monaco closes
  // brackets and quotes by itself).
  const paste = async (text) => {
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+V')
  }
  await paste('{ "name": "Mark v2", "texts": { ')
  await until(() => pane.locator('[data-dialect-discard]').count(), HUNG_MS)
  // Saved at once, before the parse that follows typing: the JSON as shown, not the last valid draft.
  await pane.locator('[data-dialect-save]').click()
  check("invalid JSON saved at once is refused (it isn't JSON), never the earlier draft", !!(await until(async () => /isn't JSON/.test(await refused.innerText().catch(() => '')), HUNG_MS)) && read(TEST_COPY).includes('MINE {hasProject'), await refused.innerText().catch(() => ''))
  check('…the JSON tab says so, and keeps what was typed', (await pane.locator('[data-dialect-json-bad]').count()) === 1)
  await shot('json-error', pane)
  // The invalid draft is kept across another file and leaving the view (HR2 on HI-2444 r1): back on its JSON tab, as
  // typed, still flagged, and the Texts tab still asks before dropping it.
  const editorText = async () => (await editor.innerText().catch(() => '')).replace(/ /g, ' ')
  const jsonTabOn = async () => (await pane.locator('[data-dialect-tab="json"]').getAttribute('aria-selected').catch(() => null)) === 'true'
  const reopen = async (via) => {
    if (via === 'file') {
      await row('workspace.json').click()
      await page.locator('.dialect-detail[data-dialect-file="workspace.json"]').waitFor({ timeout: HUNG_MS })
    } else {
      await command('view.projects')
      await command('view.dialects')
    }
    await row(TEST_COPY).click()
    await pane.waitFor({ timeout: HUNG_MS })
    await until(async () => (await editorText()).includes('"texts"'), HUNG_MS)
  }
  for (const via of ['file', 'view']) {
    await reopen(via)
    const shown = await editorText()
    check(`back after ${via === 'file' ? 'another file' : 'leaving the view'}, the invalid JSON draft is on its JSON tab, as typed and still flagged`, (await jsonTabOn()) && (await pane.locator('[data-dialect-json-bad]').count()) === 1 && shown.includes('"texts": {') && !shown.includes('MINE'), shown)
  }
  await pane.locator('[data-dialect-tab="texts"]').click()
  const leave = page.locator('.dialog').last()
  check('…and the Texts tab still asks before dropping it', !!(await until(() => leave.count(), HUNG_MS)))
  await leave.locator('.btn.subtle').first().click()
  check('…Keep editing leaves it on the JSON tab, as typed', (await jsonTabOn()) && (await editorText()).includes('"texts": {'))
  // A JSON draft typed and the file left at once, before the parse that follows typing: it comes back as typed.
  await paste(JSON.stringify({ name: 'Mark v2', texts: { [HOST]: { text: 'JSON {project}', why: 'a test' } } }, null, 2))
  await row('workspace.json').click()
  await row(TEST_COPY).click()
  await pane.waitFor({ timeout: HUNG_MS })
  await until(async () => (await editorText()).includes('JSON {project}'), HUNG_MS)
  check('a JSON draft typed just before leaving the file comes back as typed, on its JSON tab', (await jsonTabOn()) && (await editorText()).includes('JSON {project}'), await editorText())
  await pane.locator('[data-dialect-save]').click()
  check('a JSON text that fails the schema is refused the same way', !!(await until(async () => /missing \{hasProject\}/.test(await refused.innerText().catch(() => '')), HUNG_MS)) && !read(TEST_COPY).includes('JSON {project}'))
  await paste(JSON.stringify({ name: 'Mark v2', texts: { [HOST]: { text: 'JSON {hasProject, select, yes {{project}} other {}}.', why: 'a test' } } }, null, 2))
  await pane.locator('[data-dialect-save]').click()
  check('a valid JSON text saves', !!(await until(() => read(TEST_COPY).includes('JSON {hasProject'), HUNG_MS)), read(TEST_COPY))
  await pane.locator('[data-dialect-tab="texts"]').click()

  // --- A change on disk while editing: said, never overwritten; Keep My Changes makes the next Save write over it.
  await pane.locator('.dialect-area[data-area="contract"] .dialect-area-head').click().catch(() => undefined)
  await host.locator('.dialect-text-head').click().catch(() => undefined)
  await until(() => host.locator('[data-dialect-edit-text]').count(), HUNG_MS)
  await host.locator('[data-dialect-edit-text]').fill('DRAFT {hasProject, select, yes {{project}} other {}}.')
  fs.writeFileSync(path.join(dialects, ...TEST_COPY.split('/')), file('Mark v2', { [HOST]: 'OUTSIDE {hasProject, select, yes {{project}} other {}}.' }))
  check('a change made outside while editing shows "changed outside Hive"', !!(await until(() => pane.locator('[data-dialect-outside]').count(), HUNG_MS)))
  check('…and the draft is kept across the reload', (await host.locator('[data-dialect-edit-text]').inputValue()).startsWith('DRAFT'))
  fs.writeFileSync(path.join(dialects, ...TEST_COPY.split('/')), file('Mark v2', { [HOST]: 'OUTSIDE2 {hasProject, select, yes {{project}} other {}}.' }))
  await pane.locator('[data-dialect-outside] .btn').last().click()
  await until(async () => (await pane.locator('[data-dialect-outside]').count()) === 0, HUNG_MS)
  // Changed again outside after Keep My Changes adopted the text then: a further change is a conflict again.
  fs.writeFileSync(path.join(dialects, ...TEST_COPY.split('/')), file('Mark v2', { [HOST]: 'OUTSIDE3 {hasProject, select, yes {{project}} other {}}.' }))
  const saveNow = await inv('dialects:save', TEST_COPY, { file: { name: 'Mark v2', texts: { [HOST]: { text: 'X {hasProject, select, yes {{project}} other {}}.' } } } }, 'not the disk')
  check('a save from a base that is not the file on disk is refused (changedOnDisk), under the write lock', saveNow?.refused === 'changedOnDisk' && read(TEST_COPY).includes('OUTSIDE3'), JSON.stringify(saveNow))
  await pane.locator('[data-dialect-discard]').click().catch(() => undefined)

  // --- Duplicate (no model), Use for a model (Promote), on/off.
  await row('claude-code/Opus 5.5.json').click()
  await page.locator('.dialect-detail[data-dialect-file="claude-code/Opus 5.5.json"] [data-dialect-duplicate]').click()
  await answer('Opus 5.5 v2')
  check('Duplicate makes a test copy beside it, with no model', !!(await until(() => fs.existsSync(path.join(dialects, 'claude-code', 'Opus 5.5 v2.json')), HUNG_MS)) && !('model' in JSON.parse(read('claude-code/Opus 5.5 v2.json'))))
  await row('claude-code/Opus 5.5 v2.json').click()
  await page.locator('.dialect-detail[data-dialect-file="claude-code/Opus 5.5 v2.json"] [data-dialect-promote]').click()
  await answer('claude-opus-5-5')
  check('Use for a model moves the claim onto the copy; the file that had it becomes a test copy', !!(await until(() => JSON.parse(read('claude-code/Opus 5.5 v2.json')).model === 'claude-opus-5-5', HUNG_MS)) && !('model' in JSON.parse(read('claude-code/Opus 5.5.json'))))
  // Clara launched on the file that had the model: its page says her chain moved (she gets the promoted one at restart).
  await row('claude-code/Opus 5.5.json').click()
  check('…and Clara, on Auto, shows "restart to apply" on the file she launched on: her chain moved', !!(await until(async () => /Clara/.test(await page.locator('.dialect-detail[data-dialect-file="claude-code/Opus 5.5.json"] [data-dialect-restart]').innerText().catch(() => '')), HUNG_MS)), await page.locator('.dialect-detail').innerText().catch(() => ''))
  // Revert the shipped file Promote changed (Edited), which puts back its model.
  await page.locator('.dialect-detail[data-dialect-file="claude-code/Opus 5.5.json"] [data-dialect-revert]').click()
  await answer()
  check('Revert to shipped puts back the file as Hive ships it', !!(await until(() => JSON.parse(read('claude-code/Opus 5.5.json')).model === 'claude-opus-5-5', HUNG_MS)))
  // A file deleted, or renamed, outside while it is shown: it says it is no longer there, never loading forever (HR2 r1).
  const goneShown = () => until(() => page.locator('[data-dialect-gone]').count(), HUNG_MS)
  await row('claude-code/Opus 5.5 v2.json').click()
  await page.locator('.dialect-detail[data-dialect-file="claude-code/Opus 5.5 v2.json"]').waitFor({ timeout: HUNG_MS })
  fs.rmSync(path.join(dialects, 'claude-code', 'Opus 5.5 v2.json'))
  check('a file deleted outside while shown says it is no longer there', !!(await goneShown()))
  fs.writeFileSync(path.join(dialects, 'claude-code', 'Renamed.json'), file('Renamed', {}))
  await until(() => row('claude-code/Renamed.json').count(), HUNG_MS)
  await row('claude-code/Renamed.json').click()
  await page.locator('.dialect-detail[data-dialect-file="claude-code/Renamed.json"]').waitFor({ timeout: HUNG_MS })
  fs.renameSync(path.join(dialects, 'claude-code', 'Renamed.json'), path.join(dialects, 'claude-code', 'Renamed 2.json'))
  check('…and one renamed outside too', !!(await goneShown()))
  fs.rmSync(path.join(dialects, 'claude-code', 'Renamed 2.json'))
  await row('workspace.json').locator('.skill-delivered [role="switch"], .skill-delivered input, .skill-delivered button').first().click()
  check('the on/off switch keeps its state apart from the file', !!(await until(() => fs.existsSync(path.join(dialects, '.state.json')) && JSON.parse(fs.readFileSync(path.join(dialects, '.state.json'), 'utf8')).off.includes('workspace.json'), HUNG_MS)))
  await inv('dialects:setOn', 'workspace.json', true)

  // --- Delete: the user's own files only.
  check('Delete refuses the Workspace file, a CLI file and a shipped file', (await inv('dialects:delete', 'workspace.json'))?.refused === 'protected' && (await inv('dialects:delete', 'claude-code/cli.json'))?.refused === 'protected' && (await inv('dialects:delete', 'claude-code/Haiku 5.5.json'))?.refused === 'protected')

  // --- Import through its token: a model already claimed comes in as a test copy; a token can't be guessed.
  const forged = await inv('dialects:import', 'not-a-token', 'claude-code', 'Forged').catch((e) => ({ error: String(e) }))
  check('an import with a token this window was never given is refused', !!forged?.error && !fs.existsSync(path.join(dialects, 'claude-code', 'Forged.json')), JSON.stringify(forged))
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
  }, importFrom)
  const picked = await inv('dialects:pickImport')
  const imported = await inv('dialects:import', picked.token, 'claude-code', 'Imported')
  check('Import puts the picked file in the folder, as a test copy when its model is claimed', imported?.path === 'claude-code/Imported.json' && imported.testCopy === true && !('model' in JSON.parse(read('claude-code/Imported.json'))), JSON.stringify(imported))
  const again = await inv('dialects:import', picked.token, 'claude-code', 'Imported again').catch((e) => ({ error: String(e) }))
  check('…and its token is spent', !!again?.error, JSON.stringify(again))
  check('a file the user made can be deleted (to the Recycle Bin)', (await inv('dialects:delete', 'claude-code/Imported.json')) === null && !fs.existsSync(path.join(dialects, 'claude-code', 'Imported.json')))

  // --- Export writes the file as it is.
  const exportTo = path.join(lib.probeDir('dialectsview-export'), 'out.json')
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen })
  }, exportTo)
  const exported = await inv('dialects:export', TEST_COPY)
  check('Export writes the file as it is where chosen', exported === exportTo && fs.readFileSync(exportTo, 'utf8') === read(TEST_COPY))

  // --- "restart to apply" is the dialect's only: a skill-only edit doesn't blame the dialect.
  await inv('session:stop', proj, clara.id)
  await until(async () => !(await live(clara.id)), HUNG_MS)
  await inv('session:start', proj, { agentId: clara.id })
  await ready(clara.id)
  const usage = async () => (await inv('dialects:usage')).find((u) => u.agentId === clara.id)
  check('restarted, Clara no longer needs a restart for her dialect', !!(await until(async () => (await usage())?.moved === false, HUNG_MS)))
  const skill = path.join(ws, '.hive', 'skills', 'work-on-card', 'SKILL.md')
  fs.appendFileSync(skill, '\nA change.\n')
  const restartForSkill = !!(await until(async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === clara.id)?.restartNeeded, HUNG_MS))
  check('a skill-only edit asks her for a restart, but not for her dialect', restartForSkill && (await usage())?.moved === false)
  fs.writeFileSync(path.join(dialects, 'workspace.json'), file('Workspace', { [HOST]: 'WS-EDITED {hasProject, select, yes {{project}} other {}}.' }))
  check('…while a Workspace file edit moves her chain', !!(await until(async () => (await usage())?.moved === true, HUNG_MS)))

  // --- Agent Settings' Dialect: Auto, or a file of her CLI's folder.
  await command('view.projects')
  await page.getByText('alpha', { exact: true }).first().click()
  await command('agent.settings')
  const pick = page.locator('[data-agent-dialect]')
  check("Agent Settings shows her Dialect: Auto, and her CLI's model files and test copies", !!(await until(async () => (await pick.locator('option').count()) > 1, HUNG_MS)) && (await pick.locator('option').evaluateAll((os) => os.map((o) => o.value))).includes(TEST_COPY))
  await pick.selectOption(TEST_COPY)
  await shot('agent-settings', page.locator('.dialog').last())
  await page.locator('.dialog').last().locator('.btn.primary').click()
  check('…saving it picks the file', !!(await until(async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'alpha').agents.find((a) => a.id === clara.id)?.dialect === TEST_COPY, HUNG_MS)))

  await inv('session:stop', proj, clara.id).catch(() => undefined)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
