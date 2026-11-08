// The fakes' refusal of an old release's names (HI-2614, tests/e2e/fake-claude/oldDialect.cjs): a launch given the
// variables, MCP server or tools a release before 1.1 named stops instead of reading them, so no test passes on them.
// The old-release mode that read them, for the retired 0.9 upgrade suite, is gone (HI-2741, HI-2742).
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const old = require('./e2e/fake-claude/oldDialect.cjs') as {
  oldDialectIn: (env: Record<string, string>, servers?: Record<string, unknown>) => string[]
  toolName: (name: string) => string | null
}
const bridge = require('./e2e/fake-bridge.cjs') as { parseToolStep: (step: string) => { tool: string; args: unknown } | null }

// old-name: begin fakeOldDialect-inputs
/** The old release's prefix for variables, its MCP server's name and a tool of its. */
const P = 'HIVE_'
const SERVER = 'hive'
const TOOL = 'hive_lane'
// old-name: end fakeOldDialect-inputs
const OLD_ENV = { [`${P}API_TOKEN_FILE`]: 'C:\\t.json', [`${P}AGENT`]: 'b1' }
const combwork = { command: 'node', env: {} }
const oldServer = { command: 'node', env: {} }

describe("the fakes refuse an old release's names (HI-2614)", () => {
  it('finds its variables, and its server without a current one', () => {
    expect(old.oldDialectIn(OLD_ENV, {})).toEqual([`${P}API_TOKEN_FILE`, `${P}AGENT`])
    expect(old.oldDialectIn({}, { [SERVER]: oldServer })).toEqual([`its MCP server "${SERVER}"`])
    expect(old.oldDialectIn({}, { [SERVER]: oldServer, combwork })).toEqual([])
    expect(old.oldDialectIn({ CW_AGENT: 'b1' }, { combwork })).toEqual([])
  })

  it('a current tool name passes, an old one throws, anything else is no tool', () => {
    expect(old.toolName('cw_lane')).toBe('cw_lane')
    expect(() => old.toolName(TOOL)).toThrow(new RegExp(`old tool name ${TOOL}`))
    expect(old.toolName('say')).toBeNull()
  })

  it("the bridge's scripted steps: a current tool parses; an old one is refused", () => {
    expect(bridge.parseToolStep('cw cw_lane {"action":"next"}')).toEqual({ tool: 'cw_lane', args: { action: 'next' } })
    expect(() => bridge.parseToolStep(`cw ${TOOL} {"action":"next"}`)).toThrow(/old tool name/)
    expect(bridge.parseToolStep('say hello')).toBeNull()
  })

  it('the old-release mode is gone: no wrapper, no flag, no suite asking for it (HI-2742)', () => {
    const e2e = join(import.meta.dirname, 'e2e')
    expect(existsSync(join(e2e, 'fake-claude', 'fake-claude-old-release.cmd'))).toBe(false)
    expect(existsSync(join(e2e, 'fake-claude', 'oldRelease.cjs'))).toBe(false)
    const asking = readdirSync(e2e).filter((f) => /\.(cjs|mjs)$/.test(f) && /oldRelease|CW_FAKE_OLD_RELEASE/.test(readFileSync(join(e2e, f), 'utf8')))
    expect(asking).toEqual([])
  })
})
