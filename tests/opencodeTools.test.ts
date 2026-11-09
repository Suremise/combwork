// What an OpenCode agent is given (HI-2761): Combwork's skills copied into its private config folder's `skills`, the one
// folder 2.2.6 reads with both discovery switches on (HI-2761's R0b, tests/fixtures/opencode/real-2.2.6/skills); the MCP
// policies (every server denied but those given, unless the launch is the whole "as from a terminal" preset with no
// server and the project's config let in); and Combwork's guidance only with its tools.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-opencode-tools-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { copyOpencodeSkills, opencodeSkillsDir } = await import('../src/main/providers/opencode/skills')
const { launchConfig, projectDecidesMcp } = await import('../src/main/providers/opencode/config')
const { launchGuidance } = await import('../src/main/providers/opencode/adapter')
const { TOOLS_SERVER } = await import('../src/shared/assistantTools')
const require = createRequire(import.meta.url)
const fakeConfig = require('./e2e/fake-opencode/config.cjs') as { load: (dir: string | null, env: Record<string, string>) => { loaded: { kind: string; path: string }[]; instructions: string[] } }

const skill = (root: string, name: string, body = `---\nname: ${name}\ndescription: ${name} for tests\n---\nBody of ${name}\n`) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), body)
  return { name, sourcePath: join(root, name), revision: '' }
}
const R0B = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'opencode', 'real-2.2.6', 'skills', 'config-dir.json'), 'utf8')) as { configDir: Record<string, string>; codewordsInRequest: string[]; availableSkills: string; skillTool: { function: { name: string; parameters: { required: string[] } } } }

