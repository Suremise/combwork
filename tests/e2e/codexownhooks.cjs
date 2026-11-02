// Hive's hooks run beside the user's own Codex hooks (#1285, #966 row 11, Darren's decision: no "Keep my Codex hooks"
// switch, as there is nothing to keep). Asked of the installed Codex's own hook discovery (its app server's hooks/list),
// so a Codex that starts letting Hive's -c overrides displace the user's hooks, or drop their trust, fails here first:
// - the user's Stop and PreToolUse hooks (their config.toml) and Hive's of the same events (-c hooks.<event>, the session
//   flags) are listed side by side, each under its own key;
// - the user's trust records (their config.toml's hooks.state) survive Hive's -c hooks.state table: their hooks stay
//   trusted, and Hive's table names only its own session-flags keys;
// - the developer_instructions a session gets, as Hive reads them before putting its guidance after them (#1285, row
//   13): Codex's own rendering of the session's prompt (debug prompt-input, offline), as is and with them cleared, at
//   every layer (the user's, a selected profile in each form, a trusted and an untrusted project), each missing, empty,
//   blank or set.
// The -c forms are Hive's (codex/adapter.ts hookOverrides; a unit test, cliOverrides, pins its keys). A throwaway
// CODEX_HOME of its own, never the user's ~/.codex nor the signed-in test home: hooks/list needs no sign-in.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const work = path.join(lib.WORK, 'codexownhooks')
const home = path.join(work, 'codex-home')
const proj = path.join(work, 'proj')
const SESSION_FLAGS = 'C:\\<session-flags>\\config.toml'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const env = (codexHome = home) => lib.childEnv({ CODEX_HOME: codexHome, PATH: lib.pathWithoutStoreAliases() })
const toml = (s) => JSON.stringify(s)

/** Hive's form of a hook (-c hooks.<event>=[{ matcher, hooks = [{ type, command, timeout }] }]). */
const hiveHook = (event, matcher) => ['-c', `hooks.${event}=[{ ${matcher ? `matcher = ${toml(matcher)}, ` : ''}hooks = [{ type = "command", command = ${toml(`echo hive-${event}`)}, timeout = 5 }] }]`]

/** Codex's app server's hooks/list for the project, given `args` (in `codexHome`): its hooks, each with its source, command and trust. */
function hooksList(args, codexHome = home) {
  return new Promise((resolve) => {
    const p = spawn('codex.exe', ['app-server', ...args], { cwd: proj, env: env(codexHome), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    const done = (v) => {
      clearTimeout(timer)
      p.kill()
      resolve(v)
    }
    const timer = setTimeout(() => done({ error: `no reply in ${HUNG_MS / 1000} s: ${err.slice(0, 300)}` }), HUNG_MS)
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n')
    p.on('error', (e) => done({ error: String(e) }))
    p.stderr.on('data', (d) => (err += d))
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'hooks/list', params: { cwds: [proj] } })
        } else if (m.id === 2) done(m.error ? { error: JSON.stringify(m.error) } : { hooks: (m.result?.data ?? []).flatMap((e) => e.hooks ?? []) })
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hive-e2e', version: '1' } } })
  })
}
const brief = (r) => (r.error ? r.error : JSON.stringify(r.hooks.map((h) => ({ source: h.source, command: h.command, trust: h.trustStatus }))))

