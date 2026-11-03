/**
 * The text of Settings → General → Language (#767): its row in the settings catalogue and its picker. Messages only, so
 * the catalogue (which agent scripts reach) can hold them without loading FormatJS.
 */
import { msg } from './msg'

export const LANGUAGE_TEXT = {
  title: msg({ id: 'language.setting.title', defaultMessage: 'Language', description: "The setting's title in Settings → General. In any language but English, Hive adds \"(Language)\" after it, so someone who can't read the language can find the way back." }),
  desc: msg({ id: 'language.setting.desc', defaultMessage: "The language Combwork shows. Automatic follows Windows' display languages.", description: "Under the Language setting's title." }),
  tip: msg({
    id: 'language.setting.tip',
    defaultMessage: 'Languages marked as translated by AI were drafted by agents, and improvements are welcome. Combwork speaks to agents and the Assistant in English whatever this says; they can still answer you in your language. Combwork started with --lang uses that language until it next starts.',
    description: "The Language setting's info tip. --lang is a start option: keep it as it is."
  }),
  automatic: msg({ id: 'language.automatic', defaultMessage: 'Automatic (Windows: {language})', description: "The first choice in the language list. {language} is the language it picks now, by that language's own name (Deutsch, Polski)." }),
  forced: msg({ id: 'language.forced', defaultMessage: 'Combwork was started in {language} (--lang): this setting applies from its next start.', description: 'Under the language list when a start option chose the language. {language} is its code (pl, en-XA). --lang is a start option: keep it as it is.' }),
  restart: msg({ id: 'language.restart', defaultMessage: "Combwork's own text has changed language. Chromium's parts (the PDF viewer, date pickers) follow when Combwork next starts.", description: 'Under the language list after the language was changed, until Hive restarts. Chromium is the browser engine Hive is built on: keep the name.' })
}
