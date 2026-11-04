// A reviewer in a review copy reads the builder's attached files through Hive (HI-1751: HR2, a Codex reviewer, couldn't
// read HI-1702's evidence: the document tools refuse .combwork, and it rightly didn't go round Hive to the files). A fake
// Claude Code builder (B1) attaches a probe, its results (over a page long, a character of several bytes at the page's
// end) and a screenshot to its card, and submits; a fake Codex reviewer (R1) and a fake Claude Code one (E1, either) each
// start a review, which leases each a review copy, and call cw_read_attachment through their launch's own hive MCP
// server: the probe whole, the results in pages from the offset each reply names (from 0 to its size), the screenshot by
// its path. An agent of another project (X in beta) asking for the same card is told there is no such card. Dev build,
// throwaway profile, workspace, CLAUDE_CONFIG_DIR and CODEX_HOME.
const lib = require('./lib.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const PORT = Number(lib.port(47883))
const at = (x) => path.join(lib.WORK, `attachread-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const codexHome = at('codex-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)
const gitIn = (dir, ...a) => execFileSync('git', a, { cwd: dir, env: lib.gitEnv(), encoding: 'utf8' }).trim()

// The builder's evidence: a probe, results over a page long with a 4-byte character across the page's end, a screenshot.
const PAGE = 64 * 1024
const probe = "const t = Date.now()\nsetImmediate(() => console.log('lag', Date.now() - t))\n"
const results = 'r'.repeat(PAGE - 2) + '😀' + 'run 1: 12 ms ✓\n'.repeat(3000)
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', '.gitignore': '.combwork/\nevidence/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.gitProject(beta, { 'b.ts': 'export const b = 1\n', '.gitignore': '.combwork/\n' })
  const evidence = path.join(alpha, 'evidence')
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(evidence, 'probe.cjs'), probe)
  fs.writeFileSync(path.join(evidence, 'results.txt'), results)
  fs.writeFileSync(path.join(evidence, 'shot.png'), png)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 850 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, folder: 'project' } })
    await inv('project:updateConfig', alpha, { copies: { size: 2 } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', provider: 'codex', workflowRole: 'reviewer' })
    const e1 = await lib.addAgent(inv, alpha, { name: 'E1', workflowRole: 'either' })
    const x = await lib.addAgent(inv, beta, { name: 'X' })
    const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
    const ready = (p, id) =>
      until(async () => {
        const s = await live(p, id)
        if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(p, id), '\r')
        return ['ready', 'finished'].includes(s?.status)
      }, HUNG_MS)
    for (const [p, a] of [[alpha, b1], [alpha, r1], [alpha, e1], [beta, x]]) await inv('session:start', p, { agentId: a.id })
    check('the agents start', !!(await ready(alpha, b1.id)) && !!(await ready(alpha, r1.id)) && !!(await ready(alpha, e1.id)) && !!(await ready(beta, x.id)))

    // The hive API as B1 (its token, from its launch's hive server), to build and attach as a builder does.
    const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
    const b1Launch = await until(async () => {
      const sid = (await live(alpha, b1.id))?.sessionId
      return lines(path.join(claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === sid && l.opts['--mcp-config'])
    }, HUNG_MS)
    const hiveEnv = JSON.parse(fs.readFileSync(b1Launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork.env
    const tb1 = JSON.parse(fs.readFileSync(hiveEnv.CW_API_TOKEN_FILE, 'utf8')).token
    const call = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${tb1}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    // --- B1 builds two cards, attaching its evidence to the first, and submits both.
    const nums = []
    for (const title of ['Evidence A', 'Evidence C']) nums.push((await inv('tasks:create', { title, project: 'alpha' })).number)
    const [a, c] = nums
    const keys = {}
    for (const [n, v] of [[a, 2], [c, 3]]) {
      keys[n] = (await card(n)).key
      const s = await call('POST', `/v1/tasks/${encodeURIComponent(keys[n])}/start`)
      fs.writeFileSync(path.join(alpha, 'a.ts'), `export const a = ${v}\n`)
      gitIn(alpha, 'commit', '-qam', `card ${n}`, '-m', `Hive-Card: ${keys[n]}`)
      const files = n === a ? ['probe.cjs', 'results.txt', 'shot.png'] : ['probe.cjs']
      const attached = await call('PATCH', `/v1/tasks/${n}`, { comment: 'The probe, its results and a screenshot.', attachments: files.map((f) => path.join(evidence, f)), reply: 'short' })
      const sub = await call('POST', `/v1/tasks/${encodeURIComponent(keys[n])}/submit`, { summary: `Card ${n} done.`, revision: gitIn(alpha, 'rev-parse', 'HEAD') })
      check(`B1 attaches its evidence to ${keys[n]} and submits it`, s.status === 200 && attached.status === 200 && sub.status === 200 && !!(await until(async () => (await card(n))?.column === 'review', HUNG_MS)), JSON.stringify({ s: s.body, attached: attached.body, sub: sub.body }))
    }

    // What an agent's hive tool call got back, from its transcript (both fake CLIs write the call and its reply there).
    const replies = async (p, id) => {
      const s = await live(p, id)
      const items = s?.sessionId ? ((await inv('transcript:read', p, s.sessionId).catch(() => null))?.items ?? []) : []
      return items.filter((i) => i.kind === 'tool' && i.tool.name.endsWith('cw_read_attachment')).map((i) => i.tool.result ?? '')
    }
    const ask = async (p, id, args) => {
      const before = (await replies(p, id)).length
      const sent = await lib.sendPrompt(inv, lib.ptyKey(p, id), `hive cw_read_attachment ${JSON.stringify(args)}`, { submitted: async () => (await replies(p, id)).length > before })
      return sent ? (await until(async () => (await replies(p, id))[before], HUNG_MS)) ?? null : null
    }
    const body = (reply) => reply.slice(reply.indexOf('\n\n') + 2)
    const nextOf = (reply) => Number(/more from offset (\d+)\)/.exec(reply)?.[1] ?? NaN)
    /**
     * Every page of a text attachment, as the agent reads them, from the offset each reply names: each page's byte range
     * (its line) and its text as the transcript shows it (Hive's transcript view keeps a tool result's first 4,000
     * characters: the pages joined in full are replysize's and the unit tests'). Checked: the ranges follow on from 0 to
     * the file's size, and each page's text is the file's from its first byte.
     */
    const allPages = async (p, id, n, name, file) => {
      const bytes = Buffer.from(file, 'utf8')
      const ranges = []
      let offset
      for (let i = 0; i < 10; i++) {
        const r = await ask(p, id, { card: n, name, ...(offset !== undefined ? { offset } : {}) })
        const m = r && /^\S+ \(bytes ([\d,]+)–([\d,]+) of ([\d,]+) bytes/.exec(r)
        if (!m) return { ok: false, last: r?.slice(0, 200) }
        const [from, to, size] = m.slice(1, 4).map((s) => Number(s.replace(/,/g, '')))
        const shown = body(r)
        ranges.push({ from, to, size, starts: shown.slice(0, 20) })
        if (size !== bytes.length || from !== (offset ?? 0) || !bytes.subarray(from, to).toString('utf8').startsWith(shown.slice(0, 3000))) return { ok: false, ranges }
        if (!/more from offset/.test(r)) return { ok: to === size, ranges }
        offset = nextOf(r)
        if (offset !== to) return { ok: false, ranges }
      }
      return { ok: false, ranges }
    }

    // --- R1 (Codex) starts its review of A: a review copy; then reads the evidence through Hive.
    const codexToken = async () => {
      const run = (await live(alpha, r1.id))?.runId
      const launch = await until(() => lines(path.join(codexHome, 'fake-launches.jsonl')).findLast((l) => l.args.some((y) => run && y.includes(run))), HUNG_MS)
      const { fromCodexTable } = require('./fake-bridge.cjs')
      return JSON.parse(fs.readFileSync(fromCodexTable(launch.args.find((y) => y.startsWith('mcp_servers.combwork=')).slice('mcp_servers.combwork='.length)).env.CW_API_TOKEN_FILE, 'utf8')).token
    }
    const startReview = async (token, n) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${n}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ review: 'start', reply: 'short' }) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const ra = await startReview(await codexToken(), a)
    const inCopy = (r) => (r.body?.changes ?? []).find((s) => /^Review in .*[\\/]copies[\\/]copy-\d+ at /.test(s))
    check(`R1 (Codex) starts its review of ${keys[a]} in a review copy`, ra.status === 200 && !!inCopy(ra), JSON.stringify(ra.body))
    const p1 = await ask(alpha, r1.id, { card: a, name: 'probe.cjs' })
    check('…reads the probe through Hive, whole', p1 === `probe.cjs (${Buffer.byteLength(probe)} bytes)\n\n${probe}`, p1)
    const r1Results = await allPages(alpha, r1.id, a, 'results.txt', results)
    // The 4-byte character across the page's end: the first page stops before it, the second starts with it.
    check('…and the results in pages from the offset each names, from 0 to its size, each its bytes (a 4-byte character at the page end starting the second)', r1Results.ok && r1Results.ranges.length >= 2 && r1Results.ranges[1].from === PAGE - 2 && r1Results.ranges[1].starts.startsWith('😀run 1'), JSON.stringify(r1Results))
    const shot = await ask(alpha, r1.id, { card: a, name: 'shot.png' })
    check('…and the screenshot by its path, to open with its own file reading', /^shot\.png: an image \(12 bytes\)\. Open it with your own file reading: .*[\\/]\.combwork[\\/]attachments[\\/]cards[\\/]\d+[\\/][^\\/]*shot\.png$/.test(shot ?? '') && fs.readFileSync(shot.split('file reading: ')[1]).equals(png), shot)

    // --- E1 (Claude Code, either) starts its review of C: a review copy; reads C's probe, and A's as a project agent may.
    const e1Token = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync((await until(async () => {
      const sid = (await live(alpha, e1.id))?.sessionId
      return lines(path.join(claudeHome, 'fake-launches.jsonl')).findLast((l) => l.sessionId === sid && l.opts['--mcp-config'])
    }, HUNG_MS)).opts['--mcp-config'], 'utf8')).mcpServers.combwork.env.CW_API_TOKEN_FILE, 'utf8')).token
    const rc = await startReview(e1Token, c)
    check(`E1 (Claude Code) starts its review of ${keys[c]} in a review copy`, rc.status === 200 && !!inCopy(rc), JSON.stringify(rc.body))
    const p2 = await ask(alpha, e1.id, { card: c, name: 'probe.cjs' })
    check('…reads its probe through Hive, whole', p2 === `probe.cjs (${Buffer.byteLength(probe)} bytes)\n\n${probe}`, p2)
    const e1Results = await allPages(alpha, e1.id, a, 'results.txt', results)
    check("…and A's results, in the same pages", e1Results.ok && JSON.stringify(e1Results.ranges) === JSON.stringify(r1Results.ranges), JSON.stringify(e1Results))

    // --- X, an agent of another project: no such card, as for a card it can't see.
    const refused = await ask(beta, x.id, { card: a, name: 'probe.cjs' })
    check("X (beta) asking for alpha's card is told there is no such card, and gets nothing of it", !!refused && /error|not found|no card|unknown/i.test(refused) && !refused.includes('setImmediate'), refused)
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
})()
