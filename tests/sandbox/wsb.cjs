/**
 * The little of wsb.exe the Sandbox checks use themselves, beside the windows-sandbox MCP server that runs the Sandbox:
 * whether this host can run one, which are running (so a run never starts beside another), and a confirmed stop of the
 * one this run started when the server's own stop couldn't be confirmed. Never a Sandbox it didn't start: stopConfirmed
 * takes only the id the server gave this run. Node built-ins only.
 *
 * Fails closed: `list` counts only with exit 0 and valid JSON holding an array of string Ids, and a stop counts only once
 * `list` confirms the id is gone.
 *
 * WSB_STUB (tests only, tests/sandbox/stub-wsb.cjs): a Node script run instead of wsb.exe, with the same arguments.
 */
const { execFile } = require('child_process')
const { lstatSync } = require('fs')
const { join } = require('path')
const os = require('os')

const WSB = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wsb.exe')
const STOP_ATTEMPTS = 3
const STOP_RETRY_MS = Number(process.env.WSB_STOP_RETRY_MS || 3000)
// Ids are GUIDs; checked before an id goes into a command line.
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const command = () => (process.env.WSB_STUB ? { file: process.execPath, pre: [process.env.WSB_STUB] } : { file: WSB, pre: [] })

/** Runs wsb with --raw; resolves { code, json, stdout, stderr }. Never rejects. */
function wsb(args, timeoutMs = 120_000) {
  const { file, pre } = command()
  return new Promise(resolve => {
    execFile(file, [...pre, ...args, '--raw'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json = null
      try { json = stdout.trim() ? JSON.parse(stdout) : null } catch { /* not JSON */ }
      const code = err ? (typeof err.code === 'number' ? err.code : err.killed ? 'timeout' : err.code || 'error') : 0
      resolve({ code, json, stdout: String(stdout).trim(), stderr: String(stderr).trim() })
    })
  })
}

/** Ids of the running Sandboxes. Throws unless list succeeded with the expected shape: unknown is never "none". */
async function list() {
  const r = await wsb(['list'], 60_000)
  const envs = r.json?.WindowsSandboxEnvironments
  if (r.code !== 0 || !Array.isArray(envs) || envs.some(e => typeof e?.Id !== 'string' || !e.Id)) {
    throw new Error(`wsb list failed or replied unexpectedly (exit ${r.code}): ${(r.stderr || r.stdout || 'no output').slice(0, 300)}`)
  }
  return envs.map(e => e.Id)
}

/**
 * Stops `id` (this run's own) and confirms with `list`, retrying a bounded number of times. Resolves { ok, attempts }:
 * ok only when `list` succeeded and no longer holds the id. `stop` exiting 0 is not enough on its own.
 */
async function stopConfirmed(id, { attempts = STOP_ATTEMPTS, retryMs = STOP_RETRY_MS } = {}) {
  if (!ID_RE.test(id)) return { ok: false, attempts: [{ error: `not a Sandbox id: ${id}` }] }
  const tries = []
  for (let n = 1; n <= attempts; n++) {
    const r = await wsb(['stop', '--id', id], 120_000)
    const t = { code: r.code, stderr: r.stderr ? r.stderr.slice(0, 300) : undefined, gone: false }
    try { t.gone = !(await list()).includes(id) } catch (e) { t.listError = e.message }
    tries.push(t)
    if (t.gone) return { ok: true, attempts: tries }
    if (n < attempts) await new Promise(res => setTimeout(res, retryMs))
  }
  return { ok: false, attempts: tries }
}

// Smart App Control's state, in the guest's registry (the guest's own, never the host's): 0 off, 1 on, 2 evaluation.
const SAC_QUERY = 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState'
/** Smart App Control's state from SAC_QUERY's output, or null if not read. */
const sacState = text => { const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text || ''); return m ? parseInt(m[1], 16) : null }

/** Why this host can't run Sandboxes, or null. */
function hostProblem() {
  if (process.env.WSB_STUB) return null
  if (process.platform !== 'win32') return 'Windows Sandbox needs Windows.'
  const build = Number(os.release().split('.')[2])
  if (!(build >= 26100)) return `Windows build ${os.release()} is older than 24H2 (26100), which wsb.exe needs.`
  // wsb.exe is an app execution alias: existsSync (which follows it) says no, lstat sees it.
  try { lstatSync(WSB) } catch {
    return `wsb.exe not found (${WSB}): turn on the "Windows Sandbox" optional feature (Windows 11 Pro or Enterprise) and make sure its app is installed.`
  }
  return null
}

module.exports = { WSB, ID_RE, list, stopConfirmed, hostProblem, SAC_QUERY, sacState }
