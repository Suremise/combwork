// The hive tools' short replies (shared/toolReplies.ts): a change confirms what changed and where the card is now,
// a listing is one line per item, and nothing echoes a card's description, comments or history.
import { describe, expect, it } from 'vitest'
import { addRetryWaited, retryWaitEnd } from '../src/shared/runtime'
import {
  CLI_DEFAULT,
  MAX_ROWS,
  cardRequests,
  modelInUse,
  retryWaitsView,
  messageQueuedText,
  newestComments,
  notifiedText,
  changedText,
  commentsParam,
  createdText,
  noteText,
  notesListText,
  progressLabel,
  readTaskQuery,
  projectListText,
  projectStatusReply,
  releaseText,
  reorderText,
  settingListText,
  taskListText,
  taskRow,
  withoutHistory,
  type TaskRow,
  type TaskView
} from '../src/shared/toolReplies'

const LONG = 'x'.repeat(5000)

function view(n: number, extra: Partial<TaskView> = {}): TaskView {
  return {
    number: n,
    title: `Card ${n}`,
    description: LONG,
    project: 'alpha',
    agent: null,
    column: 'todo',
    order: n,
    labels: [],
    blocked: null,
    blockedBy: [],
    links: [],
    comments: [{ at: '2026-10-02T00:00:00Z', by: 'You', text: LONG }],
    history: [{ at: '2026-10-02T00:00:00Z', by: 'You', what: 'Created in Todo' }],
    archived: false,
    createdAt: '2026-10-02T00:00:00Z',
    createdBy: 'You',
    updatedAt: '2026-10-02T00:00:00Z',
    stalled: null,
    stage: 'todo',
    ...extra
  }
}

describe('task rows', () => {
  it('keep what a card is and where it stands, not its text', () => {
    const r = taskRow(view(35, { agent: { id: 'a1', name: 'Coder', status: 'working', backgroundTasks: 0 }, labels: ['bug'], blocked: 'waiting on the API', blockedBy: [12] }))
    expect(r).toEqual({ number: 35, title: 'Card 35', column: 'todo', project: 'alpha', agent: { name: 'Coder', status: 'working', backgroundTasks: 0 }, labels: ['bug'], blocked: 'waiting on the API', blockedBy: [12], stalled: null, comments: 1, archived: false })
    expect(JSON.stringify(r)).not.toContain('xxxx')
  })

  it('list as one line each, by column, top first', () => {
    const rows: TaskRow[] = [
      taskRow(view(3, { agent: { id: 'a1', name: 'Coder', status: 'finished', backgroundTasks: 2 }, labels: ['bug', 'polish'] })),
      taskRow(view(1)),
      taskRow(view(7, { column: 'doing', stalled: "Coder isn't running." }))
    ]
    const text = taskListText(rows)
    expect(text).toBe(
      [
        'Todo (2, top first):',
        '#3 Card 3 · alpha · Coder (idle, 2 background tasks) · bug, polish · 1 comment',
        '#1 Card 1 · alpha · 1 comment',
        '',
        'Doing (1, top first):',
        "#7 Card 7 · alpha · stalled: Coder isn't running. · 1 comment",
        '',
        'cw_read_task gives a card in full.'
      ].join('\n')
    )
  })

  it('stop at the row limit, say how many more there are, and carry on from an offset', () => {
    const rows = Array.from({ length: MAX_ROWS + 25 }, (_, i) => taskRow(view(i + 1)))
    const text = taskListText(rows)
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(MAX_ROWS)
    expect(text).toContain(`…and 25 more: offset ${MAX_ROWS} carries on.`)
    expect(text).toContain(`Todo (${MAX_ROWS + 25}, top first):`)
    // The next page: the rest, every card once, in board order, with the column's whole count.
    const next = taskListText(rows, { offset: MAX_ROWS })
    const shown = next.split('\n').filter((l) => l.startsWith('#'))
    expect(shown).toHaveLength(25)
    expect(shown[0]).toMatch(new RegExp(`^#${MAX_ROWS + 1} `))
    expect(next).toContain(`Cards ${MAX_ROWS + 1}–${MAX_ROWS + 25} of ${MAX_ROWS + 25}.`)
    expect(next).toContain(`Todo (${MAX_ROWS + 25}, top first):`)
    expect(next).not.toContain('more:')
    expect(taskListText(rows, { offset: 900 })).toBe(`There are ${MAX_ROWS + 25} cards: offset 900 is past the last.`)
  })

  it('say when there are none', () => {
    expect(taskListText([])).toBe('No cards.')
    expect(taskListText([], { archived: true })).toBe('No archived cards.')
  })
})

