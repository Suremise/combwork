import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ACTIVITY_HOURS, activityTabs, buildActivityView, keepGoneList, type ActivityAgent, type ActivityCard, type ActivityInput, type ActivityNode, type ActivityNow, type ActivityTabInfo, type ActivityTurns } from '@shared/activity'
import { agentState } from '@shared/agentState'
import { cardLabel } from '@shared/projectKeys'
import type { ProjectInfo, SessionListItem, TaskCard } from '@shared/types'
import { boundedQueue } from '@shared/coalesce'
import { msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, activityAgentKey, cardActivityAgents, openActivity, set, useStore, workspaceActivityKey } from '../store'
import { Icon, IconButton, InfoTip, statusText, Tooltip, useContextMenu, type MenuEntry } from '../components/ui'
import { StateMark } from '../components/StateMark'
import { loadActivityView, saveActivityView, type ActivityView } from '../activityView'
import { cx } from '../util'
import { ACTIVITY_M, Details, FADE_MS, LIST_EVERY, markOf, NO_NOW, PartView, TICK_MS, TURNS_AT_ONCE, usePageVisible } from './ActivityTab'

/** Session lists read at once (each a host's records, HI-1664: only the hosts shown, every few ticks). */
const LISTS_AT_ONCE = 2

/**
 * What the workspace level read and drew (HI-1664), counted: the measurement of its cost (nothing while hidden, one call a
 * tick for what runs now) reads them from a test copy's window.
 */
const counts = { now: 0, lists: 0, turns: 0, cardAgents: 0, renders: 0, active: false }
;(window as unknown as { __cwWorkspaceActivity?: typeof counts }).__cwWorkspaceActivity = counts

/**
 * A store value taken in only while the view is active: hidden (the window minimised), the store's changes (agents'
 * live state, the board) draw nothing, and it is read again as the view shows.
 */
function useWhileActive<T>(active: boolean, select: (s: ReturnType<typeof useStore.getState>) => T): T {
  const kept = useRef<{ v: T } | null>(null)
  const v = useStore((s) => (active || !kept.current ? select(s) : kept.current.v))
  kept.current = { v }
  return v
}

/** A host's key in the reads: its path, lower-cased. */
const hk = (path: string): string => path.toLowerCase()
/** A session's key in the reads: its host's and its id (two hosts' sessions are never one, HR5's HI-1664 design check). */
const sk = (path: string, sessionId: string): string => `${hk(path)}\n${sessionId}`

/** What the workspace level is drawn from: held as it was while it is frozen (HI-1743), by host (hk) and by session (sk). */
interface Reads {
  agents: ReadonlyMap<string, ActivityAgent[]>
  cards: ReadonlyMap<string, ActivityCard[]>
  lists: ReadonlyMap<string, SessionListItem[]>
  turns: ReadonlyMap<string, ActivityTurns>
  now: ReadonlyMap<string, ActivityNow>
}

/** A host's agents as the Activity tab takes them (shared/activity.ts). */
const activityAgents = (h: ProjectInfo): ActivityAgent[] =>
  h.agents.map((a) => {
    const l = a.live
    if (!l) return { id: a.id, name: a.name, live: null }
    const state = agentState(l)
    return { id: a.id, name: a.name, live: { sessionId: l.sessionId, sessionName: l.sessionName, startedAt: l.startedAt, status: l.status, text: statusText(l), working: state === 'working', waiting: state === 'waiting', failed: state === 'stalled' } }
  })

/** A card as the Activity tab takes it. */
const activityCard = (c: TaskCard): ActivityCard => ({ number: c.number, label: cardLabel(c), title: c.title, column: c.column, builder: c.agent, reviewer: c.review?.agent ?? null })

/** Whether a host has an agent running. */
const runs = (h: ProjectInfo): boolean => h.agents.some((a) => !!a.live)

/**
 * Activity's workspace level (HI-1664): the same "what's running now" as a project's Activity tab (HI-1743), across every
 * session host of the workspace with an agent running (its projects, and the Assistant), its agents' tabs grouped by
 * project. Opened from a card (its agents now), from the Progress panel (a lane's or a run's agents), or the activity bar.
 * Frozen as it opens, nothing past; nothing read or drawn while hidden. A tick reads what runs now in every host shown in
 * one call (never one per host or agent), their session lists every few ticks, and turns only for the tab shown.
 */
