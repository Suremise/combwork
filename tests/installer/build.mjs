// Builds the installer handoff's stand-ins (#1647, harness.nsi) with the makensis electron-builder downloaded, with
// installer.nsh as a build includes it: warnings as errors, UTF-8. Usage: node tests/installer/build.mjs <out folder>
// (the stand-ins for run.ps1 in Windows Sandbox), or --check (compiles each variant, an uninstaller's too, writing to a
// temp folder: what tests/installerScript.test.ts runs). Exits 2 when makensis isn't there (no electron-builder build yet).
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const here = fileURLToPath(new URL('.', import.meta.url))
const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis')
const makensis = join(cache, 'nsis-3.0.4.1', 'Bin', 'makensis.exe')
const plugins = join(cache, 'nsis-resources-3.4.1', 'plugins', 'x86-unicode')

/** The stand-ins: a local build's installer (its real wait, and a 3 s one for the timeout), and a release's. */
export const VARIANTS = [
  { file: 'local.exe', env: '1', defines: [] },
  { file: 'local-short.exe', env: '1', defines: ['-DCW_INSTALLER_WAIT_MS=3000'] },
  { file: 'release.exe', env: '0', defines: [] }
]

/** Compiles one variant to `out`: its output and whether it compiled. */
export function compile(out, v, extra = []) {
  const r = spawnSync(makensis, ['-WX', '-INPUTCHARSET', 'UTF8', `-DPLUGINS=${plugins}`, `-DOUT=${out}`, ...v.defines, ...extra, join(here, 'harness.nsi')], { encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows`, CW_LOCAL_BUILD: v.env } })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(makensis)) {
    console.error(`No makensis at ${makensis}: build an installer once (npm run dist) so electron-builder downloads it.`)
    process.exit(2)
  }
  const check = process.argv.includes('--check')
  const dir = check ? mkdtempSync(join(process.env.LOCALAPPDATA ?? '', 'hive-test', 'tmp', 'installer-')) : process.argv[2]
  if (!dir) {
    console.error('Usage: node tests/installer/build.mjs <out folder> | --check')
    process.exit(2)
  }
  mkdirSync(dir, { recursive: true })
  let failed = 0
  for (const v of VARIANTS) for (const extra of check ? [[], ['-DBUILD_UNINSTALLER']] : [[]]) {
    const r = compile(join(dir, v.file), v, extra)
    console.log(`${r.ok ? 'ok' : 'FAILED'} ${v.file}${extra.length ? ' (uninstaller build)' : ''}`)
    if (!r.ok) {
      failed++
      console.log(r.output.split(/\r?\n/).filter((l) => /warning|error/i.test(l)).join('\n'))
    }
  }
  if (check) rmSync(dir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
