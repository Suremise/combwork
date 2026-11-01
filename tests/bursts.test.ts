import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { chimeAllowed, FINISH_GROUP_MAX_MS, FINISH_GROUP_MS, FinishBatcher, finishedNotice, keepNotices, MAX_BANNERS, noticeRoute, noticeRouteWhy, type Finish } from '../src/shared/bursts'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { tempDir } from './tempDir'

const finish = (project: string, agent: string): Finish => ({ projectPath: `C:\\ws\\${project}`, project, agent, title: `${project} · ${agent} finished`, body: `${agent} is done.` })

describe('chimes', () => {
  it('at most one every 2 seconds', () => {
    expect(chimeAllowed(null, 1000)).toBe(true)
    expect(chimeAllowed(1000, 2500)).toBe(false)
    expect(chimeAllowed(1000, 3000)).toBe(true)
  })
})

describe('finished notifications', () => {
  it('one alone reads as before', () => {
    expect(finishedNotice([finish('hive', 'Claude')])).toEqual({ title: 'hive · Claude finished', body: 'Claude is done.' })
  })

  it('several in one project are named; across projects, counted per project', () => {
    expect(finishedNotice([finish('hive', 'Claude'), finish('hive', 'Codex'), finish('hive', 'Agent 3')])).toEqual({ title: '3 agents finished in hive', body: 'Claude, Codex, Agent 3' })
    expect(finishedNotice([finish('hive', 'Claude'), finish('web', 'One'), finish('hive', 'Codex')])).toEqual({ title: '3 agents finished', body: 'hive (2), web (1)' })
  })

  describe('grouping', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('finishes within a few seconds of each other go together, once they stop coming', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      b.add(finish('hive', 'A'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      b.add(finish('hive', 'B'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      expect(sent).toEqual([])
      vi.advanceTimersByTime(500)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B']])
      // A later one is a new group.
      b.add(finish('web', 'C'))
      vi.advanceTimersByTime(FINISH_GROUP_MS)
      expect(sent.map((g) => g.map((i) => i.agent))).toEqual([['A', 'B'], ['C']])
    })

    it('a steady stream is told at least every 10 seconds', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      for (let i = 0; i < 8; i++) {
        b.add(finish('hive', `Agent ${i}`))
        vi.advanceTimersByTime(2000)
      }
      expect(sent.length).toBeGreaterThanOrEqual(1)
      expect(sent[0].length).toBe(FINISH_GROUP_MAX_MS / 2000)
    })
  })
})

describe('the banners a window keeps (keepNotices)', () => {
  type N = { id: string; kind: 'finished' | 'waiting' }
  const n = (id: string, kind: N['kind']): N => ({ id, kind })
  const stays = (x: N) => x.kind === 'waiting'
  const add = (list: N[], x: N, keep = stays) => keepNotices([x, ...list], keep)

  it('more than four waiting for you: every one is kept, none pushed out', () => {
    let list: N[] = []
    for (let i = 1; i <= 6; i++) list = add(list, n(`w${i}`, 'waiting'))
    expect(list.map((x) => x.id)).toEqual(['w6', 'w5', 'w4', 'w3', 'w2', 'w1'])
  })

  it('one waiting, then four finished: the waiting one stays, the finished keep the newest four', () => {
    let list = add([], n('w1', 'waiting'))
    for (let i = 1; i <= 5; i++) list = add(list, n(`f${i}`, 'finished'))
    expect(list.map((x) => x.id)).toEqual(['f5', 'f4', 'f3', 'f2', 'w1'])
    expect(list.filter((x) => x.kind === 'finished')).toHaveLength(MAX_BANNERS)
  })

  it('waiting banners set to close like the others: kept like them, the newest four', () => {
    let list: N[] = []
    for (let i = 1; i <= 6; i++) list = add(list, n(`w${i}`, 'waiting'), () => false)
    expect(list.map((x) => x.id)).toEqual(['w6', 'w5', 'w4', 'w3'])
  })
})

describe('where a notice goes (noticeRoute)', () => {
  const on = { ...DEFAULT_SETTINGS.notifications }
  const wsA = 'C:\\Work\\A'
  const from = { workspacePath: wsA, projectPath: `${wsA}\\alpha` }
  const lookingAt = (workspacePath: string, projectPath: string | null) => ({ workspacePath, projectPath })

  it('Hive in the background: a Windows notification; any Hive window focused: a banner in it (Show in Hive, the default)', () => {
    expect(on.whileFocused).toBe('inApp')
    for (const kind of ['finished', 'waiting', 'notice'] as const) {
      expect(noticeRoute(on, kind, null, from), kind).toBe('windows')
      // Any Hive window, not only the one showing the project: another workspace's window focused is still Hive in use.
      expect(noticeRoute(on, kind, lookingAt('C:\\Work\\B', null), from), kind).toBe('banner')
      expect(noticeRoute(on, kind, lookingAt(wsA, `${wsA}\\alpha`), from), kind).toBe('banner')
    }
  })

  it('While Hive is focused: Show nothing, or a Windows notification; in the background always a Windows notification', () => {
    expect(noticeRoute({ ...on, whileFocused: 'nothing' }, 'finished', lookingAt(wsA, null), from)).toBe('none')
    expect(noticeRoute({ ...on, whileFocused: 'windows' }, 'finished', lookingAt(wsA, null), from)).toBe('windows')
    expect(noticeRoute({ ...on, whileFocused: 'nothing' }, 'finished', null, from)).toBe('windows')
  })

  it('notifications, or that kind, off: nowhere, focused or not', () => {
    for (const focused of [null, lookingAt(wsA, null)]) {
      for (const kind of ['finished', 'waiting', 'notice'] as const) expect(noticeRoute({ ...on, desktopNotifications: false }, kind, focused, from), kind).toBe('none')
      expect(noticeRoute({ ...on, notifyOnFinished: false }, 'finished', focused, from)).toBe('none')
      expect(noticeRoute({ ...on, notifyOnFinished: false }, 'waiting', focused, from)).not.toBe('none')
      expect(noticeRoute({ ...on, notifyOnWaiting: false }, 'waiting', focused, from)).toBe('none')
      expect(noticeRoute({ ...on, notifyOnWaiting: false }, 'notice', focused, from)).not.toBe('none')
    }
  })

  it('Show banners for: every window, this workspace, or this project; a notice left out shows nothing at all', () => {
    const other = lookingAt('C:\\Work\\B', 'C:\\Work\\B\\beta')
    const sameWsOtherProject = lookingAt('c:\\work\\a', 'c:\\work\\a\\gamma')
    const sameProject = lookingAt('c:\\work\\a', 'c:\\work\\a\\ALPHA')
    expect(noticeRoute({ ...on, bannerScope: 'all' }, 'finished', other, from)).toBe('banner')
    expect(noticeRoute({ ...on, bannerScope: 'workspace' }, 'finished', other, from)).toBe('none')
    expect(noticeRoute({ ...on, bannerScope: 'workspace' }, 'finished', sameWsOtherProject, from)).toBe('banner')
    expect(noticeRoute({ ...on, bannerScope: 'project' }, 'finished', sameWsOtherProject, from)).toBe('none')
    expect(noticeRoute({ ...on, bannerScope: 'project' }, 'waiting', sameProject, from)).toBe('banner')
    expect(noticeRoute({ ...on, bannerScope: 'project' }, 'finished', lookingAt('c:\\work\\a', null), from)).toBe('none')
    // A notice about no project (plan usage) is for every scope.
    for (const bannerScope of ['all', 'workspace', 'project'] as const) expect(noticeRoute({ ...on, bannerScope }, 'notice', other, { workspacePath: null, projectPath: null }), bannerScope).toBe('banner')
  })
})

// SessionManager's own path (notify → the finish group → the Windows notification), with Electron's Notification
// recording what it would show and each project's window a stand-in whose focus the test sets.
describe('a group of finishes, when it is shown', () => {
  const ws = tempDir('hive-bursts-')
  const alpha = join(ws, 'alpha')
  const beta = join(ws, 'beta')
  let focused: Set<string>
  let windows: Map<string, { focus: ReturnType<typeof vi.fn> }>
  let shown: { title?: string; body?: string; click: () => void }[]
  /** Banners sent to the focused window: [window key, title, body]. */
  let banners: [string, string, string][]

  beforeEach(async () => {
    vi.useFakeTimers()
    const electron = await import('electron')
    const { config } = await import('../src/main/config')
    const { sessions } = await import('../src/main/sessions')
    const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
    const w = createWorkspaceService()
    w.path = ws
    Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
    focused = new Set()
    windows = new Map()
    shown = []
    banners = []
    vi.spyOn(electron.Notification, 'isSupported').mockReturnValue(true)
    const clicks = new WeakMap<object, () => void>()
    vi.spyOn(electron.Notification.prototype, 'on').mockImplementation(function (this: object, _ev: unknown, fn: unknown) {
      clicks.set(this, fn as () => void)
      return this as never
    } as never)
    vi.spyOn(electron.Notification.prototype, 'show').mockImplementation(function (this: { options?: { title?: string; body?: string } }) {
      shown.push({ ...this.options, click: () => clicks.get(this)?.() })
    })
    // One window per project, visible; focused while the test says so.
    const windowFor = (key: string): BrowserWindow => {
      if (!windows.has(key)) windows.set(key, { focus: vi.fn() })
      const send = (_channel: string, e: { type: string; notice?: { title: string; body: string } }) => {
        if (e?.type === 'notice' && e.notice) banners.push([key, e.notice.title, e.notice.body])
      }
      const fake = { isVisible: () => true, isFocused: () => focused.has(key), isMinimized: () => false, isDestroyed: () => false, show: () => undefined, restore: () => undefined, focus: windows.get(key)!.focus, webContents: { send } }
      return fake as unknown as BrowserWindow
    }
    sessions.setWindowProvider((p) => (p ? windowFor(p.toLowerCase()) : null))
    // The Hive window in use: the one the test says is focused, showing its project (one window per project here).
    sessions.setFocusedWindowProvider(() => {
      const key = [...focused][0]
      return key ? { win: windowFor(key), workspacePath: ws, projectPath: key } : null
    })
    return async () => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      sessions.setWindowProvider(() => null)
      sessions.setFocusedWindowProvider(() => null)
      Object.assign(config.settings.notifications, DEFAULT_SETTINGS.notifications)
      await disposeWorkspaceService(w)
    }
  })

  const finished = async (project: string, agent: string): Promise<void> => {
    const { sessions } = await import('../src/main/sessions')
    const name = project === alpha ? 'alpha' : 'beta'
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(project, `${name} · ${agent} finished`, `${agent} is done.`, 'finished', agent)
  }
  const settings = async () => (await import('../src/main/config')).config.settings.notifications
  const titles = () => shown.map((s) => s.title)

  it('agents finishing together: one notification naming them', async () => {
    await finished(alpha, 'One')
    await finished(alpha, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(shown.map((s) => [s.title, s.body])).toEqual([['2 agents finished in alpha', 'One, Two']])
  })

  it('desktop notifications, or finished ones, turned off meanwhile: nothing is shown', async () => {
    for (const off of ['desktopNotifications', 'notifyOnFinished'] as const) {
      await finished(alpha, 'One')
      ;(await settings())[off] = false
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(titles(), off).toEqual([])
      ;(await settings())[off] = true
    }
  })

  it('a Hive window focused meanwhile: the group is a banner in it, not a Windows notification; set to Windows notifications, one', async () => {
    await finished(alpha, 'One')
    focused.add(alpha.toLowerCase())
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual([])
    expect(banners).toEqual([[alpha.toLowerCase(), 'alpha · One finished', 'One is done.']])
    ;(await settings()).whileFocused = 'windows'
    await finished(alpha, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['alpha · Two finished'])
    expect(banners).toHaveLength(1)
  })

  it("finishes in two windows, one focused meanwhile: one grouped banner in the focused window, counted from both; Hive in the background: a Windows notification opened from the first", async () => {
    await finished(alpha, 'One')
    await finished(beta, 'Two')
    await finished(beta, 'Three')
    focused.add(alpha.toLowerCase())
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(shown).toEqual([])
    expect(banners).toEqual([[alpha.toLowerCase(), '3 agents finished', 'alpha (1), beta (2)']])
    focused.clear()
    await finished(beta, 'Two')
    await finished(beta, 'Three')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(shown.map((s) => [s.title, s.body])).toEqual([['2 agents finished in beta', 'Two, Three']])
    shown[0].click()
    expect(windows.get(beta.toLowerCase())?.focus).toHaveBeenCalled()
  })

  it('Show banners for This project: the focused window shows only its own project\'s; the rest show nothing at all', async () => {
    ;(await settings()).bannerScope = 'project'
    focused.add(alpha.toLowerCase())
    await finished(alpha, 'One')
    await finished(beta, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(banners).toEqual([[alpha.toLowerCase(), 'alpha · One finished', 'One is done.']])
    expect(shown).toEqual([])
  })

  it('waiting for input: shown at once and on its own, while a group of finishes is collected', async () => {
    const { sessions } = await import('../src/main/sessions')
    await finished(alpha, 'One')
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input'])
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
    // The same settings apply: a Hive window focused, it is a banner there, not a Windows notification; waiting
    // notifications off, it isn't told at all.
    focused.add(beta.toLowerCase())
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(banners).toEqual([[beta.toLowerCase(), 'beta · Two needs your input', 'Allow Bash?']])
    focused.clear()
    ;(await settings()).notifyOnWaiting = false
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
  })

  it('HI-2312: a finish whose agent works again (or waits for you) by the time the group is told is left out; its next need is told at once', async () => {
    const { sessions } = await import('../src/main/sessions')
    const s = sessions as unknown as { notify: (...a: unknown[]) => void; live: Map<string, unknown> }
    const key = `${alpha.toLowerCase()}#two`
    const st = { status: 'finished' }
    s.live.set(key, { state: st })
    try {
      for (const busy of ['working', 'waiting']) {
        s.notify(alpha, 'alpha · Two finished', 'Started OV-246.', 'finished', 'Two', 'two')
        s.notify(beta, 'beta · Three finished', 'Three is done.', 'finished', 'Three', 'three')
        // Hive's delivery at the turn's end started its next turn, inside the group's few seconds.
        st.status = busy
        if (busy === 'waiting') s.notify(alpha, 'alpha · Two needs your input', 'Allow Bash?', 'waiting', undefined, 'two')
        await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
        st.status = 'finished'
      }
      expect(titles()).toEqual(['beta · Three finished', 'alpha · Two needs your input', 'beta · Three finished'])
      // Finished still when the group is told: told, with that turn's message.
      s.notify(alpha, 'alpha · Two finished', 'Merged it.', 'finished', 'Two', 'two')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(shown.at(-1)).toMatchObject({ title: 'alpha · Two finished', body: 'Merged it.' })
    } finally {
      s.live.delete(key)
    }
  })
})

describe('why a notice goes where it goes (noticeRouteWhy, for the log)', () => {
  const on = { ...DEFAULT_SETTINGS.notifications, bannerScope: 'workspace' as const }
  const from = { workspacePath: 'C:\\Work\\A', projectPath: 'C:\\Work\\A\\alpha' }
  it('says the route and its reason', () => {
    expect(noticeRouteWhy(on, 'finished', null, from)).toEqual({ route: 'windows', why: 'no Hive window focused' })
    expect(noticeRouteWhy(on, 'finished', { workspacePath: 'C:\\Work\\B', projectPath: null }, from)).toEqual({ route: 'none', why: "banner scope: another workspace's" })
    expect(noticeRouteWhy(on, 'finished', { workspacePath: 'c:\\work\\a', projectPath: null }, from)).toEqual({ route: 'banner', why: 'banner scope: workspace' })
    expect(noticeRouteWhy({ ...on, notifyOnFinished: false }, 'finished', null, from).route).toBe(noticeRoute({ ...on, notifyOnFinished: false }, 'finished', null, from))
  })
})
