// The translations' tooling (#768): the English catalogues and typed values are up to date with the code
// (scripts/i18nExtract.mjs), the translations pass the blocking check (i18nCheck.mjs: an extra key, broken ICU or a
// changed placeholder fails it; a missing translation doesn't), and coverage (i18nCoverage.mjs) only informs.
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs modules without types
import { extractDrift, extractMessages, extractWithCli, extractWithJs, hasNativeCli, messageProblems, writeGenerated } from '../scripts/i18nExtract.mjs'
// @ts-expect-error: plain .mjs modules without types
import { valuesDts } from '../scripts/i18nValues.mjs'
// @ts-expect-error: plain .mjs modules without types
import { ALTERNATE_VALUES, checkTranslations, verifyWithCli, verifyWithJs } from '../scripts/i18nCheck.mjs'
// @ts-expect-error: plain .mjs modules without types
import { coverage, coverageLines, recordSource } from '../scripts/i18nCoverage.mjs'

const ROOT = resolve(__dirname, '..')
const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
type Messages = Record<string, { defaultMessage: string; description?: string }>

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A tree of its own, with these files (path relative to it → content). */
function tree(files: Record<string, string>): string {
  const root = tempDir('hive-i18n-cat-')
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const script = (name: string, ...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', name), ...args], { encoding: 'utf8', env: ctx.baseEnv() })
const sorted = (m: Messages): string => JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))))

const SOURCE = [
  `import { msg } from '../shared/i18n/msg'`,
  `export const M = {`,
  `  cards: msg({ id: 'board.cards', defaultMessage: '{n, plural, one {# card} other {# cards}}', description: 'A count of cards' }),`,
  `  hello: msg({ id: 'board.hello', defaultMessage: 'Hello,   {name}  ', description: 'A greeting; {name} is an agent' }),`,
  `  when: msg({ id: 'progress.when', defaultMessage: 'Started {at, date, short} by {who, select, user {you} other {{who}}} <b>now</b>', description: 'When a run started' }),`,
  `  joined: msg({ id: 'progress.joined', defaultMessage: 'Joined ' + 'up', description: \`Two parts\` })`,
  `}`
].join('\n')

