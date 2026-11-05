// HI-1954: a workspace's commands as it opens (design HI-1954/s15, s19, s21). Its open point runs Prep, Server (ticked
// "The commands after this need it", failing until a flag file exists) and Seed. As the workspace opens the dialog shows
// them, Combwork dimmed behind; Server fails, the dialog leads with Stop here and warns beside Skip; an agent's start is
// refused while the list holds the agents back; Rerun (the flag made) runs it, Seed after it, and the agents are let
// go. Opened again: Skip it and continue runs Seed; Stop here runs none of the rest; Don't wait while a command runs
// lets the agents go and the rest run by themselves. A command run by hand from the palette's IPC shows the same
// dialog, its reason manual. A long command is cut to two lines, whole in its tooltip (HI-2031). Screenshots of the dialog, running and failed, in both themes. Dev build, throwaway profile
// and workspaces; test copies run the user's commands only with HIVE_TEST_RUN_ON_CLOSE=1 (unpackaged builds).
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'onopen-profile')
const ws = path.join(lib.WORK, 'onopen-ws')
const other = path.join(lib.WORK, 'onopen-other')
const marks = path.join(lib.WORK, 'onopen-marks')
const COMMAND = path.join(__dirname, 'onclose', 'command.cjs')
const flag = path.join(marks, 'server-ok')
const go = path.join(marks, 'go')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
/** A command writing `label`'s marker (its reason filled in by Combwork), in `mode` (onclose/command.cjs). */
const command = (label, mode) => `"${process.execPath}" "${COMMAND}" "${path.join(marks, `${label}.json`)}" ${label} {reason} - ${mode}`
const mark = (label) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(marks, `${label}.json`), 'utf8'))
  } catch {
    return null
  }
}
const ids = { proj: 'c-0000000e', prep: 'c-0000000a', server: 'c-0000000b', seed: 'c-0000000c', long: 'c-0000000d' }
/** The workspace's commands, its open point running `open` (their ids) in order. */
const commandsFor = (open) => ({
  list: [
    // Its label is a project's folder by its name (HR2's round 1: filled at the open's first command too).
    { id: ids.proj, name: 'Project', command: `"${process.execPath}" "${COMMAND}" "${path.join(marks, 'proj.json')}" "{project:alpha}" {reason} - quick` },
    { id: ids.prep, name: 'Prep', command: command('prep', 'quick') },
    { id: ids.server, name: 'Server', command: command('server', `flag:${flag}`), needed: true },
    { id: ids.seed, name: 'Seed', command: command('seed', 'quick') },
    { id: ids.long, name: 'Long', command: command('long', `wait:${go}`) }
  ],
  onOpen: { run: open.map((id) => ({ scope: 'workspace', id })) },
  onClose: { run: [] }
})
const dialog = (page, state) => page.locator(`.overlay.close-command[data-point="open"][data-state="${state}"]`)
const anyDialog = (page) => page.locator('.overlay.close-command')
const choose = (page, name) => page.locator('.close-command .dialog-footer button', { hasText: name }).click()
async function theme(inv, page, t) {
  await inv('settings:update', { appearance: { theme: t } })
  return lib.until(() => page.evaluate((x) => document.documentElement.dataset.theme === x, t), HUNG_MS)
}
/** Screenshots of the dialog in both themes, ending in dark. */
async function shots(inv, page, name) {
  for (const t of ['light', 'dark']) {
    await theme(inv, page, t)
    await page.screenshot({ path: path.join(lib.WORK, `onopen-${name}-${t}.png`) })
  }
}

