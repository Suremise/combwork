/**
 * A short plain-text form of someone's Markdown (#1635): its first sentence or two with the Markdown's marks taken out,
 * for a tooltip where the whole text (an agent's question, a long reason) would be a wall of `**`, backticks and run-
 * together lists. The whole stays where it is read in full.
 */

/**
 * Markdown's marks taken out, block by block, and the text run into one line. A code span's text is kept as written
 * (HR4's #1635 round 1: `__init__.py`, a glob): it is set aside before the other marks are read and put back after.
 */
export function plainMarkdown(md: string): string {
  const code: string[] = []
  return (
    md
      .replace(/\r\n?/g, '\n')
      // A fenced block says nothing a gist can show.
      .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, ' ')
      // A code span: its text between runs of the same number of backticks, one space each side trimmed (CommonMark).
      .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, text: string) => `${code.push(text.replace(/\n/g, ' ').replace(/^ (.*) $/, '$1')) - 1}`)
      .replace(/^ {0,3}#{1,6}\s+/gm, '')
      .replace(/^ {0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^ {0,3}([-*_])(\s*\1){2,}\s*$/gm, ' ')
      // Images and links: their text.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/(\d+)/g, (_, i: string) => code[Number(i)])
      .trim()
  )
}

/**
 * Its first sentence, and the next while they fit in `max` characters; a first sentence longer than that is cut at a
 * word with "…". Sentences by the language's rules (Intl.Segmenter), so a question in any language is cut at its end.
 */
export function gist(md: string, max = 160): string {
  const text = plainMarkdown(md)
  if (text.length <= max) return text
  const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map((s) => s.segment)
  let out = ''
  for (const s of sentences) {
    if ((out + s).trimEnd().length > max) break
    out += s
    if (out.length >= max / 2) break
  }
  out = out.trim()
  if (out) return out
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}
