import { createRequire } from 'module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const diagnostics = createRequire(import.meta.url)('./e2e/codexDiagnostics.cjs')
const tmp = tempDir('cw-codex-diagnostics-')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const from = new Date(2026, 9, 9, 11, 47, 0).getTime()
const to = from + 60_000
const start = '[2026-10-09 11:47:22.000 codex.exe] START: C:\\Users\\test\\WindowsApps\\pwsh.exe\nStart-Sleep -Seconds 40\n'

describe('Codex failure diagnostics (#478)', () => {
  it('keeps the local-time window and command continuations, without attributing earlier or later launches', () => {
    const text = '[2026-10-09 11:46:58.000 codex.exe] START: old\nold command\n' + start + '[2026-10-09 11:47:39.000 codex.exe] SUCCESS: peer\n[2026-10-09 11:48:01.000 codex.exe] START: later\n'
    const entries = diagnostics.sandboxEntries(text, from, to)
    expect(entries).toHaveLength(2)
    expect(entries[0].text).toContain('WindowsApps\\pwsh.exe\nStart-Sleep')
    expect(entries[0].at).toBe(from + 22_000)
    expect(entries[1].text).toContain('SUCCESS: peer')
    expect(JSON.stringify(entries)).not.toContain('old command')
    expect(JSON.stringify(entries)).not.toContain('START: later')
  })

  it('reads bounded tails from at most two daily logs and never reads the home’s sign-in', () => {
    const home = join(tmp, 'bounded')
    const sandbox = join(home, '.sandbox')
    mkdirSync(sandbox, { recursive: true })
    writeFileSync(join(home, 'auth.json'), 'SECRET_SIGN_IN')
    writeFileSync(join(sandbox, 'sandbox.2026-10-07.log'), start)
    writeFileSync(join(sandbox, 'sandbox.2026-10-08.log'), '')
    writeFileSync(join(sandbox, 'sandbox.2026-10-09.log'), 'old padding\n'.repeat(diagnostics.MAX_BYTES) + start)
    const result = diagnostics.collectSandboxDiagnostics({ home, from, to, logsRoot: join(tmp, 'missing') })
    expect(result.logs).toHaveLength(2)
    expect(result.logs[1].truncated).toBe(true)
    expect(result.logs[1].entries).toHaveLength(1)
    expect(result.logs[1].entries[0].text).toContain('START:')
    expect(JSON.stringify(result)).not.toContain('SECRET_SIGN_IN')
    expect(JSON.stringify(result).length).toBeLessThan(diagnostics.MAX_BYTES)
  })

  it('records only real suites of live runners, checks marker ownership and tolerates a partial peer write', () => {
    const logsRoot = join(tmp, 'peers')
    const make = (name: string, pid: number, state: unknown) => {
      const dir = join(logsRoot, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.active'), String(pid))
      writeFileSync(join(dir, 'running-suites.json'), typeof state === 'string' ? state : JSON.stringify(state))
    }
    const state = { pid: 101, root: 'C:/worktree', lane: 2, at: from, suites: [{ name: 'about', needs: [] }, { name: 'codex-background', needs: ['codex'] }] }
    make('run-20261009-114700', 101, state)
    make('run-20261009-114701', 102, { ...state, pid: 102 }) // Dead runner.
    make('run-20261009-114702', 103, state) // A stale state with a different owner.
    make('run-20261009-114703', 104, '{') // Read during a write.
    const peers = diagnostics.runningCliSuites({ logsRoot, alive: (pid: number) => pid !== 102 })
    expect(peers).toHaveLength(2)
    expect(peers[0]).toMatchObject({ pid: 101, lane: 2, suites: [{ name: 'codex-background', needs: ['codex'] }] })
    expect(peers[1]).toHaveProperty('unavailable')
    const other = diagnostics.runningCliSuites({ logsRoot, alive: (pid: number) => pid !== 102, ownRunner: 101 })
    expect(other).toHaveLength(1)
    expect(other[0]).toHaveProperty('unavailable')
  })

  it('saves and prints failure evidence even with missing logs, without creating a FAIL or SKIP verdict', () => {
    const output: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => output.push(String(line)))
    const file = join(tmp, 'evidence.json')
    try {
      diagnostics.printSandboxDiagnostics({ home: join(tmp, 'missing-home'), from, to, logsRoot: join(tmp, 'missing'), terminal: 'CreateProcessAsUserW failed: 5' }, file)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.logs[0].unavailable).toBe('ENOENT')
      expect(saved.terminal).toContain('CreateProcessAsUserW failed: 5')
      expect(output.every((s) => s.startsWith('DIAGNOSTIC '))).toBe(true)
      expect(() => diagnostics.printSandboxDiagnostics({ home: join(tmp, 'missing-home'), from, to, logsRoot: join(tmp, 'missing') }, join(tmp, 'no-parent', 'evidence.json'))).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses the user’s Codex home before reading it', () => {
    const home = join(process.env.USERPROFILE || homedir(), '.codex')
    expect(() => diagnostics.collectSandboxDiagnostics({ home, from, to })).toThrow('require a test Codex home')
  })
})
