/**
 * The ICU MessageFormat agent text is written in (dialects, HI-2065), formatted by FormatJS's `intl-messageformat` in
 * English, tags off (`<` is text: agent text has no markup): the same grammar the extractor checks the catalogue and a
 * dialect's texts with (scripts/agentTextExtract.mjs, FormatJS's parser with the same options), so what passes the
 * schema formats. hive-mcp.js and hive-progress.js run outside the asar and can't load a package from node_modules:
 * intl-messageformat and its parser are bundled into Hive's chunks for them (electron.vite.config.ts, HI-2433).
 */
import { IntlMessageFormat } from 'intl-messageformat'

/** A parsed message, as FormatJS gives it (`getAst()`). */
export type Part = ReturnType<IntlMessageFormat['getAst']>[number]

/** What a placeholder is: the schema's kinds. */
export type PlaceholderKind = 'plain' | 'number' | 'date' | 'time' | 'plural' | 'select'

export class IcuError extends Error {}

/** FormatJS's element types (TYPE in @formatjs/icu-messageformat-parser, which these scripts don't import directly). */
const T = { argument: 1, number: 2, date: 3, time: 4, select: 5, plural: 6 } as const
const KIND: Record<number, PlaceholderKind> = { [T.argument]: 'plain', [T.number]: 'number', [T.date]: 'date', [T.time]: 'time', [T.select]: 'select', [T.plural]: 'plural' }

/** Parsed messages, by text: a message is parsed once, then formatted per call. */
const cache = new Map<string, IntlMessageFormat>()
const CACHE_MAX = 2000

function compiled(text: string): IntlMessageFormat {
  let m = cache.get(text)
  if (m) return m
  try {
    m = new IntlMessageFormat(text, 'en', undefined, { ignoreTag: true })
  } catch (e) {
    throw new IcuError(`not ICU agent text can use: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(text, m)
  return m
}

/** A message's parts; throws IcuError on text that isn't ICU (an unclosed brace, a plural or select with no other). */
export const parseIcu = (text: string): Part[] => compiled(text).getAst()

/** A message's text formatted with values, in English; throws IcuError when it isn't ICU or a value it needs is missing. */
export function formatIcu(text: string, values?: Readonly<Record<string, string | number>>): string {
  const m = compiled(text)
  try {
    return String(m.format(values as Record<string, string | number> | undefined))
  } catch (e) {
    throw new IcuError(String((e as Error)?.message ?? e).split('\n')[0])
  }
}

/** A message's placeholders and their kinds, nested ones included: what a dialect's override must keep exactly. */
export function placeholdersOf(parts: readonly Part[], into: Record<string, PlaceholderKind> = Object.create(null)): Record<string, PlaceholderKind> {
  for (const p of parts) {
    const kind = KIND[p.type]
    if (!kind || !('value' in p)) continue
    const name = p.value as string
    // A name used two ways is its strongest use: a plural or select over a plain mention.
    if (!Object.hasOwn(into, name) || into[name] === 'plain') into[name] = kind
    if ('options' in p) for (const o of Object.values(p.options as Record<string, { value: Part[] }>)) placeholdersOf(o.value, into)
  }
  return into
}
