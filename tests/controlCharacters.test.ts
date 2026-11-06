// No source file has a control character other than tab, CR and LF (#1040). One can't be seen in an editor or a diff:
// a stray backspace in a regex hid a dead branch for months (#1023), and an ESC in board.cjs matched only by luck of
// being typed literally. Write them as escapes (\x1b, \b). Source files only: text such as a licence keeps its form
// feeds. New files not ignored count too, so one fails before it's committed.
import { execFileSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')

/** Source files: code and styles, by extension. */
const SOURCE = /\.(?:[cm]?[jt]sx?|css|html)$/i

/** Each control character in a source file of `repo` (tracked, or new and not ignored), as path:line:column and its code. */
function controlCharacters(repo: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: repo, env: baseEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const found: string[] = []
  for (const path of listed.split('\0')) {
    if (!SOURCE.test(path)) continue
    let text: string
    try {
      text = readFileSync(join(repo, path), 'utf8')
    } catch {
      continue // tracked but deleted in the working tree
    }
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g)) found.push(`${path}:${i + 1}:${m.index + 1} U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    })
  }
  return found.sort()
}

describe('control characters (#1040)', () => {
  it('no source file in the repository has one other than tab, CR and LF', () => {
    expect(controlCharacters(root)).toEqual([])
  })

  it('finds one in a source file, tracked or new, and passes tabs, line endings, escapes and other text files', () => {
    const repo = tempDir('cw-ctrl-')
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(repo, 'esc.cjs'), "const ok = 1\nx.replace(/\x1b\\[[0-9;]*m/g, '')\n")
      writeFileSync(join(repo, 'clean.ts'), "\tconst re = /\\x1b\\[/\r\nconst b = '\\b'\r\n")
      writeFileSync(join(repo, 'licence.txt'), 'page one\fpage two\n')
      git('add', 'esc.cjs', 'clean.ts', 'licence.txt')
      writeFileSync(join(repo, '.gitignore'), 'ignored.ts\n')
      writeFileSync(join(repo, 'ignored.ts'), 'a\bb\n')
      // new.mts is new and not ignored, the rest tracked.
      writeFileSync(join(repo, 'new.mts'), "const s = 'a\x7fb'\n")
      expect(controlCharacters(repo)).toEqual(['esc.cjs:2:12 U+001B', 'new.mts:1:13 U+007F'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
