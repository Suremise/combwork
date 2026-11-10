// HI-2025: unit tests run Git for Windows' own git.exe instead of its cmd launcher only where the launcher is the git PATH
// finds, for one installation, inserted just before the launcher's folder (tests/directGit.ts); otherwise PATH as it was.
import { delimiter, join } from 'path'
import { describe, expect, it } from 'vitest'
import { directGitPath } from './directGit'

const ROOT = 'C:\\Program Files\\Git'
const CMD = join(ROOT, 'cmd')
const BIN = join(ROOT, 'mingw64', 'bin')
const EXEC = 'C:/Program Files/Git/mingw64/libexec/git-core'
const SYS = 'C:\\WINDOWS\\system32'
/** git.exe in the launcher's folder and git's own; `extra`, other folders holding one. */
const has = (extra: string[] = []) => (p: string) => [join(CMD, 'git.exe'), join(BIN, 'git.exe'), ...extra].map((x) => x.toLowerCase()).includes(p.toLowerCase())
const path = (...parts: string[]) => parts.join(delimiter)

describe('directGitPath (HI-2025)', () => {
  it("the launcher first: git's own folder goes immediately before it, every folder ahead keeping its place", () => {
    expect(directGitPath(path(SYS, 'C:\\Tools', CMD, 'C:\\Later'), EXEC, has())).toBe(path(SYS, 'C:\\Tools', BIN, CMD, 'C:\\Later'))
  })

  it("git's own folder already first (Git Bash): unchanged", () => {
    expect(directGitPath(path('C:\\Users\\me\\bin', BIN, SYS, CMD), EXEC, has())).toBeNull()
  })

  it('another installation (exec path elsewhere), or no git.exe in its bin: unchanged', () => {
    expect(directGitPath(path(SYS, CMD), 'D:/OtherGit/mingw64/libexec/git-core', has())).toBeNull()
    expect(directGitPath(path(SYS, CMD), EXEC, (p) => p.toLowerCase() === join(CMD, 'git.exe').toLowerCase())).toBeNull()
  })

  it("a git.exe first that isn't a launcher (some other git), or none at all: unchanged", () => {
    expect(directGitPath(path('C:\\PortableGit\\bin', CMD), EXEC, has([join('C:\\PortableGit\\bin', 'git.exe')]))).toBeNull()
    expect(directGitPath(path(SYS, 'C:\\Tools'), EXEC, has())).toBeNull()
  })

  it("a ucrt64 install (HI-2812): its bin folder, matching the exec path, goes before the launcher", () => {
    const ucrt = join(ROOT, 'ucrt64', 'bin')
    const exec = 'C:/Program Files/Git/ucrt64/libexec/git-core'
    const onlyUcrt = (p: string) => [join(CMD, 'git.exe'), join(ucrt, 'git.exe')].map((x) => x.toLowerCase()).includes(p.toLowerCase())
    expect(directGitPath(path(SYS, CMD, 'C:\\Later'), exec, onlyUcrt)).toBe(path(SYS, ucrt, CMD, 'C:\\Later'))
    // The bin folder is the exec path's, never another layout's that happens to hold a git.exe.
    expect(directGitPath(path(SYS, CMD), exec, has())).toBeNull()
    expect(directGitPath(path(SYS, CMD), EXEC, onlyUcrt)).toBeNull()
    // A layout the product doesn't know: unchanged.
    expect(directGitPath(path(SYS, CMD), 'C:/Program Files/Git/usr/libexec/git-core', has([join(ROOT, 'usr', 'bin', 'git.exe')]))).toBeNull()
  })

  it('run once, then again on its own result: no second insertion', () => {
    const once = directGitPath(path(SYS, CMD), EXEC, has())!
    expect(directGitPath(once, EXEC, has())).toBeNull()
  })
})
