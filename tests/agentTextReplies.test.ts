// Agent text (dialects, HI-2065; HI-2435): the canary dialect over Combwork's tool replies (src/shared/toolReplies.ts, the
// `reply` area). Every word a reply builder says comes through the catalogue: run with every id's text wrapped in
// markers, no letter is left outside them but the values the test passed in, and every `reply.*` id shows in some
// reply. With no dialect, the replies read as they always did.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { setProcessChain, type DialectChain } from '../src/shared/agentText'
import { canaryProblems, canaryTexts } from '../src/shared/agentText/canary'
import * as R from '../src/shared/toolReplies'
import type { QueuePublic } from '../src/shared/workflow/queue'
import { columnLabel } from '../src/shared/tasks'
import { holderText, minutes, slotLine } from '../src/shared/mergeSlot'
import { idleWatchText } from '../src/shared/idleWatch'
import { unsubmittedText } from '../src/shared/unsubmitted'
import { shortDuration } from '../src/shared/progress'
// @ts-expect-error: a plain .mjs module without types
import { readCatalogue } from '../scripts/agentTextExtract.mjs'

const ROOT = join(__dirname, '..')
const catalogue = readCatalogue(ROOT) as Record<string, { text: string }>
const ids = new Set(Object.keys(catalogue))
const chain = (texts: Record<string, string>): DialectChain => ({ texts, files: ['test.json'], hash: 'test' })

afterEach(() => setProcessChain(null))

/** Values the samples pass: names, keys, paths and the like, which are the caller's words, not Combwork's. */
const VALUES = ['alpha', 'Coder', 'Codex', 'Lean replies', 'HI-12', 'main', 'feature/x', 'claude-code', 'builder', 'reviewer', 'lane-3f2a', 'notes/plan.md', 'm41', 'work-on-card', 'Carry a card', 'broken header', 'Commented', 'Moved to Review', 'cw_start_card', 'cw_submit', 'folder', 'files', 'base', 'greet.js', 'column', 'comment', 'Waiting for HI-12 → Review', 'waiting for HI-12 → Review', 'decision', 'sessions.compactAbove', 'Suggest compacting above', 'Settings → Sessions → Suggest compacting above', 'Einstellungen', 'on or off', 'Suggests compacting.', 'A tip.', 'when long', 'at the next launch', 'the user decides', 'User guide section', 'summary text', 'why text', 'detail text', 'abc1234', 'it was taken', 'B1', 'a-1', 'log', 'hello', 'conflict', 'paused for a conflict', 'src/a.ts', 'ours', 'merge', 'git merge --abort', 'git status', 'abort', 'check', 'checks', 'a step', 'timeout', 'Opus', 'opus', 'high', 'plan', 'acc', 'Work', 'Codex work', 'weekly', 'fiveHour', 'any', 'Sonnet', 'tpl', 'workspace', 'team.json', 'mergeMethod', 'squash', 'rebase', 'Review checks', 'pnpm build', 'Coder2', 'HB4', 'working', 'refused text', 'move.needsOverride', 'Do this next.', 'Change it there.', 'a warning', 'Watching HI-12', '5h', 'e2e', 'Watching lanes', 'HI-12 has a new decision', 'Coder: finished', 'pending reason', 'active', 'review', 'start', 'submit', 'beta', 'HI-13', 'HI-60', 'Other', 'Git', 'None', 'title', 'labels', 'Plan', 'lane line', 'failed', 'passed', 'Waiting for agents', 'ttl', 'slot-a', 'r1', 'h1', 'x', 'y']

