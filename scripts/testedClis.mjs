// The release's tested-with manifest (resources/tested-clis.json, #365): which version of each coding agent CLI this
// Combwork was tested with. Made only from a real-tier e2e run record (tests/e2e/record.mjs, run-record.json), never typed
// by hand: `npm run tested-clis` (tested-clis.mjs) after `npm run e2e -- --all --real --build --record`, and
// `npm run release` refuses a manifest whose record isn't of the code being released (RELEASING.md).

import { REAL_CLIS } from '../tests/e2e/record.mjs'

/** The real CLIs of the e2e suites (`needs` in suites.mjs) and the provider each one is, by its id. */
export const CLI_PROVIDERS = REAL_CLIS

/** The manifest's file, relative to the repository. */
export const MANIFEST = 'resources/tested-clis.json'

/**
 * The manifest with what a run record shows (`current` kept for a CLI it can't vouch for): a CLI's entry is replaced
 * only when the record is valid, every real suite of that CLI ran and passed (none failed or skipped), and every one
 * of them says which of that CLI its Combwork selected (the record's per-suite `clis`, from Combwork's own detection), all the
 * same version. A suite marked `noCombwork` in suites.mjs runs the CLI without Combwork, so it names none: it must pass, and
 * isn't asked which. `updated` lists the provider ids replaced; `problems` says why each other one wasn't.
 */
export function manifestFromRecord(record, suites, current = {}) {
  return manifestFromRecords([record], suites, current)
}

/**
 * What one record shows of one CLI (`need`, a key of CLI_PROVIDERS): its version when every real suite of it ran and
 * passed, each naming the same version (noCombwork suites only passing), or why not, and whether any of them ran at all.
 */
function cliInRecord(record, suites, need) {
  const { id, name } = CLI_PROVIDERS[need]
  const real = suites.filter((s) => (s.needs ?? []).includes(need)).map((s) => s.name)
  const noCombwork = new Set(suites.filter((s) => s.noCombwork).map((s) => s.name))
  const result = (n) => record.results.find((r) => r.name === n)
  const missing = real.filter((n) => !result(n))
  const notPassed = real.filter((n) => result(n) && (!result(n).ok || result(n).skipped))
  // What each suite's Combwork selected of this CLI.
  const versionsOf = (n) => [...new Set((result(n)?.clis ?? []).filter((c) => c?.provider === id && typeof c.version === 'string').map((c) => c.version))]
  const unsaid = real.filter((n) => !noCombwork.has(n) && result(n) && !versionsOf(n).length)
  // Every version its suites' Combwork selected, whatever they did (#1105 round 1: a partial or failed record's version
  // still counts against another record's).
  const versions = [...new Set(real.flatMap(versionsOf))].sort()
  const ran = missing.length < real.length
  if (!ran) return { ran, versions, problem: `${name}: none of its real suites ran` }
  if (missing.length) return { ran, versions, problem: `${name}: not all of its real suites ran (${missing.join(', ')} didn't)` }
  if (notPassed.length) return { ran, versions, problem: `${name}: not all of its real suites passed (${notPassed.join(', ')})` }
  if (unsaid.length) return { ran, versions, problem: `${name}: the record doesn't say which version Combwork used in ${unsaid.join(', ')}` }
  if (!versions.length) return { ran, versions, problem: `${name}: none of its real suites says which version Combwork used` }
  if (versions.length > 1) return { ran, versions, problem: `${name}: its real suites ran different versions (${versions.join(', ')})` }
  return { ran, versions, version: versions[0] }
}

/**
 * manifestFromRecord over several run records of the same commit (#1105: the real tier rerun per CLI, as for 0.9.2,
 * when Codex's suites can't share the machine with Claude Code's): every record must be a valid run record, all of one
 * commit. Each CLI's entry comes from the records in which all its real suites ran and passed (never suites pooled
 * across records); any two versions of it among all the records' suites, passed or not, are refused. A CLI no record
 * vouches for keeps its earlier entry, with the reason from a record where its suites ran (or "none of its real suites
 * ran").
 */
export function manifestFromRecords(records, suites, current = {}) {
  const manifest = { ...current }
  const updated = []
  const problems = []
  const many = records.length > 1
  const which = (i) => (many ? `record ${i + 1}: ` : '')
  if (!records.length) return { manifest, updated, problems: ['no run record given'] }
  for (const [i, record] of records.entries()) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.results)) return { manifest, updated, problems: [`${which(i)}it isn't a run record (run-record.json)`] }
    if (!record.valid) return { manifest, updated, problems: [`${which(i)}the record isn't valid: ${(record.problems ?? []).join('; ') || 'it says so'}`] }
  }
  const codes = [...new Set(records.map((r) => r.code))]
  if (codes.length > 1) return { manifest, updated, problems: [`the records are of different code (${codes.join(', ')}): give records of one commit`] }
  for (const [need, { id, name }] of Object.entries(CLI_PROVIDERS)) {
    const seen = records.map((record) => ({ record, ...cliInRecord(record, suites, need) }))
    const vouched = seen.filter((s) => s.version)
    // Every version any record's suites ran, passed or not: one record vouching can't hide another's other version.
    const versions = [...new Set(seen.flatMap((s) => s.versions))].sort()
    const showing = seen.filter((s) => s.versions.length)
    if (versions.length > 1) problems.push(showing.length === 1 ? showing[0].problem : `${name}: the records ran different versions (${versions.join(', ')})`)
    else if (!vouched.length) problems.push((seen.find((s) => s.ran) ?? seen[0]).problem)
    else {
      const when = vouched.map((s) => String(s.record.when ?? '')).sort().at(-1)
      manifest[id] = { version: versions[0], testedAt: when.slice(0, 10), record: codes[0] }
      updated.push(id)
    }
  }
  return { manifest, updated, problems }
}

/**
 * Why the manifest isn't of the code being released, or null: each entry must come from a record of a commit (not of
 * uncommitted changes) that differs from HEAD in nothing but the manifest itself. `changedSince(commit)` lists the
 * files changed from that commit to HEAD, or null when git doesn't know the commit.
 */
export function manifestStale(manifest, changedSince) {
  const entries = Object.entries(CLI_PROVIDERS).map(([, p]) => [p, manifest?.[p.id]])
  const missing = entries.filter(([, e]) => !e?.version).map(([p]) => p.name)
  if (missing.length) return `it has no tested version for ${missing.join(' and ')}`
  for (const [p, e] of entries) {
    if (!/^[0-9a-f]{7,40}$/.test(String(e.record ?? ''))) return `${p.name}'s entry comes from a run on uncommitted changes (${e.record})`
    const changed = changedSince(e.record)
    if (!changed) return `${p.name}'s entry comes from a commit git doesn't know (${e.record})`
    const other = changed.filter((f) => f !== MANIFEST)
    if (other.length) return `${p.name}'s entry was tested on ${e.record}, and ${other.length} file${other.length === 1 ? ' has' : 's have'} changed since (${other.slice(0, 3).join(', ')}${other.length > 3 ? ', …' : ''})`
  }
  return null
}
