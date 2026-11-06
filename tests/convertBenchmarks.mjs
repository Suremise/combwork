// The scenario benchmarks in the test area, converted once to 1.1's names (HI-2605): a step of npm run test:move-area
// (tests/moveTestArea.mjs), after the move or on its own once the area is moved. Before 1.1 a benchmark had
// OLD_SCHEMA, and until HI-2591 its call measures were RENAMED_FIELDS' old names; Performance → Compare reads
// only the new names (HI-2587: benchmarks are dev artifacts, converted here, not read under two names), so a pass
// comparing with a baseline saved before (the rel-110-* ones) needs this.
//
// - Which files: every baseline (scenarios/baselines/*.json) and every run's benchmark (scenarios/results/*/benchmark.json).
// - Only those names change: each is replaced in the file's text, and the result is checked to parse as the same
//   benchmark with the new names (anything else leaves the file as it was, and says why). Every other byte stays.
// - A copy of each file, byte for byte, goes to BACKUP in the test area before it is written; a file's copy is written
//   once, so a rerun never replaces the original. Remove that folder by hand once the conversion is proved.
// - Safe to rerun: a converted file is skipped, each write is atomic (a temporary file renamed over it).
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, relative } from 'path'
import { isDeepStrictEqual } from 'util'

const require = createRequire(import.meta.url)
const { absent, present } = require('./testArea.cjs')
const { resultsHeld } = require('./scenarios/benchmark.cjs')

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** A benchmark's schema before 1.1, and since (src/shared/benchmark.ts BENCHMARK_SCHEMA). */
// old-name: begin old-benchmark-schema
export const OLD_SCHEMA = 'hive-benchmark/1'
// old-name: end old-benchmark-schema
export const NEW_SCHEMA = 'combwork-benchmark/1'
/** Where the originals are kept, in the test area. */
export const BACKUP = 'benchmark-schema-backup'

/** The benchmark files under area, relative to it: the baselines, then each run's benchmark.json. */
export function benchmarkFiles(area) {
  const list = (dir) => {
    try {
      return readdirSync(join(area, dir), { withFileTypes: true })
    } catch (e) {
      if (absent(e)) return []
      throw e
    }
  }
  const baselines = list('scenarios/baselines').filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => `scenarios/baselines/${d.name}`)
  const results = list('scenarios/results').filter((d) => d.isDirectory() && present(join(area, 'scenarios/results', d.name, 'benchmark.json'))).map((d) => `scenarios/results/${d.name}/benchmark.json`)
  return [...baselines.sort(), ...results.sort()]
}

/**
 * The fields HI-2591 renamed in a benchmark (a sample's measures, and each agent's row): old name → new. Benchmarks
 * written before it (every run before 2026-11-05 21:06, the 1.1 ones too) have the old names, which Compare doesn't
 * read: their call measures show as not measured, so a scenario compares as incomplete.
 */
// old-name: begin old-benchmark-fields
export const RENAMED_FIELDS = { hiveCalls: 'combworkCalls', hiveCallErrors: 'combworkCallErrors' }
// old-name: end old-benchmark-fields

const SCHEMA_RE = new RegExp(`("schema"\\s*:\\s*)"${OLD_SCHEMA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`)
const FIELD_RE = new RegExp(`"(${Object.keys(RENAMED_FIELDS).join('|')})"(\\s*:)`, 'g')

/** value as it reads converted: RENAMED_FIELDS' keys renamed at any depth. Throws when an object has both names. */
function renamed(value) {
  if (Array.isArray(value)) return value.map(renamed)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    const key = RENAMED_FIELDS[k] ?? k
    if (Object.hasOwn(out, key)) throw new Error('an object in it has both a field’s old and new names')
    out[key] = renamed(v)
  }
  return out
}

/**
 * text converted to 1.1's benchmark: its top-level schema OLD_SCHEMA made "combwork-benchmark/1", and the
 * fields RENAMED_FIELDS names renamed; nothing else changes (each replaced in the text, every other byte kept). Returns
 * { text } when converted, { skip: why } when there is nothing to convert, or { error: why } when it isn't safe to.
 */
