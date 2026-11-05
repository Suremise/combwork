import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { redactLog } from '../src/shared/redact'
import { tempDir } from './tempDir'

// Claude Code's and Codex's discovery warnings (#463), as Copilot's (#452): a candidate's path and what it printed instead
// of its version are the user's text, so Copy Diagnostics leaves them out and keeps the warning itself.

const PROVIDERS = [
  { id: 'claude-code', exe: 'claude.exe', load: async () => (await import('../src/main/providers/claude/adapter')).claudeCode },
  { id: 'codex', exe: 'codex.exe', load: async () => (await import('../src/main/providers/codex/adapter')).codex }
]

describe('Provider discovery log', () => {
  for (const p of PROVIDERS) {
    it(`${p.id}: leaves a candidate’s path and what it printed out of Copy Diagnostics (userText)`, async () => {
      // A custom path in a private folder (a space in its name) whose CLI prints a private name instead of its version.
      const dir = tempDir('cw-discovery-')
      const exe = join(dir, 'Private Client', p.exe)
      mkdirSync(dirname(exe), { recursive: true })
      writeFileSync(exe, '')
      vi.resetModules()
      vi.doMock('../src/main/config', () => ({ config: { settings: { providers: { [p.id]: { executablePath: exe } } } } }))
      vi.doMock('../src/main/providers/common', async (actual) => ({ ...(await actual<typeof import('../src/main/providers/common')>()), run: async (file: string) => (file === exe ? { stdout: '', stderr: 'Failed loading Confidential Customer profile', code: 1 } : { stdout: '', stderr: '', code: 1 }) }))
      const lines: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)))
      try {
        const adapter = await p.load()
        expect((await adapter.locate()).path).not.toBe(exe)
      } finally {
        spy.mockRestore()
        vi.doUnmock('../src/main/config')
        vi.doUnmock('../src/main/providers/common')
        vi.resetModules()
        rmSync(dir, { recursive: true, force: true })
      }
      const warning = lines.find((l) => l.includes('did not report a version') && l.includes('Private Client'))
      expect(warning).toBeDefined()
      const out = redactLog(warning!, { home: 'C:\\Users\\nobody', folders: [], names: [] })
      expect(out).toContain('did not report a version')
      expect(out).not.toMatch(/Private Client|Client|claude\.exe|codex\.exe|Confidential|Customer/)
    })
  }
})
