// HI-2320: one notification system. Every message is one entry, routed once by one table (shared/notify.ts), owned by
// one window (main/notify.ts tell()), its buttons resolved by their own offer only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kindOfLevel, keepPopups, MAX_POPUPS, notifyRoute, popupMs, popupRole, staysUntilHandled, toldWhenAway, type NotifyKind } from '../src/shared/notify'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { HiveEvent } from '../src/shared/types'

const KINDS: NotifyKind[] = ['needsYou', 'finished', 'work', 'usage', 'warning', 'result', 'transcript', 'update', 'quit', 'tip']
const on = { ...DEFAULT_SETTINGS.notifications }
const wsA = 'C:\\Work\\A'
const from = { workspacePath: wsA, projectPath: `${wsA}\\alpha` }
const nowhere = { workspacePath: null, projectPath: null }
const lookingAt = (workspacePath: string, projectPath: string | null) => ({ workspacePath, projectPath })
const route = (n: Partial<typeof on>, kind: NotifyKind, focused: ReturnType<typeof lookingAt> | null, f: { workspacePath: string | null; projectPath: string | null } = from) => notifyRoute({ ...on, ...n }, kind, focused, f).route

describe('the routing table (notifyRoute): each kind, one place', () => {
  it('a Hive window focused: every kind pops up in it, but Hive has closed (its windows are closing)', () => {
    for (const kind of KINDS) expect(route({}, kind, lookingAt(wsA, null)), kind).toBe(kind === 'quit' ? 'none' : 'popup')
  })

  it('no Hive window focused: agents, lanes, plan usage and Hive closing go to Windows notifications; Hive\'s own messages wait in their window', () => {
    for (const kind of KINDS) expect(route({}, kind, null), kind).toBe(toldWhenAway(kind) ? 'windows' : 'popup')
    expect(KINDS.filter(toldWhenAway)).toEqual(['needsYou', 'finished', 'work', 'usage', 'quit'])
  })

  it('the master switch off: nothing for the agent kinds, plan usage and Hive closing, focused or not; Hive\'s own messages still pop up', () => {
    for (const focused of [null, lookingAt(wsA, null)]) {
      for (const kind of KINDS) expect(route({ desktopNotifications: false }, kind, focused), kind).toBe(toldWhenAway(kind) ? 'none' : kind === 'quit' ? 'none' : 'popup')
    }
  })

  it('a kind off: nowhere, focused or not, whatever the others', () => {
    for (const focused of [null, lookingAt(wsA, null)]) {
      expect(route({ notifyOnFinished: false }, 'finished', focused)).toBe('none')
      expect(route({ notifyOnFinished: false }, 'needsYou', focused)).not.toBe('none')
      expect(route({ notifyOnWaiting: false }, 'needsYou', focused)).toBe('none')
      expect(route({ notifyOnWaiting: false }, 'work', focused)).not.toBe('none')
    }
  })

  it('the scope (Show pop-ups about agents for): one left out goes to the bell only, never nowhere', () => {
    const other = lookingAt('C:\\Work\\B', 'C:\\Work\\B\\beta')
    const sameWsOtherProject = lookingAt('c:\\work\\a', 'c:\\work\\a\\gamma')
    const sameProject = lookingAt('c:\\work\\a', 'c:\\work\\a\\ALPHA')
    expect(route({ bannerScope: 'all' }, 'finished', other)).toBe('popup')
    expect(route({ bannerScope: 'workspace' }, 'finished', other)).toBe('bell')
    expect(route({ bannerScope: 'workspace' }, 'finished', sameWsOtherProject)).toBe('popup')
    expect(route({ bannerScope: 'project' }, 'work', sameWsOtherProject)).toBe('bell')
    expect(route({ bannerScope: 'project' }, 'needsYou', sameProject)).toBe('popup')
    for (const kind of ['needsYou', 'finished', 'work'] as const) expect(route({ bannerScope: 'none' }, kind, sameProject), kind).toBe('bell')
    // The scope is about agents: Hive's own messages, and one about no project, pop up whatever it says.
    for (const bannerScope of ['workspace', 'project', 'none'] as const) {
      expect(route({ bannerScope }, 'warning', other), bannerScope).toBe('popup')
      expect(route({ bannerScope }, 'usage', other, nowhere), bannerScope).toBe('popup')
      expect(route({ bannerScope }, 'work', other, nowhere), bannerScope).toBe('popup')
    }
  })

  it('the scope only applies while a window is focused: Only in the bell (the old Show nothing) keeps the Windows notifications in the background', () => {
    for (const bannerScope of ['workspace', 'project', 'none'] as const) {
      for (const kind of ['needsYou', 'finished', 'work'] as const) expect(route({ bannerScope }, kind, null), `${bannerScope} ${kind}`).toBe('windows')
    }
  })

  it('says why, for the log', () => {
    const s = { ...on, bannerScope: 'workspace' as const }
    expect(notifyRoute(s, 'finished', null, from)).toEqual({ route: 'windows', why: 'no Hive window focused' })
    expect(notifyRoute(s, 'finished', lookingAt('C:\\Work\\B', null), from)).toEqual({ route: 'bell', why: "pop-up scope: another workspace's" })
    expect(notifyRoute(s, 'finished', lookingAt('c:\\work\\a', null), from)).toEqual({ route: 'popup', why: 'pop-up scope: workspace' })
    expect(notifyRoute(s, 'warning', null, nowhere)).toEqual({ route: 'popup', why: 'no Hive window focused: waits in its window' })
  })

  it("a message by its level: warning and error are Hive's warnings, info and success its results", () => {
    expect(['info', 'success', 'warning', 'error'].map((l) => kindOfLevel(l as never))).toEqual(['result', 'result', 'warning', 'warning'])
  })
})

