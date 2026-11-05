// Card attachments (HI-1700, design s8 + s11 + s13): files kept with a card, whatever sessions it has had or not yet, in its
// host's `.combwork/attachments/cards/<card number>` (its project's folder; the workspace's for a card with no project), one
// row each in `card_attachments`. Named by the card's number, which never changes (its key does: a move, a key renamed).
//
// Files are copied in (never moved) and published with their rows in one change of the board, under its write lock, which
// every attach, remove, move and delete takes; each rechecks the card there. What a change does on disk before it commits
// is put back if it is undone (onBoardUndone), and what it leaves to do afterwards is done once it commits
// (afterBoardWrite). What a crash leaves is settled at the next open (recoverCardAttachments), from the operations' own
// records (`op.json`) read against the committed board: never by age.
import { createHash, randomBytes } from 'crypto'
import { createReadStream, createWriteStream } from 'original-fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile, copyFile } from 'original-fs/promises'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { basename, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { ATTACHMENTS_DIR, CARD_ATTACHMENTS_DIR, attachmentKind } from '../shared/attachments'
import { CARD_ATTACHMENT_FOLDERS_ID, CARD_ATTACHMENT_MAX_ID } from '../shared/advanced'
import { ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, type CardAttachment, type CardAttachmentGroup, type CardDrafts } from '../shared/cardAttachments'
import { CW_DIR, projectAgents } from '../shared/defaults'
import { msg } from '../shared/i18n'
import { formatBytes } from '../shared/units'
import { legacyWorktree } from '../shared/agentFolders'
import type { AttachmentContent } from '../shared/types'
import { advanced } from './advanced'
import { attachmentName, freeName, ownAttachmentsFolder } from './attachmentsFolder'
import { afterBoardWrite, boardChanged, boardRead, boardWrite, boardWriteOp, cardKeys, onBoardUndone } from './boardStore'
import { insideReal, realPath } from './fsutil'
import { combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { trash } from './trash'
import { fileIdentity, ownFolder, sameFile, type FileIdentity } from './cardCleanupFs'
import type { WorkspaceService } from './workspace'

const log = createLogger('attachments')

const STAGING = '.staging'
const TRASH = '.trash'
const OP_FILE = 'op.json'

const M = {
  tooLarge: msg({ id: 'service.cardAttach.tooLarge', defaultMessage: '{name} is larger than {max}, the most a card keeps in one file (Settings → Advanced → Card attachments: largest file). Nothing was attached.', description: 'An error attaching files to a card (HI-1700): one is larger than the limit ({max}: a size such as 25 MB); none of them was attached.' }),
  tooMuch: msg({ id: 'service.cardAttach.tooMuch', defaultMessage: 'At most {files, number} files and {total} can be attached at once. Nothing was attached.', description: 'An error attaching files to a card (HI-1700): more files, or more bytes in all ({total}: a size such as 100 MB), than one change takes; none was attached.' }),
  refused: msg({ id: 'service.cardAttach.refused', defaultMessage: '{path} is not a file that can be attached here: give the path of a file of your own project (its folder, its slots) or of the temp folder. Nothing was attached.', description: 'An error attaching a file to a card by its path (HI-1700): it is missing, a folder or a link, or in a place the caller may not attach from (another project, Combwork’s own folders). Nothing was attached.' }),
  // HI-2480: an agent's, the Assistant's or a script's: where files may come from, and where another folder is added.
  refusedFrom: msg({ id: 'service.cardAttach.refusedFrom', defaultMessage: "{path} is not a file that can be attached here. Files can come from {caller, select, agent {your own project (its folder, its slots)} other {the workspace and its projects}}, the temp folder ({temp}){more, select, yes { and the folders of Settings → Advanced → Card attachments: more folders ({folders})} other {}}. To attach from another folder, the user adds it there (Settings → Advanced → Card attachments: more folders, Combwork's or this workspace's): don't copy the file into the temp folder. Nothing was attached.", description: "An error attaching a file to a card by its path (HI-1700, HI-2480): it is missing, a folder or a link, or in a place the caller may not attach from. {caller} is agent for a project's agent, else the Assistant or a script; {temp} is the temp folder's path; {more} is yes when the user listed more folders, {folders} those folders. Card attachments: more folders is an advanced setting's title: use it as Settings shows it. Nothing was attached." }),
  noCard: msg({ id: 'service.cardAttach.noCard', defaultMessage: 'No such card.', description: 'An error attaching a file to a card (HI-1700): the card is gone.' }),
  noProject: msg({ id: 'service.cardAttach.noProject', defaultMessage: '{project} is not a project of the workspace. Nothing was attached.', description: 'An error attaching files to a card (HI-1700): the project named for it is not one of the workspace’s (a path, or a name no project has); nothing was copied.' }),
  noAttachment: msg({ id: 'service.cardAttach.noAttachment', defaultMessage: 'The card has no such attachment.', description: 'An error removing a card attachment (HI-1700) that is gone.' }),
  moved: msg({ id: 'service.cardAttach.moved', defaultMessage: "The card moved to another project meanwhile: attach again.", description: "An error attaching files to a card (HI-1700): the card moved to another project while they were copied; nothing was attached." }),
  notOwn: msg({ id: 'service.attachments.notOwn', defaultMessage: "{folder} is a link or not a folder of the project's own, so Combwork keeps no attachments in it.", description: "An error keeping a pasted or dropped file for a session: its folder {folder} (in the project's .combwork) is a link or leads elsewhere, so Combwork writes nothing through it." }),
  moveFailed: msg({ id: 'service.cardAttach.moveFailed', defaultMessage: "The card's attachments couldn't be copied to {project}, so it wasn't moved: {why}", description: "An error moving a card to another project (HI-1700): its attached files couldn't be copied there; the card stays where it was. {project} is the project's name, {why} the reason." })
}

// ---------------------------------------------------------------------------
// Where a card's files are.
// ---------------------------------------------------------------------------

/** A name that is one folder's (no separator, drive, `.` or `..`, nor a character Windows refuses). */
const plainName = (n: string): boolean => !!n && n !== '.' && n !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(n)

/**
 * The folder a card's attachments are kept under: its project's, or the workspace's for a card with no project. A
 * project is a folder of the workspace by its plain name: anything else (a path, `..`) is refused, never joined.
 */
export function cardHost(ws: WorkspaceService, project: string | null | undefined): string {
  if (!project) return ws.path!
  if (!plainName(project)) throw combworkError(M.noProject, { project }, { kind: 'invalid' })
  return join(ws.path!, project)
}
/** A host's cards folder, `<host>\.combwork\attachments\cards`. */
export const cardsRoot = (host: string): string => join(host, CW_DIR, ATTACHMENTS_DIR, CARD_ATTACHMENTS_DIR)
/** A card's folder, made or not. */
export const cardFolder = (host: string, card: number): string => join(cardsRoot(host), String(card))

/** A folder under the host's cards folder (`names`: one step each), made where missing, every step a real folder of the host's own. */
async function ownCardsFolder(host: string, ...names: string[]): Promise<string> {
  const root = await ownAttachmentsFolder(host)
  let p = root
  for (const n of [CARD_ATTACHMENTS_DIR, ...names]) {
    p = join(p, n)
    if (!(await lstat(p).catch(() => null))) await mkdir(p).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)))
    const st = await lstat(p).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isDirectory() || !insideReal(p, [host])) throw combworkError(M.notOwn, { folder: p })
  }
  return p
}

