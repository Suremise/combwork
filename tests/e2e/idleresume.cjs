// Resuming a long-idle conversation (HI-3360): one idle past Settings → Advanced's threshold (an hour by default) has most
// likely lost the CLI's prompt cache. The window's Resume asks first, with its age and its size (tokens of context, or
// only its transcript's size, never called tokens), Archive and Start Fresh its default and Resume one click away; the
// Agent API (the Assistant's cw_start_agent) refuses such a resume, latest or named alike, with the same facts, until it
// is asked with resumeIdle; a Codex agent (no prompt-cache TTL of its own) is refused the same way. Throwaway profile and
// workspace, the fake Claude Code (fake-claude/) and fake Codex (fake-codex/), the Assistant on the fake Claude Code for
// its token; no prompt is typed. The fixture's records go into the workspace's database once Combwork has read the
// project, with Combwork's backup of the Claude transcript.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { putSessions } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const scratch = lib.WORK
const userData = path.join(scratch, 'idleresume-profile')
const ws = path.join(scratch, 'idleresume-ws')
const proj = path.join(ws, 'demo')
const PORT = lib.port(47602)
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.gitProject(proj)

const IDLE = '33600000-0000-4000-8000-000000000001' // Worker's (Claude Code), last active three days ago, 60K tokens
const CODEX = '33600000-0000-4000-8000-000000000002' // Coder's (Codex), last active three days ago, no transcript
const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000 - 3_600_000).toISOString()
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const shot = (page, n) => page.screenshot({ path: path.join(scratch, `idleresume-${n}.png`) })

