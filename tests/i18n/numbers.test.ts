import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { msg, setLanguage, tr } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { ADVANCED_DEFS, advancedShown } from '../../src/shared/advanced'
import { unknownStateText } from '../../src/shared/runtime'
import { durationText } from '../../src/shared/tasks'

// #879: a plain `{n}` placeholder given a number is written with String(n), whatever the language: only `{n, number}`
// (and a plural's #) follows it. The messages whose numbers can reach 1,000 take `{…, number}`; ids, ports, PIDs, exit
// codes, years and line numbers stay plain, ungrouped.

const ROOT = resolve(__dirname, '../..')
const catalogue = Object.assign({}, ...readdirSync(join(ROOT, 'locales/en')).map((f) => JSON.parse(readFileSync(join(ROOT, 'locales/en', f), 'utf8')))) as Record<string, { defaultMessage: string; description: string }>
const shownAs = (id: string, values: Record<string, string | number>): string => tr(msg({ id, defaultMessage: catalogue[id].defaultMessage, description: catalogue[id].description }), values)

const N = 12_345
/** Each message, with values that put N in every number placeholder. */
const CASES: [id: string, values: Record<string, string | number>, numbers: number][] = [
  ['service.git.tooLarge', { kb: N }, 1],
  ['content.mcp.zipTooMany', { max: N }, 1],
  ['tasks.start.noteTooLong', { max: N }, 1],
  ['tasks.error.cardsTooMany', { max: N }, 1],
  ['tasks.history.archivedInBatch', { n: N, label: 'x' }, 1],
  ['board.batchName.shownIn', { n: N, column: 'x' }, 1],
  ['board.batchName.shownCards', { n: N }, 1],
  ['board.batch.andMore', { cards: 'x', n: N }, 1],
  ['panes.resume.allSessions', { n: N }, 1],
  ['panes.list.more', { n: N }, 1],
  ['shell.showAll.all', { n: N }, 1],
  ['shell.showAll.region', { label: 'x', n: N }, 1],
  ['board.archiveAll.menuShownIn', { n: N, total: N }, 2],
  ['board.archiveAll.menuShown', { n: N, total: N }, 2],
  ['board.archiveAll.menuColumn', { column: 'x', total: N }, 1],
  ['board.archiveAll.menuAll', { total: N }, 1],
  ['board.archived.countSelected', { n: N, selected: N }, 2],
  ['board.archived.unarchiveSelectedN', { n: N }, 1],
  ['board.archived.unarchiveBatch', { n: N }, 1],
  ['board.toolbar.archived', { n: N }, 1],
  ['board.archiveAll.titleShownIn', { n: N, column: 'x' }, 1],
  ['board.archiveAll.messageShownIn', { n: N, column: 'x', total: N }, 2],
  ['board.archiveAll.messageShown', { n: N, total: N }, 2],
  ['board.archiveAll.columnCount', { column: 'x', n: N }, 1],
  ['shell.table.range', { from: N, to: N, total: N }, 3],
  ['board.progress.stepOf', { step: N, total: N }, 2],
  ['board.progress.stepOfNamed', { step: N, total: N, name: 'x' }, 2],
  ['board.progress.railFiltered', { name: 'x', summary: 'x', all: N }, 1],
  ['board.progress.railFilteredNone', { name: 'x', all: N }, 1],
  ['board.progress.railShowing', { name: 'x', shown: N, all: N }, 2],
  ['board.progress.moreRuns', { n: N }, 1],
  ['board.progress.moreOthers', { n: N }, 1],
  ['board.details.stepsLast', { done: N, total: N, step: 'x' }, 2],
  ['board.details.steps', { done: N, total: N }, 2],
  ['sessions.branch.archive', { scope: 'all', n: N }, 1],
  ['sessions.branch.unarchive', { scope: 'session', n: N }, 1],
  ['sessions.branch.delete', { scope: 'all', n: N }, 1],
  ['sessions.bulk.skipCount', { n: N, reason: 'live' }, 1],
  ['settings.sessions.usageCacheSize.tip', { min: N, max: N }, 2],
  ['settings.agents.backgroundTaskMinutes.tip', { min: N, max: N }, 2],
  ['tips.ui.counter', { n: N, total: N }, 2],
  ['tips.assistantCompact.text', { tokens: N }, 1],
  ['tips.progressHistory.text', { kept: N }, 1],
  ['sessions.bulk.andMore', { n: N }, 1],
  ['sessions.bulk.doneSkipped', { action: 'archive', n: N, skipped: N, why: 'x' }, 2],
  ['git.tags.older', { count: N }, 1],
  ['git.branches.remote', { count: N }, 1],
  ['project.card.withoutPriceShort', { count: N }, 1],
  ['project.settings.megabytes', { count: N }, 1],
  ['workspace.overview.withoutPriceShort', { count: N }, 1],
  ['files.attachments.total', { host: 'assistant', total: N, groups: N }, 2],
  ['settings.advanced.unit.seconds', { n: N }, 1],
  ['files.viewer.position', { index: N, count: N }, 2],
  ['sessions.image.position', { n: N, total: N }, 2],
  ['shell.table.page', { page: N, pages: N }, 2],
  ['board.duration.hours', { h: N }, 1],
  ['board.duration.hoursMinutes', { h: N, min: 5 }, 1],
  ['actions.duration.hoursMinutes', { h: N, m: 5 }, 1],
  ['panes.runtime.silent', { known: 'yes', minutes: N }, 1],
  ['board.slots.minutes', { n: N }, 1],
  ['service.gitRepo.diverged', { branch: 'x', upstream: 'x', ahead: N, behind: N }, 2],
  ['workspace.move.unreadable', { count: N, files: 'x', more: 0 }, 1]
]

