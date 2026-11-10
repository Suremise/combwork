// J9d's jj-card-review assertion (HI-2870, HR2's round 1; tests/scenarios/jjReviewCopy.cjs): what changed in a jj review
// copy while its reviewer had it. Its failure is fixed here, never with a model run (AGENTS.md).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

type Snap = { files: Record<string, string>; at: string; atEmpty: boolean; parent: string } | null
const require = createRequire(import.meta.url)
type Tool = { name: string; input: string; cwd?: string }
const { copySnapshot, copyChanges, copyWrites } = require('./scenarios/jjReviewCopy.cjs') as {
  copySnapshot: (folder: string, jj: (...a: string[]) => string) => Snap
  copyChanges: (a: Snap, b: Snap) => string[]
  copyWrites: (o: { tools: Tool[] }, copy: string) => string[]
}

const REV = 'a'.repeat(40)
const AT = 'b'.repeat(40)

/** A copy as Combwork lends one: the submitted files, jj's and Git's folders, jj's answers given by the test. */
function copy(): { dir: string; jj: { at: string; empty: boolean; parent: string }; look: () => Snap } {
  const dir = tempDir('jjcopy-')
  mkdirSync(join(dir, '.jj', 'repo'), { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: elsewhere\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'greet.js'), "module.exports = (name) => 'Helo, ' + name.trim()\n")
  writeFileSync(join(dir, 'src', 'util.js'), 'module.exports = {}\n')
  const jj = { at: AT, empty: true, parent: REV }
  const run = (...a: string[]): string => {
    const rev = a[a.indexOf('-r') + 1]
    return rev === '@' ? `${jj.at} ${jj.empty}` : jj.parent
  }
  return { dir, jj, look: () => copySnapshot(dir, run) }
}

