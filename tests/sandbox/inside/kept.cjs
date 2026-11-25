/**
 * What an upgrade must keep of the data the Sandbox's mark step seeded (drive.cjs, HI-2727): pure comparisons of what
 * was there before the upgrade and what is there after, by content, never by a file's name alone. Node built-ins only:
 * it runs inside the Sandbox, and the unit tests (tests/sandboxChecks.test.ts) give it tampered data to fail on.
 */
const crypto = require('crypto')

/** A text's SHA-256, or null for none. */
const sha = (text) => (typeof text === 'string' ? crypto.createHash('sha256').update(text).digest('hex') : null)
const parse = (text) => { try { return JSON.parse(text) } catch { return null } }

/**
 * A connection as an upgrade must keep it: its row in connections:list (read by its id: id, provider, name, kind), its
 * sign-in (fake-account.json, whole), the account its .claude.json names (oauthAccount), and the trust answers seeded
 * for `trustFolders` there. `files` are those two files' texts (null when missing). The CLI adds entries of its own to
 * .claude.json as it runs (a folder it is started in), so only the seeded ones are compared.
 */
function connectionSnapshot(list, id, files, trustFolders) {
  const row = (Array.isArray(list?.connections) ? list.connections : []).find((c) => c?.id === id) ?? null
  const claude = parse(files?.['.claude.json'])
  return {
    row: row && { id: row.id, provider: row.provider, name: row.name, kind: row.kind ?? 'signIn' },
    signIn: sha(files?.['fake-account.json']),
    account: claude?.oauthAccount ?? null,
    trust: Object.fromEntries(trustFolders.map((f) => [f, claude?.projects?.[f]?.hasTrustDialogAccepted ?? null]))
  }
}

/** How a connection after the upgrade differs from before it: [] when kept (a snapshot from before that seeded nothing fails too). */
function connectionDiffers(before, after) {
  const out = []
  if (!before?.row) out.push('no connection was seeded')
  else if (!after?.row) out.push(`connection ${before.row.id} isn't listed`)
  else for (const k of ['id', 'provider', 'name', 'kind']) if (before.row[k] !== after.row[k]) out.push(`its ${k}: ${before.row[k]} → ${after.row[k]}`)
  if (!before?.signIn) out.push('no sign-in was seeded')
  else if (before.signIn !== after?.signIn) out.push(after?.signIn ? 'its sign-in (fake-account.json) changed' : 'its sign-in (fake-account.json) is gone')
  if (!before?.account) out.push('no account was seeded in .claude.json')
  else if (JSON.stringify(before.account) !== JSON.stringify(after?.account ?? null)) out.push(`the account .claude.json names: ${JSON.stringify(before.account)} → ${JSON.stringify(after?.account ?? null)}`)
  const trust = Object.entries(before?.trust ?? {})
  if (!trust.length || trust.some(([, v]) => typeof v !== 'boolean')) out.push('the trust answers weren\'t all seeded')
  for (const [f, v] of trust) if (after?.trust?.[f] !== v) out.push(`the trust answer for ${f}: ${v} → ${after?.trust?.[f] ?? 'none'}`)
  return out
}

/** How a skill copy's files differ from what was seeded (`expected`: name → text): [] when each is there as it was. */
function copyDiffers(expected, files) {
  return Object.entries(expected).flatMap(([name, text]) => (typeof files?.[name] !== 'string' ? [`${name} is gone`] : sha(files[name]) !== sha(text) ? [`${name} changed`] : []))
}

/** combwork.log's line as a run starts (src/main/index.ts), and the one a start writes when the last run left its marker (lastRun.ts). */
const START_LINE = /\[main\] Combwork (\S+) starting\b/
const UNEXPECTED_LINE = 'The last run of Combwork ended without quitting'

/**
 * What the latest start in a profile's combwork.log found of the run before it (HI-3578): its version, and its line
 * saying the last run ended without quitting (the notice that Combwork closed unexpectedly), or null for a clean one.
 * Null when the log has no start. After an upgrade over a running release, before anything else starts it, the latest
 * start is the one the installer's --force-run made: the release before was asked to close for the install, and quits.
 */
function lastStart(log) {
  const lines = String(log ?? '').split(/\r?\n/)
  let at = -1
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (START_LINE.test(lines[i])) at = i
  if (at < 0) return null
  return { version: START_LINE.exec(lines[at])[1], unexpected: lines.slice(at + 1).find((l) => l.includes(UNEXPECTED_LINE)) ?? null }
}

module.exports = { sha, connectionSnapshot, connectionDiffers, copyDiffers, lastStart, START_LINE, UNEXPECTED_LINE }
