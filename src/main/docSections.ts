// Reading a Markdown document to outline it or read one section (#817): a project's file (in the folder the caller works
// in) or a shared note (`shared:<path>`). Only Markdown, only inside its folder (through junctions too), never Hive's
// own `.combwork` or git's `.git` folder, and up to DOC_MAX: a reply never carries more than the section asked for.
import { readFile, stat } from 'original-fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import { insideReal, realPath } from './fsutil'
import { parseDocRef } from '../shared/docRefs'
import { docOutline, findHeading, sectionText } from '../shared/docSections'
import type { ContextProblem } from '../shared/types'
import { CW_DIR } from '../shared/defaults'

/** A shared note's reference starts with this: `shared:plans/i18n.md`. */
export const SHARED_PREFIX = 'shared:'

/** The largest document read by section. */
export const DOC_MAX = 4 * 1024 * 1024

/** What reading a document found: its text, or why not. */
export type DocRead = { ok: true; text: string } | { ok: false; code: 'outside' | 'hidden' | 'notMarkdown' | 'notFound' | 'tooBig' }

const MARKDOWN = /\.(md|markdown|mdx)$/i

/** Whether a path inside the folder goes into Hive's own `.combwork` or git's `.git`. */
const hidden = (inside: string): boolean => inside.split(/[\\/]/).some((part) => part.toLowerCase() === CW_DIR || part.toLowerCase() === '.git')

/**
 * Reads a document: `path` relative to `root` (a project's folder, or the shared notes' folder for `shared:` paths).
 * A path outside it, into `.combwork` or `.git`, or not Markdown is refused before anything is read.
 */
export async function readDoc(root: string, path: string): Promise<DocRead> {
  const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || isAbsolute(rel) || /^[a-z]:/i.test(rel)) return { ok: false, code: 'outside' }
  const abs = resolve(root, rel)
  const inside = relative(resolve(root), abs)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { ok: false, code: 'outside' }
  if (hidden(inside)) return { ok: false, code: 'hidden' }
  if (!MARKDOWN.test(abs)) return { ok: false, code: 'notMarkdown' }
  if (!insideReal(abs, [root])) return { ok: false, code: 'outside' }
  // Where it really is, through junctions and links: one inside the folder may still lead into .combwork or .git.
  if (hidden(relative(realPath(root), realPath(abs)))) return { ok: false, code: 'hidden' }
  const s = await stat(abs).catch(() => null)
  if (!s?.isFile()) return { ok: false, code: 'notFound' }
  if (s.size > DOC_MAX) return { ok: false, code: 'tooBig' }
  const text = await readFile(abs, 'utf8').catch(() => null)
  return text === null ? { ok: false, code: 'notFound' } : { ok: true, text: text.replace(/^﻿/, '') }
}

/** Why a reference doesn't resolve: as reading its document found, not a reference at all, no such heading, or a heading whose text several share. */
export type DocRefProblem = Extract<DocRead, { ok: false }>['code'] | 'invalid' | 'noHeading' | 'ambiguous'

/** A reference checked: its section (or whole document) and where it starts, or why not with the closest headings' slugs. */
export type DocRefCheck = { ref: string; content: string; line: number; size: number } | { ref: string; problem: DocRefProblem; closest?: string[] }

/**
 * Checks a card's context reference (#818, #819): in the project's folder (`project`: never an agent's worktree; null for a
 * card about the workspace, whose project files can't resolve) or the shared notes (`shared`, for `shared:` references).
 * It resolves when its file is there and readable and, with a #slug, that heading is in it, uniquely: a heading whose
 * text another one has too (a second "Setup" added above it) is `ambiguous`, since which one the slug names can change;
 * one with an explicit id (`<a id="setup"></a>`, #1535) is never, and keeps resolving when its text is renamed, unless
 * another heading carries the same id (a section copied with its anchor): then a reference to any of them is ambiguous.
 * The size is its section's, or the whole document's when it names no heading.
 */
export async function checkDocRef(project: string | null, shared: string, ref: string): Promise<DocRefCheck> {
  const parsed = parseDocRef(ref)
  if (!parsed) return { ref, problem: 'invalid' }
  const isShared = parsed.path.startsWith(SHARED_PREFIX)
  if (!isShared && !project) return { ref, problem: 'notFound' }
  const r = await readDoc(isShared ? shared : project!, isShared ? parsed.path.slice(SHARED_PREFIX.length) : parsed.path)
  if (!r.ok) return { ref, problem: r.code }
  if (!parsed.slug) return { ref, content: r.text, line: 1, size: r.text.length }
  const outline = docOutline(r.text)
  const found = findHeading(outline, `#${parsed.slug}`)
  if ('ambiguous' in found) return { ref, problem: 'ambiguous', closest: found.ambiguous.map((h) => h.slug) }
  if (!('heading' in found)) return { ref, problem: 'noHeading', closest: found.closest.slice(0, 3).map((h) => h.slug) }
  const h = found.heading
  // A heading with an explicit id is the one its id names, whatever other headings are called (#1535); one of several
  // carrying the same id, named by its numbered slug, may be another once they move.
  if (h.sharedId) return { ref, problem: 'ambiguous', closest: outline.filter((x) => x.sharedId === h.sharedId).map((x) => x.slug) }
  const same = outline.filter((x) => x.text.toLowerCase() === h.text.toLowerCase())
  if (!h.fixed && same.length > 1) return { ref, problem: 'ambiguous', closest: same.map((x) => x.slug) }
  return { ref, content: sectionText(r.text, h), line: h.line, size: h.size }
}

/** A card's references that don't resolve now (#819), checked together. */
export async function contextProblems(project: string | null, shared: string, refs: readonly string[]): Promise<ContextProblem[]> {
  const checks = await Promise.all(refs.map((ref) => checkDocRef(project, shared, ref).catch((): DocRefCheck => ({ ref, problem: 'notFound' }))))
  return checks.flatMap((c) => ('problem' in c ? [{ ref: c.ref, problem: c.problem, ...(c.closest?.length ? { closest: c.closest } : {}) }] : []))
}
