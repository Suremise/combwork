// #846 (E10b): the `tasks` area, the board's service. Its refusals are CombworkErrors: agents (the Agent API, the hive
// tools) read them in English exactly as before, with the same status, and the window in its language. A card's
// history keeps its English (`what`: agents read it, Combwork's code and the scenarios match it) and stores the line as
// data beside it (`whatText`: a message id and values), which the card dialog shows in the window's language; entries
// from before have only the English, and show it.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from '../tempDir'

const base = tempDir('hive-i18n-tasks-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p) => rm(p, { recursive: true, force: true })

const { setLanguage, tr } = await import('../../src/shared/i18n')
const { englishText, withValues } = await import('../../src/shared/advanced')
const { HISTORY, storedLineText, storedMessage, storedText } = await import('../../src/shared/taskHistory')
const { PROVIDERS, providerMessage } = await import('../../src/shared/providers')
const { safeguardComment, safeguardText } = await import('../../src/shared/safeguards')
const { cardBusy } = await import('../../src/main/cardBusy')
const { ordinal } = await import('../../src/shared/toolReplies')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../../src/main/workspace')
const tasks = await import('../../src/main/tasks')
const { agentBusyError, startTask } = await import('../../src/main/taskStart')
const { shownError, windowError } = await import('../../src/main/combworkError')
const { apiErrorReply, entryForAgents } = await import('../../src/main/servers')
type StoredText = import('../../src/shared/types').StoredText
type TaskCard = import('../../src/shared/types').TaskCard

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/tasks.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agent = { kind: 'agent', name: 'Agent 1 (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const

/** A German translation of some of the area's messages, as a language file gives them (the rest stays English). */
const GERMAN: Record<string, string> = {
  'tasks.history.created': 'Erstellt in {column, select, hold {Geparkt} todo {Zu tun} doing {In Arbeit} review {Prüfung} passed {Bestanden} done {Erledigt} other {{column}}}',
  'tasks.history.renamed': 'Umbenannt in „{title}“',
  'tasks.history.movedTop': 'Ganz nach oben in {column, select, hold {Geparkt} todo {Zu tun} doing {In Arbeit} review {Prüfung} passed {Bestanden} done {Erledigt} other {{column}}}',
  'tasks.history.placed': 'Auf Platz {place} in {column, select, hold {Geparkt} todo {Zu tun} doing {In Arbeit} review {Prüfung} passed {Bestanden} done {Erledigt} other {{column}}}',
  'tasks.history.archivedInBatch': 'Mit {n} Karten archiviert ({label})',
  'tasks.history.loopWake': '{agent} {kind, select, review {zur Prüfung} other {mit dem Urteil}} geweckt (Schleife)',
  'tasks.history.decisionsTold': '{agent} über {count, plural, one {# neue Entscheidung} other {# neue Entscheidungen}} informiert',
  'tasks.history.watchEnded': '{watcher} wartet nicht mehr darauf: {why, select, blocked {die Karte ist blockiert} reviewer {{agent} prüft sie} reviewTaken {ihre Prüfung wurde ihm genommen} reassigned {an {agent} gegeben} unassigned {an niemanden gegeben} other {{why}}}',
  'tasks.history.safeguardStop': '**{agent}, nach einem Sicherheitsstopp:** Läuft jetzt auf {to} statt {from} (seit {since}).{hasHelp, select, yes { {help}} other {}}',
  'agents.claude.safeguardHelp': 'Im Terminal: /feedback meldet einen Fehlalarm, /model wechselt zurück.',
  'board.busy.reviewing': '{agent} prüft sie',
  'tasks.by.you': 'Du',
  'tasks.error.unknownTask': 'Unbekannte Aufgabe {card}',
  'tasks.error.needsTitle': 'Eine Aufgabe braucht einen Titel.',
  'tasks.error.tooLong': '{what, select, title {Der Titel ist zu lang (höchstens {max, number} Zeichen).} other {Zu lang.}}',
  'tasks.error.onlyUserDone': 'Nur der Benutzer legt Karten in Erledigt an.',
  'tasks.error.beforeArchived': '{before} ist archiviert.',
  'tasks.error.orderElsewhere': '{card} ist in {other, select, doing {In Arbeit} other {{other}}}, nicht in {column, select, todo {Zu tun} other {{column}}}.',
  'tasks.error.reviewAgentsOnly': 'Nur ein Agent des Projekts prüft die Karte.',
  'tasks.start.noteTooLong': 'Die Notiz ist zu lang (höchstens {max, number} Zeichen).',
  'tasks.skipped.movedColumn': 'nach {column, select, doing {In Arbeit} other {{column}}} verschoben'
}

function project(ws: string, name: string, agents: { id: string; name: string }[] = []): string {
  const p = join(ws, name)
  mkdirSync(join(p, '.combwork'), { recursive: true })
  writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents }))
  return p
}

