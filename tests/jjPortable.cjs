// The portable jj the real-jj fixtures run (HI-2793's J0): the official Windows build of the version Combwork is tested
// with (resources/tested-vcs.json), fetched and checked by `npm run jj:fetch` into the test area's tools folder, never
// installed system-wide and never on PATH. Tests run it only in tempDir() repositories, with jj's and git's config isolated.
const fs = require('fs')
const path = require('path')
const { areas } = require('./testArea.cjs')
const tested = require('../resources/tested-vcs.json').jj

/** Where the pinned jj lives: %LOCALAPPDATA%\combwork-test\tools\jj-<version>\jj.exe. */
function jjDir(env = process.env) {
  return path.join(areas(env).area, 'tools', `jj-${tested.version}`)
}

/** The portable jj.exe, or null when it hasn't been fetched (npm run jj:fetch). */
function portableJj(env = process.env) {
  const exe = path.join(jjDir(env), 'jj.exe')
  return fs.existsSync(exe) ? exe : null
}

module.exports = { tested, jjDir, portableJj }
