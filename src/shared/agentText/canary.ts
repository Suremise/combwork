/**
 * The canary dialect (dialects, HI-2065; design section 2, check 4): pseudo-localisation for agent text. Every id's text
 * wrapped in markers, `⟦id⟧…⟦/⟧`, put in a session's chain: what an agent then gets with any letter outside the markers
 * is text that bypassed the catalogue (hard-coded, or glued on in code). Tests run it over what agents get (unit tests of
 * the builders; tests/e2e/agentguidance.cjs through hive-mcp.js's dialect file) and grow with each extraction card.
 * Imports nothing: the e2e scripts load it in plain Node.
 */

const OPEN = '⟦'
const CLOSE = '⟦/⟧'

/** The canary's texts: each catalogue id's text (id → { text }) wrapped in its markers. */
export function canaryTexts(catalogue: Readonly<Record<string, { text: string }>>): Record<string, string> {
  return Object.fromEntries(Object.entries(catalogue).map(([id, m]) => [id, `${OPEN}${id}⟧${m.text}${CLOSE}`]))
}

/** What a canary run found in an output: the text outside every marker, and the ids its markers name. */
export function canarySplit(output: string): { outside: string; ids: string[]; unbalanced: boolean } {
  let outside = ''
  const ids: string[] = []
  let depth = 0
  let at = 0
  let unbalanced = false
  while (at < output.length) {
    if (output.startsWith(CLOSE, at)) {
      if (depth === 0) unbalanced = true
      else depth--
      at += CLOSE.length
      continue
    }
    if (output[at] === OPEN) {
      const end = output.indexOf('⟧', at + 1)
      if (end > at) {
        ids.push(output.slice(at + 1, end))
        depth++
        at = end + 1
        continue
      }
    }
    if (depth === 0) outside += output[at]
    at++
  }
  return { outside, ids, unbalanced: unbalanced || depth !== 0 }
}

/**
 * What's wrong with an output a canary run produced: a letter outside the markers (once the values the test passed are
 * taken out: a project's name is the caller's, not Hive's wording), a marker naming an id the schema hasn't, unbalanced
 * markers. Empty: every word came through the catalogue.
 */
export function canaryProblems(output: string, schemaIds: ReadonlySet<string>, values: readonly string[] = []): string[] {
  const { outside, ids, unbalanced } = canarySplit(output)
  let rest = outside
  for (const v of [...values].sort((a, b) => b.length - a.length)) if (v) rest = rest.split(v).join(' ')
  const problems: string[] = []
  const words = rest.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []
  if (words.length) problems.push(`text outside the catalogue: ${[...new Set(words)].slice(0, 12).join(', ')} (in "${rest.trim().slice(0, 160)}")`)
  const unknown = [...new Set(ids.filter((id) => !schemaIds.has(id)))]
  if (unknown.length) problems.push(`markers naming ids the schema hasn't: ${unknown.join(', ')}`)
  if (unbalanced) problems.push('unbalanced markers')
  return problems
}