type Row = Omit<CardAttachment, 'path' | 'kind' | 'missing'>
const COLUMNS = 'card, id, file, name, size, sha256, by, at, comment' // i18n-ignore: SQL
const newest = (a: Row, b: Row): number => b.at.localeCompare(a.at) || b.file.localeCompare(a.file)
const withPath = (host: string, r: Row, missing = false): CardAttachment => ({ ...r, path: join(cardFolder(host, r.card), r.file), kind: attachmentKind(r.name), ...(missing ? { missing: true } : {}) })
const exists = async (p: string): Promise<boolean> => !!(await lstat(p).catch(() => null))

/** A card's attachments, newest first, with their paths now; a file gone from disk is marked `missing`. */
export async function cardAttachments(ws: WorkspaceService, card: number): Promise<CardAttachment[]> {
  const found = boardRead(ws, (db) => {
    const c = db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined // i18n-ignore: SQL
    return c ? { host: cardHost(ws, c.project), rows: db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(card) as Row[] } : null // i18n-ignore: SQL
  })
  if (!found) return []
  return Promise.all(found.rows.sort(newest).map(async (r) => withPath(found.host, r, !(await exists(join(cardFolder(found.host, card), r.file))))))
}

/**
 * A card attachment's text for the viewer's preview (HI-1958), by the card and its id, never a path from the window:
 * read by readCardAttachment (HI-1751), so through one opened file, its folder chain and the file's identity checked
 * again after the open and its row before the reply (HR2's round 1: checking a path, then reading it later, could follow
 * a folder swapped for a link meanwhile). Whole, up to `max` bytes ('too-large' beyond); an image, a PDF or a file that
 * isn't UTF-8 text is 'binary'. Anything it refuses (gone, outside its folder, changed meanwhile) is an error.
 */
export async function previewCardAttachment(ws: WorkspaceService, card: number, id: string, max: number): Promise<AttachmentContent> {
  const found = boardRead(ws, (db) => {
    const c = db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined // i18n-ignore: SQL
    const r = c && (db.prepare('SELECT file FROM card_attachments WHERE card = ? AND id = ?').get(card, id) as { file: string } | undefined) // i18n-ignore: SQL
    return c && r ? { project: c.project, file: r.file } : null
  })
  if (!found) throw combworkError(M.noAttachment, undefined, { kind: 'notFound' })
  const r = await readCardAttachment(ws, { number: card, project: found.project }, found.file, null, max)
  if ('problem' in r) throw combworkError(M.noAttachment, undefined, { kind: 'notFound' })
  if (r.kind !== 'text') return { kind: 'binary', text: '' }
  return r.next !== undefined ? { kind: 'too-large', text: '' } : { kind: 'text', text: r.content }
}

