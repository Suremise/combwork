// The merge queue's e2e fixture (#1348; later P5 suites add helpers here only): a git project set to "Hive merges" into
// `integration` (a branch checked out in no folder, as #1348's advance needs; the project folder stays on main), with one
// merge check whose behaviour a test steers from outside the repository, fake Claude Code agents acting by their own
// tokens (a builder per card, each in its own worktree; one reviewer), and the steps that take a card to approved.
//
// The check is `"<tools>\tool.cmd"`, which runs check.js: it reads control.json (`pass`, `fail`, or `wait` for go.txt
// and then pass), writes its pid to started.txt, and never writes in the folder it runs in (a check must count). Take
// tool.cmd away for a check that can't start (transient).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

/** A suite's queue project, its folders under the suite's work folder (`name-…`). */
function queueProject(name) {
  const at = (x) => path.join(lib.WORK, `${name}-${x}`)
  const fx = { name, userData: at('profile'), ws: at('ws'), claudeHome: at('claude-home'), tools: at('tools'), shots: at('shots') }
  fx.alpha = path.join(fx.ws, 'alpha')
  fx.control = path.join(fx.tools, 'control.json')
  fx.started = path.join(fx.tools, 'started.txt')
  fx.go = path.join(fx.tools, 'go.txt')
  fx.tool = path.join(fx.tools, 'tool.cmd')
  fx.identity = { name: 'Hive Queue Test', email: 'queue@example.com' }
  return fx
}

