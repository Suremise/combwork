// A follow-up submitted in Review (HI-1832): on HI-1772 a reviewer's asked-for commit could only reach review by a
// failed round, or by the reviewer moving the card to Doing, which gave it to the reviewer and ended both watches. A fake
// Claude Code builder (B1) and its lane's reviewer (E1, fake Claude Code), the Assistant off, in the project folder:
// - B1 builds the card and submits it; E1 starts its review, leased copy-1 at that revision;
// - B1 commits the change E1 asked for and submits it with cw_submit followUp (the real hive MCP server): the card stays
//   in Review and B1's, in the same round, its history "Follow-up submitted for review at <commit>", the new revision
//   pinned, B1 watching it again, and E1 woken (no column move) saying to start its review again;
// - E1's start review again takes the follow-up: copy-1 is reset to it (the earlier lease returned), and its pass there
//   moves the card on; a verdict on the earlier submission is refused;
// - E1's own move of a card in Review back to Doing leaves it B1's (no "Given to E1").
// Dev build (or HIVE_EXE), throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const PORT = Number(lib.port(47795))
const at = (x) => path.join(lib.WORK, `followupsubmit-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const gitIn = (dir, ...a) => execFileSync('git', a, { cwd: dir, env: lib.gitEnv(), encoding: 'utf8' }).trim()
const lines = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 850 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project' } })
    await inv('project:updateConfig', alpha, { copies: { size: 1 } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const e1 = await lib.addAgent(inv, alpha, { name: 'E1', workflowRole: 'either' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const ready = (id) =>
      until(async () => {
        const s = await live(id)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    for (const a of [b1, e1]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await ready(b1.id)) && !!(await ready(e1.id)))

    const launchOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      return until(() => lines(path.join(claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
    }
    const tokenOf = async (id) => {
      const hive = JSON.parse(fs.readFileSync((await launchOf(id)).opts['--mcp-config'], 'utf8')).mcpServers.combwork
      return JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const tb1 = await tokenOf(b1.id)
    const te1 = await tokenOf(e1.id)
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const copies = () => inv('copies:list', alpha)
    const leaseOf = async (n) => (await copies()).find((c) => c.state === 'leased' && c.lease && c.lease.kind === 'review' && c.lease.card === n && c.lease.agent === e1.id && !c.lease.returned)
    const facts = async (n) => (await inv('tasks:facts', n)) ?? []
    // What B1's cw_submit got back, from its transcript (the fake writes the call and its reply there).
    const submits = async () => {
      const s = await live(b1.id)
      const items = s?.sessionId ? ((await inv('transcript:read', alpha, s.sessionId).catch(() => null))?.items ?? []) : []
      return items.filter((i) => i.kind === 'tool' && i.tool.name.endsWith('cw_submit')).map((i) => i.tool.result ?? '')
    }

    // --- B1 builds the card in its lane (E1 reviews) and submits it; E1 starts its review in copy-1.
    const n = (await inv('tasks:create', { title: 'Follow-up card', project: 'alpha' })).number
    const key = (await card(n)).key
    const lane = await call(tb1, 'POST', '/v1/lanes', { cards: [n], reviewer: 'E1' })
    check("B1's lane, E1 its reviewer", lane.status === 200, JSON.stringify(lane.body))
    const s = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start`)
    fs.writeFileSync(path.join(alpha, 'a.ts'), 'export const a = 2\n')
    gitIn(alpha, 'commit', '-qam', 'card', '-m', `Combwork-Card: ${key}`)
    const first = gitIn(alpha, 'rev-parse', 'HEAD')
    const sub = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: 'Done.' })
    check(`B1 builds and submits ${key}`, s.status === 200 && sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ s: s.body, sub: sub.body }))
    const r1 = await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start-review`, {})
    const c1 = await until(() => leaseOf(n), HUNG_MS)
    check('E1 starts its review, in copy-1 at the submitted revision', r1.status === 200 && !!c1 && gitIn(c1.folder, 'rev-parse', 'HEAD') === first, JSON.stringify({ r1: r1.body, copies: await copies() }))
    const firstLease = c1?.lease?.id

    // --- B1 commits what E1 asked for and submits it as a follow-up, through its hive tool.
    fs.writeFileSync(path.join(alpha, 'a.ts'), 'export const a = 3\n')
    gitIn(alpha, 'commit', '-qam', 'asked for', '-m', `Combwork-Card: ${key}`)
    const head = gitIn(alpha, 'rev-parse', 'HEAD')
    const wakes = path.join(claudeHome, 'fake-wakes.jsonl')
    const wakesBefore = lines(wakes).length
    const before = (await submits()).length
    const args = { card: key, summary: 'The change E1 asked for: a is 3.', followUp: true }
    const sent = await lib.sendPrompt(inv, lib.ptyKey(alpha, b1.id), `cw cw_submit ${JSON.stringify(args)}`, { submitted: async () => (await submits()).length > before })
    const reply = sent ? await until(async () => (await submits())[before], HUNG_MS) : null
    check('B1 submits the follow-up with cw_submit followUp', !!reply && !/refused|error/i.test(reply), String(reply))
    const now = await card(n)
    check('…the card stays in Review, B1\'s', now.column === 'review' && now.agent === b1.id, JSON.stringify({ column: now.column, agent: now.agent }))
    check('…its history says so, and never "Given to"', now.history.some((h) => h.whatText?.id === 'tasks.history.followUpSubmitted' && h.whatText.values?.revision === head.slice(0, 7)) && !now.history.some((h) => h.what.startsWith('Given to E1')), JSON.stringify(now.history.slice(-4)))
    const subs = (await facts(n)).filter((f) => f.kind === 'Submitted')
    check('…a second submission, at the head, in the same round', subs.length === 2 && subs[1].data.revision === head && subs[1].data.followUp === true && subs[1].data.round === subs[0].data.round, JSON.stringify(subs.map((f) => f.data)))
    check('…pinned', !!(await until(() => { try { return gitIn(alpha, 'rev-parse', `refs/cw/cards/${key.toLowerCase()}/2`) === head } catch { return false } }, HUNG_MS)))
    check('…B1 watches it again', !!(await until(async () => (await live(b1.id))?.status === 'watching', HUNG_MS)), String((await live(b1.id))?.status))
    const woken = await until(() => lines(wakes).slice(wakesBefore).find((w) => w.agent === 'E1' && w.text.includes(`follow-up submitted for review at ${head.slice(0, 7)}`)), HUNG_MS)
    check('…and E1 is woken, with no column move, to start its review again', !!woken && /cw_start_review/.test(woken.text), JSON.stringify(lines(wakes).slice(wakesBefore)))

    // --- E1 starts again: copy-1 at the follow-up, the earlier lease returned; a verdict on the earlier one is refused.
    const old = await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/verdict`, { pass: false, comment: 'On the earlier one.', submission: subs[0].seq })
    check('a verdict on the earlier submission is refused', old.status !== 200, JSON.stringify(old.body))
    const r2 = await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start-review`, {})
    const c2 = await until(async () => {
      const l = await leaseOf(n)
      return l && l.lease.id !== firstLease && gitIn(l.folder, 'rev-parse', 'HEAD') === head ? l : null
    }, HUNG_MS)
    check("E1's start review again takes the follow-up: its review copy is moved to it", r2.status === 200 && r2.body?.data?.revision === head && !!c2, JSON.stringify({ r2: r2.body, copies: await copies() }))
    const pass = await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/verdict`, { pass: true, comment: 'Good.' })
    check('…and its pass moves the card on, no round counted', pass.status === 200 && !!(await until(async () => (await card(n))?.column !== 'review', HUNG_MS)) && !(await facts(n)).some((f) => f.kind === 'Verdict' && f.data.pass === false), JSON.stringify(pass.body))

    // --- A reviewer's own move to Doing (the HI-1772 workaround) leaves the card its builder's.
    const m = (await inv('tasks:create', { title: 'Moved back', project: 'alpha' })).number
    const mkey = (await card(m)).key
    await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(mkey)}/start`)
    fs.writeFileSync(path.join(alpha, 'b.ts'), 'export const b = 1\n')
    gitIn(alpha, 'add', 'b.ts')
    gitIn(alpha, 'commit', '-qm', 'b', '-m', `Combwork-Card: ${mkey}`)
    await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(mkey)}/submit`, { summary: 'Done.' })
    await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(mkey)}/start-review`, {})
    const back = await call(te1, 'PATCH', `/v1/tasks/${m}`, { column: 'doing', reply: 'short' })
    const moved = await until(async () => ((await card(m))?.column === 'doing' ? card(m) : null), HUNG_MS)
    check("E1's move of the card back to Doing leaves it B1's", back.status === 200 && moved?.agent === b1.id && !moved.history.some((h) => h.what.startsWith('Given to E1')), JSON.stringify({ back: back.body, agent: moved?.agent, history: moved?.history.slice(-4) }))
  } catch (e) {
    check('no unexpected error', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
