import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { findPaths, pathCandidates, resolveLink, type LinkRoot, type LinkTarget, type PathMatch } from '@shared/fileLinks'
import { msg, tr } from '@shared/i18n'
import { call } from './api'
import { get, isAssistantPath, set, setProjectTab, showView } from './store'
import { agentFolder, awayFromProject } from './agentPlace'

/** The hover of a file path's link in a terminal. */
const LINK_TITLE = msg({ id: 'files.links.title', defaultMessage: 'Open in Files · Ctrl+click', description: "The hover of a file path in a terminal (an agent's output): Ctrl+click opens the file in the project's Files tab. Files is the tab's name: use it as the tab is named." })

/** The workspace's projects and the folders their agents work in (slots, homes, 0.9 worktrees: #1442), where file links may lead. */
function linkRoots(): LinkRoot[] {
  const out: LinkRoot[] = []
  for (const p of get().workspace?.projects ?? []) {
    out.push({ path: p.path, project: p.path, agentId: null })
    for (const a of p.agents) if (awayFromProject(a)) out.push({ path: agentFolder(a), project: p.path, agentId: a.id })
  }
  return out
}

/** The folder an agent's relative paths are from: where it works (#1442); the Assistant's are the workspace's. */
function linkBase(projectPath: string, agentId: string | undefined): string | null {
  const s = get()
  if (isAssistantPath(projectPath)) return s.workspace?.path ?? null
  const p = s.workspace?.projects.find((x) => x.path === projectPath)
  const a = p?.agents.find((x) => x.id === agentId)
  return (a ? agentFolder(a) : null) ?? p?.path ?? null
}

/** Each file's path as spelled on disk (null: not a file), remembered for a few seconds so hovering doesn't ask main on every move. */
const known = new Map<string, { rel: string | null; at: number }>()
const KNOWN_MS = 5000

/** The targets that are files, with their paths as spelled on disk (the Files tree matches them exactly). */
async function existing(targets: LinkTarget[]): Promise<(LinkTarget | null)[]> {
  const key = (t: LinkTarget): string => `${t.root}|${t.rel}`.toLowerCase()
  const now = Date.now()
  const ask = new Map<string, LinkTarget[]>()
  for (const t of targets) {
    const k = known.get(key(t))
    if (k && now - k.at < KNOWN_MS) continue
    ask.set(t.root, [...(ask.get(t.root) ?? []), t])
  }
  await Promise.all(
    [...ask].map(async ([root, ts]) => {
      const rels = await call('files:linkFiles', root, ts.map((t) => t.rel)).catch(() => ts.map(() => null))
      ts.forEach((t, i) => known.set(key(t), { rel: rels[i] ?? null, at: now }))
    })
  )
  if (known.size > 2000) for (const [k, v] of known) if (now - v.at >= KNOWN_MS) known.delete(k)
  return targets.map((t) => {
    const rel = known.get(key(t))?.rel
    return rel ? { ...t, rel } : null
  })
}

/** Shows a file in its project's Files tab (the worktree's folder for a worktree), at a line. */
export function openFileLink(t: LinkTarget, line?: number, col?: number): void {
  set((s) => ({
    selectedProject: t.project,
    filesRoot: { ...s.filesRoot, [t.project]: t.agentId ?? '' },
    filesJump: { project: t.project, root: t.agentId ?? '', rel: t.rel, line, col, nonce: Date.now() }
  }))
  showView('projects')
  setProjectTab(t.project, 'files')
}

/** A line's text, and the terminal column each character starts in (wide characters take two). */
export function lineText(line: IBufferLine, cols: number): { text: string; colOf: number[] } {
  let text = ''
  const colOf: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) colOf.push(x)
    text += chars
  }
  colOf.push(cols)
  return { text, colOf }
}

/**
 * Ctrl+click on a file path in a session's terminal opens it in the Files tab at its line. Only paths
 * to files that exist in a workspace project or worktree are linked; a plain click stays a click.
 */
export function fileLinkProvider(term: Terminal, context: () => { projectPath?: string; agentId?: string }, host: () => HTMLElement | null): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const { projectPath, agentId } = context()
      const base = projectPath ? linkBase(projectPath, agentId) : null
      const line = term.buffer.active.getLine(y - 1)
      if (!base || !line) return callback(undefined)
      const { text, colOf } = lineText(line, term.cols)
      const roots = linkRoots()
      // Every way the line may hold a path (a path with spaces is also its shorter beginnings); the files among
      // them decide which become links.
      const found = pathCandidates(text).flatMap((m) => {
        const target = resolveLink(m.path, base, roots)
        return target ? [{ m, target }] : []
      })
      if (!found.length) return callback(undefined)
      const at = (m: PathMatch): string => `${m.start}:${m.end}:${m.path}`
      void existing(found.map((f) => f.target)).then((files) => {
        const fileAt = new Map(found.flatMap((f, i) => (files[i] ? [[at(f.m), files[i]] as const] : [])))
        const links: ILink[] = findPaths(text, (m) => fileAt.has(at(m)))
          .map((m) => ({ m, target: fileAt.get(at(m))! }))
          .map(({ m, target }) => ({
            text: text.slice(m.start, m.end),
            range: { start: { x: colOf[m.start] + 1, y }, end: { x: colOf[m.end - 1] + 1, y } },
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => {
              if (e.ctrlKey || e.metaKey) openFileLink(target, m.line, m.col)
            },
            // Translated as it shows, so a language changed since the terminal opened applies (HI-2346).
            hover: () => host()?.setAttribute('title', tr(LINK_TITLE)),
            leave: () => host()?.removeAttribute('title')
          }))
        callback(links.length ? links : undefined)
      })
    }
  }
}
