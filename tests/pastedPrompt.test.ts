// How Combwork puts a prompt into a CLI (#597, SessionManager.sendPrompt): a CLI that reads a bracketed paste as text
// (Claude Code) gets the line as one while its terminal has bracketed paste on, so a busy CLI reading Combwork's Ctrl+U,
// the line and its Enter in one go still sends it; a slash command, a CLI without the capability, or one with
// bracketed paste off gets it typed in pieces, as before. The real helpers, on a stand-in live session; the terminal's
// writes are recorded, never sent.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeBox, claudeInput, type ClaudeInput } from './claudeInputStandIn'

// The CLI's echo (#600): with `echo.to` set, what Combwork types is drawn on that screen, as a CLI reading its input draws it.
const { writes, echo } = vi.hoisted(() => ({ writes: [] as string[], echo: { to: null as null | { write(d: string): void } } }))
vi.mock('../src/main/ptyHost', async (original) => ({ ...((await original()) as object), writePty: (_key: string, data: string) => void (writes.push(data), echo.to?.write(data)) }))
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { TerminalScreen } = await import('../src/main/terminalScreen')
const { advanced } = await import('../src/main/advanced')
const { PROMPT_AS_TYPED, PROMPT_CLEAR_DRAFT, drawnWaitId } = await import('../src/shared/advanced')
const { backspaceKeys, promptInput, rollbackKeys, typedPrompt, withoutInvisible } = await import('../src/main/sessions')
const { TYPED_NEWLINE_KEYS } = await import('../src/shared/terminalInput')
const { providerService } = await import('../src/main/providerService')
const { NEWLINE_TRIED } = await import('../src/main/providers/codex/adapter')

/**
 * How Combwork clears an empty Claude Code input before it types (HI-1979, HR6's round 1): a letter, seen alone in its box,
 * then the Backspace that takes it back (one Ctrl+U for the other CLIs).
 */
const CLEARED = ['x', '\x7f']