/** Every attachment of a project's cards (its Attachments tab), by card number, newest first; archived cards' too. */
export async function projectCardAttachments(ws: WorkspaceService, project: string): Promise<Map<number, CardAttachment[]>> {
  const rows = boardRead(ws, (db) => db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card IN (SELECT number FROM cards WHERE project = ? COLLATE NOCASE)`).all(project) as Row[]) // i18n-ignore: SQL
  const host = cardHost(ws, project)
  const out = new Map<number, CardAttachment[]>()
  for (const r of rows.sort(newest)) out.set(r.card, [...(out.get(r.card) ?? []), withPath(host, r, !(await exists(join(cardFolder(host, r.card), r.file))))])
  return out
}

/** A project's cards' attachments by card, as its Attachments tab lists them: newest card first (by its newest file). */
export async function cardAttachmentGroups(ws: WorkspaceService, projectPath: string): Promise<CardAttachmentGroup[]> {
  const project = basename(projectPath)
  const byCard = await projectCardAttachments(ws, project)
  if (!byCard.size) return []
  const numbers = [...byCard.keys()]
  const keys = cardKeys(ws, numbers)
  const cards = boardRead(ws, (db) => db.prepare('SELECT number, title, col, archived FROM cards WHERE number IN (SELECT value FROM json_each(?))').all(JSON.stringify(numbers)) as { number: number; title: string; col: string; archived: number }[]) // i18n-ignore: SQL
  return cards
    .map((c) => ({ card: c.number, key: keys.get(c.number) ?? null, title: c.title, column: c.col, archived: !!c.archived, attachments: byCard.get(c.number)! }))
    .sort((a, b) => b.attachments[0].at.localeCompare(a.attachments[0].at))
}

/** Counts of attachments by card (for the board's cards), for the cards given. */
export function attachmentCounts(ws: WorkspaceService, cards: number[]): Map<number, number> {
  if (!cards.length) return new Map()
  return boardRead(ws, (db) => new Map((db.prepare('SELECT card, count(*) AS n FROM card_attachments WHERE card IN (SELECT value FROM json_each(?)) GROUP BY card').all(JSON.stringify(cards)) as { card: number; n: number }[]).map((r) => [r.card, r.n]))) // i18n-ignore: SQL
}

// ---------------------------------------------------------------------------
// Where a file may come from (s13 §2): protected hosts first, then the caller's allowed folders, on real paths.
// ---------------------------------------------------------------------------

/**
 * Who asks: a project's agent (its project's name), the Assistant or a script with the workspace's token, the user in the
 * window (a drop or a picked file: their own choice), or the window's Attach to card from a pane (a file of that host's
 * session attachments only).
 */
export type AttachCaller = { kind: 'agent'; project: string } | { kind: 'workspace' } | { kind: 'user' } | { kind: 'pane'; host: string }

/** A project's working folders: its folder, its slots and copies (under the worktrees root), its agents' 0.9 worktrees. */
async function workFolders(ws: WorkspaceService, projectPath: string): Promise<string[]> {
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const legacy = cfg ? projectAgents(cfg).flatMap((a) => legacyWorktree(a)?.path ?? []) : []
  return [projectPath, join(ws.worktreesRoot, basename(projectPath)), ...legacy]
}

const within = (p: string, roots: string[]): boolean => roots.some((r) => insideReal(p, [r]))

/** Every project folder of the workspace, hidden ones too. */
const allProjects = async (ws: WorkspaceService): Promise<string[]> => [...(await ws.listProjectPaths().catch(() => [] as string[])), ...(await ws.listProjectPaths({ hidden: true }).catch(() => [] as string[]))]

/**
 * The innermost `.combwork` folder in a real path (a host's own: the Assistant's home is inside the workspace's), and what
 * follows it: only `attachments` (a session's or a card's files) may be read through one.
 */
function throughCombwork(real: string): { hive: string; next: string | undefined } | null {
  const parts = real.split(sep)
  const i = parts.map((x) => x.toLowerCase()).lastIndexOf(CW_DIR)
  return i < 0 ? null : { hive: parts.slice(0, i + 1).join(sep), next: parts[i + 1]?.toLowerCase() }
}

/**
 * The folders the user listed in Settings → Advanced → Card attachments: more folders (HI-2480), the workspace's own list
 * over Hive's: each full path, a %VARIABLE% at its start filled in from the environment (one that isn't set, or that
 * doesn't give a full path, leaves the folder out). Checked as a file's other allowed folders are, after the protected ones.
 */
/** For tests: the temp folder attachableSource accepts (a test's own files are all in its run's temp folder). */
export const attachTestHooks: { temp: string | null } = { temp: null }

export function extraFolders(ws: WorkspaceService): string[] {
  // A workspace's empty list is Hive's list, as Settings' emptied box for the workspace is (round 2: one meaning).
  const own = advanced.get<string[]>(CARD_ATTACHMENT_FOLDERS_ID, ws.config?.advanced ?? null)
  const listed = Array.isArray(own) && own.length ? own : advanced.get<string[]>(CARD_ATTACHMENT_FOLDERS_ID, null)
  if (!Array.isArray(listed)) return []
  const env = new Map(Object.entries(process.env).map(([k, v]) => [k.toLowerCase(), v]))
  return listed.flatMap((f) => {
    const filled = typeof f === 'string' ? f.replace(/^%([a-z_][a-z0-9_]*)%/i, (all, name: string) => env.get(name.toLowerCase()) ?? all) : ''
    return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/])/.test(filled) ? [resolve(filled)] : []
  })
}

/**
 * The real path of a file the caller may attach, or the refusal (the same whether the file is there or not): a regular
 * file (no folder or link at the end), whose real path, every folder above it resolved (a junction anywhere counts), is in
 * a folder the caller may read from and in no protected host's.
 */
export async function attachableSource(ws: WorkspaceService, caller: AttachCaller, path: string): Promise<string> {
  const temp = attachTestHooks.temp ?? tmpdir()
  const more = caller.kind === 'agent' || caller.kind === 'workspace' ? extraFolders(ws) : []
  const refuse = (): never => {
    if (caller.kind === 'agent' || caller.kind === 'workspace') throw combworkError(M.refusedFrom, { path, caller: caller.kind, temp, more: more.length ? 'yes' : 'no', folders: more.join('; ') }, { kind: 'invalid' })
    throw combworkError(M.refused, { path }, { kind: 'invalid' })
  }
  if (typeof path !== 'string' || !path || !/^[a-zA-Z]:[\\/]|^\\\\/.test(path)) refuse()
  const st = await lstat(path).catch(() => null)
  if (!st || st.isSymbolicLink() || !st.isFile()) refuse()
  const real = realPath(resolve(path))
  if (caller.kind === 'user') return real
  if (caller.kind === 'pane') {
    const root = join(caller.host, CW_DIR, ATTACHMENTS_DIR)
    if (!within(real, [root]) || within(real, [join(root, CARD_ATTACHMENTS_DIR)])) refuse()
    return real
  }
  const projects = await allProjects(ws)
  const hive = throughCombwork(real)
  if (caller.kind === 'agent') {
    const own = projects.find((p) => basename(p).toLowerCase() === caller.project.toLowerCase())
    if (!own) refuse()
    const ownFolders = await workFolders(ws, own!)
    // Protected first: another project's folders, the Assistant's home, the workspace's own .combwork (wherever they are,
    // inside the caller's own folders or the temp folder included).
    const others = (await Promise.all(projects.filter((p) => p !== own).map((p) => workFolders(ws, p)))).flat()
    if (within(real, [...others, ws.assistantHome, join(ws.path!, CW_DIR)])) refuse()
    // A .combwork only through its own project's attachments.
    if (hive && !(hive.hive.toLowerCase() === realPath(join(own!, CW_DIR)).toLowerCase() && hive.next === ATTACHMENTS_DIR)) refuse()
    if (!within(real, [...ownFolders, temp, ...more])) refuse()
    return real
  }
  // The Assistant and scripts: the workspace, every project's working folders wherever they are, the Assistant's home,
  // the temp folder and the listed folders; any .combwork only through its attachments.
  if (hive && hive.next !== ATTACHMENTS_DIR) refuse()
  const all = (await Promise.all(projects.map((p) => workFolders(ws, p)))).flat()
  if (!within(real, [ws.path!, ...all, ws.assistantHome, temp, ...more])) refuse()
  return real
}

// ---------------------------------------------------------------------------
// Staging: files copied in, streamed, counted and hashed, under the limits (s13 §3).
// ---------------------------------------------------------------------------

/** What is attached: a file by its real path (attachableSource), or bytes (a paste) with the name they came with. */
export type AttachSource = { path: string; name?: string } | { data: Uint8Array; name: string | null }

interface StagedFile {
  tmp: string
  name: string
  size: number
  sha256: string
}

/** Files copied into a host's staging folder for one operation: published with a card's change, or dropped. */
export interface Staging {
  host: string
  dir: string
  files: StagedFile[]
  /** Removes what is left of the staging (published files were renamed out of it). */
  dispose(): Promise<void>
}

/** Staging folders of operations running in this Hive (lower-cased paths), from before they are made until disposed of. */
const liveStaging = new Set<string>()

/** Whether another process (another Hive on the workspace) is running: its staging may be in use. */
const otherAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const limits = (): { file: number; total: number } => ({ file: advanced.get<number>(CARD_ATTACHMENT_MAX_ID), total: ATTACH_MAX_TOTAL })

/** Checks a call's count and, where known up front, sizes (a paste's bytes), before anything is read or copied. */
export function checkBatch(sources: { size?: number; name?: string | null }[]): void {
  const { file, total } = limits()
  if (sources.length > ATTACH_MAX_FILES) throw combworkError(M.tooMuch, { files: ATTACH_MAX_FILES, total: formatBytes(total) }, { kind: 'invalid' })
  let sum = 0
  for (const s of sources) {
    if (s.size === undefined) continue
    if (s.size > file) throw combworkError(M.tooLarge, { name: s.name ?? '', max: formatBytes(file) }, { kind: 'invalid' })
    sum += s.size
  }
  if (sum > total) throw combworkError(M.tooMuch, { files: ATTACH_MAX_FILES, total: formatBytes(total) }, { kind: 'invalid' })
}

/**
 * Copies the sources into `<host>\.combwork\attachments\cards\.staging\<op>` (its op.json first), each streamed, counted and
 * hashed as it is read: past the file's limit or the call's total it stops (a file that grew since it was checked too),
 * and the whole staging goes. Nothing in it is published or visible until a change renames it into a card's folder.
 */
export async function stage(host: string, card: number | null, sources: AttachSource[]): Promise<Staging> {
  checkBatch(sources.map((s) => ('data' in s ? { size: s.data.byteLength, name: s.name } : { name: s.name ?? basename(s.path) })))
  const { file, total } = limits()
  const op = randomBytes(6).toString('hex')
  // Live from before its folder is made until it is disposed of: recovery leaves it alone meanwhile (HR4's HI-1700 round 1).
  const key = join(cardsRoot(host), STAGING, op).toLowerCase()
  liveStaging.add(key)
  const dispose = async (): Promise<void> => {
    await rm(join(cardsRoot(host), STAGING, op), { recursive: true, force: true }).catch((e) => log.warn(`Could not remove the staging folder ${userText(op)}`, e))
    liveStaging.delete(key)
  }
  let dir: string
  try {
    dir = await ownCardsFolder(host, STAGING, op)
  } catch (e) {
    await dispose()
    throw e
  }
  const files: StagedFile[] = []
  let sum = 0
  try {
    await writeFile(join(dir, OP_FILE), JSON.stringify({ kind: 'stage', card, pid: process.pid, at: new Date().toISOString() }))
    for (const [i, s] of sources.entries()) {
      const name = ('data' in s ? s.name : (s.name ?? basename(s.path))) || ''
      const tmp = join(dir, `${i}.part`)
      const hash = createHash('sha256')
      let size = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length
          sum += chunk.length
          if (size > file) return done(combworkError(M.tooLarge, { name, max: formatBytes(file) }, { kind: 'invalid' }))
          if (sum > total) return done(combworkError(M.tooMuch, { files: ATTACH_MAX_FILES, total: formatBytes(total) }, { kind: 'invalid' }))
          hash.update(chunk)
          done(null, chunk)
        }
      })
      if ('data' in s) {
        size = s.data.byteLength
        sum += size
        if (size > file) throw combworkError(M.tooLarge, { name, max: formatBytes(file) }, { kind: 'invalid' })
        if (sum > total) throw combworkError(M.tooMuch, { files: ATTACH_MAX_FILES, total: formatBytes(total) }, { kind: 'invalid' })
        hash.update(s.data)
        await writeFile(tmp, s.data)
      } else await pipeline(createReadStream(s.path), counter, createWriteStream(tmp))
      files.push({ tmp, name, size, sha256: hash.digest('hex') })
    }
  } catch (e) {
    await dispose()
    throw e
  }
  return { host, dir, files, dispose }
}

/**
 * The card dialog's drafts for one Save or Post (HI-1700): checked as a whole (the count, and the pastes' sizes before
 * anything is copied), each dropped or picked file read through its real path (the user's own choice), and staged for
 * the card's host. Null without any.
 */
export async function stageDrafts(ws: WorkspaceService, drafts: CardDrafts | undefined | null, project: string | null | undefined): Promise<{ staging: Staging; drafts: string[] } | null> {
  if (!drafts?.files?.length) return null
  if (!Array.isArray(drafts.keys) || drafts.keys.length !== drafts.files.length || drafts.keys.some((k) => !/^draft-\d{1,4}$/.test(k))) throw combworkError(M.refused, { path: '' }, { kind: 'invalid' })
  checkBatch(drafts.files.map((f) => ('data' in f ? { size: f.data?.byteLength ?? 0, name: f.name } : { name: basename(String(f.path)) })))
  // A project of the workspace, before anything is copied (a new card's names one the window was given).
  if (project && !(await allProjects(ws)).some((p) => basename(p).toLowerCase() === project.toLowerCase())) throw combworkError(M.noProject, { project }, { kind: 'invalid' })
  const sources: AttachSource[] = []
  for (const f of drafts.files) {
    if ('data' in f) {
      if (!(f.data instanceof Uint8Array)) throw combworkError(M.refused, { path: f.name ?? '' }, { kind: 'invalid' })
      sources.push({ data: f.data, name: typeof f.name === 'string' ? f.name : null })
    } else sources.push({ path: await attachableSource(ws, { kind: 'user' }, f.path), name: basename(f.path) })
  }
  return { staging: await stage(cardHost(ws, project), null, sources), drafts: drafts.keys }
}

// ---------------------------------------------------------------------------
// Publishing, removing, deleting, moving: inside a change of the board.
// ---------------------------------------------------------------------------

/** What a published staging gave each source, in order: the attachment (one row for the same bytes), and whether it is new. */
export interface Published {
  attachments: CardAttachment[]
  added: boolean[]
}

/**
 * Publishes a staging to a card, inside the change of the board that also makes the card's text (a new card, a comment):
 * the card rechecked there (it exists, its host is the staging's), the same bytes kept once (a file already on the card,
 * or twice in the batch, gives the one row), each new file renamed into the card's folder and its row inserted. Undone
 * with the change: the renamed files go again (onBoardUndone).
 */
export async function publish(ws: WorkspaceService, card: number, staging: Staging, by: string, comment: string | null): Promise<Published> {
  const c = boardWriteOp(ws, (db) => db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined) // i18n-ignore: SQL
  if (!c) throw combworkError(M.noCard, undefined, { kind: 'notFound' })
  const host = cardHost(ws, c.project)
  if (host.toLowerCase() !== staging.host.toLowerCase()) throw combworkError(M.moved, undefined, { kind: 'conflict' })
  const out: Published = { attachments: [], added: [] }
  if (!staging.files.length) return out
  const dir = await ownCardsFolder(host, String(card))
  const bySha = new Map<string, CardAttachment>()
  for (const r of boardWriteOp(ws, (db) => db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(card) as Row[])) bySha.set(r.sha256, withPath(host, r)) // i18n-ignore: SQL
  for (const f of staging.files) {
    const kept = bySha.get(f.sha256)
    if (kept) {
      out.attachments.push(kept)
      out.added.push(false)
      continue
    }
    const target = await freeName(dir, attachmentName(f.name || null), (i) => `-${i + 1}`)
    await rename(f.tmp, target)
    onBoardUndone(ws, () => unlink(target).catch(() => undefined))
    const row: Row = { card, id: randomBytes(6).toString('hex'), file: basename(target), name: f.name || basename(target), size: f.size, sha256: f.sha256, by, at: new Date().toISOString(), comment }
    boardWriteOp(ws, (db) => db.prepare(`INSERT INTO card_attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.card, row.id, row.file, row.name, row.size, row.sha256, row.by, row.at, row.comment)) // i18n-ignore: SQL
    const a = withPath(host, row)
    bySha.set(f.sha256, a)
    out.attachments.push(a)
    out.added.push(true)
  }
  return out
}

