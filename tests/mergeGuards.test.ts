// Merge guards (HI-3284, design HI-3284/s16): the shape and bounds a save takes, the globs, the unified-diff parser over
// recorded Git output (tests/fixtures/mergeGuards), the matching (added lines only, whole lines, flags, paths),
// the report for agents, the example guard's pattern, and the worker: a runaway pattern ends at its time limit naming
// the guard, the empty-match rule at a save, and a read that fails or is too large is incomplete, never a pass.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
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
  splitGlobs,
  unquotePath,
  type AddedFile,
  type MergeGuard
} from '../src/shared/workflow/mergeGuards'
import { cancelPreview, checkMergeGuards, EMPTY_CHECK_MS, emptyMatchProblems, guardWorkers, inWorker, previewMergeGuard, PREVIEW_LIMITS, PREVIEWS_AT_ONCE, previewsNow, schedulePreview, useGuardsWorker } from '../src/main/workflow/mergeGuardsRun'
import { withGuardsWorker } from './guardsWorker'
import { guardedShown } from '../src/main/workflow/queueState'
import { storedLineText } from '../src/shared/taskHistory'
import { tr } from '../src/shared/i18n'
import { takesOption } from '../src/shared/workflow/options'
import { tempDir } from './tempDir'
import { freshGitRepo, sh } from './workflow/harness'
import { addedDiff } from '../src/main/gitCommands'
import { timing } from './timing.cjs'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'mergeGuards', name), 'utf8')
const guard = (over: Partial<MergeGuard> = {}): MergeGuard => ({ name: 'No secrets', pattern: 'secret', message: 'Take it out.', ...over })
const files = (d: string): AddedFile[] => {
  const r = parseAddedLines(d)
  if ('incomplete' in r) throw new Error(r.incomplete)
  return r.files
}

// The longest a wait here waits: a bound for a hung run, never how long it should take (#570). Vitest's default 1 s is a
// budget a loaded runner outlasts (HI-3349).
const HUNG_MS = timing('wait.hang')

