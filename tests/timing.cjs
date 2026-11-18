// HI-3378: the tests' one timing file (tests/timing.json), read by name, from the unit tests (TypeScript), the e2e suites
// (.cjs) and the runners (.mjs) alike. timing(name) is a value in ms; an unknown name throws, so a typo can't turn into a
// default. Overrides, in one place:
// - CW_TEST_TIMING: a JSON file of the same shape (or of plain numbers by name), merged over the defaults by name; a name
//   it gives that the defaults don't have is an error, as is a value that isn't a positive number of ms.
// - CW_TEST_TIMING_SCALE: a factor for the hang values alone (generous bounds of a hung run), never for a budget, a quiet
//   window, a pace or an interval, whose number is the point.
// Read once per process; both variables are in the e2e run context's PASS_ENV, so suites and their children see them.
const fs = require('fs')
const path = require('path')

const KINDS = ['hang', 'budget', 'quiet', 'pace', 'interval', 'seam']

/** The defaults' file, and each entry's shape checked: { kind, ms, note }. */
function readDefaults(file = path.join(__dirname, 'timing.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const out = {}
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith('$')) continue
    if (!v || typeof v !== 'object' || !KINDS.includes(v.kind) || !Number.isFinite(v.ms) || v.ms <= 0) throw new Error(`tests/timing.json: ${name} must be { kind: ${KINDS.join('|')}, ms: a positive number }`)
    out[name] = { kind: v.kind, ms: v.ms, note: typeof v.note === 'string' ? v.note : '' }
  }
  return out
}

/** The values in force: the defaults, the override file's values over them by name, then the hang values scaled. */
function resolve(env = process.env, defaults = readDefaults()) {
  const values = Object.fromEntries(Object.entries(defaults).map(([n, v]) => [n, { ...v }]))
  const file = env.CW_TEST_TIMING
  if (file) {
    const over = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [name, v] of Object.entries(over)) {
      if (name.startsWith('$')) continue
      if (!values[name]) throw new Error(`CW_TEST_TIMING (${file}): no timing named ${name} (tests/timing.json lists them)`)
      const ms = typeof v === 'number' ? v : v && typeof v === 'object' ? v.ms : NaN
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`CW_TEST_TIMING (${file}): ${name} must be a positive number of ms`)
      values[name].ms = ms
    }
  }
  const scale = env.CW_TEST_TIMING_SCALE ? Number(env.CW_TEST_TIMING_SCALE) : 1
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`CW_TEST_TIMING_SCALE must be a positive number, not ${env.CW_TEST_TIMING_SCALE}`)
  for (const v of Object.values(values)) if (v.kind === 'hang') v.ms = Math.round(v.ms * scale)
  return values
}

let current = null

/** A timing's value in ms, by name (tests/timing.json); an unknown name throws. */
function timing(name) {
  current ??= resolve()
  const v = current[name]
  if (!v) throw new Error(`no timing named ${name} (tests/timing.json lists them)`)
  return v.ms
}

/** Every timing in force, by name: { kind, ms, note }. */
function timings() {
  current ??= resolve()
  return current
}

module.exports = { timing, timings, resolve, readDefaults, KINDS }
