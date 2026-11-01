// Windows Sandbox's broker and a connection switch's held slot (HI-2304, SPEC §16.10.3): MB1 switched connection, its
// run left Windows Sandbox's WindowsSandboxServer.exe running, Hive held the slot for it, and MB1 never resumed.
// B1 is lent slot-a (`slots:test`, as a card's start does) and started there, on the fake Claude Code. A test copy takes
// a process whose command line names HIVE_TEST_SYSTEM_BROKER as the Sandbox's broker (no test can put one in
// WindowsApps), and the names in HIVE_TEST_SYSTEM_BROKER_ACTIVE as running on the machine.
// 1. B1 leaves the fake broker running (fake-claude's "hidden-linger") while a "Sandbox" runs, and its connection is
//    switched at its safe point: it exits, slot-a stays held (the broker counts while a Sandbox runs), and the switch's
//    resume waits, saying so in a notice once, starting nothing meanwhile.
// 2. The "Sandbox" closes: within a look at the leftovers B1's run counts as ended (the broker isn't its work), slot-a is
//    freed, and the switch resumes B1 there, in the same conversation. The broker still runs: Hive never ends it.
// 3. A real writer: B1 leaves a node running ("linger 1") and is switched again: slot-a stays held, named by that
//    process; once it ends (here from outside, by pid and start time), the switch resumes B1.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only: slot-a is lent through slots:test, and the broker is a test seam's, both of which a packaged build refuses.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotbroker-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const shots = at('shots')
const active = at('active.txt')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47819))
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const pids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(active, { force: true })
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, path.join(root, 'slot-a')])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const kept = []
  try {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_SYSTEM_BROKER: 'linger-unnamed', HIVE_TEST_SYSTEM_BROKER_ACTIVE: active }, viewport: { width: 1400, height: 950 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
    const inv = (...a) => h.inv(...a)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const slotA = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
    const toast = h.page.locator('.toast', { hasText: "B1's switch of connection waits for slot-a" })

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const key = lib.ptyKey(alpha, b1.id)
    const lent = await inv('slots:test', alpha, { op: 'lend', agent: b1.id, card: 12 })
    check('#12 is lent slot-a for B1', lent?.ok && lent.slot.name === 'slot-a', JSON.stringify(lent))
    await inv('session:start', alpha, { agentId: b1.id })
    const s1 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 runs in slot-a', s1?.slot === 'slot-a', JSON.stringify(s1))

    // --- 1. The fake broker left running while a "Sandbox" runs: held, and the switch waits.
    fs.writeFileSync(active, 'windowssandboxclient.exe\n')
    const brokerFile = path.join(home, 'fake-hidden-linger.jsonl')
    await lib.sendPrompt(inv, key, 'hidden-linger', { submitted: async () => (await live(b1.id))?.status === 'working' || pids(brokerFile).length > 0 })
    check('B1 leaves the fake broker running', !!(await until(async () => pids(brokerFile).length === 1 && (await idle(b1.id)), HUNG_MS)))
    const broker = lib.identify(pids(brokerFile))
    kept.push(...broker)
    const switched = await inv('session:switchConnection', alpha, b1.id)
    check("B1's switch is arranged for its safe point", switched === 'queued', String(switched))
    check('…B1 exits, and slot-a stays held while a "Sandbox" runs: its broker listed', !!(await until(async () => {
      if (await live(b1.id)) return false
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w?.run === s1.runId && w.processes?.list.some((p) => p.pid === broker[0]?.pid)
    }, HUNG_MS)), JSON.stringify(await inv('slots:heldWriter', alpha, 'slot-a')))
    check('…the switch waits, saying so once in a notice', !!(await until(async () => (await toast.count()) === 1, HUNG_MS)), await h.page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))
    check('…naming what holds it', /held by node, left running by B1's last run/.test(await toast.innerText()), await toast.innerText())
    await h.page.screenshot({ path: path.join(shots, 'slotbroker-waits.png') })
    check('…and starts nothing while it waits', !(await live(b1.id)))

    // --- 2. The "Sandbox" closes: the broker isn't B1's work, slot-a is freed, and B1 resumes in the same conversation.
    fs.rmSync(active, { force: true })
    const s2 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('the "Sandbox" closed: the switch resumes B1 in slot-a, in the same conversation', s2?.slot === 'slot-a' && s2.runId !== s1.runId && s2.sessionId === s1.sessionId, JSON.stringify(s2))
    check('…its run the writer now', (await inv('slots:heldWriter', alpha, 'slot-a'))?.run === s2?.runId)
    check('…the broker is left running, never ended', lib.identify(broker.map((b) => b.pid)).length === 1)
    check('…and no longer listed as B1\'s', !(await inv('session:leftovers')).some((l) => l.agentId === b1.id && l.processes.some((p) => p.pid === broker[0]?.pid)))
    check('…told once only', (await toast.count()) <= 1)
    lib.endExactly(kept.splice(0))
    if (await toast.count()) await toast.locator('button').last().click().catch(() => undefined)

    // --- 3. A real writer left running holds the slot, named; once it ends, the switch resumes B1.
    const lingerFile = path.join(home, 'fake-linger.jsonl')
    await lib.sendPrompt(inv, key, 'linger 1', { submitted: async () => (await live(b1.id))?.status === 'working' || pids(lingerFile).length > 0 })
    check('B1 leaves a node running', !!(await until(async () => pids(lingerFile).length === 1 && (await idle(b1.id)), HUNG_MS)))
    const writer = lib.identify(pids(lingerFile))
    kept.push(...writer)
    check('B1 switched again', (await inv('session:switchConnection', alpha, b1.id)) === 'queued')
    check('…slot-a stays held, the node listed (no "Sandbox" runs: it is no broker)', !!(await until(async () => {
      if (await live(b1.id)) return false
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w?.run === s2.runId && w.processes?.list.some((p) => p.pid === writer[0]?.pid)
    }, HUNG_MS)))
    check('…the switch waits, saying so', !!(await until(async () => (await toast.count()) === 1, HUNG_MS)))
    check('…starting nothing, slot-a still held', !(await live(b1.id)) && !!(await slotA())?.writer)
    lib.endExactly(kept.splice(0))
    const s3 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('the node ended: the switch resumes B1 in slot-a, in the same conversation', s3?.slot === 'slot-a' && s3.runId !== s2.runId && s3.sessionId === s1.sessionId, JSON.stringify(s3))
  } finally {
    await h?.app.close().catch(() => undefined)
    lib.endExactly(kept)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
