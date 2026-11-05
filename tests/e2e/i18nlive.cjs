// A change of language while the window is open (#795): the command palette, already open, relabels its rows without
// a keystroke, and Settings → Keyboard Shortcuts keeps its clashes by command, not by label: a language change gives
// no command a clash with itself, and two commands whose names translate alike still show a real clash. A stopped
// session's transcript, open, shows Combwork's own notices in the new language at once, with its file unchanged (#797).
// Project Settings opened in another language shows its sections (the list, the heading and its description) and its
// rows in it, and follows a change of language while it is open (#793, E1's catalogue in lane C's view). A connection's
// dialog names its permission modes in it, their values the ids, and a running agent's mode menu says what a mode does
// in it (#861; modes are a connection's since HI-2107). An agent whose sign-in expired says how to sign in with its
// provider's message in the window's language (#847). A card on
// the Task Board, drawn only when what it shows changes, follows a change of language with the card unchanged (HI-1806). The
// window is sent language-changed as main sends it, with a small catalogue of test translations. Throwaway profile and
// workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

// A stopped session of a project, as Combwork keeps its backup (compressed, #1110): a prompt, then the user interrupting it.
const ws = path.join(lib.WORK, 'i18nlive-ws')
const proj = path.join(ws, 'demo')
const SESSION = '33333333-aaaa-bbbb-cccc-000000000003' // synthetic
const transcript = path.join(proj, '.combwork', 'sessions', `${SESSION}.jsonl.gz`)
fs.rmSync(ws, { recursive: true, force: true })
fs.mkdirSync(path.dirname(transcript), { recursive: true })
fs.writeFileSync(
  transcript,
  require('zlib').gzipSync(
    [
      { type: 'user', timestamp: '2026-10-14T10:00:00.000Z', message: { role: 'user', content: 'Translate the transcript viewer' } },
      { type: 'user', timestamp: '2026-10-14T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  )
)
fs.writeFileSync(path.join(proj, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: SESSION, agent: 'claude-code', name: 'Interrupted', createdAt: '2026-10-14T10:00:00.000Z', lastActiveAt: '2026-10-14T10:01:00.000Z', archived: false }] }))

