// A card's context references (#818): the doc sections an agent reads first, by file and heading, never by line:
// `docs/ARCHITECTURE.md#core-contracts`, `shared:plans/2026-10-14-i18n-design.md#extraction-lanes`, or a whole document
// (`docs/PLAN.md`). The heading is a slug as cw_doc_outline lists it (shared/docSections.ts, #817).

/** The most references a card has. */
export const MAX_CONTEXT = 10
/** The longest reference. */
export const MAX_CONTEXT_REF = 300

/** A reference split into its document and its section's slug (none: the whole document). */
export interface DocRef {
  path: string
  slug: string | null
}

const REF = /^(.+?\.(?:md|markdown|mdx))(?:#([^#\s]+))?$/i

/**
 * A reference's document and slug, or null when it isn't one: a Markdown file (a project's, or `shared:<path>`) and
 * optionally `#` and a slug. Line numbers (`#L12`, `#12`, `:12`) and anything else after the file are not references.
 */
export function parseDocRef(ref: string): DocRef | null {
  const m = REF.exec(ref.trim())
  if (!m || /^L?\d+$/i.test(m[2] ?? '') || /\s/.test(m[1])) return null
  return { path: m[1], slug: m[2] ?? null }
}

/** References written one a line (or separated by commas), as the card dialog takes them: trimmed, once each. */
export function splitDocRefs(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]
}
