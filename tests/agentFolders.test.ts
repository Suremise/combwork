// The folder contract (#1434, SPEC §16.10.3; shared/agentFolders.ts and main/agentFolders.ts): where each kind of agent
// starts a new conversation and whether a conversation may resume where it was made, automatically (Resume All,
// startup: `canResumeNow`) or by the user's own Resume (`canResumeByUser`); a session bound to its lease and rebound only
// inside the lease change's own write (one transaction: an injected failure changes neither, two Hives at once: one
// wins and the other reads the result); old session rows read as before; Resume All never taking a free slot; the
// refusals' words.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotStore } from '../src/main/slots'
import { legacyWorktree, rebindSession, RebindRefused, takeByHand } from '../src/main/agentFolders'
import { readSessionRecords, writeSessionRecords } from '../src/main/schema/sessionDeliveryTables'
import { canResumeByUser, canResumeNow, currentFolder, defaultPurpose, launchFolder, resumeFolder, resumeHold, type FolderAgent, type FolderFacts, type FolderLease, type FolderSlot, type ResumeHold } from '../src/shared/agentFolders'
import { agentsToResume, resumeAll, type ResumeAllAgent } from '../src/shared/resumeAll'
import { holdShort, holdText, resumeBlock, type ResumeContext } from '../src/shared/sessionResume'
import { shownText } from '../src/shared/advanced'

const P = 'C:\\ws\\project'
const W = 'C:\\ws.worktrees\\project'
const slotFolder = (name: string): string => `${W}\\${name}`

const lease = (id: string, slot: string, agent: string, kind: FolderLease['kind'] = 'card', card: number | null = kind === 'card' ? 12 : null): FolderLease => ({ id, kind, slot, card, lane: kind === 'lane' ? 'lane-1' : null, agent })
const slot = (name: string, o: { open?: FolderLease | null; last?: FolderLease | null; state?: string } = {}): FolderSlot => ({
  name,
  folder: slotFolder(name),
  state: o.state ?? (o.open ? 'lent' : 'ready'),
  portBase: 41000,
  open: o.open ?? null,
  last: o.open ? { ...o.open, ended: false } : o.last ? { ...o.last, ended: true } : null
})
const facts = (slots: FolderSlot[], o: Partial<FolderFacts> = {}): FolderFacts => ({ projectPath: P, migrated: true, homes: [], slots, ...o })
const builder: FolderAgent = { id: 'b1', role: 'builder', legacy: null }
const reviewer: FolderAgent = { id: 'r1', role: 'reviewer', legacy: null }
const either: FolderAgent = { id: 'e1', role: 'either', legacy: null }

