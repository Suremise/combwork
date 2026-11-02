// Windows Sandbox's broker and a connection switch's held slot (HI-2304, SPEC §16.10.3): MB1 switched connection, its
// run left Windows Sandbox's WindowsSandboxServer.exe running, Hive held the slot for it, and MB1 never resumed.
// B1 is lent slot-a (`slots:test`, as a card's start does) and started there, on the fake Claude Code. A test copy takes
// the processes whose ids are in the file HIVE_TEST_SYSTEM_BROKER as the Sandbox's broker (no test can put one in
// WindowsApps; their paths are still asked of the helper by id and start time), and the names in the file
// HIVE_TEST_SYSTEM_BROKER_ACTIVE as running on the machine.
// 1. B1 leaves the fake broker running (fake-claude's "hidden-linger") while a "Sandbox" runs, and its connection is
//    switched at its safe point: it exits, slot-a stays held (the broker counts while a Sandbox runs), and the switch's
//    resume waits, saying so in a notice once, starting nothing meanwhile.
// 2. The "Sandbox" closes: within a look at the leftovers B1's run counts as ended (the broker isn't its work), slot-a is
//    freed, and the switch resumes B1 there, in the same conversation. The broker still runs: Hive never ends it.
// 3. A real writer: B1 leaves a node running ("linger 1") and is switched again: slot-a stays held, named by that
//    process; once it ends (here from outside, by pid and start time), the switch resumes B1.
// 4. (HI-2309) A quit with only the broker left: B1 leaves it while a "Sandbox" runs and is stopped (slot-a held, the
//    broker listed); the "Sandbox" closes and Hive quits at once. The next Hive, on the same profile, finds slot-a free
//    (its run kept as ended: the quit's look, or the leftovers' if it came first, both by the one rule), the broker not
//    listed as B1's, and still running.
// 5. (HI-2313) Hive is ended from outside while B1 runs, its broker left running, as a crash would, and its keeper
//    outlives it (HI-2314), writing its own "live" receipt listing only the broker. The next Hive asks that keeper for
//    B1's run now (its "live" is no proof), is told only the broker, and frees slot-a by itself, with no notice. The
//    broker and its keeper still run.
// 6. (HI-2309) The same, but its keeper is ended from outside after its receipt, so nothing can answer now: the next
//    Hive keeps slot-a held, says once in a notice that only the idle broker holds it and releasing is safe; its Release
//    Slot… (from the notice's button) says so with "End these processes first" off. Screenshots of the notice and the
//    question, light and dark. Released, the broker still runs.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only: slot-a is lent through slots:test, and the broker is a test seam's, both of which a packaged build refuses.
const lib = require('./lib.cjs')
const { processes, descendantsIn, endAsCrash } = require('./folderProcesses.cjs')
const { DatabaseSync } = require('node:sqlite')
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
const brokers = at('brokers.txt')
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
/**
 * Ends a test Hive from outside, as a crash would (slotrelease's way): its main process first, then all it started but
 * `spare`. True once its main process has exited and none of those it ended still runs as the same process (HI-2316).
 */
async function endFromOutside(app, spare = []) {
  const proc = app.process()
  const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
  const id = lib.identify([proc.pid])[0]
  const list = processes()
  const top = id && list.find((p) => p.pid === id.pid && Math.abs(p.started - id.started) <= 1)
  const rest = top ? descendantsIn(list, top.pid).filter((p) => !spare.includes(p.pid)) : []
  const ended = top ? endAsCrash(list, { pid: top.pid, started: top.started }, rest) : 0
  return ended > 0 && !!(await lib.until(() => gone, HUNG_MS)) && !!(await lib.until(() => lib.stillSame([{ pid: top.pid, started: top.started }, ...rest]).length === 0, HUNG_MS, 250))
}
/**
 * A row of a gone Hive's hive.db, read once a read succeeds (HI-2316). Windows reports the ended Hive's exit a moment
 * before its view of hive.db-shm is unmapped: a first connection then can't truncate that file and is refused ("disk
 * I/O error", SQLITE_IOERR_TRUNCATE, 1546), with the keeper still running and holding nothing. So each refusal is
 * noted, with how long after `since`, and the read is tried again until one succeeds. Returns { row, refused }: row
 * null if none succeeded within the bound.
 */