/**
 * Attaches files to a card on their own (no text with them): checked, staged out of the lock, published in a change of
 * the board. The staging is removed whatever happens.
 */
export async function attachToCard(ws: WorkspaceService, card: number, sources: AttachSource[], by: string, comment: string | null = null): Promise<Published> {
  const project = boardRead(ws, (db) => db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined) // i18n-ignore: SQL
  if (!project) throw combworkError(M.noCard, undefined, { kind: 'notFound' })
  const staging = await stage(cardHost(ws, project.project), card, sources)
  try {
    return await boardWrite(ws, async () => {
      const out = await publish(ws, card, staging, by, comment)
      // Told to the windows once it commits: a card dialog open on it shows the file.
      if (out.added.some(Boolean)) boardChanged(ws)
      return out
    })
  } finally {
    await staging.dispose()
  }
}

/** Links a card's attachments not linked yet to the comment that names them. In the comment's change. */
export function linkToComment(ws: WorkspaceService, card: number, ids: string[], comment: string): void {
  if (!ids.length) return
  boardWriteOp(ws, (db) => {
    const st = db.prepare('UPDATE card_attachments SET comment = ? WHERE card = ? AND id = ? AND comment IS NULL') // i18n-ignore: SQL
    for (const id of ids) st.run(comment, card, id)
  })
}

