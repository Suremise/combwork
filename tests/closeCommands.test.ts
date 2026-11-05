// HI-1368's close commands as Combwork runs them: a close of a workspace joined by others for the same open (one close, one
// run, the first reason's); with no command an ordinary close, nothing drained or run; a workspace not finished being
// written runs nothing and says so; When Combwork quits doesn't run when a workspace didn't drain, nor with none set. The
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
    // A list's commands as they'd run, their placeholders filled in (HI-1954), or HI-1368's one command.
    startRun: (_root: string, _folder: string, job: string | { steps: { command: string }[]; values: import('../src/shared/commands').CommandValues }) => {
      state.started.push(typeof job === 'string' ? job : job.steps.map((s) => fillCommand(s.command, job.values).text).join(' && '))
      throw new Error('no runner in a unit test')
    }
  }
})

const { closeCommandState, closeWithCommand, dontWait, quitRunsAny, runQuitCommand } = await import('../src/main/closeCommand/closeCommands')
const { fillCommand } = await import('../src/shared/commands')
/** Combwork's commands with When Combwork quits running `command` (none: nothing), as Settings saves them (HI-1954). */
const hive = (command: string, onUpdate = false) => ({ list: command ? [{ id: 'c-0000000f', name: 'Quit', command }] : [], onQuit: { run: command ? [{ scope: 'hive' as const, id: 'c-0000000f' }] : [], ...(onUpdate ? { onUpdate } : {}) } })
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
    // Its close point running `command` (HI-1954: a list of one), as Settings saves it.
    config: { commands: { list: command ? [{ id: 'c-00000001', name: 'Backup', command }] : [], onOpen: { run: [] }, onClose: { run: command ? [{ scope: 'workspace' as const, id: 'c-00000001' }] : [] } } },
    info: () => ({ projects: [] }),
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

  it("a test copy of Combwork: closed, the command not run", async () => {
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

describe("a quit with When Combwork quits to run (HR6's round 1, findings 1 and 3; the saving step)", () => {
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

  it("a close held, and Skip the command at its saving step: the panel stays and the close goes on; released, its command and When Combwork quits are skipped and nothing starts (Darren's decision, 15:30)", async () => {
    for (const command of ['backup', '']) {
      const held = gate()
      const ws = fakeWs('D:\\ws\\Work', command, held.wait)
      const win = fakeWin()
      let outcome: string | null = null
      const r = closeWithCommand(ws as never, 'quit', win as never, { drain: true }).then((x) => (outcome = x))
      const saving = await panelIn(win, 'saving')
      expect(saving).toMatchObject({ state: 'saving', workspace: 'Work', ...(command ? { steps: [{ name: 'Backup', state: 'waiting' }] } : {}) })
      dontWait(win as never, saving!.id)
      expect(closeCommandState(win as never)).toMatchObject({ state: 'saving', skipped: true })
      await flush()
      expect(outcome).toBeNull()
      expect(ws.close).toHaveBeenCalledTimes(1)
      held.open()
      await r
      expect(outcome).toBe('leftSaving')
      expect(closeCommandState(win as never)).toBeNull()
      expect(ws.close).toHaveBeenCalledTimes(1)
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
    // The runner's start fails (stood in): the same panel says so, as its first step's failure, its choices offered (HI-1954).
    const failed = await panelIn(win, 'failed')
    expect([failed?.id, failed?.steps?.[0]?.failure, failed?.awaiting]).toEqual([saving?.id, 'spawn', { step: 0, attempt: 0, needed: false }])
    expect(state.started).toEqual(['backup'])
    const { controlRun } = await import('../src/main/closeCommand/closeCommands')
    // A choice for another attempt does nothing; Stop here ends it.
    controlRun(win as never, failed!.id, 'stop', 0, 1)
    expect(closeCommandState(win as never)?.state).toBe('failed')
    controlRun(win as never, failed!.id, 'stop', 0, 0)
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
    it(`a window's close under way (${command ? 'with a command' : 'plain'}) when the quit joins it: one close, its saving step shown; Skip there, then the close released: both skipped, nothing starts (Darren's decision, 15:30)`, async () => {
      const held = gate()
      const ws = fakeWs('D:\\ws\\Work', command, held.wait)
      const win = fakeWin()
      // The window's own close first; then the quit joins it, needing it drained.
      const closing = closeWithCommand(ws as never, 'window', win as never)
      const joined = closeWithCommand(ws as never, 'quit', win as never, { drain: true })
      const saving = await panelIn(win, 'saving')
      expect(saving?.workspace).toBe('Work')
      dontWait(win as never, saving!.id)
      held.open()
      await expect(Promise.all([closing, joined])).resolves.toEqual(['leftSaving', 'leftSaving'])
      expect(ws.close).toHaveBeenCalledTimes(1)
      expect(state.drains).toHaveLength(0)
      expect(state.started).toHaveLength(0)
    })
  }
})

describe('When Combwork quits, run', () => {
  it("doesn't run after a workspace that wasn't finished being written, nor with none set", async () => {
    await expect(runQuitCommand(hive('backup all'), 'quit', null, 'failed')).resolves.toBe('notDrained')
    await expect(runQuitCommand(hive('backup all'), 'quit', null, 'left')).resolves.toBe('leftSaving')
    await expect(runQuitCommand(hive(''), 'quit', null, null)).resolves.toBe('skipped')
    expect(state.started).toHaveLength(0)
    await expect(runQuitCommand(hive('backup all {reason}'), 'quit', null, null)).resolves.toBe('failed')
    expect(state.started).toEqual(['backup all quit'])
  })

  it('a quit has something to run only with a command set somewhere, and never in a test copy', () => {
    const plain = fakeWs('D:\\ws\\A')
    const withOne = fakeWs('D:\\ws\\B', 'backup')
    expect(quitRunsAny([plain] as never, hive(''))).toBe(false)
    expect(quitRunsAny([plain, withOne] as never, hive(''))).toBe(true)
    expect(quitRunsAny([plain] as never, hive('x'))).toBe(true)
    state.runs = false
    expect(quitRunsAny([withOne] as never, hive('x'))).toBe(false)
  })
})
