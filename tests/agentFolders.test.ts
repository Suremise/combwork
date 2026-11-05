// The folder contract (#1434, SPEC §16.10.3; shared/agentFolders.ts and main/agentFolders.ts): where each kind of agent
// starts a new conversation and whether a conversation may resume where it was made, automatically (Resume All,
// startup: `canResumeNow`) or by the user's own Resume (`canResumeByUser`); a session bound to its lease and rebound only
// inside the lease change's own write (one transaction: an injected failure changes neither, two Combworks at once: one
// wins and the other reads the result); old session rows read as before; Resume All never taking a free slot; the
// refusals' words.
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { admitted } from './admitted'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotStore } from '../src/main/slots'
import { claimIn, ClaimRefused, leasedLine, legacyWorktree, rebindSession, RebindRefused, slotsIn } from '../src/main/agentFolders'
import { readSessionRecords, writeSessionRecords } from '../src/main/schema/sessionDeliveryTables'
import { agentPlaces, canResumeByUser, canResumeNow, currentFolder, defaultPurpose, launchFolder, namedFolders, resumeFolder, resumeHold, resumeHome, shownPlace, type FolderAgent, type FolderFacts, type FolderLease, type FolderSlot, type ResumeHold } from '../src/shared/agentFolders'
import { agentsToResume, resumeAll, type ResumeAllAgent } from '../src/shared/resumeAll'
import { holdShort, holdText, resumeBlock, type ResumeContext } from '../src/shared/sessionResume'
import { shownText } from '../src/shared/advanced'

const P = 'C:\\ws\\project'
const W = 'C:\\ws.worktrees\\project'
const slotFolder = (name: string): string => `${W}\\${name}`

const lease = (id: string, slot: string, agent: string, kind: FolderLease['kind'] = 'card', card: number | null = kind === 'card' ? 12 : null): FolderLease => ({ id, kind, slot, card, lane: kind === 'lane' ? 'lane-1' : null, agent })
const slot = (name: string, o: { open?: FolderLease | null; last?: FolderLease | null; state?: string; writer?: FolderSlot['writer'] } = {}): FolderSlot => ({
  name,
  folder: slotFolder(name),
  state: o.state ?? (o.open ? 'lent' : 'ready'),
  portBase: 41000,
  open: o.open ?? null,
  last: o.open ? { ...o.open, ended: false } : o.last ? { ...o.last, ended: true } : null,
  writer: o.writer ?? null
})
const facts = (slots: FolderSlot[], o: Partial<FolderFacts> = {}): FolderFacts => ({ projectPath: P, migrated: true, migratedAgents: [], homes: [], slots, ...o })
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

  it('until the migration takes it over an agent with a 0.9 worktree keeps working there; after, its worktree no longer counts', () => {
    const legacy: FolderAgent = { id: 'b1', role: 'builder', legacy: { path: 'C:\\ws.worktrees\\project\\hb1', branch: 'cw/hb1' } }
    expect(launchFolder(facts([], { migrated: false }), legacy, 'build')).toBe('C:\\ws.worktrees\\project\\hb1')
    expect(launchFolder(facts([], { migrated: false }), legacy, 'review')).toBe('C:\\ws.worktrees\\project\\hb1')
    expect(launchFolder(facts([], { migratedAgents: ['b1'] }), legacy, 'build')).toBe(P)
    // Its project migrated, but not this agent (its worktree missing then, or made since): still its worktree.
    expect(launchFolder(facts([], { migratedAgents: ['b2'] }), legacy, 'build')).toBe('C:\\ws.worktrees\\project\\hb1')
    // A card's slot wins over it even before the migration.
    expect(launchFolder(facts([slot('slot-a', { open: lease('l1', 'slot-a', 'b1') })], { migrated: false }), legacy, 'build')).toBe(slotFolder('slot-a'))
    expect(legacyWorktree({ worktree: { path: 'C:\\x', branch: 'b', base: 'main' } })).toEqual({ path: 'C:\\x', branch: 'b', base: 'main' })
    expect(legacyWorktree({})).toBeNull()
  })

  it('a conversation resumes in the folder it recorded; an older row without one, in the project folder', () => {
    expect(resumeFolder(P, { cwd: slotFolder('slot-b') })).toBe(slotFolder('slot-b'))
    expect(resumeFolder(P, {})).toBe(P)
  })

  it('names the retired home a conversation resumes in (#1552), by its folder whatever its case; none elsewhere', () => {
    const home = 'C:\\ws.worktrees\\project\\hr1'
    const f = facts([slot('slot-b')], { homes: [home] })
    expect(resumeHome(f, { cwd: home })).toBe('hr1')
    expect(resumeHome(f, { cwd: home.toUpperCase() })).toBe('HR1')
    expect(resumeHome(f, { cwd: slotFolder('slot-b') })).toBeNull()
    expect(resumeHome(f, { cwd: P })).toBeNull()
    expect(resumeHome(f, {})).toBeNull()
    expect(resumeHome(facts([]), { cwd: home })).toBeNull()
  })
})

