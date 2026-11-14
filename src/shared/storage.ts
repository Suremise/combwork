// What Combwork keeps per project (Project Settings → Storage), which of it Clean Up… may remove, and what Purge… removes.
import type { CleanupItem, CleanupOptions, PurgeItem } from './types'
import { tr } from './i18n'
import { msg } from './i18n/msg'
import { isSessionFolder } from './attachments'

const M = {
  neverStarted: msg({ id: 'workspace.storage.neverStarted', defaultMessage: 'A launch that never got a session', description: "Storage, a folder of attachments to clean up: pasted into a launch that never became a session." }),
  removedAgent: msg({ id: 'workspace.storage.removedAgent', defaultMessage: 'Removed agent {id}', description: 'Storage, a launch folder to clean up (HI-3144): its agent was removed. {id} is the agent’s id (a-1234abcd).' }),
  deletedSession: msg({ id: 'workspace.storage.deletedSession', defaultMessage: 'Deleted session {id}', description: 'Storage, a folder of attachments to clean up: its session was deleted. {id} is the start of its id (8 characters).' })
}

const DAY = 24 * 60 * 60 * 1000

export const DEFAULT_CLEANUP: CleanupOptions = { archivedAttachmentsDays: 90, orphanAttachments: false, archivedBackupsDays: null, goneBackups: false, launchFolders: true }

/** One of a project's sessions, as Clean Up sees it. */
export interface CleanupSession {
  id: string
  name: string
  archived: boolean
  lastActiveAt: string
  /** Running now (never touched). */
  running: boolean
  /** The CLI (Claude Code, Codex) still has its transcript. */
  inCli: boolean
  /** Combwork's backups of it (active and archived copies) and their sizes. */
  backups: { path: string; bytes: number }[]
}

export interface CleanupFacts {
  sessions: CleanupSession[]
  /** The folders in .combwork/attachments: a session id, or run-<launch> for a launch that had no id yet. */
  attachmentFolders: { name: string; path: string; bytes: number }[]
  /** Session ids and run-<launch> names of what is running now. */
  liveNames: Set<string>
  now: number
  /** Launch folders of agents no longer the project's, none starting or running (HI-3144, launchFolders.ts). */
  launchFolders?: { agentId: string; path: string; bytes: number }[]
}

/**
 * What Clean Up removes with these options: attachments of archived sessions last active more than N days ago, attachments of
 * sessions Combwork no longer has (deleted, or launches that never got an id), Combwork's backups of archived sessions older
 * than N days that the CLI still has, and the backups of archived sessions the CLI no longer has (which deletes them).
 * Running and non-archived sessions are never in it.
 */
export function planCleanup(facts: CleanupFacts, opts: CleanupOptions): CleanupItem[] {
  const items: CleanupItem[] = []
  const old = (s: CleanupSession, days: number): boolean => facts.now - Date.parse(s.lastActiveAt) > days * DAY
  const byId = new Map(facts.sessions.map((s) => [s.id.toLowerCase(), s]))
  const label = (s: CleanupSession): string => s.name || s.id.slice(0, 8)
  for (const f of facts.attachmentFolders) {
    // Cards' attachments (HI-1700) are never a session's to clean up, whatever the facts say.
    if (!isSessionFolder(f.name) || facts.liveNames.has(f.name.toLowerCase())) continue
    const s = byId.get(f.name.toLowerCase())
    if (s) {
      if (!s.running && s.archived && opts.archivedAttachmentsDays !== null && old(s, opts.archivedAttachmentsDays)) items.push({ kind: 'archived-attachments', path: f.path, bytes: f.bytes, sessionId: s.id, label: label(s) })
    } else if (opts.orphanAttachments) items.push({ kind: 'orphan-attachments', path: f.path, bytes: f.bytes, label: /^run-/i.test(f.name) ? tr(M.neverStarted) : tr(M.deletedSession, { id: f.name.slice(0, 8) }) })
  }
  for (const s of facts.sessions) {
    if (s.running || !s.archived || !s.backups.length) continue
    if (s.inCli) {
      if (opts.archivedBackupsDays !== null && old(s, opts.archivedBackupsDays)) for (const b of s.backups) items.push({ kind: 'archived-backup', path: b.path, bytes: b.bytes, sessionId: s.id, label: label(s) })
    } else if (opts.goneBackups) for (const b of s.backups) items.push({ kind: 'gone-backup', path: b.path, bytes: b.bytes, sessionId: s.id, label: label(s) })
  }
  if (opts.launchFolders) for (const f of facts.launchFolders ?? []) items.push({ kind: 'launch-folder', path: f.path, bytes: f.bytes, label: tr(M.removedAgent, { id: f.agentId }) })
  return items
}

/** One of a host's sessions, as Purge… sees it (#1138). */
export interface PurgeSession {
  id: string
  name: string
  /** Running or starting now (never touched). */
  running: boolean
  /** The CLI still has its transcript: Combwork's files aren't its last copy. */
  inCli: boolean
  /** The size of old usage kept on its record (keptUsage, from before the usage history), or null: none. */
  keptUsageBytes: number | null
}

/** A file as the preview saw it: what apply checks it against. */
export interface PurgeFile {
  path: string
  bytes: number
  mtimeMs: number
}

