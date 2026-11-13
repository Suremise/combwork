// HI-3107: a card's earlier work on lines of another version control (a Git card put back with commits, its repository
// switched to jj since), read from its recorded starts and through that version control's own ports. Real git; the
// card's facts and rulesets stood in for. Known no-work (gone, or held by its target) is never listed; whatever can't be
// read or proved is listed as `unknown`, never dropped (HR2's design check).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { gitWorkspacePort } from '../src/main/platform/gitWorkspacePort'
import { gitHistory } from '../src/main/platform/gitHistory'
import { earlierWork, type EarlierWorkSource } from '../src/main/workflow/earlierWork'
import type { Fact } from '../src/shared/workflow/facts'

void gitWorkspacePort
void gitHistory

const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A repository: main with one commit; `ahead` one commit past main; `merged` a branch main holds. */
function repo(): string {
  const r = join(tempDir('earlier-'), 'project')
  mkdirSync(r, { recursive: true })
  g(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  g(r, 'add', 'a.txt')
  g(r, 'commit', '-q', '-m', 'one')
  g(r, 'branch', 'merged')
  g(r, 'switch', '-q', '-c', 'ahead')
  writeFileSync(join(r, 'b.txt'), 'b\n')
  g(r, 'add', 'b.txt')
  g(r, 'commit', '-q', '-m', 'work')
  g(r, 'switch', '-q', 'main')
  return r
}

let seq = 0
const started = (line: string | null, target: string | null, ruleset: string): Fact => ({ id: ++seq, card: 1, kind: 'Started', actor: 'user', source: 'recorded', at: new Date().toISOString(), ruleset, data: { folder: 'project', line, base: null, target, builder: 'b', cardKind: 'code' } }) as unknown as Fact

/** A card's facts, with its rulesets by id (`git`, `jj`; any other id unreadable). */
const source = (facts: Fact[]): EarlierWorkSource => ({
  facts: () => facts,
  ruleset: (id) => {
    if (id === 'rs-git') return { options: { platform: 'git' } }
    if (id === 'rs-jj') return { options: { platform: 'jj' } }
    throw new Error(`no ruleset ${id}`)
  }
})

describe('HI-3107: earlier work on lines of another version control', () => {
  it('a Git line with commits its target lacks: ahead; one its target holds, or gone: nothing', async () => {
    const r = repo()
    const facts = [started('ahead', 'main', 'rs-git'), started('merged', 'main', 'rs-git'), started('gone', 'main', 'rs-git')]
    expect(await earlierWork(source(facts), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'main', platform: 'git', state: 'ahead' }])
  })

  it("what can't be read or proved is said as unknown, never dropped: its target gone, its repository unreadable", async () => {
    const r = repo()
    expect(await earlierWork(source([started('ahead', 'no-such-target', 'rs-git')]), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'no-such-target', platform: 'git', state: 'unknown' }])
    expect(await earlierWork(source([started('ahead', null, 'rs-git')]), 1, 'jj', r)).toEqual([{ line: 'ahead', target: null, platform: 'git', state: 'unknown' }])
    const notRepo = tempDir('earlier-none-')
    expect((await earlierWork(source([started('ahead', 'main', 'rs-git')]), 1, 'jj', notRepo)).map((e) => e.state)).toEqual(['unknown'])
  })

  it("only lines of a version control left behind whose lines are branches: the one in force, jj's preparation keys and an unreadable ruleset are left out", async () => {
    const r = repo()
    expect(await earlierWork(source([started('ahead', 'main', 'rs-git')]), 1, 'git', r)).toEqual([])
    expect(await earlierWork(source([started('jj:cw-x-slot-a/1.1', 'main', 'rs-jj')]), 1, 'git', r)).toEqual([])
    expect(await earlierWork(source([started('ahead', 'main', 'rs-gone')]), 1, 'jj', r)).toEqual([])
    expect(await earlierWork(source([started(null, 'main', 'rs-git')]), 1, 'jj', r)).toEqual([])
  })

  it('a line started on more than once is read once, against the target its last start recorded', async () => {
    const r = repo()
    const facts = [started('ahead', 'no-such-target', 'rs-git'), started('ahead', 'main', 'rs-git')]
    expect(await earlierWork(source(facts), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'main', platform: 'git', state: 'ahead' }])
  })
})