/** Text other modules give the replies as values (shared/tasks.ts's column names, mergeSlot.ts, idleWatch.ts, unsubmitted.ts, progress.ts): not this area's. */
function foreign(): string[] {
  const holder = { id: 'h', kind: 'agent' as const, name: 'Coder', cards: [12], since: 0, until: 300000, taken: true }
  const split = (s: string | null): string[] => (s ?? '').split('\u0001')
  const list = [{ card: 12, count: 1, atLeast: false, since: 'abc1234' }]
  return [
    ...(['hold', 'todo', 'doing', 'review', 'passed', 'done'] as const).map(columnLabel),
    holderText(holder),
    slotLine({ project: 'alpha', branch: 'main', holder: null, waiting: [] }, 0),
    slotLine({ project: 'alpha', branch: 'main', holder: null, waiting: [{ agentId: 'a', name: 'Coder', cards: [], since: 0 }] }, 0),
    minutes(300000),
    idleWatchText({ number: 12 }),
    shortDuration(360000),
    ...split(unsubmittedText(list, '\u0001')),
    ...split(unsubmittedText([...list, list[0]], '\u0001')),
    unsubmittedText(list) ?? '',
    unsubmittedText([...list, list[0]]) ?? '',
    unsubmittedText([{ card: 12, count: 2, atLeast: true, since: 'abc1234' }]) ?? '',
    '1st',
    '2nd'
  ]
}

