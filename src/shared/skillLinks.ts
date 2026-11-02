/**
 * A link in a skill's Markdown to another file of the same skill (HI-2011: SKILL.md as a contents page, its reference
 * files linked from it): which listed file it names, or null. Only a relative link naming one of `files` exactly (the
 * skill's files as skillFiles lists them: real files, relative, with "/", never through a link) counts: a link with a
 * scheme, an absolute or drive path, a backslash, a ".." or "." segment, or an escape that doesn't decode is no file
 * of the skill, so nothing outside its folder is ever opened from it. Its #anchor and ?query are dropped.
 */
export function skillLinkTarget(href: string, files: readonly string[]): string | null {
  const bare = href.split(/[?#]/)[0]
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('/') || bare.includes('\\')) return null
  let path: string
  try {
    path = decodeURIComponent(bare)
  } catch {
    return null
  }
  // Decoded, it may name what the raw link hid (%2e%2e, %5c, %2f): checked again.
  if (path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0')) return null
  const parts = path.split('/')
  if (parts[0] === '.') parts.shift()
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) return null
  const rel = parts.join('/')
  return files.includes(rel) ? rel : null
}
