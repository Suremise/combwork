import { describe, expect, it } from 'vitest'
import { appTakesTerminalKey, copyPasteKey, isTyping } from '../src/shared/terminalInput'

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

// All keys go to the CLI (#1292, #966 row 26, Darren's choice on #1120 point 5): off, Hive's bound shortcuts take their
// keys but those the CLI uses itself; on, only the command palette's, so every command stays in reach.
describe('appTakesTerminalKey (#1292)', () => {
  const o = { palette: 'Ctrl+Shift+P', reserved: new Set(['CTRL+B']), bound: ['CTRL+SHIFT+P', 'CTRL+P', 'CTRL+B', 'CTRL+,'] }
  it("off: Hive's bound keys, never one the CLI keeps, never an unbound one", () => {
    const off = { ...o, allKeysToCli: false }
    expect(appTakesTerminalKey('Ctrl+P', off)).toBe(true)
    expect(appTakesTerminalKey('ctrl+,', off)).toBe(true)
    expect(appTakesTerminalKey('Ctrl+Shift+P', off)).toBe(true)
    expect(appTakesTerminalKey('Ctrl+B', off)).toBe(false)
    expect(appTakesTerminalKey('Ctrl+J', off)).toBe(false)
  })
  it("on: every key to the CLI but the palette's shortcut, as the user bound it", () => {
    const on = { ...o, allKeysToCli: true }
    expect(appTakesTerminalKey('Ctrl+P', on)).toBe(false)
    expect(appTakesTerminalKey('Ctrl+,', on)).toBe(false)
    expect(appTakesTerminalKey('Ctrl+B', on)).toBe(false)
    expect(appTakesTerminalKey('Ctrl+Shift+P', on)).toBe(true)
    expect(appTakesTerminalKey('ctrl+shift+p', on)).toBe(true)
    // The palette rebound: its new shortcut stays Hive's, the old one goes to the CLI.
    expect(appTakesTerminalKey('F1', { ...on, palette: 'F1' })).toBe(true)
    expect(appTakesTerminalKey('Ctrl+Shift+P', { ...on, palette: 'F1' })).toBe(false)
    // The palette unbound: nothing of Hive's (it is still in the menus).
    expect(appTakesTerminalKey('Ctrl+Shift+P', { ...on, palette: null })).toBe(false)
  })
  // A two-step palette shortcut (HR4's round 1): its first key starts Hive's chord, its second completes it while that
  // chord is pending; any other key (another chord's second step, the second step alone) goes to the CLI.
  it('on, with the palette rebound to two steps: its first key, then its second while pending; nothing else', () => {
    const chord = { ...o, allKeysToCli: true, palette: 'Mod+K Mod+P', bound: ['MOD+K MOD+P', 'MOD+K MOD+N'] }
    expect(appTakesTerminalKey('Mod+K', chord)).toBe(true)
    expect(appTakesTerminalKey('Mod+P', { ...chord, pending: 'Mod+K' })).toBe(true)
    expect(appTakesTerminalKey('mod+p', { ...chord, pending: 'mod+k' })).toBe(true)
    // A chord of another command sharing its first key: its second step goes to the CLI.
    expect(appTakesTerminalKey('Mod+N', { ...chord, pending: 'Mod+K' })).toBe(false)
    // The second step alone, or after another prefix: the CLI's.
    expect(appTakesTerminalKey('Mod+P', chord)).toBe(false)
    expect(appTakesTerminalKey('Mod+P', { ...chord, pending: 'Mod+J' })).toBe(false)
    // While pending, its first key again isn't a second step.
    expect(appTakesTerminalKey('Mod+K', { ...chord, pending: 'Mod+K' })).toBe(false)
    // Off, chords are never begun from a pane (as before): neither key is Hive's alone.
    expect(appTakesTerminalKey('Mod+K', { ...chord, allKeysToCli: false })).toBe(false)
  })
})
