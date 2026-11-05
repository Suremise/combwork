// When a provider task types keys into a CLI (Codex's sandbox setup, #235): once the screen shows it has loaded, and
// its title has shown no spinner for a moment. Codex 0.160.0 draws its prompt while it is still loading, then writes
// the folder over "loading" in place; output can end anywhere, inside a word or an escape sequence.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Combwork's terminals, recorded instead (no process runs).
const pty = vi.hoisted(() => ({ onData: null as ((d: string) => void) | null, open: new Set<string>(), typed: [] as { at: number; keys: string }[] }))
vi.mock('../src/main/ptyHost', async (original) => ({
  ...(await original<object>()),
  spawnPty: (key: string, opts: { onData: (d: string) => void }) => {
    pty.open.add(key)
    pty.onData = opts.onData
  },
  hasPty: (key: string) => pty.open.has(key),
  killPty: (key: string) => void pty.open.delete(key),
  writePty: (_key: string, keys: string) => void pty.typed.push({ at: Date.now(), keys })
}))

const { CODEX_LOADED, codexHoldsInput } = await import('../src/main/providers/codex/adapter')
const { KeyGate } = await import('../src/main/taskKeys')
const { providerService } = await import('../src/main/providerService')
const events = await import('../src/main/events')
const { TerminalScreen } = await import('../src/main/terminalScreen')

const { stream } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex-startup-0.160.0.json'), 'utf8')) as { stream: string }
const BUSY = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/
/** Where Codex writes the folder over "loading" (in place: the cursor moves back to it). */
const folder = stream.indexOf('\x1b[3;6H~')
const loading = stream.indexOf('loading')
const version = stream.indexOf('(v0.160.0)')
/** The first spinner frame in its title, and its end (the plain title the fixture ends with). */
const spinner = stream.indexOf('\x1b]0;⠹')
const spinnerEnd = stream.lastIndexOf('\x1b]0;hive-codex-setup\x07')
// The terminal parses what it is given asynchronously, and the gate sets `ready` when it has parsed the screen. The wait is
// for that: every write the terminals have been given has been parsed (its callback ran), or its screen was disposed (no
// callback comes). A fixed delay raced the parser: about 15 ms a write on an idle machine, and not much less than 20 ms
// on a loaded one (#335).
type Pending = { screen: InstanceType<typeof TerminalScreen>; done: Promise<void>; settle: () => void }
const pending = new Set<Pending>()
const write = TerminalScreen.prototype.write
const dispose = TerminalScreen.prototype.dispose
vi.spyOn(TerminalScreen.prototype, 'write').mockImplementation(function (this: InstanceType<typeof TerminalScreen>, data: string, parsedCallback?: () => void) {
  let resolve: () => void = () => undefined
  const done = new Promise<void>((r) => (resolve = r))
  const entry: Pending = {
    screen: this,
    done,
    settle: () => {
      pending.delete(entry)
      resolve()
    }
  }
  pending.add(entry)
  write.call(this, data, () => {
    parsedCallback?.()
    entry.settle()
  })
  // A screen that is already gone takes nothing, and no callback is coming.
  if (!(this as unknown as { term: unknown }).term) entry.settle()
})
vi.spyOn(TerminalScreen.prototype, 'dispose').mockImplementation(function (this: InstanceType<typeof TerminalScreen>) {
  dispose.call(this)
  for (const e of [...pending]) if (e.screen === this) e.settle()
})
afterAll(() => vi.restoreAllMocks())
/** Resolves once everything the terminals were given so far has been parsed (or its screen disposed). */
const parsed = (): Promise<void> => Promise.all([...pending].map((e) => e.done)).then(() => undefined)
/**
 * A screen Codex 0.161 drew, captured from its rendered terminal (tests/fixtures/codex-0.161-*.txt, #363), as output
 * that clears the screen and draws it again: held-working (its input holding /permissions while a turn runs, "tab to
 * queue message"), held-idle (still holding it, free), permissions-readonly (the /permissions menu open).
 */
