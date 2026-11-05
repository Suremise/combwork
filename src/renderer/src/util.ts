import type { RecentWorkspace } from '@shared/types'
import { formatDate, formatWeekdayTime } from '@shared/dates'
import { fmt, msg, tr } from '@shared/i18n'

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export { formatBytes, formatTokens } from '@shared/units'

/** A number in the language Hive shows: "12,345", "12 345". */
export const formatNumber = (n: number): string => fmt.number(n)

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!t) return '—'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return tr(msg({ id: 'actions.ago.justNow', defaultMessage: 'just now', description: "When something happened, under a minute ago (inbox, sessions, cards). Lower case. It also follows a participle (\"saved {when}\", \"Updated {when}\", \"changed {changed}\"): where it can't, the translation of those messages puts it elsewhere." }))
  const m = s < 90 ? 1 : Math.round(s / 60)
  if (m < 60) return tr(msg({ id: 'actions.ago.minutes', defaultMessage: '{n, plural, one {# minute ago} other {# minutes ago}}', description: "When something happened, in minutes (inbox, sessions, cards). Lower case. It also follows a participle (\"saved {when}\", \"Updated {when}\", \"changed {changed}\"): where it can't, the translation of those messages puts it elsewhere." }), { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return tr(msg({ id: 'actions.ago.hours', defaultMessage: '{n, plural, one {# hour ago} other {# hours ago}}', description: "When something happened, in hours (inbox, sessions, cards). Lower case. It also follows a participle (\"saved {when}\", \"Updated {when}\", \"changed {changed}\"): where it can't, the translation of those messages puts it elsewhere." }), { n: h })
  const d = Math.round(h / 24)
  if (d < 30) return d === 1 ? tr(msg({ id: 'actions.ago.yesterday', defaultMessage: 'yesterday', description: "When something happened: a day ago (inbox, sessions, cards). Lower case. It also follows a participle (\"saved {when}\", \"Updated {when}\", \"changed {changed}\"): where it can't, the translation of those messages puts it elsewhere." })) : tr(msg({ id: 'actions.ago.days', defaultMessage: '{n, plural, one {# day ago} other {# days ago}}', description: "When something happened, in days, 2 to 29 (inbox, sessions, cards). Lower case. It also follows a participle (\"saved {when}\", \"Updated {when}\", \"changed {changed}\"): where it can't, the translation of those messages puts it elsewhere." }), { n: d })
  return formatDate(t)
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return tr(msg({ id: 'actions.duration.seconds', defaultMessage: '{s}s', description: 'A very short duration in seconds ("40s"), as a compact figure. Keep it as short as possible.' }), { s: Math.round(seconds) })
  const m = Math.floor(seconds / 60)
  if (m < 60) return tr(msg({ id: 'actions.duration.minutes', defaultMessage: '{m}m', description: 'A very short duration in minutes ("4m"), as a compact figure. Keep it as short as possible.' }), { m })
  return tr(msg({ id: 'actions.duration.hoursMinutes', defaultMessage: '{h, number}h {m}m', description: 'A very short duration in hours and minutes ("1h 5m"), as a compact figure. Keep it as short as possible.' }), { h: Math.floor(m / 60), m: m % 60 })
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** A session action, with one colour wherever it appears (#344): its buttons (`btn act-*`), menu icons and confirm button. */
export type SessionAction = 'stop' | 'remove' | 'start' | 'archive-start' | 'resume'

/** The class giving an element an action's colour. */
export const actClass = (a: SessionAction | undefined): string | false => !!a && `act-${a}`

export function isMac(): boolean {
  return window.combwork.platform === 'darwin'
}

/** A key combination as the window shows it ("Mod+Shift+P" → "Strg+Umschalt+P"): the keys keyboards in the language name differently in its words (#885). */
export function formatKeybinding(k: string): string {
  const key = (p: string): string => {
    if (p === 'Mod' || p === 'Ctrl') return isMac() && p === 'Mod' ? '⌘' : tr(msg({ id: 'actions.keys.ctrl', defaultMessage: 'Ctrl', description: "The Ctrl key's name as shortcuts show it (\"Ctrl+B\"): as printed on keyboards in the language (German: Strg)." }))
    if (p === 'Shift') return tr(msg({ id: 'actions.keys.shift', defaultMessage: 'Shift', description: "The Shift key's name as shortcuts show it (\"Shift+Alt+C\"): as printed on keyboards in the language (German: Umschalt, Spanish: Mayús)." }))
    if (p === 'Del' || p === 'Delete') return tr(msg({ id: 'actions.keys.delete', defaultMessage: 'Del', description: "The Delete key's name as shortcuts show it (in a menu, beside Delete): as printed on keyboards in the language (German: Entf, Spanish: Supr)." }))
    return p.replace(/^Arrow(?=.)/, '')
  }
  return k
    .split(' ')
    .map((chord) => chord.split('+').map(key).join('+'))
    .join(' ')
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** Quotes a path for pasting into a terminal when it contains whitespace. */
export const quotePath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)

/** Drag payload for files dragged out of the Files and Attachments tabs. */
export const FILES_MIME = 'application/x-combwork-files'

export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes('Files') || dt.types.includes(FILES_MIME))
}

/** URL the renderer can load a workspace image from (served by the main process). */
export const imageUrl = (path: string): string => `combwork-img://img/${encodeURIComponent(path)}`

/** When a limit resets, relative if soon: "in 2 h 14 min", else "Mon 09:00". */
export function resetsIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return tr(msg({ id: 'actions.resets.now', defaultMessage: 'now', description: 'When a usage limit resets: now (it has reset). Lower case.' }))
  const min = Math.round(ms / 60000)
  if (min < 60) return tr(msg({ id: 'actions.resets.minutes', defaultMessage: 'in {min} min', description: 'When a usage limit resets, soon: in {min} minutes. Lower case; keep it short.' }), { min })
  if (min < 24 * 60) return tr(msg({ id: 'actions.resets.hours', defaultMessage: 'in {h} h {min} min', description: 'When a usage limit resets, today: in {h} hours and {min} minutes. Lower case; keep it short.' }), { h: Math.floor(min / 60), min: min % 60 })
  return formatWeekdayTime(iso)
}

export { sessionLabel } from '@shared/defaults'

/** A recent workspace's tooltip: its path, and why it is greyed or marked (#144). */
export function recentTip(r: RecentWorkspace): string {
  if (!r.exists) return `${r.path}\n${tr(msg({ id: 'actions.recent.notFoundTip', defaultMessage: "Not found: moved or deleted, or on a drive that isn't connected.", description: "A recent workspace's tooltip, under its path: its folder isn't there." }))}`
  if (r.openElsewhere) return `${r.path}\n${tr(msg({ id: 'actions.recent.elsewhereTip', defaultMessage: 'Open in another window: choosing it brings that window forward.', description: "A recent workspace's tooltip, under its path: another Combwork window has it open." }))}`
  return r.path
}

/** What a recent entry says beside its name: its path, "not found", or "open in another window". */
export function recentNote(r: RecentWorkspace): string {
  if (!r.exists) return tr(msg({ id: 'actions.recent.notFound', defaultMessage: 'not found', description: "Beside a recent workspace's name: its folder isn't there. Lower case." }))
  return r.openElsewhere ? tr(msg({ id: 'actions.recent.elsewhere', defaultMessage: 'open in another window', description: "Beside a recent workspace's name: another Combwork window has it open. Lower case." })) : r.path
}
