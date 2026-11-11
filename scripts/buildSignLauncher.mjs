// Builds cw-sign.exe (HI-2867) from resources/cw-sign/cw-sign.cs with Windows' own .NET Framework compiler (csc.exe,
// part of every Windows 10 and 11): no dependency, nothing prebuilt in the repository. electron.vite.config.ts runs it
// after each main build (npm run build, npm run dev, the e2e runner's builds), into out/bin; electron-builder.yml ships
// out/bin as resources/bin. Tests build their own copy (buildSignLauncher(<temp folder>)).
//
// Run alone: node scripts/buildSignLauncher.mjs [<output folder>]
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SIGN_LAUNCHER_SOURCE = join(ROOT, 'resources', 'cw-sign', 'cw-sign.cs')

/** Windows' .NET Framework 4 compiler, or null (not Windows, or no .NET Framework). */
export function frameworkCsc(env = process.env) {
  const win = env.SystemRoot || env.windir
  if (process.platform !== 'win32' || !win) return null
  for (const fw of ['Framework64', 'Framework']) {
    const csc = join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
    if (existsSync(csc)) return csc
  }
  return null
}

/**
 * Compiles the launcher into `outDir` (cw-sign.exe), unless the one there is newer than its source. Resolves to its path,
 * or null with the reason logged (no compiler: sessions then get no signer entries, and sign as before).
 */
export function buildSignLauncher(outDir = join(ROOT, 'out', 'bin'), log = console.warn) {
  const exe = join(outDir, 'cw-sign.exe')
  try {
    if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(SIGN_LAUNCHER_SOURCE).mtimeMs) return exe
  } catch {
    // compiled again below
  }
  const csc = frameworkCsc()
  if (!csc) {
    log('cw-sign.exe not built: no .NET Framework compiler (csc.exe) here. Sessions will sign as they did before HI-2867.')
    return null
  }
  mkdirSync(outDir, { recursive: true })
  try {
    execFileSync(csc, ['-nologo', '-optimize', '-target:exe', `-out:${exe}`, SIGN_LAUNCHER_SOURCE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (e) {
    log(`cw-sign.exe not built: ${String(e.stdout ?? '')}${String(e.stderr ?? '') || e.message}`)
    return null
  }
  return exe
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildSignLauncher(process.argv[2] ? resolve(process.argv[2]) : undefined)
  if (!out) process.exit(1)
  console.log(out)
}