/** Every reply builder, in each of its cases. */
function replies(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const add = (name: string, text: string | { error: string } | number | null | unknown): void => {
    if (typeof text === 'string') out.push({ name, text })
    else if (text && typeof text === 'object' && 'error' in text) out.push({ name, text: String((text as { error: string }).error) })
  }
  add('checks isolated', R.checksView(['typecheck'], 'HI-12', true)?.checksHint)
  add('checks', R.checksView(['typecheck'], 'HI-12', false)?.checksHint)
  add('comments param', R.commentsParam('x'))
  const change = { number: 12, key: 'HI-12', title: 'Lean replies', column: 'review' as const, position: 1, of: 4, project: 'alpha', agent: 'Coder', changes: ['Commented', 'Moved to Review'] }
  add('created', R.createdText(change))
  add('created bare', R.createdText({ ...change, position: null, project: '', agent: null, changes: [] }))
  add('changed', R.changedText(change))
  add('changed none', R.changedText({ ...change, changes: [], project: '', agent: null }))
  for (const next of [{ step: 'intents', intents: ['start', 'submit'] }, { step: 'review' }, { step: 'user' }, { step: 'merge' }, { step: 'queue' }, { step: 'done' }] as never[])
    add(`intent ${JSON.stringify(next)}`, R.intentText({ ok: true, card: 'HI-12', from: 'active', to: 'review', data: { folder: 'x', files: Array.from({ length: 22 }, () => 'greet.js'), base: [] }, next, warnings: ['a warning'], lane: 'lane line' }))
  add('intent still', R.intentText({ ok: true, card: 'HI-12', from: 'review', to: 'review' }))
  add('intent done', R.intentText({ ok: true, card: 'HI-12', from: '', to: '' }))
  add('refused', R.refusedText({ refused: true, rule: 'move.needsOverride', message: 'refused text', next: 'Do this next.', change: 'Change it there.', override: null, warnings: ['a warning'] }))
  add('asked', R.askedAssistantText({ ok: true, card: 'HI-12', delivery: 'm41' }))
  add('asked none', R.askedAssistantText({ ok: true, card: 'HI-12', delivery: '' }))
  add('notified', R.notifiedText({}))
  add('notified opens', R.notifiedText({ opens: 'Coder' }))
  const groups = [{ group: 'm41', at: 'x', changes: [{ id: 'a-1', what: 'title', card: 12, fields: ['title'], undone: true as const }, { id: 'a-1', what: 'title', fields: [], final: 'it was taken' }, ...Array.from({ length: 41 }, (_, i) => ({ id: 'a-1', what: 'title', card: i + 1, fields: [] }))] }]
  add('changes group', R.changeListText(groups, 'm41'))
  add('changes no group', R.changeListText(groups, 'x'))
  add('changes none', R.changeListText([]))
  add('changes', R.changeListText([...groups, { group: 'm41', at: 'x', changes: [{ id: 'a-1', what: 'title', fields: [] }] }]))
  const undone = (o: Partial<R.UndoneListed>): R.UndoneListed => ({ change: 'a-1', what: 'title', undone: [], skipped: [], ...o })
  add('undo', R.undoText([undone({ already: true }), undone({ final: 'it was taken', card: 12 }), undone({ undone: ['title'] }), ...['changed', 'gone', 'ended', 'failed', 'x'].map((why) => undone({ undone: ['labels'], skipped: [{ field: 'title', why, error: 'x' }] })), ...Array.from({ length: 41 }, () => undone({ skipped: [{ field: 'title', why: 'gone' }] }))]))
  add('undo one', R.undoText([undone({ undone: ['title'] })]))
  add('batch', R.batchText({ changed: [change], refused: [{ number: 13, error: 'x' }, { number: 0, ref: 'HI-99', error: 'x' }, { number: 13, error: 'refused text', rule: 'move.needsOverride', next: 'Do this next.', change: 'Change it there.' }, { number: 13, error: 'HI-13 refused text', rule: 'move.needsOverride' }] }))
  add('batch none', R.batchText({ changed: [], refused: [] }))
  add('batch one', R.batchText({ changed: [change, change], refused: [] }))
  add('reorder', R.reorderText({ column: 'todo', top: [12], count: 3, lanes: [{ id: 'lane-3f2a', builder: 'Coder', cards: [12] }, { id: 'lane-3f2a', builder: 'Coder', cards: [12, 13] }] }))
  add('reorder one', R.reorderText({ column: 'todo', top: [12], count: 2 }))
  add('reorder all', R.reorderText({ column: 'todo', top: [12], count: 1 }))
  const row = (o: Partial<R.TaskRow>): R.TaskRow => ({ number: 12, key: 'HI-12', title: 'Lean replies', column: 'todo', project: 'alpha', agent: null, labels: [], blocked: null, blockedBy: [], stalled: null, comments: 0, archived: false, ...o })
  const rows = [
    ...['ready', 'finished', 'background', 'waiting', 'watching', 'signin', 'working'].map((status) => row({ agent: { name: 'Coder', status, backgroundTasks: 2 } })),
    row({ agent: { name: 'Coder', status: 'working', backgroundTasks: 1 }, labels: ['decision'], blocked: 'pending reason', blockedBy: [13, 60], elsewhere: [60], stalled: 'x', reviewing: { name: 'Codex', stalled: 'x' }, comments: 1 }),
    row({ column: 'review', reviewing: { name: 'Codex' }, comments: 3 })
  ]
  add('list', R.taskListText(rows))
  add('list page', R.taskListText(Array.from({ length: 250 }, () => row({})), { offset: 10 }))
  add('list archived', R.taskListText(rows, { archived: true }))
  add('list none', R.taskListText([]))
  add('list none archived', R.taskListText([], { archived: true }))
  add('list past', R.taskListText(rows, { offset: 99 }))
  add('progress', R.progressLabel({ title: 'e2e', step: 4, total: 12, etaMs: 360000 }))
  add('progress stale', R.progressLabel({ title: 'e2e', stale: true }))
  add('progress bare', R.progressLabel({ title: 'e2e' }))
  const project = (o: Partial<R.ProjectRow>): R.ProjectRow => ({ name: 'alpha', workspace: 'Work', active: true, branch: 'main', agents: [], ...o })
  add('projects', R.projectListText([project({}), project({ workspace: 'Other', active: false, branch: null, agents: [{ name: 'Coder', provider: 'claude-code', workflowRole: 'builder', status: 'ready', branch: 'main', backgroundTasks: 2, progress: 'e2e' }, { name: 'Codex', provider: 'codex', status: 'watching', branch: null, backgroundTasks: 0, watching: 'Waiting for HI-12 → Review' }] })]))
  add('projects none', R.projectListText([]))
  add('notes', R.notesListText([{ relPath: 'notes/plan.md', isDir: false, modified: '2026-10-01T00:00:00Z' }]))
  add('notes none', R.notesListText([]))
  add('note', R.noteText({ path: 'notes/plan.md', content: 'x', revision: 'abc1234' }))
  add('note bare', R.noteText({ path: 'notes/plan.md', content: 'x' }))
  for (const append of [true, false]) for (const rev of ['abc1234', undefined]) add(`written ${append} ${rev}`, R.noteWrittenText('notes/plan.md', 1234, append, rev))
  const h = (level: number, size: number): R.DocHeadingRow => ({ level, text: 'Plan', slug: 'plan', size })
  add('outline', R.docOutlineText({ path: 'notes/plan.md', size: 56000, headings: Array.from({ length: 201 }, (_, i) => h(1 + (i % 3), 3200)) }))
  add('outline none', R.docOutlineText({ path: 'notes/plan.md', size: 840, headings: [] }))
  add('section', R.docSectionText({ path: 'notes/plan.md', heading: h(2, 1200), content: 'x' }))
  add('section whole', R.docSectionText({ path: 'notes/plan.md', content: 'x', size: 1200 }))
  add('section long', R.docSectionText({ path: 'notes/plan.md', heading: h(2, 1200), content: 'x', partial: true, subsections: [h(3, 400)] }))
  for (const kind of ['image', 'pdf', 'binary'] as const) add(`attachment ${kind}`, R.attachmentText({ name: 'greet.js', file: 'x', size: 2048, kind, path: 'notes/plan.md' }))
  add('attachment text', R.attachmentText({ name: 'greet.js', file: 'x', size: 2048, kind: 'text', offset: 0, content: 'x', next: 1024 }))
  add('attachment whole', R.attachmentText({ name: 'greet.js', file: 'x', size: 2048, kind: 'text', offset: 0, content: 'x' }))
  const skill = (o: Partial<R.SkillRow>): R.SkillRow => ({ name: 'work-on-card', description: 'Carry a card', level: 'hive', ...o })
  add('skills', R.skillListText([skill({ audience: 'agents' }), skill({ audience: 'assistant', level: 'machine' }), skill({ audience: 'all', level: 'plugin', plugin: 'x' }), skill({ problem: 'broken header', level: 'local', description: '' })]))
  add('skills none', R.skillListText([]))
  const wc = (o: Partial<R.WaitChange>): R.WaitChange => ({ number: 12, column: 'review', changes: ['column', 'comment'], by: 'Coder', comment: { by: 'Coder', firstLine: 'hello' }, ...o })
  add('wait lane', R.taskWaitText({ watching: 'Watching lanes', events: ['failed', 'passed'], limitAt: 'x', replaced: 'Waiting for HI-12 → Review', cards: { now: [12], kept: true, replaced: [13], dropped: [60], inLanes: [12] }, agents: { now: ['Coder'], kept: true, already: ['Coder: finished'] } }))
  add('wait lane plain', R.taskWaitText({ watching: 'Watching lanes', events: [], cards: { now: [], replaced: [13], inLanes: [12, 13] } as never }))
  add('wait idle', R.taskWaitText({ watching: 'Watching HI-12', idle: 12, lanesLeft: ['lane-3f2a'] }))
  add('wait', R.taskWaitText({ watching: 'Watching HI-12', limitAt: 'x', lanesLeft: ['lane-3f2a', 'lane-3f2a'] }))
  add('wait unsubmitted', R.taskWaitText({ watching: 'Watching HI-12', unsubmitted: [{ card: 12, count: 1, atLeast: false, since: 'abc1234' }] as never }))
  add('wait already', R.taskWaitText({ already: wc({}), unsubmitted: [{ card: 12, count: 2, atLeast: true, since: 'abc1234' }] as never }))
  add('wait already gone', R.taskWaitText({ already: wc({ changes: 'gone', comment: null, archived: true }) }))
  add('wait usage', R.taskWaitText({ usageAlready: ['x', 'y'], replaced: 'Waiting for HI-12 → Review' }))
  add('wait changes', R.taskWaitText({ changes: [wc({}), wc({ changes: 'gone', comment: null, by: null }), wc({ by: null, comment: null })], since: 'x' }))
  add('wait none', R.taskWaitText({ timedOut: true, since: 'x' }))
  add('wait done', R.taskWaitText({ done: 'x' }))
  add('agents watch', R.agentWatchText({ watching: 'Waiting for agents', limitAt: 'x', replaced: 'Waiting for HI-12 → Review', dropped: ['Codex'] }))
  add('agents watch lanes', R.agentWatchText({ watching: 'Waiting for agents', lanesLeft: ['lane-3f2a'] }))
  add('agents already', R.agentWatchText({ already: ['Coder: finished'], replaced: 'Waiting for HI-12 → Review', dropped: ['Codex'] }))
  const setting = (o: Partial<R.SettingRow>): R.SettingRow => ({ id: 'sessions.compactAbove', title: 'Suggest compacting above', value: 'on', desc: 'Suggests compacting.', ...o })
  add('settings', R.settingListText([setting({ default: 'off', readOnly: true }), setting({ value: 'inherit' }), ...Array.from({ length: 200 }, () => setting({}))], { query: 'x' }))
  add('settings none', R.settingListText([]))
  add('settings no match', R.settingListText([], { query: 'x' }))
  const detail: R.SettingDetail = { id: 'sessions.compactAbove', title: 'Suggest compacting above', path: 'Settings → Sessions → Suggest compacting above', shownAs: 'Einstellungen', scope: 'workspace', project: 'alpha', value: 'on', default: 'off', takes: 'on or off', desc: 'Suggests compacting.', tip: 'A tip.', helps: 'when long', restart: 'at the next launch', readOnly: 'the user decides', docs: 'User guide section' }
  add('setting', R.settingText(detail))
  add('setting default', R.settingText({ ...detail, value: 'off', project: undefined }))
  add('setting changed', R.settingChangedText({ title: 'x', id: 'sessions.compactAbove', path: 'Settings → Sessions → Suggest compacting above', project: 'alpha', old: 'on', new: 'off', restart: 'at the next launch' }))
  add('setting changed now', R.settingChangedText({ title: 'x', id: 'sessions.compactAbove', path: 'Settings → Sessions → Suggest compacting above', old: 'on', new: 'off' }))
  add('setting same', R.settingChangedText({ title: 'x', id: 'sessions.compactAbove', path: 'Settings → Sessions → Suggest compacting above', project: 'alpha', old: 'on', new: 'on' }))
  const entry = (o: Partial<R.JournalEntryDetail>): R.JournalEntryDetail => ({ id: 12, at: '2026-10-18T00:00:00Z', kind: 'decision', project: 'alpha', summary: 'summary text', importance: 3, source: 'hive', supersededBy: 13, hasDetail: true, detail: 'detail text', why: 'why text', digestOf: 'x', updatedAt: 'x', links: [{ type: 'card', ref: '12' }], tags: ['lane'], supersedes: [1], ...o })
  add('recall', R.journalRecallText([entry({}), entry({ importance: 2, source: 'agent', hasDetail: false, supersededBy: null, project: null })]))
  add('recall none', R.journalRecallText([]))
  add('recall no match', R.journalRecallText([], 'x'))
  add('entry', R.journalEntryText(entry({})))
  add('entry bare', R.journalEntryText(entry({ project: null, source: 'agent', updatedAt: null, why: null, detail: null, digestOf: null, links: [], tags: [], supersededBy: null, supersedes: [] })))
  const holder = { id: 'h', kind: 'agent' as const, name: 'Coder', cards: [12], since: 0, until: 300000, taken: true }
  const lost = { branch: 'main', why: 'ttl' }
  add('claim held', R.claimText({ held: true, branch: 'main', until: 300000, extended: true, lost }, 0))
  add('claim gone', R.claimText({ held: false, branch: 'main' }, 0))
  add('claim waiting', R.claimText({ held: false, branch: 'main', position: 2, holder }, 0))
  add('release', R.releaseText({ branch: 'main', released: true, next: 'Codex', lost }))
  add('release left', R.releaseText({ branch: 'main', left: true }))
  add('release none', R.releaseText({ branch: 'main', holder, yours: [{ branch: 'feature/x', held: true }, { branch: 'feature/x', held: false }] }))
  add('release free', R.releaseText({ branch: 'main' }))
  add('slot', R.mergeSlotText({ branch: 'main', holder: null, waiting: [{ name: 'Coder' }] } as never, 0))
  add('slot quiet', R.mergeSlotText({ branch: 'main', holder: null, waiting: [] } as never, 0))
  const source: R.ConsoleSourceRow = { label: 'B1', kind: 'agent', select: { agent: 'a-1', project: 'alpha' }, provider: 'claude-code', capturing: true, events: 3 }
  add('sources', R.consoleSourcesText({ total: 5, offset: 0, sources: [source, { ...source, capturing: false, provider: undefined }] }))
  add('sources none', R.consoleSourcesText({ total: 0, offset: 0, sources: [] }))
  const ev: R.ConsoleEventRow = { seq: 1, at: '2026-10-18T12:00:00Z', kind: 'log', name: 'x', summary: 'hello', truncated: true }
  add('events', R.consoleEventsText({ source, events: [ev], newer: 2, newest: 1 }))
  add('events older', R.consoleEventsText({ source, events: [ev], older: 2, newest: 1 }))
  add('events none', R.consoleEventsText({ source, events: [], newest: 3 }))
  add('events none yet', R.consoleEventsText({ source, events: [] }))
  add('events off', R.consoleEventsText({ source: { ...source, capturing: false }, events: [] }))
  add('events missing', R.consoleEventsText({ source, events: [], missing: [4] }))
  const queue = (o: Partial<QueuePublic>): QueuePublic => ({ project: 'alpha', target: 'main', paused: null, runBy: null, runHere: true, testing: null, queued: [], recent: [], ...o }) as QueuePublic
  const stuck = { phase: 'merge', branch: 'main', ref: 'abc1234', expected: 'abc1234', result: null, files: Array.from({ length: 6 }, () => ({ path: 'src/a.ts', side: 'ours' })), commands: [{ purpose: 'abort', place: 'project', command: 'git merge --abort' }, { purpose: 'check', place: 'target', command: 'git status' }] }
  add('queue paused', R.queueText(queue({ paused: { reason: 'paused for a conflict', by: 'user', card: 'HI-12', files: ['src/a.ts'], stuck } as never })))
  add('queue paused assistant', R.queueText(queue({ paused: { reason: 'paused for a conflict', by: 'assistant', files: [], stuck: { ...stuck, branch: null, files: [], commands: [] } } as never })))
  add('queue paused bare', R.queueText(queue({ paused: { reason: 'paused for a conflict', files: [] } as never })))
  add('queue run by', R.queueText(queue({ runBy: 'HB4', runHere: false })))
  add('queue running', R.queueText(queue({ testing: { key: 'HI-12', title: 'Lean replies', revision: 'abc1234', step: 'checks' }, queued: Array.from({ length: 6 }, () => ({ key: 'HI-13', title: 'Lean replies' })), recent: [{ key: 'HI-12', outcome: 'merged', result: 'abc1234', by: 'outside' }, { key: 'HI-12', outcome: 'returned', reason: 'conflict', transient: true, files: ['src/a.ts'] }, { key: 'HI-12', outcome: 'cancelled', reason: 'conflict' }] } as never)))
  add('queue testing', R.queueText(queue({ testing: { key: 'HI-12', title: 'Lean replies', revision: 'abc1234' }, queued: [{ key: 'HI-13', title: 'Lean replies' }] } as never)))
  add('queue empty', R.queueText(queue({})))
  add('queues none', R.queuesText([], 'alpha'))
  add('queue resumed', R.queueResumedText({ resumed: false, queue: queue({}) }))
  const team: R.TeamPublic = { paused: true, pausedBy: null, since: null, parked: false, safeToInstall: false, running: [{ project: 'alpha', agent: 'Coder', state: 'unknown', what: 'working' }, { project: '', agent: '', state: 'running', what: 'e2e' }], others: [] }
  add('team', R.teamText(team))
  add('team parked', R.teamText({ ...team, parked: true, safeToInstall: true, running: Array.from({ length: 201 }, () => team.running[1]) }))
  add('team not paused', R.teamText({ ...team, paused: false, running: [] }))
  add('releasable', R.releasableText({ project: 'alpha', carried: [{ slot: 'slot-a', agent: 'Coder' }], held: [{ slot: 'slot-a', agent: 'Coder', run: 'x', hive: 'y', processes: { list: Array.from({ length: 6 }, () => ({ pid: 1, label: 'e2e' })), more: 1 } }, { slot: 'slot-a', agent: 'Coder', run: 'x', hive: 'y', processes: null }] }))
  add('releasable few', R.releasableText({ project: 'alpha', carried: [], held: [{ slot: 'slot-a', agent: 'Coder', run: 'x', hive: 'y', processes: { list: [{ pid: 1, label: 'e2e' }], more: 0 } }] }))
  add('releasable none', R.releasableText({ project: 'alpha', carried: [], held: [] }))
  add('released carried', R.slotReleasedText({ project: 'alpha', kind: 'carried', slot: 'slot-a', agent: 'Coder' }))
  add('released writer', R.slotReleasedText({ project: 'alpha', kind: 'writer', slot: 'slot-a', agent: 'Coder', ended: true }))
  const conn: R.ConnectionPublic = { id: 'x', name: 'Opus', account: 'acc', cli: 'claude-code', model: 'opus', effort: 'high', context200k: true, mode: 'plan', extraArgs: 'x', tag: 'Builders' }
  const usage: R.AccountUsagePublic[] = [{ account: 'acc', limits: [{ label: '5h', usedPercent: 40, resetsAt: '2026-10-18T12:00:00Z' }, { label: '5h', usedPercent: 40, resetsAt: null }], move: { percent: 90, limit: 'weekly', to: 'Sonnet' } }, { account: 'acc', limits: [], move: { percent: 90, limit: 'fiveHour', to: 'Sonnet' } }, { account: 'acc', limits: [], move: { percent: 90, limit: 'any', to: 'Sonnet' } }]
  add('connections', R.connectionListText({ connections: [conn, { id: 'x', name: 'Opus', account: 'acc', cli: null, usable: false }], accounts: [{ id: 'x', name: 'Work', cli: 'codex', on: false }, { id: 'x', name: 'Work2', cli: 'codex' }], usage }))
  add('connections none', R.connectionListText({ connections: [], accounts: [] }))
  add('connection made', R.connectionChangedText('Made', conn))
  add('connection changed', R.connectionChangedText('Changed', conn))
  add('templates', R.templateListText({ project: 'alpha', templates: [{ scope: 'workspace', from: 'x', file: 'team.json', name: 'tpl', agents: 2, workflow: ['Git', 'None', 'x'], problem: 'x' }, { scope: 'workspace', file: 'team.json', name: 'tpl', agents: 2, workflow: [] }] }))
  add('templates none', R.templateListText({ project: 'alpha', templates: [] }))
  const wf = { platform: 'Git', applies: true, needsGit: false, dropped: [], changes: [{ key: 'mergeMethod', now: 'squash', next: 'rebase' }], missingCommands: ['Review checks'], identityOff: true, problems: [] }
  const plan: R.TemplatePlanPublic = { project: 'alpha', template: { scope: 'workspace', file: 'team.json', name: 'tpl' }, remove: ['Coder'], create: [{ name: 'Coder2', template: 'Coder', role: 'builder', connection: 'Opus', pairedWith: 'Codex' }, { name: 'Codex', template: 'Codex', role: 'reviewer', connection: null }], taken: [{ name: 'Coder', project: 'beta', suggestion: 'Coder2' }], options: [{ id: 'x', name: 'Opus', cli: 'claude-code', account: 'acc' }], blocked: ['x'], workflow: wf }
  add('plan', R.templatePlanText(plan))
  add('plan bare', R.templatePlanText({ ...plan, remove: [], taken: [], options: [], blocked: [], workflow: { ...wf, changes: [], missingCommands: [], identityOff: false } }))
  add('plan git only', R.templatePlanText({ ...plan, workflow: { ...wf, applies: false, needsGit: true } }))
  add('plan dropped', R.templatePlanText({ ...plan, workflow: { ...wf, applies: false, dropped: ['Git'] } }))
  const load: R.TemplateLoadPublic = { project: 'alpha', template: { scope: 'workspace', file: 'team.json', name: 'tpl' }, removed: ['Coder'], created: ['Coder2'], renamed: [{ template: 'Coder', name: 'Coder2' }], connections: [{ name: 'Coder2', connection: 'Opus' }], workflow: { ...wf, saved: true } }
  add('loaded', R.templateLoadedText(load))
  add('loaded not saved', R.templateLoadedText({ ...load, removed: [], renamed: [], connections: [], workflow: { ...wf, notSaved: 'x' } }))
  add('loaded none', R.templateLoadedText({ ...load, workflow: { ...wf } }))
  add('applied', R.connectionsAppliedText({ project: 'alpha', changed: [{ name: 'Coder', connection: 'Opus' }], restart: ['Coder'], skipped: [{ name: 'Codex', why: 'x' }] }))
  add('applied none', R.connectionsAppliedText({ project: 'alpha', changed: [], restart: [], skipped: [] }))
  add('queued all', R.messageQueuedText({ who: 'Coder', id: 'm41', tied: '', status: 'working', queued: 1, tells: ['checkpoints', 'stopContinuation', 'idleWakes'] }))
  add('queued one', R.messageQueuedText({ who: 'Coder', id: 'm41', tied: '', status: 'working', queued: 1, tells: ['idleWakes'] }))
  add('queued none', R.messageQueuedText({ who: 'Coder', id: 'm41', tied: '', status: 'working', queued: 1, tells: [] }))
  return out
}

