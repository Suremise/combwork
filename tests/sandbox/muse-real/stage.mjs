/**
 * Stages Muse Code's real-binary check for a Windows Sandbox turn (HI-3202; README.md beside this). Bundles run.ts with
 * Combwork's own launch code (src/main/providers/muse) into one run.cjs, and copies beside it the pinned muse.exe (its
 * SHA-256 checked), this Node's node.exe, the MCP stub and go.cmd, into a new folder inside the checkout (the Sandbox maps
 * only folders under its client's roots): out\muse-real-<time>, which git ignores.
 *
 *   node tests/sandbox/muse-real/stage.mjs [--muse <muse.exe>]   stage it; prints the folder
 *   node tests/sandbox/muse-real/stage.mjs --dry                   build every launch on this machine without starting Muse
 *
 * Nothing here starts Muse: the folder runs only inside the Sandbox (`C:\build\go.cmd`).
 */
import { createHash } from 'crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const SHA = '2d223f7f992f02c313225ed47adf3dda24e7361b6b8389f2c19f7c12f026618a'
const argv = process.argv.slice(2)
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null)
const dry = argv.includes('--dry')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
// A new folder each run (never one emptied by a computed path).
const out = dry ? join(process.env.LOCALAPPDATA || '', 'combwork-test', 'tmp', `muse-real-dry-${stamp}`) : join(ROOT, 'out', `muse-real-${stamp}`)
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(HERE, 'run.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(out, 'run.cjs'),
  alias: { 'original-fs': 'fs', 'original-fs/promises': 'fs/promises', electron: join(HERE, 'electron-stub.cjs') },
  logLevel: 'warning'
})
copyFileSync(join(HERE, 'mcp.cjs'), join(out, 'mcp.cjs'))

if (dry) {
  const r = spawnSync(process.execPath, [join(out, 'run.cjs')], { env: { ...process.env, MUSE_REAL_DRY: out }, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

const muse = opt('--muse') || join(process.env.LOCALAPPDATA || '', 'combwork-test', 'muse-1.4.20', 'muse.exe')
const sha = createHash('sha256').update(readFileSync(muse)).digest('hex')
if (sha !== SHA) {
  console.error(`${muse} is not the pinned Muse Code 1.4.20 (SHA-256 ${sha})`)
  process.exit(1)
}
copyFileSync(muse, join(out, 'muse.exe'))
copyFileSync(process.execPath, join(out, 'node.exe'))
writeFileSync(
  join(out, 'go.cmd'),
  ['@echo off', 'rem Muse Code 1.4.20 checked offline and headless (HI-3202): nothing typed or answered.', 'if not exist C:\\out mkdir C:\\out', '"%~dp0node.exe" "%~dp0run.cjs" > C:\\out\\console.txt 2>&1', 'echo exit %errorlevel% >> C:\\out\\console.txt', ''].join('\r\n')
)
console.log(out)
