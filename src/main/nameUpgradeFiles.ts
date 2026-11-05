import { readdir, readFile } from 'original-fs/promises'
import { join } from 'path'
import { writeTextAtomic } from './fsutil'

/**
 * The names upgrade's rewrites of files Combwork keeps in a workspace (HI-2587, nameUpgrade.ts): text Hive wrote under
 * its names, rewritten once to Combwork's. Each is pure on the text (`upgraded*`, null when nothing is old) and written
 * only when it changed, atomically; what it doesn't recognise as its own is left byte for byte.
 */

/** The first line of the `.combwork/.gitignore` Hive wrote before 1.1, and Combwork's (workspace.ts BOARD_GITIGNORE). */
const OLD_GITIGNORE_HEAD = "# The task board's database and what moving it from files left (added by Hive, #1017)" // i18n-ignore: the .combwork folder's .gitignore, a file committed with the workspace
const GITIGNORE_HEAD = "# The task board's database and what moving it from files left (added by Combwork, #1017)" // i18n-ignore: as above

/**
 * The `.combwork/.gitignore`'s lines for the names upgrade's record (nameUpgrade.ts NAMES_DONE_FILE): this machine's, as
 * the board is, so a clone elsewhere upgrades its own. In workspace.ts's BOARD_GITIGNORE too.
 */
export const NAMES_IGNORE = "# The names upgrade's record on this machine (HI-2587)\ncombwork-names.json\n" // i18n-ignore: the .combwork folder's .gitignore, a file committed with the workspace

/**
 * A `.combwork/.gitignore` Combwork or Hive wrote with Combwork's head, the board's lines for `combwork.db` and the names
 * upgrade's record kept out; null when it is someone else's (another first line) or has nothing old. Only whole lines
 * change, each ending kept.
 */
export function upgradedGitignore(text: string): string | null {
  const lines = text.split('\n')
  const head = lines[0].replace(/\r$/, '')
  if (head !== OLD_GITIGNORE_HEAD && head !== GITIGNORE_HEAD) return null
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const out = lines.map((l, i) => {
    const cr = l.endsWith('\r') ? '\r' : ''
    const bare = cr ? l.slice(0, -1) : l
    if (i === 0) return GITIGNORE_HEAD + cr
    if (bare === 'hive.db') return 'combwork.db' + cr
    if (bare === 'hive.db-*') return 'combwork.db-*' + cr
    return l
  })
  let now = out.join('\n')
  if (!/^combwork-names\.json\r?$/m.test(now)) now = `${now}${now.endsWith('\n') || !now ? '' : nl}${NAMES_IGNORE.replace(/\n/g, nl)}`
  return now === text ? null : now
}

/**
 * The `.combwork/README.md` texts Hive and the 1.1 release candidates wrote (1.0's, still headed `.hive` after its
 * folder's move; HI-2462's; HI-2580's, naming `hive.db`): a README that is exactly one of them (either line ending) is
 * Combwork's own, never edited, and becomes `now` (WORKSPACE_README). Any other is the user's, left as it is.
 */
// i18n-ignore: a README committed with the workspace, in English, as Hive wrote it
const README_HI2462 = `# .combwork

This folder is managed by [Hive](https://github.com/) and is meant to be committed.

- \`shared/\` — notes, instructions and handovers shared across AI sessions and projects.
- \`skills/\` — Hive skills (one folder per skill, each with a \`SKILL.md\`). Every agent in every project gets them.
- \`mcp/\` — MCP server definitions (one \`<name>.json\` per server). Add them to projects in Hive.
- \`workspace.json\` — the workspace's settings, among them the MCP servers added for the Hive Assistant (a project's are in its \`.combwork/project.json\`).
- \`hive.db\` — the task board (Hive's database). It is this machine's, like the Assistant's sessions: \`.gitignore\` keeps it out of git.
- \`usage.db\` — what each session used (the usage history the Overviews read). It is this machine's too, kept out of git.

MCP definitions must not contain secrets. Reference environment variables instead, e.g. \`"\${GITHUB_TOKEN}"\`.
`

const oldReadmes = (now: string): string[] => [README_HI2462.replace('# .combwork', '# .hive').replace('`.combwork/project.json`', '`.hive/project.json`'), README_HI2462, now.replace('`combwork.db`', '`hive.db`')]

export function upgradedReadme(text: string, now: string): string | null {
  const crlf = text.includes('\r\n')
  const lf = text.replace(/\r\n/g, '\n')
  if (lf === now || !oldReadmes(now).includes(lf)) return null
  return crlf ? now.replace(/\n/g, '\r\n') : now
}

/** The old catalogue's address and the definitions' old folder variable (HI-2472, HI-2503), as stored definitions hold them. */
const OLD_CATALOG_URL = 'https://github.com/Suremise/hive-mcp/releases/latest/download/catalog.json'
const CATALOG_URL = 'https://github.com/Suremise/combwork-mcp/releases/latest/download/catalog.json'

/** A stored MCP definition's text with the new folder variable and catalogue address; null when it names neither old one. */
export function upgradedMcpDefinition(text: string): string | null {
  if (!text.includes('${HIVE_MCP_DIR}') && !text.includes(OLD_CATALOG_URL)) return null
  return text.split('${HIVE_MCP_DIR}').join('${CW_MCP_DIR}').split(OLD_CATALOG_URL).join(CATALOG_URL)
}

/** Rewrites a file when `f` changes it. Gone: nothing to do; unreadable: the step fails. */
async function rewrite(file: string, f: (t: string) => string | null): Promise<void> {
  const t = await readFile(file, 'utf8').catch(ifAbsent(null))
  if (t === null) return
  const now = f(t)
  if (now !== null) await writeTextAtomic(file, now)
}

/**
 * A step's way with a file or folder that isn't there (HI-2587, HR2's round 1): `value` for ENOENT only, every other
 * error thrown, so a folder that can't be read fails the step (and the upgrade isn't recorded done) rather than reading
 * as empty.
 */
export const ifAbsent = <T>(value: T) => (e: NodeJS.ErrnoException): T | Promise<never> => (e?.code === 'ENOENT' ? value : Promise.reject(e))

const mcpFiles = async (dir: string): Promise<string[]> => (await readdir(join(dir, 'mcp')).catch(ifAbsent([] as string[]))).filter((f) => f.endsWith('.json')).map((f) => join(dir, 'mcp', f))

/** Rewrites them (the names upgrade's `files` step). `readme`: the README Combwork writes now. */
export async function upgradeWorkspaceFiles(dir: string, readme: string): Promise<void> {
  await rewrite(join(dir, '.gitignore'), upgradedGitignore)
  await rewrite(join(dir, 'README.md'), (t) => upgradedReadme(t, readme))
  for (const f of await mcpFiles(dir)) await rewrite(f, upgradedMcpDefinition)
}
