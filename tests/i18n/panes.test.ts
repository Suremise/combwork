import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { fmt, setLanguage, tr } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { runtimeLabel, unknownStateText } from '../../src/shared/runtime'
import { safeguardText, type SafeguardNote } from '../../src/shared/safeguards'
import { leftoversSummary, processCount } from '../../src/shared/agentProcesses'
import { agentLimitLine, agentPart, agentWatchLabel, watchText } from '../../src/shared/agentWatch'
import { watchLabel } from '../../src/shared/watch'
import { laneWatchLabel } from '../../src/shared/laneWatch'
import { waitingFor } from '../../src/shared/agentTable'
import type { LiveSessionState } from '../../src/shared/types'

// #799: the `panes` area (agents' panes, their footer and terminal, the agents tables). What the window shows of an
// agent is in the user's language; what agents and the Agent API read of the same state (its unknown state, watch
// labels, wake lines, a safeguard comment on its card) stays English, and in English both read the same.

const ROOT = resolve(__dirname, '../..')

afterEach(() => setLanguage('en', {}))

/** Text the pseudo-locale made: in brackets, with no plain English word left in it. */
const pseudo = (s: string): boolean => s.includes('[') && !/\b(?:the|and|of|on|for|is|to|its|it|min|state|waiting|process|processes|lane|lanes|finish)\b/.test(s)

const unit = (l: string[]): string => fmt.list(l, 'unit')
const NOW = Date.parse('2026-10-14T12:00:00Z')
const silent = { turn: { state: 'unknown', id: 't', silentSince: new Date(NOW - 23 * 60_000).toISOString() } } as unknown as LiveSessionState
const notes: SafeguardNote[] = [
  { at: '2026-10-14T15:12:00', model: 'opus', tools: ['Bash', 'Edit'], stops: 1 },
  { at: '2026-10-14T15:12:00', tools: [], stops: 3, prompt: true },
  { at: '2026-10-14T15:12:00', model: 'opus', tools: ['Bash'], stops: 2, idle: true, switched: { from: 'opus', to: 'sonnet', at: '2026-10-14T15:13:00' } },
  { at: '2026-10-14T15:12:00', tools: ['Bash'], stops: 0, switched: { from: 'opus', to: 'sonnet', at: '2026-10-14T15:13:00' } }
]
const label = (m: string): string => m[0].toUpperCase() + m.slice(1)
const watches = [
  { cards: [], agents: ['B6'] },
  { cards: [], agents: ['B6', 'B7'] },
  { cards: [12], column: 'review' as const },
  { cards: [506, 509] },
  { cards: [], lanes: ['all'] },
  { cards: [4], lanes: ['l-1'] },
  { cards: [], lanes: ['l-1', 'l-2'] }
]
/** The English label agents read for each watch above. */
const agentLabel = (w: (typeof watches)[number]): string =>
  w.agents ? agentWatchLabel({ agents: w.agents.map((name) => ({ name, project: 'hive', id: name })) } as never) : w.lanes ? laneWatchLabel({ ids: w.lanes[0] === 'all' ? 'all' : w.lanes, events: [] }, w.cards) : watchLabel({ cards: w.cards, column: w.column })

describe('the panes area', () => {
  it('locales/en/panes.json has a note for translators on every message', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/panes.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en).length).toBeGreaterThan(50)
    for (const [id, m] of Object.entries(en)) {
      expect(id.startsWith('panes.'), id).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
  })

  it("in English, the window's words for an agent read as the Agent API's and agents' do", () => {
    expect(unknownStateText(silent, NOW, tr)).toBe(unknownStateText(silent, NOW))
    expect(unknownStateText(silent, NOW)).toBe('Silent 23 min · state unknown')
    for (const n of notes) expect(safeguardText(n, label, tr)).toBe(safeguardText(n, label))
    for (const n of [1, 2, 7]) expect(processCount(n, tr)).toBe(processCount(n))
    const left = { processes: ['a', 'b', 'b', 'c', 'd', 'e', 'f'].map((l, i) => ({ pid: i, name: 'node.exe', label: l, created: '' })), more: 2 } as never
    // Hive's English lists are British (no serial comma), as the window's are with Windows set to en-GB.
    setLanguage('en', {}, 'en-GB')
    expect(leftoversSummary(left, 4, { tr, list: fmt.list })).toBe(leftoversSummary(left, 4))
    expect(leftoversSummary(left, 4)).toBe('a, 2 × b, c, d and 4 more processes')
    // In another language: its counts, its plural and its list.
    setLanguage('pl', { 'session.leftovers.times': '{n, number} × {label}', 'session.leftovers.more': '{n, plural, one {jeszcze # proces} few {jeszcze # procesy} many {jeszcze # procesów} other {jeszcze # procesu}}' }, 'pl-PL')
    expect(leftoversSummary(left, 4, { tr, list: fmt.list })).toBe('a, 2 × b, c, d i jeszcze 4 procesy')
    setLanguage('en', {})
    for (const w of watches) {
      expect(watchText(w, tr, unit)).toBe(agentLabel(w))
      expect(watchText(w, tr, unit, 'cell')).toBe(waitingFor({ label: agentLabel(w) }))
    }
  })

  it("an agent's status words: one message each, with its own words where it has them", () => {
    const st = (over: object): LiveSessionState => ({ runtime: { lifecycle: 'running', attention: 'none', maintenance: 'none' }, turn: { state: 'running', id: 't' }, ...over }) as unknown as LiveSessionState
    expect(runtimeLabel(st({ runtime: { lifecycle: 'stopped' } }))).toBe('Stopped')
    expect(runtimeLabel(st({ runtime: { lifecycle: 'running', attention: 'waiting' } }))).toBe('Needs your input')
    expect(runtimeLabel(st({ runtime: { lifecycle: 'running', attention: 'waiting' }, statusMessage: 'Allow Bash?' }))).toBe('Allow Bash?')
    expect(runtimeLabel(st({}))).toBe('Working…')
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const over of [{ runtime: { lifecycle: 'stopped' } }, { runtime: { lifecycle: 'starting' } }, { runtime: { lifecycle: 'signin' } }, {}]) expect(pseudo(runtimeLabel(st(over))!), JSON.stringify(over)).toBe(true)
  })

  it('under the pseudo-locale, the window words translate and what agents read stays English', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const window = [unknownStateText(silent, NOW, tr)!, ...notes.map((n) => safeguardText(n, label, tr)), processCount(2, tr), ...watches.flatMap((w) => [watchText(w, tr, unit), ...(w.column || w.agents || w.lanes ? [watchText(w, tr, unit, 'cell')] : [])])]
    for (const t of window) expect(pseudo(t), t).toBe(true)
    expect(unknownStateText(silent, NOW)).toBe('Silent 23 min · state unknown')
    expect(safeguardText(notes[1], label)).toBe('A safety classifier stopped a response at 15:12 (3 this session). Its CLI asks what to do about it.')
    expect(agentPart({ name: 'B6', project: 'hive' }, 'stopped', { status: 'stopped' } as never)).toBe('B6 (hive) stopped')
    expect(agentLimitLine({ agents: [{ name: 'B6', project: 'hive', id: 'x' }] } as never, 30)).toMatch(/^\[CW\] B6 is still working after 30 min/)
  })
})
