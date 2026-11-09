// The CLI versions a Combwork release was tested with (#365): read from the real tier's run record (never typed by hand),
// written into resources/tested-clis.json by `npm run tested-clis`, checked by `npm run release`, and compared with the
// installed version for Provider Setup, Copy Diagnostics and the Agent API.
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, win32 } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { CLI_PROVIDERS, gitReaders, MANIFEST, manifestCheck, manifestFromRecord, manifestFromRecords, manifestStale, testOnlyFiles, versionOnlyFiles } from '../scripts/testedClis.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { readCliLog, realCliHomes, realCliVersions, recordJson, recordMarkdown } from './e2e/record.mjs'
import { compareTested, noteSelectedCli } from '../src/main/testedClis'
import { compareVersions } from '../src/main/providers/common'
import { PROVIDERS } from '../src/shared/providers'
import { testedComparison, testedNote, testedSummary } from '../src/shared/testedClis'
import { tempDir } from './tempDir'
import { createRequire } from 'module'

type Suite = { name: string; needs?: string[]; noCombwork?: string }
type Cli = { provider: string; version: string; path: string | null; home?: string }
const suites = SUITES as Suite[]
const real = (need: string) => suites.filter((s) => s.needs?.includes(need)).map((s) => s.name)
/** Those that need this CLI alone (HI-1742: one needing two, such as cliquit, is a run of both). */
const alone = (need: string) => suites.filter((s) => s.needs?.length === 1 && s.needs[0] === need).map((s) => s.name)
/** Those of them that start a test Combwork, which says which version it selected (not noCombwork). */
const withCombwork = (need: string) => suites.filter((s) => s.needs?.includes(need) && !s.noCombwork).map((s) => s.name)
const CLAUDE: Cli = { provider: 'claude-code', version: '2.1.292', path: 'C:\\Users\\t\\.local\\bin\\claude.exe' }
const CODEX: Cli = { provider: 'codex', version: '0.160.1', path: 'C:\\Users\\t\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' }
/** A passed suite whose test copies of Combwork selected these CLIs (both, as Combwork looks for both). */
const pass = (name: string, clis: Cli[] = []) => ({ name, ok: true, seconds: 3, clis })
const COPILOT: Cli = { provider: 'copilot', version: '1.0.93', path: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe' }
/** Each real suite once (#1521: reviewcopiesreal needs all three), its Combwork having selected every CLI it needs. */
const AGY: Cli = { provider: 'antigravity', version: '1.5.0', path: 'C:\\Users\\t\\AppData\\Local\\agy\\bin\\agy.exe' }
const OPENCODE: Cli = { provider: 'opencode', version: '2.2.6', path: 'C:\\Users\\t\\AppData\\Local\\combwork-test\\opencode-2.2.6\\opencode.exe' }
const realResults = () => [pass('about'), ...suites.filter((s) => s.needs?.length).map((s) => pass(s.name, [CLAUDE, CODEX, ...(s.needs!.includes('copilot') ? [COPILOT] : []), ...(s.needs!.includes('agy') ? [AGY] : []), ...(s.needs!.includes('opencode') ? [OPENCODE] : [])]))]
/** A run record of the whole real tier (and one fake suite), every suite passed, as run.mjs writes it. */
const fullRecord = (over: Record<string, unknown> = {}) => {
  const results = realResults()
  return { ...recordJson({ code: '0123456789ab', when: '2026-10-07 14:32', results, clis: realCliVersions(results, suites) }), ...over }
}
type Result = ReturnType<typeof realResults>[number]

describe('the run record says which real CLIs ran, as Combwork selected them (#365)', () => {
  it("reads the suite's log of what its Combwork selected, once each, skipping lines it can't read", () => {
    const log = [JSON.stringify(CLAUDE), JSON.stringify(CODEX), JSON.stringify(CLAUDE), '{"provider":"codex"', JSON.stringify({ provider: 'codex' }), ''].join('\n')
    expect(readCliLog(log)).toEqual([CLAUDE, CODEX])
    expect(readCliLog('')).toEqual([])
  })

  it("takes each real CLI's versions from its own real suites only, and names them in the records", () => {
    // A Codex suite's Combwork also finds Claude Code: that isn't a run of Claude Code's suites.
    const results = [pass('about', [{ ...CLAUDE, version: '9.9.9' }]), pass(alone('claude')[0], [CLAUDE]), pass(alone('codex')[0], [{ ...CLAUDE, version: '2.1.1' }, CODEX])]
    expect(realCliVersions(results, suites)).toEqual({ claude: ['2.1.292'], codex: ['0.160.1'] })
    // A suite needing both (cliquit) is a run of each: its Claude Code counts.
    const both = suites.find((s) => s.needs?.includes('claude') && s.needs.includes('codex'))!.name
    expect(realCliVersions([...results, pass(both, [{ ...CLAUDE, version: '2.1.1' }, CODEX])], suites)).toEqual({ claude: ['2.1.1', '2.1.292'], codex: ['0.160.1'] })
    const clis = { claude: ['2.1.292'], codex: ['0.160.1', '0.161.0'] }
    const md = recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results, logDir: 'x', summary: '3 passed', clis })
    expect(md).toContain('Real CLIs (as Combwork selected them): Claude Code 2.1.292, Codex 0.160.1 and 0.161.0.')
    expect(recordMarkdown({ code: 'abc', when: 'now', jobs: 4, results: [pass('about')], logDir: 'x', summary: '1 passed' })).not.toContain('Real CLIs')
    const json = recordJson({ code: 'abc', when: 'now', results: [pass('a', [CLAUDE]), { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true }], problems: ['code changed'], clis: { claude: ['2.1.292'] } })
    expect(json).toEqual({ code: 'abc', when: 'now', valid: false, problems: ['code changed'], clis: { claude: ['2.1.292'] }, results: [{ name: 'a', ok: true, skipped: null, environment: false, clis: [CLAUDE] }, { name: 'b', ok: true, skipped: 'environment: usage limit', environment: true, clis: [] }], notRun: [] })
  })
})