describe("what changed in a jj review copy while its reviewer had it", () => {
  it('nothing, for a reviewer that only reads: its files and jj records left as they were', () => {
    const c = copy()
    const first = c.look()
    expect(first).toMatchObject({ at: AT, atEmpty: true, parent: REV })
    expect(Object.keys(first!.files).sort()).toEqual(['greet.js', 'src/util.js'])
    // jj's and Git's own files changing (a read's own records, an index refresh) are no edit of the copy.
    writeFileSync(join(c.dir, '.jj', 'repo', 'op'), 'x')
    expect(copyChanges(first, c.look())).toEqual([])
  })

  it('a file edited, added or removed without any jj command: each named', () => {
    const c = copy()
    const first = c.look()
    writeFileSync(join(c.dir, 'greet.js'), "module.exports = (name) => 'Hello, ' + name.trim()\n")
    writeFileSync(join(c.dir, 'src', 'new.js'), '\n')
    rmSync(join(c.dir, 'src', 'util.js'))
    expect(copyChanges(first, c.look()).sort()).toEqual(['added src/new.js', 'edited greet.js', 'removed src/util.js'])
  })

  it("the fix recorded with jj (a commit, jj new or describe): jj's working copy or its parent moved", () => {
    const c = copy()
    const first = c.look()
    // jj commit: the edit recorded as @'s commit, a new empty @ on it; the file stays as edited.
    writeFileSync(join(c.dir, 'greet.js'), "module.exports = (name) => 'Hello, ' + name.trim()\n")
    c.jj.parent = 'c'.repeat(40)
    c.jj.at = 'd'.repeat(40)
    const changes = copyChanges(first, c.look())
    expect(changes).toContain('edited greet.js')
    expect(changes.some((x) => x.startsWith("jj's working copy moved"))).toBe(true)
    expect(changes.some((x) => x.startsWith('its parent moved'))).toBe(true)
    // jj describe on @ alone (no file changed): its commit id moves.
    const d = copy()
    const before = d.look()
    d.jj.at = 'e'.repeat(40)
    expect(copyChanges(before, d.look())).toEqual([`jj's working copy moved: ${AT.slice(0, 12)} → ${'e'.repeat(12)}`])
  })

  it("a reviewer's tool calls that change the copy, however quick: file tools' edits there, jj records and file writes run there", () => {
    const COPY = 'C:\\ws\\.copies\\alpha\\copy-1'
    const writes = (tools: Tool[]): string[] => copyWrites({ tools }, COPY)
    // File tools naming a file in it (any spelling of its path), or run there.
    expect(writes([{ name: 'Edit', input: '{"file_path":"c:/ws/.copies/alpha/copy-1/greet.js","old_string":"Helo"}' }])).toHaveLength(1)
    expect(writes([{ name: 'Write', input: 'C:\\ws\\.copies\\alpha\\copy-1\\fix.js' }])).toHaveLength(1)
    expect(writes([{ name: 'apply_patch', input: '*** Update File: greet.js', cwd: `${COPY}\\src` }])).toHaveLength(1)
    // jj commands that record or change the copy, run there or pointed at it.
    for (const cmd of ['jj commit -m fix', 'jj describe -m x', 'jj new', 'jj squash', 'jj edit @-', 'jj restore greet.js', 'jj abandon', 'jj op restore abc', 'jj workspace update-stale', 'jj.exe --no-pager ci -m y']) {
      expect(writes([{ name: 'Bash', input: cmd, cwd: COPY }]), cmd).toEqual([cmd])
    }
    expect(writes([{ name: 'PowerShell', input: `jj -R "${COPY}" commit -m fix` }])).toHaveLength(1)
    // Shell writes there: a redirection, cmdlets and commands that write, move or remove, sed -i.
    for (const cmd of ["echo 'x' > greet.js", 'Set-Content greet.js x', 'Remove-Item greet.js', 'rm greet.js', "sed -i 's/Helo/Hello/' greet.js", 'mv a.js b.js']) {
      expect(writes([{ name: 'Bash', input: cmd, cwd: COPY }]), cmd).toHaveLength(1)
    }
  })

  it("a reviewer's reads, and anything outside the copy, aren't changes", () => {
    const COPY = 'C:\\ws\\.copies\\alpha\\copy-1'
    const writes = (tools: Tool[]): string[] => copyWrites({ tools }, COPY)
    for (const cmd of ['jj diff --from abc --to def', 'jj log -r @-', 'jj show @-', 'jj st', 'jj file show greet.js -r @-', 'jj op log', 'git diff abc def', 'cat greet.js', 'node -e "1" 2>&1', 'git status > $null', 'Get-Content greet.js', 'jj bookmark list']) {
      expect(writes([{ name: 'Bash', input: cmd, cwd: COPY }]), cmd).toEqual([])
    }
    expect(writes([{ name: 'Read', input: `${COPY}\\greet.js` }])).toEqual([])
    // Quoted text is no command: a script's `->`, `;` or `|` (Claude Code's read in run 2026-11-10T18-01-19-claude-code).
    const run = `cd "C:/ws/.copies/alpha/copy-1" && cat greet.js && node -e "const g=require('./greet.js');console.log(JSON.stringify(g('  Ann  ')));try{g(undefined)}catch(e){console.log('undefined ->',e.message)}"`
    expect(writes([{ name: 'Bash', input: run }])).toEqual([])
    expect(writes([{ name: 'Bash', input: `jj log -r @- -T 'description ++ "; rm x | > y"'`, cwd: COPY }])).toEqual([])
    expect(writes([{ name: 'Bash', input: `jj commit -m "fix; the greeting"`, cwd: COPY }])).toHaveLength(1)
    // Elsewhere: the reviewer's own scratch, the project folder.
    expect(writes([{ name: 'Write', input: 'C:\\Temp\\scratch\\notes.md' }])).toEqual([])
    expect(writes([{ name: 'Bash', input: 'jj commit -m x', cwd: 'C:\\ws\\alpha' }])).toEqual([])
    // Another copy whose name starts with this one's.
    expect(writes([{ name: 'Bash', input: 'jj new', cwd: `${COPY}0` }])).toEqual([])
  })

  it('a copy gone (given back and removed): nothing to compare, not counted as a change', () => {
    const c = copy()
    const first = c.look()
    rmSync(c.dir, { recursive: true, force: true })
    expect(c.look()).toBeNull()
    expect(copyChanges(first, null)).toEqual([])
  })
})