let workspaces = 0
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

beforeEach(async () => {
  const path = join(base, `ws-${++workspaces}`)
  project(path, 'alpha', [{ id: 'a1', name: 'Agent 1' }])
  project(path, 'beta')
  w = createWorkspaceService()
  await w.open(path)
})
afterEach(() => {
  disposeWorkspaceService(w)
  setLanguage('en', {})
})

/** A refusal HI-1952 gave a kind: its English matched no statusFor pattern, so it answered 500 until then. */
const NOW_REFUSED = (english: string): boolean => /^(blockedBy must be a list|#\d+ is in Todo\. A card is reviewed in Review|You aren't reviewing #\d+ now)/.test(english)

/** What a call threw. */
async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('it did not throw')
}

/** A stored line as the window shows it: its message in the window's language (what Board.tsx does). */
const shown = (s: StoredText | undefined): string | null => (s ? storedLineText(s, (m, values) => tr(m, values), providerMessage) : null)

/** A stored line's English (what main stores in `what`): agents' column names (#1458). */
const englishOf = (s: StoredText): string | null => storedLineText(s, tasks.agentEnglish, providerMessage)

describe('the tasks area', () => {
  it('every message is of the tasks area, with a note for translators, and the two files have no text left to convert', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(80)
    for (const [id, m] of Object.entries(EN)) {
      expect(id).toMatch(/^tasks\./)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    for (const f of ['tasks.ts', 'taskStart.ts']) expect(() => readFileSync(join(ROOT, 'i18n/allow', `src__main__${f}.json`)), f).toThrow()
  })

  it('every history line has its message in the table the window reads, and an unknown id or an old entry has none', () => {
    for (const m of Object.values(HISTORY)) expect(storedMessage({ id: m.id })).toBe(m)
    expect(storedMessage({ id: 'tasks.history.fromANewerCombwork' })).toBeNull()
    expect(storedMessage(undefined)).toBeNull()
  })
})