const draw = (name: string): string =>
  '\x1b[2J\x1b[H' + readFileSync(join(__dirname, 'fixtures', `${name}.txt`), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).join('\r\n')

describe('KeyGate', () => {
  it('the fixture is what it says: the prompt drawn while loading, then the folder over "loading"', () => {
    expect([version, loading, folder, spinner, spinnerEnd].every((i) => i > 0)).toBe(true)
    expect(version < loading && loading < folder && folder < spinner && spinner < spinnerEnd).toBe(true)
    expect(stream.slice(0, folder)).toContain('Ask Codex to do anything')
  })

  it('not ready while Codex loads, wherever its output is split; ready once the folder is written over "loading"', async () => {
    // Every split in and around the header's version and "loading", and in and after the folder's escape sequence.
    const splits = [...Array.from({ length: loading + 9 - version }, (_, i) => version + i), ...Array.from({ length: 16 }, (_, i) => folder - 2 + i), spinner, spinnerEnd]
    for (const k of splits) {
      const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32 })
      gate.feed(stream.slice(0, k))
      await parsed()
      // The folder starts with "~", the 8th character of "\x1b[3;6H~".
      expect({ k, ready: gate.ready }).toEqual({ k, ready: k > folder + 6 })
      gate.feed(stream.slice(k))
      await parsed()
      expect({ k, ready: gate.ready }).toEqual({ k, ready: true })
      gate.dispose()
    }
  })

  it('in one-character pieces too', async () => {
    const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32 })
    for (const c of stream.slice(0, folder + 6)) gate.feed(c)
    await parsed()
    expect(gate.ready).toBe(false)
    for (const c of stream.slice(folder + 6)) gate.feed(c)
    await parsed()
    expect(gate.ready).toBe(true)
  })

  it('idle only from when it is ready, and not while its title shows a spinner', async () => {
    let now = 0
    const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, cols: 120, rows: 32, clock: () => now })
    now = 80
    gate.feed(stream.slice(0, folder))
    await parsed()
    now = 1100
    expect(gate.idleFor()).toBe(0)
    // Loaded late, its spinner with it (a loaded machine).
    now = 1600
    gate.feed(stream.slice(folder, spinner + 30))
    await parsed()
    expect(gate.ready && gate.busy).toBe(true)
    now = 2600
    expect(gate.idleFor()).toBe(0)
    now = 2700
    gate.feed(stream.slice(spinner + 30))
    now = 3200
    expect(gate.busy).toBe(false)
    expect(gate.idleFor()).toBe(500)
  })

  it("busy while its screen shows it holds what was typed, before its title says so (#363), and idle from when that goes", async () => {
    let now = 0
    const gate = new KeyGate({ ready: CODEX_LOADED, busyTitle: BUSY, busyScreen: codexHoldsInput, cols: 120, rows: 32, clock: () => now })
    gate.feed(stream)
    await parsed()
    now = 2000
    expect(gate.ready && !gate.busy).toBe(true)
    // Codex's input holding /permissions while it works ("tab to queue message"), its title still plain.
    now = 2100
    gate.feed(draw('codex-0.161-held-working'))
    await parsed()
    expect(gate.busy).toBe(true)
    now = 4000
    expect(gate.idleFor()).toBe(0)
    expect(gate.settled(500)).toBe(false)
    // Free again: the hint goes (the command still in its input).
    now = 4100
    gate.feed(draw('codex-0.161-held-idle'))
    await parsed()
    now = 4700
    expect(gate.busy).toBe(false)
    expect(gate.idleFor()).toBe(600)
  })
})

