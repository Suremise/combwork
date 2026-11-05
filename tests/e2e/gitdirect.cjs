// HI-2137: where the test copy's PATH git is Git for Windows' launcher (<root>\cmd\git.exe, as a Start-menu PATH has it,
// with no other Git folder on PATH), Combwork starts the real git beneath it directly: git's trace2 ancestry shows no
// launcher layer (git.exe < electron.exe) for the test copy's own git, and a hook, and an alias through sh run from it,
// see the launcher's PATH folders first (its MinGW folder's bin, such as /mingw64/bin or /ucrt64/bin, then /usr/bin). Skipped where git isn't Git for Windows. Throwaway
// profile and workspace, quiet; no agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'gitdirect-profile')
const ws = path.join(lib.WORK, 'gitdirect-ws')
const repo = path.join(ws, 'repo')
const trace = path.join(lib.WORK, 'gitdirect-trace2')
const hookOut = path.join(lib.WORK, 'gitdirect-hook.txt')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** Git for Windows' launcher for the suite's git, or null when its git isn't Git for Windows. */
function launcherOf() {
  const execPath = path.win32.normalize(lib.git(lib.WORK, ['--exec-path']).trim())
  const launcher = path.join(path.dirname(path.dirname(path.dirname(execPath))), 'cmd', 'git.exe')
  return fs.existsSync(launcher) ? { launcher, real: path.join(execPath, 'git.exe') } : null
}

/** The run context's PATH for a test copy with Git's launcher folder and no other folder that holds git. */
function pathWithLauncher(launcher) {
  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const rest = (env[key] ?? '').split(path.delimiter).filter((d) => d && !['git.exe', 'git.com'].some((g) => fs.existsSync(path.join(d.replace(/^"|"$/g, ''), g))))
  return [path.dirname(launcher), ...rest].join(path.delimiter)
}

/**
 * Each git process trace2 wrote (one file each, but those in `before`): its arguments and its ancestry (its parent first,
 * Git for Windows' windows/ancestry).
 */
function traced(before = new Set()) {
  if (!fs.existsSync(trace)) return []
  return fs.readdirSync(trace).filter((f) => !before.has(f)).map((f) => {
    const p = { argv: [], ancestry: [] }
    for (const line of fs.readFileSync(path.join(trace, f), 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line)
        if (e.event === 'start') p.argv = e.argv
        if (e.event === 'data_json' && e.key === 'windows/ancestry') p.ancestry = e.value
      } catch {}
    }
    return p
  })
}

;(async () => {
  const found = launcherOf()
  if (!found) lib.skip("the suite's git isn't Git for Windows: there is no launcher to start it through")
  for (const d of [userData, ws, trace, hookOut]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(trace, { recursive: true })
  lib.gitProject(repo)
  // An alias through sh, and a hook (sh) that runs it and says what its PATH starts with.
  lib.git(repo, ['config', 'alias.hivedirect', '!echo alias-through-sh'])
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
  fs.writeFileSync(hook, `#!/bin/sh\n{ echo "first=$PATH"; echo "sed=$(command -v sed)"; git hivedirect; } > "${hookOut.replace(/\\/g, '/')}"\n`)
  lib.enableProviders(userData)

  const { app, page, inv } = await lib.launch({ userData, env: { PATH: pathWithLauncher(found.launcher), GIT_TRACE2_EVENT: trace } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const tool = await inv('git:tool', true)
    check('Combwork finds git, its path the launcher', tool.state === 'ok' && tool.path?.toLowerCase() === found.launcher.toLowerCase(), JSON.stringify(tool))
    // Git as checked so far, the check's own (PATH's git, by design) and any started before it found the real one: not counted.
    const before = new Set(fs.readdirSync(trace))
    await lib.openWorkspace(inv, page, ws)

    // --- A hook and an alias through sh, from the real git Combwork starts.
    await inv('git:createBranch', repo, 'cw/direct')
    const said = await lib.until(() => (fs.existsSync(hookOut) && fs.readFileSync(hookOut, 'utf8').includes('alias-through-sh') ? fs.readFileSync(hookOut, 'utf8') : null), HUNG_MS)
    check("Combwork's checkout ran the hook, and the hook the alias through sh", !!said, said ?? 'no hook output')
    // Git puts its exec-path first itself; then the launcher's folders, then ~/bin (the real git alone, with no MSYSTEM,
    // would put ~/bin first).
    // The MinGW folder is Git's build's (mingw64, or ucrt64 from Git 2.5x; gitTool.ts's MINGW): the same one throughout.
    check("…the hook's PATH starts as through the launcher: git's exec-path, its MinGW bin, /usr/bin, ~/bin; sed from /usr/bin", /^first=\/(mingw64|ucrt64|clangarm64|mingw32)\/libexec\/git-core:\/\1\/bin:\/usr\/bin:[^:]*\/bin(:|$)/m.test(said ?? '') && !/^first=.*:\/(mingw64|ucrt64|clangarm64|mingw32)\/bin:.*:\/\1\/bin(:|$)/m.test(said ?? '') && /^sed=\/usr\/bin\/sed$/m.test(said ?? ''), said)
    check('…and it switched the branch', lib.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'cw/direct')
    await inv('git:history', repo)
    await inv('git:status', repo)

    // --- trace2: every git the test copy started itself, by its ancestry. Its own git's parent is electron.exe; through
    // the launcher it would be git.exe (the launcher), then electron.exe. Those its hook started are below the hook's sh.
    const own = (p) => p.ancestry[0] === 'electron.exe'
    const throughLauncher = (p) => p.ancestry[0] === 'git.exe' && p.ancestry[1] === 'electron.exe'
    const all = await lib.until(() => {
      // Not a check of git itself (PATH's git each time, by design: HI-2137).
      const ps = traced(before).filter((p) => !p.argv.includes('--version') && !p.argv.includes('--exec-path'))
      return ps.some((p) => p.argv.includes('checkout')) ? ps : null
    }, HUNG_MS)
    const ps = all ?? []
    const direct = ps.filter(own)
    const launched = ps.filter(throughLauncher)
    console.log(`trace2: ${ps.length} git processes; the test copy's own ${direct.length} started directly, ${launched.length} through the launcher`)
    check("the test copy's own git starts directly: its parent is electron.exe", direct.some((p) => p.argv.includes('checkout')), JSON.stringify(ps.map((p) => p.ancestry.slice(0, 3))))
    check('…never through the launcher (no git.exe < electron.exe layer)', launched.length === 0, JSON.stringify(launched.map((p) => p.argv.slice(1, 8))))
    check("…the real git: trace2's own path is under the exec-path, not cmd", direct.every((p) => p.argv[0] && !/[\\/]cmd[\\/]git(\.exe)?$/i.test(p.argv[0])), JSON.stringify(direct.map((p) => p.argv[0])))
  } finally {
    await app.close()
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack || e}`)
  process.exit(1)
})
