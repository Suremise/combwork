// What the profile folders (HI-2461, profileFolders.ts) tell the user once the first window has loaded: after a move of
// the local folder, by the installer (HI-2460) or by the names upgrade at start (HI-2594), once, the connections that
// show signed out, by name.
//
// The record of the move is `profile-move.json` in the new local folder, `{ v: 1, from, movedAt, by: "installer" | "app" }`
// (the contract HI-2460 shares): the mover puts it in the old local folder just before renaming that folder, so it
// arrives with the rename. The app reads it for this check only and records it done (`signInChecked`), keeping every
// field it has; the names already said (`signInNamed`) are kept too, so a check that couldn't finish (a connection whose
// check failed) is tried again next start without saying a name twice. A record that can't be read, or isn't a mover's,
// is left exactly as it is. Combwork never signs in for the user.

import { readFileSync, renameSync, writeFileSync } from 'original-fs'
import { join } from 'path'
import { fmt, msg, tr } from '../shared/i18n'
import { checkAccount, combworkAccounts, isServer } from './accounts'
import { toast } from './events'
import { createLogger, userText } from './logger'
import { MOVE_RECORD, profileChoices } from './profileFolders'

const log = createLogger('profile')

export { MOVE_RECORD }

const M = {
  signInTitle: msg({ id: 'main.profileMove.signInTitle', defaultMessage: '{n, plural, one {Sign in to # connection again} other {Sign in to # connections again}}', description: "A notice at start (HI-2461), once: after the app's data moved to the Combwork folder (the app's new name), some connections' sign-ins didn't carry across. {n} is how many." }),
  signInBody: msg({ id: 'main.profileMove.signInBody', defaultMessage: 'Since its data moved to the Combwork folder, {names} {n, plural, one {shows} other {show}} signed out. Sign in again in Settings → Accounts & Connections.', description: 'The notice naming the connections that show signed out after the data moved. {names} lists them by name; {n} is how many.' })
}

/** The record of a move, as read: its own fields and any other, kept as they are. */
type MoveRecord = Record<string, unknown> & { v: 1; from: string; by: 'installer' | 'app'; signInChecked?: boolean; signInNamed?: string[] }

/** The record in `folder`, or null when there is none, or it can't be read or isn't a mover's (then left alone). */
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
    if (r && typeof r === 'object' && r.v === 1 && (r.by === 'installer' || r.by === 'app') && typeof r.from === 'string') return r as MoveRecord
  } catch {
    // Not JSON: below.
  }
  log.warn(`profile: ${userText(join(folder, MOVE_RECORD))} isn't a record of a move; left as it is`)
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
  const { local } = profileChoices()
  if (local) await checkSignInsAfterMove(local.use)
  // The notices' phase is over (tests wait for this line before saying none came).
  log.info('profile: start notices done')
}

/**
 * After the local folder moved (the installer, or the names upgrade at start): each of Combwork's connections checked, and those that show signed out named
 * once. A check that failed (no answer) leaves the record unfinished, for the next start; the names said are kept.
 */
export async function checkSignInsAfterMove(folder: string, check: (id: string) => Promise<{ loggedIn: boolean | null } | null> = checkAccount): Promise<string[]> {
  const r = readMoveRecord(folder)
  if (!r || r.signInChecked === true) return []
  const named = new Set(Array.isArray(r.signInNamed) ? r.signInNamed.filter((x): x is string => typeof x === 'string') : [])
  const out: { id: string; name: string }[] = []
  let unfinished = false
  for (const a of combworkAccounts().filter((x) => !isServer(x))) {
    const seen = await check(a.id).catch(() => null)
    if (!seen || seen.loggedIn === null) unfinished = true
    else if (seen.loggedIn === false && !named.has(a.id)) out.push({ id: a.id, name: a.name })
  }
  log.info(`profile: after the move, ${out.length} connection(s) newly show signed out${unfinished ? '; some couldn’t be checked, tried again next start' : ''}`) // i18n-ignore: the log (English)
  if (out.length) toast('warning', tr(M.signInTitle, { n: out.length }), tr(M.signInBody, { n: out.length, names: fmt.list(out.map((x) => x.name)) }), undefined, undefined, undefined, { timeoutMs: 120_000 })
  writeMoveRecord(folder, { ...r, signInNamed: [...named, ...out.map((x) => x.id)], ...(unfinished ? {} : { signInChecked: true }) })
  return out.map((x) => x.name)
}
