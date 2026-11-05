// Resume per agent: guard against one conversation in two agents, AgentInfo.resume, the Resume split
// button + session picker, the session tag, Sessions tab Show / Resume in.
// Throwaway profile and git project in the work folder. Agent 1 runs the fake Claude Code (fake-claude/, #194),
// which writes its transcript with its session id as Claude Code does; no prompt is ever sent. Clipboard untouched.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
const { putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
const scratch = lib.WORK, userData = path.join(scratch, 'resume-profile')
// Outside the repository, so its CLAUDE.md (which imports AGENTS.md) doesn't apply to the test session (#174).
const ws = path.join(scratch, 'resume-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
const proj = path.join(ws, 'demo')
fs.mkdirSync(proj, { recursive: true })
// Git in the test repository, waiting out the Combwork under test's own git (lib.git, #199).
const g = (cmd) => lib.git(proj, cmd)
g('init -q -b main'); g('config user.email test@example.com'); g('config user.name Test')
fs.writeFileSync(path.join(proj, 'README.md'), '# Demo\n'); g('add -A'); g('commit -q -m init')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
const shot = (page, n) => page.screenshot({ path: path.join(scratch, `resume-${n}.png`) })

;(async () => {
  const claude = lib.fakeClaude(userData, path.join(scratch, 'resume-claude-home'), [proj])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  const project = async () => (await inv('workspace:refresh')).projects.find((p) => p.name === 'demo')
  await inv('workspace:open', ws); await sleep(800)
  await inv('project:setActive', proj, true)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(500)

  // Old sessions: two of Agent 1's, none of Agent 2's.
  const A1 = await lib.addAgent(inv, proj)
  const A2 = await lib.addAgent(inv, proj)
  const old = (id, name, at, extra = {}) => ({ id, agent: 'claude-code', name, createdAt: at, lastActiveAt: at, archived: false, names: 2, ...extra })
  // In the workspace's database (#1061): Combwork has read the project's records.
  putSessions(proj, { version: 1, sessions: [old('11111111-0000-4000-8000-000000000001', 'Older work', '2026-09-20T10:00:00Z', { agentId: A1.id }), old('11111111-0000-4000-8000-000000000002', 'Tray fixes', '2026-09-25T10:00:00Z', { agentId: A1.id })] })
  // Combwork's backups of their transcripts: a session with no transcript anywhere can't be resumed.
  for (const [sid, at] of [['11111111-0000-4000-8000-000000000001', '2026-09-20T10:00:00Z'], ['11111111-0000-4000-8000-000000000002', '2026-09-25T10:00:00Z']]) {
    const b = path.join(proj, '.combwork', 'sessions', `${sid}.jsonl`)
    fs.mkdirSync(path.dirname(b), { recursive: true })
    fs.writeFileSync(b, JSON.stringify({ type: 'user', sessionId: sid, timestamp: at, message: { role: 'user', content: 'Earlier work' } }) + '\n')
  }
  let p = await project()
  const a1 = () => p.agents.find((a) => a.id === A1.id), a2 = () => p.agents.find((a) => a.id === A2.id)
  check('Agent 1 resume = its latest', a1().resume?.id === '11111111-0000-4000-8000-000000000002', JSON.stringify(a1().resume))
  check('Agent 2 has nothing of its own', a2().resume === null)

  // Two columns so both pane headers show.
  await inv('project:updateConfig', proj, { layout: 'columns2' })
  const h2 = page.locator('.pane-header-bar', { hasText: 'Agent 2' })
  // Nothing to resume: its header offers New Session in Stop's place (#977), and Resume is greyed out in its ⋯.
  const offers = await lib.until(async () => (await h2.locator('button[aria-label="New Session"]').count()) === 1 && (await h2.locator('button[aria-label="Resume"]').count()) === 0, HUNG_MS)
  check('Agent 2 offers New Session, no Resume', !!offers)
  /** Opens agent h's ⋯ and chooses Resume a Session… (#977: a header button before). */
  const pickFrom = async (h) => {
    await h.getByRole('button', { name: 'More', exact: true }).click()
    await page.locator('.menu .menu-item', { hasText: 'Resume a Session…' }).click()
  }

  // Start Agent 1 fresh (no prompt sent).
  const st = await inv('session:start', proj, { agentId: A1.id })
  await lib.acceptClaudeTrust(inv, proj, A1.id)
  await lib.until(async () => (await inv('session:live')).some((l) => l.agentId === A1.id && l.status !== 'starting'), 30000)
  p = await project()
  check('Agent 1 running', !!a1().live)

  // Guard: Agent 2 can't take the conversation Agent 1 has open.
  const err = await page.evaluate(([folder, id, a2id]) => window.combwork.invoke('session:start', folder, { resumeId: id, agentId: a2id }).then(() => 'started', (e) => String(e.message ?? e)), [proj, st.sessionId, A2.id])
  check('guard refuses a conversation open in another agent', /already open in Agent 1/.test(err), err)
  check('Agent 2 still stopped', !(await project()).agents.find((a) => a.id === A2.id).live)

  // The session's name in Agent 1's footer.
  const h1 = page.locator('.pane-header-bar', { hasText: 'Agent 1' })
  // Its session, in its ⋯ (#978: a footer icon before): Open in Sessions Tab, with the session's name as its detail.
  const sessionItem = page.locator('.menu .menu-item', { hasText: 'Open in Sessions Tab' })
  const openSessionItem = async () => {
    await h1.getByRole('button', { name: 'More', exact: true }).click()
    await lib.until(() => sessionItem.isVisible(), 5000)
  }
  await openSessionItem()
  check("its session is in its ⋯", (await sessionItem.count()) === 1)
  await page.keyboard.press('Escape')

  // Picker for Agent 2: Agent 1's open session greyed, old sessions resumable.
  await pickFrom(h2); await lib.until(async () => (await page.locator('.menu .menu-item.two-line').count()) > 0, 10000)
  const rows = page.locator('.menu .menu-item.two-line')
  const texts = await rows.allTextContents()
  check('picker lists 3 sessions', texts.length === 3, JSON.stringify(texts))
  check('open one is muted and names Agent 1', (await page.locator('.menu .menu-item.muted').count()) === 1 && /open in Agent 1/.test(texts.join('|')))
  check('old sessions say who ran them', texts.filter((t) => /last run by Agent 1/.test(t)).length === 2)
  await shot(page, '1-picker')
  // Clicking the open one shows Agent 1 instead of resuming.
  await page.locator('.menu .menu-item.muted').click(); await sleep(500)
  check('clicking the open one focuses Agent 1', await page.locator('.pane-header-bar.focused', { hasText: 'Agent 1' }).count() === 1)
  check('still only Agent 1 runs', (await project()).agents.filter((a) => a.live).length === 1)

  // Session tag → Sessions tab on that session, with Show instead of Resume.
  await openSessionItem(); await sessionItem.click(); await lib.until(async () => (await page.locator('.tabs .tab.active', { hasText: 'Sessions' }).count()) === 1 && (await page.locator('.session-row.selected').count()) === 1, 10000)
  check('Sessions tab opened', await page.locator('.tabs .tab.active', { hasText: 'Sessions' }).count() === 1)
  check('live session selected', await page.locator('.session-row.selected').count() === 1)
  check('Show button for the running session', await page.locator('.transcript-toolbar button', { hasText: 'Show' }).count() === 1)
  await shot(page, '2-sessions-live')
  // An old session: Resume goes to the free agent, ▾ offers both.
  await page.locator('.session-row', { hasText: 'Tray fixes' }).click(); await sleep(800)
  const resumeBtn = page.locator('.transcript-toolbar .split-btn button').first()
  check('Resume in Agent 2 (Agent 1 is busy)', /Resume in Agent 2/.test(await resumeBtn.textContent()), await resumeBtn.textContent())
  await page.locator('.transcript-toolbar .split-caret').click(); await sleep(400)
  const inTexts = await page.locator('.menu .menu-item').allTextContents()
  check('Resume in menu lists both agents', inTexts.length === 2 && /running/.test(inTexts[0]), JSON.stringify(inTexts))
  await shot(page, '3-resume-in')
  await page.keyboard.press('Escape')

  // The agent's ⋯: Resume (disabled: nothing of its own) and Resume a Session…
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click(); await sleep(500)
  await page.locator('.pane-header-bar', { hasText: 'Agent 2' }).click(); await sleep(300)
  await h2.getByRole('button', { name: 'More', exact: true }).click()
  check("Resume disabled in Agent 2's ⋯", await page.locator('.menu .menu-item', { hasText: /^\s*Resume\s*$/ }).evaluate((el) => el.classList.contains('disabled')).catch(() => false))
  await page.keyboard.press('Escape')
  await pickFrom(h2); await lib.until(async () => (await page.locator('.menu .menu-header').textContent().catch(() => '')) === 'Resume in Agent 2', 10000)
  check("the ⋯'s picker opens", (await page.locator('.menu .menu-header').textContent()) === 'Resume in Agent 2')
  await shot(page, '4-header')
  await page.keyboard.press('Escape')

  // Rename the live session: the ⋯'s detail follows.
  await inv('session:rename', proj, st.sessionId, 'Renamed live')
  const renamed = await lib.until(async () => {
    await openSessionItem()
    const d = await sessionItem.locator('.menu-detail').innerText().catch(() => '')
    await page.keyboard.press('Escape')
    return /Renamed live/.test(d)
  }, 5000)
  check('its detail follows rename', !!renamed)

  await inv('session:stop', proj, A1.id); await lib.until(async () => !(await inv('session:live')).some((l) => l.agentId === A1.id), 15000)
  p = await project()
  check('after stop Agent 1 resume is back', !!a1().resume, JSON.stringify(a1().resume))

  // Compressed backups (#1110): an ended session's backup as Combwork keeps it (compressing it is in backupCompression.test.ts).
  const zlib = require('zlib')
  const OLDER = '11111111-0000-4000-8000-000000000001'
  const plainB = path.join(proj, '.combwork', 'sessions', `${OLDER}.jsonl`), gzB = plainB + '.gz'
  const compressed = () => fs.existsSync(gzB) && !fs.existsSync(plainB)
  if (fs.existsSync(plainB)) {
    fs.writeFileSync(gzB, zlib.gzipSync(fs.readFileSync(plainB)))
    fs.rmSync(plainB)
  }
  check("an ended session's backup is compressed", compressed())
  const viewed = await inv('transcript:read', proj, OLDER)
  check('it is viewed from the compressed backup', !!viewed?.items.some((i) => i.kind === 'user' && /Earlier work/.test(i.text)), JSON.stringify(viewed?.items?.length))
  const found = await inv('transcript:search', proj, 'Earlier work', OLDER)
  check('it is searched', found.length > 0, JSON.stringify(found).slice(0, 200))
  // Export: the save dialog answered in main, to a test path.
  const out = path.join(scratch, 'resume-export.md')
  fs.rmSync(out, { force: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, out)
  const saved = await inv('transcript:export', proj, OLDER, 'Older work')
  check('it is exported', saved === out && /Earlier work/.test(fs.readFileSync(out, 'utf8')), String(saved))
  // The CLI has no transcript of it: a resume puts the backup back, decompressed, where the CLI looks.
  const cliCopy = () => {
    const dir = path.join(scratch, 'resume-claude-home', 'projects')
    for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const f = path.join(dir, d, `${OLDER}.jsonl`)
      if (fs.existsSync(f)) return f
    }
    return null
  }
  for (const round of [1, 2]) {
    check(`round ${round}: the CLI has no copy`, cliCopy() === null)
    await inv('session:start', proj, { resumeId: OLDER, agentId: A1.id })
    await lib.acceptClaudeTrust(inv, proj, A1.id)
    const up = await lib.until(async () => (await inv('session:live')).some((l) => l.agentId === A1.id && l.sessionId === OLDER && l.status !== 'starting'), 30000)
    check(`round ${round}: resumed from the compressed backup`, !!up)
    const restored = cliCopy()
    check(`round ${round}: restored where the CLI looks, decompressed`, !!restored && /Earlier work/.test(fs.readFileSync(restored, 'utf8')), String(restored))
    await inv('session:stop', proj, A1.id); await lib.until(async () => !(await inv('session:live')).some((l) => l.agentId === A1.id), 15000)
    // Ended: its backup (written plain while it ran) is compressed again, and still holds the conversation.
    const again = await lib.until(compressed, 15000)
    check(`round ${round}: compressed again at its end`, !!again && /Earlier work/.test(zlib.gunzipSync(fs.readFileSync(gzB)).toString('utf8')))
    // The CLI forgets it again (as Claude Code does after 30 days).
    fs.rmSync(restored, { force: true })
  }
  await app.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
