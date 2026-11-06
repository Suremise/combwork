// The fakes' old-release mode (HI-2614, tests/e2e/fake-claude/oldRelease.cjs): only upgradelane's released 0.9 build
// launches the fake with it on. A current launch refuses the old dialect (HIVE_* variables, the `hive` server, hive_*
// tools) instead of reading it; in old mode each maps, and the current names still work.
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

const OLD_ENV = { HIVE_API_TOKEN_FILE: 'C:\\t.json', HIVE_AGENT: 'b1' }
const combwork = { command: 'node', env: {} }
const hive = { command: 'node', env: {} }

describe("the fakes' old-release mode (HI-2614)", () => {
  it('is on only with its flag set to 1', () => {
    expect(old.on({})).toBe(false)
    expect(old.on({ [old.FLAG]: '0' })).toBe(false)
    expect(old.on({ [old.FLAG]: '1' })).toBe(true)
  })

  it('current mode: the old dialect is found, never read', () => {
    expect(old.oldDialectIn(OLD_ENV, {})).toEqual(['HIVE_API_TOKEN_FILE', 'HIVE_AGENT'])
    expect(old.oldDialectIn({}, { hive })).toEqual(['its MCP server "hive"'])
    expect(old.oldDialectIn({ CW_AGENT: 'b1' }, { combwork })).toEqual([])
    expect(old.envOf(OLD_ENV, false)).toEqual(OLD_ENV)
    expect(old.serverOf({ hive }, false)).toBeNull()
    expect(() => old.toolName('hive_lane', false)).toThrow(/old tool name hive_lane/)
  })

  it('old mode: each maps, and the current names still work', () => {
    expect(old.envOf(OLD_ENV, true)).toMatchObject({ CW_API_TOKEN_FILE: 'C:\\t.json', CW_AGENT: 'b1' })
    expect(old.envOf({ HIVE_AGENT: 'old', CW_AGENT: 'now' }, true).CW_AGENT).toBe('now')
    expect(old.serverOf({ hive }, true)).toBe(hive)
    expect(old.serverOf({ hive, combwork }, true)).toBe(combwork)
    expect(old.toolName('hive_lane', true)).toBe('hive_lane')
    expect(old.toolName('cw_lane', true)).toBe('cw_lane')
  })

  it("the bridge's scripted steps: a current tool parses; an old one is refused in a current launch", () => {
    expect(bridge.parseToolStep('cw cw_lane {"action":"next"}')).toEqual({ tool: 'cw_lane', args: { action: 'next' } })
    expect(() => bridge.parseToolStep('cw hive_lane {"action":"next"}')).toThrow(/old tool name/)
    expect(bridge.parseToolStep('say hello')).toBeNull()
  })

  it("only its wrapper sets the flag, and only upgradelane's old profile is given the wrapper", () => {
    const e2e = join(import.meta.dirname, 'e2e')
    expect(readFileSync(join(e2e, 'fake-claude', 'fake-claude-old-release.cmd'), 'utf8')).toMatch(/^@set CW_FAKE_OLD_RELEASE=1\r?\n@node "%~dp0fake-claude\.cjs" %\*/)
    expect(readFileSync(join(e2e, 'fake-claude', 'fake-claude.cmd'), 'utf8')).not.toMatch(/CW_FAKE_OLD_RELEASE/)
    expect(readFileSync(join(e2e, 'runContext.cjs'), 'utf8')).not.toMatch(/CW_FAKE_OLD_RELEASE/)
    const given = readdirSync(e2e).filter((f) => /\.(cjs|mjs)$/.test(f) && /oldRelease: true/.test(readFileSync(join(e2e, f), 'utf8')))
    expect(given).toEqual(['upgradelane.cjs'])
  })
})
