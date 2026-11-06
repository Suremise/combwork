// The files Combwork writes into projects and workspaces say Combwork (HI-2580), and what 1.0 wrote in them before 1.1
// is rewritten once by the names upgrade (HI-2587, nameUpgradeFiles.ts and nameUpgradeProjects.ts), never recognised
// afterwards: the .combwork folder's README and .gitignore (its board lines for combwork.db too), the comments in a
// repository's info/exclude, and each launch folder's README.txt. A file the user wrote is left byte for byte.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { ASSISTANT_GITIGNORE, BOARD_GITIGNORE, HANDOVER_README, WORKSPACE_README, withUsageIgnore } from '../src/main/workspace'
import { COPIES_EXCLUDE_COMMENT, excludeCopies } from '../src/main/providers/common'
import { LAUNCH_README } from '../src/main/providers/claude/adapter'
import { upgradedGitignore, upgradedMcpDefinition, upgradedReadme } from '../src/main/nameUpgradeFiles'
import { upgradedExclude } from '../src/main/nameUpgradeProjects'
import { EXCLUDE_COMMENT } from '../src/shared/combworkFolderMove'

/** 1.0's .combwork/.gitignore before #1106 added the usage history's lines. */
// old-name: begin old-gitignore
const OLD_GITIGNORE = "# The task board's database and what moving it from files left (added by Hive, #1017)\nhive.db\nhive.db-*\nbackups/\n"
// old-name: end old-gitignore
const USAGE = '# What each session used: the usage history (#1106)\nusage.db\nusage.db-*\n'
const NAMES = "# The names upgrade's record on this machine (HI-2587)\ncombwork-names.json\n"

describe('the wording of the files Combwork writes (HI-2580)', () => {
  it('says Combwork, never the old name, and links the repository', () => {
    for (const text of [WORKSPACE_README, BOARD_GITIGNORE, ASSISTANT_GITIGNORE, HANDOVER_README, COPIES_EXCLUDE_COMMENT, LAUNCH_README]) {
      expect(text).toMatch(/Combwork/)
      // old-name: begin no-old-name
      expect(text).not.toMatch(/\bHive\b/)
      // old-name: end no-old-name
    }
    expect(WORKSPACE_README).toContain('[Combwork](https://github.com/Suremise/combwork)')
    expect(WORKSPACE_README).toContain('`combwork.db`')
    // old-name: begin no-old-board-lines
    expect(BOARD_GITIGNORE).not.toMatch(/hive/)
    // old-name: end no-old-board-lines
  })
})

describe("the .combwork folder's .gitignore", () => {
  it("1.0's is rewritten once: Combwork's head, the board's lines for combwork.db, the record kept out", () => {
    const head = BOARD_GITIGNORE.split('\n')[0]
    expect(upgradedGitignore(OLD_GITIGNORE)).toBe(`${head}\ncombwork.db\ncombwork.db-*\nbackups/\n${NAMES}`)
    expect(upgradedGitignore(`${OLD_GITIGNORE}${USAGE}`)).toBe(`${head}\ncombwork.db\ncombwork.db-*\nbackups/\n${USAGE}${NAMES}`)
    // CRLF kept.
    const crlf = upgradedGitignore(OLD_GITIGNORE.replace(/\n/g, '\r\n'))
    expect(crlf).toBe(`${head}\ncombwork.db\ncombwork.db-*\nbackups/\n${NAMES}`.replace(/\n/g, '\r\n'))
    // Then nothing more: the next open writes nothing.
    expect(upgradedGitignore(upgradedGitignore(OLD_GITIGNORE)!)).toBeNull()
    expect(upgradedGitignore(BOARD_GITIGNORE)).toBeNull()
  })

  it("the user's own is left, and 1.0's head is no longer Combwork's for the usage lines", () => {
    // old-name: begin users-own-gitignore
    expect(upgradedGitignore('# mine\nhive.db\n')).toBeNull()
    expect(withUsageIgnore(OLD_GITIGNORE)).toBeNull()
    expect(withUsageIgnore('# mine\nhive.db\n')).toBeNull()
    // old-name: end users-own-gitignore
  })

  it("adds the usage history's lines to Combwork's own once", () => {
    const head = BOARD_GITIGNORE.split('\n')[0]
    expect(withUsageIgnore(`${head}\ncombwork.db\n`)).toBe(`${head}\ncombwork.db\n${USAGE}`)
    expect(withUsageIgnore(BOARD_GITIGNORE)).toBeNull()
  })
})

