// Codex: /compact, image paste (fake clipboard in the app only) and the "Ask me" file lock.
// Test CODEX_HOME (codex-home.cjs), throwaway profile, the scratch workspace. A few short prompts on a small model.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const http = require('http')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxextra-profile')
const ws = path.join(scratch, 'cxextra-ws')
const proj = path.join(ws, 'demo')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}
const post = (url, token, body) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let t = ''
      res.on('data', (d) => (t += d))
      res.on('end', () => resolve({ status: res.statusCode, body: t }))
    })
    req.on('error', reject)
    req.end(data)
  })
;(async () => {
  fs.rmSync(ws, { recursive: true, force: true })
  lib.gitProject(proj, { 'notes.txt': 'hi\n' })
  lib.trustForCodex(proj)
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47894), CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  const page = await app.firstWindow()
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await inv('project:updateConfig', proj, { layout: 'columns2' })
  await lib.setOwnOptions(inv, proj, { fileLocks: 'ask' })
  await page.getByText('demo', { exact: true }).first().click()
  await sleep(500)
  const agents = () => inv('workspace:get').then((w) => w.projects.find((p) => p.name === 'demo').agents)
  for (const name of ['Codex', 'Codex 2']) await lib.addAgent(inv, proj, { name, provider: 'codex', model: 'gpt-6-luna', effort: 'low' })
  const codex = (await agents()).filter((a) => a.provider === 'codex')
  const [a1, a2] = codex
  check('two codex agents', codex.length >= 2)
  const live = async (id) => (await agents()).find((a) => a.id === id).live
  const waitFor = async (id, test, ms) => {
    const t = Date.now()
    for (;;) {
      const l = await live(id)
      if (test(l)) return l
      if (Date.now() - t > ms) return l
      await sleep(700)
    }
  }
  const text = async (id) => (await inv('pty:buffer', `session:${proj.toLowerCase()}#${id}`).catch(() => '')).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ')

  // --- Compact
  await inv('session:start', proj, { agentId: a1.id })
  await waitFor(a1.id, (l) => l?.status === 'ready', 60000)
  await inv('project:updateConfig', proj, { allowSessionInput: true }).catch(() => undefined)
  await lib.until(async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === proj.toLowerCase())?.config.allowSessionInput === true, 10000)
  // A first turn, so there is something to compact.
  const key1 = `session:${proj.toLowerCase()}#${a1.id}`
  // Codex answering is the CLI's part (a usage limit or the network there is the environment's: lib.cliStep).
  let l = await lib.cliStep('the first turn', { session: key1 }, async () => {
    // Sent until Codex takes it (lib.sendPrompt): an Enter taken as part of a paste left it in the input, and the
    // /compact after it was added to it.
    await lib.sendPrompt(inv, key1, 'Reply with the single word READY.', { submitted: async () => ['working', 'finished'].includes((await live(a1.id))?.status) })
    const turn = await waitFor(a1.id, (x) => x?.sessionId && x.status === 'finished', 90000)
    check('first turn finished', turn?.status === 'finished', turn?.status)
    return turn
  })
  const before = await inv('session:usage', proj, l.sessionId).catch(() => null)
  await inv('session:compact', proj, undefined, a1.id)
  const sawCompacting = await waitFor(a1.id, (x) => /Compacting/i.test(x?.statusMessage ?? ''), 10000)
  check('status shows Compacting', /Compacting/i.test(sawCompacting?.statusMessage ?? ''), sawCompacting?.statusMessage)
  l = await waitFor(a1.id, (x) => !/Compacting/i.test(x?.statusMessage ?? '') && (x?.status === 'ready' || x?.status === 'finished'), 180000)
  check('compaction ends', !/Compacting/i.test(l?.statusMessage ?? ''), `${l?.status} ${l?.statusMessage ?? ''}`)
  await lib.until(async () => ((await inv('session:usage', proj, l.sessionId).catch(() => null))?.compactions?.length ?? 0) > (before?.compactions?.length ?? 0), 15000)
  const after = await inv('session:usage', proj, l.sessionId).catch(() => null)
  check('usage records the compaction', (after?.compactions?.length ?? 0) > (before?.compactions?.length ?? 0), JSON.stringify(after?.compactions))
  await page.screenshot({ path: path.join(scratch, 'cxe-1-compact.png') })

  // --- Image paste: a fake clipboard in the app; the real one is never touched.
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 120 } })
  await app.evaluate(async ({ clipboard }, b64) => {
    const bytes = Buffer.from(b64, 'base64')
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([bytes], { type: 'image/png' }) }]
  }, png.toString('base64'))
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => undefined } }))
  // The first Codex agent's pane is the left-hand column.
  await page.mouse.click(600, 650)
  await sleep(300)
  await page.keyboard.press('Control+V')
  await lib.until(async () => { const d = path.join(proj, '.combwork', 'attachments', l.sessionId); return fs.existsSync(d) && fs.readdirSync(d).length > 0 && /\[Image|image #|\.png/i.test((await text(a1.id)).slice(-600)) }, 15000) // the pasted image saved, and shown by Codex
  const t1 = await text(a1.id)
  const imgDir = path.join(proj, '.combwork', 'attachments', l.sessionId)
  const saved = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []
  check('image saved under the session', saved.length > 0, saved.join(','))
  check('Codex shows the pasted image', /\[Image|image #|\.png/i.test(t1.slice(-600)), t1.slice(-300))
  await page.screenshot({ path: path.join(scratch, 'cxe-2-image.png') })
  await inv('pty:write', key1, '\x15')
  await sleep(500)

  // --- "Ask me" lock: agent 2 holds notes.txt (a claim made through the hook server), agent 1 edits it.
  await inv('session:start', proj, { agentId: a2.id })
  const l2 = await waitFor(a2.id, (x) => x?.status === 'ready', 60000)
  // The token isn't in the log (Combwork hides it): read it from agent 2's Codex command line.
  const hook = lib.codexHook(l2.runId)
  const m = hook ? [null, hook.token, hook.url] : null
  check('hook url and token found', !!m)
  const claim = await post(`${m[2]}?run=${l2.runId}`, m[1], {
    hook_event_name: 'PreToolUse',
    session_id: l2.sessionId || 'pending',
    cwd: proj,
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: notes.txt\n@@\n+claimed\n*** End Patch' }
  })
  check('agent 2 claims notes.txt', claim.status === 200, `${claim.status} ${claim.body}`)
  await sleep(800)
  const held = (await live(a2.id))?.lockedFiles ?? []
  check('lock shows on agent 2', held.some((f) => /notes\.txt$/i.test(f)), JSON.stringify(held))
  const asking = page.locator('.toast', { hasText: 'wants to edit notes.txt' })
  const notes = () => fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8')
  // A turn of agent 1's: typed until Codex takes it (its status moves on: lib.sendPrompt), then until Combwork asks, the
  // file changes or the turn ends. Waiting on the status alone returned at once with the last turn's "finished" (#201).
  const turn = async (prompt) => {
    const since = (await live(a1.id))?.statusSince
    await lib.sendPrompt(inv, key1, prompt, { submitted: async () => (await live(a1.id))?.statusSince !== since })
    await lib.until(async () => (await asking.count()) > 0 || /from agent 1/.test(notes()) || ['finished', 'waiting'].includes((await live(a1.id))?.status), 120000, 300)
    return live(a1.id)
  }
  let w
  // Combwork asks only once Codex tries the edit. The small test model sometimes answers without trying (once it replied
  // READY again, from the turn before the compaction): then it is asked again, more firmly, up to twice. Codex
  // answering is the CLI's part (lib.cliStep); Combwork holding the edit back and asking is Combwork's.
  await lib.cliStep('the locked edit', { session: key1 }, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      w = await turn(attempt ? 'Edit notes.txt now: call the apply_patch tool to append the line "from agent 1". Do not answer in text.' : 'Use apply_patch to add the line "from agent 1" at the end of notes.txt. Do nothing else.')
      if (await lib.until(async () => (await asking.count()) > 0, 5000)) break
      if (/from agent 1/.test(notes())) break
      console.log(`Codex didn't try the edit (attempt ${attempt + 1}): asking again`)
      await waitFor(a1.id, (x) => x?.status === 'finished' || x?.status === 'waiting', 60000)
    }
    await page.screenshot({ path: path.join(scratch, 'cxe-3-lock-ask.png') })
    check('the locked edit is held back', !/from agent 1/.test(notes()), `${w?.status}`)
    // Exactly Allow (HI-2386): the entry's own text is a button too (it opens the agent), and says "Allow Codex to edit it too?".
    check('Combwork asks with an Allow button', (await asking.getByRole('button', { name: 'Allow', exact: true }).count()) > 0)
  })
  const notes0 = notes()
  // Allow as soon as Combwork asks, as a user does: usually while Codex is still replying to the refusal, so Combwork's
  // go-ahead waits for that turn's end (#201); after it, the go-ahead goes at once.
  console.log(`Allow clicked while agent 1 is ${(await live(a1.id))?.status}`)
  await asking.getByRole('button', { name: 'Allow', exact: true }).first().click().catch(() => undefined)
  // The edit is Codex's retry. Waiting for the edit itself: a working-then-finished wait could see the blocked turn's end.
  await lib.cliStep('the edit after Allow', { session: key1 }, async () => {
    const edited = await lib.until(async () => /from agent 1/.test(notes()), 180000, 1000)
    check('after Allow, Codex makes the edit', edited, `${(await live(a1.id))?.status}`)
  })
  console.log('TERMINAL TAIL:', (await text(a1.id)).slice(-400))
  await page.screenshot({ path: path.join(scratch, 'cxe-4-allowed.png') })
  fs.writeFileSync(path.join(proj, 'notes.txt'), notes0)

  // --- The same lock when Codex runs apply_patch as a shell command (HI-2408: Codex 0.166 applies it as an edit; its
  // PreToolUse is Bash). Agent 2 claims shell.txt; agent 1 is asked to edit it that way, which is held back and asked about.
  fs.writeFileSync(path.join(proj, 'shell.txt'), 'hi\n')
  const shellClaim = await post(`${m[2]}?run=${l2.runId}`, m[1], {
    hook_event_name: 'PreToolUse',
    session_id: l2.sessionId || 'pending',
    cwd: proj,
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: shell.txt\n@@\n+claimed\n*** End Patch' }
  })
  check('agent 2 claims shell.txt', shellClaim.status === 200, `${shellClaim.status} ${shellClaim.body}`)
  await lib.until(async () => ((await live(a2.id))?.lockedFiles ?? []).some((f) => /shell\.txt$/i.test(f)), 10000)
  const askingShell = page.locator('.toast', { hasText: 'wants to edit shell.txt' })
  const shellText = () => fs.readFileSync(path.join(proj, 'shell.txt'), 'utf8')
  const shellPrompt = 'Run exactly this command with your exec_command tool (shell "bash"), not the apply_patch tool, and do nothing else: apply_patch <<\'PATCH\' then the lines *** Begin Patch / *** Update File: shell.txt / @@ / " hi" / +from agent 1 / *** End Patch, each on its own line, then PATCH.'
  await lib.cliStep('the locked shell edit', { session: key1 }, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const since = (await live(a1.id))?.statusSince
      await lib.sendPrompt(inv, key1, shellPrompt, { submitted: async () => (await live(a1.id))?.statusSince !== since })
      await lib.until(async () => (await askingShell.count()) > 0 || /from agent 1/.test(shellText()) || ['finished', 'waiting'].includes((await live(a1.id))?.status), 120000, 300)
      if (await lib.until(async () => (await askingShell.count()) > 0, 5000)) break
      if (/from agent 1/.test(shellText())) break
      console.log(`Codex didn't try the shell edit (attempt ${attempt + 1}): asking again`)
      await waitFor(a1.id, (x) => x?.status === 'finished' || x?.status === 'waiting', 60000)
    }
    check('the locked shell edit is held back', !/from agent 1/.test(shellText()), shellText())
    check('Combwork asks about the shell edit with an Allow button', (await askingShell.getByRole('button', { name: 'Allow', exact: true }).count()) > 0)
  })
  // Decline: Esc interrupts.
  await inv('pty:write', key1, '\x1b')
  await lib.until(async () => ['ready', 'finished'].includes((await inv('session:live')).find((x) => x.agentId === a1.id)?.status), 15000) // the interrupt landed

  await inv('session:stop', proj)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(`${results.filter(Boolean).length}/${results.length}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
