// The one way Combwork calls the GitHub CLI (HI-3550, HI-2843's decision "(a)"): the user's own gh and its own
// sign-in, never a token of Combwork's. Every call names its host (`--hostname`) or its repository (`-R
// host/owner/repo`), so gh's default host is never assumed (HI-1201's finding). gh runs as a child process, so nothing
// waits on main's thread; its environment never carries a GitHub token (GH_TOKEN and the like are removed, never set);
// each call is bounded by Settings → Advanced's "GitHub CLI: longest a call takes"; a failure comes back as a kind and
// gh's own words, for the window to say in plain words. A test puts a fake gh first on the PATH it passes.

import { access } from 'original-fs/promises'
import { delimiter, join } from 'path'
import { GITHUB_GH_MINUTES } from '../shared/advanced'
import type { GhState, GhStatus, GithubRepoRef } from '../shared/githubRepo'
import { advanced } from './advanced'
import { createLogger, userText } from './logger'
import { run } from './providers/common'
import { parseGhStatus } from './providers/copilot/hosts'

const log = createLogger('github')

/** The variables that would sign gh in with a token instead of its own login: removed, in any spelling. */
export const GH_TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']

/** What gh is asked about: a host (`--hostname`), or a repository on one (`-R host/owner/repo`). */
export type GhTarget = { host: string } | { repo: GithubRepoRef }

/** A call's answer: its output (parsed when JSON was asked for), or why it failed. */
export type GhResult = { ok: true; stdout: string; json: unknown } | { ok: false; problem: Exclude<GhState, 'signedIn'>; detail: string | null }

/** The environment gh gets: the given one without any GitHub token, never prompting, without colour or update notices. */
export function ghEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !GH_TOKEN_VARS.includes(k.toUpperCase())) out[k] = v
  return { ...out, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '' }
}

/** gh on the environment's PATH, as cmd.exe finds it (gh.exe first, then a .cmd or .bat), or null. */
export async function findGh(env: Record<string, string | undefined>): Promise<string | null> {
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const name of ['gh.exe', 'gh.cmd', 'gh.bat']) {
      const f = join(dir.replace(/^"|"$/g, ''), name)
      try {
        await access(f)
        return f
      } catch {
        // not here
      }
    }
  }
  return null
}

/** An environment without GH_HOST, in any spelling: the call names its host itself. */
const withoutHost = (env: Record<string, string | undefined>): Record<string, string | undefined> => Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'GH_HOST'))

/** The bound on one call, from Settings → Advanced (read each time: a change applies to the next call). */
export function ghTimeoutMs(): number {
  const n = Number(advanced.get(GITHUB_GH_MINUTES))
  return Math.round((Number.isFinite(n) && n > 0 ? n : 2) * 60_000)
}

/** gh's words that say it isn't signed in there (its exit code 4 says so too). */
const SIGNED_OUT = /not logged in|gh auth login|authentication required|no oauth token|HTTP 401|Bad credentials/i

/** gh's first line of complaint, at most 300 characters. */
const firstWords = (s: string): string | null => {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  return line ? line.slice(0, 300) : null
}

/**
 * Runs gh with `args`, exactly as given, in `env` without its tokens: the low-level step every call goes through.
 * Copilot's sign-in check uses it with its agents' environment (its GH_HOST kept); everything else uses `gh()`.
 */
export async function ghExec(args: string[], opts: { env: Record<string, string | undefined>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number; missing?: true; timedOut?: true }> {
  const env = ghEnv(opts.env)
  const exe = await findGh(env)
  if (!exe) return { stdout: '', stderr: '', code: 1, missing: true }
  const r = await run(exe, args, opts.timeoutMs ?? ghTimeoutMs(), env)
  return { stdout: r.stdout, stderr: r.stderr, code: r.code, ...(r.timedOut ? { timedOut: true as const } : {}) }
}

/**
 * A gh call about a host or a repository: `args` (a gh command, such as `['pr', 'list']`), the target added as gh
 * takes it, and `--json`'s output parsed when `json` is set. Combwork's own environment, without GH_HOST (the target
 * names the host) or any token.
 */
export async function gh(target: GhTarget, args: string[], opts: { json?: boolean; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<GhResult> {
  const where = 'repo' in target ? ['-R', `${target.repo.host}/${target.repo.owner}/${target.repo.repo}`] : ['--hostname', target.host]
  const r = await ghExec([...args, ...where], { env: withoutHost(opts.env ?? process.env), timeoutMs: opts.timeoutMs })
  if (r.missing) return { ok: false, problem: 'missing', detail: null }
  if (r.timedOut) return { ok: false, problem: 'timeout', detail: null }
  if (r.code !== 0) {
    const detail = firstWords(r.stderr) ?? firstWords(r.stdout)
    log.info(`gh ${args[0] ?? ''} failed (${r.code}): ${userText(detail ?? '')}`)
    return { ok: false, problem: r.code === 4 || SIGNED_OUT.test(r.stderr) ? 'signedOut' : 'failed', detail }
  }
  if (!opts.json) return { ok: true, stdout: r.stdout, json: null }
  try {
    return { ok: true, stdout: r.stdout, json: JSON.parse(r.stdout) as unknown }
  } catch {
    return { ok: false, problem: 'failed', detail: firstWords(r.stdout) }
  }
}

/** gh's sign-in on `host` (`gh auth status --active --hostname <host> --json hosts`, never `gh auth token`) and version. */
export async function ghStatus(host: string, env?: Record<string, string | undefined>): Promise<GhStatus> {
  const at = (state: GhState, more: Partial<GhStatus> = {}): GhStatus => ({ host, state, login: null, version: null, error: null, ...more })
  const base = withoutHost(env ?? process.env)
  const version = await ghExec(['--version'], { env: base, timeoutMs: Math.min(ghTimeoutMs(), 30_000) })
  if (version.missing) return at('missing')
  const v = /gh version (\S+)/.exec(version.stdout)?.[1] ?? null
  // gh may exit non-zero and still say each host's state: its JSON is read whatever the exit code.
  const r = await ghExec(['auth', 'status', '--active', '--hostname', host, '--json', 'hosts'], { env: base })
  if (r.missing) return at('missing')
  if (r.timedOut) return at('timeout', { version: v })
  const s = r.stdout.trim() ? parseGhStatus(r.stdout, host) : null
  if (!s) {
    const detail = firstWords(r.stderr) ?? firstWords(r.stdout)
    return r.code === 4 || SIGNED_OUT.test(r.stderr) ? at('signedOut', { version: v }) : at('failed', { version: v, error: detail })
  }
  if (s.state === 'none') return at('signedOut', { version: v })
  if (s.state === 'success') return at('signedIn', { version: v, login: s.login })
  if (s.state === 'timeout') return at('timeout', { version: v, login: s.login })
  // error: gh has a login there it couldn't use (a revoked token, say): signed out, in gh's own words.
  return at(s.state === 'error' ? 'signedOut' : 'failed', { version: v, login: s.login, error: s.error })
}
