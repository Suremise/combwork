/**
 * The language Combwork shows (#767). Chosen before Electron is ready, because Chromium takes its language (--lang: the
 * window's navigator.language and Intl defaults, Accept-Language, its own dialogs) only at start: the --lang start
 * option or CW_LANG (tests, screenshots, translators checking their work), else Settings → General → Language, else
 * the first of Windows' display languages Combwork has translations for, else English. Main loads the language's
 * translations once and gives them to each window (app:info, language-changed). A later change of the setting switches
 * Combwork's own text at once; Chromium's own parts follow at the next start.
 */
import { app } from 'electron'
import { language, setLanguage, setProblemReporter, type Catalogue } from '../shared/i18n'
import { availableLanguages, loadCatalogue } from '../shared/i18n/catalogues'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE, resolveLanguage, type ChosenLanguage, type LanguageSetting } from '../shared/i18n/languages'
import { setRegionalFormat } from '../shared/dates'
import type { AppSettings, LanguageInfo } from '../shared/types'
import { createLogger } from './logger'

const log = createLogger('i18n')

/** The start option (--lang=pl) or CW_LANG: wins over the setting, for this run only. */
let forced: string | null = null
/** The language Chromium was started in. */
let started: ChosenLanguage = { code: SOURCE_LANGUAGE, locale: SOURCE_LANGUAGE }
let shown: ChosenLanguage = started
let messages: Catalogue = {}
/** Each request's number: a slower load that a newer request overtook is dropped, whatever that request asked for. */
let requests = 0

const choose = (setting: LanguageSetting | undefined): ChosenLanguage => resolveLanguage(setting, app.getPreferredSystemLanguages(), availableLanguages(), forced)

/**
 * Before ready: works out the language and starts Chromium in it, from the setting as config.json has it (the config
 * isn't loaded yet).
 */
export function chooseStartLanguage(saved: LanguageSetting | undefined): void {
  // Read before Combwork sets Chromium's --lang itself, which getSwitchValue would then return. CW_LANG pins tests'
  // language (unpackaged builds only, like Combwork's other test switches).
  forced = app.commandLine.getSwitchValue('lang') || (!app.isPackaged && process.env.CW_LANG) || null
  started = shown = choose(saved)
  // The pseudo-locale is English to Chromium.
  app.commandLine.appendSwitch('lang', started.code === PSEUDO_LANGUAGE ? 'en-US' : started.locale)
}

/** Shows the language for request n; false when a newer request overtook it while its translations loaded. */
async function show(chosen: ChosenLanguage, n: number): Promise<boolean> {
  const t0 = performance.now()
  const loaded = await loadCatalogue(chosen.code, (text) => log.warn(text))
  if (n !== requests) return false
  messages = loaded
  shown = chosen
  setLanguage(chosen.code, messages, chosen.locale)
  log.info(`Language ${chosen.code} (${chosen.locale}; ${Object.keys(messages).length} translations, ${Math.round(performance.now() - t0)} ms; Windows: ${app.getPreferredSystemLanguages().join(', ')}, regional format ${app.getSystemLocale()}${forced ? `; forced: ${forced}` : ''})`)
  return true
}

/** After ready, before anything shows text: main's own text (notifications, the tray, dialogs) in the language. */
export async function startI18n(settings: AppSettings): Promise<void> {
  setProblemReporter((text) => log.warn(text))
  setRegionalFormat(app.getSystemLocale())
  await show(choose(settings.general.language), ++requests)
}

/**
 * The setting changed: switches main to the language it now picks, and returns what the windows need to follow
 * (language-changed); null when Combwork's language stays the same.
 */
export async function switchLanguage(settings: AppSettings): Promise<LanguageInfo | null> {
  const next = choose(settings.general.language)
  // The latest request wins: also one for the language shown now, which drops a switch away from it still loading.
  const n = ++requests
  if (next.code === language() && next.locale === shown.locale) return null
  return (await show(next, n)) ? languageInfo() : null
}

/** The language for a window: it, its translations, and what the picker says about it. */
export function languageInfo(): LanguageInfo {
  return {
    code: shown.code,
    locale: shown.locale,
    startCode: started.code,
    automatic: resolveLanguage('auto', app.getPreferredSystemLanguages(), availableLanguages()).code,
    available: availableLanguages(),
    regionalFormat: app.getSystemLocale(),
    forced,
    messages
  }
}
