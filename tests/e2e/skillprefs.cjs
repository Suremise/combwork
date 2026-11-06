// Per-project view preferences from two windows (#245). Window 1 shows alpha's Skills tab on Codex with Combwork's skills
// folded; window 2 then shows beta's on Claude Code with its provider skills open. Each window keeps its own copy of the
// saved maps, and used to save its whole copy, so window 2's save replaced alpha's. Now each change is merged in main:
// both are saved, survive a restart, and show again. ui:set no longer writes these maps, and ui:setProjectPref refuses
// a value that isn't one. Dev build, throwaway profile and workspaces, quiet.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')

const userData = path.join(lib.WORK, 'skillprefs-profile')
const wsA = path.join(lib.WORK, 'skillprefs-a')
const wsB = path.join(lib.WORK, 'skillprefs-b')
const alpha = path.join(wsA, 'alpha')
const beta = path.join(wsB, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** A window's controls for a project's Skills tab. */
const skillsTab = async (page, name) => {
  await page.keyboard.press('Control+Shift+E')
  await page.getByText(name, { exact: true }).first().click()
  await lib.openMoreTab(page, 'Skills')
  const pick = page.locator('.skill-provider-pick select')
  await lib.until(async () => (await pick.count()) === 1, 10000)
  return { pick, combwork: page.locator('.skill-group-toggle', { hasText: 'Combwork' }).first(), provider: page.locator('.skill-provider-toggle') }
}

;(async () => {
  for (const d of [userData, wsA, wsB, path.join(lib.WORK, 'skillprefs-codex-home')]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(alpha, { recursive: true })
  fs.mkdirSync(beta, { recursive: true })
  lib.enableProviders(userData, ['claude-code', 'codex'])
  // Codex is listed from an empty home of the suite's own: never the user's ~/.codex, nor the shared test home.
  const codexHome = path.join(lib.WORK, 'skillprefs-codex-home')
  fs.mkdirSync(codexHome, { recursive: true })
  const env = { CODEX_HOME: codexHome, CW_API_PORT: lib.port(47934) }
  let { app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, wsA)
  // The second window starts before either change, so its copy of the maps has neither.
  const next = app.waitForEvent('window')
  await inv('window:new')
  const page2 = await next
  await page2.waitForLoadState('domcontentloaded')
  await lib.appReady(page2)
  page2.on('pageerror', (e) => check('no page errors (window 2)', false, e.message))
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv2, page2, wsB)

  const a = await skillsTab(page, 'alpha')
  await a.pick.selectOption('codex')
  await a.combwork.click()
  const b = await skillsTab(page2, 'beta')
  await b.provider.click()
  const [ka, kb] = [alpha.toLowerCase(), beta.toLowerCase()]
  const saved = await lib.until(async () => {
    const ui = await inv('ui:get')
    return ui.skillsFold?.[ka] && ui.skillsFold?.[kb] ? ui : null
  }, 5000)
  const ui = saved ?? (await inv('ui:get'))
  check("window 2's change keeps window 1's project: both providers saved", ui.skillsProvider?.[ka] === 'codex' && !(kb in (ui.skillsProvider ?? {})), JSON.stringify(ui.skillsProvider))
  check('…and both projects’ open groups', JSON.stringify(ui.skillsFold?.[ka]) === '{"combwork":false,"provider":false}' && JSON.stringify(ui.skillsFold?.[kb]) === '{"combwork":true,"provider":true}', JSON.stringify(ui.skillsFold))

  // The Sessions tree's branches go the same way; ui:set leaves the per-project maps alone; a wrong value is refused.
  await inv('ui:setProjectPref', 'sessionsTree', alpha, { 'provider:codex': false })
  await inv2('ui:setProjectPref', 'sessionsTree', beta, { 'provider:claude-code': true })
  await inv2('ui:set', { skillsProvider: {}, skillsFold: {}, sessionsTree: {}, sidebarCompact: false })
  const after = await inv('ui:get')
  check('Sessions tree branches of both projects are saved, and ui:set leaves the maps alone', after.sessionsTree?.[ka]?.['provider:codex'] === false && after.sessionsTree?.[kb]?.['provider:claude-code'] === true && after.skillsProvider?.[ka] === 'codex', JSON.stringify({ tree: after.sessionsTree, provider: after.skillsProvider }))
  const refused = await inv('ui:setProjectPref', 'skillsProvider', alpha, 'no-such-provider').then(() => 'saved', (e) => String(e))
  check('a value that is not one is refused', /Not a skillsProvider value/.test(refused) && (await inv('ui:get')).skillsProvider?.[ka] === 'codex', refused)
  const notPref = await inv('ui:setProjectPref', 'sidebarWidth', alpha, 1).then(() => 'saved', (e) => String(e))
  check('…and so is a preference that is not per project', /Not a project preference/.test(notPref), notPref)

  // After a restart, each project's Skills tab shows as it was left.
  await app.close()
  ;({ app, page, inv } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } }))
  page.on('pageerror', (e) => check('no page errors (restarted)', false, e.message))
  for (const w of app.windows().slice(1)) await w.close().catch(() => undefined)
  await lib.openWorkspace(inv, page, wsA)
  const a2 = await skillsTab(page, 'alpha')
  check('restarted: alpha shows Codex, Combwork’s skills folded', (await a2.pick.inputValue()) === 'codex' && (await a2.combwork.getAttribute('aria-expanded')) === 'false', JSON.stringify({ pick: await a2.pick.inputValue(), combwork: await a2.combwork.getAttribute('aria-expanded') }))
  await lib.openWorkspace(inv, page, wsB)
  const b2 = await skillsTab(page, 'beta')
  check('restarted: beta shows Claude Code, its skills open', (await b2.pick.inputValue()) === 'claude-code' && (await b2.provider.getAttribute('aria-expanded')) === 'true', JSON.stringify({ pick: await b2.pick.inputValue(), provider: await b2.provider.getAttribute('aria-expanded') }))
  await page.screenshot({ path: path.join(lib.WORK, 'skillprefs-restarted.png') })

  await app.close()
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
