/**
 * The process-wide dialect of hive-mcp.js and hive-progress.js (dialects, HI-2065): one process serves one session, so
 * its chain is the process's. Hive writes the session's resolved texts (only the overrides, merged down the chain) to a
 * file in the launch's private folder and names it in `CW_DIALECT_FILE`, with `CW_DIALECT` the chain's hash.
 * Importing this loads it, before the entry's own code renders any text: each entry imports it first. With no file, or
 * one that can't be read, the process speaks the Default (silently: hive-progress's output is the user's command's).
 * Node's fs: these scripts run as plain Node, outside the asar.
 */
import { readFileSync } from 'fs'
import { setProcessChain, type DialectChain } from './index'

/** The chain a dialect file holds, or null when it isn't one: `{ texts: { id: text }, files?: [...], hash? }`. */
export function chainFromFile(raw: string, hash = ''): DialectChain | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as { texts?: unknown; files?: unknown; hash?: unknown }
  if (!d.texts || typeof d.texts !== 'object' || Array.isArray(d.texts)) return null
  const texts: Record<string, string> = {}
  for (const [id, text] of Object.entries(d.texts as Record<string, unknown>)) if (typeof text === 'string') texts[id] = text
  const files = Array.isArray(d.files) ? d.files.filter((f): f is string => typeof f === 'string') : []
  return { texts, files, hash: typeof d.hash === 'string' ? d.hash : hash }
}

/** Loads the process's chain from its environment: the file CW_DIALECT_FILE names, else the Default (null). */
export function loadProcessDialect(env: Record<string, string | undefined> = process.env): DialectChain | null {
  const file = env.CW_DIALECT_FILE
  let chain: DialectChain | null = null
  if (file) {
    try {
      chain = chainFromFile(readFileSync(file, 'utf8'), env.CW_DIALECT ?? '')
    } catch {
      chain = null
    }
  }
  setProcessChain(chain)
  return chain
}

loadProcessDialect()
