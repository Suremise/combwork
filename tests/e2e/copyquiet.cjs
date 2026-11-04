// Copies: wait for one to be free (hive.copies.quietWaitMinutes, #1563, tests/workflow/README.md's P7 table) in the app:
// a pool of one review copy, fake Claude Code agents (B1 builds two cards in the project folder; R1 and R2 review), the
// wait set to its least, 1 minute:
// - R1 reviews A in copy-1 and gives its verdict while still working (a turn held open, sent once the turn Hive's reviewer
//   pool typed A into has ended, HI-2046): copy-1 is returned but held back (returning) while R1 is busy;
// - R2's start review on B waits for a copy ("the pool's 1 copy is in use; copy-1, returned 0 min ago, is held back by
//   R1 (working)", HI-1764) while the copy is within the wait;
// - past the minute, R2's review says what still uses it: "copy-1 is still in use by R1 (working)";
// - R1's turn over, copy-1 is freed and leased to R2.
// The wait spans a minute by design (its least): every step waits for what it expects, bounded against a hang.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// The quiet wait's minute, a look at the pools (every 30 s) and a loaded machine.
const QUIET_MS = 180000

const at = (x) => path.join(lib.WORK, `copyquiet-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47810))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms, every = 250) => lib.until(fn, ms, every)
const gitIn = (dir, ...a) => lib.git(dir, a).trim()
const lines = (file) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const env = lib.fakeClaude(userData, home, [ws, alpha])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project' } })
    await inv('slots:setSetting', alpha, 'copiesSize', 1)
    await inv('advanced:set', 'hive.copies.quietWaitMinutes', 1)
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const r2 = await lib.addAgent(inv, alpha, { name: 'R2', workflowRole: 'reviewer' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    for (const a of [b1, r1, r2]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await until(async () => (await Promise.all([b1, r1, r2].map(async (a) => ['ready', 'finished'].includes((await live(a.id))?.status)))).every(Boolean), HUNG_MS)))
    const token = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const l = await until(() => lines(path.join(home, 'fake-launches.jsonl')).findLast((x) => x.sessionId === sessionId && x.opts['--mcp-config']), HUNG_MS)
      const hive = JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers.combwork
      return JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const call = async (t, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const [tb1, tr1, tr2] = [await token(b1.id), await token(r1.id), await token(r2.id)]
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const copies = () => inv('copies:list', alpha)
    const copy1 = async () => (await copies()).find((c) => c.name === 'copy-1')

    // --- Two cards built and submitted by B1 in the project folder.
    const cards = []
    for (const [title, v] of [['Quiet A', 2], ['Quiet B', 3]]) {
      const n = (await inv('tasks:create', { title, project: 'alpha' })).number
      const key = (await card(n)).key
      const s = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start`)
      fs.writeFileSync(path.join(alpha, 'a.ts'), `export const a = ${v}\n`)
      gitIn(alpha, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', title, '-m', `Hive-Card: ${key}`)
      const sub = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: `${title}: ready`, revision: gitIn(alpha, 'rev-parse', 'HEAD') })
      check(`B1 builds and submits ${key}`, s.status === 200 && sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ s: s.body, sub: sub.body }))
      cards.push(n)
    }
    const [a, b] = cards

    // --- R1 reviews A in copy-1; its verdict while it works returns the copy, held back.
    const ra = await call(tr1, 'PATCH', `/v1/tasks/${a}`, { review: 'start', reply: 'short' })
    check("R1's start review leases copy-1", ra.status === 200 && !!(await until(async () => (await copy1())?.state === 'leased' && (await copy1())?.lease?.agent === r1.id, HUNG_MS)), JSON.stringify({ ra: ra.body, copies: await copies() }))
    // HI-2175: Hive's reviewer pool gives each card in Review outside a lane to an idle reviewer and types it in (HI-2046),
    // a turn of R1's own: the held-open turn is a new one, sent once that has ended, never that turn taken for it.
    const idle = await until(async () => ['ready', 'finished'].includes((await live(r1.id))?.status), HUNG_MS)
    const before = (await live(r1.id))?.turn?.id ?? null
    const held = async () => {
      const s = await live(r1.id)
      return s?.status === 'working' && (s.turn?.id ?? null) !== before
    }
    const sent = !!idle && (await lib.sendPrompt(inv, lib.ptyKey(alpha, r1.id), 'holduntil quiet-go', { submitted: held }))
    check('R1 is working (its turn held open)', !!sent && (await held()), JSON.stringify(await live(r1.id)))
    const va = await call(tr1, 'PATCH', `/v1/tasks/${a}`, { review: 'failed', comment: 'Fake: one thing to fix.', reply: 'short' })
    const returnedAt = Date.now()
    check("R1's verdict on A while it works: copy-1 is returned, held back", va.status === 200 && !!(await until(async () => (await copy1())?.state === 'returning', HUNG_MS)), JSON.stringify({ va: va.body, copies: await copies() }))

    // --- R2's review of B waits; past the minute, it says what still uses copy-1.
    const startB = async () => (await call(tr2, 'PATCH', `/v1/tasks/${b}`, { review: 'start' })).body?.reviewCopy ?? ''
    const first = await startB()
    check("R2's start review on B waits: the pool's copies are in use", Date.now() - returnedAt < 60_000 && /^Waiting for a review copy \(the pool's 1 copy is in use; copy-1, returned \d+ min ago, is held back by R1 \(working\)\)/.test(first), first)
    let said = ''
    const past = await until(async () => /copy-1 is still in use by R1 \(working\)/.test((said = await startB())), QUIET_MS, 5000)
    check('past the wait (1 min), it says what still uses it: "copy-1 is still in use by R1 (working)"', !!past && Date.now() - returnedAt >= 60_000, `${said} R1: ${JSON.stringify(await live(r1.id))}`)
    check('…copy-1 still held back, and no second copy made', (await copy1())?.state === 'returning' && (await copies()).length === 1, JSON.stringify(await copies()))

    // --- R1's turn over: copy-1 freed and leased to R2.
    fs.writeFileSync(path.join(home, 'quiet-go'), 'go')
    check("R1's turn ends", !!(await until(async () => ['ready', 'finished'].includes((await live(r1.id))?.status), HUNG_MS)))
    check('…copy-1 is freed and leased to R2 for B', !!(await until(async () => (await copy1())?.state === 'leased' && (await copy1())?.lease?.agent === r2.id && (await copy1())?.lease?.card === b, QUIET_MS)), JSON.stringify(await copies()))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    fs.writeFileSync(path.join(home, 'quiet-go'), 'go')
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
