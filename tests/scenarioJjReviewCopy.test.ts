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
type View = { state: string; lease: { returned: boolean } | null }
const { copySnapshot, firstLook, copyChanges, copyWrites, shellCommands } = require('./scenarios/jjReviewCopy.cjs') as {
  copySnapshot: (folder: string, jj: (...a: string[]) => string) => Snap
  firstLook: (view: View, snap: Snap, revision: string) => 'baseline' | 'seen' | null
  copyChanges: (a: Snap, b: Snap) => string[]
  copyWrites: (o: { tools: Tool[] }, copy: string) => string[]
  shellCommands: (text: string) => { words: string[]; bare: string }[]
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

  it('read as the shell reads it (HI-2935): escaped quotes, a shell\'s own script, and a heredoc\'s apostrophe', () => {
    const COPY = 'C:\\ws\\.copies\\alpha\\copy-1'
    const writes = (tools: Tool[]): string[] => copyWrites({ tools }, COPY)
    // Escaped quotes inside "…": one read-only script, never cut at the first \" (its `->` was taken for a redirection).
    expect(writes([{ name: 'Bash', input: 'node -e "console.log(\\"undefined ->\\", e.message)"', cwd: COPY }])).toEqual([])
    expect(writes([{ name: 'PowerShell', input: 'node -e "console.log(`"a -> b`")"', cwd: COPY }])).toEqual([])
    // A shell's script is commands too: a jj record or a write inside `bash -c "…"` or `pwsh -Command "…"`.
    expect(writes([{ name: 'Bash', input: 'bash -c "cd x; jj commit -m y"', cwd: COPY }])).toEqual(['jj commit -m y'])
    expect(writes([{ name: 'PowerShell', input: 'pwsh -Command "Get-Content a.js; Set-Content greet.js x"', cwd: COPY }])).toEqual(['Set-Content greet.js x'])
    expect(writes([{ name: 'Bash', input: "sh -c 'echo hi > out.txt'", cwd: COPY }])).toEqual(['echo hi > out.txt'])
    expect(writes([{ name: 'Bash', input: 'bash -c "jj log -r @-; jj diff"', cwd: COPY }])).toEqual([])
    // A heredoc's text is no command: its apostrophe pairs with nothing, so the jj describe after it still counts.
    const notes = `cat <<'EOF'\nReviewer's notes: looks right\nEOF\njj describe -m 'done'`
    expect(writes([{ name: 'Bash', input: notes, cwd: COPY }])).toEqual(['jj describe -m done'])
    // A script over several lines in one quote stays one word (an arrow function's => is no redirection).
    expect(writes([{ name: 'Bash', input: 'node -e "\nconst f = (x) => x + 1\nconsole.log(f(1))\n"', cwd: COPY }])).toEqual([])
    // A quote that never closes ends at its line's end: the next line is read.
    expect(writes([{ name: 'Bash', input: "echo it's fine\njj new", cwd: COPY }])).toEqual(['jj new'])
  })

  it('shellCommands: words and the bare command, quotes, separators, here-strings', () => {
    const cmds = (t: string) => shellCommands(t).map((c) => c.words)
    expect(cmds('jj log -r @- && jj diff | head; cat a || echo b')).toEqual([['jj', 'log', '-r', '@-'], ['jj', 'diff'], ['head'], ['cat', 'a'], ['echo', 'b']])
    expect(shellCommands('jj commit -m "fix; the > greeting"')).toEqual([{ words: ['jj', 'commit', '-m', 'fix; the > greeting'], bare: 'jj commit -m ""' }])
    expect(cmds('echo "a\\\\" b')).toEqual([['echo', 'a\\', 'b']])
    expect(cmds("echo 'it''s'")).toEqual([['echo', 'its']])
    expect(cmds("$x = @'\nline one; rm x\n'@\njj st")).toEqual([['$x', '=', 'line one; rm x'], ['jj', 'st']])
    expect(cmds('cmd /c "jj new"')).toEqual([['cmd', '/c', 'jj new'], ['jj', 'new']])
  })

  it("a copy still being made (HI-2907): jj's @- on the revision before its files are written is no first look", () => {
    // Combwork's lease operation: jj records the copy's workspace at the revision, then writes its files and checks it.
    const dir = tempDir('jjcopy-')
    mkdirSync(join(dir, '.jj', 'repo'), { recursive: true })
    const jj = { at: 'f'.repeat(40) }
    const look = (): Snap => copySnapshot(dir, (...a: string[]) => (a[a.indexOf('-r') + 1] === '@' ? `${jj.at} true` : REV))
    const view: View = { state: 'creating', lease: { returned: false } }
    const early = look()
    expect(early).toMatchObject({ parent: REV, files: {} })
    expect(firstLook(view, early, REV)).toBeNull()
    // A free copy reset for the lease keeps its state until the operation ends: no first look either.
    expect(firstLook({ state: 'free', lease: { returned: false } }, early, REV)).toBeNull()
    expect(firstLook({ state: 'dirty', lease: { returned: false } }, early, REV)).toBeNull()
    // The copy fills in, and jj's working copy moves to its checked-out commit: what the first look used to report.
    writeFileSync(join(dir, 'greet.js'), "module.exports = (name) => 'Helo, ' + name.trim()\n")
    writeFileSync(join(dir, 'README.md'), '# r\n')
    jj.at = AT
    expect(copyChanges(early, look()).sort()).toEqual(['added README.md', 'added greet.js', `jj's working copy moved: ${'f'.repeat(12)} → ${AT.slice(0, 12)}`])
    // Handed over (leased): its first look, and a reviewer that only reads changes nothing after it.
    view.state = 'leased'
    const first = look()
    expect(firstLook(view, first, REV)).toBe('baseline')
    expect(copyChanges(first, look())).toEqual([])
  })

  it('a first look: only on the submitted revision; a copy given back before it was on it, with nothing to compare', () => {
    const c = copy()
    const snap = c.look()
    expect(firstLook({ state: 'leased', lease: { returned: false } }, snap, 'c'.repeat(40))).toBeNull()
    expect(firstLook({ state: 'leased', lease: null }, snap, REV)).toBeNull()
    expect(firstLook({ state: 'leased', lease: { returned: false } }, null, REV)).toBeNull()
    // Given back between two looks: 'returning' only once the operation that made it ready has ended.
    expect(firstLook({ state: 'returning', lease: { returned: true } }, snap, REV)).toBe('seen')
    // Given back while still being made, and its setup failed: never ready.
    expect(firstLook({ state: 'creating', lease: { returned: true } }, snap, REV)).toBeNull()
  })

  it('a copy gone (given back and removed): nothing to compare, not counted as a change', () => {
    const c = copy()
    const first = c.look()
    rmSync(c.dir, { recursive: true, force: true })
    expect(c.look()).toBeNull()
    expect(copyChanges(first, null)).toEqual([])
  })
})