/** Writes an operation's record, flushed, before anything it records is moved. */
async function writeOp(dir: string, op: object): Promise<void> {
  const f = await open(join(dir, OP_FILE), 'w')
  try {
    await f.writeFile(JSON.stringify(op))
    await f.sync()
  } finally {
    await f.close()
  }
}

/** A trash operation's end, once its change committed: what it holds to the Recycle Bin, then its record. */
async function finishTrash(dir: string): Promise<void> {
  for (const e of await readdir(dir).catch(() => [] as string[])) if (e !== OP_FILE) await trash(join(dir, e))
  await unlink(join(dir, OP_FILE)).catch(() => undefined)
  await rmdir(dir).catch(() => undefined)
}

/**
 * Removes one of a card's attachments, in one change of the board: its record written, the file renamed into the cards'
 * trash, the row deleted; once it commits, the file goes to the Recycle Bin. Undone, the file is renamed back.
 */
export async function removeCardAttachment(ws: WorkspaceService, card: number, id: string): Promise<void> {
  await boardWrite(ws, async () => {
    const found = boardWriteOp(ws, (db) => {
      const c = db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined // i18n-ignore: SQL
      const r = c && (db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ? AND id = ?`).get(card, id) as Row | undefined) // i18n-ignore: SQL
      return c && r ? { host: cardHost(ws, c.project), row: r } : null
    })
    if (!found) throw combworkError(M.noAttachment, undefined, { kind: 'notFound' })
    const from = join(cardFolder(found.host, card), found.row.file)
    if (await exists(from)) {
      const dir = await ownCardsFolder(found.host, TRASH, randomBytes(6).toString('hex'))
      await writeOp(dir, { kind: 'remove', card, files: [{ id, file: found.row.file }] })
      await rename(from, join(dir, found.row.file))
      onBoardUndone(ws, async () => {
        await rename(join(dir, found.row.file), from)
        await rm(dir, { recursive: true, force: true })
      })
      afterBoardWrite(ws, () => void finishTrash(dir).catch((e) => log.warn('sending a removed card attachment to the Recycle Bin', e)))
    }
    boardWriteOp(ws, (db) => db.prepare('DELETE FROM card_attachments WHERE card = ? AND id = ?').run(card, id)) // i18n-ignore: SQL
    boardChanged(ws)
  })
}

/** A file the clean-up planned to remove (HI-1842 round 2): its row, and the file as it was on disk ('missing': none). */
export interface CleanupFile {
  id: string
  file: string
  identity: FileIdentity | 'missing'
}

/**
 * Removes the planned files of a card (the clean-up's, HI-1842), in the change running here: only those still as they
 * were planned (the same row, and on disk the same unchanged file, or still none), in a folder that is still the host's
 * own (a real folder at every step: never through a link). One record for them, each file renamed into the cards'
 * trash, their rows deleted; once it commits, to the Recycle Bin; undone, renamed back. A file that changed, and every
 * file of a folder that isn't the host's own, is left with its row. Returns what went and how many were left.
 */
export async function removeCardAttachments(ws: WorkspaceService, card: number, planned: CleanupFile[]): Promise<{ removed: { id: string; name: string; size: number }[]; left: number; unsafe: boolean }> {
  return boardWrite(ws, async () => {
    const found = boardWriteOp(ws, (db) => {
      const c = db.prepare('SELECT project FROM cards WHERE number = ?').get(card) as { project: string | null } | undefined // i18n-ignore: SQL
      return c ? { host: cardHost(ws, c.project), rows: db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(card) as Row[] } : null // i18n-ignore: SQL
    })
    if (!found) return { removed: [], left: planned.length, unsafe: false }
    const folder = cardFolder(found.host, card)
    if ((await exists(folder)) && !(await ownFolder(found.host, folder))) {
      log.warn(`${userText(folder)} is a link or not the project's own folder: its attachments are left as they are`)
      return { removed: [], left: planned.length, unsafe: true }
    }
    // Each planned file, as it is now: the same row, and the same file on disk (or still none).
    const going: { row: Row; there: boolean }[] = []
    for (const f of planned) {
      const row = found.rows.find((r) => r.id === f.id && r.file === f.file)
      if (!row) continue
      const p = join(folder, f.file)
      if (f.identity === 'missing') {
        if (!(await lstat(p).catch(() => null))) going.push({ row, there: false })
      } else if (sameFile(f.identity, await fileIdentity(p))) going.push({ row, there: true })
    }
    const moving = going.filter((g) => g.there).map((g) => g.row)
    if (moving.length) {
      const dir = await ownCardsFolder(found.host, TRASH, randomBytes(6).toString('hex'))
      await writeOp(dir, { kind: 'remove', card, files: moving.map((r) => ({ id: r.id, file: r.file })) })
      const moved: Row[] = []
      onBoardUndone(ws, async () => {
        for (const r of moved) await rename(join(dir, r.file), join(folder, r.file))
        await rm(dir, { recursive: true, force: true })
      })
      for (const r of moving) {
        await rename(join(folder, r.file), join(dir, r.file))
        moved.push(r)
      }
      afterBoardWrite(ws, () => void finishTrash(dir).catch((e) => log.warn("sending a card's cleaned-up attachments to the Recycle Bin", e)))
    }
    if (going.length) {
      const del = boardWriteOp(ws, (db) => db.prepare('DELETE FROM card_attachments WHERE card = ? AND id = ?')) // i18n-ignore: SQL
      for (const g of going) del.run(card, g.row.id)
      boardChanged(ws)
    }
    return { removed: going.map((g) => g.row).sort(newest).map((r) => ({ id: r.id, name: r.name, size: r.size })), left: planned.length - going.length, unsafe: false }
  })
}

/**
 * A card about to be deleted, in the change that deletes it: its folder (if any) renamed into the cards' trash with its
 * record; once the change commits, to the Recycle Bin; undone, renamed back. Throws if it can't be moved (the card stays).
 */
export async function trashCardFolder(ws: WorkspaceService, card: number, project: string | null | undefined): Promise<void> {
  const host = cardHost(ws, project)
  const from = cardFolder(host, card)
  const st = await lstat(from).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink() || !st.isDirectory()) return log.warn(`${userText(from)} is a link or not a folder: left as it is`)
  const dir = await ownCardsFolder(host, TRASH, randomBytes(6).toString('hex'))
  await writeOp(dir, { kind: 'delete', card })
  await rename(from, join(dir, 'files'))
  onBoardUndone(ws, async () => {
    await rename(join(dir, 'files'), from)
    await rm(dir, { recursive: true, force: true })
  })
  afterBoardWrite(ws, () => void finishTrash(dir).catch((e) => log.warn("sending a deleted card's attachments to the Recycle Bin", e)))
}

/**
 * A card moving to another project (or out of one), in the change that moves it, the board's lock held throughout: its
 * files copied (never moved) into the new host's staging and renamed into its folder there; once the change commits the
 * old folder goes to the Recycle Bin; undone, the copies go. Throws (the move is refused, nothing changed) if a copy fails.
 */
export async function moveCardFolder(ws: WorkspaceService, card: number, from: string | null | undefined, to: string | null | undefined): Promise<void> {
  const fromHost = cardHost(ws, from)
  const toHost = cardHost(ws, to)
  if (fromHost.toLowerCase() === toHost.toLowerCase()) return
  const rows = boardWriteOp(ws, (db) => db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(card) as Row[]) // i18n-ignore: SQL
  const src = cardFolder(fromHost, card)
  if (!rows.length && !(await exists(src))) return
  const placed: string[] = []
  let staging: string | null = null
  try {
    staging = await ownCardsFolder(toHost, STAGING, randomBytes(6).toString('hex'))
    await writeFile(join(staging, OP_FILE), JSON.stringify({ kind: 'move', card, at: new Date().toISOString() }))
    for (const r of rows) if (await exists(join(src, r.file))) await copyFile(join(src, r.file), join(staging, r.file))
    const dest = await ownCardsFolder(toHost, String(card))
    for (const r of rows) {
      if (!(await exists(join(staging, r.file)))) continue
      await rename(join(staging, r.file), join(dest, r.file))
      placed.push(join(dest, r.file))
    }
  } catch (e) {
    for (const p of placed) await unlink(p).catch(() => undefined)
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw combworkError(M.moveFailed, { project: to ?? '', why: e instanceof Error ? e.message : String(e) }, { kind: 'conflict', cause: e })
  }
  await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  onBoardUndone(ws, async () => {
    for (const p of placed) await unlink(p).catch(() => undefined)
  })
  afterBoardWrite(ws, () => void (exists(src).then((there) => (there ? trash(src) : undefined)).catch((e) => log.warn(`Could not send the old attachments folder ${userText(src)} to the Recycle Bin`, e))))
}

// ---------------------------------------------------------------------------
// Recovery (s13 §1): at the next open, under the board's lock and the workspace's lifetime.
// ---------------------------------------------------------------------------

export interface CardAttachmentRecovery {
  restored: number
  binned: number
  staged: number
  left: number
}

/**
 * Settles what an interrupted operation left in each host's cards folder, from the committed board: a removal or deletion
 * whose change didn't commit is put back (the row or card is still there), one that did goes to the Recycle Bin; staging
 * goes (no operation is mid-way under the lock); a folder of a deleted card goes to the Recycle Bin; one of a card now
 * kept elsewhere goes once its own folder holds every file (copied there first where missing); a file with no row goes
 * to the Recycle Bin. A record that can't be read is left as it is. Never throws.
 */
export async function recoverCardAttachments(ws: WorkspaceService): Promise<CardAttachmentRecovery> {
  const out: CardAttachmentRecovery = { restored: 0, binned: 0, staged: 0, left: 0 }
  const path = ws.path
  if (!path) return out
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  const hosts = [path, ...(await allProjects(ws))]
  for (const host of hosts) {
    const root = cardsRoot(host)
    if (!alive()) break
    if (!(await exists(root))) continue
    try {
      await boardWrite(ws, () => recoverHost(ws, host, root, out), { alive })
    } catch (e) {
      log.warn(`recovering the card attachments of ${userText(basename(host))}`, e)
    }
  }
  if (out.restored || out.binned || out.staged || out.left) log.info(`Card attachments recovered: ${out.restored} put back, ${out.binned} to the Recycle Bin, ${out.staged} staging folder(s) removed, ${out.left} left`)
  return out
}

/** A real folder of the host's own (no link, really inside it), there now; no folder is made. */
async function ownFolderNow(host: string, p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return !!st && !st.isSymbolicLink() && st.isDirectory() && insideReal(p, [host])
}

/** A plain file directly in `dir` (no link, really inside it). */
async function ownFileIn(dir: string, name: string): Promise<boolean> {
  if (!plainName(name)) return false
  const p = join(dir, name)
  const st = await lstat(p).catch(() => null)
  return !!st && !st.isSymbolicLink() && st.isFile() && insideReal(p, [dir])
}

/** An attachment's id, as Hive makes them (12 hex digits). */
const ATTACHMENT_ID = /^[0-9a-f]{12}$/

/** A trash operation's record, checked: its kind, a card's number, and for a removal each file's id and plain name. Null when it isn't one. */
function trashRecord(v: unknown): { kind: 'remove'; card: number; files: { id: string; file: string }[] } | { kind: 'delete'; card: number } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as { kind?: unknown; card?: unknown; files?: unknown }
  if (typeof r.card !== 'number' || !Number.isInteger(r.card) || r.card < 1) return null
  if (r.kind === 'delete') return { kind: 'delete', card: r.card }
  if (r.kind !== 'remove' || !Array.isArray(r.files) || !r.files.length) return null
  const files: { id: string; file: string }[] = []
  for (const f of r.files as unknown[]) {
    const x = f as { id?: unknown; file?: unknown }
    if (!x || typeof x.id !== 'string' || !ATTACHMENT_ID.test(x.id) || typeof x.file !== 'string' || !plainName(x.file)) return null
    files.push({ id: x.id, file: x.file })
  }
  return { kind: 'remove', card: r.card, files }
}

