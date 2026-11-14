import { randomBytes, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { mkdir, rm } from 'original-fs/promises'
import { dirname, join } from 'path'
import { writeJsonAtomic } from './fsutil'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import { createLogger } from './logger'
import { recordTestToken } from './testQuiet'
import { launchPrivateDir } from './hookTokens'

/**
 * Each agent launch's own Agent API token. The API knows from it which agent, project and workspace a call comes
 * from, so a project agent's board calls are confined to its project however it fills in the request. Agents get
 * this token instead of the workspace's (`agent-api.json`), in their environment and their Combwork tools; a new launch
 * replaces it and the agent's exit ends it. (An agent runs as the user and could still read the workspace token
 * from disk: this keeps agents in their lane, it doesn't contain a hostile one.)
 */
export interface AgentIdentity {
  workspace: string
  projectPath: string
  agentId: string
}

const log = createLogger('agent-tokens')
const tokens = new Map<string, AgentIdentity & { token: string; runId: string }>()
const key = (projectPath: string, agentId: string): string => `${projectPath.toLowerCase()}#${agentId}`

/**
 * Where an agent's current launch finds its token (HI-3195): a file in that launch's own private folder, beside its hook
 * token, gone with the launch (endHookToken). A launch's settings name its own file, so a leftover process of a replaced
 * launch (HI-2232's renewal race) reads only its own revoked token, never its successor's, as it did when every launch
 * of an agent shared one file. '' while the agent has no launch.
 */
export function agentTokenFile(projectPath: string, agentId: string): string {
  const run = tokens.get(key(projectPath, agentId))?.runId
  return run ? launchTokenFile(run) : ''
}

/** HI-3195: the token file of the launch `runId`. */
export const launchTokenFile = (runId: string): string => join(launchPrivateDir(runId), 'agent-token.json')

/** Before HI-3195, every launch of an agent shared this file: an earlier version's are removed at start (clearOldTokenFiles). */
const oldTokenFolder = (): string => join(app.getPath('userData'), 'agent-api')

/** HI-3195: at start, the per-agent token files an earlier version left (their tokens died with it): never read again. */
export async function clearOldTokenFiles(): Promise<void> {
  await rm(oldTokenFolder(), { recursive: true, force: true }).catch((e) => log.warn('removing the old per-agent token files', e))
}

/** A launch whose token stopped working: ended with the agent, or replaced by its next launch. */
export type EndedLaunch = AgentIdentity & { runId: string }
const endedListeners = new Set<(ended: EndedLaunch) => void>()

/**
 * Told, at once, each time a launch's token stops working (HI-2416): what the token opened and keeps open (the Agent API's
 * event streams) ends with it, as a viewer token's streams end when it is revoked. Returns the unsubscribe.
 */
export function onAgentTokenEnded(fn: (ended: EndedLaunch) => void): () => void {
  endedListeners.add(fn)
  return () => void endedListeners.delete(fn)
}

function ended(t: EndedLaunch): void {
  const launch: EndedLaunch = { workspace: t.workspace, projectPath: t.projectPath, agentId: t.agentId, runId: t.runId }
  // A listener's failure never stops the token ending, nor the others being told.
  for (const fn of endedListeners) {
    try {
      fn(launch)
    } catch (e) {
      log.warn('ending what an agent token kept open', e)
    }
  }
}

/** The note in an agent's token file (dialects, HI-2447): written for any reader, so said in the Default. */
const FILE_NOTE = agentMsg({ id: 'token.file.agentNote', text: "One Combwork agent's Agent API token. Combwork replaces it each time the agent starts.", note: "The note beside the token in an agent's token file, for whoever opens it." })

/** A new token for an agent's launch (`runId`); the previous one stops working. */
export async function newAgentToken(id: AgentIdentity, runId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  recordTestToken('agent', token)
  const k = key(id.projectPath, id.agentId)
  const was = tokens.get(k)
  tokens.set(k, { ...id, token, runId })
  if (was) ended(was)
  const file = launchTokenFile(runId)
  await mkdir(dirname(file), { recursive: true })
  await writeJsonAtomic(file, { token, note: inDefaultDialect(() => say(FILE_NOTE)) })
  return token
}

/** HI-3194: the launch whose token works now for the agent (its newest), or null: a call from any other launch is stale. */
export function currentAgentRun(projectPath: string, agentId: string): string | null {
  return tokens.get(key(projectPath, agentId))?.runId ?? null
}

/** The agent's current token, if it has been launched. */
export function agentToken(projectPath: string, agentId: string): string | null {
  return tokens.get(key(projectPath, agentId))?.token ?? null
}

/** The agent's launch `runId` ended: its token stops working (not a newer launch's, if it was restarted meanwhile). */
export function endAgentToken(projectPath: string, agentId: string, runId: string): void {
  const k = key(projectPath, agentId)
  const t = tokens.get(k)
  if (t?.runId !== runId) return
  tokens.delete(k)
  ended(t)
}

/** The agent a token belongs to, with the launch it was made for, or null. */
export function agentForToken(token: string): (AgentIdentity & { runId: string }) | null {
  const got = Buffer.from(token)
  for (const t of tokens.values()) {
    const want = Buffer.from(t.token)
    if (got.length === want.length && timingSafeEqual(got, want)) return { workspace: t.workspace, projectPath: t.projectPath, agentId: t.agentId, runId: t.runId }
  }
  return null
}