describe('task changes', () => {
  it('a new card: its number and place', () => {
    expect(createdText({ number: 61, title: 'Lean replies', column: 'todo', position: 51, of: 51, project: 'hive', agent: 'Coder', changes: [] })).toBe('#61 created in Todo (51st of 51) for hive, given to Coder: Lean replies')
  })

  it('a change: what changed and where the card is now', () => {
    expect(changedText({ number: 60, title: 'Reorder', column: 'review', position: 1, of: 4, project: 'hive', agent: null, changes: ['Moved to Review', 'Commented'] })).toBe('#60 Reorder: Moved to Review; Commented. Now in Review (1st of 4), hive.')
    expect(changedText({ number: 8, title: 'T', column: 'todo', position: 12, of: 12, project: '', agent: null, changes: [] })).toBe('#8 T: No change. Now in Todo (12th of 12).')
  })

  it('a reorder: the new top, not the column', () => {
    expect(reorderText({ column: 'todo', top: [11, 6, 8], count: 50 })).toBe('Todo now starts #11, #6, #8; its other 47 cards keep their order below.')
    expect(reorderText({ column: 'review', top: [2, 1], count: 2 })).toBe('Review now starts #2, #1.')
  })

  it('a read without history says how long it is', () => {
    const v = withoutHistory(view(4))
    expect('history' in v).toBe(false)
    expect(v.historyEntries).toBe(1)
    expect(v.description).toBe(LONG)
    expect(v.comments).toHaveLength(1)
  })
})

describe("an agent's model, effort and retry waits (HI-1996)", () => {
  it('what its CLI reports, else what its launch gave, else its CLI’s default; not running: none', () => {
    expect(modelInUse(null)).toBeNull()
    expect(modelInUse({ modelId: 'claude-opus-5-5', effort: 'high', launchedWith: { model: 'opus', effort: 'medium' } })).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(modelInUse({ launchedWith: { model: 'gpt-5.6', effort: 'xhigh' } })).toEqual({ model: 'gpt-5.6', effort: 'xhigh' })
    expect(modelInUse({ modelName: 'Sonnet', launchedWith: { model: null, effort: null } })).toEqual({ model: 'Sonnet', effort: CLI_DEFAULT })
    expect(modelInUse({})).toEqual({ model: CLI_DEFAULT, effort: CLI_DEFAULT })
  })

  const wait = { at: '2026-10-29T10:00:00.000Z', since: '2026-10-29T10:00:00.000Z', retryAt: '2026-10-29T10:06:40.000Z', attempt: 1, max: 5, status: 429 }
  const at = (iso: string): number => Date.parse(iso)

  it('none: absent, so the reply stays as it was', () => {
    expect(retryWaitsView(null)).toBeUndefined()
    expect(retryWaitsView({})).toBeUndefined()
  })

  it('a wait ends at its retry time when Hive notices later, never before it began; the waits add up', () => {
    expect(retryWaitEnd(wait, at('2026-10-29T10:06:45.000Z'))).toBe(at(wait.retryAt))
    expect(retryWaitEnd(wait, at('2026-10-29T10:02:00.000Z'))).toBe(at('2026-10-29T10:02:00.000Z'))
    expect(retryWaitEnd({ ...wait, retryAt: null }, at('2026-10-29T09:59:00.000Z'))).toBe(at(wait.since))
    const one = addRetryWaited(undefined, wait, at('2026-10-29T10:06:45.000Z'))
    expect(one).toEqual({ waits: 1, ms: 400_000, latest: { since: wait.since, ended: wait.retryAt, tries: 1, status: 429 } })
    const two = addRetryWaited(one, { ...wait, since: '2026-10-29T11:00:00.000Z', retryAt: null, attempt: 3, status: null, network: true }, at('2026-10-29T11:01:00.000Z'))
    expect(two).toEqual({ waits: 2, ms: 460_000, latest: { since: '2026-10-29T11:00:00.000Z', ended: '2026-10-29T11:01:00.000Z', tries: 3, status: null, network: true } })
    // As cw_agent_activity gives them: seconds; one under way counted to now, the latest.
    expect(retryWaitsView({ retryWaited: two })).toEqual({ waits: 2, seconds: 460, latest: { since: '2026-10-29T11:00:00.000Z', seconds: 60, tries: 3, status: null, network: true } })
    expect(retryWaitsView({ retryWaited: two, retryWait: { ...wait, since: '2026-10-29T12:00:00.000Z', retryAt: '2026-10-29T12:05:00.000Z' } }, at('2026-10-29T12:01:30.000Z'))).toEqual({
      waits: 3,
      seconds: 550,
      latest: { since: '2026-10-29T12:00:00.000Z', seconds: 90, tries: 1, status: 429, ongoing: true, retryAt: '2026-10-29T12:05:00.000Z' }
    })
  })
})