;(async () => {
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(proj, { recursive: true })
  const config = path.join(home, 'config.toml')
  fs.writeFileSync(config, ['[[hooks.Stop]]', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "echo user-Stop"', '[[hooks.PreToolUse]]', 'matcher = "*"', '[[hooks.PreToolUse.hooks]]', 'type = "command"', 'command = "echo user-PreToolUse"', ''].join('\n'))
  const hive = [...hiveHook('Stop'), ...hiveHook('PreToolUse', '*')]
  const user = (r) => (r.hooks ?? []).filter((h) => h.source === 'user')
  const ours = (r) => (r.hooks ?? []).filter((h) => h.source === 'sessionFlags')

  // The user's own, alone: learnt, then trusted in their config as Codex's review would write it.
  const alone = await hooksList([])
  check("Codex lists the user's own hooks", user(alone).length === 2, brief(alone))
  fs.appendFileSync(config, user(alone).flatMap((h) => [`[hooks.state.${toml(h.key)}]`, `trusted_hash = ${toml(h.currentHash)}`]).join('\n') + '\n')
  const trusted = await hooksList([])
  check("…and trusts them once their config's hooks.state says so", user(trusted).length === 2 && user(trusted).every((h) => h.trustStatus === 'trusted'), brief(trusted))

  // With Hive's hooks for the same events: both sets, each under its own key.
  const both = await hooksList(hive)
  check("Hive's hooks for the same events are listed beside the user's, not in their place", user(both).length === 2 && ours(both).length === 2, brief(both))
  check("…each under its own key: the user's config's, and the session flags'", user(both).every((h) => !h.key.startsWith(SESSION_FLAGS)) && ours(both).every((h) => h.key.startsWith(SESSION_FLAGS)), brief(both))
  check('…the commands as each gave them', user(both).map((h) => h.command).sort().join() === 'echo user-PreToolUse,echo user-Stop' && ours(both).map((h) => h.command).sort().join() === 'echo hive-PreToolUse,echo hive-Stop', brief(both))

  // With Hive's trust table too (its own session-flags keys only): the user's trust survives.
  const table = Object.fromEntries(ours(both).map((h) => [h.key, { trusted_hash: h.currentHash }]))
  const state = `hooks.state={ ${Object.entries(table).map(([k, v]) => `${toml(k)} = { trusted_hash = ${toml(v.trusted_hash)} }`).join(', ')} }`
  const withState = await hooksList([...hive, '-c', state])
  check("with Hive's hooks.state table, the user's hooks stay trusted", user(withState).length === 2 && user(withState).every((h) => h.trustStatus === 'trusted'), brief(withState))
  check("…and Hive's are trusted by their own records", ours(withState).length === 2 && ours(withState).every((h) => h.trustStatus === 'trusted'), brief(withState))

  // A connection's home (HI-1757): new, as Hive makes one (its sessions and archived_sessions junctions to the CLI home's,
  // no config, no sign-in), with the file store a connection's Codex is given. Hive's hooks are trusted by their own
  // records on the command line alone; the user's, in ~/.codex's config, aren't this home's.
  const conn = path.join(work, 'accounts', 'a-connection')
  fs.mkdirSync(conn, { recursive: true })
  for (const n of ['sessions', 'archived_sessions']) {
    fs.mkdirSync(path.join(home, n), { recursive: true })
    fs.symlinkSync(path.join(home, n), path.join(conn, n), 'junction')
  }
  const inConnection = await hooksList(['-c', 'cli_auth_credentials_store="file"', ...hive, '-c', state], conn)
  check("in a connection's new home, with the file store, Hive's hooks are trusted by their own records", ours(inConnection).length === 2 && ours(inConnection).every((h) => h.trustStatus === 'trusted'), brief(inConnection))
  check("…and the user's own hooks (their home's config) aren't the connection's", user(inConnection).length === 0, brief(inConnection))

  // ---- developer_instructions (#1285, HR4's rounds 1–3, the Assistant's design): Hive asks Codex which apply by
  // rendering the session's prompt offline with the agent's own arguments (debug prompt-input), as is and with them
  // cleared, and puts its guidance after what the first has in front of the second. Codex decides every layer itself:
  // checked here at each, with each kind of value, and every profile form, through that same reading (its rule is
  // developerInstructionsOf in codex/adapter.ts, unit-tested in cliOverrides).
  const { execFileSync } = require('child_process')
  const developerTexts = (args) => {
    try {
      const items = JSON.parse(execFileSync('codex.exe', [...args, 'debug', 'prompt-input'], { cwd: proj, env: env(), encoding: 'utf8', windowsHide: true, timeout: HUNG_MS }))
      // Every developer message's texts in order (#1514: 0.164.0 has a tools item with the developer role first, and its
      // base instructions in a developer message before the one with developer_instructions), as developerTexts does.
      return items.filter((i) => i.role === 'developer' && (i.type === undefined || i.type === 'message') && Array.isArray(i.content)).flatMap((i) => i.content.map((c) => (typeof c.text === 'string' ? c.text : '')))
    } catch (e) {
      return { error: String(e.stderr ?? e).slice(0, 200) }
    }
  }
  /** What Hive reads as the session's developer_instructions: '' none, null when it can't tell (as Hive's own rule). */
  const effective = (args) => {
    const as = developerTexts(args)
    const cleared = developerTexts([...args, '-c', 'developer_instructions=""'])
    if (!Array.isArray(as) || !Array.isArray(cleared)) return { error: as.error ?? cleared.error }
    const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i])
    if (same(as, cleared)) return ''
    // One text more, anywhere, the rest the same (#1514: in front in 0.163.0, after the base instructions in 0.164.0).
    if (as.length !== cleared.length + 1) return null
    const k = as.findIndex((t, i) => t !== cleared[i])
    return same([...as.slice(0, k), ...as.slice(k + 1)], cleared) ? as[k].trim() : null
  }
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true })
  // A layer's file, with developer_instructions missing (undefined), or set to the value given.
  const layer = (file, value, extra = '') => fs.writeFileSync(file, `${value === undefined ? '' : `developer_instructions = ${toml(value)}\n`}${extra}`)
  const setLayers = ({ user: own, profile, project, trust = 'trusted' }) => {
    layer(config, own, `[projects.${toml(proj)}]\ntrust_level = ${toml(trust)}\n`)
    layer(path.join(home, 'mine.config.toml'), profile)
    layer(path.join(proj, '.codex', 'config.toml'), project)
  }
  const P = ['--profile', 'mine']
  const cases = [
    // The user's own config alone.
    [{ user: 'USER-ONLY' }, [], 'USER-ONLY'],
    [{}, [], ''],
    [{ user: '' }, [], ''],
    [{ user: '   ' }, [], ''],
    // A selected profile over the user's, in every form Codex takes; one that sets none leaves the user's.
    ...[['--profile', 'mine'], ['--profile=mine'], ['-p', 'mine'], ['-pmine'], ['-p=mine']].map((a) => [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY' }, a, 'PROFILE-ONLY']),
    [{ user: 'USER-ONLY' }, P, 'USER-ONLY'],
    // A profile set empty or blank clears the user's (HR4's round 3).
    [{ user: 'USER-ONLY', profile: '' }, P, ''],
    [{ user: 'USER-ONLY', profile: '   ' }, P, ''],
    // A trusted project's over the profile and the user's; set empty, it clears both (HR4's round 3); missing, the profile's.
    [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY', project: 'PROJECT-ONLY' }, P, 'PROJECT-ONLY'],
    [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY', project: '' }, P, ''],
    [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY', project: '   ' }, P, ''],
    [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY' }, P, 'PROFILE-ONLY'],
    [{ user: 'USER-ONLY', project: 'PROJECT-ONLY' }, [], 'PROJECT-ONLY'],
    // An untrusted project's is never taken (HR4's round 1), set or empty.
    [{ user: 'USER-ONLY', project: 'PROJECT-ONLY', trust: 'untrusted' }, [], 'USER-ONLY'],
    [{ user: 'USER-ONLY', profile: 'PROFILE-ONLY', project: '', trust: 'untrusted' }, P, 'PROFILE-ONLY']
  ]
  for (const [layers, args, want] of cases) {
    setLayers(layers)
    const got = effective(args)
    check(`developer_instructions with ${JSON.stringify(layers)} ${args.join(' ') || '(no arguments)'}: ${JSON.stringify(want)}`, got === want, JSON.stringify(got))
  }
  // Two profiles: Codex refuses them (so would the session); Hive, unable to read them, gives its guidance alone.
  setLayers({ user: 'USER-ONLY', profile: 'PROFILE-ONLY' })
  const twice = effective(['-p', 'other', '--profile', 'mine'])
  check('two profiles: Codex refuses them, and Hive reads no answer', /cannot be used multiple times/.test(twice?.error ?? ''), JSON.stringify(twice))

  // Its folder stays for the runner to prune: a Codex just ended can still hold its files for a moment.
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