export const WorkspaceActivityView = memo(function WorkspaceActivityView({ workspacePath }: { workspacePath: string }) {
  counts.renders++
  const shown = useStore((s) => s.activity === 'activity')
  const visible = usePageVisible()
  const active = shown && visible
  counts.active = active
  const projects = useWhileActive(active, (s) => s.workspace?.projects ?? NO_PROJECTS)
  const assistant = useWhileActive(active, (s) => s.workspace?.assistant ?? null)
  const hosts = useMemo(() => [...projects, ...(assistant ? [assistant] : [])], [projects, assistant])
  // The view (filters, tab, own processes, its card): the workspace's own, never a project's (HR5's design check).
  const vk = workspaceActivityKey(workspacePath)
  const stored = useStore((s) => s.activityFilters[vk])
  const [loaded] = useState(() => stored ?? loadActivityView(vk))
  const view = stored ?? loaded
  const setView = useCallback(
    (patch: Partial<ActivityView>): void =>
      set((s) => {
        const next = { ...(s.activityFilters[vk] ?? loaded), ...patch }
        saveActivityView(vk, next)
        return { activityFilters: { ...s.activityFilters, [vk]: next } }
      }),
    [vk, loaded]
  )
  const tasks = useWhileActive(active, (s) => s.tasks)
  const [lists, setLists] = useState<ReadonlyMap<string, SessionListItem[]>>(new Map())
  const [listError, setListError] = useState<string | null>(null)
  const [now, setNow] = useState<ReadonlyMap<string, ActivityNow>>(new Map())
  const [nowRead, setNowRead] = useState(false)
  const [turns, setTurns] = useState<ReadonlyMap<string, ActivityTurns>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  // Drawn again when an agent's live state changed (its status, its line); `members` only when an agent started, stopped
  // or began another session: what the session lists and a card's agents depend on (HR5's HI-1664 round 1).
  const [tick, setTick] = useState(0)
  const [members, setMembers] = useState(0)
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts

  // The hosts the view is about: those with an agent running, and with an agents filter, those it names an agent of.
  // Opened for a card, its agents alone: none when nobody works on it (never every agent).
  const keyed = useMemo(() => new Set(view.agents ?? []), [view.agents])
  const byCard = !!view.forCard
  const inFilter = useCallback((h: ProjectInfo): string[] | undefined => (keyed.size || byCard ? h.agents.filter((a) => keyed.has(activityAgentKey(h.path, a.id))).map((a) => a.id) : undefined), [keyed, byCard])
  const shownHosts = useMemo(
    () => hostsRef.current.filter((h) => runs(h) && (inFilter(h)?.length ?? 1) > 0),
    // Taken in at a tick that saw an agent start or stop, and when the hosts or the filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, hosts.length, inFilter]
  )
  const shownRef = useRef(shownHosts)
  shownRef.current = shownHosts

  const shownSessionsRef = useRef<{ path: string; id: string; live: boolean }[]>([])
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  // What runs now, one call at a time (a tick never overlaps the last); lists and turns a few at a time. All for while
  // the view is shown: hidden, gone or another workspace, what waits is dropped and what still runs applies nothing.
  const nowReads = useRef(boundedQueue(1))
  const listReads = useRef(boundedQueue(LISTS_AT_ONCE))
  const turnReads = useRef(boundedQueue(TURNS_AT_ONCE))
  const readTurns = useCallback((wanted: { path: string; id: string }[]): void => {
    for (const { path, id } of wanted) {
      const key = sk(path, id)
      turnReads.current.add(
        key,
        () => (counts.turns++, call('activity:turns', path, id, turnsRef.current.get(key)?.version).catch(() => null)),
        (t) => t && setTurns((m) => new Map(m).set(key, t))
      )
    }
  }, [])
  const readLists = useCallback((): void => {
    for (const h of shownRef.current) {
      const path = h.path
      listReads.current.add(
        hk(path),
        () => (counts.lists++, call('activity:sessions', path, ACTIVITY_HOURS).then((l) => ({ l }), (e: unknown) => ({ e }))),
        (r) => {
          if ('l' in r) {
            setLists((m) => new Map(m).set(hk(path), r.l))
            setListError(null)
          } else setListError(errorMessage(r.e))
        }
      )
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let stop = false
    const nowQueue = nowReads.current
    const listQueue = listReads.current
    const turnQueue = turnReads.current
    let lastNow = ''
    let lastLive = ''
    let lastMembers = ''
    let ticks = 0
    readLists()
    const read = (): void => {
      const paths = shownRef.current.map((h) => h.path)
      if (!paths.length) setNowRead(true)
      else
        nowQueue.add(
          'now',
          () => (counts.now++, call('activity:nowAll', paths).catch(() => null)),
          (rows) => {
            setNowRead(true)
            if (stop || !rows) return
            const key = JSON.stringify(rows)
            if (key === lastNow) return
            lastNow = key
            setNow(new Map(rows.map((r) => [hk(r.path), r.now])))
          }
        )
      const liveNow = hostsRef.current.map((h) => `${hk(h.path)}=${h.agents.map((a) => (a.live ? `${a.id}:${a.live.sessionId}:${a.live.status}:${statusText(a.live)}` : a.id)).join(',')}`).join('|')
      if (liveNow !== lastLive) {
        lastLive = liveNow
        setTick((t) => t + 1)
      }
      const membersNow = hostsRef.current.map((h) => `${hk(h.path)}=${h.agents.map((a) => (a.live ? `${a.id}:${a.live.sessionId}` : '')).join(',')}`).join('|')
      const joined = membersNow !== lastMembers
      if (joined) {
        lastMembers = membersNow
        setMembers((m) => m + 1)
      }
      if ((joined && ticks > 0) || ++ticks % LIST_EVERY === 0) readLists()
      readTurns(shownSessionsRef.current.filter((x) => x.live))
    }
    read()
    const t = setInterval(read, TICK_MS)
    return () => {
      stop = true
      clearInterval(t)
      nowQueue.cancel()
      listQueue.cancel()
      turnQueue.cancel()
    }
  }, [active, readTurns, readLists])

  // Opened for a card: its agents found again as agents start and stop (never polled), while shown.
  const forCard = view.forCard
  const cardRef = useRef<TaskCard | null>(null)
  cardRef.current = forCard ? (tasks.find((c) => c.number === forCard) ?? null) : null
  const lastFound = useRef('')
  useEffect(() => {
    if (!active || !forCard) return
    let stop = false
    const c = cardRef.current
    if (c) counts.cardAgents++
    void (c ? cardActivityAgents(c) : Promise.resolve([])).then((agents) => {
      if (stop) return
      const key = agents.join('|')
      if (key === lastFound.current) return
      lastFound.current = key
      if (key !== (view.agents ?? []).join('|')) setView({ agents: agents })
    })
    return () => {
      stop = true
    }
    // At each start or stop (members), the opening, or another card: never for a status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, forCard, members])

  const agents = useMemo<ReadonlyMap<string, ActivityAgent[]>>(
    () => new Map(hostsRef.current.map((h) => [hk(h.path), activityAgents(h)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, hosts.length]
  )
  const cards = useMemo<ReadonlyMap<string, ActivityCard[]>>(() => {
    // Each project's cards, and the workspace's own (no project) beside every host's: an agent may work on one.
    const own = tasks.filter((c) => !c.archived && !c.project).map(activityCard)
    return new Map(hosts.map((h) => [hk(h.path), [...tasks.filter((c) => !c.archived && c.project && c.project.toLowerCase() === h.name.toLowerCase()).map(activityCard), ...own]]))
  }, [tasks, hosts])
  const reads = useMemo<Reads>(() => ({ agents, cards, lists, turns, now }), [agents, cards, lists, turns, now])

  // --- Frozen or live, as the project's tab (HI-1743).
  const [held, setHeld] = useState<Reads | null>(null)
  const [pending, setPending] = useState(0)
  const [fresh, setFresh] = useState(0)
  const ready = shownHosts.every((h) => lists.has(hk(h.path))) && nowRead
  const opening = `${view.opened ?? 0}`
  const lastOpening = useRef<string | null>(null)
  useEffect(() => {
    if (!active) {
      lastOpening.current = null
      return
    }
    if (lastOpening.current === opening) return
    lastOpening.current = opening
    setLive(false)
    setHeld(null)
    setPending(0)
    setNowRead(false)
    setFresh((n) => n + 1)
  }, [active, opening])
  useEffect(() => {
    if (!live && !held && ready) setHeld(reads)
    if (live && held) {
      setHeld(null)
      setPending(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ready, held])
  const refresh = useCallback((): void => {
    setHeld((h) => (h ? reads : null))
    setPending(0)
    setFresh((n) => n + 1)
  }, [reads])
  const filterKey = JSON.stringify([view.agents ?? [], view.cards ?? [], view.hideFinished !== false, view.tab ?? '', !!view.showOwn])
  const lastFilter = useRef(filterKey)
  useEffect(() => {
    if (lastFilter.current === filterKey) return
    lastFilter.current = filterKey
    setFresh((n) => n + 1)
  }, [filterKey])
  const lastReads = useRef(reads)
  useEffect(() => {
    const was = lastReads.current
    lastReads.current = reads
    if (!held || was === reads) return
    const onlyFirst = was.agents === reads.agents && was.cards === reads.cards && was.now === reads.now && [...reads.lists].every(([k, l]) => was.lists.get(k) === l || !held.lists.has(k)) && [...reads.turns].every(([k, t]) => was.turns.get(k) === t || !held.turns.has(k))
    if (!onlyFirst) setPending((n) => n + 1)
  }, [reads, held])
  const drawn = useMemo<Reads>(() => {
    if (!held) return reads
    // What the snapshot hadn't read yet completes it (a host's first list, a session's first turns).
    const newLists = [...reads.lists].filter(([k]) => !held.lists.has(k))
    const newTurns = [...reads.turns].filter(([k]) => !held.turns.has(k))
    return newLists.length || newTurns.length ? { ...held, lists: new Map([...held.lists, ...newLists]), turns: new Map([...held.turns, ...newTurns]) } : held
  }, [held, reads])

  // --- The tabs, by host, and the one shown.
  // The time the drawn reads are of: taken again with them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const at = useMemo(() => Date.now(), [drawn])
  const inputs = useMemo(() => {
    const byHost = new Map<string, Map<string, ActivityTurns>>()
    for (const [k, t] of drawn.turns) {
      const i = k.indexOf('\n')
      const host = k.slice(0, i)
      const m = byHost.get(host) ?? new Map<string, ActivityTurns>()
      m.set(k.slice(i + 1), t)
      byHost.set(host, m)
    }
    return new Map(
      shownHosts.map((h): [string, ActivityInput] => {
        const k = hk(h.path)
        return [k, { agents: drawn.agents.get(k) ?? [], cards: drawn.cards.get(k) ?? [], sessions: drawn.lists.get(k) ?? [], turns: byHost.get(k) ?? new Map(), now: drawn.now.get(k) ?? NO_NOW, at }]
      })
    )
  }, [drawn, shownHosts, at])
  const groups = useMemo(
    () =>
      shownHosts.flatMap((h) => {
        const input = inputs.get(hk(h.path))!
        const keep = h.agents.find((a) => activityAgentKey(h.path, a.id) === view.tab)?.id
        const tabs = activityTabs(input, { agents: inFilter(h), cards: view.cards, hideFinished: view.hideFinished }, keep)
        return tabs.length ? [{ host: h, input, tabs }] : []
      }),
    [shownHosts, inputs, inFilter, view.tab, view.cards, view.hideFinished]
  )
  const all = groups.flatMap((g) => g.tabs.map((t) => ({ host: g.host, input: g.input, tab: t, key: activityAgentKey(g.host.path, t.agentId) })))
  const current = all.find((x) => x.key === view.tab) ?? all[0] ?? null
  const content = useMemo(() => (current ? buildActivityView(current.input, current.tab.agentId, { showOwn: !!view.showOwn }) : { card: null, parts: [] }), [current, view.showOwn])

  // Live, what ended fades out where it was, then leaves; frozen, nothing changes.
  const goneAt = useRef(new Map<string, number>())
  const keptRef = useRef<{ fresh: number; lists: Map<string, ActivityNode[]> }>({ fresh: -1, lists: new Map() })
  const [prune, setPrune] = useState(0)
  const parts = useMemo(() => {
    if (keptRef.current.fresh !== fresh) {
      keptRef.current = { fresh, lists: new Map() }
      goneAt.current.clear()
    }
    const t0 = Date.now()
    const still = new Set<string>()
    const host = current ? hk(current.host.path) : ''
    const keep = (key: string, next: ActivityNode[]): ActivityNode[] => {
      const out = keepGoneList(keptRef.current.lists.get(key) ?? [], next).filter((n) => {
        if (!n.gone) return true
        const since = goneAt.current.get(`${host}\n${n.key}`) ?? t0
        goneAt.current.set(`${host}\n${n.key}`, since)
        if (t0 - since >= FADE_MS) return false
        still.add(`${host}\n${n.key}`)
        return true
      })
      keptRef.current.lists.set(key, out)
      return out
    }
    const out = content.parts.map((p) => ({ ...p, subagents: keep(`${host}\n${p.agentId}:subagents`, p.subagents), processes: keep(`${host}\n${p.agentId}:processes`, p.processes) }))
    for (const k of [...goneAt.current.keys()]) if (!still.has(k)) goneAt.current.delete(k)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, fresh, prune])
  const fading = parts.some((p) => [...p.subagents, ...p.processes].some((n) => n.gone))
  useEffect(() => {
    if (!fading) return
    const t = setTimeout(() => setPrune((n) => n + 1), FADE_MS)
    return () => clearTimeout(t)
  }, [fading, parts])

  // Turns only for the tab shown (its agent's session and running subagents).
  const shownSessions = useMemo(() => {
    const path = current?.host.path
    if (!path) return []
    return parts.flatMap((p) => [...(p.session ? [{ path, id: p.session.session.id, live: true }] : []), ...p.subagents.flatMap((n) => (n.kind === 'session' && !n.gone ? [{ path, id: n.session.id, live: n.live }] : []))])
  }, [parts, current?.host.path])
  shownSessionsRef.current = shownSessions
  const unread = shownSessions.filter((x) => !turns.has(sk(x.path, x.id)))
  const unreadKey = unread.map((x) => sk(x.path, x.id)).join(',')
  useEffect(() => {
    if (active && unread.length) readTurns(unread)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, unreadKey, readTurns])

  const byKey = useMemo(() => {
    const m = new Map<string, ActivityNode>()
    for (const p of parts) for (const n of [p.session, p.turn, p.doing?.kind === 'tool' ? p.doing.tool : null, ...p.subagents, ...p.processes]) if (n) m.set(n.key, n)
    return m
  }, [parts])
  const chosen = selected ? (byKey.get(selected) ?? null) : null

  // The Agents ▾ and Cards ▾ menus: the workspace's agents (by project) and its cards in progress.
  const menu = useContextMenu()
  const openPick = (e: React.MouseEvent<HTMLElement>, what: 'agents' | 'cards'): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const show = (picked: readonly (string | number)[]): void => {
      const choices: [string | number, string][] =
        what === 'agents'
          ? hostsRef.current.filter(runs).flatMap((h) => h.agents.map((a): [string, string] => [activityAgentKey(h.path, a.id), tr(M.agentIn, { agent: a.name, project: h.name })]))
          : tasks.filter((c) => !c.archived && (c.column === 'doing' || c.column === 'review')).map((c) => [c.number, `${cardLabel(c)} ${c.title}`])
      const items: MenuEntry[] = [
        { label: tr(ACTIVITY_M.all), icon: picked.length ? undefined : 'check', onClick: () => pick([]) },
        { separator: true },
        ...choices.map(([id, label]): MenuEntry => ({ label, icon: picked.includes(id) ? 'check' : undefined, onClick: () => pick(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) }))
      ]
      menu.openAt(r.left, r.bottom + 2, items)
    }
    const pick = (next: readonly (string | number)[]): void => {
      // Picking agents by hand ends the card's filter.
      setView(what === 'agents' ? { agents: next as string[], forCard: undefined } : { cards: next as number[] })
      show(next)
    }
    show(what === 'agents' ? (view.agents ?? []) : (view.cards ?? []))
  }

  const reading = shownHosts.some((h) => !lists.has(hk(h.path))) && !listError
  const card = content.card
  const solo = parts[0]?.session?.session
  const forCardLabel = forCard ? (cardRef.current ? cardLabel(cardRef.current) : `#${forCard}`) : null
  const filtered = !!view.agents?.length || !!view.cards?.length
  return (
    <div className="activity-tab activity-workspace">
      <div className="activity-main">
        <div className="activity-head">
          <span className="pane-header-title">{tr(M.heading)}</span>
          {forCardLabel ? (
            <span className="chip activity-for-card">
              {tr(M.forCard, { card: forCardLabel })}
              <IconButton icon="close" title={tr(M.clearCard)} onClick={() => setView({ agents: [], forCard: undefined })} />
            </span>
          ) : (
            <button className={cx('btn small subtle activity-pick', !!view.agents?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'agents')}>
              {tr(ACTIVITY_M.agents, { n: view.agents?.length ?? 0 })} <Icon name="chevron-down" />
            </button>
          )}
          <button className={cx('btn small subtle activity-pick', !!view.cards?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'cards')}>
            {tr(ACTIVITY_M.cards, { n: view.cards?.length ?? 0 })} <Icon name="chevron-down" />
          </button>
          <label className="flex muted activity-hide">
            <input type="checkbox" className="checkbox" checked={view.hideFinished !== false} onChange={(e) => setView({ hideFinished: e.target.checked })} /> {tr(ACTIVITY_M.hideFinished)}
          </label>
          {reading && <span className="faint">{tr(ACTIVITY_M.reading)}</span>}
          {listError && <span className="error-text">{tr(ACTIVITY_M.loadFailed, { error: listError })}</span>}
          <div className="actions">
            {!live && pending > 0 && (
              <button className="chip activity-pill" onClick={refresh} title={tr(ACTIVITY_M.pillTip)}>
                <Icon name="refresh" /> {tr(ACTIVITY_M.pill, { n: pending })}
              </button>
            )}
            <button className={cx('btn small subtle activity-live', live && 'on') /* i18n-ignore: class names */} aria-pressed={live} title={tr(live ? ACTIVITY_M.pauseTip : ACTIVITY_M.liveTip)} onClick={() => setLive((v) => !v)}>
              <Icon name={live ? 'debug-pause' : 'play'} /> {tr(live ? ACTIVITY_M.pause : ACTIVITY_M.live)}
            </button>
            <IconButton icon="refresh" title={tr(ACTIVITY_M.refresh)} onClick={refresh} />
          </div>
        </div>
        {groups.length > 0 && (
          <div className="activity-tabs activity-tab-groups" role="tablist" aria-label={tr(ACTIVITY_M.tabsLabel)}>
            {groups.map((g) => (
              <div key={g.host.path} className="activity-tab-group" role="presentation" data-host={g.host.name}>
                <span className="activity-tab-group-name faint">{g.host === assistant ? tr(M.assistant) : g.host.name}</span>
                {g.tabs.map((t: ActivityTabInfo) => {
                  const key = activityAgentKey(g.host.path, t.agentId)
                  const on = key === current?.key
                  return (
                    <button
                      key={key}
                      role="tab"
                      className={cx('activity-agent-tab', on && 'active')}
                      aria-selected={on}
                      data-agent={t.agentId}
                      data-host={g.host.name}
                      title={t.card ? `${t.name} · ${t.card.label} ${t.card.title}` : t.name}
                      onClick={() => {
                        setSelected(null)
                        setView({ tab: key })
                      }}
                    >
                      <StateMark state={markOf(t.state)} />
                      <span className="activity-agent-tab-name">{t.name}</span>
                      {t.card && <span className="faint activity-agent-tab-card">{t.card.label}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
        {!parts.length || !current ? (
          <div className="pane-empty">{reading ? null : forCardLabel ? tr(M.cardNobody, { card: forCardLabel }) : tr(filtered ? ACTIVITY_M.emptyFiltered : M.empty)}</div>
        ) : (
          <div className="activity-list" role="tabpanel">
            {card ? (
              <div className="activity-card-head">
                <button className="link activity-card-key" title={tr(ACTIVITY_M.openCard)} onClick={() => set({ taskOpen: card.number })}>
                  {card.label}
                </button>
                <span className="activity-card-title" title={card.title}>
                  {card.title}
                </span>
                <span className="faint activity-card-column">· {tr(ACTIVITY_M.column, { column: card.column })}</span>
              </div>
            ) : solo ? (
              <div className="activity-card-head">
                <span className="activity-card-title" title={solo.title || solo.name || solo.id.slice(0, 8)}>
                  {solo.title || solo.name || solo.id.slice(0, 8)}
                </span>
              </div>
            ) : null}
            {parts.map((p) => (
              <PartView key={p.agentId} project={current.host} part={p} many={parts.length > 1} selected={selected} onSelect={setSelected} showOwn={!!view.showOwn} onShowOwn={(v) => setView({ showOwn: v })} />
            ))}
          </div>
        )}
      </div>
      {chosen && current && <Details project={current.host} node={chosen} onClose={() => setSelected(null)} />}
      {menu.element}
    </div>
  )
})

/** Activity's sidebar (HI-1664): the whole workspace, and each project's own Activity tab. */
export function WorkspaceActivityPanel() {
  const workspace = useStore((s) => !!s.workspace)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const row = (key: string, icon: string, label: string, tip: string, selected: boolean, onClick: () => void, count?: number) => (
    <Tooltip key={key} block content={tip}>
      <div className={cx('row', selected && 'selected')} role="button" tabIndex={0} aria-pressed={selected} onClick={onClick} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
        <Icon name={icon} /> <span className="label">{label}</span>
        {!!count && <span className="badge">{count}</span>}
      </div>
    </Tooltip>
  )
  return (
    <>
      <div className="pane-header">
        {tr(M.heading)}
        <InfoTip text={tr(M.panelTip)} />
      </div>
      <div className="pane-body">
        {!workspace && <div className="pane-empty">{tr(M.noWorkspace)}</div>}
        {workspace && (
          <>
            {row('', 'root-folder', tr(M.whole), tr(M.wholeTip), true, () => undefined)}
            <div className="section-header">{tr(M.projects)}</div>
            {projects.map((p) => row(p.path, 'folder', p.name, tr(M.projectTip, { project: p.name }), false, () => openActivity(p.path, null), p.agents.filter((a) => !!a.live).length))}
          </>
        )}
      </div>
    </>
  )
}

/** "Show in Activity" (HI-1664): a Progress panel run's or lane's agents on Activity's workspace level. */
export const SHOW_IN_ACTIVITY = msg({ id: 'activity.workspace.showIn', defaultMessage: 'Show in Activity', description: "A button in a Progress panel run's details, and an entry of a lane's menu: opens Activity's workspace level on that run's agent (or the lane's builder and reviewer), what it runs now." })

const M = {
  heading: msg({ id: 'activity.workspace.heading', defaultMessage: 'Activity', description: "Activity's workspace level (the activity bar's Activity view): what every project's agents run now, their tabs grouped by project." }),
  panelTip: msg({ id: 'activity.workspace.panelTip', defaultMessage: "What the workspace's agents run now. The whole workspace shows every project's running agents together; a project opens its own Activity tab.", description: "The info tip beside the Activity view's sidebar heading." }),
  noWorkspace: msg({ id: 'activity.workspace.noWorkspace', defaultMessage: 'Open a workspace to see what its agents run.', description: "The Activity view's sidebar with no workspace open." }),
  whole: msg({ id: 'activity.workspace.whole', defaultMessage: 'Whole workspace', description: "A row of the Activity view's sidebar: every project's running agents together (as Performance's Whole workspace)." }),
  wholeTip: msg({ id: 'activity.workspace.wholeTip', defaultMessage: "Every project's running agents, grouped by project, and the Assistant when it runs.", description: "Tooltip of the Activity view's Whole workspace row." }),
  projects: msg({ id: 'activity.workspace.projects', defaultMessage: 'Projects', description: "A section heading in the Activity view's sidebar, over a row per project." }),
  projectTip: msg({ id: 'activity.workspace.projectTip', defaultMessage: "Open {project}'s Activity tab.", description: "Tooltip of a project's row in the Activity view's sidebar: opens that project's own Activity tab. {project} is its name." }),
  assistant: msg({ id: 'activity.workspace.assistant', defaultMessage: 'Assistant', description: "The Assistant's group heading among the Activity view's agent tabs (its tabs grouped by project; the Combwork Assistant is its own group)." }),
  agentIn: msg({ id: 'activity.workspace.agentIn', defaultMessage: '{project} · {agent}', description: "An entry of the Activity view's Agents menu: an agent ({agent}) and its project ({project})." }),
  empty: msg({ id: 'activity.workspace.empty', defaultMessage: 'Nothing is running in this workspace. Start an agent to see what it runs here.', description: "Activity's workspace level when no agent of any project runs anything." }),
  forCard: msg({ id: 'activity.workspace.forCard', defaultMessage: 'Card {card}', description: "A chip above Activity's workspace level when it was opened from a card, naming the filter (not saying anyone works on it): only the agents working on that card ({card}: its key, such as HI-12) now have tabs." }),
  clearCard: msg({ id: 'activity.workspace.clearCard', defaultMessage: 'Show every agent', description: "Tooltip of the button on Activity's \"Working on HI-12\" chip: drops the card's filter." }),
  cardNobody: msg({ id: 'activity.workspace.cardNobody', defaultMessage: 'Nobody is working on {card} now. The card has its history.', description: "Activity's workspace level opened from a card ({card}: its key) when no running agent works on it now: past work is read on the card itself." })
}
