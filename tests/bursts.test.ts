import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { chimeAllowed, FINISH_GROUP_MAX_MS, FINISH_GROUP_MS, FinishBatcher, finishedNotice, type Finish } from '../src/shared/bursts'
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
    expect(finishedNotice([finish('alpha', 'Claude')])).toEqual({ title: 'alpha · Claude finished', body: 'Claude is done.' })
  })

  it('several in one project are named; across projects, counted per project', () => {
    expect(finishedNotice([finish('alpha', 'Claude'), finish('alpha', 'Codex'), finish('alpha', 'Agent 3')])).toEqual({ title: '3 agents finished in alpha', body: 'Claude, Codex, Agent 3' })
    expect(finishedNotice([finish('alpha', 'Claude'), finish('web', 'One'), finish('alpha', 'Codex')])).toEqual({ title: '3 agents finished', body: 'alpha (2), web (1)' })
  })

  describe('grouping', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('finishes within a few seconds of each other go together, once they stop coming', () => {
      const sent: Finish[][] = []
      const b = new FinishBatcher((items) => sent.push(items))
      b.add(finish('alpha', 'A'))
      vi.advanceTimersByTime(FINISH_GROUP_MS - 500)
      b.add(finish('alpha', 'B'))
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
        b.add(finish('alpha', `Agent ${i}`))
        vi.advanceTimersByTime(2000)
      }
      expect(sent.length).toBeGreaterThanOrEqual(1)
      expect(sent[0].length).toBe(FINISH_GROUP_MAX_MS / 2000)
    })
  })
})

