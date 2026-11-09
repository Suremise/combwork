/**
 * The Files tab's Git menu (HI-2743): the ignore lines Combwork writes, how it reads `git check-ignore -v`, and which
 * rules it may take out again. Pure, so main writes with them and the renderer labels its menu with them.
 */

/** A rule git named for an ignored path (`git check-ignore -v`): its file as git printed it, its line and pattern. */
export interface IgnoreRule {
  /** The rule's file: relative to the repository's top (`.gitignore`, `sub/.gitignore`, `.git/info/exclude`), or absolute (the global excludes file). */
  source: string
  line: number
  pattern: string
}

/** Escapes what a .gitignore line would read as a pattern or a comment, so the line names exactly this text. */
function escapeIgnore(text: string): string {
  const esc = text.replace(/[\\*?[]/g, (c) => `\\${c}`)
  // Trailing spaces are dropped unless escaped.
  return esc.replace(/ +$/, (s) => s.replace(/ /g, '\\ '))
}

/** The line that ignores exactly this path (relative to the repository's top, `/` separated): anchored, a folder with a trailing `/`. */
export function exactIgnoreLine(repoRel: string, isDir: boolean): string {
  return `/${escapeIgnore(repoRel.replace(/^\/+|\/+$/g, ''))}${isDir ? '/' : ''}`
}

/** A file name's extension for "All *.ext files", or null (no extension, or a dotfile such as `.env`). */
export function extensionOf(name: string): string | null {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : null
}

/** The line that ignores every file with this extension, anywhere. */
export const extIgnoreLine = (ext: string): string => `*.${escapeIgnore(ext)}`

/** Undoes git's C-style quoting of a path (a name with a tab or a quote in it). */
function unquote(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p
  const body = p.slice(1, -1)
  const bytes: number[] = []
  const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  const utf8 = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...utf8.encode(c))
      continue
    }
    const n = body[i + 1]
    if (/[0-7]/.test(n ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(map[n] ?? n.charCodeAt(0))
      i += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * `git check-ignore -v` output, by path (as given, without a trailing `/`): `<source>:<line>:<pattern>\t<path>`. A path
 * that matched a negation (`!keep.log`) isn't ignored, so it is left out.
 */
export function parseCheckIgnore(out: string): Map<string, IgnoreRule> {
  const rules = new Map<string, IgnoreRule>()
  for (const raw of out.split(/\r?\n/)) {
    const tab = raw.lastIndexOf('\t')
    if (tab < 0) continue
    const m = /^(.*?):(\d+):(.*)$/.exec(raw.slice(0, tab))
    if (!m || m[3].startsWith('!')) continue
    rules.set(unquote(raw.slice(tab + 1)).replace(/\/$/, ''), { source: unquote(m[1]), line: Number(m[2]), pattern: m[3] })
  }
  return rules
}

/** The ignore files Combwork writes: the repository's top `.gitignore` (shared), and `.git/info/exclude` (this PC only). */
export type IgnoreTarget = 'shared' | 'local'

/**
 * Whether Include again may take this rule out (HI-2743): a plain line in the top `.gitignore` or in `.git/info/exclude`
 * (`infoExclude`: that file as git names it, relative to the repository's top) naming exactly this path, or the
 * `*.ext` line of this file's extension. A negation, a wider pattern, a nested .gitignore or the global file: no.
 */
export function removableRule(rule: IgnoreRule, repoRel: string, isDir: boolean, infoExclude: string): IgnoreTarget | null {
  const target = rule.source === '.gitignore' ? 'shared' : rule.source.toLowerCase() === infoExclude.toLowerCase() ? 'local' : null
  if (!target) return null
  if (rule.pattern === exactIgnoreLine(repoRel, isDir)) return target
  const ext = isDir ? null : extensionOf(repoRel.slice(repoRel.lastIndexOf('/') + 1))
  return ext && rule.pattern === extIgnoreLine(ext) ? target : null
}

/** The file's line ending: CRLF when it has one before any lone LF, else LF. */
export function lineEnding(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'
}

const sameLine = (a: string, b: string): boolean => a.replace(/\r$/, '').trimEnd() === b

/**
 * Appends each line not already in the text (a line equal to it, trailing spaces aside), in the text's own line ending,
 * after a line break when the text doesn't end with one. The new text, and which lines were added.
 */
export function appendIgnoreLines(text: string, lines: string[]): { text: string; added: string[] } {
  const eol = lineEnding(text)
  const have = text.split('\n')
  const added: string[] = []
  for (const l of lines) if (!have.some((h) => sameLine(h, l)) && !added.includes(l)) added.push(l)
  if (!added.length) return { text, added }
  const body = text.replace(/^﻿/, '')
  const sep = body.length && !text.endsWith('\n') ? eol : ''
  return { text: text + sep + added.map((l) => l + eol).join(''), added }
}

/** The text without its line `lineNo` (1-based), with that line's break, or null when that line isn't `pattern`. */
export function removeIgnoreLine(text: string, lineNo: number, pattern: string): string | null {
  const parts = text.split('\n')
  const i = lineNo - 1
  if (i < 0 || i >= parts.length) return null
  const line = parts[i].replace(/^﻿/, '')
  if (!sameLine(line, pattern)) return null
  const bom = i === 0 && parts[0].startsWith('﻿') ? '﻿' : ''
  parts.splice(i, 1)
  // The last line had no break of its own: the break before it goes with it (its CR too).
  if (i === parts.length && i > 0) parts[i - 1] = parts[i - 1].replace(/\r$/, '')
  const out = parts.join('\n')
  return bom && !out.startsWith('﻿') ? bom + out : out
}