/**
 * Settles one host's cards folder (recoverCardAttachments), its whole chain checked first (`.combwork`, `attachments`,
 * `cards`: real folders of the host's own, never through a link) and each step again before it is used. A record that
 * isn't one Hive writes (a path in a name, an id or number it never makes) is left as it is, and logged: nothing it
 * names is touched. A file it names must be a plain file in its own operation's folder, and, put back, the one its row
 * names.
 */
async function recoverHost(ws: WorkspaceService, host: string, root: string, out: CardAttachmentRecovery): Promise<void> {
  for (const p of [join(host, CW_DIR), join(host, CW_DIR, ATTACHMENTS_DIR), root]) {
    if (!(await ownFolderNow(host, p))) {
      out.left++
      return log.warn(`${userText(p)} is a link or not a folder: its card attachments are left as they are`)
    }
  }
  const cardOf = (n: number): { project: string | null } | undefined => boardWriteOp(ws, (db) => db.prepare('SELECT project FROM cards WHERE number = ?').get(n) as { project: string | null } | undefined) // i18n-ignore: SQL
  const rowsOf = (n: number): Row[] => boardWriteOp(ws, (db) => db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(n) as Row[]) // i18n-ignore: SQL
  const homeOf = (card: { project: string | null }): string | null => {
    try {
      return cardHost(ws, card.project)
    } catch {
      return null
    }
  }
  const here = (card: { project: string | null } | undefined): boolean => !!card && homeOf(card)?.toLowerCase() === host.toLowerCase()
  // Interrupted removals and deletions, each by its own record.
  const trashRoot = join(root, TRASH)
  if (await ownFolderNow(host, trashRoot)) {
    for (const op of await readdir(trashRoot).catch(() => [] as string[])) {
      const dir = join(trashRoot, op)
      if (!plainName(op) || !(await ownFolderNow(host, dir))) {
        out.left++
        log.warn(`${userText(dir)} is a link or not a folder: left as it is`)
        continue
      }
      let rec: ReturnType<typeof trashRecord> = null
      try {
        rec = trashRecord(JSON.parse(await readFile(join(dir, OP_FILE), 'utf8')))
      } catch {
        rec = null
      }
      if (!rec) {
        out.left++
        log.warn(`${userText(dir)} has no record Combwork wrote: left as it is`)
        continue
      }
      if (rec.kind === 'remove') {
        const card = cardOf(rec.card)
        const rows = rowsOf(rec.card)
        for (const f of rec.files) {
          if (!(await ownFileIn(dir, f.file))) continue
          const row = rows.find((r) => r.id === f.id)
          if (row && row.file.toLowerCase() === f.file.toLowerCase() && here(card)) {
            const dest = await ownCardsFolder(host, String(rec.card))
            if (await lstat(join(dest, f.file)).catch(() => null)) {
              out.left++
              log.warn(`${userText(f.file)} is in its card's folder again: the one removed is left in ${userText(dir)}`)
              continue
            }
            await rename(join(dir, f.file), join(dest, f.file))
            out.restored++
          } else {
            await trash(join(dir, f.file))
            out.binned++
          }
        }
      } else {
        const files = join(dir, 'files')
        if (await ownFolderNow(host, files)) {
          if (here(cardOf(rec.card)) && !(await lstat(cardFolder(host, rec.card)).catch(() => null))) {
            await rename(files, cardFolder(host, rec.card))
            out.restored++
          } else {
            await trash(files)
            out.binned++
          }
        }
      }
      await finishTrash(dir)
    }
  }
  // Staging no operation of this Hive's is using (it registers its own from before it is made), nor another Hive's
  // still running.
  const stagingRoot = join(root, STAGING)
  if (await ownFolderNow(host, stagingRoot)) {
    for (const op of await readdir(stagingRoot).catch(() => [] as string[])) {
      const dir = join(stagingRoot, op)
      if (liveStaging.has(dir.toLowerCase())) continue
      if (!plainName(op) || !(await ownFolderNow(host, dir))) {
        out.left++
        continue
      }
      const pid = await readFile(join(dir, OP_FILE), 'utf8').then((t) => (JSON.parse(t) as { pid?: unknown }).pid, () => undefined)
      if (otherAlive(pid)) continue
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      out.staged++
    }
  }
  // Cards' folders.
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.isSymbolicLink() || !/^[1-9]\d{0,15}$/.test(e.name)) continue
    const n = Number(e.name)
    const dir = join(root, e.name)
    if (!(await ownFolderNow(host, dir))) continue
    const card = cardOf(n)
    if (!card) {
      await trash(dir)
      out.binned++
      continue
    }
    const rows = rowsOf(n).filter((r) => plainName(r.file))
    const home = homeOf(card)
    if (!home) continue
    if (home.toLowerCase() !== host.toLowerCase()) {
      // A folder left by a move: every row's file copied to the card's own folder first where it is missing there.
      const own = cardFolder(home, n)
      for (const r of rows) {
        if ((await lstat(join(own, r.file)).catch(() => null)) || !(await ownFileIn(dir, r.file))) continue
        await copyFile(join(dir, r.file), join(await ownCardsFolder(home, String(n)), r.file))
        out.restored++
      }
      await trash(dir)
      out.binned++
      continue
    }
    const named = new Set(rows.map((r) => r.file.toLowerCase()))
    for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!f.isFile() || named.has(f.name.toLowerCase())) continue
      await trash(join(dir, f.name))
      out.binned++
    }
  }
}

