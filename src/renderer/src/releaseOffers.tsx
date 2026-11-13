// HI-3155 (Darren's 2A): the release offer, a project's own For you item. Read from main (`workflow:releaseOffers`) as a
// workspace opens and again on each `release-offers` event; shown on the board's For you row, in the Inbox, and under
// Work merges into. Move… and Remove… fill the change into Version Control → Workflow and open its Save… (the existing
// preview and retarget); Start… opens Start the next version; Not now puts it off until it changes. Each is bound to the
// offer's id: main refuses it once the offer changed.

import { useEffect } from 'react'
import { msg, tr } from '@shared/i18n'
import { offerApplies, offerOptions } from '@shared/releaseOffer'
import type { ReleaseOffer } from '@shared/types'
import { call, errorMessage } from './api'
import { get, notify, openVersionControl, set, useStore, NO_RELEASE_OFFERS } from './store'
import { startNextVersion } from './components/NextVersion'

const M = {
  move: msg({ id: 'board.releaseOffer.move', defaultMessage: '{project}: {target} is released ({dated, select, yes {{tag}, tagged {date, date, medium}} other {{tag}}}, merged into {into}). {how, select, move {Move Work merges into to {next}?} start {Start {next}, the next version?} other {}}', description: 'HI-3155: a release offer (For you, a project’s own item): the project’s Work merges into ({target}) is released: a tag named after it ({tag}, as v1.4.0) and merged into the default branch ({into}). dated yes: the tag’s own date. how move: offers to move Work merges into to the next version ({next}, which exists); start: offers to start it ({next} doesn’t exist yet); other: no next version. Work merges into is an option’s name: as translated there.' }),
  drop: msg({ id: 'board.releaseOffer.drop', defaultMessage: '{n, plural, one {{branches} is released and nothing uses it: take it off Other branches work can merge into?} other {{branches} are released and nothing uses them: take them off Other branches work can merge into?}}', description: 'HI-3155: the cleanup part of a release offer: branches listed under Other branches work can merge into that are released and unused ({branches}: their names, joined; {n} how many). Other branches work can merge into is an option’s name: as translated there.' }),
  kept: msg({ id: 'board.releaseOffer.kept', defaultMessage: '{n, plural, one {{branches} is released but still in use, so it stays.} other {{branches} are released but still in use, so they stay.}}', description: 'HI-3155: released branches under Other branches work can merge into that cards, lanes or slots still use ({branches}: each name with what uses it, joined; {n} how many).' }),
  moveButton: msg({ id: 'board.releaseOffer.moveButton', defaultMessage: 'Move…', description: 'HI-3155: a release offer’s button: fills the change into Version Control → Workflow and opens its Save… (with what can follow). The ellipsis: a dialog follows.' }),
  removeButton: msg({ id: 'board.releaseOffer.removeButton', defaultMessage: 'Remove…', description: 'HI-3155: a release offer’s button when it only takes released branches off Other branches work can merge into: opens Workflow’s Save… with that change.' }),
  startButton: msg({ id: 'board.releaseOffer.startButton', defaultMessage: 'Start {next}…', description: 'HI-3155: a release offer’s button: opens Start the next version for {next} (a branch name, as 1.5.0).' }),
  notNow: msg({ id: 'board.releaseOffer.notNow', defaultMessage: 'Not now', description: 'HI-3155: a release offer’s button: hides it until it changes (a new release, the next version made).' }),
  stale: msg({ id: 'board.releaseOffer.stale', defaultMessage: 'The release offer changed since it was shown: here it is as it is now.', description: 'HI-3155: a notification: a release offer’s button found the offer changed (or gone); the offers are read again.' }),
  failed: msg({ id: 'board.releaseOffer.failed', defaultMessage: 'The release offer couldn’t be put off', description: 'HI-3155: a notification’s title: Not now on a release offer failed; the reason follows.' })
}

