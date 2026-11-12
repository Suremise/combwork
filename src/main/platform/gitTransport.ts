// Follow mode's transport, Git's (HI-1183, SPEC §16.9.4): the merge queue's target is the branch it tracks on its remote.
// The endpoint is captured once for an attempt (`destination`: one push URL, rewrites applied by git then, and the
// transport and sign-in settings an allowlist names), and every fetch and publication runs in a sealed context built
// from that snapshot alone: a bare gitdir of its own in a temp folder whose only configuration is the snapshot's (no
// `url.*`, `remote.*` or `include*` ever), with the system and global configuration switched off and git's own variables
// removed from its environment, using the project's object store directly. A live edit of the user's configuration (a
// new insteadOf or pushInsteadOf, an include) is never read by these children, so it can't redirect them; nothing of the
// user's configuration is edited. The project's pre-push hook runs once in the project itself (`git hook run`), and the
// publication runs with no hook.

import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'original-fs'
import { tmpdir } from 'os'
import { delimiter, isAbsolute, join, resolve } from 'path'
import { git } from '../git'
import { again } from './again'
import { configRead } from './gitCommits'
import type { Again, CandidateHost, FollowSetupPause, PublishReply, QueueGitResult, TransportSnapshot } from './integration'

/** A fetch or a publication reaches the remote and may wait on a sign-in window: as G18's push, long but never forever. */
export const TRANSPORT_MS = 5 * 60_000

/**
 * The settings carried into the sealed context: how the endpoint is reached and signed in to, never which endpoint it is.
 * `credential.*` (helpers, GCM's settings), `http.*` (proxy, TLS, headers, per URL too), the SSH command and variant, and
 * `protocol.*`. Never `url.*`, `remote.*`, `include*` or `core.hooksPath` (the hook runs in the project).
 */
const CARRIED = '^(credential|http)\\.|^core\\.sshcommand$|^ssh\\.variant$|^protocol\\.'

/**
 * The sealed context's own settings, after the snapshot's (so none of them can be undone by it): it never runs gc or
 * maintenance (its refs aren't the project's, so a gc there would treat the project's objects as unreachable), writes no
 * commit graph, and has no hooks.
 */
const SEALED = ['[gc]', '\tauto = 0', '[maintenance]', '\tauto = false', '[fetch]', '\twriteCommitGraph = false', '[core]', '\thooksPath = ', '\tcommitGraph = false']

/** git's variables a child inherits that would point it elsewhere or add settings: never passed into the sealed context. */
const isGitVar = (k: string): boolean => /^GIT_/i.test(k) && !/^GIT_SSH(_COMMAND|_VARIANT)?$/i.test(k)

