// Dragging a card in a column taller than the window: held near the column's top or bottom edge (still, with no
// further mouse moves), the column scrolls until it can't, and the card drops where the marker shows: the very top,
// the very bottom, or into another long column scrolled elsewhere; a column scrolled by anything else under the still
// pointer moves the marker too. Leaving the board stops the scrolling, and the
// columns scroll normally afterwards. No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'boardscroll-profile')
const ws = path.join(lib.WORK, 'boardscroll-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 700 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(100)
    return v
  }

  // Thirty cards in Todo and thirty in Doing: both columns far taller than the window.
  const todo = []
  const doing = []
  for (let i = 1; i <= 30; i++) todo.push((await inv('tasks:create', { title: `Todo card ${i}`, project: 'alpha' })).number)
  for (let i = 1; i <= 30; i++) doing.push((await inv('tasks:create', { title: `Doing card ${i}`, project: 'alpha', column: 'doing', agent: '' })).number)
  const saved = async (column) => (await inv('tasks:list')).filter((c) => c.column === column && !c.archived).sort((a, b) => a.order - b.order).map((c) => c.number)

  await page.getByRole('button', { name: 'Task Board' }).click()
  const column = (label) => page.locator('.board-column', { has: page.locator('.board-column-header', { hasText: label }) })
  const body = (label) => column(label).locator('.board-column-body')
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  await until(async () => (await tile(todo[29]).count()) === 1, HUNG_MS)
  const scroll = (label) => body(label).evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
  const scrollTo = (label, top) => body(label).evaluate((el, t) => (el.scrollTop = t === 'end' ? el.scrollHeight : t), top)
  check('the columns are taller than the window', (await scroll('Todo')).max > 400 && (await scroll('Active')).max > 400, JSON.stringify(await scroll('Todo')))

  /** Presses on a card and moves a little, so the drag starts. */
  const pick = async (n) => {
    const a = await tile(n).boundingBox()
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2 + 6, { steps: 3 })
    await lib.sleep(150)
  }
  /**
   * Moves the dragged card to (x, y) and leaves the mouse there. A last small move makes sure the board hears where
   * it stopped (Playwright sends few dragovers during a move); from then on the mouse is still, with none at all.
   */
  let held = null
  const holdAt = async (x, y) => {
    await page.mouse.move(x, y, { steps: 6 })
    await lib.sleep(100)
    await page.mouse.move(x + 1, y, { steps: 1 })
    await lib.sleep(100)
    held = { x, y }
  }
  /** Lets go where the mouse is held: Playwright only drops on a release that straight follows a move. */
  const release = async () => {
    await page.mouse.move(held.x, held.y)
    await page.mouse.up()
  }
  const marker = async (label) =>
    body(label).evaluate((el) => {
      const kids = [...el.children]
      const i = kids.findIndex((k) => k.classList.contains('task-drop'))
      if (i < 0) return null
      const next = kids.slice(i + 1).find((k) => k.classList.contains('task-card'))
      return next ? Number(next.dataset.task) : 'end'
    })

  // --- The bottom card to the very top, held still at the top edge.
  await scrollTo('Todo', 'end')
  await lib.sleep(200)
  const last = todo[29]
  await pick(last)
  const todoBox = await body('Todo').boundingBox()
  await holdAt(todoBox.x + todoBox.width / 2, todoBox.y + 6)
  const start = (await scroll('Todo')).top
  await lib.sleep(400)
  const moving = (await scroll('Todo')).top
  check('held still at the top edge, the column scrolls', moving < start, `${start} → ${moving}`)
  check('until it reaches the top', !!(await until(async () => (await scroll('Todo')).top === 0, 8000)), String((await scroll('Todo')).top))
  await lib.sleep(300)
  check('and stays there', (await scroll('Todo')).top === 0)
  check('the marker is before the first card', (await marker('Todo')) === todo[0], String(await marker('Todo')))
  await release()
  check('dropped at the very top', !!(await until(async () => (await saved('todo'))[0] === last, 5000)), (await saved('todo')).slice(0, 3).join(','))
  await page.screenshot({ path: path.join(lib.WORK, 'boardscroll-1-top.png') })

  // --- The top card to the very bottom, held still at the bottom edge.
  await scrollTo('Todo', 0)
  await lib.sleep(200)
  const first = (await saved('todo'))[0]
  await pick(first)
  await holdAt(todoBox.x + todoBox.width / 2, todoBox.y + todoBox.height - 6)
  check('held still at the bottom edge, it scrolls to the bottom', !!(await until(async () => {
    const s = await scroll('Todo')
    return s.top >= s.max - 1
  }, 8000)))
  check('the marker is at the end', !!(await until(async () => (await marker('Todo')) === 'end', HUNG_MS)), String(await marker('Todo')))
  await release()
  check('dropped at the very bottom', !!(await until(async () => (await saved('todo')).at(-1) === first, 5000)), (await saved('todo')).slice(-3).join(','))

  // --- Into another long column scrolled elsewhere: Active scrolls to its top, and the card lands first.
  await scrollTo('Todo', 0)
  await scrollTo('Active', 300)
  await lib.sleep(200)
  const moved = (await saved('todo'))[0]
  await pick(moved)
  const doingBox = await body('Active').boundingBox()
  await holdAt(doingBox.x + doingBox.width / 2, doingBox.y + 200)
  // Scrolled by something other than the board's own edge scrolling (Chromium scrolls a column near its edge during
  // a drag too, #256), with the pointer still: the marker follows the card now under it, the sixth.
  const sixth = await body('Active').evaluate((el, [n, y]) => {
    const r = el.querySelector(`.task-card[data-task="${n}"]`).getBoundingClientRect()
    el.scrollTop += r.top + r.height / 4 - y
    return el.scrollTop
  }, [doing[5], held.y])
  check('scrolled under a still pointer, the marker follows', sixth > 50 && !!(await until(async () => (await marker('Active')) === doing[5], HUNG_MS)), `${sixth}: ${await marker('Active')}`)
  await holdAt(doingBox.x + doingBox.width / 2, doingBox.y + 6)
  check('over Active, Active scrolls to its top', !!(await until(async () => (await scroll('Active')).top === 0, 8000)))
  check("Todo doesn't scroll meanwhile", (await scroll('Todo')).top === 0)
  check('the marker is before Active\'s first card', !!(await until(async () => (await marker('Active')) === doing[0], HUNG_MS)), String(await marker('Active')))
  await release()
  // Into Active from another column asks who works on it (Move to Active): the card has no agent, so Nobody yet.
  const ask = page.locator('.dialog', { hasText: `Move ${await lib.cardLabel(inv, moved)} to Active` })
  await ask.waitFor({ timeout: 5000 })
  await ask.locator('.dialog-footer .btn.primary').click()
  check('it lands first in Doing, where the marker was', !!(await until(async () => (await saved('doing'))[0] === moved, 5000)), (await saved('doing')).slice(0, 3).join(','))

  // --- Leaving the board stops the scrolling; afterwards the column scrolls as usual.
  await scrollTo('Active', 'end')
  await lib.sleep(200)
  await pick(doing[29])
  await holdAt(doingBox.x + doingBox.width / 2, doingBox.y + 6)
  await until(async () => (await scroll('Active')).top < (await scroll('Active')).max - 100, 5000)
  // Out of the board, over the page header.
  await holdAt(doingBox.x + doingBox.width / 2, 20)
  await lib.sleep(200)
  const a1 = (await scroll('Active')).top
  await lib.sleep(500)
  const a2 = (await scroll('Active')).top
  check('leaving the board stops the scrolling', a1 === a2 && a1 > 0, `${a1} → ${a2}`)
  await release()
  await lib.sleep(300)
  const b1 = (await scroll('Active')).top
  await lib.sleep(500)
  check('dropping outside stops it too', (await scroll('Active')).top === b1)
  check('the card stayed where it was', (await saved('doing')).at(-1) === doing[29])
  const box = await body('Active').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)
  check('the column scrolls normally afterwards', !!(await until(async () => (await scroll('Active')).top < b1, HUNG_MS)))

  // --- A click still opens a card.
  await tile(todo[5]).click()
  check('a click opens the card', !!(await until(async () => (await page.locator('.dialog').count()) === 1, HUNG_MS)))
  await page.keyboard.press('Escape')

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
