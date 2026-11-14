// The jj-plain-git scenario's detector (HI-2800; tests/scenarios/gitMutations.cjs): which git commands in an agent's shell
// calls change HEAD, the index, a branch or a ref, and which are reads. Its failure is fixed here, never with a model run
// (AGENTS.md).
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { gitMutations, gitMutationsIn } = require('./scenarios/gitMutations.cjs') as { gitMutations: (o: { tools: { name: string; input: string }[] }) => string[]; gitMutationsIn: (text: string) => string[] }

describe('git commands that move HEAD, the index, a branch or a ref', () => {
  it('counts each mutating command, in any form', () => {
    for (const cmd of [
      'git add -A',
      'git add math.js && git commit -m "Fix add"',
      'git commit -am fix',
      'git reset --hard HEAD~1',
      'git restore --staged math.js',
      'git rebase main',
      'git merge feature',
      'git cherry-pick abc123',
      'git checkout -b fix',
      'git checkout -- math.js',
      'git switch main',
      'git stash',
      'git stash push -m wip',
      'git branch fix',
      'git branch -D old',
      'git tag v1',
      'git tag -d v1',
      'git update-ref refs/heads/x HEAD',
      'git symbolic-ref HEAD refs/heads/x',
      'git update-index --assume-unchanged a',
      'git worktree add ../x',
      'git pull',
      'git fetch origin',
      'git apply --index p.diff',
      'git rm --cached a',
      'git mv a b',
      'git -C D:\\work\\alpha commit -m x',
      'git --git-dir=.git --work-tree=. add a',
      'git -c user.name=x -c user.email=y commit -m x',
      '& git.exe commit -m x',
      '"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x',
      'cd alpha; git commit -m x',
      'git remote add origin u'
    ])
      expect(gitMutationsIn(cmd), cmd).not.toEqual([])
  })

  it('leaves reads and working-tree-only commands alone', () => {
    for (const cmd of ['git status', 'git status --short', 'git log --oneline -5', 'git diff', 'git diff --cached', 'git show HEAD', 'git branch', 'git branch --list', 'git branch -a -v', 'git branch --show-current', 'git tag', 'git tag -l', 'git restore math.js', 'git stash list', 'git rev-parse HEAD', 'git config user.name', 'git remote -v', 'jj commit -m "Fix add"', 'jj describe -m x && jj new', 'jj git push', 'echo git commit', 'node -e "1"'])
      expect(gitMutationsIn(cmd), cmd).toEqual([])
  })

  it("reads only shell tools' calls, across the CLIs", () => {
    const o = { tools: [{ name: 'Bash', input: 'git commit -m x' }, { name: 'PowerShell', input: 'git status' }, { name: 'Write', input: 'git commit in a file' }, { name: 'exec_command', input: '{"cmd":"git add -A"}' }] }
    expect(gitMutations(o)).toEqual(['git commit -m x', 'git add -A'])
  })
})