describe("the run record names each real suite's CLI home, and none may be the user's own (#368)", () => {
  const profile = join('C:', 'Users', 't')
  it("lists the home of each real suite's own CLI, not the other CLI its Combwork found", () => {
    const own = join(profile, 'AppData', 'Local', 'combwork-test', 'e2e', 'lanes', '0', 'mode', 'mode-claude-home')
    const codexHome = join(profile, 'AppData', 'Local', 'combwork-test', 'codex')
    const claudeSuite = alone('claude')[0]
    const codexSuite = alone('codex')[0]
    const results = [pass('about', [{ ...CLAUDE, home: join(profile, '.claude') }] as Cli[]), pass(claudeSuite, [{ ...CLAUDE, home: own }, { ...CODEX, home: join(profile, '.codex') }] as Cli[]), pass(codexSuite, [{ ...CODEX, home: codexHome }] as Cli[])]
    const { homes, own: inUsers } = realCliHomes(results, suites, profile)
    expect(homes).toEqual([`${claudeSuite}: Claude Code in ${own}`, `${codexSuite}: Codex in ${codexHome}`])
    // The fake suite's Combwork and the Claude suite's Codex check aren't runs of those CLIs.
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
  it('takes each CLI whose real suites all ran and passed, with the version their Combwork selected', () => {
    const { manifest, updated, problems } = manifestFromRecord(fullRecord(), suites)
    expect(problems).toEqual([])
    expect(updated).toEqual(['claude-code', 'codex', 'copilot', 'antigravity', 'opencode'])
    expect(manifest).toEqual({ antigravity: { version: '1.5.0', testedAt: '2026-10-07', record: '0123456789ab' }, 'claude-code': { version: '2.1.292', testedAt: '2026-10-07', record: '0123456789ab' }, codex: { version: '0.160.1', testedAt: '2026-10-07', record: '0123456789ab' }, copilot: { version: '1.0.93', testedAt: '2026-10-07', record: '0123456789ab' }, opencode: { version: '2.2.6', testedAt: '2026-10-07', record: '0123456789ab' } })
  })

  it("never vouches for a CLI the record doesn't show working, and keeps its earlier entry", () => {
    const current = { codex: { version: '0.159.0', testedAt: '2026-09-01', record: 'fedcba987654' } }
    const changed = (name: string, change: (r: Result) => object) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? change(r) : r)) })
    // A real suite skipped for the environment, or failed: no result for that CLI.
    let out = manifestFromRecord(changed(alone('codex')[0], (r) => ({ ...r, skipped: 'environment: usage limit', environment: true })), suites, current)
    expect(out.updated).toEqual(['claude-code', 'copilot', 'antigravity', 'opencode'])
    expect(out.manifest.codex).toEqual(current.codex)
    expect(out.problems).toEqual([`Codex: not all of its real suites passed (${alone('codex')[0]})`])
    expect(manifestFromRecord(changed(alone('claude')[0], (r) => ({ ...r, ok: false })), suites).problems).toEqual([`Claude Code: not all of its real suites passed (${alone('claude')[0]})`])
    // Only some of its suites ran (an --affected run), or none (the fake tier).
    const some = fullRecord({ results: fullRecord().results.filter((r: Result) => r.name !== alone('claude')[0]) })
    expect(manifestFromRecord(some, suites).problems).toEqual([`Claude Code: not all of its real suites ran (${alone('claude')[0]} didn't)`])
    out = manifestFromRecord(fullRecord({ results: [pass('about')] }), suites, current)
    expect(out.updated).toEqual([])
    expect(out.manifest).toEqual(current)
    expect(out.problems).toEqual(['Claude Code: none of its real suites ran', 'Codex: none of its real suites ran', 'GitHub Copilot: none of its real suites ran', 'Antigravity: none of its real suites ran', 'OpenCode: none of its real suites ran'])
  })

  it('takes the version only from what every suite of the CLI ran: none unsaid, all the same', () => {
    const changed = (name: string, clis: Cli[]) => fullRecord({ results: fullRecord().results.map((r: Result) => (r.name === name ? { ...r, clis } : r)) })
    // A suite whose Combwork didn't say (an older runner, or it never looked), or said only the other CLI.
    expect(manifestFromRecord(changed(withCombwork('codex')[1], []), suites).problems).toEqual([`Codex: the record doesn't say which version Combwork used in ${withCombwork('codex')[1]}`])
    expect(manifestFromRecord(changed(withCombwork('claude')[0], [CODEX]), suites).problems).toEqual([`Claude Code: the record doesn't say which version Combwork used in ${withCombwork('claude')[0]}`])
    // One suite ran another version (updated mid-run, or another copy): refused, not one of them picked.
    expect(manifestFromRecord(changed(withCombwork('codex')[2], [CLAUDE, { ...CODEX, version: '0.161.0' }]), suites).problems).toEqual(['Codex: its real suites ran different versions (0.160.1, 0.161.0)'])
    // The record's top-level summary is never the source: only what each suite's Combwork selected.
    expect(manifestFromRecord(fullRecord({ clis: { claude: ['1.0.0'], codex: ['0.1.0'] } }), suites).manifest.codex.version).toBe('0.160.1')
  })

  it("doesn't ask a suite that runs its CLI without Combwork (noCombwork) which version, but it must still pass (#921)", () => {
    const own = [...suites, { name: 'codex-nocombwork', needs: ['codex'], noCombwork: 'runs codex itself' }]
    const record = (r: object) => fullRecord({ results: [...fullRecord().results.filter((x: Result) => x.name !== 'codex-nocombwork'), { ...pass('codex-nocombwork'), ...r }] })
    expect(manifestFromRecord(record({}), own).problems).toEqual([])
    expect(manifestFromRecord(record({}), own).manifest.codex.version).toBe('0.160.1')
    expect(manifestFromRecord(record({ ok: false }), own).problems).toEqual(['Codex: not all of its real suites passed (codex-nocombwork)'])
    // One that does name a version is held to it.
    expect(manifestFromRecord(record({ clis: [{ ...CODEX, version: '0.161.0' }] }), own).problems).toEqual(['Codex: its real suites ran different versions (0.160.1, 0.161.0)'])
    // A CLI whose only suites start no Combwork: nothing says its version.
    const only = [{ name: 'codex-nocombwork', needs: ['codex'], noCombwork: 'runs codex itself' }]
    expect(manifestFromRecord(fullRecord({ results: [pass('codex-nocombwork')] }), only).problems).toEqual(['Claude Code: none of its real suites ran', 'Codex: none of its real suites says which version Combwork used', 'GitHub Copilot: none of its real suites ran', 'Antigravity: none of its real suites ran', 'OpenCode: none of its real suites ran'])
    // Every suite marked so says why, and is a real suite.
    for (const s of suites.filter((x) => x.noCombwork)) expect(s.needs?.some((n) => n !== 'packaged'), s.name).toBe(true)
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
      const { manifest, updated, problems } = manifestFromRecords([only('codex', { when: '2026-10-19 10:00' }), only('claude', { when: '2026-10-19 12:00' }), only('copilot'), only('agy'), only('opencode')], suites)
      expect(problems).toEqual([])
      expect(updated).toEqual(['claude-code', 'codex', 'copilot', 'antigravity', 'opencode'])
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
      expect(out.problems).toEqual([notAllRan('GitHub Copilot', 'copilot', 'codex'), 'Antigravity: none of its real suites ran', 'OpenCode: none of its real suites ran'])
      expect(manifestFromRecords([solo('codex'), solo('claude')], suites).problems).toContain('GitHub Copilot: none of its real suites ran')
      const failed = only('copilot', { results: only('copilot').results.map((r: Result) => (r.name === alone('copilot')[0] ? { ...r, ok: false } : r)) })
      // Each reason is the first record's where that CLI's suites ran: the failed one for Copilot (and for Claude Code,
      // whose shared suites ran there too).
      expect(manifestFromRecords([failed, only('codex')], suites).problems).toEqual([notAllRan('Claude Code', 'claude', 'copilot'), `GitHub Copilot: not all of its real suites passed (${alone('copilot')[0]})`, 'Antigravity: none of its real suites ran', 'OpenCode: none of its real suites ran'])
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
      expect(conflicted(partial).problems).toEqual(['Codex: the records ran different versions (0.160.1, 0.161.0)', notAllRan('GitHub Copilot', 'copilot', 'codex'), 'Antigravity: none of its real suites ran', 'OpenCode: none of its real suites ran'])
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

  it('maps each real CLI of the suites to a provider Combwork has', () => {
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
    expect(manifestStale(null, () => [])).toBe('it has no tested version for Claude Code and Codex and GitHub Copilot and Antigravity and OpenCode')
    expect(manifestStale({ 'claude-code': manifest['claude-code'], copilot: manifest.copilot, antigravity: manifest.antigravity, opencode: manifest.opencode }, () => [])).toBe('it has no tested version for Codex')
    expect(manifestStale({ ...manifest, codex: { ...manifest.codex, record: '0123456789ab+fedcba987654' } }, () => [])).toBe("Codex's entry comes from a run on uncommitted changes (0123456789ab+fedcba987654)")
    expect(manifestStale(manifest, () => null)).toBe("Claude Code's entry comes from a commit git doesn't know (0123456789ab)")
    expect(manifestStale(manifest, () => [MANIFEST, 'src/main/sessions.ts', 'package.json'])).toBe("Claude Code's entry was tested on 0123456789ab, and 2 files have changed since (src/main/sessions.ts, package.json)")
  })
})

