import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectInfo, SessionBulkAction, SessionBulkResult, SessionListItem, SessionSkipReason, Transcript, TranscriptImageRef, TranscriptItem, TranscriptSearchResult, TranscriptTool } from '@shared/types'
import { TRANSCRIPT_WINDOW, transcriptSizeInfo, transcriptWarnLimit } from '@shared/defaults'
import { useAgentLimit } from '../advanced'
import { formatDateTime } from '@shared/dates'
import { isProviderEnabled, providerDescriptor, providerName } from '@shared/providers'
import { buildSessionTree, countText, countsIn, pathTo, sessionKey, sessionsIn, type TreeNode } from '@shared/sessionTree'
import { holdText, removedAgentNote, resumeBlock, type ResumeContext } from '@shared/sessionResume'
import { ProviderIcon } from '../components/ProviderIcon'
import * as actions from '../actions'
import { freshShort, freshTip } from '../freshResume'
import { call, errorMessage } from '../api'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import { Icon, IconButton, InfoTip, LoadFailed, Markdown, Modal, SearchInput, StaleNote, Tooltip, useContextMenu, type MenuEntry } from '../components/ui'
import { agentProviderOf, confirm, focusedAgentId, get, notify, openInSessionsTab, prompt, revealAgent, set, setAssistantOpen, useDateStyle, useLanguage, useSessionStarting, useStarting, useStore, startingKey, startingLabel } from '../store'
import { cardLabel } from '@shared/projectKeys'
import { cx, formatDuration, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { useSessions } from './ProjectTabs'
import { useScopedLoad } from '../scopedLoad'
import { sessionOrigin, type SessionOrigin } from '@shared/sessionOrigin'
import { legacyOf, placeText } from '../agentPlace'
import { MAX_TREE_PREFS } from '@shared/uiPrefs'
import { shownText } from '@shared/advanced'
import { rememberProjectPref } from '../projectPrefs'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import type { CleanupPlan, CleanupSkip } from '@shared/sessionCleanup'
import { BulkProgressNote, SessionCleanup } from './SessionCleanup'
import { PurgeDialog } from '../components/Purge'

/**
 * Sessions tab: the project's sessions as a tree on the left (provider → agent → session → the sub-sessions it
 * started, like the Files tree: counts, actions on any branch, keyboard) and a read-only transcript on the right.
 * Search filters the tree across names, dates, providers and transcript text, with each session's matches under it.
 * The Hive Assistant's conversations use it too (`assistant`): its own words, no agent level, its panel instead of an
 * agent's pane.
 */

type Jump = { sessionId: string; itemId: number; nonce: number }
type Hit = TranscriptSearchResult['hits'][number]
type Row = { kind: 'node'; key: string; node: TreeNode; depth: number; parent: string | null } | { kind: 'hit'; key: string; sessionId: string; hit: Hit; depth: number; parent: string }

const copyText = (text: string): void => void navigator.clipboard.writeText(text)
const NO_PREFS: Record<string, boolean> = {}
/** Branches whose open or folded state is remembered per project (the most recently changed). */

/** Why a bulk action passed over a session, in a few words. */
/** A skip reason as a select's key, which can't have a dash: 'in-use' is inUse. */
const skipKey = (reason: SessionSkipReason): string => (reason === 'in-use' ? 'inUse' : reason)

function skipText(reason: SessionSkipReason): string {
  const key = skipKey(reason)
  return tr(msg({ id: 'sessions.bulk.skipReason', defaultMessage: '{reason, select, live {running} inUse {in use} reading {being read by Combwork} open {open in another Combwork window} external {started outside Combwork} other {failed}}', description: 'Why archiving, unarchiving or deleting passed over a session, in a few words (lower case): it is running, its files are in use, Combwork is reading it, another Combwork window has it open, it was started outside Combwork, or it failed (other).' }), { reason: key })
}

/** Why Clean Up left an old session alone before asking main, in a few words (running: as main's skips say it). */
function cleanupSkipText(reason: CleanupSkip): string {
  if (reason === 'live') return skipText('live')
  return tr(msg({ id: 'sessions.cleanup.skipReason', defaultMessage: "{reason, select, shown {open here} other {the Assistant's current conversation}}", description: "Why Clean Up passed over an old session, in a few words (lower case): its transcript is open in the Sessions tab, or it is the Combwork Assistant's current conversation (other)." }), { reason })
}

/** "Session" or "Conversation" (the Assistant's) in a few messages' selects. */
type Kind = 'session' | 'conversation'

export function SessionsTab({ project, assistant = false }: { project: ProjectInfo; assistant?: boolean }) {
  const { items, othersLoading, reload, error: listError, loadedAt } = useSessions(project)
  const limit = useAgentLimit(project)
  const listWidth = usePaneSize('sessions', 320)
  const [showArchived, setShowArchived] = useState(false)
  const [cleaningUp, setCleaningUp] = useState(false)
  // Purge… of one session (#1138), and the view it closed before its files went (opened again after, if it's still there).
  const [purging, setPurging] = useState<SessionListItem | null>(null)
  const purgeClosed = useRef<string | null>(null)
  const kind: Kind = assistant ? 'conversation' : 'session'
  useLanguage()
  const newOne = (): void => {
    void actions.newSession(project.path)
    if (assistant) setAssistantOpen(true)
  }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // This tab's transcript view, as main knows it (transcript:viewing): a session open in it isn't archived or deleted.
  const [viewId] = useState(() => `v${Math.random().toString(36).slice(2, 12)}`)
  // The keyboard's place in the tree (a branch, session or match), apart from the session shown.
  const [cursor, setCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchTry, setSearchTry] = useState(0)
  const [jump, setJump] = useState<Jump | null>(null)
  // Branches opened to show a session (the one selected at first, or opened from elsewhere): not remembered.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const settings = useStore((s) => s.settings)
  const installs = useStore((s) => s.providers)
  // Transcripts past this size (MB) show in the warning colour, as the agent's footer does.
  const warnMB = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
  const prefKey = project.path.toLowerCase()
  const explicit = useStore((s) => s.sessionsTree[prefKey]) ?? NO_PREFS
  // Running sessions of all the project's agents, by session id.
  const liveById = new Map(project.agents.filter((a) => a.live).map((a) => [a.live!.sessionId, a.live!]))
  const liveId = project.live?.sessionId
  const isLive = (id: string): boolean => liveById.has(id)
  const many = project.agents.length > 1
  // Where each session ran and whose it was, as it recorded (the Assistant's conversations have one place to run).
  const origin = (s: SessionListItem): SessionOrigin | null => (assistant ? null : sessionOrigin(project.path, project.agents, s, project.folders))
  const sessionName = (s: SessionListItem): string => sessionLabel(s, project.name, tr)
  const menu = useContextMenu()
  const resumeMenu = useContextMenu()
  useDateStyle() // session names and times follow the date format

  // Search as you type (debounced), across every session: names, dates, providers and transcript text. Results belong
  // to their project and query: never shown for another. A search that failed is said in place of the count, with Retry.
  const q = query.trim()
  const searchKey = q ? JSON.stringify([project.path, q]) : ''
  const search = useScopedLoad<TranscriptSearchResult[]>(searchKey)
  const results = q ? search.data : null
  const searchError = q ? search.error : null
  const { load: loadSearch } = search
  useEffect(() => {
    if (!searchKey) return
    const path = project.path
    const t = setTimeout(() => loadSearch(searchKey, () => call('transcript:search', path, q, null)), 250)
    return () => clearTimeout(t)
    // The key holds the project and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, searchTry, loadSearch])

  // The Assistant's list is its own conversations (and what they started).
  const shown = useMemo(() => (items ?? []).filter((i) => !assistant || i.source === 'combwork' || !!i.sub?.parentId), [items, assistant])
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items])
  const hitsById = new Map((results ?? []).map((r) => [r.sessionId, r]))
  const low = q.toLowerCase()
  const matches = (s: SessionListItem): boolean =>
    hitsById.has(s.id) || [sessionName(s), s.title ?? '', providerName(s.provider), s.lastActivity ? formatDateTime(s.lastActivity) : '', origin(s)?.label ?? '', s.sub?.kind ?? ''].some((t) => t.toLowerCase().includes(low))
  const tree = buildSessionTree(shown, { agents: project.agents, byAgent: !assistant, showArchived, selectedId, match: q ? matches : null })
  const treeNow = useRef(tree)
  treeNow.current = tree

  // Branches start folded except the focused agent's (the Assistant's: its provider's); what the user opens or folds is
  // remembered for the project.
  const focused = assistant ? null : focusedAgentId(project)
  const focusedProvider = assistant ? agentProviderOf(project.agents[0]) : focused ? agentProviderOf(project.agents.find((a) => a.id === focused)) : null
  const defaultOpen = (n: TreeNode): boolean =>
    n.kind === 'provider' ? n.provider === focusedProvider && (assistant || n.children.some((c) => c.kind === 'agent' && c.agentId === focused)) : n.kind === 'agent' ? !!focused && n.agentId === focused : false
  const isOpen = (n: TreeNode): boolean => !!q || revealed.has(n.key) || (explicit[n.key] ?? defaultOpen(n))
  const setOpen = (keys: string[], open: boolean): void => {
    const next = { ...explicit }
    for (const k of keys) {
      delete next[k]
      next[k] = open
    }
    rememberProjectPref('sessionsTree', prefKey, Object.fromEntries(Object.entries(next).slice(-MAX_TREE_PREFS)))
    setRevealed((r) => {
      if (!keys.some((k) => r.has(k))) return r
      const x = new Set(r)
      for (const k of keys) x.delete(k)
      return x
    })
  }
  const branchKeys = (nodes: readonly TreeNode[]): string[] => nodes.flatMap((n) => (n.children.length ? [n.key, ...branchKeys(n.children)] : []))
  /** Opens the branches down to a session, so it shows; false when it isn't in the tree (yet). */
  const reveal = (id: string): boolean => {
    const path = pathTo(treeNow.current, id)
    if (path?.length) setRevealed((r) => (path.every((k) => r.has(k)) ? r : new Set([...r, ...path])))
    return !!path
  }

  const open = (sessionId: string, itemId?: number): void => {
    setSelectedId(sessionId)
    setJump(itemId === undefined ? null : { sessionId, itemId, nonce: Date.now() })
  }

  // Opened on a session from elsewhere (e.g. clicking the session name above an agent's terminal).
  const jumpTo = useStore((s) => (s.sessionsJump?.project === project.path ? s.sessionsJump : null))
  useEffect(() => {
    if (!jumpTo) return
    setSelectedId(jumpTo.id)
    setCursor(sessionKey(jumpTo.id))
    set({ sessionsJump: null })
    // At one of its compactions (the Overview's compaction history): its divider, with the summary open.
    if (jumpTo.compaction !== undefined) {
      const n = jumpTo.compaction
      void call('transcript:compactions', project.path, jumpTo.id)
        .then((ids) => ids[n] !== undefined && setJump({ sessionId: jumpTo.id, itemId: ids[n], nonce: jumpTo.nonce }))
        .catch(() => undefined)
    }
  }, [jumpTo, project.path])

  const selected = items?.find((i) => i.id === selectedId) ?? null
  // From the click until it runs (#1177); the agent that would resume it busy starting something else holds it too.
  const resuming = useSessionStarting(project.path, selected?.id ?? null)
  const targetStarting = !!useStarting(project.path, selected ? actions.resumeTarget(project, selected) : null)

  // Start on the running session, or the most recent conversation (not while an action has closed the view: moving).
  const moving = useRef(false)
  useEffect(() => {
    if (!items || moving.current || (selectedId && items.some((i) => i.id === selectedId))) return
    const first = items.find((i) => i.id === liveId) ?? items.find((i) => !i.archived && !i.sub) ?? items[0]
    setSelectedId(first?.id ?? null)
    if (first) setCursor(sessionKey(first.id))
  }, [items, selectedId, liveId])
  // The session shown has its branches open: once each time it changes (or once the list has it), so a branch folded
  // later stays folded when the list refreshes.
  const revealedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId || revealedFor.current === selectedId) return
    if (reveal(selectedId)) revealedFor.current = selectedId
    // reveal reads the tree as it is now (treeNow); this runs when the session shown changes, or the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, items])

  const rename = async (s: SessionListItem): Promise<void> => {
    const current = sessionName(s)
    const name = (await prompt({ title: tr(msg({ id: 'sessions.rename.title', defaultMessage: 'Rename session', description: "Title of the prompt for a session's new name (Sessions tab)." })), initial: current, confirmLabel: tr(RENAME) }))?.trim()
    if (!name || name === current) return
    await actions.attempt(tr(msg({ id: 'sessions.rename.failed', defaultMessage: 'Could not rename', description: "An error's title: renaming a session failed." })), () => call('session:rename', project.path, s.id, name))
    reload()
  }
  const remove = async (s: SessionListItem): Promise<void> => {
    const who = providerName(s.provider)
    const ok = await confirm({
      title: tr(msg({ id: 'sessions.delete.title', defaultMessage: '{kind, select, conversation {Delete conversation?} other {Delete session?}}', description: "Title of the confirmation before deleting a session (the Combwork Assistant's: a conversation) from Combwork." }), { kind }),
      message: tr(msg({ id: 'sessions.delete.message', defaultMessage: 'Delete "{name}" from Combwork?', description: 'The confirmation before deleting a session from Combwork: its name ({name}).' }), { name: sessionName(s) }),
      detail:
        s.source === 'combwork'
          ? tr(msg({ id: 'sessions.delete.detailCombwork', defaultMessage: "Combwork's copies of its transcript go to the Recycle Bin and it no longer shows here; what it used stays in the totals. {cli} keeps its own transcript, so {cli}'s own resume list still has it.", description: "What deleting a session Combwork started does: Combwork's copies go to the Recycle Bin, its usage stays counted, and the CLI ({cli}: \"Claude Code\") keeps its own transcript." }), { cli: who })
          : tr(msg({ id: 'sessions.delete.detailExternal', defaultMessage: "Combwork stops listing it. {cli} keeps its transcript, so {cli}'s own resume list still has it.", description: 'What deleting a session started outside Combwork does: Combwork stops listing it, and the CLI ({cli}: "Claude Code") keeps its transcript.' }), { cli: who }),
      confirmLabel: tr(msg({ id: 'sessions.delete.button', defaultMessage: 'Delete', description: 'Button: deletes the session from Combwork. Keep it short.' })),
      danger: true
    })
    if (!ok) return
    const closed = await closeView([s.id])
    const done = await actions.attempt(tr(msg({ id: 'sessions.delete.failed', defaultMessage: '{kind, select, conversation {Could not delete the conversation} other {Could not delete the session}}', description: "An error's title: deleting a session (the Combwork Assistant's: a conversation) failed." }), { kind }), () => call('session:delete', project.path, s.id).then(() => true))
    moving.current = false
    // Still there (it couldn't be deleted): open it again.
    if (!done && closed) setSelectedId(closed)
    reload()
  }
  const archive = async (s: SessionListItem, archived: boolean): Promise<void> => {
    if (archived && !(await confirm({ title: tr(msg({ id: 'sessions.archive.title', defaultMessage: 'Archive session?', description: 'Title of the confirmation before archiving a session (Sessions tab).' })), message: tr(msg({ id: 'sessions.archive.message', defaultMessage: 'The transcript is preserved in .combwork/archive and hidden from this list. You can unarchive it at any time.', description: 'What archiving a session does. .combwork/archive is a folder: keep it as it is.' })), confirmLabel: tr(ARCHIVE) }))) return
    const closed = await closeView([s.id])
    await actions.attempt(tr(msg({ id: 'sessions.archive.failed', defaultMessage: 'Could not archive', description: "An error's title: archiving or unarchiving a session failed." })), () => call('session:archive', project.path, s.id, archived))
    moving.current = false
    // Its files have moved (or stayed): open it again from where they are.
    if (closed) setSelectedId(closed)
    reload()
  }

  /**
   * Closes this tab's view of a transcript about to be archived or deleted, before main moves its files (main counts an
   * open view as in use): its id, when it was one of them, once main knows the view is closed.
   */
  const closeView = async (ids: string[]): Promise<string | null> => {
    if (!selectedId || !ids.includes(selectedId)) return null
    const closed = selectedId
    moving.current = true
    setSelectedId(null)
    setJump(null)
    await call('transcript:viewing', viewId, project.path, null).catch(() => undefined)
    return closed
  }

  // ---- branch actions: everything under a provider, an agent, or a session and its sub-sessions ----
  const branchName = (n: TreeNode): string => (n.kind === 'session' ? `"${sessionName(n.item)}"` : n.kind === 'agent' ? `${n.label} (${providerName(n.provider)})` : n.label)
  const bulkList = (n: TreeNode, action: SessionBulkAction): SessionListItem[] =>
    // Archiving keeps Hive's copy: only Hive's own sessions have one (a sub-session started outside Hive goes with its session).
    sessionsIn(n).filter((s) => (action === 'delete' ? true : action === 'archive' ? !s.archived && s.source === 'combwork' : !!s.archived))
  const runBulk = async (n: TreeNode, action: SessionBulkAction): Promise<void> => {
    const list = bulkList(n, action)
    if (!list.length) return
    const what = countText({ sessions: list.filter((s) => !s.sub).length, subs: list.filter((s) => !!s.sub).length })
    const running = list.filter((s) => isLive(s.id)).length
    const skipNote = tr(msg({ id: 'sessions.bulk.skipNote', defaultMessage: '{running, plural, =0 {Running sessions are skipped, and so are any whose files are in use; the result says which.} one {# running now is skipped, as are any whose files are in use; the result says which.} other {# running now are skipped, as are any whose files are in use; the result says which.}}', description: "In the confirmation before archiving or deleting many sessions: running sessions ({running} of them now; none: a general note) and any whose files are in use are passed over, and the result lists them." }), { running })
    const where = { what, branch: branchName(n) }
    const ok =
      action === 'unarchive' ||
      (await confirm(
        action === 'delete'
          ? {
              title: tr(msg({ id: 'sessions.bulk.deleteTitle', defaultMessage: 'Delete {what}?', description: 'Title of the confirmation before deleting many sessions: how many ({what}: "3 sessions and 12 sub-sessions").' }), where),
              message: tr(msg({ id: 'sessions.bulk.deleteMessage', defaultMessage: 'Delete {what} under {branch} from Combwork?', description: 'The confirmation before deleting many sessions ({what}: "3 sessions") under a branch of the Sessions tree ({branch}: a provider, an agent or a session).' }), where),
              detail: tr(msg({ id: 'sessions.bulk.deleteDetail', defaultMessage: "Combwork's copies of their transcripts go to the Recycle Bin (restore them from there) and Combwork stops listing them; what they used stays in the totals. Claude Code and Codex keep their own transcripts. {skipNote}", description: 'What deleting many sessions does; then which are passed over ({skipNote}, a sentence).' }), { skipNote }),
              confirmLabel: tr(msg({ id: 'sessions.bulk.deleteAll', defaultMessage: 'Delete All', description: 'Button: deletes all the sessions listed. Keep it short.' })),
              danger: true
            }
          : {
              title: tr(msg({ id: 'sessions.bulk.archiveTitle', defaultMessage: 'Archive {what}?', description: 'Title of the confirmation before archiving many sessions: how many ({what}: "3 sessions and 12 sub-sessions").' }), where),
              message: tr(msg({ id: 'sessions.bulk.archiveMessage', defaultMessage: 'Archive {what} under {branch}?', description: 'The confirmation before archiving many sessions ({what}: "3 sessions") under a branch of the Sessions tree ({branch}: a provider, an agent or a session).' }), where),
              detail: tr(msg({ id: 'sessions.bulk.archiveDetail', defaultMessage: 'Their transcripts are kept in .combwork/archive and hidden from this list: tick Archived to see them, and unarchive any at any time. {skipNote}', description: 'What archiving many sessions does (.combwork/archive is a folder; Archived is a checkbox above the list: use its translation); then which are passed over ({skipNote}, a sentence).' }), { skipNote }),
              confirmLabel: tr(msg({ id: 'sessions.bulk.archiveAll', defaultMessage: 'Archive All', description: 'Button: archives all the sessions listed. Keep it short.' }))
            }
      ))
    if (!ok) return
    // The transcript open here, if it is one of them, closes first (an open one is in use); it opens again if its
    // session was left alone, and the result says when it stays closed.
    const closed = await closeView(list.map((s) => s.id))
    const r = await actions.attempt(tr(msg({ id: 'sessions.bulk.failed', defaultMessage: '{action, select, archive {Could not archive the {kind, select, conversation {conversations} other {sessions}}} unarchive {Could not unarchive the {kind, select, conversation {conversations} other {sessions}}} other {Could not delete the {kind, select, conversation {conversations} other {sessions}}}}', description: "An error's title: archiving, unarchiving or deleting many sessions (the Combwork Assistant's: conversations) failed." }), { action, kind }), () => call('session:bulk', project.path, action, list.map((s) => s.id)))
    moving.current = false
    if (closed && (!r || !r.done.includes(closed))) setSelectedId(closed)
    if (!r) return
    reportBulk(
      action,
      r,
      (id) => {
        const s = byId.get(id)
        return s ? sessionName(s) : id.slice(0, 8)
      },
      !!closed && r.done.includes(closed)
    )
    reload()
  }

  const resumeCtx = (s: SessionListItem): ResumeContext => {
    const install = installs[s.provider]
    return {
      live: isLive(s.id),
      providerEnabled: isProviderEnabled(settings, s.provider),
      providerInstalled: install && !install.checking ? install.found : null,
      runners: actions.agentsForSession(project, s),
      canAddAgent: !assistant && (!s.cwd || s.cwd.toLowerCase() === project.path.toLowerCase()) && project.agents.length < limit,
      assistant,
      projectPath: project.path
    }
  }
  const whyNot = (s: SessionListItem): string | null => resumeBlock(s, resumeCtx(s))

  const sessionMenu = (n: Extract<TreeNode, { kind: 'session' }>): MenuEntry[] => {
    const s = n.item
    const live = isLive(s.id)
    const block = whyNot(s)
    const entries: MenuEntry[] = []
    if (live) {
      const holder = project.agents.find((a) => a.live?.sessionId === s.id)
      if (holder) entries.push({ label: assistant ? tr(msg({ id: 'sessions.menu.showAssistant', defaultMessage: 'Show the Assistant', description: "Menu item on the Combwork Assistant's running conversation: opens its panel." })) : tr(msg({ id: 'sessions.menu.showAgent', defaultMessage: 'Show {agent}', description: "Menu item on a running session: shows the agent running it ({agent}: its name)." }), { agent: holder.name }), icon: 'terminal', onClick: () => (assistant ? setAssistantOpen(true) : revealAgent(project, holder.id)) })
    } else if (!s.archived) {
      // Its agent starting already (#1177).
      const target = actions.resumeTarget(project, s)
      const busy = target ? get().starting[startingKey(project.path, target)] : undefined
      entries.push({ label: tr(RESUME), icon: 'debug-continue', action: 'resume', disabled: !!block || !!busy, detail: block ?? (busy ? startingLabel(busy) : s.fresh ? freshShort() : undefined), onClick: () => void actions.resumeSession(project.path, s) })
    }
    if (s.source === 'external' && !s.sub) entries.push({ label: tr(ADOPT), icon: 'add', onClick: () => void actions.attempt(tr(ADOPT_FAILED), () => call('session:adopt', project.path, s.id)).then(reload) })
    if (s.source === 'combwork') entries.push({ label: tr(msg({ id: 'sessions.menu.rename', defaultMessage: 'Rename…', description: 'Menu item on a session: renames it.' })), icon: 'tag', keybinding: 'F2', onClick: () => void rename(s) })
    entries.push({ separator: true })
    if (s.source === 'combwork' && !live) entries.push({ label: s.archived ? tr(UNARCHIVE) : tr(ARCHIVE), icon: s.archived ? 'unarchive' : 'archive', onClick: () => void archive(s, !s.archived) })
    entries.push({ label: tr(msg({ id: 'sessions.menu.delete', defaultMessage: '{kind, select, conversation {Delete Conversation…} other {Delete Session…}}', description: "Menu item on a session (the Combwork Assistant's: a conversation): deletes it from Combwork, after a confirmation." }), { kind }), icon: 'trash', keybinding: formatKeybinding('Del'), danger: true, disabled: live, onClick: () => void remove(s) }) // i18n-ignore: a key's id, which formatKeybinding names
    if (s.source === 'combwork') entries.push({ label: tr(msg({ id: 'sessions.menu.purge', defaultMessage: "Purge Combwork's Files…", description: "Menu item on a session: lists, then removes, everything Combwork keeps of it (its backups, attachments, old usage), never the coding agent's own files." })), icon: 'trash', danger: true, disabled: live, onClick: () => setPurging(s) })
    if (n.children.length) entries.push({ separator: true }, ...branchEntries(n))
    entries.push({ separator: true }, { label: tr(msg({ id: 'sessions.menu.copyId', defaultMessage: 'Copy Session ID', description: "Menu item on a session: copies its id (the CLI's session id) to the clipboard." })), icon: 'copy', onClick: () => copyText(s.id) })
    return entries
  }
  const branchEntries = (n: TreeNode): MenuEntry[] => {
    const keys = [n.key, ...branchKeys(n.children)]
    const count = (action: SessionBulkAction): number => bulkList(n, action).length
    const archiving = count('archive')
    const unarchiving = count('unarchive')
    const deleting = count('delete')
    const scope = n.kind === 'session' ? 'session' : 'branch'
    return [
      { label: tr(EXPAND_ALL), icon: 'expand-all', onClick: () => setOpen(keys, true) },
      { label: tr(COLLAPSE_ALL), icon: 'collapse-all', onClick: () => setOpen(keys, false) },
      { separator: true },
      { label: tr(msg({ id: 'sessions.branch.archive', defaultMessage: '{scope, select, session {Archive with Its Sub-sessions… ({n, number})} other {Archive All… ({n, number})}}', description: 'Menu item on a branch of the Sessions tree (a provider or an agent: All; a session: with the sessions it started): archives the {n} sessions in it.' }), { scope, n: archiving }), icon: 'archive', disabled: !archiving, detail: archiving ? undefined : tr(msg({ id: 'sessions.branch.nothingToArchive', defaultMessage: "Nothing of Combwork's to archive here", description: "Why Archive All is greyed out: no session in the branch is Combwork's own (only Combwork's sessions can be archived)." })), onClick: () => void runBulk(n, 'archive') },
      ...(unarchiving ? [{ label: tr(msg({ id: 'sessions.branch.unarchive', defaultMessage: '{scope, select, session {Unarchive with Its Sub-sessions ({n, number})} other {Unarchive All ({n, number})}}', description: 'Menu item on a branch of the Sessions tree (a provider or an agent: All; a session: with the sessions it started): unarchives the {n} archived sessions in it.' }), { scope, n: unarchiving }), icon: 'unarchive', onClick: () => void runBulk(n, 'unarchive') }] : []),
      { label: tr(msg({ id: 'sessions.branch.delete', defaultMessage: '{scope, select, session {Delete with Its Sub-sessions… ({n, number})} other {Delete All… ({n, number})}}', description: 'Menu item on a branch of the Sessions tree (a provider or an agent: All; a session: with the sessions it started): deletes the {n} sessions in it from Combwork.' }), { scope, n: deleting }), icon: 'trash', danger: true, disabled: !deleting, onClick: () => void runBulk(n, 'delete') }
    ]
  }
  const menuFor = (n: TreeNode): MenuEntry[] => (n.kind === 'session' ? sessionMenu(n) : branchEntries(n))

  const theList = tr(msg({ id: 'sessions.list.what', defaultMessage: '{kind, select, conversation {the conversations} other {the sessions}}', description: "What could not be loaded, in \"Could not load …\" (the Sessions tab's list; the Combwork Assistant's: conversations). Lower case." }), { kind })
  if (!items) return listError ? <LoadFailed what={theList} error={listError} onRetry={reload} /> : <div className="empty-state"><Icon name="loading" spin />{tr(LOADING)}</div>

  // The tree's rows as shown: open branches' children, and while searching each session's matches under it.
  const rows: Row[] = []
  const walk = (nodes: readonly TreeNode[], depth: number, parent: string | null): void => {
    for (const n of nodes) {
      rows.push({ kind: 'node', key: n.key, node: n, depth, parent })
      if (n.kind === 'session' && q) for (const h of hitsById.get(n.item.id)?.hits ?? []) rows.push({ kind: 'hit', key: `h:${n.item.id}:${h.itemId}`, sessionId: n.item.id, hit: h, depth: depth + 1, parent: n.key })
      if (n.children.length && isOpen(n)) walk(n.children, depth + 1, n.key)
    }
  }
  walk(tree, 0, null)
  const hitCount = results?.reduce((n, r) => n + r.hits.length, 0) ?? 0
  const matched = q ? tree.flatMap(sessionsIn).length : 0

  const activate = (r: Row): void => {
    setCursor(r.key)
    if (r.kind === 'hit') open(r.sessionId, r.hit.itemId)
    else if (r.node.kind === 'session') open(r.node.item.id)
  }
  const toggle = (n: TreeNode): void => setOpen([n.key], !isOpen(n))

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if ((ev.target as HTMLElement).tagName === 'INPUT') return
    const idx = cursor ? rows.findIndex((r) => r.key === cursor) : -1
    const cur = idx >= 0 ? rows[idx] : null
    const node = cur?.kind === 'node' ? cur.node : null
    const moveTo = (i: number): void => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (!r) return
      activate(r)
      treeRef.current?.querySelector(`[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    let handled = true
    if (ev.key === 'ArrowDown') moveTo(idx + 1)
    else if (ev.key === 'ArrowUp') moveTo(idx < 0 ? 0 : idx - 1)
    else if (ev.key === 'Home') moveTo(0)
    else if (ev.key === 'End') moveTo(rows.length - 1)
    else if (ev.key === 'ArrowRight' && node?.children.length && !q) {
      if (!isOpen(node)) setOpen([node.key], true)
      else moveTo(idx + 1)
    } else if (ev.key === 'ArrowLeft' && cur) {
      if (node?.children.length && isOpen(node) && !q) setOpen([node.key], false)
      else if (cur.parent) moveTo(rows.findIndex((r) => r.key === cur.parent))
    } else if (ev.key === 'Enter' && cur) {
      if (node && node.kind !== 'session') toggle(node)
      else activate(cur)
    } else if (ev.key === 'F2' && node?.kind === 'session' && node.item.source === 'combwork') void rename(node.item)
    else if (ev.key === 'Delete' && node) {
      if (node.kind === 'session') {
        if (!isLive(node.item.id)) void remove(node.item)
      } else void runBulk(node, 'delete')
    } else handled = false
    if (handled) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

  return (
    <div
      className="split"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      }}
    >
      <div className="split-list sessions-list" style={{ width: listWidth }}>
        <PaneResizer paneKey="sessions" />
        <div className="pane-header" style={{ paddingLeft: 14 }}>
          {tr(msg({ id: 'sessions.list.heading', defaultMessage: '{kind, select, conversation {Conversations} other {Sessions}}', description: "The heading of the Sessions tab's list (the Combwork Assistant's: Conversations)." }), { kind })}
          <InfoTip
            text={
              assistant
                ? tr(msg({ id: 'sessions.list.infoAssistant', defaultMessage: "Every conversation of this workspace's Assistant, by provider. Select one to read it in full, including what came before each compaction.", description: "The info tip of the Combwork Assistant's conversations list. A compaction is when the CLI summarises the conversation to free context." }))
                : tr(msg({ id: 'sessions.list.info', defaultMessage: "Every session of this project, by provider and agent, with the sessions each one started (such as Codex's guardian reviews) under it. Select one to read its transcript, including what came before each compaction; right-click a branch to archive or delete everything in it. Transcripts a CLI has deleted are read from Combwork's backup.", description: "The info tip of the Sessions tab's list. Codex's guardian reviews are sessions Codex starts (keep the name); a compaction is when the CLI summarises the conversation." }))
            }
          />
          <div className="actions">
            <IconButton icon="add" title={tr(msg({ id: 'sessions.list.new', defaultMessage: '{kind, select, conversation {New Conversation} other {New Session}}', description: "Tooltip of the Sessions tab's + button: starts a new session (the Combwork Assistant's: conversation)." }), { kind })} onClick={newOne} />
            <IconButton icon="clear-all" action="sessions-cleanup" title={tr(msg({ id: 'sessions.list.cleanUp', defaultMessage: '{kind, select, conversation {Clean Up Old Conversations…} other {Clean Up Old Sessions…}}', description: "Tooltip of the Sessions tab's Clean Up button (the Combwork Assistant's: conversations): archives or deletes sessions older than an age, after a dialog." }), { kind })} onClick={() => setCleaningUp(true)} disabled={!shown.length} />
            <IconButton icon="refresh" title={tr(msg({ id: 'sessions.list.refresh', defaultMessage: 'Refresh', description: "Tooltip of the Sessions tab's refresh button: reads the list again." }))} onClick={reload} />
            <IconButton icon="expand-all" title={tr(EXPAND_ALL)} onClick={() => setOpen(branchKeys(tree), true)} />
            <IconButton icon="collapse-all" title={tr(COLLAPSE_ALL)} onClick={() => setOpen(branchKeys(tree), false)} />
          </div>
        </div>
        <div className="files-filter">
          <Icon name="search" />
          <SearchInput
            ref={searchRef}
            placeholder={tr(msg({ id: 'sessions.search.placeholder', defaultMessage: '{kind, select, conversation {Search conversations: names, dates, transcripts} other {Search sessions: names, dates, transcripts}}', description: "The Sessions tab's search box (the Combwork Assistant's: conversations): what it searches." }), { kind })}
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const first = rows.find((r) => r.kind === 'hit') ?? rows.find((r) => r.kind === 'node' && r.node.kind === 'session')
                if (first) activate(first)
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                treeRef.current?.focus()
                const first = rows.find((r) => r.kind === 'hit' || r.node.kind === 'session') ?? rows[0]
                if (first) activate(first)
              }
            }}
          />
          {query && <IconButton icon="close" title={tr(msg({ id: 'sessions.search.clear', defaultMessage: 'Clear', description: "Tooltip of the button that empties the Sessions tab's search box." }))} onClick={() => setQuery('')} />}
        </div>
        <div className="sessions-filters">
          <label className="flex muted">
            <input type="checkbox" className="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {tr(msg({ id: 'sessions.filter.archived', defaultMessage: 'Archived', description: 'A checkbox above the Sessions list: shows archived sessions too.' }))}
          </label>
          {othersLoading && !assistant && (
            <span className="sessions-scope faint" data-loading="others">
              <Icon name="loading" spin /> {tr(msg({ id: 'sessions.list.othersLoading', defaultMessage: 'Looking for sessions started outside Combwork…', description: "Above the Sessions list while it shows Combwork's own sessions and is still reading the sessions the CLIs keep for the project's folders (started in a terminal or an editor)." }))}
            </span>
          )}
          {q && (
            <span className="sessions-scope faint">
              {searchError ? null : !results ? (
                <>
                  <Icon name="loading" spin /> {tr(msg({ id: 'sessions.search.searching', defaultMessage: 'Searching…', description: "Under the Sessions tab's search box while it searches the transcripts." }))}
                </>
              ) : matched === 0 ? (
                tr(msg({ id: 'sessions.search.none', defaultMessage: 'No matches', description: "Under the Sessions tab's search box: nothing matches." }))
              ) : (
                tr(msg({ id: 'sessions.search.count', defaultMessage: '{kind, select, conversation {{sessions, plural, one {# conversation} other {# conversations}}} other {{sessions, plural, one {# session} other {# sessions}}}}{hits, plural, =0 {} one { · #{more} match} other { · #{more} matches}}', description: "Under the Sessions tab's search box: how many sessions match (the Combwork Assistant's: conversations), then how many matches in their transcripts ({more} is \"+\" when there are more than shown, else empty; none: leave it empty)." }), { kind, sessions: matched, hits: hitCount, more: results.some((r) => r.more) ? '+' : '' })
              )}
            </span>
          )}
        </div>
        <BulkProgressNote projectPath={project.path} kind={kind} />
        {listError && <StaleNote what={theList} error={listError} at={loadedAt} onRetry={reload} />}
        {q && searchError && <LoadFailed inline what={tr(msg({ id: 'sessions.search.what', defaultMessage: 'the search results', description: "What could not be loaded, in \"Could not load …\": the Sessions tab's search. Lower case." }))} error={searchError} onRetry={() => setSearchTry((n) => n + 1)} />}
        <div className="pane-body file-tree sessions-tree" tabIndex={0} ref={treeRef} onKeyDown={onKeyDown}>
          {items.length === 0 && !othersLoading && <div className="pane-empty">{tr(NONE_YET, { kind })}</div>}
          {items.length > 0 && rows.length === 0 && !q && <div className="pane-empty">{tr(msg({ id: 'sessions.list.noneHere', defaultMessage: '{kind, select, conversation {No conversations here: tick Archived to see archived ones.} other {No sessions here: tick Archived to see archived ones.}}', description: "The Sessions list when every session is archived (the Combwork Assistant's: conversations). Archived is the checkbox above it: use its translation." }), { kind })}</div>}
          {rows.map((r) => {
            if (r.kind === 'hit') {
              return (
                <div
                  key={r.key}
                  data-key={r.key}
                  className={cx('search-hit', cursor === r.key && 'cursor', selectedId === r.sessionId && jump?.itemId === r.hit.itemId && 'selected')}
                  style={{ paddingLeft: 28 + r.depth * 14 }}
                  onClick={() => activate(r)}
                >
                  <span className="hit-kind">{tr(HIT_KIND[r.hit.kind])}</span>
                  <Highlight text={r.hit.snippet} query={q} />
                </div>
              )
            }
            const n = r.node
            const onContextMenu = (e: React.MouseEvent): void => {
              setCursor(r.key)
              menu.open(e, menuFor(n))
            }
            const more = (e: React.MouseEvent): void => {
              const b = e.currentTarget.getBoundingClientRect()
              setCursor(r.key)
              menu.openAt(b.left, b.bottom + 2, menuFor(n))
            }
            if (n.kind !== 'session') {
              return <BranchRow key={r.key} n={n} depth={r.depth} open={isOpen(n)} cursor={cursor === r.key} onClick={() => (setCursor(r.key), toggle(n))} onContextMenu={onContextMenu} onMore={more} />
            }
            const s = n.item
            return (
              <SessionRow
                key={r.key}
                s={s}
                name={sessionName(s)}
                depth={r.depth}
                open={isOpen(n)}
                kids={n.children}
                orphan={n.orphan}
                live={liveById.get(s.id)?.status ?? null}
                origin={origin(s)}
                block={whyNot(s)}
                warnMB={warnMB}
                assistant={assistant}
                selected={s.id === selectedId}
                cursor={cursor === r.key}
                onClick={() => activate(r)}
                onToggle={() => toggle(n)}
                onContextMenu={onContextMenu}
                buttons={
                  <>
                    {s.source === 'combwork' && <IconButton icon="tag" title={tr(RENAME)} onClick={() => void rename(s)} />}
                    {!isLive(s.id) && <IconButton icon="trash" title={tr(DELETE_ONE, { kind })} onClick={() => void remove(s)} />}
                    <IconButton icon="ellipsis" title={tr(MORE_ACTIONS)} onClick={more} />
                  </>
                }
              />
            )
          })}
        </div>
      </div>
      <div className="split-main">
        {selected ? (
          <TranscriptView
            key={`${project.path}|${selected.id}`}
            project={project}
            session={selected}
            origin={origin(selected)}
            live={isLive(selected.id)}
            jump={jump?.sessionId === selected.id ? jump : null}
            query={q}
            viewId={viewId}
            marker={<SessionMarker s={selected} block={whyNot(selected)} live={isLive(selected.id)} orphan={!!selected.sub && !byId.has(selected.sub.parentId ?? '')} />}
            toolbar={
              <>
                {selected.source === 'external' && !selected.sub && (
                  <button className="btn small subtle" onClick={() => void actions.attempt(tr(ADOPT_FAILED), () => call('session:adopt', project.path, selected.id)).then(reload)}>
                    {tr(ADOPT)}
                  </button>
                )}
                {selected.source === 'combwork' && <IconButton icon="tag" title={tr(RENAME)} onClick={() => void rename(selected)} />}
                {selected.source === 'combwork' && !isLive(selected.id) && (
                  <IconButton icon={selected.archived ? 'unarchive' : 'archive'} title={selected.archived ? tr(UNARCHIVE) : tr(ARCHIVE)} onClick={() => void archive(selected, !selected.archived)} />
                )}
                {!isLive(selected.id) && <IconButton icon="trash" title={tr(DELETE_ONE, { kind })} onClick={() => void remove(selected)} />}
                {isLive(selected.id) && (() => {
                  const holder = project.agents.find((a) => a.live?.sessionId === selected.id)!
                  return (
                    <Tooltip content={assistant ? tr(msg({ id: 'sessions.running.assistantTip', defaultMessage: 'The Assistant is running this conversation. Show its panel.', description: "Tooltip of Show over the Combwork Assistant's running conversation." })) : tr(msg({ id: 'sessions.running.agentTip', defaultMessage: 'This conversation is running in {agent}. Show its terminal.', description: "Tooltip of Show over a running session's transcript: the agent running it ({agent}: its name)." }), { agent: holder.name })}>
                      <button className="btn small" onClick={() => (assistant ? setAssistantOpen(true) : revealAgent(project, holder.id))}>
                        <Icon name="terminal" /> {many ? tr(msg({ id: 'sessions.running.showAgent', defaultMessage: 'Show {agent}', description: "Button over a running session's transcript: shows the agent running it ({agent}: its name)." }), { agent: holder.name }) : tr(msg({ id: 'sessions.running.show', defaultMessage: 'Show', description: "Button over a running session's transcript: shows its agent's terminal (the Assistant's panel). Keep it short." }))}
                      </button>
                    </Tooltip>
                  )
                })()}
                {!selected.archived && !isLive(selected.id) && (() => {
                  const block = whyNot(selected)
                  // Can't be resumed: the buttons stay, disabled, and say why. One whose slot holds other work now (#1434) can
                  // start its agent afresh from a handover instead (its transcript is the one shown here).
                  if (block) {
                    const fresh = !!selected.hold && !!selected.agentId && project.agents.some((a) => a.id === selected.agentId)
                    return (
                      <>
                        <Tooltip content={block}>
                          <span className="resume-blocked">
                            <button className="btn small act-resume" disabled>
                              <Icon name="debug-continue" /> {tr(RESUME)}
                            </button>
                          </span>
                        </Tooltip>
                        {fresh && (
                          <button className="btn small" data-action="start-fresh-handover" onClick={() => set({ handOverFor: { project: project.path, agentId: selected.agentId! } })}>
                            <Icon name="arrow-swap" /> {tr(msg({ id: 'sessions.resume.startFresh', defaultMessage: 'Start Fresh with a Handover', description: "Button over a session's transcript that can't resume where it ran (#1434: its slot holds other work): opens Hand Over to… for its agent, which starts a new conversation from a handover." }))}
                          </button>
                        )}
                      </>
                    )
                  }
                  const agents = actions.agentsForSession(project, selected)
                  const target = actions.resumeTarget(project, selected)
                  const targetAgent = agents.find((a) => a.id === target) ?? null
                  const targetName = targetAgent?.name
                  // Its slot free and as it left it (#1434): this Resume takes it again, as Resume All doesn't.
                  // HI-2540: one that can't continue starts a new conversation, said before Resume is pressed.
                  const note = (selected.hold?.is === 'byHand' ? shownText(holdText(selected.hold, targetName ?? selected.agentName ?? '')) : null) ?? removedAgentNote(selected, project.agents, targetAgent) ?? (selected.fresh ? freshTip(selected.fresh, sessionName(selected)) : null)
                  if (agents.length < 2) {
                    const button = (
                      <button className="btn small act-resume" disabled={!!resuming || targetStarting} aria-busy={!!resuming || undefined} onClick={() => void actions.resumeSession(project.path, selected)}>
                        <Icon name={resuming ? 'loading' : 'debug-continue'} spin={!!resuming} /> {resuming ? startingLabel(resuming) : tr(RESUME)}
                      </button>
                    )
                    return note ? <Tooltip content={note}>{button}</Tooltip> : button
                  }
                  return (
                    <span className="split-btn">
                      <Tooltip content={note ?? (targetName ? tr(RESUME_IN, { agent: targetName }) : tr(msg({ id: 'sessions.resume.addsTip', defaultMessage: 'Resume (adds an agent if none can run it)', description: "Tooltip of Resume when no agent can run the session: Resume adds one." })))}>
                        <button className="btn small act-resume" disabled={!!resuming || targetStarting} aria-busy={!!resuming || undefined} onClick={() => void actions.resumeSession(project.path, selected)}>
                          <Icon name={resuming ? 'loading' : 'debug-continue'} spin={!!resuming} /> {resuming ? startingLabel(resuming) : targetName ? tr(RESUME_IN, { agent: targetName }) : tr(RESUME)}
                        </button>
                      </Tooltip>
                      <Tooltip content={tr(RESUME_ELSEWHERE)}>
                        <button
                          className="btn small act-resume split-caret"
                          disabled={!!resuming || targetStarting}
                          aria-label={tr(RESUME_ELSEWHERE)}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect()
                            resumeMenu.openAt(r.left, r.bottom + 2, [
                              { header: true, label: tr(msg({ id: 'sessions.resume.menuHeader', defaultMessage: 'Resume in', description: 'The heading of the menu of agents a session can resume in.' })) },
                              ...agents.map((a) => ({
                                label: a.name,
                                icon: a.id === target ? 'debug-continue' : 'person',
                                // Starting already (#1177).
                                disabled: !!get().starting[startingKey(project.path, a.id)],
                                detail: tr(msg({ id: 'sessions.resume.agentDetail', defaultMessage: '{where, select, worktree {worktree · {branch}} place {{place}} other {project folder}}{running, select, yes { · running, its current session stops first} other {}}', description: 'Under an agent in the Resume in menu: where it works (its worktree from before 1.0 and its branch; a slot, carried slot or home ({place}: agents.place.short, such as "in slot-b"); or the project folder; lower case), and, when it runs, that its current session stops first.' }), { where: legacyOf(a) ? 'worktree' : placeText(a.place) ? 'place' : 'folder', branch: legacyOf(a)?.branch ?? '', place: placeText(a.place) ?? '', running: a.live ? 'yes' : 'no' }),
                                onClick: () => void actions.resumeSession(project.path, selected, a.id)
                              }))
                            ])
                          }}
                        >
                          <Icon name="chevron-down" />
                        </button>
                      </Tooltip>
                      {resumeMenu.element}
                    </span>
                  )
                })()}
              </>
            }
          />
        ) : (
          <div className="empty-state">
            <Icon name="history" />
            {items.length ? tr(msg({ id: 'sessions.empty.select', defaultMessage: '{kind, select, conversation {Select a conversation to read its transcript.} other {Select a session to read its transcript.}}', description: "The Sessions tab's reading pane with nothing selected (the Combwork Assistant's: conversation)." }), { kind }) : tr(NONE_YET, { kind })}
          </div>
        )}
      </div>
      {menu.element}
      {purging && (
        <PurgeDialog
          target={{ kind: 'session', projectPath: project.path, sessionId: purging.id }}
          name={sessionName(purging)}
          beforeApply={async () => {
            purgeClosed.current = await closeView([purging.id])
          }}
          onClose={() => {
            moving.current = false
            if (purgeClosed.current) setSelectedId(purgeClosed.current)
            purgeClosed.current = null
            setPurging(null)
          }}
          onDone={() => {
            // Open again where it is now: a session whose last copy went is gone, and the list shows another.
            moving.current = false
            if (purgeClosed.current) setSelectedId(purgeClosed.current)
            purgeClosed.current = null
            setPurging(null)
            reload()
          }}
        />
      )}
      {cleaningUp && (
        <SessionCleanup
          projectPath={project.path}
          items={shown}
          kind={kind}
          live={isLive}
          shown={selectedId}
          current={assistant ? (project.agents[0]?.resume?.id ?? project.agents[0]?.lastSessionId ?? null) : null}
          skipText={cleanupSkipText}
          onClose={() => setCleaningUp(false)}
          onDone={(action, r, skipped) => {
            reportBulk(action, r, (id) => {
              const s = byId.get(id)
              return s ? sessionName(s) : id.slice(0, 8)
            }, false, skipped)
            reload()
          }}
        />
      )}
    </div>
  )
}

/** What a bulk action did: one line, and what it skipped and why (`before`: what Clean Up left alone before asking). */
function reportBulk(action: SessionBulkAction, r: SessionBulkResult, name: (id: string) => string, closedView: boolean, before: CleanupPlan['skipped'] = []): void {
  const n = r.done.length
  const head = { action, n }
  const closed = closedView ? tr(msg({ id: 'sessions.bulk.closedView', defaultMessage: 'The transcript you were reading was one of them: it was closed first.', description: 'In the report of archiving or deleting many sessions: the transcript open in the tab was one of them, so it was closed.' })) : undefined
  const skipped = [...before.map((s) => ({ id: s.item.id, key: s.reason as string, why: cleanupSkipText(s.reason), message: undefined as string | undefined })), ...r.skipped.map((s) => ({ id: s.id, key: skipKey(s.reason), why: skipText(s.reason), message: s.message }))]
  if (!skipped.length) return notify('success', tr(msg({ id: 'sessions.bulk.done', defaultMessage: '{action, select, archive {Archived} unarchive {Unarchived} other {Deleted}} {n, plural, one {# session} other {# sessions}}.', description: "A notification's title: how many sessions were archived, unarchived or deleted." }), head), closed)
  const reasons = new Map<string, number>()
  for (const s of skipped) reasons.set(s.key, (reasons.get(s.key) ?? 0) + 1)
  const why = fmt.list(
    [...reasons].map(([k, v]) => tr(msg({ id: 'sessions.bulk.skipCount', defaultMessage: "{reason, select, live {{n, plural, one {# running} other {# running}}} inUse {{n, plural, one {# in use} other {# in use}}} reading {{n, plural, one {# being read by Combwork} other {# being read by Combwork}}} open {{n, plural, one {# open in another Combwork window} other {# open in other Combwork windows}}} external {{n, plural, one {# started outside Combwork} other {# started outside Combwork}}} shown {{n, plural, one {# open here} other {# open here}}} current {{n, plural, one {# current Assistant conversation} other {# current Assistant conversations}}} other {{n, plural, one {# failed} other {# failed}}}}", description: 'How many sessions were passed over for one reason, listed after "n skipped:" ("2 running, 1 in use"). {reason} picks why: running, files in use, Combwork is reading it, open in another Combwork window, started outside Combwork, open in this tab, the Combwork Assistant\'s current conversation, or it failed (other).' }), { n: v, reason: k })),
    'unit'
  )
  const shown = skipped.slice(0, 6).map((s) => `• ${name(s.id)}: ${s.why}${s.message ? ` (${s.message})` : ''}`)
  if (skipped.length > shown.length) shown.push(tr(msg({ id: 'sessions.bulk.andMore', defaultMessage: '…and {n, number} more', description: 'The last line of the list of sessions passed over, when it is cut short: how many more.' }), { n: skipped.length - shown.length }))
  if (closed) shown.push(closed)
  notify(n ? 'warning' : 'error', tr(msg({ id: 'sessions.bulk.doneSkipped', defaultMessage: '{action, select, archive {Archived} unarchive {Unarchived} other {Deleted}} {n, plural, one {# session} other {# sessions}}; {skipped, number} skipped: {why}', description: "A notification's title: how many sessions were archived, unarchived or deleted, and how many were passed over and why ({why}: \"2 running, 1 in use\")." }), { ...head, skipped: skipped.length, why }), shown.join('\n'))
}

// The words used in several places of the tab, as messages (shown with tr() where they render).
const RENAME = msg({ id: 'sessions.common.rename', defaultMessage: 'Rename', description: 'Button or tooltip: renames a session. Keep it short.' })
const ARCHIVE = msg({ id: 'sessions.common.archive', defaultMessage: 'Archive', description: 'Button, menu item or tooltip: archives a session (hides it, keeping its transcript). Keep it short.' })
const UNARCHIVE = msg({ id: 'sessions.common.unarchive', defaultMessage: 'Unarchive', description: 'Button, menu item or tooltip: brings an archived session back to the list. Keep it short.' })
const RESUME = msg({ id: 'sessions.common.resume', defaultMessage: 'Resume', description: 'Button or menu item: resumes a session in its agent. Keep it short.' })
const RESUME_IN = msg({ id: 'sessions.common.resumeIn', defaultMessage: 'Resume in {agent}', description: 'Button or tooltip: resumes the session in an agent ({agent}: its name).' })
const RESUME_ELSEWHERE = msg({ id: 'sessions.common.resumeElsewhere', defaultMessage: 'Resume in another agent', description: "Tooltip and accessible name of the Resume button's arrow: choose the agent to resume in." })
const ADOPT = msg({ id: 'sessions.common.adopt', defaultMessage: 'Adopt', description: 'Button or menu item on a session started outside Combwork: lets Combwork manage it. Keep it short.' })
const ADOPT_FAILED = msg({ id: 'sessions.common.adoptFailed', defaultMessage: 'Could not adopt', description: "An error's title: adopting a session started outside Combwork failed." })
const EXPAND_ALL = msg({ id: 'sessions.common.expandAll', defaultMessage: 'Expand All', description: 'Menu item or tooltip: opens every branch of the Sessions tree.' })
const COLLAPSE_ALL = msg({ id: 'sessions.common.collapseAll', defaultMessage: 'Collapse All', description: 'Menu item or tooltip: folds every branch of the Sessions tree.' })
const MORE_ACTIONS = msg({ id: 'sessions.common.moreActions', defaultMessage: 'More Actions', description: "Tooltip of a row's ⋯ button: opens its menu." })
const LOADING = msg({ id: 'sessions.common.loading', defaultMessage: 'Loading…', description: 'While the Sessions list or a transcript loads.' })
const DELETE_ONE = msg({ id: 'sessions.common.delete', defaultMessage: '{kind, select, conversation {Delete conversation} other {Delete session}}', description: "Tooltip of a session's delete button (the Combwork Assistant's: conversation)." })
const NONE_YET = msg({ id: 'sessions.common.noneYet', defaultMessage: '{kind, select, conversation {No conversations yet.} other {No sessions yet.}}', description: "The Sessions tab with no sessions (the Combwork Assistant's: conversations)." })

/** What a search match is in: a message of the transcript, by its kind. */
const HIT_KIND: Record<TranscriptItem['kind'], Msg> = {
  user: msg({ id: 'sessions.hit.user', defaultMessage: 'You', description: "A search match's kind (Sessions search): in the user's prompt. Keep it short." }),
  assistant: msg({ id: 'sessions.hit.assistant', defaultMessage: 'Reply', description: "A search match's kind: in the agent's reply. Keep it short." }),
  thinking: msg({ id: 'sessions.hit.thinking', defaultMessage: 'Thinking', description: "A search match's kind: in the agent's thinking. Keep it short." }),
  tool: msg({ id: 'sessions.hit.tool', defaultMessage: 'Tool', description: "A search match's kind: in a tool call. Keep it short." }),
  compaction: msg({ id: 'sessions.hit.compaction', defaultMessage: 'Summary', description: "A search match's kind: in a compaction's summary. Keep it short." }),
  command: msg({ id: 'sessions.hit.command', defaultMessage: 'Command', description: "A search match's kind: in a command the user typed (/compact…). Keep it short." }),
  notice: msg({ id: 'sessions.hit.notice', defaultMessage: 'Notice', description: "A search match's kind: in a notice from the CLI. Keep it short." })
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (!query || at === -1) return <span className="hit-text">{text}</span>
  return (
    <span className="hit-text">
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </span>
  )
}

/** A provider or agent in the tree: like a folder in the Files tree, with its count and ⋯ for its actions. */
function BranchRow({ n, depth, open, cursor, onClick, onContextMenu, onMore }: { n: Exclude<TreeNode, { kind: 'session' }>; depth: number; open: boolean; cursor: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void; onMore: (e: React.MouseEvent) => void }) {
  const c = countsIn(n)
  return (
    <div data-key={n.key} className={cx('row', 'file-row', 'session-branch', `session-branch-${n.kind}`, cursor && 'cursor')} style={{ paddingLeft: 8 + depth * 14 }} onClick={onClick} onContextMenu={onContextMenu}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} className="twistie" />
      {n.kind === 'provider' ? <ProviderIcon provider={n.provider} /> : <Icon name={n.agentId ? 'person' : 'circle-slash'} className="file-icon" />}
      <span className={cx('label', n.removed && 'removed')}>{n.label}</span>
      <Tooltip content={countText(c)}>
        <span className="tree-count">
          {fmt.number(c.sessions)}
          {c.subs > 0 && <span className="faint"> + {fmt.number(c.subs)}</span>}
        </span>
      </Tooltip>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton icon="ellipsis" title={tr(MORE_ACTIONS)} onClick={onMore} />
      </div>
    </div>
  )
}

/** A sub-session's kind, or why a session can't be resumed (shown in the tree and over its transcript). */
function SessionMarker({ s, block, live, orphan }: { s: SessionListItem; block: string | null; live: boolean; orphan: boolean }) {
  if (s.sub) {
    return (
      <Tooltip content={`${block ?? ''}${orphan ? `\n${tr(msg({ id: 'sessions.marker.orphan', defaultMessage: "The session that started it isn't listed (deleted, or not from this project).", description: "On a sub-session (a session another one started): the session that started it isn't in the list." }))}` : ''}`.trim()}>
        <span className="badge sub-kind">
          <Icon name="type-hierarchy-sub" /> {s.sub.kind}
        </span>
      </Tooltip>
    )
  }
  if (!block || live || s.archived) return null
  return (
    <Tooltip content={block}>
      <span className="badge cant-resume">
        <Icon name="debug-disconnect" /> {tr(msg({ id: 'sessions.marker.cantResume', defaultMessage: "can't resume", description: "A badge on a session that can't be resumed (its hover says why). Lower case; keep it short." }))}
      </span>
    </Tooltip>
  )
}

/** The transcript's size on disk (#671): amber past Warn when a transcript is over, with what to do about it. */
function TranscriptSize({ s, warnMB, assistant }: { s: SessionListItem; warnMB: number; assistant: boolean }) {
  const { text, long } = transcriptSizeInfo(s.transcriptBytes, warnMB)
  const kind: Kind = assistant ? 'conversation' : 'session'
  const tip =
    text === '—'
      ? tr(msg({ id: 'sessions.size.none', defaultMessage: '{kind, select, conversation {{cli} has no transcript file for this conversation} other {{cli} has no transcript file for this session}}{backup, select, yes { (Combwork keeps a backup of it)} other {}}.', description: "Hover of a session's transcript size when the CLI ({cli}) has no file for it; and when Combwork has a backup of it, that it does." }), { kind, cli: providerName(s.provider), backup: s.hasBackup ? 'yes' : 'no' })
      : tr(msg({ id: 'sessions.size.tip', defaultMessage: 'Transcript: {size} on disk{limit, plural, =0 {} other { (flagged over # MB: Settings → Sessions)}}.{long, select, conversation { A long conversation slows down the CLI and Combwork, and compacting doesn\'t shrink the file. Start a new conversation (⋯ → New Conversation) to make it short again.} session { A long conversation slows down the CLI and Combwork, and compacting doesn\'t shrink the file. Hand the work over to a new conversation (Hand Over to…) to make it short again.} other {}}', description: "Hover of a session's transcript size ({size}: \"6.1 MB\"), the size it is flagged over ({limit} MB, set in Settings → Sessions; 0: leave it empty), and, when it is over (long: the Combwork Assistant's conversation or an agent's session), what to do. \"New Conversation\" and \"Hand Over to…\" are commands: use their translations." }), { size: text, limit: warnMB, long: long ? kind : 'no' })
  return (
    <Tooltip content={tip}>
      <span className={cx('session-row-size', long && 'warn-text')}>{text}</span>
    </Tooltip>
  )
}

function SessionRow(props: {
  s: SessionListItem
  name: string
  depth: number
  open: boolean
  kids: readonly TreeNode[]
  orphan: boolean
  live: string | null
  origin: SessionOrigin | null
  block: string | null
  warnMB: number
  assistant: boolean
  selected: boolean
  cursor: boolean
  onClick: () => void
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
  buttons: React.ReactNode
}) {
  const { s, name, live, origin, kids } = props
  const kinds = new Set(kids.map((k) => (k.kind === 'session' ? k.item.sub?.kind : null)))
  const kind = kinds.size === 1 ? [...kinds][0] : null
  return (
    <div
      data-key={sessionKey(s.id)}
      className={cx('session-row', props.selected && 'selected', props.cursor && 'cursor', s.archived && 'archived', s.sub && 'sub')}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
    >
      <div className="session-row-title">
        {kids.length ? (
          <span
            className="twistie"
            onClick={(e) => {
              e.stopPropagation()
              props.onToggle()
            }}
          >
            <Icon name={props.open ? 'chevron-down' : 'chevron-right'} />
          </span>
        ) : (
          <span className="twistie" />
        )}
        {live && <span className={cx('dot', live)} />}
        <Tooltip content={providerName(s.provider)}>
          <span>
            <ProviderIcon provider={s.provider} />
          </span>
        </Tooltip>
        <strong>{name}</strong>
      </div>
      <div className="session-row-meta">
        {s.lastActivity ? (
          <Tooltip content={tr(msg({ id: 'sessions.row.lastActive', defaultMessage: 'Last active {when}', description: "Hover of a session's time in the list: when it was last active ({when}: a date and time)." }), { when: formatDateTime(s.lastActivity) })}>
            <span className="session-row-when">{timeAgo(s.lastActivity)}</span>
          </Tooltip>
        ) : (
          <span>{timeAgo(s.lastActivity)}</span>
        )}
        {s.usage && <span className="session-row-context">{tr(msg({ id: 'sessions.row.context', defaultMessage: '{tokens} context', description: 'A session row in the list: how many tokens its context holds ({tokens}: "120K"). Keep it short.' }), { tokens: formatTokens(s.usage.contextTokens) })}</span>}
        <TranscriptSize s={s} warnMB={props.warnMB} assistant={props.assistant} />
        {origin && (
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{origin.detail}</span>}>
            <span className="badge session-origin">{origin.location}</span>
          </Tooltip>
        )}
        {s.source === 'external' && !s.sub && (
          <Tooltip content={tr(msg({ id: 'sessions.row.externalTip', defaultMessage: 'Started outside Combwork (e.g. in VS Code or a terminal). Adopt it to manage it here.', description: 'Hover of the external badge on a session started outside Combwork. Adopt is a button: use its translation.' }))}>
            <span className="badge info">{tr(msg({ id: 'sessions.row.external', defaultMessage: 'external', description: 'A badge on a session started outside Combwork. Lower case; keep it short.' }))}</span>
          </Tooltip>
        )}
        {s.archived && <span className="badge">{tr(msg({ id: 'sessions.row.archived', defaultMessage: 'archived', description: 'A badge on an archived session. Lower case; keep it short.' }))}</span>}
        {!s.hasTranscript && s.hasBackup && (
          <Tooltip content={tr(msg({ id: 'sessions.row.backupTip', defaultMessage: '{cli} no longer has this transcript; Combwork shows and resumes it from its backup.', description: "Hover of the backup badge: the CLI ({cli}) deleted the session's transcript, and Combwork uses its own copy." }), { cli: providerName(s.provider) })}>
            <span className="badge warn">{tr(msg({ id: 'sessions.row.backup', defaultMessage: 'backup', description: "A badge on a session read from Combwork's backup (the CLI deleted its own copy). Lower case; keep it short." }))}</span>
          </Tooltip>
        )}
        <SessionMarker s={s} block={props.block} live={!!live} orphan={props.orphan} />
        {kids.length > 0 && (
          <Tooltip content={tr(msg({ id: 'sessions.row.subsTip', defaultMessage: 'Sessions {cli} started for this one: {n}', description: 'Hover of the badge counting the sessions this one started ({cli}: the CLI that started them; {n}: how many).' }), { cli: providerName(s.provider), n: kids.length })}>
            <span className="badge sub-count">
              {kind ? `${kids.length} ${kind}${kids.length === 1 ? '' : 's'}` /* i18n-ignore: the CLI's own name for these sessions ("guardian review"), made plural as the CLI's English is */ : tr(msg({ id: 'sessions.row.subs', defaultMessage: '{n, plural, one {# sub-session} other {# sub-sessions}}', description: 'A badge counting the sessions this one started (sub-sessions). Keep it short.' }), { n: kids.length })}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {props.buttons}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcript viewer
// ---------------------------------------------------------------------------

/** Items grouped the way they are read: your message, then everything the agent did in reply. */
type Block =
  | { kind: 'user'; item: Extract<TranscriptItem, { kind: 'user' }> }
  | { kind: 'reply'; items: TranscriptItem[] }
  | { kind: 'other'; item: TranscriptItem }

function toBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = []
  for (const item of items) {
    if (item.kind === 'user') out.push({ kind: 'user', item })
    else if (item.kind === 'assistant' || item.kind === 'thinking' || item.kind === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'reply') last.items.push(item)
      else out.push({ kind: 'reply', items: [item] })
    } else out.push({ kind: 'other', item })
  }
  return out
}

const time = (ts: string | null): string => (ts ? formatDateTime(ts) : '')

function TranscriptView({ project, session, origin, live, jump, query, viewId, marker, toolbar }: { project: ProjectInfo; session: SessionListItem; origin: SessionOrigin | null; live: boolean; jump: Jump | null; query: string; viewId: string; marker: React.ReactNode; toolbar: React.ReactNode }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  // Main knows this transcript is open here: archiving or deleting it skips it (this tab closes it first: closeView).
  useEffect(() => {
    void call('transcript:viewing', viewId, project.path, session.id).catch(() => undefined)
    return () => void call('transcript:viewing', viewId, project.path, null).catch(() => undefined)
  }, [viewId, project.path, session.id])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [allOpen, setAllOpen] = useState(false)
  const [viewing, setViewing] = useState<TranscriptImageRef | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const versionRef = useRef<string | undefined>(undefined)
  /** The first item loaded: the latest TRANSCRIPT_WINDOW open first, earlier ones load as you scroll up. */
  const fromRef = useRef<number | undefined>(undefined)
  /** Scrolling up loaded earlier items: keep the view where it was (distance from the bottom). */
  const keepBottom = useRef<number | null>(null)
  const loadingEarlier = useRef(false)
  /** Whether the view follows the end of the transcript. */
  const pinned = useRef(jump === null)
  /**
   * A jump placed the view (a search hit, a compaction): only the user's own scrolling follows the end again, not the
   * scroll events of Hive's own scrolls (#1323: the opening scroll to the end, its event arriving after the jump, pinned
   * the view again and the jump was scrolled away).
   */
  const placed = useRef(false)
  const unplace = (): void => {
    placed.current = false
  }
  const followDefault = useStore((s) => s.settings?.sessions.followTranscripts ?? false)
  useDateStyle()
  // A running session is followed only when switched on (Follow), else it updates with Refresh.
  const [follow, setFollow] = useState(followDefault)

  const load = useCallback(
    async (opts: { from?: number; force?: boolean } = {}) => {
      try {
        const from = opts.from ?? fromRef.current
        const same = from === fromRef.current && !opts.force
        const t = await call('transcript:read', project.path, session.id, { knownVersion: same ? versionRef.current : undefined, from })
        if (!t) return
        versionRef.current = t.version
        fromRef.current = t.from
        setTranscript(t)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [project.path, session.id]
  )

  useEffect(() => {
    fromRef.current = undefined
    versionRef.current = undefined
    void load()
  }, [load])
  // Follow a running session as its CLI appends to it (when switched on).
  useEffect(() => {
    if (!live || !follow) return
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [live, follow, load])

  /** Loads the TRANSCRIPT_WINDOW items before the first one shown, keeping the view where it is. */
  const loadEarlier = useCallback(async () => {
    const el = scroller.current
    const from = fromRef.current ?? 0
    if (!el || from <= 0 || loadingEarlier.current) return
    loadingEarlier.current = true
    keepBottom.current = el.scrollHeight - el.scrollTop
    await load({ from: Math.max(0, from - TRANSCRIPT_WINDOW) })
    loadingEarlier.current = false
  }, [load])

  // Open at the latest message and stay there while new messages arrive, unless you scroll up.
  // Blocks off screen are laid out lazily with estimated heights that settle as they render, so
  // the body is watched for size changes rather than scrolled once.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !transcript) return
    if (keepBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepBottom.current
      keepBottom.current = null
    } else if (pinned.current) el.scrollTop = el.scrollHeight
  }, [transcript])
  const hasTranscript = transcript !== null
  useEffect(() => {
    const el = scroller.current
    const body = el?.firstElementChild
    if (!el || !body) return
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(body)
    return () => ro.disconnect()
  }, [hasTranscript])

  // Jump to a search hit: expand it if it's collapsed, then scroll it into the middle.
  useEffect(() => {
    if (!jump || !transcript) return
    // A hit before the loaded items: load from a little before it first.
    if (jump.itemId < transcript.from) {
      void load({ from: Math.max(0, jump.itemId - 50) })
      return
    }
    // Runs for a new jump, or once its items have loaded — not on every transcript update (it would scroll back).
    pinned.current = false
    placed.current = true
    setExpanded((s) => new Set(s).add(jump.itemId))
    let frames = 0
    const go = (): void => {
      const el = document.getElementById(`tx-${jump.itemId}`)
      el?.scrollIntoView({ block: 'center' })
      // Blocks around it render lazily and can shift it, so settle for a few frames.
      if (++frames < 4) requestAnimationFrame(go)
      else if (el) {
        el.classList.remove('flash')
        void el.offsetWidth
        el.classList.add('flash')
      }
    }
    requestAnimationFrame(go)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, hasTranscript, transcript?.from])

  // Highlight the search text everywhere it's rendered (CSS Custom Highlight API).
  useEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!reg || !H) return
    const root = scroller.current
    if (!query || !root) {
      reg.delete('cw-search')
      return
    }
    const ranges: Range[] = []
    const q = query.toLowerCase()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && ranges.length < 2000; n = walker.nextNode()) {
      const text = n.textContent?.toLowerCase() ?? ''
      for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + q.length)) {
        const r = new Range()
        r.setStart(n, at)
        r.setEnd(n, at + q.length)
        ranges.push(r)
      }
    }
    reg.set('cw-search', new H(...ranges))
    return () => void reg.delete('cw-search')
  })

  const blocks = useMemo(() => (transcript ? toBlocks(transcript.items) : []), [transcript])
  const images = useMemo(() => transcript?.items.flatMap((i) => (i.kind === 'user' ? i.images : i.kind === 'tool' ? i.tool.images : [])) ?? [], [transcript])
  const toggle = useCallback((id: number) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  }), [])
  const isOpen = (id: number): boolean => allOpen !== expanded.has(id)

  const u = session.usage
  const exportMd = async (): Promise<void> => {
    const path = await actions.attempt(tr(msg({ id: 'sessions.export.failed', defaultMessage: 'Could not export', description: "An error's title: exporting a transcript as Markdown failed." })), () => call('transcript:export', project.path, session.id, sessionLabel(session, project.name, tr)))
    if (path) notify('success', tr(msg({ id: 'sessions.export.done', defaultMessage: 'Transcript exported', description: "A notification's title: the transcript was saved as a Markdown file (its path follows)." })), path)
  }

  return (
    <>
      <div className="editor-toolbar transcript-toolbar">
        <Icon name="comment-discussion" />
        <span className="path">
          <strong>{sessionLabel(session, project.name, tr)}</strong>
          {live && <span className="badge accent" style={{ marginLeft: 8 }}>{tr(msg({ id: 'sessions.view.running', defaultMessage: 'Running', description: "A badge over a running session's transcript. Keep it short." }))}</span>}
          {marker && <span style={{ marginLeft: 8 }}>{marker}</span>}
          {session.handedOverFrom && (
            <Tooltip content={tr(msg({ id: 'sessions.view.handedOverTip', defaultMessage: "Another agent's work was handed over to this session. Click to open that session.", description: "Hover of the handed over badge over a transcript: the session it continues from." }))}>
              <span className="badge link" style={{ marginLeft: 8 }} onClick={() => openInSessionsTab(project.path, session.handedOverFrom!)}>
                <Icon name="arrow-swap" /> {tr(msg({ id: 'sessions.view.handedOver', defaultMessage: 'handed over', description: "A badge over a transcript: another agent's work was handed over to this session. Lower case; keep it short." }))}
              </span>
            </Tooltip>
          )}
          {u && (
            <span className="faint" style={{ marginLeft: 8 }}>
              {tr(msg({ id: 'sessions.view.usage', defaultMessage: '{context} context · {output} output · {prompts, plural, one {# prompt} other {# prompts}}{compactions, plural, =0 {} one { · # compaction} other { · # compactions}}{cache, select, warm { · cache warm {left}} expired { · cache expired} other {}}', description: 'Over a transcript: its context and output tokens ("120K"), how many prompts the user sent, how many times it was compacted (none: leave it empty), and whether the provider\'s prompt cache is still warm for {left} ("4m") or has expired, so resuming re-caches the conversation (not known: leave it empty).' }), { context: formatTokens(u.contextTokens), output: formatTokens(u.outputTokens), prompts: u.userMessages, compactions: u.compactions.length, cache: !session.recache ? 'none' : session.recache.warm ? 'warm' : 'expired', left: session.recache?.warm ? formatDuration(session.recache.secondsLeft) : '' })}
            </span>
          )}
        </span>
        <IconButton icon={allOpen ? 'collapse-all' : 'expand-all'} title={allOpen ? tr(msg({ id: 'sessions.view.collapseTools', defaultMessage: 'Collapse Tool Calls', description: "Tooltip over a transcript: folds every tool call and the agent's thinking." })) : tr(msg({ id: 'sessions.view.expandTools', defaultMessage: 'Expand Tool Calls', description: "Tooltip over a transcript: opens every tool call and the agent's thinking." }))} onClick={() => {
          setAllOpen(!allOpen)
          setExpanded(new Set())
        }} />
        <IconButton icon="export" title={tr(msg({ id: 'sessions.view.export', defaultMessage: 'Export as Markdown…', description: 'Tooltip over a transcript: saves it as a Markdown file.' }))} disabled={!transcript} onClick={() => void exportMd()} />
        {live && (
          <Tooltip content={follow ? tr(msg({ id: 'sessions.view.followingTip', defaultMessage: 'Following new messages as they arrive. Click to stop.', description: "Tooltip of Follow over a running session's transcript, while on." })) : tr(msg({ id: 'sessions.view.followTip', defaultMessage: 'Follow new messages as they arrive (Settings → Sessions sets the default)', description: "Tooltip of Follow over a running session's transcript, while off. Settings → Sessions is where: use its translated names." }))}>
            <button className={cx('btn', 'small', 'subtle', follow && 'active')} onClick={() => setFollow(!follow)}>
              <Icon name={follow ? 'eye' : 'eye-closed'} /> {tr(msg({ id: 'sessions.view.follow', defaultMessage: 'Follow', description: "Button over a running session's transcript: keeps showing new messages as they arrive. Keep it short." }))}
            </button>
          </Tooltip>
        )}
        {!follow && <IconButton icon="refresh" title={tr(msg({ id: 'sessions.view.refresh', defaultMessage: 'Refresh (load new messages)', description: 'Tooltip over a transcript: reads it again for new messages.' }))} onClick={() => void load({ force: true })} />}
        {toolbar}
      </div>
      {origin && (
        <div className="session-ran-in faint">
          <Icon name={!session.cwd || session.cwd.toLowerCase() === project.path.toLowerCase() ? 'folder' : 'git-branch'} /> {tr(msg({ id: 'sessions.view.ranIn', defaultMessage: 'Ran in', description: 'Over a transcript, before where the session ran (its agent and the project folder or a worktree).' }))}{' '}
          <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{origin.detail}</span>}>
            <span>{origin.label}</span>
          </Tooltip>
        </div>
      )}
      <WorkedOn cards={session.cards} />
      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          if (!placed.current) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
          if (el.scrollTop < 200) void loadEarlier()
        }}
        onWheel={unplace}
        onPointerDown={unplace}
        onKeyDown={unplace}
      >
        {error ? (
          <div className="empty-state">{/no transcript/i.test(error) ? tr(NOTHING_SAID) : error}</div>
        ) : !transcript ? (
          <div className="empty-state"><Icon name="loading" spin />{tr(LOADING)}</div>
        ) : blocks.length === 0 ? (
          <div className="empty-state">{tr(NOTHING_SAID)}</div>
        ) : (
          <div className="transcript-body">
            {transcript.from > 0 && (
              <div className="transcript-earlier faint">
                <button className="btn small subtle" onClick={() => void loadEarlier()}>
                  <Icon name="fold-up" /> {tr(msg({ id: 'sessions.view.earlier', defaultMessage: '{n, plural, one {# earlier item} other {# earlier items}} — scroll up or click to load', description: 'At the top of a long transcript: how many earlier messages are not loaded yet, and how to load them.' }), { n: transcript.from })}
                </button>
              </div>
            )}
            {blocks.map((b) =>
              b.kind === 'user' ? (
                <UserMessage key={b.item.id} item={b.item} project={project} sessionId={session.id} onImage={setViewing} />
              ) : b.kind === 'reply' ? (
                <Reply key={b.items[0].id} items={b.items} project={project} sessionId={session.id} assistant={providerDescriptor(session.provider).assistant} isOpen={isOpen} toggle={toggle} onImage={setViewing} />
              ) : (
                <OtherItem key={b.item.id} item={b.item} open={isOpen(b.item.id)} toggle={toggle} />
              )
            )}
            {live && follow && <div className="transcript-live faint"><Icon name="loading" spin /> {tr(msg({ id: 'sessions.view.following', defaultMessage: 'Following the running session', description: "At the end of a running session's transcript while Follow is on." }))}</div>}
          </div>
        )}
      </div>
      {viewing && <TranscriptImageViewer project={project} sessionId={session.id} image={viewing} images={images} onNavigate={setViewing} onClose={() => setViewing(null)} />}
    </>
  )
}

const NOTHING_SAID = msg({ id: 'sessions.view.empty', defaultMessage: 'Nothing has been said in this session yet.', description: 'A transcript with no messages yet.' })

function CopyButton({ text, title }: { text: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      icon={done ? 'check' : 'copy'}
      title={title ?? tr(msg({ id: 'sessions.view.copy', defaultMessage: 'Copy', description: 'Tooltip of a copy button in a transcript. Keep it short.' }))}
      onClick={() => {
        copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    />
  )
}

const MemoMarkdown = memo(Markdown)

const UserMessage = memo(function UserMessage({ item, project, sessionId, onImage }: { item: Extract<TranscriptItem, { kind: 'user' }>; project: ProjectInfo; sessionId: string; onImage: (img: TranscriptImageRef) => void }) {
  useLanguage()
  return (
    <div className="tx-block tx-user" id={`tx-${item.id}`}>
      <div className="tx-head">
        <Icon name="person" />
        <strong>{tr(msg({ id: 'sessions.view.you', defaultMessage: 'You', description: "The heading of the user's own message in a transcript. Keep it short." }))}</strong>
        <span className="faint">{time(item.timestamp)}</span>
        <div className="tx-actions">
          <CopyButton text={item.text} title={tr(msg({ id: 'sessions.view.copyMessage', defaultMessage: 'Copy Message', description: "Tooltip: copies the user's message in a transcript." }))} />
        </div>
      </div>
      {item.text.trim() && <div className="tx-user-text">{item.text}</div>}
      {item.images.length > 0 && (
        <div className="tx-images">
          {item.images.map((img) => (
            <TranscriptThumb key={img.id} project={project} sessionId={sessionId} image={img} onOpen={onImage} />
          ))}
        </div>
      )}
    </div>
  )
})

function Reply({ items, project, sessionId, assistant, isOpen, toggle, onImage }: { items: TranscriptItem[]; project: ProjectInfo; sessionId: string; assistant: string; isOpen: (id: number) => boolean; toggle: (id: number) => void; onImage: (img: TranscriptImageRef) => void }) {
  return (
    <div className="tx-block tx-reply">
      <div className="tx-head">
        <Icon name="sparkle" />
        <strong>{assistant}</strong>
        <span className="faint">{time(items[0].timestamp)}</span>
      </div>
      {items.map((item) =>
        item.kind === 'assistant' ? (
          <div key={item.id} id={`tx-${item.id}`} className="tx-text">
            <div className="tx-actions">
              <CopyButton text={item.text} title={tr(msg({ id: 'sessions.view.copyReply', defaultMessage: 'Copy Reply', description: "Tooltip: copies the agent's reply in a transcript." }))} />
            </div>
            <MemoMarkdown source={item.text} />
          </div>
        ) : item.kind === 'thinking' ? (
          <Collapsible key={item.id} id={item.id} open={isOpen(item.id)} toggle={toggle} icon="lightbulb" label={tr(msg({ id: 'sessions.view.thinking', defaultMessage: 'Thinking', description: "A folded part of a transcript: the agent's thinking. Keep it short." }))} className="tx-thinking">
            <div className="tx-pre">{item.text}</div>
          </Collapsible>
        ) : item.kind === 'tool' ? (
          <ToolCall key={item.id} id={item.id} tool={item.tool} open={isOpen(item.id)} toggle={toggle} project={project} sessionId={sessionId} onImage={onImage} />
        ) : null
      )}
    </div>
  )
}

function Collapsible({ id, open, toggle, icon, label, detail, badge, className, anchored = true, children }: { id: number; open: boolean; toggle: (id: number) => void; icon: string; label: React.ReactNode; detail?: string; badge?: React.ReactNode; className?: string; anchored?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx('tx-fold', open && 'open', className)} id={anchored ? `tx-${id}` : undefined}>
      <div className="tx-fold-head" onClick={() => toggle(id)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <Icon name={icon} />
        <span className="tx-fold-label">{label}</span>
        {detail && <span className="tx-fold-detail">{detail}</span>}
        {badge}
      </div>
      {open && <div className="tx-fold-body">{children}</div>}
    </div>
  )
}

const TOOL_ICON: Record<string, string> = { Bash: 'terminal', PowerShell: 'terminal', Shell: 'terminal', Script: 'code', view_image: 'file-media', Read: 'go-to-file', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', Glob: 'search', Grep: 'search', Agent: 'hubot', Task: 'hubot', WebFetch: 'globe', WebSearch: 'globe' }

const NO_CALLS_OPEN: ReadonlySet<number> = new Set()

/** A command's exit code, as a badge says it (HI-2240: a Codex script's command). */
const exitCodeText = (code: number): string => tr(msg({ id: 'sessions.tool.exitCode', defaultMessage: 'exit code {code}', description: "A badge on a command a Codex script ran, in a transcript (HI-2240): the exit code it ended with ({code}: a number such as 0 or 1, shown as it is). Lower case; keep it short." }), { code: String(code) })

/** What kind of call a Codex script's call is, as its line counts it (HI-2240): an MCP server's (by server), or Hive's name for it. */
const callKind = (c: TranscriptTool): string => (c.name.includes(' · ') ? `mcp:${c.name.split(' · ')[0]}` : c.name === 'Shell' ? 'command' : c.name === 'Edit' ? 'edit' : c.name === 'view_image' ? 'image' : 'other')

/**
 * A Codex script's calls in a line (HI-2240, Darren's decision): how many of each kind, in the order they first came
 * ("3 combwork calls, 1 command, 2 edits"), and how many failed.
 */
function callsSummary(calls: TranscriptTool[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(callKind(c), (counts.get(callKind(c)) ?? 0) + 1)
  const parts = [...counts].map(([kind, n]) =>
    kind.startsWith('mcp:')
      ? tr(msg({ id: 'sessions.tool.scriptMcpCalls', defaultMessage: '{n, plural, one {# {server} call} other {# {server} calls}}', description: "Part of a folded Codex script's line in a transcript (HI-2240), in a list such as \"3 combwork calls, 1 command, 2 edits\": how many calls the script made to one MCP server's tools ({server}: the server's name, such as combwork, not translated)." }), { n, server: kind.slice(4) })
      : tr(msg({ id: 'sessions.tool.scriptKindCalls', defaultMessage: '{kind, select, command {{n, plural, one {# command} other {# commands}}} edit {{n, plural, one {# edit} other {# edits}}} image {{n, plural, one {# image view} other {# image views}}} other {{n, plural, one {# other call} other {# other calls}}}}', description: "Part of a folded Codex script's line in a transcript (HI-2240), in a list such as \"3 combwork calls, 1 command, 2 edits\": how many calls of one kind the script made. {kind}: shell commands it ran, file edits it made, images it looked at, or (other) any other tool calls." }), { n, kind })
  )
  const failed = calls.filter((c) => c.isError).length
  if (failed) parts.push(tr(msg({ id: 'sessions.tool.scriptFailedCalls', defaultMessage: '{n, plural, one {# failed} other {# failed}}', description: "The last part of a folded Codex script's line in a transcript (HI-2240), after \"3 combwork calls, 1 command\": how many of the script's calls failed." }), { n: failed }))
  return fmt.list(parts, 'unit')
}

/**
 * A tool call in a transcript, folded. A Codex code-mode script shows the calls it made (HI-2240): folded, how many and
 * which; open, each call folded in turn with its own icon and result, then the script's code and what it printed.
 * `nested`: a script's call, the `index`th of the tool `id` (its whole text is loaded from it).
 */
function ToolCall({ id, tool, open, toggle, project, sessionId, onImage, nested }: { id: number; tool: TranscriptTool; open: boolean; toggle: (id: number) => void; project: ProjectInfo; sessionId: string; onImage: (img: TranscriptImageRef) => void; nested?: { parent: number; index: number } }) {
  const [full, setFull] = useState<TranscriptTool | null>(null)
  const [openCalls, setOpenCalls] = useState<ReadonlySet<number>>(NO_CALLS_OPEN)
  const toggleCall = useCallback((i: number) => setOpenCalls((was) => {
    const next = new Set(was)
    if (!next.delete(i)) next.add(i)
    return next
  }), [])
  const t = full ?? tool
  const calls = t.calls ?? []
  const truncated = !full && (tool.inputLength !== undefined || tool.resultLength !== undefined)
  const load = async (): Promise<TranscriptTool | null> => {
    const whole = await call('transcript:tool', project.path, sessionId, nested ? nested.parent : id)
    return nested ? (whole.calls?.[nested.index] ?? null) : whole
  }
  return (
    <Collapsible
      id={id}
      open={open}
      toggle={toggle}
      anchored={!nested}
      icon={TOOL_ICON[tool.name] ?? (tool.name.includes(' · ') ? 'plug' : 'tools')}
      label={tool.name}
      detail={tool.calls?.length ? callsSummary(tool.calls) : tool.summary}
      badge={tool.exitCode !== undefined && tool.exitCode !== 0 ? <span className="badge error">{exitCodeText(tool.exitCode)}</span> : tool.isError ? <span className="badge error">{tr(msg({ id: 'sessions.tool.errorBadge', defaultMessage: 'error', description: 'A badge on a tool call in a transcript that failed. Lower case; keep it short.' }))}</span> : tool.result === null ? <span className="badge">{tr(msg({ id: 'sessions.tool.noResult', defaultMessage: 'no result', description: 'A badge on a tool call in a transcript that has no result (yet). Lower case; keep it short.' }))}</span> : null}
      className="tx-tool"
    >
      {calls.length > 0 && (
        <div className="tx-calls">
          {calls.map((c, i) => (
            <ToolCall key={i} id={i} tool={c} open={openCalls.has(i)} toggle={toggleCall} project={project} sessionId={sessionId} onImage={onImage} nested={{ parent: nested?.parent ?? id, index: i }} />
          ))}
        </div>
      )}
      <div className="tx-io-label">
        {tr(msg({ id: 'sessions.tool.input', defaultMessage: 'Input', description: "Label above a tool call's input in a transcript." }))} <CopyButton text={t.input} title={tr(msg({ id: 'sessions.tool.copyInput', defaultMessage: 'Copy Input', description: "Tooltip: copies a tool call's input." }))} />
      </div>
      <div className="tx-pre">{t.input}</div>
      {t.result !== null && (
        <>
          <div className="tx-io-label">
            {t.isError ? tr(msg({ id: 'sessions.tool.error', defaultMessage: 'Error', description: "Label above a failed tool call's result in a transcript." })) : tr(msg({ id: 'sessions.tool.result', defaultMessage: 'Result', description: "Label above a tool call's result in a transcript." }))} <CopyButton text={t.result} title={tr(msg({ id: 'sessions.tool.copyResult', defaultMessage: 'Copy Result', description: "Tooltip: copies a tool call's result." }))} />
            {t.exitCode !== undefined && <span className={cx('badge', t.exitCode !== 0 && 'error')}>{exitCodeText(t.exitCode)}</span>}
          </div>
          <div className={cx('tx-pre', 'tx-result', t.isError && 'error')}>{t.result || <span className="faint">{tr(msg({ id: 'sessions.tool.empty', defaultMessage: '(empty)', description: "A tool call's result when it is empty." }))}</span>}</div>
        </>
      )}
      {truncated && (
        <button className="btn small subtle" style={{ marginTop: 6 }} onClick={() => void actions.attempt(tr(msg({ id: 'sessions.tool.loadFailed', defaultMessage: 'Could not load the tool call', description: "An error's title: loading a long tool call in full failed." })), load).then((f) => f && setFull(f))}>
          {tr(msg({ id: 'sessions.tool.showAll', defaultMessage: 'Show all ({n, plural, one {# character} other {# characters}})', description: 'Button under a long tool call cut short in a transcript: shows it all ({n}: its length in characters).' }), { n: (tool.inputLength ?? 0) + (tool.resultLength ?? 0) })}
        </button>
      )}
      {t.images.length > 0 && (
        <div className="tx-images">
          {t.images.map((img) => (
            <TranscriptThumb key={img.id} project={project} sessionId={sessionId} image={img} onOpen={onImage} />
          ))}
        </div>
      )}
    </Collapsible>
  )
}

function OtherItem({ item, open, toggle }: { item: TranscriptItem; open: boolean; toggle: (id: number) => void }) {
  // Hive's own notices are formatted here, in the language shown (#797): a language change shows them in it at once.
  useLanguage()
  if (item.kind === 'compaction') {
    const freed = Math.max(0, item.preTokens - item.postTokens)
    return (
      <div className={cx('tx-compaction', open && 'open')} id={`tx-${item.id}`}>
        <div className="tx-compaction-line" onClick={() => item.summary && toggle(item.id)}>
          <span className="rule" />
          <span className="tx-compaction-label">
            <Icon name="fold" /> {tr(msg({ id: 'sessions.compaction.title', defaultMessage: 'Conversation compacted', description: 'A divider in a transcript: the CLI summarised the conversation here to free context. A badge saying how (auto or manual, as the CLI names it) follows.' }))} <span className={cx('badge', item.trigger === 'auto' ? 'accent' : 'info')}>{item.trigger}</span>
            <span className="faint">
              {tr(msg({ id: 'sessions.compaction.tokens', defaultMessage: '{before} → {after}{next, select, none {} other { ({next} with instructions)}} · freed {freed} · {when}', description: "A compaction divider in a transcript: context tokens before and after (\"120K\"), then the next request's with its instructions (none: leave it empty), how many it freed, and when." }), { before: formatTokens(item.preTokens), after: formatTokens(item.postTokens), next: item.nextRequestTokens !== null ? formatTokens(item.nextRequestTokens) : 'none', freed: formatTokens(freed), when: time(item.timestamp) })}
            </span>
            {item.summary && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}
          </span>
          <span className="rule" />
        </div>
        {open && item.summary && (
          <div className="tx-compaction-summary">
            <div className="tx-actions">
              <CopyButton text={item.summary} title={tr(msg({ id: 'sessions.compaction.copy', defaultMessage: 'Copy Summary', description: "Tooltip: copies a compaction's summary." }))} />
            </div>
            <MemoMarkdown source={item.summary} />
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'command') {
    return (
      <div className="tx-command" id={`tx-${item.id}`}>
        <div className="tx-command-line">
          <Icon name="terminal-cmd" />
          <code>{item.name === '!' ? `! ${item.args}` : `${item.name}${item.args ? ` ${item.args}` : ''}`}</code>
          <span className="faint">{time(item.timestamp)}</span>
        </div>
        {item.output && <div className="tx-pre tx-command-output">{item.output}</div>}
      </div>
    )
  }
  if (item.kind === 'notice') {
    return (
      <div className={cx('tx-notice', item.level === 'error' && 'error')} id={`tx-${item.id}`}>
        <Icon name={item.level === 'error' ? 'warning' : 'info'} /> {item.message ? shownText(item.message) : item.text}
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE = msg({ id: 'sessions.image.untitled', defaultMessage: 'Image', description: "An image in a transcript that has no file name (a thumbnail's tooltip, the image viewer's title)." })

const imageCache = new Map<string, string>()

function useTranscriptImage(project: ProjectInfo, sessionId: string, id: number, enabled = true): string | null {
  const key = `${project.path}|${sessionId}|${id}`
  const [src, setSrc] = useState<string | null>(imageCache.get(key) ?? null)
  useEffect(() => {
    if (!enabled || imageCache.has(key)) {
      setSrc(imageCache.get(key) ?? null)
      return
    }
    let cancelled = false
    void call('transcript:image', project.path, sessionId, id)
      .then((url) => {
        imageCache.set(key, url)
        if (!cancelled) setSrc(url)
      })
      // The transcript says an image was there; without its copy, the placeholder stays.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [key, enabled, project.path, sessionId, id])
  return src
}

function TranscriptThumb({ project, sessionId, image, onOpen }: { project: ProjectInfo; sessionId: string; image: TranscriptImageRef; onOpen: (img: TranscriptImageRef) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const src = useTranscriptImage(project, sessionId, image.id, visible)
  return (
    <div className="thumb" ref={ref} onClick={() => onOpen(image)} title={image.path ?? tr(IMAGE)}>
      {src ? <img src={src} alt="" draggable={false} /> : <Icon name="file-media" />}
    </div>
  )
}

function TranscriptImageViewer({ project, sessionId, image, images, onNavigate, onClose }: { project: ProjectInfo; sessionId: string; image: TranscriptImageRef; images: TranscriptImageRef[]; onNavigate: (img: TranscriptImageRef) => void; onClose: () => void }) {
  const src = useTranscriptImage(project, sessionId, image.id)
  const i = images.findIndex((x) => x.id === image.id)
  const prev = images[i - 1]
  const next = images[i + 1]
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev)
      else if (e.key === 'ArrowRight' && next) onNavigate(next)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onNavigate])
  return (
    <Modal
      title={image.path ? image.path.split(/[\\/]/).pop()! : tr(IMAGE)}
      icon="file-media"
      onClose={onClose}
      wide
      // Sized to the image, with its own controls: it stays put (#133).
      movable={false}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>
            {tr(msg({ id: 'sessions.image.position', defaultMessage: '{n, number} of {total, number}', description: "In a transcript's image viewer: which image this is ({n}) of how many ({total})." }), { n: i + 1, total: images.length })}
          </span>
          {image.path && (
            <>
              <button className="btn subtle" onClick={() => void call('app:showInFolder', image.path!)}>
                <Icon name="folder-opened" /> {tr(msg({ id: 'sessions.image.reveal', defaultMessage: 'Reveal', description: "Button in a transcript's image viewer: shows the image's file in File Explorer. Keep it short." }))}
              </button>
              <button className="btn subtle" onClick={() => copyText(image.path!)}>
                {tr(msg({ id: 'sessions.image.copyPath', defaultMessage: 'Copy Path', description: "Button in a transcript's image viewer: copies the image file's path." }))}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="image-viewer">
        <IconButton icon="chevron-left" title={tr(msg({ id: 'sessions.image.earlier', defaultMessage: 'Earlier (←)', description: "Tooltip in a transcript's image viewer: the previous image (the ← key)." }))} disabled={!prev} onClick={() => prev && onNavigate(prev)} />
        <div className="image-frame">{src ? <img src={src} alt="" /> : <Icon name="loading" spin />}</div>
        <IconButton icon="chevron-right" title={tr(msg({ id: 'sessions.image.later', defaultMessage: 'Later (→)', description: "Tooltip in a transcript's image viewer: the next image (the → key)." }))} disabled={!next} onClick={() => next && onNavigate(next)} />
      </div>
    </Modal>
  )
}

/** "Worked on #5 Prompt snippets, #7 …": the board cards the session's agent had in Doing. A deleted card keeps its
 *  number and the title it had, without a link. */
/** The cards a session worked on, and those it reviewed (each a line, when it has any). */
function WorkedOn({ cards }: { cards: SessionListItem['cards'] }) {
  if (!cards?.length) return null
  return (
    <>
      <CardsLine icon="project" label={tr(msg({ id: 'sessions.cards.workedOn', defaultMessage: 'Worked on', description: "Over a transcript, before the board cards the session's agent worked on (#5 Title, …)." }))} cards={cards.filter((c) => !c.review)} />
      <CardsLine icon="eye" label={tr(msg({ id: 'sessions.cards.reviewed', defaultMessage: 'Reviewed', description: "Over a transcript, before the board cards the session's agent reviewed (#5 Title, …)." }))} cards={cards.filter((c) => c.review)} />
    </>
  )
}

function CardsLine({ icon, label, cards }: { icon: string; label: string; cards: NonNullable<SessionListItem['cards']> }) {
  const tasks = useStore((s) => s.tasks)
  if (!cards.length) return null
  return (
    <div className="worked-on faint">
      <Icon name={icon} /> {label}{' '}
      {cards.map((c, i) => {
        const card = tasks.find((t) => t.number === c.number)
        const text = `${card ? cardLabel(card) : `#${c.number}`} ${card?.title ?? c.title}`
        return (
          <span key={c.number}>
            {i > 0 && ', '}
            {card ? (
              <a className="link" data-task={c.number} onClick={() => set({ taskOpen: c.number })}>
                {text}
              </a>
            ) : (
              <Tooltip content={tr(msg({ id: 'sessions.cards.deleted', defaultMessage: 'This card was deleted.', description: 'Hover of a card over a transcript that is no longer on the board.' }))}>
                <span>{text}</span>
              </Tooltip>
            )}
          </span>
        )
      })}
    </div>
  )
}