/** The most of an attachment's text one read gives (HI-1751): a longer one is read in pages, by `offset`. */
export const ATTACHMENT_PAGE = 64 * 1024
/** How much of a file's start is looked at for a NUL byte, which makes it binary. */
const SNIFF = 8192

/**
 * What reading a card's attachment gives an agent (HI-1751): a page of its text (`next`: the byte offset to read from
 * for the page after it, absent at its end), or its kind and path when it isn't UTF-8 text.
 */
export type AttachmentRead =
  | { name: string; file: string; size: number; kind: 'text'; offset: number; content: string; next?: number }
  | { name: string; file: string; size: number; kind: 'image' | 'pdf' | 'binary'; path: string }

/**
 * Why an attachment can't be read: none by that name (`choices`: the card's), several (`choices`: those), its file gone,
 * not where its card keeps it (a link on the way, a name that isn't plain), the card or file changed while it was read
 * (read the card again), or an offset that isn't a byte of it (`size`).
 */
export type AttachmentReadProblem = { problem: 'unknown' | 'ambiguous' | 'missing' | 'outside' | 'changed' | 'offset'; choices?: string[]; size?: number }

/**
 * Tests: run between the checks before the open and the open (`beforeOpen`: a folder swapped for a link, which Windows
 * won't allow once the file is open), and between the open and the checks after it (a swap, a move, a deletion meanwhile).
 */