describe("the .combwork folder's README", () => {
  it("1.0's, HI-2462's and HI-2580's become Combwork's; one the user edited is theirs", () => {
    // old-name: begin old-readme-hi2580
    const hi2580 = WORKSPACE_README.replace('`combwork.db`', '`hive.db`')
    // old-name: end old-readme-hi2580
    expect(upgradedReadme(hi2580, WORKSPACE_README)).toBe(WORKSPACE_README)
    expect(upgradedReadme(hi2580.replace(/\n/g, '\r\n'), WORKSPACE_README)).toBe(WORKSPACE_README.replace(/\n/g, '\r\n'))
    // old-name: begin old-readme-10
    const v10 = `# .hive\n\nThis folder is managed by [Hive](https://github.com/) and is meant to be committed.\n`
    // old-name: end old-readme-10
    expect(upgradedReadme(v10, WORKSPACE_README)).toBeNull()
    expect(upgradedReadme(`${hi2580}\nMy notes.\n`, WORKSPACE_README)).toBeNull()
    expect(upgradedReadme(WORKSPACE_README, WORKSPACE_README)).toBeNull()
  })
})

describe("stored MCP definitions", () => {
  it('take the new folder variable and catalogue address; others are left', () => {
    // old-name: begin old-mcp-definition
    const old = JSON.stringify({ command: '${HIVE_MCP_DIR}/srv/run.cmd', catalog: { source: 'https://github.com/Suremise/hive-mcp/releases/latest/download/catalog.json' } }, null, 2)
    // old-name: end old-mcp-definition
    expect(upgradedMcpDefinition(old)).toBe(JSON.stringify({ command: '${CW_MCP_DIR}/srv/run.cmd', catalog: { source: 'https://github.com/Suremise/combwork-mcp/releases/latest/download/catalog.json' } }, null, 2))
    expect(upgradedMcpDefinition('{"command":"${CW_MCP_DIR}/x"}')).toBeNull()
  })
})

describe('the comments in info/exclude', () => {
  const repo = (): { dir: string; exclude: string } => {
    const dir = tempDir('cw-copies-exclude-')
    execFileSync('git', ['init', '-q', dir])
    const exclude = join(dir, '.git', 'info', 'exclude')
    mkdirSync(join(exclude, '..'), { recursive: true })
    return { dir, exclude }
  }

  it("writes Combwork's comment above the copies' lines", async () => {
    const { dir, exclude } = repo()
    writeFileSync(exclude, '')
    await excludeCopies(dir)
    expect(readFileSync(exclude, 'utf8')).toBe(`${COPIES_EXCLUDE_COMMENT}\n/.agents/skills/cw-*/\n/.agents/skills/.cw-*/\n`)
  })

  it("1.0's comments become Combwork's once (HI-2575, HI-2580), the old copies' lines go (HI-2594), every other line as it was", () => {
    // old-name: begin old-exclude-lines
    const text = "# mine\n# Hive project metadata (added by Hive)\n/alpha/.combwork/\n# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\r\n/.agents/skills/cw-*/\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\r\n/hive-*/\n"
    expect(upgradedExclude(text)).toBe(`# mine\n${EXCLUDE_COMMENT}\n/alpha/.combwork/\n${COPIES_EXCLUDE_COMMENT}\r\n/.agents/skills/cw-*/\n/hive-*/\n`)
    // old-name: end old-exclude-lines
    expect(upgradedExclude(upgradedExclude(text)!)).toBeNull()
    expect(upgradedExclude('# mine\n/x/\n')).toBeNull()
  })

  it("1.0's comment is no longer taken for Combwork's: the copies get Combwork's", async () => {
    const { dir, exclude } = repo()
    // old-name: begin old-copies-comment
    writeFileSync(exclude, "# Hive's copies of workspace skills for Codex and Copilot (added by Hive)\n/.agents/skills/hive-*/\n/.agents/skills/.hive-*/\n")
    // old-name: end old-copies-comment
    await excludeCopies(dir)
    expect(readFileSync(exclude, 'utf8')).toContain(COPIES_EXCLUDE_COMMENT)
  })
})
