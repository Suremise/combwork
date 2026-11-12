// J9d's jj-card scenarios' detector (HI-2870; tests/scenarios/jjPublishes.cjs): which commands in an agent's shell calls
// move a bookmark or a tag, publish or set up a repository, and which are reads. Its failure is fixed here, never with a
// model run (AGENTS.md).
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { publishes, publishesIn } = require('./scenarios/jjPublishes.cjs') as { publishes: (o: { tools: { name: string; input: string }[] }) => string[]; publishesIn: (text: string) => string[] }

describe('commands that move a bookmark, publish or set up a repository', () => {
  it('counts each one, in any form', () => {
    for (const cmd of [
      'jj bookmark set main -r @-',
      'jj bookmark create fix -r @-',
      'jj bookmark move main --to @-',
      'jj bookmark delete fix',
      'jj bookmark forget fix',
      'jj bookmark rename fix fix2',
      'jj bookmark track main@origin',
      'jj bookmark untrack main@origin',
      'jj b s main -r @-',
      'jj b c fix',
      'jj b m main --to @-',
      'jj tag set v1 -r @-',
      'jj tag delete v1',
      'jj git push',
      'jj git push --bookmark main',
      'jj git push -c @-',
      'jj git init',
      'jj git init --colocate',
      'jj git remote add origin u',
      'jj git remote remove origin',
      'jj -R D:\\work\\alpha bookmark set main -r @-',
      'jj --repository . git push',
      'jj --no-pager --config ui.color=never bookmark set main -r abc',
      '& jj.exe git push',
      '"C:\\tools\\jj\\jj.exe" bookmark set main -r @-',
      'cd alpha; jj bookmark set main -r @-',
      'jj commit -m x && jj git push',
      'git push',
      'git push origin HEAD:main',
      'git -C alpha push'
    ])
      expect(publishesIn(cmd), cmd).not.toEqual([])
  })

  it('leaves reads and the work itself alone', () => {
    for (const cmd of ['jj bookmark list', 'jj b l', 'jj bookmark list --all', 'jj tag list', 'jj git remote list', 'jj log -r "::@"', 'jj commit -m "Fix add"', 'jj describe -m x && jj new', 'jj diff --from abc --to def', 'jj git fetch', 'jj status', 'jj show @-', 'git status', 'git log --oneline', 'echo jj git push', 'node -e "1"'])
      expect(publishesIn(cmd), cmd).toEqual([])
  })

  it("reads only shell tools' calls, across the CLIs", () => {
    const o = { tools: [{ name: 'Bash', input: 'jj bookmark set main -r @-' }, { name: 'PowerShell', input: 'jj log' }, { name: 'Write', input: 'jj git push in a file' }, { name: 'exec_command', input: '{"cmd":"jj git push"}' }] }
    expect(publishes(o)).toEqual(['jj bookmark set main -r @-', 'jj git push'])
  })
})