export const attachmentReadSeams: { beforeOpen: (() => Promise<void>) | null; afterOpen: (() => Promise<void>) | null } = { beforeOpen: null, afterOpen: null }

/**
 * A card's attachment for an agent (HI-1751: HR2 couldn't read HI-1702's evidence, the document tools refusing `.combwork`),
 * by its name or its file's name in the card's folder (`<time>_<name>`). `card`: the card as the caller was allowed to
 * read it (its scope checked), whose project decides the folder: one moved or deleted meanwhile is refused, never read
 * from another place. Only a regular file is read, its whole folder chain (`.combwork`, `attachments`, `cards`, the card's)
 * and itself no link, its name plain, checked before it is opened and again after, with the opened file's identity; the
 * card's row is checked again before the reply. Text (UTF-8, no NUL in its first 8 KB) is read from the byte `offset`
 * (a whole number from 0 to its size), ATTACHMENT_PAGE at a time and never more, each page ending on a whole character
 * (a first page leaving out a byte-order mark), so the pages' contents joined are its text; bytes that aren't UTF-8 make
 * it binary. An image, a PDF or a binary file gives its kind and path (the same offset rules), for the CLI's own reading.
 */
export async function readCardAttachment(ws: WorkspaceService, card: { number: number; project: string | null }, name: string, offsetRaw: string | null = null, page = ATTACHMENT_PAGE): Promise<AttachmentRead | AttachmentReadProblem> {
  const n = card.number
  const sameProject = (p: string | null | undefined): boolean => (p ?? null)?.toLowerCase() === card.project?.toLowerCase()
  const now = (): { project: string | null; rows: Row[] } | null =>
    boardRead(ws, (db) => {
      const c = db.prepare('SELECT project FROM cards WHERE number = ?').get(n) as { project: string | null } | undefined // i18n-ignore: SQL
      return c ? { project: c.project, rows: db.prepare(`SELECT ${COLUMNS} FROM card_attachments WHERE card = ?`).all(n) as Row[] } : null // i18n-ignore: SQL
    })
  const first = now()
  if (!first || !sameProject(first.project)) return { problem: 'changed' }
  const want = name.trim().toLowerCase()
  const byFile = first.rows.filter((r) => r.file.toLowerCase() === want)
  const found = byFile.length ? byFile : first.rows.filter((r) => r.name.toLowerCase() === want)
  if (found.length !== 1) return { problem: found.length ? 'ambiguous' : 'unknown', choices: (found.length ? found : first.rows.sort(newest)).map((r) => r.file) }
  const row = found[0]
  if (!plainName(row.file)) return { problem: 'outside' }
  const host = cardHost(ws, card.project)
  const folder = cardFolder(host, n)
  const path = join(folder, row.file)
  // Each folder from the host's .combwork down to the card's, and the file: there, and none of them a link.
  const chain = [join(host, CW_DIR), join(host, CW_DIR, ATTACHMENTS_DIR), cardsRoot(host), folder]
  const plain = async (): Promise<'ok' | 'missing' | 'outside'> => {
    for (const d of chain) {
      const st = await lstat(d).catch(() => null)
      if (!st) return 'missing'
      if (st.isSymbolicLink() || !st.isDirectory()) return 'outside'
    }
    const st = await lstat(path, { bigint: true }).catch(() => null)
    if (!st) return 'missing'
    if (st.isSymbolicLink() || !st.isFile() || !insideReal(path, [folder])) return 'outside'
    return 'ok'
  }
  const before = await plain()
  if (before !== 'ok') return { problem: before }
  await attachmentReadSeams.beforeOpen?.()
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return { problem: 'missing' }
  try {
    const opened = await fh.stat({ bigint: true })
    await attachmentReadSeams.afterOpen?.()
    // After the open: the chain still plain, and the path still the file that was opened.
    const after = await plain()
    if (after !== 'ok') return { problem: after === 'missing' ? 'changed' : after }
    const leaf = await lstat(path, { bigint: true }).catch(() => null)
    if (!leaf || leaf.dev !== opened.dev || leaf.ino !== opened.ino) return { problem: 'changed' }
    const size = Number(opened.size)
    const from = offsetRaw === null || offsetRaw === '' ? 0 : /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : NaN
    if (!Number.isSafeInteger(from) || from > size) return { problem: 'offset', size }
    const head = { name: row.name, file: row.file, size }
    const still = (): boolean => {
      const again = now()
      return !!again && sameProject(again.project) && again.rows.some((r) => r.id === row.id && r.file === row.file)
    }
    const kind = attachmentKind(row.name)
    const binary = (k: 'image' | 'pdf' | 'binary'): AttachmentRead | AttachmentReadProblem => (still() ? { ...head, kind: k, path } : { problem: 'changed' })
    if (kind === 'image' || kind === 'pdf') return binary(kind)
    const sniff = Buffer.alloc(Math.min(SNIFF, size))
    const got = (await fh.read(sniff, 0, sniff.length, 0)).bytesRead
    if (sniff.subarray(0, got).includes(0)) return binary('binary')
    // A page and up to 3 bytes after it, so its end can move back to a whole character (the byte after a cut is never
    // a UTF-8 continuation byte, 10xxxxxx): never more read than that.
    const buf = Buffer.alloc(Math.min(page + 3, size - from))
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    // Shorter than its size at the open: changed meanwhile (an offset that moved on by nothing would read forever).
    if (bytesRead < buf.length) return { problem: 'changed' }
    let end = Math.min(bytesRead, page)
    if (end < bytesRead) {
      let back = end
      while (back > 0 && (buf[back] & 0xc0) === 0x80) back--
      if (back > 0) end = back
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, end))
    } catch {
      return binary('binary')
    }
    if (!still()) return { problem: 'changed' }
    const content = from === 0 && text.startsWith('\uFEFF') ? text.slice(1) : text
    return { ...head, kind: 'text', offset: from, content, ...(from + end < size ? { next: from + end } : {}) }
  } finally {
    await fh.close()
  }
}

/** Tests: the staging and trash folders' names. */
export const CARD_FOLDERS_FOR_TESTS = { STAGING, TRASH, OP_FILE }
