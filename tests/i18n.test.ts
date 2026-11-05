import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { builtinModules, createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import type { AppSettings } from '../src/shared/types'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs modules without types
import { BUILD_INPUTS, buildInputs } from './e2e/build.mjs'
import { fmt, language, locale, msg, onLanguageChange, pseudoText, setLanguage, setProblemReporter, tr, tRich } from '../src/shared/i18n'
import { availableLanguages, loadCatalogue } from '../src/shared/i18n/catalogues'
import { LANGUAGES, PSEUDO_LANGUAGE, matchLanguage, resolveLanguage } from '../src/shared/i18n/languages'
import { LANGUAGE_TEXT } from '../src/shared/i18n/languageText'
import { formatDate, setRegionalFormat } from '../src/shared/dates'

// #767: the i18n core. Choosing the language, ICU plurals, a broken or missing translation showing English, the
// pseudo-locale, Intl formatting, the loader, main's switches (the latest wins), agent-facing scripts never reaching
// the translations, tests pinned to English, and the e2e build following the translations.

const ROOT = resolve(__dirname, '..')

// Main's language (src/main/i18n.ts) asks Electron for Windows' languages; a test can hold a language's load.
vi.mock('electron', async () => {
  const stub = await import('./electron-stub')
  return { ...stub, app: { ...stub.app, commandLine: { getSwitchValue: () => '', appendSwitch: () => undefined }, getPreferredSystemLanguages: () => ['en-GB'], getSystemLocale: () => 'en-GB' } }
})
const held = vi.hoisted(() => ({ load: null as null | ((code: string) => Promise<Record<string, string>> | null) }))
vi.mock('../src/shared/i18n/catalogues', async (original) => {
  const real = await original<typeof import('../src/shared/i18n/catalogues')>()
  return { ...real, loadCatalogue: (code: string, report?: (text: string) => void) => held.load?.(code) ?? real.loadCatalogue(code, report) }
})

afterEach(() => {
  held.load = null
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  setRegionalFormat(undefined)
})

describe('choosing the language', () => {
  const all = LANGUAGES.map((l) => l.code)

  it('matches Windows tags to Combwork languages', () => {
    expect(matchLanguage('de-AT')).toBe('de')
    expect(matchLanguage('pt-PT')).toBe('pt-BR')
    expect(matchLanguage('pl_PL')).toBe('pl')
    expect(matchLanguage('EN-gb')).toBe('en')
    expect(matchLanguage('ko-KR')).toBeNull()
    expect(matchLanguage('')).toBeNull()
  })

  it('Chinese is Simplified only', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) expect(matchLanguage(tag), tag).toBe('zh-CN')
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) expect(matchLanguage(tag), tag).toBeNull()
  })

  it('only a forced language may be the pseudo-locale: as a Windows tag it is English', () => {
    expect(matchLanguage('en-XA')).toBe('en')
    expect(matchLanguage('en-XA', undefined, true)).toBe(PSEUDO_LANGUAGE)
  })

  it('forced, then the setting, then Windows, then English; formatting in the Windows tag that chose it', () => {
    expect(resolveLanguage('auto', ['zh-TW', 'fr-CA', 'en-GB'], all)).toEqual({ code: 'fr', locale: 'fr-CA' })
    expect(resolveLanguage('auto', ['ko-KR'], all)).toEqual({ code: 'en', locale: 'en' })
    expect(resolveLanguage(undefined, [], all)).toEqual({ code: 'en', locale: 'en' })
    expect(resolveLanguage('pl', ['fr-FR'], all)).toEqual({ code: 'pl', locale: 'pl' })
    expect(resolveLanguage('pl', ['pl-PL', 'en-GB'], all)).toEqual({ code: 'pl', locale: 'pl-PL' })
    expect(resolveLanguage('en', ['pl-PL', 'en-GB'], all)).toEqual({ code: 'en', locale: 'en-GB' })
    // An unknown setting falls through to Windows.
    expect(resolveLanguage('xx', ['de-DE'], all)).toEqual({ code: 'de', locale: 'de-DE' })
    // Forced wins, as written.
    expect(resolveLanguage('pl', ['fr-FR'], all, 'en')).toEqual({ code: 'en', locale: 'en' })
    expect(resolveLanguage('pl', ['fr-FR'], all, 'en-XA')).toEqual({ code: PSEUDO_LANGUAGE, locale: 'en' })
  })

  it('Automatic picks only a language with translations; one chosen or forced is honoured without', () => {
    const available = ['pl']
    expect(resolveLanguage('auto', ['de-DE', 'pl-PL'], available)).toEqual({ code: 'pl', locale: 'pl-PL' })
    expect(resolveLanguage('auto', ['de-DE'], available)).toEqual({ code: 'en', locale: 'en' })
    expect(resolveLanguage('de', ['en-GB'], available)).toEqual({ code: 'de', locale: 'de' })
    expect(resolveLanguage('de', ['de-AT'], [])).toEqual({ code: 'de', locale: 'de-AT' })
    expect(resolveLanguage('auto', ['de-DE'], available, 'de')).toEqual({ code: 'de', locale: 'de' })
  })

  it('every language has its own name, and those drafted by AI their mark and note', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN'])
    for (const l of LANGUAGES) {
      expect(l.name, l.code).toBeTruthy()
      if (l.ai) {
        expect(l.aiMark, l.code).toMatch(/^\(.+\)$/)
        expect(l.aiNote, l.code).toBeTruthy()
      }
    }
    expect(LANGUAGES.find((l) => l.code === 'en')?.ai).toBe(false)
  })
})

