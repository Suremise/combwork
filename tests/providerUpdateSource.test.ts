// HI-2729: Provider Setup offers only an update the install's own source can deliver. A WinGet install of Copilot is
// compared with what WinGet has, never npm's newer release; WinGet's "nothing newer" exit isn't a failure; Claude Code's
// latest is its update channel's. Every source is stubbed: no winget, npm or network runs here.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWingetVersion, wingetShowArgs, wingetUpToDate, wingetVersion } from '../src/main/providers/winget'
import { tempDir } from './tempDir'

const WINGET_EXE = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe'
const NPM_CMD = 'C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd'
const SHOW = 'Found GitHub Copilot CLI [GitHub.Copilot]\r\nVersion: 1.0.106\r\nPublisher: GitHub, Inc.\r\nPublisher Url: https://github.com/home/\r\nMoniker: copilot\r\n'

afterEach(() => {
  vi.doUnmock('../src/main/plainHttpsJson')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('WinGet’s version of a package', () => {
  it('reads the version off `winget show`, whatever language its field names are in', () => {
    expect(parseWingetVersion(SHOW)).toBe('1.0.106')
    expect(parseWingetVersion('Gefunden GitHub Copilot CLI [GitHub.Copilot]\nVersion: 1.0.107-1\nHerausgeber: GitHub, Inc.\n')).toBe('1.0.107-1')
    expect(parseWingetVersion('Trouvé GitHub Copilot CLI [GitHub.Copilot]\nVersion : 1.0.106\n')).toBe('1.0.106')
    expect(parseWingetVersion('見つかりました GitHub Copilot CLI [GitHub.Copilot]\nバージョン: 1.0.106\n')).toBe('1.0.106')
    expect(parseWingetVersion('No package found matching input criteria.\r\n')).toBeNull()
    expect(parseWingetVersion('')).toBeNull()
  })

  it('asks the winget source only, bounded, and answers null when WinGet fails, times out or says nothing', async () => {
    const calls: { file: string; args: string[]; timeoutMs?: number }[] = []
    let reply: { stdout: string; stderr: string; code: number; ended?: true } = { stdout: SHOW, stderr: '', code: 0 }
    const run = async (file: string, args: string[], timeoutMs?: number): Promise<typeof reply> => {
      calls.push({ file, args, timeoutMs })
      return reply
    }
    expect(await wingetVersion('GitHub.Copilot', run)).toBe('1.0.106')
    expect(calls).toEqual([{ file: 'winget.exe', args: wingetShowArgs('GitHub.Copilot'), timeoutMs: expect.any(Number) }])
    expect(calls[0].args).toEqual(expect.arrayContaining(['show', '--exact', '--source', 'winget', '--disable-interactivity']))
    expect(calls[0].args).not.toEqual(expect.arrayContaining(['upgrade']))
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(60_000)
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
})

describe('Copilot’s latest version, by install kind', () => {
  const withNpm = async (version: string): Promise<{ urls: string[]; install: typeof import('../src/main/providers/copilot/install') }> => {
    vi.resetModules()
    const urls: string[] = []
    vi.doMock('../src/main/plainHttpsJson', () => ({
      plainHttpsJson: async (url: string) => {
        urls.push(url)
        return { version }
      }
    }))
    return { urls, install: await import('../src/main/providers/copilot/install') }
  }

  it('compares a WinGet install with WinGet’s version, never npm’s newer one', async () => {
    const { urls, install } = await withNpm('1.0.107')
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
    const { urls, install } = await withNpm('1.0.107')
    const winget = vi.fn(async () => '1.0.106')
    expect(await install.copilotLatestVersion(NPM_CMD, winget)).toBe('1.0.107')
    expect(await install.copilotLatestVersion('D:\\tools\\copilot.exe', winget)).toBe('1.0.107')
    expect(await install.copilotLatestVersion(null, winget)).toBe('1.0.107')
    expect(winget).not.toHaveBeenCalled()
    expect(urls).toHaveLength(3)
  })

  it('offers Update to a WinGet install only once WinGet has a newer version', async () => {
    const { install } = await withNpm('1.0.107')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const offered = async (wingetHas: string): Promise<boolean> => {
      const latest = await install.copilotLatestVersion(WINGET_EXE, async () => wingetHas)
      return !!latest && copilot.isNewer(latest, '1.0.106')
    }
    expect(await offered('1.0.106')).toBe(false)
    expect(await offered('1.0.107')).toBe(true)
  })

  it('takes WinGet’s "no newer version" as up to date for a WinGet install only', async () => {
    const { install } = await withNpm('1.0.107')
    expect(install.copilotUpdateUpToDate(WINGET_EXE, -1978335189)).toBe(true)
    expect(install.copilotUpdateUpToDate(WINGET_EXE, 1)).toBe(false)
    expect(install.copilotUpdateUpToDate(NPM_CMD, -1978335189)).toBe(false)
    // The portable uninstall failure stays a failure, with its explicit retry (#1101).
    expect(install.copilotUpdateUpToDate(WINGET_EXE, -1978335145)).toBe(false)
    expect(install.copilotUpdateRetry(WINGET_EXE, -1978335189)).toBeNull()
  })
})

describe('Claude Code’s latest version follows its update channel', () => {
  const home = (settings?: string): string => {
    const dir = tempDir('claude-home-')
    mkdirSync(dir, { recursive: true })
    if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings)
    return dir
  }

  it('reads autoUpdatesChannel, latest unless it says stable', async () => {
    const { claudeUpdateChannel } = await import('../src/main/providers/claude/adapter')
    expect(await claudeUpdateChannel(home())).toBe('latest')
    expect(await claudeUpdateChannel(home('{"autoUpdatesChannel":"stable"}'))).toBe('stable')
    expect(await claudeUpdateChannel(home('{"autoUpdatesChannel":"latest"}'))).toBe('latest')
    expect(await claudeUpdateChannel(home('{"autoUpdatesChannel":"nightly"}'))).toBe('latest')
    expect(await claudeUpdateChannel(home('{ not json'))).toBe('latest')
  })

  it('answers the npm tag of that channel, latest’s when it has none', async () => {
    vi.resetModules()
    let tags: Record<string, string> = { stable: '2.1.311', latest: '2.1.319', next: '2.1.319' }
    const urls: string[] = []
    vi.doMock('../src/main/plainHttpsJson', () => ({
      plainHttpsJson: async (url: string) => {
        urls.push(url)
        return tags
      }
    }))
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    vi.stubEnv('CLAUDE_CONFIG_DIR', home('{"autoUpdatesChannel":"stable"}'))
    expect(await claudeCode.latestVersion()).toBe('2.1.311')
    vi.stubEnv('CLAUDE_CONFIG_DIR', home())
    expect(await claudeCode.latestVersion()).toBe('2.1.319')
    vi.stubEnv('CLAUDE_CONFIG_DIR', home('{"autoUpdatesChannel":"stable"}'))
    tags = { latest: '2.1.319' }
    expect(await claudeCode.latestVersion()).toBe('2.1.319')
    expect(new Set(urls)).toEqual(new Set(['https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags']))
  })
})
