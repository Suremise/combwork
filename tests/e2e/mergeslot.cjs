// The merge slot (#350) on fake Claude Code agents (fake-claude/), through the real hive tool: two agents claiming at
// once merge one after the other and the second runs its checks once; the waiter's status says who it waits for, and
// the project's Overview and the Progress panel show the holder and the line; a holder whose session ends frees the
// slot; a hold that runs out passes on and is reported; the user releases a holder from the Overview; the Merge dialog
// waits while the slot is taken; another project's agent can't reach the slot. Dev build, throwaway profile, workspace
// and CLAUDE_CONFIG_DIR; holds last 20 s here (CW_TEST_MERGE_HOLD_MS).
// Dev build only (#1580): it starts this checkout's Electron itself, and Wes is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), with a branch for the Merge dialog.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'mergeslot-profile')
const ws = path.join(lib.WORK, 'mergeslot-ws')
const claudeHome = path.join(lib.WORK, 'mergeslot-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const PORT = Number(lib.port(47920))
const HOLD_MS = 20000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine.
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  lib.gitProject(beta)
  // The branch the slots are for, whatever git's default is here.
  for (const d of [alpha, beta]) lib.git(d, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase(), beta.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off', CW_TEST_MERGE_HOLD_MS: String(HOLD_MS) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body, token = apiToken) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const slotNow = async () => (await api('GET', '/v1/projects/alpha/merge-slot?branch=main')).body
  const live = async (dir, id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === dir.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 30000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(250)
    return v
  }
  const start = async (dir, id) => {
    await inv('session:start', dir, { agentId: id })
    return until(async () => (await live(dir, id))?.status === 'ready', HUNG_MS)
  }
  const idle = (dir, id) => until(async () => ['ready', 'finished'].includes((await live(dir, id))?.status), 60000)
  /**
   * Types a prompt into an agent (as the user does), Enter included, once it is idle: taken once a turn of its starts.
   * Typed again when a wake of Combwork's disturbed it (typeLine).
   */
  const say = async (dir, agent, text) => {
    await lib.typeLine(inv, lib.ptyKey(dir, agent.id), claudeHome, agent.name, text, { ready: async () => ['ready', 'finished'].includes((await live(dir, agent.id))?.status), live: () => live(dir, agent.id), hungMs: 60000 })
  }
  const slot = (args) => `cw cw_merge_slot ${JSON.stringify(args)}`
  const shellRuns = () => {
    const f = path.join(claudeHome, 'fake-shell.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const ann = await lib.addAgent(inv, alpha, { name: 'Ann' })
  const bob = await lib.addAgent(inv, alpha, { name: 'Bob' })
  const bea = await lib.addAgent(inv, beta, { name: 'Bea' })
  check('the agents start', !!(await start(alpha, ann.id)) && !!(await start(alpha, bob.id)) && !!(await start(beta, bea.id)))

  // --- Two agents claim at once: one merges, the other waits its turn and runs its checks once, after.
  const checksFile = path.join(alpha, 'checks.txt')
  await say(alpha, ann, `${slot({ action: 'claim', cards: [1] })} then work 8 then shell: echo Ann>>checks.txt then ${slot({ action: 'release' })}`)
  check('the first claim holds the slot', !!(await until(async () => (await slotNow())?.holder?.name === 'Ann', HUNG_MS)), JSON.stringify(await slotNow()))
  await say(alpha, bob, `${slot({ action: 'claim', cards: [2], timeoutSeconds: 25 })} then shell: echo Bob>>checks.txt then ${slot({ action: 'release' })}`)
  const waitingNote = 'Waiting for the merge slot (Ann is merging #1)'
  check("the second waits, and its status says for whom", !!(await until(async () => (await live(alpha, bob.id))?.mergeSlot === waitingNote, 10000)), JSON.stringify((await live(alpha, bob.id))?.mergeSlot))
  check('the holder\'s status says it is merging', (await live(alpha, ann.id))?.mergeSlot === 'Merging into main (merge slot)')
  const viaApi = (await api('GET', '/v1/projects/alpha')).body?.agents?.find((a) => a.name === 'Bob')
  check('the Agent API gives the waiter that status message', viaApi?.statusMessage === waitingNote, JSON.stringify(viaApi?.statusMessage))
  const line = await slotNow()
  check('the slot lists the holder and who waits', line?.holder?.name === 'Ann' && line.holder.cards.join() === '1' && line.waiting.map((w) => w.name).join() === 'Bob', JSON.stringify(line))
  // The project's Overview and the Progress panel show it.
  await page.locator('.tabs .tab', { hasText: 'Overview' }).first().click()
  const inOverview = await until(async () => {
    const t = await page.locator('.overview-page .merge-slot').allInnerTexts()
    return t.some((x) => /main: Ann is merging #1/.test(x) && /Waiting: Bob/.test(x))
  }, 10000)
  check('the Overview shows the holder and the line', !!inOverview, (await page.locator('.overview-page .merge-slot').allInnerTexts()).join(' | '))
  await page.screenshot({ path: path.join(lib.WORK, 'mergeslot-overview.png') })
  await page.locator('.progress-rail').click()
  const inPanel = await until(async () => {
    const t = await page.locator('.progress-panel .progress-merge-card').allInnerTexts()
    return t.length === 1 && /Ann is merging #1/.test(t[0]) && /alpha · into main/.test(t[0]) && /Waiting: Bob/.test(t[0])
  }, 5000)
  check('the Progress panel shows the merge on top, with who waits (#484)', !!inPanel, (await page.locator('.progress-panel .progress-merge-card').allInnerTexts()).join(' | '))
  await page.screenshot({ path: path.join(lib.WORK, 'mergeslot-progress.png') })
  await idle(alpha, ann.id)
  await idle(alpha, bob.id)
  const order = fs.existsSync(checksFile) ? fs.readFileSync(checksFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []
  check('one after the other, and the second ran its checks once', order.join() === 'Ann,Bob', JSON.stringify(order))
  check('both released it: free, nobody waiting', !!(await until(async () => { const s = await slotNow(); return !s?.holder && !s?.waiting.length }, 5000)), JSON.stringify(await slotNow()))
  check('their status notes are gone', !(await live(alpha, ann.id))?.mergeSlot && !(await live(alpha, bob.id))?.mergeSlot)
  check('the Overview and the Progress panel show no slot when free', !!(await until(async () => (await page.locator('.merge-slot, .progress-merge-card').count()) === 0, 5000)))

  // --- A holder whose session ends frees the slot: the one waiting gets it.
  await say(alpha, ann, slot({ action: 'claim', cards: [3] }))
  await until(async () => (await slotNow())?.holder?.name === 'Ann', HUNG_MS)
  await say(alpha, bob, `${slot({ action: 'claim', timeoutSeconds: 25 })} then work 1`)
  await until(async () => (await slotNow())?.waiting?.length === 1, 10000)
  await inv('session:stop', alpha, ann.id)
  check("the holder's session ended: the next in line has it", !!(await until(async () => (await slotNow())?.holder?.name === 'Bob', 15000)), JSON.stringify(await slotNow()))

  // --- A hold that runs out goes on, and the user is told (holds last HOLD_MS here).
  const expired = await until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => /Bob's merge slot expired/.test(t)), HOLD_MS + 15000)
  check('an expired hold is reported to the user', !!expired)
  check('…and freed', !(await slotNow())?.holder)
  await page.screenshot({ path: path.join(lib.WORK, 'mergeslot-expired.png') })

  // --- The user releases a holder from the Progress panel (after a question), only the hold the question named.
  await idle(alpha, bob.id)
  await say(alpha, bob, slot({ action: 'claim', cards: [4] }))
  await until(async () => (await slotNow())?.holder?.name === 'Bob', HUNG_MS)
  const askRelease = async () => {
    await page.locator('.progress-panel .progress-merge-card button', { hasText: 'Release' }).click()
    return until(async () => (await page.locator('.dialog', { hasText: 'Release the merge slot?' }).count()) === 1, 5000)
  }
  const asked = await askRelease()
  check('Release asks first, naming the holder', !!asked && (await page.locator('.dialog', { hasText: 'Bob holds the merge slot for alpha · main' }).count()) === 1)
  // While the question is open, the slot changes hands: Bob releases and claims again (a new hold).
  const shown = (await slotNow())?.holder?.id
  await idle(alpha, bob.id)
  const sent = Date.now()
  await say(alpha, bob, `${slot({ action: 'release' })} then ${slot({ action: 'claim', cards: [6] })}`)
  // Once that turn has ended (idle again, changed since it was asked), not after a fixed time: under load the claim
  // came after 10 s, and the answer below was then given with no newer hold (#669).
  const newHold = await until(async () => {
    const b = await live(alpha, bob.id)
    const h = (await slotNow())?.holder
    return ['ready', 'finished'].includes(b?.status) && Date.parse(b?.statusSince ?? '') > sent && h && h.id !== shown && h.name === 'Bob' ? h : null
  }, 60000)
  await page.locator('.dialog .btn', { hasText: 'Release' }).click()
  const refused = await until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => /changed hands meanwhile, so nothing was released/.test(t)), 5000)
  const after = (await slotNow())?.holder
  check("an answer to an older question doesn't release the newer hold: refused, said, and it keeps it", !!newHold && !!refused && after?.id === newHold.id && after?.cards.join() === '6', JSON.stringify({ shown, newHold, after, bob: (await live(alpha, bob.id))?.status }))
  await page.screenshot({ path: path.join(lib.WORK, 'mergeslot-release-refused.png') })
  check('asked again, Release frees the slot', !!(await askRelease()))
  await page.locator('.dialog .btn', { hasText: 'Release' }).click()
  check('…and frees the slot', !!(await until(async () => !(await slotNow())?.holder, 5000)))

  // --- The Merge dialog follows the slot: open while it is free, it waits once an agent claims it, until it is free again.
  const wes = await lib.addAgent(inv, alpha, { name: 'Wes', location: 'new-worktree' })
  fs.writeFileSync(path.join(wes.worktree.path, 'b.txt'), 'b' + String.fromCharCode(10))
  // Committed: only committed work is merged (#1347), so uncommitted files alone would keep Merge off.
  lib.git(wes.worktree.path, ['add', '-A'])
  lib.git(wes.worktree.path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b'])
  await idle(alpha, bob.id)
  await page.locator('.tabs .tab', { hasText: 'Session' }).first().click()
  await lib.agentMenu(page, 'Wes')
  await page.locator('.menu-item', { hasText: 'Merge…' }).click()
  const dialog = page.locator('.dialog', { hasText: "Merge Wes's work" })
  const merge = dialog.locator('.btn.primary', { hasText: 'Merge' })
  check('the Merge dialog opens with Merge enabled while the slot is free', !!(await until(async () => (await dialog.count()) === 1 && !(await merge.isDisabled()), 10000)))
  await say(alpha, bob, slot({ action: 'claim', cards: [5] }))
  const noted = await until(async () => (await dialog.locator('.merge-slot-note').count()) === 1, 10000)
  check('once an agent claims it, the dialog says who is merging, and Merge waits', !!noted && /Bob is merging #5 into main/.test(await dialog.locator('.merge-slot-note').innerText()) && (await merge.isDisabled()))
  await page.screenshot({ path: path.join(lib.WORK, 'mergeslot-dialog.png') })
  await idle(alpha, bob.id)
  await say(alpha, bob, slot({ action: 'release' }))
  check('once it is free again, Merge is enabled', !!(await until(async () => (await dialog.locator('.merge-slot-note').count()) === 0 && !(await merge.isDisabled()), 10000)))
  await merge.click()
  check('the merge goes through', !!(await until(async () => (await dialog.count()) === 0, 15000)) && fs.existsSync(path.join(alpha, 'b.txt')))

  // --- Who may reach it: another project's agent can't; a script can look but not claim.
  const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const beaToken = launches.filter((l) => l.cwd.toLowerCase() === beta.toLowerCase()).at(-1)?.token
  check("another project's agent can't read or claim it", (await api('GET', '/v1/projects/alpha/merge-slot?branch=main', undefined, beaToken)).status === 403 && (await api('POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', timeoutSeconds: 0 }, beaToken)).status === 403)
  check('its own project is fine', (await api('GET', '/v1/projects/beta/merge-slot?branch=main', undefined, beaToken)).status === 200)
  const scriptClaim = await api('POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', timeoutSeconds: 0 })
  check("a script reads it but can't claim it", (await api('GET', '/v1/projects/alpha/merge-slot')).status === 200 && scriptClaim.status === 403, JSON.stringify(scriptClaim))
  check('a bad branch or cards are refused', (await api('POST', '/v1/projects/beta/merge-slot/claim', { branch: 'a b' }, beaToken)).status === 400 && (await api('POST', '/v1/projects/beta/merge-slot/claim', { cards: ['x'] }, beaToken)).status === 400)
  check("nothing in the agents' shells failed", shellRuns().every((r) => r.code === 0), JSON.stringify(shellRuns().filter((r) => r.code !== 0)))

  await app.close().catch(() => undefined)
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
