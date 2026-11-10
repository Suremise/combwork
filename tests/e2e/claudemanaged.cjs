// Claude Code under an organisation's managed policy (HI-2777), on the fake Claude Code with a managed settings file in its
// own home (fake-managed, which the fake reads as Claude Code reads Program Files' and Combwork reads as
// CW_TEST_CLAUDE_MANAGED_DIR; the PC's own managed settings and registry are never read or touched):
// 1. allowManagedHooksOnly without Combwork's hooks: none arrive, and the warning names the setting and where it was
//    found, with Admin snippet… on the banner; the dialog shows the snippet with this Combwork's port;
// 2. the snippet pasted with allowManagedHooksOnly: the agent's hooks arrive through the managed handlers alone
//    (SessionStart through its PowerShell command, the others over HTTP to the fixed URL), each once, a lock decision
//    made on an edit, and its status line read;
// 3. the snippet without allowManagedHooksOnly: Combwork's own handlers and the snippet's are identical, so the CLI runs
//    each once, and nothing arrives twice;
// 4. a hook timeout changed after the snippet was pasted: the handlers differ, the CLI runs both, and Combwork handles
//    each tool call and prompt once and says the hooks arrive twice;
// 5. no managed settings (HI-2850): a busy turn (messages taken in mid-turn under its prompt_id, the same text twice, a
//    foreground sub-agent's tool calls, a card watch) has every event handled and nothing said to arrive twice;
// 6. a snippet posting to another URL: every hook really arrives twice; the same busy turn has each event handled once.
// Dev build, throwaway profile, workspace and CLI home. Nothing signs in or spends tokens.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'claudemanaged-profile')
const ws = path.join(lib.WORK, 'claudemanaged-ws')
const claudeHome = path.join(lib.WORK, 'claudemanaged-claude-home')
const managedDir = path.join(claudeHome, 'fake-managed')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47938))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = lib.until

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'x.txt': 'x\n' })
  const cenv = lib.fakeClaude(userData, claudeHome, [alpha])
  fs.mkdirSync(managedDir, { recursive: true })
  const writeManaged = (json) => fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify(json, null, 2))
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.hooks.missingSeconds': 3 } }, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...cenv, CW_TEST_CLAUDE_MANAGED_DIR: managedDir, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.setOwnOptions(inv, alpha, { fileLocks: 'block' })
    const agent = await lib.addAgent(inv, alpha, { name: 'Ann' })
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === agent.id)
    const raw = async () => (await inv('pty:buffer', lib.ptyKey(alpha, agent.id)).catch(() => '')) ?? ''
    const say = async (text) => {
      const mark = (await raw()).length
      return lib.sendPrompt(inv, lib.ptyKey(alpha, agent.id), text, { submitted: async () => /esc to interrupt|Worked for/.test(lib.plainText((await raw()).slice(mark))) })
    }
    const fakeLog = path.join(claudeHome, 'fake-managed-hooks.jsonl')
    const fakeRows = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
    const fired = async () => ((await inv('session:hooks', alpha, agent.id).catch(() => null))?.fired ?? []).map((f) => f.event)
    const count = (list, ev) => list.filter((e) => e === ev).length
    const start = async () => {
      await inv('session:start', alpha, { agentId: agent.id })
      return !!(await until(async () => !!(await live())?.runId, HUNG_MS))
    }
    const stop = async () => {
      await inv('session:stop', alpha, agent.id)
      await until(async () => !(await live()), HUNG_MS)
      fs.rmSync(fakeLog, { force: true })
    }
    /**
     * A busy turn (HI-2850), as HB3's on 10 Nov: two messages taken in mid-turn (each a UserPromptSubmit under the turn's
     * prompt_id, its own text), the same text taken twice at two tool boundaries, a foreground sub-agent's two tool calls,
     * and a card watch, to its end. Each is an event of its own, so each is handled: five prompts, seven tool calls
     * (four Bash, the Agent call, its sub-agent's two Reads), one SubagentStop.
     */
    const card = (await inv('tasks:create', { title: 'Watched while busy', project: 'alpha', agent: agent.id, column: 'doing' })).number
    const busyTurn = async (label) => {
      check(`${label}: a busy turn goes to work`, (await say(`queued 2 then queuedsame 2 then subtools 2 then cw cw_wait_for_tasks ${JSON.stringify({ cards: [card], column: 'done', wake: true, limitMinutes: 60 })}`)) > 0)
      check(`${label}: it ends watching the card`, !!(await until(async () => (await live())?.status === 'watching' && (await fired()).includes('Stop'), HUNG_MS)), JSON.stringify((await live())?.status))
      const f = await fired()
      check(`${label}: every prompt (the turn's, two queued, the same text twice), tool call and SubagentStop handled once`, count(f, 'UserPromptSubmit') === 5 && count(f, 'PreToolUse') === 7 && count(f, 'PostToolUse') === 7 && count(f, 'SubagentStop') === 1, JSON.stringify(f))
    }
    /** A prompt with an edit of x.txt and its status line's model, to its end: every event Combwork takes, once each. */
    const turn = async (model) => {
      check(`a prompt (${model}) goes to work`, (await say(`edit x.txt statusmodel ${model}`)) > 0)
      return !!(await until(async () => (await live())?.status === 'finished' && (await fired()).includes('Stop'), HUNG_MS))
    }

    // ---- 1. Only managed hooks, and Combwork's aren't there: the warning names the setting and where it was found.
    writeManaged({ allowManagedHooksOnly: true })
    check('1: the agent starts', await start())
    const missing = await until(async () => (await live())?.hooksMissing, HUNG_MS)
    check('1: its hooks are missing, the cause named: allowManagedHooksOnly in the managed settings file', missing?.why === 'managedOnly' && missing?.setting === 'allowManagedHooksOnly' && /managed settings/i.test(missing?.offIn ?? '') && missing?.snippet === true, JSON.stringify(missing))
    const banner = page.locator('.banner.hooks-missing')
    check('1: the banner says so and offers the admin snippet', /allowManagedHooksOnly/.test((await banner.innerText().catch(() => '')) ?? '') && (await banner.getByRole('button', { name: 'Admin snippet…' }).count()) === 1, await banner.innerText().catch(() => ''))
    await banner.getByRole('button', { name: 'Admin snippet…' }).click()
    const dialog = page.locator('.dialog', { hasText: 'Claude Code admin snippet' })
    const area = dialog.locator('textarea.admin-snippet')
    await area.waitFor({ timeout: HUNG_MS })
    await until(async () => (await area.inputValue()).length > 0, HUNG_MS)
    const snippet = JSON.parse(await area.inputValue())
    const urls = JSON.stringify(snippet).match(/http:\/\/127\.0\.0\.1:\d+\/hook/g) ?? []
    check("1: the snippet's HTTP hooks post to this Combwork's fixed URL; it has a SessionStart command and a status line", urls.length > 0 && urls.every((u) => u === `http://127.0.0.1:${PORT}/hook`) && /EncodedCommand/.test(snippet.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '') && snippet.statusLine?.type === 'command', JSON.stringify(snippet).slice(0, 400))
    check('1: the snippet holds no token', !/[0-9a-f]{48}/.test(JSON.stringify(snippet)))
    // The warning's toast would cover the dialog: dismissed first (its own close button).
    while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await dialog.screenshot({ path: path.join(lib.WORK, `claudemanaged-snippet-${theme}.png`) })
    }
    await page.keyboard.press('Escape')
    await stop()

    // ---- 2. The snippet pasted, with only managed hooks: every hook comes through it, once.
    writeManaged({ ...snippet, allowManagedHooksOnly: true })
    // Ready before any turn: a fresh start.
    check('2: the agent starts, its SessionStart through the managed command', (await start()) && !!(await until(async () => (await live())?.status === 'ready', HUNG_MS)))
    check('2: a turn ends finished', await turn('managed-model-2'))
    const f2 = await fired()
    check('2: each event arrived once (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop)', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((e) => count(f2, e) === 1), JSON.stringify(f2))
    check('2: the fake ran only the managed handlers (one per event)', fakeRows().length > 0 && fakeRows().every((r) => r.handlers === 1), JSON.stringify(fakeRows().slice(0, 6)))
    check('2: its status line was read (the model it reported)', !!(await until(async () => (await live())?.modelName === 'managed-model-2', HUNG_MS)), JSON.stringify(await live().then((l) => l?.modelName)))
    check('2: no hooks missing, none doubled', !(await live())?.hooksMissing && !(await live())?.hooksDoubled)
    await stop()

    // ---- 3. The snippet without allowManagedHooksOnly: identical handlers, run once by the CLI.
    writeManaged(snippet)
    // Ready before any turn: a fresh start.
    check('3: the agent starts', (await start()) && !!(await until(async () => (await live())?.status === 'ready', HUNG_MS)))
    check('3: a turn ends finished', await turn('managed-model-3'))
    const f3 = await fired()
    check('3: each event arrived once', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((e) => count(f3, e) === 1), JSON.stringify(f3))
    check("3: Combwork's handler and the snippet's were one (the fake ran one per event)", fakeRows().length > 0 && fakeRows().every((r) => r.handlers === 1), JSON.stringify(fakeRows().slice(0, 6)))
    check('3: not doubled', !(await live())?.hooksDoubled)
    await stop()

    // ---- 4. A timeout changed after pasting: the handlers differ, both run, Combwork handles tool calls and prompts once.
    await inv('advanced:set', 'claude-code.hooks.timeoutSeconds', 7)
    // Ready before any turn: a fresh start.
    check('4: the agent starts', (await start()) && !!(await until(async () => (await live())?.status === 'ready', HUNG_MS)))
    check('4: a turn ends finished', await turn('managed-model-4'))
    const f4 = await fired()
    // As Claude Code 2.1.319 does: HTTP handlers of one URL run once whatever their timeouts; the SessionStart commands
    // differ (the timeout is in the command), so both run.
    check('4: the fake ran both SessionStart commands, and one HTTP handler per event (same URL)', fakeRows().some((r) => r.event === 'SessionStart' && r.handlers === 2) && fakeRows().filter((r) => r.event !== 'SessionStart').every((r) => r.handlers === 1), JSON.stringify(fakeRows().slice(0, 6)))
    check('4: SessionStart (startup) was handled once', count(f4, 'SessionStart') === 1, JSON.stringify(f4))
    check('4: the tool call and the prompt were each handled once', count(f4, 'PreToolUse') === 1 && count(f4, 'PostToolUse') === 1 && count(f4, 'UserPromptSubmit') === 1, JSON.stringify(f4))
    check('4: Combwork says its hooks arrive twice', !!(await until(async () => (await live())?.hooksDoubled, HUNG_MS)))
    check('4: the banner says so and offers the admin snippet', !!(await until(async () => /twice/.test((await page.locator('.banner.hooks-doubled').innerText().catch(() => '')) ?? ''), HUNG_MS)))
    await page.locator('.banner.hooks-doubled').screenshot({ path: path.join(lib.WORK, 'claudemanaged-doubled.png') })
    await stop()
    await inv('advanced:set', 'claude-code.hooks.timeoutSeconds', 5)

    // ---- 5. No managed settings at all (Darren's PC, HI-2850): a busy turn is never taken for hooks arriving twice.
    fs.rmSync(path.join(managedDir, 'managed-settings.json'), { force: true })
    check('5: the agent starts', (await start()) && !!(await until(async () => (await live())?.status === 'ready', HUNG_MS)))
    await busyTurn('5')
    check("5: the fake ran Combwork's handlers alone", fakeRows().length === 0)
    check('5: not doubled', !(await live())?.hooksDoubled)
    await stop()

    // ---- 6. A snippet whose HTTP hooks post to another URL (?copy=1, the same route): the CLI runs both handlers of every
    // event, so each hook really arrives twice. Each copy is answered from the first; each distinct event still handled.
    writeManaged(JSON.parse(JSON.stringify(snippet).replaceAll(`http://127.0.0.1:${PORT}/hook`, `http://127.0.0.1:${PORT}/hook?copy=1`)))
    check('6: the agent starts', (await start()) && !!(await until(async () => (await live())?.status === 'ready', HUNG_MS)))
    await busyTurn('6')
    check('6: the fake ran two HTTP handlers for each prompt and tool call', fakeRows().filter((r) => r.event === 'UserPromptSubmit' || r.event === 'PreToolUse').every((r) => r.handlers === 2) && fakeRows().some((r) => r.event === 'PreToolUse'), JSON.stringify(fakeRows().slice(0, 6)))
    check('6: Combwork says its hooks arrive twice', !!(await until(async () => (await live())?.hooksDoubled, HUNG_MS)))
    await stop()
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
