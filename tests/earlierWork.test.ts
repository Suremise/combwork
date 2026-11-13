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
import { earlierWork, UNREAD, type EarlierWorkSource } from '../src/main/workflow/earlierWork'
import { earlierWorkText } from '../src/main/workflow/runtime'
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

  it("only lines of a version control left behind whose lines are branches: the one in force and jj's preparation keys are left out", async () => {
    const r = repo()
    expect(await earlierWork(source([started('ahead', 'main', 'rs-git')]), 1, 'git', r)).toEqual([])
    expect(await earlierWork(source([started('jj:cw-x-slot-a/1.1', 'main', 'rs-jj')]), 1, 'git', r)).toEqual([])
    expect(await earlierWork(source([started(null, 'main', 'rs-git')]), 1, 'jj', r)).toEqual([])
    // A later start under the one in force on the same line, or the line the start being made works on: the card's own.
    expect(await earlierWork(source([started('ahead', 'main', 'rs-git'), started('ahead', 'main', 'rs-jj')]), 1, 'jj', r)).toEqual([])
    expect(await earlierWork(source([started('ahead', 'main', 'rs-gone')]), 1, 'jj', r, 'ahead')).toEqual([])
  })

  it("HR2's controls: a start's ruleset unreadable says its line as unknown (its version control unread, never guessed); the card's starts unreadable say so", async () => {
    const r = repo()
    // A real Git branch ahead of main, its start's ruleset failing (EIO): never dropped.
    expect(await earlierWork(source([started('ahead', 'main', 'rs-gone')]), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'main', platform: null, state: 'unknown' }])
    const noRuleset = { ...started('ahead', 'main', 'rs-git'), ruleset: undefined } as unknown as Fact
    expect(await earlierWork(source([noRuleset]), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'main', platform: null, state: 'unknown' }])
    const unread: EarlierWorkSource = {
      facts: () => {
        throw new Error('EIO')
      },
      ruleset: () => ({ options: { platform: 'git' } })
    }
    expect(await earlierWork(unread, 1, 'jj', r)).toEqual([UNREAD])
    // Each said to the builder: the line, or that the starts couldn't be read.
    expect(earlierWorkText('SH-1', { line: 'ahead', target: 'main', platform: null, state: 'unknown' }, 'jj')).toMatch(/SH-1 has earlier work on ahead, from a start whose version control Combwork couldn't read: Combwork couldn't tell/)
    expect(earlierWorkText('SH-1', UNREAD, 'jj')).toMatch(/couldn't read SH-1's earlier starts/)
  })

  it("never says the work is missing from the new start: a new target already holding it (or a kept folder that brought it in) is allowed for", async () => {
    const r = repo()
    // The jj start's target is at the old work's head: its slot has b.txt. The reader still compares with the old target
    // (main), so the line is ahead; the text says the target may hold it by now, and to check before bringing it in.
    g(r, 'branch', 'new-target', 'ahead')
    expect(g(r, 'show', 'new-target:b.txt')).toBe('b')
    const lines = await earlierWork(source([started('ahead', 'main', 'rs-git')]), 1, 'jj', r)
    expect(lines).toEqual([{ line: 'ahead', target: 'main', platform: 'git', state: 'ahead' }])
    const text = earlierWorkText('SH-1', lines[0], 'jj')
    expect(text).toMatch(/from before its project switched to jj: commits its target main doesn't hold/)
    expect(text).toMatch(/this start's target may hold it by now: check whether your folder has it before bringing in what you need/)
    expect(text).not.toMatch(/isn't in the folder|without it|afresh/)
  })

  it('a line started on more than once is read once, against the target its last start recorded', async () => {
    const r = repo()
    const facts = [started('ahead', 'no-such-target', 'rs-git'), started('ahead', 'main', 'rs-git')]
    expect(await earlierWork(source(facts), 1, 'jj', r)).toEqual([{ line: 'ahead', target: 'main', platform: 'git', state: 'ahead' }])
  })
})
