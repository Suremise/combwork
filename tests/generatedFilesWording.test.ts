// The files Combwork writes into projects and workspaces say Combwork (HI-2580), and what Hive wrote in them before 1.1
// is still recognised as Combwork's own: the .combwork folder's README, its .gitignore and the Assistant's, the comment
// above the skill copies' lines in a repository's info/exclude, and each launch folder's README.txt.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { ASSISTANT_GITIGNORE, BOARD_GITIGNORE, HANDOVER_README, WORKSPACE_README, withUsageIgnore } from '../src/main/workspace'
import { COPIES_EXCLUDE_COMMENT, excludeCopies } from '../src/main/providers/common'
import { LAUNCH_README } from '../src/main/providers/claude/adapter'

/** Hive's .combwork/.gitignore before #1106 added the usage history's lines. */
const OLD_GITIGNORE = "# The task board's database and what moving it from files left (added by Hive, #1017)\nhive.db\nhive.db-*\nbackups/\n"

describe('the wording of the files Combwork writes (HI-2580)', () => {
  it('says Combwork, never Hive, and links the repository', () => {
    for (const text of [WORKSPACE_README, BOARD_GITIGNORE, ASSISTANT_GITIGNORE, HANDOVER_README, COPIES_EXCLUDE_COMMENT, LAUNCH_README]) {
      expect(text).toMatch(/Combwork/)
      expect(text).not.toMatch(/\bHive\b/)
    }
    expect(WORKSPACE_README).toContain('[Combwork](https://github.com/Suremise/combwork)')
    // The database's file keeps its name for now.
    expect(WORKSPACE_README).toContain('`hive.db`')
  })
})

describe("the .combwork folder's .gitignore", () => {
  it("adds the usage history's lines to Combwork's own, and to Hive's", () => {
    const head = BOARD_GITIGNORE.split('\n')[0]
    expect(withUsageIgnore(`${head}\nhive.db\n`)).toBe(`${head}\nhive.db\n# What each session used: the usage history (#1106)\nusage.db\nusage.db-*\n`)
    expect(withUsageIgnore(OLD_GITIGNORE)).toBe(`${OLD_GITIGNORE}# What each session used: the usage history (#1106)\nusage.db\nusage.db-*\n`)
    // CRLF kept, and a last line without its newline ended first.
    expect(withUsageIgnore(OLD_GITIGNORE.replace(/\n/g, '\r\n').replace(/\r\n$/, ''))).toBe(`${OLD_GITIGNORE.replace(/\n/g, '\r\n')}# What each session used: the usage history (#1106)\r\nusage.db\r\nusage.db-*\r\n`)
  })

  it("leaves the user's own, and one that has them already", () => {
    expect(withUsageIgnore('# mine\nhive.db\n')).toBeNull()
    expect(withUsageIgnore(BOARD_GITIGNORE)).toBeNull()
    expect(withUsageIgnore(`${OLD_GITIGNORE}usage.db\n`)).toBeNull()
  })
})

describe("the skill copies' lines in info/exclude", () => {
  const repo = (): { dir: string; exclude: string } => {
    const dir = tempDir('hive-copies-exclude-')
    execFileSync('git', ['init', '-q', dir])
    const exclude = join(dir, '.git', 'info', 'exclude')
    mkdirSync(join(exclude, '..'), { recursive: true })
    return { dir, exclude }
  }

  it("writes Combwork's comment above them", async () => {
    const { dir, exclude } = repo()
    writeFileSync(exclude, '')
    await excludeCopies(dir)
    expect(readFileSync(exclude, 'utf8')).toBe(`${COPIES_EXCLUDE_COMMENT}\n/.agents/skills/cw-*/\n/.agents/skills/.cw-*/\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\n`)
  })

  it("takes Hive's comment for Combwork's own: no second comment", async () => {
    const { dir, exclude } = repo()
    writeFileSync(exclude, "# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\n")
    await excludeCopies(dir)
    const text = readFileSync(exclude, 'utf8')
    expect(text).toBe("# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\n/.agents/skills/cw-*/\n/.agents/skills/.cw-*/\n")
    expect(text).not.toContain(COPIES_EXCLUDE_COMMENT)
  })
})
