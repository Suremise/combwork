// Worktree branches as hive/<workspace>/<project>/<agent> (#703): git's ref rules for the workspace's and project's parts
// (spaces, odd characters, "..", ".lock", very long names; what comes out is a branch git takes), the agent read from a
// branch in either form (hive/<agent> from before, the full form only for this workspace and project), and the branches
// Add Agent may find an unused worktree on.
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { branchHere, chooseSpace, currentSpaces, hiveBranch, hiveBranchNumber, oldHiveBranch, refPart, reusableBranches } from '../src/shared/hiveBranches'

/** Whether git takes `name` as a branch name. */
const gitTakes = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('the full form', () => {
  const home = { workspace: 'HIVE', project: 'ambrosia' }

  it("is hive/<workspace>/<project>/<agent>: the folders' names as they are, the agent's slug", () => {
    expect(hiveBranch(home, 'AMB1')).toBe('hive/HIVE/ambrosia/amb1')
    expect(hiveBranch({ workspace: 'My Work', project: 'web app' }, 'Builder 2')).toBe('hive/My-Work/web-app/builder-2')
    expect(oldHiveBranch('AMB1')).toBe('hive/amb1')
  })

  it("applies git's ref rules to the workspace's and project's parts, so git always takes the branch", () => {
    const odd = ['a b', 'a..b', 'x.lock', '.hidden', 'trailing.', 'tilde~caret^colon:', 'q?star*[br', 'back\\slash', 'at@{x}', '@', '---', '...', 'Ümlaut café', 'emoji 🐝', 'tab\there', 'x'.repeat(200), 'a.lock.lock', '-lead', 'end-']
    for (const name of odd) {
      const part = refPart(name, 'workspace')
      expect(part.length).toBeGreaterThan(0)
      expect(part.length).toBeLessThanOrEqual(40)
      expect(part).not.toMatch(/\.\.|^[.-]|[.-]$|\.lock$|[\s~^:?*[\\@{}]/i)
      expect(gitTakes(hiveBranch({ workspace: name, project: name }, name))).toBe(true)
    }
    expect([refPart('a..b', 'w'), refPart('x.lock', 'w'), refPart('a.lock.lock', 'w'), refPart('---', 'w'), refPart('Ümlaut café', 'w')]).toEqual(['a.b', 'x', 'a', 'w', 'mlaut-caf'])
  })
})

describe("a branch Combwork made for an agent", () => {
  const home = { workspace: 'HIVE', project: 'ambrosia' }

  it('is recognised in either form: hive/<slug> from before as Combwork made it, and the full form here, case aside', () => {
    expect(hiveBranchNumber('hive/amb1', home, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/amb1-2', home, 'AMB1')).toBe(2)
    expect(hiveBranchNumber('hive/HIVE/ambrosia/amb1', home, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/hive/Ambrosia/amb1-3', home, 'amb1')).toBe(3)
    // In a workspace part Combwork gave this project (recorded): this project's; one that only looks numbered isn't (round 3:
    // another workspace may be called HIVE-2).
    expect(hiveBranchNumber('hive/HIVE-2/ambrosia/amb1', { ...home, spaces: ['HIVE-2'] }, 'AMB1')).toBe(0)
    expect(hiveBranchNumber('hive/HIVE-2/ambrosia/amb1', home, 'AMB1')).toBeNull()
    expect(hiveBranchNumber('hive/My-Work/web-app/b1', { workspace: 'My Work', project: 'web app' }, 'B1')).toBe(0)
  })

  it("from before, by its slug exactly as Combwork made it then: B--1 had hive/b--1 (round 2: not the new rules' b-1)", () => {
    expect(oldHiveBranch('B--1')).toBe('hive/b--1')
    expect(hiveBranchNumber('hive/b--1', home, 'B--1')).toBe(0)
    expect(hiveBranchNumber('hive/b--1-2', home, 'B--1')).toBe(2)
    expect(hiveBranchNumber('hive/b-1', home, 'B--1')).toBeNull()
    // The full form uses the new rules: B--1's part is b-1.
    expect(hiveBranch(home, 'B--1')).toBe('hive/HIVE/ambrosia/b-1')
    expect(hiveBranchNumber('hive/HIVE/ambrosia/b-1', home, 'B--1')).toBe(0)
  })

  it("isn't another agent's, another workspace's or project's (two workspaces in one repository), or a branch not Combwork's", () => {
    for (const b of ['hive/OTHER/ambrosia/amb1', 'hive/HIVE/other/amb1', 'hive/HIVEX/ambrosia/amb1', 'feature/amb1', 'hive/HIVE/amb1', 'hive/a/b/c/d', 'main', 'hive', 'hive/amb10', 'hive/HIVE/ambrosia/amb1-x']) expect(hiveBranchNumber(b, home, 'AMB1')).toBeNull()
  })

  it("Add Agent's new worktree on an agent's full-form branch may find the branch Combwork made for that name before; any other only itself", () => {
    expect(reusableBranches('hive/HIVE/ambrosia/amb1', home, 'AMB1')).toEqual(['hive/HIVE/ambrosia/amb1', 'hive/amb1'])
    expect(reusableBranches('hive/HIVE/ambrosia/b-1', home, 'B--1')).toEqual(['hive/HIVE/ambrosia/b-1', 'hive/b--1'])
    // Without the name, or for another agent's or workspace's branch: only itself.
    expect(reusableBranches('hive/HIVE/ambrosia/amb1', home)).toEqual(['hive/HIVE/ambrosia/amb1'])
    expect(reusableBranches('hive/HIVE/ambrosia/amb2', home, 'AMB1')).toEqual(['hive/HIVE/ambrosia/amb2'])
    expect(reusableBranches('hive/OTHER/ambrosia/amb1', home, 'AMB1')).toEqual(['hive/OTHER/ambrosia/amb1'])
    expect(reusableBranches('feature/x', home, 'X')).toEqual(['feature/x'])
    // With a recorded part: the same agent's branch in each of the project's own parts, the current one first, then before #703.
    expect(reusableBranches('hive/HIVE-2/ambrosia/amb1', { ...home, spaces: ['HIVE-2'] }, 'AMB1')).toEqual(['hive/HIVE-2/ambrosia/amb1', 'hive/HIVE/ambrosia/amb1', 'hive/amb1'])
    expect(reusableBranches('hive/HIVE-2/ambrosia/amb1', home, 'AMB1')).toEqual(['hive/HIVE-2/ambrosia/amb1'])
  })
})

describe('the workspace part for new branches (#703 rounds 2 and 3)', () => {
  const home = { workspace: 'ws', project: 'alpha' }
  it("is the workspace's own, unless hive/<workspace> or hive/<workspace>/<project> is a branch (case aside): then a new numbered one", () => {
    expect(chooseSpace(home, ['main', 'hive/b1', 'hive/ws/alpha/b1'])).toEqual({ space: 'ws', isNew: false })
    expect(chooseSpace(home, ['main', 'hive/ws'])).toEqual({ space: 'ws-2', isNew: true })
    expect(chooseSpace(home, ['hive/WS', 'hive/ws-2/alpha'])).toEqual({ space: 'ws-3', isNew: true })
    expect(chooseSpace({ workspace: 'HIVE', project: 'ambrosia' }, ['hive/hive'])).toEqual({ space: 'HIVE-2', isNew: true })
    expect(hiveBranch({ ...home, space: chooseSpace(home, ['hive/ws']).space }, 'New')).toBe('hive/ws-2/alpha/new')
  })

  it("never a new one another workspace of that name uses in the repository (round 3: a workspace called ws-2)", () => {
    expect(chooseSpace(home, ['hive/ws', 'hive/ws-2/alpha/foreign'])).toEqual({ space: 'ws-3', isNew: true })
    // Its project only: ws-2's other projects' branches don't stand in the way.
    expect(chooseSpace(home, ['hive/ws', 'hive/ws-2/beta/x'])).toEqual({ space: 'ws-2', isNew: true })
  })

  it('stays where it moved to (round 3): the recorded part while it is clear, even once the branch in the way has gone', () => {
    const moved = { ...home, spaces: ['ws-2'] }
    expect(chooseSpace(moved, ['hive/ws'])).toEqual({ space: 'ws-2', isNew: false })
    expect(chooseSpace(moved, ['main'])).toEqual({ space: 'ws-2', isNew: false })
    // Its own again, if the recorded one is blocked; a further one only when both are.
    expect(chooseSpace(moved, ['hive/ws-2'])).toEqual({ space: 'ws', isNew: false })
    expect(chooseSpace(moved, ['hive/ws-2', 'hive/ws'])).toEqual({ space: 'ws-3', isNew: true })
  })
})

describe('a branch named after where its project was (branchHere, #1305)', () => {
  const tools = { workspace: 'Tools', project: 'dialect', space: 'Tools' }
  it('a moved and renamed project: both parts follow, the agent part stays', () => {
    expect(branchHere('hive/Scratch/juniper/jb1', tools)).toBe('hive/Tools/dialect/jb1')
    expect(branchHere('hive/Scratch/juniper/jb1-2', tools)).toBe('hive/Tools/dialect/jb1-2')
  })
  it('only the workspace moved, or only the project renamed: that part follows', () => {
    expect(branchHere('hive/Scratch/dialect/db1', tools)).toBe('hive/Tools/dialect/db1')
    expect(branchHere('hive/Tools/juniper/jb1', tools)).toBe('hive/Tools/dialect/jb1')
  })
  it('the workspace part its new branches take now (chooseSpace), when another', () => {
    expect(branchHere('hive/Scratch/dialect/db1', { ...tools, space: 'Tools-2', spaces: ['Tools-2'] })).toBe('hive/Tools-2/dialect/db1')
  })
  it("already named for here (case aside), or in one of this project's recorded parts: kept", () => {
    expect(branchHere('hive/Tools/dialect/db1', tools)).toBeNull()
    expect(branchHere('hive/tools/DIALECT/db1', tools)).toBeNull()
    expect(branchHere('hive/Tools-2/dialect/db1', { ...tools, spaces: ['Tools-2'] })).toBeNull()
  })
  it("not Combwork's full form: kept (hive/<agent> from before #703, a branch of the user's)", () => {
    expect(branchHere('hive/db1', tools)).toBeNull()
    expect(branchHere('feature/login', tools)).toBeNull()
    expect(branchHere('hive/a/b/c/d', tools)).toBeNull()
  })
  it("a folder name git refuses is made a ref part, as Combwork's branches are", () => {
    expect(branchHere('hive/Scratch/juniper/jb1', { workspace: 'My Tools', project: 'dialect' })).toBe('hive/My-Tools/dialect/jb1')
  })
})

describe('a workspace part recorded under an old name (#1305, HR5 round 1)', () => {
  // Scratch had a branch in the way, so its project's branches took Scratch-2 (recorded); the workspace is now Tools.
  const moved = { workspace: 'Tools', project: 'juniper', spaces: ['Scratch-2'] }
  it('is still the project’s, but no longer a name for here', () => {
    expect(currentSpaces(moved)).toEqual(['Tools'])
    expect(currentSpaces({ workspace: 'Tools', project: 'juniper', spaces: ['Scratch-2', 'Tools-2'] })).toEqual(['Tools', 'Tools-2'])
  })
  it('new branches take the workspace’s own part, not the old recorded one', () => {
    expect(chooseSpace(moved, [])).toEqual({ space: 'Tools', isNew: false })
    expect(chooseSpace({ ...moved, spaces: ['Scratch-2', 'Tools-2'] }, [])).toEqual({ space: 'Tools-2', isNew: false })
  })
  it('a branch in it is renamed to the part new branches take now', () => {
    const space = chooseSpace(moved, []).space
    expect(branchHere('hive/Scratch-2/juniper/jb1', { ...moved, space })).toBe('hive/Tools/juniper/jb1')
    // Blocked (a branch hive/Tools there): the next free one, as new branches would.
    const blocked = chooseSpace(moved, ['hive/Tools'])
    expect(blocked).toEqual({ space: 'Tools-2', isNew: true })
    expect(branchHere('hive/Scratch-2/juniper/jb1', { ...moved, space: blocked.space })).toBe('hive/Tools-2/juniper/jb1')
  })
  it('one recorded for the workspace as it is now stays as it is', () => {
    expect(branchHere('hive/Tools-2/juniper/jb1', { workspace: 'Tools', project: 'juniper', spaces: ['Tools-2'], space: 'Tools-2' })).toBeNull()
  })
})
