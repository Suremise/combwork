import { describe, expect, it } from 'vitest'
import type { ConsoleEvent, ConsoleSource } from '../src/shared/devConsole'
import { clockTime, filterChoices, filterEvents, mergeEvents, NO_FILTER, sourceGroups, sourceOption, startsOpen } from '../src/shared/consoleView'

const ev = (seq: number, over: Partial<ConsoleEvent> = {}): ConsoleEvent => ({ seq, at: '2026-10-12T09:15:04.020Z', source: 's', kind: 'hook', name: 'PreToolUse', summary: 'PreToolUse (Edit) → toolStart; working', bytes: 10, ...over })

describe('mergeEvents', () => {
  it('appends events in order', () => {
    expect(mergeEvents([ev(1), ev(2)], [ev(3), ev(4)]).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it("keeps each event once when a resume's snapshot overlaps live deliveries, in seq order", () => {
    expect(mergeEvents([ev(1), ev(3), ev(4)], [ev(2), ev(3), ev(5)]).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the newest within its bound', () => {
    const list = Array.from({ length: 10 }, (_, i) => ev(i + 1))
    expect(mergeEvents(list, [ev(11), ev(12)], 5).map((e) => e.seq)).toEqual([8, 9, 10, 11, 12])
  })

  it('returns the same list when nothing is added', () => {
    const list = [ev(1)]
    expect(mergeEvents(list, [])).toBe(list)
  })
})

describe('filterEvents', () => {
  const list = [
    ev(1, { kind: 'launch', name: 'launch', provider: 'claude-code', summary: 'Claude Code 2.1 started' }),
    ev(2, { kind: 'hook', name: 'SessionStart', provider: 'claude-code', summary: 'SessionStart → start; ready' }),
    ev(3, { kind: 'hook', name: 'PreToolUse', provider: 'codex', raw: { tool_name: 'apply_patch' } }),
    ev(4, { kind: 'api', name: 'GET /v1/status', summary: 'GET /v1/status by agent B1 → 200 ok' })
  ]
  const seqs = (f: Partial<typeof NO_FILTER>): number[] => filterEvents(list, { ...NO_FILTER, ...f }).map((e) => e.seq)

  it('shows everything with no filter', () => expect(seqs({})).toEqual([1, 2, 3, 4]))
  it('by event type', () => expect(seqs({ hiddenKinds: new Set(['hook']) })).toEqual([1, 4]))
  it('by provider', () => expect(seqs({ provider: 'codex' })).toEqual([3]))
  it("by search, in an event's name, summary or payload, ignoring case", () => {
    expect(seqs({ search: 'sessionstart' })).toEqual([2])
    expect(seqs({ search: 'B1' })).toEqual([4])
    expect(seqs({ search: 'APPLY_PATCH' })).toEqual([3])
    expect(seqs({ search: '  ' })).toEqual([1, 2, 3, 4])
  })
  it('clear hides what came before it', () => expect(seqs({ afterSeq: 2 })).toEqual([3, 4]))
  it('filters together', () => expect(seqs({ provider: 'claude-code', hiddenKinds: new Set(['launch']), search: 'start' })).toEqual([2]))

  it("offers the events' kinds and providers", () => {
    expect(filterChoices(list)).toEqual({ kinds: ['api', 'hook', 'launch'], providers: ['claude-code', 'codex'] })
  })
})

describe('sourceGroups', () => {
  const src = (over: Partial<ConsoleSource>): ConsoleSource => ({ id: over.label ?? 'x', kind: 'session', label: 'x', workspacePath: 'C:\\ws', capturing: false, events: 0, ...over })
  it('Hive and its Assistant first, then each project by name with its agents by name', () => {
    const groups = sourceGroups([
      src({ label: 'beta · B10', project: 'beta', agent: 'B10' }),
      src({ label: 'Hive Assistant', kind: 'assistant' }),
      src({ label: 'beta · B2', project: 'beta', agent: 'B2' }),
      src({ label: 'alpha · B1', project: 'alpha', agent: 'B1' }),
      src({ label: 'Hive', kind: 'hive' })
    ])
    expect(groups.map((g) => [g.label, g.sources.map((s) => s.label)])).toEqual([
      ['Hive', ['Hive', 'Hive Assistant']],
      ['alpha', ['alpha · B1']],
      ['beta', ['beta · B2', 'beta · B10']]
    ])
  })

  it("names an agent's session by the agent, with its events when it has some", () => {
    expect(sourceOption(src({ label: 'alpha · B1', project: 'alpha', agent: 'B1' }))).toBe('B1')
    expect(sourceOption(src({ label: 'Hive', kind: 'hive', events: 12 }))).toBe('Hive (12)')
    expect(sourceOption(src({ label: 'Assistant', kind: 'assistant' }))).toBe('Assistant')
  })
})

describe('payloads and times', () => {
  it('a large payload starts collapsed below its top level', () => {
    const big = { text: 'x'.repeat(2000) }
    expect(startsOpen(big, 0)).toBe(true)
    expect(startsOpen(big, 1)).toBe(false)
    expect(startsOpen({ a: 1 }, 3)).toBe(true)
  })

  it('times to the millisecond, local', () => {
    const at = new Date(2026, 9, 12, 9, 5, 4, 20).toISOString()
    expect(clockTime(at)).toBe('09:05:04.020')
    expect(clockTime('nonsense')).toBe('')
  })
})
