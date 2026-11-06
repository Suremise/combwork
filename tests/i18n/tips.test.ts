import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { setLanguage, setProblemReporter, tr, tRich, type Msg } from '../../src/shared/i18n'
import { PSEUDO_LANGUAGE } from '../../src/shared/i18n/languages'
import { TIP_GROUP_TEXT, TIP_GROUPS, TIPS } from '../../src/shared/tips'

// #794: the `tips` area. Every tip's title and text are messages, its shortcut a {key} placeholder with the command in
// `key` (so a language puts the shortcut where its sentence needs it), and Help → Tips names its groups by message.

const ROOT = resolve(__dirname, '../..')
const EN = JSON.parse(readFileSync(join(ROOT, 'locales/en/tips.json'), 'utf8')) as Record<string, { defaultMessage: string; description: string }>
const COMMANDS = readFileSync(join(ROOT, 'src/renderer/src/commands.ts'), 'utf8')
const asMsg = (x: string | Msg): Msg => {
  if (typeof x === 'string') throw new Error(`plain text: ${x}`)
  return x
}

const problems: string[] = []
afterEach(() => {
  setLanguage('en', {})
  setProblemReporter(() => undefined)
  problems.length = 0
})

describe('the tips as messages', () => {
  it('every title and text is a message of the tips area, in the English catalogue with a note for translators', () => {
    for (const tip of TIPS)
      for (const m of [asMsg(tip.title), asMsg(tip.text)]) {
        expect(m.id, tip.id).toMatch(/^tips\./)
        expect(EN[m.id], m.id).toEqual({ defaultMessage: m.defaultMessage, description: m.description })
        expect(m.description.length, m.id).toBeGreaterThan(10)
      }
  })

  it('a shortcut is {key} with its command in `key`, a command Combwork has; no old {key:…} is left', () => {
    let keyed = 0
    for (const tip of TIPS) {
      const text = asMsg(tip.text).defaultMessage
      expect(text, tip.id).not.toMatch(/\{key:/)
      expect(text.includes('{key}'), tip.id).toBe(!!tip.key)
      if (tip.key) {
        keyed++
        expect(COMMANDS, `${tip.id}: ${tip.key}`).toContain(`id: '${tip.key}'`)
        expect(asMsg(tip.text).description, tip.id).toContain('{key}')
      }
    }
    expect(keyed).toBeGreaterThanOrEqual(8)
  })

  it('reads as before in English, the shortcut where {key} is', () => {
    const palette = TIPS.find((t) => t.id === 'palette')!
    expect(tr(asMsg(palette.text), { key: 'Ctrl+Shift+P' })).toBe('Press Ctrl+Shift+P and type: every command, with its shortcut.')
    expect(tr(asMsg(TIPS.find((t) => t.id === 'compact-focus')!.title))).toBe('Compact with a focus')
  })

  it('numbers and examples are values, formatted as shown, never written into the words (#911)', () => {
    const shown = (id: string): string => {
      const tip = TIPS.find((t) => t.id === id)!
      return tr(asMsg(tip.text), { ...tip.values?.(), key: '' })
    }
    expect(shown('assistant-compact')).toContain('past 500,000 tokens by default')
    expect(shown('card-cost').replace(/[\u00a0\u202f]/g, ' ')).toContain('"cost: ≈ $1.84 · 2 rounds"')
    expect(shown('date-format')).toContain('Combwork shows dates as 2026-10-04 and times as 14:05.')
    expect(shown('loop-defaults')).toContain('(10 rounds and 6 hours to start with)')
    expect(shown('session-cleanup')).toContain('more than 24 hours, 7 days or 30 days ago')
    expect(shown('git-view')).toContain('The status bar shows "main · origin · ↑2 ↓0": click it')
    for (const id of ['assistant-messages', 'inbox-notices']) expect(shown(id), id).not.toMatch(/\d/)
    const more = TIPS.find((t) => t.id === 'more-agents')!
    expect(tr(asMsg(more.title), more.values?.())).toBe('More than 12 agents')
    // Every placeholder a tip's words have, other than {key}, has a value.
    for (const tip of TIPS)
      for (const m of [asMsg(tip.title), asMsg(tip.text)]) {
        const names = [...m.defaultMessage.matchAll(/\{(\w+)[,}]/g)].map((x) => x[1]).filter((n) => n !== 'key')
        expect(names.filter((n) => !(n in (tip.values?.() ?? {}))), m.id).toEqual([])
      }
  })

  it('a translation puts the shortcut where its language needs it', () => {
    const palette = TIPS.find((t) => t.id === 'palette')!
    setLanguage('ja', { [asMsg(palette.text).id]: 'すべてのコマンドは{key}で。' }, 'ja-JP')
    const KEY = { key: true }
    expect(tRich<typeof KEY>(asMsg(palette.text), { key: KEY })).toEqual(['すべてのコマンドは', KEY, 'で。'])
  })

  it('every tip, and every group heading, shows in another language with no problem reported', () => {
    setProblemReporter((p) => problems.push(p))
    setLanguage(PSEUDO_LANGUAGE, {})
    for (const tip of TIPS) {
      expect(tr(asMsg(tip.title), tip.values?.()), tip.id).toMatch(/^\[/)
      expect(tr(asMsg(tip.text), { ...tip.values?.(), key: 'K' }), tip.id).toMatch(/^\[/)
    }
    expect(Object.keys(TIP_GROUP_TEXT).sort()).toEqual([...TIP_GROUPS].sort())
    for (const g of TIP_GROUPS) expect(tr(TIP_GROUP_TEXT[g]), g).not.toBe(g)
    expect(problems).toEqual([])
  })
})
