// Project Settings → Storage: which files Clean Up… and Purge… remove, and how sizes read.
import { describe, expect, it } from 'vitest'
import { planCleanup, planPurge, type CleanupFacts, type CleanupSession, type PurgeFacts, type PurgeSession } from '../src/shared/storage'
import { formatSize } from '../src/shared/units'
import type { CleanupOptions } from '../src/shared/types'

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-02T12:00:00Z')
const ago = (days: number): string => new Date(now - days * DAY).toISOString()
const session = (id: string, patch: Partial<CleanupSession> = {}): CleanupSession => ({
  id,
  name: `Session ${id}`,
  archived: true,
  lastActiveAt: ago(200),
  running: false,
  inCli: true,
  backups: [{ path: `P/.combwork/archive/${id}.jsonl`, bytes: 1000 }],
  ...patch
})
const facts = (sessions: CleanupSession[], folders: string[] = [], live: string[] = []): CleanupFacts => ({
  sessions,
  attachmentFolders: folders.map((name) => ({ name, path: `P/.combwork/attachments/${name}`, bytes: 500 })),
  liveNames: new Set(live),
  now
})
const NONE: CleanupOptions = { archivedAttachmentsDays: null, orphanAttachments: false, archivedBackupsDays: null, goneBackups: false }

describe('Clean Up', () => {
  it('removes attachments of archived sessions older than N days only', () => {
    const f = facts([session('old'), session('young', { lastActiveAt: ago(10) }), session('open', { archived: false }), session('busy', { running: true })], ['old', 'young', 'open', 'busy'])
    expect(planCleanup(f, { ...NONE, archivedAttachmentsDays: 90 }).map((i) => [i.kind, i.sessionId])).toEqual([['archived-attachments', 'old']])
    expect(planCleanup(f, { ...NONE, archivedAttachmentsDays: 5 }).map((i) => i.sessionId)).toEqual(['old', 'young'])
    expect(planCleanup(f, NONE)).toEqual([])
  })

  it("removes attachments of deleted sessions and of launches that never got an id, never a running one's", () => {
    const f = facts([session('kept')], ['kept', 'deleted-1', 'run-abc', 'run-live', 'live-id'], ['run-live', 'live-id'])
    const items = planCleanup(f, { ...NONE, orphanAttachments: true })
    expect(items.map((i) => i.path)).toEqual(['P/.combwork/attachments/deleted-1', 'P/.combwork/attachments/run-abc'])
    expect(items.every((i) => i.kind === 'orphan-attachments')).toBe(true)
  })

  it("keeps old backups apart from last copies: N days only takes backups the CLI still has", () => {
    const f = facts([session('cli'), session('gone', { inCli: false }), session('recent', { lastActiveAt: ago(3) }), session('open', { archived: false }), session('busy', { running: true, inCli: false })])
    expect(planCleanup(f, { ...NONE, archivedBackupsDays: 90 }).map((i) => [i.kind, i.sessionId])).toEqual([['archived-backup', 'cli']])
    expect(planCleanup(f, { ...NONE, goneBackups: true }).map((i) => [i.kind, i.sessionId])).toEqual([['gone-backup', 'gone']])
  })

  it('lists every copy of a session (an active backup next to the archived one)', () => {
    const two = session('two', { backups: [{ path: 'P/.combwork/sessions/two.jsonl', bytes: 10 }, { path: 'P/.combwork/archive/two.jsonl', bytes: 20 }] })
    const items = planCleanup(facts([two]), { ...NONE, archivedBackupsDays: 1 })
    expect(items.map((i) => i.bytes)).toEqual([10, 20])
    expect(planCleanup(facts([session('none', { backups: [] })]), { ...NONE, archivedBackupsDays: 1, goneBackups: true })).toEqual([])
  })
})

