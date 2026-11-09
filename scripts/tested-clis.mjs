// npm run tested-clis [run-record.json…]: writes the release's tested-with manifest (resources/tested-clis.json, #365)
// from real-tier e2e run records: the latest one (the e2e logs' run-record.json) unless files are given. Run it after
// the real tier's run on the commit being released, or the RC's before a version-only bump (`npm run e2e -- --all --only-real
// <Copilot's suites> --build --record`, RELEASING.md Step 4), then commit the manifest (RELEASING.md).
// Several records of the same commit may be given (#1105: the real tier rerun per CLI): each CLI's entry comes from
// the one in which all its real suites ran and passed. Exits 1 when it couldn't vouch for every CLI (it still writes
// those it could).
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { SUITES } from '../tests/e2e/suites.mjs'
import { CLI_PROVIDERS, MANIFEST, manifestFromRecords } from './testedClis.mjs'

const root = join(import.meta.dirname, '..')
const runContext = createRequire(import.meta.url)('../tests/e2e/runContext.cjs')
// --also <cli> (HI-2780): that CLI may be tested at more than one version at this commit, each in its own record.
const args = process.argv.slice(2)
const also = args.flatMap((a, i) => (args[i - 1] === '--also' ? [a] : []))
const given = args.filter((a, i) => a !== '--also' && args[i - 1] !== '--also')
const files = given.length ? given : [join(runContext.WORK, 'logs', 'run-record.json')]
const absent = files.filter((f) => !existsSync(f))
if (absent.length) {
  console.error(`No run record at ${absent.join(', ')}. Run the real tier with a record first: npm run e2e -- --all --only-real <Copilot's suites> --build --record (RELEASING.md Step 4)`)
  process.exit(1)
}
const records = files.map((f) => JSON.parse(readFileSync(f, 'utf8')))
const out = join(root, MANIFEST)
const current = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
const { manifest, updated, problems } = manifestFromRecords(records, SUITES, current, { also })
for (const [i, f] of files.entries()) console.log(`Run record: ${f} (code ${records[i].code ?? '?'}, ${records[i].when ?? '?'})`)
if (updated.length) {
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const id of updated) console.log(`  ${Object.values(CLI_PROVIDERS).find((p) => p.id === id).name}: tested with ${manifest[id].version}${manifest[id].also?.length ? ` (also ${manifest[id].also.map((a) => a.version).join(', ')})` : ''}`)
  console.log(`Wrote ${MANIFEST}: commit it.`)
}
for (const p of problems) console.log(`  Not updated: ${p}`)
process.exit(problems.length ? 1 : 0)