describe('runTask: the setup keys go in once Codex has loaded and is idle', () => {
  afterEach(() => {
    vi.useRealTimers()
    pty.open.clear()
    pty.typed.length = 0
  })

  it('none while it loads, however long; then, after its startup spinner, each key in turn', async () => {
    vi.useFakeTimers({ now: 0 })
    const keys = [{ keys: '\x15', waitMs: 150 }, { keys: '/permissions', waitMs: 200 }, { keys: '\r', waitMs: 900 }, { keys: '2', waitMs: 300 }]
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys, ready: CODEX_LOADED, busyTitle: BUSY })
    // Its prompt drawn while loading, the output ending in the middle of "loading".
    pty.onData!(stream.slice(0, loading + 1))
    pty.onData!(stream.slice(loading + 1, folder))
    await vi.advanceTimersByTimeAsync(5000)
    expect(pty.typed).toEqual([])
    // Loaded (the folder over "loading"), and its spinner starts.
    pty.onData!(stream.slice(folder, spinner + 30))
    await vi.advanceTimersByTimeAsync(3000)
    expect(pty.typed).toEqual([])
    // The spinner ends: after a second of idle, the keys go in, one after another.
    const idleAt = Date.now()
    pty.onData!(stream.slice(spinner + 30))
    await vi.advanceTimersByTimeAsync(4000)
    expect(pty.typed.map((t) => t.keys)).toEqual(keys.map((k) => k.keys))
    expect(pty.typed[0].at - idleAt).toBeGreaterThanOrEqual(1000)
  })

  // Codex 0.161 reordered /permissions (#396): the setup task reads the menu Codex draws for "Ask for approval".
  const menu = (codexVersion: string) => readFileSync(join(__dirname, 'fixtures', `codex-${codexVersion}-permissions-readonly.txt`), 'utf8').split('\n').slice(-12).join('\r\n')
  for (const [codexVersion, want] of [['0.161', '1'], ['0.160', '2']]) {
    it(`picks "Ask for approval" from the menu on the screen (Codex ${codexVersion}'s order: ${want})`, async () => {
      vi.useFakeTimers({ now: 0 })
      const { codex } = await import('../src/main/providers/codex/adapter')
      const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
      run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: CODEX_LOADED, busyTitle: BUSY })
      pty.onData!(stream)
      await vi.advanceTimersByTimeAsync(3000)
      // The menu is open; the number isn't typed until it shows.
      expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r'])
      pty.onData!(`\r\n${menu(codexVersion)}`)
      await vi.advanceTimersByTimeAsync(1000)
      expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r', want])
    })
  }

  it('types nothing more when the menu never shows the preset, and says so', async () => {
    vi.useFakeTimers({ now: 0 })
    const { codex } = await import('../src/main/providers/codex/adapter')
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: CODEX_LOADED, busyTitle: BUSY })
    pty.onData!(stream)
    pty.onData!('\r\n  1. Approve for me   Only ask for actions detected as potentially unsafe')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions', '\r'])
  })

  // #363: under load Codex was busy as the setup's keys came, its title's spinner later than the hint on its screen, and
  // /permissions stayed in its input, never run. Codex's screens here are captured from 0.161.
  const setup = async (): Promise<void> => {
    vi.useFakeTimers({ now: 0 })
    const { codex } = await import('../src/main/providers/codex/adapter')
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: CODEX_LOADED, busyTitle: BUSY, busyScreen: codexHoldsInput })
    pty.onData!(stream)
    // Until /permissions has gone in, and no further: its Enter comes 200 ms later.
    for (let ms = 0; ms < 5000 && pty.typed.length < 2; ms += 10) await vi.advanceTimersByTimeAsync(10)
    expect(pty.typed.map((t) => t.keys)).toEqual(['\x15', '/permissions'])
  }
  const typed = (): string[] => pty.typed.map((t) => t.keys)
  /** Until Enter has gone in (n of them), in 10 ms steps, so what Codex draws next comes right after it. */
  const untilEnters = async (n: number): Promise<void> => {
    for (let ms = 0; ms < 60_000 && typed().filter((k) => k === '\r').length < n; ms += 10) await vi.advanceTimersByTimeAsync(10)
  }

  it('holds Enter while Codex shows it holds the command, and sends it once Codex is free', async () => {
    await setup()
    // Codex busy and holding /permissions, its title still plain: Enter waits.
    pty.onData!(draw('codex-0.161-held-working'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typed()).toEqual(['\x15', '/permissions'])
    // Free, the command in its input: Enter, which Codex runs (its menu), then the menu's number.
    pty.onData!(draw('codex-0.161-held-idle'))
    await untilEnters(1)
    pty.onData!(draw('codex-0.161-permissions-readonly'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(typed()).toEqual(['\x15', '/permissions', '\r', '1'])
  })

  it('sends Enter again when Codex was busy as it came and still holds the command once free; never retypes it', async () => {
    await setup()
    // The command in its input, Codex free: Enter goes in. Then Codex shows it was busy and kept the command.
    pty.onData!(draw('codex-0.161-held-idle'))
    await untilEnters(1)
    pty.onData!(draw('codex-0.161-held-working'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typed()).toEqual(['\x15', '/permissions', '\r'])
    // Free, still holding it: Enter again, after a moment for Codex to draw what it did.
    const freeAt = Date.now()
    pty.onData!(draw('codex-0.161-held-idle'))
    await untilEnters(2)
    expect(pty.typed[3].at - freeAt).toBeGreaterThanOrEqual(1500)
    pty.onData!(draw('codex-0.161-permissions-readonly'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(typed()).toEqual(['\x15', '/permissions', '\r', '\r', '1'])
  })

  it('sends Enter only once when Codex took the command: its input cleared, the menu drawn later', async () => {
    await setup()
    pty.onData!(draw('codex-0.161-held-idle'))
    await untilEnters(1)
    // Taken (run, or queued to run when Codex is free): its input no longer holds it, though Codex is still busy.
    pty.onData!(draw('codex-0.161-held-working').replace('› /permissions\r\n', '› Ask Codex to do anything\r\n'))
    await vi.advanceTimersByTimeAsync(5000)
    pty.onData!(draw('codex-0.161-permissions-readonly'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(typed()).toEqual(['\x15', '/permissions', '\r', '1'])
  })

  it('types nothing more into Codex while it stays busy, and stops after 30 seconds saying so', async () => {
    const toasts = vi.spyOn(events, 'toast').mockImplementation(() => undefined as never)
    await setup()
    pty.onData!(draw('codex-0.161-held-working'))
    await vi.advanceTimersByTimeAsync(29_000)
    expect(typed()).toEqual(['\x15', '/permissions'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(typed()).toEqual(['\x15', '/permissions'])
    expect(toasts).toHaveBeenCalledWith('warning', 'Codex setup: Combwork stopped typing into it, as it stayed busy for 30 seconds. Finish it in the terminal.')
    // Free later: still nothing (it stopped).
    pty.onData!(draw('codex-0.161-held-idle'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(typed()).toEqual(['\x15', '/permissions'])
    toasts.mockRestore()
  })

  it('the 30-second start (Codex never shown loaded) types nothing while Codex shows it is busy', async () => {
    vi.useFakeTimers({ now: 0 })
    const { codex } = await import('../src/main/providers/codex/adapter')
    const run = (providerService as unknown as { runTask: (...a: unknown[]) => string }).runTask.bind(providerService)
    run('codex', 'setup', 'codex.exe', [], 'Codex setup', { keys: codex.modeMenuKeys('ask'), ready: /never shown/, busyTitle: BUSY, busyScreen: codexHoldsInput })
    pty.onData!(draw('codex-0.161-held-working'))
    await vi.advanceTimersByTimeAsync(45_000)
    expect(typed()).toEqual([])
  })

  it('sends Enter at most three times in all while Codex holds the command, then stops, choosing nothing', async () => {
    await setup()
    pty.onData!(draw('codex-0.161-held-idle'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(typed()).toEqual(['\x15', '/permissions', '\r', '\r', '\r'])
  })
})