describe("a card's open requests (HI-1992)", () => {
  const asked = { card: 7, project: 'p', request: 'HI-7/r15', kind: 'decide', gate: 'ask', text: `Which icon: the bee or the hive cell?\n\n${LONG}`, asker: 'Coder', since: '2026-10-29T01:00:00.000Z', for: 'user' as const }
  const gate = { ...asked, request: 'HI-7/r16', kind: 'approve', gate: 'okBefore', text: 'Approve the merge.', asker: null, since: '2026-10-29T02:00:00.000Z' }

  it('none: absent, so a card with none reads as before', () => {
    expect(cardRequests([])).toBeUndefined()
    expect(cardRequests([], true)).toBeUndefined()
  })

  it('each with its id, who asked, its words and when; Hive asked: no asker', () => {
    expect(cardRequests([asked, gate])).toEqual([
      { request: 'HI-7/r15', kind: 'decide', gate: 'ask', text: asked.text, asker: 'Coder', since: asked.since },
      { request: 'HI-7/r16', kind: 'approve', gate: 'okBefore', text: 'Approve the merge.', since: gate.since }
    ])
  })

  it("summary: its words cut as a comment's summary, with the whole length when cut", () => {
    const [q, g] = cardRequests([asked, gate], true)!
    expect(q).toMatchObject({ text: 'Which icon: the bee or the hive cell?', length: asked.text.length, asker: 'Coder', since: asked.since })
    expect(g.text).toBe('Approve the merge.')
    expect('length' in g).toBe(false)
  })
})

