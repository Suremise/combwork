// Settings → Accounts & Connections (HI-980; HI-2107: the section's id still 'accounts'; on for everyone since HI-1774):
// Add Account… makes the account's folder (its projects\ a junction to the CLI home's) and opens its sign-in in Hive's
// terminal, nothing typed into it; once it ends, the row says who it is signed in as, and Set Up (HI-1826) runs the CLI
// itself on the folder for its first-run screens. Turned on, it is this workspace's
// default. A login changed in its folder while Settings is closed (as a /login in a pane would) is found by its watch
// and shown as changed, with Keep the New Login. Two accounts on one login are flagged. A second window's workspace keeps
// its own choice. Remove deletes the folder for good, the conversations it linked to untouched. The fake Claude Code
// signs in (fake-login-as.json beside the accounts folder): no browser opens, no real login is used. Screenshots in both
// themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'accounts-profile')
const home = path.join(lib.WORK, 'accounts-claude-home')
const codexHome = path.join(lib.WORK, 'accounts-codex-home')
const ws1 = path.join(lib.WORK, 'accounts-ws1')
const ws2 = path.join(lib.WORK, 'accounts-ws2')
const accountsRoot = path.join(userData, 'accounts')
const conversation = path.join(home, 'projects', 'C--work-alpha', 'kept.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws1, ws2]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = lib.fakeClaude(userData, home, [])
  // Codex on too (HI-1870: one list, Add asking which CLI), the fake, on a home of the suite's own with no sandbox set up.
  fs.rmSync(codexHome, { recursive: true, force: true })
  fs.mkdirSync(codexHome, { recursive: true })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  env.CODEX_HOME = codexHome
  // Trust reads go ahead while this file is there; taken away, they wait (HI-1870: Checking… shown, for its screenshot).
  const trustGo = path.join(userData, 'trust-go')
  fs.writeFileSync(trustGo, '')
  env.HIVE_TEST_HOLD_TRUST = trustGo
  fs.mkdirSync(path.dirname(conversation), { recursive: true })
  fs.writeFileSync(conversation, '{"kept":true}\n')
  // Each project with a Claude Code agent: "Needs set up" counts only projects a connection would be used in (HI-1871).
  const projectWithAgent = (dir) => {
    fs.mkdirSync(path.join(dir, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'claude-code' }] }))
  }
  for (const w of [ws1, ws2]) projectWithAgent(path.join(w, 'alpha'))
  // `hold`: the fake's sign-in waits (for a browser that never comes) until its terminal is closed.
  const loginAs = (email, hold = false) => {
    fs.mkdirSync(accountsRoot, { recursive: true })
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1', plan: 'plus', ...(hold ? { hold } : {}) }))
  }

  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const invOn = (p) => (ch, ...a) => p.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const inv = invOn(page)
    await lib.openWorkspace(inv, page, ws1)
    const list = () => inv('connections:list')
    const wsJson = (w) => JSON.parse(fs.readFileSync(path.join(w, '.combwork', 'workspace.json'), 'utf8')).connections
    const shots = async (name) => {
      while ((await page.locator('.toast').count()) > 0) await page.locator('.toast').first().locator('button').last().click()
      await page.mouse.move(5, 5)
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.screenshot({ path: path.join(lib.WORK, `accounts-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    const nav = page.locator('.settings-nav .row[data-section="accounts"]')
    const openSettings = async () => {
      await page.keyboard.press('Control+,')
      await page.locator('.settings-nav').waitFor({ timeout: HUNG_MS })
    }
    const row = (name) => page.locator('.account-row', { has: page.locator('.account-name', { hasText: name }) })
    const fillPrompt = async (text) => {
      const field = page.locator('.dialog input.input')
      await field.waitFor({ timeout: HUNG_MS })
      await field.fill(text)
      await page.locator('.dialog .dialog-footer .btn.primary').click()
    }
    // An account's ⋯ menu (HI-2107): Rename, Sign In, Set Up, Remove.
    const menuOf = async (name, item) => {
      await row(name).locator('[data-action="account-menu"]').click()
      await page.locator('.menu .menu-item', { hasText: item }).first().click()
    }
    // Add Account… (HI-1870): one button for every CLI, its dialog asking which first.
    const addVia = async (cli, name) => {
      await page.locator('[data-add]').click()
      await page.locator(`[data-cli-choice="${cli}"]`).check({ timeout: HUNG_MS })
      await page.locator('#conn-name').fill(name)
      await page.locator('[data-add-connection]').click()
    }
    const terminalOpen = async (id) => (await list()).connections.find((a) => a.id === id)?.signingIn === true
    // Close under a terminal whose CLI still runs: asks first (HI-1870); `yes` false cancels.
    const closeRunning = async (yes) => {
      await page.locator('.account-signin [data-close-terminal]').click()
      const ask = page.locator('.dialog', { hasText: 'Close the terminal?' })
      await ask.waitFor({ timeout: HUNG_MS })
      await ask.locator(yes ? '.dialog-footer .btn.danger' : '.dialog-footer .btn.subtle').click()
      return lib.until(async () => (await ask.count()) === 0, HUNG_MS)
    }
    // An ended sign-in's terminal (it offers Set Up once ended): its Close hides it, asking nothing.
    const closeEnded = async () => {
      if (!(await page.locator('.account-signin').count())) return
      await page.locator('.account-signin [data-set-up-after]').waitFor({ timeout: HUNG_MS })
      await page.locator('.account-signin [data-close-terminal]').click()
      check('an ended terminal’s Close hides it without asking', !!(await lib.until(async () => (await page.locator('.account-signin').count()) === 0, HUNG_MS)) && (await page.locator('.dialog', { hasText: 'Close the terminal?' }).count()) === 0)
    }

    // --- Always there (S8, HI-1774: no preview switch any more).
    await openSettings()
    check('Settings → Accounts & Connections shows, with nothing turned on first', !!(await lib.until(async () => (await nav.count()) === 1, HUNG_MS)))
    await nav.click()
    check('…with no accounts yet', !!(await lib.until(async () => (await page.getByText('No accounts yet').count()) === 1, HUNG_MS)))

    // --- Add Account… (HI-1870): one button, its dialog asking which CLI first, each with its icon.
    check('one Add Account… for every CLI', (await page.locator('[data-add]').count()) === 1 && /Add Account…/.test(await page.locator('[data-add]').innerText()))
    loginAs('one@example.com')
    await page.locator('[data-add]').click()
    const choice = (cli) => page.locator('.dialog .conn-cli-choice', { has: page.locator(`[data-cli-choice="${cli}"]`) })
    check('…asking which CLI first, each with its icon', !!(await lib.until(async () => (await choice('claude-code').locator('.provider-icon').count()) === 1 && (await choice('codex').locator('.provider-icon').count()) === 1, HUNG_MS)))
    check('…Claude Code chosen first, with where it gets its model', (await page.locator('[data-cli-choice="claude-code"]').isChecked()) && (await page.locator('[data-from="server"]').count()) === 1)
    await page.locator('[data-cli-choice="codex"]').check()
    check('…Codex, which has no servers, without it', !!(await lib.until(async () => (await page.locator('[data-from="server"]').count()) === 0, HUNG_MS)))
    await page.locator('[data-cli-choice="claude-code"]').check()
    await page.locator('#conn-name').fill('Personal')
    await shots('add')
    await page.locator('[data-add-connection]').click()
    const personal = await lib.until(async () => (await list()).connections.find((a) => a.name === 'Personal') ?? null, HUNG_MS)
    check('Add Account… adds it', !!personal)
    const folder = personal ? path.join(accountsRoot, personal.id) : ''
    check('…its folder in the profile’s accounts folder, projects a junction to the CLI home’s', !!personal && fs.lstatSync(path.join(folder, 'projects')).isSymbolicLink() && fs.existsSync(path.join(folder, 'projects', 'C--work-alpha', 'kept.jsonl')))
    check('…and opens its sign-in in a terminal of Hive’s', !!(await lib.until(async () => (await page.locator('.account-signin .task-terminal').count()) === 1, HUNG_MS)))
    const signed = await lib.until(async () => {
      const a = (await list()).connections.find((x) => x.id === personal?.id)
      return a?.accepted?.email === 'one@example.com' && a.observed?.loggedIn === true ? a : null
    }, HUNG_MS)
    check('once the sign-in ends, it is signed in as that login, taken on as its own', !!signed, JSON.stringify((await list()).connections))
    check('…and its row says so', !!(await lib.until(async () => /Signed in/.test(await row('Personal').innerText().catch(() => '')) && /one@example\.com · max/.test(await row('Personal').innerText().catch(() => '')), HUNG_MS)))
    check('…with its CLI and its icon', (await row('Personal').locator('.account-cli .provider-icon').count()) === 1 && /Claude Code/.test(await row('Personal').locator('.account-cli').innerText()))
    // A browser sign-in leaves the first-run screens unanswered (its .claude.json without the onboarding field): said.
    check('…and that it needs set up, Set Up primary, with what it is for', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="needed"]').count()) === 1, HUNG_MS)) && (await row('Personal').locator('[data-set-up].primary').count()) === 1 && /first-run questions/.test(await row('Personal').locator('[data-set-up-note]').innerText().catch(() => '')))
    await shots('signed-in')

    // --- Set Up (HI-1826): a browser sign-in leaves Claude Code's first-run screens unanswered, so Set Up is offered
    // under the ended sign-in and on the row; it runs the CLI itself on the folder, answered by the user (nothing typed).
    check('the sign-in ended, Set Up is offered beside Close', !!(await lib.until(async () => (await page.locator('.account-signin [data-set-up-after]').count()) === 1, HUNG_MS)))
    check('…and on its row, signed in', (await row('Personal').locator('[data-set-up]').count()) === 1)
    const launches = path.join(folder, 'fake-launches.jsonl')
    const before = fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean).length : 0
    await page.locator('.account-signin [data-set-up-after]').click()
    const ran = await lib.until(async () => {
      const all = fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
      return all.length > before ? all.at(-1) : null
    }, HUNG_MS)
    check('Set Up runs the CLI itself in the connection’s folder (its launch logged there)', !!ran && path.resolve(ran.cwd).toLowerCase() === path.resolve(folder).toLowerCase(), JSON.stringify(ran))
    check('…in the terminal, with the setup hint', !!(await lib.until(async () => /first-run questions/.test(await page.locator('.account-signin .hint').innerText().catch(() => '')), HUNG_MS)))
    await shots('set-up')
    // --- Close is always there (HI-1870): with the CLI still running it asks; cancelled, nothing changes.
    check('Close is offered while the CLI still runs', (await page.locator('.account-signin [data-close-terminal]').count()) === 1 && (await terminalOpen(personal.id)))
    check('…asks first; cancelled, the terminal stays, its CLI running', !!(await closeRunning(false)) && (await page.locator('.account-signin .task-terminal').count()) === 1 && (await terminalOpen(personal.id)))
    await page.locator('.account-signin [data-close-terminal]').click()
    await page.locator('.dialog', { hasText: 'Close the terminal?' }).waitFor({ timeout: HUNG_MS })
    await shots('close-running')
    await page.locator('.dialog .dialog-footer .btn.danger').click()
    check('…confirmed, it ends the CLI and hides the terminal', !!(await lib.until(async () => (await page.locator('.account-signin').count()) === 0 && !(await terminalOpen(personal.id)), HUNG_MS)))
    // Its screens were answered (the fake does at once, in .claude.json): read as its Set Up ends, the row says it is set up.
    check('…and, its screens answered, its row says it is set up, Set Up no longer primary', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="done"]').count()) === 1, HUNG_MS)) && (await row('Personal').locator('[data-set-up].primary').count()) === 0 && (await row('Personal').locator('[data-set-up-note]').count()) === 0)
    await shots('set-up-done')

    // --- On in this workspace.
    await row('Personal').getByRole('switch').click()
    check('turned on here, it is on in this workspace (workspace.json; HI-2106: no default kept, the order says which)', !!(await lib.until(async () => JSON.stringify(wsJson(ws1)) === JSON.stringify({ 'claude-code': { on: [personal.id] } }), HUNG_MS)), JSON.stringify(wsJson(ws1)))
    check('…and its row says so: On here', !!(await lib.until(async () => (await row('Personal').locator('[data-on-here] [role="switch"]').getAttribute('aria-checked')) === 'true', HUNG_MS)))

    // --- Set up for this workspace (HI-1870): on here, its CLI must trust the folders it would be used in too, read
    // from its .claude.json (never written by Hive). Claude Code's trust of a folder covers those inside it (HI-1871),
    // so Set Up asks once, in the workspace's folder; the fake records the trust answered there.
    const ws1Real = fs.realpathSync.native(ws1)
    const trustOf = async (invoke, id) => (await invoke('connections:list')).connections.find((a) => a.id === id)?.trust ?? null
    // Its agent on Personal's connection, as Agent Settings sets it (HI-2162): a test copy's project migration pins an agent
    // to the CLI test home's account (the seam), always usable, so Personal is used there only when chosen. Counted by
    // its connection's account (HI-2108: an agent names a connection, not an account).
    const onPersonal = async (invoke, project) => {
      const base = (await invoke('connections:list')).connectionRows.find((c) => c.account === personal.id)
      return (await invoke('agents:update', project, 'a-one', { connection: base.id })).connection === base.id
    }
    check('its project’s agent put on it (Agent Settings → Connection)', await onPersonal(inv, path.join(ws1, 'alpha')))
    check('on in a workspace whose project it doesn’t trust, it needs set up again, naming the project', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="needed"]').count()) === 1 && /Not trusted yet in this workspace: alpha/.test(await row('Personal').locator('[data-not-trusted]').innerText().catch(() => '')), HUNG_MS)) && (await row('Personal').locator('[data-set-up].primary').count()) === 1)
    await shots('not-trusted')
    const launchesBefore = fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean).length
    await row('Personal').locator('[data-set-up]').click()
    check('…its Set Up opens once, in the workspace’s folder, saying it covers every project in it', !!(await lib.until(async () => /this workspace's folder.*every project in it/.test(await page.locator('.account-signin [data-set-up-in]').innerText().catch(() => '')), HUNG_MS)))
    check('…its sentence said once, above the terminal, not on the row too', (await row('Personal').locator('[data-set-up-note]').count()) === 0 && (await page.locator('.account-signin .hint').count()) >= 1)
    await shots('set-up-workspace')
    const trustRun = await lib.until(async () => {
      const all = fs.readFileSync(launches, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      return all.length > launchesBefore ? all.at(-1) : null
    }, HUNG_MS)
    check('…the CLI run there, on the connection', !!trustRun && path.resolve(trustRun.cwd).toLowerCase() === ws1Real.toLowerCase(), JSON.stringify(trustRun))
    // The hint names the folder it actually opened in (HI-1871 round 1: main's answer, not the row's last view).
    check('…its hint names the folder the CLI was started in', !!trustRun && (await page.locator('.account-signin [data-set-up-in]').innerText()).toLowerCase().includes(path.resolve(trustRun.cwd).toLowerCase()))
    const wsKey = ws1Real.replace(/\\/g, '/')
    await lib.until(async () => JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8')).projects?.[wsKey]?.hasTrustDialogAccepted === true, HUNG_MS)
    await closeRunning(true)
    check('…its trust answered once (the fake records it), the row says it is set up: alpha and the Assistant’s home covered', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="done"]').count()) === 1, HUNG_MS)) && JSON.stringify(await trustOf(inv, personal.id)) === JSON.stringify({ pending: [], unknown: false }))
    // A project added afterwards, its trust read held: Checking…, never Set up, until it is in (HI-1870 round 3). It is
    // inside the trusted workspace folder, so then Set up by itself, with no new answer (the same answer as before, for
    // a new set of projects: the window is told, HI-1870 round 4), the list never asked here.
    fs.rmSync(trustGo)
    projectWithAgent(path.join(ws1, 'gamma'))
    await inv('workspace:refresh')
    check('…its agent put on it too', await onPersonal(inv, path.join(ws1, 'gamma')))
    check('while its trust of a new project is read, the row says Checking…, not Set up', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="checking"]').count()) === 1, HUNG_MS)) && (await row('Personal').locator('[data-set-up-state="done"]').count()) === 0)
    await shots('checking')
    fs.writeFileSync(trustGo, '')
    check('…then Set up by itself: the workspace folder’s trust covers it, no new answer', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="done"]').count()) === 1, HUNG_MS)))
    // A project with no agent on Claude Code doesn't count (HI-1871, Darren): no read for it, nothing pending.
    fs.mkdirSync(path.join(ws1, 'delta'), { recursive: true })
    await inv('workspace:refresh')
    check('a project with no agent on this CLI isn’t counted', (await row('Personal').locator('[data-set-up-state="done"]').count()) === 1 && JSON.stringify(await trustOf(inv, personal.id)) === JSON.stringify({ pending: [], unknown: false }))
    // A Git repository in the trusted workspace folder (HI-2520): Claude Code asks for it anyway (a folder above a
    // repository doesn't cover it), so it needs Set Up, at its own folder, not the workspace's again. Then removed.
    const epsilon = path.join(ws1, 'epsilon')
    lib.gitProject(epsilon)
    projectWithAgent(epsilon)
    await inv('workspace:refresh')
    check('a Git project in the trusted workspace folder: its agent put on it', await onPersonal(inv, epsilon))
    const epsilonReal = fs.realpathSync.native(epsilon)
    const gitTrust = await lib.until(async () => {
      const t = await trustOf(inv, personal.id)
      return t && !t.checking && t.pending.length ? t : null
    }, HUNG_MS)
    check('…it needs set up, naming it: the workspace folder’s trust doesn’t cover a repository', !!gitTrust && JSON.stringify(gitTrust.pending) === JSON.stringify([{ project: 'epsilon', folder: epsilonReal, git: true }]) && !!(await lib.until(async () => /epsilon/.test(await row('Personal').locator('[data-not-trusted]').innerText().catch(() => '')), HUNG_MS)), JSON.stringify(gitTrust))
    check('…its Set Up would open in the repository’s own folder, not the workspace’s', !!gitTrust && gitTrust.setUpIn?.folder === epsilonReal && !gitTrust.setUpIn.workspace, JSON.stringify(gitTrust?.setUpIn))
    await shots('git-not-covered')
    fs.rmSync(epsilon, { recursive: true, force: true })
    await inv('workspace:refresh')
    check('…removed, it is set up again', !!(await lib.until(async () => (await row('Personal').locator('[data-set-up-state="done"]').count()) === 1, HUNG_MS)))

    // --- Rename: the name only.
    await menuOf('Personal', 'Rename…')
    await fillPrompt('Hive overnight')
    check('Rename… changes its name, not its folder', !!(await lib.until(async () => (await list()).connections.some((a) => a.id === personal.id && a.name === 'Hive overnight'), HUNG_MS)) && fs.existsSync(folder))

    // --- A login changed with Settings closed (a /login in a pane): its watch finds it.
    await page.keyboard.press('Escape')
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    fs.writeFileSync(path.join(folder, 'fake-account.json'), JSON.stringify({ email: 'two@example.com', orgId: 'org-1' }))
    // As a /login changes it: its account, the rest of the file (its onboarding, its trusted folders) kept.
    const claudeJson = path.join(folder, '.claude.json')
    fs.writeFileSync(claudeJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(claudeJson, 'utf8')), oauthAccount: { emailAddress: 'two@example.com' } }))
    const changed = await lib.until(async () => {
      const a = (await list()).connections.find((x) => x.id === personal.id)
      return a?.observed?.email === 'two@example.com' ? a : null
    }, HUNG_MS)
    check('a login changed in its folder with Settings closed is found by itself', !!changed && changed.accepted?.email === 'one@example.com')
    await openSettings()
    await nav.click()
    check('…and shown as changed, with what it was', !!(await lib.until(async () => /Login changed/.test(await row('Hive overnight').innerText().catch(() => '')) && /Now signed in as two@example\.com, was one@example\.com/.test(await row('Hive overnight').innerText().catch(() => '')), HUNG_MS)))
    await shots('changed')
    await row('Hive overnight').getByRole('button', { name: 'Keep the New Login' }).click()
    await fillPrompt('Two')
    check('Keep the New Login takes it on, and offers a rename', !!(await lib.until(async () => (await list()).connections.some((a) => a.id === personal.id && a.accepted?.email === 'two@example.com' && a.name === 'Two'), HUNG_MS)))

    // --- A second account on the same login: both flagged.
    loginAs('two@example.com')
    await addVia('claude-code', 'Work')
    const work = await lib.until(async () => (await list()).connections.find((a) => a.name === 'Work' && a.observed?.loggedIn) ?? null, HUNG_MS)
    check('a second account signs in', !!work)
    check('two accounts on one login are both flagged', !!(await lib.until(async () => (await page.locator('[data-warning="duplicate"]').count()) === 2, HUNG_MS)))
    await shots('duplicate')

    // --- The one order of accounts (HI-2107, decision A): drag or Alt+Up/Down reorders, never turning one on or off;
    // no Default or Make Default any more. Each account's connections are listed under it, the first named after it.
    const claudeOrder = async () => (await list()).connections.filter((c) => c.provider === 'claude-code').map((c) => c.id)
    const onHere = async () => (await list()).workspace['claude-code']?.on ?? []
    check('no Default, Make Default or Used here on any row', (await page.locator('[data-default-hint], [data-make-default], [data-used-here]').count()) === 0)
    check('each account lists its first connection under it, named after it as it was added (a rename leaves it)', !!(await lib.until(async () => /Personal/.test(await page.locator(`[data-connections-of="${personal.id}"] [data-connection]`).first().innerText().catch(() => '')) && (await page.locator(`[data-connections-of="${work.id}"] [data-connection]`).count()) === 1, HUNG_MS)))
    check('…and On here on every row, on or off', (await row('Two').locator('[data-on-here]').count()) === 1 && (await row('Work').locator('[data-on-here]').count()) === 1)
    await shots('order')
    const onBefore = JSON.stringify(await onHere())
    // Dragged to the top by its handle.
    await row('Work').locator('[data-move-handle]').dragTo(row('Two'))
    check('dragging a row onto another moves it there in the one order', !!(await lib.until(async () => JSON.stringify(await claudeOrder()) === JSON.stringify([work.id, personal.id]), HUNG_MS)))
    check('…turning nothing on or off', JSON.stringify(await onHere()) === onBefore)
    // From the keyboard: Alt+Down on its handle, then Alt+Up.
    await row('Work').locator('[data-move-handle]').focus()
    await page.keyboard.press('Alt+ArrowDown')
    check('Alt+Down on the handle moves it down', !!(await lib.until(async () => JSON.stringify(await claudeOrder()) === JSON.stringify([personal.id, work.id]), HUNG_MS)))
    await row('Work').locator('[data-move-handle]').focus()
    await page.keyboard.press('Alt+ArrowUp')
    check('…Alt+Up back to the top', !!(await lib.until(async () => JSON.stringify(await claudeOrder()) === JSON.stringify([work.id, personal.id]), HUNG_MS)))
    await inv('connections:move', personal.id, 0)
    await lib.until(async () => JSON.stringify(await claudeOrder()) === JSON.stringify([personal.id, work.id]), HUNG_MS)

    // --- A second window: its workspace keeps its own choice.
    const next = app.waitForEvent('window')
    await inv('window:new')
    const p2 = await next
    await p2.waitForLoadState('domcontentloaded')
    await lib.appReady(p2)
    await lib.openWorkspace(invOn(p2), p2, ws2)
    // A new workspace starts with the last account chosen as a default (Darren, 26 Oct): Personal.
    check('a new workspace starts with the top of the order on (HI-1875), the one used there', JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [personal.id] } }), JSON.stringify(wsJson(ws2)))
    // One connection, two workspaces (HI-1870): set up for the first one's folders, not yet for this one's.
    const alpha2 = fs.realpathSync.native(path.join(ws2, 'alpha'))
    check('its alpha’s agent put on it there too', await onPersonal(invOn(p2), path.join(ws2, 'alpha')))
    check('one connection in two workspaces: each window says its own (here alpha untrusted, set up in the first)', !!(await lib.until(async () => !!(await trustOf(invOn(p2), personal.id))?.pending.some((p) => p.project === 'alpha' && p.folder === alpha2), HUNG_MS)) && JSON.stringify(await trustOf(inv, personal.id)) === JSON.stringify({ pending: [], unknown: false }), JSON.stringify([await trustOf(invOn(p2), personal.id), await trustOf(inv, personal.id), alpha2]))
    await invOn(p2)('connections:setOn', personal.id, false)
    check('…off there, its trust there no longer counts', !!(await lib.until(async () => (await trustOf(invOn(p2), personal.id)) === null, HUNG_MS)))
    await invOn(p2)('connections:setOn', personal.id, true)
    check('…turned on there again, it needs set up there again', !!(await lib.until(async () => !!(await trustOf(invOn(p2), personal.id))?.pending.some((p) => p.project === 'alpha'), HUNG_MS)))
    await invOn(p2)('connections:setOn', personal.id, false)
    await invOn(p2)('connections:setOn', work.id, true)
    check('a second window’s workspace has Work on', !!(await lib.until(async () => JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [work.id] } }), HUNG_MS)), JSON.stringify(wsJson(ws2)))
    check('…and the first keeps its own', JSON.stringify(wsJson(ws1)) === JSON.stringify({ 'claude-code': { on: [personal.id] } }), JSON.stringify(wsJson(ws1)))
    check('…each window lists its own workspace’s choice', JSON.stringify((await list()).workspace) !== JSON.stringify((await invOn(p2)('connections:list')).workspace))
    await invOn(p2)('connections:setOn', work.id, false)
    check('turned all off there, it stays off', !!(await lib.until(async () => JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [] } }), HUNG_MS)))
    await p2.close()

    // --- A Codex connection in the same list (HI-1870), its Set Up the one-time Windows sandbox, said the same way.
    await closeEnded()
    loginAs('codex@example.com')
    await addVia('codex', 'ChatGPT')
    const gpt = await lib.until(async () => (await list()).connections.find((a) => a.name === 'ChatGPT' && a.observed?.loggedIn) ?? null, HUNG_MS)
    check('a Codex connection signs in', !!gpt, JSON.stringify((await list()).connections.map((a) => [a.name, a.observed])))
    check('…in the same list, last in the one order (HI-2107), with its own CLI and icon', !!(await lib.until(async () => JSON.stringify(await page.locator('.account-block').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-cli')))) === JSON.stringify(['claude-code', 'claude-code', 'codex']), HUNG_MS)) && (await row('ChatGPT').locator('.account-cli .provider-icon').count()) === 1)
    check('…needing set up, said as for Claude Code, naming the sandbox', !!(await lib.until(async () => (await row('ChatGPT').locator('[data-set-up-state="needed"]').count()) === 1, HUNG_MS)) && (await row('ChatGPT').locator('[data-set-up].primary').count()) === 1 && /Windows sandbox/.test(await row('ChatGPT').locator('[data-set-up-note]').innerText().catch(() => '')))
    await closeEnded()
    await shots('codex-needs-set-up')
    await row('ChatGPT').locator('[data-set-up]').click()
    check('…its Set Up says what it is for', !!(await lib.until(async () => /Windows sandbox/.test(await page.locator('.account-signin .hint').innerText().catch(() => '')), HUNG_MS)))
    const gptToml = path.join(accountsRoot, gpt?.id ?? '', 'config.toml')
    await lib.until(async () => fs.existsSync(gptToml) && /sandbox/.test(fs.readFileSync(gptToml, 'utf8')), HUNG_MS)
    check('…closed while Codex runs (asked, confirmed), its row then says it is set up', !!(await closeRunning(true)) && !!(await lib.until(async () => (await row('ChatGPT').locator('[data-set-up-state="done"]').count()) === 1, HUNG_MS)))
    await shots('codex-set-up')

    // --- A sign-in still waiting for its browser: Close asks, and Remove offers to close it (HI-1870).
    loginAs('held@example.com', true)
    await addVia('claude-code', 'Held')
    const held = await lib.until(async () => (await list()).connections.find((a) => a.name === 'Held') ?? null, HUNG_MS)
    check('a sign-in still waiting has its terminal open, with Close', !!held && !!(await lib.until(async () => terminalOpen(held.id), HUNG_MS)) && (await page.locator('.account-signin [data-close-terminal]').count()) === 1)
    check('…Close asks first, and ends it once confirmed, the connection kept, not signed in', !!(await closeRunning(true)) && !!(await lib.until(async () => !(await terminalOpen(held.id)) && (await page.locator('.account-signin').count()) === 0, HUNG_MS)) && !!(await list()).connections.find((a) => a.id === held.id && !a.accepted))
    await menuOf('Held', 'Sign In')
    await lib.until(async () => terminalOpen(held.id), HUNG_MS)
    await menuOf('Held', 'Remove…')
    const askOpen = page.locator('.dialog', { hasText: 'Close its terminal and remove Held?' })
    check('Remove with its sign-in open asks to close its terminal and remove it', !!(await lib.until(async () => (await askOpen.count()) === 1, HUNG_MS)) && /Close Terminal and Remove/.test(await askOpen.locator('.dialog-footer .btn.danger').innerText()))
    await shots('remove-open')
    await askOpen.locator('.dialog-footer .btn.danger').click()
    check('…confirmed, the terminal is ended and the connection removed, its folder gone', !!(await lib.until(async () => !(await list()).connections.some((a) => a.id === held.id) && !fs.existsSync(path.join(accountsRoot, held.id)) && (await page.locator('.account-signin').count()) === 0, HUNG_MS)))

    // --- Remove: the folder for good, the conversations kept.
    const workFolder = path.join(accountsRoot, work.id)
    await menuOf('Work', 'Remove…')
    const ask = page.locator('.dialog', { hasText: 'Remove Work?' })
    check('Remove… asks first, saying its login on this PC goes with it', !!(await lib.until(async () => /deleted for good, with its login on this PC/.test(await ask.innerText().catch(() => '')), HUNG_MS)))
    await ask.locator('.dialog-footer .btn.danger').click()
    check('…then the account and its folder are gone', !!(await lib.until(async () => !(await list()).connections.some((a) => a.id === work.id) && !fs.existsSync(workFolder), HUNG_MS)))
    check('…the conversations it linked to untouched', fs.readFileSync(conversation, 'utf8').includes('kept'))
    check('…and the other account no longer flagged', !!(await lib.until(async () => (await page.locator('[data-warning="duplicate"]').count()) === 0, HUNG_MS)))
    await shots('after-remove')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }

  // --- The preference order's one-time move (HI-1875), on a profile from before it: two workspaces with different
  // defaults, the most recently opened's (Max 2) goes to the top; an agent pinned to Max 3 launched last
  // (lastUsedConnection) is never taken for a default. Read once at start; nothing else changed.
  const migProfile = path.join(lib.WORK, 'accounts-migrate-profile')
  const migNew = path.join(lib.WORK, 'accounts-migrate-new')
  const migOld = path.join(lib.WORK, 'accounts-migrate-old')
  for (const d of [migProfile, migNew, migOld]) fs.rmSync(d, { recursive: true, force: true })
  const migEnv = lib.fakeClaude(migProfile, home, [])
  const migCfgFile = path.join(migProfile, 'config.json')
  const migCfg = JSON.parse(fs.readFileSync(migCfgFile, 'utf8'))
  const conn = (id, name) => ({ id, provider: 'claude-code', kind: 'signIn', name, createdAt: '2026-10-27T00:00:00.000Z', defaults: {} })
  migCfg.connections = [conn('a-max1', 'Max 1'), conn('a-max2', 'Max 2'), conn('a-max3', 'Max 3')]
  migCfg.lastUsedConnection = { 'claude-code': 'a-max3' }
  migCfg.recentWorkspaces = [migNew, migOld]
  fs.writeFileSync(migCfgFile, JSON.stringify(migCfg, null, 2))
  for (const [w, def] of [[migNew, 'a-max2'], [migOld, 'a-max1']]) {
    fs.mkdirSync(path.join(w, '.combwork'), { recursive: true })
    fs.writeFileSync(path.join(w, '.combwork', 'workspace.json'), JSON.stringify({ version: 1, connections: { 'claude-code': { on: ['a-max1', 'a-max2'], default: def } } }))
  }
  const mig = await lib.launch({ userData: migProfile, env: migEnv, viewport: { width: 1200, height: 800 } })
  try {
    // The accounts, as config.json's migration made them from its connections (HI-2106), the order's move with them.
    const order = () => (JSON.parse(fs.readFileSync(migCfgFile, 'utf8')).accounts ?? []).filter((a) => !a.home).map((c) => c.id).join(',')
    check('migration: the most recent workspace default (Max 2) is the top of the order, the rest in their order', !!(await lib.until(async () => order() === 'a-max2,a-max1,a-max3', HUNG_MS)), order())
    check('…never the last launch on an agent’s own connection (Max 3), and done once', JSON.parse(fs.readFileSync(migCfgFile, 'utf8')).connectionOrderMigrated === true)
  } catch (e) {
    check('the migration part ran to its end', false, e.stack)
  } finally {
    await mig.app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