const count = (text: string, figure: string): number => text.split(figure).length - 1

afterEach(() => setLanguage('en', {}))

describe('numbers in messages follow the language (#879)', () => {
  it('each message is in the catalogue', () => {
    expect(CASES.map(([id]) => id).filter((id) => !catalogue[id])).toEqual([])
  })

  it('in English, grouped as before for 1,000 and more', () => {
    for (const [id, values, numbers] of CASES) expect(count(shownAs(id, values), '12,345'), `${id}: ${shownAs(id, values)}`).toBe(numbers)
  })

  it("translated into Polish, the language's grouping (12 345), with no English digits left", () => {
    // Translated: a message not translated yet is English throughout, its numbers too (FormatJS formats the English
    // fallback in the default locale, so its plurals stay English), so each stands in as its own translation here.
    setLanguage('pl', Object.fromEntries(CASES.map(([id]) => [id, catalogue[id].defaultMessage])), 'pl-PL')
    for (const [id, values, numbers] of CASES) {
      const text = shownAs(id, values)
      expect(count(text, '12 345'), `${id}: ${text}`).toBe(numbers)
      expect(text, id).not.toContain('12345')
    }
  })

  it('under the pseudo-locale, the placeholders still take numbers', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const [id, values, numbers] of CASES) expect(count(shownAs(id, values), '12,345'), id).toBe(numbers)
  })

  it("a fraction takes the language's decimal separator", () => {
    expect(shownAs('project.settings.megabytes', { count: 12_345.5 })).toBe('12,345.5 MB')
    setLanguage('pl', { 'project.settings.megabytes': catalogue['project.settings.megabytes'].defaultMessage }, 'pl-PL')
    expect(shownAs('project.settings.megabytes', { count: 12_345.5 })).toBe('12 345,5 MB')
  })

  it('through the code that shows them: an advanced setting in seconds, a duration in hours, silent minutes', () => {
    const replySeconds = ADVANCED_DEFS.find((d) => d.id === 'cw.mcp.replySeconds')!
    const silent = (min: number | null) => unknownStateText({ turn: { state: 'unknown', ...(min === null ? {} : { silentSince: new Date(Date.UTC(2026, 9, 15) - min * 60_000).toISOString() }) } } as never, Date.UTC(2026, 9, 15), tr)
    expect([advancedShown(replySeconds, 3600), durationText(1250 * 3_600_000, tr), silent(1500), silent(null)]).toEqual(['3,600 s', '1,250 h', 'Silent 1,500 min · state unknown', 'Silent ? min · state unknown'])
    const ids = ['settings.advanced.unit.seconds', 'board.duration.hours', 'panes.runtime.silent']
    setLanguage('pl', Object.fromEntries(ids.map((id) => [id, catalogue[id].defaultMessage])), 'pl-PL')
    // Polish groups from five digits: 12 345, but 3600.
    expect([advancedShown(replySeconds, 3600), durationText(12_345 * 3_600_000, tr), silent(12_345), silent(null)]).toEqual(['3600 s', '12 345 h', 'Silent 12 345 min · state unknown', 'Silent ? min · state unknown'])
  })

  it('an id stays ungrouped: a card number', () => {
    setLanguage('pl', { 'tasks.history.imported': catalogue['tasks.history.imported'].defaultMessage }, 'pl-PL')
    expect(shownAs('tasks.history.imported', { project: 'alpha', was: N })).toContain('#12345')
  })
})
