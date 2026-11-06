// The old name's guard (HI-2617, tests/oldNames.mjs): no file or path of the repository names the app's old name except
// where tests/oldNamesAllow.json places it, every entry there still places one, and what Combwork generates by default
// names it nowhere. `node tests/oldNames.mjs` lists what fails, by file.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { ALLOW_FILE, checkDiffNames, checkNames, checkRepoNames, diffPath, inventory, nameHits, textOf } from './oldNames.mjs'
import { ASSISTANT_GITIGNORE, BOARD_GITIGNORE, HANDOVER_README, WORKSPACE_README } from '../src/main/workspace'
import { COPIES_EXCLUDE_COMMENT } from '../src/main/providers/common'
import { LAUNCH_README } from '../src/main/providers/claude/adapter'
import { DEFAULT_APP_CONFIG, DEFAULT_PROJECT_CONFIG, DEFAULT_SETTINGS, DEFAULT_WORKSPACE_CONFIG } from '../src/shared/defaults'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const { oldNameHits } = createRequire(import.meta.url)('./sandbox/clean.cjs') as { oldNameHits: (text: string) => { at: number; match: string }[] }
/** A region's marker line, put together so the cases below aren't markers of this file. */
const mark = (kind: 'begin' | 'end', id: string): string => ['// old-name:', kind, id].join(' ')

type Hit = { file: string; line: number; text: string }
type Allow = Record<string, Record<string, string>[]>
const check = (files: Record<string, string | Buffer>, allow: Allow = {}): { hits: Hit[]; problems: string[] } =>
  checkNames({ files: Object.keys(files).sort(), read: (f: string) => (typeof files[f] === 'string' ? Buffer.from(files[f] as string) : files[f]), allow })

// old-name: begin truth-table
describe("the old name's detector (HI-2617)", () => {
  it('finds it in any case, as a word or joined to anything', () => {
    const hits = ['hive', 'Hive', 'HIVE', 'hIvE', '.hive', 'hive.db', 'hive-api', 'hive_text', 'HIVE_DIR', 'CW_HIVE', 'HiveMcp', 'myHive', 'provideHiveMcp', 'hive/HI-12', 'Hive-Card', "Hive's", 'hives', 'hive2', '2hive', 'xhive', 'cxhive-ws', 'myhive_inbox', 'hiveish', '\\nhive', 'arcHive', 'ArcHIVE', 'beeHive', 'chivey', 'Chiver', 'archHive']
    for (const h of hits) expect(nameHits(h).length, h).toBe(1)
    expect(nameHits('the Hive app, archive, hive.log').map((h: { at: number; match: string }) => [h.at, h.match])).toEqual([[4, 'Hive'], [23, 'hive']])
  })

  it('passes the ordinary words that hold its letters: archive in all its forms, chive, chives, beehive', () => {
    const not = ['archive', 'Archive', 'ARCHIVE', 'archived', 'Archived', 'archives', 'archiving', 'archiver', 'unarchive', 'Unarchived', 'insideArchive', 'boardarchive', 'ARCHIVE_DIR', 'désarchiver', 'chive', 'chives', 'Chives', 'CHIVES', 'beehive', 'Beehive', 'BEEHIVES', 'a chive.', '']
    for (const n of not) expect(nameHits(n), n).toEqual([])
  })

  it('is the clean-install check\'s matcher too: both find the same hits in the same cases (HI-2633)', () => {
    const cases = [
      'hive', 'Hive', 'HIVE', 'hIvE', '.hive', 'hive.db', 'HIVE_DIR', 'CW_HIVE', 'myHive', "Hive's", 'hives', 'hive2', '2hive', 'xhive', 'XHIVE', 'myhive', 'myhive_inbox',
      'cw-hive-mcp', 'getHive()', 'x/hive', 'arcHive', 'ArcHIVE', 'beeHive', 'chivey', 'archHive',
      'archive', 'Archive', 'ARCHIVE', 'archived', 'unarchive', 'ARCHIVE_DIR', 'désarchiver', 'chive', 'chives', 'CHIVES', 'beehive', 'BEEHIVES', 'Combwork', 'hiv e', '',
      'the Hive app, archive, hive.log'
    ]
    const at = (hs: { at: number; match: string }[]) => hs.map((h) => [h.at, h.match])
    for (const c of cases) expect(at(oldNameHits(c)), c).toEqual(at(nameHits(c)))
    for (const c of ['xhive', 'XHIVE', 'myhive']) expect(oldNameHits(c), c).toHaveLength(1)
    expect(oldNameHits('archive')).toEqual([])
  })

  it('reads UTF-16 by its BOM, and binary content as bytes', () => {
    expect(nameHits(textOf(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a Hive', 'utf16le')])))).toHaveLength(1)
    expect(nameHits(textOf(Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x01]), Buffer.from('tEXthive'), Buffer.from([0x00])])))).toHaveLength(1)
    expect(nameHits(textOf(Buffer.from([0x89, 0x50, 0x00, 0x01, 0x68, 0x69])))).toEqual([])
  })
})

