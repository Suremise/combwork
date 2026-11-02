import { activityTurns, type ActivityDetail, type ActivityTurns } from '../shared/activity'
import { maskText } from '../shared/redact'
import { open, stat } from 'original-fs/promises'
import type { ProviderId, Transcript, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '../shared/types'
import { TRANSCRIPT_WINDOW, assertSessionId } from '../shared/defaults'
import { formatDateTime } from '../shared/dates'
import { msg, tr } from '../shared/i18n'
import { hiveError } from './hiveError'
import { provider } from './providers'
import { searchItems, shownNotice, transcriptMarkdown } from './providers/conversation'
import type { ConversationParserLike } from './providers/types'
import { sessions } from './sessions'
import { setViewing, whileReading } from './transcriptReads'
import { workspace } from './workspace'
import { isGz, readBytes, readTranscript } from './transcriptFiles'
import { toolForDisplay } from './transcriptDisplay'

/** The Sessions tab's refusals, in the window's language (#850). */
const M = {
  busy: msg({ id: 'service.transcripts.busy', defaultMessage: 'This session is being archived or deleted. Try again in a moment.', description: "An error opening a session's conversation in the Sessions tab while it is being archived or deleted." })
}

/**
 * The Sessions tab's transcript viewer. Parsed transcripts are cached and followed incrementally
 * (providers only append), so re-reading a live session costs only the new lines. Each provider has its
 * own parser into the same items.
 */

interface Entry {
  path: string
  provider: ProviderId
  parser: ConversationParserLike
  size: number
  /** A compressed backup's identity when read (size, modified time, file id): it is replaced whole, never appended to. */
  stamp: string
  used: number
}

/** What the viewer passes back to learn nothing changed: a plain file's size read, a compressed one's identity. */
const versionOf = (e: Entry): string => (isGz(e.path) ? `gz:${e.stamp}` : String(e.size))

const MAX_CACHED = 6
/** How much of a transcript is read at a time. */
const READ_CHUNK = 4 * 1024 * 1024
const cache = new Map<string, Entry>()

async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

const pending = new Map<string, Promise<unknown>>()

/**
 * One read at a time per transcript: two overlapping reads (the 2-second poll and a search, say) would
 * otherwise both feed the same new bytes to the parser and duplicate messages.
 */
async function parsed(projectPath: string, sessionId: string): Promise<Entry> {
  // A project, or the Hive Assistant's home (its conversations are browsed the same way).
  projectPath = workspace.assertSessionHost(projectPath)
  // The id becomes part of a file name, so only accept plain ids (UUIDs).
  assertSessionId(sessionId)
  // Not while its files move: archiving or deleting it reserves it first.
  if (sessions.reserved(projectPath, sessionId)) throw hiveError(M.busy, undefined, { kind: 'conflict' })
  const key = `${projectPath.toLowerCase()}|${sessionId}`
  const run = (pending.get(key) ?? Promise.resolve()).then(
    () => whileReading(projectPath, sessionId, () => parseNow(projectPath, sessionId, key)),
    () => whileReading(projectPath, sessionId, () => parseNow(projectPath, sessionId, key))
  )
  const tail = run.catch(() => undefined)
  pending.set(key, tail)
  void tail.then(() => {
    if (pending.get(key) === tail) pending.delete(key)
  })
  return run
}

async function parseNow(projectPath: string, sessionId: string, key: string): Promise<Entry> {
  const path = await sessions.anyTranscript(projectPath, sessionId)
  if (!path) throw hiveError(msg({ id: 'service.transcripts.none', defaultMessage: 'This session has no transcript yet.', description: "An error in the Sessions tab: the session's CLI hasn't written its conversation's file yet." }), undefined, { kind: 'notFound' })
  const st = await stat(path)
  const size = st.size
  // A compressed backup (#1110) is replaced whole when a resumed session ends, possibly by one of the same size: it is
  // told apart by its identity, and read whole again when that changes.
  const stamp = isGz(path) ? `${st.size}:${st.mtimeMs}:${st.ino}` : ''
  let e = cache.get(key)
  // A different file (the provider deleted it and Hive's backup is used), a shorter one or another compressed one means
  // start again.
  if (!e || e.path !== path || (isGz(path) ? stamp !== e.stamp : size < e.parser.offset)) {
    const id = await sessions.sessionProvider(projectPath, sessionId)
    e = { path, provider: id, parser: provider(id).conversationParser(projectPath), size: 0, stamp: '', used: 0 }
    cache.set(key, e)
  }
  e.used = Date.now()
  if (isGz(path)) {
    if (e.stamp !== stamp) {
      // Decompressed a piece at a time, each handed to the parser as a plain file's would be.
      const parser = e.parser
      await readTranscript(path, 0, (piece) => void parser.feed(piece), READ_CHUNK)
      e.size = size
      e.stamp = stamp
    }
  } else if (size !== e.size) {
    // In pieces, so a long transcript opened for the first time doesn't take its whole size in memory at once.
    let chunk = READ_CHUNK
    while (e.parser.offset < size) {
      const before = e.parser.offset
      const end = Math.min(size, before + chunk)
      e.parser.feed(await readRange(path, before, end))
      if (e.parser.offset > before) continue
      // One line longer than the piece (a large image): read a bigger piece; at the end, a line still being written.
      if (end === size) break
      chunk *= 2
    }
    e.size = size
  }
  if (cache.size > MAX_CACHED) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].used - b[1].used)[0]
    cache.delete(oldest[0])
  }
  return e
}

