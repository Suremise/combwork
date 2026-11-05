// A process that failed to start is reported with its code (#599). Under heavy load Windows can fail a process as it
// starts (0xc0000142: its desktop heap runs short); the runner says the code and what it means, so the agent running the
// tests can react. The failure here is Node made: a child that has started ends with the startup failure's status, so
// nothing unsigned runs and no dialog can show. So this checks the reporting (the code is seen as soon as the child
// ends, and said), not that a real loader failure shows no dialog: under real load one can (windowsExits.cjs). No test
// copy of Combwork, no window.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const { describeExit, windowsCodesIn } = require('./windowsExits.cjs')

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Starts a child and waits (up to ms: a bound for a hung start) for it to end: { code, error } (code null if it hasn't). */
async function runToEnd(args, ms = 30000) {
  const r = { code: null, error: null }
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, env: lib.childEnv() })
  child.on('error', (e) => (r.error = e))
  child.on('exit', (code) => (r.code = code))
  await lib.until(() => r.code !== null || r.error, ms)
  if (r.code === null && !r.error) child.kill()
  return r
}

;(async () => {
  const { resultLines } = await import('./runner.mjs')

  // The status a child that can't initialise ends with (here a child that has started, ending with it).
  const r = await runToEnd(['-e', 'process.exit(-1073741502)'])
  check('a child ending with STATUS_DLL_INIT_FAILED: its parent sees the code as it ends', r.code === 0xc0000142, JSON.stringify(r))

  // A suite ending that way: the runner's line names the code and what to do.
  const [line] = resultLines('failfast', { ok: false, code: r.code, seconds: 1, failed: [] })
  check('the runner says the code and what to do', /FAIL {2}1s {2}\(exit 0xc0000142: a DLL failed to initialise .*desktop heap.*: rerun with fewer runs at once\)$/.test(line), line)

  // A child of a suite's that failed to start, in the suite's output (Playwright's words for Electron that didn't start):
  // under the failed suite's line, with its meaning.
  const out = `<process did exit: exitCode=${r.code}, signal=null>`
  const lines = resultLines('failfast', { ok: false, code: 1, seconds: 1, failed: ['FAIL Combwork did not start'], windows: windowsCodesIn(out) })
  check('a startup failure in a suite’s output is said under its line', lines[2] === `    Windows: ${describeExit(0xc0000142)}`, JSON.stringify(lines))

  console.log(failed ? `FAIL ${failed} check(s) failed` : 'failfast: all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
