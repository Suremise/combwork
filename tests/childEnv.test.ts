// A session's environment (#567, #589): Combwork's own CW_ variables are dropped from it. SESSION_SETTINGS names the ones a
// session keeps on purpose, none today: the test-slot count is the test folder's config.json, which needs no passing on.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lydell/node-pty', () => ({ spawn: () => undefined }))
vi.mock('../src/main/events', () => ({ sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [{ envToStrip: ['CLAUDECODE'] }] }))

const { childEnv, SESSION_SETTINGS } = await import('../src/main/ptyHost')

const set = (vars: Record<string, string>): void => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v)
}
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("a session's environment", () => {
  it("drops every CW_ variable while the list is empty: Combwork's own, the test copies' settings and the slot count, and a session's identity", () => {
    expect([...SESSION_SETTINGS]).toEqual([])
    set({ CW_TEST_HEAVY_SLOTS: '4', CW_API_TOKEN: 'secret', CW_AGENT_ID: 'a-1', CW_TEST_QUIET: '1', CW_TEST_HEAVY_DIR: 'C:/pool', CW_USER_DATA: 'C:/profile', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crashpad_1_X', CW_TEST_SOMETHING_ELSE: 'x' })
    const env = childEnv()
    expect(Object.keys(env).filter((k) => k.startsWith('CW_'))).toEqual([])
    // Combwork's crash handler (#985) too: an app the agent starts keeps its crashes to itself.
    for (const k of ['CLAUDECODE', 'ELECTRON_RUN_AS_NODE', 'CHROME_CRASHPAD_PIPE_NAME']) expect(env[k], k).toBeUndefined()
  })

  it("drops inherited CW_ variables, so a session gets only those Combwork gives it now", () => {
    // A session started from a shell inside another Combwork session inherits that one's identity.
    set({ CW_API_TOKEN_FILE: 'C:/other/token.json', CW_AGENT: 'HB9', CW_SLOT: 'slot-z', CW_API_URL: 'http://127.0.0.1:1', CWD_LIKE: 'kept', CWX: 'kept' })
    const env = childEnv({ CW_AGENT: 'HB2', CW_API_URL: 'http://127.0.0.1:47822' })
    expect(Object.keys(env).filter((k) => k.startsWith('CW_')).sort()).toEqual(['CW_AGENT', 'CW_API_URL'])
    expect([env.CW_AGENT, env.CW_API_URL]).toEqual(['HB2', 'http://127.0.0.1:47822'])
    expect([env.CWD_LIKE, env.CWX]).toEqual(['kept', 'kept'])
  })

  it('keeps a name added to the list, and only that one; what the session is given wins', () => {
    set({ CW_KEPT_FOR_TEST: 'yes', CW_API_TOKEN: 'secret' })
    SESSION_SETTINGS.add('CW_KEPT_FOR_TEST')
    try {
      const env = childEnv()
      expect(Object.keys(env).filter((k) => k.startsWith('CW_'))).toEqual(['CW_KEPT_FOR_TEST'])
      expect(childEnv({ CW_KEPT_FOR_TEST: 'given' }).CW_KEPT_FOR_TEST).toBe('given')
    } finally {
      SESSION_SETTINGS.delete('CW_KEPT_FOR_TEST')
    }
    expect(childEnv().CW_KEPT_FOR_TEST).toBeUndefined()
  })
})
