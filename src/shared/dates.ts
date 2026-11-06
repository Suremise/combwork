/**
 * Dates and times as the user chose them (Settings → General → Date format and Time): every date Combwork shows goes
 * through these, so one setting changes them all. Each process keeps the current choice (`setDateStyle`, from its
 * settings); a formatter given a style uses that instead. The numeric forms are the user's choice, whatever the language;
 * words (a weekday, a month, AM and PM) are in the language Combwork shows (#851).
 */
import { dateWords } from './i18n/locale'

/** yyyy-mm-dd (2026-10-04), dd/mm/yyyy, mm/dd/yyyy, or Windows' regional format's short date. */
export type DateFormat = 'ymd' | 'dmy' | 'mdy' | 'system'
/** 24-hour (14:05) or 12-hour (2:05 PM). */
export type TimeFormat = '24h' | '12h'
export interface DateStyle {
  date: DateFormat
  time: TimeFormat
}

export const DEFAULT_DATE_STYLE: DateStyle = { date: 'ymd', time: '24h' }
export const DATE_FORMATS: DateFormat[] = ['ymd', 'dmy', 'mdy', 'system']
export const TIME_FORMATS: TimeFormat[] = ['24h', '12h']

let current: DateStyle = DEFAULT_DATE_STYLE

/** The choice formatters use from now on (unknown values fall back to the default). */
export function setDateStyle(s: Partial<DateStyle> | undefined): void {
  current = {
    date: s?.date && DATE_FORMATS.includes(s.date) ? s.date : DEFAULT_DATE_STYLE.date,
    time: s?.time && TIME_FORMATS.includes(s.time) ? s.time : DEFAULT_DATE_STYLE.time
  }
}

export function dateStyle(): DateStyle {
  return current
}

/**
 * Windows' regional format (a BCP 47 tag, en-GB), which System dates follow (#767): not the language Combwork shows, which
 * Chromium's default locale follows once Combwork starts it in that language.
 */
let regional: string | undefined
export function setRegionalFormat(locale: string | undefined): void {
  regional = locale || undefined
}

const toDate = (d: Date | string | number): Date | null => {
  const x = d instanceof Date ? d : new Date(d)
  return isNaN(x.getTime()) ? null : x
}
const pad = (n: number): string => String(n).padStart(2, '0')

/** The date alone: "2026-10-04" (or as chosen); '' for a date that can't be read. */
export function formatDate(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  const [y, m, day] = [x.getFullYear(), pad(x.getMonth() + 1), pad(x.getDate())]
  switch (style.date) {
    case 'dmy':
      return `${day}/${m}/${y}`
    case 'mdy':
      return `${m}/${day}/${y}`
    case 'system':
      return x.toLocaleDateString(regional) // i18n-ignore: System is Windows' regional format by choice, not the language Combwork shows
    default:
      return `${y}-${m}-${day}`
  }
}

/** The time alone: "14:05", or "2:05 PM" ("午後2:05" in Japanese). */
export function formatTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  return style.time === '12h' ? dateWords(x, { hour: 'numeric', minute: '2-digit', hour12: true }) : `${pad(x.getHours())}:${pad(x.getMinutes())}`
}

/** Date and time: "2026-10-04 14:05". */
export function formatDateTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  return x ? `${formatDate(x, style)} ${formatTime(x, style)}` : ''
}

/** When something happened, briefly: the time alone today, else the date and time. */
export function formatWhen(d: Date | string | number, now = new Date(), style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  return x.toDateString() === now.toDateString() ? formatTime(x, style) : formatDateTime(x, style)
}

/**
 * A weekday and time, for something within the coming week: "Mon 14:05". One formatter for both, so the language
 * places and marks the weekday ("09:05 (日)" in Japanese, where 日 alone reads as "day"; #893).
 */
export function formatWeekdayTime(d: Date | string | number, style: DateStyle = current): string {
  const x = toDate(d)
  if (!x) return ''
  return dateWords(x, style.time === '12h' ? { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true } : { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

/** A day under a chart's bar: its weekday, day and month in the language's words and order ("Mon 4 Oct", "pon., 4 paź"). */
export function formatDayLabel(d: Date | string | number): string {
  const x = toDate(d)
  return x ? dateWords(x, { weekday: 'short', day: 'numeric', month: 'short' }) : ''
}

/** How many calendar days before `now` a date is: 0 today, 1 yesterday (whatever the clock change between). */
export function daysAgo(d: Date | string | number, now = new Date()): number {
  const x = toDate(d)
  if (!x) return 0
  const day = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  return Math.round((day(now) - day(x)) / 86_400_000)
}

/** A day in a span of days: "9 Oct" in the language's words and order, with the year when it isn't this year's. */
export function formatShortDay(d: Date | string | number, now = new Date()): string {
  const x = toDate(d)
  return x ? dateWords(x, { day: 'numeric', month: 'short', ...(x.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }) : ''
}

/** A day as a divider's label: "Wednesday 15 Oct" in the language's words and order, with the year when it isn't this year's. */
export function formatLongDay(d: Date | string | number, now = new Date()): string {
  const x = toDate(d)
  return x ? dateWords(x, { weekday: 'long', day: 'numeric', month: 'short', ...(x.getFullYear() !== now.getFullYear() && { year: 'numeric' }) }) : ''
}
