// Merge guards (HI-3284, design HI-3284/s16): the shape and bounds a save takes, the globs, the unified-diff parser over
// recorded Git and jj output (tests/fixtures/mergeGuards), the matching (added lines only, whole lines, flags, paths),
// the report for agents, the example guard's pattern, and the worker: a runaway pattern ends at its time limit naming
// the guard, the empty-match rule at a save, and a read that fails or is too large is incomplete, never a pass.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  excerptOf,
  GUARD_EXCERPT,
  GUARD_HITS_KEPT,
  GUARD_LIMITS,
  guardApplies,
  guardFailureText,
  guardProblems,
  guardReportLog,
  guardsKey,
  guardsRefuse,
  guardWarning,
  matchGuards,
  namePattern,
  nameGuard,
  offersNameGuard,
  parseAddedLines,
  previewGuard,
  PREVIEW_HITS,
  unquotePath,
  type AddedFile,
  type MergeGuard
} from '../src/shared/workflow/mergeGuards'
import { checkMergeGuards, emptyMatchProblems, inWorker, previewMergeGuard, useGuardsWorker } from '../src/main/workflow/mergeGuardsRun'
import { takesOption } from '../src/shared/workflow/options'
import { tempDir } from './tempDir'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'mergeGuards', name), 'utf8')
const guard = (over: Partial<MergeGuard> = {}): MergeGuard => ({ name: 'No secrets', pattern: 'secret', message: 'Take it out.', ...over })
const files = (d: string): AddedFile[] => {
  const r = parseAddedLines(d)
  if ('incomplete' in r) throw new Error(r.incomplete)
  return r.files
}

