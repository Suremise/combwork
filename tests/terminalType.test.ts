// HI-2004: sessions' terminals named as Hive's terminal is (xterm.js): TERM=xterm-256color unless the environment names
// one already (the user's own, or the session's), and no WT_SESSION inherited from a Windows Terminal Hive was opened
// from, so the CLIs draw the same however Hive was opened. An Advanced switch (`hive.sessions.terminalType`, on) turns
// it off, leaving the environment as given.
import { describe, expect, it } from 'vitest'
import { withTerminalType } from '../src/main/ptyHost'
import { advancedDef, TERMINAL_TYPE } from '../src/shared/advanced'

describe("a session's terminal type (HI-2004)", () => {
  it('names the terminal xterm-256color, and drops an inherited WT_SESSION', () => {
    expect(withTerminalType({ PATH: 'C:\\bin', TERM_PROGRAM: 'Hive', WT_SESSION: '3f1c-…' }, true)).toEqual({ PATH: 'C:\\bin', TERM_PROGRAM: 'Hive', TERM: 'xterm-256color' })
    // Opened from the Start menu: neither, so the same result as from Windows Terminal.
    expect(withTerminalType({ PATH: 'C:\\bin' }, true)).toEqual({ PATH: 'C:\\bin', TERM: 'xterm-256color' })
  })

  it("keeps a TERM the environment already names: the user's own, or the session's", () => {
    expect(withTerminalType({ TERM: 'xterm-direct', WT_SESSION: 'x' }, true)).toEqual({ TERM: 'xterm-direct' })
  })

  it("on Windows, names in any case are the same variable: a Term of the user's or a connection's kept alone, a wt_session dropped (HR3's round 1)", () => {
    // Inherited (the user's own, as childEnv copies Hive's environment with its casing).
    expect(withTerminalType({ Term: 'dumb', wt_session: 'x', Path: 'C:\\bin' }, true, 'win32')).toEqual({ Term: 'dumb', Path: 'C:\\bin' })
    // A session's or connection's own TERM spread over an inherited one in another case: one TERM, the session's (the last).
    expect(withTerminalType({ term: 'xterm', PATH: 'C:\\bin', TERM: 'vt100' }, true, 'win32')).toEqual({ PATH: 'C:\\bin', TERM: 'vt100' })
    expect(withTerminalType({ Wt_Session: 'x' }, true, 'win32')).toEqual({ TERM: 'xterm-256color' })
    // Elsewhere names are case-sensitive: `term` isn't TERM.
    expect(withTerminalType({ term: 'x' }, true, 'linux')).toEqual({ term: 'x', TERM: 'xterm-256color' })
  })

  it('turned off, the environment as given, WT_SESSION and no TERM included', () => {
    const env = { PATH: 'C:\\bin', WT_SESSION: 'x' }
    expect(withTerminalType(env, false)).toBe(env)
  })

  it('is an advanced switch, on by default, applying to the next sessions', () => {
    expect(advancedDef(TERMINAL_TYPE)).toMatchObject({ group: 'hive', kind: 'boolean', default: true, applies: 'sessions' })
  })
})
