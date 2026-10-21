import { describe, expect, it } from 'vitest'
import { copyPasteKey, isTyping } from '../src/shared/terminalInput'

describe('isTyping', () => {
  it("ignores xterm's replies to the program", () => {
    for (const reply of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[?62;22c',
      '\x1b[>0;276;0c',
      '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
      '\x1b]10;rgb:cccc/cccc/cccc\x07',
      '\x1bP>|xterm.js(5.5.0)\x1b\\',
      '\x1b[?1u\x1b]11;rgb:0000/0000/0000\x1b\\'
    ])
      expect(isTyping(reply), JSON.stringify(reply)).toBe(false)
  })

  it('counts keys, Enter and pastes as typing', () => {
    for (const keys of ['a', '\r', '\x7f', '\x03', 'hello world', '\x1b[200~pasted\x1b[201~']) expect(isTyping(keys), JSON.stringify(keys)).toBe(true)
  })
})

describe('copyPasteKey (#1286)', () => {
  const key = (k: string, more: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, ...more })

  it("by default (the switch off), Hive's copy with a selection and paste; Ctrl+C with none goes on to the CLI", () => {
    expect(copyPasteKey(key('c'), false, true)).toBe('copy')
    expect(copyPasteKey(key('C'), false, true)).toBe('copy')
    expect(copyPasteKey(key('c'), false, false)).toBeNull()
    expect(copyPasteKey(key('v'), false, false)).toBe('paste')
    expect(copyPasteKey(key('V'), false, true)).toBe('paste')
  })

  it('with the switch on, both go to the CLI, a selection or not', () => {
    for (const k of ['c', 'C', 'v', 'V']) for (const sel of [true, false]) expect(copyPasteKey(key(k), true, sel), `${k} ${sel}`).toBe('cli')
  })

  it('other keys, Alt chords and keys without Ctrl are none of its business, either way', () => {
    for (const toCli of [true, false]) {
      expect(copyPasteKey(key('x'), toCli, true)).toBeNull()
      expect(copyPasteKey(key('v', { altKey: true }), toCli, true)).toBeNull()
      expect(copyPasteKey(key('c', { ctrlKey: false }), toCli, true)).toBeNull()
      expect(copyPasteKey(key('v', { ctrlKey: false, metaKey: true }), toCli, true)).toBe(toCli ? 'cli' : 'paste')
    }
  })
})
