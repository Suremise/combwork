// Card attachments' clean-up (HI-1842, Darren's decisions of 27 Oct 2026): a project's archived cards lose their
// attachments some days after they were archived (Project Settings → Storage: Off, 3, 7, 30 or 90 days; 30 by default).
// Only archived cards, never open or merely Done ones, nor cards archived because their project was hidden or removed
// (restoring the project brings those back). Unarchiving a card before then keeps its files. What main and the window share.
import type { TaskCard } from './types'

/** The choices, as project.json keeps them: `off`, or the days after archiving. */
export const CARD_CLEANUP_CHOICES = ['off', '3', '7', '30', '90'] as const
export type CardCleanupChoice = (typeof CARD_CLEANUP_CHOICES)[number]
export const CARD_CLEANUP_DEFAULT: CardCleanupChoice = '30'

/** The days a project's choice keeps an archived card's attachments; null when it is off. A value it doesn't know: the default. */
export function cleanupDays(choice: unknown): number | null {
  const c = (CARD_CLEANUP_CHOICES as readonly unknown[]).includes(choice) ? (choice as CardCleanupChoice) : CARD_CLEANUP_DEFAULT
  return c === 'off' ? null : Number(c)
}

/** When the card was archived (ms): its latest archive line in its history (they all start "Archived"), else its last change. */
export function archivedSince(card: Pick<TaskCard, 'history' | 'updatedAt'>): number {
  const at = card.history.filter((h) => h.what.startsWith('Archived')).map((h) => Date.parse(h.at))
  const t = Math.max(...at.filter(Number.isFinite))
  return Number.isFinite(t) ? t : Date.parse(card.updatedAt) || 0
}

export const DAY_MS = 86_400_000

/** Whether a card's attachments are due to go: archived (not with its project) for at least `days` days by `now` (`dayMs`: a day's length, shorter in tests). */
export function cleanupDue(card: Pick<TaskCard, 'archived' | 'archivedFor' | 'history' | 'updatedAt'>, days: number | null, now: number, dayMs = DAY_MS): boolean {
  if (days === null || !card.archived) return false
  if (card.archivedFor === 'project-hidden' || card.archivedFor === 'project-removed') return false
  return now - archivedSince(card) >= days * dayMs
}

/** A card whose attachments the clean-up removes, as Clean Up Now lists it. */
export interface CardCleanupItem {
  card: number
  key: string | null
  title: string
  /** When it was archived (ISO). */
  archivedAt: string
  files: { id: string; name: string; size: number }[]
}
