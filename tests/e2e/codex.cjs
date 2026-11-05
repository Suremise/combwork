// Combwork running a Codex agent end to end, against the permanent test CODEX_HOME (codex-home.cjs, signed in).
// One short prompt on gpt-6-luna at low effort. Nothing touches the real ~/.codex or Combwork profile.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { sessionsOf } = require('./storeDocs.cjs')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxhive-profile')
const ws = path.join(scratch, 'cxhive-ws')
const proj = path.join(ws, 'demo')
const codexHome = lib.CODEX_HOME
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

function prepare() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: proj, env: lib.gitEnv() })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: proj, env: lib.gitEnv() })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: proj, env: lib.gitEnv() })
  // The test Codex home trusts the project folder and has the non-admin sandbox set up (under its lock: lib.cjs).
  lib.trustForCodex(proj, codexHome)
  lib.enableProviders(userData, ['claude-code', 'codex'])
}

;(async () => {
  prepare()
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47892), CODEX_HOME: codexHome, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => results.push(`PAGEERROR ${e.message}`))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(500) } return null }

  const info = await waitFor(async () => { const i = (await inv('provider:info')).codex; return i && !i.checking ? i : null }, 30000)
  check('Codex found', !!info?.found, JSON.stringify(info))
  check('Codex signed in', info?.loggedIn === true, info?.authMethod)
  check('no readiness problems (sandbox set up in the test home)', !(info?.readiness ?? []).some((r) => r.level !== 'info'), JSON.stringify(info?.readiness))

  await lib.openWorkspace(inv, page, ws)
  const def = await lib.addAgent(inv, proj, { name: 'Codex', provider: 'codex', location: 'project', model: 'gpt-6-luna', effort: 'low' })
  check('agent added with provider codex', def.provider === 'codex')
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const live = async () => (await inv('session:live')).find((l) => l.agentId === def.id)
  await inv('session:start', proj, { agentId: def.id })
  const started = await live()
  check('starts without a session id (Codex picks it)', started?.provider === 'codex' && started?.sessionId === '', JSON.stringify(started && { p: started.provider, s: started.sessionId }))
  const ready = await waitFor(async () => { const l = await live(); return l?.status === 'ready' ? l : null }, 60000)
  check('ready once Codex shows its prompt', !!ready, JSON.stringify(await live()))
  check('starts in Approve for me', ready?.permissionMode === 'approve-for-me', ready?.permissionMode)
  await page.screenshot({ path: path.join(scratch, 'cxh-1-ready.png') })

  // One prompt: an edit with apply_patch. Codex answering it is the CLI's part (a usage limit or the network there is
  // the environment's, lib.cliStep), what Combwork makes of the turn is checked after it.
  const key = `session:${proj.toLowerCase()}#${def.id}`
  await lib.cliStep('the prompt’s turn', { session: key }, async () => {
    // Sent until Codex takes it (lib.sendPrompt): under the full set's load, an Enter right after the prompt can become a
    // new line in it, or the prompt be dropped while Codex is still drawing (#190). Finished counts too: a quick turn
    // can be over between two looks.
    const attempt = await lib.sendPrompt(inv, key, 'Use apply_patch to add a file notes.txt containing hi. Do nothing else.', { submitted: async () => ['working', 'background', 'finished'].includes((await live())?.status) })
    check('prompt makes it working', attempt > 0, (await live())?.status)
    if (attempt > 1) console.log(`(the prompt was taken at attempt ${attempt})`)
    const done = await waitFor(async () => ((await live())?.status === 'finished' ? true : null), 180000)
    check('turn finishes (Stop hook)', !!done, (await live())?.status)
    check('the patch was applied', fs.existsSync(path.join(proj, 'notes.txt')))
  })
  // Codex names the session with its first hook (the first prompt).
  const sessionId = (await live())?.sessionId
  check('the first hook binds the session id', /^[0-9a-f-]{36}$/.test(sessionId ?? ''), sessionId)
  const recs = sessionsOf(proj).sessions
  const rec = recs.find((r) => r.id === sessionId)
  check('session recorded as Codex with its transcript path', rec?.agent === 'codex' && /rollout-.*\.jsonl$/.test(rec?.transcriptPath ?? ''), JSON.stringify(rec))
  // The backup tick reads the transcript for live details.
  await lib.until(async () => (await live())?.modelName === 'gpt-6-luna', 30000)
  const after = await live()
  check('live details: model from the transcript', after?.modelName === 'gpt-6-luna', after?.modelName)
  const plan = (await inv('app:planUsage')).codex
  check('plan usage from the transcript', !!plan?.limits?.length && plan.plan, JSON.stringify(plan))
  await page.screenshot({ path: path.join(scratch, 'cxh-2-finished.png') })

  const list = await inv('session:list', proj)
  const item = list.find((s) => s.id === sessionId)
  check('Sessions list: Codex session with usage', item?.provider === 'codex' && item.usage?.requests > 0 && item.usage?.contextWindow > 0, JSON.stringify(item?.usage))
  const tx = await inv('transcript:read', proj, sessionId)
  const kinds = tx.items.map((i) => i.kind)
  check('transcript: prompt, edit and reply', kinds.includes('user') && tx.items.some((i) => i.kind === 'tool' && i.tool.name === 'Edit') && kinds.includes('assistant'), kinds.join(','))

  // Codex takes the keys for a mode change and then reports it: each step waits for the report (20 s bounds a hung CLI).
  await inv('session:setPlanMode', proj, def.id, true)
  check('Plan mode on', !!(await waitFor(async () => (await live())?.planMode === true, 20000)))
  await inv('session:setPlanMode', proj, def.id, false)
  await waitFor(async () => (await live())?.planMode === false, 20000)
  const r = await inv('session:setMode', proj, def.id, 'ask')
  check('switches preset with the /permissions menu', r.ok && !!(await waitFor(async () => (await live())?.permissionMode === 'ask', 20000)), JSON.stringify(r))
  await page.screenshot({ path: path.join(scratch, 'cxh-3-menu.png') })

  // Full Access live (#1014), as the menu does it after Combwork's own confirmation: Codex shows its own warning after the
  // pick, which the user answers in its terminal, and the switch waits for that answer. Answered "1. Yes, continue
  // anyway" (0.162.1 offers that and Cancel, neither of which changes the test home), the session switches in place: the
  // same Codex process and conversation, no restart. Its screens are kept for the advanced setting's recorded sample.
  await inv('settings:update', { providers: { codex: { enableDangerousMode: true } } })
  const before2 = await live()
  /** Codex's screen now, rendered from its terminal's output at its size (kept as cxh-fullaccess-<name>.txt). */
  const screenNow = async (name) => {
    const { Terminal } = require('@xterm/headless')
    const size = await inv('pty:size', key)
    const term = new Terminal({ cols: size?.cols ?? 120, rows: size?.rows ?? 40, allowProposedApi: true })
    const output = await inv('pty:buffer', key)
    await new Promise((res) => term.write(output, res))
    const b = term.buffer.active
    const lines = []
    for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
    term.dispose()
    const text = lines.join('\n')
    fs.writeFileSync(path.join(scratch, `cxh-fullaccess-${name}.txt`), text)
    return text
  }
  // The menu, as the user opens it from the footer's mode badge: Full access says what it does, not that it restarts.
  await page.locator('.pane-footer-bar .mode-badge').click()
  const fullItem = page.locator('.menu .menu-item', { hasText: /^Full access/ })
  await waitFor(async () => (await fullItem.count()) === 1, 10000)
  const fullText = await fullItem.innerText().catch(() => '')
  check("the mode menu: Full access with its own description, not 'Restarts the session'", /No sandbox and no approvals/.test(fullText) && !/Restarts the session/.test(fullText), fullText)
  await fullItem.click()
  // Combwork's own confirmation first, unchanged; no restart question after it.
  const useFull = page.getByRole('button', { name: 'Use Full access', exact: true })
  check("Combwork's confirmation comes first", !!(await waitFor(async () => (await useFull.count()) === 1, 10000)))
  await useFull.click()
  const warned = await waitFor(async () => /Enable full access\?/i.test(await screenNow('warning')), 20000)
  check("Codex shows its own Full Access warning, and Combwork's switch waits for the answer", !!warned && (await live())?.modeSwitching === 'full-access', JSON.stringify(await live().then((l) => l && { mode: l.permissionMode, switching: l.modeSwitching, status: l.status })))
  await page.screenshot({ path: path.join(scratch, 'cxh-5-fullaccess-warning.png') })
  // What Codex printed so far (before the answer), for whether it says the selection before or after it.
  fs.writeFileSync(path.join(scratch, 'cxh-fullaccess-before-answer.txt'), lib.plainText(await inv('pty:buffer', key)).slice(-4000))
  check('…and no restart question', (await page.getByText('Restart in Full access?').count()) === 0)
  await inv('pty:write', key, '1')
  check('…answered in the terminal, it switches to Full Access', !!(await waitFor(async () => { const l = await live(); return l?.permissionMode === 'full-access' && !l.modeSwitching }, 20000)), JSON.stringify(await live().then((l) => l && { mode: l.permissionMode, switching: l.modeSwitching })))
  const after2 = await live()
  check('…live: the same Codex process and conversation, no restart', after2?.runId === before2?.runId && after2?.pid === before2?.pid && after2?.sessionId === sessionId, JSON.stringify(after2 && { run: [before2?.runId, after2.runId], pid: [before2?.pid, after2.pid], s: after2.sessionId }))
  await screenNow('answered')
  fs.writeFileSync(path.join(scratch, 'cxh-fullaccess-after-answer.txt'), lib.plainText(await inv('pty:buffer', key)).slice(-4000))
  await page.screenshot({ path: path.join(scratch, 'cxh-6-fullaccess.png') })

  await inv('session:stop', proj, def.id)
  const stopped = await waitFor(async () => (!(await live()) ? true : null), 20000)
  check('stops', !!stopped)
  await sleep(1500) // A fixed wait on purpose: no condition Combwork exposes says Codex's process has fully exited before the same thread is resumed.
  await inv('session:start', proj, { agentId: def.id, resumeId: sessionId })
  const resumed = await waitFor(async () => { const l = await live(); return l?.status === 'ready' ? l : null }, 60000)
  check('resumes the same conversation', resumed?.sessionId === sessionId, JSON.stringify(resumed && { s: resumed.sessionId, st: resumed.status }))
  await page.screenshot({ path: path.join(scratch, 'cxh-4-resumed.png') })
  await inv('session:stop', proj, def.id)
  await waitFor(async () => (!(await live()) ? true : null), 20000)
  await app.close()
  console.log(results.join('\n'))
})().catch((e) => {
  console.error(e)
  console.log(results.join('\n'))
  process.exit(1)
})