describe('the diff parser (recorded git 2.56.0 and jj 0.47.1 output)', () => {
  // The same change both tools describe: an added line, a deleted file, a binary change, a non-ASCII name with a space,
  // a CRLF file, a new file, a line without its final newline, a pure rename and an edited one.
  const expected = [
    { path: 'a.txt', lines: [{ n: 4, text: 'new secret line' }] },
    { path: 'café x.txt', lines: [{ n: 2, text: 'secret accent' }] },
    { path: 'crlf.txt', lines: [{ n: 3, text: 'third secret' }] },
    { path: 'new.txt', lines: [{ n: 1, text: 'brand new' }, { n: 2, text: 'secret too' }] },
    { path: 'nonl.txt', lines: [{ n: 1, text: 'no final newline, secret' }] },
    { path: 'renedit2.txt', lines: [{ n: 6, text: 'added secret' }] }
  ]

  it.each(['git-2.56.0-added.diff', 'jj-0.47.1-added.diff'])('reads only the added text lines of %s', (name) => {
    expect(files(fixture(name))).toEqual(expected)
  })

  it('unquotes git’s C-quoted paths, octal escapes as UTF-8', () => {
    expect(unquotePath('"b/caf\\303\\251 \\"x\\".txt"')).toBe('b/café "x".txt')
    expect(unquotePath('"a\\tb\\\\c"')).toBe('a\tb\\c')
    expect(unquotePath('b/plain.txt')).toBe('b/plain.txt')
    expect(files('diff --git "a/t\\tab" "b/t\\tab"\n--- "a/t\\tab"\n+++ "b/t\\tab"\n@@ -0,0 +1 @@\n+x\n')).toEqual([{ path: 't\tab', lines: [{ n: 1, text: 'x' }] }])
  })

  it('reads an added line that looks like a header as a line, by the hunk’s counts', () => {
    expect(files('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n++++ b/y\n+diff --git a/z b/z\n')).toEqual([{ path: 'x', lines: [{ n: 1, text: '+++ b/y' }, { n: 2, text: 'diff --git a/z b/z' }] }])
  })

  it('is incomplete, never partial: a malformed or truncated diff, or past its lines', () => {
    expect(parseAddedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n')).toEqual({ incomplete: 'truncated' })
    expect(parseAddedLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n?what\n')).toEqual({ incomplete: 'malformed' })
    expect(parseAddedLines('garbage\n')).toEqual({ incomplete: 'malformed' })
    expect(parseAddedLines(fixture('git-2.56.0-added.diff'), 3)).toEqual({ incomplete: 'tooManyLines' })
    expect(parseAddedLines('')).toEqual({ files: [], lines: 0 })
  })
})

describe('globs', () => {
  it('matches a name at any depth without a slash, the path from the root with one, and a folder’s contents', () => {
    expect(guardApplies({ skip: ['LICENSE*'] }, 'LICENSE.md')).toBe(false)
    expect(guardApplies({ skip: ['LICENSE*'] }, 'sub/LICENSE')).toBe(false)
    expect(guardApplies({ skip: ['docs/**'] }, 'docs/a/b.md')).toBe(false)
    expect(guardApplies({ skip: ['docs/**'] }, 'src/docs/b.md')).toBe(true)
    expect(guardApplies({ skip: ['docs'] }, 'docs/b.md')).toBe(false)
    expect(guardApplies({ paths: ['src/**/*.ts'] }, 'src/a/b/c.ts')).toBe(true)
    expect(guardApplies({ paths: ['src/**/*.ts'] }, 'src/c.ts')).toBe(true)
    expect(guardApplies({ paths: ['src/**/*.ts'] }, 'tests/c.ts')).toBe(false)
    expect(guardApplies({ paths: ['*.{md,txt}'] }, 'a/b.TXT')).toBe(true)
    expect(guardApplies({ paths: ['?.ts'] }, 'ab.ts')).toBe(false)
    expect(guardApplies({ paths: ['src/*.ts'], skip: ['src/gen.ts'] }, 'src\\gen.ts')).toBe(false)
    expect(guardApplies({}, 'anything')).toBe(true)
  })
})

describe('saving guards: shape and bounds, never running a pattern', () => {
  it('takes a well-formed list and refuses each problem, naming the guard', () => {
    expect(guardProblems([guard(), guard({ ignoreCase: true, paths: ['src/**'], skip: ['LICENSE'] })])).toEqual([])
    expect(takesOption('mergeGuards', [guard()])).toBe(true)
    // The option takes the shape; the rest is the save's to say, each by its message (guardProblems).
    expect(takesOption('mergeGuards', [guard({ pattern: '(' })])).toBe(true)
    expect(takesOption('mergeGuards', [{ name: 'x' }])).toBe(false)
    expect(guardProblems('x')).toEqual([{ guard: -1, field: 'list', why: 'notList' }])
    expect(guardProblems(Array.from({ length: GUARD_LIMITS.guards + 1 }, () => guard()))).toEqual([{ guard: -1, field: 'list', why: 'tooMany' }])
    expect(guardProblems([{ name: 'x' }])).toEqual([{ guard: 0, field: 'list', why: 'notGuard' }])
    expect(guardProblems([guard({ name: ' ', message: '' })]).map((p) => `${p.field}:${p.why}`)).toEqual(['name:empty', 'message:empty'])
    expect(guardProblems([guard({ name: 'n'.repeat(GUARD_LIMITS.name + 1) })]).map((p) => p.why)).toEqual(['tooLong'])
    expect(guardProblems([guard({ pattern: 'a'.repeat(GUARD_LIMITS.pattern + 1) })]).map((p) => p.why)).toEqual(['tooLong'])
    const bad = guardProblems([guard(), guard({ pattern: '(unclosed' })])
    expect(bad).toMatchObject([{ guard: 1, field: 'pattern', why: 'invalid' }])
    expect(bad[0].detail).toMatch(/Unterminated group|unclosed|Invalid/i)
    // The u flag: an identity escape it doesn't take is refused at save, as matching would compile it.
    expect(guardProblems([guard({ pattern: '\\-' })]).map((p) => p.why)).toEqual(['invalid'])
  })

  it('refuses globs it can’t use, and too many', () => {
    for (const g of ['/abs', 'a/../b', 'a//b', '[ab].ts', 'a\\b', '{a,{b}}', '{a', 'a}', '{a/b}', '']) expect(guardProblems([guard({ paths: [g] })]).map((p) => p.why), g).toEqual(['glob'])
    expect(guardProblems([guard({ skip: Array.from({ length: GUARD_LIMITS.globs + 1 }, (_x, i) => `f${i}`) })]).map((p) => p.why)).toEqual(['tooManyGlobs'])
    expect(guardProblems([guard({ paths: ['src/**', '*.{ts,tsx}', 'a?c'] })])).toEqual([])
  })

  it('keys guards by everything that changes a result, in order', () => {
    const a = guard()
    const b = guard({ name: 'Other', pattern: 'x' })
    expect(guardsKey([])).toBe('')
    expect(guardsKey([a, b])).toBe(guardsKey([{ ...a }, { ...b }]))
    expect(guardsKey([a, b])).not.toBe(guardsKey([b, a]))
    expect(guardsKey([a])).not.toBe(guardsKey([{ ...a, ignoreCase: true }]))
    expect(guardsKey([a])).not.toBe(guardsKey([{ ...a, skip: ['LICENSE'] }]))
    expect(guardsKey([a])).toBe(guardsKey([{ ...a, ignoreCase: false, paths: [] }]))
  })
})

describe('matching', () => {
  const added = files(fixture('git-2.56.0-added.diff'))

  it('matches only added lines (a match the target already has, or a deleted one, is no hit), each line whole', () => {
    const r = matchGuards(added, [guard({ name: 'Old', pattern: 'old', message: 'Say new.' })])
    expect(r).toEqual({ hits: [], more: 0, messages: [] })
    const s = matchGuards(added, [guard()])
    expect(s.hits.map((h) => `${h.file}:${h.line}`)).toEqual(['a.txt:4', 'café x.txt:2', 'crlf.txt:3', 'new.txt:2', 'nonl.txt:1', 'renedit2.txt:6'])
    expect(s.messages).toEqual([{ guard: 'No secrets', message: 'Take it out.' }])
    // A match past the first 4,000 characters of a line is found (no prefix scanning, HR2's round 1).
    const long = matchGuards([{ path: 'min.js', lines: [{ n: 1, text: `${'x'.repeat(10_000)}secret` }] }], [guard()])
    expect(long.hits).toHaveLength(1)
    expect(long.hits[0].excerpt.length).toBeLessThanOrEqual(GUARD_EXCERPT + 2)
    expect(long.hits[0].excerpt).toContain('secret')
  })

  it('takes the case flag and the paths', () => {
    const f: AddedFile[] = [{ path: 'src/a.ts', lines: [{ n: 1, text: 'SECRET' }] }, { path: 'LICENSE', lines: [{ n: 1, text: 'secret' }] }]
    expect(matchGuards(f, [guard()]).hits.map((h) => h.file)).toEqual(['LICENSE'])
    expect(matchGuards(f, [guard({ ignoreCase: true })]).hits.map((h) => h.file)).toEqual(['src/a.ts', 'LICENSE'])
    expect(matchGuards(f, [guard({ ignoreCase: true, skip: ['LICENSE'] })]).hits.map((h) => h.file)).toEqual(['src/a.ts'])
    expect(matchGuards(f, [guard({ ignoreCase: true, paths: ['*.md'] })]).hits).toEqual([])
  })

  it('keeps at most GUARD_HITS_KEPT hits and counts the rest', () => {
    const many: AddedFile[] = [{ path: 'x', lines: Array.from({ length: GUARD_HITS_KEPT + 7 }, (_x, i) => ({ n: i + 1, text: 'secret' })) }]
    const r = matchGuards(many, [guard()])
    expect(r.hits).toHaveLength(GUARD_HITS_KEPT)
    expect(r.more).toBe(7)
  })

  it('is incomplete for a pattern that matches an empty line, never run', () => {
    expect(matchGuards(added, [guard({ name: 'All', pattern: 'x*' })])).toMatchObject({ hits: [], incomplete: 'matchesEmpty:All' })
  })

  it('says a match and an unfinished check apart, for agents', () => {
    const r = matchGuards(added, [guard()])
    expect(guardsRefuse(r)).toBe(true)
    expect(guardFailureText(r)).toBe('merge guard "No secrets" matches 6 lines it adds')
    expect(guardReportLog(r).split('\n')).toEqual(['a.txt:4: new secret line', 'café x.txt:2: secret accent', 'crlf.txt:3: third secret', 'new.txt:2: secret too', 'nonl.txt:1: no final newline, secret', 'renedit2.txt:6: added secret', '"No secrets": Take it out.'])
    const unfinished = { hits: [], more: 0, messages: [], incomplete: 'timedOut:No secrets' }
    expect(guardsRefuse(unfinished)).toBe(true)
    expect(guardFailureText(unfinished)).toBe('the merge guards couldn\'t finish (guard "No secrets" ran past its time limit), so nothing was proved')
    expect(guardWarning(r)).toBe('Merge guards: merge guard "No secrets" matches 6 lines it adds since its merge base (a.txt:4). The merge will refuse it if it is still there when merged.')
    expect(guardsRefuse({ hits: [], more: 0, messages: [] })).toBe(false)
  })

  it('cuts only the excerpt', () => {
    expect(excerptOf('\tshort secret ', 7, 6)).toBe('short secret')
    const cut = excerptOf(`${'a'.repeat(300)}secret${'b'.repeat(300)}`, 300, 6)
    expect(cut.startsWith('…') && cut.endsWith('…') && cut.includes('secret')).toBe(true)
  })
})

describe('a preview of what a guard already matches (Darren’s decision, 15 Nov)', () => {
  it('counts every line it matches in the files it applies to, listing the first few', () => {
    const texts = [{ path: 'a.txt', text: 'secret\nno\nsecret\r\n' }, { path: 'LICENSE', text: 'secret' }, ...Array.from({ length: 6 }, (_x, i) => ({ path: `f${i}.txt`, text: 'a secret' }))]
    const p = previewGuard(texts, guard({ skip: ['LICENSE'] }))
    expect(p.count).toBe(8)
    expect(p.files).toBe(7)
    expect(p.hits).toHaveLength(PREVIEW_HITS)
    expect(p.hits.slice(0, 2)).toEqual([{ file: 'a.txt', line: 1, excerpt: 'secret' }, { file: 'a.txt', line: 3, excerpt: 'secret' }])
    expect(previewGuard([{ path: 'a', text: 'none' }], guard())).toEqual({ count: 0, hits: [], files: 1 })
  })
})

describe('the example guard (Darren’s decision, 15 Nov)', () => {
  const hits = (name: string, text: string): boolean => new RegExp(namePattern(name), 'u').test(text)

  it('matches the name as a whole word, case-sensitive, its spaces any whitespace', () => {
    expect(hits('Ann Lee', 'by Ann Lee.')).toBe(true)
    expect(hits('Ann Lee', 'by Ann\tLee')).toBe(true)
    expect(hits('Ann Lee', 'by ann lee')).toBe(false)
    expect(hits('Ann Lee', 'by JoAnn Lee')).toBe(false)
    expect(hits('Ann Lee', 'by Ann Leeds')).toBe(false)
  })

  it('escapes the name, and bounds it by Unicode letters (punctuation and accents at its ends)', () => {
    expect(hits('Dr. Who', 'thanks Dr. Who, ok')).toBe(true)
    expect(hits('Dr. Who', 'thanks DrX Who')).toBe(false)
    expect(hits('Zoë', 'Zoë wrote it')).toBe(true)
    expect(hits('Zoë', 'Zoëy wrote it')).toBe(false)
    expect(hits('a+b (c)', 'x a+b (c) y')).toBe(true)
    expect(hits('O\'Neil-Smith', "by O'Neil-Smith")).toBe(true)
    expect(guardProblems([nameGuard('a+b (c) [d] {e} | f/g \\ h $ ^ ? *', 'Keep', 'Msg')])).toEqual([])
  })

  it('fills once with the skips, offered only for a name that is set', () => {
    expect(nameGuard('Ann Lee', 'Keep my name out of the code', 'Your name…')).toEqual({ name: 'Keep my name out of the code', pattern: namePattern('Ann Lee'), skip: ['LICENSE*', 'package.json', 'electron-builder.yml', 'CODE_OF_CONDUCT*'], message: 'Your name…' })
    expect(offersNameGuard('Ann')).toBe(true)
    expect(offersNameGuard('User')).toBe(false)
    expect(offersNameGuard('  ')).toBe(false)
    expect(offersNameGuard(undefined)).toBe(false)
  })
})

describe('the worker', () => {
  const tmp = tempDir('cw-merge-guards-')
  const bundle = join(tmp, 'merge-guards-worker.cjs')
  // The longest a wait here waits: a bound for a hung run, never how long it should take (#570).
  const HUNG_MS = 30_000

  beforeAll(async () => {
    await build({ entryPoints: [join(__dirname, '..', 'src', 'main', 'workflow', 'mergeGuardsWorker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
    useGuardsWorker(bundle)
  }, 60_000)
  afterAll(() => useGuardsWorker(null))

  const limits = { timeoutMs: HUNG_MS, maxLines: 200_000 }
  const diff = fixture('git-2.56.0-added.diff')

  it('matches in its own thread', async () => {
    const r = await checkMergeGuards([guard()], async () => ({ text: diff }), limits)
    expect(r.hits).toHaveLength(6)
    expect(r.incomplete).toBeUndefined()
  })

  it('ends a runaway pattern at its time limit, naming the guard: incomplete, never a pass', async () => {
    const runaway = [guard({ name: 'Quick' }), guard({ name: 'Runaway', pattern: '^(a+)+$' })]
    const text = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'a'.repeat(40)}!\n`
    // A time limit the pattern can't meet (2^40 steps), so the thread is ended mid-match.
    const r = await checkMergeGuards(runaway, async () => ({ text }), { timeoutMs: 300, maxLines: 10 })
    expect(r).toMatchObject({ hits: [], incomplete: 'timedOut:Runaway' })
    expect(r.transient).toBeUndefined()
    expect(guardFailureText(r)).toContain('guard "Runaway" ran past its time limit')
  }, HUNG_MS)

  it('is incomplete for a read too large, unreadable (transient), past its lines, or cancelled', async () => {
    expect(await checkMergeGuards([guard()], async () => ({ tooLarge: true }), limits)).toMatchObject({ incomplete: 'tooLarge' })
    expect(await checkMergeGuards([guard()], async () => ({ unreadable: 'fatal: bad object' }), limits)).toMatchObject({ incomplete: 'unreadable', transient: true })
    expect(await checkMergeGuards([guard()], async () => { throw new Error('gone') }, limits)).toMatchObject({ incomplete: 'unreadable', transient: true })
    expect(await checkMergeGuards([guard()], async () => ({ text: diff }), { ...limits, maxLines: 2 })).toMatchObject({ incomplete: 'tooLarge' })
    const ac = new AbortController()
    ac.abort()
    expect(await checkMergeGuards([guard()], async () => ({ text: diff }), { ...limits, signal: ac.signal })).toMatchObject({ incomplete: 'cancelled' })
    // No guards: nothing read.
    expect(await checkMergeGuards([], async () => { throw new Error('never read') }, limits)).toEqual({ hits: [], more: 0, messages: [] })
  })

  it('checks the empty-match rule at a save, and a pattern that takes too long there', async () => {
    expect(await emptyMatchProblems([guard(), guard({ pattern: 'x?' })])).toEqual([{ guard: 1, field: 'pattern', why: 'matchesEmpty' }])
    expect(await emptyMatchProblems([guard()])).toEqual([])
    expect(await emptyMatchProblems(undefined)).toEqual([])
    // The worker named which guard it was on when its time ran out (here, a limit no worker can meet).
    expect(await emptyMatchProblems([guard(), guard({ pattern: 'y' })], 0)).toMatchObject([{ field: 'pattern', why: 'timedOut' }])
  })

  it('previews what a guard already matches in a project: the files given, or a walk leaving out dot folders and the excluded', async () => {
    const root = tempDir('cw-guard-preview-')
    const put = (f: string, text: string | Buffer): void => {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), text)
    }
    put('src/a.ts', 'ok\nmy secret\r\nsecret again\n')
    put('LICENSE', 'a secret licence\n')
    put('node_modules/x/i.js', 'secret\n')
    put('.git/config', 'secret\n')
    put('bin.dat', Buffer.from([0, 1, 2, 115, 101, 99, 114, 101, 116]))
    const walked = await previewMergeGuard(root, null, ['node_modules'], guard({ skip: ['LICENSE'] }))
    expect(walked).toEqual({ count: 2, files: 1, hits: [{ file: 'src/a.ts', line: 2, excerpt: 'my secret' }, { file: 'src/a.ts', line: 3, excerpt: 'secret again' }] })
    const listed = await previewMergeGuard(root, ['LICENSE', 'gone.txt'], [], guard())
    expect(listed).toMatchObject({ count: 1, hits: [{ file: 'LICENSE', line: 1 }] })
    expect(await previewMergeGuard(root, null, [], guard({ pattern: '(' }))).toMatchObject({ incomplete: 'invalid' })
    expect(await previewMergeGuard(root, null, [], guard(), 0)).toMatchObject({ incomplete: 'timedOut' })
  }, HUNG_MS)

  it('answers a request and is ended after it', async () => {
    const r = await inWorker({ type: 'empty', guards: [guard()] }, HUNG_MS)
    expect(r).toEqual({ problems: [] })
  })
})
