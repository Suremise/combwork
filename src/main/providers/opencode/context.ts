// The Assistant's state view in an OpenCode session (HI-2771): 2.2.6's session instruction entries, put through the
// launch's own server with its password (tests/fixtures/opencode/real-2.2.6/wire/instruction-entries.json). OpenCode
// renders an entry in the system prompt as <context key="…">value</context>, and a later change to it as a
// <system-update> superseding the previous value, without starting a turn. Combwork owns one key and touches no other.
import { readFile } from 'original-fs/promises'
import type { StartContextDelivery, StartContextTrigger } from '../types'
import { serverInfoPath } from './launcher'

/** Combwork's one instruction entry (2.2.6's key pattern: ^[a-z0-9][a-z0-9._-]*$). */
export const CONTEXT_KEY = 'combwork.state-view'
/** 2.2.6's limit on an entry's value (413 above it), its JSON's UTF-8 bytes as 2.2.6 counts them: never trimmed to fit. */
export const CONTEXT_MAX_BYTES = 262144

/** Each running launch's server credentials, from its build (buildCommand) to its end (sessions.onLaunchEnded). */
const runs = new Map<string, { privateDir: string; password: string; sessionId: string }>()

export function trackContextRun(runId: string, privateDir: string, password: string, sessionId: string): void {
  runs.set(runId, { privateDir, password, sessionId })
}
export function untrackContextRun(runId: string): void {
  runs.delete(runId)
}

/** The posts that bring a start context: the launch's settled baseline (before its TUI starts) and a compaction's end. */
export function contextTrigger(body: Record<string, any>): StartContextTrigger | null {
  if (body?.hook_event_name === 'OpencodeSnapshot') return { source: 'start' }
  const e = body?.hook_event_name === 'OpencodeEvent' ? body.event : null
  if (e?.type !== 'session.compaction.ended') return null
  const id = typeof e.id === 'string' && e.id ? e.id : typeof e.seq === 'number' ? `seq:${e.seq}` : null
  return id ? { source: 'compact', id } : null
}

/** The launch's server, from its own record (the launcher's, for this session only), as a loopback URL; null if not that. */
async function serverOf(privateDir: string, sessionId: string): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(serverInfoPath(privateDir), 'utf8')) as { url?: unknown; sessionId?: unknown }
    return info.sessionId === sessionId && typeof info.url === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(info.url) ? info.url : null
  } catch {
    return null
  }
}

/**
 * Puts the text as Combwork's entry in the run's session, or removes it (null), within signal. A body over the limit
 * isn't sent: Combwork's entry is removed instead (no stale view stays), and it says so. Never throws.
 */
export async function deliverContext(runId: string, sessionId: string, text: string | null, signal: AbortSignal): Promise<StartContextDelivery> {
  const run = runs.get(runId)
  if (!run || run.sessionId !== sessionId || signal.aborted) return 'notSent'
  const url = await serverOf(run.privateDir, sessionId)
  if (!url || signal.aborted) return 'notSent'
  const body = text === null ? null : JSON.stringify({ value: text })
  const tooLarge = text !== null && Buffer.byteLength(JSON.stringify(text), 'utf8') > CONTEXT_MAX_BYTES
  const remove = body === null || tooLarge
  try {
    const res = await fetch(`${url}/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${CONTEXT_KEY}`, {
      method: remove ? 'DELETE' : 'PUT',
      headers: { authorization: 'Basic ' + Buffer.from(`opencode:${run.password}`).toString('base64'), ...(remove ? {} : { 'content-type': 'application/json' }) }, // i18n-ignore: an HTTP authorization header, never shown
      ...(remove ? {} : { body: body! }),
      signal
    })
    await res.arrayBuffer().catch(() => undefined)
    if (remove) return res.status === 204 || res.status === 404 ? (tooLarge ? 'tooLarge' : 'removed') : 'refused'
    return res.status === 204 ? 'put' : 'refused'
  } catch {
    // Cut off by the signal: it may have reached the server, so its outcome is unknown, never a success.
    return signal.aborted ? 'uncertain' : 'refused'
  }
}
