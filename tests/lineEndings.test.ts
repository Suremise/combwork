// No text file has mixed line endings (#149). .gitattributes has git store text as LF (`* text=auto`) and leaves the
// working tree's ending to each machine, so a checkout is all CRLF or all LF; an edit that writes LF lines into a CRLF
// file (#136's app.css) makes it mixed. This passes whichever ending a machine checks out: it forbids only mixing, and a
// lone CR (git takes a file with one for binary, so the policy can't normalise it). New files not ignored count too, so
// a mixed one fails before it's committed.
import { execFileSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')

/** Each text file in `repo` (tracked, or new and not ignored) with mixed line endings or a lone CR, with its counts. */
function lineEndingProblems(repo: string): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--eol', '-co', '--exclude-standard'], { cwd: repo, env: baseEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const problems: string[] = []
  for (const entry of listed.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    // `attr/-text`: marked binary (or -text) in .gitattributes.
    if (/\battr\/-text\b/.test(entry.slice(0, tab))) continue
    const path = entry.slice(tab + 1)
    let bytes: Buffer
    try {
      bytes = readFileSync(join(repo, path))
    } catch {
      continue // tracked but deleted in the working tree
    }
    if (bytes.includes(0)) continue // binary content
    let crlf = 0
    let lf = 0
    let cr = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a) lf++
      else if (bytes[i] === 0x0d) {
        if (bytes[i + 1] === 0x0a) {
          crlf++
          i++
        } else cr++
      }
    }
    if ((crlf && lf) || cr) problems.push(`${path}: ${crlf} CRLF, ${lf} LF, ${cr} lone CR`)
  }
  return problems.sort()
}

describe('line endings (#149)', () => {
  it('no text file in the repository mixes them', () => {
    expect(lineEndingProblems(root)).toEqual([])
  })

  it('finds a mixed file or a lone CR, and passes all-CRLF, all-LF and binary files', () => {
    const repo = tempDir('cw-eol-')
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd: repo, env: baseEnv(), encoding: 'utf8' })
      git('init', '-q')
      writeFileSync(join(repo, '.gitattributes'), '* text=auto\n*.png binary\n')
      writeFileSync(join(repo, 'crlf.ts'), 'a\r\nb\r\n')
      writeFileSync(join(repo, 'lf.ts'), 'a\nb\n')
      writeFileSync(join(repo, 'mixed.css'), 'a\r\nb\nc\r\n')
      writeFileSync(join(repo, 'lonecr.mjs'), 'a\r\r\nb\r\n')
      writeFileSync(join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d]))
      git('add', '.gitattributes', 'crlf.ts', 'lf.ts', 'mixed.css', 'image.png')
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(repo, 'ignored.txt'), 'a\r\nb\n')
      // lonecr.mjs is new and not ignored, the rest tracked.
      expect(lineEndingProblems(repo)).toEqual(['lonecr.mjs: 2 CRLF, 0 LF, 1 lone CR', 'mixed.css: 2 CRLF, 1 LF, 0 lone CR'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
