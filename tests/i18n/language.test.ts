import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { createIntl } from '@formatjs/intl'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'
import { loadCatalogue } from '../../src/shared/i18n/catalogues'
import { LANGUAGE_TEXT } from '../../src/shared/i18n/languageText'
import { checkSettingValue, settingEntry, settingOptions } from '../../src/shared/settingsCatalog'
import { DEFAULT_SETTINGS } from '../../src/shared/defaults'

// #767: the `language` area. Its English catalogue and typed values match its messages, its Polish formats, and its
// row in the settings catalogue keeps the English for the Assistant's tools.

const ROOT = resolve(__dirname, '../..')
const MESSAGES: Msg[] = Object.values(LANGUAGE_TEXT)

afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
})

/** A message's placeholders (tags aside), as the typed values name them. */
function placeholders(els: MessageFormatElement[], acc = new Set<string>()): Set<string> {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue
    if (el.type !== TYPE.tag) acc.add(el.value)
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) placeholders(o.value, acc)
    if (el.type === TYPE.tag) placeholders(el.children, acc)
  }
  return acc
}

describe('the language area', () => {
  it('locales/en/language.json is its messages, by id', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/language.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en)).toEqual(MESSAGES.map((m) => m.id).sort())
    for (const m of MESSAGES) expect(en[m.id], m.id).toEqual({ defaultMessage: m.defaultMessage, description: m.description })
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/language.d.ts'), 'utf8')
    for (const m of MESSAGES) {
      const line = dts.split(/\r?\n/).find((l) => l.trim().startsWith(`'${m.id}':`))
      expect(line, m.id).toBeTruthy()
      const names = [...placeholders(parse(m.defaultMessage))]
      if (!names.length) expect(line, m.id).toMatch(/: undefined$/)
      for (const n of names) expect(line, `${m.id}: ${n}`).toContain(`${n}: `)
    }
  })

  it('every message has a note for translators', () => {
    for (const m of MESSAGES) expect(m.description.length, m.id).toBeGreaterThan(10)
  })

  // #792: the expected text is the catalogue's own, formatted apart from Hive, so a translator can change the wording
  // without changing this test; a broken placeholder still fails here and in i18n:check.
  it('Polish formats every message it has, with the English placeholders', async () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    const pl = await loadCatalogue('pl')
    setLanguage('pl', pl, 'pl-PL')
    const apart = createIntl({ locale: 'pl-PL', messages: pl, onError: (e) => problems.push(`apart: ${e.message}`) })
    for (const m of MESSAGES) {
      if (!pl[m.id]) continue
      expect([...placeholders(parse(pl[m.id]))].sort(), m.id).toEqual([...placeholders(parse(m.defaultMessage))].sort())
      const values = Object.fromEntries([...placeholders(parse(m.defaultMessage))].map((n) => [n, `‹${n}›`]))
      expect(tr(m, values), m.id).toBe(apart.formatMessage({ id: m.id }, values))
    }
    // The placeholder is filled, whatever the words around it.
    expect(tr(LANGUAGE_TEXT.automatic, { language: 'Polski' })).toContain('Polski')
    expect(problems).toEqual([])
  })
})

describe('Settings → General → Language in the catalogue', () => {
  const e = settingEntry('general.language')!

  it('is a row with its messages; its English stays for the Assistant', () => {
    expect(e).toBeTruthy()
    expect(e.title).toBe('Language')
    expect(e.text?.title).toBe(LANGUAGE_TEXT.title)
    expect(e.text?.englishTitle).toBe(true)
    expect(e.docs).toBe('language')
    expect(DEFAULT_SETTINGS.general.language).toBe('auto')
  })

  it('the Assistant sets it by English name or code', () => {
    expect(settingOptions(e)?.map((o) => o.value)).toEqual(['auto', 'de', 'en', 'es', 'fr', 'pl', 'pt-BR', 'ja', 'zh-CN'])
    expect(checkSettingValue(e, 'Polish')).toEqual({ value: 'pl' })
    expect(checkSettingValue(e, 'zh-CN')).toEqual({ value: 'zh-CN' })
    expect(checkSettingValue(e, 'automatic')).toEqual({ value: 'auto' })
    expect('error' in checkSettingValue(e, 'Klingon')).toBe(true)
  })
})
