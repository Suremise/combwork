// The Files tab's Git menu (HI-2743): the lines Exclude from git writes (once each, in the file's own line ending, in
// .gitignore or .git/info/exclude), Stop tracking (git rm --cached, the file kept), Include again (only its own plain
// line), and how check-ignore -v is read. Pure helpers, then real git in a throwaway repository.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { appendIgnoreLines, exactIgnoreLine, extensionOf, extIgnoreLine, lineEnding, parseCheckIgnore, removableRule, removeIgnoreLine } from '../src/shared/gitIgnoreRules'
import { tempDir } from './tempDir'

describe('ignore lines', () => {
  it('names exactly one path: anchored, a folder with a trailing slash, pattern characters escaped', () => {
    expect(exactIgnoreLine('a.txt', false)).toBe('/a.txt')
    expect(exactIgnoreLine('src/build', true)).toBe('/src/build/')
    expect(exactIgnoreLine('w[1]*?.txt', false)).toBe('/w\\[1]\\*\\?.txt')
    expect(exactIgnoreLine('#notes', false)).toBe('/#notes')
    expect(exactIgnoreLine('trail  ', false)).toBe('/trail\\ \\ ')
  })

  it('offers an extension only for a file that has one', () => {
    expect(extensionOf('app.log')).toBe('log')
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('.env')).toBeNull()
    expect(extensionOf('Makefile')).toBeNull()
    expect(extensionOf('odd.')).toBeNull()
    expect(extIgnoreLine('log')).toBe('*.log')
  })
})

describe('appending without a duplicate', () => {
  it('adds a line once, and skips one already there', () => {
    const one = appendIgnoreLines('node_modules/\n', ['/a.txt'])
    expect(one).toEqual({ text: 'node_modules/\n/a.txt\n', added: ['/a.txt'] })
    expect(appendIgnoreLines(one.text, ['/a.txt'])).toEqual({ text: one.text, added: [] })
    expect(appendIgnoreLines('/a.txt   \n', ['/a.txt']).added).toEqual([])
    expect(appendIgnoreLines('', ['/a', '/a', '/b']).added).toEqual(['/a', '/b'])
  })

  it("keeps the file's line endings, and breaks a last line that has none", () => {
    expect(lineEnding('a\r\nb')).toBe('\r\n')
    expect(lineEnding('a\nb\r\n')).toBe('\n')
    expect(appendIgnoreLines('dist/\r\n', ['/x']).text).toBe('dist/\r\n/x\r\n')
    expect(appendIgnoreLines('dist/', ['/x']).text).toBe('dist/\n/x\n')
    expect(appendIgnoreLines('dist/\r\n*.log', ['/x']).text).toBe('dist/\r\n*.log\r\n/x\r\n')
    expect(appendIgnoreLines('', ['/x']).text).toBe('/x\n')
    expect(appendIgnoreLines('\uFEFFdist/\r\n', ['/x']).text).toBe('\uFEFFdist/\r\n/x\r\n')
  })
})

