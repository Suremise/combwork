// The commands Waiting shows to integrate a passed jj card by hand (HI-3094, from HI-3058's hunt): run as the window
// shows them (`integrateCommands`, the same function) on a card of two commits, the target holds the whole card and it
// counts as integrated. Before, the copy named only the reviewed commit, and the target got its last commit alone.
// The real-jj cases are skipped without the fetched jj (npm run jj:fetch).

import { writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { gitHistory } from '../src/main/platform/gitHistory'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { integrateCommands } from '../src/shared/jjViews'
import { harness, jjExe } from './jjWorkspaceHarness'

describe('integrateCommands (HI-3094)', () => {
  it('copies the card from its base to the reviewed commit, then moves the target to the copy given', () => {
    expect(integrateCommands({ base: 'b0', revision: 'r9', target: 'main' }, '<copy of r9>')).toEqual(['jj duplicate -r b0..r9 --onto main', 'jj bookmark set main -r <copy of r9>'])
  })
})

describe.skipIf(!jjExe)('the integrate commands on a card of two commits (HI-3094)', { timeout: 120_000 }, () => {
  it.each([true, false])('the target holds the whole card and it counts as integrated (colocated: %s)', async (colocated) => {
    const h = harness()
    const { repo, base } = h.repo(`intg${colocated ? 'c' : 'n'}`, colocated)
    const top = resolve(repo, '..')
    // The target moves on after the card's base.
    h.jj(repo, 'new', 'main')
    writeFileSync(join(repo, 't.txt'), 'target\n')
    h.jj(repo, 'commit', '-m', 'target')
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@-')
    // The card: two commits on its base, in its own workspace (its slot).
    const slot = join(top, 'builder')
    h.jj(repo, 'workspace', 'add', slot, '--name', 'builder', '-r', base, colocated ? '--colocate' : '--no-colocate')
    writeFileSync(join(slot, 'k1.txt'), 'first commit of the card\n')
    h.jj(slot, 'commit', '-m', 'card: part 1')
    writeFileSync(join(slot, 'k2.txt'), 'second commit of the card\n')
    h.jj(slot, 'commit', '-m', 'card: part 2')
    const R = h.id(slot, 'builder@-')
    const read = (...args: string[]): string => h.jj(repo, '--ignore-working-copy', ...args)
    // The window's commands, word for word: the copy, then the bookmark moved to the reviewed commit's copy.
    const [dup] = integrateCommands({ base, revision: R, target: 'main' }, '<copy>')
    h.jj(repo, ...dup.split(' ').slice(1))
    const copy = read('log', '--no-graph', '-r', `main:: & description(substring:"card: part 2") & ~${R}`, '-T', 'commit_id')
    const [, set] = integrateCommands({ base, revision: R, target: 'main' }, copy)
    h.jj(repo, ...set.split(' ').slice(1))
    const files = read('file', 'list', '-r', 'main').split(/\r?\n/).filter(Boolean).sort()
    expect(files).toEqual(expect.arrayContaining(['k1.txt', 'k2.txt', 't.txt']))
    // Its change applied again in the target: the card counts as integrated (Combwork's own proof).
    const d = await jjContextOf(repo, h.runner)
    if (!('jj' in d)) throw new Error('not detected')
    expect(await gitHistory.contains(d.jj.store, 'main', { base, revision: R }, h.id(repo, 'main'))).not.toBeNull()
  })
})
