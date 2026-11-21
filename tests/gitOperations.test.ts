// HI-3467: the way out Combwork names for a slot whose detach keeps failing, `git switch --detach <target>`, keeps the
// target one literal argument where the user pastes it (HR1's round 1): valid branch names a shell would read otherwise.
import { describe, expect, it } from 'vitest'
import { gitDetachCommand, shellArg } from '../src/shared/gitOperations'

describe('HI-3467: gitDetachCommand', () => {
  it('names a plain branch as it is', () => {
    expect(gitDetachCommand('main')).toBe('git switch --detach main')
    expect(gitDetachCommand('release/1.7.0')).toBe('git switch --detach release/1.7.0')
    expect(gitDetachCommand('cw/HI-3467-a_b')).toBe('git switch --detach cw/HI-3467-a_b')
  })

  it("quotes one a shell would read (git allows each of these): PowerShell's variables, cmd's operators, quotes", () => {
    expect(gitDetachCommand('release$next')).toBe("git switch --detach 'release$next'")
    expect(gitDetachCommand('release&whoami')).toBe("git switch --detach 'release&whoami'")
    expect(gitDetachCommand('a;b')).toBe("git switch --detach 'a;b'")
    expect(gitDetachCommand('a(b)')).toBe("git switch --detach 'a(b)'")
    expect(gitDetachCommand('a`b')).toBe("git switch --detach 'a`b'")
    expect(gitDetachCommand('a@b')).toBe("git switch --detach 'a@b'")
    // A quote inside is doubled, PowerShell's typographic ones too.
    expect(shellArg("it's")).toBe("'it''s'")
    expect(shellArg('it’s')).toBe("'it’’s'")
  })
})
