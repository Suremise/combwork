import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { app } from 'electron'
import { join } from 'path'
import type { ViewerToken } from '../shared/types'
import { agentMsg, inDefaultDialect, say } from '../shared/agentText'
import { readJson, writeJsonAtomic } from './fsutil'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'

/**
 * The Agent API's read-only viewer tokens (#620): made and revoked by the user in Settings → Agent API, each named for
 * the app it is for ("Apiary"). A viewer reads and follows the workspace like the workspace token (every GET and the
 * event stream) and changes nothing: the API refuses its every other request. Kept beside the workspace token in Hive's
 * profile (`agent-api-viewers.json`), never in a project.
 */
const MAX_VIEWERS = 20
const MAX_NAME = 40

const file = (): string => join(app.getPath('userData'), 'agent-api-viewers.json')

let viewers: ViewerToken[] = []
let loaded: Promise<void> | null = null
/** Changes one at a time, so two quick ones never lose each other. */
let writes: Promise<unknown> = Promise.resolve()

const valid = (v: unknown): v is ViewerToken => {
  const t = v as ViewerToken
  return !!t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.token === 'string' && t.token.length >= 32 && typeof t.createdAt === 'string'
}

/** Reads the kept tokens, once. */
export function loadViewerTokens(): Promise<void> {
  loaded ??= readJson<{ viewers?: unknown[] }>(file(), {}).then((saved) => {
    viewers = (Array.isArray(saved.viewers) ? saved.viewers : []).filter(valid)
  })
  return loaded
}

export function viewerTokens(): ViewerToken[] {
  return viewers.map((v) => ({ ...v }))
}

/** The viewer a bearer token is, or null. */
export function viewerForToken(bearer: string): ViewerToken | null {
  const got = Buffer.from(bearer)
  for (const v of viewers) {
    const want = Buffer.from(v.token)
    if (got.length === want.length && timingSafeEqual(got, want)) return v
  }
  return null
}

/** The note in the viewer tokens' file (dialects, HI-2447): written for any reader, so said in the Default. */
const FILE_NOTE = agentMsg({ id: 'token.file.viewerNote', text: 'Read-only Agent API tokens. Make and revoke them in Settings → Agent API → Viewer tokens.', note: "The note beside the viewer tokens in their file (#620), for whoever opens it." })

function change<T>(fn: () => T): Promise<T> {
  const run = writes.then(async () => {
    await loadViewerTokens()
    const result = fn()
    await writeJsonAtomic(file(), { viewers, note: inDefaultDialect(() => say(FILE_NOTE)) })
    return result
  })
  writes = run.catch(() => undefined)
  return run
}

/**
 * Why a viewer token wasn't made: the window's text (HI-2459), shown in Settings → Agent API → Viewer tokens in the
 * user's language (its only caller is the window: api:createViewer).
 */
const REFUSED = {
  noName: msg({ id: 'main.viewerTokens.noName', defaultMessage: 'Give the viewer token a name, such as the app it is for', description: 'Why a viewer token was not made (Settings → Agent API → Viewer tokens): its name is empty. Shown under "Could not make the viewer token".' }),
  tooLong: msg({ id: 'main.viewerTokens.tooLong', defaultMessage: "A viewer token's name is at most {most, number} characters", description: 'Why a viewer token was not made: its name is too long. {most} is the most characters a name may have (40).' }),
  taken: msg({ id: 'main.viewerTokens.taken', defaultMessage: 'There is already a viewer token named "{name}"', description: 'Why a viewer token was not made: another one has that name (letter case aside). {name} is the name the user gave it.' }),
  tooMany: msg({ id: 'main.viewerTokens.tooMany', defaultMessage: 'Combwork keeps at most {most, number} viewer tokens: revoke one first', description: 'Why a viewer token was not made: Combwork already keeps the most it keeps. {most} is that number (20). Revoke is the button beside each token.' })
}

/** A new viewer token named `name`. Refuses an empty or taken name, and more than 20 tokens. */
export function createViewerToken(name: string): Promise<ViewerToken> {
  const n = String(name ?? '').trim()
  if (!n) return Promise.reject(hiveError(REFUSED.noName, undefined, { kind: 'invalid' })) // window: Settings → Agent API → Viewer tokens (api:createViewer only)
  if (n.length > MAX_NAME) return Promise.reject(hiveError(REFUSED.tooLong, { most: MAX_NAME }, { kind: 'invalid' })) // window: Settings → Agent API → Viewer tokens (api:createViewer only)
  return change(() => {
    if (viewers.some((v) => v.name.toLowerCase() === n.toLowerCase())) throw hiveError(REFUSED.taken, { name: n }, { kind: 'conflict' }) // window: Settings → Agent API → Viewer tokens (api:createViewer only)
    if (viewers.length >= MAX_VIEWERS) throw hiveError(REFUSED.tooMany, { most: MAX_VIEWERS }, { kind: 'conflict' }) // window: Settings → Agent API → Viewer tokens (api:createViewer only)
    const v: ViewerToken = { id: randomUUID(), name: n, token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() }
    viewers = [...viewers, v]
    return { ...v }
  })
}

/** Revokes a viewer token: it stops working at once. Returns whether there was one. */
export function revokeViewerToken(id: string): Promise<boolean> {
  return change(() => {
    const had = viewers.some((v) => v.id === id)
    viewers = viewers.filter((v) => v.id !== id)
    return had
  })
}