describe('the English catalogues and typed values (i18n:extract)', () => {
  it("are up to date with Combwork's source", () => {
    const drift = extractDrift(ROOT) as string[]
    expect(drift, 'out of date: run npm run i18n:extract and commit the result').toEqual([])
  })

  it("every message in Combwork's source names its area and has a note for translators", () => {
    expect(messageProblems(extractMessages(ROOT))).toEqual([])
  })

  it.runIf(hasNativeCli())("reading without the CLI (no native binding) finds the same messages as formatjs extract, in Combwork's source and a fixture", () => {
    expect(sorted(extractWithJs(ROOT))).toBe(sorted(extractWithCli(ROOT)))
    const root = tree({ 'src/renderer/src/Panel.tsx': SOURCE })
    expect(sorted(extractWithJs(root))).toBe(sorted(extractWithCli(root)))
  })

  it.each([
    ['formatjs extract', extractWithCli],
    ['Babel', extractWithJs]
  ])('%s: a duplicate id with other text fails', (_name, extract) => {
    if (extract === extractWithCli && !hasNativeCli()) return
    const root = tree({ 'src/a.ts': `import { msg } from './m'\nexport const a = msg({ id: 'x.a', defaultMessage: 'A', description: 'one' })\nexport const b = msg({ id: 'x.a', defaultMessage: 'B', description: 'two' })\n` })
    expect(() => extract(root)).toThrow(/Duplicate message id: "x\.a"/)
  })

  it('reading without the CLI finds msg calls written with space, a line break or a comment before the parenthesis (review round 1)', () => {
    const root = tree({
      'src/a.ts': [
        `import { msg } from './m'`,
        `export const a = msg ({ id: 'x.a', defaultMessage: 'Hi', description: 'Greeting' })`,
        `export const b = msg`,
        `  ({ id: 'x.b', defaultMessage: 'Bye', description: 'Farewell' })`,
        `export const c = msg /* a note */ ({ id: 'x.c', defaultMessage: 'Later', description: 'Parting' })`
      ].join('\n')
    })
    expect(Object.keys(extractWithJs(root)).sort()).toEqual(['x.a', 'x.b', 'x.c'])
    if (hasNativeCli()) expect(sorted(extractWithJs(root))).toBe(sorted(extractWithCli(root)))
  })

  // #815: a leading space, a line break or two spaces is part of the message (translators work from this English), so
  // neither reader trims or collapses it, and a line break in the source reads the same from a CRLF file as from an LF one.
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n']
  ])('both readers keep white space as written (%s source)', (_name, eol) => {
    const root = tree({
      'src/a.ts': [
        `import { msg } from './m'`,
        "export const a = msg({ id: 'x.a', defaultMessage: `One",
        "  Two`, description: 'A line break in a template' })",
        `export const b = msg({ id: 'x.b', defaultMessage: ' lead\\ttab\\n\\npara ', description: 'Leading, trailing, a tab and a paragraph' })`,
        `export const c = msg({ id: 'x.c', defaultMessage: 'a ' + '\\n b', description: 'Joined with +' })`,
        `export const d = msg({ id: 'x.d', defaultMessage: "two  spaces ", description: 'Two spaces' })`
      ].join(eol)
    })
    const want = { 'x.a': 'One\n  Two', 'x.b': ' lead\ttab\n\npara ', 'x.c': 'a \n b', 'x.d': 'two  spaces ' }
    const english = (m: Messages) => Object.fromEntries(Object.entries(m).map(([id, x]) => [id, x.defaultMessage]))
    expect(english(extractWithJs(root))).toEqual(want)
    if (hasNativeCli()) expect(english(extractWithCli(root))).toEqual(want)
  })

  it('a message with no note for translators, or an id with no area, is a problem', () => {
    expect(messageProblems({ 'board.ok': { defaultMessage: 'Fine', description: 'A word' }, 'board.bare': { defaultMessage: 'No note' }, nodots: { defaultMessage: 'X', description: 'An id with no area' } })).toEqual([
      'board.bare: needs a description, a note for translators (what it is and where it shows)',
      'nodots: an id is its area and a name, in parts joined by dots ("settings.general.title")'
    ])
  })

  it('writes a catalogue and typed values per area, finds them stale when a message changes, and removes an area with none left', () => {
    const root = tree({ 'src/renderer/src/Panel.tsx': SOURCE })
    expect(extractDrift(root)).toEqual(['locales/en/board.json', 'locales/en/progress.json', 'src/shared/i18n/values/board.d.ts', 'src/shared/i18n/values/progress.d.ts'])
    writeGenerated(root)
    expect(extractDrift(root)).toEqual([])
    const board = JSON.parse(readFileSync(join(root, 'locales/en/board.json'), 'utf8')) as Messages
    expect(board['board.hello']).toEqual({ defaultMessage: 'Hello,   {name}  ', description: 'A greeting; {name} is an agent' })
    // The --check the stale-file test makes, as the command CI's npm test runs: a message changed in the code.
    writeFileSync(join(root, 'src/renderer/src/Panel.tsx'), SOURCE.replace("'Hello,   {name}  '", "'Hi, {name}'"))
    expect(extractDrift(root)).toEqual(['locales/en/board.json'])
    const r = script('i18nExtract.mjs', '--root', root, '--check')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('locales/en/board.json')
    // An area whose messages all went: its files go too.
    writeFileSync(join(root, 'src/renderer/src/Panel.tsx'), SOURCE.split('\n').filter((l) => !l.includes("'progress.")).join('\n'))
    writeGenerated(root)
    expect(existsSync(join(root, 'locales/en/progress.json'))).toBe(false)
    expect(existsSync(join(root, 'src/shared/i18n/values/progress.d.ts'))).toBe(false)
    expect(script('i18nExtract.mjs', '--root', root, '--check').status).toBe(0)
  })

  it('keeps the line endings of a file on disk when it rewrites it', () => {
    const root = tree({ 'src/a.ts': `import { msg } from './m'\nexport const a = msg({ id: 'x.a', defaultMessage: 'A', description: 'one' })\n` })
    writeGenerated(root)
    const file = join(root, 'locales/en/x.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'))
    expect(extractDrift(root)).toEqual([])
    writeFileSync(join(root, 'src/a.ts'), `import { msg } from './m'\nexport const a = msg({ id: 'x.a', defaultMessage: 'B', description: 'one' })\n`)
    writeGenerated(root)
    expect(readFileSync(file, 'utf8')).toBe('{\r\n  "x.a": {\r\n    "defaultMessage": "B",\r\n    "description": "one"\r\n  }\r\n}\r\n')
  })

  it("types each placeholder by its use: plurals and numbers take a number, dates a date, select a string; tags (tRich's) aren't values", () => {
    const dts = valuesDts('progress', {
      'progress.a': { defaultMessage: '{n, plural, one {# card} other {# cards}} by {name}' },
      'progress.b': { defaultMessage: 'Started {at, date, short} by {who, select, user {you} other {{who}}} <b>now</b>' },
      'progress.c': { defaultMessage: '{n} of {n, number}' },
      'progress.d': { defaultMessage: 'No values' }
    }) as string
    expect(dts.split('\n').slice(2)).toEqual([
      'interface CombworkMessageValues {',
      "  'progress.a': { n: number; name: string | number }",
      "  'progress.b': { at: Date | number; who: string }",
      "  'progress.c': { n: number }",
      "  'progress.d': undefined",
      '}',
      ''
    ])
  })
})

