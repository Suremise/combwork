// Hive's hooks run beside the user's own Codex hooks (#1285, #966 row 11, Darren's decision: no "Keep my Codex hooks"
// switch, as there is nothing to keep). Asked of the installed Codex's own hook discovery (its app server's hooks/list),
// so a Codex that starts letting Hive's -c overrides displace the user's hooks, or drop their trust, fails here first:
// - the user's Stop and PreToolUse hooks (their config.toml) and Hive's of the same events (-c hooks.<event>, the session
//   flags) are listed side by side, each under its own key;
// - the user's trust records (their config.toml's hooks.state) survive Hive's -c hooks.state table: their hooks stay
//   trusted, and Hive's table names only its own session-flags keys.
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
const env = () => lib.childEnv({ CODEX_HOME: home, PATH: lib.pathWithoutStoreAliases() })
const toml = (s) => JSON.stringify(s)

/** Hive's form of a hook (-c hooks.<event>=[{ matcher, hooks = [{ type, command, timeout }] }]). */
const hiveHook = (event, matcher) => ['-c', `hooks.${event}=[{ ${matcher ? `matcher = ${toml(matcher)}, ` : ''}hooks = [{ type = "command", command = ${toml(`echo hive-${event}`)}, timeout = 5 }] }]`]

/** Codex's app server's hooks/list for the project, given `args`: its hooks, each with its source, command and trust. */
function hooksList(args) {
  return new Promise((resolve) => {
    const p = spawn('codex.exe', ['app-server', ...args], { cwd: proj, env: env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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

  // Its folder stays for the runner to prune: a Codex just ended can still hold its files for a moment.
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
