// HI-1368's close commands as Hive runs them: a close of a workspace joined by others for the same open (one close, one
// run, the first reason's); with no command an ordinary close, nothing drained or run; a workspace not finished being
// written runs nothing and says so; When Hive quits doesn't run when a workspace didn't drain, nor with none set. The
// window, the drain and the runner are stood in for.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ drains: [] as { path: string; resolve: (r: { drained: boolean; left?: string[] }) => void }[], started: [] as string[], runs: true }))

vi.mock('../src/main/closeCommand/drain', () => ({
  // As the real one: its `cancelled` (the user's Don't wait) ends it at once, not drained.
  drainWorkspace: (path: string, _place: string, o: { cancelled?: AbortSignal } = {}) =>
    new Promise((resolve) => {
      state.drains.push({ path, resolve: resolve as never })
      o.cancelled?.addEventListener('abort', () => resolve({ drained: false, left: ["the user didn't wait for it"] }))
    })
}))
vi.mock('../src/main/closeCommand/runs', async (orig) => {
  const real = await orig<typeof import('../src/main/closeCommand/runs')>()
  return {
    ...real,
    runsCloseCommands: () => state.runs,
    pruneRuns: async () => undefined,
    startRun: (_root: string, _folder: string, command: string) => {
      state.started.push(command)
      throw new Error('no runner in a unit test')
    }
  }
})

const { closeCommandState, closeWithCommand, dontWait, quitRunsAny, runQuitCommand } = await import('../src/main/closeCommand/closeCommands')
const { EventEmitter } = await import('events')

let windows = 0
/** A window, as far as the panels use one: what it was sent. */
function fakeWin() {
  const sent: unknown[] = []
  const id = ++windows
  return Object.assign(new EventEmitter(), { sent, webContents: { id, send: (_c: string, e: unknown) => void sent.push(e) }, isDestroyed: () => false, isVisible: () => true, showInactive: () => undefined })
}
/** The window's panel, once it shows `state`. */
const panelIn = async (win: ReturnType<typeof fakeWin>, want: string) => {
  for (let i = 0; i < 20 && closeCommandState(win as never)?.state !== want; i++) await Promise.resolve()
  return closeCommandState(win as never)
}

/** A window's workspace service, as far as the close commands use it; `held`: its close waits for the gate. */
function fakeWs(path: string | null, command = '', held?: Promise<void>) {
  const ws = {
    path,
    openPlace: path ? path.toLowerCase() : null,
    config: { onClose: { command, onUpdate: false } },
    closes: 0,
    close: vi.fn(async () => {
      ws.closes++
      await held
      ws.path = null
      ws.openPlace = null
    })
  }
  return ws
}
/** A gate a test opens: what waits on it goes on then. */
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void
  return { wait: new Promise<void>((r) => (open = r)), open }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  state.drains.length = 0
  state.started.length = 0
  state.runs = true
})