describe('where an agent is, as the Agent API names it (#1451)', () => {
  it('an idle builder with a dispatch lease: in its slot (lease), now and next; its running session elsewhere: there (session)', () => {
    const f = facts([slot('slot-b', { open: lease('l1', 'slot-b', 'b1') })])
    expect(agentPlaces(f, builder, null)).toEqual({ now: { path: slotFolder('slot-b'), at: 'slot-b', why: 'lease', slot: 'slot-b' }, launch: { path: slotFolder('slot-b'), at: 'slot-b', why: 'lease', slot: 'slot-b' } })
    expect(agentPlaces(f, builder, { cwd: P }).now).toEqual({ path: P, at: 'project', why: 'session', slot: null })
  })

  it('a carried agent: its adopted slot (carried); a 0.9 worktree not migrated yet: there (carried), by its path', () => {
    expect(agentPlaces(facts([slot('hb2', { open: lease('l2', 'hb2', 'b1', 'carried') })]), builder, null).now).toEqual({ path: slotFolder('hb2'), at: 'hb2', why: 'carried', slot: 'hb2' })
    const old: FolderAgent = { ...builder, legacy: { path: slotFolder('b1'), branch: 'cw/b1' } }
    expect(agentPlaces(facts([], { migrated: false }), old, null).now).toEqual({ path: slotFolder('b1'), at: slotFolder('b1'), why: 'carried', slot: null })
  })

  it('a reviewer: the project folder next; resumed in its retired home, there now (home: <name>)', () => {
    const home = slotFolder('hr1')
    const f = facts([], { homes: [home] })
    const p = agentPlaces(f, reviewer, { cwd: home })
    expect([p.now, p.launch]).toEqual([
      { path: home, at: 'home: hr1', why: 'session', slot: null },
      { path: P, at: 'project', why: 'project', slot: null }
    ])
    // An either agent mid-build reviews in the project folder only when it starts afresh for that: its next conversation (a build) is its slot.
    expect(agentPlaces(facts([slot('slot-c', { open: lease('l3', 'slot-c', 'e1') })]), either, null).launch.at).toBe('slot-c')
  })
})

