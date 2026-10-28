// How Hive puts a prompt into a CLI (#597, SessionManager.sendPrompt): a CLI that reads a bracketed paste as text
// (Claude Code) gets the line as one while its terminal has bracketed paste on, so a busy CLI reading Hive's Ctrl+U,
// the line and its Enter in one go still sends it; a slash command, a CLI without the capability, or one with
// bracketed paste off gets it typed in pieces, as before. The real helpers, on a stand-in live session; the terminal's
// writes are recorded, never sent.
import { afterEach, describe, expect, it, vi } from 'vitest'

// The CLI's echo (#600): with `echo.to` set, what Hive types is drawn on that screen, as a CLI reading its input draws it.
const { writes, echo } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } } }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void (writes.push(data), echo.to?.write(data)) }))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { TerminalScreen } = await import('../src/main/terminalScreen')
const { advanced } = await import('../src/main/advanced')
const { PROMPT_AS_TYPED, PROMPT_CLEAR_DRAFT, drawnWaitId } = await import('../src/shared/advanced')
const { promptInput, typedPrompt, withoutInvisible } = await import('../src/main/sessions')
const { TYPED_NEWLINE_KEYS } = await import('../src/shared/terminalInput')

describe('a prompt Hive puts into a CLI (#597)', () => {
  const p = 'C:/hive-test/pasted-prompt'
  const id = 'b1'
  const s = sessions as unknown as { live: Map<string, unknown> }
  const liveKey = `${p.toLowerCase()}#${id}`
  const screens: InstanceType<typeof TerminalScreen>[] = []
  /** An idle launch of `adapter` whose screen has had `output` (the CLI's own) drawn on it. */
  const running = async (adapter: unknown, output: string) => {
    const screen = new TerminalScreen(60, 20)
    screens.push(screen)
    await new Promise<void>((r) => screen.write(output, r))
    s.live.set(liveKey, { state: { runId: 'r1', status: 'ready', projectPath: p, agentId: id, agentName: 'B1' }, adapter, screen, prompts: 0 })
    return screen
  }
  afterEach(() => {
    s.live.delete(liveKey)
    writes.length = 0
    echo.to = null
    vi.useRealTimers()
    // A test that failed while Hive was typing mustn't leave the next one refused as busy.
    ;(sessions as unknown as { delivering: Set<string> }).delivering.clear()
    for (const x of screens.splice(0)) x.dispose()
  })
  const typedText = (): string => writes.slice(1, -1).join('')

  it('Claude Code with bracketed paste on gets the line as one paste, between Ctrl+U and Enter', async () => {
    await running(claudeCode, '\x1b[?2004h> ')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review:\n  a comment')
    expect(writes).toEqual(['\x15', '\x1b[200~[Hive] #12 is in Review: a comment\x1b[201~', '\r'])
  })

  it("the line's control characters are left out of the paste: nothing in it can end it or press a key", async () => {
    await running(claudeCode, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, 'a comment \x1b[201~\x03 quoting keys\x7f\x9b')
    expect(writes).toEqual(['\x15', '\x1b[200~a comment [201~ quoting keys\x1b[201~', '\r'])
  })

  it('a slash command is typed: pasted, it would be sent as a message', async () => {
    await running(claudeCode, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '/rename the work')
    expect(writes.length).toBeGreaterThan(3)
    expect(typedText()).toBe('/rename the work')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
  })

  it('typed in pieces when the CLI has bracketed paste off (turned off again too)', async () => {
    await running(claudeCode, '\x1b[?2004h\x1b[?2004l')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.length).toBeGreaterThan(3)
    expect(typedText()).toBe('[Hive] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('typed in pieces into a CLI without the capability, even with bracketed paste on (Codex)', async () => {
    echo.to = await running(codex, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[Hive] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
    expect(typedText()).toBe('[Hive] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('Copilot with bracketed paste on gets the line as one paste too (#600)', async () => {
    await running(copilot, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it, act on it, then ack it.')
    expect(writes).toEqual(['\x15', '\x1b[200~[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it, act on it, then ack it.\x1b[201~', '\r'])
  })

  describe("Settings → Advanced's switches for what Hive types (#1286)", () => {
    /** Runs `fn` with these switches as given (the others as they are). */
    const withSwitches = async (values: Record<string, boolean | string>, fn: () => Promise<void>): Promise<void> => {
      const get = advanced.get.bind(advanced)
      const spy = vi.spyOn(advanced, 'get').mockImplementation(((key: string, ws?: Record<string, unknown> | null) => (key in values ? values[key] : get(key, ws))) as typeof advanced.get)
      try {
        await fn()
      } finally {
        spy.mockRestore()
      }
    }
    const written = 'A plan:\r\n  1. one\n\n\t2. two  \x03'

    it('both default to what Hive did before: the draft cleared, the prompt on one line', () => {
      expect([advanced.get<boolean>(PROMPT_CLEAR_DRAFT), advanced.get<boolean>(PROMPT_AS_TYPED)]).toEqual([true, false])
    })

    it('as typed, a paste keeps the spacing and line breaks (as the Enter a terminal pastes them with); other control characters stay out', async () => {
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
      expect(writes).toEqual(['\x15', '\x1b[200~A plan:\r  1. one\r\r\t2. two  \x1b[201~', '\r'])
      writes.length = 0
      // Nothing in it can end the paste (a new launch: the last line is taken).
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'a \x1b[201~\x7f b\n'))
      expect(writes).toEqual(['\x15', '\x1b[200~a [201~ b\r\x1b[201~', '\r'])
    })

    it('not as typed (the default), the same prompt goes on one line, as before', async () => {
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: false }, () => sessions.sendPrompt(p, id, written))
      expect(writes).toEqual(['\x15', '\x1b[200~A plan: 1. one 2. two \x1b[201~', '\r'])
    })

    it('as typed into a CLI Hive types into (Codex): each line break or tab a space, the spacing kept', async () => {
      echo.to = await running(codex, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
      expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
      expect(typedText()).toBe('A plan:   1. one   2. two  ')
    })

    describe("Codex's new-line key for a typed prompt's line breaks (HI-1327)", () => {
      const NEWLINE = 'codex.prompt.newlineKey'
      const ALT_ENTER = TYPED_NEWLINE_KEYS['alt-enter']
      const CTRL_J = TYPED_NEWLINE_KEYS['ctrl-j']
      /** The prompt as Codex would read it: Hive's writes between Ctrl+U and Enter, each key back as a line break. */
      const asRead = (key: string): string => writes.slice(1, -1).join('').split(key).join('\n')

      it('is off by default (spaces) until tried on real Codex: the prompt goes on one line as before', async () => {
        expect(advanced.get<string>(NEWLINE)).toBe('spaces')
        expect(codex.typedNewline()).toBeNull()
        echo.to = await running(codex, '')
        await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
        expect(typedText()).toBe('A plan:   1. one   2. two  ')
        expect(writes.some((w) => w.includes('\x1b'))).toBe(false)
      })

      for (const [choice, key] of [['alt-enter', ALT_ENTER], ['ctrl-j', CTRL_J]] as const) {
        it(`${choice}: each line break is that key, written whole; indentation and blank lines kept, a tab a space, other control characters out, one Enter at the end`, async () => {
          echo.to = await running(codex, '')
          await withSwitches({ [PROMPT_AS_TYPED]: true, [NEWLINE]: choice }, () => sessions.sendPrompt(p, id, written))
          expect(asRead(key)).toBe('A plan:\n  1. one\n\n 2. two  ')
          // Each key its own write; no other write has an escape in it; the one Enter is the last write.
          expect(writes.filter((w) => w === key)).toHaveLength(3)
          expect(writes.filter((w) => w !== key).some((w) => w.includes('\x1b'))).toBe(false)
          expect(writes.slice(0, -1).filter((w) => w !== key).some((w) => w.includes('\r'))).toBe(false)
          expect(writes.at(-1)).toBe('\r')
        })
      }

      it("escapes and control characters in the text never reach Codex, beside line breaks and across a chunk's end", async () => {
        echo.to = await running(codex, '')
        // CRLF, a lone CR and an LF; an escape sequence spanning the first chunk's end (8 characters), and ones beside breaks.
        await withSwitches({ [PROMPT_AS_TYPED]: true, [NEWLINE]: 'alt-enter' }, () => sessions.sendPrompt(p, id, 'abcdefg\x1b[31m\x1b\r\nx\x1b\x07\ry\x1b\nz\x9b'))
        expect(asRead(ALT_ENTER)).toBe('abcdefg[31m\nx\ny\nz')
        // Between Hive's own Ctrl+U and Enter: nothing but text and the keys.
        expect(writes.slice(1, -1).filter((w) => w !== ALT_ENTER).some((w) => /[\x00-\x1f\x7f-\x9f]/.test(w))).toBe(false)
      })

      it('leading and trailing line breaks are keys too', async () => {
        echo.to = await running(codex, '')
        await withSwitches({ [PROMPT_AS_TYPED]: true, [NEWLINE]: 'alt-enter' }, () => sessions.sendPrompt(p, id, '\nmiddle\n'))
        expect(asRead(ALT_ENTER)).toBe('\nmiddle\n')
      })

      it('a slash command, and the prompt with Send prompts as typed off, still go on one line', async () => {
        echo.to = await running(codex, '')
        await withSwitches({ [PROMPT_AS_TYPED]: true, [NEWLINE]: 'alt-enter' }, () => sessions.sendPrompt(p, id, '/review the\nwork'))
        expect(typedText()).toBe('/review the work')
        writes.length = 0
        echo.to = await running(codex, '')
        await withSwitches({ [PROMPT_AS_TYPED]: false, [NEWLINE]: 'alt-enter' }, () => sessions.sendPrompt(p, id, 'A plan:\r\n  1. one\n\n\t2. two'))
        expect(typedText()).toBe('A plan: 1. one 2. two')
        expect(writes.some((w) => w.includes('\x1b'))).toBe(false)
      })

      it('the agent stopping between writes: nothing more is written, no key and no Enter', async () => {
        const screen = await running(codex, '')
        // The session goes as the first key reaches it.
        echo.to = { write: (d: string) => (screen.write(d), d === ALT_ENTER && s.live.delete(liveKey)) }
        await expect(withSwitches({ [PROMPT_AS_TYPED]: true, [NEWLINE]: 'alt-enter' }, () => sessions.sendPrompt(p, id, 'one\ntwo\nthree'))).rejects.toThrow()
        const at = writes.indexOf(ALT_ENTER)
        expect(at).toBeGreaterThan(0)
        expect(writes.slice(at + 1)).toEqual([])
      })

      it('typedPrompt: the pieces, each line through promptInput and each break a key', () => {
        expect(typedPrompt('a\r\n\tb\rc\n', 'K')).toEqual([{ text: 'a' }, { key: 'K' }, { text: ' b' }, { key: 'K' }, { text: 'c' }, { key: 'K' }])
        expect(typedPrompt('x\x1b[2Jy', 'K')).toEqual([{ text: 'x[2Jy' }])
      })
    })

    it('promptInput: each case of pasted or typed, as typed or not', () => {
      expect(promptInput('a\r\nb\tc\x1b', true, true)).toBe('a\rb\tc')
      expect(promptInput('a\r\nb\tc\x1b', false, true)).toBe('a b c')
      expect(promptInput('a b\x1b', true, false)).toBe('a b')
      // Typed and not as typed: as before, the line as it comes (already on one line).
      expect(promptInput('a b', false, false)).toBe('a b')
    })

    // Claude Code 2.1.309 leaves a prompt with one of these unsent ("Removed 1 invisible character · review and press Enter
    // to send"), and sends them inside an emoji: each as tried with the real CLI (#1547).
    it('promptInput leaves out invisible characters, pasted or typed, as typed or not, but keeps the emoji made with them', () => {
      for (const c of ['​', '‌', '‍', '‎', '­', '⁠', '‮', '﻿', '️']) {
        for (const [paste, asTyped] of [[true, true], [true, false], [false, true], [false, false]]) expect(promptInput(`A${c}b c`, paste, asTyped)).toBe('Ab c')
      }
      for (const emoji of ['❤️', '1️⃣', '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', '\u{1f44d}\u{1f3fd}', '\u{1f468}‍\u{1f469}‍\u{1f467}', '\u{1f3f3}️‍\u{1f308}', '☺︎']) {
        expect(promptInput(`word${emoji} PONG`, true, false)).toBe(`word${emoji} PONG`)
      }
      // Stray ones beside an emoji still go: a joiner at its end, a selector after a letter or a lone digit, a tag alone.
      expect(promptInput('\u{1f468}‍ word 1️ x\u{e0067}', true, false)).toBe('\u{1f468} word 1 x')
    })

    it("withoutInvisible, which Compact's focus goes through too", () => {
      expect(withoutInvisible('keep​ the﻿ plan')).toBe('keep the plan')
    })

    it("the draft switch off: no Ctrl+U before the prompt, so the CLI's draft stays in front of it", async () => {
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_CLEAR_DRAFT]: false }, () => sessions.sendPrompt(p, id, 'hello'))
      expect(writes).toEqual(['\x1b[200~hello\x1b[201~', '\r'])
      writes.length = 0
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_CLEAR_DRAFT]: true }, () => sessions.sendPrompt(p, id, 'hello'))
      expect(writes).toEqual(['\x15', '\x1b[200~hello\x1b[201~', '\r'])
    })

    it('a prompt stopped part-way is taken back with Ctrl+U only while the draft switch is on', async () => {
      for (const clear of [true, false]) {
        writes.length = 0
        await running(claudeCode, '\x1b[?2004h')
        // The guard passes until the line is typed, then refuses (the agent got busy): Hive stops before Enter.
        let checks = 0
        const guard = (): void => {
          if (++checks > (clear ? 2 : 1)) throw new Error('busy now')
        }
        await withSwitches({ [PROMPT_CLEAR_DRAFT]: clear }, () => expect(sessions.sendPrompt(p, id, 'hello', guard)).rejects.toThrow('busy now'))
        expect(writes, `clear ${clear}`).toEqual(clear ? ['\x15', '\x1b[200~hello\x1b[201~', '\x15'] : ['\x1b[200~hello\x1b[201~'])
      }
    })
  })

  describe("Codex: Enter once the line is drawn (#600: a busy Codex drops an Enter it reads with the line)", () => {
    const line = '[Hive] New in your inbox: 1 message (m4). Call hive_inbox to read it, act on it, then ack it.'

    it('no Enter while the line isn’t drawn; Enter once it is', async () => {
      const screen = await running(codex, '\x1b[?2004h› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      // Typed (Ctrl+U, the pieces, the pause after them), and a second more: Codex, paused, has drawn nothing.
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes.slice(1).join('')).toBe(line)
      expect(writes).not.toContain('\r')
      // It reads its input again and draws the line: Enter follows.
      screen.write(line)
      await vi.advanceTimersByTimeAsync(100)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it("an earlier doorbell with the same end on screen doesn't count as drawn", async () => {
      const screen = await running(codex, '› [Hive] New in your inbox: 1 message (m3). Call hive_inbox to read it, act on it, then ack it.\r\n› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes).not.toContain('\r')
      screen.write(line)
      await vi.advanceTimersByTimeAsync(100)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it('not drawn within 5 s, Enter anyway (as before #600)', async () => {
      await running(codex, '› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      await vi.advanceTimersByTimeAsync(4000)
      expect(writes).not.toContain('\r')
      await vi.advanceTimersByTimeAsync(2000)
      await sent
      expect(writes.at(-1)).toBe('\r')
    })

    it('drawn as it is typed (an idle Codex), Enter goes at once, long before the wait would end', async () => {
      echo.to = await running(codex, '› ')
      vi.useFakeTimers()
      const sent = sessions.sendPrompt(p, id, line)
      // Typing takes about half a second of the clock (Ctrl+U, the pieces, the pause after them); the wait would be 5 s.
      await vi.advanceTimersByTimeAsync(1000)
      expect(writes.at(-1)).toBe('\r')
      await sent
    })

    it('every CLI Hive waits for to draw a line has that wait in Settings → Advanced', async () => {
      const { PROVIDERS } = await import('../src/shared/providers')
      const { advancedDef } = await import('../src/shared/advanced')
      const waiting = PROVIDERS.filter((d) => d.capabilities.enterOnceDrawn)
      expect(waiting.map((d) => d.id)).toEqual(['codex'])
      for (const d of waiting) expect(advancedDef(drawnWaitId(d.id))?.kind, d.id).toBe('number')
    })

    it("the wait is Settings → Advanced's (Codex → Typed line: wait to be drawn)", async () => {
      const number = advanced.number.bind(advanced)
      const spy = vi.spyOn(advanced, 'number').mockImplementation((key: string) => (key === drawnWaitId('codex') ? 12 : number(key)))
      try {
        await running(codex, '› ')
        vi.useFakeTimers()
        const sent = sessions.sendPrompt(p, id, line)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(writes).not.toContain('\r')
        await vi.advanceTimersByTimeAsync(3000)
        await sent
        expect(writes.at(-1)).toBe('\r')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
