// A wake typed into a CLI that is busy for a moment (#597), on fake Claude Code sessions (fake-claude/): an agent and
// the Assistant. While fake-slow-input is there the fake reads no input. Combwork's Ctrl+U, the line and its Enter once
// reached a busy Claude Code in one read, which it took as a paste with those keys in it as text and sent the line
// neither on Enter nor on Enter again (the fake acts that out). Now Combwork types into Claude Code only once a key of its
// own shows in the input box (HI-1979): it puts the wake off, types nothing of it, and types it once the fake reads
// again, as a bracketed paste, taken at its first Enter (the fake says which Enter sent it). A wake typed while the CLI
// reads its input as usual is taken too. Whether Combwork pressed Enter again isn't checked (#664):
// it does when the CLI reads its input later than Combwork's window to be taken (3 s here), as a starved CLI does under load,
// and that Enter falls on an empty prompt; what is checked is that Combwork's check of the wake ends and no mark stays.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'wakepaste-profile')
const ws = path.join(lib.WORK, 'wakepaste-ws')
const claudeHome = path.join(lib.WORK, 'wakepaste-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([ws.toLowerCase(), alpha.toLowerCase(), path.join(ws, '.combwork', 'assistant').toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // A short wait for a wake to be taken (10 s in Combwork): a wake that isn't taken shows soon.
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47833), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off', CW_TEST_WAKE_TAKE_MS: '3000' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const home = (await inv('workspace:refresh')).assistant.path

  const live = async (p, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === id)
  const wakes = () => {
    const f = path.join(claudeHome, 'fake-wakes.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  const hiveLog = () => {
    const f = path.join(userData, 'logs', 'hive.log')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  }
  /** Combwork's log lines about wakes typed into agent `id`. */
  const wakeLines = (id) => hiveLog().split('\n').filter((l) => l.includes(id) && /\[watches\] (Woke|The wake typed into)/.test(l))
  /** How many of those wakes Combwork's check has ended for: taken in time, or marked (a mark the CLI's late take clears). */
  const settled = (id) => wakeLines(id).filter((l) => /was taken after \d+ ms|still wasn't taken|wasn't taken, and Enter couldn't/.test(l)).length
  /** Combwork's check of the agent's nth wake has ended, and no mark stays: it counts the line taken. */
  const hiveSawTaken = async (p, id, n) => !!(await lib.until(async () => settled(id) >= n && !(await live(p, id))?.untakenLine, HUNG_MS))
  const say = async (p, id, text) => {
    // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
    await lib.typeLine(inv, lib.ptyKey(p, id), claudeHome, null, text, { live: () => live(p, id) })
  }
  const idle = async (p, id) => ['ready', 'finished'].includes((await live(p, id))?.status)

  await page.getByText('alpha', { exact: true }).first().click()
  const agent = await lib.addAgent(inv, alpha, { name: 'Watcher' })
  const card = (await inv('tasks:create', { title: 'Watched', project: 'alpha' })).number
  // Wakes name the card by its key (#1219), not its number.
  const named = `${(await inv('tasks:list')).find((c) => c.number === card).key}`
  await inv('session:start', alpha, { agentId: agent.id })
  check('the agent starts', !!(await lib.until(() => idle(alpha, agent.id), 30000)))
  await inv('session:start', home, { agentId: 'assistant' })
  check('the Assistant starts', !!(await lib.until(() => idle(home, 'assistant'), 30000)))

  for (const [who, p, id] of [
    ['an agent', alpha, agent.id],
    ['the Assistant', home, 'assistant']
  ]) {
    const watch = async () => {
      await say(p, id, `cw cw_wait_for_tasks {"cards":[${card}],"changes":["comment"],"wake":true}`)
      return lib.until(async () => (await live(p, id))?.status === 'watching', HUNG_MS)
    }
    const mine = () => wakes().filter((w) => w.text.includes(named) && w.agent === name)
    let name = null

    // Read as usual: taken at its first Enter.
    check(`${who} watches the card`, !!(await watch()))
    const before = wakes().length
    await inv('tasks:comment', card, `Read as usual, for ${who}`)
    const first = await lib.until(() => wakes().length > before && wakes().at(-1), HUNG_MS)
    name = first?.agent
    check(`${who}: a wake typed while the CLI reads as usual is taken`, !!first && first.text.includes(`Read as usual, for ${who}`), JSON.stringify(first))
    check(`${who}: …at its first Enter`, first?.enter === 1, JSON.stringify(first))
    check(`${who}: …and Combwork counts it taken`, await hiveSawTaken(p, id, 1), wakeLines(id).join(' | '))
    await lib.until(() => idle(p, id), HUNG_MS)

    // Busy for a moment: Combwork types nothing of the wake until a key of its own shows in the input box (HI-1979), so it
    // puts the wake off, and types it once the CLI reads again: what reaches it in one read is only the keys clearing it.
    check(`${who} watches again`, !!(await watch()))
    const knob = path.join(claudeHome, `fake-slow-input-${String(name).replace(/[^\w-]/g, '_')}.txt`)
    fs.writeFileSync(knob, '')
    check(`${who}: its CLI stops reading its input`, !!(await lib.until(() => fs.existsSync(knob.replace(/\.txt$/, '.paused')), HUNG_MS)))
    const putOff = () => hiveLog().split('\n').filter((l) => l.includes("its input wasn't seen empty")).length
    const typed = wakeLines(id).filter((l) => / Woke /.test(l)).length
    const offBefore = putOff()
    const taken = mine().length
    await inv('tasks:comment', card, `Read in one go, for ${who}`)
    check(`${who}: Combwork puts the wake off meanwhile`, !!(await lib.until(() => putOff() > offBefore, HUNG_MS)), hiveLog().split('\n').slice(-5).join(' | '))
    check(`${who}: …typing none of it`, wakeLines(id).filter((l) => / Woke /.test(l)).length === typed, wakeLines(id).join(' | '))
    fs.rmSync(knob, { force: true })
    // Combwork has typed it and pressed Enter (its log says Woke once the Enter is in).
    check(`${who}: once it reads again, Combwork types the wake`, !!(await lib.until(() => wakeLines(id).filter((l) => / Woke /.test(l)).length > typed, HUNG_MS)), wakeLines(id).join(' | '))
    const got = await lib.until(() => mine().length > taken && mine().at(-1), HUNG_MS)
    check(`${who}: the wake its CLI read in one go is taken`, !!got && got.text.includes(`Read in one go, for ${who}`), JSON.stringify(mine()))
    check(`${who}: …at its first Enter, not lost in a paste`, got?.enter === 1, JSON.stringify(got))
    check(`${who}: …and Combwork counts it taken: nothing marked as not taken`, await hiveSawTaken(p, id, 2), wakeLines(id).join(' | '))
    await lib.until(() => idle(p, id), HUNG_MS)
  }

  await app.close()
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
