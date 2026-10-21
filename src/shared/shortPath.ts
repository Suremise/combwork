/**
 * A path as the part that matters (#1317), for list dialogs (Repair's plan and report, worktrees, Remove Project): the
 * folder's name, or, beside another path (Was and Now), the part that differs from it, the common start dropped. What
 * shows is never the whole story: the full path goes in the tooltip, to Copy and to screen readers (ShortPath).
 */

/** A path's root (a drive's `C:\`, a share's `\\server\share\`, `/`, or none) and its names, with the separator it uses. */
export function pathParts(path: string): { root: string; names: string[]; sep: string } {
  const sep = path.includes('\\') || /^[A-Za-z]:/.test(path) ? '\\' : '/'
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(path)
  const drive = /^[A-Za-z]:(?:[\\/]|$)/.exec(path)
  const root = unc ? unc[0].replace(/[\\/]/g, sep) + sep : drive ? drive[0].slice(0, 2) + sep : path.startsWith('/') ? '/' : ''
  const rest = path.slice(unc ? unc[0].length : drive ? drive[0].length : root.length)
  return { root, names: rest.split(/[\\/]+/).filter(Boolean), sep }
}

/** Windows paths compare without case (a drive letter, a folder the user typed in another case). */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** What shows for a path shortened: before the part shown when its start was dropped. */
export const DROPPED = '…'

/**
 * The part of `path` that matters. Alone: its last name (a root alone stays whole: `C:\`, `\\server\share\`). Beside
 * `other`: what follows the names they share, after `…\` when more than the root was dropped (`…\x\wt` beside
 * `…\y\wt`); a path that only differs at the end, or is the same, shows its last name; one on another drive or share
 * shows whole, since its root is what differs.
 */
export function shortPath(path: string, other?: string): string {
  const p = pathParts(path)
  const last = p.names.at(-1) ?? p.root
  if (other === undefined) return last
  const o = pathParts(other)
  if (!same(p.root, o.root)) return path
  let common = 0
  while (common < p.names.length && common < o.names.length && same(p.names[common], o.names[common])) common++
  const rest = p.names.slice(common)
  // The same path, or the other one's folder: the name says which, its long common start dropped too.
  if (rest.length <= 1) return rest.length && o.names[common] ? shortName(last, o.names[common]) : last
  return common > 0 ? `${DROPPED}${p.sep}${rest.join(p.sep)}` : `${p.root}${rest.join(p.sep)}`
}

/** The shortest start a name drops: less is no shorter to read. */
const NAME_KEEP = 12

/**
 * A folder name beside another that differs from it only at its end, as a CLI's folders named after a whole path are
 * (Claude Code's `C--Users-…-Scratch-juniper` beside `C--Users-…-Tools-dialect`): what follows their common start, cut
 * at a dash, after `…`; the name whole when they share little.
 */
export function shortName(name: string, other: string): string {
  let n = 0
  while (n < name.length && n < other.length && name[n].toLowerCase() === other[n].toLowerCase()) n++
  const cut = name.lastIndexOf('-', n - 1) + 1
  return cut >= NAME_KEEP && cut < name.length ? `${DROPPED}${name.slice(cut)}` : name
}
