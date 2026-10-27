// The Microsoft Store's PowerShell 7 and Codex's sandbox (#585, Darren's decision: options 1 and 3). With Codex's Windows
// sandbox set up and the Store's pwsh first on PATH, Provider Setup warns, names the symptom and suggests the installer's
// PowerShell 7; Hive never changes the shell. Detection: the first pwsh.exe on PATH, by the Store's app execution alias
// folder or its package folder. (On a machine with the Store's pwsh the alias is a reparse point only lstat can see:
// checked against the real one, where there is one.)
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, delimiter } from 'path'
import { lstatSync } from 'original-fs'
import { afterEach, describe, expect, it } from 'vitest'
import { storePwshFirst, storePwshIssue } from '../src/main/providers/codex/storePwsh'
import { tempDir } from './tempDir'

const base = tempDir('hive-store-pwsh-')
const folder = (...parts: string[]): string => {
  const d = join(base, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}
const withPwsh = (...parts: string[]): string => {
  const d = folder(...parts)
  writeFileSync(join(d, 'pwsh.exe'), '')
  return d
}
const local = join(base, 'Local')
const alias = withPwsh('Local', 'Microsoft', 'WindowsApps')
const pkg = withPwsh('Program Files', 'WindowsApps', 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe')
const msi = withPwsh('Program Files', 'PowerShell', '7')
const none = folder('Windows', 'System32')

describe('the Store PowerShell first on PATH (#585)', () => {
  const path = (...dirs: string[]): string => dirs.join(delimiter)

  it("finds the Store's app execution alias, or its package folder, when it is the first pwsh", () => {
    expect(storePwshFirst(path(none, alias, msi), local, 'win32')).toBe(true)
    expect(storePwshFirst(path(none, pkg, msi), local, 'win32')).toBe(true)
    // Trailing separators and quotes, as PATH entries can have them.
    expect(storePwshFirst(path(`"${alias}\\"`, msi), local, 'win32')).toBe(true)
  })

  it("not when the installer's PowerShell 7 comes first, nor without a pwsh, nor off Windows", () => {
    expect(storePwshFirst(path(none, msi, alias), local, 'win32')).toBe(false)
    expect(storePwshFirst(path(none), local, 'win32')).toBe(false)
    expect(storePwshFirst(path(alias), local, 'linux')).toBe(false)
  })

  it("sees the real alias where this machine has the Store's PowerShell 7 (a reparse point: lstat, not stat)", () => {
    const real = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')
    let link = false
    try {
      link = lstatSync(join(real, 'pwsh.exe')).isSymbolicLink()
    } catch {
      // Not installed here.
    }
    if (process.platform === 'win32' && link) expect(storePwshFirst(real, process.env.LOCALAPPDATA, 'win32')).toBe(true)
  })

  it('warns in Provider Setup: a short label, then the problem, the symptom and the fix, no button (Hive never changes the shell)', () => {
    const issue = storePwshIssue()
    expect(issue).toMatchObject({ id: 'store-pwsh', level: 'warning', message: 'PowerShell 7 from the Microsoft Store is installed' })
    // The label is a badge and the window's banner (#1404): the explanation is the detail's first paragraph.
    expect(issue.detail![0]).toMatch(/^Codex agents' commands can fail while a PowerShell 7 from the Microsoft Store is open/)
    expect(issue.action).toBeUndefined()
    expect(issue.detail!.join('\n')).toMatch(/CreateProcessAsUserW failed: 5/)
    expect(issue.detail!.join('\n')).toMatch(/winget install --id Microsoft\.PowerShell --source winget --installer-type wix/)
  })

  // #1512: winget takes the Store's PowerShell for the same app ("already installed", nothing installed) until it is gone.
  it('the fix in the order that works, in English and every translation: uninstall the Store one, install, then restart', () => {
    const order = (text: string, lang: string): void => {
      const uninstall = text.indexOf('Remove-AppxPackage')
      const install = text.indexOf('winget install --id Microsoft.PowerShell --source winget --installer-type wix')
      expect(uninstall, `${lang}: the uninstall command`).toBeGreaterThan(0)
      expect(install, `${lang}: the install command after it`).toBeGreaterThan(uninstall)
      expect(text.indexOf('Hive', install), `${lang}: Hive restarted after the install`).toBeGreaterThan(install)
    }
    order(storePwshIssue().detail!.at(-1)!, 'en')
    for (const lang of ['de', 'es', 'fr', 'ja', 'pl', 'pt-BR', 'zh-CN']) {
      const catalogue = JSON.parse(readFileSync(join(__dirname, '..', 'locales', lang, 'providers.json'), 'utf8')) as Record<string, string>
      order(catalogue['providers.codex.storePwsh.fix'], lang)
    }
  })
})

describe("Codex's readiness with the Store PowerShell (#585)", () => {
  const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, CODEX_HOME: process.env.CODEX_HOME }
  afterEach(() => Object.assign(process.env, saved))

  const readiness = async (sandbox: string | null, pathDirs: string[], loggedIn = true): Promise<string[]> => {
    const home = folder('codex-home', `${sandbox ?? 'none'}-${pathDirs.length}-${Math.random().toString(36).slice(2, 8)}`)
    if (sandbox) writeFileSync(join(home, 'config.toml'), `[windows]\nsandbox = "${sandbox}"\n`)
    Object.assign(process.env, { CODEX_HOME: home, PATH: pathDirs.join(delimiter), LOCALAPPDATA: local })
    const { codex } = await import('../src/main/providers/codex/adapter')
    return codex.readiness({ found: true, loggedIn, updateAvailable: false } as never).map((i) => i.id)
  }

  it('warns once the sandbox is set up and the Store pwsh comes first; not otherwise', async () => {
    if (process.platform !== 'win32') return
    expect(await readiness('unelevated', [alias, msi])).toContain('store-pwsh')
    expect(await readiness('elevated', [pkg])).toContain('store-pwsh')
    expect(await readiness('unelevated', [msi, alias])).not.toContain('store-pwsh')
    // Without the sandbox, its setup comes first (commands ask before each run, and aren't sandboxed).
    expect(await readiness(null, [alias])).not.toContain('store-pwsh')
    // Signed out: the sign-in first, as for the sandbox's own items.
    expect(await readiness('unelevated', [alias], false)).toEqual(['signed-out'])
  })
})
