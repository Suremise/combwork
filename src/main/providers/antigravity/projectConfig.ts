import { dirname, join, resolve } from 'path'
import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'

// The customizations agy would load from an agent's workspace folders (HI-2544), read before it starts so the agent's
// private profile can override what it wasn't given. agy reads `.agents\` (and the legacy `.agent\`, `_agents\`,
// `_agent\`) in each workspace folder and each parent up to the repository root (its customization discovery, checked with
// 1.5.0): the folder it runs in and each --add-dir. MCP servers in mcp_config.json, hooks in hooks.json.

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

/** One config file's top-level names (`key`: its object of names, or the file's own top level), or none when it's absent. */
async function namesIn(file: string, key: string | null): Promise<string[]> {
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
    j = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new UnreadableConfig(file, e instanceof Error ? e.message : String(e))
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new UnreadableConfig(file, 'not a JSON object')
  const obj = key ? (j as Record<string, unknown>)[key] : j
  if (obj === undefined) return []
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new UnreadableConfig(file, `${key} is not an object`)
  return Object.keys(obj)
}

/**
 * The MCP servers and named hooks agy would load from these workspace folders (each scanned up to its repository root),
 * with the files they come from. An unreadable or invalid file throws UnreadableConfig.
 */
export async function workspaceCustomizations(folders: readonly string[]): Promise<{ servers: Map<string, string>; hooks: Map<string, string> }> {
  const servers = new Map<string, string>()
  const hooks = new Map<string, string>()
  const seen = new Set<string>()
  for (const folder of folders) {
    for (const d of scannedFolders(folder)) {
      for (const dot of DOT_DIRS) {
        const base = join(d, dot)
        if (seen.has(base.toLowerCase())) continue
        seen.add(base.toLowerCase())
        const mcp = join(base, 'mcp_config.json')
        for (const n of await namesIn(mcp, 'mcpServers')) if (!servers.has(n)) servers.set(n, mcp)
        const hk = join(base, 'hooks.json')
        for (const n of await namesIn(hk, null)) if (!hooks.has(n)) hooks.set(n, hk)
      }
    }
  }
  return { servers, hooks }
}
