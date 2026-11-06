// "The main process was busy" (#1109): a gap spanning the PC's sleep (a suspend and resume told by powerMonitor, faked
// here around a block of the main process) logs an info line, not a warning; an IPC call that holds the main process
// (CW_TEST_BLOCK_IPC) is named in the warning. Main's thread pool has 16 threads, not Node's 4 (HI-1702): with eight held
// a file call still ends, and with all of them held the slow file call is noted in combwork.log, timed off main's thread (main
// held with the pool free gives no such line). The blocked call's stall is kept for the Performance view, which lists
// it with its cause in a throwaway workspace (HI-1135). Dev build, throwaway profile.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'stalls-profile')
const logFile = path.join(userData, 'logs', 'combwork.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [])
const busyLines = () => lines().filter((l) => l.includes('[main] The main process was'))

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  // A warning a second at most, so one from Combwork's own start doesn't hide the suite's.
  const { app, page, inv } = await lib.launch({ userData, env: { CW_TEST_STALL_QUIET_MS: '1000' } })
  try {
    // The PC sleeps: suspend, the main process held, resume.
    const before = busyLines().length
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
      for (const until = Date.now() + 1500; Date.now() < until; );
      powerMonitor.emit('resume')
    })
    // This sleep's own line, its 1.5 s: an earlier stall (Combwork's start, under load) still being decided when the suspend
    // is told is taken for the sleep's too, and its line can come first (HI-2317).
    const sleepLine = (l) => Number(/\[INFO\] \[main\] The main process was paused for (\d+) ms while the PC slept: not counted as busy/.exec(l)?.[1] ?? 0) >= 1450
    const slept = await lib.until(() => busyLines().slice(before).find(sleepLine), HUNG_MS)
    check('a gap spanning sleep is an info line', !!slept, busyLines().slice(before).join(' | '))
    check('and not a warning', !busyLines().slice(before).some((l) => l.includes('[WARN]')), busyLines().slice(before).join(' | '))

    // An IPC call holds the main process: the warning names it.
    const mark = busyLines().length
    await app.evaluate(() => {
      process.env.CW_TEST_BLOCK_IPC = 'app:info=1500*1'
    })
    await inv('app:info')
    const warned = await lib.until(() => busyLines().slice(mark).find((l) => /\[WARN\] \[main\] The main process was busy for \d+ ms/.test(l) && l.includes('ipc app:info')), HUNG_MS)
    check('a blocking IPC call is named in the warning', !!warned, busyLines().slice(mark).join(' | '))
    check('with its time and the CPU used', /ipc app:info \(\d+\.\d s\)/.test(warned ?? '') && /\(main thread CPU \d+ ms\)/.test(warned ?? ''), warned)
    if (warned) console.log(`  ${warned.trim()}`)

    // The Performance view's stalls (HI-1135): the same stall kept, with its cause, and listed in the workspace's page.
    const kept = await lib.until(async () => (await inv('performance:stalls')).stalls.find((s) => s.ms >= 1000 && s.work.some((w) => w.label === 'ipc app:info')) ?? null, HUNG_MS)
    check('performance:stalls keeps it, naming the IPC call during it, and its CPU', !!kept && kept.work.find((w) => w.label === 'ipc app:info').ms >= 1000 && (kept.cpuMs === null || kept.cpuMs >= 0) && kept.at <= Date.now(), JSON.stringify(kept))
    const ws = path.join(lib.WORK, 'stalls-ws')
    fs.rmSync(ws, { recursive: true, force: true })
    fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
    await lib.openWorkspace(inv, page, ws)
    await page.locator('.activitybar button[aria-label="Performance"]').click()
    const table = page.locator('.performance-page:visible .table:has(th .th-sort:text-is("During it"))')
    const row = table.locator('tbody tr', { hasText: 'ipc app:info' })
    const shown = await lib.until(async () => ((await row.count()) >= 1 ? (await row.first().innerText()).replace(/\s+/g, ' ') : null), HUNG_MS)
    check('the Performance view lists it: its length and the IPC call during it', !!shown && /\b1\.\d s\b/.test(shown) && shown.includes('ipc app:info'), shown ?? (await page.locator('.performance-page:visible').innerText().catch(() => '')).slice(-600))
    check('…and how many there were since Combwork started', /stalls? since Combwork started/.test(await page.locator('[data-stalls-count]').innerText().catch(() => '')))
    await table.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.screenshot({ path: path.join(lib.WORK, 'stalls-performance.png') })

    // Main's thread pool (HI-1702): wider than Node's 4, and a wait for it is noted. Each read of a pipe nobody writes to
    // holds one of the pool's threads, using no CPU, until the test writes to it.
    await app.evaluate(async () => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')
      const ofs = req('original-fs')
      const net = req('net')
      const name = String.raw`\\.\pipe\cw-stalls-` + process.pid
      const socks = []
      const server = net.createServer((s) => socks.push(s))
      await new Promise((r) => server.listen(name, r))
      const reads = []
      global.__pool = {
        /** n more pool threads held by reads. */
        hold: async (n) => {
          for (let i = 0; i < n; i++) {
            const fd = await new Promise((r, j) => ofs.open(name, 'r+', (e, h) => (e ? j(e) : r(h))))
            reads.push(new Promise((r) => ofs.read(fd, Buffer.alloc(1), 0, 1, null, () => r(fd))))
          }
          // The server has each one's end, to let it go.
          while (socks.length < reads.length) await new Promise((r) => setTimeout(r, 10))
        },
        /** Whether a stat ends while they are held (bounded: a pool all held never ends it). */
        statEnds: () => Promise.race([new Promise((r) => ofs.stat(process.execPath, () => r(true))), new Promise((r) => setTimeout(() => r(false), 3000))]),
        release: async () => {
          for (const s of socks) s.write('x')
          for (const fd of await Promise.all(reads.splice(0))) ofs.closeSync(fd)
          for (const s of socks.splice(0)) s.destroy()
        },
        close: () => server.close()
      }
    })
    try {
      await app.evaluate(() => global.__pool.hold(8))
      check("main's thread pool is wider than Node's 4: with eight of its threads held, a file call still ends", await app.evaluate(() => global.__pool.statEnds()))
      await app.evaluate(() => global.__pool.release())
      const text = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
      const marked = text().length
      const since = () => text().slice(marked).split('\n')
      const slowCalls = () => since().filter((l) => /\[WARN\] \[main\] A file call took \d+ ms to end \(timed off main's thread\): it waited for the thread pool, whose 16 threads/.test(l))
      /** All 16 held until a file call is seen not to end; the watchdog's own stat, taken each second, ends once they go. */
      const holdAll = async () => {
        await app.evaluate(() => global.__pool.hold(16))
        const none = !(await app.evaluate(() => global.__pool.statEnds()))
        await app.evaluate(() => global.__pool.release())
        return none
      }
      check('…and with all 16 held, none ends', await holdAll())
      const waited = await lib.until(() => slowCalls()[0], HUNG_MS)
      check('with all its threads held, the slow file call is noted', !!waited, since().filter((l) => l.includes('[main]')).join(' | '))
      if (waited) console.log(`  ${waited.trim()}`)
      // Main's thread held 700 ms with the pool free (HR2's round 1): a busy warning, and no slow file call. The pool
      // held again after it marks the end: any line for main's 700 ms would come before that one's, or be counted in it.
      await app.evaluate(() => {
        process.env.CW_TEST_BLOCK_IPC = 'app:info=700*1'
      })
      const called = Date.now()
      await inv('app:info')
      const calledMs = Date.now() - called
      const busy = await lib.until(() => since().find((l) => /\[WARN\] \[main\] The main process was busy for \d+ ms/.test(l) && l.includes('ipc app:info')), HUNG_MS)
      // Evidence for a miss (HI-2317): whether the call was held, and the stalls kept (kept before the log's quiet minute).
      const keptNow = async () => JSON.stringify((await inv('performance:stalls')).stalls.slice(0, 3).map((s) => ({ ms: s.ms, work: s.work.map((w) => w.label) })))
      check('main held with the pool free is a busy warning', !!busy, busy ? '' : `${since().filter((l) => l.includes('[main]')).join(' | ')} · app:info took ${calledMs} ms · stalls kept, newest first: ${await keptNow()}`)
      await holdAll()
      await lib.until(() => slowCalls().length >= 2, HUNG_MS)
      const took = slowCalls().map((l) => Number(/took (\d+) ms/.exec(l)[1]))
      check("…and main's held thread isn't taken for a slow file call: the two lines are the held pool's", took.length === 2 && took.every((ms) => ms >= 2000) && !/more slow file call/.test(slowCalls()[1]), JSON.stringify(slowCalls()))
    } finally {
      await app.evaluate(() => global.__pool.release().then(() => global.__pool.close())).catch(() => undefined)
    }
  } catch (e) {
    console.error(e)
    failed++
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})()