describe('where an agent is, as the window shows it (#1442)', () => {
  const shown = (f: FolderFacts, a: FolderAgent, running: { cwd: string } | null = null, branch: string | null = null) => shownPlace(f, a, agentPlaces(f, a, running).now, branch)

  it('a builder in a card\'s slot: "slot", by the slot\'s name, with its line; in its carried slot: "carried"', () => {
    const f = facts([slot('slot-b', { open: lease('l1', 'slot-b', 'b1') })])
    expect(shown(f, builder, null, 'cw/card-12')).toEqual({ folder: slotFolder('slot-b'), is: 'slot', name: 'slot-b', branch: 'cw/card-12' })
    expect(shown(facts([slot('hb2', { open: lease('l2', 'hb2', 'b1', 'carried') })]), builder)).toEqual({ folder: slotFolder('hb2'), is: 'carried', name: 'hb2', branch: null })
    // Running in a slot under another agent's carried lease (draining): a slot, not its carried one.
    expect(shown(facts([slot('hb3', { open: lease('l3', 'hb3', 'b9', 'carried') })]), builder, { cwd: slotFolder('hb3') }).is).toBe('slot')
  })

  it("a slot with a target: its base, what the Changes tab compares the slot's work with (#1569)", () => {
    const f = facts([{ ...slot('slot-b', { open: lease('l1', 'slot-b', 'b1') }), target: 'main' }])
    expect(shown(f, builder, null, 'cw/card-12')).toEqual({ folder: slotFolder('slot-b'), is: 'slot', name: 'slot-b', branch: 'cw/card-12', base: 'main' })
    // Its card's target, where the line merges, before the slot's (#1627: a lane's slot lent before targets were passed on).
    expect(shownPlace(f, builder, agentPlaces(f, builder, null).now, 'cw/card-12', '1.0.0').base).toBe('1.0.0')
  })

  it('a reviewer resumed in its retired home: "home", by the folder\'s name; in the project folder: nothing to name', () => {
    const home = slotFolder('hr4')
    const f = facts([], { homes: [home] })
    expect(shown(f, reviewer, { cwd: home })).toEqual({ folder: home, is: 'home', name: 'hr4', branch: null })
    expect(shown(f, reviewer)).toEqual({ folder: P, is: 'project', name: null, branch: null })
  })

  it('an agent on its 0.9 worktree, not migrated yet: "legacy", with its branch; once migrated, where the contract puts it', () => {
    const old: FolderAgent = { ...builder, legacy: { path: slotFolder('hb1'), branch: 'cw/hb1' } }
    expect(shown(facts([], { migrated: false }), old)).toEqual({ folder: slotFolder('hb1'), is: 'legacy', name: 'hb1', branch: 'cw/hb1' })
    expect(shown(facts([], { migratedAgents: ['b1'] }), old).is).toBe('project')
  })

  it("the project's slots and homes, named: what a session's folder is called", () => {
    expect(namedFolders(facts([slot('slot-a'), slot('hb2')], { homes: [slotFolder('hr4')] }))).toEqual([
      { path: slotFolder('slot-a'), name: 'slot-a', is: 'slot' },
      { path: slotFolder('hb2'), name: 'hb2', is: 'slot' },
      { path: slotFolder('hr4'), name: 'hr4', is: 'home' }
    ])
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
    { name: 'an ended lease, its own run still handing the slot back: draining', f: facts([slot('slot-b', { last: lease('l1', 'slot-b', 'b1'), state: 'lent', writer: { run: 'r1', agent: 'b1', lease: 'l1' } })]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'draining', slot: 'slot-b' } },
    { name: 'an ended lease, its slot not looked at yet, its revision not recorded: draining', f: facts([{ ...slot('slot-b', { last: lease('l1', 'slot-b', 'b1') }), last: { ...lease('l1', 'slot-b', 'b1'), ended: true, endRev: null } }]), agent: builder, s: { cwd: slotFolder('slot-b'), lease: 'l1' }, hold: { is: 'draining', slot: 'slot-b' } },
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

  it('after a restart with both leases open, the same answers (the contract reads only what combwork.db keeps)', () => {
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
    expect(shownText(holdShort({ is: 'byHand', slot: 'slot-b', how: 'take', lease: 'l1' }))).toBe('its slot is free. Resume it by hand to take it')
    expect(shownText(holdShort({ is: 'reused', slot: 'slot-b', card: 14, lane: null }))).toBe("its slot now holds #14's work")
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


describe("a slot's writer: claimed in one write with the resume authority, held until its run has exited (combwork.db)", () => {
  const opened: (() => void)[] = []
  afterEach(() => {
    for (const close of opened.splice(0)) close()
  })
  const at = '2026-10-23T08:00:00.000Z'
  const ME = { pid: process.pid, started: 1 }

  /**
   * A workspace's combwork.db with a project's slot-b lent to b1 for #12 (lease l1), slot-c free and ready, and b1's
   * session s1 in slot-b, bound to l1. `other()` is another Combwork's connection to the same file.
   */
  function board(): { store: SlotStore; db: DatabaseSync; other: () => SlotStore } {
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
    db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p1', 'slot-b', ?, 'lent', 41000, ?, ?)").run(slotFolder('slot-b'), at, at)
    db.prepare("INSERT INTO slots (project, name, folder, state, port_base, created_at, used_at) VALUES ('p1', 'slot-c', ?, 'ready', 41010, ?, ?)").run(slotFolder('slot-c'), at, at)
    db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l1', 'p1', 'slot-b', 'card', 12, 'b1', ?)").run(at)
    db.prepare("INSERT INTO sessions (host, id, ord, provider, name, agent_id, cwd, created_at, last_active_at, lease) VALUES ('p1', 's1', 0, 'claude-code', 'one', 'b1', ?, ?, ?, 'l1')").run(slotFolder('slot-b'), at, at)
    opened.push(() => {
      db.close()
      for (const s of conns) s.conn.close()
      closeBoard(ws)
      dismiss()
    })
    return { store, db, other: make }
  }
  const leaseOf = (db: DatabaseSync, id = 's1'): string | null => (db.prepare("SELECT lease FROM sessions WHERE host = 'p1' AND id = ?").get(id) as { lease: string | null }).lease
  const writerOf = (store: SlotStore, name = 'slot-b') => store.slot(name)?.writer ?? null

  it("an agent's watched line (#1451, branchWatch's): its dispatch lease's before its carried one, the card last started there, this project's only", () => {
    const { db } = board()
    // b1's card lease on slot-b, its card not started there yet: no line.
    expect(leasedLine(db, 'p1', 'b1')).toEqual({ folder: slotFolder('slot-b'), target: null, line: null, carried: false })
    db.prepare("INSERT INTO cards (number, title, description, project, col, ord, created_at, created_by, updated_at) VALUES (12, 'Fix', '', 'p1', 'doing', 1, ?, 'test', ?)").run(at, at)
    db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (12, 1, 'Started', ?, 'hive', 'recorded', ?)").run(at, JSON.stringify({ lease: 'l1', line: 'cw/P1/P1-12-fix' }))
    expect(leasedLine(db, 'p1', 'b1')?.line).toBe('cw/P1/P1-12-fix')
    // A carried lease too (its 0.9 worktree, adopted): the dispatch lease's still wins; another agent's carried one is its own.
    db.prepare("UPDATE slots SET target = 'main' WHERE name = 'slot-c'").run()
    db.prepare("INSERT INTO slot_leases (id, project, slot, kind, agent, from_at) VALUES ('l2', 'p1', 'slot-c', 'carried', 'b1', ?)").run(at)
    expect(leasedLine(db, 'p1', 'b1')).toMatchObject({ folder: slotFolder('slot-b'), carried: false })
    db.prepare("UPDATE slot_leases SET ended_at = ? WHERE id = 'l1'").run(at)
    expect(leasedLine(db, 'p1', 'b1')).toEqual({ folder: slotFolder('slot-c'), target: 'main', line: null, carried: true })
    // Another project's agent of the same id: none.
    expect(leasedLine(db, 'p2', 'b1')).toBeNull()
  })

  it("a line's target is its card's, as it started (#1627): a lane's slot keeps the target it was lent with", () => {
    const { db } = board()
    db.prepare("UPDATE slots SET target = 'main' WHERE name = 'slot-b'").run()
    db.prepare("INSERT INTO cards (number, title, description, project, col, ord, created_at, created_by, updated_at) VALUES (12, 'Fix', '', 'p1', 'doing', 1, ?, 'test', ?)").run(at, at)
    // Started before 1.0's facts named a target: the slot's.
    db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (12, 1, 'Started', ?, 'hive', 'recorded', ?)").run(at, JSON.stringify({ lease: 'l1', line: 'cw/P1/P1-12-fix' }))
    expect(leasedLine(db, 'p1', 'b1')).toMatchObject({ line: 'cw/P1/P1-12-fix', target: 'main' })
    db.prepare("INSERT INTO card_facts (card, seq, kind, at, actor, source, data) VALUES (12, 2, 'Started', ?, 'hive', 'recorded', ?)").run(new Date(Date.parse(at) + 1000).toISOString(), JSON.stringify({ lease: 'l1', line: 'cw/P1/P1-12-fix', target: '1.0.0' }))
    expect(leasedLine(db, 'p1', 'b1')).toMatchObject({ line: 'cw/P1/P1-12-fix', target: '1.0.0' })
  })
  /** A claim as claimPlace makes it, its facts read before the write (as `before` has them). */
  const claim = (store: SlotStore, o: { run: string; existing?: { id: string; cwd: string; lease?: string } | null; auto?: boolean; head?: string | null; folder?: string; agent?: FolderAgent }) =>
    store.conn.write((db) => claimIn(db, store, { facts: facts([]), folder: o.folder ?? slotFolder('slot-b'), agent: o.agent ?? builder, existing: o.existing === undefined ? null : o.existing, purpose: 'build', auto: o.auto ?? false, run: o.run, sessionsHost: 'p1', me: ME, head: o.head ?? null }))
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => (e instanceof ClaimRefused ? e.why : String(e))
    )
  const s1 = { id: 's1', cwd: slotFolder('slot-b'), lease: 'l1' }

  it("a new conversation claims its lease's slot for its run; nothing else may start, lend, adopt or remove it meanwhile", async () => {
    const b = board()
    expect(await claim(b.store, { run: 'run-1' })).toMatchObject({ lease: 'l1', slot: { name: 'slot-b', writer: { run: 'run-1', agent: 'b1', lease: 'l1' } } })
    expect(writerOf(b.store)).toMatchObject({ run: 'run-1', lease: 'l1', agent: 'b1', pid: process.pid })
    // Another run (another Combwork's, say) for the same lease: refused, the slot is written.
    expect(await refusal(claim(b.other(), { run: 'run-2' }))).toEqual({ is: 'busy', slot: 'slot-b', agent: 'b1' })
    // The lease ends while the run drains: the slot still isn't lent, adopted or removed.
    await b.store.end('l1', 'done')
    expect(await b.store.carry('b2', { name: 'slot-b', folder: slotFolder('slot-b'), target: null })).toBeNull()
    expect(await b.store.startRemoval('slot-b', 'lent', 'o-x', { pid: 1, started: 1 })).toBe(false)
    const taken = await b.store.take({ agent: 'b2', card: 14, slot: 'slot-b' }, { size: 4, root: W, target: null, token: 'o-y', holder: { pid: 1, started: 1 } })
    expect(taken.ok).toBe(false)
    // Its last revision isn't recorded while it drains; once its run has released it, it is.
    expect(await b.store.finalizeEndRev('l1', 'head-1')).toBe(false)
    expect(await b.store.clearWriter('slot-b', 'run-2')).toBe(false)
    expect(await b.store.clearWriter('slot-b', 'run-1')).toBe(true)
    expect(await b.store.finalizeEndRev('l1', 'head-2')).toBe(true)
    expect(b.store.lease('l1')?.endRev).toBe('head-2')
    expect(await b.store.finalizeEndRev('l1', 'head-3')).toBe(false)
  })

  it('a lease that changed before the write: the claim decides from combwork.db as it is then (two Combworks at once: one writer)', async () => {
    const b = board()
    // The lease ended between the facts read and the write: a new conversation has no slot of its own any more.
    await b.store.end('l1', 'done')
    expect(await refusal(claim(b.store, { run: 'run-1' }))).toEqual({ is: 'changed', slot: 'slot-b' })
    expect(writerOf(b.store)).toBeNull()
    // Lent again to b1 (#13): two starts of it at once (two Combworks), one writer.
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l2', 'p1', 'slot-b', 'card', 13, 'b1', '2026-10-23T09:00:00.000Z')").run()
    const two = await Promise.all([refusal(claim(b.store, { run: 'run-a' })), refusal(claim(b.other(), { run: 'run-b' }))])
    expect(two.filter((r) => r === null)).toHaveLength(1)
    expect(two.find((r) => r !== null)).toMatchObject({ is: 'busy', slot: 'slot-b' })
    expect(['run-a', 'run-b']).toContain(writerOf(b.store)?.run)
  })

  it("the user's Resume taking a free slot re-decides in its write: refused once the agent has a card elsewhere (stale hold), nothing written", async () => {
    const b = board()
    await b.store.end('l1', 'done')
    await b.store.finalizeEndRev('l1', 'abc123')
    b.db.prepare("UPDATE slots SET state = 'ready' WHERE project = 'p1' AND name = 'slot-b'").run()
    // Computed byHand before; then #15's dispatch lease opens for b1 in slot-c before the write.
    expect(resumeHold(facts([slot('slot-b', { last: lease('l1', 'slot-b', 'b1') })]), builder, s1)?.is).toBe('byHand')
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l15', 'p1', 'slot-c', 'card', 15, 'b1', '2026-10-23T09:00:00.000Z')").run()
    expect(await refusal(claim(b.store, { run: 'run-1', existing: s1, head: 'abc123' }))).toEqual({ is: 'hold', hold: { is: 'after', slot: 'slot-c', card: 15, lane: null } })
    expect(b.store.openLease('slot-b')).toBeNull()
    expect(leaseOf(b.db)).toBe('l1')
    expect(writerOf(b.store)).toBeNull()
  })

  it("…takes it at the head its lease ended at, under a new carried lease, rebinding and claiming it together; Resume All's (auto) never does", async () => {
    const b = board()
    await b.store.end('l1', 'done')
    await b.store.finalizeEndRev('l1', 'abc123')
    b.db.prepare("UPDATE slots SET state = 'ready' WHERE project = 'p1' AND name = 'slot-b'").run()
    expect(await refusal(claim(b.store, { run: 'run-1', existing: s1, head: 'abc123', auto: true }))).toMatchObject({ is: 'hold', hold: { is: 'byHand', how: 'take' } })
    expect(await refusal(claim(b.store, { run: 'run-1', existing: s1, head: 'other' }))).toEqual({ is: 'changed', slot: 'slot-b' })
    expect(await refusal(claim(b.store, { run: 'run-1', existing: s1, head: null }))).toEqual({ is: 'changed', slot: 'slot-b' })
    expect(b.store.openLease('slot-b')).toBeNull()
    const got = await claim(b.store, { run: 'run-1', existing: s1, head: 'abc123' })
    expect(b.store.openLease('slot-b')).toMatchObject({ id: got.lease, agent: 'b1', kind: 'carried' })
    expect(leaseOf(b.db)).toBe(got.lease)
    expect(writerOf(b.store)).toMatchObject({ run: 'run-1', lease: got.lease })
    // Its row: only the lease changed, never its folder or its conversation's id.
    expect(b.db.prepare("SELECT id, provider, cwd FROM sessions WHERE host = 'p1' AND id = 's1'").get()).toEqual({ id: 's1', provider: 'claude-code', cwd: slotFolder('slot-b') })
  })

  it("…its own slot under a later lease: rebound only while that is still so in the write (the card ending meanwhile refuses it)", async () => {
    const b = board()
    await b.store.end('l1', 'done')
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l2', 'p1', 'slot-b', 'card', 13, 'b1', '2026-10-23T09:00:00.000Z')").run()
    expect(resumeHold(facts([slot('slot-b', { open: lease('l2', 'slot-b', 'b1') })]), builder, s1)).toMatchObject({ is: 'byHand', how: 'rebind', lease: 'l2' })
    await b.store.end('l2', 'put back')
    expect(await refusal(claim(b.store, { run: 'run-1', existing: s1 }))).toMatchObject({ is: 'hold', hold: { is: 'reused' } })
    expect(leaseOf(b.db)).toBe('l1')
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l3', 'p1', 'slot-b', 'card', 16, 'b1', '2026-10-23T10:00:00.000Z')").run()
    expect(await claim(b.store, { run: 'run-1', existing: s1 })).toMatchObject({ lease: 'l3' })
    expect(leaseOf(b.db)).toBe('l3')
  })

  it("another agent's run still draining in a free slot: the slot holds its work, and a writer left by a Combwork that is gone is never taken over by a claim", async () => {
    const b = board()
    await claim(b.store, { run: 'run-1' })
    await b.store.end('l1', 'done')
    const s2 = { id: 's2', cwd: slotFolder('slot-b'), lease: 'l0' }
    const b2: FolderAgent = { id: 'b2', role: 'builder', legacy: null }
    expect(resumeHold({ ...facts([]), slots: b.store.conn.read((db) => slotsIn(db, 'p1')) }, b2, s2)).toMatchObject({ is: 'reused', card: 12 })
    // A lease of slot-b again (#13) while run-1's writer stays (its Combwork crashed, its processes not known to have ended).
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l2', 'p1', 'slot-b', 'card', 13, 'b1', '2026-10-23T09:00:00.000Z')").run()
    b.db.prepare("UPDATE slots SET writer_pid = 999999 WHERE project = 'p1' AND name = 'slot-b'").run()
    expect(await refusal(claim(b.store, { run: 'run-2' }))).toEqual({ is: 'busy', slot: 'slot-b', agent: 'b1' })
    expect(writerOf(b.store)).toMatchObject({ run: 'run-1' })
  })

  it('a slot being set up or installed (an operation, an unsettled job, or not ready) is never claimed; nothing is written', async () => {
    const b = board()
    const check = async (set: string, undo: string): Promise<void> => {
      b.db.prepare(`UPDATE slots SET ${set} WHERE project = 'p1' AND name = 'slot-b'`).run()
      expect(await refusal(claim(b.store, { run: 'run-1' }))).toEqual({ is: 'setup', slot: 'slot-b' })
      expect(writerOf(b.store)).toBeNull()
      b.db.prepare(`UPDATE slots SET ${undo} WHERE project = 'p1' AND name = 'slot-b'`).run()
    }
    await check("op = 'o-warm', op_kind = 'warm', op_lease = 'l1', op_pid = 1, op_started = 1", 'op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL')
    await check("job = 'setup-job'", 'job = NULL')
    await check("state = 'creating'", "state = 'lent'")
    await check("state = 'gone'", "state = 'lent'")
    // Set up, and lent: claimed.
    expect(await claim(b.store, { run: 'run-1' })).toMatchObject({ lease: 'l1', slot: { writer: { run: 'run-1' } } })
    // And the other way: no operation starts on it while it is written (FREE needs no writer).
    expect(await b.store.startRemoval('slot-b', 'lent', 'o-r', { pid: 1, started: 1 })).toBe(false)
  })

  it('binds and rebinds only within the rules, and a failure inside the write changes neither', async () => {
    const b = board()
    await b.store.end('l1', 'done')
    b.db.prepare("INSERT INTO slot_leases (id, project, slot, kind, card, agent, from_at) VALUES ('l2', 'p1', 'slot-c', 'card', 13, 'b1', ?)").run(at)
    b.db.prepare("INSERT INTO sessions (host, id, ord, provider, name, agent_id, cwd, created_at, last_active_at) VALUES ('p1', 's2', 1, 'claude-code', 'two', 'b2', ?, ?, ?)").run(slotFolder('slot-b'), at, at)
    const tryRebind = (session: string, to: string): Promise<unknown> => b.store.conn.write((db) => rebindSession(db, 'p1', 'p1', session, to))
    await expect(tryRebind('s1', 'l2')).rejects.toThrow(/another folder/)
    await expect(tryRebind('s2', 'l2')).rejects.toThrow(/another agent's/)
    await expect(tryRebind('s1', 'l1')).rejects.toBeInstanceOf(RebindRefused)
    await expect(
      b.store.conn.write((db) => {
        db.prepare("INSERT INTO slot_leases (id, project, slot, kind, agent, from_at) VALUES ('l9', 'p1', 'slot-b', 'carried', 'b1', 't')").run()
        rebindSession(db, 'p1', 'p1', 's1', 'l9')
        throw new Error('injected')
      })
    ).rejects.toThrow('injected')
    expect(b.store.lease('l9')).toBeNull()
    expect(leaseOf(b.db)).toBe('l1')
  })

  it("a record's save leaves its lease as it is, and older rows (no lease) read as before", async () => {
    const b = board()
    const w = b.store.conn
    const recs = w.read((db) => readSessionRecords(db, 'p1'))
    expect(recs[0]).toMatchObject({ id: 's1', cwd: slotFolder('slot-b'), lease: 'l1' })
    await w.write((db) => writeSessionRecords(db, 'p1', { sessions: [{ ...recs[0], name: 'renamed', lease: 'ignored' }] }))
    expect(leaseOf(b.db)).toBe('l1')
    expect(w.read((db) => readSessionRecords(db, 'p1'))[0]).toMatchObject({ name: 'renamed', lease: 'l1' })
    b.db.prepare("INSERT INTO sessions (host, id, ord, provider, name, created_at, last_active_at) VALUES ('p1', 'old', 1, 'claude-code', 'old', 't', 't')").run()
    const old = w.read((db) => readSessionRecords(db, 'p1')).find((r) => r.id === 'old')!
    expect(old).not.toHaveProperty('lease')
    expect(old).not.toHaveProperty('cwd')
    expect(resumeFolder(P, old as { cwd?: string })).toBe(P)
  })
})