// The spike's catalogues (#756, verify-r2): what the blocking check fails, and what it lets through.
const EN = { 'test.hello': 'Hello {name}', 'test.cards': '{n, plural, one {# card} other {# cards}}' }
const VERIFY: [string, Record<string, string>, 0 | 1, RegExp?][] = [
  ['missing everything ({})', {}, 0],
  ['complete and correct', { 'test.hello': 'Witaj {name}', 'test.cards': '{n, plural, one {# karta} few {# karty} many {# kart} other {# karty}}' }, 0],
  ['partly translated', { 'test.hello': 'Witaj {name}' }, 0],
  ['a renamed placeholder ({name} → {nazwa})', { 'test.hello': 'Witaj {nazwa}' }, 1, /test\.hello: Missing variable name/],
  ['a plural with no other', { 'test.cards': '{n, plural, one {# karta}' }, 1, /test\.cards: .*MISSING_OTHER_CLAUSE/],
  ['an extra key', { 'test.hello': 'Witaj {name}', 'test.extra': 'Nadmiar' }, 1, /test\.extra/],
  ['a tag the English has not', { 'test.hello': 'Witaj <b>{name}</b>' }, 1, /test\.hello/]
]

describe('the blocking check of the translations (i18n:check)', () => {
  it.each(VERIFY)('%s: FormatJS parser exits %i', (_name, pl, exit, why) => {
    const problems = verifyWithJs(EN, pl) as string[]
    expect(problems.length ? 1 : 0, problems.join('\n')).toBe(exit)
    if (why) expect(problems.join('\n')).toMatch(why)
  })

  it.each(VERIFY)('%s: formatjs verify agrees', (_name, pl, exit, why) => {
    const problems = verifyWithCli('pl', EN, pl) as string[]
    expect(problems.length ? 1 : 0, problems.join('\n')).toBe(exit)
    if (why) expect(problems.join('\n')).toMatch(why)
  })

  it("Combwork's translations pass, both ways", () => {
    for (const js of [false, true]) {
      const { results } = checkTranslations(ROOT, { js }) as { results: Record<string, string[]> }
      expect(Object.keys(results).length).toBeGreaterThan(0)
      for (const [code, problems] of Object.entries(results)) expect(problems, `${code} (${js ? 'parser' : 'CLI'})`).toEqual([])
    }
  })

  it("a deliberately broken translation fails the command CI's npm test runs, and a missing one doesn't", () => {
    // English and the one language it breaks (HI-2021): the check runs once per language, and every language's own pass
    // is "Combwork's translations pass" above. The whole tree, run four times, took over 20 s under a loaded machine.
    const root = tree({})
    for (const code of ['en', 'pl']) cpSync(join(ROOT, 'locales', code), join(root, 'locales', code), { recursive: true })
    expect(script('i18nCheck.mjs', '--root', root).status).toBe(0)
    const file = join(root, 'locales/pl/language.json')
    const pl = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    expect(pl['language.automatic']).toContain('{language}')
    writeFileSync(file, JSON.stringify({ ...pl, 'language.automatic': pl['language.automatic'].replace('{language}', '{język}') }))
    for (const args of [[], ['--js']]) {
      const r = script('i18nCheck.mjs', '--root', root, ...args)
      expect(r.status, r.stdout).toBe(1)
      expect(r.stdout).toMatch(/language\.automatic: Missing variable language/)
    }
    // Missing is fine: the English shows.
    writeFileSync(file, '{}')
    expect(script('i18nCheck.mjs', '--root', root).status).toBe(0)
  })

  it("a file that isn't messages, a value that isn't text and a message in another area's file fail", () => {
    const root = tree({
      'locales/en/board.json': JSON.stringify({ 'board.a': { defaultMessage: 'A', description: 'x' } }),
      'locales/en/tips.json': JSON.stringify({ 'tips.b': { defaultMessage: 'B', description: 'x' } }),
      'locales/pl/board.json': JSON.stringify({ 'board.a': 5, 'tips.b': 'Be' }),
      'locales/pl/tips.json': '[]',
      'locales/de/board.json': '{ not json'
    })
    const { results } = checkTranslations(root, { js: true }) as { results: Record<string, string[]> }
    expect(results.pl).toEqual(['pl/board.json: board.a is not text', 'pl/board.json: tips.b belongs in pl/tips.json', 'pl/tips.json: not an object of messages (id → text)'])
    expect(results.de).toEqual([expect.stringMatching(/^de\/board\.json: not JSON/)])
  })

  it('a control character or a lone surrogate in a translation fails, and a line break only where the English has none (#888)', () => {
    const root = tree({
      'locales/en/board.json': JSON.stringify({
        'board.a': { defaultMessage: 'Compress', description: 'x' },
        'board.b': { defaultMessage: 'One\nTwo', description: 'x' },
        'board.c': { defaultMessage: 'One two', description: 'x' },
        'board.d': { defaultMessage: 'Tab', description: 'x' },
        'board.e': { defaultMessage: 'Smile', description: 'x' }
      }),
      // As #853's heredoc left it: U+0001 in place of a K. The surrogates are escapes, as only an escape in JSON can make one.
      'locales/de/board.json': `{ "board.a": "\\u0001omprimieren \\u0001", "board.b": "Eins\\nZwei", "board.c": "Eins\\nzwei", "board.d": "Tab\\t\\u007f", "board.e": "L\\ud83d\\ude00chle \\ud83d \\ude00" }`
    })
    for (const js of [true, false]) {
      const { results } = checkTranslations(root, { js }) as { results: Record<string, string[]> }
      expect(results.de).toEqual([
        'de/board.json: board.a has a control character (U+0001)',
        "de/board.json: board.c has a line break (U+000A) the English hasn't",
        'de/board.json: board.d has a control character (U+0009, U+007F)',
        'de/board.json: board.e has a lone surrogate (U+D83D, U+DE00)'
      ])
    }
    const r = script('i18nCheck.mjs', '--root', root)
    expect(r.status, r.stdout).toBe(1)
    expect(r.stdout).toContain('de/board.json: board.a has a control character (U+0001)')
  })

  it('a translation may write an alternate value in place of the placeholder it stands in for, only where one is listed (#904)', () => {
    const [id, alternates] = Object.entries(ALTERNATE_VALUES as Record<string, Record<string, string>>)[0]
    const [alt, name] = Object.entries(alternates)[0]
    const area = id.split('.')[0]
    const root = tree({
      [`locales/en/${area}.json`]: JSON.stringify({ [id]: { defaultMessage: `{n, plural, one {Enable {${name}}} other {Enable all {${name}}}}`, description: 'x' }, [`${area}.other`]: { defaultMessage: `Use {${name}}`, description: 'x' } }),
      [`locales/zh-CN/${area}.json`]: JSON.stringify({ [id]: `{n, plural, other {启用{${alt}}}}`, [`${area}.other`]: `使用{${alt}}` })
    })
    for (const js of [true, false]) {
      const { results } = checkTranslations(root, { js }) as { results: Record<string, string[]> }
      const problems = results['zh-CN'].join('\n')
      expect(problems, js ? 'parser' : 'CLI').toMatch(`${area}.other: Missing variable ${name}`)
      expect(problems, js ? 'parser' : 'CLI').not.toContain(`${id}:`)
    }
  })

  it("each alternate value stands in for a placeholder its English has, and its note for translators names it (#904)", () => {
    for (const [id, alternates] of Object.entries(ALTERNATE_VALUES as Record<string, Record<string, string>>)) {
      const english = JSON.parse(readFileSync(join(ROOT, `locales/en/${id.split('.')[0]}.json`), 'utf8')) as Messages
      expect(english[id], id).toBeTruthy()
      for (const [alt, name] of Object.entries(alternates)) {
        expect(english[id].defaultMessage, id).toContain(`{${name}}`)
        expect(english[id].description, id).toContain(`{${alt}}`)
      }
    }
  })
})

