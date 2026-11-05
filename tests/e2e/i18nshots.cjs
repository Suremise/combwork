// The i18n screenshot route (#769; #756's design, section 4): opens each screen of Combwork in a language and photographs
// it in both themes, for a person or an agent to look at: under the pseudo-locale (en-XA, the default) anything still
// plain English was missed; under a language (`npm run e2e -- i18nshots --lang pl`), text that is cut off or wraps
// badly shows. It reaches screens only by means that don't depend on the language: IPC, command ids (the menu-command
// event) and structural hooks (data-run, data-agent, data-action, data-stat, classes), never an English locator
// (tests/i18nshots.test.ts checks). It fails when a screen can't be reached, never on wording.
//
// The screens are case files in tests/e2e/i18nshots/, found by name: core.cjs first, then each area's (<area>.cjs,
// written by the card that translates that area), so no two cards edit the same file. A case file is
// { area, screens: [{ name, open(ctx), close?(ctx) }] }: open() shows the screen and resolves to the locator to
// photograph (null: the whole window), or throws saying what didn't show; close() puts back what the next screen needs.
// ctx: { app, page, inv(channel, ...args), command(id), api(method, route, body), setFocus(on), lib, lang, workspace,
// project (alpha's path), agents (One, Two, Three: added, not started), claudeHome (the fake Claude Code's), hungMs }. Cases share one window per language,
// in order, so a screen leaves the window as it found it (or as its close() does).
//
// Languages: E2E_I18N_LANGS (comma-separated; the runner's --lang sets it), else en-XA. Each starts its own test copy
// with HIVE_LANG set to it (the run context pins every other suite to English) and checks Combwork shows that language.
// Written to the suite folder's i18nshots-shots: <lang>/<area>-<screen>-<theme>.png, a language's notify.log when it
// would have shown a Windows notification, and reached.json (per language and screen: its screenshots, or why it wasn't
// reached). The runner keeps them after a pass with --keep-files, which --lang implies.
//
// With them, a text report of what each screen's layout does to its text (#899, layoutReport.cjs: text cut off,
// wrapped, squeezed or overlapping, and English left in a translated run): report.txt (a line per issue, naming the
// screenshot to open) and report.json. Read it first and open only the images it flags; it never fails the run.
const fs = require('fs')
const path = require('path')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 25000
const CASES = path.join(__dirname, 'i18nshots')
const THEMES = ['dark', 'light']
const SCREEN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A language tag as --lang takes it: pl, pt-BR, zh-CN, en-XA. Whether Combwork has it is checked by starting it. */
const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

/** The languages to photograph, from E2E_I18N_LANGS (comma-separated), else the pseudo-locale. */
function languagesFrom(value) {
  const langs = String(value ?? '').split(',').map((l) => l.trim()).filter(Boolean)
  return langs.length ? [...new Set(langs)] : ['en-XA']
}

/**
 * The case files, core.cjs first and then by name, each checked: { cases: [{ file, area, screens }], problems }. A
 * file is named for its area; its screens have unique names (lower case and dashes) and an open() function.
 */
function loadCases(dir = CASES) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.cjs')).sort((a, b) => (b === 'core.cjs') - (a === 'core.cjs') || a.localeCompare(b))
  const cases = []
  const problems = []
  for (const file of files) {
    let mod
    try {
      mod = require(path.join(dir, file))
    } catch (e) {
      problems.push(`${file}: can't be loaded: ${e.message}`)
      continue
    }
    const area = path.basename(file, '.cjs')
    const said = problems.length
    if (mod?.area !== area) problems.push(`${file}: its area is ${JSON.stringify(mod?.area)}, not ${JSON.stringify(area)} (a case file is named for its area)`)
    const screens = Array.isArray(mod?.screens) ? mod.screens : []
    if (!screens.length) problems.push(`${file}: no screens`)
    const names = new Set()
    for (const s of screens) {
      if (!SCREEN_NAME.test(s?.name ?? '')) problems.push(`${file}: a screen's name ${JSON.stringify(s?.name)} isn't lower case words and dashes`)
      else if (names.has(s.name)) problems.push(`${file}: two screens are named ${s.name}`)
      names.add(s?.name)
      if (typeof s?.open !== 'function') problems.push(`${file}: ${s?.name ?? 'a screen'} has no open()`)
      if (s?.close !== undefined && typeof s.close !== 'function') problems.push(`${file}: ${s.name}'s close isn't a function`)
    }
    if (problems.length === said) cases.push({ file, area, screens })
  }
  return { cases, problems }
}

module.exports = { languagesFrom, loadCases, LANG_TAG }

