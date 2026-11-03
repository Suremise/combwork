// The environment a test's Windows PowerShell (powershell.exe, 5.1) runs in (HI-2401): what it has on any machine, not
// a few variables of it. Built from the run context's allowlist (tests/e2e/runContext.cjs: Windows' own variables, the
// user's folders, the temp folder), so nothing else of the test's shell reaches it. With fewer, PowerShell has no
// LOCALAPPDATA for its module-analysis cache, nor the PSModuleAnalysisCachePath a machine can set (GitHub's
// windows-latest image sets it, and warms that cache): its first auto-loaded cmdlet (Get-CimInstance, Test-Path,
// Start-Sleep) then analyses every module cold, which there took longer than the tests' bounds.
import { createRequire } from 'module'
import { join } from 'path'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: (parent?: NodeJS.ProcessEnv) => Record<string, string> }

/**
 * Windows PowerShell's environment, from `parent`'s allowlisted variables. Its module path is `parent`'s without
 * PowerShell 7's folders (a pwsh shell, as GitHub's runner steps use, puts its own first, and 5.1 can't load their
 * modules), and always with 5.1's own modules folder.
 */
export function powershellEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = baseEnv(parent)
  const named = (name: string): string | undefined => Object.keys(env).find((k) => k.toUpperCase() === name)
  const rootKey = named('SYSTEMROOT')
  const own = join(rootKey ? env[rootKey] : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  const key = named('PSMODULEPATH')
  const pwsh7 = (d: string): boolean => /[\\/]PowerShell[\\/]/i.test(d)
  const folders = (key ? env[key] : '').split(';').filter((d) => d && !pwsh7(d))
  if (!folders.some((d) => d.replace(/[\\/]+$/, '').toLowerCase() === own.toLowerCase())) folders.push(own)
  if (key) delete env[key]
  env.PSModulePath = folders.join(';')
  return env
}
