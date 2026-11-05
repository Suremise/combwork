// The Assistant's state view (#1032): given at each session start and after each compaction while its journal is on.
// What it says (the board, lanes, agents, what waits on the user, the journal's few entries in scope, a missing weekly
// digest), its hard budget however much there is, nothing while the journal is off, the SessionStart reply that carries
// it, and the handover's once-only suggestion of the journal while it is off.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { isoWeek, weekStart } from '../src/shared/journal'
import { utf8Bytes } from '../src/shared/metrics'
import { START_VIEW_MAX_BYTES, startView, type StartViewInput, type ViewCard, type ViewEntry } from '../src/shared/startView'
import type { LiveSessionState } from '../src/shared/types'

const base = tempDir('hive-start-view-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const journal = await import('../src/main/journal')
const service = await import('../src/main/journalService')
const { assistantStartView } = await import('../src/main/startView')
const { ClaudeCodeAdapter } = await import('../src/main/providers/claude/adapter')
const { advanced } = await import('../src/main/advanced')
const { ASSISTANT_START_VIEW } = await import('../src/shared/advanced')

vi.setConfig({ testTimeout: 30_000 })
const user = { kind: 'user' } as const
const DAY = 86_400_000

const empty = (over: Partial<StartViewInput> = {}): StartViewInput => ({ now: new Date('2026-10-18T12:00:00Z'), source: 'startup', counts: [], active: [], blocked: [], lanes: [], agents: [], journal: { decisions: [], incidents: [], onCards: [], digestDue: null }, ...over })
const card = (n: number, over: Partial<ViewCard> = {}): ViewCard => ({ number: n, title: `Card ${n}`, column: 'doing', project: 'alpha', agent: 'B1', reviewer: null, blocked: null, ...over })
const entry = (id: number, over: Partial<ViewEntry> = {}): ViewEntry => ({ id, at: '2026-10-15T09:00:00Z', kind: 'decision', project: 'alpha', summary: `Entry ${id}`, importance: 1, ...over })

describe('the state view as text', () => {
  it('says where things stand, section by section, and how to recall more', () => {
    const v = startView(
      empty({
        source: 'compact',
        counts: [{ project: 'alpha', columns: { doing: 1, review: 1, todo: 4, done: 9 } }],
        active: [card(12, { title: 'Friendlier greeting' }), card(13, { column: 'review', agent: 'B2', reviewer: 'R1' })],
        blocked: [card(14, { column: 'todo', agent: null, blocked: 'Which greeting does Darren want?' })],
        lanes: [{ project: 'alpha', builder: 'B1', reviewer: 'R1', current: 12, state: 'active', pausedOn: null }],
        agents: [{ project: 'alpha', name: 'B1', status: 'working' }, { project: 'alpha', name: 'B3', status: 'waiting', asking: 'Allow Bash?' }],
        journal: { decisions: [entry(5, { summary: 'Darren: "Welcome back!" is the greeting', importance: 2 })], incidents: [entry(6, { kind: 'incident', summary: 'Merge of #10 failed its lint' })], onCards: [entry(7, { kind: 'plan', summary: 'Start #15 once #12 is Done' })], digestDue: '2026-W41' }
      })
    )
    expect(v.split('\n')[0]).toMatch(/^\[CW\] Where things stand, after a compaction \(2026-10-18 12:00 UTC\).*Check the live state before acting on it\.$/)
    expect(v).toContain('Waiting on the user:\n- #14 (alpha, Todo) blocked: Which greeting does Darren want?\n- B3 (alpha) waits for the user: Allow Bash?')
    expect(v).toContain('Cards in Doing and Review:\n- #12 Doing · alpha · B1: Friendlier greeting\n- #13 Review · alpha · B2, reviewed by R1: Card 13')
    expect(v).toContain('Lanes running:\n- B1/R1 (alpha): on #12, active')
    expect(v).toContain('Agents running:\n- alpha: B1 working, B3 waiting')
    expect(v).toContain('Board:\n- alpha: 1 Doing, 1 Review, 4 Todo')
    expect(v).toContain('Journal: recent decisions and plans:\n- #5 2026-10-15 decision (alpha) !: Darren: "Welcome back!" is the greeting')
    expect(v).toContain('Journal: on the cards in hand:\n- #7 2026-10-15 plan (alpha): Start #15 once #12 is Done')
    expect(v).toContain('Journal: recent incidents:\n- #6 2026-10-15 incident (alpha): Merge of #10 failed its lint')
    expect(v).toContain('2026-W41 has entries but no digest: write one (kind digest, digestOf "2026-W41"; the journal skill).')
    expect(v.split('\n').at(-1)).toMatch(/cw_journal_recall/)
  })

  it('leaves out empty sections, and says so when no agent runs', () => {
    const v = startView(empty())
    expect(v).toContain('Agents running:\n- none')
    expect(v).not.toMatch(/Waiting on the user|Journal:|Lanes running|Weekly digest/)
    expect(startView(empty({ source: 'resume' }))).toMatch(/Where things stand, on resuming/)
  })

  it('never passes its budget, however much there is, and counts what it leaves out', () => {
    const long = 'x'.repeat(400)
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
    const v = startView(
      empty({
        counts: many(40, (i) => ({ project: `project-${i}-${long.slice(0, 60)}`, columns: { doing: 3, review: 2, passed: 1, todo: 30 } })),
        active: many(200, (i) => card(1000 + i, { title: long, agent: `Agent-${i}`, reviewer: 'Reviewer' })),
        blocked: many(100, (i) => card(2000 + i, { blocked: long })),
        lanes: many(50, (i) => ({ project: 'alpha', builder: `B${i}`, reviewer: `R${i}`, current: i, state: 'active', pausedOn: null })),
        agents: many(240, (i) => ({ project: `p${i % 10}`, name: `Agent-${i}`, status: i % 3 ? 'working' : 'waiting', asking: long })),
        journal: { decisions: many(50, (i) => entry(i, { summary: long })), incidents: many(50, (i) => entry(100 + i, { kind: 'incident', summary: long })), onCards: many(50, (i) => entry(200 + i, { summary: long })), digestDue: '2026-W41' }
      })
    )
    expect(utf8Bytes(v)).toBeLessThanOrEqual(START_VIEW_MAX_BYTES)
    // Every section is there (each gets its first lines before any gets more), with a count of the rest.
    for (const title of ['Waiting on the user:', 'Cards in Doing and Review:', 'Lanes running:', 'Agents running:', 'Board:', 'Journal: recent decisions and plans:', 'Journal: on the cards in hand:', 'Journal: recent incidents:', 'Weekly digest:']) expect(v, title).toContain(`\n${title}\n`)
    expect(v).toMatch(/Waiting on the user:\n- Agent-0 \(p0\) waits for the user/)
    expect(v).toMatch(/- \(\d+ more: cw_list_tasks and cw_list_projects\)/)
    // Lines are whole: long text is clipped within its line.
    for (const line of v.split('\n')) expect(line.length).toBeLessThanOrEqual(300)
  })

  it("keeps the journal and the board when one section is crowded (#1032 round 2: 100 blocked cards left no memory)", () => {
    const reason = 'r'.repeat(120)
    const v = startView(
      empty({
        source: 'compact',
        counts: [{ project: 'alpha', columns: { doing: 1, todo: 100 } }],
        active: [card(1, { title: 'The one in hand' })],
        blocked: Array.from({ length: 100 }, (_, i) => card(100 + i, { column: 'todo', agent: null, blocked: reason })),
        journal: { decisions: [entry(5, { summary: 'Darren: "Welcome back!" is the greeting', importance: 2 })], incidents: [], onCards: [], digestDue: '2026-W41' }
      })
    )
    expect(utf8Bytes(v)).toBeLessThanOrEqual(START_VIEW_MAX_BYTES)
    expect(v).toContain('- #1 Doing · alpha · B1: The one in hand')
    expect(v).toContain('Darren: "Welcome back!" is the greeting')
    expect(v).toContain('2026-W41 has entries but no digest')
    expect(v).toContain('Board:\n- alpha: 1 Doing, 100 Todo')
    // The crowded section still gets what is left, and says how many it left out.
    expect(v).toMatch(/- \(\d+ more: cw_list_tasks and cw_list_projects\)/)
    // ...up to its cap (#1078).
    expect((v.match(/blocked: r+/g) ?? []).length).toBe(10)
  })

  it('keeps every section within its budget with CJK and emoji text, cut between whole characters (#1069)', () => {
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
    // n characters (code points), so the input itself has no half pairs.
    const chars = (s: string, n: number): string => Array.from(s.repeat(n)).slice(0, n).join('')
    const cjk = (n: number, i: number): string => chars(`${i}漢字かな한글`, n)
    const emoji = (n: number, i: number): string => chars(`${i}🐝👩‍💻🎉`, n)
    for (const text of [cjk, emoji]) {
      const v = startView(
        empty({
          counts: many(20, (i) => ({ project: text(80, i), columns: { doing: 3, review: 2, passed: 1, todo: 30 } })),
          active: many(20, (i) => card(1000 + i, { project: text(80, i), title: text(90, i), agent: text(30, i), reviewer: text(30, i) })),
          blocked: many(20, (i) => card(2000 + i, { project: text(80, i), agent: text(30, i), blocked: text(120, i) })),
          lanes: many(20, (i) => ({ project: text(80, i), builder: text(30, i), reviewer: text(30, i), current: i, state: 'active', pausedOn: null })),
          agents: many(20, (i) => ({ project: text(80, i % 4), name: text(30, i), status: 'working' })),
          journal: { decisions: many(20, (i) => entry(i, { project: text(80, i), summary: text(160, i) })), incidents: many(20, (i) => entry(100 + i, { kind: 'incident', project: text(80, i), summary: text(160, i) })), onCards: many(20, (i) => entry(200 + i, { project: text(80, i), summary: text(160, i) })), digestDue: '2026-W41' }
        })
      )
      expect(utf8Bytes(v)).toBeLessThanOrEqual(START_VIEW_MAX_BYTES)
      for (const title of ['Waiting on the user:', 'Cards in Doing and Review:', 'Lanes running:', 'Agents running:', 'Board:', 'Journal: recent decisions and plans:', 'Journal: on the cards in hand:', 'Journal: recent incidents:', 'Weekly digest:']) {
        expect(v, title).toContain(`\n${title}\n`)
        // Each section's floor: its first two lines, whatever is crowded elsewhere.
        const section = v.split(`\n${title}\n`)[1].split('\n')
        expect(section.slice(0, title === 'Weekly digest:' ? 1 : 2).every((l) => l.startsWith('- ') && !l.startsWith('- (')), title).toBe(true)
      }
      for (const line of v.split('\n')) expect(utf8Bytes(line)).toBeLessThanOrEqual(400)
      // No half of a surrogate pair where a line or a title was cut.
      expect(v).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
  })

  it('caps what waits on the user at 10 lines, decisions first, then a count of the rest On Hold (#1078)', () => {
    const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`
    const after = Array.from({ length: 55 }, (_, i) => card(100 + i, { column: 'hold', agent: null, blocked: 'After 0.9.0: needs the new board first', updatedAt: at(1 + (i % 17)) }))
    const decide = [
      card(300, { column: 'hold', agent: null, blocked: 'Darren to decide the layout', updatedAt: at(3) }),
      card(301, { column: 'hold', agent: null, blocked: 'Discuss with Darren before building', updatedAt: at(16) }),
      card(302, { column: 'hold', agent: null, blocked: 'Which provider first?', updatedAt: at(10) }),
      card(303, { column: 'hold', agent: null, blocked: 'Waits for the user', labels: ['design'], updatedAt: at(12) })
    ]
    const inHand = card(400, { column: 'review', agent: 'B1', blocked: 'Last round failed: carry on?', updatedAt: at(2) })
    const v = startView(
      empty({
        counts: [{ project: 'alpha', columns: { doing: 1, review: 1, todo: 12, hold: 60 } }],
        active: [card(1, { title: 'The one in hand' }), inHand],
        blocked: [...after, ...decide, inHand],
        agents: [{ project: 'alpha', name: 'B1', status: 'working' }, { project: 'alpha', name: 'B3', status: 'waiting', asking: 'Allow Bash?' }],
        journal: { decisions: [entry(5)], incidents: [], onCards: [], digestDue: null }
      })
    )
    const section = v.split('Waiting on the user:\n')[1].split('\nCards in Doing and Review:')[0].split('\n')
    expect(section).toHaveLength(11)
    // The agent asking now, the card blocked in hand, the decisions (newest first), then the plain waits (newest first).
    expect(section.slice(0, 6)).toEqual([
      '- B3 (alpha) waits for the user: Allow Bash?',
      '- #400 (alpha, Review, B1) blocked: Last round failed: carry on?',
      '- #301 (alpha, On hold) blocked: Discuss with Darren before building',
      '- #303 (alpha, On hold) blocked: Waits for the user',
      '- #302 (alpha, On hold) blocked: Which provider first?',
      '- #300 (alpha, On hold) blocked: Darren to decide the layout'
    ])
    expect(section.slice(6, 10).every((l) => l.includes('After 0.9.0'))).toBe(true)
    const shownDates = section.slice(6, 10).map((l) => after.find((c) => l.startsWith(`- #${c.number} `))!.updatedAt)
    expect(shownDates).toEqual([at(17), at(17), at(17), at(16)])
    expect(section[10]).toBe('- (51 more On Hold: cw_list_tasks column hold)')
    // About 1.5K tokens at most, with every other section there.
    expect(utf8Bytes(v)).toBeLessThan(6000)
    for (const title of ['Cards in Doing and Review:', 'Agents running:', 'Board:', 'Journal: recent decisions and plans:']) expect(v, title).toContain(`\n${title}\n`)
  })

  it('keeps a small list as it was, in its order, up to the cap (#1078 round 1)', () => {
    const blocked = [
      card(20, { column: 'hold', agent: null, blocked: 'After 0.9.0', updatedAt: '2026-10-01T00:00:00Z' }),
      card(21, { column: 'hold', agent: null, blocked: 'Darren to decide', updatedAt: '2026-10-17T00:00:00Z' }),
      ...Array.from({ length: 7 }, (_, i) => card(30 + i, { column: 'todo', agent: null, blocked: 'Which one?' }))
    ]
    const v = startView(empty({ blocked, agents: [{ project: 'alpha', name: 'B3', status: 'waiting', asking: 'Allow Bash?' }] }))
    const section = v.split('Waiting on the user:\n')[1].split('\nAgents running:')[0].split('\n')
    expect(section).toEqual([...blocked.map((c) => `- #${c.number} (alpha, ${c.column === 'hold' ? 'On hold' : 'Todo'}) blocked: ${c.blocked}`), '- B3 (alpha) waits for the user: Allow Bash?'])
  })

  it('caps the other sections too, however much room is left (#1078)', () => {
    const many = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))
    const shown = (v: string, title: string): number => v.split(`${title}\n`)[1].split('\n').findIndex((l) => !l.startsWith('- ') || l.startsWith('- ('))
    const v = startView(
      empty({
        counts: many(30, (i) => ({ project: `p${i}`, columns: { todo: 1 } })),
        active: many(30, (i) => card(i + 1)),
        lanes: many(30, (i) => ({ project: 'alpha', builder: `B${i}`, reviewer: null, current: i + 1, state: 'active', pausedOn: null })),
        agents: many(30, (i) => ({ project: `p${i}`, name: 'B1', status: 'working' }))
      })
    )
    expect(shown(v, 'Cards in Doing and Review:')).toBe(10)
    expect(v).toContain('- (20 more: cw_list_tasks)')
    expect(shown(v, 'Lanes running:')).toBe(8)
    expect(v).toContain('- (22 more: cw_lane list)')
    expect(shown(v, 'Agents running:')).toBe(8)
    expect(v).toContain('- (22 more: cw_list_projects)')
    expect(shown(v, 'Board:')).toBe(10)
  })

  it('counts left-out lines the usual way when some are not On Hold', () => {
    const v = startView(empty({ blocked: Array.from({ length: 12 }, (_, i) => card(i + 1, { column: i < 11 ? 'doing' : 'hold', blocked: 'Carry on?' })) }))
    expect(v).toContain('- (2 more: cw_list_tasks and cw_list_projects)')
    const held = startView(empty({ blocked: Array.from({ length: 12 }, (_, i) => card(i + 1, { column: i < 9 ? 'doing' : 'hold', blocked: 'Carry on?' })) }))
    expect(held).toContain('- (2 more On Hold: cw_list_tasks column hold)')
  })
})