describe('projects and notes', () => {
  it('projects: one line each, with their agents', () => {
    const text = projectListText([
      { name: 'alpha', workspace: 'ws', active: true, branch: 'main', agents: [{ name: 'Coder', provider: 'claude-code', status: 'working', branch: null, backgroundTasks: 0 }, { name: 'Two', provider: 'codex', status: 'finished', branch: 'hive/two', backgroundTasks: 1 }] },
      { name: 'beta', workspace: 'ws', active: false, branch: null, agents: [] }
    ])
    expect(text.split('\n').slice(0, 2)).toEqual(['alpha (on, main): Coder [claude-code] working; Two [codex, hive/two] idle (1 background)', 'beta (off): no agents'])
  })

  it('a watching agent says what it waits for', () => {
    const text = projectListText([{ name: 'alpha', workspace: 'ws', active: true, branch: null, agents: [{ name: 'Rev', provider: 'codex', status: 'watching', branch: null, backgroundTasks: 0, watching: 'Waiting for #12 → Review' }] }])
    expect(text.split('\n')[0]).toBe('alpha (on): Rev [codex] waiting for #12 → Review')
  })

  it("an agent with an open progress run says what it's running, how far and the time left, briefly", () => {
    const label = progressLabel({ title: 'e2e: 12 suites', step: 4, total: 12, etaMs: 360_000 })
    expect(label).toBe('e2e: 12 suites 4/12, about 6 min left')
    expect(progressLabel({ title: 'build' })).toBe('build')
    expect(progressLabel({ title: 'tests', step: 1, total: 3, etaMs: 5000, stale: true })).toBe('tests 1/3, stopped reporting')
    expect(progressLabel({ title: 'y'.repeat(120) }).length).toBe(60)
    const text = projectListText([{ name: 'alpha', workspace: 'ws', active: true, branch: null, agents: [{ name: 'Alfie', provider: 'claude-code', status: 'working', branch: null, backgroundTasks: 0, progress: label }] }])
    expect(text.split('\n')[0]).toBe('alpha (on): Alfie [claude-code] working (running e2e: 12 suites 4/12, about 6 min left)')
  })

  it('projects from several workspaces name their workspace', () => {
    expect(projectListText([{ name: 'a', workspace: 'one', active: true, branch: null, agents: [] }, { name: 'b', workspace: 'two', active: true, branch: null, agents: [] }])).toMatch(/^one\/a \(on\): no agents\ntwo\/b/)
  })

  it("a project's status leaves out what its settings only repeat or keep for Hive (HI-1712)", () => {
    const status = { name: 'alpha', path: 'C:\\ws\\alpha', settings: { version: 2, chime: 'inherit', id: 'p-1', lastPath: 'C:\\ws\\alpha', stepsDone: ['a step'] } }
    expect(projectStatusReply(status)).toEqual({ name: 'alpha', path: 'C:\\ws\\alpha', settings: { chime: 'inherit', id: 'p-1' } })
    expect(projectStatusReply({ name: 'alpha' })).toEqual({ name: 'alpha' })
  })

  it('settings set to inherit come last under one line, without their value (HI-1712)', () => {
    const rows = [
      { id: 'project.chime', value: 'inherit', title: 'Completion chime', desc: 'Plays a sound.' },
      { id: 'project.loopWakes', value: 'on', title: 'Wake reviewers and builders', desc: 'Wakes them.' },
      { id: 'project.codex.permissionMode', value: 'inherit', readOnly: true as const, title: 'Permission mode', desc: 'How it asks.' },
      { id: 'project.fileLocks', value: 'inherit', title: 'File locks', desc: 'Locks files.' }
    ]
    expect(settingListText(rows)).toBe('project.loopWakes = on · Wake reviewers and builders\nproject.codex.permissionMode = inherit [read-only] · Permission mode\nSet to inherit:\nproject.chime · Completion chime\nproject.fileLocks · File locks')
    expect(settingListText(rows.slice(0, 2), { query: 'wake' })).toBe('project.loopWakes = on · Wake reviewers and builders: Wakes them.\nSet to inherit:\nproject.chime · Completion chime: Plays a sound.')
    expect(settingListText([rows[1]])).not.toContain('inherit')
  })

  it('notes: a flat list of paths with dates', () => {
    const text = notesListText([
      { relPath: 'handovers', isDir: true, children: [{ relPath: 'handovers/2026-10-01-a.md', isDir: false, modified: '2026-10-01T12:00:00.000Z' }] },
      { relPath: 'conventions.md', isDir: false }
    ])
    expect(text).toBe('handovers/2026-10-01-a.md (2026-10-01)\nconventions.md\n\ncw_read_shared_note reads one.')
    expect(notesListText([])).toBe('No shared notes yet.')
  })

  it('a note reads as its text, not a JSON string', () => {
    expect(noteText({ path: 'notes/a.md', content: '# A\n\n"quoted"' })).toBe('notes/a.md\n\n# A\n\n"quoted"')
  })

  it('a release that finds no hold says which slots the agent does hold or wait for, or that it has none (#586)', () => {
    expect(releaseText({ none: true, branch: 'feature', holder: null, yours: [{ branch: 'main', held: true }, { branch: 'release', held: false }] })).toBe("You don't hold the merge slot for feature (it is free). Yours: main (held), release (waiting); release with its branch.")
    expect(releaseText({ none: true, branch: 'feature', holder: null, yours: [] })).toBe("You don't hold the merge slot for feature (it is free). You hold and wait for no other merge slot of this project.")
  })
})