describe('one pop-up system: stacking, timing, roles', () => {
  type P = { id: string; kind: NotifyKind; level: 'info' | 'error' }
  const p = (id: string, kind: NotifyKind): P => ({ id, kind, level: 'info' })
  const add = (list: P[], x: P, waitingStays = true) => keepPopups([x, ...list], (t) => staysUntilHandled(t, waitingStays))

  it('more than four that need you: every one is kept, none pushed out', () => {
    let list: P[] = []
    for (let i = 1; i <= 6; i++) list = add(list, p(`w${i}`, 'needsYou'))
    expect(list.map((x) => x.id)).toEqual(['w6', 'w5', 'w4', 'w3', 'w2', 'w1'])
  })

  it('one that needs you, then five others: it stays, the others keep the newest four', () => {
    let list = add([], p('w1', 'needsYou'))
    for (let i = 1; i <= 5; i++) list = add(list, p(`f${i}`, 'finished'))
    expect(list.map((x) => x.id)).toEqual(['f5', 'f4', 'f3', 'f2', 'w1'])
    expect(list.filter((x) => x.kind === 'finished')).toHaveLength(MAX_POPUPS)
  })

  it('those that need you set to close like the others: kept like them; answered, one closes like the others too', () => {
    let list: P[] = []
    for (let i = 1; i <= 6; i++) list = add(list, p(`w${i}`, 'needsYou'), false)
    expect(list.map((x) => x.id)).toEqual(['w6', 'w5', 'w4', 'w3'])
    expect(staysUntilHandled({ kind: 'needsYou', level: 'info', resolved: 'Answered' }, true)).toBe(false)
  })

  it("a pop-up's time: the setting's; an error, or live buttons, at least 15 s; its own time first", () => {
    expect(popupMs({ level: 'info' }, 6)).toBe(6000)
    expect(popupMs({ level: 'error' }, 6)).toBe(15_000)
    expect(popupMs({ level: 'info', actions: [{ label: 'Undo', command: 'x' }] }, 6)).toBe(15_000)
    expect(popupMs({ level: 'info', actions: [{ label: 'Undo', command: 'x' }], resolved: 'Done' }, 6)).toBe(6000)
    expect(popupMs({ level: 'info' }, 30)).toBe(30_000)
    expect(popupMs({ level: 'info', timeoutMs: 10_000 }, 6)).toBe(10_000)
    // Its own time is for answering it: resolved, the setting's (HI-2370).
    expect(popupMs({ level: 'info', timeoutMs: 120_000, actions: [{ label: 'Resume', command: 'x' }], resolved: 'Not resumed' }, 6)).toBe(6000)
    expect(popupMs({ level: 'error', timeoutMs: 120_000, resolved: 'Done' }, 6)).toBe(15_000)
  })

  it('announced at once when it needs you or is an error; politely otherwise', () => {
    expect(popupRole({ kind: 'needsYou', level: 'info' })).toBe('alert')
    expect(popupRole({ level: 'error' })).toBe('alert')
    expect(popupRole({ kind: 'finished', level: 'success' })).toBe('status')
    expect(popupRole({ level: 'warning' })).toBe('status')
  })
})