export function convertText(text) {
  let before
  try {
    before = JSON.parse(text)
  } catch {
    return { error: "isn't whole JSON" }
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) return { error: "isn't a benchmark" }
  if (before.schema !== OLD_SCHEMA && before.schema !== NEW_SCHEMA) return { skip: `another schema (${JSON.stringify(before.schema ?? null)})` }
  const out = (before.schema === OLD_SCHEMA ? text.replace(SCHEMA_RE, `$1"${NEW_SCHEMA}"`) : text).replace(FIELD_RE, (_, k, colon) => `"${RENAMED_FIELDS[k]}"${colon}`)
  if (out === text) return { skip: 'converted already' }
  let after
  try {
    after = JSON.parse(out)
  } catch {
    return { error: "wouldn't be whole JSON after the change" }
  }
  // What it should read as: the same benchmark with the new schema and the fields renamed, and nothing else changed (a
  // field named so inside a string, a schema elsewhere than at the top, or an object with both names, isn't).
  let want
  try {
    want = renamed({ ...before, schema: NEW_SCHEMA })
  } catch (e) {
    return { error: e.message }
  }
  if (!isDeepStrictEqual(after, want)) return { error: 'its schema and fields can’t be changed alone' }
  return { text: out }
}

/**
 * The scenario runs going on in area: their results folders, which a runner holds until it ends (benchmark.cjs
 * resultsHeld), its baseline saved before then. Other tests (e2e lanes, unit runs) write no benchmark, so they don't count.
 */
export function scenarioRuns(area, alive = processAlive) {
  let names = []
  try {
    names = readdirSync(join(area, 'scenarios/results'))
  } catch (e) {
    if (absent(e)) return []
    throw e
  }
  return names.filter((n) => resultsHeld(join(area, 'scenarios/results', n), alive))
}

/**
 * Converts the benchmarks under area (benchmarkFiles); refuses (throws) while a scenario run is going on there.
 * opts: dryRun (says what it would do, writes nothing), alive (a pid's process is running), say.
 * Returns { converted, already, skipped: [{ file, why }], failed: [{ file, why }], backup }.
 */
export function convertBenchmarks(area, { dryRun = false, alive = processAlive, say = () => {} } = {}) {
  const runs = scenarioRuns(area, alive)
  if (runs.length) throw new Error(`Scenario benchmarks not converted: scenario runs are going on (${runs.map((r) => `results/${r}`).join(', ')}). Run this again once they end.`)
  const backup = join(area, BACKUP)
  const out = { converted: 0, already: 0, skipped: [], failed: [], backup }
  for (const rel of benchmarkFiles(area)) {
    const file = join(area, rel)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if (absent(e)) continue
      out.failed.push({ file: rel, why: `couldn't read it (${e.code || e.message})` })
      continue
    }
    const r = convertText(text)
    if (r.skip === 'converted already') out.already++
    else if (r.skip) out.skipped.push({ file: rel, why: r.skip })
    else if (r.error) out.failed.push({ file: rel, why: r.error })
    else if (dryRun) out.converted++
    else {
      try {
        const kept = join(backup, rel)
        if (!present(kept)) {
          mkdirSync(dirname(kept), { recursive: true })
          writeFileSync(kept, readFileSync(file))
        }
        // A copy from an earlier run is this file as it was then: the same, or an earlier step of the same conversion
        // (the schema converted before the fields were). Anything else: look.
        const was = readFileSync(kept, 'utf8')
        if (was !== text && convertText(was).text !== r.text) throw new Error(`its copy in ${BACKUP} is another version of it: look at both`)
        const tmp = `${file}.convert-${process.pid}`
        writeFileSync(tmp, r.text)
        if (readFileSync(file, 'utf8') !== text) {
          rmSync(tmp, { force: true })
          throw new Error('it changed while being converted')
        }
        renameSync(tmp, file)
        out.converted++
      } catch (e) {
        out.failed.push({ file: rel, why: e.message })
      }
    }
  }
  const verb = dryRun ? 'would convert' : 'converted'
  say(`Scenario benchmarks: ${verb} ${out.converted} to 1.1's names (${NEW_SCHEMA}, ${Object.values(RENAMED_FIELDS).join(', ')}), ${out.already} already were${out.skipped.length ? `, ${out.skipped.length} skipped` : ''}${out.failed.length ? `, ${out.failed.length} left as they were` : ''}.`)
  for (const f of [...out.skipped, ...out.failed]) say(`  ${f.file}: ${f.why}`)
  if (out.converted && !dryRun) say(`  The originals are in ${relative(area, backup)} in the test area: remove it once Compare reads them.`)
  return out
}
