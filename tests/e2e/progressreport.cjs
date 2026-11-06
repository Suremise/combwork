// The cw-progress wrapper in an agent's session (#137), on a fake Claude Code agent (fake-claude/) whose "shell:" step
// runs a command in cmd with the session's environment: cw-progress is on the session's PATH (Combwork's bin folder
// first), passes the command's output and exit code through and takes out its step lines.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'progressreport-profile')
const ws = path.join(lib.WORK, 'progressreport-ws')
const claudeHome = path.join(lib.WORK, 'progressreport-claude-home')
const alpha = path.join(ws, 'alpha')
// A checkout of alpha at an older commit (#1273), beside the workspace so it isn't one of its projects.
const older = path.join(lib.WORK, 'progressreport-older')
// The runners' timings for the runs it starts, its own (#1518): the machine's file keeps its newest 300 keys, which on a
// busy machine lost `about`'s within hours, and with it the estimate checked.
const timings = path.join(lib.WORK, 'progressreport-timings.json')
const PORT = Number(lib.port(47913))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome, older, timings]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const shells = () => {
    const f = path.join(claudeHome, 'fake-shell.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  /**
   * Has the agent start a command (as its shell would), typed again if a wake of Combwork's disturbed it (typeLine): taken
   * once a turn of its starts. Resolves to a wait for what it recorded. `disturb`: typeLine's own check.
   */
  const startShell = async (id, cmd, ms = 30000, { disturb = null } = {}) => {
    const before = shells().length
    const typed = await lib.typeLine(inv, lib.ptyKey(alpha, id), claudeHome, 'Builder', `shell: ${cmd}`, {
      ready: async () => (await live(id))?.status !== 'working',
      live: () => live(id),
      hungMs: Math.max(ms, HUNG_MS),
      disturb,
    })
    // Its own record (a line a wake disturbed may have run too, typeLine), once the agent is quiet: a record it writes
    // late isn't taken for the next command's.
    const wait = async () => {
      const ran = await until(() => shells().slice(before).find((s) => s.cmd === cmd), ms)
      await until(async () => (await live(id))?.status !== 'working', HUNG_MS)
      return ran
    }
    wait.typed = typed
    return wait
  }
  const shell = async (id, cmd, ms) => (await startShell(id, cmd, ms))()
  // A screenshot in a theme (#1250): the page must reach the theme, its Progress panel's background must be that
  // theme's (dark or light), and the image is taken again until it shows that background (just inside the panel's left
  // edge), so neither a switch that didn't happen nor a frame still painted in the other theme passes for this one's.
  const isDark = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
  }
  const pixelAt = (png, x, y) =>
    page.evaluate(
      async ([b64, px, py]) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const g = c.getContext('2d')
        g.drawImage(img, 0, 0)
        return `rgb(${[...g.getImageData(px, py, 1, 1).data.slice(0, 3)].join(', ')})`
      },
      [png.toString('base64'), x, y]
    )
  const themedShot = async (theme, name) => {
    await inv('settings:update', { appearance: { theme } })
    const reached = await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    const at = await page.evaluate(() => {
      const el = document.querySelector('.progress-panel')
      const r = el.getBoundingClientRect()
      return { x: Math.round((r.left + 3) * devicePixelRatio), y: Math.round((r.top + r.height / 2) * devicePixelRatio), bg: getComputedStyle(el).backgroundColor, theme: document.documentElement.dataset.theme }
    })
    if (!reached || isDark(at.bg) !== (theme === 'dark')) return check(`${name}: the page switches to the ${theme} theme`, false, `the page's theme is ${at.theme}, its panel ${at.bg}`)
    let shown = ''
    const ok = await until(async () => (shown = await pixelAt(await page.screenshot({ path: path.join(lib.WORK, name) }), at.x, at.y)) === at.bg, HUNG_MS)
    check(`${name} shows the ${theme} theme`, !!ok, `the panel is ${at.bg} in the page, ${shown} in the image`)
  }
  const runs = () => inv('progress:list')
  const newRun = async (known, match) => until(async () => (await runs()).find((r) => !known.includes(r.id) && match(r)), 60000)

  await page.getByText('alpha', { exact: true }).first().click()
  const builder = await lib.addAgent(inv, alpha, { name: 'Builder' })
  await inv('session:start', alpha, { agentId: builder.id })
  check('the agent starts', !!(await until(async () => (await live(builder.id))?.status === 'ready', HUNG_MS)))

  const bin = path.join(userData, 'bin')
  // typeLine's own check (#1560): a line a wake of Combwork's disturbed is typed again, whether the wake's Ctrl+U came
  // between the line and its Enter, or its text was on the line before the line was typed.
  const disturbed = await startShell(builder.id, 'where cw-progress', 30000, { disturb: 'enter' })
  check('a line a Ctrl+U cleared before its Enter is typed again (typeLine)', disturbed.typed.attempt === 2 && disturbed.typed.lost[0]?.startsWith('disturbed'), JSON.stringify(disturbed.typed))
  await disturbed()
  const whereRun = await startShell(builder.id, 'where cw-progress', 30000, { disturb: 'before' })
  // Typed again at once or, the mixed line taken as a turn, once more after that turn dropped it.
  check("…and one typed after a wake's text on the line", whereRun.typed.attempt >= 2 && whereRun.typed.lost[0]?.startsWith('disturbed'), JSON.stringify(whereRun.typed))
  const where = await whereRun()
  // where lists the sh script (for Git Bash) too; cmd and PowerShell run the .cmd beside it, as with npm's pair.
  const found = (where?.stdout ?? '').trim().split(/\r?\n/).map((l) => l.toLowerCase())
  const mine = [path.join(bin, 'cw-progress'), path.join(bin, 'cw-progress.cmd')].map((f) => f.toLowerCase())
  check("cw-progress is on the session's PATH, from this Combwork's bin folder first (the .cmd and the sh script)", where?.code === 0 && mine.every((f) => found.slice(0, 2).includes(f)), JSON.stringify(where))

  const run = await shell(builder.id, `cw-progress --title Demo -- node -e "console.log('hi'); console.log('##cw-progress step=1 total=2 name=one'); console.error('warn'); process.exit(3)"`)
  check("the command's output passes through, without its step lines", run?.stdout.replace(/\r/g, '') === 'hi\n' && run?.stderr.replace(/\r/g, '') === 'warn\n', JSON.stringify(run))
  check('…and its exit code', run?.code === 3, JSON.stringify(run))
  const demo = (await runs()).find((r) => r.title === 'Demo')
  check('the run was reported as the agent, and failed with its exit code', demo?.agentName === 'Builder' && demo?.state === 'failed' && demo?.summary === 'exit code 3', JSON.stringify(demo))

  // --- An Electron app run through either shim starts as an app (the shims run cw-progress with Combwork's executable as
  // Node; that setting isn't passed on to the command). The app quits rather than exits: app.exit() as soon as it's
  // ready sometimes crashes Electron under load (0x80000003, exit code 3 in bash; 0xC0000005), app.quit() never (#656).
  const electronApp = path.join(lib.WORK, 'progressreport-electron-app.cjs')
  fs.writeFileSync(electronApp, "let app = null\ntry { app = require('electron').app } catch {}\nif (!app) { console.log('BROKEN: running as Node'); process.exit(23) }\napp.whenReady().then(() => { console.log('OK: Electron app'); app.quit() })\n")
  const viaCmd = await shell(builder.id, `cw-progress -- "${lib.ELECTRON}" "${electronApp}"`)
  check('an Electron app through cw-progress (cmd, the .cmd shim) starts as an app', viaCmd?.code === 0 && viaCmd?.stdout.trim() === 'OK: Electron app', JSON.stringify(viaCmd))
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  if (fs.existsSync(gitBash)) {
    const posix = (p) => p.replace(/\\/g, '/')
    const viaBash = await shell(builder.id, `"${gitBash}" -c "cw-progress -- '${posix(lib.ELECTRON)}' '${posix(electronApp)}'"`)
    check('…and through Git Bash (the sh shim)', viaBash?.code === 0 && viaBash?.stdout.trim() === 'OK: Electron app', JSON.stringify(viaBash))
  } else console.log('(no Git Bash: the sh shim not checked here)')

  // --- In the Progress panel while it runs: the agent's name, the title and its steps.
  await page.locator('.xterm').first().click().catch(() => undefined)
  await page.keyboard.press('Control+Alt+P')
  const panel = page.locator('.progress-panel')
  check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  let known = (await runs()).map((r) => r.id)
  const stepped = await startShell(builder.id, `cw-progress --title "Stepped demo" -- node -e "console.log('##cw-progress step=1 total=3 name=alpha'); setTimeout(() => console.log('##cw-progress step=2 name=beta'), 2500); setTimeout(() => process.exit(0), 6000)"`)
  const live1 = await newRun(known, (r) => r.title === 'Stepped demo')
  const row = panel.locator(`.progress-run[data-run="${live1?.id}"]`)
  const rowText = async () => (await row.textContent().catch(() => '')) ?? ''
  check('the panel shows the run with the agent, its title and its first step', !!live1 && !!(await until(async () => /Builder/.test(await rowText()) && /Stepped demo/.test(await rowText()) && /1 of 3: alpha/.test(await rowText()), 10000)), await rowText())
  check('…then its next step', !!(await until(async () => /2 of 3: beta/.test(await rowText()), 10000)), await rowText())
  await page.screenshot({ path: path.join(lib.WORK, 'progressreport-panel.png') })
  const end1 = await stepped()
  check('…and it passes', end1?.code === 0 && (await until(async () => (await runs()).find((r) => r.id === live1?.id)?.state === 'passed', 10000)), JSON.stringify(end1))

  // --- A total printed after the wrapper's first 2 seconds (#145): the run starts without steps and takes it once.
  known = (await runs()).map((r) => r.id)
  const lateCmd = await startShell(builder.id, `cw-progress --title "Late total" -- node -e "setTimeout(() => console.log('##cw-progress step=2 total=4 name=late'), 3500); setTimeout(() => console.log('##cw-progress step=3 total=9 name=later'), 5500); setTimeout(() => process.exit(0), 8000)"`)
  const live2 = await newRun(known, (r) => r.title === 'Late total')
  const lateRow = panel.locator(`.progress-run[data-run="${live2?.id}"]`)
  const lateText = async () => (await lateRow.textContent().catch(() => '')) ?? ''
  check('a run whose total comes late starts without steps', !!live2 && live2.total === null, JSON.stringify(live2))
  check('…then shows the late total as steps', !!(await until(async () => /2 of 4: late/.test(await lateText()), 10000)), await lateText())
  await page.screenshot({ path: path.join(lib.WORK, 'progressreport-late-total.png') })
  check('…and keeps it when another total comes', !!(await until(async () => /3 of 4: later/.test(await lateText()), 10000)), await lateText())
  const end2 = await lateCmd()
  const late2 = await until(async () => (await runs()).find((r) => r.id === live2?.id && r.state === 'passed'), 10000)
  check('…and it passes with its bar full', end2?.code === 0 && late2?.total === 4 && late2?.step === 4, JSON.stringify({ end2, late2 }))

  // --- A run for a card (#1220): it defaults to the agent's card in Doing and what's checked out in its folder; the row
  // shows "#N · a3f2c1d" under the agent (the card opens it), and its details the card and the whole revision.
  const gitIn = (...a) => require('child_process').execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: alpha, env: lib.gitEnv(), encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(alpha, 'b.ts'), 'export const b = 2\n')
  // What the checks below write is ignored (#1222: an ignored output doesn't count against a check).
  fs.writeFileSync(path.join(alpha, '.gitignore'), 'check-ran.txt\n')
  gitIn('add', 'b.ts', '.gitignore')
  gitIn('commit', '-qm', 'second')
  const head = gitIn('rev-parse', 'HEAD')
  const card = await inv('tasks:create', { title: 'Run for a card', project: 'alpha', agent: builder.id, column: 'doing' })
  known = (await runs()).map((r) => r.id)
  const forCard = await startShell(builder.id, `cw-progress --title "For a card" -- node -e "setTimeout(() => process.exit(0), 6000)"`)
  const live3 = await newRun(known, (r) => r.title === 'For a card')
  check("a run names the agent's card in Doing and the folder's head by default", live3?.card === card.number && live3?.revision === head && live3?.testedCheckout === head && live3?.folder?.toLowerCase() === alpha.toLowerCase(), JSON.stringify(live3))
  const cardRow = panel.locator(`.progress-run[data-run="${live3?.id}"]`)
  const forText = async () => (await cardRow.locator('.progress-run-for').textContent().catch(() => '')) ?? ''
  check('…and its row shows "AM-12 · a3f2c1d" under the agent (the card by key, #1221)', !!(await until(async () => (await forText()).replace(/\s+/g, ' ').trim() === `${card.key} · ${head.slice(0, 7)}`, 10000)), await forText())
  await cardRow.locator('.progress-title').click()
  const details = cardRow.locator('.progress-details')
  const detailsText = async () => (await details.textContent().catch(() => '')) ?? ''
  check('…and its details the card and the whole revision', !!(await until(async () => (await detailsText()).includes(`Card${card.key}`) && (await detailsText()).includes(`Revision${head}`), 10000)), await detailsText())
  check("…and no Tested on: it was tested on the card's revision (#1273)", !(await detailsText()).includes('Tested on'), await detailsText())
  for (const theme of ['light', 'dark']) await themedShot(theme, `progressreport-card-${theme}.png`)
  await cardRow.locator('.progress-run-card').click()
  // The dialog has the card's title in its title box.
  check('…and its card opens the card', !!(await until(() => page.locator('[role="dialog"] input').evaluateAll((els) => els.some((e) => e.value === 'Run for a card')), 10000)))
  await page.keyboard.press('Escape')
  const end3 = await forCard()
  check('…and it passes', end3?.code === 0, JSON.stringify(end3))

  // A run for the card in another checkout (#1273, as a reviewer's): the card's revision, and what it was tested on, the
  // commit checked out there, shown in its details as Tested on.
  gitIn('worktree', 'add', '-q', '--detach', older, 'HEAD~1')
  const olderHead = gitIn('rev-parse', 'HEAD~1')
  known = (await runs()).map((r) => r.id)
  const elsewhere = await startShell(builder.id, `cd /d "${older}" && cw-progress --card "#${card.number}" --title "Tested elsewhere" -- node -e "setTimeout(() => process.exit(0), 6000)"`)
  const live4 = await newRun(known, (r) => r.title === 'Tested elsewhere')
  check("a run in another checkout: the card's revision, tested on that checkout's head", live4?.card === card.number && live4?.revision === head && live4?.testedCheckout === olderHead, JSON.stringify(live4))
  const elsewhereRow = panel.locator(`.progress-run[data-run="${live4?.id}"]`)
  await elsewhereRow.locator('.progress-title').click()
  const elsewhereText = async () => (await elsewhereRow.locator('.progress-details').textContent().catch(() => '')) ?? ''
  check('…and its details show Tested on with the whole commit, after the Revision', !!(await until(async () => /Revision[0-9a-f]{40}Tested on[0-9a-f]{40}/.test(await elsewhereText()) && (await elsewhereText()).includes(`Revision${head}Tested on${olderHead}`), HUNG_MS)), await elsewhereText())
  for (const theme of ['light', 'dark']) await themedShot(theme, `progressreport-tested-on-${theme}.png`)
  const end4 = await elsewhere()
  check('…and it passes', end4?.code === 0, JSON.stringify(end4))
  await elsewhereRow.locator('.progress-title').click()
  gitIn('worktree', 'remove', '--force', older)

  // A revision that isn't what's checked out is refused before the command runs; a check runs the project's command.
  const refused = await shell(builder.id, `cw-progress --card "#${card.number}" --revision HEAD~1 -- node -e "require('fs').writeFileSync('refused-ran.txt', 'x')"`)
  check("a --revision that isn't checked out is refused, and the command never runs", refused?.code === 2 && /isn't what's checked out here/.test(refused?.stderr ?? '') && !fs.existsSync(path.join(alpha, 'refused-ran.txt')), JSON.stringify(refused))
  // The check commands are set through the app's own save (#1594): a direct write of project.json, made in place, could
  // be read half written by Combwork meanwhile, taken as damaged and replaced by its .bak, losing the commands.
  const commands = { quick: `node -e "require('fs').writeFileSync('check-ran.txt', 'yes')"` }
  const setCommands = async () => {
    const form = await inv('workflow:setOptions', alpha, { preset: null, options: { commands } })
    check('the check commands are saved', JSON.stringify(form?.own?.commands) === JSON.stringify(commands), JSON.stringify(form?.own))
  }
  await setCommands()
  known = (await runs()).map((r) => r.id)
  const checked = await shell(builder.id, 'cw-progress --check quick')
  const quick = (await runs()).find((r) => !known.includes(r.id) && r.check === 'quick')
  check("--check runs the project's command for it, titled by its name", checked?.code === 0 && fs.readFileSync(path.join(alpha, 'check-ran.txt'), 'utf8') === 'yes' && quick?.title === 'quick' && quick?.card === card.number && quick?.state === 'passed', JSON.stringify({ checked, quick }))

  // --- Runs as checks (#1222): the --check run is a check of the card's revision in its facts, counted, and its details
  // say so; a check that edits a tracked file while it runs (undone before it ends) is recorded, not counted.
  const work = () => inv('tasks:work', card.number)
  const counted = await until(async () => (await work())?.checks.find((c) => c.run === quick?.id), 10000)
  check("…and is the card's check of its revision, counted", counted?.counted === true && counted.name === 'quick' && counted.revision === head && counted.tested === head && counted.result === 'passed', JSON.stringify({ counted, status: gitIn('status', '--porcelain') }))
  const quickRow = panel.locator(`.progress-run[data-run="${quick?.id}"]`)
  await quickRow.locator('.progress-title').click()
  const quickDetails = async () => (await quickRow.locator('.progress-details').textContent().catch(() => '')) ?? ''
  check('…and its details say it counts as the check', !!(await until(async () => (await quickDetails()).includes('CheckCounts as check: quick'), 10000)), await quickDetails())
  commands.edit = `node -e "const fs = require('fs'); const t = fs.readFileSync('b.ts'); fs.writeFileSync('b.ts', 'edited'); fs.writeFileSync('b.ts', t)"`
  await setCommands()
  known = (await runs()).map((r) => r.id)
  const edited = await shell(builder.id, 'cw-progress --check edit')
  const editRun = (await runs()).find((r) => !known.includes(r.id) && r.check === 'edit')
  const notCounted = await until(async () => (await work())?.checks.find((c) => c.run === editRun?.id), 10000)
  check('a check that edits a tracked file while it runs is recorded, not counted (changed)', edited?.code === 0 && notCounted?.counted === false && notCounted.whyNot === 'changed', JSON.stringify({ edited, notCounted }))
  const editRow = panel.locator(`.progress-run[data-run="${editRun?.id}"]`)
  await editRow.locator('.progress-title').click()
  const editDetails = async () => (await editRow.locator('.progress-details').textContent().catch(() => '')) ?? ''
  check('…and its details say why', !!(await until(async () => (await editDetails()).includes("Doesn't count as check edit: files changed in the folder while it ran"), 10000)), await editDetails())
  for (const theme of ['light', 'dark']) await themedShot(theme, `progressreport-check-${theme}.png`)

  const unknown = await shell(builder.id, 'cw-progress --check lint')
  check('…and with no command for the name, runs nothing and says so', unknown?.code === 2 && /no command configured for the check "lint"/.test(unknown?.stderr ?? ''), JSON.stringify(unknown))
  await inv('tasks:update', card.number, { column: 'todo' }).catch(() => undefined)

  // --- Combwork's own runners in an agent's session: shown in this Combwork's panel as the agent's, with steps and estimates.
  const root = lib.ROOT
  const withTimings = `set "CW_TEST_PROGRESS_TIMINGS=${timings}"&& `
  const unitCmd = `${withTimings}cd /d "${root}" && npx vitest run tests/tips.test.ts tests/e2esuites.test.ts`
  known = (await runs()).map((r) => r.id)
  const unit1 = await shell(builder.id, unitCmd, 120000)
  const u1 = (await runs()).find((r) => !known.includes(r.id) && /^unit: 2 files$/.test(r.title))
  check('npm test reports "unit: 2 files", a step per file, as the agent', unit1?.code === 0 && u1?.agentName === 'Builder' && u1?.total === 2 && u1?.step === 2 && u1?.state === 'passed', JSON.stringify({ code: unit1?.code, u1 }))
  known = (await runs()).map((r) => r.id)
  await shell(builder.id, unitCmd, 120000)
  const u2 = (await runs()).find((r) => !known.includes(r.id) && /^unit: 2 files$/.test(r.title))
  check('…and the next time, with an estimate', u2?.state === 'passed' && lib.hadEstimate(u2), JSON.stringify(u2))
  known = (await runs()).map((r) => r.id)
  const off = await shell(builder.id, `set CW_PROGRESS=0&& ${unitCmd}`, 120000)
  await lib.sleep(1500) // A fixed wait on purpose: this checks that nothing is reported.
  check('CW_PROGRESS=0: the tests run, nothing is reported', off?.code === 0 && (await runs()).every((r) => known.includes(r.id)), JSON.stringify((await runs()).filter((r) => !known.includes(r.id))))

  // An earlier run of the suite, its time kept; then the run checked, with its estimate from that one.
  const aboutCmd = `${withTimings}cd /d "${root}" && node tests/e2e/run.mjs about`
  const earlier = await shell(builder.id, aboutCmd, 180000)
  check('…an earlier e2e run of the suite passes, its time kept', earlier?.code === 0, earlier?.stdout)
  known = (await runs()).map((r) => r.id)
  const e2e = await shell(builder.id, aboutCmd, 180000)
  const e1 = (await runs()).find((r) => !known.includes(r.id) && r.title === 'e2e: 1 suite')
  check('npm run e2e reports "e2e: 1 suite" as the agent, with its step and the estimate from earlier runs', e2e?.code === 0 && e1?.agentName === 'Builder' && e1?.total === 1 && e1?.state === 'passed' && lib.hadEstimate(e1), JSON.stringify({ code: e2e?.code, out: e2e?.stdout?.slice(-300), e1 }))
  check('…and its output is the runner\'s usual', /about\s+pass/.test(e2e?.stdout ?? '') && /1 passed, 0 failed, 0 skipped/.test(e2e?.stdout ?? ''), e2e?.stdout)
  check('only those runs: the test Combwork the suite started reported nothing here', (await runs()).filter((r) => !known.includes(r.id)).length === 1, JSON.stringify((await runs()).filter((r) => !known.includes(r.id))))

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