describe('messages', () => {
  const cards = msg({ id: 'test.cards', defaultMessage: '{n, plural, one {# card} other {# cards}} in {project}', description: 'Test.' })

  it('English is the message as written, with ICU plurals', () => {
    expect(tr(cards, { n: 1, project: 'hive' })).toBe('1 card in hive')
    expect(tr(cards, { n: 3, project: 'hive' })).toBe('3 cards in hive')
  })

  it("Polish has its plural forms (one, few, many, other), in the translation's words", () => {
    setLanguage('pl', { 'test.cards': '{n, plural, one {# karta} few {# karty} many {# kart} other {# karty}} w {project}' })
    expect(language()).toBe('pl')
    expect([1, 2, 5, 22, 25, 112].map((n) => tr(cards, { n, project: 'hive' }))).toEqual(['1 karta w hive', '2 karty w hive', '5 kart w hive', '22 karty w hive', '25 kart w hive', '112 kart w hive'])
  })

  it('a translation that renames a placeholder or does not parse shows in English, reported once', () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    const hello = msg({ id: 'test.hello', defaultMessage: 'Hello {name}', description: 'Test.' })
    setLanguage('pl', { 'test.hello': 'Witaj {nazwa}', 'test.cards': '{n, plural, one {# karta}' })
    expect(tr(hello, { name: 'Ola' })).toBe('Hello Ola')
    expect(tr(cards, { n: 2, project: 'p' })).toBe('2 cards in p')
    expect(tr(cards, { n: 2, project: 'p' })).toBe('2 cards in p')
    expect(problems).toEqual(['i18n (pl): test.hello: Error: The intl string context variable "nazwa" was not provided to the string "Witaj {nazwa}"', 'i18n (pl): test.cards: SyntaxError: MISSING_OTHER_CLAUSE'])
  })

  it('a message the language lacks is English, quietly', () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    setLanguage('pl', {})
    expect(tr(msg({ id: 'test.missing', defaultMessage: 'Only in English', description: 'Test.' }))).toBe('Only in English')
    expect(problems).toEqual([])
  })

  it('rich text: tags become what the values give', () => {
    const m = msg({ id: 'test.rich', defaultMessage: 'Removed <b>{agent}</b>', description: 'Test.' })
    expect(tRich(m, { agent: 'B1', b: (chunks) => ({ bold: chunks.join('') }) })).toEqual(['Removed ', { bold: 'B1' }])
  })

  it('listeners hear each change of language', () => {
    const heard: string[] = []
    const off = onLanguageChange((c) => heard.push(c))
    setLanguage('pl', {})
    setLanguage('en', {})
    off()
    setLanguage('de', {})
    expect(heard).toEqual(['pl', 'en'])
  })

  it('the pseudo-locale accents and lengthens the text, keeping placeholders and plurals', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const out = tr(cards, { n: 3, project: 'hive' })
    expect(out.startsWith('[')).toBe(true)
    expect(out.endsWith(']')).toBe(true)
    expect(out).toContain(`3 ${pseudoText('cards in')} hive`)
    expect(out.length).toBeGreaterThanOrEqual(Math.round('3 cards in hive'.length * 1.25))
    // English for formatting: Intl isn't pseudo.
    expect(locale()).toBe('en')
  })

  it('placeholders are typed from the generated values', () => {
    // Never called: tsc (npm run typecheck) checks these lines.
    const typeChecks = (): void => {
      tr(LANGUAGE_TEXT.automatic, { language: 'Polski' })
      tr(LANGUAGE_TEXT.restart)
      // @ts-expect-error: its placeholder's value is needed
      tr(LANGUAGE_TEXT.automatic)
      // @ts-expect-error: a misspelt placeholder
      tr(LANGUAGE_TEXT.automatic, { langauge: 'Polski' })
      // @ts-expect-error: a message without placeholders takes no values
      tr(LANGUAGE_TEXT.restart, { language: 'Polski' })
    }
    expect(typeof typeChecks).toBe('function')
  })
})

