// Reviewers review in review copies (#1439, SPEC §16.10.5): start review leases the reviewer a copy at the exact revision
// it reviews, the verdict returns it, and each reviewer's launch is granted the project's copies folder (--add-dir). A
// fake Claude Code builder (B1) builds three cards in the project folder (Where cards are built: the project folder); two
// fake Codex reviewers (R1, R2) and a fake Claude Code agent that does either (E1, the lane's reviewer); the Assistant
// isn't started:
// - the reviewers' launches (R1, R2, E1 in the project folder) have --add-dir <ws>.worktrees\alpha\copies; B1's has none;
// - R1's start review replies with copies\copy-1, at the submitted revision, while the builder's folder has moved on;
// - R1's hive-progress --check there (no card named) counts for the submission, the copy's card and revision;
// - with a pool of two, R1 and R2 review at once; E1's start review waits ("Waiting for a review copy", the card's
//   history says so); R1's verdict returns copy-1, which E1 is then leased and told of (its inbox);
// - R2's session ending gives its review up: copy-2 is returned and freed; with review copies off, R2 started again has
//   no --add-dir and its start review leases nothing.
// Dev build (or HIVE_EXE), throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { fromCodexTable } = require('./fake-bridge.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
// The pools are looked at again every 30 s (copiesApp.ts): a wait for a copy to come free spans one look at least.
const LOOK_MS = 120000

