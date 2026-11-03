/**
 * The ICU MessageFormat agent text is written in (dialects, HI-2065): the syntax the window's messages use, read and
 * formatted here with Node's own Intl, because hive-mcp.js and hive-progress.js load only Node's built-ins and Hive's
 * chunks, never FormatJS (AGENTS.md). It covers what agent text needs, as FormatJS reads it with its tags off:
 * - `{name}`: a value as text;
 * - `{n, number}`: a number in English ("1,234");
 * - `{n, plural, =0 {none} one {# card} other {# cards}}` (`offset:k` too): `#` is the number;
 * - `{x, select, yes {…} other {…}}`;
 * - apostrophes as FormatJS reads them: `''` is one, and one before `{`, `}` (or `#` in a plural) quotes up to the next;
 *   any other is text. `<` is text: agent text has no tags.
 * tests/agentText.test.ts checks this formats every message of the catalogue as FormatJS does.
 */

export type Part =
  | string
  | { kind: 'arg'; name: string }
  | { kind: 'number'; name: string }
  | { kind: 'pound' }
  | { kind: 'plural'; name: string; offset: number; options: Record<string, Part[]> }
  | { kind: 'select'; name: string; options: Record<string, Part[]> }

/** What a placeholder is: the schema's kinds. */
export type PlaceholderKind = 'plain' | 'number' | 'plural' | 'select'

export class IcuError extends Error {}

const SPACE = /\s/

/** A message's parts; throws IcuError on text that isn't ICU (an unclosed brace, an unknown type, a select with no other). */
export function parseIcu(text: string): Part[] {
  let at = 0
  const fail = (why: string): never => {
    throw new IcuError(`${why} at ${at} in "${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`)
  }
  const skipSpace = (): void => {
    while (at < text.length && SPACE.test(text[at])) at++
  }
  const word = (): string => {
    const start = at
    while (at < text.length && !SPACE.test(text[at]) && !'{},'.includes(text[at])) at++
    return text.slice(start, at)
  }
  /** Parts up to the end, or to the `}` that closes an option (not consumed). */
  const parts = (inPlural: boolean, nested: boolean): Part[] => {
    const out: Part[] = []
    let lit = ''
    const flush = (): void => {
      if (lit) out.push(lit)
      lit = ''
    }
    while (at < text.length) {
      const c = text[at]
      if (c === "'") {
        const next = text[at + 1]
        if (next === "'") {
          lit += "'"
          at += 2
        } else if (next === '{' || next === '}' || (inPlural && next === '#')) {
          // Quoted: up to the next lone apostrophe ('' inside is one).
          at++
          while (at < text.length) {
            if (text[at] === "'") {
              if (text[at + 1] === "'") {
                lit += "'"
                at += 2
                continue
              }
              at++
              break
            }
            lit += text[at++]
          }
        } else {
          lit += c
          at++
        }
      } else if (c === '{') {
        flush()
        out.push(argument())
      } else if (c === '}') {
        if (!nested) fail('an unmatched }')
        break
      } else if (c === '#' && inPlural) {
        flush()
        out.push({ kind: 'pound' })
        at++
      } else {
        lit += c
        at++
      }
    }
    flush()
    return out
  }
  const options = (inPlural: boolean): Record<string, Part[]> => {
    const opts: Record<string, Part[]> = {}
    for (;;) {
      skipSpace()
      if (text[at] === '}') break
      const key = word()
      if (!key) fail('an option with no key')
      if (Object.hasOwn(opts, key)) fail(`a second option ${key}`)
      skipSpace()
      if (text[at] !== '{') fail(`option ${key} has no {…}`)
      at++
      opts[key] = parts(inPlural, true)
      if (text[at] !== '}') fail(`option ${key} is not closed`)
      at++
    }
    if (!opts.other) fail('a plural or select with no other option')
    return opts
  }
  const argument = (): Part => {
    at++ // {
    skipSpace()
    const name = word()
    if (!name) fail('a placeholder with no name')
    skipSpace()
    if (text[at] === '}') {
      at++
      return { kind: 'arg', name }
    }
    if (text[at] !== ',') fail(`placeholder ${name} is not closed`)
    at++
    skipSpace()
    const type = word()
    skipSpace()
    if (type === 'number') {
      if (text[at] !== '}') fail(`{${name}, number} takes no style here`)
      at++
      return { kind: 'number', name }
    }
    if (type !== 'plural' && type !== 'select') fail(`placeholder type ${type || '(none)'} isn't one agent text uses (number, plural, select)`)
    if (text[at] !== ',') fail(`{${name}, ${type}} needs its options`)
    at++
    skipSpace()
    let offset = 0
    if (type === 'plural' && text.startsWith('offset:', at)) {
      at += 'offset:'.length
      skipSpace()
      const n = word()
      if (!/^\d+$/.test(n)) fail('a plural offset is a whole number')
      offset = Number(n)
    }
    const opts = options(type === 'plural')
    at++ // }
    return type === 'plural' ? { kind: 'plural', name, offset, options: opts } : { kind: 'select', name, options: opts }
  }
  const out = parts(false, false)
  if (at < text.length) fail('an unmatched }')
  return out
}

// English, always: agent text is the dialect's, never the window's language.
const numbers = new Intl.NumberFormat('en')
const plurals = new Intl.PluralRules('en')

/** The parts formatted with values; throws IcuError when one it needs is missing. */
export function formatParts(parts: readonly Part[], values: Readonly<Record<string, string | number>> = {}, pound?: number): string {
  let out = ''
  const value = (name: string): string | number => {
    if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) throw new IcuError(`no value for {${name}}`)
    return values[name]
  }
  for (const p of parts) {
    if (typeof p === 'string') out += p
    else if (p.kind === 'arg') out += String(value(p.name))
    else if (p.kind === 'number') {
      const v = value(p.name)
      out += typeof v === 'number' ? numbers.format(v) : String(v)
    } else if (p.kind === 'pound') out += pound === undefined ? '#' : numbers.format(pound)
    else if (p.kind === 'select') out += formatParts(p.options[String(value(p.name))] ?? p.options.other, values, pound)
    else {
      const v = Number(value(p.name))
      const exact = p.options[`=${v}`]
      const n = v - p.offset
      out += formatParts(exact ?? p.options[plurals.select(n)] ?? p.options.other, values, n)
    }
  }
  return out
}

/** A message's text formatted with values. */
export const formatIcu = (text: string, values?: Readonly<Record<string, string | number>>): string => formatParts(parseIcu(text), values)

/** A message's placeholders and their kinds, nested ones included: what a dialect's override must keep exactly. */
export function placeholdersOf(parts: readonly Part[], into: Record<string, PlaceholderKind> = {}): Record<string, PlaceholderKind> {
  for (const p of parts) {
    if (typeof p === 'string' || p.kind === 'pound') continue
    const kind: PlaceholderKind = p.kind === 'arg' ? 'plain' : p.kind
    // A name used two ways is its strongest use: a plural or select over a plain mention.
    if (!into[p.name] || into[p.name] === 'plain') into[p.name] = kind
    if (p.kind === 'plural' || p.kind === 'select') for (const o of Object.values(p.options)) placeholdersOf(o, into)
  }
  return into
}
