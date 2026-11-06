import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { setLanguage, tr } from '../../src/shared/i18n'
import { msg } from '../../src/shared/i18n/msg'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { attachmentLabel } from '../../src/shared/attachments'
import { removedAgentName, sessionOrigin } from '../../src/shared/sessionOrigin'
import { countText, notFromAgent } from '../../src/shared/sessionTree'

// #802: the `sessions` area (the Sessions tab's chrome, attachment chips). Its words are in the user's language; what
// a session holds (prompts, replies, its name, paths, agent names) is never translated.

const ROOT = resolve(__dirname, '../..')
const PROJECT = 'C:\\ws\\alpha'

afterEach(() => setLanguage('en', {}))

/** Text the pseudo-locale made: in brackets, with no plain English word of the chrome left in it. */
const pseudo = (s: string): boolean => s.includes('[') && !/\b(?:the|and|of|in|its|it|agent|session|sessions|folder|removed|path|itself)\b/.test(s)

const origins = () => [
  sessionOrigin(PROJECT, [{ id: 'a-1', name: 'Coder' }], { source: 'combwork', agentId: 'a-1', agentName: 'Coder', cwd: PROJECT } as never)!,
  sessionOrigin(PROJECT, [], { source: 'combwork', agentId: 'a-2', agentName: 'Helper', cwd: 'C:\\ws\\alpha-wt\\b1', branch: 'cw/b1' } as never)!,
  sessionOrigin(PROJECT, [], { source: 'combwork', agentId: 'a-3', cwd: PROJECT } as never)!,
  sessionOrigin(PROJECT, [], { source: 'combwork', cwd: PROJECT } as never)!
]

describe('the sessions area', () => {
  it('locales/en/sessions.json has a note for translators on every message', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en/sessions.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    expect(Object.keys(en).length).toBeGreaterThan(80)
    for (const [id, m] of Object.entries(en)) {
      expect(id.startsWith('sessions.'), id).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
    }
  })

  it('the English reads as the Sessions tab said it before, for one and for many', () => {
    expect([countText({ sessions: 0, subs: 0 }), countText({ sessions: 1, subs: 0 }), countText({ sessions: 3, subs: 12 }), countText({ sessions: 0, subs: 1 })]).toEqual(['no sessions', '1 session', '3 sessions and 12 sub-sessions', '1 sub-session'])
    expect(notFromAgent()).toBe('Not from an agent')
    expect([removedAgentName('Coder'), removedAgentName(null)]).toEqual(['Coder (removed)', 'Removed agent'])
    const [mine, gone, unnamed, none] = origins()
    expect(mine).toEqual({ agent: 'Coder', location: 'Project folder', label: 'Coder · Project folder', detail: `Ran in ${PROJECT}\nAgent Coder (a-1).` })
    expect(gone.label).toBe('Helper (removed) · Worktree · cw/b1')
    expect(gone.detail).toBe('Ran in C:\\ws\\alpha-wt\\b1\nIts agent (a-2) has since been removed.')
    expect(unnamed.agent).toBe('Removed agent')
    expect(none.detail).toBe(`Ran in ${PROJECT}\nNo agent recorded (adopted, or from before Combwork recorded agents).`)
    expect(attachmentLabel('image', ['image'], 'Claude Code')).toEqual({ label: 'Image', native: true, detail: 'Claude Code sees the image itself.' })
    expect(attachmentLabel('pdf', ['image'], 'Codex')).toEqual({ label: 'PDF · by path', native: false, detail: "Codex doesn't read PDFs itself: the agent gets its path and opens it with its tools." })
    expect(attachmentLabel('file', [], 'Codex').detail).toBe("Codex doesn't read this kind of file itself: the agent gets its path and opens it with its tools.")
  })

  it('under the pseudo-locale the chrome translates, and names and paths stay as they are', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    const texts = [countText({ sessions: 3, subs: 2 }), countText({ sessions: 0, subs: 0 }), notFromAgent(), removedAgentName(null), ...origins().flatMap((o) => [o.location, o.detail]), attachmentLabel('pdf', [], 'Codex').detail, attachmentLabel('pdf', [], 'Codex').label, attachmentLabel('text', ['text'], 'Codex').detail]
    for (const t of texts) expect(pseudo(t), t).toBe(true)
    const [mine, gone] = origins()
    expect(mine.agent).toBe('Coder')
    expect(gone.detail).toContain('C:\\ws\\alpha-wt\\b1')
    expect(gone.location).toContain('cw/b1')
  })

  // #815: translators work from locales/en, so its English keeps the source's line breaks and separators. A language
  // whose text is the catalogue's English as written reads exactly as the source's English does.
  it("a translation made from the catalogue's English keeps its line breaks and the usage line's separators", () => {
    const catalogue = (area: string) => JSON.parse(readFileSync(join(ROOT, `locales/en/${area}.json`), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
    const en = { ...catalogue('sessions'), ...catalogue('panes'), ...catalogue('project') }
    const ids = ['sessions.view.usage', 'project.settings.inheritList']
    const messages = ids.map((id) => msg({ id, defaultMessage: en[id].defaultMessage, description: en[id].description }))
    const values = { context: '120K', output: '8K', prompts: 3, compactions: 1, left: '4m', session: 'S', since: 'today', id: 'abc', branch: 'cw/b1', path: 'C:\\wt', base: 'main', value: 'a\nb' }
    const shown = (cache: string) => messages.map((m) => tr(m as never, { ...values, cache } as never))
    const english = shown('warm')
    expect(english[0]).toBe('120K context · 8K output · 3 prompts · 1 compaction · cache warm 4m')
    expect(shown('expired')[0]).toBe('120K context · 8K output · 3 prompts · 1 compaction · cache expired')
    expect(shown('none')[0]).toBe('120K context · 8K output · 3 prompts · 1 compaction')
    expect(english.slice(1).map((t) => t.split('\n').length)).toEqual([3])
    setLanguage('pl', Object.fromEntries(ids.map((id) => [id, en[id].defaultMessage])))
    expect(shown('warm')).toEqual(english)
  })
})