/** Reads the workspace's release offers into the store (kept as the same list when nothing changed). */
export async function loadReleaseOffers(): Promise<void> {
  const ws = get().workspace?.path
  if (!ws) return set({ releaseOffers: NO_RELEASE_OFFERS })
  const got = await call('workflow:releaseOffers').catch(() => null)
  if (!got || get().workspace?.path !== ws) return
  const now = get().releaseOffers
  if (now.length === got.length && now.every((o, i) => o.id === got[i].id)) return
  set({ releaseOffers: got.length ? got : NO_RELEASE_OFFERS })
}

/** The workspace's release offers, read as the workspace opens. */
export function useReleaseOffers(): ReleaseOffer[] {
  const ws = useStore((s) => s.workspace?.path ?? '')
  useEffect(() => {
    void loadReleaseOffers()
  }, [ws])
  return useStore((s) => s.releaseOffers)
}

/** The offer as the window says it. */
export function releaseOfferText(o: ReleaseOffer): string {
  const parts: string[] = []
  if (o.move) parts.push(tr(M.move, { project: o.project, target: o.move.target, tag: o.move.tag, into: o.move.into, dated: o.move.date ? 'yes' : 'no', date: o.move.date ? Date.parse(o.move.date) : 0, how: o.move.moveTo ? 'move' : o.move.startNext ? 'start' : 'none', next: o.move.moveTo ?? o.move.startNext ?? '' }))
  else parts.push(`${o.project}:`)
  if (o.cleanup?.drop.length) parts.push(tr(M.drop, { n: o.cleanup.drop.length, branches: o.cleanup.drop.map((d) => d.branch).join(', ') }))
  if (o.cleanup?.kept.length) parts.push(tr(M.kept, { n: o.cleanup.kept.length, branches: o.cleanup.kept.map((k) => `${k.branch} (${k.uses.join(', ')})`).join('; ') }))
  return parts.join(' ')
}

/** Still the current offer (read afresh by main): else said, and the offers shown as they are now. */
async function stillCurrent(o: ReleaseOffer): Promise<boolean> {
  const ok = await call('workflow:releaseOfferCurrent', o.projectPath, o.id).catch(() => false)
  if (!ok) {
    notify('warning', tr(M.stale))
    await loadReleaseOffers()
  }
  return ok
}

/** Move… or Remove…: the change filled into Workflow (never over unsaved edits) and its Save… opened. */
async function applyOffer(o: ReleaseOffer): Promise<void> {
  if (!(await stillCurrent(o))) return
  set({ workflowPrefill: { path: o.projectPath, preset: null, offer: { id: o.id, basis: o.basis, options: offerOptions(o) } } })
  openVersionControl(o.projectPath, 'workflow')
}

async function startOffer(o: ReleaseOffer): Promise<void> {
  if (!(await stillCurrent(o))) return
  await startNextVersion(o.projectPath, () => void loadReleaseOffers(), o.id)
}

async function notNow(o: ReleaseOffer): Promise<void> {
  try {
    await call('workflow:releaseOfferDismiss', o.projectPath, o.id)
  } catch (e) {
    notify('warning', tr(M.failed), errorMessage(e))
  }
  await loadReleaseOffers()
}

/** One offer: its words and its buttons (the board's For you row, the Inbox, Workflow). */
export function ReleaseOfferRow({ offer, compact }: { offer: ReleaseOffer; compact?: boolean }) {
  const applies = offerApplies(offer)
  return (
    <div className={compact ? 'release-offer compact' : 'release-offer'} data-release-offer={offer.id} data-project={offer.project}>
      <span className="release-offer-text">{releaseOfferText(offer)}</span>
      <span className="release-offer-actions">
        {applies && (
          <button className="btn small primary" data-action="release-offer-move" onClick={() => void applyOffer(offer)}>
            {tr(offer.move?.moveTo ? M.moveButton : M.removeButton)}
          </button>
        )}
        {!offer.move?.moveTo && offer.move?.startNext && (
          <button className="btn small" data-action="release-offer-start" onClick={() => void startOffer(offer)}>
            {tr(M.startButton, { next: offer.move.startNext })}
          </button>
        )}
        <button className="btn small subtle" data-action="release-offer-dismiss" onClick={() => void notNow(offer)}>
          {tr(M.notNow)}
        </button>
      </span>
    </div>
  )
}
