// HI-2867 (SPEC §16.9.5): the rules cw-sign and Combwork's signing check share: the argument transport, which entries are
// Combwork's (validated before anything is dropped), a session's environment with the signer, which calls are signing
// calls, and the known installations whatever the variables' case.
import { describe, expect, it } from 'vitest'
import { decodeArgv, encodeArgv, gitConfigCount, interpreterOf, isKnownSigner, isMsys2Sh, quoteArgMsvc, quoteArgMsys2, resolveProgramWith, signerRun, isSignLauncher, isSigningCall, knownSignerPaths, lastScoped, signerKind, withoutOurEntries, withSessionSigner, SIGN_ENV } from '../src/main/platform/signerRules'

const L = 'C:\\Program Files\\Combwork\\resources\\bin\\cw-sign.exe'
const signer = { launcher: L, exec: 'C:\\Program Files\\Combwork\\Combwork.exe', script: 'C:\\x\\cw-sign.js', timeoutMs: 120_000 }

describe("cw-sign's argument transport", () => {
  it('keeps every argument as it was: empty ones, quotes, %, ^, &, spaces and any UTF-8', () => {
    for (const args of [[], [''], ['', ''], ['-Y', 'sign', '-n', 'git', '-f', 'C:\\k ey&x%PATH%^y"q', 'C:\\buf'], ['--status-fd=2', '-bsau', 'a"b %PATH% ^& c'], ['é', '日本', '😀', 'tab\there']]) {
      expect(decodeArgv(encodeArgv(args))).toEqual(args)
    }
  })
  it('refuses a transport that is missing or malformed', () => {
    for (const bad of [undefined, '', 'x', ':', '2', '2:', '-1:', '1.5:YQ==', '2:YQ==', '0:YQ==', '1:not base64!']) expect(decodeArgv(bad)).toBeNull()
  })
})

describe("Combwork's entries in a session's environment", () => {
  it('puts its two entries first, so the user\'s own (after them) still win, with the variables cw-sign reads', () => {
    const env = withSessionSigner({ PATH: 'p', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.ssh.program', GIT_CONFIG_VALUE_0: 'C:\\mine.exe' }, signer)
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'gpg.program',
      GIT_CONFIG_VALUE_0: L,
      GIT_CONFIG_KEY_1: 'gpg.ssh.program',
      GIT_CONFIG_VALUE_1: L,
      GIT_CONFIG_KEY_2: 'gpg.ssh.program',
      GIT_CONFIG_VALUE_2: 'C:\\mine.exe',
      [SIGN_ENV.ours]: '2',
      [SIGN_ENV.self]: L,
      [SIGN_ENV.exec]: signer.exec,
      [SIGN_ENV.script]: signer.script,
      [SIGN_ENV.timeout]: '120000',
      PATH: 'p'
    })
  })
  it('never adds commit.gpgsign or anything that turns signing off', () => {
    const env = withSessionSigner({}, signer)
    const keys = Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_KEY_')).map(([, v]) => v)
    expect(keys).toEqual(['gpg.program', 'gpg.ssh.program'])
  })
  it("drops another Combwork's launcher entries (a dev build started from a session), with or without a signer", () => {
    const outer = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'gpg.program', GIT_CONFIG_VALUE_0: 'D:\\other\\out\\bin\\cw-sign.exe', GIT_CONFIG_KEY_1: 'gpg.ssh.program', GIT_CONFIG_VALUE_1: 'D:\\other\\out\\bin\\CW-SIGN.EXE', GIT_CONFIG_KEY_2: 'core.autocrlf', GIT_CONFIG_VALUE_2: 'false' }
    expect(withSessionSigner(outer, null)).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' })
    const env = withSessionSigner(outer, signer)
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_KEY_2]).toEqual(['3', L, L, 'core.autocrlf'])
  })
  it('off (no signer) and nothing to drop: the environment as it was', () => {
    const env = { PATH: 'p', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'n' }
    expect(withSessionSigner(env, null)).toEqual(env)
    expect(withSessionSigner({ PATH: 'p' }, null)).toEqual({ PATH: 'p' })
  })
  it('leaves a count git would refuse for git to refuse', () => {
    const env = { GIT_CONFIG_COUNT: 'x' }
    expect(withSessionSigner(env, signer)).toBe(env)
  })
})

