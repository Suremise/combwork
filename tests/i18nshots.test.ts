import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { affectedSuites } from './e2e/affected.mjs'
// @ts-expect-error: plain .mjs modules without types
import { LANG_SUITE, parseArgs, selectSuites } from './e2e/runner.mjs'
import { tempDir } from './tempDir'

// #769: the i18n screenshot route. It reaches every screen without English text (so it works in any language), finds
// each area's case file by name, and the runner's --lang runs it alone in the languages given.

const req = createRequire(__filename)
const route = req('./e2e/i18nshots.cjs') as {
  languagesFrom: (v: string | undefined) => string[]
  loadCases: (dir?: string) => { cases: { file: string; area: string; screens: { name: string }[] }[]; problems: string[] }
}
const names: string[] = (SUITES as { name: string }[]).map((s) => s.name)
const casesDir = join(__dirname, 'e2e', 'i18nshots')

describe('the i18nshots route (#769)', () => {
  it('finds no screen by its English text: no text, role-name, label or title locator in the suite or a case file', () => {
    const files = [join(__dirname, 'e2e', 'i18nshots.cjs'), ...readdirSync(casesDir).filter((n) => n.endsWith('.cjs')).map((n) => join(casesDir, n))]
    expect(files.length).toBeGreaterThan(2)
    const english = /hasText|hasNotText|getBy(?:Role|Text|Label|Title|Placeholder|AltText)\b|:has-text\(|:text(?:-is|-matches)?\(|\btext=|\[(?:aria-label|title|placeholder|alt)[\^$*~|]?=/
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/)
      for (const [i, line] of lines.entries()) expect(english.test(line), `${f}:${i + 1}: ${line.trim()}`).toBe(false)
    }
  })

  it('loads every case file: core first, then by area, each named for its area with uniquely named screens', () => {
    const { cases, problems } = route.loadCases()
    expect(problems).toEqual([])
    expect(cases[0].area).toBe('core')
    expect(cases.map((c) => c.area).slice(1)).toEqual(cases.map((c) => c.area).slice(1).sort())
    expect(cases.map((c) => c.area)).toEqual(expect.arrayContaining(['core', 'language']))
    // The prototype's screens (#756): Usage cost, banner, Progress, the window, the open-cards dialog, and Language.
    expect(cases[0].screens.map((s) => s.name)).toEqual(['usage-cost', 'banner', 'progress', 'window', 'open-cards-dialog'])
  })

  it('says what is wrong with a case file rather than skipping its screens', () => {
    const dir = tempDir('hive-i18nshots-')
    try {
      writeFileSync(join(dir, 'board.cjs'), "module.exports = { area: 'boards', screens: [{ name: 'card', open: () => null }] }")
      writeFileSync(join(dir, 'files.cjs'), "module.exports = { area: 'files', screens: [{ name: 'Tree View', open: () => null }, { name: 'editor' }, { name: 'editor', open: () => null }] }")
      writeFileSync(join(dir, 'git.cjs'), "module.exports = { area: 'git', screens: [] }")
      writeFileSync(join(dir, 'sessions.cjs'), 'throw new Error("broken")')
      writeFileSync(join(dir, 'tips.cjs'), "module.exports = { area: 'tips', screens: [{ name: 'tip-card', open: () => null }] }")
      mkdirSync(join(dir, 'notes'))
      const { cases, problems } = route.loadCases(dir)
      expect(cases.map((c) => c.area)).toEqual(['tips'])
      expect(problems).toEqual([
        'board.cjs: its area is "boards", not "board" (a case file is named for its area)',
        `files.cjs: a screen's name "Tree View" isn't lower case words and dashes`,
        'files.cjs: editor has no open()',
        'files.cjs: two screens are named editor',
        'git.cjs: no screens',
        expect.stringMatching(/^sessions\.cjs: can't be loaded: broken/)
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('photographs the pseudo-locale unless given languages', () => {
    expect(route.languagesFrom(undefined)).toEqual(['en-XA'])
    expect(route.languagesFrom('')).toEqual(['en-XA'])
    expect(route.languagesFrom('en-XA, pl,pl')).toEqual(['en-XA', 'pl'])
  })

  it('--lang runs the route alone in those languages and keeps its screenshots; the other suites stay in English', () => {
    expect(LANG_SUITE).toBe('i18nshots')
    expect(names).toContain(LANG_SUITE)
    const parse = (...a: string[]) => parseArgs(a, names)
    expect(parse('--lang', 'pl')).toMatchObject({ lang: ['pl'], named: ['i18nshots'], keepFiles: true })
    expect(parse('i18nshots', '--lang', 'en-XA,pl', '--lang', 'pt-BR,pl')).toMatchObject({ lang: ['en-XA', 'pl', 'pt-BR'], named: ['i18nshots'] })
    expect(selectSuites(SUITES, parse('--lang', 'zh-CN')).map((s: { name: string }) => s.name)).toEqual(['i18nshots'])
    // Without it, i18nshots is an ordinary suite (in the full set, under the pseudo-locale) and no screenshots are kept.
    expect(parse('i18nshots')).toMatchObject({ lang: [], named: ['i18nshots'], keepFiles: false })
    for (const bad of [['--lang'], ['--lang', '--build'], ['--lang', ',']]) expect(parse(...bad).error, bad.join(' ')).toMatch(/--lang needs a language code/)
    expect(parse('--lang', 'polski').error).toMatch(/polski isn't a language code/)
    for (const other of [['--lang', 'pl', 'board'], ['--lang', 'pl', '--all'], ['--lang', 'pl', '--affected'], ['--lang', 'pl', '--real']]) expect(parse(...other).error, other.join(' ')).toMatch(/every other suite runs in English/)
  })

  it('--affected runs it for its case files, the translations and the screens its core cases reach', () => {
    const pick = (f: string) => affectedSuites([f], names)
    for (const f of ['tests/e2e/i18nshots.cjs', 'tests/e2e/i18nshots/core.cjs', 'tests/e2e/i18nshots/board.cjs', 'locales/pl/language.json', 'src/renderer/src/components/Popups.tsx', 'src/main/progress.ts']) expect(pick(f).suites, f).toContain('i18nshots')
    // A translation alone needs nothing else: every other suite runs in English.
    expect(pick('locales/de/board.json')).toEqual({ suites: ['i18nshots'], why: ['locales/de/board.json: i18nshots'] })
    // The i18n tooling and each area's unit tests are npm test's (#768): no suite.
    for (const f of ['scripts/i18nExtract.mjs', 'scripts/i18nValues.mjs', 'scripts/i18nCheck.mjs', 'scripts/i18nCoverage.mjs', 'scripts/i18nGuard.mjs', 'i18n/allow/src/renderer/src/components/Board.tsx.json', 'tests/i18n/language.test.ts']) expect(pick(f), f).toEqual({ suites: [], why: [] })
    // Its text report's layout check (#899): the route and the suite that seeds it.
    expect(pick('tests/e2e/layoutReport.cjs').suites).toEqual(expect.arrayContaining(['i18nreport', 'i18nshots']))
  })
})

// #899: the route's text report, so agents read text and open only the screenshots it flags.
const report = req('./e2e/layoutReport.cjs') as {
  englishCatalogue: () => Record<string, string>
  englishLeft: (english: Record<string, string>, translations: Record<string, string>) => { exact: string[]; patterns: { id: string; source: string }[] }
  summarize: (r: Record<string, Record<string, { image: string; issues: { kind: string; text: string; where: string; px?: number; detail?: string }[] }>>) => string
}

describe("the i18nshots route's text report (#899)", () => {
  it('looks for English left only where the language translates it into other words', () => {
    const english = { a: 'Not running', b: 'To do', c: 'OK', d: 'Cancel', e: 'Cancel', f: 'Hive', g: '{agent} (removed)', h: '{n, plural, one {# card} other {# cards}}', i: '<b>{name}</b> is ready', j: '{name}', k: 'Hive {version}' }
    const pl = { a: 'Nie działa', c: 'OK', d: 'Anuluj', e: 'Cancel', f: 'Pszczoła', g: '{agent} (usunięty)', h: '{n, plural, one {# karta} other {# kart}}', i: '<b>{name}</b> jest gotowy', j: '{name}', k: 'Hive {version}', z: 'Hive' }
    const left = report.englishLeft(english, pl)
    // b isn't translated (shown in English on purpose), c translates to itself, d's English is also e's translation,
    // and f's English is another message's translation (z): seeing any of them is no sign of a miss.
    expect(left.exact).toEqual(['Not running'])
    // Plain placeholders become a pattern; plurals, markup and a message with too few letters of its own don't.
    expect(left.patterns.map((p) => p.id)).toEqual(['g'])
    const re = new RegExp(left.patterns[0].source, 'u')
    expect(re.test('Alice (removed)')).toBe(true)
    expect(re.test('Alice (usunięty)')).toBe(false)
  })

  it('reads every English catalogue', () => {
    const en = report.englishCatalogue()
    expect(Object.keys(en).length).toBeGreaterThan(1000)
    expect(Object.values(en).every((v) => typeof v === 'string')).toBe(true)
  })

  it('says per language how many screens were flagged, then a line per issue naming the screenshot to open', () => {
    const text = report.summarize({
      pl: {
        'board/board': { image: 'pl/board-board-dark.png', issues: [{ kind: 'wraps', text: 'DO ZROBIENIA', where: 'div.col-head > h3', detail: '2 lines' }, { kind: 'english', text: 'Not running', where: 'span' }] },
        'core/window': { image: 'pl/core-window-dark.png', issues: [] },
        'settings/advanced': { image: 'pl/settings-advanced-dark.png', issues: [{ kind: 'clipped', text: 'hive.showDeveloperFeatures', where: 'div.s-label', px: 14 }] }
      }
    })
    expect(text.split('\n')).toEqual([
      'pl: 3 screens checked, 2 flagged (1 wraps, 1 english, 1 clipped)',
      '  board/board (pl): wraps "DO ZROBIENIA" [div.col-head > h3, 2 lines] → pl/board-board-dark.png',
      '  board/board (pl): english "Not running" [span] → pl/board-board-dark.png',
      '  settings/advanced (pl): clipped by 14 px "hive.showDeveloperFeatures" [div.s-label] → pl/settings-advanced-dark.png',
      ''
    ])
  })
})
