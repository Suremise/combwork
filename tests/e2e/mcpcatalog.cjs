// MCP catalogues (HI-545), in the window, from file:// catalogues on a throwaway share (no network: ours is off). The MCP
// view's Catalogue lists each source as a category with the one-time note for a source Combwork doesn't check; search and
// the filter narrow it; a server's view shows its requirements checked; Install shows what it runs first and adds it
// to the workspace added nowhere, its view opening for Add to…. A newer version is offered only after ↻ (the
// catalogues aren't read otherwise), and Update says what changes and keeps the places it is added. Settings → MCP
// Catalogues adds a source. Screenshots of the Catalogue, a server's view, the Install dialog and Settings → MCP
// Catalogues in both themes (mcpcatalog-*.png in the run's folder). Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')
const { zipSync, strToU8 } = require('fflate')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'mcpcatalog-profile')
const ws = path.join(lib.WORK, 'mcpcatalog-ws')
const proj = path.join(ws, 'demo')
const share = path.join(lib.WORK, 'mcpcatalog-share')
const share2 = path.join(lib.WORK, 'mcpcatalog-share2')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Publishes demo at `version` (running `script`) and a server only macOS can run, as a file:// catalogue in `dir`. */
function publish(dir, version, script, name = 'Test catalogue') {
  fs.mkdirSync(dir, { recursive: true })
  const def = { description: 'A demo server', command: 'node', args: [`\${CW_MCP_DIR}/demo/${script}`] }
  const zip = zipSync({ 'demo/combwork-mcp.json': strToU8(JSON.stringify(def)), [`demo/${script}`]: strToU8(`// demo ${version}`) })
  const zipFile = path.join(dir, `demo-${version}.zip`)
  fs.writeFileSync(zipFile, zip)
  const z = { url: pathToFileURL(zipFile).href, sha256: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length }
  const server = (n, os, description) => ({ name: n, version, description, tags: ['demo'], requires: { os }, zip: z })
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 1, name, servers: [server('demo', ['windows', 'macos', 'linux'], 'A demo server for tests'), server('mac-only', ['macos'], 'Runs on macOS only')] }))
  return pathToFileURL(path.join(dir, 'catalog.json')).href
}

