import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { mkdir, rm, writeFile } from 'original-fs/promises'
import { join } from 'path'
import { recordTestToken } from './testQuiet'
import { endTwins } from './hookTwins'

/**
 * Each launch's own hook token and private folder (#345). The hook server takes a hook call only with the token of the
 * launch it names (`?run=<runId>`), and a launch's token ends with it: a token that leaks can't speak for another
 * session or outlive its own. CLIs that send hooks over HTTP read it from the session's environment (`CW_HOOK_TOKEN`);
 * hook commands (curl) read the header from the launch's auth file.
 *
 * The auth file, and whatever else of a launch may hold a secret (Claude Code's settings, with a user's `--settings`
 * and its `env`; its MCP config, with the workspace's servers' own `env` and headers), go in the launch's private
 * folder in Combwork's user data, `launches/<runId>`, never in the project: no file Combwork generates in a project holds a
 * secret. The folder goes when the launch ends, and all of them when Combwork starts.
 */

const tokens = new Map<string, string>()
/**
 * Each live token's run, by the token's SHA-256 (HI-2777): the fixed hook URL names no run, so its token tells it. A
 * lookup by hash, then the token compared in constant time, never the token itself as a key.
 */
const runsByToken = new Map<string, string>()
const tokenKey = (token: string): string => createHash('sha256').update(token).digest('hex')
/** Every run id this Combwork has made a token for (#711): only these are ever named in the log, never what a caller sent. */
const issued = new Set<string>()

function launchesDir(): string {
  return join(app.getPath('userData'), 'launches')
}

/** A launch's private folder, outside the project: for its files that may hold secrets. */
export function launchPrivateDir(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Not a run id.') // agent-protocol: a programming error (its caller's), never an agent's
  return join(launchesDir(), runId)
}

/** The file a launch's hook commands read their Authorization header from (`curl -H @<file>`). */
export function hookAuthFile(runId: string): string {
  return join(launchPrivateDir(runId), 'hook-auth.txt')
}

/** A new token for the launch `runId`, written to its auth file in its private folder (made here). */
export async function newHookToken(runId: string): Promise<{ token: string; file: string; dir: string }> {
  const token = randomBytes(24).toString('hex')
  recordTestToken('hook', token)
  const dir = launchPrivateDir(runId)
  const file = hookAuthFile(runId)
  const before = tokens.get(runId)
  if (before) runsByToken.delete(tokenKey(before))
  tokens.set(runId, token)
  runsByToken.set(tokenKey(token), runId)
  issued.add(runId)
  // A bounded record: the oldest go first (a run that old has long ended).
  if (issued.size > 5000) issued.delete(issued.values().next().value!)
  await mkdir(dir, { recursive: true })
  await writeFile(file, `Authorization: Bearer ${token}\n`)
  return { token, file, dir }
}

/** Whether an Authorization header carries the token of the launch `runId` (one that has ended has none). */
export function hookTokenMatches(runId: string | null, header: string | undefined): boolean {
  const token = runId ? tokens.get(runId) : undefined
  if (!token) return false
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The running launch whose token an Authorization header carries (HI-2777: the fixed hook URL, which names no run), or
 * null: no header, a token this Combwork didn't issue, or one whose launch has ended. Only hook tokens: an Agent API or
 * viewer token is never one.
 */
export function runForHookToken(header: string | undefined): string | null {
  const got = (header ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!got) return null
  const run = runsByToken.get(tokenKey(got)) ?? null
  return run && hookTokenMatches(run, `Bearer ${got}`) ? run : null // agent-protocol: an Authorization header's scheme, compared
}

/** Run ids whose refused hook calls the log has told of (refusedHookNote): once each, a bounded few. */
const refusedTold = new Set<string>()

/**
 * The log line for a hook call refused (#711: a Stop lost under load left no trace on Combwork's side), the first time for
 * its run id; null after that, so an ended launch's late hooks don't fill the log. Only a run id this Combwork made is
 * named: what an unknown caller sent is never logged (review round 1: the query is anyone's text).
 */
export function refusedHookNote(runId: string | null): string | null {
  const ours = !!runId && issued.has(runId)
  // agent-protocol: a key of refusedTold, not wording
  const key = ours ? runId! : runId ? '(not ours)' : '(none)'
  if (refusedTold.has(key) || refusedTold.size >= 200) return null
  refusedTold.add(key)
  // agent-protocol: combwork.log's line (servers.ts logs it), never an agent's
  if (!runId) return 'Refused a hook call that named no launch'
  // agent-protocol: combwork.log's line, as above
  if (!ours) return "Refused a hook call naming a run this Combwork didn't start"
  // agent-protocol: combwork.log's line, as above
  return `Refused a hook call for run ${runId}: ${tokens.has(runId!) ? "its token didn't match the launch's" : 'that launch has ended'}`
}

/** Whether a hook call of the running launch `runId` was refused (#1336: why its hooks don't reach Combwork). */
export const hooksRefused = (runId: string): boolean => tokens.has(runId) && refusedTold.has(runId)

/** The launch `runId` ended: its token stops working and its private folder goes. */
export function endHookToken(runId: string): void {
  const token = tokens.get(runId)
  if (token) runsByToken.delete(tokenKey(token))
  tokens.delete(runId)
  // Its duplicate deliveries' records go, and any still waiting on one goes on (HI-2777).
  endTwins(runId)
  void rm(launchPrivateDir(runId), { recursive: true, force: true }).catch(() => undefined)
}

/** At startup: private folders an earlier run of Combwork left (its tokens died with it). */
export async function clearHookAuth(): Promise<void> {
  await rm(launchesDir(), { recursive: true, force: true }).catch(() => undefined)
}