// Loaded by tests/i18nshots.test.ts for the two helpers above; run, it is the suite.
if (require.main === module) {
  const lib = require('./lib.cjs')
  const { execFileSync } = require('child_process')
  const layout = require('./layoutReport.cjs')
  const { _electron } = require('playwright-core')
  const shots = path.join(lib.WORK, 'i18nshots-shots')
  let failed = 0
  const check = (name, ok, extra = '') => {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
  }
  const oneLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300)

  /** One language: its own test copy, every case's screens in both themes. Returns what it reached. */
  async function photograph(lang, cases) {
    const result = { language: null, translations: 0, screens: {}, errors: [], report: {} }
    const dir = path.join(shots, lang)
    const userData = path.join(lib.WORK, `i18nshots-${lang}-profile`)
    const ws = path.join(lib.WORK, `i18nshots-${lang}-ws`)
    const alpha = path.join(ws, 'alpha')
    const claudeHome = path.join(lib.WORK, `i18nshots-${lang}-claude-home`)
    for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
    for (const d of [dir, alpha]) fs.mkdirSync(d, { recursive: true })
    // A Git project from the start (#1416: Combwork records the version control it finds, and shows Git's sections for Git
    // only); the cases add its commits.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: alpha, env: lib.gitEnv(), stdio: 'pipe' })
    const cenv = lib.fakeClaude(userData, claudeHome, [alpha])
    const cfgFile = path.join(userData, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
    // Banners for agents finishing while the window is focused (stubbed), and the Windows notifications it would show.
    cfg.settings.notifications = { ...cfg.settings.notifications, chimeEnabled: false, desktopNotifications: true, notifyOnFinished: true, notifyOnWaiting: true, bannerSeconds: 60 }
    // The Progress panel's runs come in through the Agent API, as a script's would.
    cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

    const port = lib.port(47834)
    const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: port, ...cenv, HIVE_LANG: lang, HIVE_TEST_NOTIFY_LOG: path.join(dir, 'notify.log') })
    const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
    try {
      const page = await app.firstWindow()
      page.on('pageerror', (e) => check(`${lang}: no page errors`, false, e.message))
      // Problems with a translation (a broken message, a missing value) are noted, never failed on: wording isn't this route's.
      page.on('console', (m) => m.type() === 'warning' && /i18n|message/i.test(m.text()) && result.errors.push(m.text().slice(0, 300)))
      await lib.fitWindow(app, page, { width: 1400, height: 860 })
      await lib.appReady(page)
      const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])

      const info = (await inv('app:info')).language
      result.language = info.code
      result.translations = Object.keys(info.messages ?? {}).length
      const shows = info.code.toLowerCase() === lang.toLowerCase()
      check(`${lang}: Combwork shows it (${result.translations} translations)`, shows, `Combwork shows ${info.code}${info.forced ? `, started with ${info.forced}` : ''}: is ${lang} one of its languages?`)
      if (!shows) return result
      // English left is looked for in a translated run only: in English, every message is its English text.
      const english = /^en(?:-(?!XA)|$)/i.test(info.code) ? null : layout.englishLeft(layout.englishCatalogue(), info.messages ?? {})

      await lib.openWorkspace(inv, page, ws)
      await lib.waitForProvider(inv)
      const agents = []
      for (const name of ['One', 'Two', 'Three']) agents.push(await lib.addAgent(inv, alpha, { name }))
      const apiToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
      const ctx = {
        app,
        page,
        inv,
        lib,
        lang,
        workspace: ws,
        project: alpha,
        agents,
        claudeHome,
        hungMs: HUNG_MS,
        /**
         * Text a case writes into Combwork as a user would, and where Combwork shows it (a selector), so English left skips it
         * there (HI-1915: a template named "Pair", a blocked reason "Waiting for the release").
         */
        authored: (text, within) => english?.authored.push({ text, within }),
        /** Runs a command by its id, as the menu does (App.tsx's menu-command event). */
        command: (id, ...args) => app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('hive:event', ev), { type: 'menu-command', command: id, args }),
        /** The Agent API, with the test copy's token. */
        api: async (method, route, body) => {
          const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
          const json = await r.json().catch(() => null)
          if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${JSON.stringify(json)}`)
          return json
        },
        /** The window's focus as Combwork sees it (a quiet test copy is never really focused): banners need it on. */
        setFocus: (on) =>
          app.evaluate(({ BrowserWindow }, f) => {
            const w = BrowserWindow.getAllWindows()[0]
            w.isFocused = () => f
            w.emit(f ? 'focus' : 'blur')
          }, on)
      }
      const theme = async (t) => {
        await inv('settings:update', { appearance: { theme: t } })
        if (!(await lib.until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === t, HUNG_MS))) throw new Error(`the ${t} theme didn't apply`)
        // Painted in it: two frames after the change, with the terminals on screen fitted to their panes (a theme change
        // and a pane that changed size fit them a moment later, and their lines re-wrap then: #896).
        await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))
        if (!(await lib.until(() => page.evaluate(() => window.__hiveTerminalsFitted?.() ?? true), HUNG_MS))) throw new Error("the terminals weren't fitted to their panes")
        await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))))
      }

      for (const c of cases) {
        for (const s of c.screens) {
          const key = `${c.area}/${s.name}`
          const got = (result.screens[key] = { reached: false, why: null })
          try {
            const target = await s.open(ctx)
            for (const t of THEMES) {
              await theme(t)
              const file = path.join(dir, `${c.area}-${s.name}-${t}.png`)
              if (target) await target.screenshot({ path: file, timeout: HUNG_MS })
              else await page.screenshot({ path: file, timeout: HUNG_MS })
              if (!(fs.statSync(file).size > 0)) throw new Error(`its ${t} screenshot is empty`)
              got[t] = path.relative(shots, file)
              // The layout is the same in both themes: it is read once, in the first.
              if (t === THEMES[0]) {
                // A screen is a locator, the whole window (null), or another window (a page: the developer console).
                const isLocator = typeof target?.elementHandle === 'function'
                const root = isLocator ? await target.elementHandle({ timeout: HUNG_MS }) : null
                const issues = await (isLocator ? target.page() : (target ?? page)).evaluate(layout.inspectLayout, [root, english])
                result.report[key] = { image: got[t].replace(/\\/g, '/'), issues }
              }
            }
            got.reached = true
          } catch (e) {
            got.why = oneLine(e)
          }
          check(`${lang}: ${key} reached in both themes`, got.reached, got.why)
          if (s.close) {
            try {
              await s.close(ctx)
            } catch (e) {
              check(`${lang}: ${key} closed for the next screen`, false, oneLine(e))
            }
          }
        }
      }
      await theme('dark').catch(() => undefined)
    } catch (e) {
      check(`${lang}: the route ran`, false, oneLine(e))
      result.errors.push(String(e?.stack ?? e))
    } finally {
      await app.close().catch(() => undefined)
    }
    return result
  }

  ;(async () => {
    fs.rmSync(shots, { recursive: true, force: true })
    fs.mkdirSync(shots, { recursive: true })
    const langs = languagesFrom(process.env.E2E_I18N_LANGS)
    const bad = langs.filter((l) => !LANG_TAG.test(l))
    check('the languages are language tags', !bad.length, bad.join(', '))
    const { cases, problems } = loadCases()
    for (const p of problems) check(`case file ${p}`, false)
    const screens = cases.reduce((n, c) => n + c.screens.length, 0)
    console.log(`Cases: ${cases.map((c) => `${c.area} (${c.screens.map((s) => s.name).join(', ')})`).join('; ')}`)
    const reached = {}
    if (!bad.length) for (const lang of langs) reached[lang] = await photograph(lang, cases)
    fs.writeFileSync(path.join(shots, 'reached.json'), JSON.stringify(Object.fromEntries(Object.entries(reached).map(([l, r]) => [l, { ...r, report: undefined }])), null, 2))
    const report = Object.fromEntries(Object.entries(reached).map(([l, r]) => [l, r.report]))
    fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 2))
    const summary = layout.summarize(report)
    fs.writeFileSync(path.join(shots, 'report.txt'), summary)
    for (const [lang, r] of Object.entries(reached)) {
      const missed = Object.entries(r.screens).filter(([, s]) => !s.reached)
      const n = Object.keys(r.screens).length - missed.length
      console.log(`${lang}: reached ${n} of ${screens} screens in both themes${missed.length ? `; not reached: ${missed.map(([k, s]) => `${k} (${s.why})`).join('; ')}` : ''}`)
      if (r.errors.length) console.log(`${lang}: noted (not failed): ${r.errors.slice(0, 5).join(' | ')}`)
    }
    // Each language's count; the issues themselves are in report.txt.
    for (const line of summary.split('\n').filter((l) => l && !l.startsWith(' '))) console.log(`Layout report: ${line}`)
    console.log(`Layout report: ${path.join(shots, 'report.txt')} (read it before opening any screenshot)`)
    console.log(`Screenshots: ${shots} (after a pass, the runner keeps a copy with --lang or --keep-files)`)
    process.exit(failed ? 1 : 0)
  })()
}