describe("an OpenCode launch's skills, in its private config folder (HI-2761)", () => {
  it('copies each skill given, with its revision, into the skills folder 2.2.6 reads', async () => {
    const src = tempDir('oc-skills-src-')
    const config = join(tempDir('oc-skills-'), 'opencode-config')
    const got = await copyOpencodeSkills(opencodeSkillsDir(config), [skill(src, 'work-on-card'), skill(src, 'card-loop')])
    expect(Object.keys(got).sort()).toEqual(['card-loop', 'work-on-card'])
    for (const d of Object.values(got)) expect(d).toEqual({ revision: expect.stringMatching(/\S/) })
    expect(readFileSync(join(config, 'skills', 'work-on-card', 'SKILL.md'), 'utf8')).toContain('Body of work-on-card')
  })

  it('leaves nothing of a skill no longer given, and none at all for a launch given none (an Independent one)', async () => {
    const src = tempDir('oc-skills-src-')
    const dir = opencodeSkillsDir(join(tempDir('oc-skills-'), 'opencode-config'))
    await copyOpencodeSkills(dir, [skill(src, 'a'), skill(src, 'b')])
    writeFileSync(join(dir, 'stray.txt'), 'left by something else')
    await copyOpencodeSkills(dir, [skill(src, 'a')])
    expect(existsSync(join(dir, 'a', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'b'))).toBe(false)
    expect(existsSync(join(dir, 'stray.txt'))).toBe(false)
    expect(await copyOpencodeSkills(dir, [])).toEqual({})
    expect(existsSync(dir)).toBe(false)
  })

  it("one skill's missing source is its own problem, never the launch's", async () => {
    const src = tempDir('oc-skills-src-')
    const dir = opencodeSkillsDir(join(tempDir('oc-skills-'), 'opencode-config'))
    const got = await copyOpencodeSkills(dir, [skill(src, 'fine'), { name: 'gone', sourcePath: join(src, 'gone'), revision: '' }])
    expect(got.fine.revision).toBeTruthy()
    expect(got.gone).toMatchObject({ revision: null, problem: expect.any(String) })
    expect(existsSync(join(dir, 'gone'))).toBe(false)
  })

  it('as 2.2.6 offered skills from its config folder (R0b), the fake offers what Combwork copies there', () => {
    // R0b's config folder rebuilt, read by the fake's discovery with both switches on: the skills 2.2.6 listed (its own two
    // built-ins aside), and the config folder's AGENTS.md as an instruction.
    const cfg = tempDir('oc-r0b-cfg-')
    for (const [rel, text] of Object.entries(R0B.configDir)) {
      mkdirSync(join(cfg, rel, '..'), { recursive: true })
      writeFileSync(join(cfg, rel), text)
    }
    const listed = [...R0B.availableSkills.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]).filter((id) => id !== 'opencode' && id !== 'report')
    const loaded = fakeConfig.load(null, { OPENCODE_CONFIG_DIR: cfg, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', USERPROFILE: tempDir('oc-r0b-home-') })
    expect(loaded.loaded.filter((l) => l.kind === 'skill').map((l) => l.path.split(/[\\/]/).pop()).sort()).toEqual(listed.sort())
    expect(loaded.instructions).toEqual([join(cfg, 'AGENTS.md')])
    // The tool the fake calls a skill with is 2.2.6's: `skill`, by its id.
    expect([R0B.skillTool.function.name, R0B.skillTool.function.parameters.required]).toEqual(['skill', ['id']])
  })
})

describe("an OpenCode launch's MCP policies (HI-2761, HR1's design check)", () => {
  const input = (over: Partial<Parameters<typeof launchConfig>[0]> = {}) => ({ model: null, agent: null, mcpServers: {}, instructions: [], ambient: [], saved: null, strip: true, noUpdate: true, ...over })
  const mcpRules = (c: Record<string, unknown>) => (c.policies as { action: string; resource: string; effect: string }[]).filter((p) => p.action === 'mcp.use')
  const providerRules = (c: Record<string, unknown>) => (c.policies as { action: string; resource: string; effect: string }[]).filter((p) => p.action === 'provider.use')

  it('leaves the servers to the project only for the terminal preset, with no server given and its config let in', () => {
    expect(projectDecidesMcp({ asFromTerminal: true, servers: 0, keepOut: false })).toBe(true)
    // Never inferred from servers alone: a managed launch with none, a terminal one with one, or the project kept out.
    expect(projectDecidesMcp({ asFromTerminal: false, servers: 0, keepOut: false })).toBe(false)
    expect(projectDecidesMcp({ asFromTerminal: true, servers: 1, keepOut: false })).toBe(false)
    expect(projectDecidesMcp({ asFromTerminal: true, servers: 0, keepOut: true })).toBe(false)
  })

  it('denies every server but those given otherwise, and denies Claude Agent in every case', () => {
    const managed = launchConfig(input({ mcpServers: { [TOOLS_SERVER]: { command: 'node', args: ['cw-mcp.js'], env: { CW_MCP_TOKEN: 't' } }, docs: { command: 'docs' } } }))
    expect(mcpRules(managed)).toEqual([{ action: 'mcp.use', resource: '*', effect: 'deny' }, { action: 'mcp.use', resource: TOOLS_SERVER, effect: 'allow' }, { action: 'mcp.use', resource: 'docs', effect: 'allow' }])
    const empty = launchConfig(input())
    expect(mcpRules(empty)).toEqual([{ action: 'mcp.use', resource: '*', effect: 'deny' }])
    const terminal = launchConfig(input({ projectDecidesMcp: true, strip: false }))
    expect(mcpRules(terminal)).toEqual([])
    for (const c of [managed, empty, terminal]) expect(providerRules(c)).toContainEqual({ action: 'provider.use', resource: 'claude-agent', effect: 'deny' })
  })

  it("puts Combwork's guidance in the config folder's AGENTS.md only with Combwork's tools", () => {
    const ctx = { guidance: 'Use cw_inbox.', instructions: '', notes: '' }
    expect(launchGuidance({ ...ctx, mcpServers: { [TOOLS_SERVER]: { command: 'x' } } })).toContain('Use cw_inbox.')
    expect(launchGuidance({ ...ctx, mcpServers: {} })).toBe('')
  })
})
