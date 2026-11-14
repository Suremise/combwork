/**
 * HI-3195: the Agent API writes a project agent's request key makes applied once (requestReceipts.ts), shared by the
 * server (which deduplicates them) and cw-mcp (which keys and retries only these, and only as a project agent): a write
 * the server doesn't deduplicate is never sent with a key, nor sent again after a lost reply.
 */

/** The card intents' route paths (`POST /v1/tasks/{card}/<path>`), as servers.ts' INTENT_ROUTES has them. */
export const INTENT_PATHS = ['put-back', 'submit', 'declare-paths', 'start-review', 'verdict', 'report-merge', 'focused-skip', 'ask', 'cannot', 'request', 'loop-step'] as const

const KEYED: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/tasks$/ },
  { method: 'POST', path: /^\/v1\/tasks\/batch$/ },
  { method: 'PATCH', path: /^\/v1\/tasks\/[^/]+$/ },
  { method: 'POST', path: new RegExp(`^/v1/tasks/[^/]+/(comments|ask-assistant|start|${INTENT_PATHS.join('|')})$`) }
]

/** Whether a request (its method, and its path without the query) is a write the server applies once by its key. */
export function keyedWrite(method: string, path: string): boolean {
  const bare = path.split('?')[0]
  return KEYED.some((k) => k.method === method && k.path.test(bare))
}