export interface PurgeFacts {
  host: string
  hostName: string
  assistant?: boolean
  sessions: PurgeSession[]
  /**
   * The files of .combwork/sessions and .combwork/archive (`folder`) named for a session: its backups (`backup`: an active or
   * archived copy, compressed or not) and what is left of one (a spare, a half-made or set-aside copy). Nothing else
   * there is Combwork's per session.
   */
  files: (PurgeFile & { id: string; folder: 'sessions' | 'archive'; backup: boolean })[]
  /** The folders in .combwork/attachments (a session id, or run-<launch> for a launch that had no id yet) and their plain files. */
  attachmentFolders: { name: string; path: string; files: PurgeFile[] }[]
  /** Old usage kept for deleted sessions (deletedUsage, from before the usage history), with its size. */
  deletedUsage: { id: string; name: string; bytes: number }[]
  /** Session ids and run-<launch> names of what is running or starting now. */
  liveNames: Set<string>
}

/**
 * An item's key: its kind and its file's path, or the record's host and session id. With the kind in it, a thing that
 * changed kind since the preview (a deleted session's folder that belongs to a session again) no longer matches it.
 */
export const purgeKey = (kind: PurgeItem['kind'], where: string, id?: string): string => `${kind}:${where.toLowerCase()}${id ? `|${id.toLowerCase()}` : ''}`

/**
 * What Purge… removes of a host (#1138): everything Combwork keeps per session — each session's backups, leftovers of them,
 * each of its attachments, and old usage on its record — and what is left of sessions Combwork no longer has (their files,
 * attachments and kept usage). With `only`, that session's alone. Running sessions are left out, and counted. A leftover
 * of a session that may be its only copy (Combwork stopped while it deleted or moved it: the CLI has no transcript and no
 * backup of it is in that folder) is kept, and counted as `recoverable`. The usage history and the CLIs' own files are
 * never in it.
 */
export function planPurge(facts: PurgeFacts, only?: string): { items: PurgeItem[]; running: number; recoverable: number } {
  const items: PurgeItem[] = []
  const at = { host: facts.host, hostName: facts.hostName, ...(facts.assistant ? { assistant: true } : {}) }
  const want = (id: string): boolean => only === undefined || id.toLowerCase() === only.toLowerCase()
  const byId = new Map(facts.sessions.map((s) => [s.id.toLowerCase(), s]))
  const live = (id: string): boolean => facts.liveNames.has(id.toLowerCase()) || !!byId.get(id.toLowerCase())?.running
  const label = (s: PurgeSession): string => s.name || s.id.slice(0, 8)
  const gone = (name: string): string => (/^run-/i.test(name) ? tr(M.neverStarted) : tr(M.deletedSession, { id: name.slice(0, 8) }))
  const file = (f: PurgeFile) => ({ path: f.path, bytes: f.bytes, mtimeMs: f.mtimeMs })
  const backedUp = new Set(facts.files.filter((f) => f.backup).map((f) => `${f.folder}|${f.id.toLowerCase()}`))
  const running = new Set<string>()
  let recoverable = 0
  for (const f of facts.files) {
    if (!want(f.id)) continue
    if (live(f.id)) {
      running.add(f.id.toLowerCase())
      continue
    }
    const s = byId.get(f.id.toLowerCase())
    if (s && f.backup) items.push({ kind: 'backup', key: purgeKey('backup', f.path), ...at, ...file(f), sessionId: s.id, label: label(s), ...(s.inCli ? {} : { lastCopy: true }) })
    else if (s && !s.inCli && !backedUp.has(`${f.folder}|${f.id.toLowerCase()}`)) recoverable++
    else items.push({ kind: 'leftover-backup', key: purgeKey('leftover-backup', f.path), ...at, ...file(f), sessionId: s?.id ?? f.id, label: s ? label(s) : gone(f.id) })
  }
  for (const d of facts.attachmentFolders) {
    if (!isSessionFolder(d.name) || !want(d.name)) continue
    if (live(d.name)) {
      if (d.files.length) running.add(d.name.toLowerCase())
      continue
    }
    const s = byId.get(d.name.toLowerCase())
    for (const f of d.files) items.push(s ? { kind: 'attachments', key: purgeKey('attachments', f.path), ...at, ...file(f), sessionId: s.id, label: label(s) } : { kind: 'orphan-attachments', key: purgeKey('orphan-attachments', f.path), ...at, ...file(f), sessionId: d.name, label: gone(d.name) })
  }
  for (const s of facts.sessions) {
    if (!want(s.id) || s.keptUsageBytes === null) continue
    if (live(s.id)) running.add(s.id.toLowerCase())
    else items.push({ kind: 'kept-usage', key: purgeKey('kept-usage', facts.host, s.id), ...at, bytes: s.keptUsageBytes, sessionId: s.id, label: label(s) })
  }
  for (const k of facts.deletedUsage) {
    if (only !== undefined || byId.has(k.id.toLowerCase())) continue
    items.push({ kind: 'deleted-usage', key: purgeKey('deleted-usage', facts.host, k.id), ...at, bytes: k.bytes, sessionId: k.id, label: k.name || tr(M.deletedSession, { id: k.id.slice(0, 8) }) })
  }
  return { items, running: running.size, recoverable }
}