async function readGoneHiveDb(file, sql, since) {
  const refused = []
  const row = await lib.until(() => {
    let db
    try {
      db = new DatabaseSync(file)
      return db.prepare(sql).get() ?? { none: true }
    } catch (e) {
      refused.push(`${Date.now() - since} ms: ${e.code ?? ''} ${e.errcode ?? ''} ${e.errstr ?? ''} ${e.message}`.trim())
      return null
    } finally {
      try {
        db?.close()
      } catch {
        // a connection that failed to open has nothing to close
      }
    }
  }, HUNG_MS, 250)
  return { row: row ?? null, refused }
}
const pids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, shots]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(active, { force: true })
  fs.writeFileSync(brokers, '')
  fs.mkdirSync(shots, { recursive: true })
  lib.gitProject(alpha)
  const env = lib.fakeClaude(userData, home, [alpha, ws, path.join(root, 'slot-a')])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  const kept = []
  const start = async () => {
    h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_SYSTEM_BROKER: brokers, HIVE_TEST_SYSTEM_BROKER_ACTIVE: active }, viewport: { width: 1400, height: 950 } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
  }
  /** The fake broker B1 leaves ("hidden-linger"), by id and start time, taken as the Sandbox's from now on. */
  const brokerFile = path.join(home, 'fake-hidden-linger.jsonl')
  const asBroker = (pid) => fs.appendFileSync(brokers, `${pid}\n`)
  try {
    await start()
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
    await lib.sendPrompt(inv, key, 'hidden-linger', { submitted: async () => (await live(b1.id))?.status === 'working' || pids(brokerFile).length > 0 })
    check('B1 leaves the fake broker running', !!(await until(async () => pids(brokerFile).length === 1 && (await idle(b1.id)), HUNG_MS)))
    const broker = lib.identify(pids(brokerFile))
    kept.push(...broker)
    asBroker(broker[0]?.pid)
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

    // --- 4. (HI-2309) A quit with only the idle broker left: the next Hive finds slot-a free, the broker still running.
    fs.writeFileSync(active, 'windowssandboxclient.exe\n')
    const before = pids(brokerFile)
    await lib.sendPrompt(inv, key, 'hidden-linger', { submitted: async () => (await live(b1.id))?.status === 'working' || pids(brokerFile).length > before.length })
    const pid4 = await until(async () => ((await idle(b1.id)) ? pids(brokerFile).find((p) => !before.includes(p)) : null), HUNG_MS)
    const broker4 = lib.identify(pid4 ? [pid4] : [])
    kept.push(...broker4)
    asBroker(pid4)
    await inv('session:stop', alpha, b1.id)
    check('B1 leaves the broker again while a "Sandbox" runs and is stopped: slot-a held, the broker listed', !!pid4 && !!(await until(async () => {
      if (await live(b1.id)) return false
      const w = await inv('slots:heldWriter', alpha, 'slot-a')
      return w?.run === s3.runId && w.processes?.list.some((p) => p.pid === pid4)
    }, HUNG_MS)))
    fs.rmSync(active, { force: true })
    await h.app.close()
    h = null
    await start()
    check('the next Hive finds slot-a free: no writer, still lent to #12', !!(await until(async () => {
      const s = await slotA()
      return s && !s.writer && s.lease?.card === 12
    }, HUNG_MS)), JSON.stringify(await slotA()))
    check("…the broker isn't listed as B1's", !(await inv('session:leftovers')).some((l) => l.agentId === b1.id && l.processes.some((p) => p.pid === pid4)))
    check('…and still runs: nothing ended it', lib.identify([pid4]).length === 1)
    await inv('session:start', alpha, { agentId: b1.id })
    const s4 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 starts in slot-a', s4?.slot === 'slot-a', JSON.stringify(s4))

    /**
     * B1, running in slot-a as `run`, leaves the broker again; Hive is then ended from outside, as a crash would, the
     * broker and its keeper (the helper the profile bound the run to, outside the job Node ends Hive's children with,
     * HI-2314) spared. Returns them once the keeper's own receipt is "live" with only the broker, as that helper for the
     * gone Hive (the CLI and the rest ended with Hive).
     */
    const crashLeavingBroker = async (run, part) => {
      const had = pids(brokerFile)
      await lib.sendPrompt(inv, key, 'hidden-linger', { submitted: async () => (await live(b1.id))?.status === 'working' || pids(brokerFile).length > had.length })
      const pid = await until(async () => ((await idle(b1.id)) ? pids(brokerFile).find((p) => !had.includes(p)) : null), HUNG_MS)
      kept.push(...lib.identify(pid ? [pid] : []))
      asBroker(pid)
      check(`${part}: B1 leaves the broker again, still running in slot-a`, !!pid && !!(await live(b1.id)))
      // Its launch's processes as Hive's running marker lists them (id and start time, as the keeper names its members).
      const marked = () => {
        try {
          return JSON.parse(fs.readFileSync(path.join(userData, 'running.json'), 'utf8')).processes?.find((l) => l.runId === run)?.processes.find((p) => p.pid === pid) ?? null
        } catch {
          return null
        }
      }
      const member = await until(marked, HUNG_MS)
      check(`${part}: …the running marker lists it, with its start time`, !!member?.created, JSON.stringify(member))
      const helper = JSON.parse(fs.readFileSync(path.join(userData, 'leftovers.json'), 'utf8')).helpers?.[run]
      const helperPid = typeof helper === 'string' ? Number(helper.split(':')[0]) : 0
      const keeper = lib.identify(helperPid ? [helperPid] : [])
      check(`${part}: …its run bound to a running helper`, keeper.length === 1, JSON.stringify(helper))
      kept.push(...keeper)
      check(`${part}: …and Hive is ended from outside, the broker and its keeper left running`, await endFromOutside(h.app, [pid, helperPid]))
      h = null
      const read = await readGoneHiveDb(path.join(ws, '.hive', 'hive.db'), "SELECT writer_run AS run, writer_pid AS pid, writer_started AS started FROM slots WHERE name = 'slot-a'", Date.now())
      if (read.refused.length) console.log(`INFO ${part}: hive.db refused ${read.refused.length} read(s) before one succeeded, the keeper ${lib.stillSame(keeper).length ? 'running' : 'gone'}: ${read.refused.slice(0, 5).join(' | ')}`)
      const row = read.row
      check(`${part}: …slot-a still names its run as writer`, row?.run === run, JSON.stringify(row))
      const receiptFile = path.join(userData, 'keeper', `keeper-${run}.json`)
      const receipt = () => {
        try {
          return JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
        } catch {
          return null
        }
      }
      const r = await until(() => {
        const now = receipt()
        return now?.state === 'live' && now.total === 1 && now.members?.[0]?.pid === pid ? now : null
      }, HUNG_MS)
      check(`${part}: its keeper outlives it and writes "live", only the broker, as that helper for the gone Hive`, !!r && r.helper === helper && r.hive === `${row?.pid}:${row?.started}` && r.members[0].created === member?.created && lib.identify([helperPid]).length === 1, JSON.stringify(receipt()))
      return { pid, keeper }
    }

    // --- 5. (HI-2313) Hive closes unexpectedly while B1 runs, its broker left: the next Hive asks its keeper for the run
    // now, is told only the broker, and frees slot-a by itself. No notice; the broker and its keeper still run.
    const crash5 = await crashLeavingBroker(s4.runId, '5')
    await start()
    check('5: the next Hive asks its keeper, told only the idle broker, and frees slot-a by itself', !!(await until(async () => !(await slotA())?.writer, HUNG_MS)), JSON.stringify(await slotA()))
    check('5: …with no notice that it is held', (await h.page.locator('.toast', { hasText: 'slot-a is held by' }).count()) === 0)
    check('5: …the broker and its keeper still running: nothing ended', lib.identify([crash5.pid]).length === 1 && lib.stillSame(crash5.keeper).length === 1)

    // --- 6. (HI-2309) The same, but its keeper ended from outside after its receipt: nothing can answer now, so the next
    // Hive keeps slot-a held, tells the user once that releasing it is safe, and its Release Slot… says so, "End these
    // processes first" off. Released, the broker still runs.
    await inv('session:start', alpha, { agentId: b1.id })
    const s6 = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('6: B1 starts in slot-a', s6?.slot === 'slot-a', JSON.stringify(s6))
    const crash6 = await crashLeavingBroker(s6.runId, '6')
    const pid5 = crash6.pid
    check('6: …its keeper ended from outside (by its identity), its receipt left', lib.endExactly(crash6.keeper) === 1 && !!(await until(() => lib.stillSame(crash6.keeper).length === 0, HUNG_MS)))
    await start()
    const notice = h.page.locator('.toast', { hasText: 'slot-a is held by node' })
    check('the next Hive keeps slot-a held, and says once that only the idle broker holds it and releasing is safe', !!(await until(async () => (await notice.count()) === 1, HUNG_MS)) && /Windows' idle Sandbox broker.*releasing the slot is safe/.test(await notice.innerText()) && !!(await slotA())?.writer, await h.page.locator('.toast').allInnerTexts().then((t) => t.join(' | ')))
    await h.page.screenshot({ path: path.join(shots, 'slotbroker-notice.png') })
    // Exactly its button: the entry's text, which names Release Slot…, is the button that shows the project (HI-2320, HI-2371).
    await notice.getByRole('button', { name: 'Release Slot…', exact: true }).click()
    const dialog = h.page.locator('.dialog', { hasText: "Release B1's slot slot-a?" })
    await dialog.waitFor({ timeout: HUNG_MS })
    const said = await dialog.innerText()
    check("its Release Slot… says the broker is Windows' idle one and releasing is safe", /held by node, Windows' idle Sandbox broker/.test(said) && /No Sandbox is running, so releasing it is safe/.test(said) && /the broker is left running/.test(said), said)
    check('…"End these processes first" off', (await dialog.locator('input[type="checkbox"]').count()) === 1 && !(await dialog.locator('input[type="checkbox"]').isChecked()))
    for (const theme of ['light', 'dark']) {
      await h.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await h.page.screenshot({ path: path.join(shots, `slotbroker-release-${theme}.png`) })
    }
    await dialog.getByRole('button', { name: 'Release', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: HUNG_MS })
    check('released: slot-a free, the broker still running', !!(await until(async () => !(await slotA())?.writer, HUNG_MS)) && lib.identify([pid5]).length === 1)
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