describe('Intl formatting follows the language', () => {
  // Intl separates with no-break spaces (U+00A0, U+202F): compared as plain spaces.
  const plain = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ')
  const sample = (): string[] => [fmt.usd(1234.5), fmt.relative(-4 * 60_000), fmt.relative(-86_400_000), fmt.list(['Claude', 'Codex', 'Copilot']), fmt.number(0.42, { style: 'percent' })].map(plain)

  it('money, relative times, lists and percents', () => {
    expect(sample()).toEqual(['$1,234.50', '4 minutes ago', 'yesterday', 'Claude, Codex, and Copilot', '42%'])
    setLanguage('pl', {}, 'pl-PL')
    expect(sample()).toEqual(['1234,50 USD', '4 minuty temu', 'wczoraj', 'Claude, Codex i Copilot', '42%'])
    setLanguage('de', {})
    expect(sample()[0]).toBe('1.234,50 $')
    setLanguage('ja', {})
    expect(sample()[1]).toBe('4 分前')
    expect(fmt.dateTime(Date.UTC(2026, 9, 13, 12, 5))).toMatch(/^2026\/10\/13/)
  })

  it('English formats as the Windows tag that chose it', () => {
    setLanguage('en', {}, 'en-GB')
    expect(plain(fmt.dateTime(Date.UTC(2026, 9, 13, 12, 5)))).toMatch(/^13 Oct 2026/)
  })

  it("Date format System follows Windows' regional format, not the language", () => {
    const d = new Date(2026, 9, 4, 14, 5)
    setLanguage('pl', {}, 'pl-PL')
    setRegionalFormat('en-GB')
    expect(formatDate(d, { date: 'system', time: '24h' })).toBe('04/10/2026')
    setRegionalFormat('en-US')
    expect(formatDate(d, { date: 'system', time: '24h' })).toBe('10/4/2026')
    expect(formatDate(d, { date: 'ymd', time: '24h' })).toBe('2026-10-04')
  })
})

describe('the translations', () => {
  it('are found by folder, English aside', () => {
    expect(availableLanguages()).toContain('pl')
    expect(availableLanguages()).not.toContain('en')
  })

  it("load a language's areas merged; {} for English, the pseudo-locale and a language without files", async () => {
    // #792: compared with the files themselves, not their wording, so a translator's change needs no test change.
    const files = globSync('locales/pl/*.json', { cwd: ROOT })
    expect(files.length).toBeGreaterThan(0)
    const onDisk = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, string>))
    expect(Object.keys(onDisk).length).toBeGreaterThan(0)
    expect(await loadCatalogue('pl')).toEqual(onDisk)
    expect(await loadCatalogue('en')).toEqual({})
    expect(await loadCatalogue(PSEUDO_LANGUAGE)).toEqual({})
    expect(await loadCatalogue('xx')).toEqual({})
  })

  it('every translation file is an object of text, in a folder named for a language', () => {
    const files = globSync('locales/*/*.json', { cwd: ROOT })
    expect(files.length).toBeGreaterThan(1)
    for (const f of files) {
      const code = f.split(/[\\/]/).at(-2)!
      expect(LANGUAGES.some((l) => l.code === code), f).toBe(true)
      const data = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, unknown>
      for (const [id, v] of Object.entries(data)) expect(code === 'en' ? typeof (v as { defaultMessage?: unknown }).defaultMessage : typeof v, `${f}: ${id}`).toBe('string')
    }
  })
})

describe("main's language", () => {
  const settings = (code: string): AppSettings => ({ general: { language: code } }) as AppSettings
  /** Bounds a hung run only: the waits end as soon as the held load has started. */
  const HUNG_MS = 20_000

  /** Holds a language's load until released; others load as usual. */
  function hold(code: string): { started: () => boolean; release: (messages: Record<string, string>) => void } {
    let release: ((m: Record<string, string>) => void) | null = null
    held.load = (c) => (c === code ? new Promise((r) => (release = r)) : null)
    return { started: () => release !== null, release: (m) => release!(m) }
  }

  it('the latest request wins: back to the language shown drops a switch still loading', async () => {
    const main = await import('../src/main/i18n')
    await main.startI18n(settings('en'))
    const pl = hold('pl')
    const toPolish = main.switchLanguage(settings('pl'))
    await vi.waitFor(() => expect(pl.started()).toBe(true), { timeout: HUNG_MS })
    expect(await main.switchLanguage(settings('en'))).toBeNull()
    pl.release({ 'language.setting.title': 'Język' })
    expect(await toPolish).toBeNull()
    expect(language()).toBe('en')
    expect(main.languageInfo().code).toBe('en')
  })

  it('…and a newer language wins over an older one still loading', async () => {
    const main = await import('../src/main/i18n')
    await main.startI18n(settings('en'))
    const pl = hold('pl')
    const toPolish = main.switchLanguage(settings('pl'))
    await vi.waitFor(() => expect(pl.started()).toBe(true), { timeout: HUNG_MS })
    expect((await main.switchLanguage(settings('de')))?.code).toBe('de')
    pl.release({ 'language.setting.title': 'Język' })
    expect(await toPolish).toBeNull()
    expect(language()).toBe('de')
    expect(main.languageInfo()).toMatchObject({ code: 'de', locale: 'de', startCode: 'en' })
  })

  it('a language chosen without translations is shown, its text in English', async () => {
    const main = await import('../src/main/i18n')
    await main.startI18n(settings('en'))
    // An empty catalogue stands for a language with no translations yet, whatever locales/ja holds (#894).
    held.load = (c) => (c === 'ja' ? Promise.resolve({}) : null)
    expect(await main.switchLanguage(settings('ja'))).toMatchObject({ code: 'ja', messages: {} })
    expect(tr(LANGUAGE_TEXT.title)).toBe('Language')
    expect(main.languageInfo().automatic).toBe('en')
  })
})

