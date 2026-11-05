// Worktree branches as cw/<workspace>/<project>/<agent> (#703, HI-2593): git's ref rules for the workspace's and
// project's parts (spaces, odd characters, "..", ".lock", very long names; what comes out is a branch git takes), the
// agent read from a branch (the full form only, for this workspace and project; nothing under the name Combwork had before
// 1.1), and the branches Add Agent may find an unused worktree on.
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { agentBranch, agentBranchNumber, BRANCH_PREFIX, branchHere, chooseSpace, currentSpaces, refPart, reusableBranches } from '../src/shared/agentBranches'

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
  const home = { workspace: 'Work', project: 'ambrosia' }

  it("is cw/<workspace>/<project>/<agent>: the folders' names as they are, the agent's slug", () => {
    expect(agentBranch(home, 'AMB1')).toBe('cw/Work/ambrosia/amb1')
    expect(agentBranch({ workspace: 'My Work', project: 'web app' }, 'Builder 2')).toBe('cw/My-Work/web-app/builder-2')
    expect(BRANCH_PREFIX).toBe('cw')
  })

  it("applies git's ref rules to the workspace's and project's parts, so git always takes the branch", () => {
    const odd = ['a b', 'a..b', 'x.lock', '.hidden', 'trailing.', 'tilde~caret^colon:', 'q?star*[br', 'back\\slash', 'at@{x}', '@', '---', '...', 'Ümlaut café', 'emoji 🐝', 'tab\there', 'x'.repeat(200), 'a.lock.lock', '-lead', 'end-']
    for (const name of odd) {
      const part = refPart(name, 'workspace')
      expect(part.length).toBeGreaterThan(0)
      expect(part.length).toBeLessThanOrEqual(40)
      expect(part).not.toMatch(/\.\.|^[.-]|[.-]$|\.lock$|[\s~^:?*[\\@{}]/i)
      expect(gitTakes(agentBranch({ workspace: name, project: name }, name))).toBe(true)
    }
    expect([refPart('a..b', 'w'), refPart('x.lock', 'w'), refPart('a.lock.lock', 'w'), refPart('---', 'w'), refPart('Ümlaut café', 'w')]).toEqual(['a.b', 'x', 'a', 'w', 'mlaut-caf'])
  })
})

describe("a branch Combwork made for an agent", () => {
  const home = { workspace: 'Work', project: 'ambrosia' }

  it('is recognised in the full form here, case aside', () => {
    expect(agentBranchNumber('cw/Work/ambrosia/amb1', home, 'AMB1')).toBe(0)
    expect(agentBranchNumber('cw/work/Ambrosia/amb1-3', home, 'amb1')).toBe(3)
    // In a workspace part Combwork gave this project (recorded): this project's; one that only looks numbered isn't (round 3:
    // another workspace may be called Work-2).
    expect(agentBranchNumber('cw/Work-2/ambrosia/amb1', { ...home, spaces: ['Work-2'] }, 'AMB1')).toBe(0)
    expect(agentBranchNumber('cw/Work-2/ambrosia/amb1', home, 'AMB1')).toBeNull()
    expect(agentBranchNumber('cw/My-Work/web-app/b1', { workspace: 'My Work', project: 'web app' }, 'B1')).toBe(0)
  })

  it("isn't a short form, nor any branch under the name Combwork had before 1.1 (HI-2593: nothing recognises those)", () => {
    for (const b of ['cw/amb1', 'cw/amb1-2', 'hive/amb1', 'hive/Work/ambrosia/amb1', 'hive/Work/ambrosia/amb1-2']) expect(agentBranchNumber(b, home, 'AMB1')).toBeNull()
    expect(reusableBranches('hive/Work/ambrosia/amb1', home, 'AMB1')).toEqual(['hive/Work/ambrosia/amb1'])
    expect(branchHere('hive/Scratch/ambrosia/amb1', home)).toBeNull()
    // The full form's agent part follows git's rules: B--1's part is b-1.
    expect(agentBranch(home, 'B--1')).toBe('cw/Work/ambrosia/b-1')
    expect(agentBranchNumber('cw/Work/ambrosia/b-1', home, 'B--1')).toBe(0)
  })

  it("isn't another agent's, another workspace's or project's (two workspaces in one repository), or a branch not Combwork's", () => {
    for (const b of ['cw/OTHER/ambrosia/amb1', 'cw/Work/other/amb1', 'cw/WorkX/ambrosia/amb1', 'feature/amb1', 'cw/Work/amb1', 'cw/a/b/c/d', 'main', 'hive', 'cw/amb10', 'cw/Work/ambrosia/amb1-x']) expect(agentBranchNumber(b, home, 'AMB1')).toBeNull()
  })

  it("Add Agent's new worktree on an agent's own branch finds only that branch without recorded parts; any other only itself", () => {
    expect(reusableBranches('cw/Work/ambrosia/amb1', home, 'AMB1')).toEqual(['cw/Work/ambrosia/amb1'])
    expect(reusableBranches('cw/Work/ambrosia/b-1', home, 'B--1')).toEqual(['cw/Work/ambrosia/b-1'])
    // Without the name, or for another agent's or workspace's branch: only itself.
    expect(reusableBranches('cw/Work/ambrosia/amb1', home)).toEqual(['cw/Work/ambrosia/amb1'])
    expect(reusableBranches('cw/Work/ambrosia/amb2', home, 'AMB1')).toEqual(['cw/Work/ambrosia/amb2'])
    expect(reusableBranches('cw/OTHER/ambrosia/amb1', home, 'AMB1')).toEqual(['cw/OTHER/ambrosia/amb1'])
    expect(reusableBranches('feature/x', home, 'X')).toEqual(['feature/x'])
    // With a recorded part: the same agent's branch in each of the project's own parts, the current one first.
    expect(reusableBranches('cw/Work-2/ambrosia/amb1', { ...home, spaces: ['Work-2'] }, 'AMB1')).toEqual(['cw/Work-2/ambrosia/amb1', 'cw/Work/ambrosia/amb1'])
    expect(reusableBranches('cw/Work-2/ambrosia/amb1', home, 'AMB1')).toEqual(['cw/Work-2/ambrosia/amb1'])
  })
})

