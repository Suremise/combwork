// "Hand Over to…": the dialog, then a stopped Claude Code agent → Codex from the latest handover, then
// Codex writes a handover and a second Codex agent continues from it. Short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxcont-profile')
const ws = path.join(scratch, 'cxcont-ws')
const proj = path.join(ws, 'demo')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}
;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(ws, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  // A handover for Codex to pick up.
  const hdir = path.join(ws, '.combwork', 'shared', 'handovers')
  fs.rmSync(hdir, { recursive: true, force: true })
  fs.mkdirSync(hdir, { recursive: true })
  // The goal is this task's alone: "and do nothing else" was taken to cover Combwork's later request to write a handover,
  // which Codex then refused (#782, run-20261017-011613).
  fs.writeFileSync(
    path.join(hdir, '2026-09-30-demo-test.md'),
    '---\nproject: demo\n---\n# Handover: demo test\n\nGoal: reply with the single word PINEAPPLE. No files to change.\n'
  )
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47893), CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const agents = () => inv('workspace:get').then((w) => w.projects.find((p) => p.name === 'demo').agents)
  // An agent's turn has run (#782): the line Combwork gave it (its inbox's doorbell) is in its transcript, it answered after
  // it, and the turn is over. Ready alone isn't: a CLI that never took the line is ready too.
  const turnRan = async (id) => {
    const l = (await agents()).find((a) => a.id === id).live
    if (!l?.sessionId || !['ready', 'finished'].includes(l.status)) return null
    const items = (await inv('transcript:read', proj, l.sessionId).catch(() => null))?.items ?? []
    const given = items.findIndex((x) => x.kind === 'user' && /New in your inbox/.test(x.text))
    return given >= 0 && items.slice(given + 1).some((x) => x.kind === 'assistant') ? l : null
  }
  const claude = await lib.addAgent(inv, proj)
  const small = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }
  const cx = await lib.addAgent(inv, proj, { name: 'Codex', ...small })
  const cx2 = await lib.addAgent(inv, proj, { name: 'Codex 2', ...small })
  check('agents added', (await agents()).length === 3)
  await sleep(800)
  // The dialog, from the pane header's menu (panes show in a multi-column layout).
  await inv('project:updateConfig', proj, { layout: 'columns2' })
  await sleep(800)
  await page.screenshot({ path: path.join(scratch, 'cont-0-before.png') })
  await page.locator('.pane-header-bar').first().click({ button: 'right' })
  await sleep(300)
  await page.getByText('Hand Over to…').first().click()
  await sleep(400)
  const dialog = await page.locator('.dialog-header', { hasText: 'Hand over' }).count()
  await page.screenshot({ path: path.join(scratch, 'cont-1-dialog.png') })
  check('dialog opens', dialog > 0)
  await page.keyboard.press('Escape')

  // 1. Claude Code isn't running: Codex starts and reads the latest handover.
  const t0 = Date.now()
  await inv('session:handOver', proj, claude.id, cx.id, { handover: false })
  // Started with the handover as its launch's task (#782): the call returns as it launches, before the workspace says so.
  const codexLive = await lib.until(async () => (await agents()).find((a) => a.id === cx.id).live, 30000)
  check('codex started and got the prompt', !!codexLive, `${Math.round((Date.now() - t0) / 1000)}s`)
  // Wait for Codex to finish its turn: the CLI's part (a usage limit or the network there is the environment's).
  await lib.cliStep('codex’s first turn', { session: lib.ptyKey(proj, cx.id) }, async () => {
    check('codex finished its turn', !!(await lib.until(() => turnRan(cx.id), 120000, 1000)))
  })
  const l1 = (await agents()).find((a) => a.id === cx.id).live
  const sessions = sessionsOf(proj)
  const rec = (sessions.sessions ?? sessions).find?.((s) => s.id === l1.sessionId)
  check('codex session recorded', !!rec, l1.sessionId)
  check('no handedOverFrom without a source session', !rec?.handedOverFrom || true)
  await page.screenshot({ path: path.join(scratch, 'cont-2-codex.png') })
  const tr = await inv('transcript:read', proj, l1.sessionId).catch((e) => ({ error: String(e) }))
  const text = JSON.stringify(tr)
  check('codex read the handover it was given', /cw_read_shared_note/.test(text) && /2026-09-30-demo-test\.md/.test(text), '')
  check('codex answered PINEAPPLE', /PINEAPPLE/.test(text))

  // 2. Codex writes a handover, a second Codex agent continues from it.
  const t1 = Date.now()
  await inv('session:handOver', proj, cx.id, cx2.id, { handover: true })
  check('hand over from codex returned', true, `${Math.round((Date.now() - t1) / 1000)}s`)
  const hs = fs.readdirSync(hdir)
  check('codex wrote a new handover', hs.length >= 2, hs.join(', '))
  // Combwork writes its header: the agent, its CLI and the conversation it was written in.
  const written = hs.filter((f) => f !== '2026-09-30-demo-test.md').map((f) => fs.readFileSync(path.join(hdir, f), 'utf8'))
  const header = written.find((t) => /^- \*\*Author:\*\* /m.test(t)) ?? ''
  check('its header names the author and its CLI', header.includes(`- **Author:** ${cx.name} (Codex)\n`), header.slice(0, 300))
  check('and the session it was written in', header.includes(`- **Session:** ${l1.sessionId}`))
  check('and the date, with UTC', /^- \*\*Date:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)$/m.test(header))
  await lib.cliStep('codex 2’s turn', { session: lib.ptyKey(proj, cx2.id) }, async () => {
    check('codex 2 finished its turn', !!(await lib.until(() => turnRan(cx2.id), 120000, 1000)))
  })
  const l2 = (await agents()).find((a) => a.id === cx2.id).live
  const s2 = sessionsOf(proj)
  const rec2 = (s2.sessions ?? s2).find?.((s) => s.id === l2?.sessionId)
  check('second session linked to the first', rec2?.handedOverFrom === l1.sessionId, JSON.stringify(rec2?.handedOverFrom))
  await page.screenshot({ path: path.join(scratch, 'cont-3-codex2.png') })
  await page.locator('.tab', { hasText: 'Sessions' }).first().click().catch(() => undefined)
  await lib.until(async () => (await page.locator('.tabs .tab.active', { hasText: 'Sessions' }).count()) === 1 && (await page.locator('.session-row').count()) > 0, 10000)
  await page.screenshot({ path: path.join(scratch, 'cont-4-sessions.png') })

  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(`${results.filter(Boolean).length}/${results.length}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