describe('the diff parser (recorded git 2.56.0 output)', () => {
  // The change it describes: an added line, a deleted file, a binary change, a non-ASCII name with a space,
  // a CRLF file, a new file, a line without its final newline, a pure rename and an edited one.
  const expected = [
    { path: 'a.txt', lines: [{ n: 4, text: 'new secret line' }] },
    { path: 'café x.txt', lines: [{ n: 2, text: 'secret accent' }] },
    { path: 'crlf.txt', lines: [{ n: 3, text: 'third secret' }] },
    { path: 'new.txt', lines: [{ n: 1, text: 'brand new' }, { n: 2, text: 'secret too' }] },
    { path: 'nonl.txt', lines: [{ n: 1, text: 'no final newline, secret' }] },
    { path: 'renedit2.txt', lines: [{ n: 6, text: 'added secret' }] }
  ]

  it.each(['git-2.56.0-added.diff'])('reads only the added text lines of %s', (name) => {
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
    expect(s.messages).toEqual([{ guard: 'No secrets', message: 'Take it out.', count: 6, file: 'a.txt', line: 4 }])
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

describe('a preview of what a guard already matches (HI-3284’s decision)', () => {
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

describe('previews in their turn (HR2\'s round 1, finding 3)', () => {
  /** A preview that runs until it is let go or cancelled, telling when it starts. */
  function held() {
    const started: string[] = []
    const go = new Map<string, () => void>()
    const run = (name: string) => (signal: AbortSignal) =>
      new Promise<{ count: number; hits: []; files: number; incomplete?: string }>((resolve) => {
        started.push(name)
        go.set(name, () => resolve({ count: 0, hits: [], files: 0 }))
        signal.addEventListener('abort', () => resolve({ count: 0, hits: [], files: 0, incomplete: 'cancelled' }), { once: true })
      })
    return { started, go, run }
  }

  it('reads at most two at once, the rest waiting in order; a newer one for a row cancels its earlier one, waiting or reading', async () => {
    const h = held()
    const a = schedulePreview('row-a', h.run('a1'))
    const b = schedulePreview('row-b', h.run('b1'))
    const c = schedulePreview('row-c', h.run('c1'))
    await expect.poll(() => h.started, { timeout: HUNG_MS }).toEqual(['a1', 'b1'])
    expect(previewsNow()).toEqual({ running: PREVIEWS_AT_ONCE, waiting: 1 })
    // Row c changes while it waits: its first never starts.
    const c2 = schedulePreview('row-c', h.run('c2'))
    expect(await c).toMatchObject({ incomplete: 'cancelled' })
    // Row a changes while it reads: its first ends now, and the next in turn starts.
    const a2 = schedulePreview('row-a', h.run('a2'))
    expect(await a).toMatchObject({ incomplete: 'cancelled' })
    await expect.poll(() => h.started, { timeout: HUNG_MS }).toEqual(['a1', 'b1', 'c2'])
    h.go.get('b1')!()
    expect(await b).toEqual({ count: 0, hits: [], files: 0 })
    await expect.poll(() => h.started, { timeout: HUNG_MS }).toEqual(['a1', 'b1', 'c2', 'a2'])
    // Row c closes: cancelled.
    cancelPreview('row-c')
    expect(await c2).toMatchObject({ incomplete: 'cancelled' })
    h.go.get('a2')!()
    await a2
    expect(previewsNow()).toEqual({ running: 0, waiting: 0 })
  })
})

describe('globs typed in one field', () => {
  it('split only at commas outside braces, round-tripping a brace glob', () => {
    expect(splitGlobs('src/*.{ts,tsx}, docs/**')).toEqual(['src/*.{ts,tsx}', 'docs/**'])
    expect(splitGlobs(' a ,, {b,c}/d ,')).toEqual(['a', '{b,c}/d'])
    expect(splitGlobs(splitGlobs('src/*.{ts,tsx}, docs/**').join(', '))).toEqual(['src/*.{ts,tsx}', 'docs/**'])
    expect(guardProblems([guard({ paths: splitGlobs('src/*.{ts,tsx}, docs/**') })])).toEqual([])
  })
})

describe('what a returned card says of its guards (HR2\'s round 1, finding 5)', () => {
  const window = (g: Parameters<typeof guardedShown>[0]): string | null => storedLineText(guardedShown(g), (m, values) => tr(m, values))
  const twoGuards = matchGuards([{ path: 'a.txt', lines: [{ n: 3, text: 'one secret' }] }, { path: 'b.txt', lines: Array.from({ length: 10 }, (_x, i) => ({ n: i + 1, text: 'TODO now' })) }], [guard({ name: 'A', message: 'Take it out.' }), guard({ name: 'B', pattern: 'TODO', message: 'Card it.' })])

  it('names each guard with its own count, first place and message', () => {
    expect(twoGuards.messages).toEqual([{ guard: 'A', message: 'Take it out.', count: 1, file: 'a.txt', line: 3 }, { guard: 'B', message: 'Card it.', count: 10, file: 'b.txt', line: 1 }])
    expect(window(twoGuards)).toBe('Came back from the merge queue: 2 merge guards matched lines it adds. “A” matched 1 line, first in a.txt:3: Take it out. “B” matched 10 lines, first in b.txt:1: Card it. The card’s Work section shows the run.')
    expect(guardFailureText(twoGuards)).toBe('merge guards match lines it adds: "A" 1 line, "B" 10 lines')
  })

  it('names three and counts the rest', () => {
    const many = matchGuards([{ path: 'a', lines: [{ n: 1, text: 'abcde' }] }], ['a', 'b', 'c', 'd', 'e'].map((x) => guard({ name: x.toUpperCase(), pattern: x, message: 'm' })))
    const said = window(many)!
    expect(said).toContain('5 merge guards matched')
    expect(said).toContain('“C” matched 1 line')
    expect(said).not.toContain('“D”')
    expect(said).toContain('2 more guards matched too.')
  })

  it('says why a check couldn\'t finish, never as a match', () => {
    expect(window({ hits: [], more: 0, messages: [], incomplete: 'timedOut:Slow' })).toBe('Came back from the merge queue: the merge guards couldn’t finish checking the lines it adds (guard “Slow” ran past its time limit), so it wasn’t merged. The card’s Work section shows the run.')
    expect(window({ hits: [], more: 0, messages: [], incomplete: 'tooLarge' })).toContain('(the merge adds more than they check)')
  })
})

describe('the example guard (HI-3284’s decision)', () => {
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

// HI-3364: the user's git configuration can change the diff's form; addedDiff pins each setting the parser depends on.
describe('the merge’s diff read with real git, whatever the repository’s diff settings', () => {
  it('a submodule moved and hunks near each other, under diff.submodule=log, interHunkContext and suppressBlankEmpty: read, never malformed', { timeout: HUNG_MS }, async () => {
    const repo = freshGitRepo(join(tempDir('guards-diff-'), 'repo'))
    sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)
    // Only what is staged: `add -A` would take the gitlink, which has no folder, for a deletion.
    const only = (content: string, message: string): string => {
      writeFileSync(join(repo, 'blank.txt'), content)
      sh(repo, 'add', '--', 'blank.txt')
      sh(repo, 'commit', '-q', '-m', message)
      return sh(repo, 'rev-parse', 'HEAD')
    }
    const base = only('a\n\nb\n', 'base')
    sh(repo, 'update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`)
    const head = only('A\n\nB\n', 'head')
    for (const [k, v] of [['diff.submodule', 'log'], ['diff.interHunkContext', '3'], ['diff.suppressBlankEmpty', 'true'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.ui', 'always']]) sh(repo, 'config', k, v)
    // The settings do change what a plain `git diff` prints: the reasons the pins exist.
    const plain = sh(repo, 'diff', '-U0', base, head)
    expect(plain).toContain(`Submodule sub ${'1'.repeat(7)}...${'2'.repeat(7)}`)
    expect(parseAddedLines(plain)).toEqual({ incomplete: 'malformed' })
    const read = await addedDiff(repo, base, head)
    if (!('text' in read)) throw new Error(JSON.stringify(read))
    // A gitlink reads as git's default form says it (its `Subproject commit` line), as without the setting.
    expect(parseAddedLines(read.text)).toEqual({
      files: [
        { path: 'blank.txt', lines: [{ n: 1, text: 'A' }, { n: 3, text: 'B' }] },
        { path: 'sub', lines: [{ n: 1, text: `Subproject commit ${'2'.repeat(40)}` }] }
      ],
      lines: 3
    })
  })
})

describe('the worker', () => {
  const built = withGuardsWorker()

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
    const r = await checkMergeGuards(runaway, async () => ({ text }), { timeoutMs: 300, maxLines: 10 }) // timing-ok: the timeout under test (its expiry is what the test checks)
    // HI-3377: not checked, the environment's (the same revision may go back), never a match.
    expect(r).toMatchObject({ hits: [], incomplete: 'timedOut:Runaway', transient: true })
    expect(guardFailureText(r)).toContain('guard "Runaway" ran past its time limit')
  }, HUNG_MS)

  // HI-3377: the request's time starts at the worker's ready, after its module loaded, never at the thread's start; a worker
  // never ready is bounded on its own, and ran no pattern. Workers of the test's own: the real one loaded late, and one that
  // never says it is ready.
  describe('its start and its ready', () => {
    const late = (ms: number): string => {
      const f = join(tempDir('cw-guards-late-'), 'late.cjs')
      writeFileSync(f, `setTimeout(() => require(${JSON.stringify(built.bundle)}), ${ms})\n`)
      return f
    }
    const never = (): string => {
      const f = join(tempDir('cw-guards-never-'), 'never.cjs')
      writeFileSync(f, 'setInterval(() => {}, 1000)\n')
      return f
    }
    // Not a React hook, whatever its name: the worker's script for these tests (lint's hook rule reads names).
    const setScript = useGuardsWorker
    const withScript = async <T,>(script: string, fn: () => Promise<T>): Promise<T> => {
      setScript(script)
      try {
        return await fn()
      } finally {
        setScript(built.bundle)
      }
    }

    it('loaded after its thread started, longer than the request’s time: still answered (the time runs from its ready)', async () => {
      const r = await withScript(late(1500), () => checkMergeGuards([guard()], async () => ({ text: diff }), { timeoutMs: 1000, maxLines: 200_000 })) // timing-ok: the limit under test, shorter than the worker's late load on purpose
      expect(r.hits).toHaveLength(6)
      expect(r.incomplete).toBeUndefined()
      expect(guardWorkers.live).toBe(0)
    }, HUNG_MS)

    it('never ready: ended at its start bound, recorded as not ready (transient), no pattern blamed; a save says unchecked', async () => {
      const r = await withScript(never(), () => inWorker({ type: 'empty', guards: [guard()] }, HUNG_MS, undefined, 300))
      expect(r).toEqual({ ended: 'failed', starting: true })
      const c = await withScript(never(), () => checkMergeGuards([guard()], async () => ({ text: diff }), { ...limits, startMs: 300 }))
      expect(c).toMatchObject({ hits: [], incomplete: 'failed:notReady', transient: true })
      expect(guardFailureText(c)).not.toContain('time limit')
      expect(guardWorkers.live).toBe(0)
    }, HUNG_MS)

    it('cancelled while starting, and while matching: cancelled, its worker ended', async () => {
      const starting = new AbortController()
      const a = withScript(never(), () => inWorker({ type: 'empty', guards: [guard()] }, HUNG_MS, starting.signal, HUNG_MS))
      await expect.poll(() => guardWorkers.live, { timeout: HUNG_MS }).toBe(1)
      starting.abort()
      expect(await a).toEqual({ ended: 'cancelled' })
      expect(guardWorkers.live).toBe(0)
      const matching = new AbortController()
      const text = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'a'.repeat(40)}!\n`
      const b = checkMergeGuards([guard({ name: 'Runaway', pattern: '^(a+)+$' })], async () => ({ text }), { ...limits, signal: matching.signal })
      await expect.poll(() => guardWorkers.live, { timeout: HUNG_MS }).toBe(1)
      matching.abort()
      expect(await b).toMatchObject({ incomplete: 'cancelled', transient: true })
      expect(guardWorkers.live).toBe(0)
    }, HUNG_MS)
  })

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
    // Its time ran out (a worker of the test's own, ready but never answering): the pattern's time, named; the save refused.
    const silent = join(tempDir('cw-guards-silent-'), 'silent.cjs')
    writeFileSync(silent, "require('worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000)\n")
    useGuardsWorker(silent)
    try {
      expect(await emptyMatchProblems([guard(), guard({ pattern: 'y' })], 300)).toEqual([{ guard: 0, field: 'pattern', why: 'timedOut' }])
    } finally {
      useGuardsWorker(built.bundle)
    }
    expect(EMPTY_CHECK_MS).toBe(10_000)
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
    // Its time from the worker's ready (HI-3377): a worker of the test's own, ready but never answering, runs past it.
    const silent = join(tempDir('cw-guards-silent-'), 'silent.cjs')
    writeFileSync(silent, "require('worker_threads').parentPort.postMessage({ ready: true }); setInterval(() => {}, 1000)\n")
    useGuardsWorker(silent)
    try {
      expect(await previewMergeGuard(root, null, [], guard(), { timeoutMs: 300 })).toMatchObject({ incomplete: 'timedOut' }) // timing-ok: the limit under test, which the silent worker runs past
    } finally {
      useGuardsWorker(built.bundle)
    }
    expect(PREVIEW_LIMITS.timeoutMs).toBe(30_000)
    const ac = new AbortController()
    ac.abort()
    expect(await previewMergeGuard(root, null, [], guard(), { signal: ac.signal })).toMatchObject({ incomplete: 'cancelled' })
    // A preview needs only a valid pattern and paths: a guard still without its name or message is previewed.
    expect(await previewMergeGuard(root, ['LICENSE'], [], guard({ name: '', message: '' }))).toMatchObject({ count: 1 })
    expect(guardWorkers.live).toBe(0)
  }, HUNG_MS)

  it('never matches on main\'s thread: with no worker it answers that the check failed, and a save refuses its guards unchecked', async () => {
    useGuardsWorker(join(tempDir('cw-no-worker-'), 'missing.cjs'))
    try {
      const runaway = [guard({ name: 'Runaway', pattern: '^(a+)+$' })]
      const text = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'a'.repeat(40)}!\n`
      expect(await checkMergeGuards(runaway, async () => ({ text }), limits)).toMatchObject({ hits: [], incomplete: 'failed' })
      expect(await emptyMatchProblems([guard()])).toEqual([{ guard: 0, field: 'pattern', why: 'unchecked' }])
      expect(await previewMergeGuard(tempDir('cw-no-worker-root-'), [], [], guard())).toMatchObject({ incomplete: 'failed' })
    } finally {
      useGuardsWorker(built.bundle)
    }
  })

  it('leaves no worker behind: answered, timed out or cancelled while it runs', async () => {
    const text = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'a'.repeat(40)}!\n`
    const runaway = [guard({ name: 'Runaway', pattern: '^(a+)+$' })]
    await checkMergeGuards([guard()], async () => ({ text: diff }), limits)
    await checkMergeGuards(runaway, async () => ({ text }), { timeoutMs: 200, maxLines: 10 }) // timing-ok: the timeout under test (its expiry is what the test checks)
    const ac = new AbortController()
    const cancelled = checkMergeGuards(runaway, async () => ({ text }), { ...limits, signal: ac.signal })
    await expect.poll(() => guardWorkers.live, { timeout: HUNG_MS }).toBe(1)
    ac.abort()
    expect(await cancelled).toMatchObject({ incomplete: 'cancelled', transient: true })
    expect(guardWorkers.live).toBe(0)
  }, HUNG_MS)

  it('answers a request and is ended after it', async () => {
    const r = await inWorker({ type: 'empty', guards: [guard()] }, HUNG_MS)
    expect(r).toEqual({ problems: [] })
  })
})
