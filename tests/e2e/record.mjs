// A run record (npm run e2e -- <suites> --record): what was tested, on exactly which code, with what result, so a
// reviewer can trust a builder's run instead of repeating it (tests/e2e/README.md, the card-loop skill). The code's
// fingerprint is HEAD plus a hash of every uncommitted change, untracked files included; `--fingerprint` prints the
// current one, to compare with a record's.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import { join, win32 } from 'path'

const runContext = createRequire(import.meta.url)('./runContext.cjs')
const { describeExit } = createRequire(import.meta.url)('./windowsExits.cjs')

/** Not code under test: builds used to rewrite it with only line-ending changes (fixed by #148), and a checkout without that fix still does. */
const NOT_CODE = ['THIRD_PARTY_NOTICES.md']

/**
 * The code's fingerprint: `<HEAD short>` when the tree is clean, else `<HEAD short>+<hash>` over the uncommitted
 * changes (tracked diffs and untracked files' contents, line endings ignored so a checkout's CRLF doesn't count).
 */
export function fingerprint(root = process.cwd()) {
  // core.safecrlf=false: no "LF will be replaced by CRLF" warnings in the runner's output.
  const git = (...a) => execFileSync('git', ['-c', 'core.safecrlf=false', ...a], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: runContext.baseEnv() })
  const head = git('rev-parse', '--short=12', 'HEAD').trim()
  const tracked = git('diff', 'HEAD', '--name-only').split(/\r?\n/).filter(Boolean)
  const untracked = git('ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean)
  const files = [...new Set([...tracked, ...untracked])].filter((f) => !NOT_CODE.includes(f)).sort()
  if (!files.length) return head
  const h = createHash('sha256')
  for (const f of files) {
    h.update(`${f}\0`)
    const p = join(root, f)
    // A deleted file counts as its absence.
    h.update(existsSync(p) ? readFileSync(p).toString('latin1').replace(/\r\n/g, '\n') : '<deleted>')
    h.update('\0')
  }
  return `${head}+${h.digest('hex').slice(0, 12)}`
}

/** The real CLIs a run can use (suites.mjs `needs`): the provider each one is, by its id and name. */
export const REAL_CLIS = { claude: { id: 'claude-code', name: 'Claude Code' }, codex: { id: 'codex', name: 'Codex' }, copilot: { id: 'copilot', name: 'GitHub Copilot' } }

/** The file in a suite's folder where its test copies of Combwork note the CLIs they selected (CW_TEST_CLI_LOG). */
export const CLI_LOG = 'cw-clis.jsonl'

/**
 * The CLIs a suite's test copies of Combwork selected (#365): each provider's executable and version as Combwork's own
 * detection chose them (main's noteSelectedCli writes a line per check to CW_TEST_CLI_LOG), once each. Not a probe of
 * the runner's: what the suite ran is what Combwork picked (a standalone CLI, never an editor extension's copy).
 */
export function readCliLog(text) {
  const seen = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    try {
      const o = JSON.parse(line)
      // The home it ran in (its sign-in and config, #368), when the line says.
      const home = typeof o?.home === 'string' && o.home ? { home: o.home } : {}
      if (typeof o?.provider === 'string' && typeof o?.version === 'string') seen.set(`${o.provider}\0${o.version}\0${o.path ?? ''}\0${home.home ?? ''}`, { provider: o.provider, version: o.version, path: typeof o.path === 'string' ? o.path : null, ...home })
    } catch {
      // Not a line Combwork wrote (a partial one): ignored.
    }
  }
  return [...seen.values()]
}

/**
 * The homes each real suite's own CLI ran in (#368), from what its Combwork noted: `homes` a line per suite ("claude-real:
 * Claude Code in C:\…\claude-real-claude-home"), and `own` the suites that ran one in the user's own home
 * (%USERPROFILE%\.claude, .codex or .copilot), which no suite may: the record isn't valid then.
 */
export function realCliHomes(results, suites, userProfile = process.env.USERPROFILE ?? '') {
  const homes = []
  const own = []
  // One spelling for one folder, as Windows reads it: either slash, dot segments resolved, no trailing slash, any case.
  const same = (p) => win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const userHomes = userProfile ? ['.claude', '.codex', '.copilot'].map((d) => same(win32.join(userProfile, d))) : []
  for (const s of suites) {
    const r = results.find((x) => x.name === s.name)
    if (!r || r.skipped) continue
    for (const need of s.needs ?? []) {
      const cli = REAL_CLIS[need]
      if (!cli) continue
      const used = [...new Set((r.clis ?? []).filter((c) => c.provider === cli.id && c.home).map((c) => c.home))]
      if (!used.length) continue
      homes.push(`${s.name}: ${cli.name} in ${used.join(' and ')}`)
      if (used.some((h) => userHomes.includes(same(h)))) own.push(s.name)
    }
  }
  return { homes, own }
}

