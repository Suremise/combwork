import { basename, dirname, join, resolve } from 'path'
import { open, readdir, realpath, stat } from 'original-fs/promises'
import { fileURLToPath } from 'url'
import type { SubSession } from '../../../shared/types'
import type { ExternalSession } from '../types'
import { keepBounded, readFirstLine } from '../common'
import { brainDir } from './home'
import { annotationTitle, parentOf } from './transcript'

// Where agy keeps an agent's conversations in its profile (HI-2546, read from 1.5.0's): brain\<id>\.system_generated\logs
// holds transcript_full.jsonl (what its hooks name; transcript.jsonl beside it, each argument encoded again, isn't read) and
// a tool's images in media\; annotations\<id>.pbtxt the conversation's title; cache\last_conversations.json the folder each
// last conversation ran in. The conversation itself is conversations\<id>.db, which a resume reads: a transcript put back
// from a backup doesn't bring it back.
//
// Every file Combwork reads here is checked by its real path (links and junctions followed) to be where it should be in
// one of Combwork's profiles, never anywhere a link, agy's word or another conversation points.

/** A conversation id as agy makes them (a UUID). */
export const isConversationId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** The transcript Combwork reads: the full one, its arguments as agy gave them. */
export const TRANSCRIPT_FILE = 'transcript_full.jsonl'

export const logsDir = (profile: string, id: string): string => join(brainDir(profile), id, '.system_generated', 'logs')

const key = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/** `path`'s parts under `root` (both as given), or null when it isn't under it. */
function partsUnder(path: string, root: string): string[] | null {
  const p = resolve(path)
  const r = key(root)
  if (!p.toLowerCase().startsWith(r + '\\') && !p.toLowerCase().startsWith(r + '/')) return null
  return p.slice(r.length + 1).split(/[\\/]/)
}

/** <profile key>\.gemini\antigravity-cli\brain\<id>\.system_generated\logs\…: the conversation's id, when parts are that. */
function conversationOf(parts: string[], rest: number): string | null {
  if (parts.length !== 7 + rest || parts[1] !== '.gemini' || parts[2] !== 'antigravity-cli' || parts[3] !== 'brain' || parts[5] !== '.system_generated' || parts[6] !== 'logs') return null
  return isConversationId(parts[4]) ? parts[4] : null
}

/** Whether a path names a conversation's transcript in a profile under `root` (that conversation's, given `id`), as written. */
export function profileTranscript(path: string, root: string, id?: string): boolean {
  const parts = partsUnder(path, root)
  const conv = parts ? conversationOf(parts, 1) : null
  return !!conv && parts![7] === TRANSCRIPT_FILE && (id === undefined || conv.toLowerCase() === id.toLowerCase())
}

/**
 * A file's real path when it is where `path` says, under `root`'s real path, with no link or junction on the way taking it
 * elsewhere (each part the same, compared without case); else null.
 */
async function realSame(path: string, root: string): Promise<string | null> {
  try {
    const [real, realRoot] = await Promise.all([realpath(path), realpath(root)])
    const want = partsUnder(path, root)
    const got = partsUnder(real, realRoot)
    if (!want || !got || want.length !== got.length || want.some((p, i) => p.toLowerCase() !== got[i].toLowerCase())) return null
    return real
  } catch {
    return null
  }
}

/**
 * A conversation's transcript, as agy reported it or as Combwork derived it, when it is that conversation's in one of
 * Combwork's profiles, really there (realSame): its real path, else null.
 */
export async function trustedTranscript(path: string, root: string, id?: string): Promise<string | null> {
  if (!profileTranscript(path, root, id)) return null
  const real = await realSame(path, root)
  if (!real) return null
  try {
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/** The profiles under `root` (each agent's folder). */
async function profiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name))
  } catch {
    return []
  }
}

/** A conversation's transcript in a profile under `root`, checked (trustedTranscript), or null. */
export const transcriptIn = (root: string, profile: string, id: string): Promise<string | null> => (isConversationId(id) ? trustedTranscript(join(logsDir(profile, id), TRANSCRIPT_FILE), root, id) : Promise.resolve(null))

/** The profile under `root` holding conversation `id` with its transcript, and that transcript; or null. */
export async function profileOf(root: string, id: string): Promise<{ profile: string; transcript: string } | null> {
  if (!isConversationId(id)) return null
  for (const profile of await profiles(root)) {
    const transcript = await transcriptIn(root, profile, id)
    if (transcript) return { profile, transcript }
  }
  return null
}

/** The most an annotations file is read (a title is a line). */
const ANNOTATION_MAX = 64 * 1024

/** Conversations' titles as last read (agy's own, made from the first prompt), for a usage asked for without waiting. */
const titles = new Map<string, string | null>()

/** A conversation's title as last read (learnTitle), or undefined when it hasn't been. */
export const knownTitle = (id: string): string | null | undefined => titles.get(id.toLowerCase())