/** Makes the project, its check and the profile: the project on main, `integration` at the same commit. */
function prepare(fx) {
  for (const d of [fx.userData, fx.ws, fx.claudeHome, fx.tools, fx.shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [fx.claudeHome, fx.tools, fx.shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(fx.alpha, { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': '.hive/\n' })
  lib.git(fx.alpha, ['branch', '-M', 'main'])
  lib.git(fx.alpha, ['branch', 'integration'])
  const check = path.join(fx.tools, 'check.js')
  fs.writeFileSync(
    check,
    [
      "const fs = require('fs')",
      `const control = ${JSON.stringify(fx.control)}, started = ${JSON.stringify(fx.started)}, go = ${JSON.stringify(fx.go)}`,
      "const c = JSON.parse(fs.readFileSync(control, 'utf8'))",
      'fs.writeFileSync(started, String(process.pid))',
      "if (c.mode === 'fail') { console.error('red: ' + (c.say || 'the check failed')); process.exit(1) }",
      "if (c.mode === 'wait') { const t = Date.now(); const tick = () => { if (fs.existsSync(go)) process.exit(0); if (Date.now() - t > 120000) process.exit(3); setTimeout(tick, 100) }; tick() }",
      ''
    ].join('\n')
  )
  fs.writeFileSync(fx.tool, `@node "${check}"\r\n`)
  steer(fx, 'pass')
  lib.enableProviders(fx.userData)
  const cfgFile = path.join(fx.userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
}

/** Sets what the next check does (`pass`, `fail`, `wait`), and clears its last start and go-ahead. */
function steer(fx, mode, say) {
  for (const f of [fx.started, fx.go]) fs.rmSync(f, { force: true })
  fs.writeFileSync(fx.control, JSON.stringify({ mode, ...(say ? { say } : {}) }))
}

/** The options "Hive merges" into integration, with the one merge check (G9), set as the project's (no preset: #1355's). */
const queueOptions = (fx, over = {}) => ({ review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: ['quick'], commands: { quick: `"${fx.tool}"` }, identity: fx.identity, okBefore: { mode: 'never', labels: [] }, ...over })

/**
 * Launches Hive on the fixture (its profile, a port, CLAUDE_CONFIG_DIR) and opens the workspace; sets the options
 * unless `keepOptions`. The page's helpers: inv, card, facts, kinds.
 */
async function startHive(fx, { port, env = {}, keepOptions = false } = {}) {
  const { app, page, inv } = await lib.launch({ userData: fx.userData, env: { HIVE_API_PORT: String(port), CLAUDE_CONFIG_DIR: fx.claudeHome, HIVE_TEST_TIPS: 'off', ...env } })
  await lib.openWorkspace(inv, page, fx.ws)
  if (!keepOptions) await inv('workflow:setOptions', fx.alpha, { preset: null, options: queueOptions(fx) })
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
  const facts = async (n) => inv('tasks:facts', n)
  const kinds = async (n) => (await facts(n)).map((f) => f.kind)
  return { app, page, inv, port, card, facts, kinds }
}

/** The fake agents' launches (fake-launches.jsonl), as their hive tools read their tokens. */
function launches(fx) {
  const f = path.join(fx.claudeHome, 'fake-launches.jsonl')
  const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

/** Adds an agent (`worktree`: in a new worktree of its own), starts it and reads its token: { id, folder, token }. */
async function agent(fx, h, name, { worktree = false } = {}) {
  const a = await lib.addAgent(h.inv, fx.alpha, { name, ...(worktree ? { location: 'new-worktree' } : {}) })
  const folder = a.worktree?.path ?? fx.alpha
  // The fake trusts the folders it is told of (its trust prompt never shows).
  const trusted = path.join(fx.claudeHome, 'fake-trusted.json')
  const was = fs.existsSync(trusted) ? JSON.parse(fs.readFileSync(trusted, 'utf8')) : []
  fs.writeFileSync(trusted, JSON.stringify([...new Set([...was, fx.ws.toLowerCase(), fx.alpha.toLowerCase(), folder.toLowerCase()])]))
  await h.inv('session:start', fx.alpha, { agentId: a.id })
  const live = async () => (await h.inv('session:live')).find((s) => s.projectPath.toLowerCase() === fx.alpha.toLowerCase() && s.agentId === a.id)
  const sessionId = await lib.until(async () => (await live())?.sessionId, HUNG_MS, 200)
  const launch = await lib.until(() => launches(fx).find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS, 200)
  const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
  const token = hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
  return { id: a.id, name, folder, token }
}

/** An agent's intent on a card (`#n`): its status and reply. */
async function intent(h, who, n, name, body = {}) {
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * A card taken to approved, so Hive queues it: a new builder (its own worktree) starts it, commits `files` there,
 * submits; the reviewer starts its review and passes it. Returns { n, builder, revision, steps } (each step's status).
 */
async function approve(fx, h, reviewer, title, files) {
  const n = (await h.inv('tasks:create', { title, project: 'alpha' })).number
  const builder = await agent(fx, h, `B${n}`, { worktree: true })
  const steps = {}
  steps.start = await intent(h, builder, n, 'start')
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(builder.folder, f), text)
  lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
  lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', title])
  const revision = lib.git(builder.folder, ['rev-parse', 'HEAD']).trim()
  steps.submit = await intent(h, builder, n, 'submit', { summary: `${title}: ready` })
  steps.review = await intent(h, reviewer, n, 'start-review')
  steps.verdict = await intent(h, reviewer, n, 'verdict', { pass: true, comment: `${title}: passed` })
  return { n, builder, revision, steps }
}

/** A commit on a branch checked out nowhere (as another person's push would land), through a worktree of its own. */
function commitOn(fx, branch, files, message) {
  const tmp = lib.probeDir(`${fx.name}-commit`)
  const dir = path.join(tmp, 'wt')
  lib.git(fx.alpha, ['worktree', 'add', '-q', dir, branch])
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  lib.git(dir, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
  lib.git(dir, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', message])
  lib.git(fx.alpha, ['worktree', 'remove', '--force', dir])
  return lib.git(fx.alpha, ['rev-parse', branch]).trim()
}

/** A hand merge of a revision into a branch checked out nowhere (someone merging outside Hive). */
function mergeOn(fx, branch, revision, message) {
  const tmp = lib.probeDir(`${fx.name}-merge`)
  const dir = path.join(tmp, 'wt')
  lib.git(fx.alpha, ['worktree', 'add', '-q', dir, branch])
  lib.git(dir, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'merge', '--no-ff', '-qm', message, revision])
  lib.git(fx.alpha, ['worktree', 'remove', '--force', dir])
  return lib.git(fx.alpha, ['rev-parse', branch]).trim()
}

const head = (fx, ref = 'integration') => lib.git(fx.alpha, ['rev-parse', ref]).trim()

module.exports = { HUNG_MS, queueProject, prepare, steer, queueOptions, startHive, agent, intent, approve, commitOn, mergeOn, head, launches }