describe("a card's history: English as stored, its line as data for the window", () => {
  it('stores the same English as before, whatever language Combwork shows, and the window reads each line in its own', async () => {
    setLanguage('de', GERMAN)
    const other = await run(() => tasks.createTask({ title: 'Other', project: 'alpha', column: 'review' }, user))
    const c = await run(() => tasks.createTask({ title: 'First', project: 'alpha' }, user))
    const said: string[] = []
    await run(() => tasks.updateTask(c.number, { title: 'Second', description: 'More', labels: ['a', 'b'], blocked: 'Which colour?', blockedBy: [other.number], links: [other.number], decision: 'Use blue', agent: 'a1' }, user, { said }))
    await run(() => tasks.updateTask(c.number, { column: 'review', position: 'top' }, assistant))
    await run(() => tasks.reorderTasks('review', [other.number, c.number], assistant))
    await run(() => tasks.updateTask(c.number, { agent: null, blocked: null, labels: [], blockedBy: [], links: [] }, user))
    const card = await run(() => tasks.getTask(c.number))
    const id = card.decisions![0].id
    await run(() => tasks.editDecision(c.number, id, 'Use red', user))
    await run(() => tasks.editDecision(c.number, id, null, user))
    await run(() => tasks.archiveTask(c.number, true))
    await run(() => tasks.archiveTask(c.number, false))
    await run(() => tasks.noteOnCard(c.number, 'Told Agent 1 of 1 new decision'))
    const history = (await run(() => tasks.getTask(c.number))).history
    // Exactly the English Combwork always wrote (agents read it; doneSince, the loop wakes and the scenarios match it).
    expect(history.map((h) => h.what)).toEqual([
      'Created in Todo',
      'Renamed to "Second"',
      'Changed the description',
      'Given to Agent 1',
      'Recorded a decision: "Use blue"',
      'Labels: a, b',
      'Blocked: Which colour?',
      `Depends on #${other.number}`,
      `Linked to #${other.number}`,
      'Moved to the top of Review',
      'Placed 2nd in Review',
      'Taken from Agent 1',
      'Removed the labels',
      'No longer blocked',
      'No longer depends on other cards',
      'Removed the links',
      'Changed a decision to "Use red" (was "Use blue")',
      'Removed a decision: "Use red"',
      'Archived',
      'Brought back from the archive',
      'Told Agent 1 of 1 new decision'
    ])
    // The hive tools' short replies confirm the change in the history's English.
    expect(said).toEqual(history.slice(1, 9).map((h) => h.what))
    // Each line Combwork's board wrote is also data, which formats back to the same English…
    for (const h of history.slice(0, -1)) {
      expect(storedMessage(h.whatText), h.what).not.toBeNull()
      expect(englishOf(h.whatText!), h.what).toBe(h.what)
    }
    // …and in the window's language where there is a translation (the column a select key, never English).
    expect(history[0].whatText).toEqual({ id: 'tasks.history.created', values: { column: 'todo' } })
    expect(history.slice(0, 2).map((h) => shown(h.whatText))).toEqual(['Erstellt in Zu tun', 'Umbenannt in „Second“'])
    expect(history.slice(9, 11).map((h) => shown(h.whatText))).toEqual(['Ganz nach oben in Prüfung', 'Auf Platz 2 in Prüfung'])
    // A line written elsewhere in English (an agent-facing note) has no data: the window shows its English.
    expect(history.at(-1)!.whatText).toBeUndefined()
    expect(shown(history.at(-1)!.whatText)).toBeNull()
    // Agents never get the data (the Agent API's card view leaves it out).
    expect(entryForAgents(history[0])).toEqual({ at: history[0].at, by: 'You', what: 'Created in Todo' })
  })

  it("formats every line's English exactly as the board wrote it before (#846)", () => {
    const en = (s: StoredText): string | null => englishOf(s)
    const cases: [StoredText, string][] = [
      [storedText(HISTORY.moved, { column: 'hold' }), 'Moved to On Hold'],
      [storedText(HISTORY.moved, { column: 'passed' }), 'Moved to Passed'],
      [storedText(HISTORY.movedBottom, { column: 'done' }), 'Moved to the bottom of Done'],
      [storedText(HISTORY.movedBefore, { column: 'doing', before: 1234 }), 'Moved to Doing, before #1234'],
      [storedText(HISTORY.movedBeforeIn, { column: 'todo', before: 7 }), 'Moved before #7 in Todo'],
      // Since HI-1661 the card before it is stored by its key; a number above is a line from before, shown as it was.
      [storedText(HISTORY.movedBefore, { column: 'doing', before: 'HI-12' }), 'Moved to Doing, before HI-12'],
      [storedText(HISTORY.movedBeforeIn, { column: 'todo', before: 'AM-3' }), 'Moved before AM-3 in Todo'],
      [storedText(HISTORY.returned, { round: 3 }), 'Returned for review, round 3'],
      [storedText(HISTORY.toProject, { project: 'beta' }), 'Moved to beta'],
      [storedText(HISTORY.toWorkspace), 'Moved to the workspace'],
      [storedText(HISTORY.takenFromOf, { agent: 'Agent 2', project: 'alpha' }), 'Taken from Agent 2 of alpha'],
      [storedText(HISTORY.takenFromOfWorkspace, { agent: 'Agent 2' }), 'Taken from Agent 2 of the workspace'],
      [storedText(HISTORY.takenFromAgent), 'Taken from its agent'],
      [storedText(HISTORY.reviewStarted), 'Started reviewing'],
      [storedText(HISTORY.reviewPassed), 'Review passed'],
      [storedText(HISTORY.reviewFailed), 'Review failed'],
      [storedText(HISTORY.reviewStopped, { agent: 'R1' }), 'Review by R1 stopped'],
      [storedText(HISTORY.reviewEnded, { agent: 'R1', why: 'sessionEnded' }), 'Review by R1 stopped: its session ended'],
      [storedText(HISTORY.reviewEnded, { agent: 'R1', why: 'agentRemoved' }), 'Review by R1 stopped: the agent was removed'],
      [storedText(HISTORY.archivedInBatch, { n: 12, label: 'All in Done' }), 'Archived in a batch of 12 (All in Done)'],
      [storedText(HISTORY.backWithBatch, { label: 'Archive All' }), 'Brought back with its batch (Archive All)'],
      [storedText(HISTORY.archivedDone, { days: 1 }), 'Archived after 1 day in Done'],
      [storedText(HISTORY.archivedDone, { days: 14 }), 'Archived after 14 days in Done'],
      [storedText(HISTORY.archivedHidden, { project: 'alpha' }), 'Archived: alpha was hidden'],
      [storedText(HISTORY.archivedRemoved, { project: 'alpha' }), 'Archived: alpha was removed from Combwork'],
      [storedText(HISTORY.restored, { project: 'alpha' }), 'Brought back: alpha was restored'],
      [storedText(HISTORY.imported, { project: 'alpha', was: 31 }), 'Brought back with alpha (it was #31)'],
      [storedText(HISTORY.repaired, { from: 'old', to: 'new' }), 'Project: old → new (renamed or moved)'],
      // A user's words with ICU's own characters in them stay as they are.
      [storedText(HISTORY.renamed, { title: "It's {n} cards, #1" }), `Renamed to "It's {n} cards, #1"`]
    ]
    for (const [s, english] of cases) expect(en(s)).toBe(english)
    // Places as toolReplies' ordinal() wrote them.
    for (const n of [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112, 499]) expect(en(storedText(HISTORY.placed, { place: n, column: 'review' }))).toBe(`Placed ${ordinal(n)} in Review`)
  })

  it('the window says Active and Approved where agents read Doing and Passed (#1458)', async () => {
    const c = await run(() => tasks.createTask({ title: 'Staged', project: 'alpha', column: 'passed' }, user))
    const other = await run(() => tasks.createTask({ title: 'Other', project: 'alpha', column: 'doing' }, user))
    // Nobody on it, by the user's reason (HI-2062: the Assistant's move into Doing with nobody on it needs one).
    await run(() => tasks.updateTask(c.number, { column: 'doing', before: other.number, override: { reason: 'Nobody yet' } }, assistant))
    await run(() => tasks.updateTask(c.number, { position: 'bottom' }, assistant))
    await run(() => tasks.updateTask(c.number, { position: 'top' }, assistant))
    await run(() => tasks.updateTask(c.number, { column: 'passed' }, user))
    const history = (await run(() => tasks.getTask(c.number))).history
    const lines = ['Created in Passed', 'Moved to Doing, before #' + other.number, 'Moved to the bottom of Doing', 'Moved to the top of Doing', 'Moved to Passed']
    expect(history.map((h) => h.what)).toEqual(lines)
    expect(history.map((h) => entryForAgents(h).what)).toEqual(lines)
    expect(history.map((h) => shown(h.whatText))).toEqual(['Created in Approved', 'Moved to Active, before #' + other.number, 'Moved to the bottom of Active', 'Moved to the top of Active', 'Moved to Approved'])
    // Every column in both: agents' names are TASK_COLUMNS' labels, the window's its column names.
    for (const [column, agents, window] of [['hold', 'On Hold', 'On Hold'], ['todo', 'Todo', 'Todo'], ['doing', 'Doing', 'Active'], ['review', 'Review', 'Review'], ['passed', 'Passed', 'Approved'], ['done', 'Done', 'Done']] as const) {
      for (const m of [HISTORY.created, HISTORY.moved, HISTORY.movedTop, HISTORY.movedBottom]) {
        const s = storedText(m, { column })
        expect(englishOf(s)).toBe(englishText(withValues(m, { column: agents })))
        expect(shown(s)).toBe(englishText(withValues(m, { column: window })))
      }
      expect(englishOf(storedText(HISTORY.placed, { place: 3, column }))).toBe(`Placed 3rd in ${agents}`)
      expect(shown(storedText(HISTORY.placed, { place: 3, column }))).toBe(`Placed 3rd in ${window}`)
      expect(englishOf(storedText(HISTORY.movedBeforeIn, { before: 4, column }))).toBe(`Moved before #4 in ${agents}`)
      expect(shown(storedText(HISTORY.movedBeforeIn, { before: 4, column }))).toBe(`Moved before #4 in ${window}`)
    }
  })

  it('a review ended by Combwork, and a project rename repaired, are data too', async () => {
    const c = await run(() => tasks.createTask({ title: 'Reviewed', project: 'alpha', column: 'review' }, user))
    await run(() => tasks.updateTask(c.number, { review: 'start' }, agent))
    await run(() => tasks.endReviews('alpha', 'a1', 'its session ended'))
    const last = (await run(() => tasks.getTask(c.number))).history.at(-1)!
    expect(last).toMatchObject({ by: 'Combwork', what: 'Review by Agent 1 stopped: its session ended', whatText: { id: 'tasks.history.reviewEnded', values: { agent: 'Agent 1', why: 'sessionEnded' } } })
  })
})