describe('coverage (i18n:coverage), informational', () => {
  const english = {
    'locales/en/board.json': JSON.stringify({ 'board.a': { defaultMessage: 'Save', description: 'x' }, 'board.b': { defaultMessage: 'Cancel', description: 'x' } }),
    'locales/en/tips.json': JSON.stringify({ 'tips.c': { defaultMessage: 'A tip', description: 'x' } })
  }

  it('counts each area, lists what shows in English, and exits 0 for an empty language', () => {
    const root = tree({ ...english, 'locales/pl/board.json': JSON.stringify({ 'board.a': 'Zapisz' }), 'locales/de/board.json': '{}' })
    expect(coverageLines(root, 'pl')).toEqual(['pl: 1 of 3 translated (33.3%)', '  board: 1 of 2; missing (shown in English): board.b', '  tips: 0 of 1; missing (shown in English): tips.c'])
    const r = script('i18nCoverage.mjs', '--root', root)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('de: 0 of 3 translated (0%)')
  })

  it("lists a translation whose English changed since it was recorded as outdated, and --record records new ones only unless named", () => {
    const root = tree({ ...english, 'locales/pl/board.json': JSON.stringify({ 'board.a': 'Zapisz', 'board.b': 'Anuluj' }) })
    expect(recordSource(root, 'pl')).toEqual(['board.a', 'board.b'])
    expect(recordSource(root, 'pl')).toEqual([])
    writeFileSync(join(root, 'locales/en/board.json'), JSON.stringify({ 'board.a': { defaultMessage: 'Save all', description: 'x' }, 'board.b': { defaultMessage: 'Cancel', description: 'x' } }))
    expect(coverage(root, 'pl').board.outdated).toEqual(['board.a'])
    expect(coverageLines(root, 'pl')[0]).toBe('pl: 2 of 3 translated (66.6%); 1 outdated')
    const r = script('i18nCoverage.mjs', '--root', root, '--record', 'pl', 'board.a')
    expect(r.status, r.stderr).toBe(0)
    expect(coverage(root, 'pl').board.outdated).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'locales/.source/pl/board.json'), 'utf8'))).toEqual({ 'board.a': 'Save all', 'board.b': 'Cancel' })
  })

  it('--record writes only the records whose content changed, keeping their CRLF (#1113)', () => {
    const crlf = (o: object) => `${JSON.stringify(o, null, 2)}\n`.replace(/\n/g, '\r\n')
    const root = tree({
      ...english,
      'locales/pl/board.json': JSON.stringify({ 'board.a': 'Zapisz', 'board.b': 'Anuluj' }),
      'locales/pl/tips.json': JSON.stringify({ 'tips.c': 'Wskazówka' }),
      'locales/.source/pl/board.json': crlf({ 'board.a': 'Save' }),
      'locales/.source/pl/tips.json': crlf({ 'tips.c': 'A tip' })
    })
    const tips = readFileSync(join(root, 'locales/.source/pl/tips.json'))
    expect(recordSource(root, 'pl')).toEqual(['board.b'])
    expect(readFileSync(join(root, 'locales/.source/pl/tips.json')).equals(tips)).toBe(true)
    expect(readFileSync(join(root, 'locales/.source/pl/board.json'), 'utf8')).toBe(crlf({ 'board.a': 'Save', 'board.b': 'Cancel' }))
  })
})
