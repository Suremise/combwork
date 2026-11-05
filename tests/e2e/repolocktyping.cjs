// Typing while the repository lock is taken (HI-1680): a keystroke into a pane goes through main, so a lock step that
// holds main's thread (its SQLite busy wait, its commits' fsyncs) delayed what the user typed. The lock's steps now
// run in a worker of their own. Here a project's lock file is held by another connection (as another Combwork's commit
// holds it), so each take of a burst of Git view switches waits in SQLite's busy wait (a second) and fails, while
// letters are typed into a fake Claude Code's pane: main's longest stall (a timer in main) and each letter's echo stay
// well under that second. A burst of switches with the lock free, the line updater's kind of burst, is timed too, for
// the log. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
/** How many takes a burst has (the line updater moved about ten lines after a merge). */
const BURST = 6
/** A stall or an echo this long is main held up: the busy wait it would sit in is a second. */
const HELD_MS = 600

const userData = path.join(lib.WORK, 'repolocktyping-profile')
const ws = path.join(lib.WORK, 'repolocktyping-ws')
const claudeHome = path.join(lib.WORK, 'repolocktyping-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const first = lib.git(beta, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  lib.git(beta, ['branch', 'other'])
  const env = lib.fakeClaude(userData, claudeHome, [alpha])
  const { app, page, inv } = await lib.launch({ userData, env })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Typist' })
  await inv('session:start', alpha, { agentId: agent.id })
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  check('the agent starts', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)), JSON.stringify((await live())?.status ?? null))
  const key = lib.ptyKey(alpha, agent.id)
  const host = page.locator(`.terminal-host[data-pty="${key.replace(/\\/g, '\\\\')}"]`)
  check('its pane shows', !!(await lib.until(async () => (await host.count()) === 1, HUNG_MS)))
  await host.click()

  // Main's longest gap between ticks of a timer of its own, since the last reset (the one open now included).
  await app.evaluate(() => {
    const g = (globalThis.__lockGap = { last: performance.now(), max: 0 })
    globalThis.__lockGapTimer = setInterval(() => {
      const now = performance.now()
      g.max = Math.max(g.max, now - g.last)
      g.last = now
    }, 5)
  })
  const resetGap = () => app.evaluate(() => Object.assign(globalThis.__lockGap, { last: performance.now(), max: 0 }))
  const gap = () => app.evaluate(() => Math.round(Math.max(globalThis.__lockGap.max, performance.now() - globalThis.__lockGap.last)))

  // Typed letters, each timed from its key to its echo on the agent's input line.
  let typed = ''
  const echoes = []
  const lines = () => page.evaluate((k) => window.__hiveTerminalLines(k) ?? [], key)
  async function typeOne() {
    const ch = String.fromCharCode(97 + (typed.length % 26))
    const want = typed + ch
    const t = Date.now()
    await page.keyboard.type(ch)
    const seen = await lib.until(async () => (await lines()).some((l) => l.trimEnd().endsWith(want)), HUNG_MS)
    typed = want
    echoes.push(seen ? Date.now() - t : Infinity)
    // A short line, so it never wraps: cleared (Ctrl+U, as in Claude Code) every 20 letters, untimed.
    if (typed.length < 20) return
    await page.keyboard.press('Control+U')
    if (!(await lib.until(async () => !(await lines()).some((l) => l.includes(typed)), HUNG_MS))) throw new Error("the agent's input line wasn't cleared")
    typed = ''
  }
  /** Types while `burst` runs, and once more after it: what each letter waited, and the burst's own time. */
  async function typeDuring(burst) {
    echoes.length = 0
    await resetGap()
    const t = Date.now()
    const state = { done: false }
    const run = burst().finally(() => (state.done = true))
    while (!state.done) await typeOne()
    await typeOne()
    await run
    return { ms: Date.now() - t, gap: await gap(), echo: Math.max(...echoes), letters: echoes.length }
  }
  /** Switches beta's branch BURST times, to and fro (or each time to `to`: one the folder isn't on, which takes the lock). */
  const switches = async (to = null) => {
    const out = []
    for (let i = 0; i < BURST; i++) out.push(await inv('git:switch', beta, to ?? (i % 2 ? first : 'other')).then(() => 'ok', (e) => String(e.message ?? e)))
    return out
  }

  // A burst with the lock free: each switch takes and releases it (the commits' fsyncs, quick on an idle disk).
  let results = []
  const free = await typeDuring(async () => (results = await switches()))
  check('a burst of switches with the lock free switches each time', results.every((r) => r === 'ok'), JSON.stringify(results))
  console.log(`burst with the lock free: ${BURST} takes in ${free.ms} ms; main's longest stall ${free.gap} ms; slowest echo ${free.echo} ms of ${free.letters} letters`)

  // The lock file held by another connection: each take waits in SQLite's busy wait, then fails, nothing changed.
  const other = new DatabaseSync(path.join(beta, '.git', 'hive-merge.lock'))
  other.exec('BEGIN IMMEDIATE')
  let held
  try {
    held = await typeDuring(async () => (results = await switches('other')))
  } finally {
    other.exec('ROLLBACK')
    other.close()
  }
  check('with the lock file held, each switch fails, saying it is locked', results.every((r) => /locked|busy/i.test(r)), JSON.stringify(results))
  console.log(`burst with the lock file held: ${BURST} takes in ${held.ms} ms; main's longest stall ${held.gap} ms; slowest echo ${held.echo} ms of ${held.letters} letters`)
  check(`main isn't held up while the takes wait (its longest stall under ${HELD_MS} ms)`, held.gap < HELD_MS, `${held.gap} ms`)
  check(`every letter typed meanwhile echoes within ${HELD_MS} ms`, held.echo < HELD_MS, `${held.echo} ms`)
  check('the branch is as the last switch with the lock free left it', lib.git(beta, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === (BURST % 2 ? 'other' : first))

  await app.evaluate(() => clearInterval(globalThis.__lockGapTimer))
  await inv('session:stop', alpha, agent.id)
  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
