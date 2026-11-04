import { join, relative, resolve, sep, dirname, basename } from 'path'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'original-fs/promises'
import { existsSync } from 'original-fs'
import { handoverHeader, handoverProject, handoverSession, type HandoverAuthor } from '../shared/hiveGuidance'
import { HIVE_DIR } from '../shared/defaults'
import { isProjectId } from '../shared/projectIds'
import type { NoteFile } from '../shared/types'
import { hashText, insideReal, readKeptJson, retryWhileSaving, withFileLock, writeKeptJson, writeTextAtomic } from './fsutil'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'
import { nameJournal, nameJournalNow as nameJournalNowOf, ownerOfName, ownersOfName } from './projectNames'
import { currentWorkspace, workspace, type WorkspaceService } from './workspace'
import { trash } from './trash'

/** Shared notes' refusals the window shows in its language (#849); agents (the Agent API's notes) read their English. */
const M = {
  outside: msg({ id: 'content.notes.outside', defaultMessage: 'Path is outside the shared notes folder', description: "An error: a shared note's path leads out of the workspace's shared notes folder (.combwork/shared)." }),
  exists: msg({ id: 'content.notes.exists', defaultMessage: '"{name}" already exists', description: 'An error making or renaming a shared note or folder: one called {name} is already there.' }),
  closed: msg({ id: 'content.notes.closed', defaultMessage: 'The workspace was closed or switched: nothing was changed.', description: 'An error: the workspace closed, or another opened in its window, while a handover was being renamed; nothing changed.' })
}

function assertInShared(p: string): string {
  const root = resolve(workspace.sharedDir)
  const abs = resolve(root, p)
  if (abs !== root && !abs.toLowerCase().startsWith(root.toLowerCase() + sep)) throw hiveError(M.outside)
  if (!insideReal(abs, [root])) throw hiveError(M.outside)
  return abs
}

/** The shared notes folder's tree: the current work's workspace's, or the folder given (`root`). */
export async function notesTree(root: string | null = workspace.path ? workspace.sharedDir : null): Promise<NoteFile[]> {
  if (!root) return []
  const walk = async (dir: string, depth: number): Promise<NoteFile[]> => {
    if (depth > 6) return []
    let entries: import('original-fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: NoteFile[] = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      const rel = relative(root, p).replace(/\\/g, '/')
      if (e.isDirectory()) out.push({ path: p, relPath: rel, name: e.name, isDir: true, children: await walk(p, depth + 1) })
      else if (e.isFile()) {
        const s = await stat(p).catch(() => null)
        out.push({ path: p, relPath: rel, name: e.name, isDir: false, modified: s?.mtime.toISOString() })
      }
    }
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  }
  return walk(root, 0)
}

