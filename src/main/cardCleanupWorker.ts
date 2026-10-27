import { lstat } from 'original-fs/promises'
import { join } from 'path'
import { parentPort } from 'worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { archivedSince, cleanupDue } from '../shared/cardCleanup'
import { composeCard, readCardRows } from './schema/cardRows'
import { fileIdentity, ownFolder, type FileIdentity } from './cardCleanupFs'

/**
 * The card attachments' clean-up plan (HI-1842 round 2), in a thread of its own: which of a project's archived cards are
 * due, and each due card's files as they are on disk now. It reads the board on a read-only connection of its own, opened
 * for one request and closed after it, and changes nothing: main applies the plan, a card at a time, checking each card
 * and file again in the board's change (cardAttachmentCleanup.ts). A request examines at most `examine` cards, from the
 * card after `after`, and plans at most `due` of them, so it is bounded whatever the board holds. No Electron here.
 */

/** A file of a due card, as planned: its row, and the file on disk then ('missing': none there, its row only). */
export interface PlannedFile {
  id: string
  file: string
  name: string
  size: number
  identity: FileIdentity | 'missing'
}

/** A due card, as planned. */
export interface PlannedCard {
  card: number
  title: string
  archivedAt: string
  files: PlannedFile[]
}

export interface PlanRequest {
  id: number
  /** The board's database. */
  db: string
  /** The project's folder, and its cards' attachments folder under it. */
  host: string
  cardsRoot: string
  project: string
  days: number
  now: number
  dayMs: number
  /** The card number to start after (a run's cursor), and the most cards to examine and to plan. */
  after: number
  examine: number
  due: number
}

export interface PlanResult {
  cards: PlannedCard[]
  /** Cards whose folder isn't the host's own, or holds a link where a file was: left as they are. */
  unsafe: number[]
  /** The last card examined (the next request starts after it), and whether the board had more past it. */
  last: number
  more: boolean
}

export type PlanReply = { id: number; ok: true; value: PlanResult } | { id: number; ok: false; error: string }

/** Plans a batch (in the worker, or here in unit tests). */
export async function planCleanup(m: PlanRequest): Promise<PlanResult> {
  const db = new DatabaseSync(m.db, { readOnly: true, timeout: 5000 })
  try {
    const legacy = db.prepare("SELECT 1 FROM pragma_table_info('cards') WHERE name = 'doc'").get() !== undefined // i18n-ignore: SQL
    // Only cards that can be due: archived, not with a hidden or removed project, with attachments. The rest never use
    // up a batch, so cards that never qualify can't keep later ones from being reached.
    const kept = legacy ? "coalesce(json_extract(c.doc, '$.archivedFor'), '')" : "coalesce(c.archived_for, '')" // i18n-ignore: SQL
    const candidates = db
      .prepare(`SELECT c.number AS n FROM cards c WHERE c.archived = 1 AND c.project = ? COLLATE NOCASE AND ${kept} NOT IN ('project-hidden', 'project-removed') AND c.number > ? AND EXISTS (SELECT 1 FROM card_attachments a WHERE a.card = c.number) ORDER BY c.number LIMIT ?`) // i18n-ignore: SQL
      .all(m.project, m.after, m.examine + 1) as { n: number }[]
    const more = candidates.length > m.examine
    const out: PlanResult = { cards: [], unsafe: [], last: m.after, more }
    for (const { n } of candidates.slice(0, m.examine)) {
      if (out.cards.length >= m.due) {
        out.more = true
        break
      }
      out.last = n
      const doc = legacy ? JSON.parse((db.prepare('SELECT doc FROM cards WHERE number = ?').get(n) as { doc: string }).doc) : composeCard(readCardRows(db, { numbers: [n] })[0]) // i18n-ignore: SQL
      const card = doc as { title?: string; archived?: boolean; archivedFor?: string; history?: { at: string; what: string }[]; updatedAt?: string }
      const c = { archived: !!card.archived, archivedFor: card.archivedFor as never, history: (card.history ?? []) as never, updatedAt: card.updatedAt ?? '' }
      if (!cleanupDue(c, m.days, m.now, m.dayMs)) continue
      const folder = join(m.cardsRoot, String(n))
      const rows = db.prepare('SELECT id, file, name, size FROM card_attachments WHERE card = ? ORDER BY at, file').all(n) as { id: string; file: string; name: string; size: number }[] // i18n-ignore: SQL
      const there = await lstat(folder).catch(() => null)
      if (there && !(await ownFolder(m.host, folder))) {
        out.unsafe.push(n)
        continue
      }
      const files: PlannedFile[] = []
      let unsafe = false
      for (const r of rows) {
        const p = join(folder, r.file)
        const st = await lstat(p).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? 'missing' : null))
        const identity = st === 'missing' ? 'missing' : await fileIdentity(p)
        if (!identity) unsafe = true
        else files.push({ ...r, identity })
      }
      if (unsafe) out.unsafe.push(n)
      else if (files.length) out.cards.push({ card: n, title: card.title ?? '', archivedAt: new Date(archivedSince(c)).toISOString(), files })
    }
    return out
  } finally {
    db.close()
  }
}

const port = parentPort
if (port) {
  port.on('message', (m: PlanRequest) => {
    planCleanup(m).then(
      (value) => port.postMessage({ id: m.id, ok: true, value } satisfies PlanReply),
      (e) => port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies PlanReply)
    )
  })
}
