// What the profile move (HI-2461, profileMove.ts) tells the user, once the first window has loaded: a copy that failed
// (this run uses the old folder), the connections that show signed out after the move (said once, naming them), and,
// from the start after the new folders first opened, the offer to remove the old folders' backups (to the Recycle Bin,
// only on the user's answer; Keep never asks again).

import { existsSync } from 'original-fs'
import { fmt, msg, tr } from '../shared/i18n'
import type { ToastAction } from '../shared/types'
import { checkAccount, hiveAccounts, isServer } from './accounts'
import { toast } from './events'
import { createLogger, userText } from './logger'
import { resolveOffer } from './notify'
import { profileMoves, readRecord, writeRecord, type MoveOutcome, type MoveRecord } from './profileMove'
import { trash } from './trash'

const log = createLogger('profile')

export const REMOVE_BACKUP_COMMAND = 'profile.removeBackup'
export const KEEP_BACKUP_COMMAND = 'profile.keepBackup'

const M = {
  failedTitle: msg({ id: 'main.profileMove.failedTitle', defaultMessage: "Hive couldn't move its data to the Combwork folder", description: "A notice at start (HI-2461): the app's data folders are renamed from Hive's to Combwork's (the app's new name, keep it as it is) at the first start of this version, and copying them failed. Nothing was lost." }),
  failedBody: msg({ id: 'main.profileMove.failedBody', defaultMessage: 'Copying {from} to {to} stopped: {why}. Nothing was lost: Hive is using {from} as before, and tries again the next time it starts.', description: 'The notice that copying the data folder failed. {from} and {to} are folder paths; {why} is the error (a code and a file, such as EBUSY and the file that was in use).' }),
  signInTitle: msg({ id: 'main.profileMove.signInTitle', defaultMessage: '{n, plural, one {Sign in to # connection again} other {Sign in to # connections again}}', description: "A notice at start (HI-2461), once: after the app's data moved to the Combwork folder (the app's new name), some connections' sign-ins didn't carry across. {n} is how many." }),
  signInBody: msg({ id: 'main.profileMove.signInBody', defaultMessage: 'Since Hive moved its data to the Combwork folder, {names} {n, plural, one {shows} other {show}} signed out. Sign in again in Settings → Accounts & Connections.', description: 'The notice naming the connections that show signed out after the data moved. {names} lists them by name; {n} is how many.' }),
  backupTitle: msg({ id: 'main.profileMove.backupTitle', defaultMessage: "Hive's old data folders are kept as a backup", description: "A notice at start (HI-2461): the app's data moved to the Combwork folders (the app's new name) and has opened from them; the old folders were kept, renamed, as a backup the user may remove." }),
  backupBody: msg({ id: 'main.profileMove.backupBody', defaultMessage: 'Hive now runs from the Combwork folders. The old ones are kept as {n, plural, one {a backup} other {backups}}: {folders}. Remove moves {n, plural, one {it} other {them}} to the Recycle Bin.', description: 'The notice offering to remove the backup of the old data folders. {folders} lists their paths; {n} is how many.' }),
  remove: msg({ id: 'main.profileMove.remove', defaultMessage: 'Remove', description: 'A button in the notice about the old data folders kept as a backup: moves them to the Recycle Bin.' }),
  keep: msg({ id: 'main.profileMove.keep', defaultMessage: 'Keep', description: "A button in the notice about the old data folders kept as a backup: keeps them, and Hive doesn't ask again." }),
  removed: msg({ id: 'main.profileMove.removed', defaultMessage: 'Moved to the Recycle Bin', description: 'What the notice about the old data folders says once Remove was taken and worked.' }),
  kept: msg({ id: 'main.profileMove.kept', defaultMessage: 'Kept', description: 'What the notice about the old data folders says once Keep was taken.' }),
  removeFailed: msg({ id: 'main.profileMove.removeFailed', defaultMessage: "Couldn't move {folder} to the Recycle Bin: {why}", description: "An error after Remove in the notice about the old data folders: {folder} is the backup folder's path, {why} the error." })
}

const OFFER = 'profile-backup'