;(async () => {
  for (const d of [userData, ws, other, marks]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(marks, { recursive: true })
  for (const w of [ws, other]) lib.gitProject(path.join(w, 'alpha'))
  // The open point, as Settings would have saved it: Prep, Server (needed), Seed.
  fs.mkdirSync(path.join(ws, '.combwork'), { recursive: true })
  const wsFile = path.join(ws, '.combwork', 'workspace.json')
  fs.writeFileSync(wsFile, JSON.stringify({ version: 1, commands: commandsFor([ids.proj, ids.prep, ids.server, ids.seed]) }))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', closeToTray: false }
  cfg.settings.appearance = { ...cfg.settings.appearance, theme: 'dark' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47705), HIVE_TEST_RUN_ON_CLOSE: '1' } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, other)
  const agent = await lib.addAgent(inv, path.join(ws, 'alpha'), { name: 'Builder' }).catch(() => null)
  /** An agent's start as the Agent API or a lane would ask: why it was refused, or null. */
  const startRefusal = (projectPath, agentId) => inv('session:start', projectPath, { agentId }).then(() => null, (e) => String(e?.message ?? e))
  const openWs = () => lib.openWorkspace(inv, page, ws, HUNG_MS * 2)

  // --- 1. Opening: Prep runs, Server fails; the dialog leads with Stop here, the agents held; Rerun, and they're let go.
  void openWs()
  check('opening: the dialog shows its commands, Combwork dimmed behind', !!(await lib.until(async () => (await anyDialog(page).count()) === 1, HUNG_MS)))
  check('…Server fails, needed: the dialog says so, with its exit code', !!(await lib.until(async () => (await dialog(page, 'failed').count()) === 1, HUNG_MS)) && /Server.*3/.test((await page.locator('#close-command-title').textContent()) ?? ''))
  check("…its first command had {project:alpha} filled with alpha's folder", mark('proj')?.label?.toLowerCase() === path.join(ws, 'alpha').toLowerCase(), JSON.stringify(mark('proj')))
  check('…Prep ran before Server, its reason open', mark('prep')?.reason === 'open', JSON.stringify(mark('prep')))
  const lead = page.locator('.close-command .dialog-footer button.primary')
  check('…Stop here leads, and Skip carries the warning', ((await lead.textContent()) ?? '').includes('Stop here') && (await page.locator('.close-command-warn').count()) === 1)
  const steps = await page.locator('.close-command-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  check('…its list: Project and Prep done, Server failed, Seed waiting', JSON.stringify(steps) === JSON.stringify(['ok', 'ok', 'failed', 'waiting']), JSON.stringify(steps))
  // Its agents held: a start as the Agent API, the Assistant or a lane asks, refused.
  const workspaceAlpha = path.join(ws, 'alpha')
  const agents = (await inv('agents:list', workspaceAlpha).catch(() => [])) ?? []
  const agentId = agent?.id ?? agents[0]?.id ?? 'none'
  const held = await startRefusal(workspaceAlpha, agentId)
  check("…an agent's start is refused while the list holds them back", /open commands are still running/.test(held ?? ''), held ?? 'not refused')
  await shots(inv, page, 'failed')
  fs.writeFileSync(flag, 'ok')
  await choose(page, 'Rerun')
  check('Rerun: Server runs again and passes, Seed after it, and the dialog goes', !!(await lib.until(async () => (await anyDialog(page).count()) === 0 && mark('seed') !== null, HUNG_MS)) && mark('server')?.reason === 'open')
  const after = await startRefusal(workspaceAlpha, agentId)
  check('…and the agents are let go: a start is no longer refused for the open commands', !/open commands are still running/.test(after ?? ''), after ?? '')

  // --- 2. Opened again, Server failing: Skip it and continue runs Seed.
  const reopen = async () => {
    await lib.openWorkspace(inv, page, other)
    void openWs()
    return !!(await lib.until(async () => (await dialog(page, 'failed').count()) === 1, HUNG_MS))
  }
  fs.rmSync(flag, { force: true })
  const seedAt = mark('seed').at
  check('opened again: Server fails', await reopen())
  await choose(page, 'Skip it and continue')
  check('Skip it and continue: Seed runs, the dialog goes', !!(await lib.until(async () => (await anyDialog(page).count()) === 0 && (mark('seed')?.at ?? 0) > seedAt, HUNG_MS)))

  // --- 3. Stop here: none of the rest; the agents are let go all the same.
  const seedAt2 = mark('seed').at
  check('opened again: Server fails', await reopen())
  await choose(page, 'Stop here')
  check('Stop here: the dialog goes, Seed not run', !!(await lib.until(async () => (await anyDialog(page).count()) === 0, HUNG_MS)) && mark('seed').at === seedAt2)
  const stopped = await startRefusal(workspaceAlpha, agentId)
  check('…and the agents are let go', !/open commands are still running/.test(stopped ?? ''), stopped ?? '')

  // --- 4. Don't wait while Long runs: the agents go now, Long and Seed finish by themselves after.
  await lib.openWorkspace(inv, page, other)
  fs.writeFileSync(wsFile, JSON.stringify({ version: 1, commands: commandsFor([ids.long, ids.seed]) }))
  void openWs()
  check("opened with Long first: the dialog, running, with Don't wait", !!(await lib.until(async () => (await dialog(page, 'running').count()) === 1, HUNG_MS)) && ((await page.locator('.close-command .dialog-footer').textContent()) ?? '').includes("Don't wait"))
  check('…Long shown running, its command under it', !!(await lib.until(async () => (await page.locator('.close-command-step[data-state="running"]').count()) === 1 && (await page.locator('.close-command-step .close-command-text').count()) > 0, HUNG_MS)))
  // HI-2031: Long's command line (node's path, the script's, a marker's) is cut to two lines; hovered, its tooltip has it whole.
  const line = page.locator('.close-command-step .close-command-line')
  const cut = await line.evaluate((el) => ({ lines: el.clientHeight / parseFloat(getComputedStyle(el).lineHeight), cut: el.scrollHeight > el.clientHeight + 1, marked: el.dataset.cut === 'true', text: el.textContent }))
  check('…its command on at most two lines, cut', cut.lines <= 2.05 && cut.cut && cut.marked, JSON.stringify(cut))
  check('…the whole command is still its text, for a screen reader', cut.text === command('long', `wait:${go}`).replace('{reason}', 'open'), cut.text)
  await shots(inv, page, 'running')
  await line.hover()
  check('…hovered, its tooltip shows the whole command', !!(await lib.until(async () => ((await page.locator('.tip.close-command-tip').textContent().catch(() => '')) ?? '') === cut.text, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'onopen-running-hover-dark.png') })
  await page.mouse.move(0, 0)
  await page.locator('.close-command .dialog-footer button', { hasText: "Don't wait" }).click()
  check("Don't wait: the dialog goes", !!(await lib.until(async () => (await anyDialog(page).count()) === 0, HUNG_MS)))
  const letGo = await startRefusal(workspaceAlpha, agentId)
  check('…the agents are let go at once', !/open commands are still running/.test(letGo ?? ''), letGo ?? '')
  const seedAt3 = mark('seed').at
  fs.writeFileSync(go, 'go')
  check('…and Long, then Seed, finish by themselves', !!(await lib.until(() => mark('long') !== null && (mark('seed')?.at ?? 0) > seedAt3, HUNG_MS)))

  // --- 5. By hand (the palette's Run Command): the same dialog, one step, its reason manual.
  await inv('commands:run', { scope: 'workspace', id: ids.prep })
  check('run by hand: Prep runs, its reason manual', !!(await lib.until(() => mark('prep')?.reason === 'manual', HUNG_MS)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
