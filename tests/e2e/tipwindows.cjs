// What the tips know, from two windows (#266). Both windows start with the same saved state; window 1 then sees a tip
// (a second agent's moment) and window 2 runs a command. Each window used to save its whole copy of the state, so
// window 2's save dropped the tip window 1 had seen, and it showed again after a restart. Now each change is applied
// in main: both are saved, and after a restart the next day's tip is the one neither window has seen. ui:set no longer
// writes the tips, and ui:changeTips refuses what isn't a change. Dev build, throwaway profile and workspaces, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'tipwindows-profile')
const wsA = path.join(lib.WORK, 'tipwindows-a')
const wsB = path.join(lib.WORK, 'tipwindows-b')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// The tips in the order they show, and the second agent's tip, from the source, with any spacing between an entry's
// fields (one written `'language',group` was missed, so never marked seen, and showed instead: #1337).
const src = fs.readFileSync(path.join(lib.ROOT, 'src', 'shared', 'tips.ts'), 'utf8')
const ORDER = [...src.matchAll(/\{\s*id: '([^']+)',\s*group: '[^']+',\s*order: (\d+)/g)].sort((a, b) => Number(a[2]) - Number(b[2])).map((m) => m[1])
const MOMENT = /'second-agent': '([^']+)'/.exec(src)?.[1]
// A title in English, or a message's English (#767): `title: msg({ id: '…', defaultMessage: '…'`.
const ENTRY = (id) => `\\{\\s*id: '${id}',\\s*group: '[^']+',\\s*order: \\d+,\\s*title: `
const TITLE = (id) =>
  new RegExp(`${ENTRY(id)}'([^']+)'`).exec(src)?.[1] ??
  new RegExp(`${ENTRY(id)}"([^"]+)"`).exec(src)?.[1] ??
  new RegExp(`${ENTRY(id)}msg\\(\\{ id: '[^']+', defaultMessage: (?:'([^']+)'|"([^"]+)")`).exec(src)?.slice(1).find(Boolean)

;(async () => {
  for (const d of [userData, wsA, wsB]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(beta, { recursive: true })
  lib.enableProviders(userData)
  // Tips on, today's tip already shown, and every tip seen but two: the second agent's, and the last one.
  const last = ORDER.filter((id) => id !== MOMENT).at(-1)
  check('the tips are read from the source', ORDER.length >= 20 && !!MOMENT && !!last && !!TITLE(last), JSON.stringify({ n: ORDER.length, MOMENT, last, title: TITLE(last) }))
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, showTips: true }
  cfg.ui = { ...cfg.ui, tips: { seen: ORDER.filter((id) => id !== MOMENT && id !== last), shownOn: day, moments: [], used: [] } }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, wsA)
  // The second window starts before either change, so its copy of the state has neither.
  const next = app.waitForEvent('window')
  await inv('window:new')
  const page2 = await next
  await page2.waitForLoadState('domcontentloaded')
  await lib.appReady(page2)
  page2.on('pageerror', (e) => check('no page errors (window 2)', false, e.message))
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv2, page2, wsB)

  // Window 1: a second agent in alpha brings its tip, which is now seen.
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.addAgent(inv, alpha, { name: 'One' })
  await lib.addAgent(inv, alpha, { name: 'Two' })
  const card = page.locator('.tip-card')
  check("window 1 shows the second agent's tip", !!(await lib.until(async () => (await card.count()) === 1 && (await card.locator('.tip-title').innerText()) === TITLE(MOMENT), 8000)), await card.locator('.tip-title').innerText().catch(() => 'no card'))
  await card.getByRole('button', { name: 'Close' }).click()
  const seen = await lib.until(async () => ((await inv('ui:get')).tips?.seen ?? []).includes(MOMENT), 5000)
  check('…and it is saved as seen', !!seen)

  // Window 2, whose copy has neither, runs a command (every command run is noted for the tips).
  await page2.keyboard.press('Control+Shift+E')
  const both = await lib.until(async () => {
    const t = (await inv('ui:get')).tips ?? {}
    return t.used?.length && t.seen?.includes(MOMENT) && t.moments?.includes('second-agent') ? t : null
  }, 5000)
  const t = both ?? (await inv('ui:get')).tips
  check("window 2's command keeps what window 1 saw: the tip, its moment and the command are all saved", !!both, JSON.stringify({ used: t?.used, seenMoment: t?.seen?.includes(MOMENT), moments: t?.moments }))

  // ui:set leaves the tips alone; ui:changeTips refuses what isn't a change.
  await inv2('ui:set', { tips: { seen: [], moments: [], used: [] }, sidebarCompact: false })
  const after = (await inv('ui:get')).tips
  check('ui:set leaves the tips alone', after?.seen?.includes(MOMENT) && after.used?.length > 0, JSON.stringify(after))
  const refused = await inv('ui:changeTips', { seen: 'x', used: 'y' }).then(() => 'saved', (e) => String(e))
  const refusedMoment = await inv('ui:changeTips', { moment: 'toString' }).then(() => 'saved', (e) => String(e))
  check('a value that is not a change is refused', /Not a tips change/.test(refused) && /Not a tips change/.test(refusedMoment), `${refused}; ${refusedMoment}`)

  // After a restart (and a day later), the day's tip is the last one: the only one neither window has seen.
  await app.close()
  ;({ app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 900 } }))
  page.on('pageerror', (e) => check('no page errors (restarted)', false, e.message))
  for (const w of app.windows().slice(1)) await w.close().catch(() => undefined)
  const kept = (await inv('ui:get')).tips
  check('restarted: the tip seen in window 1 is still seen', kept?.seen?.includes(MOMENT) && kept.used?.length > 0, JSON.stringify(kept))
  await inv('ui:changeTips', { shownOn: '2000-01-01' })
  await page.reload()
  await lib.appReady(page)
  const card2 = page.locator('.tip-card')
  const shown = await lib.until(async () => ((await card2.count()) === 1 ? await card2.locator('.tip-title').innerText() : null), 10000)
  check("restarted, the next day: the tip shown is the one not yet seen, not window 1's again", shown === TITLE(last), String(shown))
  await page.screenshot({ path: path.join(lib.WORK, 'tipwindows-restarted.png') })

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
