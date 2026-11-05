// No bare locale call outside fmt (#851): `toLocaleString()` and its kin format in the machine's or Chromium's locale,
// not the language Combwork shows (main's Intl stays the OS locale whatever the language), so numbers and dates would
// follow Windows instead of the setting. Combwork formats through `fmt` and the helpers on it (shared/i18n, shared/units,
// shared/dates). A call elsewhere names English (what agents, the log and the English developer views read) or says why
// on its line (`// i18n-ignore: <reason>`).
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(__dirname, '..')

/** A locale call: a Date's or a number's toLocale…String, or one of Intl's formatters. */
const CALL = /\.toLocale(?:Date|Time)?String\s*\(([^)]*)\)?|\bIntl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules|DisplayNames)\s*\(([^)]*)\)?/g
/** English named as the locale: the call's first argument. */
const ENGLISH = /^\s*['"]en(?:-(?:GB|US))?['"]/
/** Where fmt lives: its calls are the point. */
const FMT = /^src\/shared\/i18n\//

/** Each bare locale call in a file's source: "line: the call". */
function bareLocaleCalls(rel: string, source: string): string[] {
  if (FMT.test(rel)) return []
  const out: string[] = []
  source.split(/\r?\n/).forEach((line, i) => {
    if (/\/\/ i18n-ignore: \S/.test(line)) return
    for (const m of line.matchAll(CALL)) {
      const args = m[1] ?? m[2] ?? ''
      if (!ENGLISH.test(args)) out.push(`${rel}:${i + 1}: ${m[0]}`)
    }
  })
  return out
}

function sources(dir = 'src'): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`
    return e.isDirectory() ? sources(rel) : /\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : []
  })
}

describe('numbers and dates are formatted in the language Combwork shows', () => {
  it('no bare toLocaleString(), toLocaleDateString(), toLocaleTimeString() or Intl formatter outside fmt', () => {
    const found = sources().flatMap((rel) => bareLocaleCalls(rel, readFileSync(join(ROOT, rel), 'utf8')))
    expect(found, 'format through fmt (shared/i18n), formatTokens/formatBytes/formatSize (shared/units) or shared/dates; name English for what agents read, or say why with // i18n-ignore: <reason>').toEqual([])
  })

  it('finds each kind of bare call, and lets English, fmt and a reasoned ignore through', () => {
    const src = [
      'const a = n.toLocaleString()',
      'const b = d.toLocaleDateString(undefined, { weekday: "short" })',
      'const c = d.toLocaleTimeString([])',
      'const e = new Intl.NumberFormat(locale()).format(n)',
      'const f = Intl.DateTimeFormat().format(d)',
      "const g = n.toLocaleString('en')",
      "const h = new Intl.ListFormat('en-GB', { type }).format(xs)",
      'const i = d.toLocaleDateString(regional) // i18n-ignore: Windows\' regional format by choice',
      'const j = d.toLocaleDateString(regional) // i18n-ignore:'
    ].join('\n')
    expect(bareLocaleCalls('src/renderer/src/x.ts', src).map((l) => l.split(': ')[0])).toEqual(['src/renderer/src/x.ts:1', 'src/renderer/src/x.ts:2', 'src/renderer/src/x.ts:3', 'src/renderer/src/x.ts:4', 'src/renderer/src/x.ts:5', 'src/renderer/src/x.ts:9'])
    expect(bareLocaleCalls('src/shared/i18n/index.ts', src)).toEqual([])
  })
})
