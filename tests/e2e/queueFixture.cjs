// The merge queue's e2e fixture (#1348; later P5 suites add helpers here only): a git project set to "Hive merges" into
// `integration` (a branch checked out in no folder, as #1348's advance needs; the project folder stays on main), with one
// merge check whose behaviour a test steers from outside the repository, fake Claude Code agents acting by their own
// tokens (a builder per card, or one for many, each card on the slot its start lends: no 0.9 worktree agents, #1578; one
// reviewer), and the steps that take a card to approved.
//
// The check is `"<tools>\tool.cmd"`, which runs check.js: it reads control.json (`pass`, `fail`, or `wait` for go.txt
// and then pass), writes its pid to started.txt, and never writes in the folder it runs in (a check must count). Take
// tool.cmd away for a check that can't start (transient). A `wait` gives up after two minutes (a bound for a hung run), or
// the `maxMs` a suite steers it with (p6lane's screenshots while it holds one take minutes on a loaded machine).
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
  lib.gitProject(fx.alpha, { 'a.txt': 'one\ntwo\nthree\n', '.gitignore': '.combwork/\n' })
  lib.git(fx.alpha, ['branch', '-M', 'main'])
  lib.git(fx.alpha, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 (on in queueOptions) reads it from git each time (HI-2266).
  lib.git(fx.alpha, ['config', 'user.name', fx.identity.name])
  lib.git(fx.alpha, ['config', 'user.email', fx.identity.email])
  const check = path.join(fx.tools, 'check.js')
  fs.writeFileSync(
    check,
    [
      "const fs = require('fs')",
      `const control = ${JSON.stringify(fx.control)}, started = ${JSON.stringify(fx.started)}, go = ${JSON.stringify(fx.go)}`,
      "const c = JSON.parse(fs.readFileSync(control, 'utf8'))",
      'fs.writeFileSync(started, String(process.pid))',
      "if (c.mode === 'fail') { console.error('red: ' + (c.say || 'the check failed')); process.exit(1) }",
      "if (c.mode === 'wait') { const t = Date.now(); const tick = () => { if (fs.existsSync(go)) process.exit(0); if (Date.now() - t > (c.maxMs || 120000)) process.exit(3); setTimeout(tick, 100) }; tick() }",
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

/** Sets what the next check does (`pass`, `fail`, `wait`), and clears its last start and go-ahead. `maxMs`: a wait's bound. */
function steer(fx, mode, say, maxMs) {
  for (const f of [fx.started, fx.go]) fs.rmSync(f, { force: true })
  fs.writeFileSync(fx.control, JSON.stringify({ mode, ...(say ? { say } : {}), ...(maxMs ? { maxMs } : {}) }))
}

/**
 * The options "Hive merges" into integration, with the one merge check (G9), set as the project's (no preset: #1355's).
 * Hive's commit message chosen (G19: the branch's own is every preset's since HI-1997), so each merge names its card.
 */
const queueOptions = (fx, over = {}) => ({ review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', commitMessage: 'hive', preChecks: [], mergeChecks: ['quick'], commands: { quick: `"${fx.tool}"` }, identity: fx.identity, okBefore: { mode: 'never', labels: [] }, ...over })

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

/**
 * Adds an agent (`worktree`: in a new worktree of its own; `project`: another project of the workspace than alpha),
 * starts it and reads its token: { id, folder, token }.
 */
async function agent(fx, h, name, { worktree = false, project = fx.alpha } = {}) {
  const a = await lib.addAgent(h.inv, project, { name, ...(worktree ? { location: 'new-worktree' } : {}) })
  const folder = a.worktree?.path ?? project
  // The fake trusts the folders it is told of (its trust prompt never shows), the project's slots too (#1567): an agent
  // left at the prompt in one is never quiet, so Hive never prepares its next card's slot.
  const slotRoot = path.join(`${fx.ws}.worktrees`, path.basename(project))
  const slots = 'abcdefgh'.split('').map((x) => path.join(slotRoot, `slot-${x}`).toLowerCase())
  const trusted = path.join(fx.claudeHome, 'fake-trusted.json')
  const was = fs.existsSync(trusted) ? JSON.parse(fs.readFileSync(trusted, 'utf8')) : []
  fs.writeFileSync(trusted, JSON.stringify([...new Set([...was, fx.ws.toLowerCase(), project.toLowerCase(), folder.toLowerCase(), ...slots])]))
  await h.inv('session:start', project, { agentId: a.id })
  const live = async () => (await h.inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === a.id)
  const got = await liveToken(fx, live)
  return { id: a.id, name, folder, token: got?.token ?? null }
}

/**
 * The live session's own launch and its token (#1615): the launch of the run live now (its private folder is named by
 * the run), read inside the wait. A run Hive ends meanwhile (superseded: a resumed session keeps its id) has its folder
 * removed with its mcp.json, so a read after the wait failed (ENOENT); here the next poll reads the run live then.
 * `where` narrows the live session (in a folder); `stale`, a token an earlier run had, is passed over until a new run's
 * comes: { launch, token }, or null if none came.
 */
async function liveToken(fx, live, where = () => true, stale = null) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  return lib.until(async () => {
    const s = await live()
    if (!s?.runId || !where(s)) return null
    const launch = launches(fx).find((l) => l.opts['--mcp-config'] && path.basename(path.dirname(l.opts['--mcp-config'])) === s.runId)
    const hive = launch ? read(launch.opts['--mcp-config'])?.mcpServers?.hive : null
    const token = hive ? read(hive.env.CW_API_TOKEN_FILE)?.token : null
    return token && token !== stale ? { launch, token } : null
  }, HUNG_MS, 200)
}

/**
 * An agent Hive gave a new conversation (HI-2232: a lane recorded for an idle builder outside slots restarts it, now or
 * once it is free): the new run's token, as each launch has its own (the earlier one's is refused). `project`: the
 * agent's. The agent with it, or with a null token if no new run came.
 */
async function renewed(fx, h, a, project = fx.alpha) {
  const live = async () => (await h.inv('session:live')).find((s) => s.projectPath.toLowerCase() === project.toLowerCase() && s.agentId === a.id)
  const got = await liveToken(fx, live, () => true, a.token)
  return { ...a, token: got?.token ?? null }
}

/**
 * An agent added before (`agent`), started again in a new run of Hive (#1351: suites that restart Hive reuse their
 * agents, under the project's agent limit): its token, which each launch has its own of. Slots held by the run of a Hive
 * that ended at a seam are released first (`releaseHeld`).
 */
async function rejoin(fx, h, a) {
  await releaseHeld(fx, h)
  await h.inv('session:start', fx.alpha, { agentId: a.id })
  const live = async () => (await h.inv('session:live')).find((s) => s.projectPath.toLowerCase() === fx.alpha.toLowerCase() && s.agentId === a.id)
  // This run's launch, never an earlier one's (a resumed session keeps its id).
  const got = await liveToken(fx, live)
  return { ...a, ...(got ? { folder: got.launch.cwd } : {}), token: got?.token ?? null }
}

/**
 * Release Slot… on each slot whose writer is held (#1434, #1506): a builder's run in a Hive that ended without quitting
 * (a seam) keeps its slot until the user releases it, and with one builder the pool soon has no free slot. What the user
 * does after such an end; the queue's own recovery doesn't depend on it. Returns the slots released.
 */
async function releaseHeld(fx, h) {
  const out = []
  for (const s of await h.inv('slots:list', fx.alpha)) {
    if (!s.writer?.held) continue
    const w = await h.inv('slots:heldWriter', fx.alpha, s.name)
    // Refused as changed meanwhile: Hive may have freed it itself since it was read (HI-2055: a gone Hive's writer whose
    // run left nothing running), which is what the release was for (HI-2177): only once a read shows that run no longer
    // holds it. Still held by that run: the release's own failure; the read failing: its error (HR2's round 1).
    if (w) await h.inv('slots:releaseWriter', fx.alpha, s.name, w.run, false).catch(async (e) => {
      const now = await h.inv('slots:heldWriter', fx.alpha, s.name)
      if (now?.run === w.run) throw e
    })
    out.push(s.name)
  }
  return out
}

const sameDir = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * A card started by its builder as 1.0 builds it (#1567, SPEC §16.10): in the folder the start names (a slot lent for it),
 * once Hive has made its line there, the builder followed into it. Hive starts the builder again there in a new
 * conversation unless it already works there, and each launch has its own token: `builder`'s folder and token become
 * that launch's. Returns the start's { status, body }.
 */
async function startCard(fx, h, builder, n) {
  const live = async () => (await h.inv('session:live')).find((s) => s.projectPath.toLowerCase() === fx.alpha.toLowerCase() && s.agentId === builder.id)
  const free = async () => (await h.inv('slots:list', fx.alpha)).some((s) => !s.lease && !s.writer)
  let start = null
  // No slot free yet (the last card's: its builder's session there just ended with its lease, until its processes are
  // known to have ended): as an agent told "Wait for a slot to be free", started again once one is (a few times at most).
  // A start sent as Hive stops it (401, its token ended with that session): once it has, started again.
  for (let tries = 0; tries < 4 && (!start || start.status === 401 || start.body?.rule === 'start.slotAvailable'); tries++) {
    if (start?.status === 401) await lib.until(async () => !(await live()), HUNG_MS, 200)
    else if (start) await lib.until(free, HUNG_MS, 200)
    // Stopped by Hive meanwhile (its session ended with its slot's lease, as a card's Done or its recovery after a seam
    // ends it): started again, with its new launch's token.
    if (!(await live())) Object.assign(builder, await rejoin(fx, h, builder))
    start = await intent(h, builder, n, 'start')
  }
  const { folder, line } = start.body?.data ?? {}
  if (start.status !== 200 || !folder || folder === 'project') return start
  await lib.until(() => (lib.git(folder, ['branch', '--show-current']).trim() === line ? true : null), HUNG_MS, 200).catch(() => null)
  // The run live in the start's folder: a new launch there, or the one it already worked in (its token unchanged).
  const got = await liveToken(fx, live, (s) => sameDir(s.cwd, folder))
  if (got) builder.token = got.token
  builder.folder = folder
  return start
}

/** approve() with a builder of the caller's (one agent for many cards, each on the slot its start lends): { n, revision, steps }. */
async function approveBy(fx, h, builder, reviewer, title, files, opts = {}) {
  const n = (await h.inv('tasks:create', { title, project: 'alpha' })).number
  return { n, ...(await approveCard(fx, h, builder, reviewer, n, title, files, opts)) }
}

/**
 * Card `n` started by `builder` (startCard), `files` committed in its slot, submitted and passed: { revision, steps }.
 * `afterStart`: run once its line is made (from the target's head at its start, #1578), before the commit: a change to the
 * target that the card's must conflict with goes there, as one made before the start is in the card's line already.
 */
async function approveCard(fx, h, builder, reviewer, n, title, files, { afterStart } = {}) {
  const steps = {}
  steps.start = await startCard(fx, h, builder, n)
  if (afterStart) await afterStart(builder)
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(builder.folder, f), text)
  lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'add', '-A'])
  lib.git(builder.folder, ['-c', `user.name=${fx.identity.name}`, '-c', `user.email=${fx.identity.email}`, 'commit', '-qm', title])
  const revision = lib.git(builder.folder, ['rev-parse', 'HEAD']).trim()
  steps.submit = await intent(h, builder, n, 'submit', { summary: `${title}: ready` })
  steps.review = await intent(h, reviewer, n, 'start-review')
  steps.verdict = await intent(h, reviewer, n, 'verdict', { pass: true, comment: `${title}: passed` })
  return { revision, steps }
}

/** An agent's intent on a card (`#n`): its status and reply. */
async function intent(h, who, n, name, body = {}) {
  const res = await fetch(`http://127.0.0.1:${h.port}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * A card taken to approved, so Hive queues it: a new builder in the project folder (#1578: 1.0 adds no worktree agents)
 * starts it on the slot its start lends (startCard), commits `files` there, submits; the reviewer starts its review and
 * passes it. Each card's builder has a slot of its own, as each had a worktree in 0.9. `opts.afterStart`: approveCard's.
 * Returns { n, builder, revision, steps } (each step's status; `builder.folder` its slot).
 */
async function approve(fx, h, reviewer, title, files, opts = {}) {
  const n = (await h.inv('tasks:create', { title, project: 'alpha' })).number
  const builder = await agent(fx, h, `B${n}`)
  return { n, builder, ...(await approveCard(fx, h, builder, reviewer, n, title, files, opts)) }
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

/**
 * Whether a part needing one of the dev build's test seams runs (#1578): a packaged Hive (HIVE_EXE, the Sandbox checks)
 * ignores HIVE_TEST_… and refuses the test channels, so there the part says NOT RUN and the suite's other checks stand.
 */
function devSeam(what) {
  if (!process.env.HIVE_EXE) return true
  console.log(`NOT RUN ${what}: it needs a test seam of the dev build, and HIVE_EXE is a packaged one`)
  return false
}

const head = (fx, ref = 'integration') => lib.git(fx.alpha, ['rev-parse', ref]).trim()

/**
 * The Task Board shown, its button clicked only when it isn't (#1459): clicking it on a shown board toggles the sidebar,
 * which moves the board's cards (280 px in S14) as the next step clicks one.
 */
async function showBoard(page) {
  if (!(await page.locator('.board').isVisible())) await page.getByRole('button', { name: 'Task Board' }).click()
}

/**
 * A card's dialog opened by a click on its title (#1459): a click on the card's middle can land on its reviewer or agent
 * line, which shows that agent instead (stopping the click), and under load the board can still show the review line
 * of a card just reviewed.
 */
async function openByTitle(page, n) {
  await page.locator(`.task-card[data-task="${n}"] .task-title`).click()
}

/**
 * Helpers for suites merging into `main` checked out in the project folder (#1351): the options, the folder's status
 * (tracked files only), Hive's merge commits of a card on main (never two), a file's text as written (any line ending),
 * a card by its title, screenshots in both themes, and a card's For you section in its dialog.
 */
function folderHelpers(fx) {
  return {
    options: (over = {}) => queueOptions(fx, { target: 'main', ...over }),
    status: () => lib.git(fx.alpha, ['status', '--porcelain', '--untracked-files=no']).trim(),
    merges: (key) => lib.git(fx.alpha, ['log', '--format=%s', 'main']).split(/\r?\n/).filter((s) => s.startsWith(`${key}:`)).length,
    text: (file) => (fs.existsSync(path.join(fx.alpha, file)) ? fs.readFileSync(path.join(fx.alpha, file), 'utf8').replace(/\r\n/g, '\n') : null),
    byTitle: async (h, title) => (await h.inv('tasks:list')).find((c) => c.title === title),
    themes: async (page, shot, name) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await shot.screenshot({ path: path.join(fx.shots, `${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    },
    forYouSection: async (h, n) => {
      await showBoard(h.page)
      await openByTitle(h.page, n)
      const d = h.page.locator('.dialog').filter({ has: h.page.locator('.task-title-input') })
      await d.waitFor({ timeout: HUNG_MS })
      return { dialog: d, section: d.locator('[data-section="for-you"]') }
    }
  }
}

/**
 * The merge check as a script of the suite's (#1358: one that reads the merged result, S4's and S13's), in place of
 * check.js until `restoreCheck`. It still writes its pid to started.txt.
 */
function checkWith(fx, name, js) {
  const file = path.join(fx.tools, `${name}.js`)
  fs.writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(fx.started)}, String(process.pid))\n${js}\n`)
  fs.writeFileSync(fx.tool, `@node "${file}"\r\n`)
}

/** The merge check back to check.js (steered by control.json). */
function restoreCheck(fx) {
  fs.writeFileSync(fx.tool, `@node "${path.join(fx.tools, 'check.js')}"\r\n`)
}

/**
 * The Progress panel's Merges tab, opened (#1358): its panel, a target's queue card (`card(target)`) and that card's
 * text with its spaces folded.
 */
async function mergesTab(h, project = 'alpha') {
  const panel = h.page.locator('.progress-panel')
  if (!(await panel.count())) await h.page.locator('.progress-rail').click()
  await lib.until(async () => (await panel.count()) === 1, HUNG_MS, 200)
  await panel.locator('.progress-tab[data-tab="merges"]').click()
  await lib.until(async () => (await panel.locator('.progress-tab-merges').count()) === 1, HUNG_MS, 200)
  const card = (target) => panel.locator(`.progress-queue-card[data-queue="${project}#${target}"]`)
  const text = async (target) => ((await card(target).innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  return { panel, card, text }
}

/**
 * Another Hive's profile on the fixture's workspace (#1358's queuelease: S50, two Hives on one hive.db), set up as
 * prepare sets the fixture's own: the fake Claude Code, quiet, the Agent API on. Returns the fixture with that profile,
 * for startHive.
 */
function otherProfile(fx, suffix) {
  const userData = `${fx.userData}-${suffix}`
  fs.rmSync(userData, { recursive: true, force: true })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  return { ...fx, userData }
}

module.exports = { HUNG_MS, devSeam, queueProject, prepare, steer, queueOptions, startHive, agent, renewed, rejoin,releaseHeld, intent, startCard, approve, approveBy, commitOn, mergeOn, head, launches, folderHelpers, showBoard, openByTitle, checkWith, restoreCheck, mergesTab, otherProfile }
