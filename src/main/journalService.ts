import { existsSync } from 'original-fs'
import { join } from 'path'
import { ASSISTANT_AGENT_ID, ASSISTANT_DIR } from '../shared/assistant'
import { CW_DIR } from '../shared/defaults'
import { readKeptJson } from './fsutil'
import { JOURNAL_LIMITS, journalSettings, inScope, type JournalEdit, type JournalFilter, type JournalForgetPreview, type JournalForgetResult, type JournalSettings, type LinkType } from '../shared/journal'
import { browseEntry, closeJournal, deleteEntry, deleteJournal, forgetJournal, forgetPreview, journalFile, journalFileBytes, journalSize, leaveEntry, onJournalChange, pruneJournal, updateEntry, writeEntry, writeEntryOnce } from './journal'
import { emit } from './events'
import { createLogger } from './logger'
import type { WorkspaceService } from './workspace'
import type { StoredText } from '../shared/types'

const log = createLogger('journal')

// The windows showing a workspace's journal browser (#1033) follow its changes: its Assistant home is `<workspace>/.combwork/assistant`.
onJournalChange((home) => emit({ type: 'journal-changed', workspacePath: join(home, '..', '..') }))
// agent-protocol: who a journal entry or delivery is from: Combwork's own name (HI-2463)
const COMBWORK = { kind: 'combwork', name: 'Combwork' } as const

/**
 * The journal as a workspace has it (#1031): its settings (workspace.json `journal`, Settings → Assistant → Journal),
 * Combwork's own facts, and the Assistant told when the settings change while it may be running. The store is journal.ts.
 * Agent-facing words here stay English.
 */

/** A workspace's journal settings (defaults for what it hasn't set). */
export const journalSettingsOf = (ws: WorkspaceService): JournalSettings => journalSettings(ws.config.journal)

/** The settings, and the journal's size, for Settings. */
export function journalStatus(ws: WorkspaceService): { settings: JournalSettings; bytes: number; entries: number } {
  const settings = journalSettingsOf(ws)
  if (!ws.path) return { settings, bytes: 0, entries: 0 }
  const home = ws.assistantHome
  let entries = 0
  try {
    entries = journalSize(home)?.entries ?? 0
  } catch (e) {
    log.warn('reading the journal size', e)
  }
  return { settings, bytes: journalFileBytes(home), entries }
}

/** Changes the settings; the Assistant is told what changed (its tools follow a turn on or off at its next start, Darren's decision on #1031). */
export async function setJournalSettings(ws: WorkspaceService, patch: Partial<JournalSettings>): Promise<JournalSettings> {
  // A number out of range is refused, not raised to the minimum (HI-2345): raised, a blank box's 0 tightened the
  // retention or cap and pruned at once. journalSettings() still makes what is saved safe when it is read.
  const whole = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  if ('retentionDays' in patch && !whole(patch.retentionDays, JOURNAL_LIMITS.minRetentionDays, JOURNAL_LIMITS.maxRetentionDays))
    throw new Error(`Keep everyday entries for: a whole number of days from ${JOURNAL_LIMITS.minRetentionDays} to ${JOURNAL_LIMITS.maxRetentionDays}. Nothing was changed.`)
  if ('capMB' in patch && patch.capMB !== null && !whole(patch.capMB, JOURNAL_LIMITS.minCapMB, JOURNAL_LIMITS.maxCapMB))
    throw new Error(`Size cap: no limit, or a whole number of MB from ${JOURNAL_LIMITS.minCapMB} to ${JOURNAL_LIMITS.maxCapMB}. Nothing was changed.`)
  // Worked out in the save's turn, from the settings as they are then (#1031 round 1): changes made at once (two
  // windows) each keep the other's fields, and what is told is what this save changed.
  let was: JournalSettings | null = null
  let next: JournalSettings = journalSettingsOf(ws)
  await ws.saveWorkspaceConfigWith((c) => {
    const now = journalSettings(c.journal)
    was ??= now
    next = journalSettings({ ...now, ...patch })
    return { journal: next }
  })
  // Set in the save's callback (TypeScript can't see it there).
  const before = was as JournalSettings | null
  if (!before) return next
  const said: string[] = []
  if (before.enabled !== next.enabled) said.push(next.enabled ? 'The journal is on again; its tools come with your next start (ask the user to restart you to use them now).' : 'The journal is off: nothing is written and its tools stop working (they leave at your next start). Its entries are kept.')
  if (next.enabled && before.scope.join() !== next.scope.join()) said.push(`The journal's scope changed: store only ${next.scope.length ? next.scope.join(', ') : 'digests'} entries from now on.`)
  if (said.length) await tellAssistant(ws, said.join(' '))
  // A tighter retention or cap applies now.
  if (next.enabled && (next.retentionDays < before.retentionDays || (next.capMB ?? Infinity) < (before.capMB ?? Infinity))) pruneNow(ws, next)
  return next
}

function pruneNow(ws: WorkspaceService, s: JournalSettings): void {
  try {
    if (existsSync(journalFile(ws.assistantHome))) pruneJournal(ws.assistantHome, s)
  } catch (e) {
    log.warn('pruning the journal after its settings changed', e)
  }
}

