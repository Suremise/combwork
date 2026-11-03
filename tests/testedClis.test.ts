// The CLI versions a Hive release was tested with (#365): read from the real tier's run record (never typed by hand),
// written into resources/tested-clis.json by `npm run tested-clis`, checked by `npm run release`, and compared with the
// installed version for Provider Setup, Copy Diagnostics and the Agent API.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, win32 } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { CLI_PROVIDERS, MANIFEST, manifestFromRecord, manifestFromRecords, manifestStale } from '../scripts/testedClis.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { readCliLog, realCliHomes, realCliVersions, recordJson, recordMarkdown } from './e2e/record.mjs'
import { compareTested, noteSelectedCli } from '../src/main/testedClis'
import { compareVersions } from '../src/main/providers/common'
import { PROVIDERS } from '../src/shared/providers'
import { testedComparison, testedNote, testedSummary } from '../src/shared/testedClis'
import { tempDir } from './tempDir'

type Suite = { name: string; needs?: string[]; noHive?: string }
type Cli = { provider: string; version: string; path: string | null; home?: string }
const suites = SUITES as Suite[]
const real = (need: string) => suites.filter((s) => s.needs?.includes(need)).map((s) => s.name)
/** Those that need this CLI alone (HI-1742: one needing two, such as cliquit, is a run of both). */
const alone = (need: string) => suites.filter((s) => s.needs?.length === 1 && s.needs[0] === need).map((s) => s.name)
/** Those of them that start a test Hive, which says which version it selected (not noHive). */
const hived = (need: string) => suites.filter((s) => s.needs?.includes(need) && !s.noHive).map((s) => s.name)
const CLAUDE: Cli = { provider: 'claude-code', version: '2.1.292', path: 'C:\\Users\\t\\.local\\bin\\claude.exe' }
const CODEX: Cli = { provider: 'codex', version: '0.160.1', path: 'C:\\Users\\t\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' }
/** A passed suite whose test copies of Hive selected these CLIs (both, as Hive looks for both). */
const pass = (name: string, clis: Cli[] = []) => ({ name, ok: true, seconds: 3, clis })
const COPILOT: Cli = { provider: 'copilot', version: '1.0.93', path: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe' }
/** Each real suite once (#1521: reviewcopiesreal needs all three), its Hive having selected every CLI it needs. */
const realResults = () => [pass('about'), ...suites.filter((s) => s.needs?.length).map((s) => pass(s.name, s.needs!.includes('copilot') ? [CLAUDE, CODEX, COPILOT] : [CLAUDE, CODEX]))]
/** A run record of the whole real tier (and one fake suite), every suite passed, as run.mjs writes it. */
const fullRecord = (over: Record<string, unknown> = {}) => {
  const results = realResults()
  return { ...recordJson({ code: '0123456789ab', when: '2026-10-07 14:32', results, clis: realCliVersions(results, suites) }), ...over }
}
type Result = ReturnType<typeof realResults>[number]

describe('the run record says which real CLIs ran, as Hive selected them (#365)', () => {
  it("reads the suite's log of what its Hive selected, once each, skipping lines it can't read", () => {
    const log = [JSON.stringify(CLAUDE), JSON.stringify(CODEX), JSON.stringify(CLAUDE), '{"provider":"codex"', JSON.stringify({ provider: 'codex' }), ''].join('\n')
    expect(readCliLog(log)).toEqual([CLAUDE, CODEX])
    expect(readCliLog('')).toEqual([])
  })

  it("takes each real CLI's versions from its own real suites only, and names them in the records", () => {
    // A Codex suite's Hive also finds Claude Code: that isn't a run of Claude Code's suites.
    const results = [pass('about', [{ ...CLAUDE, version: '9.9.9' }]), pass(alone('claude')[0], [CLAUDE]), pass(alone('codex')[0], [{ ...CLAUDE, version: '2.1.1' }, CODEX])]
    expect(realCliVersions(results, suites)).toEqual({ claude: ['2.1.292'], codex: ['0.160.1'] })
    // A suite needing both (cliquit) is a run of each: its Claude Code counts.
    const both = suites.find((s) => s.needs?.includes('claude') && s.needs.includes('codex'))!.name
    expect(realCliVersions([...results, pass(both, [{ ...CLAUDE, version: '2.1.1' }, CODEX])], suites)).toEqual({ claude: ['2.1.1', '2.1.292'], codex: ['0.160.1'] })
    const clis = { claude: ['2.1.292'], codex: ['0.160.1', '0.161.0'] }
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '3 passed', clis })
    expect(md).toContain('Real CLIs (as Hive selected them): Claude Code 2.1.292, Codex 0.160.1 and 0.161.0.')
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [pass('about')], logDir: 'x', summary: '1 passed' })).not.toContain('Real CLIs')
    const json = recordJson({ code: 'abc', when: 'now', results: [pass('a', [CLAUDE]), { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true }], problems: ['code changed'], clis: { claude: ['2.1.292'] } })
    expect(json).toEqual({ code: 'abc', when: 'now', valid: false, problems: ['code changed'], clis: { claude: ['2.1.292'] }, results: [{ name: 'a', ok: true, skipped: null, environment: false, clis: [CLAUDE] }, { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true, clis: [] }], notRun: [] })
  })
})

