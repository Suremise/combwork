// A unit test that sets no CLI home gets an empty one of its own, never the user's ~/.claude, ~/.codex or ~/.copilot
// (tests/cliHomes.ts, HI-1703).
import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { claudeHome } from '../src/main/providers/claude/adapter'
import { codexHome } from '../src/main/providers/codex/adapter'
import { copilotHome } from '../src/main/providers/copilot/home'
import { tempArea } from './tempDir'

describe("the unit run's CLI homes (HI-1703)", () => {
  it("are empty folders in the tests' temp area, not the user's", () => {
    for (const [cli, home] of [['claude', claudeHome()], ['codex', codexHome()], ['copilot', copilotHome()]]) {
      expect(home, cli).not.toBe(join(homedir(), `.${cli}`))
      expect(relative(tempArea, home).startsWith('..'), `${cli}: ${home}`).toBe(false)
      expect(readdirSync(home), cli).toEqual([])
    }
  })
})