describe('where a new conversation starts, and where an agent works now', () => {
  it('a builder with a dispatch lease starts in its slot; with a carried lease only, in that one; with none, the project folder', () => {
    const f = facts([slot('slot-b', { open: lease('l1', 'slot-b', 'b1') }), slot('slot-c')])
    expect(launchFolder(f, builder, 'build')).toBe(slotFolder('slot-b'))
    expect(launchFolder(facts([slot('hb2', { open: lease('l2', 'hb2', 'b1', 'carried') })]), builder, 'build')).toBe(slotFolder('hb2'))
    expect(launchFolder(facts([slot('slot-c')]), builder, 'build')).toBe(P)
  })

  it('both leases (a dirty carried slot and a new card): a new conversation goes to the dispatch slot', () => {
    const f = facts([slot('hb2', { open: lease('lc', 'hb2', 'b1', 'carried'), state: 'dirty' }), slot('slot-a', { open: lease('ld', 'slot-a', 'b1') })])
    expect(launchFolder(f, builder, 'build')).toBe(slotFolder('slot-a'))
  })

  it('a reviewer starts in the project folder, and one resumed in its retired home works there until it starts afresh', () => {
    const home = 'C:\\ws.worktrees\\project\\hr1'
    const f = facts([], { homes: [home] })
    expect(launchFolder(f, reviewer, defaultPurpose('reviewer'))).toBe(P)
    expect(currentFolder(f, reviewer, { cwd: home })).toBe(home)
    expect(currentFolder(f, reviewer, null)).toBe(P)
    expect(resumeHold(f, reviewer, { cwd: home })).toBeNull()
  })

  it("an either agent builds in its dispatch slot, and reviews in the project folder once its lease has ended", () => {
    const building = facts([slot('slot-a', { open: lease('l1', 'slot-a', 'e1') })])
    expect(launchFolder(building, either, defaultPurpose('either'))).toBe(slotFolder('slot-a'))
    const after = facts([slot('slot-a', { last: lease('l1', 'slot-a', 'e1') })])
    expect(launchFolder(after, either, 'review')).toBe(P)
    expect(launchFolder(after, either, 'build')).toBe(P)
  })

  it('before the migration an agent with a 0.9 worktree keeps working there; after it, its worktree no longer counts', () => {
    const legacy: FolderAgent = { id: 'b1', role: 'builder', legacy: { path: 'C:\\ws.worktrees\\project\\hb1', branch: 'hive/hb1' } }
    expect(launchFolder(facts([], { migrated: false }), legacy, 'build')).toBe('C:\\ws.worktrees\\project\\hb1')
    expect(launchFolder(facts([], { migrated: false }), legacy, 'review')).toBe('C:\\ws.worktrees\\project\\hb1')
    expect(launchFolder(facts([]), legacy, 'build')).toBe(P)
    // A card's slot wins over it even before the migration.
    expect(launchFolder(facts([slot('slot-a', { open: lease('l1', 'slot-a', 'b1') })], { migrated: false }), legacy, 'build')).toBe(slotFolder('slot-a'))
    expect(legacyWorktree({ worktree: { path: 'C:\\x', branch: 'b', base: 'main' } })).toEqual({ path: 'C:\\x', branch: 'b', base: 'main' })
    expect(legacyWorktree({})).toBeNull()
  })

  it('a conversation resumes in the folder it recorded; an older row without one, in the project folder', () => {
    expect(resumeFolder(P, { cwd: slotFolder('slot-b') })).toBe(slotFolder('slot-b'))
    expect(resumeFolder(P, {})).toBe(P)
  })
})

