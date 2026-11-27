// Open External Terminal Here (#1103 round 1): the terminal it starts gets the folders of the CLIs Combwork found, as
// sessions do, so `claude` found off PATH (Claude Code's native install in ~\.local\bin) runs in it by name; Combwork's own
// PATH stays as it is. HI-3582: the External terminal setting chooses Windows Terminal, Command Prompt or PowerShell
// (Automatic: Windows Terminal, else Command Prompt); whether one opened is judged by its own start (an error, or an exit
// that isn't 0, before SETTLE_MS), not a shell's, so a wt.exe on the PATH that opens nothing falls back, and a terminal
// that can't open says which and why. Spawn is intercepted: no terminal is opened and nothing of the user's environment
// changes.
import { EventEmitter } from 'events'
import { delimiter } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IN_WINDOW, SETTLE_MS, openExternalTerminal } from '../src/main/externalTerminal'
import { CombworkError } from '../src/main/combworkError'
import { noteCliFolder } from '../src/main/freshPath'
import { externalTerminalSetting } from '../src/shared/externalTerminal'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'

const exe = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin\claude.exe` : '/home/someone/.local/bin/claude'
const folder = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin` : '/home/someone/.local/bin'

interface Call {
  file: string
  args: string[]
  cwd?: string
  path: string
  shell: unknown
  detached: unknown
}

/**
 * How a program behaves when started: it opens and its launcher ends (0, as wt.exe and `cmd /c start` do), it ends with
 * another code, it keeps running, spawn emits an error (a stale app alias: Windows can't run the file) or throws.
 */
type Behaviour = { exit: number } | 'running' | { error: string } | 'throws'

/** A spawn that records each call and acts out each program's behaviour (by file name's end); unnamed ones open. */
function fakeSpawn(behaviour: Record<string, Behaviour> = {}): { calls: Call[]; spawn: never } {
  const calls: Call[] = []
  const spawn = (file: string, args: string[], opts: { cwd?: string; env: Record<string, string>; shell?: unknown; detached?: unknown }) => {
    const key = Object.keys(opts.env).find((k) => k.toUpperCase() === 'PATH')!
    calls.push({ file, args, cwd: opts.cwd, path: opts.env[key], shell: opts.shell, detached: opts.detached })
    const how = Object.entries(behaviour).find(([name]) => file.toLowerCase().endsWith(name))?.[1] ?? { exit: 0 }
    if (how === 'throws') throw new Error(`spawn ${file} EINVAL`)
    const child = Object.assign(new EventEmitter(), { unref: () => undefined })
    process.nextTick(() => {
      if (typeof how === 'object' && 'error' in how) return void child.emit('error', new Error(how.error))
      child.emit('spawn')
      if (how !== 'running') child.emit('exit', how.exit)
    })
    return child
  }
  return { calls, spawn: spawn as never }
}

const allThere = async (): Promise<boolean> => true
const pathOf = (): string => process.env[Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? ''

/** The error's English. */
async function failure(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (err: unknown) => err
  )
  expect(e).toBeInstanceOf(CombworkError)
  return (e as Error).message
}

