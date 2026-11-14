// Which signer git would run without Combwork (HI-2867): cw-sign's choice, read from git itself in the commit's folder
// with Combwork's own entries taken out (signerRules.withoutOurEntries), every other scope, include and command entry
// kept. A process of its own runs it (cw-sign.js), so it may wait on git; main never calls it.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { envGet, lastScoped } from './signerRules'

/** The git that called (its exec path is in GIT_EXEC_PATH), else the one on PATH. */
export function gitOf(env: NodeJS.ProcessEnv): string {
  const exec = envGet(env, 'GIT_EXEC_PATH')
  const own = exec ? join(exec, process.platform === 'win32' ? 'git.exe' : 'git') : null
  return own && existsSync(own) ? own : 'git'
}

/**
 * git's signer setting for `kind` as git reads it in `cwd` with `env`: null unset, `{ failed }` when git couldn't say.
 * gpg.program and gpg.openpgp.program are one setting under two names: the last occurrence git reads wins (git-config's
 * gpg.<format>.program; as HI-1185's check reads it).
 */
export function configuredSigner(git: string, cwd: string, env: NodeJS.ProcessEnv, kind: 'ssh' | 'openpgp'): string | null | { failed: string } {
  const args = kind === 'ssh' ? ['config', '--show-scope', '--get', 'gpg.ssh.program'] : ['config', '--show-scope', '--get-regexp', '^gpg\\.(openpgp\\.)?program$']
  const r = spawnSync(git, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (r.status === 0) return lastScoped(r.stdout, kind === 'openpgp')?.value || null
  if (r.status === 1 && !r.error) return null
  return { failed: (r.stderr || r.error?.message || `exit ${r.status}`).trim() }
}
