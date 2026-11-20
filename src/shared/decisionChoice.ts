/**
 * HI-3356: a decision that picks one of a question's options ("A", "(a)", "2") is recorded with what was chosen, so the
 * card's decision stands alone. Conservative on purpose: options are found only as list entries at a line's start, each
 * label once and all of one kind at one indent; anything less certain keeps the whole question. Nothing is ever cut: what
 * it adds is the question's own text, already stored whole with the request. Punctuation and ids only, no words, so the
 * stored decision needs no translation.
 */

/** The whole answer is one option label: a letter or a 1–2 digit number, optionally `(a)`, `a)`, `a.` or `a:`. */
const SHORT_ANSWER = /^\(?\s*([A-Za-z]|\d{1,2})\s*[).:]?$/

/**
 * A line that starts an option: optional indent, an optional Markdown bullet, then the label (optional emphasis round it,
 * or in brackets), an optional bracketed aside, and a delimiter followed by whitespace or the line's end, so `1.1` or
 * `2.a` never count.
 */
const MARKER = /^([ \t]*)(?:[-*+][ \t]+)?(?:\*\*|__)?(?:\(([A-Za-z]|\d{1,2})\)|([A-Za-z]|\d{1,2})(?:\*\*|__)?(?:[ \t]*\([^)\n]*\))?[ \t]*(?:[:.)]|[ \t]-))(?:\*\*|__)?(?=[ \t]|$)[ \t]*/

interface Option {
  label: string
  indent: string
  line: number
  rest: string
}

const kindOf = (label: string): 'letter' | 'number' => (/\d/.test(label) ? 'number' : 'letter')

/**
 * The text of the option `label` names in `question`, whole (its continuation lines included), or null when the question
 * doesn't list options dependably: fewer than two marker lines, labels repeated, mixed letters and numbers, markers at
 * different indents (nesting), or no marker for `label`.
 */
export function optionText(question: string, label: string): string | null {
  const lines = question.split(/\r?\n/)
  const options: Option[] = []
  lines.forEach((l, line) => {
    const m = MARKER.exec(l)
    if (m) options.push({ label: (m[2] ?? m[3]).toLowerCase(), indent: m[1], line, rest: l.slice(m[0].length) })
  })
  if (options.length < 2) return null
  const kind = kindOf(options[0].label)
  if (options.some((o) => kindOf(o.label) !== kind || o.indent !== options[0].indent)) return null
  if (new Set(options.map((o) => o.label)).size !== options.length) return null
  const at = options.findIndex((o) => o.label === label.toLowerCase())
  if (at < 0) return null
  const end = options[at + 1]?.line ?? lines.length
  const body = [options[at].rest, ...lines.slice(options[at].line + 1, end)].join('\n').trim()
  return body || null
}

/**
 * The decision to record for `decision`, the user's answer to the request `request` (its id, `HI-12/r9`) asking `question`:
 * free text as typed; a bare option label with the chosen option's text (`A: <text> (HI-12/r9)`), or, when the options
 * can't be found dependably, with the whole question (`A (HI-12/r9: “<question>”)`).
 */
export function decisionWithChoice(decision: string, question: string | undefined, request: string): string {
  const typed = decision.trim()
  const m = SHORT_ANSWER.exec(typed)
  if (!m) return decision
  const label = m[1].toUpperCase()
  const q = (question ?? '').trim()
  if (!q) return `${typed} (${request})`
  const chosen = optionText(q, m[1])
  return chosen ? `${label}: ${chosen} (${request})` : `${typed} (${request}: “${q}”)`
}
