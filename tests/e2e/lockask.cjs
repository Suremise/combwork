// "Ask me" file locks for Codex (HI-2386), on two fake Codex agents (fake-codex/: its "patch FILE" step, an apply_patch
// edit Combwork's lock may refuse). Holder edits x.txt and holds it (its turn held open); Asker's edit of it is refused and
// Combwork asks with a notice's Allow. Asker ends its turn at once to wait, as Codex does; the ask outlives that turn's end:
// its notice still offers Allow, and Allow then types the go-ahead, after which Asker's retry edits the file. Before
// HI-2386 the turn's end withdrew the ask, and Allow did nothing (codex-extra's real run on 2 Nov). Dev build,
// throwaway profile, workspace and CODEX_HOME; nothing signs in or spends tokens.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'lockask-profile')
const ws = path.join(lib.WORK, 'lockask-ws')
const claudeHome = path.join(lib.WORK, 'lockask-claude-home')
const codexHome = path.join(lib.WORK, 'lockask-codex-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47713))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha, { 'x.txt': 'x\n' })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // What Asker does once it has read the go-ahead (its inbox, after Combwork's doorbell): the edit again, as Codex does.
  fs.writeFileSync(path.join(codexHome, 'fake-wakes-Asker.txt'), 'patch x.txt\n')

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1300, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    await page.getByText('alpha', { exact: true }).first().click()
    await lib.setOwnOptions(inv, alpha, { fileLocks: 'ask' })
    await inv('workspace:refresh')
    const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
    const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
    const idle = (id) => async () => ['ready', 'finished'].includes((await live(id))?.status)
    const edits = (agent) => lines(path.join(codexHome, 'fake-edits.jsonl')).filter((e) => e.agent === agent)
    const turnOver = (id, since) => async () => {
      const l = await live(id)
      return l && l.statusSince !== since && ['ready', 'finished'].includes(l.status) ? l : null
    }
    const say = async (id, text) => {
      const since = (await live(id))?.statusSince
      await lib.sendPrompt(inv, lib.ptyKey(alpha, id), text, { submitted: async () => (await live(id))?.statusSince !== since })
      return since
    }

    const holder = await lib.addAgent(inv, alpha, { name: 'Holder', provider: 'codex', permissionMode: 'full-access' })
    const asker = await lib.addAgent(inv, alpha, { name: 'Asker', provider: 'codex', permissionMode: 'full-access' })
    for (const a of [holder, asker]) await inv('session:start', alpha, { agentId: a.id })
    for (const a of [holder, asker]) check(`${a.name} starts`, !!(await until(idle(a.id))))

    // --- Holder edits x.txt and holds it: its turn waits ("hold") until the test lets it go.
    await say(holder.id, 'patch x.txt then hold')
    check('Holder edits x.txt and holds it', !!(await until(async () => edits('Holder').some((e) => e.allowed) && ((await live(holder.id))?.lockedFiles ?? []).some((f) => /x\.txt$/i.test(f)))), JSON.stringify({ edits: edits('Holder'), live: (await live(holder.id))?.lockedFiles }))

    // --- Asker's edit is refused, Combwork asks, and Asker ends its turn to wait (as Codex does, within seconds).
    const since = await say(asker.id, 'patch x.txt')
    check("Asker's edit is held back: it is told Combwork has asked the user", !!(await until(() => edits('Asker').some((e) => !e.allowed && /Combwork has asked the user/.test(e.reason ?? '')), HUNG_MS)), JSON.stringify(edits('Asker')))
    check("…and Asker's blocked turn ends", !!(await until(turnOver(asker.id, since))), JSON.stringify(await live(asker.id)))
    const asking = page.locator('.toast', { hasText: 'wants to edit x.txt' })
    // Exactly Allow: the entry's own text is a button too (it opens the agent), and says "Allow Asker to edit it too?".
    const allow = asking.getByRole('button', { name: 'Allow', exact: true })
    check('after that turn ended, the notice still offers Allow (the ask stays open)', !!(await until(async () => (await allow.count()) > 0)), JSON.stringify(await page.locator('.toast').allInnerTexts()))
    check("x.txt has no edit of Asker's yet", !/edited by Asker/.test(fs.readFileSync(path.join(alpha, 'x.txt'), 'utf8')))

    // --- Allow, after the blocked turn's end: the go-ahead is typed, Asker reads it and edits the file.
    await allow.first().click()
    const hiveLog = () => (fs.existsSync(path.join(userData, 'logs', 'hive.log')) ? fs.readFileSync(path.join(userData, 'logs', 'hive.log'), 'utf8') : '')
    check('Allow is answered: Asker is allowed to edit x.txt', !!(await until(() => /Lock: .*Asker.* allowed to edit .*x\.txt/.test(hiveLog()))), JSON.stringify({ log: hiveLog().match(/.*Lock: .*/g), toasts: await page.locator('.toast').allInnerTexts() }))
    const wakes = () => lines(path.join(codexHome, 'fake-wakes.jsonl')).filter((w) => w.agent === 'Asker')
    check('the go-ahead is typed into Asker, which reads it in its inbox', !!(await until(() => wakes().some((w) => /allowed you to edit x\.txt/.test(w.text)))), JSON.stringify(wakes()))
    check("…and Asker's retry edits x.txt", !!(await until(() => edits('Asker').some((e) => e.allowed))) && /edited by Asker/.test(fs.readFileSync(path.join(alpha, 'x.txt'), 'utf8')), JSON.stringify(edits('Asker')))

    // Holder's turn let go.
    await inv('pty:write', lib.ptyKey(alpha, holder.id), 'g')
    check("Holder's turn ends", !!(await until(idle(holder.id))))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
