// The test area (HI-2590): %LOCALAPPDATA%\combwork-test, where the tests keep their profiles, the signed-in Claude Code
// and Codex test homes, the scenario baselines and results, the e2e lanes and logs, the Sandbox reports and the runs' temp
// folders (tests/README.md). Before 1.1 it was hive-test: npm run test:move-area (tests/moveTestArea.mjs) moves it once,
// one way. OLD_NAME is that move's source and this guard's, and nothing else's: no test reads or writes the old folder.
// The guard (assertReady) refuses a test run while the move is still to do or unfinished, so a run never starts a new,
// signed-out test home beside the old one, nor runs with trust entries half rewritten. The runners call it as they start
// (runTemp.mts startRunTemp: the unit, e2e and scenario runs), and so do a suite run alone (lib.cjs), npm run test:clean and
// the Sandbox checks.
const fs = require('fs')
const os = require('os')
const path = require('path')

/** The test area's folder name in %LOCALAPPDATA%. */
const NAME = 'combwork-test'
/** Its name before 1.1: the move's source, and only that. */
const OLD_NAME = 'hive-test'
/** In the test area while a move is unfinished (written in the old folder before the rename, so it moves with it). */
const MARKER = '.move-in-progress.json'

/** The test area and its old folder, in env's LOCALAPPDATA (the temp folder where it is unset, off Windows). */
function areas(env = process.env) {
  const local = env.LOCALAPPDATA || os.tmpdir()
  return { area: path.join(local, NAME), old: path.join(local, OLD_NAME) }
}

/** Why a test run can't use the test area yet, or null when it can. Reads nothing in the old folder: it only looks for it. */
function notReady({ area, old } = areas()) {
  if (fs.existsSync(path.join(area, MARKER))) return `The test area's move to ${area} is unfinished: run npm run test:move-area again (HI-2590).`
  if (fs.existsSync(old) && !fs.existsSync(area)) return `The test area is still at ${old}: move it first with npm run test:move-area (HI-2590), while no test runs.`
  return null
}

/** Throws notReady's reason, if there is one. */
function assertReady(dirs) {
  const why = notReady(dirs)
  if (why) throw new Error(why)
}

module.exports = { NAME, OLD_NAME, MARKER, areas, notReady, assertReady }