describe('removing our own line only', () => {
  it('removes the line named, with its break, and nothing else', () => {
    expect(removeIgnoreLine('a\n/x\nb\n', 2, '/x')).toBe('a\nb\n')
    expect(removeIgnoreLine('a\r\n/x\r\nb\r\n', 2, '/x')).toBe('a\r\nb\r\n')
    expect(removeIgnoreLine('a\r\n/x', 2, '/x')).toBe('a')
    expect(removeIgnoreLine('\uFEFF/x\nb\n', 1, '/x')).toBe('\uFEFFb\n')
  })

  it('refuses when that line is no longer the rule', () => {
    expect(removeIgnoreLine('a\n/y\n', 2, '/x')).toBeNull()
    expect(removeIgnoreLine('a\n', 5, '/x')).toBeNull()
  })

  it('takes out only a plain line for exactly this path, or its extension, in .gitignore or info/exclude', () => {
    const r = (source: string, pattern: string) => ({ source, line: 1, pattern })
    const info = '.git/info/exclude'
    expect(removableRule(r('.gitignore', '/src/a.log'), 'src/a.log', false, info)).toBe('shared')
    expect(removableRule(r('.gitignore', '*.log'), 'src/a.log', false, info)).toBe('shared')
    expect(removableRule(r(info, '/build/'), 'build', true, info)).toBe('local')
    // A wider pattern, a nested .gitignore, the global file, a folder's extension: not ours to take out.
    expect(removableRule(r('.gitignore', 'src/'), 'src/a.log', false, info)).toBeNull()
    expect(removableRule(r('.gitignore', 'a.log'), 'src/a.log', false, info)).toBeNull()
    expect(removableRule(r('src/.gitignore', '/a.log'), 'src/a.log', false, info)).toBeNull()
    expect(removableRule(r('C:/Users/me/.config/git/ignore', '*.log'), 'src/a.log', false, info)).toBeNull()
    expect(removableRule(r('.gitignore', '*.d'), 'x.d', true, info)).toBeNull()
  })
})

describe('reading check-ignore -v', () => {
  it('gives each ignored path its rule, and leaves out a negation and a path not matched', () => {
    const out = ['.gitignore:1:*.log\ta.log', '.gitignore:3:!keep.log\tkeep.log', 'sub/.gitignore:2:deep.txt\tsub/deep.txt', '.gitignore:4:nm/\tnm/', 'C:/Users/me/.config/git/ignore:7:*.tmp\tx.tmp', '.gitignore:9:a:b\t"tab\\there"', ''].join('\n')
    const rules = parseCheckIgnore(out)
    expect([...rules.keys()]).toEqual(['a.log', 'sub/deep.txt', 'nm', 'x.tmp', 'tab\there'])
    expect(rules.get('a.log')).toEqual({ source: '.gitignore', line: 1, pattern: '*.log' })
    expect(rules.get('nm')).toEqual({ source: '.gitignore', line: 4, pattern: 'nm/' })
    expect(rules.get('x.tmp')).toEqual({ source: 'C:/Users/me/.config/git/ignore', line: 7, pattern: '*.tmp' })
    expect(rules.get('tab\there')?.pattern).toBe('a:b')
  })
})

// ---------------------------------------------------------------------------
// Real git
// ---------------------------------------------------------------------------

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const filesGit = await import('../src/main/filesGit')

const base = tempDir('cw-filesgit-')
const ws = join(base, 'ws')
const w = createWorkspaceService()
w.path = ws
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

let n = 0
let proj = ''
const sh = (...args: string[]): string => execFileSync('git', ['-C', proj, ...args], { encoding: 'utf8' })
const read = (rel: string): string => readFileSync(join(proj, rel), 'utf8')
beforeEach(() => {
  proj = join(ws, `proj${++n}`)
  mkdirSync(join(proj, 'src', 'gen'), { recursive: true })
  execFileSync('git', ['init', '-q', proj])
  sh('config', 'user.email', 'test@example.invalid')
  sh('config', 'user.name', 'Test')
  writeFileSync(join(proj, '.gitignore'), 'node_modules/\r\n')
  writeFileSync(join(proj, 'src', 'a.ts'), 'a')
  writeFileSync(join(proj, 'src', 'gen', 'out.js'), 'o')
  writeFileSync(join(proj, 'debug.log'), 'l')
  sh('add', '.')
  sh('commit', '-q', '-m', 'first')
})

