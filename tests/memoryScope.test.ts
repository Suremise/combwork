// Whom each Memory row's file applies to (HI-2667), as each provider lists it: the project's files have no scope, the
// user's own file (no connections in the workspace) is 'user', and a connection's (tests/connections.test.ts) is that
// connection's. A new file's first lines follow it (instructionsStarter, tests/i18n/project.test.ts).
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')

const project = join(tempDir('cw-memory-scope-'), 'alpha')

describe("each Memory row's scope (HI-2667)", () => {
  for (const [name, adapter, projectIds] of [
    ['Claude Code', claudeCode, ['project', 'project-dot', 'local']],
    ['Codex', codex, ['project']],
    ['Copilot', copilot, ['project', 'project-github']]
  ] as const) {
    it(`${name}: its project's files have none, its user file is the user's (every project)`, async () => {
      const rows = (await adapter.memorySources(project)).filter((s) => s.kind !== 'auto-memory')
      expect(rows.filter((s) => s.scope === undefined).map((s) => s.id)).toEqual([...projectIds])
      expect(rows.filter((s) => s.scope !== undefined).map((s) => [s.id, s.scope])).toEqual([['user', 'user']])
    })
  }

  it("Claude Code and Codex on connections: each connection's file is that connection's, by its name", async () => {
    const homes = [{ id: 'a-1', name: 'Anthropic-1', home: join(project, 'h1') }, { id: 'a-2', name: 'Work', home: join(project, 'h2') }]
    for (const adapter of [claudeCode, codex]) {
      const users = (await adapter.memorySources(project, homes)).filter((s) => s.id.startsWith('user'))
      expect(users.map((s) => [s.id, s.scope])).toEqual([
        ['user:a-1', { connection: 'Anthropic-1' }],
        ['user:a-2', { connection: 'Work' }]
      ])
    }
  })
})
