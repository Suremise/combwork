// Carrying on (#1432, #966 row 16): Hive's three ways of getting an agent to read its inbox, each with its own switch
// (Settings → Advanced, a project's own in Project Settings → Sessions), on a fake Claude Code and a fake Codex agent
// that both follow Hive's notices (fake-claude/, fake-codex/: a tool's PostToolUse reply and a Stop's reach "the
// model"; a doorbell they read is logged in fake-wakes.jsonl). For each CLI:
// 1. checkpoints on: a message left during a tool is told at that tool's end, read and acked in the same turn;
// 2. checkpoints and Stop continuation off: nothing at the tool's end nor at the Stop, the turn ends as the CLI ends it,
//    and the idle wake delivers it, once;
// 3. idle wakes off (the project's own, Settings' still on): a message for an idle agent isn't typed; it waits in the
//    inbox, the pane shows "1 unread", and its menu's Deliver Now types the line once.
// Then, with idle wakes off in Settings: a card loop's wake (the card arriving in Review for the lane's reviewer) isn't
// typed and waits in the reviewer's inbox, until Deliver Now. Dev build, throwaway profile, workspace, CLAUDE_CONFIG_DIR
// and CODEX_HOME.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'carryingon-profile')
const ws = path.join(lib.WORK, 'carryingon-ws')
const claudeHome = path.join(lib.WORK, 'carryingon-claude-home')
const codexHome = path.join(lib.WORK, 'carryingon-codex-home')
const shots = path.join(lib.WORK, 'carryingon-shots')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47860))
const API = `http://127.0.0.1:${PORT}`
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome, shots]) fs.mkdirSync(d, { recursive: true })
  // Every read of the Claude agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // The Assistant's fake runs in the workspace's folder: trusted too, so a line typed into it isn't taken as the answer.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), ws.toLowerCase()]))
  // Both follow Hive's notices, as a model does: they read their inbox and ack what they listed.
  fs.writeFileSync(path.join(claudeHome, 'fake-follow-notices.txt'), '')
  fs.writeFileSync(path.join(codexHome, 'fake-follow-notices.txt'), '')

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const status = async (id) => (await live(id))?.status
    const idle = async (id) => ['ready', 'finished'].includes(await status(id))
    const say = async (id, text) => {
      // Into Claude Code typed again if a wake of Hive's disturbed it (lib.typeLine, #1560). The fake Codex keeps no input
      // log: typed, then a pause before its Enter on purpose (it reads a typed line before its Enter, as a CLI does).
      if (id !== codex.id) return lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, null, text, { live: () => live(id) })
      await inv('pty:write', lib.ptyKey(alpha, id), text)
      await lib.sleep(300)
      await inv('pty:write', lib.ptyKey(alpha, id), '\r')
    }
    const homeOf = (a) => (a.provider === 'codex' ? codexHome : claudeHome)
    const notices = (a) => lines(path.join(homeOf(a), 'fake-notices.jsonl')).filter((n) => n.agent === a.name)
    const wakes = (a) => lines(path.join(homeOf(a), 'fake-wakes.jsonl')).filter((w) => w.agent === a.name).map((w) => w.text)
    const setSwitch = (which, value) => inv('advanced:set', `cw.inbox.${which}`, value)
    const command = (id) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args: [] })
    const ownNow = async (key) => (await inv('workspace:refresh')).projects.find((x) => x.path.toLowerCase() === alpha.toLowerCase())?.config[key]
    /** The project's own value, chosen in Project Settings → Sessions (inherit, on, off), then back to the Session tab. */
    const setOwn = async (key, value) => {
      await command('project.tab.settings')
      const select = page.locator(`select[data-setting="${key}"]`)
      await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
      await until(async () => (await select.count()) === 1, HUNG_MS)
      await select.selectOption(value)
      const saved = !!(await until(async () => (await ownNow(key)) === value, HUNG_MS))
      await command('project.tab.session')
      return saved
    }

    await page.getByText('alpha', { exact: true }).first().click()
    const claude = { ...(await lib.addAgent(inv, alpha, { name: 'Claude' })), name: 'Claude', provider: 'claude-code' }
    const codex = { ...(await lib.addAgent(inv, alpha, { name: 'Codex', provider: 'codex', permissionMode: 'approve-for-me' })), name: 'Codex', provider: 'codex' }
    for (const a of [claude, codex]) await inv('session:start', alpha, { agentId: a.id })
    check('both agents start', !!(await until(async () => (await idle(claude.id)) && (await idle(codex.id)), HUNG_MS)))

    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const home = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', home, { agentId: 'assistant' })
    await until(async () => (await inv('session:live')).some((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.status === 'ready'), HUNG_MS)
    const tool = (name, args) => {
      const out = execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n',
        env: lib.childEnv({ CW_API_URL: API, CW_WORKSPACE: ws, HIVE_ROLE: 'assistant', HIVE_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, HIVE_API_TOKEN: '', CW_PROJECT: '' }),
        timeout: 60000
      }).toString()
      const r = JSON.parse(out.split('\n')[0]).result
      return { text: r.content[0].text, isError: !!r.isError }
    }
    const delivery = (a, id) => JSON.parse(tool('cw_agent_activity', { project: 'alpha', agent: a.name, detail: true }).text).inbox?.deliveries?.find((d) => d.id === id) ?? null
    const leave = (a, text) => /\((m\d+)/.exec(tool('cw_message_agent', { project: 'alpha', agent: a.name, text }).text)?.[1] ?? null
    /** What the pane shows of the agent's inbox: its ⋯'s description. */
    const paneMore = (a) => page.locator('.pane-header-bar', { hasText: a.name }).locator('.pane-more')
    const paneSays = async (a) => (await paneMore(a).getAttribute('aria-description').catch(() => null)) ?? ''

    /**
     * A turn with a tool call in it, held at both ends by the test: `start` begins it (working, before its tool), `tool`
     * lets the tool run (its PostToolUse: a checkpoint), `end` lets the turn end (its Stop).
     */
    let k = 0
    const heldTurn = (a) => {
      const n = ++k
      if (a.provider === 'codex') {
        // "hold" waits for a "g" typed into it; its turn ends once its tool has (a second hold could miss its key while
        // the checkpoint reads the inbox).
        return { start: () => say(a.id, 'hold then checkpoint'), tool: () => inv('pty:write', lib.ptyKey(alpha, a.id), 'g'), end: async () => undefined, holdsEnd: false }
      }
      const go = (f) => fs.writeFileSync(path.join(claudeHome, f), '')
      return { start: () => say(a.id, `waitfile carry-tool${n} then checkpoint then holduntil carry-end${n}`), tool: () => go(`carry-tool${n}`), end: () => go(`carry-end${n}`), holdsEnd: true }
    }

    for (const a of [claude, codex]) {
      // --- 1. Checkpoints on (as by default): told at the tool's end, read and acked in the turn; nothing typed.
      let turn = heldTurn(a)
      await turn.start()
      check(`${a.name}: works`, !!(await until(async () => (await status(a.id)) === 'working', HUNG_MS)))
      const m1 = leave(a, 'Rebase first.')
      check(`${a.name}: a message for it while it works is queued`, !!m1 && delivery(a, m1)?.state === 'queued', JSON.stringify(delivery(a, m1)))
      await turn.tool()
      check(`${a.name}: checkpoints on: it is told at the tool's end`, !!(await until(() => notices(a).some((x) => x.at === 'checkpoint' && x.text.includes(m1)), HUNG_MS)), JSON.stringify(notices(a)))
      check(`${a.name}: …reads and acks it in its turn`, !!(await until(() => delivery(a, m1)?.state === 'acked', HUNG_MS)) && (!turn.holdsEnd || (await status(a.id)) === 'working'), JSON.stringify(delivery(a, m1)))
      await turn.end()
      check(`${a.name}: …its turn ends, with nothing typed`, !!(await until(() => idle(a.id), HUNG_MS)) && wakes(a).length === 0, JSON.stringify(wakes(a)))

      // --- 2. Checkpoints and Stop continuation off: not told at the tool nor at the Stop; the idle wake delivers once.
      await setSwitch('checkpoints', false)
      await setSwitch('stopContinuation', false)
      const told = notices(a).length
      turn = heldTurn(a)
      await turn.start()
      check(`${a.name}: works again`, !!(await until(async () => (await status(a.id)) === 'working', HUNG_MS)))
      const m2 = leave(a, 'Then take #2.')
      await turn.tool()
      await turn.end()
      // Its turn ends with the message unread (no drain), and then the doorbell names it, once.
      check(`${a.name}: both off: the idle wake delivers it`, !!(await until(() => wakes(a).some((w) => w.includes('Then take #2.')), HUNG_MS)), JSON.stringify(wakes(a)))
      check(`${a.name}: …it reads and acks it, and is idle again`, !!(await until(async () => delivery(a, m2)?.state === 'acked' && (await idle(a.id)), HUNG_MS)), JSON.stringify(delivery(a, m2)))
      check(`${a.name}: …told nothing at the tool's end nor at its Stop`, notices(a).length === told, JSON.stringify(notices(a).slice(told)))
      check(`${a.name}: …and woken once`, wakes(a).filter((w) => w.includes('Then take #2.')).length === 1, JSON.stringify(wakes(a)))
      await setSwitch('checkpoints', null)
      await setSwitch('stopContinuation', null)

      // --- 3. Idle wakes off, the project's own (Settings' on): an idle agent isn't typed into; Deliver Now types it once.
      check(`${a.name}: idle wakes off for the project (Project Settings → Sessions)`, await setOwn('inboxIdleWakes', 'off'))
      const before = wakes(a).length
      const m3 = leave(a, 'Review #3 next.')
      check(`${a.name}: idle wakes off: a message for it idle stays queued`, !!m3 && delivery(a, m3)?.state === 'queued' && (await idle(a.id)), JSON.stringify(delivery(a, m3)))
      check(`${a.name}: …its pane shows it unread`, !!(await until(async () => /1 unread/.test(await paneSays(a)), HUNG_MS)), await paneSays(a))
      await paneMore(a).click()
      await page.locator('.menu .menu-item', { hasText: '1 unread' }).click()
      const deliver = page.locator('.menu .menu-item', { hasText: /^\s*Deliver Now\s*$/ })
      check(`${a.name}: …its menu says nothing is typed by itself, and offers Deliver Now`, !!(await until(async () => (await deliver.count()) === 1 && (await page.locator('.menu', { hasText: 'Wake an idle agent is off' }).count()) > 0, HUNG_MS)))
      if (a === claude) {
        await page.screenshot({ path: path.join(shots, 'carryingon-pane.png') })
      }
      check(`${a.name}: …still not typed, the message still queued`, wakes(a).length === before && delivery(a, m3)?.state === 'queued', JSON.stringify({ wakes: wakes(a).slice(before), d: delivery(a, m3) }))
      await deliver.click()
      check(`${a.name}: Deliver Now types its line, once`, !!(await until(() => wakes(a).some((w) => w.includes('Review #3 next.')), HUNG_MS)), JSON.stringify(wakes(a)))
      check(`${a.name}: …it reads and acks it`, !!(await until(async () => delivery(a, m3)?.state === 'acked' && (await idle(a.id)), HUNG_MS)), JSON.stringify(delivery(a, m3)))
      check(`${a.name}: …and nothing more is typed`, wakes(a).length === before + 1, JSON.stringify(wakes(a).slice(before)))
      await setOwn('inboxIdleWakes', 'inherit')
    }

    // --- 4. A card loop's wake with idle wakes off in Settings: not typed, it waits in the reviewer's inbox.
    await setSwitch('idleWakes', false)
    const n = (await inv('tasks:create', { title: 'Carry on', project: 'alpha', agent: codex.id })).number
    await inv('tasks:update', n, { column: 'doing', agent: codex.id })
    await say(codex.id, `hive cw_lane ${JSON.stringify({ action: 'start', cards: [n], reviewer: 'Claude' })}`)
    check('the lane is registered', !!(await until(async () => (await inv('lanes:list')).some((l) => l.reviewer?.id === claude.id), HUNG_MS)))
    await until(() => idle(codex.id), HUNG_MS)
    const before = wakes(claude).length
    await say(codex.id, `boardmove ${n} review`)
    const loopWake = async () => (await live(claude.id))?.inbox?.unread.find((m) => m.state === 'queued' && /is in Review/.test(m.text)) ?? null
    check('a loop wake for the reviewer is made, and waits in its inbox', !!(await until(loopWake, HUNG_MS)), JSON.stringify((await live(claude.id))?.inbox))
    check("…isn't typed while it's idle", (await idle(claude.id)) && wakes(claude).length === before && !!(await loopWake()), JSON.stringify(wakes(claude).slice(before)))
    check('…its pane shows it', !!(await until(async () => /1 unread/.test(await paneSays(claude)), HUNG_MS)), await paneSays(claude))
    const typed = await inv('session:deliverNow', alpha, claude.id)
    check('Deliver Now types it once', typed === true && !!(await until(() => wakes(claude).length === before + 1, HUNG_MS)) && /is in Review/.test(wakes(claude).at(-1) ?? ''), JSON.stringify({ typed, wakes: wakes(claude).slice(before) }))

    // --- 5. The Assistant follows Settings' switch (it has no project): its watch's wake waits in its inbox, its panel's ⋯
    // shows it unread, and Deliver Now there types its line once.
    const asst = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase())
    // Typed again if a wake of Hive's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(home, 'assistant'), claudeHome, null, `hive cw_wait_for_tasks ${JSON.stringify({ cards: [n], changes: ['comment'], wake: true })}`, { live: asst })
    check('the Assistant watches the card', !!(await until(async () => (await asst())?.status === 'watching', HUNG_MS)), (await asst())?.status)
    await inv('tasks:comment', n, 'A note for the watch.')
    const asstUnread = async () => (await asst())?.inbox?.unread ?? []
    check("its watch's wake waits in its inbox, not typed", !!(await until(async () => (await asstUnread()).some((m) => m.state === 'queued'), HUNG_MS)), JSON.stringify(await asstUnread()))
    await page.keyboard.press('Control+Alt+I')
    const asstMore = page.locator('.assistant-header button[aria-label="More"]')
    check("…its panel's ⋯ shows it unread", !!(await until(async () => /1 unread/.test((await asstMore.getAttribute('aria-description').catch(() => null)) ?? '') && (await asstMore.locator('.pane-more-badge').count()) === 1, HUNG_MS)))
    await asstMore.click()
    const asstDeliver = page.locator('.menu .menu-item', { hasText: /^\s*Deliver Now\s*$/ })
    check('…its ⋯ says nothing is typed by itself, and offers Deliver Now', !!(await until(async () => (await asstDeliver.count()) === 1 && (await page.locator('.menu', { hasText: 'Wake an idle agent is off' }).count()) > 0, HUNG_MS)))
    await page.screenshot({ path: path.join(shots, 'carryingon-assistant.png') })
    check('…still queued before it is pressed', (await asstUnread()).some((m) => m.state === 'queued'), JSON.stringify(await asstUnread()))
    await asstDeliver.click()
    check('Deliver Now types its line: it reads its inbox, and nothing is left unread', !!(await until(async () => (await asstUnread()).length === 0, HUNG_MS)), JSON.stringify(await asstUnread()))
    await page.keyboard.press('Control+Alt+I')
    await setSwitch('idleWakes', null)

    // --- The rows, for the review's screenshots (light and dark): Settings → Advanced's three switches with the link to
    // the Agent API's setting, and Project Settings → Sessions' own of each.
    const themed = async (name) => {
      for (const theme of ['light', 'dark']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? document.body.className)).includes(theme), HUNG_MS)
        await page.screenshot({ path: path.join(shots, `carryingon-${name}-${theme}.png`) })
      }
    }
    await setSwitch('idleWakes', false)
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    await page.getByRole('textbox', { name: 'Search settings' }).fill('inbox')
    const rows = page.locator('.advanced-row[data-advanced^="cw.inbox."]')
    check('Advanced lists the three switches, with the inbox note linking to the Agent API', !!(await until(async () => (await rows.count()) === 3 && (await page.locator('[data-note="inbox-available"]', { hasText: 'Agents can read their inbox' }).count()) === 1, HUNG_MS)), String(await rows.count()))
    await rows.first().evaluate((e) => e.scrollIntoView({ block: 'start' }))
    await themed('advanced')
    await page.locator('[data-note="inbox-available"] [data-action="open-agent-api"]').click()
    check('…whose button shows Settings → Agent API', !!(await until(async () => (await page.locator('.settings-nav .row.selected', { hasText: 'Agent API' }).count()) === 1, HUNG_MS)))
    await page.keyboard.press('Escape')
    await setOwn('inboxCheckpoints', 'off')
    await command('project.tab.settings')
    await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
    const own = page.locator('select[data-setting="inboxIdleWakes"]')
    check("Project Settings → Sessions has the project's own of each, Inherit naming Settings' value", !!(await until(async () => (await page.locator('select[data-setting^="inbox"]').count()) === 3 && /Inherit \(off\)/i.test(await own.locator('option[value="inherit"]').innerText()), HUNG_MS)))
    await page.locator('select[data-setting="inboxCheckpoints"]').scrollIntoViewIfNeeded()
    await themed('project')
    await setOwn('inboxCheckpoints', 'inherit')
    await setSwitch('idleWakes', null)
  } catch (e) {
    check('no error', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
