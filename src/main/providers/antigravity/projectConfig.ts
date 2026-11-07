import { dirname, join, resolve } from 'path'
import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'

// The MCP servers agy would load from an agent's workspace folders (HI-2544), read before it starts: a launch that would
// load one the agent wasn't given is refused (agy can't be kept from starting it, adapter.ts). agy reads `.agents\` (and
// the legacy `.agent\`, `_agents\`, `_agent\`) in each workspace folder and each parent up to the repository root (its
// customization discovery, checked with 1.5.0): the folder it runs in and each --add-dir. MCP servers in mcp_config.json.

export const DOT_DIRS = ['.agents', '.agent', '_agents', '_agent']

/** A config agy would read that Combwork couldn't: the launch is refused (fail closed), never read as empty. */
export class UnreadableConfig extends Error {
  constructor(
    readonly file: string,
    readonly why: string
  ) {
    super(`${file}: ${why}`)
  }
}

/** The folders agy scans for a workspace folder: it and each parent up to the repository root (the folder with .git). */
export function scannedFolders(folder: string): string[] {
  const out: string[] = []
  let d = resolve(folder)
  for (;;) {
    out.push(d)
    if (existsSync(join(d, '.git'))) break
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

/** One config file's MCP servers (its `mcpServers` object, by name), or none when it's absent. */
async function serversIn(file: string): Promise<[string, unknown][]> {
  if (!existsSync(file)) return []
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    throw new UnreadableConfig(file, e instanceof Error ? e.message : String(e))
  }
  if (!text.trim()) return []
  let j: unknown
  try {
    j = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new UnreadableConfig(file, e instanceof Error ? e.message : String(e))
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new UnreadableConfig(file, 'not a JSON object') // i18n-ignore: a parse diagnostic, shown inside the window's own message like an error's own words
  const obj = (j as Record<string, unknown>).mcpServers
  if (obj === undefined) return []
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new UnreadableConfig(file, 'mcpServers is not an object') // i18n-ignore: a parse diagnostic, shown inside the window's own message like an error's own words
  return Object.entries(obj)
}

/** A workspace MCP server agy would load: the file it comes from, and its definition as written. */
export type WorkspaceServer = { file: string; def: unknown }

/**
 * The MCP servers agy would load from these workspace folders (each scanned up to its repository root), by name, with
 * every definition of a name (which one agy uses isn't known, so each counts). An unreadable or invalid file throws
 * UnreadableConfig.
 */
export async function workspaceServers(folders: readonly string[]): Promise<Map<string, WorkspaceServer[]>> {
  const servers = new Map<string, WorkspaceServer[]>()
  const seen = new Set<string>()
  for (const folder of folders) {
    for (const d of scannedFolders(folder)) {
      for (const dot of DOT_DIRS) {
        const base = join(d, dot)
        if (seen.has(base.toLowerCase())) continue
        seen.add(base.toLowerCase())
        const file = join(base, 'mcp_config.json')
        for (const [n, def] of await serversIn(file)) servers.set(n, [...(servers.get(n) ?? []), { file, def }])
      }
    }
  }
  return servers
}
