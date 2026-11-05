import { describe, expect, it } from 'vitest'
import { copilot } from '../src/main/providers/copilot/adapter'
import { ScreenRecognition } from '../src/main/screenRecognition'

// What Combwork recognises on a CLI's screen once a launch (#638 round 3), for the developer console's contract markers:
// with Copilot's own patterns, the prompt is recognised however its output is split and coloured, once, and with no
// regard to the agent's status (a transcript making it ready first, the timing that hid Combwork's status marker); the
// footer's mode the first time one shows; a changed prompt or footer never.
const PROMPT = '\x1b[2m~/demo\x1b[0m  \x1b[90m· / commands · ? help\x1b[0m'

describe('ScreenRecognition', () => {
  it("recognises Copilot's prompt across chunks and colours, once a launch", () => {
    const r = new ScreenRecognition(copilot)
    expect(r.output('Loading… ')).toBe(false)
    expect(r.output(PROMPT.slice(0, 20))).toBe(false)
    expect(r.output(PROMPT.slice(20))).toBe(true)
    expect(r.output(PROMPT)).toBe(false)
  })

  it('needs nothing of the status: a prompt drawn after the agent was made ready elsewhere is still recognised', () => {
    // Combwork's own ready marker is only taken while the agent is starting; this has no status at all.
    const r = new ScreenRecognition(copilot)
    for (const chunk of ['Welcome to GitHub Copilot CLI\r\n', '\x1b[?25l', 'some reply text\r\n']) expect(r.output(chunk)).toBe(false)
    expect(r.output(PROMPT)).toBe(true)
  })

  it('never recognises a prompt the CLI changed', () => {
    const r = new ScreenRecognition(copilot)
    expect(r.output('~/demo  · /help for commands ·')).toBe(false)
    expect(r.output('> ')).toBe(false)
  })

  it("takes the footer's mode the first time one shows, and only then", () => {
    const r = new ScreenRecognition(copilot)
    expect(r.footerOf('Loading…', 'accept-edits')).toBeNull()
    expect(r.footerOf(' · Interactive · Manual Approval · / commands', 'accept-edits')).toBe('accept-edits')
    expect(r.footerOf(' · Plan · Manual Approval · / commands', 'accept-edits')).toBeNull()
  })

  it('does nothing for a CLI without the patterns', () => {
    const r = new ScreenRecognition({})
    expect(r.output(PROMPT)).toBe(false)
    expect(r.footerOf(' · Plan · / commands', null)).toBeNull()
  })
})
