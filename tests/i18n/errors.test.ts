import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { tempDir } from '../tempDir'

// #845 (E10a): errors read by both audiences. A service throws a CombworkError: its message is English (the Agent API, the
// log), and IPC tells the window its text in the language Combwork shows. The window's text as data beside an English
// field never reaches agents.

/** Handlers IPC registers, by channel (ipcMain stands in for Electron's). */
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => Promise<unknown>>()
vi.mock('electron', async () => {
  const stub = await import('../electron-stub')
  const ipcMain = { handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => Promise<unknown>) => void handlers.set(channel, fn) }
  return { ...stub, ipcMain, default: { ...stub.default, ipcMain } }
})
/** The window a call comes from: Combwork's own, showing a workspace. */
let callerWorkspace: unknown = null
vi.mock('../../src/main/windows', async (original) => ({ ...(await original<object>()), windowOf: () => (callerWorkspace ? { ws: callerWorkspace } : null) }))

const { setLanguage } = await import('../../src/shared/i18n')
const { msg } = await import('../../src/shared/i18n/msg')
const { withValues } = await import('../../src/shared/advanced')
const { extraArgsProblem } = await import('../../src/shared/providers')
const { capturedText, englishError, errorData, errorText, CombworkError, combworkError, shownError, windowError } = await import('../../src/main/combworkError')
const { addedForAgents, apiErrorReply, entryForAgents, metricsForAgents, replyText } = await import('../../src/main/servers')
const { registerIpc } = await import('../../src/main/ipc')
const { config } = await import('../../src/main/config')
const { createWorkspaceService, disposeWorkspaceService } = await import('../../src/main/workspace')

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/errors.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>

/** Test messages, and a German translation of them and of the IPC messages these tests reach. */
const M = {
  gone: msg({ id: 'errors.test.gone', defaultMessage: 'Card #{n} is gone.', description: 'test' }),
  wrapped: msg({ id: 'errors.test.wrapped', defaultMessage: 'Could not move it: {why}', description: 'test' })
}
const GERMAN = {
  'errors.test.gone': 'Karte #{n} gibt es nicht mehr.',
  'errors.test.wrapped': 'Konnte sie nicht verschieben: {why}',
  'errors.lane.required': 'Welche Spur beendet werden soll, fehlt',
  'errors.workspace.none': 'Kein Arbeitsbereich ist geöffnet.',
  'agents.provider.extraArgsDashes': 'Combwork übergibt die Aufgabe nach "--"; entferne es aus den zusätzlichen Argumenten.'
}

afterEach(() => setLanguage('en', {}))

