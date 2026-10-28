// React's commits in a test copy (HI-1387, HI-1865). A production build says nothing of a render loop until it throws
// (#185), so a test copy's window watches React's commits through a DevTools hook (src/renderer/src/commitWatch.ts) and
// says each new largest burst (commits within 250 ms) and longest chain (commits with nothing from outside between them)
// on its console, which lib.cjs collects. A window's ordinary counts are small. A deliberate loop (a setState per commit
// in a useEffect, as #1366's was, renderer commitLoop.tsx) is caught: its burst and its chain reach React's nested-update
// limit, seen by the page and by lib.cjs, without throwing; fast typing's burst is as large, but its chain stays short.
// A suite whose chain reaches the limit fails as it exits (lib.cjs), shown here by a child run; this suite's own loop is
// accepted. Dev build, throwaway profile, quiet.
const lib = require('./lib.cjs')
const path = require('path')
const { spawnSync } = require('child_process')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000
const LIMIT = 50
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  let h = null
  try {
    h = await lib.launch({ userData: path.join(lib.WORK, 'commitburst-profile'), env: { HIVE_API_PORT: lib.port(47901) } })
    const errors = []
    h.page.on('pageerror', (e) => errors.push(e.message))
    await lib.appReady(h.page)
    const largest = () => h.page.evaluate(() => window.__hiveCommitBurst?.().max ?? null)
    const longest = () => h.page.evaluate(() => window.__hiveCommitBurst?.().chain ?? null)
    check("a test copy's window watches React's commits", await h.page.evaluate(() => window.hive.commitWatch === true && typeof window.__hiveCommitBurst === 'function'))
    // Opening the window is calibration data for step 2 (HI-1759), not judged here: only that it was counted.
    const opening = await largest()
    console.log(`INFO opening the window: ${opening} commits at most within 250 ms`)
    check('…opening the window is counted', typeof opening === 'number' && opening > 0, String(opening))
    check("…and lib.cjs has the window's count, small as it is", !!(await lib.until(() => lib.commitBursts() >= opening, HUNG_MS, 100)), `${lib.commitBursts()} of ${opening}`)
    const openingChain = await longest()
    console.log(`INFO opening the window: ${openingChain} commits at most with nothing from outside between them`)
    check('…its chains too, well under the limit', typeof openingChain === 'number' && openingChain > 0 && openingChain < LIMIT, String(openingChain))
    check("…and lib.cjs has the window's chain", !!(await lib.until(() => lib.commitChains() >= openingChain, HUNG_MS, 100)), `${lib.commitChains()} of ${openingChain}`)

    // Fast typing (HI-1864's false alarms were input): a commit per key, many within 250 ms, each its own short chain.
    const burstBefore = await largest()
    await h.page.keyboard.press('Control+Shift+P')
    const palette = h.page.locator('.palette input')
    await palette.waitFor({ timeout: HUNG_MS })
    await palette.pressSequentially('a'.repeat(60))
    await h.page.keyboard.press('Escape')
    const typedBurst = await largest()
    const typedChain = await longest()
    console.log(`INFO typing 60 keys: burst ${typedBurst} (was ${burstBefore}), chain ${typedChain}`)
    check('typing makes commits: one at least per key', typedBurst > 0, String(typedBurst))
    check('…but no chain: each key starts a new one, well under the limit', typedChain < LIMIT / 2, String(typedChain))
    // The fixture: a loop of 80 commits, one per useEffect, all within the window.
    await h.page.evaluate((n) => window.__hiveTestCommitLoop(n), 80)
    const after = await largest()
    check('a deliberate loop (a setState per commit in a useEffect) is caught: its burst reaches the candidate threshold', after >= LIMIT, String(after))
    check('…and lib.cjs has it from the console', !!(await lib.until(() => lib.commitBursts() >= after, HUNG_MS, 100)), `${lib.commitBursts()} of ${after}`)
    const chain = await longest()
    check('…and its chain reaches the limit: nothing from outside between its commits', chain >= LIMIT, String(chain))
    check('…which lib.cjs has from the console', !!(await lib.until(() => lib.commitChains() >= chain, HUNG_MS, 100)), `${lib.commitChains()} of ${chain}`)
    check('…which records it only: no page error (it never throws)', errors.length === 0, errors.join('; '))
    lib.acceptCommitChain('commitburst makes a render loop on purpose')

    // lib.cjs fails a suite whose chain reaches the limit, as it exits, even one that ends with process.exit(0): a child
    // suite of a few lines, its window a stand-in saying a chain of 60 on its console; and accepted, it passes.
    const child = (accept) => {
      const script = `const lib = require(process.argv[1]); const listeners = []
        const page = { on: (e, f) => { if (e === 'console') listeners.push(f) }, evaluate: async () => undefined }
        lib.watchCommitBursts({ windows: () => [page], on: () => {} })
        for (const f of listeners) f({ text: () => '[hive commit chain] 60' })
        if (process.argv[2] === 'accept') lib.acceptCommitChain('a test of the acceptance')
        process.exit(0)`
      const r = spawnSync(process.execPath, ['-e', script, path.join(__dirname, 'lib.cjs'), accept ? 'accept' : ''], { env: lib.baseEnv(), encoding: 'utf8', timeout: HUNG_MS })
      return { code: r.status, lines: String(r.stdout ?? '').split(/\r?\n/) }
    }
    const loop = child(false)
    check('a suite whose chain reaches the limit fails: exit code 1 though it ended with process.exit(0)', loop.code === 1, String(loop.code))
    check('…and a FAIL line naming its chain', loop.lines.some((l) => l.startsWith('FAIL React commit chain: the longest was 60 ')), loop.lines.join(' | '))
    const accepted = child(true)
    check('a suite that accepts its chain passes, saying why', accepted.code === 0 && accepted.lines.some((l) => l.includes('accepted by the suite: a test of the acceptance')) && !accepted.lines.some((l) => l.startsWith('FAIL')), `${accepted.code}: ${accepted.lines.join(' | ')}`)
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    if (h) await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