/** Tells the workspace's Assistant something (an inbox notice), if the workspace has one. */
async function tellAssistant(ws: WorkspaceService, body: string): Promise<void> {
  const home = ws.assistantHome
  if (!existsSync(join(home, CW_DIR, 'project.json'))) return
  // Loaded when used: sessions.ts reads the settings here, and deliveries.ts needs sessions loaded first.
  const { createDelivery } = await import('./deliveries')
  await createDelivery(home, { agentId: ASSISTANT_AGENT_ID, kind: 'control', from: COMBWORK, body }).catch((e) => log.warn('telling the Assistant its journal settings changed', e))
}

/** What the Assistant is asked to suggest, once, when it writes a handover with its journal off (#1032). */
export const JOURNAL_SUGGESTION = "Your journal is off. Suggest to the user once, in a line, that Settings → Assistant → Journal lets you remember decisions and plans across sessions without handovers; Combwork won't ask again."

/**
 * The suggestion for a handover the Assistant writes (#1032, Darren's decision on #989): while its journal is off, the
 * first time only (workspace.json `journalSuggested`, so it never nags); null otherwise.
 */
export async function journalSuggestion(ws: WorkspaceService): Promise<string | null> {
  if (!ws.path) return null
  let first = false
  await ws.saveWorkspaceConfigWith((c) => {
    first = !journalSettings(c.journal).enabled && !c.journalSuggested
    return first ? { journalSuggested: true } : {}
  })
  return first ? JOURNAL_SUGGESTION : null
}

/** Deletes the workspace's journal (Settings: confirmed first); the Assistant is told. */
export async function deleteWorkspaceJournal(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  await deleteJournal(ws.assistantHome)
  await tellAssistant(ws, 'The user deleted your journal: it starts again empty. Entries you recalled before are gone.')
}

/** Closes the workspace's journal (the workspace closes). */
export function closeWorkspaceJournal(ws: WorkspaceService): void {
  if (ws.path) closeJournal(ws.assistantHome)
}

/** A fact Combwork records (#1031): an event, by Combwork, small and linked. */
export interface Fact {
  summary: string
  project?: string | null
  importance?: number
  links?: { type: LinkType; ref: string }[]
  tags?: string[]
  detail?: string
  /** The summary as Combwork's message, beside its English (dialects, HI-2438). */
  summaryText?: StoredText
}

/**
 * A fact for a workspace by its folder, open or not (an unexpected close is found before its workspace opens): its
 * settings read from its workspace.json. One no window holds is written on a transient open (#1395: leaveEntry), never
 * admitted for it.
 */
export async function journalFactAt(workspacePath: string, fact: Fact): Promise<void> {
  const saved = await readKeptJson<{ journal?: unknown }>(join(workspacePath, CW_DIR, 'workspace.json'), {})
  const s = journalSettings(saved.journal)
  if (!s.enabled || !inScope(s, 'event')) return
  try {
    leaveEntry(join(workspacePath, CW_DIR, ASSISTANT_DIR), s, { kind: 'event', ...fact, tags: ['combwork', ...(fact.tags ?? [])] }, 'combwork')
  } catch (e) {
    log.warn('recording a fact in the journal', e)
  }
}

/**
 * Records a fact in the workspace's journal: only while it is on and its scope has events; never fails what it records
 * (a fact that can't be written is logged). With `once`, a fact the journal already has (the same summary and detail,
 * linked to it) isn't written again, and counts as recorded.
 */
export function journalFact(ws: WorkspaceService | null | undefined, fact: Fact, once?: { type: LinkType; ref: string }): boolean {
  if (!ws?.path) return false
  const s = journalSettingsOf(ws)
  if (!s.enabled || !inScope(s, 'event')) return false
  try {
    const input = { kind: 'event', ...fact, tags: ['combwork', ...(fact.tags ?? [])] }
    if (once) writeEntryOnce(ws.assistantHome, s, input, 'combwork', once)
    else writeEntry(ws.assistantHome, s, input, 'combwork')
    return true
  } catch (e) {
    log.warn('recording a fact in the journal', e)
    return false
  }
}

// The journal browser (#1033): what the user reads, corrects and deletes, on or off. Reading never makes a journal.

/** The workspace's Assistant home (a browser's calls act on its window's own), or null with none open. */
const homeOf = (ws: WorkspaceService): string | null => (ws.path ? ws.assistantHome : null)

export function journalEntry(ws: WorkspaceService, id: number): ReturnType<typeof browseEntry> {
  const home = homeOf(ws)
  return home ? browseEntry(home, id) : null
}

/** The user's edit; the scope still decides the kinds (Settings → Assistant → Journal). */
export function editJournalEntry(ws: WorkspaceService, id: number, edit: JournalEdit): boolean {
  const home = homeOf(ws)
  if (!home || !journalEntry(ws, id)) return false
  return updateEntry(home, journalSettingsOf(ws), id, edit)
}

export function deleteJournalEntry(ws: WorkspaceService, id: number): boolean {
  const home = homeOf(ws)
  return !!home && !!journalEntry(ws, id) && deleteEntry(home, id)
}

/** What Forget would delete: how many, and a token for exactly that set. */
export function forgetJournalPreview(ws: WorkspaceService, filter: JournalFilter): JournalForgetPreview {
  const home = homeOf(ws)
  return home ? forgetPreview(home, filter ?? {}) : { count: 0, token: '' }
}

/** Forget everything about X: exactly the set the user confirmed (its token), or nothing and the set as it is now. */
export function forgetJournalEntries(ws: WorkspaceService, filter: JournalFilter, token: string): JournalForgetResult {
  const home = homeOf(ws)
  return home ? forgetJournal(home, filter ?? {}, String(token ?? '')) : { gone: 0 }
}
