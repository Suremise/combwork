import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { setLanguage, setProblemReporter, tr, type Msg } from '../../src/shared/i18n'

// #803: the `files` area (the Files tab, its file views, DocEditor, the Attachments tab). Its messages are read from the
// English catalogue (the code's messages, extracted: tests/i18nCatalogues.test.ts checks it is current); the sentences
// that were glued together or pluralised by hand read as they did in English.

const ROOT = resolve(__dirname, '../..')
const CATALOGUE = JSON.parse(readFileSync(join(ROOT, 'locales/en/files.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const M: Record<string, Msg> = Object.fromEntries(Object.entries(CATALOGUE).map(([id, m]) => [id, { id, ...m }]))
const m = (id: string): Msg => {
  expect(M[id], id).toBeTruthy()
  return M[id]
}

afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
})

/** A message's placeholders (tags aside). */
function placeholders(els: MessageFormatElement[], acc = new Set<string>()): Set<string> {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) continue
    if (el.type !== TYPE.tag) acc.add(el.value)
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) placeholders(o.value, acc)
    if (el.type === TYPE.tag) placeholders(el.children, acc)
  }
  return acc
}

/** Some value for each placeholder: a number where it is a plural's. */
function sampleValues(message: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (el.type === TYPE.plural) out[el.value] = 2
      else if (el.type === TYPE.argument || el.type === TYPE.select || el.type === TYPE.number) out[el.value] ??= el.type === TYPE.number ? 2 : 'X'
      if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) walk(o.value)
      if (el.type === TYPE.tag) walk(el.children)
    }
  }
  walk(parse(message))
  return out
}

describe('the files area', () => {
  it('has its messages, each with a note for translators, all under files.', () => {
    expect(Object.keys(CATALOGUE).length).toBeGreaterThan(100)
    for (const [id, c] of Object.entries(CATALOGUE)) {
      expect(id.startsWith('files.'), id).toBe(true)
      expect(c.description.length, id).toBeGreaterThan(10)
    }
  })

  it("its typed values list every message's placeholders", () => {
    const dts = readFileSync(join(ROOT, 'src/shared/i18n/values/files.d.ts'), 'utf8')
    for (const [id, c] of Object.entries(CATALOGUE)) {
      const line = dts.split(/\r?\n/).find((l) => l.trim().startsWith(`'${id}':`))
      expect(line, id).toBeTruthy()
      const names = [...placeholders(parse(c.defaultMessage))]
      if (!names.length) expect(line, id).toMatch(/: undefined$/)
      for (const n of names) expect(line, `${id}: ${n}`).toContain(`${n}: `)
    }
  })

  it('the pseudo-locale formats every message, with nothing reported', () => {
    const problems: string[] = []
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const [id, c] of Object.entries(CATALOGUE)) {
      if (/<\w+>/.test(c.defaultMessage)) continue
      const out = tr(M[id], sampleValues(c.defaultMessage))
      expect(out, id).toMatch(/^\[.*\]$/s)
      // Its words are changed; a message with none (files.root.place, "{agent} · {place}") has nothing to change.
      const text = c.defaultMessage.replace(/\{[^}]*\}/g, '').trim()
      if (/\p{L}/u.test(text)) expect(out, id).not.toContain(text)
    }
    expect(problems).toEqual([])
  })
})

describe('the sentences once built by hand read as before, in English', () => {
  it('deleting in the Files tab', () => {
    expect(tr(m('files.trash.message'), { count: 1, name: 'src', folder: 'yes' })).toBe('Move "src" and everything in it to the Recycle Bin?')
    expect(tr(m('files.trash.message'), { count: 1, name: 'a.ts', folder: 'no' })).toBe('Move "a.ts" to the Recycle Bin?')
    expect(tr(m('files.trash.message'), { count: 3, name: 'a.ts', folder: 'no' })).toBe('Move 3 items to the Recycle Bin?')
    expect(tr(m('files.trash.detail'), { unsaved: 0, file: '' })).toBe('You can restore it from the Recycle Bin.')
    expect(tr(m('files.trash.detail'), { unsaved: 1, file: 'src/a.ts' })).toBe('You can restore it from the Recycle Bin. Unsaved changes to src/a.ts will be lost.')
    expect(tr(m('files.trash.detail'), { unsaved: 4, file: 'src/a.ts' })).toBe('You can restore it from the Recycle Bin. Unsaved changes to 4 files will be lost.')
  })

  it("a file's details", () => {
    expect(tr(m('files.git.status'), { status: 'M' })).toBe('Modified')
    expect(tr(m('files.git.status'), { status: 'U' })).toBe('Untracked')
    expect(tr(m('files.git.status'), { status: 'T' })).toBe('T')
    expect(tr(m('files.git.inFolder'), { status: 'Added' })).toBe('Added (contains changes)')
    expect(tr(m('files.details.extFile'), { ext: 'PNG' })).toBe('PNG file')
    expect(tr(m('files.details.selected'), { count: 2 })).toBe('2 items selected')
    expect(tr(m('files.root.worktree'), { agent: 'One', branch: 'hive/one' })).toBe("One's worktree · hive/one")
    expect(tr(m('files.csv.firstRows'), { count: 5000 })).toBe('Showing the first 5,000 rows. Switch to Edit to see everything.')
  })

  it("a session's attachments, and the Assistant's conversations'", () => {
    expect(tr(m('files.attachments.total'), { host: 'project', total: 5, groups: 1 })).toBe('5 in 1 session')
    expect(tr(m('files.attachments.total'), { host: 'assistant', total: 5, groups: 2 })).toBe('5 in 2 conversations')
    expect(tr(m('files.attachments.groupSpan'), { count: 1, days: 'one', from: 'today', to: 'today' })).toBe('1 attachment · today')
    expect(tr(m('files.attachments.groupSpan'), { count: 71, days: 'more', from: 'Oct 9', to: 'today' })).toBe('71 attachments · Oct 9 – today')
    expect(tr(m('files.attachments.groupDeleteTitle'), { count: 1 })).toBe('Move 1 attachment to the Recycle Bin?')
    expect(tr(m('files.attachments.groupDeleteMessage'), { count: 1, name: 'Fix' })).toBe('Move the attachment of "Fix" to the Recycle Bin?')
    expect(tr(m('files.attachments.groupDeleteMessage'), { count: 3, name: 'Fix' })).toBe('Move all 3 attachments of "Fix" to the Recycle Bin?')
    expect(tr(m('files.attachments.groupDeleteDetail'), { filtered: 'yes', host: 'project' })).toBe(
      'All of its attachments go, whatever the filter shows. The session keeps its transcript, which still mentions their paths. You can restore them from the Recycle Bin.'
    )
    expect(tr(m('files.attachments.groupDeleteDetail'), { filtered: 'no', host: 'assistant' })).toBe('The conversation keeps its transcript, which still mentions their paths. You can restore them from the Recycle Bin.')
    expect(tr(m('files.attachments.groupDeleted'), { count: 2 })).toBe('Moved 2 attachments to the Recycle Bin.')
    expect(tr(m('files.attachments.running'), { host: 'assistant' })).toBe('Its conversation is running')
    expect(tr(m('files.attachments.archived'), { host: 'project' })).toBe('Archived sessions')
    expect(tr(m('files.attachments.unnamed'), { host: 'project', id: '0b6a3c1e' })).toBe('Session 0b6a3c1e')
    expect(tr(m('files.attachments.groupDelete'), { host: 'assistant' })).toBe("Delete This Conversation's Attachments…")
  })
})
