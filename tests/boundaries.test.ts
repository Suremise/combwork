// Workspace and file boundaries: link escapes, nested and same-named workspaces, closed workspaces' worktrees,
// and writes that must not lose someone else's change.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock, writeTextAtomic, writeTextUnlessChanged } from '../src/main/fsutil'
import { createWorkspaceService, disposeWorkspaceService, type WorkspaceService } from '../src/main/workspace'
import { tempDir } from './tempDir'
import { bound } from './keepType'

const base = tempDir('cw-bounds-')
const dir = (...p: string[]): string => {
  const d = join(base, ...p)
  mkdirSync(d, { recursive: true })
  return d
}

// A service showing a workspace without open()'s setup (config, watcher): enough for path ownership.
const made: WorkspaceService[] = []
function showing(path: string): WorkspaceService {
  const w = createWorkspaceService()
  w.path = path
  made.push(w)
  return w
}
afterEach(async () => {
  for (const w of made.splice(0)) await disposeWorkspaceService(w)
})

describe('workspace boundaries', () => {
  it('refuses to open a workspace inside, or around, one open in another window', async () => {
    const outer = dir('nest', 'outer')
    const inner = dir('nest', 'outer', 'client')
    showing(outer)
    const other = createWorkspaceService()
    made.push(other)
    await expect(other.open(inner)).rejects.toThrow(/inside the workspace/)
    await expect(other.open(dir('nest'))).rejects.toThrow(/is inside/)
    expect(other.path).toBeNull()
  })

  it("forgets a closed workspace's agent worktrees", async () => {
    const ws = dir('closing', 'ws')
    const w = showing(ws)
    const custom = dir('closing', 'elsewhere', 'worker')
    w['roots'].set(custom.toLowerCase(), join(ws, 'proj'))
    expect(w.assertRoot(custom)).toBe(custom)
    expect(w.isAllowedPath(join(custom, 'a.txt'))).toBe(true)
    await w.close()
    w.path = dir('closing', 'next')
    expect(() => w.assertRoot(custom)).toThrow(/Not a project/)
    expect(w.isAllowedPath(join(custom, 'a.txt'))).toBe(false)
  })

  it('lets only one of two windows opening nested folders at once have its workspace', async () => {
    const outer = dir('race', 'outer')
    const inner = dir('race', 'outer', 'client')
    // Two declarations, not one destructured from an array literal: its elements' slot is any, which loses their type.
    const a = createWorkspaceService()
    const b = createWorkspaceService()
    made.push(a, b)
    // Closing the old workspace takes a moment: the other window's check must still see this one's claim.
    for (const w of [a, b]) {
      const close = bound(w, w.close)
      w.close = async () => (await new Promise((r) => setTimeout(r, 30)), close())
    }
    const results = await Promise.allSettled([a.open(outer), b.open(inner)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')?.reason?.message).toMatch(/inside/)
  })

  it("doesn't take back a closed workspace's worktrees from a refresh still reading them", async () => {
    const ws = dir('stale', 'ws')
    const proj = dir('stale', 'ws', 'proj')
    const worktree = dir('stale', 'ws.worktrees', 'proj-a')
    dir('stale', 'ws', 'proj', '.combwork')
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a', name: 'A', worktree: { path: worktree, branch: 'a', base: 'main' } }] }))
    const w = showing(ws)
    const reading = w.projectInfo(proj).catch(() => undefined)
    await w.close()
    w.path = dir('stale', 'next')
    await reading
    expect(() => w.assertRoot(worktree)).toThrow(/Not a project/)
  })

  it("won't start an agent in a workspace whose agents are being stopped to close it", async () => {
    const { sessions } = await import('../src/main/sessions')
    const ws = dir('closing-start', 'ws')
    const w = showing(ws)
    w.closing = true
    await expect(sessions.start(dir('closing-start', 'ws', 'proj'), { agentId: 'a' })).rejects.toThrow(/stopping this workspace's agents/)
  })

  it('refuses an Agent API workspace name two open workspaces share', async () => {
    const { findWorkspace } = await import('../src/main/servers')
    const a = showing(dir('dupes', 'C', 'foo'))
    showing(dir('dupes', 'E', 'foo'))
    expect(() => findWorkspace('foo')).toThrow(/Several open workspaces are named "foo"/)
    expect(findWorkspace(a.path!)).toBe(a)
  })
})

describe('project files and links', () => {
  it('reads and writes in the project, but not through a link leading outside it', async () => {
    const files = await import('../src/main/files')
    const ws = dir('links', 'ws')
    const proj = dir('links', 'ws', 'proj')
    const outside = dir('links', 'outside')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    writeFileSync(join(proj, 'own.txt'), 'mine')
    symlinkSync(outside, join(proj, 'docs'), 'junction')
    showing(ws)
    expect((await files.readText(proj, 'own.txt')).text).toBe('mine')
    await expect(files.readText(proj, 'docs/secret.txt')).rejects.toThrow(/outside the project/)
    await expect(files.writeText(proj, 'docs/secret.txt', 'changed', null, false)).rejects.toThrow(/outside the project/)
    await expect(files.create(proj, 'docs', 'new.txt', false)).rejects.toThrow(/outside the project/)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    // The link itself is the project's: it can be renamed.
    expect(await files.renameEntry(proj, 'docs', 'docs2')).toBe('docs2')
  })
})

describe('writes that keep other changes', () => {
  it("won't save over a file changed since the editor loaded it", async () => {
    const f = join(dir('conflict'), 'note.md')
    writeFileSync(f, 'v1')
    await writeTextUnlessChanged(f, 'mine', 'v1')
    expect(readFileSync(f, 'utf8')).toBe('mine')
    writeFileSync(f, 'agent edit')
    await expect(writeTextUnlessChanged(f, 'mine again', 'mine')).rejects.toThrow('CONFLICT')
    expect(readFileSync(f, 'utf8')).toBe('agent edit')
    // A new file (read as '') is created; without an expected text it simply writes.
    await writeTextUnlessChanged(join(dir('conflict'), 'new.md'), 'hi', '')
    await writeTextUnlessChanged(f, 'overwrite')
    expect(readFileSync(f, 'utf8')).toBe('overwrite')
  })

  it('keeps edits made to a draft while Save All was saving it', async () => {
    const { editorDraft, saveEditorDrafts, setEditorDraft } = await import('../src/renderer/src/editorDrafts')
    let release = (): void => undefined
    const saving = new Promise<void>((r) => (release = r))
    const draft = { key: 'mcp:x', label: 'x.json', abs: 'x.json', base: '{}\n', save: async (t: string) => (await saving, t + '\n') }
    setEditorDraft({ ...draft, text: '{"a":1}' })
    const run = saveEditorDrafts()
    setEditorDraft({ ...draft, text: '{"a":2}' })
    release()
    expect((await run).saved).toBe(1)
    expect(editorDraft('mcp:x')?.text).toBe('{"a":2}')
    expect(editorDraft('mcp:x')?.base).toBe('{"a":1}\n')
  })

  it('keeps both of two appends made at once when each holds the lock from read to write', async () => {
    const f = join(dir('append'), 'log.md')
    const append = (line: string): Promise<void> =>
      withFileLock(f, async () => {
        const existing = await readFile(f, 'utf8').catch(() => '')
        await new Promise((r) => setTimeout(r, 20))
        await writeTextAtomic(f, existing + line + '\n')
      })
    await Promise.all([append('a'), append('b'), append('c')])
    expect(readFileSync(f, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('git diff boundaries', () => {
  it("doesn't read a file through a link that leads outside the project", async () => {
    const { gitDiff } = await import('../src/main/git')
    const proj = dir('difflink', 'ws', 'proj')
    const outside = dir('difflink', 'secret')
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(outside, join(proj, 'linked'), 'junction')
    await expect(gitDiff(proj, 'linked/secret.txt')).rejects.toThrow(/outside the project/)
  })
})