describe("the board's refusals: English for agents as before, the window's language for the window", () => {
  it('says each in English with the status it always had, and in German to the window', async () => {
    setLanguage('de', GERMAN)
    const archived = await run(() => tasks.createTask({ title: 'Old', project: 'alpha' }, user))
    await run(() => tasks.archiveTask(archived.number, true))
    const doing = await run(() => tasks.createTask({ title: 'Busy', project: 'alpha', column: 'doing' }, user))
    const todo = await run(() => tasks.createTask({ title: 'Next', project: 'alpha' }, user))
    const cases: [Error, string, number, string | null][] = [
      [await caught(run(() => tasks.getTask(99))), 'Unknown task #99', 404, 'Unbekannte Aufgabe #99'],
      [await caught(run(() => tasks.readTask(todo.number, { kind: 'agent', name: 'B', scope: 'beta' }))), `Unknown task #${todo.number}`, 404, `Unbekannte Aufgabe #${todo.number}`],
      [await caught(run(() => tasks.createTask({ title: ' ' }, user))), 'A task needs a title.', 400, 'Eine Aufgabe braucht einen Titel.'],
      [await caught(run(() => tasks.createTask({ title: 'x'.repeat(201) }, user))), 'The title is too long (at most 200 characters).', 400, 'Der Titel ist zu lang (höchstens 200 Zeichen).'],
      [await caught(run(() => tasks.updateTask(todo.number, { blocked: 'x'.repeat(1001) }, user))), 'The blocked reason is too long (at most 1,000 characters).', 400, 'Zu lang.'],
      [await caught(run(() => tasks.createTask({ title: 'x', column: 'nope' as never }, user))), 'Unknown column "nope": hold, todo, doing, review, passed or done.', 400, null],
      [await caught(run(() => tasks.createTask({ title: 'x', column: 'done' }, assistant))), 'Only the user puts cards in Done.', 403, 'Nur der Benutzer legt Karten in Erledigt an.'],
      [await caught(run(() => tasks.createTask({ title: 'x', column: 'hold' }, agent))), 'Only the user or the Assistant puts cards On Hold. Add it to Todo; where the user has decided to park it, ask the Assistant (cw_ask_assistant), otherwise ask the user.', 403, null],
      [await caught(run(() => tasks.createTask({ title: 'x', project: 'beta' }, agent))), 'You can add cards only to your project (alpha).', 403, null],
      [await caught(run(() => tasks.createTask({ title: 'x', project: 'gamma' }, user))), 'Unknown project "gamma"', 404, null],
      [await caught(run(() => tasks.createTask({ title: 'x', agent: 'a1' }, user))), 'Choose a project before giving the task to an agent.', 400, 'Choose a project before giving the card to an agent.'],
      [await caught(run(() => tasks.createTask({ title: 'x', project: 'alpha', agent: 'zed' }, user))), 'Unknown agent "zed" in alpha', 404, null],
      [await caught(run(() => tasks.updateTask(todo.number, { labels: 'a' as never }, user))), 'labels must be a list', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { labels: Array.from({ length: 13 }, (_, i) => `l${i}`) }, user))), 'A card can have up to 12 labels.', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { blockedBy: 3 as never }, user))), 'blockedBy must be a list of card numbers', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { links: [todo.number] }, user))), "links: a card can't refer to itself", 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { links: ['x'] as never }, user))), 'links: "NaN" is not a card number', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { blockedBy: [999] }, user))), 'blockedBy: there is no card #999', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { position: 'middle' as never }, assistant))), 'Unknown position "middle": top or bottom.', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { before: doing.number, position: 'top' }, assistant))), 'Give before or position, not both.', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { before: todo.number }, assistant))), "A card can't go before itself.", 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { before: archived.number }, assistant))), `#${archived.number} is archived, not in Todo: #${todo.number} can only go before a card in the column it's in.`, 409, `#${archived.number} ist archiviert.`],
      [await caught(run(() => tasks.updateTask(todo.number, { before: doing.number }, assistant))), `#${doing.number} is in Doing, not in Todo: #${todo.number} can only go before a card in the column it's in.`, 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { column: 'done', position: 'top' }, assistant))), 'Only the user puts the cards in Done in order.', 403, null],
      [await caught(run(() => tasks.reorderTasks('todo', [doing.number], assistant))), `#${doing.number} is in Doing, not in Todo. Only cards already in Todo can be put in order there.`, 400, `#${doing.number} ist in In Arbeit, nicht in Zu tun.`],
      [await caught(run(() => tasks.reorderTasks('todo', [archived.number], assistant))), `#${archived.number} is archived, not in Todo. Only cards already in Todo can be put in order there.`, 409, null],
      [await caught(run(() => tasks.reorderTasks('todo', [todo.number, todo.number], assistant))), `cards: #${todo.number} is listed twice`, 400, null],
      [await caught(run(() => tasks.reorderTasks('todo', [], assistant))), 'cards: list the card numbers in the order wanted.', 400, null],
      [await caught(run(() => tasks.updateTask(archived.number, { title: 'x' }, assistant))), `#${archived.number} is archived. Only the user can bring it back.`, 403, null],
      [await caught(run(() => tasks.commentTask(todo.number, ' ', user))), 'The comment is empty.', 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { review: 'start' }, user))), "Only an agent of the card's project reviews it, through its own Combwork tools.", 403, 'Nur ein Agent des Projekts prüft die Karte.'],
      [await caught(run(() => tasks.updateTask(todo.number, { review: 'start' }, agent))), `#${todo.number} is in Todo. A card is reviewed in Review; if it needs more work, that is work on it (move it to doing).`, 400, null],
      [await caught(run(() => tasks.updateTask(todo.number, { review: 'passed' }, agent))), `You aren't reviewing #${todo.number} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.`, 400, null],
      [await caught(run(() => tasks.editDecision(todo.number, 'x', 'y', assistant))), "Only the user changes or removes a card's decisions.", 403, null],
      [await caught(run(() => tasks.archiveBatch([todo.number], { label: '', column: null, project: null, query: '', includeBusy: false }, assistant))), 'Only the user archives cards.', 403, null],
      [await caught(Promise.resolve().then(() => tasks.batchNumbers([]))),'cards: list the card numbers to change.', 400, null],
      [await caught(run(() => startTask(todo.number, { kind: 'agent', agentId: 'a1' }, user, 'x'.repeat(4001)))), 'The note is too long (at most 4,000 characters).', 400, 'Die Notiz ist zu lang (höchstens 4.000 Zeichen).']
    ]
    for (const [e, english, status, german] of cases) {
      // The Agent API's reply (and every reader of .message): the English, as before, with the status its English gave.
      expect(e.message).toBe(english)
      expect(apiErrorReply(e).body.error).toBe(english)
      expect(apiErrorReply(e).status, english).toBe(status)
      // A permission refusal was always 403 by its class; any other, by its English: the same status as before either way.
      // Except the refusals HI-1952 gave a kind, which answered 500 (no pattern matched their English): now 400.
      if (!(e instanceof tasks.TaskPermissionError) && !NOW_REFUSED(english)) expect(apiErrorReply(new Error(english)).status, `${english}: the status its English always gave`).toBe(status)
      // The window (IPC's conversion): in its language, or English where this test has no translation.
      expect((windowError(e) as Error).message).toBe(german ?? english)
      expect(shownError(e)).toBe(german ?? english)
    }
  })

  it('the window says card where agents and the Agent API keep the words they always read (#910)', async () => {
    // A busy Start answered 500 by its English (no statusFor pattern for it) until HI-1952 gave it a kind: 409.
    // The status: what it always was (a busy Start's from its English: servers.ts statusFor).
    const cases: [Error, string, string, number, string?][] = [
      // A refusal naming a column (#1458; Start's "was moved to … meanwhile"): the window says Active and Approved,
      // agents Doing and Passed.
      [tasks.columnError(HISTORY.moved, { column: 'doing' }, { kind: 'conflict' }), 'Moved to Doing', 'Moved to Active', 409],
      [tasks.columnError(HISTORY.movedBefore, { column: 'passed', before: 'HI-3' }), 'Moved to Passed, before HI-3', 'Moved to Approved, before HI-3', apiErrorReply(new Error('Moved to Passed, before HI-3')).status],
      [await caught(run(() => tasks.getTask(99))), 'Unknown task #99', 'Unknown card #99', 404, 'Unbekannte Aufgabe #99'],
      [await caught(run(() => tasks.createTask({ title: ' ' }, user))), 'A task needs a title.', 'A card needs a title.', 400, 'Eine Aufgabe braucht einen Titel.'],
      [await caught(run(() => tasks.createTask({ title: 'x', agent: 'a1' }, user))), 'Choose a project before giving the task to an agent.', 'Choose a project before giving the card to an agent.', 400],
      [agentBusyError('B1', 'working'), "B1 is working. Start the task once it's idle, or give it to another agent.", "B1 is working. Start the card once it's idle, or give it to another agent.", 409],
      [agentBusyError('B1', 'watching'), "B1 is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header). Start the task once it's idle, or give it to another agent.", "B1 is waiting on cards (a card watch): it takes no other work until it is woken, or the watch is cancelled (Cancel in its header). Start the card once it's idle, or give it to another agent.", 409]
    ]
    for (const lang of ['en', 'de'] as const) {
      setLanguage(lang, lang === 'de' ? GERMAN : {})
      for (const [e, agents, window, status, german] of cases) {
        expect(e.message).toBe(agents)
        expect(apiErrorReply(e)).toEqual({ status, body: { error: agents } })
        // In English the window's own words; in German its translation, or the window's English where this test has none.
        expect(shownError(e), lang).toBe(lang === 'en' ? window : (german ?? window))
        expect((windowError(e) as Error).message, lang).toBe(lang === 'en' ? window : (german ?? window))
      }
    }
    setLanguage('en', {})
  })

  it("an agent moving another agent's card in Doing is a conflict (409), worded for the window", async () => {
    setLanguage('de', GERMAN)
    const c = await run(() => tasks.createTask({ title: 'Theirs', project: 'alpha', column: 'doing' }, user))
    await run(() => tasks.updateTask(c.number, { agent: 'a1' }, user))
    const e = await caught(run(() => tasks.updateTask(c.number, { column: 'review' }, { kind: 'agent', name: 'Agent 2 (alpha)', self: { project: 'alpha', agentId: 'a2' }, scope: 'alpha' })))
    expect(e).toBeInstanceOf(tasks.TaskConflictError)
    expect(e.message).toBe(`#${c.number} is in Active with agent Agent 1, who is working on it: newer work is in progress, so another agent can't move it to Review. Leave it where it is; agent Agent 1 moves it to Review when done, and the user can move it.`)
    expect(apiErrorReply(e).status).toBe(409)
  })

  it("Archive All's reasons for leaving a card are the window's, in its language", async () => {
    setLanguage('de', GERMAN)
    const c = await run(() => tasks.createTask({ title: 'Moved', project: 'alpha', column: 'doing' }, user))
    const r = await run(() => tasks.archiveBatch([c.number], { label: 'All in Todo', column: 'todo', project: null, query: '', includeBusy: false }, user))
    expect(r.skipped).toEqual([{ number: c.number, why: 'nach In Arbeit verschoben' }])
    setLanguage('en', {})
    const again = await run(() => tasks.archiveBatch([c.number], { label: 'All in Todo', column: 'todo', project: null, query: '', includeBusy: false }, user))
    expect(again.skipped).toEqual([{ number: c.number, why: 'moved to Active' }])
    // Archived with its batch: the line is German in the window; the batch's name is kept as it was named (the card
    // dialog words Archive All's own names with archiveBatchText, as the archive's picker does).
    const done = await run(() => tasks.archiveBatch([c.number], { label: 'All in Doing', column: 'doing', project: null, query: '', includeBusy: false }, user))
    const h = (await run(() => tasks.getTask(c.number))).history.at(-1)!
    expect(done.archived).toEqual([c.number])
    expect(h.what).toBe('Archived in a batch of 1 (All in Doing)')
    setLanguage('de', GERMAN)
    expect(shown(h.whatText)).toBe('Mit 1 Karten archiviert (All in Doing)')
  })
})

