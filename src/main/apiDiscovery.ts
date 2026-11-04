import { app } from 'electron'
import { readFileSync, unlinkSync } from 'original-fs'
import { join } from 'path'
import { readJson, removePath, writeJsonAtomic } from './fsutil'
import { createLogger } from './logger'

const log = createLogger('api')

/**
 * The discovery file (#620): how another app (Apiary) finds a running Combwork's Agent API without reading Combwork's private
 * config. `%APPDATA%\Combwork\agent-api-discovery.json` (the profile's folder) holds the URL and port, never a token; Combwork
 * writes it while the Agent API listens and removes it when the API stops listening or Combwork quits. A file left by a
 * Combwork that ended without quitting names a process that is gone: a client checks with GET /v1/health.
 */
export const discoveryFile = (): string => join(app.getPath('userData'), 'agent-api-discovery.json')

export async function writeDiscovery(d: { url: string; port: number; version: string; api: number }): Promise<void> {
  const body = { app: 'Combwork', version: d.version, api: d.api, url: d.url, port: d.port, pid: process.pid, startedAt: new Date().toISOString(), note: "Combwork's Agent API while it runs (no token: make a viewer token in Settings → Agent API). Removed when Combwork quits." }
  await writeJsonAtomic(discoveryFile(), body).catch((e) => log.warn('could not write the Agent API discovery file', e))
}

/** Removes the discovery file, if this Combwork wrote it. */
export async function clearDiscovery(): Promise<void> {
  const saved = await readJson<{ pid?: number } | null>(discoveryFile(), null)
  if (saved?.pid === process.pid) await removePath(discoveryFile()).catch((e) => log.warn('could not remove the Agent API discovery file', e))
}

/** The same, at once, for Combwork's last moment (will-quit), where nothing is awaited. */
export function clearDiscoveryNow(): void {
  try {
    const saved = JSON.parse(readFileSync(discoveryFile(), 'utf8')) as { pid?: number }
    if (saved?.pid === process.pid) unlinkSync(discoveryFile())
  } catch {
    // None, or already gone.
  }
}