/**
 * The versions of each real CLI that the real suites of it ran, from what their Combwork selected: { claude: ['2.1.292'] }.
 * More than one means the suites ran different versions.
 */
export function realCliVersions(results, suites) {
  const out = {}
  for (const [need, { id }] of Object.entries(REAL_CLIS)) {
    const names = new Set(suites.filter((s) => (s.needs ?? []).includes(need)).map((s) => s.name))
    const versions = [...new Set(results.filter((r) => names.has(r.name)).flatMap((r) => (r.clis ?? []).filter((c) => c.provider === id).map((c) => c.version)))]
    if (versions.length) out[need] = versions.sort()
  }
  return out
}

/** The real CLIs' versions, in words: "Claude Code 2.1.292, Codex 0.160.1" (several: "Codex 0.160.1 and 0.161.0"). */
const cliLine = (clis) =>
  Object.entries(clis)
    .map(([k, v]) => `${REAL_CLIS[k]?.name ?? k} ${v.join(' and ')}`)
    .join(', ')

/**
 * How a run picked its suites (#628), for the record, so a reviewer sees whether it was the full set or what
 * `--affected` selected and why: { how: 'all' (the full set: --all, or nothing named), 'affected' or 'named', full
 * (every fake suite ran), base and mergeBase (--affected), files (how many changed), why (affected.mjs's reasons), named }.
 */
export function selectionOf({ all = false, named = [], affected = null, base = null, mergeBase = null, files = 0 }) {
  if (!affected) return all || !named.length ? { how: 'all', full: true, named } : { how: 'named', full: false, named }
  return { how: 'affected', full: !!affected.all, base, mergeBase, files, why: affected.why ?? [], named }
}

/** The record's line saying how the suites were picked (selectionOf), with --affected's reasons, a few at most. */
export function selectionLine(sel, max = 5) {
  if (!sel) return null
  const named = sel.named?.length ? `; named: ${sel.named.join(', ')}` : ''
  if (sel.how === 'all') return `Selected: the full set (fake tier)${named}.`
  if (sel.how === 'named') return `Selected: the suites named${named} (not the full set).`
  const since = `\`--affected\` since ${sel.base}${sel.mergeBase ? ` (${sel.mergeBase.slice(0, 12)})` : ''}, ${sel.files} changed file${sel.files === 1 ? '' : 's'}`
  const why = sel.why.slice(0, max).join('; ') + (sel.why.length > max ? `; and ${sel.why.length - max} more` : '')
  return `Selected: ${since}: ${sel.full ? 'every fake suite (the full set)' : 'not the full set'}${why ? `, because ${why}` : ''}${named}.`
}

/**
 * The record as data (run-record.json beside run-record.md), for scripts: `npm run tested-clis` makes the release's
 * tested-with manifest from it (#365). The code, whether it can be trusted, the real CLIs' versions, each suite's
 * result (the last run's, for a repeat: a valid record had every run pass) with the CLIs its Combwork selected.
 */
export function recordJson({ code, when, results, problems = [], notRun = [], clis = {}, selection = null, packaged = null }) {
  return {
    code,
    when,
    valid: !problems.length,
    problems,
    clis,
    ...(selection ? { selection } : {}),
    ...(packaged ? { packaged } : {}),
    results: results.map((r) => ({
      name: r.name,
      ok: !!r.ok,
      skipped: r.skipped ?? null,
      environment: !!r.environment,
      clis: r.clis ?? [],
      ...(r.notRun ? { notRun: r.notRun } : {}),
      ...(r.partsNotRun?.length ? { partsNotRun: r.partsNotRun } : {}),
      ...(windowsOf(r).length ? { windows: windowsOf(r) } : {})
    })),
    notRun
  }
}

/** A failed suite's Windows codes (#599): its own exit code, described, and those its output names. */
const windowsOf = (r) => (r.ok === false ? [...(describeExit(r.code) ? [`exit ${describeExit(r.code)}`] : []), ...(r.windows ?? [])] : [])

/** The record as Markdown, to paste into a card comment: the fingerprint, each suite's result and time, the logs; and
 * first, if it can't be trusted (recordStatus), why. After the table: how the suites were picked (selection), the real CLIs' versions (clis, when real suites
 * ran), the real tier not run (notRun), and the suites skipped for the environment (a real CLI's usage limit, sign-in,
 * network), which are no result for the code. */
/**
 * The waits that ran out in each suite (lib.until's "WAIT ran out after … ms at …" lines, HI-2663), most time first:
 * [{ name, n, seconds, at: [caller…] }]. A wait that ran out and that nothing checked is time spent for nothing.
 */
export function waitsRanOut(results) {
  return results
    .map((r) => {
      const lines = [...(r.out ?? '').matchAll(/^WAIT ran out after (\d+) ms at (.+)$/gm)]
      return { name: r.name, n: lines.length, seconds: Math.round(lines.reduce((s, m) => s + Number(m[1]), 0) / 1000), at: [...new Set(lines.map((m) => m[2].trim()))] }
    })
    .filter((w) => w.n)
    .sort((a, b) => b.seconds - a.seconds)
}
export const waitsLine = (waits) => `Waits that ran out (10 s or more each, lib.until; HI-2663): ${waits.map((w) => `${w.name} ${w.n} (${w.seconds}s)`).join(', ')}`

