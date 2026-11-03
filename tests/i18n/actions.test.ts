import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { setLanguage, tr, tRich, type Msg } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'

// #801: the `actions` area (the window's confirms, toasts and errors from actions.ts, and the helpers in util.ts,
// attach.ts and editorDrafts.ts). These are renderer modules the unit tests can't load ('@shared' paths), so the area
// is checked through its catalogue: every message has a note, its plurals have their forms, the English reads as the
// window said it before, and the pseudo-locale translates every one.

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/actions.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const message = (id: string): Msg => {
  expect(EN[id], id).toBeTruthy()
  return { id, ...EN[id] }
}

afterEach(() => setLanguage('en', {}))

/** Each plural in a message, with its option keys. */
function plurals(els: MessageFormatElement[], out: string[][] = []): string[][] {
  for (const el of els) {
    if (el.type === TYPE.plural) out.push(Object.keys(el.options))
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) plurals(o.value, out)
    if (el.type === TYPE.tag) plurals(el.children, out)
  }
  return out
}

/** Every placeholder of a message, given a value that fits it ("x", or 2 for a plural's). */
function sampleValues(els: MessageFormatElement[], out: Record<string, string | number> = {}): Record<string, string | number> {
  for (const el of els) {
    if (el.type === TYPE.argument) out[el.value] ??= 'x'
    if (el.type === TYPE.number || el.type === TYPE.plural) out[el.value] = 2
    if (el.type === TYPE.select) out[el.value] ??= Object.keys(el.options).find((k) => k !== 'other') ?? 'other'
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) sampleValues(o.value, out)
    if (el.type === TYPE.tag) sampleValues(el.children, out)
  }
  return out
}

/** A message's tags (<b>…</b>), each given as a function that keeps its content. */
function tagsOf(els: MessageFormatElement[], out: Record<string, (chunks: string[]) => string> = {}): Record<string, (chunks: string[]) => string> {
  for (const el of els) {
    if (el.type === TYPE.tag) {
      out[el.value] = (chunks) => chunks.join('')
      tagsOf(el.children, out)
    }
    if (el.type === TYPE.plural || el.type === TYPE.select) for (const o of Object.values(el.options)) tagsOf(o.value, out)
  }
  return out
}

describe('the actions area', () => {
  it('every message has a note for translators, and every plural its one and other forms', () => {
    expect(Object.keys(EN).length).toBeGreaterThan(150)
    for (const [id, m] of Object.entries(EN)) {
      expect(id.startsWith('actions.'), id).toBe(true)
      expect(m.description.length, id).toBeGreaterThan(10)
      for (const keys of plurals(parse(m.defaultMessage))) expect(keys, id).toEqual(expect.arrayContaining(['one', 'other']))
    }
  })

  it('the English reads as the window said it before', () => {
    const ago = message('actions.ago.minutes')
    expect(tr(ago, { n: 1 })).toBe('1 minute ago')
    expect(tr(ago, { n: 5 })).toBe('5 minutes ago')
    expect(tr(message('actions.ago.hours'), { n: 1 })).toBe('1 hour ago')
    expect(tr(message('actions.ago.days'), { n: 3 })).toBe('3 days ago')
    expect(tr(message('actions.duration.hoursMinutes'), { h: 1, m: 5 })).toBe('1h 5m')
    expect(tr(message('actions.resets.hours'), { h: 2, min: 14 })).toBe('in 2 h 14 min')
    const large = message('actions.attach.largeTitle')
    expect(tr(large, { n: 1 })).toBe('Attach a large file?')
    expect(tr(large, { n: 3 })).toBe('Attach 3 large files?')
    const detail = message('actions.attach.largeDetail')
    expect(tr(detail, { copy: 'yes' })).toBe('An agent may not manage a file this large: its CLI can refuse it, or reading it can fill much of its context. Combwork keeps a copy with the session.')
    expect(tr(detail, { copy: 'no' })).toBe('An agent may not manage a file this large: its CLI can refuse it, or reading it can fill much of its context.')
  })

  it('under the pseudo-locale every message of the area is translated', () => {
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const id of Object.keys(EN)) {
      const m = message(id)
      const els = parse(m.defaultMessage)
      const tags = tagsOf(els)
      const out = Object.keys(tags).length ? tRich<string>(m, { ...sampleValues(els), ...tags }).join('') : tr(m, sampleValues(els))
      expect(out.startsWith('['), `${id}: ${out}`).toBe(true)
    }
  })
})