describe('a workspace closing with its command', () => {
  it('a switch, a window close and a quit at once: one close, one drain, one run, with the first reason', async () => {
    const ws = fakeWs('D:\\ws\\Work', 'backup {reason}')
    const a = closeWithCommand(ws as never, 'switch', null)
    const b = closeWithCommand(ws as never, 'window', null)
    const c = closeWithCommand(ws as never, 'quit', null)
    await flush()
    expect(ws.close).toHaveBeenCalledTimes(1)
    expect(state.drains.map((d) => d.path)).toEqual(['D:\\ws\\Work'])
    state.drains[0].resolve({ drained: true })
    // No window: the runner's start fails (stood in), and its panel has no window to wait in.
    expect(await Promise.all([a, b, c])).toEqual(['failed', 'failed', 'failed'])
    expect(state.started).toEqual(['backup switch'])
  })

  it('with no command: an ordinary close, nothing drained or run', async () => {
    const ws = fakeWs('D:\\ws\\Plain')
    await expect(closeWithCommand(ws as never, 'window', null)).resolves.toBe('skipped')
    expect(ws.close).toHaveBeenCalledTimes(1)
    expect(state.drains).toHaveLength(0)
    expect(state.started).toHaveLength(0)
  })

  it("a test copy of Hive: closed, the command not run", async () => {
    state.runs = false
    const ws = fakeWs('D:\\ws\\Work', 'backup')
    await expect(closeWithCommand(ws as never, 'window', null)).resolves.toBe('skipped')
    expect(state.drains).toHaveLength(0)
  })

  it("not finished being written in time: the command doesn't run, and the close says so", async () => {
    const ws = fakeWs('D:\\ws\\Work', 'backup')
    const r = closeWithCommand(ws as never, 'window', null)
    await flush()
    state.drains[0].resolve({ drained: false, left: ['1 write(s) under way'] })
    await expect(r).resolves.toBe('notDrained')
    expect(state.started).toHaveLength(0)
  })

  it('an update restart without the tick: closed, not run', async () => {
    const ws = fakeWs('D:\\ws\\Work', 'backup')
    await expect(closeWithCommand(ws as never, 'update', null)).resolves.toBe('skipped')
    expect(state.drains).toHaveLength(0)
  })

  it('a workspace already closed: nothing to run', async () => {
    const ws = fakeWs(null)
    await expect(closeWithCommand(ws as never, 'window', null)).resolves.toBe('skipped')
  })
})

describe("a quit with When Hive quits to run (HR6's round 1, findings 1 and 3; the saving step)", () => {
  it('a workspace with no command of its own is drained all the same, and one not drained blocks it', async () => {
    const ws = fakeWs('D:\\ws\\Plain')
    const r = closeWithCommand(ws as never, 'quit', null, { drain: true })
    await flush()
    expect(state.drains.map((d) => d.path)).toEqual(['D:\\ws\\Plain'])
    state.drains[0].resolve({ drained: false, left: ['1 write(s) under way'] })
    await expect(r).resolves.toBe('notDrained')
    const ok = fakeWs('D:\\ws\\Plain2')
    const r2 = closeWithCommand(ok as never, 'quit', null, { drain: true })
    await flush()
    state.drains[1].resolve({ drained: true })
    await expect(r2).resolves.toBe('skipped')
    expect(state.started).toHaveLength(0)
  })

  it('an update restart whose workspace command is skipped is still drained before the global one', async () => {
    const ws = fakeWs('D:\\ws\\Work', 'backup')
    const r = closeWithCommand(ws as never, 'update', null, { drain: true })
    await flush()
    expect(state.drains).toHaveLength(1)
    state.drains[0].resolve({ drained: true })
    await expect(r).resolves.toBe('skipped')
    expect(state.started).toHaveLength(0)
  })

  it('a close that fails is not drained: nothing after it runs', async () => {
    const ws = fakeWs('D:\\ws\\Work')
    ws.close.mockRejectedValueOnce(new Error('a closing task failed'))
    await expect(closeWithCommand(ws as never, 'quit', null, { drain: true })).resolves.toBe('notDrained')
    expect(state.drains).toHaveLength(0)
  })

  it("a close held, and the user's Don't wait at its saving step: at once, its command and When Hive quits skipped; released later, it starts nothing (Darren's decision, 14:15)", async () => {
    for (const command of ['backup', '']) {
      const held = gate()
      const ws = fakeWs('D:\\ws\\Work', command, held.wait)
      const win = fakeWin()
      const r = closeWithCommand(ws as never, 'quit', win as never, { drain: true })
      const saving = await panelIn(win, 'saving')
      expect(saving).toMatchObject({ state: 'saving', workspace: 'Work', command })
      dontWait(win as never, saving!.id)
      await expect(r).resolves.toBe('leftSaving')
      expect(closeCommandState(win as never)).toBeNull()
      held.open()
      await flush()
      expect(state.drains).toHaveLength(0)
      expect(state.started).toHaveLength(0)
    }
  })

  it('a drain under way: its saving step shows until it ends, and the command then runs in the same panel', async () => {
    const ws = fakeWs('D:\\ws\\Work', 'backup')
    const win = fakeWin()
    const r = closeWithCommand(ws as never, 'window', win as never)
    const saving = await panelIn(win, 'saving')
    expect(saving?.state).toBe('saving')
    // The step is up from the start: its close first, then its drain.
    for (let i = 0; i < 20 && !state.drains.length; i++) await Promise.resolve()
    state.drains[0].resolve({ drained: true })
    // The runner's start fails (stood in): the same panel says so, until it is closed.
    const failed = await panelIn(win, 'failed')
    expect([failed?.id, failed?.failure]).toEqual([saving?.id, 'spawn'])
    expect(state.started).toEqual(['backup'])
    const { dismiss } = await import('../src/main/closeCommand/closeCommands')
    dismiss(win as never, failed!.id)
    await expect(r).resolves.toBe('failed')
  })

  it('a plain close under way when the quit joins it: drained as part of it, before the global one', async () => {
    const held = gate()
    const ws = fakeWs('D:\\ws\\Plain', '', held.wait)
    const closing = closeWithCommand(ws as never, 'window', null)
    const joined = closeWithCommand(ws as never, 'quit', null, { drain: true })
    held.open()
    await flush()
    expect(ws.close).toHaveBeenCalledTimes(1)
    expect(state.drains.map((d) => d.path)).toEqual(['D:\\ws\\Plain'])
    state.drains[0].resolve({ drained: true })
    await expect(Promise.all([closing, joined])).resolves.toEqual(['skipped', 'skipped'])
    expect(state.drains).toHaveLength(1)
  })

  for (const command of ['', 'backup']) {
    it(`a window's close under way (${command ? 'with a command' : 'plain'}) when the quit joins it: its saving step shows, and Don't wait there ends both at once; released later, nothing starts (HR6's round 2, finding 1; Darren's decision, 14:15)`, async () => {
      const held = gate()
      const ws = fakeWs('D:\\ws\\Work', command, held.wait)
      const win = fakeWin()
      // The window's own close first; then the quit joins it, needing it drained.
      const closing = closeWithCommand(ws as never, 'window', win as never)
      const joined = closeWithCommand(ws as never, 'quit', win as never, { drain: true })
      const saving = await panelIn(win, 'saving')
      expect(saving?.workspace).toBe('Work')
      dontWait(win as never, saving!.id)
      await expect(Promise.all([closing, joined])).resolves.toEqual(['leftSaving', 'leftSaving'])
      held.open()
      await flush()
      expect(state.drains).toHaveLength(0)
      expect(state.started).toHaveLength(0)
    })
  }
})