/** The folders a move made this run or before, with their records: the roaming one first. */
function moved(): { use: string; record: MoveRecord; kind: MoveOutcome['kind'] }[] {
  const m = profileMoves()
  const out: { use: string; record: MoveRecord; kind: MoveOutcome['kind'] }[] = []
  for (const o of [m.roaming, m.local]) {
    if (!o || o.kind === 'failed' || o.kind === 'busy' || o.kind === 'fresh') continue
    const record = readRecord(o.use)
    if (record) out.push({ use: o.use, record, kind: o.kind })
  }
  return out
}

function update(folder: string, change: (r: MoveRecord) => MoveRecord): void {
  const r = readRecord(folder)
  if (!r) return
  try {
    writeRecord(folder, change(r))
  } catch (e) {
    log.warn(`profile move: couldn't update the record in ${userText(folder)}`, e)
  }
}

/** Once the first window has loaded (index.ts): what the move has to say. */
export async function startProfileMoveNotices(): Promise<void> {
  const m = profileMoves()
  for (const o of [m.roaming, m.local]) {
    if (o?.kind !== 'failed') continue
    toast('warning', tr(M.failedTitle), tr(M.failedBody, { from: o.use, to: o.to, why: o.why }), undefined, undefined, undefined, { timeoutMs: 120_000 })
  }
  const folders = moved()
  // The new folders opened once: from the next start on, their backups may be offered.
  const opening = folders.filter((f) => !f.record.opened)
  for (const f of opening) update(f.use, (r) => ({ ...r, opened: true }))
  const local = profileMoves().local
  const localRecord = folders.find((f) => f.use === local?.use)
  if (localRecord && !localRecord.record.signInChecked) {
    update(localRecord.use, (r) => ({ ...r, signInChecked: true }))
    await tellSignedOut()
  }
  if (opening.length) return
  const backups = backupsToOffer()
  if (!backups.length) return
  const actions: ToastAction[] = [
    { label: tr(M.remove), command: REMOVE_BACKUP_COMMAND },
    { label: tr(M.keep), command: KEEP_BACKUP_COMMAND }
  ]
  log.info(`profile move: offering to remove ${backups.map((b) => userText(b)).join(', ')}`)
  toast('info', tr(M.backupTitle), tr(M.backupBody, { n: backups.length, folders: fmt.list(backups) }), actions, undefined, undefined, { offer: OFFER, timeoutMs: 120_000 })
}

/** The backups not answered yet that are still there, from folders that have opened. */
function backupsToOffer(): string[] {
  return moved()
    .filter((f) => f.record.opened && !f.record.offer && f.record.backup && existsSync(f.record.backup))
    .map((f) => f.record.backup!)
}

/** The connections signed out after the move, named once (Hive never signs in for the user). */
async function tellSignedOut(): Promise<void> {
  const accounts = hiveAccounts().filter((a) => !isServer(a))
  const out: string[] = []
  for (const a of accounts) {
    const seen = await checkAccount(a.id).catch(() => null)
    if (seen?.loggedIn === false) out.push(a.name)
  }
  log.info(`profile move: ${out.length} of ${accounts.length} connection(s) show signed out after the move`)
  if (!out.length) return
  toast('warning', tr(M.signInTitle, { n: out.length }), tr(M.signInBody, { n: out.length, names: fmt.list(out) }), undefined, undefined, undefined, { timeoutMs: 120_000 })
}

/** The offer's Remove: each backup to the Recycle Bin; how many went. A failure says which and why. */
export async function removeProfileBackups(): Promise<number> {
  let n = 0
  const failures: string[] = []
  for (const f of moved()) {
    const b = f.record.backup
    if (!f.record.opened || f.record.offer || !b || !existsSync(b)) continue
    try {
      await trash(b)
      update(f.use, (r) => ({ ...r, offer: 'removed' }))
      log.info(`profile move: ${userText(b)} moved to the Recycle Bin`)
      n++
    } catch (e) {
      log.warn(`profile move: couldn't move ${userText(b)} to the Recycle Bin`, e)
      failures.push(tr(M.removeFailed, { folder: b, why: (e as Error).message }))
    }
  }
  resolveOffer(OFFER, failures.length ? failures.join('\n') : tr(M.removed))
  return n
}

/** The offer's Keep: the backups stay, and it isn't offered again. */
export function keepProfileBackups(): void {
  for (const f of moved()) if (f.record.opened && !f.record.offer && f.record.backup) update(f.use, (r) => ({ ...r, offer: 'kept' }))
  log.info('profile move: the backups are kept')
  resolveOffer(OFFER, tr(M.kept))
}
