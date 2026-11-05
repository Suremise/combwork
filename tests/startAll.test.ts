// The session strip's batch actions and the Project menu (#216): Start New (All) and Archive and Start New (All) decide
// which agents and sessions from the agents as they are, flag busy ones as the quit dialog does, and go one agent at a
// time past failures; the title bar's Project menu lists every tab the strip has, in its order, from the same list, the
// main tabs Alt+1…8 and More ▾'s in a group of their own (#1043).
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { MAIN_TABS, MORE_TABS, PROJECT_MENU, PROJECT_TABS, STRIP_TABS, tabCommand } from '../src/shared/projectTabs'
import { archiveTarget, batchCounts, batchOutcome, busyNote, eachAgent, removeWorktreeText, sessionsToArchive, type BatchAgent } from '../src/shared/startAll'
import { agentRowsText } from '../src/shared/agentTable'

const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

describe('the Project menu is the tab strip', () => {
  it('lists all 14 tabs in the strip order, each with a command, from the list the strip uses', () => {
    const tabs = PROJECT_MENU.filter((x) => x.startsWith('project.tab.'))
    expect(tabs).toEqual(PROJECT_TABS.map((t) => tabCommand(t.id)))
    expect(tabs).toHaveLength(14)
    expect(tabs).toContain('project.tab.performance')
    const commands = src('src/renderer/src/commands.ts')
    for (const id of tabs) expect(commands, id).toContain(`id: '${id}'`)
    // The strip and the menu read the shared list (not copies of it); the strip leaves out Project Settings (#974), which
    // the menu keeps, last.
    expect(src('src/renderer/src/views/ProjectView.tsx')).toMatch(/const TABS = MAIN_TABS\b/)
    expect(STRIP_TABS.map((t) => tabCommand(t.id))).toEqual(tabs.filter((id) => id !== 'project.tab.settings'))
    expect(tabs.at(-1)).toBe('project.tab.settings')
    expect(src('src/renderer/src/components/TitleBar.tsx')).toMatch(/items: PROJECT_MENU\b/)
    // Explorer and Terminal stay in the menu.
    expect(PROJECT_MENU).toEqual(expect.arrayContaining(['project.openExplorer', 'project.openTerminal']))
  })

  it("groups the main tabs, then More ▾'s, then Project Settings, and numbers the main tabs Alt+1…9 in that order (#1043, Activity #1254)", () => {
    expect(MAIN_TABS.map((t) => t.id)).toEqual(['session', 'overview', 'performance', 'tasks', 'sessions', 'files', 'images', 'changes', 'activity'])
    expect(MORE_TABS.map((t) => t.id)).toEqual(['memory', 'skills', 'templates', 'mcp'])
    const group = (ids: string[]): number => PROJECT_MENU.indexOf(ids[0])
    const main = MAIN_TABS.map((t) => tabCommand(t.id))
    const more = MORE_TABS.map((t) => tabCommand(t.id))
    expect(PROJECT_MENU.slice(group(main), group(main) + main.length + 1)).toEqual([...main, '-'])
    expect(PROJECT_MENU.slice(group(more), group(more) + more.length + 2)).toEqual([...more, '-', 'project.tab.settings'])
    // Each tab command's default key, from its line in commands.ts.
    const commands = src('src/renderer/src/commands.ts')
    const lines = commands.split(/\r?\n/)
    const key = (id: string): string | null => lines.find((l) => l.includes(`{ id: '${id}',`))?.match(/keybinding: '([^']+)'/)?.[1] ?? null
    expect(main.map(key)).toEqual(['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'])
    expect(more.map(key)).toEqual([null, null, null, null])
    expect(key('project.tab.settings')).toBe('Alt+0')
    // No other command takes Alt and a digit.
    const others = lines.filter((l) => /keybinding: 'Alt\+\d'/.test(l) && !/\{ id: 'project\.tab\./.test(l))
    expect(others).toEqual([])
  })
})

describe('Start New (All) and Archive and Start New (All)', () => {
  const agent = (id: string, over: Partial<BatchAgent> = {}): BatchAgent => ({ id, name: id.toUpperCase(), live: null, resume: null, ...over })

  it("archives a running agent its current session, a stopped one the session its Resume would open, and leaves out agents with none", () => {
    const agents = [
      agent('w', { live: { sessionId: 's1', status: 'working' } }),
      agent('i', { resume: { id: 's2' } }),
      // Archived meanwhile, or gone from Combwork's list: nothing to archive.
      agent('a', { resume: { id: 's3' } }),
      agent('g', { resume: { id: 'gone' } }),
      agent('n')
    ]
    const sessions = [{ id: 's1' }, { id: 's2' }, { id: 's3', archived: true }]
    expect(sessionsToArchive(agents, sessions).map((x) => [x.agent.id, x.sessionId])).toEqual([
      ['w', 's1'],
      ['i', 's2']
    ])
    expect(sessionsToArchive([agent('n')], sessions)).toEqual([])
    expect(agents.map(archiveTarget)).toEqual(['s1', 's2', 's3', 'gone', null])
  })

  it('counts the agents each header action acts on, by the rules its confirmation uses (#275)', () => {
    const agents = [
      agent('w', { live: { sessionId: 's1', status: 'working' } }),
      agent('i', { live: { sessionId: 's2', status: 'ready' } }),
      agent('s', { resume: { id: 's3' } }),
      agent('t', { resume: { id: 's4' } }),
      agent('n'),
      agent('m')
    ]
    expect(batchCounts(agents)).toEqual({ stop: 2, resume: 2, startNew: 6, archive: 4 })
    // Archive's count is the agents its confirmation lists (when Combwork keeps their sessions).
    const sessions = ['s1', 's2', 's3', 's4'].map((id) => ({ id }))
    expect(sessionsToArchive(agents, sessions)).toHaveLength(batchCounts(agents).archive)
    expect(batchCounts([])).toEqual({ stop: 0, resume: 0, startNew: 0, archive: 0 })
  })

  it('flags what stopping a running agent costs, as the quit dialog does; idle and stopped ones get no flag', () => {
    expect(busyNote('working')).toBe('will be interrupted')
    expect(busyNote('background')).toBe('background tasks will stop')
    expect(busyNote('waiting')).toBe('waiting for you')
    for (const s of ['ready', 'finished', 'starting', 'error'] as const) expect(busyNote(s)).toBeNull()
  })

  it('goes one agent at a time: a failure is reported with its reason and the rest still start', async () => {
    const order: string[] = []
    const r = await eachAgent([agent('a'), agent('b'), agent('c')], async (x) => {
      order.push(x.id)
      if (x.id === 'b') throw new Error('Claude Code is turned off')
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(r).toEqual({ done: ['A', 'C'], failed: [{ name: 'B', error: 'Claude Code is turned off' }] })
  })
})

describe("the confirms' table (#572): what happens to each agent, and Remove All's worktree", () => {
  const live = (status: NonNullable<BatchAgent['live']>['status']) => ({ live: { sessionId: 's', status } })
  it('a running agent is stopped first, flagged when that interrupts something; a stopped one only gets what follows', () => {
    expect(batchOutcome('start', { live: null })).toEqual({ text: 'A new session', warn: false })
    expect(batchOutcome('start', live('ready'))).toEqual({ text: 'Stopped, then a new session', warn: false })
    expect(batchOutcome('start', live('working'))).toEqual({ text: 'Stopped (will be interrupted), then a new session', warn: true })
    expect(batchOutcome('archive', { live: null })).toEqual({ text: 'Its session archived, then a new one', warn: false })
    expect(batchOutcome('archive', live('background'))).toEqual({ text: 'Stopped (background tasks will stop), then its session archived, then a new one', warn: true })
    expect(batchOutcome('remove', live('watching'))).toEqual({ text: 'Stopped (its card loop pauses until it is resumed), then removed', warn: true })
    expect(batchOutcome('remove', { live: null })).toEqual({ text: 'Removed', warn: false })
  })
  it('the plain text says every cell the table shows, the card too (a reviewer\'s as such), a line an agent (#572)', () => {
    const columns = [{}, { cell: (t: string) => `card ${t}` }, { cell: (t: string) => `worktree ${t}` }, {}]
    const text = agentRowsText(columns, [
      { name: 'W', cells: [{ text: 'Working…' }, { text: '#12 Lanes' }, { text: 'cw/w' }, { text: batchOutcome('start', live('working')).text }] },
      { name: 'R', cells: [{ text: 'Watching' }, { text: 'reviewing #12 Lanes' }, { text: '' }, { text: batchOutcome('start', live('watching')).text }] },
      { name: 'S', cells: [{ text: 'Not running' }, { text: '' }, { text: removeWorktreeText({ branch: 'cw/s', check: { removable: false, reason: '2 unmerged commits' } }) }, { text: 'Removed' }] }
    ])
    expect(text.split('\n')).toEqual([
      '• W — Working… · card #12 Lanes · worktree cw/w · Stopped (will be interrupted), then a new session',
      '• R — Watching · card reviewing #12 Lanes · Stopped (its card loop pauses until it is resumed), then a new session',
      '• S — Not running · worktree cw/s: always kept (2 unmerged commits) · Removed'
    ])
  })

  it("a heading's line goes over its agents (the quit dialog's workspaces)", () => {
    expect(agentRowsText([{ cell: (t: string) => `in ${t}` }, {}], [{ groupText: 'ws-a' }, { name: 'B1', cells: [{ text: 'alpha' }, { text: 'Ready' }] }, { groupText: 'ws-b' }, { name: 'B2', cells: [{ text: 'beta' }, { text: '' }] }])).toBe('ws-a:\n• B1 — in alpha · Ready\nws-b:\n• B2 — in beta')
  })

  it("Remove All's worktree cell says whether the box can delete it (#291)", () => {
    expect(removeWorktreeText({ branch: 'cw/b1', check: { removable: true } })).toBe('cw/b1: merged and clean')
    expect(removeWorktreeText({ branch: 'cw/b2', check: { removable: false, reason: '2 commits not merged' } })).toBe('cw/b2: always kept (2 commits not merged)')
    expect(removeWorktreeText({ branch: 'cw/b3' })).toBe("cw/b3: always kept (couldn't be checked)")
  })
})
