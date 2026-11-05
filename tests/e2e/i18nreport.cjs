// The i18nshots route's text report (#899): its layout check (layoutReport.cjs) on a page seeded with the kinds of
// problems the language runs found in #886, #887, #890 and #892, now fixed in Combwork: a menu detail cut off with "…", a
// board column heading wrapping under its buttons, a table's last column cut off and a table scrolling sideways, a
// banner squeezed into a narrow column, a command name broken mid-word, a badge over its label, a button past the
// window's edge, and English left beside its translation. Each must be reported, and a clean part of the page
// (a paragraph, short labels that fit, a long code line, a scrolling list, translated text, a path broken anywhere, a
// word broken at its hyphens, an id in camelCase, a sticky header over its rows, a fixed dialog in a narrow scrolling box, text for screen
// readers, a long description cut to one line, a path cut with "…", a popup menu over its bar, a document's own
// English, a word of an id that is also a message, a list's row half scrolled out of view) must not be. Round 1 of
// the review added a short label cut to a few letters and a line cut in half at the bottom of its box. HI-1590 added
// Japanese and Chinese text wrapping between characters (not mid-word: they have no spaces between words), a Latin word
// broken inside Japanese text (mid-word), and a translation ending in a word a placeholder message ends in ("Notes de
// version", not English left). HI-1915 added the user's own words equal to a message (a template named "Pair") or
// fitting a placeholder message ("Waiting for the release" as a blocked reason), where Combwork shows them (authored): not
// English left; the same words in Combwork's own controls (a preset button "Pair", a status "Waiting for the agents") still
// are. The page runs in a bare Electron window (no Combwork), hidden.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { _electron } = require('playwright-core')
const layout = require('./layoutReport.cjs')

const dir = path.join(lib.WORK, 'i18nreport')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

// English and a translation of it, as a language run has them: two messages translated, one not translated (shown in
// English on purpose), and one whose translation is its English.
const ENGLISH = {
  'board.agent.notRunning': 'Not running',
  'board.agent.removed': '{agent} (removed)',
  'board.column.todo': 'To do',
  'panes.waitingFor': 'Waiting for {what}',
  // A placeholder and one bare word (HI-1590): it would match any phrase ending in "version", so it is no pattern.
  'providers.version': '{provider} version',
  'shell.ok': 'OK',
  'workspace.kind': 'project',
  'workflow.preset.pair': 'Pair'
}
const TRANSLATIONS = { 'board.agent.notRunning': 'Nie działa', 'board.agent.removed': '{agent} (usunięty)', 'panes.waitingFor': 'Czekam na {what}', 'providers.version': 'Wersja {provider}', 'shell.ok': 'OK', 'workspace.kind': 'projekt', 'workflow.preset.pair': 'Para' }
// What the user wrote, where Combwork shows it (HI-1915): English there is theirs.
const AUTHORED = [
  { text: 'Pair', within: '.template-row, .template-detail-title' },
  { text: 'Waiting for the release', within: '.task-blocked' }
]

