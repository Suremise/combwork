// HI-2729: Provider Setup offers only an update the install's own source can deliver. A WinGet install (Copilot, Claude
// Code, Codex) is compared with what WinGet has, never npm's or GitHub's newer release, and updated by WinGet; WinGet's
// "nothing newer" exit isn't a failure; Claude Code's other installs follow the channel `claude update` does, managed
// settings first. Every source is stubbed: no winget, reg, npm or network runs here, and nothing of this PC's is read.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWingetPath, parseWingetVersion, wingetShowArgs, wingetUpToDate, wingetVersion } from '../src/main/providers/winget'
import { managedFiles, parseRegSettings, resolveUpdateChannel, windowsChannelSources, type ChannelSources, type ManagedDoc } from '../src/main/providers/claude/updateChannel'
import { tempDir } from './tempDir'

const LINKS = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links'
const WINGET_EXE = `${LINKS}\\copilot.exe`
const NPM_CMD = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd'
const SHOW = readFileSync(join(__dirname, 'fixtures', 'advanced', 'winget-show-copilot-1.29.380.txt'), 'utf8')

type RunReply = { stdout: string; stderr: string; code: number; ended?: true }

afterEach(() => {
  vi.doUnmock('../src/main/plainHttpsJson')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('WinGet’s version of a package', () => {
  it('reads the version off `winget show` (recorded with WinGet 1.29.380), whatever language its field names are in', () => {
    expect(parseWingetVersion(SHOW)).toBe('1.0.106')
    expect(parseWingetVersion(SHOW.replace(/\n/g, '\r\n'))).toBe('1.0.106')
    expect(parseWingetVersion('Gefunden GitHub Copilot CLI [GitHub.Copilot]\nVersion: 1.0.107-1\nHerausgeber: GitHub, Inc.\n')).toBe('1.0.107-1')
    expect(parseWingetVersion('Trouvé GitHub Copilot CLI [GitHub.Copilot]\nVersion : 1.0.106\n')).toBe('1.0.106')
    expect(parseWingetVersion('見つかりました GitHub Copilot CLI [GitHub.Copilot]\nバージョン: 1.0.106\n')).toBe('1.0.106')
    expect(parseWingetVersion('No package found matching input criteria.\r\n')).toBeNull()
    expect(parseWingetVersion('')).toBeNull()
  })

  it('reads it with the pattern Settings → Advanced gives (its first group, else what it finds)', () => {
    expect(parseWingetVersion('Release 2.0.1 ready', /Release (\S+)/)).toBe('2.0.1')
    expect(parseWingetVersion('v3.1.4', /\d+\.\d+\.\d+/)).toBe('3.1.4')
    expect(parseWingetVersion(SHOW, /^Nothing like this$/m)).toBeNull()
  })

  it('asks the winget source only, within Settings → Advanced’s time, and answers null when WinGet fails, times out or says nothing', async () => {
    const calls: { file: string; args: string[]; timeoutMs?: number }[] = []
    let reply: RunReply = { stdout: SHOW, stderr: '', code: 0 }
    const run = async (file: string, args: string[], timeoutMs?: number): Promise<RunReply> => {
      calls.push({ file, args, timeoutMs })
      return reply
    }
    expect(await wingetVersion('GitHub.Copilot', run)).toBe('1.0.106')
    expect(calls).toEqual([{ file: 'winget.exe', args: wingetShowArgs('GitHub.Copilot'), timeoutMs: 30_000 }])
    expect(calls[0].args).toEqual(expect.arrayContaining(['show', '--exact', '--source', 'winget', '--disable-interactivity']))
    expect(calls[0].args).not.toContain('upgrade')
    reply = { stdout: '', stderr: '', code: -1978335212 }
    expect(await wingetVersion('GitHub.Copilot', run)).toBeNull()
    reply = { stdout: SHOW, stderr: '', code: 1, ended: true }
    expect(await wingetVersion('GitHub.Copilot', run)).toBeNull()
    reply = { stdout: 'Found GitHub Copilot CLI [GitHub.Copilot]\n', stderr: '', code: 0 }
    expect(await wingetVersion('GitHub.Copilot', run)).toBeNull()
  })

  it('knows its "no newer version" exit in either HRESULT form, and nothing else', () => {
    expect(wingetUpToDate(-1978335189)).toBe(true)
    expect(wingetUpToDate(0x8a15002b)).toBe(true)
    expect(wingetUpToDate(-1978335145)).toBe(false) // 0x8A150057, the portable uninstall failure (#1101)
    expect(wingetUpToDate(0)).toBe(false)
    expect(wingetUpToDate(1)).toBe(false)
  })

  it('knows a copy WinGet installed by its folder', () => {
    expect(isWingetPath(WINGET_EXE)).toBe(true)
    expect(isWingetPath('C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe')).toBe(true)
    expect(isWingetPath(NPM_CMD)).toBe(false)
    expect(isWingetPath('C:\\Users\\me\\.local\\bin\\claude.exe')).toBe(false)
    expect(isWingetPath('C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')).toBe(false)
  })
})

/** npm's and GitHub's replies stubbed; the URLs asked are kept. */
async function withRegistry(reply: Record<string, unknown>): Promise<string[]> {
  vi.resetModules()
  const urls: string[] = []
  vi.doMock('../src/main/plainHttpsJson', () => ({
    plainHttpsJson: async (url: string) => {
      urls.push(url)
      return reply
    }
  }))
  return urls
}

describe('Copilot’s latest version, by install kind', () => {
  it('compares a WinGet install with WinGet’s version, never npm’s newer one', async () => {
    const urls = await withRegistry({ version: '1.0.107' })
    const install = await import('../src/main/providers/copilot/install')
    const asked: string[] = []
    const winget = async (id: string): Promise<string | null> => {
      asked.push(id)
      return '1.0.106'
    }
    expect(await install.copilotLatestVersion(WINGET_EXE, winget)).toBe('1.0.106')
    expect(await install.copilotLatestVersion(WINGET_EXE.replace('Links\\copilot.exe', 'Packages\\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe\\copilot.exe'), winget)).toBe('1.0.106')
    expect(asked).toEqual(['GitHub.Copilot', 'GitHub.Copilot'])
    expect(urls).toEqual([])
    // WinGet unable to say: no version, so no Update and no "Up to date".
    expect(await install.copilotLatestVersion(WINGET_EXE, async () => null)).toBeNull()
  })

  it('compares an npm install, or one whose installer isn’t known, with npm', async () => {
    const urls = await withRegistry({ version: '1.0.107' })
    const install = await import('../src/main/providers/copilot/install')
    const winget = vi.fn(async () => '1.0.106')
    expect(await install.copilotLatestVersion(NPM_CMD, winget)).toBe('1.0.107')
    expect(await install.copilotLatestVersion('D:\\tools\\copilot.exe', winget)).toBe('1.0.107')
    expect(await install.copilotLatestVersion(null, winget)).toBe('1.0.107')
    expect(winget).not.toHaveBeenCalled()
    expect(urls).toHaveLength(3)
  })

  it('offers Update to a WinGet install only once WinGet has a newer version', async () => {
    await withRegistry({ version: '1.0.107' })
    const install = await import('../src/main/providers/copilot/install')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const offered = async (wingetHas: string): Promise<boolean> => {
      const latest = await install.copilotLatestVersion(WINGET_EXE, async () => wingetHas)
      return !!latest && copilot.isNewer(latest, '1.0.106')
    }
    expect(await offered('1.0.106')).toBe(false)
    expect(await offered('1.0.107')).toBe(true)
  })

  it('takes WinGet’s "no newer version" as up to date for a WinGet install only', async () => {
    const install = await import('../src/main/providers/copilot/install')
    expect(install.copilotUpdateUpToDate(WINGET_EXE, -1978335189)).toBe(true)
    expect(install.copilotUpdateUpToDate(WINGET_EXE, 1)).toBe(false)
    expect(install.copilotUpdateUpToDate(NPM_CMD, -1978335189)).toBe(false)
    // The portable uninstall failure stays a failure, with its explicit retry (#1101).
    expect(install.copilotUpdateUpToDate(WINGET_EXE, -1978335145)).toBe(false)
    expect(install.copilotUpdateRetry(WINGET_EXE, -1978335189)).toBeNull()
  })
})

describe('Claude Code’s and Codex’s latest version and update, by install kind', () => {
  const CLAUDE_WINGET = `${LINKS}\\claude.exe`
  const CLAUDE_NATIVE = 'C:\\Users\\me\\.local\\bin\\claude.exe'
  const CLAUDE_NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
  const CODEX_WINGET = `${LINKS}\\codex.exe`
  const CODEX_STANDALONE = 'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
  const CODEX_NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'

  it('compares a WinGet Claude Code with WinGet, and updates it with WinGet, not `claude update` (which leaves it as it is)', async () => {
    const urls = await withRegistry({ stable: '2.1.311', latest: '2.1.319' })
    const { claudeCode, claudeLatestVersion, CLAUDE_WINGET_ID } = await import('../src/main/providers/claude/adapter')
    const asked: string[] = []
    const winget = async (id: string): Promise<string | null> => {
      asked.push(id)
      return '2.1.317'
    }
    const channel = vi.fn(async () => 'latest' as const)
    expect(await claudeLatestVersion(CLAUDE_WINGET, { winget, channel })).toBe('2.1.317')
    expect(asked).toEqual([CLAUDE_WINGET_ID])
    expect(CLAUDE_WINGET_ID).toBe('Anthropic.ClaudeCode')
    expect(channel).not.toHaveBeenCalled()
    expect(urls).toEqual([])
    expect(await claudeLatestVersion(CLAUDE_WINGET, { winget: async () => null, channel })).toBeNull()
    expect(claudeCode.updateCommand(CLAUDE_WINGET)).toEqual({ file: 'winget.exe', args: ['upgrade', '--id', 'Anthropic.ClaudeCode', '--exact', '--source', 'winget'] })
    expect(claudeCode.updateUpToDate(CLAUDE_WINGET, -1978335189)).toBe(true)
    expect(claudeCode.updateUpToDate(CLAUDE_WINGET, 1)).toBe(false)
  })

  it('compares a native or npm Claude Code with npm’s tag of its channel, and updates it with `claude update`', async () => {
    const urls = await withRegistry({ stable: '2.1.311', latest: '2.1.319', next: '2.1.319' })
    const { claudeCode, claudeLatestVersion } = await import('../src/main/providers/claude/adapter')
    const winget = vi.fn(async () => '2.1.317')
    for (const exe of [CLAUDE_NATIVE, CLAUDE_NPM, null]) {
      expect(await claudeLatestVersion(exe, { winget, channel: async () => 'stable' })).toBe('2.1.311')
      expect(await claudeLatestVersion(exe, { winget, channel: async () => 'latest' })).toBe('2.1.319')
      // A channel that can't be told: no version, rather than latest's.
      expect(await claudeLatestVersion(exe, { winget, channel: async () => null })).toBeNull()
    }
    expect(winget).not.toHaveBeenCalled()
    expect(new Set(urls)).toEqual(new Set(['https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags']))
    expect(claudeCode.updateCommand(CLAUDE_NATIVE)).toEqual({ file: CLAUDE_NATIVE, args: ['update'] })
    expect(claudeCode.updateUpToDate(CLAUDE_NATIVE, -1978335189)).toBe(false)
  })

  it('answers no version when npm has no tag for the channel, never latest’s in its place', async () => {
    await withRegistry({ latest: '2.1.319' })
    const { claudeLatestVersion } = await import('../src/main/providers/claude/adapter')
    expect(await claudeLatestVersion(CLAUDE_NATIVE, { channel: async () => 'stable' })).toBeNull()
    expect(await claudeLatestVersion(CLAUDE_NATIVE, { channel: async () => 'latest' })).toBe('2.1.319')
  })

  it('compares a WinGet Codex with WinGet and updates it with WinGet; a standalone or npm one with GitHub and `codex update`', async () => {
    const urls = await withRegistry({ tag_name: 'rust-v0.167.0' })
    const { codex, CODEX_WINGET_ID } = await import('../src/main/providers/codex/adapter')
    const asked: string[] = []
    const winget = async (id: string): Promise<string | null> => {
      asked.push(id)
      return '0.166.0'
    }
    expect(CODEX_WINGET_ID).toBe('OpenAI.Codex')
    expect(await codex.latestVersion(CODEX_WINGET, winget)).toBe('0.166.0')
    expect(asked).toEqual(['OpenAI.Codex'])
    expect(urls).toEqual([])
    expect(codex.updateCommand(CODEX_WINGET)).toEqual({ file: 'winget.exe', args: ['upgrade', '--id', 'OpenAI.Codex', '--exact', '--source', 'winget'] })
    expect(codex.updateUpToDate(CODEX_WINGET, -1978335189)).toBe(true)
    for (const exe of [CODEX_STANDALONE, CODEX_NPM, null]) expect(await codex.latestVersion(exe, winget)).toBe('0.167.0')
    expect(asked).toHaveLength(1)
    expect(codex.updateCommand(CODEX_STANDALONE).args).toContain('update')
    expect(codex.updateCommand(CODEX_STANDALONE).file).not.toBe('winget.exe')
    expect(codex.updateUpToDate(CODEX_STANDALONE, -1978335189)).toBe(false)
  })
})

describe('the channel `claude update` follows', () => {
  const read = (settings: Record<string, unknown>): ManagedDoc => ({ state: 'read', settings })
  const ABSENT: ManagedDoc = { state: 'absent' }
  const UNREADABLE: ManagedDoc = { state: 'unreadable' }
  const sources = (s: Partial<Record<keyof ChannelSources, ManagedDoc>>): ChannelSources => ({
    hklm: async () => s.hklm ?? ABSENT,
    files: async () => s.files ?? ABSENT,
    hkcu: async () => s.hkcu ?? ABSENT,
    user: async () => s.user ?? ABSENT
  })
  const channel = (s: Partial<Record<keyof ChannelSources, ManagedDoc>>, field = 'autoUpdatesChannel'): Promise<string | null> => resolveUpdateChannel(sources(s), field)
  const STABLE = { autoUpdatesChannel: 'stable' }
  const LATEST = { autoUpdatesChannel: 'latest' }

  it('is the user’s setting with no managed one, latest when unset, and unknown when it can’t be read or isn’t a channel', async () => {
    expect(await channel({})).toBe('latest')
    expect(await channel({ user: read({ theme: 'dark' }) })).toBe('latest')
    expect(await channel({ user: read(STABLE) })).toBe('stable')
    expect(await channel({ user: read(LATEST) })).toBe('latest')
    expect(await channel({ user: UNREADABLE })).toBeNull()
    expect(await channel({ user: read({ autoUpdatesChannel: 'nightly' }) })).toBeNull()
  })

  it('is a managed source’s over the user’s, either way round', async () => {
    expect(await channel({ files: read(STABLE), user: read(LATEST) })).toBe('stable')
    expect(await channel({ files: read(LATEST), user: read(STABLE) })).toBe('latest')
    expect(await channel({ hklm: read(STABLE), user: read(LATEST) })).toBe('stable')
    expect(await channel({ hkcu: read(STABLE), user: read(LATEST) })).toBe('stable')
  })

  it('takes the first managed source with a policy key whole, and the user’s when that one sets no channel', async () => {
    // HKLM outranks the files.
    expect(await channel({ hklm: read(LATEST), files: read(STABLE) })).toBe('latest')
    // First-wins: HKLM with another policy key hides the files' channel; the user's decides.
    expect(await channel({ hklm: read({ cleanupPeriodDays: 30 }), files: read(STABLE), user: read(LATEST) })).toBe('latest')
    // A source with control keys only, or keys set to null, doesn't count.
    expect(await channel({ hklm: read({ managedSourcesBehavior: 'first-wins', wslInheritsWindowsSettings: true }), files: read(STABLE) })).toBe('stable')
    expect(await channel({ hklm: read({ autoUpdatesChannel: null }), files: read(STABLE) })).toBe('stable')
    // "merge" in the selected source: a lower admin source's channel counts.
    expect(await channel({ hklm: read({ managedSourcesBehavior: 'merge', cleanupPeriodDays: 30 }), files: read(STABLE), user: read(LATEST) })).toBe('stable')
  })

  it('reads HKCU only with no admin source present, and can’t tell past an unreadable admin source', async () => {
    expect(await channel({ files: read({ cleanupPeriodDays: 30 }), hkcu: read(STABLE), user: read(LATEST) })).toBe('latest')
    expect(await channel({ files: UNREADABLE, hkcu: read(STABLE), user: read(LATEST) })).toBeNull()
    expect(await channel({ hklm: UNREADABLE, files: read(STABLE) })).toBeNull()
    // A malformed HKCU value never blocks Claude Code: it falls to the user's.
    expect(await channel({ hkcu: UNREADABLE, user: read(STABLE) })).toBe('stable')
    expect(await channel({ files: read({ autoUpdatesChannel: 'weekly' }), user: read(LATEST) })).toBeNull()
  })

  it('reads the setting by the name Settings → Advanced gives', async () => {
    expect(await channel({ user: read({ updatesChannel: 'stable', autoUpdatesChannel: 'latest' }) }, 'updatesChannel')).toBe('stable')
  })

  it('merges managed-settings.json with its drop-ins in name order, and says when one can’t be read', async () => {
    const dir = (files: Record<string, string>): string => {
      const d = tempDir('claude-managed-')
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(d, name, '..'), { recursive: true })
        writeFileSync(join(d, name), text)
      }
      return d
    }
    expect(await managedFiles(dir({}))).toEqual(ABSENT)
    expect(await managedFiles(dir({ 'managed-settings.json': JSON.stringify(STABLE) }))).toEqual(read(STABLE))
    expect(await managedFiles(dir({ 'managed-settings.json': JSON.stringify(STABLE), 'managed-settings.d/20-b.json': JSON.stringify(LATEST), 'managed-settings.d/10-a.json': JSON.stringify({ autoUpdatesChannel: 'x', model: 'm' }) }))).toEqual(read({ autoUpdatesChannel: 'latest', model: 'm' }))
    expect(await managedFiles(dir({ 'managed-settings.d/10-a.json': JSON.stringify(STABLE), 'managed-settings.d/.hidden.json': JSON.stringify(LATEST), 'managed-settings.d/notes.txt': 'x' }))).toEqual(read(STABLE))
    expect(await managedFiles(dir({ 'managed-settings.json': '{ not json' }))).toEqual(UNREADABLE)
    expect(await managedFiles(dir({ 'managed-settings.json': '[1]' }))).toEqual(UNREADABLE)
    expect(await managedFiles(dir({ 'managed-settings.json': JSON.stringify(STABLE), 'managed-settings.d/10-a.json': '' }))).toEqual(UNREADABLE)
  })

  it('reads a registry policy’s Settings value, REG_SZ or REG_EXPAND_SZ', () => {
    const reg = (type: string, value: string): string => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    ${type}    ${value}\r\n\r\n`
    expect(parseRegSettings(reg('REG_SZ', '{"autoUpdatesChannel":"stable"}'))).toEqual(read(STABLE))
    expect(parseRegSettings(reg('REG_EXPAND_SZ', '{"autoUpdatesChannel": "latest", "model": "a b"}'))).toEqual(read({ autoUpdatesChannel: 'latest', model: 'a b' }))
    expect(parseRegSettings(reg('REG_SZ', 'not json'))).toEqual(UNREADABLE)
    expect(parseRegSettings(reg('REG_SZ', '"stable"'))).toEqual(UNREADABLE)
    expect(parseRegSettings('')).toEqual(ABSENT)
  })

  it('asks Windows’ own places, read only: the two registry policies, Program Files’ files and the user’s settings.json', async () => {
    const calls: string[][] = []
    const run = async (file: string, args: string[]): Promise<RunReply> => {
      calls.push([file, ...args])
      return args[1].startsWith('HKLM') ? { stdout: '    Settings    REG_SZ    {"autoUpdatesChannel":"stable"}', stderr: '', code: 0 } : { stdout: '', stderr: 'ERROR: not found', code: 1 }
    }
    const home = tempDir('claude-home-')
    writeFileSync(join(home, 'settings.json'), JSON.stringify(LATEST))
    const programFiles = tempDir('program-files-')
    const s = windowsChannelSources(home, run, programFiles, 'win32')
    expect(await s.hklm()).toEqual(read(STABLE))
    expect(await s.hkcu()).toEqual(ABSENT)
    expect(await s.files()).toEqual(ABSENT)
    expect(await s.user()).toEqual(read(LATEST))
    expect(calls).toEqual([
      ['reg.exe', 'query', 'HKLM\\SOFTWARE\\Policies\\ClaudeCode', '/v', 'Settings'],
      ['reg.exe', 'query', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode', '/v', 'Settings']
    ])
    expect(await resolveUpdateChannel(s, 'autoUpdatesChannel')).toBe('stable')
    mkdirSync(join(programFiles, 'ClaudeCode'))
    writeFileSync(join(programFiles, 'ClaudeCode', 'managed-settings.json'), JSON.stringify(LATEST))
    expect(await s.files()).toEqual(read(LATEST))
    // Elsewhere only the user's settings are read (no Windows policies).
    const other = windowsChannelSources(home, run, programFiles, 'linux')
    calls.length = 0
    expect(await resolveUpdateChannel(other, 'autoUpdatesChannel')).toBe('latest')
    expect(calls).toEqual([])
  })
})