describe("the run record names each real suite's CLI home, and none may be the user's own (#368)", () => {
  const profile = join('C:', 'Users', 't')
  it("lists the home of each real suite's own CLI, not the other CLI its Hive found", () => {
    const own = join(profile, 'AppData', 'Local', 'hive-test', 'e2e', 'lanes', '0', 'mode', 'mode-claude-home')
    const codexHome = join(profile, 'AppData', 'Local', 'hive-test', 'codex')
    const claudeSuite = alone('claude')[0]
    const codexSuite = alone('codex')[0]
    const results = [pass('about', [{ ...CLAUDE, home: join(profile, '.claude') }] as Cli[]), pass(claudeSuite, [{ ...CLAUDE, home: own }, { ...CODEX, home: join(profile, '.codex') }] as Cli[]), pass(codexSuite, [{ ...CODEX, home: codexHome }] as Cli[])]
    const { homes, own: inUsers } = realCliHomes(results, suites, profile)
    expect(homes).toEqual([`${claudeSuite}: Claude Code in ${own}`, `${codexSuite}: Codex in ${codexHome}`])
    // The fake suite's Hive and the Claude suite's Codex check aren't runs of those CLIs.
    expect(inUsers).toEqual([])
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '3 passed', homes })).toContain(`Real CLIs' homes (#368): ${claudeSuite}: Claude Code in ${own}; ${codexSuite}: Codex in ${codexHome}.`)
  })

  it("flags a real suite that ran its CLI in the user's own home", () => {
    const results = [pass(alone('claude')[0], [{ ...CLAUDE, home: `${join(profile, '.claude')}/` }] as Cli[]), pass(alone('codex')[0], [{ ...CODEX, home: join(profile, '.CODEX') }] as Cli[])]
    expect(realCliHomes(results, suites, profile).own).toEqual([alone('claude')[0], alone('codex')[0]])
    // Copilot's offline suite too: its home must be the suite's own, never ~/.copilot.
    expect(realCliHomes([pass(alone('copilot')[0], [{ ...COPILOT, home: join(profile, '.copilot') }] as Cli[])], suites, profile).own).toEqual([alone('copilot')[0]])
  })

  it('knows the user\'s homes however the path is spelled: either slash, mixed, dot segments (#368 round 1)', () => {
    const p = win32.join('C:', 'Users', 'Example')
    const claudeSuite = alone('claude')[0]
    const codexSuite = alone('codex')[0]
    const flagged = (claudeHome: string, codexHome: string) =>
      realCliHomes([pass(claudeSuite, [{ ...CLAUDE, home: claudeHome }] as Cli[]), pass(codexSuite, [{ ...CODEX, home: codexHome }] as Cli[])], suites, p).own
    expect(flagged('C:/Users/Example/.claude', 'C:/Users/Example/.codex/')).toEqual([claudeSuite, codexSuite])
    expect(flagged('C:/Users\\Example/.Claude', 'c:\\users/example\\.codex')).toEqual([claudeSuite, codexSuite])
    expect(flagged('C:\\Users\\Example\\test\\..\\.claude', 'C:/Users/Example/./x/../.codex')).toEqual([claudeSuite, codexSuite])
    // Near misses are other folders: a test home beside it, or a folder inside it.
    expect(flagged('C:\\Users\\Example\\.claude-test', 'C:\\Users\\Example\\.codex\\homes\\x')).toEqual([])
  })
})