// main/notify.ts: one entry per event, one owner, offers resolved by their own key.
describe('tell(): one entry, one window', () => {
  const sent = new Map<number, HiveEvent[]>()
  const win = (id: number, focusedNow = false) => ({ id, focusedNow, isDestroyed: () => false, webContents: { id, send: (_c: string, e: HiveEvent) => sent.set(id, [...(sent.get(id) ?? []), e]) } })
  const A = win(1)
  const B = win(2)
  let focused: ReturnType<typeof win> | null = null
  let notify: typeof import('../src/main/notify')
  let config: typeof import('../src/main/config').config

  beforeEach(async () => {
    sent.clear()
    focused = null
    notify = await import('../src/main/notify')
    config = (await import('../src/main/config')).config
    const electron = await import('electron')
    vi.spyOn(electron.Notification, 'isSupported').mockReturnValue(false)
    notify.setNotifyHost({
      focused: () => (focused ? { win: focused as never, workspacePath: focused === A ? 'C:\\Work\\A' : 'C:\\Work\\B', projectPath: null } : null),
      // With none focused: the window of the entry's own workspace.
      fallback: (p) => (p?.toLowerCase().startsWith('c:\\work\\b') ? B : A) as never,
      workspaceOf: (p) => (p.toLowerCase().startsWith('c:\\work\\b') ? 'C:\\Work\\B' : 'C:\\Work\\A')
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    notify.resetOffers()
    notify.setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
  })
  const toasts = (w: { id: number }) => (sent.get(w.id) ?? []).flatMap((e) => (e.type === 'toast' ? [e.toast] : []))

  it("HI-2355: a result of window B's request goes to B even if A has the focus by then; an agent's notice made in that request still goes to the focused A; outside a request, the focused window", async () => {
    const { AsyncLocalStorage } = await import('async_hooks')
    // As ipc.ts keeps the request's window (senderStore), read through the host.
    const request = new AsyncLocalStorage<typeof B>()
    notify.setNotifyHost({
      focused: () => (focused ? { win: focused as never, workspacePath: null, projectPath: null } : null),
      fallback: () => A as never,
      workspaceOf: () => null,
      requester: () => (request.getStore() as never) ?? null
    })
    focused = B
    // B's request is held at a barrier while the user moves to window A from outside it, then released.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const running = request.run(B, async () => {
      await held
      notify.tell({ kind: 'result', title: 'Copied to workspace' })
      notify.tell({ kind: 'warning', title: 'Platform changed' })
      notify.tell({ kind: 'needsYou', title: 'beta needs your input', projectPath: 'C:\\Work\\B\\beta' })
    })
    focused = A
    release()
    await running
    expect(toasts(B).map((t) => t.title)).toEqual(['Copied to workspace', 'Platform changed'])
    expect(toasts(A).map((t) => t.title)).toEqual(['beta needs your input'])
    // No request: Hive's own message goes to the window in use.
    notify.tell({ kind: 'warning', title: 'Background warning' })
    expect(toasts(A).map((t) => t.title)).toEqual(['beta needs your input', 'Background warning'])
  })

  it("workspace B's warning while A is focused: it pops up in A, the window you are using, and nowhere else", () => {
    focused = A
    const t = notify.tell({ kind: 'warning', title: 'B left 2 processes running', projectPath: 'C:\\Work\\B\\beta' })
    expect(toasts(A).map((x) => [x.id, x.quiet ?? false])).toEqual([[t.id, false]])
    expect(toasts(B)).toEqual([])
    // Its link opens the project where it is (another window's).
    expect(toasts(A)[0].target).toEqual({ kind: 'project', projectPath: 'C:\\Work\\B\\beta', project: 'beta' })
  })

  it("none focused: an agent's finish is a Windows notification with a quiet row in its own workspace's window; Hive's warning waits there as a pop-up", () => {
    const f = notify.tell({ kind: 'finished', title: 'beta · Two finished', projectPath: 'C:\\Work\\B\\beta' })
    expect(f.route).toBe('windows')
    expect(toasts(B).map((x) => [x.title, x.quiet ?? false])).toEqual([['beta · Two finished', true]])
    const w = notify.tell({ kind: 'warning', title: 'Hooks silent', projectPath: 'C:\\Work\\B\\beta' })
    expect(w.route).toBe('popup')
    expect(toasts(B).map((x) => [x.title, x.quiet ?? false])).toEqual([['beta · Two finished', true], ['Hooks silent', false]])
    expect(toasts(A)).toEqual([])
  })

  it("Hive has closed: never in a window; nothing while you look at Hive", () => {
    expect(notify.tell({ kind: 'quit', title: 'Hive has closed' }).route).toBe('windows')
    expect(toasts(A)).toEqual([])
    focused = A
    expect(notify.tell({ kind: 'quit', title: 'Hive has closed' }).route).toBe('none')
    expect(toasts(A)).toEqual([])
  })

  it('off: nothing reaches any window, not even the bell', () => {
    config.settings.notifications.notifyOnFinished = false
    focused = A
    expect(notify.tell({ kind: 'finished', title: 'x', projectPath: 'C:\\Work\\A\\alpha' }).route).toBe('none')
    expect(toasts(A)).toEqual([])
  })

  it("an offer resolves its own entries only: an old one's completion never clears a newer offer for the same agent", () => {
    focused = A
    const resolved: { ids: string[]; outcome: string }[] = []
    const off = (async () => (await import('../src/main/events')).onHiveEvent((e) => e.type === 'toast-resolved' && void resolved.push({ ids: e.ids, outcome: e.outcome })))()
    return off.then((stop) => {
      const oldOffer = notify.askOffer('C:\\Work\\A\\alpha', 'a1')
      const old = notify.tell({ kind: 'needsYou', title: 'old ask', projectPath: 'C:\\Work\\A\\alpha', agentId: 'a1', offer: oldOffer })
      const newer = notify.tell({ kind: 'needsYou', title: 'new ask', projectPath: 'C:\\Work\\A\\alpha', agentId: 'a1', offer: notify.askOffer('C:\\Work\\A\\alpha', 'a1') })
      expect(notify.resolveOffer(oldOffer, 'Answered')).toBe(true)
      expect(resolved).toEqual([{ ids: [old.id], outcome: 'Answered' }])
      // Taken once: a late second completion of the same offer does nothing.
      expect(notify.resolveOffer(oldOffer, 'Answered')).toBe(false)
      expect(notify.offerOpen(oldOffer)).toBe(false)
      expect(resolved.flatMap((r) => r.ids)).not.toContain(newer.id)
      stop()
    })
  })

  it("a window closing lets go of the offers only it held", () => {
    focused = B
    notify.tell({ kind: 'warning', title: 'x', offer: 'update:1.0.0' })
    expect(notify.offerOpen('update:1.0.0')).toBe(true)
    notify.forgetOwner(B.id)
    expect(notify.offerOpen('update:1.0.0')).toBe(false)
  })
})

