/**
 * The locale Combwork formats in (#851), for modules that can't import FormatJS: shared/dates.ts is reached by cw-mcp.js,
 * which may only load Node's built-ins and modules that import nothing. setLanguage() (index.ts) keeps it current;
 * until then it is English. Imports nothing.
 */
let current = 'en'

/** Set by setLanguage(): the locale Intl formats with. */
export function setFormatLocale(locale: string): void {
  current = locale
}

/** Parts of a date in the current language's words and order: `{ weekday: 'short' }` is "Mon", "pon.". */
export function dateWords(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(current, opts).format(d)
}
