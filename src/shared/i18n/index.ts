/**
 * Combwork's translations (#767): one FormatJS core for the main process and the window. Text is written in the code as a
 * message (`msg()`: an id, the English and a note for translators) and shown with `tr()` (not `t`: Combwork's code uses
 * `t` for times and tasks, and lint forbids shadowing), which formats it in the current language with ICU
 * MessageFormat (plurals, select, named placeholders). The English catalogue `locales/en/<area>.json` is extracted from
 * the code; translators edit `locales/<code>/<area>.json`. A message a language lacks, or one whose translation can't
 * be formatted (a renamed placeholder, broken ICU), shows in English: a translation can't break Combwork.
 *
 * Text is translated when it is shown, never when a module loads: keep messages (descriptors) in data, and call
 * `tr()` at render or send time, so a change of language reaches it. Agent-facing text stays English and never comes
 * through here: cw-mcp.js and cw-progress.js must not import this module (a unit test checks).
 */
import { createIntl, createIntlCache, type IntlShape } from '@formatjs/intl'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE, SOURCE_LANGUAGE, languageOf } from './languages'
import { setFormatLocale } from './locale'
import type { MessageArgs, Msg, Values } from './msg'

export { msg, type Msg, type Values } from './msg'

/** A language's translations: id → ICU message. */
export type Catalogue = Record<string, string>

const cache = createIntlCache()
let current = SOURCE_LANGUAGE
let intl: IntlShape<string> = build(SOURCE_LANGUAGE, SOURCE_LANGUAGE, {})
const listeners = new Set<(code: string) => void>()
/** Problems already reported in this language, so each is reported once. */
const reported = new Set<string>()
let onProblem: (text: string) => void = () => undefined

function build(code: string, locale: string, messages: Catalogue): IntlShape<string> {
  return createIntl(
    {
      locale,
      defaultLocale: SOURCE_LANGUAGE,
      messages,
      onError: (err) => {
        // Not translated yet: English, quietly. Anything else (a translation that doesn't parse, a placeholder it
        // renamed) is the translation's fault: English too, reported once.
        if (err.code === 'MISSING_TRANSLATION') return
        // Its id and why, in a line: FormatJS's own text runs to many lines, with the message and its note.
        const id = (err as { descriptor?: { id?: unknown } }).descriptor?.id
        const lines = err.message.split('\n')
        const why = lines.find((l) => /^\w*Error: /.test(l)) ?? lines[0]
        const key = `${code}:${typeof id === 'string' ? id : why}`
        if (reported.has(key)) return
        reported.add(key)
        onProblem(`i18n (${code}): ${typeof id === 'string' ? `${id}: ` : ''}${why}`)
      }
    },
    cache
  )
}

/**
 * Shows Combwork in this language from now on, with its translations, formatting dates and numbers for `locale` (a BCP 47
 * tag; the language's code by default). Everything formatted after this call uses it, and listeners (the window's
 * store, main's tray) show it again.
 */
export function setLanguage(code: string, messages: Catalogue, locale = code): void {
  current = code
  pseudoCache.clear()
  intl = build(code, code === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : locale, messages)
  setFormatLocale(intl.locale)
  for (const l of listeners) l(code)
}

/** The language Combwork shows now (a language's code, or the pseudo-locale). */
export const language = (): string => current

/** The locale Intl formats with now. */
export const locale = (): string => intl.locale

/** Called on each change of language. Returns the unsubscribe. */
export function onLanguageChange(fn: (code: string) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Where translation problems are reported (the main process's log; the window's console). */
export function setProblemReporter(fn: (text: string) => void): void {
  onProblem = fn
}

const shown = (m: Msg): Msg => (current === PSEUDO_LANGUAGE ? { ...m, defaultMessage: pseudoOf(m) as unknown as string } : m)

/** A message in the current language. */
export function tr<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): string {
  return intl.formatMessage(shown(m), values[0] as Values | undefined) as string
}

/**
 * A message with markup: tags in it (`<b>…</b>`) become what `values` gives for them (a function of their content),
 * and placeholders may be elements. Returns the parts, for React to render.
 */
export function tRich<T>(m: Msg, values: Record<string, T | string | number | Date | ((chunks: (string | T)[]) => T)>): (string | T)[] {
  const out = intl.formatMessage(shown(m), values as never) as unknown
  return Array.isArray(out) ? (out as (string | T)[]) : [out as string]
}

