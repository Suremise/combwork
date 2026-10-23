// Release Slot… on a held writer (#1506, SPEC §16.10.3 One writer): a slot whose writer's Hive has gone is the user's
// to release. B1 is lent slot-a (`slots:test`, as a card's start does) and started there, on the fake Claude Code:
// 1. While B1 runs there, Release is refused ("still running in this Hive"), and the slot isn't listed as held.
// 2. That Hive is ended from outside (its own process tree, by pid and start time, never by name), as a crash would:
//    the next Hive, on the same profile, lists slot-a's writer as held, and B1's ⋯ offers Release Slot….
// 3. The Version Control tab's slot list shows slot-a held by B1's ended session with Release…; its question names
//    the Hive that is gone and says Hive doesn't know what still runs; Release frees the slot, and B1 starts there again.
// Screenshots of the question, light and dark. Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { processes, descendantsIn, endExactly, childrenFirst } = require('./folderProcesses.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `slotrelease-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
// slotsessions' default too: run on its own (no runner's lane), never beside it.
const PORT = Number(lib.port(47817))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Ends a test Hive from outside, as a crash would: its main process and all it started, each by pid and start time. */
async function endFromOutside(app) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = lib.identify([proc.pid])[0]
  const list = processes()
  const top = id && list.find((p) => p.pid === id.pid && Math.abs(p.started - id.started) <= 1)
  const tree = top ? [{ pid: top.pid, started: top.started }, ...descendantsIn(list, top.pid)] : []
  const ended = tree.length ? endExactly(childrenFirst(list, tree)) : 0
  return ended > 0 && !!(await lib.until(() => gone, HUNG_MS))
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, path.join(root, 'slot-a')])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT) }, viewport: { width: 1400, height: 950 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  const inv = (...a) => h.inv(...a)
  const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 250)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
  const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
  const slotA = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
  const agentInfo = async (id) => (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha))?.agents.find((a) => a.id === id)
  const dialog = () => h.page.locator('.dialog', { hasText: 'Release B1' })

  try {
    await start()
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })

    // --- 1. B1 runs in slot-a: its writer is live, and Release is refused.
    const lent = await inv('slots:test', alpha, { op: 'lend', agent: b1.id, card: 12 })
    check('#12 is lent slot-a for B1', lent?.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    await inv('session:start', alpha, { agentId: b1.id })
    const s1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null))
    check('B1 runs in slot-a', s1?.slot === 'slot-a', JSON.stringify(s1))
    const w1 = await inv('slots:heldWriter', alpha, 'slot-a')
    check('…its run is slot-a\'s writer, live in this Hive', w1?.agent === b1.id && w1.live === true && w1.hive.self === true, JSON.stringify(w1))
    check('…not listed as held', (await slotA())?.writer?.held === false && !(await agentInfo(b1.id))?.heldSlot)
    const refused = await inv('slots:releaseWriter', alpha, 'slot-a', w1.run, false).then(() => 'released', (e) => String(e?.message ?? e))
    check('Release is refused while its run is live', /still running in this Hive/.test(refused), refused)
    check('…and slot-a keeps its writer', (await slotA())?.writer?.agent === b1.id)

    // --- 2. That Hive ends as a crash would: the next one lists slot-a's writer as held.
    check('the first Hive is ended from outside', await endFromOutside(h.app))
    await start()
    const w2 = await until(async () => {
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w && w.hive.alive === false ? w : null
    })
    check("the next Hive sees slot-a's writer held by a Hive that has gone", w2?.run === w1.run && !w2.hive.self && w2.hive.pid === w1.hive.pid && !w2.live, JSON.stringify(w2))
    check('…listed as held', !!(await until(async () => (await slotA())?.writer?.held === true)))
    check("…and B1's ⋯ offers Release Slot…", !!(await until(async () => (await agentInfo(b1.id))?.heldSlot === 'slot-a')) && (await lib.agentMenu(h.page, 'B1')).some((t) => t.startsWith('Release Slot…')))
    await h.page.keyboard.press('Escape')
    const startRefused = await inv('session:start', alpha, { agentId: b1.id }).then(() => 'started', (e) => String(e?.message ?? e))
    check('B1 can\'t start in slot-a meanwhile', /still has another session in it/.test(startRefused), startRefused)

    // --- 3. The Version Control tab's slot list: held, with Release…; the question; released.
    await h.page.getByText('alpha', { exact: true }).first().click()
    await h.page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
    await h.page.locator('.git-sections [data-section="workflow"]').click()
    const section = h.page.locator('.workflow-form')
    await section.waitFor({ timeout: HUNG_MS })
    await section.locator('.workflow-option[data-option="folder"] select').selectOption('slots')
    const row = section.locator('.workflow-slots-table tr[data-slot="slot-a"]')
    check('the slot list shows slot-a held by B1\'s ended session', !!(await until(async () => (await row.locator(`[data-held="${b1.id}"]`).count()) === 1)) && /Held by B1/.test(await row.innerText()), await row.innerText().catch(() => ''))
    await row.locator('[data-action="release-held"]').click()
    await dialog().waitFor({ timeout: HUNG_MS })
    const said = await dialog().innerText()
    check('its question names the Hive that has gone, and says Hive doesn\'t know what still runs', said.includes("Release B1's slot slot-a?") && said.includes(`process ${w1.hive.pid}`) && /doesn.t know which of the processes/.test(said), said)
    for (const theme of ['light', 'dark']) {
      await h.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await h.page.screenshot({ path: path.join(shots, `slotrelease-question-${theme}.png`) })
    }
    await dialog().getByRole('button', { name: 'Release', exact: true }).click()
    await dialog().waitFor({ state: 'detached', timeout: HUNG_MS })
    check('Release frees slot-a: no writer, still lent to #12', !!(await until(async () => {
      const s = await slotA()
      return s && !s.writer && s.lease?.card === 12
    })), JSON.stringify(await slotA()))
    check("…the list and B1's ⋯ no longer offer it", !!(await until(async () => (await row.locator('[data-action="release-held"]').count()) === 0 && !(await agentInfo(b1.id))?.heldSlot)))
    await inv('session:start', alpha, { agentId: b1.id })
    const s3 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null))
    check('B1 starts in slot-a again', s3?.slot === 'slot-a' && (await inv('slots:heldWriter', alpha, 'slot-a'))?.run === s3.runId, JSON.stringify(s3))
  } finally {
    await h?.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
