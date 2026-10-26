// "The main process was busy" (#1109): a gap spanning the PC's sleep (a suspend and resume told by powerMonitor, faked
// here around a block of the main process) logs an info line, not a warning; an IPC call that holds the main process
// (HIVE_TEST_BLOCK_IPC) is named in the warning. Main's thread pool has 16 threads, not Node's 4 (HI-1702): with eight held
// a file call still ends, and with all of them held the wait is noted in hive.log. Dev build, throwaway profile, no
// workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'stalls-profile')
const logFile = path.join(userData, 'logs', 'hive.log')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [])
const busyLines = () => lines().filter((l) => l.includes('[main] The main process was'))

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  // A warning a second at most, so one from Hive's own start doesn't hide the suite's.
  const { app, inv } = await lib.launch({ userData, env: { HIVE_TEST_STALL_QUIET_MS: '1000' } })
  try {
    // The PC sleeps: suspend, the main process held, resume.
    const before = busyLines().length
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
      for (const until = Date.now() + 1500; Date.now() < until; );
      powerMonitor.emit('resume')
    })
    const slept = await lib.until(() => busyLines().slice(before).find((l) => /\[INFO\] \[main\] The main process was paused for \d+ ms while the PC slept: not counted as busy/.test(l)), HUNG_MS)
    check('a gap spanning sleep is an info line', !!slept, busyLines().slice(before).join(' | '))
    check('and not a warning', !busyLines().slice(before).some((l) => l.includes('[WARN]')), busyLines().slice(before).join(' | '))

    // An IPC call holds the main process: the warning names it.
    const mark = busyLines().length
    await app.evaluate(() => {
      process.env.HIVE_TEST_BLOCK_IPC = 'app:info=1500*1'
    })
    await inv('app:info')
    const warned = await lib.until(() => busyLines().slice(mark).find((l) => /\[WARN\] \[main\] The main process was busy for \d+ ms/.test(l) && l.includes('ipc app:info')), HUNG_MS)
    check('a blocking IPC call is named in the warning', !!warned, busyLines().slice(mark).join(' | '))
    check('with its time and the CPU used', /ipc app:info \(\d+\.\d s\)/.test(warned ?? '') && /\(main thread CPU \d+ ms\)/.test(warned ?? ''), warned)
    if (warned) console.log(`  ${warned.trim()}`)

    // Main's thread pool (HI-1702): wider than Node's 4, and a wait for it is noted. Each read of a pipe nobody writes to
    // holds one of the pool's threads, using no CPU, until the test writes to it.
    await app.evaluate(async () => {
      const req = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')
      const ofs = req('original-fs')
      const net = req('net')
      const name = String.raw`\\.\pipe\hive-stalls-` + process.pid
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
      // All 16 held until a file call is seen not to end; Hive's own stat, taken each second, then ends once they go.
      await app.evaluate(() => global.__pool.hold(16))
      check('…and with all 16 held, none ends', !(await app.evaluate(() => global.__pool.statEnds())))
      await app.evaluate(() => global.__pool.release())
      const waited = await lib.until(() => since().find((l) => /\[WARN\] \[main\] Main's file calls waited \d+ ms for the thread pool \(all 16 of its threads busy/.test(l)), HUNG_MS)
      check('with all its threads held, the wait for one is noted', !!waited, since().filter((l) => l.includes('[main]')).join(' | '))
      if (waited) console.log(`  ${waited.trim()}`)
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
