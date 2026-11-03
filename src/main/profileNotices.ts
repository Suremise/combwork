// What the profile folders (HI-2461, profileFolders.ts) tell the user once the first window has loaded:
// - a fallback: Combwork's folder isn't there, so this run uses Hive's (each start it applies, naming the folders);
// - after the installer moved the local folder (HI-2460), once: the connections that show signed out, by name.
//
// The installer's record of its move is `profile-move.json` in the new local folder, `{ v: 1, from, movedAt, by:
// "installer" }`, written after its rename succeeded (the contract HI-2460 shares). The app reads it for this check only
// and records it done (`signInChecked`), keeping every field it has; the names already said (`signInNamed`) are kept
// too, so a check that couldn't finish (a connection whose check failed) is tried again next start without saying a name
// twice. A record that can't be read, or isn't the installer's, is left exactly as it is. Hive never signs in for the
// user.

import { readFileSync, renameSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { profileFolder } from '../shared/appName'
import { fmt, msg, tr } from '../shared/i18n'
import { app } from 'electron'
import { checkAccount, hiveAccounts, isServer } from './accounts'
import { toast } from './events'
import { createLogger, userText } from './logger'
import { profileChoices, type ProfileChoice } from './profileFolders'

const log = createLogger('profile')

export const MOVE_RECORD = 'profile-move.json'

const M = {
  fallbackTitle: msg({ id: 'main.profileMove.fallbackTitle', defaultMessage: 'Hive is using its data folders from before Combwork', description: "A notice at start (HI-2461): the app's data folders are now named Combwork (the app's new name, keep it as it is), which the installer moves them to; they weren't moved yet, so Hive uses its old folders. Nothing is lost." }),
  fallbackBody: msg({ id: 'main.profileMove.fallbackBody', defaultMessage: "{n, plural, one {The Combwork folder isn't there, so Hive runs from {folders}, as before.} other {The Combwork folders aren't there, so Hive runs from {folders}, as before.}} Installing Combwork with Hive closed moves {n, plural, one {it} other {them}}; nothing is lost meanwhile.", description: 'The notice that Hive uses its old data folders. {folders} lists their paths; {n} is how many (1 or 2). "Installing Combwork": running the installer of the app under its new name.' }),
  fallbackBodyDev: msg({ id: 'main.profileMove.fallbackBodyDev', defaultMessage: "{n, plural, one {The {name} folder isn't there, so this dev build runs from {folders}.} other {The {name} folders aren't there, so this dev build runs from {folders}.}} To move {n, plural, one {it} other {them}}, close Hive and rename {n, plural, one {it} other {each}} to {name}.", description: "The same notice for a development build of Hive (no installer moves its folders). {name} is the new folder name (Combwork-Dev: keep it as it is); {folders} lists the old folders' paths; {n} is how many (1 or 2)." }),
  signInTitle: msg({ id: 'main.profileMove.signInTitle', defaultMessage: '{n, plural, one {Sign in to # connection again} other {Sign in to # connections again}}', description: "A notice at start (HI-2461), once: after the app's data moved to the Combwork folder (the app's new name), some connections' sign-ins didn't carry across. {n} is how many." }),
  signInBody: msg({ id: 'main.profileMove.signInBody', defaultMessage: 'Since Hive moved its data to the Combwork folder, {names} {n, plural, one {shows} other {show}} signed out. Sign in again in Settings → Accounts & Connections.', description: 'The notice naming the connections that show signed out after the data moved. {names} lists them by name; {n} is how many.' })
}

/** The installer's record, as read: its own fields and any other, kept as they are. */
type MoveRecord = Record<string, unknown> & { v: 1; from: string; by: 'installer'; signInChecked?: boolean; signInNamed?: string[] }

/** The record in `folder`, or null when there is none, or it can't be read or isn't the installer's (then left alone). */
export function readMoveRecord(folder: string): MoveRecord | null {
  let text: string
  try {
    text = readFileSync(join(folder, MOVE_RECORD), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`profile: couldn't read ${userText(join(folder, MOVE_RECORD))}`, e)
    return null
  }
  try {
    const r = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>
    if (r && typeof r === 'object' && r.v === 1 && r.by === 'installer' && typeof r.from === 'string') return r as MoveRecord
  } catch {
    // Not JSON: below.
  }
  log.warn(`profile: ${userText(join(folder, MOVE_RECORD))} isn't the installer's record of a move; left as it is`)
  return null
}

/** Writes the record back whole (its fields kept), beside it then renamed over it. False: it couldn't (tried again next start). */
export function writeMoveRecord(folder: string, r: MoveRecord): boolean {
  const file = join(folder, MOVE_RECORD)
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2))
    renameSync(`${file}.tmp`, file)
    return true
  } catch (e) {
    log.warn(`profile: couldn't record the sign-in check in ${userText(file)}`, e)
    return false
  }
}

/** Once the first window has loaded (index.ts). */
export async function startProfileNotices(): Promise<void> {
  const { roaming, local } = profileChoices()
  tellFallback([roaming, local].filter((c): c is ProfileChoice => !!c?.fallback))
  if (local && !local.fallback) await checkSignInsAfterMove(local.use)
}

function tellFallback(used: ProfileChoice[]): void {
  if (!used.length) return
  const folders = fmt.list(used.map((c) => c.use))
  const n = used.length
  const body = app.isPackaged ? tr(M.fallbackBody, { n, folders }) : tr(M.fallbackBodyDev, { n, folders, name: profileFolder(false) })
  log.info(`profile: telling the fallback to ${used.map((c) => userText(c.use)).join(', ')}`)
  toast('info', tr(M.fallbackTitle), body, undefined, undefined, undefined, { timeoutMs: 60_000 })
}

/**
 * After the installer moved the local folder: each of Hive's connections checked, and those that show signed out named
 * once. A check that failed (no answer) leaves the record unfinished, for the next start; the names said are kept.
 */
export async function checkSignInsAfterMove(folder: string, check: (id: string) => Promise<{ loggedIn: boolean | null } | null> = checkAccount): Promise<string[]> {
  const r = readMoveRecord(folder)
  if (!r || r.signInChecked === true) return []
  const named = new Set(Array.isArray(r.signInNamed) ? r.signInNamed.filter((x): x is string => typeof x === 'string') : [])
  const out: { id: string; name: string }[] = []
  let unfinished = false
  for (const a of hiveAccounts().filter((x) => !isServer(x))) {
    const seen = await check(a.id).catch(() => null)
    if (!seen || seen.loggedIn === null) unfinished = true
    else if (seen.loggedIn === false && !named.has(a.id)) out.push({ id: a.id, name: a.name })
  }
  log.info(`profile: after the move, ${out.length} connection(s) newly show signed out${unfinished ? '; some couldn’t be checked, tried again next start' : ''}`) // i18n-ignore: the log (English)
  if (out.length) toast('warning', tr(M.signInTitle, { n: out.length }), tr(M.signInBody, { n: out.length, names: fmt.list(out.map((x) => x.name)) }), undefined, undefined, undefined, { timeoutMs: 120_000 })
  writeMoveRecord(folder, { ...r, signInNamed: [...named, ...out.map((x) => x.id)], ...(unfinished ? {} : { signInChecked: true }) })
  return out.map((x) => x.name)
}