export function recordMarkdown({ code, when, jobs, results, logDir, summary, problems = [], runs = null, notRun = [], clis = {}, homes = [], selection = null, packaged = null }) {
  // A skip's reason can quote the CLI: no | to break the table.
  const skippedCell = (r) => `skipped: ${r.skipped.replace(/\|/g, '/')}`
  // A suite not run on a packaged build (#1591), with why: never a pass.
  const notRunCell = (r) => `**NOT RUN**: ${r.notRun.replace(/\|/g, '/')}`
  const parts = (r) => (r.partsNotRun?.length ? ` (${r.partsNotRun.length} part${r.partsNotRun.length === 1 ? '' : 's'} NOT RUN)` : '')
  const result = (r) => (r.notRun ? notRunCell(r) : r.skipped ? skippedCell(r) : `${r.ok ? 'pass' : `**FAIL**${r.failed?.length ? ` (${r.failed.length} check${r.failed.length === 1 ? '' : 's'})` : ''}`}${parts(r)}`)
  const cell = (r) => (!r ? '–' : r.notRun || r.skipped ? result(r) : `${result(r)} ${r.seconds ?? '–'}s`)
  // A record that can't be trusted says so first, so nobody matches its fingerprint by mistake.
  const warning = problems.length ? [`**Not valid — don't trust this record:** ${problems.join('; ')}.`, ''] : []
  const head = `**e2e run record** · code \`${code}\` · ${when} · ${jobs > 1 ? `${jobs} at a time` : 'one at a time'}${packaged ? ` · packaged build \`${packaged}\` (CW_EXE)` : ''}`
  const envSkipped = [...new Set((runs ?? [{ results }]).flatMap((r) => r.results.filter((x) => x.environment).map((x) => x.name)))]
  const windows = results.filter((r) => windowsOf(r).length).map((r) => `${r.name}: ${windowsOf(r).join('; ')}`)
  const devOnly = results.filter((r) => r.notRun).map((r) => r.name)
  const partsLeft = results.filter((r) => r.partsNotRun?.length).map((r) => `${r.name}: ${r.partsNotRun.join('; ')}`)
  const waits = waitsRanOut(results)
  const notes = [
    ...(waits.length ? [`${waitsLine(waits)}.`] : []),
    ...(selection ? [selectionLine(selection)] : []),
    ...(windows.length ? [`Windows codes (#599): ${windows.join(' · ')}.`] : []),
    ...(Object.keys(clis).length ? [`Real CLIs (as Combwork selected them): ${cliLine(clis)}.`] : []),
    ...(homes.length ? [`Real CLIs' homes (#368): ${homes.join('; ')}.`] : []),
    ...(notRun.length ? [`Not run: the real tier (\`--real\`): ${notRun.join(', ')}.`] : []),
    ...(devOnly.length ? [`**Not run on the packaged build** (they would test the dev build; why in the table): ${devOnly.join(', ')}.`] : []),
    ...(partsLeft.length ? [`**Parts not run** (the suite said NOT RUN): ${partsLeft.join(' · ').replace(/\|/g, '/')}.`] : []),
    ...(envSkipped.length ? [`**Skipped for the environment** (no result for the code; the reviewer decides whether a merge needs them run again): ${envSkipped.join(', ')}.`] : [])
  ]
  const tail = notes.length ? ['', ...notes] : []
  if (!runs) {
    const rows = results.map((r) => `| ${r.name} | ${result(r)} | ${r.notRun ? '–' : `${r.seconds ?? '–'}s`} |`)
    return [...warning, head, '', '| Suite | Result | Time |', '|---|---|---|', ...rows, '', `${summary}. Logs: \`${logDir}\``, ...tail].join('\n')
  }
  // A repeat (--repeat N): each run's result, time and logs, then each suite's result in each run.
  const names = results.map((r) => r.name)
  return [
    ...warning,
    `${head} · ${runs.length} of ${runs.repeat ?? runs.length} runs`,
    '',
    '| Run | Result | Logs |',
    '|---|---|---|',
    ...runs.map((r, i) => `| ${i + 1} | ${r.ok ? 'pass' : '**FAIL**'}: ${r.summary} | \`${r.logDir}\` |`),
    '',
    `| Suite | ${runs.map((_, i) => `Run ${i + 1}`).join(' | ')} |`,
    `|---|${runs.map(() => '---|').join('')}`,
    ...names.map((n) => `| ${n} | ${runs.map((r) => cell(r.results.find((x) => x.name === n))).join(' | ')} |`),
    '',
    summary,
    ...tail
  ].join('\n')
}
