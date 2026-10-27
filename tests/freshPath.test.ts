// A CLI installed while Hive runs (#472): Hive adds the registry PATH's new folders to its own before it looks for the
// CLIs, so the install is found without a restart. The registry is stubbed (HIVE_TEST_REGISTRY_PATH): this test
// never reads the machine's.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandVars, noteCliFolder, withCliFolders, mergePath, parseRegQuery, pathFolders, refreshPath, refreshPathBeforeStart, testRegistryPath } from '../src/main/freshPath'

// The longest a wait here waits: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000

// The registry reads (PowerShell, reg.exe) are held until a test answers them: only the slow-read test makes one.
const held = vi.hoisted(() => [] as ((err: Error | null, stdout: string) => void)[])
vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    held.push(cb)
  }
}))

const saved = { ...process.env }

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

describe('mergePath', () => {
  it("adds only the folders Hive's PATH doesn't have, after its own, in order", () => {
    const r = mergePath('C:\\Windows;C:\\Tools', ['C:\\Windows', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links', 'C:\\New'], ';')
    expect(r.value).toBe('C:\\Windows;C:\\Tools;C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\New')
    expect(r.added).toEqual(['C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links', 'C:\\New'])
  })

  it('compares folders in any case, with or without quotes and a trailing slash', () => {
    const r = mergePath('"C:\\Program Files\\Git\\cmd";c:\\tools\\', ['C:\\Program Files\\Git\\cmd\\', 'C:\\TOOLS', 'c:\\tools'], ';')
    expect(r.added).toEqual([])
    expect(r.value).toBe('"C:\\Program Files\\Git\\cmd";c:\\tools\\')
  })

  it('adds a folder once, and keeps a PATH ending in a separator tidy', () => {
    const r = mergePath('C:\\A;', ['C:\\B', 'c:\\b\\'], ';')
    expect(r.value).toBe('C:\\A;C:\\B')
    expect(r.added).toEqual(['C:\\B'])
  })

  it('fills an empty PATH', () => {
    expect(mergePath('', ['C:\\A'], ';').value).toBe('C:\\A')
  })
})

describe('reading the registry', () => {
  it('expands %VARS% from the environment, in any case, leaving unknown ones', () => {
    expect(expandVars('%USERPROFILE%\\.local\\bin;%nope%', { UserProfile: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\.local\\bin;%nope%')
  })

  it("lists a PATH value's folders, without empty entries or ones naming a variable it couldn't expand", () => {
    expect(pathFolders(' C:\\A ;;%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin;%MISSING%\\bin;', { LOCALAPPDATA: 'C:\\L' })).toEqual(['C:\\A', 'C:\\L\\Programs\\OpenAI\\Codex\\bin'])
  })

  it("reads reg.exe's answer, REG_SZ or REG_EXPAND_SZ", () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools\r\n\r\n'
    expect(parseRegQuery(out)).toBe('%USERPROFILE%\\bin;C:\\Tools')
    expect(parseRegQuery('\r\nHKEY_LOCAL_MACHINE\\...\r\n    Path    REG_SZ    C:\\Windows\r\n')).toBe('C:\\Windows')
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toBe('')
  })
})

describe('test copies', () => {
  it("never read the machine's registry: the suite's stand-in, else none with a test profile", () => {
    expect(testRegistryPath({ HIVE_TEST_REGISTRY_PATH: 'C:\\X' }, false)).toBe('C:\\X')
    expect(testRegistryPath({ HIVE_USER_DATA: 'C:\\p' }, false)).toBe('')
    expect(testRegistryPath({}, false)).toBeUndefined()
    expect(testRegistryPath({ HIVE_TEST_REGISTRY_PATH: 'C:\\X', HIVE_USER_DATA: 'C:\\p' }, true)).toBeUndefined()
  })
})

describe.runIf(process.platform === 'win32')('refreshPath', () => {
  it("adds what an installer put in the registry to Hive's PATH, so where.exe and new sessions find the CLI", async () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[key] = 'C:\\Windows'
    process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local'
    process.env.HIVE_TEST_REGISTRY_PATH = 'C:\\Windows;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links'
    expect(await refreshPath()).toEqual(['C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links'])
    expect(process.env[key]).toBe('C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links')
    // Nothing new the next time.
    expect(await refreshPath()).toEqual([])
    expect(process.env[key]).toBe('C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links')
  })

  it('shares one read between calls at the same time', async () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[key] = 'C:\\Windows'
    process.env.HIVE_TEST_REGISTRY_PATH = 'C:\\New'
    const [a, b] = await Promise.all([refreshPath(), refreshPath()])
    expect(a).toEqual(['C:\\New'])
    expect(b).toEqual(['C:\\New'])
    expect(process.env[key]).toBe('C:\\Windows;C:\\New')
  })
})

// Before Hive starts an agent or a terminal (#821): the PATH a new process gets, with what was installed since Hive
// started, and never a long wait for it.
describe.runIf(process.platform === 'win32')('refreshPathBeforeStart', () => {
  it('gives the next process the folders added to the registry since Hive started', async () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[key] = 'C:\\Windows'
    process.env.HIVE_TEST_REGISTRY_PATH = 'C:\\Windows'
    await refreshPathBeforeStart()
    expect(process.env[key]).toBe('C:\\Windows')
    // An installer adds a folder while Hive runs.
    process.env.HIVE_TEST_REGISTRY_PATH = 'C:\\Windows;C:\\Installed'
    await refreshPathBeforeStart()
    expect(process.env[key]).toBe('C:\\Windows;C:\\Installed')
  })

  it("goes on with Hive's PATH when the registry is slow, and the read still counts once it ends", async () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    process.env[key] = 'C:\\Windows'
    delete process.env.HIVE_TEST_REGISTRY_PATH
    delete process.env.HIVE_USER_DATA
    held.length = 0
    // The registry isn't answering: the start goes on after its wait, with the PATH as it was.
    await refreshPathBeforeStart(20)
    expect(process.env[key]).toBe('C:\\Windows')
    expect(held).toHaveLength(1)
    // PowerShell answers late: its folders are on Hive's PATH for the next start.
    held[0](null, 'M=C:\\Windows\r\nU=C:\\Late\r\n')
    await vi.waitFor(() => expect(process.env[key]).toBe('C:\\Windows;C:\\Late'), { timeout: HUNG_MS })
  })
})