describe('the errors area', () => {
  it("has every message of ipc.ts in locales/en, each with a note for translators, and no English left to convert", () => {
    expect(Object.keys(EN).length).toBeGreaterThan(40)
    for (const [id, m] of Object.entries(EN)) {
      expect(id.startsWith('errors.')).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
    // The guard's allowlist for ipc.ts is gone: every string left is a message or marked English with a reason.
    expect(() => readFileSync(join(ROOT, 'i18n/allow/src__main__ipc.ts.json'))).toThrow()
  })
})

describe('CombworkError', () => {
  it('keeps its English as its message, whatever language Combwork shows, and gives the window its text in that language', () => {
    setLanguage('de', GERMAN)
    const e = combworkError(M.gone, { n: 12 }, { kind: 'notFound' })
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('Card #12 is gone.')
    expect(englishError(e)).toBe('Card #12 is gone.')
    expect(shownError(e)).toBe('Karte #12 gibt es nicht mehr.')
    expect(e.kind).toBe('notFound')
    expect(errorData(e)).toEqual({ text: withValues(M.gone, { n: 12 }), kind: 'notFound' })
  })

  it('formats an error inside another in the same language: a CombworkError by its text, any other by its message', () => {
    setLanguage('de', GERMAN)
    const inner = combworkError(M.gone, { n: 3 })
    const outer = combworkError(M.wrapped, { why: errorText(inner) }, { cause: inner })
    expect(outer.message).toBe('Could not move it: Card #3 is gone.')
    expect(shownError(outer)).toBe('Konnte sie nicht verschieben: Karte #3 gibt es nicht mehr.')
    expect(outer.cause).toBe(inner)
    // Node's own text (or a CLI's) stays as it came, in both.
    const fromNode = combworkError(M.wrapped, { why: errorText(new Error('EBUSY: resource busy')) })
    expect(shownError(fromNode)).toBe('Konnte sie nicht verschieben: EBUSY: resource busy')
    expect(englishError(fromNode)).toBe('Could not move it: EBUSY: resource busy')
    expect(errorData(new Error('EPERM'))).toEqual({ text: 'EPERM' })
  })

  it('takes the text of a shared helper written for the window, which formats one message with the tr it is given', () => {
    setLanguage('de', GERMAN)
    const text = capturedText((t) => extraArgsProblem('--model x -- y', t))
    expect(text).not.toBeNull()
    const e = new CombworkError(text!, { kind: 'invalid' })
    expect(e.message).toBe(extraArgsProblem('--model x -- y'))
    expect(shownError(e)).toBe(GERMAN['agents.provider.extraArgsDashes'])
    expect(capturedText((t) => extraArgsProblem('--model x', t))).toBeNull()
  })

  it('is formatted for the window by IPC, and any other error is passed on as it is', () => {
    setLanguage('de', GERMAN)
    const shown = windowError(combworkError(M.gone, { n: 7 })) as Error
    expect(shown).not.toBeInstanceOf(CombworkError)
    expect(shown.message).toBe('Karte #7 gibt es nicht mehr.')
    const plain = new Error('CONFLICT')
    expect(windowError(plain)).toBe(plain)
  })
})

describe('IPC (#845)', () => {
  it("tells the window a refused call in the window's language, and in English again after a change back", async () => {
    const ws = createWorkspaceService()
    ws.path = tempDir('hive-errors-ipc-')
    callerWorkspace = ws
    try {
      registerIpc(() => ({}) as never, {} as never)
      const call = (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!({ sender: {}, senderFrame: { parent: null } }, ...args)
      setLanguage('de', GERMAN)
      await expect(call('lanes:end', '')).rejects.toThrow(/^Welche Spur beendet werden soll, fehlt$/)
      // A connection's extra arguments (HI-2122: a project has none of its own).
      config.update((c) => {
        c.accounts = [{ id: 'acc-x', provider: 'claude-code', kind: 'signIn', name: 'X', createdAt: '' }]
        c.connections = [{ id: 'c-x', account: 'acc-x', name: 'X' }]
      })
      await expect(call('connection:update', 'c-x', { extraArgs: '--x -- y' })).rejects.toThrow(GERMAN['agents.provider.extraArgsDashes'])
      setLanguage('en', {})
      await expect(call('lanes:end', '')).rejects.toThrow(/^Which lane to end is required$/)
      // Not a CombworkError (the workspace's own, until E10f converts it): passed on as it is.
      setLanguage('de', GERMAN)
      const plain = await call('files:open', ws.path, 'a.txt').then(() => null, (e: Error) => e)
      expect(plain?.message).toMatch(/^Not a project/)
    } finally {
      callerWorkspace = null
      ws.path = null
      await disposeWorkspaceService(ws)
    }
  })
})

describe('the Agent API (#845)', () => {
  it('answers a CombworkError in English, with the status its kind says, whatever language Combwork shows', () => {
    setLanguage('de', GERMAN)
    expect(apiErrorReply(combworkError(M.gone, { n: 4 }, { kind: 'notFound' }))).toEqual({ status: 404, body: { error: 'Card #4 is gone.' } })
    expect(apiErrorReply(combworkError(msg({ id: 'errors.workspace.none', defaultMessage: 'No workspace is open.', description: 'test' }), undefined, { kind: 'conflict' }))).toEqual({ status: 409, body: { error: 'No workspace is open.' } })
    // Without a kind, the English message says the status, as for any other error.
    expect(apiErrorReply(combworkError(msg({ id: 'errors.test.unknownTask', defaultMessage: 'Unknown task #{n}', description: 'test' }), { n: 9 })).status).toBe(404)
    expect(apiErrorReply(new Error('Unknown task #9'))).toEqual({ status: 404, body: { error: 'Unknown task #9' } })
  })

  it("leaves the window's text as data out where a whole object goes to agents, and only that", () => {
    const history = { at: 'x', by: 'You', what: 'Moved to Review', whatText: { id: 'tasks.history.moved', values: { column: 'review' } }, id: 'h1' }
    const comment = { at: 'x', by: 'Combwork', text: 'Session started', appText: { id: 'tasks.comment.started' }, id: 'c1' }
    expect(entryForAgents(history)).toEqual({ at: 'x', by: 'You', what: 'Moved to Review' })
    expect(entryForAgents(comment)).toEqual({ at: 'x', by: 'Combwork', text: 'Session started' })
    const metrics = { notMeasured: ['Provider network traffic'], notMeasuredText: [M.gone], filters: { scope: 'workspace', notFiltered: ['Trend'], notFilteredText: [M.gone] }, totals: { errorText: { n: 1 } } }
    expect(metricsForAgents(metrics)).toEqual({ notMeasured: ['Provider network traffic'], filters: { scope: 'workspace', notFiltered: ['Trend'] }, totals: { errorText: { n: 1 } } })
    const added = { id: 'a-1', name: 'B2', reuse: { branch: 'b', reused: false, base: 'main', notReused: 'it holds work', notReusedText: M.gone } }
    expect(addedForAgents(added)).toEqual({ id: 'a-1', name: 'B2', reuse: { branch: 'b', reused: false, base: 'main', notReused: 'it holds work' } })
    const plain: { id: string; name: string; reuse?: typeof added.reuse } = { id: 'a-2', name: 'B3' }
    expect(addedForAgents(plain)).toBe(plain)
  })

  it('sends every other reply as it is, whatever names its data uses: a console event keeps its raw payload whole', () => {
    // HR2's round-1 case: a provider's payload whose keys happen to be a companion's name.
    const events = { events: [{ seq: 1, raw: { payload: { statusText: { code: 42 }, problemText: [1, 2], other: 7 } }, made: { errorText: { why: 'x' } } }] }
    expect(JSON.parse(replyText(events))).toEqual(events)
    expect(replyText(undefined)).toBe('')
  })
})
