// The board's six columns and how it folds (#170): On Hold before Todo and Approved between Review and Done, through the
// Agent API too; each column collapses to a narrow strip with its name and count, and the expanded
// ones share the freed width (1, 3 and 5 collapsed, narrow and wide windows); a card dropped on a strip goes to the top
// of that column (its true top with a search on, #263); columns fold sideways with « / », cards with ▾ / ▸ (#276); cards fold to one line, one by one or all of a column from its menu; and all of it is kept for the
// workspace after a reload and a restart, also with two windows (each its own workspace) that read the folds before
// either changed them. Both themes. No agents. Dev build, throwaway profile and workspaces.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'boardfold-profile')
const ws = path.join(lib.WORK, 'boardfold-ws')
const alpha = path.join(ws, 'alpha')
const wsB = path.join(lib.WORK, 'boardfold-ws-b')
const PORT = Number(lib.port(47898))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const LABELS = ['On Hold', 'Todo', 'Active', 'Review', 'Approved', 'Done']

;(async () => {
  for (const d of [userData, ws, wsB]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(wsB, 'beta'))
  fs.mkdirSync(path.join(alpha, '.combwork'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-coder', name: 'Coder' }] }))
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT) })
  let app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  let page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 800 })
  await lib.appReady(page)
  let inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = (fn, ms = 10000) => lib.until(fn, ms)

  // A card in each column, and two more in Todo.
  const n = {}
  for (const [key, column] of [['hold', 'hold'], ['t1', 'todo'], ['t2', 'todo'], ['t3', 'todo'], ['doing', 'doing'], ['review', 'review'], ['passed', 'passed'], ['done', 'done']]) {
    n[key] = (await inv('tasks:create', { title: `A ${key} card with a title long enough to be cut short when it is folded`, project: 'alpha', column, ...(column === 'doing' ? { agent: '' } : {}) })).number
  }
  await inv('tasks:update', n.t2, { blocked: 'Waiting for a decision' })

  // The workspace token (a script) may park a card (a project agent's own token can't: tests/boardColumns.test.ts).
  const tokens = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8'))
  const api = async (token, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const viaWorkspace = await api(tokens.token, 'PATCH', `/v1/tasks/${n.t3}`, { column: 'hold' })
  check('the workspace token can, and the column is listed as hold', viaWorkspace.status === 200 && viaWorkspace.body.column === 'hold', JSON.stringify(viaWorkspace))
  await inv('tasks:update', n.t3, { column: 'todo' })
  const unknown = await api(tokens.token, 'PATCH', `/v1/tasks/${n.t3}`, { column: 'merged' })
  check('an unknown column lists the six', unknown.status === 400 && /hold, todo, doing, review, passed or done/.test(unknown.body?.error), JSON.stringify(unknown))

  await page.getByRole('button', { name: 'Task Board' }).click()
  const columns = page.locator('.board-column')
  check('the board shows six columns in order', !!(await until(async () => (await columns.count()) === 6, HUNG_MS)) && JSON.stringify(await page.locator('.board-column-label').allInnerTexts()) === JSON.stringify(LABELS.map((l) => l.toUpperCase())), JSON.stringify(await page.locator('.board-column-label').allInnerTexts()))
  const column = (label) => page.locator(`.board-column[data-column="${{ 'On Hold': 'hold', Todo: 'todo', Active: 'doing', Review: 'review', Approved: 'passed', Done: 'done' }[label]}"]`)
  const tile = (x) => page.locator(`.task-card[data-task="${x}"]`)
  check('each card is in its column', (await column('On Hold').locator(tile(n.hold)).count()) === 1 && (await column('Approved').locator(tile(n.passed)).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'boardfold-six.png') })

  /** Widths of the columns as drawn: expanded ones share the room equally, collapsed strips stay narrow. */
  const widths = () => columns.evaluateAll((els) => els.map((e) => ({ id: e.dataset.column, w: Math.round(e.getBoundingClientRect().width), collapsed: e.classList.contains('collapsed') })))
  const board = () => page.locator('.board').evaluate((e) => ({ client: e.clientWidth, scroll: e.scrollWidth, right: Math.round(e.lastElementChild.getBoundingClientRect().right - e.getBoundingClientRect().right) }))
  const settled = async () => {
    await lib.sleep(400)
    return widths()
  }
  const collapse = async (label) => {
    await column(label).getByRole('button', { name: `Collapse ${label}` }).click()
    await until(async () => (await column(label).getAttribute('class')).includes('collapsed'), 5000)
  }
  const expand = async (label) => {
    await column(label).getByRole('button', { name: `Expand ${label}` }).click()
    await until(async () => !(await column(label).getAttribute('class')).includes('collapsed'), 5000)
  }
  const fills = async (what) => {
    const w = await settled()
    const open = w.filter((c) => !c.collapsed).map((c) => c.w)
    const strips = w.filter((c) => c.collapsed).map((c) => c.w)
    const b = await board()
    const even = Math.max(...open) - Math.min(...open) <= 2
    const narrow = strips.every((s) => s <= 40)
    // No gap after the last column and no sideways scroll while the least widths (160 a column, 34 a strip, 10 between)
    // fit; when they don't, each expanded column keeps its least width and the board scrolls.
    const least = open.length * 160 + strips.length * 34 + (w.length - 1) * 10
    const fit = least <= b.client ? b.scroll <= b.client + 1 && Math.abs(b.right) <= 2 : b.scroll >= least - 1 && open.every((x) => x >= 159)
    check(`${what}: the expanded columns share the width and the board ${least <= b.client ? 'fills it' : 'scrolls (their least widths are wider)'}`, even && narrow && fit, JSON.stringify({ w, b }))
  }

  for (const [width, label] of [
    [1500, 'wide'],
    [1150, 'narrow']
  ]) {
    await lib.fitWindow(app, page, { width, height: 800 })
    await fills(`${label} window, none collapsed`)
    await collapse('On Hold')
    await fills(`${label} window, 1 collapsed`)
    await collapse('Done')
    await collapse('Approved')
    await fills(`${label} window, 3 collapsed`)
    await collapse('Review')
    await collapse('Active')
    await fills(`${label} window, 5 collapsed`)
    if (label === 'wide') await page.screenshot({ path: path.join(lib.WORK, 'boardfold-five.png') })
    for (const l of ['Active', 'Review', 'Approved', 'Done', 'On Hold']) await expand(l)
  }
  await lib.fitWindow(app, page, { width: 1500, height: 800 })

  // A collapsed column: a strip with its name and count, a keyboard-reachable button; clicking it expands it.
  await collapse('On Hold')
  const strip = column('On Hold').locator('.board-column-strip')
  check('a collapsed column shows its name and card count', /On Hold/i.test(await strip.innerText()) && (await strip.locator('.count').innerText()) === '1', await strip.innerText())
  check('its strip is a button saying it expands it', (await strip.getAttribute('aria-label')) === 'Expand On Hold' && (await strip.getAttribute('aria-expanded')) === 'false')
  check('its cards are hidden', (await tile(n.hold).count()) === 0)

  // A card dropped on the strip goes to the top of that column.
  await tile(n.t3).dragTo(strip)
  const saved = async (col) => (await inv('tasks:list')).filter((c) => c.column === col && !c.archived).sort((a, b) => a.order - b.order).map((c) => c.number)
  check('a card dropped on a collapsed column goes to its top', !!(await until(async () => (await saved('hold')).join() === [n.t3, n.hold].join(), 5000)), (await saved('hold')).join())
  check("the strip's count follows", !!(await until(async () => (await strip.locator('.count').innerText()) === '2', 5000)))
  await strip.focus()
  await page.keyboard.press('Enter')
  check('Enter on the strip expands the column', !!(await until(async () => (await tile(n.hold).count()) === 1, 5000)))
  await inv('tasks:update', n.t3, { column: 'todo', position: 'bottom' })

  // With a search on, the strip still puts the card at the true top of its column, above the cards the search hides
  // (#263): not at the top of the ones it shows, which here are none.
  const search = page.getByPlaceholder('Search cards (AM-12, words, labels)')
  await search.fill('t3 card')
  await collapse('On Hold')
  check('the search hides the other cards', !!(await until(async () => (await tile(n.t3).count()) === 1 && (await tile(n.t1).count()) === 0, 5000)))
  await tile(n.t3).dragTo(strip)
  check("with a search on, a card dropped on a collapsed column still goes to its true top", !!(await until(async () => (await saved('hold')).join() === [n.t3, n.hold].join(), 5000)), (await saved('hold')).join())
  await search.fill('')
  await expand('On Hold')
  await inv('tasks:update', n.t3, { column: 'todo', position: 'bottom' })

  // Cards fold to one line, and back.
  const fold = (x, name) => tile(x).getByRole('button', { name })
  const height = (x) => tile(x).evaluate((e) => e.getBoundingClientRect().height)
  const tall = await height(n.t1)
  await fold(n.t1, `Collapse ${await lib.cardLabel(inv, n.t1)} to one line`).click()
  check('a card folds to one line', !!(await until(async () => (await tile(n.t1).getAttribute('class')).includes('folded'), 5000)) && (await height(n.t1)) < tall && (await height(n.t1)) < 34, `${tall} → ${await height(n.t1)}`)
  const line = await tile(n.t1).evaluate((e) => {
    const t = e.querySelector('.task-title')
    return { cut: t.scrollWidth > t.clientWidth, text: e.innerText }
  })
  check('folded, it shows its key and its title cut short', line.cut && line.text.includes(await lib.cardLabel(inv, n.t1)), JSON.stringify(line))
  // Escape a moment after a card opens closes it and asks nothing (#288): the card's first render used to take its
  // fields, not filled in yet, for edits, and its Escape listener kept that render's view until the next one's effects
  // ran: an Escape in between asked "Discard unsaved changes?". A microtask or a timer after the click was enough, and
  // on a busy machine the suite's own Escape landed there. Each time on a fresh page: only a dialog's first opening
  // starts with no fields.
  const discard = page.locator('.dialog[aria-label="Discard unsaved changes?"]')
  for (const after of ['a microtask', 'a timer']) {
    await page.reload()
    await lib.appReady(page)
    // Not shown within 3 s, the board is opened by its button; then the wait for its card, bounded.
    if (!(await until(async () => (await tile(n.t1).count()) === 1, 3000))) await page.getByRole('button', { name: 'Task Board' }).click()
    await until(async () => (await tile(n.t1).count()) === 1, 10000)
    await tile(n.t1).evaluate(async (el, timer) => {
      el.click()
      await (timer ? new Promise((r) => setTimeout(r, 0)) : Promise.resolve())
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }, after === 'a timer')
    const closed = await until(async () => (await page.locator('.dialog').count()) === 0 || (await discard.count()) === 1, HUNG_MS)
    check(`Escape ${after} after a card opens closes it, asking nothing`, !!closed && (await discard.count()) === 0, `discard asked: ${await discard.count()}`)
    if (await discard.count()) await discard.getByRole('button', { name: 'Discard' }).click()
  }
  await tile(n.t1).click()
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, n.t1))
  check('clicking a folded card still opens it', !!(await until(async () => (await dialog.count()) === 1, 5000)))
  await page.keyboard.press('Escape')
  check('…and Escape closes it, asking nothing', !!(await until(async () => (await dialog.count()) === 0, 5000)) && (await discard.count()) === 0)
  await fold(n.t2, `Collapse ${await lib.cardLabel(inv, n.t2)} to one line`).click()
  check('a folded blocked card keeps its marker', !!(await until(async () => (await tile(n.t2).locator('.task-flag.blocked').count()) === 1, 5000)))
  await fold(n.t1, `Expand ${await lib.cardLabel(inv, n.t1)}`).click()
  check('and unfolds', !!(await until(async () => !(await tile(n.t1).getAttribute('class')).includes('folded'), 5000)))

  // A folded card drags like any other, and stays folded in its new column.
  await tile(n.t2).dragTo(column('Active').locator('.board-column-body'))
  const toDoing = page.locator('.dialog', { hasText: `Move ${await lib.cardLabel(inv, n.t2)} to Active` })
  if (await until(async () => (await toDoing.count()) === 1, 5000)) await toDoing.getByRole('button', { name: 'Move to Active' }).click()
  check('a folded card drags to another column and stays folded', !!(await until(async () => (await column('Active').locator(tile(n.t2)).count()) === 1, 5000)) && (await tile(n.t2).getAttribute('class')).includes('folded'))

  // Collapse all and Expand all from a column's menu.
  await column('Todo').getByRole('button', { name: 'Todo: more' }).click()
  await page.locator('.menu .menu-item', { hasText: 'Collapse All Cards' }).click()
  const todoTiles = column('Todo').locator('.task-card')
  check("Collapse All Cards folds every card in the column", !!(await until(async () => (await todoTiles.count()) > 0 && (await column('Todo').locator('.task-card.folded').count()) === (await todoTiles.count()), 5000)))
  check('other columns are left as they were', (await tile(n.review).getAttribute('class')).includes('folded') === false)

  // Kept for the workspace: Done collapsed, Todo's cards folded, after a reload and after a restart.
  await collapse('Done')
  const state = async () => ({
    collapsed: await page.locator('.board-column').evaluateAll((els) => els.filter((e) => e.classList.contains('collapsed')).map((e) => e.dataset.column)),
    folded: await page.locator('.task-card.folded').evaluateAll((els) => els.map((e) => Number(e.dataset.task)).sort((a, b) => a - b))
  })
  const before = await state()
  // Columns fold sideways (#276): « on an expanded column's header, » on a strip; cards keep ▾ / ▸ (Todo's are folded).
  const icons = (loc) => loc.locator('.codicon').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith('codicon-'))))
  const collapseButton = column('Review').getByRole('button', { name: 'Collapse Review' })
  check('an expanded column collapses with « (two left chevrons), still named "Collapse Review" and expanded', JSON.stringify(await icons(collapseButton)) === JSON.stringify(['codicon-chevron-left', 'codicon-chevron-left']) && (await collapseButton.getAttribute('aria-expanded')) === 'true', JSON.stringify(await icons(collapseButton)))
  const doneStrip = column('Done').getByRole('button', { name: 'Expand Done' })
  check('a strip expands with » (two right chevrons)', JSON.stringify(await icons(doneStrip)) === JSON.stringify(['codicon-chevron-right', 'codicon-chevron-right']), JSON.stringify(await icons(doneStrip)))
  check("cards keep ▸ when folded and ▾ when not", JSON.stringify(await icons(tile(n.t1).locator('.task-fold'))) === JSON.stringify(['codicon-chevron-right']) && JSON.stringify(await icons(tile(n.review).locator('.task-fold'))) === JSON.stringify(['codicon-chevron-down']))
  const chevronsFit = await collapseButton.evaluate((b) => {
    const r = b.getBoundingClientRect()
    return [...b.querySelectorAll('.codicon')].every((i) => {
      const c = i.getBoundingClientRect()
      return c.left >= r.left - 0.5 && c.right <= r.right + 0.5
    })
  })
  check('the « sits inside its button', chevronsFit)
  await page.screenshot({ path: path.join(lib.WORK, 'boardfold-dark.png') })
  await page.locator('.board').screenshot({ path: path.join(lib.WORK, 'boardfold-arrows-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await lib.sleep(200)
  await page.screenshot({ path: path.join(lib.WORK, 'boardfold-light.png') })
  await page.locator('.board').screenshot({ path: path.join(lib.WORK, 'boardfold-arrows-light.png') })
  const stripColour = await column('Done').locator('.board-column-strip .board-column-label').evaluate((e) => getComputedStyle(e).color)
  check('a strip reads in the light theme too', stripColour !== 'rgba(0, 0, 0, 0)', stripColour)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.reload()
  await lib.appReady(page)
  await page.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
  await until(async () => (await page.locator('.board-column').count()) === 6, 10000)
  await until(async () => JSON.stringify(await state()) === JSON.stringify(before), 10000)
  check('after a reload, the same columns are collapsed and the same cards folded', JSON.stringify(await state()) === JSON.stringify(before), JSON.stringify([before, await state()]))
  await app.close()
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 800 })
  await lib.appReady(page)
  inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  if (!(await inv('workspace:get'))?.path) await lib.openWorkspace(inv, page, ws)
  await page.getByRole('button', { name: 'Task Board' }).click()
  await until(async () => (await page.locator('.board-column').count()) === 6, 10000)
  await until(async () => JSON.stringify(await state()) === JSON.stringify(before), 10000)
  check('after a restart too', JSON.stringify(await state()) === JSON.stringify(before), JSON.stringify([before, await state()]))
  // In ui-state.json beside config.json since #1111, which no longer has it.
  const ui = JSON.parse(fs.readFileSync(path.join(userData, 'ui-state.json'), 'utf8')).boardFold ?? {}
  check('not in config.json', JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).ui?.boardFold === undefined)
  check("kept in Combwork's own settings for this workspace, not in the cards", Object.keys(ui).length === 1 && Object.keys(ui)[0] === ws.toLowerCase() && !Object.keys(lib.readCard(ws, n.t1)).some((k) => /fold|collapse/i.test(k)), JSON.stringify(ui))

  // --- Two windows, each with its own workspace, both open before either changes its board: A's change, then B's,
  // keep each other (a window saves a change on what is saved now, never the folds it read when it opened).
  await inv('window:new')
  await until(async () => app.windows().length === 2, 15000)
  const pageB = app.windows().find((w) => w !== page)
  pageB.on('pageerror', (e) => check('no page errors (second window)', false, e.message))
  await lib.appReady(pageB)
  const invB = (ch, ...a) => pageB.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(invB, pageB, wsB)
  const bCard = (await invB('tasks:create', { title: 'A card of workspace B', project: 'beta' })).number
  await pageB.getByRole('button', { name: 'Task Board' }).click()
  await until(async () => (await pageB.locator(`.task-card[data-task="${bCard}"]`).count()) === 1, 10000)
  // A: Approved collapsed and the Review card folded.
  await collapse('Approved')
  await fold(n.review, `Collapse ${await lib.cardLabel(inv, n.review)} to one line`).click()
  await until(async () => (await tile(n.review).getAttribute('class')).includes('folded'), 5000)
  const afterA = await state()
  // Then B, from its own (older) view of the folds.
  await pageB.getByRole('button', { name: 'Collapse On Hold' }).click()
  await pageB.locator(`.task-card[data-task="${bCard}"]`).getByRole('button', { name: `Collapse ${await lib.cardLabel(invB, bCard)} to one line` }).click()
  const savedBoth = await until(async () => {
    const f = (await inv('ui:get')).boardFold ?? {}
    return f[wsB.toLowerCase()]?.cards?.includes(bCard) && f
  }, 5000)
  const a = savedBoth?.[ws.toLowerCase()]
  const b = savedBoth?.[wsB.toLowerCase()]
  check("B's change keeps A's: both workspaces' columns and cards are saved", !!a && a.columns.join() === afterA.collapsed.join() && afterA.folded.every((x) => a.cards.includes(x)) && b?.columns?.join() === 'hold' && b?.cards?.join() === String(bCard), JSON.stringify({ afterA, savedBoth }))
  await page.reload()
  await lib.appReady(page)
  await page.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
  await until(async () => JSON.stringify(await state()) === JSON.stringify(afterA), 10000)
  check("A reloaded after B's change shows its own folds", JSON.stringify(await state()) === JSON.stringify(afterA), JSON.stringify([afterA, await state()]))
  await app.close()
  app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  await app.firstWindow()
  await until(async () => app.windows().length === 2, 20000)
  const byWorkspace = async (folder) => {
    for (const w of app.windows()) {
      await lib.appReady(w)
      if ((await w.evaluate(() => window.hive.invoke('workspace:get')))?.path?.toLowerCase() === folder.toLowerCase()) return w
    }
    return null
  }
  page = await byWorkspace(ws)
  const pageB2 = await byWorkspace(wsB)
  check('both windows come back after a restart, each with its workspace', !!page && !!pageB2)
  if (page && pageB2) {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await page.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
    await until(async () => JSON.stringify(await state()) === JSON.stringify(afterA), 10000)
    check("after a restart, A's folds are as A left them", JSON.stringify(await state()) === JSON.stringify(afterA), JSON.stringify([afterA, await state()]))
    await pageB2.getByRole('button', { name: 'Task Board' }).click().catch(() => undefined)
    const bState = () => pageB2.evaluate(() => ({ collapsed: [...document.querySelectorAll('.board-column.collapsed')].map((e) => e.dataset.column), folded: [...document.querySelectorAll('.task-card.folded')].map((e) => Number(e.dataset.task)) }))
    await until(async () => JSON.stringify(await bState()) === JSON.stringify({ collapsed: ['hold'], folded: [bCard] }), 10000)
    check("…and B's as B left them", JSON.stringify(await bState()) === JSON.stringify({ collapsed: ['hold'], folded: [bCard] }), JSON.stringify(await bState()))
  }

  await app.close()
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
