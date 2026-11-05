/**
 * Combwork's languages (#767): which there are, what each is called in itself, and which one Combwork shows. English is the
 * source; the others are drafted by agents and say so in the picker, in their own words, until a native speaker has
 * reviewed them. Every language can be chosen, and what it hasn't translated yet shows in English; Automatic picks one
 * only once it has translations (a `locales/<code>/` folder), so Windows alone never gives anyone a language that is
 * still all English. Pure data and helpers, no FormatJS: the main process resolves the language before Electron is
 * ready (Chromium's --lang), and the window shows the picker.
 */

export interface Language {
  /** BCP 47 tag, as its folder is named (locales/<code>/). */
  code: string
  /** Its own name, as the picker shows it: Deutsch, Polski, 日本語. */
  name: string
  /** Its name in English, for the log and the docs. */
  english: string
  /** Drafted by AI and not reviewed by a native speaker yet: marked in the picker, with its note under it. */
  ai: boolean
  /** The picker's short mark after its name, in its own words: "Polski (AI)". */
  aiMark?: string
  /** The note under the picker, in its own words, so someone choosing it from another language can read it. */
  aiNote?: string
  dir: 'ltr' | 'rtl'
  /**
   * A list of units ("5 running, 2 failed") joined as a narrow conjunction: where CLDR's unit list joins with spaces
   * (Japanese) or nothing (Chinese), its narrow conjunction gives 、 (#893).
   */
  unitList?: 'narrow'
  /**
   * Windows' UI font for its script, for the windows Combwork draws without Chromium (the "Hive can't start" window): Segoe
   * UI has no CJK, so Windows' fallback mixes typefaces and narrows ，。 (#893). Segoe UI when not set.
   */
  uiFont?: string
}

export const SOURCE_LANGUAGE = 'en'

/**
 * In the picker's order: by own name, Latin scripts first. Names, marks and notes are in each language's own words,
 * the same whatever language Combwork shows, so they are never translated.
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'de', name: 'Deutsch', english: 'German', ai: true, aiMark: '(KI)', aiNote: 'Von KI übersetzt, Verbesserungen sind willkommen.', dir: 'ltr' },
  { code: 'en', name: 'English', english: 'English', ai: false, dir: 'ltr' },
  { code: 'es', name: 'Español', english: 'Spanish', ai: true, aiMark: '(IA)', aiNote: 'Traducido por IA: las mejoras son bienvenidas.', dir: 'ltr' },
  { code: 'fr', name: 'Français', english: 'French', ai: true, aiMark: '(IA)', aiNote: 'Traduit par IA : les améliorations sont les bienvenues.', dir: 'ltr' },
  { code: 'pl', name: 'Polski', english: 'Polish', ai: true, aiMark: '(AI)', aiNote: 'Przetłumaczone przez AI, poprawki mile widziane.', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', english: 'Portuguese (Brazil)', ai: true, aiMark: '(IA)', aiNote: 'Traduzido por IA: melhorias são bem-vindas.', dir: 'ltr' },
  { code: 'ja', name: '日本語', english: 'Japanese', ai: true, aiMark: '(AI)', aiNote: 'AI による翻訳です。改善を歓迎します。', dir: 'ltr', unitList: 'narrow', uiFont: 'Yu Gothic UI' }, // i18n-ignore: names: the language's English name (for the log) and a font's
  { code: 'zh-CN', name: '简体中文', english: 'Chinese (Simplified)', ai: true, aiMark: '(AI)', aiNote: '由 AI 翻译，欢迎改进。', dir: 'ltr', unitList: 'narrow', uiFont: 'Microsoft YaHei UI' } // i18n-ignore: names: the language's English name (for the log) and a font's
]

/**
 * The pseudo-locale: English with accents and about 30% longer, in brackets, to find text that was missed and layouts
 * that break. Only from the start option or CW_LANG (tests, screenshots), never in the picker.
 */
export const PSEUDO_LANGUAGE = 'en-XA'

/** Settings → General → Language: 'auto' (Windows' display languages) or a language's code. */
export type LanguageSetting = 'auto' | string

/** Combwork's language a tag asks for (its code), or null. */
export const languageOf = (code: string): Language | undefined => LANGUAGES.find((l) => l.code === code) ?? (code === PSEUDO_LANGUAGE ? LANGUAGES.find((l) => l.code === SOURCE_LANGUAGE) : undefined)

/**
 * The language of ours a BCP 47 tag asks for, or null: an exact match, then by its language (de-AT → de, pt-PT → pt-BR,
 * the only Portuguese), with Chinese by script: Simplified (zh, zh-CN, zh-SG, zh-Hans-*) only, never Traditional
 * (zh-TW, zh-HK, zh-MO, zh-Hant-*), whose readers are better served by the next language they listed, or English.
 * `available` limits it to the languages that have translations; `pseudo` lets it be the pseudo-locale.
 */
export function matchLanguage(tag: string, available?: readonly string[], pseudo = false): string | null {
  const t = tag.trim().replace(/_/g, '-').toLowerCase()
  if (!t) return null
  if (pseudo && t === PSEUDO_LANGUAGE.toLowerCase()) return PSEUDO_LANGUAGE
  const offered = available ? LANGUAGES.filter((l) => l.code === SOURCE_LANGUAGE || available.includes(l.code)) : LANGUAGES
  const exact = offered.find((l) => l.code.toLowerCase() === t)
  if (exact) return exact.code
  const [lang, ...rest] = t.split('-')
  if (lang === 'zh' && rest.some((x) => x === 'hant' || x === 'tw' || x === 'hk' || x === 'mo')) return null
  return offered.find((l) => l.code.toLowerCase().split('-')[0] === lang)?.code ?? null
}

/** What Combwork shows and how it formats: the language, and the locale for dates and numbers. */
export interface ChosenLanguage {
  /** Combwork's language: its translations. */
  code: string
  /** The locale Intl formats with: the Windows tag that chose it (en-GB, de-AT), else the code (the pseudo-locale: en). */
  locale: string
}

/**
 * The language Combwork shows: a forced one (the --lang start option or CW_LANG, for tests, screenshots and translators,
 * which may be the pseudo-locale or a language with no translations yet), else the setting, else the first of
 * Windows' preferred display languages Combwork has translations for (`available`), else English. The setting may name
 * any of Combwork's languages: it was chosen.
 */
export function resolveLanguage(setting: LanguageSetting | undefined, preferred: readonly string[], available: readonly string[], forced?: string | null): ChosenLanguage {
  const f = forced ? matchLanguage(forced, undefined, true) : null
  if (f) return { code: f, locale: f === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : forced!.trim().replace(/_/g, '-') }
  const s = setting && setting !== 'auto' ? matchLanguage(setting) : null
  // A chosen language formats as Windows does when Windows asks for it too (Polski on pl-PL: pl-PL's dates).
  const regional = (code: string): string => preferred.find((p) => matchLanguage(p) === code) ?? code
  if (s) return { code: s, locale: regional(s) }
  for (const p of preferred) {
    const m = matchLanguage(p, available)
    if (m) return { code: m, locale: p }
  }
  return { code: SOURCE_LANGUAGE, locale: SOURCE_LANGUAGE }
}