/** Combwork's backup of a transcript: one exchange whose context is 60K tokens, at `at`. */
function backup(id, at) {
  const file = path.join(proj, '.combwork', 'sessions', `${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [
    { type: 'user', sessionId: id, timestamp: at, message: { role: 'user', content: 'Earlier work' } },
    { type: 'assistant', sessionId: id, requestId: `${id}-1`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 60000, cache_creation_input_tokens: 100, output_tokens: 50 } } }
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

;(async () => {
  const claude = lib.fakeClaude(userData, path.join(scratch, 'idleresume-claude-home'), [ws, proj])
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env: { ...claude, CW_API_PORT: PORT }, viewport: { width: 1400, height: 850 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  const worker = await lib.addAgent(inv, proj, { name: 'Worker' })
  const coder = await lib.addAgent(inv, proj, { name: 'Coder', provider: 'codex' })
  const rec = (id, agent, agentId, name, extra) => ({ id, agent, agentId, cwd: proj, name, createdAt: threeDaysAgo, lastActiveAt: threeDaysAgo, archived: false, names: 2, ...extra })
  putSessions(proj, { version: 1, sessions: [rec(IDLE, 'claude-code', worker.id, 'Idle work'), rec(CODEX, 'codex', coder.id, 'Idle Codex work')] })
  backup(IDLE, threeDaysAgo)

  // The Assistant's token (only it starts agents through the Agent API): its session on the fake Claude Code.
  const home = (await inv('workspace:refresh')).assistant.path
  const assistantLive = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status !== 'stopped')
  await inv('session:start', home, { agentId: 'assistant' })
  // Before any turn: the Assistant's launch reaching ready (or its trust question, answered), not a turn's end.
  await lib.until(async () => (['waiting', 'ready'].includes((await assistantLive())?.status) ? true : null), HUNG_MS, 200)
  if ((await assistantLive())?.status === 'waiting') await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
  await lib.until(async () => ((await assistantLive())?.status === 'ready' ? true : null), HUNG_MS, 200)
  const token = JSON.parse(fs.readFileSync(path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`), 'utf8')).token
  const api = (method, url, body) =>
    fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const live = async (agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === proj.toLowerCase() && s.agentId === agentId && s.status !== 'stopped')
  const stop = async (agentId) => {
    await inv('session:stop', proj, agentId)
    return !!(await lib.until(async () => !(await live(agentId)), HUNG_MS))
  }

  // 1. The list says which are long idle, with their age and their size as far as it is known.
  // Its tokens once the usage history has read its transcript (#1106: listed without figures until then).
  const idle = await lib.until(async () => {
    const i = (await inv('session:list', proj)).find((s) => s.id === IDLE)?.idle
    return i?.tokens ? i : null
  }, HUNG_MS)
  check("the Claude conversation is long idle: its last activity, and its context's tokens", !!idle && idle.since === threeDaysAgo && idle.tokens > 20000 && idle.idleMs > 3 * 86_400_000, JSON.stringify(idle))
  const codexIdle = (await inv('session:list', proj)).find((s) => s.id === CODEX)?.idle ?? null
  check('the Codex one too (no prompt-cache TTL of its own), no size known: never called tokens', !!codexIdle && codexIdle.tokens === null, JSON.stringify(codexIdle))

  // 2. The Agent API: refused, latest or named, with its age and size; resumeIdle resumes it.
  const latest = await api('POST', '/v1/projects/demo/agents/Worker/start', { resume: true })
  const said = String(latest.body?.error ?? latest.body?.message ?? JSON.stringify(latest.body))
  check('resume: true on it is refused (409)', latest.status === 409, `${latest.status} ${said}`)
  check('…saying how long it was idle, its context, that it is an estimate, and the two ways on', /last active 3 days|last active 7[0-9] h/.test(said) && /about \d+ tokens of context/.test(said) && /most likely/.test(said) && /resumeIdle: true/.test(said) && /Leave resume out/.test(said), said)
  const named = await api('POST', '/v1/projects/demo/agents/Worker/start', { resume: IDLE })
  check('naming the conversation is refused the same way', named.status === 409, `${named.status} ${JSON.stringify(named.body)}`)
  check('…and nothing started', !(await live(worker.id)))
  const codex = await api('POST', '/v1/projects/demo/agents/Coder/start', { resume: CODEX })
  const codexSaid = String(codex.body?.error ?? codex.body?.message ?? JSON.stringify(codex.body))
  check("a Codex agent's long-idle conversation is refused too, with no size claimed", codex.status === 409 && /last active/.test(codexSaid) && !/tokens of context/.test(codexSaid), `${codex.status} ${codexSaid}`)
  const anyway = await api('POST', '/v1/projects/demo/agents/Worker/start', { resume: true, resumeIdle: true })
  check('resumeIdle: true resumes it', anyway.status === 200, `${anyway.status} ${JSON.stringify(anyway.body)}`)
  const resumed = await lib.until(async () => ((await live(worker.id))?.sessionId ? await live(worker.id) : null), HUNG_MS)
  check('…in that same conversation', resumed?.sessionId === IDLE, resumed?.sessionId)
  check('stopped again', await stop(worker.id))

  // 3. The window: the Sessions tab's Resume asks first, with its age and size; Start Fresh is the default.
  await page.locator('.tabs .tab', { hasText: 'Sessions' }).first().click()
  const row = page.locator('.session-row', { hasText: 'Idle work' })
  check('the Sessions tab lists it', !!(await lib.until(async () => (await row.count()) === 1, HUNG_MS)))
  await row.click()
  const resumeBtn = page.locator('.transcript-toolbar button.act-resume').first()
  check('its Resume shows', !!(await lib.until(async () => (await resumeBtn.count()) === 1 && (await row.evaluate((el) => el.classList.contains('selected'))), HUNG_MS)))
  const dialog = page.locator('.dialog')
  await resumeBtn.click()
  const asked = await lib.until(async () => {
    const t = await dialog.innerText().catch(() => '')
    return /was last active/.test(t) ? t : null
  }, HUNG_MS)
  check('Resume asks first: last active 3 days ago, with about 60K tokens of context', /This session was last active 3 days ago, with about 6[\d.]+k tokens of context/i.test(asked ?? ''), asked ?? (await dialog.innerText().catch(() => '')))
  check('…as an estimate', /most likely lost its prompt cache/.test(asked ?? '') && /may process that context again/.test(asked ?? ''), asked ?? '')
  const buttons = await dialog.locator('.dialog-footer button').allInnerTexts()
  check('…Resume, then Archive and Start Fresh last (the default)', buttons.indexOf('Resume') >= 0 && buttons.indexOf('Archive and Start Fresh') === buttons.length - 1, JSON.stringify(buttons))
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  check('…and the default (focused) button is Archive and Start Fresh', focused === 'Archive and Start Fresh', focused)
  await shot(page, '1-question')
  await page.keyboard.press('Escape')
  check('Escape closes it, nothing started', !!(await lib.until(async () => (await dialog.count()) === 0, HUNG_MS)) && !(await live(worker.id)))

  // 4. Resume, one click away: that conversation resumes.
  await resumeBtn.click()
  await lib.until(async () => (await dialog.count()) === 1, HUNG_MS)
  await dialog.locator('.dialog-footer button', { hasText: /^Resume$/ }).click()
  const again = await lib.until(async () => ((await live(worker.id))?.sessionId ? await live(worker.id) : null), HUNG_MS)
  check('Resume resumes that conversation', again?.sessionId === IDLE, again?.sessionId)
  check('stopped again', await stop(worker.id))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