/** Numbers, money, relative times, dates and lists in the current language (Intl, through FormatJS). */
export const fmt = {
  number: (n: number, opts?: Parameters<IntlShape['formatNumber']>[1]): string => intl.formatNumber(n, opts),
  /** Dollars (providers price in USD): "$1.84", "1,84 USD", "US$ 1,84". */
  usd: (n: number): string => intl.formatNumber(n, { style: 'currency', currency: 'USD' }),
  /** How long ago (negative) or how far ahead, in the largest whole unit: "4 minutes ago", "vor 4 Minuten", "yesterday". */
  relative: (ms: number, style: 'long' | 'short' = 'long'): string => {
    const s = Math.round(ms / 1000)
    const abs = Math.abs(s)
    const [v, unit]: [number, Intl.RelativeTimeFormatUnit] =
      abs < 60 ? [s, 'second'] : abs < 3600 ? [Math.round(s / 60), 'minute'] : abs < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day']
    return intl.formatRelativeTime(v, unit, { numeric: 'auto', style })
  },
  /** A day relative to today, in words where the language has them: 0 "today", -1 "yesterday", "heute", "gestern". */
  day: (offset: number): string => intl.formatRelativeTime(offset, 'day', { numeric: 'auto' }),
  /** A number with exactly this many decimals and no grouping, for a figure beside a unit: "1.5", "1,5", "450". */
  figure: (n: number, decimals: number): string => intl.formatNumber(n, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false }),
  /** A share (0.25 is a quarter) as a percentage, with at most this many decimals: "25%", "25 %", "0.4%". */
  percent: (share: number, decimals = 0): string => intl.formatNumber(share, { style: 'percent', maximumFractionDigits: decimals }),
  /** A date and time in the language's medium form: "13 Oct 2026, 23:40", "13 paź 2026, 23:40". */
  dateTime: (d: Date | number): string => intl.formatDate(d, { dateStyle: 'medium', timeStyle: 'short' }),
  /** "Claude, Codex and Copilot", "Claude, Codex i Copilot"; unit: "5 running, 2 failed" (no "and"). */
  list: (items: readonly string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction'): string =>
    type === 'unit' && languageOf(current)?.unitList === 'narrow' ? intl.formatList(items, { type: 'conjunction', style: 'narrow' }) : intl.formatList(items, { type, style: type === 'unit' ? 'short' : 'long' })
}

// --- The pseudo-locale: every message's text accented and about 30% longer, in [brackets], its placeholders, plurals
// and tags kept, so text that was missed shows plain, and text that is cut off or overflows shows it.

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž'
}
/** What lengthens a message: accented too, so it reads as the pseudo-locale's and never as missed English. */
const PAD = ' one two three four five six seven eight nine ten'
const pseudoCache = new Map<string, MessageFormatElement[]>()

/** A text's letters accented, as the pseudo-locale shows them. */
export function pseudoText(s: string): string {
  return [...s].map((c) => ACCENTS[c] ?? c).join('')
}

function pseudoElements(els: MessageFormatElement[]): MessageFormatElement[] {
  return els.map((el) => {
    if (el.type === TYPE.literal) return { ...el, value: pseudoText(el.value) }
    if (el.type === TYPE.tag) return { ...el, children: pseudoElements(el.children) }
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      return { ...el, options: Object.fromEntries(Object.entries(el.options).map(([k, o]) => [k, { ...o, value: pseudoElements(o.value) }])) }
    }
    return el
  })
}

/** Letters in a message's literal text (what the 30% is of). */
function letters(els: MessageFormatElement[]): number {
  let n = 0
  for (const el of els) {
    if (el.type === TYPE.literal) n += el.value.length
    else if (el.type === TYPE.tag) n += letters(el.children)
    else if (el.type === TYPE.plural || el.type === TYPE.select) n += letters(el.options.other?.value ?? [])
  }
  return n
}

/** A message as the pseudo-locale shows it: FormatJS takes the parsed form in place of the English. */
function pseudoOf(m: Msg): MessageFormatElement[] {
  let ast = pseudoCache.get(m.id)
  if (ast) return ast
  let parsed: MessageFormatElement[]
  try {
    parsed = parse(m.defaultMessage)
  } catch {
    parsed = [{ type: TYPE.literal, value: m.defaultMessage }]
  }
  const extra = Math.max(2, Math.round(letters(parsed) * 0.3))
  ast = [{ type: TYPE.literal, value: '[' }, ...pseudoElements(parsed), { type: TYPE.literal, value: `${pseudoText(PAD.repeat(Math.ceil(extra / PAD.length)).slice(0, extra))}]` }]
  pseudoCache.set(m.id, ast)
  return ast
}