describe("taking Combwork's entries out again (cw-sign)", () => {
  const session = (): NodeJS.ProcessEnv => withSessionSigner({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gpg.openpgp.program', GIT_CONFIG_VALUE_0: 'C:\\u.exe', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'U' }, signer)
  it('drops exactly its own and renumbers the user\'s', () => {
    const { env, stripped } = withoutOurEntries(session())
    expect(stripped).toBe(true)
    expect(Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG')))).toEqual({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gpg.openpgp.program', GIT_CONFIG_VALUE_0: 'C:\\u.exe', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'U' })
    expect(env[SIGN_ENV.ours]).toBeUndefined()
  })
  it('with only its own entries, leaves no GIT_CONFIG_COUNT', () => {
    const { env } = withoutOurEntries(withSessionSigner({}, signer))
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG'))).toEqual([])
  })
  it('drops nothing when the entries are not exactly its own (so cw-sign refuses rather than guess)', () => {
    const cases: [string, string][] = [
      [SIGN_ENV.ours, '3'],
      [SIGN_ENV.ours, ''],
      [SIGN_ENV.self, 'C:\\elsewhere\\cw-sign.exe'],
      ['GIT_CONFIG_KEY_0', 'gpg.x509.program'],
      ['GIT_CONFIG_VALUE_1', 'C:\\u.exe'],
      ['GIT_CONFIG_COUNT', '1']
    ]
    for (const [k, v] of cases) {
      const env = { ...session(), [k]: v }
      const out = withoutOurEntries(env)
      expect(out.stripped, `${k}=${v}`).toBe(false)
      expect(out.env).toBe(env)
    }
    const noSelf = session()
    delete noSelf[SIGN_ENV.self]
    expect(withoutOurEntries(noSelf).stripped).toBe(false)
  })
  it('reads the variables whatever their case (Windows)', () => {
    const env = Object.fromEntries(Object.entries(session()).map(([k, v]) => [k.toLowerCase(), v]))
    expect(withoutOurEntries(env).stripped).toBe(true)
  })
})

describe('which calls cw-sign changes', () => {
  it("gpg's signing calls and ssh-keygen's -Y sign only", () => {
    expect(isSigningCall(['--status-fd=2', '-bsau', 'KEY'])).toBe(true)
    expect(isSigningCall(['--status-fd=2', '--detach-sign', '-u', 'K'])).toBe(true)
    expect(isSigningCall(['-Y', 'sign', '-n', 'git', '-f', 'k', 'buf'])).toBe(true)
    expect(isSigningCall(['--keyid-format=long', '--status-fd=1', '--verify', 'sig', '-'])).toBe(false)
    for (const op of ['verify', 'check-novalidate', 'find-principals']) expect(isSigningCall(['-Y', op, '-n', 'git'])).toBe(false)
    expect(signerKind(['-Y', 'sign'])).toBe('ssh')
    expect(signerKind(['-bsau', 'K'])).toBe('openpgp')
  })
  it('recognises a cw-sign launcher by name, whatever its folder or case', () => {
    expect(isSignLauncher('C:\\a b\\cw-sign.exe')).toBe(true)
    expect(isSignLauncher('d:/x/CW-SIGN.EXE')).toBe(true)
    expect(isSignLauncher('C:\\x\\not-cw-sign.exe')).toBe(false)
    expect(isSignLauncher('gpg')).toBe(false)
  })
})

describe('known installations', () => {
  it("finds Windows' OpenSSH and GnuPG's gpg whatever the variables' case (a plain copy of the environment)", () => {
    const env = { SYSTEMROOT: 'C:\\Windows', programfiles: 'C:\\Program Files' }
    expect(isKnownSigner('C:/Windows/System32/OpenSSH/ssh-keygen.exe', [], env)).toBe(true)
    expect(isKnownSigner('c:\\program files\\gnupg\\bin\\gpg.exe', [], env)).toBe(true)
    expect(isKnownSigner('C:\\Program Files\\Git\\usr\\bin\\gpg.exe', ['C:\\Program Files\\Git'], env)).toBe(true)
    expect(isKnownSigner('C:\\tools\\gpg.exe', ['C:\\Program Files\\Git'], env)).toBe(false)
    expect(knownSignerPaths([], {})).toEqual([])
  })
})

describe('running a signer as git for Windows runs it (HR2, round 1)', () => {
  it("quotes an argument as git's quote_arg_msvc does", () => {
    expect(quoteArgMsvc('plain')).toBe('plain')
    expect(quoteArgMsvc('')).toBe('""')
    expect(quoteArgMsvc('a b')).toBe('"a b"')
    expect(quoteArgMsvc('a"b')).toBe('"a\\"b"')
    expect(quoteArgMsvc('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(quoteArgMsvc('a\\"b')).toBe('"a\\\\\\"b"')
    expect(quoteArgMsvc('a\\b')).toBe('a\\b')
    expect(quoteArgMsvc('x*y')).toBe('"x*y"')
    expect(quoteArgMsvc("it's")).toBe('"it\'s"')
    expect(quoteArgMsvc('k&x%NOPE%^y')).toBe('k&x%NOPE%^y')
  })
  it("reads a #! line's interpreter as git's parse_interpreter does", () => {
    expect(interpreterOf('s', '#!/bin/sh\necho')).toBe('sh')
    expect(interpreterOf('s', '#!/usr/bin/env node\n')).toBe('env')
    expect(interpreterOf('s', '#!C:\\tools\\perl.exe -w\r\n')).toBe('perl.exe')
    expect(interpreterOf('s', '#!sh\n')).toBeNull()
    expect(interpreterOf('s', '#!/bin/sh')).toBeNull()
    expect(interpreterOf('s.exe', '#!/bin/sh\n')).toBeNull()
    expect(interpreterOf('s', 'echo\n')).toBeNull()
    expect(interpreterOf('s', null)).toBeNull()
  })
  it("counts only git's whitespace (space, tab, newline, return) as a reason to quote", () => {
    expect(quoteArgMsvc('a\tb')).toBe('"a\tb"')
    expect(quoteArgMsvc('a\vb')).toBe('a\vb')
    expect(quoteArgMsvc('a\u00a0b')).toBe('a\u00a0b')
  })
  it("quotes an argument for MSYS2's sh as git's quote_arg_msys2 does (HI-2934)", () => {
    expect(quoteArgMsys2('plain')).toBe('plain')
    expect(quoteArgMsys2('')).toBe('""')
    expect(quoteArgMsys2('C:\\s\\x')).toBe('"C:\\\\s\\\\x"')
    expect(quoteArgMsys2('a"b')).toBe('"a\\"b"')
    for (const a of ["O'Brien", 'x*y', 'a?b', 'k{1,2}', '~/k', 'a b']) expect(quoteArgMsys2(a)).toBe(`"${a}"`)
    expect(quoteArgMsys2('k&x%P%^y')).toBe('k&x%P%^y')
  })
  it('starts a .cmd or .bat through cmd /c with git\'s command line, a script through its interpreter, the rest as it is, each word quoted as git quotes it (HI-2934)', () => {
    const SH = 'C:\\Git\\usr\\bin\\sh.exe'
    const find = (n: string): string | null => (n === 'sh' ? SH : n === 'perl' ? 'C:\\Perl\\perl.exe' : null)
    expect(signerRun('C:\\s\\my signer.cmd', 'C:/s/my signer.cmd', ['-Y', 'sign', 'k ey&x'], '@echo off', find, 'C:\\Windows\\cmd.exe')).toEqual({ file: 'C:\\Windows\\cmd.exe', argv0: 'C:\\Windows\\cmd.exe', args: ['/c', '""C:/s/my signer.cmd" -Y sign "k ey&x""'] })
    expect(signerRun('C:\\s\\s.BAT', 'C:\\s\\s.BAT', ['-bsau', 'a"b'], null, find, 'cmd.exe').args[1]).toBe('"C:\\s\\s.BAT -bsau "a\\"b""')
    // An .exe: git's command line, quote_arg_msvc (a ', *, ? or { quoted, so MSYS2's runtime neither globs nor unquotes it).
    expect(signerRun('C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe', 'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe', ['-Y', 'sign', '-n', 'git', '-f', "C:\\Users\\O'Brien\\.ssh\\id.pub", 'C:\\buf'], null, find, 'cmd.exe')).toEqual({
      file: 'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe',
      argv0: '"C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe"',
      args: ['-Y', 'sign', '-n', 'git', '-f', '"C:\\Users\\O\'Brien\\.ssh\\id.pub"', 'C:\\buf']
    })
    expect(signerRun('C:\\s\\op-ssh-sign.exe', 'op-ssh-sign', ['-bsau', 'k*{x}?'], null, find, 'cmd.exe')).toEqual({ file: 'C:\\s\\op-ssh-sign.exe', argv0: 'op-ssh-sign', args: ['-bsau', '"k*{x}?"'] })
    // A #! script through MSYS2's sh: the interpreter, the script's path as git found it, then git's arguments, quote_arg_msys2.
    expect(signerRun('C:\\s\\signer', 'C:/s/signer', ['-Y', 'sign', "O'B~"], '#!/bin/sh\n', find, 'cmd.exe')).toEqual({ file: SH, argv0: '"C:\\\\Git\\\\usr\\\\bin\\\\sh.exe"', args: ['"C:\\\\s\\\\signer"', '-Y', 'sign', '"O\'B~"'] })
    // Another interpreter: quote_arg_msvc.
    expect(signerRun('C:\\s\\signer', 'signer', ["O'B~"], '#!/usr/bin/perl\n', find, 'cmd.exe')).toEqual({ file: 'C:\\Perl\\perl.exe', argv0: 'C:\\Perl\\perl.exe', args: ['C:\\s\\signer', '"O\'B~"'] })
    expect(signerRun('C:\\s\\signer', 'C:/s/signer', ['x'], '#!/bin/missing\n', find, 'cmd.exe')).toEqual({ file: 'C:\\s\\signer', argv0: 'C:/s/signer', args: ['x'] })
  })
  it("is MSYS2's sh only for the sh.exe git finds first on PATH", () => {
    const find = (n: string): string | null => (n === 'sh' ? 'C:\\Git\\usr\\bin\\sh.exe' : null)
    expect(isMsys2Sh('c:/git/usr/bin/SH.EXE', find)).toBe(true)
    expect(isMsys2Sh('C:\\other\\sh.exe', find)).toBe(false)
    expect(isMsys2Sh('C:\\Git\\usr\\bin\\bash.exe', find)).toBe(false)
    expect(isMsys2Sh('C:\\Git\\usr\\bin\\sh.exe', () => null)).toBe(false)
  })
})

describe('finding a signer as git for Windows finds it (HI-2934)', () => {
  /** A file system of these files only (any case). */
  const fs = (...files: string[]) => async (p: string): Promise<boolean> => files.some((f) => f.toLowerCase() === p.replace(/\//g, '\\').toLowerCase())
  const env = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' })
  it('in each PATH folder in turn, <name>.exe then <name>: never by PATHEXT', async () => {
    // A folder with only gpg.cmd is passed over for a later one's gpg.exe, as git's lookup_prog does.
    expect(await resolveProgramWith(fs('C:\\a\\gpg.cmd', 'C:\\b\\gpg.exe'), 'gpg', 'C:\\r', env('C:\\a', 'C:\\b'))).toBe('C:\\b\\gpg.exe')
    expect(await resolveProgramWith(fs('C:\\a\\gpg.com', 'C:\\b\\gpg.exe'), 'gpg', 'C:\\r', env('C:\\a', 'C:\\b'))).toBe('C:\\b\\gpg.exe')
    expect(await resolveProgramWith(fs('C:\\a\\gpg', 'C:\\a\\gpg.exe'), 'gpg', 'C:\\r', env('C:\\a'))).toBe('C:\\a\\gpg.exe')
    expect(await resolveProgramWith(fs('C:\\a\\gpg', 'C:\\b\\gpg.exe'), 'gpg', 'C:\\r', env('C:\\a', 'C:\\b'))).toBe('C:\\a\\gpg')
    expect(await resolveProgramWith(fs('C:\\a\\gpg.cmd'), 'gpg', 'C:\\r', env('C:\\a'))).toBeNull()
    // A name ending in .exe: that name only.
    expect(await resolveProgramWith(fs('C:\\a\\gpg.exe.exe', 'C:\\b\\gpg.exe'), 'gpg.exe', 'C:\\r', env('C:\\a', 'C:\\b'))).toBe('C:\\b\\gpg.exe')
    // A .cmd named in full is found as it is.
    expect(await resolveProgramWith(fs('C:\\a\\signer.cmd'), 'signer.cmd', 'C:\\r', env('C:\\a'))).toBe('C:\\a\\signer.cmd')
  })
  it('a path as given, never with an extension added', async () => {
    expect(await resolveProgramWith(fs('C:\\x\\gpg.exe'), 'C:/x/gpg', 'C:\\r', env())).toBeNull()
    expect(await resolveProgramWith(fs('C:\\x\\gpg.exe'), 'C:/x/gpg.exe', 'C:\\r', env())).toBe('C:/x/gpg.exe')
    expect(await resolveProgramWith(fs('C:\\r\\tools\\s.cmd'), 'tools/s.cmd', 'C:\\r', env())).toBe('C:\\r\\tools\\s.cmd')
  })
})

describe('GIT_CONFIG_COUNT as git reads it (HI-2934)', () => {
  it('takes 0 and an empty count as none, refuses what strtoul would', () => {
    expect(gitConfigCount('0')).toBe(0)
    expect(gitConfigCount('')).toBe(0)
    expect(gitConfigCount(' +3')).toBe(3)
    expect(gitConfigCount('-0')).toBe(0)
    for (const bad of ['x', '3 ', '1.5', '-1', '+', ' ', '0x2', '2147483648']) expect(gitConfigCount(bad), bad).toBeNull()
  })
  it('a count of 0 gets the signer, as no count does', () => {
    for (const c of ['0', '']) {
      const env = withSessionSigner({ PATH: 'p', GIT_CONFIG_COUNT: c }, signer)
      expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gpg.program', GIT_CONFIG_VALUE_0: L, GIT_CONFIG_KEY_1: 'gpg.ssh.program', GIT_CONFIG_VALUE_1: L, [SIGN_ENV.ours]: '2' })
      expect(withoutOurEntries(env).stripped).toBe(true)
    }
  })
  it('an entry missing is left for git to refuse, whatever the count', () => {
    const env = { GIT_CONFIG_COUNT: '2147483647', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'n' }
    expect(withSessionSigner(env, signer)).toBe(env)
  })
})

describe("git config's last line", () => {
  it('takes the last occurrence, and the value after the key for --get-regexp', () => {
    expect(lastScoped('local\tgpg.program C:/a b.exe\ncommand\tgpg.openpgp.program C:/c.exe\n', true)).toEqual({ scope: 'command', value: 'C:/c.exe' })
    expect(lastScoped('global\tC:/x y.exe\r\n', false)).toEqual({ scope: 'global', value: 'C:/x y.exe' })
    expect(lastScoped('', false)).toBeNull()
  })
})