describe('Open External Terminal Here (#1103, HI-3582)', () => {
  afterEach(() => {
    noteCliFolder('claude-code', null)
    vi.useRealTimers()
  })

  it("Windows Terminal gets the found CLI's folder at the end of its PATH; Combwork's own PATH stays as it is", async () => {
    noteCliFolder('claude-code', exe)
    const own = pathOf()
    const { calls, spawn } = fakeSpawn()
    expect(await openExternalTerminal('C:\\work\\demo', 'auto', spawn, 'win32', allThere)).toBe('wt')
    expect(calls.map((c) => c.file)).toEqual(['wt.exe'])
    // No shell: a shell starts whether or not wt.exe can (HI-3582). Node quotes the folder itself.
    expect(calls[0]).toMatchObject({ args: ['-d', 'C:\\work\\demo'], shell: undefined, detached: true })
    expect(calls[0].path.split(delimiter).at(-1)).toBe(folder)
    expect(calls[0].path.startsWith(own)).toBe(true)
    expect(pathOf()).toBe(own)
  })

  it("a ; in the folder's name is escaped for wt, which would split its command line there", async () => {
    const { calls, spawn } = fakeSpawn()
    await openExternalTerminal('C:\\work\\a;b', 'wt', spawn, 'win32', allThere)
    expect(calls[0].args).toEqual(['-d', 'C:\\work\\a\\;b'])
  })

  it('Windows Terminal still running when it settles has opened', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, spawn } = fakeSpawn({ 'wt.exe': 'running' })
    const opened = openExternalTerminal('C:\\work\\demo', 'auto', spawn, 'win32', allThere)
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(await opened).toBe('wt')
    expect(calls.map((c) => c.file)).toEqual(['wt.exe'])
  })

  for (const [what, wt] of [
    ['a stale wt.exe app alias (Windows can\'t run it)', { error: 'spawn wt.exe UNKNOWN' }],
    ['no wt.exe at all', { error: 'spawn wt.exe ENOENT' }],
    ['a wt.exe that ends at once with an error', { exit: 1 }],
    ['a spawn that throws', 'throws']
  ] as [string, Behaviour][]) {
    it(`Automatic falls back to Command Prompt, in the folder, with the CLI folders: ${what}`, async () => {
      noteCliFolder('claude-code', exe)
      const { calls, spawn } = fakeSpawn({ 'wt.exe': wt })
      expect(await openExternalTerminal('C:\\work\\demo', 'auto', spawn, 'win32', allThere)).toBe('cmd')
      expect(calls).toHaveLength(2)
      const cmd = calls[1]
      expect(cmd.file.toLowerCase().endsWith('cmd.exe')).toBe(true)
      // In a window of its own, titled by an empty first argument (never run here).
      expect(cmd.args.slice(0, IN_WINDOW.length)).toEqual(IN_WINDOW)
      expect(cmd.args[3].toLowerCase().endsWith('cmd.exe')).toBe(true)
      expect(cmd).toMatchObject({ cwd: 'C:\\work\\demo', shell: undefined })
      expect(cmd.path.split(delimiter).at(-1)).toBe(folder)
    })
  }

  it('Command Prompt chosen opens it, never trying Windows Terminal', async () => {
    const { calls, spawn } = fakeSpawn()
    expect(await openExternalTerminal('C:\\work\\demo', 'cmd', spawn, 'win32', allThere)).toBe('cmd')
    expect(calls).toHaveLength(1)
    expect(calls[0].args[3].toLowerCase().endsWith('cmd.exe')).toBe(true)
  })

  it('PowerShell chosen opens Windows PowerShell in the folder', async () => {
    const { calls, spawn } = fakeSpawn()
    expect(await openExternalTerminal('C:\\work\\demo', 'powershell', spawn, 'win32', allThere)).toBe('powershell')
    expect(calls).toHaveLength(1)
    expect(calls[0].file.toLowerCase().endsWith('cmd.exe')).toBe(true)
    expect(calls[0].args[3].toLowerCase()).toMatch(/windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/)
    expect(calls[0].cwd).toBe('C:\\work\\demo')
  })

  it("Windows Terminal chosen that can't open says so, and opens nothing else", async () => {
    const { calls, spawn } = fakeSpawn({ 'wt.exe': { error: 'spawn wt.exe UNKNOWN' } })
    expect(await failure(openExternalTerminal('C:\\work\\demo', 'wt', spawn, 'win32', allThere))).toBe("Windows Terminal didn't open: spawn wt.exe UNKNOWN")
    expect(calls.map((c) => c.file)).toEqual(['wt.exe'])
    const ended = fakeSpawn({ 'wt.exe': { exit: 2 } })
    expect(await failure(openExternalTerminal('C:\\work\\demo', 'wt', ended.spawn, 'win32', allThere))).toBe("Windows Terminal didn't open: it ended at once with exit code 2")
  })

  it("PowerShell chosen that isn't there says where it looked, and starts nothing", async () => {
    const { calls, spawn } = fakeSpawn()
    const noPowerShell = async (p: string): Promise<boolean> => !p.toLowerCase().endsWith('powershell.exe')
    const text = await failure(openExternalTerminal('C:\\work\\demo', 'powershell', spawn, 'win32', noPowerShell))
    expect(text).toMatch(/^PowerShell didn't open: .*powershell\.exe isn't there$/)
    expect(calls).toEqual([])
  })

  it('Automatic with neither opening says why Command Prompt, the last, did not', async () => {
    const { calls, spawn } = fakeSpawn({ 'wt.exe': { error: 'spawn wt.exe ENOENT' }, 'cmd.exe': { exit: 1 } })
    expect(await failure(openExternalTerminal('C:\\work\\demo', 'auto', spawn, 'win32', allThere))).toBe("Command Prompt didn't open: it ended at once with exit code 1")
    expect(calls).toHaveLength(2)
  })

  it('an error after it settled is listened to, not thrown', async () => {
    const children: EventEmitter[] = []
    const spawn = ((..._args: unknown[]) => {
      const child = Object.assign(new EventEmitter(), { unref: () => undefined })
      children.push(child)
      process.nextTick(() => {
        child.emit('spawn')
        child.emit('exit', 0)
      })
      return child
    }) as never
    expect(await openExternalTerminal('C:\\work\\demo', 'auto', spawn, 'win32', allThere)).toBe('wt')
    expect(() => children[0].emit('error', new Error('late'))).not.toThrow()
  })

  it("elsewhere the system's terminal; with no CLI found off PATH, the PATH is Combwork's", async () => {
    const { calls, spawn } = fakeSpawn()
    expect(await openExternalTerminal('/work/demo', 'auto', spawn, 'linux', allThere)).toBe('x-terminal-emulator')
    expect(calls[0]).toMatchObject({ file: 'x-terminal-emulator', cwd: '/work/demo', path: pathOf() })
    const none = fakeSpawn({ 'x-terminal-emulator': { error: 'spawn x-terminal-emulator ENOENT' } })
    expect(await failure(openExternalTerminal('/work/demo', 'auto', none.spawn, 'linux', allThere))).toBe("x-terminal-emulator didn't open: spawn x-terminal-emulator ENOENT")
  })

  it('the setting is Automatic by default, and for a value it does not know', () => {
    expect(DEFAULT_SETTINGS.general.externalTerminal).toBe('auto')
    expect(externalTerminalSetting('powershell')).toBe('powershell')
    expect(externalTerminalSetting('bash')).toBe('auto')
    expect(externalTerminalSetting(undefined)).toBe('auto')
  })
})
