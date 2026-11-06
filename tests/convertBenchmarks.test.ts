// The scenario benchmarks' one-time conversion to 1.1's names (HI-2605, tests/convertBenchmarks.mjs, a step of
// npm run test:move-area): the schema and the call measures HI-2591 renamed, and nothing else; the originals are kept
// byte for byte, a rerun changes nothing, and Performance → Compare reads what it wrote.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { compareArtifacts, parseArtifact, type Artifact, type CompareScope } from '../src/shared/benchmark'
// @ts-expect-error: a plain .mjs module without types
import { BACKUP, NEW_SCHEMA, OLD_SCHEMA, benchmarkFiles, convertBenchmarks, convertText } from './convertBenchmarks.mjs'
import { tempDir } from './tempDir'

const WS: CompareScope = { kind: 'workspace' }
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'benchmarks', `${name}.json`), 'utf8')
/** The fixture's call measures as they were named before HI-2591. */
// old-name: begin old-fields
const oldFields = (text: string): string => text.replace(/"combworkCall(s|Errors)":/g, '"hiveCall$1":')
// old-name: end old-fields
/** The fixture as 1.0 saved it (the old schema and field names), with CRLF line ends, to show every other byte stays. */
const old = (name: string): string => oldFields(fixture(name).replace(NEW_SCHEMA, OLD_SCHEMA)).replace(/\r?\n/g, '\r\n')
/** As a 1.1 run saved it before HI-2591: the new schema, the old field names. */
const early11 = (name: string): string => oldFields(fixture(name))