;(async () => {
  for (const d of [userData, ws, share, share2]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(path.join(proj, '.combwork'), { recursive: true })
  fs.mkdirSync(path.join(ws, '.combwork', 'mcp'), { recursive: true })
  const source = publish(share, '1.0.0', 'server.js')
  const env = lib.fakeClaude(userData, path.join(lib.WORK, 'mcpcatalog-claude-home'), [proj])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.mcpCatalogs = { oursOn: false, sources: [{ url: source, on: true }] }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  const { app, page, inv } = await lib.launch({ userData, env })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.openWorkspace(inv, page, ws)
    const shots = async (name) => {
      for (const theme of ['dark', 'light']) {
        await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
        await page.mouse.move(5, 5)
        await page.screenshot({ path: path.join(lib.WORK, `mcpcatalog-${name}-${theme}.png`) })
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    }
    // Installed as demo-cat: a local demo has the name (the clash below).
    const installed = () => JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'mcp', 'demo-cat.json'), 'utf8'))
    const cfgNow = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).settings.mcpCatalogs

    // --- The Catalogue: a category per source, the one-time note, search and filter.
    await page.keyboard.press('Control+Shift+M')
    await page.locator('[data-mcp-tab="catalogue"]').click()
    const row = (n) => page.locator(`.sidebar [data-catalog-server="${n}"]`)
    check('the Catalogue lists the source as a category with its servers', !!(await lib.until(async () => (await row('demo').count()) === 1 && (await row('mac-only').count()) === 1, HUNG_MS)) && (await page.locator('.sidebar .section-header', { hasText: 'Test catalogue' }).count()) === 1)
    check("…with the note that Combwork doesn't check its servers", (await page.locator('[data-catalog-unvetted]').count()) === 1)
    check('…said once: remembered in Combwork\'s settings', !!(await lib.until(async () => cfgNow().sources[0].noted === true, HUNG_MS)), JSON.stringify(cfgNow()))
    check("mac-only says it can't run here", (await row('mac-only').innerText()).includes("Can't run here"))
    await page.locator('[data-catalog-filter]').selectOption('meets')
    check('Runs on this PC hides mac-only', !!(await lib.until(async () => (await row('mac-only').count()) === 0 && (await row('demo').count()) === 1, HUNG_MS)))
    await page.locator('[data-catalog-filter]').selectOption('all')
    await page.locator('[data-catalog-search]').fill('macos')
    check('searching "macos" finds mac-only only', !!(await lib.until(async () => (await row('demo').count()) === 0 && (await row('mac-only').count()) === 1, HUNG_MS)))
    await page.locator('[data-catalog-search]').fill('')
    await lib.until(async () => (await row('demo').count()) === 1, HUNG_MS)

    // --- A server's view: its requirements checked, Install (a local server named demo is there already).
    await inv('mcp:create', 'demo')
    await row('demo').click()
    const detail = page.locator('[data-catalog-detail="demo"]')
    check("demo's view shows its requirement met", !!(await lib.until(async () => (await detail.locator('[data-check="ok"]').count()) === 1, HUNG_MS)), await detail.innerText().catch(() => ''))
    await shots('catalogue')
    await detail.locator('[data-action="catalog-install"]').click()
    const ask = page.getByRole('dialog', { name: 'Install demo 1.0.0?' })
    check('Install shows what it runs first, and its name', !!(await lib.until(async () => (await ask.count()) === 1, HUNG_MS)) && (await ask.innerText()).includes('Runs: node ${CW_MCP_DIR}/demo/server.js') && (await ask.locator('input').inputValue()) === 'demo', JSON.stringify(await page.getByRole('dialog').allInnerTexts()))
    await shots('install')
    await ask.getByRole('button', { name: 'Install', exact: true }).click()
    // The name is taken: Replace, or choose another (#550's Add).
    const clash = page.getByRole('dialog', { name: 'Replace demo?' })
    check('the name in use asks to replace it or choose another', !!(await lib.until(async () => (await clash.count()) === 1, HUNG_MS)))
    await clash.getByRole('button', { name: 'Choose Another Name' }).click()
    await lib.until(async () => (await ask.count()) === 1, HUNG_MS)
    await ask.locator('input').fill('demo-cat')
    await ask.getByRole('button', { name: 'Install', exact: true }).click()
    check('installed under the other name, with where it came from; the local demo untouched', !!(await lib.until(async () => fs.existsSync(path.join(ws, '.combwork', 'mcp', 'demo-cat.json')) && installed().catalog?.version === '1.0.0', HUNG_MS)) && fs.existsSync(path.join(ws, '.combwork', 'mcp', 'demo-cat', 'server.js')) && !JSON.parse(fs.readFileSync(path.join(ws, '.combwork', 'mcp', 'demo.json'), 'utf8')).catalog)
    const where = page.locator('.pane-body .row', { has: page.locator('.label', { hasText: /^demo-cat\s*$/ }) }).locator('.mcp-where')
    check('…its view opens on the Installed tab, added nowhere, with Add to…', !!(await lib.until(async () => (await where.innerText().catch(() => '')) === 'Not added anywhere' && (await page.locator('[data-action="mcp-places"]').count()) === 1, HUNG_MS)), await where.innerText().catch(() => ''))

    // --- Add it to demo, then a newer version: offered only after ↻; Update keeps demo.
    await page.locator('[data-action="mcp-places"]').click()
    const places = page.getByRole('dialog', { name: 'Add demo-cat to…' })
    await places.getByRole('group', { name: 'Projects to add it to' }).getByRole('checkbox', { name: 'demo', exact: true }).check()
    await places.getByRole('button', { name: 'Save', exact: true }).click()
    const projectMcp = () => JSON.parse(fs.readFileSync(path.join(proj, '.combwork', 'project.json'), 'utf8')).mcp
    check('added to demo', !!(await lib.until(async () => (projectMcp().enabled ?? []).includes('demo-cat'), HUNG_MS)), JSON.stringify(projectMcp()))
    // Opening the Catalogue reads the catalogues; a search afterwards doesn't.
    await page.locator('[data-mcp-tab="catalogue"]').click()
    await lib.until(async () => (await row('demo').innerText().catch(() => '')).includes('Installed'), HUNG_MS)
    publish(share, '1.1.0', 'server2.js')
    await page.locator('[data-catalog-search]').fill('demo')
    check('the newer version isn\'t read until ↻: a search still says Installed', !!(await lib.until(async () => (await row('demo').innerText().catch(() => '')).includes('Installed'), HUNG_MS)), await row('demo').innerText().catch(() => ''))
    await page.getByRole('button', { name: 'Refresh', exact: true }).first().click()
    check('…after ↻ it offers Update to 1.1.0', !!(await lib.until(async () => (await row('demo').innerText().catch(() => '')).includes('Update to 1.1.0'), HUNG_MS)), await row('demo').innerText().catch(() => ''))
    await row('demo').click()
    await page.locator('[data-action="catalog-update"]').click()
    const upd = page.getByRole('dialog', { name: 'Update demo from 1.0.0 to 1.1.0?' })
    check('Update says where it is added and what changes', !!(await lib.until(async () => (await upd.count()) === 1, HUNG_MS)) && (await upd.innerText()).includes('Added in demo') && (await upd.innerText()).includes('+ Runs: node ${CW_MCP_DIR}/demo-cat/server2.js'), await upd.innerText().catch(() => ''))
    await shots('update')
    await upd.getByRole('button', { name: 'Update', exact: true }).click()
    check('updated, and demo keeps it', !!(await lib.until(async () => installed().catalog?.version === '1.1.0', HUNG_MS)) && (projectMcp().enabled ?? []).includes('demo-cat') && String(installed().args?.[0]).includes('demo-cat/server2.js'), JSON.stringify([installed(), projectMcp()]))

    // --- Settings → MCP Catalogues adds a source; the Catalogue lists it after ↻.
    const second = publish(share2, '2.0.0', 'other.js', 'Second catalogue')
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav .row', { hasText: /^\s*MCP Catalogues\s*$/ }).click()
    const addBox = page.getByLabel("A catalogue's address")
    check('Settings → MCP Catalogues lists ours (off) and the source', !!(await lib.until(async () => (await addBox.count()) === 1, HUNG_MS)) && (await page.locator('[data-catalog-source="ours"]').getByRole('switch').getAttribute('aria-checked')) === 'false')
    await addBox.fill('http://example.com/catalog.json')
    await page.getByRole('button', { name: 'Add Catalogue' }).click()
    check('an http:// address is refused', !!(await lib.until(async () => (await page.locator('.mcp-catalog-sources .banner.danger').count()) === 1, HUNG_MS)) && cfgNow().sources.length === 1)
    await addBox.fill(second)
    await page.getByRole('button', { name: 'Add Catalogue' }).click()
    check('a file:// catalogue is added', !!(await lib.until(async () => cfgNow().sources.length === 2, HUNG_MS)), JSON.stringify(cfgNow()))
    await shots('settings')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+M')
    await page.locator('[data-catalog-search]').fill('')
    check('the Catalogue lists the second source as its own category', !!(await lib.until(async () => (await page.locator('.sidebar .section-header', { hasText: 'Second catalogue' }).count()) === 1, HUNG_MS)))
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
