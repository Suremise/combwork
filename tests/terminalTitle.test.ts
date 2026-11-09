import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADVANCED_DEFS, advancedRegExp } from '../src/shared/advanced'
import { lastTerminalTurn, lastTitle, type TerminalTurn } from '../src/main/terminalTitle'

/** Feeds output in pieces, as the terminal delivers it: the titles each piece shows (null: none). */
function feed(...pieces: string[]): (string | null)[] {
  let carry = ''
  return pieces.map((p) => {
    const r = lastTitle(carry, p)
    carry = r.carry
    return r.title
  })
}

describe('terminal titles', () => {
  it('reads OSC 0 and 2, ended by BEL or ST; the last one in a piece wins', () => {
    expect(lastTitle('', 'x\x1b]0;demo\x07y').title).toBe('demo')
    expect(lastTitle('', '\x1b]2;[ ! ] Action Required | demo\x1b\\').title).toBe('[ ! ] Action Required | demo')
    expect(lastTitle('', '\x1b]0;one\x07\x1b[2J\x1b]0;two\x07').title).toBe('two')
    expect(lastTitle('', 'plain output').title).toBeNull()
  })

  it('a title split across pieces, anywhere, is read once it is whole', () => {
    const t = '\x1b]0;[ ! ] Action Required | demo\x07'
    for (let i = 1; i < t.length; i++) expect(feed('a' + t.slice(0, i), t.slice(i) + 'b'), `split at ${i}`).toEqual([null, '[ ! ] Action Required | demo'])
    // Ended by ST, split between its two characters.
    expect(feed('\x1b]0;demo\x1b', '\\')).toEqual([null, 'demo'])
  })

  it("other sequences aren't titles, and aren't kept waiting", () => {
    // A hyperlink (OSC 8) and colours.
    expect(lastTitle('', '\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b[31mred').title).toBeNull()
    expect(lastTitle('', 'text \x1b]8;;https://x').carry).toBe('')
    // A title that never ends isn't kept forever.
    expect(lastTitle('', '\x1b]0;' + 'x'.repeat(2000)).carry).toBe('')
    expect(lastTitle('', 'done\x1b]0;demo\x07').carry).toBe('')
  })
})

describe("a CLI's turn state in its terminal (HI-2802)", () => {
  const def = ADVANCED_DEFS.find((d) => d.id === 'copilot.terminal.turn')!
  const re = advancedRegExp(def, def.default as string)
  /** Feeds output in pieces: the state each piece says (null: none). */
  function turns(...pieces: string[]): (TerminalTurn | null)[] {
    let carry = ''
    return pieces.map((p) => {
      const r = lastTerminalTurn(re, carry, p)
      carry = r.carry
      return r.turn
    })
  }

  it("reads Copilot's recorded OSC 7501 sequences, in order, and nothing else they wrote", () => {
    const rec = JSON.parse(readFileSync(join(__dirname, 'fixtures/advanced/terminal-turn-copilot-1.0.106.json'), 'utf8')) as { osc: string[] }
    const said = rec.osc.map((p) => lastTerminalTurn(re, '', `\x1b]${p}\x07`).turn)
    // Each 7501 payload says its state; Windows Terminal's progress (OSC 9;4) says none.
    expect(said.filter((t) => t !== null)).toEqual(rec.osc.filter((p) => p.startsWith('7501;')).map((p) => (p.includes('state=working') ? 'working' : p.includes('state=done') ? 'done' : 'idle')))
    expect(said).toContain('working')
    expect(said).toContain('done')
    expect(rec.osc.filter((p) => p.startsWith('9;4;')).every((p) => lastTerminalTurn(re, '', `\x1b]${p}\x07`).turn === null)).toBe(true)
  })

  it('the last state in a piece wins, ended by BEL or ST; titles and other output say none', () => {
    expect(turns('\x1b]7501;state=working:app=copilot\x07out\x1b]9;4;3;0\x07')).toEqual(['working'])
    expect(turns('\x1b]7501;state=working:app=copilot\x07\x1b]7501;state=done:app=copilot\x1b\\')).toEqual(['done'])
    expect(turns('\x1b]7501;state=idle:app=copilot\x07')).toEqual(['idle'])
    expect(turns('\x1b]0;say hi - GitHub Copilot\x07', 'plain', '\x1b[2J')).toEqual([null, null, null])
  })

  it('a sequence split across pieces, anywhere, is read once it is whole', () => {
    const s = '\x1b]7501;state=done:app=copilot\x07'
    for (let i = 1; i < s.length; i++) expect(turns('a' + s.slice(0, i), s.slice(i) + 'b'), `split at ${i}`).toEqual([null, 'done'])
    // One that never ends isn't kept forever.
    expect(lastTerminalTurn(re, '', '\x1b]7501;' + 'x'.repeat(2000)).carry).toBe('')
  })
})