describe('When Hive quits, run', () => {
  it("doesn't run after a workspace that wasn't finished being written, nor with none set", async () => {
    await expect(runQuitCommand({ command: 'backup all', onUpdate: false }, 'quit', null, 'failed')).resolves.toBe('notDrained')
    await expect(runQuitCommand({ command: 'backup all', onUpdate: false }, 'quit', null, 'left')).resolves.toBe('leftSaving')
    await expect(runQuitCommand({ command: '', onUpdate: false }, 'quit', null, null)).resolves.toBe('skipped')
    expect(state.started).toHaveLength(0)
    await expect(runQuitCommand({ command: 'backup all {reason}', onUpdate: false }, 'quit', null, null)).resolves.toBe('failed')
    expect(state.started).toEqual(['backup all quit'])
  })

  it('a quit has something to run only with a command set somewhere, and never in a test copy', () => {
    const plain = fakeWs('D:\\ws\\A')
    const withOne = fakeWs('D:\\ws\\B', 'backup')
    expect(quitRunsAny([plain] as never, { command: '', onUpdate: false })).toBe(false)
    expect(quitRunsAny([plain, withOne] as never, { command: '', onUpdate: false })).toBe(true)
    expect(quitRunsAny([plain] as never, { command: 'x', onUpdate: false })).toBe(true)
    state.runs = false
    expect(quitRunsAny([withOne] as never, { command: 'x', onUpdate: false })).toBe(false)
  })
})
