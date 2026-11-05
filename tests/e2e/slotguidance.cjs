// What agents are told about slots (#1444, SPEC §16.10): the guidance P7 changed, as each CLI is given it, with the
// Assistant off. alpha builds cards in slots (Where cards are built: each card in its own folder):
// 1. Claude Code (fake): B1, in the project folder, starts its card through its own hive server (tools/call, as its
//    CLI would): the reply names the slot and says it continues there; Combwork starts it again in the slot, where its launch's
//    skills have the slot lines (work-on-card: work and run checks in the slot; --isolated) and its hive server's
//    instructions the contract's slot line.
// 2. R1, a reviewer in the project folder: its skills have the review-copy line (review-agent-work), and its start review
//    reply names the review copy's folder (B1's submission, made in the slot).
// 3. Codex (fake): B2 lent a slot for its card: started there, its copies in the slot have the slot lines and its
//    developer instructions the contract's slot line.
// 4. Copilot (the real CLI offline against the stand-in model, where it is installed): B3 lent a slot: its copies there
//    and the system prompt it sends have them too.
// No text delivered to any of them tells an agent to use a worktree of its own. Dev build, throwaway profile, workspace,
// CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME.
// Dev build only (#1580): its slots are lent through slots:test, which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotguidance-${x}`)
const userData = at('profile')
const ws = at('ws')
const claudeHome = at('claude-home')
const codexHome = at('codex-home')
const copilotDir = at('copilot')
const apiLog = at('copilot-api.jsonl')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47807))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
// The lines P7 changed (#1444), as agents are given them.
const SLOT_LINE = /that folder is the slot: work and run checks there, never in another one/
const ISOLATED = /with `--isolated` it runs in a check copy of its own/
const COPY_LINE = /the review copy holding that revision when the project has them\. Review there, never in the builder's slot or folder/
const CONTRACT = /Combwork sets your folder \(the project's, a card's or lane's slot, or the review copy a review names\)/
// What nothing delivered may say any more: a worktree of an agent's own (tests/guidance.test.ts has the same).
const OWN = /\b(?:its|your|their|an agent's) (?:own )?(?:git )?worktree\b|\bown (?:git )?worktree\b|\bagents? with (?:its|their) own\b/i

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, claudeHome, codexHome, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha, { 'greet.js': "module.exports = (name) => 'Hello ' + name\n", '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, ws, ...['slot-a', 'slot-b', 'slot-c'].map((s) => path.join(root, s))])
  const withCopilot = copilotInstalled()
  lib.enableProviders(userData, ['claude-code', 'codex', ...(withCopilot ? ['copilot'] : [])])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const api = withCopilot ? await startFakeCopilotApi({ log: apiLog, systems: true }) : null
  const copilotEnv = api ? copilotTestEnv(api, copilotDir, { above: lib.WORK }) : {}
  if (api) fs.writeFileSync(path.join(copilotEnv.COPILOT_HOME, 'config.json'), JSON.stringify({ trustedFolders: [alpha, ...['slot-a', 'slot-b', 'slot-c'].map((s) => path.join(root, s))] }, null, 2))

  const h = await lib.launch({ userData, env: { ...claudeEnv, CODEX_HOME: codexHome, ...copilotEnv, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    // Each card in its own folder, an agent reviewing, the agent merging.
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots', target: 'main', style: 'merge', preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder', provider: 'codex' })
    const b3 = withCopilot ? await lib.addAgent(inv, alpha, { name: 'B3', workflowRole: 'builder', provider: 'copilot' }) : null
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const ready = (id) =>
      until(async () => {
        const s = await live(id)
        if (s?.status === 'waiting') {
          // A folder new to the CLI asks to trust it first (Claude Code's menu starts on "No": lib answers it).
          const screen = lib.plainText(await inv('pty:buffer', lib.ptyKey(alpha, id)).catch(() => ''))
          if (/trust this folder/i.test(screen) && !(await lib.acceptClaudeTrust(inv, alpha, id, 3000))) await inv('pty:write', lib.ptyKey(alpha, id), '\r')
          else if (/Do you trust the files/i.test(screen)) await inv('pty:write', lib.ptyKey(alpha, id), '\r')
        }
        return ['ready', 'finished'].includes(s?.status) ? s : null
      }, HUNG_MS)
    const claudeLaunches = () => lines(path.join(claudeHome, 'fake-launches.jsonl'))
    /** The hive server a Claude Code agent's running session was given (its --mcp-config). */
    const serverOf = async (id) => {
      const sessionId = (await live(id))?.sessionId
      const launch = await until(() => claudeLaunches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      return launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    }
    /** One call to that server, as the CLI makes it: its reply's result. */
    const mcp = (server, method, params) => {
      const out = execFileSync(server.command, server.args ?? [], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n', env: lib.childEnv(server.env ?? {}), timeout: HUNG_MS }).toString()
      return out.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((m) => m?.id === 1)?.result ?? null
    }
    const tool = (server, name, args) => {
      const r = mcp(server, 'tools/call', { name, arguments: args })
      return { text: r?.content?.[0]?.text ?? '', isError: !!r?.isError }
    }
    const instructionsOf = (server) => mcp(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })?.instructions ?? ''
    /** A Claude Code agent's launch skills (its launch plugin, in the project's .combwork). */
    const pluginSkill = (id, name) => readOr(path.join(alpha, '.combwork', `launch-${id}`, 'plugin', 'skills', name, 'SKILL.md'))
    /** Codex's and Copilot's copies in a folder. */
    const copy = (folder, name) => readOr(path.join(folder, '.agents', 'skills', `cw-${name}`, 'SKILL.md'))
    const delivered = []

    // --- 1. Claude Code: B1 starts its card from the project folder; Combwork gives it the card in the slot.
    const n1 = (await inv('tasks:create', { title: 'Greeting comma', project: 'alpha' })).number
    await inv('tasks:update', n1, { agent: b1.id })
    await inv('session:start', alpha, { agentId: b1.id })
    const first = await ready(b1.id)
    check('B1 runs in the project folder', same(first?.cwd, alpha), JSON.stringify(first))
    const started = tool(await serverOf(b1.id), 'cw_start_card', { card: `#${n1}` })
    const slotA = (started.text.match(/folder: ([^;\n]+)/) ?? [])[1]?.trim()
    check("B1's start reply names its slot's folder and line, and says it continues there", !started.isError && !!slotA && /line: cw\//.test(started.text) && /You'll continue in slot-\w+, on cw\//.test(started.text), started.text)
    const inSlot = await until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, slotA) && s.sessionId !== first.sessionId ? s : null
    }, HUNG_MS)
    check('Combwork starts B1 again in the slot, in a new conversation', !!inSlot, JSON.stringify(await live(b1.id)))
    await ready(b1.id)
    const work1 = pluginSkill(b1.id, 'work-on-card')
    check("B1's work-on-card has the slot lines (work and check in the slot; --isolated)", SLOT_LINE.test(work1) && ISOLATED.test(work1), work1.slice(0, 200))
    const b1Server = await serverOf(b1.id)
    const told1 = instructionsOf(b1Server)
    check("…and its hive server's instructions the contract's slot line", CONTRACT.test(told1), told1.slice(0, 300))
    delivered.push(['B1 work-on-card', work1], ['B1 card-loop', pluginSkill(b1.id, 'card-loop')], ['B1 merge-ready', pluginSkill(b1.id, 'merge-ready')], ['B1 contract', told1])

    // B1's work in the slot, submitted, for R1's review.
    fs.writeFileSync(path.join(slotA, 'greet.js'), "module.exports = (name) => 'Hello, ' + name\n")
    lib.git(slotA, ['-c', 'user.name=B1', '-c', 'user.email=b1@example.com', 'commit', '-qam', 'Greeting comma'])
    const submitted = tool(b1Server, 'cw_submit', { card: `#${n1}`, summary: 'Round 1 ready: greet has its comma.' })
    check("B1 submits its card from the slot", !submitted.isError && !!(await until(async () => (await inv('tasks:list')).find((c) => c.number === n1)?.column === 'review', HUNG_MS)), submitted.text)

    // --- 2. R1, a reviewer in the project folder: the review-copy lines, and a start review naming the copy's folder.
    // The card is in Review outside a lane, so Combwork starts R1, the stopped reviewer, for it (HI-2046): waited for, never
    // started here too, which raced Combwork's own start ("already running or starting", HI-2207).
    const rs = await ready(r1.id)
    check('R1 runs in the project folder', same(rs?.cwd, alpha), JSON.stringify(rs))
    const review1 = pluginSkill(r1.id, 'review-agent-work')
    check("R1's review-agent-work has the review-copy line", COPY_LINE.test(review1), review1.slice(0, 200))
    const r1Server = await serverOf(r1.id)
    const reviewing = tool(r1Server, 'cw_start_review', { card: `#${n1}` })
    const copyAt = (reviewing.text.match(/Review in (.+?) at [0-9a-f]{7,}/) ?? [])[1]
    check("R1's start review reply names the review copy's folder, not B1's slot", !reviewing.isError && !!copyAt && /copies/i.test(copyAt) && !same(copyAt, slotA) && fs.existsSync(copyAt), reviewing.text)
    check("…and the files to review by name (never [object Object])", /files: M greet\.js/.test(reviewing.text), reviewing.text)
    delivered.push(['R1 review-agent-work', review1], ['R1 contract', instructionsOf(r1Server)], ['R1 start review', reviewing.text], ['B1 start', started.text])

    // --- 3. Codex: B2 lent a slot for its card, started there.
    const n2 = (await inv('tasks:create', { title: 'Codex card', project: 'alpha' })).number
    const l2 = await inv('slots:test', alpha, { op: 'lend', agent: b2.id, card: n2 })
    check('B2 is lent a slot', l2?.ok && !!l2.slot?.folder, JSON.stringify(l2))
    await inv('session:start', alpha, { agentId: b2.id })
    const s2 = await ready(b2.id)
    check('B2 (Codex) runs in its slot', same(s2?.cwd, l2.slot.folder), JSON.stringify(s2))
    const work2 = copy(l2.slot.folder, 'work-on-card')
    check("B2's copy of work-on-card in the slot has the slot lines", SLOT_LINE.test(work2) && ISOLATED.test(work2), work2.slice(0, 200) || 'no copy')
    const codexLaunch = lines(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => same(l.cwd, l2.slot.folder)).at(-1)
    const told2 = codexLaunch?.args.find((a) => a.startsWith('developer_instructions=')) ?? ''
    check("…and its developer instructions the contract's slot line", CONTRACT.test(told2), told2.slice(0, 300))
    delivered.push(['B2 work-on-card', work2], ['B2 review-agent-work', copy(l2.slot.folder, 'review-agent-work')], ['B2 contract', told2])

    // --- 4. Copilot: B3 lent a slot for its card, started there, its first request's system prompt read.
    if (b3) {
      const n3 = (await inv('tasks:create', { title: 'Copilot card', project: 'alpha' })).number
      const l3 = await inv('slots:test', alpha, { op: 'lend', agent: b3.id, card: n3 })
      await inv('session:start', alpha, { agentId: b3.id })
      const s3 = await ready(b3.id)
      check('B3 (Copilot) runs in its slot', same(s3?.cwd, l3.slot?.folder), JSON.stringify(s3))
      const work3 = copy(l3.slot.folder, 'work-on-card')
      check("B3's copy of work-on-card in the slot has the slot lines", SLOT_LINE.test(work3) && ISOLATED.test(work3), work3.slice(0, 200) || 'no copy')
      await lib.sendPrompt(inv, lib.ptyKey(alpha, b3.id), 'say ready', { submitted: async () => lines(apiLog).length > 0 })
      const system = (await until(() => lines(apiLog).find((l) => l.system)?.system, HUNG_MS)) ?? ''
      check("…and the system prompt it sends the contract's slot line", CONTRACT.test(system), system.slice(0, 300))
      delivered.push(['B3 work-on-card', work3], ['B3 contract', system])
    } else console.log("SKIP Copilot: the GitHub Copilot CLI isn't installed")

    // --- Nothing delivered tells an agent to use a worktree of its own.
    const owning = delivered.filter(([, text]) => OWN.test(text)).map(([what, text]) => `${what}: ${text.match(OWN)[0]}`)
    check(`no delivered text (${delivered.length}) tells an agent to use a worktree of its own`, delivered.every(([, text]) => !!text) && owning.length === 0, owning.join(' | ') || delivered.filter(([, t]) => !t).map(([w]) => `${w}: empty`).join(' | '))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
    if (api) await Promise.resolve(api.close()).catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
