// A pane made again while its CLI runs (HI-3252): its view replays the terminal from the main process, and once the
// output has outgrown the kept raw output (512 KiB) that starts with a snapshot of the terminal. On a fake Claude Code
// session (fake-claude/, logging each read of its input), so nothing signs in or spends tokens.
// 1. Classic: a reloaded window shows the CLI's screen on the normal buffer, no mouse reporting.
// 2. Full screen: "fullscreen 300" switches to the alternate screen, turns mouse reporting (SGR) and bracketed paste on and
//    draws a header once, then 300 frames updating the rows under it (about 600 KB from the pseudoconsole). Switched away and back, then the window reloaded, the
//    pane is on the alternate screen with the header and the latest update, mouse reporting and bracketed paste on; a
//    wheel turn reaches the CLI as an SGR mouse report, a paste in brackets, and typing as typed.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'terminalreplay-profile')
const ws = path.join(lib.WORK, 'terminalreplay-ws')
const claudeHome = path.join(lib.WORK, 'terminalreplay-claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, beta])
  lib.logFakeInput(claudeHome)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)

    const def = await lib.addAgent(inv, alpha, { name: 'Tester' })
    await lib.addAgent(inv, beta, { name: 'Other' })
    const showAlpha = () => page.getByText('alpha', { exact: true }).first().click()
    await showAlpha()
    const key = lib.ptyKey(alpha, def.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === def.id)
    await inv('session:start', alpha, { agentId: def.id })
    check('the fake Claude Code is ready', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)), JSON.stringify(await live().then((l) => l && { status: l.status })))

    const state = () => page.evaluate((k) => window.__cwTerminalState(k), key)
    const lines = async () => (await page.evaluate((k) => window.__cwTerminalLines(k), key)) ?? []
    const shows = async (text) => (await lines()).some((l) => l.includes(text))
    const inputLog = path.join(claudeHome, 'fake-input.jsonl')
    const readsOfInput = () => (fs.existsSync(inputLog) ? fs.readFileSync(inputLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).data) : [])
    const inputSince = (from) => readsOfInput().slice(from).join('')
    /** The window reloaded: the pane is made again and replays its terminal; true once it is there. */
    const reload = async () => {
      await page.reload()
      await lib.appReady(page)
      await showAlpha()
      return !!(await lib.until(async () => (await state()) && (await lines()).some((l) => l.trim()), HUNG_MS, 200))
    }

    // ---- 1. Classic: the normal screen, as the CLI drew it.
    const before = (await lines()).filter((l) => l.trim()).at(-1)?.trim()
    check('reloaded, the classic pane is made again', await reload())
    check('…on the normal screen, with no mouse reporting', !!(await lib.until(async () => (await state())?.buffer === 'normal' && (await state())?.mouse === 'none', HUNG_MS, 200)), JSON.stringify(await state()))
    check('…showing what the CLI drew', !!before && !!(await lib.until(() => shows(before), HUNG_MS, 200)), JSON.stringify({ before, lines: await lines() }))

    // ---- 2. Full screen, past the kept raw output.
    await inv('pty:write', key, 'fullscreen 300')
    await lib.until(async () => readsOfInput().join('').includes('fullscreen 300'), HUNG_MS, 100)
    await inv('pty:write', key, '\r')
    const LAST = /frame (\d+)/
    const lastFrame = async () => (await lines()).map((l) => LAST.exec(l)?.[1]).find(Boolean)
    check('the CLI draws full screen', !!(await lib.until(async () => (await state())?.buffer === 'alternate' && (await shows('FULLSCREEN HEADER')), HUNG_MS, 200)), JSON.stringify(await state()))
    check('…and its turn ends', !!(await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), HUNG_MS, 200)))
    const frame = await lib.until(async () => {
      const f = await lastFrame()
      return f && f === (await lastFrame()) ? f : null
    }, HUNG_MS, 300)
    check('…its last update shown', !!frame, JSON.stringify(await lines()))
    const buffer = await inv('pty:buffer', key)
    // The pseudoconsole's title at the launch (OSC 0) is in the raw output only: gone, the output has outgrown what is kept.
    check("the kept output no longer has the launch's start", !buffer.includes('\x1b]0;'), JSON.stringify(buffer.slice(0, 300)))
    check('…and the replay has the header and the alternate screen from its snapshot', buffer.includes('FULLSCREEN HEADER') && buffer.includes('\x1b[?1049h'), JSON.stringify(buffer.slice(0, 300)))

    /** The pane as it should be after the CLI's full-screen drawing. */
    const restored = async (when) => {
      check(`${when}: on the alternate screen, mouse reporting and bracketed paste on`, !!(await lib.until(async () => {
        const s = await state()
        return s?.buffer === 'alternate' && s.mouse === 'vt200' && s.paste
      }, HUNG_MS, 200)), JSON.stringify(await state()))
      check(`${when}: the header drawn once, and the latest update`, !!(await lib.until(async () => (await shows('FULLSCREEN HEADER')) && (await lastFrame()) === frame, HUNG_MS, 200)), JSON.stringify(await lines()))
    }
    await page.getByText('beta', { exact: true }).first().click()
    await showAlpha()
    await restored('switched away and back')
    check('reloaded, the full-screen pane is made again', await reload())
    await restored('reloaded')
    await page.screenshot({ path: path.join(lib.WORK, 'terminalreplay-reloaded.png') })

    // Input after the reload: the CLI still has mouse reporting (SGR) and bracketed paste on, and the pane sends as it expects.
    const host = page.locator(`.terminal-host[data-pty="${key.replace(/\\/g, '\\\\')}"] .xterm-screen`)
    const box = await host.boundingBox()
    let from = readsOfInput().length
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -200)
    check('a wheel turn reaches the CLI as an SGR mouse report', !!(await lib.until(async () => /\x1b\[<6[45];\d+;\d+M/.test(inputSince(from)), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    // The clipboard, stubbed (as terminalinput): never the real one.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'pasted words', writeText: async () => undefined } }))
    await host.click()
    from = readsOfInput().length
    await page.keyboard.press('Control+V')
    check('a paste reaches the CLI in brackets', !!(await lib.until(async () => inputSince(from).includes('\x1b[200~pasted words\x1b[201~'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    from = readsOfInput().length
    await page.keyboard.type('typed')
    check('typing reaches the CLI as typed', !!(await lib.until(async () => inputSince(from).includes('typed'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
