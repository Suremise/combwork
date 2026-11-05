// Unsaved edits outside the Files tab (shared notes, MCP servers): kept when the view changes, a save won't
// silently overwrite a file changed on disk (an agent's edit), and quitting asks about them and saves them.
// Dev build, throwaway profile and workspace; no agents are started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'drafts-profile')
const ws = path.join(lib.WORK, 'drafts-ws')
const note = path.join(ws, '.combwork', 'shared', 'plan.md')
const server = path.join(ws, '.combwork', 'mcp', 'demo.json')
const sleep = lib.sleep
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const read = (f) => fs.readFileSync(f, 'utf8')
// The longest a check waits for its condition: a bound for a hung run, never how long the step should take.
const HUNG_MS = 10000

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47896) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.appReady(page)
  await page.evaluate((folder) => window.combwork.invoke('workspace:open', folder), ws)
  await sleep(800)
  fs.writeFileSync(note, '# Plan\n')
  fs.mkdirSync(path.dirname(server), { recursive: true })
  fs.writeFileSync(server, '{ "command": "node", "args": [] }\n')
  await page.evaluate(() => window.combwork.invoke('workspace:refresh'))

  const toolbar = page.locator('.split-main .editor-toolbar').first()
  const typeAtEnd = async (text) => {
    await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
    await lib.until(unsaved, HUNG_MS)
  }
  const unsaved = async () => (await toolbar.innerText()).includes('●')
  const dialogText = () => page.locator('.dialog').last().innerText({ timeout: 1000 }).catch(() => '')
  const openNote = async () => {
    await page.keyboard.press('Control+Shift+H')
    await sleep(600)
    await page.locator('.row', { hasText: 'plan.md' }).first().click()
    await lib.until(async () => ((await page.locator('.row', { hasText: 'plan.md' }).first().getAttribute('class')) ?? '').includes('selected'), 10000)
  }
  const openServer = async () => {
    await page.keyboard.press('Control+Shift+M')
    await sleep(600)
    await page.locator('.row', { hasText: 'demo' }).first().click()
    await lib.until(async () => ((await page.locator('.row', { hasText: 'demo' }).first().getAttribute('class')) ?? '').includes('selected'), 10000)
  }

  // A note's edits survive going to another view and back.
  await openNote()
  await toolbar.locator('button[aria-label="Edit"]').click()
  // The editor's lines are there once Monaco has loaded into it: typing before that is lost.
  await lib.until(async () => (await page.locator('.split-main .monaco .view-lines').count()) === 1, HUNG_MS)
  await typeAtEnd('DRAFT-1 ')
  await openServer()
  await openNote()
  check('note: unsaved edits kept after changing view', !!(await lib.until(async () => (await page.locator('.split-main .monaco').first().innerText({ timeout: 1000 }).catch(() => '')).includes('DRAFT-1'), HUNG_MS)))
  check('note: still marked unsaved', !!(await lib.until(unsaved, HUNG_MS)))

  // Changed on disk meanwhile (as an agent would): Save asks before overwriting, Cancel keeps the disk's version.
  fs.writeFileSync(note, '# Plan\nAGENT\n')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  const dlg = (await lib.until(async () => { const t = await dialogText(); return /changed on disk/.test(t) && t }, HUNG_MS)) || (await dialogText())
  check('note: save asks when the file changed on disk', /changed on disk/.test(dlg), dlg.slice(0, 120))
  await page.locator('.dialog .btn', { hasText: 'Cancel' }).last().click()
  // Once the dialog has gone, the cancelled save is over: the file must still be the agent's.
  await lib.until(async () => (await page.locator('.dialog').count()) === 0, HUNG_MS)
  check("note: cancelling keeps the agent's version", read(note) === '# Plan\nAGENT\n')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  await page.locator('.dialog .btn', { hasText: 'Overwrite' }).last().click()
  // Saved on disk, and then the editor knows it (its dot goes): the next edit must count as a new one.
  check('note: Overwrite saves my version', !!(await lib.until(async () => read(note).includes('DRAFT-1') && !(await unsaved()), HUNG_MS)))
  await typeAtEnd('DRAFT-2 ')

  // An MCP server saved without its final newline (Combwork adds one) saves again without a false conflict.
  await openServer()
  await page.locator('.split-main .monaco').first().click({ position: { x: 200, y: 10 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Backspace')
  check('mcp: removing the final newline is an edit', !!(await lib.until(unsaved, HUNG_MS)))
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  // The file is unchanged by this save (Combwork adds the newline back), so the dot going is what says it's done.
  check('mcp: saved with a final newline', !!(await lib.until(async () => !(await unsaved()), HUNG_MS)) && read(server) === '{ "command": "node", "args": [] }\n', JSON.stringify(read(server)))
  await typeAtEnd(' ')
  await toolbar.locator('.btn', { hasText: 'Save' }).click()
  // A false conflict would ask (a dialog) instead of writing the file, so the file being written rules it out.
  const savedAgain = () => read(server).trimEnd() === '{ "command": "node", "args": [] }' && read(server) !== '{ "command": "node", "args": [] }\n'
  check('mcp: saving again is no conflict', !!(await lib.until(savedAgain, HUNG_MS)) && (await page.locator('.dialog').count()) === 0, JSON.stringify(read(server)))

  // An MCP server's edits are kept the same way.
  await typeAtEnd(' ')
  await openNote()
  await openServer()
  check('mcp: unsaved edits kept after changing view', !!(await lib.until(unsaved, HUNG_MS)))

  // Quitting lists both and saves them.
  await page.evaluate(() => window.combwork.invoke('app:quit'))
  const quit = (await lib.until(async () => { const t = await dialogText(); return /plan\.md/.test(t) && /demo\.json/.test(t) && t }, HUNG_MS)) || (await dialogText())
  check('quit: lists the unsaved note and server', /plan\.md/.test(quit) && /demo\.json/.test(quit), quit.replace(/\s+/g, ' ').slice(0, 200))
  // Combwork's part (saving both, then app.quit) and the process's exit are waited for separately (#424): the limits only
  // bound a hang, since a loaded machine stretches both (#563).
  const quitting = await lib.quitWatch(app)
  const clicked = Date.now()
  await page.getByRole('button', { name: 'Save and quit' }).click()
  const quits = !!(await quitting.untilDecided(30000)) && (await quitting.gone(30000))
  check('quit: Combwork quits after saving', quits, quitting.timings(clicked))
  console.log(`quit: ${quitting.timings(clicked)}`)
  check('quit: the note was saved', read(note).includes('DRAFT-2'))
  check('quit: the server was saved', read(server) !== '{ "command": "node", "args": [] }\n' && !!JSON.parse(read(server)))
  // Combwork has quit (that was the test): Playwright may already have let go of it, so asking about it can throw.
  await app.close().catch(() => undefined)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