const PORT = Number(lib.port(47802))
const at = (x) => path.join(lib.WORK, `reviewcopies-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const codexHome = at('codex-home')
const tools = at('tools')
const alpha = path.join(ws, 'alpha')
const copiesDir = path.join(`${ws}.worktrees`, 'alpha', 'copies')
const started = path.join(tools, 'started.jsonl')
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
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const starts = () => lines(started)

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome, codexHome, tools]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome, tools]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  // The check: records where it ran, passes.
  const script = path.join(tools, 'check.js')
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(started)}, JSON.stringify({ cwd: process.cwd() }) + '\\n')\n`)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Through lib.launch, so HIVE_EXE runs it on a packaged build (#1591: the packaged checks' review in a review copy, #1539).
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 850 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project', commands: { quick: `node "${script}"` } } })
    await inv('project:updateConfig', alpha, { copies: { size: 2 } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', provider: 'codex', workflowRole: 'reviewer' })
    const r2 = await lib.addAgent(inv, alpha, { name: 'R2', provider: 'codex', workflowRole: 'reviewer' })
    const e1 = await lib.addAgent(inv, alpha, { name: 'E1', workflowRole: 'either' })
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const ready = (id) =>
      until(async () => {
        const s = await live(id)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, id), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    for (const a of [b1, r1, r2, e1]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await ready(b1.id)) && !!(await ready(r1.id)) && !!(await ready(r2.id)) && !!(await ready(e1.id)))

    // --- Each launch: the reviewers' granted the copies folder (in the project folder), the builder's not.
    const claudeLaunch = async (id) => {
      const sessionId = (await live(id))?.sessionId
      return until(() => lines(path.join(claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
    }
    const codexLaunches = () => lines(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => !['--version', 'login', 'app-server', 'debug'].includes(l.args[0]))
    const addDirs = (args) => args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []))
    const lb1 = await claudeLaunch(b1.id)
    const le1 = await claudeLaunch(e1.id)
    check("B1's launch (a builder) has no --add-dir", !!lb1 && !lb1.opts['--add-dir'], JSON.stringify(lb1?.opts))
    check("E1's launch (either, in the project folder) has --add-dir the copies folder", same(le1?.opts['--add-dir'], copiesDir) && same(le1?.cwd, alpha), JSON.stringify({ opts: le1?.opts, cwd: le1?.cwd }))
    // An agent's Codex launch: the one whose hooks carry its run's id.
    const codexOf = async (id) => {
      const run = (await live(id))?.runId
      return until(() => (run ? codexLaunches().findLast((l) => l.args.some((x) => x.includes(run))) : null), HUNG_MS)
    }
    const lr1 = await codexOf(r1.id)
    const lr2 = await codexOf(r2.id)
    check("R1's and R2's launches (Codex reviewers) have --add-dir the copies folder", [lr1, lr2].every((l) => l && addDirs(l.args).length === 1 && same(addDirs(l.args)[0], copiesDir)), JSON.stringify([lr1?.args, lr2?.args].map((a) => a && addDirs(a))))
    check('…which Hive made', fs.existsSync(copiesDir))

    const claudeToken = async (id) => {
      const l = await claudeLaunch(id)
      const hive = JSON.parse(fs.readFileSync(l.opts['--mcp-config'], 'utf8')).mcpServers.combwork
      return JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const codexToken = async (id) => {
      const l = await codexOf(id)
      const hive = fromCodexTable(l.args.find((a) => a.startsWith('mcp_servers.combwork=')).slice('mcp_servers.combwork='.length))
      return JSON.parse(fs.readFileSync(hive.env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const call = async (token, method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const tb1 = await claudeToken(b1.id)
    const te1 = await claudeToken(e1.id)
    const tr1 = await codexToken(r1.id)
    const tr2 = await codexToken(r2.id)
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const copies = () => inv('copies:list', alpha)
    const copyOf = async (n, agent) => (await copies()).find((c) => c.state === 'leased' && c.lease && c.lease.kind === 'review' && c.lease.card === n && c.lease.agent === agent && !c.lease.returned)

    // --- Three cards, each built and submitted in turn by B1 (C in a lane whose reviewer is E1).
    const cards = []
    for (const title of ['Copies A', 'Copies B', 'Copies C']) cards.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [a, b, c] = cards
    const keyOf = async (n) => (await card(n)).key
    const lane = await call(tb1, 'POST', '/v1/lanes', { cards: [c], reviewer: 'E1' })
    check("B1's lane for C, E1 its reviewer", lane.status === 200, JSON.stringify(lane.body))
    const revs = {}
    for (const [n, v] of [[a, 2], [b, 3], [c, 4]]) {
      const key = await keyOf(n)
      const s = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/start`)
      fs.writeFileSync(path.join(alpha, 'a.ts'), `export const a = ${v}\n`)
      // Its own commit, attributed to it (a shared folder's cards are their Hive-Card commits).
      gitIn(alpha, 'commit', '-qam', `card ${n}`, '-m', `Hive-Card: ${key}`)
      revs[n] = gitIn(alpha, 'rev-parse', 'HEAD')
      const sub = await call(tb1, 'POST', `/v1/tasks/${encodeURIComponent(key)}/submit`, { summary: `Card ${n} done.`, revision: revs[n] })
      check(`B1 builds and submits ${key}`, s.status === 200 && sub.status === 200 && (await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ s: s.body, sub: sub.body }))
    }

    // --- R1 reviews A in copy-1, at A's revision, while the builder's folder has moved on.
    const ra = await call(tr1, 'PATCH', `/v1/tasks/${a}`, { review: 'start', reply: 'short' })
    const said = (ra.body?.changes ?? []).find((x) => x.startsWith('Review in '))
    check("R1's start review names copy-1 at A's revision", ra.status === 200 && !!said && /[\\/]copies[\\/]copy-1 at /.test(said) && said.includes(revs[a].slice(0, 12)), JSON.stringify(ra.body))
    // Lean (AGENTS.md, replysize.cjs): the line the reply adds is one sentence and a path.
    check('…in one line of at most 300 characters', !!said && said.length <= 300, String(said?.length))
    const c1 = await until(() => copyOf(a, r1.id), HUNG_MS)
    check('…copy-1 is leased to R1 for A, at its revision', !!c1 && c1.name === 'copy-1' && gitIn(c1.folder, 'rev-parse', 'HEAD') === revs[a], JSON.stringify(await copies()))
    check("…while the builder's folder has moved on (C's commit)", gitIn(alpha, 'rev-parse', 'HEAD') === revs[c] && revs[c] !== revs[a])
    check("…and A's history says so", (await card(a)).history.some((h) => h.whatText?.id === 'tasks.history.reviewCopyLeased' && h.whatText.values?.copy === 'copy-1'), JSON.stringify((await card(a)).history.slice(-3)))

    // --- R1's check in the copy counts for A's submission.
    const shell = async (id, cmd) => {
      const file = path.join(codexHome, 'fake-shell.jsonl')
      const before = lines(file).length
      const sent = await lib.sendPrompt(inv, lib.ptyKey(alpha, id), `shell: ${cmd}`, { submitted: () => lines(file).length > before })
      return sent ? lines(file)[before] : null
    }
    const ran = await shell(r1.id, `cd /d "${c1.folder}" && hive-progress --check quick`)
    check('R1 runs the check in copy-1', ran?.code === 0 && same(starts().at(-1)?.cwd, c1.folder), JSON.stringify({ ran, starts: starts() }))
    const run = await until(async () => (await inv('progress:snapshot')).runs.find((r) => r.check === 'quick' && r.card === a && r.copy === 'copy-1' && r.state !== 'running'), HUNG_MS)
    const counted = await until(async () => (await inv('tasks:work', a))?.checks.find((x) => x.name === 'quick' && x.run === run?.id), HUNG_MS)
    check('…a check of A at its revision, counted', !!counted && counted.counted === true && counted.revision === revs[a], JSON.stringify({ run, counted }))

    // --- A pool of two: R2 reviews B at once; E1, C's lane reviewer, waits.
    const rb = await call(tr2, 'PATCH', `/v1/tasks/${b}`, { review: 'start', reply: 'short' })
    const c2 = await until(() => copyOf(b, r2.id), HUNG_MS)
    check('R2 reviews B in copy-2 at the same time', rb.status === 200 && c2?.name === 'copy-2' && gitIn(c2.folder, 'rev-parse', 'HEAD') === revs[b], JSON.stringify({ rb: rb.body, copies: await copies() }))
    const rc = await call(te1, 'POST', `/v1/tasks/${encodeURIComponent(await keyOf(c))}/start-review`, {})
    check("E1's start review (the intent) waits for a review copy", rc.status === 200 && (rc.body?.data?.reviewCopy ?? '').startsWith('Waiting for a review copy'), JSON.stringify(rc.body))
    check('…in one line of at most 300 characters', (rc.body?.data?.reviewCopy ?? '').length <= 300, String(rc.body?.data?.reviewCopy?.length))
    check("…C's history says so", (await card(c)).history.some((h) => h.whatText?.id === 'tasks.history.reviewCopyWaiting' && h.whatText.values?.agent === 'E1'))
    check('…and no third copy is made', (await copies()).length === 2, JSON.stringify(await copies()))

    // --- R1's verdict returns copy-1; E1 is leased it and told.
    const va = await call(tr1, 'PATCH', `/v1/tasks/${a}`, { review: 'failed', comment: 'Fake: one thing to fix.', reply: 'short' })
    check("R1's verdict on A", va.status === 200, JSON.stringify(va.body))
    const forE1 = await until(() => copyOf(c, e1.id), LOOK_MS)
    check('…copy-1 is freed and leased to E1 for C, at its revision', forE1?.name === 'copy-1' && gitIn(forE1.folder, 'rev-parse', 'HEAD') === revs[c], JSON.stringify(await copies()))
    const told = await until(() => lines(path.join(claudeHome, 'fake-wakes.jsonl')).find((w) => w.agent === 'E1' && /review copy is ready/.test(w.text)), HUNG_MS)
    check('…and E1 is told, with its folder', !!told && told.text.includes(forE1?.folder ?? '?'), JSON.stringify(lines(path.join(claudeHome, 'fake-wakes.jsonl'))))

    // --- R2's session ends: its review is given up, copy-2 returned and freed. Off, R2 again is granted nothing.
    await inv('session:stop', alpha, r2.id)
    check('R2 stops', !!(await until(async () => !(await live(r2.id)), HUNG_MS)))
    check("…its review copy is returned and freed", !!(await until(async () => (await copies()).find((x) => x.name === 'copy-2')?.state === 'free' && !(await copyOf(b, r2.id)), LOOK_MS)), JSON.stringify(await copies()))
    await inv('advanced:set', 'hive.copies.review', false)
    const before = codexLaunches().length
    await inv('session:start', alpha, { agentId: r2.id })
    check('R2 starts again', !!(await ready(r2.id)))
    const again = await codexOf(r2.id)
    check('…with review copies off, its launch has no --add-dir', !!again && codexLaunches().length > before && !again.args.includes('--add-dir'), JSON.stringify(again?.args))
    const tr2b = await codexToken(r2.id)
    const rb2 = await call(tr2b, 'PATCH', `/v1/tasks/${b}`, { review: 'start', reply: 'short' })
    check('…and its start review leases nothing', rb2.status === 200 && !(rb2.body?.changes ?? []).some((x) => /review copy|Review in/.test(x)) && !(await copyOf(b, r2.id)), JSON.stringify(rb2.body))
  } catch (e) {
    check('no unexpected error', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
