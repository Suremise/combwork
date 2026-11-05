// Open External Terminal Here (#1103 round 1): the terminal it starts gets the folders of the CLIs Combwork found, as
// sessions do, so `claude` found off PATH (Claude Code's native install in ~\.local\bin) runs in it by name; Combwork's own
// PATH stays as it is. Windows Terminal, its cmd fallback and the system terminal elsewhere. Spawn is intercepted: no
// terminal is opened and nothing of the user's environment changes.
import { delimiter } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openExternalTerminal } from '../src/main/externalTerminal'
import { noteCliFolder } from '../src/main/freshPath'

const exe = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin\claude.exe` : '/home/someone/.local/bin/claude'
const folder = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin` : '/home/someone/.local/bin'

interface Call {
  file: string
  args: string[]
  cwd?: string
  path: string
}

/** A spawn that records each call; `refuse` names programs it can't start (as spawn throws for a missing one). */
function fakeSpawn(refuse: string[] = []): { calls: Call[]; spawn: never } {
  const calls: Call[] = []
  const spawn = (file: string, args: string[], opts: { cwd?: string; env: Record<string, string> }) => {
    const key = Object.keys(opts.env).find((k) => k.toUpperCase() === 'PATH')!
    calls.push({ file, args, cwd: opts.cwd, path: opts.env[key] })
    if (refuse.includes(file)) throw new Error(`spawn ${file} ENOENT`)
    return { on: () => undefined, unref: () => undefined }
  }
  return { calls, spawn: spawn as never }
}

const pathOf = (): string => process.env[Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? ''

describe('Open External Terminal Here (#1103)', () => {
  afterEach(() => noteCliFolder('claude-code', null))

  it("Windows Terminal gets the found CLI's folder at the end of its PATH; Combwork's own PATH stays as it is", () => {
    noteCliFolder('claude-code', exe)
    const own = pathOf()
    const { calls, spawn } = fakeSpawn()
    expect(openExternalTerminal('C:\\work\\demo', spawn, 'win32')).toBe('wt')
    expect(calls.map((c) => c.file)).toEqual(['wt.exe'])
    expect(calls[0].args).toEqual(['-d', '"C:\\work\\demo"'])
    expect(calls[0].path.split(delimiter).at(-1)).toBe(folder)
    expect(calls[0].path.startsWith(own)).toBe(true)
    expect(pathOf()).toBe(own)
  })

  it('its cmd fallback gets it too, in the folder', () => {
    noteCliFolder('claude-code', exe)
    const { calls, spawn } = fakeSpawn(['wt.exe'])
    expect(openExternalTerminal('C:\\work\\demo', spawn, 'win32')).toBe('cmd')
    expect(calls.map((c) => c.file)).toEqual(['wt.exe', 'cmd.exe'])
    // Its arguments joined: the start command, as Combwork has always run the fallback (never run here).
    expect(calls[1].args.join(' ')).toBe('/c start cmd.exe')
    expect(calls[1].cwd).toBe('C:\\work\\demo')
    expect(calls[1].path.split(delimiter).at(-1)).toBe(folder)
  })

  it("elsewhere the system's terminal; with no CLI found off PATH, the PATH is Combwork's", () => {
    const { calls, spawn } = fakeSpawn()
    expect(openExternalTerminal('/work/demo', spawn, 'linux')).toBe('x-terminal-emulator')
    expect(calls[0]).toMatchObject({ file: 'x-terminal-emulator', cwd: '/work/demo', path: pathOf() })
    const none = fakeSpawn(['x-terminal-emulator'])
    expect(openExternalTerminal('/work/demo', none.spawn, 'linux')).toBeNull()
  })
})
