// Combwork's icon sizes don't change when an editor first loads Monaco's stylesheet (its Codicons base rule, the same as
// the one Combwork bundles, sets every icon to 16px). Each way Monaco first loads gets a fresh app: a Markdown preview
// colouring a code block, the Changes tab's diff editor, and the Files tab's source editor. The activity bar's icons
// stay 24px and other shell icons keep their sizes, before, while the editor shows and after leaving it, again and
// again, in both themes, and they scale with the UI zoom; Monaco's own icons keep theirs. Dev build, throwaway
// profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const ws = path.join(lib.WORK, 'icons-ws')
const demo = path.join(ws, 'demo')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = async (fn, ms = 15000) => {
  const t = Date.now()
  let v
  while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
  return v
}

/** Shell icons with a size of their own (app.css), and the size each should have. */
const SHELL = [
  ['.activitybar .activity-btn .codicon', '24px'],
  ['.statusbar .status-item .codicon', null],
  ['.tabs .tab .codicon', null],
  ['.project-header .btn .codicon', null]
]

async function launch(name) {
  const userData = path.join(lib.WORK, `icons-profile-${name}`)
  fs.rmSync(userData, { recursive: true, force: true })
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47896), CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check(`${name}: no page errors`, false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('demo', { exact: true }).first().click()
  await lib.sleep(500)
  return { app, page, inv }
}

/** Each shell icon group's computed font size (all of the group's icons must agree), and its width in screen pixels. */
const sizes = (page) =>
  page.evaluate((groups) => {
    const out = {}
    for (const [sel] of groups) {
      const icons = [...document.querySelectorAll(sel)]
      const fontSizes = [...new Set(icons.map((i) => getComputedStyle(i).fontSize))]
      out[sel] = { n: icons.length, fontSize: fontSizes.join('/'), width: icons[0] ? Math.round(icons[0].getBoundingClientRect().width * devicePixelRatio * 10) / 10 : 0 }
    }
    return out
  }, SHELL)
/** Monaco's own stylesheet is in the page (a class only it styles). */
const monacoLoaded = (page) => page.evaluate(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /monaco-aria-container/.test(r.cssText)) } catch { return false } }))

function same(name, before, after) {
  for (const [sel, want] of SHELL) {
    const b = before[sel]
    const a = after[sel]
    if (!b?.n) continue
    const ok = a.fontSize === b.fontSize && (!want || a.fontSize === want)
    check(`${name}: ${sel} stays ${want ?? b.fontSize}`, ok, `${b.fontSize} → ${a.fontSize}`)
  }
}

async function away(page) {
  await page.locator('.tabs .tab', { hasText: /^\s*Session\s*$/ }).click()
  await lib.sleep(400)
}

;(async () => {
  fs.rmSync(ws, { recursive: true, force: true })
  lib.gitProject(demo, {
    'code.ts': 'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    'README.md': '# Demo\n\n```ts\nconst x: number = 1\n```\n'
  })
  // A change, for the Changes tab's diff.
  fs.writeFileSync(path.join(demo, 'code.ts'), 'export function add(a: number, b: number): number {\n  return a + b + 0\n}\n')

  const triggers = {
    preview: async (page) => {
      await page.locator('.tabs .tab', { hasText: 'Files' }).click()
      await page.locator('.file-row[data-rel="README.md"]').click()
      return until(async () => (await page.locator('.md-preview code[data-colorized]').count()) === 1, HUNG_MS)
    },
    diff: async (page) => {
      await page.locator('.tabs .tab', { hasText: 'Version Control' }).click()
      await page.locator('.split-list .row', { hasText: 'code.ts' }).first().click()
      return until(async () => (await page.locator('.monaco-diff-editor').count()) > 0, HUNG_MS)
    },
    editor: async (page) => {
      await page.locator('.tabs .tab', { hasText: 'Files' }).click()
      await page.locator('.file-row[data-rel="code.ts"]').click()
      return until(async () => (await page.locator('.split-main .monaco-editor').count()) > 0, HUNG_MS)
    }
  }

  for (const [name, open] of Object.entries(triggers)) {
    const { app, page, inv } = await launch(name)
    const before = await sizes(page)
    check(`${name}: Monaco's stylesheet isn't loaded yet`, !(await monacoLoaded(page)))
    check(`${name}: the activity bar's icons start at 24px`, before[SHELL[0][0]].n >= 8 && before[SHELL[0][0]].fontSize === '24px', JSON.stringify(before[SHELL[0][0]]))
    check(`${name}: it opens`, !!(await open(page)))
    check(`${name}: Monaco's stylesheet is loaded`, await monacoLoaded(page))
    same(`${name}, open`, before, await sizes(page))
    await page.screenshot({ path: path.join(lib.WORK, `icons-${name}-open.png`) })
    await away(page)
    same(`${name}, after leaving`, before, await sizes(page))

    if (name === 'editor') {
      // Monaco's own icons: the find widget's are 16px (its base size).
      await page.locator('.tabs .tab', { hasText: 'Files' }).click()
      await page.locator('.file-row[data-rel="code.ts"]').click()
      await until(async () => (await page.locator('.split-main .monaco-editor').count()) > 0, HUNG_MS)
      await page.locator('.split-main .monaco-editor .view-lines').click()
      await page.keyboard.press('Control+F')
      const findIcon = page.locator('.monaco-editor .find-widget .codicon').first()
      const findSize = (await until(async () => (await findIcon.count()) > 0, 5000)) ? await findIcon.evaluate((i) => getComputedStyle(i).fontSize) : null
      check("Monaco's find widget icons stay 16px", findSize === '16px', String(findSize))
      await page.screenshot({ path: path.join(lib.WORK, 'icons-editor-find.png') })
      await page.keyboard.press('Escape')
      // Back and forth, and the other theme.
      for (let i = 0; i < 3; i++) {
        await triggers.editor(page)
        await away(page)
        await triggers.diff(page)
        await away(page)
      }
      same('after going back and forth', before, await sizes(page))
      await inv('settings:update', { appearance: { theme: 'light' } })
      await triggers.editor(page)
      same('light theme, editor open', before, await sizes(page))
      await away(page)
      same('light theme, after leaving', before, await sizes(page))
      await page.screenshot({ path: path.join(lib.WORK, 'icons-light.png') })
      await inv('settings:update', { appearance: { theme: 'dark' } })
      // UI zoom: the same CSS size, drawn larger in proportion.
      const at = async (z) => {
        await app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(f), z)
        await lib.sleep(400)
        return (await sizes(page))[SHELL[0][0]]
      }
      const [one, big] = [await at(1), await at(1.5)]
      check('UI zoom 150%: still 24px, drawn 1.5 times as wide', big.fontSize === '24px' && Math.abs(big.width / one.width - 1.5) < 0.08, `${one.width} → ${big.width}`)
      await at(1)
    }
    await app.close()
  }

  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
