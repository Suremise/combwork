// The merge checks' bracket (queueChecks.ts, #1349, #1386) on a real temporary repository: a check counts only when
// nothing changed the folder, the end snapshots the files tracked at the start, and a start whose tracked files git
// couldn't list proves nothing (HR5's #1386 round 1: an unread list taken as empty let a restored edit count).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { gitRepo, sh } from './harness'
import { bracketEnd, bracketStart } from '../../src/main/workflow/queueChecks'

// git's `ls-files` refused once, as an index git can't open would.
const fault = vi.hoisted(() => ({ lsFiles: 0 }))
vi.mock('../../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/git')>()
  return {
    ...real,
    git: (...args: Parameters<typeof real.git>) => {
      if (fault.lsFiles > 0 && args[1][0] === 'ls-files') {
        fault.lsFiles--
        return Promise.resolve({ ok: false, code: 128, out: '', buf: Buffer.alloc(0), err: 'fatal: index file open failed' })
      }
      return real.git(...args)
    }
  }
})

afterEach(() => {
  fault.lsFiles = 0
})

/** A check that writes a tracked file and puts its content back, its time moved on (an edit undone). */
function editAndRestore(repo: string): void {
  const file = join(repo, 'src/a.txt')
  const content = readFileSync(file)
  const s = statSync(file)
  writeFileSync(file, 'an edit\n')
  writeFileSync(file, content)
  utimesSync(file, s.atime, new Date(s.mtimeMs + 10_000))
  expect(sh(repo, 'status', '--porcelain')).toBe('')
}

describe("the merge checks' bracket", () => {
  it('a check that touches nothing counts', async () => {
    const repo = gitRepo(join(tempDir('queue-bracket-'), 'r'))
    const head = sh(repo, 'rev-parse', 'HEAD')
    const start = await bracketStart(repo)
    expect(await bracketEnd(repo, head, start)).toEqual({ counted: true, tested: head })
  })

  it('an edit undone during the check proves nothing (changed)', async () => {
    const repo = gitRepo(join(tempDir('queue-bracket-'), 'r'))
    const head = sh(repo, 'rev-parse', 'HEAD')
    const start = await bracketStart(repo)
    editAndRestore(repo)
    expect(await bracketEnd(repo, head, start)).toMatchObject({ counted: false, whyNot: 'changed' })
  })

  it("a start whose tracked files git couldn't list proves nothing, even with the folder clean and HEAD where it was", async () => {
    const repo = gitRepo(join(tempDir('queue-bracket-'), 'r'))
    const head = sh(repo, 'rev-parse', 'HEAD')
    fault.lsFiles = 1
    const start = await bracketStart(repo)
    expect(fault.lsFiles).toBe(0)
    expect(start.files).toBeNull()
    editAndRestore(repo)
    expect(await bracketEnd(repo, head, start)).toMatchObject({ counted: false, whyNot: 'changed' })
  })
})
