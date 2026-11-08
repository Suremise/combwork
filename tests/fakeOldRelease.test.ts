// The fakes' old-release mode (HI-2614, tests/e2e/fake-claude/oldRelease.cjs): upgradelane's released 0.9 build
// launched the fake with it on; that suite is retired (HI-2741), and HI-2742 decides the mode's own retirement. A current launch refuses the old dialect (the old release's variables, server and tools)
// instead of reading it; in old mode each maps, and the current names still work.
import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const old = require('./e2e/fake-claude/oldRelease.cjs') as {
  FLAG: string
  on: (env?: Record<string, string | undefined>) => boolean
  oldDialectIn: (env: Record<string, string>, servers?: Record<string, unknown>) => string[]
  envOf: (env: Record<string, string>, mode?: boolean) => Record<string, string>
  serverOf: (servers: Record<string, unknown>, mode?: boolean) => unknown
  toolName: (name: string, mode?: boolean) => string | null
}
const bridge = require('./e2e/fake-bridge.cjs') as { parseToolStep: (step: string) => { tool: string; args: unknown } | null }

// old-name: begin fakeOldRelease-inputs
/** The old release's prefix for variables, its MCP server's name and a tool of its. */
const P = 'HIVE_'
const SERVER = 'hive'
const TOOL = 'hive_lane'
// old-name: end fakeOldRelease-inputs
const OLD_ENV = { [`${P}API_TOKEN_FILE`]: 'C:\\t.json', [`${P}AGENT`]: 'b1' }
const combwork = { command: 'node', env: {} }
const oldServer = { command: 'node', env: {} }

describe("the fakes' old-release mode (HI-2614)", () => {
  it('is on only with its flag set to 1', () => {
    expect(old.on({})).toBe(false)
    expect(old.on({ [old.FLAG]: '0' })).toBe(false)
    expect(old.on({ [old.FLAG]: '1' })).toBe(true)
  })

  it('current mode: the old dialect is found, never read', () => {
    expect(old.oldDialectIn(OLD_ENV, {})).toEqual([`${P}API_TOKEN_FILE`, `${P}AGENT`])
    expect(old.oldDialectIn({}, { [SERVER]: oldServer })).toEqual([`its MCP server "${SERVER}"`])
    expect(old.oldDialectIn({ CW_AGENT: 'b1' }, { combwork })).toEqual([])
    expect(old.envOf(OLD_ENV, false)).toEqual(OLD_ENV)
    expect(old.serverOf({ [SERVER]: oldServer }, false)).toBeNull()
    expect(() => old.toolName(TOOL, false)).toThrow(new RegExp(`old tool name ${TOOL}`))
  })

  it('old mode: each maps, and the current names still work', () => {
    expect(old.envOf(OLD_ENV, true)).toMatchObject({ CW_API_TOKEN_FILE: 'C:\\t.json', CW_AGENT: 'b1' })
    expect(old.envOf({ [`${P}AGENT`]: 'old', CW_AGENT: 'now' }, true).CW_AGENT).toBe('now')
    expect(old.serverOf({ [SERVER]: oldServer }, true)).toBe(oldServer)
    expect(old.serverOf({ [SERVER]: oldServer, combwork }, true)).toBe(combwork)
    expect(old.toolName(TOOL, true)).toBe(TOOL)
    expect(old.toolName('cw_lane', true)).toBe('cw_lane')
  })

  it("the bridge's scripted steps: a current tool parses; an old one is refused in a current launch", () => {
    expect(bridge.parseToolStep('cw cw_lane {"action":"next"}')).toEqual({ tool: 'cw_lane', args: { action: 'next' } })
    expect(() => bridge.parseToolStep(`cw ${TOOL} {"action":"next"}`)).toThrow(/old tool name/)
    expect(bridge.parseToolStep('say hello')).toBeNull()
  })

  it("only its wrapper sets the flag, and no suite is given the wrapper since upgradelane was retired (HI-2741)", () => {
    const e2e = join(import.meta.dirname, 'e2e')
    expect(readFileSync(join(e2e, 'fake-claude', 'fake-claude-old-release.cmd'), 'utf8')).toMatch(/^@set CW_FAKE_OLD_RELEASE=1\r?\n@node "%~dp0fake-claude\.cjs" %\*/)
    expect(readFileSync(join(e2e, 'fake-claude', 'fake-claude.cmd'), 'utf8')).not.toMatch(/CW_FAKE_OLD_RELEASE/)
    expect(readFileSync(join(e2e, 'runContext.cjs'), 'utf8')).not.toMatch(/CW_FAKE_OLD_RELEASE/)
    const given = readdirSync(e2e).filter((f) => /\.(cjs|mjs)$/.test(f) && /oldRelease: true/.test(readFileSync(join(e2e, f), 'utf8')))
    expect(given).toEqual([])
  })
})
