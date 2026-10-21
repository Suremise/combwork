// For you, the main side (#1269, SPEC §16.8.5, §16.11.4), on fake Claude Code agents (fake-claude/): a builder and a
// reviewer in a lane with a round limit of 1. The reviewer fails the card on the board: Hive asks the user (a request in
// `tasks:forYou`, Decide, with its message for the window), the lane pauses on the card, and a notice says so. The
// user's answer (`tasks:answer`: carry on, one more round) clears it, the lane runs again and the builder is woken with
// the choice, once; an answer to it again is refused. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'foryou-profile')
const ws = path.join(lib.WORK, 'foryou-ws')
const claudeHome = path.join(lib.WORK, 'foryou-claude-home')
const notifyLog = path.join(lib.WORK, 'foryou-notify.jsonl')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47832))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(notifyLog, { force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off', HIVE_TEST_NOTIFY_LOG: notifyLog })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const wakes = (agent) => {
      const f = path.join(claudeHome, 'fake-wakes.jsonl')
      return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((w) => w.agent === agent).map((w) => w.text)
    }
    const told = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8') : '')
    const say = async (id, text) => {
      await inv('pty:write', lib.ptyKey(alpha, id), text)
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const lane = async () => (await inv('lanes:list')).find((l) => l.project === 'alpha')

    await page.getByText('alpha', { exact: true }).first().click()
    const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
    const reviewer = await lib.addAgent(inv, alpha, { name: 'Reviewer' })
    for (const a of [builder, reviewer]) await inv('session:start', alpha, { agentId: a.id })
    check('the agents start', !!(await lib.until(async () => (await idle(builder.id)) && (await idle(reviewer.id)), HUNG_MS)))
    const n = (await inv('tasks:create', { title: 'Tidy the names', project: 'alpha', agent: builder.id })).number
    await inv('tasks:update', n, { column: 'doing', agent: builder.id })
    const key = (await card(n)).key
    // The builder registers its lane (card-loop does) with one round before the user is asked.
    await say(builder.id, `hive hive_lane ${JSON.stringify({ action: 'start', cards: [n], reviewer: 'Reviewer', rounds: 1 })}`)
    check('the lane is registered, with one round', !!(await lib.until(async () => (await lane())?.rounds === 1, HUNG_MS)), JSON.stringify(await lane()))
    await lib.until(() => idle(builder.id), HUNG_MS)
    check('nothing waits for the user yet', (await inv('tasks:forYou')).count === 0)

    // The reviewer fails it: the round limit. For you, the lane paused on it, the user told.
    await say(builder.id, `boardmove ${n} review`)
    await lib.until(async () => (await card(n))?.column === 'review', HUNG_MS)
    await lib.until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), HUNG_MS)
    await say(reviewer.id, `boardreview ${n} start then boardreview ${n} failed`)
    const asked = await lib.until(async () => {
      const f = await inv('tasks:forYou')
      return f.count === 1 && f
    }, HUNG_MS)
    check('the round limit asks the user (For you)', !!asked, JSON.stringify(asked))
    const item = asked ? asked.items[0] : {}
    check('…a Decide request for the card, with its message', item.card === n && item.kind === 'decide' && item.gate === 'roundLimit' && item.shown?.id === 'workflow.forYou.roundLimit' && item.asker === null, JSON.stringify(item))
    check('…in the project too', (await inv('tasks:forYou', 'alpha')).count === 1 && (await inv('tasks:forYou', 'beta')).count === 0)
    check('the lane pauses on it', !!(await lib.until(async () => (await lane())?.state === 'paused' && (await lane())?.pausedOn === n, HUNG_MS)), JSON.stringify(await lane()))
    check('the user is told', !!(await lib.until(async () => told().includes('failed 1 review: carry on with more rounds'), HUNG_MS)), told())

    // An answer that doesn't fit (an approval) is refused; the user's carry on is taken.
    const refused = await inv('tasks:answer', n, item.request, { outcome: 'approved' }).then(() => null, (e) => String(e.message ?? e))
    check("an answer that doesn't fit is refused", /doesn't fit the request/.test(refused ?? ''), refused)
    // The builder hears of the failed verdict first (its loop wake), before the user answers.
    check('the builder is woken with the verdict', !!(await lib.until(async () => wakes('Builder').length === 1, HUNG_MS)), JSON.stringify(wakes('Builder')))
    await lib.until(async () => (await idle(reviewer.id)) && (await idle(builder.id)), HUNG_MS)
    await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 })
    check('answered: nothing waits for the user', (await inv('tasks:forYou')).count === 0)
    check('the lane runs again', !!(await lib.until(async () => (await lane())?.state === 'active', HUNG_MS)), JSON.stringify(await lane()))
    const answerWake = (w) => w.startsWith(`[Hive] ${key} (#${n})`) && w.includes('carry on (1 more round)')
    check('the builder is woken with the answer', !!(await lib.until(async () => wakes('Builder').some(answerWake), HUNG_MS)), JSON.stringify(wakes('Builder')))
    const again = await inv('tasks:answer', n, item.request, { outcome: 'answered', choice: 'carryOn', rounds: 1 }).then(() => null, (e) => String(e.message ?? e))
    check('an answer to it again is refused', !!again, String(again))
    await lib.until(() => idle(builder.id), HUNG_MS)
    check('…and the builder was woken once for it', wakes('Builder').filter(answerWake).length === 1, JSON.stringify(wakes('Builder')))
    // The card's history says whom Hive told of the answer (#1269 round 2), as the card dialog shows it.
    const toldLine = 'Told Builder (alpha) of your answer'
    check("the card's history says whom Hive told of the answer", !!(await lib.until(async () => (await card(n))?.history.some((h) => h.by === 'Hive' && h.what === toldLine), HUNG_MS)), JSON.stringify((await card(n))?.history.map((h) => h.what)))
    await page.getByRole('button', { name: 'Task Board' }).click()
    await page.locator(`.task-card[data-task="${n}"]`).click()
    const dialog = page.locator('.dialog', { hasText: `(#${n})` })
    await dialog.waitFor({ timeout: HUNG_MS })
    await dialog.locator('[data-section="history"]').click()
    const history = dialog.locator('.task-history')
    check('the answer moved nothing: the card is not returned for review by it', (await card(n))?.column === 'review' && !(await card(n))?.history.some((h) => /Returned for review/.test(h.what)), JSON.stringify((await card(n))?.history.map((h) => `${h.by}: ${h.what}`)))
    check('…and the card dialog shows it', !!(await lib.until(async () => (await history.innerText().catch(() => '')).includes(toldLine), HUNG_MS)))
    await history.screenshot({ path: path.join(lib.WORK, 'foryou-history.png') })
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
