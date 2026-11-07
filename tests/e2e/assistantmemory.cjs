// The Assistant's own memory (HI-2666): Memory in the Assistant view lists what its coding agent saved for the workspace's
// folder, from a fake memory folder in the suite's own Claude Code home (never the user's): MEMORY.md first, its folder's
// path with Copy Path and Open Folder (HI-2736: main opens that folder, Explorer stubbed), a file opened in the project Memory tab's editor and saved through the same guarded file:read and
// file:write. With its files gone, it says there is no memory yet; with the Assistant set to a coding agent whose memory
// Combwork doesn't show (Codex), it says so, and nothing of the old list stays. Screenshots in both themes. Nothing runs.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR, quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'assistantmemory-profile')
const ws = path.join(lib.WORK, 'assistantmemory-ws')
const claudeHome = path.join(lib.WORK, 'assistantmemory-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'api'), { recursive: true })
  // Claude Code's folder for the workspace's own (where the Assistant's sessions run): its name as Claude Code makes it.
  const memDir = path.join(claudeHome, 'projects', fs.realpathSync(ws).replace(/[^a-zA-Z0-9]/g, '-'), 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [Release cadence](release-cadence.md) — the user ships on Fridays\n')
  fs.writeFileSync(path.join(memDir, 'release-cadence.md'), '---\nname: release-cadence\n---\n\nThe user ships on Fridays.\n')
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47931), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const { until } = lib
  const view = page.locator('.assistant-memory')
  const rows = () => view.locator('.split-list .row .label').allInnerTexts()

  // --- The Assistant view: its Memory section, after Attachments.
  await page.locator('.activity-btn[aria-label="Assistant"]').click()
  await until(async () => (await page.locator('.assistant-summary').count()) > 0, HUNG_MS)
  const sections = (await page.locator('.sidebar .section-header').allTextContents()).map((t) => t.replace(/\d+$/, '').trim())
  check('the Assistant view has a Memory section, last', sections.at(-1) === 'Memory', JSON.stringify(sections))
  await page.locator('.sidebar .row[data-section="memory"]').click()
  check('Its Memory lists MEMORY.md first, then the fact', !!(await until(async () => JSON.stringify(await rows()) === JSON.stringify(['MEMORY.md', 'release-cadence.md']), HUNG_MS)), JSON.stringify(await rows()))
  // Its text as written (the header draws it in capitals).
  const heading = await view.locator('.pane-header').first().textContent()
  check("…under a heading naming it the Assistant's, for this workspace", /The Assistant's Memory · This Workspace/.test(heading ?? ''), heading ?? '')
  const shown = await view.locator('.assistant-memory-folder').getAttribute('data-folder')
  check('its folder is the one in the suite’s Claude Code home, for the workspace’s folder', (shown ?? '').toLowerCase() === memDir.toLowerCase(), `${shown} vs ${memDir}`)
  // Copy Path: the folder's path on the clipboard.
  await view.getByRole('button', { name: 'Copy Path' }).click()
  const clip = await until(async () => {
    const t = await app.evaluate(({ clipboard }) => clipboard.readText())
    return t && t.toLowerCase() === memDir.toLowerCase() ? t : null
  }, HUNG_MS)
  check('Copy Path copies it', !!clip)
  // Open Folder (HI-2736): main opens the folder it names itself; Explorer stubbed, so no window opens.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openPath = async (p) => (globalThis.__opened.push(p), '')
  })
  await view.getByRole('button', { name: 'Open Folder' }).click()
  const opened = await until(async () => {
    const o = await app.evaluate(() => globalThis.__opened)
    return o.length ? o : null
  }, HUNG_MS)
  check('Open Folder opens that folder, and only it', !!opened && opened.length === 1 && opened[0].toLowerCase() === memDir.toLowerCase(), JSON.stringify(opened))
  check('…with no error shown', (await page.locator('.toast.error').count()) === 0)
  // Explorer failing: its error is shown, not dropped.
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => 'Failed to open path'
  })
  await view.getByRole('button', { name: 'Open Folder' }).click()
  check('a failed open shows its error', !!(await until(async () => (await page.locator('.toast.error', { hasText: 'Failed to open path' }).count()) > 0, HUNG_MS)))

  // --- MEMORY.md, opened first, in the Memory tab's editor (read through the guarded file:read).
  const editor = view.locator('.split-main')
  const text = async () => (await editor.innerText().catch(() => '')).replace(/ /g, ' ')
  check('MEMORY.md opens with its text', !!(await until(async () => /ships on Fridays/.test(await text()), HUNG_MS)), await text())
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, 5000)
    await page.screenshot({ path: path.join(lib.WORK, `assistantmemory-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  // The fact, edited and saved (the guarded file:write).
  await view.locator('.split-list .row', { hasText: 'release-cadence.md' }).click()
  await until(async () => /The user ships on Fridays\./.test(await text()), HUNG_MS)
  const fact = path.join(memDir, 'release-cadence.md')
  // Markdown opens in its preview: Edit, as in a project's Memory tab.
  await editor.getByRole('button', { name: 'Edit' }).click()
  await editor.locator('.monaco-editor .view-lines').first().click({ timeout: HUNG_MS })
  await page.keyboard.press('Control+End')
  await page.keyboard.type('And tags the release on Thursdays.')
  await editor.locator('.editor-toolbar button.primary').first().click()
  check('an edit saved writes the file', !!(await until(() => /And tags the release on Thursdays\./.test(fs.readFileSync(fact, 'utf8')), HUNG_MS)), fs.readFileSync(fact, 'utf8'))

  // --- No memory yet: its files gone, Refresh says so (the folder still named).
  for (const f of fs.readdirSync(memDir)) fs.rmSync(path.join(memDir, f))
  await view.getByRole('button', { name: 'Refresh' }).click()
  check('with no files: "No memory yet", the folder still named', !!(await until(async () => (await view.locator('.assistant-memory-empty').count()) === 1 && (await rows()).length === 0, HUNG_MS)), await view.innerText())
  check('…and nothing left open', /Choose a file on the left/.test(await view.innerText()))

  // --- The Assistant set to Codex for its next session (none running): its memory isn't shown here, and nothing of
  // Claude Code's list stays.
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- kept\n')
  await view.getByRole('button', { name: 'Refresh' }).click()
  await until(async () => JSON.stringify(await rows()) === JSON.stringify(['MEMORY.md']), HUNG_MS)
  // As the Assistant panel's provider choice saves it: its agent's own provider, in its home.
  await inv('agents:update', path.join(ws, '.combwork', 'assistant'), 'assistant', { provider: 'codex' })
  await inv('workspace:refresh')
  const unsupported = await until(async () => (await view.locator('.assistant-memory-unsupported').count()) === 1, HUNG_MS)
  check("on Codex: the view says it shows saved memory for Claude Code only, Codex's isn't shown here", !!unsupported && /shows saved memory for Claude Code only: Codex's, if it keeps any, isn't shown here/.test(await view.innerText()), await view.innerText())
  check('…with no list, folder or file open from Claude Code’s', (await rows()).length === 0 && (await view.locator('.assistant-memory-folder').count()) === 0 && /Choose a file on the left/.test(await view.innerText()))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantmemory-codex-dark.png') })

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
