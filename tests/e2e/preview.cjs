// The Preview runner in the app (HI-3614, design HI-3597 s16 §E, SPEC §16.21): a test Combwork runs Node stand-ins for dev
// servers through its process supervisor, on ports from its dev build's range, through the window's IPC (as the Preview tab
// will) and Project Settings → Preview:
// 4. Off (the default): every preview: call is refused, and Project Settings has no Preview section. Turned on, it has
//    one, suggesting package.json's dev script for the user to take (nothing saved until Save, screenshot).
// 1. Cross-project: alpha and beta started at the same time get different ports from 46000–46999, each answering.
// 2. Collision and the wrong server: a stranger on the next port makes it pick another; a stranger on every port of the
//    range fails the start naming the range; a server ignoring PORT fails naming the port it listens on; a server that
//    exits, then a stranger taking its port, leaves it Stopped (its address gone), and a new start gets another port.
// 3. Identity: clean, the source is the commit alone; an edit gives a content id (and the running preview notes the
//    change), the revert the commit alone again; a preview in a slot under its lease stops when the lease ends, and the
//    slot's next lease gets a new one.
// 4. Turned off again: the running preview is stopped (its server gone, its port free), and the section goes.
// Dev build, throwaway profile and workspace (no agent is started). Ports: the dev build's range, a stranger's at random
// in it as the test finds them free; the all-taken case moves the range to 52000–52999 for its step.
const lib = require('./lib.cjs')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47939))
const fx = q.queueProject('preview')
const beta = path.join(fx.ws, 'beta')
const HUNG_MS = lib.timing('hang.step')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

/** What a page at the address says (null: nothing answered). */
const fetchText = (url) =>
  new Promise((res) => {
    const r = http.get(url, (m) => {
      let b = ''
      m.on('data', (d) => (b += d))
      m.on('end', () => res(b))
    })
    r.on('error', () => res(null))
    r.setTimeout(HUNG_MS, () => r.destroy())
  })

const strangers = []
/** Listens on a port as another program would; null when it can't (someone holds it already). */
const stranger = (port) =>
  new Promise((res) => {
    const s = net.createServer((c) => c.end())
    s.once('error', () => res(null))
    s.listen(port, '127.0.0.1', () => {
      strangers.push(s)
      res(s)
    })
  })
const closeAll = async (list) => Promise.all(list.splice(0).map((s) => new Promise((r) => s.close(() => r()))))
/** Whether a port can be bound on 127.0.0.1 now. */
const free = (port) =>
  new Promise((res) => {
    const s = net.createServer()
    s.once('error', () => res(false))
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => res(true)))
  })