describe('whether a conversation may resume now (automatic) or by the user', () => {
  const cases: { name: string; f: FolderFacts; agent: FolderAgent; s: { cwd?: string; lease?: string }; hold: ResumeHold | null }[] = [
    { name: 'its lease open: resumes now', f: facts([slot('slot-b', { open: lease('l1', 'slot-b', 'b1') })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: null },
    { name: 'the project folder: resumes now', f: facts([]), agent: builder, s: { cwd: P }, hold: null },
    { name: 'its slot lent to AM-14 since: refused', f: facts([slot('slot-b', { open: lease('l2', 'slot-b', 'b2', 'card', 14) })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'reused', slot: 'slot-b', card: 14, lane: null } },
    { name: 'its slot lent to a lane since, now free: refused', f: facts([slot('slot-b', { last: lease('l2', 'slot-b', 'b2', 'lane') })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'reused', slot: 'slot-b', card: null, lane: 'lane-1' } },
    { name: 'its own slot under a later lease: by hand (rebind)', f: facts([slot('slot-b', { open: lease('l3', 'slot-b', 'b1') })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'byHand', slot: 'slot-b', how: 'rebind', lease: 'l3' } },
    { name: 'an ended lease, its slot free and clean: by hand (take)', f: facts([slot('slot-b', { last: lease('l1', 'slot-b', 'b1') })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'byHand', slot: 'slot-b', how: 'take', lease: 'l1' } },
    { name: 'an ended lease, its slot dirty: refused', f: facts([slot('slot-b', { last: lease('l1', 'slot-b', 'b1'), state: 'dirty' })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'changed', slot: 'slot-b' } },
    { name: 'its slot gone: refused', f: facts([slot('slot-b', { open: lease('l1', 'slot-b', 'b1'), state: 'gone' })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'gone', slot: 'slot-b' } },
    { name: 'its agent a reviewer now: refused (reviewers never run in a slot)', f: facts([slot('slot-b', { last: lease('l1', 'slot-b', 'r1') })]), agent: reviewer, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'reviewer', slot: 'slot-b' } },
    {
      name: 'both leases: its carried slot waits for the card',
      f: facts([slot('hb2', { open: lease('lc', 'hb2', 'b1', 'carried') }), slot('slot-a', { open: lease('ld', 'slot-a', 'b1', 'card', 14) })]),
      agent: builder,
      s: { cwd: slotFolder('hb2'), lease: 'lc' },
      hold: { is: 'after', slot: 'slot-a', card: 14, lane: null }
    },
    { name: 'both leases, the card ended: its carried slot resumes now', f: facts([slot('hb2', { open: lease('lc', 'hb2', 'b1', 'carried') }), slot('slot-a', { last: lease('ld', 'slot-a', 'b1', 'card', 14) })]), agent: builder, s: { cwd: slotFolder('hb2'), lease: 'lc' }, hold: null },
    { name: 'a free slot while the agent keeps another: refused', f: facts([slot('hb2', { open: lease('lc', 'hb2', 'b1', 'carried') }), slot('slot-b', { last: lease('l1', 'slot-b', 'b1') })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'holds', slot: 'hb2' } }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(resumeHold(c.f, c.agent, c.s)).toEqual(c.hold)
      expect(canResumeNow(c.f, c.agent, c.s)).toBe(c.hold === null)
      expect(canResumeByUser(c.f, c.agent, c.s)).toBe(c.hold === null || c.hold.is === 'byHand')
    })
  }

  it('a free, clean slot at the session revision: the user may resume it, Resume All and startup may not', () => {
    const f = facts([slot('slot-b', { last: lease('l1', 'slot-b', 'b1') })])
    expect(canResumeByUser(f, builder, { cwd: slotFolder('slot-b'), lease: 'l1' })).toBe(true)
    expect(canResumeNow(f, builder, { cwd: slotFolder('slot-b'), lease: 'l1' })).toBe(false)
  })

  it('after a restart with both leases open, the same answers (the contract reads only what hive.db keeps)', () => {
    const before = facts([slot('hb2', { open: lease('lc', 'hb2', 'b1', 'carried') }), slot('slot-a', { open: lease('ld', 'slot-a', 'b1') })])
    const after: FolderFacts = JSON.parse(JSON.stringify(before))
    for (const s of [{ cwd: slotFolder('hb2'), lease: 'lc' }, { cwd: slotFolder('slot-a'), lease: 'ld' }]) expect(resumeHold(after, builder, s)).toEqual(resumeHold(before, builder, s))
    expect(launchFolder(after, builder, 'build')).toBe(launchFolder(before, builder, 'build'))
  })
})

describe('Resume All and the Sessions tab with holds', () => {
  const held = (name: string, hold?: ResumeHold): ResumeAllAgent => ({ id: name, name, live: null, resume: { id: `s-${name}`, ...(hold ? { hold } : {}) } })

  it('Resume All resumes only conversations that may resume now, never taking a free slot, and lists the rest', async () => {
    const agents = [held('Now'), held('ByHand', { is: 'byHand', slot: 'slot-b', how: 'take', lease: 'l1' }), held('Reused', { is: 'reused', slot: 'slot-c', card: 14, lane: null })]
    expect(agentsToResume(agents).map((a) => a.name)).toEqual(['Now'])
    const started: string[] = []
    const r = await resumeAll(agents, async (a) => void started.push(a.name))
    expect(started).toEqual(['Now'])
    expect(r.held.map((h) => [h.name, h.hold.is])).toEqual([
      ['ByHand', 'byHand'],
      ['Reused', 'reused']
    ])
  })

  it('the words: each refusal, and the short ones Resume All lists', () => {
    expect(shownText(holdText({ is: 'after', slot: 'slot-a', card: 14, lane: null }, 'HB2'))).toBe('HB2 is on #14 in slot-a: resume this after #14.')
    expect(shownText(holdText({ is: 'reused', slot: 'slot-b', card: 14, lane: null }, 'HB2'))).toBe("This conversation's slot (slot-b) now holds #14's work. Read its transcript, or start fresh with a handover.")
    expect(shownText(holdText({ is: 'reused', slot: 'slot-b', card: null, lane: 'l' }, 'HB2'))).toBe("This conversation's slot (slot-b) now holds a lane's work. Read its transcript, or start fresh with a handover.")
    expect(shownText(holdShort({ is: 'byHand', slot: 'slot-b', how: 'take', lease: 'l1' }))).toBe('resume by hand')
    expect(shownText(holdShort({ is: 'reused', slot: 'slot-b', card: 14, lane: null }))).toBe('slot reused')
    expect(shownText(holdShort({ is: 'after', slot: 'slot-a', card: 14, lane: null }))).toBe('after #14')
  })

  it("the Sessions tab's Resume is blocked by a hold, except one the user's own Resume takes", () => {
    const ctx: ResumeContext = { live: false, providerEnabled: true, providerInstalled: true, runners: [{ id: 'b1', name: 'HB2' }], canAddAgent: false, projectPath: P }
    const s = { provider: 'claude-code' as const, hasTranscript: true, hasBackup: false, cwd: slotFolder('slot-b'), agentId: 'b1', agentName: 'HB2' }
    expect(resumeBlock({ ...s, hold: { is: 'reused', slot: 'slot-b', card: 14, lane: null } }, ctx)).toMatch(/now holds #14's work/)
    expect(resumeBlock({ ...s, hold: { is: 'byHand', slot: 'slot-b', how: 'take', lease: 'l1' } }, ctx)).toBeNull()
    expect(resumeBlock(s, ctx)).toBeNull()
    // A session recorded in the project folder (cwd always recorded since #1434) isn't a worktree's.
    expect(resumeBlock({ ...s, cwd: P }, { ...ctx, runners: [] })).toMatch(/No agent works in the project folder/)
  })
})

describe('sessions bound to leases in hive.db', () => {
  const opened: (() => void)[] = []
  afterEach(() => {
    for (const close of opened.splice(0)) close()
  })

  /** A workspace's hive.db with a project's slot-b lent to b1 for #12 (lease l1) and b1's session s1 in it, bound to l1. */
  function board(): { ws: string; file: string; store: SlotStore; db: DatabaseSync; other: () => SlotStore } {
    const ws = join(tempDir('agentfolders-'), 'ws')
    const dismiss = admitted(ws)
    workspaceDb(ws)
    const file = boardFile(ws)
    const conns: SlotStore[] = []
    const make = (): SlotStore => {
      const s = new SlotStore(fileSlotConn(file), 'p1')
      conns.push(s)
      return s
    }
    const store = make()
    const db = new DatabaseSync(file)
    const at = '2026-10-23T08:00:00.000Z'
    db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p1', 'slot-b', ?, 'lent', 41000, ?, ?)").run(slotFolder('slot-b'), at, at)
    db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l1', 'p1', 'slot-b', 'card', 12, 'b1', ?)").run(at)
    db.prepare("INSERT INTO sessions (host, id, ord, provider, name, agent_id, cwd, created_at, last_active_at, lease) VALUES ('p1', 's1', 0, 'claude-code', 'one', 'b1', ?, ?, ?, 'l1')").run(slotFolder('slot-b'), at, at)
    opened.push(() => {
      db.close()
      for (const s of conns) s.conn.close()
      closeBoard(ws)
      dismiss()
    })
    return { ws, file, store, db, other: make }
  }
  const leaseOf = (db: DatabaseSync, id = 's1'): string | null => (db.prepare("SELECT lease FROM sessions WHERE host = 'p1' AND id = ?").get(id) as { lease: string | null }).lease

  it("rebinds in the lease change's own write: only the lease changes, never the folder or the conversation's id", async () => {
    const b = board()
    await b.store.end('l1', 'done', 'abc123')
    expect(b.store.lease('l1')).toMatchObject({ to: expect.any(String), endRev: 'abc123' })
    const taken = await b.store.carry('b1', { name: 'slot-b', folder: slotFolder('slot-b'), target: null }, (db, l) => {
      rebindSession(db, 'p1', 'p1', 's1', l.id)
      return true
    })
    expect(taken).not.toBeNull()
    const row = b.db.prepare("SELECT id, provider, cwd, lease FROM sessions WHERE host = 'p1' AND id = 's1'").get() as Record<string, string>
    expect(row).toEqual({ id: 's1', provider: 'claude-code', cwd: slotFolder('slot-b'), lease: taken!.id })
  })

  it('refuses another folder, another agent, or an ended lease', async () => {
    const b = board()
    await b.store.end('l1', 'done')
    const at = '2026-10-23T09:00:00.000Z'
    b.db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p1', 'slot-c', ?, 'lent', 41010, ?, ?)").run(slotFolder('slot-c'), at, at)
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l2', 'p1', 'slot-c', 'card', 13, 'b1', ?)").run(at)
    b.db.prepare("INSERT INTO sessions (host, id, ord, provider, name, agent_id, cwd, created_at, last_active_at) VALUES ('p1', 's2', 1, 'claude-code', 'two', 'b2', ?, ?, ?)").run(slotFolder('slot-b'), at, at)
    const tryRebind = (session: string, to: string): Promise<unknown> => b.store.conn.write((db) => rebindSession(db, 'p1', 'p1', session, to))
    await expect(tryRebind('s1', 'l2')).rejects.toThrow(/another folder/)
    await expect(tryRebind('s2', 'l2')).rejects.toThrow(/another agent's/)
    await expect(tryRebind('s1', 'l1')).rejects.toBeInstanceOf(RebindRefused)
    expect(leaseOf(b.db)).toBe('l1')
  })

  it('a failure inside the write changes neither: no new lease, the session still bound to its old one', async () => {
    const b = board()
    await b.store.end('l1', 'done', 'abc123')
    await expect(
      b.store.conn.write((db) => {
        db.prepare("INSERT INTO slot_leases (id, project, slot, kind, agent, from_at) VALUES ('l9', 'p1', 'slot-b', 'carried', 'b1', 't')").run()
        rebindSession(db, 'p1', 'p1', 's1', 'l9')
        throw new Error('injected')
      })
    ).rejects.toThrow('injected')
    expect(b.store.lease('l9')).toBeNull()
    expect(leaseOf(b.db)).toBe('l1')
    // carry's own check refusing: nothing written either.
    expect(await b.store.carry('b1', { name: 'slot-b', folder: slotFolder('slot-b'), target: null }, () => false)).toBeNull()
    expect(b.store.openLease('slot-b')).toBeNull()
    expect(leaseOf(b.db)).toBe('l1')
  })

  it("the user's Resume taking a free slot: only at the head its lease ended at, and two Hives at once: one wins, the other reads it", async () => {
    const b = board()
    await b.store.end('l1', 'done', 'abc123')
    b.db.prepare("UPDATE slots SET state = 'ready' WHERE project = 'p1' AND name = 'slot-b'").run()
    const hold = { is: 'byHand' as const, slot: 'slot-b', how: 'take' as const, lease: 'l1' }
    expect(await takeByHand(b.store, 'p1', 'b1', 's1', slotFolder('slot-b'), hold, 'other')).toBeNull()
    expect(b.store.openLease('slot-b')).toBeNull()
    const [x, y] = await Promise.all([takeByHand(b.store, 'p1', 'b1', 's1', slotFolder('slot-b'), hold, 'abc123'), takeByHand(b.other(), 'p1', 'b1', 's1', slotFolder('slot-b'), hold, 'abc123')])
    const won = [x, y].filter(Boolean)
    expect(won).toHaveLength(1)
    expect(b.store.openLease('slot-b')).toMatchObject({ id: won[0], agent: 'b1', kind: 'carried' })
    expect(leaseOf(b.db)).toBe(won[0])
  })

  it("a record's save leaves its lease as it is, and older rows (no lease) read as before", async () => {
    const b = board()
    const w = workspaceDb(b.ws).writer
    const recs = readSessionRecords(w, 'p1')
    expect(recs[0]).toMatchObject({ id: 's1', cwd: slotFolder('slot-b'), lease: 'l1' })
    writeSessionRecords(w, 'p1', { sessions: [{ ...recs[0], name: 'renamed', lease: 'ignored' }] })
    expect(leaseOf(b.db)).toBe('l1')
    expect(readSessionRecords(w, 'p1')[0]).toMatchObject({ name: 'renamed', lease: 'l1' })
    b.db.prepare("INSERT INTO sessions (host, id, ord, provider, name, created_at, last_active_at) VALUES ('p1', 'old', 1, 'claude-code', 'old', 't', 't')").run()
    const old = readSessionRecords(w, 'p1').find((r) => r.id === 'old')!
    expect(old).not.toHaveProperty('lease')
    expect(old).not.toHaveProperty('cwd')
    expect(resumeFolder(P, old as { cwd?: string })).toBe(P)
  })
})
