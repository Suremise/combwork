// The Assistant's own memory (HI-2666): what its CLI saved for the workspace's folder, as main finds it (an isolated Claude
// Code home, never the user's), which provider's is shown, and that a provider whose adapter shows none says nothing of
// what that CLI keeps. Its files are read and saved through the project Memory tab's file guard: that guard admits them.
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-assistant-memory-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { assistantMemoryFolder, assistantMemoryFor } = await import('../src/main/assistantMemory')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { encodeProjectPath } = await import('../src/main/providers/claude/usage')
const { assistantMemoryProvider, assistantMemoryScope } = await import('../src/shared/assistantMemory')

const ws = join(base, 'Work Space')
mkdirSync(ws, { recursive: true })
const memDir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', encodeProjectPath(ws), 'memory')

describe("the Assistant's memory, as main finds it (HI-2666)", () => {
  it("Claude Code, no memory yet: where it would keep it, and no files", async () => {
    const m = await assistantMemoryFor(ws, 'claude-code')
    expect(m.provider).toBe('claude-code')
    expect(m.folder?.toLowerCase()).toBe(memDir.toLowerCase())
    expect(m.files).toEqual([])
  })

  it('Claude Code, with memory: its Markdown files, MEMORY.md (the index) first, nothing else', async () => {
    mkdirSync(memDir, { recursive: true })
    for (const f of ['b.md', 'MEMORY.md', 'a.md', 'notes.txt']) writeFileSync(join(memDir, f), `# ${f}\n`)
    const m = await assistantMemoryFor(ws, 'claude-code')
    expect(m.files.map((f) => f.label)).toEqual(['MEMORY.md', 'a.md', 'b.md'])
    expect(m.files.every((f) => f.kind === 'auto-memory' && f.exists && f.provider === 'claude-code')).toBe(true)
    // The project Memory tab's file guard admits them, to read and to save: no new powers.
    for (const f of m.files) {
      expect(claudeCode.fileAllowed(f.path, false), f.label).toBe(true)
      expect(claudeCode.fileAllowed(f.path, true), f.label).toBe(true)
    }
    // ...and nothing beside them in Claude Code's home.
    expect(claudeCode.fileAllowed(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), false)).toBe(false)
    expect(claudeCode.fileAllowed(join(memDir, 'notes.txt'), false)).toBe(false)
  })

  it("a provider whose adapter shows no saved memory (Codex, Copilot): no folder and no files, whatever its CLI keeps", async () => {
    for (const p of ['codex', 'copilot'] as const) expect(await assistantMemoryFor(ws, p)).toEqual({ provider: p, folder: null, files: [] })
  })
})

describe("Open Folder beside the Assistant's memory (HI-2736)", () => {
  it('opens exactly the memory folder main names, found again from the workspace and provider', async () => {
    mkdirSync(memDir, { recursive: true })
    expect((await assistantMemoryFolder(ws, 'claude-code'))?.toLowerCase()).toBe(memDir.toLowerCase())
    // The file guard (app:openPath, file:read) still admits only its memory files: not the folder, its project's folder
    // above it, nor a folder beside it. Open Folder needs none of them: it opens the folder it found itself.
    for (const p of [memDir, dirname(memDir), join(dirname(memDir), 'other'), join(process.env.CLAUDE_CONFIG_DIR!, 'projects')]) expect(claudeCode.fileAllowed(p, false), p).toBe(false)
  })

  it("none to open where there is no folder: not made yet, or a provider whose memory isn't shown", async () => {
    const other = join(base, 'Other Space')
    mkdirSync(other, { recursive: true })
    expect(await assistantMemoryFolder(other, 'claude-code')).toBeNull()
    expect(await assistantMemoryFolder(ws, 'codex')).toBeNull()
  })
})

describe('which provider, and the scope of a load', () => {
  it("the one the Assistant runs on now, though its settings name another for its next launch; else the configured one", () => {
    expect(assistantMemoryProvider({ provider: 'codex' }, 'claude-code')).toBe('codex')
    expect(assistantMemoryProvider(null, 'claude-code')).toBe('claude-code')
    expect(assistantMemoryProvider(undefined, 'copilot')).toBe('copilot')
  })

  it('a load is scoped to the workspace and the provider: another of either is another scope', () => {
    const a = assistantMemoryScope('D:\\Work', 'claude-code')
    expect(assistantMemoryScope('d:\\work', 'claude-code')).toBe(a)
    expect(assistantMemoryScope('D:\\Other', 'claude-code')).not.toBe(a)
    expect(assistantMemoryScope('D:\\Work', 'codex')).not.toBe(a)
  })
})
