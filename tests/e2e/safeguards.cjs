// When a CLI's safety classifier stops an agent's response (#606): a stop and a model switch after it (Claude Code's
// fallback, by itself) are noted on the agent (its pane's shield with the model it runs on now, Combwork's notice, a note on
// its Doing card, cw_agent_activity's safeguard field: names only, never what was stopped); and Claude Code's prompt
// about a stop after its turn's Stop (HB3's, 11 Oct) waits for the user saying why, with its last tool calls, stays
// waiting through the idle notice while it shows, and once answered is idle after the stop, ready for a nudge, taking a
// task again (HB3 showed "Claude needs your permission" for half an hour). Stops seconds apart each count; Performance
// counts them per agent and model, with a stop seen only on screen (its prompt, no transcript record) kept on the
// session's record, once with the record Claude Code writes when the prompt is answered "Switch automatically", and the
// same after a restart. The agent runs the fake Claude Code (fake-claude/: "safeguard", "fallback", "safeguardprompt",
// "safeguardpromptswitch"), so nothing signs in or spends tokens. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; notifications recorded, not shown.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'guard-profile')
const ws = path.join(lib.WORK, 'guard-ws')
const claudeHome = path.join(lib.WORK, 'guard-claude-home')
const notifyLog = path.join(lib.WORK, 'guard-notify.log')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47876))
const API = `http://127.0.0.1:${PORT}`
const IDLE_MESSAGE = 'Idle after a safeguard stop: give it a nudge'
let failed = 0
// What Performance counted before the restart, by model, and the agent's session.
let expected = null
let sessionId = null
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.agentApi = { enabled: true, port: Number(PORT), provideCombworkMcp: true, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // Claude Code's idle notification, half a second after each turn (and after the prompt is answered) instead of a minute.
  fs.writeFileSync(path.join(claudeHome, 'fake-idle-notify.txt'), '500')
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_QUIET: '1', CW_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
    const until = async (fn, ms) => {
      const t = Date.now()
      let v
      while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
      return v
    }
    const notices = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'notification')
    const hooksLog = path.join(userData, 'logs', 'hooks.log')
    const notifications = () => (fs.existsSync(hooksLog) ? fs.readFileSync(hooksLog, 'utf8').split('\n').filter((l) => / Notification /.test(l)).length : 0)
    // Giving agents tasks is the Assistant's: start it (also the fake) and use its token.
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await live(home, 'assistant'))?.status === 'waiting', HUNG_MS)
    await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    await until(async () => (await live(home, 'assistant'))?.status === 'ready', HUNG_MS)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const api = async (method, p, body) => {
      const res = await fetch(API + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }

    await page.getByText('alpha', { exact: true }).first().click()
    const added = await api('POST', '/v1/projects/alpha/agents', { name: 'Tester', prompt: 'work 1' })
    const id = added.body?.agent?.id
    check('the agent finishes its first task', !!(await until(async () => (await live(alpha, id))?.status === 'finished', HUNG_MS)), JSON.stringify(added.body))
    const card = await inv('tasks:create', { title: 'Probe the parser', project: 'alpha', agent: id, column: 'doing' })

    // A stop, and Claude Code switching to Opus 4.8 by itself after it.
    const given = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'edit notes.txt safeguard fallback' })
    check('it takes a task its safety classifier stops', given.status === 200, JSON.stringify(given.body))
    const switched = await until(async () => {
      const s = await live(alpha, id)
      return s?.safeguard?.switched?.to === 'claude-opus-4-8' && s
    }, HUNG_MS)
    const g = switched?.safeguard
    // The tool calls before it: its own, and its inbox read (#650: its task came by doorbell).
    check('the stop and the switch are noted, with the tool calls before it', g?.stops === 1 && g.switched.from === 'claude-fake' && g.model === 'claude-fake' && g.tools.filter((x) => x !== 'mcp__combwork__cw_inbox').join() === 'Edit,Bash' && g.tools.includes('mcp__combwork__cw_inbox'), JSON.stringify(g))
    const mark = await until(async () => {
      const t = await page.locator('.safeguard-mark').first().innerText().catch(() => '')
      return /4\.8/.test(t) && t
    }, HUNG_MS)
    check('its pane shows the model it runs on now', !!mark, String(mark))
    const seen = await until(async () => {
      const s = await live(alpha, id)
      return s?.safeguard && !s.safeguard.unseen && s
    }, HUNG_MS)
    check('its pane on screen counts as seen (out of the attention inbox)', !!seen, JSON.stringify(seen?.safeguard))
    const told = await until(() => notices().find((n) => /now runs on/.test(n.title ?? '')), HUNG_MS)
    check("Combwork's notice says so", !!told && /safety classifier stopped a response/.test(told.body ?? ''), JSON.stringify(notices()))
    const comment = await until(async () => {
      const c = await api('GET', `/v1/tasks/${card.number}/comments/latest`)
      return /now runs on/.test(JSON.stringify(c.body)) && c.body
    }, HUNG_MS)
    check('its Doing card gets a note from Combwork', !!comment && /"by":"Combwork"/.test(JSON.stringify(comment)), JSON.stringify(comment))
    const activity = await api('GET', '/v1/projects/alpha/agents/Tester/activity')
    const field = activity.body?.safeguard
    check('cw_agent_activity has the safeguard field', field?.switchedTo === 'claude-opus-4-8' && field.stops === 1 && field.toolsBefore?.includes('Bash'), JSON.stringify(field))
    check('with names only, never what was stopped', !/stopped by a safety classifier|echo probe/.test(JSON.stringify(field ?? {})))
    const finished = await until(async () => (await live(alpha, id))?.status === 'finished', HUNG_MS)
    check('it finishes that task', !!finished)

    // Two more stops in two short tasks, seconds apart: each is another stop, however close (by their identities).
    for (const n of [2, 3]) {
      const again = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'safeguard' })
      const noted = await until(async () => {
        const s = await live(alpha, id)
        return s?.status === 'finished' && s.safeguard?.stops === n && s
      }, HUNG_MS)
      check(`a stop seconds after the last is another (${n})`, again.status === 200 && !!noted, JSON.stringify([again.body, (await live(alpha, id))?.safeguard]))
    }
    // What Performance counts for the agent, by model (#606): the stops in its transcript, and those seen only on screen.
    const counted = async () => Object.fromEntries(((await inv('metrics:query', { scope: { kind: 'project', project: 'alpha' } })).safeguards ?? []).filter((r) => r.agent === 'Tester').map((r) => [r.model, r.stops]).sort(([x], [y]) => x.localeCompare(y)))
    const countedIs = async (want) => (await until(async () => JSON.stringify(await counted()) === JSON.stringify(want), HUNG_MS)) || false
    check('Performance counts the three, by model', await countedIs({ 'claude-fake': 1, 'claude-opus-4-8': 2 }), JSON.stringify(await counted()))

    // Claude Code's prompt about a stop, after its turn's Stop: waiting, saying why.
    const before = notifications()
    const asked = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'edit other.txt safeguardprompt' })
    check('it takes a task its CLI then asks about', asked.status === 200, JSON.stringify(asked.body))
    const waiting = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'waiting' && /safety classifier/.test(s.statusMessage ?? '') && s
    }, HUNG_MS)
    check('it waits on the prompt, saying why with its last tool calls', !!waiting && /last tool calls: .*Edit/.test(waiting.statusMessage) && waiting.safeguard?.prompt === true, JSON.stringify(waiting && { status: waiting.status, message: waiting.statusMessage, safeguard: waiting.safeguard }))
    const notified = await until(() => notices().find((n) => /needs your input/.test(n.title ?? '') && /safety classifier/.test(n.body ?? '')), HUNG_MS)
    check('the notification says why', !!notified, JSON.stringify(notices().slice(-3)))
    const pane = await until(async () => {
      const t = await page.locator('.pane-status').first().innerText().catch(() => '')
      return /safety classifier/.test(t) && t
    }, HUNG_MS)
    check('so does its pane', !!pane, String(pane))
    // Its prompt and the idle notification while the dialog still shows (no one has typed): it still waits.
    await until(() => notifications() >= before + 2, HUNG_MS)
    const still = await live(alpha, id)
    check('the idle notice while the prompt shows leaves it waiting', notifications() >= before + 2 && still?.status === 'waiting', `${notifications() - before} notifications · ${still?.status}`)

    // Answered in its terminal: no hook says so; the prompt gone from its screen does.
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    const idle = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'ready' && s
    }, HUNG_MS)
    check('once answered it is idle after the stop, ready for a nudge', idle?.statusMessage === IDLE_MESSAGE && idle.safeguard?.idle === true && !idle.safeguard.prompt && idle.runtime?.attention == null, JSON.stringify(idle && { status: idle.status, message: idle.statusMessage, safeguard: idle.safeguard, runtime: idle.runtime }))
    const nudge = await until(async () => {
      const t = await page.locator('.pane-status').first().innerText().catch(() => '')
      return /nudge/.test(t) && t
    }, HUNG_MS)
    check('its pane says so', !!nudge, String(nudge))
    const nudged = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'work 1' })
    check('and it takes a task', nudged.status === 200, JSON.stringify(nudged.body))
    const done = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'finished' && s
    }, HUNG_MS)
    check('which it finishes, no longer idle after the stop', !!done && !done.safeguard?.idle && done.safeguard?.stops === 4, JSON.stringify(done?.safeguard))
    // The stop its prompt showed left no transcript record (HB3's): Performance counts it from the session's record.
    check('Performance counts the stop seen only on screen', await countedIs({ 'claude-fake': 1, 'claude-opus-4-8': 3 }), JSON.stringify(await counted()))

    // A prompt answered "Switch automatically": Claude Code records the flagged request then, the same stop its prompt
    // showed, so it counts once; and the switch it made is noted.
    const switching = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'safeguardpromptswitch' })
    const asking = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'waiting' && s.safeguard?.prompt && s
    }, HUNG_MS)
    check('it waits on the next prompt', switching.status === 200 && !!asking, JSON.stringify((await live(alpha, id))?.safeguard))
    await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    const moved = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'ready' && s.safeguard?.switched?.to === 'claude-sonnet-5-5' && s
    }, HUNG_MS)
    check('answered, its switch is noted', !!moved && moved.safeguard.stops === 5, JSON.stringify((await live(alpha, id))?.safeguard))
    check('and Performance counts that stop once (prompt and record)', await countedIs({ 'claude-fake': 1, 'claude-opus-4-8': 4 }), JSON.stringify(await counted()))
    const record = sessionsOf(alpha).sessions.find((s) => s.agentId === id)
    const screenStops = record?.screenStops ?? []
    check('the session keeps both stops seen on screen, each with its turn', screenStops.length === 2 && screenStops.every((s) => s.turn) && screenStops[0].turn !== screenStops[1].turn, JSON.stringify(screenStops))

    // One more prompt, left waiting when Combwork quits: Claude Code records that stop while Combwork is down (below).
    const last = await api('POST', '/v1/projects/alpha/agents/Tester/prompt', { text: 'safeguardprompt' })
    const left = await until(async () => {
      const s = await live(alpha, id)
      return s?.status === 'waiting' && s.safeguard?.prompt && s
    }, HUNG_MS)
    check('it waits on a last prompt', last.status === 200 && !!left, JSON.stringify((await live(alpha, id))?.safeguard))
    check('which Performance counts', await countedIs({ 'claude-fake': 1, 'claude-opus-4-8': 4, 'claude-sonnet-5-5': 1 }), JSON.stringify(await counted()))
    sessionId = left?.sessionId
    expected = await counted()
  } finally {
    await app.close()
  }

  // While Combwork is down, Claude Code records the stop its last prompt showed (answered "Switch automatically" then): in
  // the same turn of its transcript, so it is that stop, not another, though Combwork never saw the two together.
  const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(dir, e.name)) : e.name === `${sessionId}.jsonl` ? [path.join(dir, e.name)] : []))
  const transcript = sessionId ? find(path.join(claudeHome, 'projects'))[0] : undefined
  check('its transcript is found', !!transcript, String(sessionId))
  if (transcript) fs.appendFileSync(transcript, JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback', direction: 'retry', scope: 'session', content: "Opus 5.5's safeguards flagged this message. Switched to Opus 4.8.", level: 'warning', trigger: 'refusal', originalModel: 'claude-sonnet-5-5', fallbackModel: 'claude-opus-4-8', requestId: 'req_while_down', apiRefusalCategory: 'cyber', isMeta: false, timestamp: new Date().toISOString(), uuid: 'record-while-down', sessionId }) + '\n')

  // After a restart, Performance counts the same: the stops seen only on screen are kept on the session's record, and the
  // one recorded while Combwork was down is matched to its prompt by their turn (#606 round 3).
  const again = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await again.firstWindow()
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const counted = async () => Object.fromEntries(((await inv('metrics:query', { scope: { kind: 'project', project: 'alpha' } })).safeguards ?? []).filter((r) => r.agent === 'Tester').map((r) => [r.model, r.stops]).sort(([x], [y]) => x.localeCompare(y)))
    const same = await lib.until(async () => JSON.stringify(await counted()) === JSON.stringify(expected), HUNG_MS)
    check('after a restart Performance counts the same', Object.keys(expected ?? {}).length > 0 && !!same, JSON.stringify([expected, await counted()]))
  } finally {
    await again.close()
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