describe('npm run release: test-only changes since the record, let through on the record (HI-2661)', () => {
  const manifest = manifestFromRecord(fullRecord(), suites).manifest
  const REC = '0123456789ab'
  type S = { name: string; needs?: string[] }
  /** Readers over a made-up history: suites.mjs's list at each revision, and which paths name a needle there. */
  const readers = (at: Record<string, S[] | null>, names: Record<string, Record<string, string[]>> = {}) => ({
    suitesAt: async (rev: string) => (rev in at ? at[rev] : null),
    namesAt: async (rev: string, needle: string) => (rev in at ? (names[rev]?.[needle] ?? []) : null)
  })
  const LIST: S[] = [{ name: 'advanced' }, { name: 'mergequeuefolder' }, { name: 'claude-real', needs: ['claude'] }, { name: 'contract-copilot', needs: ['copilot'] }]
  const same = readers({ [REC]: LIST, HEAD: LIST })
  const check = (files: string[], r = same) => manifestCheck(manifest, () => [MANIFEST, ...files], r)

  it('lets through a unit test and a fake suite of the same list at both revisions, and lists them per provider', async () => {
    const out = await check(['tests/settingsWorkspace.test.ts', 'tests/workflow/focused.test.ts', 'tests/e2e/advanced.cjs', 'tests/e2e/mergequeuefolder.cjs'])
    expect(out.stale).toBeNull()
    const files = ['tests/settingsWorkspace.test.ts', 'tests/workflow/focused.test.ts', 'tests/e2e/advanced.cjs', 'tests/e2e/mergequeuefolder.cjs']
    expect(out.excluded).toEqual({ antigravity: { record: REC, files }, 'claude-code': { record: REC, files }, codex: { record: REC, files }, copilot: { record: REC, files }, opencode: { record: REC, files } })
    // The manifest alone changed: nothing to list.
    expect(await manifestCheck(manifest, () => [MANIFEST], same)).toEqual({ stale: null, excluded: {} })
  })

  it('keeps everything else stale: a real suite, the harness, a fixture or helper a suite reads, suites.mjs, scenarios, the app', async () => {
    for (const f of ['tests/e2e/claude-real.cjs', 'tests/e2e/contract-copilot.cjs', 'tests/e2e/lib.cjs', 'tests/e2e/fake-copilot-api.cjs', 'tests/fixtures/console/copilot.json', 'tests/e2e/suites.mjs', 'tests/scenarios/scenarios.cjs', 'tests/sandbox/checks.cjs', 'scripts/release.mjs', 'src/main/sessions.ts', 'package.json', 'tests/e2e/README.md']) {
      const out = await check(['tests/settingsWorkspace.test.ts', f])
      expect(out.stale, f).toBe(`Claude Code's entry was tested on ${REC}, and 1 file has changed since (${f})`)
      expect(out.excluded).toEqual({})
    }
  })

  it('a unit test or fake suite another test file names is stale: at the record, or at HEAD', async () => {
    const named = (rev: string) => readers({ [REC]: LIST, HEAD: LIST }, { [rev]: { 'shared.test.ts': ['tests/e2e/boardfold.cjs'], 'advanced.cjs': ['tests/e2e/other.cjs'] } })
    for (const rev of [REC, 'HEAD']) {
      expect((await check(['tests/shared.test.ts'], named(rev))).stale, rev).toContain('(tests/shared.test.ts)')
      expect((await check(['tests/e2e/advanced.cjs'], named(rev))).stale, rev).toContain('(tests/e2e/advanced.cjs)')
    }
    // Naming itself is no reference.
    const self = readers({ [REC]: LIST, HEAD: LIST }, { HEAD: { 'advanced.cjs': ['tests/e2e/advanced.cjs'] } })
    expect((await check(['tests/e2e/advanced.cjs'], self)).stale).toBeNull()
  })

  it('a suite must be fake at both revisions: real then, new now, deleted, or renamed is stale', async () => {
    const realThen = readers({ [REC]: [{ name: 'advanced', needs: ['codex'] }], HEAD: [{ name: 'advanced' }] })
    expect((await check(['tests/e2e/advanced.cjs'], realThen)).stale).toContain('(tests/e2e/advanced.cjs)')
    const newNow = readers({ [REC]: [], HEAD: [{ name: 'fresh' }] })
    expect((await check(['tests/e2e/fresh.cjs'], newNow)).stale).toContain('(tests/e2e/fresh.cjs)')
    const deleted = readers({ [REC]: [{ name: 'gone' }], HEAD: [] })
    expect((await check(['tests/e2e/gone.cjs'], deleted)).stale).toContain('(tests/e2e/gone.cjs)')
    // A rename (--no-renames: a delete and an add) changes suites.mjs too, and each side is a suite at one revision only.
    const renamed = readers({ [REC]: [{ name: 'old' }], HEAD: [{ name: 'new' }] })
    expect((await testOnlyFiles(['tests/e2e/old.cjs', 'tests/e2e/new.cjs', 'tests/e2e/suites.mjs'], REC, renamed)).exempt).toEqual([])
  })

  it("can't say, so stale: suites.mjs unreadable at either revision, a grep that fails, an unknown commit", async () => {
    for (const r of [readers({ [REC]: null, HEAD: LIST }), readers({ [REC]: LIST, HEAD: null }), readers({ HEAD: LIST })]) expect((await check(['tests/settingsWorkspace.test.ts'], r)).stale).toContain('(tests/settingsWorkspace.test.ts)')
    const grepFails = { suitesAt: async () => LIST, namesAt: async () => null }
    expect((await check(['tests/settingsWorkspace.test.ts'], grepFails)).stale).toContain('(tests/settingsWorkspace.test.ts)')
    // The refusals before it are manifestStale's, unchanged.
    expect((await manifestCheck(manifest, () => null, same)).stale).toBe(`Claude Code's entry comes from a commit git doesn't know (${REC})`)
    expect((await manifestCheck({ ...manifest, codex: { ...manifest.codex, record: '0123456789ab+fedcba987654' } }, () => [], same)).stale).toBe("Codex's entry comes from a run on uncommitted changes (0123456789ab+fedcba987654)")
    expect((await manifestCheck(null, () => [], same)).stale).toBe('it has no tested version for Claude Code and Codex and GitHub Copilot and Antigravity and OpenCode')
  })

  // Its git runs in the run context's environment (its allowlist, no repository-selection variables), with no global or
  // system git config: never the shell's GIT_DIR or the user's hooks, signing or identity (HR1's HI-2661 round 1).
  const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
  const gitEnv = (): NodeJS.ProcessEnv => ({ ...baseEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  const isolatedSpawn = (cmd: string, args: string[], opts: object) => spawnSync(cmd, args, { ...opts, env: gitEnv() })

  it("the git readers: suites.mjs and names as they are at a revision; null for what git can't show", async () => {
    // A hostile shell around it, which must not reach its git: GIT_DIR naming a decoy repository, and a global config
    // that signs commits and runs a pre-commit hook that fails and leaves a mark.
    const hostile = tempDir('tested-clis-hostile-')
    const decoy = join(hostile, 'decoy')
    mkdirSync(decoy)
    execFileSync('git', ['init', '-q'], { cwd: decoy, env: gitEnv(), windowsHide: true })
    const hooks = join(hostile, 'hooks')
    mkdirSync(hooks)
    const mark = join(hostile, 'hook-ran')
    const slashes = (p: string) => p.replace(/\\/g, '/')
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho ran > "${slashes(mark)}"\nexit 1\n`)
    writeFileSync(join(hostile, 'gitconfig'), `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${slashes(hooks)}\n`)
    vi.stubEnv('GIT_DIR', join(decoy, '.git'))
    vi.stubEnv('GIT_WORK_TREE', decoy)
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(hostile, 'gitconfig'))
    try {
      await gitReadersCase()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(existsSync(mark)).toBe(false)
    expect(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: decoy, env: gitEnv(), windowsHide: true }).status).not.toBe(0)
  })

  async function gitReadersCase() {
    const repo = tempDir('tested-clis-git-')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: gitEnv() }).trim()
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    const put = (f: string, text: string) => {
      mkdirSync(join(repo, f, '..'), { recursive: true })
      writeFileSync(join(repo, f), text)
    }
    put('tests/e2e/suites.mjs', "export const SUITES = [{ name: 'advanced' }, { name: 'claude-real', needs: ['claude'] }]\n")
    put('tests/e2e/advanced.cjs', '// advanced\n')
    put('tests/e2e/claude-real.cjs', "require('./advanced.cjs')\n")
    put('tests/fixtures/x.json', '"shared.test.ts"\n')
    git('add', '-A')
    git('commit', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    // Then: claude-real no longer needs advanced; the suite list says so; a suite renamed.
    put('tests/e2e/claude-real.cjs', '// alone\n')
    put('tests/e2e/suites.mjs', "export const SUITES = [{ name: 'advanced' }, { name: 'renamed', needs: ['claude'] }]\n")
    git('add', '-A')
    git('commit', '-qm', 'two')
    const r = gitReaders(repo, isolatedSpawn)
    expect((await r.suitesAt(one)).map((s: S) => s.name)).toEqual(['advanced', 'claude-real'])
    expect((await r.suitesAt('HEAD')).map((s: S) => s.name)).toEqual(['advanced', 'renamed'])
    expect(await r.namesAt(one, 'advanced.cjs')).toEqual(['tests/e2e/claude-real.cjs'])
    expect(await r.namesAt('HEAD', 'advanced.cjs')).toEqual([])
    expect(await r.namesAt(one, 'shared.test.ts')).toEqual(['tests/fixtures/x.json'])
    // HI-2676: a file's text at a revision; null for a path or a revision git can't show.
    expect(await r.fileAt(one, 'tests/e2e/claude-real.cjs')).toBe("require('./advanced.cjs')\n")
    expect(await r.fileAt('HEAD', 'tests/e2e/claude-real.cjs')).toBe('// alone\n')
    expect(await r.fileAt(one, 'no/such.file')).toBeNull()
    expect(await r.fileAt('f'.repeat(40), 'tests/e2e/advanced.cjs')).toBeNull()
    // advanced.cjs was named by a real suite at `one`: stale, though nothing names it now (HEAD's list readable).
    expect((await testOnlyFiles(['tests/e2e/advanced.cjs'], one, { suitesAt: r.suitesAt, namesAt: r.namesAt })).stale).toEqual(['tests/e2e/advanced.cjs'])
    // What git can't show: an unknown commit; a revision without suites.mjs; one whose suites.mjs doesn't load.
    expect(await r.suitesAt('f'.repeat(40))).toBeNull()
    expect(await r.namesAt('f'.repeat(40), 'advanced.cjs')).toBeNull()
    put('tests/e2e/suites.mjs', 'export const SUITES = [\n')
    git('add', '-A')
    git('commit', '-qm', 'broken')
    expect(await r.suitesAt('HEAD')).toBeNull()
    git('rm', '-q', 'tests/e2e/suites.mjs')
    git('commit', '-qm', 'none')
    expect(await r.suitesAt('HEAD')).toBeNull()
  }
})

describe('npm run release: a version-only bump since the record keeps the manifest (HI-2676)', () => {
  const manifest = manifestFromRecord(fullRecord(), suites).manifest
  const REC = '0123456789ab'
  const pkg = (v: string, more: Record<string, unknown> = {}) => JSON.stringify({ name: 'combwork', version: v, scripts: { build: 'x' }, ...more }, null, 2) + '\n'
  const lock = (v: string, dep = '1.0.0', root = v) => JSON.stringify({ name: 'combwork', version: v, lockfileVersion: 3, packages: { '': { name: 'combwork', version: root }, 'node_modules/x': { version: dep } } }, null, 2) + '\n'
  const notes = (heading: string, line = '- A change.') => `# Release Notes\r\n\r\n${heading}\r\n\r\n${line}\r\n\r\n## 1.1.0 — 2026-11-06\r\n`
  const before = { 'package.json': pkg('1.1.0'), 'package-lock.json': lock('1.1.0'), 'CHANGELOG.md': notes('## Unreleased') }
  const bumped = { 'package.json': pkg('1.2.0'), 'package-lock.json': lock('1.2.0'), 'CHANGELOG.md': notes('## 1.2.0 — 2026-11-20') }
  const LIST = [{ name: 'advanced' }]
  const readers = (now: Record<string, string>, then: Record<string, string | null> = before) => ({
    suitesAt: async () => LIST,
    namesAt: async () => [],
    fileAt: async (rev: string, path: string) => (rev === 'HEAD' ? now : rev === REC ? then : {})[path] ?? null
  })
  const ALL = ['package.json', 'package-lock.json', 'CHANGELOG.md']
  const check = (files: string[], now: Record<string, string>, then?: Record<string, string | null>) => manifestCheck(manifest, () => [MANIFEST, ...files], readers(now, then))

  it('lets the bump through, listed with its version for each provider, and a test-only file beside it', async () => {
    const out = await check([...ALL, 'tests/settingsWorkspace.test.ts'], bumped)
    expect(out.stale).toBeNull()
    expect(out.excluded.codex).toEqual({ record: REC, files: [...ALL, 'tests/settingsWorkspace.test.ts'], version: '1.2.0' })
    expect(Object.keys(out.excluded).sort()).toEqual(['antigravity', 'claude-code', 'codex', 'copilot', 'opencode'])
    // The bump alone, package.json and the lockfile only (no release notes yet): through as well.
    expect((await check(['package.json', 'package-lock.json'], bumped)).stale).toBeNull()
  })

  it('keeps the refusals: a source change, a test change off the allowlist, another package.json field', async () => {
    expect((await check([...ALL, 'src/main/sessions.ts'], bumped)).stale).toContain('(src/main/sessions.ts)')
    expect((await check([...ALL, 'tests/e2e/lib.cjs'], bumped)).stale).toContain('(tests/e2e/lib.cjs)')
    expect((await check(ALL, { ...bumped, 'package.json': pkg('1.2.0', { scripts: { build: 'y' } }) })).stale).toContain('(package.json)')
  })

  it("refuses more than a bump in the lockfile or the release notes, or versions that don't agree", async () => {
    expect((await check(ALL, { ...bumped, 'package-lock.json': lock('1.2.0', '2.0.0') })).stale).toContain('(package-lock.json)')
    expect((await check(ALL, { ...bumped, 'CHANGELOG.md': notes('## 1.2.0 — 2026-11-20', '- Another change.') })).stale).toContain('(CHANGELOG.md)')
    // The heading names another version, or no date, or the record had no Unreleased section to become it.
    for (const heading of ['## 1.3.0 — 2026-11-20', '## 1.2.0'])
      expect((await check(ALL, { ...bumped, 'CHANGELOG.md': notes(heading) })).stale, heading).toContain('(CHANGELOG.md)')
    expect((await check(ALL, bumped, { ...before, 'CHANGELOG.md': notes('## 1.1.1 — 2026-11-10') })).stale).toContain('(CHANGELOG.md)')
    // The lockfile left behind package.json: every bumped file is stale, as is a lockfile's root left behind.
    expect((await check(['package.json'], { ...bumped, 'package-lock.json': lock('1.1.0') })).stale).toContain('(package.json)')
    expect((await check(['package.json', 'package-lock.json'], { ...bumped, 'package-lock.json': lock('1.2.0', '1.0.0', '1.1.0') })).stale).toContain('2 files have changed since (package.json, package-lock.json)')
  })

  it("can't say, so stale: a file git can't show at either revision, JSON that doesn't parse, no file reader at all", async () => {
    expect((await check(ALL, bumped, { ...before, 'package.json': null })).stale).toContain('(package.json)')
    expect((await check(ALL, { ...bumped, 'package-lock.json': '{ not json' })).stale).toContain('3 files have changed since')
    const noFiles = { suitesAt: async () => LIST, namesAt: async () => [] }
    expect((await manifestCheck(manifest, () => [MANIFEST, ...ALL], noFiles)).stale).toContain('3 files have changed since')
    expect(await versionOnlyFiles([], REC, readers(bumped))).toEqual({ exempt: [], stale: [] })
  })
})

describe('the shipped manifest (#365)', () => {
  // Between releases it may lack a provider (Claude Code's real tier runs in the default home until #368, so its entry
  // is written by the release's run); npm run release refuses it until every provider has one (manifestStale).
  it("names only Combwork's providers, each entry as npm run tested-clis writes it from a run record of the real tier", () => {
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

describe('the run record\'s versions are what Combwork selected, not the first copy on PATH (#365)', () => {
  const dir = tempDir('combwork-tested-clis-')
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

  it("an editor extension's copy first on PATH, at another version: Combwork selects the standalone CLI, and notes that one", async () => {
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
      // A test copy of Combwork notes what it selected for the run record.
      const log = join(dir, 'cw-clis.jsonl')
      const env = { user: process.env.CW_USER_DATA, log: process.env.CW_TEST_CLI_LOG }
      process.env.CW_USER_DATA = join(dir, 'profile')
      process.env.CW_TEST_CLI_LOG = log
      // With the home the adapter says its sessions get (#368): CLAUDE_CONFIG_DIR, here a test home.
      const configDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-home')
      try {
        await noteSelectedCli(info, claudeCode.configHome?.() ?? null)
      } finally {
        restore('CW_USER_DATA', env.user)
        restore('CW_TEST_CLI_LOG', env.log)
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
    const was = process.env.CW_TEST_CLI_LOG
    process.env.CW_TEST_CLI_LOG = log
    const user = process.env.CW_USER_DATA
    delete process.env.CW_USER_DATA
    try {
      await noteSelectedCli(info)
      process.env.CW_USER_DATA = join(dir, 'profile')
      await noteSelectedCli({ provider: 'claude-code', found: false, path: null, version: null } as never)
    } finally {
      restore('CW_TEST_CLI_LOG', was)
      restore('CW_USER_DATA', user)
    }
    expect(() => readFileSync(log, 'utf8')).toThrow()
  })
})
