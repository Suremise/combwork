// Relocation's Git implementation (SPEC §16.3.6 port 2's `relocate` capability, HI-2792's R9): what Repair after a moved
// workspace or project (workspaceMove.ts) and a moved .combwork folder's slots (combworkMove.ts) did with git, moved here
// unchanged: each member the exact git command, or the file read of git's links, its caller ran before, so no git command
// is added, dropped or reordered. The worktree listing and a line's existence are the workspace port's own (`list`,
// `lineExists`); the 0.9 helpers it read lines with stay worktrees.ts' (Git's implementation).

import { join, resolve } from 'path'
import { readFile, stat } from 'original-fs/promises'
import { rebase } from '../../shared/movePaths'
import { realPath, samePlace } from '../fsutil'
import { git } from '../git'
import { localBranches } from '../worktrees'
import type { Relocation } from './workspacePort'

const under = (p: string, root: string): boolean => rebase(p, root, root) !== null

export const gitRelocation: Relocation = {
  // Whether a folder is a git worktree's (it has a .git file, not a folder).
  isWorkspaceFolder: async (p) => (await stat(join(p, '.git')).catch(() => null))?.isFile() ?? false,

  // Whether git's links between a repository and one of its worktrees are right both ways (by real paths: git writes the long names, #389).
  async linked(repo, wt) {
    try {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(join(wt, '.git'), 'utf8'))?.[1]?.trim()
      if (!gitdir || !under(realPath(resolve(wt, gitdir)), realPath(join(repo, '.git', 'worktrees')))) return false
      const back = (await readFile(join(resolve(wt, gitdir), 'gitdir'), 'utf8')).trim()
      return samePlace(resolve(back), join(wt, '.git'))
    } catch {
      return false
    }
  },

  // A worktree's identity (#1441): its git administrative folder, as its `.git` file names it (`worktree move` keeps it).
  async identity(folder) {
    const text = await readFile(join(folder, '.git'), 'utf8').catch(() => null)
    const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null
    return m ? resolve(folder, m[1]).toLowerCase() : null
  },

  // combworkMove.ts's repairWorktrees: the folders git lists, resolved, from its porcelain list; null when git can't list them.
  async listedFolders(repo) {
    const r = await git(repo, ['worktree', 'list', '--porcelain'])
    if (!r.ok) return null
    return r.out
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => resolve(l.slice('worktree '.length).trim()))
  },

  localLines: (repo) => localBranches(repo),
  lineRemote: async (repo, line) => (await git(repo, ['config', '--get', `branch.${line}.remote`])).out.trim(),
  move: async (repo, from, to) => {
    const r = await git(repo, ['worktree', 'move', from, to])
    return { ok: r.ok, err: r.err }
  },
  repair: async (repo, folders) => {
    const r = await git(repo, ['worktree', 'repair', ...folders])
    return { ok: r.ok, err: r.err, code: r.code }
  },
  renameLine: async (repo, from, to) => {
    const r = await git(repo, ['branch', '-m', from, to])
    return { ok: r.ok, err: r.err }
  }
}
