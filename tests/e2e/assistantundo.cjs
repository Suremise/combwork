// Undo of the Assistant's changes in its panel (#1283, SPEC §16.14): "Done by the Assistant" lists its changes by the
// user's message they came from ("Your message at 08:14: 70 changes · Undo"), the newest open and the others folded,
// each change on its row with Undo. S24 in the window: 70 relabels in one message, the user edits one card since, Undo
// on the message asks first, then says what it did (69 undone, 1 kept with why), the card the user edited keeping their
// labels. What undo did is kept with each change (#1283 round 2): after a reload the card the user edited still says
// Kept, never Undone. Undo on a single change puts it back and strikes the row through with when; a comment says it
// can't be undone, and why; the Assistant's own undo (cw_undo) is listed in the same list, and a change of it the user
// partly changed since says Partly undone, after a reload too. Screenshots in both themes and in Polish. The Assistant runs the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'assistantundo-profile')
const ws = path.join(lib.WORK, 'assistantundo-ws')
const claudeHome = path.join(lib.WORK, 'assistantundo-claude-home')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(path.join(ws, 'alpha'))
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), path.join(ws, 'alpha').toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47926), CLAUDE_CONFIG_DIR: claudeHome })

  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1500, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const home = (await inv('workspace:refresh')).assistant.path
    const key = lib.ptyKey(home, 'assistant')
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
    const panel = () => page.locator('.assistant-panel')
    const prompts = lib.fakePrompts((ch, ...a) => inv(ch, ...a), key, () => live(), { home: claudeHome })
    const say = async (text) => !!(await prompts.say(text))
    const themed = async (theme) => {
      await inv('settings:update', { appearance: { theme } })
      return !!(await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS))
    }
    const shots = async (name, el = panel()) => {
      for (const theme of ['dark', 'light']) {
        await themed(theme)
        await el.screenshot({ path: path.join(lib.WORK, `assistantundo-${name}-${theme}.png`) })
      }
      await themed('dark')
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

    // The Assistant's panel, started.
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Control+Alt+I')
    await lib.until(async () => (await panel().locator('.assistant-header').count()) === 1, HUNG_MS)
    await panel().locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
    check('the Assistant starts', !!(await lib.until(async () => (await live())?.status === 'ready' || (await live())?.status === 'finished', HUNG_MS)))

    // --- S24: 70 cards the user made, relabelled by the Assistant in one message (one batch).
    const numbers = []
    for (let i = 1; i <= 70; i++) numbers.push((await inv('tasks:create', { project: 'alpha', title: `Card ${i}` })).number)
    check('it relabels 70 cards in one message', await say(`cw cw_update_tasks ${JSON.stringify({ numbers, addLabels: ['triage'] })}`))
    check('…every card has the label', !!(await lib.until(async () => (await inv('tasks:list')).filter((c) => numbers.includes(c.number) && c.labels?.includes('triage')).length === 70, HUNG_MS)))
    // The user edits one of them since: its labels are theirs now.
    const edited = numbers[4]
    await inv('tasks:update', edited, { labels: ['mine'] })
    const link = panel().locator('.assistant-done-link')
    check('“Done by the Assistant (70)”', !!(await lib.until(async () => /Done by the Assistant\s*\(70\)/i.test(await link.innerText().catch(() => '')), HUNG_MS)), await link.innerText().catch(() => ''))
    await link.click()
    const groups = panel().locator('.assistant-change-group')
    const head = (i) => groups.nth(i).locator('.assistant-change-toggle')
    check('one message: “Your message at …: 70 changes”, open', !!(await lib.until(async () => (await groups.count()) === 1 && /^Your message at .+: 70 changes$/.test((await head(0).innerText()).trim()) && (await head(0).getAttribute('aria-expanded')) === 'true', HUNG_MS)), await groups.first().innerText().catch(() => ''))
    const rows = groups.first().locator('.assistant-action')
    check('…its changes, each with Undo (the last 3, Show all for the rest)', (await rows.count()) === 3 && (await rows.locator('.assistant-undo').count()) === 3 && /labels/.test(await rows.first().innerText()), await rows.first().innerText().catch(() => ''))
    await shots('message')

    // Undo on the message: asked first.
    await groups.first().locator('.assistant-undo-group').click()
    const dialog = page.locator('.dialog')
    check('Undo on the message asks first: “Undo 70 changes?”, what since is kept', !!(await lib.until(async () => /Undo 70 changes\?/.test(await dialog.innerText().catch(() => '')) && /Changes made since by you or an agent are kept\./.test(await dialog.innerText().catch(() => '')), HUNG_MS)), await dialog.innerText().catch(() => ''))
    await dialog.screenshot({ path: path.join(lib.WORK, 'assistantundo-ask-dark.png') })
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
    const result = groups.first().locator('.assistant-undo-result')
    check('…then says what it did: 69 undone, 1 kept as it is', !!(await lib.until(async () => /69 changes undone/.test(await result.innerText().catch(() => '')) && /1 kept as it is:/.test(await result.innerText().catch(() => '')), HUNG_MS)), await result.innerText().catch(() => ''))
    const keptLine = await result.locator('.assistant-undo-kept li').innerText().catch(() => '')
    check('…the card the user edited listed, with why', /Card 5/.test(keptLine) && /labels changed since/.test(keptLine), keptLine)
    const after = (await inv('tasks:list')).filter((c) => numbers.includes(c.number))
    check('…every other card without the label, the edited one with the user’s', after.filter((c) => c.labels?.includes('triage')).length === 0 && JSON.stringify((await card(edited)).labels) === '["mine"]', JSON.stringify((await card(edited)).labels))
    check('…its rows struck through, Undo no longer offered', !!(await lib.until(async () => (await groups.first().locator('.assistant-action.undone').count()) >= 2 && (await groups.first().locator('.assistant-undo, .assistant-undo-group').count()) === 0, HUNG_MS)))
    await shots('result')
    // After a reload (what the window kept is gone): the card the user edited says Kept, the others Undone.
    const reload = async () => {
      await page.reload()
      await lib.until(async () => (await panel().locator('.assistant-header').count()) === 1, HUNG_MS)
      await lib.until(async () => (await groups.count()) >= 1, HUNG_MS)
    }
    await reload()
    await groups.first().getByRole('button', { name: /Show all 7\d/ }).click()
    const keptRow = groups.first().locator('.assistant-action[data-status="kept"]')
    check('after a reload: the edited card’s change still says Kept, not Undone; the rest Undone', !!(await lib.until(async () => (await keptRow.count()) === 1 && /Card 5/.test(await keptRow.innerText()) && /Kept/.test(await keptRow.innerText()) && (await groups.first().locator('.assistant-action[data-status="undone"]').count()) === 69, HUNG_MS)), await keptRow.innerText().catch(() => ''))
    const keptTip = await lib.hoverTip(page, keptRow, (t) => /labels changed since/.test(t), HUNG_MS)
    check('…its tooltip says why: labels changed since', /labels changed since/.test(keptTip), keptTip)
    await page.mouse.move(5, 5)

    // --- One change at a time: a title and a comment in the next message.
    const [one, two] = [numbers[0], numbers[1]]
    check('a new message: a title changed and a comment', await say(`cw cw_update_task {"number":${one},"title":"Renamed by the Assistant"} then cw cw_update_task {"number":${two},"comment":"A note"}`))
    check('…the newest message open, the one before folded', !!(await lib.until(async () => (await groups.count()) === 2 && (await head(0).getAttribute('aria-expanded')) === 'true' && (await head(1).getAttribute('aria-expanded')) === 'false', HUNG_MS)), String(await groups.count()))
    const titleRow = groups.first().locator('.assistant-action', { hasText: 'Renamed by the Assistant' })
    const commentRow = groups.first().locator('.assistant-action[data-status="final"]')
    check("…the comment says it can't be undone, with no Undo", !!(await lib.until(async () => (await commentRow.count()) >= 1, HUNG_MS)) && /Can't be undone/.test(await commentRow.first().innerText()) && (await commentRow.locator('.assistant-undo').count()) === 0, await groups.first().innerText().catch(() => ''))
    check('…the title change has Undo', (await titleRow.locator('.assistant-undo').count()) === 1 && /title/.test(await titleRow.innerText()), await titleRow.innerText().catch(() => ''))
    await titleRow.locator('.assistant-undo').click()
    check('Undo on it: the title is back', !!(await lib.until(async () => (await card(one))?.title === 'Card 1', HUNG_MS)), (await card(one))?.title)
    check('…its row struck through, “Undone just now”, no Undo', !!(await lib.until(async () => (await groups.first().locator('.assistant-action.undone').count()) === 1 && /Undone just now/.test(await groups.first().locator('.assistant-action.undone').innerText()) && (await groups.first().locator('.assistant-action.undone .assistant-undo').count()) === 0, HUNG_MS)), await groups.first().innerText().catch(() => ''))
    await shots('single')

    // --- The Assistant's own undo, in the same list: a change the user partly changed since says Partly undone.
    check('a third message: it blocks a card and renames it', await say(`cw cw_update_task {"number":${numbers[2]},"blocked":"Waiting on a decision","title":"Renamed again"}`))
    await inv('tasks:update', numbers[2], { title: 'My own title' })
    check('…then undoes it with its own tool', await say('cw cw_undo {"group":"latest"}'))
    check('…its undo listed with its message (the newest, open)', !!(await lib.until(async () => (await groups.count()) === 4 && (await groups.first().locator('.assistant-action', { hasText: 'Undid 1 of 1 change of its own' }).count()) === 1, HUNG_MS)) && !(await card(numbers[2]))?.blocked, await panel().locator('.assistant-actions').innerText().catch(() => ''))
    // The message before it, opened: the change it undid, struck through.
    await head(1).click()
    const partlyRow = groups.nth(1).locator('.assistant-action[data-status="partly"]')
    check('…the change it undid says Partly undone in its own message (the block put back, the title the user’s)', !!(await lib.until(async () => (await partlyRow.count()) === 1 && /Partly undone/.test(await partlyRow.innerText()), HUNG_MS)) && !(await card(numbers[2]))?.blocked && (await card(numbers[2]))?.title === 'My own title', await groups.nth(1).innerText().catch(() => ''))
    await reload()
    await head(1).click()
    check('…and after a reload', !!(await lib.until(async () => (await partlyRow.count()) === 1, HUNG_MS)), await groups.nth(1).innerText().catch(() => ''))

    // --- In Polish (as main sends a change of language, with Polish's own catalogue).
    const base = (await inv('app:info')).language
    const dir = path.join(lib.ROOT, 'locales', 'pl')
    const messages = Object.assign({}, ...fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    const speak = (language) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'language-changed', language })
    await speak({ ...base, code: 'pl', locale: 'pl', messages })
    check('the list in Polish', !!(await lib.until(async () => !/Your message at/.test(await panel().locator('.assistant-actions').innerText().catch(() => 'Your message at')), HUNG_MS)), await panel().locator('.assistant-actions').innerText().catch(() => ''))
    await panel().screenshot({ path: path.join(lib.WORK, 'assistantundo-pl.png') })
    await speak(base)
  } finally {
    await app.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
