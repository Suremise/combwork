// The Microsoft Store's PowerShell 7 and Codex's sandbox (#584, kept visible for #585): while any other process of that
// package runs on the machine, the sandbox can't start it (#499: error 5 by its WindowsApps alias, 0xC0070005 by the
// package's own path), so a Codex agent whose commands run in it fails whenever a pwsh is open. The real Codex suites
// run commands in Windows PowerShell for this (lib.pathWithoutStoreAliases); this suite checks the refusal itself, with
// a Store pwsh held open on purpose: the sandbox refuses the Store's pwsh, and starts Windows PowerShell. If Codex starts
// the Store's pwsh one day, this fails, saying so: #585 and the suites' PATH are to be looked at again. Through `codex
// sandbox` in the Codex test home (no model, no tokens); skipped where the Store's PowerShell 7 isn't installed.
const lib = require('./lib.cjs')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.step')

const alias = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
const windowsPowerShell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const ws = path.join(lib.WORK, 'codex-storepwsh-ws')
const LAUNCHES = 3
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

/** One `codex sandbox` launch of a shell that exits at once: { code, refused (CreateProcessAsUserW's code), out }. */
const sandboxed = (exe) =>
  new Promise((resolve) => {
    const p = spawn('codex.exe', ['sandbox', '--', exe, '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { cwd: ws, env: lib.childEnv({ CODEX_HOME: lib.CODEX_HOME }), windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('error', (e) => resolve({ code: null, refused: null, out: String(e) }))
    p.on('close', (code) => resolve({ code, refused: /CreateProcessAsUserW failed: (-?\d+)/.exec(out)?.[1] ?? null, out: out.slice(0, 300) }))
  })

;(async () => {
  let held = null
  try {
    try {
      fs.lstatSync(alias)
    } catch {
      lib.skip("the Store's PowerShell 7 isn't installed here (no WindowsApps alias)")
    }
    if (!lib.codexSignedIn()) lib.skip('the Codex test home has no sign-in (tests/e2e/README.md)')
    fs.rmSync(ws, { recursive: true, force: true })
    fs.mkdirSync(ws, { recursive: true })

    // A plain Store pwsh held open, waiting on its stdin: #499's trigger, on purpose.
    held = spawn(alias, ['-NoProfile', '-NonInteractive', '-Command', "'READY'; [void][Console]::In.ReadLine()"], { env: lib.childEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let said = ''
    held.stdout.on('data', (d) => (said += d))
    check("a Store pwsh is held open (the trigger)", !!(await lib.until(() => said.includes('READY'), HUNG_MS)), said)

    const store = []
    for (let i = 0; i < LAUNCHES; i++) store.push(await sandboxed(alias))
    const refusedAll = store.every((r) => r.code !== 0 && (r.refused === '5' || r.refused === '-1073283067'))
    check(
      `the sandbox refuses the Store's pwsh while another of its processes runs (${LAUNCHES} of ${LAUNCHES}, #499)`,
      refusedAll,
      store.some((r) => r.code === 0) ? "it started the Store's pwsh: Codex may have fixed #499 upstream; look at #585 again, and at lib.pathWithoutStoreAliases" : JSON.stringify(store)
    )
    const plain = []
    for (let i = 0; i < LAUNCHES; i++) plain.push(await sandboxed(windowsPowerShell))
    check(`…while it starts Windows PowerShell (${LAUNCHES} of ${LAUNCHES}): what the Codex suites run commands in`, plain.every((r) => r.code === 0), JSON.stringify(plain))
  } finally {
    if (held) {
      const gone = new Promise((r) => (held.exitCode !== null ? r() : held.once('exit', r)))
      held.stdin.end('\n')
      if (!(await Promise.race([gone.then(() => true), new Promise((r) => setTimeout(() => r(false), HUNG_MS))]))) lib.endChildTree(held)
    }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
