/**
 * The Assistant's journal (#989, #1031): what an entry is, what may be stored, and the settings, shared by main (the
 * store, `main/journal.ts`), the combwork MCP server (its tools) and the window (Settings → Assistant). Agent-facing words
 * here stay English; the window's words are its own messages.
 */

/** What an entry records. A digest sums up others (the weekly routine); the rest are what the scope allows. */
export const JOURNAL_KINDS = ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment', 'digest'] as const
export type JournalKind = (typeof JOURNAL_KINDS)[number]

/** The kinds the user chooses to allow (Settings → Assistant → Journal): every kind but digest, which is always allowed. */
export const SCOPE_KINDS = ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment'] as const satisfies readonly JournalKind[]
export type ScopeKind = (typeof SCOPE_KINDS)[number]

/** Work only, by default (Darren's decision on #989): preferences and moments are the user's to turn on. */
export const DEFAULT_SCOPE: ScopeKind[] = ['decision', 'plan', 'event', 'incident', 'insight']

/** What an entry links to. */
export const LINK_TYPES = ['card', 'commit', 'note', 'artifact', 'session', 'agent', 'project', 'entry'] as const
export type LinkType = (typeof LINK_TYPES)[number]

/** Who wrote an entry: Combwork's own facts, or the Assistant. */
export type JournalSource = 'combwork' | 'assistant'

/** The journal's settings, per workspace (Settings → Assistant → Journal). */
export interface JournalSettings {
  /** Off keeps everything: the tools go and nothing is written, until it is on again. */
  enabled: boolean
  /** The kinds that may be stored. */
  scope: ScopeKind[]
  /** Everyday entries older than this many days go; digests and entries of importance 2 or more stay. */
  retentionDays: number
  /** Past this size the oldest everyday entries go first; null: no limit. */
  capMB: number | null
}

export const DEFAULT_JOURNAL: JournalSettings = { enabled: true, scope: DEFAULT_SCOPE, retentionDays: 90, capMB: 50 }

/** Bounds the settings take. */
export const JOURNAL_LIMITS = { minRetentionDays: 7, maxRetentionDays: 3650, minCapMB: 5, maxCapMB: 10_000 } as const

/** Sizes an entry's fields may have, and how many a recall gives. */
export const ENTRY_LIMITS = { summary: 300, detail: 100_000, why: 4000, links: 40, tags: 20, tag: 40, ref: 300, project: 200, recallDefault: 10, recallMax: 50 } as const

/** Importance: 0 trivia, 1 everyday (the default), 2 important, 3 essential. 2 and up outlive retention and the cap. */
export const KEPT_IMPORTANCE = 2

/** Settings as saved, with anything missing or of the wrong type made safe. */
export function journalSettings(v: unknown): JournalSettings {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  const scope = Array.isArray(o.scope) ? SCOPE_KINDS.filter((k) => (o.scope as unknown[]).includes(k)) : DEFAULT_JOURNAL.scope
  const days = typeof o.retentionDays === 'number' && Number.isFinite(o.retentionDays) ? Math.round(o.retentionDays) : DEFAULT_JOURNAL.retentionDays
  const cap = o.capMB === null ? null : typeof o.capMB === 'number' && Number.isFinite(o.capMB) ? Math.round(o.capMB) : DEFAULT_JOURNAL.capMB
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_JOURNAL.enabled,
    scope,
    retentionDays: Math.min(JOURNAL_LIMITS.maxRetentionDays, Math.max(JOURNAL_LIMITS.minRetentionDays, days)),
    capMB: cap === null ? null : Math.min(JOURNAL_LIMITS.maxCapMB, Math.max(JOURNAL_LIMITS.minCapMB, cap))
  }
}

/** Whether the scope lets a kind be stored (a digest always may). */
export const inScope = (s: Pick<JournalSettings, 'scope'>, kind: JournalKind): boolean => kind === 'digest' || (s.scope as string[]).includes(kind)

/** A date's ISO week, as a digest names its period ("2026-W42"; weeks start on Monday, in UTC). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  // The week's Thursday decides its year.
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const jan1 = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - jan1) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** The Monday 00:00 UTC that starts a date's ISO week. */
export function weekStart(d: Date): Date {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() || 7) - 1))
  return t
}

/**
 * What the journal browser (#1033, the Assistant's view) shows: entries matching every filter given, newest first.
 * `query`'s words must all be found (each a prefix); `project` '' is the workspace's own entries (no project).
 */
export interface JournalFilter {
  query?: string
  kinds?: JournalKind[]
  project?: string
  source?: JournalSource
  /** ISO times, inclusive. */
  since?: string
  until?: string
}

/** A row of the browser's timeline. */
export interface JournalRow {
  id: number
  at: string
  kind: JournalKind
  project: string | null
  summary: string
  importance: number
  source: JournalSource
  supersededBy: number | null
  digestOf: string | null
  links: { type: LinkType; ref: string }[]
}

/** A page of the timeline: its rows, and how many match in all. */
export interface JournalPage {
  rows: JournalRow[]
  total: number
}

/**
 * What Forget would delete (#1033 round 2): how many entries match, and a token for exactly that set. Forget deletes
 * only while the set is still the one the user confirmed; any entry in or out since (written, edited, deleted), and it
 * deletes nothing and says how many match now.
 */
export interface JournalForgetPreview {
  count: number
  token: string
}

export type JournalForgetResult = { gone: number } | { changed: JournalForgetPreview }

/** An entry in full, for the browser. */
export interface JournalEntryView extends JournalRow {
  detail: string | null
  why: string | null
  updatedAt: string | null
  tags: string[]
  supersedes: number[]
}

/** What the browser's Edit changes. */
export interface JournalEdit {
  summary?: string
  detail?: string | null
  why?: string | null
  importance?: number
  kind?: JournalKind
}

/** The browser's page size, and the most one call gives. */
export const BROWSE_LIMITS = { page: 100, max: 500 } as const
