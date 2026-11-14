import { isAbsolute, relative, resolve } from 'path'

/**
 * In Claude Code's config folder, only what Combwork shows: the user CLAUDE.md and auto memory (editable),
 * and skills (read-only). Never credentials or settings.
 */
export function claudeFileAllowed(path: string, write: boolean, home: string): boolean {
  const rel = relative(resolve(home), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]/)
  if (!/\.md$/i.test(rel)) return false
  if (parts.length === 1) return parts[0].toLowerCase() === 'claude.md'
  if (parts[0] === 'projects') return claudeAutoMemory(path, home)
  if (parts[0] === 'skills' || parts[0] === 'plugins') return !write && parts[parts.length - 1].toLowerCase() === 'skill.md'
  return false
}

/** Whether a path is one of a project's auto memory files in Claude Code's config folder: `projects/<project>/memory/<name>.md`. */
export function claudeAutoMemory(path: string, home: string): boolean {
  const rel = relative(resolve(home), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.md$/i.test(rel)) return false
  const parts = rel.split(/[\\/]/)
  return parts.length === 4 && parts[0] === 'projects' && parts[2] === 'memory'
}
