// Agents' signer as installed (HI-2867): dist/win-unpacked's resources\bin\cw-sign.exe and its
// app.asar.unpacked\out\main\cw-sign.js, run with Combwork.exe as Node (as a session's git runs them), each loading only
// Node's built-ins and Combwork's chunks. Checked with a real git commit in a test repository: a key whose passphrase
// nobody can type fails at once with Combwork's line, and a key that needs nobody signs. CW_SIGN_CHECK_DEV=1 checks the dev
// build's (out\bin, out\main) instead: dev coverage, never the packaged run's.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const dev = process.env.CW_SIGN_CHECK_DEV === '1'
const exe = dev ? lib.ELECTRON : lib.PACKAGED_EXE
const launcher = dev ? path.join(lib.ROOT, 'out', 'bin', 'cw-sign.exe') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'resources', 'bin', 'cw-sign.exe')
const script = dev ? path.join(lib.ROOT, 'out', 'main', 'cw-sign.js') : path.join(lib.ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'out', 'main', 'cw-sign.js')
/** A commit's bound: a hang is a failure, never a wait. */
const HUNG_MS = 60_000
/** How fast a commit that needs someone must fail. */
const FAST_MS = 15_000
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

function main() {
  console.log(`checking ${dev ? 'the dev build' : 'dist\\win-unpacked'}: ${launcher}`)
  for (const f of [exe, launcher, script]) if (!fs.existsSync(f)) {
    console.log(`FAIL missing ${f}${dev ? '' : ' (npm run dist builds it)'}`)
    process.exit(1)
  }
  const dir = lib.probeDir('packaged-sign')
  const gitRoot = path.resolve(execFileSync('git', ['--exec-path'], { env: lib.gitEnv(), encoding: 'utf8' }).trim(), '..', '..', '..')
  const keygen = path.join(gitRoot, 'usr', 'bin', 'ssh-keygen.exe')
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: repo, env: lib.gitEnv(extra), encoding: 'utf8', windowsHide: true, timeout: HUNG_MS, input: '' })
  for (const a of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['config', 'commit.gpgsign', 'true'], ['config', 'gpg.format', 'ssh']]) git(a)
  // The session's environment, as Combwork gives it (signerRules.withSessionSigner).
  const session = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gpg.program', GIT_CONFIG_VALUE_0: launcher, GIT_CONFIG_KEY_1: 'gpg.ssh.program', GIT_CONFIG_VALUE_1: launcher, CW_SIGN_OURS: '2', CW_SIGN_SELF: launcher, CW_SIGN_EXEC: exe, CW_SIGN_JS: script, CW_SIGN_TIMEOUT_MS: String(HUNG_MS) }
  const key = (name, passphrase) => {
    const k = path.join(dir, name)
    execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'test', '-f', k], { windowsHide: true, env: lib.baseEnv() })
    return k.replace(/\\/g, '/')
  }

  git(['config', 'user.signingkey', key('locked', 'not-typed-by-anyone')])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  git(['add', '-A'])
  const t = Date.now()
  const locked = git(['commit', '-q', '-m', 'a'], session)
  const ms = Date.now() - t
  check('a key that needs a passphrase fails the commit', locked.status !== 0, `exit ${locked.status}`)
  check(`…at once (${ms} ms)`, ms < FAST_MS)
  check("…with Combwork's line", /nobody can in an agent's session/.test(locked.stderr), locked.stderr.slice(0, 300))

  git(['config', 'user.signingkey', key('open', '')])
  const open = git(['commit', '-q', '-m', 'a'], session)
  check('a key that needs nobody signs the commit', open.status === 0, open.stderr.slice(0, 300))
  const sig = git(['cat-file', 'commit', 'HEAD']).stdout
  check('…and the commit carries its signature', /BEGIN SSH SIGNATURE/.test(sig))
  process.exit(failed ? 1 : 0)
}

main()
