// HI-2867 (SPEC §16.9.5): the rules cw-sign and Combwork's signing check share: the argument transport, which entries are
// Combwork's (validated before anything is dropped), a session's environment with the signer, which calls are signing
// calls, and the known installations whatever the variables' case.
import { describe, expect, it } from 'vitest'
import { decodeArgv, encodeArgv, isKnownSigner, isSignLauncher, isSigningCall, knownSignerPaths, lastScoped, signerKind, withoutOurEntries, withSessionSigner, SIGN_ENV } from '../src/main/platform/signerRules'

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

describe("git config's last line", () => {
  it('takes the last occurrence, and the value after the key for --get-regexp', () => {
    expect(lastScoped('local\tgpg.program C:/a b.exe\ncommand\tgpg.openpgp.program C:/c.exe\n', true)).toEqual({ scope: 'command', value: 'C:/c.exe' })
    expect(lastScoped('global\tC:/x y.exe\r\n', false)).toEqual({ scope: 'global', value: 'C:/x y.exe' })
    expect(lastScoped('', false)).toBeNull()
  })
})
