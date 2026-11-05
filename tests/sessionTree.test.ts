// The Sessions tab's tree (#239): provider → agent → session → its sub-sessions, newest first, with counts.
import { describe, expect, it } from 'vitest'
import { buildSessionTree, notFromAgent, countText, countsIn, pathTo, sessionsIn, type TreeNode } from '../src/shared/sessionTree'
import type { SessionListItem } from '../src/shared/types'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const item = (n: number, more: Partial<SessionListItem> = {}): SessionListItem => ({
  id: id(n),
  provider: 'claude-code',
  source: 'combwork',
  title: null,
  name: `S${n}`,
  lastActivity: `2026-10-0${Math.min(9, n)}T10:00:00.000Z`,
  hasTranscript: true,
  hasBackup: false,
  usage: null,
  recache: null,
  ...more
})
const agents = [
  { id: 'a-claude', name: 'Claude' },
  { id: 'a-codex', name: 'Codexette' }
]
const opts = { agents, byAgent: true, showArchived: false }
const labels = (nodes: readonly TreeNode[]): unknown[] => nodes.map((n) => (n.kind === 'session' ? n.item.name : [n.label, labels(n.children)]))

// Newest first, as session:list gives them.
const list: SessionListItem[] = [
  item(9, { provider: 'codex', agentId: 'a-codex', name: 'Codex work' }),
  item(8, { provider: 'codex', source: 'external', name: 'Review 1', sub: { parentId: id(9), kind: 'guardian review' } }),
  item(7, { provider: 'codex', source: 'external', name: 'Review 2', sub: { parentId: id(9), kind: 'guardian review' } }),
  item(6, { agentId: 'a-claude', name: 'Claude work' }),
  item(5, { agentId: 'a-gone', agentName: 'Coder', name: 'Old Coder work' }),
  item(4, { source: 'external', name: 'From VS Code' }),
  item(3, { provider: 'codex', source: 'external', name: 'Lost review', sub: { parentId: id(99), kind: 'guardian review' } }),
  item(2, { agentId: 'a-claude', name: 'Put away', archived: true }),
  item(1, { agentId: 'a-claude', name: 'First' })
]

describe('buildSessionTree', () => {
  it('groups by provider (descriptor order), then agent (project order, removed, then none); sub-sessions under their session', () => {
    expect(labels(buildSessionTree(list, opts))).toEqual([
      ['Claude Code', [['Claude', ['Claude work', 'First']], ['Coder (removed)', ['Old Coder work']], [notFromAgent(), ['From VS Code']]]],
      ['Codex', [['Codexette', ['Codex work']], [notFromAgent(), ['Lost review']]]]
    ])
    const codexWork = buildSessionTree(list, opts)[1].children[0].children[0]
    expect(codexWork.kind === 'session' && codexWork.children.map((c) => c.kind === 'session' && c.item.name)).toEqual(['Review 1', 'Review 2'])
  })
  it('a removed agent from before names were kept is "Removed agent"', () => {
    expect(labels(buildSessionTree([item(1, { agentId: 'a-old' })], opts))).toEqual([['Claude Code', [['Removed agent', ['S1']]]]])
  })
  it('marks orphans (parent not listed) and removed agents', () => {
    const tree = buildSessionTree(list, opts)
    const lost = tree[1].children[1].children[0]
    expect(lost.kind === 'session' && lost.orphan).toBe(true)
    const removed = tree[0].children[1]
    expect(removed.kind === 'agent' && removed.removed).toBe(true)
    const noAgent = tree[0].children[2]
    expect(noAgent.kind === 'agent' && noAgent.agentId).toBeNull()
  })
  it('archived sessions show with Archived, or when selected; their sub-sessions go with them', () => {
    const archivedParent = list.map((s) => (s.id === id(9) ? { ...s, archived: true } : s))
    expect(sessionsIn({ kind: 'provider', key: '', label: '', provider: 'codex', children: buildSessionTree(archivedParent, opts) }).map((s) => s.name)).not.toContain('Review 1')
    expect(labels(buildSessionTree(list, { ...opts, showArchived: true }))[0]).toEqual(['Claude Code', [['Claude', ['Claude work', 'Put away', 'First']], ['Coder (removed)', ['Old Coder work']], [notFromAgent(), ['From VS Code']]]])
    expect(JSON.stringify(labels(buildSessionTree(list, { ...opts, selectedId: id(2) })))).toContain('Put away')
  })
  it('search keeps matching sessions, and the session of a matching sub-session', () => {
    const match = (s: SessionListItem): boolean => /review 2|first/i.test(s.name ?? '')
    expect(labels(buildSessionTree(list, { ...opts, match }))).toEqual([
      ['Claude Code', [['Claude', ['First']]]],
      ['Codex', [['Codexette', ['Codex work']]]]
    ])
    const codexWork = buildSessionTree(list, { ...opts, match })[1].children[0].children[0]
    expect(codexWork.kind === 'session' && codexWork.children.map((c) => c.kind === 'session' && c.item.name)).toEqual(['Review 2'])
  })
  it("the Assistant's tree has no agent level", () => {
    expect(labels(buildSessionTree([item(2), item(1, { provider: 'codex' })], { ...opts, byAgent: false }))).toEqual([['Claude Code', ['S2']], ['Codex', ['S1']]])
  })
  it('a loop of parents loses no session', () => {
    const loop = [item(2, { sub: { parentId: id(1), kind: 'x' } }), item(1, { sub: { parentId: id(2), kind: 'x' } })]
    const all = buildSessionTree(loop, opts).flatMap(sessionsIn).map((s) => s.id)
    expect(all.sort()).toEqual([id(1), id(2)])
    expect(buildSessionTree([item(1, { sub: { parentId: id(1), kind: 'x' } })], opts).flatMap(sessionsIn)).toHaveLength(1)
  })
  it('deleted sessions (kept usage) never show', () => {
    expect(buildSessionTree([item(1, { deleted: true })], opts)).toEqual([])
  })
})

describe('counts and paths', () => {
  it('counts conversations and sub-sessions in a branch', () => {
    const tree = buildSessionTree(list, opts)
    expect(countsIn(tree[1])).toEqual({ sessions: 1, subs: 3 })
    expect(countsIn(tree[0])).toEqual({ sessions: 4, subs: 0 })
    expect(countText({ sessions: 1, subs: 3 })).toBe('1 session and 3 sub-sessions')
    expect(countText({ sessions: 2, subs: 0 })).toBe('2 sessions')
    expect(countText({ sessions: 0, subs: 1 })).toBe('1 sub-session')
  })
  it('the branches down to a session', () => {
    const tree = buildSessionTree(list, opts)
    expect(pathTo(tree, id(8))).toEqual(['p:codex', 'a:codex:a-codex', `s:${id(9)}`])
    expect(pathTo(tree, id(1))).toEqual(['p:claude-code', 'a:claude-code:a-claude'])
    expect(pathTo(tree, id(42))).toBeNull()
  })
})