describe('npm run tested-clis: the manifest from a run record (#365)', () => {
  it('takes each CLI whose real suites all ran and passed, with the version their Hive selected', () => {
    const { manifest, updated, problems } = manifestFromRecord(fullRecord(), suites)
    expect(problems).toEqual([])
    expect(updated).toEqual(['claude-code', 'codex', 'copilot'])
    expect(manifest).toEqual({ 'claude-code': { version: '2.1.292', testedAt: '2026-10-07', record: '0123456789ab' }, codex: { version: '0.160.1', testedAt: '2026-10-07', record: '0123456789ab' }, copilot: { version: '1.0.93', testedAt: '2026-10-07', record: '0123456789ab' } })
  })

  it("never vouches for a CLI the record doesn't show working, and keeps its earlier entry", () => {
    const current = { codex: { version: '0.159.0', testedAt: '2026-09-01', record: 'fedcba987654' } }
    const changed = (name: string, change: (r: Result) => object) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? change(r) : r)) })
    // A real suite skipped for the environment, or failed: no result for that CLI.
    let out = manifestFromRecord(changed(alone('codex')[0], (r) => ({ ...r, skipped: 'environment: usage limit', environment: true })), suites, current)
    expect(out.updated).toEqual(['claude-code', 'copilot'])
    expect(out.manifest.codex).toEqual(current.codex)
    expect(out.problems).toEqual([`Codex: not all of its real suites passed (${alone('codex')[0]})`])
    expect(manifestFromRecord(changed(alone('claude')[0], (r) => ({ ...r, ok: false })), suites).problems).toEqual([`Claude Code: not all of its real suites passed (${alone('claude')[0]})`])
    // Only some of its suites ran (an --affected run), or none (the fake tier).
    const some = fullRecord({ results: fullRecord().results.filter((r: Result) => r.name !== alone('claude')[0]) })
    expect(manifestFromRecord(some, suites).problems).toEqual([`Claude Code: not all of its real suites ran (${alone('claude')[0]} didn't)`])
    out = manifestFromRecord(fullRecord({ results: [pass('about')] }), suites, current)
    expect(out.updated).toEqual([])
    expect(out.manifest).toEqual(current)
    expect(out.problems).toEqual(['Claude Code: none of its real suites ran', 'Codex: none of its real suites ran', 'GitHub Copilot: none of its real suites ran'])
  })

  it('takes the version only from what every suite of the CLI ran: none unsaid, all the same', () => {
    const changed = (name: string, clis: Cli[]) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? { ...r, clis } : r)) })
    // A suite whose Hive didn't say (an older runner, or it never looked), or said only the other CLI.
    expect(manifestFromRecord(changed(hived('codex')[1], []), suites).problems).toEqual([`Codex: the record doesn't say which version Hive used in ${hived('codex')[1]}`])
    expect(manifestFromRecord(changed(hived('claude')[0], [CODEX]), suites).problems).toEqual([`Claude Code: the record doesn't say which version Hive used in ${hived('claude')[0]}`])
    // One suite ran another version (updated mid-run, or another copy): refused, not one of them picked.
    expect(manifestFromRecord(changed(hived('codex')[2], [CLAUDE, { ...CODEX, version: '0.161.0' }]), suites).problems).toEqual(['Codex: its real suites ran different versions (0.160.1, 0.161.0)'])
    // The record's top-level summary is never the source: only what each suite's Hive selected.
    expect(manifestFromRecord(fullRecord({ clis: { claude: ['1.0.0'], codex: ['0.1.0'] } }), suites).manifest.codex.version).toBe('0.160.1')
  })

  it("doesn't ask a suite that runs its CLI without Hive (noHive) which version, but it must still pass (#921)", () => {
    const own = [...suites, { name: 'codex-nohive', needs: ['codex'], noHive: 'runs codex itself' }]
    const record = (r: object) => fullRecord({ results: [...fullRecord().results.filter((x: Result) => x.name !== 'codex-nohive'), { ...pass('codex-nohive'), ...r }] })
    expect(manifestFromRecord(record({}), own).problems).toEqual([])
    expect(manifestFromRecord(record({}), own).manifest.codex.version).toBe('0.160.1')
    expect(manifestFromRecord(record({ ok: false }), own).problems).toEqual(['Codex: not all of its real suites passed (codex-nohive)'])
    // One that does name a version is held to it.
    expect(manifestFromRecord(record({ clis: [{ ...CODEX, version: '0.161.0' }] }), own).problems).toEqual(['Codex: its real suites ran different versions (0.160.1, 0.161.0)'])
    // A CLI whose only suites start no Hive: nothing says its version.
    const only = [{ name: 'codex-nohive', needs: ['codex'], noHive: 'runs codex itself' }]
    expect(manifestFromRecord(fullRecord({ results: [pass('codex-nohive')] }), only).problems).toEqual(['Claude Code: none of its real suites ran', 'Codex: none of its real suites says which version Hive used', 'GitHub Copilot: none of its real suites ran'])
    // Every suite marked so says why, and is a real suite.
    for (const s of suites.filter((x) => x.noHive)) expect(s.needs?.some((n) => n !== 'packaged'), s.name).toBe(true)
  })

  it('refuses a record that is not valid, or not a record', () => {
    expect(manifestFromRecord(fullRecord({ valid: false, problems: ['the code changed while the suites ran'] }), suites)).toEqual({ manifest: {}, updated: [], problems: ["the record isn't valid: the code changed while the suites ran"] })
    expect(manifestFromRecord({ hello: 1 }, suites).problems).toEqual(["it isn't a run record (run-record.json)"])
  })

  // #1105: for 0.9.2 the real tier ran per CLI (Codex's suites can't share the machine with a Store PowerShell 7, #585)
  // and the three same-commit records were merged by hand.
  describe('several records of the same commit, one per CLI (#1105)', () => {
    const only = (need: string, over: Record<string, unknown> = {}) => fullRecord({ results: [pass('about'), ...realResults().filter((r: Result) => real(need).includes(r.name))], ...over })
    // A suite needing several CLIs (#1521: reviewcopiesreal) runs in each of their records: `solo` leaves those out, for a
    // record in which no other CLI's suite ran.
    const solo = (need: string, over: Record<string, unknown> = {}) => fullRecord({ results: [pass('about'), ...realResults().filter((r: Result) => real(need).includes(r.name) && suites.find((s) => s.name === r.name)!.needs!.length === 1)], ...over })
    /** Why `need` isn't vouched by a record of `ran`'s suites, which ran some of its suites. */
    const notAllRan = (name: string, need: string, ran: string) => `${name}: not all of its real suites ran (${real(need).filter((n) => !real(ran).includes(n)).join(', ')} didn't)`
    it("takes each CLI from the record where all its real suites ran and passed", () => {
      const { manifest, updated, problems } = manifestFromRecords([only('codex', { when: '2026-10-19 10:00' }), only('claude', { when: '2026-10-19 12:00' }), only('copilot')], suites)
      expect(problems).toEqual([])
      expect(updated).toEqual(['claude-code', 'codex', 'copilot'])
      expect(manifest['claude-code']).toEqual({ version: '2.1.292', testedAt: '2026-10-19', record: '0123456789ab' })
      expect(manifest.codex.version).toBe('0.160.1')
      // A CLI two records both cover, at one version: taken, dated by the later run.
      expect(manifestFromRecords([only('codex', { when: '2026-10-18 09:00' }), fullRecord({ when: '2026-10-20 09:00' })], suites).manifest.codex.testedAt).toBe('2026-10-20')
    })
    it('refuses records of different commits, an invalid one, or one that isn\'t a record, saying which', () => {
      const current = { codex: { version: '0.159.0', testedAt: '2026-09-01', record: 'fedcba987654' } }
      const other = manifestFromRecords([only('codex'), only('claude', { code: 'fedcba987654' })], suites, current)
      expect(other).toEqual({ manifest: current, updated: [], problems: ['the records are of different code (0123456789ab, fedcba987654): give records of one commit'] })
      expect(manifestFromRecords([only('codex'), only('claude', { valid: false, problems: ['the code changed while the suites ran'] })], suites).problems).toEqual(["record 2: the record isn't valid: the code changed while the suites ran"])
      expect(manifestFromRecords([only('codex'), { hello: 1 }], suites).problems).toEqual(["record 2: it isn't a run record (run-record.json)"])
      expect(manifestFromRecords([], suites).problems).toEqual(['no run record given'])
    })
    it("fails a CLI no record vouches for, with the reason from a record where its suites ran", () => {
      const out = manifestFromRecords([only('codex'), only('claude')], suites)
      expect(out.updated).toEqual(['claude-code', 'codex'])
      // Its suites that also need Codex ran in the first record, the others nowhere.
      expect(out.problems).toEqual([notAllRan('GitHub Copilot', 'copilot', 'codex')])
      expect(manifestFromRecords([solo('codex'), solo('claude')], suites).problems).toContain('GitHub Copilot: none of its real suites ran')
      const failed = only('copilot', { results: only('copilot').results.map((r: Result) => (r.name === alone('copilot')[0] ? { ...r, ok: false } : r)) })
      // Each reason is the first record's where that CLI's suites ran: the failed one for Copilot (and for Claude Code,
      // whose shared suites ran there too).
      expect(manifestFromRecords([failed, only('codex')], suites).problems).toEqual([notAllRan('Claude Code', 'claude', 'copilot'), `GitHub Copilot: not all of its real suites passed (${alone('copilot')[0]})`])
    })
    it('refuses a CLI two records ran at different versions', () => {
      const newer = only('codex', { results: only('codex').results.map((r: Result) => ({ ...r, clis: r.clis.map((c: Cli) => (c.provider === 'codex' ? { ...c, version: '0.161.0' } : c)) })) })
      const out = manifestFromRecords([only('codex'), newer, only('claude')], suites)
      expect(out.problems).toContain('Codex: the records ran different versions (0.160.1, 0.161.0)')
      expect(out.updated).not.toContain('codex')
    })
    // Round 1: a record that doesn't vouch (partial, failed or mixed) still shows which version its suites ran.
    it('refuses a CLI when a partial, failed or mixed record ran another version beside a full pass', () => {
      const at = (r: Result, v: string) => ({ ...r, clis: r.clis.map((c: Cli) => (c.provider === 'codex' ? { ...c, version: v } : c)) })
      const codexRuns = only('codex').results.filter((r: Result) => real('codex').includes(r.name))
      const conflicted = (b: object) => manifestFromRecords([only('codex'), only('claude'), b], suites)
      // Partial: one Codex suite, at 0.161.0, the others not run.
      const partial = fullRecord({ results: [pass('about'), at(codexRuns[0], '0.161.0')] })
      expect(conflicted(partial).problems).toEqual(['Codex: the records ran different versions (0.160.1, 0.161.0)', notAllRan('GitHub Copilot', 'copilot', 'codex')])
      expect(conflicted(partial).updated).toEqual(['claude-code'])
      // Failed: every Codex suite ran at 0.161.0, one failed.
      const failed = fullRecord({ results: [pass('about'), ...codexRuns.map((r: Result, i: number) => ({ ...at(r, '0.161.0'), ok: i !== 0 }))] })
      expect(conflicted(failed).problems).toContain('Codex: the records ran different versions (0.160.1, 0.161.0)')
      // Mixed within itself: one suite at 0.161.0, the rest at 0.160.1.
      const mixed = fullRecord({ results: [pass('about'), ...codexRuns.map((r: Result, i: number) => (i === 0 ? at(r, '0.161.0') : r))] })
      expect(conflicted(mixed).problems).toContain('Codex: the records ran different versions (0.160.1, 0.161.0)')
      // A partial record at the same version doesn't stop it, and its suites aren't pooled into a pass.
      expect(conflicted(fullRecord({ results: [pass('about'), codexRuns[0]] })).updated).toContain('codex')
      expect(manifestFromRecords([fullRecord({ results: [pass('about'), codexRuns[0]] }), fullRecord({ results: [pass('about'), ...codexRuns.slice(1)] })], suites).updated).not.toContain('codex')
      // A CLI in no record still fails, its older entry kept.
      const current = { copilot: { version: '1.0.90', testedAt: '2026-10-01', record: 'fedcba987654' } }
      const out = manifestFromRecords([solo('codex'), solo('claude')], suites, current)
      expect(out.problems).toContain('GitHub Copilot: none of its real suites ran')
      expect(out.manifest.copilot).toEqual(current.copilot)
    })
  })

  it('maps each real CLI of the suites to a provider Hive has', () => {
    const needs = new Set(suites.flatMap((s) => s.needs ?? []).filter((n) => n !== 'packaged'))
    expect([...needs].sort()).toEqual(Object.keys(CLI_PROVIDERS).sort())
    for (const p of Object.values(CLI_PROVIDERS) as { id: string; name: string }[]) expect(PROVIDERS.find((x) => x.id === p.id)?.name).toBe(p.name)
  })
})