/** No prompt anybody would have to see: no terminal prompt, no askpass, a credential manager kept non-interactive (G18's). */
const quiet = { GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' }

/** The URL as it may be shown or kept: no userinfo, query or fragment (an scp-like `user@host:path` keeps its user, never a secret). */
export function displayUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)?([^?#]*)/i.exec(url)
  if (m) return `${m[1]}${m[3]}`
  return url.replace(/[?#].*$/, '')
}

/**
 * A push URL as the snapshot keeps it (HR2's round 1): a relative filesystem path made absolute against the project, as
 * git in the project reads it, so the sealed context (another folder) and recovery reach the same repository. A URL
 * (`scheme://`), an scp-like `host:path` and an absolute path (`C:\…`, `C:/…`, `/…`, `\\server\…`) are kept as they are.
 */
export function projectRelative(project: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  const drive = /^[a-z]:[\\/]/i.test(url)
  // git's rule: a colon before any slash makes it scp-like (a drive letter's isn't).
  if (!drive && /^[^/\\]*:/.test(url)) return url
  return isAbsolute(url) ? url : resolve(project, url)
}

/** The secret values a snapshot holds: its URL's userinfo, and each carried setting's value that could hold one. */
function secretsOf(snap: TransportSnapshot): string[] {
  const out: string[] = []
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i.exec(snap.url)
  if (m) out.push(m[1], ...m[1].split(':').slice(1))
  // Its query and fragment (HR2's round 1: `?access_token=…`), whole and each value, as git may echo them bare.
  const q = /[?#](.*)$/.exec(snap.url)
  if (q) out.push(q[1], ...q[1].split(/[&#;]/).flatMap((p) => [p, p.slice(p.indexOf('=') + 1)]))
  for (const [k, v] of snap.config) {
    if (!/extraheader|proxy|cookie|helper|token|password|secret|key|user/i.test(k)) continue
    out.push(v)
    const h = /^[^:]+:\s*(.+)$/.exec(v)
    if (h) out.push(h[1])
    // Its pieces too (a header's token, a helper's `password=…`, a proxy's `user:pass@`): any long enough to be one.
    for (const piece of v.split(/[\s=;:@'"(){}]+/)) if (piece.length >= 10) out.push(piece)
  }
  return [...new Set(out.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length)
}

/**
 * A tool's words with credentials taken out: any URL's userinfo, authorization and bearer values, and each secret value
 * of the snapshot, before they are kept or shown (a pause's message, a card's log, a log line).
 */
export function redactTransport(text: string, snap: TransportSnapshot | null): string {
  let t = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1***@')
  // Any URL's query and fragment, as a URL shown keeps neither (a token can be in either).
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s'"?#]*)[?#][^\s'"]*/gi, '$1?***')
  t = t.replace(/(authorization:\s*)(\S+\s+)?\S+/gi, '$1***').replace(/(bearer\s+)\S+/gi, '$1***')
  if (snap) for (const s of secretsOf(snap)) t = t.split(s).join('***')
  return t
}

/** A config file's line for one setting (`section.sub.name`), quoted as git reads it. */
function configLines(pairs: [string, string][]): string[] {
  const out: string[] = []
  const q = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  for (const [key, value] of pairs) {
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    if (first < 0) continue
    const section = key.slice(0, first)
    const name = key.slice(last + 1)
    const sub = last > first ? key.slice(first + 1, last) : null
    out.push(sub === null ? `[${section}]` : `[${section} "${q(sub)}"]`, `\t${name} = "${q(value)}"`)
  }
  return out
}

/**
 * The sealed context of one operation: made from the snapshot, removed once it ends (it holds the decrypted settings).
 * `haves` (HI-2987): commits of the project's, as refs of the context's own (`refs/have/<n>`), so a fetch tells the remote
 * what it has and receives only what is new; with none, git offers nothing and the remote sends the branch's whole history.
 */
async function sealed<T>(snap: TransportSnapshot, fn: (ctx: string, env: NodeJS.ProcessEnv) => Promise<T>, haves: readonly string[] = []): Promise<T> {
  const ctx = join(tmpdir(), `combwork-transport-${randomUUID()}`)
  try {
    mkdirSync(join(ctx, 'refs'), { recursive: true })
    mkdirSync(join(ctx, 'objects'), { recursive: true })
    writeFileSync(join(ctx, 'HEAD'), 'ref: refs/heads/none\n')
    writeFileSync(join(ctx, 'empty'), '')
    if (haves.length) writeFileSync(join(ctx, 'packed-refs'), haves.map((c, i) => `${c} refs/have/${i}\n`).join(''))
    const sha256 = snap.format === 'sha256'
    const head = ['[core]', `\trepositoryformatversion = ${sha256 ? 1 : 0}`, '\tbare = true', ...(sha256 ? ['[extensions]', '\tobjectformat = sha256'] : [])]
    writeFileSync(join(ctx, 'config'), [...head, ...configLines(snap.config), ...SEALED, ''].join('\n'))
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (!isGitVar(k)) env[k] = v
    Object.assign(env, quiet, {
      GIT_DIR: ctx,
      GIT_OBJECT_DIRECTORY: snap.objects,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(ctx, 'empty'),
      ...(snap.alternates.length ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: snap.alternates.join(delimiter) } : {})
    })
    return await fn(ctx, env)
  } finally {
    rmSync(ctx, { recursive: true, force: true })
  }
}

/** What a git run said, both streams, for a pause or a log. */
const said = (r: QueueGitResult): string => `${r.err}\n${r.out}`.trim() || `git exited with code ${r.code}` // i18n-ignore: git's side of a pause, in English as git's are

/**
 * The endpoint and transport of a target, captured once (`destination`). Reads only, in the project: what it tracks, its
 * push URL as git resolves it now (rewrites applied), whether it is shallow, where its objects are, and the carried
 * settings with includes resolved.
 */
export async function destinationOf(h: CandidateHost, target: string): Promise<Again | { snapshot: TransportSnapshot } | { pause: FollowSetupPause; files?: string[] }> {
  const get = async (key: string) => configRead(await h.run(h.project, ['config', '--get', key]))
  const remote = await get(`branch.${target}.remote`)
  if (typeof remote !== 'string') return again(remote.failed)
  const merge = await get(`branch.${target}.merge`)
  if (typeof merge !== 'string') return again(merge.failed)
  if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) return { pause: 'noUpstream' }
  const urls = await h.run(h.project, ['remote', 'get-url', '--push', '--all', '--', remote])
  if (!urls.ok) return urls.code === 2 || /no such remote/i.test(urls.err) ? { pause: 'noUpstream' } : again(said(urls))
  const list = urls.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  if (list.length !== 1) return { pause: 'remoteAmbiguous', files: list.map(displayUrl) }
  const shallow = await h.run(h.project, ['rev-parse', '--is-shallow-repository'])
  if (!shallow.ok) return again(said(shallow))
  if (shallow.out.trim() === 'true') return { pause: 'remoteUnsupported' }
  const common = await h.run(h.project, ['rev-parse', '--git-common-dir'])
  if (!common.ok) return again(said(common))
  const format = await h.run(h.project, ['rev-parse', '--show-object-format'])
  if (!format.ok) return again(said(format))
  const objects = resolve(h.project, common.out.trim(), 'objects')
  let alternates: string[] = []
  try {
    alternates = readFileSync(join(objects, 'info', 'alternates'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => (isAbsolute(l) ? l : resolve(objects, l)))
  } catch {
    // none
  }
  const carried = await h.run(h.project, ['config', '--includes', '-z', '--get-regexp', CARRIED])
  if (!carried.ok && carried.code !== 1) return again(said(carried))
  const config: [string, string][] = []
  for (const item of (carried.ok ? carried.out : '').split('\0').filter(Boolean)) {
    const at = item.indexOf('\n')
    config.push(at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)])
  }
  const url = projectRelative(h.project, list[0])
  return { snapshot: { remote, url, display: displayUrl(url), ref: merge, config, objects, alternates, format: format.out.trim() || 'sha1' } }
}

/** At most this many of the project's commits are offered to the remote as haves (HI-2987). */
export const HAVES_MAX = 256

/**
 * HI-2987: the project's commits a sealed fetch offers the remote as haves: its previous pin (`into`), what it tracks of
 * that remote, and its local branches, read in the project (refs only: no transport setting). Unreadable: none, the fetch
 * still correct, only larger.
 */
async function havesOf(h: CandidateHost, snap: TransportSnapshot, into: string): Promise<string[]> {
  const r = await h.run(h.project, ['for-each-ref', `--count=${HAVES_MAX}`, '--format=%(objectname) %(objecttype)', into, `refs/remotes/${snap.remote}/`, 'refs/heads/'])
  if (!r.ok) return []
  const hex = /^[0-9a-f]{40}([0-9a-f]{24})?$/
  return [...new Set(r.out.split(/\r?\n/).map((l) => l.trim().split(' ')).filter(([id, type]) => type === 'commit' && hex.test(id)).map(([id]) => id))]
}

/** Fetches the snapshot's ref into the sealed context's own ref, reads that fetch's head there, and pins it in the project as `into`. */
export async function fetchHeadOf(h: CandidateHost, snap: TransportSnapshot, into: string, timeoutMs = TRANSPORT_MS): Promise<{ head: string } | { failed: string }> {
  const haves = await havesOf(h, snap, into)
  return sealed(snap, async (ctx, env) => {
    const f = await h.run(ctx, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-gc', '--no-auto-maintenance', '--', snap.url, `+${snap.ref}:refs/cw/r`], { env, timeoutMs })
    if (!f.ok) return { failed: redactTransport(said(f), snap) }
    const r = await h.run(ctx, ['rev-parse', '--verify', '--quiet', 'refs/cw/r^{commit}'], { env })
    const head = r.ok ? r.out.trim() : ''
    if (!head) return { failed: redactTransport(said(r), snap) }
    const pin = await h.run(h.project, ['update-ref', into, head])
    return pin.ok ? { head } : { failed: said(pin) }
  }, haves)
}

/**
 * The project's pre-push hook, once, in the project, for the exact update: its argv the remote's name and the URL as it
 * may be shown (never its credentials), its stdin git's own line for an object-name source (`<X> <X> <ref> <R>`, HR2's
 * s20 note). No hook: `ok`.
 */
export async function prePushOf(h: CandidateHost, snap: TransportSnapshot, lease: string, result: string): Promise<'ok' | { refused: string } | { timedOut: string }> {
  const dir = join(tmpdir(), `combwork-prepush-${randomUUID()}`)
  try {
    mkdirSync(dir, { recursive: true })
    const stdin = join(dir, 'stdin')
    writeFileSync(stdin, `${result} ${result} ${snap.ref} ${lease}\n`)
    const env: NodeJS.ProcessEnv = { ...process.env, ...quiet }
    const r = await h.run(h.project, ['hook', 'run', '--ignore-missing', `--to-stdin=${stdin}`, 'pre-push', '--', snap.remote, snap.display], { env, timeoutMs: TRANSPORT_MS })
    if (r.ok) return 'ok'
    if (r.timedOut) return { timedOut: redactTransport(r.errAtTimeout ?? said(r), snap) }
    return { refused: redactTransport(said(r), snap) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The publication: `result` over exactly `lease` at the snapshot's endpoint and ref, in the sealed context, with no hook
 * (it ran in the project). `--force-with-lease=<ref>:<lease>` with one explicit refspec: the remote takes it only while
 * its ref is exactly `lease`, and the update is a fast-forward because the queue proved `lease` is an ancestor of
 * `result` first. Read from git's porcelain status of that ref; anything it doesn't say plainly is unknown.
 */
export function publishOf(h: CandidateHost, snap: TransportSnapshot, lease: string, result: string): Promise<PublishReply> {
  return sealed(snap, async (ctx, env) => {
    const r = await h.run(ctx, ['push', '--porcelain', '--no-verify', `--force-with-lease=${snap.ref}:${lease}`, '--', snap.url, `${result}:${snap.ref}`], { env, timeoutMs: TRANSPORT_MS })
    const words = redactTransport(said(r), snap)
    // Never started: nothing was sent.
    if (r.notRun) return { stale: words }
    if (r.timedOut || r.signal) return { unknown: words }
    const line = r.out.split(/\r?\n/).find((l) => l.includes(`\t${result}:${snap.ref}\t`) || l.includes(`:${snap.ref}\t`))
    const flag = line?.[0]
    if (flag === '=') return 'atResult'
    if (r.ok && (flag === ' ' || flag === '+' || flag === '*')) return 'pushed'
    if (flag === '!') {
      if (/\[remote rejected\]/i.test(line!)) return { refused: words }
      if (/\[rejected\]|stale info|non-fast-forward|fetch first/i.test(line!)) return { stale: words }
    }
    return { unknown: words }
  })
}

/**
 * A host for follow mode's reads outside the merge queue (a slot's base, HI-1183): the project, Combwork's own git(),
 * with an environment and bound when asked. Nothing of the queue's (no identity, no signing).
 */
export function projectHost(project: string): CandidateHost {
  return {
    project,
    folder: project,
    signTimeoutMs: 0,
    identity: async () => null,
    reads: {},
    run: async (cwd, args, opts) => {
      const r = await git(cwd, args, undefined, undefined, { ...(opts?.env ? { env: opts.env } : {}), ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}) })
      return { ok: r.ok, out: r.out, err: r.err, code: r.code, ...(r.timedOut ? { timedOut: true } : {}), ...(r.notRun ? { notRun: r.notRun } : {}) }
    }
  }
}