describe('the Git menu on a real repository', () => {
  it('says what git tracks and what it ignores, by which rule', async () => {
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\r\n*.tmp\r\n')
    writeFileSync(join(proj, 'x.tmp'), '')
    const info = await filesGit.gitInfo(proj, [
      { rel: 'src', isDir: true },
      { rel: 'x.tmp', isDir: false },
      { rel: 'new.txt', isDir: false }
    ])
    expect(info.repo).toBe(true)
    expect(info.branch).toBeTruthy()
    expect(info.items.map((i) => [i.rel, i.tracked, i.rule?.pattern ?? null, i.rule?.removable ?? null, i.rule?.file ?? null])).toEqual([
      ['src', true, null, null, null],
      ['x.tmp', false, '*.tmp', 'shared', '.gitignore'],
      ['new.txt', false, null, null, null]
    ])
  })

  it('appends to .gitignore once, keeping its CRLF, and shows as a change', async () => {
    const first = await filesGit.gitExclude(proj, [{ rel: 'src/gen', isDir: true }], 'shared', false)
    expect(first).toMatchObject({ file: '.gitignore', lines: ['/src/gen/'] })
    expect(read('.gitignore')).toBe('node_modules/\r\n/src/gen/\r\n')
    const again = await filesGit.gitExclude(proj, [{ rel: 'src/gen', isDir: true }], 'shared', false)
    expect(again.lines).toEqual([])
    expect(read('.gitignore')).toBe('node_modules/\r\n/src/gen/\r\n')
    expect(sh('status', '--porcelain')).toContain('.gitignore')
    await filesGit.gitExclude(proj, [{ rel: 'debug.log', isDir: false }], 'shared', true)
    expect(read('.gitignore')).toBe('node_modules/\r\n/src/gen/\r\n*.log\r\n')
  })

  it('writes .git/info/exclude for Only on this PC, leaving .gitignore alone', async () => {
    const done = await filesGit.gitExclude(proj, [{ rel: 'notes.md', isDir: false }], 'local', false)
    expect(done.file).toBe('.git/info/exclude')
    expect(read('.git/info/exclude').split(/\r?\n/)).toContain('/notes.md')
    expect(read('.gitignore')).toBe('node_modules/\r\n')
    writeFileSync(join(proj, 'notes.md'), '')
    expect(sh('check-ignore', '-v', 'notes.md')).toMatch(/^\.git\/info\/exclude:\d+:\/notes\.md\tnotes\.md/)
  })

  it('stops tracking a folder with git rm --cached, the files left on disk', async () => {
    const done = await filesGit.gitUntrack(proj, [{ rel: 'src/gen', isDir: true }])
    expect(done.count).toBe(1)
    expect(existsSync(join(proj, 'src', 'gen', 'out.js'))).toBe(true)
    expect(sh('ls-files', 'src/gen')).toBe('')
    expect(sh('status', '--porcelain')).toMatch(/^D {2}src\/gen\/out\.js/m)
    // Nothing tracked is left: nothing done.
    expect((await filesGit.gitUntrack(proj, [{ rel: 'src/gen', isDir: true }])).count).toBe(0)
  })

  it('includes again by removing only its own line', async () => {
    // check-ignore names no rule for a tracked file (git doesn't ignore those): an untracked one.
    writeFileSync(join(proj, 'scratch.log'), '')
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\r\n/scratch.log\r\n*.tmp\r\n')
    const done = await filesGit.gitInclude(proj, [{ rel: 'scratch.log', isDir: false }])
    expect(done.lines).toEqual(['/scratch.log'])
    expect(read('.gitignore')).toBe('node_modules/\r\n*.tmp\r\n')
  })

  it('refuses to include again what a wider rule ignores, and leaves the file', async () => {
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\nsrc/\n')
    await expect(filesGit.gitInclude(proj, [{ rel: 'src/a.ts', isDir: false }])).rejects.toThrow()
    expect(read('.gitignore')).toBe('node_modules/\nsrc/\n')
  })

  it('outside a repository, says so', async () => {
    const plain = join(ws, `plain${++n}`)
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'a.txt'), '')
    expect((await filesGit.gitInfo(plain, [{ rel: 'a.txt', isDir: false }])).repo).toBe(false)
  })

  it('never acts outside the project folder or in .git', async () => {
    await expect(filesGit.gitExclude(proj, [{ rel: '../x', isDir: false }], 'shared', false)).rejects.toThrow()
    await expect(filesGit.gitUntrack(proj, [{ rel: '.git/config', isDir: false }])).rejects.toThrow()
  })
})