// SessionManager's own path (notify → the finish group → the Windows notification), with Electron's Notification
// recording what it would show and each project's window a stand-in whose focus the test sets.
describe('a group of finishes, when it is shown', () => {
  const ws = tempDir('cw-bursts-')
  const alpha = join(ws, 'alpha')
  const beta = join(ws, 'beta')
  let focused: Set<string>
  let windows: Map<string, { focus: ReturnType<typeof vi.fn> }>
  let shown: { title?: string; body?: string; click: () => void }[]
  /** Pop-ups sent to the focused window (HI-2320: entries not quiet): [window key, title, body]. */
  let banners: [string, string, string][]
  /** Bell rows only (quiet entries: told as a Windows notification, or left out of pop-ups): [window key, title]. */
  let bellOnly: [string, string][]

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
    bellOnly = []
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
      const send = (_channel: string, e: { type: string; toast?: { title: string; message?: string; quiet?: boolean } }) => {
        if (e?.type !== 'toast' || !e.toast) return
        if (e.toast.quiet) bellOnly.push([key, e.toast.title])
        else banners.push([key, e.toast.title, e.toast.message ?? ''])
      }
      const fake = { isVisible: () => true, isFocused: () => focused.has(key), isMinimized: () => false, isDestroyed: () => false, show: () => undefined, restore: () => undefined, focus: windows.get(key)!.focus, webContents: { send } }
      return fake as unknown as BrowserWindow
    }
    sessions.setWindowProvider((p) => (p ? windowFor(p.toLowerCase()) : null))
    // The Combwork window in use: the one the test says is focused, showing its project (one window per project here); with
    // none, an entry's own project's window owns it.
    const { setNotifyHost } = await import('../src/main/notify')
    setNotifyHost({
      focused: () => {
        const key = [...focused][0]
        return key ? { win: windowFor(key), workspacePath: ws, projectPath: key } : null
      },
      fallback: (p) => (p ? windowFor(p.toLowerCase()) : null),
      workspaceOf: () => ws
    })
    return async () => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      sessions.setWindowProvider(() => null)
      ;(await import('../src/main/notify')).setNotifyHost({ focused: () => null, fallback: () => null, workspaceOf: () => null })
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

  it('a Combwork window focused meanwhile: the group pops up in it, never a Windows notification too (HI-2320: once, in one place)', async () => {
    await finished(alpha, 'One')
    focused.add(alpha.toLowerCase())
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual([])
    expect(banners).toEqual([[alpha.toLowerCase(), 'alpha · One finished', 'One is done.']])
    expect(bellOnly).toEqual([])
  })

  it('Combwork in the background: a Windows notification, and its row in its window\'s bell, never a pop-up', async () => {
    await finished(alpha, 'One')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['alpha · One finished'])
    expect(banners).toEqual([])
    expect(bellOnly).toEqual([[alpha.toLowerCase(), 'alpha · One finished']])
  })

  it("finishes in two windows, one focused meanwhile: one grouped banner in the focused window, counted from both; Combwork in the background: a Windows notification opened from the first", async () => {
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

  it("Show pop-ups for This project: the focused window pops up only its own project's; the rest go to its bell only", async () => {
    ;(await settings()).bannerScope = 'project'
    focused.add(alpha.toLowerCase())
    await finished(alpha, 'One')
    await finished(beta, 'Two')
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(banners).toEqual([[alpha.toLowerCase(), 'alpha · One finished', 'One is done.']])
    expect(bellOnly).toEqual([[alpha.toLowerCase(), 'beta · Two finished']])
    expect(shown).toEqual([])
  })

  it('waiting for input: shown at once and on its own, while a group of finishes is collected', async () => {
    const { sessions } = await import('../src/main/sessions')
    await finished(alpha, 'One')
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input'])
    await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
    // The same settings apply: a Combwork window focused, it pops up there, not a Windows notification; waiting
    // notifications off, it isn't told at all.
    focused.add(beta.toLowerCase())
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(banners).toEqual([[beta.toLowerCase(), 'beta · Two needs your input', 'Allow Bash?']])
    focused.clear()
    ;(await settings()).notifyOnWaiting = false
    ;(sessions as unknown as { notify: (...a: unknown[]) => void }).notify(beta, 'beta · Two needs your input', 'Allow Bash?', 'waiting')
    expect(titles()).toEqual(['beta · Two needs your input', 'alpha · One finished'])
  })

  // HI-2312: an agent whose next turn starts (its status leaves its turn's end for working, starting or waiting) while its
  // finish waits to be told: that finish isn't told, whatever the new turn ends as.
  describe('a finish whose agent starts its next turn before it is told', () => {
    type S = { notify: (...a: unknown[]) => void; emitState: (st: unknown) => void; settleBackground: (l: unknown, woke: boolean) => void }
    const manager = async () => (await import('../src/main/sessions')).sessions as unknown as S
    const agent = () => ({ projectPath: alpha, agentId: 'two', agentName: 'Two', status: 'working' as string })
    /** Its status, as a hook step sets it and reports it. */
    const goes = async (st: ReturnType<typeof agent>, status: string) => {
      st.status = status
      ;(await manager()).emitState(st)
    }
    const twoFinishes = async (body: string) => (await manager()).notify(alpha, 'alpha · Two finished', body, 'finished', 'Two', 'two')

    it('working again: left out of the group, which is told without it', async () => {
      const st = agent()
      await twoFinishes('Started OV-246.')
      await goes(st, 'finished')
      await finished(beta, 'Three')
      await goes(st, 'working')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(titles()).toEqual(['beta · Three finished'])
    })

    it('a second turn ended within the group: only its own finish is told, once', async () => {
      const st = agent()
      await twoFinishes('Started OV-246.')
      await goes(st, 'finished')
      await goes(st, 'working')
      await twoFinishes('Merged it.')
      await goes(st, 'finished')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(shown.map((n) => [n.title, n.body])).toEqual([['alpha · Two finished', 'Merged it.']])
    })

    it('a second turn ending into a card watch: nothing told (its own end is a watch, the first is over)', async () => {
      const st = agent()
      await twoFinishes('Started OV-246.')
      await goes(st, 'finished')
      await goes(st, 'working')
      await goes(st, 'watching')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(shown).toEqual([])
    })

    it('waiting for you in its next turn: that is told at once, and the finish before it never', async () => {
      const s = await manager()
      const st = agent()
      await twoFinishes('Started OV-246.')
      await goes(st, 'finished')
      await goes(st, 'waiting')
      s.notify(alpha, 'alpha · Two needs your input', 'Allow Bash?', 'waiting', undefined, 'two')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(titles()).toEqual(['alpha · Two needs your input'])
    })

    it('its background tasks ended (a finish of its own), then a new turn: not told either', async () => {
      const s = await manager()
      const st = { ...agent(), status: 'background' }
      s.emitState(st)
      s.settleBackground({ state: st, tasks: new Map(), adapter: { descriptor: { capabilities: { backgroundWakes: true } } } }, false)
      expect(st.status).toBe('finished')
      await goes(st, 'working')
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(shown).toEqual([])
      // Without a new turn, the same finish is told.
      await goes(st, 'background')
      s.settleBackground({ state: st, tasks: new Map(), adapter: { descriptor: { capabilities: { backgroundWakes: true } } } }, false)
      await vi.advanceTimersByTimeAsync(FINISH_GROUP_MS)
      expect(shown.map((n) => n.body)).toEqual(['Its background tasks have ended.'])
    })
  })
})