const LONG = 'Ask before each edit or command, and remember what the user allowed for the rest of the session.'
const PAGE = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><style>
body { margin: 0; font: 13px/1.4 'Segoe UI', sans-serif; width: 900px; }
section { margin: 8px; }
.menu-detail { width: 380px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col { width: 120px; display: inline-block; vertical-align: top; }
.col-head { display: flex; align-items: center; } .col-head h3 { margin: 0; font-size: 13px; flex: 1 1 auto; min-width: 0; } .col-head button { flex: none; }
.archive { width: 300px; overflow: hidden; } .archive table { width: 500px; table-layout: fixed; }
.prices { width: 300px; overflow-x: auto; } .prices table { width: 600px; }
.banner { display: flex; width: 600px; } .banner .text { width: 150px; } .banner .space { flex: 1; }
.keys td.cmd { width: 50px; word-break: break-all; }
.mode { position: relative; width: 300px; } .mode .badge { position: absolute; left: 20px; top: 0; background: #333; color: #fff; }
.edge { position: absolute; left: 860px; top: 4px; white-space: nowrap; }
.vclip { width: 300px; height: 30px; overflow: hidden; line-height: 24px; }
.clean p { width: 600px; } .clean .list { height: 50px; overflow-y: auto; } .clean .list div { height: 30px; }
.clean pre { width: 200px; overflow-x: auto; }
.sticky-wrap { height: 40px; overflow-y: auto; } .sticky-wrap > div { height: 20px; } .sticky-head { position: sticky; top: 0; background: #ddd; }
.page-scroll { width: 100px; height: 40px; overflow: auto; } .dialog { position: fixed; left: 300px; top: 600px; width: 400px; }
.popup-wrap { position: relative; } .popup { position: absolute; left: 0; top: 0; z-index: 10; background: #eee; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style></head><body>
<section><div class="menu-detail">${LONG}</div></section>
<section><div class="col"><div class="col-head"><h3>DO ZROBIENIA TERAZ</h3><button>+</button><button>⋯</button></div></div></section>
<section><div class="archive"><table><tr><td>Karta</td><td>Zarchiwizowano</td><td>Przywróć kartę</td></tr></table></div></section>
<section><div class="prices"><table><tr><th>Model</th><th>Wejście</th><th>Wyjście</th><th>Pamięć podręczna</th></tr></table></div></section>
<section><div class="banner"><div class="text">Folder .combwork jest zatwierdzony w repozytorium, więc jego pliki trafiają do historii projektu i widzą je wszyscy.</div><div class="space"></div></div></section>
<section style="display: flex; gap: 20px"><table class="keys"><tr><td class="cmd">Einstellungen</td><td>Ctrl+,</td></tr></table><div lang="ja" style="width: 70px; word-break: break-all">設定のArbeitsbereichを開く</div></section>
<section><div class="mode"><span>Domyślny tryb pracy</span><span class="badge">W użyciu</span></div></section>
<section style="position: relative; height: 30px"><button class="edge">Wznów w agencie</button></section>
<section><span>Not running</span> <span>Alice (removed)</span> <button class="preset">Pair</button> <span class="status">Waiting for the agents</span></section>
<section><button style="width: 40px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">Berechtigungsmodus</button></section>
<section><div class="vclip"><div>Pierwsza widoczna linia<br>Druga linia ucięta w połowie</div></div></section>
<section class="clean">
  <p>To jest zwykły akapit, który mieści się w swojej kolumnie i zawija się tylko między słowami, tak jak powinien.</p>
  <h3>Ustawienia</h3><button>Zapisz</button><span class="badge">Nowy</span>
  <pre>npm run e2e -- --lang en-XA,pl --build --keep-files and a long line of code that scrolls</pre>
  <div class="list"><div>Pierwszy</div><div>Drugi</div><div>Trzeci</div></div>
  <span>Nie działa</span> <span>Bob (usunięty)</span> <span>OK</span> <span>To do</span>
  <div style="width: 120px; overflow-wrap: anywhere">C:\\Users\\Someone\\AppData\\Local\\hive-test\\e2e\\lanes</div>
  <div style="width: 120px">Kliknij prawym-przyciskiem-myszy-tutaj</div>
  <div class="menu-detail" style="width: 150px">Opis umiejętności, który jest długi i celowo skrócony do jednej linii w liście, bo cały tekst widać po wybraniu wiersza.</div>
  <div class="menu-detail" style="width: 150px">C:\\Users\\Someone\\AppData\\Local\\hive-test\\e2e\\lanes\\0</div>
  <div style="width: 60px; overflow-wrap: anywhere">session.applyPermissionModes</div>
  <div class="popup-wrap"><span>Etykieta paska</span><div class="popup">Menu nad paskiem</div></div>
  <div class="sticky-wrap"><div class="sticky-head">Nagłówek</div><div>Wiersz pierwszy</div><div>Wiersz drugi</div></div>
  <div class="page-scroll"><div class="dialog"><h2>Okno dialogowe na całą szerokość</h2></div></div>
  <span class="sr-only">Tylko dla czytnika ekranu</span>
  <div class="markdown"><p><strong>Not running</strong> is what the skill's own English says.</p><h2>Not running</h2></div>
  <div class="kb-id">workspace.<wbr>new.<wbr>project</div>
  <div style="display: flex; gap: 20px; align-items: baseline"><div class="template-row"><div class="label">Pair</div></div><div class="template-detail-title"><span>Pair</span></div><div class="task-blocked"><span class="task-note-text">Waiting for the release</span></div></div>
  <div style="display: flex; gap: 20px; align-items: flex-start"><div lang="ja" style="width: 90px">エージェントではなくスクリプトが報告したため</div><div lang="zh-CN" style="width: 60px">报告的进度已经更新了</div><span>Notes de version</span></div>
</section>
</body></html>`

const MAIN = `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 1800, show: false, webPreferences: { backgroundThrottling: false } })
  w.loadFile(require('path').join(__dirname, 'page.html'))
})
`

;(async () => {
  // Unit-level checks of the report's helpers, with the same catalogue.
  const left = layout.englishLeft(ENGLISH, TRANSLATIONS)
  check('English left: translated messages only', JSON.stringify(left.exact) === JSON.stringify(['Not running', 'Pair', 'project']), JSON.stringify(left))
  const pattern = (id) => left.patterns.find((p) => p.id === id)
  check('English left: a message with a placeholder is a pattern', left.patterns.length === 2 && new RegExp(pattern('board.agent.removed')?.source, 'u').test('Alice (removed)') && new RegExp(pattern('panes.waitingFor')?.source, 'u').test('Waiting for the release'), JSON.stringify(left.patterns))
  check("English left: nothing the user wrote yet (the route's cases add theirs)", Array.isArray(left.authored) && left.authored.length === 0, JSON.stringify(left.authored))
  left.authored.push(...AUTHORED)

  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const page0 = path.join(dir, 'page.html')
  const main = path.join(dir, 'main.js')
  fs.writeFileSync(page0, PAGE)
  fs.writeFileSync(main, MAIN)
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [main], cwd: dir, env: lib.hiveEnv({ CW_USER_DATA: path.join(dir, 'profile') }), timeout: 20000 })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    // The whole page is in the window: text below its edge would be skipped as not shown, and pass unchecked.
    const fits = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)
    check('the whole page is in the window', fits)
    const issues = await page.evaluate(layout.inspectLayout, [null, left])
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(issues, null, 2))
    const has = (kind, text) => issues.some((i) => i.kind === kind && i.text.includes(text))
    const said = () => layout.summarize({ pl: { page: { image: 'page.png', issues } } })
    check('a menu detail cut off with "…" (#886: the permission mode menu)', has('ellipsis', 'Ask before each edit'), said())
    check('a column heading wrapping under its buttons (#886, #890, #892: board columns)', has('wraps', 'DO ZROBIENIA TERAZ'), said())
    check("a table's last column cut off (#886: the archived cards table)", has('cut-off', 'Przywróć kartę'), said())
    check('a table scrolling sideways (#887, #892: the API prices table)', has('sideways', 'Pamięć podręczna'), said())
    check('a banner squeezed into a narrow column (#886: the .combwork committed banner)', has('squeezed', 'Folder .combwork'), said())
    check('a word broken across lines (#887, #892: the shortcuts table)', has('mid-word', 'Einstellungen'), said())
    check('a Latin word broken inside Japanese text (HI-1590)', has('mid-word', 'Arbeitsbereich'), said())
    check('a badge over its label (#890, #892: the mode row)', has('overlaps', 'W użyciu') || has('overlaps', 'Domyślny tryb'), said())
    check("a button past the window's edge", has('outside', 'Wznów w agencie'), said())
    check('a short label cut to a few letters with "…" (#899 round 1: however much is cut)', has('ellipsis', 'Berechtigungsmodus'), said())
    check('a line cut in half by the box around it (#899 round 1: at the bottom)', has('cut-off', 'Druga linia'), said())
    check('English left: a translated message shown in English', has('english', 'Not running'), said())
    check('English left: a message with a placeholder', has('english', 'Alice (removed)'), said())
    // HI-1915: the user's words where Combwork shows them aren't English left; the same words in Combwork's own controls are.
    const englishAt = (text, where) => issues.some((i) => i.kind === 'english' && i.text === text && where.test(i.where))
    check("English left: Combwork's own control, untranslated, though the user named a template the same (the positive control)", englishAt('Pair', /button\.preset/), said())
    check("English left: Combwork's own status, untranslated, fitting a placeholder message (the positive control)", englishAt('Waiting for the agents', /span\.status/), said())
    check("English left: not a template's name the user gave, equal to a message (HI-1915: \"Pair\")", !issues.some((i) => i.kind === 'english' && /template-row|template-detail-title/.test(i.where)), said())
    check("English left: not a blocked reason the user gave, fitting a placeholder message (HI-1915: \"Waiting for {what}\")", !issues.some((i) => i.kind === 'english' && /task-blocked/.test(i.where)), said())
    const clean = ['To jest zwykły', 'Ustawienia', 'Zapisz', 'Nowy', 'npm run', 'Pierwszy', 'Drugi', 'Trzeci', 'Nie działa', 'Bob (usunięty)', 'OK', 'To do', 'hive-test', 'Users', 'przyciskiem', 'Nagłówek', 'Wiersz', 'Okno dialogowe', 'Tylko dla', 'Opis umiejętności', 'Someone', 'applyPermissionModes', 'Etykieta paska', 'Menu nad', 'エージェント', '报告', 'Notes de version']
    const wrong = issues.filter((i) => clean.some((c) => i.text.includes(c)) || /markdown|kb-id/.test(i.where))
    check('nothing reported in the clean part', !wrong.length, layout.summarize({ pl: { page: { image: '', issues: wrong } } }))
    // The report's lines name the screen, the language and the screenshot to open.
    const line = layout.issueLine('board-board', 'pl', { kind: 'wraps', text: 'DO ZROBIENIA', where: 'div.col-head > h3', detail: '2 lines' }, 'pl/board-board-dark.png')
    check("a report line names the screen, language, place and screenshot", line === 'board-board (pl): wraps "DO ZROBIENIA" [div.col-head > h3, 2 lines] → pl/board-board-dark.png', line)
  } finally {
    await app.close().catch(() => undefined)
  }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL the suite ran (${e?.stack ?? e})`)
  process.exit(1)
})
