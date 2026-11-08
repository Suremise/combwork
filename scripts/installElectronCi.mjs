// CI's Electron install (HI-2751): fetches Electron's binary once, before the tests, with retries. npm 11 blocks
// install scripts, so after `npm ci` the binary isn't there, and the first test to load Electron used to download it
// mid-run with no retry: a GitHub 504 then failed whichever files happened to load it. This runs Electron's own
// installer (node_modules/electron/install.js, what `npx install-electron --no` runs), which downloads into
// electron_config_cache when the zip isn't cached there and unzips it into node_modules/electron/dist.
//   node scripts/installElectronCi.mjs              install, up to 4 attempts with growing pauses
//   node scripts/installElectronCi.mjs --version    print the Electron version (CI's cache key)
// It exits 1 with "Electron download failed" (a GitHub error annotation in CI) when every attempt fails.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const ELECTRON = join(import.meta.dirname, '..', 'node_modules', 'electron')
const { version } = JSON.parse(readFileSync(join(ELECTRON, 'package.json'), 'utf8'))

if (process.argv.includes('--version')) {
  console.log(version)
  process.exit(0)
}

/** Pauses before attempts 2, 3 and 4: a release-download hiccup usually clears within a minute. */
const PAUSES_S = [15, 45, 90]

function installed() {
  try {
    const exe = readFileSync(join(ELECTRON, 'path.txt'), 'utf8')
    return readFileSync(join(ELECTRON, 'dist', 'version'), 'utf8').trim().replace(/^v/, '') === version && existsSync(join(ELECTRON, 'dist', exe))
  } catch {
    return false
  }
}

function runInstaller() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ELECTRON, 'install.js')], { stdio: 'inherit' })
    child.on('error', (err) => {
      console.error(err.message)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const cache = process.env.electron_config_cache
console.log(`Electron ${version}; cache: ${cache || "@electron/get's default"}${cache && existsSync(cache) ? '' : ' (empty)'}`)
for (let attempt = 1; ; attempt++) {
  const code = await runInstaller()
  if (code === 0 && installed()) {
    console.log(`Electron ${version} installed (attempt ${attempt}).`)
    process.exit(0)
  }
  const pause = PAUSES_S[attempt - 1]
  if (pause === undefined) break
  console.log(`Attempt ${attempt} failed (exit ${code}); trying again in ${pause} s.`)
  await delay(pause * 1000)
}
const message = `Electron download failed: Electron ${version} couldn't be installed after ${PAUSES_S.length + 1} attempts (see the errors above).`
console.error(process.env.GITHUB_ACTIONS ? `::error title=Electron download failed::${message}` : message)
process.exit(1)