;(async () => {
  q.prepare(fx)
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
  // The stand-in: an HTTP server on PORT (`port`), or on a port of its own (`fixed <n>`), or on PORT until a file appears (`exitOn <file>`).
  const server = path.join(fx.tools, 'server.js')
  fs.writeFileSync(
    server,
    [
      "const http = require('http'), fs = require('fs')",
      'const [mode, arg] = process.argv.slice(2)',
      "const port = mode === 'fixed' ? Number(arg) : Number(process.env.PORT)",
      "http.createServer((q, r) => r.end('preview ' + process.env.PORT + ' ' + process.env.CW_PREVIEW_PORT)).listen(port, '127.0.0.1')",
      "setInterval(() => { if (mode === 'exitOn' && fs.existsSync(arg)) process.exit(0) }, 100)",
      ''
    ].join('\n')
  )
  const cmd = (...a) => `node "${server}" ${a.join(' ')}`
  // A package.json for the suggestion, committed (the project folder stays clean).
  fs.writeFileSync(path.join(fx.alpha, 'package.json'), JSON.stringify({ name: 'alpha', scripts: { start: 'node s.js', dev: 'vite' } }, null, 2) + '\n')
  lib.git(fx.alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'])
  lib.git(fx.alpha, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'package.json'])
  const h = await q.startCombwork(fx, { port: PORT, keepOptions: true })
  try {
    const { page, inv, app } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    const refusal = (p) => p.then(() => '', (e) => String(e?.message ?? e))
    const list = (p = fx.alpha) => inv('preview:list', p)
    const at = async (folder, p = fx.alpha) => (await list(p)).find((v) => v.place.folder.toLowerCase() === folder.toLowerCase())
    const command = (id) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('cw:event', ev), { type: 'menu-command', command: id, args: [] })
    const navRow = (text) => page.locator('.settings-nav .row', { hasText: text })
    const projects = (await inv('workspace:refresh')).projects.map((p) => p.path.toLowerCase())
    check('the workspace has alpha and beta', projects.includes(fx.alpha.toLowerCase()) && projects.includes(beta.toLowerCase()), JSON.stringify(projects))

    // --- Off (the default): nothing of it is reachable.
    const off = await refusal(list())
    check('off: preview:list is refused, saying the Preview is turned off', /Preview is turned off/.test(off), off)
    check('off: …and preview:start and preview:setConfig too', /turned off/.test(await refusal(inv('preview:start', fx.alpha))) && /turned off/.test(await refusal(inv('preview:setConfig', fx.alpha, { command: cmd('port') }))))
    check("off: project:updateConfig doesn't take a preview", /preview:setConfig/.test(await refusal(inv('project:updateConfig', fx.alpha, { preview: { command: 'x' } }))))
    await page.getByText('alpha', { exact: true }).first().click()
    await command('project.tab.settings')
    check('off: Project Settings shows its sections, with no Preview', !!(await until(async () => (await navRow('Sessions').count()) > 0, HUNG_MS)) && (await navRow('Preview').count()) === 0)

    // --- On: Project Settings → Preview, its suggestion taken only by the user's click, saved only by Save.
    await inv('advanced:set', 'cw.preview.enabled', true)
    await inv('advanced:set', 'cw.preview.startSeconds', 5)
    check('on: Project Settings has a Preview section', !!(await until(async () => (await navRow('Preview').count()) === 1, HUNG_MS)))
    await navRow('Preview').click()
    const box = page.locator('[data-setting="preview"]')
    const suggestion = box.locator('[data-preview="suggestion"]')
    check("…suggesting package.json's dev script, run by npm", !!(await until(async () => (await suggestion.count()) === 1 && (await suggestion.innerText()).includes('npm run dev'), HUNG_MS)), await box.innerText().catch(() => ''))
    const address = box.locator('[data-preview="address"]')
    check('…and saying where the server must listen: a port from 46000–46999 in PORT', /46000.46999/.test(await address.innerText()) && (await address.innerText()).includes('PORT') && (await address.innerText()).includes('http://127.0.0.1:%PORT%/'), await address.innerText())
    await suggestion.locator('[data-action="use-suggestion"]').click()
    const commandBox = box.locator('input[data-field="command"]')
    const saved = async () => (await inv('workspace:refresh')).projects.find((p) => p.path.toLowerCase() === fx.alpha.toLowerCase())?.config.preview
    check('Use it fills the box, and nothing is saved yet', (await commandBox.inputValue()) === 'npm run dev' && (await saved()) === undefined)
    await page.mouse.move(5, 5)
    await page.locator('.settings').screenshot({ path: path.join(fx.shots, 'preview-1-settings.png') })
    await commandBox.fill(cmd('port'))
    await box.locator('[data-action="save-preview"]').click()
    check('Save saves the command', !!(await until(async () => (await saved())?.command === cmd('port'), HUNG_MS)), JSON.stringify(await saved()))
    check('a page path not from the root is refused', /page path/.test(await refusal(inv('preview:setConfig', fx.alpha, { command: cmd('port'), path: 'app' }))))
    await inv('preview:setConfig', beta, { command: cmd('port') })
    await command('project.tab.session')

    // --- 1. Cross-project: two projects at the same time, different ports, each its own server.
    const [a, b] = await Promise.all([inv('preview:start', fx.alpha), inv('preview:start', beta)])
    check('alpha and beta both run', a.state === 'running' && b.state === 'running', JSON.stringify([a.end, b.end]))
    check('…on different ports from the dev build’s range', a.port !== b.port && [a.port, b.port].every((p) => p >= 46000 && p <= 46999), JSON.stringify([a.port, b.port]))
    check('…each answering with its own PORT and CW_PREVIEW_PORT', (await fetchText(a.url)) === `preview ${a.port} ${a.port}` && (await fetchText(b.url)) === `preview ${b.port} ${b.port}`)
    check("…each in its project's list only", (await list()).every((v) => v.projectPath.toLowerCase() === fx.alpha.toLowerCase()) && (await list(beta)).length === 1)
    check('a second start of a running place gives the same preview', (await inv('preview:start', fx.alpha)).id === a.id)
    check('Stop stops both', (await inv('preview:stop', fx.alpha)) === true && (await inv('preview:stop', beta)) === true)
    check("…their servers gone, ports free", !!(await until(async () => (await free(a.port)) && (await free(b.port)), HUNG_MS)))
    check("…each kept as stopped, saying it was stopped", (await at(fx.alpha))?.state === 'stopped' && (await at(fx.alpha))?.end?.kind === 'stopped')

    // --- 2. A stranger on the next port: skipped.
    const taken = await stranger(a.port)
    const c = await inv('preview:start', fx.alpha)
    check('a stranger on the next port makes it pick another', !!taken && c.state === 'running' && c.port !== a.port && (await fetchText(c.url)) === `preview ${c.port} ${c.port}`, JSON.stringify([a.port, c.port, c.end]))
    await inv('preview:stop', fx.alpha)
    await closeAll(strangers)

    // --- 2. A server ignoring PORT: fails, naming the port it listens on.
    let own = 46500
    while (!(await free(own))) own++
    await inv('preview:setConfig', fx.alpha, { command: cmd('fixed', own) })
    const d = await inv('preview:start', fx.alpha)
    check('a server ignoring PORT fails, naming the port it listens on', d.state === 'stopped' && d.end?.kind === 'otherPort' && JSON.stringify(d.end.listening) === JSON.stringify([own]), JSON.stringify(d.end))
    check('…its tree ended: its own port is free again', !!(await until(() => free(own), HUNG_MS)))

    // --- 2. An exit, then a stranger on its port: Stopped, never the stranger's.
    const go = path.join(fx.tools, 'exit-now.txt')
    await inv('preview:setConfig', fx.alpha, { command: cmd('exitOn', `"${go}"`) })
    const e = await inv('preview:start', fx.alpha)
    check('a server that will exit runs first', e.state === 'running', JSON.stringify(e.end))
    fs.writeFileSync(go, 'go')
    check('…once it exits, the preview is stopped (exited)', !!(await until(async () => (await at(fx.alpha))?.end?.kind === 'exited', HUNG_MS)), JSON.stringify(await at(fx.alpha)))
    fs.rmSync(go)
    check('…its port free', !!(await until(() => free(e.port), HUNG_MS)))
    check('…a stranger takes it', !!(await stranger(e.port)))
    const after = await at(fx.alpha)
    check('…and the preview stays Stopped, with no address: nothing reattaches', after.id === e.id && after.state === 'stopped' && after.url === null)
    await inv('preview:setConfig', fx.alpha, { command: cmd('port') })
    const f = await inv('preview:start', fx.alpha)
    check('…a new start is a new preview on another port', f.state === 'running' && f.id !== e.id && f.port !== e.port, JSON.stringify([f.port, e.port]))
    await inv('preview:stop', fx.alpha)
    await closeAll(strangers)

    // --- 2. A stranger on every port of the range: "no free port", naming it.
    await inv('advanced:set', 'cw.preview.portRange', 52000)
    const hogs = []
    for (let p = 52000; p <= 52999; p++) {
      const s = await stranger(p)
      if (s) hogs.push(s)
    }
    const g = await inv('preview:start', fx.alpha)
    check('a stranger on every port fails the start, naming the range', g.state === 'stopped' && g.end?.kind === 'noFreePort' && g.end.first === 52000 && g.end.last === 52999, JSON.stringify(g.end))
    await closeAll(strangers)
    await inv('advanced:set', 'cw.preview.portRange', 45000)

    // --- 3. Identity: the source at start; an edit a content id; the revert the commit alone.
    const head = lib.git(fx.alpha, ['rev-parse', 'HEAD']).trim()
    const clean = await inv('preview:start', fx.alpha)
    check('clean: the source is the commit alone', clean.state === 'running' && clean.source.commit === head && clean.source.content === null, JSON.stringify(clean.source))
    fs.writeFileSync(path.join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    check('…an edit while it runs is noted (its files changed)', !!(await until(async () => !!(await at(fx.alpha))?.changedAt, HUNG_MS)))
    await inv('preview:stop', fx.alpha)
    const dirty = await inv('preview:start', fx.alpha)
    check('an edit: started again, the commit and a content id', dirty.source.commit === head && /^[0-9a-f]{40}$/.test(dirty.source.content ?? ''), JSON.stringify(dirty.source))
    await inv('preview:stop', fx.alpha)
    fs.writeFileSync(path.join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\n')
    const reverted = await inv('preview:start', fx.alpha)
    check('the revert: the commit alone again', reverted.source.commit === head && reverted.source.content === null, JSON.stringify(reverted.source))
    await inv('preview:stop', fx.alpha)

    // --- 3. A slot's preview stops with its lease; the slot's next lease gets a new one.
    const b1 = await lib.addAgent(inv, fx.alpha, { name: 'B1' })
    const op = (o) => inv('slots:test', fx.alpha, o)
    const lent = await op({ op: 'lend', agent: b1.id, card: 101 })
    check('B1 is lent a slot', lent.ok, JSON.stringify(lent))
    const folder = lent.slot.folder
    const inSlot = await inv('preview:start', fx.alpha, folder)
    check("a preview in the slot runs, under its lease", inSlot.state === 'running' && inSlot.place.kind === 'slot' && inSlot.place.generation === lent.lease.id, JSON.stringify([inSlot.place, inSlot.end]))
    await op({ op: 'release', lease: lent.lease.id, why: 'done' })
    check('…the lease ended: the preview is stopped (its place ended)', !!(await until(async () => (await at(folder))?.end?.kind === 'placeEnded', HUNG_MS)), JSON.stringify(await at(folder)))
    check('…its server gone', !!(await until(() => free(inSlot.port), HUNG_MS)))
    check('a slot no card holds is refused', /isn't lent/.test(await refusal(inv('preview:start', fx.alpha, folder))))
    const again = await op({ op: 'lend', agent: b1.id, card: 102 })
    const next = again.ok && again.slot.folder.toLowerCase() === folder.toLowerCase() ? await inv('preview:start', fx.alpha, folder) : null
    check("the slot's next lease gets a new preview, under it", !!next && next.state === 'running' && next.id !== inSlot.id && next.place.generation === again.lease.id, JSON.stringify([again.slot?.name, next?.place]))
    check('a folder that is no place of the project is refused', /isn't alpha's folder/.test(await refusal(inv('preview:start', fx.alpha, fx.tools))))

    // --- 4. Turned off again: what runs is stopped, and the section goes.
    await command('project.tab.settings')
    await inv('advanced:set', 'cw.preview.enabled', false)
    check('off again: the slot’s running preview is stopped, its port free', !!next && !!(await until(() => free(next.port), HUNG_MS)))
    check('…preview:list refused again', /turned off/.test(await refusal(list())))
    check('…and Project Settings has no Preview section', !!(await until(async () => (await navRow('Preview').count()) === 0, HUNG_MS)))
    if (again.ok) await op({ op: 'release', lease: again.lease.id, why: 'done' })
  } catch (e) {
    check('the run went through', false, e?.stack ?? String(e))
  } finally {
    await closeAll(strangers)
    await h.app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})()