function forDisplay(item: TranscriptItem): TranscriptItem {
  // Hive's own notices in the language the window shows (#797); the cache keeps them as data.
  if (item.kind === 'notice') return item.message ? { ...item, text: shownNotice(item) } : item
  if (item.kind !== 'tool') return item
  return { ...item, tool: toolForDisplay(item.tool) }
}

export const transcripts = {
  /**
   * The conversation from item `from` on (by default the latest TRANSCRIPT_WINDOW items: the viewer loads
   * earlier ones as you scroll up), or null when the file hasn't changed since knownVersion.
   */
  async read(projectPath: string, sessionId: string, opts: { knownVersion?: string; from?: number } = {}): Promise<Transcript | null> {
    const e = await parsed(projectPath, sessionId)
    const version = versionOf(e)
    if (opts.knownVersion !== undefined && opts.knownVersion === version) return null
    const total = e.parser.items.length
    const from = Math.max(0, Math.min(total, opts.from ?? total - TRANSCRIPT_WINDOW))
    return { sessionId, size: e.size, version, total, from, items: e.parser.items.slice(from).map(forDisplay) }
  },

  /** A session's latest turns for the Activity tab (#1254), from the same parse; null when the file hasn't changed since knownVersion. */
  async turns(projectPath: string, sessionId: string, knownVersion?: string): Promise<ActivityTurns | null> {
    const e = await parsed(projectPath, sessionId)
    const version = versionOf(e)
    if (knownVersion !== undefined && knownVersion === version) return null
    return { sessionId, version, ...activityTurns(e.parser.items) }
  },

  /**
   * An item's whole text for the Activity tab's details (#1254): a prompt, or a tool call's input and result, as written
   * (line breaks kept, nothing cut), masked like the log. Null when the item isn't a prompt or a tool call.
   */
  async detail(projectPath: string, sessionId: string, itemId: number): Promise<ActivityDetail | null> {
    const item = (await parsed(projectPath, sessionId)).parser.items[itemId]
    if (item?.kind === 'user') return { input: maskText(item.text), result: null }
    if (item?.kind === 'tool') return { input: maskText(item.tool.input), result: item.tool.result === null ? null : maskText(item.tool.result) }
    return null
  },

  async tool(projectPath: string, sessionId: string, itemId: number): Promise<TranscriptTool> {
    const item = (await parsed(projectPath, sessionId)).parser.items[itemId]
    if (item?.kind !== 'tool') throw hiveError(msg({ id: 'service.transcripts.noTool', defaultMessage: 'No such tool call', description: "An error in the Sessions tab: the tool call asked for isn't in the conversation (any more)." }), undefined, { kind: 'notFound' })
    return item.tool
  },

  /** An image from the transcript as a data URL. */
  async image(projectPath: string, sessionId: string, imageId: number): Promise<string> {
    return whileReading(projectPath, sessionId, () => this.imageNow(projectPath, sessionId, imageId))
  },

  async imageNow(projectPath: string, sessionId: string, imageId: number): Promise<string> {
    const e = await parsed(projectPath, sessionId)
    const loc = e.parser.images[imageId]
    if (!loc) throw hiveError(msg({ id: 'service.transcripts.noImage', defaultMessage: 'No such image', description: "An error in the Sessions tab: the image asked for isn't in the conversation (any more)." }), undefined, { kind: 'notFound' })
    const entry = JSON.parse((await readBytes(e.path, loc.offset, loc.offset + loc.length)).toString('utf8'))
    const url = provider(e.provider).imageData(entry, loc)
    if (!url) throw hiveError(msg({ id: 'service.transcripts.imageNotKept', defaultMessage: 'The image is not stored in the transcript', description: "An error in the Sessions tab: the conversation's file mentions the image but doesn't hold it." }), undefined, { kind: 'notFound' })
    return url
  },

  /** A Sessions view of the window shows this session's transcript now (null: none); see transcriptReads. */
  viewing(window: number, view: string, projectPath: string, sessionId: string | null): void {
    projectPath = workspace.assertSessionHost(projectPath)
    if (sessionId !== null) assertSessionId(sessionId)
    // Not a session being archived or deleted: its view opens once that is over (and reads it then).
    if (sessionId !== null && sessions.reserved(projectPath, sessionId)) throw hiveError(M.busy, undefined, { kind: 'conflict' })
    setViewing(window, view, projectPath, sessionId)
  },

  /** The item ids of the transcript's compactions, oldest first (the Overview's compaction history opens one). */
  async compactions(projectPath: string, sessionId: string): Promise<number[]> {
    const items = (await parsed(projectPath, sessionId)).parser.items
    return items.flatMap((item, id) => (item.kind === 'compaction' ? [id] : []))
  },

  /** Searches one session, or every session of the project when sessionId is null. */
  async search(projectPath: string, query: string, sessionId: string | null): Promise<TranscriptSearchResult[]> {
    const ids = sessionId ? [sessionId] : (await sessions.list(projectPath)).map((s) => s.id)
    const out: TranscriptSearchResult[] = []
    let total = 0
    for (const id of ids) {
      if (total >= 500) break
      const e = await parsed(projectPath, id).catch(() => null)
      if (!e) continue
      const { hits, more } = searchItems(e.parser.items, query, sessionId ? 500 : Math.min(100, 500 - total))
      if (!hits.length) continue
      total += hits.length
      out.push({ sessionId: id, hits, more })
    }
    return out
  },

  async markdown(projectPath: string, sessionId: string, title: string): Promise<string> {
    return whileReading(projectPath, sessionId, () => this.markdownNow(projectPath, sessionId, title))
  },

  async markdownNow(projectPath: string, sessionId: string, title: string): Promise<string> {
    const e = await parsed(projectPath, sessionId)
    const project = workspace.assertSessionHost(projectPath)
    const p = provider(e.provider)
    const subtitle = tr(msg({ id: 'service.transcripts.exported', defaultMessage: '{session} · exported from Hive {date}', description: 'The line under the title of a conversation exported as Markdown (Sessions tab → Export): {session} says which session it was, {date} when it was exported.' }), { session: p.exportSubtitle(sessionId, project), date: formatDateTime(new Date()) })
    return transcriptMarkdown(e.parser.items, title, subtitle, p.descriptor.assistant)
  }
}
