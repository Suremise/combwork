/**
 * The window's language (#767): set before the first render, so nothing shows in English first, and again when
 * Settings → General → Language changes (language-changed), which renders the window again in it (store.useLanguage).
 * Main loads the translations and sends them with the language: the window loads no catalogue of its own.
 */
import { setLanguage, setProblemReporter } from '@shared/i18n'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE, languageOf } from '@shared/i18n/languages'
import { setRegionalFormat } from '@shared/dates'
import type { LanguageInfo } from '@shared/types'
import { call } from './api'

setProblemReporter((text) => console.warn(text))

/** Shows the window in a language: its messages, and the page's lang and dir (screen readers; right-to-left later). */
export function applyLanguage(info: LanguageInfo): void {
  setRegionalFormat(info.regionalFormat)
  setLanguage(info.code, info.messages, info.locale)
  document.documentElement.lang = info.code === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : info.code
  document.documentElement.dir = languageOf(info.code)?.dir ?? 'ltr'
}

/** Before the first render: the language main chose, then each change of it. */
export async function initLanguage(): Promise<void> {
  window.combwork.onEvent((e) => {
    if (e.type === 'language-changed') applyLanguage(e.language)
  })
  try {
    applyLanguage((await call('app:info')).language)
  } catch (e) {
    // English, as the messages are written: never a window that doesn't start.
    console.warn('language', e)
  }
}