describe('lines and a comment Combwork writes from outside the board service (#866)', () => {
  it('stores the English each wrote before, word for word, and the window reads them in its language', () => {
    const cases: [StoredText, string, string][] = [
      [storedText(HISTORY.loopWake, { agent: 'R1', kind: 'review' }), 'Woke R1 to review it (a loop wake)', 'R1 zur Prüfung geweckt (Schleife)'],
      [storedText(HISTORY.loopWake, { agent: 'B1', kind: 'verdict' }), 'Woke B1 with its verdict (a loop wake)', 'B1 mit dem Urteil geweckt (Schleife)'],
      [storedText(HISTORY.decisionsTold, { agent: 'B1', count: 1 }), 'Told B1 of 1 new decision', 'B1 über 1 neue Entscheidung informiert'],
      [storedText(HISTORY.decisionsTold, { agent: 'B1', count: 3 }), 'Told B1 of 3 new decisions', 'B1 über 3 neue Entscheidungen informiert'],
      [storedText(HISTORY.watchEnded, { watcher: 'B1', why: 'blocked', agent: '' }), "Ended B1's watch on it: the card is blocked", 'B1 wartet nicht mehr darauf: die Karte ist blockiert'],
      [storedText(HISTORY.watchEnded, { watcher: 'R1', why: 'reviewer', agent: 'R2' }), "Ended R1's watch on it: R2 reviews it", 'R1 wartet nicht mehr darauf: R2 prüft sie'],
      [storedText(HISTORY.watchEnded, { watcher: 'R1', why: 'reviewTaken', agent: '' }), "Ended R1's watch on it: its review was taken from it", 'R1 wartet nicht mehr darauf: ihre Prüfung wurde ihm genommen'],
      [storedText(HISTORY.watchEnded, { watcher: 'R1', why: 'reassigned', agent: 'B4' }), "Ended R1's watch on it: reassigned to B4", 'R1 wartet nicht mehr darauf: an B4 gegeben'],
      [storedText(HISTORY.watchEnded, { watcher: 'a-1', why: 'unassigned', agent: '' }), "Ended a-1's watch on it: reassigned to no agent", 'a-1 wartet nicht mehr darauf: an niemanden gegeben']
    ]
    for (const [s, en] of cases) expect(englishOf(s)).toBe(en)
    setLanguage('de', GERMAN)
    for (const [s, en, de] of cases) {
      expect(englishOf(s), en).toBe(en)
      expect(shown(s), en).toBe(de)
    }
  })

  it("words the safeguard comment as before, the CLI's help included, and shows it in the window's language", () => {
    const label = (m: string): string => m.toUpperCase()
    const switched = { from: 'opus', to: 'sonnet', at: '2026-10-15T15:12:00.000Z' }
    const notes = [
      { at: '2026-10-15T15:10:00.000Z', model: 'opus', tools: ['Bash', 'Edit'], stops: 1, switched },
      { at: '2026-10-15T15:10:00.000Z', tools: ['Bash'], stops: 3, switched, prompt: true },
      { at: '2026-10-15T15:10:00.000Z', model: 'opus', tools: [], stops: 2, switched, idle: true },
      { at: '2026-10-15T15:10:00.000Z', tools: ['Read'], stops: 0, switched }
    ]
    for (const d of PROVIDERS) {
      // The descriptor's English help and its message are the same sentence (the comment's English comes from the message).
      expect(d.text?.safeguardHelp?.defaultMessage ?? null, d.id).toBe(d.safeguardHelp)
      for (const note of notes) {
        const before = `**Agent 1, after a safeguard stop:** ${safeguardText(note, label)}${d.safeguardHelp ? ` ${d.safeguardHelp}` : ''}`
        expect(englishOf(safeguardComment(note, 'Agent 1', label, d.text?.safeguardHelp ?? null)), `${d.id} ${JSON.stringify(note)}`).toBe(before)
      }
    }
    setLanguage('de', GERMAN)
    const claude = PROVIDERS.find((d) => d.text?.safeguardHelp?.id === 'agents.claude.safeguardHelp')!
    const said = safeguardComment(notes[3], 'Agent 1', label, claude.text!.safeguardHelp)
    expect(said.values?.help).toEqual({ id: 'agents.claude.safeguardHelp' })
    const since = said.values?.since as string
    expect(shown(said)).toBe(`**Agent 1, nach einem Sicherheitsstopp:** Läuft jetzt auf SONNET statt OPUS (seit ${since}). Im Terminal: /feedback meldet einen Fehlalarm, /model wechselt zurück.`)
    // A help message this Combwork doesn't know (a newer one wrote it): nothing to show, so the window shows the stored English.
    expect(shown({ ...said, values: { ...said.values, help: { id: 'agents.nope.safeguardHelp' } } })).toBeNull()
  })

  it('shows nothing of a damaged record (a card file edited by hand), so the window keeps the stored English', () => {
    setLanguage('de', GERMAN)
    const help = { id: 'agents.claude.safeguardHelp' }
    const ok = { id: 'tasks.history.safeguardStop', values: { agent: 'A', stops: 0, model: 'none', time: '', to: 'b', from: 'a', since: '15:12', state: 'none', hasTools: 'no', tools: '', hasHelp: 'yes', help } }
    expect(shown(ok)).toBe('**A, nach einem Sicherheitsstopp:** Läuft jetzt auf b statt a (seit 15:12). Im Terminal: /feedback meldet einen Fehlalarm, /model wechselt zurück.')
    const damaged: unknown[] = [
      null,
      'tasks.history.loopWake',
      [],
      { id: 42 },
      { id: null, values: {} },
      { id: 'tasks.history.loopWake', values: null },
      { id: 'tasks.history.loopWake', values: ['R1', 'review'] },
      { id: 'tasks.history.loopWake', values: 'R1' },
      { id: 'tasks.history.loopWake', values: { agent: null, kind: 'review' } },
      { id: 'tasks.history.loopWake', values: { agent: ['R1'], kind: 'review' } },
      { id: 'tasks.history.loopWake', values: { agent: true, kind: 'review' } },
      { id: 'tasks.history.decisionsTold', values: { agent: 'B1', count: Number.NaN } },
      { ...ok, values: { ...ok.values, help: null } },
      { ...ok, values: { ...ok.values, help: [] } },
      { ...ok, values: { ...ok.values, help: { id: 7 } } },
      { ...ok, values: { ...ok.values, help: { id: 'agents.claude.safeguardHelp', values: null } } },
      { ...ok, values: { ...ok.values, help: { id: 'tasks.history.loopWake', values: { agent: { id: 'tasks.history.loopWake', values: { agent: { id: 'tasks.history.loopWake', values: { agent: { id: 'tasks.history.loopWake', values: { agent: 'x', kind: 'review' } }, kind: 'review' } }, kind: 'review' } }, kind: 'review' } } } }
    ]
    for (const s of damaged) {
      expect(storedLineText(s, (m, values) => tr(m, values), providerMessage), JSON.stringify(s)).toBeNull()
      expect(storedLineText(s, (m, values) => englishText(values ? withValues(m, values) : m), providerMessage), JSON.stringify(s)).toBeNull()
    }
  })

  it("puts the comment on a card with its English for agents and its data for the window", async () => {
    const c = await run(() => tasks.createTask({ title: 'Guarded', project: 'alpha' }, user))
    const said = safeguardComment({ at: '2026-10-15T15:10:00.000Z', tools: [], stops: 1, switched: { from: 'a', to: 'b', at: '2026-10-15T15:12:00.000Z' } }, 'Agent 1', (m) => m, null)
    expect(await run(() => tasks.commentAsCombwork(c.number, said))).toBe(true)
    const comment = (await run(() => tasks.getTask(c.number))).comments.at(-1)!
    expect(comment.text).toBe(englishOf(said))
    expect(comment.text).toMatch(/^\*\*Agent 1, after a safeguard stop:\*\* A safety classifier stopped a response at \d\d:\d\d\. It now runs on b instead of a \(since \d\d:\d\d\)\.$/)
    expect(comment.appText).toEqual(said)
  })

  it("gives Archive All's reasons for leaving a card in the window's language", async () => {
    const card = { number: 1, column: 'review', project: 'alpha', review: { agentId: 'r1', agentName: 'R1' } } as unknown as TaskCard
    setLanguage('de', GERMAN)
    expect(await run(async () => cardBusy(w, card))).toBe('R1 prüft sie')
    setLanguage('en', {})
    expect(await run(async () => cardBusy(w, card))).toBe('R1 is reviewing it')
  })
})