describe('formatSize', () => {
  it('reads KB, MB and GB', () => {
    expect(formatSize(0)).toBe('0 KB')
    expect(formatSize(300)).toBe('1 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatSize(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })
})

const purgeSession = (id: string, patch: Partial<PurgeSession> = {}): PurgeSession => ({ id, name: `Session ${id}`, running: false, inCli: true, keptUsageBytes: null, ...patch })
const file = (id: string, name = `${id}.jsonl`, backup = true) => ({ path: `P/.combwork/sessions/${name}`, bytes: 100, mtimeMs: 1, id, folder: 'sessions' as const, backup })
const folder = (name: string, files = ['x.png']) => ({ name, path: `P/.combwork/attachments/${name}`, files: files.map((f) => ({ path: `P/.combwork/attachments/${name}/${f}`, bytes: 5, mtimeMs: 1 })) })
const purgeFacts = (patch: Partial<PurgeFacts>): PurgeFacts => ({ host: 'P', hostName: 'p', sessions: [], files: [], attachmentFolders: [], deletedUsage: [], liveNames: new Set(), ...patch })

describe('Purge', () => {
  it("lists each session's backups, leftovers, attachments and kept usage; a backup the CLI no longer has is a last copy", () => {
    const f = purgeFacts({
      sessions: [purgeSession('a'), purgeSession('b', { inCli: false, keptUsageBytes: 40 })],
      files: [file('a'), file('b', 'b.jsonl.gz'), file('b', 'b.jsonl.gz.spare', false)],
      attachmentFolders: [folder('a')]
    })
    expect(planPurge(f).items.map((i) => [i.kind, i.sessionId, !!i.lastCopy])).toEqual([
      ['backup', 'a', false],
      ['backup', 'b', true],
      ['leftover-backup', 'b', false],
      ['attachments', 'a', false],
      ['kept-usage', 'b', false]
    ])
  })

  it('leaves running sessions out and counts them; launches running are left out too', () => {
    const f = purgeFacts({ sessions: [purgeSession('a', { running: true, keptUsageBytes: 1 }), purgeSession('b')], files: [file('a'), file('b')], attachmentFolders: [folder('run-1')], liveNames: new Set(['run-1']) })
    const r = planPurge(f)
    expect([r.items.map((i) => i.sessionId), r.running]).toEqual([['b'], 2])
  })

  it("lists what is left of sessions Hive no longer has, and old usage of deleted ones", () => {
    const f = purgeFacts({ files: [file('gone')], attachmentFolders: [folder('gone'), folder('run-9')], deletedUsage: [{ id: 'd', name: 'Old', bytes: 9 }] })
    expect(planPurge(f).items.map((i) => i.kind)).toEqual(['leftover-backup', 'orphan-attachments', 'orphan-attachments', 'deleted-usage'])
  })

  it("a session's own purge lists only that session (no leftovers of others, no deleted sessions' usage)", () => {
    const f = purgeFacts({ sessions: [purgeSession('a', { keptUsageBytes: 2 }), purgeSession('b')], files: [file('a'), file('b'), file('gone')], attachmentFolders: [folder('B')], deletedUsage: [{ id: 'd', name: '', bytes: 1 }] })
    expect(planPurge(f, 'A').items.map((i) => [i.kind, i.sessionId])).toEqual([['backup', 'a'], ['kept-usage', 'a']])
  })

  it('lists each attachment, and keeps a leftover that may be the only copy of a session the CLI lost', () => {
    const f = purgeFacts({ sessions: [purgeSession('a', { inCli: false }), purgeSession('b', { inCli: false })], files: [file('a', 'a.jsonl.gz.spare', false), file('b'), file('b', 'b.jsonl.spare', false)], attachmentFolders: [folder('a', ['1.png', '2.png'])] })
    const r = planPurge(f)
    expect([r.recoverable, r.items.map((i) => [i.kind, i.sessionId])]).toEqual([1, [['backup', 'b'], ['leftover-backup', 'b'], ['attachments', 'a'], ['attachments', 'a']]])
  })

  it('keys tell the kind apart: a folder that changed kind no longer matches the preview', () => {
    const orphan = planPurge(purgeFacts({ attachmentFolders: [folder('x')] })).items[0]
    const owned = planPurge(purgeFacts({ sessions: [purgeSession('x')], attachmentFolders: [folder('x')] })).items[0]
    expect(orphan.key).not.toBe(owned.key)
  })
})