export async function createNote(relPath: string, isDir: boolean): Promise<string> {
  let rel = relPath.trim().replace(/^[\\/]+/, '')
  if (!rel) throw hiveError(msg({ id: 'content.notes.nameRequired', defaultMessage: 'Name is required', description: 'An error making a shared note or folder with no name.' }), undefined, { kind: 'invalid' })
  if (!isDir && !/\.[a-z0-9]+$/i.test(rel)) rel += '.md'
  const abs = assertInShared(rel)
  if (existsSync(abs)) throw hiveError(M.exists, { name: rel })
  if (isDir) await mkdir(abs, { recursive: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    const title = basename(abs).replace(/\.[^.]+$/, '')
    await writeFile(abs, abs.endsWith('.md') ? `# ${title}\n\n` : '', { flag: 'wx' })
  }
  return abs
}

export async function deleteNote(p: string): Promise<void> {
  const abs = assertInShared(p)
  if (abs === resolve(workspace.sharedDir)) throw hiveError(msg({ id: 'content.notes.deleteRoot', defaultMessage: 'Cannot delete the shared folder itself', description: "An error: the shared notes folder itself (.combwork/shared) can't be deleted, only what is in it." }))
  // To the Recycle Bin, like files, skills, modes and sessions.
  if (existsSync(abs)) await trash(abs)
}

export async function renameNote(p: string, newName: string): Promise<string> {
  const abs = assertInShared(p)
  if (!newName.trim() || /[\\/:*?"<>|]/.test(newName)) throw hiveError(msg({ id: 'content.notes.badName', defaultMessage: 'Invalid name', description: 'An error renaming a shared note: the new name is empty or has a character Windows can\'t have in a name (such as / or :).' }), undefined, { kind: 'invalid' })
  const dest = assertInShared(join(dirname(abs), newName.trim()))
  // Only its letters' case changed: the same file (Windows), renamed.
  const caseOnly = abs !== dest && abs.toLowerCase() === dest.toLowerCase()
  if (!caseOnly && existsSync(dest)) throw hiveError(M.exists, { name: newName })
  const at = workspaceAt(currentWorkspace())
  if (!at || resolve(dirname(abs)).toLowerCase() !== resolve(at.shared, 'handovers').toLowerCase()) {
    await rename(abs, dest)
    return dest
  }
  // A handover keeps its project (#514): the file and its owner's record change together, in the record's lock (an
  // adoption lists the handovers in it too, so it never sees one under a name its record doesn't have).
  return retryWhileSaving(() => withFileLock(at.owners, async () => {
    stillOpen(at)
    const owners = await readOwners(at.owners)
    stillOpen(at)
    await rename(abs, dest)
    const from = basename(abs)
    const id = owners[from]
    if (!id) return dest
    delete owners[from]
    // Kept whatever it is called now (a .txt for a while, say): renamed back, it is its project's again.
    owners[basename(dest)] = id
    try {
      await writeKeptJson(at.owners, { version: 1, owners })
    } catch (e) {
      // Not recorded: the file goes back to its name, so it stays its project's.
      await rename(dest, abs).catch(() => undefined)
      throw e
    }
    return dest
  }))
}

// ---------------------------------------------------------------------------
// Whose a handover is (#514): by the stable id of the project it was written for, never by a name alone.
// ---------------------------------------------------------------------------

/** A file name in shared/handovers that is a handover: Markdown (.md in any case, as Windows names are), not its README, nothing but a name. */
function isHandoverFile(name: string): boolean {
  return /\.md$/i.test(name) && name.toLowerCase() !== 'readme.md' && plainName(name)
}
const plainName = (name: string): boolean => !!name && name.length <= 255 && !/[\\/\0]/.test(name)
const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** Handovers newest first: by the date their name starts with, then by when they last changed. */
const newestFirst = (a: NoteFile, b: NoteFile): number => b.name.slice(0, 10).localeCompare(a.name.slice(0, 10)) || (b.modified ?? '').localeCompare(a.modified ?? '')

/**
 * A workspace as it was when a call began: its folders, and whether it still is that workspace (not closed, nor the
 * window switched to another). Ownership work checks it after each wait and in its lock before writing, so what was
 * read in one workspace is never written into the next one.
 */
interface WorkspaceAt {
  ws: WorkspaceService
  shared: string
  owners: string
  open: () => boolean
}
function workspaceAt(ws: WorkspaceService): WorkspaceAt | null {
  const path = ws.path
  if (!path) return null
  const life = ws.lifetime
  return { ws, shared: join(path, HIVE_DIR, 'shared'), owners: join(path, HIVE_DIR, 'handover-owners.json'), open: () => !life.aborted && ws.lifetime === life && ws.path === path }
}
function stillOpen(at: WorkspaceAt): void {
  if (!at.open()) throw hiveError(M.closed, undefined, { kind: 'conflict' })
}

/** The workspace's handovers, as files of shared/handovers (its README aside). */
/** Every file's name in shared/handovers (none while it doesn't exist); one that can't be read fails. */
async function handoverNames(at: WorkspaceAt): Promise<Set<string>> {
  try {
    return new Set((await readdir(join(at.shared, 'handovers'), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw e
  }
}

async function handoverFiles(at: WorkspaceAt): Promise<NoteFile[]> {
  return ((await notesTree(at.shared)).find((n) => n.isDir && n.name === 'handovers')?.children ?? []).filter((f) => !f.isDir && isHandoverFile(f.name))
}

/** The record of handovers' owners, read to be changed and written back: still being saved by something else, KeptFileBusy (#1600). */
async function readOwners(file: string): Promise<Record<string, string>> {
  const raw = await readKeptJson<unknown>(file, null, { unsettled: 'throw' })
  const o = raw && typeof raw === 'object' ? (raw as { owners?: unknown }).owners : null
  const out: Record<string, string> = {}
  if (o && typeof o === 'object' && !Array.isArray(o)) for (const [f, id] of Object.entries(o)) if (isProjectId(id) && plainName(f)) out[f] = id
  return out
}

/**
 * Records that a handover is a project's (by its id) as Hive writes it: `write` creates the file, in the record's lock
 * once the record has been read (#1600), so a record still being saved by something else refuses the handover before
 * there is any file to take back.
 */
async function ownHandover(at: WorkspaceAt, file: string, id: string, write: () => Promise<void>): Promise<void> {
  await retryWhileSaving(() => withFileLock(at.owners, async () => {
    stillOpen(at)
    const owners = await readOwners(at.owners)
    stillOpen(at)
    await write()
    owners[file] = id
    await writeKeptJson(at.owners, { version: 1, owners })
  }))
}

/**
 * Who a handover with no recorded owner is, from what it says (one written before #514, or by hand). Its header's
 * Project line names a folder name, which more than one project may have had (renamed, and the name taken again):
 * the conversation its header names settles which (the one project whose sessions include it), and with none, only a
 * name one project ever had counts (`ownersOfName`: the project of that name now, and those that had it before). With
 * no header, the project whose name, now or before, its file name begins with (the longest such, only if one project
 * ever had it). Evidence that disagrees (a conversation of a project that never had the name) or that can't decide
 * leaves it nobody's, never a guess: it is asked again after the next rename or Repair (which records the names it
 * finds a project had).
 */
function legacyOwner(ws: WorkspaceService, file: string, text: string, sessionOwner: (id: string) => string | null): string | null {
  const named = handoverProject(text)
  if (!named) return ownerBySlug(ws, file.replace(/^\d{4}-\d{2}-\d{2}-/, ''))
  const session = handoverSession(text)
  const ran = session ? sessionOwner(session) : null
  if (named === '(workspace)') return ran
  const had = ownersOfName(ws, named)
  if (ran) return !had.length || had.includes(ran) ? ran : null
  return had.length === 1 ? had[0] : null
}

/**
 * The project a handover's file name (after its date) begins with: of the projects' names now and before (the record of
 * names), the longest that begins it, only if exactly one project ever had it.
 */
function ownerBySlug(ws: WorkspaceService, rest: string): string | null {
  const names = [...ws.projectIdsNow().byId.values()].map((p) => basename(p))
  for (const p of Object.values(nameJournalNowOf(ws).projects)) names.push(p.name, ...p.former)
  const matches = names.filter((n) => slugOf(n) && rest.startsWith(slugOf(n) + '-'))
  if (!matches.length) return null
  const longest = Math.max(...matches.map((n) => slugOf(n).length))
  const owners = new Set(matches.filter((n) => slugOf(n).length === longest).map((n) => ownerOfName(ws, n)))
  return owners.size === 1 ? [...owners][0] : null
}

/**
 * Gives each handover with no recorded owner the project it is, when that can be known (legacyOwner), in the record's
 * lock; forgets the records of handovers gone. All in the workspace it began in (WorkspaceAt): closed or switched
 * meanwhile, it changes nothing and fails. Returns every owner.
 */
export async function adoptHandovers(ws: WorkspaceService): Promise<Map<string, string>> {
  const at = workspaceAt(ws)
  if (!at) return new Map()
  await nameJournal(ws)
  stillOpen(at)
  return retryWhileSaving(() => withFileLock(at.owners, async () => {
    stillOpen(at)
    // Listed in the lock: a handover renamed (renameNote, in this lock) is never seen by its old name here.
    const files = await handoverFiles(at)
    stillOpen(at)
    const owners = await readOwners(at.owners)
    stillOpen(at)
    let changed = false
    // Forgotten only when its file is gone (by any name: one renamed to another type keeps its owner); a folder that
    // can't be read fails, never forgetting them all.
    const here = await handoverNames(at)
    stillOpen(at)
    // Its name's case changed outside Hive (Explorer): the same file, its owner under the name it has now.
    const byCase = new Map([...here].map((f) => [f.toLowerCase(), f]))
    for (const f of Object.keys(owners)) {
      if (here.has(f)) continue
      const now = byCase.get(f.toLowerCase())
      if (now && !owners[now]) owners[now] = owners[f]
      delete owners[f]
      changed = true
    }
    let sessionIds: Map<string, string[]> | null = null
    const sessionOwner = (id: string): string | null => {
      const ids = (sessionIds ?? new Map()).get(id) ?? []
      return ids.length === 1 ? ids[0] : null
    }
    for (const f of files) {
      if (owners[f.name]) continue
      const text = (await readFile(join(at.shared, f.relPath), 'utf8').catch(() => '')).slice(0, 4000)
      stillOpen(at)
      if (!text) continue
      if (!sessionIds && handoverSession(text)) {
        sessionIds = await sessionsByProject(ws)
        stillOpen(at)
      }
      const id = legacyOwner(ws, f.name, text, sessionOwner)
      if (!id) continue
      owners[f.name] = id
      changed = true
    }
    stillOpen(at)
    if (changed) await writeKeptJson(at.owners, { version: 1, owners })
    return new Map(Object.entries(owners))
  }))
}

/** Which projects ran each conversation (sessions.json), by its id. */
async function sessionsByProject(ws: WorkspaceService): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const [id, p] of ws.projectIdsNow().byId) {
    for (const s of (await ws.sessionsFile(p).catch(() => null))?.sessions ?? []) {
      if (typeof s?.id !== 'string') continue
      const list = out.get(s.id) ?? []
      if (!list.includes(id)) list.push(id)
      out.set(s.id, list)
    }
  }
  return out
}

/**
 * A project's handovers, newest first (#514): those whose owner is its id, recorded as Hive wrote them or worked out
 * once for older ones (adoptHandovers). A renamed project keeps its own, and a project that takes a name some other
 * project had never gets that one's. No project: every handover.
 */
export async function handoversFor(ws: WorkspaceService, project: string | undefined): Promise<NoteFile[]> {
  const at = workspaceAt(ws)
  if (!at) return []
  if (!project) return (await handoverFiles(at)).sort(newestFirst)
  const owners = await adoptHandovers(ws)
  const files = await handoverFiles(at)
  const ids = await ws.projectIds()
  stillOpen(at)
  const id = ids.byPath.get(join(ws.path!, project).toLowerCase())
  return id ? files.filter((f) => owners.get(f.name) === id).sort(newestFirst) : []
}

/** Writes a handover note into shared/handovers and returns its path; `by` is the agent that wrote it, for its header. */
export async function createHandover(project: string, title: string, content: string, by: HandoverAuthor | null = null): Promise<string> {
  const date = new Date().toISOString().slice(0, 10)
  const slug = `${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'handover'
  // All in the workspace it began in (a window switched meanwhile writes nothing into the next one).
  const ws = currentWorkspace()
  const at = workspaceAt(ws)
  if (!at) throw new Error('No workspace is open') // i18n-ignore: the Agent API's handover (agents read English)
  const dir = join(at.shared, 'handovers')
  await mkdir(dir, { recursive: true })
  stillOpen(at)
  // The same slug as hive-mcp's, which finds a project's handovers by this prefix.
  const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  let file = join(dir, `${date}-${projectSlug ? projectSlug + '-' : ''}${slug}.md`)
  const header = handoverHeader(title, project, by, new Date())
  // Whose it is, by the project's id (#514): it stays that project's whatever it is called later.
  const owner = project ? ws.projectIdsNow().byPath.get(join(ws.path!, project).toLowerCase()) : undefined
  // Created, never overwritten: two handovers with the same title at once get -2, -3…
  for (let n = 2; ; n++) {
    try {
      const write = (): Promise<void> => writeFile(file, header + content.trim() + '\n', { flag: 'wx' })
      if (owner) await ownHandover(at, basename(file), owner, write)
      else await write()
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 1000) throw e
      file = file.replace(/(-\d+)?\.md$/, `-${n}.md`)
    }
  }
}

/** A shared note's revision: a short hash of its text, which a write can name to be sure it changes what its writer read. */
export const noteRevision = (text: string): string => hashText(text).slice(0, 12)

/** A write naming a revision the note is no longer at: `current` is its revision now, null when it no longer exists. */
export class NoteConflict extends Error {
  constructor(
    rel: string,
    expected: string,
    public current: string | null
  ) {
    // i18n-ignore: agents only (the Agent API's note write, with expectedRevision)
    super(current ? `${rel} has changed since revision ${expected}: it is now at revision ${current}. Read it again, merge your change and write it with expectedRevision ${current}.` : `${rel} no longer exists. Write it without expectedRevision to create it again.`)
  }
}

export async function readNote(abs: string): Promise<{ content: string; revision: string }> {
  const content = await readFile(abs, 'utf8')
  return { content, revision: noteRevision(content) }
}

/**
 * Writes or appends to a note. Locked from read to write (the same lock as Hive's editors' saves), so two agents
 * appending at once both keep their text, and with `expectedRevision` the check and the write can't be split by
 * another write: the second of two writers that read the same text is refused rather than dropping the first's change.
 */
export async function writeNote(abs: string, rel: string, content: string, o: { append?: boolean; expectedRevision?: string } = {}): Promise<{ revision: string }> {
  return withFileLock(abs, async () => {
    const existing = await readFile(abs, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
    if (o.expectedRevision !== undefined) {
      const current = existing === null ? null : noteRevision(existing)
      if (current !== o.expectedRevision) throw new NoteConflict(rel, o.expectedRevision, current)
    }
    const text = o.append && existing ? existing + (existing.endsWith('\n') ? '' : '\n') + content : content
    await writeTextAtomic(abs, text)
    return { revision: noteRevision(text) }
  })
}

export { assertInShared }
