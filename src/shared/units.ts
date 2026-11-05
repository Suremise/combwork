// How Combwork shows token counts and sizes (#608), in the language it shows (#851): the figure from fmt (its decimal
// separator, "1,5"), the unit from a message, so a language can write "1,5 Ko". Unit tests reach them without the renderer.
import { fmt, msg, tr } from './i18n'

const M = {
  thousands: msg({ id: 'units.tokens.thousands', defaultMessage: '{n}k', description: 'A token count in thousands, compact ("12.3k", "450k"): context, usage and cost figures. {n} is the number, already formatted. Keep it as short as possible.' }),
  millions: msg({ id: 'units.tokens.millions', defaultMessage: '{n}M', description: 'A token count in millions, compact ("5.5M", "12M"). {n} is the number, already formatted. Keep it as short as possible.' }),
  billions: msg({ id: 'units.tokens.billions', defaultMessage: '{n}B', description: 'A token count in billions, compact ("12.9B", "150B"). {n} is the number, already formatted. Keep it as short as possible.' }),
  bytes: msg({ id: 'units.size.bytes', defaultMessage: '{n} B', description: 'A size in bytes ("160 B"): files, attachments, transcripts. {n} is the number, already formatted.' }),
  kilobytes: msg({ id: 'units.size.kilobytes', defaultMessage: '{n} KB', description: 'A size in kilobytes, of 1024 bytes ("1.5 KB", "820 KB"). {n} is the number, already formatted.' }),
  megabytes: msg({ id: 'units.size.megabytes', defaultMessage: '{n} MB', description: 'A size in megabytes, of 1024 KB ("6.1 MB", "118 MB"). {n} is the number, already formatted.' }),
  gigabytes: msg({ id: 'units.size.gigabytes', defaultMessage: '{n} GB', description: 'A size in gigabytes, of 1024 MB ("2.4 GB", "16.0 GB"): storage, memory. {n} is the number, already formatted.' })
}

/** Token units, largest first: the unit, its message, and from how many of it whole numbers are shown. */
const TOKEN_UNITS = [[1e9, M.billions, 100], [1e6, M.millions, 10], [1e3, M.thousands, 100]] as const

/** One decimal below `whole` (as it would read rounded), none from it. */
const decimalsBelow = (v: number, whole: number): number => (Number(v.toFixed(1)) >= whole ? 0 : 1)

/** "950", "12.3k", "450k", "5.5M", "12M", "12.9B", "150B"; an average is rounded, and a value that would show as 1000 of a
 *  unit is shown in the next (999,999 is "1.0M", not "1000k"). */
export function formatTokens(n: number): string {
  const r = Math.round(n)
  let i = TOKEN_UNITS.findIndex(([unit]) => r >= unit)
  if (i < 0) return fmt.figure(r, 0)
  if (i > 0 && Math.round(r / TOKEN_UNITS[i][0]) >= 1000) i--
  const [unit, m, whole] = TOKEN_UNITS[i]
  const v = r / unit
  return tr(m, { n: fmt.figure(v, decimalsBelow(v, whole)) })
}

/** "160 B", "1.5 KB", "12 KB", "3.4 MB": whole bytes (an average is rounded), and a value that would show as 1024 of a unit
 *  is shown in the next (1,048,575 bytes is "1.0 MB", not "1024 KB"). For files and attachments. */
export function formatBytes(n: number): string {
  const b = Math.round(n)
  const kb = b / 1024
  if (b < 1024) return tr(M.bytes, { n: fmt.figure(b, 0) })
  if (Math.round(kb) < 1024) return tr(M.kilobytes, { n: fmt.figure(kb, decimalsBelow(kb, 10)) })
  return tr(M.megabytes, { n: fmt.figure(kb / 1024, 1) })
}

/** "0 KB", "820 KB", "6.1 MB", "118 MB", "2.4 GB": a size in whole KB (at least 1 KB for anything), then MB and GB with a
 *  decimal below 10. Storage, a transcript's size, the memory agents take. */
export function formatSize(n: number): string {
  if (n < 1024 * 1024) return tr(M.kilobytes, { n: fmt.figure(n === 0 ? 0 : Math.max(1, Math.round(n / 1024)), 0) })
  const mb = n / 1024 ** 2
  if (mb < 1024) return tr(M.megabytes, { n: fmt.figure(mb, mb < 10 ? 1 : 0) })
  const gb = mb / 1024
  return tr(M.gigabytes, { n: fmt.figure(gb, gb < 10 ? 1 : 0) })
}

/** "16.0 GB", "9.5 GB": gigabytes with a decimal, for a computer's memory. */
export const formatGigabytes = (n: number): string => tr(M.gigabytes, { n: fmt.figure(n / 1024 ** 3, 1) })