// #1103: Claude Code's native installer can leave ~\.local\bin off every PATH (the registry's too), so Provider Setup
// found the CLI where it installs it while the sessions and terminals Hive starts couldn't run it by name.
describe("a found CLI's folder on the PATH of what Hive starts (#1103)", () => {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exe = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin\claude.exe` : '/home/someone/.local/bin/claude'
  const folder = process.platform === 'win32' ? String.raw`C:\Users\someone\.local\bin` : '/home/someone/.local/bin'
  afterEach(() => noteCliFolder('test-cli', null))

  it("adds its folder at the end of a child's PATH, once, keeping the rest in its order; Hive's own PATH stays as it is", () => {
    const own = process.env.PATH
    noteCliFolder('test-cli', exe)
    expect(withCliFolders(['A', 'B'].join(sep))).toBe(['A', 'B', folder].join(sep))
    expect(withCliFolders(withCliFolders(['A', 'B'].join(sep)))).toBe(['A', 'B', folder].join(sep))
    expect(process.env.PATH).toBe(own)
  })

  it('leaves PATH as it is when it has the folder already, however it is written', () => {
    noteCliFolder('test-cli', exe)
    const written = process.platform === 'win32' ? `"${folder.toUpperCase()}\\"` : `${folder}/`
    expect(withCliFolders([written, 'A'].join(sep))).toBe([written, 'A'].join(sep))
  })

  it('follows the provider: a CLI found elsewhere replaces its folder, one no longer found drops it', () => {
    noteCliFolder('test-cli', exe)
    const other = process.platform === 'win32' ? String.raw`D:\Tools\claude.exe` : '/opt/tools/claude'
    noteCliFolder('test-cli', other)
    expect(withCliFolders('A')).toBe(['A', process.platform === 'win32' ? String.raw`D:\Tools` : '/opt/tools'].join(sep))
    noteCliFolder('test-cli', null)
    expect(withCliFolders('A')).toBe('A')
  })
})