describe('the workspace part for new branches (#703 rounds 2 and 3)', () => {
  const home = { workspace: 'ws', project: 'alpha' }
  it("is the workspace's own, unless cw/<workspace> or cw/<workspace>/<project> is a branch (case aside): then a new numbered one", () => {
    expect(chooseSpace(home, ['main', 'cw/b1', 'cw/ws/alpha/b1'])).toEqual({ space: 'ws', isNew: false })
    expect(chooseSpace(home, ['main', 'cw/ws'])).toEqual({ space: 'ws-2', isNew: true })
    expect(chooseSpace(home, ['cw/WS', 'cw/ws-2/alpha'])).toEqual({ space: 'ws-3', isNew: true })
    expect(chooseSpace({ workspace: 'Work', project: 'ambrosia' }, ['cw/work'])).toEqual({ space: 'Work-2', isNew: true })
    expect(agentBranch({ ...home, space: chooseSpace(home, ['cw/ws']).space }, 'New')).toBe('cw/ws-2/alpha/new')
  })

  it("never a new one another workspace of that name uses in the repository (round 3: a workspace called ws-2)", () => {
    expect(chooseSpace(home, ['cw/ws', 'cw/ws-2/alpha/foreign'])).toEqual({ space: 'ws-3', isNew: true })
    // Its project only: ws-2's other projects' branches don't stand in the way.
    expect(chooseSpace(home, ['cw/ws', 'cw/ws-2/beta/x'])).toEqual({ space: 'ws-2', isNew: true })
  })

  it('stays where it moved to (round 3): the recorded part while it is clear, even once the branch in the way has gone', () => {
    const moved = { ...home, spaces: ['ws-2'] }
    expect(chooseSpace(moved, ['cw/ws'])).toEqual({ space: 'ws-2', isNew: false })
    expect(chooseSpace(moved, ['main'])).toEqual({ space: 'ws-2', isNew: false })
    // Its own again, if the recorded one is blocked; a further one only when both are.
    expect(chooseSpace(moved, ['cw/ws-2'])).toEqual({ space: 'ws', isNew: false })
    expect(chooseSpace(moved, ['cw/ws-2', 'cw/ws'])).toEqual({ space: 'ws-3', isNew: true })
  })
})

describe('a branch named after where its project was (branchHere, #1305)', () => {
  const tools = { workspace: 'Tools', project: 'dialect', space: 'Tools' }
  it('a moved and renamed project: both parts follow, the agent part stays', () => {
    expect(branchHere('cw/Scratch/juniper/jb1', tools)).toBe('cw/Tools/dialect/jb1')
    expect(branchHere('cw/Scratch/juniper/jb1-2', tools)).toBe('cw/Tools/dialect/jb1-2')
  })
  it('only the workspace moved, or only the project renamed: that part follows', () => {
    expect(branchHere('cw/Scratch/dialect/db1', tools)).toBe('cw/Tools/dialect/db1')
    expect(branchHere('cw/Tools/juniper/jb1', tools)).toBe('cw/Tools/dialect/jb1')
  })
  it('the workspace part its new branches take now (chooseSpace), when another', () => {
    expect(branchHere('cw/Scratch/dialect/db1', { ...tools, space: 'Tools-2', spaces: ['Tools-2'] })).toBe('cw/Tools-2/dialect/db1')
  })
  it("already named for here (case aside), or in one of this project's recorded parts: kept", () => {
    expect(branchHere('cw/Tools/dialect/db1', tools)).toBeNull()
    expect(branchHere('cw/tools/DIALECT/db1', tools)).toBeNull()
    expect(branchHere('cw/Tools-2/dialect/db1', { ...tools, spaces: ['Tools-2'] })).toBeNull()
  })
  it("not Combwork's full form: kept (a short form, a branch of the user's, one under its name before 1.1)", () => {
    expect(branchHere('cw/db1', tools)).toBeNull()
    expect(branchHere('hive/Scratch/juniper/jb1', tools)).toBeNull()
    expect(branchHere('feature/login', tools)).toBeNull()
    expect(branchHere('cw/a/b/c/d', tools)).toBeNull()
  })
  it("a folder name git refuses is made a ref part, as Combwork's branches are", () => {
    expect(branchHere('cw/Scratch/juniper/jb1', { workspace: 'My Tools', project: 'dialect' })).toBe('cw/My-Tools/dialect/jb1')
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
    expect(branchHere('cw/Scratch-2/juniper/jb1', { ...moved, space })).toBe('cw/Tools/juniper/jb1')
    // Blocked (a branch cw/Tools there): the next free one, as new branches would.
    const blocked = chooseSpace(moved, ['cw/Tools'])
    expect(blocked).toEqual({ space: 'Tools-2', isNew: true })
    expect(branchHere('cw/Scratch-2/juniper/jb1', { ...moved, space: blocked.space })).toBe('cw/Tools-2/juniper/jb1')
  })
  it('one recorded for the workspace as it is now stays as it is', () => {
    expect(branchHere('cw/Tools-2/juniper/jb1', { workspace: 'Tools', project: 'juniper', spaces: ['Tools-2'], space: 'Tools-2' })).toBeNull()
  })
})
