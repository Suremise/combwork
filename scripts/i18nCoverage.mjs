// How much of each language is translated (#768): `npm run i18n:coverage` prints, per language and per area, how many
// of the English messages it has, which are missing (they show in English) and which are outdated: their English has
// changed since they were translated, so they may no longer say the same (they still show). Informational: it always
// exits 0; the blocking check is `npm run i18n:check`.
//
// Outdated is measured against locales/.source/<code>/<area>.json, the English each translation was made from (id →
// that English). After translating, record it: `npm run i18n:coverage -- --record <code>` records the English of the
// language's translations that have no record yet; after updating outdated ones, name them:
// `npm run i18n:coverage -- --record <code> <id> <id>…`. A message removed from the English leaves its record behind, which
// i18n:check fails on (HI-3519): `npm run i18n:coverage -- --prune` drops those of every language.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { areaOf, rootArg, writeKeepingEndings } from './i18nExtract.mjs'
import { englishMessages, readLanguage, translatedLanguages } from './i18nCheck.mjs'

/** The English each of a language's translations was made from (id → English), every area merged. */
export function recordedSource(root, code) {
  const dir = join(root, 'locales', '.source', code)
  const out = {}
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      Object.assign(out, JSON.parse(readFileSync(join(dir, f), 'utf8')))
    } catch {
      // A damaged record only loses the outdated report for its area.
    }
  }
  return out
}

/** A language's coverage, per area: its English messages, those translated, missing and outdated (ids sorted). */
export function coverage(root, code) {
  const english = englishMessages(root)
  const { messages } = readLanguage(root, code)
  const source = recordedSource(root, code)
  const areas = {}
  for (const id of Object.keys(english).sort()) {
    const a = (areas[areaOf(id)] ??= { total: 0, translated: 0, missing: [], outdated: [] })
    a.total++
    if (!messages[id]) a.missing.push(id)
    else {
      a.translated++
      if (id in source && source[id] !== english[id]) a.outdated.push(id)
    }
  }
  return areas
}

const pct = (n, of) => (of ? `${Math.floor((n / of) * 1000) / 10}%` : '100%')
const some = (ids) => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}`

/** The report's lines for a language. */
export function coverageLines(root, code) {
  const areas = coverage(root, code)
  const sum = (k) => Object.values(areas).reduce((n, a) => n + (Array.isArray(a[k]) ? a[k].length : a[k]), 0)
  const lines = [`${code}: ${sum('translated')} of ${sum('total')} translated (${pct(sum('translated'), sum('total'))})${sum('outdated') ? `; ${sum('outdated')} outdated` : ''}`]
  for (const [area, a] of Object.entries(areas)) {
    if (!a.missing.length && !a.outdated.length) continue
    lines.push(`  ${area}: ${a.translated} of ${a.total}${a.missing.length ? `; missing (shown in English): ${some(a.missing)}` : ''}${a.outdated.length ? `; outdated (the English changed): ${some(a.outdated)}` : ''}`)
  }
  return lines
}

/** Records the current English of a language's translations (the ids given, or those with no record yet). Returns the ids recorded. */
export function recordSource(root, code, ids = []) {
  const english = englishMessages(root)
  const { messages } = readLanguage(root, code)
  const source = recordedSource(root, code)
  const take = ids.length ? ids.filter((id) => messages[id] && english[id] !== undefined) : Object.keys(messages).filter((id) => english[id] !== undefined && !(id in source))
  if (!take.length) return []
  const dir = join(root, 'locales', '.source', code)
  mkdirSync(dir, { recursive: true })
  for (const id of take) source[id] = english[id]
  const byArea = {}
  for (const id of Object.keys(source).sort()) (byArea[areaOf(id)] ??= {})[id] = source[id]
  // Only the areas whose record changed, each with the line endings it has on disk (#1113: every file was rewritten LF).
  for (const [area, entries] of Object.entries(byArea)) writeKeepingEndings(join(dir, `${area}.json`), `${JSON.stringify(entries, null, 2)}\n`)
  return take
}

/**
 * Drops a language's records of ids the English catalogue no longer has (HI-3519: i18n:check fails on one), each area's
 * file rewritten only if it changed, with its line endings, and removed once it records nothing. Returns the ids dropped.
 */
export function pruneSource(root, code) {
  const english = englishMessages(root)
  const dir = join(root, 'locales', '.source', code)
  if (!existsSync(dir)) return []
  const dropped = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue // i18n:check names a damaged record
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const gone = Object.keys(data).filter((id) => !(id in english))
    if (!gone.length) continue
    dropped.push(...gone)
    const kept = Object.fromEntries(Object.entries(data).filter(([id]) => id in english))
    if (Object.keys(kept).length) writeKeepingEndings(join(dir, f), `${JSON.stringify(kept, null, 2)}\n`)
    else rmSync(join(dir, f))
  }
  return dropped
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const root = rootArg(args)
  const at = args.indexOf('--record')
  if (args.includes('--prune')) {
    for (const code of translatedLanguages(root)) {
      const dropped = pruneSource(root, code)
      console.log(`${code}: dropped ${dropped.length} recorded English of messages that are gone${dropped.length ? ` (${dropped.join(', ')})` : ''}`)
    }
  } else if (at >= 0) {
    const code = args[at + 1]
    if (!code || !translatedLanguages(root).includes(code)) {
      console.error(`--record <code>: a language in locales/ (${translatedLanguages(root).join(', ')})`)
      process.exit(1)
    }
    const done = recordSource(root, code, args.slice(at + 2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--root'))
    console.log(`${code}: recorded the English of ${done.length} translations in locales/.source/${code}/`)
  } else {
    const english = Object.keys(englishMessages(root)).length
    console.log(`i18n:coverage (informational: a missing message shows in English): ${english} English messages`)
    for (const code of translatedLanguages(root)) console.log(coverageLines(root, code).join('\n'))
  }
}