describe('the canary dialect over the tool replies (HI-2435)', () => {
  it('finds every word of them in the catalogue, and every reply text in some reply', () => {
    setProcessChain(chain(canaryTexts(catalogue)))
    const seen = new Set<string>()
    const values = [...VALUES, ...foreign()]
    for (const { name, text } of replies()) {
      expect(canaryProblems(text, ids, values), name).toEqual([])
      for (const m of text.matchAll(/⟦([^/⟧][^⟧]*)⟧/g)) seen.add(m[1])
    }
    const area = [...ids].filter((id) => id.startsWith('reply.'))
    expect(area.length).toBeGreaterThan(200)
    expect(area.filter((id) => !seen.has(id))).toEqual([])
  })

  it('reads as it always did with no dialect', () => {
    // As tests/toolReplies.test.ts and the replies' own suites expect them.
    expect(R.notifiedText({ opens: 'HB4' })).toBe('Notification shown; a click opens HB4.')
    expect(R.reorderText({ column: 'todo', top: [12], count: 3 })).toBe('Todo now starts #12; its other 2 cards keep their order below.')
    expect(R.noteWrittenText('notes/plan.md', 12345, false, 'abc')).toBe('Wrote notes/plan.md (12,345 characters, revision abc).')
    expect(R.undoText([{ change: 'a-1', what: 'title', undone: ['title'], skipped: [] }])).toBe('Undid 1 of 1 change in full.')
    expect(R.releasableText({ project: 'alpha', carried: [], held: [{ slot: 'slot-a', agent: 'Coder', run: 'r1', hive: 'h1', processes: null }] })).toBe('slot-a: held by Coder\'s ended run r1, its Combwork h1 (kind writer, confirm {"slot":"slot-a","run":"r1"}). Combwork doesn\'t know which of its processes still run.')
    expect(R.checksView(['typecheck'], 'HI-12', true)?.checksHint).toBe('before review: run one with cw-progress --check <name> --card "HI-12" (--isolated: in a check copy at the card\'s revision; work-on-card)')
  })
})