describe("the old name's allowances (HI-2617)", () => {
  it('fails each hit nothing places, in a path too, with its line', () => {
    const { hits, problems } = check({ 'src/a.ts': 'one\nconst dir = ".hive"\n', 'tests/hive-fixture.txt': 'nothing' })
    expect(hits).toEqual([
      { file: 'src/a.ts', line: 2, text: 'const dir = ".hive"' },
      { file: 'tests/hive-fixture.txt', line: 0, text: '(its path)' }
    ])
    expect(problems).toEqual([])
  })

  it("places a hit in a listed region, string, file, path or history, and nothing outside them", () => {
    const files = {
      'src/up.ts': `a Hive\n${mark('begin', 'input')}\nconst OLD = ".hive"\n${mark('end', 'input')}\nafter hive\n`,
      'locales/en/x.json': '{ "a": "From Hive 1.0", "b": "Hive again" }',
      'tests/fixtures/rec.jsonl': '{"cwd":"hive"}\n',
      'tests/fixtures/rec-hive.txt': 'clean',
      'CHANGELOG.md': '## Unreleased\n- Hive now\n## 1.0.0 — 2026-11-03\n- Hive then\n'
    }
    const allow = {
      regions: [{ file: 'src/up.ts', id: 'input', why: 'the input' }],
      strings: [{ file: 'locales/en/x.json', text: 'From Hive 1.0', why: 'history' }],
      files: [{ file: 'tests/fixtures/rec.jsonl', why: 'recorded' }],
      paths: [{ path: 'tests/fixtures/rec-hive.txt', why: 'recorded' }],
      history: [{ file: 'CHANGELOG.md', from: '## 1.0.0 — 2026-11-03', why: 'released' }]
    }
    const { hits, problems } = check(files, allow)
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(['CHANGELOG.md:2', 'locales/en/x.json:1', 'src/up.ts:1', 'src/up.ts:5'])
    expect(problems).toEqual([])
  })

  it('fails a stale entry of each kind, and one naming a file that is gone', () => {
    const allow = {
      regions: [{ file: 'a.ts', id: 'empty', why: '' }],
      strings: [{ file: 'a.ts', text: 'Hive gone', why: '' }, { file: 'a.ts', text: 'clean text', why: '' }],
      files: [{ file: 'b.txt', why: '' }],
      paths: [{ path: 'b.txt', why: '' }],
      history: [{ file: 'a.ts', from: '## 0.1.0', why: '' }, { file: 'gone.md', from: '## 1.0.0', why: '' }]
    }
    const { hits, problems } = check({ 'a.ts': `${mark('begin', 'empty')}\nclean\n${mark('end', 'empty')}\nclean text\n## 0.1.0\nclean\n`, 'b.txt': 'clean' }, allow)
    expect(hits).toEqual([])
    expect(problems).toEqual([
      'history[1]: gone.md isn\'t a file of the repository',
      'regions[0] (a.ts, empty) places no hit: remove it',
      'strings[0] (a.ts) places no hit: remove it',
      'strings[1] (a.ts) places no hit: remove it',
      'files[0] (b.txt) places no hit: remove it',
      'paths[0] (b.txt) places no hit: remove it',
      'history[0] (a.ts) places no hit: remove it',
      'history[1] (gone.md) places no hit: remove it'
    ])
  })

  it("fails a marker the list doesn't name, so a file can't exempt itself, and one unclosed or doubled", () => {
    const { hits, problems } = check(
      { 'a.ts': `${mark('begin', 'mine')}\nconst x = "hive"\n${mark('end', 'mine')}\n`, 'b.ts': `${mark('begin', 'open')}\nhive\n`, 'c.ts': `${mark('end', 'loose')}\n` },
      { regions: [{ file: 'b.ts', id: 'open', why: '' }, { file: 'c.ts', id: 'loose', why: '' }] }
    )
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(['a.ts:2', 'b.ts:2'])
    expect(problems).toEqual([
      `a.ts: the marker "${mark('begin', 'mine').slice(3)}" isn't in tests/oldNamesAllow.json's regions`,
      `a.ts: the marker "${mark('end', 'mine').slice(3)}" isn't in tests/oldNamesAllow.json's regions`,
      'b.ts: the region open never ends',
      'c.ts: the region loose ends without beginning',
      'regions[0] (b.ts, open) places no hit: remove it',
      'regions[1] (c.ts, loose) places no hit: remove it'
    ])
  })

  it("places a diffFiles file whole, as the change's check does, and never calls one stale (the Assistant's call on HI-2625)", () => {
    const allow = {
      regions: [{ file: 'src/up.ts', id: 'input', why: '' }],
      diffFiles: [{ file: 'src/up.ts', why: 'the upgrade' }, { file: 'src/clean.ts', why: 'the upgrade' }, { file: 'gone.ts', why: '' }]
    }
    const files = { 'src/up.ts': `const a = "Hive"\n${mark('begin', 'input')}\nconst OLD = ".hive"\n${mark('end', 'input')}\n`, 'src/clean.ts': 'clean', 'src/other.ts': 'hive' }
    const { hits, problems } = check(files, allow)
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(['src/other.ts:1'])
    // The region inside it still places its own hit, so it isn't stale either.
    expect(problems).toEqual(["diffFiles[2]: gone.ts isn't a file of the repository"])
  })

  it('a history entry places only what follows its line', () => {
    const { hits } = check({ 'CHANGELOG.md': '## Unreleased\r\n- Hive\r\n## 1.0.0 — 2026-11-03\r\n- Hive\r\n' }, { history: [{ file: 'CHANGELOG.md', from: '## 1.0.0 — 2026-11-03', why: '' }] })
    expect(hits.map((h) => h.line)).toEqual([2])
  })

  it("reads the list's own file as allowances, not as hits", () => {
    expect(check({ [ALLOW_FILE]: '{ "strings": [{ "file": "a.ts", "text": "Hive" }] }', 'a.ts': 'Hive' }, { strings: [{ file: 'a.ts', text: 'Hive', why: '' }] })).toEqual({ hits: [], problems: [] })
  })

  it('finds a hit planted in a new file of a repository, and in its path, before it is committed', () => {
    const repo = tempDir('cw-oldnames-')
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      mkdirSync(join(repo, dirname(ALLOW_FILE)), { recursive: true })
      writeFileSync(join(repo, ALLOW_FILE), '{}')
      writeFileSync(join(repo, 'clean.ts'), 'export const archive = 1\n')
      git('add', '.')
      writeFileSync(join(repo, 'planted.ts'), 'export const dir = "Hive"\n')
      writeFileSync(join(repo, 'hive.md'), 'clean\n')
      writeFileSync(join(repo, '.gitignore'), 'ignored.ts\n')
      writeFileSync(join(repo, 'ignored.ts'), 'hive\n')
      const { hits, problems } = checkRepoNames(repo)
      expect(hits).toEqual([
        { file: 'hive.md', line: 0, text: '(its path)' },
        { file: 'planted.ts', line: 1, text: 'export const dir = "Hive"' }
      ])
      expect(problems).toEqual([])
      expect(inventory(hits)).toEqual(['hive.md (1)', '  0: (its path)', 'planted.ts (1)', '  1: export const dir = "Hive"'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("the names check of a change (Darren's decision on HI-2617)", () => {
  it('fails only what the change adds: a line, a new path; passes the lines it keeps, a diffFiles file, a marked line', () => {
    const repo = tempDir('cw-oldnames-diff-')
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      mkdirSync(join(repo, 'tests'), { recursive: true })
      mkdirSync(join(repo, 'src'), { recursive: true })
      const allow = { diffFiles: [{ file: 'src/upgrade.ts', why: 'the upgrade' }], history: [{ file: 'CHANGELOG.md', from: '## 1.0.0', why: 'released' }] }
      writeFileSync(join(repo, ALLOW_FILE), JSON.stringify(allow))
      writeFileSync(join(repo, 'src/a.ts'), 'const kept = ".hive"\n')
      writeFileSync(join(repo, 'src/upgrade.ts'), 'export {}\n')
      writeFileSync(join(repo, 'CHANGELOG.md'), '## Unreleased\n## 1.0.0\n- old\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      const base = git('rev-parse', 'HEAD').trim()
      writeFileSync(join(repo, 'src/a.ts'), 'const kept = ".hive"\nconst added = "Hive"\nconst marked = ".hive" // old-name: the input folder\nconst clean = "archive"\n')
      writeFileSync(join(repo, 'src/upgrade.ts'), 'export const OLD = ".hive"\n')
      writeFileSync(join(repo, 'CHANGELOG.md'), '## Unreleased\n- Hive now\n## 1.0.0\n- old\n- Hive then\n')
      writeFileSync(join(repo, 'src/hive-new.ts'), 'export {}\n')
      git('add', '.')
      git('commit', '-q', '-m', 'the change')
      // New and not committed: counted whole.
      writeFileSync(join(repo, 'src/loose.ts'), 'const x = "myHive"\n')
      const { base: from, hits } = checkDiffNames(repo, base)
      expect(from).toBe(base)
      expect(hits.map((h: Hit) => `${h.file}:${h.line}`)).toEqual(['CHANGELOG.md:2', 'src/a.ts:2', 'src/hive-new.ts:0', 'src/loose.ts:1'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('checks a path with a space or a non-ASCII letter, changed or new, its lines and its name (HI-2633)', () => {
    const repo = tempDir('cw-oldnames-paths-')
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      mkdirSync(join(repo, 'tests'), { recursive: true })
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, ALLOW_FILE), '{}')
      for (const f of ['src/a b.ts', 'src/café.ts', 'src/plain.ts']) writeFileSync(join(repo, f), 'one\n')
      git('add', '.')
      git('commit', '-q', '-m', 'base')
      const base = git('rev-parse', 'HEAD').trim()
      for (const f of ['src/a b.ts', 'src/café.ts']) writeFileSync(join(repo, f), 'one\nconst x = "Hive"\n')
      // Lines that read like a file's header, in a hunk ("--- a/x", "+++ b/x"): still lines of plain.ts, not a file.
      writeFileSync(join(repo, 'src/plain.ts'), '-- a/src/a b.ts\n++ b/src/a b.ts\nconst z = "xhive"\n')
      writeFileSync(join(repo, 'src/né hive.ts'), 'hive\n')
      writeFileSync(join(repo, 'src/new space.ts'), '\nconst y = "myhive"\n')
      git('add', '.')
      git('commit', '-q', '-m', 'the change')
      const { hits } = checkDiffNames(repo, base)
      expect(hits.map((h: Hit) => `${h.file}:${h.line}`).sort()).toEqual(['src/a b.ts:2', 'src/café.ts:2', 'src/new space.ts:2', 'src/né hive.ts:0', 'src/né hive.ts:1', 'src/plain.ts:3'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("reads git's quoted header paths", () => {
    expect(diffPath('b/src/a b.ts\t')).toBe('src/a b.ts')
    expect(diffPath('"b/src/caf\\303\\251.ts"')).toBe('src/café.ts')
    expect(diffPath('"b/src/say \\"x\\".ts"')).toBe('src/say "x".ts')
    expect(diffPath('/dev/null')).toBeNull()
  })

  it("each diffFiles entry is a file of the repository, and check:repo runs the change's check", () => {
    const allow = JSON.parse(readFileSync(join(__dirname, '..', ALLOW_FILE), 'utf8')) as { diffFiles: { file: string; why: string }[] }
    expect(allow.diffFiles.length).toBeGreaterThan(0)
    for (const e of allow.diffFiles) {
      expect(existsSync(join(__dirname, '..', e.file)), e.file).toBe(true)
      expect(e.why, e.file).toBeTruthy()
    }
    expect(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).scripts['check:repo']).toContain('node tests/oldNames.mjs --diff')
  })
})
// old-name: end truth-table

// The whole tree is `npm run check:names` (node tests/oldNames.mjs), the report sweep 3 works from; check:repo runs the
// change's check, `--diff` (Darren's decision on HI-2617, 6 Nov).
describe('the old name in what Combwork generates (HI-2617)', () => {
  it('appears in nothing Combwork generates by default: the files it writes, the default settings and configs', () => {
    const generated: Record<string, string> = {
      WORKSPACE_README,
      BOARD_GITIGNORE,
      ASSISTANT_GITIGNORE,
      HANDOVER_README,
      COPIES_EXCLUDE_COMMENT,
      LAUNCH_README,
      DEFAULT_SETTINGS: JSON.stringify(DEFAULT_SETTINGS),
      DEFAULT_APP_CONFIG: JSON.stringify(DEFAULT_APP_CONFIG),
      DEFAULT_WORKSPACE_CONFIG: JSON.stringify(DEFAULT_WORKSPACE_CONFIG),
      DEFAULT_PROJECT_CONFIG: JSON.stringify(DEFAULT_PROJECT_CONFIG)
    }
    expect(Object.entries(generated).filter(([, text]) => nameHits(text).length).map(([name]) => name)).toEqual([])
  })
})
