import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { clipboardPreview, osc52, osc52Decision, OSC52_MAX_BYTES, OSC52_PREVIEW, OSC52_PREVIEW_LINES } from '../src/shared/osc52'

// What GitHub Copilot CLI 1.0.95 printed when Ctrl+C copied its own mouse selection ("SELECTME alpha beta gamma delta"),
// offline against the stand-in model (#736): a BEL-terminated OSC 52 write between its redraw and "copied to clipboard".
const RECORDED = '\x1b[32;3H\x1b[?25h\x1b[m\x1b]52;c;U0VMRUNUTUUgYWxwaGEgYmV0YSBnYW1tYSBkZWx0YQ==\x07\x1b[?25l\x1b[34;1H \x1b[34mcopied to clipboard'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** The OSC 52 data xterm hands its handler for some program output. */
async function oscData(output: string): Promise<string[]> {
  const term = new Terminal({ allowProposedApi: true })
  const seen: string[] = []
  term.parser.registerOscHandler(52, (data) => {
    seen.push(data)
    return true
  })
  await new Promise<void>((resolve) => term.write(output, resolve))
  term.dispose()
  return seen
}

describe('osc52', () => {
  it("takes Copilot's recorded copy, as xterm parses it", async () => {
    const data = await oscData(RECORDED)
    expect(data).toEqual(['c;U0VMRUNUTUUgYWxwaGEgYmV0YSBnYW1tYSBkZWx0YQ=='])
    expect(osc52(data[0], true)).toEqual({ kind: 'write', text: 'SELECTME alpha beta gamma delta' })
  })

  it('takes the ST terminator, any selection and none, and UTF-8', async () => {
    expect(await oscData(`\x1b]52;c;${b64('a')}\x1b\\`)).toEqual([`c;${b64('a')}`])
    for (const sel of ['c', 'p', 's', '0', 'cp', ''])
      expect(osc52(`${sel};${b64('Grüße — 日本')}`, true), sel).toEqual({ kind: 'write', text: 'Grüße — 日本' })
  })

  it('never answers a read, in use or not', () => {
    expect(osc52('c;?', true)).toEqual({ kind: 'refused', reason: 'read' })
    expect(osc52('c;?', false)).toEqual({ kind: 'refused', reason: 'read' })
  })

  it('refuses a write from a terminal the user is not using', () => {
    expect(osc52(`c;${b64('x')}`, false)).toEqual({ kind: 'refused', reason: 'not-in-use' })
  })

  it('refuses more than OSC52_MAX_BYTES and takes up to it', () => {
    const max = 'a'.repeat(OSC52_MAX_BYTES)
    expect(osc52(`c;${b64(max)}`, true)).toEqual({ kind: 'write', text: max })
    expect(osc52(`c;${b64(max + 'a')}`, true)).toEqual({ kind: 'refused', reason: 'too-large' })
    expect(osc52(`c;${'A'.repeat(OSC52_MAX_BYTES * 2)}`, true)).toEqual({ kind: 'refused', reason: 'too-large' })
  })

  it('changes nothing for an empty or malformed payload', () => {
    for (const data of ['c;', 'c', '', 'c;not base64!', 'c;QQ===', 'c;A'])
      expect(osc52(data, true), JSON.stringify(data)).toEqual({ kind: 'refused', reason: 'invalid' })
  })
})

// The policy (#1292, #966 row 27, Darren's choice: Allow as before, Ask each time, Block; reads never allowed).
describe('osc52Decision (#1292)', () => {
  const write = osc52(`c;${b64('copied')}`, true)
  it('Allow (the default) writes, Ask asks first with the text, Block refuses', () => {
    expect(osc52Decision(write, 'allow')).toEqual({ write: 'copied' })
    expect(osc52Decision(write, undefined)).toEqual({ write: 'copied' })
    expect(osc52Decision(write, 'ask')).toEqual({ ask: 'copied' })
    expect(osc52Decision(write, 'block')).toEqual({ refuse: 'blocked' })
  })
  it('a read, a write from a terminal not in use, or a bad one is refused whatever the policy', () => {
    for (const policy of ['allow', 'ask', 'block']) {
      expect(osc52Decision(osc52('c;?', true), policy)).toEqual({ refuse: 'read' })
      expect(osc52Decision(osc52(`c;${b64('x')}`, false), policy)).toEqual({ refuse: 'not-in-use' })
      expect(osc52Decision(osc52('c;not base64!', true), policy)).toEqual({ refuse: 'invalid' })
    }
  })
})

// What the question shows of a write (#1292, the Assistant's screenshot note): its first lines in the dialog's box, cut
// after a few, with how many characters it leaves out.
describe('clipboardPreview (#1292)', () => {
  it('shows a short text whole, line by line, with nothing left out', () => {
    expect(clipboardPreview('one line')).toEqual({ lines: ['one line'], more: 0 })
    expect(clipboardPreview('a\nb\r\nc')).toEqual({ lines: ['a', 'b', 'c'], more: 0 })
  })
  it('cuts after its lines or its characters, counting every character not shown', () => {
    const many = Array.from({ length: OSC52_PREVIEW_LINES + 3 }, (_, i) => `line ${i}`).join('\n')
    const p = clipboardPreview(many)
    expect(p.lines).toHaveLength(OSC52_PREVIEW_LINES)
    expect(p.more).toBe(many.length - p.lines.join('\n').length)
    const long = 'x'.repeat(OSC52_PREVIEW + 40)
    expect(clipboardPreview(long)).toEqual({ lines: ['x'.repeat(OSC52_PREVIEW)], more: 40 })
  })
})
