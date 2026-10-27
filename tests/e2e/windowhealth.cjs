// A window's freeze names itself in hive.log (HI-1775): a deliberately slow render (the page busy for half a second)
// logs a long-task line naming the view it was on; a hang (Electron's unresponsive, as rendercrash raises it) logs its
// start with the view, the window's last input and its last long tasks, and its recovery with how long it was out.
// Native dialogs are stubbed in the test build's main process (the hang's Wait / Reload box stays open until it
// recovers). Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'windowhealth-profile')
const ws = path.join(lib.WORK, 'windowhealth-ws')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
  const { app, page, inv } = await lib.launch({ userData, env: { HIVE_API_PORT: lib.port(47902) } })
  try {
    await lib.openWorkspace(inv, page, ws)
    const logged = (since, test) => lib.hiveLogLines(userData).slice(since).find(test)
    // Its lines so far (the file ends with a newline: the empty piece after it isn't one).
    const linesNow = () => lib.hiveLogLines(userData).filter((l, i, all) => i < all.length - 1 || l !== '').length

    // --- A slow render on the Task Board: a long-task line, naming the board.
    await page.getByRole('button', { name: 'Task Board' }).click()
    await lib.until(async () => page.locator('.board').isVisible(), HUNG_MS)
    // Where the window is reaches main as it changes; the long task says it too, as its report goes.
    const from = linesNow()
    // Run as one of the page's own tasks (a timer's), as a slow render is: a script DevTools runs isn't counted as one.
    await page.evaluate(() =>
      setTimeout(() => {
        const until = performance.now() + 500
        while (performance.now() < until);
      }, 0)
    )
    const busy = await lib.until(async () => logged(from, (l) => l.includes("The window's page was busy for")), HUNG_MS, 200)
    check('a slow render logs a long-task line', !!busy)
    check('…naming the view it was on, and how long it took', !!busy && /view board/.test(busy) && /busy for (\d{3,}) ms/.test(busy) && Number(/busy for (\d+) ms/.exec(busy)[1]) >= 450, busy)

    // --- A hang: its start with the view (after the hang prompt's wait), its recovery with how long it was out.
    await app.evaluate(({ dialog }) => {
      globalThis.__boxes = []
      dialog.showMessageBox = (_win, o) => {
        globalThis.__boxes.push({ message: o.message })
        return new Promise((resolve) => o.signal?.addEventListener('abort', () => resolve({ response: 0 })))
      }
    })
    await page.mouse.move(40, 40)
    const hangFrom = linesNow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('unresponsive'))
    const hung = await lib.until(async () => logged(hangFrom, (l) => l.includes("The window's page isn't responding (")), HUNG_MS, 200)
    check('a hang logs its start', !!hung)
    check('…with the view, the last input and the last long tasks', !!hung && /view board/.test(hung) && /its last input \d+\.\d s before/.test(hung) && /its last long tasks: \d+ ms/.test(hung), hung)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('responsive'))
    const back = await lib.until(async () => logged(hangFrom, (l) => l.includes("The window's page responds again")), HUNG_MS, 200)
    check('…and its recovery, how long it was out and the view', !!back && /responds again, \d+\.\d s after it stopped responding/.test(back) && /view board/.test(back), back)
    check('the hang prompt was asked and dismissed', !!(await lib.until(async () => (await app.evaluate(() => globalThis.__boxes.length)) === 1, HUNG_MS)))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
