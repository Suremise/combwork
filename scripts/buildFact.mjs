// Builds recorded as facts (#1534, #1062): after a successful `npm run dist` or `npm run release`, tells Combwork of the
// build so it goes into the workspace's journal as Combwork's own entry (src/main/buildFacts.ts). A failed build never gets
// here: both scripts exit first. Through the Agent API (POST /v1/builds) when Combwork can be reached: the session's
// CW_API_URL and token (an agent running the build has them; a script can set them). Otherwise, or when Combwork doesn't
// answer, a marker file in the workspace's .combwork/builds, which Combwork picks up when the workspace next opens. The
// workspace is CW_WORKSPACE, else the nearest folder above the main checkout with a .combwork/workspace.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { request } from 'http'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { checkoutOf, installerName, readBuildInfo } from './distCopy.mjs'

/** As src/shared/buildFacts.ts's BUILD_KINDS (tests/buildFacts.test.ts checks they agree). */
export const BUILD_KINDS = ['beta', 'baseline', 'rc', 'release']
export const BUILD_MARKERS_DIR = 'builds'

/**
 * The kind of a build: the one given (--kind), else from its version and script. A -beta.n version is a beta, a -rc.n a
 * release candidate; with no pre-release part, release uploads a release, and dist builds the candidate for one
 * (RELEASING.md, Step 1). A baseline install is built with --kind baseline (RELEASING.md, The 1.0 path).
 */
export function buildKind(version, by, given = null) {
  if (given) {
    if (!BUILD_KINDS.includes(given)) throw new Error(`--kind is one of: ${BUILD_KINDS.join(', ')}.`)
    return given
  }
  const pre = /-([a-z]+)/i.exec(version)?.[1]?.toLowerCase()
  if (pre === 'beta') return 'beta'
  if (pre === 'rc') return 'rc'
  return by === 'release' ? 'release' : 'rc'
}

/** The installer's path from dist's lines ("Installer: <path> (copied from this worktree…)"), or null. */
export function installerOf(lines) {
  for (const l of lines) {
    const m = /^Installer: (.+?\.exe)(?: \(|$)/.exec(l)
    if (m) return m[1]
  }
  return null
}

/**
 * A workspace's folder of Combwork's, `.combwork` (HI-2462), or null when it has none. A workspace only 1.0 has opened
 * isn't one: its builds are recorded once 1.1 has opened it and moved its data.
 */
const dataOf = (dir) => {
  const d = join(dir, '.combwork')
  return existsSync(join(d, 'workspace.json')) ? d : null
}

/** The workspace a checkout's builds are recorded in, or null. */
export function workspaceOf(root, env = process.env) {
  const named = env.CW_WORKSPACE
  if (named && dataOf(named)) return named
  let dir = checkoutOf(root)?.main ?? root
  for (;;) {
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
    if (dataOf(dir)) return dir
  }
}

/** The token a session's Combwork tools use: its token file's (it changes each launch), never a token variable (HI-2262). */
function tokenOf(env) {
  try {
    if (env.CW_API_TOKEN_FILE) return JSON.parse(readFileSync(env.CW_API_TOKEN_FILE, 'utf8')).token || null
  } catch {
    // fall through
  }
  return null
}

/**
 * POSTs the fact; resolves to Combwork's reply ({ recorded, reason? }), or null when Combwork can't be reached, refuses, or the
 * exchange ends any other way (a reply cut off, the connection closed early, no answer within timeoutMs for the whole
 * exchange). It always settles, once, and never rejects (#1534 round 1: a cut-off reply left it pending, and the script
 * ended with an unsettled await after a good build): the caller then leaves a marker.
 */
export function postBuild(fact, { url, token, workspace }, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let req = null
    let settled = false
    const done = (reply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req?.destroy()
      resolve(reply)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    try {
      const u = new URL('/v1/builds', url)
      const body = JSON.stringify(fact)
      const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` }
      if (workspace) headers['x-combwork-workspace'] = encodeURIComponent(workspace)
      req = request(u, { method: 'POST', headers }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          // A body cut off but ended cleanly doesn't parse: null too.
          if (!res.complete || res.statusCode < 200 || res.statusCode >= 300) return done(null)
          try {
            const reply = JSON.parse(text)
            done(reply && typeof reply === 'object' && typeof reply.recorded === 'boolean' ? reply : null)
          } catch {
            done(null)
          }
        })
        res.on('aborted', () => done(null))
        res.on('error', () => done(null))
        res.on('close', () => done(null))
      })
      // Closed before any reply: a socket hang up, an error.
      req.on('error', () => done(null))
      req.end(body)
    } catch {
      done(null)
    }
  })
}

/** Leaves the fact for Combwork as a marker in the workspace (written whole: a temp file renamed). Returns its path. */
export function leaveBuild(fact, workspace) {
  const dir = join(dataOf(workspace) ?? join(workspace, '.combwork'), BUILD_MARKERS_DIR)
  mkdirSync(dir, { recursive: true })
  const name = `${fact.builtAt.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
  const file = join(dir, `${name}.json`)
  writeFileSync(join(dir, `${name}.tmp`), JSON.stringify(fact, null, 2))
  renameSync(join(dir, `${name}.tmp`), file)
  return file
}

/**
 * Tells Combwork of a successful build: { version, commit, branch, installer, builtAt, by, kind? }. Returns the line to
 * print. Never fails the build: a fact that can't be sent or left is said, and the build stands.
 */
export async function recordBuild({ root, version, commit, branch = null, installer, builtAt = new Date().toISOString(), by, kind = null }, { env = process.env, post = postBuild } = {}) {
  let fact
  try {
    fact = { kind: buildKind(version, by, kind), version, commit, branch, installer, builtAt, by }
  } catch (e) {
    return `Build not recorded in Combwork's journal: ${e.message}`
  }
  const workspace = workspaceOf(root, env)
  const token = tokenOf(env)
  if (env.CW_API_URL && token) {
    const reply = await Promise.resolve()
      .then(() => post(fact, { url: env.CW_API_URL, token, workspace }))
      .catch(() => null)
    if (reply) return reply.recorded ? `Build recorded in Combwork's journal (${fact.kind}).` : `Build not recorded in Combwork's journal: ${reply.reason}`
  }
  if (!workspace) return "Build not recorded in Combwork's journal: no Combwork workspace holds this checkout (CW_WORKSPACE names one)."
  try {
    leaveBuild(fact, workspace)
    return `Build left for Combwork's journal (${fact.kind}): it's recorded when the workspace next opens in Combwork.`
  } catch (e) {
    return `Build not recorded in Combwork's journal: ${e.message}`
  }
}

/**
 * After `npm run dist`: records the build if it succeeded, returning the line to print, else null. Only a build whose
 * code is certain has dist/build-info.json (makeDist removes the old one first, finishDist writes it), so a failed or
 * unlabelled build records nothing. The installer is where dist's lines say it went (the main checkout's dist, or this one).
 */
export async function recordDist({ root, lines, kind = null }, opts) {
  const info = readBuildInfo(join(root, 'dist'))
  if (!info) return null
  return recordBuild({ root, version: info.version, commit: info.head, branch: info.branch, installer: installerOf(lines) ?? join(root, 'dist', installerName(info.version)), builtAt: info.builtAt, by: 'dist', kind }, opts)
}