/** Reads a conversation's title from its profile's annotations (checked by its real path, at most ANNOTATION_MAX) and keeps it. */
export async function learnTitle(root: string, profile: string, id: string): Promise<string | null> {
  const file = join(dirname(brainDir(profile)), 'annotations', `${id}.pbtxt`)
  let title: string | null = null
  const real = await realSame(file, root)
  if (real) title = annotationTitle((await readCapped(real, ANNOTATION_MAX))?.toString('utf8') ?? '')
  keepBounded(titles, id.toLowerCase(), title)
  return title
}

/** A file's bytes, at most `max`: null when it is larger (never read past `max`) or can't be read. */
async function readCapped(path: string, max: number): Promise<Buffer | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(max + 1)
      let at = 0
      for (;;) {
        const { bytesRead } = await fh.read(buf, at, buf.length - at, at)
        if (bytesRead === 0) break
        at += bytesRead
        if (at > max) return null
      }
      return buf.subarray(0, at)
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/** The folders the profile's last conversations ran in (cache\last_conversations.json: folder → conversation id). */
async function profileFolders(root: string, profile: string): Promise<string[]> {
  const real = await realSame(join(dirname(brainDir(profile)), 'cache', 'last_conversations.json'), root)
  if (!real) return []
  try {
    const j = JSON.parse((await readCapped(real, ANNOTATION_MAX))?.toString('utf8') ?? '')
    return j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : []
  } catch {
    return []
  }
}

/**
 * The conversations of the profiles that ran in `folder` (their last_conversations.json names it): each profile is one
 * agent's, so its conversations are that agent's, also those started inside a launch (agy's /new) that Combwork has no
 * record of, and its subagents' (`sub`). Those `skip` names (Combwork's own) aren't looked at. The user's own agy
 * conversations (~\.gemini) are never read: they aren't under `root`.
 */
export async function listConversations(root: string, folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]> {
  const want = key(folder)
  const out: ExternalSession[] = []
  for (const profile of await profiles(root)) {
    if (!(await profileFolders(root, profile)).some((f) => key(f) === want)) continue
    let ids: string[] = []
    try {
      ids = await readdir(brainDir(profile))
    } catch {
      continue
    }
    for (const id of ids) {
      if (!isConversationId(id) || skip?.(id)) continue
      const p = await transcriptIn(root, profile, id)
      const st = p ? await stat(p).catch(() => null) : null
      if (!p || !st || st.size === 0) continue
      await learnTitle(root, profile, id)
      const sub = await subOf(p, st.mtimeMs)
      out.push({ id, transcriptPath: p, modified: st.mtime.toISOString(), bytes: st.size, mtimeMs: st.mtimeMs, ...(sub ? { sub } : {}) })
    }
  }
  return out
}

/** Each transcript's answer, by path and time: its first step never changes once written. */
const subs = new Map<string, SubSession | null>()

/**
 * Whether a transcript is a subagent's (HI-2546, 1.5.0's runs): a subagent is a conversation of its own, whose first step
 * is its parent's task, a SYSTEM_MESSAGE from the parent's conversation (parentOf).
 */
export async function subOf(path: string, mtimeMs?: number): Promise<SubSession | null> {
  const k = `${path.toLowerCase()}|${mtimeMs ?? ''}`
  const known = subs.get(k)
  if (known !== undefined) return known
  const parent = parentOf(await readFirstLine(path).catch(() => ''))
  const sub: SubSession | null = parent ? { parentId: parent, kind: 'subagent' } : null
  keepBounded(subs, k, sub)
  return sub
}

/** The largest image Combwork shows from agy's media files: one larger is never read past this. */
export const MEDIA_MAX = 20 * 1024 * 1024

/**
 * An image a step of `transcript` names (its `media` entry: {mime_type, uri}) as a data URL, read from the file its uri
 * names: only a file in that same conversation's logs\media, in one of Combwork's profiles (under `root`), each checked by
 * its real path, and at most `max` bytes; never anywhere else agy's word, a link or another conversation points.
 */
export async function mediaData(entry: unknown, transcript: string, root: string, max = MEDIA_MAX): Promise<string | null> {
  const m = entry as { mime_type?: unknown; uri?: unknown } | null
  if (!m || typeof m.uri !== 'string' || typeof m.mime_type !== 'string' || !/^image\/[\w.+-]+$/.test(m.mime_type)) return null
  const own = await trustedTranscript(transcript, root)
  if (!own) return null
  let file: string
  try {
    file = resolve(m.uri.startsWith('file:') ? fileURLToPath(m.uri) : m.uri)
  } catch {
    return null
  }
  // In this transcript's own logs\media, as written: the same conversation, never another's.
  const parts = partsUnder(file, root)
  if (!parts || conversationOf(parts, 2) === null || parts[7] !== 'media' || key(join(dirname(transcript), 'media', basename(file))) !== key(file)) return null
  const real = await realSame(file, root)
  if (!real) return null
  const bytes = await readCapped(real, max)
  return bytes ? `data:${m.mime_type};base64,${bytes.toString('base64')}` : null
}
