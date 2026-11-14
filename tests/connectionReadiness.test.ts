// HI-3278: a CLI that signs in per connection (Claude Code since HI-1755, Codex) never checks its own home's sign-in,
// which its agents don't use: a user signed in only through a connection got "Codex is not signed in" for ever. On its
// own home (the test seam), the CLI's sign-in is what its agents use, so a signed-out one still says so. Provider
// Setup's connection line warns when every account on in the workspace is signed out (noneSignedInHere).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../src/shared/types'
import type { ConnectionsView } from '../src/shared/accounts'
import { noneSignedInHere } from '../src/shared/connectionLabel'
import { tempDir } from './tempDir'

/** Each per-connection CLI: its executable, its version answer, and what its own sign-in check says signed out. */
const PROVIDERS = [
  { id: 'claude-code', exe: 'claude.exe', version: '2.1.312 (Claude Code)', signedOut: '{"loggedIn":false}', status: ['auth', 'status', '--json'], load: async () => (await import('../src/main/providers/claude/adapter')).claudeCode },
  { id: 'codex', exe: 'codex.exe', version: 'codex-cli 0.164.0', signedOut: 'Not logged in', status: ['login', 'status'], load: async () => (await import('../src/main/providers/codex/adapter')).codex }
]

const dirs: string[] = []
afterEach(() => {
  vi.doUnmock('../src/main/config')
  vi.doUnmock('../src/main/providers/common')
  vi.doUnmock('../src/main/connectionSeam')
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The adapter with its CLI at a path of the test's, its own home signed out, its connections managing sign-in or not. */
async function located(p: (typeof PROVIDERS)[number], managed: boolean) {
  const dir = tempDir('cw-signin-')
  dirs.push(dir)
  const exe = join(dir, 'bin', p.exe)
  mkdirSync(dirname(exe), { recursive: true })
  writeFileSync(exe, '')
  // Codex's sandbox items read its home's config: an empty home of the test's, never the user's ~/.codex.
  vi.stubEnv('CODEX_HOME', join(dir, 'codex-home'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'claude-home'))
  const calls: string[][] = []
  vi.resetModules()
  vi.doMock('../src/main/config', () => ({ config: { settings: { providers: { [p.id]: { executablePath: exe } } } } }))
  vi.doMock('../src/main/connectionSeam', async (actual) => ({ ...(await actual<typeof import('../src/main/connectionSeam')>()), connectionsManaged: () => managed }))
  vi.doMock('../src/main/providers/common', async (actual) => ({
    ...(await actual<typeof import('../src/main/providers/common')>()),
    run: async (file: string, args: string[] = []) => {
      if (file !== exe) return { stdout: '', stderr: '', code: 1 }
      calls.push(args)
      if (args[0] === '--version') return { stdout: p.version, stderr: '', code: 0 }
      if (args.join(' ') === p.status.join(' ')) return { stdout: p.signedOut, stderr: '', code: 1 }
      return { stdout: '', stderr: '', code: 1 }
    }
  }))
  const adapter = await p.load()
  const info = await adapter.locate()
  return { info, issues: adapter.readiness(info).map((r) => r.id), statusChecked: calls.some((a) => a.join(' ') === p.status.join(' ')) }
}

describe('readiness of a CLI that signs in per connection (HI-3278)', () => {
  for (const p of PROVIDERS) {
    it(`${p.id}: signed in through a connection, its own home signed out: its home isn't checked, and nothing says it isn't signed in`, async () => {
      const { info, issues, statusChecked } = await located(p, true)
      expect(info.found).toBe(true)
      expect(statusChecked).toBe(false)
      expect(info.loggedIn).toBeNull()
      expect(issues).not.toContain('signed-out')
    })

    it(`${p.id}: on its own home (no connections manage it), a signed-out home still says so`, async () => {
      const { info, issues, statusChecked } = await located(p, false)
      expect(statusChecked).toBe(true)
      expect(info.loggedIn).toBe(false)
      expect(issues).toContain('signed-out')
    })
  }
})

describe("Provider Setup's connection line: every account on here signed out (noneSignedInHere)", () => {
  const acc = (id: string, o: Partial<Account> = {}): ConnectionsView['connections'][number] => ({ id, provider: 'codex', name: id, createdAt: '2026-11-14T00:00:00.000Z', signingIn: false, folder: join('C:\\accounts', id), ...o })
  const view = (connections: ConnectionsView['connections'], on: string[]): Pick<ConnectionsView, 'connections' | 'workspace'> => ({ connections, workspace: { codex: { on, default: on[0] ?? null } } })
  const out = { at: '2026-11-14T00:00:00.000Z', loggedIn: false }
  const inn = { at: '2026-11-14T00:00:00.000Z', loggedIn: true }

  it('warns when each account on is signed out', () => {
    expect(noneSignedInHere(view([acc('a', { observed: out }), acc('b', { observed: out })], ['a', 'b']), 'codex')).toBe(true)
  })

  it.each([
    ['one of them signed in', view([acc('a', { observed: out }), acc('b', { observed: inn })], ['a', 'b'])],
    ['one not checked yet', view([acc('a', { observed: out }), acc('b')], ['a', 'b'])],
    ['one whose check failed (unknown)', view([acc('a', { observed: out }), acc('b', { observed: { at: out.at, loggedIn: null, error: 'timed out' } })], ['a', 'b'])],
    ['a server account on (no sign-in)', view([acc('a', { observed: out }), acc('s', { kind: 'server' })], ['a', 's'])],
    ['none on (said its own way)', view([acc('a', { observed: out })], [])],
    ['a signed-out account that is off here', view([acc('a', { observed: out }), acc('b', { observed: inn })], ['b'])]
  ])('never with %s', (_what, v) => {
    expect(noneSignedInHere(v, 'codex')).toBe(false)
  })
})