function area(files: Record<string, string>): string {
  const dir = tempDir('convert-benchmarks-')
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')
const artifact = (text: string): Artifact => (parseArtifact(text, WS) as { artifact: Artifact }).artifact

describe("the scenario benchmarks' names, converted once (HI-2605)", () => {
  it('changes only the schema and the renamed fields: every other byte stays, and Compare reads it as the same benchmark', () => {
    const before = old('baseline')
    // old-name: begin old-fields-before
    expect(before).toMatch(/"hiveCalls":/)
    // old-name: end old-fields-before
    expect(parseArtifact(before, WS)).toMatchObject({ error: expect.stringMatching(/isn’t a Combwork benchmark/) })
    const { text } = convertText(before)
    expect(text).toBe(fixture('baseline').replace(/\r?\n/g, '\r\n'))
    // Against a 1.1 run of the same: every scenario the same (with the old field names, its call measures would be unmeasured).
    const cmp = compareArtifacts(artifact(text), artifact(fixture('baseline')))
    expect(cmp.comparable).toBe(true)
    expect(cmp.summary).toEqual({ same: 4 })
    const unconverted = compareArtifacts(artifact(early11('baseline')), artifact(fixture('baseline')))
    expect(unconverted.scenarios?.find((s) => s.id === 'work-on-card')?.status).toBe('incomplete')
  })

  it('renames the fields of a 1.1 benchmark written before HI-2591, keeping its schema', () => {
    expect(convertText(early11('baseline'))).toEqual({ text: fixture('baseline') })
  })

  it('leaves alone what is converted already and another schema, and what it can’t change alone', () => {
    expect(convertText(fixture('baseline'))).toEqual({ skip: 'converted already' })
    // old-name: begin old-fields-cases-1
    expect(convertText('{"schema":"combwork-metrics/1","hiveCalls":1}')).toMatchObject({ skip: expect.stringMatching(/another schema/) })
    expect(convertText('{"schema": "hive-')).toMatchObject({ error: expect.any(String) })
    // old-name: end old-fields-cases-1
    expect(convertText('[1]')).toMatchObject({ error: expect.any(String) })
    // A schema with the old id nested before the top-level one; both names in one object.
    expect(convertText(`{"note":{"schema":"${OLD_SCHEMA}"},"schema":"${OLD_SCHEMA}"}`)).toMatchObject({ error: expect.any(String) })
    // old-name: begin old-fields-cases-2
    expect(convertText(`{"schema":"${NEW_SCHEMA}","m":{"hiveCalls":1,"combworkCalls":2}}`)).toMatchObject({ error: expect.stringMatching(/both/) })
    // old-name: end old-fields-cases-2
    // Only field names change: a value that says one stays.
    // old-name: begin old-fields-cases-3
    expect(convertText(`{"schema":"${NEW_SCHEMA}","note":"hiveCalls","m":{"hiveCalls" : 1}}`)).toEqual({ text: `{"schema":"${NEW_SCHEMA}","note":"hiveCalls","m":{"combworkCalls" : 1}}` })
    // old-name: end old-fields-cases-3
  })

  it('converts the baselines and each run’s benchmark, keeps the originals byte for byte, and a rerun changes nothing', () => {
    const files = {
      'scenarios/baselines/rel-110-rc2-fake.json': old('baseline'),
      'scenarios/baselines/hi2598-after.json': early11('baseline'),
      'scenarios/baselines/hi2605-after.json': fixture('baseline'),
      'scenarios/baselines/notes.txt': `"schema": "${OLD_SCHEMA}"`,
      'scenarios/results/2026-11-05T01-56-50-fake/benchmark.json': old('baseline'),
      'scenarios/results/2026-11-05T01-56-50-fake/results.json': `{"schema":"${OLD_SCHEMA}"}`,
      'scenarios/results/2026-11-05T22-10-00-fake/benchmark.json': fixture('baseline')
    }
    const dir = area(files)
    expect(benchmarkFiles(dir)).toEqual(['scenarios/baselines/hi2598-after.json', 'scenarios/baselines/hi2605-after.json', 'scenarios/baselines/rel-110-rc2-fake.json', 'scenarios/results/2026-11-05T01-56-50-fake/benchmark.json', 'scenarios/results/2026-11-05T22-10-00-fake/benchmark.json'])

    expect(convertBenchmarks(dir, { dryRun: true })).toMatchObject({ converted: 3, already: 2, failed: [] })
    for (const [rel, text] of Object.entries(files)) expect(read(dir, rel)).toBe(text)

    const lines: string[] = []
    expect(convertBenchmarks(dir, { say: (l: string) => lines.push(l) })).toMatchObject({ converted: 3, already: 2, failed: [], skipped: [] })
    expect(lines[0]).toMatch(/converted 3 .* 2 already/)
    for (const rel of ['scenarios/baselines/rel-110-rc2-fake.json', 'scenarios/baselines/hi2598-after.json', 'scenarios/results/2026-11-05T01-56-50-fake/benchmark.json']) {
      expect(read(dir, rel)).toBe(convertText(files[rel as keyof typeof files]).text)
      expect(readFileSync(join(dir, BACKUP, rel))).toEqual(Buffer.from(files[rel as keyof typeof files], 'utf8'))
    }
    // What isn't a benchmark file, and the files converted already, are untouched; no temporary file is left.
    for (const rel of ['scenarios/baselines/notes.txt', 'scenarios/results/2026-11-05T01-56-50-fake/results.json', 'scenarios/baselines/hi2605-after.json']) expect(read(dir, rel)).toBe(files[rel as keyof typeof files])
    expect(readdirSync(join(dir, 'scenarios/baselines')).filter((n) => n.includes('.convert-'))).toEqual([])

    expect(convertBenchmarks(dir)).toMatchObject({ converted: 0, already: 5, failed: [] })
    expect(readFileSync(join(dir, BACKUP, 'scenarios/baselines/rel-110-rc2-fake.json'), 'utf8')).toBe(files['scenarios/baselines/rel-110-rc2-fake.json'])
  })

  it('refuses while a scenario run holds its results folder, and writes nothing', () => {
    const rel = 'scenarios/baselines/a.json'
    const dir = area({ [rel]: old('baseline'), 'scenarios/results/2026-11-05T22-00-00-fake/runner.json': JSON.stringify({ pid: process.pid }) })
    expect(() => convertBenchmarks(dir)).toThrow(/scenario runs are going on \(results\/2026-11-05T22-00-00-fake\)/)
    expect(read(dir, rel)).toBe(old('baseline'))
    expect(convertBenchmarks(dir, { alive: () => false })).toMatchObject({ converted: 1 })
  })

  it('goes on from an earlier run’s copy (the same file, or an earlier step of its conversion), and refuses another version', () => {
    const rel = 'scenarios/baselines/a.json'
    const same = area({ [rel]: old('baseline'), [`${BACKUP}/${rel}`]: old('baseline') })
    expect(convertBenchmarks(same)).toMatchObject({ converted: 1, failed: [] })

    // The schema was converted by an earlier run that didn't rename the fields: its copy, the original, stays.
    const step = area({ [rel]: oldFields(old('baseline').replace(OLD_SCHEMA, NEW_SCHEMA)), [`${BACKUP}/${rel}`]: old('baseline') })
    expect(convertBenchmarks(step)).toMatchObject({ converted: 1, failed: [] })
    expect(read(step, rel)).toBe(convertText(old('baseline')).text)
    expect(read(step, `${BACKUP}/${rel}`)).toBe(old('baseline'))

    const other = area({ [rel]: old('baseline'), [`${BACKUP}/${rel}`]: old('baseline').replace('{', '{ ') })
    expect(convertBenchmarks(other)).toMatchObject({ converted: 0, failed: [{ file: rel, why: expect.stringMatching(/another version/) }] })
    expect(read(other, rel)).toBe(old('baseline'))
  })
})