describe('npm run release: the manifest must be of the code released (#365)', () => {
  const manifest = manifestFromRecord(fullRecord(), suites).manifest
  it('takes one tested on HEAD, or on the commit before with only the manifest changed since', () => {
    expect(manifestStale(manifest, () => [])).toBeNull()
    expect(manifestStale(manifest, () => [MANIFEST])).toBeNull()
  })
  it('refuses one that is missing a CLI, comes from uncommitted changes, an unknown commit, or older code', () => {
    expect(manifestStale(null, () => [])).toBe('it has no tested version for Claude Code and Codex and GitHub Copilot')
    expect(manifestStale({ 'claude-code': manifest['claude-code'], copilot: manifest.copilot }, () => [])).toBe('it has no tested version for Codex')
    expect(manifestStale({ ...manifest, codex: { ...manifest.codex, record: '0123456789ab+fedcba987654' } }, () => [])).toBe("Codex's entry comes from a run on uncommitted changes (0123456789ab+fedcba987654)")
    expect(manifestStale(manifest, () => null)).toBe("Claude Code's entry comes from a commit git doesn't know (0123456789ab)")
    expect(manifestStale(manifest, () => [MANIFEST, 'src/main/sessions.ts', 'package.json'])).toBe("Claude Code's entry was tested on 0123456789ab, and 2 files have changed since (src/main/sessions.ts, package.json)")
  })
})