describe('the state view in a workspace', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const cards: Record<string, number> = {}
  const run = <T,>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const home = (): string => w.assistantHome
  const write = (kind: string, summary: string, more: Record<string, unknown> = {}): number => journal.writeEntry(home(), service.journalSettingsOf(w), { kind, summary, ...more }, 'assistant')
  const backdate = (id: number, at: Date): void => {
    const db = new DatabaseSync(journal.journalFile(home()))
    db.prepare('UPDATE entries SET at = ? WHERE id = ?').run(at.toISOString(), id)
    db.close()
  }
  const live = [{ projectPath: alpha, agentId: 'b1', agentName: 'B1', status: 'working' }, { projectPath: alpha, agentId: 'r1', agentName: 'R1', status: 'waiting', statusMessage: 'Allow Bash?' }] as LiveSessionState[]

  beforeAll(async () => {
    process.env.CW_TEST_TRASH_DIR = join(base, 'trash')
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    // Everything on (preferences too), then narrowed below.
    await service.setJournalSettings(w, { scope: ['decision', 'plan', 'event', 'incident', 'insight', 'preference'] })
    cards.doing = (await run(() => tasks.createTask({ title: 'Friendlier greeting', project: 'alpha', column: 'doing', agent: 'B1' }, user))).number
    cards.review = (await run(() => tasks.createTask({ title: 'Faster tests', project: 'alpha' }, user))).number
    await run(() => tasks.updateTask(cards.review, { column: 'review' }, user))
    cards.blocked = (await run(() => tasks.createTask({ title: 'Pick a colour', project: 'alpha', blocked: 'Which colour does Darren want?' }, user))).number
    cards.done = (await run(() => tasks.createTask({ title: 'Old work', project: 'alpha' }, user))).number
    await run(() => tasks.updateTask(cards.done, { column: 'done' }, user))
    await lanes.startLane(w, { project: 'alpha', builder: 'b1', reviewer: 'r1', cards: [cards.doing], by: 'B1' })
  })
  afterAll(async () => {
    delete process.env.CW_TEST_TRASH_DIR
    await disposeWorkspaceService(w)
  })

  it('gives the board, lanes, agents and the journal entries relevant now', async () => {
    const now = new Date()
    const decision = write('decision', 'Darren: the greeting is "Welcome back!"', { importance: 2, links: [{ type: 'card', ref: String(cards.doing) }] })
    backdate(decision, new Date(now.getTime() - 6 * DAY))
    const old = write('decision', 'A decision from last month')
    backdate(old, new Date(now.getTime() - 30 * DAY))
    write('incident', 'The merge of #3 failed its lint')
    const onCard = write('insight', 'Faster tests: the slow one is the e2e build', { links: [{ type: 'card', ref: String(cards.review) }] })
    write('preference', 'Darren likes short replies')
    const v = (await run(() => assistantStartView(w, live, 'compact', now)))!
    expect(v).toMatch(/after a compaction/)
    expect(v).toContain(`- #${cards.blocked} (alpha, Todo) blocked: Which colour does Darren want?`)
    expect(v).toContain('- R1 (alpha) waits for the user: Allow Bash?')
    expect(v).toContain(`- #${cards.doing} Doing · alpha · B1: Friendlier greeting`)
    expect(v).toContain(`- #${cards.review} Review · alpha: Faster tests`)
    expect(v).not.toContain('Old work')
    expect(v).toMatch(new RegExp(`- B1/R1 \\(alpha\\): on #${cards.doing}, active`))
    expect(v).toContain('- alpha: B1 working, R1 waiting')
    expect(v).toContain(`#${decision} `)
    expect(v).toContain('Darren: the greeting is "Welcome back!"')
    expect(v).not.toContain('A decision from last month')
    expect(v).toContain('The merge of #3 failed its lint')
    expect(v).toContain(`- #${onCard} `)
    // Preferences aren't among the kinds the view looks at.
    expect(v).not.toContain('Darren likes short replies')
    expect(utf8Bytes(v)).toBeLessThanOrEqual(START_VIEW_MAX_BYTES)
  })

  it("leaves out kinds the scope doesn't allow any more", async () => {
    await service.setJournalSettings(w, { scope: ['plan', 'event'] })
    const v = (await run(() => assistantStartView(w, live, 'startup')))!
    expect(v).not.toContain('Welcome back!')
    expect(v).not.toContain('failed its lint')
    expect(v).not.toContain('the slow one is the e2e build')
    expect(v).toContain('Friendlier greeting')
    await service.setJournalSettings(w, { scope: ['decision', 'plan', 'event', 'incident', 'insight'] })
  })

  it('asks for a digest of last week when it had entries and none', async () => {
    const lastWeek = new Date(weekStart(new Date()).getTime() - 3 * DAY)
    const label = isoWeek(lastWeek)
    backdate(write('event', 'Something last week'), lastWeek)
    expect(await run(() => assistantStartView(w, live, 'startup'))).toContain(`${label} has entries but no digest`)
    write('digest', `The week ${label}`, { digestOf: label })
    expect(await run(() => assistantStartView(w, live, 'startup'))).not.toContain('has entries but no digest')
  })

  it('stays within its budget with a big board and a busy journal', async () => {
    const long = 'A long title that goes on '.repeat(7)
    for (let i = 0; i < 40; i++) await run(() => tasks.createTask({ title: `${long} ${i}`, project: 'alpha', column: 'doing', blocked: i % 2 ? long : undefined }, user))
    for (let i = 0; i < 40; i++) write('decision', `${long} decision ${i}`)
    const v = (await run(() => assistantStartView(w, live, 'startup')))!
    expect(utf8Bytes(v)).toBeLessThanOrEqual(START_VIEW_MAX_BYTES)
    expect(v).toMatch(/\(\d+ more: /)
  })

  it('gives nothing while the journal is off', async () => {
    await service.setJournalSettings(w, { enabled: false })
    expect(await run(() => assistantStartView(w, live, 'startup'))).toBeNull()
    await service.setJournalSettings(w, { enabled: true })
  })

  it("gives nothing with Settings → Advanced's start view off (#1286), and the view again with it on", async () => {
    const get = advanced.get.bind(advanced)
    const off = vi.spyOn(advanced, 'get').mockImplementation(((id: string, ws?: Record<string, unknown> | null) => (id === ASSISTANT_START_VIEW ? false : get(id, ws))) as typeof advanced.get)
    try {
      expect(await run(() => assistantStartView(w, live, 'startup'))).toBeNull()
      expect(await run(() => assistantStartView(w, live, 'compact'))).toBeNull()
    } finally {
      off.mockRestore()
    }
    expect(advanced.get<boolean>(ASSISTANT_START_VIEW)).toBe(true)
    expect(await run(() => assistantStartView(w, live, 'startup'))).toMatch(/^\[CW\] Where things stand/)
  })

  it("is carried by Claude Code's SessionStart reply", () => {
    expect(new ClaudeCodeAdapter().startContextReply('[CW] view')).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[CW] view' } })
  })

  it('with the journal off, a handover suggests it once, never again', async () => {
    await service.setJournalSettings(w, { enabled: false })
    expect(await service.journalSuggestion(w)).toBe(service.JOURNAL_SUGGESTION)
    expect(await service.journalSuggestion(w)).toBeNull()
    expect(JSON.parse(readFileSync(join(wsPath, '.combwork', 'workspace.json'), 'utf8')).journalSuggested).toBe(true)
    await service.setJournalSettings(w, { enabled: true })
    expect(await service.journalSuggestion(w)).toBeNull()
  })
})