// HI-2320 (the Assistant's scope for round 3, HR2's round 2 finding 5): an entry's button run in another window waits
// for that window to say it has finished, and only that window; bounded, and cancelled if it reloads, its renderer goes
// or it closes, never passing for done.
describe('a button run in another window (noticeActionIn)', () => {
  const window = async (id: number) => {
    const { EventEmitter } = await import('events')
    const wc = Object.assign(new EventEmitter(), { id, sent: [] as unknown[], send: (_c: string, e: unknown) => void wc.sent.push(e) })
    return { webContents: wc, isDestroyed: () => false }
  }
  const replyOf = (w: { webContents: { sent: unknown[] } }) => (w.webContents.sent.at(-1) as { reply: string }).reply

  it('finishes when its own window replies; a reply from another window is ignored', async () => {
    const notify = await import('../src/main/notify')
    const target = await window(11)
    const done = notify.noticeActionIn(target as never, 'session.allowLockedEdit', ['p'])
    expect(target.webContents.sent.at(-1)).toMatchObject({ type: 'menu-command', command: 'session.allowLockedEdit' })
    const reply = replyOf(target)
    let settled = false
    void done.then(() => (settled = true))
    notify.noticeActionDone(reply, null, 22)
    await Promise.resolve()
    expect(settled).toBe(false)
    notify.noticeActionDone(reply, null, 11)
    await done
    expect(notify.noticeActionsWaiting()).toBe(0)
  })

  it('the other window reloads, or its renderer goes, mid-run: the wait ends as unfinished and is let go', async () => {
    const notify = await import('../src/main/notify')
    for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
      const target = await window(12)
      const done = notify.noticeActionIn(target as never, 'x', [])
      target.webContents.emit(event)
      await expect(done).rejects.toThrow(notify.NOTICE_ACTION_UNFINISHED)
      expect(notify.noticeActionsWaiting()).toBe(0)
      // A late reply after that changes nothing.
      notify.noticeActionDone(replyOf(target), null, 12)
    }
  })

  it('no reply in time: unfinished, never done', async () => {
    vi.useFakeTimers()
    try {
      const notify = await import('../src/main/notify')
      const target = await window(13)
      const done = notify.noticeActionIn(target as never, 'x', [], 1000)
      const failed = expect(done).rejects.toThrow(notify.NOTICE_ACTION_UNFINISHED)
      await vi.advanceTimersByTimeAsync(1000)
      await failed
      expect(notify.noticeActionsWaiting()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('its window closing ends the wait as unfinished', async () => {
    const notify = await import('../src/main/notify')
    const target = await window(14)
    const done = notify.noticeActionIn(target as never, 'x', [])
    notify.forgetOwner(14)
    await expect(done).rejects.toThrow(notify.NOTICE_ACTION_UNFINISHED)
  })
})
