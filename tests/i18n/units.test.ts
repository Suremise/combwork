import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fmt, setLanguage } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { formatBytes, formatGigabytes, formatSize, formatTokens } from '../../src/shared/units'
import { formatDate, formatDayLabel, formatTime, formatWeekdayTime, type DateStyle } from '../../src/shared/dates'

// #851 (F3): sizes, token counts, percentages and the words in dates are in the language Combwork shows: the number from fmt
// (its decimal separator), the unit a message (`units` area), weekdays, months and AM/PM from Intl in the language's
// locale. The numeric date and time forms stay the user's choice.

const ROOT = resolve(__dirname, '../..')
const at = new Date(2026, 9, 5, 14, 5) // Monday 5 October 2026, 14:05
const style = (date: DateStyle['date'], time: DateStyle['time']): DateStyle => ({ date, time })

afterEach(() => setLanguage('en', {}))

describe('the units area', () => {
  it('locales/en/units.json has a note for translators on every message, each saying {n} comes formatted', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/units.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en).sort()).toEqual(['units.size.bytes', 'units.size.gigabytes', 'units.size.kilobytes', 'units.size.megabytes', 'units.tokens.billions', 'units.tokens.millions', 'units.tokens.thousands'])
    for (const [id, m] of Object.entries(en)) {
      expect(m.defaultMessage, id).toContain('{n}')
      expect(m.description, id).toContain('already formatted')
    }
  })

  it('reads in English as Combwork always showed it', () => {
    expect([formatTokens(950), formatTokens(12_345), formatTokens(5_500_000), formatTokens(12.9e9)]).toEqual(['950', '12.3k', '5.5M', '12.9B'])
    expect([formatBytes(160), formatBytes(1536), formatBytes(3.4 * 1024 ** 2)]).toEqual(['160 B', '1.5 KB', '3.4 MB'])
    expect([formatSize(0), formatSize(820 * 1024), formatSize(6.1 * 1024 ** 2), formatSize(2.4 * 1024 ** 3), formatGigabytes(16 * 1024 ** 3)]).toEqual(['0 KB', '820 KB', '6.1 MB', '2.4 GB', '16.0 GB'])
    expect([fmt.percent(0.45), fmt.percent(0.004, 1), fmt.figure(1234.5, 1)]).toEqual(['45%', '0.4%', '1234.5'])
    expect([formatTime(at, style('ymd', '12h')), formatWeekdayTime(at), formatDayLabel(at)]).toEqual(['2:05 PM', 'Mon 14:05', 'Mon, Oct 5'])
  })

  it("in Polish: the language's decimal comma and words, the user's date and time forms kept", () => {
    setLanguage('pl', {}, 'pl-PL')
    expect([formatTokens(12_345), formatTokens(5_500_000), formatBytes(1536), formatSize(6.1 * 1024 ** 2), formatGigabytes(9.5 * 1024 ** 3)]).toEqual(['12,3k', '5,5M', '1,5 KB', '6,1 MB', '9,5 GB'])
    expect(fmt.percent(0.45)).toMatch(/^45\s?%$/)
    expect(formatDate(at)).toBe('2026-10-05')
    expect(formatTime(at)).toBe('14:05')
    expect(formatWeekdayTime(at)).toBe('pon., 14:05')
    expect(formatDayLabel(at)).toMatch(/^pon\., 5 paź/)
  })

  it('in Japanese and Chinese: the weekday marked as one, and a list of units joined with 、 (#893)', () => {
    setLanguage('ja', {}, 'ja-JP')
    expect(formatWeekdayTime(at)).toBe('14:05 (月)')
    expect(fmt.list(['One', 'Two', 'Three'], 'unit')).toBe('One、Two、Three')
    setLanguage('zh-CN', {})
    expect(formatWeekdayTime(at)).toBe('周一14:05')
    expect(fmt.list(['One', 'Two', 'Three'], 'unit')).toBe('One、Two、Three')
    // Other languages keep CLDR's unit list.
    setLanguage('en', {})
    expect(fmt.list(['One', 'Two', 'Three'], 'unit')).toBe('One, Two, Three')
  })

  it('a translated unit is used, and AM and PM are in the language', () => {
    setLanguage('fr', { 'units.size.kilobytes': '{n} Ko', 'units.tokens.thousands': '{n} k' }, 'fr-FR')
    expect([formatBytes(1536), formatSize(820 * 1024), formatTokens(12_345)]).toEqual(['1,5 Ko', '820 Ko', '12,3 k'])
    // A percentage with the language's spacing (Settings' range rows, round 1 of review): "50 %" in French.
    expect(fmt.percent(0.5)).toBe('50\u00a0%')
    setLanguage('ja', {}, 'ja-JP')
    expect(formatTime(at, style('ymd', '12h'))).toBe('午後2:05')
  })

  it('under the pseudo-locale the units are the pseudo-locale’s, the figure kept', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const t = formatBytes(1536)
    expect(t.startsWith('[1.5 ĶƁ')).toBe(true)
  })
})
