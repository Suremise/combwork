// Why Combwork stopped (#985): a normal quit logs each step of its way out, with the caller; a crash of the window's page
// and of the main process each leave a crash dump in the profile (never uploaded) and the page's a log line; the next
// start logs the dumps and Copy Diagnostics names the newest. Crashes only this test copy: its page by loading
// chrome://crash, its main process by process.crash() in it, and anything left of it is ended by its own pid and start
// time (lib.identify), never by name. Its memory is logged at start and exit, and with Save a memory snapshot on, a main
// process given a small heap that runs out of it leaves a heap snapshot in the profile first (#1005). Dev build,
// throwaway profile, no workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'crashdumps-profile')
const reports = path.join(userData, 'Crashpad', 'reports')
const logFile = path.join(userData, 'logs', 'combwork.log')
const heapDir = path.join(userData, 'heap')
// The main process's heap in the out-of-memory test: small, so it fills (and its snapshot is written) in seconds.
const SMALL_HEAP_MB = 256
// The bound for that test's main process filling its heap and writing the snapshot: a bound for a hung run (#570).
const OOM_HUNG_MS = 180000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const dumps = () => (fs.existsSync(reports) ? fs.readdirSync(reports).filter((f) => f.toLowerCase().endsWith('.dmp')) : [])
const snapshots = () => (fs.existsSync(heapDir) ? fs.readdirSync(heapDir).filter((f) => f.endsWith('.heapsnapshot')) : [])
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')
/** The log since the last start: this run's lines. */
const thisRun = () => {
  const text = logText()
  const at = Math.max(-1, ...[...text.matchAll(/\] Combwork \S+ starting \(/g)].map((m) => m.index))
  return at < 0 ? '' : text.slice(text.lastIndexOf('\n', at) + 1)
}
const has = (text, re) => re.test(text)

// Playwright gives up on a page whose renderer crashed (it throws "Target crashed" from its connection), and on an app
// whose main process went; neither is this suite's failure.
process.on('uncaughtException', (e) => {
  if (/Target crashed|Target page, context or browser has been closed|has been closed/.test(String(e?.message))) return
  console.error(e)
  process.exit(1)
})

