// Performance → Provider usage (#241): deliberate lines, never random wrapping. A fake Claude Code session (still
// running, with an estimated cost) gives a row; at a wide and a narrow window, at 100% and 125% zoom, in both themes:
// the Provider and Cost cells are one line ("≈ $…" never split), Sessions and Context at most two (the value, then
// "1 running" / "… max of …"), each line unwrapped; a narrow table scrolls inside its section. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR; quiet.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'perftable-profile')
const ws = path.join(lib.WORK, 'perftable-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claude = lib.fakeClaude(userData, path.join(lib.WORK, 'perftable-claude-home'), [alpha])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47935), ...claude })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  // A price for the fake model, so the cost is Combwork's estimate: "≈ $…".
  await inv('settings:setProviderPrices', 'claude-code', { 'claude-fake': { input: 1000, cachedInput: 100, cacheWrite: 1000, output: 1000 } })
  await lib.openWorkspace(inv, page, ws)
  const agent = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await inv('session:start', alpha, { agentId: agent.id })
  const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id)
  await lib.until(async () => (await live())?.status === 'ready', 15000)
  await lib.sendPrompt(inv, lib.ptyKey(alpha, agent.id), 'hello', { submitted: async () => ['working', 'finished'].includes((await live())?.status) })
  await lib.until(async () => (await live())?.status === 'finished', 15000)

  await page.locator('.activitybar button[aria-label="Performance"]').click()
  const row = page.locator('.performance-page:visible .table-wrap .table:has(th .th-sort:text-is("Sessions")) tbody tr', { hasText: 'Claude Code' }).first()
  check('Provider usage has the session’s row', !!(await lib.until(async () => (await row.count()) === 1, 15000)))

  /** Each cell's lines: how many lines of text each of its parts takes, and whether the table scrolls. */
  const measure = () =>
    row.evaluate((tr) => {
      const head = [...tr.closest('table').querySelectorAll('thead th')].map((th) => th.textContent.trim().toLowerCase())
      const cell = (name) => tr.children[head.findIndex((h) => h.startsWith(name))]
      // Lines a node's text takes: its client rects, per line box.
      const lines = (el) => {
        if (!el) return 0
        const r = document.createRange()
        r.selectNodeContents(el)
        const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)))
        return tops.size
      }
      // Where a node's first line of text starts.
      const top = (el) => {
        const r = document.createRange()
        r.selectNodeContents(el)
        return [...r.getClientRects()].find((x) => x.width > 0)?.top ?? null
      }
      const parts = (td) => [...(td.querySelectorAll('.cell-lines > span').length ? td.querySelectorAll('.cell-lines > span') : [td])].filter((s) => s.textContent.trim()).map((s) => ({ text: s.textContent.trim(), lines: lines(s), top: top(s) }))
      const wrap = tr.closest('.table-wrap')
      return {
        provider: parts(cell('provider')),
        sessions: parts(cell('sessions')),
        context: parts(cell('context')),
        cost: parts(cell('cost')),
        scrolls: wrap.scrollWidth > wrap.clientWidth + 1
      }
    })
  const oneLineEach = (ps) => ps.every((p) => p.lines === 1)
  const verify = async (label) => {
    const m = await measure()
    check(`${label}: Provider is one line`, m.provider.length === 1 && oneLineEach(m.provider), JSON.stringify(m.provider))
    check(`${label}: Cost is one line, "≈ $…" whole`, m.cost.length === 1 && oneLineEach(m.cost) && m.cost[0].text.startsWith('≈ $'), JSON.stringify(m.cost))
    check(`${label}: Sessions is the count, then "1 running"`, m.sessions.length === 2 && oneLineEach(m.sessions) && m.sessions[1].text === '1 running', JSON.stringify(m.sessions))
    check(`${label}: Context is "… avg", then "… max"`, m.context.length <= 2 && oneLineEach(m.context) && (m.context[0]?.text ?? '').endsWith(' avg') && / max/.test(m.context[1]?.text ?? ''), JSON.stringify(m.context))
    // The row's values on one line: a two-line cell's first line level with the one-line cells.
    const tops = [m.provider, m.sessions, m.context, m.cost].map((ps) => ps[0]?.top ?? NaN)
    check(`${label}: every value on the row's first line`, Math.max(...tops) - Math.min(...tops) <= 1.5, JSON.stringify(tops))
    return m
  }
  await verify('wide')
  await page.screenshot({ path: path.join(lib.WORK, 'perftable-wide.png') })
  // Narrow: the table scrolls in its section rather than breaking cells.
  await page.setViewportSize({ width: 820, height: 900 })
  await lib.sleep(400)
  await row.scrollIntoViewIfNeeded()
  const narrow = await verify('narrow')
  check('narrow: the table scrolls inside its section instead', narrow.scrolls)
  await page.screenshot({ path: path.join(lib.WORK, 'perftable-narrow.png') })
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(300)
  await page.screenshot({ path: path.join(lib.WORK, 'perftable-narrow-light.png') })
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
  await lib.sleep(400)
  await verify('125%')
  await page.screenshot({ path: path.join(lib.WORK, 'perftable-125.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  // The Workspace Overview's table by project, narrow: "≈ $…" one line, the table scrolling in its section instead.
  await page.keyboard.press('Control+Shift+O')
  const wsRow = page.locator('.ws-projects tbody tr', { hasText: 'alpha' })
  check('Workspace Overview: the project row', !!(await lib.until(async () => (await wsRow.count()) === 1, 10000)))
  await page.setViewportSize({ width: 620, height: 900 })
  await lib.sleep(400)
  await wsRow.scrollIntoViewIfNeeded()
  const ws1 = await wsRow.evaluate((tr) => {
    const head = [...tr.closest('table').querySelectorAll('thead th')].map((th) => th.textContent.trim().toLowerCase())
    const td = tr.children[head.findIndex((h) => h.startsWith('cost'))]
    const r = document.createRange()
    r.selectNodeContents(td)
    const wrap = tr.closest('.table-wrap')
    return { text: td.textContent, lines: new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size, inWrap: !!wrap, scrolls: !!wrap && wrap.scrollWidth > wrap.clientWidth + 1 }
  })
  check('…its cost "≈ $…" on one line', ws1.text.startsWith('≈ $') && ws1.lines === 1, JSON.stringify(ws1))
  check('…the table in a scrolling section', ws1.inWrap, JSON.stringify(ws1))
  await page.screenshot({ path: path.join(lib.WORK, 'perftable-wsoverview.png') })

  await inv('session:stop', alpha, agent.id)
  await app.close()
  if (failed) console.log(`${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
