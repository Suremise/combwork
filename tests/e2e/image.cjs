// Attachments (#387): image paste (Ctrl+V) and drag-and-drop of files into an agent's terminal: each one's path reaches
// the CLI's input line, a copy kept with the session; a chip per attachment over the terminal, labelled by what the CLI
// reads itself, dismissed by × and cleared by Enter; a large file asked about first; the Attachments tab's viewer, whose
// Delete waits for the session to stop (#258); and the ended-session bar. The agent runs the fake Claude Code (fake-claude/, #195),
// which shows what is typed as Claude Code does. Throwaway profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const scratch = lib.WORK
const userData = path.join(scratch, 'image-profile')
const ws = path.join(scratch, 'image-ws')
const shots = path.join(scratch, 'image-shots')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
for (const d of [userData, ws, shots]) fs.rmSync(d, { recursive: true, force: true })
fs.mkdirSync(path.join(ws, 'demo'), { recursive: true })
fs.mkdirSync(shots, { recursive: true })

;(async () => {
  const claude = lib.fakeClaude(userData, path.join(scratch, 'image-claude-home'), [path.join(ws, 'demo')])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claude })
  const app = await _electron.launch({
    executablePath: lib.ELECTRON,
    args: [lib.ROOT],
    cwd: lib.ROOT,
    env
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const proj = path.join(ws, 'demo')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  const agent = await lib.soloAgent(inv, proj)
  await inv('workspace:refresh')
  const st = await inv('session:start', proj, { agentId: agent.id })
  await lib.acceptClaudeTrust(inv, proj, agent.id)
  check('the session starts', !!(await lib.until(async () => (await inv('session:live')).some((l) => l.status === 'ready'), 30000)))
  const typed = async () => (await inv('pty:buffer', lib.ptyKey(proj, agent.id))).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  /** The attachments' paths on the CLI's input line: copies Hive keeps with the session (.combwork/attachments/<session>/…). */
  // A copy's name may have spaces (its own name after the time), when its path is quoted.
  const kept = async (ext = 'png') => [...new Set([...(await typed()).matchAll(new RegExp(`[\\\\/]\\.combwork[\\\\/]attachments[\\\\/][^"\\r\\n]+?\\.${ext}(?=["\\s]|$)`, 'gi'))].map((m) => m[0]))]
  const images = () => kept('png')
  /** The chips over the terminal: each attachment's name and label. */
  const chips = async () => (await page.locator('.attachment-chip').evaluateAll((els) => els.map((e) => `${e.querySelector('.attachment-chip-name')?.textContent} | ${e.querySelector('.attachment-chip-label')?.textContent}`)))

  // A fake clipboard holding a PNG, in the app only: the real clipboard is never read or written.
  const png = await page.screenshot({ path: path.join(shots, 'source.png'), clip: { x: 0, y: 0, width: 400, height: 200 } })
  await app.evaluate(async ({ clipboard }, b64) => {
    const bytes = Buffer.from(b64, 'base64')
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([bytes], { type: 'image/png' }) }]
  }, png.toString('base64'))
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => undefined } })
  })

  await page.locator('.terminal-host').first().click()
  await page.keyboard.press('Control+V')
  const pasted = (await lib.until(async () => (await images()).length >= 1, 10000)) ? (await images())[0] : null
  check("Ctrl+V: the pasted image's path reaches the CLI's input line", !!pasted, (await typed()).slice(-300))
  await page.screenshot({ path: path.join(shots, '1-ctrl-v.png') })

  // Drop real files: setInputFiles gives path-backed Files.
  await page.evaluate(() => {
    const i = document.createElement('input')
    i.type = 'file'
    i.id = '__drop'
    i.multiple = true
    i.style.display = 'none'
    document.body.appendChild(i)
  })
  const drop = async (...files) => {
    await page.setInputFiles('#__drop', files)
    await page.evaluate(() => {
      const dt = new DataTransfer()
      for (const f of document.getElementById('__drop').files) dt.items.add(f)
      const host = document.querySelector('.terminal-host')
      host.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
  }
  const dropSrc = path.join(scratch, 'drop me.png')
  fs.writeFileSync(dropSrc, png)
  await drop(dropSrc)
  check("a dropped image's path reaches it too (a copy kept with the session)", !!(await lib.until(async () => (await images()).length >= 2, 10000)), (await typed()).slice(-300))
  await page.screenshot({ path: path.join(shots, '2-drop.png') })

  const imgDir = path.join(proj, '.combwork', 'attachments', st.sessionId)
  const saved = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []
  const shown = (await images()).map((p) => path.basename(p))
  check('both are saved with the session, as the paths say', saved.length === 2 && shown.every((f) => saved.includes(f)) && pasted?.toLowerCase().includes(st.sessionId.toLowerCase()), JSON.stringify({ saved, shown }))
  check('a chip for each over the terminal, labelled Image', !!(await lib.until(async () => (await chips()).length === 2 && (await chips()).every((c) => c.endsWith(' | Image')), HUNG_MS)), JSON.stringify(await chips()))

  // Other kinds of file (#387): a PDF and a zip from outside the project are copied too and their paths pasted. The fake
  // is Claude Code, which reads PDFs itself: its chip says PDF; the zip's says it goes by path.
  const pdfSrc = path.join(scratch, 'q3 report.pdf')
  const zipSrc = path.join(scratch, 'logs.zip')
  // A real (if empty) page: an invalid PDF makes Chromium's viewer show its own error, whose button takes the keyboard.
  fs.writeFileSync(pdfSrc, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
  fs.writeFileSync(zipSrc, 'PK')
  await drop(pdfSrc, zipSrc)
  const pdfs = await lib.until(async () => ((await kept('pdf')).length === 1 && (await kept('zip')).length === 1 ? kept('pdf') : null), 10000)
  check("a dropped PDF's and zip's paths reach the input line, copies kept with the session", !!pdfs && pdfs[0].endsWith('_q3 report.pdf') && fs.readdirSync(imgDir).length === 4, (await typed()).slice(-400))
  check('their chips: PDF, and the zip by path', !!(await lib.until(async () => JSON.stringify((await chips()).slice(2)) === JSON.stringify(['q3 report.pdf | PDF', 'logs.zip | File · by path']), HUNG_MS)), JSON.stringify(await chips()))
  await page.screenshot({ path: path.join(shots, '2-chips.png') })
  // A chip's × dismisses it (its path stays in the prompt). By its name: Attach to a card (HI-1700) shares its class.
  await page.locator('.attachment-chip', { hasText: 'logs.zip' }).getByRole('button', { name: 'Dismiss logs.zip' }).click()
  check("× dismisses a chip", !!(await lib.until(async () => (await chips()).length === 3, HUNG_MS)), JSON.stringify(await chips()))

  // A large file is asked about first; cancelled, nothing is pasted or copied.
  const bigSrc = path.join(scratch, 'huge.log')
  fs.writeFileSync(bigSrc, Buffer.alloc(21 * 1024 * 1024, 0x61))
  await drop(bigSrc)
  const ask = page.locator('.dialog', { hasText: 'Attach a large file?' })
  check('a large file is asked about first', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(shots, '2-large.png') })
  await ask.locator('.dialog-footer button', { hasText: /^Cancel$/ }).click()
  await lib.until(async () => (await ask.count()) === 0, HUNG_MS)
  check('… and cancelled, it is neither pasted nor copied', !/huge\.log/.test(await typed()) && fs.readdirSync(imgDir).length === 4, (await typed()).slice(-300))

  // The Images tab's viewer (#258): Delete is greyed out, saying why, on the running session's images, not on a stopped
  // session's; moving between them changes it, and so does the session stopping.
  const pastDir = path.join(proj, '.combwork', 'attachments', '0b6e0000-0000-4000-8000-000000000258')
  fs.mkdirSync(pastDir, { recursive: true })
  const pastPng = path.join(pastDir, '2026-01-01T09-00-00.png')
  fs.writeFileSync(pastPng, lib.samplePng())
  fs.utimesSync(pastPng, new Date('2026-01-01T09:00:00Z'), new Date('2026-01-01T09:00:00Z'))
  const tab = (label) => page.locator('.tab', { has: page.locator('.tab-label', { hasText: new RegExp(`^${label}$`) }) })
  await tab('Attachments').click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 5, 10000)
  const viewerTitle = () => page.locator('.dialog[role="dialog"]').first().getAttribute('aria-label', { timeout: 2000 }).then((x) => x ?? '', () => '')
  const del = page.locator('.dialog-footer button', { hasText: /^\s*Delete$/ })
  await page.locator('.image-group', { has: page.locator('.badge', { hasText: 'Running' }) }).locator('.thumb').first().click()
  await lib.until(async () => (await page.locator('.image-viewer').count()) === 1, 5000)
  check("viewer: a running session's image can't be deleted", await del.isDisabled(), await viewerTitle())
  await del.hover({ force: true })
  const why = await lib.until(async () => (await page.locator('.tip', { hasText: 'Its session is running' }).count()) > 0, HUNG_MS)
  check('viewer: … and its Delete says why', !!why, await page.locator('.tip').allInnerTexts().then((x) => x.join(' | ')))
  await page.screenshot({ path: path.join(shots, '3-viewer-running.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await page.screenshot({ path: path.join(shots, '3-viewer-running-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await page.mouse.move(10, 10)
  for (let i = 0; i < 5 && !/2026-01-01T09-00-00/.test(await viewerTitle()); i++) await page.keyboard.press('ArrowRight')
  check("viewer: moving to a stopped session's image enables Delete", /2026-01-01T09-00-00/.test(await viewerTitle()) && (await del.isEnabled()), await viewerTitle())
  await page.keyboard.press('ArrowLeft')
  check('viewer: … and moving back disables it again', !!(await lib.until(() => del.isDisabled(), HUNG_MS)), await viewerTitle())
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.image-viewer').count()) === 0, HUNG_MS)
  await tab('Session').click()

  // Its ⋯ menu's Show Session's Attachments (HI-1841): the Attachments tab on Pane attachments at this running session's
  // files, its own session's, nothing started.
  const liveBefore = await inv('session:live')
  const sessionId = liveBefore.find((l) => l.agentId === agent.id)?.sessionId
  const entries = await lib.agentMenu(page, agent.name)
  check("the agent's menu offers Show Session's Attachments", entries.some((e) => e.startsWith("Show Session's Attachments")), JSON.stringify(entries))
  await page.locator('.menu .menu-item', { hasText: "Show Session's Attachments" }).click()
  const own = page.locator(`[role="tabpanel"][data-tab-panel="pane"] .image-group[data-session="${sessionId}"]`)
  check("…opens Pane attachments at its session's files", !!(await lib.until(async () => (await page.locator('.attachment-tabs [role="tab"][data-tab="pane"]').getAttribute('aria-selected')) === 'true' && (await own.isVisible()) && (await own.locator('.badge', { hasText: 'Running' }).count()) === 1, HUNG_MS)), String(sessionId))
  check('…starting nothing', JSON.stringify((await inv('session:live')).map((l) => l.sessionId)) === JSON.stringify(liveBefore.map((l) => l.sessionId)))
  await page.screenshot({ path: path.join(shots, '3-show-session-attachments.png') })
  await tab('Session').click()

  // Sending the prompt (Enter) clears its chips.
  check('the chips are still there before the prompt is sent', (await chips()).length === 3, JSON.stringify(await chips()))
  await page.locator('.terminal-host').first().click()
  await page.keyboard.press('Enter')
  check('Enter sends the prompt and clears its chips', !!(await lib.until(async () => (await chips()).length === 0, HUNG_MS)), JSON.stringify(await chips()))

  // Ended bar.
  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  check('the ended bar shows once it stops', !!(await lib.until(async () => (await page.locator('.session-ended').count()) === 1, 10000)))
  await page.screenshot({ path: path.join(shots, '4-ended.png') })

  // Its images can be deleted now it has stopped (the dialog is cancelled: nothing goes).
  await tab('Attachments').click()
  await lib.until(async () => (await page.locator('.thumb').count()) === 5, 10000)
  await page.locator('.thumb').first().click()
  await lib.until(async () => (await page.locator('.image-viewer').count()) === 1, 5000)
  check("viewer: once the session stops, its image's Delete is enabled", !!(await lib.until(() => del.isEnabled(), 5000)), await viewerTitle())
  await page.keyboard.press('Escape')
  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.stack ?? e)
  process.exit(1)
})
