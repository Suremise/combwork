// HI-3378: the tests' one timing file (tests/timing.json), read by name, from the unit tests (TypeScript), the e2e suites
// (.cjs) and the runners (.mjs) alike. timing(name) is a value in ms; an unknown name throws, so a typo can't turn into a
// default. Overrides, in one place:
// - CW_TEST_TIMING: a JSON file of the same shape (or of plain numbers by name), merged over the defaults by name; a name
//   it gives that the defaults don't have is an error, as is a value that isn't a positive number of ms.
// - CW_TEST_TIMING_SCALE: a factor for the hang values alone (generous bounds of a hung run), never for a budget, a quiet
//   window, a pace or an interval, whose number is the point, nor a lock's age (when one run may take another's lock on
//   a shared machine: never shortened by a scale).
// Every value in force is a whole number of ms from 1 to the most a Node timer takes (MAX_MS), or loading fails: a scale
// or an override can't disable a limit (0) or overflow a timer into firing at once. Names are own properties only:
// `constructor`, `__proto__` and the like are no timing.
// Read once per process; both variables are in the e2e run context's PASS_ENV, so suites and their children see them.
const fs = require('fs')
const path = require('path')

const KINDS = ['hang', 'budget', 'quiet', 'pace', 'interval', 'seam', 'lock']
/** The most a Node timer takes (setTimeout's limit, 2^31 - 1 ms); past it the timer fires at once. */
const MAX_MS = 2 ** 31 - 1
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
/** A value in force, checked: a whole number of ms in range, else an error naming it and where it came from. */
const checked = (name, ms, from) => {
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_MS) throw new Error(`${from}: ${name} resolves to ${ms} ms, outside 1 to ${MAX_MS} (a Node timer's range)`)
  return Math.round(ms)
}

/** The defaults' file, and each entry's shape checked: { kind, ms, note }. */
function readDefaults(file = path.join(__dirname, 'timing.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const out = Object.create(null)
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith('$')) continue
    if (!v || typeof v !== 'object' || !KINDS.includes(v.kind) || !Number.isFinite(v.ms) || v.ms <= 0) throw new Error(`tests/timing.json: ${name} must be { kind: ${KINDS.join('|')}, ms: a positive number }`)
    out[name] = { kind: v.kind, ms: checked(name, v.ms, 'tests/timing.json'), note: typeof v.note === 'string' ? v.note : '' }
  }
  return out
}

/** The values in force: the defaults, the override file's values over them by name, then the hang values scaled. */
function resolve(env = process.env, defaults = readDefaults()) {
  const values = Object.create(null)
  for (const [n, v] of Object.entries(defaults)) values[n] = { ...v }
  const file = env.CW_TEST_TIMING
  if (file) {
    const over = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [name, v] of Object.entries(over)) {
      if (name.startsWith('$')) continue
      if (!own(values, name)) throw new Error(`CW_TEST_TIMING (${file}): no timing named ${name} (tests/timing.json lists them)`)
      const ms = typeof v === 'number' ? v : v && typeof v === 'object' ? v.ms : NaN
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`CW_TEST_TIMING (${file}): ${name} must be a positive number of ms`)
      values[name].ms = checked(name, ms, `CW_TEST_TIMING (${file})`)
    }
  }
  const scale = env.CW_TEST_TIMING_SCALE ? Number(env.CW_TEST_TIMING_SCALE) : 1
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`CW_TEST_TIMING_SCALE must be a positive number, not ${env.CW_TEST_TIMING_SCALE}`)
  for (const [name, v] of Object.entries(values)) if (v.kind === 'hang') v.ms = checked(name, v.ms * scale, `CW_TEST_TIMING_SCALE (${scale})`)
  return values
}

let current = null

/** A timing's value in ms, by name (tests/timing.json); an unknown name throws. */
function timing(name) {
  current ??= resolve()
  if (typeof name !== 'string' || !own(current, name)) throw new Error(`no timing named ${String(name)} (tests/timing.json lists them)`)
  return current[name].ms
}

/** Every timing in force, by name: { kind, ms, note }. */
function timings() {
  current ??= resolve()
  return current
}

module.exports = { timing, timings, resolve, readDefaults, KINDS, MAX_MS }
