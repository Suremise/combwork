// Settings → Accounts (HI-980, staged behind Settings → Advanced → Accounts (preview)): hidden while the preview is off;
// Add Account… makes the account's folder (its projects\ a junction to the CLI home's) and opens its sign-in in Hive's
// terminal, nothing typed into it; once it ends, the row says who it is signed in as. Turned on, it is this workspace's
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
  fs.mkdirSync(path.dirname(conversation), { recursive: true })
  fs.writeFileSync(conversation, '{"kept":true}\n')
  for (const w of [ws1, ws2]) fs.mkdirSync(path.join(w, 'alpha'), { recursive: true })
  const loginAs = (email) => {
    fs.mkdirSync(accountsRoot, { recursive: true })
    fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, orgId: 'org-1' }))
  }

  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 950 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const invOn = (p) => (ch, ...a) => p.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const inv = invOn(page)
    await lib.openWorkspace(inv, page, ws1)
    const list = () => inv('accounts:list')
    const wsJson = (w) => JSON.parse(fs.readFileSync(path.join(w, '.hive', 'workspace.json'), 'utf8')).accounts
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

    // --- Hidden while the preview is off.
    await openSettings()
    check('Settings → Accounts is hidden while its preview is off', (await nav.count()) === 0)
    check('…and nothing about accounts is given out', (await list()).preview === false)
    await inv('advanced:set', 'hive.accounts.preview', true)
    check('the preview on, Settings → Accounts shows', !!(await lib.until(async () => (await nav.count()) === 1, HUNG_MS)))
    await nav.click()
    check('…with no accounts yet', !!(await lib.until(async () => (await page.getByText('No accounts yet').count()) === 1, HUNG_MS)))

    // --- Add Account…: the folder and junction, then its sign-in in Hive's terminal.
    loginAs('one@example.com')
    await page.locator('[data-add="claude-code"]').click()
    await fillPrompt('Personal')
    const personal = await lib.until(async () => (await list()).accounts.find((a) => a.name === 'Personal') ?? null, HUNG_MS)
    check('Add Account… adds it', !!personal)
    const folder = personal ? path.join(accountsRoot, personal.id) : ''
    check('…its folder in the profile’s accounts folder, projects a junction to the CLI home’s', !!personal && fs.lstatSync(path.join(folder, 'projects')).isSymbolicLink() && fs.existsSync(path.join(folder, 'projects', 'C--work-alpha', 'kept.jsonl')))
    check('…and opens its sign-in in a terminal of Hive’s', !!(await lib.until(async () => (await page.locator('.account-signin .task-terminal').count()) === 1, HUNG_MS)))
    const signed = await lib.until(async () => {
      const a = (await list()).accounts.find((x) => x.id === personal?.id)
      return a?.accepted?.email === 'one@example.com' && a.observed?.loggedIn === true ? a : null
    }, HUNG_MS)
    check('once the sign-in ends, it is signed in as that login, taken on as its own', !!signed, JSON.stringify((await list()).accounts))
    check('…and its row says so', !!(await lib.until(async () => /Signed in/.test(await row('Personal').innerText().catch(() => '')) && /one@example\.com · max/.test(await row('Personal').innerText().catch(() => '')), HUNG_MS)))
    await shots('signed-in')
    await page.locator('.account-signin .btn', { hasText: 'Close' }).click().catch(() => undefined)

    // --- On in this workspace: its default.
    await row('Personal').getByRole('switch').click()
    check('turned on here, it is this workspace’s default (workspace.json)', !!(await lib.until(async () => JSON.stringify(wsJson(ws1)) === JSON.stringify({ 'claude-code': { on: [personal.id], default: personal.id } }), HUNG_MS)), JSON.stringify(wsJson(ws1)))
    check('…and its row says so', !!(await lib.until(async () => (await row('Personal').locator('.account-default').count()) === 1, HUNG_MS)))

    // --- Rename: the name only.
    await row('Personal').getByRole('button', { name: 'Rename…' }).click()
    await fillPrompt('Hive overnight')
    check('Rename… changes its name, not its folder', !!(await lib.until(async () => (await list()).accounts.some((a) => a.id === personal.id && a.name === 'Hive overnight'), HUNG_MS)) && fs.existsSync(folder))

    // --- A login changed with Settings closed (a /login in a pane): its watch finds it.
    await page.keyboard.press('Escape')
    await page.locator('.activity-btn[aria-label="Task Board"]').click()
    fs.writeFileSync(path.join(folder, 'fake-account.json'), JSON.stringify({ email: 'two@example.com', orgId: 'org-1' }))
    fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com' } }))
    const changed = await lib.until(async () => {
      const a = (await list()).accounts.find((x) => x.id === personal.id)
      return a?.observed?.email === 'two@example.com' ? a : null
    }, HUNG_MS)
    check('a login changed in its folder with Settings closed is found by itself', !!changed && changed.accepted?.email === 'one@example.com')
    await openSettings()
    await nav.click()
    check('…and shown as changed, with what it was', !!(await lib.until(async () => /Login changed/.test(await row('Hive overnight').innerText().catch(() => '')) && /Now signed in as two@example\.com, was one@example\.com/.test(await row('Hive overnight').innerText().catch(() => '')), HUNG_MS)))
    await shots('changed')
    await row('Hive overnight').getByRole('button', { name: 'Keep the New Login' }).click()
    await fillPrompt('Two')
    check('Keep the New Login takes it on, and offers a rename', !!(await lib.until(async () => (await list()).accounts.some((a) => a.id === personal.id && a.accepted?.email === 'two@example.com' && a.name === 'Two'), HUNG_MS)))

    // --- A second account on the same login: both flagged.
    loginAs('two@example.com')
    await page.locator('[data-add="claude-code"]').click()
    await fillPrompt('Work')
    const work = await lib.until(async () => (await list()).accounts.find((a) => a.name === 'Work' && a.observed?.loggedIn) ?? null, HUNG_MS)
    check('a second account signs in', !!work)
    check('two accounts on one login are both flagged', !!(await lib.until(async () => (await page.locator('[data-warning="duplicate"]').count()) === 2, HUNG_MS)))
    await shots('duplicate')

    // --- A second window: its workspace keeps its own choice.
    const next = app.waitForEvent('window')
    await inv('window:new')
    const p2 = await next
    await p2.waitForLoadState('domcontentloaded')
    await lib.appReady(p2)
    await lib.openWorkspace(invOn(p2), p2, ws2)
    // A new workspace starts with the last account chosen as a default (Darren, 26 Oct): Personal.
    check('a new workspace starts with the last-used account on, as its default', JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [personal.id], default: personal.id } }), JSON.stringify(wsJson(ws2)))
    await invOn(p2)('accounts:setOn', personal.id, false)
    await invOn(p2)('accounts:setOn', work.id, true)
    check('a second window’s workspace has Work on, as its default', !!(await lib.until(async () => JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [work.id], default: work.id } }), HUNG_MS)), JSON.stringify(wsJson(ws2)))
    check('…and the first keeps its own', JSON.stringify(wsJson(ws1)) === JSON.stringify({ 'claude-code': { on: [personal.id], default: personal.id } }), JSON.stringify(wsJson(ws1)))
    check('…each window lists its own workspace’s choice', JSON.stringify((await list()).workspace) !== JSON.stringify((await invOn(p2)('accounts:list')).workspace))
    await invOn(p2)('accounts:setOn', work.id, false)
    check('turned all off there, it stays off (no default)', !!(await lib.until(async () => JSON.stringify(wsJson(ws2)) === JSON.stringify({ 'claude-code': { on: [], default: null } }), HUNG_MS)))
    await p2.close()

    // --- Remove: the folder for good, the conversations kept.
    const workFolder = path.join(accountsRoot, work.id)
    await row('Work').getByRole('button', { name: 'Remove…' }).click()
    const ask = page.locator('.dialog', { hasText: 'Remove Work?' })
    check('Remove… asks first, saying its login on this PC goes with it', !!(await lib.until(async () => /deleted for good, with its login on this PC/.test(await ask.innerText().catch(() => '')), HUNG_MS)))
    await ask.locator('.dialog-footer .btn.danger').click()
    check('…then the account and its folder are gone', !!(await lib.until(async () => !(await list()).accounts.some((a) => a.id === work.id) && !fs.existsSync(workFolder), HUNG_MS)))
    check('…the conversations it linked to untouched', fs.readFileSync(conversation, 'utf8').includes('kept'))
    check('…and the other account no longer flagged', !!(await lib.until(async () => (await page.locator('[data-warning="duplicate"]').count()) === 0, HUNG_MS)))
    await shots('after-remove')
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