describe("cw_message_agent's queued reply (#1497)", () => {
  const queued = (tells: ('checkpoints' | 'stopContinuation' | 'idleWakes')[]) => messageQueuedText({ who: 'B1', id: 'm7', tied: '', status: 'working', queued: 2, tells })
  const said = (how: string) => `Queued for B1 (m7, working): ${how}; 2 waiting. cw_agent_activity says when it is received and acked.`
  it('names only the ways the carrying-on switches on for the agent tell it, in their order, for each combination', () => {
    const cases: [('checkpoints' | 'stopContinuation' | 'idleWakes')[], string][] = [
      [['checkpoints', 'stopContinuation', 'idleWakes'], "Combwork tells it at its next tool call, at its turn's end or once it is idle"],
      [['checkpoints', 'stopContinuation'], "Combwork tells it at its next tool call or at its turn's end"],
      [['checkpoints', 'idleWakes'], 'Combwork tells it at its next tool call or once it is idle'],
      [['stopContinuation', 'idleWakes'], "Combwork tells it at its turn's end or once it is idle"],
      [['checkpoints'], 'Combwork tells it at its next tool call'],
      [['stopContinuation'], "Combwork tells it at its turn's end"],
      [['idleWakes'], 'Combwork tells it once it is idle'],
      [[], 'it waits in its inbox until it reads it with cw_inbox (the user can Deliver Now)']
    ]
    for (const [tells, how] of cases) expect(queued(tells), tells.join('+') || 'none').toBe(said(how))
    // Given in any order, said in the switches' own.
    expect(queued(['idleWakes', 'checkpoints'])).toBe(said('Combwork tells it at its next tool call or once it is idle'))
  })
  it("says the card's round it is tied to", () => {
    expect(messageQueuedText({ who: 'B1', id: 'm7', tied: ', for HI-12 (#40) round 2', status: 'watching', queued: 1, tells: ['idleWakes'] })).toBe('Queued for B1 (m7, for HI-12 (#40) round 2, watching): Combwork tells it once it is idle; 1 waiting. cw_agent_activity says when it is received and acked.')
  })
})

describe('cw_notify (HI-1961)', () => {
  it('says what a click opens, only when the notice has a target', () => {
    expect(notifiedText({})).toBe('Notification shown.')
    expect(notifiedText({ opens: 'HB4' })).toBe('Notification shown; a click opens HB4.')
    expect(notifiedText({ opens: 'HI-12' })).toBe('Notification shown; a click opens HI-12.')
  })
})

// HI-2412: comments: 0 reads none of a card's comments (all counted), never falling back to every one.
describe('a card read narrowed to its newest comments', () => {
  const card = { comments: ['a', 'b', 'c'] }

  it('cw_read_task passes comments through whenever it is given, 0 included', () => {
    expect(readTaskQuery({ comments: 0 })).toBe('history=false&comments=0')
    expect(readTaskQuery({ comments: 2 })).toBe('history=false&comments=2')
    expect(readTaskQuery({ comments: 2.7, summary: true, attachments: true, history: true })).toBe('comments=2&summary=true&attachments=true')
    expect(readTaskQuery({})).toBe('history=false')
    // Not a number: passed on for the API to refuse, not dropped into a full read.
    expect(readTaskQuery({ comments: -1 })).toBe('history=false&comments=-1')
    expect(readTaskQuery({ comments: 'none' })).toBe('history=false&comments=none')
  })

  it('the API takes a whole number from 0 and refuses anything else', () => {
    expect(commentsParam(null)).toBeNull()
    expect(commentsParam('0')).toBe(0)
    expect(commentsParam('2')).toBe(2)
    for (const bad of ['-1', '1.5', '', 'none']) expect(commentsParam(bad)).toEqual({ error: `comments must be a whole number from 0: "${bad}"` })
  })

  it('0 keeps none and counts them all; a positive n keeps the newest n', () => {
    expect(newestComments(card, 0)).toEqual({ comments: [], commentsOmitted: 3 })
    expect(newestComments(card, 2)).toEqual({ comments: ['b', 'c'], commentsOmitted: 1 })
    expect(newestComments(card, 5)).toEqual({ comments: ['a', 'b', 'c'], commentsOmitted: 0 })
  })
})
