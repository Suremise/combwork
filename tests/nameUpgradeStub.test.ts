// HI-2594 (HR1's round 1): the board's stub for older versions (`.combwork/tasks`, #1017) is retired by the names
// upgrade's files step, under the move's lock (nameUpgradeFiles.ts moveOldStub; the lock and the other processes'
// refusal around it are tested in nameUpgrade.test.ts). Its cards are set aside intact, each once; a name taken keeps
// both; only a stub is touched; and a folder that can't be read fails the step rather than reading as empty.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { moveOldStub, SET_ASIDE_DIR } from '../src/main/nameUpgradeFiles'
import { SET_ASIDE } from '../src/main/boardStore'
import { tempDir } from './tempDir'

/** A workspace's `.combwork` with a board and the stub 1.0 left, holding `cards`. */
function withStub(cards: Record<string, string>, o: { readme?: boolean; board?: boolean } = {}): string {
  const dir = join(tempDir('nameupgrade-stub-'), '.combwork')
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  if (o.board !== false) writeFileSync(join(dir, 'combwork.db'), '')
  writeFileSync(join(dir, 'tasks', 'board.json'), '{"version":1,"next":9}')
  if (o.readme !== false) writeFileSync(join(dir, 'tasks', 'README.txt'), 'The task board moved to .hive/hive.db in Hive 0.9 (#1017).\r\n')
  for (const [f, t] of Object.entries(cards)) writeFileSync(join(dir, 'tasks', f), t)
  return dir
}
const aside = (dir: string): string[] => (existsSync(join(dir, SET_ASIDE_DIR)) ? readdirSync(join(dir, SET_ASIDE_DIR)).sort() : [])

describe("the board's stub for older versions, retired by the names upgrade (HI-2594)", () => {
  it('names the folder the board reviews', () => {
    expect(SET_ASIDE_DIR).toBe(SET_ASIDE)
  })

  it('sets each card aside intact, removes the stub, and does nothing the second time', async () => {
    const dir = withStub({ '7.json': '{"title":"seven"}', '8.json': '{ damaged' })
    expect(await moveOldStub(dir)).toBe(2)
    expect(aside(dir)).toEqual(['7.json', '8.json'])
    expect(readFileSync(join(dir, SET_ASIDE_DIR, '8.json'), 'utf8')).toBe('{ damaged')
    expect(existsSync(join(dir, 'tasks'))).toBe(false)
    expect(await moveOldStub(dir)).toBe(0)
    expect(aside(dir)).toEqual(['7.json', '8.json'])
  })

  it('a card set aside already (the same content) is kept once; another under a taken name is kept beside it', async () => {
    const dir = withStub({ '7.json': '{"title":"seven"}', '9.json': '{"title":"nine, edited"}' })
    mkdirSync(join(dir, SET_ASIDE_DIR))
    writeFileSync(join(dir, SET_ASIDE_DIR, '7.json'), '{"title":"seven"}')
    writeFileSync(join(dir, SET_ASIDE_DIR, '9.json'), '{"title":"nine"}')
    expect(await moveOldStub(dir)).toBe(1)
    const files = aside(dir)
    expect(files).toHaveLength(3)
    expect(readFileSync(join(dir, SET_ASIDE_DIR, '9.json'), 'utf8')).toBe('{"title":"nine"}')
    expect(files.filter((f) => !['7.json', '9.json'].includes(f)).map((f) => [/^9\.[0-9TZ-]+-0\.json$/.test(f), readFileSync(join(dir, SET_ASIDE_DIR, f), 'utf8')])).toEqual([[true, '{"title":"nine, edited"}']])
  })

  it("a file of the user's in the stub keeps the folder; the stub's own files and its cards still go", async () => {
    const dir = withStub({ '7.json': '{}', 'notes.txt': 'mine' })
    expect(await moveOldStub(dir)).toBe(1)
    expect(readdirSync(join(dir, 'tasks'))).toEqual(['notes.txt'])
  })

  it('only a stub: without its README (0.8 cards the board imports, or not ours), or with no board, nothing is touched', async () => {
    for (const o of [{ readme: false }, { board: false }]) {
      const dir = withStub({ '7.json': '{}' }, o)
      const before = readdirSync(join(dir, 'tasks')).sort()
      expect(await moveOldStub(dir), JSON.stringify(o)).toBe(0)
      expect(readdirSync(join(dir, 'tasks')).sort()).toEqual(before)
      expect(aside(dir)).toEqual([])
    }
    // No stub at all: nothing.
    expect(await moveOldStub(join(tempDir('nameupgrade-nostub-'), '.combwork'))).toBe(0)
  })

  it("a stub that isn't a folder fails the step (nothing recorded done), rather than reading as empty", async () => {
    const dir = join(tempDir('nameupgrade-stubfile-'), '.combwork')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks'), 'not a folder')
    await expect(moveOldStub(dir)).rejects.toThrow()
  })
})
