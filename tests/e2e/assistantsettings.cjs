// The Hive Assistant changes Hive's settings (#186). With Settings → Assistant → Control → Change settings on, its
// cw_update_setting changes a setting as Settings would: Settings shows the new value (modified), its panel lists the
// change with old → new and an Undo button (#1283), and Undo puts the old value back (the change struck through, undone).
// A project's setting changes in Project Settings. Its own Control and other sensitive settings are refused and listed as
// not done; with Change settings turned off while it runs, a change is refused at once. Change settings is a switch
// under Control, off by default. The Assistant runs the fake Claude Code (fake-claude/), whose "hive TOOL {json}" calls a
// tool through the real hive MCP server. Screenshots in both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'assistantsettings-profile')
const ws = path.join(lib.WORK, 'assistantsettings-ws')
const claudeHome = path.join(lib.WORK, 'assistantsettings-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47912), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path
  const key = lib.ptyKey(home, 'assistant')
  const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === home.toLowerCase() && s.agentId === 'assistant')
  const settings = async () => inv('settings:get')
  // Each prompt is typed once the fake takes prompts and waited for by its own turn (#672, #684: lib.fakePrompts).
  const prompts = lib.fakePrompts(inv, key, live, { home: claudeHome, why: () => whyNotFinished() })
  const typeLine = prompts.type
  /** Has the Assistant run one prompt (fake commands): true once that prompt's own turn has ended. */
  const say = async (text) => !!(await prompts.say(text))
  /**
   * Evidence for a turn that didn't finish (#551: the restarted Assistant's terminal ended just after its first call):
   * the session's state, how each fake ended (fake-exits.jsonl: none for one ended from outside), and Hive's log of
   * terminals and the Assistant.
   */
  const whyNotFinished = async () => {
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/) : [])
    for (const l of read(path.join(claudeHome, 'fake-exits.jsonl'))) console.log(`DIAGNOSTIC fake exit: ${l.slice(0, 600)}`)
    for (const l of read(path.join(claudeHome, 'fake-launches.jsonl'))) console.log(`DIAGNOSTIC fake launch: session ${JSON.parse(l).sessionId}`)
    for (const l of read(path.join(userData, 'logs', 'hive.log')).filter((line) => /\[(pty|assistant|sessions?|agents?|processes)\]|WARN|ERROR/.test(line)).slice(-40)) console.log(`DIAGNOSTIC ${l.slice(0, 400)}`)
  }
  // The window draws what it's asked for once it has it: the panel lists an action when main's event reaches it, which
  // can be after the turn that made it has ended (#672), and a settings page after its click. So what it shows is waited
  // for, bounded only for a hung run; one not there at the first look is logged with how long it took.
  const shows = async (what, fn) => {
    const t = Date.now()
    let looks = 0
    const v = await lib.until(async () => (looks++, await fn()), HUNG_MS)
    if (looks > 1) console.log(`  (${what}: ${v ? 'shown' : 'not shown'} after ${Date.now() - t} ms)`)
    return v
  }
  const textOf = (loc) => loc.innerText().catch(() => '')
  /** Waits for `loc`'s text to match `re`; returns the text it showed last. */
  const showsText = async (what, loc, re) => {
    let text = ''
    await shows(what, async () => re.test((text = await textOf(loc))))
    return text
  }

  // --- Change settings: under Control, off by default.
  check('Change settings is off by default', (await settings()).assistant.changeSettings === false)
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Assistant' }).click()
  const row = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Change settings' }) })
  const titles = () => page.locator('.settings-content .setting .s-title').allInnerTexts()
  check('Settings → Assistant shows Change settings, after Control', !!(await shows('Settings → Assistant', async () => (await row.count()) === 1)) && (await titles()).findIndex((t) => t.startsWith('Change settings')) === (await titles()).findIndex((t) => t.startsWith('Control')) + 1, JSON.stringify(await titles()))
  await row.locator('.switch, [role="switch"], input[type="checkbox"]').first().click()
  check('…and turns on', !!(await lib.until(async () => (await settings()).assistant.changeSettings === true, HUNG_MS)))
  await page.keyboard.press('Escape')

  // --- The Assistant, started with it on.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+I')
  const panel = page.locator('.assistant-panel')
  await lib.until(async () => (await panel.locator('.assistant-header').count()) === 1, HUNG_MS)
  await panel.locator('.assistant-header').getByRole('button', { name: 'Start', exact: true }).click()
  check('the Assistant runs', !!(await lib.until(async () => (await live())?.status === 'ready', 20000)))

  // --- A change: Settings shows it, the panel lists it with Undo.
  check('it changes a setting', await say('skill tune-settings then hive cw_update_setting {"id":"sessions.transcriptWarnMB","value":50}'))
  check('…which is now 50 MB', (await settings()).sessions.transcriptWarnMB === 50, String((await settings()).sessions.transcriptWarnMB))
  // The list opens from "Done by the Assistant (n)" at the watch line's end (#979: closed until then).
  const doneLink = panel.locator('.assistant-done-link')
  await lib.until(async () => (await doneLink.count()) === 1, HUNG_MS)
  if ((await doneLink.getAttribute('aria-expanded')) !== 'true') await doneLink.click()
  const action = panel.locator('.assistant-action', { hasText: 'Warn when a transcript is over' }).first()
  const changed =/Changed Settings → Sessions → Warn when a transcript is over: 20 → 50/
  const changedText = await showsText('the change', action, changed)
  check('its panel lists the change, old → new', changed.test(changedText), changedText)
  const revert = action.getByRole('button', { name: /^Undo: Changed Settings → Sessions → Warn when a transcript is over: 20 → 50/ })
  check('…with an Undo button', !!(await shows('its Undo', async () => (await revert.count()) === 1)))
  await page.keyboard.press('Control+,')
  await page.locator('.settings-nav .row', { hasText: 'Sessions' }).first().click()
  const warn = page.locator('.setting', { has: page.locator('.s-title', { hasText: 'Warn when a transcript is over' }) })
  const warnValue = () => warn.locator('input[type=number]').inputValue().catch(() => '')
  check('Settings → Sessions shows 50, modified', !!(await shows('Settings → Sessions', async () => (await warnValue()) === '50' && (await warn.locator('.modified').count()) === 1)), await warnValue())
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300) // on purpose: the theme's colours settle
    await page.screenshot({ path: path.join(lib.WORK, `assistantsettings-changed-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- Undo: back to 20, and the change struck through.
  await revert.click()
  check('Undo puts it back to 20 MB', !!(await lib.until(async () => (await settings()).sessions.transcriptWarnMB === 20, HUNG_MS)))
  check('…which Settings shows', !!(await lib.until(async () => (await warn.locator('input[type=number]').inputValue()) === '20', HUNG_MS)))
  check('…and the panel strikes the change through, undone', !!(await lib.until(async () => (await panel.locator('.assistant-action.undone', { hasText: 'Warn when a transcript is over: 20 → 50' }).count()) === 1 && (await revert.count()) === 0, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'assistantsettings-reverted.png') })

  // --- A project's setting: Project Settings has it.
  check("it changes a project's setting", await say('hive cw_update_setting {"id":"project.compactSuggestTokens","value":300000,"project":"alpha"}'))
  const alphaCfg = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === alpha.toLowerCase()).config
  check("alpha's Suggest compacting above is 300000", (await alphaCfg()).compactSuggestTokens === 300000, String((await alphaCfg()).compactSuggestTokens))

  // --- Races with the user's own edits (#186 review): a project config write held just before its file is replaced,
  // so another change waits for the lock behind it.
  const projectFile = path.join(alpha, '.hive', 'project.json')
  const holdNextWrite = () =>
    app.evaluate((_, target) => {
      const f = process.mainModule.require('original-fs/promises')
      const original = global.__hiveTestRename ?? (global.__hiveTestRename = f.rename)
      global.__hiveTestGate = { entered: false }
      f.rename = async (...args) => {
        if (!global.__hiveTestGate.entered && String(args[1]).toLowerCase() === target.toLowerCase()) {
          global.__hiveTestGate.entered = true
          await new Promise((resolve) => (global.__hiveTestGate.release = resolve))
          f.rename = original
        }
        return original(...args)
      }
    }, projectFile)
  const held = () => lib.until(() => app.evaluate(() => global.__hiveTestGate.entered), HUNG_MS)
  const release = () => app.evaluate(() => global.__hiveTestGate.release())
  // A change queued for the project's lock (#423): withFileLock (fsutil.ts) queues a call behind the one holding a file's
  // lock by setting the file's key (its path in lower case) in its map of locks, in the same step as the call. While the
  // user's write holds project.json, a set of that key to the queue's promise is a change queued behind it: past all its
  // checks before the lock. Only a promise counts: other maps use the same key (HI-1850: project.json's kept reads,
  // HI-1814, set it on every read, and the lock's call count beside it). Counted from Map.prototype.set in Hive's main
  // process only while a race waits for it, then put back. Were the lock kept some other way, no set would come and the
  // check fails, rather than passing without the race.
  const watchLockQueue = () =>
    app.evaluate((_, lockKey) => {
      const set = (global.__hiveTestMapSet ??= Map.prototype.set)
      global.__hiveTestQueued = 0
      // eslint-disable-next-line eslint/no-extend-native -- in the test copy only, and put back once the race is queued
      Map.prototype.set = function (k, v) {
        if (k === lockKey && typeof v?.then === 'function') global.__hiveTestQueued++
        return set.call(this, k, v)
      }
    }, projectFile.toLowerCase())
  /** Until a change has queued for the project's lock behind the user's held write (the fake's call starts a hive MCP server first, seconds under load); then stops counting. */
  const queuedForLock = async () => {
    const queued = !!(await lib.until(() => app.evaluate(() => global.__hiveTestQueued > 0), 30000))
    await app.evaluate(() => {
      // eslint-disable-next-line eslint/no-extend-native -- putting Map's own set back
      Map.prototype.set = global.__hiveTestMapSet
    })
    return queued
  }
  // Started in the page and left there (nothing returned to wait on: the write is held on purpose).
  const userWrite = (value) =>
    page.evaluate(([p, v]) => {
      window.__userWrite = window.hive.invoke('project:updateConfig', p, { compactSuggestTokens: v }).then(() => 'saved', (e) => e.message)
    }, [alpha, value])

  // Change settings turned off while the Assistant's change waits for the lock: it is refused when its turn comes.
  await inv('settings:update', { assistant: { changeSettings: true } })
  await holdNextWrite()
  await userWrite(400000)
  check("the user's write holds the project's lock", !!(await held()))
  await watchLockQueue()
  const queued = say('hive cw_update_setting {"id":"project.compactSuggestTokens","value":500000,"project":"alpha"}')
  check("the Assistant's change waits behind the user's write", await queuedForLock())
  await inv('settings:update', { assistant: { changeSettings: false } })
  await release()
  await queued
  check("the user's write is saved", (await page.evaluate(() => window.__userWrite)) === 'saved')
  check('the queued change, its permission withdrawn meanwhile, changed nothing', (await alphaCfg()).compactSuggestTokens === 400000, String((await alphaCfg()).compactSuggestTokens))
  // Refused where it waited (under the lock), not by the up-front check a call that arrives after the switch meets.
  const turnedOff = (await inv('assistant:actions')).filter((a) => !a.ok).at(-1)
  check('…listed as not done: Change settings was turned off', !!(await shows('the refused project change', async () => (await panel.locator('.assistant-action.failed', { hasText: 'Change Project Settings → Sessions → Suggest compacting above in alpha' }).count()) >= 1)) && /was turned off before the change was made/.test(turnedOff?.error ?? ''), JSON.stringify(turnedOff))

  // The Assistant restarted while its change waits for the lock: the new session doesn't carry out the old one's change.
  await inv('settings:update', { assistant: { changeSettings: true } })
  await holdNextWrite()
  await userWrite(410000)
  await held()
  const refusedBefore = (await inv('assistant:actions')).filter((a) => !a.ok).length
  await watchLockQueue()
  // Typed, not said: its turn never ends (the session is stopped under it).
  await typeLine('hive cw_update_setting {"id":"project.compactSuggestTokens","value":500000,"project":"alpha"}')
  check("the old session's change waits behind the user's write", await queuedForLock())
  await inv('session:stop', home, 'assistant')
  await lib.until(async () => !(await live()), 15000)
  await inv('session:start', home, { agentId: 'assistant' })
  check('the Assistant starts again', !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), 20000)))
  await release()
  check("the old session's change is refused when its turn comes", !!(await lib.until(async () => (await inv('assistant:actions')).filter((a) => !a.ok).length > refusedBefore, 10000)))
  check("…and the user's write stays", (await alphaCfg()).compactSuggestTokens === 410000, String((await alphaCfg()).compactSuggestTokens))
  check('…listed as not done: its session ended', /session that asked for this ended/.test((await inv('assistant:actions')).filter((a) => !a.ok).at(-1)?.error ?? ''), JSON.stringify((await inv('assistant:actions')).at(-1)))

  // Revert while the user's newer edit holds the lock: it sees that edit and refuses, keeping it.
  await inv('settings:update', { assistant: { changeSettings: true } })
  check('it changes the project setting again', await say('hive cw_update_setting {"id":"project.compactSuggestTokens","value":300000,"project":"alpha"}'))
  const latest = (await inv('assistant:actions')).filter((a) => a.setting?.id === 'project.compactSuggestTokens').at(-1)
  check('…410000 → 300000, listed for Revert', latest?.setting?.oldText === '410000' && latest?.setting?.newText === '300000', JSON.stringify(latest?.setting))
  await holdNextWrite()
  await userWrite(450000)
  await held()
  await page.evaluate((id) => {
    window.__revert = window.hive.invoke('assistant:revertSetting', id).then(() => 'reverted', (e) => e.message)
  }, latest.id)
  await lib.sleep(500) // on purpose: the Revert waits for the lock behind the user's write
  await release()
  const reverted = await page.evaluate(() => window.__revert)
  check('Revert after a newer edit is refused, saying it changed since', /has changed since/.test(reverted), reverted)
  check("…and the user's newer edit stays", (await alphaCfg()).compactSuggestTokens === 450000, String((await alphaCfg()).compactSuggestTokens))

  // --- A table: the board's column colours, changed and reverted.
  check('it changes a column colour', await say('hive cw_update_setting {"id":"board.colors","value":{"doing":"#ff0000"}}'))
  check('…Doing is red, the others as they were', (await settings()).board.colors.doing === '#ff0000' && (await settings()).board.colors.todo !== '#ff0000')
  const colours = panel.locator('.assistant-action', { hasText: 'Column colours' }).first()
  const colourChange = /Column colours: doing: #[0-9a-f]{6} → doing: #ff0000/
  const coloursText = await showsText('the colour change', colours, colourChange)
  check('…listed as the colour it changed, not the table\'s size', colourChange.test(coloursText), coloursText)
  await colours.getByRole('button', { name: /^Undo: / }).click()
  check('…and Undo puts the colours back', !!(await lib.until(async () => (await settings()).board.colors.doing !== '#ff0000', HUNG_MS)))

  // --- A fallback list: a label-only change is listed by that entry, old and new (#317).
  await inv('settings:setProviderFallback', 'claude-code', 'models', [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }])
  check('it renames a fallback model', await say('hive cw_update_setting {"id":"claude-code.modelFallback","value":[{"value":"opus","label":"Opus (big)"},{"value":"sonnet","label":"Sonnet"}]}'))
  const renamed = panel.locator('.assistant-action', { hasText: 'Models (fallback)' }).first()
  const relabel = /opus: Opus → opus: Opus \(big\)/
  const renamedText = await showsText('the renamed model', renamed, relabel)
  check('…listed as the label that changed', relabel.test(renamedText), renamedText)

  // --- A provider's prices: null puts back Hive's, a shipped model removed from the table too (#315); Undo removes it again.
  const removedNow = async () => JSON.stringify((await settings()).providers['claude-code'].pricesRemoved ?? [])
  await inv('settings:setProviderPrices', 'claude-code', {}, ['claude-opus-4-8'])
  check('it resets the API prices', await say('hive cw_update_setting {"id":"claude-code.prices","value":null}'))
  check("…and the removed model has Hive's price again", (await removedNow()) === '[]', await removedNow())
  const reset = panel.locator('.assistant-action', { hasText: 'API prices' }).first()
  const putBack = /claude-opus-4-8: removed → claude-opus-4-8: Hive's price/
  const resetText = await showsText('the prices reset', reset, putBack)
  check('…listed as the model put back', putBack.test(resetText), resetText)
  await reset.getByRole('button', { name: /^Undo: / }).click()
  check('…and Undo removes it again', !!(await lib.until(async () => (await removedNow()) === '["claude-opus-4-8"]', HUNG_MS)), await removedNow())

  // --- Refused: its own Control, and what Hive runs.
  check('it tries to raise its own Control', await say('hive cw_update_setting {"id":"assistant.control","value":"look"}'))
  check('…which stays as it was', (await settings()).assistant.control === 'projects')
  const controlRefused = panel.locator('.assistant-action.failed', { hasText: 'Change Settings → Assistant → Control' })
  check('…listed as not done', !!(await shows('the refused Control change', async () => (await controlRefused.count()) === 1)), `${await controlRefused.count()} rows`)
  check('it tries to change a CLI path', await say('hive cw_update_setting {"id":"claude-code.executablePath","value":"C:\\\\evil.exe"}'))
  check("…which stays as it was", (await settings()).providers['claude-code'].executablePath.endsWith('fake-claude.cmd'))

  // --- Turned off while it runs: refused at once.
  await inv('settings:update', { assistant: { changeSettings: false } })
  check('with Change settings off, it tries again', await say('hive cw_update_setting {"id":"sessions.transcriptWarnMB","value":60}'))
  check('…and nothing changes', (await settings()).sessions.transcriptWarnMB === 20)
  check('…listed as not done, saying why', !!(await shows('the refused change', async () => (await panel.locator('.assistant-action.failed', { hasText: 'Change Settings → Sessions → Warn when a transcript is over' }).count()) >= 1)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
