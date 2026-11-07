import { dirname, join, resolve } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'original-fs'
import { readdir, readFile, stat } from 'original-fs/promises'
import { fileURLToPath } from 'url'
import type { SubSession } from '../../../shared/types'
import type { ExternalSession } from '../types'
import { keepBounded, readFirstLine } from '../common'
import { brainDir } from './home'
import { annotationTitle, parentOf } from './transcript'

// Where agy keeps an agent's conversations in its profile (HI-2546, read from 1.5.0's): brain\<id>\.system_generated\logs
// holds transcript_full.jsonl (what its hooks name) and transcript.jsonl (each argument encoded again); annotations\<id>.pbtxt
// the conversation's title; cache\last_conversations.json the folder each last conversation ran in. Its conversation
// itself is in conversations\<id>.db, which a resume reads: a transcript put back from a backup doesn't bring it back.

/** A conversation id as agy makes them (a UUID). */
export const isConversationId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** The transcript files agy writes for a conversation, the one Combwork reads first. */
export const TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl']

export const logsDir = (profile: string, id: string): string => join(brainDir(profile), id, '.system_generated', 'logs')

/** A conversation's transcript in a profile, the first of TRANSCRIPT_FILES there, or null. */
export function transcriptIn(profile: string, id: string): string | null {
  if (!isConversationId(id)) return null
  for (const f of TRANSCRIPT_FILES) {
    const p = join(logsDir(profile, id), f)
    if (existsSync(p)) return p
  }
  return null
}

const folderKey = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/**
 * Whether a path agy reported (its hooks' transcriptPath) is a conversation's transcript in one of Combwork's profiles
 * (under `root`, in brain\<id>\.system_generated\logs, one of TRANSCRIPT_FILES): agy's word alone never sends Combwork to
 * read another file. `id`, when given: that conversation's.
 */
export function profileTranscript(path: string, root: string, id?: string): boolean {
  const p = resolve(path)
  const r = folderKey(root)
  if (!p.toLowerCase().startsWith(r + '\\') && !p.toLowerCase().startsWith(r + '/')) return false
  const parts = p.slice(r.length + 1).split(/[\\/]/)
  // <profile key>\.gemini\antigravity-cli\brain\<id>\.system_generated\logs\<file>
  if (parts.length !== 8 || parts[1] !== '.gemini' || parts[2] !== 'antigravity-cli' || parts[3] !== 'brain' || parts[5] !== '.system_generated' || parts[6] !== 'logs') return false
  if (!isConversationId(parts[4]) || (id !== undefined && parts[4].toLowerCase() !== id.toLowerCase())) return false
  return TRANSCRIPT_FILES.includes(parts[7])
}

/** The profiles under `root` (each agent's folder). */
async function profiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(root, d.name))
  } catch {
    return []
  }
}

/** The profile under `root` holding conversation `id`, or null. */
export async function profileOf(root: string, id: string): Promise<string | null> {
  if (!isConversationId(id)) return null
  for (const p of await profiles(root)) if (transcriptIn(p, id)) return p
  return null
}

/** The same, without waiting (a usage's title, asked for synchronously): a few folders' names. */
export function profileOfNow(root: string, id: string): string | null {
  if (!isConversationId(id)) return null
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  for (const n of names) if (transcriptIn(join(root, n), id)) return join(root, n)
  return null
}

/** A conversation's title (agy's own, made from its first prompt), from the profile's annotations, or null. */
export function conversationTitle(profile: string, id: string): string | null {
  try {
    return annotationTitle(readFileSync(join(dirname(brainDir(profile)), 'annotations', `${id}.pbtxt`), 'utf8'))
  } catch {
    return null
  }
}

/** The folders the profile's last conversations ran in (cache\last_conversations.json: folder → conversation id). */
async function profileFolders(profile: string): Promise<string[]> {
  try {
    const j = JSON.parse(await readFile(join(dirname(brainDir(profile)), 'cache', 'last_conversations.json'), 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : []
  } catch {
    return []
  }
}

/**
 * The conversations of the profiles that ran in `folder` (their last_conversations.json names it): each profile is one
 * agent's, so its conversations are that agent's, also those started inside a launch (agy's /new) that Combwork has no
 * record of. Those `skip` names (Combwork's own) aren't looked at. The user's own agy conversations (~\.gemini) are never
 * read: they aren't under `root`.
 */
export async function listConversations(root: string, folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]> {
  const want = folderKey(folder)
  const out: ExternalSession[] = []
  for (const profile of await profiles(root)) {
    if (!(await profileFolders(profile)).some((f) => folderKey(f) === want)) continue
    let ids: string[] = []
    try {
      ids = await readdir(brainDir(profile))
    } catch {
      continue
    }
    for (const id of ids) {
      if (!isConversationId(id) || skip?.(id)) continue
      const p = transcriptIn(profile, id)
      const st = p ? await stat(p).catch(() => null) : null
      if (!p || !st || st.size === 0) continue
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
  const key = `${path.toLowerCase()}|${mtimeMs ?? ''}`
  const known = subs.get(key)
  if (known !== undefined) return known
  const parent = parentOf(await readFirstLine(path).catch(() => ''))
  const sub: SubSession | null = parent ? { parentId: parent, kind: 'subagent' } : null
  keepBounded(subs, key, sub)
  return sub
}

/** The largest image Combwork shows from agy's media files. */
const MEDIA_MAX = 20 * 1024 * 1024

/**
 * An image a step names (its `media` entry: {mime_type, uri}) as a data URL, read from the file its uri names: only a file
 * in a conversation's logs\media in one of Combwork's profiles (under `root`), never anywhere else agy's word points.
 */
export function mediaData(entry: unknown, root: string): string | null {
  const m = entry as { mime_type?: unknown; uri?: unknown } | null
  if (!m || typeof m.uri !== 'string' || typeof m.mime_type !== 'string' || !/^image\/[\w.+-]+$/.test(m.mime_type)) return null
  let file: string
  try {
    file = resolve(m.uri.startsWith('file:') ? fileURLToPath(m.uri) : m.uri)
  } catch {
    return null
  }
  const r = folderKey(root)
  if (!file.toLowerCase().startsWith(r + '\\') && !file.toLowerCase().startsWith(r + '/')) return null
  const parts = file.slice(r.length + 1).split(/[\\/]/)
  // <profile key>\.gemini\antigravity-cli\brain\<id>\.system_generated\logs\media\<file>
  if (parts.length !== 9 || parts[1] !== '.gemini' || parts[2] !== 'antigravity-cli' || parts[3] !== 'brain' || !isConversationId(parts[4]) || parts[5] !== '.system_generated' || parts[6] !== 'logs' || parts[7] !== 'media') return null
  try {
    if (statSync(file).size > MEDIA_MAX) return null
    return `data:${m.mime_type};base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