;(async () => {
  fs.rmSync(userData, { recursive: true, force: true })
  let current = null
  const identities = []
  const start = async () => {
    current = await lib.launch({ userData })
    identities.push(...lib.identify([current.app.process().pid]))
    return current
  }
  try {
    // A normal quit: each step of it, and who asked.
    {
      const { app, inv } = await start()
      check('a fresh profile has no crash dumps', dumps().length === 0, dumps().join(', '))
      const quitting = await lib.quitWatch(app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits', !!(await quitting.gone(HUNG_MS)), quitting.timings(Date.now()))
      const run = thisRun()
      for (const [what, re] of [
        ['before-quit', /\[exit\] before-quit/],
        ['the call, with its caller', /\[exit\] Leaving by app\.quit: quitting/],
        ['will-quit', /\[exit\] will-quit/],
        ['quit, with its exit code', /\[exit\] quit \(exit code 0\)/],
        ["the process's exit", /\[exit\] The main process is exiting \(exit code 0\)/]
      ]) check(`a normal quit logs ${what}`, has(run, re), run.split('\n').filter((l) => l.includes('[exit]')).join(' | '))
      // The main process's memory (#1005): at start, and as it exits.
      check('the start logs the memory', has(run, /\[INFO\] \[memory\] Memory, at start: heap \d+ of \d+ MB used \(limit \d+ MB, \d+%\); external \d+ MB, array buffers \d+ MB, rss \d+ MB/), run.split('\n').filter((l) => l.includes('[memory]')).join(' | '))
      check('the exit line has the memory', has(run, /\[exit\] The main process is exiting \(exit code 0\); memory: heap \d+ of \d+ MB used/))
      check('snapshots are off by default', !has(run, /Memory snapshots on/))
      current = null
    }

    // The window's page crashes: a dump and a line; Combwork reloads it.
    {
      const { app } = await start()
      await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].webContents.loadURL('chrome://crash').catch(() => undefined))
      check("the page's crash leaves a crash dump", !!(await lib.until(() => dumps().length === 1, HUNG_MS)), `${dumps().length} dump(s)`)
      check("the page's crash is logged with its reason", !!(await lib.until(() => /\[exit\] A page's process went \(crashed, exit code/.test(thisRun()), HUNG_MS)))

      // The main process crashes: a dump, and no quit in the log.
      const before = dumps().length
      const proc = app.process()
      const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
      await app.evaluate(() => process.crash()).catch(() => undefined)
      check('the main process ends', await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), HUNG_MS))]))
      check("the main process's crash leaves a crash dump", !!(await lib.until(() => dumps().length === before + 1, HUNG_MS)), `${dumps().length} dump(s)`)
      check('a crash logs no quit', !has(thisRun(), /\[exit\] (before-quit|will-quit|quit \()/))
      current = null
    }

    // Out of memory (#1005), with Settings → Advanced → Save a memory snapshot… on: the main process, given a small heap,
    // fills it; Node writes a heap snapshot into the profile's heap folder before the crash, which leaves a dump too.
    {
      fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.heapSnapshotNearLimit': true } }))
      const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [`--js-flags=--max-old-space-size=${SMALL_HEAP_MB}`, lib.ROOT], cwd: lib.ROOT, env: lib.hiveEnv({ HIVE_USER_DATA: userData }) })
      current = { app }
      identities.push(...lib.identify([app.process().pid]))
      await lib.appReady(await app.firstWindow())
      check('the start says snapshots are on, and where', !!(await lib.until(() => /\[memory\] Memory snapshots on: if the main process nears its heap limit, a snapshot is written to .*\\heap/.test(thisRun()), HUNG_MS)))
      const limit = Number(/\[memory\] Memory, at start: .*\(limit (\d+) MB/.exec(thisRun())?.[1])
      check('the heap limit is the small one', limit > 0 && limit < 1024, `limit ${limit} MB`)
      const before = dumps().length
      const proc = app.process()
      const gone = new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true))))
      // Never returns: the main process runs out of heap in it.
      void app.evaluate(() => {
        const keep = []
        for (;;) keep.push(Array.from({ length: 100000 }, () => ({ n: Math.random() })))
      }).catch(() => undefined)
      check('the main process runs out of memory and ends', await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), OOM_HUNG_MS))]))
      const shots = snapshots()
      check('it left a heap snapshot in the profile', shots.length === 1 && fs.statSync(path.join(heapDir, shots[0])).size > 0, shots.join(', '))
      check('and a crash dump', !!(await lib.until(() => dumps().length === before + 1, HUNG_MS)), `${dumps().length} dump(s)`)
      current = null
    }

    // The next start logs them, and Copy Diagnostics names the newest.
    {
      const { app, inv } = await start()
      check('the next start logs the dumps', !!(await lib.until(() => /\[exit\] 3 crash dump\(s\) in the profile; the newest from \d{4}-/.test(thisRun()), HUNG_MS)))
      check('and the snapshot', /\[memory\] 1 memory snapshot\(s\) in .*\\heap; the newest from \d{4}-/.test(thisRun()))
      const report = await inv('app:diagnostics')
      check('Copy Diagnostics names the newest dump', /### Crash dumps\n\n- 3 in `[^`]*Crashpad\\reports`; the newest from [^:]+:[^`]*`[\w-]+\.dmp`/.test(report), report.slice(report.indexOf('### Crash dumps'), report.indexOf('### Crash dumps') + 300))
      check('and says they are never sent', /Combwork never sends them/.test(report))
      const memory = report.slice(report.indexOf('### Memory'), report.indexOf('### Log'))
      check('Copy Diagnostics has the memory now, the snapshots and the lines logged', /- Now: heap \d+ of \d+ MB used/.test(memory) && /- Memory snapshots: on; 1 in `[^`]*\\heap`, the newest from \d{4}-[^(]+\(\d+ MB\): they hold what Combwork had in memory, so never attached/.test(memory) && /- Logged:\n {2}- \d{4}-\S+ Memory, at start: heap/.test(memory), memory)
      const quitting = await lib.quitWatch(app)
      await inv('app:quit').catch(() => undefined)
      check('the test copy quits again', !!(await quitting.gone(HUNG_MS)))
      current = null
    }
  } catch (e) {
    check('no unexpected error', false, e?.stack ?? String(e))
  } finally {
    if (current) await current.app.close().catch(() => undefined)
    // Anything left of a copy this suite started, by its own pid and start time only.
    for (const id of identities) lib.endTreeExactly(id)
    // The snapshot is hundreds of MB: not kept for the runner's housekeeping.
    fs.rmSync(heapDir, { recursive: true, force: true })
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})()