describe('the shipped manifest (#365)', () => {
  // Between releases it may lack a provider (Claude Code's real tier runs in the default home until #368, so its entry
  // is written by the release's run); npm run release refuses it until every provider has one (manifestStale).
  it("names only Hive's providers, each entry as npm run tested-clis writes it from a run record of the real tier", () => {
    const shipped = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    expect(Object.keys(shipped).length).toBeGreaterThan(0)
    for (const id of Object.keys(shipped)) expect(PROVIDERS.map((p) => p.id), id).toContain(id)
    for (const p of PROVIDERS.filter((x) => shipped[x.id])) {
      const e = shipped[p.id]
      expect(e.version, p.id).toMatch(/^\d+\.\d+\.\d+/)
      expect(e.testedAt, p.id).toMatch(/^\d{4}-\d\d-\d\d$/)
      // The record's code: written by npm run tested-clis from a run record, never typed.
      expect(e.record, p.id).toMatch(/^[0-9a-f]{12}(\+[0-9a-f]{12})?$/)
    }
  })
})

describe('the installed version against the tested one (#365)', () => {
  const isNewer = (a: string, b: string) => compareVersions(a, b) > 0
  const tested = { version: '2.1.287', testedAt: '2026-10-07' }
  it('compares by the provider\'s version order', () => {
    expect(compareTested(tested, '2.1.287', isNewer).installed).toBe('same')
    expect(compareTested(tested, '2.1.290', isNewer).installed).toBe('newer')
    expect(compareTested(tested, '2.1.30', isNewer).installed).toBe('older')
    expect(compareTested(tested, '2.10.0', isNewer).installed).toBe('newer')
    expect(compareTested(tested, null, isNewer)).toEqual({ ...tested, installed: 'unknown' })
  })
  it('says it calmly: a tick for the same, a note for newer, older or unknown', () => {
    const t = (installed: 'same' | 'newer' | 'older' | 'unknown') => ({ ...tested, installed })
    expect(testedSummary(t('newer'), '2.1.290')).toBe('Tested with 2.1.287 · installed 2.1.290')
    expect(testedSummary(t('unknown'), null)).toBe('Tested with 2.1.287 · installed version unknown')
    expect(testedNote(t('same'))).toBeNull()
    expect(testedNote(t('newer'))).toBe('This version came out after this Combwork release was tested. Most updates work; if something behaves oddly, report it (Copy Diagnostics).')
    expect(testedNote(t('older'))).toBe('Older than tested; consider updating.')
    expect(testedNote(t('unknown'))).toMatch(/couldn't tell which version is installed/)
    expect(['same', 'newer', 'older', 'unknown'].map((k) => testedComparison(t(k as 'same')))).toEqual(['the tested version', 'newer than tested', 'older than tested', 'version unknown'])
  })
})

describe('the run record\'s versions are what Hive selected, not the first copy on PATH (#365)', () => {
  const dir = tempDir('hive-tested-clis-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  /** Puts an environment variable back as it was. */
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  /** A stand-in CLI that says this version for any arguments. */
  const fake = (folder: string, version: string) => {
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'claude.cmd')
    writeFileSync(file, `@echo ${version} (Claude Code)\r\n`)
    return file
  }

  it("an editor extension's copy first on PATH, at another version: Hive selects the standalone CLI, and notes that one", async () => {
    const extension = fake(join(dir, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9', 'resources'), '9.9.9')
    const standalone = fake(join(dir, 'standalone'), '2.1.292')
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    // Its PATH candidates in where.exe's order: the extension's copy first.
    const adapter = claudeCode as unknown as { candidates: () => Promise<{ path: string; source: string }[]> }
    const before = adapter.candidates
    adapter.candidates = async () => [{ path: extension, source: 'PATH' }, { path: standalone, source: 'PATH' }]
    try {
      const info = await claudeCode.locate()
      expect({ path: info.path, version: info.version, rejected: info.rejected }).toEqual({ path: standalone, version: '2.1.292', rejected: [extension] })
      // A test copy of Hive notes what it selected for the run record.
      const log = join(dir, 'hive-clis.jsonl')
      const env = { user: process.env.HIVE_USER_DATA, log: process.env.HIVE_TEST_CLI_LOG }
      process.env.HIVE_USER_DATA = join(dir, 'profile')
      process.env.HIVE_TEST_CLI_LOG = log
      // With the home the adapter says its sessions get (#368): CLAUDE_CONFIG_DIR, here a test home.
      const configDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-home')
      try {
        await noteSelectedCli(info, claudeCode.configHome?.() ?? null)
      } finally {
        restore('HIVE_USER_DATA', env.user)
        restore('HIVE_TEST_CLI_LOG', env.log)
        restore('CLAUDE_CONFIG_DIR', configDir)
      }
      expect(readCliLog(readFileSync(log, 'utf8'))).toEqual([{ provider: 'claude-code', version: '2.1.292', path: standalone, home: join(dir, 'claude-home') }])
    } finally {
      adapter.candidates = before
    }
  })

  it('notes nothing outside a test copy, or for a CLI not found', async () => {
    const log = join(dir, 'none.jsonl')
    const info = { provider: 'claude-code', found: true, path: 'x', version: '1.0.0' } as never
    const was = process.env.HIVE_TEST_CLI_LOG
    process.env.HIVE_TEST_CLI_LOG = log
    const user = process.env.HIVE_USER_DATA
    delete process.env.HIVE_USER_DATA
    try {
      await noteSelectedCli(info)
      process.env.HIVE_USER_DATA = join(dir, 'profile')
      await noteSelectedCli({ provider: 'claude-code', found: false, path: null, version: null } as never)
    } finally {
      restore('HIVE_TEST_CLI_LOG', was)
      restore('HIVE_USER_DATA', user)
    }
    expect(() => readFileSync(log, 'utf8')).toThrow()
  })
})
