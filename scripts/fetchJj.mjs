// npm run jj:fetch (HI-2793's J0): fetches the jj Combwork is tested with (resources/tested-vcs.json) for the real-jj
// fixtures: the official Windows zip, its SHA-256 checked before anything is unpacked, into the test area's tools folder
// (%LOCALAPPDATA%\combwork-test\tools\jj-<version>). Nothing system-wide, nothing on PATH. Already there: says so and
// checks its version. The zip goes once it is unpacked.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { tested, jjDir } = require('../tests/jjPortable.cjs')
const { assertReady } = require('../tests/testArea.cjs')

assertReady()
const dir = jjDir()
const exe = join(dir, 'jj.exe')
const versionOf = (file) => execFileSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { SYSTEMROOT: process.env.SYSTEMROOT ?? '', PATH: '' } }).trim()

if (existsSync(exe)) {
  console.log(`jj ${tested.version} is there already: ${exe} (${versionOf(exe)})`)
  process.exit(0)
}
mkdirSync(dir, { recursive: true })
// A run that stopped part-way left its staging folder: this script's own, in its own folder.
for (const name of readdirSync(dir)) if (/^unpack-\d+$/.test(name)) rmSync(join(dir, name), { recursive: true, force: true })
console.log(`Fetching ${tested.download.url}`)
const res = await fetch(tested.download.url)
if (!res.ok) {
  console.error(`The download failed: HTTP ${res.status}`)
  process.exit(1)
}
const zip = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(zip).digest('hex')
if (sha !== tested.download.sha256) {
  console.error(`The zip's SHA-256 is ${sha}, not ${tested.download.sha256}: not unpacked`)
  process.exit(1)
}
// Unpacked into a new folder beside the final one, then moved, so a half-unpacked jj is never taken for the real one.
const stage = join(dir, `unpack-${process.pid}`)
mkdirSync(stage)
const file = join(stage, 'jj.zip')
writeFileSync(file, zip)
// Windows' own tar (bsdtar, which reads zips), never a Git Bash tar on PATH (which takes `C:` for a host).
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
try {
  execFileSync(tar, ['-xf', file, '-C', stage], { windowsHide: true, stdio: 'inherit' })
} catch (e) {
  rmSync(stage, { recursive: true, force: true })
  throw e
}
rmSync(file)
if (!existsSync(join(stage, 'jj.exe'))) {
  console.error(`The zip has no jj.exe at its top: left in ${stage} to look at`)
  process.exit(1)
}
renameSync(join(stage, 'jj.exe'), exe)
rmSync(stage, { recursive: true })
const said = versionOf(exe)
if (!said.startsWith(`jj ${tested.version}`)) {
  console.error(`It says "${said}", not jj ${tested.version}`)
  process.exit(1)
}
console.log(`jj ${tested.version} (SHA-256 checked): ${exe}`)