describe('a prompt Combwork puts into a CLI (#597)', () => {
  const p = 'C:/combwork-test/pasted-prompt'
  const id = 'b1'
  const s = sessions as unknown as { live: Map<string, unknown> }
  const liveKey = `${p.toLowerCase()}#${id}`
  const screens: InstanceType<typeof TerminalScreen>[] = []
  /** The Claude Code launch's input (claudeInputStandIn), when `running` started one. */
  let claude: ClaudeInput | null = null
  /**
   * An idle launch of `adapter` whose screen has had `output` (the CLI's own) drawn on it. Claude Code's is its input box
   * (a stand-in, `claude`: HI-1979, Combwork types into it only once that box shows empty after a key of Combwork's) with
   * `box`'s options, bracketed paste as `output` leaves it; `box` false: `output` alone, on a screen nothing more draws on.
   */
  const running = async (adapter: unknown, output: string, cliVersion: string | null = null, box: false | Parameters<typeof claudeInput>[0] = {}) => {
    if (adapter === claudeCode && box) {
      const c = claudeInput({ paste: output.lastIndexOf('\x1b[?2004h') > output.lastIndexOf('\x1b[?2004l'), ...box })
      claude = c
      echo.to = { write: c.feed }
      s.live.set(liveKey, { state: { runId: 'r1', status: 'ready', projectPath: p, agentId: id, agentName: 'B1' }, adapter, screen: c.screen, prompts: 0, cliVersion })
      return null as unknown as InstanceType<typeof TerminalScreen>
    }
    const screen = new TerminalScreen(60, 20)
    screens.push(screen)
    await new Promise<void>((r) => screen.write(output, r))
    s.live.set(liveKey, { state: { runId: 'r1', status: 'ready', projectPath: p, agentId: id, agentName: 'B1' }, adapter, screen, prompts: 0, cliVersion })
    return screen
  }
  afterEach(() => {
    s.live.delete(liveKey)
    writes.length = 0
    echo.to = null
    vi.useRealTimers()
    // A test that failed while Combwork was typing mustn't leave the next one refused as busy.
    ;(sessions as unknown as { delivering: Set<string> }).delivering.clear()
    for (const x of screens.splice(0)) x.dispose()
    claude = null
  })
  /** What was typed between the clear (a Ctrl+U, or Claude Code's letter and Backspace) and Enter. */
  const typedText = (): string => writes.slice(writes[0] === 'x' && writes[1] === '\x7f' ? 2 : 1, -1).join('')

  it('Claude Code with bracketed paste on gets the line as one paste, between Ctrl+U and Enter', async () => {
    await running(claudeCode, '\x1b[?2004h> ')
    await sessions.sendPrompt(p, id, '[CW] #12 is in Review:\n  a comment')
    expect(writes).toEqual([...CLEARED, '\x1b[200~[CW] #12 is in Review: a comment\x1b[201~', '\r'])
  })

  it("the line's control characters are left out of the paste: nothing in it can end it or press a key", async () => {
    await running(claudeCode, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, 'a comment \x1b[201~\x03 quoting keys\x7f\x9b')
    expect(writes).toEqual([...CLEARED, '\x1b[200~a comment [201~ quoting keys\x1b[201~', '\r'])
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
    await sessions.sendPrompt(p, id, '[CW] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.length).toBeGreaterThan(3)
    expect(typedText()).toBe('[CW] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('typed in pieces into a CLI without the capability, even with bracketed paste on (Codex)', async () => {
    echo.to = await running(codex, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[CW] #12 is in Review: a comment that is long enough for several pieces')
    expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
    expect(typedText()).toBe('[CW] #12 is in Review: a comment that is long enough for several pieces')
  })

  it('Copilot with bracketed paste on gets the line as one paste too (#600)', async () => {
    await running(copilot, '\x1b[?2004h')
    await sessions.sendPrompt(p, id, '[CW] New in your inbox: 1 message (m4). Call cw_inbox to read it, act on it, then ack it.')
    expect(writes).toEqual(['\x15', '\x1b[200~[CW] New in your inbox: 1 message (m4). Call cw_inbox to read it, act on it, then ack it.\x1b[201~', '\r'])
  })

  describe("Settings → Advanced's switches for what Combwork types (#1286)", () => {
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

    it('both default to what Combwork did before: the draft cleared, the prompt on one line', () => {
      expect([advanced.get<boolean>(PROMPT_CLEAR_DRAFT), advanced.get<boolean>(PROMPT_AS_TYPED)]).toEqual([true, false])
    })

    it('as typed, a paste keeps the spacing and line breaks (as the Enter a terminal pastes them with); other control characters stay out', async () => {
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
      expect(writes).toEqual([...CLEARED, '\x1b[200~A plan:\r  1. one\r\r\t2. two  \x1b[201~', '\r'])
      writes.length = 0
      // Nothing in it can end the paste (a new launch: the last line is taken).
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'a \x1b[201~\x7f b\n'))
      expect(writes).toEqual([...CLEARED, '\x1b[200~a [201~ b\r\x1b[201~', '\r'])
    })

    it('not as typed (the default), the same prompt goes on one line, as before', async () => {
      await running(claudeCode, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: false }, () => sessions.sendPrompt(p, id, written))
      expect(writes).toEqual([...CLEARED, '\x1b[200~A plan: 1. one 2. two \x1b[201~', '\r'])
    })

    it('as typed into a CLI Combwork types into (Codex): each line break or tab a space, the spacing kept', async () => {
      echo.to = await running(codex, '\x1b[?2004h')
      await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
      expect(writes.some((w) => w.includes('\x1b[200~'))).toBe(false)
      expect(typedText()).toBe('A plan:   1. one   2. two  ')
    })

    describe("Codex's new-line key for a typed prompt's line breaks (HI-1327)", () => {
      const NEWLINE = 'codex.prompt.newlineKey'
      const ALT_ENTER = TYPED_NEWLINE_KEYS['alt-enter']
      const CTRL_J = TYPED_NEWLINE_KEYS['ctrl-j']
      /** The prompt as Codex would read it: Combwork's writes between Ctrl+U and Enter, each key back as a line break. */
      const asRead = (key: string): string => writes.slice(1, -1).join('').split(key).join('\n')

      /** Runs `fn` with Codex's installed version reported as `version`. */
      const onVersion = async (version: string | null, fn: () => Promise<void>): Promise<void> => {
        const info = providerService.info.bind(providerService)
        const spy = vi.spyOn(providerService, 'info').mockImplementation(((pid: Parameters<typeof info>[0]) => ({ ...info(pid), version })) as typeof providerService.info)
        try {
          await fn()
        } finally {
          spy.mockRestore()
        }
      }
      /** Runs `fn` with the line-break choice `key` and the switches given. */
      const chosen = (key: string, values: Record<string, boolean | string>, fn: () => Promise<void>): Promise<void> => withSwitches({ ...values, [NEWLINE]: key }, fn)

      it('defaults to Automatic: Alt+Enter with a Codex version it was tried with (0.164.0); with another, or one not known, spaces as before', async () => {
        expect(advanced.get<string>(NEWLINE)).toBe('auto')
        expect(NEWLINE_TRIED).toEqual(['0.164.0'])
        expect([codex.typedNewline('0.164.0'), codex.typedNewline('0.165.0'), codex.typedNewline(null)]).toEqual(['alt-enter', null, null])
        echo.to = await running(codex, '', '0.164.0')
        await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
        expect(asRead(ALT_ENTER)).toBe('A plan:\n  1. one\n\n 2. two  ')
        for (const version of ['0.165.0', null]) {
          writes.length = 0
          echo.to = await running(codex, '', version)
          await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written))
          expect(typedText(), String(version)).toBe('A plan:   1. one   2. two  ')
          expect(writes.some((w) => w.includes('\x1b'))).toBe(false)
        }
      })

      it("goes by the version the running Codex was launched with, not the one installed since (HR6's round 1)", async () => {
        // Launched as 0.163.0 (untried); 0.164.0 installed meanwhile: still spaces.
        echo.to = await running(codex, '', '0.163.0')
        await onVersion('0.164.0', () => withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written)))
        expect(typedText()).toBe('A plan:   1. one   2. two  ')
        // The converse: launched as 0.164.0, an untried version installed since: still its key.
        writes.length = 0
        echo.to = await running(codex, '', '0.164.0')
        await onVersion('0.163.0', () => withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written)))
        expect(asRead(ALT_ENTER)).toBe('A plan:\n  1. one\n\n 2. two  ')
      })

      /**
       * A stand-in for Codex 0.164's input box (HR6's round 1): Alt+Enter a new line, Ctrl+U deletes to the line's start
       * (at a line's start, the line break before it), Enter sends; what it sends is recorded. Drawn on `screen` too.
       */
      const composer = (screen: InstanceType<typeof TerminalScreen>) => {
        const box = { lines: [''], sent: [] as string[] }
        echo.to = {
          write: (d: string) => {
            screen.write(d)
            if (d === ALT_ENTER) box.lines.push('')
            else
              for (const ch of d) {
                const last = box.lines.length - 1
                if (ch === '\x15') {
                  if (box.lines[last] === '' && last > 0) box.lines.pop()
                  else box.lines[last] = ''
                } else if (ch === '\r') {
                  box.sent.push(box.lines.join('\n'))
                  box.lines = ['']
                } else if (ch >= ' ') box.lines[last] += ch
              }
          }
        }
        return box
      }

      it('stopped part-way through a multi-line prompt, what Combwork typed is taken back whole, and the next prompt goes alone', async () => {
        const box = composer(await running(codex, '', '0.164.0'))
        // The agent gets busy once two of its line breaks are in, its CLI still running.
        const guard = (): void => {
          if (writes.filter((w) => w === ALT_ENTER).length >= 2) throw new Error('it got busy')
        }
        await expect(withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'first line\n\n  third', guard))).rejects.toThrow('it got busy')
        expect(box.lines).toEqual([''])
        expect(box.sent).toEqual([])
        await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'fresh\nwork'))
        expect(box.sent).toEqual(['fresh\nwork'])
        expect(rollbackKeys([10, 0, 0])).toBe(3)
        expect(rollbackKeys([5, 3])).toBe(3)
        expect(rollbackKeys([0])).toBe(0)
      })

      it('the user typing meanwhile: nothing of theirs is taken back', async () => {
        const box = composer(await running(codex, '', '0.164.0'))
        const guard = (): void => {
          if (writes.filter((w) => w === ALT_ENTER).length >= 1) {
            sessions.noteUserInput((sessions as unknown as { key(p: string, a: string): string }).key(p, id), 'x')
            throw new Error('the user typed')
          }
        }
        await expect(withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'one\ntwo', guard))).rejects.toThrow('the user typed')
        expect(writes.filter((w) => w === '\x15')).toHaveLength(1)
        expect(box.lines).toEqual(['one', ''])
      })

      it("a last line of spaces doesn't make Enter wait for it to be drawn", async () => {
        const box = composer(await running(codex, '', '0.164.0'))
        // A minute's wait would fail this test by its own time limit: Enter must follow at once.
        const number = advanced.number.bind(advanced)
        const spy = vi.spyOn(advanced, 'number').mockImplementation((k: string) => (k === drawnWaitId('codex') ? 60 : number(k)))
        try {
          await withSwitches({ [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, 'first\n   '))
        } finally {
          spy.mockRestore()
        }
        expect(box.sent).toEqual(['first\n   '])
      })

      it('a key chosen is used with any version, Alt+Enter too; Spaces chosen, never a key', async () => {
        echo.to = await running(codex, '')
        await onVersion('0.165.0', () => chosen('ctrl-j', { [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written)))
        expect(asRead(CTRL_J)).toBe('A plan:\n  1. one\n\n 2. two  ')
        writes.length = 0
        echo.to = await running(codex, '')
        await onVersion(null, () => chosen('alt-enter', { [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written)))
        expect(asRead(ALT_ENTER)).toBe('A plan:\n  1. one\n\n 2. two  ')
        writes.length = 0
        echo.to = await running(codex, '')
        await onVersion('0.164.0', () => chosen('spaces', { [PROMPT_AS_TYPED]: true }, () => sessions.sendPrompt(p, id, written)))
        expect(typedText()).toBe('A plan:   1. one   2. two  ')
      })

      for (const [choice, key] of [['alt-enter', ALT_ENTER], ['ctrl-j', CTRL_J]] as const) {
        it(`${choice}: each line break is that key, written whole; indentation and blank lines kept, a tab a space, other control characters out, one Enter at the end`, async () => {
          echo.to = await running(codex, '')
          await chosen(choice, { [PROMPT_AS_TYPED]: true },() => sessions.sendPrompt(p, id, written))
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
        await chosen('alt-enter', { [PROMPT_AS_TYPED]: true },() => sessions.sendPrompt(p, id, 'abcdefg\x1b[31m\x1b\r\nx\x1b\x07\ry\x1b\nz\x9b'))
        expect(asRead(ALT_ENTER)).toBe('abcdefg[31m\nx\ny\nz')
        // Between Combwork's own Ctrl+U and Enter: nothing but text and the keys.
        expect(writes.slice(1, -1).filter((w) => w !== ALT_ENTER).some((w) => /[\x00-\x1f\x7f-\x9f]/.test(w))).toBe(false)
      })

      it('leading and trailing line breaks are keys too', async () => {
        echo.to = await running(codex, '')
        await chosen('alt-enter', { [PROMPT_AS_TYPED]: true },() => sessions.sendPrompt(p, id, '\nmiddle\n'))
        expect(asRead(ALT_ENTER)).toBe('\nmiddle\n')
      })

      it('a slash command, and the prompt with Send prompts as typed off, still go on one line', async () => {
        echo.to = await running(codex, '')
        await chosen('alt-enter', { [PROMPT_AS_TYPED]: true },() => sessions.sendPrompt(p, id, '/review the\nwork'))
        expect(typedText()).toBe('/review the work')
        writes.length = 0
        echo.to = await running(codex, '')
        await chosen('alt-enter', { [PROMPT_AS_TYPED]: false },() => sessions.sendPrompt(p, id, 'A plan:\r\n  1. one\n\n\t2. two'))
        expect(typedText()).toBe('A plan: 1. one 2. two')
        expect(writes.some((w) => w.includes('\x1b'))).toBe(false)
      })

      it('the agent stopping between writes: nothing more is written, no key and no Enter', async () => {
        const screen = await running(codex, '')
        // The session goes as the first key reaches it.
        echo.to = { write: (d: string) => (screen.write(d), d === ALT_ENTER && s.live.delete(liveKey)) }
        await expect(chosen('alt-enter', { [PROMPT_AS_TYPED]: true },() => sessions.sendPrompt(p, id, 'one\ntwo\nthree'))).rejects.toThrow()
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
      // Typed and not as typed: the line as it comes (already on one line), without control characters (HI-1920: a
      // Ctrl+C in it reached Codex as Ctrl+C, an escape could press arrow keys).
      expect(promptInput('a b', false, false)).toBe('a b')
      expect(promptInput('stop\x03 here \x1b[A up\x7f \x9b end', false, false)).toBe('stop here [A up  end')
    })

    it('typed into Codex with Send prompts as typed off (the default), no control character reaches it (HI-1920)', async () => {
      echo.to = await running(codex, '')
      await withSwitches({ [PROMPT_AS_TYPED]: false }, () => sessions.sendPrompt(p, id, 'A plan:\r\n  1. one\n\n\t2. two  \x03 then \x1b[A\x7f'))
      // Collapsed first, then left out: the Ctrl+C between two spaces leaves both, as a paste does.
      expect(typedText()).toBe('A plan: 1. one 2. two  then [A')
      expect(writes.slice(1, -1).some((w) => /[\x00-\x1f\x7f-\x9f]/.test(w))).toBe(false)
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
      expect(writes).toEqual([...CLEARED, '\x1b[200~hello\x1b[201~', '\r'])
    })

    it('a prompt stopped part-way is taken back only while the draft switch is on (Copilot: Ctrl+U; Claude Code: Backspaces)', async () => {
      for (const [adapter, back] of [[copilot, ['\x15']], [claudeCode, ['\x7f\x7f\x7f\x7f\x7f']]] as const) {
        for (const clear of [true, false]) {
          writes.length = 0
          await running(adapter, '\x1b[?2004h')
          // The guard passes until the line is typed, then refuses (the agent got busy): Combwork stops before Enter.
          const guard = (): void => {
            if (writes.some((w) => w.startsWith('\x1b[200~'))) throw new Error('busy now')
          }
          await withSwitches({ [PROMPT_CLEAR_DRAFT]: clear }, () => expect(sessions.sendPrompt(p, id, 'hello', guard)).rejects.toThrow('busy now'))
          expect(writes, `${adapter.id}, clear ${clear}`).toEqual(clear ? [...(adapter === claudeCode ? CLEARED : ['\x15']), '\x1b[200~hello\x1b[201~', ...back] : ['\x1b[200~hello\x1b[201~'])
        }
      }
    })

    // HI-1974: Claude Code 2.1.312's Ctrl+U deletes only the wrapped row the cursor is on, so one left a stopped wake's
    // first rows in LB1's input and the next wake was sent after them; and a row count misses wide characters (HR6's
    // round 1). Its input is the stand-in written apart from Combwork's code (claudeInputStandIn): a Backspace deletes one
    // character as the user sees it (a grapheme: stricter than the code points Combwork counts); a Ctrl+U would take back a
    // row, never what Combwork needs, so none is pressed.
    it('a line with wide characters stopped part-way in Claude Code is taken back whole, and the next prompt goes alone', async () => {
      const wide = `${'界'.repeat(500)} 👩‍💻 ${'supercalifragilisticexpialidocious-and-more '.repeat(3)}${'é'.normalize('NFD')} end`
      for (const line of [wide, '[CW] New in your inbox: 1 card event (LE-191) (m315). Call cw_inbox to read it. (Your watch is still on, waiting for LE-191: do what this asks, then end your turn, and Combwork wakes you when it changes.)']) {
        writes.length = 0
        await running(claudeCode, '\x1b[?2004h')
        // Refused once the line is in (as a wake no longer wanted is), never before.
        const guard = (): void => {
          if (writes.some((w) => w.startsWith('\x1b[200~'))) throw new Error('It is no longer wanted.')
        }
        await expect(sessions.sendPrompt(p, id, line, guard)).rejects.toThrow('no longer wanted')
        expect(writes.some((w) => w.startsWith('\x1b[200~')), 'the line was written before it was stopped').toBe(true)
        expect([claude!.input.text, claude!.input.sent, claude!.input.ctrlU], line.slice(0, 20)).toEqual(['', [], 0])
        await sessions.sendPrompt(p, id, 'the next prompt')
        expect(claude!.input.sent, line.slice(0, 20)).toEqual(['the next prompt'])
      }
    })

    describe("Claude Code's draft cleared before Combwork types (HI-1979)", () => {
      /** Runs `fn` with Advanced's wait for each key short (a refusal needn't take its 2 s). */
      const shortWait = async <T,>(fn: () => Promise<T>): Promise<T> => {
        const number = advanced.number.bind(advanced)
        const spy = vi.spyOn(advanced, 'number').mockImplementation((setting: string) => (setting === 'claude-code.prompt.clearKeySeconds' ? 0.3 : number(setting)))
        try {
          return await fn()
        } finally {
          spy.mockRestore()
        }
      }
      const pasted = (): boolean => writes.some((w) => w.startsWith('\x1b[200~'))
      const ctrlU = (): number => writes.filter((w) => w === '\x15').length
      // Three rows of the box (58 characters each).
      const DRAFT = `${'a draft the user left there, wrapping onto three rows. '.repeat(3)}end`

      it('a draft wrapped onto three rows: a Ctrl+U for each, the box then shown empty by the letter typed and taken back, then the prompt, sent alone', async () => {
        await running(claudeCode, '\x1b[?2004h', null, { draft: DRAFT })
        await sessions.sendPrompt(p, id, 'the prompt')
        expect(writes).toEqual(['\x15', '\x15', '\x15', ...CLEARED, '\x1b[200~the prompt\x1b[201~', '\r'])
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it("the same, drawn where the terminal doesn't say it shows Unicode: \">\" its prompt mark, the session's name in its top rule", async () => {
        await running(claudeCode, '\x1b[?2004h', null, { draft: DRAFT, ascii: true })
        await sessions.sendPrompt(p, id, 'the prompt')
        expect(writes).toEqual(['\x15', '\x15', '\x15', ...CLEARED, '\x1b[200~the prompt\x1b[201~', '\r'])
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it('a draft taller than the screen, with line breaks: cleared whole (its top rule off the screen meanwhile), then sent alone', async () => {
        const tall = Array.from({ length: 14 }, (_, i) => `line ${i} ${'x'.repeat(70)}`).join('\n')
        await running(claudeCode, '\x1b[?2004h', null, { draft: tall, viewport: 20 })
        expect(claudeCode.promptText!(claude!.screen.textWithoutDim()), 'the box is taller than the screen').toBeNull()
        await sessions.sendPrompt(p, id, 'the prompt')
        // Two rows for each line, and its 13 line breaks.
        expect(ctrlU()).toBe(14 * 2 + 13)
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it("an empty box already on the screen isn't taken as empty (HR6's round 1): a draft drawn late is still cleared, and the prompt goes alone", async () => {
        // The screen shows an empty box, but the CLI holds two rows of a draft and draws each change 200 ms late.
        const draft = DRAFT.slice(0, 116)
        await running(claudeCode, '\x1b[?2004h', null, { draft, shows: claudeBox(), lagMs: 200 })
        await sessions.sendPrompt(p, id, 'the prompt')
        // The letter showed after the draft, on a row of its own (the draft fills its two), so three rows went, then it
        // showed alone.
        expect(ctrlU()).toBe(3)
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it('the CLI stops answering keys: refused, nothing of the prompt written or taken back; a later try clears it and sends it alone', async () => {
        await running(claudeCode, '\x1b[?2004h', null, { draft: DRAFT })
        claude!.input.answers = 1
        await shortWait(() => expect(sessions.sendPrompt(p, id, 'the prompt')).rejects.toThrow(/couldn't be seen empty/))
        expect([pasted(), writes.includes('\x7f'), writes.includes('\r')]).toEqual([false, false, false])
        expect(claude!.input.text, 'two rows left').toBe(DRAFT.slice(0, 116))
        claude!.input.answers = Infinity
        writes.length = 0
        await sessions.sendPrompt(p, id, 'the prompt')
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it('the letter typed and not shown (the CLI not reading): refused, and the letter taken back', async () => {
        await running(claudeCode, '\x1b[?2004h')
        claude!.input.answers = 0
        await shortWait(() => expect(sessions.sendPrompt(p, id, 'the prompt')).rejects.toThrow(/couldn't be seen empty/))
        expect(writes).toEqual(['x', '\x7f'])
      })

      it('the user typing as it is cleared: it stops at once, refused; the rest of their draft stays', async () => {
        await running(claudeCode, '\x1b[?2004h', null, { draft: DRAFT })
        const guard = (): void => {
          if (ctrlU() >= 2) throw new Error('The user is typing there.')
        }
        await expect(sessions.sendPrompt(p, id, 'the prompt', guard)).rejects.toThrow('The user is typing there.')
        expect(writes).toEqual(['\x15', '\x15'])
        expect(claude!.input.text).toBe(DRAFT.slice(0, 58))
      })

      it("an input box it can't find: refused after one Ctrl+U, nothing typed; a later try with its box on the screen goes", async () => {
        await running(claudeCode, '\x1b[?2004h> ', null, false)
        await shortWait(() => expect(sessions.sendPrompt(p, id, 'the prompt')).rejects.toThrow(/couldn't be seen empty/))
        expect(writes).toEqual(['\x15'])
        writes.length = 0
        await running(claudeCode, '\x1b[?2004h')
        await sessions.sendPrompt(p, id, 'the prompt')
        expect(writes).toEqual([...CLEARED, '\x1b[200~the prompt\x1b[201~', '\r'])
      })

      it('an empty box: no Ctrl+U, the letter shown alone and taken back, then the prompt (each key answered, never waited out: a key waited out refuses)', async () => {
        await running(claudeCode, '\x1b[?2004h')
        await sessions.sendPrompt(p, id, 'the prompt')
        expect(writes).toEqual([...CLEARED, '\x1b[200~the prompt\x1b[201~', '\r'])
        expect(claude!.input.sent).toEqual(['the prompt'])
      })

      it('Codex and Copilot: one Ctrl+U, whatever their screen shows', async () => {
        for (const adapter of [codex, copilot]) {
          writes.length = 0
          await running(adapter, '\x1b[?2004h')
          await sessions.sendPrompt(p, id, 'the prompt')
          expect(writes.filter((w) => w === '\x15'), adapter.id).toHaveLength(1)
          expect(writes.includes('x'), adapter.id).toBe(false)
        }
      })

      it('the box read is the one at the bottom, with a rule and a prompt mark left on the screen above it', () => {
        // A rule shared as one box's bottom and the next one's top: the last box is the bottom one, not a span from the
        // stray rule above down to its top rule (which then matched no box of its own).
        const rule = '─'.repeat(60)
        const shown = `${rule}\n❯ \n\n> [CW] New in your inbox: 1 task (m2). Call cw_inbox to read it.\n\n${claudeBox()}`
        expect(claudeCode.promptText!(shown)).toBe('')
        expect(claudeCode.promptText!(`${rule}\n❯ \n\n> an old prompt\n\n${claudeBox('a draft')}`)).toBe('a draft')
      })

      it("the recorded screens: Claude Code 2.1.312's box read row by row as each Ctrl+U took one, then empty", () => {
        const screensRead = readFileSync(join(__dirname, 'fixtures', 'advanced', 'input-clear-claude-2.1.312.txt'), 'utf8').replace(/\r\n/g, '\n').split(/^== .*$/m).slice(1)
        const read = screensRead.map((x) => claudeCode.promptText!(x))
        expect(read.map((x) => x?.length ?? null)).toEqual([...read.map((x) => x?.length ?? null)].sort((a, b) => (b ?? 0) - (a ?? 0)))
        expect(read).toHaveLength(5)
        expect(read.slice(0, 4).every((x) => !!x)).toBe(true)
        expect(read[4]).toBe('')
      })
    })

    it('backspaceKeys: one for each code point written, and one for each key between typed lines', () => {
      expect(backspaceKeys('')).toBe(0)
      expect(backspaceKeys('hello')).toBe(5)
      // Wide or not, one each; a character of several code points (an emoji sequence, a decomposed é) counts each.
      expect(backspaceKeys('界界')).toBe(2)
      expect(backspaceKeys('👩‍💻')).toBe(3)
      expect(backspaceKeys('é'.normalize('NFD'))).toBe(2)
      expect(backspaceKeys([5, 0, 3])).toBe(5 + 1 + 0 + 1 + 3)
    })
  })

  describe("Codex: Enter once the line is drawn (#600: a busy Codex drops an Enter it reads with the line)", () => {
    const line = '[CW] New in your inbox: 1 message (m4). Call cw_inbox to read it, act on it, then ack it.'

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
      const screen = await running(codex, '› [CW] New in your inbox: 1 message (m3). Call cw_inbox to read it, act on it, then ack it.\r\n› ')
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

    it('every CLI Combwork waits for to draw a line has that wait in Settings → Advanced', async () => {
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
