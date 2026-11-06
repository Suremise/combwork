// The question the Assistant's stop asks the user (HI-1994) is the window's text (HI-2449): shown in the language Combwork
// shows, in the panel and in its notification, while its English (the log's, the event stream's title) is word for word
// what Combwork asked before.
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { setLanguage } from '../src/shared/i18n'
import { shownText } from '../src/shared/advanced'

const base = tempDir('cw-stop-question-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { stopQuestion } = await import('../src/main/assistantControl')

/** The question as Combwork asked it before HI-2449, from servers.ts's code then: the English it keeps. */
const STATUS_WORDS: Record<string, string> = {
  working: 'working',
  waiting: 'waiting for the user',
  signin: 'waiting for the user to sign in to its CLI again (its sign-in expired)',
  starting: 'starting',
  background: 'waiting on background tasks it started',
  watching: 'waiting for cards to change (a card watch: its card loop pauses until it is resumed)',
  ready: 'idle',
  finished: 'idle (finished its task)',
  error: 'in error',
  stopped: 'stopped'
}
const before = (agent: string, project: string, status: string, said: string) => {
  const reason = said ? ` Its reason: ${said}${/[.!?]$/.test(said) ? '' : '.'}` : ''
  return { title: `Stop ${agent} in ${project}?`, message: `The Assistant wants to stop ${agent}, which is ${STATUS_WORDS[status] ?? status}.${reason} Its conversation is kept and can be resumed.`, yes: 'Stop', no: "Don't stop" }
}

const german = (): Record<string, string> => JSON.parse(readFileSync(join(__dirname, '..', 'locales', 'de', 'main.json'), 'utf8'))

afterEach(() => setLanguage('en', {}))

describe("the Assistant's stop question", () => {
  it('keeps the English it had, for every status, with a reason or none', () => {
    for (const status of [...Object.keys(STATUS_WORDS), 'somethingNew'])
      for (const reason of ['', 'it is stuck', 'It loops!', 'Done?'])
        expect(stopQuestion({ agent: 'b1', project: 'webapp', status, reason }), `${status} ${reason}`).toMatchObject(before('b1', 'webapp', status, reason))
  })

  it("is shown in the language Combwork shows, while its English stays the log's", () => {
    setLanguage('de', german())
    const q = stopQuestion({ agent: 'b1', project: 'webapp', status: 'waiting', reason: 'es hängt' })
    expect(shownText(q.text!.title)).toBe('b1 in webapp stoppen?')
    expect(shownText(q.text!.message)).toBe('Der Assistent möchte b1 stoppen, der gerade auf dich wartet. Seine Begründung: es hängt. Die Unterhaltung bleibt erhalten und lässt sich fortsetzen.')
    expect([shownText(q.text!.yes), shownText(q.text!.no)]).toEqual(['Stoppen', 'Nicht stoppen'])
    expect(q.title).toBe('Stop b1 in webapp?')
    // A status the window has no words for is named as Combwork names it.
    expect(shownText(stopQuestion({ agent: 'b1', project: 'webapp', status: 'somethingNew', reason: '' }).text!.message)).toContain('der gerade somethingNew.')
  })
})
