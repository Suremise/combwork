// A project's Overview shows the board at a glance for its own cards, as the Workspace Overview does for all of
// them: the counts follow cards created, moved, edited, deleted and moved to another project without a reload, a
// project with no cards says so, switching projects never shows the previous one's counts, and each number opens
// the project's Tasks tab (the Workspace Overview's open the whole board). Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'taskoverview-profile')
const ws = path.join(lib.WORK, 'taskoverview-ws')
const [alpha, beta, gamma] = ['alpha', 'beta', 'gamma'].map((n) => path.join(ws, n))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 8000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
  return v
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [alpha, beta, gamma]) fs.mkdirSync(d, { recursive: true })
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47909) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1300, height: 800 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)

  // alpha: 2 Todo, 1 Doing, 1 Review. beta: 1 Todo (blocked), 2 Done. gamma: none. And a workspace card.
  const make = async (title, project, column, extra = {}) => (await inv('tasks:create', { title, project, column, agent: '', ...extra })).number
  const a1 = await make('A1', 'alpha', 'todo')
  await make('A2', 'alpha', 'todo')
  await make('A3', 'alpha', 'doing')
  await make('A4', 'alpha', 'review')
  const b1 = await make('B1', 'beta', 'todo')
  await inv('tasks:update', b1, { blocked: 'Waiting on a decision' })
  await make('B2', 'beta', 'done')
  await make('B3', 'beta', 'done')
  await make('W', '', 'todo')

  const strip = page.locator('.board-strip')
  /** The strip's numbers by label, e.g. { Todo: 2, Active: 1, … }, or its text when it has none. */
  const read = async () => {
    if (!(await strip.count())) return null
    const items = await strip.first().locator('.board-strip-item').allInnerTexts()
    const out = {}
    for (const t of items) {
      const m = /^(\d+)\s+(.+)$/.exec(t.trim())
      if (m) out[m[2]] = Number(m[1])
      else out.text = (await strip.first().innerText()).replace(/\s+/g, ' ').trim()
    }
    return out
  }
  const is = (want) => async () => {
    const got = await read()
    return got && Object.entries(want).every(([k, v]) => got[k] === v) ? got : null
  }
  const showOverview = async (name) => {
    await page.locator('.project-row', { hasText: name }).first().click()
    await page.locator('.tabs .tab', { hasText: 'Overview' }).click()
    await page.locator('.overview-head').first().waitFor({ timeout: 8000 })
  }

  // --- The Workspace Overview: every card.
  await page.getByRole('button', { name: 'Workspace Overview' }).click()
  check('the Workspace Overview counts every card', !!(await until(is({ Todo: 4, Active: 1, 'Waiting for review': 1, Done: 2, Blocked: 1 }), HUNG_MS)), JSON.stringify(await read()))

  // --- alpha's Overview: its cards only.
  await page.getByRole('button', { name: 'Projects' }).click()
  await showOverview('alpha')
  check("alpha's Overview counts only alpha's cards", !!(await until(is({ Todo: 2, Active: 1, 'Waiting for review': 1, Done: 0, Blocked: 0 }), HUNG_MS)), JSON.stringify(await read()))
  check('the strip is for alpha', (await strip.first().getAttribute('data-project')) === 'alpha')

  // --- Switching to beta never shows alpha's counts, not even for a moment.
  const seen = []
  const watching = (async () => {
    const t = Date.now()
    while (Date.now() - t < 1500) {
      const p = await strip.first().getAttribute('data-project').catch(() => null)
      const r = await read().catch(() => null)
      if (p && r) seen.push({ p, r })
      await lib.sleep(20)
    }
  })()
  await showOverview('beta')
  await watching
  check("beta's Overview counts only beta's cards", !!(await until(is({ Todo: 1, Active: 0, 'Waiting for review': 0, Done: 2, Blocked: 1 }), HUNG_MS)), JSON.stringify(await read()))
  check("after the switch, beta's strip never shows alpha's counts", seen.filter((x) => x.p === 'beta').every((x) => x.r.Todo === 1 && x.r.Done === 2), JSON.stringify(seen.slice(-3)))

  // --- gamma: no cards, a clear empty state.
  await showOverview('gamma')
  check('a project without cards says so', !!(await until(async () => /No cards for this project/.test((await read())?.text ?? ''), HUNG_MS)), JSON.stringify(await read()))

  // --- Live updates on beta's Overview: create, move, edit (block), delete, move to another project.
  await showOverview('beta')
  await until(is({ Todo: 1, Done: 2 }), HUNG_MS)
  const b4 = await make('B4', 'beta', 'todo')
  check('a new card counts at once', !!(await until(is({ Todo: 2 }), HUNG_MS)), JSON.stringify(await read()))
  await inv('tasks:update', b4, { column: 'review' })
  check('a moved card moves in the counts', !!(await until(is({ Todo: 1, 'Waiting for review': 1 }), HUNG_MS)), JSON.stringify(await read()))
  await inv('tasks:update', b4, { blocked: 'Needs input' })
  check('an edit (blocked) counts', !!(await until(is({ Blocked: 2 }), HUNG_MS)), JSON.stringify(await read()))
  await inv('tasks:update', b4, { project: 'alpha' })
  check('a card moved to another project leaves the counts', !!(await until(is({ 'Waiting for review': 0, Blocked: 1 }), HUNG_MS)), JSON.stringify(await read()))
  await inv('tasks:delete', b1)
  check('a deleted card leaves the counts', !!(await until(is({ Todo: 0, Blocked: 0, Done: 2 }), HUNG_MS)), JSON.stringify(await read()))
  await showOverview('alpha')
  check('the moved card counts on its new project', !!(await until(is({ Todo: 2, 'Waiting for review': 2 }), HUNG_MS)), JSON.stringify(await read()))
  await page.screenshot({ path: path.join(lib.WORK, 'taskoverview.png') })

  // --- A number opens the project's Tasks tab, scoped to it.
  await strip.first().locator('.board-strip-item', { hasText: 'Todo' }).click()
  check('a number opens the Tasks tab', !!(await until(async () => (await page.locator('.tabs .tab.active').innerText()).includes('Tasks'), HUNG_MS)))
  const titles = await until(async () => {
    const t = await page.locator('.board-view.in-tab .task-title').allInnerTexts()
    return t.length ? t : null
  }, HUNG_MS)
  check("…showing alpha's cards only", !!titles && titles.every((t) => /^A\d|^B4$/.test(t.trim())) && titles.includes('A1') && !titles.includes('W') && !titles.includes('B2'), JSON.stringify(titles))
  await inv('tasks:delete', a1)
  await showOverview('gamma')
  await strip.first().locator('.board-strip-item', { hasText: 'Open Tasks' }).click()
  check("the empty state's Open Tasks opens gamma's Tasks tab", !!(await until(async () => (await page.locator('.tabs .tab.active').innerText()).includes('Tasks'), HUNG_MS)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
