import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { msg, setLanguage, setProblemReporter, tr } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { finishedNotice, type Finish } from '../../src/shared/bursts'
import { reloadedMessage } from '../../src/main/rendererWatch'
import { cantStartMessage } from '../../src/main/installDir'

// #796: the `main` area, the main process's own text: the tray, notices and dialogs (quit, crashes, updates, the
// install folder), and the errors and reports of what it does for the window (Initialise Git Repository, Remove
// project, unused worktrees, Clean Up, Repair after a move). Copy Diagnostics' report and the Agent API's metrics stay
// English (the design keeps diagnostics content English), each line marked.

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/main.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const FILES = ['antivirus', 'bundled', 'consoleWindow', 'diagnostics', 'gitInit', 'index', 'installDir', 'metricsUsage', 'planUsage', 'projectRemoval', 'rendererWatch', 'storage', 'tray', 'unusedWorktrees', 'updater', 'workspaceMove']
  .map((f) => `src/main/${f}.ts`)
  .concat('src/shared/bursts.ts')

/** An agent's finish, as main's notifications group them. */
const fin = (project: string, agent: string): Finish => ({ projectPath: `D:/ws/${project}`, project, agent, title: '', body: '' })

const problems: string[] = []
afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  problems.length = 0
})

/** Values for a message's placeholders: a number where it counts or picks by number, a select's `other`, else text. */
function valuesOf(els: MessageFormatElement[], acc: Record<string, string | number> = {}): Record<string, string | number> {
  for (const el of els) {
    if (el.type === TYPE.argument) acc[el.value] ??= 'X'
    else if (el.type === TYPE.number || el.type === TYPE.plural) acc[el.value] = 2
    else if (el.type === TYPE.select) acc[el.value] = 'other'
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) valuesOf(o.value, acc)
  }
  return acc
}
/** A catalogue message, as code would show it. */
const shown = (id: string): string => tr(msg({ id, defaultMessage: EN[id].defaultMessage, description: EN[id].description }), valuesOf(parse(EN[id].defaultMessage)) as never)

describe('the main area', () => {
  it('every message is of the main area, with a note for translators', () => {
    const ids = Object.keys(EN)
    expect(ids.length).toBeGreaterThan(150)
    for (const id of ids) {
      expect(id).toMatch(/^main\./)
      expect(EN[id].description.length, id).toBeGreaterThan(10)
    }
  })

  it('each file of the area has no text left to convert, and imports its messages (the diagnostics ones marked English)', () => {
    for (const f of FILES) {
      expect(existsSync(join(ROOT, 'i18n/allow', `${f.replace(/\//g, '__')}.json`)), f).toBe(false)
      const src = readFileSync(join(ROOT, f), 'utf8')
      if (f.endsWith('diagnostics.ts') || f.endsWith('metricsUsage.ts')) expect(src, f).toMatch(/i18n-ignore: .*English/)
      else expect(src, f).toMatch(/from '\.\.?\/(shared\/)?i18n'/)
    }
  })

  it('reads as before in English', () => {
    expect(reloadedMessage(0)).toBe('Your agents kept running.')
    expect(reloadedMessage(1)).toBe('Your agents kept running. Unsaved changes to one file were lost.')
    expect(reloadedMessage(3)).toBe('Your agents kept running. Unsaved changes to 3 files were lost.')
    expect(finishedNotice([fin('site', 'B1'), fin('site', 'B2')])).toEqual({ title: '2 agents finished in site', body: 'B1, B2' })
    expect(finishedNotice([fin('site', 'B1'), fin('api', 'B2'), fin('site', 'B3')])).toEqual({ title: '3 agents finished', body: 'site (2), api (1)' })
  })

  it('every message formats in another language with no problem reported', () => {
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const id of Object.keys(EN)) expect(shown(id), id).toMatch(/^\[/)
    expect(problems).toEqual([])
  })

  it('a translation is what shows: the crash notice, the finished notification, the install folder message', () => {
    setProblemReporter((p) => problems.push(p))
    setLanguage('pl', {
      'main.window.reloadedLost': '{n, plural, one {Agenci działają. Utracono zmiany w jednym pliku.} few {Agenci działają. Utracono zmiany w # plikach.} many {Agenci działają. Utracono zmiany w # plikach.} other {Agenci działają. Utracono zmiany w # pliku.}}',
      'main.finished.inProject': '{n} agentów skończyło w {project}'
    }, 'pl-PL')
    expect(reloadedMessage(3)).toBe('Agenci działają. Utracono zmiany w 3 plikach.')
    expect(finishedNotice([fin('site', 'B1'), fin('site', 'B2')]).title).toBe('2 agentów skończyło w site')
    setLanguage(PSEUDO_LANGUAGE, {})
    const m = cantStartMessage('C:\\Combwork')
    expect([m.title, m.text].every((t) => t.startsWith('['))).toBe(true)
    expect(m.command).not.toMatch(/^\[/)
    expect(problems).toEqual([])
  })
})