const HUNG_MS = 15000
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(ok ? 'PASS' : 'FAIL', name, extra)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData: path.join(lib.WORK, 'i18nlive-profile') })
  try {
    const command = (id, ...args) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args })
    const base = (await inv('app:info')).language
    /** The window shown in a test language, as main sends a change of language. */
    const speak = (code, messages) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language: { ...base, code, locale: code, messages } })

    // The palette, open, in English.
    await command('palette.show')
    const paletteRow = page.locator('.palette .palette-item[data-command="palette.show"]')
    check('the palette lists the command in English', !!(await lib.until(async () => /Show All Commands/.test(await paletteRow.innerText().catch(() => '')), HUNG_MS)))
    // Another language while it is open: the row follows, nothing typed.
    await speak('de', { 'shell.command.palette.show': 'Alle Befehle zeigen', 'shell.category.view': 'Ansicht' })
    check('the open palette relabels its rows in the new language', !!(await lib.until(async () => (await paletteRow.innerText().catch(() => '')).includes('Ansicht: Alle Befehle zeigen'), HUNG_MS)), await paletteRow.innerText().catch(() => ''))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.palette').count()) === 0, HUNG_MS)

    // Settings → Keyboard Shortcuts, back in English.
    await speak('en', {})
    await command('settings.keybindings')
    const row = (id) => page.locator('.kb-table tbody tr', { has: page.locator('.kb-id', { hasText: new RegExp(`^${id.replace('.', '\\.')}$`) }) })
    const warnings = (id) => row(id).locator('.kb-warn').count()
    check('the editor lists the commands', !!(await lib.until(async () => (await row('palette.show').count()) === 1, HUNG_MS)))
    check('no clash for Show All Commands to start with', (await warnings('palette.show')) === 0)
    // A change of language: the clashes, kept by command, don't change.
    await speak('de', { 'shell.command.palette.show': 'Alle Befehle zeigen' })
    check('its row is relabelled', !!(await lib.until(async () => (await row('palette.show').innerText()).includes('Alle Befehle zeigen'), HUNG_MS)))
    check('…and gives it no clash with itself', (await warnings('palette.show')) === 0)

    // Two commands named alike in a language, sharing a shortcut: a real clash, still shown.
    await speak('de', { 'shell.command.palette.show': 'Gleich', 'shell.command.project.goto': 'Gleich' })
    await inv('settings:setKeybinding', 'project.goto', 'Mod+Shift+P')
    check('two commands with the same name and shortcut both show the clash', !!(await lib.until(async () => (await warnings('palette.show')) === 1 && (await warnings('project.goto')) === 1, HUNG_MS)), JSON.stringify([await warnings('palette.show'), await warnings('project.goto')]))
    await inv('settings:setKeybinding', 'project.goto', null)
    check('and none once the shortcut is taken off again', !!(await lib.until(async () => (await warnings('palette.show')) === 0, HUNG_MS)))

    // A stopped session's transcript, open in English: its notice is Combwork's own.
    await speak('en', {})
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('demo', { exact: true }).first().click()
    await page.locator('.tab', { hasText: 'Sessions' }).click()
    await lib.until(async () => (await page.locator('.session-row').count()) > 0, HUNG_MS)
    await page.locator('.session-row').first().click()
    const notice = page.locator('.tx-notice')
    check('the open transcript shows its notice in English', !!(await lib.until(async () => (await notice.innerText().catch(() => '')).includes('Interrupted by you'), HUNG_MS)), await notice.innerText().catch(() => ''))
    const before = fs.statSync(transcript)
    // Another language, nothing written to the transcript: the notice follows at once, reopening nothing.
    await speak('de', { 'providers.transcript.interrupted': 'Von dir unterbrochen' })
    check('the notice follows the language at once', !!(await lib.until(async () => (await notice.innerText().catch(() => '')).includes('Von dir unterbrochen'), HUNG_MS)), await notice.innerText().catch(() => ''))
    const after = fs.statSync(transcript)
    check('…with the transcript file unchanged', after.size === before.size && after.mtimeMs === before.mtimeMs)
    check('…and the same prompt above it, the view not reloaded empty', (await page.locator('.tx-user').count()) === 1)

    // Project Settings, opened while the window shows German: its section and rows in it.
    await speak('de', {
      'settings.projectSection.general.label': 'Allgemein',
      'settings.projectSection.general.desc': 'Der Schlüssel des Projekts und der Anbieter seiner neuen Agenten.',
      'settings.project.key.title': 'Projektschlüssel'
    })
    await command('project.tab.settings')
    const navLabel = page.locator('.settings-nav .row.selected .label')
    const heading = page.locator('.settings-content .settings-group h2').first()
    const about = page.locator('.settings-content .settings-group > p').first()
    const content = page.locator('.settings-content')
    const shows = (want) => lib.until(async () => {
      const got = [await navLabel.innerText().catch(() => ''), await heading.innerText().catch(() => ''), await about.innerText().catch(() => ''), await content.innerText().catch(() => '')]
      return got[0] === want.label && got[1] === want.label && got[2] === want.desc && got[3].includes(want.row)
    }, HUNG_MS)
    const seen = async () => JSON.stringify([await navLabel.innerText().catch(() => ''), await heading.innerText().catch(() => ''), await about.innerText().catch(() => '')])
    check('Project Settings opened in German shows its section (list, heading, description) and its rows in German', !!(await shows({ label: 'Allgemein', desc: 'Der Schlüssel des Projekts und der Anbieter seiner neuen Agenten.', row: 'Projektschlüssel' })), await seen())
    // English while it is open: all of it follows at once.
    await speak('en', {})
    check('…and follows a change of language while it is open', !!(await shows({ label: 'General', desc: 'The project’s key, which names its cards, and the provider its new agents use.', row: 'Project key' })), await seen())

    // A Claude Code connection's permission mode (#861; a connection's since HI-2107, in Settings → Accounts &
    // Connections): its choices named in the window's language, the CLI default's naming the mode it is, following a
    // change while the dialog is open; the choices' values stay the modes' ids. A test copy on its CLI test home lists no
    // account (that home isn't shown in Settings), so one is added for it, never signed in; Settings lists the accounts of
    // the CLIs turned on, so Claude Code is turned on.
    const DE_MODES = { 'agents.claude.auto': 'Automatisch', 'agents.claude.autoDescription': 'Ein Klassifikator genehmigt risikoarme Aktionen selbst.', 'agents.claude.manual': 'Manuell' }
    await speak('de', DE_MODES)
    await inv('settings:update', { providers: { 'claude-code': { enabled: true, checkUpdatesOnLaunch: false } } })
    const account = (await inv('connections:list')).connections.find((a) => a.provider === 'claude-code') ?? (await inv('connections:add', 'claude-code', 'Modes in two languages'))
    await command('settings.accounts')
    const connectionRow = page.locator(`[data-connections-of="${account.id}"] [data-connection]`).first()
    check("Settings → Accounts & Connections lists the account's connection", !!(await lib.until(async () => (await connectionRow.count()) === 1, HUNG_MS)))
    await connectionRow.locator('[data-action="connection-menu"]').click({ timeout: HUNG_MS })
    await page.locator('.menu .menu-item', { hasText: 'Edit…' }).first().click({ timeout: HUNG_MS })
    const form = page.locator('[data-connection-form]')
    const modeSelect = form.locator('select[data-mode]')
    const modes = async () => ({ options: await modeSelect.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent.trim()])).catch(() => []) })
    const modesIn = (want) => lib.until(async () => {
      const m = await modes()
      const label = Object.fromEntries(m.options)
      return label.manual === want.manual && label.auto === want.auto && label['']?.includes(want.auto) ? m : null
    }, HUNG_MS)
    const inGerman = await modesIn({ manual: 'Manuell', auto: 'Automatisch' })
    check("a connection's dialog names its permission modes, and the CLI default's, in German", !!inGerman, JSON.stringify(await modes()))
    await speak('en', {})
    const inEnglish = await modesIn({ manual: 'Manual', auto: 'Auto' })
    check('…and follows a change of language while it is open', !!inEnglish, JSON.stringify(await modes()))
    const ids = (m) => JSON.stringify(m?.options.map(([v]) => v))
    check('…its choices keep the modes’ ids', !!inGerman && ids(inGerman) === ids(inEnglish) && inEnglish.options.some(([v]) => v === 'manual') && inEnglish.options.some(([v]) => v === 'auto'), `${ids(inGerman)} ${ids(inEnglish)}`)
    await page.locator('.dialog').last().getByRole('button', { name: 'Cancel' }).click()
    await form.waitFor({ state: 'detached', timeout: HUNG_MS })

    // An agent whose sign-in expired (#847): its tab's hover says how to sign in with the provider's own message in the
    // window's language, not its English, and in English again after a change of language. Its state is sent as main
    // sends it (no CLI runs); sent again while it is hovered, in case a refresh of the workspace replaced it.
    const signer = await lib.addAgent(inv, proj, { name: 'Signer' })
    await command('project.tab.session')
    // Its name on its pane's header, whose hover says what the strip's tab did (#975).
    const tab = lib.paneHeader(page, 'Signer').locator('.agent-name')
    await lib.until(async () => (await tab.count()) === 1, HUNG_MS)
    const signedOut = { provider: 'claude-code', runId: 'i18nlive-signin', projectPath: proj, agentId: signer.id, agentName: 'Signer', cwd: proj, sessionId: '', status: 'signin', runtime: { lifecycle: 'signin', maintenance: null, attention: null, composer: 'free' }, startedAt: new Date().toISOString(), launchSignature: '', unseen: false, signIn: { message: 'Login expired · Please run /login', since: new Date().toISOString() } }
    const tipSays = (want) =>
      lib.until(async () => {
        await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'session-status', state: signedOut })
        const tip = await lib.hoverTip(page, tab, (t) => t.includes(want), 3000)
        return tip.includes(want) && tip
      }, HUNG_MS)
    const help = 'Tippe /login in das Terminal eines seiner Agenten oder nutze Hilfe → Agent-Einrichtung → Claude Code → Anmelden.'
    await speak('de', { 'agents.claude.signInHelp': help })
    check("an agent that needs sign-in: its hover says how to sign in in the window's language", !!(await tipSays(help)))
    await speak('en', {})
    check('…and in English after a change of language', !!(await tipSays('Type /login in one of its agents’ terminals')))

    // Running in Manual, its mode menu (#861: where a mode's description is shown since HI-2107) says what Auto does in
    // the window's language, following a change while the menu is open. Sent as main sends it, again until the badge
    // shows it running, in case a refresh replaced it.
    const running = { ...signedOut, runId: 'i18nlive-running', status: 'ready', runtime: { lifecycle: 'running', maintenance: null, attention: null, composer: 'free' }, permissionMode: 'manual', signIn: undefined }
    const badge = page.locator('.agent-pane').filter({ has: page.locator('.pane-header-bar .agent-name', { hasText: /^Signer$/ }) }).locator('.pane-footer-bar .mode-badge')
    const menuText = async () => (await page.locator('.menu .menu-item').allInnerTexts().catch(() => [])).join(' | ')
    await speak('de', DE_MODES)
    const opened = await lib.until(async () => {
      await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'session-status', state: running })
      if (!(await badge.evaluate((b) => b.classList.contains('live')).catch(() => false))) return false
      if (!(await page.locator('.menu').count())) await badge.click().catch(() => undefined)
      return (await menuText()).includes(DE_MODES['agents.claude.autoDescription'])
    }, HUNG_MS)
    check("a running agent's mode menu says what Auto does in German", !!opened, await menuText())
    await speak('en', {})
    check('…and follows a change of language while it is open', !!(await lib.until(async () => (await menuText()).includes('A safety classifier approves low-risk actions itself and only asks about risky ones.'), HUNG_MS)), await menuText())
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)

    // A closed row in the Progress panel's Runs tab (#1309), drawn only when its run changes (#1108), follows a change
    // of language with nothing clicked and its run unchanged: a script's run, ended.
    const api = await inv('api:info')
    const call = (method, p, body) => fetch(`${api.url}${p}`, { method, headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json())
    const done = await call('POST', '/v1/progress', { title: 'i18n build' })
    await call('POST', `/v1/progress/${done.id}/finish`, { ok: true })
    if (!(await page.locator('.progress-panel').count())) await page.locator('.progress-rail').click()
    await page.locator('.progress-panel .progress-tab[data-tab="runs"]').click()
    // Who ran it, the first part of its line (HI-1701), in Other (a run for no card), opened: closed once its runs passed.
    const recentRow = page.locator(`.progress-panel .progress-recent-item[data-run="${done.id}"] .progress-recent-who`)
    const openOther = page.locator('.progress-panel .progress-card-runs[data-card-runs="other"] .progress-card-toggle[aria-expanded="false"]')
    check('the ended run is in the Runs tab, by a script', !!(await lib.until(async () => {
      if (await openOther.count()) await openOther.click().catch(() => undefined)
      return (await recentRow.innerText().catch(() => '')).startsWith('Script')
    }, 30000)), await recentRow.innerText().catch(() => ''))
    await speak('de', { 'board.progress.script': 'Skript' })
    check('…its closed row follows a change of language', !!(await lib.until(async () => (await recentRow.innerText().catch(() => '')).startsWith('Skript'), HUNG_MS)), await recentRow.innerText().catch(() => ''))
    await speak('en', {})
    check('…and back', !!(await lib.until(async () => (await recentRow.innerText().catch(() => '')).startsWith('Script'), HUNG_MS)))

    // A card on the Task Board, drawn only when what it shows changes (HI-1806), follows a change of language with the
    // card itself unchanged: its fold button's name.
    await inv('tasks:create', { title: 'A card in two languages', project: 'demo' })
    await page.getByRole('button', { name: 'Task Board', exact: true }).first().click()
    const fold = page.locator('.board .task-card').filter({ hasText: 'A card in two languages' }).locator('.task-fold')
    const foldName = () => fold.first().evaluate((b) => b.getAttribute('aria-label') ?? b.getAttribute('title') ?? '').catch(() => '')
    check('a card on the board says its fold in English', !!(await lib.until(async () => /^Collapse .* to one line$/.test(await foldName()), HUNG_MS)), await foldName())
    await speak('de', { 'board.card.collapse': '{card} auf eine Zeile zuklappen' })
    check('…and follows a change of language, the card unchanged', !!(await lib.until(async () => (await foldName()).endsWith('auf eine Zeile zuklappen'), HUNG_MS)), await foldName())
    await speak('en', {})
    check('…and back', !!(await lib.until(async () => /^Collapse .* to one line$/.test(await foldName()), HUNG_MS)))
  } catch (e) {
    check('the suite ran', false, String(e?.stack ?? e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