describe('agent-facing scripts never load the translations', () => {
  // hive-mcp.js and hive-progress.js run outside the asar with Node built-ins and Combwork's own chunks only (AGENTS.md):
  // a shared module they import that imports a package the build leaves in node_modules would break them, and
  // agent-facing text stays English. The one package they reach is agent text's formatter, intl-messageformat, which the
  // build bundles into the chunks (electron.vite.config.ts, HI-2433); never the window's translations. msg.ts and
  // the modules of messages and languages import nothing, so data modules (the settings catalogue) may hold messages;
  // locale.ts neither, so dates.ts can word its dates in the language (#851).
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(from), spec)
    return [`${base}.ts`, `${base}.mts`, base, join(base, 'index.ts')].find((f) => /\.m?ts$/.test(f) && existsSync(f)) ?? null
  }
  const reach = (entry: string): { files: string[]; packages: string[] } => {
    const seen = new Set<string>()
    const packages = new Set<string>()
    const todo = [entry]
    while (todo.length) {
      const f = todo.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue
        const next = resolveImport(f, m[1])
        if (next) todo.push(next)
        else packages.add(m[1])
      }
    }
    return { files: [...seen].map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/')), packages: [...packages] }
  }
  it.each(['src/main/mcp/cw-mcp.ts', 'src/main/progressReporters/cw-progress.ts'])('%s', (entry) => {
    const { files, packages } = reach(join(ROOT, entry))
    expect(files.length).toBeGreaterThan(1)
    expect(files.filter((f) => f.startsWith('src/shared/i18n/') && !/\/(msg|languages|languageText|locale)\.ts$/.test(f))).toEqual([])
    expect(packages.filter((p) => p.startsWith('@formatjs/'))).toEqual([])
    // Node's built-ins, and agent text's formatter, which the build bundles into the chunks for them (HI-2433).
    expect(packages.filter((p) => !builtinModules.includes(p.replace(/^node:/, '')) && p !== 'intl-messageformat')).toEqual([])
  })
})

describe('the e2e build follows the translations', () => {
  it('changing, adding or removing a translation file changes the build inputs, so --build builds again', () => {
    expect(BUILD_INPUTS).toContain('locales')
    const root = tempDir('i18n-build-inputs')
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      mkdirSync(join(root, 'locales', 'pl'), { recursive: true })
      writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
      writeFileSync(join(root, 'locales', 'pl', 'language.json'), '{ "a": "A" }\n')
      const first = buildInputs(root)
      writeFileSync(join(root, 'locales', 'pl', 'language.json'), '{ "a": "Ą" }\n')
      const changed = buildInputs(root)
      mkdirSync(join(root, 'locales', 'de'), { recursive: true })
      writeFileSync(join(root, 'locales', 'de', 'language.json'), '{}\n')
      const added = buildInputs(root)
      rmSync(join(root, 'locales', 'de'), { recursive: true })
      const removed = buildInputs(root)
      expect(new Set([first, changed, added]).size).toBe(3)
      expect(removed).toBe(changed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('tests run in English', () => {
  it('a test Combwork is pinned to English unless a suite says otherwise', () => {
    const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { hiveEnv: (vars?: Record<string, string>, parent?: Record<string, string>) => Record<string, string> }
    expect(ctx.hiveEnv({ CW_USER_DATA: 'C:\\p' }, { CW_LANG: 'pl' }).CW_LANG).toBe('en')
    expect(ctx.hiveEnv({ CW_USER_DATA: 'C:\\p', CW_LANG: 'en-XA' }, {}).CW_LANG).toBe('en-XA')
  })
})
